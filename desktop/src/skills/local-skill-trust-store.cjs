const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { canonicalJson } = require('../collaboration/outcome-records.cjs')
const {
  assertManifestIdentity,
  localSkillContractHash,
  normalizeLocalSkillManifest,
} = require('./local-skill-contract.cjs')

const MAX_AUDIT_BYTES = 8 * 1024 * 1024
const MAX_AUDIT_EVENTS = 10000
const SHA256 = /^[a-f0-9]{64}$/
const BINDING_ID = /^skill-trust-binding-[a-f0-9]{64}$/
const DECISION_ID = /^skill-trust-decision-[a-f0-9]{64}$/
const EVENT_ID = /^skill-trust-event-[a-f0-9]{64}$/

function trustError(code) {
  return Object.assign(new Error(code), { code })
}

function fail(code) {
  throw trustError(code)
}

function exactObject(input, fields) {
  return input && typeof input === 'object' && !Array.isArray(input)
    && Object.keys(input).sort().join(',') === [...fields].sort().join(',')
}

function hashId(prefix, value) {
  return `${prefix}-${crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

function normalizeCoordinates(value) {
  if (!exactObject(value, ['targetKind', 'namespace', 'slug', 'name'])) {
    fail('LOCAL_SKILL_TRUST_BINDING_INVALID')
  }
  const coordinates = Object.fromEntries(Object.entries(value).map(([key, child]) => (
    [key, String(child || '')]
  )))
  if (!coordinates.targetKind || !coordinates.namespace || !coordinates.slug || !coordinates.name
      || Object.values(coordinates).some(child => (
        child !== child.trim() || child.length > 160 || /[\u0000-\u001f\u007f-\u009f]/.test(child)
      ))) {
    fail('LOCAL_SKILL_TRUST_BINDING_INVALID')
  }
  return coordinates
}

function normalizeBinding(input) {
  if (!exactObject(input, ['coordinates', 'manifest', 'contentHash'])) {
    fail('LOCAL_SKILL_TRUST_BINDING_INVALID')
  }
  const coordinates = normalizeCoordinates(input.coordinates)
  const manifest = assertManifestIdentity(input.manifest, coordinates)
  const contentHash = String(input.contentHash || '')
  if (!SHA256.test(contentHash)) fail('LOCAL_SKILL_TRUST_BINDING_INVALID')
  const body = {
    scope: 'agent-content',
    coordinates,
    contractHash: localSkillContractHash(manifest),
    contentHash,
    manifest,
  }
  return Object.freeze({ bindingId: hashId('skill-trust-binding', body), ...body })
}

function asBinding(input) {
  if (input && typeof input === 'object' && BINDING_ID.test(String(input.bindingId || ''))) {
    const normalized = normalizeBinding({
      coordinates: input.coordinates,
      manifest: input.manifest,
      contentHash: input.contentHash,
    })
    if (normalized.bindingId !== input.bindingId
        || normalized.contractHash !== input.contractHash || input.scope !== 'agent-content') {
      fail('LOCAL_SKILL_TRUST_BINDING_INVALID')
    }
    return normalized
  }
  return normalizeBinding(input)
}

function normalizeEvent(input, sequence, previousEventId) {
  if (!exactObject(input, [
    'eventId', 'schemaVersion', 'recordType', 'sequence', 'timestamp', 'action',
    'bindingId', 'decisionId', 'previousEventId', 'binding',
  ]) || input.schemaVersion !== 1 || input.recordType !== 'local-skill-trust-audit'
      || input.sequence !== sequence || input.previousEventId !== previousEventId
      || !['approved', 'revoked'].includes(input.action)
      || !BINDING_ID.test(String(input.bindingId || ''))
      || !DECISION_ID.test(String(input.decisionId || ''))
      || !Number.isFinite(Date.parse(String(input.timestamp || '')))
      || (input.action === 'approved') !== Boolean(input.binding)) {
    fail('LOCAL_SKILL_TRUST_AUDIT_INVALID')
  }
  let binding = null
  if (input.binding) {
    binding = normalizeBinding({
      coordinates: input.binding.coordinates,
      manifest: input.binding.manifest,
      contentHash: input.binding.contentHash,
    })
    if (binding.bindingId !== input.bindingId
        || binding.contractHash !== input.binding.contractHash
        || input.binding.scope !== 'agent-content') {
      fail('LOCAL_SKILL_TRUST_AUDIT_INVALID')
    }
  }
  const body = {
    schemaVersion: 1,
    recordType: 'local-skill-trust-audit',
    sequence,
    timestamp: input.timestamp,
    action: input.action,
    bindingId: input.bindingId,
    decisionId: input.decisionId,
    previousEventId,
    binding,
  }
  if (hashId('skill-trust-event', body) !== input.eventId) {
    fail('LOCAL_SKILL_TRUST_AUDIT_INVALID')
  }
  return Object.freeze({ eventId: input.eventId, ...body })
}

function writeLine(filename, line) {
  const directory = path.dirname(filename)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const directoryStat = fs.lstatSync(directory)
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    fail('LOCAL_SKILL_TRUST_STORE_UNAVAILABLE')
  }
  try { fs.chmodSync(directory, 0o700) } catch { /* best effort */ }
  let descriptor
  try {
    descriptor = fs.openSync(
      filename,
      fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT
        | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    )
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile() || stat.size + Buffer.byteLength(line) > MAX_AUDIT_BYTES) {
      fail('LOCAL_SKILL_TRUST_AUDIT_LIMIT')
    }
    fs.writeFileSync(descriptor, line, 'utf8')
    fs.fsyncSync(descriptor)
    fs.fchmodSync(descriptor, 0o600)
  } finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor) } catch {}
  }
}

function readAuditFile(filename) {
  let descriptor
  try {
    descriptor = fs.openSync(
      filename,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    )
    const opened = fs.fstatSync(descriptor)
    if (!opened.isFile() || opened.size > MAX_AUDIT_BYTES) {
      fail('LOCAL_SKILL_TRUST_AUDIT_INVALID')
    }
    const bytes = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset)
      if (!count) fail('LOCAL_SKILL_TRUST_AUDIT_INVALID')
      offset += count
    }
    const final = fs.fstatSync(descriptor)
    const pathStat = fs.lstatSync(filename)
    if (final.size !== opened.size || final.dev !== opened.dev || final.ino !== opened.ino
        || pathStat.isSymbolicLink() || !pathStat.isFile()
        || pathStat.dev !== final.dev || pathStat.ino !== final.ino) {
      fail('LOCAL_SKILL_TRUST_AUDIT_INVALID')
    }
    return bytes.toString('utf8')
  } catch (error) {
    if (error?.code?.startsWith('LOCAL_SKILL_')) throw error
    fail('LOCAL_SKILL_TRUST_AUDIT_INVALID')
  } finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor) } catch {}
  }
}

class LocalSkillTrustStore {
  constructor({ storagePath, now = () => new Date() } = {}) {
    if (typeof storagePath !== 'string' || !path.isAbsolute(storagePath)
        || storagePath === path.parse(storagePath).root || typeof now !== 'function') {
      fail('LOCAL_SKILL_TRUST_STORE_OPTIONS_INVALID')
    }
    this.storagePath = path.normalize(storagePath)
    this.now = now
    this.events = []
    this.states = new Map()
    this.unavailableCode = ''
    try { this.load() } catch (error) {
      this.events = []
      this.states = new Map()
      this.unavailableCode = error?.code || 'LOCAL_SKILL_TRUST_STORE_UNAVAILABLE'
    }
  }

  load() {
    const directory = path.dirname(this.storagePath)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const directoryStat = fs.lstatSync(directory)
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      fail('LOCAL_SKILL_TRUST_STORE_UNAVAILABLE')
    }
    try { fs.chmodSync(directory, 0o700) } catch { /* best effort */ }
    if (!fs.existsSync(this.storagePath)) return
    const text = readAuditFile(this.storagePath)
    if (text && !text.endsWith('\n')) fail('LOCAL_SKILL_TRUST_AUDIT_INVALID')
    const lines = text.split('\n').filter(Boolean)
    if (lines.length > MAX_AUDIT_EVENTS) fail('LOCAL_SKILL_TRUST_AUDIT_INVALID')
    let previousEventId = ''
    this.events = lines.map((line, index) => {
      let parsed
      try { parsed = JSON.parse(line) } catch { fail('LOCAL_SKILL_TRUST_AUDIT_INVALID') }
      const event = normalizeEvent(parsed, index + 1, previousEventId)
      previousEventId = event.eventId
      return event
    })
    for (const event of this.events) {
      const previous = this.states.get(event.bindingId)
      if (event.action === 'approved') {
        this.states.set(event.bindingId, { state: 'approved', event, binding: event.binding })
      } else {
        if (!previous?.binding || previous.event.decisionId !== event.decisionId) {
          fail('LOCAL_SKILL_TRUST_AUDIT_INVALID')
        }
        this.states.set(event.bindingId, { state: 'revoked', event, binding: previous.binding })
      }
    }
  }

  requireAvailable() {
    if (this.unavailableCode) fail(this.unavailableCode)
  }

  diagnostic() {
    return this.unavailableCode
  }

  binding(input) {
    this.requireAvailable()
    return normalizeBinding(input)
  }

  append(action, binding, decisionId) {
    this.requireAvailable()
    if (this.events.length >= MAX_AUDIT_EVENTS) fail('LOCAL_SKILL_TRUST_AUDIT_LIMIT')
    const body = {
      schemaVersion: 1,
      recordType: 'local-skill-trust-audit',
      sequence: this.events.length + 1,
      timestamp: this.now().toISOString(),
      action,
      bindingId: binding.bindingId,
      decisionId,
      previousEventId: this.events.at(-1)?.eventId || '',
      binding: action === 'approved' ? binding : null,
    }
    const event = normalizeEvent(
      { eventId: hashId('skill-trust-event', body), ...body },
      body.sequence,
      body.previousEventId,
    )
    try { writeLine(this.storagePath, `${canonicalJson(event)}\n`) } catch (error) {
      this.unavailableCode = error?.code?.startsWith('LOCAL_SKILL_')
        ? error.code : 'LOCAL_SKILL_TRUST_STORE_UNAVAILABLE'
      fail(this.unavailableCode)
    }
    this.events.push(event)
    this.states.set(binding.bindingId, {
      state: action === 'approved' ? 'approved' : 'revoked',
      event,
      binding,
    })
    return event
  }

  decision(input) {
    this.requireAvailable()
    const binding = asBinding(input)
    const state = this.states.get(binding.bindingId)
    if (state?.state !== 'approved') return null
    return Object.freeze({
      bindingId: binding.bindingId,
      decisionId: state.event.decisionId,
      approvedAt: state.event.timestamp,
    })
  }

  approve(input) {
    const binding = asBinding(input)
    const existing = this.decision(input)
    if (existing) return existing
    const decisionBody = {
      bindingId: binding.bindingId,
      approvedAt: this.now().toISOString(),
      previousEventId: this.events.at(-1)?.eventId || '',
    }
    const decisionId = hashId('skill-trust-decision', decisionBody)
    const event = this.append('approved', binding, decisionId)
    return Object.freeze({ bindingId: binding.bindingId, decisionId, approvedAt: event.timestamp })
  }

  assertApproved(input, expectedDecisionId = '') {
    this.requireAvailable()
    const decision = this.decision(input)
    if (!decision || (expectedDecisionId && decision.decisionId !== expectedDecisionId)) {
      fail('LOCAL_SKILL_TRUST_REQUIRED')
    }
    return decision
  }

  revoke(bindingId) {
    this.requireAvailable()
    const id = String(bindingId || '')
    const state = this.states.get(id)
    if (!BINDING_ID.test(id) || state?.state !== 'approved') {
      fail('LOCAL_SKILL_TRUST_NOT_FOUND')
    }
    this.append('revoked', state.binding, state.event.decisionId)
    return Object.freeze({ bindingId: id, revoked: true })
  }

  list() {
    this.requireAvailable()
    return [...this.states.values()].map(state => Object.freeze({
      bindingId: state.binding.bindingId,
      state: state.state,
      decisionId: state.event.decisionId,
      updatedAt: state.event.timestamp,
      scope: state.binding.scope,
      coordinates: state.binding.coordinates,
      contractHash: state.binding.contractHash,
      contentHash: state.binding.contentHash,
      manifest: normalizeLocalSkillManifest(state.binding.manifest),
    })).sort((left, right) => left.bindingId.localeCompare(right.bindingId))
  }
}

module.exports = {
  LocalSkillTrustStore,
  normalizeLocalSkillTrustBinding: normalizeBinding,
}

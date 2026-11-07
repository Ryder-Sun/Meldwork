const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

const { ContentBlobStore } = require('../attachments/content-blob-store.cjs')
const {
  canonicalJson,
} = require('../collaboration/outcome-records.cjs')
const { publicCollaborationText } = require('../collaboration/collaboration-records.cjs')
const {
  createHumanGateRecord,
  decideHumanGateRecord,
  parseHumanGateRecord,
  publicHumanGate,
} = require('./human-gate-records.cjs')
const { atomicWritePrivateFile } = require('../security/private-file.cjs')

const STORE_VERSION = 1
const MAX_GATES = 2048
const GATE_ID = /^human-gate-[a-f0-9]{64}$/

function storeError(code, cause) {
  const error = new Error(code)
  error.code = code
  if (cause) error.cause = cause
  return error
}

function canonicalPayload(input) {
  let serialized
  try { serialized = canonicalJson(input) } catch (error) {
    throw storeError('HUMAN_GATE_REQUEST_INVALID', error)
  }
  const bytes = Buffer.from(serialized, 'utf8')
  if (!bytes.length || bytes.length > 256 * 1024) {
    throw storeError('HUMAN_GATE_REQUEST_INVALID')
  }
  return bytes
}

class HumanGateStore {
  constructor({ storagePath, contentBlobStore } = {}) {
    if (typeof storagePath !== 'string' || !storagePath) {
      throw storeError('HUMAN_GATE_STORAGE_PATH_REQUIRED')
    }
    if (!(contentBlobStore instanceof ContentBlobStore)) {
      throw storeError('HUMAN_GATE_CONTENT_BLOB_STORE_REQUIRED')
    }
    this.storagePath = path.resolve(storagePath)
    if (this.storagePath === path.parse(this.storagePath).root) {
      throw storeError('HUMAN_GATE_STORAGE_PATH_UNSAFE')
    }
    this.contentBlobStore = contentBlobStore
    this.quarantined = []
    this.records = this.load()
  }

  validateRequest(record) {
    if (!this.contentBlobStore.has(record.requestRef)) {
      throw storeError('HUMAN_GATE_REQUEST_NOT_FOUND')
    }
    const bytes = this.contentBlobStore.read(record.requestRef)
    const text = bytes.toString('utf8')
    const parsed = JSON.parse(text)
    if (canonicalJson(parsed) !== text) throw storeError('HUMAN_GATE_REQUEST_TAMPERED')
    return parsed
  }

  quarantine(entries) {
    if (!entries.length) return
    this.quarantined = entries
    try {
      atomicWritePrivateFile(`${this.storagePath}.quarantine.json`, `${JSON.stringify({
        version: 1,
        quarantinedAt: new Date().toISOString(),
        entries,
      }, null, 2)}\n`)
    } catch { /* Loading valid unrelated Gates must not depend on diagnostics. */ }
  }

  load() {
    try {
      const bytes = fs.readFileSync(this.storagePath)
      if (!bytes.length || bytes.length > 4 * 1024 * 1024) return []
      const parsed = JSON.parse(bytes.toString('utf8'))
      if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.gates)) return []
      const records = []
      const gateIds = new Set()
      const quarantined = []
      for (const [index, candidate] of parsed.gates.slice(-MAX_GATES).entries()) {
        try {
          const record = parseHumanGateRecord(candidate)
          if (gateIds.has(record.gateId)) throw storeError('HUMAN_GATE_DUPLICATE')
          this.validateRequest(record)
          gateIds.add(record.gateId)
          records.push(record)
        } catch (error) {
          quarantined.push({
            index,
            code: String(error?.code || error?.message || 'HUMAN_GATE_RECORD_INVALID').slice(0, 120),
          })
        }
      }
      this.quarantine(quarantined)
      if (quarantined.length) {
        try { this.save(records) } catch { /* Valid Gates remain available in memory. */ }
      }
      try { fs.chmodSync(this.storagePath, 0o600) } catch { /* Windows may ignore modes. */ }
      return records
    } catch {
      return []
    }
  }

  save(records = this.records) {
    const serialized = `${JSON.stringify({ version: STORE_VERSION, gates: records }, null, 2)}\n`
    atomicWritePrivateFile(this.storagePath, serialized)
  }

  create(input = {}) {
    const { request, ...recordInput } = input
    const requestBytes = canonicalPayload(request)
    const requestRef = {
      algorithm: 'sha256',
      hash: createHash('sha256').update(requestBytes).digest('hex'),
      size: requestBytes.length,
      mediaType: 'application/json',
    }
    const record = createHumanGateRecord({
      ...recordInput,
      requestRef,
      requestHash: requestRef.hash,
    })
    const existing = this.records.find(candidate => candidate.gateId === record.gateId)
    if (!existing && this.records.length >= MAX_GATES) throw storeError('HUMAN_GATE_LIMIT')
    this.contentBlobStore.put(requestBytes, { mediaType: 'application/json' })
    if (existing) return existing
    const next = [...this.records, record]
    this.save(next)
    this.records = next
    return record
  }

  get(gateId) {
    if (!GATE_ID.test(String(gateId || ''))) throw storeError('HUMAN_GATE_ID_INVALID')
    const record = this.records.find(candidate => candidate.gateId === gateId)
    if (!record) throw storeError('HUMAN_GATE_NOT_FOUND')
    if (!this.contentBlobStore.has(record.requestRef)) {
      throw storeError('HUMAN_GATE_REQUEST_NOT_FOUND')
    }
    return record
  }

  request(gateId) {
    const record = this.get(gateId)
    try {
      return this.validateRequest(record)
    } catch (error) {
      throw storeError('HUMAN_GATE_REQUEST_TAMPERED', error)
    }
  }

  decide(gateId, decision) {
    const current = this.get(gateId)
    const decided = decideHumanGateRecord(current, decision)
    if (decided === current) return current
    const index = this.records.findIndex(record => record.gateId === gateId)
    const next = [...this.records]
    next[index] = decided
    this.save(next)
    this.records = next
    return decided
  }

  rollbackDecision(gateId, expectedDecision) {
    const current = this.get(gateId)
    if (current.status === 'pending'
        || canonicalJson(current.decision) !== canonicalJson(expectedDecision)) {
      throw storeError('HUMAN_GATE_ROLLBACK_INVALID')
    }
    const pending = parseHumanGateRecord({
      ...current,
      status: 'pending',
      decision: null,
    })
    const index = this.records.findIndex(record => record.gateId === gateId)
    const next = [...this.records]
    next[index] = pending
    this.save(next)
    this.records = next
    return pending
  }

  publicRecord(record) {
    const gate = publicHumanGate(record)
    if (record.type !== 'decision' || record.status !== 'pending' || !record.agentRunId.startsWith('graph-decision-')) return gate
    const unavailable = () => ({ ...gate, decisionContextUnavailable: true })
    try {
      const request = this.validateRequest(record)
      if (!/^task-graph-[a-f0-9]{64}$/.test(request.graphId || '')
          || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(request.nodeId || '')
          || record.agentRunId !== `graph-decision-${createHash('sha256').update(JSON.stringify([request.graphId, request.nodeId])).digest('hex')}`) return unavailable()
      if (request.decisionContext === undefined) return gate
      if (!Array.isArray(request.decisionContext) || request.decisionContext.length > 32) return unavailable()
      const decisionContext = request.decisionContext.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)
            || Object.keys(item).sort().join(',') !== 'agentKind,text,truncated'
            || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(item.agentKind || '')
            || typeof item.text !== 'string' || !item.text || item.text.length > 2000
            || typeof item.truncated !== 'boolean'
            || publicCollaborationText(item.text, 2000) !== item.text) return null
        return { agentKind: item.agentKind, text: item.text, truncated: item.truncated }
      })
      if (!decisionContext.every(Boolean)) return unavailable()
      return decisionContext.length ? { ...gate, decisionContext } : gate
    } catch { return unavailable() }
  }

  list({ runId = '', pendingOnly = false } = {}) {
    return this.records
      .filter(record => (!runId || record.runId === runId)
        && (!pendingOnly || record.status === 'pending'))
      .map(record => this.publicRecord(record))
  }
}

module.exports = { HumanGateStore }

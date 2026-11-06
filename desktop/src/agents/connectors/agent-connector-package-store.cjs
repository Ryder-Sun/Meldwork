const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { z } = require('zod')

const {
  compareSemanticVersions,
  isUpstreamVersionCompatible,
  parseAgentConnectorManifest,
} = require('./agent-connector-manifest.cjs')
const { canonicalJson } = require('../../collaboration/outcome-records.cjs')
const { atomicWritePrivateFile, ensurePrivateDirectory } = require('../../security/private-file.cjs')
const { redactSecrets } = require('../../security/secret-redaction.cjs')

const AGENT_CONNECTOR_PACKAGE_VERSION = 1
const AGENT_CONNECTOR_SDK_VERSION = '1.0.0'
const MAX_PACKAGE_BYTES = 512 * 1024
const MAX_PACKAGES = 128
const MAX_AUDIT_EVENTS = MAX_PACKAGES * 16
const MAX_AUDIT_BYTES = 8 * 1024 * 1024
const PACKAGE_ID = /^connector-package-[a-f0-9]{64}$/
const AUDIT_ID = /^connector-audit-[a-f0-9]{64}$/
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const SDK_LOCAL_ECHO_RECIPE_ID = 'sdk.local-echo.v1'
const SDK_HTTP_JSON_RECIPE_ID = 'sdk.http-json.v1'
const SDK_RECIPE_IDS = Object.freeze([
  SDK_LOCAL_ECHO_RECIPE_ID,
  SDK_HTTP_JSON_RECIPE_ID,
])
const PACKAGE_STATES = new Set([
  'imported', 'approved', 'installed', 'disabled', 'revoked', 'removed',
])

function packageError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function fail(code) {
  throw packageError(code)
}

function safeTextSchema(max) {
  return z.string().min(1).max(max).superRefine((value, context) => {
    if (/[\u0000-\u001f\u007f]/.test(value) || redactSecrets(value) !== value) {
      context.addIssue({ code: 'custom', message: 'unsafe package text' })
    }
  })
}

const httpsEndpointSchema = z.string().min(9).max(2048).superRefine((value, context) => {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password
        || parsed.search || parsed.hash) {
      context.addIssue({ code: 'custom', message: 'HTTPS endpoint required' })
    }
  } catch {
    context.addIssue({ code: 'custom', message: 'HTTPS endpoint required' })
  }
})

const publisherSchema = z.strictObject({
  id: z.string().min(1).max(120).regex(PUBLIC_ID),
  name: safeTextSchema(120),
})

const providerSchema = z.discriminatedUnion('id', [
  z.strictObject({
    id: z.literal(SDK_LOCAL_ECHO_RECIPE_ID),
    config: z.strictObject({}),
  }),
  z.strictObject({
    id: z.literal(SDK_HTTP_JSON_RECIPE_ID),
    config: z.strictObject({
      endpoint: httpsEndpointSchema,
      authSlotId: z.string().min(1).max(120).regex(PUBLIC_ID).nullable(),
    }),
  }),
])

const packageContentSchema = z.strictObject({
  publisher: publisherSchema,
  provider: providerSchema,
  manifest: z.unknown(),
}).superRefine((value, context) => {
  let manifest
  try {
    manifest = parseAgentConnectorManifest(value.manifest)
  } catch {
    context.addIssue({ code: 'custom', path: ['manifest'], message: 'invalid manifest' })
    return
  }
  if (manifest.invocation.recipeId !== value.provider.id
      || manifest.upstream.id !== 'meldwork-sdk'
      || !isUpstreamVersionCompatible(manifest, AGENT_CONNECTOR_SDK_VERSION)) {
    context.addIssue({ code: 'custom', message: 'provider and manifest mismatch' })
    return
  }
  if (value.provider.id === SDK_LOCAL_ECHO_RECIPE_ID) {
    if (manifest.transport.type !== 'cli' || manifest.transport.protocol !== 'json'
        || manifest.outboundDestinations.length || manifest.credentials.mode !== 'none'
        || manifest.inputTypes.length !== 1 || manifest.inputTypes[0] !== 'text'
        || manifest.permissionModes.length !== 1
        || manifest.permissionModes[0] !== 'read-only') {
      context.addIssue({ code: 'custom', message: 'local echo capabilities invalid' })
    }
    return
  }
  const endpoint = new URL(value.provider.config.endpoint)
  const slotId = value.provider.config.authSlotId
  const authSlot = manifest.credentials.slots.find(slot => slot.slotId === slotId)
  if (manifest.transport.type !== 'http' || manifest.transport.protocol !== 'json'
      || !manifest.outboundDestinations.includes(endpoint.origin)
      || (slotId === null && manifest.credentials.mode !== 'none')
      || (slotId !== null && (manifest.credentials.mode !== 'credential-ref'
        || manifest.credentials.slots.length !== 1 || !authSlot || !authSlot.required
        || !['api-key', 'token'].includes(authSlot.type)))
      || manifest.inputTypes.length !== 1 || manifest.inputTypes[0] !== 'text'
      || manifest.permissionModes.length !== 1
      || manifest.permissionModes[0] !== 'read-only') {
    context.addIssue({ code: 'custom', message: 'HTTP JSON capabilities invalid' })
  }
})

const packageRecordSchema = z.strictObject({
  packageId: z.string().regex(PACKAGE_ID),
  schemaVersion: z.literal(AGENT_CONNECTOR_PACKAGE_VERSION),
  recordType: z.literal('agent-connector-package'),
  publisher: publisherSchema,
  provider: providerSchema,
  manifest: z.unknown(),
})

function packageIdFor(body) {
  return `connector-package-${crypto.createHash('sha256').update(canonicalJson(body)).digest('hex')}`
}

function canonicalPackage(record) {
  const serialized = canonicalJson(record)
  if (Buffer.byteLength(serialized) > MAX_PACKAGE_BYTES) {
    fail('AGENT_CONNECTOR_PACKAGE_SCHEMA_INVALID')
  }
  return serialized
}

function createAgentConnectorPackage(input) {
  const result = packageContentSchema.safeParse(input)
  if (!result.success) fail('AGENT_CONNECTOR_PACKAGE_SCHEMA_INVALID')
  const content = {
    ...result.data,
    manifest: parseAgentConnectorManifest(result.data.manifest),
  }
  const body = {
    schemaVersion: AGENT_CONNECTOR_PACKAGE_VERSION,
    recordType: 'agent-connector-package',
    ...content,
  }
  return JSON.parse(canonicalPackage({ packageId: packageIdFor(body), ...body }))
}

function parseAgentConnectorPackage(input) {
  const bytes = Buffer.isBuffer(input) || input instanceof Uint8Array
    ? Buffer.from(input)
    : typeof input === 'string' ? Buffer.from(input, 'utf8') : null
  let parsed = input
  let serialized = null
  if (bytes) {
    if (!bytes.length || bytes.length > MAX_PACKAGE_BYTES
        || !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) {
      fail('AGENT_CONNECTOR_PACKAGE_JSON_INVALID')
    }
    serialized = bytes.toString('utf8')
    try { parsed = JSON.parse(serialized) } catch { fail('AGENT_CONNECTOR_PACKAGE_JSON_INVALID') }
  }
  const recordResult = packageRecordSchema.safeParse(parsed)
  if (!recordResult.success) fail('AGENT_CONNECTOR_PACKAGE_SCHEMA_INVALID')
  const { packageId, schemaVersion: _schemaVersion, recordType: _recordType, ...content } = recordResult.data
  const contentResult = packageContentSchema.safeParse(content)
  if (!contentResult.success) fail('AGENT_CONNECTOR_PACKAGE_SCHEMA_INVALID')
  const record = {
    packageId,
    schemaVersion: AGENT_CONNECTOR_PACKAGE_VERSION,
    recordType: 'agent-connector-package',
    ...contentResult.data,
    manifest: parseAgentConnectorManifest(contentResult.data.manifest),
  }
  const { packageId: _packageId, ...body } = record
  if (packageIdFor(body) !== packageId) fail('AGENT_CONNECTOR_PACKAGE_ID_MISMATCH')
  const canonical = canonicalPackage(record)
  if (serialized !== null && serialized !== canonical) {
    fail('AGENT_CONNECTOR_PACKAGE_JSON_NOT_CANONICAL')
  }
  return Object.freeze(JSON.parse(canonical))
}

function serializeAgentConnectorPackage(input) {
  return canonicalJson(parseAgentConnectorPackage(input))
}

function exactOptions(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => ['now', 'rootPath'].includes(key))
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Reflect.ownKeys(value).sort().join(',') === [...keys].sort().join(',')
}

function readRegularNoFollow(filename, maxBytes, code) {
  let descriptor
  try {
    descriptor = fs.openSync(
      filename,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    )
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile() || stat.size > maxBytes) fail(code)
    return fs.readFileSync(descriptor)
  } catch (error) {
    if (error?.code?.startsWith('AGENT_CONNECTOR_')) throw error
    fail(code)
  } finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor) } catch {}
  }
}

function validTimestamp(value) {
  return typeof value === 'string' && value.length <= 40
    && new Date(value).toISOString() === value
}

function auditEventId(body) {
  return `connector-audit-${crypto.createHash('sha256').update(canonicalJson(body)).digest('hex')}`
}

function parseAuditEvent(input, expectedSequence, previousEventId) {
  if (!exactKeys(input, [
    'action', 'details', 'eventId', 'packageId', 'previousEventId',
    'recordType', 'schemaVersion', 'sequence', 'timestamp',
  ]) || input.schemaVersion !== 1 || input.recordType !== 'agent-connector-package-audit'
      || input.sequence !== expectedSequence || !PACKAGE_ID.test(String(input.packageId || ''))
      || input.previousEventId !== previousEventId || !validTimestamp(input.timestamp)
      || !['imported', 'approved', 'installed', 'disabled', 'revoked', 'upgraded', 'removed'].includes(input.action)
      || !input.details || typeof input.details !== 'object' || Array.isArray(input.details)) {
    fail('AGENT_CONNECTOR_PACKAGE_AUDIT_INVALID')
  }
  const { eventId, ...body } = input
  if (!AUDIT_ID.test(String(eventId || '')) || auditEventId(body) !== eventId) {
    fail('AGENT_CONNECTOR_PACKAGE_AUDIT_INVALID')
  }
  return Object.freeze(JSON.parse(canonicalJson(input)))
}

function recordState(events) {
  const states = new Map()
  for (const event of events) {
    const current = states.get(event.packageId)
    if (event.action === 'imported') {
      if ((current && current.state !== 'removed') || !exactKeys(event.details, ['originFilename', 'originSha256'])
          || typeof event.details.originFilename !== 'string'
          || event.details.originFilename !== path.basename(event.details.originFilename)
          || !/^[a-f0-9]{64}$/.test(String(event.details.originSha256 || ''))) {
        fail('AGENT_CONNECTOR_PACKAGE_AUDIT_INVALID')
      }
      states.set(event.packageId, {
        state: 'imported',
        originFilename: event.details.originFilename,
        originSha256: event.details.originSha256,
        updatedAt: event.timestamp,
      })
      continue
    }
    if (!current || current.state === 'removed') fail('AGENT_CONNECTOR_PACKAGE_AUDIT_INVALID')
    const allowed = {
      approved: ['imported'],
      installed: ['approved', 'disabled'],
      disabled: ['installed'],
      revoked: ['imported', 'approved', 'installed', 'disabled'],
      upgraded: ['approved'],
      removed: ['imported', 'approved', 'disabled', 'revoked'],
    }
    if (!allowed[event.action].includes(current.state)) {
      fail('AGENT_CONNECTOR_PACKAGE_AUDIT_INVALID')
    }
    if (event.action === 'upgraded') {
      if (!exactKeys(event.details, ['fromPackageId'])
          || !PACKAGE_ID.test(String(event.details.fromPackageId || ''))) {
        fail('AGENT_CONNECTOR_PACKAGE_AUDIT_INVALID')
      }
      const previous = states.get(event.details.fromPackageId)
      if (!previous || !['installed', 'disabled'].includes(previous.state)
          || event.details.fromPackageId === event.packageId) {
        fail('AGENT_CONNECTOR_PACKAGE_AUDIT_INVALID')
      }
      previous.state = 'disabled'
      previous.updatedAt = event.timestamp
      current.state = 'installed'
    } else {
      if (!exactKeys(event.details, [])) fail('AGENT_CONNECTOR_PACKAGE_AUDIT_INVALID')
      current.state = event.action
    }
    current.updatedAt = event.timestamp
  }
  return states
}

class AgentConnectorPackageStore {
  constructor(options = {}) {
    if (!exactOptions(options) || typeof options.rootPath !== 'string'
        || !path.isAbsolute(options.rootPath)
        || options.rootPath === path.parse(options.rootPath).root
        || (options.now !== undefined && typeof options.now !== 'function')) {
      fail('AGENT_CONNECTOR_PACKAGE_STORE_OPTIONS_INVALID')
    }
    this.rootPath = path.normalize(options.rootPath)
    this.packageDirectory = path.join(this.rootPath, 'packages')
    this.auditPath = path.join(this.rootPath, 'audit.jsonl')
    this.now = options.now || (() => new Date())
    this.events = []
    this.states = new Map()
    this.unavailableCode = ''
    try {
      this.loadAudit()
    } catch (error) {
      this.events = []
      this.states = new Map()
      this.unavailableCode = error?.code || 'AGENT_CONNECTOR_PACKAGE_STORE_UNAVAILABLE'
    }
  }

  requireAvailable() {
    if (this.unavailableCode) fail(this.unavailableCode)
  }

  diagnostic() {
    return this.unavailableCode
  }

  ensureDirectories() {
    ensurePrivateDirectory(this.rootPath)
    ensurePrivateDirectory(this.packageDirectory)
  }

  loadAudit() {
    this.ensureDirectories()
    if (!fs.existsSync(this.auditPath)) return
    try {
      const text = readRegularNoFollow(
        this.auditPath,
        MAX_AUDIT_BYTES,
        'AGENT_CONNECTOR_PACKAGE_AUDIT_INVALID',
      ).toString('utf8')
      if (!text.endsWith('\n')) fail('AGENT_CONNECTOR_PACKAGE_AUDIT_INVALID')
      const lines = text.split('\n').filter(Boolean)
      if (lines.length > MAX_AUDIT_EVENTS) fail('AGENT_CONNECTOR_PACKAGE_AUDIT_INVALID')
      let previousEventId = ''
      this.events = lines.map((line, index) => {
        const parsed = JSON.parse(line)
        const event = parseAuditEvent(parsed, index + 1, previousEventId)
        previousEventId = event.eventId
        return event
      })
      this.states = recordState(this.events)
      if (this.states.size > MAX_PACKAGES) fail('AGENT_CONNECTOR_PACKAGE_LIMIT')
    } catch (error) {
      if (error?.code?.startsWith('AGENT_CONNECTOR_')) throw error
      fail('AGENT_CONNECTOR_PACKAGE_AUDIT_INVALID')
    }
  }

  packagePath(packageId) {
    if (!PACKAGE_ID.test(String(packageId || ''))) fail('AGENT_CONNECTOR_PACKAGE_NOT_FOUND')
    return path.join(this.packageDirectory, `${packageId}.json`)
  }

  readPackage(packageId) {
    this.requireAvailable()
    const filename = this.packagePath(packageId)
    try {
      return parseAgentConnectorPackage(readRegularNoFollow(
        filename,
        MAX_PACKAGE_BYTES,
        'AGENT_CONNECTOR_PACKAGE_UNAVAILABLE',
      ))
    } catch (error) {
      if (error?.code?.startsWith('AGENT_CONNECTOR_')) throw error
      fail('AGENT_CONNECTOR_PACKAGE_UNAVAILABLE')
    }
  }

  append(action, packageId, details = {}) {
    this.requireAvailable()
    if (this.events.length >= MAX_AUDIT_EVENTS) fail('AGENT_CONNECTOR_PACKAGE_AUDIT_LIMIT')
    const timestamp = this.now().toISOString()
    const body = {
      schemaVersion: 1,
      recordType: 'agent-connector-package-audit',
      sequence: this.events.length + 1,
      timestamp,
      action,
      packageId,
      previousEventId: this.events.at(-1)?.eventId || '',
      details,
    }
    const event = parseAuditEvent(
      { eventId: auditEventId(body), ...body },
      body.sequence,
      body.previousEventId,
    )
    let descriptor
    let writeStarted = false
    try {
      this.ensureDirectories()
      descriptor = fs.openSync(
        this.auditPath,
        fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT
          | (fs.constants.O_NOFOLLOW || 0),
        0o600,
      )
      const stat = fs.fstatSync(descriptor)
      const line = `${canonicalJson(event)}\n`
      if (!stat.isFile() || stat.size + Buffer.byteLength(line) > MAX_AUDIT_BYTES) {
        fail('AGENT_CONNECTOR_PACKAGE_AUDIT_LIMIT')
      }
      writeStarted = true
      fs.writeFileSync(descriptor, line, 'utf8')
      fs.fsyncSync(descriptor)
      fs.fchmodSync(descriptor, 0o600)
      fs.closeSync(descriptor)
      descriptor = undefined
      if (stat.size === 0) {
        let directoryDescriptor
        try {
          directoryDescriptor = fs.openSync(this.rootPath, 'r')
          fs.fsyncSync(directoryDescriptor)
        } catch (error) {
          const unsupported = ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)
            || (process.platform === 'win32' && ['EPERM', 'EISDIR'].includes(error.code))
          if (!unsupported) throw error
        } finally {
          if (directoryDescriptor !== undefined) fs.closeSync(directoryDescriptor)
        }
      }
    } catch (error) {
      if (descriptor !== undefined) try { fs.closeSync(descriptor) } catch {}
      if (writeStarted) this.unavailableCode = 'AGENT_CONNECTOR_PACKAGE_AUDIT_UNAVAILABLE'
      if (error?.code?.startsWith('AGENT_CONNECTOR_')) throw error
      fail('AGENT_CONNECTOR_PACKAGE_AUDIT_UNAVAILABLE')
    }
    this.events.push(event)
    this.states = recordState(this.events)
    return event
  }

  import(input, originFilename = 'connector-package.json') {
    this.requireAvailable()
    const packageRecord = parseAgentConnectorPackage(input)
    const existing = this.states.get(packageRecord.packageId)
    if (existing && existing.state !== 'removed') return this.inspect(packageRecord.packageId)
    if (!existing && this.states.size >= MAX_PACKAGES) fail('AGENT_CONNECTOR_PACKAGE_LIMIT')
    const filename = path.basename(String(originFilename || 'connector-package.json'))
    if (!filename || filename.length > 255 || /[\u0000-\u001f\u007f]/.test(filename)) {
      fail('AGENT_CONNECTOR_PACKAGE_ORIGIN_INVALID')
    }
    const serialized = serializeAgentConnectorPackage(packageRecord)
    const originSha256 = crypto.createHash('sha256').update(serialized).digest('hex')
    this.ensureDirectories()
    try {
      atomicWritePrivateFile(this.packagePath(packageRecord.packageId), serialized)
    } catch {
      fail('AGENT_CONNECTOR_PACKAGE_STORE_UNAVAILABLE')
    }
    this.append('imported', packageRecord.packageId, { originFilename: filename, originSha256 })
    return this.inspect(packageRecord.packageId)
  }

  stateFor(packageId) {
    this.requireAvailable()
    const state = this.states.get(String(packageId || ''))
    if (!state) fail('AGENT_CONNECTOR_PACKAGE_NOT_FOUND')
    return state
  }

  transition(packageId, action) {
    const normalizedId = String(packageId || '')
    const current = this.stateFor(normalizedId)
    const allowed = {
      approved: ['imported'],
      installed: ['approved', 'disabled'],
      disabled: ['installed'],
      revoked: ['imported', 'approved', 'installed', 'disabled'],
      removed: ['imported', 'approved', 'disabled', 'revoked'],
    }
    if (!allowed[action]?.includes(current.state)) {
      fail('AGENT_CONNECTOR_PACKAGE_TRANSITION_INVALID')
    }
    this.readPackage(normalizedId)
    this.append(action, normalizedId)
    return this.inspect(normalizedId)
  }

  approve(packageId) { return this.transition(packageId, 'approved') }

  install(packageId) { return this.transition(packageId, 'installed') }

  disable(packageId) { return this.transition(packageId, 'disabled') }

  revoke(packageId) { return this.transition(packageId, 'revoked') }

  remove(packageId) { return this.transition(packageId, 'removed') }

  upgrade(packageId) {
    const normalizedId = String(packageId || '')
    const current = this.stateFor(normalizedId)
    if (current.state !== 'approved') fail('AGENT_CONNECTOR_PACKAGE_TRANSITION_INVALID')
    const target = this.readPackage(normalizedId)
    const installed = this.list().filter(item => (
      item.state === 'installed'
      && item.connectorId === target.manifest.connectorId
      && item.packageId !== normalizedId
    ))
    if (installed.length !== 1) fail('AGENT_CONNECTOR_PACKAGE_UPGRADE_INVALID')
    if (compareSemanticVersions(
      target.manifest.connectorVersion,
      installed[0].connectorVersion,
    ) <= 0) fail('AGENT_CONNECTOR_PACKAGE_UPGRADE_INVALID')
    this.append('upgraded', normalizedId, { fromPackageId: installed[0].packageId })
    return this.inspect(normalizedId)
  }

  inspect(packageId) {
    const normalizedId = String(packageId || '')
    const state = this.stateFor(normalizedId)
    const packageRecord = this.readPackage(normalizedId)
    return Object.freeze({
      packageId: packageRecord.packageId,
      state: state.state,
      publisher: packageRecord.publisher,
      provider: packageRecord.provider,
      manifest: packageRecord.manifest,
      origin: Object.freeze({
        filename: state.originFilename,
        sha256: state.originSha256,
      }),
      updatedAt: state.updatedAt,
    })
  }

  list() {
    this.requireAvailable()
    return [...this.states.keys()].map(packageId => this.inspect(packageId)).map(item => Object.freeze({
      packageId: item.packageId,
      state: item.state,
      publisher: item.publisher,
      providerId: item.provider.id,
      connectorId: item.manifest.connectorId,
      connectorVersion: item.manifest.connectorVersion,
      manifestId: item.manifest.manifestId,
      label: item.manifest.label,
      origin: item.origin,
      updatedAt: item.updatedAt,
    })).sort((left, right) => (
      left.connectorId.localeCompare(right.connectorId)
      || left.connectorVersion.localeCompare(right.connectorVersion)
    ))
  }

  installedPackages() {
    if (this.unavailableCode) return []
    try {
      return [...this.states.entries()]
        .filter(([, state]) => state.state === 'installed')
        .map(([packageId]) => this.inspect(packageId))
    } catch (error) {
      this.unavailableCode = error?.code || 'AGENT_CONNECTOR_PACKAGE_STORE_UNAVAILABLE'
      return []
    }
  }

  packageForManifest(manifestId) {
    if (this.unavailableCode) return null
    const match = this.installedPackages().find(item => item.manifest.manifestId === manifestId)
    return match || null
  }

  audit(packageId) {
    const normalizedId = String(packageId || '')
    this.stateFor(normalizedId)
    return this.events.filter(event => event.packageId === normalizedId)
      .map(event => Object.freeze(JSON.parse(canonicalJson(event))))
  }
}

module.exports = {
  AGENT_CONNECTOR_PACKAGE_VERSION,
  AGENT_CONNECTOR_SDK_VERSION,
  AgentConnectorPackageStore,
  MAX_PACKAGE_BYTES,
  SDK_HTTP_JSON_RECIPE_ID,
  SDK_LOCAL_ECHO_RECIPE_ID,
  SDK_RECIPE_IDS,
  createAgentConnectorPackage,
  parseAgentConnectorPackage,
  serializeAgentConnectorPackage,
}

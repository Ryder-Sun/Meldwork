const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { isSemanticVersion } = require('./agent-connector-manifest.cjs')
const { canonicalJson } = require('../../collaboration/outcome-records.cjs')
const { atomicWritePrivateFile, ensurePrivateDirectory } = require('../../security/private-file.cjs')
const { redactSecrets } = require('../../security/secret-redaction.cjs')

const STORE_VERSION = 1
const MAX_INSTANCES = 128
const MAX_CREDENTIAL_SLOTS = 16
const MAX_CREDENTIAL_BYTES = 64 * 1024
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const MANIFEST_ID = /^connector-manifest-[a-f0-9]{64}$/
const INSTANCE_ID = /^custom-[a-f0-9]{16}$/
const CREDENTIAL_REF = /^credential-ref:[a-f0-9]{32}$/

function storeError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function fail(code) {
  throw storeError(code)
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Reflect.ownKeys(value).sort().join(',') === [...keys].sort().join(',')
}

function clone(value) {
  return JSON.parse(canonicalJson(value))
}

function frozenClone(value) {
  return Object.freeze(clone(value))
}

function normalizeLabel(value) {
  const label = String(value || '').trim()
  if (!label || label.length > 120 || /[\u0000-\u001f\u007f]/.test(label)
      || redactSecrets(label) !== label) {
    fail('AGENT_CONNECTOR_INSTANCE_INVALID')
  }
  return label
}

function normalizeCredentials(value) {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('AGENT_CONNECTOR_CREDENTIAL_INVALID')
  }
  const keys = Reflect.ownKeys(value)
  if (!keys.length || keys.length > MAX_CREDENTIAL_SLOTS
      || keys.some(key => typeof key !== 'string' || !PUBLIC_ID.test(key))) {
    fail('AGENT_CONNECTOR_CREDENTIAL_INVALID')
  }
  const credentials = {}
  for (const key of keys.sort()) {
    if (typeof value[key] !== 'string') fail('AGENT_CONNECTOR_CREDENTIAL_INVALID')
    const secret = value[key].trim()
    if (!secret || secret.length > 8192 || secret.includes('\u0000')) {
      fail('AGENT_CONNECTOR_CREDENTIAL_INVALID')
    }
    credentials[key] = secret
  }
  if (Buffer.byteLength(canonicalJson(credentials)) > MAX_CREDENTIAL_BYTES) {
    fail('AGENT_CONNECTOR_CREDENTIAL_INVALID')
  }
  return credentials
}

function normalizeCreateInput(input) {
  if (!exactKeys(input, [
    'connectorId', 'connectorVersion', 'credentials', 'label', 'manifestId',
  ])) {
    fail('AGENT_CONNECTOR_INSTANCE_INVALID')
  }
  const manifestId = String(input.manifestId || '')
  const connectorId = String(input.connectorId || '')
  const connectorVersion = String(input.connectorVersion || '')
  if (!MANIFEST_ID.test(manifestId) || !PUBLIC_ID.test(connectorId)
      || !isSemanticVersion(connectorVersion)) {
    fail('AGENT_CONNECTOR_INSTANCE_INVALID')
  }
  return {
    manifestId,
    connectorId,
    connectorVersion,
    label: normalizeLabel(input.label),
    credentials: normalizeCredentials(input.credentials),
  }
}

function normalizeInstanceRecord(value) {
  if (!exactKeys(value, [
    'connectorId', 'connectorVersion', 'credentialRef', 'instanceId', 'label', 'manifestId',
  ])) {
    fail('AGENT_CONNECTOR_INSTANCE_STORE_UNAVAILABLE')
  }
  const record = {
    instanceId: String(value.instanceId || ''),
    manifestId: String(value.manifestId || ''),
    connectorId: String(value.connectorId || ''),
    connectorVersion: String(value.connectorVersion || ''),
    label: normalizeLabel(value.label),
    credentialRef: value.credentialRef === null ? null : String(value.credentialRef || ''),
  }
  if (!INSTANCE_ID.test(record.instanceId) || !MANIFEST_ID.test(record.manifestId)
      || !PUBLIC_ID.test(record.connectorId) || !isSemanticVersion(record.connectorVersion)
      || (record.credentialRef !== null && !CREDENTIAL_REF.test(record.credentialRef))) {
    fail('AGENT_CONNECTOR_INSTANCE_STORE_UNAVAILABLE')
  }
  return record
}

function publicRecord(record) {
  return frozenClone({
    instanceId: record.instanceId,
    manifestId: record.manifestId,
    connectorId: record.connectorId,
    connectorVersion: record.connectorVersion,
    label: record.label,
    credentialConfigured: Boolean(record.credentialRef),
  })
}

class AgentConnectorInstanceStore {
  constructor(options = {}) {
    if (!exactKeys(options, ['credentialStoragePath', 'instanceStoragePath', 'safeStorage'])
        || typeof options.instanceStoragePath !== 'string'
        || typeof options.credentialStoragePath !== 'string'
        || !path.isAbsolute(options.instanceStoragePath)
        || !path.isAbsolute(options.credentialStoragePath)
        || options.instanceStoragePath === path.parse(options.instanceStoragePath).root
        || options.credentialStoragePath === path.parse(options.credentialStoragePath).root
        || path.normalize(options.instanceStoragePath) === path.normalize(options.credentialStoragePath)) {
      fail('AGENT_CONNECTOR_INSTANCE_STORE_OPTIONS_INVALID')
    }
    this.instanceStoragePath = path.normalize(options.instanceStoragePath)
    this.credentialStoragePath = path.normalize(options.credentialStoragePath)
    this.safeStorage = options.safeStorage
  }

  encryptionAvailable() {
    try {
      return Boolean(this.safeStorage?.isEncryptionAvailable?.())
    } catch {
      return false
    }
  }

  recordExecution(input) {
    const fields = ['runId', 'agentRunId', 'connectorId', 'connectorVersion', 'manifestId',
      'manifestSchemaVersion', 'instanceId', 'recipeId', 'upstreamId', 'upstreamVersion', 'credentialRefId']
    if (!exactKeys(input, fields)
        || ['runId', 'agentRunId', 'connectorId', 'instanceId', 'recipeId', 'upstreamId']
          .some(key => typeof input[key] !== 'string' || !PUBLIC_ID.test(input[key]))
        || !MANIFEST_ID.test(input.manifestId)
        || !isSemanticVersion(input.connectorVersion) || !isSemanticVersion(input.upstreamVersion)
        || !Number.isSafeInteger(input.manifestSchemaVersion) || input.manifestSchemaVersion < 1
        || (input.credentialRefId !== null && !CREDENTIAL_REF.test(input.credentialRefId))) {
      fail('AGENT_CONNECTOR_EXECUTION_RECORD_INVALID')
    }
    const directory = path.join(path.dirname(this.credentialStoragePath), 'agent-connector-executions')
    const id = crypto.createHash('sha256').update(canonicalJson([input.runId, input.agentRunId])).digest('hex')
    const filename = path.join(directory, `${id}.json`)
    const temporary = path.join(directory, `.${id}.${crypto.randomBytes(8).toString('hex')}.tmp`)
    const content = canonicalJson({ version: 1, ...input })
    let descriptor
    try {
      ensurePrivateDirectory(path.dirname(this.credentialStoragePath))
      ensurePrivateDirectory(directory)
      descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0), 0o600)
      fs.writeFileSync(descriptor, content, 'utf8')
      fs.fsyncSync(descriptor)
      fs.closeSync(descriptor)
      descriptor = undefined
      try {
        fs.linkSync(temporary, filename)
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
        const stat = fs.fstatSync(descriptor)
        if (!stat.isFile() || stat.size > 8192 || fs.readFileSync(descriptor, 'utf8') !== content) {
          fail('AGENT_CONNECTOR_EXECUTION_RECORD_CONFLICT')
        }
        return
      }
      let directoryDescriptor
      try {
        directoryDescriptor = fs.openSync(directory, 'r')
        fs.fsyncSync(directoryDescriptor)
      } catch (error) {
        const unsupported = ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)
          || (process.platform === 'win32' && ['EPERM', 'EISDIR'].includes(error.code))
        if (!unsupported) throw error
      } finally {
        if (directoryDescriptor !== undefined) fs.closeSync(directoryDescriptor)
      }
    } catch (error) {
      if (error?.code === 'AGENT_CONNECTOR_EXECUTION_RECORD_CONFLICT') throw error
      fail('AGENT_CONNECTOR_EXECUTION_RECORD_UNAVAILABLE')
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor)
      try { fs.unlinkSync(temporary) } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
  }

  create(input) {
    const normalized = normalizeCreateInput(input)
    const instanceDocument = this.readInstanceDocument()
    if (instanceDocument.instances.length >= MAX_INSTANCES) {
      fail('AGENT_CONNECTOR_INSTANCE_STORE_LIMIT')
    }
    let instanceId
    do {
      instanceId = `custom-${crypto.randomBytes(8).toString('hex')}`
    } while (instanceDocument.instances.some(item => item.instanceId === instanceId))

    let credentialRef = null
    let previousCredentialDocument = null
    if (normalized.credentials) {
      if (!this.encryptionAvailable()) fail('AGENT_CONNECTOR_ENCRYPTION_UNAVAILABLE')
      const plaintext = canonicalJson(normalized.credentials)
      let encrypted
      try {
        encrypted = this.safeStorage.encryptString(plaintext)
        if (!Buffer.isBuffer(encrypted) || !encrypted.length
            || this.safeStorage.decryptString(encrypted) !== plaintext) {
          throw new Error('invalid encryption result')
        }
      } catch {
        fail('AGENT_CONNECTOR_ENCRYPTION_FAILED')
      }
      previousCredentialDocument = this.readCredentialDocument()
      do {
        credentialRef = `credential-ref:${crypto.randomBytes(16).toString('hex')}`
      } while (Object.hasOwn(previousCredentialDocument.credentials, credentialRef))
      const credentialDocument = clone(previousCredentialDocument)
      credentialDocument.credentials[credentialRef] = {
        encrypted: encrypted.toString('base64'),
      }
      this.writeCredentialDocument(credentialDocument)
    }

    const record = {
      instanceId,
      manifestId: normalized.manifestId,
      connectorId: normalized.connectorId,
      connectorVersion: normalized.connectorVersion,
      label: normalized.label,
      credentialRef,
    }
    instanceDocument.instances.push(record)
    instanceDocument.instances.sort((left, right) => left.instanceId.localeCompare(right.instanceId))
    try {
      this.writeInstanceDocument(instanceDocument)
    } catch (error) {
      if (previousCredentialDocument) {
        try { this.writeCredentialDocument(previousCredentialDocument) } catch { /* orphan remains encrypted */ }
      }
      throw error
    }
    return publicRecord(record)
  }

  list() {
    return this.listRecords().map(publicRecord)
  }

  listRecords() {
    return this.readInstanceDocument().instances.map(frozenClone)
  }

  resolveCredential(credentialRef) {
    const normalizedRef = String(credentialRef || '')
    if (!CREDENTIAL_REF.test(normalizedRef)) fail('AGENT_CONNECTOR_CREDENTIAL_UNAVAILABLE')
    const referenced = this.readInstanceDocument().instances.some(record => (
      record.credentialRef === normalizedRef
    ))
    if (!referenced || !this.encryptionAvailable()) {
      fail('AGENT_CONNECTOR_CREDENTIAL_UNAVAILABLE')
    }
    const entry = this.readCredentialDocument().credentials[normalizedRef]
    if (!entry) fail('AGENT_CONNECTOR_CREDENTIAL_UNAVAILABLE')
    try {
      const encrypted = Buffer.from(entry.encrypted, 'base64')
      if (!encrypted.length || encrypted.toString('base64') !== entry.encrypted) {
        throw new Error('invalid ciphertext')
      }
      const plaintext = this.safeStorage.decryptString(encrypted)
      const parsed = JSON.parse(plaintext)
      const credentials = normalizeCredentials(parsed)
      if (!credentials || canonicalJson(credentials) !== plaintext) {
        throw new Error('invalid credential payload')
      }
      return frozenClone(credentials)
    } catch {
      fail('AGENT_CONNECTOR_CREDENTIAL_UNAVAILABLE')
    }
  }

  delete(instanceId) {
    const normalizedId = String(instanceId || '')
    if (!INSTANCE_ID.test(normalizedId)) fail('AGENT_CONNECTOR_INSTANCE_NOT_FOUND')
    const document = this.readInstanceDocument()
    const index = document.instances.findIndex(item => item.instanceId === normalizedId)
    if (index < 0) fail('AGENT_CONNECTOR_INSTANCE_NOT_FOUND')
    const [removed] = document.instances.splice(index, 1)
    this.writeInstanceDocument(document)

    if (removed.credentialRef) {
      try {
        const credentialDocument = this.readCredentialDocument()
        delete credentialDocument.credentials[removed.credentialRef]
        this.writeCredentialDocument(credentialDocument)
      } catch { /* Removing the instance already revoked an unreadable reference. */ }
    }
    return Object.freeze({ deleted: true, instanceId: normalizedId })
  }

  readInstanceDocument() {
    if (!fs.existsSync(this.instanceStoragePath)) return { version: STORE_VERSION, instances: [] }
    let payload
    try {
      payload = JSON.parse(fs.readFileSync(this.instanceStoragePath, 'utf8'))
    } catch {
      fail('AGENT_CONNECTOR_INSTANCE_STORE_UNAVAILABLE')
    }
    if (!exactKeys(payload, ['instances', 'version']) || payload.version !== STORE_VERSION
        || !Array.isArray(payload.instances) || payload.instances.length > MAX_INSTANCES) {
      fail('AGENT_CONNECTOR_INSTANCE_STORE_UNAVAILABLE')
    }
    const instances = payload.instances.map(normalizeInstanceRecord)
    if (new Set(instances.map(item => item.instanceId)).size !== instances.length
        || new Set(instances.map(item => item.credentialRef).filter(Boolean)).size
          !== instances.filter(item => item.credentialRef).length) {
      fail('AGENT_CONNECTOR_INSTANCE_STORE_UNAVAILABLE')
    }
    return { version: STORE_VERSION, instances }
  }

  readCredentialDocument() {
    if (!fs.existsSync(this.credentialStoragePath)) {
      return { version: STORE_VERSION, credentials: {} }
    }
    let payload
    try {
      payload = JSON.parse(fs.readFileSync(this.credentialStoragePath, 'utf8'))
    } catch {
      fail('AGENT_CONNECTOR_CREDENTIAL_UNAVAILABLE')
    }
    if (!exactKeys(payload, ['credentials', 'version']) || payload.version !== STORE_VERSION
        || !payload.credentials || typeof payload.credentials !== 'object'
        || Array.isArray(payload.credentials)
        || Object.keys(payload.credentials).length > MAX_INSTANCES) {
      fail('AGENT_CONNECTOR_CREDENTIAL_UNAVAILABLE')
    }
    const credentials = {}
    for (const [credentialRef, entry] of Object.entries(payload.credentials)) {
      if (!CREDENTIAL_REF.test(credentialRef) || !exactKeys(entry, ['encrypted'])
          || typeof entry.encrypted !== 'string' || !entry.encrypted) {
        fail('AGENT_CONNECTOR_CREDENTIAL_UNAVAILABLE')
      }
      credentials[credentialRef] = { encrypted: entry.encrypted }
    }
    return { version: STORE_VERSION, credentials }
  }

  writeInstanceDocument(document) {
    if (!document.instances.length) {
      try { fs.unlinkSync(this.instanceStoragePath) } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      return
    }
    atomicWritePrivateFile(this.instanceStoragePath, canonicalJson(document))
  }

  writeCredentialDocument(document) {
    if (!Object.keys(document.credentials).length) {
      try { fs.unlinkSync(this.credentialStoragePath) } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      return
    }
    atomicWritePrivateFile(this.credentialStoragePath, canonicalJson(document))
  }
}

module.exports = {
  AgentConnectorInstanceStore,
  STORE_VERSION,
}

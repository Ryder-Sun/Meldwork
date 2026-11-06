const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { AgentConnectorInstanceStore } = require('../../../src/agents/connectors/agent-connector-instance-store.cjs')

function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: value => Buffer.from(`sealed:${value}`, 'utf8'),
    decryptString: value => {
      const text = Buffer.from(value).toString('utf8')
      if (!text.startsWith('sealed:')) throw new Error('ciphertext invalid')
      return text.slice('sealed:'.length)
    },
  }
}

function fixture(t, safeStorage = fakeSafeStorage()) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-agent-connector-store-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const instanceStoragePath = path.join(directory, 'instances.json')
  const credentialStoragePath = path.join(directory, 'private', 'credentials.json')
  const createStore = () => new AgentConnectorInstanceStore({
    instanceStoragePath,
    credentialStoragePath,
    safeStorage,
  })
  return { createStore, credentialStoragePath, directory, instanceStoragePath }
}

function instanceInput(label, credentials) {
  return {
    manifestId: `connector-manifest-${'a'.repeat(64)}`,
    connectorId: 'external.review-agent',
    connectorVersion: '1.0.0',
    label,
    credentials,
  }
}

test('execution provenance is private, durable, idempotent and bound to its credential reference', t => {
  const { createStore, credentialStoragePath } = fixture(t)
  const store = createStore()
  const account = store.create(instanceInput('Review account', { account: 'private-value' }))
  const instance = store.listRecords().find(item => item.instanceId === account.instanceId)
  const record = { runId: 'run-1', agentRunId: 'agent-run-1', connectorId: instance.connectorId,
    connectorVersion: instance.connectorVersion, manifestId: instance.manifestId, manifestSchemaVersion: 1,
    instanceId: instance.instanceId, recipeId: 'external.review-agent.run', upstreamId: 'review-agent',
    upstreamVersion: '1.0.0', credentialRefId: instance.credentialRef }
  store.recordExecution(record)
  createStore().recordExecution(record)
  const directory = path.join(path.dirname(credentialStoragePath), 'agent-connector-executions')
  const [name] = fs.readdirSync(directory)
  const content = fs.readFileSync(path.join(directory, name), 'utf8')
  assert.deepEqual(JSON.parse(content), { version: 1, ...record })
  assert.doesNotMatch(content, /private-value/)
  assert.throws(() => store.recordExecution({ ...record, credentialRefId: null }), {
    message: 'AGENT_CONNECTOR_EXECUTION_RECORD_CONFLICT',
  })
  const next = { ...record, runId: 'run-after-write-error', agentRunId: 'agent-run-after-write-error' }
  const originalWrite = fs.writeFileSync
  try {
    fs.writeFileSync = () => { throw Object.assign(new Error('simulated write failure'), { code: 'EIO' }) }
    assert.throws(() => store.recordExecution(next), { message: 'AGENT_CONNECTOR_EXECUTION_RECORD_UNAVAILABLE' })
  } finally { fs.writeFileSync = originalWrite }
  assert.deepEqual(fs.readdirSync(directory), [name])
  createStore().recordExecution(next)
  assert.equal(fs.readdirSync(directory).length, 2)
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(directory, name)).mode & 0o777, 0o600)
    fs.unlinkSync(path.join(directory, name))
    fs.symlinkSync(credentialStoragePath, path.join(directory, name))
    assert.throws(() => store.recordExecution(record), { message: 'AGENT_CONNECTOR_EXECUTION_RECORD_UNAVAILABLE' })
  }
})

test('persists multiple Connector accounts with separate encrypted CredentialRefs', (t) => {
  const {
    createStore, credentialStoragePath, instanceStoragePath,
  } = fixture(t)
  const store = createStore()

  const first = store.create(instanceInput('Review account A', {
    account: 'connector-secret-a',
  }))
  const second = store.create(instanceInput('Review account B', {
    account: 'connector-secret-b',
  }))

  assert.equal(first.credentialConfigured, true)
  assert.equal(second.credentialConfigured, true)
  assert.equal(Object.hasOwn(first, 'credentialRef'), false)
  assert.doesNotMatch(JSON.stringify(store.list()), /credential-ref|connector-secret/i)

  const records = store.listRecords()
  assert.equal(records.length, 2)
  assert.notEqual(records[0].credentialRef, records[1].credentialRef)
  const firstRecord = records.find(item => item.instanceId === first.instanceId)
  const secondRecord = records.find(item => item.instanceId === second.instanceId)

  const instanceDocument = fs.readFileSync(instanceStoragePath, 'utf8')
  const credentialDocument = fs.readFileSync(credentialStoragePath, 'utf8')
  assert.match(instanceDocument, /credential-ref:/)
  assert.doesNotMatch(instanceDocument, /encrypted|connector-secret/i)
  assert.match(credentialDocument, /encrypted|credential-ref:/)
  assert.doesNotMatch(credentialDocument, /Review account|external\.review-agent|connector-secret/i)

  const restarted = createStore()
  assert.deepEqual(
    restarted.resolveCredential(firstRecord.credentialRef),
    { account: 'connector-secret-a' },
  )
  assert.deepEqual(
    restarted.resolveCredential(secondRecord.credentialRef),
    { account: 'connector-secret-b' },
  )
})

test('supports credential-free instances without probing safeStorage', (t) => {
  let probes = 0
  const { createStore, credentialStoragePath } = fixture(t, {
    isEncryptionAvailable: () => { probes += 1; return false },
  })
  const instance = createStore().create(instanceInput('Local account', null))

  assert.equal(instance.credentialConfigured, false)
  assert.equal(probes, 0)
  assert.equal(fs.existsSync(credentialStoragePath), false)
})

test('revoked, missing, and corrupt CredentialRefs fail closed', (t) => {
  const { createStore, credentialStoragePath } = fixture(t)
  const store = createStore()
  store.create(instanceInput('Review account A', { account: 'connector-secret-a' }))
  const [record] = store.listRecords()

  store.delete(record.instanceId)
  assert.throws(
    () => store.resolveCredential(record.credentialRef),
    { message: 'AGENT_CONNECTOR_CREDENTIAL_UNAVAILABLE' },
  )

  store.create(instanceInput('Review account B', { account: 'connector-secret-b' }))
  const current = store.listRecords()[0]
  fs.unlinkSync(credentialStoragePath)
  assert.throws(
    () => store.resolveCredential(current.credentialRef),
    { message: 'AGENT_CONNECTOR_CREDENTIAL_UNAVAILABLE' },
  )

  const replacement = createStore()
  replacement.create(instanceInput('Review account C', { account: 'connector-secret-c' }))
  const corrupt = JSON.parse(fs.readFileSync(credentialStoragePath, 'utf8'))
  const corruptRef = replacement.listRecords().find(item => (
    item.label === 'Review account C'
  )).credentialRef
  corrupt.credentials[corruptRef].encrypted = 'not-base64'
  fs.writeFileSync(credentialStoragePath, JSON.stringify(corrupt))
  assert.throws(
    () => replacement.resolveCredential(corruptRef),
    { message: 'AGENT_CONNECTOR_CREDENTIAL_UNAVAILABLE' },
  )
})

test('never writes plaintext when operating-system encryption is unavailable', (t) => {
  const {
    createStore, credentialStoragePath, instanceStoragePath,
  } = fixture(t, fakeSafeStorage(false))

  assert.throws(
    () => createStore().create(instanceInput('Review account', {
      account: 'connector-secret-must-not-persist',
    })),
    { message: 'AGENT_CONNECTOR_ENCRYPTION_UNAVAILABLE' },
  )
  assert.equal(fs.existsSync(instanceStoragePath), false)
  assert.equal(fs.existsSync(credentialStoragePath), false)
})

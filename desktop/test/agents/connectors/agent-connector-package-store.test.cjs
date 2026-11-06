const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  AgentConnectorPackageStore,
  createAgentConnectorPackage,
  parseAgentConnectorPackage,
  serializeAgentConnectorPackage,
} = require('../../../src/agents/connectors/agent-connector-package-store.cjs')
const {
  SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_MANIFEST,
  SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE,
} = require('../../../src/agents/connectors/agent-connector-local.cjs')

function fixture(t) {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-connector-packages-'))
  t.after(() => fs.rmSync(rootPath, { recursive: true, force: true }))
  let tick = 0
  const create = () => new AgentConnectorPackageStore({
    rootPath,
    now: () => new Date(Date.UTC(2026, 7, 10, 0, 0, tick++)),
  })
  return { create, rootPath, store: create() }
}

test('existing Connector package directories are made private', { skip: process.platform === 'win32' }, t => {
  const { rootPath, create } = fixture(t)
  fs.chmodSync(rootPath, 0o755)
  fs.chmodSync(path.join(rootPath, 'packages'), 0o755)
  const store = create()
  assert.equal(store.diagnostic(), '')
  assert.equal(fs.statSync(rootPath).mode & 0o777, 0o700)
  assert.equal(fs.statSync(path.join(rootPath, 'packages')).mode & 0o777, 0o700)
})

test('Connector package store fails closed if private directory permissions cannot be enforced', { skip: process.platform === 'win32' }, t => {
  const { rootPath, create } = fixture(t)
  const original = fs.fchmodSync
  fs.fchmodSync = () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }) }
  t.after(() => { fs.fchmodSync = original })
  const store = create()
  assert.equal(store.diagnostic(), 'EACCES')
  assert.deepEqual(store.installedPackages(), [])
  assert.throws(() => store.list(), { code: 'EACCES' })
  assert.deepEqual(fs.readdirSync(path.join(rootPath, 'packages')), [])
})

test('Connector package store rejects a symlink root before creating directories in its target', { skip: process.platform === 'win32' }, t => {
  const { rootPath } = fixture(t)
  const target = path.join(rootPath, 'unrelated')
  const link = path.join(rootPath, 'redirect')
  fs.mkdirSync(target)
  fs.symlinkSync(target, link)
  const store = new AgentConnectorPackageStore({ rootPath: link })
  assert.equal(store.diagnostic(), 'AGENT_CONNECTOR_PACKAGE_STORE_UNAVAILABLE')
  assert.deepEqual(fs.readdirSync(target), [])
})

test('creates and parses a strict content-addressed Connector package', () => {
  const serialized = serializeAgentConnectorPackage(SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE)
  const parsed = parseAgentConnectorPackage(serialized)
  assert.equal(parsed.packageId, SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE.packageId)
  assert.equal(parsed.manifest.manifestId, SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_MANIFEST.manifestId)

  const forged = JSON.parse(serialized)
  forged.packageId = `connector-package-${'0'.repeat(64)}`
  assert.throws(() => parseAgentConnectorPackage(forged), {
    message: 'AGENT_CONNECTOR_PACKAGE_ID_MISMATCH',
  })
  const executable = JSON.parse(serialized)
  executable.provider.config.command = '/bin/sh'
  assert.throws(() => createAgentConnectorPackage(executable), {
    message: 'AGENT_CONNECTOR_PACKAGE_SCHEMA_INVALID',
  })
  const expandedManifestInput = {
    ...SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_MANIFEST,
    inputTypes: ['text', 'file'],
  }
  delete expandedManifestInput.manifestId
  delete expandedManifestInput.recordType
  delete expandedManifestInput.schemaVersion
  const { createAgentConnectorManifest } = require('../../../src/agents/connectors/agent-connector-manifest.cjs')
  assert.throws(() => createAgentConnectorPackage({
    publisher: SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE.publisher,
    provider: SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE.provider,
    manifest: createAgentConnectorManifest(expandedManifestInput),
  }), { message: 'AGENT_CONNECTOR_PACKAGE_SCHEMA_INVALID' })
})

test('persists the complete trust lifecycle with a hash-chained audit trail', (t) => {
  const { create, rootPath, store } = fixture(t)
  const packageId = SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE.packageId
  const imported = store.import(
    serializeAgentConnectorPackage(SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE),
    '/private/source/local-echo.connector.json',
  )
  assert.equal(imported.state, 'imported')
  assert.equal(imported.origin.filename, 'local-echo.connector.json')
  assert.equal(Object.hasOwn(imported.origin, 'path'), false)
  assert.equal(store.approve(packageId).state, 'approved')
  assert.equal(store.install(packageId).state, 'installed')
  assert.deepEqual(store.installedPackages().map(item => item.packageId), [packageId])
  assert.equal(store.disable(packageId).state, 'disabled')
  assert.equal(store.revoke(packageId).state, 'revoked')
  assert.equal(store.remove(packageId).state, 'removed')

  const events = store.audit(packageId)
  assert.deepEqual(events.map(event => event.action), [
    'imported', 'approved', 'installed', 'disabled', 'revoked', 'removed',
  ])
  assert.equal(events[0].previousEventId, '')
  assert.equal(events[1].previousEventId, events[0].eventId)
  assert.equal(create().inspect(packageId).state, 'removed')
  assert.match(fs.readFileSync(path.join(rootPath, 'audit.jsonl'), 'utf8'), /connector-audit-/)
})

test('reimporting a removed package requires fresh approval and preserves its audit history', (t) => {
  const { create, store } = fixture(t)
  const serialized = serializeAgentConnectorPackage(SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE)
  const packageId = SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE.packageId
  store.import(serialized, 'first.json')
  store.approve(packageId)
  store.install(packageId)
  store.revoke(packageId)
  assert.equal(store.import(serialized, 'again.json').state, 'revoked')
  store.remove(packageId)
  assert.equal(store.import(serialized, 'again.json').state, 'imported')
  assert.equal(store.inspect(packageId).origin.filename, 'again.json')
  assert.throws(() => store.install(packageId), { message: 'AGENT_CONNECTOR_PACKAGE_TRANSITION_INVALID' })
  assert.deepEqual(store.audit(packageId).map(event => event.action), ['imported', 'approved', 'installed', 'revoked', 'removed', 'imported'])
  const reopened = create()
  assert.equal(reopened.inspect(packageId).state, 'imported')
  assert.equal(reopened.approve(packageId).state, 'approved')
  assert.equal(reopened.install(packageId).state, 'installed')
})

test('an uncertain audit append blocks further operations until the store is reopened', (t) => {
  const { create, store } = fixture(t)
  const serialized = serializeAgentConnectorPackage(SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE)
  const packageId = SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE.packageId
  store.import(serialized, 'first.json')
  const original = fs.fsyncSync
  fs.fsyncSync = () => { throw Object.assign(new Error('sync failed'), { code: 'EIO' }) }
  try {
    assert.throws(() => store.approve(packageId), { message: 'AGENT_CONNECTOR_PACKAGE_AUDIT_UNAVAILABLE' })
  } finally {
    fs.fsyncSync = original
  }
  assert.equal(store.diagnostic(), 'AGENT_CONNECTOR_PACKAGE_AUDIT_UNAVAILABLE')
  assert.throws(() => store.approve(packageId), { message: 'AGENT_CONNECTOR_PACKAGE_AUDIT_UNAVAILABLE' })
  const reopened = create()
  assert.equal(reopened.inspect(packageId).state, 'approved')
  assert.deepEqual(reopened.audit(packageId).map(event => event.action), ['imported', 'approved'])
})

test('the first audit append syncs its parent directory', (t) => {
  if (process.platform === 'win32') return t.skip('directory handles are not portable on Windows')
  const { rootPath, store } = fixture(t)
  const open = fs.openSync
  let directorySyncs = 0
  fs.openSync = (...args) => {
    if (args[0] === rootPath && args[1] === 'r') directorySyncs += 1
    return open(...args)
  }
  try {
    store.import(serializeAgentConnectorPackage(SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE), 'first.json')
    assert.equal(directorySyncs, 1)
    store.approve(SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE.packageId)
    assert.equal(directorySyncs, 1)
  } finally {
    fs.openSync = open
  }
})

test('an audit directory sync failure leaves the store unavailable until reload', (t) => {
  if (process.platform === 'win32') return t.skip('directory handles are not portable on Windows')
  const { rootPath, create, store } = fixture(t)
  const root = fs.statSync(rootPath)
  const sync = fs.fsyncSync
  fs.fsyncSync = descriptor => {
    const stat = fs.fstatSync(descriptor)
    if (stat.isDirectory() && stat.dev === root.dev && stat.ino === root.ino) {
      throw Object.assign(new Error('directory sync failed'), { code: 'EIO' })
    }
    return sync(descriptor)
  }
  try {
    assert.throws(() => store.import(serializeAgentConnectorPackage(SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE)), {
      message: 'AGENT_CONNECTOR_PACKAGE_AUDIT_UNAVAILABLE',
    })
  } finally {
    fs.fsyncSync = sync
  }
  assert.equal(store.diagnostic(), 'AGENT_CONNECTOR_PACKAGE_AUDIT_UNAVAILABLE')
  assert.equal(create().inspect(SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE.packageId).state, 'imported')
})

test('upgrades one installed Connector version and fails closed on audit tampering', (t) => {
  const { create, rootPath, store } = fixture(t)
  const first = SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE
  const secondManifest = {
    ...SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_MANIFEST,
    connectorVersion: '1.1.0',
  }
  delete secondManifest.manifestId
  delete secondManifest.recordType
  delete secondManifest.schemaVersion
  const { createAgentConnectorManifest } = require('../../../src/agents/connectors/agent-connector-manifest.cjs')
  const second = createAgentConnectorPackage({
    publisher: first.publisher,
    provider: first.provider,
    manifest: createAgentConnectorManifest(secondManifest),
  })
  store.import(serializeAgentConnectorPackage(first), 'first.json')
  store.approve(first.packageId)
  store.install(first.packageId)
  store.import(serializeAgentConnectorPackage(second), 'second.json')
  store.approve(second.packageId)
  const append = store.append.bind(store)
  store.append = (action, ...args) => {
    if (action === 'upgraded') throw new Error('SIMULATED_UPGRADE_WRITE_FAILURE')
    return append(action, ...args)
  }
  assert.throws(() => store.upgrade(second.packageId), { message: 'SIMULATED_UPGRADE_WRITE_FAILURE' })
  assert.equal(store.inspect(first.packageId).state, 'installed')
  assert.equal(create().inspect(first.packageId).state, 'installed')
  assert.equal(store.inspect(second.packageId).state, 'approved')
  store.append = append
  assert.equal(store.upgrade(second.packageId).state, 'installed')
  assert.equal(store.inspect(first.packageId).state, 'disabled')
  assert.deepEqual(store.audit(second.packageId).map(event => event.action), [
    'imported', 'approved', 'upgraded',
  ])
  const legacy = fixture(t)
  legacy.store.import(serializeAgentConnectorPackage(first), 'first.json')
  legacy.store.approve(first.packageId)
  legacy.store.install(first.packageId)
  legacy.store.import(serializeAgentConnectorPackage(second), 'second.json')
  legacy.store.approve(second.packageId)
  legacy.store.append('disabled', first.packageId)
  legacy.store.append('upgraded', second.packageId, { fromPackageId: first.packageId })
  const reopenedLegacy = legacy.create()
  assert.equal(reopenedLegacy.inspect(first.packageId).state, 'disabled')
  assert.equal(reopenedLegacy.inspect(second.packageId).state, 'installed')
  const lowerManifestInput = {
    ...SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_MANIFEST,
    connectorVersion: '0.9.0',
  }
  delete lowerManifestInput.manifestId
  delete lowerManifestInput.recordType
  delete lowerManifestInput.schemaVersion
  const lower = createAgentConnectorPackage({
    publisher: first.publisher,
    provider: first.provider,
    manifest: createAgentConnectorManifest(lowerManifestInput),
  })
  store.import(serializeAgentConnectorPackage(lower), 'lower.json')
  store.approve(lower.packageId)
  assert.throws(() => store.upgrade(lower.packageId), {
    message: 'AGENT_CONNECTOR_PACKAGE_UPGRADE_INVALID',
  })

  fs.appendFileSync(path.join(rootPath, 'audit.jsonl'), '{"tampered":true}\n')
  const unavailable = create()
  assert.deepEqual(unavailable.installedPackages(), [])
  assert.equal(unavailable.diagnostic(), 'AGENT_CONNECTOR_PACKAGE_AUDIT_INVALID')
  assert.throws(() => unavailable.list(), {
    message: 'AGENT_CONNECTOR_PACKAGE_AUDIT_INVALID',
  })
})

test('installed package symlinks disable Connectors without blocking store construction', (t) => {
  const { create, rootPath, store } = fixture(t)
  const packageRecord = SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE
  store.import(serializeAgentConnectorPackage(packageRecord), 'echo.json')
  store.approve(packageRecord.packageId)
  store.install(packageRecord.packageId)
  const filename = path.join(rootPath, 'packages', `${packageRecord.packageId}.json`)
  const replacement = path.join(rootPath, 'replacement.json')
  fs.renameSync(filename, replacement)
  fs.symlinkSync(replacement, filename)

  const restarted = create()
  assert.deepEqual(restarted.installedPackages(), [])
  assert.equal(restarted.diagnostic(), 'AGENT_CONNECTOR_PACKAGE_UNAVAILABLE')
  assert.throws(() => restarted.list(), {
    message: 'AGENT_CONNECTOR_PACKAGE_UNAVAILABLE',
  })
})

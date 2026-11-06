const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { ContentBlobStore } = require('../../src/attachments/content-blob-store.cjs')
const { DEFAULT_FILESYSTEM_CONNECTOR_ID } = require('../../src/knowledge/knowledge-connector-filesystem.cjs')
const { DEFAULT_MEMORY_CONNECTOR_ID } = require('../../src/knowledge/knowledge-connector-memory.cjs')
const {
  LocalKnowledgeConnectors,
  authorizeLocalInstance,
} = require('../../src/knowledge/local-knowledge-connectors.cjs')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-local-connectors-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const vaultPath = path.join(directory, 'Obsidian Vault')
  fs.mkdirSync(path.join(vaultPath, 'notes'), { recursive: true })
  const filename = path.join(vaultPath, 'notes', 'decision.md')
  fs.writeFileSync(filename, [
    '# Decision',
    'Use immutable source evidence.',
    'api_key=sk-local-connector-secret-123456',
    `vault=${vaultPath}`,
    'credential-ref:opaque-renderer-secret',
  ].join('\n'))
  const contentBlobStore = new ContentBlobStore({
    rootPath: path.join(directory, 'private', 'content-blobs'),
  })
  const create = () => new LocalKnowledgeConnectors({
    contentBlobStore,
    getObsidianVaultPath: () => vaultPath,
  })
  return { contentBlobStore, create, filename, vaultPath }
}

test('knowledge connector records are synced and a failed replacement preserves the previous file', async t => {
  const { create } = fixture(t)
  const connectors = create()
  const originalSync = fs.fsyncSync
  const synced = []
  fs.fsyncSync = fd => { synced.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file'); return originalSync(fd) }
  t.after(() => { fs.fsyncSync = originalSync })
  const instance = (await connectors.list()).find(item => item.connectorId === DEFAULT_FILESYSTEM_CONNECTOR_ID)
  await connectors.revoke(instance.instanceId)
  const before = fs.readFileSync(connectors.storagePath, 'utf8')
  assert.equal(synced.includes('file'), true)
  if (process.platform !== 'win32') assert.equal(synced.includes('directory'), true)
  const rename = fs.renameSync
  fs.renameSync = () => { throw new Error('REPLACE_FAILED') }
  t.after(() => { fs.renameSync = rename })
  await assert.rejects(connectors.authorize(DEFAULT_FILESYSTEM_CONNECTOR_ID), { message: 'REPLACE_FAILED' })
  assert.equal(fs.readFileSync(connectors.storagePath, 'utf8'), before)
  assert.equal((await connectors.list()).some(item => item.instanceId === instance.instanceId), false)
  assert.equal(fs.readdirSync(path.dirname(connectors.storagePath)).some(name => name.endsWith('.tmp')), false)
})

test('exposes two production implementations and a sanitized complete source lifecycle', async (t) => {
  const { create, vaultPath } = fixture(t)
  const connectors = create()
  const instances = await connectors.list()
  assert.equal(instances.length, 2)
  assert.deepEqual(instances.map(instance => instance.connectorId), [
    DEFAULT_MEMORY_CONNECTOR_ID,
    DEFAULT_FILESYSTEM_CONNECTOR_ID,
  ])
  assert.equal(instances.every(instance => instance.accessMode === 'read-only'), true)
  assert.equal(instances.every(instance => instance.credentialConfigured === false), true)
  assert.equal(instances.every(instance => instance.authorized === true), true)

  const instanceId = instances.find(instance => (
    instance.connectorId === DEFAULT_FILESYSTEM_CONNECTOR_ID
  )).instanceId
  const probe = await connectors.probe(instanceId)
  const search = await connectors.search(instanceId, { query: 'immutable', limit: 5 })
  assert.equal(probe.status, 'ready')
  assert.equal(search.length, 1)
  assert.equal(search[0].locator, 'notes/decision.md')
  assert.match(search[0].snippet, /\[redacted\]/)
  assert.doesNotMatch(search[0].snippet, /sk-local-connector-secret/)

  const fetched = await connectors.fetch(instanceId, {
    sourceId: search[0].sourceId,
    locator: search[0].locator,
  })
  assert.match(fetched.content, /\[redacted\]/)
  assert.doesNotMatch(fetched.content, /sk-local-connector-secret/)
  const snapshot = await connectors.snapshot(instanceId, {
    sourceId: search[0].sourceId,
    locator: search[0].locator,
  })
  assert.equal(Object.hasOwn(snapshot, 'contentRef'), false)
  assert.equal(Object.hasOwn(snapshot, 'locator'), false)
  const cited = await connectors.citation(instanceId, { snapshotId: snapshot.snapshotId })
  assert.equal(cited.citation.verification, 'snapshot')
  assert.equal(Object.hasOwn(cited.citation, 'contentRef'), false)
  assert.equal(Object.hasOwn(cited.citation, 'locator'), false)
  assert.doesNotMatch(cited.content, /sk-local-connector-secret/)
  assert.deepEqual(
    await connectors.citation(instanceId, { citationId: cited.citation.citationId }),
    cited,
  )
  const restarted = create()
  assert.deepEqual(
    await restarted.citation(instanceId, { citationId: cited.citation.citationId }),
    cited,
  )
  const durableIndex = fs.readFileSync(path.join(
    path.dirname(connectors.contentBlobStore.rootPath),
    'knowledge-connector-records.json',
  ), 'utf8')
  assert.doesNotMatch(durableIndex, /sk-local-connector-secret|immutable source evidence/)
  assert.doesNotMatch(durableIndex, new RegExp(vaultPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  const selected = await connectors.select(instanceId, {
    sourceId: search[0].sourceId,
    locator: search[0].locator,
    captureMode: 'snapshot',
  })
  const publicJson = JSON.stringify({ instances, probe, search, selected })
  assert.equal(Object.isFrozen(selected), true)
  assert.equal(Object.hasOwn(selected, 'locator'), false)
  assert.doesNotMatch(publicJson, new RegExp(vaultPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(publicJson, /credentialRef|opaque-renderer-secret|sk-local-connector-secret/i)
  await assert.rejects(
    () => connectors.fetch(instanceId, {
      sourceId: `knowledge-source-${'a'.repeat(64)}`,
      locator: 'notes/private.md',
    }),
    { message: 'LOCAL_KNOWLEDGE_SOURCE_NOT_GRANTED' },
  )

  const memory = instances.find(instance => instance.connectorId === DEFAULT_MEMORY_CONNECTOR_ID)
  const [memorySource] = await connectors.search(memory.instanceId, {
    query: 'Electron main process', limit: 5,
  })
  const memorySnapshot = await connectors.snapshot(memory.instanceId, {
    sourceId: memorySource.sourceId,
    locator: memorySource.locator,
  })
  const memoryCitation = await connectors.citation(memory.instanceId, {
    snapshotId: memorySnapshot.snapshotId,
  })
  assert.match(memoryCitation.content, /Electron main process/)
})

test('captures immutable snapshots, preserves live semantics, and verifies citations after restart', async (t) => {
  const { contentBlobStore, create, filename, vaultPath } = fixture(t)
  const connectors = create()
  const instance = (await connectors.list()).find(item => (
    item.connectorId === DEFAULT_FILESYSTEM_CONNECTOR_ID
  ))
  const [source] = await connectors.search(instance.instanceId, {
    query: 'immutable', limit: 5,
  })
  const selected = await connectors.select(instance.instanceId, {
    sourceId: source.sourceId,
    locator: source.locator,
    captureMode: 'snapshot',
  })
  const prepared = await connectors.prepareSelection(selected.selectionId)
  const originalBytes = contentBlobStore.read(prepared.snapshot.contentRef)
  assert.match(originalBytes.toString('utf8'), /immutable source evidence/)
  assert.equal(prepared.captureMode, 'snapshot')
  assert.equal(prepared.citation.verification, 'snapshot')
  assert.doesNotMatch(JSON.stringify(prepared), new RegExp(vaultPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  fs.writeFileSync(filename, '# Decision\nRevised live evidence')
  const restarted = create()
  const reopened = await restarted.verifyCitation({
    snapshot: prepared.snapshot,
    citation: prepared.citation,
  })
  assert.equal(reopened.content, originalBytes.toString('utf8'))

  const [liveSource] = await restarted.search(instance.instanceId, {
    query: 'Revised', limit: 5,
  })
  const liveSelection = await restarted.select(instance.instanceId, {
    sourceId: liveSource.sourceId,
    locator: liveSource.locator,
    captureMode: 'live-reference',
  })
  fs.writeFileSync(filename, '# Decision\nLatest live evidence')
  const livePrepared = await restarted.prepareSelection(liveSelection.selectionId)
  assert.notEqual(livePrepared.snapshot.contentHash, liveSelection.contentHash)
  assert.equal(livePrepared.captureMode, 'live-reference')
  assert.equal(livePrepared.citation.verification, 'live')
  const verifiedLive = await restarted.verifyCitation({
    snapshot: livePrepared.snapshot,
    citation: livePrepared.citation,
  })
  assert.equal(verifiedLive.content, '# Decision\nLatest live evidence')
})

test('revocation invalidates outstanding selections and strict requests fail closed', async (t) => {
  const { create } = fixture(t)
  const connectors = create()
  const instance = (await connectors.list()).find(item => (
    item.connectorId === DEFAULT_FILESYSTEM_CONNECTOR_ID
  ))
  const [source] = await connectors.search(instance.instanceId, {
    query: 'immutable', limit: 5,
  })
  const selected = await connectors.select(instance.instanceId, {
    sourceId: source.sourceId,
    locator: source.locator,
    captureMode: 'snapshot',
  })
  await assert.rejects(
    () => connectors.search(instance.instanceId, { query: 'immutable', limit: 5, path: '/tmp' }),
    { message: 'LOCAL_KNOWLEDGE_SEARCH_INVALID' },
  )
  await assert.rejects(
    () => connectors.select(instance.instanceId, {
      sourceId: source.sourceId,
      locator: source.locator,
      captureMode: 'snapshot',
      credentialRef: 'credential-ref:must-not-pass',
    }),
    { message: 'LOCAL_KNOWLEDGE_SELECTION_INVALID' },
  )

  const revoked = await connectors.revoke(instance.instanceId)
  assert.equal(revoked.authorized, false)
  await assert.rejects(
    () => connectors.prepareSelection(selected.selectionId),
    { message: 'LOCAL_KNOWLEDGE_SELECTION_NOT_FOUND' },
  )
  assert.equal((await connectors.list()).some(item => item.instanceId === instance.instanceId), false)
  const restarted = create()
  assert.equal((await restarted.list()).some(item => item.instanceId === instance.instanceId), false)
  const reauthorized = await restarted.authorize(DEFAULT_FILESYSTEM_CONNECTOR_ID)
  assert.equal(reauthorized.instanceId, instance.instanceId)
  assert.equal(reauthorized.authorized, true)
})

test('startup auto-authorization rejects future credential-bearing instances', () => {
  assert.throws(
    () => authorizeLocalInstance({ authorize: async () => ({}) }, 'knowledge.remote', {
      credentialLifecycle: 'persistent',
      credentialRef: 'credential-ref:remote-account',
    }),
    { message: 'LOCAL_KNOWLEDGE_AUTO_AUTHORIZATION_FORBIDDEN' },
  )
})

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const { ContentBlobStore } = require('../../src/attachments/content-blob-store.cjs')
const { LocalSkillCatalog } = require('../../src/skills/local-skill-catalog.cjs')
const { LocalSkillSnapshotStore } = require('../../src/skills/local-skill-snapshot.cjs')
const { LocalSkillSnapshotSelections } = require('../../src/skills/local-skill-snapshot-selections.cjs')
const { LocalSkillTrustStore } = require('../../src/skills/local-skill-trust-store.cjs')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { RunScheduler } = require('../../src/runs/run-scheduler.cjs')
const { fixture: workspaceFixture, deferred } = require('../support/local-workspace-test-helpers.cjs')

function skillManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    recordType: 'meldwork-skill-manifest',
    identity: { id: 'global/review', version: '1.0.0' },
    origin: { type: 'local-unsigned', publisher: 'Local author' },
    agents: [{ kind: 'codex', minVersion: '0.100.0', maxVersion: '1.0.0' }],
    inputTypes: ['text'],
    tools: ['filesystem'],
    credentials: [],
    permissionMode: 'read-only',
    networkDestinations: [],
    sideEffectClass: 'none',
    ...overrides,
  }
}

function removeFixture(directory) {
  if (!fs.existsSync(directory)) return
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      fs.chmodSync(filename, 0o700)
      removeFixture(filename)
    } else {
      fs.chmodSync(filename, 0o600)
    }
  }
  fs.rmSync(directory, { recursive: true, force: true })
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-skill-selections-'))
  t.after(() => removeFixture(directory))
  const skillDirectory = path.join(directory, 'home', '.codex', 'skills', 'review')
  fs.mkdirSync(path.join(skillDirectory, 'references'), { recursive: true })
  fs.writeFileSync(path.join(skillDirectory, 'SKILL.md'), '# Original Skill\n')
  fs.writeFileSync(
    path.join(skillDirectory, 'meldwork.skill.json'),
    `${JSON.stringify(skillManifest())}\n`,
  )
  fs.writeFileSync(path.join(skillDirectory, 'references', 'rules.md'), 'Original rules\n')
  const contentBlobStore = new ContentBlobStore({
    rootPath: path.join(directory, 'private', 'blobs'),
  })
  const snapshotStore = new LocalSkillSnapshotStore({
    contentBlobStore,
    rootPath: path.join(directory, 'private', 'materialized'),
  })
  const catalog = new LocalSkillCatalog({ home: path.join(directory, 'home') })
  const trustStore = new LocalSkillTrustStore({
    storagePath: path.join(directory, 'private', 'skill-trust.jsonl'),
  })
  const approvals = []
  const selections = new LocalSkillSnapshotSelections({
    catalog,
    snapshotStore,
    contentBlobStore,
    trustStore,
    requestTrust: async request => {
      approvals.push(request)
      return true
    },
  })
  return {
    approvals, catalog, contentBlobStore, directory, selections, skillDirectory, trustStore,
  }
}

function persistedHint(value) {
  return JSON.parse(JSON.stringify(value))
}

test('captures a trusted current selection without serializing source or materialized paths', async (t) => {
  const { approvals, catalog, directory, selections } = fixture(t)
  const selected = catalog.list('codex').skills[0]
  const [runtime] = await selections.prepare('codex', [selected])
  const persisted = persistedHint(runtime)

  assert.equal(fs.readFileSync(runtime.entryPath, 'utf8'), '# Original Skill\n')
  assert.deepEqual(Object.keys(persisted).sort(), [
    'manifestHash', 'name', 'namespace', 'slug', 'snapshotId', 'snapshotRef', 'targetKind',
  ])
  assert.equal(JSON.stringify(persisted).includes(directory), false)
  assert.equal(Object.keys(runtime).includes('entryPath'), false)
  assert.equal(Object.keys(runtime).includes('approvedSkillManifest'), false)
  assert.equal(approvals.length, 1)
})

test('restores the same trusted immutable snapshot after the live Skill changes or disappears', async (t) => {
  const { approvals, catalog, selections, skillDirectory } = fixture(t)
  const [captured] = await selections.prepare('codex', [catalog.list('codex').skills[0]])
  const persisted = persistedHint(captured)
  fs.writeFileSync(path.join(skillDirectory, 'SKILL.md'), '# Mutated Skill\n')
  fs.rmSync(path.join(skillDirectory, 'references'), { recursive: true })

  const [restored] = await selections.prepare('codex', [persisted])

  assert.equal(restored.snapshotId, captured.snapshotId)
  assert.equal(fs.readFileSync(restored.entryPath, 'utf8'), '# Original Skill\n')
  assert.equal(
    fs.readFileSync(path.join(path.dirname(restored.entryPath), 'references', 'rules.md'), 'utf8'),
    'Original rules\n',
  )
  assert.equal(approvals.length, 1)
})

test('rejects mixed, forged, missing, or tampered snapshot selections', async (t) => {
  const { catalog, contentBlobStore, selections } = fixture(t)
  const selected = catalog.list('codex').skills[0]
  const [captured] = await selections.prepare('codex', [selected])
  const persisted = persistedHint(captured)

  await assert.rejects(
    selections.prepare('codex', [selected, persisted]),
    { message: 'LOCAL_SKILL_SELECTION_INVALID' },
  )
  await assert.rejects(
    selections.prepare('codex', [{ ...persisted, manifestHash: 'b'.repeat(64) }]),
    { message: 'LOCAL_SKILL_SELECTION_INVALID' },
  )
  await assert.rejects(
    selections.prepare('hermes', [persisted]),
    { message: 'LOCAL_SKILL_SELECTION_INVALID' },
  )
  const missing = {
    ...persisted,
    snapshotRef: {
      ...persisted.snapshotRef,
      hash: 'c'.repeat(64),
    },
  }
  await assert.rejects(
    selections.prepare('codex', [missing]),
    { message: 'LOCAL_SKILL_SNAPSHOT_RESTORE_FAILED' },
  )

  const filename = path.join(
    contentBlobStore.rootPath,
    'sha256',
    persisted.snapshotRef.hash.slice(0, 2),
    persisted.snapshotRef.hash,
  )
  fs.chmodSync(filename, 0o600)
  fs.writeFileSync(filename, Buffer.alloc(persisted.snapshotRef.size, 0x78), { mode: 0o600 })
  await assert.rejects(
    selections.prepare('codex', [persisted]),
    { message: 'LOCAL_SKILL_SNAPSHOT_RESTORE_FAILED' },
  )
})

test('content upgrades require a new approval and revoked trust blocks restore', async (t) => {
  const { approvals, catalog, selections, skillDirectory, trustStore } = fixture(t)
  const selected = catalog.list('codex').skills[0]
  const [first] = await selections.prepare('codex', [selected])
  const firstBindingId = first.trustBindingId

  fs.writeFileSync(path.join(skillDirectory, 'SKILL.md'), '# Upgraded Skill\n')
  const [upgraded] = await selections.prepare('codex', [selected])
  assert.notEqual(upgraded.manifestHash, first.manifestHash)
  assert.notEqual(upgraded.trustBindingId, firstBindingId)
  assert.equal(approvals.length, 2)

  trustStore.revoke(upgraded.trustBindingId)
  await assert.rejects(
    selections.prepare('codex', [persistedHint(upgraded)]),
    { message: 'LOCAL_SKILL_TRUST_REQUIRED' },
  )
})

for (const revokeAt of ['queued', 'after-lease', 'never']) test(`a queued Skill handles trust ${revokeAt}`, async t => {
  const { catalog, selections, trustStore } = fixture(t)
  const workspaceSetup = workspaceFixture()
  t.after(() => fs.rmSync(workspaceSetup.directory, { recursive: true, force: true }))
  const scheduler = new RunScheduler({ globalLimit: 1 })
  const blocker = await scheduler.acquire({ taskId: 'blocking-task', workspaceKey: 'blocking-workspace' })
  t.after(() => blocker.release())
  const prepared = deferred()
  let calls = 0
  let bindingId
  let validations = 0
  workspaceSetup.options.runScheduler = scheduler
  workspaceSetup.options.detectAgents = async () => [{ kind: 'codex', name: 'Codex',
    executable: '/tmp/codex', version: 'codex-cli 0.146.0', resolvedVersion: '0.146.0', compatibilityState: 'compatible' }]
  workspaceSetup.options.validateSkillSelections = async (kind, selected) => {
    const result = await selections.prepare(kind, selected)
    if (result.length && !bindingId) { bindingId = result[0].trustBindingId; prepared.resolve() }
    if (result.length && ++validations === 2 && revokeAt === 'after-lease') trustStore.revoke(bindingId)
    return result
  }
  workspaceSetup.options.runAgent = async () => { calls += 1; return { text: 'Skill response', outcome: 'completed' } }
  const workspace = new LocalWorkspace(workspaceSetup.options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({ name: 'Revoked Skill', agentKinds: ['codex'],
    workdir: workspaceSetup.directory, allowWrite: false })
  const pending = workspace.sendMessage({ groupId: group.id, text: 'Review', targetKinds: ['codex'],
    skillHints: [catalog.list('codex').skills[0]] })
  await prepared.promise
  if (revokeAt === 'queued') trustStore.revoke(bindingId)
  blocker.release()
  await pending
  assert.equal(calls, revokeAt === 'never' ? 1 : 0)
  if (revokeAt !== 'never') assert.ok(workspace.snapshot().messages.some(message => (
    message.system?.params?.reason === 'LOCAL_SKILL_TRUST_REQUIRED'
  )))
  else assert.ok(workspace.snapshot().messages.some(message => message.content === 'Skill response'))
})

test('rejects missing manifests and manifest upgrades that are not explicitly approved', async (t) => {
  const { approvals, catalog, selections, skillDirectory } = fixture(t)
  const selected = catalog.list('codex').skills[0]
  fs.rmSync(path.join(skillDirectory, 'meldwork.skill.json'))
  await assert.rejects(
    selections.prepare('codex', [selected]),
    { message: 'LOCAL_SKILL_MANIFEST_MISSING' },
  )
  assert.equal(approvals.length, 0)
})

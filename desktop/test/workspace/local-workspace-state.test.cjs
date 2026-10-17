const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadWorkspaceState, workspaceSnapshot } = require('../../src/workspace/local-workspace-state.cjs')

test('snapshot exposes only the newest bound run outcome without private ledger fields', () => {
  const record = { runId: 'run-new', groupId: 'group', threadRootId: 'root', status: 'completed',
    targetKinds: ['codex'], startedAt: 20, finishedAt: 30,
    sessionRef: '/private/native-session', reason: 'secret', agentRuns: [{ output: 'private' }] }
  const snapshot = workspaceSnapshot({
    detectedAgents: [], preparingRuns: new Map(), activeRuns: new Map(),
    state: { groups: [{ id: 'group' }], messages: [{ id: 'root', groupId: 'group', role: 'user' }] },
    runLedger: { list: () => [record,
      { ...record, runId: 'run-old', startedAt: 10, finishedAt: 40, status: 'failed' },
      { ...record, groupId: 'other' }, { ...record, threadRootId: 'missing' },
    ] },
  })
  assert.deepEqual(snapshot.runOutcomes, [{ runId: 'run-new', groupId: 'group', threadRootId: 'root',
    status: 'completed', targetKinds: ['codex'], startedAt: 20, finishedAt: 30 }])
  assert.deepEqual(snapshot.runs, [])
  snapshot.runOutcomes[0].targetKinds.push('hermes')
  assert.deepEqual(record.targetKinds, ['codex'])
})

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-workspace-state-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return path.join(directory, 'workspace.json')
}

test('distinguishes missing, corrupt, unreadable, unsupported, and valid workspace state', (t) => {
  const storagePath = fixture(t)

  assert.deepEqual(loadWorkspaceState(storagePath), {
    state: {
      version: 3, groups: [], messages: [], sessions: {}, sessionMeta: {},
      agentPreferences: {}, agentRuntime: {},
    },
    status: 'missing',
    trusted: true,
    diagnostic: '',
  })

  fs.writeFileSync(storagePath, '{invalid json')
  assert.equal(loadWorkspaceState(storagePath).status, 'corrupt')
  assert.equal(loadWorkspaceState(storagePath).diagnostic, 'LOCAL_WORKSPACE_STATE_CORRUPT')

  fs.writeFileSync(storagePath, JSON.stringify({ version: 99, groups: [], messages: [], sessions: {} }))
  assert.equal(loadWorkspaceState(storagePath).status, 'unsupported')
  assert.equal(loadWorkspaceState(storagePath).diagnostic, 'LOCAL_WORKSPACE_STATE_UNSUPPORTED')

  fs.rmSync(storagePath)
  fs.mkdirSync(storagePath)
  assert.equal(loadWorkspaceState(storagePath).status, 'unreadable')
  assert.equal(loadWorkspaceState(storagePath).diagnostic, 'LOCAL_WORKSPACE_STATE_UNREADABLE')

  fs.rmSync(storagePath, { recursive: true })
  fs.writeFileSync(storagePath, JSON.stringify({ version: 3, groups: [], messages: [], sessions: {} }))
  assert.equal(loadWorkspaceState(storagePath).status, 'ready')
  assert.equal(loadWorkspaceState(storagePath).trusted, true)
})

test('a group emptied by an earlier build is recovered from its replies instead of dropped', (t) => {
  const storagePath = fixture(t)
  fs.writeFileSync(storagePath, JSON.stringify({
    version: 3,
    groups: [
      { id: 'emptied', name: 'Emptied', agentKinds: [], workdir: '/tmp' },
      { id: 'silent', name: 'Never replied', agentKinds: [], workdir: '/tmp' },
    ],
    messages: [
      { id: 'u1', groupId: 'emptied', role: 'user', content: 'Plan it' },
      { id: 'a1', groupId: 'emptied', role: 'agent', agentKind: 'hermes', content: 'Hermes reply' },
      { id: 'a2', groupId: 'emptied', role: 'agent', agentKind: 'codex', content: 'Codex reply' },
      { id: 'a3', groupId: 'emptied', role: 'agent', agentKind: 'hermes', content: 'Hermes again' },
      { id: 'u2', groupId: 'silent', role: 'user', content: 'Nobody answered' },
    ],
    sessions: {},
  }))

  const { state, trusted } = loadWorkspaceState(storagePath)
  assert.equal(trusted, true)
  assert.deepEqual(state.groups.map(group => [group.id, group.agentKinds]), [
    ['emptied', ['hermes', 'codex']],
  ])
  assert.deepEqual(state.messages.map(message => message.id), ['u1', 'a1', 'a2', 'a3'])
})

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { switchNativeSessionProfile } = require('../../src/workspace/native-session-profiles.cjs')
const { saveWorkspaceState, loadWorkspaceState, workspaceSnapshot } = require('../../src/workspace/local-workspace-state.cjs')
const { sessionKey, resolveSessionState, clearSessionState } = require('../../src/workspace/local-workspace-context.cjs')
const { LocalWorkspaceConversations } = require('../../src/workspace/local-workspace-conversations.cjs')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { fixture } = require('../support/local-workspace-test-helpers.cjs')

test('switching native profiles preserves direct, group and other Agent sessions across reload', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-native-sessions-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'workspace.json')
  let state = { version: 3, groups: [
    { id: 'direct', agentKinds: ['hermes'], conversationType: 'direct' },
    { id: 'group', agentKinds: ['hermes', 'codex'] },
  ], messages: [], sessions: { 'direct:hermes': 'direct-a', 'group:hermes': 'group-a', 'group:codex': 'codex-a' },
  sessionMeta: {}, agentPreferences: {}, agentRuntime: {} }
  switchNativeSessionProfile(state, 'hermes', '', '/profile-b')
  assert.deepEqual(state.sessions, { 'group:codex': 'codex-a' })
  const snapshot = workspaceSnapshot({ state, detectedAgents: [], preparingRuns: new Map(), activeRuns: new Map() })
  assert.doesNotMatch(JSON.stringify(snapshot), /direct-a|group-a|nativeSessionProfiles/)
  assert.equal(resolveSessionState({ state, group: state.groups[0], kind: 'hermes', save() {} }).sessionRef, '')
  state.sessions['direct:hermes'] = 'direct-b'
  state.sessions['group:hermes'] = 'group-b'
  saveWorkspaceState(filename, state)
  const loaded = loadWorkspaceState(filename)
  assert.equal(loaded.status, 'ready')
  state = loaded.state
  switchNativeSessionProfile(state, 'hermes', '/profile-b', '')
  assert.deepEqual(state.sessions, { 'group:codex': 'codex-a', 'direct:hermes': 'direct-a', 'group:hermes': 'group-a' })
  assert.equal(resolveSessionState({ state, group: state.groups[0], kind: 'hermes', save() {} }).sessionRef, 'direct-a')
  switchNativeSessionProfile(state, 'hermes', '', '/profile-b')
  assert.deepEqual(state.sessions, { 'group:codex': 'codex-a', 'direct:hermes': 'direct-b', 'group:hermes': 'group-b' })
})

test('profile switching retains canonical and legacy task sessions with provenance', () => {
  const group = { id: 'group with spaces', agentKinds: ['hermes'] }
  const taskKey = sessionKey(group.id, 'hermes', 'task-one')
  const conversationKey = sessionKey(group.id, 'hermes')
  const state = { groups: [group], messages: [{ groupId: group.id, id: 'task-one', role: 'user' }],
    sessions: { [conversationKey]: 'conversation-a', [taskKey]: 'task-a' },
    sessionMeta: { [conversationKey]: { sessionScope: 'conversation', originTaskId: 'task-one', provenanceCompleteness: 'complete' } } }
  switchNativeSessionProfile(state, 'hermes', '', '/profile-b')
  assert.deepEqual(state.sessions, {})
  switchNativeSessionProfile(state, 'hermes', '/profile-b', '')
  assert.equal(state.sessions[conversationKey], 'conversation-a')
  assert.equal(state.sessions[taskKey], 'task-a')
  assert.equal(state.sessionMeta[conversationKey].originTaskId, 'task-one')
})

test('invalid archived session data does not silently become trusted workspace state', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-native-sessions-invalid-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'workspace.json')
  saveWorkspaceState(filename, { version: 3, groups: [], messages: [], sessions: {},
    nativeSessionProfiles: { hermes: { invalid: { sessions: {}, sessionMeta: {} } } } })
  assert.equal(loadWorkspaceState(filename).trusted, false)
})

test('clearing a group also clears its archived profile sessions without affecting another group', () => {
  const state = { groups: [{ id: 'one', agentKinds: ['hermes'] }, { id: 'two', agentKinds: ['hermes'] }],
    messages: [], sessions: { 'one:hermes': 'one-a', 'two:hermes': 'two-a' }, sessionMeta: {} }
  switchNativeSessionProfile(state, 'hermes', '', '/profile-b')
  clearSessionState(state, 'one')
  switchNativeSessionProfile(state, 'hermes', '/profile-b', '')
  assert.deepEqual(state.sessions, { 'two:hermes': 'two-a' })
})

test('group deletion rolls back archived sessions when saving fails', () => {
  const state = { groups: [{ id: 'one', agentKinds: ['hermes'] }], messages: [],
    sessions: { 'one:hermes': 'session-a' }, sessionMeta: {} }
  switchNativeSessionProfile(state, 'hermes', '', '/profile-b')
  const before = structuredClone(state.nativeSessionProfiles)
  const conversations = new LocalWorkspaceConversations({ state: () => state,
    clearSessionState: groupId => clearSessionState(state, groupId),
    isGroupBusy: () => false, save: () => { throw new Error('save failed') } })
  assert.throws(() => conversations.deleteGroup('one'), { message: 'save failed' })
  assert.deepEqual(state.nativeSessionProfiles, before)
})

test('direct and group chats resume the matching native profile after restart', async t => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const calls = []
  let nextSession = 0
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    calls.push(runOptions.sessionRef)
    return { text: 'Reply', outcome: 'completed', sessionRef: runOptions.sessionRef || `native-${++nextSession}` }
  }
  let workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const direct = workspace.createGroup({ conversationType: 'direct', directAgentKind: 'hermes', workdir: directory })
  const group = workspace.createGroup({ name: 'Group', agentKinds: ['hermes', 'codex'], workdir: directory })
  const sendBoth = async () => {
    await workspace.sendMessage({ groupId: direct.id, text: 'Hello' })
    await workspace.sendMessage({ groupId: group.id, text: 'Hello', mode: 'manual', targetKinds: ['hermes'] })
  }
  await sendBoth()
  switchNativeSessionProfile(workspace.state, 'hermes', '', '/profile-b')
  workspace.state.agentPreferences.hermes = { nativeConfigDirectory: '/profile-b' }
  workspace.save()
  await sendBoth()
  workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  switchNativeSessionProfile(workspace.state, 'hermes', '/profile-b', '')
  workspace.state.agentPreferences.hermes = { nativeConfigDirectory: '' }
  workspace.save()
  await sendBoth()
  assert.deepEqual(calls, ['', '', '', '', 'native-1', 'native-2'])
})

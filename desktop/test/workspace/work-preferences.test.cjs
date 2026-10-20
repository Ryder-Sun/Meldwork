const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { parseWorkPreferences, loadedWorkPreferences, workPreferencesPrompt } = require('../../src/workspace/work-preferences.cjs')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { registerDesktopIpc } = require('../../src/shell/main-ipc.cjs')
const { fixture } = require('../support/local-workspace-test-helpers.cjs')

const preference = { detail: 'concise', initiative: 'proactive', evidence: 'strict', preferredAgentKinds: ['codex'], instructions: 'Use a comparison table.' }

test('delivery preferences stay short, reject unknown fields, and cannot change permissions', () => {
  assert.equal(workPreferencesPrompt(undefined), '')
  assert.equal(workPreferencesPrompt(loadedWorkPreferences(null)), '')
  assert.throws(() => parseWorkPreferences({ ...preference, allowWrite: true }), /INVALID/)
  assert.throws(() => parseWorkPreferences({ ...preference, instructions: 'x'.repeat(801) }), /INVALID/)
  assert.throws(() => parseWorkPreferences({ ...preference, preferredAgentKinds: Array(9).fill('codex') }), /INVALID/)
  const text = workPreferencesPrompt({ ...preference, instructions: 'x'.repeat(800) })
  assert.ok(text.length < 1500)
  assert.match(text, /permission boundaries take precedence/)
  assert.match(text, /Distinguish facts, inferences and unknowns/)
})

test('preferences are transactionally saved, survive restart and reach each actual participant', async t => {
  const f = fixture()
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(f.options)
  const handles = new Map()
  registerDesktopIpc({ registerTrustedHandle: (name, handler) => handles.set(name, handler), getWorkspace: () => workspace })
  const save = handles.get('local-work-preferences:save')
  assert.throws(() => save({ ...preference, detail: 'unbounded' }), /INVALID/)
  workspace.activeRuns.set('busy', {})
  assert.throws(() => save(preference), /BUSY/)
  workspace.activeRuns.clear()
  save(preference)
  assert.deepEqual(handles.get('local-work-preferences:get')(), preference)
  const restarted = new LocalWorkspace(f.options)
  assert.deepEqual(restarted.state.workPreferences, preference)
  await restarted.refreshAgents()
  const group = restarted.createGroup({ name: 'Shared task', agentKinds: ['codex', 'hermes', 'workbuddy'], workdir: f.directory, allowWrite: false })
  await restarted.sendMessage({ groupId: group.id, text: 'Use the supplied evidence. Budget must not exceed 500.', targetKinds: group.agentKinds, mode: 'manual' })
  assert.equal(f.calls.length, 3)
  for (const call of f.calls) {
    assert.match(call.prompt, /Use a comparison table/)
    assert.match(call.prompt, /Budget must not exceed 500/)
    assert.equal(call.runOptions.sandbox, 'read-only')
  }
  const before = workspace.state.workPreferences
  workspace.save = () => { throw new Error('disk-full') }
  assert.throws(() => save({ ...preference, detail: 'thorough' }), /disk-full/)
  assert.deepEqual(workspace.state.workPreferences, before)
})

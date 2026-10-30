const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { fixture } = require('../support/local-workspace-test-helpers.cjs')

function emitActiveTools(runOptions) {
  runOptions.onEvent({ type: 'answer_delta', status: 'running', delta: 'OpenCode 已给出可见结论。' })
  for (let index = 0; index < 20; index += 1) {
    runOptions.onEvent({
      id: `research-${index}`, type: 'tool_start', title: 'search', status: 'running',
    })
    runOptions.onEvent({
      id: `research-${index}`, type: 'tool_result_summary', title: 'search', status: 'completed',
    })
    assert.equal(runOptions.signal.aborted, false)
  }
}

test('sequential discussion lets OpenCode complete more than twelve tools and preserves its answer', { timeout: 30000 }, async t => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const detectAgents = options.detectAgents
  options.detectAgents = async () => [
    ...await detectAgents(),
    { kind: 'opencode', name: 'OpenCode CLI', executable: '/tmp/opencode', version: '1' },
  ]
  options.naturalAgentResponses = true
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    if (prompt.includes('Work independently on the user task')) {
      return { text: `${agent.kind} initial analysis.`, outcome: 'completed' }
    }
    if (agent.kind !== 'opencode') {
      return { text: 'The available answer is complete.', outcome: 'completed' }
    }
    emitActiveTools(runOptions)
    return { text: 'OpenCode 已给出可见结论。', outcome: 'completed' }
  }
  const workspace = new LocalWorkspace(options)
  t.after(() => workspace.stopAll())
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Sequential OpenCode termination', agentKinds: ['opencode', 'codex'],
    workdir: directory, allowWrite: false,
  })
  await workspace.sendMessage({
    groupId: group.id, text: 'Discuss this task.', mode: 'auto', protocol: 'v4',
    targetKinds: group.agentKinds, discussionStyle: 'sequential', maxRounds: 2,
  })
  const controller = workspace.activeRuns.get(group.id)
  assert.ok(controller)
  await controller.promise
  const terminal = workspace.snapshot().messages.find(message => (
    message.threadRootId === controller.threadRootId
      && message.agentKind === 'opencode'
      && message.trace?.phase === 'discussion'
  ))
  assert.ok(terminal)
  assert.equal(workspace.snapshot().messages.some(message => (
    message.threadRootId === controller.threadRootId && message.system?.key === 'system.agentCallFailed'
  )), false)
  assert.match(terminal.content, /OpenCode 已给出可见结论。/)
  assert.equal(workspace.snapshot().runningGroupIds.includes(group.id), false)
})

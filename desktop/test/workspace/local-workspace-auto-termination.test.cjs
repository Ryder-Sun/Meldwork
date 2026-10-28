const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { fixture } = require('../support/local-workspace-test-helpers.cjs')

async function waitForStop(signal) {
  if (signal.aborted) throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
  await new Promise((resolve, reject) => signal.addEventListener('abort',
    () => reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED')), { once: true }))
}

function emitRunawayTools(runOptions) {
  runOptions.onEvent({ type: 'answer_delta', status: 'running', delta: 'OpenCode 已给出可见结论。' })
  for (let index = 0; index < 20; index += 1) {
    runOptions.onEvent({
      id: `research-${index}`, type: 'tool_start', title: 'search', status: 'running',
    })
  }
}

test('sequential discussion stops an OpenCode tool loop and preserves its answer', { timeout: 30000 }, async t => {
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
    emitRunawayTools(runOptions)
    await waitForStop(runOptions.signal)
  }
  const workspace = new LocalWorkspace(options)
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
      && message.system?.key === 'system.agentCallFailed'
  ))
  assert.equal(terminal?.system.params.reason, 'LOCAL_AGENT_TOOL_LIMIT', JSON.stringify(
    workspace.snapshot().messages.filter(message => message.threadRootId === controller.threadRootId)
      .map(message => ({ role: message.role, agentKind: message.agentKind, system: message.system, phase: message.trace?.phase })),
  ))
  assert.match(terminal.content, /OpenCode 已给出可见结论。/)
  assert.equal(workspace.snapshot().runningGroupIds.includes(group.id), false)
})

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { agentRuntimeError } = require('../../src/agents/agent-runtime-contract.cjs')
const { fixture } = require('../support/local-workspace-test-helpers.cjs')

function topicMessages(workspace, rootId) {
  return workspace.snapshot().messages.filter(message => message.threadRootId === rootId)
}

test('concurrent replies and failure notices keep slot order whatever order they finish in', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.retrySleep = async () => {}
  options.runAgent = async (agent, _prompt, _cwd, runOptions) => {
    // Codex finishes last, Hermes fails first, WorkBuddy finishes in between.
    if (agent.kind === 'codex') {
      await new Promise(resolve => setTimeout(resolve, 40))
      return { text: 'codex result', sessionRef: runOptions.sessionRef || 'codex-session' }
    }
    if (agent.kind === 'hermes') throw agentRuntimeError('LOCAL_AGENT_REFUSED', 'refused')
    await new Promise(resolve => setTimeout(resolve, 10))
    return { text: 'workbuddy result', sessionRef: runOptions.sessionRef || 'workbuddy-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Ordered batch', agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory, allowWrite: false,
  })

  await workspace.sendMessage({
    groupId: group.id, text: 'Answer independently.',
    protocol: 'v4', mode: 'manual', targetKinds: group.agentKinds,
  })

  const root = workspace.snapshot().messages.find(message => message.role === 'user')
  const topic = topicMessages(workspace, root.id)
  const byTurn = [...topic].sort((left, right) => left.turnSeq - right.turnSeq)
  assert.deepEqual(byTurn.map(message => [message.role, message.agentKind]), [
    ['agent', 'codex'],
    ['system', 'hermes'],
    ['agent', 'workbuddy'],
  ])
  assert.equal(topic.every(message => Number.isSafeInteger(message.turnSeq)), true)
  assert.equal(new Set(topic.map(message => message.turnSeq)).size, topic.length)
})

test('turn numbers continue after a restart and stay off direct chats', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, _prompt, _cwd, runOptions) => ({
    text: `${agent.kind} reply`, sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
  })
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Numbered topic', agentKinds: ['codex', 'hermes'], workdir: directory, allowWrite: false,
  })
  await workspace.sendMessage({
    groupId: group.id, text: 'First turn', protocol: 'v4', mode: 'manual',
    targetKinds: group.agentKinds,
  })
  const root = workspace.snapshot().messages.find(message => message.role === 'user')
  const before = Math.max(...topicMessages(workspace, root.id).map(message => message.turnSeq))

  const restarted = new LocalWorkspace(options)
  await restarted.refreshAgents()
  const notice = restarted.addMessage(group.id, 'system', 'Follow-up notice', '', root.id)
  assert.equal(notice.turnSeq, before + 1)

  const direct = restarted.createGroup({
    name: 'Codex', agentKinds: ['codex'], workdir: directory,
    conversationType: 'direct', directAgentKind: 'codex',
  })
  await restarted.sendMessage({ groupId: direct.id, text: 'Hello' })
  assert.equal(restarted.snapshot().messages
    .filter(message => message.groupId === direct.id)
    .some(message => message.turnSeq != null), false)
})

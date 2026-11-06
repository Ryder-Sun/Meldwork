const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { runAgent, shutdownAcpSessionRuntime } = require('../../src/agents/cli/cli-adapters.cjs')
const { executable } = require('../support/cli-adapters-test-helpers.cjs')
const { fixture } = require('../support/local-workspace-test-helpers.cjs')

test('DeepSeek participates in direct and group chats with separate reusable sessions', async (t) => {
  const { directory, options } = fixture()
  const cli = executable(directory, 'dsh.cjs', `
const readline = require('node:readline')
const { randomUUID } = require('node:crypto')
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  else if (message.method === 'session/new') send({ jsonrpc: '2.0', id: message.id, result: { sessionId: randomUUID() } })
  else if (message.method === 'session/resume') send({ jsonrpc: '2.0', id: message.id, result: {} })
  else if (message.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: message.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'DeepSeek reply' } } } })
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
  }
})
`)
  t.after(async () => {
    await shutdownAcpSessionRuntime()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  options.detectAgents = async () => [
    { kind: 'deepseek', name: 'DeepSeek Harness', executable: cli, version: '0.2.1-rc.2' },
    { kind: 'codex', name: 'Codex', executable: '/tmp/codex', version: '1' },
  ]
  const refs = []
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    if (agent.kind === 'codex') return { text: 'Codex reply', outcome: 'completed' }
    const result = await runAgent(agent, prompt, workdir, runOptions)
    refs.push({ incoming: runOptions.sessionRef, returned: result.sessionRef })
    return result
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const direct = workspace.createGroup({ conversationType: 'direct', directAgentKind: 'deepseek', workdir: directory })
  const group = workspace.createGroup({ name: 'Team', agentKinds: ['deepseek', 'codex'], workdir: directory })
  await workspace.sendMessage({ groupId: direct.id, text: 'Hello DeepSeek' })
  await workspace.sendMessage({ groupId: group.id, text: 'Review together', targetKinds: ['deepseek', 'codex'] })
  await workspace.sendMessage({ groupId: direct.id, text: 'Continue' })

  const messages = workspace.snapshot().messages.filter(message => message.role === 'agent')
  assert.deepEqual(messages.map(message => [message.groupId, message.agentKind, message.content]), [
    [direct.id, 'deepseek', 'DeepSeek reply'],
    [group.id, 'deepseek', 'DeepSeek reply'],
    [group.id, 'codex', 'Codex reply'],
    [direct.id, 'deepseek', 'DeepSeek reply'],
  ])
  assert.notEqual(refs[0].returned, refs[1].returned)
  assert.equal(refs[2].incoming, refs[0].returned)
  assert.equal(refs[2].returned, refs[0].returned)
  for (const discussionStyle of ['sequential', 'agent-led']) {
    const discussion = workspace.createGroup({
      name: discussionStyle, agentKinds: ['deepseek', 'codex'], workdir: directory,
    })
    await workspace.sendMessage({
      groupId: discussion.id, text: 'Review together', targetKinds: ['deepseek', 'codex'],
      mode: 'auto', protocol: 'v4', discussionStyle, maxRounds: 1,
    })
    await workspace.activeRuns.get(discussion.id)?.promise
    const replies = workspace.snapshot().messages.filter(message => (
      message.groupId === discussion.id && message.role === 'agent'
    ))
    assert.ok(replies.some(message => message.agentKind === 'deepseek' && message.content.includes('DeepSeek reply')), discussionStyle)
    assert.ok(replies.some(message => message.agentKind === 'codex'), discussionStyle)
  }
})

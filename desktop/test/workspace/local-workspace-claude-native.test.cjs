const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { resolveNativeCredentialState } = require('../../src/agents/local-agent-readiness.cjs')
const { fixture } = require('../support/local-workspace-test-helpers.cjs')

test('Claude project credentials remain usable in direct and group chats when global auth is logged out', async t => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const project = path.join(directory, 'project')
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({
    env: { ANTHROPIC_API_KEY: 'synthetic-project-key' },
  }))
  options.detectAgents = async () => [
    { kind: 'claude', name: 'Claude', executable: '/tmp/claude', version: '1' },
    { kind: 'codex', name: 'Codex', executable: '/tmp/codex', version: '1' },
  ]
  options.credentialState = async kind => kind === 'claude'
    ? resolveNativeCredentialState(kind, { home: directory, env: {}, executable: '/tmp/claude',
      execFileFn: async () => ({ stdout: JSON.stringify({ loggedIn: false }) }) })
    : { state: 'ready', source: 'native-credential' }
  options.runAgent = async (agent, _prompt, workdir) => {
    if (agent.kind === 'claude') {
      const settings = JSON.parse(fs.readFileSync(path.join(workdir, '.claude', 'settings.json'), 'utf8'))
      assert.equal(settings.env.ANTHROPIC_API_KEY, 'synthetic-project-key')
    }
    return { text: `${agent.kind} reply`, outcome: 'completed' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const claude = workspace.detectedAgents.find(agent => agent.kind === 'claude')
  assert.equal(claude.credentialState, 'unknown')
  assert.equal(claude.recentlyVerified, false)
  const group = workspace.createGroup({ name: 'Group', agentKinds: ['claude', 'codex'], workdir: project })
  await assert.rejects(workspace.sendMessage({ groupId: group.id, text: 'Reply', routingMode: 'automatic' }),
    { code: 'LOCAL_AGENT_ROUTING_UNVERIFIED' })
  const direct = workspace.createGroup({ conversationType: 'direct', directAgentKind: 'claude', workdir: project })
  await workspace.sendMessage({ groupId: direct.id, text: 'Reply' })
  await workspace.sendMessage({ groupId: group.id, text: 'Reply', targetKinds: ['claude', 'codex'] })
  for (const chat of [direct, group]) {
    assert.ok(workspace.snapshot().messages.some(message => message.groupId === chat.id
      && message.agentKind === 'claude' && message.content === 'claude reply'))
  }
  await workspace.stopAll()
})

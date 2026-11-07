const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { resolveNativeCredentialState } = require('../../src/agents/local-agent-readiness.cjs')
const { mimoConfiguredProvider } = require('../../src/agents/cli/mimo-native-config.cjs')
const { fixture } = require('../support/local-workspace-test-helpers.cjs')

test('MiMo project provider remains usable for direct and group chat while official login is absent', async t => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const project = path.join(directory, 'project')
  fs.mkdirSync(project)
  fs.writeFileSync(path.join(project, 'mimocode.json'), JSON.stringify({
    model: 'custom/model', provider: { custom: { options: { apiKey: 'synthetic-key' } } },
  }))
  const env = { HOME: directory, XDG_CONFIG_HOME: path.join(directory, 'config') }
  options.detectAgents = async () => [
    { kind: 'mimo', name: 'MiMo', executable: '/tmp/mimo', version: '1' },
    { kind: 'codex', name: 'Codex', executable: '/tmp/codex', version: '1' },
  ]
  options.credentialState = async kind => kind === 'mimo'
    ? resolveNativeCredentialState(kind, { home: directory, env, executable: '/tmp/mimo',
      execFileFn: async () => ({ stdout: 'Not logged in. Run `mimo auth login` to log in.' }) })
    : { state: 'ready', source: 'native-credential' }
  options.runAgent = async (agent, _prompt, workdir) => {
    if (agent.kind === 'mimo') assert.equal(mimoConfiguredProvider({ home: directory, env, workdir }), true)
    return { text: `${agent.kind} reply`, outcome: 'completed' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const mimo = workspace.detectedAgents.find(agent => agent.kind === 'mimo')
  assert.equal(mimo.credentialState, 'unknown')
  assert.equal(mimo.recentlyVerified, false)
  const group = workspace.createGroup({ name: 'Group', agentKinds: ['mimo', 'codex'], workdir: project })
  await assert.rejects(workspace.sendMessage({ groupId: group.id, text: 'Reply', routingMode: 'automatic' }),
    { code: 'LOCAL_AGENT_ROUTING_UNVERIFIED' })
  const direct = workspace.createGroup({ conversationType: 'direct', directAgentKind: 'mimo', workdir: project })
  await workspace.sendMessage({ groupId: direct.id, text: 'Reply' })
  await workspace.sendMessage({ groupId: group.id, text: 'Reply', targetKinds: ['mimo', 'codex'] })
  for (const chat of [direct, group]) {
    assert.ok(workspace.snapshot().messages.some(message => message.groupId === chat.id
      && message.agentKind === 'mimo' && message.content === 'mimo reply'))
  }
  await workspace.stopAll()
})

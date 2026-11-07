const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { runAgent } = require('../../src/agents/cli/cli-adapters.cjs')
const { nativeCredentialEnvironment } = require('../../src/agents/agent-native-environment.cjs')
const { zcodeDeclaredCredentialKeys } = require('../../src/agents/local-agent-readiness.cjs')
const { fixture } = require('../support/local-workspace-test-helpers.cjs')
const { executable } = require('../support/cli-adapters-test-helpers.cjs')

test('Zcode model override retains its native credential in direct and group chats', async t => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const cli = executable(directory, 'zcode', `
if (process.env.ZCODE_MODEL !== 'custom/model' || process.env.ANTHROPIC_API_KEY !== 'synthetic-key') process.exit(1)
process.stdout.write(JSON.stringify({ response: 'zcode reply', sessionId: 'session-1', projection: { status: 'completed' } }))
`)
  options.detectAgents = async () => [
    { kind: 'zcode', name: 'Zcode', executable: cli, version: '0.16.1' },
    { kind: 'codex', name: 'Codex', executable: '/tmp/codex', version: '1' },
  ]
  const shell = { ZCODE_MODEL: 'custom/model', ANTHROPIC_API_KEY: 'synthetic-key' }
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    if (agent.kind !== 'zcode') return { text: 'peer reply', outcome: 'completed', sessionRef: 'peer-session' }
    const keys = zcodeDeclaredCredentialKeys({ home: directory, workdir, env: shell })
    assert.ok(keys.includes('ANTHROPIC_API_KEY'))
    return runAgent(agent, prompt, workdir, {
      ...runOptions, env: nativeCredentialEnvironment('zcode', shell, keys), nativeCredentialKeys: keys,
    })
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const direct = workspace.createGroup({ conversationType: 'direct', directAgentKind: 'zcode', workdir: directory })
  await workspace.sendMessage({ groupId: direct.id, text: 'Reply' })
  const group = workspace.createGroup({ name: 'Group', agentKinds: ['zcode', 'codex'], workdir: directory })
  await workspace.sendMessage({ groupId: group.id, text: 'Reply', targetKinds: ['zcode', 'codex'] })
  const messages = workspace.snapshot().messages
  assert.ok(messages.some(message => message.groupId === direct.id && message.agentKind === 'zcode' && message.content === 'zcode reply'))
  assert.ok(messages.some(message => message.groupId === group.id && message.agentKind === 'zcode' && message.content === 'zcode reply'))
  assert.ok(messages.some(message => message.groupId === group.id && message.agentKind === 'codex' && message.content === 'peer reply'))
  await workspace.stopAll()
})

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { runAgent } = require('../../src/agents/cli/cli-adapters.cjs')
const { nativeCredentialEnvironment } = require('../../src/agents/agent-native-environment.cjs')
const { zcodeDeclaredCredentialKeys } = require('../../src/agents/local-agent-readiness.cjs')
const { nativeConfigEnvironment, validateNativeConfigDirectory } = require('../../src/agents/native-config-directory.cjs')
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

test('selected Zcode native home reaches direct and group chat subprocesses', async t => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const home = path.join(directory, 'selected-home')
  const config = path.join(home, '.zcode', 'cli')
  fs.mkdirSync(config, { recursive: true })
  fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({ model: { main: 'selected/model' },
    provider: { selected: { kind: 'openai', name: 'Selected' } } }))
  const selected = validateNativeConfigDirectory('zcode', config)
  const expectedHome = path.dirname(path.dirname(selected))
  const cli = executable(directory, 'zcode', `
if (process.env.HOME !== ${JSON.stringify(expectedHome)} || process.env.SELECTED_API_KEY !== 'synthetic-key') process.exit(1)
process.stdout.write(JSON.stringify({ response: 'selected reply', sessionId: 'selected-session', projection: { status: 'completed' } }))
`)
  options.detectAgents = async () => [
    { kind: 'zcode', name: 'Zcode', executable: cli, version: '0.16.1' },
    { kind: 'codex', name: 'Codex', executable: '/tmp/codex', version: '1' },
  ]
  let workspace
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    if (agent.kind !== 'zcode') return { text: 'peer reply', outcome: 'completed', sessionRef: 'peer-session' }
    const shell = nativeConfigEnvironment('zcode', workspace.state.agentPreferences, { SELECTED_API_KEY: 'synthetic-key' })
    const keys = zcodeDeclaredCredentialKeys({ home: directory, workdir, env: shell })
    assert.ok(keys.includes('SELECTED_API_KEY'))
    return runAgent(agent, prompt, workdir, { ...runOptions,
      env: nativeCredentialEnvironment('zcode', shell, keys), nativeCredentialKeys: keys })
  }
  workspace = new LocalWorkspace(options)
  workspace.state.agentPreferences.zcode = { nativeConfigDirectory: selected }
  await workspace.refreshAgents()
  const direct = workspace.createGroup({ conversationType: 'direct', directAgentKind: 'zcode', workdir: directory })
  await workspace.sendMessage({ groupId: direct.id, text: 'Reply' })
  const group = workspace.createGroup({ name: 'Group', agentKinds: ['zcode', 'codex'], workdir: directory })
  await workspace.sendMessage({ groupId: group.id, text: 'Reply', targetKinds: ['zcode', 'codex'] })
  const messages = workspace.snapshot().messages
  for (const id of [direct.id, group.id]) assert.ok(messages.some(message => (
    message.groupId === id && message.agentKind === 'zcode' && message.content === 'selected reply'
  )))
  await workspace.stopAll()
})

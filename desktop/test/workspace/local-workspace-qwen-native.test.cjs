const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { runAgent } = require('../../src/agents/cli/cli-adapters.cjs')
const { nativeCredentialEnvironment } = require('../../src/agents/agent-native-environment.cjs')
const { nativeConfigEnvironment, validateNativeConfigDirectory } = require('../../src/agents/native-config-directory.cjs')
const { qwenDeclaredCredentialKeys } = require('../../src/agents/cli/qwen-native-config.cjs')
const { fixture } = require('../support/local-workspace-test-helpers.cjs')
const { executable } = require('../support/cli-adapters-test-helpers.cjs')

test('selected Qwen native home reaches direct and group chat subprocesses', async t => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const home = path.join(directory, 'selected-home')
  const config = path.join(home, '.qwen')
  fs.mkdirSync(config, { recursive: true })
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ model: { name: 'chosen' },
    security: { auth: { selectedType: 'openai' } },
    modelProviders: { openai: [{ id: 'chosen', envKey: 'CHOSEN_TOKEN' }] } }))
  const selected = validateNativeConfigDirectory('qwen', config)
  const expectedHome = path.dirname(selected)
  const cli = executable(directory, 'qwen', `
if (process.env.HOME !== ${JSON.stringify(expectedHome)} || process.env.CHOSEN_TOKEN !== 'synthetic-key') process.exit(1)
process.stdout.write(JSON.stringify({ type: 'result', result: 'selected reply', session_id: 'selected-session' }) + '\\n')
`)
  options.detectAgents = async () => [
    { kind: 'qwen', name: 'Qwen', executable: cli, version: '0.10.0' },
    { kind: 'codex', name: 'Codex', executable: '/tmp/codex', version: '1' },
  ]
  let workspace
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    if (agent.kind !== 'qwen') return { text: 'peer reply', outcome: 'completed', sessionRef: 'peer-session' }
    const shell = nativeConfigEnvironment('qwen', workspace.state.agentPreferences, { CHOSEN_TOKEN: 'synthetic-key' })
    const keys = qwenDeclaredCredentialKeys({ home: directory, workdir, env: shell })
    assert.deepEqual(keys, ['CHOSEN_TOKEN'])
    return runAgent(agent, prompt, workdir, { ...runOptions,
      env: nativeCredentialEnvironment('qwen', shell, keys), nativeCredentialKeys: keys })
  }
  workspace = new LocalWorkspace(options)
  workspace.state.agentPreferences.qwen = { nativeConfigDirectory: selected }
  await workspace.refreshAgents()
  const direct = workspace.createGroup({ conversationType: 'direct', directAgentKind: 'qwen', workdir: directory })
  await workspace.sendMessage({ groupId: direct.id, text: 'Reply' })
  const group = workspace.createGroup({ name: 'Group', agentKinds: ['qwen', 'codex'], workdir: directory })
  await workspace.sendMessage({ groupId: group.id, text: 'Reply', targetKinds: ['qwen', 'codex'] })
  const messages = workspace.snapshot().messages
  for (const id of [direct.id, group.id]) assert.ok(messages.some(message => (
    message.groupId === id && message.agentKind === 'qwen' && message.content === 'selected reply'
  )))
  await workspace.stopAll()
})

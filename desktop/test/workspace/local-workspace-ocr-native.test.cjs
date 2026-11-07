const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { runAgent } = require('../../src/agents/cli/cli-adapters.cjs')
const { nativeCredentialEnvironment } = require('../../src/agents/agent-native-environment.cjs')
const { nativeConfigEnvironment, validateNativeConfigDirectory } = require('../../src/agents/native-config-directory.cjs')
const { fixture } = require('../support/local-workspace-test-helpers.cjs')
const { executable } = require('../support/cli-adapters-test-helpers.cjs')

test('selected OpenCodeReview native home persists and reaches direct and group subprocesses', async t => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const home = path.join(directory, 'selected-home')
  const config = path.join(home, '.opencodereview')
  fs.mkdirSync(config, { recursive: true })
  fs.writeFileSync(path.join(config, 'config.json'), '{}')
  const selected = validateNativeConfigDirectory('opencodereview', config)
  const cli = executable(directory, 'ocr', `
if (process.env.HOME !== ${JSON.stringify(home)}) process.exit(1)
process.stdout.write(JSON.stringify({ status: 'complete', message: 'Selected review.', comments: [],
  manifest: { schema_version: 'ocr.run-manifest/v1', operation: 'review', terminal_state: 'complete' } }))
`)
  options.detectAgents = async () => [
    { kind: 'opencodereview', name: 'OpenCodeReview', executable: cli, version: '1.13.6' },
    { kind: 'codex', name: 'Codex', executable: '/tmp/codex', version: '1' },
  ]
  let workspace
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    if (agent.kind !== 'opencodereview') return { text: 'Peer reply', outcome: 'completed', sessionRef: 'peer-session' }
    const env = nativeConfigEnvironment('opencodereview', workspace.state.agentPreferences, {})
    return runAgent(agent, prompt, workdir, { ...runOptions, env: nativeCredentialEnvironment('opencodereview', env) })
  }
  workspace = new LocalWorkspace(options)
  workspace.state.agentPreferences.opencodereview = { nativeConfigDirectory: selected }
  workspace.save()
  workspace = new LocalWorkspace(options)
  assert.equal(workspace.state.agentPreferences.opencodereview.nativeConfigDirectory, selected)
  await workspace.refreshAgents()
  const direct = workspace.createGroup({ conversationType: 'direct', directAgentKind: 'opencodereview', workdir: directory })
  await workspace.sendMessage({ groupId: direct.id, text: 'Review' })
  const group = workspace.createGroup({ name: 'Group', agentKinds: ['opencodereview', 'codex'], workdir: directory })
  await workspace.sendMessage({ groupId: group.id, text: 'Review', targetKinds: ['opencodereview', 'codex'] })
  const messages = workspace.snapshot().messages
  for (const id of [direct.id, group.id]) assert.ok(messages.some(message => (
    message.groupId === id && message.agentKind === 'opencodereview' && message.content.includes('Selected review.')
  )))
  await workspace.stopAll()
})

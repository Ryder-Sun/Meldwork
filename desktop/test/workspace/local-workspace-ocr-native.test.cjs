const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { execFileSync } = require('node:child_process')
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

test('real OpenCodeReview uses the selected home in direct and group chats',
  { skip: process.env.MELDWORK_TEST_REAL_OCR !== '1', timeout: 30000 }, async t => {
    const { directory, options } = fixture()
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const repo = path.join(directory, 'repo')
    const home = path.join(directory, 'selected-home')
    const config = path.join(home, '.opencodereview')
    fs.mkdirSync(repo)
    fs.mkdirSync(config, { recursive: true })
    for (const args of [['init', '-q'], ['config', 'user.name', 'Meldwork Test'],
      ['config', 'user.email', 'test@example.invalid']]) execFileSync('git', args, { cwd: repo })
    fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 1;\n')
    execFileSync('git', ['add', 'app.js'], { cwd: repo })
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repo })
    fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 2;\n')
    let requests = 0
    const server = http.createServer((request, response) => {
      requests += 1
      request.resume()
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id: 'mock', object: 'chat.completion', choices: [{ index: 0,
          message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function',
            function: { name: 'task_done', arguments: '{"state":"DONE"}' } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
      })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => server.close())
    fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({ llm: {
      url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
      auth_token: 'synthetic-key', model: 'mock', protocol: 'openai',
    } }))
    const selected = validateNativeConfigDirectory('opencodereview', config)
    const cli = execFileSync('which', ['ocr'], { encoding: 'utf8' }).trim()
    options.detectAgents = async () => [
      { kind: 'opencodereview', name: 'OpenCodeReview', executable: cli, version: '1.13.6' },
      { kind: 'codex', name: 'Codex', executable: '/tmp/codex', version: '1' },
    ]
    let workspace
    options.runAgent = async (agent, prompt, workdir, runOptions) => {
      if (agent.kind !== 'opencodereview') return { text: 'Peer reply', outcome: 'completed', sessionRef: 'peer-session' }
      const env = nativeConfigEnvironment('opencodereview', workspace.state.agentPreferences, { PATH: process.env.PATH })
      return runAgent(agent, prompt, workdir, { ...runOptions, env })
    }
    workspace = new LocalWorkspace(options)
    workspace.state.agentPreferences.opencodereview = { nativeConfigDirectory: selected }
    await workspace.refreshAgents()
    const direct = workspace.createGroup({ conversationType: 'direct', directAgentKind: 'opencodereview', workdir: repo })
    await workspace.sendMessage({ groupId: direct.id, text: 'Review the change' })
    const group = workspace.createGroup({ name: 'Group', agentKinds: ['opencodereview', 'codex'], workdir: repo })
    await workspace.sendMessage({ groupId: group.id, text: 'Review the change', targetKinds: ['opencodereview', 'codex'] })
    const messages = workspace.snapshot().messages
    for (const id of [direct.id, group.id]) assert.ok(messages.some(message => (
      message.groupId === id && message.agentKind === 'opencodereview' && message.trace?.status === 'completed'
    )))
    assert.equal(requests, 2)
    await workspace.stopAll()
  })

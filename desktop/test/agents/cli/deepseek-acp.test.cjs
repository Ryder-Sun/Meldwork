const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { runAgent, invocation, shutdownAcpSessionRuntime } = require('../../../src/agents/cli/cli-adapters.cjs')
const { childEnvironment } = require('../../../src/agents/cli/cli-process-support.cjs')
const { executable } = require('../../support/cli-adapters-test-helpers.cjs')

test('DeepSeek ACP keeps mode-bound sessions, resumes, and rejects escalations', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-dsh-'))
  const cli = executable(directory, 'dsh.cjs', `
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
let prompt
input.on('line', line => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  else if (message.method === 'session/new') send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'abc-123' } })
  else if (message.method === 'session/resume') {
    if (message.params.sessionId !== 'abc-123') process.exit(2)
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    if (message.params.prompt[0].text === 'missing key') {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32603,
        message: 'Internal error: turn failed: llm-pi-ai: no credential for provider route "zgci"' } })
      return
    }
    prompt = message
    send({ jsonrpc: '2.0', id: 42, method: 'session/request_permission', params: {
      sessionId: 'abc-123', toolCall: { toolCallId: 'tool-1', title: 'escalate', status: 'pending' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }],
    } })
  } else if (message.id === 42) {
    if (message.result?.outcome?.optionId !== 'reject') process.exit(3)
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'abc-123', update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'DeepSeek answer' },
    } } })
    send({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } })
  }
})
`)
  t.after(async () => {
    await shutdownAcpSessionRuntime()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const agent = { kind: 'deepseek', executable: cli, name: 'DeepSeek' }
  const options = { sandbox: 'read-only', onPermissionRequest: () => ({ status: 'approved', optionId: 'allow' }) }
  const first = await runAgent(agent, 'first', directory, options)
  assert.equal(first.text, 'DeepSeek answer')
  assert.equal(first.sessionRef, 'dsh-read:abc-123')
  const resumed = await runAgent(agent, 'second', directory, { ...options, sessionRef: first.sessionRef })
  assert.equal(resumed.text, 'DeepSeek answer')
  assert.equal(resumed.sessionRef, first.sessionRef)
  await assert.rejects(runAgent(agent, 'write', directory, {
    ...options, sandbox: 'workspace-write', sessionRef: first.sessionRef,
  }), { code: 'LOCAL_AGENT_SESSION_INVALID' })
  const write = await runAgent(agent, 'write', directory, { ...options, sandbox: 'workspace-write' })
  assert.equal(write.sessionRef, 'dsh-write:abc-123')
  await assert.rejects(runAgent(agent, 'missing key', directory, options), { code: 'LOCAL_AGENT_AUTH_REQUIRED' })
})

test('DeepSeek invocation pins policy and preserves only its allowed native environment', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-dsh-invocation-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const env = { DSH_HOME: home }
  const read = invocation('deepseek', '/bin/dsh', '/tmp', '', { sandbox: 'read-only', env })
  const write = invocation('deepseek', '/bin/dsh', '/tmp', '', { sandbox: 'workspace-write', env })
  assert.match(read.args.at(-1), /deepseek-read\.yml$/)
  assert.match(write.args.at(-1), /deepseek-write\.yml$/)
  assert.match(fs.readFileSync(read.args[3], 'utf8'), /model: smart-router-v2/)
  for (const [spec, mode] of [[read, 'read-only'], [write, 'workspace-write']]) {
    const policy = fs.readFileSync(spec.args.at(-1), 'utf8')
    assert.match(policy, new RegExp(`mode: ${mode}`))
    assert.match(policy, /policy: never/)
    assert.match(policy, /id: permission\s+disabled: true/)
  }
  const childEnv = childEnvironment({ kind: 'deepseek', executable: '/bin/dsh' }, '/tmp', {
    env: { ZGCI_API_KEY: 'test-key', DSH_HOME: '/tmp/dsh', DSH_PERMISSION_MODE: 'danger-full-access' },
  }, process.platform)
  assert.equal(childEnv.ZGCI_API_KEY, 'test-key')
  assert.equal(childEnv.DSH_HOME, '/tmp/dsh')
  assert.equal(childEnv.DSH_PERMISSION_MODE, undefined)
})

test('DeepSeek honors an explicitly configured ACP provider and its declared credential', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-dsh-native-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  fs.mkdirSync(path.join(home, 'profiles', 'acp'), { recursive: true })
  fs.writeFileSync(path.join(home, 'profiles', 'acp', 'cordis.patch.yml'), [
    '- id: llm-pi-ai', '  config:', '    providers:', '      custom:', '        apiKeyEnv: CUSTOM_DSH_KEY',
    '    localValue: !!js process.cwd()',
    '- id: acp', '  config:', '    provider: custom', '    model: chosen-model',
  ].join('\n'))
  const { deepseekNativeConfig } = require('../../../src/agents/cli/deepseek-native-config.cjs')
  const { nativeCredentialEnvironment } = require('../../../src/agents/agent-native-environment.cjs')
  const { redactChildSecrets } = require('../../../src/agents/cli/cli-runtime-event-sanitizer.cjs')
  const native = deepseekNativeConfig({ env: { DSH_HOME: home } })
  assert.deepEqual(native, { explicitModel: true, credentialKeys: ['CUSTOM_DSH_KEY'] })
  assert.deepEqual(nativeCredentialEnvironment('deepseek', { DSH_HOME: home, CUSTOM_DSH_KEY: 'selected-secret',
    ZGCI_API_KEY: 'other-account', UNRELATED_SECRET: 'private' }, native.credentialKeys),
  { DSH_HOME: home, CUSTOM_DSH_KEY: 'selected-secret' })
  for (const sandbox of ['read-only', 'workspace-write']) {
    const options = { sandbox, env: { DSH_HOME: home, CUSTOM_DSH_KEY: 'selected-secret' },
      nativeCredentialKeys: native.credentialKeys }
    const spec = invocation('deepseek', '/bin/dsh', '/tmp', '', options)
    assert.equal(spec.args.some(arg => /deepseek-zgci\.yml$/.test(arg)), false)
    assert.match(spec.args.at(-1), /deepseek-(?:read|write)\.yml$/)
    const child = childEnvironment({ kind: 'deepseek' }, '/tmp', options, process.platform)
    assert.equal(child.CUSTOM_DSH_KEY, 'selected-secret')
    assert.doesNotMatch(redactChildSecrets('failed with selected-secret', child), /selected-secret/)
  }
})

test('DeepSeek uses the default model only without an explicit native selection', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-dsh-default-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const env = { DSH_HOME: root }
  const options = { sandbox: 'read-only', env }
  assert.equal(invocation('deepseek', '/bin/dsh', '/tmp', '', options).args.some(arg => /deepseek-zgci\.yml$/.test(arg)), true)
  fs.writeFileSync(path.join(root, 'cordis.patch.yml'), '- id: acp\n  config:\n    model: user-model\n')
  assert.equal(invocation('deepseek', '/bin/dsh', '/tmp', '', options).args.some(arg => /deepseek-zgci\.yml$/.test(arg)), false)
  fs.writeFileSync(path.join(root, 'cordis.patch.yml'), 'invalid: [')
  assert.equal(invocation('deepseek', '/bin/dsh', '/tmp', '', options).args.some(arg => /deepseek-zgci\.yml$/.test(arg)), false)
})

test('DeepSeek native official provider retains its bundled API key declaration', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-dsh-official-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { deepseekNativeConfig } = require('../../../src/agents/cli/deepseek-native-config.cjs')
  const { nativeCredentialEnvironment } = require('../../../src/agents/agent-native-environment.cjs')
  const env = { DSH_HOME: root, DEEPSEEK_API_KEY: 'official-secret', ZGCI_API_KEY: 'other-secret' }
  for (const patch of ['- id: acp\n  config:\n    provider: deepseek-official\n',
    '- id: acp\n  config:\n    model: deepseek-v4-flash\n']) {
    fs.writeFileSync(path.join(root, 'cordis.patch.yml'), patch)
    const native = deepseekNativeConfig({ env })
    assert.deepEqual(native.credentialKeys, ['DEEPSEEK_API_KEY'])
    assert.deepEqual(nativeCredentialEnvironment('deepseek', env, native.credentialKeys),
      { DSH_HOME: root, DEEPSEEK_API_KEY: 'official-secret' })
  }
  fs.mkdirSync(path.join(root, 'profiles', 'acp'), { recursive: true })
  fs.writeFileSync(path.join(root, 'profiles', 'acp', 'cordis.patch.yml'), '- id: acp\n  config:\n    provider: custom\n')
  fs.writeFileSync(path.join(root, 'cordis.patch.yml'), '- id: acp\n  config:\n    model: custom-model\n')
  assert.deepEqual(deepseekNativeConfig({ env }).credentialKeys, [])
})

test('DeepSeek ACP uses the native selected provider in both permission modes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-dsh-native-acp-'))
  fs.mkdirSync(path.join(directory, 'profiles', 'acp'), { recursive: true })
  fs.writeFileSync(path.join(directory, 'profiles', 'acp', 'cordis.patch.yml'), [
    '- id: llm-pi-ai', '  config:', '    providers:', '      custom:', '        apiKeyEnv: CUSTOM_DSH_KEY',
    '- id: acp', '  config:', '    provider: custom', '    model: chosen-model',
  ].join('\n'))
  const cli = executable(directory, 'native-dsh.cjs', `
const readline = require('node:readline')
if (process.argv.some(arg => arg.endsWith('deepseek-zgci.yml')) || process.env.CUSTOM_DSH_KEY !== 'native-test-secret') process.exit(2)
const input = readline.createInterface({ input: process.stdin })
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
input.on('line', line => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  else if (message.method === 'session/new') send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'native-session' } })
  else if (message.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Native provider reply' } } } })
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
  }
})
`)
  t.after(async () => { await shutdownAcpSessionRuntime(); fs.rmSync(directory, { recursive: true, force: true }) })
  for (const sandbox of ['read-only', 'workspace-write']) {
    const result = await runAgent({ kind: 'deepseek', executable: cli }, 'hello', directory, {
      sandbox, env: { DSH_HOME: directory, CUSTOM_DSH_KEY: 'native-test-secret' },
      nativeCredentialKeys: ['CUSTOM_DSH_KEY'],
    })
    assert.equal(result.text, 'Native provider reply')
  }
})

test('DeepSeek restarts its persistent ACP process after native model configuration changes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-dsh-native-reload-'))
  fs.mkdirSync(path.join(directory, 'profiles', 'acp'), { recursive: true })
  const config = path.join(directory, 'profiles', 'acp', 'cordis.patch.yml')
  const writeConfig = model => fs.writeFileSync(config, `- id: acp\n  config:\n    provider: custom\n    model: ${model}\n`)
  writeConfig('first-model')
  const cli = executable(directory, 'reload-dsh.cjs', `
const fs = require('node:fs')
fs.appendFileSync(process.env.MELDWORK_TEST_START_FILE, 'start\\n')
const readline = require('node:readline')
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  else if (message.method === 'session/new') send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'reload-session' } })
  else if (message.method === 'session/resume') send({ jsonrpc: '2.0', id: message.id, result: {} })
  else if (message.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'reload-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Reply' } } } })
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
  }
})
`)
  t.after(async () => { await shutdownAcpSessionRuntime(); fs.rmSync(directory, { recursive: true, force: true }) })
  const starts = path.join(directory, 'starts')
  const agent = { kind: 'deepseek', executable: cli }
  const options = { sandbox: 'read-only', acpPersistenceKey: 'reload-test',
    env: { DSH_HOME: directory, MELDWORK_TEST_START_FILE: starts } }
  const first = await runAgent(agent, 'first', directory, options)
  writeConfig('second-model')
  await assert.rejects(runAgent(agent, 'second', directory, { ...options, sessionRef: first.sessionRef }),
    { code: 'LOCAL_AGENT_SESSION_INVALID' })
  const second = await runAgent(agent, 'second', directory, options)
  assert.equal(second.text, 'Reply')
  assert.equal(fs.readFileSync(starts, 'utf8'), 'start\nstart\n')
})

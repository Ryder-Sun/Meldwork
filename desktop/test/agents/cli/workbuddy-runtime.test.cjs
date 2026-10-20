const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { workBuddyCredentialState, workBuddyEnvironment, workBuddySettings } = require('../../../src/agents/cli/workbuddy-runtime.cjs')
const { nativeCredentialEnvironment, resolveNativeCredentialState } = require('../../../src/agents/local-agent-readiness.cjs')
const { childEnvironment, failedAgentProcessError } = require('../../../src/agents/cli/cli-process-support.cjs')
const { invocation } = require('../../../src/agents/cli/cli-invocations.cjs')
const { registerDesktopIpc } = require('../../../src/shell/main-ipc.cjs')

function fixture(t, objectFormat = false) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-workbuddy-runtime-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const models = [
    { id: 'text', name: 'Text model', apiKey: 'synthetic-native-key', url: 'https://model.example/v1', supportsToolCall: true },
    { id: 'image', apiKey: 'image-key', url: 'https://model.example/v1', supportsToolCall: false },
    { id: 'encrypted', apiKey: { ciphertext: 'encrypted-key' }, url: 'https://model.example/v1', supportsToolCall: true },
    { id: 'bad-url', apiKey: 'bad-url-key', url: 'file:///private', supportsToolCall: true },
    { apiKey: 'missing-id-key', url: 'https://model.example/v1', supportsToolCall: true },
  ]
  fs.mkdirSync(path.join(home, '.workbuddy'))
  fs.writeFileSync(path.join(home, '.workbuddy', 'models.json'), JSON.stringify(objectFormat ? { models } : models))
  return { home, env: {}, platform: 'darwin' }
}

test('WorkBuddy settings expose model names and IDs only, for both native file shapes', t => {
  for (const format of [false, true]) {
    const options = fixture(t, format)
    assert.deepEqual(workBuddySettings(options), { modelId: '', models: [{ id: 'text', name: 'Text model' }] })
    const output = JSON.stringify(workBuddySettings(options))
    assert.equal(output.includes('key'), false)
    assert.equal(output.includes('https:'), false)
  }
})

test('WorkBuddy never chooses the first configured model or accepts unrelated provider credentials', t => {
  const options = fixture(t)
  assert.deepEqual(workBuddyEnvironment(options), {})
  assert.deepEqual(workBuddyCredentialState({ ...options, env: { OPENAI_API_KEY: 'unrelated' } }), { state: 'unknown', source: 'unverified' })
  assert.deepEqual(nativeCredentialEnvironment('workbuddy', { CODEBUDDY_AUTH_TOKEN: 'native-token', CODEBUDDY_CONFIG_DIR: '/native', OPENAI_API_KEY: 'unrelated' }), { CODEBUDDY_AUTH_TOKEN: 'native-token', CODEBUDDY_CONFIG_DIR: '/native' })
})

test('selected WorkBuddy provider is read from native storage at invocation time and propagated safely', t => {
  const options = { ...fixture(t), modelId: 'text' }
  const env = workBuddyEnvironment(options)
  assert.equal(env.CODEBUDDY_MODEL, 'custom-local:text')
  assert.equal(env.CODEBUDDY_API_KEY, 'synthetic-native-key')
  assert.equal(childEnvironment({ kind: 'workbuddy' }, '/tmp', { env }, 'darwin').CODEBUDDY_API_KEY, env.CODEBUDDY_API_KEY)
  const spec = invocation('workbuddy', '/cli', '/tmp', 'saved-session', { model: env.CODEBUDDY_MODEL })
  assert.deepEqual(spec.args.slice(-4), ['--model', 'custom-local:text', '--resume', 'saved-session'])
  assert.ok(spec.args.includes('plan'))
  assert.equal(spec.args.includes('--dangerously-skip-permissions'), false)
  const filename = path.join(options.home, '.workbuddy', 'models.json')
  const updated = JSON.parse(fs.readFileSync(filename, 'utf8'))
  updated[0].apiKey = 'rotated-key'
  fs.writeFileSync(filename, JSON.stringify(updated))
  assert.equal(workBuddyEnvironment(options).CODEBUDDY_API_KEY, 'rotated-key')
})

test('missing, encrypted or non-tool models fail closed without falling back', t => {
  const options = fixture(t)
  for (const modelId of ['missing', 'encrypted', 'image', '../text']) {
    assert.throws(() => workBuddyEnvironment({ ...options, modelId }), /LOCAL_WORKBUDDY_MODEL_UNAVAILABLE/)
    assert.deepEqual(workBuddyCredentialState({ ...options, modelId }), { state: 'unknown', source: 'workbuddy-model-unavailable' })
  }
})

test('native WorkBuddy configuration directory is honored', t => {
  const options = fixture(t)
  const directory = path.join(options.home, 'custom')
  fs.renameSync(path.join(options.home, '.workbuddy'), directory)
  assert.deepEqual(workBuddySettings(options).models, [])
  const custom = { ...options, env: { CODEBUDDY_CONFIG_DIR: directory }, modelId: 'text' }
  assert.equal(workBuddyEnvironment(custom).CODEBUDDY_CONFIG_DIR, directory)
})

test('host-encrypted desktop login is diagnosed separately and explicit provider remains usable', async t => {
  const options = fixture(t)
  const directory = path.join(options.home, 'Library/Application Support/CodeBuddyExtension/Data/Public/auth')
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'workbuddy-desktop.info'), JSON.stringify({ auth: { accessToken: { ciphertext: 'not-readable-by-cli' } } }))
  // Independent installations must not be blocked merely because the desktop
  // client also has its own protected account on this computer.
  assert.deepEqual(await resolveNativeCredentialState('workbuddy', options), { state: 'unknown', source: 'unverified' })
  options.executable = path.join(options.home, 'cli', 'bin', 'codebuddy')
  fs.mkdirSync(path.dirname(options.executable), { recursive: true })
  fs.mkdirSync(path.join(options.home, 'cli', 'dist'))
  fs.writeFileSync(options.executable, '')
  fs.writeFileSync(path.join(options.home, 'cli', 'dist', 'codebuddy-lite-wb.mjs'), '')
  assert.deepEqual(await resolveNativeCredentialState('workbuddy', options), { state: 'unknown', source: 'workbuddy-desktop-locked' })
  assert.deepEqual(await resolveNativeCredentialState('workbuddy', { ...options, modelId: 'text' }), { state: 'ready', source: 'native-credential' })
})

test('WorkBuddy custom provider 401 stays run-scoped while native sign-in errors retain their meaning', () => {
  const error = failedAgentProcessError('HTTP 401: Unauthorized', { kind: 'workbuddy', model: 'custom-local:text' })
  assert.equal(error.code, 'LOCAL_WORKBUDDY_PROVIDER_AUTH')
  assert.equal(error.failure.category, 'authentication')
  assert.equal(failedAgentProcessError('Please sign in', { kind: 'workbuddy' }).code, 'LOCAL_AGENT_AUTH_REQUIRED')
})

test('WorkBuddy model IPC validates native IDs, rejects active runs and rolls back failed persistence', async () => {
  const handles = new Map()
  const workspace = { state: { agentPreferences: { workbuddy: { showInSidebar: false } }, agentRuntime: { workbuddy: { credentialState: 'missing' } } }, activeRuns: new Map(), preparingRuns: new Map(), save() {} }
  registerDesktopIpc({ registerTrustedHandle: (channel, callback) => handles.set(channel, callback), getWorkspace: () => workspace,
    getWorkBuddySettings: async () => ({ modelId: '', models: [{ id: 'text', name: 'Text model' }] }), refreshLocalAgentState: async () => {} })
  const setModel = handles.get('local-workbuddy:set-model')
  for (const args of [[], [{}], ['text', 'extra'], ['unregistered'], ['../text']]) {
    await assert.rejects(setModel(...args), /LOCAL_WORKBUDDY_MODEL_UNAVAILABLE/)
  }
  workspace.activeRuns.set('group', {})
  await assert.rejects(setModel('text'), /LOCAL_WORKBUDDY_BUSY/)
  workspace.activeRuns.clear()
  workspace.save = () => { throw new Error('disk-full') }
  await assert.rejects(setModel('text'), /disk-full/)
  assert.deepEqual(workspace.state.agentPreferences.workbuddy, { showInSidebar: false })
  assert.equal(workspace.state.agentRuntime.workbuddy.credentialState, 'missing')
  workspace.save = () => {}
  assert.equal((await setModel('text')).modelId, 'text')
  assert.deepEqual(workspace.state.agentPreferences.workbuddy, { showInSidebar: false, modelId: 'text' })
  assert.equal(workspace.state.agentRuntime.workbuddy, undefined)
})

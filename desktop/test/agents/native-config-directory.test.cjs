const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { nativeAuthIdentityFiles, nativeConfigEnvironment, nativeIdentityDirectory, validateNativeConfigDirectory } = require('../../src/agents/native-config-directory.cjs')
const { nativeCredentialState } = require('../../src/agents/local-agent-readiness.cjs')
const { loadWorkspaceState, saveWorkspaceState } = require('../../src/workspace/local-workspace-state.cjs')

test('validates a selected native directory and scopes it to the owning Agent', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-native-config-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  assert.throws(() => validateNativeConfigDirectory('hermes', directory), { message: 'LOCAL_NATIVE_CONFIG_INVALID' })
  fs.writeFileSync(path.join(directory, 'config.yaml'), 'model: native\n')
  const selected = validateNativeConfigDirectory('hermes', directory)
  const preferences = { hermes: { nativeConfigDirectory: selected } }
  assert.equal(nativeConfigEnvironment('hermes', preferences, { PATH: '/bin' }).HERMES_HOME, selected)
  assert.deepEqual(nativeConfigEnvironment('codex', preferences, { PATH: '/bin' }), { PATH: '/bin' })
  assert.throws(() => validateNativeConfigDirectory('unknown', directory), { message: 'LOCAL_NATIVE_CONFIG_INVALID' })
  assert.throws(() => validateNativeConfigDirectory('hermes', 'relative'), { message: 'LOCAL_NATIVE_CONFIG_INVALID' })
  assert.throws(() => nativeConfigEnvironment('hermes', { hermes: { nativeConfigDirectory: 'relative' } }), { message: 'LOCAL_NATIVE_CONFIG_INVALID' })
})

test('native identity directories follow shell overrides and known defaults', () => {
  const home = path.resolve('test-home')
  const selected = path.join(home, 'native-kimi')
  assert.equal(nativeIdentityDirectory('codex', {}, home, 'linux'), path.join(home, '.codex'))
  assert.equal(nativeIdentityDirectory('gemini', {}, home, 'linux'), path.join(home, '.gemini'))
  assert.equal(nativeIdentityDirectory('gemini', { GEMINI_CLI_HOME: selected }, home, 'linux'), path.join(selected, '.gemini'))
  assert.equal(nativeIdentityDirectory('gemini', { GEMINI_CLI_HOME: 'relative' }, home, 'linux'), '')
  assert.equal(nativeIdentityDirectory('kimi', { KIMI_CODE_HOME: selected }, home, 'linux'), selected)
  assert.equal(nativeIdentityDirectory('kimi', { KIMI_CODE_HOME: 'relative' }, home, 'linux'), '')
  assert.equal(nativeIdentityDirectory('hermes', { HERMES_DATA_DIR_SUFFIX: '-test' }, home, 'linux'), path.join(home, '.hermes-test'))
  assert.equal(nativeIdentityDirectory('unknown', {}, home, 'linux'), '')
})

test('MiMo validates its selected native configuration directory', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-mimo-config-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  assert.throws(() => validateNativeConfigDirectory('mimo', directory), { message: 'LOCAL_NATIVE_CONFIG_INVALID' })
  fs.writeFileSync(path.join(directory, 'mimocode.jsonc'), '{"model":"custom/model"}')
  const selected = validateNativeConfigDirectory('mimo', directory)
  const env = nativeConfigEnvironment('mimo', { mimo: { nativeConfigDirectory: selected } }, {})
  assert.equal(env.MIMOCODE_CONFIG_DIR, selected)
  assert.equal(nativeIdentityDirectory('mimo', env, directory), selected)
})

test('OpenCode authentication identity follows its XDG data directory', () => {
  const home = path.resolve('test-home')
  assert.deepEqual(nativeAuthIdentityFiles('opencode', {}, home), [path.join(home, '.local', 'share', 'opencode', 'auth.json')])
  assert.deepEqual(nativeAuthIdentityFiles('opencode', { XDG_DATA_HOME: path.join(home, 'data') }, home),
    [path.join(home, 'data', 'opencode', 'auth.json')])
  assert.deepEqual(nativeAuthIdentityFiles('opencode', { XDG_DATA_HOME: 'relative' }, home), [])
  assert.deepEqual(nativeAuthIdentityFiles('codex', {}, home), [])
})

test('Gemini authentication identity includes explicitly selected system and cloud files', () => {
  const home = path.resolve('test-home')
  const settings = path.join(home, 'system', 'settings.json')
  const credentials = path.join(home, 'cloud', 'credentials.json')
  assert.deepEqual(nativeAuthIdentityFiles('gemini', {
    GEMINI_CLI_SYSTEM_SETTINGS_PATH: settings, GOOGLE_APPLICATION_CREDENTIALS: credentials,
  }, home), [settings, path.join(home, 'system', 'system-defaults.json'), credentials])
  assert.deepEqual(nativeAuthIdentityFiles('gemini', {
    GEMINI_CLI_SYSTEM_SETTINGS_PATH: 'relative', GOOGLE_APPLICATION_CREDENTIALS: 'relative',
  }, home), [])
  assert.deepEqual(nativeAuthIdentityFiles('gemini', {}, home, 'darwin'), [
    '/Library/Application Support/GeminiCli/settings.json',
    '/Library/Application Support/GeminiCli/system-defaults.json',
    path.join(home, '.config', 'gcloud', 'application_default_credentials.json'),
  ])
  assert.deepEqual(nativeAuthIdentityFiles('gemini', { APPDATA: 'C:\\Users\\User\\AppData\\Roaming' }, 'C:\\Users\\User', 'win32'), [
    'C:\\ProgramData\\gemini-cli\\settings.json', 'C:\\ProgramData\\gemini-cli\\system-defaults.json',
    'C:\\Users\\User\\AppData\\Roaming\\gcloud\\application_default_credentials.json',
  ])
})

test('Qwen authentication identity tracks its native user and system settings', () => {
  const home = path.resolve('test-home')
  const settings = path.join(home, 'system', 'qwen.json')
  assert.deepEqual(nativeAuthIdentityFiles('qwen', { QWEN_CODE_SYSTEM_SETTINGS_PATH: settings }, home, 'darwin'), [
    settings, path.join(home, 'system', 'system-defaults.json'),
    path.join(home, '.qwen', 'settings.json'), path.join(home, '.qwen', 'oauth_creds.json'),
  ])
})

test('a selected native directory survives workspace restart', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-native-config-restart-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'config.yaml'), 'model: native\n')
  const selected = validateNativeConfigDirectory('hermes', directory)
  const storagePath = path.join(directory, 'workspace.json')
  saveWorkspaceState(storagePath, { version: 3, groups: [], messages: [], sessions: {},
    agentPreferences: { hermes: { nativeConfigDirectory: selected } }, agentRuntime: {} })
  const restored = loadWorkspaceState(storagePath)
  assert.equal(restored.status, 'ready')
  assert.equal(nativeConfigEnvironment('hermes', restored.state.agentPreferences).HERMES_HOME, selected)
})

test('Hermes accepts a native directory configured through .env alone', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-hermes-env-config-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, '.env'), 'OPENAI_API_KEY=synthetic-secret\n')
  const selected = validateNativeConfigDirectory('hermes', directory)
  const env = nativeConfigEnvironment('hermes', { hermes: { nativeConfigDirectory: selected } }, {})
  assert.equal(env.HERMES_HOME, selected)
  assert.deepEqual(nativeCredentialState('hermes', { home: directory, env }), {
    state: 'ready', source: 'native-credential',
  })
})

test('DeepSeek Harness accepts its native profiles directory and scopes DSH_HOME', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-dsh-config-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  assert.throws(() => validateNativeConfigDirectory('deepseek', directory), { message: 'LOCAL_NATIVE_CONFIG_INVALID' })
  fs.mkdirSync(path.join(directory, 'profiles'))
  const selected = validateNativeConfigDirectory('deepseek', directory)
  const preferences = { deepseek: { nativeConfigDirectory: selected } }
  assert.equal(nativeConfigEnvironment('deepseek', preferences, { DSH_HOME: '/previous' }).DSH_HOME, selected)
  assert.deepEqual(nativeConfigEnvironment('hermes', preferences), {})
})

test('Kimi accepts a credentials-only native directory', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-kimi-config-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  assert.throws(() => validateNativeConfigDirectory('kimi', directory), { message: 'LOCAL_NATIVE_CONFIG_INVALID' })
  fs.mkdirSync(path.join(directory, 'credentials'))
  const selected = validateNativeConfigDirectory('kimi', directory)
  assert.equal(nativeConfigEnvironment('kimi', { kimi: { nativeConfigDirectory: selected } }).KIMI_CODE_HOME, selected)
})

test('Gemini selected .gemini directory maps to its native home and preserves symlinks', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-gemini-config-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const actual = path.join(directory, 'actual'); fs.mkdirSync(actual)
  fs.writeFileSync(path.join(actual, 'settings.json'), '{}')
  const parent = path.join(directory, 'home'); fs.mkdirSync(parent)
  const selected = path.join(parent, '.gemini')
  try { fs.symlinkSync(actual, selected, 'dir') } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error
    fs.mkdirSync(selected)
    fs.copyFileSync(path.join(actual, 'settings.json'), path.join(selected, 'settings.json'))
  }
  assert.throws(() => validateNativeConfigDirectory('gemini', actual), /LOCAL_NATIVE_CONFIG_INVALID/)
  assert.equal(validateNativeConfigDirectory('gemini', selected), selected)
  const env = nativeConfigEnvironment('gemini', { gemini: { nativeConfigDirectory: selected } })
  assert.equal(env.GEMINI_CLI_HOME, parent)
  assert.equal(nativeIdentityDirectory('gemini', env, directory), selected)
  assert.throws(() => nativeConfigEnvironment('gemini', { gemini: { nativeConfigDirectory: actual } }), /LOCAL_NATIVE_CONFIG_INVALID/)
})

for (const [kind, key, file] of [
  ['codex', 'CODEX_HOME', 'config.toml'],
  ['claude', 'CLAUDE_CONFIG_DIR', 'settings.json'],
  ['pi', 'PI_CODING_AGENT_DIR', 'models.json'],
  ['kimi', 'KIMI_CODE_HOME', 'config.toml'],
  ['workbuddy', 'CODEBUDDY_CONFIG_DIR', 'models.json'],
  ['opencode', 'OPENCODE_CONFIG_DIR', 'opencode.jsonc'],
]) {
  test(`${kind} uses its selected native configuration directory`, t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `meldwork-${kind}-config-`))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    fs.writeFileSync(path.join(directory, file), '')
    const selected = validateNativeConfigDirectory(kind, directory)
    assert.equal(nativeConfigEnvironment(kind, { [kind]: { nativeConfigDirectory: selected } })[key], selected)
    assert.deepEqual(nativeConfigEnvironment('hermes', { [kind]: { nativeConfigDirectory: selected } }), {})
  })
}

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { nativeAuthIdentityFiles, nativeConfigEnvironment, nativeIdentityDirectory, nativeProjectConfigPaths, validateNativeConfigDirectory } = require('../../src/agents/native-config-directory.cjs')

test('Zcode authentication identity follows the target Windows profile', () => {
  assert.deepEqual(nativeAuthIdentityFiles('zcode', { USERPROFILE: 'C:\\Users\\Ryder' }, 'C:\\Fallback', 'win32'), [
    'C:\\Users\\Ryder\\.zcode\\cli\\config.json',
  ])
})

test('Zcode CA bundle changes invalidate verification and relative paths are tracked', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-zcode-ca-identity-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const filename = path.join(home, 'ca.pem')
  fs.writeFileSync(filename, 'first certificate')
  const { NATIVE_AUTH_IDENTITY_FILES } = require('../../src/agents/native-config-directory.cjs')
  const { agentVerificationIdentity } = require('../../src/workspace/agent-verification-identity.cjs')
  const agent = { kind: 'zcode' }
  Object.defineProperty(agent, NATIVE_AUTH_IDENTITY_FILES, {
    value: nativeAuthIdentityFiles('zcode', { ZCODE_AGENT_CA_CERT: filename }, home),
  })
  assert.ok(agent[NATIVE_AUTH_IDENTITY_FILES].includes(filename))
  assert.deepEqual(nativeProjectConfigPaths('zcode', { ZCODE_AGENT_CA_CERT: 'certs/ca.pem' }), [
    { value: 'certs/ca.pem', directory: false },
  ])
  const before = agentVerificationIdentity(agent)
  fs.writeFileSync(filename, 'replacement certificate')
  assert.notEqual(agentVerificationIdentity(agent), before)
})
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
  const shared = ['config.json', 'opencode.json', 'opencode.jsonc'].map(name => path.join(home, '.config', 'opencode', name))
  shared.push(...['opencode.json', 'opencode.jsonc'].map(name => path.join(home, '.opencode', name)))
  const cloud = [path.join(home, '.local', 'state', 'opencode', 'model.json'),
    path.join(home, '.cache', 'opencode', 'models.json'),
    path.join(home, '.aws', 'config'), path.join(home, '.aws', 'credentials')]
  assert.deepEqual(nativeAuthIdentityFiles('opencode', {}, home), [path.join(home, '.local', 'share', 'opencode', 'auth.json'), ...shared, ...cloud])
  assert.deepEqual(nativeAuthIdentityFiles('opencode', { XDG_DATA_HOME: path.join(home, 'data') }, home),
    [path.join(home, 'data', 'opencode', 'auth.json'), ...shared, ...cloud])
  assert.deepEqual(nativeAuthIdentityFiles('opencode', { XDG_DATA_HOME: 'relative' }, home), [...shared, ...cloud])
  assert.deepEqual(nativeAuthIdentityFiles('opencode', { OPENCODE_CONFIG: path.join(home, 'custom.json') }, home),
    [path.join(home, '.local', 'share', 'opencode', 'auth.json'), path.join(home, 'custom.json'), ...shared, ...cloud])
  assert.deepEqual(nativeAuthIdentityFiles('opencode', { OPENCODE_CONFIG: '~/custom.json' }, home),
    [path.join(home, '.local', 'share', 'opencode', 'auth.json'), path.join(home, 'custom.json'), ...shared, ...cloud])
  const customCache = path.join(home, 'custom-cache')
  assert.ok(nativeAuthIdentityFiles('opencode', { XDG_CACHE_HOME: customCache }, home)
    .includes(path.join(customCache, 'opencode', 'models.json')))
  assert.deepEqual(nativeAuthIdentityFiles('codex', {}, home), [])
})

test('MiMo identity tracks its explicit and user configuration files', () => {
  const home = path.resolve('test-home')
  assert.deepEqual(nativeAuthIdentityFiles('mimo', { MIMOCODE_CONFIG: path.join(home, 'custom.json') }, home), [
    path.join(home, 'custom.json'), path.join(home, '.mimocode', 'mimocode.json'),
    path.join(home, '.mimocode', 'mimocode.jsonc'),
    path.join(home, '.config', 'mimocode', 'mimocode.json'), path.join(home, '.config', 'mimocode', 'mimocode.jsonc'),
    path.join(home, '.local', 'state', 'mimocode', 'model.json'),
  ])
})

test('project config identities retain only relative CLI paths', () => {
  assert.deepEqual(nativeProjectConfigPaths('opencode', { OPENCODE_CONFIG: 'custom.json', OPENCODE_CONFIG_DIR: 'config' }), [
    { value: 'custom.json', directory: false }, { value: 'config', directory: true },
  ])
  assert.deepEqual(nativeProjectConfigPaths('opencode', { AWS_CONFIG_FILE: 'aws/config',
    GOOGLE_APPLICATION_CREDENTIALS: 'google.json' }), [
    { value: 'aws/config', directory: false }, { value: 'google.json', directory: false },
  ])
  assert.deepEqual(nativeProjectConfigPaths('mimo', { MIMOCODE_CONFIG: '/absolute.json', MIMOCODE_CONFIG_DIR: 'config' }), [
    { value: 'config', directory: true },
  ])
  assert.deepEqual(nativeProjectConfigPaths('mimo', { MIMOCODE_CONFIG: '~/config.json' }), [
    { value: '~/config.json', directory: false },
  ])
  assert.deepEqual(nativeProjectConfigPaths('codex', { OPENCODE_CONFIG: 'custom.json' }), [])
  assert.deepEqual(nativeProjectConfigPaths('gemini', { GEMINI_CLI_SYSTEM_SETTINGS_PATH: 'system/settings.json',
    GOOGLE_APPLICATION_CREDENTIALS: 'credentials.json' }), [
    { value: 'system/settings.json', directory: false }, { value: 'system/system-defaults.json', directory: false },
    { value: 'credentials.json', directory: false },
  ])
  assert.deepEqual(nativeProjectConfigPaths('qwen', { QWEN_CODE_SYSTEM_SETTINGS_PATH: 'qwen/settings.json',
    QWEN_CODE_SYSTEM_DEFAULTS_PATH: '/absolute-defaults.json' }), [{ value: 'qwen/settings.json', directory: false }])
  assert.deepEqual(nativeProjectConfigPaths('pi', { AWS_CONFIG_FILE: 'aws/config',
    GOOGLE_APPLICATION_CREDENTIALS: 'google.json', AZURE_FEDERATED_TOKEN_FILE: 'ignored' }), [
    { value: 'aws/config', directory: false }, { value: 'google.json', directory: false },
  ])
  assert.deepEqual(nativeProjectConfigPaths('claude', { AWS_SHARED_CREDENTIALS_FILE: 'aws/credentials',
    AZURE_FEDERATED_TOKEN_FILE: 'azure/token', AWS_CONFIG_FILE: '/absolute' }), [
    { value: 'aws/credentials', directory: false }, { value: 'azure/token', directory: false },
  ])
})

test('Pi and Claude identity tracks explicitly selected absolute cloud credential files', () => {
  const home = path.resolve('test-home')
  const aws = path.join(home, 'aws', 'credentials')
  const azure = path.join(home, 'azure', 'token')
  const env = { AWS_SHARED_CREDENTIALS_FILE: aws, AZURE_FEDERATED_TOKEN_FILE: azure,
    GOOGLE_APPLICATION_CREDENTIALS: 'relative.json' }
  const config = path.join(home, '.aws', 'config')
  assert.deepEqual(nativeAuthIdentityFiles('pi', env, home), [config, aws])
  assert.deepEqual(nativeAuthIdentityFiles('claude', env, home), [config, aws, azure])
  assert.deepEqual(nativeAuthIdentityFiles('pi', { AWS_CONFIG_FILE: 'relative-config' }, home),
    [path.join(home, '.aws', 'credentials')])
})

test('default AWS credential updates change Pi and Claude verification identity', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-aws-identity-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const filename = path.join(home, '.aws', 'credentials')
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  fs.writeFileSync(filename, 'first')
  const { NATIVE_AUTH_IDENTITY_FILES } = require('../../src/agents/native-config-directory.cjs')
  const { agentVerificationIdentity } = require('../../src/workspace/agent-verification-identity.cjs')
  const agents = ['pi', 'claude', 'opencode'].map(kind => {
    const agent = { kind }
    Object.defineProperty(agent, NATIVE_AUTH_IDENTITY_FILES, { value: nativeAuthIdentityFiles(kind, {}, home) })
    return agent
  })
  const before = agents.map(agent => agentVerificationIdentity(agent))
  fs.writeFileSync(filename, 'replacement credentials')
  for (let index = 0; index < agents.length; index += 1) {
    assert.notEqual(agentVerificationIdentity(agents[index]), before[index])
  }
})

test('AWS CA bundle changes invalidate Bedrock Agent verification and relative paths are tracked', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-aws-ca-identity-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const filename = path.join(home, 'ca.pem')
  fs.writeFileSync(filename, 'first certificate')
  const { NATIVE_AUTH_IDENTITY_FILES } = require('../../src/agents/native-config-directory.cjs')
  const { agentVerificationIdentity } = require('../../src/workspace/agent-verification-identity.cjs')
  const agents = ['pi', 'claude', 'opencode'].map(kind => {
    const agent = { kind }
    Object.defineProperty(agent, NATIVE_AUTH_IDENTITY_FILES, {
      value: nativeAuthIdentityFiles(kind, { AWS_CA_BUNDLE: filename }, home),
    })
    assert.ok(agent[NATIVE_AUTH_IDENTITY_FILES].includes(filename))
    assert.deepEqual(nativeProjectConfigPaths(kind, { AWS_CA_BUNDLE: 'certs/ca.pem' }), [
      { value: 'certs/ca.pem', directory: false },
    ])
    return agent
  })
  const before = agents.map(agent => agentVerificationIdentity(agent))
  fs.writeFileSync(filename, 'replacement certificate')
  for (let index = 0; index < agents.length; index += 1) {
    assert.notEqual(agentVerificationIdentity(agents[index]), before[index])
  }
})

test('native TLS bundle changes invalidate Agent and workspace verification', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-native-ca-identity-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const absolute = path.join(home, 'absolute.pem')
  const relative = path.join(home, 'relative.pem')
  fs.writeFileSync(absolute, 'first certificate')
  fs.writeFileSync(relative, 'first relative certificate')
  const { NATIVE_AUTH_IDENTITY_FILES, NATIVE_PROJECT_CONFIG_PATHS, nativeNetworkIdentityFiles } = require('../../src/agents/native-config-directory.cjs')
  const { agentVerificationIdentity, projectVerificationIdentity } = require('../../src/workspace/agent-verification-identity.cjs')
  const env = { NODE_EXTRA_CA_CERTS: absolute, SSL_CERT_FILE: 'relative.pem' }
  const agent = { kind: 'codex' }
  Object.defineProperty(agent, NATIVE_AUTH_IDENTITY_FILES, { value: nativeNetworkIdentityFiles(env) })
  Object.defineProperty(agent, NATIVE_PROJECT_CONFIG_PATHS, { value: nativeProjectConfigPaths('codex', env) })
  const before = agentVerificationIdentity(agent)
  const projectBefore = projectVerificationIdentity('codex', home, agent, 'environment')
  fs.writeFileSync(absolute, 'updated certificate')
  fs.writeFileSync(relative, 'updated relative certificate')
  assert.notEqual(agentVerificationIdentity(agent), before)
  assert.notEqual(projectVerificationIdentity('codex', home, agent, 'environment'), projectBefore)
})

test('MiMo recent model changes invalidate verification identity', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-mimo-model-identity-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const filename = path.join(home, '.local', 'state', 'mimocode', 'model.json')
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  fs.writeFileSync(filename, '{"recent":[]}')
  const { NATIVE_AUTH_IDENTITY_FILES } = require('../../src/agents/native-config-directory.cjs')
  const { agentVerificationIdentity } = require('../../src/workspace/agent-verification-identity.cjs')
  const agent = { kind: 'mimo' }
  Object.defineProperty(agent, NATIVE_AUTH_IDENTITY_FILES, { value: nativeAuthIdentityFiles('mimo', {}, home) })
  const before = agentVerificationIdentity(agent)
  fs.writeFileSync(filename, '{"recent":[{"providerID":"test","modelID":"model"}]}')
  assert.notEqual(agentVerificationIdentity(agent), before)
})

test('OpenCode recent models and provider metadata changes invalidate verification identity', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-opencode-model-identity-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const filename = path.join(home, '.local', 'state', 'opencode', 'model.json')
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  fs.writeFileSync(filename, '{"recent":[]}')
  const { NATIVE_AUTH_IDENTITY_FILES } = require('../../src/agents/native-config-directory.cjs')
  const { agentVerificationIdentity } = require('../../src/workspace/agent-verification-identity.cjs')
  const agent = { kind: 'opencode' }
  Object.defineProperty(agent, NATIVE_AUTH_IDENTITY_FILES, { value: nativeAuthIdentityFiles('opencode', {}, home) })
  const before = agentVerificationIdentity(agent)
  fs.writeFileSync(filename, '{"recent":[{"providerID":"test","modelID":"model"}]}')
  assert.notEqual(agentVerificationIdentity(agent), before)
  const afterRecent = agentVerificationIdentity(agent)
  const metadata = path.join(home, '.cache', 'opencode', 'models.json')
  fs.mkdirSync(path.dirname(metadata), { recursive: true })
  fs.writeFileSync(metadata, '{"test":{"env":["API_KEY"]}}')
  assert.notEqual(agentVerificationIdentity(agent), afterRecent)
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

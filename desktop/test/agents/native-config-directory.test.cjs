const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { nativeAuthIdentityFiles, nativeConfigEnvironment, nativeIdentityDirectory, nativeProjectConfigPaths, validateNativeConfigDirectory } = require('../../src/agents/native-config-directory.cjs')

test('OpenClaw selects its native state directory without changing other Agents', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-openclaw-config-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  assert.throws(() => validateNativeConfigDirectory('openclaw', root), { message: 'LOCAL_NATIVE_CONFIG_INVALID' })
  fs.mkdirSync(path.join(root, 'agents'))
  const selected = validateNativeConfigDirectory('openclaw', root)
  const preferences = { openclaw: { nativeConfigDirectory: selected } }
  assert.equal(nativeConfigEnvironment('openclaw', preferences, {}).OPENCLAW_STATE_DIR, selected)
  assert.equal(nativeIdentityDirectory('openclaw', { OPENCLAW_STATE_DIR: selected }, root), selected)
  assert.equal(nativeConfigEnvironment('hermes', preferences, {}).OPENCLAW_STATE_DIR, undefined)
})

test('OpenCodeReview selects its native configuration directory and parent home', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-ocr-config-home-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const directory = path.join(home, '.opencodereview')
  fs.mkdirSync(directory)
  assert.throws(() => validateNativeConfigDirectory('opencodereview', directory), { message: 'LOCAL_NATIVE_CONFIG_INVALID' })
  fs.writeFileSync(path.join(directory, 'config.json'), '{}')
  assert.equal(validateNativeConfigDirectory('opencodereview', directory), directory)
  const preferences = { opencodereview: { nativeConfigDirectory: directory } }
  assert.equal(nativeConfigEnvironment('opencodereview', preferences, { HOME: '/old' }).HOME, home)
  const { childEnvironment } = require('../../src/agents/cli/cli-process-support.cjs')
  const selected = nativeConfigEnvironment('opencodereview', preferences, { HOME: '/old' })
  assert.equal(childEnvironment({ kind: 'opencodereview' }, home, { env: selected }, process.platform).HOME, home)
  assert.deepEqual(nativeConfigEnvironment('opencodereview', preferences, {}, 'win32'), { HOME: home, USERPROFILE: home })
  const windows = nativeConfigEnvironment('opencodereview', preferences, {}, 'win32')
  assert.equal(childEnvironment({ kind: 'opencodereview' }, home, { env: windows }, 'win32').USERPROFILE, home)
  assert.equal(nativeIdentityDirectory('opencodereview', { HOME: home }, '/other', 'linux'), directory)
  assert.throws(() => nativeConfigEnvironment('opencodereview', { opencodereview: { nativeConfigDirectory: home } }),
    { message: 'LOCAL_NATIVE_CONFIG_INVALID' })
  if (process.platform !== 'win32') {
    assert.throws(() => nativeConfigEnvironment('opencodereview', { opencodereview: { nativeConfigDirectory: path.join(home, '.OPENCODEREVIEW') } }),
      { message: 'LOCAL_NATIVE_CONFIG_INVALID' })
    const alias = path.join(home, 'alias', '.opencodereview')
    fs.mkdirSync(path.dirname(alias))
    fs.symlinkSync(directory, alias, 'dir')
    assert.equal(validateNativeConfigDirectory('opencodereview', alias), alias)
    assert.equal(nativeConfigEnvironment('opencodereview', { opencodereview: { nativeConfigDirectory: alias } }).HOME, path.dirname(alias))
  }
})

test('OpenCodeReview verification changes when native credentials or configuration change', t => {
  const { NATIVE_AUTH_IDENTITY_FILES } = require('../../src/agents/native-config-directory.cjs')
  const { agentVerificationIdentity } = require('../../src/workspace/agent-verification-identity.cjs')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-ocr-identity-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const directory = path.join(home, '.opencodereview')
  fs.mkdirSync(directory)
  const agent = { kind: 'opencodereview' }
  Object.defineProperty(agent, NATIVE_AUTH_IDENTITY_FILES, { value: nativeAuthIdentityFiles(agent.kind, {}, home) })
  let previous = agentVerificationIdentity(agent)
  for (const name of ['config.json', '.env']) {
    fs.writeFileSync(path.join(directory, name), 'first')
    const current = agentVerificationIdentity(agent)
    assert.notEqual(current, previous, name)
    previous = current
  }
  assert.deepEqual(nativeAuthIdentityFiles('opencodereview', { HOME: '/other' }, '/home', 'linux'), [
    '/home/.opencodereview/config.json', '/home/.opencodereview/.env',
    '/other/.opencodereview/config.json', '/other/.opencodereview/.env',
  ])
  assert.deepEqual(nativeAuthIdentityFiles('opencodereview', { USERPROFILE: 'C:\\Other' }, 'C:\\Home', 'win32'), [
    'C:\\Home\\.opencodereview\\config.json', 'C:\\Home\\.opencodereview\\.env',
    'C:\\Other\\.opencodereview\\config.json', 'C:\\Other\\.opencodereview\\.env',
  ])
})

test('Zcode selects only a native .zcode/cli directory and derives its process home', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-zcode-config-home-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const selected = path.join(home, '.zcode', 'cli')
  fs.mkdirSync(selected, { recursive: true })
  assert.throws(() => validateNativeConfigDirectory('zcode', selected), { message: 'LOCAL_NATIVE_CONFIG_INVALID' })
  fs.writeFileSync(path.join(selected, 'config.json'), '{}')
  const directory = validateNativeConfigDirectory('zcode', selected)
  const preferences = { zcode: { nativeConfigDirectory: directory } }
  assert.equal(nativeConfigEnvironment('zcode', preferences, { HOME: '/old' }).HOME, path.resolve(home))
  assert.deepEqual(nativeConfigEnvironment('zcode', preferences, {}, 'win32'), { HOME: path.resolve(home), USERPROFILE: path.resolve(home) })
  assert.equal(nativeIdentityDirectory('zcode', { HOME: path.resolve(home) }, '/other', 'linux'), directory)
  assert.equal(nativeIdentityDirectory('zcode', { USERPROFILE: 'C:\\Users\\Selected' }, 'C:\\Other', 'win32'),
    'C:\\Users\\Selected\\.zcode\\cli')
  assert.throws(() => nativeConfigEnvironment('zcode', { zcode: { nativeConfigDirectory: home } }), { message: 'LOCAL_NATIVE_CONFIG_INVALID' })
  if (process.platform !== 'win32') {
    assert.throws(() => nativeConfigEnvironment('zcode', { zcode: { nativeConfigDirectory: path.join(home, '.ZCODE', 'cli') } }),
      { message: 'LOCAL_NATIVE_CONFIG_INVALID' })
    const aliasHome = path.join(home, 'alias')
    fs.mkdirSync(path.join(aliasHome, '.zcode'), { recursive: true })
    const linked = path.join(aliasHome, '.zcode', 'cli')
    fs.symlinkSync(selected, linked, 'dir')
    assert.equal(validateNativeConfigDirectory('zcode', linked), path.resolve(linked))
    assert.equal(nativeConfigEnvironment('zcode', { zcode: { nativeConfigDirectory: linked } }).HOME, aliasHome)
  }
})

test('Qwen selects a native .qwen directory and derives its process home', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-qwen-config-home-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const selected = path.join(home, '.qwen')
  fs.mkdirSync(selected)
  assert.throws(() => validateNativeConfigDirectory('qwen', selected), { message: 'LOCAL_NATIVE_CONFIG_INVALID' })
  fs.writeFileSync(path.join(selected, 'settings.json'), '{}')
  const directory = validateNativeConfigDirectory('qwen', selected)
  const preferences = { qwen: { nativeConfigDirectory: directory } }
  assert.equal(nativeConfigEnvironment('qwen', preferences, { HOME: '/old' }).HOME, path.resolve(home))
  assert.deepEqual(nativeConfigEnvironment('qwen', preferences, {}, 'win32'), { HOME: path.resolve(home), USERPROFILE: path.resolve(home) })
  assert.equal(nativeIdentityDirectory('qwen', { HOME: path.resolve(home) }, '/other', 'linux'), directory)
  const identityFiles = nativeAuthIdentityFiles('qwen', { HOME: path.resolve(home) }, '/other', 'linux')
  assert.ok(identityFiles.includes(path.join(directory, 'settings.json')))
  assert.equal(identityFiles.includes('/other/.qwen/settings.json'), false)
  assert.equal(nativeIdentityDirectory('qwen', { USERPROFILE: 'C:\\Users\\Selected' }, 'C:\\Other', 'win32'),
    'C:\\Users\\Selected\\.qwen')
  assert.throws(() => nativeConfigEnvironment('qwen', { qwen: { nativeConfigDirectory: home } }), { message: 'LOCAL_NATIVE_CONFIG_INVALID' })
  if (process.platform !== 'win32') {
    assert.throws(() => nativeConfigEnvironment('qwen', { qwen: { nativeConfigDirectory: path.join(home, '.QWEN') } }),
      { message: 'LOCAL_NATIVE_CONFIG_INVALID' })
    const aliasHome = path.join(home, 'alias')
    fs.mkdirSync(aliasHome)
    const linked = path.join(aliasHome, '.qwen')
    fs.symlinkSync(selected, linked, 'dir')
    assert.equal(validateNativeConfigDirectory('qwen', linked), path.resolve(linked))
    assert.equal(nativeConfigEnvironment('qwen', { qwen: { nativeConfigDirectory: linked } }).HOME, aliasHome)
  }
})

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
  assert.equal(nativeIdentityDirectory('hermes', { HERMES_HOME: '~/profiles/work' }, home, 'linux'), path.join(home, 'profiles', 'work'))
  assert.equal(nativeIdentityDirectory('unknown', {}, home, 'linux'), '')
})

test('verification tracks the native files used by credential readiness', t => {
  const { NATIVE_CONFIG_IDENTITY_DIRECTORY } = require('../../src/agents/native-config-directory.cjs')
  const { agentVerificationIdentity } = require('../../src/workspace/agent-verification-identity.cjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-native-identity-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const [kind, files] of Object.entries({
    hermes: ['config.json'], codex: ['config.json', '.env'],
    claude: ['settings.local.json', '.env'], kimi: ['.env'],
  })) {
    const directory = path.join(root, kind)
    fs.mkdirSync(directory)
    const agent = { kind }
    Object.defineProperty(agent, NATIVE_CONFIG_IDENTITY_DIRECTORY, { value: directory })
    for (const file of files) {
      const before = agentVerificationIdentity(agent)
      fs.writeFileSync(path.join(directory, file), 'changed native configuration')
      assert.notEqual(agentVerificationIdentity(agent), before, `${kind}: ${file}`)
    }
  }
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
    path.join(home, '.aws', 'config'), path.join(home, '.aws', 'credentials'),
    path.join(home, '.config', 'gcloud', 'application_default_credentials.json')]
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
  assert.deepEqual(nativeProjectConfigPaths('hermes', { AWS_CONFIG_FILE: 'aws/config',
    VERTEX_CREDENTIALS_PATH: 'vertex.json', CLOUDSDK_CONFIG: 'gcloud' }), [
    { value: 'aws/config', directory: false }, { value: 'vertex.json', directory: false },
    { value: path.join('gcloud', 'application_default_credentials.json'), directory: false },
  ])
})

test('Hermes project verification follows a relative Google Cloud credentials directory', t => {
  const { NATIVE_PROJECT_CONFIG_PATHS } = require('../../src/agents/native-config-directory.cjs')
  const { projectVerificationIdentity } = require('../../src/workspace/agent-verification-identity.cjs')
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-hermes-gcloud-project-'))
  t.after(() => fs.rmSync(workdir, { recursive: true, force: true }))
  const filename = path.join(workdir, 'gcloud', 'application_default_credentials.json')
  fs.mkdirSync(path.dirname(filename))
  fs.writeFileSync(filename, 'first')
  const agent = { kind: 'hermes' }
  Object.defineProperty(agent, NATIVE_PROJECT_CONFIG_PATHS, {
    value: nativeProjectConfigPaths('hermes', { CLOUDSDK_CONFIG: 'gcloud' }),
  })
  const before = projectVerificationIdentity('hermes', workdir, agent, 'environment')
  fs.writeFileSync(filename, 'replacement')
  assert.notEqual(projectVerificationIdentity('hermes', workdir, agent, 'environment'), before)
})

test('Google Cloud ADC directories participate in Gemini, Pi and OpenCode verification', t => {
  const { NATIVE_AUTH_IDENTITY_FILES, NATIVE_PROJECT_CONFIG_PATHS } = require('../../src/agents/native-config-directory.cjs')
  const { agentVerificationIdentity, projectVerificationIdentity } = require('../../src/workspace/agent-verification-identity.cjs')
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-gcloud-identities-'))
  t.after(() => fs.rmSync(workdir, { recursive: true, force: true }))
  const root = path.join(workdir, 'gcloud')
  const filename = path.join(root, 'application_default_credentials.json')
  fs.mkdirSync(root)
  fs.writeFileSync(filename, 'first')
  for (const kind of ['gemini', 'pi', 'opencode']) {
    const agent = { kind }
    const absolute = nativeAuthIdentityFiles(kind, { CLOUDSDK_CONFIG: root }, workdir)
    assert.ok(absolute.includes(filename), kind)
    Object.defineProperty(agent, NATIVE_AUTH_IDENTITY_FILES, { value: absolute })
    Object.defineProperty(agent, NATIVE_PROJECT_CONFIG_PATHS, {
      value: nativeProjectConfigPaths(kind, { CLOUDSDK_CONFIG: 'gcloud' }),
    })
    const beforeAgent = agentVerificationIdentity(agent)
    const beforeProject = projectVerificationIdentity(kind, workdir, agent, 'environment')
    fs.appendFileSync(filename, 'x')
    assert.notEqual(agentVerificationIdentity(agent), beforeAgent, kind)
    assert.notEqual(projectVerificationIdentity(kind, workdir, agent, 'environment'), beforeProject, kind)
  }
})

test('Hermes verification tracks native cloud credential files', t => {
  const { NATIVE_AUTH_IDENTITY_FILES } = require('../../src/agents/native-config-directory.cjs')
  const { agentVerificationIdentity } = require('../../src/workspace/agent-verification-identity.cjs')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-hermes-cloud-identity-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const filename = path.join(home, 'vertex.json')
  fs.writeFileSync(filename, 'first')
  const agent = { kind: 'hermes' }
  Object.defineProperty(agent, NATIVE_AUTH_IDENTITY_FILES, {
    value: nativeAuthIdentityFiles('hermes', { VERTEX_CREDENTIALS_PATH: filename }, home),
  })
  assert.ok(agent[NATIVE_AUTH_IDENTITY_FILES].includes(path.join(home, '.config', 'gcloud', 'application_default_credentials.json')))
  const before = agentVerificationIdentity(agent)
  fs.writeFileSync(filename, 'replacement')
  assert.notEqual(agentVerificationIdentity(agent), before)
})

test('Pi and Claude identity tracks explicitly selected absolute cloud credential files', () => {
  const home = path.resolve('test-home')
  const aws = path.join(home, 'aws', 'credentials')
  const azure = path.join(home, 'azure', 'token')
  const env = { AWS_SHARED_CREDENTIALS_FILE: aws, AZURE_FEDERATED_TOKEN_FILE: azure,
    GOOGLE_APPLICATION_CREDENTIALS: 'relative.json' }
  const config = path.join(home, '.aws', 'config')
  const adc = path.join(home, '.config', 'gcloud', 'application_default_credentials.json')
  assert.deepEqual(nativeAuthIdentityFiles('pi', env, home), [config, aws, adc])
  assert.deepEqual(nativeAuthIdentityFiles('claude', env, home), [config, aws, azure])
  assert.deepEqual(nativeAuthIdentityFiles('pi', { AWS_CONFIG_FILE: 'relative-config' }, home),
    [path.join(home, '.aws', 'credentials'), adc])
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
  }, home), [settings, path.join(home, 'system', 'system-defaults.json'), credentials, path.join(home, '.env')])
  assert.deepEqual(nativeAuthIdentityFiles('gemini', {
    GEMINI_CLI_SYSTEM_SETTINGS_PATH: 'relative', GOOGLE_APPLICATION_CREDENTIALS: 'relative',
  }, home), [path.join(home, '.env')])
  assert.deepEqual(nativeAuthIdentityFiles('gemini', {}, home, 'darwin'), [
    '/Library/Application Support/GeminiCli/settings.json',
    '/Library/Application Support/GeminiCli/system-defaults.json',
    path.join(home, '.config', 'gcloud', 'application_default_credentials.json'), path.join(home, '.env'),
  ])
  assert.deepEqual(nativeAuthIdentityFiles('gemini', { APPDATA: 'C:\\Users\\User\\AppData\\Roaming' }, 'C:\\Users\\User', 'win32'), [
    'C:\\ProgramData\\gemini-cli\\settings.json', 'C:\\ProgramData\\gemini-cli\\system-defaults.json',
    'C:\\Users\\User\\AppData\\Roaming\\gcloud\\application_default_credentials.json', 'C:\\Users\\User\\.env',
  ])
})

test('Qwen authentication identity tracks its native user and system settings', () => {
  const home = path.resolve('test-home')
  const settings = path.join(home, 'system', 'qwen.json')
  assert.deepEqual(nativeAuthIdentityFiles('qwen', { QWEN_CODE_SYSTEM_SETTINGS_PATH: settings }, home, 'darwin'), [
    settings, path.join(home, 'system', 'system-defaults.json'),
    path.join(home, '.qwen', 'settings.json'), path.join(home, '.qwen', 'oauth_creds.json'), path.join(home, '.qwen', '.env'),
    path.join(home, '.qwen', 'trustedFolders.json'), path.join(home, '.env'),
  ])
})

test('Qwen verification changes when native folder trust changes', t => {
  const { NATIVE_AUTH_IDENTITY_FILES } = require('../../src/agents/native-config-directory.cjs')
  const { agentVerificationIdentity } = require('../../src/workspace/agent-verification-identity.cjs')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-qwen-trust-identity-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  fs.mkdirSync(path.join(home, '.qwen'))
  const filename = path.join(home, '.qwen', 'trustedFolders.json')
  fs.writeFileSync(filename, '{}')
  const agent = { kind: 'qwen' }
  Object.defineProperty(agent, NATIVE_AUTH_IDENTITY_FILES, { value: nativeAuthIdentityFiles('qwen', {}, home) })
  const before = agentVerificationIdentity(agent)
  fs.writeFileSync(filename, JSON.stringify({ [home]: 'TRUST_FOLDER' }))
  assert.notEqual(agentVerificationIdentity(agent), before)
})

test('Qwen and Gemini project verification track environment files above the Git root', t => {
  const { projectVerificationIdentity } = require('../../src/workspace/agent-verification-identity.cjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-qwen-project-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repository = path.join(root, 'repository')
  const workdir = path.join(repository, 'nested')
  fs.mkdirSync(path.join(repository, '.git'), { recursive: true })
  fs.mkdirSync(workdir)
  for (const kind of ['qwen', 'gemini']) {
    for (const target of [path.join(root, '.env'), path.join(repository, `.${kind}`, '.env')]) {
      fs.rmSync(target, { force: true })
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const before = projectVerificationIdentity(kind, workdir)
      fs.writeFileSync(target, 'API_KEY=changed\n')
      assert.notEqual(projectVerificationIdentity(kind, workdir), before, target)
    }
  }
})

test('Qwen verification identity changes when its native environment file changes', t => {
  const { NATIVE_AUTH_IDENTITY_FILES } = require('../../src/agents/native-config-directory.cjs')
  const { agentVerificationIdentity } = require('../../src/workspace/agent-verification-identity.cjs')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-qwen-identity-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const filename = path.join(home, '.qwen', '.env')
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  fs.writeFileSync(filename, 'DASHSCOPE_API_KEY=first\n')
  const agent = { kind: 'qwen', installed: true }
  Object.defineProperty(agent, NATIVE_AUTH_IDENTITY_FILES, { value: nativeAuthIdentityFiles('qwen', {}, home) })
  const before = agentVerificationIdentity(agent)
  fs.writeFileSync(filename, 'DASHSCOPE_API_KEY=replacement\n')
  assert.notEqual(agentVerificationIdentity(agent), before)
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

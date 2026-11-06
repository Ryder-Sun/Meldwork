const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { childEnvironment } = require('../../src/agents/cli/cli-process-support.cjs')

const {
  hermesDeclaredCredentialKeys,
  zcodeDeclaredCredentialKeys,
  piDeclaredCredentialKeys,
  nativeCredentialEnvironment,
  nativeCredentialState,
  resolveNativeOpenClawRuntime,
  resolveNativeCredentialState,
  resolveNativeShellEnvironment,
} = require('../../src/agents/local-agent-readiness.cjs')

test('Gemini uses its shell-selected native home for readiness and execution', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-gemini-native-home-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const selected = path.join(home, 'selected')
  const selectedConfig = path.join(selected, '.gemini')
  const defaultConfig = path.join(home, '.gemini')
  fs.mkdirSync(selectedConfig, { recursive: true })
  fs.mkdirSync(defaultConfig, { recursive: true })
  fs.writeFileSync(path.join(defaultConfig, 'oauth_creds.json'), JSON.stringify({ refresh_token: 'default-secret' }))
  const captured = await resolveNativeShellEnvironment({ cache: false, platform: 'win32', env: { GEMINI_CLI_HOME: selected } })
  const native = nativeCredentialEnvironment('gemini', captured.env)
  assert.deepEqual(native, { GEMINI_CLI_HOME: selected })
  assert.equal(nativeCredentialState('gemini', { home, env: native }).state, 'unknown')
  fs.writeFileSync(path.join(selectedConfig, 'oauth_creds.json'), JSON.stringify({ refresh_token: 'selected-secret' }))
  assert.equal(nativeCredentialState('gemini', { home, env: native }).state, 'ready')
  assert.equal(childEnvironment({ kind: 'gemini' }, home, { env: native }, 'darwin').GEMINI_CLI_HOME, selected)
  assert.deepEqual(nativeCredentialEnvironment('codex', captured.env), {})
  assert.equal(nativeCredentialState('gemini', { home, env: { GEMINI_CLI_HOME: 'relative' } }).state, 'unknown')
})

test('OpenCode detects native API credentials in its selected XDG data directory', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-opencode-auth-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const data = path.join(home, 'native-data')
  const dir = path.join(data, 'opencode'); fs.mkdirSync(dir, { recursive: true })
  const auth = path.join(dir, 'auth.json')
  const options = { home, env: { XDG_DATA_HOME: data } }
  fs.writeFileSync(auth, JSON.stringify({ provider: { type: 'api', key: 'synthetic-secret' } }))
  const result = nativeCredentialState('opencode', options)
  assert.deepEqual(result, { state: 'ready', source: 'native-credential' })
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/)
  fs.writeFileSync(auth, JSON.stringify({ provider: { type: 'api', key: '' } }))
  assert.equal(nativeCredentialState('opencode', options).state, 'unknown')
  fs.writeFileSync(auth, JSON.stringify({ provider: { type: 'unrelated', key: 'synthetic-secret' } }))
  assert.equal(nativeCredentialState('opencode', options).state, 'unknown')
  fs.writeFileSync(auth, JSON.stringify({ provider: { type: 'oauth', refresh: 'synthetic-refresh' } }))
  assert.equal(nativeCredentialState('opencode', options).state, 'ready')
})

test('Pi captures only environment references declared by its selected native models configuration', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-pi-declared-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const selected = path.join(home, 'selected')
  fs.mkdirSync(selected)
  fs.writeFileSync(path.join(selected, 'models.json'), JSON.stringify({ providers: {
    custom: { apiKey: '${KEY_PREFIX}_$KEY_SUFFIX', headers: { Authorization: 'Bearer $HEADER_TOKEN',
      Escaped: '$$IGNORED $!ALSO_IGNORED', Command: '!echo $COMMAND_SECRET' },
    models: [{ headers: { 'X-Model': '$MODEL_KEY' } }],
    modelOverrides: { a: { headers: { 'X-Override': '${OVERRIDE_KEY}' } } } },
  } }))
  const keys = piDeclaredCredentialKeys({ home, env: { PI_CODING_AGENT_DIR: selected } })
  assert.deepEqual(keys, ['HEADER_TOKEN', 'KEY_PREFIX', 'KEY_SUFFIX', 'MODEL_KEY', 'OVERRIDE_KEY'])
  const captured = await resolveNativeShellEnvironment({ cache: false, platform: 'win32', extraEnvKeys: keys,
    env: { KEY_PREFIX: 'private', HEADER_TOKEN: 'header-private', UNRELATED_KEY: 'unrelated' } })
  assert.deepEqual(nativeCredentialEnvironment('pi', captured.env, keys), {
    HEADER_TOKEN: 'header-private', KEY_PREFIX: 'private',
  })
  assert.equal(captured.env.UNRELATED_KEY, undefined)
  assert.deepEqual(piDeclaredCredentialKeys({ home, env: {} }), [])
})

test('Pi retains more than 32 environment references from its native models configuration', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-pi-many-keys-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const root = path.join(home, '.pi', 'agent')
  fs.mkdirSync(root, { recursive: true })
  const headers = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`X-Key-${index}`, `$PI_CUSTOM_${index}`]))
  fs.writeFileSync(path.join(root, 'models.json'), JSON.stringify({ providers: { custom: { headers } } }))
  const keys = piDeclaredCredentialKeys({ home, env: {} })
  assert.equal(keys.length, 40)
  assert.ok(keys.includes('PI_CUSTOM_39'))
})

test('Pi model readiness resolves native credential references without running commands or using another provider', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-pi-provider-readiness-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const root = path.join(home, '.pi', 'agent'); fs.mkdirSync(root, { recursive: true })
  const models = path.join(root, 'models.json')
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ defaultProvider: 'selected' }))
  const write = key => fs.writeFileSync(models, JSON.stringify({ providers: {
    selected: { apiKey: key }, other: { apiKey: 'unrelated-secret' },
  } }))
  write('${PREFIX}_$SUFFIX')
  assert.equal(nativeCredentialState('pi', { home, env: { PREFIX: 'prefix' } }).state, 'unknown')
  assert.equal(nativeCredentialState('pi', { home, env: { PREFIX: 'prefix', SUFFIX: 'suffix' } }).state, 'ready')
  write('!touch ' + path.join(home, 'should-not-exist'))
  assert.equal(nativeCredentialState('pi', { home, env: {} }).state, 'unknown')
  assert.equal(fs.existsSync(path.join(home, 'should-not-exist')), false)
  write('$$literal-$!credential')
  assert.equal(nativeCredentialState('pi', { home, env: {} }).state, 'ready')
})

test('Pi authentication readiness checks the selected native provider', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-pi-auth-provider-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const root = path.join(home, '.pi', 'agent'); fs.mkdirSync(root, { recursive: true })
  const settings = path.join(root, 'settings.json')
  fs.writeFileSync(settings, JSON.stringify({ defaultProvider: 'selected' }))
  const auth = path.join(root, 'auth.json')
  fs.writeFileSync(auth, JSON.stringify({ other: { type: 'api_key', key: 'unrelated-secret' } }))
  assert.equal(nativeCredentialState('pi', { home, env: {} }).state, 'unknown')
  assert.equal(nativeCredentialState('pi', { home, env: { OPENAI_API_KEY: 'unrelated-secret' } }).state, 'unknown')
  fs.writeFileSync(auth, JSON.stringify({ other: { type: 'api_key', key: 'unrelated-secret' },
    selected: { type: 'oauth', refresh: 'selected-secret' } }))
  assert.equal(nativeCredentialState('pi', { home, env: {} }).state, 'ready')
  fs.writeFileSync(settings, '{invalid')
  assert.equal(nativeCredentialState('pi', { home, env: {} }).state, 'unknown')
  fs.rmSync(settings)
  assert.equal(nativeCredentialState('pi', { home, env: {} }).state, 'ready')
  fs.rmSync(auth)
  fs.writeFileSync(settings, JSON.stringify({ defaultProvider: 'openai' }))
  assert.equal(nativeCredentialState('pi', { home, env: { ANTHROPIC_API_KEY: 'unrelated-secret' } }).state, 'unknown')
  assert.equal(nativeCredentialState('pi', { home, env: { OPENAI_API_KEY: 'selected-secret' } }).state, 'ready')
})

test('Zcode captures credentials only for configured native models', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-zcode-declared-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const dir = path.join(home, '.zcode', 'cli'); fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    provider: { acme: { name: 'Acme Service', kind: 'openai' }, 'default-beta': {}, unused: {} },
    model: { main: 'acme/model', lite: 'default-beta/model' },
  }))
  const keys = zcodeDeclaredCredentialKeys({ home })
  assert.deepEqual(keys, ['ACME_API_KEY', 'ACME_SERVICE_API_KEY', 'BETA_API_KEY', 'DEFAULT_BETA_API_KEY', 'OPENAI_API_KEY'])
  const result = await resolveNativeShellEnvironment({ cache: false, platform: 'win32', extraEnvKeys: keys,
    env: { ACME_API_KEY: 'test-private', UNUSED_API_KEY: 'not-shared' } })
  assert.deepEqual(nativeCredentialEnvironment('zcode', result.env, keys), { ACME_API_KEY: 'test-private' })
  assert.deepEqual(nativeCredentialEnvironment('codex', result.env), {})
  assert.equal(result.env.UNUSED_API_KEY, undefined)
  fs.writeFileSync(path.join(dir, 'config.json'), '{')
  assert.deepEqual(zcodeDeclaredCredentialKeys({ home }), [])
})

test('Hermes captures only safe credential names declared by its selected YAML config', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-hermes-declared-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const selected = path.join(home, 'selected'); fs.mkdirSync(selected)
  fs.writeFileSync(path.join(selected, 'config.yaml'), [
    'model:', '  provider: another', '  key_env: CUSTOM_CREDENTIAL',
    'fallback_model:', '  - provider: "custom:lower"', '    model: fallback',
    'providers:', '  another:', '    api_key_env: SECOND_VALUE',
    '  unrelated:', '    key_env: UNRELATED_SECRET',
    'custom_providers:', '  - name: invalid', '    key_env: NODE_OPTIONS',
    '  - name: invalid2', '    key_env: PATH', '  - name: invalid3', '    key_env: "X; touch /tmp/bad"',
    '  - name: lower', '    key_env: lower_secret',
  ].join('\n'))
  const keys = hermesDeclaredCredentialKeys({ home, env: { HERMES_HOME: selected } })
  assert.deepEqual(keys, ['ANOTHER_API_KEY', 'CUSTOM_CREDENTIAL', 'SECOND_VALUE', 'lower_secret'])
  assert.deepEqual(hermesDeclaredCredentialKeys({ home, env: {} }), [])
  const result = await resolveNativeShellEnvironment({ cache: false, platform: 'win32', extraEnvKeys: keys,
    env: { Custom_Credential: 'test-private', SECOND_VALUE: 'other-private', LOWER_SECRET: 'lower-private', UNRELATED_SECRET: 'not-shared' } })
  assert.deepEqual(nativeCredentialEnvironment('hermes', result.env, keys), {
    CUSTOM_CREDENTIAL: 'test-private', SECOND_VALUE: 'other-private', lower_secret: 'lower-private',
  })
  assert.deepEqual(nativeCredentialEnvironment('codex', result.env), {})
  assert.equal(result.env.UNRELATED_SECRET, undefined)
})

test('declared Hermes credentials can be read from a login shell without capturing unrelated variables', { skip: process.platform === 'win32' }, async () => {
  const execFile = require('node:util').promisify(require('node:child_process').execFile)
  const result = await resolveNativeShellEnvironment({ cache: false, platform: 'darwin', home: '/tmp/native-home',
    shell: '/bin/sh', env: { PATH: '/usr/bin' }, extraEnvKeys: ['CUSTOM_CREDENTIAL', 'NODE_OPTIONS'],
    execFileFn: (command, args, options) => execFile(command, ['-c', [
      'export CUSTOM_CREDENTIAL=test-private UNRELATED_SECRET=private', args[1],
    ].join('\n')], options),
  })
  assert.equal(result.env.CUSTOM_CREDENTIAL, 'test-private')
  assert.equal(result.env.UNRELATED_SECRET, undefined)
  assert.equal(result.env.NODE_OPTIONS, undefined)
})

test('Hermes declared credentials follow selected and fallback providers, including auto selection', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-hermes-provider-keys-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const root = path.join(home, '.hermes'); fs.mkdirSync(root)
  const file = path.join(root, 'config.yaml')
  const config = [
    'model:', '  provider: first', 'providers:',
    '  first:', '    key_env: FIRST_KEY',
    '  second:', '    name: Second Provider', '    key_env: SECOND_KEY',
    '  disabled:', '    enabled: false', '    key_env: DISABLED_KEY',
    'fallback_model:', '  - provider: "custom:second"', '    model: fallback', '    key_env: FALLBACK_KEY',
  ].join('\n')
  fs.writeFileSync(file, config)
  assert.deepEqual(hermesDeclaredCredentialKeys({ home, env: {} }), ['FALLBACK_KEY', 'FIRST_API_KEY', 'FIRST_KEY', 'SECOND_KEY'])
  fs.writeFileSync(file, config.replace('provider: first', 'provider: auto'))
  assert.deepEqual(hermesDeclaredCredentialKeys({ home, env: {} }), ['FALLBACK_KEY', 'FIRST_KEY', 'SECOND_KEY'])
  fs.writeFileSync(file, config.replace('provider: first', 'provider: absent').replace('  - provider: "custom:second"', '  - provider: absent'))
  assert.deepEqual(hermesDeclaredCredentialKeys({ home, env: {} }), ['ABSENT_API_KEY', 'FALLBACK_KEY'])
})

test('Hermes captures credentials for the native fallback provider chain and legacy fallback', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-hermes-fallback-keys-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const root = path.join(home, '.hermes'); fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, 'config.yaml'), [
    'model:', '  provider: main', '  key_env: MAIN_KEY',
    'fallback_providers:', '  - provider: custom:backup', '    model: backup-model',
    '    key_env: BACKUP_KEY',
    '  - provider: alternate', '    model: alternate-model',
    'fallback_model:', '  provider: legacy', '  model: legacy-model', '  api_key_env: LEGACY_KEY',
    'providers:', '  alternate:', '    api_key_env: ALTERNATE_KEY',
    '  unused:', '    key_env: UNRELATED_SECRET',
  ].join('\n'))
  const keys = hermesDeclaredCredentialKeys({ home, env: {} })
  assert.deepEqual(keys, ['ALTERNATE_API_KEY', 'ALTERNATE_KEY', 'BACKUP_KEY', 'LEGACY_API_KEY', 'LEGACY_KEY', 'MAIN_API_KEY', 'MAIN_KEY'])
  const captured = await resolveNativeShellEnvironment({ cache: false, platform: 'win32', extraEnvKeys: keys,
    env: { BACKUP_KEY: 'backup-private', ALTERNATE_KEY: 'alternate-private',
      LEGACY_KEY: 'legacy-private', UNRELATED_SECRET: 'not-shared' } })
  assert.deepEqual(nativeCredentialEnvironment('hermes', captured.env, keys), {
    ALTERNATE_KEY: 'alternate-private', BACKUP_KEY: 'backup-private', LEGACY_KEY: 'legacy-private',
  })
  assert.equal(captured.env.UNRELATED_SECRET, undefined)
})

test('Hermes receives the selected native provider key without an endpoint override', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-hermes-native-provider-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const root = path.join(home, '.hermes'); fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, 'config.yaml'), 'model:\n  provider: north-star\n  default: native-model\n')
  const keys = hermesDeclaredCredentialKeys({ home, env: {} })
  const captured = await resolveNativeShellEnvironment({ cache: false, platform: 'win32', extraEnvKeys: keys,
    env: { NORTH_STAR_API_KEY: 'native-private', OTHER_API_KEY: 'unrelated' } })
  assert.deepEqual(keys, ['NORTH_STAR_API_KEY'])
  assert.deepEqual(nativeCredentialEnvironment('hermes', captured.env, keys), { NORTH_STAR_API_KEY: 'native-private' })
  assert.equal(captured.env.OTHER_API_KEY, undefined)
})

test('Hermes honors environment-selected native provider when config.yaml is absent', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-hermes-env-provider-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const root = path.join(home, '.hermes'); fs.mkdirSync(root)
  const env = { HERMES_INFERENCE_PROVIDER: 'north-star' }
  assert.deepEqual(hermesDeclaredCredentialKeys({ home, env }), ['NORTH_STAR_API_KEY'])
  fs.writeFileSync(path.join(root, 'config.yaml'), 'model:\n  provider: selected\n')
  assert.deepEqual(hermesDeclaredCredentialKeys({ home, env }), ['SELECTED_API_KEY'])
  fs.writeFileSync(path.join(root, 'config.yaml'), 'model: [invalid')
  assert.deepEqual(hermesDeclaredCredentialKeys({ home, env }), [])
})

test('Hermes selects configured provider credentials for an auto-routed qualified model', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-hermes-qualified-model-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const root = path.join(home, '.hermes'); fs.mkdirSync(root)
  const file = path.join(root, 'config.yaml')
  const config = [
    'model:', '  provider: auto', '  default: backup/model-name',
    'providers:', '  backup:', '    key_env: BACKUP_CREDENTIAL',
    '  other:', '    key_env: UNRELATED_CREDENTIAL',
  ].join('\n')
  fs.writeFileSync(file, config)
  assert.deepEqual(hermesDeclaredCredentialKeys({ home, env: {} }), ['BACKUP_API_KEY', 'BACKUP_CREDENTIAL'])
  fs.writeFileSync(file, config.replace('provider: auto', 'provider: openrouter'))
  assert.deepEqual(hermesDeclaredCredentialKeys({ home, env: {} }), ['OPENROUTER_API_KEY'])
})

test('native environment cache observes credential and proxy changes without a PATH change', async () => {
  const base = { platform: 'win32', home: 'C:\\meldwork-cache-test', env: { PATH: 'C:\\bin',
    ANTHROPIC_API_KEY: 'synthetic-before', HTTPS_PROXY: 'http://before.example:8080' } }
  const before = await resolveNativeShellEnvironment(base)
  const after = await resolveNativeShellEnvironment({ ...base, env: { ...base.env,
    ANTHROPIC_API_KEY: 'synthetic-after', HTTPS_PROXY: '' } })
  assert.equal(before.env.ANTHROPIC_API_KEY, 'synthetic-before')
  assert.equal(after.env.ANTHROPIC_API_KEY, 'synthetic-after')
  assert.equal(after.env.HTTPS_PROXY, '')
  const removed = await resolveNativeShellEnvironment({ ...base, env: { PATH: base.env.PATH } })
  assert.equal(removed.env.ANTHROPIC_API_KEY, undefined)
  assert.equal(removed.env.HTTPS_PROXY, undefined)
})

test('Codex native API key is captured and scoped to Codex', async () => {
  const result = await resolveNativeShellEnvironment({ cache: false, platform: 'win32',
    env: { Codex_Api_Key: 'native-key', UNRELATED_SECRET: 'private' } })
  assert.equal(result.env.CODEX_API_KEY, 'native-key')
  assert.deepEqual(nativeCredentialEnvironment('codex', result.env), { CODEX_API_KEY: 'native-key' })
  assert.deepEqual(nativeCredentialEnvironment('hermes', result.env), {})
  assert.deepEqual(nativeCredentialState('codex', { home: '/nonexistent', env: result.env }), {
    state: 'ready', source: 'native-credential',
  })
  assert.equal(result.env.UNRELATED_SECRET, undefined)
})

test('an OpenAI environment key alone does not prove the default Codex provider is authenticated', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-codex-unverified-key-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const env = { OPENAI_API_KEY: 'custom-provider-key' }
  assert.deepEqual(nativeCredentialState('codex', { home, env }), { state: 'unknown', source: 'unverified' })
  assert.deepEqual(nativeCredentialEnvironment('codex', env), env)
  assert.deepEqual(nativeCredentialState('codex', { home, env: { ...env, CODEX_API_KEY: 'native-key' } }), {
    state: 'ready', source: 'native-credential',
  })
})

test('Codex readiness follows the selected provider env_key, not other accounts', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-codex-selected-key-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const selected = path.join(home, 'selected')
  fs.mkdirSync(selected)
  fs.writeFileSync(path.join(selected, 'config.toml'), "profile = 'work'\nmodel_provider = 'other'\n[profiles.work]\nmodel_provider = 'custom'\n[model_providers.custom]\nenv_key = 'CUSTOM_CREDENTIAL'\n[model_providers.other]\nenv_key = 'OTHER_SECRET'\n")
  fs.writeFileSync(path.join(selected, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'other-account' }))
  const env = { CODEX_HOME: selected, CODEX_API_KEY: 'other-account', OTHER_SECRET: 'other' }
  assert.deepEqual(nativeCredentialState('codex', { home, env }), { state: 'unknown', source: 'unverified' })
  assert.deepEqual(nativeCredentialState('codex', { home, env: { ...env, CUSTOM_CREDENTIAL: ' ' } }), { state: 'unknown', source: 'unverified' })
  assert.deepEqual(nativeCredentialState('codex', { home, env: { ...env, CUSTOM_CREDENTIAL: 'secret' } }), { state: 'ready', source: 'native-credential' })
  fs.writeFileSync(path.join(selected, 'config.toml'), "model_provider = 'custom'\n[model_providers.custom]\nenv_key = 'NODE_OPTIONS'\n")
  assert.deepEqual(nativeCredentialState('codex', { home, env: { ...env, NODE_OPTIONS: 'unsafe' } }), { state: 'unknown', source: 'unverified' })
})

test('Windows native environment canonicalizes allowed keys without leaking unrelated values', async () => {
  const result = await resolveNativeShellEnvironment({ cache: false, platform: 'win32', env: {
    Path: 'C:\\tools', Anthropic_Api_Key: 'native-secret', Claude_Config_Dir: 'C:\\claude',
    Vertex_Region_Claude_Test: 'region', Unrelated_Secret: 'private',
  } })
  assert.equal(result.env.PATH, 'C:\\tools')
  assert.equal(result.env.ANTHROPIC_API_KEY, 'native-secret')
  assert.equal(result.env.CLAUDE_CONFIG_DIR, 'C:\\claude')
  assert.equal(result.env.VERTEX_REGION_CLAUDE_TEST, 'region')
  assert.equal(result.env.UNRELATED_SECRET, undefined)
  assert.deepEqual(nativeCredentialEnvironment('claude', result.env), {
    ANTHROPIC_API_KEY: 'native-secret', CLAUDE_CONFIG_DIR: 'C:\\claude', VERTEX_REGION_CLAUDE_TEST: 'region',
  })
  const preferred = await resolveNativeShellEnvironment({ cache: false, platform: 'win32', env: {
    ANTHROPIC_API_KEY: 'canonical', Anthropic_Api_Key: 'other',
  } })
  assert.equal(preferred.env.ANTHROPIC_API_KEY, 'canonical')
})

test('Zcode native provider settings survive shell capture and readiness detection', async () => {
  const result = await resolveNativeShellEnvironment({ cache: false, platform: 'win32', env: {
    Zcode_Api_Key: 'test-secret', Zcode_Base_Url: 'https://provider.example',
    Anthropic_Base_Url: 'https://anthropic.example', UNRELATED_SECRET: 'private',
  } })
  assert.deepEqual(nativeCredentialEnvironment('zcode', result.env), {
    ZCODE_API_KEY: 'test-secret', ZCODE_BASE_URL: 'https://provider.example',
    ANTHROPIC_BASE_URL: 'https://anthropic.example',
  })
  assert.deepEqual(nativeCredentialState('zcode', { env: result.env, home: '/no-config' }),
    { state: 'ready', source: 'native-credential' })
  assert.equal(result.env.UNRELATED_SECRET, undefined)
})

test('Hermes endpoint settings survive native shell environment capture', async () => {
  const result = await resolveNativeShellEnvironment({ cache: false, platform: 'win32', env: {
    Custom_Base_Url: 'https://custom.example', Openrouter_Base_Url: 'https://router.example',
    Ollama_Host: 'http://localhost:11434', Ollama_Api_Key: 'test-secret', UNRELATED_SECRET: 'private',
  } })
  assert.deepEqual(nativeCredentialEnvironment('hermes', result.env), {
    CUSTOM_BASE_URL: 'https://custom.example', OPENROUTER_BASE_URL: 'https://router.example',
    OLLAMA_HOST: 'http://localhost:11434', OLLAMA_API_KEY: 'test-secret',
  })
  assert.equal(result.env.UNRELATED_SECRET, undefined)
})

test('native shell capture preserves XDG configuration directories without unrelated variables', { skip: process.platform === 'win32' }, async () => {
  const execFile = require('node:util').promisify(require('node:child_process').execFile)
  const result = await resolveNativeShellEnvironment({
    cache: false, platform: 'darwin', home: '/tmp/native-home', shell: '/bin/sh', env: { PATH: '/usr/bin' },
    execFileFn: (command, args, options) => execFile(command, ['-c', [
      'export XDG_CONFIG_HOME=/native/config XDG_DATA_HOME=/native/data XDG_RUNTIME_DIR=',
      'export UNRELATED_SECRET=private', args[1],
    ].join('\n')], options),
  })
  assert.equal(result.env.XDG_CONFIG_HOME, '/native/config')
  assert.equal(result.env.XDG_DATA_HOME, '/native/data')
  assert.equal(result.env.XDG_RUNTIME_DIR, '')
  assert.equal(result.env.UNRELATED_SECRET, undefined)
})

test('explicit refresh replaces cached native shell settings and subsequent calls share the new result', {
  skip: process.platform === 'win32',
}, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-shell-refresh-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const shell = path.join(home, 'sh')
  const settings = path.join(home, 'native-env')
  fs.writeFileSync(shell, '#!/bin/sh\n. "$HOME/native-env"\nexec /bin/sh "$@"\n', { mode: 0o700 })
  fs.writeFileSync(settings, 'export ANTHROPIC_BASE_URL=https://before.example\n', { mode: 0o600 })
  const options = { home, shell, platform: 'linux', env: { PATH: '/usr/bin:/bin' } }
  const first = await resolveNativeShellEnvironment(options)
  assert.equal(first.env.ANTHROPIC_BASE_URL, 'https://before.example')
  fs.writeFileSync(settings, 'export ANTHROPIC_BASE_URL=https://after.example\n', { mode: 0o600 })
  assert.strictEqual(await resolveNativeShellEnvironment(options), first)
  const refreshed = await resolveNativeShellEnvironment({ ...options, refresh: true })
  assert.equal(refreshed.env.ANTHROPIC_BASE_URL, 'https://after.example')
  assert.strictEqual(await resolveNativeShellEnvironment(options), refreshed)
})

test('a login shell that stops answering keeps the last environment it produced instead of the bare app environment', {
  skip: process.platform === 'win32',
}, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-shell-last-good-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const shell = path.join(home, 'sh')
  fs.writeFileSync(
    shell,
    '#!/bin/sh\n[ -f "$HOME/broken" ] && exit 3\n. "$HOME/native-env"\nexec /bin/sh "$@"\n',
    { mode: 0o700 },
  )
  fs.writeFileSync(path.join(home, 'native-env'), [
    'export ANTHROPIC_BASE_URL=https://gateway.example',
    'export PATH="/opt/user/bin:$PATH"',
    '',
  ].join('\n'), { mode: 0o600 })
  const options = { home, shell, platform: 'linux', env: { PATH: '/usr/bin:/bin' } }

  const good = await resolveNativeShellEnvironment(options)
  assert.equal(good.source, 'native-shell')
  assert.equal(good.env.ANTHROPIC_BASE_URL, 'https://gateway.example')

  fs.writeFileSync(path.join(home, 'broken'), '')
  const afterFailure = await resolveNativeShellEnvironment({ ...options, refresh: true })
  assert.equal(afterFailure.source, 'native-shell')
  assert.equal(afterFailure.env.ANTHROPIC_BASE_URL, 'https://gateway.example')
  assert.ok(afterFailure.env.PATH.split(':').includes('/opt/user/bin'))
  assert.deepEqual(Object.keys(afterFailure).sort(), ['env', 'source'])

  // The failure is not remembered: once the shell works again the new
  // settings are picked up on the next explicit refresh.
  fs.rmSync(path.join(home, 'broken'))
  fs.writeFileSync(path.join(home, 'native-env'), 'export ANTHROPIC_BASE_URL=https://other.example\n', { mode: 0o600 })
  const recovered = await resolveNativeShellEnvironment({ ...options, refresh: true })
  assert.equal(recovered.env.ANTHROPIC_BASE_URL, 'https://other.example')
})

test('without any earlier success a failed login shell still falls back to the process environment', {
  skip: process.platform === 'win32',
}, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-shell-first-failure-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const shell = path.join(home, 'sh')
  fs.writeFileSync(shell, '#!/bin/sh\nexit 3\n', { mode: 0o700 })
  const result = await resolveNativeShellEnvironment({
    home, shell, platform: 'linux', env: { PATH: '/usr/bin:/bin', OPENAI_API_KEY: 'from-process' },
  })
  assert.equal(result.source, 'process')
  assert.equal(result.env.OPENAI_API_KEY, 'from-process')
})

function openClawModelsCatalog(apiKey, baseUrl = 'https://provider.example/v1') {
  return JSON.stringify({
    providers: {
      provider: {
        baseUrl,
        api: 'openai-completions',
        apiKey,
        models: [{ id: 'model', name: 'Model', input: ['text'] }],
      },
    },
  })
}

test('native readiness respects custom config roots and the Pi coding agent auth directory', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-native-roots-'))
  const cases = [
    ['pi', {}, path.join(home, '.pi', 'agent', 'auth.json')],
    ['pi', { PI_CODING_AGENT_DIR: path.join(home, 'custom-pi') }, path.join(home, 'custom-pi', 'auth.json')],
    ['hermes', { HERMES_HOME: path.join(home, 'custom-hermes') }, path.join(home, 'custom-hermes', 'auth.json')],
    ['codex', { CODEX_HOME: path.join(home, 'custom-codex') }, path.join(home, 'custom-codex', 'auth.json')],
    ['claude', { CLAUDE_CONFIG_DIR: path.join(home, 'custom-claude') }, path.join(home, 'custom-claude', '.credentials.json')],
    ['opencode', { XDG_DATA_HOME: path.join(home, 'data') }, path.join(home, 'data', 'opencode', 'auth.json')],
  ]
  try {
    for (const [kind, env, filename] of cases) {
      fs.mkdirSync(path.dirname(filename), { recursive: true })
      fs.writeFileSync(filename, JSON.stringify({ provider: kind === 'pi'
        ? { type: 'api_key', key: 'test-only-secret' }
        : { apiKey: 'test-only-secret' } }))
      assert.deepEqual(nativeCredentialState(kind, { home, env }), {
        state: 'ready', source: 'native-credential',
      })
      if (kind !== 'opencode') {
        assert.deepEqual(nativeCredentialEnvironment(kind, env), env)
      }
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('Hermes and Pi readiness do not fall back to unrelated credentials when custom roots are set', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-custom-native-root-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  fs.mkdirSync(path.join(home, '.hermes'), { recursive: true })
  fs.writeFileSync(path.join(home, '.hermes', '.env'), 'OPENAI_API_KEY=default-test-secret\n')
  fs.mkdirSync(path.join(home, '.pi'), { recursive: true })
  fs.writeFileSync(path.join(home, '.pi', 'auth.json'), JSON.stringify({ apiKey: 'default-test-secret' }))
  assert.deepEqual(nativeCredentialState('hermes', { home, env: { HERMES_HOME: '~/custom-hermes' } }), {
    state: 'unknown', source: 'unverified',
  })
  assert.deepEqual(nativeCredentialState('pi', { home, env: { PI_CODING_AGENT_DIR: '~/custom-pi' } }), {
    state: 'unknown', source: 'unverified',
  })
  fs.mkdirSync(path.join(home, 'custom-hermes'))
  fs.writeFileSync(path.join(home, 'custom-hermes', '.env'), 'OPENAI_API_KEY=custom-test-secret\n')
  fs.mkdirSync(path.join(home, 'custom-pi'))
  fs.writeFileSync(path.join(home, 'custom-pi', 'auth.json'), JSON.stringify({ apiKey: 'custom-test-secret' }))
  assert.equal(nativeCredentialState('hermes', { home, env: { HERMES_HOME: '~/custom-hermes' } }).state, 'ready')
  assert.equal(nativeCredentialState('pi', { home, env: { PI_CODING_AGENT_DIR: '~/custom-pi' } }).state, 'ready')
})

test('Hermes readiness follows the native Windows default and configured data suffix', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-hermes-windows-root-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const localAppData = path.join(home, 'Local')
  const directory = path.join(localAppData, 'hermes-test')
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, '.env'), 'OPENAI_API_KEY=synthetic-secret\n')
  const env = { LOCALAPPDATA: localAppData, HERMES_DATA_DIR_SUFFIX: '-test' }
  assert.equal(nativeCredentialState('hermes', { home, env, platform: 'win32' }).state, 'ready')
  assert.equal(nativeCredentialEnvironment('hermes', env).HERMES_DATA_DIR_SUFFIX, '-test')
})

test('Pi native OAuth credentials use access and refresh fields', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-pi-oauth-'))
  const directory = path.join(home, '.pi', 'agent')
  try {
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'auth.json'), JSON.stringify({
      anthropic: { type: 'oauth', access: 'test-access', refresh: 'test-refresh' },
    }))
    assert.deepEqual(nativeCredentialState('pi', { home, env: {} }), {
      state: 'ready', source: 'native-credential',
    })
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('Hermes readiness detects a native credential without returning its value', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-hermes-readiness-'))
  const secret = 'hermes-secret-value'
  fs.mkdirSync(path.join(home, '.hermes'), { recursive: true })
  fs.writeFileSync(path.join(home, '.hermes', '.env'), `OPENAI_API_KEY=${secret}\n`)

  try {
    const result = nativeCredentialState('hermes', { home })
    assert.deepEqual(result, { state: 'ready', source: 'native-credential' })
    assert.equal(JSON.stringify(result).includes(secret), false)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('Hermes readiness ignores a config.yml file that its native CLI does not load', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-hermes-yml-readiness-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const root = path.join(home, '.hermes')
  fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, 'config.yml'), 'api_key: synthetic-secret\n')
  assert.deepEqual(nativeCredentialState('hermes', { home, env: {} }), {
    state: 'unknown', source: 'unverified',
  })
  fs.writeFileSync(path.join(root, 'config.yaml'), 'api_key: synthetic-secret\n')
  assert.deepEqual(nativeCredentialState('hermes', { home, env: {} }), {
    state: 'ready', source: 'native-credential',
  })
})

test('custom Provider config is recognized while unresolved Env references remain unverified', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-custom-provider-readiness-'))
  const config = path.join(home, '.hermes', 'config.yaml')
  fs.mkdirSync(path.dirname(config), { recursive: true })
  try {
    fs.writeFileSync(config, [
      'provider: custom',
      'base_url: https://gateway.example/v1',
      'model: local-model',
      'api_key: sk-custom-provider',
    ].join('\n'))
    assert.deepEqual(nativeCredentialState('hermes', { home, env: {} }), {
      state: 'ready', source: 'native-credential',
    })

    fs.writeFileSync(config, 'api_key: ${OPENROUTER_API_KEY}\n')
    assert.deepEqual(nativeCredentialState('hermes', { home, env: {} }), {
      state: 'unknown', source: 'unverified',
    })
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('placeholder scalar values are not treated as native credentials', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-placeholder-credential-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const root = path.join(home, '.hermes')
  fs.mkdirSync(root)
  for (const value of ['null', 'None', 'undefined', 'false', 'true', '~']) {
    fs.writeFileSync(path.join(root, 'config.yaml'), `api_key: ${value}\n`)
    assert.equal(nativeCredentialState('hermes', { home, env: {} }).state, 'unknown', value)
    fs.writeFileSync(path.join(root, 'auth.json'), JSON.stringify({ api_key: value }))
    assert.equal(nativeCredentialState('hermes', { home, env: {} }).state, 'unknown', value)
    fs.rmSync(path.join(root, 'auth.json'))
  }
  fs.writeFileSync(path.join(root, 'config.yaml'), 'api_key: null # not configured\n')
  assert.equal(nativeCredentialState('hermes', { home, env: {} }).state, 'unknown')
  fs.writeFileSync(path.join(root, 'config.yaml'), 'api_key: synthetic-secret\n')
  assert.equal(nativeCredentialState('hermes', { home, env: {} }).state, 'ready')
})

test('login shell discovery returns only allowlisted Agent Provider values', async () => {
  const calls = []
  const result = await resolveNativeShellEnvironment({
    cache: false,
    platform: 'darwin',
    home: '/Users/Ryder',
    shell: '/bin/zsh',
    env: {
      PATH: '/usr/bin',
      GITHUB_TOKEN: 'ambient-secret',
      MELDWORK_PRIVATE_VALUE: 'desktop-private-value',
    },
    execFileFn: async (command, args, options) => {
      calls.push({ command, args, options })
      return {
        stdout: [
          'shell startup banner\n__MELDWORK_NATIVE_ENV_V1__',
          'PATH=/opt/custom/bin:/usr/bin',
          'OPENROUTER_API_KEY=openrouter-secret',
          'OPENAI_BASE_URL=https://openrouter.ai/api/v1',
          'OPENAI_MODEL=openrouter/model',
          'GITHUB_TOKEN=must-not-be-read',
          '',
        ].join('\u0000'),
      }
    },
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, '/bin/zsh')
  assert.equal(calls[0].args[0], '-lic')
  assert.equal(calls[0].options.env.GITHUB_TOKEN, undefined)
  assert.equal(calls[0].options.env.MELDWORK_PRIVATE_VALUE, undefined)
  assert.equal(calls[0].args[1].includes('ambient-secret'), false)
  assert.deepEqual(result, {
    source: 'native-shell',
    env: {
      PATH: '/opt/custom/bin:/usr/bin',
      OPENROUTER_API_KEY: 'openrouter-secret',
      OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
      OPENAI_MODEL: 'openrouter/model',
    },
  })
})

test('shell discovery failure falls back to allowlisted process Provider values', async () => {
  const result = await resolveNativeShellEnvironment({
    cache: false,
    platform: 'darwin',
    shell: '/bin/zsh',
    env: {
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'process-provider-key',
      OPENAI_BASE_URL: 'https://gateway.example/v1',
      MELDWORK_PRIVATE_VALUE: 'desktop-private-value',
    },
    execFileFn: async () => { throw new Error('shell unavailable') },
  })

  assert.deepEqual(result, {
    source: 'process',
    env: {
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'process-provider-key',
      OPENAI_BASE_URL: 'https://gateway.example/v1',
    },
  })
})

test('OpenRouter credentials loaded from the native shell mark Hermes ready', async () => {
  const result = await resolveNativeCredentialState('hermes', {
    env: {
      OPENROUTER_API_KEY: 'openrouter-key',
      OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
      OPENAI_MODEL: 'openrouter/model',
    },
    credentialSource: 'native-shell',
  })

  assert.deepEqual(result, { state: 'ready', source: 'native-shell' })
})

test('WorkBuddy readiness requires a selected model and never exposes configured keys', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-workbuddy-readiness-'))
  const secret = 'workbuddy-secret-value'
  fs.mkdirSync(path.join(home, '.workbuddy'), { recursive: true })
  fs.writeFileSync(path.join(home, '.workbuddy', 'models.json'), JSON.stringify([
    { id: 'glm', apiKey: secret, url: 'https://model.example/v1', supportsToolCall: true },
  ]))

  try {
    assert.deepEqual(nativeCredentialState('workbuddy', { home, env: {} }), { state: 'unknown', source: 'unverified' })
    const result = nativeCredentialState('workbuddy', { home, env: {}, modelId: 'glm' })
    assert.deepEqual(result, { state: 'ready', source: 'native-credential' })
    assert.equal(JSON.stringify(result).includes(secret), false)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('native readiness recognizes credential files for every supported CLI', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-native-readiness-'))
  const fixtures = [
    ['codex', ['.codex', 'auth.json'], { tokens: { access_token: 'codex-secret' } }],
    ['hermes', ['.hermes', 'auth.json'], { access_token: 'hermes-secret' }],
    ['openclaw', ['.openclaw', 'openclaw.json'], { gateway: { auth: { token: 'claw-secret' } } }],
    ['pi', ['.pi', 'auth.json'], { access_token: 'pi-secret' }],
    ['kimi', ['.kimi-code', 'credentials', 'kimi-code.json'], { refresh_token: 'kimi-secret' }],
    ['claude', ['.claude', '.credentials.json'], { oauth: { accessToken: 'claude-secret' } }],
    ['qwen', ['.qwen', 'oauth_creds.json'], { access_token: 'qwen-secret' }],
    ['gemini', ['.gemini', 'oauth_creds.json'], { refresh_token: 'gemini-secret' }],
    ['opencode', ['.local', 'share', 'opencode', 'auth.json'], { openai: { token: 'opencode-secret' } }],
    ['opencodereview', ['.opencodereview', 'config.json'], { llm: { auth_token: 'ocr-secret' } }],
  ]
  try {
    for (const [, segments, value] of fixtures) {
      const filename = path.join(home, ...segments)
      fs.mkdirSync(path.dirname(filename), { recursive: true })
      fs.writeFileSync(filename, JSON.stringify(value))
    }
    for (const [kind] of fixtures) {
      assert.deepEqual(nativeCredentialState(kind, { home, env: {} }), {
        state: 'ready', source: 'native-credential',
      })
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('Claude readiness uses the official auth status without exposing OAuth data', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-claude-readiness-'))
  const calls = []
  try {
    const result = await resolveNativeCredentialState('claude', {
      home,
      env: { PATH: '/usr/bin', XDG_RUNTIME_DIR: '/native/runtime', XDG_CACHE_HOME: '', MELDWORK_PRIVATE_VALUE: 'desktop-private-value' },
      executable: '/tmp/claude',
      execFileFn: async (command, args, options) => {
        calls.push({ command, args, env: options.env })
        return { stdout: JSON.stringify({ loggedIn: true, authMethod: 'oauth_token' }) }
      },
    })

    assert.deepEqual(result, { state: 'ready', source: 'native-auth-status' })
    assert.deepEqual(calls[0].args, ['auth', 'status', '--json'])
    assert.equal(calls[0].env.XDG_RUNTIME_DIR, '/native/runtime')
    assert.equal(calls[0].env.XDG_CACHE_HOME, '')
    assert.equal(calls[0].env.MELDWORK_PRIVATE_VALUE, undefined)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('OpenClaw readiness uses the official model status when auth is stored outside its config', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-openclaw-readiness-'))
  const agentDir = path.join(home, '.openclaw', 'agents', 'main', 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      provider: {
        baseUrl: 'https://provider.example/v1',
        api: 'openai-completions',
        apiKey: 'native-openclaw-secret',
        models: [{ id: 'model', name: 'Model', input: ['text'] }],
      },
    },
  }))
  const calls = []
  try {
    const result = await resolveNativeCredentialState('openclaw', {
      home,
      env: { PATH: '/usr/bin', MELDWORK_PRIVATE_VALUE: 'desktop-private-value' },
      executable: '/tmp/openclaw',
      execFileFn: async (command, args, options) => {
        calls.push({ command, args, env: options.env })
        return {
          stdout: JSON.stringify({
            defaultModel: 'provider/model',
            resolvedDefault: 'provider/model',
            agentDir,
            auth: { missingProvidersInUse: [], unusableProfiles: ['unused-expired-profile'] },
          }),
        }
      },
    })

    assert.deepEqual(result, { state: 'ready', source: 'native-auth-status' })
    assert.deepEqual(calls[0].args, ['models', 'status', '--check', '--json'])
    assert.equal(calls[0].env.MELDWORK_PRIVATE_VALUE, undefined)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('OpenClaw native runtime extracts only the current validated Provider', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-openclaw-runtime-status-'))
  const agentDir = path.join(home, '.openclaw', 'agents', 'main', 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const secret = 'native-openclaw-secret'
  const calls = []
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      provider: {
        baseUrl: 'https://provider.example/v1/',
        api: 'openai-completions',
        apiKey: secret,
        headers: { Authorization: 'must-not-copy' },
        tools: { allow: ['exec'] },
        models: [
          { id: 'other', name: 'Other' },
          {
            id: 'model-v1',
            name: 'Model V1',
            input: ['text'],
            contextWindow: 128000,
            maxTokens: 4096,
            reasoning: false,
            cost: { input: 0, output: 0, unsafe: 1 },
            params: { unsafe: true },
          },
        ],
      },
    },
  }))

  const runtime = await resolveNativeOpenClawRuntime({
    home,
    env: {},
    executable: '/tmp/openclaw',
    execFileFn: async (_command, args, options) => {
      calls.push({ args, env: options.env })
      return { stdout: JSON.stringify({
        resolvedDefault: 'provider/model-v1',
        agentDir,
        auth: { missingProvidersInUse: [], profiles: [{ token: 'ignored' }] },
      }) }
    },
  })

  assert.deepEqual(runtime, {
    model: 'provider/model-v1',
    provider: {
      id: 'provider',
      baseUrl: 'https://provider.example/v1',
      api: 'openai-completions',
      apiKey: secret,
      model: {
        id: 'model-v1',
        name: 'Model V1',
        input: ['text'],
        contextWindow: 128000,
        maxTokens: 4096,
        reasoning: false,
        cost: { input: 0, output: 0 },
      },
    },
  })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args, ['models', 'status', '--check', '--json'])
  assert.equal(Object.hasOwn(runtime, 'auth'), false)
  assert.equal(Object.hasOwn(runtime, 'agentDir'), false)
  assert.equal(Object.hasOwn(runtime.provider, 'headers'), false)
  assert.equal(Object.hasOwn(runtime.provider.model, 'params'), false)
})

test('OpenClaw native runtime resolves allowlisted Env SecretRefs from the shell environment', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-openclaw-env-runtime-'))
  const agentDir = path.join(home, '.openclaw', 'agents', 'main', 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, 'models.json'), openClawModelsCatalog({
    source: 'env', provider: 'default', id: 'OPENROUTER_API_KEY',
  }, 'https://openrouter.ai/api/v1'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))

  const runtime = await resolveNativeOpenClawRuntime({
    home,
    env: { OPENROUTER_API_KEY: 'openrouter-native-key' },
    executable: '/tmp/openclaw',
    execFileFn: async () => ({ stdout: JSON.stringify({
      resolvedDefault: 'provider/model', agentDir,
      auth: { missingProvidersInUse: [] },
    }) }),
  })

  assert.equal(runtime.provider.apiKey, 'openrouter-native-key')
  assert.equal(JSON.stringify(runtime).includes('OPENROUTER_API_KEY'), false)
})

test('OpenClaw native runtime rejects Env SecretRefs without reading unrelated process secrets', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-openclaw-runtime-env-'))
  const agentDir = path.join(home, '.openclaw', 'agents', 'main', 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      provider: {
        baseUrl: 'https://attacker.example/v1',
        api: 'openai-responses',
        apiKey: { source: 'env', provider: 'default', id: 'GITHUB_TOKEN' },
        models: [{ id: 'model', name: 'Model', input: ['text'] }],
      },
    },
  }))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const calls = []
  await assert.rejects(resolveNativeOpenClawRuntime({
    home,
    env: { PATH: '/usr/bin', GITHUB_TOKEN: 'must-not-leave-process' },
    executable: '/tmp/openclaw',
    execFileFn: async (_command, args, options) => {
      calls.push({ args, env: options.env })
      return { stdout: JSON.stringify({
        resolvedDefault: 'provider/model', agentDir,
        auth: { missingProvidersInUse: [] },
      }) }
    },
  }), { message: 'OPENCLAW_NATIVE_RUNTIME_UNAVAILABLE' })

  assert.equal(calls[0].env.GITHUB_TOKEN, undefined)
})

test('OpenClaw native runtime rejects every structured and string SecretRef marker', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-openclaw-secretrefs-'))
  const agentDir = path.join(home, '.openclaw', 'agents', 'main', 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const refs = [
    { source: 'env', provider: 'default', id: 'GITHUB_TOKEN' },
    { source: 'file', provider: 'default', id: '/tmp/secret' },
    { source: 'exec', provider: 'default', id: 'secret-command' },
    { source: 'env', id: 'GITHUB_TOKEN' },
    '$GITHUB_TOKEN',
    '${GITHUB_TOKEN}',
    'secretref-env:GITHUB_TOKEN',
    '__env__:GITHUB_TOKEN',
    'secretref-managed',
    'GITHUB_TOKEN',
    'AWS_PROFILE',
    'oauth:github',
    'custom-local',
    'gcp-vertex-credentials',
  ]

  for (const apiKey of refs) {
    fs.writeFileSync(path.join(agentDir, 'models.json'), openClawModelsCatalog(apiKey))
    await assert.rejects(resolveNativeOpenClawRuntime({
      home,
      env: {
        PATH: '/usr/bin',
        GITHUB_TOKEN: 'must-not-leave-process',
        AWS_PROFILE: 'must-not-leave-process',
      },
      executable: '/tmp/openclaw',
      execFileFn: async (_command, _args, options) => {
        assert.equal(options.env.GITHUB_TOKEN, undefined)
        assert.equal(options.env.AWS_PROFILE, undefined)
        return { stdout: JSON.stringify({
          resolvedDefault: 'provider/model', agentDir,
          auth: { missingProvidersInUse: [] },
        }) }
      },
    }), { message: 'OPENCLAW_NATIVE_RUNTIME_UNAVAILABLE' })
  }
})

test('OpenClaw native runtime rejects ancestor path changes while reading models', {
  skip: process.platform === 'win32',
}, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-openclaw-model-path-'))
  const agentDir = path.join(home, '.openclaw', 'agents', 'main', 'agent')
  const external = path.join(home, 'external-agent')
  fs.mkdirSync(agentDir, { recursive: true })
  fs.mkdirSync(external)
  fs.writeFileSync(path.join(agentDir, 'models.json'), openClawModelsCatalog('inside-key'))
  fs.writeFileSync(path.join(external, 'models.json'), openClawModelsCatalog('outside-key'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))

  const canonicalAgentDir = fs.realpathSync(agentDir)
  const modelsPath = path.join(canonicalAgentDir, 'models.json')
  const originalLstat = fs.lstatSync
  let redirected = false
  fs.lstatSync = function guardedLstat(filename, ...args) {
    const stat = originalLstat.call(this, filename, ...args)
    if (!redirected && String(filename) === modelsPath) {
      redirected = true
      fs.renameSync(agentDir, `${agentDir}.original`)
      fs.symlinkSync(external, agentDir, 'dir')
    }
    return stat
  }

  try {
    await assert.rejects(resolveNativeOpenClawRuntime({
      home,
      env: {},
      executable: '/tmp/openclaw',
      execFileFn: async () => ({ stdout: JSON.stringify({
        resolvedDefault: 'provider/model', agentDir,
        auth: { missingProvidersInUse: [] },
      }) }),
    }), { message: 'OPENCLAW_NATIVE_RUNTIME_UNAVAILABLE' })
  } finally {
    fs.lstatSync = originalLstat
  }
})

test('OpenClaw native runtime rejects models file identity changes after opening', {
  skip: process.platform === 'win32',
}, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-openclaw-model-inode-'))
  const agentDir = path.join(home, '.openclaw', 'agents', 'main', 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, 'models.json'), openClawModelsCatalog('inside-key'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))

  const modelsPath = path.join(fs.realpathSync(agentDir), 'models.json')
  const originalOpen = fs.openSync
  let replaced = false
  fs.openSync = function guardedOpen(filename, ...args) {
    const descriptor = originalOpen.call(this, filename, ...args)
    if (!replaced && String(filename) === modelsPath) {
      replaced = true
      fs.renameSync(modelsPath, `${modelsPath}.original`)
      fs.writeFileSync(modelsPath, openClawModelsCatalog('replacement-key'))
    }
    return descriptor
  }

  try {
    await assert.rejects(resolveNativeOpenClawRuntime({
      home,
      env: {},
      executable: '/tmp/openclaw',
      execFileFn: async () => ({ stdout: JSON.stringify({
        resolvedDefault: 'provider/model', agentDir,
        auth: { missingProvidersInUse: [] },
      }) }),
    }), { message: 'OPENCLAW_NATIVE_RUNTIME_UNAVAILABLE' })
  } finally {
    fs.openSync = originalOpen
  }
})

test('OpenClaw native runtime rejects in-place models changes while reading', {
  skip: process.platform === 'win32',
}, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-openclaw-model-content-'))
  const agentDir = path.join(home, '.openclaw', 'agents', 'main', 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, 'models.json'), openClawModelsCatalog('inside-key'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))

  const modelsPath = path.join(fs.realpathSync(agentDir), 'models.json')
  const originalReadFile = fs.readFileSync
  const originalIdentity = fs.statSync(modelsPath).ino
  let modified = false
  fs.readFileSync = function guardedReadFile(filename, ...args) {
    const contents = originalReadFile.call(this, filename, ...args)
    if (!modified && typeof filename === 'number') {
      modified = true
      fs.writeFileSync(modelsPath, openClawModelsCatalog('edited-key'))
      assert.equal(fs.statSync(modelsPath).ino, originalIdentity)
    }
    return contents
  }

  try {
    await assert.rejects(resolveNativeOpenClawRuntime({
      home,
      env: {},
      executable: '/tmp/openclaw',
      execFileFn: async () => ({ stdout: JSON.stringify({
        resolvedDefault: 'provider/model', agentDir,
        auth: { missingProvidersInUse: [] },
      }) }),
    }), { message: 'OPENCLAW_NATIVE_RUNTIME_UNAVAILABLE' })
  } finally {
    fs.readFileSync = originalReadFile
  }
})

test('OpenClaw native runtime rejects unsafe status and Provider descriptors', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-openclaw-runtime-invalid-'))
  const agentDir = path.join(home, '.openclaw', 'agents', 'main', 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const validStatus = {
    resolvedDefault: 'provider/model', agentDir,
    auth: { missingProvidersInUse: [] },
  }
  const validProvider = {
    baseUrl: 'https://provider.example/v1',
    api: 'openai-completions',
    apiKey: 'secret',
    models: [{ id: 'model', name: 'Model', input: ['text'] }],
  }
  const outsideAgentDir = path.join(home, 'outside-agent')
  fs.mkdirSync(outsideAgentDir)
  fs.writeFileSync(path.join(outsideAgentDir, 'models.json'), JSON.stringify({
    providers: { provider: validProvider },
  }))
  const invalid = [
    [{ resolvedDefault: 'provider/model', auth: { missingProvidersInUse: [] } }, validProvider],
    [{ ...validStatus, agentDir: 'relative' }, validProvider],
    [{ ...validStatus, resolvedDefault: 'provider.id/model' }, validProvider],
    [{ ...validStatus, agentDir: path.join(home, 'missing') }, validProvider],
    [{ ...validStatus, agentDir: outsideAgentDir }, validProvider],
    [validStatus, { ...validProvider, baseUrl: 'http://provider.example/v1' }],
    [validStatus, { ...validProvider, api: 'unknown-api' }],
    [validStatus, { ...validProvider, apiKey: '' }],
    [validStatus, { ...validProvider, models: [{ id: 'other', name: 'Other', input: ['text'] }] }],
    [validStatus, {
      ...validProvider,
      apiKey: { source: 'file', provider: 'default', id: '/tmp/secret' },
    }],
  ]

  assert.deepEqual(await resolveNativeCredentialState('openclaw', {
    home, env: {}, executable: '/tmp/openclaw',
    execFileFn: async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) },
  }), { state: 'unknown', source: 'native-probe-failed' })

  for (const [status, provider] of invalid) {
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
      providers: { provider },
    }))
    await assert.rejects(
      resolveNativeOpenClawRuntime({
        home,
        env: {},
        executable: '/tmp/openclaw',
        execFileFn: async () => ({ stdout: JSON.stringify(status) }),
      }),
      { message: 'OPENCLAW_NATIVE_RUNTIME_UNAVAILABLE' },
    )
    assert.deepEqual(await resolveNativeCredentialState('openclaw', {
      home,
      env: {},
      executable: '/tmp/openclaw',
      execFileFn: async () => ({ stdout: JSON.stringify(status) }),
    }), {
      state: 'unknown', source: 'native-runtime-unavailable',
    })
  }

  if (process.platform !== 'win32') {
    const outsideModels = path.join(home, 'outside-models.json')
    fs.writeFileSync(outsideModels, JSON.stringify({ providers: { provider: validProvider } }))
    fs.rmSync(path.join(agentDir, 'models.json'), { force: true })
    fs.symlinkSync(outsideModels, path.join(agentDir, 'models.json'))
    await assert.rejects(resolveNativeOpenClawRuntime({
      home,
      env: {},
      executable: '/tmp/openclaw',
      execFileFn: async () => ({ stdout: JSON.stringify(validStatus) }),
    }), { message: 'OPENCLAW_NATIVE_RUNTIME_UNAVAILABLE' })
  }
})

test('OpenClaw model status overrides a stale gateway token without exposing auth details', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-openclaw-stale-auth-'))
  const configPath = path.join(home, '.openclaw', 'openclaw.json')
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify({ gateway: { auth: { token: 'gateway-only-token' } } }))
  try {
    const error = Object.assign(new Error('missing provider auth'), {
      stdout: JSON.stringify({
        defaultModel: 'provider/model',
        resolvedDefault: 'provider/model',
        auth: { missingProvidersInUse: ['provider'], unusableProfiles: [] },
      }),
    })
    const result = await resolveNativeCredentialState('openclaw', {
      home,
      env: {},
      executable: '/tmp/openclaw',
      execFileFn: async () => { throw error },
    })

    assert.deepEqual(result, { state: 'missing', source: 'native-auth-status' })
    assert.equal(JSON.stringify(result).includes('gateway-only-token'), false)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('MiMo readiness uses the installed CLI identity without forwarding private values', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-mimo-auth-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const calls = []
  for (const stdout of [
    '\u001b[32mProvider: MiMo\u001b[0m\nUser ID: user-123',
    'Provider: MiMo\nType: OAuth',
  ]) {
    const result = await resolveNativeCredentialState('mimo', {
      home,
      env: { PATH: '/usr/bin', MELDWORK_PRIVATE_VALUE: 'desktop-private-value' },
      executable: '/tmp/mimo',
      execFileFn: async (command, args, options) => {
        calls.push({ command, args, env: options.env })
        return { stdout }
      },
    })

    assert.deepEqual(result, { state: 'ready', source: 'native-auth-status' })
  }
  assert.deepEqual(calls.map(call => call.args), [
    ['providers', 'whoami'],
    ['providers', 'whoami'],
  ])
  assert.equal(calls.every(call => call.env.MELDWORK_PRIVATE_VALUE === undefined), true)
})

test('MiMo readiness recognizes ANSI-colored logged-out output even when the CLI exits zero', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-mimo-auth-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const result = await resolveNativeCredentialState('mimo', {
    home,
    env: {},
    executable: '/tmp/mimo',
    execFileFn: async () => ({
      stdout: '\u001b[0m\n\u001b[31mNot logged in. Run `mimo auth login` to log in.\u001b[0m',
    }),
  })

  assert.deepEqual(result, { state: 'missing', source: 'native-auth-status' })
})

test('MiMo readiness remains unknown for missing or malformed identity output', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-mimo-auth-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  assert.deepEqual(await resolveNativeCredentialState('mimo', { home, env: {} }), {
    state: 'unknown', source: 'unverified',
  })

  for (const stdout of [
    '',
    'Provider: MiMo\nUser ID:',
    'Provider: Other\nUser ID: user-123',
    'User ID: user-123',
    'Authentication status unavailable',
  ]) {
    const result = await resolveNativeCredentialState('mimo', {
      home,
      env: {},
      executable: '/tmp/mimo',
      execFileFn: async () => ({ stdout }),
    })
    assert.deepEqual(result, { state: 'unknown', source: 'unverified' })
  }
})

test('Claude auth status overrides a stale credential file', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-claude-stale-auth-'))
  const credentialPath = path.join(home, '.claude', '.credentials.json')
  fs.mkdirSync(path.dirname(credentialPath), { recursive: true })
  fs.writeFileSync(credentialPath, JSON.stringify({ oauth: { accessToken: 'expired-token' } }))
  let calls = 0
  try {
    const result = await resolveNativeCredentialState('claude', {
      home,
      env: {},
      executable: '/tmp/claude',
      execFileFn: async () => {
        calls += 1
        return { stdout: JSON.stringify({ loggedIn: false }) }
      },
    })

    assert.deepEqual(result, { state: 'missing', source: 'native-auth-status' })
    assert.equal(calls, 1)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('Claude probes native auth with cloud configuration even when a direct API key exists', async () => {
  let calls = 0
  const env = {
    ANTHROPIC_API_KEY: 'unused-direct-key', CLAUDE_CODE_USE_BEDROCK: '1',
    AWS_PROFILE: 'native-profile', AWS_REGION: 'us-east-1',
    AWS_SESSION_TOKEN: 'native-session-token', GITHUB_TOKEN: 'unrelated-secret',
  }
  const result = await resolveNativeCredentialState('claude', {
    env, executable: '/tmp/claude',
    execFileFn: async (command, args, options) => {
      calls += 1
      assert.deepEqual(args, ['auth', 'status', '--json'])
      assert.equal(options.env.AWS_PROFILE, env.AWS_PROFILE)
      assert.equal(options.env.AWS_SESSION_TOKEN, env.AWS_SESSION_TOKEN)
      assert.equal(options.env.CLAUDE_CODE_USE_BEDROCK, '1')
      assert.equal(options.env.GITHUB_TOKEN, undefined)
      return { stdout: JSON.stringify({ loggedIn: false }) }
    },
  })
  assert.equal(calls, 1)
  assert.deepEqual(result, { state: 'missing', source: 'native-auth-status' })
})

test('Claude API key status remains configuration evidence rather than verified authentication', async () => {
  const result = await resolveNativeCredentialState('claude', {
    env: { ANTHROPIC_API_KEY: 'unverified-api-key' }, executable: '/tmp/claude',
    execFileFn: async () => ({ stdout: JSON.stringify({ loggedIn: true, authMethod: 'api_key' }) }),
  })
  assert.deepEqual(result, { state: 'ready', source: 'native-credential' })
})

test('Claude cloud provider recognition alone does not verify SDK credentials', async () => {
  for (const apiProvider of ['bedrock', 'vertex', 'foundry']) {
    const result = await resolveNativeCredentialState('claude', {
      env: { ANTHROPIC_API_KEY: 'unused-direct-key' }, executable: '/tmp/claude',
      execFileFn: async () => ({ stdout: JSON.stringify({
        loggedIn: true, authMethod: 'third_party', apiProvider,
      }) }),
    })
    assert.deepEqual(result, { state: 'unknown', source: 'unverified' })
  }
})

test('real shell extraction preserves explicit empty cloud and credential overrides', {
  skip: process.platform === 'win32',
}, async () => {
  const execFile = require('node:util').promisify(require('node:child_process').execFile)
  const result = await resolveNativeShellEnvironment({
    cache: false, platform: 'linux', shell: '/bin/sh',
    env: { AWS_PROFILE: 'stale-profile', ANTHROPIC_API_KEY: 'stale-key', PATH: '/usr/bin:/bin' },
    execFileFn: (command, args, options) => execFile(command, ['-c',
      "export AWS_PROFILE='' ANTHROPIC_API_KEY='' CLAUDE_CODE_USE_BEDROCK='0'\n" + args[1],
    ], options),
  })
  assert.equal(result.source, 'native-shell')
  assert.equal(result.env.AWS_PROFILE, '')
  assert.equal(result.env.ANTHROPIC_API_KEY, '')
  assert.equal(result.env.CLAUDE_CODE_USE_BEDROCK, '0')
  assert.deepEqual(nativeCredentialEnvironment('claude', result.env), {
    AWS_PROFILE: '', ANTHROPIC_API_KEY: '', CLAUDE_CODE_USE_BEDROCK: '0',
  })
  const fallback = await resolveNativeShellEnvironment({
    cache: false, platform: 'win32', env: { AWS_PROFILE: '', ANTHROPIC_API_KEY: '' },
  })
  assert.equal(fallback.env.AWS_PROFILE, '')
  assert.equal(fallback.env.ANTHROPIC_API_KEY, '')
})

test('real shell unsets remove inherited native credentials without exposing unrelated secrets', {
  skip: process.platform === 'win32',
}, async () => {
  const execFile = require('node:util').promisify(require('node:child_process').execFile)
  const result = await resolveNativeShellEnvironment({
    cache: false, platform: 'linux', shell: '/bin/sh',
    env: { AWS_PROFILE: 'stale-profile', ANTHROPIC_API_KEY: 'stale-key',
      VERTEX_REGION_MODEL: 'stale-region', GITHUB_TOKEN: 'unrelated', PATH: '/usr/bin:/bin' },
    execFileFn: (command, args, options) => {
      assert.equal(options.env.GITHUB_TOKEN, undefined)
      return execFile(command, ['-c', 'unset AWS_PROFILE ANTHROPIC_API_KEY VERTEX_REGION_MODEL\n' + args[1]], options)
    },
  })
  for (const key of ['AWS_PROFILE', 'ANTHROPIC_API_KEY', 'VERTEX_REGION_MODEL']) {
    assert.equal(Object.hasOwn(result.env, key), false)
    assert.ok(result.unsetKeys.includes(key))
  }
})

test('model-specific Vertex regions participate in cache identity and stay scoped to the native Agent', async () => {
  const key = 'VERTEX_REGION_CLAUDE_FUTURE_MODEL'
  const base = { platform: 'win32', home: 'C:\\vertex-region-test', env: { PATH: 'C:\\bin', [key]: 'us-east5' } }
  const before = await resolveNativeShellEnvironment(base)
  const after = await resolveNativeShellEnvironment({ ...base, env: { ...base.env, [key]: '' } })
  assert.equal(before.env[key], 'us-east5')
  assert.equal(after.env[key], '')
  assert.deepEqual(nativeCredentialEnvironment('claude', after.env), { [key]: '' })
  assert.deepEqual(nativeCredentialEnvironment('gemini', before.env), {})
  assert.deepEqual(nativeCredentialEnvironment('codex', before.env), {})
  const removed = await resolveNativeShellEnvironment({ ...base, env: { PATH: base.env.PATH } })
  assert.equal(removed.env[key], undefined)
  assert.deepEqual(nativeCredentialEnvironment('claude', {
    VERTEX_REGION_: 'empty-model', VERTEX_REGION_lowercase: 'invalid',
    'VERTEX_REGION_MODEL;bad': 'invalid', NODE_OPTIONS: '--require untrusted',
  }), {})
})

for (const shell of ['/bin/sh', '/bin/bash', '/bin/zsh']) {
  test(`native shell ${shell} extracts exported dynamic regions without unrelated values or value evaluation`, {
    skip: process.platform === 'win32' || !fs.existsSync(shell),
  }, async t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-region-'))
    t.after(() => fs.rmSync(home, { recursive: true, force: true }))
    const execFile = require('node:util').promisify(require('node:child_process').execFile)
    let output = ''
    const resolved = await resolveNativeShellEnvironment({
      cache: false, home, shell, env: { PATH: '/usr/bin:/bin' },
      execFileFn: async (command, args, options) => {
        const result = await execFile(command, ['-c', [
          "export VERTEX_REGION_CLAUDE_FUTURE_MODEL=us-east5",
          "export VERTEX_REGION_CLAUDE_EMPTY=''",
          "export VERTEX_REGION_LITERAL='$(touch should-not-exist)'",
          "export MELDWORK_UNRELATED='synthetic-unrelated-secret'",
          "export NODE_OPTIONS='--require /nonexistent/untrusted-module.cjs'",
          args[1],
        ].join('\n')], { ...options, cwd: home })
        output = result.stdout
        return result
      },
    })
    assert.equal(resolved.source, 'native-shell')
    assert.equal(resolved.env.VERTEX_REGION_CLAUDE_FUTURE_MODEL, 'us-east5')
    assert.equal(resolved.env.VERTEX_REGION_CLAUDE_EMPTY, '')
    assert.equal(resolved.env.VERTEX_REGION_LITERAL, '$(touch should-not-exist)')
    assert.equal(resolved.env.MELDWORK_UNRELATED, undefined)
    assert.equal(resolved.env.NODE_OPTIONS, undefined)
    assert.equal(output.includes('synthetic-unrelated-secret'), false)
    assert.equal(fs.existsSync(path.join(home, 'should-not-exist')), false)
  })
}

test('native cloud configuration is forwarded only to compatible Agents', () => {
  const cloud = {
    CLAUDE_CODE_USE_VERTEX: '1', AWS_PROFILE: 'native', AWS_ACCESS_KEY_ID: 'access-key',
    AWS_SECRET_ACCESS_KEY: 'secret-key', AZURE_CLIENT_SECRET: 'azure-secret',
    GOOGLE_APPLICATION_CREDENTIALS: '/tmp/adc.json', GOOGLE_CLOUD_PROJECT: 'native-project',
    CLOUD_ML_REGION: 'us-east5', ANTHROPIC_FOUNDRY_RESOURCE: 'native-resource',
  }
  assert.deepEqual(nativeCredentialEnvironment('claude', cloud), cloud)
  assert.deepEqual(nativeCredentialEnvironment('gemini', cloud), {
    GOOGLE_APPLICATION_CREDENTIALS: '/tmp/adc.json', GOOGLE_CLOUD_PROJECT: 'native-project',
  })
  assert.deepEqual(nativeCredentialEnvironment('codex', cloud), {})
})

test('AWS SDK options survive shell discovery and are shared by cloud Agent probes and execution', async () => {
  const cloud = {
    AWS_SDK_LOAD_CONFIG: '1', AWS_EC2_METADATA_DISABLED: 'true',
    AWS_STS_REGIONAL_ENDPOINTS: 'regional', AWS_RETRY_MODE: 'adaptive', AWS_MAX_ATTEMPTS: '5',
  }
  const result = await resolveNativeShellEnvironment({
    cache: false, platform: 'win32', env: { ...cloud, GITHUB_TOKEN: 'unrelated' },
  })
  const execFile = require('node:util').promisify(require('node:child_process').execFile)
  const shellResult = await resolveNativeShellEnvironment({
    cache: false, platform: 'darwin', shell: '/bin/sh', env: {},
    execFileFn: (command, args, options) => execFile(command, ['-c', [
      ...Object.entries(cloud).map(([key, value]) => `export ${key}=${value}`), args[1],
    ].join('\n')], options),
  })
  assert.equal(shellResult.source, 'native-shell')
  assert.deepEqual(nativeCredentialEnvironment('claude', shellResult.env), cloud)
  for (const kind of ['claude', 'pi']) {
    const native = nativeCredentialEnvironment(kind, result.env)
    assert.deepEqual(native, cloud)
    const execution = childEnvironment({ kind }, '/tmp/workspace', { env: native }, 'win32')
    for (const [key, value] of Object.entries(cloud)) assert.equal(execution[key], value)
    assert.equal(execution.GITHUB_TOKEN, undefined)
  }
  let probeEnv
  await resolveNativeCredentialState('claude', {
    env: result.env, platform: 'win32', executable: 'claude.exe',
    execFileFn: async (_command, _args, options) => {
      probeEnv = options.env
      return { stdout: '{"loggedIn":true,"authMethod":"api_key"}' }
    },
  })
  for (const [key, value] of Object.entries(cloud)) assert.equal(probeEnv[key], value)
  assert.equal(probeEnv.GITHUB_TOKEN, undefined)
  assert.deepEqual(nativeCredentialEnvironment('codex', result.env), {})
})

test('Pi retains its native Bedrock, Azure and Vertex environment without unrelated secrets', async () => {
  const cloud = {
    AWS_PROFILE: 'native-profile', AWS_REGION: 'region', AWS_SECRET_ACCESS_KEY: 'synthetic-aws',
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/example',
    AZURE_OPENAI_API_KEY: 'synthetic-azure', AZURE_OPENAI_BASE_URL: 'https://azure.example',
    GOOGLE_CLOUD_API_KEY: 'synthetic-google', GOOGLE_CLOUD_PROJECT: 'project',
    GOOGLE_APPLICATION_CREDENTIALS: '/tmp/adc.json',
  }
  const result = await resolveNativeShellEnvironment({
    cache: false, platform: 'win32', env: { ...cloud, GITHUB_TOKEN: 'unrelated' },
  })
  assert.deepEqual(nativeCredentialEnvironment('pi', result.env), cloud)
  assert.deepEqual(nativeCredentialEnvironment('codex', result.env), {})
  assert.equal(result.env.GITHUB_TOKEN, undefined)
})

test('Claude retains native Bedrock container credentials through shell discovery and execution', async () => {
  const cloud = {
    CLAUDE_CODE_USE_BEDROCK: '1',
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/example',
    AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://127.0.0.1/credentials',
    AWS_CONTAINER_AUTHORIZATION_TOKEN: 'synthetic-container-token',
    AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: '/tmp/container-token',
  }
  const result = await resolveNativeShellEnvironment({
    cache: false, platform: 'win32', env: { ...cloud, GITHUB_TOKEN: 'unrelated' },
  })
  const selected = nativeCredentialEnvironment('claude', result.env)
  assert.deepEqual(selected, cloud)
  const { childEnvironment } = require('../../src/agents/cli/cli-process-support.cjs')
  const child = childEnvironment({ kind: 'claude' }, '/workspace', { env: selected }, 'win32')
  for (const [key, value] of Object.entries(cloud)) assert.equal(child[key], value)
  assert.deepEqual(nativeCredentialEnvironment('codex', result.env), {})
  assert.equal(result.env.GITHUB_TOKEN, undefined)
})

test('Kimi credential detection follows its selected native home instead of stale defaults', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-kimi-home-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const defaults = path.join(home, '.kimi-code')
  const selected = path.join(home, 'selected-kimi')
  fs.mkdirSync(defaults)
  fs.mkdirSync(selected)
  fs.writeFileSync(path.join(defaults, 'config.toml'), 'api_key = "stale-test-credential"\n')
  assert.equal(nativeCredentialState('kimi', { home, env: {} }).state, 'ready')
  assert.equal(nativeCredentialState('kimi', { home, env: { KIMI_CODE_HOME: selected } }).state, 'unknown')
  fs.mkdirSync(path.join(selected, 'credentials'))
  fs.writeFileSync(path.join(selected, 'credentials', 'kimi-code.json'), '{"access_token":"selected-test-credential"}')
  assert.equal(nativeCredentialState('kimi', { home, env: { KIMI_CODE_HOME: selected } }).state, 'ready')
  assert.equal(nativeCredentialState('kimi', { home, env: { KIMI_CODE_HOME: 'relative-home' } }).state, 'unknown')
})

test('an installed Agent without credential evidence remains unverified', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-missing-readiness-'))
  try {
    assert.deepEqual(nativeCredentialState('workbuddy', { home }), {
      state: 'unknown', source: 'unverified',
    })
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('native environment forwarding includes only the current Agent credential keys', () => {
  assert.deepEqual(nativeCredentialEnvironment('claude', {
    ANTHROPIC_API_KEY: 'claude-key',
    OPENAI_API_KEY: 'unrelated-openai-key',
    MELDWORK_PRIVATE_VALUE: 'desktop-private-value',
  }), {
    ANTHROPIC_API_KEY: 'claude-key',
  })

  assert.deepEqual(nativeCredentialEnvironment('hermes', {
    OPENROUTER_API_KEY: 'openrouter-key',
    OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
    OPENAI_MODEL: 'openrouter/model',
    GITHUB_TOKEN: 'unrelated-secret',
  }), {
    OPENROUTER_API_KEY: 'openrouter-key',
    OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
    OPENAI_MODEL: 'openrouter/model',
  })
})

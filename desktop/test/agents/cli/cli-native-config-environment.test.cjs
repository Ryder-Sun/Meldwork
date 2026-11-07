const test = require('node:test')
const assert = require('node:assert/strict')
const { nativeCredentialEnvironment } = require('../../../src/agents/local-agent-readiness.cjs')
const { childEnvironment } = require('../../../src/agents/cli/cli-process-support.cjs')
const { createRuntimeEventEmitter, redactChildSecrets } = require('../../../src/agents/cli/cli-runtime-event-sanitizer.cjs')

test('short native credentials are redacted without hiding unrelated configuration', () => {
  const env = { OPENAI_API_KEY: 'abc', AWS_SECRET_ACCESS_KEY: 'xy', AWS_SESSION_TOKEN: 'def', AWS_BEARER_TOKEN_BEDROCK: 'zz',
    AZURE_CLIENT_SECRET: 'gh', OPENAI_MODEL: 'model-name' }
  assert.equal(redactChildSecrets('abc xy def zz gh model-name', env),
    '[redacted] [redacted] [redacted] [redacted] [redacted] model-name')
})
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { executable } = require('../../support/cli-adapters-test-helpers.cjs')
const { runAgent } = require('../../../src/agents/cli/cli-adapters.cjs')

test('native configuration controls reach only the CLI that owns them', () => {
  const entries = {
    codex: { CODEX_HOME: '/native/codex' },
    hermes: { HERMES_HOME: '/native/hermes', GCLOUD_PROJECT: 'native-project' },
    deepseek: { DSH_HOME: '/native/dsh', DSH_AGENTS_HOME: '/native/shared' },
    kimi: { KIMI_CODE_HOME: '/native/kimi', KIMI_MODEL_PROVIDER_TYPE: 'openai' },
    mimo: { MIMOCODE_CONFIG_DIR: '/native/mimo', MIMOCODE_CONFIG_CONTENT: '{"model":"local/model"}' },
    opencode: { OPENCODE_CONFIG: '/native/opencode.json', OPENCODE_CONFIG_DIR: '/native/opencode', OPENCODE_CONFIG_CONTENT: '{"model":"local/model"}', OPENCODE_DISABLE_PROJECT_CONFIG: 'true', GCLOUD_PROJECT: 'native-project' },
    qwen: { QWEN_HOME: '/native/qwen' },
    gemini: { GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:3425', GCLOUD_PROJECT: 'native-project' },
  }
  const shell = { ...Object.assign({}, ...Object.values(entries)), UNRELATED_SECRET: 'must-not-leak', NODE_OPTIONS: '--require /untrusted.js' }
  for (const [kind, expected] of Object.entries(entries)) {
    const selected = nativeCredentialEnvironment(kind, shell)
    assert.deepEqual(selected, expected, kind)
    const child = childEnvironment({ kind, executable: '/native/cli' }, '/workspace', { env: selected }, 'darwin')
    for (const [key, value] of Object.entries(expected)) assert.equal(child[key], value, `${kind}: ${key}`)
    assert.equal(child.NODE_OPTIONS, undefined)
    assert.equal(child.UNRELATED_SECRET, undefined)
  }
})

test('OpenCode receives its native Bedrock, Azure and Google provider settings', async () => {
  const { resolveNativeShellEnvironment } = require('../../../src/agents/local-agent-readiness.cjs')
  const input = { AWS_PROFILE: 'native-profile', AWS_BEARER_TOKEN_BEDROCK: 'aws-secret',
    AZURE_OPENAI_API_KEY: 'azure-secret', AZURE_RESOURCE_NAME: 'azure-resource',
    GOOGLE_APPLICATION_CREDENTIALS: 'google.json', GOOGLE_CLOUD_PROJECT: 'native-project' }
  const captured = await resolveNativeShellEnvironment({ cache: false, platform: 'win32', env: input })
  const selected = nativeCredentialEnvironment('opencode', captured.env)
  assert.deepEqual(selected, input)
  const child = childEnvironment({ kind: 'opencode' }, '/workspace', { env: selected }, 'darwin')
  for (const [key, value] of Object.entries(input)) assert.equal(child[key], value)
  assert.equal(nativeCredentialEnvironment('codex', captured.env).AWS_PROFILE, undefined)
  assert.equal(nativeCredentialEnvironment('hermes', captured.env).AZURE_OPENAI_API_KEY, undefined)
})

test('Zcode native provider environment reaches its child without leaking to other Agents', () => {
  const env = { ZCODE_API_KEY: 'test-secret', ZCODE_BASE_URL: 'https://provider.example', ZCODE_MODEL: 'project/model',
    ZCODE_HTTP_PROXY: 'http://127.0.0.1:8080', ZCODE_NO_PROXY: 'localhost', ZCODE_AGENT_CA_CERT: '/ca.pem',
    ANTHROPIC_BASE_URL: 'https://anthropic.example', NODE_OPTIONS: '--require /untrusted.js' }
  const selected = nativeCredentialEnvironment('zcode', env)
  assert.deepEqual(selected, { ZCODE_API_KEY: 'test-secret', ZCODE_BASE_URL: 'https://provider.example', ZCODE_MODEL: 'project/model',
    ZCODE_HTTP_PROXY: 'http://127.0.0.1:8080', ZCODE_NO_PROXY: 'localhost', ZCODE_AGENT_CA_CERT: '/ca.pem',
    ANTHROPIC_BASE_URL: 'https://anthropic.example' })
  const child = childEnvironment({ kind: 'zcode', executable: '/native/zcode' }, '/workspace', { env: selected }, 'darwin')
  for (const [key, value] of Object.entries(selected)) assert.equal(child[key], value)
  assert.equal(child.NODE_OPTIONS, undefined)
  assert.equal(nativeCredentialEnvironment('codex', env).ZCODE_API_KEY, undefined)
})

test('Zcode declared provider credentials are isolated and redacted', () => {
  const options = { env: { ACME_API_KEY: 'synthetic-secret' }, nativeCredentialKeys: ['ACME_API_KEY'] }
  const zcode = childEnvironment({ kind: 'zcode', executable: '/native/zcode' }, '/workspace', options, 'darwin')
  assert.equal(zcode.ACME_API_KEY, 'synthetic-secret')
  assert.equal(redactChildSecrets('value=synthetic-secret', zcode), 'value=[redacted]')
  assert.equal(childEnvironment({ kind: 'codex', executable: '/native/codex' }, '/workspace', { env: options.env }, 'darwin').ACME_API_KEY, undefined)
})

test('Codex Connector credentials are redacted even when short', () => {
  const options = { env: { CODEX_API_KEY: 'abc' }, nativeCredentialKeys: ['CODEX_API_KEY'] }
  const child = childEnvironment({ kind: 'codex', executable: '/native/codex' }, '/workspace', options, 'darwin')
  assert.equal(child.CODEX_API_KEY, 'abc')
  assert.equal(redactChildSecrets('key=abc', child), 'key=[redacted]')
})

test('Hermes native endpoint variables reach its child without leaking to other Agents', () => {
  const env = { CUSTOM_BASE_URL: 'https://custom.example', OPENROUTER_BASE_URL: 'https://router.example',
    OLLAMA_HOST: 'http://localhost:11434', OLLAMA_API_KEY: 'test-secret', NODE_OPTIONS: '--require /untrusted.js' }
  const selected = nativeCredentialEnvironment('hermes', env)
  assert.deepEqual(selected, { CUSTOM_BASE_URL: env.CUSTOM_BASE_URL, OPENROUTER_BASE_URL: env.OPENROUTER_BASE_URL,
    OLLAMA_HOST: env.OLLAMA_HOST, OLLAMA_API_KEY: env.OLLAMA_API_KEY })
  const child = childEnvironment({ kind: 'hermes', executable: '/native/hermes' }, '/workspace', { env: selected }, 'darwin')
  for (const [key, value] of Object.entries(selected)) assert.equal(child[key], value)
  assert.equal(child.NODE_OPTIONS, undefined)
  assert.deepEqual(nativeCredentialEnvironment('codex', env), {})
})

test('declared Hermes credentials reach only Hermes and are redacted even without a conventional name', () => {
  const options = { env: { CUSTOM_CREDENTIAL: 'abc', NODE_OPTIONS: '--require /untrusted.js' },
    nativeCredentialKeys: ['CUSTOM_CREDENTIAL', 'NODE_OPTIONS'] }
  const hermes = childEnvironment({ kind: 'hermes', executable: '/native/hermes' }, '/workspace', options, 'darwin')
  assert.equal(hermes.CUSTOM_CREDENTIAL, 'abc')
  assert.equal(hermes.NODE_OPTIONS, undefined)
  assert.equal(redactChildSecrets('value=abc', hermes), 'value=[redacted]')
  const events = []
  const emitter = createRuntimeEventEmitter({ onEvent: event => events.push(event) }, hermes)
  for (const part of ['a', 'b', 'c']) emitter.emit({ type: 'answer_delta', status: 'running', delta: part })
  emitter.finalize({ status: 'completed' })
  assert.doesNotMatch(JSON.stringify(events), /abc/)
  const codex = childEnvironment({ kind: 'codex', executable: '/native/codex' }, '/workspace', { env: options.env }, 'darwin')
  assert.equal(codex.CUSTOM_CREDENTIAL, undefined)
})

test('Codex uses only the selected native provider env_key and redacts it', t => {
  const { codexDeclaredCredentialKeys } = require('../../../src/agents/local-agent-readiness.cjs')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-codex-provider-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'config.toml'), `profile = 'work'\nmodel_provider = 'other'\n[profiles.work]\nmodel_provider = 'custom'\n[model_providers.custom]\nenv_key = 'CUSTOM_CREDENTIAL'\n[model_providers.other]\nenv_key = 'OTHER_SECRET'\n`)
  const env = { CODEX_HOME: directory, CUSTOM_CREDENTIAL: 'abc', OTHER_SECRET: 'other', NODE_OPTIONS: 'unsafe' }
  const keys = codexDeclaredCredentialKeys({ env, home: directory })
  assert.deepEqual(keys, ['CUSTOM_CREDENTIAL'])
  const selected = nativeCredentialEnvironment('codex', env, keys)
  const child = childEnvironment({ kind: 'codex', executable: '/native/codex' }, '/workspace', {
    env: selected, nativeCredentialKeys: keys,
  }, 'darwin')
  assert.equal(child.CUSTOM_CREDENTIAL, 'abc')
  assert.equal(child.OTHER_SECRET, undefined)
  assert.equal(child.NODE_OPTIONS, undefined)
  assert.equal(redactChildSecrets('value=abc', child), 'value=[redacted]')
  fs.writeFileSync(path.join(directory, 'config.toml'), "model_provider = 'custom'\n[model_providers.custom]\nenv_key = 'NODE_OPTIONS'\n")
  assert.deepEqual(codexDeclaredCredentialKeys({ env, home: directory }), [])
})

test('Hermes invocation receives declared credentials and redacts them from its reply', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-hermes-declared-key-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const cli = executable(directory, 'hermes.cjs', "process.stdout.write('reply=' + process.env.CUSTOM_CREDENTIAL)")
  const result = await runAgent({ kind: 'hermes', name: 'Hermes', executable: cli }, 'hello', directory, {
    hermesAcpAvailable: false, hermesMessageWatermarkFn: () => null,
    env: { CUSTOM_CREDENTIAL: 'abc' }, nativeCredentialKeys: ['CUSTOM_CREDENTIAL'],
  })
  assert.equal(result.text, 'reply=[redacted]')
})

test('MiMo captures only the selected provider environment reference and redacts it', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-mimo-reference-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.mkdirSync(path.join(directory, 'mimocode'))
  const filename = path.join(directory, 'mimocode', 'mimocode.json')
  const write = key => fs.writeFileSync(filename, JSON.stringify({ model: 'custom/model', provider: {
    custom: { options: { apiKey: key } }, other: { options: { apiKey: '{env:OTHER_SECRET}' } },
  } }))
  const { mimoDeclaredCredentialKeys, mimoConfiguredProvider } = require('../../../src/agents/cli/mimo-native-config.cjs')
  const env = { XDG_CONFIG_HOME: directory, CUSTOM_CREDENTIAL: 'abc', OTHER_SECRET: 'other' }
  write('{env:CUSTOM_CREDENTIAL}')
  const keys = mimoDeclaredCredentialKeys({ env })
  assert.deepEqual(keys, ['CUSTOM_CREDENTIAL'])
  assert.equal(mimoConfiguredProvider({ env }), true)
  const selected = nativeCredentialEnvironment('mimo', env, keys)
  const child = childEnvironment({ kind: 'mimo', executable: '/native/mimo' }, '/workspace', {
    env: selected, nativeCredentialKeys: keys,
  }, 'darwin')
  assert.equal(child.CUSTOM_CREDENTIAL, 'abc')
  assert.equal(child.OTHER_SECRET, undefined)
  assert.equal(redactChildSecrets('value=abc', child), 'value=[redacted]')
  assert.equal(nativeCredentialEnvironment('codex', env).CUSTOM_CREDENTIAL, undefined)
  write('{env:NODE_OPTIONS}')
  assert.deepEqual(mimoDeclaredCredentialKeys({ env }), [])
  assert.equal(mimoConfiguredProvider({ env: { ...env, NODE_OPTIONS: 'unsafe' } }), false)
})

test('MiMo resolves the selected model from the native shell before finding its provider key', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-mimo-model-env-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  fs.writeFileSync(path.join(home, 'mimocode.json'), JSON.stringify({ model: '{env:MODEL_CHOICE}',
    provider: { custom: { options: { apiKey: '{env:CUSTOM_KEY}' } },
      other: { options: { apiKey: '{env:OTHER_KEY}' } } } }))
  const { mimoDeclaredCredentialKeys, mimoConfiguredProvider } = require('../../../src/agents/cli/mimo-native-config.cjs')
  assert.deepEqual(mimoDeclaredCredentialKeys({ home, workdir: home, env: {} }), ['MODEL_CHOICE'])
  const env = { MODEL_CHOICE: 'custom/model', CUSTOM_KEY: 'synthetic' }
  assert.deepEqual(mimoDeclaredCredentialKeys({ home, workdir: home, env }), ['CUSTOM_KEY', 'MODEL_CHOICE'])
  assert.equal(mimoConfiguredProvider({ home, workdir: home, env }), true)
})

test('MiMo captures embedded key and header references for only the selected provider', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-mimo-headers-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  fs.writeFileSync(path.join(home, 'mimocode.json'), JSON.stringify({ model: 'custom/model',
    provider: { custom: { options: { apiKey: 'prefix-{env:CUSTOM_KEY}', headers: { authorization: 'Bearer {env:HEADER_KEY}' } } },
      other: { options: { apiKey: '{env:OTHER_KEY}' } } } }))
  const { mimoDeclaredCredentialKeys, mimoConfiguredProvider } = require('../../../src/agents/cli/mimo-native-config.cjs')
  const env = { CUSTOM_KEY: 'synthetic', HEADER_KEY: 'header', OTHER_KEY: 'other' }
  const keys = mimoDeclaredCredentialKeys({ home, workdir: home, env })
  assert.deepEqual(keys, ['CUSTOM_KEY', 'HEADER_KEY'])
  assert.equal(mimoConfiguredProvider({ home, workdir: home, env }), true)
  assert.equal(mimoConfiguredProvider({ home, workdir: home, env: {} }), false)
  const child = childEnvironment({ kind: 'mimo' }, home,
    { env: nativeCredentialEnvironment('mimo', env, keys), nativeCredentialKeys: keys }, 'darwin')
  assert.equal(child.CUSTOM_KEY, 'synthetic')
  assert.equal(child.HEADER_KEY, 'header')
  assert.equal(child.OTHER_KEY, undefined)
})

test('MiMo discovers the recent native model provider when no model is configured', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-mimo-recent-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const state = path.join(home, 'state', 'mimocode')
  fs.mkdirSync(state, { recursive: true })
  fs.writeFileSync(path.join(state, 'model.json'), JSON.stringify({ recent: [
    { providerID: 'missing', modelID: 'example' }, { providerID: 'custom', modelID: 'example' },
  ] }))
  fs.writeFileSync(path.join(home, 'mimocode.json'), JSON.stringify({ provider: {
    custom: { options: { apiKey: '{env:CUSTOM_KEY}' } }, other: { options: { apiKey: '{env:OTHER_KEY}' } },
  } }))
  const { mimoDeclaredCredentialKeys, mimoConfiguredProvider } = require('../../../src/agents/cli/mimo-native-config.cjs')
  const env = { XDG_STATE_HOME: path.dirname(state), CUSTOM_KEY: 'synthetic', OTHER_KEY: 'unrelated' }
  assert.deepEqual(mimoDeclaredCredentialKeys({ home, workdir: home, env }), ['CUSTOM_KEY'])
  assert.equal(mimoConfiguredProvider({ home, workdir: home, env }), true)
  fs.writeFileSync(path.join(state, 'model.json'), JSON.stringify({ recent: [
    { providerID: 'custom', modelID: 'example' }, { providerID: 'other', modelID: 'example' },
  ] }))
  assert.deepEqual(mimoDeclaredCredentialKeys({ home, workdir: home, env }), ['CUSTOM_KEY', 'OTHER_KEY'])
  assert.equal(mimoConfiguredProvider({ home, workdir: home, env: { ...env, CUSTOM_KEY: '' } }), true)
  fs.writeFileSync(path.join(state, 'model.json'), '{bad')
  assert.deepEqual(mimoDeclaredCredentialKeys({ home, workdir: home, env }), [])
})

test('inline native provider credentials are redacted in complete and streamed output', () => {
  for (const kind of ['mimo', 'opencode']) {
    const key = kind === 'mimo' ? 'MIMOCODE_CONFIG_CONTENT' : 'OPENCODE_CONFIG_CONTENT'
    const content = `{ // native JSONC\n provider: { custom: { options: { apiKey: 'abc', headers: { Authorization: 'Bearer secret-token' } } } } }`
    const child = childEnvironment({ kind, executable: '/native/cli' }, '/workspace', { env: { [key]: content } }, 'darwin')
    assert.equal(redactChildSecrets('key abc and secret-token', child), 'key [redacted] and [redacted]')
    const events = []
    const emitter = createRuntimeEventEmitter({ onEvent: event => events.push(event) }, child)
    for (const part of ['a', 'b', 'c']) emitter.emit({ type: 'answer_delta', status: 'running', delta: part })
    emitter.finalize({ status: 'completed' })
    assert.doesNotMatch(JSON.stringify(events), /abc/)
    child[key] = '{provider:{custom:{options:{apiKey:"new-secret"}}}}'
    assert.equal(redactChildSecrets('new-secret', child), '[redacted]')
  }
})

test('MiMo resolves provider references across native configuration overrides', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-mimo-overrides-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const root = path.join(directory, 'xdg')
  const selected = path.join(directory, 'selected')
  fs.mkdirSync(path.join(root, 'mimocode'), { recursive: true })
  fs.mkdirSync(selected)
  const provider = apiKey => ({ custom: { options: { apiKey } } })
  fs.writeFileSync(path.join(root, 'mimocode', 'mimocode.json'), JSON.stringify({
    model: 'custom/model', provider: provider('{env:GLOBAL_SECRET}'),
  }))
  const file = path.join(directory, 'override.json')
  fs.writeFileSync(file, JSON.stringify({ provider: provider('{env:FILE_SECRET}') }))
  fs.writeFileSync(path.join(selected, 'mimocode.json'), JSON.stringify({ provider: provider('{env:DIR_SECRET}') }))
  const { mimoDeclaredCredentialKeys, mimoConfiguredProvider } = require('../../../src/agents/cli/mimo-native-config.cjs')
  const env = { XDG_CONFIG_HOME: root, MIMOCODE_CONFIG: file, MIMOCODE_CONFIG_DIR: selected,
    GLOBAL_SECRET: 'a', FILE_SECRET: 'b', DIR_SECRET: 'c', INLINE_SECRET: 'd' }
  assert.deepEqual(mimoDeclaredCredentialKeys({ env }), ['DIR_SECRET'])
  const inline = { ...env, MIMOCODE_CONFIG_CONTENT: JSON.stringify({ provider: provider('{env:INLINE_SECRET}') }) }
  assert.deepEqual(mimoDeclaredCredentialKeys({ env: inline }), ['INLINE_SECRET'])
  assert.equal(mimoConfiguredProvider({ env: inline }), true)
  const selectedEnv = nativeCredentialEnvironment('mimo', inline, ['INLINE_SECRET'])
  assert.equal(selectedEnv.MIMOCODE_CONFIG, file)
  assert.equal(selectedEnv.INLINE_SECRET, 'd')
  assert.equal(selectedEnv.DIR_SECRET, undefined)
  fs.writeFileSync(path.join(selected, 'mimocode.jsonc'), '{ // native override\n provider: { custom: { options: { apiKey: "{env:JSONC_SECRET}", }, }, }, }')
  assert.deepEqual(mimoDeclaredCredentialKeys({ env }), ['JSONC_SECRET'])
  fs.writeFileSync(path.join(selected, 'mimocode.json'), '{bad json')
  assert.deepEqual(mimoDeclaredCredentialKeys({ env }), [])
})

test('MiMo selected native directory drives credential capture and child execution', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-mimo-selected-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const selected = path.join(home, 'selected')
  fs.mkdirSync(selected)
  fs.writeFileSync(path.join(selected, 'mimocode.json'), JSON.stringify({
    model: 'custom/model', provider: { custom: { options: { apiKey: '{env:SELECTED_TOKEN}' } } },
  }))
  const { nativeConfigEnvironment } = require('../../../src/agents/native-config-directory.cjs')
  const { mimoDeclaredCredentialKeys, mimoConfiguredProvider } = require('../../../src/agents/cli/mimo-native-config.cjs')
  const env = nativeConfigEnvironment('mimo', { mimo: { nativeConfigDirectory: selected } }, {
    SELECTED_TOKEN: 'synthetic-private-token', HOME: home,
  })
  const keys = mimoDeclaredCredentialKeys({ home, env })
  assert.deepEqual(keys, ['SELECTED_TOKEN'])
  assert.equal(mimoConfiguredProvider({ home, env }), true)
  const native = nativeCredentialEnvironment('mimo', env, keys)
  const child = childEnvironment({ kind: 'mimo' }, home, { env: native, nativeCredentialKeys: keys }, 'darwin')
  assert.equal(child.MIMOCODE_CONFIG_DIR, selected)
  assert.equal(child.SELECTED_TOKEN, 'synthetic-private-token')
  assert.equal(nativeCredentialEnvironment('codex', env).SELECTED_TOKEN, undefined)
})

test('MiMo selects project provider references for the current work directory', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-mimo-project-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const root = path.join(home, 'project')
  const workdir = path.join(root, 'nested')
  const xdg = path.join(home, 'config')
  fs.mkdirSync(path.join(root, '.git'), { recursive: true })
  fs.mkdirSync(workdir)
  fs.mkdirSync(path.join(xdg, 'mimocode'), { recursive: true })
  const provider = key => ({ model: 'custom/model', provider: { custom: { options: { apiKey: `{env:${key}}` } } } })
  fs.writeFileSync(path.join(xdg, 'mimocode', 'mimocode.json'), JSON.stringify(provider('GLOBAL_SECRET')))
  fs.writeFileSync(path.join(root, 'mimocode.json'), JSON.stringify(provider('PROJECT_SECRET')))
  fs.writeFileSync(path.join(workdir, 'mimocode.jsonc'), JSON.stringify(provider('NESTED_SECRET')))
  const { mimoDeclaredCredentialKeys } = require('../../../src/agents/cli/mimo-native-config.cjs')
  const env = { XDG_CONFIG_HOME: xdg }
  assert.deepEqual(mimoDeclaredCredentialKeys({ home, env, workdir }), ['NESTED_SECRET'])
  assert.deepEqual(mimoDeclaredCredentialKeys({ home, env, workdir: root }), ['PROJECT_SECRET'])
  for (const [directory, key] of [[root, 'ROOT_DIR_SECRET'], [workdir, 'NESTED_DIR_SECRET']]) {
    fs.mkdirSync(path.join(directory, '.mimocode'))
    fs.writeFileSync(path.join(directory, '.mimocode', 'mimocode.json'), JSON.stringify(provider(key)))
  }
  assert.deepEqual(mimoDeclaredCredentialKeys({ home, env, workdir }), ['ROOT_DIR_SECRET'])
  assert.deepEqual(mimoDeclaredCredentialKeys({ home, env: { ...env, MIMOCODE_DISABLE_PROJECT_CONFIG: '1' }, workdir }), ['GLOBAL_SECRET'])
  assert.deepEqual(mimoDeclaredCredentialKeys({ home, env, workdir: home }), ['GLOBAL_SECRET'])
  fs.rmSync(path.join(root, '.git'), { recursive: true })
  assert.deepEqual(mimoDeclaredCredentialKeys({ home, env, workdir }), ['ROOT_DIR_SECRET'])
})

test('MiMo resolves relative native configuration paths against the chat work directory', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-mimo-relative-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const workdir = path.join(home, 'work')
  const selected = path.join(workdir, 'selected')
  fs.mkdirSync(selected, { recursive: true })
  const config = key => JSON.stringify({ model: 'custom/model', provider: {
    custom: { options: { apiKey: `{env:${key}}` } },
  } })
  fs.writeFileSync(path.join(workdir, 'config.json'), config('FILE_KEY'))
  fs.writeFileSync(path.join(selected, 'mimocode.json'), config('DIRECTORY_KEY'))
  const { mimoDeclaredCredentialKeys } = require('../../../src/agents/cli/mimo-native-config.cjs')
  const env = { MIMOCODE_CONFIG: 'config.json', MIMOCODE_CONFIG_DIR: 'selected' }
  assert.deepEqual(mimoDeclaredCredentialKeys({ home, env }), [])
  assert.deepEqual(mimoDeclaredCredentialKeys({ home, env, workdir }), ['DIRECTORY_KEY'])
  assert.deepEqual(mimoDeclaredCredentialKeys({ home, env: { MIMOCODE_CONFIG: 'config.json' }, workdir }), ['FILE_KEY'])
})

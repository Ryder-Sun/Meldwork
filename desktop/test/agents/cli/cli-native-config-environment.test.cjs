const test = require('node:test')
const assert = require('node:assert/strict')
const { nativeCredentialEnvironment } = require('../../../src/agents/local-agent-readiness.cjs')
const { childEnvironment } = require('../../../src/agents/cli/cli-process-support.cjs')
const { createRuntimeEventEmitter, redactChildSecrets } = require('../../../src/agents/cli/cli-runtime-event-sanitizer.cjs')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { executable } = require('../../support/cli-adapters-test-helpers.cjs')
const { runAgent } = require('../../../src/agents/cli/cli-adapters.cjs')

test('native configuration controls reach only the CLI that owns them', () => {
  const entries = {
    codex: { CODEX_HOME: '/native/codex' },
    hermes: { HERMES_HOME: '/native/hermes' },
    deepseek: { DSH_HOME: '/native/dsh', DSH_AGENTS_HOME: '/native/shared' },
    kimi: { KIMI_CODE_HOME: '/native/kimi', KIMI_MODEL_PROVIDER_TYPE: 'openai' },
    mimo: { MIMOCODE_CONFIG_DIR: '/native/mimo', MIMOCODE_CONFIG_CONTENT: '{"model":"local/model"}' },
    opencode: { OPENCODE_CONFIG: '/native/opencode.json', OPENCODE_CONFIG_DIR: '/native/opencode', OPENCODE_CONFIG_CONTENT: '{"model":"local/model"}' },
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

test('Zcode native provider environment reaches its child without leaking to other Agents', () => {
  const env = { ZCODE_API_KEY: 'test-secret', ZCODE_BASE_URL: 'https://provider.example',
    ANTHROPIC_BASE_URL: 'https://anthropic.example', NODE_OPTIONS: '--require /untrusted.js' }
  const selected = nativeCredentialEnvironment('zcode', env)
  assert.deepEqual(selected, { ZCODE_API_KEY: 'test-secret', ZCODE_BASE_URL: 'https://provider.example',
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
  assert.equal(childEnvironment({ kind: 'codex', executable: '/native/codex' }, '/workspace', options, 'darwin').ACME_API_KEY, undefined)
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
  const codex = childEnvironment({ kind: 'codex', executable: '/native/codex' }, '/workspace', options, 'darwin')
  assert.equal(codex.CUSTOM_CREDENTIAL, undefined)
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
  assert.equal(nativeCredentialEnvironment('codex', env, keys).CUSTOM_CREDENTIAL, undefined)
  write('{env:NODE_OPTIONS}')
  assert.deepEqual(mimoDeclaredCredentialKeys({ env }), [])
  assert.equal(mimoConfiguredProvider({ env: { ...env, NODE_OPTIONS: 'unsafe' } }), false)
})

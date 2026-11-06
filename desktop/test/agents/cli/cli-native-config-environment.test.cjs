const test = require('node:test')
const assert = require('node:assert/strict')
const { nativeCredentialEnvironment } = require('../../../src/agents/local-agent-readiness.cjs')
const { childEnvironment } = require('../../../src/agents/cli/cli-process-support.cjs')

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

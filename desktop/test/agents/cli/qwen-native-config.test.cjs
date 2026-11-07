const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { qwenDeclaredCredentialKeys } = require('../../../src/agents/cli/qwen-native-config.cjs')
const { nativeCredentialEnvironment } = require('../../../src/agents/agent-native-environment.cjs')
const { childEnvironment } = require('../../../src/agents/cli/cli-process-support.cjs')
const { redactChildSecrets } = require('../../../src/agents/cli/cli-runtime-events.cjs')
const { nativeCredentialState } = require('../../../src/agents/local-agent-readiness.cjs')

test('Qwen resolves the selected home for its model credential and local .env', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-qwen-selected-home-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const selected = path.join(root, 'selected')
  fs.mkdirSync(path.join(selected, '.qwen'), { recursive: true })
  fs.writeFileSync(path.join(selected, '.qwen', 'settings.json'), JSON.stringify({
    model: { name: 'chosen' }, security: { auth: { selectedType: 'openai' } },
    modelProviders: { openai: [{ id: 'chosen', envKey: 'CHOSEN_TOKEN' }] },
  }))
  fs.writeFileSync(path.join(selected, '.qwen', '.env'), 'CHOSEN_TOKEN=synthetic-selected\n')
  const env = { HOME: selected, QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(root, 'missing.json') }
  const keys = qwenDeclaredCredentialKeys({ home: root, env })
  assert.deepEqual(keys, ['CHOSEN_TOKEN'])
  assert.equal(nativeCredentialState('qwen', { home: root, env, nativeCredentialKeys: keys }).state, 'ready')
  const project = path.join(root, 'project')
  fs.mkdirSync(path.join(project, '.qwen'), { recursive: true })
  fs.writeFileSync(path.join(project, '.qwen', 'settings.json'), JSON.stringify({ model: { name: 'project' },
    security: { auth: { selectedType: 'openai' } }, modelProviders: { openai: [{ id: 'project', envKey: 'PROJECT_TOKEN' }] } }))
  assert.deepEqual(qwenDeclaredCredentialKeys({ home: root, env, workdir: project }), ['PROJECT_TOKEN'])
})

test('Qwen captures only the selected model credential and redacts it', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-qwen-env-key-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  fs.mkdirSync(path.join(home, '.qwen'))
  fs.writeFileSync(path.join(home, '.qwen', 'settings.json'), JSON.stringify({
    model: { name: 'chosen' }, security: { auth: { selectedType: 'openai' } },
    modelProviders: { openai: [{ id: 'chosen', envKey: 'CHOSEN_TOKEN' }, { id: 'other', envKey: 'OTHER_TOKEN' }] },
  }))
  const env = { QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(home, 'missing.json'), CHOSEN_TOKEN: 'private-value', OTHER_TOKEN: 'other-value' }
  const keys = qwenDeclaredCredentialKeys({ home, env })
  assert.deepEqual(keys, ['CHOSEN_TOKEN'])
  const native = nativeCredentialEnvironment('qwen', env, keys)
  const child = childEnvironment({ kind: 'qwen' }, home, { env: native, nativeCredentialKeys: keys }, 'darwin')
  assert.equal(child.CHOSEN_TOKEN, 'private-value')
  assert.equal(child.OTHER_TOKEN, undefined)
  assert.equal(redactChildSecrets('private-value', child), '[redacted]')
  assert.equal(nativeCredentialEnvironment('codex', env).CHOSEN_TOKEN, undefined)
  assert.deepEqual(nativeCredentialState('qwen', { home, env: { OPENAI_API_KEY: 'unrelated' }, nativeCredentialKeys: keys }),
    { state: 'unknown', source: 'unverified' })
  assert.deepEqual(nativeCredentialState('qwen', { home, env: child, nativeCredentialKeys: keys }),
    { state: 'ready', source: 'native-credential' })
  fs.writeFileSync(path.join(home, '.env'), 'CHOSEN_TOKEN=home-value\n')
  assert.deepEqual(nativeCredentialState('qwen', { home, env: {}, nativeCredentialKeys: keys, credentialSource: 'native-shell' }),
    { state: 'ready', source: 'native-credential' })
  assert.deepEqual(nativeCredentialState('qwen', { home, env: child, nativeCredentialKeys: keys, credentialSource: 'native-shell' }),
    { state: 'ready', source: 'native-shell' })
  fs.writeFileSync(path.join(home, '.qwen', '.env'), 'OTHER_TOKEN=unrelated\n')
  assert.deepEqual(nativeCredentialState('qwen', { home, env: {}, nativeCredentialKeys: keys }),
    { state: 'unknown', source: 'unverified' })
  fs.writeFileSync(path.join(home, '.qwen', '.env'), 'CHOSEN_TOKEN=selected\n')
  assert.deepEqual(nativeCredentialState('qwen', { home, env: { CHOSEN_TOKEN: '' }, nativeCredentialKeys: keys }),
    { state: 'unknown', source: 'unverified' })
  fs.writeFileSync(path.join(home, '.qwen', '.env'), 'CHOSEN_TOKEN=selected\nCHOSEN_TOKEN=\n')
  assert.deepEqual(nativeCredentialState('qwen', { home, env: {}, nativeCredentialKeys: keys }),
    { state: 'unknown', source: 'unverified' })
})

test('Qwen does not read a project credential declaration when folder trust denies it', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-qwen-trust-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const workdir = path.join(home, 'project')
  fs.mkdirSync(path.join(home, '.qwen'))
  fs.mkdirSync(path.join(workdir, '.qwen'), { recursive: true })
  fs.writeFileSync(path.join(home, '.qwen', 'settings.json'), JSON.stringify({ security: { folderTrust: { enabled: true } } }))
  fs.writeFileSync(path.join(workdir, '.qwen', 'settings.json'), JSON.stringify({
    model: { name: 'chosen' }, security: { auth: { selectedType: 'openai' } },
    modelProviders: { openai: [{ id: 'chosen', envKey: 'PROJECT_TOKEN' }] },
  }))
  const env = { QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(home, 'missing.json') }
  assert.deepEqual(qwenDeclaredCredentialKeys({ home, workdir, env }), [])
  fs.writeFileSync(path.join(home, '.qwen', 'trustedFolders.json'), JSON.stringify({ [workdir]: 'TRUST_FOLDER' }))
  assert.deepEqual(qwenDeclaredCredentialKeys({ home, workdir, env }), ['PROJECT_TOKEN'])
})

test('Qwen system configuration takes precedence and unsafe credential names are rejected', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-qwen-env-precedence-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const workdir = path.join(home, 'project')
  fs.mkdirSync(path.join(workdir, '.qwen'), { recursive: true })
  const config = key => ({ model: { name: 'chosen' }, security: { auth: { selectedType: 'openai' } },
    modelProviders: { openai: [{ id: 'chosen', envKey: key }] } })
  fs.writeFileSync(path.join(workdir, '.qwen', 'settings.json'), JSON.stringify(config('PROJECT_KEY')))
  const system = path.join(home, 'system.json')
  fs.writeFileSync(system, JSON.stringify(config('SYSTEM_KEY')))
  const env = { QWEN_CODE_SYSTEM_SETTINGS_PATH: system }
  assert.deepEqual(qwenDeclaredCredentialKeys({ home, workdir, env }), ['SYSTEM_KEY'])
  fs.writeFileSync(system, JSON.stringify(config('NODE_OPTIONS')))
  assert.deepEqual(qwenDeclaredCredentialKeys({ home, workdir, env }), [])
  assert.deepEqual(nativeCredentialState('qwen', { home, workdir,
    env: { ...env, OPENAI_API_KEY: 'unrelated' } }), { state: 'unknown', source: 'unverified' })
  fs.writeFileSync(system, JSON.stringify({ modelProviders: { anthropic: [{ id: 'other', envKey: 'OTHER_KEY' }] } }))
  assert.deepEqual(qwenDeclaredCredentialKeys({ home, workdir, env }), ['OPENAI_API_KEY'])
  fs.writeFileSync(system, '{ malformed')
  assert.deepEqual(nativeCredentialState('qwen', { home, workdir,
    env: { ...env, OPENAI_API_KEY: 'unrelated' } }), { state: 'unknown', source: 'unverified' })
})

test('Qwen readiness follows the selected standard provider credential', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-qwen-standard-provider-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  fs.mkdirSync(path.join(home, '.qwen'))
  const settings = path.join(home, '.qwen', 'settings.json')
  const env = { QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(home, 'missing.json'), OPENAI_API_KEY: 'other-provider' }
  for (const [auth, key] of [['anthropic', 'ANTHROPIC_API_KEY'], ['gemini', 'GEMINI_API_KEY'], ['vertex-ai', 'GOOGLE_API_KEY']]) {
    fs.writeFileSync(settings, JSON.stringify({ security: { auth: { selectedType: auth } } }))
    const keys = qwenDeclaredCredentialKeys({ home, env })
    assert.deepEqual(keys, [key])
    assert.deepEqual(nativeCredentialState('qwen', { home, env, nativeCredentialKeys: keys }),
      { state: 'unknown', source: 'unverified' })
    assert.deepEqual(nativeCredentialState('qwen', { home, env: { ...env, [key]: 'selected' }, nativeCredentialKeys: keys }),
      { state: 'ready', source: 'native-credential' })
  }
})

test('Qwen OAuth readiness ignores unrelated provider keys', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-qwen-oauth-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const root = path.join(home, '.qwen')
  fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'qwen-oauth' } } }))
  const env = { HOME: home, QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(home, 'missing.json'), OPENAI_API_KEY: 'unrelated' }
  assert.deepEqual(nativeCredentialState('qwen', { home, env }), { state: 'unknown', source: 'unverified' })
  fs.writeFileSync(path.join(root, 'oauth_creds.json'), JSON.stringify({ access_token: 'oauth-token' }))
  assert.deepEqual(nativeCredentialState('qwen', { home, env }), { state: 'ready', source: 'native-credential' })
})

test('Qwen infers native auth from complete environment combinations', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-qwen-env-auth-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const env = { HOME: home, QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(home, 'missing.json'),
    OPENAI_API_KEY: 'unrelated', OPENAI_MODEL: 'model', OPENAI_BASE_URL: 'https://example.test' }
  assert.deepEqual(qwenDeclaredCredentialKeys({ home, env }), ['OPENAI_API_KEY'])
  const oauthEnv = { ...env, QWEN_OAUTH: '1' }
  assert.deepEqual(qwenDeclaredCredentialKeys({ home, env: oauthEnv }), [])
  assert.deepEqual(nativeCredentialState('qwen', { home, env: oauthEnv }), { state: 'unknown', source: 'unverified' })
  const native = nativeCredentialEnvironment('qwen', oauthEnv, [])
  const child = childEnvironment({ kind: 'qwen' }, home, { env: native, nativeCredentialKeys: [] }, 'darwin')
  assert.equal(child.QWEN_OAUTH, '1')
  assert.deepEqual(qwenDeclaredCredentialKeys({ home, env: child }), [])
  assert.deepEqual(nativeCredentialState('qwen', { home, env: child }), { state: 'unknown', source: 'unverified' })
  fs.mkdirSync(path.join(home, '.qwen'))
  fs.writeFileSync(path.join(home, '.qwen', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'openai' } } }))
  assert.deepEqual(qwenDeclaredCredentialKeys({ home, env: oauthEnv }), ['OPENAI_API_KEY'])
})

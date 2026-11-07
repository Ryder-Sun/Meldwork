const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { geminiNativeAuth } = require('../../../src/agents/cli/gemini-native-config.cjs')
const { nativeCredentialState } = require('../../../src/agents/local-agent-readiness.cjs')

test('Gemini resolves auth through native settings and workspace trust', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-gemini-auth-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const root = path.join(home, '.gemini')
  const project = path.join(home, 'project')
  fs.mkdirSync(root)
  fs.mkdirSync(path.join(project, '.gemini'), { recursive: true })
  const defaults = path.join(home, 'defaults.json')
  const system = path.join(home, 'system.json')
  const env = { GEMINI_CLI_SYSTEM_SETTINGS_PATH: system, GEMINI_CLI_SYSTEM_DEFAULTS_PATH: defaults }
  const write = (file, auth) => fs.writeFileSync(file, JSON.stringify({ security: { auth: { selectedType: auth } } }))
  write(defaults, 'oauth-personal')
  write(path.join(root, 'settings.json'), 'gemini-api-key')
  write(path.join(project, '.gemini', 'settings.json'), 'vertex-ai')
  assert.equal(geminiNativeAuth({ home, env, workdir: project }).authType, 'gemini-api-key')
  fs.writeFileSync(path.join(root, 'trustedFolders.json'), JSON.stringify({ [project]: 'TRUST_FOLDER' }))
  assert.equal(geminiNativeAuth({ home, env, workdir: project }).authType, 'vertex-ai')
  assert.equal(geminiNativeAuth({ home, env: { ...env, GEMINI_RESTRICTED_MODE: 'true' }, workdir: project }).authType, 'gemini-api-key')
  assert.equal(geminiNativeAuth({ home, env: { ...env, GEMINI_CLI_AUTH_OVERRIDE: 'oauth-personal' } }).authType, 'oauth-personal')
  write(system, 'vertex-ai')
  assert.equal(geminiNativeAuth({ home, env: { ...env, GEMINI_CLI_AUTH_OVERRIDE: 'oauth-personal' }, workdir: project }).authType, 'vertex-ai')
})

test('Gemini readiness checks credentials for its selected auth mode', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-gemini-ready-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const root = path.join(home, '.gemini')
  fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, 'oauth_creds.json'), JSON.stringify({ refresh_token: 'oauth-token' }))
  const noSelection = { GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(home, 'system.json'), GOOGLE_API_KEY: 'unrelated' }
  assert.deepEqual(nativeCredentialState('gemini', { home, env: noSelection }), { state: 'unknown', source: 'unverified' })
  const env = { GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(home, 'system.json'), GEMINI_CLI_AUTH_OVERRIDE: 'oauth-personal', GEMINI_API_KEY: 'unrelated' }
  fs.unlinkSync(path.join(root, 'oauth_creds.json'))
  assert.deepEqual(nativeCredentialState('gemini', { home, env }), { state: 'unknown', source: 'unverified' })
  fs.writeFileSync(path.join(root, 'oauth_creds.json'), JSON.stringify({ refresh_token: 'oauth-token' }))
  assert.deepEqual(nativeCredentialState('gemini', { home, env }), { state: 'ready', source: 'native-credential' })
  env.GEMINI_CLI_AUTH_OVERRIDE = 'gemini-api-key'
  assert.deepEqual(nativeCredentialState('gemini', { home, env }), { state: 'ready', source: 'native-credential' })
  env.GEMINI_CLI_AUTH_OVERRIDE = 'vertex-ai'
  assert.deepEqual(nativeCredentialState('gemini', { home, env }), { state: 'unknown', source: 'unverified' })
  env.GEMINI_CLI_AUTH_OVERRIDE = 'gemini-api-key'
  delete env.GEMINI_API_KEY
  assert.deepEqual(nativeCredentialState('gemini', { home, env }), { state: 'unknown', source: 'unverified' })
})

test('Gemini auth inference and overrides follow native CLI precedence', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-gemini-inferred-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const env = { GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(home, 'missing.json'), GEMINI_API_KEY: 'unrelated' }
  assert.equal(geminiNativeAuth({ home, env }).authType, 'gemini-api-key')
  assert.equal(geminiNativeAuth({ home, env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: env.GEMINI_CLI_SYSTEM_SETTINGS_PATH,
    CLOUD_SHELL: 'true' } }).authType, 'compute-default-credentials')
  for (const [extra, expected] of [[{ GOOGLE_GENAI_USE_GCA: 'true' }, 'oauth-personal'],
    [{ GOOGLE_GENAI_USE_VERTEXAI: 'true' }, 'vertex-ai'], [{ GOOGLE_GEMINI_BASE_URL: 'https://example.test' }, 'gateway'],
    [{ GEMINI_CLI_AUTH_OVERRIDE: 'cloud-shell' }, 'cloud-shell'], [{ GEMINI_CLI_AUTH_OVERRIDE: 'gateway' }, 'gateway']]) {
    const selected = { ...env, ...extra }
    assert.equal(geminiNativeAuth({ home, env: selected }).authType, expected)
    assert.deepEqual(nativeCredentialState('gemini', { home, env: selected }), { state: 'unknown', source: 'unverified' })
  }
})

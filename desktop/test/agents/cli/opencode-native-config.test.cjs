const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { opencodeDeclaredCredentialKeys } = require('../../../src/agents/cli/opencode-native-config.cjs')

test('OpenCode discovers native provider references in global, explicit, inline and project configurations', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-opencode-config-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const global = path.join(home, 'config', 'opencode')
  const project = path.join(home, 'project')
  const workdir = path.join(project, 'src')
  fs.mkdirSync(global, { recursive: true })
  fs.mkdirSync(workdir, { recursive: true })
  fs.mkdirSync(path.join(project, '.git'))
  fs.writeFileSync(path.join(global, 'opencode.jsonc'), '{ // comment {env:IGNORED}\n provider: { one: { options: { apiKey: "{env:GLOBAL_SECRET}" } } } }')
  fs.writeFileSync(path.join(project, 'opencode.json'), JSON.stringify({ provider: { two: {
    options: { headers: { Authorization: 'Bearer {env:PROJECT_SECRET}' }, apiKey: '{env:NODE_OPTIONS}' },
  } }, instructions: ['{env:UNRELATED_SECRET}'] }))
  fs.writeFileSync(path.join(home, 'explicit.json'), JSON.stringify({ model: '{env:MODEL_CHOICE}' }))
  const env = { XDG_CONFIG_HOME: path.join(home, 'config'), OPENCODE_CONFIG: path.join(home, 'explicit.json'),
    OPENCODE_CONFIG_CONTENT: '{ provider: { three: { options: { apiKey: "{env:INLINE_SECRET}" } } } }' }
  assert.deepEqual(opencodeDeclaredCredentialKeys({ home, workdir, env }),
    ['GLOBAL_SECRET', 'INLINE_SECRET', 'MODEL_CHOICE', 'PROJECT_SECRET'])
  assert.deepEqual(opencodeDeclaredCredentialKeys({ home, env }), ['GLOBAL_SECRET', 'INLINE_SECRET', 'MODEL_CHOICE'])
})

test('OpenCode discovers env names for selected native model providers only', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-opencode-providers-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const config = path.join(home, 'config', 'opencode')
  const cache = path.join(home, 'cache', 'opencode')
  fs.mkdirSync(config, { recursive: true })
  fs.mkdirSync(cache, { recursive: true })
  fs.writeFileSync(path.join(config, 'opencode.json'), JSON.stringify({ model: 'deepseek/model', small_model: 'groq/fast' }))
  fs.writeFileSync(path.join(cache, 'models.json'), JSON.stringify({
    deepseek: { env: ['DEEPSEEK_API_KEY', 'NODE_OPTIONS'] }, groq: { env: ['GROQ_API_KEY'] },
    unrelated: { env: ['UNRELATED_API_KEY'] },
  }))
  const env = { XDG_CONFIG_HOME: path.dirname(config), XDG_CACHE_HOME: path.dirname(cache),
    DEEPSEEK_API_KEY: 'deepseek-test', GROQ_API_KEY: 'groq-test', UNRELATED_API_KEY: 'unrelated-test' }
  const keys = opencodeDeclaredCredentialKeys({ home, env })
  assert.deepEqual(keys, ['DEEPSEEK_API_KEY', 'GROQ_API_KEY'])
  const { resolveNativeShellEnvironment, nativeCredentialEnvironment } = require('../../../src/agents/local-agent-readiness.cjs')
  const { childEnvironment } = require('../../../src/agents/cli/cli-process-support.cjs')
  const captured = await resolveNativeShellEnvironment({ platform: 'win32', env, extraEnvKeys: keys, cache: false })
  const selected = nativeCredentialEnvironment('opencode', captured.env, keys)
  const child = childEnvironment({ kind: 'opencode' }, home, { env: selected, nativeCredentialKeys: keys }, 'darwin')
  assert.equal(child.DEEPSEEK_API_KEY, 'deepseek-test')
  assert.equal(child.GROQ_API_KEY, 'groq-test')
  assert.equal(child.UNRELATED_API_KEY, undefined)
  fs.writeFileSync(path.join(cache, 'models.json'), '{invalid')
  assert.deepEqual(opencodeDeclaredCredentialKeys({ home, env }), [])
})

test('OpenCode discovers recent native providers only when no model is configured', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-opencode-recent-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const cache = path.join(home, 'cache', 'opencode')
  const state = path.join(home, 'state', 'opencode')
  const config = path.join(home, 'config', 'opencode')
  for (const dir of [cache, state, config]) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(cache, 'models.json'), JSON.stringify({
    deepseek: { env: ['DEEPSEEK_API_KEY'] }, groq: { env: ['GROQ_API_KEY'] },
  }))
  fs.writeFileSync(path.join(state, 'model.json'), JSON.stringify({ recent: [
    { providerID: 'deepseek', modelID: 'model' }, { providerID: 'bad/name', modelID: 'model' },
  ] }))
  const env = { XDG_CACHE_HOME: path.dirname(cache), XDG_STATE_HOME: path.dirname(state), XDG_CONFIG_HOME: path.dirname(config) }
  assert.deepEqual(opencodeDeclaredCredentialKeys({ home, env }), ['DEEPSEEK_API_KEY'])
  fs.writeFileSync(path.join(config, 'opencode.json'), JSON.stringify({ model: 'groq/model' }))
  assert.deepEqual(opencodeDeclaredCredentialKeys({ home, env }), ['GROQ_API_KEY'])
  fs.writeFileSync(path.join(state, 'model.json'), '{invalid')
  fs.rmSync(path.join(config, 'opencode.json'))
  assert.deepEqual(opencodeDeclaredCredentialKeys({ home, env }), [])
})

test('OpenCode resolves an env-selected native model to its provider credential name', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-opencode-model-env-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const cache = path.join(home, '.cache', 'opencode')
  fs.mkdirSync(cache, { recursive: true })
  fs.writeFileSync(path.join(cache, 'models.json'), JSON.stringify({ groq: { env: ['GROQ_API_KEY'] } }))
  fs.writeFileSync(path.join(home, 'opencode.json'), JSON.stringify({ model: '{env:MODEL_CHOICE}' }))
  assert.deepEqual(opencodeDeclaredCredentialKeys({ home, workdir: home, env: {} }), ['MODEL_CHOICE'])
  assert.deepEqual(opencodeDeclaredCredentialKeys({ home, workdir: home, env: { MODEL_CHOICE: 'groq/model' } }),
    ['GROQ_API_KEY', 'MODEL_CHOICE'])
})

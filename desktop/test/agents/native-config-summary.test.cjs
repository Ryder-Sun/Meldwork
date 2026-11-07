const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { nativeUserConfigSummary } = require('../../src/agents/native-config-summary.cjs')

test('native summaries expose only the selected user configuration field', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-config-summary-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const selected = path.join(root, 'selected')
  fs.mkdirSync(path.join(selected, '.qwen'), { recursive: true })
  fs.mkdirSync(path.join(selected, '.zcode', 'cli'), { recursive: true })
  fs.writeFileSync(path.join(selected, '.qwen', 'settings.json'), "{ security: { auth: { selectedType: 'openai', apiKey: 'private-secret' } } }")
  fs.writeFileSync(path.join(selected, '.zcode', 'cli', 'config.json'), JSON.stringify({
    model: { main: 'custom/model' }, provider: { custom: { options: { apiKey: 'private-secret' } } },
  }))
  const options = { home: root, env: { HOME: selected,
    QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(root, 'system.json'),
    QWEN_CODE_SYSTEM_DEFAULTS_PATH: path.join(root, 'defaults.json') }, platform: 'darwin' }
  assert.deepEqual(nativeUserConfigSummary('qwen', options), { authType: 'openai' })
  assert.deepEqual(nativeUserConfigSummary('zcode', options), { provider: 'custom' })
  assert.doesNotMatch(JSON.stringify([nativeUserConfigSummary('qwen', options), nativeUserConfigSummary('zcode', options)]), /private-secret/)
  assert.deepEqual(nativeUserConfigSummary('zcode', { home: root, env: {}, platform: 'darwin' }), { provider: '' })
  fs.writeFileSync(path.join(selected, '.zcode', 'cli', 'config.json'), '{bad')
  assert.deepEqual(nativeUserConfigSummary('zcode', options), { provider: '' })
  fs.writeFileSync(path.join(selected, '.qwen', 'settings.json'), "{security:{auth:{selectedType:'unsafe secret'}}}")
  assert.deepEqual(nativeUserConfigSummary('qwen', options), { authType: '' })
})

test('Qwen summary follows native system, user, default and environment precedence', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-qwen-summary-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const user = path.join(root, '.qwen', 'settings.json')
  const system = path.join(root, 'system.json')
  const defaults = path.join(root, 'defaults.json')
  fs.mkdirSync(path.dirname(user), { recursive: true })
  const options = { home: root, env: { HOME: root, QWEN_CODE_SYSTEM_SETTINGS_PATH: system,
    QWEN_CODE_SYSTEM_DEFAULTS_PATH: defaults, QWEN_DEFAULT_AUTH_TYPE: 'environment' } }
  const write = (file, selectedType) => fs.writeFileSync(file, JSON.stringify({ security: { auth: { selectedType } } }))
  assert.deepEqual(nativeUserConfigSummary('qwen', options), { authType: 'environment' })
  write(defaults, 'default')
  assert.deepEqual(nativeUserConfigSummary('qwen', options), { authType: 'default' })
  write(user, 'user')
  assert.deepEqual(nativeUserConfigSummary('qwen', options), { authType: 'user' })
  write(system, 'system')
  assert.deepEqual(nativeUserConfigSummary('qwen', options), { authType: 'system' })
  fs.writeFileSync(system, '{bad')
  assert.deepEqual(nativeUserConfigSummary('qwen', options), { authType: '' })
})

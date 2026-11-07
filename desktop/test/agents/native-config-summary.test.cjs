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
  const options = { home: root, env: { HOME: selected }, platform: 'darwin' }
  assert.deepEqual(nativeUserConfigSummary('qwen', options), { authType: 'openai' })
  assert.deepEqual(nativeUserConfigSummary('zcode', options), { provider: 'custom' })
  assert.doesNotMatch(JSON.stringify([nativeUserConfigSummary('qwen', options), nativeUserConfigSummary('zcode', options)]), /private-secret/)
  assert.deepEqual(nativeUserConfigSummary('zcode', { home: root, env: {}, platform: 'darwin' }), { provider: '' })
  fs.writeFileSync(path.join(selected, '.zcode', 'cli', 'config.json'), '{bad')
  assert.deepEqual(nativeUserConfigSummary('zcode', options), { provider: '' })
  fs.writeFileSync(path.join(selected, '.qwen', 'settings.json'), "{security:{auth:{selectedType:'unsafe secret'}}}")
  assert.deepEqual(nativeUserConfigSummary('qwen', options), { authType: '' })
})

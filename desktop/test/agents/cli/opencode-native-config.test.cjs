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

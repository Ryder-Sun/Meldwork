const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { resolveNativeCredentialState } = require('../../../src/agents/local-agent-readiness.cjs')

test('MiMo selected native provider remains usable without signing in to the built-in account', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-mimo-selected-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const root = path.join(home, '.config', 'mimocode')
  fs.mkdirSync(root, { recursive: true })
  const config = { model: 'private/text', provider: { private: { options: { apiKey: 'synthetic-key' } } } }
  const file = path.join(root, 'mimocode.json')
  fs.writeFileSync(file, JSON.stringify(config))
  const probe = async () => ({ stdout: 'Not logged in. Run `mimo auth login` to log in.' })
  const options = { home, env: {}, executable: '/tmp/mimo', execFileFn: probe }
  const result = await resolveNativeCredentialState('mimo', options)
  assert.deepEqual(result, { state: 'ready', source: 'native-credential' })
  assert.equal(JSON.stringify(result).includes('synthetic-key'), false)
  config.model = 'unconfigured/text'
  fs.writeFileSync(file, JSON.stringify(config))
  assert.equal((await resolveNativeCredentialState('mimo', options)).state, 'missing')
  config.model = 'private/text'
  config.provider.private.options.apiKey = '{env:PRIVATE_MODEL_KEY}'
  fs.writeFileSync(file, JSON.stringify(config))
  assert.equal((await resolveNativeCredentialState('mimo', options)).state, 'missing')
  assert.equal((await resolveNativeCredentialState('mimo', { ...options, env: { PRIVATE_MODEL_KEY: 'native-env-value' } })).state, 'ready')
})

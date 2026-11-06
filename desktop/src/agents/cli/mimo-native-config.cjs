const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const JSON5 = require('json5')
const { nativeSecretEnvKeys } = require('./native-secret-environment.cjs')

function mimoProviderKey(options = {}) {
  const env = options.env || process.env
  const root = env.XDG_CONFIG_HOME || path.join(options.home || os.homedir(), '.config')
  try {
    const files = [path.join(root, 'mimocode', 'mimocode.json'), path.join(root, 'mimocode', 'mimocode.jsonc'),
      env.MIMOCODE_CONFIG, env.MIMOCODE_CONFIG_DIR && path.join(env.MIMOCODE_CONFIG_DIR, 'mimocode.json'),
      env.MIMOCODE_CONFIG_DIR && path.join(env.MIMOCODE_CONFIG_DIR, 'mimocode.jsonc')].filter(Boolean)
    const configs = []
    for (const file of files) {
      let stat
      try { stat = fs.statSync(file) } catch (error) {
        if (error.code === 'ENOENT') continue
        throw error
      }
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return ''
      configs.push(JSON5.parse(fs.readFileSync(file, 'utf8')))
    }
    if (env.MIMOCODE_CONFIG_CONTENT) {
      if (Buffer.byteLength(env.MIMOCODE_CONFIG_CONTENT) > 2 * 1024 * 1024) return ''
      configs.push(JSON5.parse(env.MIMOCODE_CONFIG_CONTENT))
    }
    let model = ''
    for (const config of configs) {
      if (typeof config?.model === 'string') model = config.model
    }
    if (!model.includes('/')) return ''
    const providerId = model.split('/')[0]
    let key
    for (const config of configs) {
      const options = config?.provider?.[providerId]?.options
      if (options && Object.hasOwn(options, 'apiKey')) key = options.apiKey
    }
    if (typeof key !== 'string' || !key.trim()) return ''
    return key
  } catch { return '' }
}

function mimoDeclaredCredentialKeys(options = {}) {
  const reference = mimoProviderKey(options).match(/^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/)
  return nativeSecretEnvKeys(reference ? [reference[1]] : [])
}

function mimoConfiguredProvider(options = {}) {
  const env = options.env || process.env
  let key = mimoProviderKey(options)
  if (!key) return false
  const reference = key.match(/^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/)
  if (reference) key = nativeSecretEnvKeys([reference[1]]).length ? env[reference[1]] : ''
  else if (/^\{.*\}$/.test(key)) return false
  return typeof key === 'string' && Boolean(key.trim())
}

module.exports = { mimoConfiguredProvider, mimoDeclaredCredentialKeys }

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { nativeSecretEnvKeys } = require('./native-secret-environment.cjs')

function mimoProviderKey(options = {}) {
  const env = options.env || process.env
  const root = env.XDG_CONFIG_HOME || path.join(options.home || os.homedir(), '.config')
  try {
    const file = path.join(root, 'mimocode', 'mimocode.json')
    if (fs.statSync(file).size > 2 * 1024 * 1024) return ''
    const config = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof config.model !== 'string' || !config.model.includes('/')) return ''
    const provider = config.provider?.[config.model.split('/')[0]]
    const key = provider?.options?.apiKey
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

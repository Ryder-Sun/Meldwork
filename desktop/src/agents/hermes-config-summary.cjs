const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const yaml = require('js-yaml')
const { redactSecrets } = require('../security/secret-redaction.cjs')

function hermesProviderFromConfig(config, env = {}) {
  const model = config?.model && typeof config.model === 'object' && !Array.isArray(config.model) ? config.model : {}
  const providerText = value => typeof value === 'string' ? value.trim()
    : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : ''
  let provider = providerText(model.provider)
  for (const key of ['default', 'model', 'name']) {
    const nested = model[key]
    if (nested && typeof nested === 'object' && !Array.isArray(nested)
        && nested.provider && providerText(nested.provider) && (!provider || provider === 'auto')) provider = providerText(nested.provider)
  }
  if (!provider && config?.provider) provider = providerText(config.provider)
  return provider || (typeof env.HERMES_INFERENCE_PROVIDER === 'string' ? env.HERMES_INFERENCE_PROVIDER.trim() : '')
}

function hermesProviderEnvironment(root, env = {}) {
  if (!Object.hasOwn(env, 'HERMES_INFERENCE_PROVIDER')) {
    try {
      const file = path.join(root, '.env')
      const stat = fs.statSync(file)
      if (stat.isFile() && stat.size <= 1024 * 1024) {
        let provider = ''
        for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
          if (!/^\s*(?:export\s+)?HERMES_INFERENCE_PROVIDER\s*=/.test(line)) continue
          const match = line.match(/^\s*(?:export\s+)?HERMES_INFERENCE_PROVIDER\s*=\s*(?:"([A-Za-z0-9._:-]+)"|'([A-Za-z0-9._:-]+)'|([A-Za-z0-9._:-]+))\s*(?:#.*)?$/)
          provider = match ? match[1] || match[2] || match[3] : ''
        }
        if (provider) return { ...env, HERMES_INFERENCE_PROVIDER: provider }
      }
    } catch { /* No readable native environment file. */ }
  }
  return env
}

function hermesConfiguredProvider(options = {}) {
  const env = options.env || process.env
  const home = options.home || os.homedir()
  const root = env.HERMES_HOME ? String(env.HERMES_HOME).replace(/^~(?=$|[\\/])/, home)
    : (options.platform || process.platform) === 'win32'
      ? path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), `hermes${env.HERMES_DATA_DIR_SUFFIX || ''}`)
      : path.join(home, `.hermes${env.HERMES_DATA_DIR_SUFFIX || ''}`)
  if (!path.isAbsolute(root)) return ''
  let config = {}
  try {
    const file = path.join(root, 'config.yaml')
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > 1024 * 1024) return ''
    config = yaml.load(fs.readFileSync(file, 'utf8')) || {}
    if (typeof config !== 'object' || Array.isArray(config)) return ''
  } catch (error) {
    if (error.code !== 'ENOENT') return ''
  }
  const value = hermesProviderFromConfig(config, hermesProviderEnvironment(root, env))
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value) && redactSecrets(value) === value ? value : ''
}

module.exports = { hermesConfiguredProvider, hermesProviderFromConfig, hermesProviderEnvironment }

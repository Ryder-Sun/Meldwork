const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const toml = require('@iarna/toml')
const { redactSecrets } = require('../security/secret-redaction.cjs')

function codexConfiguredProvider(options = {}) {
  const env = options.env || process.env
  const home = options.home || os.homedir()
  const root = env.CODEX_HOME ? String(env.CODEX_HOME).replace(/^~(?=$|[\\/])/, home) : path.join(home, '.codex')
  if (!path.isAbsolute(root)) return ''
  try {
    const file = path.join(root, 'config.toml')
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > 1024 * 1024) return ''
    const config = toml.parse(fs.readFileSync(file, 'utf8'))
    const profile = typeof config.profile === 'string' ? config.profiles?.[config.profile] : null
    const value = profile?.model_provider || config.model_provider
    if (typeof value !== 'string') return ''
    const provider = value.trim()
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(provider) && redactSecrets(provider) === provider ? provider : ''
  } catch { return '' }
}

module.exports = { codexConfiguredProvider }

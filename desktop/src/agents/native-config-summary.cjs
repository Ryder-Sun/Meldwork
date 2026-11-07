const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { redactSecrets } = require('../security/secret-redaction.cjs')
const { qwenConfiguredAuth } = require('./cli/qwen-native-config.cjs')

function nativeUserConfigSummary(kind, options = {}) {
  if (!['qwen', 'zcode'].includes(kind)) return null
  const env = options.env || process.env
  const platform = options.platform || process.platform
  const configuredHome = platform === 'win32' ? env.USERPROFILE : env.HOME
  const home = typeof configuredHome === 'string' && configuredHome.trim()
    ? configuredHome.trim() : (options.home || os.homedir())
  const field = kind === 'qwen' ? 'authType' : 'provider'
  const empty = { [field]: '' }
  if (!path.isAbsolute(home)) return empty
  try {
    let value
    if (kind === 'qwen') value = qwenConfiguredAuth(options)
    else {
      const envModel = typeof env.ZCODE_MODEL === 'string' ? env.ZCODE_MODEL.trim() : ''
      if (envModel) value = envModel.includes('/') ? envModel.split('/')[0] : 'anthropic'
      else {
        const file = path.join(home, '.zcode', 'cli', 'config.json')
        const stat = fs.statSync(file)
        if (!stat.isFile() || stat.size > 1024 * 1024) return empty
        const model = JSON.parse(fs.readFileSync(file, 'utf8'))?.model?.main
        value = typeof model === 'string' ? (model.includes('/') ? model.split('/')[0] : 'anthropic') : model?.provider
      }
    }
    if (typeof value !== 'string') return empty
    const text = value.trim()
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(text) && redactSecrets(text) === text
      ? { [field]: text } : empty
  } catch { return empty }
}

module.exports = { nativeUserConfigSummary }

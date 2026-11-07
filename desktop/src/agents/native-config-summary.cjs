const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const JSON5 = require('json5')
const { redactSecrets } = require('../security/secret-redaction.cjs')

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
    const file = kind === 'qwen' ? path.join(home, '.qwen', 'settings.json')
      : path.join(home, '.zcode', 'cli', 'config.json')
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > 1024 * 1024) return empty
    const contents = fs.readFileSync(file, 'utf8')
    const config = kind === 'qwen' ? JSON5.parse(contents) : JSON.parse(contents)
    const model = config?.model?.main
    const value = kind === 'qwen' ? config?.security?.auth?.selectedType
      : typeof model === 'string' && model.includes('/') ? model.split('/')[0] : model?.provider
    if (typeof value !== 'string') return empty
    const text = value.trim()
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(text) && redactSecrets(text) === text
      ? { [field]: text } : empty
  } catch { return empty }
}

module.exports = { nativeUserConfigSummary }

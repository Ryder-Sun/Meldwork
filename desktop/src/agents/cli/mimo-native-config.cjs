const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

function mimoConfiguredProvider(options = {}) {
  const env = options.env || process.env
  const root = env.XDG_CONFIG_HOME || path.join(options.home || os.homedir(), '.config')
  try {
    const file = path.join(root, 'mimocode', 'mimocode.json')
    if (fs.statSync(file).size > 2 * 1024 * 1024) return false
    const config = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof config.model !== 'string' || !config.model.includes('/')) return false
    const provider = config.provider?.[config.model.split('/')[0]]
    let key = provider?.options?.apiKey
    if (typeof key !== 'string' || !key.trim()) return false
    const reference = key.match(/^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/)
    if (reference) key = env[reference[1]]
    else if (/^\{.*\}$/.test(key)) return false
    return typeof key === 'string' && Boolean(key.trim())
  } catch { return false }
}

module.exports = { mimoConfiguredProvider }

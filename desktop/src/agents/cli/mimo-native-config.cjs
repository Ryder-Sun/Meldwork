const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const JSON5 = require('json5')
const { nativeSecretEnvKeys } = require('./native-secret-environment.cjs')

function projectDirectories(workdir) {
  if (typeof workdir !== 'string' || !path.isAbsolute(workdir)) return []
  const directories = []
  let current = path.resolve(workdir)
  for (let depth = 0; depth < 64; depth += 1) {
    directories.push(current)
    if (fs.existsSync(path.join(current, '.git'))) return directories.reverse()
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return directories.reverse()
}

function mimoProviderKey(options = {}) {
  const env = options.env || process.env
  const home = options.home || os.homedir()
  const root = env.XDG_CONFIG_HOME || path.join(home, '.config')
  try {
    const resolveNativePath = value => {
      if (!value || path.isAbsolute(value)) return value
      return typeof options.workdir === 'string' && path.isAbsolute(options.workdir)
        ? path.resolve(options.workdir, value) : null
    }
    const explicitFile = resolveNativePath(env.MIMOCODE_CONFIG)
    const explicitDirectory = resolveNativePath(env.MIMOCODE_CONFIG_DIR)
    if (explicitFile === null || explicitDirectory === null) return ''
    const projects = /^(?:1|true)$/i.test(env.MIMOCODE_DISABLE_PROJECT_CONFIG || '')
      ? [] : projectDirectories(options.workdir)
    const files = [path.join(root, 'mimocode', 'mimocode.json'), path.join(root, 'mimocode', 'mimocode.jsonc'),
      explicitFile, ...projects.flatMap(directory => [path.join(directory, 'mimocode.json'), path.join(directory, 'mimocode.jsonc')]),
      ...[...projects].reverse().flatMap(directory => [path.join(directory, '.mimocode', 'mimocode.json'), path.join(directory, '.mimocode', 'mimocode.jsonc')]),
      path.join(home, '.mimocode', 'mimocode.json'), path.join(home, '.mimocode', 'mimocode.jsonc'),
      explicitDirectory && path.join(explicitDirectory, 'mimocode.json'),
      explicitDirectory && path.join(explicitDirectory, 'mimocode.jsonc')].filter(Boolean)
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

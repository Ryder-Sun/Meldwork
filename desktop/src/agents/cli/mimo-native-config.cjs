const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createHash } = require('node:crypto')
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

function mimoConfigLayers(options = {}) {
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
    if (explicitFile === null || explicitDirectory === null) return null
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
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return null
      configs.push(JSON5.parse(fs.readFileSync(file, 'utf8')))
    }
    if (env.MIMOCODE_CONFIG_CONTENT) {
      if (Buffer.byteLength(env.MIMOCODE_CONFIG_CONTENT) > 2 * 1024 * 1024) return null
      configs.push(JSON5.parse(env.MIMOCODE_CONFIG_CONTENT))
    }
    return configs
  } catch { return null }
}

function mimoConfigurationFingerprint(options = {}) {
  const configs = mimoConfigLayers(options)
  if (configs === null) return null
  const recent = mimoModel(configs) ? null : mimoRecentModels(options.env || process.env, options.home || os.homedir())
  return createHash('sha256').update(JSON.stringify([configs, recent])).digest('hex')
}

function mimoModel(configs) {
  return configs.reduce((model, config) => typeof config?.model === 'string' ? config.model : model, '')
}

function mimoRecentModels(env, home) {
  const stateRoot = env.XDG_STATE_HOME || path.join(home, '.local', 'state')
  try {
    const filename = path.join(stateRoot, 'mimocode', 'model.json')
    const stat = fs.statSync(filename)
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return []
    const recent = JSON.parse(fs.readFileSync(filename, 'utf8'))?.recent
    return (Array.isArray(recent) ? recent.slice(0, 32) : [])
      .filter(item => typeof item?.providerID === 'string' && /^[A-Za-z0-9._-]+$/.test(item.providerID)
        && typeof item.modelID === 'string' && item.modelID)
      .map(item => ({ providerID: item.providerID, modelID: item.modelID }))
  } catch { return [] }
}

function mimoProviderIds(configs, env, home) {
  const configuredModel = mimoModel(configs)
  if (!configuredModel) return [...new Set(mimoRecentModels(env, home).map(item => item.providerID))]
  const model = configuredModel.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_match, name) => nativeSecretEnvKeys([name]).length ? env[name] || '' : '')
  return model.includes('/') && model.split('/')[0] ? [model.split('/')[0]] : []
}

function mimoProviderKeys(options = {}, configs = mimoConfigLayers(options)) {
  if (!configs) return []
  try {
    const result = []
    for (const providerId of mimoProviderIds(configs, options.env || process.env, options.home || os.homedir())) {
      let key
      for (const config of configs) {
        const options = config?.provider?.[providerId]?.options
        if (options && Object.hasOwn(options, 'apiKey')) key = options.apiKey
      }
      if (typeof key === 'string' && key.trim()) result.push(key)
    }
    return result
  } catch { return [] }
}

function mimoDeclaredCredentialKeys(options = {}) {
  const configs = mimoConfigLayers(options)
  if (!configs) return []
  const keys = []
  const visit = (value, depth = 0) => {
    if (depth > 32 || keys.length >= 128) return
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)) keys.push(match[1])
    } else if (value && typeof value === 'object') {
      for (const child of Object.values(value)) visit(child, depth + 1)
    }
  }
  visit(mimoModel(configs))
  const providerIds = mimoProviderIds(configs, options.env || process.env, options.home || os.homedir())
  if (providerIds.length) {
    const merge = (current, incoming, depth = 0) => {
      if (depth > 32 || !incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming
      const result = current && typeof current === 'object' && !Array.isArray(current)
        ? current : Object.create(null)
      for (const [key, value] of Object.entries(incoming)) {
        result[key] = merge(result[key], value, depth + 1)
      }
      return result
    }
    for (const providerId of providerIds) {
      let provider = null
      for (const config of configs) {
        if (Object.hasOwn(config?.provider || {}, providerId)) provider = merge(provider, config.provider[providerId])
      }
      visit(provider)
    }
  }
  return nativeSecretEnvKeys(keys)
}

function mimoConfiguredProvider(options = {}) {
  const env = options.env || process.env
  return mimoProviderKeys(options).some(key => {
    let missing = false
    key = key.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => {
      const value = nativeSecretEnvKeys([name]).length ? env[name] : ''
      if (typeof value !== 'string' || !value.trim()) missing = true
      return value || ''
    })
    return !missing && !/^\{.*\}$/.test(key) && Boolean(key.trim())
  })
}

function mimoConfigSecrets(options = {}) {
  const configs = mimoConfigLayers(options)
  if (!configs) return []
  const secrets = new Set()
  const pending = configs.map(value => [value, 0])
  while (pending.length && secrets.size < 128) {
    const [value, depth] = pending.pop()
    if (!value || typeof value !== 'object' || depth > 32) continue
    for (const [key, item] of Object.entries(value)) {
      if (/(?:api[_-]?key|access[_-]?key|token|secret|password|authorization)$/i.test(key)
          && typeof item === 'string' && item && item.length <= 8192 && !/^\{(?:env|file):[^}]+\}$/.test(item)) {
        secrets.add(item)
        const bearer = item.match(/^Bearer\s+(\S+)$/i)
        if (bearer) secrets.add(bearer[1])
      } else if (item && typeof item === 'object') pending.push([item, depth + 1])
    }
  }
  return [...secrets]
}

module.exports = { mimoConfigurationFingerprint, mimoConfiguredProvider, mimoDeclaredCredentialKeys, mimoConfigSecrets }

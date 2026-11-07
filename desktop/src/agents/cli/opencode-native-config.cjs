const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const JSON5 = require('json5')
const { nativeSecretEnvKeys } = require('./native-secret-environment.cjs')

function opencodeDeclaredCredentialKeys(options = {}) {
  const env = options.env || process.env
  const home = options.home || os.homedir()
  const workdir = typeof options.workdir === 'string' && path.isAbsolute(options.workdir)
    ? options.workdir : ''
  const resolvePath = value => {
    if (typeof value !== 'string' || !value) return ''
    const expanded = value.replace(/^~(?=$|[\\/])/, home)
    return path.isAbsolute(expanded) ? expanded : workdir ? path.resolve(workdir, expanded) : ''
  }
  const configRoot = env.XDG_CONFIG_HOME || path.join(home, '.config')
  const roots = [path.join(configRoot, 'opencode'), resolvePath(env.OPENCODE_CONFIG_DIR)].filter(Boolean)
  const files = roots.flatMap(root => ['opencode.json', 'opencode.jsonc'].map(name => path.join(root, name)))
  const explicit = resolvePath(env.OPENCODE_CONFIG)
  if (explicit) files.push(explicit)
  if (workdir) {
    let current = path.resolve(workdir)
    for (let depth = 0; depth < 64; depth += 1) {
      files.push(...['opencode.json', 'opencode.jsonc'].map(name => path.join(current, name)))
      files.push(...['opencode.json', 'opencode.jsonc'].map(name => path.join(current, '.opencode', name)))
      if (fs.existsSync(path.join(current, '.git'))) break
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  const configs = []
  for (const file of new Set(files)) {
    try {
      const stat = fs.statSync(file)
      if (stat.isFile() && stat.size <= 2 * 1024 * 1024) configs.push(JSON5.parse(fs.readFileSync(file, 'utf8')))
    } catch { /* Invalid or missing native configs are diagnosed by OpenCode. */ }
  }
  if (typeof env.OPENCODE_CONFIG_CONTENT === 'string'
      && Buffer.byteLength(env.OPENCODE_CONFIG_CONTENT) <= 2 * 1024 * 1024) {
    try { configs.push(JSON5.parse(env.OPENCODE_CONFIG_CONTENT)) } catch { /* Native CLI reports invalid content. */ }
  }
  const keys = []
  const visit = (value, depth = 0) => {
    if (depth > 32) return
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)) keys.push(match[1])
    } else if (value && typeof value === 'object') {
      for (const child of Object.values(value)) visit(child, depth + 1)
    }
  }
  for (const config of configs) {
    visit(config?.provider)
    visit(config?.providers)
    visit(config?.model)
    visit(config?.small_model)
  }
  const resolveModel = model => typeof model === 'string'
    ? model.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => env[name] || '') : model
  const providers = new Set(configs.flatMap(config => [resolveModel(config?.model), resolveModel(config?.small_model)])
    .filter(model => typeof model === 'string' && /^[A-Za-z0-9._-]+\/.+/.test(model))
    .map(model => model.slice(0, model.indexOf('/'))))
  const hasConfiguredModel = configs.some(config => typeof config?.model === 'string' && config.model)
  if (!hasConfiguredModel) {
    const stateRoot = env.XDG_STATE_HOME || path.join(home, '.local', 'state')
    const filename = path.join(stateRoot, 'opencode', 'model.json')
    try {
      const stat = fs.statSync(filename)
      if (stat.isFile() && stat.size <= 2 * 1024 * 1024) {
        const recent = JSON.parse(fs.readFileSync(filename, 'utf8'))?.recent
        if (Array.isArray(recent)) {
          for (const item of recent.slice(0, 32)) {
            if (typeof item?.providerID === 'string' && /^[A-Za-z0-9._-]+$/.test(item.providerID)
                && typeof item.modelID === 'string' && item.modelID) providers.add(item.providerID)
          }
        }
      }
    } catch { /* No usable recent native model is available. */ }
  }
  if (providers.size || !hasConfiguredModel) {
    const cacheRoot = env.XDG_CACHE_HOME || path.join(home, '.cache')
    const filename = path.join(cacheRoot, 'opencode', 'models.json')
    try {
      const stat = fs.statSync(filename)
      if (stat.isFile() && stat.size <= 16 * 1024 * 1024) {
        const metadata = JSON.parse(fs.readFileSync(filename, 'utf8'))
        const candidates = hasConfiguredModel ? [...providers] : Object.keys(metadata).slice(0, 1024)
        for (const provider of candidates) {
          const declared = Object.hasOwn(metadata, provider) ? metadata[provider]?.env : null
          if (Array.isArray(declared)) keys.push(...declared.slice(0, 128))
          if (keys.length >= 1024) break
        }
      }
    } catch { /* Missing or invalid native metadata is handled by OpenCode. */ }
  }
  const safeKeys = []
  for (let index = 0; index < Math.min(keys.length, 1024); index += 128) {
    safeKeys.push(...nativeSecretEnvKeys(keys.slice(index, index + 128)))
  }
  return [...new Set(safeKeys)].sort()
}

module.exports = { opencodeDeclaredCredentialKeys }

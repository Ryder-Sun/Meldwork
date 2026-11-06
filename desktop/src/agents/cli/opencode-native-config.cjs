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
  return nativeSecretEnvKeys(keys)
}

module.exports = { opencodeDeclaredCredentialKeys }

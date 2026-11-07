const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const yaml = require('js-yaml')
const { nativeSecretEnvKeys, configSecrets } = require('./native-secret-environment.cjs')
// DSH supports JavaScript-tagged scalar expressions; inspect them as inert text.
const patchSchema = yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar', construct: value => value,
})])

function deepseekConfigurationFingerprint(options = {}) {
  const env = options.env || process.env
  const home = options.home || os.homedir()
  const root = typeof env.DSH_HOME === 'string' && env.DSH_HOME ? env.DSH_HOME.replace(/^~(?=$|[\\/])/, home) : path.join(home, '.dsh')
  if (!path.isAbsolute(root)) return null
  const files = ['cordis.patch.yml', '.credentials.yaml', 'profiles/acp/cordis.patch.yml',
    'profiles/acp/.credentials.yaml']
  const entries = []
  for (const file of files) {
    try {
      const filename = path.join(root, file)
      const stat = fs.statSync(filename)
      if (!stat.isFile() || stat.size > 1024 * 1024) return null
      entries.push([file, createHash('sha256').update(fs.readFileSync(filename)).digest('hex')])
    } catch (error) {
      if (error.code !== 'ENOENT') return null
      entries.push([file, null])
    }
  }
  return createHash('sha256').update(JSON.stringify([root, entries])).digest('hex')
}

function deepseekNativeSecrets(options = {}) {
  const env = options.env || process.env
  const home = options.home || os.homedir()
  const root = typeof env.DSH_HOME === 'string' && env.DSH_HOME
    ? env.DSH_HOME.replace(/^~(?=$|[\\/])/, home) : path.join(home, '.dsh')
  if (!path.isAbsolute(root)) return []
  const secrets = new Set()
  const add = value => {
    if (typeof value === 'string' && value && value.length <= 8192) secrets.add(value)
  }
  for (const file of ['.credentials.yaml', 'profiles/acp/.credentials.yaml',
    'cordis.patch.yml', 'profiles/acp/cordis.patch.yml']) {
    try {
      const filename = path.join(root, file)
      const stat = fs.statSync(filename)
      if (!stat.isFile() || stat.size > 1024 * 1024) continue
      const document = yaml.load(fs.readFileSync(filename, 'utf8'), { schema: patchSchema })
      for (const value of configSecrets([document])) add(value)
      if (!file.endsWith('.credentials.yaml') || !document || typeof document !== 'object') continue
      if (document.refs && typeof document.refs === 'object' && !Array.isArray(document.refs)) {
        for (const value of Object.values(document.refs)) add(value)
      }
      if (document.records && typeof document.records === 'object' && !Array.isArray(document.records)) {
        for (const record of Object.values(document.records)) {
          if (record?.kind === 'api-key') add(record.key)
        }
      }
    } catch { /* The CLI handles unreadable or invalid native configuration. */ }
  }
  return [...secrets]
}

function deepseekDefaultCredentialConfigured(options = {}) {
  const env = options.env || process.env
  const home = options.home || os.homedir()
  const root = typeof env.DSH_HOME === 'string' && env.DSH_HOME
    ? env.DSH_HOME.replace(/^~(?=$|[\\/])/, home) : path.join(home, '.dsh')
  if (!path.isAbsolute(root)) return false
  const mapping = value => value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  const jsonValue = (value, seen = new Set(), depth = 0) => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
    if (typeof value === 'number') return Number.isFinite(value)
    if (depth > 32 || (!Array.isArray(value) && !mapping(value)) || seen.has(value)) return false
    seen.add(value)
    const valid = Object.values(value).every(item => jsonValue(item, seen, depth + 1))
    seen.delete(value)
    return valid
  }
  const validEnv = value => mapping(value) && Object.entries(value).every(([key, item]) => (
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof item === 'string' && item.length > 0
  ))
  try {
    const filename = path.join(root, '.credentials.yaml')
    const stat = fs.statSync(filename)
    if (!stat.isFile() || stat.size > 1024 * 1024
        || ((options.platform || process.platform) !== 'win32' && (stat.mode & 0o077))) return false
    const document = yaml.load(fs.readFileSync(filename, 'utf8'))
    if (!mapping(document) || document.version !== 1
        || (document.refs !== undefined && !validEnv(document.refs))
        || (document.records !== undefined && !mapping(document.records))) return false
    for (const [key, record] of Object.entries(document.records || {})) {
      if (!/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/.test(key) || !mapping(record)) return false
      if (record.kind === 'api-key') {
        if (Object.keys(record).some(field => !['kind', 'key', 'env'].includes(field))
            || (record.key !== undefined && (typeof record.key !== 'string' || !record.key.length))
            || (record.env !== undefined && !validEnv(record.env))) return false
      } else if (record.kind === 'grant') {
        if (Object.keys(record).some(field => !['kind', 'payload'].includes(field))
            || !Object.hasOwn(record, 'payload') || !jsonValue(record.payload)) return false
      } else return false
    }
    const credential = document.refs?.ZGCI_API_KEY
    return typeof credential === 'string' && /^[\x21-\x7e]+$/.test(credential)
  } catch { return false }
}

function deepseekNativeConfig(options = {}) {
  const env = options.env || process.env
  const home = options.home || os.homedir()
  const root = typeof env.DSH_HOME === 'string' && env.DSH_HOME ? env.DSH_HOME.replace(/^~(?=$|[\\/])/, home) : path.join(home, '.dsh')
  if (!path.isAbsolute(root)) return { explicitModel: true, credentialKeys: [] }
  const files = [path.join(root, 'profiles', 'acp', 'cordis.patch.yml'), path.join(root, 'cordis.patch.yml')]
  const keys = []
  let explicitModel = false
  let provider = ''
  for (const filename of files) {
    let document
    try {
      const stat = fs.statSync(filename)
      if (!stat.isFile() || stat.size > 1024 * 1024) return { explicitModel: true, credentialKeys: [] }
      document = yaml.load(fs.readFileSync(filename, 'utf8'), { schema: patchSchema })
    } catch (error) {
      if (error.code === 'ENOENT') continue
      return { explicitModel: true, credentialKeys: [] }
    }
    const pending = [document]
    const seen = new Set()
    while (pending.length) {
      const node = pending.pop()
      if (!node || typeof node !== 'object' || seen.has(node)) continue
      seen.add(node)
      if (node.id === 'acp' && node.config && typeof node.config === 'object') {
        if (['provider', 'model'].some(key => typeof node.config[key] === 'string' && node.config[key].trim())) explicitModel = true
        if (typeof node.config.provider === 'string' && node.config.provider.trim()) provider = node.config.provider.trim()
      }
      if (typeof node.apiKeyEnv === 'string') keys.push(node.apiKeyEnv)
      pending.push(...Object.values(node).reverse())
    }
  }
  if (explicitModel && (!provider || provider === 'deepseek-official')) keys.push('DEEPSEEK_API_KEY')
  return { explicitModel, credentialKeys: nativeSecretEnvKeys(keys) }
}

module.exports = { deepseekNativeConfig, deepseekConfigurationFingerprint, deepseekDefaultCredentialConfigured, deepseekNativeSecrets }

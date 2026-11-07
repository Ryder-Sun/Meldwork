const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const yaml = require('js-yaml')
const { nativeSecretEnvKeys } = require('./native-secret-environment.cjs')
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

module.exports = { deepseekNativeConfig, deepseekConfigurationFingerprint }

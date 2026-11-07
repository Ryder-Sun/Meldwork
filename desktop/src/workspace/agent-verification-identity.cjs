const { createHash, randomBytes } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { npmShimTarget } = require('../agents/cli/cli-discovery.cjs')
const { credentialLiteral } = require('../agents/cli/native-secret-environment.cjs')
const { NATIVE_CONFIG_DIRECTORIES, NATIVE_CONFIG_IDENTITY_DIRECTORY, NATIVE_ENVIRONMENT_IDENTITY, NATIVE_AUTH_IDENTITY_FILES, NATIVE_PROJECT_CONFIG_PATHS } = require('../agents/native-config-directory.cjs')

function fileIdentity(filename) {
  try {
    const stat = fs.statSync(filename)
    return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]
  } catch (error) {
    return error?.code === 'ENOENT' ? null : ['unreadable', randomBytes(32).toString('hex')]
  }
}

function selectedConfigurationIdentity(agent, preferences) {
  const directory = preferences?.[agent.kind]?.nativeConfigDirectory || agent[NATIVE_CONFIG_IDENTITY_DIRECTORY]
  const spec = Object.hasOwn(NATIVE_CONFIG_DIRECTORIES, agent.kind) ? NATIVE_CONFIG_DIRECTORIES[agent.kind] : null
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || !spec) return null
  const entries = [['directory', directory], ...[...spec.files, ...(spec.identityFiles || [])]
    .map(name => [name, fileIdentity(path.join(directory, name))])]
  for (const name of spec.directories || []) {
    const root = path.join(directory, name)
    let children = []
    try {
      children = fs.readdirSync(root).sort()
      if (children.length > 256) return ['unbounded-directory', randomBytes(32).toString('hex')]
    } catch (error) {
      if (error.code !== 'ENOENT') return ['unreadable-directory', randomBytes(32).toString('hex')]
    }
    entries.push([name, fileIdentity(root), children.map(child => {
      const childPath = path.join(root, child)
      const nested = agent.kind === 'deepseek' && name === 'profiles'
        ? ['cordis.yml', 'cordis.patch.yml', '.credentials.yaml']
          .map(file => [file, fileIdentity(path.join(childPath, file))]) : null
      return [child, fileIdentity(childPath), nested]
    })])
  }
  return entries
}

function geminiAccessTokenExpired(agent, preferences, now) {
  const directory = preferences?.gemini?.nativeConfigDirectory || agent[NATIVE_CONFIG_IDENTITY_DIRECTORY]
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) return false
  try {
    const filename = path.join(directory, 'oauth_creds.json')
    const stat = fs.statSync(filename)
    if (!stat.isFile() || stat.size > 1024 * 1024) return false
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'))
    if (credentialLiteral(value?.refresh_token)) return false
    return credentialLiteral(value?.access_token)
      && typeof value.expiry_date === 'number' && Number.isFinite(value.expiry_date)
      && value.expiry_date > 0 && value.expiry_date <= now + 5 * 60 * 1000
  } catch { return false }
}

function agentVerificationIdentity(agent, preferences = {}, options = {}) {
  if (!agent?.kind) return ''
  let executableStat = null
  if (agent.executable) {
    try {
      const stat = fs.statSync(agent.executable)
      executableStat = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]
    } catch { /* unavailable paths are still bound to their detected identity */ }
  }
  const identity = [
    agent.kind, agent.executable || '', agent.version || '', executableStat,
    agent.connectorId || '', agent.connectorVersion || '', agent.upstreamVersion || '',
    preferences?.[agent.kind]?.nativeConfigDirectory || '',
  ]
  if ((options.platform || process.platform) === 'win32' && /\.(?:cmd|bat)$/i.test(agent.executable || '')) {
    try {
      const target = npmShimTarget(agent.executable, options)
      if (!target) throw new Error('invalid shim')
      const stat = (options.statFn || fs.statSync)(target)
      identity.push(['shim-target', target, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs])
    } catch {
      identity.push(['unavailable-shim-target', randomBytes(32).toString('hex')])
    }
  }
  const configuration = selectedConfigurationIdentity(agent, preferences)
  if (configuration !== null) identity.push(configuration)
  if (agent.kind === 'gemini' && geminiAccessTokenExpired(agent, preferences, options.now ?? Date.now())) {
    identity.push(['oauth-access-token-expired'])
  }
  if (Array.isArray(agent[NATIVE_AUTH_IDENTITY_FILES])) {
    identity.push(agent[NATIVE_AUTH_IDENTITY_FILES].filter(filename => typeof filename === 'string' && path.isAbsolute(filename))
      .map(filename => [filename, fileIdentity(filename)]))
  }
  if (agent[NATIVE_ENVIRONMENT_IDENTITY]) identity.push(agent[NATIVE_ENVIRONMENT_IDENTITY])
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

function projectVerificationIdentity(kind, workdir, agent = null, environmentIdentity = '') {
  const files = {
    codex: ['.codex/config.toml'],
    claude: ['.claude/settings.json', '.claude/settings.local.json'],
    zcode: ['zcode.json', '.zcode/config.json'],
    opencode: ['opencode.json', 'opencode.jsonc', '.opencode/opencode.json', '.opencode/opencode.jsonc'],
    mimo: ['mimocode.json', 'mimocode.jsonc', '.mimocode/mimocode.json', '.mimocode/mimocode.jsonc'],
    gemini: ['.gemini/settings.json', '.gemini/.env', '.env'],
    qwen: ['.qwen/settings.json', '.qwen/.env', '.env'],
    deepseek: ['.env'],
    pi: [],
  }[kind]
  if (!files && !environmentIdentity) return ''
  if (kind === 'pi' && !environmentIdentity && !agent?.[NATIVE_PROJECT_CONFIG_PATHS]?.length) return ''
  if (typeof workdir !== 'string' || !path.isAbsolute(workdir)) return null
  const root = path.resolve(workdir)
  if (root.length > 32767) return null
  try { if (!fs.statSync(root).isDirectory()) return null } catch { return null }
  const entries = [kind, root]
  if (environmentIdentity) entries.push(['native-environment', environmentIdentity])
  for (const item of agent?.[NATIVE_PROJECT_CONFIG_PATHS] || []) {
    if (!item || typeof item.value !== 'string' || path.isAbsolute(item.value)) continue
    const target = path.resolve(root, item.value)
    const names = kind === 'opencode' ? ['opencode.json', 'opencode.jsonc'] : ['mimocode.json', 'mimocode.jsonc']
    entries.push([target, item.directory ? names.map(name => [name, fileIdentity(path.join(target, name))]) : fileIdentity(target)])
  }
  let current = root
  for (;;) {
    entries.push([current, ...(files || []).map(file => [file, fileIdentity(path.join(current, file))])])
    if (kind === 'deepseek') break
    if (kind !== 'qwen' && kind !== 'gemini' && fs.existsSync(path.join(current, '.git'))) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

module.exports = { agentVerificationIdentity, projectVerificationIdentity }

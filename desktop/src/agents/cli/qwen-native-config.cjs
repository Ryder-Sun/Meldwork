const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const JSON5 = require('json5')
const { nativeSecretEnvKeys } = require('./native-secret-environment.cjs')

function qwenNativeSelection(options = {}) {
  const env = options.env || process.env
  const platform = options.platform || process.platform
  const configuredHome = platform === 'win32' ? env.USERPROFILE : env.HOME
  const home = typeof configuredHome === 'string' && configuredHome.trim() ? configuredHome.trim() : (options.home || os.homedir())
  const system = env.QWEN_CODE_SYSTEM_SETTINGS_PATH || (platform === 'darwin'
    ? '/Library/Application Support/QwenCode/settings.json' : platform === 'win32'
      ? 'C:\\ProgramData\\qwen-code\\settings.json' : '/etc/qwen-code/settings.json')
  const defaults = env.QWEN_CODE_SYSTEM_DEFAULTS_PATH || path.join(path.dirname(system), 'system-defaults.json')
  const resolveFile = file => path.isAbsolute(file) ? file
    : typeof options.workdir === 'string' && path.isAbsolute(options.workdir) ? path.resolve(options.workdir, file) : ''
  const user = path.join(home, '.qwen', 'settings.json')
  const project = options.workdir && path.isAbsolute(options.workdir) && path.resolve(options.workdir) !== path.resolve(home)
    ? path.join(options.workdir, '.qwen', 'settings.json') : ''
  let model = ''
  let auth = ''
  let inlineCredential = ''
  const providers = new Map()
  try {
    const configs = new Map()
    for (const entry of [defaults, user, project, system].filter(Boolean)) {
      const file = resolveFile(entry)
      if (!file) return { keys: [], unsupported: true }
      let stat
      try { stat = fs.statSync(file) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
      if (!stat.isFile() || stat.size > 1024 * 1024) return { keys: [], unsupported: true }
      const settings = JSON5.parse(fs.readFileSync(file, 'utf8'))
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { keys: [], unsupported: true }
      configs.set(entry, settings)
    }
    const trustEnabled = configs.get(system)?.security?.folderTrust?.enabled
      ?? configs.get(user)?.security?.folderTrust?.enabled ?? false
    let includeProject = trustEnabled === false
    if (project && trustEnabled === true) {
      const trustFile = resolveFile(env.GEMINI_CLI_TRUSTED_FOLDERS_PATH || path.join(home, '.qwen', 'trustedFolders.json'))
      try {
        const stat = fs.statSync(trustFile)
        const rules = stat.isFile() && stat.size <= 1024 * 1024 ? JSON5.parse(fs.readFileSync(trustFile, 'utf8')) : null
        const target = path.resolve(options.workdir)
        includeProject = Boolean(rules && typeof rules === 'object' && !Array.isArray(rules)
          && Object.entries(rules).some(([folder, level]) => {
            if (!path.isAbsolute(folder) || !['TRUST_FOLDER', 'TRUST_PARENT'].includes(level)) return false
            const root = path.resolve(level === 'TRUST_PARENT' ? path.dirname(folder) : folder)
            const relative = path.relative(root, target)
            return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
          }))
      } catch { includeProject = false }
    }
    for (const entry of [defaults, user, ...(includeProject && project ? [project] : []), system]) {
      const settings = configs.get(entry)
      if (!settings) continue
      if (typeof settings.model?.name === 'string') model = settings.model.name
      if (typeof settings.security?.auth?.selectedType === 'string') auth = settings.security.auth.selectedType
      if (Object.hasOwn(settings.security?.auth || {}, 'apiKey')) inlineCredential = settings.security.auth.apiKey
      if (settings.modelProviders && typeof settings.modelProviders === 'object' && !Array.isArray(settings.modelProviders)) {
        providers.clear()
        for (const [type, entries] of Object.entries(settings.modelProviders)) {
          if (Array.isArray(entries)) providers.set(type, entries)
        }
      }
    }
    if (!auth) {
      if (env.QWEN_OAUTH) auth = 'qwen-oauth'
      else if (env.OPENAI_API_KEY && env.OPENAI_MODEL && env.OPENAI_BASE_URL) auth = 'openai'
      else if (env.GEMINI_API_KEY && env.GEMINI_MODEL) auth = 'gemini'
      else if (env.GOOGLE_API_KEY && env.GOOGLE_MODEL) auth = 'vertex-ai'
      else if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_MODEL && env.ANTHROPIC_BASE_URL) auth = 'anthropic'
    }
    auth ||= typeof env.QWEN_DEFAULT_AUTH_TYPE === 'string' ? env.QWEN_DEFAULT_AUTH_TYPE : ''
    if (!auth) return { keys: [], unsupported: false, authType: '' }
    const selected = model ? (providers.get(auth) || []).filter(entry => entry?.id === model) : []
    if (selected.length > 1) return { keys: [], unsupported: true, authType: auth }
    if (selected[0]?.envKey) {
      const keys = nativeSecretEnvKeys([selected[0].envKey])
      return { keys, unsupported: keys.length === 0, authType: auth }
    }
    if (typeof inlineCredential === 'string' && inlineCredential.trim()) return { keys: [], unsupported: false, authType: auth }
    const defaultKeys = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY',
      gemini: 'GEMINI_API_KEY', 'vertex-ai': 'GOOGLE_API_KEY' }
    return { keys: nativeSecretEnvKeys([defaultKeys[auth]]), unsupported: false, authType: auth }
  } catch { return { keys: [], unsupported: true } }
}

function qwenCredentialSelection(options = {}) {
  const { keys, unsupported } = qwenNativeSelection(options)
  return { keys, unsupported }
}

function qwenConfiguredAuth(options = {}) {
  return qwenNativeSelection(options).authType || ''
}

function qwenDeclaredCredentialKeys(options = {}) {
  return qwenCredentialSelection(options).keys
}

module.exports = { qwenCredentialSelection, qwenDeclaredCredentialKeys, qwenConfiguredAuth }

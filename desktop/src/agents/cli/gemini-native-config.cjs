const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const JSON5 = require('json5')

function readSettings(file) {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('invalid settings')
    const value = JSON5.parse(fs.readFileSync(file, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid settings')
    return value
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
}

function geminiNativeAuth(options = {}) {
  const env = options.env || process.env
  const platform = options.platform || process.platform
  const home = options.home || os.homedir()
  const base = env.GEMINI_CLI_HOME || home
  const system = env.GEMINI_CLI_SYSTEM_SETTINGS_PATH || (platform === 'darwin'
    ? '/Library/Application Support/GeminiCli/settings.json' : platform === 'win32'
      ? 'C:\\ProgramData\\gemini-cli\\settings.json' : '/etc/gemini-cli/settings.json')
  const defaults = env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH || path.join(path.dirname(system), 'system-defaults.json')
  if (![base, system, defaults].every(value => typeof value === 'string' && path.isAbsolute(value))) return { uncertain: true }
  const root = path.join(base, '.gemini')
  try {
    const layers = [readSettings(defaults), readSettings(path.join(root, 'settings.json'))]
    const systemSettings = readSettings(system)
    const validOverrides = ['oauth-personal', 'gemini-api-key', 'vertex-ai', 'cloud-shell', 'compute-default-credentials', 'gateway']
    const override = validOverrides.includes(env.GEMINI_CLI_AUTH_OVERRIDE) ? env.GEMINI_CLI_AUTH_OVERRIDE : ''
    let authType = override || (layers[1].security?.auth?.selectedType ?? layers[0].security?.auth?.selectedType ?? '')
    const workdir = typeof options.workdir === 'string' && path.isAbsolute(options.workdir) ? options.workdir : ''
    if (workdir && path.resolve(workdir) !== path.resolve(base)) {
      let trusted = env.GEMINI_CLI_TRUST_WORKSPACE === 'true'
      if (env.GEMINI_RESTRICTED_MODE === 'true' || env.GEMINI_CLI_TRUST_WORKSPACE === 'false') trusted = false
      else if (!trusted) {
        const enabled = systemSettings.security?.folderTrust?.enabled
          ?? layers[1].security?.folderTrust?.enabled ?? layers[0].security?.folderTrust?.enabled ?? true
        if (enabled === false) trusted = true
        else {
          const trustFile = env.GEMINI_CLI_TRUSTED_FOLDERS_PATH || path.join(root, 'trustedFolders.json')
          if (!path.isAbsolute(trustFile)) return { uncertain: true }
          const rules = readSettings(trustFile)
          const real = fs.realpathSync(workdir)
          let longest = -1
          for (const [folder, level] of Object.entries(rules)) {
            if (!path.isAbsolute(folder) || !['TRUST_FOLDER', 'TRUST_PARENT', 'DO_NOT_TRUST'].includes(level)) continue
            const candidate = level === 'TRUST_PARENT' ? path.dirname(folder) : folder
            const rootPath = fs.existsSync(candidate) ? fs.realpathSync(candidate) : path.resolve(candidate)
            const relative = path.relative(rootPath, real)
            if ((relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)))
                && rootPath.length > longest) {
              longest = rootPath.length
              trusted = level !== 'DO_NOT_TRUST'
            }
          }
        }
      }
      if (trusted) authType = readSettings(path.join(workdir, '.gemini', 'settings.json')).security?.auth?.selectedType ?? authType
    }
    authType = systemSettings.security?.auth?.selectedType ?? authType
    if (!authType) {
      if (env.GOOGLE_GENAI_USE_GCA === 'true') authType = 'oauth-personal'
      else if (env.GOOGLE_GENAI_USE_VERTEXAI === 'true') authType = 'vertex-ai'
      else if (env.GOOGLE_GEMINI_BASE_URL) authType = 'gateway'
      else if (env.GEMINI_API_KEY) authType = 'gemini-api-key'
      else if (env.CLOUD_SHELL === 'true' || env.GEMINI_CLI_USE_COMPUTE_ADC === 'true') authType = 'compute-default-credentials'
    }
    return { authType: typeof authType === 'string' ? authType : '', root }
  } catch { return { uncertain: true } }
}

module.exports = { geminiNativeAuth }

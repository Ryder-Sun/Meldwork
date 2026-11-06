const fs = require('node:fs')
const path = require('node:path')
const { createHmac, randomBytes } = require('node:crypto')
const NATIVE_CONFIG_IDENTITY_DIRECTORY = Symbol('nativeConfigIdentityDirectory')
const NATIVE_ENVIRONMENT_IDENTITY = Symbol('nativeEnvironmentIdentity')
const NATIVE_AUTH_IDENTITY_FILES = Symbol('nativeAuthIdentityFiles')
const environmentIdentityKey = randomBytes(32)

function nativeEnvironmentIdentity(env) {
  const entries = Object.entries(env).filter(([, value]) => typeof value === 'string')
    .sort(([left], [right]) => left.localeCompare(right))
  return createHmac('sha256', environmentIdentityKey).update(JSON.stringify(entries)).digest('hex')
}

function nativeAuthIdentityFiles(kind, env, home, platform = process.platform) {
  if (kind === 'qwen') {
    const paths = platform === 'win32' ? path.win32 : path.posix
    const settings = env?.QWEN_CODE_SYSTEM_SETTINGS_PATH || (platform === 'darwin'
      ? '/Library/Application Support/QwenCode/settings.json' : platform === 'win32'
        ? 'C:\\ProgramData\\qwen-code\\settings.json' : '/etc/qwen-code/settings.json')
    const defaults = env?.QWEN_CODE_SYSTEM_DEFAULTS_PATH
      || (typeof settings === 'string' && paths.isAbsolute(settings) ? paths.join(paths.dirname(settings), 'system-defaults.json') : '')
    const userRoot = typeof home === 'string' && paths.isAbsolute(home) ? paths.join(home, '.qwen') : ''
    return [settings, defaults, ...(userRoot ? ['settings.json', 'oauth_creds.json'].map(name => paths.join(userRoot, name)) : [])]
      .filter(filename => typeof filename === 'string' && paths.isAbsolute(filename))
  }
  if (kind === 'gemini') {
    const paths = platform === 'win32' ? path.win32 : path.posix
    const settings = env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH || (platform === 'darwin'
      ? '/Library/Application Support/GeminiCli/settings.json' : platform === 'win32'
        ? 'C:\\ProgramData\\gemini-cli\\settings.json' : '/etc/gemini-cli/settings.json')
    const defaults = env?.GEMINI_CLI_SYSTEM_DEFAULTS_PATH
      || (typeof settings === 'string' && paths.isAbsolute(settings) ? paths.join(paths.dirname(settings), 'system-defaults.json') : '')
    const cloudRoot = platform === 'win32' ? env?.APPDATA : paths.join(env?.HOME || home || '', '.config')
    const credentials = env?.GOOGLE_APPLICATION_CREDENTIALS
      || (typeof cloudRoot === 'string' && paths.isAbsolute(cloudRoot)
        ? paths.join(cloudRoot, 'gcloud', 'application_default_credentials.json') : '')
    return [settings, defaults, credentials]
      .filter(filename => typeof filename === 'string' && paths.isAbsolute(filename))
  }
  if (kind === 'zcode') {
    const configured = process.platform === 'win32' ? env?.USERPROFILE : env?.HOME
    const root = typeof configured === 'string' && configured.trim() ? configured.trim() : home
    return typeof root === 'string' && path.isAbsolute(root) ? [path.join(root, '.zcode', 'cli', 'config.json')] : []
  }
  if (kind !== 'opencode') return []
  const root = env?.XDG_DATA_HOME || (typeof home === 'string' && path.isAbsolute(home) ? path.join(home, '.local', 'share') : '')
  return typeof root === 'string' && path.isAbsolute(root) ? [path.join(root, 'opencode', 'auth.json')] : []
}

const NATIVE_CONFIG_DIRECTORIES = Object.freeze({
  hermes: { key: 'HERMES_HOME', files: ['config.yaml', 'auth.json', '.env'] },
  codex: { key: 'CODEX_HOME', files: ['config.toml', 'auth.json'] },
  claude: { key: 'CLAUDE_CONFIG_DIR', files: ['settings.json', '.credentials.json'] },
  pi: { key: 'PI_CODING_AGENT_DIR', files: ['settings.json', 'auth.json', 'models.json'] },
  opencode: { key: 'OPENCODE_CONFIG_DIR', files: ['opencode.json', 'opencode.jsonc'] },
  gemini: { key: 'GEMINI_CLI_HOME', files: ['oauth_creds.json', 'gemini-credentials.json', 'google_accounts.json', 'settings.json', '.env'] },
  kimi: { key: 'KIMI_CODE_HOME', files: ['config.toml'], directories: ['credentials'] },
  mimo: { key: 'MIMOCODE_CONFIG_DIR', files: ['mimocode.json', 'mimocode.jsonc'] },
  deepseek: { key: 'DSH_HOME', files: ['cordis.patch.yml', '.credentials.yaml'], directories: ['profiles'] },
  workbuddy: { key: 'CODEBUDDY_CONFIG_DIR', files: ['models.json', 'settings.json', '.credentials.json'] },
})
function nativeIdentityDirectory(kind, env, home, platform = process.platform) {
  if (kind === 'gemini') {
    const base = env?.GEMINI_CLI_HOME || home
    return typeof base === 'string' && path.isAbsolute(base) ? path.join(base, '.gemini') : ''
  }
  const spec = Object.hasOwn(NATIVE_CONFIG_DIRECTORIES, kind) ? NATIVE_CONFIG_DIRECTORIES[kind] : null
  if (!spec || !path.isAbsolute(home)) return ''
  const configured = env?.[spec.key]
  if (typeof configured === 'string' && configured) {
    return path.isAbsolute(configured) ? configured : ''
  }
  const defaults = {
    hermes: platform === 'win32'
      ? path.join(env?.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), `hermes${env?.HERMES_DATA_DIR_SUFFIX || ''}`)
      : path.join(home, `.hermes${env?.HERMES_DATA_DIR_SUFFIX || ''}`),
    codex: path.join(home, '.codex'), claude: path.join(home, '.claude'),
    pi: path.join(home, '.pi', 'agent'), kimi: path.join(home, '.kimi-code'),
    mimo: path.join(env?.XDG_CONFIG_HOME || path.join(home, '.config'), 'mimocode'),
    opencode: path.join(env?.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode'),
    deepseek: path.join(home, '.dsh'), workbuddy: path.join(home, '.workbuddy'),
  }
  return defaults[kind] || ''
}

function nativeConfigEnvironment(kind, preferences, env = {}) {
  const spec = Object.hasOwn(NATIVE_CONFIG_DIRECTORIES, kind) ? NATIVE_CONFIG_DIRECTORIES[kind] : null
  const directory = preferences?.[kind]?.nativeConfigDirectory
  if (!spec || directory === undefined || directory === '') return env
  if (typeof directory !== 'string' || directory.length > 4096
      || directory.includes('\u0000') || !path.isAbsolute(directory)) throw new Error('LOCAL_NATIVE_CONFIG_INVALID')
  if (kind === 'gemini' && path.basename(path.resolve(directory)) !== '.gemini') throw new Error('LOCAL_NATIVE_CONFIG_INVALID')
  return { ...env, [spec.key]: kind === 'gemini' ? path.dirname(path.resolve(directory)) : directory }
}

function validateNativeConfigDirectory(kind, directory) {
  const spec = Object.hasOwn(NATIVE_CONFIG_DIRECTORIES, kind) ? NATIVE_CONFIG_DIRECTORIES[kind] : null
  if (!spec || typeof directory !== 'string' || directory.length > 4096
      || directory.includes('\u0000') || !path.isAbsolute(directory)) throw new Error('LOCAL_NATIVE_CONFIG_INVALID')
  if (kind === 'gemini' && path.basename(path.resolve(directory)) !== '.gemini') throw new Error('LOCAL_NATIVE_CONFIG_INVALID')
  let resolved
  try {
    resolved = fs.realpathSync(directory)
    if (!fs.statSync(resolved).isDirectory()
        || !(spec.files.some(name => {
          try { return fs.statSync(path.join(resolved, name)).isFile() } catch { return false }
        }) || (spec.directories || []).some(name => {
          try { return fs.statSync(path.join(resolved, name)).isDirectory() } catch { return false }
        }))) throw new Error('invalid directory')
  } catch { throw new Error('LOCAL_NATIVE_CONFIG_INVALID') }
  return kind === 'gemini' ? path.resolve(directory) : resolved
}

module.exports = { NATIVE_CONFIG_DIRECTORIES, NATIVE_CONFIG_IDENTITY_DIRECTORY, NATIVE_ENVIRONMENT_IDENTITY, NATIVE_AUTH_IDENTITY_FILES,
  nativeEnvironmentIdentity, nativeAuthIdentityFiles, nativeConfigEnvironment,
  nativeIdentityDirectory, validateNativeConfigDirectory }

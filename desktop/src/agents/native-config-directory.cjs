const fs = require('node:fs')
const path = require('node:path')
const { createHmac, randomBytes } = require('node:crypto')
const { networkEnvironment } = require('./cli/cli-network-environment.cjs')
const NATIVE_CONFIG_IDENTITY_DIRECTORY = Symbol('nativeConfigIdentityDirectory')
const NATIVE_ENVIRONMENT_IDENTITY = Symbol('nativeEnvironmentIdentity')
const NATIVE_AUTH_IDENTITY_FILES = Symbol('nativeAuthIdentityFiles')
const NATIVE_PROJECT_CONFIG_PATHS = Symbol('nativeProjectConfigPaths')
const environmentIdentityKey = randomBytes(32)
const NETWORK_CERTIFICATE_KEYS = ['SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE']

function nativeNetworkIdentityFiles(env = {}, platform = process.platform) {
  const source = networkEnvironment(env, platform)
  const paths = platform === 'win32' ? path.win32 : path.posix
  return NETWORK_CERTIFICATE_KEYS.map(key => source[key])
    .filter(filename => typeof filename === 'string' && paths.isAbsolute(filename))
}

function cloudIdentityPathKeys(kind) {
  return ['AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_CA_BUNDLE',
    'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE', 'GOOGLE_APPLICATION_CREDENTIALS',
    ...(kind === 'hermes' ? ['VERTEX_CREDENTIALS_PATH'] : []),
    ...(kind === 'claude' ? ['AZURE_CLIENT_CERTIFICATE_PATH', 'AZURE_FEDERATED_TOKEN_FILE'] : [])]
}

function cloudIdentityFiles(kind, env, home, platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const configuredHome = platform === 'win32' ? env?.USERPROFILE : env?.HOME
  const root = typeof configuredHome === 'string' && paths.isAbsolute(configuredHome) ? configuredHome : home
  const defaults = typeof root === 'string' && paths.isAbsolute(root)
    ? { AWS_CONFIG_FILE: paths.join(root, '.aws', 'config'),
      AWS_SHARED_CREDENTIALS_FILE: paths.join(root, '.aws', 'credentials') } : {}
  const cloudRoot = env?.CLOUDSDK_CONFIG || (platform === 'win32'
    ? env?.APPDATA && paths.join(env.APPDATA, 'gcloud')
    : root && paths.join(env?.XDG_CONFIG_HOME || paths.join(root, '.config'), 'gcloud'))
  return [...cloudIdentityPathKeys(kind).map(key => env?.[key] || defaults[key]),
    ...(['hermes', 'pi', 'opencode'].includes(kind) && typeof cloudRoot === 'string' && paths.isAbsolute(cloudRoot)
      ? [paths.join(cloudRoot, 'application_default_credentials.json')] : [])]
    .filter(filename => typeof filename === 'string' && paths.isAbsolute(filename))
}

function nativeProjectConfigPaths(kind, env = {}) {
  let entries = kind === 'opencode' ? [[env.OPENCODE_CONFIG, false], [env.OPENCODE_CONFIG_DIR, true]]
    : kind === 'mimo' ? [[env.MIMOCODE_CONFIG, false], [env.MIMOCODE_CONFIG_DIR, true]] : []
  if (kind === 'zcode') entries = [[env.ZCODE_AGENT_CA_CERT, false]]
  if (kind === 'gemini' || kind === 'qwen') {
    const settings = env[kind === 'gemini' ? 'GEMINI_CLI_SYSTEM_SETTINGS_PATH' : 'QWEN_CODE_SYSTEM_SETTINGS_PATH']
    const defaults = env[kind === 'gemini' ? 'GEMINI_CLI_SYSTEM_DEFAULTS_PATH' : 'QWEN_CODE_SYSTEM_DEFAULTS_PATH']
      || (typeof settings === 'string' && settings ? path.join(path.dirname(settings), 'system-defaults.json') : '')
    entries = [[settings, false], [defaults, false], ...(kind === 'gemini' ? [[env.GOOGLE_APPLICATION_CREDENTIALS, false]]
      : [[env.GEMINI_CLI_TRUSTED_FOLDERS_PATH, false]])]
  }
  if (kind === 'pi' || kind === 'claude' || kind === 'hermes') {
    entries = cloudIdentityPathKeys(kind).map(key => [env[key], false])
  }
  if (kind === 'opencode') entries.push(...cloudIdentityPathKeys(kind).map(key => [env[key], false]))
  if (['gemini', 'hermes', 'pi', 'opencode'].includes(kind)
      && typeof env.CLOUDSDK_CONFIG === 'string' && env.CLOUDSDK_CONFIG) {
    entries.push([path.join(env.CLOUDSDK_CONFIG, 'application_default_credentials.json'), false])
  }
  const network = networkEnvironment(env)
  entries.push(...NETWORK_CERTIFICATE_KEYS.map(key => [network[key], false]))
  return entries.flatMap(([value, directory]) => {
    return typeof value === 'string' && value && !path.isAbsolute(value)
      && !(kind === 'opencode' && /^~(?=$|[\\/])/.test(value))
      ? [{ value, directory }] : []
  })
}

function nativeEnvironmentIdentity(env) {
  const entries = Object.entries(env).filter(([, value]) => typeof value === 'string')
    .sort(([left], [right]) => left.localeCompare(right))
  return createHmac('sha256', environmentIdentityKey).update(JSON.stringify(entries)).digest('hex')
}

function nativeAuthIdentityFiles(kind, env, home, platform = process.platform) {
  if (kind === 'pi' || kind === 'claude' || kind === 'hermes') {
    return cloudIdentityFiles(kind, env, home, platform)
  }
  if (kind === 'qwen') {
    const paths = platform === 'win32' ? path.win32 : path.posix
    const settings = env?.QWEN_CODE_SYSTEM_SETTINGS_PATH || (platform === 'darwin'
      ? '/Library/Application Support/QwenCode/settings.json' : platform === 'win32'
        ? 'C:\\ProgramData\\qwen-code\\settings.json' : '/etc/qwen-code/settings.json')
    const defaults = env?.QWEN_CODE_SYSTEM_DEFAULTS_PATH
      || (typeof settings === 'string' && paths.isAbsolute(settings) ? paths.join(paths.dirname(settings), 'system-defaults.json') : '')
    const userRoot = typeof home === 'string' && paths.isAbsolute(home) ? paths.join(home, '.qwen') : ''
    return [settings, defaults, ...(userRoot ? ['settings.json', 'oauth_creds.json', '.env'].map(name => paths.join(userRoot, name)) : []),
      env?.GEMINI_CLI_TRUSTED_FOLDERS_PATH || (userRoot && paths.join(userRoot, 'trustedFolders.json')),
      ...(typeof home === 'string' && paths.isAbsolute(home) ? [paths.join(home, '.env')] : [])]
      .filter(filename => typeof filename === 'string' && paths.isAbsolute(filename))
  }
  if (kind === 'gemini') {
    const paths = platform === 'win32' ? path.win32 : path.posix
    const settings = env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH || (platform === 'darwin'
      ? '/Library/Application Support/GeminiCli/settings.json' : platform === 'win32'
        ? 'C:\\ProgramData\\gemini-cli\\settings.json' : '/etc/gemini-cli/settings.json')
    const defaults = env?.GEMINI_CLI_SYSTEM_DEFAULTS_PATH
      || (typeof settings === 'string' && paths.isAbsolute(settings) ? paths.join(paths.dirname(settings), 'system-defaults.json') : '')
    const cloudRoot = env?.CLOUDSDK_CONFIG || (platform === 'win32'
      ? env?.APPDATA && paths.join(env.APPDATA, 'gcloud')
      : paths.join(env?.XDG_CONFIG_HOME || paths.join(env?.HOME || home || '', '.config'), 'gcloud'))
    const credentials = env?.GOOGLE_APPLICATION_CREDENTIALS
      || (typeof cloudRoot === 'string' && paths.isAbsolute(cloudRoot)
        ? paths.join(cloudRoot, 'application_default_credentials.json') : '')
    return [settings, defaults, credentials,
      ...(typeof home === 'string' && paths.isAbsolute(home) ? [paths.join(home, '.env')] : [])]
      .filter(filename => typeof filename === 'string' && paths.isAbsolute(filename))
  }
  if (kind === 'zcode') {
    const paths = platform === 'win32' ? path.win32 : path.posix
    const configured = platform === 'win32' ? env?.USERPROFILE : env?.HOME
    const root = typeof configured === 'string' && configured.trim() ? configured.trim() : home
    return [typeof root === 'string' && paths.isAbsolute(root) ? paths.join(root, '.zcode', 'cli', 'config.json') : '',
      env?.ZCODE_AGENT_CA_CERT].filter(filename => typeof filename === 'string' && paths.isAbsolute(filename))
  }
  if (kind === 'mimo') {
    const explicit = env?.MIMOCODE_CONFIG
    const userRoot = typeof home === 'string' && path.isAbsolute(home) ? path.join(home, '.mimocode') : ''
    const configRoot = env?.XDG_CONFIG_HOME || (home && path.join(home, '.config'))
    const sharedRoot = typeof configRoot === 'string' && path.isAbsolute(configRoot) ? path.join(configRoot, 'mimocode') : ''
    const stateRoot = env?.XDG_STATE_HOME || (home && path.join(home, '.local', 'state'))
    return [explicit, ...[userRoot, sharedRoot].filter(Boolean)
      .flatMap(root => ['mimocode.json', 'mimocode.jsonc'].map(name => path.join(root, name))),
      typeof stateRoot === 'string' && path.isAbsolute(stateRoot) ? path.join(stateRoot, 'mimocode', 'model.json') : '']
      .filter(filename => typeof filename === 'string' && path.isAbsolute(filename))
  }
  if (kind !== 'opencode') return []
  const root = env?.XDG_DATA_HOME || (typeof home === 'string' && path.isAbsolute(home) ? path.join(home, '.local', 'share') : '')
  const configRoot = env?.XDG_CONFIG_HOME || (home && path.join(home, '.config'))
  const sharedRoot = typeof configRoot === 'string' && path.isAbsolute(configRoot) ? path.join(configRoot, 'opencode') : ''
  const explicit = typeof env?.OPENCODE_CONFIG === 'string' && typeof home === 'string' && path.isAbsolute(home)
    ? env.OPENCODE_CONFIG.replace(/^~(?=$|[\\/])/, home) : env?.OPENCODE_CONFIG
  const stateRoot = env?.XDG_STATE_HOME || (home && path.join(home, '.local', 'state'))
  const cacheRoot = env?.XDG_CACHE_HOME || (home && path.join(home, '.cache'))
  return [typeof root === 'string' && path.isAbsolute(root) ? path.join(root, 'opencode', 'auth.json') : '', explicit,
    ...(sharedRoot ? ['config.json', 'opencode.json', 'opencode.jsonc'].map(name => path.join(sharedRoot, name)) : []),
    ...(typeof home === 'string' && path.isAbsolute(home)
      ? ['opencode.json', 'opencode.jsonc'].map(name => path.join(home, '.opencode', name)) : []),
    typeof stateRoot === 'string' && path.isAbsolute(stateRoot) ? path.join(stateRoot, 'opencode', 'model.json') : '',
    typeof cacheRoot === 'string' && path.isAbsolute(cacheRoot) ? path.join(cacheRoot, 'opencode', 'models.json') : '',
    ...cloudIdentityFiles(kind, env, home, platform)]
    .filter(filename => typeof filename === 'string' && path.isAbsolute(filename))
}

const NATIVE_CONFIG_DIRECTORIES = Object.freeze({
  hermes: { key: 'HERMES_HOME', files: ['config.yaml', 'auth.json', '.env'], identityFiles: ['config.json'] },
  codex: { key: 'CODEX_HOME', files: ['config.toml', 'auth.json'], identityFiles: ['config.json', '.env'] },
  claude: { key: 'CLAUDE_CONFIG_DIR', files: ['settings.json', '.credentials.json'], identityFiles: ['settings.local.json', '.env'] },
  pi: { key: 'PI_CODING_AGENT_DIR', files: ['settings.json', 'auth.json', 'models.json'] },
  opencode: { key: 'OPENCODE_CONFIG_DIR', files: ['opencode.json', 'opencode.jsonc'] },
  gemini: { key: 'GEMINI_CLI_HOME', files: ['oauth_creds.json', 'gemini-credentials.json', 'google_accounts.json', 'settings.json', '.env'] },
  kimi: { key: 'KIMI_CODE_HOME', files: ['config.toml'], identityFiles: ['.env'], directories: ['credentials'] },
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
    const directory = kind === 'hermes' ? configured.replace(/^~(?=$|[\\/])/, home) : configured
    return path.isAbsolute(directory) ? directory : ''
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

module.exports = { NATIVE_CONFIG_DIRECTORIES, NATIVE_CONFIG_IDENTITY_DIRECTORY, NATIVE_ENVIRONMENT_IDENTITY, NATIVE_AUTH_IDENTITY_FILES, NATIVE_PROJECT_CONFIG_PATHS,
  nativeProjectConfigPaths, nativeNetworkIdentityFiles,
  nativeEnvironmentIdentity, nativeAuthIdentityFiles, nativeConfigEnvironment,
  nativeIdentityDirectory, validateNativeConfigDirectory }

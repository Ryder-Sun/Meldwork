const fs = require('node:fs')
const path = require('node:path')
const { createHmac, randomBytes } = require('node:crypto')
const NATIVE_CONFIG_IDENTITY_DIRECTORY = Symbol('nativeConfigIdentityDirectory')
const NATIVE_ENVIRONMENT_IDENTITY = Symbol('nativeEnvironmentIdentity')
const environmentIdentityKey = randomBytes(32)

function nativeEnvironmentIdentity(env) {
  const entries = Object.entries(env).filter(([, value]) => typeof value === 'string')
    .sort(([left], [right]) => left.localeCompare(right))
  return createHmac('sha256', environmentIdentityKey).update(JSON.stringify(entries)).digest('hex')
}

const NATIVE_CONFIG_DIRECTORIES = Object.freeze({
  hermes: { key: 'HERMES_HOME', files: ['config.yaml', 'auth.json', '.env'] },
  codex: { key: 'CODEX_HOME', files: ['config.toml', 'auth.json'] },
  claude: { key: 'CLAUDE_CONFIG_DIR', files: ['settings.json', '.credentials.json'] },
  pi: { key: 'PI_CODING_AGENT_DIR', files: ['settings.json', 'auth.json', 'models.json'] },
  kimi: { key: 'KIMI_CODE_HOME', files: ['config.toml'], directories: ['credentials'] },
  deepseek: { key: 'DSH_HOME', files: ['cordis.patch.yml', '.credentials.yaml'], directories: ['profiles'] },
  workbuddy: { key: 'CODEBUDDY_CONFIG_DIR', files: ['models.json', 'settings.json', '.credentials.json'] },
})

function nativeIdentityDirectory(kind, env, home, platform = process.platform) {
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
  return { ...env, [spec.key]: directory }
}

function validateNativeConfigDirectory(kind, directory) {
  const spec = Object.hasOwn(NATIVE_CONFIG_DIRECTORIES, kind) ? NATIVE_CONFIG_DIRECTORIES[kind] : null
  if (!spec || typeof directory !== 'string' || directory.length > 4096
      || directory.includes('\u0000') || !path.isAbsolute(directory)) throw new Error('LOCAL_NATIVE_CONFIG_INVALID')
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
  return resolved
}

module.exports = { NATIVE_CONFIG_DIRECTORIES, NATIVE_CONFIG_IDENTITY_DIRECTORY, NATIVE_ENVIRONMENT_IDENTITY,
  nativeEnvironmentIdentity, nativeConfigEnvironment,
  nativeIdentityDirectory, validateNativeConfigDirectory }

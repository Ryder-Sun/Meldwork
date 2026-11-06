const fs = require('node:fs')
const path = require('node:path')

const NATIVE_CONFIG_DIRECTORIES = Object.freeze({
  hermes: { key: 'HERMES_HOME', files: ['config.yaml', 'auth.json'] },
  codex: { key: 'CODEX_HOME', files: ['config.toml', 'auth.json'] },
  claude: { key: 'CLAUDE_CONFIG_DIR', files: ['settings.json', '.credentials.json'] },
  pi: { key: 'PI_CODING_AGENT_DIR', files: ['settings.json', 'auth.json', 'models.json'] },
  deepseek: { key: 'DSH_HOME', files: ['cordis.patch.yml', '.credentials.yaml'], directories: ['profiles'] },
})

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

module.exports = { NATIVE_CONFIG_DIRECTORIES, nativeConfigEnvironment, validateNativeConfigDirectory }

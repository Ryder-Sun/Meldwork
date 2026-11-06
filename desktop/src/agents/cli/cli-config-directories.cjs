const CONFIG_DIRECTORY_ENV_KEYS = Object.freeze([
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
  'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
])

function configDirectoryEnvironment(source = {}) {
  return Object.fromEntries(CONFIG_DIRECTORY_ENV_KEYS
    .filter(key => typeof source[key] === 'string')
    .map(key => [key, source[key]]))
}

module.exports = { CONFIG_DIRECTORY_ENV_KEYS, configDirectoryEnvironment }

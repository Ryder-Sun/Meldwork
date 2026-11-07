const SECRET_ENV_KEYS = Symbol.for('meldwork.native-secret-env-keys')
const UNSAFE = /^(?:(?:PATH|HOME|USER|LOGNAME|SHELL|ENV|IFS|CDPATH|GLOBIGNORE|TMPDIR|TMP|TEMP|TERM|COMSPEC|SYSTEMROOT|WINDIR|USERPROFILE|PATHEXT|APPDATA|LOCALAPPDATA|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|HERMES_EXEC_ASK|HERMES_YOLO_MODE)$|(?:BASH_|ZSH_|FISH_|NODE_|ELECTRON_|LD_|DYLD_|PYTHON|RUBY|PERL|JAVA_|GIT_|SSH_))/i

function nativeSecretEnvKeys(input) {
  if (!Array.isArray(input)) return []
  return [...new Set(input.filter(key => typeof key === 'string'
    && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) && !UNSAFE.test(key)))].slice(0, 128).sort()
}

function credentialLiteral(value) {
  if (typeof value !== 'string') return false
  const candidate = value.trim()
  if (!candidate) return false
  if (/^(?:null|none|undefined|true|false|~)$/i.test(candidate)) return false
  if (/^\$(?:[A-Z_][A-Z0-9_]*|\{[A-Z_][A-Z0-9_]*\})$/i.test(candidate)) return false
  if (/^(?:env|secretref-env|__env__):[A-Z_][A-Z0-9_]*$/i.test(candidate)) return false
  return !/^[A-Z_][A-Z0-9_]*(?:API_KEY|TOKEN|CREDENTIAL)$/i.test(candidate)
}

function configSecrets(configs) {
  const secrets = new Set()
  const pending = configs.map(value => [value, 0])
  const visited = new WeakMap()
  while (pending.length && secrets.size < 128) {
    const [value, depth] = pending.pop()
    if (!value || typeof value !== 'object' || depth > 32) continue
    if (visited.has(value) && visited.get(value) <= depth) continue
    visited.set(value, depth)
    for (const [key, item] of Object.entries(value)) {
      if ((/(?:api[_-]?key|access[_-]?key|token|secret|password|authorization)$/i.test(key)
          || (key === 'key' && value.type === 'api_key'))
          && credentialLiteral(item) && item.length <= 8192 && !/^\{(?:env|file):[^}]+\}$/.test(item)) {
        secrets.add(item)
        const bearer = item.match(/^Bearer\s+(\S+)$/i)
        if (bearer) secrets.add(bearer[1])
      } else if (item && typeof item === 'object') pending.push([item, depth + 1])
    }
  }
  return [...secrets]
}

module.exports = { SECRET_ENV_KEYS, nativeSecretEnvKeys, credentialLiteral, configSecrets }

const SECRET_ENV_KEYS = Symbol.for('meldwork.native-secret-env-keys')
const UNSAFE = /^(?:(?:PATH|HOME|USER|LOGNAME|SHELL|ENV|IFS|CDPATH|GLOBIGNORE|TMPDIR|TMP|TEMP|TERM|COMSPEC|SYSTEMROOT|WINDIR|USERPROFILE|PATHEXT|APPDATA|LOCALAPPDATA|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|HERMES_EXEC_ASK|HERMES_YOLO_MODE)$|(?:BASH_|ZSH_|FISH_|NODE_|ELECTRON_|LD_|DYLD_|PYTHON|RUBY|PERL|JAVA_|GIT_|SSH_))/i

function nativeSecretEnvKeys(input) {
  if (!Array.isArray(input)) return []
  return [...new Set(input.filter(key => typeof key === 'string'
    && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) && !UNSAFE.test(key)))].slice(0, 128).sort()
}

module.exports = { SECRET_ENV_KEYS, nativeSecretEnvKeys }

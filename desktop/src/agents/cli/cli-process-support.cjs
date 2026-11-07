const path = require('node:path')
const { launchEnvironment, searchPath, systemChildEnvironment } = require('./cli-discovery.cjs')
const { networkEnvironment } = require('./cli-network-environment.cjs')
const { CONFIG_DIRECTORY_ENV_KEYS } = require('./cli-config-directories.cjs')
const { SECRET_ENV_KEYS, nativeSecretEnvKeys } = require('./native-secret-environment.cjs')
const { nativeCredentialEnvironment } = require('../agent-native-environment.cjs')
const { redactChildSecrets } = require('./cli-runtime-events.cjs')
const {
  agentRuntimeError,
  authFailureCode,
} = require('../agent-runtime-contract.cjs')
const { authFailureCertainty, isContextOverflow } = require('../../runs/failure-signals.cjs')
const { validateOpenClawRuntimeGuard } = require('./openclaw-runtime.cjs')

const TERMINATE_GRACE_MS = 500
const KILL_SETTLE_MS = 500
const OPENCODE_READ_ONLY_PERMISSION = JSON.stringify({
  '*': 'deny',
  read: 'allow',
  glob: 'allow',
  grep: 'allow',
  list: 'allow',
  webfetch: 'allow',
  websearch: 'allow',
})
const OPENCLAW_RUNTIME_PATH_KEYS = Object.freeze([
  'OPENCLAW_HOME',
  'OPENCLAW_STATE_DIR',
  'OPENCLAW_CONFIG_PATH',
  'OPENCLAW_WORKSPACE_DIR',
])
const TEST_RUNTIME_ENV = /^(?:CONNECTOR_TEST_|MELDWORK_TEST_)/
const BLOCKED_RUNTIME_ENV = /^(?:NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_|ELECTRON_RUN_AS_NODE)$/

function agentExecutionError(code, diagnostic = '') {
  return agentRuntimeError(code, diagnostic)
}

function terminateWindowsProcessTree(child, spawnFn, timeoutMs = TERMINATE_GRACE_MS + KILL_SETTLE_MS) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let killer
    let childClosed = false
    let killerSucceeded = false
    let settled = false
    let timer
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('close', onChildClose)
      killer?.removeListener('close', onKillerClose)
      if (error) {
        const failure = agentExecutionError('LOCAL_AGENT_TERMINATION_FAILED')
        if (child.pid && child.exitCode == null && child.signalCode == null) {
          const pending = new Promise(resolveExit => {
            child.once('exit', resolveExit)
            if (child.exitCode != null || child.signalCode != null) {
              child.removeListener('exit', resolveExit)
              resolveExit()
            }
          })
          Object.defineProperty(failure, Symbol.for('meldwork.pending-process-exit'), { value: pending })
        }
        reject(failure)
      } else resolve()
    }
    const onFailure = () => finish(true)
    const onChildClose = () => { childClosed = true; if (killerSucceeded) finish(false) }
    const onKillerClose = code => {
      if (code !== 0) return finish(true)
      killerSucceeded = true
      if (childClosed || child.exitCode != null || child.signalCode != null) finish(false)
    }
    child.once('close', onChildClose)
    child.once('error', onFailure)
    timer = setTimeout(onFailure, timeoutMs)
    try {
      if (!child.pid) return onFailure()
      killer = spawnFn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true,
      })
      killer.once('close', onKillerClose)
      killer.once('error', onFailure)
      killer.unref?.()
    } catch { onFailure() }
  })
}

function invalidSessionFailure(detail) {
  const text = String(detail || '').trim()
  if (!text || authFailureCertainty(text)
      || /\b(?:api|access|refresh|auth|session)[ _-]?token\b/i.test(text)) return false
  // A resumed native session that no longer fits the model context cannot be
  // continued; rebuilding it with compact continuation context is the fix.
  if (isContextOverflow(text)) return true
  if (/^(?:Error: )?Resume retains gateway session policy; creation overrides are unsupported on resume\./m.test(text)
      && /--yolo differs from this session's launch/.test(text)) return true
  // Runtime crashes ("thread 'main' panicked ... invalid ...") and parser
  // errors mention threads or invalid input without saying anything about the
  // stored session. Discarding a healthy session for them loses context.
  if (/\bpanicked\b|\bSyntaxError\b|\binvalid JSON\b|\bUnexpected token\b|\bstack backtrace\b/i.test(text)) {
    return false
  }
  return /\b(?:no|unknown|invalid|expired|missing|stale)\s+(?:saved\s+)?(?:session|conversation|thread)\b|\b(?:session|conversation|thread)(?:\s+(?:id|key|reference))?\b[^\n]{0,100}\b(?:not found|does not exist|no longer exists|invalid|unknown|expired|has expired|was deleted|cannot be resumed)\b/i
    .test(text)
}

function failedAgentProcessError(detail, options = {}) {
  if (!detail) return agentExecutionError('LOCAL_AGENT_EXITED')
  if (options.kind === 'zcode' && /\b1113\b|insufficient balance|no resource package/i.test(detail)) {
    return agentExecutionError('LOCAL_AGENT_PROVIDER_QUOTA_EXHAUSTED', 'The configured provider has insufficient balance or no active resource package.')
  }
  if (options.kind === 'zcode' && /\bModel provider is missing an API key:/i.test(detail)) {
    return agentExecutionError('LOCAL_AGENT_AUTH_REQUIRED', 'Missing API key for the configured Zcode provider.')
  }
  if (options.kind === 'workbuddy' && options.model && authFailureCode(detail)) {
    return agentExecutionError('LOCAL_WORKBUDDY_PROVIDER_AUTH', detail)
  }
  return agentExecutionError(
    options.sessionRef && invalidSessionFailure(detail)
      ? 'LOCAL_AGENT_SESSION_INVALID'
      : authFailureCode(detail) || 'LOCAL_AGENT_PROCESS_FAILED',
    detail,
  )
}

function inheritedEnvironment(options, platform) {
  const env = systemChildEnvironment(process.env, platform)
  for (const key of options.nativeUnsetKeys || []) delete env[key]
  return env
}

function openClawChildEnvironment(workdir, options, platform) {
  const source = options.env || {}
  const guard = options.openClawRuntimeGuard
  if (!guard) throw new Error('OPENCLAW_RUNTIME_GUARD_REQUIRED')
  validateOpenClawRuntimeGuard(guard, source)
  if (source.OPENCLAW_WORKSPACE_DIR !== path.resolve(workdir)) {
    throw new Error('OPENCLAW_RUNTIME_UNSAFE_PATH')
  }

  const env = {
    ...inheritedEnvironment(options, platform),
    ...networkEnvironment(source, platform),
  }
  for (const key of [
    'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME',
    'XDG_RUNTIME_DIR', 'APPDATA', 'LOCALAPPDATA',
  ]) {
    delete env[key]
  }

  for (const key of OPENCLAW_RUNTIME_PATH_KEYS) env[key] = source[key]
  for (const key of guard.credentialKeys) env[key] = source[key]
  const isolatedHome = source.OPENCLAW_HOME
  env.HOME = isolatedHome
  env.USERPROFILE = isolatedHome
  env.XDG_CONFIG_HOME = path.join(isolatedHome, '.config')
  env.XDG_DATA_HOME = path.join(isolatedHome, '.local', 'share')
  env.XDG_STATE_HOME = path.join(isolatedHome, '.local', 'state')
  env.XDG_CACHE_HOME = path.join(isolatedHome, '.cache')
  env.XDG_RUNTIME_DIR = path.join(isolatedHome, '.runtime')
  env.TMPDIR = env.XDG_RUNTIME_DIR
  env.TMP = env.XDG_RUNTIME_DIR
  env.TEMP = env.XDG_RUNTIME_DIR
  env.OPENCLAW_DISABLE_BONJOUR = '1'
  env.APPDATA = path.join(isolatedHome, 'AppData', 'Roaming')
  env.LOCALAPPDATA = path.join(isolatedHome, 'AppData', 'Local')
  env.PATH = searchPath({ platform })
  return env
}

function childEnvironment(agent, workdir, options, platform) {
  if (agent.kind === 'openclaw') {
    return openClawChildEnvironment(workdir, options, platform)
  }
  const hermesSafetyEnv = agent.kind === 'hermes'
    ? options.sandbox === 'workspace-write'
      ? { HERMES_EXEC_ASK: '', HERMES_YOLO_MODE: '1' }
      : { HERMES_EXEC_ASK: '1', HERMES_YOLO_MODE: '' }
    : {}
  const openCodeSafetyEnv = {}
  // ACP has no terminal UI for question/plan transitions. Match the native
  // headless runner: return the answer to Meldwork instead of waiting forever.
  const headlessPermissions = { question: 'deny', plan_enter: 'deny', plan_exit: 'deny' }
  if (agent.kind === 'opencode') {
    openCodeSafetyEnv.OPENCODE_PERMISSION = JSON.stringify({
      ...(options.sandbox !== 'workspace-write' ? JSON.parse(OPENCODE_READ_ONLY_PERMISSION) : {}),
      ...headlessPermissions,
    })
  }
  if (agent.kind === 'mimo') {
    // MiMo applies read/write permissions with ACP session/set_mode. Keep
    // process-wide permissions stable when the discussion changes phase.
    openCodeSafetyEnv.MIMOCODE_PERMISSION = JSON.stringify(headlessPermissions)
  }
  const source = { ...process.env, ...options.env }
  for (const key of options.nativeUnsetKeys || []) {
    if (!Object.hasOwn(options.env || {}, key)) delete source[key]
  }
  const nativeKeys = nativeSecretEnvKeys(options.nativeCredentialKeys)
  const nativeEnvironment = nativeCredentialEnvironment(agent.kind, options.env || {}, nativeKeys, platform)
  const controlled = {
    ...Object.fromEntries(Object.entries(nativeEnvironment).filter(([key]) => !BLOCKED_RUNTIME_ENV.test(key))),
    ...networkEnvironment(options.env || {}, platform),
    ...Object.fromEntries(Object.entries(options.env || {}).filter(([key, value]) => (
      typeof value === 'string' && (TEST_RUNTIME_ENV.test(key)
        || CONFIG_DIRECTORY_ENV_KEYS.includes(key)) && !BLOCKED_RUNTIME_ENV.test(key)
    ))),
  }
  const childEnv = {
    ...inheritedEnvironment(options, platform),
    ...controlled,
    ...hermesSafetyEnv,
    ...openCodeSafetyEnv,
    ...launchEnvironment(agent.kind, agent.executable, { platform }),
    PATH: searchPath({ platform, env: source }),
  }
  Object.defineProperty(childEnv, SECRET_ENV_KEYS, { value: nativeKeys })
  return childEnv
}

module.exports = {
  KILL_SETTLE_MS,
  TERMINATE_GRACE_MS,
  agentExecutionError,
  childEnvironment,
  failedAgentProcessError,
  invalidSessionFailure,
  terminateWindowsProcessTree,
}

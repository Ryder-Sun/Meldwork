const { execFile } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { promisify } = require('node:util')
const { networkEnvironment } = require('./cli-network-environment.cjs')
const {
  assessAgentVersion,
  capabilityProbes,
  identifyAgentVersion,
} = require('../agent-compatibility.cjs')

const execFileAsync = promisify(execFile)
const AGENT_PROFILES = {
  codex: { label: 'Codex', commands: ['codex'] },
  hermes: { label: 'Hermes', commands: ['hermes'] },
  openclaw: { label: 'OpenClaw', commands: ['openclaw'] },
  workbuddy: { label: 'WorkBuddy', commands: ['codebuddy'] },
  pi: { label: 'Pi Agent', commands: ['pi', 'pi-agent', 'piagent'] },
  kimi: { label: 'Kimi', commands: ['kimi'] },
  mimo: { label: 'MiMo', commands: ['mimo'] },
  claude: { label: 'Claude', commands: ['claude'] },
  gemini: { label: 'Gemini', commands: ['gemini'] },
  opencode: { label: 'OpenCode', commands: ['opencode'] },
  qwen: { label: 'Qwen', commands: ['qwen'] },
  opencodereview: { label: 'OpenCodeReview', commands: ['ocr'] },
}
const ALLOWED_KINDS = Object.keys(AGENT_PROFILES)
const DEFAULT_WINDOWS_PATHEXT = ['.COM', '.EXE', '.BAT', '.CMD']
const CAPABILITY_CACHE_TTL_MS = 5 * 60 * 1000
const capabilityCache = new Map()
const SYSTEM_CHILD_ENV_KEYS = Object.freeze([
  'HOME', 'USER', 'LOGNAME', 'SHELL',
  'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'TERM', 'COLORTERM', 'NO_COLOR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME',
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
  'OS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'NUMBER_OF_PROCESSORS',
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR',
])

function envValue(env, name) {
  const match = Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase())
  return match ? env[match] : ''
}

function systemChildEnvironment(sourceEnv = process.env, platform = process.platform) {
  const env = networkEnvironment(sourceEnv, platform)
  for (const name of SYSTEM_CHILD_ENV_KEYS) {
    const value = envValue(sourceEnv, name)
    if (typeof value === 'string' && value) env[name] = value
  }
  if (platform === 'win32') env.USERPROFILE ||= os.homedir()
  else env.HOME ||= os.homedir()
  return env
}

function runtimeOptions(options = {}) {
  const platform = options.platform || process.platform
  return {
    platform,
    env: options.env ?? process.env,
    home: options.home || os.homedir(),
    pathApi: platform === 'win32' ? path.win32 : path.posix,
    accessFn: options.accessFn || fs.promises.access,
    execFileFn: options.execFileFn || execFileAsync,
  }
}

function uniquePaths(values, platform) {
  const seen = new Set()
  return values.filter(Boolean).filter((value) => {
    const key = platform === 'win32' ? value.toLowerCase() : value
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function versionManagerBins(root, suffix, options = {}) {
  if (!root) return []
  const { pathApi } = runtimeOptions(options)
  const readdirFn = options.readdirFn || fs.readdirSync
  let entries
  try {
    entries = readdirFn(root, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter(entry => entry?.name
      && (typeof entry.isDirectory !== 'function'
        || entry.isDirectory()
        || entry.isSymbolicLink?.()))
    .map(entry => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
    .map(name => pathApi.join(root, name, ...suffix))
}

function searchDirectories(options = {}) {
  const { platform, env, home, pathApi } = runtimeOptions(options)
  const configured = String(envValue(env, 'PATH') || '').split(pathApi.delimiter)
  const pnpmHome = envValue(env, 'PNPM_HOME')
  if (platform !== 'win32') {
    const fnmMultishellPath = envValue(env, 'FNM_MULTISHELL_PATH')
    const fnmDataRoots = [
      pathApi.join(home, '.local', 'share', 'fnm', 'node-versions'),
      platform === 'darwin'
        ? pathApi.join(home, 'Library', 'Application Support', 'fnm', 'node-versions')
        : '',
    ]
    return uniquePaths([
      ...configured,
      pnpmHome,
      envValue(env, 'NVM_BIN'),
      envValue(env, 'BUN_INSTALL') && pathApi.join(envValue(env, 'BUN_INSTALL'), 'bin'),
      envValue(env, 'ASDF_DATA_DIR') && pathApi.join(envValue(env, 'ASDF_DATA_DIR'), 'shims'),
      envValue(env, 'MISE_DATA_DIR') && pathApi.join(envValue(env, 'MISE_DATA_DIR'), 'shims'),
      envValue(env, 'NODENV_ROOT') && pathApi.join(envValue(env, 'NODENV_ROOT'), 'shims'),
      fnmMultishellPath && pathApi.join(fnmMultishellPath, 'bin'),
      pathApi.join(home, '.volta', 'bin'),
      platform === 'darwin' && pathApi.join(home, 'Library', 'pnpm'),
      pathApi.join(home, '.local', 'share', 'pnpm'),
      pathApi.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
      ...fnmDataRoots.flatMap(root => versionManagerBins(root, ['installation', 'bin'], options)),
      pathApi.join(home, '.nvm', 'current', 'bin'),
      ...versionManagerBins(pathApi.join(home, '.nvm', 'versions', 'node'), ['bin'], options),
      pathApi.join(home, '.asdf', 'shims'),
      pathApi.join(home, '.local', 'share', 'mise', 'shims'),
      pathApi.join(home, '.nodenv', 'shims'),
      pathApi.join(home, '.bun', 'bin'),
      pathApi.join(home, '.local', 'bin'),
      pathApi.join(home, '.local', 'opt', 'npm-global', 'bin'),
      pathApi.join(home, '.npm-global', 'bin'),
      pathApi.join(home, '.kimi-code', 'bin'),
      pathApi.join(home, '.mimocode', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
    ], platform)
  }

  const appData = envValue(env, 'APPDATA')
  const localAppData = envValue(env, 'LOCALAPPDATA')
  const programFiles = envValue(env, 'ProgramFiles')
  const programFilesX86 = envValue(env, 'ProgramFiles(x86)')
  const programData = envValue(env, 'ProgramData')
  const chocolatey = envValue(env, 'ChocolateyInstall')
  const scoop = envValue(env, 'SCOOP')
  const nvmHome = envValue(env, 'NVM_HOME')
  const nvmSymlink = envValue(env, 'NVM_SYMLINK')
  const workBuddyCli = base => base && pathApi.join(
    base, 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin',
  )
  return uniquePaths([
    ...configured,
    pathApi.join(home, '.local', 'bin'),
    pathApi.join(home, '.local', 'opt', 'npm-global', 'bin'),
    pathApi.join(home, '.npm-global', 'bin'),
    pathApi.join(home, '.kimi-code', 'bin'),
    pathApi.join(home, '.mimocode', 'bin'),
    pnpmHome,
    appData && pathApi.join(appData, 'npm'),
    localAppData && pathApi.join(localAppData, 'npm'),
    localAppData && pathApi.join(localAppData, 'pnpm'),
    localAppData && pathApi.join(localAppData, 'Programs', 'nodejs'),
    localAppData && pathApi.join(localAppData, 'Microsoft', 'WindowsApps'),
    localAppData && workBuddyCli(pathApi.join(localAppData, 'Programs')),
    nvmSymlink,
    nvmHome,
    programFiles && pathApi.join(programFiles, 'nodejs'),
    programFiles && workBuddyCli(programFiles),
    programFilesX86 && pathApi.join(programFilesX86, 'nodejs'),
    programFilesX86 && workBuddyCli(programFilesX86),
    chocolatey && pathApi.join(chocolatey, 'bin'),
    programData && pathApi.join(programData, 'chocolatey', 'bin'),
    scoop && pathApi.join(scoop, 'shims'),
    pathApi.join(home, 'scoop', 'shims'),
  ], platform)
}

function searchPath(options = {}) {
  const { pathApi } = runtimeOptions(options)
  return searchDirectories(options).join(pathApi.delimiter)
}

function agentCommands(kind, options = {}) {
  const { platform, home, pathApi } = runtimeOptions(options)
  const commands = [...AGENT_PROFILES[kind].commands]
  if (kind === 'codex' && platform === 'darwin') {
    commands.push('/Applications/ChatGPT.app/Contents/Resources/codex')
    commands.push(pathApi.join(
      home, 'Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex',
    ))
  }
  if (kind === 'workbuddy' && platform === 'darwin') {
    commands.push('/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy')
    commands.push(pathApi.join(
      home, 'Applications', 'WorkBuddy.app', 'Contents', 'Resources',
      'app.asar.unpacked', 'cli', 'bin', 'codebuddy',
    ))
  }
  return commands
}

// The WorkBuddy app ships its CLI with only the lite bundle, which the
// launcher loads solely when this variable is set. Without it every headless
// call, `--help` included, exits with MODULE_NOT_FOUND. Installs that carry a
// regular bundle launch exactly as before.
function launchEnvironment(kind, executable, options = {}) {
  if (kind !== 'workbuddy' || !executable) return {}
  const { pathApi } = runtimeOptions(options)
  try {
    const dist = pathApi.join(pathApi.dirname(fs.realpathSync(executable)), '..', 'dist')
    const shipped = name => fs.existsSync(pathApi.join(dist, name))
    if (shipped('codebuddy-lite-wb.mjs') && !shipped('codebuddy-headless.js') && !shipped('codebuddy.js')) {
      return { CODEBUDDY_FORCE_LITE_WB_BUNDLE: '1' }
    }
  } catch { /* an unreadable layout keeps the default launch */ }
  return {}
}

function executableExtensions(options = {}) {
  const { platform, env } = runtimeOptions(options)
  if (platform !== 'win32') return ['']
  const configured = String(envValue(env, 'PATHEXT') || '')
    .split(';')
    .map(extension => extension.trim())
    .filter(Boolean)
    .map(extension => extension.startsWith('.') ? extension : `.${extension}`)
  return ['', ...(configured.length ? configured : DEFAULT_WINDOWS_PATHEXT)]
}

function executableCandidates(command, options = {}) {
  const { platform, pathApi } = runtimeOptions(options)
  const names = platform === 'win32' && !pathApi.extname(command)
    ? executableExtensions(options).map(extension => `${command}${extension}`)
    : [command]
  if (pathApi.isAbsolute(command)) return names
  return searchDirectories(options).flatMap(directory => names.map(name => pathApi.join(directory, name)))
}

async function* resolvedExecutableCandidates(kind, options = {}) {
  if (!ALLOWED_KINDS.includes(kind)) return
  const runtime = runtimeOptions(options)
  const { platform, env, pathApi, accessFn, execFileFn } = runtime
  const commands = agentCommands(kind, options)
  const seen = new Set()
  const candidateKey = candidate => platform === 'win32' ? candidate.toLowerCase() : candidate
  const lookupEnv = {
    ...systemChildEnvironment(env, platform),
    PATH: searchPath(options),
  }
  for (const command of commands) {
    for (const candidate of executableCandidates(command, options)) {
      const key = candidateKey(candidate)
      if (seen.has(key)) continue
      seen.add(key)
      try {
        await accessFn(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK)
        yield candidate
      } catch { /* keep searching */ }
    }
  }
  for (const command of commands.filter(candidate => !pathApi.isAbsolute(candidate))) {
    try {
      const lookupCommand = platform === 'win32'
        ? 'where.exe'
        : (platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
      const lookupArgs = platform === 'win32' ? [command] : ['-lc', `command -v -- ${command}`]
      const { stdout } = await execFileFn(lookupCommand, lookupArgs, {
        timeout: 5000,
        windowsHide: true,
        env: lookupEnv,
      })
      for (const line of String(stdout || '').split(/\r?\n/)) {
        const candidate = line.trim().replace(/^"|"$/g, '')
        if (!candidate || !pathApi.isAbsolute(candidate)) continue
        const key = candidateKey(candidate)
        if (seen.has(key)) continue
        seen.add(key)
        try {
          await accessFn(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK)
          yield candidate
        } catch { /* keep checking lookup results */ }
      }
    } catch { /* keep searching */ }
  }
}

async function resolveExecutable(kind, options = {}) {
  for await (const executable of resolvedExecutableCandidates(kind, options)) return executable
  return null
}

function npmShimTarget(executable, options = {}) {
  const readFileFn = options.readFileFn || (filename => fs.readFileSync(filename, 'utf8'))
  let source
  try {
    source = String(readFileFn(executable))
  } catch {
    return ''
  }
  const matches = [...source.matchAll(/"([^"\r\n]+)"\s+%\*/gi)]
  for (const match of matches.reverse()) {
    const token = match[1]
    if (!/^%(?:dp0%|~dp0)[\\/]/i.test(token)) continue
    const relative = token.replace(/^%(?:dp0%|~dp0)[\\/]+/i, '')
    const shimDirectory = path.win32.dirname(executable)
    const target = path.win32.resolve(shimDirectory, relative)
    const nestedPath = path.win32.relative(shimDirectory, target)
    const remainsBeneathShim = nestedPath
      && !path.win32.isAbsolute(nestedPath)
      && nestedPath !== '..'
      && !nestedPath.startsWith(`..${path.win32.sep}`)
    const isNodeModuleBin = nestedPath.split(/[\\/]+/)
      .some(segment => segment.toLowerCase() === 'node_modules')
    const extension = path.win32.extname(relative).toLowerCase()
    const supportedTarget = !extension
      || ['.cjs', '.mjs', '.js', '.com', '.exe'].includes(extension)
    if (remainsBeneathShim && isNodeModuleBin && supportedTarget) return target
  }
  return ''
}

function prepareCommand(command, args, options = {}) {
  const { platform } = runtimeOptions(options)
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(command)) return { command, args }
  const target = npmShimTarget(command, options)
  if (!target) throw new Error('LOCAL_CLI_WRAPPER_UNSUPPORTED')
  const existsFn = options.existsFn || fs.existsSync
  if (/\.(?:com|exe)$/i.test(target)) {
    if (!existsFn(target)) throw new Error('LOCAL_CLI_WRAPPER_UNSUPPORTED')
    return { command: target, args }
  }
  const bundledNode = path.win32.join(path.win32.dirname(command), 'node.exe')
  return {
    command: existsFn(bundledNode) ? bundledNode : 'node.exe',
    args: [target, ...args],
  }
}

async function probeAgentCapabilities(kind, executable, options = {}) {
  const runtime = runtimeOptions(options)
  const { env, execFileFn, platform } = runtime
  const prepareCommandFn = options.prepareCommandFn || prepareCommand
  const childEnv = {
    ...(options.childEnv || {
      ...systemChildEnvironment(env, platform),
      PATH: searchPath(options),
    }),
    ...launchEnvironment(kind, executable, options),
  }
  let identity = ''
  try {
    const stat = (options.statFn || fs.statSync)(executable)
    identity = JSON.stringify([
      kind, executable, options.version || '', stat.dev, stat.ino,
      stat.size, stat.mtimeMs, stat.ctimeMs,
    ])
  } catch { /* caching requires a verifiable executable identity */ }
  const cacheKey = `${kind}:${executable}`
  const prior = capabilityCache.get(cacheKey)
  const recentCompatible = identity && prior?.identity === identity
    && Date.now() - prior.checkedAt < CAPABILITY_CACHE_TTL_MS
  const results = await Promise.all(capabilityProbes(kind).map(async (probe) => {
    for (const timeout of probe.timeout ? [probe.timeout] : [8000, 16000]) {
      try {
        const command = prepareCommandFn(executable, probe.args, options)
        const result = await execFileFn(command.command, command.args, {
          timeout,
          windowsHide: true,
          env: childEnv,
        })
        return { probe, output: `${result.stdout || ''}\n${result.stderr || ''}` }
      } catch (error) {
        const timedOut = error?.killed === true || error?.code === 'ETIMEDOUT'
        if (timedOut && timeout === 8000) continue
        return { probe, error: true, timedOut }
      }
    }
  }))
  const failed = results.find(result => !result.timedOut && (result.error
    || result.probe.requiredText.some(value => !result.output.includes(value))
    || (result.probe.validateOutput && !result.probe.validateOutput(result.output))))
  if (failed) capabilityCache.delete(cacheKey)
  for (const result of results) {
    const { probe } = result
    if (result.timedOut && !failed) {
      if (recentCompatible) continue
      return {
        compatibilityState: 'unknown',
        incompatibilityReason: 'LOCAL_AGENT_CAPABILITY_PROBE_TIMEOUT',
        incompatibilityProbe: probe.id,
      }
    }
    if (result.timedOut) continue
    if (result.error) {
      return {
        compatibilityState: 'incompatible',
        incompatibilityReason: probe.id.endsWith('-acp')
          ? 'LOCAL_AGENT_PROTOCOL_UNAVAILABLE'
          : 'LOCAL_AGENT_REQUIRED_CAPABILITY_MISSING',
        incompatibilityProbe: probe.id,
      }
    }
    if (probe.requiredText.some(value => !result.output.includes(value))) {
      return {
        compatibilityState: 'incompatible',
        incompatibilityReason: 'LOCAL_AGENT_REQUIRED_CAPABILITY_MISSING',
        incompatibilityProbe: probe.id,
      }
    }
  }
  if (identity && !results.some(result => result.timedOut)) {
    capabilityCache.set(cacheKey, { identity, checkedAt: Date.now() })
  }
  return {
    compatibilityState: 'compatible',
    incompatibilityReason: '',
    incompatibilityProbe: '',
  }
}

async function inspectAgentCandidate(kind, executable, options, childEnv) {
  const runtime = runtimeOptions(options)
  const { execFileFn } = runtime
  const prepareCommandFn = options.prepareCommandFn || prepareCommand
  const incompatibleCapabilities = {
    compatibilityState: 'incompatible',
    incompatibilityReason: 'LOCAL_AGENT_REQUIRED_CAPABILITY_MISSING',
    incompatibilityProbe: '',
  }
  const versionTask = (async () => {
    try {
      const versionCommand = prepareCommandFn(executable, ['--version'], options)
      const result = await execFileFn(versionCommand.command, versionCommand.args, {
        timeout: 8000,
        windowsHide: true,
        env: childEnv,
      })
      const identified = identifyAgentVersion(kind, [result.stdout, result.stderr], { executable })
      return {
        succeeded: true,
        version: identified?.line || '',
        versionIdentified: Boolean(identified),
      }
    } catch { /* capability probes can still establish whether this installation works */ }
    return { succeeded: false, version: '', versionIdentified: false }
  })()

  const { version } = await versionTask
  const versionCompatibility = assessAgentVersion(kind, version)
  const capabilityTask = Promise.resolve().then(async () => {
    const result = await (options.probeAgentCapabilitiesFn || probeAgentCapabilities)(
      kind,
      executable,
      { ...options, childEnv, version },
    )
    return result && typeof result === 'object' ? result : incompatibleCapabilities
  }).catch(() => incompatibleCapabilities)
  const acpTask = kind === 'hermes'
    ? (async () => {
        try {
          const checkCommand = prepareCommandFn(executable, ['acp', '--check'], options)
          await execFileFn(checkCommand.command, checkCommand.args, {
            timeout: 8000,
            windowsHide: true,
            env: childEnv,
          })
          return true
        } catch {
          return false
        }
      })()
    : Promise.resolve(undefined)
  const [capabilityCompatibility, acpAvailable] = await Promise.all([capabilityTask, acpTask])
  const compatibility = capabilityCompatibility.compatibilityState !== 'compatible'
    ? { ...versionCompatibility, ...capabilityCompatibility }
    : {
        ...versionCompatibility,
        compatibilityState: 'compatible',
        incompatibilityReason: '',
        incompatibilityProbe: '',
      }
  return {
    kind,
    name: `${AGENT_PROFILES[kind].label} CLI`,
    executable,
    version,
    ...compatibility,
    ...(kind === 'hermes' ? { acpAvailable } : {}),
  }
}

async function detectAgentKind(kind, options, childEnv) {
  const resolved = typeof options.resolveExecutableFn === 'function'
    ? await options.resolveExecutableFn(kind)
    : null
  const candidates = typeof options.resolveExecutableFn === 'function'
    ? (resolved ? [resolved] : [])
    : resolvedExecutableCandidates(kind, options)
  let firstIncompatible = null
  for await (const executable of candidates) {
    const candidate = await inspectAgentCandidate(kind, executable, options, childEnv)
    if (!candidate) continue
    if (candidate.compatibilityState === 'compatible') return candidate
    firstIncompatible ||= candidate
  }
  return firstIncompatible
}

async function detectAgents(options = {}) {
  const runtime = runtimeOptions(options)
  const { env, platform } = runtime
  const childEnv = {
    ...systemChildEnvironment(env, platform),
    PATH: searchPath(options),
  }
  const detected = await Promise.all(ALLOWED_KINDS.map(kind => (
    detectAgentKind(kind, options, childEnv).catch(() => null)
  )))
  return detected.filter(Boolean)
}

module.exports = {
  AGENT_PROFILES,
  ALLOWED_KINDS,
  detectAgents,
  launchEnvironment,
  prepareCommand,
  probeAgentCapabilities,
  resolveExecutable,
  searchPath,
  systemChildEnvironment,
}

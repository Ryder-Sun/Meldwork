const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { isDeepStrictEqual } = require('node:util')

const { atomicWritePrivateFile } = require('../../security/private-file.cjs')

const MANAGED_OPENCLAW_PROVIDER_ID = 'meldwork-desktop'
const READ_ONLY_TOOLS = [
  'read', 'web_search', 'web_fetch', 'memory_search', 'memory_get', 'session_status',
]
const WRITE_TOOLS = ['write', 'edit', 'apply_patch']
const DENIED_TOOLS = [
  'exec', 'process', 'code_execution', 'browser', 'canvas', 'gateway', 'nodes', 'cron',
  'message', 'sessions_send', 'sessions_spawn', 'subagents',
]
const OPENCLAW_MODEL_REF = /^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,239}$/
const NATIVE_OPENCLAW_PROVIDER_ID = /^[a-z][a-z0-9_-]{0,63}$/
const NATIVE_OPENCLAW_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,239}$/
const NATIVE_OPENCLAW_MODEL_INPUTS = new Set(['text', 'image', 'audio', 'video'])
const OPENCLAW_PROVIDER_APIS = new Set([
  'openai-completions',
  'openai-responses',
  'openai-chatgpt-responses',
  'anthropic-messages',
  'google-generative-ai',
  'google-vertex',
  'github-copilot',
  'bedrock-converse-stream',
  'ollama',
  'azure-openai-responses',
])
const OPENCLAW_RUNTIME_PATH_ENV_KEYS = Object.freeze([
  'OPENCLAW_HOME',
  'OPENCLAW_STATE_DIR',
  'OPENCLAW_CONFIG_PATH',
  'OPENCLAW_WORKSPACE_DIR',
])
const OPENCLAW_RUNTIME_CREDENTIAL_KEYS = new Set([
  'MELDWORK_OPENCLAW_API_KEY',
  'MELDWORK_OPENCLAW_NATIVE_API_KEY',
  'OPENCLAW_GATEWAY_TOKEN',
])
const issuedOpenClawRuntimeGuards = new WeakSet()
const openClawRuntimeCredentialDigests = new WeakMap()
const openClawRuntimeConfigs = new WeakMap()
const OPENCLAW_ENV_SECRET_NAME = /^[A-Z][A-Z0-9_]{0,127}$/
const OPENCLAW_SECRET_MARKERS = new Set([
  'secretref-managed',
  'minimax-oauth',
  'ollama-local',
  'custom-local',
  'codex-app-server',
  'gcp-vertex-credentials',
])

function isOpenClawSecretReference(input) {
  if (input && typeof input === 'object') return true
  if (typeof input !== 'string') return false
  const value = input.trim()
  if (!value) return false
  if (OPENCLAW_ENV_SECRET_NAME.test(value)) return true
  if (/^\$(?:[A-Z][A-Z0-9_]{0,127}|\{[A-Z][A-Z0-9_]{0,127}\})$/.test(value)) return true
  if (/^(?:secretref-env:|__env__:)[A-Z][A-Z0-9_]{0,127}$/.test(value)) return true
  return value.startsWith('oauth:') || OPENCLAW_SECRET_MARKERS.has(value)
}

function identityValue(value) {
  return typeof value === 'bigint' ? value.toString() : String(value)
}

function sameFilesystemIdentity(stat, expected) {
  return identityValue(stat.dev) === expected.dev
    && identityValue(stat.ino) === expected.ino
    && (expected.birthtime === undefined
      || identityValue(stat.birthtimeMs) === expected.birthtime)
}

function directoryIdentity(filename) {
  const resolved = path.resolve(filename)
  const stat = fs.lstatSync(resolved)
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== resolved) {
    throw new Error('OPENCLAW_RUNTIME_UNSAFE_PATH')
  }
  return Object.freeze({
    path: resolved,
    dev: identityValue(stat.dev),
    ino: identityValue(stat.ino),
    birthtime: identityValue(stat.birthtimeMs),
    mode: stat.mode,
  })
}

function readRuntimeConfigFile(filename) {
  const resolved = path.resolve(filename)
  const entry = fs.lstatSync(resolved)
  if (!entry.isFile() || entry.isSymbolicLink() || fs.realpathSync(resolved) !== resolved) {
    throw new Error('OPENCLAW_RUNTIME_UNSAFE_PATH')
  }
  const noFollow = fs.constants.O_NOFOLLOW || 0
  const descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | noFollow)
  try {
    const before = fs.fstatSync(descriptor)
    if (!before.isFile() || before.size > 256 * 1024 || !sameFilesystemIdentity(before, {
      dev: identityValue(entry.dev),
      ino: identityValue(entry.ino),
      birthtime: identityValue(entry.birthtimeMs),
    })) {
      throw new Error('OPENCLAW_RUNTIME_UNSAFE_PATH')
    }
    const buffer = Buffer.alloc(256 * 1024 + 1)
    let length = 0
    while (length < buffer.length) {
      const count = fs.readSync(descriptor, buffer, length, buffer.length - length, null)
      if (!count) break
      length += count
    }
    if (length === buffer.length) throw new Error('OPENCLAW_RUNTIME_UNSAFE_PATH')
    const contents = buffer.subarray(0, length)
    const after = fs.fstatSync(descriptor)
    const current = fs.lstatSync(resolved)
    if (!sameFilesystemIdentity(after, {
      dev: identityValue(before.dev),
      ino: identityValue(before.ino),
      birthtime: identityValue(before.birthtimeMs),
    }) || current.isSymbolicLink() || !current.isFile()
        || !sameFilesystemIdentity(current, {
          dev: identityValue(before.dev),
          ino: identityValue(before.ino),
          birthtime: identityValue(before.birthtimeMs),
        }) || fs.realpathSync(resolved) !== resolved) {
      throw new Error('OPENCLAW_RUNTIME_UNSAFE_PATH')
    }
    const identity = Object.freeze({
      path: resolved,
      dev: identityValue(before.dev),
      ino: identityValue(before.ino),
      birthtime: identityValue(before.birthtimeMs),
      mode: before.mode,
      size: contents.length,
      digest: crypto.createHash('sha256').update(contents).digest('hex'),
    })
    return { identity, contents: contents.toString('utf8') }
  } finally {
    fs.closeSync(descriptor)
  }
}

function fileIdentity(filename) {
  return readRuntimeConfigFile(filename).identity
}

function validateDirectoryIdentities(identities) {
  for (const expected of identities) {
    const current = directoryIdentity(expected.path)
    if (current.dev !== expected.dev || current.ino !== expected.ino) {
      throw new Error('OPENCLAW_RUNTIME_UNSAFE_PATH')
    }
    if (current.birthtime !== expected.birthtime
        || (process.platform !== 'win32' && (current.mode & 0o777) !== 0o700)) {
      throw new Error('OPENCLAW_RUNTIME_UNSAFE_PATH')
    }
  }
}

function validateFileIdentity(expected) {
  const current = fileIdentity(expected.path)
  if (current.dev !== expected.dev || current.ino !== expected.ino
      || current.birthtime !== expected.birthtime
      || (process.platform !== 'win32' && (current.mode & 0o777) !== 0o600)
      || current.size !== expected.size || current.digest !== expected.digest) {
    throw new Error('OPENCLAW_RUNTIME_UNSAFE_PATH')
  }
}

function normalizeProvider(input) {
  const apiKey = typeof input?.OPENAI_API_KEY === 'string' ? input.OPENAI_API_KEY.trim() : ''
  const baseUrl = String(input?.OPENAI_BASE_URL || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
  const model = String(input?.OPENAI_MODEL || '').trim()
  let parsed
  try { parsed = new URL(baseUrl) } catch { throw new Error('OPENCLAW_PROVIDER_INVALID') }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  if (!apiKey || apiKey.length > 8192 || isOpenClawSecretReference(apiKey)
      || !model || model.length > 120
      || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback))
      || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('OPENCLAW_PROVIDER_INVALID')
  }
  return { apiKey, baseUrl, model }
}

function runtimePaths({ storageRoot, workdir, sessionRef, configName, runtimeVersion }) {
  if (!path.isAbsolute(storageRoot) || !path.isAbsolute(workdir)) {
    throw new Error('OPENCLAW_RUNTIME_INVALID_SCOPE')
  }
  let resolvedStorageRoot
  try {
    resolvedStorageRoot = fs.realpathSync(path.resolve(storageRoot))
    if (!fs.statSync(resolvedStorageRoot).isDirectory()) throw new Error('invalid')
  } catch {
    throw new Error('OPENCLAW_RUNTIME_INVALID_SCOPE')
  }
  const resolvedWorkdir = path.resolve(workdir)
  // The managed scope is keyed by session, workspace, and CLI version. OpenClaw
  // refuses to start on state written by an older CLI ("Legacy workspace setup
  // state requires migration"), so a version-scoped directory gives an upgraded
  // CLI a fresh isolated scope instead of a guaranteed startup failure.
  const versionSegment = String(runtimeVersion || '').trim()
  const scope = crypto.createHash('sha256')
    .update(versionSegment
      ? `${sessionRef || 'configure'}\0${resolvedWorkdir}\0${versionSegment}`
      : `${sessionRef || 'configure'}\0${resolvedWorkdir}`)
    .digest('hex')
    .slice(0, 24)
  const runtimeRoot = path.join(resolvedStorageRoot, 'openclaw-managed', scope)
  const home = path.join(runtimeRoot, 'home')
  const state = path.join(runtimeRoot, 'state')
  const configPath = path.join(runtimeRoot, configName)
  const directories = [
    path.join(resolvedStorageRoot, 'openclaw-managed'),
    runtimeRoot,
    home,
    path.join(home, '.config'),
    path.join(home, '.local'),
    path.join(home, '.local', 'share'),
    path.join(home, '.local', 'state'),
    path.join(home, '.cache'),
    path.join(home, '.runtime'),
    path.join(home, 'AppData'),
    path.join(home, 'AppData', 'Roaming'),
    path.join(home, 'AppData', 'Local'),
    state,
  ]
  for (const directory of directories) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 })
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    const stat = directoryIdentity(directory)
    if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700) {
      fs.chmodSync(directory, 0o700)
    }
  }
  const directoryIdentities = Object.freeze(directories.map(directoryIdentity))
  return { resolvedWorkdir, home, state, configPath, directoryIdentities }
}

function toolPolicy(allowWrite) {
  const allowedTools = allowWrite
    ? [...READ_ONLY_TOOLS, ...WRITE_TOOLS]
    : READ_ONLY_TOOLS
  return {
    allow: allowedTools,
    deny: DENIED_TOOLS,
    fs: { workspaceOnly: true },
    exec: { security: 'deny', ask: 'always' },
    elevated: { enabled: false },
  }
}

function writeRuntimeConfig(runtime, config, credentials, credentialKey) {
  const credentialEntries = Object.entries(credentials || {})
  if (!credentialEntries.length
      || credentialEntries.some(([key, value]) => (
        !OPENCLAW_RUNTIME_CREDENTIAL_KEYS.has(key)
          || typeof value !== 'string' || !value
      ))
      || !credentials[credentialKey]) {
    throw new Error('OPENCLAW_RUNTIME_CREDENTIAL_SCOPE_INVALID')
  }
  const contents = `${JSON.stringify(config, null, 2)}\n`
  validateDirectoryIdentities(runtime.directoryIdentities)
  atomicWritePrivateFile(runtime.configPath, contents)
  validateDirectoryIdentities(runtime.directoryIdentities)
  const configIdentity = fileIdentity(runtime.configPath)
  const guard = Object.freeze({
    directories: runtime.directoryIdentities,
    config: configIdentity,
    paths: Object.freeze({
      OPENCLAW_HOME: runtime.home,
      OPENCLAW_STATE_DIR: runtime.state,
      OPENCLAW_CONFIG_PATH: runtime.configPath,
      OPENCLAW_WORKSPACE_DIR: runtime.resolvedWorkdir,
    }),
    credentialKey,
    credentialKeys: Object.freeze(credentialEntries.map(([key]) => key)),
  })
  issuedOpenClawRuntimeGuards.add(guard)
  openClawRuntimeConfigs.set(guard, contents)
  openClawRuntimeCredentialDigests.set(guard, Object.freeze(Object.fromEntries(
    credentialEntries.map(([key, value]) => [
      key,
      crypto.createHash('sha256').update(value).digest('hex'),
    ]),
  )))
  return guard
}

function validateRuntimeScope(guard, env = {}) {
  const credentialDigests = guard && typeof guard === 'object'
    ? openClawRuntimeCredentialDigests.get(guard)
    : undefined
  if (!guard || typeof guard !== 'object' || !issuedOpenClawRuntimeGuards.has(guard)
      || !Array.isArray(guard.directories)
      || !guard.config || !guard.paths
      || !OPENCLAW_RUNTIME_CREDENTIAL_KEYS.has(guard.credentialKey)
      || !Array.isArray(guard.credentialKeys) || !guard.credentialKeys.length
      || guard.credentialKeys.some(key => !OPENCLAW_RUNTIME_CREDENTIAL_KEYS.has(key))
      || !credentialDigests || typeof credentialDigests !== 'object') {
    throw new Error('OPENCLAW_RUNTIME_GUARD_REQUIRED')
  }
  for (const key of OPENCLAW_RUNTIME_PATH_ENV_KEYS) {
    if (env[key] !== guard.paths[key]) throw new Error('OPENCLAW_RUNTIME_UNSAFE_PATH')
  }
  for (const key of guard.credentialKeys) {
    if (typeof env[key] !== 'string' || !env[key]
        || crypto.createHash('sha256').update(env[key]).digest('hex')
          !== credentialDigests[key]) {
      throw new Error('OPENCLAW_RUNTIME_CREDENTIAL_SCOPE_INVALID')
    }
  }
  validateDirectoryIdentities(guard.directories)
}

function validateOpenClawRuntimeGuard(guard, env = {}) {
  validateRuntimeScope(guard, env)
  validateFileIdentity(guard.config)
  return true
}

function comparableMigratedConfig(config) {
  // OpenClaw materializes the implicit main agent and stamps migrations at startup.
  const result = JSON.parse(JSON.stringify(config))
  const meta = result.meta
  if (meta && typeof meta === 'object' && !Array.isArray(meta)
      && Object.keys(meta).every(key => ['migrations', 'lastTouchedVersion', 'lastTouchedAt'].includes(key))
      && (meta.lastTouchedVersion === undefined || /^\d{4}\.\d{1,2}\.\d{1,2}(?:[-+.][\w.-]+)?$/.test(meta.lastTouchedVersion))
      && (meta.lastTouchedAt === undefined || (typeof meta.lastTouchedAt === 'string' && Number.isFinite(Date.parse(meta.lastTouchedAt))))
      && (meta.migrations === undefined || isDeepStrictEqual(meta.migrations, { modelPolicyAllowlist: true }))) {
    delete result.meta
  }
  if (isDeepStrictEqual(result.agents?.entries, { main: {} })) delete result.agents.entries
  if (isDeepStrictEqual(result.discovery?.wideArea, { enabled: false })) {
    result.discovery.wideArea = {}
  }
  return result
}

function refreshOpenClawRuntimeAfterStartup(options) {
  const guard = options?.openClawRuntimeGuard
  const env = options?.env || {}
  validateRuntimeScope(guard, env)
  const { identity: config, contents } = readRuntimeConfigFile(guard.config.path)
  if (process.platform !== 'win32' && (config.mode & 0o777) !== 0o600) {
    throw new Error('OPENCLAW_RUNTIME_UNSAFE_PATH')
  }
  validateDirectoryIdentities(guard.directories)
  validateFileIdentity(config)
  let equivalent = false
  try {
    equivalent = isDeepStrictEqual(
      comparableMigratedConfig(JSON.parse(openClawRuntimeConfigs.get(guard))),
      comparableMigratedConfig(JSON.parse(contents)),
    )
  } catch { /* malformed config is rejected below */ }
  if (!equivalent) throw new Error('OPENCLAW_RUNTIME_UNSAFE_PATH')
  const refreshed = Object.freeze({ ...guard, config })
  issuedOpenClawRuntimeGuards.add(refreshed)
  openClawRuntimeConfigs.set(refreshed, contents)
  openClawRuntimeCredentialDigests.set(refreshed, openClawRuntimeCredentialDigests.get(guard))
  return { ...options, openClawRuntimeGuard: refreshed }
}

function configureOpenClawGatewayRuntime(options, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('OPENCLAW_GATEWAY_PORT_INVALID')
  }
  const guard = options?.openClawRuntimeGuard
  const env = options?.env || {}
  validateOpenClawRuntimeGuard(guard, env)

  const config = JSON.parse(openClawRuntimeConfigs.get(guard))
  const gatewayCredentialKey = 'OPENCLAW_GATEWAY_TOKEN'
  const nextConfig = {
    ...config,
    logging: {
      ...(config.logging || {}),
      file: path.join(guard.paths.OPENCLAW_STATE_DIR, 'gateway.log'),
    },
    update: {
      ...(config.update || {}),
      checkOnStart: false,
      auto: { ...(config.update?.auto || {}), enabled: false },
    },
    discovery: {
      ...(config.discovery || {}),
      wideArea: { ...(config.discovery?.wideArea || {}), enabled: false },
      mdns: { ...(config.discovery?.mdns || {}), mode: 'off' },
    },
    gateway: {
      ...(config.gateway || {}),
      port,
      mode: 'local',
      bind: 'loopback',
      controlUi: { ...(config.gateway?.controlUi || {}), enabled: false },
      auth: {
        mode: 'token',
        token: { source: 'env', provider: 'default', id: gatewayCredentialKey },
      },
      tailscale: { ...(config.gateway?.tailscale || {}), mode: 'off' },
    },
  }
  const credentials = Object.fromEntries(
    guard.credentialKeys.map(key => [key, env[key]]),
  )
  const runtime = {
    resolvedWorkdir: guard.paths.OPENCLAW_WORKSPACE_DIR,
    home: guard.paths.OPENCLAW_HOME,
    state: guard.paths.OPENCLAW_STATE_DIR,
    configPath: guard.paths.OPENCLAW_CONFIG_PATH,
    directoryIdentities: guard.directories,
  }
  return {
    ...options,
    env: { ...env },
    openClawRuntimeGuard: writeRuntimeConfig(
      runtime,
      nextConfig,
      credentials,
      guard.credentialKey,
    ),
  }
}

function normalizedNativeModel(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const id = String(input.id || '').trim()
  const name = String(input.name || '').trim()
  if (!NATIVE_OPENCLAW_MODEL_ID.test(id) || !name || name.length > 240) return null
  const model = { id, name }
  if (!Array.isArray(input.input) || !input.input.length
      || input.input.some(value => !NATIVE_OPENCLAW_MODEL_INPUTS.has(value))) return null
  model.input = [...new Set(input.input)]
  for (const key of ['contextWindow', 'contextTokens', 'maxTokens']) {
    const value = input[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1_000_000_000) {
      model[key] = value
    }
  }
  if (typeof input.reasoning === 'boolean') model.reasoning = input.reasoning
  if (input.cost && typeof input.cost === 'object' && !Array.isArray(input.cost)) {
    const cost = {}
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
      const value = input.cost[key]
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000) {
        cost[key] = value
      }
    }
    if (Object.keys(cost).length) model.cost = cost
  }
  return model
}

function managedOpenClawOptions({
  storageRoot, workdir, sessionRef = '', allowWrite = false, provider, openclawVersion,
}) {
  const normalized = normalizeProvider(provider)
  const configName = allowWrite
    ? 'openclaw.provider.workspace-write.json'
    : 'openclaw.provider.read-only.json'
  const runtime = runtimePaths({
    storageRoot, workdir, sessionRef, configName, runtimeVersion: openclawVersion,
  })
  const { resolvedWorkdir, home, state, configPath } = runtime

  const modelRef = `${MANAGED_OPENCLAW_PROVIDER_ID}/${normalized.model}`
  const gatewayCredentialKey = 'OPENCLAW_GATEWAY_TOKEN'
  const gatewayToken = crypto.randomBytes(32).toString('base64url')
  const config = {
    agents: {
      defaults: {
        workspace: resolvedWorkdir,
        model: { primary: modelRef },
        skipBootstrap: true,
      },
    },
    models: {
      mode: 'replace',
      providers: {
        [MANAGED_OPENCLAW_PROVIDER_ID]: {
          baseUrl: normalized.baseUrl,
          apiKey: {
            source: 'env', provider: 'default', id: 'MELDWORK_OPENCLAW_API_KEY',
          },
          api: 'openai-completions',
          models: [{ id: normalized.model, name: normalized.model, input: ['text'] }],
        },
      },
    },
    tools: toolPolicy(allowWrite),
    gateway: {
      mode: 'local',
      bind: 'loopback',
      auth: {
        mode: 'token',
        token: { source: 'env', provider: 'default', id: gatewayCredentialKey },
      },
      controlUi: { enabled: false },
    },
  }
  const credentialKey = 'MELDWORK_OPENCLAW_API_KEY'
  const openClawRuntimeGuard = writeRuntimeConfig(runtime, config, {
    [credentialKey]: normalized.apiKey,
    [gatewayCredentialKey]: gatewayToken,
  }, credentialKey)

  return {
    openClawRuntimeGuard,
    env: {
      OPENCLAW_HOME: home,
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_WORKSPACE_DIR: resolvedWorkdir,
      [credentialKey]: normalized.apiKey,
      [gatewayCredentialKey]: gatewayToken,
    },
  }
}

function nativeOpenClawOptions({
  storageRoot, workdir, sessionRef = '', allowWrite = false, runtime, openclawVersion,
}) {
  const modelRef = String(runtime?.model || '').trim()
  const provider = runtime?.provider
  const providerId = String(provider?.id || '').trim()
  const apiKey = typeof provider?.apiKey === 'string' ? provider.apiKey.trim() : ''
  const baseUrl = String(provider?.baseUrl || '').trim()
  const api = String(provider?.api || '').trim()
  const model = normalizedNativeModel(provider?.model)
  if (!OPENCLAW_MODEL_REF.test(modelRef)
      || !NATIVE_OPENCLAW_PROVIDER_ID.test(providerId)
      || !apiKey || apiKey.length > 8192 || isOpenClawSecretReference(apiKey)
      || !OPENCLAW_PROVIDER_APIS.has(api)
      || !model || typeof model !== 'object' || Array.isArray(model)
      || String(model.id || '').trim() === ''
      || modelRef !== `${providerId}/${model.id}`) {
    throw new Error('OPENCLAW_NATIVE_RUNTIME_INVALID')
  }
  let parsedBaseUrl
  try { parsedBaseUrl = new URL(baseUrl) } catch { /* handled below */ }
  const loopback = parsedBaseUrl
    && ['localhost', '127.0.0.1', '[::1]'].includes(parsedBaseUrl.hostname)
  if (!parsedBaseUrl
      || (parsedBaseUrl.protocol !== 'https:' && !(parsedBaseUrl.protocol === 'http:' && loopback))
      || parsedBaseUrl.username || parsedBaseUrl.password
      || parsedBaseUrl.search || parsedBaseUrl.hash) {
    throw new Error('OPENCLAW_NATIVE_RUNTIME_INVALID')
  }
  const configName = allowWrite
    ? 'openclaw.native.workspace-write.json'
    : 'openclaw.native.read-only.json'
  const runtimePathsResult = runtimePaths({
    storageRoot, workdir, sessionRef, configName, runtimeVersion: openclawVersion,
  })
  const { resolvedWorkdir, home, state, configPath } = runtimePathsResult
  const modelConfig = { primary: modelRef }
  const gatewayCredentialKey = 'OPENCLAW_GATEWAY_TOKEN'
  const gatewayToken = crypto.randomBytes(32).toString('base64url')
  const config = {
    agents: {
      defaults: {
        workspace: resolvedWorkdir,
        model: modelConfig,
        skipBootstrap: true,
      },
    },
    models: {
      mode: 'replace',
      providers: {
        [providerId]: {
          baseUrl: baseUrl.replace(/\/+$/, ''),
          apiKey: {
            source: 'env', provider: 'default', id: 'MELDWORK_OPENCLAW_NATIVE_API_KEY',
          },
          api,
          models: [model],
        },
      },
    },
    tools: toolPolicy(allowWrite),
    gateway: {
      mode: 'local',
      bind: 'loopback',
      auth: {
        mode: 'token',
        token: { source: 'env', provider: 'default', id: gatewayCredentialKey },
      },
      controlUi: { enabled: false },
    },
  }
  const credentialKey = 'MELDWORK_OPENCLAW_NATIVE_API_KEY'
  const openClawRuntimeGuard = writeRuntimeConfig(
    runtimePathsResult,
    config,
    { [credentialKey]: apiKey, [gatewayCredentialKey]: gatewayToken },
    credentialKey,
  )
  return {
    openClawRuntimeGuard,
    env: {
      OPENCLAW_HOME: home,
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_WORKSPACE_DIR: resolvedWorkdir,
      [credentialKey]: apiKey,
      [gatewayCredentialKey]: gatewayToken,
    },
  }
}

module.exports = {
  configureOpenClawGatewayRuntime,
  isOpenClawSecretReference,
  managedOpenClawOptions,
  nativeOpenClawOptions,
  refreshOpenClawRuntimeAfterStartup,
  validateOpenClawRuntimeGuard,
}

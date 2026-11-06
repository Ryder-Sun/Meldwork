const { execFile } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { promisify } = require('node:util')
const yaml = require('js-yaml')
const { nativeSecretEnvKeys } = require('./cli/native-secret-environment.cjs')
const { prepareCommand, searchPath } = require('./cli/cli-adapters.cjs')
const { isOpenClawSecretReference } = require('./cli/openclaw-runtime.cjs')
const { NETWORK_ENV_KEYS, networkEnvironment } = require('./cli/cli-network-environment.cjs')
const { CONFIG_DIRECTORY_ENV_KEYS } = require('./cli/cli-config-directories.cjs')
const { workBuddyCredentialState } = require('./cli/workbuddy-runtime.cjs')
const { mimoConfiguredProvider } = require('./cli/mimo-native-config.cjs')

const execFileAsync = promisify(execFile)

const CREDENTIAL_FIELD = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|credential)$/i
const OPENCLAW_MODEL_REF = /^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,239}$/
const OPENCLAW_PROVIDER_ID = /^[a-z][a-z0-9_-]{0,63}$/
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
const OPENCLAW_MODEL_INPUTS = new Set(['text', 'image', 'audio', 'video'])
const MAX_CREDENTIAL_FILE_BYTES = 2 * 1024 * 1024
const MAX_SHELL_ENV_BYTES = 256 * 1024
const SHELL_ENV_CACHE_TTL_MS = 30000
// A login shell that loads nvm/conda/compinit can take several seconds,
// especially right after boot or under load.
const SHELL_ENV_TIMEOUT_MS = 10000
// When the shell does not answer and nothing better is known, retry soon
// instead of pinning the bare app environment for the whole cache window.
const SHELL_ENV_FAILURE_TTL_MS = 5000
const SHELL_ENV_MARKER = '__MELDWORK_NATIVE_ENV_V1__'
const VERTEX_MODEL_REGION_KEY = /^VERTEX_REGION_[A-Z0-9_]{1,120}$/
const CREDENTIAL_ENV_KEYS = Object.freeze({
  codex: ['CODEX_API_KEY', 'OPENAI_API_KEY'],
  hermes: ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY'],
  openclaw: ['OPENAI_API_KEY', 'OPENROUTER_API_KEY'],
  workbuddy: ['CODEBUDDY_API_KEY', 'CODEBUDDY_AUTH_TOKEN'],
  zcode: ['ANTHROPIC_API_KEY', 'ZCODE_API_KEY'],
  pi: ['PI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY'],
  kimi: ['MOONSHOT_API_KEY', 'KIMI_API_KEY', 'KIMI_MODEL_API_KEY', 'OPENAI_API_KEY'],
  mimo: ['MIMO_API_KEY'],
  deepseek: ['ZGCI_API_KEY'],
  claude: ['ANTHROPIC_API_KEY'],
  qwen: ['DASHSCOPE_API_KEY', 'OPENAI_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  opencode: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY'],
  opencodereview: ['OCR_LLM_TOKEN', 'OPENAI_API_KEY'],
})
const GOOGLE_CLOUD_ENV_KEYS = [
  'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION', 'GOOGLE_CLOUD_QUOTA_PROJECT', 'CLOUDSDK_CONFIG',
]
const RUNTIME_ENV_KEYS = Object.freeze({
  codex: ['CODEX_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'CODEX_HOME'],
  hermes: [
    'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY',
    'OPENAI_BASE_URL', 'OPENAI_MODEL', 'HERMES_INFERENCE_PROVIDER', 'HERMES_INFERENCE_MODEL',
    'OPENROUTER_BASE_URL', 'CUSTOM_BASE_URL', 'OLLAMA_HOST', 'OLLAMA_API_KEY',
    'HERMES_HOME', 'HERMES_DATA_DIR_SUFFIX',
  ],
  openclaw: ['OPENAI_API_KEY', 'OPENROUTER_API_KEY'],
  workbuddy: [
    'CODEBUDDY_API_KEY', 'CODEBUDDY_AUTH_TOKEN', 'CODEBUDDY_BASE_URL', 'CODEBUDDY_MODEL',
    'CODEBUDDY_CONFIG_DIR',
  ],
  zcode: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ZCODE_API_KEY', 'ZCODE_BASE_URL'],
  pi: [
    'PI_API_KEY', 'PI_BASE_URL', 'PI_MODEL',
    'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'PI_CODING_AGENT_DIR',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
    'AWS_BEARER_TOKEN_BEDROCK', 'AWS_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_REGION',
    'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_ROLE_ARN',
    'AWS_ROLE_SESSION_NAME', 'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    'AWS_CONTAINER_AUTHORIZATION_TOKEN', 'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
    'AWS_BEDROCK_FORCE_CACHE', 'AWS_BEDROCK_FORCE_HTTP', 'AWS_BEDROCK_SKIP_AUTH',
    'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_API_VERSION', 'AZURE_API_VERSION',
    'AZURE_OPENAI_BASE_URL', 'AZURE_OPENAI_RESOURCE_NAME', 'AZURE_OPENAI_DEPLOYMENT_NAME_MAP',
    'GOOGLE_CLOUD_API_KEY', ...GOOGLE_CLOUD_ENV_KEYS,
  ],
  kimi: [
    'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'KIMI_MODEL_API_KEY',
    'KIMI_MODEL_BASE_URL', 'KIMI_MODEL_NAME',
    'KIMI_MODEL_PROVIDER_TYPE', 'KIMI_MODEL_CAPABILITIES',
    'KIMI_MODEL_MAX_CONTEXT_SIZE', 'KIMI_MODEL_MAX_OUTPUT_SIZE',
    'KIMI_CODE_HOME',
    'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL',
  ],
  mimo: ['MIMO_API_KEY', 'MIMO_BASE_URL', 'MIMO_MODEL', 'MIMOCODE_CONFIG_DIR', 'MIMOCODE_CONFIG_CONTENT'],
  deepseek: ['ZGCI_API_KEY', 'DSH_HOME', 'DSH_AGENTS_HOME'],
  claude: [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'CLAUDE_CONFIG_DIR',
    'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_MANTLE',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK',
    'AWS_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_ROLE_ARN', 'AWS_ROLE_SESSION_NAME', 'AWS_WEB_IDENTITY_TOKEN_FILE',
    'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_BEDROCK_MANTLE_BASE_URL', 'ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION',
    ...GOOGLE_CLOUD_ENV_KEYS,
    'CLOUD_ML_REGION', 'ANTHROPIC_VERTEX_PROJECT_ID', 'ANTHROPIC_VERTEX_BASE_URL',
    'ANTHROPIC_FOUNDRY_RESOURCE', 'ANTHROPIC_FOUNDRY_BASE_URL',
    'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
    'AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_AUTHORITY_HOST',
    'AZURE_CLIENT_CERTIFICATE_PATH', 'AZURE_CLIENT_CERTIFICATE_PASSWORD', 'AZURE_FEDERATED_TOKEN_FILE',
    'AZURE_CONFIG_DIR',
  ],
  qwen: ['DASHSCOPE_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'QWEN_HOME'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_MODEL', 'GOOGLE_GEMINI_BASE_URL', ...GOOGLE_CLOUD_ENV_KEYS],
  opencode: [
    'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY',
    'OPENAI_BASE_URL', 'OPENAI_MODEL',
    'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT',
  ],
  opencodereview: [
    'OCR_LLM_TOKEN', 'OCR_LLM_URL', 'OCR_LLM_MODEL', 'OCR_USE_ANTHROPIC',
    'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL',
  ],
})
const SHELL_ENV_KEYS = Object.freeze([...new Set([
  'PATH',
  ...CONFIG_DIRECTORY_ENV_KEYS,
  ...NETWORK_ENV_KEYS,
  ...Object.values(RUNTIME_ENV_KEYS).flat(),
])])
const shellEnvironmentCache = new Map()

function readCredentialFile(filename) {
  try {
    const stat = fs.statSync(filename)
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CREDENTIAL_FILE_BYTES) return ''
    return fs.readFileSync(filename, 'utf8')
  } catch {
    return ''
  }
}

function containsCredential(value) {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(containsCredential)
  if (value.type === 'api_key' && credentialLiteral(value.key)) return true
  if (value.type === 'oauth' && (credentialLiteral(value.access) || credentialLiteral(value.refresh))) return true
  return Object.entries(value).some(([key, child]) => {
    if (CREDENTIAL_FIELD.test(key) && credentialLiteral(child)) return true
    return child && typeof child === 'object' && containsCredential(child)
  })
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

function jsonContainsCredential(filename) {
  try {
    const contents = readCredentialFile(filename)
    return Boolean(contents) && containsCredential(JSON.parse(contents))
  } catch {
    return false
  }
}

function textContainsCredential(filename) {
  try {
    return readCredentialFile(filename).split(/\r?\n/).some((line) => {
      const match = line.match(/^\s*([A-Za-z][A-Za-z0-9_-]*)\s*[:=]\s*(.+?)\s*$/)
      if (!match || !CREDENTIAL_FIELD.test(match[1])) return false
      const raw = match[2].trim()
      const value = (/^['"]/.test(raw) ? raw : raw.replace(/\s+#.*$/, ''))
        .replace(/^['"]|['"]$/g, '').trim()
      return credentialLiteral(value)
    })
  } catch {
    return false
  }
}

function hermesDeclaredCredentialKeys(options = {}) {
  const env = options.env || process.env
  const home = options.home || os.homedir()
  const root = env.HERMES_HOME
    ? String(env.HERMES_HOME).replace(/^~(?=$|[\\/])/, home)
    : (options.platform || process.platform) === 'win32'
      ? path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), `hermes${env.HERMES_DATA_DIR_SUFFIX || ''}`)
      : path.join(home, `.hermes${env.HERMES_DATA_DIR_SUFFIX || ''}`)
  if (!path.isAbsolute(root)) return []
  try {
    const filename = path.join(root, 'config.yaml')
    let config = {}
    try {
      const stat = fs.statSync(filename)
      if (!stat.isFile() || stat.size > 1024 * 1024) return []
      config = yaml.load(fs.readFileSync(filename, 'utf8')) || {}
      if (typeof config !== 'object' || Array.isArray(config)) return []
    } catch (error) {
      if (error?.code !== 'ENOENT') return []
    }
    const model = config.model && typeof config.model === 'object' && !Array.isArray(config.model)
      ? config.model : {}
    const fallbacks = [config.fallback_providers, config.fallback_model]
      .flatMap(value => Array.isArray(value) ? value : [value])
      .filter(entry => entry && typeof entry === 'object' && !Array.isArray(entry)).slice(0, 32)
    const nestedModel = model.default && typeof model.default === 'object' ? model.default : {}
    const currentProvider = String(model.provider || nestedModel.provider || env.HERMES_INFERENCE_PROVIDER || 'auto').trim().toLowerCase()
    const configuredProviders = config.providers && typeof config.providers === 'object' && !Array.isArray(config.providers)
      ? config.providers : {}
    const modelName = typeof model.default === 'string' ? model.default.trim() : ''
    const [modelPrefix, ...modelSuffix] = modelName.split('/')
    const qualifiedProvider = currentProvider === 'auto' && modelSuffix.join('/').trim()
      && Object.keys(configuredProviders).some(name => name.toLowerCase() === modelPrefix.trim().toLowerCase())
      ? modelPrefix.trim().toLowerCase() : ''
    const references = [qualifiedProvider || currentProvider,
      ...fallbacks.map(entry => String(entry.provider || '').trim().toLowerCase())].filter(Boolean)
    const providerKeys = references.filter(name => /^[a-z][a-z0-9_-]*$/.test(name)
      && !['auto', 'custom'].includes(name))
      .map(name => `${name.replace(/[-]+/g, '_').toUpperCase()}_API_KEY`)
    const allCandidates = references.includes('auto') || (currentProvider === 'custom' && !model.base_url)
      || fallbacks.some(entry => String(entry.provider || '').trim().toLowerCase() === 'custom' && !entry.base_url)
    const endpoints = [model, ...fallbacks].map(entry => String(entry.base_url || '').trim().replace(/\/+$/, '')).filter(Boolean)
    const matches = (entry, providerKey = '') => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
      if (entry.enabled === false || entry.enabled === 0 || entry.enabled === null || (typeof entry.enabled === 'string'
          && ['false', '0', 'no', 'off'].includes(entry.enabled.trim().toLowerCase()))) return false
      if (allCandidates) return true
      const aliases = [providerKey, entry.name, entry.provider_key].flatMap(value => {
        const raw = String(value || '').trim().toLowerCase()
        if (!raw) return []
        const normalized = raw.replace(/ /g, '-')
        const suffix = normalized.startsWith('custom:') ? normalized.slice(7) : normalized
        return [raw, normalized, suffix, `custom:${suffix}`]
      })
      if (references.some(name => aliases.includes(name))) return true
      const base = String(entry.base_url || entry.api || entry.url || '').trim().replace(/\/+$/, '')
      return references.includes('custom') && Boolean(base) && endpoints.includes(base)
    }
    const providers = Object.entries(configuredProviders).slice(0, 256)
      .filter(([key, value]) => matches(value, key)).map(([, value]) => value)
    const custom = Array.isArray(config.custom_providers) ? config.custom_providers.slice(0, 256).filter(entry => matches(entry)) : []
    const entries = [model, ...fallbacks, ...providers, ...custom]
    return nativeSecretEnvKeys([...entries.flatMap(entry => (
      entry && typeof entry === 'object' && !Array.isArray(entry) ? [entry.key_env, entry.api_key_env] : []
    )), ...providerKeys])
  } catch { return [] }
}

function zcodeDeclaredCredentialKeys(options = {}) {
  const home = options.home || os.homedir()
  try {
    const filename = path.join(home, '.zcode', 'cli', 'config.json')
    const stat = fs.statSync(filename)
    if (!stat.isFile() || stat.size > 1024 * 1024) return []
    const config = JSON.parse(fs.readFileSync(filename, 'utf8'))
    const model = config?.model && typeof config.model === 'object' && !Array.isArray(config.model) ? config.model : {}
    const models = [model.main, model.lite, ...(Array.isArray(model.available) ? model.available.slice(0, 32) : [])]
    const providers = config?.provider && typeof config.provider === 'object' && !Array.isArray(config.provider) ? config.provider : {}
    const names = []
    for (const item of models) {
      const provider = typeof item === 'string' ? item.split('/')[0]
        : item && typeof item === 'object' ? item.provider : ''
      if (typeof provider !== 'string' || !provider.trim()) continue
      const id = provider.trim()
      const entry = providers[id] && typeof providers[id] === 'object' ? providers[id] : {}
      names.push(id, id.replace(/^default[-_]/, ''), entry.name)
      if (entry.kind === 'openai' || id === 'openai') names.push('openai')
    }
    return nativeSecretEnvKeys(names.filter(value => typeof value === 'string').map(value => {
      const name = value.trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase()
      return name ? `${name}_API_KEY` : ''
    }))
  } catch { return [] }
}

function nativeCredentialEnvironment(kind, env = process.env, declaredKeys = []) {
  const result = {}
  const keys = [...(RUNTIME_ENV_KEYS[kind] || []), ...(kind === 'claude'
    ? Object.keys(env).filter(key => VERTEX_MODEL_REGION_KEY.test(key)) : []),
    ...(['hermes', 'zcode'].includes(kind) ? nativeSecretEnvKeys(declaredKeys) : [])]
  for (const key of keys) {
    if (typeof env[key] === 'string') result[key] = env[key]
  }
  return result
}

function nativeCredentialKeyEnvironment(kind, env = process.env) {
  const result = {}
  for (const key of CREDENTIAL_ENV_KEYS[kind] || []) {
    if (typeof env[key] === 'string' && env[key].trim()) result[key] = env[key]
  }
  return result
}

function allowedShellEnvironment(env = process.env, platform = process.platform, extraEnvKeys = []) {
  const source = { ...env, ...networkEnvironment(env, platform) }
  const result = {}
  const sourceKeys = Object.keys(source)
  const regionKeys = sourceKeys.map(key => platform === 'win32' ? key.toUpperCase() : key)
    .filter(key => VERTEX_MODEL_REGION_KEY.test(key))
  for (const key of [...SHELL_ENV_KEYS, ...regionKeys, ...nativeSecretEnvKeys(extraEnvKeys)]) {
    const sourceKey = Object.hasOwn(source, key) ? key
      : platform === 'win32' ? sourceKeys.find(candidate => candidate.toUpperCase() === key.toUpperCase()) : undefined
    const value = sourceKey === undefined ? undefined : source[sourceKey]
    if (typeof value !== 'string' || value.length > MAX_SHELL_ENV_BYTES) continue
    result[key] = value
  }
  return result
}

function nativeShellCommand(shellName, extraEnvKeys = []) {
  const keys = [...SHELL_ENV_KEYS, ...nativeSecretEnvKeys(extraEnvKeys)].join(' ')
  // Enumerate names only; do not dump unrelated values or depend on Electron RunAsNode.
  const regionNames = shellName === 'zsh'
    ? 'builtin print -rl -- ${(k)parameters[(I)VERTEX_REGION_*]}'
    : [
        'if [ -n "${BASH_VERSION-}" ]; then',
        '  builtin compgen -e VERTEX_REGION_',
        'elif [ -x /bin/bash ]; then',
        "  BASH_ENV= ENV= /bin/bash --noprofile --norc -c 'builtin compgen -e VERTEX_REGION_'",
        'fi',
      ].join('\n')
  return [
    `printf '${SHELL_ENV_MARKER}\\0'`,
    `for __meldwork_key in ${keys} $(${regionNames}); do`,
    '  case "$__meldwork_key" in ""|*[!A-Za-z0-9_]*) continue ;; esac',
    '  case "$__meldwork_key" in VERTEX_REGION_*)',
    '    __meldwork_model=${__meldwork_key#VERTEX_REGION_}',
    '    case "$__meldwork_model" in ""|*[!A-Z0-9_]*) continue ;; esac',
    '    [ ${#__meldwork_model} -le 120 ] || continue ;;',
    '  esac',
    '  eval "__meldwork_value=\\${$__meldwork_key-}"',
    '  eval "__meldwork_set=\\${$__meldwork_key+x}"',
    '  if [ -n "$__meldwork_set" ]; then',
    "    printf '%s=%s\\0' \"$__meldwork_key\" \"$__meldwork_value\"",
    '  fi',
    'done',
  ].join('\n')
}

function parseNativeShellEnvironment(output, extraEnvKeys = []) {
  const text = String(output || '')
  const marker = `${SHELL_ENV_MARKER}\u0000`
  const start = text.indexOf(marker)
  if (start < 0) return {}
  const allowed = new Set([...SHELL_ENV_KEYS, ...nativeSecretEnvKeys(extraEnvKeys)])
  const result = {}
  for (const entry of text.slice(start + marker.length).split('\u0000')) {
    const separator = entry.indexOf('=')
    if (separator <= 0) continue
    const key = entry.slice(0, separator)
    const value = entry.slice(separator + 1)
    if ((!allowed.has(key) && !VERTEX_MODEL_REGION_KEY.test(key))
        || value.length > MAX_SHELL_ENV_BYTES) continue
    result[key] = value
  }
  return result
}

async function queryNativeShellEnvironment(options = {}) {
  const source = options.env || process.env
  const platform = options.platform || process.platform
  const home = options.home || os.homedir()
  const fallback = allowedShellEnvironment(source, platform, options.extraEnvKeys)
  if (platform === 'win32') return { env: fallback, source: 'process' }
  const shell = String(options.shell || source.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh'))
  const shellName = path.basename(shell)
  if (!path.isAbsolute(shell) || !['bash', 'sh', 'zsh'].includes(shellName)) {
    return { env: fallback, source: 'process' }
  }
  const execFileFn = options.execFileFn || execFileAsync
  const childEnv = probeEnvironment('', { ...options, env: source, home, platform })
  childEnv.SHELL = shell
  childEnv.TERM = 'dumb'
  childEnv.NO_COLOR = '1'
  try {
    const result = await execFileFn(
      shell,
      [shellName === 'sh' ? '-lc' : '-lic', nativeShellCommand(shellName, options.extraEnvKeys)],
      {
        timeout: SHELL_ENV_TIMEOUT_MS,
        maxBuffer: MAX_SHELL_ENV_BYTES,
        windowsHide: true,
        env: childEnv,
      },
    )
    const loaded = parseNativeShellEnvironment(result.stdout, options.extraEnvKeys)
    return {
      env: { ...fallback, ...loaded },
      source: Object.keys(loaded).some(key => key !== 'PATH') ? 'native-shell' : 'process',
    }
  } catch {
    return { env: fallback, source: 'process', failed: true }
  }
}

function publicShellEnvironment({ env, source }) {
  return { env, source }
}

const lastGoodShellEnvironment = new Map()

function resolveNativeShellEnvironment(options = {}) {
  const useCache = options.cache !== false && !options.execFileFn
  if (!useCache) return queryNativeShellEnvironment(options).then(publicShellEnvironment)
  const source = options.env || process.env
  const platform = options.platform || process.platform
  const home = options.home || os.homedir()
  const shell = String(options.shell || source.SHELL || '')
  const environmentHash = createHash('sha256')
    .update(JSON.stringify(allowedShellEnvironment(source, platform, options.extraEnvKeys))).digest('hex')
  const key = [platform, home, shell, environmentHash, nativeSecretEnvKeys(options.extraEnvKeys).join(',')].join('\u0000')
  const now = Date.now()
  const cached = shellEnvironmentCache.get(key)
  if (options.refresh !== true && cached?.expiresAt > now) {
    return cached.promise
  }
  // The window is measured from when the capture finishes, so a capture that
  // used up its whole timeout is not already stale when it returns.
  const entry = { key, promise: null, expiresAt: now + SHELL_ENV_CACHE_TTL_MS }
  entry.promise = queryNativeShellEnvironment(options).then((result) => {
    entry.expiresAt = Date.now() + SHELL_ENV_CACHE_TTL_MS
    if (!result.failed) {
      if (result.source === 'native-shell') {
        if (lastGoodShellEnvironment.size >= 16) lastGoodShellEnvironment.delete(lastGoodShellEnvironment.keys().next().value)
        lastGoodShellEnvironment.set(key, result)
      }
      return publicShellEnvironment(result)
    }
    // The login shell did not answer (slow rc file, timeout, startup error).
    // The bare app environment has none of the user's PATH entries or API
    // keys, so an Agent started with it fails with misleading sign-in errors.
    // Keep using what the shell last produced for this account instead.
    if (lastGoodShellEnvironment.has(key)) {
      return publicShellEnvironment(lastGoodShellEnvironment.get(key))
    }
    entry.expiresAt = Date.now() + SHELL_ENV_FAILURE_TTL_MS
    return publicShellEnvironment(result)
  })
  if (shellEnvironmentCache.size >= 16) shellEnvironmentCache.delete(shellEnvironmentCache.keys().next().value)
  shellEnvironmentCache.set(key, entry)
  return entry.promise
}

function nativeCredentialState(kind, options = {}) {
  if (kind === 'workbuddy') return workBuddyCredentialState(options)
  const home = options.home || os.homedir()
  const env = options.env || process.env
  const codexHome = env.CODEX_HOME || path.join(home, '.codex')
  const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
  const expandHome = value => String(value).replace(/^~(?=$|[\\/])/, home)
  const piHome = env.PI_CODING_AGENT_DIR ? expandHome(env.PI_CODING_AGENT_DIR) : path.join(home, '.pi', 'agent')
  const hermesHome = env.HERMES_HOME ? expandHome(env.HERMES_HOME)
    : (options.platform || process.platform) === 'win32'
      ? path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), `hermes${env.HERMES_DATA_DIR_SUFFIX || ''}`)
      : path.join(home, `.hermes${env.HERMES_DATA_DIR_SUFFIX || ''}`)
  if (Object.keys(nativeCredentialKeyEnvironment(kind, env)).length) {
    return {
      state: 'ready',
      source: options.credentialSource === 'native-shell' ? 'native-shell' : 'native-credential',
    }
  }

  const jsonFiles = {
    zcode: [path.join(home, '.zcode', 'cli', 'config.json')],
    codex: [path.join(codexHome, 'auth.json'), path.join(codexHome, 'config.json')],
    hermes: [path.join(hermesHome, 'auth.json'), path.join(hermesHome, 'config.json')],
    openclaw: [path.join(home, '.openclaw', 'openclaw.json')],
    pi: [
      path.join(piHome, 'auth.json'),
      path.join(piHome, 'models.json'),
      ...(env.PI_CODING_AGENT_DIR ? [] : [
        path.join(home, '.pi', 'auth.json'),
        path.join(home, '.pi', 'config.json'),
        path.join(home, '.pi-agent', 'auth.json'),
        path.join(home, '.pi-agent', 'config.json'),
      ]),
    ],
    kimi: [path.join(home, '.kimi-code', 'credentials', 'kimi-code.json')],
    claude: [
      path.join(claudeHome, '.credentials.json'),
      path.join(claudeHome, 'settings.json'),
      path.join(claudeHome, 'settings.local.json'),
    ],
    qwen: [path.join(home, '.qwen', 'oauth_creds.json'), path.join(home, '.qwen', 'settings.json')],
    gemini: [
      path.join(home, '.gemini', 'oauth_creds.json'),
      path.join(home, '.gemini', 'settings.json'),
    ],
    opencode: [path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'opencode', 'auth.json')],
    opencodereview: [path.join(home, '.opencodereview', 'config.json')],
  }[kind] || []
  if (jsonFiles.some(jsonContainsCredential)) {
    return { state: 'ready', source: 'native-credential' }
  }

  const textFiles = {
    codex: [path.join(codexHome, '.env'), path.join(codexHome, 'config.toml')],
    hermes: [
      path.join(hermesHome, '.env'),
      path.join(hermesHome, 'config.yaml'),
    ],
    openclaw: [path.join(home, '.openclaw', '.env')],
    pi: env.PI_CODING_AGENT_DIR ? [] : [
      path.join(home, '.pi', '.env'),
      path.join(home, '.pi', 'config.toml'),
      path.join(home, '.pi-agent', '.env'),
      path.join(home, '.pi-agent', 'config.toml'),
    ],
    kimi: [
      path.join(home, '.kimi', 'config.toml'),
      path.join(home, '.kimi-code', 'config.toml'),
      path.join(home, '.kimi-code', '.env'),
    ],
    mimo: [path.join(home, '.mimo', '.env'), path.join(home, '.mimocode', '.env')],
    claude: [path.join(claudeHome, '.env')],
    qwen: [path.join(home, '.qwen', '.env')],
    gemini: [path.join(home, '.gemini', '.env')],
    opencode: [
      path.join(home, '.opencode', '.env'),
      path.join(home, '.config', 'opencode', '.env'),
    ],
    opencodereview: [path.join(home, '.opencodereview', '.env')],
  }[kind] || []
  if (textFiles.some(textContainsCredential)) {
    return { state: 'ready', source: 'native-credential' }
  }

  return { state: 'unknown', source: 'unverified' }
}

function probeEnvironment(kind, options = {}) {
  const source = options.env || process.env
  const platform = options.platform || process.platform
  const home = options.home || os.homedir()
  const env = networkEnvironment(source, platform)
  for (const key of [
    'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP',
    'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE',
    'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME',
    'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
    'APPDATA', 'LOCALAPPDATA',
  ]) {
    if (typeof source[key] === 'string' && source[key]) env[key] = source[key]
  }
  for (const key of CONFIG_DIRECTORY_ENV_KEYS) {
    if (typeof source[key] === 'string') env[key] = source[key]
  }
  if (platform === 'win32') env.USERPROFILE ||= home
  else env.HOME = home
  env.PATH = searchPath({ platform, env: source, home })
  Object.assign(env, nativeCredentialEnvironment(kind, source, options.nativeCredentialKeys))
  return env
}

function claudeAuthState(output) {
  try {
    const status = JSON.parse(String(output || '').trim())
    // Cloud status recognizes a provider selection without checking SDK credentials.
    if (status?.loggedIn === true && status.authMethod === 'third_party') {
      return { state: 'unknown', source: 'unverified' }
    }
    if (status?.loggedIn === true && status.authMethod === 'api_key') {
      return { state: 'ready', source: 'native-credential' }
    }
    if (status?.loggedIn === true) return { state: 'ready', source: 'native-auth-status' }
    if (status?.loggedIn === false) return { state: 'missing', source: 'native-auth-status' }
  } catch { /* keep the file-based result */ }
  return null
}

function mimoAuthState(output) {
  const lines = String(output || '')
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
    .split(/\r?\n/)
    .map(line => line.replace(/^[^A-Za-z0-9]+/, '').trim())
    .filter(Boolean)
  if (lines.some(line => (
    /^Not logged in(?:\.|$)/i.test(line) && /\bmimo auth login\b/i.test(line)
  ))) {
    return { state: 'missing', source: 'native-auth-status' }
  }
  const providerReady = lines.some(line => /^Provider\s*:\s*MiMo\s*$/i.test(line))
  const identityReady = lines.some(line => (
    /^(?:User ID|Type)\s*:\s*[A-Za-z0-9]/i.test(line)
  ))
  return providerReady && identityReady
    ? { state: 'ready', source: 'native-auth-status' }
    : null
}

function pathInside(parent, child) {
  const relative = path.relative(parent, child)
  return Boolean(relative) && relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function identityValue(value) {
  return typeof value === 'bigint' ? value.toString() : String(value)
}

function sameFilesystemIdentity(stat, expected) {
  return identityValue(stat.dev) === expected.dev && identityValue(stat.ino) === expected.ino
}

function fileVersion(stat) {
  return {
    dev: identityValue(stat.dev),
    ino: identityValue(stat.ino),
    size: identityValue(stat.size),
    mtime: identityValue(stat.mtimeNs ?? stat.mtimeMs),
    ctime: identityValue(stat.ctimeNs ?? stat.ctimeMs),
  }
}

function sameFileVersion(stat, expected) {
  const current = fileVersion(stat)
  return current.dev === expected.dev && current.ino === expected.ino
    && current.size === expected.size && current.mtime === expected.mtime
    && current.ctime === expected.ctime
}

function openClawDirectoryIdentity(filename) {
  const resolved = path.resolve(filename)
  const stat = fs.lstatSync(resolved)
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== resolved) {
    throw new Error('OPENCLAW_NATIVE_RUNTIME_UNSAFE_PATH')
  }
  return { path: resolved, dev: identityValue(stat.dev), ino: identityValue(stat.ino) }
}

function validateOpenClawDirectoryIdentities(identities) {
  for (const expected of identities) {
    const current = openClawDirectoryIdentity(expected.path)
    if (current.dev !== expected.dev || current.ino !== expected.ino) {
      throw new Error('OPENCLAW_NATIVE_RUNTIME_UNSAFE_PATH')
    }
  }
}

function parseOpenClawStatus(output, options = {}) {
  try {
    const status = JSON.parse(String(output || '').trim())
    const auth = status?.auth
    const resolvedModel = String(status?.resolvedDefault || status?.defaultModel || '').trim()
    if (!auth || !OPENCLAW_MODEL_REF.test(resolvedModel)) return null
    if (Array.isArray(auth.missingProvidersInUse) && auth.missingProvidersInUse.length) {
      return { credentialState: { state: 'missing', source: 'native-auth-status' } }
    }
    const requestedAgentDir = String(status?.agentDir || '').trim()
    if (!path.isAbsolute(requestedAgentDir)) {
      return { credentialState: { state: 'unknown', source: 'native-runtime-unavailable' } }
    }
    const resolvedHome = fs.realpathSync(path.resolve(options.home || os.homedir()))
    const nativeRoot = path.join(resolvedHome, '.openclaw')
    const nativeRootIdentity = openClawDirectoryIdentity(nativeRoot)
    const agentDir = fs.realpathSync(requestedAgentDir)
    if (!fs.statSync(agentDir).isDirectory() || !pathInside(nativeRoot, agentDir)) {
      return { credentialState: { state: 'unknown', source: 'native-runtime-unavailable' } }
    }
    const directoryIdentities = [nativeRootIdentity]
    let current = nativeRoot
    for (const segment of path.relative(nativeRoot, agentDir).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment)
      directoryIdentities.push(openClawDirectoryIdentity(current))
    }
    return {
      credentialState: { state: 'ready', source: 'native-auth-status' },
      runtime: {
        model: resolvedModel,
        agentDir: path.normalize(agentDir),
        directoryIdentities,
      },
    }
  } catch {
    return null
  }
}

function resolveOpenClawRuntimeStatus(status, options = {}) {
  if (!status?.runtime || status.credentialState?.state !== 'ready') return null
  const parts = openClawModelParts(status.runtime.model)
  if (!parts) return null
  return parseOpenClawModelsFile(
    readOpenClawModelsFile(status.runtime),
    status.runtime.model,
    options,
  )
}

function openClawModelParts(modelRef) {
  const separator = modelRef.indexOf('/')
  if (separator <= 0 || separator === modelRef.length - 1) return null
  const providerId = modelRef.slice(0, separator)
  const modelId = modelRef.slice(separator + 1)
  if (!OPENCLAW_PROVIDER_ID.test(providerId) || !OPENCLAW_MODEL_REF.test(modelId)) return null
  return { providerId, modelId }
}

function openClawBaseUrl(value) {
  const baseUrl = String(value || '').trim().replace(/\/+$/, '')
  let parsed
  try { parsed = new URL(baseUrl) } catch { return '' }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  if ((parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback))
      || parsed.username || parsed.password || parsed.search || parsed.hash) return ''
  return baseUrl
}

function boundedPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1_000_000_000
    ? value
    : null
}

function sanitizedOpenClawModel(input, modelId) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || String(input.id || '').trim() !== modelId) return null
  const requestedName = String(input.name || '').trim()
  if (requestedName.length > 240) return null
  const model = { id: modelId, name: requestedName || modelId }
  if (Array.isArray(input.input)) {
    const values = [...new Set(input.input.map(value => String(value || '').trim()))]
    if (!values.length || values.some(value => !OPENCLAW_MODEL_INPUTS.has(value))) return null
    model.input = values
  } else {
    model.input = ['text']
  }
  for (const key of ['contextWindow', 'contextTokens', 'maxTokens']) {
    const value = boundedPositiveNumber(input[key])
    if (value !== null) model[key] = value
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

function openClawEnvKey(input) {
  const allowed = new Set(CREDENTIAL_ENV_KEYS.openclaw)
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const key = String(input.id || '').trim()
    return input.source === 'env' && allowed.has(key) ? key : ''
  }
  if (typeof input !== 'string') return ''
  const match = input.trim().match(/^(?:([A-Z][A-Z0-9_]*)|\$([A-Z][A-Z0-9_]*)|\$\{([A-Z][A-Z0-9_]*)\})$/)
  const key = match?.slice(1).find(Boolean) || ''
  return allowed.has(key) ? key : ''
}

function openClawApiKey(input, env = process.env) {
  const envKey = openClawEnvKey(input)
  if (envKey) {
    const value = String(env[envKey] || '').trim()
    return value && value.length <= 8192 ? value : ''
  }
  if (typeof input !== 'string' || isOpenClawSecretReference(input)) return ''
  const value = input.trim()
  return value && value.length <= 8192 ? value : ''
}

function parseOpenClawModelsFile(output, modelRef, options = {}) {
  try {
    const parts = openClawModelParts(modelRef)
    const catalog = JSON.parse(String(output || '').trim())
    const provider = catalog?.providers?.[parts?.providerId]
    if (!parts || !provider || typeof provider !== 'object' || Array.isArray(provider)) return null
    const baseUrl = openClawBaseUrl(provider.baseUrl)
    const api = String(provider.api || '').trim()
    const apiKey = openClawApiKey(provider.apiKey, options.env)
    const model = Array.isArray(provider.models)
      ? provider.models.map(candidate => sanitizedOpenClawModel(candidate, parts.modelId)).find(Boolean)
      : null
    if (!baseUrl || !OPENCLAW_PROVIDER_APIS.has(api) || !apiKey || !model) return null
    return {
      model: modelRef,
      provider: { id: parts.providerId, baseUrl, api, apiKey, model },
    }
  } catch {
    return null
  }
}

function readOpenClawModelsFile(runtime) {
  validateOpenClawDirectoryIdentities(runtime.directoryIdentities)
  const modelsPath = path.join(runtime.agentDir, 'models.json')
  const resolvedModelsPath = path.resolve(modelsPath)
  const entry = fs.lstatSync(modelsPath, { bigint: true })
  if (!entry.isFile() || entry.isSymbolicLink()
      || fs.realpathSync(resolvedModelsPath) !== resolvedModelsPath) return ''
  const noFollow = fs.constants.O_NOFOLLOW || 0
  const descriptor = fs.openSync(resolvedModelsPath, fs.constants.O_RDONLY | noFollow)
  try {
    const before = fs.fstatSync(descriptor, { bigint: true })
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(MAX_CREDENTIAL_FILE_BYTES)
        || !sameFilesystemIdentity(before, {
          dev: identityValue(entry.dev), ino: identityValue(entry.ino),
        })) return ''
    const expectedVersion = fileVersion(before)
    const contents = fs.readFileSync(descriptor, 'utf8')
    const after = fs.fstatSync(descriptor, { bigint: true })
    validateOpenClawDirectoryIdentities(runtime.directoryIdentities)
    const current = fs.lstatSync(resolvedModelsPath, { bigint: true })
    if (!sameFileVersion(after, expectedVersion)
        || !current.isFile() || current.isSymbolicLink()
        || !sameFileVersion(current, expectedVersion)
        || fs.realpathSync(resolvedModelsPath) !== resolvedModelsPath) {
      throw new Error('OPENCLAW_NATIVE_RUNTIME_UNSAFE_PATH')
    }
    return contents
  } finally {
    fs.closeSync(descriptor)
  }
}

async function queryOpenClawStatus(options = {}) {
  if (!options.executable) return null
  const platform = options.platform || process.platform
  const prepareCommandFn = options.prepareCommandFn || prepareCommand
  const execFileFn = options.execFileFn || execFileAsync
  const prepared = prepareCommandFn(
    options.executable,
    ['models', 'status', '--check', '--json'],
    { platform },
  )
  try {
    const result = await execFileFn(prepared.command, prepared.args, {
      timeout: 7000,
      windowsHide: true,
      env: probeEnvironment('openclaw', options),
    })
    return parseOpenClawStatus(result.stdout, options)
  } catch (error) {
    const status = parseOpenClawStatus(error?.stdout, options)
    if (status) return status
    if (error?.killed === true || error?.code === 'ETIMEDOUT') {
      return { credentialState: { state: 'unknown', source: 'native-probe-failed' } }
    }
    return null
  }
}

async function resolveNativeOpenClawRuntime(options = {}) {
  const status = await queryOpenClawStatus(options)
  try {
    const runtime = resolveOpenClawRuntimeStatus(status, options)
    if (runtime) return runtime
  } catch { /* fail closed below */ }
  throw new Error('OPENCLAW_NATIVE_RUNTIME_UNAVAILABLE')
}

async function queryMimoAuthState(options = {}) {
  if (!options.executable) return null
  const platform = options.platform || process.platform
  const prepareCommandFn = options.prepareCommandFn || prepareCommand
  const execFileFn = options.execFileFn || execFileAsync
  const prepared = prepareCommandFn(options.executable, ['providers', 'whoami'], { platform })
  try {
    const result = await execFileFn(prepared.command, prepared.args, {
      timeout: 5000,
      windowsHide: true,
      env: probeEnvironment('mimo', options),
    })
    return mimoAuthState(result.stdout)
  } catch (error) {
    return mimoAuthState(error?.stdout)
  }
}

async function resolveNativeCredentialState(kind, options = {}) {
  if (kind === 'workbuddy') return workBuddyCredentialState(options)
  const current = nativeCredentialState(kind, options)
  if (kind === 'mimo') {
    if (current.state === 'ready' || mimoConfiguredProvider(options)) {
      return { state: 'ready', source: 'native-credential' }
    }
    return await queryMimoAuthState(options) || current
  }
  if (kind === 'openclaw') {
    const status = await queryOpenClawStatus(options)
    if (status?.credentialState?.state === 'missing') return status.credentialState
    try {
      if (resolveOpenClawRuntimeStatus(status, options)) {
        return { state: 'ready', source: 'native-auth-status' }
      }
    } catch { /* fail closed below */ }
    return ['native-runtime-unavailable', 'native-probe-failed'].includes(status?.credentialState?.source)
      ? status.credentialState
      : { state: 'unknown', source: 'native-runtime-unavailable' }
  }
  if (kind !== 'claude' || !options.executable) return current

  const platform = options.platform || process.platform
  const prepareCommandFn = options.prepareCommandFn || prepareCommand
  const execFileFn = options.execFileFn || execFileAsync
  const prepared = prepareCommandFn(options.executable, ['auth', 'status', '--json'], { platform })
  try {
    const result = await execFileFn(prepared.command, prepared.args, {
      timeout: 5000,
      windowsHide: true,
      env: probeEnvironment('claude', options),
    })
    return claudeAuthState(result.stdout) || current
  } catch (error) {
    return claudeAuthState(error?.stdout) || current
  }
}

module.exports = {
  hermesDeclaredCredentialKeys,
  zcodeDeclaredCredentialKeys,
  nativeCredentialEnvironment,
  nativeCredentialState,
  resolveNativeOpenClawRuntime,
  resolveNativeCredentialState,
  resolveNativeShellEnvironment,
}

const { execFile } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { promisify } = require('node:util')
const yaml = require('js-yaml')
const JSON5 = require('json5')
const toml = require('@iarna/toml')
const { nativeSecretEnvKeys } = require('./cli/native-secret-environment.cjs')
const { OCR_PROVIDER_KEYS } = require('./cli/ocr-provider-environment.cjs')
const { deepseekNativeConfig } = require('./cli/deepseek-native-config.cjs')
const { hermesProviderFromConfig, hermesProviderEnvironment } = require('./hermes-config-summary.cjs')
const { qwenCredentialSelection, qwenConfiguredAuth } = require('./cli/qwen-native-config.cjs')
const { geminiNativeAuth } = require('./cli/gemini-native-config.cjs')
const { prepareCommand, searchPath } = require('./cli/cli-discovery.cjs')
const { isOpenClawSecretReference } = require('./cli/openclaw-runtime.cjs')
const { NETWORK_ENV_KEYS, networkEnvironment } = require('./cli/cli-network-environment.cjs')
const { CONFIG_DIRECTORY_ENV_KEYS } = require('./cli/cli-config-directories.cjs')
const { workBuddyCredentialState } = require('./cli/workbuddy-runtime.cjs')
const { mimoConfiguredProvider } = require('./cli/mimo-native-config.cjs')
const { PI_PROVIDER_CREDENTIAL_KEYS } = require('./cli/pi-provider-environment.cjs')
const { CREDENTIAL_ENV_KEYS, RUNTIME_ENV_KEYS, VERTEX_MODEL_REGION_KEY, nativeCredentialEnvironment } = require('./agent-native-environment.cjs')

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

function qwenOAuthCredentialsPresent(filename) {
  try {
    const contents = readCredentialFile(filename)
    if (!contents) return false
    const credentials = JSON.parse(contents)
    return Boolean(credentials && typeof credentials === 'object' && !Array.isArray(credentials)
      && ['access_token', 'refresh_token', 'token_type'].every(key => credentialLiteral(credentials[key]))
      && typeof credentials.expiry_date === 'number' && Number.isFinite(credentials.expiry_date)
      && credentials.expiry_date > 0)
  } catch { return false }
}

function geminiOAuthCredentialsPresent(filename) {
  try {
    const contents = readCredentialFile(filename)
    if (!contents) return false
    const credentials = JSON.parse(contents)
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) return false
    if (credentialLiteral(credentials.refresh_token)) return true
    if (!credentialLiteral(credentials.access_token)) return false
    if (credentials.expiry_date == null || credentials.expiry_date === 0) return true
    return typeof credentials.expiry_date === 'number' && Number.isFinite(credentials.expiry_date)
      && credentials.expiry_date > Date.now() + 5 * 60 * 1000
  } catch { return false }
}

function openCodeReviewSelectedCredential(home, env, credentialSource, presetProviders) {
  let config
  try {
    const file = path.join(home, '.opencodereview', 'config.json')
    const contents = readCredentialFile(file)
    if (!contents) return fs.existsSync(file) ? { state: 'unknown', source: 'unverified' } : null
    config = JSON.parse(contents)
  } catch { return { state: 'unknown', source: 'unverified' } }
  const provider = typeof config?.provider === 'string' ? config.provider.trim() : ''
  if (!provider) return null
  const knownPreset = Array.isArray(presetProviders) ? presetProviders.includes(provider)
    : ['openai', 'openai-responses', 'anthropic'].includes(provider)
  const nativeKey = knownPreset && Object.hasOwn(OCR_PROVIDER_KEYS, provider) ? OCR_PROVIDER_KEYS[provider] : ''
  const selected = knownPreset ? config.providers?.[provider]
    : Array.isArray(presetProviders) ? config.custom_providers?.[provider] : null
  if (!selected || typeof selected !== 'object' || Array.isArray(selected)) {
    return { state: 'unknown', source: 'unverified' }
  }
  const model = typeof selected?.model === 'string' && selected.model.trim()
    ? selected.model.trim() : (typeof config.model === 'string' ? config.model.trim() : '')
  if (!model) return { state: 'unknown', source: 'unverified' }
  const protocol = typeof selected?.protocol === 'string' ? selected.protocol.trim().toLowerCase() : ''
  if (selected?.protocol != null && typeof selected.protocol !== 'string') return { state: 'unknown', source: 'unverified' }
  if (!knownPreset || selected?.protocol) {
    if (!['openai', 'openai-responses', 'anthropic', 'anthropic-bedrock'].includes(protocol)) {
      return { state: 'unknown', source: 'unverified' }
    }
  }
  if (!knownPreset || selected?.url) {
    try {
      const endpoint = new URL(selected.url)
      if (!['http:', 'https:'].includes(endpoint.protocol)) return { state: 'unknown', source: 'unverified' }
    } catch { return { state: 'unknown', source: 'unverified' } }
  }
  const configured = credentialLiteral(selected?.api_key)
  const command = typeof selected?.api_key_cmd === 'string' && selected.api_key_cmd.trim()
  const inherited = !command && nativeKey && credentialLiteral(env[nativeKey])
  return configured || inherited
    ? { state: 'ready', source: inherited && credentialSource === 'native-shell' ? 'native-shell' : 'native-credential' }
    : { state: 'unknown', source: 'unverified' }
}

function openCodeReviewFallbackCredential(home, env, credentialSource) {
  const unknown = { state: 'unknown', source: 'unverified' }
  const validUrl = value => {
    try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false }
  }
  const validProtocol = value => value == null || value === '' || (typeof value === 'string'
    && ['openai', 'openai-responses', 'anthropic'].includes(value.trim().toLowerCase()))
  let config = {}
  try {
    const contents = readCredentialFile(path.join(home, '.opencodereview', 'config.json'))
    if (contents) config = JSON.parse(contents)
  } catch { return unknown }
  const llm = config?.llm || {}
  const hasModel = value => typeof value === 'string' && Boolean(value.trim())
  const command = typeof llm.auth_token_cmd === 'string' && llm.auth_token_cmd.trim()
  if (llm.url && hasModel(llm.model) && (credentialLiteral(llm.auth_token) || command)) {
    if (!validUrl(llm.url) || !validProtocol(llm.protocol) || !credentialLiteral(llm.auth_token)) return unknown
    return { state: 'ready', source: 'native-credential' }
  }
  const sources = [
    { url: env.OCR_LLM_URL, model: env.OCR_LLM_MODEL, token: env.OCR_LLM_TOKEN, protocol: env.OCR_LLM_PROTOCOL },
    { url: env.ANTHROPIC_BASE_URL, model: env.ANTHROPIC_MODEL, token: env.ANTHROPIC_AUTH_TOKEN },
  ]
  for (const source of sources) {
    if (!source.url || !hasModel(source.model) || !credentialLiteral(source.token)) continue
    if (!validUrl(source.url) || !validProtocol(source.protocol)) return unknown
    return { state: 'ready', source: credentialSource === 'native-shell' ? 'native-shell' : 'native-credential' }
  }
  return unknown
}

function openCodeAuthContainsCredential(filename) {
  try {
    const contents = readCredentialFile(filename)
    const auth = contents && JSON.parse(contents)
    return Boolean(auth && typeof auth === 'object' && !Array.isArray(auth)
      && Object.values(auth).some(entry => entry && typeof entry === 'object'
        && !Array.isArray(entry) && entry.type === 'api' && credentialLiteral(entry.key)))
  } catch { return false }
}

function piDefaultProvider(root) {
  try {
    const settings = readCredentialFile(path.join(root, 'settings.json'))
    if (!settings) return ''
    const parsed = JSON5.parse(settings)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return typeof parsed.defaultProvider === 'string' ? parsed.defaultProvider : ''
  } catch { return null }
}

function piAuthContainsCredential(filename, selected) {
  if (selected === null) return false
  try {
    const contents = readCredentialFile(filename)
    const auth = contents && JSON.parse(contents)
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return false
    return containsCredential(selected ? auth[selected] : auth)
  } catch { return false }
}

function piCloudflareCredentialReady(root, env, provider) {
  let credential
  try {
    const contents = readCredentialFile(path.join(root, 'auth.json'))
    const auth = contents && JSON.parse(contents)
    credential = auth?.[provider]
  } catch { return false }
  const value = (name, stored) => stored !== undefined ? stored : env[name]
  const key = value('CLOUDFLARE_API_KEY', credential?.key)
  const account = value('CLOUDFLARE_ACCOUNT_ID', credential?.env?.CLOUDFLARE_ACCOUNT_ID)
  const gateway = value('CLOUDFLARE_GATEWAY_ID', credential?.env?.CLOUDFLARE_GATEWAY_ID)
  const present = item => typeof item === 'string' && Boolean(item.trim())
  return credentialLiteral(key) && present(account)
    && (provider !== 'cloudflare-ai-gateway' || present(gateway))
}

function piModelsContainCredential(root, env, selected) {
  try {
    if (selected === null) return false
    const contents = readCredentialFile(path.join(root, 'models.json'))
    const config = contents && JSON5.parse(contents)
    const providers = config?.providers
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return false
    const candidates = selected ? [providers[selected]] : Object.values(providers)
    return candidates.some(provider => {
      const value = provider?.apiKey
      if (typeof value !== 'string' || value.startsWith('!')) return false
      let missing = false
      const resolved = value.replace(/\$\$|\$!|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
        (match, braced, simple) => {
          if (match === '$$') return '$'
          if (match === '$!') return '!'
          const part = env[braced || simple]
          if (typeof part !== 'string' || !part) { missing = true; return '' }
          return part
        })
      return !missing && credentialLiteral(resolved)
    })
  } catch { return false }
}

function textContainsCredential(filename, allowedKeys = null) {
  try {
    return readCredentialFile(filename).split(/\r?\n/).some((line) => {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_-]*)\s*[:=]\s*(.+?)\s*$/)
      if (!match || (allowedKeys ? !allowedKeys.includes(match[1]) : !CREDENTIAL_FIELD.test(match[1]))) return false
      const raw = match[2].trim()
      const value = (/^['"]/.test(raw) ? raw : raw.replace(/\s+#.*$/, ''))
        .replace(/^['"]|['"]$/g, '').trim()
      return credentialLiteral(value)
    })
  } catch {
    return false
  }
}

function dotenvContainsCredential(filename, key) {
  try {
    for (const line of readCredentialFile(filename).split(/\r?\n/).reverse()) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
      if (!match || match[1] !== key) continue
      const raw = match[2].trim()
      const quoted = raw.match(/^(['"])(.*?)\1\s*(?:#.*)?$/)
      if (/^['"]/.test(raw) && !quoted) return false
      const value = (quoted ? quoted[2] : raw.replace(/\s*#.*$/, '')).trim()
      return credentialLiteral(value)
    }
  } catch { /* Missing or unreadable configuration is unverified. */ }
  return false
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
      .filter(entry => entry && typeof entry === 'object' && !Array.isArray(entry) && entry.provider && entry.model).slice(0, 32)
    const currentProvider = (hermesProviderFromConfig(config, hermesProviderEnvironment(root, env)) || 'auto').toLowerCase()
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

function zcodeConfigFiles(options = {}) {
  const fallbackHome = options.home || os.homedir()
  const platform = options.platform || process.platform
  const configuredHome = platform === 'win32' ? options.env?.USERPROFILE : options.env?.HOME
  const home = typeof configuredHome === 'string' && configuredHome.trim() ? configuredHome.trim() : fallbackHome
  const files = [path.join(home, '.zcode', 'cli', 'config.json')]
  if (typeof options.workdir === 'string' && path.isAbsolute(options.workdir)) {
    const directories = []
    let current = path.resolve(options.workdir)
    let foundGit = false
    for (;;) {
      directories.push(current)
      try { if (fs.statSync(path.join(current, '.git')).isDirectory() || fs.statSync(path.join(current, '.git')).isFile()) { foundGit = true; break } } catch {}
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
    for (const directory of (foundGit ? directories.reverse() : directories.slice(0, 1))) {
      files.push(path.join(directory, 'zcode.json'), path.join(directory, '.zcode', 'config.json'))
    }
  }
  return files
}

function zcodeDeclaredCredentialKeys(options = {}) {
  try {
    const files = zcodeConfigFiles(options)
    let model = {}
    let providers = Object.create(null)
    for (const filename of files) {
      let config
      try {
        const stat = fs.statSync(filename)
        if (!stat.isFile() || stat.size > 1024 * 1024) continue
        config = JSON.parse(fs.readFileSync(filename, 'utf8'))
      } catch { continue }
      if (config?.model && typeof config.model === 'object' && !Array.isArray(config.model)) model = { ...config.model }
      if (config?.provider && typeof config.provider === 'object' && !Array.isArray(config.provider)) {
        providers = Object.create(null)
        for (const [id, entry] of Object.entries(config.provider)) {
          if (entry && typeof entry === 'object' && !Array.isArray(entry)) providers[id] = { ...entry }
        }
      }
    }
    const envModel = typeof options.env?.ZCODE_MODEL === 'string' ? options.env.ZCODE_MODEL.trim() : ''
    const selectedModel = envModel ? { provider: envModel.includes('/') ? envModel.split('/')[0] : 'anthropic', kind: 'anthropic' } : model.main
    const models = [selectedModel, model.lite, ...(Array.isArray(model.available) ? model.available.slice(0, 32) : [])]
    const names = []
    for (const item of models) {
      const provider = typeof item === 'string' ? item.split('/')[0]
        : item && typeof item === 'object' ? item.provider : ''
      if (typeof provider !== 'string' || !provider.trim()) continue
      const id = provider.trim()
      const entry = providers[id] && typeof providers[id] === 'object' ? providers[id] : {}
      const modelEntry = item && typeof item === 'object' ? item : {}
      const kind = modelEntry.kind || entry.kind
      names.push(id, id.replace(/^default[-_]/, ''), modelEntry.providerName || entry.name)
      if (kind === 'openai' || (!kind && id === 'openai')) names.push('openai')
      if (kind === 'anthropic' || (!kind && id === 'anthropic')) names.push('anthropic')
    }
    return nativeSecretEnvKeys(names.filter(value => typeof value === 'string').map(value => {
      const name = value.trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase()
      return name ? `${name}_API_KEY` : ''
    }))
  } catch { return [] }
}

function zcodeSelectedCredentialState(options = {}) {
  const env = options.env || process.env
  const config = { model: {}, provider: Object.create(null) }
  let found = false
  try {
    for (const filename of zcodeConfigFiles(options)) {
      let stat
      try { stat = fs.statSync(filename) } catch (error) {
        if (error?.code === 'ENOENT') continue
        throw error
      }
      if (!stat.isFile() || stat.size > MAX_CREDENTIAL_FILE_BYTES) return { state: 'unknown', source: 'unverified' }
      const layer = JSON.parse(fs.readFileSync(filename, 'utf8'))
      if (!layer || typeof layer !== 'object' || Array.isArray(layer)) return { state: 'unknown', source: 'unverified' }
      found = true
      if (layer.model && typeof layer.model === 'object' && !Array.isArray(layer.model)) {
        config.model = { ...layer.model }
      }
      if (layer.provider && typeof layer.provider === 'object' && !Array.isArray(layer.provider)) {
        config.provider = Object.create(null)
        for (const [id, entry] of Object.entries(layer.provider)) {
          if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
            config.provider[id] = { ...entry }
          }
        }
      }
    }
  } catch (error) {
    return { state: 'unknown', source: 'unverified' }
  }
  const envModel = typeof env.ZCODE_MODEL === 'string' ? env.ZCODE_MODEL.trim() : ''
  if (!found && !envModel) return null
  const model = envModel ? { provider: envModel.includes('/') ? envModel.split('/')[0] : 'anthropic', kind: 'anthropic' }
    : typeof config?.model?.main === 'string' ? { provider: config.model.main.includes('/')
      ? config.model.main.split('/')[0] : 'anthropic' }
      : config?.model?.main
  if (!model || typeof model !== 'object' || typeof model.provider !== 'string' || !model.provider.trim()) {
    return { state: 'unknown', source: 'unverified' }
  }
  const provider = model.provider.trim()
  const entry = config?.provider?.[provider] || {}
  const kind = model.kind || entry.kind || (['openai', 'anthropic'].includes(provider) ? provider : '')
  const names = [provider, provider.replace(/^default[-_]/, ''), model.providerName || entry.name]
  if (kind === 'openai' || kind === 'anthropic') names.push(kind)
  const keys = nativeSecretEnvKeys(['ZCODE_API_KEY', ...names.filter(name => typeof name === 'string').map(name => {
    const normalized = name.trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase()
    return normalized ? `${normalized}_API_KEY` : ''
  })])
  if (keys.some(key => typeof env[key] === 'string' && env[key].trim())) {
    return { state: 'ready', source: options.credentialSource === 'native-shell' ? 'native-shell' : 'native-credential' }
  }
  if (credentialLiteral(model.apiKey) || credentialLiteral(entry.options?.apiKey)) {
    return { state: 'ready', source: 'native-credential' }
  }
  return { state: 'unknown', source: 'unverified' }
}

function piDeclaredCredentialKeys(options = {}) {
  const env = options.env || process.env
  const home = options.home || os.homedir()
  const root = env.PI_CODING_AGENT_DIR
    ? String(env.PI_CODING_AGENT_DIR).replace(/^~(?=$|[\\/])/, home)
    : path.join(home, '.pi', 'agent')
  if (!path.isAbsolute(root)) return []
  try {
    const file = path.join(root, 'models.json')
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > MAX_CREDENTIAL_FILE_BYTES) return []
    const config = JSON5.parse(fs.readFileSync(file, 'utf8'))
    const providers = config?.providers
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return []
    const values = []
    const headers = value => {
      if (value && typeof value === 'object' && !Array.isArray(value)) values.push(...Object.values(value))
    }
    for (const provider of Object.values(providers).slice(0, 256)) {
      if (!provider || typeof provider !== 'object' || Array.isArray(provider)) continue
      values.push(provider.apiKey)
      headers(provider.headers)
      for (const model of Array.isArray(provider.models) ? provider.models.slice(0, 256) : []) headers(model?.headers)
      if (provider.modelOverrides && typeof provider.modelOverrides === 'object' && !Array.isArray(provider.modelOverrides)) {
        for (const model of Object.values(provider.modelOverrides).slice(0, 256)) headers(model?.headers)
      }
    }
    const keys = []
    for (const value of values) {
      if (typeof value !== 'string' || value.startsWith('!')) continue
      for (const match of value.matchAll(/\$\$|\$!|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
        if (match[1] || match[2]) keys.push(match[1] || match[2])
      }
    }
    return nativeSecretEnvKeys(keys)
  } catch { return [] }
}

function codexProviderCredentialKey(options = {}) {
  const home = options.home || os.homedir()
  const root = options.env?.CODEX_HOME || path.join(home, '.codex')
  try {
    const filename = path.join(root, 'config.toml')
    if (fs.statSync(filename).size > 1024 * 1024) return null
    const config = toml.parse(fs.readFileSync(filename, 'utf8'))
    const profile = typeof config.profile === 'string' ? config.profiles?.[config.profile] : null
    const provider = profile?.model_provider || config.model_provider
    const key = config.model_providers?.[provider]?.env_key
    return typeof key === 'string' && key ? key : null
  } catch { return null }
}

function codexDeclaredCredentialKeys(options = {}) {
  return nativeSecretEnvKeys([codexProviderCredentialKey(options)])
}

function hermesSelectedProvider(root, env, home) {
  try {
    const content = readCredentialFile(path.join(root, 'config.yaml'))
    const config = content ? yaml.load(content) : {}
    if (!config || typeof config !== 'object' || Array.isArray(config)) return null
    const fallbacks = [config.fallback_providers, config.fallback_model]
      .flatMap(value => Array.isArray(value) ? value : [value])
      .filter(value => value && typeof value === 'object' && !Array.isArray(value) && value.provider && value.model)
    if (fallbacks.length) {
      const providers = [hermesProviderFromConfig(config, hermesProviderEnvironment(root, env)),
        ...fallbacks.map(value => value?.provider)]
        .filter(value => typeof value === 'string')
        .map(value => value.trim().toLowerCase())
        .filter(value => ['openai', 'openrouter', 'anthropic'].includes(value))
      return { provider: '', authProviders: [...new Set(providers)], fallbackEntries: fallbacks, config,
        keys: hermesDeclaredCredentialKeys({ home, env: { ...env, HERMES_HOME: root } }) }
    }
    const model = config.model && typeof config.model === 'object' && !Array.isArray(config.model) ? config.model : {}
    const provider = hermesProviderFromConfig(config, hermesProviderEnvironment(root, env)).toLowerCase()
    const canonical = { openai: 'OPENAI_API_KEY', openrouter: 'OPENROUTER_API_KEY', anthropic: 'ANTHROPIC_API_KEY' }
    if (provider.startsWith('custom:')) {
      const providers = config.providers && typeof config.providers === 'object' && !Array.isArray(config.providers)
        ? config.providers : {}
      const suffix = provider.slice(7)
      const matches = value => typeof value === 'string'
        && value.trim().toLowerCase().replace(/ /g, '-').replace(/^custom:/, '') === suffix
      const usable = entry => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
        const enabled = entry.enabled === undefined || (Boolean(entry.enabled)
          && !(typeof entry.enabled === 'string' && ['false', '0', 'no', 'off'].includes(entry.enabled.trim().toLowerCase())))
        const endpoint = entry.api || entry.url || entry.base_url
        return enabled && typeof endpoint === 'string' && Boolean(endpoint.trim())
      }
      const providerKey = Object.keys(providers).find(key => usable(providers[key])
        && (matches(key) || matches(providers[key].name)))
      const legacy = Array.isArray(config.custom_providers) ? config.custom_providers.find(entry => (
        usable(entry) && [entry.name, entry.provider_key].some(matches)
      )) : null
      const selected = (providerKey && providers[providerKey]) || legacy
      if (selected && typeof selected === 'object' && !Array.isArray(selected)) {
        return { provider: providerKey || suffix, selected, config, keys: nativeSecretEnvKeys([
          selected.key_env, selected.api_key_env,
        ]) }
      }
      return { unavailable: true }
    }
    // Bare names may resolve to a built-in, a plugin, or a named endpoint.
    // Without asking Hermes to resolve them, another provider's key is not proof.
    if (provider && provider !== 'auto' && provider !== 'custom' && !Object.hasOwn(canonical, provider)) {
      return { unavailable: true }
    }
    if (!Object.hasOwn(canonical, provider)) return null
    return { provider, config, keys: nativeSecretEnvKeys([canonical[provider], model.key_env, model.api_key_env,
      config.providers?.[provider]?.key_env, config.providers?.[provider]?.api_key_env]) }
  } catch { return null }
}

function hermesAuthContainsCredential(filename, provider) {
  try {
    const contents = readCredentialFile(filename)
    const auth = contents && JSON.parse(contents)
    return Boolean(auth && (containsCredential(auth.providers?.[provider])
      || containsCredential(auth.credential_pool?.[provider])))
  } catch { return false }
}

function hermesConfigContainsCredential(selection) {
  const { config, provider, selected } = selection
  return containsCredential(config.model) || containsCredential(selected || config.providers?.[provider])
    || (selection.fallbackEntries || []).some(entry => credentialLiteral(entry.api_key))
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
    ? 'for __meldwork_region in ${(k)parameters[(I)VERTEX_REGION_*]}; do [[ ${(tP)__meldwork_region} == *export* ]] && builtin print -r -- "$__meldwork_region"; done'
    : [
        'if [ -n "${BASH_VERSION-}" ]; then',
        '  builtin compgen -e VERTEX_REGION_',
        'elif [ -x /bin/bash ]; then',
        "  BASH_ENV= ENV= /bin/bash --noprofile --norc -c 'builtin compgen -e VERTEX_REGION_'",
        'fi',
      ].join('\n')
  const exportedCheck = shellName === 'zsh'
    ? '[[ ${(tP)__meldwork_key} == *export* ]]'
    : shellName === 'bash'
      ? '__meldwork_decl=$(declare -p "$__meldwork_key" 2>/dev/null); __meldwork_flags=${__meldwork_decl#declare -}; __meldwork_flags=${__meldwork_flags%% *}; case "$__meldwork_flags" in *x*) true ;; *) false ;; esac'
      : '/usr/bin/printenv "$__meldwork_key" >/dev/null 2>&1'
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
    `  if ${exportedCheck}; then`,
    "    printf '%s=%s\\0' \"$__meldwork_key\" \"$__meldwork_value\"",
    '  else',
    "    printf '!%s\\0' \"$__meldwork_key\"",
    '  fi',
    'done',
  ].join('\n')
}

function parseNativeShellEnvironment(output, extraEnvKeys = []) {
  const text = String(output || '')
  const marker = `${SHELL_ENV_MARKER}\u0000`
  const start = text.indexOf(marker)
  if (start < 0) return { env: {}, unsetKeys: [] }
  const allowed = new Set([...SHELL_ENV_KEYS, ...nativeSecretEnvKeys(extraEnvKeys)])
  const result = {}
  const unsetKeys = []
  for (const entry of text.slice(start + marker.length).split('\u0000')) {
    if (entry.startsWith('!')) {
      const key = entry.slice(1)
      if (allowed.has(key) || VERTEX_MODEL_REGION_KEY.test(key)) unsetKeys.push(key)
      continue
    }
    const separator = entry.indexOf('=')
    if (separator <= 0) continue
    const key = entry.slice(0, separator)
    const value = entry.slice(separator + 1)
    if ((!allowed.has(key) && !VERTEX_MODEL_REGION_KEY.test(key))
        || value.length > MAX_SHELL_ENV_BYTES) continue
    result[key] = value
  }
  return { env: result, unsetKeys }
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
  Object.assign(childEnv, fallback)
  childEnv.SHELL = shell
  childEnv.TERM = 'dumb'
  childEnv.NO_COLOR = '1'
  const capturedKeys = [...(options.extraEnvKeys || []), ...Object.keys(fallback).filter(key => VERTEX_MODEL_REGION_KEY.test(key))]
  try {
    const result = await execFileFn(
      shell,
      [shellName === 'sh' ? '-lc' : '-lic', nativeShellCommand(shellName, capturedKeys)],
      {
        timeout: SHELL_ENV_TIMEOUT_MS,
        maxBuffer: MAX_SHELL_ENV_BYTES,
        windowsHide: true,
        env: childEnv,
      },
    )
    const loaded = parseNativeShellEnvironment(result.stdout, capturedKeys)
    const merged = { ...fallback, ...loaded.env }
    const declaredKeys = new Set(nativeSecretEnvKeys(options.extraEnvKeys))
    const unsetKeys = loaded.unsetKeys.filter(key => Object.hasOwn(fallback, key) || declaredKeys.has(key))
    for (const key of unsetKeys) delete merged[key]
    return {
      env: merged,
      ...(unsetKeys.length ? { unsetKeys } : {}),
      source: Object.keys(loaded.env).some(key => key !== 'PATH') || unsetKeys.length ? 'native-shell' : 'process',
    }
  } catch {
    return { env: fallback, source: 'process', failed: true }
  }
}

function publicShellEnvironment({ env, source, unsetKeys }) {
  return { env, source, ...(unsetKeys?.length ? { unsetKeys } : {}) }
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
  if (kind === 'deepseek' && deepseekNativeConfig(options).explicitModel) {
    return { state: 'unknown', source: 'unverified' }
  }
  if (kind === 'zcode') {
    const selected = zcodeSelectedCredentialState(options)
    if (selected) return selected
  }
  const home = options.home || os.homedir()
  const env = options.env || process.env
  const configuredUserHome = (options.platform || process.platform) === 'win32' ? env.USERPROFILE : env.HOME
  const effectiveUserHome = typeof configuredUserHome === 'string' && configuredUserHome.trim() ? configuredUserHome.trim() : home
  if (kind === 'opencodereview') {
    const selected = openCodeReviewSelectedCredential(effectiveUserHome, env, options.credentialSource, options.ocrPresetProviders)
    if (selected) return selected
    return openCodeReviewFallbackCredential(effectiveUserHome, env, options.credentialSource)
  }
  const codexHome = env.CODEX_HOME || path.join(home, '.codex')
  const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
  const geminiHome = env.GEMINI_CLI_HOME
    ? (path.isAbsolute(env.GEMINI_CLI_HOME) ? path.join(env.GEMINI_CLI_HOME, '.gemini') : null)
    : path.join(home, '.gemini')
  if (kind === 'gemini') {
    const selection = geminiNativeAuth({ home, env, workdir: options.workdir, platform: options.platform })
    if (selection.uncertain) return { state: 'unknown', source: 'unverified' }
    if (selection.authType === 'oauth-personal') {
      return geminiOAuthCredentialsPresent(path.join(selection.root, 'oauth_creds.json'))
        ? { state: 'ready', source: 'native-credential' }
        : { state: 'unknown', source: 'unverified' }
    }
    if (selection.authType === 'gemini-api-key') {
      const found = typeof env.GEMINI_API_KEY === 'string' && env.GEMINI_API_KEY.trim()
      return found ? { state: 'ready', source: options.credentialSource === 'native-shell' ? 'native-shell' : 'native-credential' }
        : { state: 'unknown', source: 'unverified' }
    }
    return { state: 'unknown', source: 'unverified' }
  }
  const expandHome = value => String(value).replace(/^~(?=$|[\\/])/, home)
  const piHome = env.PI_CODING_AGENT_DIR ? expandHome(env.PI_CODING_AGENT_DIR) : path.join(home, '.pi', 'agent')
  const kimiHome = env.KIMI_CODE_HOME
    ? (path.isAbsolute(env.KIMI_CODE_HOME) ? env.KIMI_CODE_HOME : null)
    : path.join(home, '.kimi-code')
  const hermesHome = env.HERMES_HOME ? expandHome(env.HERMES_HOME)
    : (options.platform || process.platform) === 'win32'
      ? path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), `hermes${env.HERMES_DATA_DIR_SUFFIX || ''}`)
      : path.join(home, `.hermes${env.HERMES_DATA_DIR_SUFFIX || ''}`)
  const openCodeAuth = path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'opencode', 'auth.json')
  if (kind === 'codex') {
    const key = codexProviderCredentialKey({ home, env })
    if (key) {
      const safe = nativeSecretEnvKeys([key]).includes(key)
      return safe && typeof env[key] === 'string' && env[key].trim()
        ? { state: 'ready', source: options.credentialSource === 'native-shell' ? 'native-shell' : 'native-credential' }
        : { state: 'unknown', source: 'unverified' }
    }
  }
  if (kind === 'qwen' && qwenCredentialSelection({ home, env, workdir: options.workdir, platform: options.platform }).unsupported) {
    return { state: 'unknown', source: 'unverified' }
  }
  if (kind === 'qwen' && qwenConfiguredAuth({ home, env, workdir: options.workdir, platform: options.platform }) === 'qwen-oauth') {
    return qwenOAuthCredentialsPresent(path.join(effectiveUserHome, '.qwen', 'oauth_creds.json'))
      ? { state: 'ready', source: 'native-credential' }
      : { state: 'unknown', source: 'unverified' }
  }
  if (kind === 'qwen' && options.nativeCredentialKeys?.length) {
    const [key] = nativeSecretEnvKeys(options.nativeCredentialKeys)
    const inherited = key && Object.hasOwn(env, key)
    const envFile = !inherited && key
      ? [path.join(effectiveUserHome, '.qwen', '.env'), path.join(effectiveUserHome, '.env')].find(file => fs.existsSync(file)) : ''
    const configured = inherited ? typeof env[key] === 'string' && env[key].trim()
      : envFile && dotenvContainsCredential(envFile, key)
    return configured
      ? { state: 'ready', source: inherited && options.credentialSource === 'native-shell' ? 'native-shell' : 'native-credential' }
      : { state: 'unknown', source: 'unverified' }
  }
  const piProvider = kind === 'pi' ? piDefaultProvider(piHome) : ''
  const hermesSelection = kind === 'hermes' ? hermesSelectedProvider(hermesHome, env, home) : null
  if (hermesSelection?.unavailable) return { state: 'unknown', source: 'unverified' }
  const hermesKeys = hermesSelection?.keys || null
  let credentialEnv = nativeCredentialKeyEnvironment(kind, env)
  if (hermesKeys) {
    credentialEnv = Object.fromEntries(hermesKeys.filter(key => typeof env[key] === 'string' && env[key].trim())
      .map(key => [key, env[key]]))
  }
  const selectedPiKey = Object.hasOwn(PI_PROVIDER_CREDENTIAL_KEYS, piProvider) ? PI_PROVIDER_CREDENTIAL_KEYS[piProvider] : ''
  const hasCredentialEnv = kind !== 'pi' || piProvider === ''
    ? Object.keys(credentialEnv).length > 0
    : Boolean(selectedPiKey && credentialEnv[selectedPiKey]
      || piProvider === 'anthropic' && (credentialEnv.ANTHROPIC_AUTH_TOKEN || credentialEnv.ANTHROPIC_OAUTH_TOKEN))
  const piCloudflare = ['cloudflare-workers-ai', 'cloudflare-ai-gateway'].includes(piProvider)
  if (piCloudflare ? piCloudflareCredentialReady(piHome, env, piProvider) : hasCredentialEnv) {
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
      ...(env.PI_CODING_AGENT_DIR ? [] : [
        path.join(home, '.pi', 'auth.json'),
        path.join(home, '.pi', 'config.json'),
        path.join(home, '.pi-agent', 'auth.json'),
        path.join(home, '.pi-agent', 'config.json'),
      ]),
    ],
    kimi: kimiHome ? [path.join(kimiHome, 'credentials', 'kimi-code.json')] : [],
    claude: [
      path.join(claudeHome, '.credentials.json'),
      path.join(claudeHome, 'settings.json'),
      path.join(claudeHome, 'settings.local.json'),
    ],
    qwen: [path.join(effectiveUserHome, '.qwen', 'oauth_creds.json'), path.join(effectiveUserHome, '.qwen', 'settings.json')],
    gemini: geminiHome ? [path.join(geminiHome, 'oauth_creds.json'), path.join(geminiHome, 'settings.json')] : [],
    opencode: [openCodeAuth],
    opencodereview: [path.join(effectiveUserHome, '.opencodereview', 'config.json')],
  }[kind] || []
  if (jsonFiles.some(filename => kind === 'pi' ? !piCloudflare && piAuthContainsCredential(filename, piProvider)
    : hermesSelection ? path.basename(filename) === 'auth.json'
      && (hermesSelection.authProviders || [hermesSelection.provider]).some(provider => hermesAuthContainsCredential(filename, provider))
      : jsonContainsCredential(filename))
      || (kind === 'pi' && piModelsContainCredential(piHome, env, piProvider))
      || (kind === 'opencode' && openCodeAuthContainsCredential(openCodeAuth))) {
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
      ...(env.KIMI_CODE_HOME ? [] : [path.join(home, '.kimi', 'config.toml')]),
      ...(kimiHome ? [path.join(kimiHome, 'config.toml'), path.join(kimiHome, '.env')] : []),
    ],
    mimo: [path.join(home, '.mimo', '.env'), path.join(home, '.mimocode', '.env')],
    claude: [path.join(claudeHome, '.env')],
    qwen: [path.join(effectiveUserHome, '.qwen', '.env')],
    gemini: geminiHome ? [path.join(geminiHome, '.env')] : [],
    opencode: [
      path.join(home, '.opencode', '.env'),
      path.join(home, '.config', 'opencode', '.env'),
    ],
    opencodereview: [path.join(effectiveUserHome, '.opencodereview', '.env')],
  }[kind] || []
  if (textFiles.some(filename => hermesSelection && filename === path.join(hermesHome, 'config.yaml')
    ? hermesConfigContainsCredential(hermesSelection)
    : textContainsCredential(filename,
      kind === 'hermes' && filename === path.join(hermesHome, '.env') ? hermesKeys : null))) {
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
  Object.assign(env, nativeCredentialEnvironment(kind, source, options.nativeCredentialKeys, platform))
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
    if (status?.ok === false && status?.error?.type === 'cli_error'
        && typeof status.error.message === 'string'
        && /\.apiKey is unresolved in the active runtime snapshot\./.test(status.error.message)) {
      return { credentialState: { state: 'unknown', source: 'native-secret-unresolved' } }
    }
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
  if (kind === 'opencodereview' && current.state !== 'ready' && options.executable) {
    const platform = options.platform || process.platform
    const env = options.env || process.env
    const configuredHome = platform === 'win32' ? env.USERPROFILE : env.HOME
    const home = typeof configuredHome === 'string' && configuredHome.trim()
      ? configuredHome.trim() : (options.home || os.homedir())
    if (!openCodeReviewSelectedCredential(home, env, options.credentialSource)) return current
    const prepareCommandFn = options.prepareCommandFn || prepareCommand
    const execFileFn = options.execFileFn || execFileAsync
    try {
      const prepared = prepareCommandFn(options.executable, ['llm', 'providers'], { platform })
      const result = await execFileFn(prepared.command, prepared.args, {
        timeout: 5000, maxBuffer: 256 * 1024, windowsHide: true, env: probeEnvironment(kind, options),
      })
      const output = String(result.stdout || '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      if (!/^\s*Built-in providers:\s*$/m.test(output) || !/^\s*NAME\s+PROTOCOL\s+BASE URL\s*$/m.test(output)) return current
      const names = output.split(/\r?\n/).flatMap(line => {
        const match = line.match(/^\s*([a-z][a-z0-9-]*)\s+\S+/)
        return match ? [match[1]] : []
      })
      if (!names.includes('openai') || !names.includes('anthropic')) return current
      return nativeCredentialState(kind, { ...options, ocrPresetProviders: names })
    } catch { return current }
  }
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
    return ['native-runtime-unavailable', 'native-probe-failed', 'native-secret-unresolved'].includes(status?.credentialState?.source)
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
  codexDeclaredCredentialKeys,
  hermesDeclaredCredentialKeys,
  zcodeDeclaredCredentialKeys,
  piDeclaredCredentialKeys,
  nativeCredentialEnvironment,
  nativeCredentialState,
  resolveNativeOpenClawRuntime,
  resolveNativeCredentialState,
  resolveNativeShellEnvironment,
}

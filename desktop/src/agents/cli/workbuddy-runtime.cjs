const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { launchEnvironment } = require('./cli-discovery.cjs')

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/

function workBuddyModels(options = {}) {
  const env = options.env || process.env
  const root = env.CODEBUDDY_CONFIG_DIR || path.join(options.home || os.homedir(), '.workbuddy')
  try {
    const filename = path.join(root, 'models.json')
    const stat = fs.statSync(filename)
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return []
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'))
    const models = Array.isArray(value) ? value : value.models
    return (Array.isArray(models) ? models : []).filter(model => (
      typeof model?.id === 'string' && MODEL_ID.test(model.id)
      && typeof model.apiKey === 'string' && model.apiKey.trim()
      && model.supportsToolCall === true && validUrl(model.url)
    )).slice(0, 64)
  } catch { return [] }
}

function validUrl(value) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
  } catch { return false }
}

function workBuddySettings(options = {}) {
  return {
    modelId: options.modelId || '',
    models: workBuddyModels(options).map(model => ({
      id: model.id, name: String(model.name || model.id).slice(0, 120),
    })),
  }
}

function workBuddyEnvironment(options = {}) {
  if (!options.modelId) return {}
  const model = workBuddyModels(options).find(model => model.id === options.modelId)
  if (!model) throw new Error('LOCAL_WORKBUDDY_MODEL_UNAVAILABLE')
  // Use the CLI's supported provider settings, without copying desktop account
  // tokens or attempting to unlock its host-managed encrypted credential store.
  return {
    CODEBUDDY_CONFIG_DIR: (options.env || process.env).CODEBUDDY_CONFIG_DIR
      || path.join(options.home || os.homedir(), '.workbuddy'),
    CODEBUDDY_MODEL: `custom-local:${model.id}`,
    CODEBUDDY_API_KEY: model.apiKey,
    CODEBUDDY_BASE_URL: model.url,
  }
}

function workBuddyCredentialState(options = {}) {
  if (options.modelId) {
    try {
      workBuddyEnvironment(options)
      return { state: 'ready', source: 'native-credential' }
    } catch { return { state: 'unknown', source: 'workbuddy-model-unavailable' } }
  }
  const env = options.env || process.env
  if (env.CODEBUDDY_API_KEY?.trim() || env.CODEBUDDY_AUTH_TOKEN?.trim()) {
    return { state: 'ready', source: 'native-credential' }
  }
  // A models.json entry is not a selected provider. The desktop app's shared
  // encrypted login also cannot be decoded by its standalone lite CLI.
  if (launchEnvironment('workbuddy', options.executable, options).CODEBUDDY_FORCE_LITE_WB_BUNDLE !== '1') {
    return { state: 'unknown', source: 'unverified' }
  }
  const home = options.home || os.homedir()
  const platform = options.platform || process.platform
  const root = platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : platform === 'win32' ? path.join(home, 'AppData', 'Local')
      : path.join(home, '.local', 'share')
  try {
    const filename = path.join(root, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info')
    if (fs.statSync(filename).size <= 2 * 1024 * 1024) {
      const auth = JSON.parse(fs.readFileSync(filename, 'utf8')).auth
      if (auth?.accessToken && typeof auth.accessToken === 'object') {
        return { state: 'unknown', source: 'workbuddy-desktop-locked' }
      }
    }
  } catch { /* native CLI may still have an independent login */ }
  return { state: 'unknown', source: 'unverified' }
}

module.exports = { workBuddyCredentialState, workBuddyEnvironment, workBuddySettings }

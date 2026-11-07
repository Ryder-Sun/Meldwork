const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// Native OCR v1.13 provider EnvVar fields; this selects existing shell values,
// it does not set a provider, endpoint, or credential.
const OCR_PROVIDER_KEYS = Object.freeze({
  anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', 'openai-responses': 'OPENAI_RESPONSES_API_KEY',
  openrouter: 'OPENROUTER_API_KEY', edenai: 'EDENAI_API_KEY', gemini: 'GEMINI_API_KEY',
  dashscope: 'DASHSCOPE_API_KEY', 'dashscope-tokenplan': 'DASHSCOPE_TOKENPLAN_KEY',
  volcengine: 'ARK_API_KEY', deepseek: 'DEEPSEEK_API_KEY', 'tencent-tokenhub': 'TENCENT_TOKENHUB_API_KEY',
  'hy-tokenplan': 'TENCENT_HUNYUAN_TOKENPLAN_KEY', iflytek: 'SPARK_API_KEY', kimi: 'MOONSHOT_API_KEY',
  'kimi-global': 'MOONSHOT_GLOBAL_API_KEY', 'z-ai': 'Z_AI_API_KEY', 'z-ai-coding': 'Z_AI_CODING_API_KEY',
  mimo: 'MIMO_API_KEY', minimax: 'MINIMAX_GLOBAL_API_KEY', 'minimax-cn': 'MINIMAX_API_KEY',
  'baidu-qianfan': 'QIANFAN_API_KEY', 'ollama-cloud': 'OLLAMA_API_KEY', novita: 'NOVITA_API_KEY',
  xai: 'XAI_API_KEY', litellm: 'LITELLM_API_KEY', siliconflow: 'SILICONFLOW_GLOBAL_API_KEY',
  'siliconflow-cn': 'SILICONFLOW_API_KEY', mistral: 'MISTRAL_API_KEY',
})

function ocrConfig(options = {}) {
  const env = options.env || process.env
  const platform = options.platform || process.platform
  const configured = platform === 'win32' ? env.USERPROFILE : env.HOME
  const home = typeof configured === 'string' && configured.trim() ? configured.trim() : (options.home || os.homedir())
  try {
    const file = path.join(home, '.opencodereview', 'config.json')
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > 1024 * 1024) return null
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch { return null }
}

function ocrSelectedProvider(options = {}) {
  const provider = ocrConfig(options)?.provider
  return typeof provider === 'string' ? provider.trim() : ''
}

function ocrDeclaredCredentialKeys(options = {}) {
  const config = ocrConfig(options)
  const provider = typeof config?.provider === 'string' ? config.provider.trim() : ''
  const key = Object.hasOwn(OCR_PROVIDER_KEYS, provider) ? OCR_PROVIDER_KEYS[provider] : ''
  const entry = config?.providers?.[provider]
  if (!key || !entry || typeof entry !== 'object' || Array.isArray(entry)) return []
  if (typeof entry.api_key === 'string' && entry.api_key.trim()) return []
  if (typeof entry.api_key_cmd === 'string' && entry.api_key_cmd.trim()) return []
  return [key]
}

module.exports = { OCR_PROVIDER_KEYS, ocrDeclaredCredentialKeys, ocrSelectedProvider }

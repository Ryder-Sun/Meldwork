// Environment names used by Pi's built-in providers. Custom providers are
// discovered separately from the user's native models.json.
const PI_PROVIDER_CREDENTIAL_KEYS = Object.freeze({
  'ant-ling': 'ANT_LING_API_KEY', 'qwen-token-plan': 'QWEN_TOKEN_PLAN_API_KEY',
  'qwen-token-plan-cn': 'QWEN_TOKEN_PLAN_CN_API_KEY',
  'qwen-token-plan-individual': 'QWEN_TOKEN_PLAN_API_KEY',
  openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', 'github-copilot': 'COPILOT_GITHUB_TOKEN',
  'azure-openai-responses': 'AZURE_OPENAI_API_KEY', nvidia: 'NVIDIA_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY', google: 'GEMINI_API_KEY',
  'google-vertex': 'GOOGLE_CLOUD_API_KEY', groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY', xai: 'XAI_API_KEY', radius: 'RADIUS_API_KEY',
  openrouter: 'OPENROUTER_API_KEY', 'vercel-ai-gateway': 'AI_GATEWAY_API_KEY',
  zai: 'ZAI_API_KEY', 'zai-coding-cn': 'ZAI_CODING_CN_API_KEY',
  mistral: 'MISTRAL_API_KEY', minimax: 'MINIMAX_API_KEY', 'minimax-cn': 'MINIMAX_CN_API_KEY',
  moonshotai: 'MOONSHOT_API_KEY', 'moonshotai-cn': 'MOONSHOT_API_KEY',
  huggingface: 'HF_TOKEN', fireworks: 'FIREWORKS_API_KEY', together: 'TOGETHER_API_KEY',
  baseten: 'BASETEN_API_KEY', opencode: 'OPENCODE_API_KEY', 'opencode-go': 'OPENCODE_API_KEY',
  'kimi-coding': 'KIMI_API_KEY', meta: 'META_API_KEY',
  'cloudflare-workers-ai': 'CLOUDFLARE_API_KEY', 'cloudflare-ai-gateway': 'CLOUDFLARE_API_KEY',
  xiaomi: 'XIAOMI_API_KEY', 'xiaomi-token-plan-cn': 'XIAOMI_TOKEN_PLAN_CN_API_KEY',
  'xiaomi-token-plan-ams': 'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
  'xiaomi-token-plan-sgp': 'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
})
const PI_BUILTIN_CREDENTIAL_KEYS = Object.freeze([...new Set([
  ...Object.values(PI_PROVIDER_CREDENTIAL_KEYS), 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN',
])])
const PI_BUILTIN_CONFIG_KEYS = Object.freeze(['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_GATEWAY_ID'])

module.exports = { PI_PROVIDER_CREDENTIAL_KEYS, PI_BUILTIN_CREDENTIAL_KEYS, PI_BUILTIN_CONFIG_KEYS }

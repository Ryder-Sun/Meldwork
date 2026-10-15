const AGENT_LABELS = {
  codex: 'Codex',
  hermes: 'Hermes',
  openclaw: 'OpenClaw',
  workbuddy: 'WorkBuddy',
  pi: 'Pi Agent',
  kimi: 'Kimi',
  mimo: 'MiMo',
  claude: 'Claude',
  qwen: 'Qwen',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  opencodereview: 'OpenCodeReview',
}
const CUSTOM_AGENT_KIND = /^custom-[a-f0-9]{16}$/
const CLOUD_AGENT_KIND = /^cloud-[a-f0-9]{24}$/
const MAX_MESSAGE_TEXT_CHARS = 20000
const MAX_SYSTEM_PARAM_TEXT_CHARS = 1000
const STABLE_USER_TURNS_PER_EDGE = 3
const STABLE_USER_TURN_TEXT_LIMIT = 700
const RECENT_TRANSCRIPT_MESSAGE_LIMIT = 20
const STABLE_CONTEXT_TEXT_LIMIT = 3000
const RECENT_TRANSCRIPT_TEXT_LIMIT = 9000
const SESSION_KEY = /^[A-Za-z0-9._:-]{1,240}$/

function isSupportedAgentKind(kind) {
  const normalized = String(kind || '')
  return Object.hasOwn(AGENT_LABELS, normalized)
    || CUSTOM_AGENT_KIND.test(normalized)
    || CLOUD_AGENT_KIND.test(normalized)
}

function defaultAgentLabel(kind) {
  return AGENT_LABELS[kind] || String(kind || 'Agent')
}

function cleanText(value, limit = MAX_MESSAGE_TEXT_CHARS) {
  return String(value || '').trim().slice(0, limit)
}

function cleanInline(value, limit = 80) {
  return cleanText(value, limit).replace(/[\n\r\[\]`]/g, ' ').replace(/\s+/g, ' ')
}

module.exports = {
  AGENT_LABELS,
  CLOUD_AGENT_KIND,
  CUSTOM_AGENT_KIND,
  MAX_MESSAGE_TEXT_CHARS,
  MAX_SYSTEM_PARAM_TEXT_CHARS,
  RECENT_TRANSCRIPT_MESSAGE_LIMIT,
  RECENT_TRANSCRIPT_TEXT_LIMIT,
  SESSION_KEY,
  STABLE_CONTEXT_TEXT_LIMIT,
  STABLE_USER_TURN_TEXT_LIMIT,
  STABLE_USER_TURNS_PER_EDGE,
  cleanInline,
  cleanText,
  defaultAgentLabel,
  isSupportedAgentKind,
}

// Pure text classifiers for local Agent failure diagnostics.
//
// Agent CLIs report failures as free text on stderr or inside structured error
// results. Classification decides whether Meldwork retries, asks the user to
// sign in again, or rebuilds a native session, so every rule here errs on the
// side of "ambiguous": only explicit login and API-key statements count as a
// definitive authentication failure. A bare 403, a proxy refusal, or a word
// such as "unauthorized" inside unrelated output must never mark an installed
// Agent as signed out.

const MAX_SIGNAL_TEXT_CHARS = 64 * 1024

const LOG_PREFIX = /^(?:\[[^\]]{1,40}\]\s*|(?:error|fatal|err|warning)\s*[:!-]\s*|[✗✘×!]\s*)+/i

const DEFINITIVE_AUTH_LINE = [
  /^(?:invalid|expired|missing|incorrect|revoked)\s+(?:api[ _-]?key|(?:access|refresh|auth|oauth|bearer)[ _-]?token|credentials?)\b/i,
  /^(?:authentication|authorization)\s+(?:failed|required)\b/i,
  /^(?:please\s+)?(?:log|sign)\s+in\b/i,
  /^(?:please\s+)?run\s+\S*\s*(?:\/)?login\b/i,
  /^not\s+(?:logged|signed)\s+in\b/i,
  /^you\s+are\s+not\s+(?:logged|signed)\s+in\b/i,
  /^select an auth type\b/i,
  /^oauth\s+token\s+(?:has\s+)?(?:expired|is\s+invalid|was\s+revoked)\b/i,
  /^HTTP\s+401\s*:/i,
  /^provider rejected\b/i,
  /^(?:认证|鉴权|登录)(?:失败|过期)/,
  /^(?:令牌|凭据|密钥)(?:无效|缺失|已过期)/,
  /^请(?:先|重新)登录/,
  /^未登录/,
]

const DEFINITIVE_AUTH_ANYWHERE = /"type"\s*:\s*"authentication_error"|\binvalid_api_key\b|\bincorrect api key provided\b|\binvalid x-api-key\b/i

// Ambiguous refusals must lead a diagnostic line. Tool output such as
// "Failed to download docs: HTTP 403 Forbidden" mentions a refusal of some
// unrelated resource and stays a plain process failure.
const AMBIGUOUS_AUTH_LINE = [
  /^HTTP\s+403\s*:/i,
  /^(?:403\s+)?forbidden\b/i,
  /^unauthori[sz]ed\b/i,
  /^access denied\b/i,
  /^invalid token\b/i,
]

const AMBIGUOUS_AUTH_ANYWHERE = /"type"\s*:\s*"permission_error"/i

const RATE_LIMIT = /\b429\b|too many requests|rate[ _-]?limit(?:ed|ing)?\b|\boverloaded(?:_error)?\b|\bquota (?:exceeded|exhausted)\b|\bresource[ _-]?exhausted\b|\binsufficient_quota\b|\b529\b/i

const NETWORK = /\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ENETDOWN|EHOSTUNREACH)\b|socket hang up|fetch failed|network (?:error|is unreachable)|connection (?:reset|refused|closed|timed out)|getaddrinfo|tls handshake|ssl handshake|proxy (?:error|connection)/i

const PROVIDER_UNAVAILABLE = /\b(?:HTTP\s*)?50[0234]\b\s*(?::|-)?\s*(?:internal server error|bad gateway|service unavailable|gateway timeout)|\bservice unavailable\b|\bbad gateway\b|\bgateway timeout\b|\binternal server error\b|"type"\s*:\s*"api_error"|\bupstream connect error\b/i

const CONTEXT_OVERFLOW = /prompt is too long|context[_ ]length[_ ]exceeded|maximum context length|context window (?:exceeded|is full|limit)|input is too long|too many (?:input )?tokens|exceeds? the (?:maximum|model'?s?) context|context_window_exceeded|request too large for model/i

function signalText(value) {
  return String(value || '').slice(0, MAX_SIGNAL_TEXT_CHARS)
}

function diagnosticLines(value) {
  return signalText(value)
    .split(/\r?\n/)
    .map(line => line.trim().replace(LOG_PREFIX, '').trim())
    .filter(Boolean)
}

// Returns 'definitive', 'ambiguous', or ''.
function authFailureCertainty(value) {
  const text = signalText(value)
  if (!text.trim()) return ''
  const lines = diagnosticLines(text)
  if (DEFINITIVE_AUTH_ANYWHERE.test(text)
      || lines.some(line => DEFINITIVE_AUTH_LINE.some(pattern => pattern.test(line)))) {
    return 'definitive'
  }
  if (lines.some(line => AMBIGUOUS_AUTH_LINE.some(pattern => pattern.test(line)))
      || AMBIGUOUS_AUTH_ANYWHERE.test(text)) {
    return 'ambiguous'
  }
  return ''
}

function isRateLimited(value) {
  return RATE_LIMIT.test(signalText(value))
}

function isNetworkFailure(value) {
  return NETWORK.test(signalText(value))
}

function isProviderUnavailable(value) {
  return PROVIDER_UNAVAILABLE.test(signalText(value))
}

function isContextOverflow(value) {
  return CONTEXT_OVERFLOW.test(signalText(value))
}

const RETRY_AFTER_PATTERNS = [
  /retry[- ]after["']?\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)?/i,
  /(?:try|retry) again in\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)?/i,
  /(?:reset|resets) in\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)/i,
]

const MAX_RETRY_AFTER_MS = 5 * 60 * 1000

function retryAfterFromText(value) {
  const text = signalText(value)
  for (const pattern of RETRY_AFTER_PATTERNS) {
    const match = text.match(pattern)
    if (!match) continue
    const amount = Number(match[1])
    if (!Number.isFinite(amount) || amount < 0) continue
    const unit = String(match[2] || 's').toLowerCase()
    const multiplier = unit.startsWith('ms') || unit.startsWith('milli')
      ? 1
      : unit.startsWith('m') ? 60 * 1000 : 1000
    return Math.min(MAX_RETRY_AFTER_MS, Math.round(amount * multiplier))
  }
  return null
}

module.exports = {
  authFailureCertainty,
  isContextOverflow,
  isNetworkFailure,
  isProviderUnavailable,
  isRateLimited,
  retryAfterFromText,
}

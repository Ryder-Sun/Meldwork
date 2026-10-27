const { stripAnsi } = require('./cli-output-parsers.cjs')

const RUNTIME_EVENT_TYPES = new Set([
  'status',
  'answer_delta',
  'reasoning_summary',
  'plan',
  'tool_start',
  'tool_update',
  'tool_result_summary',
  'warning',
])
const RUNTIME_EVENT_STATUSES = new Set([
  'queued', 'running', 'waiting', 'completed', 'partial', 'failed', 'stopped', 'timeout',
])
const RUNTIME_EVENT_LIMITS = Object.freeze({
  id: 100,
  status: 24,
  title: 120,
  summary: 2000,
  detail: 4000,
  delta: 4000,
})

function utf8ByteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8')
}

function redactChildSecrets(value, env) {
  let result = String(value || '')
  for (const secret of childSecrets(env)) {
    result = result.split(secret).join('[redacted]')
  }
  return result
}

function childSecrets(env) {
  const secrets = new Set()
  for (const [name, value] of Object.entries(env || {})) {
    if (typeof value !== 'string' || !value) continue
    if (/(?:API[_-]?KEY|ACCESS[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)/i.test(name)
        && utf8ByteLength(value) >= 8) secrets.add(value)
    if (!/^(?:https?|all)_proxy$/i.test(name)) continue
    if (value.includes('@')) secrets.add(value)
    try {
      const url = new URL(value)
      if (!url.username && !url.password) continue
      secrets.add(value)
      secrets.add(url.href)
      const userinfo = `${url.username}:${url.password}`
      secrets.add(userinfo)
      const decoded = decodeURIComponent(userinfo)
      secrets.add(decoded)
      secrets.add(Buffer.from(decoded).toString('base64'))
      for (const part of [url.username, url.password]) {
        if (utf8ByteLength(part) >= 8) secrets.add(part)
        const literal = decodeURIComponent(part)
        if (utf8ByteLength(literal) >= 8) secrets.add(literal)
      }
    } catch { /* malformed proxy URLs are diagnosed by the native runtime */ }
  }
  return [...secrets].sort((left, right) => right.length - left.length)
}

function assignmentNameVariants(parts) {
  return parts.slice(1).reduce(
    (names, part) => names.flatMap(name => ['', '_', '-'].map(separator => `${name}${separator}${part}`)),
    [parts[0]],
  )
}

const ASSIGNMENT_NAME_FRAGMENTS = [
  ...assignmentNameVariants(['api', 'key']),
  ...assignmentNameVariants(['access', 'key']),
  ...assignmentNameVariants(['access', 'key', 'id']),
  ...assignmentNameVariants(['secret', 'access', 'key']),
  ...assignmentNameVariants(['access', 'token']),
  ...assignmentNameVariants(['refresh', 'token']),
  ...assignmentNameVariants(['auth', 'token']),
  ...assignmentNameVariants(['database', 'url']),
  ...assignmentNameVariants(['connection', 'string']),
  ...assignmentNameVariants(['private', 'key']),
  'dsn', 'token', 'secret', 'password', 'credential', 'authorization',
]

function tokenPrefixSuffixLength(value, token, requireBoundary = true, minimumLength = 1) {
  const lowerValue = value.toLowerCase()
  const lowerToken = token.toLowerCase()
  for (let length = Math.min(value.length, token.length); length > 0; length -= 1) {
    if (length < minimumLength) break
    if (!lowerValue.endsWith(lowerToken.slice(0, length))) continue
    const start = value.length - length
    if (!requireBoundary || start === 0 || !/[A-Za-z0-9_]/.test(value[start - 1])) return length
  }
  return 0
}

function pathSuffixLength(value) {
  const matches = [
    value.match(/file:\/\/\/[^\s"'`<>|,;)}\]]+$/i),
    value.match(/(?<![A-Za-z0-9:])(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`<>|,;)}\]]+$/),
    value.match(/(?<![\p{L}\p{N}:/])\/+[^\s"'`<>|,;)}\]]+$/u),
  ]
  return Math.max(...matches.map(match => match?.[0]?.length || 0))
}

function boundarySensitiveSuffixLength(value, secrets) {
  let retained = 0
  const retain = (length) => { retained = Math.max(retained, length || 0) }
  // Keep a word boundary across chunks: a slash in the next chunk may be
  // prose (云/端), not the start of an absolute filesystem path.
  retain(value.match(/(?=[^\x00-\x7f])[\p{L}\p{N}]$/u)?.[0]?.length)
  for (const secret of secrets) {
    const limit = Math.min(value.length, secret.length - 1)
    for (let length = limit; length > retained; length -= 1) {
      if (value.endsWith(secret.slice(0, length))) {
        retain(length)
        break
      }
    }
  }
  retain(tokenPrefixSuffixLength(value, 'AKIA'))
  retain(tokenPrefixSuffixLength(value, 'bearer'))
  for (const name of ASSIGNMENT_NAME_FRAGMENTS) {
    retain(tokenPrefixSuffixLength(value, name, false))
  }
  const pathLength = pathSuffixLength(value)
  if (pathLength) retain(pathLength)
  retain(value.match(/(?<![\p{L}\p{N}:/])\/+$/u)?.[0]?.length)

  const matches = [
    value.match(/\bAKIA[0-9A-Z]{0,15}$/),
    value.match(/\bbearer\s+[A-Za-z0-9._~+\/-]*$/i),
    value.match(/(["']?)(?:[A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|database[_-]?url|connection[_-]?string|dsn|token|secret|password|credential|authorization|private[_-]?key)[A-Za-z0-9_.-]*)\1\s*[:=]\s*(?:"[^"\r\n]*|'[^'\r\n]*'|\[[^\]\r\n]*\]|[^\s,;}\]]*)$/i),
    value.match(/\b[A-Za-z][A-Za-z0-9+.-]*:\/{0,1}$/),
    value.match(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s\/@]*$/),
    value.match(/\bhttps?$/i),
  ]
  for (const match of matches) retain(match?.[0]?.length)
  retain(value.match(/-----BEGIN [A-Z0-9 ]*$/i)?.[0]?.length)
  const privateKey = value.match(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*$/i)
  if (privateKey && !/-----END [A-Z0-9 ]*PRIVATE KEY-----\s*$/i.test(privateKey[0])) {
    retain(privateKey[0].length)
  }
  return retained
}

function pendingAnswerDeltaIsSensitive(value, secrets) {
  if (utf8ByteLength(value) >= 8 && secrets.some(secret => secret.startsWith(value))) return true
  if (/\bAKIA[0-9A-Z]*$/.test(value)) return true
  if (/\bbearer\s+[A-Za-z0-9._~+\/-]+$/i.test(value)) return true
  if (/(["']?)(?:[A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|database[_-]?url|connection[_-]?string|dsn|token|secret|password|credential|authorization|private[_-]?key)[A-Za-z0-9_.-]*)\1\s*[:=]\s*[^\s,;}\]]*$/i.test(value)) return true
  if (/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s\/@:]+:[^\s\/@]*$/i.test(value)) return true
  return /-----BEGIN [A-Z0-9 ]*$/i.test(value)
    || /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*$/i.test(value)
}

function createAnswerDeltaRedactor(env) {
  const secrets = childSecrets(env)
  let pending = ''

  return {
    push(value) {
      const combined = redactChildSecrets(pending + String(value || ''), env)
      const retained = boundarySensitiveSuffixLength(combined, secrets)
      pending = retained ? combined.slice(-retained) : ''
      return sanitizeRuntimeEventText(
        retained ? combined.slice(0, -retained) : combined,
        env,
        Number.MAX_SAFE_INTEGER,
        false,
        false,
      )
    },
    flush(terminalText = '') {
      if (!pending) return ''
      const value = pending
      pending = ''
      const combined = value + String(terminalText || '')
      if (redactChildSecrets(combined, env) !== combined) return ''
      if (pendingAnswerDeltaIsSensitive(value, secrets)) return '[redacted]'
      if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s\/@:]+(?:\/[^\s]*)?$/.test(value)) return value
      return sanitizeRuntimeEventText(value, env, Number.MAX_SAFE_INTEGER, false, false)
    },
  }
}

function runtimeEventStatus(value, fallback = '') {
  const normalized = String(value || '').toLowerCase()
  const aliases = {
    pending: 'queued',
    in_progress: 'running',
    cancelled: 'stopped',
    canceled: 'stopped',
    success: 'completed',
    error: 'failed',
  }
  const status = aliases[normalized] || normalized
  return RUNTIME_EVENT_STATUSES.has(status) ? status : fallback
}

function terminalAnswerStatus(status) {
  return ['completed', 'failed', 'partial', 'stopped', 'timeout'].includes(status)
}

function sanitizeRuntimeEventText(value, childEnv, limit, singleLine = false, trim = true) {
  let text = stripAnsi(redactChildSecrets(value, childEnv))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi, '[redacted private key]')
    .replace(/file:\/\/\/[^\s"'`<>|,;)}\]]+/gi, '[path]')
    .replace(/(?<![A-Za-z0-9:])(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`<>|,;)}\]]+/g, '[path]')
    .replace(/(?<![\p{L}\p{N}:/])\/+[^\s"'`<>|,;)}\]]+/gu, '[path]')
    .replace(/(["']?)(?:[A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|database[_-]?url|connection[_-]?string|dsn|token|secret|password|credential|authorization|private[_-]?key)[A-Za-z0-9_.-]*)\1\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|\[[^\]\r\n]*\]|[^\s,;}\]]+)/gi, 'credential=[redacted]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]')
    .replace(/\bbearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, '$1[redacted]@')
    .replace(/(["']?)(?:command|cmd)\1\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]+)/gi, '[operation hidden]')
    .replace(/(["']?)stderr\1\s*[:=]\s*[^\r\n]*/gi, '[diagnostic hidden]')
  if (singleLine) text = text.replace(/\s+/g, ' ')
  return (trim ? text.trim() : text).slice(0, limit)
}

function createRuntimeEventEmitter(options, childEnv) {
  const callback = typeof options.onEvent === 'function' ? options.onEvent : null
  const activity = typeof options.onActivity === 'function' ? options.onActivity : null
  let deliveredAnswer = ''
  let finalized = false
  const openTools = new Map()
  const answerDeltaRedactor = createAnswerDeltaRedactor(childEnv)
  const deliver = (event) => {
    if (!callback) return
    try {
      const pending = callback(event)
      if (pending && typeof pending.catch === 'function') pending.catch(() => {})
    } catch { /* runtime events are best-effort */ }
  }
  const deliverAnswerDelta = (base, delta) => {
    if (!delta) return false
    const replace = base.replace === true
    deliveredAnswer = replace ? delta : deliveredAnswer + delta
    const eventBase = { ...base }
    delete eventBase.replace
    for (let offset = 0; offset < delta.length; offset += RUNTIME_EVENT_LIMITS.delta) {
      deliver({
        ...eventBase,
        ...(replace && offset === 0 ? { replace: true } : {}),
        delta: delta.slice(offset, offset + RUNTIME_EVENT_LIMITS.delta),
      })
    }
    return true
  }
  const flushAnswerDelta = (
    base = { type: 'answer_delta', status: 'completed' }, terminalText = '',
  ) => {
    return deliverAnswerDelta(base, answerDeltaRedactor.flush(terminalText))
  }
  const emit = (input) => {
    try { activity?.() } catch { /* activity is best-effort */ }
    if (!callback || !input || !RUNTIME_EVENT_TYPES.has(input.type)) return
    const base = { type: input.type }
    const rawId = sanitizeRuntimeEventText(input.id, childEnv, RUNTIME_EVENT_LIMITS.id, true)
    if (/^[A-Za-z0-9._:-]{1,100}$/.test(rawId)) base.id = rawId
    const status = runtimeEventStatus(input.status)
    if (status) base.status = status
    for (const field of ['title', 'summary', 'detail']) {
      const text = sanitizeRuntimeEventText(
        input[field],
        childEnv,
        RUNTIME_EVENT_LIMITS[field],
        field === 'title',
      )
      if (text) base[field] = text
    }
    if (base.id && input.type === 'tool_start') {
      openTools.set(base.id, {
        id: base.id,
        ...(base.title ? { title: base.title } : {}),
      })
    } else if (base.id && input.type === 'tool_result_summary') {
      openTools.delete(base.id)
    }
    if (input.type !== 'answer_delta') {
      deliver(base)
      return
    }
    const delta = answerDeltaRedactor.push(input.delta)
    deliverAnswerDelta(base, terminalAnswerStatus(status) ? delta + answerDeltaRedactor.flush() : delta)
  }
  const finalize = ({ text = '', status = 'completed' } = {}) => {
    if (finalized) return false
    finalized = true
    const answerStatus = runtimeEventStatus(status, 'failed')
    const toolStatus = answerStatus === 'completed' ? 'partial' : answerStatus
    for (const tool of openTools.values()) {
      deliver({
        type: 'tool_result_summary',
        id: tool.id,
        status: toolStatus,
        ...(tool.title ? { title: tool.title } : {}),
      })
    }
    openTools.clear()
    const flushedAnswerDelta = flushAnswerDelta(
      { type: 'answer_delta', status: answerStatus },
      text,
    )
    if (text) {
      const finalAnswerRedactor = createAnswerDeltaRedactor(childEnv)
      const finalAnswer = finalAnswerRedactor.push(text) + finalAnswerRedactor.flush()
      if (!deliveredAnswer) {
        deliverAnswerDelta({ type: 'answer_delta', status: answerStatus }, finalAnswer)
      } else if (!flushedAnswerDelta && finalAnswer === deliveredAnswer) {
        deliverAnswerDelta(
          { type: 'answer_delta', status: answerStatus, replace: true },
          finalAnswer,
        )
      } else if (finalAnswer.startsWith(deliveredAnswer)) {
        deliverAnswerDelta(
          { type: 'answer_delta', status: answerStatus },
          finalAnswer.slice(deliveredAnswer.length),
        )
      } else {
        deliverAnswerDelta(
          { type: 'answer_delta', status: answerStatus, replace: true },
          finalAnswer,
        )
      }
    }
    return true
  }
  return {
    emit,
    finalize,
    emitFinalAnswer(text, outcome = 'completed') {
      return finalize({ text, status: outcome })
    },
  }
}

module.exports = {
  createRuntimeEventEmitter,
  redactChildSecrets,
  runtimeEventStatus,
}

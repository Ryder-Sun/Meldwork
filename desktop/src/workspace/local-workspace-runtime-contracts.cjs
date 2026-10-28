const { DEFAULT_MAX_OUTPUT_CHARS, normalizeTraceCapsule } = require('../runs/run-harness.cjs')
const {
  MAX_MESSAGE_TEXT_CHARS,
  MAX_SYSTEM_PARAM_TEXT_CHARS,
  cleanInline,
  cleanText,
  isSupportedAgentKind,
} = require('./local-workspace-contracts.cjs')

const AUTO_CONSENSUS_MARKER = /\[\[MELDWORK_CONSENSUS:(agree|continue)\]\]/gi
const AUTO_FINAL_CONSENSUS_MARKER = /(?:^|\r?\n)[ \t]*\[\[MELDWORK_CONSENSUS:(agree|continue)\]\][ \t]*$/i
const DEFAULT_RUN_SILENCE_WARNING_MS = 20 * 1000
// Inactivity windows for one Agent turn. Real CLIs regularly think, run builds
// or wait on slow providers for several minutes; the former 3/5 minute limits
// killed Agents that were still working. A separate no-progress cap (three
// times the inactivity window) still stops CLIs that only emit heartbeats.
const DEFAULT_RUN_AGENT_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_RUN_AGENT_TOOL_TIMEOUT_MS = 20 * 60 * 1000
const DEFAULT_AUTO_AGENT_INVOCATION_MAX_MS = 6 * 60 * 1000
const DEFAULT_AUTO_AGENT_ANSWER_IDLE_MS = 60 * 1000
const DEFAULT_AUTO_AGENT_TOOL_CALL_LIMIT = 12
const DEFAULT_RUN_ABORT_GRACE_MS = 2500
const DEFAULT_AUTO_ROUNDS = 6
const MAX_AUTO_ROUNDS = 10
const MAX_TERMINAL_PREFIX_TEXT_CHARS = (MAX_SYSTEM_PARAM_TEXT_CHARS * 2) + 128
const MAX_TERMINAL_MESSAGE_TEXT_CHARS = MAX_TERMINAL_PREFIX_TEXT_CHARS
  + 1
  + DEFAULT_MAX_OUTPUT_CHARS
const SESSION_REF = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$/
const SECRET_LIKE_SESSION_REF = /^(?:sk|rk|pk|ghp|github_pat|xox[baprs]?)[_-][A-Za-z0-9_-]{12,}$/i
const RUN_STATUSES = new Set([
  'completed', 'partial', 'failed', 'stopped', 'timeout', 'round-limit', 'interrupted',
  'budget-exhausted', 'circuit-breaker',
])
const RECOVERABLE_AGENT_STATUSES = new Set([
  'completed', 'partial', 'failed', 'stopped', 'timeout', 'interrupted',
])
const AGENT_TERMINAL_SYSTEM_KEYS = new Set([
  'system.agentCallFailed', 'system.agentStopped', 'system.agentInterrupted',
  'system.agentBudgetExhausted',
])
const RUN_LEDGER_CHECKPOINT_DELAY_MS = 120
const PROGRESS_TITLES = new Set([
  'reasoning', 'process', 'read_file', 'write_file', 'search',
  'image_generation', 'audio_generation', 'video_generation', 'tool',
])
// Hermes sessions stay on one main-process ACP connection; cross-process resume is rejected.
const HERMES_WORKSPACE_ACP_ENABLED = true

function isTracedAgentTerminalMessage(message) {
  return message?.role === 'system'
    && isSupportedAgentKind(message.agentKind)
    && AGENT_TERMINAL_SYSTEM_KEYS.has(message.system?.key)
    && Boolean(normalizeTraceCapsule(message.trace))
}

function terminalMessageContent(prefix, streamedConclusion) {
  const safePrefix = cleanText(prefix, MAX_TERMINAL_PREFIX_TEXT_CHARS)
  const conclusion = cleanText(streamedConclusion, DEFAULT_MAX_OUTPUT_CHARS)
  return cleanText(
    [safePrefix, conclusion].filter(Boolean).join('\n'),
    MAX_TERMINAL_MESSAGE_TEXT_CHARS,
  )
}

function terminalMessageContentLimit(role, agentKind, systemKey) {
  return role === 'system' && agentKind && AGENT_TERMINAL_SYSTEM_KEYS.has(systemKey)
    ? MAX_TERMINAL_MESSAGE_TEXT_CHARS
    : MAX_MESSAGE_TEXT_CHARS
}

function terminalStatusPrefix(label, status, reason = '') {
  const agent = cleanText(label, MAX_SYSTEM_PARAM_TEXT_CHARS)
  if (status === 'interrupted') return `${agent} was interrupted when Meldwork closed.`
  if (status === 'stopped') return `${agent} was stopped.`
  return `${agent} failed: ${cleanText(reason, MAX_SYSTEM_PARAM_TEXT_CHARS)}`
}

function budgetTerminalPrefix(label) {
  const agent = cleanText(label, MAX_SYSTEM_PARAM_TEXT_CHARS)
  return `${agent} stopped because a hard run budget was exceeded.`
}

function terminalRunStatusForReason(reason, fallback = 'stopped') {
  if (reason === 'shutdown') return 'interrupted'
  if (reason === 'hard_budget') return 'budget-exhausted'
  if (reason === 'circuit_breaker') return 'circuit-breaker'
  return RUN_STATUSES.has(fallback) ? fallback : 'stopped'
}

function terminalStatusPrefixFromMessage(message, fallbackLabel, fallbackStatus, fallbackReason) {
  const key = message?.system?.key
  const label = cleanText(message?.system?.params?.agent, MAX_SYSTEM_PARAM_TEXT_CHARS)
    || fallbackLabel
  if (key === 'system.agentInterrupted') return terminalStatusPrefix(label, 'interrupted')
  if (key === 'system.agentStopped') return terminalStatusPrefix(label, 'stopped')
  if (key === 'system.agentBudgetExhausted') return budgetTerminalPrefix(label)
  if (key === 'system.agentCallFailed') {
    const reason = cleanText(message?.system?.params?.reason, MAX_SYSTEM_PARAM_TEXT_CHARS)
      || fallbackReason
    return terminalStatusPrefix(label, 'failed', reason)
  }
  return terminalStatusPrefix(fallbackLabel, fallbackStatus, fallbackReason)
}

function cleanProgressSteps(value) {
  return (Array.isArray(value) ? value : []).slice(-8).map((step) => {
    const requestedTitle = cleanInline(step?.title, 80).toLowerCase()
    return {
      title: PROGRESS_TITLES.has(requestedTitle) ? requestedTitle : 'process',
      status: ['completed', 'failed', 'in_progress'].includes(step?.status)
        ? step.status
        : 'completed',
    }
  })
}

function cleanElapsedMs(value) {
  return Number.isFinite(value) && value >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.round(value))
    : null
}

function agentStoppedError() {
  return new Error('LOCAL_AGENT_EXECUTION_STOPPED')
}

function normalizeSessionRef(value) {
  const sessionRef = String(value || '')
  return SESSION_REF.test(sessionRef) && !SECRET_LIKE_SESSION_REF.test(sessionRef) ? sessionRef : ''
}

async function abortableOperation(operation, signal) {
  if (signal?.aborted) throw agentStoppedError()
  if (!signal) return await Promise.resolve().then(operation)
  let abortHandler
  const aborted = new Promise((_, reject) => {
    abortHandler = () => reject(agentStoppedError())
    signal.addEventListener('abort', abortHandler, { once: true })
  })
  try {
    return await Promise.race([Promise.resolve().then(operation), aborted])
  } finally {
    signal.removeEventListener('abort', abortHandler)
  }
}

function settleWithin(promise, timeoutMs) {
  if (!promise) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    let timer
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    Promise.resolve(promise).then(() => finish(true), () => finish(true))
    timer = setTimeout(() => finish(false), timeoutMs)
  })
}

function normalizeAutoRounds(value) {
  const requested = Number(value)
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_AUTO_ROUNDS
  return Math.max(1, Math.min(MAX_AUTO_ROUNDS, Math.floor(requested)))
}

function cleanRunMaxRounds(value) {
  const requested = Number(value)
  if (!Number.isFinite(requested) || requested <= 0) return 0
  return Math.max(1, Math.min(MAX_AUTO_ROUNDS, Math.floor(requested)))
}

function cleanCurrentRound(value, maxRounds, unlimitedRounds = false) {
  const requested = Number(value)
  if (!Number.isFinite(requested) || requested <= 0) return 0
  if (unlimitedRounds) return Math.floor(requested)
  if (!maxRounds) return 0
  return Math.max(1, Math.min(maxRounds, Math.floor(requested)))
}

function parseAutoReply(value) {
  const raw = String(value || '').trim()
  const finalMarker = raw.match(AUTO_FINAL_CONSENSUS_MARKER)
  const markerCount = raw.match(AUTO_CONSENSUS_MARKER)?.length || 0
  const text = raw.replace(AUTO_CONSENSUS_MARKER, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const consensus = markerCount === 1
    && finalMarker?.[1].toLowerCase() === 'agree'
  return { text, consensus }
}

module.exports = {
  AGENT_TERMINAL_SYSTEM_KEYS,
  AUTO_CONSENSUS_MARKER,
  DEFAULT_AUTO_AGENT_INVOCATION_MAX_MS,
  DEFAULT_AUTO_AGENT_ANSWER_IDLE_MS,
  DEFAULT_AUTO_AGENT_TOOL_CALL_LIMIT,
  DEFAULT_AUTO_ROUNDS,
  DEFAULT_RUN_ABORT_GRACE_MS,
  DEFAULT_RUN_AGENT_TIMEOUT_MS,
  DEFAULT_RUN_AGENT_TOOL_TIMEOUT_MS,
  DEFAULT_RUN_SILENCE_WARNING_MS,
  HERMES_WORKSPACE_ACP_ENABLED,
  RECOVERABLE_AGENT_STATUSES,
  RUN_LEDGER_CHECKPOINT_DELAY_MS,
  RUN_STATUSES,
  abortableOperation,
  agentStoppedError,
  budgetTerminalPrefix,
  cleanCurrentRound,
  cleanElapsedMs,
  cleanProgressSteps,
  cleanRunMaxRounds,
  isTracedAgentTerminalMessage,
  normalizeAutoRounds,
  normalizeSessionRef,
  parseAutoReply,
  settleWithin,
  terminalMessageContent,
  terminalMessageContentLimit,
  terminalRunStatusForReason,
  terminalStatusPrefix,
  terminalStatusPrefixFromMessage,
}

const { redactSecrets } = require('../security/secret-redaction.cjs')

function parseTaskDecision(input) {
  const invalid = () => { throw new Error('LOCAL_RUN_TASK_DECISION_INVALID') }
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['status', 'reason', 'deliverables', 'handoffTo', 'nextKinds', 'reviewedVersion'].includes(key))
      || !['completed', 'continue', 'blocked', 'needs-human'].includes(input.status)) invalid()
  const text = (value, limit) => {
    if (typeof value !== 'string' || !value.trim() || value.length > limit
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) invalid()
    return redactSecrets(value.trim())
  }
  const reason = text(input.reason, 1600)
  if (!Array.isArray(input.deliverables) || input.deliverables.length > 16) invalid()
  const deliverables = input.deliverables.map(value => text(value, 800))
  if (input.status === 'completed' && !deliverables.length) invalid()
  if (input.handoffTo != null && (input.status !== 'continue'
      || typeof input.handoffTo !== 'string'
      || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(input.handoffTo))) invalid()
  if (input.nextKinds != null && (!Array.isArray(input.nextKinds)
      || input.nextKinds.length > 32
      || input.nextKinds.some(kind => typeof kind !== 'string'
        || !/^[a-z0-9][a-z0-9-]{0,79}$/i.test(kind))
      || (input.nextKinds.length > 0 && input.status !== 'continue'))) invalid()
  const nextKinds = input.nextKinds?.map(kind => kind.toLowerCase())
  if (nextKinds && new Set(nextKinds).size !== nextKinds.length) invalid()
  if (input.reviewedVersion != null && (typeof input.reviewedVersion !== 'string'
      || !/^[a-f0-9]{64}$/.test(input.reviewedVersion))) invalid()
  return {
    status: input.status, reason, deliverables,
    ...(input.handoffTo != null ? { handoffTo: input.handoffTo } : {}),
    ...(nextKinds ? { nextKinds } : {}),
    ...(input.reviewedVersion != null ? { reviewedVersion: input.reviewedVersion } : {}),
  }
}

const STATUS_SYNONYMS = new Map([
  ['completed', 'completed'], ['complete', 'completed'], ['done', 'completed'],
  ['finished', 'completed'], ['success', 'completed'], ['succeeded', 'completed'],
  ['continue', 'continue'], ['continuing', 'continue'], ['in-progress', 'continue'],
  ['in_progress', 'continue'], ['ongoing', 'continue'], ['pending', 'continue'],
  ['blocked', 'blocked'], ['blocker', 'blocked'],
  ['needs-human', 'needs-human'], ['needs_human', 'needs-human'],
  ['needs human', 'needs-human'], ['needshuman', 'needs-human'], ['human', 'needs-human'],
])

function agentKindToken(value) {
  return typeof value === 'string'
    ? value.trim().replace(/^@+/, '').toLowerCase()
    : ''
}

// Agents write task decisions by hand at the end of free text. Small slips
// (capitalised status, "done", an @handle, a single string instead of a list,
// a completed answer without a separate file) used to fail the whole turn
// and silently end the discussion. Normalise them first; the strict parser
// still validates the result.
function normalizeTaskDecision(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const status = STATUS_SYNONYMS.get(String(input.status || '').trim().toLowerCase())
    || String(input.status || '')
  const textList = value => (Array.isArray(value) ? value : (value == null ? [] : [value]))
    .filter(item => typeof item === 'string' && item.trim())
    .map(item => item.trim().slice(0, 800))
    .slice(0, 16)
  const reason = typeof input.reason === 'string' && input.reason.trim()
    ? input.reason.trim().slice(0, 1600)
    : String(options.fallbackReason || '').trim().slice(0, 1600) || 'No reason given.'
  let deliverables = textList(input.deliverables)
  // A completed answer is itself the deliverable when nothing else was named.
  if (status === 'completed' && !deliverables.length) deliverables = ['The answer in this message']
  const nextKinds = [...new Set(textList(input.nextKinds).map(agentKindToken).filter(Boolean))]
  const handoffTo = agentKindToken(input.handoffTo)
  return {
    status,
    reason,
    deliverables,
    ...(status === 'continue' && handoffTo ? { handoffTo } : {}),
    // Keep an explicit list (even an empty one) so the stored decision says
    // what the Agent wrote; peers can only be requested while continuing.
    ...(input.nextKinds != null
      ? { nextKinds: status === 'continue' ? nextKinds.slice(0, 32) : [] }
      : {}),
    ...(input.reviewedVersion != null ? { reviewedVersion: input.reviewedVersion } : {}),
  }
}

function parseLenientTaskDecision(input, options = {}) {
  return parseTaskDecision(normalizeTaskDecision(input, options))
}

module.exports = { normalizeTaskDecision, parseLenientTaskDecision, parseTaskDecision }

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/
const GROUP_IDENTIFIER = /^[^\u0000-\u001f\u007f]{1,100}$/u
const AGENT_KIND = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/
const CONTEXT_RECORD_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const CONTEXT_PACK_ID = /^context-pack-[a-f0-9]{64}$/
const DELIVERY_RECORD_ID = /^delivery-record-[a-f0-9]{64}$/
const SHA256 = /^[a-f0-9]{64}$/
const SESSION_SCOPES = new Set(['task', 'conversation', 'group', 'unknown-legacy', 'none'])
const SESSION_ORIGINS = new Set(['created', 'resumed', 'migrated', 'unknown-legacy', 'none'])
const SESSION_PROVENANCE_COMPLETENESS = new Set(['complete', 'partial', 'unknown-legacy'])
const SESSION_PROVENANCE_FIELDS = new Set([
  'scope',
  'reuse',
  'origin',
  'originTaskId',
  'inheritedTaskIds',
  'completeness',
])
const RUN_EVENT_TYPES = new Set([
  'status',
  'answer_delta',
  'reasoning_summary',
  'plan',
  'tool_start',
  'tool_update',
  'tool_result_summary',
  'warning',
])
const CAPSULE_EVENT_TYPES = new Set([
  'reasoning_summary',
  'plan',
  'tool_start',
  'tool_update',
  'tool_result_summary',
  'warning',
])
const EVENT_STATUSES = new Set([
  'pending', 'queued', 'preparing', 'in_progress', 'running', 'streaming', 'waiting',
  'completed', 'succeeded', 'failed', 'cancelled', 'stopped', 'partial', 'timeout', 'interrupted',
])
const ORCHESTRATION_PHASES = new Set([
  'prepare', 'dispatch', 'running', 'reconcile',
  'proposal', 'discussion', 'challenge', 'coordination', 'work', 'synthesis', 'verification',
  'commit', 'committed', 'failed', 'stopped', 'human-gate',
])
const TRACE_PHASES = new Set([
  'proposal', 'challenge', 'coordination', 'work', 'synthesis', 'verification', 'commit',
  'discussion', 'synthesis-recovery', 'manual_retry',
])
const ORCHESTRATION_SLOT_STATUSES = new Set([
  'planned', 'prepared', 'queued', 'running', 'waiting', 'settled', 'completed', 'committed',
  'partial', 'failed', 'stopped', 'timeout', 'interrupted', 'cancelled', 'unknown_outcome',
])
const ORCHESTRATION_SLOT_ROLES = new Set([
  'primary', 'reviewer', 'arbiter', 'worker', 'integrator',
  'synthesizer', 'verifier', 'writer', 'participant',
])
const MAX_ORCHESTRATION_SLOTS = 32

export const MAX_RUN_AGENTS = 64
export const MAX_TRACE_EVENTS = 200
const MAX_CAPSULE_EVENTS = 12
export const MAX_SEEN_EVENT_SEQUENCES = 512
const MAX_SOURCE_MESSAGE_IDS = 32
const MAX_DELIVERY_RECORD_IDS = 8
const MAX_INHERITED_TASK_IDS = 64
export const MAX_AGENT_OUTPUT = 20000

export function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

export function boundedString(value, limit, { trim = true } = {}) {
  if (typeof value !== 'string' || value.length > limit) return ''
  return trim ? value.trim() : value
}

export function identifier(value) {
  const normalized = boundedString(value, 160)
  return IDENTIFIER.test(normalized) ? normalized : ''
}

export function groupIdentifier(value) {
  const normalized = typeof value === 'string' ? value : ''
  return GROUP_IDENTIFIER.test(normalized) ? normalized : ''
}

export function agentKind(value) {
  const normalized = boundedString(value, 40)
  return AGENT_KIND.test(normalized) ? normalized : ''
}

export function normalizedAgentKinds(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.slice(0, MAX_RUN_AGENTS).map(agentKind).filter(Boolean))]
}

function nonNegativeInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isInteger(value) && value >= 0 && value <= maximum ? value : null
}

export function orchestrationPhase(value) {
  const phase = boundedString(value, 40).toLowerCase()
  if (phase === 'completed') return 'committed'
  return ORCHESTRATION_PHASES.has(phase) ? phase : ''
}

export function orchestrationSlotCompleted(value) {
  return ['completed', 'succeeded', 'settled', 'committed'].includes(
    boundedString(value, 40).toLowerCase(),
  )
}

function normalizeOrchestrationSlot(value, roleByAgentKind, orchestrationRound) {
  const input = record(value)
  if (!input) return null
  const agentKindValue = agentKind(input.agentKind)
  const phase = orchestrationPhase(input.phase)
  const status = boundedString(input.status, 40).toLowerCase()
  if (!agentKindValue || !phase || !ORCHESTRATION_SLOT_STATUSES.has(status)) {
    return null
  }
  const output = { agentKind: agentKindValue, phase, status }
  const role = boundedString(input.role, 40).toLowerCase()
    || roleByAgentKind.get(agentKindValue)
    || ''
  if (ORCHESTRATION_SLOT_ROLES.has(role)) output.role = role
  const round = nonNegativeInteger(input.round, 100000) ?? orchestrationRound
  if (round !== null) output.round = round
  return output
}

export function normalizeOrchestration(value) {
  const input = record(value)
  if (!input || input.version !== 4) return null
  const output = { version: 4 }
  const phase = orchestrationPhase(input.phase)
  if (!phase) return output
  output.phase = phase
  const currentKinds = normalizedAgentKinds(input.currentKinds)
  if (currentKinds.length) output.currentKinds = currentKinds
  const roleByAgentKind = new Map(
    (Array.isArray(input.plan?.assignments) ? input.plan.assignments : [])
      .map(assignment => [
        agentKind(assignment?.agentKind),
        boundedString(assignment?.role, 40).toLowerCase(),
      ])
      .filter(([kind, role]) => kind && ORCHESTRATION_SLOT_ROLES.has(role)),
  )
  const orchestrationRound = nonNegativeInteger(input.round, 100000)
  if (Array.isArray(input.slots)) {
    const slots = input.slots.slice(0, MAX_ORCHESTRATION_SLOTS)
      .map(slot => normalizeOrchestrationSlot(slot, roleByAgentKind, orchestrationRound))
      .filter(Boolean)
    if (slots.length) output.slots = slots
  }
  return output
}

function normalizedTimestamp(value) {
  if (Number.isFinite(value) && value >= 0) return value
  const text = boundedString(value, 80)
  return text && !Number.isNaN(Date.parse(text)) ? text : ''
}

function normalizedStatus(value) {
  const status = boundedString(value, 32).toLowerCase()
  return EVENT_STATUSES.has(status) ? status : ''
}

function sourceMessageIds(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.slice(0, MAX_SOURCE_MESSAGE_IDS).map(identifier).filter(Boolean))]
}

function contextRecordIdentifier(value) {
  const normalized = boundedString(value, 120)
  return CONTEXT_RECORD_IDENTIFIER.test(normalized) ? normalized : ''
}

function normalizedContextPackId(value) {
  return typeof value === 'string' && CONTEXT_PACK_ID.test(value) ? value : ''
}

function normalizedDeliveryRecordIds(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(item => (
    typeof item === 'string' && DELIVERY_RECORD_ID.test(item) ? item : ''
  )).filter(Boolean))].slice(-MAX_DELIVERY_RECORD_IDS)
}

function normalizeSessionProvenance(value) {
  const input = record(value)
  if (!input) return null
  const keys = Reflect.ownKeys(input)
  if (
    keys.length !== SESSION_PROVENANCE_FIELDS.size
    || keys.some(key => typeof key !== 'string' || !SESSION_PROVENANCE_FIELDS.has(key))
    || [...SESSION_PROVENANCE_FIELDS].some(key => !Object.hasOwn(input, key))
  ) return null

  const scope = boundedString(input.scope, 32)
  const origin = boundedString(input.origin, 32)
  const completeness = boundedString(input.completeness, 32)
  if (
    !SESSION_SCOPES.has(scope)
    || typeof input.reuse !== 'boolean'
    || !SESSION_ORIGINS.has(origin)
    || !SESSION_PROVENANCE_COMPLETENESS.has(completeness)
    || (input.originTaskId !== null && !contextRecordIdentifier(input.originTaskId))
    || !Array.isArray(input.inheritedTaskIds)
    || input.inheritedTaskIds.length > MAX_INHERITED_TASK_IDS
  ) return null

  const originTaskId = input.originTaskId === null ? null : contextRecordIdentifier(input.originTaskId)
  const inheritedTaskIds = input.inheritedTaskIds.map(contextRecordIdentifier)
  if (
    inheritedTaskIds.some(id => !id)
    || new Set(inheritedTaskIds).size !== inheritedTaskIds.length
    || (!input.reuse && inheritedTaskIds.length)
    || (input.reuse && ['created', 'none'].includes(origin))
    || (!input.reuse && !['created', 'none'].includes(origin))
  ) return null

  if (scope === 'none' && (
    input.reuse
    || origin !== 'none'
    || originTaskId !== null
    || inheritedTaskIds.length
    || completeness !== 'complete'
  )) return null

  const unknownLegacy = scope === 'unknown-legacy' || origin === 'unknown-legacy'
  if (
    unknownLegacy !== (completeness === 'unknown-legacy')
    || (unknownLegacy && (originTaskId !== null || inheritedTaskIds.length))
    || (!unknownLegacy && scope !== 'none' && !originTaskId)
    || (scope === 'task' && inheritedTaskIds.length)
    || (originTaskId && inheritedTaskIds.includes(originTaskId))
  ) return null

  return {
    scope,
    reuse: input.reuse,
    origin,
    originTaskId,
    inheritedTaskIds,
    completeness,
  }
}

function normalizeTraceContext(value) {
  const input = record(value)
  if (!input) return { includedCount: 0, omittedCount: 0, charCount: 0 }
  const context = {
    includedCount: nonNegativeInteger(input.includedCount, 1000) ?? 0,
    omittedCount: nonNegativeInteger(input.omittedCount, 100000) ?? 0,
    charCount: nonNegativeInteger(input.charCount, 1000000) ?? 0,
  }
  if (['bootstrap', 'continuation'].includes(input.contextMode)) {
    context.contextMode = input.contextMode
  }
  for (const field of ['promptChars', 'sourceCount', 'promptBytes', 'wirePayloadBytes']) {
    const maximum = field === 'sourceCount' ? 1000 : 10000000
    const normalized = nonNegativeInteger(input[field], maximum)
    if (normalized !== null) context[field] = normalized
  }
  for (const field of ['sourceHash', 'promptHash', 'wirePayloadHash']) {
    if (typeof input[field] === 'string' && SHA256.test(input[field])) {
      context[field] = input[field]
    }
  }
  if (input.sessionRotated === true) context.sessionRotated = true
  const contextPackId = normalizedContextPackId(input.contextPackId)
  if (contextPackId) context.contextPackId = contextPackId
  if (input.contextPackState === 'legacy-unavailable' && !contextPackId) {
    context.contextPackState = 'legacy-unavailable'
  } else if (contextPackId) context.contextPackState = 'captured'
  const deliveryRecordIds = normalizedDeliveryRecordIds(input.deliveryRecordIds)
  if (deliveryRecordIds.length) context.deliveryRecordIds = deliveryRecordIds
  const sessionProvenance = normalizeSessionProvenance(input.sessionProvenance)
  if (sessionProvenance) context.sessionProvenance = sessionProvenance
  return context
}

function capsuleDetail(value) {
  const detail = boundedString(value, 600, { trim: false })
  if (!detail) return ''
  return detail.split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => (
      /^Exit code: -?\d+$/u.test(line)
      || /^Output: \d+ lines?, \d+ bytes$/u.test(line)
      || /^Result: (?:-?\d+(?:\.\d+)?|true|false|\d+ items?|\d+ fields?)$/u.test(line)
    ))
    .slice(0, 4)
    .join('\n')
}

export function normalizeCapsuleEvent(value, index = 0) {
  const input = record(value)
  if (!input) return null
  const type = boundedString(input.type, 40).toLowerCase()
  if (!CAPSULE_EVENT_TYPES.has(type)) return null
  const evidenceId = identifier(input.evidenceId) || `E-${index + 1}`
  const event = {
    evidenceId,
    type,
    status: normalizedStatus(input.status) || 'completed',
  }
  const title = boundedString(input.title, 120)
  const summary = boundedString(input.summary, 600)
  const detail = capsuleDetail(input.detail)
  if (title) event.title = title
  if (summary) event.summary = summary
  if (detail) event.detail = detail
  return event
}

export function normalizeRunEvent(value, fallback = {}) {
  const input = record(value)
  const defaults = record(fallback) || {}
  if (!input) return null
  const runId = identifier(input.runId || defaults.runId)
  const agentRunId = identifier(input.agentRunId || defaults.agentRunId)
  const groupId = groupIdentifier(input.groupId || defaults.groupId)
  const threadRootId = identifier(input.threadRootId || defaults.threadRootId)
  const kind = agentKind(input.agentKind || input.kind || defaults.agentKind || defaults.kind)
  const round = nonNegativeInteger(input.round ?? defaults.round, 10000)
  const seq = nonNegativeInteger(input.seq)
  const type = boundedString(input.type, 40).toLowerCase()
  if (!runId || !agentRunId || !groupId || !kind || seq == null || !RUN_EVENT_TYPES.has(type)) {
    return null
  }

  const event = { runId, agentRunId, groupId, agentKind: kind, round: round ?? 0, seq, type }
  if (threadRootId) event.threadRootId = threadRootId
  const id = identifier(input.id)
  const status = normalizedStatus(input.status)
  const title = boundedString(input.title, 160)
  const summary = boundedString(input.summary, 4000)
  const detail = boundedString(input.detail, 12000, { trim: false })
  const delta = boundedString(input.delta, 16000, { trim: false })
  const timestamp = normalizedTimestamp(input.timestamp)
  if (id) event.id = id
  if (status) event.status = status
  if (title) event.title = title
  if (summary) event.summary = summary
  if (detail) event.detail = detail
  if (delta) event.delta = delta
  if (timestamp !== '') event.timestamp = timestamp
  if (type === 'answer_delta' && !delta) return null
  if (type === 'answer_delta' && input.replace === true) event.replace = true
  return event
}

function normalizeStoredEvents(value, fallback) {
  if (!Array.isArray(value)) return []
  const bySequence = new Map()
  for (const item of value.slice(-MAX_TRACE_EVENTS)) {
    const event = normalizeRunEvent(item, fallback)
    if (event) bySequence.set(event.seq, event)
  }
  return [...bySequence.values()].sort((left, right) => left.seq - right.seq)
}

export function normalizeRunAgent(value, run = {}) {
  const input = record(value)
  const parent = record(run) || {}
  if (!input) return null
  const runId = identifier(parent.runId || input.runId)
  const groupId = groupIdentifier(parent.groupId || input.groupId)
  const threadRootId = identifier(parent.threadRootId || input.threadRootId)
  const agentRunId = identifier(input.agentRunId)
  const kind = agentKind(input.kind || input.agentKind)
  if (!runId || !groupId || !agentRunId || !kind) return null
  const round = nonNegativeInteger(input.round, 10000) ?? 0
  const status = normalizedStatus(input.status) || 'pending'
  const events = normalizeStoredEvents(input.events, {
    runId, agentRunId, groupId, threadRootId, agentKind: kind, round,
  })
  const output = boundedString(input.output, MAX_AGENT_OUTPUT, { trim: false })
  const startedAt = normalizedTimestamp(input.startedAt)
  const lastActivityAt = normalizedTimestamp(input.lastActivityAt)
  let orchestration = normalizeOrchestration(input.orchestration)
  const targetKinds = normalizedAgentKinds(parent.targetKinds)
  if (orchestration && targetKinds.length) {
    const targets = new Set(targetKinds)
    orchestration = {
      ...orchestration,
      ...(Array.isArray(orchestration.currentKinds)
        ? { currentKinds: orchestration.currentKinds.filter(kind => targets.has(kind)) }
        : {}),
      ...(Array.isArray(orchestration.slots)
        ? { slots: orchestration.slots.filter(slot => targets.has(slot.agentKind)) }
        : {}),
    }
  }
  const seenSeqs = [...new Set([
    ...events.map(event => event.seq),
    ...(Array.isArray(input.seenSeqs) ? input.seenSeqs : []),
  ].map(value => nonNegativeInteger(value)).filter(value => value != null))]
    .slice(-MAX_SEEN_EVENT_SEQUENCES)
  return {
    agentRunId,
    kind,
    round,
    status,
    output,
    events,
    sourceMessageIds: sourceMessageIds(input.sourceMessageIds),
    context: normalizeTraceContext(input.context),
    ...(orchestration ? { orchestration } : {}),
    ...(startedAt !== '' ? { startedAt } : {}),
    ...(lastActivityAt !== '' ? { lastActivityAt } : {}),
    ...(Number.isSafeInteger(input.turnSeq) && input.turnSeq > 0 ? { turnSeq: input.turnSeq } : {}),
    silent: input.silent === true,
    truncated: input.truncated === true,
    seenSeqs,
  }
}

export function normalizeMessageTrace(value, message = {}) {
  void message
  const input = record(value)
  if (!input) return null
  const runId = identifier(input.runId)
  const agentRunId = identifier(input.agentRunId)
  if (!runId || !agentRunId) return null
  const round = nonNegativeInteger(input.round, 100000)
  const executionSequence = nonNegativeInteger(input.executionSequence, 100000)
  const phase = boundedString(input.phase, 40).toLowerCase()
  const context = normalizeTraceContext(input.context)
  const orchestration = normalizeOrchestration(input.orchestration)
  const events = (Array.isArray(input.events) ? input.events : [])
    .slice(0, MAX_CAPSULE_EVENTS)
    .map(normalizeCapsuleEvent)
    .filter(Boolean)
  return {
    runId,
    agentRunId,
    ...(round != null ? { round } : {}),
    ...(executionSequence != null ? { executionSequence } : {}),
    ...(TRACE_PHASES.has(phase) ? { phase } : {}),
    status: normalizedStatus(input.status) || 'completed',
    summary: boundedString(input.summary, 8000),
    events,
    sourceMessageIds: sourceMessageIds(input.sourceMessageIds),
    truncated: input.truncated === true,
    context,
    ...(orchestration ? { orchestration } : {}),
  }
}

import {
  MAX_RUN_AGENTS,
  agentKind,
  groupIdentifier,
  identifier,
  normalizeMessageTrace,
  normalizeOrchestration,
  normalizeRunAgent,
  normalizedAgentKinds,
  record,
} from './desktop-normalization.js'

const HUMAN_GATE_ID = /^human-gate-[a-f0-9]{64}$/
const AGENT_TERMINAL_SYSTEM_KEYS = new Set([
  'system.agentCallFailed', 'system.agentStopped', 'system.agentInterrupted',
  'system.agentBudgetExhausted',
])
const HUMAN_GATE_OPTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const HUMAN_GATE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/
const HUMAN_GATE_FIELDS = new Set([
  'gateId', 'type', 'runId', 'agentRunId', 'agentKind', 'summary', 'options', 'status', 'createdAt',
])
const HUMAN_GATE_OPTION_FIELDS = new Set(['optionId', 'name', 'kind'])
const BUDGET_DIMENSIONS = [
  'inputTokens', 'outputTokens', 'costMicros', 'toolCalls', 'outboundBytes', 'elapsedMs',
]
const BUDGET_DIMENSION_FIELDS = new Set(BUDGET_DIMENSIONS)
const REQUIRED_BUDGET_FIELDS = new Set(['limits', 'used', 'source', 'enforcement', 'startedAt'])
const BUDGET_FIELDS = new Set([...REQUIRED_BUDGET_FIELDS, 'exhaustion'])
const BUDGET_EXHAUSTION_FIELDS = new Set([
  'dimension', 'limit', 'priorUsed', 'attemptedUsage', 'used',
  'source', 'enforcement', 'reason',
])
const BUDGET_SOURCES = new Set(['reported', 'estimated', 'unknown'])
const BUDGET_ENFORCEMENTS = new Set(['hard', 'soft'])
const V4_RUN_PHASES = new Set([
  'preparing', 'running', 'waiting', 'completed', 'succeeded', 'partial',
  'failed', 'cancelled', 'stopped', 'timeout', 'interrupted',
])
const V4_RUN_MODES = new Set(['manual', 'auto'])
const V4_RUN_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/
const MAX_V4_CURRENT_ROUND = 100000
const MAX_V4_CONFIGURED_ROUNDS = 10
const MAX_DATE_TIMESTAMP = 8640000000000000
const RUN_OUTCOME_STATUSES = new Set([
  'preparing', 'queued', 'running', 'waiting', 'reconciling',
  'completed', 'partial', 'failed', 'stopped', 'timeout', 'round-limit', 'interrupted',
  'budget-exhausted', 'circuit-breaker',
])
const RUN_OUTCOME_FIELDS = new Set([
  'groupId', 'runId', 'threadRootId', 'status', 'targetKinds', 'startedAt', 'finishedAt',
])

export function emptySnapshot() {
  return {
    agents: [], groups: [], messages: [], runningGroupIds: [], runs: [], humanGates: [], runOutcomes: [],
  }
}

function normalizeProgress(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 8).map(item => ({
    title: String(item?.title || '').trim(),
    status: String(item?.status || '').trim(),
  })).filter(item => item.title)
}

function boundedV4RunInteger(value, maximum) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null
}

function normalizedV4RunTimestamp(value) {
  if (Number.isSafeInteger(value) && value >= 0 && value <= MAX_DATE_TIMESTAMP) return value
  return typeof value === 'string' && value.length <= 40 && V4_RUN_TIMESTAMP.test(value)
    && Number.isFinite(Date.parse(value))
    ? value
    : null
}

function exactRecord(value, fields) {
  const input = record(value)
  if (!input) return null
  const keys = Reflect.ownKeys(input)
  return keys.length === fields.size
    && keys.every(key => typeof key === 'string' && fields.has(key))
    && [...fields].every(field => Object.hasOwn(input, field))
    ? input
    : null
}

function normalizeBudget(value) {
  const input = record(value)
  if (!input) return null
  const keys = Reflect.ownKeys(input)
  if (keys.some(key => typeof key !== 'string' || !BUDGET_FIELDS.has(key))
      || [...REQUIRED_BUDGET_FIELDS].some(field => !Object.hasOwn(input, field))) return null
  if (!input || !Number.isSafeInteger(input.startedAt) || input.startedAt < 0) return null
  const limits = exactRecord(input.limits, BUDGET_DIMENSION_FIELDS)
  const used = exactRecord(input.used, BUDGET_DIMENSION_FIELDS)
  const source = exactRecord(input.source, BUDGET_DIMENSION_FIELDS)
  const enforcement = exactRecord(input.enforcement, BUDGET_DIMENSION_FIELDS)
  if (!limits || !used || !source || !enforcement) return null
  const output = { limits: {}, used: {}, source: {}, enforcement: {}, startedAt: input.startedAt }
  for (const dimension of BUDGET_DIMENSIONS) {
    const limit = limits[dimension]
    const usedValue = used[dimension]
    const sourceValue = source[dimension]
    const enforcementValue = enforcement[dimension]
    if ((limit !== null && (!Number.isSafeInteger(limit) || limit < 0))
        || !Number.isSafeInteger(usedValue) || usedValue < 0
        || !BUDGET_SOURCES.has(sourceValue)
        || !BUDGET_ENFORCEMENTS.has(enforcementValue)) return null
    output.limits[dimension] = limit
    output.used[dimension] = usedValue
    output.source[dimension] = sourceValue
    output.enforcement[dimension] = enforcementValue
  }
  if (Object.hasOwn(input, 'exhaustion')) {
    if (input.exhaustion === null) output.exhaustion = null
    else {
      const exhaustion = exactRecord(input.exhaustion, BUDGET_EXHAUSTION_FIELDS)
      if (!exhaustion
          || !BUDGET_DIMENSION_FIELDS.has(exhaustion.dimension)
          || !Number.isSafeInteger(exhaustion.limit) || exhaustion.limit < 0
          || !Number.isSafeInteger(exhaustion.priorUsed) || exhaustion.priorUsed < 0
          || !Number.isSafeInteger(exhaustion.attemptedUsage) || exhaustion.attemptedUsage < 0
          || !Number.isSafeInteger(exhaustion.used) || exhaustion.used < 0
          || exhaustion.used !== exhaustion.priorUsed + exhaustion.attemptedUsage
          || exhaustion.used <= exhaustion.limit
          || !BUDGET_SOURCES.has(exhaustion.source)
          || exhaustion.enforcement !== 'hard'
          || exhaustion.reason !== 'BUDGET_LIMIT_EXCEEDED') return null
      output.exhaustion = { ...exhaustion }
    }
  }
  return output
}

function normalizeHumanGate(value) {
  const input = exactRecord(value, HUMAN_GATE_FIELDS)
  const gateId = String(input?.gateId || '')
  const runId = identifier(input?.runId)
  const agentRunId = identifier(input?.agentRunId)
  const kind = agentKind(input?.agentKind)
  const type = String(input?.type || '')
  const status = String(input?.status || '')
  const summary = typeof input?.summary === 'string' && input.summary.length <= 500
    ? input.summary.trim()
    : ''
  const createdAt = typeof input?.createdAt === 'string' && input.createdAt.length <= 80
    && HUMAN_GATE_TIMESTAMP.test(input.createdAt)
    && !Number.isNaN(Date.parse(input.createdAt))
    ? input.createdAt
    : ''
  if (!HUMAN_GATE_ID.test(gateId) || !runId || !agentRunId || !kind || !summary
      || runId !== input?.runId || agentRunId !== input?.agentRunId || kind !== input?.agentKind
      || !HUMAN_GATE_OPTION_ID.test(runId) || !HUMAN_GATE_OPTION_ID.test(agentRunId)
      || !['permission', 'budget', 'decision', 'retry', 'input'].includes(type)
      || status !== 'pending'
      || summary !== input?.summary
      || /[\u0000-\u001f\u007f]/u.test(summary)
      || !createdAt
      || !Array.isArray(input.options)) return null
  const options = input.options.slice(0, 16).map((option) => {
    const normalized = exactRecord(option, HUMAN_GATE_OPTION_FIELDS)
    const optionId = String(normalized?.optionId || '')
    const name = typeof normalized?.name === 'string' && normalized.name.length <= 160
      ? normalized.name.trim()
      : ''
    const optionKind = String(normalized?.kind || '')
    return HUMAN_GATE_OPTION_ID.test(optionId) && HUMAN_GATE_OPTION_ID.test(optionKind) && name
      && name === normalized?.name && !/[\u0000-\u001f\u007f]/u.test(name)
      ? { optionId, name, kind: optionKind }
      : null
  }).filter(Boolean)
  if (!options.length || options.length !== input.options.length
      || new Set(options.map(option => option.optionId)).size !== options.length) return null
  return {
    gateId, runId, agentRunId, agentKind: kind, type, summary, options, status,
    createdAt,
  }
}

function scopeRunToTargetKinds(run, values) {
  const targetKinds = normalizedAgentKinds(values)
  const targets = new Set(targetKinds)
  const orchestration = run.orchestration && run.orchestration.version === 4
    ? {
        ...run.orchestration,
        ...(Array.isArray(run.orchestration.currentKinds)
          ? { currentKinds: run.orchestration.currentKinds.filter(kind => targets.has(kind)) }
          : {}),
        ...(Array.isArray(run.orchestration.slots)
          ? { slots: run.orchestration.slots.filter(slot => targets.has(slot.agentKind)) }
          : {}),
      }
    : run.orchestration
  const scoped = {
    ...run,
    targetKinds,
    completedKinds: normalizedAgentKinds(run.completedKinds).filter(kind => targets.has(kind)),
    failedKinds: normalizedAgentKinds(run.failedKinds).filter(kind => targets.has(kind)),
    currentKind: targets.has(agentKind(run.currentKind)) ? agentKind(run.currentKind) : '',
    agentRuns: (Array.isArray(run.agentRuns) ? run.agentRuns : []).filter(agent => targets.has(agent.kind)),
    ...(orchestration ? { orchestration } : {}),
  }
  delete scoped._targetKindsInferred
  return scoped
}

function normalizeRun(value) {
  const input = record(value)
  if (!input) return null
  const isV4 = record(input.orchestration)?.version === 4
  const run = isV4
    ? { progress: normalizeProgress(input.progress) }
    : { ...input, progress: normalizeProgress(input.progress) }
  if (isV4) {
    if (V4_RUN_PHASES.has(input.phase)) run.phase = input.phase
    if (V4_RUN_MODES.has(input.mode)) run.mode = input.mode
    const currentRound = boundedV4RunInteger(input.currentRound, MAX_V4_CURRENT_ROUND)
    const maxRounds = boundedV4RunInteger(input.maxRounds, MAX_V4_CONFIGURED_ROUNDS)
    const startedAt = normalizedV4RunTimestamp(input.startedAt)
    if (currentRound !== null) run.currentRound = currentRound
    if (maxRounds !== null) run.maxRounds = maxRounds
    if (typeof input.unlimitedRounds === 'boolean') run.unlimitedRounds = input.unlimitedRounds
    if (startedAt !== null) run.startedAt = startedAt
    const orchestration = normalizeOrchestration(input.orchestration)
    if (orchestration) run.orchestration = orchestration
    else delete run.orchestration
  }
  const runId = identifier(input.runId)
  const groupId = groupIdentifier(input.groupId)
  const threadRootId = identifier(input.threadRootId)
  const responseVersionRootId = identifier(input.responseVersionRootId)
  if (runId) run.runId = runId
  else delete run.runId
  if (groupId) run.groupId = groupId
  else delete run.groupId
  if (threadRootId) run.threadRootId = threadRootId
  else delete run.threadRootId
  if (responseVersionRootId) run.responseVersionRootId = responseVersionRootId
  else delete run.responseVersionRootId
  const declaredTargetKinds = normalizedAgentKinds(input.targetKinds)
  run.targetKinds = declaredTargetKinds
  const rawAgentRuns = Array.isArray(input.agentRuns) ? input.agentRuns : input.agents
  run.agentRuns = Array.isArray(rawAgentRuns)
    ? rawAgentRuns.slice(0, MAX_RUN_AGENTS).map(agent => normalizeRunAgent(agent, run)).filter(Boolean)
    : []
  // Agents waiting for another writer in the same folder.
  run.waitingForWorkspaceKinds = normalizedAgentKinds(input.waitingForWorkspaceKinds)
  run.waitingGateIds = [...new Set((Array.isArray(input.waitingGateIds)
    ? input.waitingGateIds.slice(0, 32)
    : []).filter(gateId => typeof gateId === 'string' && HUMAN_GATE_ID.test(gateId)))]
  const budget = normalizeBudget(input.budget)
  if (budget) run.budget = budget
  else delete run.budget
  delete run.agents
  const inferredTargetKinds = normalizedAgentKinds([
    ...run.agentRuns.map(agent => agent.kind),
    ...(Array.isArray(run.orchestration?.currentKinds) ? run.orchestration.currentKinds : []),
    ...(Array.isArray(run.orchestration?.slots)
      ? run.orchestration.slots.map(slot => slot.agentKind)
      : []),
    input.currentKind,
    ...(Array.isArray(input.completedKinds) ? input.completedKinds : []),
    ...(Array.isArray(input.failedKinds) ? input.failedKinds : []),
  ])
  return scopeRunToTargetKinds(
    run,
    declaredTargetKinds.length ? declaredTargetKinds : inferredTargetKinds,
  )
}

function normalizeMessage(value) {
  const input = record(value)
  if (!input) return null
  const message = { ...input }
  const responseVersionRootId = message.role === 'agent'
    || (message.role === 'system' && AGENT_TERMINAL_SYSTEM_KEYS.has(message.system?.key))
    ? identifier(input.responseVersionRootId)
    : ''
  if (responseVersionRootId) message.responseVersionRootId = responseVersionRootId
  else delete message.responseVersionRootId
  const targetKinds = normalizedAgentKinds(input.targetKinds)
  const mentionedAgentKinds = normalizedAgentKinds(input.mentionedAgentKinds)
  if (targetKinds.length) message.targetKinds = targetKinds
  else delete message.targetKinds
  if (mentionedAgentKinds.length) message.mentionedAgentKinds = mentionedAgentKinds
  else delete message.mentionedAgentKinds
  const trace = normalizeMessageTrace(input.trace)
  if (trace) message.trace = trace
  else delete message.trace
  if (!Number.isSafeInteger(input.turnSeq) || input.turnSeq <= 0) delete message.turnSeq
  return message
}

export function normalizeSnapshot(value) {
  const messages = Array.isArray(value?.messages) ? value.messages.map(normalizeMessage).filter(Boolean) : []
  const messagesById = new Map(messages.map(message => [message.id, message]))
  const groupIds = new Set((Array.isArray(value?.groups) ? value.groups : []).map(group => group.id))
  const runOutcomes = []
  const outcomeRoots = new Set()
  for (const valueOutcome of Array.isArray(value?.runOutcomes) ? value.runOutcomes : []) {
    const outcome = exactRecord(valueOutcome, RUN_OUTCOME_FIELDS)
    if (!outcome) continue
    const root = messagesById.get(outcome.threadRootId)
    const kinds = normalizedAgentKinds(outcome.targetKinds)
    if (!groupIds.has(outcome.groupId) || groupIdentifier(outcome.groupId) !== outcome.groupId
        || !outcome.runId || identifier(outcome.runId) !== outcome.runId
        || root?.role !== 'user' || root.threadRootId || root.groupId !== outcome.groupId
        || !RUN_OUTCOME_STATUSES.has(outcome.status) || !kinds.length
        || !Array.isArray(outcome.targetKinds) || kinds.length !== outcome.targetKinds.length
        || kinds.some((kind, index) => kind !== outcome.targetKinds[index])
        || !Number.isSafeInteger(outcome.startedAt) || outcome.startedAt < 0 || outcome.startedAt > MAX_DATE_TIMESTAMP
        || !Number.isSafeInteger(outcome.finishedAt) || outcome.finishedAt < 0 || outcome.finishedAt > MAX_DATE_TIMESTAMP
        || (outcome.finishedAt && outcome.finishedAt < outcome.startedAt)
        || outcomeRoots.has(outcome.threadRootId)) continue
    outcomeRoots.add(outcome.threadRootId)
    runOutcomes.push({ ...outcome, targetKinds: kinds })
  }
  const runs = (Array.isArray(value?.runs) ? value.runs : [])
    .map(normalizeRun)
    .filter(Boolean)
    .map((run) => {
      const rootMessage = messagesById.get(run.threadRootId)
      const messageTargets = normalizedAgentKinds(rootMessage?.targetKinds)
      const mentionedTargets = normalizedAgentKinds(rootMessage?.mentionedAgentKinds)
      const targets = messageTargets.length ? messageTargets : mentionedTargets
      return targets.length ? scopeRunToTargetKinds(run, targets) : run
    })
  const activeGates = (Array.isArray(value?.humanGates) ? value.humanGates.slice(0, 128) : [])
    .map(normalizeHumanGate)
    .filter((gate) => {
      if (!gate) return false
      const run = runs.find(item => item.runId === gate.runId)
      return Boolean(run?.agentRuns.some(agent => (
        agent.agentRunId === gate.agentRunId && agent.kind === gate.agentKind
      )))
    })
  const gatesById = new Map(activeGates.map(gate => [gate.gateId, gate]))
  for (const run of runs) {
    run.waitingGateIds = run.waitingGateIds.filter((gateId) => {
      const gate = gatesById.get(gateId)
      return gate?.runId === run.runId
    })
  }
  const waitingGateIds = new Set(runs.flatMap(run => run.waitingGateIds))
  return {
    agents: Array.isArray(value?.agents) ? value.agents : [],
    groups: Array.isArray(value?.groups) ? value.groups : [],
    messages,
    runningGroupIds: Array.isArray(value?.runningGroupIds) ? value.runningGroupIds : [],
    runs,
    runOutcomes,
    humanGates: activeGates.filter(gate => waitingGateIds.has(gate.gateId)),
  }
}

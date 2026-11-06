const {
  AGENT_CAPABILITY_DOMAINS,
  AGENT_COST_BANDS,
  AGENT_INPUT_TYPES,
  AGENT_LATENCY_BANDS,
  AGENT_OUTPUT_TYPES,
  AGENT_PERMISSION_MODES,
  AGENT_TOOL_CLASSES,
  agentRuntimeCapabilities,
  isCodeReviewAgentKind,
} = require('./agent-runtime-contract.cjs')
const { parseFitMatrix } = require('../evaluations/eval-records.cjs')
const { cleanInline, isSupportedAgentKind } = require('../workspace/local-workspace-contracts.cjs')

const ROUTING_DECISION_VERSION = 1
const MIN_FIT_MATRIX_SAMPLE_SIZE = 3
const MIN_FIT_MATRIX_CONFIDENCE = 0.6
const MAX_ROUTING_CANDIDATES = 32
const MAX_ROUTING_REQUIREMENTS = 8
const ROUTING_MODES = new Set(['explicit', 'automatic'])
const COLLABORATION_MODES = new Set(['none', 'beneficial', 'required'])
const LIMIT_BANDS = new Set(['low', 'medium', 'high', 'any'])
const BAND_ORDER = new Map([['low', 0], ['medium', 1], ['high', 2]])
const EXCLUSION_REASONS = new Set([
  'unavailable', 'domain', 'input-type', 'output-type', 'tool-class',
  'permission', 'latency', 'cost', 'context', 'resumability', 'unverified',
])
const RATIONALES = new Set([
  'explicit-user-selection', 'smallest-suitable-team', 'evidence-ranked-team',
])
const REQUIREMENT_KEYS = new Set([
  'collaboration', 'domains', 'inputTypes', 'maxCostBand', 'maxLatencyBand',
  'minContextChars', 'outputTypes', 'permissionMode', 'resumableRequired', 'toolClasses',
])
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/

function routingError(code, diagnostic = {}) {
  const error = Object.assign(new Error(code), { code })
  Object.defineProperty(error, 'routingDiagnostic', {
    value: Object.freeze({ code, ...diagnostic }),
    enumerable: false,
  })
  return error
}

function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value : null
}

function exactKeys(value, keys) {
  const input = plainRecord(value)
  if (!input) return false
  const actual = Reflect.ownKeys(input)
  return actual.length === keys.size
    && actual.every(key => typeof key === 'string' && keys.has(key))
}

function uniqueValues(value, allowed, fallback = [], maximum = MAX_ROUTING_REQUIREMENTS) {
  if (value == null) return [...fallback]
  if (!Array.isArray(value) || value.length > maximum || new Set(value).size !== value.length
      || value.some(item => typeof item !== 'string' || !allowed.includes(item))) {
    throw routingError('LOCAL_AGENT_ROUTING_REQUIREMENTS_INVALID')
  }
  return [...value]
}

function normalizeRoutingRequirements(value, defaults = {}) {
  const input = value == null ? {} : plainRecord(value)
  if (!input || Reflect.ownKeys(input).some(key => (
    typeof key !== 'string' || !REQUIREMENT_KEYS.has(key)
  ))) {
    throw routingError('LOCAL_AGENT_ROUTING_REQUIREMENTS_INVALID')
  }
  const permissionMode = input.permissionMode ?? defaults.permissionMode ?? 'read-only'
  const collaboration = input.collaboration ?? defaults.collaboration ?? 'none'
  const maxLatencyBand = input.maxLatencyBand ?? 'any'
  const maxCostBand = input.maxCostBand ?? 'any'
  const minContextChars = input.minContextChars ?? defaults.minContextChars ?? 1
  const resumableRequired = input.resumableRequired ?? false
  if (!AGENT_PERMISSION_MODES.includes(permissionMode)
      || (defaults.permissionMode && permissionMode !== defaults.permissionMode)
      || !COLLABORATION_MODES.has(collaboration)
      || !LIMIT_BANDS.has(maxLatencyBand)
      || !LIMIT_BANDS.has(maxCostBand)
      || !Number.isSafeInteger(minContextChars) || minContextChars < 1
      || minContextChars > 4 * 1024 * 1024
      || typeof resumableRequired !== 'boolean') {
    throw routingError('LOCAL_AGENT_ROUTING_REQUIREMENTS_INVALID')
  }
  return Object.freeze({
    domains: Object.freeze(uniqueValues(
      input.domains, AGENT_CAPABILITY_DOMAINS, defaults.domains || ['general'],
    )),
    inputTypes: Object.freeze(uniqueValues(
      input.inputTypes, AGENT_INPUT_TYPES, defaults.inputTypes || ['text'],
    )),
    outputTypes: Object.freeze(uniqueValues(
      input.outputTypes, AGENT_OUTPUT_TYPES, defaults.outputTypes || ['text'],
    )),
    toolClasses: Object.freeze(uniqueValues(input.toolClasses, AGENT_TOOL_CLASSES, [])),
    permissionMode,
    maxLatencyBand,
    maxCostBand,
    minContextChars,
    resumableRequired,
    collaboration,
  })
}

function normalizeFitMatrix(value) {
  const input = plainRecord(value)
  if (input?.schemaVersion === 1 && Object.hasOwn(input, 'matrixId')) {
    try {
      const matrix = parseFitMatrix(input)
      return Object.freeze({
        version: matrix.matrixId,
        entries: Object.freeze(matrix.entries.filter(entry => entry.routingEligible).map(entry => (
          Object.freeze({
            kind: entry.kind,
            domains: Object.freeze([...entry.domains]),
            score: entry.score,
            confidence: entry.confidence,
            sampleSize: entry.sampleSize,
          })
        ))),
      })
    } catch {
      return Object.freeze({ version: '', entries: Object.freeze([]) })
    }
  }
  if (!input || !PUBLIC_ID.test(String(input.version || ''))
      || !Array.isArray(input.entries) || input.entries.length > 512) {
    return Object.freeze({ version: '', entries: Object.freeze([]) })
  }
  const entries = input.entries.map((entry) => {
    const candidate = plainRecord(entry)
    const kind = cleanInline(candidate?.kind, 40)
    const domains = Array.isArray(candidate?.domains)
      ? [...new Set(candidate.domains.filter(domain => AGENT_CAPABILITY_DOMAINS.includes(domain)))]
      : []
    const score = Number(candidate?.score)
    const confidence = Number(candidate?.confidence)
    const sampleSize = Number(candidate?.sampleSize)
    if (!isSupportedAgentKind(kind) || !domains.length
        || !Number.isFinite(score) || score < 0 || score > 100
        || !Number.isFinite(confidence) || confidence < 0 || confidence > 1
        || !Number.isSafeInteger(sampleSize) || sampleSize < 1) return null
    return Object.freeze({ kind, domains: Object.freeze(domains), score, confidence, sampleSize })
  }).filter(Boolean)
  return Object.freeze({ version: input.version, entries: Object.freeze(entries) })
}

function evidenceFor(kind, requirements, matrix) {
  const matches = matrix.entries.filter(entry => (
    entry.kind === kind
      && entry.sampleSize >= MIN_FIT_MATRIX_SAMPLE_SIZE
      && entry.confidence >= MIN_FIT_MATRIX_CONFIDENCE
      && entry.domains.some(domain => requirements.domains.includes(domain))
  )).sort((left, right) => (
    (right.confidence * right.sampleSize) - (left.confidence * left.sampleSize)
      || right.score - left.score
  ))
  const best = matches[0]
  if (!best) return null
  return Object.freeze({
    matrixVersion: matrix.version,
    score: Math.round(best.score * 100) / 100,
    confidence: Math.round(best.confidence * 1000) / 1000,
    sampleSize: best.sampleSize,
  })
}

function exceedsBand(actual, maximum) {
  if (maximum === 'any') return false
  if (actual === 'unknown') return true
  return BAND_ORDER.get(actual) > BAND_ORDER.get(maximum)
}

function evaluateCandidate(agent, requirements, options = {}) {
  const capabilities = agentRuntimeCapabilities(agent.kind, {
    agent,
    attachmentSupport: options.attachmentSupport?.(agent.kind) || {},
  })
  const exclusions = []
  if (!(agent.invocable ?? agent.available)) exclusions.push('unavailable')
  if (options.requireVerified && !options.isRecentlyVerified(agent)) exclusions.push('unverified')
  if (requirements.domains.some(domain => !capabilities.domains.includes(domain))) {
    exclusions.push('domain')
  }
  if (requirements.inputTypes.some(type => !capabilities.inputTypes.includes(type))) {
    exclusions.push('input-type')
  }
  if (requirements.outputTypes.some(type => !capabilities.outputTypes.includes(type))) {
    exclusions.push('output-type')
  }
  if (requirements.toolClasses.some(type => !capabilities.toolClasses.includes(type))) {
    exclusions.push('tool-class')
  }
  if (!capabilities.permissionModes.includes(requirements.permissionMode)
      && !(options.allowReadOnlyPeer && requirements.permissionMode === 'workspace-write'
        && capabilities.permissionModes.includes('read-only'))) {
    exclusions.push('permission')
  }
  if (exceedsBand(capabilities.latencyBand, requirements.maxLatencyBand)) {
    exclusions.push('latency')
  }
  if (exceedsBand(capabilities.costBand, requirements.maxCostBand)) exclusions.push('cost')
  if (capabilities.contextLimitChars < requirements.minContextChars) exclusions.push('context')
  if (requirements.resumableRequired && !capabilities.resumable) exclusions.push('resumability')
  const evidence = evidenceFor(agent.kind, requirements, options.fitMatrix)
  const coverageScore = 50
    + requirements.domains.filter(domain => capabilities.domains.includes(domain)).length * 5
    + requirements.inputTypes.filter(type => capabilities.inputTypes.includes(type)).length * 3
    + requirements.outputTypes.filter(type => capabilities.outputTypes.includes(type)).length * 2
    + requirements.toolClasses.filter(type => capabilities.toolClasses.includes(type)).length * 2
  const evidenceScore = evidence ? Math.round(evidence.score * evidence.confidence) : 0
  return Object.freeze({
    kind: agent.kind,
    eligible: exclusions.length === 0,
    score: Math.max(0, Math.min(1000, coverageScore + evidenceScore)),
    exclusions: Object.freeze(exclusions),
    ...(evidence ? { evidence } : {}),
  })
}

function targetList(value) {
  if (!Array.isArray(value)) throw routingError('LOCAL_MESSAGE_TARGET_REQUIRED')
  if (value.length > MAX_ROUTING_CANDIDATES) {
    throw routingError('LOCAL_MESSAGE_TARGET_LIMIT', { count: value.length })
  }
  const targets = value.map((raw) => {
    const kind = cleanInline(raw, 40)
    if (typeof raw !== 'string' || raw !== kind || !isSupportedAgentKind(kind)) {
      throw routingError('LOCAL_MESSAGE_TARGET_UNKNOWN', { kind })
    }
    return kind
  })
  if (new Set(targets).size !== targets.length) {
    throw routingError('LOCAL_MESSAGE_TARGET_DUPLICATE')
  }
  return targets
}

function errorForExclusions(candidate) {
  if (candidate.exclusions.includes('unavailable')) {
    return routingError('LOCAL_AGENT_UNAVAILABLE', { kind: candidate.kind, reason: 'unavailable' })
  }
  return routingError('LOCAL_AGENT_CAPABILITY_MISMATCH', {
    kind: candidate.kind,
    reason: candidate.exclusions[0] || 'capability',
  })
}

function normalizeRoutingCandidate(value) {
  const fields = new Set(['eligible', 'exclusions', 'kind', 'score'])
  if (plainRecord(value?.evidence)) fields.add('evidence')
  if (!exactKeys(value, fields)) return null
  const kind = cleanInline(value.kind, 40)
  if (!isSupportedAgentKind(kind) || typeof value.eligible !== 'boolean'
      || !Number.isSafeInteger(value.score) || value.score < 0 || value.score > 1000
      || !Array.isArray(value.exclusions) || value.exclusions.length > EXCLUSION_REASONS.size
      || new Set(value.exclusions).size !== value.exclusions.length
      || value.exclusions.some(reason => !EXCLUSION_REASONS.has(reason))) return null
  let evidence
  if (Object.hasOwn(value, 'evidence')) {
    const input = value.evidence
    const evidenceFields = new Set(['confidence', 'matrixVersion', 'sampleSize', 'score'])
    if (!exactKeys(input, evidenceFields) || !PUBLIC_ID.test(String(input.matrixVersion || ''))
        || !Number.isFinite(input.score) || input.score < 0 || input.score > 100
        || !Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1
        || !Number.isSafeInteger(input.sampleSize) || input.sampleSize < 1) return null
    evidence = { ...input }
  }
  return {
    kind,
    eligible: value.eligible,
    score: value.score,
    exclusions: [...value.exclusions],
    ...(evidence ? { evidence } : {}),
  }
}

function normalizeRoutingDecision(value) {
  const input = plainRecord(value)
  const fields = new Set([
    'candidates', 'evidenceVersion', 'mode', 'rationale', 'requirements',
    'selectedKinds', 'version',
  ])
  if (!exactKeys(input, fields) || input.version !== ROUTING_DECISION_VERSION
      || !ROUTING_MODES.has(input.mode) || !RATIONALES.has(input.rationale)
      || (input.evidenceVersion && !PUBLIC_ID.test(input.evidenceVersion))) return null
  let requirements
  try { requirements = normalizeRoutingRequirements(input.requirements) } catch { return null }
  let selectedKinds
  try { selectedKinds = targetList(input.selectedKinds) } catch { return null }
  const candidates = Array.isArray(input.candidates) && input.candidates.length <= MAX_ROUTING_CANDIDATES
    ? input.candidates.map(normalizeRoutingCandidate)
    : []
  if (!selectedKinds.length || candidates.length !== input.candidates.length
      || candidates.some(candidate => !candidate)
      || new Set(candidates.map(candidate => candidate.kind)).size !== candidates.length
      || selectedKinds.some(kind => !candidates.some(candidate => (
        candidate.kind === kind && candidate.eligible
      )))) return null
  return {
    version: ROUTING_DECISION_VERSION,
    mode: input.mode,
    requirements,
    candidates,
    selectedKinds,
    rationale: input.rationale,
    evidenceVersion: input.evidenceVersion,
  }
}

class AgentRouter {
  constructor(options = {}) {
    this.attachmentSupport = options.attachmentSupport || (() => ({}))
    this.fitMatrix = normalizeFitMatrix(options.fitMatrix)
    this.isRecentlyVerified = options.isRecentlyVerified || (agent => agent.recentlyVerified === true)
  }

  route({ agents, group, input, mode, inputTypes, minContextChars }) {
    const routingMode = input.routingMode == null ? 'explicit' : String(input.routingMode)
    if (!ROUTING_MODES.has(routingMode)) {
      throw routingError('LOCAL_AGENT_ROUTING_MODE_INVALID')
    }
    const requestedTargets = targetList(input.targetKinds == null ? [] : input.targetKinds)
    const effectiveMode = requestedTargets.length ? 'explicit' : routingMode
    if (effectiveMode === 'automatic' && (
      (Array.isArray(input.mentionedAgentKinds) && input.mentionedAgentKinds.length)
      || (Array.isArray(input.skillHints) && input.skillHints.length)
      || (Array.isArray(input.knowledgeBaseHints) && input.knowledgeBaseHints.length)
    )) {
      throw routingError('LOCAL_AGENT_ROUTING_CONTEXT_CONFLICT')
    }
    const approvedKinds = targetList(group.agentKinds)
    const explicitTargets = effectiveMode === 'explicit' && !requestedTargets.length
      ? approvedKinds
      : requestedTargets
    const explicitReadOnlyTargets = effectiveMode === 'explicit'
      && explicitTargets.length > 0
      && explicitTargets.every(kind => isCodeReviewAgentKind(kind))
    const detected = new Map((Array.isArray(agents) ? agents : []).map(agent => [agent.kind, agent]))
    const permissionTargets = effectiveMode === 'explicit' ? explicitTargets : approvedKinds
    const targetWriteSupport = permissionTargets.map((kind) => {
      const candidate = detected.get(kind)
      return (effectiveMode === 'explicit' || (candidate
        && (candidate.invocable ?? candidate.available) && this.isRecentlyVerified(candidate)))
      && agentRuntimeCapabilities(kind, {
        agent: detected.get(kind),
        attachmentSupport: this.attachmentSupport(kind),
      }).permissionModes.includes('workspace-write')
    })
    const writePermissionCompatible = effectiveMode === 'explicit'
      ? targetWriteSupport.every(Boolean)
      : targetWriteSupport.some(Boolean)
    const permissionMode = explicitReadOnlyTargets || !writePermissionCompatible
      ? 'read-only'
      : group.allowWrite === true ? 'workspace-write' : 'read-only'
    const requirements = normalizeRoutingRequirements(input.routingRequirements, {
      domains: effectiveMode === 'automatic' ? ['general'] : [],
      inputTypes,
      outputTypes: ['text'],
      permissionMode,
      minContextChars,
      collaboration: mode === 'auto' ? 'required' : 'none',
    })
    if (explicitTargets.some(kind => !approvedKinds.includes(kind))) {
      const kind = explicitTargets.find(target => !approvedKinds.includes(target))
      throw routingError('LOCAL_MESSAGE_TARGET_OUT_OF_GROUP', { kind })
    }
    const allowReadOnlyPeer = effectiveMode === 'automatic'
      && requirements.collaboration === 'required'
      && requirements.permissionMode === 'workspace-write'
      && input.routingRequirements?.permissionMode == null
    const candidates = approvedKinds.map((kind) => evaluateCandidate(
      detected.get(kind) || { kind, available: false },
      requirements,
      { attachmentSupport: this.attachmentSupport, fitMatrix: this.fitMatrix,
        requireVerified: effectiveMode === 'automatic', isRecentlyVerified: this.isRecentlyVerified,
        allowReadOnlyPeer },
    ))
    let selectedKinds
    if (effectiveMode === 'explicit') {
      selectedKinds = explicitTargets
      for (const kind of selectedKinds) {
        const candidate = candidates.find(item => item.kind === kind)
        if (!candidate?.eligible) throw errorForExclusions(candidate || {
          kind, exclusions: ['unavailable'],
        })
      }
    } else {
      const eligible = candidates.filter(candidate => candidate.eligible)
        .sort((left, right) => right.score - left.score
          || approvedKinds.indexOf(left.kind) - approvedKinds.indexOf(right.kind))
      const requiredCount = requirements.collaboration === 'required' ? 2 : 1
      if (eligible.length < requiredCount) {
        const unverified = candidates.filter(candidate => candidate.exclusions.length === 1
          && candidate.exclusions[0] === 'unverified').length
        if (eligible.length + unverified >= requiredCount) {
          throw routingError('LOCAL_AGENT_ROUTING_UNVERIFIED', { eligibleCount: eligible.length, requiredCount })
        }
        throw routingError(
          requiredCount > 1 ? 'LOCAL_AUTO_AGENT_COUNT' : 'LOCAL_AGENT_ROUTING_NO_MATCH',
          { eligibleCount: eligible.length, requiredCount },
        )
      }
      selectedKinds = eligible.slice(0, requiredCount).map(candidate => candidate.kind)
      if (allowReadOnlyPeer) {
        const canWrite = kind => agentRuntimeCapabilities(kind, {
          agent: detected.get(kind), attachmentSupport: this.attachmentSupport(kind),
        }).permissionModes.includes('workspace-write')
        if (!selectedKinds.some(canWrite)) {
          const writer = eligible.find(candidate => canWrite(candidate.kind))
          if (!writer) throw routingError('LOCAL_AGENT_ROUTING_NO_MATCH', { eligibleCount: eligible.length, requiredCount })
          selectedKinds[selectedKinds.length - 1] = writer.kind
        }
      }
    }
    const selectedHasEvidence = selectedKinds.some(kind => (
      candidates.find(candidate => candidate.kind === kind)?.evidence
    ))
    const decision = normalizeRoutingDecision({
      version: ROUTING_DECISION_VERSION,
      mode: effectiveMode,
      requirements,
      candidates,
      selectedKinds,
      rationale: effectiveMode === 'explicit'
        ? 'explicit-user-selection'
        : (selectedHasEvidence ? 'evidence-ranked-team' : 'smallest-suitable-team'),
      evidenceVersion: selectedHasEvidence ? this.fitMatrix.version : '',
    })
    if (!decision) throw routingError('LOCAL_AGENT_ROUTING_DECISION_INVALID')
    return Object.freeze(decision)
  }
}

module.exports = {
  AgentRouter,
  MIN_FIT_MATRIX_CONFIDENCE,
  MIN_FIT_MATRIX_SAMPLE_SIZE,
  ROUTING_DECISION_VERSION,
  normalizeFitMatrix,
  normalizeRoutingDecision,
  normalizeRoutingRequirements,
  routingError,
}

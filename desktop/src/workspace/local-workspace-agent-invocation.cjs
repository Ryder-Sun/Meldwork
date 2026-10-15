const { createHash, randomUUID } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { parseLenientTaskDecision } = require('../collaboration/task-decision.cjs')
const {
  agentRuntimeCapabilities,
  isCodeReviewAgentKind,
  requireTerminalAgentResult,
} = require('../agents/agent-runtime-contract.cjs')
const {
  nextSessionMeta,
  normalizeOutcomeRefs,
  normalizeSessionMeta,
} = require('../runs/run-harness.cjs')
const {
  canonicalJson,
  normalizeContextPackId,
} = require('../collaboration/context-pack-records.cjs')
const {
  defaultAgentLabel,
  HERMES_WORKSPACE_ACP_ENABLED,
  MAX_MESSAGE_ATTACHMENTS,
  abortableOperation,
  agentStoppedError,
  attachmentType,
  cleanText,
  cleanProgressSteps,
  normalizeAttachmentMetadata,
  parseAutoReply,
  settleWithin,
} = require('./local-workspace-inputs.cjs')
const { assertLocalSkillExecution } = require('../skills/local-skill-contract.cjs')
const { directPromptFor } = require('./local-workspace-context.cjs')
const { outboundWirePayloadBytes } = require('../collaboration/outbound-payload.cjs')
const { processRunScheduler } = require('../runs/run-scheduler.cjs')
const {
  cleanupStagedAgentInputs,
  stageAgentInputs,
  stagedAgentInputPrompt,
} = require('../agents/agent-input-staging.cjs')

const MAX_INHERITED_TASK_IDS = 64
const MAX_ISOLATED_PROMPT_BYTES = 4 * 1024 * 1024
const OUTCOME_REF_FIELDS = Object.freeze([
  'artifactIds',
  'evidenceIds',
  'findingIds',
  'reviewerFindingIds',
  'adoptionIds',
  'workflowOutcomeRefs',
])

function extractReportedOutputPaths(text) {
  if (typeof text !== 'string') return []
  const matches = text.match(/(?:\/(?:Users|home|tmp|private\/tmp)\/[^\s"'<>`\]\[)]+)/g) || []
  return [...new Set(matches.map(value => value.replace(/[.,;:!?]+$/, '')))]
}

function mergeOutcomeRefs(sources, options = {}) {
  const merged = {}
  const seen = new Map(OUTCOME_REF_FIELDS.map(field => [field, new Set()]))
  for (const source of sources) {
    const normalized = normalizeOutcomeRefs(
      source,
      options.strict === true ? { strict: true } : {},
    )
    for (const field of OUTCOME_REF_FIELDS) {
      if (!Array.isArray(normalized[field])) continue
      for (const value of normalized[field]) {
        const key = field === 'workflowOutcomeRefs' ? canonicalJson(value) : value
        if (seen.get(field).has(key)) continue
        seen.get(field).add(key)
        merged[field] = [...(merged[field] || []), value]
      }
    }
  }
  // Each source is validated strictly; later sources only fill remaining field capacity.
  return normalizeOutcomeRefs(merged)
}

const OPERATION_ID = /^[A-Za-z0-9._:-]{1,120}$/
const SHA256 = /^[a-f0-9]{64}$/
const V4_PHASES = new Set([
  'proposal', 'discussion', 'challenge', 'work', 'synthesis', 'verification',
])
const V4_RECEIPT_MARKER_PREFIX = '[[MELDWORK_COLLABORATION'
const V4_RECEIPT_MARKER = /\s*\[\[MELDWORK_COLLABORATION(?:_JSON)?:([\s\S]*?)\]\]/i
const V4_RECEIPT_BLOCK = /\s*\[\[MELDWORK_COLLABORATION(?:_JSON)?\]\]([\s\S]*?)\[\[\/MELDWORK_COLLABORATION(?:_JSON)?\]\]/i
const LEGACY_CONSENSUS_MARKER = /^\s*\[\[MELDWORK_CONSENSUS:(?:agree|continue)\]\]\s*$/gim
const V4_RECEIPT_MAX_TEXT = 800
const V4_RECEIPT_MAX_ITEMS = 16
const V4_RECEIPT_MAX_BYTES = 16 * 1024

function isV4InternalProtocolCommentary(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text || text.length > 4000 || /\[\[MELDWORK_COLLABORATION/i.test(text)) return false
  const mentionsControl = /(?:\breceipt\b|structured marker|MELDWORK framework|ExitPlanMode|\u7ed3\u6784\u5316\s*receipt|receipt\s*\u6807\u8bb0)/i.test(text)
  const describesInternalProcess = /(?:coordination\/self-introduction|not a code implementation task|no plan file|implementation planning|plan mode|waiting for (?:the )?(?:next|subsequent).*(?:phase|instruction)|\u534f\u4f5c\u534f\u8c03\u7c7b\u6587\u672c\u4ea7\u51fa|\u975e\u4ee3\u7801\u5b9e\u73b0\u4efb\u52a1|\u6267\u884c\u8ba1\u5212\u6d41\u7a0b|\u4e0d\u8c03\u7528\s*ExitPlanMode|\u672c\u8f6e\u4ea4\u4ed8|\u7b49\u5f85\u540e\u7eed.*(?:\u9636\u6bb5|\u6307\u4ee4))/i.test(text)
  return mentionsControl && describesInternalProcess
}

function stripV4InternalProtocolTail(value) {
  const paragraphs = String(value || '').trim().split(/\n{2,}/)
  while (paragraphs.length && isV4InternalProtocolCommentary(paragraphs.at(-1))) {
    paragraphs.pop()
  }
  return paragraphs.join('\n\n').trim()
}

function boundedReceiptText(value, limit = V4_RECEIPT_MAX_TEXT) {
  if (typeof value !== 'string' || value.trim().length > limit) return ''
  const text = cleanText(value, limit)
  return text && !text.includes('\u0000') ? text : ''
}

function boundedReceiptList(value) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > V4_RECEIPT_MAX_ITEMS) {
    throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
  }
  const result = value.map(item => boundedReceiptText(item))
  if (result.some(item => !item)) throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
  return result
}

// A decision that is still unreadable after normalisation is treated as no
// decision: the orchestrator then asks the owner again instead of failing
// the Agent and removing it from the discussion.
function leniencyTaskDecision(value, summary) {
  try {
    return { taskDecision: parseLenientTaskDecision(value, { fallbackReason: summary }) }
  } catch {
    return {}
  }
}

function parseV4CollaborationReceiptStrict(result, required = false, expectedPhase = '', options = {}) {
  const rawText = typeof result?.text === 'string' ? result.text : ''
  if (!required) return { text: rawText, collaboration: null }
  let text = rawText
  let receipt = result?.collaboration
  // Natural discussion turns are free-form answers; a slightly malformed
  // receipt there must not fail the turn and end the discussion. Strict
  // phased-V4 receipts keep failing closed.
  const lenient = expectedPhase === 'discussion'
  let trailingVisibleText = ''
  let unreadableReceipt = false
  const block = rawText.match(V4_RECEIPT_BLOCK) || rawText.match(V4_RECEIPT_MARKER)
  if (block) {
    const markerStart = Number(block.index) || 0
    const suffix = rawText.slice(markerStart + block[0].length).trim()
    // A closing code fence after the receipt is formatting, not content.
    if (suffix && !isV4InternalProtocolCommentary(suffix) && !/^[\s`~]*$/.test(suffix)) {
      if (!lenient) throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
      trailingVisibleText = suffix
    }
    const encoded = String(block[1] || '').trim()
    if (!encoded || Buffer.byteLength(encoded) > V4_RECEIPT_MAX_BYTES) {
      if (!lenient) throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
      unreadableReceipt = true
    }
    if (!unreadableReceipt) {
      try {
        let parsed
        try {
          parsed = JSON.parse(encoded)
        } catch (error) {
          if (!lenient) throw error
          // Common hand-written slips: smart quotes and trailing commas.
          parsed = JSON.parse(encoded
            .replace(/[\u201c\u201d]/g, '"')
            .replace(/[\u2018\u2019]/g, "'")
            .replace(/,\s*([}\]])/g, '$1'))
        }
        if (receipt != null && canonicalJson(receipt) !== canonicalJson(parsed)) {
          throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_MISMATCH')
        }
        receipt = parsed
      } catch (error) {
        if (error?.message === 'LOCAL_RUN_COLLABORATION_RECEIPT_MISMATCH') throw error
        if (!lenient) throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
        unreadableReceipt = true
      }
    }
    text = rawText.slice(0, markerStart) + (trailingVisibleText ? `\n\n${trailingVisibleText}` : '')
  } else if (/\[\[MELDWORK_COLLABORATION/i.test(rawText)) {
    if (!lenient) throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
    unreadableReceipt = true
    text = rawText.slice(0, rawText.search(/\[\[MELDWORK_COLLABORATION/i))
  }
  if (unreadableReceipt) receipt = null
  if (lenient && receipt && typeof receipt === 'object' && !Array.isArray(receipt)) {
    // Keep only discussion fields and fill a missing summary, so an extra key
    // or a long summary does not discard the Agent's whole contribution.
    const decisionReason = typeof receipt.taskDecision?.reason === 'string'
      ? receipt.taskDecision.reason
      : ''
    const summary = typeof receipt.summary === 'string' && receipt.summary.trim()
      ? receipt.summary.trim().slice(0, V4_RECEIPT_MAX_TEXT)
      : (decisionReason.trim().slice(0, V4_RECEIPT_MAX_TEXT) || 'Discussion contribution')
    receipt = {
      version: 1,
      phase: 'discussion',
      summary,
      ...(receipt.taskDecision != null ? { taskDecision: receipt.taskDecision } : {}),
    }
  }
  text = stripV4InternalProtocolTail(
    text.replace(LEGACY_CONSENSUS_MARKER, '').replace(/\n{3,}/g, '\n\n'),
  )
  if (receipt == null && options.allowMissingV4Receipt === true && text) {
    return { text, collaboration: null }
  }
  if (receipt == null && expectedPhase === 'proposal'
      && options.allowMissingProposalReceipt === true && text) {
    receipt = {
      version: 1,
      phase: 'proposal',
      summary: 'The Agent returned a visible proposal without a structured receipt.',
      capabilities: ['Delivered a user-facing proposal'],
      intendedWork: ['Addressed the current user task'],
      deliverables: ['Visible Agent response'],
      dependencies: [],
    }
  }
  if (receipt == null) throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_REQUIRED')
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
  }
  try {
    if (Buffer.byteLength(canonicalJson(receipt)) > V4_RECEIPT_MAX_BYTES) {
      throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
    }
  } catch (error) {
    if (error?.message === 'LOCAL_RUN_COLLABORATION_RECEIPT_INVALID') throw error
    throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
  }
  const phase = String(expectedPhase || '')
  const summary = boundedReceiptText(receipt.summary)
  const allowed = new Set([
    'version', 'phase', 'summary',
    ...(phase === 'discussion' ? ['taskDecision'] : []),
    ...(['challenge', 'verification'].includes(phase) ? ['verdict'] : []),
    ...(phase === 'proposal'
      ? ['capabilities', 'intendedWork', 'deliverables', 'dependencies'] : []),
    ...(phase === 'challenge'
      ? [
          'proposedAssignments', 'finalizerKind', 'verifierKinds',
          'supportedPlanHash', 'agreeToPlan',
        ] : []),
    ...(phase === 'work' ? ['workItemId', 'deliverables'] : []),
    ...(phase === 'synthesis' ? ['resolvedIssueIds'] : []),
  ])
  if (!V4_PHASES.has(phase) || !summary
      || Object.keys(receipt).some(key => !allowed.has(key))
      || (receipt.version != null && receipt.version !== 1)
      || (receipt.phase != null && receipt.phase !== phase)) {
    throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
  }
  if (['challenge', 'verification'].includes(phase)
      && !['support', 'contradict'].includes(receipt.verdict)) {
    throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
  }
  const resolvedIssueIds = phase === 'synthesis'
    ? boundedReceiptList(receipt.resolvedIssueIds)
    : null
  if (phase === 'synthesis' && !Array.isArray(receipt.resolvedIssueIds)) {
    throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
  }
  if (phase === 'challenge' && receipt.supportedPlanHash != null
      && !SHA256.test(String(receipt.supportedPlanHash))) {
    throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
  }
  const proposalList = (field, requireItem = false) => {
    if (!Array.isArray(receipt[field])) {
      throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
    }
    const list = boundedReceiptList(receipt[field])
    if (requireItem && list.length === 0) {
      throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
    }
    return list
  }
  const boundedList = value => {
    if (value == null) return []
    if (!Array.isArray(value) || value.length > V4_RECEIPT_MAX_ITEMS) {
      throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
    }
    const result = value.map(item => boundedReceiptText(item))
    if (result.some(item => !item)) throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
    return result
  }
  const normalized = {
    version: 1,
    phase,
    summary,
    ...(phase === 'discussion' && receipt.taskDecision != null
      ? leniencyTaskDecision(receipt.taskDecision, summary) : {}),
    ...(['challenge', 'verification'].includes(phase) ? { verdict: receipt.verdict } : {}),
    ...(phase === 'proposal' ? {
      capabilities: proposalList('capabilities', true),
      intendedWork: proposalList('intendedWork', true),
      deliverables: proposalList('deliverables', true),
      dependencies: proposalList('dependencies'),
    } : {}),
    ...(phase === 'challenge' ? {
      ...(Array.isArray(receipt.proposedAssignments)
        ? {
            proposedAssignments: receipt.proposedAssignments.map(assignment => (
              assignment && typeof assignment === 'object' && !Array.isArray(assignment)
                && assignment.role === 'finalizer'
                ? { ...assignment, role: 'integrator' }
                : assignment
            )),
          }
        : {}),
      ...(receipt.finalizerKind ? { finalizerKind: boundedReceiptText(receipt.finalizerKind, 120) } : {}),
      ...(Array.isArray(receipt.verifierKinds) ? { verifierKinds: boundedList(receipt.verifierKinds) } : {}),
      ...(receipt.supportedPlanHash ? { supportedPlanHash: receipt.supportedPlanHash } : {}),
      ...(typeof receipt.agreeToPlan === 'boolean' ? { agreeToPlan: receipt.agreeToPlan } : {}),
    } : {}),
    ...(phase === 'work' ? {
      ...(receipt.workItemId ? { workItemId: boundedReceiptText(receipt.workItemId, 120) } : {}),
      deliverables: boundedList(receipt.deliverables),
    } : {}),
    ...(phase === 'synthesis' ? { resolvedIssueIds } : {}),
  }
  return { text, collaboration: Object.freeze(JSON.parse(canonicalJson(normalized))) }
}

function parseV4CollaborationReceipt(result, required = false, expectedPhase = '', options = {}) {
  try {
    return parseV4CollaborationReceiptStrict(result, required, expectedPhase, options)
  } catch (error) {
    const code = String(error?.message || '')
    if (expectedPhase !== 'proposal'
        || options.allowMissingProposalReceipt !== true
        || !['LOCAL_RUN_COLLABORATION_RECEIPT_INVALID', 'LOCAL_RUN_COLLABORATION_RECEIPT_REQUIRED']
          .includes(code)) {
      throw error
    }
    const rawText = typeof result?.text === 'string' ? result.text : ''
    const markerIndex = rawText.search(/\[\[MELDWORK_COLLABORATION/i)
    const visibleText = (markerIndex >= 0 ? rawText.slice(0, markerIndex) : rawText)
      .replace(LEGACY_CONSENSUS_MARKER, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    if (!visibleText) throw error
    return {
      text: visibleText,
      collaboration: Object.freeze({
        version: 1,
        phase: 'proposal',
        summary: 'The Agent returned a visible proposal without a valid structured receipt.',
        capabilities: ['Delivered a user-facing proposal'],
        intendedWork: ['Addressed the current user task'],
        deliverables: ['Visible Agent response'],
        dependencies: [],
      }),
    }
  }
}

function attachInvocationFailure(error, input) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return error
  const existing = error.invocationFailure && typeof error.invocationFailure === 'object'
    ? error.invocationFailure
    : {}
  Object.defineProperty(error, 'invocationFailure', {
    value: Object.freeze({
      outcomeCertainty: existing.outcomeCertainty || input.outcomeCertainty,
      sideEffectsPossible: existing.sideEffectsPossible === true || input.sideEffectsPossible === true,
      operationId: existing.operationId || input.operationId,
      idempotencyMode: existing.idempotencyMode || input.idempotencyMode,
    }),
    enumerable: false,
    configurable: true,
  })
  return error
}

function isolatedInvocationContext(context) {
  if (!['isolated', 'frozen'].includes(context?.sessionPolicy)
      && !(context?.v4 === true && typeof context.promptOverride === 'string')) return null
  const promptOverride = typeof context.promptOverride === 'string'
    ? context.promptOverride
    : ''
  const contextPackId = normalizeContextPackId(context.contextPackId)
  if (!promptOverride || promptOverride.includes('\u0000')
      || Buffer.byteLength(promptOverride) > MAX_ISOLATED_PROMPT_BYTES
      || !contextPackId) {
    throw new Error('LOCAL_RUN_ISOLATED_CONTEXT_INVALID')
  }
  return {
    promptOverride,
    contextPackId,
    policy: ['isolated', 'frozen'].includes(context?.sessionPolicy) ? context.sessionPolicy : '',
  }
}

function createdSessionProvenance(group, taskId, stateless = false) {
  if (stateless) {
    return {
      scope: 'none', reuse: false, origin: 'none', originTaskId: null,
      inheritedTaskIds: [], completeness: 'complete',
    }
  }
  return {
    scope: 'conversation',
    reuse: false,
    origin: 'created',
    originTaskId: taskId || null,
    inheritedTaskIds: [],
    completeness: 'complete',
  }
}

function provenanceMeta(provenance) {
  if (provenance.scope === 'unknown-legacy') {
    return {
      sessionScope: 'unknown-legacy',
      originTaskId: '',
      inheritedTaskIds: [],
      provenanceCompleteness: 'unknown-legacy',
    }
  }
  if (provenance.scope === 'none') return {}
  return {
    sessionScope: provenance.scope,
    originTaskId: provenance.originTaskId || '',
    inheritedTaskIds: provenance.inheritedTaskIds || [],
    provenanceCompleteness: provenance.completeness,
  }
}

function completedSessionMeta(meta, provenance, taskId, usage) {
  let inheritedTaskIds = [...(provenance.inheritedTaskIds || [])]
  let completeness = provenance.completeness
  if (provenance.scope === 'conversation' && taskId
      && taskId !== provenance.originTaskId && !inheritedTaskIds.includes(taskId)) {
    inheritedTaskIds.push(taskId)
    if (inheritedTaskIds.length > MAX_INHERITED_TASK_IDS) {
      inheritedTaskIds = inheritedTaskIds.slice(-MAX_INHERITED_TASK_IDS)
      completeness = 'partial'
    }
  }
  return nextSessionMeta(meta, {
    ...usage,
    ...provenanceMeta({ ...provenance, inheritedTaskIds, completeness }),
  })
}

function matchesResumedPermission(request, resumedGate) {
  if (!request || !resumedGate?.request) return false
  try {
    if (canonicalJson(request) !== canonicalJson(resumedGate.request)) return false
  } catch {
    return false
  }
  const selected = request.options?.find(option => option.optionId === resumedGate.optionId)
  if (!selected) return false
  return resumedGate.status === 'approved'
    ? selected.kind.startsWith('allow_')
    : selected.kind.startsWith('reject_')
}

function sha256(value) {
  return createHash('sha256').update(String(value || '')).digest('hex')
}

function permissionContinuationRequestId(requestHash, binding) {
  return sha256(canonicalJson({
    requestHash,
    sessionRefHash: binding.sessionRefHash,
    sessionProvenanceHash: binding.sessionProvenanceHash,
  }))
}

function deliveredPackedContext(packedContext, promptMode) {
  if (promptMode !== 'continuation') return packedContext
  return {
    ...packedContext,
    sourceMessageIds: packedContext.continuationSourceMessageIds || [],
    sourceEntries: packedContext.continuationSourceEntries || [],
    context: packedContext.continuationContext || {
      includedCount: 0,
      omittedCount: 0,
      charCount: 0,
    },
  }
}

function withCollaborationPackage(packedContext, collaborationPackage) {
  if (!collaborationPackage) return packedContext
  const text = typeof collaborationPackage.text === 'string'
    ? collaborationPackage.text
    : ''
  if (!text || text.length > 128000 || text.includes('\u0000')) {
    throw new Error('LOCAL_RUN_COLLABORATION_PACKAGE_INVALID')
  }
  return { ...packedContext, collaborationText: text }
}

function contextSourceProof(contextPack) {
  const sources = (Array.isArray(contextPack?.sources) ? contextPack.sources : []).map(source => ({
    type: source.type,
    sourceId: source.sourceId,
    contentHash: source.contentHash,
    targetKinds: source.targetKinds,
    captureMode: source.captureMode,
  }))
  return {
    sourceCount: sources.length,
    sourceHash: sha256(canonicalJson(sources)),
  }
}

function assertRequiredContextFits(packedContext) {
  if (!packedContext?.requiredContextOverflow) return
  const error = new Error('LOCAL_RUN_REQUIRED_CONTEXT_OVERFLOW')
  error.code = 'LOCAL_RUN_REQUIRED_CONTEXT_OVERFLOW'
  error.contextOverflow = { ...packedContext.requiredContextOverflow }
  throw error
}

function connectorSessionBinding(sessionRef, sessionProvenance) {
  const stableProvenance = {
    scope: String(sessionProvenance?.scope || 'none'),
    originTaskId: String(sessionProvenance?.originTaskId || ''),
    inheritedTaskIds: Array.isArray(sessionProvenance?.inheritedTaskIds)
      ? [...sessionProvenance.inheritedTaskIds]
      : [],
    completeness: String(sessionProvenance?.completeness || 'complete'),
  }
  return {
    sessionRefHash: sha256(sessionRef),
    sessionProvenanceHash: sha256(canonicalJson(stableProvenance)),
  }
}

class LocalWorkspaceAgentInvocation {
  constructor(options) {
    this.state = options.state
    this.detectedAgents = options.detectedAgents
    this.activeRuns = options.activeRuns
    this.runAgentTimeoutMs = options.runAgentTimeoutMs
    this.runAgentToolTimeoutMs = options.runAgentToolTimeoutMs
    this.runAbortGraceMs = options.runAbortGraceMs
    this.defaultYolo = options.defaultYolo !== false
    this.captureAgentOutputs = options.captureAgentOutputs
    this.captureArtifactOutputs = options.captureArtifactOutputs
    this.captureAgentOutcomeDescriptors = options.captureAgentOutcomeDescriptors
    this.runAgent = options.runAgent
    this.importAgentOutputs = options.importAgentOutputs
    this.recordAgentOutcomes = options.recordAgentOutcomes
    this.sessionKey = options.sessionKey
    this.sessionState = options.sessionState
    this.openClawSessionRef = options.openClawSessionRef
    this.save = options.save
    this.packedPromptContext = options.packedPromptContext
    this.ensureRunHarness = options.ensureRunHarness
    this.emitRunEvent = options.emitRunEvent
    this.armAgentSilence = options.armAgentSilence
    this.clearAgentSilence = options.clearAgentSilence
    this.checkpointRun = options.checkpointRun
    this.hasRunLedger = typeof options.hasRunLedger === 'function'
      ? options.hasRunLedger
      : (() => false)
    this.scheduleRunCheckpoint = options.scheduleRunCheckpoint
    this.emitChanged = options.emitChanged
    this.promptFor = options.promptFor
    this.reserveTurnSeq = typeof options.reserveTurnSeq === 'function'
      ? options.reserveTurnSeq
      : null
    this.agentLabel = typeof options.agentLabel === 'function'
      ? options.agentLabel
      : kind => defaultAgentLabel(kind)
    this.persistSessionState = options.persistSessionState
    this.createAttemptContextPack = options.createAttemptContextPack
    this.recordContextDelivery = options.recordContextDelivery
    this.markRuntimeCredential = options.markRuntimeCredential
    this.addMessage = options.addMessage
    this.runScheduler = options.runScheduler || processRunScheduler
    this.registerAgentController = options.registerAgentController
    this.unregisterAgentController = options.unregisterAgentController
    this.requestHumanGate = options.requestHumanGate
    this.completeHumanGateContinuation = options.completeHumanGateContinuation
    this.connectorRuntime = options.connectorRuntime || null
    this.attachmentSupport = options.attachmentSupport || (() => ({}))
    this.activeAgentSnapshots = new Map()
  }

  commitSessionState(mutator) {
    const state = this.state()
    const previousSessions = { ...state.sessions }
    const previousSessionMeta = { ...state.sessionMeta }
    try {
      const result = mutator(state)
      if (result !== false) this.save()
      return result
    } catch (error) {
      state.sessions = previousSessions
      state.sessionMeta = previousSessionMeta
      throw error
    }
  }

  async invoke(group, kind, mode, signal, threadRootId = '', context = {}) {
    // Group turns get a per-topic dispatch number before anything awaits, so
    // concurrent dispatches keep their call order. Batch dispatchers reserve
    // numbers themselves and pass them in.
    const requestedTurnSeq = Number(context.turnSeq)
    const turnSeq = Number.isSafeInteger(requestedTurnSeq) && requestedTurnSeq > 0
      ? requestedTurnSeq
      : (group.conversationType !== 'direct' && threadRootId
        && typeof this.reserveTurnSeq === 'function'
        ? this.reserveTurnSeq(group.id, threadRootId)
        : null)
    if (turnSeq) context = { ...context, turnSeq }
    const activeRun = this.activeRuns.get(group.id)
    const taskId = cleanText(activeRun?.taskId || context.taskId || threadRootId, 120)
    if (!taskId) throw new Error('LOCAL_RUN_TASK_INVALID')
    let workspacePath = group.workdir ? path.resolve(group.workdir) : group.id
    try { workspacePath = fs.realpathSync(workspacePath) } catch { /* runtime validates unavailable directories */ }
    // Direct chats are independent execution surfaces. Scope their scheduler
    // resource to the chat so one writable chat cannot block another Agent.
    const schedulerWorkspaceKey = group.conversationType === 'direct'
      ? `${workspacePath}\u0000direct:${group.id}`
      : workspacePath
    const workspaceKey = createHash('sha256')
      .update(String(schedulerWorkspaceKey))
      .digest('hex')
    const writerKind = cleanText(context.singleWriterKind || context.writerKind, 80)
    const permissionMode = group.allowWrite === true
      && (context.permissionMode == null || context.permissionMode === 'workspace-write')
      && (!writerKind || writerKind === kind)
      && isolatedInvocationContext(context)?.policy !== 'isolated'
      && !isCodeReviewAgentKind(kind)
      ? 'workspace-write' : 'read-only'
    context = { ...context, permissionMode }
    const agentController = new AbortController()
    const registration = { agentRunId: '' }
    let queuedAbortHandler = null
    this.registerAgentController?.(activeRun, kind, registration.agentRunId, agentController)
    if (signal) {
      queuedAbortHandler = () => agentController.abort()
      if (signal.aborted) queuedAbortHandler()
      else signal.addEventListener('abort', queuedAbortHandler, { once: true })
    }
    try {
      return await this.runScheduler.withLease({
        taskId,
        workspaceKey,
        permissionMode,
        signal: agentController.signal,
      }, (lease) => {
        if (signal && queuedAbortHandler) {
          signal.removeEventListener('abort', queuedAbortHandler)
          queuedAbortHandler = null
        }
        return this.invokeLeased(
          group,
          kind,
          mode,
          signal,
          threadRootId,
          context,
          { agentController, registration, lease },
        )
      })
    } finally {
      if (signal && queuedAbortHandler) {
        signal.removeEventListener('abort', queuedAbortHandler)
      }
      this.unregisterAgentController?.(
        activeRun, kind, registration.agentRunId, agentController,
      )
    }
  }

  async invokeLeased(
    group, kind, mode, signal, threadRootId = '', context = {}, invocation = {},
  ) {
    const detected = this.detectedAgents()
    const activeRun = this.activeRuns.get(group.id)
    const candidate = detected.find(item => item.kind === kind)
    const snapshotKey = `${group.id}:${activeRun?.runId || 'active'}:${kind}`
    if (candidate) this.activeAgentSnapshots.set(snapshotKey, { ...candidate })
    const snapshot = this.activeAgentSnapshots.get(snapshotKey)
    const agent = detected.find(item => item.kind === kind && item.available)
      || (activeRun?.targetKinds?.includes(kind)
        && candidate
        && candidate.installed !== false
        && candidate.compatibilityState !== 'incompatible'
        && candidate.credentialState !== 'missing'
        && candidate.availabilitySource !== 'runtime-auth-failure'
        && candidate.availabilitySource !== 'none'
        ? candidate
        : activeRun?.targetKinds?.includes(kind) && !candidate && snapshot
          ? snapshot
          : null)
    if (!agent) throw new Error('LOCAL_AGENT_UNAVAILABLE')
    const reviewOnly = isCodeReviewAgentKind(kind)
    const invocationContext = isolatedInvocationContext(context)
    const isolated = invocationContext?.policy === 'isolated'
    const frozen = invocationContext?.policy === 'frozen'
    const internal = context.internal === true
    if (internal && !isolated) throw new Error('LOCAL_RUN_INTERNAL_CONTEXT_INVALID')
    const requestedPermission = context.permissionMode == null
      ? (group.allowWrite === true ? 'workspace-write' : 'read-only')
      : (context.permissionMode === 'workspace-write' ? 'workspace-write' : 'read-only')
    const writerKind = cleanText(context.singleWriterKind || context.writerKind, 80)
    const writerAllowed = !writerKind || writerKind === kind
    const supportsWorkspaceWrite = agentRuntimeCapabilities(kind, { agent })
      .permissionModes.includes('workspace-write')
    const allowWrite = group.allowWrite === true
      && requestedPermission === 'workspace-write'
      && writerAllowed
      && supportsWorkspaceWrite
      && !reviewOnly
      && !isolated
    const skillInputTypes = new Set(['text'])
    for (const attachment of context.attachmentSnapshots || []) {
      const type = attachmentType(attachment?.mimeType)
      if (type) skillInputTypes.add(type)
    }
    for (const skill of context.skillHints || []) {
      if (!skill?.approvedSkillManifest) continue
      assertLocalSkillExecution(skill.approvedSkillManifest, {
        kind,
        version: agent.resolvedVersion || agent.version,
        inputTypes: [...skillInputTypes],
        capabilities: agent.capabilities,
        permissionMode: allowWrite ? 'workspace-write' : 'read-only',
        credentialIds: [],
      })
    }
    const state = this.state()
    const taskId = cleanText(activeRun?.taskId || context.taskId || threadRootId, 120)
    const round = mode === 'auto' ? (activeRun?.currentRound || 1) : 0
    const responseVersionRootId = cleanText(context.responseVersionRootId, 100)
      || (mode === 'auto'
        ? `response-${sha256(JSON.stringify([
            group.id,
            threadRootId,
            kind,
            round,
            cleanText(context.phase, 40) || 'response',
          ])).slice(0, 48)}`
        : '')
    if (!isolated && !frozen) {
      const requiredContext = this.packedPromptContext(
        group.id, '', threadRootId, context.contextOptions || {},
      )
      assertRequiredContextFits(requiredContext)
    }
    const requestedOperationId = String(context.operationId || '')
    const operationId = OPERATION_ID.test(requestedOperationId)
      ? requestedOperationId
      : `agent-operation-${createHash('sha256').update(JSON.stringify({
          runId: activeRun?.runId || taskId,
          kind,
          mode,
          round,
        })).digest('hex')}`
    const v4AgentSlotBinding = context.v4 === true
      && V4_PHASES.has(context.phase)
      && OPERATION_ID.test(String(context.slotId || ''))
      && SHA256.test(String(context.snapshotHash || ''))
      ? {
          phase: context.phase,
          slotId: context.slotId,
          operationId,
          snapshotHash: context.snapshotHash,
        }
      : null
    const idempotencyMode = agent.idempotencyMode === 'durable' ? 'durable' : 'none'
    // Isolated invocations must see only their approved prompt, so they never
    // resume or persist the conversation's native session.
    const resolvedSession = reviewOnly || isolated
      ? {
          key: this.sessionKey(group.id, kind),
          sessionRef: '',
          sessionMeta: {},
          provenance: createdSessionProvenance(group, taskId, true),
        }
      : this.sessionState(
          group, kind, context.sessionThreadRootId || threadRootId, taskId,
        )
    const key = resolvedSession.key
    const storedSessionRef = String(resolvedSession.sessionRef || '')
    let sessionRef = storedSessionRef
    let sessionMeta = normalizeSessionMeta(resolvedSession.sessionMeta)
    let sessionProvenance = resolvedSession.provenance
    let sessionRotated = resolvedSession.sessionReset === true
    const resumedConnectorGate = ['input', 'permission'].includes(context.resumedGate?.type)
      && context.resumedGate?.request?.source === 'connector'
      ? context.resumedGate
      : null
    let resumedPermission = context.resumedGate?.type === 'permission'
      && !resumedConnectorGate
      ? context.resumedGate
      : null
    // A conversation owns one native session for its lifetime. Rebuild only
    // when the Agent reports that the existing native session is invalid.
    const sessionNeedsRotation = false
    if (resumedPermission) {
      const requestHash = sha256(canonicalJson(resumedPermission.request))
      const persistedBinding = {
        sessionRefHash: resumedPermission.sessionRefHash,
        sessionProvenanceHash: resumedPermission.sessionProvenanceHash,
      }
      const binding = connectorSessionBinding(sessionRef, sessionProvenance)
      if (resumedPermission.requestId !== permissionContinuationRequestId(
        requestHash, persistedBinding,
      ) || resumedPermission.requestHash !== requestHash
          || resumedPermission.sessionProvenanceHash !== binding.sessionProvenanceHash
          || (sessionRef && resumedPermission.sessionRefHash !== binding.sessionRefHash)) {
        throw new Error('LOCAL_RUN_PERMISSION_REQUEST_MISMATCH')
      }
    }
    if (resumedPermission && (!sessionRef || sessionNeedsRotation)) {
      if (context.v4 === true && !allowWrite && sessionRef) resumedPermission = null
      else throw new Error('LOCAL_RUN_PERMISSION_RESUME_UNAVAILABLE')
    }
    if (sessionNeedsRotation) {
      sessionMeta = {}
      sessionProvenance = createdSessionProvenance(group, taskId)
      this.commitSessionState((nextState) => {
        delete nextState.sessions[key]
        delete nextState.sessionMeta[key]
        if (kind === 'openclaw') {
          const generation = randomUUID().replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'session'
          sessionRef = this.openClawSessionRef(
            group, generation, group.conversationType === 'direct' ? '' : taskId,
          )
          nextState.sessions[key] = sessionRef
          nextState.sessionMeta[key] = normalizeSessionMeta(
            provenanceMeta(sessionProvenance),
          )
        } else {
          sessionRef = ''
        }
      })
      sessionRotated = true
    }
    let sessionTransport = sessionRef ? String(sessionMeta.transport || '') : ''
    const hermesNeedsLegacy = kind === 'hermes' && sessionTransport === 'acp'
      && (!HERMES_WORKSPACE_ACP_ENABLED
        || agent.acpAvailable === false
      )
    if (resumedPermission && hermesNeedsLegacy) {
      throw new Error('LOCAL_RUN_PERMISSION_RESUME_UNAVAILABLE')
    }
    if (sessionRef && hermesNeedsLegacy) {
      this.commitSessionState((nextState) => {
        delete nextState.sessions[key]
        delete nextState.sessionMeta[key]
      })
      sessionRef = ''
      sessionMeta = {}
      sessionProvenance = createdSessionProvenance(group, taskId)
      sessionTransport = ''
      sessionRotated = true
    }
    let v4Prompt = invocationContext?.promptOverride || ''
    let v4Delivery = null
    const buildV4Prompt = () => {
      if (context.v4 !== true || typeof context.v4PromptBuilder !== 'function') return v4Prompt
      const built = context.v4PromptBuilder({
        sessionRefHash: sha256(sessionRef),
        sessionProvenanceHash: connectorSessionBinding(sessionRef, sessionProvenance).sessionProvenanceHash,
        sessionRotated,
        hasSession: Boolean(sessionRef),
      })
      if (!built || typeof built.prompt !== 'string' || !built.prompt
          || built.prompt.includes('\u0000') || Buffer.byteLength(built.prompt) > MAX_ISOLATED_PROMPT_BYTES) {
        throw new Error('LOCAL_RUN_V4_PROMPT_INVALID')
      }
      v4Prompt = built.prompt
      v4Delivery = built.delivery || null
      return v4Prompt
    }
    try {
      buildV4Prompt()
    } catch (error) {
      throw attachInvocationFailure(error, {
        outcomeCertainty: 'not_started',
        sideEffectsPossible: false,
        operationId,
        idempotencyMode,
      })
    }
    const knownSessionHistory = group.conversationType === 'direct'
      || sessionProvenance.completeness !== 'unknown-legacy'
    const sameTaskSession = !taskId
      || taskId === sessionMeta.originTaskId
      || (Array.isArray(sessionMeta.inheritedTaskIds) && sessionMeta.inheritedTaskIds.includes(taskId))
    let transcriptAfterKind = knownSessionHistory && !sessionRotated && storedSessionRef && storedSessionRef === sessionRef
      && (!sessionMeta.lastDeliveredMessageId || !sameTaskSession)
      ? kind
      : ''
    // Group Sessions already contain the immutable bootstrap instructions after
    // a successful turn. Keep direct chat unchanged and send only the compact
    // Harness context on later group turns.
    let promptMode = group.conversationType !== 'direct'
      && Boolean(sessionRef)
      && !sessionRotated
      && knownSessionHistory
      && sessionMeta.turns > 0
      ? 'continuation'
      : 'bootstrap'
    const sessionContextOptions = (!isolated && !frozen && promptMode === 'continuation' && sameTaskSession)
      ? { ...(context.contextOptions || {}), afterMessageId: sessionMeta.lastDeliveredMessageId || '' }
      : (context.contextOptions || {})
    let packedContext = isolated || frozen
      ? {
          text: v4Prompt,
          sourceMessageIds: context.snapshotSourceMessageIds || [],
          sourceEntries: context.snapshotSourceEntries || [],
          omittedCount: 0,
          charCount: v4Prompt.length,
          context: {
            includedCount: 0,
            omittedCount: 0,
            charCount: v4Prompt.length,
            contextPackId: invocationContext.contextPackId,
            contextPackState: 'captured',
          },
          currentTaskText: v4Prompt,
          stableText: '(frozen)',
          recentText: '(frozen)',
          continuationText: v4Prompt,
        }
      : this.packedPromptContext(
          group.id, transcriptAfterKind, threadRootId, sessionContextOptions,
        )
    if (!isolated && !frozen) {
      packedContext = withCollaborationPackage(
        packedContext, context.collaborationPackage,
      )
    }
    if (!isolated && !frozen) assertRequiredContextFits(packedContext)
    let deliveredContext = deliveredPackedContext(packedContext, promptMode)
    const harness = this.ensureRunHarness(group, activeRun, threadRootId)
    const harnessRun = harness?.beginAgent(kind, round, deliveredContext.sourceMessageIds, {
      turnSeq: context.turnSeq,
    })
    let deliveryContext = {
      contextPackId: invocationContext?.contextPackId || activeRun?.contextPackId || '',
      deliveryRecordIds: [],
      sessionProvenance,
    }
    if (harnessRun) {
      const liveHarnessRun = harness.current(kind, round, harnessRun.agentRunId)
      if (liveHarnessRun) {
        liveHarnessRun.context = {
          ...deliveredContext.context,
          contextMode: promptMode,
          sessionRotated,
          ...deliveryContext,
        }
      }
      this.emitRunEvent(harnessRun)
      this.armAgentSilence(activeRun, kind, round, harnessRun.agentRunId)
      this.emitChanged()
    }
    const agentController = invocation.agentController instanceof AbortController
      ? invocation.agentController
      : new AbortController()
    const registration = invocation.registration || { agentRunId: '' }
    registration.agentRunId = harnessRun?.agentRunId || ''
    this.registerAgentController?.(
      activeRun, kind, registration.agentRunId, agentController,
    )
    let watchdogTimedOut = false
    let watchdogError = null
    let parentAbortObserved = false
    let agentCallbacksClosed = false
    let watchdogTimer = null
    let watchdogPromise = null
    let watchdogReject = null
    let watchdogLastProgressAt = Date.now()
    // Substantive progress (mapped events, answer text, tool lifecycle,
    // structured progress). Raw process output only proves liveness.
    let watchdogLastSubstantiveAt = Date.now()
    let watchdogPaused = false
    let watchdogEstablished = false
    let watchdogToolActive = false
    let parentAbortHandler = null
    let parentAbortPromise = null
    let capturePromise = null
    let artifactCapturePromise = null
    let runPromise = null
    let importPromise = null
    let outcomeCapturePromise = null
    let attemptProgress = []
    const resolvedGateIds = []
    const pendingPermissionCallbacks = new Set()
    let resumedPermissionUsed = false
    let resumedPermissionError = null
    const startedAt = Date.now()
    // Automatic discussions must make progress between rounds even when an
    // Agent keeps emitting heartbeat events without ever returning a result.
    // Three windows apply: a startup deadline (group runs) until the process
    // shows any sign of life, an inactivity window refreshed by any activity
    // outside tool calls (tool calls use the longer tool window), and a
    // no-progress cap that only streamed text, tool lifecycle, reasoning
    // status and structured progress reset, so a CLI that emits empty
    // heartbeats forever still stops.
    const hardDeadlineAt = mode === 'auto' && Number.isFinite(this.runAgentTimeoutMs)
      && this.runAgentTimeoutMs > 0
      ? startedAt + this.runAgentTimeoutMs
      : Number.POSITIVE_INFINITY
    if (signal) {
      parentAbortPromise = new Promise((_, reject) => {
        parentAbortHandler = () => {
          parentAbortObserved = true
          agentController.abort()
          reject(agentStoppedError())
        }
      })
      parentAbortPromise.catch(() => {})
      if (signal.aborted) parentAbortHandler()
      else signal.addEventListener('abort', parentAbortHandler, { once: true })
    }
    const armWatchdog = () => {
      if (watchdogTimer || watchdogPaused || agentController.signal.aborted
          || !Number.isFinite(this.runAgentTimeoutMs) || this.runAgentTimeoutMs <= 0) return
      const elapsedSinceProgress = Date.now() - watchdogLastProgressAt
      const inactivityTimeoutMs = watchdogToolActive
        ? this.runAgentToolTimeoutMs
        : this.runAgentTimeoutMs
      const inactivityRemainingMs = Math.max(0, inactivityTimeoutMs - elapsedSinceProgress)
      const hardRemainingMs = Math.max(
        0, (watchdogEstablished ? Number.POSITIVE_INFINITY : hardDeadlineAt) - Date.now(),
      )
      // In automatic discussions liveness keeps a turn alive, but not
      // forever: without substantive progress a heartbeat-only CLI stops after
      // three inactivity windows so the remaining participants can continue.
      // Manual and direct turns keep running while the process is active;
      // the user can stop them.
      const stallLimitMs = mode !== 'auto'
        ? Number.POSITIVE_INFINITY
        : watchdogToolActive
          ? this.runAgentToolTimeoutMs
          : this.runAgentTimeoutMs * 3
      const stallRemainingMs = Math.max(
        0, stallLimitMs - (Date.now() - watchdogLastSubstantiveAt),
      )
      const remainingMs = Math.min(inactivityRemainingMs, hardRemainingMs, stallRemainingMs)
      watchdogTimer = setTimeout(() => {
        watchdogTimer = null
        if (parentAbortObserved || signal?.aborted || watchdogPaused
            || agentController.signal.aborted) return
        // This is an inactivity/stall timeout. Substantive progress refreshes
        // the window, while an unmatched tool lifecycle remains bounded.
        watchdogTimedOut = true
        watchdogError = new Error('LOCAL_AGENT_TIMEOUT')
        agentController.abort()
        watchdogReject(watchdogError)
      }, remainingMs)
    }
    const pauseWatchdog = () => {
      watchdogPaused = true
      clearTimeout(watchdogTimer)
      watchdogTimer = null
    }
    const noteWatchdogProgress = () => {
      if (agentCallbacksClosed || agentController.signal.aborted) return
      watchdogLastProgressAt = Date.now()
      watchdogLastSubstantiveAt = watchdogLastProgressAt
      if (!watchdogPaused) {
        clearTimeout(watchdogTimer)
        watchdogTimer = null
        armWatchdog()
      }
    }
    // Raw stdout/stderr bytes or ACP traffic prove the process is alive. They
    // lift the startup deadline (a thinking Agent used to be killed after
    // three minutes in group runs) and refresh the inactivity window outside
    // tool calls, but never count as substantive progress.
    const noteWatchdogLiveness = () => {
      if (agentCallbacksClosed || agentController.signal.aborted) return
      watchdogEstablished = true
      if (!watchdogToolActive) watchdogLastProgressAt = Date.now()
      if (!watchdogPaused) {
        clearTimeout(watchdogTimer)
        watchdogTimer = null
        armWatchdog()
      }
    }
    const establishWatchdog = () => {
      if (watchdogEstablished || agentController.signal.aborted) return
      watchdogEstablished = true
      clearTimeout(watchdogTimer)
      watchdogTimer = null
    }
    const resumeWatchdog = () => {
      watchdogPaused = false
      watchdogLastProgressAt = Date.now()
      armWatchdog()
    }
    watchdogPromise = new Promise((_, reject) => {
      watchdogReject = reject
    })
    watchdogPromise.catch(() => {})
    armWatchdog()
    const waitForHumanGate = async (operation) => {
      pauseWatchdog()
      try {
        return invocation.lease?.suspend
          ? await invocation.lease.suspend(operation, context.v4 === true
            && context.parallelGraph === true ? { pauseTask: true } : undefined)
          : await operation()
      } finally {
        if (!agentController.signal.aborted) resumeWatchdog()
      }
    }
    const onProgress = (step) => {
      if (agentCallbacksClosed || agentController.signal.aborted
          || !activeRun || this.activeRuns.get(group.id) !== activeRun) return
      establishWatchdog()
      noteWatchdogProgress()
      const next = [...attemptProgress]
      const progressId = typeof step?.id === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(step.id)
        ? step.id
        : ''
      const existingIndex = progressId
        ? next.findIndex(item => item?.id === progressId)
        : -1
      if (existingIndex >= 0) next[existingIndex] = { ...step, id: progressId }
      else next.push(progressId ? { ...step, id: progressId } : step)
      attemptProgress = next.slice(-8)
      if (activeRun.currentKind === kind) activeRun.progress = attemptProgress
      this.armAgentSilence(activeRun, kind, round, harnessRun?.agentRunId)
    }
    let autoDeltaBuffer = ''
    let v4DeltaBuffer = ''
    let v4ReceiptStarted = false
    const consensusMarkers = [
      '[[MELDWORK_CONSENSUS:agree]]',
      '[[MELDWORK_CONSENSUS:continue]]',
    ]
    const emitHarnessEvent = (rawEvent) => {
      if (agentCallbacksClosed || agentController.signal.aborted
          || this.activeRuns.get(group.id) !== activeRun
          || !harness || !harnessRun || !rawEvent) return
      const event = harness.ingest(kind, round, rawEvent, harnessRun.agentRunId)
      if (!event) return
      // Once a connector has produced a real runtime event, the process is
      // demonstrably alive. Active tools use a longer shared inactivity window.
      establishWatchdog()
      const eventType = String(event.type || '').toLowerCase()
      const eventStatus = String(event.status || '').toLowerCase()
      if (['tool_start', 'tool_update'].includes(eventType)
          && ['queued', 'running', 'waiting', 'in_progress', 'streaming'].includes(eventStatus)) {
        watchdogToolActive = true
        noteWatchdogProgress()
      } else if (eventType === 'tool_result_summary'
          || (eventType === 'status' && ['completed', 'failed', 'stopped', 'timeout', 'interrupted']
            .includes(eventStatus))) {
        watchdogToolActive = false
        noteWatchdogProgress()
      }
      this.emitRunEvent(event)
      this.armAgentSilence(activeRun, kind, round, harnessRun.agentRunId)
      if (event.type !== 'answer_delta' || event.seq % 8 === 0) {
        this.scheduleRunCheckpoint(group.id, activeRun)
        this.emitChanged()
      }
    }
    const emitV4AnswerDelta = (rawEvent) => {
      if (v4ReceiptStarted) return
      v4DeltaBuffer += String(rawEvent.delta || '')
      const hiddenMarkers = [
        ...consensusMarkers.map(marker => marker.toUpperCase()),
        V4_RECEIPT_MARKER_PREFIX,
      ]
      let visible = ''
      while (v4DeltaBuffer && !v4ReceiptStarted) {
        const uppercaseBuffer = v4DeltaBuffer.toUpperCase()
        const next = hiddenMarkers.reduce((candidate, marker) => {
          const index = uppercaseBuffer.indexOf(marker)
          return index >= 0 && (!candidate || index < candidate.index)
            ? { index, marker }
            : candidate
        }, null)
        if (next) {
          visible += v4DeltaBuffer.slice(0, next.index)
          v4DeltaBuffer = v4DeltaBuffer.slice(next.index + next.marker.length)
          if (next.marker === V4_RECEIPT_MARKER_PREFIX) v4ReceiptStarted = true
          continue
        }
        let hold = 0
        for (const marker of hiddenMarkers) {
          for (let size = 1; size < marker.length; size += 1) {
            if (uppercaseBuffer.endsWith(marker.slice(0, size))) hold = Math.max(hold, size)
          }
        }
        visible += hold ? v4DeltaBuffer.slice(0, -hold) : v4DeltaBuffer
        v4DeltaBuffer = hold ? v4DeltaBuffer.slice(-hold) : ''
        break
      }
      if (visible) emitHarnessEvent({ ...rawEvent, delta: visible })
    }
    const emitRuntimeEvent = (rawEvent) => {
      if (agentCallbacksClosed || agentController.signal.aborted) return
      noteWatchdogProgress()
      if (!rawEvent || rawEvent.type !== 'answer_delta') {
        emitHarnessEvent(rawEvent)
        return
      }
      if (context.v4 === true) {
        emitV4AnswerDelta(rawEvent)
        return
      }
      if (mode !== 'auto') {
        emitHarnessEvent(rawEvent)
        return
      }
      autoDeltaBuffer += String(rawEvent.delta || '')
      for (const marker of consensusMarkers) {
        autoDeltaBuffer = autoDeltaBuffer.split(marker).join('')
      }
      let hold = 0
      for (const marker of consensusMarkers) {
        for (let size = 1; size < marker.length; size += 1) {
          if (autoDeltaBuffer.endsWith(marker.slice(0, size))) hold = Math.max(hold, size)
        }
      }
      const safe = hold ? autoDeltaBuffer.slice(0, -hold) : autoDeltaBuffer
      autoDeltaBuffer = hold ? autoDeltaBuffer.slice(-hold) : ''
      if (safe) emitHarnessEvent({ ...rawEvent, delta: safe })
    }
    const flushRuntimeEvent = (finalText = '') => {
      if (context.v4 === true) {
        const suffix = v4DeltaBuffer
        v4DeltaBuffer = ''
        if (!v4ReceiptStarted && suffix && String(finalText).endsWith(suffix)) {
          emitHarnessEvent({ type: 'answer_delta', status: 'running', delta: suffix })
        }
        return
      }
      if (!autoDeltaBuffer) return
      const safe = consensusMarkers.reduce(
        (value, marker) => value.split(marker).join(''),
        autoDeltaBuffer,
      )
      autoDeltaBuffer = ''
      if (safe) emitHarnessEvent({ type: 'answer_delta', status: 'running', delta: safe })
    }
    let outputBaseline = null
    let artifactOutputBaseline = null
    let stagedInputs = null
    let result
    let operationStarted = false
    let sideEffectsStarted = false
    let terminalFailureKnown = false
    let harnessFinished = false
    let connectorContext = {}
    let connectorResume = null
    if (resumedConnectorGate) {
      const request = resumedConnectorGate.request
      const binding = connectorSessionBinding(sessionRef, sessionProvenance)
      const requestHash = sha256(canonicalJson(request))
      if (!agent.connectorInstanceId
          || request.connectorInstanceId !== agent.connectorInstanceId
          || request.connectorId !== agent.connectorId
          || request.connectorVersion !== agent.connectorVersion
          || request.runId !== activeRun?.runId
          || request.agentRunId !== resumedConnectorGate.agentRunId
          || request.operationId !== operationId
          || request.requestId !== resumedConnectorGate.request?.requestId
          || requestHash !== resumedConnectorGate.requestHash
          || binding.sessionRefHash !== request.sessionRefHash
          || binding.sessionProvenanceHash !== request.sessionProvenanceHash) {
        throw new Error('LOCAL_RUN_CONNECTOR_REQUEST_MISMATCH')
      }
      connectorResume = {
        type: resumedConnectorGate.type,
        requestId: request.requestId,
        requestHash,
        ...binding,
        ...(resumedConnectorGate.type === 'input'
          ? { response: resumedConnectorGate.response }
          : {
              status: resumedConnectorGate.status,
              optionId: resumedConnectorGate.optionId,
            }),
      }
    }
    const finishHarness = (status, finalText = '', runtimeContext = {}) => {
      if (!harness || !harnessRun || harnessFinished) return null
      flushRuntimeEvent(finalText)
      agentCallbacksClosed = true
      this.clearAgentSilence(activeRun, kind, round, harnessRun.agentRunId)
      const finished = harness.finishAgent(kind, round, status, finalText, {
        ...deliveredContext.context,
        contextMode: promptMode,
        sessionRotated,
        ...(context.phase ? { phase: context.phase } : {}),
        ...(Number.isInteger(context.executionSequence)
          ? { executionSequence: context.executionSequence }
          : {}),
        ...(v4AgentSlotBinding
          ? {
              operationId: v4AgentSlotBinding.operationId,
              snapshotHash: v4AgentSlotBinding.snapshotHash,
            }
          : {}),
        ...runtimeContext,
        ...deliveryContext,
        ...connectorContext,
      }, harnessRun.agentRunId)
      harnessFinished = true
      this.emitRunEvent(finished.event)
      this.checkpointRun(group.id, activeRun)
      this.emitChanged()
      return finished.capsule
    }
    try {
      const persisted = this.checkpointRun(group.id, activeRun)
      if (this.hasRunLedger() && persisted !== true) {
        throw new Error('LOCAL_RUN_PERSIST_FAILED')
      }
      if (typeof context.onLeaseAcquired === 'function') {
        context.onLeaseAcquired({
          operationId,
          agentRunId: harnessRun?.agentRunId || '',
          permissionMode: allowWrite ? 'workspace-write' : 'read-only',
          sideEffectsPossible: allowWrite,
        })
      }
      if (allowWrite) {
        artifactCapturePromise = Promise.resolve().then(() => this.captureArtifactOutputs(
          group.workdir,
          { signal: agentController.signal },
        ))
        artifactCapturePromise.catch(() => {})
        try {
          capturePromise = Promise.resolve().then(() => this.captureAgentOutputs(
            group.workdir,
            { signal: agentController.signal },
          ))
          capturePromise.catch(() => {})
          outputBaseline = await abortableOperation(
            () => capturePromise,
            agentController.signal,
          )
        } catch (error) {
          if (agentController.signal.aborted) throw error
          /* output capture is best effort */
        }
        try {
          artifactOutputBaseline = await abortableOperation(
            () => artifactCapturePromise,
            agentController.signal,
          )
        } catch (error) {
          if (agentController.signal.aborted) throw error
          /* artifact output capture is best effort */
        }
      }
      const nativeImageLimit = Math.max(
        0,
        Math.floor(Number(this.attachmentSupport(kind)?.image) || 0),
      )
      stagedInputs = isolated || frozen
        ? null
        : stageAgentInputs(group.workdir, context.attachmentSnapshots || [], nativeImageLimit)
      const runtimeInstruction = cleanText(context.runtimeInstruction, 3000)
      const regenerationInstruction = cleanText(context.regenerationInstruction, 3000)
      const responseScopeInstruction = group.conversationType === 'direct'
        ? ''
        : [
            'Final response scope:',
            'Answer only the current user task labeled authoritative above.',
            'Use earlier messages only as supporting evidence when they help answer that current task.',
            'Do not separately mention, summarize, continue, or complete any previous user task.',
            'Do not append an answer to an older task after the current-task conclusion.',
          ].join('\n')
      const buildPrompt = (afterKind, contextPackage) => isolated || frozen
        ? v4Prompt
          : group.conversationType === 'direct'
          ? [
              // A resumed native session already holds the conversation. A new
              // or rebuilt session needs the earlier turns and, always, the
              // current request plus the per-turn delivery contract.
              directPromptFor({
                group,
                label: this.agentLabel(kind),
                packed: contextPackage,
                skillHints: context.skillHints || [],
                knowledgeBaseHints: context.knowledgeBaseHints || [],
                includeHistory: sessionRotated || !sessionRef,
              }),
              stagedAgentInputPrompt(stagedInputs),
              runtimeInstruction ? `Harness recovery task:\n${runtimeInstruction}` : '',
              regenerationInstruction
                ? `Fresh response instruction:\n${regenerationInstruction}`
                : '',
            ].filter(Boolean).join('\n\n')
        : [
            context.v4 === true && v4Prompt
              ? v4Prompt
              : this.promptFor(
                group, kind, context.completionPolicy === 'typed' ? 'manual' : mode,
                threadRootId, context.skillHints || [],
                context.knowledgeBaseHints || [], afterKind, contextPackage, promptMode,
                activeRun?.unlimitedRounds === true,
              ),
            stagedAgentInputPrompt(stagedInputs),
            runtimeInstruction ? `Harness recovery task:\n${runtimeInstruction}` : '',
            regenerationInstruction
              ? `Fresh response instruction:\n${regenerationInstruction}`
              : '',
            responseScopeInstruction,
          ].filter(Boolean).join('\n')
      let prompt = buildPrompt(transcriptAfterKind, packedContext)
      const recordOutboundPayload = (outbound = {}) => {
        noteWatchdogProgress()
        if (activeRun?.budget) {
          const bytes = outboundWirePayloadBytes(outbound)
          activeRun.budget.addUsageBatch([
            { dimension: 'outboundBytes', amount: bytes.length, source: 'reported' },
            {
              dimension: 'inputTokens',
              amount: Math.ceil(bytes.length / 4),
              source: 'estimated',
            },
          ])
        }
        const baseContextPackId = isolated?.contextPackId || activeRun?.contextPackId || ''
        if (!baseContextPackId || !harness || !harnessRun) return
        const deliveredPrompt = typeof outbound?.prompt === 'string' ? outbound.prompt : prompt
        const attempt = this.createAttemptContextPack({
          baseContextPackId,
          group,
          taskId,
          mode: group.conversationType === 'direct' ? 'direct' : mode,
          kind,
          packedContext: deliveredContext,
          attachments: isolated || frozen ? [] : (context.attachmentSnapshots || []),
          skillHints: isolated || frozen ? [] : (context.skillHints || []),
          knowledgeBaseHints: isolated || frozen ? [] : (context.knowledgeBaseHints || []),
          // The prompt is context-budgeted, so delivery verification must use
          // the exact prompt scheduled for this Agent rather than the raw turn.
          // Verify against the prompt actually reported by the transport. This
          // remains correct when a recovery path rebuilds a prompt mid-attempt.
          approvedPrompt: deliveredPrompt,
          forceReadOnly: Boolean(isolated),
        })
        const delivery = this.recordContextDelivery({
          contextPackId: attempt.record.contextPackId,
          runId: activeRun.runId,
          agentRunId: harnessRun.agentRunId,
          kind,
          outbound,
          permissionMode: allowWrite ? 'workspace-write' : 'read-only',
          skills: isolated || frozen ? [] : (context.skillHints || []),
          runtimeAdditions: attempt.runtimeAdditions,
          sessionProvenance,
        })
        deliveryContext = {
          contextPackId: attempt.record.contextPackId,
          deliveryRecordIds: [
            ...deliveryContext.deliveryRecordIds,
            delivery.deliveryRecordId,
          ].slice(-8),
          sessionProvenance,
          ...contextSourceProof(attempt.record),
          promptChars: deliveredPrompt.length,
          promptBytes: Buffer.byteLength(deliveredPrompt, 'utf8'),
          promptHash: sha256(deliveredPrompt),
          wirePayloadBytes: delivery.wirePayloadBytes,
          wirePayloadHash: delivery.wirePayloadHash,
        }
        const liveHarnessRun = harness.current(kind, round, harnessRun.agentRunId)
        if (liveHarnessRun) {
          liveHarnessRun.context = {
            ...deliveredContext.context,
            contextMode: promptMode,
            sessionRotated,
            ...deliveryContext,
            ...connectorContext,
          }
        }
        this.checkpointRun(group.id, activeRun)
        this.emitChanged()
      }
      const rebuildFreshSession = () => {
        sessionMeta = {}
        sessionProvenance = createdSessionProvenance(group, taskId)
        promptMode = 'bootstrap'
        deliveryContext = { ...deliveryContext, sessionProvenance }
        this.commitSessionState((nextState) => {
          delete nextState.sessions[key]
          delete nextState.sessionMeta[key]
          if (kind === 'openclaw') {
            const generation = randomUUID().replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'session'
            sessionRef = this.openClawSessionRef(
              group, generation, group.conversationType === 'direct' ? '' : taskId,
            )
            nextState.sessions[key] = sessionRef
            nextState.sessionMeta[key] = normalizeSessionMeta(
              provenanceMeta(sessionProvenance),
            )
          } else {
            sessionRef = ''
          }
        })
        sessionTransport = ''
        transcriptAfterKind = ''
        sessionRotated = true
        buildV4Prompt()
        packedContext = frozen
          ? {
              text: v4Prompt,
              sourceMessageIds: context.snapshotSourceMessageIds || [],
              sourceEntries: context.snapshotSourceEntries || [],
              omittedCount: 0,
              charCount: v4Prompt.length,
              context: {
                includedCount: 0, omittedCount: 0, charCount: v4Prompt.length,
                contextPackId: invocationContext.contextPackId, contextPackState: 'captured',
              },
              currentTaskText: v4Prompt,
              stableText: '(frozen)', recentText: '(frozen)', continuationText: v4Prompt,
            }
          : withCollaborationPackage(
              this.packedPromptContext(group.id, '', threadRootId, context.contextOptions || {}),
              context.collaborationPackage,
            )
        assertRequiredContextFits(packedContext)
        deliveredContext = deliveredPackedContext(packedContext, promptMode)
        const liveHarnessRun = harness?.current(
          kind, round, harnessRun?.agentRunId || '',
        )
        if (liveHarnessRun) {
          liveHarnessRun.sourceMessageIds = [...deliveredContext.sourceMessageIds]
          liveHarnessRun.context = {
            ...deliveredContext.context,
            contextMode: promptMode,
            sessionRotated,
            ...deliveryContext,
            ...connectorContext,
          }
        }
        prompt = buildPrompt('', packedContext)
        this.scheduleRunCheckpoint(group.id, activeRun)
        this.emitChanged()
        return prompt
      }
      const runOptions = {
        sessionRef,
        ...(Number.isInteger(context.executionSequence)
          ? { executionSequence: context.executionSequence }
          : {}),
        onSessionRef: (nextSessionRef, metadata = {}) => {
          if (agentCallbacksClosed || agentController.signal.aborted) return
          noteWatchdogProgress()
          if (reviewOnly || isolated) return
          const transport = ['legacy', 'acp'].includes(metadata?.transport)
            ? metadata.transport
            : ''
          if (transport) sessionTransport = transport
          sessionRef = String(nextSessionRef || '')
          this.persistSessionState(key, sessionRef, normalizeSessionMeta({
            ...sessionMeta,
            ...provenanceMeta(sessionProvenance),
            ...(sessionTransport ? { transport: sessionTransport } : {}),
          }))
        },
        onSessionInvalidated: () => {
          if (kind !== 'hermes' || reviewOnly || isolated || resumedPermission) return null
          return { prompt: rebuildFreshSession() }
        },
        signal: agentController.signal,
        sandbox: allowWrite ? 'workspace-write' : 'read-only',
        operationId,
        onActivity: () => {
          // A cloud request has no local process events while the remote CLI
          // is working. Its activity callback is therefore the first proof
          // that the run has started and must release the initial deadline.
          if (agent.cloud === true) {
            establishWatchdog()
            noteWatchdogProgress()
          } else {
            noteWatchdogLiveness()
          }
        },
        onProgress,
        onEvent: emitRuntimeEvent,
        onOutboundPayload: recordOutboundPayload,
        onPermissionRequest: (request, permissionContext = {}) => {
          // Permission prompts default to yolo for every local invocation.
          // Callers can opt into an interactive Gate explicitly with
          // `yolo: false`; sandbox and workspace authorization remain enforced
          // before this callback is reached.
          if ((context.yolo ?? this.defaultYolo) !== false) {
            const option = Array.isArray(request?.options)
              ? request.options.find(candidate => candidate?.kind === 'allow_once')
                || request.options.find(candidate => candidate?.kind === 'allow_always')
                || request.options[0]
              : null
            if (option?.optionId) {
              return Promise.resolve({ status: 'approved', optionId: option.optionId })
            }
          }
          const pending = Promise.resolve().then(async () => {
            if (resumedPermission && !resumedPermissionUsed) {
              if (!matchesResumedPermission(request, resumedPermission)) {
                resumedPermissionError = new Error('LOCAL_RUN_PERMISSION_REQUEST_MISMATCH')
                throw resumedPermissionError
              }
              resumedPermissionUsed = true
              return {
                status: resumedPermission.status,
                optionId: resumedPermission.optionId,
              }
            }
            const requestHash = sha256(canonicalJson(request))
            const binding = connectorSessionBinding(sessionRef, sessionProvenance)
            const decision = await waitForHumanGate(() => this.requestHumanGate({
              type: 'permission',
              runId: activeRun.runId,
              agentRunId: harnessRun.agentRunId,
              agentKind: kind,
              summary: 'Agent requests permission to continue a tool action.',
              options: request.options,
              request,
            }, {
              signal: permissionContext.signal || agentController.signal,
              preserveOnAbort: () => activeRun.stopReason === 'shutdown',
              continuation: {
                resumeKind: 'agent_slot',
                agentRunId: harnessRun.agentRunId,
                agentKind: kind,
                round,
                ...(v4AgentSlotBinding || {}),
                requestId: permissionContinuationRequestId(requestHash, binding),
                requestHash,
                ...binding,
              },
            }))
            if (decision.gateId) resolvedGateIds.push(decision.gateId)
            return { status: decision.status, optionId: decision.optionId }
          })
          pendingPermissionCallbacks.add(pending)
          pending.then(
            () => pendingPermissionCallbacks.delete(pending),
            () => pendingPermissionCallbacks.delete(pending),
          )
          return pending
        },
        sessionTransport,
        ...(kind === 'workbuddy' && Number.isInteger(context.maxInternalTurns)
          ? { maxTurns: context.maxInternalTurns }
          : {}),
        attachments: isolated || frozen ? [] : (stagedInputs?.nativeImagePaths || []),
        // ACP runtimes are shared by the stable group/task session key. OpenClaw
        // is excluded because its gateway wrapper owns the process lifetime and
        // is intentionally torn down after each invocation.
        ...(kind !== 'openclaw' ? { acpPersistenceKey: key } : {}),
        ...(kind === 'hermes'
          ? { hermesAcpAvailable: HERMES_WORKSPACE_ACP_ENABLED && agent.acpAvailable !== false }
          : {}),
      }
      const runCurrentSession = () => {
        const currentRunOptions = { ...runOptions, sessionRef, sessionTransport }
        if (!agent.connectorInstanceId) {
          return this.runAgent(agent, prompt, group.workdir, currentRunOptions)
        }
        if (!this.connectorRuntime || typeof this.connectorRuntime.run !== 'function') {
          throw new Error('AGENT_CONNECTOR_RUNTIME_UNAVAILABLE')
        }
        if (!activeRun?.runId || !harnessRun?.agentRunId) {
          throw new Error('AGENT_CONNECTOR_RUN_ID_INVALID')
        }
        return this.connectorRuntime.run(agent, prompt, group.workdir, {
          ...currentRunOptions,
          runId: activeRun.runId,
          agentRunId: harnessRun.agentRunId,
          onActivity: () => {
            if (agent.cloud === true) {
              establishWatchdog()
              noteWatchdogProgress()
            } else {
              noteWatchdogLiveness()
            }
          },
          onConnectorState: (nextContext) => {
            noteWatchdogProgress()
            connectorContext = nextContext
            const liveHarnessRun = harness.current(kind, round, harnessRun.agentRunId)
            if (liveHarnessRun) {
              liveHarnessRun.context = {
                ...deliveredContext.context,
                contextMode: promptMode,
                sessionRotated,
                ...deliveryContext,
                ...connectorContext,
              }
            }
            this.checkpointRun(group.id, activeRun)
            this.emitChanged()
          },
          connectorResume,
        })
      }
      const costDecision = activeRun?.budget?.check('costMicros')
      if (costDecision?.action === 'human_gate') {
        const resumed = context.resumedGate
        const decision = resumed?.type === 'budget'
          ? resumed
          : await waitForHumanGate(() => this.requestHumanGate({
          type: 'budget',
          runId: activeRun.runId,
          agentRunId: harnessRun.agentRunId,
          agentKind: kind,
          summary: 'Cost usage is unavailable for this Agent attempt.',
          options: [
            { optionId: 'continue-unmetered', name: 'Continue', kind: 'allow_once' },
            { optionId: 'cancel-attempt', name: 'Cancel', kind: 'reject_once' },
          ],
          request: costDecision,
          }, {
            signal: agentController.signal,
            preserveOnAbort: () => activeRun.stopReason === 'shutdown',
            continuation: {
              resumeKind: 'agent_slot',
              agentRunId: harnessRun.agentRunId,
              agentKind: kind,
              round,
              ...(v4AgentSlotBinding || {}),
            },
          }))
        if (decision.gateId && resumed?.type !== 'budget') resolvedGateIds.push(decision.gateId)
        if (decision.status !== 'approved') throw new Error('LOCAL_BUDGET_REJECTED')
        activeRun.budget.approveUnobservable('costMicros')
        this.checkpointRun(group.id, activeRun)
      }
      if (agentController.signal.aborted) throw agentStoppedError()
      const executeCurrentSession = async () => {
        const reusedSessionRef = sessionRef
        try {
          operationStarted = true
          if (allowWrite) sideEffectsStarted = true
          return await runCurrentSession()
        } catch (error) {
          if (agentController.signal.aborted || !reusedSessionRef
              || resumedConnectorGate
              || error?.message !== 'LOCAL_AGENT_SESSION_INVALID') throw error
          if (resumedPermission) {
            if (context.v4 !== true || allowWrite) throw error
            resumedPermission = null
          }
          rebuildFreshSession()
          operationStarted = true
          if (allowWrite) sideEffectsStarted = true
          return await runCurrentSession()
        }
      }
      const raceCurrentSession = async () => {
        runPromise = Promise.resolve().then(executeCurrentSession)
        runPromise.catch(() => {})
        const pending = [runPromise, watchdogPromise]
        if (parentAbortPromise) pending.push(parentAbortPromise)
        return Promise.race(pending)
      }
      result = await raceCurrentSession()
      if (['waiting_input', 'waiting_permission'].includes(result?.outcome)) {
        if (!agent.connectorInstanceId || resumedConnectorGate) {
          throw new Error('LOCAL_RUN_CONNECTOR_WAITING_INVALID')
        }
        const waiting = result.waitingRequest
        const waitingSessionRef = String(result.sessionRef || '')
        if (waitingSessionRef && waitingSessionRef !== sessionRef) {
          runOptions.onSessionRef(waitingSessionRef)
          sessionRef = waitingSessionRef
        }
        const binding = connectorSessionBinding(sessionRef, sessionProvenance)
        const request = {
          version: 1,
          source: 'connector',
          outcome: result.outcome,
          requestId: waiting?.requestId,
          runId: activeRun.runId,
          agentRunId: harnessRun.agentRunId,
          ...(result.outcome === 'waiting_input'
            ? { prompt: waiting?.prompt }
            : {
                permission: waiting?.permission,
                ...(waiting?.summary ? { summary: waiting.summary } : {}),
              }),
          connectorInstanceId: agent.connectorInstanceId,
          connectorId: result.connector?.connectorId,
          connectorVersion: result.connector?.connectorVersion,
          operationId,
          cursor: waiting?.cursor,
          ...binding,
        }
        const requestHash = sha256(canonicalJson(request))
        const gateType = result.outcome === 'waiting_input' ? 'input' : 'permission'
        const decision = await waitForHumanGate(() => this.requestHumanGate({
          type: gateType,
          runId: activeRun.runId,
          agentRunId: harnessRun.agentRunId,
          agentKind: kind,
          summary: gateType === 'input'
            ? String(waiting?.prompt || '').trim().replace(/\s+/g, ' ').slice(0, 500)
            : String(waiting?.summary || 'Connector requests permission to continue.').slice(0, 500),
          options: gateType === 'input'
            ? [
                { optionId: 'submit-input', name: 'Submit', kind: 'respond' },
                { optionId: 'cancel-input', name: 'Cancel', kind: 'reject' },
              ]
            : [
                { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
              ],
          request,
        }, {
          signal: agentController.signal,
          preserveOnAbort: () => activeRun.stopReason === 'shutdown',
          continuation: {
            resumeKind: 'agent_slot',
            agentRunId: harnessRun.agentRunId,
            agentKind: kind,
            round,
            ...(v4AgentSlotBinding || {}),
            requestId: request.requestId,
            requestHash,
            ...binding,
          },
        }))
        if (decision.gateId) resolvedGateIds.push(decision.gateId)
        if (decision.status !== 'approved') throw new Error(
          gateType === 'input' ? 'LOCAL_INPUT_REJECTED' : 'LOCAL_PERMISSION_REJECTED',
        )
        connectorResume = {
          type: gateType,
          requestId: request.requestId,
          requestHash,
          ...binding,
          ...(gateType === 'input'
            ? { response: decision.response }
            : { status: decision.status, optionId: decision.optionId }),
        }
        result = await raceCurrentSession()
      }
      if (pendingPermissionCallbacks.size) {
        await Promise.allSettled([...pendingPermissionCallbacks])
        throw new Error('LOCAL_AGENT_PERMISSION_TERMINAL_RACE')
      }
      terminalFailureKnown = ['failed', 'cancelled']
        .includes(String(result?.outcome || ''))
      if (agentController.signal.aborted) throw agentStoppedError()
      if (resumedPermissionError) throw resumedPermissionError
      if (resumedPermission && !resumedPermissionUsed) {
        throw new Error('LOCAL_RUN_PERMISSION_REQUEST_NOT_REISSUED')
      }
      result = requireTerminalAgentResult(result)
      this.markRuntimeCredential(kind, 'ready')

      const collaborationReply = parseV4CollaborationReceipt(
      result,
      context.v4 === true,
      context.phase || '',
        {
          allowMissingProposalReceipt: context.allowMissingProposalReceipt === true,
          allowMissingV4Receipt: context.allowMissingV4Receipt === true,
        },
      )
      const reply = mode === 'auto' && context.completionPolicy !== 'typed'
        ? parseAutoReply(collaborationReply.text)
        : { text: collaborationReply.text, consensus: false }
      if (!reply.text) throw new Error('LOCAL_AGENT_EMPTY_RESPONSE')
      const progress = attemptProgress.length ? attemptProgress : result.progress
      const toolCalls = cleanProgressSteps(progress).map(step => ({
        ...step,
        status: step.status === 'in_progress' ? 'completed' : step.status,
      }))
      if (activeRun) activeRun.progress = toolCalls
      if (activeRun?.budget) {
        const reportedOutputTokens = Number(result.usage?.outputTokens)
        const hasReportedOutputTokens = Number.isSafeInteger(reportedOutputTokens)
          && reportedOutputTokens >= 0
        const reportedCostMicros = Number(result.usage?.costMicros)
        activeRun.budget.addUsageBatch([
          {
            dimension: 'outputTokens',
            amount: hasReportedOutputTokens
              ? reportedOutputTokens
              : Math.ceil(reply.text.length / 4),
            source: hasReportedOutputTokens ? 'reported' : 'estimated',
          },
          { dimension: 'toolCalls', amount: toolCalls.length, source: 'estimated' },
          ...(Number.isSafeInteger(reportedCostMicros) && reportedCostMicros >= 0
            ? [{ dimension: 'costMicros', amount: reportedCostMicros, source: 'reported' }]
            : []),
          {
            dimension: 'elapsedMs',
            value: activeRun.budget.elapsedValue(),
            source: 'reported',
          },
        ])
        this.checkpointRun(group.id, activeRun)
      }
      let attachments = []
      if (allowWrite) {
        try {
          importPromise = Promise.resolve().then(() => this.importAgentOutputs({
            workdir: group.workdir,
            baseline: outputBaseline,
            startedAt,
            agentKind: kind,
            reportedPaths: extractReportedOutputPaths(reply.text),
            signal: agentController.signal,
          }))
          importPromise.catch(() => {})
          const imported = await abortableOperation(
            () => importPromise,
            agentController.signal,
          )
          attachments = (Array.isArray(imported) ? imported : [])
            .slice(0, MAX_MESSAGE_ATTACHMENTS)
            .map(normalizeAttachmentMetadata)
            .filter(Boolean)
        } catch (error) {
          if (agentController.signal.aborted) throw error
          /* the reply remains available when no valid media was produced */
        }
      }
      if (agentController.signal.aborted) throw agentStoppedError()
      let descriptors = []
      if (allowWrite && artifactOutputBaseline) {
        try {
          outcomeCapturePromise = Promise.resolve().then(() => (
            this.captureAgentOutcomeDescriptors({
              workdir: group.workdir,
              baseline: artifactOutputBaseline,
              startedAt,
              agentKind: kind,
              runId: activeRun?.runId,
              agentRunId: harnessRun?.agentRunId,
              signal: agentController.signal,
            })
          ))
          outcomeCapturePromise.catch(() => {})
          const captured = await abortableOperation(
            () => outcomeCapturePromise,
            agentController.signal,
          )
          descriptors = Array.isArray(captured) ? captured : []
        } catch (error) {
          if (agentController.signal.aborted) throw error
          /* the conclusion remains durable when explicit outputs cannot be captured */
        }
      }
      if (agentController.signal.aborted) throw agentStoppedError()
      const requestedOutcomeRefs = !internal && context.outcomeRefs
        && typeof context.outcomeRefs === 'object'
        && !Array.isArray(context.outcomeRefs)
        ? context.outcomeRefs
        : {}
      const reportedOutcomeRefs = !internal
        ? normalizeOutcomeRefs(result.outcomeRefs, context.v4 === true ? { strict: true } : {})
        : {}
      const capturedOutcomeRefs = internal
        ? { artifactIds: [], evidenceIds: [] }
        : this.recordAgentOutcomes({
            groupId: group.id,
            runId: activeRun?.runId,
            agentRunId: harnessRun?.agentRunId,
            agentKind: kind,
            round,
            conclusion: reply.text,
            descriptors,
          })
      const producedOutcomeRefs = mergeOutcomeRefs(
        [reportedOutcomeRefs, capturedOutcomeRefs],
        { strict: context.v4 === true },
      )
      const auditOutcomeRefs = mergeOutcomeRefs([
        producedOutcomeRefs,
        capturedOutcomeRefs,
        requestedOutcomeRefs,
      ])
      const finalStatus = result.outcome
      const trace = finishHarness(finalStatus, reply.text, {
        promptChars: prompt.length,
        promptBytes: Buffer.byteLength(prompt, 'utf8'),
        promptHash: sha256(prompt),
        externalRunRef: result.externalRunRef,
        outcomeRefs: auditOutcomeRefs,
        ...(collaborationReply.collaboration?.taskDecision
          ? { taskDecision: collaborationReply.collaboration.taskDecision } : {}),
      })
      const messageMetadata = {
        elapsedMs: Date.now() - startedAt,
        toolCalls,
        attachments,
        trace,
        responseVersionRootId,
        ...(context.turnSeq ? { turnSeq: context.turnSeq } : {}),
      }
      const pendingMessage = internal
        ? null
        : {
            groupId: group.id,
            role: 'agent',
            content: reply.text,
            agentKind: kind,
            threadRootId,
            system: null,
            metadata: messageMetadata,
          }
      const message = pendingMessage && context.deferMessage !== true
        ? this.addMessage(
            pendingMessage.groupId,
            pendingMessage.role,
            pendingMessage.content,
            pendingMessage.agentKind,
            pendingMessage.threadRootId,
            pendingMessage.system,
            pendingMessage.metadata,
          )
        : null
      if (!reviewOnly && !isolated) {
        this.persistSessionState(key, result.sessionRef || sessionRef, completedSessionMeta(
          sessionMeta, sessionProvenance, taskId, {
          promptChars: prompt.length,
          replyChars: reply.text.length,
          rotated: sessionRotated,
          transport: sessionTransport,
          lastDeliveredMessageId: packedContext.latestMessageId || sessionMeta.lastDeliveredMessageId,
          },
        ))
      }
      return {
        message,
        pendingMessage,
        collaboration: collaborationReply.collaboration,
        outcomeRefs: producedOutcomeRefs,
        producedOutcomeRefs,
        operationId,
        consensus: reply.consensus && result.outcome === 'completed',
        ...(v4Delivery ? {
          v4Delivery,
          v4SessionBinding: connectorSessionBinding(result.sessionRef || sessionRef, sessionProvenance),
        } : {}),
      }
    } catch (caughtError) {
      const parentTimedOut = Boolean(signal?.aborted && activeRun?.stopReason === 'timeout')
      const parentStopped = Boolean(signal?.aborted || parentAbortObserved)
      const parentInterrupted = parentStopped && activeRun?.stopReason === 'shutdown'
      const agentCancelled = agentController.signal.aborted
        && !parentStopped && !watchdogTimedOut
      if (parentStopped || watchdogTimedOut || agentCancelled) {
        const cleanupPromises = [
          capturePromise,
          artifactCapturePromise,
          runPromise,
          importPromise,
          outcomeCapturePromise,
        ].filter(Boolean)
        if (cleanupPromises.length) {
          await settleWithin(Promise.allSettled(cleanupPromises), this.runAbortGraceMs)
        }
      }
      const error = parentTimedOut
        ? new Error('LOCAL_AGENT_TIMEOUT')
        : parentStopped
          ? (caughtError?.message === 'LOCAL_AGENT_EXECUTION_STOPPED'
              ? caughtError
              : agentStoppedError())
          : watchdogTimedOut
            ? (watchdogError || new Error('LOCAL_AGENT_TIMEOUT'))
            : agentCancelled
              ? agentStoppedError()
              : caughtError
      // Only an explicit sign-in failure changes readiness. Network, quota and
      // provider refusals stay run-scoped so a healthy Agent remains usable.
      if (error?.code === 'LOCAL_AGENT_AUTH_REQUIRED'
          && context.deferCredentialFailure !== true) {
        this.markRuntimeCredential(kind, 'missing')
      }
      const status = parentTimedOut
        ? 'timeout'
        : parentInterrupted
          ? 'interrupted'
          : parentStopped
            ? 'stopped'
            : watchdogTimedOut
              ? 'timeout'
              : agentCancelled
                ? 'stopped'
                : 'failed'
      const trace = finishHarness(status)
      if (trace && error && (typeof error === 'object' || typeof error === 'function')) {
        Object.defineProperty(error, 'runTrace', {
          value: trace,
          enumerable: false,
          configurable: true,
        })
      }
      // Failure and stop notices take the turn's slot in the timeline.
      if (context.turnSeq && error && (typeof error === 'object' || typeof error === 'function')) {
        Object.defineProperty(error, 'turnSeq', {
          value: context.turnSeq,
          enumerable: false,
          configurable: true,
        })
      }
      throw attachInvocationFailure(error, {
        outcomeCertainty: terminalFailureKnown
          ? 'known_failed'
          : (operationStarted || sideEffectsStarted ? 'unknown_outcome' : 'not_started'),
        sideEffectsPossible: allowWrite && sideEffectsStarted,
        operationId,
        idempotencyMode,
      })
    } finally {
      agentCallbacksClosed = true
      clearTimeout(watchdogTimer)
      watchdogTimer = null
      if (signal && parentAbortHandler) {
        signal.removeEventListener('abort', parentAbortHandler)
      }
      this.unregisterAgentController?.(
        activeRun, kind, registration.agentRunId, agentController,
      )
      if (activeRun?.stopReason !== 'shutdown') {
        for (const gateId of resolvedGateIds) {
          this.completeHumanGateContinuation?.(activeRun.runId, gateId, 'completed')
        }
      }
      cleanupStagedAgentInputs(stagedInputs)
    }
  }

  resetSession(group, kind, rotateOpenClaw = true, taskId = '') {
    const key = this.sessionKey(group.id, kind)
    const legacyPrefix = `${group.id}:${kind}:thread:`
    return this.commitSessionState((state) => {
      const legacyKeys = new Set([
        key,
        ...(taskId ? [this.sessionKey(group.id, kind, taskId)] : []),
        ...state.messages.filter(message => message.groupId === group.id && message.role === 'user')
          .map(message => this.sessionKey(group.id, kind, message.id)),
      ])
      const belongsToSession = candidate => legacyKeys.has(candidate)
        || candidate.startsWith(legacyPrefix)
        || (candidate.startsWith(`${group.id}:task:`) && candidate.endsWith(`:${kind}`))
      let changed = false
      for (const candidate of Object.keys(state.sessions)) {
        if (!belongsToSession(candidate)) continue
        delete state.sessions[candidate]
        changed = true
      }
      for (const candidate of Object.keys(state.sessionMeta)) {
        if (!belongsToSession(candidate)) continue
        delete state.sessionMeta[candidate]
        changed = true
      }
      if (kind === 'openclaw' && rotateOpenClaw) {
        const generation = randomUUID().replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'session'
        const provenance = createdSessionProvenance(group, cleanText(taskId, 120))
        state.sessions[key] = this.openClawSessionRef(group, generation)
        state.sessionMeta[key] = normalizeSessionMeta(provenanceMeta(provenance))
        changed = true
      }
      return changed
    })
  }
}

module.exports = { LocalWorkspaceAgentInvocation, parseV4CollaborationReceipt }

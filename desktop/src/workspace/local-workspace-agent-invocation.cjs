const { createHash, randomUUID } = require('node:crypto')
const { workPreferencesPrompt } = require('./work-preferences.cjs')
const {
  assertResumedPermissionBinding,
  automaticPermissionResponse,
  matchesResumedPermission,
  permissionContinuationRequestId,
} = require('../agents/agent-permission-policy.cjs')
const {
  agentRuntimeCapabilities,
  isCodeReviewAgentKind,
  requireTerminalAgentResult,
} = require('../agents/agent-runtime-contract.cjs')
const {
  cleanupStagedAgentInputs,
  stageAgentInputs,
} = require('../agents/agent-input-staging.cjs')
const { createAnswerMarkerFilter } = require('../collaboration/answer-marker-filter.cjs')
const {
  V4_AGENT_PHASES,
  parseV4CollaborationReceipt,
} = require('../collaboration/collaboration-receipt.cjs')
const {
  canonicalJson,
  normalizeContextPackId,
} = require('../collaboration/context-pack-records.cjs')
const { normalizeOutcomeRefs, normalizeSessionMeta } = require('../runs/run-harness.cjs')
const { createInvocationWatchdog } = require('../runs/invocation-watchdog.cjs')
const { processRunScheduler } = require('../runs/run-scheduler.cjs')
const {
  DEFAULT_AUTO_AGENT_INVOCATION_MAX_MS,
  DEFAULT_AUTO_AGENT_ANSWER_IDLE_MS,
  DEFAULT_AUTO_AGENT_TOOL_CALL_LIMIT,
} = require('./local-workspace-runtime-contracts.cjs')
const { assertLocalSkillExecution } = require('../skills/local-skill-contract.cjs')
const {
  defaultAgentLabel,
  HERMES_WORKSPACE_ACP_ENABLED,
  agentStoppedError,
  attachmentType,
  cleanText,
  cleanProgressSteps,
  parseAutoReply,
  settleWithin,
} = require('./local-workspace-inputs.cjs')
const { recordOutboundUsage, recordReplyUsage } = require('./invocation-budget.cjs')
const {
  attachErrorMetadata,
  attachInvocationFailure,
  resolveInvocationStop,
} = require('./invocation-failure.cjs')
const { InvocationOutputs } = require('./invocation-outputs.cjs')
const { assembleInvocationPrompt } = require('./invocation-prompt.cjs')
const {
  InvocationSession,
  connectorSessionBinding,
  createdSessionProvenance,
  provenanceMeta,
  sha256,
} = require('./invocation-session.cjs')

const MAX_ISOLATED_PROMPT_BYTES = 4 * 1024 * 1024
const OUTCOME_REF_FIELDS = Object.freeze([
  'artifactIds',
  'evidenceIds',
  'findingIds',
  'reviewerFindingIds',
  'adoptionIds',
  'workflowOutcomeRefs',
])

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
    // Every conversation, group or direct, is its own execution surface. The
    // writer lease is scoped to the conversation, so a writable chat never
    // makes an Agent in another conversation wait, including when both use the
    // same folder (most chats keep the default one). Writers inside one
    // conversation still take turns.
    const workspaceKey = createHash('sha256')
      .update(`conversation\u0000${group.id}`)
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
      && V4_AGENT_PHASES.has(context.phase)
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
    const session = new InvocationSession({
      resolved: reviewOnly || isolated
        ? {
            key: this.sessionKey(group.id, kind),
            sessionRef: '',
            sessionMeta: {},
            provenance: createdSessionProvenance(taskId, true),
          }
        : this.sessionState(
            group, kind, context.sessionThreadRootId || threadRootId, taskId,
          ),
      group,
      kind,
      taskId,
      deps: {
        commitSessionState: mutator => this.commitSessionState(mutator),
        openClawSessionRef: (...args) => this.openClawSessionRef(...args),
        persistSessionState: (...args) => this.persistSessionState(...args),
      },
    })
    const resumedConnectorGate = ['input', 'permission'].includes(context.resumedGate?.type)
      && context.resumedGate?.request?.source === 'connector'
      ? context.resumedGate
      : null
    let resumedPermission = context.resumedGate?.type === 'permission'
      && !resumedConnectorGate
      ? context.resumedGate
      : null
    if (resumedPermission) {
      assertResumedPermissionBinding(resumedPermission, session.binding(), session.ref)
      if (!session.ref) throw new Error('LOCAL_RUN_PERMISSION_RESUME_UNAVAILABLE')
    }
    const hermesNeedsLegacy = kind === 'hermes' && session.transport === 'acp'
      && (!HERMES_WORKSPACE_ACP_ENABLED || agent.acpAvailable === false)
    if (resumedPermission && hermesNeedsLegacy) {
      throw new Error('LOCAL_RUN_PERMISSION_RESUME_UNAVAILABLE')
    }
    if (session.ref && hermesNeedsLegacy) session.discard()
    let v4Prompt = invocationContext?.promptOverride || ''
    let v4Delivery = null
    const buildV4Prompt = () => {
      if (context.v4 !== true || typeof context.v4PromptBuilder !== 'function') return v4Prompt
      const built = context.v4PromptBuilder({
        sessionRefHash: sha256(session.ref),
        sessionProvenanceHash: session.binding().sessionProvenanceHash,
        sessionRotated: session.rotated,
        hasSession: Boolean(session.ref),
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
      || session.provenance.completeness !== 'unknown-legacy'
    const sameTaskSession = !taskId
      || taskId === session.meta.originTaskId
      || (Array.isArray(session.meta.inheritedTaskIds) && session.meta.inheritedTaskIds.includes(taskId))
    let transcriptAfterKind = knownSessionHistory && !session.rotated && session.storedRef && session.storedRef === session.ref
      && (!session.meta.lastDeliveredMessageId || !sameTaskSession)
      ? kind
      : ''
    // Group Sessions already contain the immutable bootstrap instructions after
    // a successful turn. Keep direct chat unchanged and send only the compact
    // Harness context on later group turns.
    let promptMode = group.conversationType !== 'direct'
      && Boolean(session.ref)
      && !session.rotated
      && knownSessionHistory
      && session.meta.turns > 0
      ? 'continuation'
      : 'bootstrap'
    const sessionContextOptions = (!isolated && !frozen && promptMode === 'continuation' && sameTaskSession)
      ? { ...(context.contextOptions || {}), afterMessageId: session.meta.lastDeliveredMessageId || '' }
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
      sessionProvenance: session.provenance,
    }
    if (harnessRun) {
      const liveHarnessRun = harness.current(kind, round, harnessRun.agentRunId)
      if (liveHarnessRun) {
        liveHarnessRun.context = {
          ...deliveredContext.context,
          contextMode: promptMode,
          sessionRotated: session.rotated,
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
    let parentAbortObserved = false
    let agentCallbacksClosed = false
    let parentAbortHandler = null
    let parentAbortPromise = null
    let runPromise = null
    let attemptProgress = []
    const resolvedGateIds = []
    const pendingPermissionCallbacks = new Set()
    let resumedPermissionUsed = false
    let resumedPermissionError = null
    let anonymousToolCallSequence = 0
    const startedAt = Date.now()
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
    // Automatic discussions must make progress between rounds even when an
    // Agent keeps emitting heartbeat events without ever returning a result,
    // so they get the strict startup and no-progress limits.
    const watchdog = createInvocationWatchdog({
      timeoutMs: this.runAgentTimeoutMs,
      toolTimeoutMs: this.runAgentToolTimeoutMs,
      strict: mode === 'auto',
      maxDurationMs: mode === 'auto' && context.v4 === true
        && ['proposal', 'discussion'].includes(context.phase)
        ? DEFAULT_AUTO_AGENT_INVOCATION_MAX_MS : 0,
      answerIdleMs: mode === 'auto' && context.v4 === true
        && ['proposal', 'discussion'].includes(context.phase)
        ? DEFAULT_AUTO_AGENT_ANSWER_IDLE_MS : 0,
      maxToolCalls: mode === 'auto' && context.v4 === true
        && ['proposal', 'discussion'].includes(context.phase)
        ? DEFAULT_AUTO_AGENT_TOOL_CALL_LIMIT : 0,
      isStopped: () => parentAbortObserved || Boolean(signal?.aborted)
        || agentController.signal.aborted,
      onTimeout: () => agentController.abort(),
    })
    const closeAgentCallbacks = () => {
      agentCallbacksClosed = true
      watchdog.close()
    }
    const outputs = new InvocationOutputs({
      enabled: allowWrite,
      workdir: group.workdir,
      signal: agentController.signal,
      agentKind: kind,
      startedAt,
      deps: {
        captureAgentOutputs: (...args) => this.captureAgentOutputs(...args),
        captureArtifactOutputs: (...args) => this.captureArtifactOutputs(...args),
        importAgentOutputs: (...args) => this.importAgentOutputs(...args),
        captureAgentOutcomeDescriptors: (...args) => this.captureAgentOutcomeDescriptors(...args),
      },
    })
    const waitForHumanGate = async (operation) => {
      watchdog.pause()
      try {
        return invocation.lease?.suspend
          ? await invocation.lease.suspend(operation, context.v4 === true
            && context.parallelGraph === true ? { pauseTask: true } : undefined)
          : await operation()
      } finally {
        if (!agentController.signal.aborted) watchdog.resume()
      }
    }
    const onProgress = (step) => {
      if (agentCallbacksClosed || agentController.signal.aborted
          || !activeRun || this.activeRuns.get(group.id) !== activeRun) return
      watchdog.establish()
      watchdog.progress()
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
    const answerFilter = createAnswerMarkerFilter({
      mode: context.v4 === true ? 'receipt' : (mode === 'auto' ? 'auto' : 'plain'),
    })
    let flushingTerminalAnswer = false
    const emitHarnessEvent = (rawEvent) => {
      if (agentCallbacksClosed || (agentController.signal.aborted && !flushingTerminalAnswer)
          || this.activeRuns.get(group.id) !== activeRun
          || !harness || !harnessRun || !rawEvent) return
      const event = harness.ingest(kind, round, rawEvent, harnessRun.agentRunId)
      if (!event) return
      // Once a connector has produced a real runtime event, the process is
      // demonstrably alive. Active tools use a longer shared inactivity window.
      watchdog.establish()
      const eventType = String(event.type || '').toLowerCase()
      const eventStatus = String(event.status || '').toLowerCase()
      if (['tool_start', 'tool_update'].includes(eventType)
          && ['queued', 'running', 'waiting', 'in_progress', 'streaming'].includes(eventStatus)) {
        const toolId = String(event.id || '')
        const accepted = toolId
          ? watchdog.toolStarted(toolId)
          : (eventType === 'tool_start'
            ? watchdog.toolStarted(`anonymous-${++anonymousToolCallSequence}`)
            : (watchdog.toolProgress(), true))
        if (!accepted) return
      } else if (eventType === 'tool_result_summary'
          || (eventType === 'status' && ['completed', 'failed', 'stopped', 'timeout', 'interrupted']
            .includes(eventStatus))) {
        watchdog.toolFinished(event.id)
      }
      if (eventType === 'answer_delta' && event.delta) watchdog.answer()
      this.emitRunEvent(event)
      this.armAgentSilence(activeRun, kind, round, harnessRun.agentRunId)
      if (event.type !== 'answer_delta' || event.seq % 8 === 0) {
        this.scheduleRunCheckpoint(group.id, activeRun)
        this.emitChanged()
      }
    }
    const emitRuntimeEvent = (rawEvent) => {
      if (agentCallbacksClosed || agentController.signal.aborted) return
      watchdog.progress()
      if (!rawEvent || rawEvent.type !== 'answer_delta'
          || (context.v4 !== true && mode !== 'auto')) {
        emitHarnessEvent(rawEvent)
        return
      }
      const visible = answerFilter.push(rawEvent.delta)
      if (visible) emitHarnessEvent({ ...rawEvent, delta: visible })
    }
    const flushRuntimeEvent = (finalText = '') => {
      const rest = answerFilter.flush(finalText)
      if (rest) emitHarnessEvent({ type: 'answer_delta', status: 'running', delta: rest })
    }
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
      const binding = session.binding()
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
      flushingTerminalAnswer = true
      flushRuntimeEvent(finalText)
      flushingTerminalAnswer = false
      closeAgentCallbacks()
      this.clearAgentSilence(activeRun, kind, round, harnessRun.agentRunId)
      const finished = harness.finishAgent(kind, round, status, finalText, {
        ...deliveredContext.context,
        contextMode: promptMode,
        sessionRotated: session.rotated,
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
      await outputs.begin()
      const nativeImageLimit = Math.max(
        0,
        Math.floor(Number(this.attachmentSupport(kind)?.image) || 0),
      )
      // Frozen prompts are fixed text, but the user's attachments still have
      // to reach the Agent; only isolated invocations see nothing but their
      // approved prompt.
      stagedInputs = isolated
        ? null
        : stageAgentInputs(group.workdir, context.attachmentSnapshots || [], nativeImageLimit)
      const preferencesText = isolated ? '' : workPreferencesPrompt(this.state().workPreferences)
      const buildPrompt = (afterKind, contextPackage) => [assembleInvocationPrompt({
        group,
        kind,
        mode,
        threadRootId,
        context,
        activeRun,
        isolated,
        frozen,
        v4Prompt,
        promptMode,
        afterKind,
        packed: contextPackage,
        session,
        stagedInputs,
        promptFor: (...args) => this.promptFor(...args),
        agentLabel: label => this.agentLabel(label),
      }), preferencesText].filter(Boolean).join('\n\n')
      let prompt = buildPrompt(transcriptAfterKind, packedContext)
      const recordOutboundPayload = (outbound = {}) => {
        watchdog.progress()
        recordOutboundUsage(activeRun?.budget, outbound)
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
          attachments: isolated ? [] : (context.attachmentSnapshots || []),
          skillHints: isolated || frozen ? [] : (context.skillHints || []),
          knowledgeBaseHints: isolated ? [] : (context.knowledgeBaseHints || []),
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
          sessionProvenance: session.provenance,
        })
        deliveryContext = {
          contextPackId: attempt.record.contextPackId,
          deliveryRecordIds: [
            ...deliveryContext.deliveryRecordIds,
            delivery.deliveryRecordId,
          ].slice(-8),
          sessionProvenance: session.provenance,
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
            sessionRotated: session.rotated,
            ...deliveryContext,
            ...connectorContext,
          }
        }
        this.checkpointRun(group.id, activeRun)
        this.emitChanged()
      }
      const rebuildFreshSession = () => {
        session.discard()
        promptMode = 'bootstrap'
        deliveryContext = { ...deliveryContext, sessionProvenance: session.provenance }
        transcriptAfterKind = ''
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
            sessionRotated: session.rotated,
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
        sessionRef: session.ref,
        ...(Number.isInteger(context.executionSequence)
          ? { executionSequence: context.executionSequence }
          : {}),
        onSessionRef: (nextSessionRef, metadata = {}) => {
          if (agentCallbacksClosed || agentController.signal.aborted) return
          watchdog.progress()
          if (reviewOnly || isolated) return
          session.adopt(nextSessionRef, metadata)
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
            watchdog.establish()
            watchdog.progress()
          } else {
            watchdog.liveness()
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
            const automatic = automaticPermissionResponse(request, { allowWrite })
            if (automatic !== undefined) return Promise.resolve(automatic)
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
            const binding = session.binding()
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
        sessionTransport: session.transport,
        ...(kind === 'workbuddy' && Number.isInteger(context.maxInternalTurns)
          ? { maxTurns: context.maxInternalTurns }
          : {}),
        attachments: isolated ? [] : (stagedInputs?.nativeImagePaths || []),
        // ACP runtimes are shared by the stable group/task session key. OpenClaw
        // is excluded because its gateway wrapper owns the process lifetime and
        // is intentionally torn down after each invocation.
        ...(kind !== 'openclaw' ? { acpPersistenceKey: session.key } : {}),
        ...(kind === 'hermes'
          ? { hermesAcpAvailable: HERMES_WORKSPACE_ACP_ENABLED && agent.acpAvailable !== false }
          : {}),
      }
      const runCurrentSession = () => {
        const currentRunOptions = {
          ...runOptions, sessionRef: session.ref, sessionTransport: session.transport,
        }
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
              watchdog.establish()
              watchdog.progress()
            } else {
              watchdog.liveness()
            }
          },
          onConnectorState: (nextContext) => {
            watchdog.progress()
            connectorContext = nextContext
            const liveHarnessRun = harness.current(kind, round, harnessRun.agentRunId)
            if (liveHarnessRun) {
              liveHarnessRun.context = {
                ...deliveredContext.context,
                contextMode: promptMode,
                sessionRotated: session.rotated,
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
        const reusedSessionRef = session.ref
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
        const pending = [runPromise, watchdog.promise]
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
        if (waitingSessionRef && waitingSessionRef !== session.ref) {
          runOptions.onSessionRef(waitingSessionRef)
          session.ref = waitingSessionRef
        }
        const binding = session.binding()
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
        recordReplyUsage(activeRun.budget, {
          usage: result.usage,
          replyText: reply.text,
          toolCallCount: toolCalls.length,
        })
        this.checkpointRun(group.id, activeRun)
      }
      const attachments = await outputs.importMedia(reply.text)
      if (agentController.signal.aborted) throw agentStoppedError()
      const descriptors = await outputs.describeOutcomes({
        runId: activeRun?.runId,
        agentRunId: harnessRun?.agentRunId,
      })
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
        session.complete(result.sessionRef, {
          promptChars: prompt.length,
          replyChars: reply.text.length,
          rotated: session.rotated,
          transport: session.transport,
          lastDeliveredMessageId: packedContext.latestMessageId || session.meta.lastDeliveredMessageId,
        })
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
          v4SessionBinding: connectorSessionBinding(result.sessionRef || session.ref, session.provenance),
        } : {}),
      }
    } catch (caughtError) {
      const stop = resolveInvocationStop({
        caughtError, signal, parentAbortObserved, activeRun, agentController, watchdog,
      })
      if (stop.settleOutstanding) {
        const cleanupPromises = [runPromise, ...outputs.pending()].filter(Boolean)
        if (cleanupPromises.length) {
          await settleWithin(Promise.allSettled(cleanupPromises), this.runAbortGraceMs)
        }
      }
      const { error } = stop
      // Only an explicit sign-in failure changes readiness. Network, quota and
      // provider refusals stay run-scoped so a healthy Agent remains usable.
      if (error?.code === 'LOCAL_AGENT_AUTH_REQUIRED'
          && context.deferCredentialFailure !== true) {
        this.markRuntimeCredential(kind, 'missing')
      }
      // Failure and stop notices take the turn's slot in the timeline.
      attachErrorMetadata(error, {
        runTrace: finishHarness(stop.status),
        turnSeq: context.turnSeq,
      })
      throw attachInvocationFailure(error, {
        outcomeCertainty: terminalFailureKnown
          ? 'known_failed'
          : (operationStarted || sideEffectsStarted ? 'unknown_outcome' : 'not_started'),
        sideEffectsPossible: allowWrite && sideEffectsStarted,
        operationId,
        idempotencyMode,
      })
    } finally {
      closeAgentCallbacks()
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
        const provenance = createdSessionProvenance(cleanText(taskId, 120))
        state.sessions[key] = this.openClawSessionRef(group, generation)
        state.sessionMeta[key] = normalizeSessionMeta(provenanceMeta(provenance))
        changed = true
      }
      return changed
    })
  }
}

module.exports = { LocalWorkspaceAgentInvocation }

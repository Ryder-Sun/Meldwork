const path = require('node:path')
const { createHash } = require('node:crypto')
const {
  KNOWLEDGE_BASE_KINDS,
  MAX_KNOWLEDGE_BASE_HINTS,
  MAX_MESSAGE_ATTACHMENTS,
  MAX_SKILL_HINTS,
  USER_ATTACHMENT_MIME_TYPES,
  abortableOperation,
  attachmentLimitError,
  attachmentType,
  cleanInline,
  cleanText,
  knowledgeBaseHintsPrompt,
  normalizeAttachmentMetadata,
  normalizeAutoRounds,
  normalizeKnowledgeBaseHint,
  normalizeSkillHint,
  normalizeTargetKinds,
  skillHintsPrompt,
  terminalRunStatusForReason,
} = require('./local-workspace-inputs.cjs')
const { MAX_RUN_AGENT_ATTEMPTS } = require('../runs/failure-policy.cjs')
const { createTaskGraph } = require('../collaboration/task-graph-records.cjs')
const { assertLocalSkillExecution } = require('../skills/local-skill-contract.cjs')
const {
  ROLES,
  appendBlackboardEntry,
  createBlackboardEntryRecord,
  emptyCollaborationState,
  roleForIndex,
} = require('../collaboration/collaboration-records.cjs')
const { canonicalJson } = require('../collaboration/context-pack-records.cjs')
const {
  createCollaborationReceipt,
  createOrchestrationV4,
  hashValue,
  parseOrchestrationV4,
} = require('../collaboration/orchestration-v4-records.cjs')
const {
  restoreV4SnapshotSkills,
  v4Snapshot,
  v4SnapshotBodyHash,
  v4SnapshotSkillHints,
  validateV4SnapshotBody,
} = require('./local-workspace-context.cjs')
const { manualReplyPrompt } = require('./prompts/manual-reply-prompt.cjs')
const { agentRuntimeCapabilities } = require('../agents/agent-runtime-contract.cjs')

const DISCUSSION_STYLES = new Set(['sequential', 'agent-led'])

function hardBudgetFailure(error) {
  return error?.code === 'LOCAL_BUDGET_EXHAUSTED'
    || error?.message === 'LOCAL_BUDGET_EXHAUSTED'
}

function circuitBreakerFailure(error) {
  return error?.code === 'LOCAL_RUN_CIRCUIT_BREAKER'
    || error?.message === 'LOCAL_RUN_CIRCUIT_BREAKER'
}

function isV4ManualUnknownWriter(slot) {
  return slot?.permission === 'workspace-write'
    && slot.status === 'running'
    && slot.commitStatus !== 'committed'
    && Number.isSafeInteger(slot.attempt)
    && slot.attempt > 0
}

function v4ManualRecoveryGateInput(runId, batchId, slot) {
  return {
    type: 'retry',
    runId,
    agentRunId: slot.operationId,
    agentKind: slot.agentKind,
    summary: 'The recovered workspace-write Agent attempt may already have changed the workspace.',
    options: [
      { optionId: 'retry-once', name: 'Retry once', kind: 'allow_once' },
      { optionId: 'cancel-retry', name: 'Do not retry', kind: 'reject_once' },
    ],
    request: {
      phase: 'manual-writer-recovery',
      batchId,
      slotId: slot.slotId,
      operationId: slot.operationId,
      attempt: slot.attempt,
      outcomeCertainty: 'unknown_outcome',
      sideEffectsPossible: true,
    },
  }
}

function stalePermissionResumeFailure(error, resumedGate) {
  const code = String(error?.code || error?.message || '')
  return resumedGate?.type === 'permission'
    && ['LOCAL_RUN_PERMISSION_RESUME_UNAVAILABLE', 'LOCAL_AGENT_SESSION_INVALID'].includes(code)
}

class LocalWorkspaceMessageSubmission {
  constructor(options) {
    this.state = options.state
    this.detectedAgents = options.detectedAgents
    this.isShuttingDown = options.isShuttingDown
    this.resolveAttachmentsFn = options.resolveAttachments
    this.attachmentSupport = options.attachmentSupport
    this.validateSkillSelections = options.validateSkillSelections
    this.validateKnowledgeBaseSelections = options.validateKnowledgeBaseSelections
    this.getGroup = options.getGroup
    this.isGroupBusy = options.isGroupBusy
    this.reserveRun = options.reserveRun
    this.bindRunTask = options.bindRunTask
    this.releasePreparation = options.releasePreparation
    this.addMessage = options.addMessage
    this.reserveTurnSeqs = typeof options.reserveTurnSeqs === 'function'
      ? options.reserveTurnSeqs
      : () => []
    this.rollbackAddedMessage = options.rollbackAddedMessage
    this.startAutoRunner = options.startAutoRunner
    this.beginRun = options.beginRun
    this.invokeAgent = options.invokeAgent
    this.invokeWithRecovery = options.invokeWithRecovery
    this.recordAgentInterruption = options.recordAgentInterruption
    this.recordAgentFailure = options.recordAgentFailure
    this.emitChanged = options.emitChanged
    this.snapshot = options.snapshot
    this.finishRun = options.finishRun
    this.createContextPack = options.createContextPack
    this.configureRunBudget = options.configureRunBudget
    this.resetAgentSession = options.resetAgentSession
    this.refreshAgents = options.refreshAgents
    this.consumeAgentControl = options.consumeAgentControl
    this.checkpointRun = options.checkpointRun
    this.hasRunLedger = options.hasRunLedger || (() => false)
    this.routeAgents = options.routeAgents
    this.contentBlobStore = options.contentBlobStore
    this.outcomeStore = options.outcomeStore
    this.commitV4AgentMessage = options.commitV4AgentMessage
    this.requestHumanGate = options.requestHumanGate
    this.completeHumanGateContinuation = options.completeHumanGateContinuation
  }

  async resolveAttachments(attachmentRefs, signal) {
    if (!Array.isArray(attachmentRefs)) throw new Error('LOCAL_ATTACHMENT_REFERENCE_INVALID')
    if (attachmentRefs.length > MAX_MESSAGE_ATTACHMENTS) {
      throw new Error('LOCAL_ATTACHMENT_COUNT_LIMIT')
    }
    const resolved = attachmentRefs.length
      ? await abortableOperation(() => this.resolveAttachmentsFn(attachmentRefs), signal)
      : []
    if (!Array.isArray(resolved) || resolved.length !== attachmentRefs.length) {
      throw new Error('LOCAL_ATTACHMENT_REFERENCE_INVALID')
    }
    return resolved.map((attachment) => {
      const metadata = normalizeAttachmentMetadata(attachment)
      if (!metadata || typeof attachment.path !== 'string' || !path.isAbsolute(attachment.path)) {
        throw new Error('LOCAL_ATTACHMENT_REFERENCE_INVALID')
      }
      if (!USER_ATTACHMENT_MIME_TYPES.has(metadata.mimeType)) {
        throw new Error('LOCAL_ATTACHMENT_REFERENCE_INVALID')
      }
      return { ...metadata, path: path.normalize(attachment.path) }
    })
  }

  validateAttachmentSupport(targetKinds, attachments) {
    const values = Array.isArray(attachments) ? attachments : []
    for (const kind of targetKinds) {
      const support = this.attachmentSupport(kind) || {}
      const counts = new Map()
      for (const attachment of values) {
        const type = attachmentType(attachment?.mimeType)
        if (!type) throw new Error('LOCAL_ATTACHMENT_REFERENCE_INVALID')
        const count = (counts.get(type) || 0) + 1
        counts.set(type, count)
        const nativeLimit = Math.max(0, Math.min(
          MAX_MESSAGE_ATTACHMENTS,
          Math.floor(Number(support[type]) || 0),
        ))
        const fileFallbackLimit = Math.max(0, Math.min(
          MAX_MESSAGE_ATTACHMENTS,
          Math.floor(Number(support.file) || 0),
        ))
        const limit = Math.max(nativeLimit, fileFallbackLimit)
        if (!limit) throw new Error(attachmentLimitError(type))
        if (count > limit) throw new Error(attachmentLimitError(type, true))
      }
    }
  }

  async preflight(group, targetKinds, input, reservation) {
    const text = cleanText(input.text)
    const attachments = await this.resolveAttachments(input.attachments || [], reservation.signal)
    if (reservation.signal.aborted || this.isShuttingDown()) {
      throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
    }
    if (!text && !attachments.length) throw new Error('LOCAL_MESSAGE_REQUIRED')
    this.validateAttachmentSupport(targetKinds, attachments)

    const requestedSkillHints = input.skillHints || []
    const skillHintsByKind = new Map()
    const publicSkillHintsByKind = new Map()
    for (const kind of targetKinds) {
      const scoped = requestedSkillHints.filter(skill => skill?.targetKind === kind)
      const validated = await abortableOperation(
        () => this.validateSkillSelections(kind, scoped),
        reservation.signal,
      )
      if (reservation.signal.aborted || this.isShuttingDown()) {
        throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
      }
      if (!Array.isArray(validated) || validated.some(skill => skill?.targetKind !== kind)) {
        throw new Error('LOCAL_SKILL_SELECTION_INVALID')
      }
      const agent = this.detectedAgents().find(candidate => candidate.kind === kind)
      for (const skill of validated) {
        if (!skill?.approvedSkillManifest) continue
        assertLocalSkillExecution(skill.approvedSkillManifest, {
          kind,
          version: agent?.resolvedVersion || agent?.version,
          inputTypes: ['text', ...new Set(attachments.map(attachment => (
            attachmentType(attachment.mimeType)
          )).filter(Boolean))],
          capabilities: agent?.capabilities,
          permissionMode: group.allowWrite === true ? 'workspace-write' : 'read-only',
          credentialIds: [],
        })
      }
      const publicHints = validated.map(normalizeSkillHint).filter(Boolean)
      if (publicHints.length !== validated.length) {
        throw new Error('LOCAL_SKILL_SELECTION_INVALID')
      }
      skillHintsByKind.set(kind, validated)
      publicSkillHintsByKind.set(kind, publicHints)
    }
    const requestedKnowledgeBaseHints = input.knowledgeBaseHints || []
    const validatedKnowledgeBaseHints = await abortableOperation(
      () => this.validateKnowledgeBaseSelections(targetKinds, requestedKnowledgeBaseHints),
      reservation.signal,
    )
    if (reservation.signal.aborted || this.isShuttingDown()) {
      throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
    }
    const knowledgeBaseHints = (Array.isArray(validatedKnowledgeBaseHints)
      ? validatedKnowledgeBaseHints
      : []).map((source) => {
      const publicHint = normalizeKnowledgeBaseHint(source)
      if (!publicHint) return null
      return source?.connectorSource
        ? { ...publicHint, connectorSource: source.connectorSource }
        : publicHint
    }).filter(Boolean)
    if (knowledgeBaseHints.length !== requestedKnowledgeBaseHints.length
        || knowledgeBaseHints.some(source => (
          source.targetKinds.some(kind => !targetKinds.includes(kind))
        ))) {
      throw new Error('LOCAL_KNOWLEDGE_BASE_SELECTION_INVALID')
    }
    const knowledgeBaseHintsByKind = new Map(targetKinds.map(kind => [
      kind,
      knowledgeBaseHints.filter(source => source.targetKinds.includes(kind)),
    ]))
    return {
      text,
      attachments,
      skillHintsByKind,
      skillHints: targetKinds.flatMap(kind => publicSkillHintsByKind.get(kind) || []),
      knowledgeBaseHintsByKind,
      knowledgeBaseHints,
      storedKnowledgeBaseHints: knowledgeBaseHints.filter(source => !source.connectorSource),
    }
  }

  validateInput(group, input) {
    const mode = input.mode === 'auto' && group.conversationType !== 'direct'
      ? 'auto'
      : 'manual'
    const inputTypes = ['text', ...new Set((Array.isArray(input.attachments)
      ? input.attachments
      : []).map(attachment => attachmentType(attachment?.mimeType)).filter(Boolean))]
    const routingDecision = this.routeAgents({
      agents: this.detectedAgents(),
      group,
      input,
      mode,
      inputTypes,
      minContextChars: Math.max(1, cleanText(input.text).length),
    })
    const targetKinds = routingDecision.selectedKinds
    if (mode === 'auto' && !targetKinds.length) throw new Error('LOCAL_AUTO_AGENT_COUNT')
    if (input.mentionedAgentKinds != null && !Array.isArray(input.mentionedAgentKinds)) {
      throw new Error('LOCAL_MESSAGE_TARGET_REQUIRED')
    }
    const mentionedAgentKinds = normalizeTargetKinds(input.mentionedAgentKinds)
    if (mentionedAgentKinds.some(kind => !targetKinds.includes(kind))) {
      throw new Error('LOCAL_MESSAGE_TARGET_REQUIRED')
    }
    if (input.skillHints != null && !Array.isArray(input.skillHints)) {
      throw new Error('LOCAL_SKILL_SELECTION_INVALID')
    }
    const requestedSkillHints = input.skillHints || []
    if (requestedSkillHints.length > MAX_SKILL_HINTS) throw new Error('LOCAL_SKILL_LIMIT')
    if (requestedSkillHints.some(skill => !targetKinds.includes(String(skill?.targetKind || '')))) {
      throw new Error('LOCAL_SKILL_SELECTION_INVALID')
    }
    if (input.knowledgeBaseHints != null && !Array.isArray(input.knowledgeBaseHints)) {
      throw new Error('LOCAL_KNOWLEDGE_BASE_SELECTION_INVALID')
    }
    const requestedKnowledgeBaseHints = input.knowledgeBaseHints || []
    if (requestedKnowledgeBaseHints.length > MAX_KNOWLEDGE_BASE_HINTS) {
      throw new Error('LOCAL_KNOWLEDGE_BASE_SELECTION_INVALID')
    }
    const requestedKnowledgeKinds = new Set()
    for (const source of requestedKnowledgeBaseHints) {
      const kind = cleanInline(source?.kind, 40)
      const sourceTargets = normalizeTargetKinds(source?.targetKinds)
      if (!KNOWLEDGE_BASE_KINDS.has(kind) || requestedKnowledgeKinds.has(kind)
          || !sourceTargets.length || sourceTargets.some(target => !targetKinds.includes(target))) {
        throw new Error('LOCAL_KNOWLEDGE_BASE_SELECTION_INVALID')
      }
      requestedKnowledgeKinds.add(kind)
    }
    const unlimitedRounds = mode === 'auto' && input.unlimitedRounds === true
    const maxRounds = mode === 'auto' && !unlimitedRounds
      ? normalizeAutoRounds(input.maxRounds ?? input.maxTurns)
      : 0
    let taskGraph = null
    if (input.workflow != null) {
      if (mode !== 'auto') throw new Error('LOCAL_WORKFLOW_UNSUPPORTED')
      if (input.workflow?.template !== 'task-graph') {
        throw new Error('LOCAL_WORKFLOW_UNSUPPORTED')
      }
      try {
        taskGraph = createTaskGraph(input.workflow, targetKinds)
      } catch {
        throw new Error('LOCAL_WORKFLOW_INVALID')
      }
    }
    const requestedThreadRootId = mode === 'manual' ? cleanText(input.threadRootId, 100) : ''
    const regenerateMessageId = cleanText(input.regenerateMessageId, 100)
    if (input.regenerateMessageId != null && !regenerateMessageId) {
      throw new Error('LOCAL_MESSAGE_REGENERATION_INVALID')
    }
    if (regenerateMessageId && (mode !== 'manual' || targetKinds.length !== 1)) {
      throw new Error('LOCAL_MESSAGE_REGENERATION_INVALID')
    }
    const v4 = (mode === 'manual' || mode === 'auto')
      && group.conversationType !== 'direct'
      && (targetKinds.length > 1 || (mode === 'auto' && targetKinds.length === 1))
      && !regenerateMessageId
      && input.protocol !== 'legacy'
      && this.v4Requested(input)
    const requestedDiscussionStyle = input.discussionStyle == null
      ? ''
      : cleanInline(input.discussionStyle, 40)
    if (requestedDiscussionStyle && !DISCUSSION_STYLES.has(requestedDiscussionStyle)) {
      throw new Error('LOCAL_DISCUSSION_STYLE_INVALID')
    }
    if (requestedDiscussionStyle && (mode !== 'auto' || !v4)) {
      throw new Error('LOCAL_DISCUSSION_STYLE_UNSUPPORTED')
    }
    return {
      mode,
      targetKinds,
      v4,
      discussionStyle: mode === 'auto' && v4
        ? (requestedDiscussionStyle || 'sequential')
        : '',
      unlimitedRounds,
      maxRounds,
      requestedThreadRootId,
      regenerateMessageId,
      routingDecision,
      taskGraph,
    }
  }

  resolveRegeneration(group, messageId, targetKinds) {
    if (!messageId) return null
    const messages = this.state().messages
    const sourceIndex = messages.findIndex(message => (
      message.id === messageId && message.groupId === group.id
    ))
    const sourceMessage = messages[sourceIndex]
    const targetKind = targetKinds[0]
    if (sourceIndex < 0 || sourceMessage?.role !== 'agent'
        || sourceMessage.agentKind !== targetKind) {
      throw new Error('LOCAL_MESSAGE_REGENERATION_INVALID')
    }
    let userMessage = null
    if (sourceMessage.threadRootId) {
      userMessage = messages.find(message => (
        message.id === sourceMessage.threadRootId
        && message.groupId === group.id
        && message.role === 'user'
      ))
    } else if (group.conversationType === 'direct') {
      for (let index = sourceIndex - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (message.groupId === group.id && message.role === 'user' && !message.threadRootId) {
          userMessage = message
          break
        }
      }
    }
    if (!userMessage) throw new Error('LOCAL_MESSAGE_REGENERATION_INVALID')
    return {
      sourceMessage,
      userMessage,
      responseVersionRootId: cleanText(
        sourceMessage.responseVersionRootId || sourceMessage.id,
        100,
      ),
    }
  }

  regenerationInput(input, regeneration, targetKind) {
    const message = regeneration.userMessage
    return {
      ...input,
      text: message.content,
      attachments: Array.isArray(message.attachments) ? message.attachments : [],
      skillHints: (Array.isArray(message.skillHints) ? message.skillHints : [])
        .filter(skill => skill.targetKind === targetKind),
      knowledgeBaseHints: (Array.isArray(message.knowledgeBaseHints)
        ? message.knowledgeBaseHints
        : []).filter(source => source.targetKinds?.includes(targetKind)).map(source => ({
        ...source,
        targetKinds: [targetKind],
      })),
    }
  }

  regenerationInstruction() {
    return [
      'Produce a fresh alternative response to the user request.',
      'Re-evaluate the task independently and return the best complete answer.',
      'Do not mention response versions, regeneration, or the previous answer.',
    ].join('\n')
  }

  replacementInstruction(failedKind) {
    const agent = this.detectedAgents().find(candidate => candidate.kind === failedKind)
    const label = cleanInline(agent?.name, 60) || failedKind
    return [
      `You are replacing ${label} for this turn.`,
      'Complete the interrupted Agent slot using the shared task context, then return your own conclusion.',
      'Do not claim that the interrupted Agent completed this work.',
    ].join('\n')
  }

  v4Requested(input) {
    if (input?.protocol === 'legacy' || input?.harnessVersion === 3) return false
    return input?.protocol === 'v4'
      || input?.harnessVersion === 4
      || input?.collaborationVersion === 4
      || input?.v4 === true
  }

  v4BatchId(controller, phase = 'proposal') {
    const digest = createHash('sha256').update(JSON.stringify([
      controller.runId,
      controller.taskId,
      phase,
      controller.currentRound || 0,
    ])).digest('hex').slice(0, 32)
    return `batch-${digest}`
  }

  v4WriterKind(controller, targetKinds, seed = '') {
    const kinds = Array.isArray(targetKinds) ? targetKinds : []
    if (!kinds.length) return ''
    const digest = createHash('sha256').update(JSON.stringify([
      controller?.runId || '', controller?.taskId || '', seed, kinds,
    ])).digest('hex')
    return kinds[Number.parseInt(digest.slice(0, 8), 16) % kinds.length]
  }

  checkpointV4Manual(group, controller) {
    if (this.hasRunLedger() && this.checkpointRun(group.id, controller) !== true) {
      throw new Error('LOCAL_RUN_PERSIST_FAILED')
    }
    this.emitChanged()
  }

  persistV4Snapshot(controller, snapshot, targetKinds) {
    if (!this.contentBlobStore) throw new Error('LOCAL_RUN_SNAPSHOT_STORE_UNAVAILABLE')
    const serialized = canonicalJson(snapshot)
    const contentRef = this.contentBlobStore.put(serialized, { mediaType: 'application/json' })
    const sourceIds = [snapshot?.messageId, ...(snapshot?.history || []).map(item => item.id)]
      .filter(Boolean).slice(-64)
    const record = {
      contextPackId: controller.contextPackId || null,
      taskId: snapshot?.taskId || controller.taskId || null,
      messageId: snapshot?.messageId || controller.threadRootId || null,
      groupId: snapshot?.group?.id || controller.groupId || null,
      round: Math.max(0, Number(controller.currentRound) || 0),
      targetKinds: [...targetKinds],
      sourceIds,
      capturedAt: Date.now(),
      charCount: Buffer.byteLength(serialized),
      contentHash: contentRef.hash,
      bodyHash: v4SnapshotBodyHash(snapshot),
      contentRef,
    }
    return { body: snapshot, record, hash: hashValue(record) }
  }

  loadV4Snapshot(orchestration, bindings) {
    const snapshotRecord = orchestration?.snapshot
    if (!snapshotRecord?.contentRef || !this.contentBlobStore) {
      throw new Error('LOCAL_RUN_SNAPSHOT_INVALID')
    }
    let bytes
    try { bytes = this.contentBlobStore.read(snapshotRecord.contentRef) } catch {
      throw new Error('LOCAL_RUN_SNAPSHOT_INVALID')
    }
    let body
    try { body = JSON.parse(bytes.toString('utf8')) } catch {
      throw new Error('LOCAL_RUN_SNAPSHOT_INVALID')
    }
    return validateV4SnapshotBody({
      body,
      serialized: bytes.toString('utf8'),
      byteLength: bytes.length,
      record: snapshotRecord,
      orchestrationSnapshotHash: orchestration.snapshotHash,
      ...bindings,
    })
  }

  v4ResultBodyRecord(controller, slot, pendingMessage) {
    if (!pendingMessage || pendingMessage.role !== 'agent'
        || !this.contentBlobStore || !this.outcomeStore) {
      throw new Error('LOCAL_RUN_RESULT_BODY_INVALID')
    }
    const trace = pendingMessage.metadata?.trace
    const body = JSON.parse(JSON.stringify({
      version: 1,
      agentKind: slot.agentKind,
      slotId: slot.slotId,
      operationId: slot.operationId,
      threadRootId: pendingMessage.threadRootId || '',
      content: pendingMessage.content,
      metadata: {
        ...(pendingMessage.metadata?.elapsedMs != null
          ? { elapsedMs: pendingMessage.metadata.elapsedMs } : {}),
        ...(Array.isArray(pendingMessage.metadata?.toolCalls)
          ? { toolCalls: pendingMessage.metadata.toolCalls } : {}),
        ...(Array.isArray(pendingMessage.metadata?.attachments)
          ? { attachments: pendingMessage.metadata.attachments } : {}),
        ...(pendingMessage.metadata?.responseVersionRootId
          ? { responseVersionRootId: pendingMessage.metadata.responseVersionRootId } : {}),
        ...(trace ? { trace } : {}),
        ...(pendingMessage.metadata?.turnSeq ? { turnSeq: pendingMessage.metadata.turnSeq } : {}),
      },
    }))
    const contentRef = this.contentBlobStore.put(canonicalJson(body), {
      mediaType: 'application/json',
    })
    return this.outcomeStore.putArtifact({
      type: 'structured-data',
      name: `${slot.agentKind}-manual-v4-result.json`,
      producedBy: {
        runId: controller.runId,
        agentRunId: String(trace?.agentRunId || slot.operationId),
        agentKind: slot.agentKind,
      },
      contentRef,
      contentHash: contentRef.hash,
    })
  }

  loadV4ResultBody(slot) {
    if (!slot?.resultBodyArtifactId || !this.outcomeStore || !this.contentBlobStore) {
      throw new Error('LOCAL_RUN_RESULT_BODY_INVALID')
    }
    let artifact
    let bytes
    try {
      artifact = this.outcomeStore.getArtifact(slot.resultBodyArtifactId)
      bytes = this.contentBlobStore.read(artifact.contentRef)
    } catch {
      throw new Error('LOCAL_RUN_RESULT_BODY_INVALID')
    }
    let body
    try { body = JSON.parse(bytes.toString('utf8')) } catch {
      throw new Error('LOCAL_RUN_RESULT_BODY_INVALID')
    }
    if (canonicalJson(body) !== bytes.toString('utf8')
        || body?.version !== 1
        || body.agentKind !== slot.agentKind
        || body.slotId !== slot.slotId
        || body.operationId !== slot.operationId
        || typeof body.content !== 'string'
        || !body.metadata || typeof body.metadata !== 'object' || Array.isArray(body.metadata)) {
      throw new Error('LOCAL_RUN_RESULT_BODY_INVALID')
    }
    return body
  }

  v4BlackboardEntry(controller, targetKinds, slot, receipt, resultBody, outcomeRefs) {
    return createBlackboardEntryRecord({
      entryType: 'claim',
      subject: `Manual response from ${slot.agentKind}`,
      statement: receipt.summary,
      value: receipt.summary,
      owner: {
        type: 'agent',
        agentKind: slot.agentKind,
        role: roleForIndex(targetKinds.indexOf(slot.agentKind)),
      },
      audience: { roles: [...ROLES], agentKinds: [] },
      lifecycle: {
        state: 'active',
        sequence: targetKinds.indexOf(slot.agentKind) + 1,
        recordedAt: slot.finishedAt,
        supersedesEntryId: null,
      },
      provenance: {
        runId: controller.runId,
        taskId: controller.taskId,
        round: 1,
        agentRunId: resultBody.metadata?.trace?.agentRunId || slot.operationId,
        artifactIds: outcomeRefs.artifactIds,
        evidenceIds: outcomeRefs.evidenceIds,
      },
      refs: [...new Set([
        ...outcomeRefs.artifactIds,
        ...outcomeRefs.evidenceIds,
        slot.resultBodyArtifactId,
      ])],
    })
  }

  v4Orchestration({ controller, workflow, template, phase, batchId, snapshotRecord, slots,
    writerKind, targetKinds, collaboration = emptyCollaborationState(), commitState = null }) {
    const slotList = Array.isArray(slots) ? slots : []
    if (!snapshotRecord) throw new Error('LOCAL_RUN_SNAPSHOT_INVALID')
    const snapshotHash = hashValue(snapshotRecord)
    const normalizedPhase = phase
    const assignments = slotList.map((slot, index) => ({
      agentKind: slot.agentKind,
      slotId: slot.slotId,
      role: slot.permission === 'workspace-write' ? 'writer' : 'primary',
      operationId: slot.operationId,
      objective: normalizedPhase === 'proposal'
        ? 'Produce an independent bounded response.'
        : 'Complete the assigned collaboration phase.',
      expectedOutput: 'Return a concise structured collaboration result.',
      inputRefs: [],
      readOnly: slot.permission !== 'workspace-write',
      index,
    }))
    const plan = {
      version: 1,
      snapshotHash,
      assignments: assignments.map(({ index: _index, ...assignment }) => assignment),
      createdAt: Date.now(),
      barrier: 'batch',
    }
    const normalizedSlots = slotList.map((slot, index) => {
      const status = slot.status === 'pending' ? 'planned' : slot.status
      const terminal = ['completed', 'partial', 'failed', 'stopped', 'timeout', 'interrupted']
        .includes(status)
      return {
        slotId: slot.slotId,
        agentKind: slot.agentKind,
        phase: normalizedPhase,
        status,
        operationId: slot.operationId,
        ...(slot.agentRunId ? { agentRunId: slot.agentRunId } : {}),
        queuePosition: index,
        snapshotHash,
        deliveryWatermark: Number(slot.deliveryWatermark?.watermark ?? slot.deliveryWatermark)
          || (Array.isArray(slot.deliveryWatermark?.entryIds) ? slot.deliveryWatermark.entryIds.length : 0),
        receiptId: slot.receiptId || '',
        resultHash: slot.resultHash || '',
        assignedAt: slot.assignedAt || Date.now(),
        startedAt: slot.startedAt || Date.now(),
        finishedAt: terminal ? (slot.finishedAt || Date.now()) : null,
        commitStatus: slot.commitStatus || (terminal ? 'committed' : 'pending'),
        attempt: Number.isSafeInteger(slot.attempt) ? slot.attempt : 0,
        ...(slot.permission ? { permission: slot.permission } : {}),
        ...(slot.resultRefs ? { resultRefs: slot.resultRefs } : {}),
        resultBodyArtifactId: slot.resultBodyArtifactId || '',
        commitId: slot.commitId,
        messageId: slot.messageId,
        blackboardEntryId: slot.blackboardEntryId || '',
      }
    })
    const completedKinds = normalizedSlots
      .filter(slot => ['completed', 'partial'].includes(slot.status))
      .map(slot => slot.agentKind)
    const pendingKinds = normalizedSlots
      .filter(slot => !['completed', 'partial', 'failed', 'stopped', 'timeout', 'interrupted'].includes(slot.status))
      .map(slot => slot.agentKind)
    const commit = commitState || {
      status: 'pending',
      writerKind: writerKind || null,
      committedKinds: [],
      pendingKinds: [...targetKinds],
      operationId: '',
      attempt: 0,
      updatedAt: Date.now(),
    }
    const normalizedCommit = {
      status: commit.status || 'pending',
      writerKind: commit.writerKind || writerKind || null,
      committedKinds: commit.committedKinds || normalizedSlots
        .filter(slot => slot.commitStatus === 'committed').map(slot => slot.agentKind),
      pendingKinds: commit.pendingKinds || pendingKinds,
      operationId: commit.operationId || '',
      attempt: Number.isSafeInteger(commit.attempt) ? commit.attempt : 0,
      updatedAt: commit.updatedAt || Date.now(),
      ...(Array.isArray(commit.committedSlotIds)
        ? { committedSlotIds: [...commit.committedSlotIds] } : {}),
      ...(Array.isArray(commit.messageIds) ? { messageIds: [...commit.messageIds] } : {}),
      ...(Array.isArray(commit.blackboardEntryIds)
        ? { blackboardEntryIds: [...commit.blackboardEntryIds] } : {}),
    }
    return createOrchestrationV4({
      workflow,
      template,
      phase: normalizedPhase,
      batchId,
      currentKinds: normalizedPhase === 'proposal' ? [...pendingKinds] : [],
      snapshotHash,
      snapshot: snapshotRecord,
      plan,
      slots: normalizedSlots,
      deliveryWatermarks: targetKinds.map(kind => {
        const slot = normalizedSlots.find(item => item.agentKind === kind)
        const latestReceipt = slot?.resultRefs?.workflowOutcomeRefs?.findLast?.(
          record => record?.receipt,
        )?.receipt
        return {
          agentKind: kind,
          phase: latestReceipt?.phase || normalizedPhase,
          watermark: slot?.deliveryWatermark || 0,
          operationId: latestReceipt?.operationId || slot?.operationId || '',
          snapshotHash,
          updatedAt: Date.now(),
        }
      }),
      commitState: normalizedCommit,
      pendingKinds,
      activeKinds: [...targetKinds],
      successfulKinds: completedKinds,
      agreementKinds: [],
      attachmentRecipients: [],
      totalSuccesses: completedKinds.length,
      terminalFailureOccurred: normalizedSlots.some(slot => slot.status === 'failed'),
      collaboration,
    }, { targetKinds, now: Date.now() })
  }

  async commitV4ManualBarrier({ group, controller, targetKinds, slots, snapshotRecord,
    batchId, writerKind, allowStoppedCommit = false }) {
    const successfulSlots = slots.filter(slot => ['completed', 'partial'].includes(slot.status))
    const committedKinds = successfulSlots
      .filter(slot => slot.commitStatus === 'committed')
      .map(slot => slot.agentKind)
    const committedSlotIds = successfulSlots
      .filter(slot => slot.commitStatus === 'committed')
      .map(slot => slot.slotId)
    const messageIds = successfulSlots
      .filter(slot => slot.commitStatus === 'committed')
      .map(slot => slot.messageId)
    const blackboardEntryIds = successfulSlots
      .filter(slot => slot.commitStatus === 'committed')
      .map(slot => slot.blackboardEntryId)
    controller.orchestration = this.v4Orchestration({
      controller,
      workflow: 'manual',
      template: 'concurrent-batch',
      phase: 'commit',
      batchId,
      snapshotRecord,
      slots,
      writerKind,
      targetKinds,
      collaboration: controller.orchestration?.collaboration || emptyCollaborationState(),
      commitState: {
        status: 'committing',
        writerKind: writerKind || null,
        committedKinds,
        pendingKinds: successfulSlots
          .filter(slot => slot.commitStatus !== 'committed').map(slot => slot.agentKind),
        committedSlotIds,
        messageIds,
        blackboardEntryIds,
        operationId: `commit-operation-${hashValue({ batchId, targetKinds })}`,
        attempt: (controller.orchestration?.commitState?.attempt || 0) + 1,
        updatedAt: Date.now(),
      },
    })
    this.checkpointV4Manual(group, controller)

    for (const slot of successfulSlots) {
      if (controller.signal.aborted && !allowStoppedCommit) break
      const resultBody = this.loadV4ResultBody(slot)
      const workflowRecord = slot.resultRefs?.workflowOutcomeRefs?.find(item => (
        item?.receipt?.receiptId === slot.receiptId
      ))
      if (!workflowRecord?.receipt || workflowRecord.blackboardEntry?.entryId !== slot.blackboardEntryId) {
        throw new Error('LOCAL_RUN_RESULT_BODY_INVALID')
      }
      const message = this.commitV4AgentMessage({
        messageId: slot.messageId,
        groupId: group.id,
        agentKind: slot.agentKind,
        threadRootId: resultBody.threadRootId,
        content: resultBody.content,
        metadata: resultBody.metadata,
      })
      let collaboration = controller.orchestration.collaboration
      if (!collaboration.entries.some(entry => entry.entryId === slot.blackboardEntryId)) {
        const {
          entryId: _entryId,
          version: _version,
          recordType: _recordType,
          ...blackboardInput
        } = workflowRecord.blackboardEntry
        collaboration = appendBlackboardEntry(collaboration, blackboardInput)
        if (!collaboration.entries.some(entry => entry.entryId === slot.blackboardEntryId)) {
          throw new Error('LOCAL_RUN_COMMIT_INVALID')
        }
      }
      slot.commitStatus = 'committed'
      const currentCommitted = successfulSlots
        .filter(candidate => candidate.commitStatus === 'committed')
      controller.orchestration = this.v4Orchestration({
        controller,
        workflow: 'manual',
        template: 'concurrent-batch',
        phase: 'commit',
        batchId,
        snapshotRecord,
        slots,
        writerKind,
        targetKinds,
        collaboration,
        commitState: {
          ...controller.orchestration.commitState,
          committedKinds: currentCommitted.map(candidate => candidate.agentKind),
          pendingKinds: successfulSlots
            .filter(candidate => candidate.commitStatus !== 'committed')
            .map(candidate => candidate.agentKind),
          committedSlotIds: currentCommitted.map(candidate => candidate.slotId),
          messageIds: currentCommitted.map(candidate => candidate.messageId),
          blackboardEntryIds: currentCommitted.map(candidate => candidate.blackboardEntryId),
          updatedAt: Date.now(),
        },
      })
      if (message.id !== slot.messageId) throw new Error('LOCAL_RUN_COMMIT_INVALID')
      this.checkpointV4Manual(group, controller)
    }

    const allCommitted = successfulSlots.every(slot => slot.commitStatus === 'committed')
    controller.orchestration = this.v4Orchestration({
      controller,
      workflow: 'manual',
      template: 'concurrent-batch',
      phase: controller.signal.aborted ? 'stopped' : 'completed',
      batchId,
      snapshotRecord,
      slots,
      writerKind,
      targetKinds,
      collaboration: controller.orchestration.collaboration,
      commitState: {
        ...controller.orchestration.commitState,
        status: controller.signal.aborted || !allCommitted
          ? 'partial'
          : (slots.some(slot => slot.status === 'failed') ? 'partial' : 'committed'),
        pendingKinds: successfulSlots
          .filter(slot => slot.commitStatus !== 'committed').map(slot => slot.agentKind),
        updatedAt: Date.now(),
      },
    })
    this.checkpointV4Manual(group, controller)
  }

  async executeV4ManualSlots({ group, targetKinds, prepared, controller, threadRootId,
    snapshot, snapshotRecord, batchId, slots, writerKind, activeKinds,
    skillHintsByKind = new Map(), resumedGate = null }) {
    const snapshotSourceMessageIds = [snapshot.messageId, ...snapshot.history.map(item => item.id)]
    const frozenSnapshotHash = controller.orchestration.snapshotHash
    const prompts = new Map(activeKinds.map(kind => [kind, manualReplyPrompt({
      group: { ...group, ...snapshot.group },
      kind,
      targetKinds,
      taskText: snapshot.taskText,
      history: snapshot.history,
      skillHintsText: skillHintsPrompt(skillHintsByKind.get(kind) || []),
      knowledgeBaseHintsText: knowledgeBaseHintsPrompt(
        prepared?.knowledgeBaseHintsByKind?.get(kind) || [],
      ),
      writer: slots.find(slot => slot.agentKind === kind)?.permission === 'workspace-write',
    })]))
    // Concurrent replies keep slot order in the timeline whatever order they
    // finish in; failure notices take their slot's number too.
    const reservedTurns = this.reserveTurnSeqs(group.id, threadRootId, activeKinds.length)
    const turnSeqByKind = new Map(activeKinds.map((kind, index) => [kind, reservedTurns[index]]))
    const pending = await Promise.all(activeKinds.map(async (kind) => {
      const index = targetKinds.indexOf(kind)
      const slot = slots[index]
      slot.status = 'queued'
      delete slot.agentRunId
      slot.finishedAt = null
      slot.commitStatus = 'pending'
      controller.orchestration = this.v4Orchestration({
        controller,
        workflow: 'manual',
        template: 'concurrent-batch',
        phase: 'proposal',
        batchId,
        snapshotRecord,
        slots,
        writerKind,
        targetKinds,
        collaboration: controller.orchestration.collaboration,
        commitState: controller.orchestration.commitState,
      })
      this.checkpointV4Manual(group, controller)
      let leaseAcquired = false
      try {
        const invocation = await this.invokeWithRecovery({
          group: slot.permission === 'workspace-write' ? group : { ...group, allowWrite: false },
          kind,
          controller,
          activeKinds: targetKinds,
          threadRootId,
          context: {
            v4: true,
            phase: 'proposal',
            batchId,
            slotId: slot.slotId,
            snapshotHash: frozenSnapshotHash,
            sessionPolicy: 'frozen',
            ...(turnSeqByKind.get(kind) ? { turnSeq: turnSeqByKind.get(kind) } : {}),
            promptOverride: prompts.get(kind),
            contextPackId: controller.contextPackId,
            snapshotSourceMessageIds,
            snapshotSourceEntries: snapshot.history,
            permissionMode: slot.permission,
            singleWriterKind: '',
            independentProposal: true,
            parallelGraph: true,
            deferMessage: true,
            allowMissingProposalReceipt: true,
            operationId: slot.operationId,
            onLeaseAcquired: (leaseState) => {
              if (leaseAcquired) return
              leaseAcquired = true
              if (!leaseState?.agentRunId) throw new Error('LOCAL_RUN_PERSIST_FAILED')
              slot.agentRunId = leaseState.agentRunId
              slot.status = 'running'
              if (resumedGate?.type !== 'permission') slot.attempt += 1
              slot.startedAt = Date.now()
              slot.finishedAt = null
              if (resumedGate?.gateId
                  && controller.continuation?.gateId === resumedGate.gateId
                  && controller.continuation.state === 'completed') {
                controller.continuation = null
              }
              controller.orchestration = this.v4Orchestration({
                controller,
                workflow: 'manual',
                template: 'concurrent-batch',
                phase: 'proposal',
                batchId,
                snapshotRecord,
                slots,
                writerKind,
                targetKinds,
                collaboration: controller.orchestration.collaboration,
                commitState: controller.orchestration.commitState,
              })
              this.checkpointV4Manual(group, controller)
            },
            ...(resumedGate?.agentKind === kind ? { resumedGate } : {}),
            skillHints: skillHintsByKind.get(kind) || [],
            knowledgeBaseHints: prepared?.knowledgeBaseHintsByKind?.get(kind) || [],
            attachmentSnapshots: prepared?.attachments || [],
          },
        })
        if (controller.signal.aborted) return { kind, index, stopped: true }
        const result = invocation?.result
        if (!result?.pendingMessage || !result.collaboration) {
          throw invocation?.error || new Error('LOCAL_AGENT_UNKNOWN_FAILURE')
        }
        const resultBodyArtifact = this.v4ResultBodyRecord(
          controller, slot, result.pendingMessage,
        )
        const outcomeRefs = {
          artifactIds: result.outcomeRefs?.artifactIds || [],
          evidenceIds: result.outcomeRefs?.evidenceIds || [],
        }
        slot.status = 'completed'
        slot.commitStatus = 'pending'
        slot.finishedAt = Date.now()
        slot.resultBodyArtifactId = resultBodyArtifact.artifactId
        const receipt = createCollaborationReceipt({
          phase: 'proposal',
          agentKind: kind,
          slotId: slot.slotId,
          operationId: slot.operationId,
          status: result.collaboration.status || 'completed',
          summary: result.collaboration.summary,
          conclusion: '',
          artifactIds: outcomeRefs.artifactIds,
          evidenceIds: outcomeRefs.evidenceIds,
          unresolved: result.collaboration.unresolved || [],
          claims: result.collaboration.claims || [],
          findings: result.collaboration.findings || [],
          refs: result.collaboration.refs || [],
          deliveryWatermark: 1,
          snapshotHash: frozenSnapshotHash,
        })
        slot.resultHash = hashValue(receipt)
        slot.receiptId = receipt.receiptId
        slot.deliveryWatermark = receipt.deliveryWatermark
        const resultBody = this.loadV4ResultBody(slot)
        const blackboardEntry = this.v4BlackboardEntry(
          controller, targetKinds, slot, receipt, resultBody, outcomeRefs,
        )
        slot.blackboardEntryId = blackboardEntry.entryId
        slot.resultRefs = {
          ...outcomeRefs,
          workflowOutcomeRefs: [{ receipt, blackboardEntry }],
        }
        controller.orchestration = this.v4Orchestration({
          controller,
          workflow: 'manual',
          template: 'concurrent-batch',
          phase: 'proposal',
          batchId,
          snapshotRecord,
          slots,
          writerKind,
          targetKinds,
          collaboration: controller.orchestration.collaboration,
          commitState: controller.orchestration.commitState,
        })
        this.checkpointV4Manual(group, controller)
        if (resumedGate?.agentKind === kind
            && controller.continuation?.gateId === resumedGate.gateId
            && this.completeHumanGateContinuation?.(
              controller.runId, resumedGate.gateId, 'completed',
            ) !== true && this.hasRunLedger()) {
          throw new Error('LOCAL_RUN_PERSIST_FAILED')
        }
        return { kind, index, invocation }
      } catch (error) {
        if (stalePermissionResumeFailure(error, resumedGate)
            && resumedGate.agentKind === kind) {
          this.resetAgentSession(group, kind, true, controller.taskId)
          if (slot.permission === 'workspace-write') {
            slot.status = 'running'
            slot.commitStatus = 'pending'
            slot.finishedAt = null
            controller.orchestration = this.v4Orchestration({
              controller,
              workflow: 'manual',
              template: 'concurrent-batch',
              phase: 'proposal',
              batchId,
              snapshotRecord,
              slots,
              writerKind,
              targetKinds,
              collaboration: controller.orchestration.collaboration,
              commitState: controller.orchestration.commitState,
            })
            this.checkpointV4Manual(group, controller)
            return { kind, index, permissionRestartRecovery: true }
          }
          slot.status = 'queued'
          slot.commitStatus = 'pending'
          slot.finishedAt = null
          controller.orchestration = this.v4Orchestration({
            controller,
            workflow: 'manual',
            template: 'concurrent-batch',
            phase: 'proposal',
            batchId,
            snapshotRecord,
            slots,
            writerKind,
            targetKinds,
            collaboration: controller.orchestration.collaboration,
            commitState: controller.orchestration.commitState,
          })
          this.checkpointV4Manual(group, controller)
          return { kind, index, permissionRestartReadOnly: true }
        }
        const preserveQueuedForRecovery = controller.signal.aborted
          && controller.stopReason === 'shutdown'
          && !leaseAcquired
          && slot.status === 'queued'
        const preserveGateCursor = controller.signal.aborted
          && controller.stopReason === 'shutdown'
          && controller.continuation?.resumeKind === 'agent_slot'
          && ['pending', 'ready', 'resuming'].includes(controller.continuation.state)
        slot.status = preserveQueuedForRecovery
          ? 'queued'
          : (controller.signal.aborted ? 'stopped' : 'failed')
        slot.commitStatus = preserveQueuedForRecovery
          ? 'pending'
          : (controller.signal.aborted ? 'partial' : 'failed')
        slot.finishedAt = preserveQueuedForRecovery ? null : Date.now()
        controller.orchestration = this.v4Orchestration({
          controller,
          workflow: 'manual',
          template: 'concurrent-batch',
          phase: controller.signal.aborted && !preserveGateCursor ? 'stopped' : 'proposal',
          batchId,
          snapshotRecord,
          slots,
          writerKind,
          targetKinds,
          collaboration: controller.orchestration.collaboration,
          commitState: controller.orchestration.commitState,
        })
        this.checkpointV4Manual(group, controller)
        return { kind, index, error }
      }
    }))

    const readOnlyRestarts = pending.filter(item => item.permissionRestartReadOnly)
    if (readOnlyRestarts.length) {
      return this.executeV4ManualSlots({
        group, targetKinds, prepared, controller, threadRootId,
        snapshot, snapshotRecord, batchId, slots, writerKind,
        activeKinds: readOnlyRestarts.map(item => item.kind), skillHintsByKind,
      })
    }

    const failures = []
    for (const item of pending.sort((left, right) => left.index - right.index)) {
      if (item.permissionRestartRecovery) continue
      const slot = slots[item.index]
      if (!controller.signal.aborted && slot.status === 'completed') continue
      const error = item.error || item.invocation?.error || new Error('LOCAL_AGENT_UNKNOWN_FAILURE')
      failures.push({ ...item, error })
      if (!controller.signal.aborted) {
        this.recordAgentFailure(group.id, item.kind, error, threadRootId)
      } else if (controller.stopReason === 'user'
          && slot.agentRunId
          && error?.runTrace?.agentRunId === slot.agentRunId) {
        this.recordAgentInterruption(group.id, item.kind, error, threadRootId, 'stopped')
      }
    }
    controller.completedKinds = targetKinds.filter(kind => {
      const status = slots.find(slot => slot.agentKind === kind)?.status
      return ['completed', 'partial', 'failed', 'stopped', 'timeout', 'interrupted'].includes(status)
    })
    controller.failedKinds = slots
      .filter(slot => ['failed', 'stopped', 'timeout', 'interrupted'].includes(slot.status))
      .map(slot => slot.agentKind)
    controller.currentKind = ''
    return { failures }
  }

  async runV4Manual({ group, targetKinds, userMessage, prepared, controller, threadRootId }) {
    const writableKinds = group.allowWrite === true ? targetKinds.filter(kind => (
      agentRuntimeCapabilities(kind, {
        agent: this.detectedAgents().find(agent => agent.kind === kind),
      }).permissionModes.includes('workspace-write')
    )) : []
    const writerKind = this.v4WriterKind(controller, writableKinds, 'manual')
    const snapshot = v4Snapshot({
      state: this.snapshot(),
      group,
      taskId: userMessage.id,
      targetKinds,
      message: userMessage,
      skillHintsByKind: prepared.skillHintsByKind,
      phase: 'proposal',
      writerKind,
    })
    const frozenSnapshot = this.persistV4Snapshot(controller, snapshot, targetKinds)
    const batchId = this.v4BatchId(controller, 'proposal')
    const slots = targetKinds.map((kind, index) => ({
      slotId: `slot-${index + 1}-${kind}`,
      agentKind: kind,
      phase: 'proposal',
      status: 'pending',
      attempt: 0,
      operationId: `agent-operation-${createHash('sha256').update(`${controller.runId}:${batchId}:${kind}`).digest('hex')}`,
      permission: writableKinds.includes(kind) ? 'workspace-write' : 'read-only',
      resultRefs: { artifactIds: [], evidenceIds: [] },
      deliveryWatermark: { version: 1, entryIds: [] },
      resultBodyArtifactId: '',
      commitId: `commit-${hashValue({ batchId, kind, index })}`,
      messageId: `message-${hashValue({ batchId, kind, index })}`,
      blackboardEntryId: '',
    }))
    controller.orchestration = this.v4Orchestration({
      controller,
      workflow: 'manual',
      template: 'concurrent-batch',
      phase: 'proposal',
      batchId,
      snapshotRecord: frozenSnapshot.record,
      slots,
      writerKind,
      targetKinds,
    })
    this.checkpointV4Manual(group, controller)

    const execution = await this.executeV4ManualSlots({
      group,
      targetKinds,
      prepared,
      controller,
      threadRootId,
      snapshot,
      snapshotRecord: frozenSnapshot.record,
      batchId,
      slots,
      writerKind,
      activeKinds: targetKinds,
      skillHintsByKind: prepared.skillHintsByKind,
    })
    const successfulKinds = slots
      .filter(slot => ['completed', 'partial'].includes(slot.status))
      .map(slot => slot.agentKind)
    if (!controller.signal.aborted || controller.stopReason === 'user') {
      await this.commitV4ManualBarrier({
        group,
        controller,
        targetKinds,
        slots,
        snapshotRecord: frozenSnapshot.record,
        batchId,
        writerKind,
        allowStoppedCommit: controller.stopReason === 'user',
      })
    }
    return {
      status: controller.signal.aborted
        ? terminalRunStatusForReason(controller.stopReason)
        : (successfulKinds.length === targetKinds.length ? 'completed' : 'partial'),
      failures: execution.failures,
    }
  }

  async resumeV4Manual({ group, durable, controller, onlyKind = '', resumedGate = null }) {
    let orchestration
    try {
      orchestration = parseOrchestrationV4(controller.orchestration, {
        targetKinds: durable.targetKinds,
      })
    } catch (error) {
      controller.orchestration = structuredClone(durable.orchestration)
      throw error
    }
    controller.orchestration = orchestration
    if (orchestration?.version !== 4 || orchestration.template !== 'concurrent-batch'
        || orchestration.workflow !== 'manual') {
      throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
    }
    const targetKinds = [...durable.targetKinds]
    const slots = orchestration.slots.map(slot => ({ ...slot }))
    const snapshot = this.loadV4Snapshot(orchestration, {
      taskId: durable.taskId,
      messageId: durable.threadRootId,
      groupId: durable.groupId,
      targetKinds,
    })
    const persistedSkills = v4SnapshotSkillHints(snapshot, targetKinds)
    const hasPersistedSkills = targetKinds.some(kind => (
      (persistedSkills.get(kind) || []).length > 0
    ))
    const skillHintsByKind = hasPersistedSkills
      ? await restoreV4SnapshotSkills({
          snapshot,
          targetKinds,
          validateSkillSelections: this.validateSkillSelections,
          persisted: persistedSkills,
        })
      : persistedSkills
    const writerKind = orchestration.commitState?.writerKind || ''
    for (const slot of slots.filter(slot => ['completed', 'partial'].includes(slot.status))) {
      this.loadV4ResultBody(slot)
    }
    let effectiveOnlyKind = onlyKind
    let effectiveResumedGate = resumedGate
    if (!effectiveOnlyKind) {
      const unknownWriters = slots.filter(isV4ManualUnknownWriter)
      const unknownWriter = unknownWriters[0]
      if (unknownWriter) {
        if (!this.requestHumanGate) throw new Error('LOCAL_RUN_RETRY_GATE_INVALID')
        const gate = await this.requestHumanGate(
          v4ManualRecoveryGateInput(controller.runId, orchestration.batchId, unknownWriter),
          {
            signal: controller.signal,
            preserveOnAbort: () => controller.stopReason === 'shutdown',
            continuation: {
              resumeKind: 'agent_slot',
              agentRunId: unknownWriter.operationId,
              ...(unknownWriter.agentRunId
                ? { publicAgentRunId: unknownWriter.agentRunId }
                : {}),
              agentKind: unknownWriter.agentKind,
              round: orchestration.snapshot?.round || 0,
              phase: orchestration.phase,
              slotId: unknownWriter.slotId,
              operationId: unknownWriter.operationId,
              snapshotHash: orchestration.snapshotHash,
            },
          },
        )
        if (gate.status !== 'approved') {
          if (this.completeHumanGateContinuation?.(
            controller.runId, gate.gateId, 'cancelled',
          ) !== true && this.hasRunLedger()) throw new Error('LOCAL_RUN_PERSIST_FAILED')
          controller.stopReason = 'human_gate_rejected'
          return { status: 'stopped', failures: [] }
        }
        if (gate.optionId !== 'retry-once') throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
        if (this.completeHumanGateContinuation?.(
          controller.runId, gate.gateId, 'completed',
        ) !== true && this.hasRunLedger()) throw new Error('LOCAL_RUN_PERSIST_FAILED')
        unknownWriter.status = 'queued'
        delete unknownWriter.agentRunId
        unknownWriter.finishedAt = null
        unknownWriter.commitStatus = 'pending'
        controller.orchestration = this.v4Orchestration({
          controller,
          workflow: 'manual',
          template: 'concurrent-batch',
          phase: 'proposal',
          batchId: orchestration.batchId,
          snapshotRecord: orchestration.snapshot,
          slots,
          writerKind,
          targetKinds,
          collaboration: orchestration.collaboration,
          commitState: orchestration.commitState,
        })
        this.checkpointV4Manual(group, controller)
        effectiveOnlyKind = unknownWriter.agentKind
        effectiveResumedGate = {
          gateId: gate.gateId,
          type: 'retry',
          agentRunId: unknownWriter.operationId,
          agentKind: unknownWriter.agentKind,
          status: gate.status,
          optionId: gate.optionId,
          request: v4ManualRecoveryGateInput(
            controller.runId, orchestration.batchId, unknownWriter,
          ).request,
          used: false,
        }
      }
    }
    const boundSlot = effectiveOnlyKind
      ? slots.find(slot => slot.agentKind === effectiveOnlyKind)
      : null
    const approvedGateRetry = Boolean(
      effectiveResumedGate
      && boundSlot
      && effectiveResumedGate.agentKind === effectiveOnlyKind
      && effectiveResumedGate.status === 'approved',
    )
    const retryable = slot => (
      slot.commitStatus !== 'committed'
      && !['completed', 'partial'].includes(slot.status)
      && (slot.permission === 'read-only'
        || ['planned', 'prepared', 'queued', 'failed'].includes(slot.status)
        || (approvedGateRetry && slot === boundSlot))
    )
    const candidates = slots.filter(slot => (
      (!effectiveOnlyKind || slot.agentKind === effectiveOnlyKind) && retryable(slot)
    )).map(slot => slot.agentKind)
    if (effectiveOnlyKind && !candidates.includes(effectiveOnlyKind)
        && !['completed', 'partial'].includes(boundSlot?.status)) {
      throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
    }
    const execution = candidates.length
      ? await this.executeV4ManualSlots({
          group,
          targetKinds,
          prepared: null,
          controller,
          threadRootId: durable.threadRootId,
          snapshot,
          snapshotRecord: orchestration.snapshot,
          batchId: orchestration.batchId,
          slots,
          writerKind,
          activeKinds: candidates,
          skillHintsByKind,
          resumedGate: effectiveResumedGate,
        })
      : { failures: [] }
    if (slots.some(isV4ManualUnknownWriter)) {
      return this.resumeV4Manual({
        group,
        durable: { ...durable, orchestration: controller.orchestration },
        controller,
      })
    }
    if (effectiveOnlyKind && !controller.signal.aborted) {
      const peerCandidates = slots.filter(slot => (
        slot.agentKind !== effectiveOnlyKind && retryable(slot)
      )).map(slot => slot.agentKind)
      if (peerCandidates.length) {
        const peerExecution = await this.executeV4ManualSlots({
          group,
          targetKinds,
          prepared: null,
          controller,
          threadRootId: durable.threadRootId,
          snapshot,
          snapshotRecord: orchestration.snapshot,
          batchId: orchestration.batchId,
          slots,
          writerKind,
          activeKinds: peerCandidates,
          skillHintsByKind,
        })
        execution.failures.push(...peerExecution.failures)
      }
    }
    if (!controller.signal.aborted) {
      await this.commitV4ManualBarrier({
        group,
        controller,
        targetKinds,
        slots,
        snapshotRecord: orchestration.snapshot,
        batchId: orchestration.batchId,
        writerKind,
      })
    }
    const successfulKinds = slots
      .filter(slot => ['completed', 'partial'].includes(slot.status))
      .map(slot => slot.agentKind)
    return {
      status: controller.signal.aborted
        ? terminalRunStatusForReason(controller.stopReason)
        : (successfulKinds.length === targetKinds.length ? 'completed' : 'partial'),
      failures: execution.failures,
    }
  }

  async send(input) {
    const group = this.getGroup(input.groupId)
    if (this.isGroupBusy(group.id)) throw new Error('LOCAL_GROUP_RUNNING')
    const {
      mode,
      targetKinds,
      v4,
      unlimitedRounds,
      maxRounds,
      requestedThreadRootId,
      regenerateMessageId,
      routingDecision,
      taskGraph,
      discussionStyle,
    } = this.validateInput(group, input)
    const regeneration = this.resolveRegeneration(group, regenerateMessageId, targetKinds)
    const reservation = this.reserveRun(
      group.id,
      mode,
      targetKinds,
      regeneration?.userMessage.id || '',
      maxRounds,
      unlimitedRounds,
    )
    reservation.v4 = v4
    reservation.discussionStyle = discussionStyle
    try {
      if (regeneration) reservation.responseVersionRootId = regeneration.responseVersionRootId
      this.configureRunBudget(reservation, input.budget || {})
      if (regeneration) this.emitChanged()
    } catch (error) {
      this.releasePreparation(group.id, reservation)
      throw error
    }
    const promise = (async () => {
      let controller = null
      let autoStarted = false
      const successfulKinds = new Set()
      let runStatus = 'failed'
      const reportedFailures = new Set()
      try {
        const prepared = await this.preflight(
          group,
          targetKinds,
          regeneration ? this.regenerationInput(input, regeneration, targetKinds[0]) : input,
          reservation,
        )
        if (mode === 'auto') {
          const previousUpdatedAt = group.updatedAt
          const userMessage = this.addMessage(
            group.id,
            'user',
            prepared.text,
            '',
            '',
            null,
            {
              attachments: prepared.attachments.map(({ path: _path, ...metadata }) => metadata),
              skillHints: prepared.skillHints,
              knowledgeBaseHints: prepared.storedKnowledgeBaseHints,
              targetKinds,
              routingDecision,
            },
          )
          try {
            const contextPack = this.createContextPack({
              group,
              taskId: userMessage.id,
              mode: 'auto',
              targetKinds,
              message: userMessage,
              prepared,
            })
            this.bindRunTask(
              group.id, reservation, userMessage.id, userMessage.id, contextPack.contextPackId,
            )
            controller = this.startAutoRunner(
              group, targetKinds, userMessage.id, maxRounds, reservation, prepared, unlimitedRounds,
              taskGraph,
            )
          } catch (error) {
            try {
              this.rollbackAddedMessage(group.id, userMessage.id, previousUpdatedAt)
            } catch (rollbackError) {
              if (error && typeof error === 'object') error.rollbackError = rollbackError
            }
            throw error
          }
          autoStarted = true
          return {
            started: true,
            maxRounds,
            threadRootId: userMessage.id,
            ...(unlimitedRounds ? { unlimitedRounds: true } : {}),
          }
        }

        const previousUpdatedAt = group.updatedAt
        const userMessage = regeneration?.userMessage || this.addMessage(
          group.id,
          'user',
          prepared.text,
          '',
          '',
          null,
          {
            attachments: prepared.attachments.map(({ path: _path, ...metadata }) => metadata),
            skillHints: prepared.skillHints,
            knowledgeBaseHints: prepared.storedKnowledgeBaseHints,
            targetKinds: group.conversationType === 'direct' ? [] : targetKinds,
            routingDecision,
          },
        )
        const threadRootId = regeneration
          ? userMessage.id
          : (group.conversationType === 'direct' ? '' : userMessage.id)
        try {
          const contextPack = this.createContextPack({
            group,
            taskId: userMessage.id,
            mode: group.conversationType === 'direct' ? 'direct' : 'manual',
            targetKinds,
            message: userMessage,
            prepared,
          })
          this.bindRunTask(
            group.id, reservation, userMessage.id, threadRootId, contextPack.contextPackId,
          )
          if (regeneration) {
            this.resetAgentSession(group, targetKinds[0], true, userMessage.id)
          }
          if (!v4) {
            reservation.orchestration = {
              version: 1,
              workflow: 'manual',
              currentKind: '',
              pendingKinds: [...targetKinds],
              activeKinds: [...targetKinds],
              successfulKinds: [],
              agreementKinds: [],
              attachmentRecipients: [],
              totalSuccesses: 0,
              terminalFailureOccurred: false,
            }
          }
          controller = this.beginRun(
            group.id, 'manual', targetKinds, threadRootId, reservation,
          )
        } catch (error) {
          if (!regeneration) {
            try {
              this.rollbackAddedMessage(group.id, userMessage.id, previousUpdatedAt)
            } catch (rollbackError) {
              if (error && typeof error === 'object') error.rollbackError = rollbackError
            }
          }
          throw error
        }
        if (controller.signal.aborted) throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
        if (v4) {
          const v4Result = await this.runV4Manual({
            group,
            targetKinds,
            userMessage,
            prepared,
            controller,
            threadRootId,
          })
          runStatus = v4Result.status
          return this.snapshot()
        }
        let activeKinds = [...targetKinds]
        const pendingKinds = [...targetKinds]
        const replacementInstructions = new Map()
        while (pendingKinds.length) {
          const kind = pendingKinds.shift()
          if (!activeKinds.includes(kind)) continue
          if (controller.signal.aborted) break
          controller.currentKind = kind
          controller.progress = []
          controller.orchestration = {
            ...controller.orchestration,
            currentKind: kind,
            pendingKinds: [...pendingKinds],
            activeKinds: [...activeKinds],
            successfulKinds: [...successfulKinds],
          }
          if (this.hasRunLedger() && this.checkpointRun(group.id, controller) !== true) {
            throw new Error('LOCAL_RUN_PERSIST_FAILED')
          }
          this.emitChanged()
          try {
            const invocation = await this.invokeWithRecovery({
              group,
              kind,
              controller,
              activeKinds,
              threadRootId,
              context: {
                skillHints: prepared.skillHintsByKind.get(kind) || [],
                knowledgeBaseHints: prepared.knowledgeBaseHintsByKind.get(kind) || [],
                attachments: prepared.attachments.map(attachment => attachment.path),
                attachmentSnapshots: prepared.attachments,
                sessionThreadRootId: requestedThreadRootId || threadRootId,
                runtimeInstruction: replacementInstructions.get(kind) || '',
                responseVersionRootId: regeneration?.responseVersionRootId || '',
                regenerationInstruction: regeneration ? this.regenerationInstruction() : '',
                contextOptions: regeneration
                  ? {
                      beforeMessageId: regeneration.sourceMessage.id,
                      excludeResponseVersionRootId: regeneration.responseVersionRootId,
                      focusUserMessageId: regeneration.userMessage.id,
                    }
                  : { focusUserMessageId: userMessage.id },
              },
              reportedFailures,
            })
            replacementInstructions.delete(kind)
            if (invocation.control?.action === 'replace') {
              this.recordAgentInterruption(
                group.id, kind, invocation.error, threadRootId, 'stopped', reportedFailures,
              )
              if (!controller.failedKinds.includes(kind)) controller.failedKinds.push(kind)
              if (!controller.completedKinds.includes(kind)) controller.completedKinds.push(kind)
              successfulKinds.delete(kind)
              const replacementKind = invocation.control.replacementKind
              activeKinds = activeKinds.filter(activeKind => activeKind !== kind)
              replacementInstructions.set(
                replacementKind,
                this.replacementInstruction(kind),
              )
              if (!pendingKinds.includes(replacementKind)) pendingKinds.unshift(replacementKind)
              controller.currentKind = ''
              controller.progress = []
              this.emitChanged()
              continue
            }
            if (invocation.control?.action === 'cancel') {
              this.recordAgentInterruption(
                group.id, kind, invocation.error, threadRootId, 'stopped', reportedFailures,
              )
              if (!controller.failedKinds.includes(kind)) controller.failedKinds.push(kind)
              if (!controller.completedKinds.includes(kind)) controller.completedKinds.push(kind)
              successfulKinds.delete(kind)
              controller.currentKind = ''
              controller.progress = []
              this.emitChanged()
              continue
            }
            if (!invocation.result) {
              throw invocation.error || new Error('LOCAL_AGENT_UNKNOWN_FAILURE')
            }
            successfulKinds.add(kind)
          } catch (error) {
            if (circuitBreakerFailure(error)) {
              controller.stopReason = 'circuit_breaker'
              controller.abort()
              this.addMessage(
                group.id,
                'system',
                `Run stopped after ${MAX_RUN_AGENT_ATTEMPTS} Agent attempts.`,
                '',
                threadRootId,
                {
                  key: 'system.runCircuitBreaker',
                  params: { maxAttempts: MAX_RUN_AGENT_ATTEMPTS },
                },
              )
              break
            }
            if (hardBudgetFailure(error)) {
              this.recordAgentFailure(group.id, kind, error, threadRootId, reportedFailures)
              successfulKinds.delete(kind)
              if (!controller.failedKinds.includes(kind)) controller.failedKinds.push(kind)
              if (!controller.completedKinds.includes(kind)) controller.completedKinds.push(kind)
              controller.stopReason = 'hard_budget'
              controller.abort()
              break
            }
            if (controller.signal.aborted) {
              this.recordAgentInterruption(
                group.id,
                kind,
                error,
                threadRootId,
                controller.stopReason === 'shutdown' ? 'interrupted' : 'stopped',
              )
              if (!controller.completedKinds.includes(kind)) controller.completedKinds.push(kind)
              break
            }
            this.recordAgentFailure(group.id, kind, error, threadRootId, reportedFailures)
            successfulKinds.delete(kind)
            if (!controller.failedKinds.includes(kind)) controller.failedKinds.push(kind)
            if (error?.message === 'LOCAL_AGENT_TIMEOUT') runStatus = 'timeout'
          }
          if (!controller.completedKinds.includes(kind)) controller.completedKinds.push(kind)
          controller.currentKind = ''
          controller.progress = []
          controller.orchestration = {
            ...controller.orchestration,
            currentKind: '',
            pendingKinds: [...pendingKinds],
            activeKinds: [...activeKinds],
            successfulKinds: [...successfulKinds],
          }
          if (this.hasRunLedger() && this.checkpointRun(group.id, controller) !== true) {
            throw new Error('LOCAL_RUN_PERSIST_FAILED')
          }
          this.emitChanged()
        }
        if (controller.signal.aborted) {
          runStatus = terminalRunStatusForReason(controller.stopReason)
          return this.snapshot()
        }
        const successCount = activeKinds.filter(kind => successfulKinds.has(kind)).length
        if (!successCount) return this.snapshot()
        runStatus = successCount === activeKinds.length
          ? 'completed'
          : 'partial'
        return this.snapshot()
      } finally {
        if (mode === 'auto') {
          if (!autoStarted) this.releasePreparation(group.id, reservation)
        } else if (controller) {
          controller.currentKind = ''
          controller.progress = []
          if (controller.signal.aborted) {
            runStatus = terminalRunStatusForReason(controller.stopReason)
          } else if (runStatus === 'failed' && successfulKinds.size > 0) runStatus = 'partial'
          await this.finishRun(group.id, controller, runStatus)
        } else {
          this.releasePreparation(group.id, reservation)
        }
      }
    })()
    reservation.promise = promise
    return await promise
  }

  startAuto(input) {
    const group = this.getGroup(input.groupId)
    if (this.isGroupBusy(group.id)) throw new Error('LOCAL_GROUP_RUNNING')
    if (input.targetKinds != null && !Array.isArray(input.targetKinds)) {
      throw new Error('LOCAL_MESSAGE_TARGET_REQUIRED')
    }
    const requested = Array.isArray(input.targetKinds) && input.targetKinds.length
      ? normalizeTargetKinds(input.targetKinds)
      : group.agentKinds
    const targetKinds = [...new Set(requested.filter(kind => group.agentKinds.includes(kind)))]
    if (!targetKinds.length) throw new Error('LOCAL_AUTO_AGENT_COUNT')
    const unlimitedRounds = input.unlimitedRounds === true
    const maxRounds = unlimitedRounds
      ? 0
      : normalizeAutoRounds(input.maxRounds ?? input.maxTurns)
    let taskGraph = null
    if (input.workflow != null) {
      if (input.workflow?.template !== 'task-graph') {
        throw new Error('LOCAL_WORKFLOW_UNSUPPORTED')
      }
      try {
        taskGraph = createTaskGraph(input.workflow, targetKinds)
      } catch {
        throw new Error('LOCAL_WORKFLOW_INVALID')
      }
    }
    const state = this.state()
    const latestRoot = state.messages.findLast(message => (
      message.groupId === group.id && message.role === 'user' && !message.threadRootId
    ))
    const threadRootId = cleanText(input.threadRootId, 100) || latestRoot?.id || ''
    if (!threadRootId) throw new Error('LOCAL_AUTO_THREAD_REQUIRED')
    const rootMessage = state.messages.find(message => (
      message.id === threadRootId && message.groupId === group.id && message.role === 'user'
    ))
    const rootAttachments = (Array.isArray(rootMessage?.attachments) ? rootMessage.attachments : [])
      .map(normalizeAttachmentMetadata)
      .filter(Boolean)
    this.validateAttachmentSupport(targetKinds, rootAttachments)
    const reservation = this.reserveRun(
      group.id, 'auto', targetKinds, threadRootId, maxRounds, unlimitedRounds,
    )
    reservation.v4 = input.protocol !== 'legacy' && this.v4Requested(input)
    const requestedDiscussionStyle = input.discussionStyle == null
      ? ''
      : cleanInline(input.discussionStyle, 40)
    if (requestedDiscussionStyle && !DISCUSSION_STYLES.has(requestedDiscussionStyle)) {
      this.releasePreparation(group.id, reservation)
      throw new Error('LOCAL_DISCUSSION_STYLE_INVALID')
    }
    if (requestedDiscussionStyle && !reservation.v4) {
      this.releasePreparation(group.id, reservation)
      throw new Error('LOCAL_DISCUSSION_STYLE_UNSUPPORTED')
    }
    reservation.discussionStyle = requestedDiscussionStyle || 'sequential'
    try {
      this.configureRunBudget(reservation, input.budget || {})
      const contextPack = this.createContextPack({
        group,
        taskId: threadRootId,
        mode: 'auto',
        targetKinds,
        message: rootMessage,
      })
      this.bindRunTask(
        group.id, reservation, threadRootId, threadRootId, contextPack.contextPackId,
      )
      this.startAutoRunner(
        group, targetKinds, threadRootId, maxRounds, reservation, null, unlimitedRounds,
        taskGraph,
      )
    } catch (error) {
      this.releasePreparation(group.id, reservation)
      throw error
    }
    return { started: true, maxRounds, ...(unlimitedRounds ? { unlimitedRounds: true } : {}) }
  }
}

module.exports = {
  LocalWorkspaceMessageSubmission,
  isV4ManualUnknownWriter,
  v4ManualRecoveryGateInput,
}

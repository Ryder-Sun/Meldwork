const { EventEmitter } = require('node:events')
const { createHash, randomUUID } = require('node:crypto')
const path = require('node:path')
const { ContentBlobStore } = require('../attachments/content-blob-store.cjs')
const { agentRuntimeCapabilities } = require('../agents/agent-runtime-contract.cjs')
const { ContextPackStore } = require('../collaboration/context-pack-store.cjs')
const { HumanGateCoordinator } = require('../gates/human-gate-coordinator.cjs')
const { HumanGateStore } = require('../gates/human-gate-store.cjs')
const { OutcomeStore } = require('../collaboration/outcome-store.cjs')
const { hashValue } = require('../collaboration/orchestration-v4-records.cjs')
const {
  RunHarness,
  normalizeOutcomeRefs,
  normalizeSessionMeta,
} = require('../runs/run-harness.cjs')
const { RunBudget } = require('../runs/run-budget.cjs')
const { LocalWorkspaceRunLedger } = require('./local-workspace-ledger.cjs')
const { LocalWorkspaceAgentCatalog } = require('./local-workspace-agent-catalog.cjs')
const { LocalWorkspaceAgentInvocation } = require('./local-workspace-agent-invocation.cjs')
const { LocalWorkspaceAutoRunner } = require('./local-workspace-auto-runner.cjs')
const { LocalWorkspaceConversations } = require('./local-workspace-conversations.cjs')
const { LocalWorkspaceContextPacks } = require('./local-workspace-context-packs.cjs')
const {
  LocalWorkspaceMessageSubmission,
  isV4ManualUnknownWriter,
  v4ManualRecoveryGateInput,
} = require('./local-workspace-message-submission.cjs')
const { LocalWorkspaceRunCoordinator } = require('./local-workspace-run-coordinator.cjs')
const { LocalWorkspaceRunMessages } = require('./local-workspace-run-messages.cjs')
const { AgentRouter } = require('../agents/agent-routing.cjs')
const {
  clearSessionState,
  openClawSessionRef,
  packedPromptContext,
  promptFor,
  promptMessageText,
  recentTranscriptEntries,
  resolveSessionState,
  sessionKey,
  stableUserInstructions,
  stableUserMessages,
} = require('./local-workspace-context.cjs')
const {
  DEFAULT_RUN_ABORT_GRACE_MS,
  DEFAULT_RUN_AGENT_TIMEOUT_MS,
  DEFAULT_RUN_SILENCE_WARNING_MS,
  SESSION_KEY,
  cleanInline,
  defaultAgentLabel,
  normalizeLoadedMessage,
  normalizeSessionRef,
  terminalRunStatusForReason,
} = require('./local-workspace-inputs.cjs')
const {
  DEFAULT_RUN_AGENT_TOOL_TIMEOUT_MS,
} = require('./local-workspace-runtime-contracts.cjs')
const { MAX_RUN_AGENT_ATTEMPTS } = require('../runs/failure-policy.cjs')
const {
  loadWorkspaceState,
  saveWorkspaceState,
  workspaceSnapshot,
} = require('./local-workspace-state.cjs')

const MAX_AGENT_OUTCOME_ARTIFACTS = 16
const OUTCOME_RECORDER = Object.freeze({ kind: 'system', actorId: 'meldwork-main' })
const TERMINAL_RUN_STATUSES = new Set([
  'completed', 'partial', 'failed', 'stopped', 'timeout', 'round-limit', 'interrupted',
  'budget-exhausted', 'circuit-breaker',
])
const V4_VISIBLE_MESSAGE_PHASES = ['proposal', 'discussion', 'challenge', 'work', 'verification']

function naturalV4MessageBindingMatches(message, record, phase) {
  if (!record.orchestration?.discussionStyle || !['proposal', 'discussion'].includes(phase)) {
    return true
  }
  const round = Number(message?.trace?.round) || 0
  const slot = record.orchestration.slots?.find(candidate => (
    candidate.agentKind === message.agentKind
  ))
  if (round < 1 || !slot?.slotId) return false
  const operationPhase = phase === 'discussion' ? `discussion:${round}` : phase
  const operationId = `operation-${createHash('sha256').update(JSON.stringify([
    record.runId,
    record.taskId,
    message.agentKind,
    slot.slotId,
    operationPhase,
    round,
  ])).digest('hex')}`
  return message.trace?.context?.operationId === operationId
    && message.trace?.context?.snapshotHash === record.orchestration.snapshotHash
}

function isCommittedV4PhaseMessage(message, record) {
  const agentRunId = String(message?.trace?.agentRunId || '')
  if (message?.role !== 'agent' || message?.groupId !== record.groupId
      || message?.trace?.runId !== record.runId || !message.agentKind || !agentRunId) {
    return false
  }
  return V4_VISIBLE_MESSAGE_PHASES.some((phase) => {
    if (message.id !== `message-${hashValue({
      agentKind: message.agentKind,
      agentRunId,
      phase,
      runId: record.runId,
      taskId: record.taskId,
    })}`) return false
    return naturalV4MessageBindingMatches(message, record, phase)
  })
}

class LocalWorkspace extends EventEmitter {
  constructor(options) {
    super()
    this.storagePath = options.storagePath
    this.detectAgentsFn = options.detectAgents
    this.runAgentFn = options.runAgent
    this.resolveAttachmentsFn = options.resolveAttachments || (async (attachments) => {
      if (attachments?.length) throw new Error('LOCAL_ATTACHMENT_STORAGE_UNAVAILABLE')
      return []
    })
    this.captureAgentOutputsFn = options.captureAgentOutputs || (async () => null)
    this.importAgentOutputsFn = options.importAgentOutputs || (async () => [])
    this.captureArtifactOutputsFn = options.captureArtifactOutputs || (async () => null)
    this.captureAgentOutcomeDescriptorsFn = options.captureAgentOutcomeDescriptors
      || (async () => [])
    this.validateSkillSelectionsFn = options.validateSkillSelections || ((_kind, selections) => selections)
    this.validateKnowledgeBaseSelectionsFn = options.validateKnowledgeBaseSelections || ((_kinds, selections) => selections)
    this.imageAttachmentLimitFn = options.imageAttachmentLimit || (() => 0)
    this.attachmentSupportFn = options.attachmentSupport || (kind => ({
      image: this.imageAttachmentLimitFn(kind),
    }))
    this.credentialStateFn = options.credentialState || (async () => ({ state: 'unknown', source: 'unverified' }))
    this.agentLabelFn = options.agentLabel || defaultAgentLabel
    this.runSilenceWarningMs = Number.isFinite(options.runSilenceWarningMs)
      && options.runSilenceWarningMs > 0
      ? options.runSilenceWarningMs
      : DEFAULT_RUN_SILENCE_WARNING_MS
    this.runAgentTimeoutMs = Number.isFinite(options.runAgentTimeoutMs)
      && options.runAgentTimeoutMs > 0
      ? options.runAgentTimeoutMs
      : DEFAULT_RUN_AGENT_TIMEOUT_MS
    this.runAgentToolTimeoutMs = Number.isFinite(options.runAgentToolTimeoutMs)
      && options.runAgentToolTimeoutMs > 0
      ? options.runAgentToolTimeoutMs
      : DEFAULT_RUN_AGENT_TOOL_TIMEOUT_MS
    this.runAbortGraceMs = Number.isFinite(options.runAbortGraceMs)
      && options.runAbortGraceMs > 0
      ? options.runAbortGraceMs
      : DEFAULT_RUN_ABORT_GRACE_MS
    this.runBudgetDefaults = options.runBudgetDefaults || {}
    this.now = options.now || (() => new Date().toISOString())
    this.createId = options.createId || randomUUID
    this.createRunId = options.createRunId || randomUUID
    this.runLedger = options.runLedger || null
    this.workspaceRecovery = this.load()
    this.state = this.workspaceRecovery.state
    const privateRoot = path.join(path.dirname(this.storagePath), 'meldwork-private')
    this.contentBlobStore = options.contentBlobStore || new ContentBlobStore({
      rootPath: path.join(privateRoot, 'content-blobs'),
    })
    this.contextPackStore = options.contextPackStore || new ContextPackStore({
      rootPath: path.join(privateRoot, 'context-packs'),
    })
    this.outcomeStore = options.outcomeStore || new OutcomeStore({
      rootPath: path.join(privateRoot, 'outcomes'),
      contentBlobStore: this.contentBlobStore,
    })
    this.humanGateStore = options.humanGateStore || new HumanGateStore({
      storagePath: path.join(privateRoot, 'human-gates.json'),
      contentBlobStore: this.contentBlobStore,
    })
    this.humanGateCoordinator = options.humanGateCoordinator || new HumanGateCoordinator({
      store: this.humanGateStore,
      now: () => this.now(),
      onChanged: () => this.emitChanged(),
      onWaiting: (record, continuation) => this.markHumanGateWaiting(record, continuation),
      onResumed: record => this.markHumanGateResumed(record),
      canResume: record => this.canResumeHumanGate(record),
      onOrphanDecision: (record, decision) => this.resumeHumanGateDecision(record, decision),
      onResumeFailed: (record, error) => this.failHumanGateContinuation(record, error),
    })
    this.contextPacks = new LocalWorkspaceContextPacks({
      contentBlobStore: this.contentBlobStore,
      contextPackStore: this.contextPackStore,
    })
    if (this.workspaceRecovery.trusted) {
      this.runLedger?.reconcileContextPacks?.(
        contextPackId => this.contextPackStore.get(contextPackId),
      )
    }
    this.detectedAgents = []
    this.preparingRuns = new Map()
    this.activeRuns = new Map()
    this.pendingV4ManualRecoveries = new Map()
    this.pendingV4AutoRecoveries = new Map()
    this.runCheckpointTimers = new Map()
    this.humanGateWaitTails = new Map()
    this.shuttingDown = false
    this.agentCatalog = new LocalWorkspaceAgentCatalog({
      state: () => this.state,
      detectedAgents: () => this.detectedAgents,
      setDetectedAgents: agents => { this.detectedAgents = agents },
      detectAgents: () => this.detectAgentsFn(),
      credentialState: (...args) => this.credentialStateFn(...args),
      attachmentSupport: kind => this.attachmentSupportFn(kind),
      save: () => this.save(),
      emitChanged: () => this.emitChanged(),
      snapshot: () => this.snapshot(),
      now: () => this.now(),
    })
    this.agentRouter = options.agentRouter || new AgentRouter({
      attachmentSupport: kind => this.attachmentSupportFn(kind),
      fitMatrix: options.agentFitMatrix,
    })
    this.runLedgerCoordinator = new LocalWorkspaceRunLedger({
      runLedger: this.runLedger,
      state: () => this.state,
      save: () => this.save(),
      createId: () => this.createId(),
      now: () => this.now(),
      agentLabel: kind => this.agentLabel(kind),
      preserveWaitingRun: record => this.canResumeHumanGateRecord(record),
      preparingRuns: this.preparingRuns,
      timers: this.runCheckpointTimers,
    })
    this.runCoordinator = new LocalWorkspaceRunCoordinator({
      preparingRuns: this.preparingRuns,
      activeRuns: this.activeRuns,
      createRunId: () => this.createRunId(),
      getRunSilenceWarningMs: () => this.runSilenceWarningMs,
      isShuttingDown: () => this.shuttingDown,
      setShuttingDown: value => { this.shuttingDown = value },
      checkpointRun: (...args) => this.checkpointRun(...args),
      hasRunLedger: () => Boolean(this.runLedger),
      validateContextPack: (contextPackId, taskId) => {
        const pack = this.contextPackStore.get(contextPackId)
        return pack.contextPackId === contextPackId && pack.taskId === taskId
      },
      finishRunCheckpoint: (...args) => this.finishRunCheckpoint(...args),
      scheduleRunCheckpoint: (...args) => this.scheduleRunCheckpoint(...args),
      emitChanged: () => this.emitChanged(),
      emit: (...args) => this.emit(...args),
      runBudgetDefaults: this.runBudgetDefaults,
      retryBaseDelayMs: options.retryBaseDelayMs,
      retryMaxDelayMs: options.retryMaxDelayMs,
      terminalRetrySleep: options.terminalRetrySleep,
    })
    this.conversations = new LocalWorkspaceConversations({
      state: () => this.state,
      detectedAgents: () => this.detectedAgents,
      save: () => this.save(),
      emitChanged: () => this.emitChanged(),
      isGroupBusy: groupId => this.isGroupBusy(groupId),
      clearSessionState: groupId => this.clearSessionState(groupId),
      runLedger: this.runLedger,
      agentLabel: kind => this.agentLabel(kind),
      createId: () => this.createId(),
      now: () => this.now(),
    })
    this.runMessages = new LocalWorkspaceRunMessages({
      state: () => this.state,
      activeRuns: this.activeRuns,
      agentLabel: kind => this.agentLabel(kind),
      checkpointRun: (...args) => this.checkpointRun(...args),
      addMessage: (...args) => this.addMessage(...args),
    })
    this.agentInvocation = new LocalWorkspaceAgentInvocation({
      state: () => this.state,
      detectedAgents: () => this.detectedAgents,
      activeRuns: this.activeRuns,
      runAgentTimeoutMs: this.runAgentTimeoutMs,
      runAgentToolTimeoutMs: this.runAgentToolTimeoutMs,
      runAbortGraceMs: this.runAbortGraceMs,
      defaultYolo: options.defaultYolo,
      naturalAgentResponses: options.naturalAgentResponses,
      captureAgentOutputs: (...args) => this.captureAgentOutputsFn(...args),
      captureArtifactOutputs: (...args) => this.captureArtifactOutputsFn(...args),
      captureAgentOutcomeDescriptors: (...args) => (
        this.captureAgentOutcomeDescriptorsFn(...args)
      ),
      runAgent: (...args) => this.runAgentFn(...args),
      importAgentOutputs: (...args) => this.importAgentOutputsFn(...args),
      recordAgentOutcomes: (...args) => this.recordAgentOutcomes(...args),
      sessionKey: (...args) => this.sessionKey(...args),
      sessionState: (...args) => this.sessionState(...args),
      openClawSessionRef: (...args) => this.openClawSessionRef(...args),
      save: () => this.save(),
      packedPromptContext: (...args) => this.packedPromptContext(...args),
      ensureRunHarness: (...args) => this.ensureRunHarness(...args),
      emitRunEvent: event => this.emitRunEvent(event),
      armAgentSilence: (...args) => this.armAgentSilence(...args),
      clearAgentSilence: (...args) => this.clearAgentSilence(...args),
      checkpointRun: (...args) => this.checkpointRun(...args),
      hasRunLedger: () => Boolean(this.runLedger),
      scheduleRunCheckpoint: (...args) => this.scheduleRunCheckpoint(...args),
      emitChanged: () => this.emitChanged(),
      promptFor: (...args) => this.promptFor(...args),
      persistSessionState: (...args) => this.persistSessionState(...args),
      createAttemptContextPack: (...args) => this.createAttemptContextPack(...args),
      recordContextDelivery: (...args) => this.recordContextDelivery(...args),
      markRuntimeCredential: (...args) => this.markRuntimeCredential(...args),
      addMessage: (...args) => this.addMessage(...args),
      runScheduler: options.runScheduler,
      registerAgentController: (...args) => this.runCoordinator.registerAgentController(...args),
      unregisterAgentController: (...args) => this.runCoordinator.unregisterAgentController(...args),
      requestHumanGate: (...args) => this.requestHumanGate(...args),
      completeHumanGateContinuation: (...args) => this.completeHumanGateContinuation(...args),
      connectorRuntime: options.connectorRuntime,
      attachmentSupport: (...args) => this.attachmentSupportFn(...args),
    })
    this.autoRunner = new LocalWorkspaceAutoRunner({
      state: () => this.state,
      canWriteWorkspace: kind => agentRuntimeCapabilities(kind, {
        agent: this.detectedAgents.find(agent => agent.kind === kind),
      }).permissionModes.includes('workspace-write'),
      beginRun: (...args) => this.beginRun(...args),
      resolveAttachments: (...args) => this.resolveAttachments(...args),
      validateSkillSelections: (...args) => this.validateSkillSelectionsFn(...args),
      validateKnowledgeBaseSelections: (...args) => this.validateKnowledgeBaseSelectionsFn(...args),
      invokeAgent: (...args) => this.invokeAgent(...args),
      defaultYolo: options.defaultYolo,
      naturalAgentResponses: options.naturalAgentResponses,
      resetAgentSession: (...args) => this.resetAgentSession(...args),
      refreshAgents: () => this.refreshAgents(),
      consumeAgentControl: (...args) => this.runCoordinator.consumeAgentControl(...args),
      markRuntimeCredential: (...args) => this.markRuntimeCredential(...args),
      agentLabel: kind => this.agentLabel(kind),
      recordAgentFailure: (...args) => this.recordAgentFailure(...args),
      recordAgentInterruption: (...args) => this.recordAgentInterruption(...args),
      addMessage: (...args) => this.addMessage(...args),
      removeAgent: (...args) => this.conversations.removeAgent(...args),
      commitV4AgentMessage: input => this.commitV4AgentMessage(input),
      emitChanged: () => this.emitChanged(),
      finishRun: (...args) => this.finishRun(...args),
      outcomeStore: this.outcomeStore,
      contentBlobStore: this.contentBlobStore,
      checkpointRun: (...args) => this.checkpointRun(...args),
      hasRunLedger: () => Boolean(this.runLedger),
      requestHumanGate: (...args) => this.requestHumanGate(...args),
      completeHumanGateContinuation: (...args) => this.completeHumanGateContinuation(...args),
      requestTaskDecision: (...args) => this.requestV4TaskDecision(...args),
      taskDecisionResponses: runId => this.v4TaskDecisionResponses(runId),
      retryContract: kind => ({
        idempotencyMode: this.detectedAgents.find(agent => agent.kind === kind)?.idempotencyMode
          === 'durable'
          ? 'durable'
          : 'none',
      }),
      retryBaseDelayMs: options.retryBaseDelayMs,
      retryMaxDelayMs: options.retryMaxDelayMs,
      retrySleep: options.retrySleep,
    })
    this.messageSubmission = new LocalWorkspaceMessageSubmission({
      state: () => this.state,
      detectedAgents: () => this.detectedAgents,
      isShuttingDown: () => this.shuttingDown,
      resolveAttachments: (...args) => this.resolveAttachmentsFn(...args),
      attachmentSupport: (...args) => this.attachmentSupportFn(...args),
      validateSkillSelections: (...args) => this.validateSkillSelectionsFn(...args),
      validateKnowledgeBaseSelections: (...args) => this.validateKnowledgeBaseSelectionsFn(...args),
      getGroup: (...args) => this.getGroup(...args),
      isGroupBusy: (...args) => this.isGroupBusy(...args),
      reserveRun: (...args) => this.reserveRun(...args),
      bindRunTask: (...args) => this.bindRunTask(...args),
      releasePreparation: (...args) => this.releasePreparation(...args),
      addMessage: (...args) => this.addMessage(...args),
      rollbackAddedMessage: (...args) => this.conversations.rollbackAddedMessage(...args),
      startAutoRunner: (...args) => this.startAutoRunner(...args),
      beginRun: (...args) => this.beginRun(...args),
      invokeAgent: (...args) => this.invokeAgent(...args),
      invokeWithRecovery: input => this.autoRunner.invokeWithUnauthorizedRecovery({
        ...input,
        mode: 'manual',
      }),
      recordAgentInterruption: (...args) => this.recordAgentInterruption(...args),
      recordAgentFailure: (...args) => this.recordAgentFailure(...args),
      emitChanged: () => this.emitChanged(),
      snapshot: () => this.snapshot(),
      finishRun: (...args) => this.finishRun(...args),
      createContextPack: (...args) => this.createContextPack(...args),
      configureRunBudget: (...args) => this.runCoordinator.configureBudget(...args),
      resetAgentSession: (...args) => this.resetAgentSession(...args),
      refreshAgents: () => this.refreshAgents(),
      consumeAgentControl: (...args) => this.runCoordinator.consumeAgentControl(...args),
      checkpointRun: (...args) => this.checkpointRun(...args),
      hasRunLedger: () => Boolean(this.runLedger),
      routeAgents: input => this.agentRouter.route(input),
      contentBlobStore: this.contentBlobStore,
      outcomeStore: this.outcomeStore,
      commitV4AgentMessage: input => this.commitV4AgentMessage(input),
      requestHumanGate: (...args) => this.requestHumanGate(...args),
      completeHumanGateContinuation: (...args) => this.completeHumanGateContinuation(...args),
    })
    if (this.workspaceRecovery.trusted) {
      this.humanGateCoordinator.reconcileDecisions?.()
      this.restoreInterruptedRuns()
      this.humanGateCoordinator.reconcileOrphans?.()
    }
  }

  agentLabel(kind) {
    return cleanInline(this.agentLabelFn(kind), 60) || defaultAgentLabel(kind)
  }

  load() {
    return loadWorkspaceState(this.storagePath)
  }

  save() {
    if (!this.workspaceRecovery.trusted) {
      throw new Error(this.workspaceRecovery.diagnostic || 'LOCAL_WORKSPACE_STATE_UNTRUSTED')
    }
    saveWorkspaceState(this.storagePath, this.state)
  }

  restoreInterruptedRuns() {
    const recoverableV4Manual = this.recoverableV4ManualRecords()
    const recoverableV4Auto = this.recoverableV4AutoRecords()
    this.runLedgerCoordinator.restoreInterruptedRuns()
    if (!recoverableV4Manual.length && !recoverableV4Auto.length) return

    let messagesChanged = false
    for (const record of recoverableV4Manual) {
      let durable
      try {
        durable = this.runLedger.checkpoint(record)
      } catch {
        continue
      }
      const allowedMessageIds = new Set(
        durable.orchestration.slots.map(slot => slot.messageId).filter(Boolean),
      )
      const retainedMessages = this.state.messages.filter(message => (
        message.trace?.runId !== durable.runId || allowedMessageIds.has(message.id)
      ))
      if (retainedMessages.length !== this.state.messages.length) {
        this.state.messages = retainedMessages
        messagesChanged = true
      }
      this.prepareV4ManualRecovery(durable)
    }
    for (const record of recoverableV4Auto) {
      let durable
      try {
        durable = this.runLedger.checkpoint(record)
      } catch {
        continue
      }
      const allowedMessageIds = new Set([
        ...(durable.orchestration.commitState.messageIds || []),
        ...(durable.orchestration.candidateCommit?.messageId
          ? [durable.orchestration.candidateCommit.messageId] : []),
      ])
      const retainedMessages = this.state.messages.filter(message => (
        message.trace?.runId !== durable.runId
          || allowedMessageIds.has(message.id)
          || isCommittedV4PhaseMessage(message, durable)
      ))
      if (retainedMessages.length !== this.state.messages.length) {
        this.state.messages = retainedMessages
        messagesChanged = true
      }
      this.prepareV4AutoRecovery(durable)
    }
    if (messagesChanged) this.save()
  }

  recoverableV4ManualRecords() {
    let records = []
    try { records = this.runLedger?.list?.() || [] } catch { return [] }
    const groupIds = new Set(this.state.groups.map(group => group.id))
    const retainedGroups = new Set()
    return records.filter((record) => {
      const orchestration = record?.orchestration
      const terminalRecovery = record?.continuation
        ? this.v4ManualTerminalRecovery(record)
        : null
      if (record?.mode !== 'manual' || TERMINAL_RUN_STATUSES.has(record.status)
          || !groupIds.has(record.groupId) || retainedGroups.has(record.groupId)
          || orchestration?.version !== 4 || orchestration.workflow !== 'manual'
          || orchestration.template !== 'concurrent-batch'
          || (record.continuation && !terminalRecovery)) {
        return false
      }
      retainedGroups.add(record.groupId)
      return true
    })
  }

  recoverableV4AutoRecords() {
    let records = []
    try { records = this.runLedger?.list?.() || [] } catch { return [] }
    const groupIds = new Set(this.state.groups.map(group => group.id))
    const retainedGroups = new Set()
    return records.filter((record) => {
      const orchestration = record?.orchestration
      const terminalRecovery = record?.continuation
        ? this.v4SynthesisTerminalRecovery(record)
        : null
      const commitState = orchestration?.commitState
      const candidateCommit = orchestration?.candidateCommit
      const resumablePhase = [
        'proposal', 'discussion', 'challenge', 'coordination', 'work', 'synthesis', 'verification',
      ].includes(orchestration?.phase)
      const resumableCommit = ['commit', 'committed', 'completed'].includes(orchestration?.phase)
        && ['committing', 'committed'].includes(commitState?.status)
        && Array.isArray(commitState.messageIds) && commitState.messageIds.length === 1
      const resumableCandidateCommit = ['commit', 'completed'].includes(orchestration?.phase)
        && ['intent', 'message-committed', 'sinks-committed', 'completed']
          .includes(candidateCommit?.status)
        && candidateCommit.messageId
        && candidateCommit.blackboardEntryId
      const synthesisGateBinding = orchestration?.synthesisRecovery?.pendingGate
      const resumableSynthesisGate = orchestration?.phase === 'human-gate'
        && synthesisGateBinding
        && orchestration.synthesisRecovery.attempts?.some(attempt => (
          attempt.status === 'unknown_outcome'
          && attempt.writerKind === synthesisGateBinding.writerKind
          && attempt.operationId === synthesisGateBinding.operationId
        ))
      if (record?.mode !== 'auto' || TERMINAL_RUN_STATUSES.has(record.status)
          || !groupIds.has(record.groupId) || retainedGroups.has(record.groupId)
          || orchestration?.version !== 4 || orchestration.workflow !== 'auto'
          || orchestration.template !== 'discussion'
          || (record.continuation && record.continuation.state !== 'completed' && !terminalRecovery)
          || (!resumablePhase && !resumableCommit
            && !resumableCandidateCommit && !resumableSynthesisGate && !terminalRecovery)) {
        return false
      }
      retainedGroups.add(record.groupId)
      return true
    })
  }

  prepareV4ManualRecovery(durable) {
    const group = this.state.groups.find(item => item.id === durable.groupId)
    if (!group || this.activeRuns.has(group.id)) return false
    const controller = this.createRunController(
      'manual', durable.targetKinds, durable.threadRootId,
    )
    controller.runId = durable.runId
    controller.taskId = durable.taskId
    controller.contextPackId = durable.contextPackId
    controller.taskBound = true
    controller.groupId = group.id
    controller.currentRound = durable.currentRound || 0
    controller.startedAt = durable.startedAt
    controller.attemptHistory = [...(durable.attemptHistory || [])]
    controller.orchestration = structuredClone(durable.orchestration)
    controller.continuation = durable.continuation
      ? structuredClone(durable.continuation)
      : null
    controller.completedKinds = controller.orchestration.slots
      .filter(slot => ['completed', 'partial', 'failed', 'stopped', 'timeout', 'interrupted']
        .includes(slot.status))
      .map(slot => slot.agentKind)
    controller.failedKinds = controller.orchestration.slots
      .filter(slot => ['failed', 'stopped', 'timeout', 'interrupted'].includes(slot.status))
      .map(slot => slot.agentKind)
    controller.harness = new RunHarness({
      runId: durable.runId,
      groupId: group.id,
      threadRootId: durable.threadRootId,
      targetKinds: durable.targetKinds,
      agentRuns: durable.agentRuns,
    })
    if (durable.budget) {
      controller.budget = new RunBudget({
        ...durable.budget,
        now: Date.now,
      })
    }
    this.activeRuns.set(group.id, controller)
    this.pendingV4ManualRecoveries.set(durable.runId, { group, durable, controller })
    return true
  }

  prepareV4AutoRecovery(durable) {
    const group = this.state.groups.find(item => item.id === durable.groupId)
    if (!group || this.activeRuns.has(group.id)) return false
    const controller = this.createRunController(
      'auto', durable.targetKinds, durable.threadRootId,
      durable.maxRounds, durable.unlimitedRounds,
    )
    controller.runId = durable.runId
    controller.taskId = durable.taskId
    controller.contextPackId = durable.contextPackId
    controller.taskBound = true
    controller.groupId = group.id
    controller.currentRound = durable.currentRound || 0
    controller.startedAt = durable.startedAt
    controller.attemptHistory = [...(durable.attemptHistory || [])]
    controller.orchestration = structuredClone(durable.orchestration)
    controller.continuation = durable.continuation
      ? structuredClone(durable.continuation)
      : null
    controller.v4 = true
    controller.completedKinds = controller.orchestration.slots
      .filter(slot => ['completed', 'partial', 'failed', 'stopped', 'timeout', 'interrupted']
        .includes(slot.status))
      .map(slot => slot.agentKind)
    controller.failedKinds = controller.orchestration.slots
      .filter(slot => ['failed', 'stopped', 'timeout', 'interrupted'].includes(slot.status))
      .map(slot => slot.agentKind)
    controller.harness = new RunHarness({
      runId: durable.runId,
      groupId: group.id,
      threadRootId: durable.threadRootId,
      targetKinds: durable.targetKinds,
      agentRuns: durable.agentRuns,
    })
    if (durable.budget) {
      controller.budget = new RunBudget({ ...durable.budget, now: Date.now })
    }
    this.activeRuns.set(group.id, controller)
    this.pendingV4AutoRecoveries.set(durable.runId, { group, durable, controller })
    return true
  }

  resumeV4ManualRecoveries() {
    const recoveries = [...this.pendingV4ManualRecoveries.values()]
    this.pendingV4ManualRecoveries.clear()
    for (const recovery of recoveries) {
      queueMicrotask(() => {
        this.resumeV4ManualRecovery(recovery).catch((error) => {
          if (!recovery.controller.stopReason) {
            recovery.controller.stopReason = String(
              error?.code || error?.message || 'LOCAL_RUN_CONTINUATION_INVALID',
            )
          }
        })
      })
    }
  }

  resumeV4AutoRecoveries() {
    const recoveries = [...this.pendingV4AutoRecoveries.values()]
    this.pendingV4AutoRecoveries.clear()
    for (const recovery of recoveries) {
      queueMicrotask(() => {
        this.resumeV4AutoRecovery(recovery).catch((error) => {
          if (!recovery.controller.stopReason) {
            recovery.controller.stopReason = String(
              error?.code || error?.message || 'LOCAL_RUN_CONTINUATION_INVALID',
            )
          }
        })
      })
    }
  }

  async resumeV4AutoRecovery({ group, durable, controller }) {
    try {
      const terminalRecovery = this.v4SynthesisTerminalRecovery(durable)
      if (terminalRecovery?.state === 'cancelled') {
        controller.stopReason = 'human_gate_rejected'
        await this.finishRun(group.id, controller, 'stopped')
        return
      }
      const finalStatus = await this.autoRunner.resume(group, durable, controller)
      await this.finishRun(group.id, controller, finalStatus)
    } catch (error) {
      if (controller.signal.aborted) {
        await this.finishRun(group.id, controller, terminalRunStatusForReason(controller.stopReason))
        return
      }
      controller.stopReason = String(error?.message || 'LOCAL_RUN_CONTINUATION_INVALID')
      await this.finishRun(group.id, controller, 'failed')
    }
  }

  async resumeV4ManualRecovery({ group, durable, controller }) {
    try {
      const terminalRecovery = this.v4ManualTerminalRecovery(durable)
      if (terminalRecovery?.state === 'cancelled') {
        controller.stopReason = 'human_gate_rejected'
        await this.finishRun(group.id, controller, 'stopped')
        return
      }
      if (terminalRecovery?.state === 'failed') {
        controller.stopReason = durable.reason || 'human_gate_continuation_failed'
        await this.finishRun(group.id, controller, 'failed')
        return
      }
      const result = await this.messageSubmission.resumeV4Manual({
        group,
        durable,
        controller,
        ...(terminalRecovery ? {
          onlyKind: terminalRecovery.slot.agentKind,
          resumedGate: {
            gateId: terminalRecovery.gate.gateId,
            type: terminalRecovery.gate.type,
            agentRunId: terminalRecovery.gate.agentRunId,
            agentKind: terminalRecovery.gate.agentKind,
            status: terminalRecovery.gate.status,
            optionId: terminalRecovery.gate.decision.optionId,
            request: terminalRecovery.request,
            requestHash: terminalRecovery.gate.requestHash,
            used: false,
          },
        } : {}),
      })
      await this.finishRun(group.id, controller, result.status)
    } catch (error) {
      controller.stopReason = String(error?.message || 'LOCAL_RUN_CONTINUATION_INVALID')
      await this.finishRun(group.id, controller, 'failed')
    }
  }

  runLedgerRecord(groupId, controller, status = '') {
    return this.runLedgerCoordinator.record(groupId, controller, status)
  }

  checkpointRun(groupId, controller, status = '') {
    return this.runLedgerCoordinator.checkpoint(groupId, controller, status)
  }

  scheduleRunCheckpoint(groupId, controller) {
    if (this.shuttingDown) return
    this.runLedgerCoordinator.schedule(groupId, controller)
  }

  finishRunCheckpoint(groupId, controller, status) {
    return this.runLedgerCoordinator.finish(groupId, controller, status)
  }

  snapshot() {
    return workspaceSnapshot(this)
  }

  emitChanged() {
    this.emit('changed', this.snapshot())
  }

  createRunController(mode, targetKinds, threadRootId, maxRounds = 0, unlimitedRounds = false) {
    return this.runCoordinator.createController(
      mode, targetKinds, threadRootId, maxRounds, unlimitedRounds,
    )
  }

  isGroupBusy(groupId) {
    if (this.runCoordinator.isGroupBusy(groupId)) return true
    try {
      return (this.runLedger?.list?.(groupId) || []).some(record => (
        record.status === 'waiting' && this.canResumeHumanGateRecord(record)
      ))
    } catch {
      return false
    }
  }

  reserveRun(
    groupId, mode, targetKinds, threadRootId = '', maxRounds = 0, unlimitedRounds = false,
  ) {
    return this.runCoordinator.reserve(
      groupId, mode, targetKinds, threadRootId, maxRounds, unlimitedRounds,
    )
  }

  bindRunTask(groupId, controller, taskId, threadRootId = '', contextPackId = '') {
    return this.runCoordinator.bindTask(
      groupId, controller, taskId, threadRootId, contextPackId,
    )
  }

  releasePreparation(groupId, controller) {
    return this.runCoordinator.releasePreparation(groupId, controller)
  }

  beginRun(
    groupId, mode, targetKinds, threadRootId, reservation = null, maxRounds = 0,
    unlimitedRounds = false,
  ) {
    return this.runCoordinator.begin(
      groupId, mode, targetKinds, threadRootId, reservation, maxRounds, unlimitedRounds,
    )
  }

  finishRun(groupId, controller, status) {
    return this.runCoordinator.finish(groupId, controller, status)
  }

  configureRunBudget(controller, input = {}) {
    return this.runCoordinator.configureBudget(controller, input)
  }

  controllerForRunId(runId) {
    return [...this.activeRuns.entries()].find(([, controller]) => controller.runId === runId) || null
  }

  continuationTimestamp() {
    const timestamp = Date.parse(this.now())
    return Number.isFinite(timestamp) ? timestamp : Date.now()
  }

  markHumanGateWaiting(record, input) {
    const match = this.controllerForRunId(record?.runId)
    if (!match || !input || typeof input !== 'object') {
      throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
    }
    const [groupId, controller] = match
    const invocationFields = ['phase', 'slotId', 'operationId', 'snapshotHash']
    const invocationFieldCount = invocationFields.filter(field => Object.hasOwn(input, field)).length
    if (invocationFieldCount > 0
        && (!['agent_slot', 'v4_task_decision'].includes(input.resumeKind)
          || invocationFieldCount !== invocationFields.length)) {
      throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
    }
    const previousWaitingGateIds = new Set(controller.waitingGateIds)
    const previousContinuation = controller.continuation
    const timestamp = this.continuationTimestamp()
    try {
      controller.continuation = {
        gateId: record.gateId,
        gateType: record.type,
        resumeKind: input.resumeKind,
        state: 'pending',
        agentRunId: input.agentRunId,
        ...(input.publicAgentRunId ? { publicAgentRunId: input.publicAgentRunId } : {}),
        agentKind: input.agentKind,
        round: input.round || 0,
        ...(['v4_human_gate', 'v4_synthesis_recovery'].includes(input.resumeKind)
          ? { stateEpoch: input.stateEpoch }
          : {}),
        ...(invocationFieldCount === invocationFields.length ? {
          phase: input.phase,
          slotId: input.slotId,
          operationId: input.operationId,
          snapshotHash: input.snapshotHash,
        } : {}),
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(input.requestId ? {
          requestId: input.requestId,
          requestHash: record.requestHash,
          sessionRefHash: input.sessionRefHash,
          sessionProvenanceHash: input.sessionProvenanceHash,
        } : {}),
      }
      controller.waitingGateIds.add(record.gateId)
      if (this.runLedger && this.checkpointRun(groupId, controller, 'waiting') !== true) {
        throw new Error('LOCAL_RUN_PERSIST_FAILED')
      }
    } catch (error) {
      controller.waitingGateIds.clear()
      for (const gateId of previousWaitingGateIds) controller.waitingGateIds.add(gateId)
      controller.continuation = previousContinuation
      throw error
    }
    return true
  }

  markHumanGateResumed(record) {
    const match = this.controllerForRunId(record?.runId)
    if (!match) {
      const durable = this.runLedger?.get?.(record?.runId)
      if (!durable?.continuation || durable.continuation.gateId !== record.gateId) return false
      this.runLedger.checkpoint({
        runId: durable.runId,
        continuation: {
          ...durable.continuation,
          state: 'ready',
          updatedAt: this.continuationTimestamp(),
        },
      })
      return true
    }
    const [groupId, controller] = match
    const previousWaitingGateIds = new Set(controller.waitingGateIds)
    const previousContinuation = controller.continuation
    try {
      controller.waitingGateIds.delete(record.gateId)
      if (controller.continuation?.gateId === record.gateId) {
        controller.continuation = {
          ...controller.continuation,
          state: 'ready',
          updatedAt: this.continuationTimestamp(),
        }
      }
      if (this.runLedger && this.checkpointRun(
        groupId, controller, controller.waitingGateIds.size ? 'waiting' : 'running',
      ) !== true) throw new Error('LOCAL_RUN_PERSIST_FAILED')
    } catch (error) {
      controller.waitingGateIds.clear()
      for (const gateId of previousWaitingGateIds) controller.waitingGateIds.add(gateId)
      controller.continuation = previousContinuation
      throw error
    }
    return true
  }

  v4SynthesisRecoveryGateMatch(
    runRecord, gateRecord, gateInput = null, allowTerminalContinuation = false,
  ) {
    const orchestration = runRecord?.orchestration
    const recovery = orchestration?.synthesisRecovery
    const binding = recovery?.pendingGate
    if (runRecord?.mode !== 'auto' || TERMINAL_RUN_STATUSES.has(runRecord.status)
        || (!allowTerminalContinuation && runRecord.continuation) || orchestration?.version !== 4
        || orchestration.workflow !== 'auto' || orchestration.template !== 'discussion'
        || orchestration.phase !== 'human-gate' || !binding) return null
    const terminalState = allowTerminalContinuation ? runRecord.continuation?.state : ''
    const matchingAttempts = recovery.attempts?.filter(attempt => (
      attempt.status === (terminalState === 'cancelled' ? 'cancelled' : 'unknown_outcome')
      && attempt.outcomeCertainty === 'unknown_outcome'
      && attempt.permission === 'workspace-write'
      && attempt.leaseAcquired === true
      && attempt.sideEffectsPossible === true
      && attempt.writerKind === binding.writerKind
      && attempt.slotId === binding.slotId
      && attempt.operationId === binding.operationId
      && attempt.attempt === binding.attempt
    )) || []
    const slot = orchestration.slots?.find(candidate => (
      candidate.slotId === binding.slotId
      && candidate.agentKind === binding.writerKind
      && candidate.operationId === binding.operationId
      && candidate.permission === 'workspace-write'
      && ['waiting', 'failed'].includes(candidate.status)
    ))
    const bindingFields = {
      writerKind: binding.writerKind,
      slotId: binding.slotId,
      operationId: binding.operationId,
      attempt: binding.attempt,
      proposedReplacementKind: binding.proposedReplacementKind,
      round: binding.round,
      stateEpoch: binding.stateEpoch,
      rankingFingerprint: binding.rankingFingerprint,
    }
    if (matchingAttempts.length !== 1 || !slot
        || recovery.activeWriterKind !== binding.writerKind
        || recovery.stateEpoch !== binding.stateEpoch
        || recovery.rankingFingerprint !== binding.rankingFingerprint
        || binding.bindingHash !== hashValue(bindingFields)) return null
    const expectedSummary = 'The workspace-write synthesis attempt may have produced side effects, but its result is unknown.'
    const expectedOptions = [
      { optionId: 'retry-original-writer', name: 'Retry original writer', kind: 'accept' },
      ...(binding.proposedReplacementKind ? [{
        optionId: 'replace-next-writer', name: 'Replace with next writer', kind: 'accept',
      }] : []),
      { optionId: 'stop-discussion', name: 'Stop', kind: 'reject' },
    ]
    const expectedRequest = {
      phase: 'synthesis-recovery',
      bindingHash: binding.bindingHash,
      writerKind: binding.writerKind,
      slotId: binding.slotId,
      operationId: binding.operationId,
      attempt: binding.attempt,
      proposedReplacementKind: binding.proposedReplacementKind,
      round: binding.round,
      stateEpoch: binding.stateEpoch,
      outcomeCertainty: 'unknown_outcome',
    }
    let gate
    let request
    try {
      gate = this.humanGateStore.get(gateRecord?.gateId)
      request = this.humanGateStore.request(gate.gateId)
    } catch {
      return null
    }
    const expectedRequestFields = Reflect.ownKeys(expectedRequest)
    const requestFields = request && typeof request === 'object' && !Array.isArray(request)
      ? Reflect.ownKeys(request)
      : []
    const continuation = runRecord.continuation
    const terminalPublicAttempts = allowTerminalContinuation
      ? (runRecord.agentRuns || []).filter(attempt => (
          attempt?.agentRunId === continuation?.publicAgentRunId
            && attempt?.kind === continuation?.agentKind
        ))
      : []
    const terminalPublicSlots = allowTerminalContinuation
      ? orchestration.slots.filter(candidate => (
          candidate.slotId === binding.slotId
            && candidate.agentKind === continuation?.agentKind
            && candidate.operationId === binding.operationId
            && candidate.agentRunId === continuation?.publicAgentRunId
        ))
      : []
    const expectedGateStatus = terminalState === 'cancelled'
      ? 'rejected'
      : (terminalState === 'completed' ? 'approved' : 'pending')
    if (gate.status !== expectedGateStatus
        || gate.type !== 'decision'
        || gate.runId !== runRecord.runId || gate.agentRunId !== binding.operationId
        || gate.agentKind !== binding.writerKind || gate.summary !== expectedSummary
        || gate.expiresAt !== undefined || hashValue(gate.options) !== hashValue(expectedOptions)
        || requestFields.length !== expectedRequestFields.length
        || !requestFields.every(field => expectedRequestFields.includes(field))
        || hashValue(request) !== hashValue(expectedRequest)
        || (allowTerminalContinuation && (
          !['completed', 'cancelled'].includes(continuation?.state)
          || continuation.gateId !== gate.gateId
          || continuation.gateType !== gate.type
          || continuation.resumeKind !== 'v4_synthesis_recovery'
          || continuation.agentRunId !== binding.operationId
          || continuation.agentKind !== binding.writerKind
          || continuation.round !== binding.round
          || continuation.stateEpoch !== binding.stateEpoch
          || !continuation.publicAgentRunId
          || terminalPublicAttempts.length !== 1
          || terminalPublicSlots.length !== 1
        ))) return null
    if (gateInput) {
      const expectedInputFields = [
        'type', 'runId', 'agentRunId', 'agentKind', 'summary', 'options', 'request',
      ]
      const inputFields = Reflect.ownKeys(gateInput)
      const inputRequestFields = gateInput.request && typeof gateInput.request === 'object'
        && !Array.isArray(gateInput.request) ? Reflect.ownKeys(gateInput.request) : []
      if (inputFields.length !== expectedInputFields.length
          || !inputFields.every(field => expectedInputFields.includes(field))
          || gateInput.type !== gate.type || gateInput.runId !== gate.runId
          || gateInput.agentRunId !== gate.agentRunId || gateInput.agentKind !== gate.agentKind
          || gateInput.summary !== gate.summary
          || hashValue(gateInput.options) !== hashValue(gate.options)
          || inputRequestFields.length !== expectedRequestFields.length
          || !inputRequestFields.every(field => expectedRequestFields.includes(field))
          || hashValue(gateInput.request) !== hashValue(request)) return null
    }
    return { gate, binding }
  }

  v4SynthesisTerminalRecovery(runRecord, gateInput = null) {
    const continuation = runRecord?.continuation
    if (!['completed', 'cancelled'].includes(continuation?.state)
        || continuation.resumeKind !== 'v4_synthesis_recovery') return null
    let gate
    try { gate = this.humanGateStore.get(continuation.gateId) } catch { return null }
    const match = this.v4SynthesisRecoveryGateMatch(runRecord, gate, gateInput, true)
    if (!match) return null
    const cancelled = continuation.state === 'cancelled'
      && gate.decision?.status === 'rejected'
      && gate.decision.optionId === 'stop-discussion'
    const completed = continuation.state === 'completed'
      && gate.decision?.status === 'approved'
      && ['retry-original-writer', 'replace-next-writer'].includes(gate.decision.optionId)
      && (gate.decision.optionId !== 'replace-next-writer'
        || Boolean(match.binding.proposedReplacementKind))
    if (!cancelled && !completed) return null
    return { ...match, state: continuation.state }
  }

  v4ManualRecoveryGateMatch(
    runRecord, gateRecord, gateInput = null, allowContinuation = false,
  ) {
    const orchestration = runRecord?.orchestration
    if (runRecord?.mode !== 'manual' || TERMINAL_RUN_STATUSES.has(runRecord.status)
        || orchestration?.version !== 4 || orchestration.workflow !== 'manual'
        || orchestration.template !== 'concurrent-batch' || orchestration.phase !== 'proposal'
        || (!allowContinuation && runRecord.continuation)) return null
    let gate
    let request
    try {
      gate = this.humanGateStore.get(gateRecord?.gateId)
      request = this.humanGateStore.request(gate.gateId)
    } catch {
      return null
    }
    const slot = orchestration.slots?.find(candidate => (
      candidate.slotId === request?.slotId
      && candidate.agentKind === gate.agentKind
      && candidate.operationId === request?.operationId
    ))
    const slotIndex = runRecord.targetKinds?.indexOf(slot?.agentKind) ?? -1
    const expectedSlotId = `slot-${slotIndex + 1}-${slot?.agentKind}`
    const expectedOperationId = slot ? `agent-operation-${createHash('sha256').update(
      `${runRecord.runId}:${orchestration.batchId}:${slot.agentKind}`,
    ).digest('hex')}` : ''
    const assignment = orchestration.plan?.assignments?.find(item => item.slotId === slot?.slotId)
    const continuation = runRecord.continuation
    const allowedContinuationSlot = allowContinuation
      && ['running', 'queued', 'completed', 'partial', 'failed'].includes(slot?.status)
    if (!slot || slotIndex < 0 || slot.slotId !== expectedSlotId
        || slot.operationId !== expectedOperationId || slot.commitStatus === 'committed'
        || orchestration.commitState?.writerKind !== slot.agentKind
        || assignment?.agentKind !== slot.agentKind
        || assignment?.operationId !== slot.operationId
        || (!allowContinuation && !isV4ManualUnknownWriter(slot))
        || (allowContinuation && !allowedContinuationSlot)
        || (allowContinuation && continuation && (
          continuation.gateId !== gate.gateId
          || continuation.gateType !== 'retry'
          || continuation.resumeKind !== 'agent_slot'
          || continuation.agentRunId !== slot.operationId
          || continuation.agentKind !== slot.agentKind
          || continuation.round !== (orchestration.snapshot?.round || 0)
        ))) return null
    const expectedInput = v4ManualRecoveryGateInput(
      runRecord.runId, orchestration.batchId, slot,
    )
    const expectedRequestFields = Reflect.ownKeys(expectedInput.request)
    const requestFields = request && typeof request === 'object' && !Array.isArray(request)
      ? Reflect.ownKeys(request)
      : []
    if ((!allowContinuation && gate.status !== 'pending')
        || gate.type !== expectedInput.type || gate.runId !== expectedInput.runId
        || gate.agentRunId !== expectedInput.agentRunId
        || gate.agentKind !== expectedInput.agentKind || gate.summary !== expectedInput.summary
        || gate.expiresAt !== undefined || hashValue(gate.options) !== hashValue(expectedInput.options)
        || requestFields.length !== expectedRequestFields.length
        || !requestFields.every(field => expectedRequestFields.includes(field))
        || hashValue(request) !== hashValue(expectedInput.request)) return null
    if (gateInput) {
      const expectedInputFields = Reflect.ownKeys(expectedInput)
      const inputFields = Reflect.ownKeys(gateInput)
      const inputRequestFields = gateInput.request && typeof gateInput.request === 'object'
        && !Array.isArray(gateInput.request) ? Reflect.ownKeys(gateInput.request) : []
      if (inputFields.length !== expectedInputFields.length
          || !inputFields.every(field => expectedInputFields.includes(field))
          || gateInput.type !== expectedInput.type || gateInput.runId !== expectedInput.runId
          || gateInput.agentRunId !== expectedInput.agentRunId
          || gateInput.agentKind !== expectedInput.agentKind
          || gateInput.summary !== expectedInput.summary
          || hashValue(gateInput.options) !== hashValue(expectedInput.options)
          || inputRequestFields.length !== expectedRequestFields.length
          || !inputRequestFields.every(field => expectedRequestFields.includes(field))
          || hashValue(gateInput.request) !== hashValue(expectedInput.request)) return null
    }
    return { gate, request, slot }
  }

  v4ManualTerminalRecovery(runRecord) {
    const continuation = runRecord?.continuation
    if (!['completed', 'failed', 'cancelled'].includes(continuation?.state)) return null
    let gate
    try { gate = this.humanGateStore.get(continuation.gateId) } catch { return null }
    const match = this.v4ManualRecoveryGateMatch(runRecord, gate, null, true)
    if (!match || !gate.decision) return null
    if (continuation.state === 'completed'
        && (gate.status !== 'approved' || gate.decision.optionId !== 'retry-once')) return null
    if (continuation.state === 'cancelled'
        && (gate.status !== 'rejected' || gate.decision.optionId !== 'cancel-retry')) return null
    return { ...match, state: continuation.state }
  }

  v4TaskDecisionSource(durable, gate, request) {
    if (durable?.mode !== 'auto' || durable.orchestration?.version !== 4
        || gate.type !== 'input' || gate.runId !== durable.runId
        || !request || Object.keys(request).length !== 7
        || request.source !== 'task-decision' || request.phase !== 'discussion'
        || request.snapshotHash !== durable.orchestration.snapshotHash) return null
    const sources = durable.agentRuns.filter(attempt => (
      attempt.agentRunId === gate.agentRunId && attempt.kind === gate.agentKind
      && attempt.status === 'completed' && attempt.round === request.round
      && attempt.context?.operationId === request.operationId
      && attempt.context?.snapshotHash === request.snapshotHash
      && attempt.context?.taskDecision?.status === 'needs-human'
      && hashValue(attempt.context.taskDecision) === request.decisionHash
    ))
    if (sources.length !== 1 || request.operationId !== this.autoRunner.v4OperationId(
      durable, gate.agentKind, `discussion:${request.round}`, request.slotId, request.round,
    )) return null
    return sources[0]
  }

  canResumeV4TaskDecision(durable, gate, request) {
    const source = this.v4TaskDecisionSource(durable, gate, request)
    const continuation = durable.continuation
    const cursor = durable.orchestration
    const group = this.state.groups.find(item => item.id === durable.groupId)
    const slot = cursor?.slots.find(item => item.slotId === request?.slotId)
    return Boolean(source && group && gate.options.length === 2
      && gate.options[0].optionId === 'respond' && gate.options[0].kind === 'respond'
      && gate.options[1].optionId === 'cancel' && gate.options[1].kind === 'reject'
      && continuation?.resumeKind === 'v4_task_decision'
      && cursor.phase === 'discussion' && cursor.round === request.round
      && durable.currentRound === request.round && continuation.round === request.round
      && continuation.slotId === request.slotId
      && continuation.operationId === request.operationId
      && continuation.snapshotHash === request.snapshotHash
      && slot?.agentRunId === source.agentRunId && slot.agentKind === source.kind
      && slot.operationId === request.operationId && slot.commitStatus === 'committed'
      && this.autoRunner.v4NaturalOwner(group, durable, durable.threadRootId) === source.kind)
  }

  v4TaskDecisionResponses(runId) {
    const durable = this.runLedger?.get?.(runId)
    if (!durable) return []
    return this.humanGateStore.list({ runId }).flatMap(item => {
      if (item.type !== 'input' || item.status !== 'approved') return []
      try {
        const gate = this.humanGateStore.get(item.gateId)
        const request = this.humanGateStore.request(item.gateId)
        const source = this.v4TaskDecisionSource(durable, gate, request)
        return source && gate.decision?.response ? [{
          id: gate.gateId, round: source.round, agentKind: 'human',
          text: gate.decision.response,
        }] : []
      } catch { return [] }
    })
  }

  async requestV4TaskDecision(group, controller, message) {
    const durable = this.runLedger?.get?.(controller.runId)
    if (!durable) return null
    const source = durable.agentRuns.find(attempt => (
      attempt.agentRunId === message.trace?.agentRunId && attempt.kind === message.agentKind
    ))
    const slot = durable.orchestration?.slots.find(item => item.agentRunId === source?.agentRunId)
    if (!source || !slot || source.context?.taskDecision?.status !== 'needs-human'
        || slot.commitStatus !== 'committed') throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
    const request = {
      source: 'task-decision', phase: 'discussion', round: source.round,
      slotId: slot.slotId, operationId: slot.operationId,
      snapshotHash: durable.orchestration.snapshotHash,
      decisionHash: hashValue(source.context.taskDecision),
    }
    const decision = await this.requestHumanGate({
      type: 'input', runId: durable.runId, agentRunId: source.agentRunId, agentKind: source.kind,
      createdAt: new Date(slot.finishedAt).toISOString(),
      summary: source.context.taskDecision.reason,
      options: [
        { optionId: 'respond', name: 'Respond', kind: 'respond' },
        { optionId: 'cancel', name: 'Cancel', kind: 'reject' },
      ],
      request,
    }, {
      signal: controller.signal,
      preserveOnAbort: () => controller.stopReason === 'shutdown',
      continuation: {
        resumeKind: 'v4_task_decision', agentRunId: source.agentRunId, agentKind: source.kind,
        round: source.round, phase: 'discussion', slotId: slot.slotId,
        operationId: slot.operationId, snapshotHash: durable.orchestration.snapshotHash,
      },
    })
    if (this.completeHumanGateContinuation(durable.runId, decision.gateId,
      decision.status === 'approved' ? 'completed' : 'cancelled') !== true) {
      throw new Error('LOCAL_RUN_PERSIST_FAILED')
    }
    return decision
  }

  async requestHumanGate(input, options = {}) {
    const runId = String(input?.runId || '')
    const previous = this.humanGateWaitTails.get(runId) || Promise.resolve()
    let release
    const current = new Promise((resolve) => { release = resolve })
    this.humanGateWaitTails.set(runId, current)
    let gateId = ''
    try {
      await previous
      if (options.signal?.aborted) throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
      let waitInput = input
      try {
        const durable = this.runLedger?.get?.(runId)
        const terminalRecovery = this.v4SynthesisTerminalRecovery(durable, input)
        if (terminalRecovery?.state === 'completed') {
          return {
            ...terminalRecovery.gate.decision,
            gateId: terminalRecovery.gate.gateId,
          }
        }
        const matches = this.humanGateStore.list({ runId, pendingOnly: true })
          .map(gate => this.v4SynthesisRecoveryGateMatch(durable, gate, input)
            || this.v4ManualRecoveryGateMatch(durable, gate, input))
          .filter(Boolean)
        if (matches.length === 1) {
          waitInput = { ...input, createdAt: matches[0].gate.createdAt }
        }
      } catch { /* A non-matching durable Gate follows the normal fail-closed path. */ }
      const decision = await this.humanGateCoordinator.wait(waitInput, {
        ...options,
        onCreated: record => { gateId = record.gateId },
      })
      return { ...decision, gateId }
    } finally {
      release()
      if (this.humanGateWaitTails.get(runId) === current) {
        this.humanGateWaitTails.delete(runId)
      }
    }
  }

  listHumanGates(options = {}) {
    return this.humanGateCoordinator.list(options)
  }

  decideHumanGate(gateId, decision) {
    return this.humanGateCoordinator.decide(gateId, decision)
  }

  canResumeHumanGateRecord(runRecord, gateRecord = null) {
    const continuation = runRecord?.continuation
    if (!continuation) {
      return Boolean(gateRecord && (
        this.v4SynthesisRecoveryGateMatch(runRecord, gateRecord)
        || this.v4ManualRecoveryGateMatch(runRecord, gateRecord)
      ))
    }
    if (continuation.gateId !== gateRecord?.gateId && gateRecord) return false
    if (!['pending', 'ready', 'resuming'].includes(continuation.state)) return false
    let gate = gateRecord
    try { gate ||= this.humanGateStore.get(continuation.gateId) } catch { return false }
    if (gate.runId !== runRecord.runId || gate.type !== continuation.gateType
        || gate.agentRunId !== continuation.agentRunId
        || gate.agentKind !== continuation.agentKind) return false
    if (runRecord.orchestration?.version === 4) {
      const agentRuns = Array.isArray(runRecord.agentRuns) ? runRecord.agentRuns : []
      const privateV4Gate = ['v4_human_gate', 'v4_synthesis_recovery']
        .includes(continuation.resumeKind)
        || (continuation.resumeKind === 'agent_slot'
          && continuation.operationId === gate.agentRunId
          && continuation.operationId === continuation.agentRunId)
      if (privateV4Gate) {
        const publicAgentRunId = continuation.publicAgentRunId
        const publicAttempts = agentRuns.filter(agentRun => (
          agentRun?.agentRunId === publicAgentRunId
            && agentRun?.kind === continuation.agentKind
        ))
        const publicSlots = runRecord.orchestration.slots.filter(slot => (
          slot.agentKind === continuation.agentKind
            && slot.agentRunId === publicAgentRunId
            && (continuation.resumeKind !== 'agent_slot'
              || (slot.slotId === continuation.slotId
                && slot.operationId === continuation.operationId))
        ))
        if (!publicAgentRunId || publicAttempts.length !== 1 || publicSlots.length !== 1) {
          return false
        }
      } else {
        const directAttempts = agentRuns.filter(agentRun => (
          agentRun?.agentRunId === gate.agentRunId && agentRun?.kind === gate.agentKind
        ))
        const directSlots = continuation.resumeKind === 'agent_slot'
          ? runRecord.orchestration.slots.filter(slot => (
              slot.slotId === continuation.slotId
                && slot.agentKind === continuation.agentKind
                && slot.agentRunId === gate.agentRunId
            ))
          : []
        if (directAttempts.length !== 1
            || (continuation.resumeKind === 'agent_slot' && directSlots.length !== 1)) {
          return false
        }
      }
    }
    if (continuation.state !== 'pending' && gate.status === 'pending') return false
    try {
      const request = this.humanGateStore.request(gate.gateId)
      if (continuation.resumeKind === 'v4_task_decision') {
        const pack = this.contextPackStore.get(runRecord.contextPackId)
        return pack.taskId === runRecord.taskId
          && this.canResumeV4TaskDecision(runRecord, gate, request)
      }
      const connectorBound = gate.type === 'input' || request?.source === 'connector'
      if (connectorBound && (
        continuation.requestId !== request.requestId
        || continuation.requestHash !== gate.requestHash
        || continuation.sessionRefHash !== request.sessionRefHash
        || continuation.sessionProvenanceHash !== request.sessionProvenanceHash
      )) return false
      const nativePermission = gate.type === 'permission' && request?.source !== 'connector'
      if (nativePermission) {
        const group = this.state.groups.find(candidate => candidate.id === runRecord.groupId)
        if (!group) return false
        const resolved = this.sessionState(
          group, continuation.agentKind, runRecord.threadRootId, runRecord.taskId,
        )
        const provenance = {
          scope: String(resolved.provenance?.scope || 'none'),
          originTaskId: String(resolved.provenance?.originTaskId || ''),
          inheritedTaskIds: Array.isArray(resolved.provenance?.inheritedTaskIds)
            ? [...resolved.provenance.inheritedTaskIds]
            : [],
          completeness: String(resolved.provenance?.completeness || 'complete'),
        }
        const sessionRefHash = createHash('sha256')
          .update(String(resolved.sessionRef || '')).digest('hex')
        const sessionProvenanceHash = hashValue(provenance)
        const requestId = hashValue({
          requestHash: gate.requestHash,
          sessionRefHash: continuation.sessionRefHash,
          sessionProvenanceHash: continuation.sessionProvenanceHash,
        })
        if (continuation.requestId !== requestId
            || continuation.requestHash !== gate.requestHash
            || continuation.sessionProvenanceHash !== sessionProvenanceHash
            || (resolved.sessionRef && continuation.sessionRefHash !== sessionRefHash)) return false
      }
      const pack = this.contextPackStore.get(runRecord.contextPackId)
      return pack.taskId === runRecord.taskId
        && this.state.groups.some(group => group.id === runRecord.groupId)
        && Boolean(request)
    } catch {
      return false
    }
  }

  canResumeHumanGate(gateRecord) {
    const runRecord = this.runLedger?.get?.(gateRecord?.runId)
    return this.canResumeHumanGateRecord(runRecord, gateRecord)
  }

  completeHumanGateContinuation(runId, gateId, state = 'completed') {
    const match = this.controllerForRunId(runId)
    if (!match) return false
    const [groupId, controller] = match
    if (controller.continuation?.gateId !== gateId) return false
    controller.waitingGateIds.delete(gateId)
    controller.continuation = {
      ...controller.continuation,
      state: ['completed', 'failed', 'cancelled'].includes(state) ? state : 'completed',
      updatedAt: this.continuationTimestamp(),
    }
    return this.checkpointRun(groupId, controller) === true || !this.runLedger
  }

  canFinalizeReplayedAgentSlot(durable) {
    const continuation = durable?.continuation
    const targetKinds = Array.isArray(durable?.targetKinds) ? durable.targetKinds : []
    if (durable?.mode !== 'manual' || continuation?.resumeKind !== 'agent_slot'
        || targetKinds.length !== 1 || targetKinds[0] !== continuation.agentKind) return false
    return !durable.threadRootId || durable.taskId === durable.threadRootId
  }

  canResumeOrchestration(durable, workflow) {
    const cursor = durable?.orchestration
    const continuation = durable?.continuation
    if (workflow === 'auto' && continuation?.resumeKind === 'v4_synthesis_recovery') {
      const recovery = cursor?.synthesisRecovery
      const binding = recovery?.pendingGate
      const continuedAttempt = recovery?.attempts?.find(candidate => (
        candidate.operationId === binding?.operationId
      ))
      const appliedAttempt = recovery?.attempts?.find(candidate => (
        candidate.operationId === continuation.agentRunId
      ))
      const activeAttempt = recovery?.attempts?.find(candidate => (
        ['intent', 'leased', 'unknown_outcome'].includes(candidate.status)
      ))
      const waitingForDecision = cursor?.phase === 'human-gate'
        && binding?.writerKind === continuation.agentKind
        && binding?.operationId === continuation.agentRunId
        && binding?.round === continuation.round
        && binding?.stateEpoch === continuation.stateEpoch
        && continuedAttempt?.status === 'unknown_outcome'
      const approvedActionApplied = cursor?.phase === 'synthesis'
        && !binding
        && appliedAttempt?.status === 'superseded'
        && activeAttempt?.status === 'intent'
        && activeAttempt.operationId !== continuation.agentRunId
      const rejectedActionApplied = cursor?.phase === 'human-gate'
        && binding?.writerKind === continuation.agentKind
        && binding?.operationId === continuation.agentRunId
        && binding?.round === continuation.round
        && binding?.stateEpoch === continuation.stateEpoch
        && continuedAttempt?.status === 'cancelled'
        && continuedAttempt.sideEffectsPossible === true
        && continuedAttempt.outcomeCertainty === 'unknown_outcome'
      return durable?.mode === 'auto'
        && cursor?.version === 4
        && cursor.workflow === 'auto'
        && cursor.template === 'discussion'
        && (waitingForDecision || approvedActionApplied || rejectedActionApplied)
    }
    if (workflow === 'auto' && continuation?.resumeKind === 'v4_human_gate') {
      return durable?.mode === 'auto'
        && cursor?.version === 4
        && cursor.workflow === 'auto'
        && cursor.template === 'discussion'
        && cursor.phase === 'human-gate'
        && Array.isArray(cursor.activeKinds)
        && cursor.activeKinds.length > 0
        && cursor.activeKinds.every(kind => (
          Array.isArray(durable.targetKinds) && durable.targetKinds.includes(kind)
        ))
    }
    const supportedCursor = workflow === 'auto'
      ? [1, 2, 3].includes(cursor?.version)
      : cursor?.version === 1
    if (durable?.mode !== workflow || !supportedCursor || cursor.workflow !== workflow
        || cursor.currentKind !== continuation?.agentKind
        || !cursor.activeKinds.includes(cursor.currentKind)) return false
    const targetKinds = Array.isArray(durable.targetKinds) ? durable.targetKinds : []
    if (workflow === 'auto' && (
      durable.currentRound < 1 || continuation?.round !== durable.currentRound
    )) return false
    if (workflow === 'manual' && continuation?.round !== 0) return false
    return cursor.activeKinds.length > 0
      && cursor.activeKinds.every(kind => targetKinds.includes(kind))
      && cursor.pendingKinds.every(kind => cursor.activeKinds.includes(kind))
      && !cursor.pendingKinds.includes(cursor.currentKind)
      && !cursor.successfulKinds.includes(cursor.currentKind)
      && cursor.successfulKinds.every(kind => cursor.activeKinds.includes(kind))
      && cursor.pendingKinds.every(kind => !cursor.successfulKinds.includes(kind))
      && cursor.agreementKinds.every(kind => cursor.successfulKinds.includes(kind))
  }

  canResumeManualOrchestration(durable) {
    return this.canResumeOrchestration(durable, 'manual')
  }

  canResumeV4ManualAgentSlot(durable, gate) {
    const cursor = durable?.orchestration
    const continuation = durable?.continuation
    const phase = cursor?.phase
    if (durable?.mode !== 'manual' || continuation?.resumeKind !== 'agent_slot'
        || cursor?.version !== 4 || cursor.workflow !== 'manual'
        || cursor.template !== 'concurrent-batch'
        || phase !== 'proposal' || continuation.phase !== phase
        || !['budget', 'permission', 'retry', 'input'].includes(gate?.type)
        || gate.runId !== durable.runId || gate.agentRunId !== continuation.agentRunId
        || gate.agentKind !== continuation.agentKind
        || continuation.snapshotHash !== cursor.snapshotHash
        || continuation.round !== (cursor.snapshot?.round || 0)) {
      return false
    }
    const expectedBatchId = `batch-${createHash('sha256').update(JSON.stringify([
      durable.runId,
      durable.taskId,
      phase,
      continuation.round,
    ])).digest('hex').slice(0, 32)}`
    const matches = cursor.slots.filter(slot => slot.agentKind === continuation.agentKind)
    if (matches.length !== 1 || cursor.batchId !== expectedBatchId
        || !cursor.snapshot || hashValue(cursor.snapshot) !== cursor.snapshotHash
        || cursor.plan?.snapshotHash !== cursor.snapshotHash) return false
    const slot = matches[0]
    const slotIndex = durable.targetKinds.indexOf(continuation.agentKind)
    const expectedSlotId = `slot-${slotIndex + 1}-${continuation.agentKind}`
    const expectedOperationId = `agent-operation-${createHash('sha256').update(
      `${durable.runId}:${cursor.batchId}:${continuation.agentKind}`,
    ).digest('hex')}`
    const assignments = cursor.plan?.assignments?.filter(item => item.slotId === slot.slotId) || []
    const assignment = assignments[0]
    const manualRecovery = gate.type === 'retry'
      ? this.v4ManualRecoveryGateMatch(durable, gate, null, true)
      : null
    const agentRun = durable.agentRuns?.find(item => (
      item.agentRunId === continuation.agentRunId
      && item.kind === continuation.agentKind
      && item.round === continuation.round
    ))
    return Boolean(
      assignment
      && assignments.length === 1
      && (agentRun || manualRecovery?.slot === slot)
      && slotIndex >= 0
      && slot.slotId === expectedSlotId
      && slot.slotId === continuation.slotId
      && slot.queuePosition === slotIndex
      && slot.operationId === expectedOperationId
      && slot.operationId === continuation.operationId
      && slot.snapshotHash === continuation.snapshotHash
      && assignment.agentKind === slot.agentKind
      && assignment.operationId === slot.operationId
      && JSON.stringify(cursor.snapshot?.targetKinds) === JSON.stringify(durable.targetKinds)
      && cursor.snapshot?.targetKinds?.includes(slot.agentKind)
      && durable.targetKinds?.includes(slot.agentKind)
      && !(slot.resultRefs?.workflowOutcomeRefs || []).some(item => (
        item?.receipt?.phase === phase
          && item.receipt.operationId === continuation.operationId
          && ['completed', 'accepted'].includes(item.receipt.status)
      )),
    )
  }

  canResumeV4AutoAgentSlot(durable, gate, controller) {
    const cursor = durable?.orchestration
    const continuation = durable?.continuation
    const phase = cursor?.phase
    if (durable?.mode !== 'auto' || continuation?.resumeKind !== 'agent_slot'
        || cursor?.version !== 4 || cursor.workflow !== 'auto'
        || cursor.template !== 'discussion'
        || !['proposal', 'discussion', 'challenge', 'work', 'synthesis', 'verification'].includes(phase)
        || !['budget', 'permission', 'retry', 'input'].includes(gate?.type)
        || gate.runId !== durable.runId || gate.agentRunId !== continuation.agentRunId
        || gate.agentKind !== continuation.agentKind
        || continuation.phase !== phase
        || continuation.snapshotHash !== cursor.snapshotHash
        || continuation.round !== cursor.round
        || continuation.round !== durable.currentRound
        || !controller) return false
    const targetKinds = Array.isArray(durable.targetKinds) ? durable.targetKinds : []
    const matches = cursor.slots.filter(slot => slot.agentKind === continuation.agentKind)
    if (matches.length !== 1 || !cursor.snapshotHash || !cursor.snapshot
        || cursor.slots.length !== targetKinds.length
        || hashValue(cursor.snapshot) !== cursor.snapshotHash
        || JSON.stringify(cursor.snapshot.targetKinds) !== JSON.stringify(targetKinds)) return false
    const slot = matches[0]
    const slotIndex = targetKinds.indexOf(slot.agentKind)
    const agentRun = durable.agentRuns?.find(item => (
      item.agentRunId === continuation.agentRunId
        && item.kind === slot.agentKind && item.round === continuation.round
    ))
    if (slotIndex < 0 || !agentRun || slot.slotId !== continuation.slotId
        || slot.operationId !== continuation.operationId
        || slot.slotId !== `slot-${slotIndex + 1}-${slot.agentKind}`
        || slot.queuePosition !== slotIndex || slot.phase !== phase
        || slot.snapshotHash !== continuation.snapshotHash
        || !['planned', 'queued', 'running', 'waiting', 'stopped', 'failed'].includes(slot.status)) {
      return false
    }
    const assignments = cursor.plan?.assignments?.filter(item => item.slotId === slot.slotId) || []
    if (assignments.length !== 1 || assignments[0].agentKind !== slot.agentKind
        || assignments[0].operationId !== slot.operationId
        || (slot.resultRefs?.workflowOutcomeRefs || []).some(item => (
          item?.receipt?.phase === phase && item.receipt.operationId === slot.operationId
        ))) return false
    let operationPhase = phase === 'discussion' ? `discussion:${cursor.round}` : phase
    if (phase === 'work') {
      const matchingAssignments = cursor.coordinationPlan?.assignments?.filter(item => (
        item.ownerKind === slot.agentKind && item.taskId
          && this.autoRunner.v4OperationId(
            controller, slot.agentKind, `work:${item.taskId}`, slot.slotId,
          ) === slot.operationId
      )) || []
      if (matchingAssignments.length !== 1) return false
      const assignment = matchingAssignments[0]
      let workState
      try {
        workState = this.autoRunner.v4WorkState(
          cursor.workReceipts || [], cursor.coordinationPlan,
        )
      } catch {
        return false
      }
      const pending = workState.pending.filter(item => (
        item.taskId === assignment.taskId && item.ownerKind === assignment.ownerKind
      ))
      const ready = workState.ready.filter(item => (
        item.taskId === assignment.taskId && item.ownerKind === assignment.ownerKind
      ))
      if (pending.length !== 1 || ready.length !== 1) return false
      operationPhase = `work:${assignment.taskId}`
    }
    if (phase === 'synthesis') {
      const attempt = cursor.synthesisRecovery?.attempts?.find(item => (
        ['intent', 'leased', 'unknown_outcome'].includes(item.status)
      ))
      return Boolean(
        attempt && attempt.writerKind === slot.agentKind && attempt.slotId === slot.slotId
          && attempt.operationId === slot.operationId,
      )
    }
    return slot.operationId === this.autoRunner.v4OperationId(
      controller, slot.agentKind, operationPhase, slot.slotId,
      ...(phase === 'discussion' ? [cursor.round] : []),
    )
  }

  canResumeAutoOrchestration(durable) {
    return this.canResumeOrchestration(durable, 'auto')
  }

  async replayAgentSlot(group, durable, controller, gate, decision, request) {
    if (!['budget', 'permission', 'retry', 'input'].includes(gate?.type)) {
      throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
    }
    const message = this.state.messages.find(candidate => (
      candidate.groupId === group.id
      && candidate.role === 'user'
      && [durable.taskId, durable.threadRootId].includes(candidate.id)
    ))
    if (!message) throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
    const attachments = await this.resolveAttachments(message.attachments || [])
    const skills = await this.validateSkillSelectionsFn(
      durable.continuation.agentKind,
      (message.skillHints || []).filter(skill => (
        skill.targetKind === durable.continuation.agentKind
      )),
    )
    const knowledge = await this.validateKnowledgeBaseSelectionsFn(
      [durable.continuation.agentKind], message.knowledgeBaseHints || [],
    )
    const activeKinds = controller.orchestration?.activeKinds || durable.targetKinds
    const recovered = await this.autoRunner.invokeWithUnauthorizedRecovery({
      group,
      kind: durable.continuation.agentKind,
      controller,
      activeKinds,
      threadRootId: durable.threadRootId,
      context: {
        attachments: attachments.map(attachment => attachment.path),
        attachmentSnapshots: attachments,
        skillHints: skills,
        knowledgeBaseHints: knowledge,
        resumedGate: {
          gateId: gate.gateId,
          type: gate.type,
          agentRunId: gate.agentRunId,
          status: decision.status,
          optionId: decision.optionId,
          ...(['permission', 'input'].includes(gate.type) ? {
            request,
            requestHash: gate.requestHash,
            requestId: durable.continuation.requestId,
            sessionRefHash: durable.continuation.sessionRefHash,
            sessionProvenanceHash: durable.continuation.sessionProvenanceHash,
          } : {}),
          ...(gate.type === 'input' ? { response: decision.response } : {}),
          used: false,
        },
        runtimeInstruction: gate.type === 'permission'
          ? [
              'Resume the existing Agent Session at its pending permission request.',
              'Do not repeat actions completed before that request.',
              'Continue only after the Harness applies the persisted decision to the exact reissued request.',
            ].join(' ')
          : (gate.type === 'input'
              ? 'Resume the exact pending Connector input request with the persisted user response.'
              : (gate.type === 'retry'
              ? [
                  'The user explicitly approved one replay after an earlier attempt had an uncertain outcome.',
                  'Reuse the durable operation identity supplied by the Harness.',
                ].join(' ')
              : '')),
      },
      reportedFailures: new Set(),
      mode: durable.mode,
    })
    if (!recovered?.result) throw recovered?.error || new Error('LOCAL_RUN_CONTINUATION_FAILED')
    if (!controller.completedKinds.includes(durable.continuation.agentKind)) {
      controller.completedKinds.push(durable.continuation.agentKind)
    }
    return recovered.result
  }

  async continueManualOrchestration(group, durable, controller) {
    const cursor = controller.orchestration
    const message = this.state.messages.find(candidate => (
      candidate.groupId === group.id
      && candidate.role === 'user'
      && [durable.taskId, durable.threadRootId].includes(candidate.id)
    ))
    if (!message || cursor?.version !== 1 || cursor.workflow !== 'manual'
        || cursor.currentKind || cursor.pendingKinds.some(kind => !cursor.activeKinds.includes(kind))) {
      throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
    }
    const attachments = await this.resolveAttachments(message.attachments || [])
    const activeKinds = [...cursor.activeKinds]
    const successfulKinds = new Set(cursor.successfulKinds)
    const pendingKinds = [...cursor.pendingKinds]
    const reportedFailures = new Set()

    while (pendingKinds.length) {
      const kind = pendingKinds.shift()
      if (!activeKinds.includes(kind) || controller.signal.aborted) continue
      controller.currentKind = kind
      controller.progress = []
      controller.orchestration = {
        ...controller.orchestration,
        currentKind: kind,
        pendingKinds: [...pendingKinds],
        successfulKinds: [...successfulKinds],
      }
      if (this.checkpointRun(group.id, controller) !== true) {
        throw new Error('LOCAL_RUN_PERSIST_FAILED')
      }
      this.emitChanged()
      try {
        const skills = await this.validateSkillSelectionsFn(
          kind,
          (message.skillHints || []).filter(skill => skill.targetKind === kind),
        )
        const knowledge = await this.validateKnowledgeBaseSelectionsFn(
          [kind],
          (message.knowledgeBaseHints || []).filter(source => source.targetKinds?.includes(kind))
            .map(source => ({ ...source, targetKinds: [kind] })),
        )
        const invocation = await this.autoRunner.invokeWithUnauthorizedRecovery({
          group,
          kind,
          controller,
          activeKinds,
          threadRootId: durable.threadRootId,
          context: {
            attachments: attachments.map(attachment => attachment.path),
            attachmentSnapshots: attachments,
            skillHints: skills,
            knowledgeBaseHints: knowledge,
            contextOptions: { focusUserMessageId: message.id },
          },
          reportedFailures,
          mode: 'manual',
        })
        if (!invocation?.result) throw invocation?.error || new Error('LOCAL_AGENT_UNKNOWN_FAILURE')
        successfulKinds.add(kind)
      } catch (error) {
        if (error?.code === 'LOCAL_RUN_CIRCUIT_BREAKER'
            || error?.message === 'LOCAL_RUN_CIRCUIT_BREAKER') {
          controller.stopReason = 'circuit_breaker'
          controller.abort()
          this.addMessage(
            group.id,
            'system',
            `Run stopped after ${MAX_RUN_AGENT_ATTEMPTS} Agent attempts.`,
            '',
            durable.threadRootId,
            {
              key: 'system.runCircuitBreaker',
              params: { maxAttempts: MAX_RUN_AGENT_ATTEMPTS },
            },
          )
          break
        }
        if (error?.code === 'LOCAL_BUDGET_EXHAUSTED'
            || error?.message === 'LOCAL_BUDGET_EXHAUSTED') {
          this.recordAgentFailure(
            group.id, kind, error, durable.threadRootId, reportedFailures,
          )
          if (!controller.failedKinds.includes(kind)) controller.failedKinds.push(kind)
          if (!controller.completedKinds.includes(kind)) controller.completedKinds.push(kind)
          successfulKinds.delete(kind)
          controller.stopReason = 'hard_budget'
          controller.abort()
          break
        }
        if (controller.signal.aborted) {
          this.recordAgentInterruption(
            group.id,
            kind,
            error,
            durable.threadRootId,
            controller.stopReason === 'shutdown' ? 'interrupted' : 'stopped',
            reportedFailures,
          )
          if (!controller.completedKinds.includes(kind)) controller.completedKinds.push(kind)
          break
        }
        this.recordAgentFailure(group.id, kind, error, durable.threadRootId, reportedFailures)
        if (!controller.failedKinds.includes(kind)) controller.failedKinds.push(kind)
        successfulKinds.delete(kind)
      }
      if (!controller.completedKinds.includes(kind)) controller.completedKinds.push(kind)
      controller.currentKind = ''
      controller.progress = []
      controller.orchestration = {
        ...controller.orchestration,
        currentKind: '',
        pendingKinds: [...pendingKinds],
        successfulKinds: [...successfulKinds],
      }
      if (this.checkpointRun(group.id, controller) !== true) {
        throw new Error('LOCAL_RUN_PERSIST_FAILED')
      }
      this.emitChanged()
    }

    if (controller.signal.aborted) {
      return terminalRunStatusForReason(controller.stopReason)
    }
    const successCount = activeKinds.filter(kind => successfulKinds.has(kind)).length
    if (!successCount) return 'failed'
    return successCount === activeKinds.length ? 'completed' : 'partial'
  }

  async resumeHumanGateDecision(gate, decision) {
    const durable = this.runLedger?.get?.(gate.runId)
    if (!this.canResumeHumanGateRecord(durable, gate)) {
      return this.failHumanGateContinuation(gate, new Error('LOCAL_RUN_CONTINUATION_INVALID'))
    }
    let controller = null
    try {
      controller = this.runCoordinator.resume(durable)
      const group = this.getGroup(durable.groupId)
      if (durable.continuation.resumeKind === 'v4_task_decision') {
        const finalStatus = await this.autoRunner.resume(group, durable, controller)
        await this.finishRun(durable.groupId, controller, finalStatus)
        return
      }
      const resumableManual = this.canResumeManualOrchestration(durable)
      const resumableAuto = this.canResumeAutoOrchestration(durable)
      const resumableV4ManualSlot = this.canResumeV4ManualAgentSlot(durable, gate)
      const resumableV4AutoSlot = this.canResumeV4AutoAgentSlot(durable, gate, controller)
      const resumableTaskGraphDecision = durable.continuation.resumeKind === 'role_review_decision'
        && durable.mode === 'auto'
        && durable.orchestration?.version === 3
        && durable.orchestration?.template === 'task-graph'
      if (durable.continuation.resumeKind === 'agent_slot'
          && decision.status === 'approved'
          && !this.canFinalizeReplayedAgentSlot(durable)
          && !resumableManual
          && !resumableAuto
          && !resumableV4ManualSlot
          && !resumableV4AutoSlot) {
        throw new Error('LOCAL_RUN_ORCHESTRATION_RESUME_UNAVAILABLE')
      }
      if (durable.continuation.resumeKind === 'role_review_decision'
          && !resumableTaskGraphDecision) {
        throw new Error('LOCAL_WORKFLOW_UNSUPPORTED')
      }
      if (resumableTaskGraphDecision) {
        const finalStatus = await this.autoRunner.resumeDecision(
          group, durable, controller, decision,
        )
        await this.finishRun(durable.groupId, controller, finalStatus)
        return
      }
      if (durable.continuation.resumeKind === 'v4_synthesis_recovery') {
        if (!resumableAuto) throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
        const request = this.humanGateStore.request(gate.gateId)
        const recovery = durable.orchestration.synthesisRecovery
        const requestBinding = request && typeof request === 'object' ? {
          bindingHash: request.bindingHash,
          writerKind: request.writerKind,
          slotId: request.slotId,
          operationId: request.operationId,
          attempt: request.attempt,
          proposedReplacementKind: request.proposedReplacementKind,
          round: request.round,
          stateEpoch: request.stateEpoch,
          rankingFingerprint: recovery.rankingFingerprint,
        } : null
        const binding = recovery.pendingGate || requestBinding
        const requestFields = request && typeof request === 'object' && !Array.isArray(request)
          ? Reflect.ownKeys(request)
          : []
        const bindingFields = binding ? {
          writerKind: binding.writerKind,
          slotId: binding.slotId,
          operationId: binding.operationId,
          attempt: binding.attempt,
          proposedReplacementKind: binding.proposedReplacementKind,
          round: binding.round,
          stateEpoch: binding.stateEpoch,
          rankingFingerprint: binding.rankingFingerprint,
        } : null
        const validRequest = requestFields.length === 10
          && requestFields.every(field => typeof field === 'string' && [
            'phase', 'bindingHash', 'writerKind', 'slotId', 'operationId', 'attempt',
            'proposedReplacementKind', 'round', 'stateEpoch', 'outcomeCertainty',
          ].includes(field))
          && request.phase === 'synthesis-recovery'
          && request.outcomeCertainty === 'unknown_outcome'
          && request.bindingHash === binding.bindingHash
          && request.writerKind === binding.writerKind
          && request.slotId === binding.slotId
          && request.operationId === binding.operationId
          && request.attempt === binding.attempt
          && request.proposedReplacementKind === binding.proposedReplacementKind
          && request.round === binding.round
          && request.stateEpoch === binding.stateEpoch
          && request.bindingHash === hashValue(bindingFields)
        const approvedOption = decision.status === 'approved'
          && ['retry-original-writer', 'replace-next-writer'].includes(decision.optionId)
        const stoppedOption = decision.status === 'rejected'
          && decision.optionId === 'stop-discussion'
        if (gate.type !== 'decision' || !validRequest || (!approvedOption && !stoppedOption)
            || gate.agentKind !== binding.writerKind
            || gate.agentRunId !== binding.operationId
            || durable.continuation.agentKind !== binding.writerKind
            || durable.continuation.agentRunId !== binding.operationId
            || durable.continuation.round !== binding.round
            || durable.continuation.stateEpoch !== binding.stateEpoch) {
          throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
        }
        if (stoppedOption) {
          controller.orchestration = {
            ...controller.orchestration,
            synthesisRecovery: this.autoRunner.v4CancelSynthesisRecovery(recovery),
            currentKind: '',
            currentKinds: [],
            pendingKinds: [],
          }
          if (this.checkpointRun(durable.groupId, controller) !== true && this.runLedger) {
            throw new Error('LOCAL_RUN_PERSIST_FAILED')
          }
          this.completeHumanGateContinuation(durable.runId, gate.gateId, 'cancelled')
          await this.finishRun(durable.groupId, controller, 'stopped')
          return
        }
        const writerKind = decision.optionId === 'replace-next-writer'
          ? binding.proposedReplacementKind
          : binding.writerKind
        if (!writerKind) throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
        if (controller.continuation?.gateId === gate.gateId
            && ['pending', 'ready', 'resuming'].includes(controller.continuation.state)
            && !this.completeHumanGateContinuation(durable.runId, gate.gateId, 'completed')) {
          throw new Error('LOCAL_RUN_PERSIST_FAILED')
        }
        const appliedAttempt = recovery.attempts.find(attempt => (
          attempt.operationId === binding.operationId
        ))
        const activeAttempt = this.autoRunner.v4ActiveSynthesisAttempt(recovery)
        const approvedActionApplied = !recovery.pendingGate
          && durable.orchestration.phase === 'synthesis'
          && appliedAttempt?.status === 'superseded'
          && activeAttempt?.status === 'intent'
          && activeAttempt.writerKind === writerKind
        const nextRecovery = approvedActionApplied
          ? recovery
          : this.autoRunner.v4AppendSynthesisAttempt(
              controller,
              durable.orchestration.coordinationPlan || durable.orchestration.synthesisBinding,
              recovery,
              durable.orchestration.slots,
              writerKind,
            )
        const nextAttempt = this.autoRunner.v4ActiveSynthesisAttempt(nextRecovery)
        const nextSlots = durable.orchestration.slots.map((slot) => {
          if (slot.agentKind !== writerKind) return { ...slot, permission: 'read-only' }
          if (approvedActionApplied) return { ...slot, permission: 'workspace-write' }
          const { agentRunId: _agentRunId, ...retainedSlot } = slot
          return {
            ...retainedSlot,
            phase: 'synthesis',
            status: 'planned',
            operationId: nextAttempt.operationId,
            receiptId: '',
            resultHash: '',
            finishedAt: null,
            commitStatus: 'pending',
            permission: 'workspace-write',
          }
        })
        controller.currentKind = writerKind
        controller.v4Watermarks = durable.orchestration.deliveryWatermarks.map(item => ({
          ...item,
        }))
        if (!approvedActionApplied) {
          this.autoRunner.v4CheckpointPhase(group, controller, {
            targetKinds: durable.targetKinds,
            phase: 'synthesis',
            batchId: durable.orchestration.batchId,
            snapshotRecord: durable.orchestration.snapshot,
            snapshotHash: durable.orchestration.snapshotHash,
            slots: nextSlots,
            writerKind,
            currentKinds: [writerKind],
            pendingKinds: [writerKind],
            receipts: this.autoRunner.v4RestoreReceipts(controller),
            challengeBindings: durable.orchestration.challengeBindings,
            synthesisBinding: durable.orchestration.synthesisBinding,
            synthesisRecovery: nextRecovery,
            convergence: durable.orchestration.convergence || null,
            coordinationPlan: durable.orchestration.coordinationPlan,
            workReceipts: durable.orchestration.workReceipts,
          })
        }
        const finalStatus = await this.autoRunner.resume(group, durable, controller)
        await this.finishRun(durable.groupId, controller, finalStatus)
        return
      }
      if (durable.continuation.resumeKind === 'v4_human_gate') {
        if (decision.status !== 'approved') {
          this.completeHumanGateContinuation(durable.runId, gate.gateId, 'cancelled')
          await this.finishRun(durable.groupId, controller, 'stopped')
          return
        }
        const request = this.humanGateStore.request(gate.gateId)
        const requestFields = request && typeof request === 'object' && !Array.isArray(request)
          ? Reflect.ownKeys(request)
          : []
        const unresolvedIssueIds = request?.unresolvedIssueIds
        const writerKind = durable.orchestration?.commitState?.writerKind
        const writerSlot = durable.orchestration?.slots?.find(slot => (
          slot.agentKind === writerKind
        ))
        const expectedAgentRunId = writerSlot
          ? this.autoRunner.v4OperationId(
              controller, writerKind, 'human-gate', writerSlot.slotId,
            )
          : ''
        const convergence = durable.orchestration?.convergence
        const validRequest = requestFields.length === 5
          && requestFields.every(field => typeof field === 'string'
            && ['phase', 'round', 'candidateHash', 'unresolvedIssueIds', 'stateEpoch'].includes(field))
          && request.phase === 'discussion'
          && Number.isSafeInteger(request.round)
          && request.round >= 1
          && /^[a-f0-9]{64}$/.test(String(request.candidateHash || ''))
          && Array.isArray(unresolvedIssueIds)
          && unresolvedIssueIds.length <= 32
          && unresolvedIssueIds.every(issueId => (
            typeof issueId === 'string'
            && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(issueId)
          ))
          && new Set(unresolvedIssueIds).size === unresolvedIssueIds.length
          && Number.isSafeInteger(request.stateEpoch)
          && request.stateEpoch >= 1
        if (gate.type !== 'decision'
            || decision.optionId !== 'continue-discussion'
            || !validRequest
            || request.round !== durable.continuation.round
            || request.round !== durable.currentRound
            || request.round !== durable.orchestration?.round
            || request.stateEpoch !== durable.continuation.stateEpoch
            || request.stateEpoch !== convergence?.stateEpoch
            || request.candidateHash !== convergence?.candidateContentHash
            || JSON.stringify([...unresolvedIssueIds].sort())
              !== JSON.stringify(convergence?.openIssueIds || [])
            || convergence.acknowledgedGateEpoch === convergence.stateEpoch
            || !writerKind
            || !writerSlot
            || durable.continuation.agentKind !== writerKind
            || gate.agentKind !== writerKind
            || durable.continuation.agentRunId !== expectedAgentRunId
            || gate.agentRunId !== expectedAgentRunId) {
          throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
        }
        const previousWaitingGateIds = new Set(controller.waitingGateIds)
        const previousContinuation = controller.continuation
        const previousCurrentKind = controller.currentKind
        const previousOrchestration = controller.orchestration
        try {
          controller.waitingGateIds.delete(gate.gateId)
          controller.continuation = {
            ...controller.continuation,
            state: 'completed',
            updatedAt: this.continuationTimestamp(),
          }
          controller.currentKind = ''
          controller.orchestration = {
            ...controller.orchestration,
            phase: 'challenge',
            currentKind: '',
            currentKinds: [],
            pendingKinds: [],
            convergence: {
              ...controller.orchestration.convergence,
              acknowledgedGateEpoch: request.stateEpoch,
            },
          }
          if (this.checkpointRun(durable.groupId, controller) !== true && this.runLedger) {
            throw new Error('LOCAL_RUN_PERSIST_FAILED')
          }
        } catch (error) {
          controller.waitingGateIds.clear()
          for (const gateId of previousWaitingGateIds) controller.waitingGateIds.add(gateId)
          controller.continuation = previousContinuation
          controller.currentKind = previousCurrentKind
          controller.orchestration = previousOrchestration
          throw error
        }
        const finalStatus = await this.autoRunner.resume(
          group, durable, controller,
        )
        await this.finishRun(durable.groupId, controller, finalStatus)
        return
      }
      if (resumableV4ManualSlot) {
        if (decision.status !== 'approved') {
          this.completeHumanGateContinuation(durable.runId, gate.gateId, 'cancelled')
          await this.finishRun(durable.groupId, controller, 'stopped')
          return
        }
        const request = this.humanGateStore.request(gate.gateId)
        const result = await this.messageSubmission.resumeV4Manual({
          group,
          durable,
          controller,
          onlyKind: durable.continuation.agentKind,
          resumedGate: {
            gateId: gate.gateId,
            type: gate.type,
            agentRunId: gate.agentRunId,
            agentKind: gate.agentKind,
            status: decision.status,
            optionId: decision.optionId,
            request,
            requestHash: gate.requestHash,
            requestId: durable.continuation.requestId,
            sessionRefHash: durable.continuation.sessionRefHash,
            sessionProvenanceHash: durable.continuation.sessionProvenanceHash,
            ...(gate.type === 'input' ? { response: decision.response } : {}),
            used: false,
          },
        })
        if (controller.continuation?.gateId === gate.gateId
            && !this.completeHumanGateContinuation(durable.runId, gate.gateId, 'completed')) {
          throw new Error('LOCAL_RUN_PERSIST_FAILED')
        }
        await this.finishRun(durable.groupId, controller, result.status)
        return
      }
      if (resumableV4AutoSlot) {
        if (decision.status !== 'approved') {
          this.completeHumanGateContinuation(durable.runId, gate.gateId, 'cancelled')
          await this.finishRun(durable.groupId, controller, 'stopped')
          return
        }
        const resumedGate = {
          gateId: gate.gateId,
          type: gate.type,
          agentRunId: gate.agentRunId,
          agentKind: gate.agentKind,
          status: decision.status,
          optionId: decision.optionId,
          request: this.humanGateStore.request(gate.gateId),
          requestHash: gate.requestHash,
          requestId: durable.continuation.requestId,
          sessionRefHash: durable.continuation.sessionRefHash,
          sessionProvenanceHash: durable.continuation.sessionProvenanceHash,
          phase: durable.continuation.phase,
          slotId: durable.continuation.slotId,
          operationId: durable.continuation.operationId,
          snapshotHash: durable.continuation.snapshotHash,
          round: durable.continuation.round,
          ...(gate.type === 'input' ? { response: decision.response } : {}),
          used: false,
        }
        const finalStatus = await this.autoRunner.resume(
          group, durable, controller, null, resumedGate,
        )
        if (controller.continuation?.gateId === gate.gateId
            && !this.completeHumanGateContinuation(durable.runId, gate.gateId, 'completed')) {
          throw new Error('LOCAL_RUN_PERSIST_FAILED')
        }
        await this.finishRun(durable.groupId, controller, finalStatus)
        return
      }
      const request = this.humanGateStore.request(gate.gateId)
      let replayedResult = null
      if (gate.type === 'permission' || gate.type === 'retry' || gate.type === 'input') {
        if (decision.status === 'rejected') {
          this.resetAgentSession(group, durable.continuation.agentKind, true, durable.taskId)
          if (!controller.completedKinds.includes(durable.continuation.agentKind)) {
            controller.completedKinds.push(durable.continuation.agentKind)
          }
          this.completeHumanGateContinuation(durable.runId, gate.gateId, 'cancelled')
          await this.finishRun(durable.groupId, controller, 'stopped')
          return
        }
        if (gate.type === 'retry' && !this.completeHumanGateContinuation(
          durable.runId, gate.gateId, 'completed',
        )) {
          throw new Error('LOCAL_RUN_PERSIST_FAILED')
        }
        replayedResult = await this.replayAgentSlot(
          group, durable, controller, gate, decision, request,
        )
      } else if (gate.type === 'budget' && decision.status !== 'approved') {
        throw new Error('LOCAL_BUDGET_REJECTED')
      } else {
        replayedResult = await this.replayAgentSlot(
          group, durable, controller, gate, decision, request,
        )
      }
      if (resumableManual || resumableAuto) {
        const successfulKinds = new Set(controller.orchestration.successfulKinds)
        successfulKinds.add(durable.continuation.agentKind)
        controller.currentKind = ''
        controller.orchestration = {
          ...controller.orchestration,
          currentKind: '',
          successfulKinds: [...successfulKinds],
          ...(resumableAuto ? {
            agreementKinds: replayedResult?.consensus
              ? [...new Set([
                  ...controller.orchestration.agreementKinds,
                  durable.continuation.agentKind,
                ])]
              : controller.orchestration.agreementKinds.filter(
                  kind => kind !== durable.continuation.agentKind,
                ),
            attachmentRecipients: [...new Set([
              ...controller.orchestration.attachmentRecipients,
              durable.continuation.agentKind,
            ])],
          } : {}),
        }
      }
      if (controller.continuation?.gateId === gate.gateId
          && !this.completeHumanGateContinuation(durable.runId, gate.gateId, 'completed')) {
        throw new Error('LOCAL_RUN_PERSIST_FAILED')
      }
      const finalStatus = resumableManual
        ? await this.continueManualOrchestration(group, durable, controller)
        : (resumableAuto
            ? await this.autoRunner.resume(group, durable, controller, replayedResult)
            : 'completed')
      await this.finishRun(durable.groupId, controller, finalStatus)
    } catch (error) {
      if (controller) {
        if (error?.code === 'LOCAL_RUN_TERMINAL_PERSIST_FAILED') return
        if (controller.signal.aborted && controller.stopReason === 'shutdown') {
          await this.finishRun(durable.groupId, controller, 'interrupted')
          return
        }
        const circuitBreaker = error?.code === 'LOCAL_RUN_CIRCUIT_BREAKER'
          || error?.message === 'LOCAL_RUN_CIRCUIT_BREAKER'
        const hardBudget = error?.code === 'LOCAL_BUDGET_EXHAUSTED'
          || error?.message === 'LOCAL_BUDGET_EXHAUSTED'
        if (hardBudget) controller.stopReason = 'hard_budget'
        if (circuitBreaker) {
          controller.stopReason = 'circuit_breaker'
          this.addMessage(
            durable.groupId,
            'system',
            `Run stopped after ${MAX_RUN_AGENT_ATTEMPTS} Agent attempts.`,
            '',
            durable.threadRootId,
            {
              key: 'system.runCircuitBreaker',
              params: { maxAttempts: MAX_RUN_AGENT_ATTEMPTS },
            },
          )
        }
        if (durable.continuation.resumeKind === 'agent_slot'
            && decision.status !== 'rejected' && !circuitBreaker) {
          if (!controller.failedKinds.includes(durable.continuation.agentKind)) {
            controller.failedKinds.push(durable.continuation.agentKind)
          }
          this.recordAgentFailure(
            durable.groupId,
            durable.continuation.agentKind,
            error,
            durable.threadRootId,
            new Set(),
          )
          if (!hardBudget) {
            controller.stopReason = String(error?.message || 'human_gate_continuation_failed')
          }
        }
        if (durable.continuation.resumeKind === 'role_review_decision') {
          controller.stopReason = 'LOCAL_WORKFLOW_UNSUPPORTED'
        }
        this.completeHumanGateContinuation(
          durable.runId, gate.gateId,
          decision.status === 'rejected' ? 'cancelled' : 'failed',
        )
        await this.finishRun(
          durable.groupId,
          controller,
          decision.status === 'rejected'
            ? 'stopped'
            : terminalRunStatusForReason(controller.stopReason, 'failed'),
        )
      } else {
        this.failHumanGateContinuation(gate, error)
      }
    }
  }

  failHumanGateContinuation(gate) {
    const gateId = String(gate?.gateId || '')
    const durable = (this.runLedger?.list?.() || []).find(record => (
      record.continuation?.gateId === gateId
        && ['pending', 'ready', 'resuming'].includes(record.continuation.state)
    ))
    if (!durable) return false
    try {
      if (durable.continuation?.gateId === gate.gateId) {
        this.runLedger.checkpoint({
          runId: durable.runId,
          continuation: {
            ...durable.continuation,
            state: 'failed',
            updatedAt: this.continuationTimestamp(),
          },
        })
      }
      this.runLedger.finish(durable.runId, 'failed', 'human_gate_continuation_invalid')
      return true
    } catch {
      return false
    }
  }

  resumeReadyHumanGates() {
    for (const durable of this.runLedger?.list?.() || []) {
      if (!['ready', 'resuming'].includes(durable.continuation?.state)) continue
      let gate
      try { gate = this.humanGateStore.get(durable.continuation.gateId) } catch { continue }
      if (!gate.decision) continue
      queueMicrotask(() => this.resumeHumanGateDecision(gate, gate.decision))
    }
  }

  recordAgentFailure(groupId, kind, error, threadRootId, reportedFailures = null) {
    return this.runMessages.recordFailure(
      groupId, kind, error, threadRootId, reportedFailures,
    )
  }

  streamedAgentConclusion(groupId, agentRunId) {
    return this.runMessages.streamedConclusion(groupId, agentRunId)
  }

  recordAgentInterruption(
    groupId, kind, error, threadRootId, status = 'stopped', reportedFailures = null,
  ) {
    return this.runMessages.recordInterruption(
      groupId, kind, error, threadRootId, status, reportedFailures,
    )
  }

  async refreshAgents() {
    const snapshot = await this.agentCatalog.refresh()
    this.resumeV4ManualRecoveries()
    this.resumeV4AutoRecoveries()
    this.resumeReadyHumanGates()
    return snapshot
  }

  setSidebarVisibility(kind, visible) {
    return this.agentCatalog.setSidebarVisibility(kind, visible)
  }

  markRuntimeCredential(kind, credentialState) {
    return this.agentCatalog.markRuntimeCredential(kind, credentialState)
  }

  clearRuntimeCredentialFailures() {
    return this.agentCatalog.clearRuntimeCredentialFailures()
  }

  createGroup(input) {
    return this.conversations.createGroup(input)
  }

  updateGroup(groupId, input) {
    return this.conversations.updateGroup(groupId, input)
  }

  deleteGroup(groupId) {
    return this.conversations.deleteGroup(groupId)
  }

  deleteMessage(groupId, messageId) {
    return this.conversations.deleteMessage(groupId, messageId)
  }

  getGroup(groupId) {
    return this.conversations.getGroup(groupId)
  }

  addMessage(
    groupId, role, content, agentKind = '', threadRootId = '', system = null, metadata = {},
  ) {
    return this.conversations.addMessage(
      groupId, role, content, agentKind, threadRootId, system, metadata,
    )
  }

  commitV4AgentMessage(input = {}) {
    const messageId = String(input.messageId || '')
    const existing = this.state.messages.find(message => message.id === messageId)
    if (existing) {
      if (existing.groupId !== input.groupId || existing.role !== 'agent'
          || existing.agentKind !== input.agentKind
          || String(existing.threadRootId || '') !== String(input.threadRootId || '')
          || existing.content !== input.content) {
        throw new Error('LOCAL_RUN_COMMIT_INVALID')
      }
      return existing
    }
    const group = this.getGroup(input.groupId)
    const message = normalizeLoadedMessage({
      id: messageId,
      groupId: group.id,
      role: 'agent',
      agentKind: input.agentKind,
      senderName: this.agentLabel(input.agentKind),
      content: input.content,
      createdAt: this.now(),
      ...(input.threadRootId ? { threadRootId: input.threadRootId } : {}),
      ...(input.metadata?.elapsedMs != null ? { elapsedMs: input.metadata.elapsedMs } : {}),
      ...(Array.isArray(input.metadata?.toolCalls) ? { toolCalls: input.metadata.toolCalls } : {}),
      ...(Array.isArray(input.metadata?.attachments)
        ? { attachments: input.metadata.attachments } : {}),
      ...(input.metadata?.responseVersionRootId
        ? { responseVersionRootId: input.metadata.responseVersionRootId } : {}),
      ...(input.metadata?.trace ? { trace: input.metadata.trace } : {}),
    })
    if (!message || message.id !== messageId) throw new Error('LOCAL_RUN_COMMIT_INVALID')
    const previousMessages = [...this.state.messages]
    const previousUpdatedAt = group.updatedAt
    try {
      this.state.messages.push(message)
      group.updatedAt = message.createdAt
      this.save()
    } catch (error) {
      this.state.messages = previousMessages
      group.updatedAt = previousUpdatedAt
      throw error
    }
    this.emitChanged()
    return message
  }

  sessionKey(groupId, kind, taskId = '') {
    return sessionKey(groupId, kind, taskId)
  }

  clearSessionState(groupId) {
    clearSessionState(this.state, groupId)
  }

  openClawSessionRef(group, generation = '', taskId = '') {
    return openClawSessionRef(group, generation, taskId)
  }

  sessionState(group, kind, threadRootId = '', taskId = '') {
    const previousSessions = { ...this.state.sessions }
    const previousSessionMeta = { ...this.state.sessionMeta }
    try {
      return resolveSessionState({
        state: this.state,
        group,
        kind,
        threadRootId,
        taskId,
        save: () => this.save(),
      })
    } catch (error) {
      this.state.sessions = previousSessions
      this.state.sessionMeta = previousSessionMeta
      throw error
    }
  }

  sessionRef(group, kind, threadRootId = '', taskId = '') {
    return this.sessionState(group, kind, threadRootId, taskId).sessionRef
  }

  persistSessionState(key, sessionRef, meta) {
    const nextRef = normalizeSessionRef(sessionRef)
    if (!SESSION_KEY.test(String(key || '')) || !nextRef) return false
    const hadSession = Object.hasOwn(this.state.sessions, key)
    const hadMeta = Object.hasOwn(this.state.sessionMeta, key)
    const previousSession = this.state.sessions[key]
    const previousMeta = this.state.sessionMeta[key]
    this.state.sessions[key] = nextRef
    this.state.sessionMeta[key] = normalizeSessionMeta(meta)
    try {
      this.save()
    } catch (error) {
      if (hadSession) this.state.sessions[key] = previousSession
      else delete this.state.sessions[key]
      if (hadMeta) this.state.sessionMeta[key] = previousMeta
      else delete this.state.sessionMeta[key]
      throw error
    }
    return true
  }

  persistSessionRef(key, sessionRef) {
    const next = normalizeSessionRef(sessionRef)
    if (!SESSION_KEY.test(String(key || '')) || !next || next === this.state.sessions[key]) return false
    this.state.sessions[key] = next
    this.save()
    return true
  }

  persistSessionMeta(key, meta) {
    const next = normalizeSessionMeta(meta)
    if (!this.state.sessionMeta || typeof this.state.sessionMeta !== 'object') {
      this.state.sessionMeta = {}
    }
    this.state.sessionMeta[key] = next
    this.save()
    return next
  }

  createContextPack(input) {
    return this.contextPacks.basePack(input)
  }

  createAttemptContextPack(input) {
    return this.contextPacks.attemptPack(input)
  }

  recordContextDelivery(input) {
    return this.contextPacks.delivery(input)
  }

  recordAgentOutcomes(input = {}) {
    const controller = this.activeRuns.get(String(input.groupId || ''))
    const runId = String(input.runId || '')
    const agentRunId = String(input.agentRunId || '')
    const agentKind = String(input.agentKind || '')
    const round = Number(input.round)
    const harnessRun = controller?.harness?.current(agentKind, round, agentRunId)
    if (!controller || controller.runId !== runId || !harnessRun
        || harnessRun.agentRunId !== agentRunId || harnessRun.kind !== agentKind) return {}

    const conclusion = String(input.conclusion || '').trim()
    const descriptors = Array.isArray(input.descriptors) ? input.descriptors : []
    const candidates = [
      ...(conclusion ? [{
        type: 'document',
        name: `${agentKind}-conclusion.txt`,
        content: Buffer.from(conclusion, 'utf8'),
        mediaType: 'text/plain',
      }] : []),
      ...descriptors,
    ].slice(0, MAX_AGENT_OUTCOME_ARTIFACTS)
    const refs = { artifactIds: [], evidenceIds: [] }
    const producedBy = { runId, agentRunId, agentKind }

    for (const descriptor of candidates) {
      if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) continue
      try {
        const artifactInput = {
          type: descriptor.type,
          name: descriptor.name,
          producedBy,
        }
        if (Buffer.isBuffer(descriptor.content) || descriptor.content instanceof Uint8Array) {
          const mediaType = String(descriptor.mediaType || '')
          const contentRef = this.contentBlobStore.put(
            descriptor.content,
            mediaType ? { mediaType } : undefined,
          )
          if (descriptor.contentHash && descriptor.contentHash !== contentRef.hash) continue
          artifactInput.contentRef = contentRef
          artifactInput.contentHash = contentRef.hash
        } else if (descriptor.contentHash) {
          artifactInput.contentHash = descriptor.contentHash
        }
        if (descriptor.locationRef) artifactInput.locationRef = descriptor.locationRef

        const artifact = this.outcomeStore.putArtifact(artifactInput)
        const evidenceRefs = [{ type: 'artifact', artifactId: artifact.artifactId }]
        if (artifact.contentRef) {
          evidenceRefs.push({
            type: 'blob',
            contentRef: artifact.contentRef,
            contentHash: artifact.contentHash,
          })
        } else if (artifact.locationRef) {
          evidenceRefs.push({
            type: 'location',
            locationRef: artifact.locationRef,
            ...(artifact.contentHash ? { contentHash: artifact.contentHash } : {}),
          })
        }
        const evidence = this.outcomeStore.putEvidence({
          kind: 'observation',
          level: 'observed',
          subject: { type: 'artifact', artifactId: artifact.artifactId },
          summary: 'Meldwork captured the concrete Agent output.',
          recordedBy: OUTCOME_RECORDER,
          refs: evidenceRefs,
        })
        refs.artifactIds.push(artifact.artifactId)
        refs.evidenceIds.push(evidence.evidenceId)
      } catch { /* invalid or unavailable outcome capture must not discard the Agent reply */ }
    }
    return normalizeOutcomeRefs(refs)
  }

  promptMessageText(message, limit = 20000) {
    return promptMessageText(message, limit)
  }

  stableUserInstructions(groupId, threadRootId = '', contextOptions = {}) {
    return stableUserInstructions(this.state, groupId, threadRootId, contextOptions)
  }

  stableUserMessages(groupId, threadRootId = '', contextOptions = {}) {
    return stableUserMessages(this.state, groupId, threadRootId, contextOptions)
  }

  recentTranscriptEntries(groupId, afterAgentKind = '', contextOptions = {}) {
    return recentTranscriptEntries(this.state, groupId, afterAgentKind, contextOptions)
  }

  recentTranscript(groupId, afterAgentKind = '') {
    return this.packedPromptContext(groupId, afterAgentKind).recentText
  }

  packedPromptContext(groupId, afterAgentKind = '', threadRootId = '', contextOptions = {}) {
    return packedPromptContext({
      state: this.state,
      groupId,
      afterAgentKind,
      threadRootId,
      agentLabel: kind => this.agentLabel(kind),
      ...contextOptions,
    })
  }

  promptFor(
    group, kind, mode, threadRootId = '', skillHints = [], knowledgeBaseHints = [],
    transcriptAfterKind = '', contextPackage = null, promptMode = 'bootstrap',
    unlimitedRounds = false,
  ) {
    const packed = contextPackage || this.packedPromptContext(group.id, transcriptAfterKind, threadRootId)
    return promptFor({
      group,
      kind,
      mode,
      skillHints,
      knowledgeBaseHints,
      packed,
      agentLabel: agentKind => this.agentLabel(agentKind),
      promptMode,
      unlimitedRounds,
    })
  }

  ensureRunHarness(group, controller, threadRootId = '') {
    return this.runCoordinator.ensureHarness(group, controller, threadRootId)
  }

  emitRunEvent(event) {
    return this.runCoordinator.emitRunEvent(event)
  }

  clearAgentSilence(controller, kind, round, agentRunId = '') {
    return this.runCoordinator.clearAgentSilence(controller, kind, round, agentRunId)
  }

  armAgentSilence(controller, kind, round, agentRunId = '') {
    return this.runCoordinator.armAgentSilence(controller, kind, round, agentRunId)
  }

  clearRunSilence(controller) {
    return this.runCoordinator.clearRunSilence(controller)
  }

  async invokeAgent(group, kind, mode, signal, threadRootId = '', context = {}) {
    return this.agentInvocation.invoke(group, kind, mode, signal, threadRootId, context)
  }

  resetAgentSession(group, kind, rotateOpenClaw = true, taskId = '') {
    return this.agentInvocation.resetSession(group, kind, rotateOpenClaw, taskId)
  }

  async resolveAttachments(attachmentRefs) {
    return this.messageSubmission.resolveAttachments(attachmentRefs)
  }

  validateAttachmentSupport(targetKinds, attachments) {
    return this.messageSubmission.validateAttachmentSupport(targetKinds, attachments)
  }

  async preflightMessage(targetKinds, input, reservation) {
    return this.messageSubmission.preflight(targetKinds, input, reservation)
  }

  startAutoRunner(
    group, targetKinds, threadRootId, maxRounds, reservation = null, preparedContext = null,
    unlimitedRounds = false, taskGraph = null,
  ) {
    return this.autoRunner.start(
      group, targetKinds, threadRootId, maxRounds, reservation, preparedContext, unlimitedRounds,
      taskGraph,
    )
  }

  async sendMessage(input) {
    return this.messageSubmission.send(input)
  }

  startAuto(input) {
    return this.messageSubmission.startAuto(input)
  }

  stop(groupId, runId) {
    return this.runCoordinator.stop(groupId, runId)
  }

  controlAgent(groupId, runId, kind, action, replacementKind = '') {
    const group = this.getGroup(groupId)
    if (!group.agentKinds.includes(kind)) return false
    if (action === 'replace') {
      const controller = this.activeRuns.get(groupId)
      const replacement = this.detectedAgents.find(agent => (
        agent.kind === replacementKind && agent.available && group.agentKinds.includes(agent.kind)
          && controller?.targetKinds?.includes(agent.kind)
      ))
      if (!replacement) return false
    }
    return this.runCoordinator.controlAgent(
      groupId, runId, kind, action, replacementKind,
    )
  }

  async stopAll() {
    for (const timer of this.runCheckpointTimers.values()) clearTimeout(timer)
    this.runCheckpointTimers.clear()
    await this.runCoordinator.stopAll()
    for (const timer of this.runCheckpointTimers.values()) clearTimeout(timer)
    this.runCheckpointTimers.clear()
  }
}

module.exports = { LocalWorkspace }

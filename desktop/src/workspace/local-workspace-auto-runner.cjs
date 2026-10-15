const { createHash } = require('node:crypto')
const { MAX_MESSAGE_TEXT_CHARS } = require('./local-workspace-contracts.cjs')

const {
  cleanText,
  normalizeKnowledgeBaseHint,
  normalizeSkillHint,
} = require('./local-workspace-inputs.cjs')
const {
  MAX_RUN_AGENT_ATTEMPTS,
  boundedBackoffDelay,
  normalizeAttemptHistoryEntry,
  normalizeFailure,
  normalizeFailureOutcome,
  retryDecision,
} = require('../runs/failure-policy.cjs')
const {
  appendBlackboardEntry,
  collaborationPackageIndexText,
  appendHandoff,
  collaborationPackageText,
  createBlackboardEntryRecord,
  emptyCollaborationState,
  publicCollaborationText,
  roleForIndex,
  visibleBlackboardEntries,
} = require('../collaboration/collaboration-records.cjs')
const {
  appendWorkReceipt,
  buildCollaborationPackage,
  candidateCommitBlackboardStatement,
  candidateCommitSinkId,
  commitDeliveryObservable,
  coordinationRecoveryKinds,
  createCollaborationReceipt,
  createSynthesisBinding,
  hashValue,
  parseCollaborationControlBlock,
  rankedSynthesisKinds,
  resolveCoordinationConsensus,
} = require('../collaboration/orchestration-v4-records.cjs')
const { createReviewerFindingRecord } = require('../collaboration/outcome-records.cjs')
const { canonicalJson } = require('../collaboration/context-pack-records.cjs')
const { parseTaskDecision } = require('../collaboration/task-decision.cjs')
const {
  packNaturalDiscussionTranscript,
  restoreV4SnapshotSkills,
  unlimitedReviewContract,
  v4Prompt,
  v4Snapshot,
  v4SnapshotBodyHash,
  v4SnapshotSkillHints,
  validateV4SnapshotBody,
} = require('./local-workspace-context.cjs')
const {
  createTaskGraphCursor,
  parseTaskGraphCursor,
  readyTaskGraphNodes,
  terminalTaskGraphState,
  updateTaskGraphCursor,
} = require('../collaboration/task-graph-records.cjs')
const {
  abortableDelay,
  authenticationFailureStatus,
  authenticationFailureText,
  circuitBreakerError,
  circuitBreakerFailure,
  hardBudgetFailure,
  sanitizedAuthenticationError,
  stalePermissionResumeFailure,
  terminalRunStatusForReason,
  unauthorizedFailure,
} = require('./local-workspace-auto-runner-support.cjs')
const { traceCapsuleFromAgentRun } = require('../runs/run-harness-normalization.cjs')
const { v4NaturalDecisionMethods } = require('./local-workspace-auto-runner-natural-decisions.cjs')
const { v4OutcomeMethods } = require('./local-workspace-auto-runner-v4-outcomes.cjs')

class LocalWorkspaceAutoRunner {
  constructor(options) {
    this.state = options.state
    this.canWriteWorkspace = options.canWriteWorkspace || (() => false)
    this.beginRun = options.beginRun
    this.resolveAttachments = options.resolveAttachments
    this.validateSkillSelections = options.validateSkillSelections
    this.validateKnowledgeBaseSelections = options.validateKnowledgeBaseSelections
    this.invokeAgent = options.invokeAgent
    this.defaultYolo = options.defaultYolo !== false
    this.naturalAgentResponses = options.naturalAgentResponses === true
    this.resetAgentSession = options.resetAgentSession
    this.refreshAgents = options.refreshAgents
    this.consumeAgentControl = options.consumeAgentControl
    this.markRuntimeCredential = options.markRuntimeCredential
    this.agentLabel = options.agentLabel
    this.recordAgentFailure = options.recordAgentFailure
    this.recordAgentInterruption = options.recordAgentInterruption
    this.addMessage = options.addMessage
    this.commitV4AgentMessage = typeof options.commitV4AgentMessage === 'function'
      ? options.commitV4AgentMessage
      : null
    this.emitChanged = options.emitChanged
    this.finishRun = options.finishRun
    this.outcomeStore = options.outcomeStore || null
    this.contentBlobStore = options.contentBlobStore || null
    this.checkpointRun = options.checkpointRun
    this.hasRunLedger = typeof options.hasRunLedger === 'function'
      ? options.hasRunLedger
      : () => false
    this.requestHumanGate = typeof options.requestHumanGate === 'function'
      ? options.requestHumanGate
      : null
    this.requestTaskDecision = options.requestTaskDecision || null
    this.taskDecisionResponses = options.taskDecisionResponses || (() => [])
    this.completeHumanGateContinuation = typeof options.completeHumanGateContinuation === 'function'
      ? options.completeHumanGateContinuation
      : null
    this.retryContract = typeof options.retryContract === 'function'
      ? options.retryContract
      : () => ({ idempotencyMode: 'none' })
    this.retryBaseDelayMs = Number.isFinite(options.retryBaseDelayMs)
      ? Math.max(1, Math.floor(options.retryBaseDelayMs))
      : 250
    this.retryMaxDelayMs = Number.isFinite(options.retryMaxDelayMs)
      ? Math.max(this.retryBaseDelayMs, Math.floor(options.retryMaxDelayMs))
      : 2000
    // Provider throttling without a Retry-After hint waits at least this long
    // so automatic retries do not burn the remaining quota within a second.
    this.retryRateLimitMinDelayMs = Number.isFinite(options.retryRateLimitMinDelayMs)
      ? Math.max(0, Math.floor(options.retryRateLimitMinDelayMs))
      : 2000
    this.sleep = options.retrySleep || abortableDelay
  }

  setCurrentAgent(controller, kind) {
    controller.currentKind = kind
    controller.progress = []
    this.emitChanged()
  }

  pauseFailedAgentForRun(group, controller, kind, threadRootId, error = null) {
    // Failures are scoped to the current run. Group membership is user
    // configuration: editing it after a provider or login hiccup made the
    // Agent disappear from every later conversation turn, and removing the
    // last member made the whole group (and its history) unloadable.
    if (group.conversationType === 'direct' || !group.agentKinds.includes(kind)) return false
    if (!controller.failedKinds.includes(kind)) controller.failedKinds.push(kind)
    const alreadyReported = this.state().messages.some(message => (
      message.threadRootId === threadRootId
        && message.agentKind === kind
        && message.system?.key === 'system.agentPausedAfterFailure'
        && message.system?.params?.runId === controller.runId
    ))
    if (!alreadyReported) {
      const agent = this.agentLabel(kind)
      const reason = normalizeFailure(error).code || 'LOCAL_AGENT_PROCESS_FAILED'
      this.addMessage(
        group.id,
        'system',
        `${agent} is paused for the rest of this discussion (${reason}). It stays in the group and will be tried again on the next message.`,
        kind,
        threadRootId,
        {
          key: 'system.agentPausedAfterFailure',
          params: { agent, reason, runId: controller.runId },
        },
      )
    }
    return true
  }

  shouldPauseFailedAgent(error) {
    const category = normalizeFailure(error).category
    // Runtime, provider, rate-limit, protocol, and timeout failures stay
    // silent run-scoped exclusions; their own failure message explains them.
    // Authentication and compatibility failures get an explicit notice
    // because the user usually has to act (sign in or update the CLI).
    return ['authentication', 'compatibility'].includes(category)
  }

  replacementInstruction(failedKind) {
    return [
      `You are replacing ${this.agentLabel(failedKind)} for this turn.`,
      'Complete the interrupted Agent slot using the shared task context, then return your own conclusion.',
      'Do not claim that the interrupted Agent completed this work.',
    ].join('\n')
  }

  retryDelay(failedAttempt) {
    return boundedBackoffDelay(failedAttempt, {
      baseDelayMs: this.retryBaseDelayMs,
      maxDelayMs: this.retryMaxDelayMs,
    })
  }

  operationIdFor(controller, kind, mode) {
    const digest = createHash('sha256').update(JSON.stringify({
      runId: controller.runId,
      kind,
      mode,
      round: controller.currentRound || 0,
    })).digest('hex')
    return `agent-operation-${digest}`
  }

  recordAttempt(group, controller, input) {
    const history = Array.isArray(controller.attemptHistory) ? controller.attemptHistory : []
    const previousSequence = history.at(-1)?.sequence || 0
    const entry = normalizeAttemptHistoryEntry({
      sequence: previousSequence + 1,
      agentKind: input.agentKind,
      phase: input.phase,
      attempt: input.attempt,
      failureCategory: input.failureCategory ?? null,
      policyAction: input.policyAction,
      backoffMs: input.backoffMs || 0,
      recoveryAgentKind: input.recoveryAgentKind || '',
      finalOutcome: input.finalOutcome,
      timestamp: Date.now(),
      ...(input.outcomeCertainty ? { outcomeCertainty: input.outcomeCertainty } : {}),
      ...(Object.hasOwn(input, 'sideEffectsPossible')
        ? { sideEffectsPossible: input.sideEffectsPossible }
        : {}),
      ...(input.operationId ? { operationId: input.operationId } : {}),
      ...(input.idempotencyMode ? { idempotencyMode: input.idempotencyMode } : {}),
    })
    if (!entry) throw new Error('LOCAL_RUN_ATTEMPT_INVALID')
    controller.attemptHistory = [...history, entry].slice(-256)
    const persisted = this.checkpointRun?.(group.id, controller)
    if (this.hasRunLedger() && persisted !== true) {
      throw new Error('LOCAL_RUN_PERSIST_FAILED')
    }
    return entry
  }

  async prepareRetry(group, kind, controller, failedAttempt, options = {}) {
    if (options.resetSession === true) {
      this.resetAgentSession(group, kind, true, controller.taskId)
    }
    this.markRuntimeCredential(kind, 'unknown')
    try { await this.refreshAgents() } catch {
      if (controller.signal.aborted) throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
    }
    const delayMs = Number.isFinite(options.delayMs)
      ? Math.max(0, Math.floor(options.delayMs))
      : this.retryDelay(failedAttempt)
    await this.sleep(delayMs, controller.signal)
    return delayMs
  }

  async invokeTransiently(invokeSource, group, kind, controller, options = {}) {
    const operationId = options.operationId
    const idempotencyMode = options.idempotencyMode === 'durable' ? 'durable' : 'none'
    const sideEffectsPossible = options.sideEffectsPossible === true
    for (let attempt = 1; ; attempt += 1) {
      if (controller.attemptHistory.length >= MAX_RUN_AGENT_ATTEMPTS) {
        throw circuitBreakerError()
      }
      const phase = attempt === 1 ? (options.phase || 'initial') : 'transient_retry'
      const phaseAttempt = attempt === 1 ? (options.attempt || 1) : attempt - 1
      try {
        const result = await invokeSource()
        this.recordAttempt(group, controller, {
          agentKind: options.agentKind || kind,
          phase,
          attempt: phaseAttempt,
          failureCategory: null,
          policyAction: options.successAction || 'complete',
          backoffMs: options.successBackoffMs || 0,
          recoveryAgentKind: options.recoveryAgentKind || '',
          finalOutcome: 'succeeded',
          sideEffectsPossible,
          operationId,
          idempotencyMode,
        })
        return result
      } catch (error) {
        if (controller.signal.aborted) {
          this.recordAttempt(group, controller, {
            agentKind: options.agentKind || kind,
            phase,
            attempt: phaseAttempt,
            failureCategory: 'cancellation',
            policyAction: 'cancel',
            recoveryAgentKind: options.recoveryAgentKind || '',
            finalOutcome: 'cancelled',
          })
          throw error
        }
        if (unauthorizedFailure(error)) throw error
        const failure = normalizeFailure(error)
        const safety = normalizeFailureOutcome(error, {
          category: failure.category,
          sideEffectsPossible,
          operationId,
          idempotencyMode,
        })
        if (failure.category === 'cancellation') throw error
        if (options.deferFailurePolicy === true) {
          this.recordAttempt(group, controller, {
            agentKind: options.agentKind || kind,
            phase,
            attempt: phaseAttempt,
            failureCategory: failure.category,
            policyAction: 'fail',
            backoffMs: 0,
            recoveryAgentKind: '',
            finalOutcome: 'failed',
            ...safety,
          })
          throw error
        }
        // Session recovery is owned by LocalWorkspaceAgentInvocation so a stale
        // native Session gets exactly one fresh attempt across every run mode.
        // An ambiguous refusal (HTTP 403, proxy or region block) gets exactly
        // one more attempt: a transient gateway refusal recovers, while a real
        // permission problem fails fast without signing the Agent out.
        const maxAttempts = failure.category === 'timeout' && options.retryTimeouts !== true
          ? 1
          : failure.code === 'LOCAL_AGENT_ACCESS_DENIED' ? 2 : 4
        const decision = retryDecision(failure, {
          attempt,
          maxAttempts,
          baseDelayMs: this.retryBaseDelayMs,
          maxDelayMs: this.retryMaxDelayMs,
          rateLimitMinDelayMs: this.retryRateLimitMinDelayMs,
          safety,
        })
        if (decision.action === 'human_gate') {
          this.recordAttempt(group, controller, {
            agentKind: options.agentKind || kind,
            phase,
            attempt: phaseAttempt,
            failureCategory: failure.category,
            policyAction: 'human_gate',
            backoffMs: decision.delayMs,
            recoveryAgentKind: options.recoveryAgentKind || '',
            finalOutcome: 'failed',
            ...safety,
          })
          if (!this.requestHumanGate || !error?.runTrace?.agentRunId) {
            throw new Error('LOCAL_RUN_RETRY_GATE_INVALID')
          }
          const gate = await this.requestHumanGate({
            type: 'retry',
            runId: controller.runId,
            agentRunId: error.runTrace.agentRunId,
            agentKind: options.agentKind || kind,
            summary: 'The previous write-capable Agent attempt may already have changed the workspace.',
            options: [
              { optionId: 'retry-once', name: 'Retry once', kind: 'allow_once' },
              { optionId: 'cancel-retry', name: 'Do not retry', kind: 'reject_once' },
            ],
            request: {
              failureCategory: failure.category,
              outcomeCertainty: safety.outcomeCertainty,
              sideEffectsPossible: safety.sideEffectsPossible,
              operationId: safety.operationId,
              idempotencyMode: safety.idempotencyMode,
            },
          }, {
            signal: controller.signal,
            preserveOnAbort: () => controller.stopReason === 'shutdown',
            continuation: {
              resumeKind: 'agent_slot',
              agentRunId: error.runTrace.agentRunId,
              agentKind: options.agentKind || kind,
              round: controller.currentRound || 0,
              ...(options.v4AgentSlotBinding || {}),
            },
          })
          if (gate.status !== 'approved') {
            this.completeHumanGateContinuation?.(controller.runId, gate.gateId, 'cancelled')
            controller.stopReason = 'human_gate_rejected'
            controller.abort()
            throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
          }
          if (this.completeHumanGateContinuation?.(
            controller.runId, gate.gateId, 'completed',
          ) !== true && this.hasRunLedger()) {
            throw new Error('LOCAL_RUN_PERSIST_FAILED')
          }
          this.markRuntimeCredential(kind, 'unknown')
          try { await this.refreshAgents() } catch {
            if (controller.signal.aborted) throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
          }
          await this.sleep(decision.delayMs, controller.signal)
          continue
        }
        if (decision.action !== 'retry') {
          this.recordAttempt(group, controller, {
            agentKind: options.agentKind || kind,
            phase,
            attempt: phaseAttempt,
            failureCategory: failure.category,
            policyAction: options.failureAction
              || (decision.action === 'refresh_session' ? 'refresh_session' : 'fail'),
            backoffMs: options.failureBackoffMs || 0,
            recoveryAgentKind: options.recoveryAgentKind || '',
            finalOutcome: 'failed',
            ...safety,
          })
          throw error
        }
        this.recordAttempt(group, controller, {
          agentKind: options.agentKind || kind,
          phase,
          attempt: phaseAttempt,
          failureCategory: failure.category,
          policyAction: 'retry',
          backoffMs: decision.delayMs,
          recoveryAgentKind: options.recoveryAgentKind || '',
          finalOutcome: 'failed',
          ...safety,
        })
        // Transient retries keep the Agent's readiness untouched. Refreshing
        // the whole catalog here re-ran discovery and credential probes while
        // the Agent was busy and could flip a healthy Agent to unavailable.
        await this.sleep(decision.delayMs, controller.signal)
      }
    }
  }

  async controlAfterFailure(group, kind, controller, error) {
    const request = this.consumeAgentControl(controller, kind)
    if (!request) return null
    const failure = normalizeFailure(error)
    const manualAttempt = (controller.manualRetryCounts.get(kind) || 0) + 1
    if (request.action === 'retry') {
      controller.manualRetryCounts.set(kind, manualAttempt)
      const delayMs = this.retryDelay(manualAttempt)
      this.recordAttempt(group, controller, {
        agentKind: kind,
        phase: 'manual_retry',
        attempt: manualAttempt,
        failureCategory: failure.category,
        policyAction: 'retry',
        backoffMs: delayMs,
        finalOutcome: 'failed',
      })
      await this.prepareRetry(group, kind, controller, manualAttempt, {
        resetSession: true,
        delayMs,
      })
      return { action: 'retry' }
    }
    this.recordAttempt(group, controller, {
      agentKind: kind,
      phase: 'manual_retry',
      attempt: manualAttempt,
      failureCategory: failure.category,
      policyAction: request.action === 'replace' ? 'replace_agent' : 'cancel',
      recoveryAgentKind: request.replacementKind || '',
      finalOutcome: request.action === 'replace' ? 'replaced' : 'cancelled',
    })
    return request
  }

  async invokeWithUnauthorizedRecovery(input) {
    const { controller, kind } = input
    if (controller.attemptHistory.length >= MAX_RUN_AGENT_ATTEMPTS) {
      throw circuitBreakerError()
    }
    if (controller.agentSlotKinds.has(kind)) {
      throw new Error('LOCAL_AGENT_ATTEMPT_RUNNING')
    }
    controller.agentSlotKinds.add(kind)
    try {
      return await this.invokeWithUnauthorizedRecoveryInSlot(input)
    } finally {
      controller.agentSlotKinds.delete(kind)
    }
  }

  async invokeWithUnauthorizedRecoveryInSlot({
    group,
    kind,
    controller,
    threadRootId,
    context,
    mode = 'auto',
  }) {
    const requestedOperationId = String(context?.operationId || '')
    const operationId = /^[A-Za-z0-9._:-]{1,120}$/.test(requestedOperationId)
      ? requestedOperationId
      : this.operationIdFor(controller, kind, mode)
    const contract = this.retryContract(kind) || {}
    const idempotencyMode = contract.idempotencyMode === 'durable' ? 'durable' : 'none'
    const sideEffectsPossible = group.allowWrite === true
      && context.permissionMode !== 'read-only'
    const invokeSource = async () => {
      if (context.parallelGraph !== true) this.setCurrentAgent(controller, kind)
      return this.invokeAgent(group, kind, mode, controller.signal, threadRootId, {
        ...context,
        yolo: context.yolo ?? this.defaultYolo,
        deferCredentialFailure: true,
        operationId,
      })
    }
    let phase = 'initial'
    let phaseAttempt = 1
    while (true) {
      try {
        return {
          result: await this.invokeTransiently(invokeSource, group, kind, controller, {
            phase,
            attempt: phaseAttempt,
            operationId,
            idempotencyMode,
            sideEffectsPossible,
            deferFailurePolicy: context.v4SynthesisRecovery === true
              || (context.v4 === true && context.resumedGate?.type === 'permission'),
            // A timed-out automatic slot is a failed participant for this
            // round. Retrying it serially delays every healthy peer and
            // defeats failure isolation; manual/direct invocations retain
            // their existing timeout retry policy.
            retryTimeouts: mode !== 'auto',
            v4AgentSlotBinding: mode === 'auto' && context.v4 === true ? {
              phase: context.phase,
              slotId: context.slotId,
              operationId,
              snapshotHash: context.snapshotHash,
            } : null,
          }),
          removed: false,
        }
      } catch (error) {
        if (controller.signal.aborted) throw error
        const control = await this.controlAfterFailure(group, kind, controller, error)
        if (control?.action === 'retry') {
          phase = 'manual_retry'
          phaseAttempt = controller.manualRetryCounts.get(kind) || 1
          continue
        }
        if (control) return { result: null, removed: false, control, error }
        if (!unauthorizedFailure(error)) throw error
        // Only explicit sign-in failures reach this point. Mark the Agent as
        // needing a fresh login; the catalog clears it on the next refresh
        // after the retry window or as soon as native credentials verify.
        this.markRuntimeCredential(kind, 'missing')
        this.recordAttempt(group, controller, {
          agentKind: kind,
          phase,
          attempt: phaseAttempt,
          failureCategory: 'authentication',
          policyAction: 'fail',
          finalOutcome: 'failed',
          ...normalizeFailureOutcome(error, {
            sideEffectsPossible: group.allowWrite === true,
            operationId,
            idempotencyMode,
          }),
        })
        throw sanitizedAuthenticationError(error)
      }
    }
  }

  orchestrationCursor(targetKinds, taskGraph = null) {
    if (taskGraph) {
      return {
        version: 3,
        workflow: 'auto',
        template: 'task-graph',
        currentKind: '',
        pendingKinds: [...targetKinds],
        activeKinds: [...targetKinds],
        successfulKinds: [],
        agreementKinds: [],
        attachmentRecipients: [],
        totalSuccesses: 0,
        terminalFailureOccurred: false,
        collaboration: emptyCollaborationState(),
        taskGraph: createTaskGraphCursor(taskGraph),
      }
    }
    return {
      version: 2,
      workflow: 'auto',
      currentKind: '',
      pendingKinds: [...targetKinds],
      activeKinds: [...targetKinds],
      successfulKinds: [],
      agreementKinds: [],
      attachmentRecipients: [],
      totalSuccesses: 0,
      terminalFailureOccurred: false,
      collaboration: emptyCollaborationState(),
    }
  }

  collaborationRole(activeKinds, kind) {
    return roleForIndex(Math.max(0, activeKinds.indexOf(kind)))
  }

  collaborationAudience(role) {
    return {
      roles: role === 'primary'
        ? ['reviewer', 'arbiter']
        : (role === 'reviewer' ? ['primary', 'arbiter'] : ['primary', 'reviewer']),
      agentKinds: [],
    }
  }

  collaborationAcceptance(role) {
    if (role === 'reviewer') {
      return [
        'Check the selected claims and outcome references.',
        'Identify unsupported assumptions, conflicts, or missing evidence.',
      ]
    }
    if (role === 'arbiter') {
      return [
        'Resolve visible conflicts using the selected evidence.',
        'Return one bounded conclusion and state whether consensus is reached.',
      ]
    }
    return [
      'Produce one concrete conclusion for the current task.',
      'Publish only claims and durable outcome references needed downstream.',
    ]
  }

  collaborationExpectedOutput(role) {
    if (role === 'reviewer') return 'A concise review with corrections or explicit acceptance.'
    if (role === 'arbiter') return 'A final adjudication of the selected claims and conflicts.'
    return 'A concise primary conclusion with any durable Artifact or Evidence references.'
  }

  collaborationObjective(group, controller, threadRootId) {
    const root = this.state().messages.find(message => (
      message.groupId === group.id && message.id === threadRootId && message.role === 'user'
    ))
    return publicCollaborationText(root?.content || 'Complete the current user task.', 3000)
      || 'Complete the current user task.'
  }

  prepareCollaborationPackage(
    group, controller, activeKinds, kind, threadRootId, options = {},
  ) {
    const collaboration = controller.orchestration?.collaboration || emptyCollaborationState()
    const destination = {
      agentKind: kind,
      role: options.role || this.collaborationRole(activeKinds, kind),
    }
    const selectedEntryIds = Array.isArray(options.selectedEntryIds)
      ? new Set(options.selectedEntryIds)
      : null
    const selectedEntries = selectedEntryIds
      ? collaboration.entries.filter(entry => selectedEntryIds.has(entry.entryId))
      : visibleBlackboardEntries(collaboration, destination)
    const objective = this.collaborationObjective(group, controller, threadRootId)
    const expectedOutput = options.expectedOutput
      || this.collaborationExpectedOutput(destination.role)
    const acceptanceCriteria = options.acceptanceCriteria
      || this.collaborationAcceptance(destination.role)
    const selectedIds = selectedEntries.map(entry => entry.entryId)
    const reusable = [...collaboration.handoffs].reverse().find(handoff => (
      handoff.destination.agentKind === destination.agentKind
      && handoff.destination.role === destination.role
      && handoff.objective === objective
      && handoff.expectedOutput === expectedOutput
      && handoff.selectedEntryIds.length === selectedIds.length
      && handoff.selectedEntryIds.every((id, index) => id === selectedIds[index])
      && handoff.acceptanceCriteria.length === acceptanceCriteria.length
      && handoff.acceptanceCriteria.every((value, index) => value === acceptanceCriteria[index])
    ))
    if (reusable) {
      return {
        handoff: reusable,
        entries: selectedEntries,
        text: collaborationPackageText(reusable, selectedEntries),
      }
    }
    const previousOwner = [...collaboration.entries].reverse().find(entry => (
      entry.owner.type === 'agent'
    ))?.owner
    const createdAt = Date.now()
    const next = appendHandoff(collaboration, {
      source: previousOwner || { type: 'harness' },
      destination,
      objective,
      selectedEntryIds: selectedIds,
      expectedOutput,
      acceptanceCriteria,
      provenance: {
        runId: controller.runId,
        taskId: controller.taskId,
        round: controller.currentRound,
        agentRunId: null,
        artifactIds: [],
        evidenceIds: [],
      },
      createdAt,
    })
    const handoff = next.handoffs.at(-1)
    this.checkpointOrchestration(group, controller, { collaboration: next })
    return {
      handoff,
      entries: selectedEntries,
      text: collaborationPackageText(handoff, selectedEntries),
    }
  }

  recordCollaborationResult(group, controller, activeKinds, kind, result, options = {}) {
    const role = options.role || this.collaborationRole(activeKinds, kind)
    const conclusion = publicCollaborationText(result?.message?.content || '')
    const trace = result?.message?.trace
    const provenance = {
      runId: controller.runId,
      taskId: controller.taskId,
      round: controller.currentRound,
      agentRunId: trace?.agentRunId || null,
      artifactIds: result?.outcomeRefs?.artifactIds || [],
      evidenceIds: result?.outcomeRefs?.evidenceIds || [],
    }
    let collaboration = controller.orchestration?.collaboration || emptyCollaborationState()
    const previousCollaboration = collaboration
    const previousEntryIds = new Set(collaboration.entries.map(entry => entry.entryId))
    let sequence = collaboration.entries.length + 1
    const recordedAt = Date.now()
    const conclusionValue = conclusion
      ? createHash('sha256').update(conclusion).digest('hex')
      : ''
    const entryType = options.entryType || 'claim'
    const subject = options.subject || `task:${controller.taskId}:conclusion`
    const entryRefs = Array.isArray(options.refs) ? options.refs : []
    const duplicateConclusion = conclusion && collaboration.entries.some(entry => (
      entry.entryType === entryType
      && entry.lifecycle.state === 'active'
      && entry.subject === subject
      && entry.value === conclusionValue
      && entry.owner.type === 'agent'
      && entry.owner.agentKind === kind
    ))
    if (conclusion && !duplicateConclusion) {
      collaboration = appendBlackboardEntry(collaboration, {
        entryType,
        subject,
        statement: conclusion,
        value: entryType === 'claim' ? conclusionValue : '',
        owner: { type: 'agent', agentKind: kind, role },
        audience: this.collaborationAudience(role),
        lifecycle: {
          state: 'active', sequence, recordedAt, supersedesEntryId: null,
        },
        provenance,
        refs: entryRefs,
      })
      sequence = collaboration.entries.length + 1
    }
    for (const artifactId of duplicateConclusion ? [] : provenance.artifactIds.slice(0, 1)) {
      collaboration = appendBlackboardEntry(collaboration, {
        entryType: 'artifact-ref',
        subject: `task:${controller.taskId}:artifact`,
        statement: 'Durable Artifact produced by the Agent.',
        value: '',
        owner: { type: 'agent', agentKind: kind, role },
        audience: this.collaborationAudience(role),
        lifecycle: {
          state: 'active', sequence, recordedAt, supersedesEntryId: null,
        },
        provenance,
        refs: [artifactId],
      })
      sequence = collaboration.entries.length + 1
    }
    for (const evidenceId of duplicateConclusion ? [] : provenance.evidenceIds.slice(0, 1)) {
      collaboration = appendBlackboardEntry(collaboration, {
        entryType: 'evidence-ref',
        subject: `task:${controller.taskId}:evidence`,
        statement: 'Durable Evidence recorded for the Agent conclusion.',
        value: '',
        owner: { type: 'agent', agentKind: kind, role },
        audience: this.collaborationAudience(role),
        lifecycle: {
          state: 'active', sequence, recordedAt, supersedesEntryId: null,
        },
        provenance,
        refs: [evidenceId],
      })
      sequence = collaboration.entries.length + 1
    }
    if (collaboration !== previousCollaboration) {
      this.checkpointOrchestration(group, controller, { collaboration })
    }
    return collaboration.entries
      .filter(entry => !previousEntryIds.has(entry.entryId))
      .map(entry => entry.entryId)
  }

  checkpointOrchestration(group, controller, updates = {}) {
    const previous = controller.orchestration
    controller.orchestration = { ...previous, ...updates }
    // A thrown callback has an unknown write outcome; only explicit failure is safe to roll back.
    const persisted = this.checkpointRun?.(group.id, controller)
    if (this.hasRunLedger() && persisted !== true) {
      controller.orchestration = previous
      if (previous?.version === 4) controller.currentRound = previous.round
      throw new Error('LOCAL_RUN_PERSIST_FAILED')
    }
  }

  v4PhaseAdvanceBlocked(controller) {
    const orchestration = controller.orchestration
    const continuation = controller.continuation
    return orchestration?.version === 4
      && continuation?.resumeKind === 'agent_slot'
      && continuation.phase === orchestration.phase
      && continuation.round === orchestration.round
      // `resuming` means the gate decision has already been accepted and the
      // continuation is actively replaying the gated slot. Blocking that
      // state makes the resume path fail with its own phase-gate error.
      && ['pending', 'ready'].includes(continuation.state)
  }

  assertV4PhaseCanAdvance(controller) {
    if (this.v4PhaseAdvanceBlocked(controller)) {
      throw new Error('LOCAL_RUN_V4_PHASE_GATE_PENDING')
    }
  }

  unresolvedTaskGraphConflicts(collaborationInput = null) {
    const collaboration = collaborationInput || emptyCollaborationState()
    const resolved = new Set(collaboration.entries
      .filter(entry => entry.entryType === 'decision' && entry.lifecycle.state === 'active')
      .flatMap(entry => entry.refs))
    return collaboration.entries.filter(entry => (
      entry.entryType === 'conflict'
      && entry.lifecycle.state === 'active'
      && !resolved.has(entry.entryId)
    ))
  }

  taskGraphAcceptanceCriteria(node) {
    const criteria = []
    if (node.acceptance.requireConclusion) criteria.push('Return one concrete conclusion.')
    if (node.acceptance.minArtifactRefs) {
      criteria.push(`Produce at least ${node.acceptance.minArtifactRefs} durable Artifact reference(s).`)
    }
    if (node.acceptance.minEvidenceRefs) {
      criteria.push(`Produce at least ${node.acceptance.minEvidenceRefs} durable Evidence reference(s).`)
    }
    return criteria.length ? criteria : ['Complete the explicit Human decision.']
  }

  taskGraphSelectedEntryIds(controller, node) {
    const cursor = parseTaskGraphCursor(controller.orchestration.taskGraph)
    const states = new Map(cursor.nodeStates.map(state => [state.nodeId, state]))
    const selected = node.inputNodeIds.flatMap(nodeId => states.get(nodeId)?.entryIds || [])
    if (['reviewer', 'arbiter'].includes(node.role)) {
      selected.push(...this.unresolvedTaskGraphConflicts(
        controller.orchestration.collaboration,
      ).map(entry => entry.entryId))
    }
    return [...new Set(selected)]
  }

  taskGraphPrompt(node, objective, collaborationPackage, unlimitedRounds = false) {
    return [
      'MELDWORK_TASK_GRAPH_V1',
      `Node: ${node.nodeId}`,
      `Role: ${node.role}`,
      `Objective: ${objective}`,
      `Expected output: ${node.expectedOutput}`,
      `Acceptance criteria: ${this.taskGraphAcceptanceCriteria(node).join(' | ')}`,
      unlimitedReviewContract(unlimitedRounds),
      collaborationPackage.text,
      'Return the requested result directly. Completion is evaluated from durable typed records; do not emit a consensus marker.',
    ].join('\n')
  }

  checkpointTaskGraph(group, controller, cursorInput, options = {}) {
    let taskGraph = parseTaskGraphCursor(cursorInput)
    taskGraph = parseTaskGraphCursor({
      ...taskGraph,
      terminalState: terminalTaskGraphState(taskGraph),
    })
    const states = new Map(taskGraph.nodeStates.map(state => [state.nodeId, state]))
    const pendingKinds = taskGraph.graph.nodes
      .filter(node => states.get(node.nodeId)?.status === 'pending' && node.agentKind)
      .map(node => node.agentKind)
    const successfulKinds = taskGraph.graph.nodes
      .filter(node => states.get(node.nodeId)?.status === 'accepted' && node.agentKind)
      .map(node => node.agentKind)
    const uniquePendingKinds = [...new Set(pendingKinds)]
    const uniqueSuccessfulKinds = [...new Set(successfulKinds)]
    this.checkpointOrchestration(group, controller, {
      taskGraph,
      currentKind: options.currentKind || '',
      pendingKinds: uniquePendingKinds,
      successfulKinds: uniqueSuccessfulKinds,
      agreementKinds: [],
      totalSuccesses: taskGraph.nodeStates.filter(state => state.status === 'accepted').length,
      terminalFailureOccurred: taskGraph.terminalState === 'failed',
    })
    return taskGraph
  }

  taskGraphResultAccepted(node, result) {
    const conclusion = publicCollaborationText(result?.message?.content || '')
    const artifactIds = result?.outcomeRefs?.artifactIds || []
    const evidenceIds = result?.outcomeRefs?.evidenceIds || []
    return (!node.acceptance.requireConclusion || Boolean(conclusion))
      && artifactIds.length >= node.acceptance.minArtifactRefs
      && evidenceIds.length >= node.acceptance.minEvidenceRefs
  }

  applyTaskGraphAgentResult(group, controller, node, result) {
    const conflicts = this.unresolvedTaskGraphConflicts(controller.orchestration.collaboration)
    const entryIds = this.recordCollaborationResult(
      group,
      controller,
      controller.orchestration.activeKinds,
      node.agentKind,
      result,
      {
        role: node.role,
        entryType: node.role === 'arbiter' ? 'decision' : 'claim',
        subject: node.role === 'primary'
          ? `task:${controller.taskId}:conclusion`
          : `task:${controller.taskId}:node:${node.nodeId}`,
        refs: node.role === 'arbiter' ? conflicts.map(entry => entry.entryId) : [],
      },
    )
    const accepted = this.taskGraphResultAccepted(node, result)
    const conclusion = publicCollaborationText(result?.message?.content || '')
    const artifactIds = result?.outcomeRefs?.artifactIds || []
    const evidenceIds = result?.outcomeRefs?.evidenceIds || []
    let cursor = updateTaskGraphCursor(
      controller.orchestration.taskGraph,
      node.nodeId,
      {
        status: accepted ? 'accepted' : 'failed',
        entryIds,
        artifactIds,
        evidenceIds,
        conclusionHash: conclusion
          ? createHash('sha256').update(conclusion).digest('hex')
          : '',
      },
    )
    if (accepted) {
      if (!controller.completedKinds.includes(node.agentKind)) {
        controller.completedKinds.push(node.agentKind)
      }
    } else if (!controller.failedKinds.includes(node.agentKind)) {
      controller.failedKinds.push(node.agentKind)
    }
    cursor = this.checkpointTaskGraph(group, controller, cursor)
    return accepted
  }

  taskGraphDecisionAgentRunId(graphId, nodeId) {
    const digest = createHash('sha256').update(JSON.stringify([graphId, nodeId])).digest('hex')
    return `graph-decision-${digest}`
  }

  taskGraphDecisionAnchor(controller, node) {
    const graph = parseTaskGraphCursor(controller.orchestration.taskGraph)
    const byId = new Map(graph.graph.nodes.map(candidate => [candidate.nodeId, candidate]))
    return [...node.dependsOn].reverse()
      .map(nodeId => byId.get(nodeId)?.agentKind)
      .find(Boolean) || controller.targetKinds[0]
  }

  applyTaskGraphHumanDecision(group, controller, node, decision) {
    const option = node.decisionOptions.find(candidate => candidate.optionId === decision.optionId)
    if (!option) throw new Error('LOCAL_WORKFLOW_DECISION_INVALID')
    const accepted = decision.status === 'approved'
    const conflicts = this.unresolvedTaskGraphConflicts(controller.orchestration.collaboration)
    let collaboration = controller.orchestration.collaboration
    collaboration = appendBlackboardEntry(collaboration, {
      entryType: 'decision',
      subject: `task:${controller.taskId}:node:${node.nodeId}`,
      statement: `Human selected: ${option.name}`,
      value: '',
      owner: { type: 'harness' },
      audience: { roles: ['primary', 'reviewer', 'arbiter'], agentKinds: [] },
      lifecycle: {
        state: 'active',
        sequence: collaboration.entries.length + 1,
        recordedAt: Date.now(),
        supersedesEntryId: null,
      },
      provenance: {
        runId: controller.runId,
        taskId: controller.taskId,
        round: controller.currentRound,
        agentRunId: this.taskGraphDecisionAgentRunId(
          controller.orchestration.taskGraph.graph.graphId,
          node.nodeId,
        ),
        artifactIds: [],
        evidenceIds: [],
      },
      refs: conflicts.map(entry => entry.entryId),
    })
    const decisionEntryId = collaboration.entries.at(-1).entryId
    this.checkpointOrchestration(group, controller, { collaboration })
    let cursor = updateTaskGraphCursor(
      controller.orchestration.taskGraph,
      node.nodeId,
      {
        status: accepted ? 'accepted' : 'rejected',
        entryIds: [decisionEntryId],
        decisionOptionId: option.optionId,
      },
    )
    cursor = this.checkpointTaskGraph(group, controller, cursor)
    return accepted
  }

  async executeTaskGraphAgentNode(
    group, controller, threadRootId, context, node, parallelGraph = false,
  ) {
    const selectedEntryIds = this.taskGraphSelectedEntryIds(controller, node)
    const collaborationPackage = this.prepareCollaborationPackage(
      group,
      controller,
      controller.orchestration.activeKinds,
      node.agentKind,
      threadRootId,
      {
        role: node.role,
        selectedEntryIds,
        expectedOutput: node.expectedOutput,
        acceptanceCriteria: this.taskGraphAcceptanceCriteria(node),
      },
    )
    const isolated = ['reviewer', 'arbiter'].includes(node.role)
    const attachments = node.role === 'primary'
      && !controller.orchestration.attachmentRecipients.includes(node.agentKind)
      ? context.rootAttachments.map(attachment => attachment.path)
      : []
    const objective = this.collaborationObjective(group, controller, threadRootId)
    return this.invokeWithUnauthorizedRecovery({
      group,
      kind: node.agentKind,
      controller,
      threadRootId,
      context: {
        attachments,
        attachmentSnapshots: attachments.length ? context.rootAttachments : [],
        skillHints: context.rootSkillsByKind.get(node.agentKind) || [],
        knowledgeBaseHints: context.rootKnowledgeBasesByKind.get(node.agentKind) || [],
        collaborationPackage,
        completionPolicy: 'typed',
        parallelGraph,
        runtimeInstruction: isolated ? '' : [
          `Execute task-graph node ${node.nodeId} as ${node.role}.`,
          `Expected output: ${node.expectedOutput}`,
          'Do not emit a consensus marker.',
        ].join('\n'),
        ...(isolated ? {
          sessionPolicy: 'isolated',
          promptOverride: this.taskGraphPrompt(
            node, objective, collaborationPackage, controller.unlimitedRounds === true,
          ),
          contextPackId: controller.contextPackId,
        } : {}),
        contextOptions: {
          focusUserMessageId: threadRootId,
          omitAgentThreadRootId: threadRootId,
        },
      },
      mode: 'auto',
    })
  }

  async executeTaskGraphHumanNode(group, controller, node) {
    if (!this.requestHumanGate) throw new Error('LOCAL_WORKFLOW_DECISION_UNAVAILABLE')
    const anchorKind = this.taskGraphDecisionAnchor(controller, node)
    const agentRunId = this.taskGraphDecisionAgentRunId(
      controller.orchestration.taskGraph.graph.graphId,
      node.nodeId,
    )
    let cursor = updateTaskGraphCursor(
      controller.orchestration.taskGraph,
      node.nodeId,
      { status: 'waiting', attention: 'decision', attempts: 1 },
    )
    cursor = this.checkpointTaskGraph(group, controller, cursor, { currentKind: anchorKind })
    const gate = await this.requestHumanGate({
      type: 'decision',
      runId: controller.runId,
      agentRunId,
      agentKind: anchorKind,
      summary: node.expectedOutput,
      options: node.decisionOptions,
      request: {
        graphId: cursor.graph.graphId,
        nodeId: node.nodeId,
        inputNodeIds: node.inputNodeIds,
      },
    }, {
      signal: controller.signal,
      preserveOnAbort: () => controller.stopReason === 'shutdown',
      continuation: {
        resumeKind: 'role_review_decision',
        agentRunId,
        agentKind: anchorKind,
        round: controller.currentRound,
      },
    })
    const accepted = this.applyTaskGraphHumanDecision(group, controller, node, gate)
    if (this.completeHumanGateContinuation?.(
      controller.runId,
      gate.gateId,
      accepted ? 'completed' : 'cancelled',
    ) !== true && this.hasRunLedger()) {
      throw new Error('LOCAL_RUN_PERSIST_FAILED')
    }
    return accepted
  }

  taskGraphBatch(group, readyNodes) {
    const parallel = []
    const kinds = new Set()
    if (group.allowWrite !== true) {
      for (const node of readyNodes) {
        if (!node.parallel || node.role === 'human' || kinds.has(node.agentKind)) continue
        parallel.push(node)
        kinds.add(node.agentKind)
      }
    }
    return parallel.length > 1 ? parallel : readyNodes.slice(0, 1)
  }

  async runTaskGraph(group, controller, threadRootId, context) {
    while (!controller.signal.aborted) {
      let cursor = parseTaskGraphCursor(controller.orchestration.taskGraph)
      const terminalState = terminalTaskGraphState(cursor)
      if (terminalState !== 'running') {
        cursor = this.checkpointTaskGraph(group, controller, cursor)
        break
      }
      if (!controller.unlimitedRounds && controller.currentRound >= controller.maxRounds) break
      const readyNodes = readyTaskGraphNodes(cursor)
      if (!readyNodes.length) {
        cursor = parseTaskGraphCursor({ ...cursor, terminalState: 'failed' })
        this.checkpointTaskGraph(group, controller, cursor)
        break
      }
      const batch = this.taskGraphBatch(group, readyNodes)
      controller.currentRound += 1
      if (batch.length === 1 && batch[0].role === 'human') {
        await this.executeTaskGraphHumanNode(group, controller, batch[0])
        continue
      }
      const conflicts = this.unresolvedTaskGraphConflicts(controller.orchestration.collaboration)
      for (const node of batch) {
        cursor = updateTaskGraphCursor(cursor, node.nodeId, {
          status: 'running',
          attention: node.role === 'reviewer' && conflicts.length
            ? 'review'
            : (node.role === 'arbiter' && conflicts.length ? 'decision' : 'none'),
          attempts: cursor.nodeStates.find(state => state.nodeId === node.nodeId).attempts + 1,
        })
      }
      const currentKind = batch.length === 1 ? batch[0].agentKind : ''
      cursor = this.checkpointTaskGraph(group, controller, cursor, { currentKind })
      this.emitChanged()
      const settled = await Promise.allSettled(batch.map(node => (
        this.executeTaskGraphAgentNode(
          group, controller, threadRootId, context, node, batch.length > 1,
        )
      )))
      for (let index = 0; index < batch.length; index += 1) {
        const node = batch[index]
        const outcome = settled[index]
        if (outcome.status === 'fulfilled' && outcome.value?.result) {
          if (outcome.value.result.outcomeRefs?.artifactIds?.length
              && !controller.orchestration.attachmentRecipients.includes(node.agentKind)) {
            this.checkpointOrchestration(group, controller, {
              attachmentRecipients: [...controller.orchestration.attachmentRecipients, node.agentKind],
            })
          }
          this.applyTaskGraphAgentResult(group, controller, node, outcome.value.result)
          continue
        }
        const error = outcome.status === 'rejected'
          ? outcome.reason
          : (outcome.value?.error || new Error('LOCAL_AGENT_UNKNOWN_FAILURE'))
        if (controller.signal.aborted) continue
        this.recordAgentFailure(group.id, node.agentKind, error, threadRootId, new Set())
        cursor = updateTaskGraphCursor(
          controller.orchestration.taskGraph,
          node.nodeId,
          { status: 'failed' },
        )
        this.checkpointTaskGraph(group, controller, cursor)
        if (!controller.failedKinds.includes(node.agentKind)) {
          controller.failedKinds.push(node.agentKind)
        }
        if (circuitBreakerFailure(error)) {
          controller.stopReason = 'circuit_breaker'
          controller.abort()
        } else if (hardBudgetFailure(error)) {
          controller.stopReason = 'hard_budget'
          controller.abort()
        }
      }
      controller.currentKind = ''
      controller.progress = []
      this.emitChanged()
    }

    if (controller.signal.aborted) return terminalRunStatusForReason(controller.stopReason)
    const cursor = parseTaskGraphCursor(controller.orchestration.taskGraph)
    if (cursor.terminalState === 'accepted') return 'completed'
    if (cursor.terminalState === 'rejected') return 'stopped'
    if (cursor.terminalState === 'failed') {
      return cursor.nodeStates.some(state => state.status === 'accepted') ? 'partial' : 'failed'
    }
    return cursor.nodeStates.some(state => state.status === 'accepted') ? 'round-limit' : 'failed'
  }

  async automaticContext(group, controller, threadRootId, preparedContext = null) {
    let rootAttachments = preparedContext?.attachments
    let rootSkillsByKind = preparedContext?.skillHintsByKind
    let rootKnowledgeBasesByKind = preparedContext?.knowledgeBaseHintsByKind
    if (!rootAttachments || !rootSkillsByKind || !rootKnowledgeBasesByKind) {
      const rootMessage = this.state().messages.find(message => (
        message.id === threadRootId && message.groupId === group.id && message.role === 'user'
      ))
      rootAttachments = await this.resolveAttachments(rootMessage?.attachments || [])
      rootSkillsByKind = new Map()
      for (const kind of controller.targetKinds) {
        const scoped = (rootMessage?.skillHints || []).filter(skill => skill.targetKind === kind)
        if (!scoped.length) {
          rootSkillsByKind.set(kind, [])
          continue
        }
        try {
          const validated = await this.validateSkillSelections(kind, scoped)
          rootSkillsByKind.set(
            kind,
            Array.isArray(validated) && validated.every(skill => skill?.targetKind === kind)
              ? validated
              : [],
          )
        } catch {
          rootSkillsByKind.set(kind, [])
        }
      }
      let storedKnowledgeBaseHints = []
      try {
        const validated = await this.validateKnowledgeBaseSelections(
          controller.targetKinds,
          rootMessage?.knowledgeBaseHints || [],
        )
        storedKnowledgeBaseHints = (Array.isArray(validated) ? validated : [])
          .map(normalizeKnowledgeBaseHint)
          .filter(Boolean)
      } catch { /* unavailable knowledge bases are omitted when resuming */ }
      rootKnowledgeBasesByKind = new Map(controller.targetKinds.map(kind => [
        kind,
        storedKnowledgeBaseHints.filter(source => source.targetKinds.includes(kind)),
      ]))
    }
    return {
      rootAttachments,
      rootSkillsByKind,
      rootKnowledgeBasesByKind,
    }
  }

  v4Enabled(controller) {
    return controller?.v4 === true || controller?.orchestration?.version === 4
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

  v4SynthesisBinding({ targetKinds, snapshotRecord, routingDecision }) {
    const selected = new Set(targetKinds)
    const candidates = (Array.isArray(routingDecision?.candidates)
      ? routingDecision.candidates : [])
      .filter(candidate => selected.has(candidate?.kind))
      .map(candidate => ({
        kind: candidate.kind,
        score: candidate.score,
        ...(candidate.evidence ? { evidence: { ...candidate.evidence } } : {}),
      }))
    return createSynthesisBinding({
      snapshotContentHash: snapshotRecord?.bodyHash,
      targetKinds,
      candidates,
    })
  }

  v4SynthesisRankedKinds(roleBinding) {
    return roleBinding?.planHash
      ? coordinationRecoveryKinds(roleBinding)
      : rankedSynthesisKinds(roleBinding)
  }

  v4SynthesisVerificationKinds(roleBinding, writerKind) {
    if (roleBinding?.planHash) {
      const rankedKinds = coordinationRecoveryKinds(roleBinding)
      const verificationKinds = roleBinding.verifierKinds.filter(kind => kind !== writerKind)
      if (!rankedKinds.includes(writerKind) || verificationKinds.length < 1) {
        throw new Error('LOCAL_RUN_V4_COORDINATION_PLAN_INVALID')
      }
      return verificationKinds
    }
    return rankedSynthesisKinds(roleBinding)
      .filter(kind => kind !== writerKind)
      .slice(0, Math.min(2, roleBinding.candidates.length - 1))
  }

  v4SynthesisAttemptOperationId(controller, kind, slotId, attempt) {
    const digest = createHash('sha256').update(JSON.stringify([
      controller.runId,
      controller.taskId,
      kind,
      slotId,
      'synthesis',
      controller.currentRound || 0,
      attempt,
    ])).digest('hex')
    return `operation-${digest}`
  }

  v4CreateSynthesisRecovery(controller, roleBinding, slots, options = {}) {
    const rankedKinds = this.v4SynthesisRankedKinds(roleBinding)
    const originalWriterKind = roleBinding?.planHash
      ? roleBinding.finalizerKind : roleBinding.writerKind
    const writerKind = String(options.writerKind || originalWriterKind)
    const writerSlot = slots.find(slot => slot.agentKind === writerKind)
    if (!writerSlot || !rankedKinds.includes(writerKind)) {
      throw new Error('LOCAL_RUN_V4_SYNTHESIS_RECOVERY_INVALID')
    }
    const attempt = Math.max(1, Number(options.attempt) || 1)
    const operationId = this.v4SynthesisAttemptOperationId(
      controller, writerKind, writerSlot.slotId, attempt,
    )
    return {
      revision: Math.max(1, Number(options.revision) || 1),
      originalWriterKind,
      activeWriterKind: writerKind,
      verificationKinds: this.v4SynthesisVerificationKinds(roleBinding, writerKind),
      rankedKinds,
      rankingFingerprint: roleBinding?.planHash
        ? hashValue({ planHash: roleBinding.planHash, rankedKinds })
        : hashValue({ selectionInputHash: roleBinding.selectionInputHash, rankedKinds }),
      stateEpoch: Math.max(0, Number(options.stateEpoch) || 0),
      triedWriters: rankedKinds.slice(0, rankedKinds.indexOf(writerKind) + 1),
      attempts: [{
        attemptId: `synthesis-attempt-${hashValue({ operationId, attempt }).slice(0, 64)}`,
        writerKind,
        slotId: writerSlot.slotId,
        operationId,
        attempt,
        status: 'intent',
        permission: 'read-only',
        leaseAcquired: false,
        sideEffectsPossible: false,
        outcomeCertainty: 'not_started',
        updatedAt: Date.now(),
      }],
    }
  }

  v4ActiveSynthesisAttempt(recovery) {
    return [...(recovery?.attempts || [])].reverse().find(attempt => (
      ['intent', 'leased', 'unknown_outcome'].includes(attempt.status)
    )) || null
  }

  v4UpdateSynthesisAttempt(recovery, operationId, updates) {
    let matched = false
    const attempts = recovery.attempts.map(attempt => {
      if (attempt.operationId !== operationId) return attempt
      matched = true
      return { ...attempt, ...updates, updatedAt: Date.now() }
    })
    if (!matched) throw new Error('LOCAL_RUN_V4_SYNTHESIS_RECOVERY_INVALID')
    return { ...recovery, attempts }
  }

  v4SynthesisRecoveryGate(controller, recovery) {
    const attempt = this.v4ActiveSynthesisAttempt(recovery)
    if (!attempt || attempt.status !== 'unknown_outcome') {
      throw new Error('LOCAL_RUN_V4_SYNTHESIS_RECOVERY_INVALID')
    }
    const currentIndex = recovery.rankedKinds.indexOf(recovery.activeWriterKind)
    const fields = {
      writerKind: attempt.writerKind,
      slotId: attempt.slotId,
      operationId: attempt.operationId,
      attempt: attempt.attempt,
      proposedReplacementKind: recovery.rankedKinds[currentIndex + 1] || '',
      round: controller.currentRound,
      stateEpoch: recovery.stateEpoch,
      rankingFingerprint: recovery.rankingFingerprint,
    }
    return { bindingHash: hashValue(fields), ...fields }
  }

  v4CancelSynthesisRecovery(recovery) {
    const binding = recovery?.pendingGate
    const boundAttempt = recovery?.attempts?.find(attempt => (
      attempt.operationId === binding?.operationId
    ))
    if (binding && boundAttempt?.status === 'cancelled'
        && boundAttempt.sideEffectsPossible === true
        && boundAttempt.outcomeCertainty === 'unknown_outcome') {
      return recovery
    }
    const attempt = this.v4ActiveSynthesisAttempt(recovery)
    if (!binding || !attempt || attempt.status !== 'unknown_outcome'
        || attempt.writerKind !== binding.writerKind
        || attempt.slotId !== binding.slotId
        || attempt.operationId !== binding.operationId
        || attempt.attempt !== binding.attempt) {
      throw new Error('LOCAL_RUN_V4_SYNTHESIS_RECOVERY_INVALID')
    }
    return this.v4UpdateSynthesisAttempt(recovery, attempt.operationId, {
      status: 'cancelled',
      sideEffectsPossible: true,
      outcomeCertainty: 'unknown_outcome',
    })
  }

  v4AppendSynthesisAttempt(controller, roleBinding, recovery, slots, writerKind) {
    let nextRecovery = recovery
    const activeAttempt = this.v4ActiveSynthesisAttempt(nextRecovery)
    if (activeAttempt?.status === 'unknown_outcome') {
      nextRecovery = this.v4UpdateSynthesisAttempt(
        nextRecovery,
        activeAttempt.operationId,
        {
          status: 'superseded',
          sideEffectsPossible: true,
          outcomeCertainty: 'unknown_outcome',
        },
      )
    } else if (activeAttempt) {
      throw new Error('LOCAL_RUN_V4_SYNTHESIS_RECOVERY_INVALID')
    }
    const { pendingGate: _pendingGate, ...withoutGate } = nextRecovery
    const writerSlot = slots.find(slot => slot.agentKind === writerKind)
    const writerIndex = withoutGate.rankedKinds.indexOf(writerKind)
    if (!writerSlot || writerIndex < 0) {
      throw new Error('LOCAL_RUN_V4_SYNTHESIS_RECOVERY_INVALID')
    }
    const attempt = withoutGate.attempts.filter(item => item.writerKind === writerKind).length + 1
    const operationId = this.v4SynthesisAttemptOperationId(
      controller, writerKind, writerSlot.slotId, attempt,
    )
    return {
      ...withoutGate,
      revision: withoutGate.revision + 1,
      activeWriterKind: writerKind,
      verificationKinds: this.v4SynthesisVerificationKinds(roleBinding, writerKind),
      triedWriters: withoutGate.rankedKinds.slice(0, writerIndex + 1),
      attempts: [...withoutGate.attempts, {
        attemptId: `synthesis-attempt-${hashValue({ operationId, attempt }).slice(0, 64)}`,
        writerKind,
        slotId: writerSlot.slotId,
        operationId,
        attempt,
        status: 'intent',
        permission: 'read-only',
        leaseAcquired: false,
        sideEffectsPossible: false,
        outcomeCertainty: 'not_started',
        updatedAt: Date.now(),
      }],
    }
  }

  v4ReplaceSynthesisWriter(controller, roleBinding, recovery, slots) {
    const currentIndex = recovery.rankedKinds.indexOf(recovery.activeWriterKind)
    const writerKind = recovery.rankedKinds[currentIndex + 1] || ''
    if (!writerKind) return null
    return this.v4AppendSynthesisAttempt(
      controller, roleBinding, recovery, slots, writerKind,
    )
  }

  v4OperationId(
    controller, kind, phase, slotId = '', round = controller.currentRound || 0,
  ) {
    const digest = createHash('sha256').update(JSON.stringify([
      controller.runId,
      controller.taskId,
      kind,
      slotId,
      phase,
      round,
    ])).digest('hex')
    return `operation-${digest}`
  }

  v4SnapshotRecord(controller, snapshot, targetKinds) {
    if (!this.contentBlobStore) throw new Error('LOCAL_RUN_SNAPSHOT_STORE_UNAVAILABLE')
    const serialized = canonicalJson(snapshot)
    const contentRef = this.contentBlobStore.put(serialized, { mediaType: 'application/json' })
    const sourceIds = [snapshot?.messageId, ...(snapshot?.history || []).map(item => item.id)]
      .filter(Boolean).slice(-64)
    const taskId = snapshot?.taskId || controller.taskId || null
    const record = {
      contextPackId: controller.contextPackId || null,
      taskId,
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
    return { record, snapshotHash: hashValue(record) }
  }

  v4SnapshotSkillHints(snapshot, targetKinds) {
    return v4SnapshotSkillHints(snapshot, targetKinds)
  }

  async v4RestoreSnapshotSkills(snapshot, targetKinds, persisted = null) {
    return restoreV4SnapshotSkills({
      snapshot,
      targetKinds,
      validateSkillSelections: this.validateSkillSelections,
      persisted,
    })
  }

  v4LoadSnapshot(orchestration, { taskId, messageId, groupId, targetKinds }) {
    const record = orchestration?.snapshot
    if (!record?.contentRef || !this.contentBlobStore) {
      throw new Error('LOCAL_RUN_SNAPSHOT_INVALID')
    }
    let bytes
    try { bytes = this.contentBlobStore.read(record.contentRef) } catch {
      throw new Error('LOCAL_RUN_SNAPSHOT_INVALID')
    }
    const serialized = bytes.toString('utf8')
    let body
    try { body = JSON.parse(serialized) } catch {
      throw new Error('LOCAL_RUN_SNAPSHOT_INVALID')
    }
    return validateV4SnapshotBody({
      body,
      serialized,
      byteLength: bytes.length,
      record,
      orchestrationSnapshotHash: orchestration.snapshotHash,
      taskId,
      messageId,
      groupId,
      targetKinds,
    })
  }

  v4RestoreReceipts(controller) {
    if (Array.isArray(controller.v4ReceiptRecords)) {
      return controller.v4ReceiptRecords.map(item => ({
        receipt: item.receipt,
        verdict: item.verdict || '',
        resolvedIssueIds: Array.isArray(item.resolvedIssueIds)
          ? [...item.resolvedIssueIds]
          : [],
      }))
    }
    const restored = []
    const slots = Array.isArray(controller.orchestration?.slots)
      ? controller.orchestration.slots
      : []
    for (const slot of slots) {
      const records = slot?.resultRefs?.workflowOutcomeRefs
      if (!Array.isArray(records)) continue
      for (const record of records) {
        if (!record?.receipt) continue
        try {
          const receipt = parseCollaborationControlBlock(record.receipt)
          restored.push({
            receipt,
            verdict: typeof record.verdict === 'string' ? record.verdict : '',
            resolvedIssueIds: Array.isArray(record.resolvedIssueIds)
              ? record.resolvedIssueIds.filter(value => typeof value === 'string')
              : [],
          })
        } catch { /* malformed historical receipts are ignored and re-run */ }
      }
    }
    controller.v4ReceiptRecords = restored
    return restored
  }

  v4Package(receiptRecords, options = {}) {
    const recipientKind = String(options.recipientKind || '')
    const binding = options.sessionBinding || {}
    const deliveryState = Array.isArray(options.deliveryState) ? options.deliveryState : []
    const latest = new Map()
    for (const item of receiptRecords) {
      const receipt = item?.receipt
      if (!receipt) continue
      const key = receipt.agentKind || `${receipt.phase}\u0000${receipt.summary}`
      const previous = latest.get(key)
      if (!previous || (Number(receipt.deliveryWatermark) || 0)
          > (Number(previous.receipt.deliveryWatermark) || 0)
          || ((Number(receipt.deliveryWatermark) || 0)
            === (Number(previous.receipt.deliveryWatermark) || 0)
            && receipt.phase.localeCompare(previous.receipt.phase) > 0)) {
        latest.set(key, item)
      }
    }
    let selectedItems = [...latest.values()]
    const snapshotHash = typeof options.snapshotHash === 'string' ? options.snapshotHash : ''
    const targetKinds = new Set(Array.isArray(options.targetKinds) ? options.targetKinds : [])
    const resolvedIssueIds = []
    const resolved = new Set()
    for (const item of receiptRecords) {
      const receipt = item?.receipt
      if (!snapshotHash || receipt?.snapshotHash !== snapshotHash
          || (targetKinds.size && !targetKinds.has(receipt.agentKind))) continue
      for (const value of Array.isArray(item.resolvedIssueIds) ? item.resolvedIssueIds : []) {
        if (typeof value !== 'string' || !value || value.length > 120 || resolved.has(value)) continue
        resolved.add(value)
        resolvedIssueIds.push(value)
        if (resolvedIssueIds.length >= 256) break
      }
      if (resolvedIssueIds.length >= 256) break
    }
    if (recipientKind && binding.sessionRefHash && !options.forceFull) {
      const acknowledged = new Map(deliveryState
        .filter(item => item.recipientKind === recipientKind
          && item.sessionRefHash === binding.sessionRefHash
          && item.sessionProvenanceHash === binding.sessionProvenanceHash
          && item.status === 'acknowledged')
        .map(item => [`${item.sourceAgentKind}\u0000${item.sourcePhase}`, item.watermark]))
      selectedItems = selectedItems.filter(item => {
        const receipt = item.receipt
        const previous = acknowledged.get(`${receipt.agentKind}\u0000${receipt.phase}`) || 0
        return (Number(receipt.deliveryWatermark) || 0) > previous
      })
    }
    const selectedReceipts = selectedItems.map(item => item.receipt)
    const totalLimit = Number.isSafeInteger(options.totalLimit) ? options.totalLimit : 6000
    const packageRecord = buildCollaborationPackage(selectedReceipts, {
      targetKinds: options.targetKinds || [],
      totalLimit,
      resolvedIssueIds,
    })
    const text = this.v4SanitizeDeliveryText(packageRecord.text, packageRecord.text.length)
    return text === packageRecord.text
      ? packageRecord
      : { ...packageRecord, text, totalChars: text.length, packageHash: hashValue(text) }
  }

  v4CoordinationResult({
    receiptRecords, targetKinds, snapshotHash, snapshot = null,
    challengeBindings = [], requireSupport = true,
  }) {
    const candidateReceipts = receiptRecords
      .filter(record => record?.receipt?.phase === 'challenge')
    const supportReceipts = requireSupport
      ? targetKinds.map((kind) => {
          const operationId = challengeBindings.find(binding => (
            binding.reviewerKind === kind
          ))?.reviewerOperationId || ''
          return this.v4ReceiptForOperation(
            receiptRecords, 'challenge', kind, operationId,
          ) || null
        })
      : []
    if (supportReceipts.some(receipt => !receipt)) {
      const result = resolveCoordinationConsensus({
        targetKinds, snapshotHash, candidateReceipts, supportReceipts: [],
      })
      return this.v4SemanticCoordinationResult(result, snapshot)
    }
    const result = resolveCoordinationConsensus({
      targetKinds, snapshotHash, candidateReceipts, supportReceipts,
    })
    return this.v4SemanticCoordinationResult(result, snapshot)
  }

  v4SemanticCoordinationResult(result, snapshot) {
    const candidates = result.candidates.filter((candidate) => {
      try {
        for (const assignment of candidate.assignments) {
          this.v4DirectAssignmentReferences(assignment, snapshot)
        }
        return true
      } catch (error) {
        if (error?.message === 'LOCAL_RUN_V4_ASSIGNMENT_REFERENCE_INVALID') return false
        throw error
      }
    })
    const candidateHashes = new Set(candidates.map(candidate => candidate.planHash))
    return {
      ...result,
      plan: result.plan && candidateHashes.has(result.plan.planHash) ? result.plan : null,
      candidates,
    }
  }

  v4SanitizeDeliveryText(value, limit = 6000) {
    const privateWrapper = '(?:private[ _-]?(?:reasoning|thoughts?)|analysis|chain[ _-]?of[ _-]?thought|cot)'
    const privateHeading = '(?:private[ _-]?(?:reasoning|thoughts?)|chain[ _-]?of[ _-]?thought|cot)'
    const stripped = this.v4StripMeldworkControls(
      publicCollaborationText(value, Number.MAX_SAFE_INTEGER),
    )
    const maximum = Number.isSafeInteger(limit) && limit >= 0 ? limit : 6000
    let privateSectionLevel = null
    const withoutPrivateSections = stripped.split(/\r?\n/).filter((line) => {
      const heading = line.match(/^\s*(#{1,6})\s+(.+)$/u)
      const level = heading?.[1].length
      if (heading && new RegExp(`^${privateHeading}\\b`, 'iu').test(heading[2].trim())) {
        privateSectionLevel = Math.min(privateSectionLevel ?? level, level)
        return false
      }
      if (privateSectionLevel !== null && heading && level <= privateSectionLevel) {
        privateSectionLevel = null
      }
      return privateSectionLevel === null
    }).join('\n')
    return withoutPrivateSections
      .replace(new RegExp(`<\\s*${privateWrapper}\\b[^>]*>[\\s\\S]*?<\\/\\s*${privateWrapper}\\s*>`, 'giu'), '')
      .replace(/(?:^|\n)\s*(?:my\s+)?private[ _-]?reasoning\s*:\s*[^\n]*/giu, '\n')
      .replace(/\b(?:session(?:[ _-]?(?:id|ref))?)\b\s*(?::|=)\s*[A-Za-z0-9][A-Za-z0-9._:-]*/giu, '[redacted]')
      .replace(/\b(?:session(?:[ _-]?(?:id|ref))?)\b\s+[A-Za-z0-9][A-Za-z0-9._:-]*/giu, '[redacted]')
      .replace(/\b(?:session[-_][A-Za-z0-9._:-]+|[A-Za-z0-9][A-Za-z0-9._:-]*-(?:native-)?session)\b/giu, '[redacted]')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, maximum)
  }

  v4StripMeldworkControls(text) {
    const marker = '[[MELDWORK_'
    const source = String(text || '')
    const upper = source.toUpperCase()
    let cursor = 0
    let output = ''
    while (true) {
      const start = upper.indexOf(marker, cursor)
      if (start < 0) return output + source.slice(cursor)
      output += source.slice(cursor, start)
      let quote = ''
      let escaped = false
      let braces = 0
      let brackets = 0
      let end = -1
      for (let index = start + 2; index < source.length - 1; index += 1) {
        const character = source[index]
        if (quote) {
          if (escaped) escaped = false
          else if (character === '\\') escaped = true
          else if (character === quote) quote = ''
          continue
        }
        if (character === '"' || character === "'") {
          quote = character
        } else if (character === '{') {
          braces += 1
        } else if (character === '}') {
          braces = Math.max(0, braces - 1)
        } else if (character === '[') {
          brackets += 1
        } else if (character === ']') {
          if (braces === 0 && brackets === 0 && source[index + 1] === ']') {
            end = index + 2
            break
          }
          brackets = Math.max(0, brackets - 1)
        }
      }
      if (end < 0) return output
      const header = source.slice(start, end)
      if (!header.includes(':')) {
        const closing = `[[/${header.slice(2, -2)}]]`.toUpperCase()
        const closingStart = upper.indexOf(closing, end)
        cursor = closingStart < 0 ? end : closingStart + closing.length
      } else {
        cursor = end
      }
    }
  }

  v4CoordinationText(result, limit = 4800) {
    const candidates = Array.isArray(result?.candidates) ? result.candidates : []
    if (!candidates.length) return ''
    const supportCounts = new Map()
    for (const planHash of result.supportPlanHashes || []) {
      if (planHash) supportCounts.set(planHash, (supportCounts.get(planHash) || 0) + 1)
    }
    const lines = [
      'MELDWORK_V4_RESPONSIBILITY_CANDIDATES_V1',
      'Fields: h=planHash;s=support;f=finalizer;v=verifiers;a=[t=taskId,o=owner,r=role,x=objective,y=expectedOutput,i=inputRefs,a=artifactRefs,d=dependencies]',
    ]
    const append = (line) => {
      const next = [...lines, line].join('\n')
      if (next.length > limit) return false
      lines.push(line)
      return true
    }
    for (const plan of candidates) {
      let safe = true
      const text = value => {
        const raw = String(value || '')
        const sanitized = this.v4SanitizeDeliveryText(raw, 2000)
        if (/\[\[MELDWORK_/iu.test(raw) || sanitized !== raw) safe = false
        return sanitized
      }
      const values = value => Array.isArray(value) ? value.map(text) : []
      const graph = {
        h: plan.planHash,
        s: supportCounts.get(plan.planHash) || 0,
        f: text(plan.finalizerKind),
        v: values(plan.verifierKinds),
        a: plan.assignments.map(assignment => ({
          t: text(assignment.taskId),
          o: text(assignment.ownerKind),
          r: text(assignment.role),
          x: text(assignment.objective),
          y: text(assignment.expectedOutput),
          i: values(assignment.inputRefs),
          a: values(assignment.artifactIds),
          d: values(assignment.dependsOn),
        })),
      }
      if (!safe) continue
      append(JSON.stringify(graph))
    }
    return lines.join('\n')
  }

  v4ChallengeProposalText(binding, reviewerKind, limit = 1600) {
    const proposalKind = String(binding?.proposalKind || '')
    if (!proposalKind || proposalKind === reviewerKind) {
      throw new Error('LOCAL_RUN_V4_CHALLENGE_BINDING_INVALID')
    }
    for (const artifactId of binding.artifactIds || []) {
      try {
        const { artifact, content } = this.v4ArtifactIdentity(artifactId)
        const body = this.v4SanitizeDeliveryText(content, limit)
        if (artifact.producedBy?.agentKind !== proposalKind || !body) continue
        return [
          'MELDWORK_V4_ASSIGNED_PROPOSAL_V1',
          `Proposal Agent: ${proposalKind}`,
          `Proposal Artifact: ${artifactId}`,
          'Proposal body excerpt:',
          body,
        ].join('\n')
      } catch { /* skip non-text and unavailable outcome refs */ }
    }
    throw new Error('LOCAL_RUN_V4_CHALLENGE_BINDING_INVALID')
  }

  v4CoordinationAssignment(coordinationPlan, kind, options = {}) {
    const owned = coordinationPlan?.assignments?.filter(item => item.ownerKind === kind) || []
    if (options.taskId) return owned.find(item => item.taskId === options.taskId) || null
    if (options.role) return owned.find(item => item.role === options.role) || null
    return owned[0] || null
  }

  v4DirectAssignmentReferences(assignment, snapshot) {
    const snapshotSources = new Map([
      [snapshot?.messageId, snapshot?.taskText],
      ...(Array.isArray(snapshot?.history) ? snapshot.history : []).map(item => [item?.id, item?.text]),
    ].filter(([sourceId]) => typeof sourceId === 'string' && sourceId))
    const safeReferenceText = (value) => {
      const raw = String(value || '').trim()
      const sanitized = this.v4SanitizeDeliveryText(raw, Number.MAX_SAFE_INTEGER)
      if (!raw || sanitized !== raw || /\[\[MELDWORK_/iu.test(raw)) {
        throw new Error('LOCAL_RUN_V4_ASSIGNMENT_REFERENCE_INVALID')
      }
      return sanitized
    }
    const inputReferences = assignment.inputRefs.map((sourceId) => {
      if (!snapshotSources.has(sourceId)) {
        throw new Error('LOCAL_RUN_V4_ASSIGNMENT_REFERENCE_INVALID')
      }
      return {
        kind: 'input', id: sourceId, header: `Input ${sourceId}:`,
        body: safeReferenceText(snapshotSources.get(sourceId)),
      }
    })
    const directArtifacts = assignment.artifactIds.map((artifactId) => {
      let identity
      try { identity = this.v4ArtifactIdentity(artifactId) } catch {
        throw new Error('LOCAL_RUN_V4_ASSIGNMENT_REFERENCE_INVALID')
      }
      if (identity.artifact.contentRef?.mediaType !== 'text/plain') {
        throw new Error('LOCAL_RUN_V4_ASSIGNMENT_REFERENCE_INVALID')
      }
      return {
        kind: 'artifact', id: artifactId, header: `Artifact ${artifactId}:`,
        body: safeReferenceText(identity.content),
      }
    })
    return { inputReferences, directArtifacts }
  }

  v4WorkAssignmentText(
    coordinationPlan, kind, taskId, snapshot = null, limit = 6000, receiptRecords = [],
  ) {
    const assignment = this.v4CoordinationAssignment(coordinationPlan, kind, { taskId })
    if (!assignment) throw new Error('LOCAL_RUN_V4_COORDINATION_PLAN_INVALID')
    const { inputReferences, directArtifacts } = this.v4DirectAssignmentReferences(
      assignment, snapshot,
    )
    const directReferences = [...inputReferences, ...directArtifacts]
    const dependencies = new Set(assignment.dependsOn)
    const latestDependencies = new Map()
    for (const record of receiptRecords) {
      const receipt = record?.receipt
      if (receipt?.phase !== 'work' || !dependencies.has(receipt.workItemId)) continue
      latestDependencies.set(receipt.workItemId, record)
    }
    const dependencyArtifacts = [...latestDependencies.values()]
      .sort((left, right) => String(left.receipt.workItemId)
        .localeCompare(String(right.receipt.workItemId)))
      .flatMap(record => (record.receipt.artifactIds || []).map((artifactId, index) => ({
        artifactId,
        index,
        receipt: record.receipt,
      })))
      .map(({ artifactId, index, receipt }) => {
        let identity
        try { identity = this.v4ArtifactIdentity(artifactId) } catch {
          throw new Error('LOCAL_RUN_V4_REFERENCE_INVALID')
        }
        const mediaType = String(identity.artifact.contentRef?.mediaType || '')
        const raw = String(identity.content || '').trim()
        const body = mediaType === 'text/plain'
          ? this.v4SanitizeDeliveryText(raw, Number.MAX_SAFE_INTEGER)
          : ''
        let omission = ''
        if (mediaType !== 'text/plain') {
          omission = `${artifactId} reason=non-text mediaType=${mediaType || 'unknown'}`
        } else if (!raw) {
          omission = `${artifactId} reason=empty`
        } else if (body !== raw) {
          omission = `${artifactId} reason=safety-filter`
        }
        return {
          key: `${receipt.workItemId}:${index}`,
          artifactId,
          body,
          omission,
          header: `Artifact ${artifactId} from ${receipt.agentKind} work=${receipt.workItemId}`,
        }
      })
    const render = (included) => {
      const lines = [
        'MELDWORK_V4_AGREED_WORK_PACKAGE_V1',
        `Responsibility plan: ${coordinationPlan.planHash}`,
        `Work item: ${assignment.taskId}`,
        `Owner: ${assignment.ownerKind}`,
        `Role: ${assignment.role}`,
        `Input refs: ${assignment.inputRefs.length ? assignment.inputRefs.join(', ') : '(none)'}`,
        `Artifact refs: ${assignment.artifactIds.length ? assignment.artifactIds.join(', ') : '(none)'}`,
        `Dependencies: ${assignment.dependsOn.length ? assignment.dependsOn.join(', ') : '(none)'}`,
      ]
      if (inputReferences.length) {
        lines.push('MELDWORK_V4_FROZEN_INPUT_REFS_V1')
        for (const reference of inputReferences) {
          lines.push(reference.header)
          const body = included.get(`direct:${reference.kind}:${reference.id}`) || ''
          if (body) lines.push(body)
        }
      }
      if (directArtifacts.length) {
        lines.push('MELDWORK_V4_DIRECT_ARTIFACT_REFS_V1')
        for (const reference of directArtifacts) {
          lines.push(reference.header)
          const body = included.get(`direct:${reference.kind}:${reference.id}`) || ''
          if (body) lines.push(body)
        }
      }
      if (dependencyArtifacts.length) {
        lines.push('MELDWORK_V4_REFERENCED_ARTIFACTS_V1')
        for (const artifact of dependencyArtifacts) {
          lines.push(artifact.header)
          const body = included.get(`dependency:${artifact.key}`) || ''
          if (body) lines.push(body)
        }
      }
      const objective = included.get('objective') || ''
      const expectedOutput = included.get('expectedOutput') || ''
      lines.push(`Objective: ${objective}`, `Expected output: ${expectedOutput}`)
      const freeTextOmissions = [
        ...(objective.length < assignment.objective.length ? ['objective reason=budget'] : []),
        ...(expectedOutput.length < assignment.expectedOutput.length
          ? ['expectedOutput reason=budget'] : []),
      ]
      if (freeTextOmissions.length) {
        lines.push('MELDWORK_V4_TRUNCATED_FREE_TEXT_V1', ...freeTextOmissions)
      }
      const directOmissions = directReferences.filter(reference => (
        (included.get(`direct:${reference.kind}:${reference.id}`) || '').length
          < reference.body.length
      )).map(reference => `${reference.kind} ${reference.id} reason=budget`)
      if (directOmissions.length) {
        lines.push('MELDWORK_V4_OMITTED_DIRECT_REFERENCE_BODIES_V1', ...directOmissions)
      }
      const dependencyOmissions = dependencyArtifacts.flatMap((artifact) => {
        if (artifact.omission) return [artifact.omission]
        return (included.get(`dependency:${artifact.key}`) || '').length < artifact.body.length
          ? [`${artifact.artifactId} reason=budget`]
          : []
      })
      if (dependencyOmissions.length) {
        lines.push('MELDWORK_V4_OMITTED_ARTIFACT_BODIES_V1', ...dependencyOmissions)
      }
      return lines.join('\n')
    }
    const maximum = Number.isSafeInteger(limit) && limit >= 0 ? limit : 6000
    const fullIncluded = new Map([
      ['objective', assignment.objective],
      ['expectedOutput', assignment.expectedOutput],
      ...directReferences.map(reference => [
        `direct:${reference.kind}:${reference.id}`, reference.body,
      ]),
      ...dependencyArtifacts.filter(artifact => artifact.body).map(artifact => [
        `dependency:${artifact.key}`, artifact.body,
      ]),
    ])
    const full = render(fullIncluded)
    if (full.length <= maximum) return full
    const bodyFields = [...fullIncluded.entries()]
    const bodyLineCount = directReferences.length
      + dependencyArtifacts.filter(artifact => artifact.body).length
    let remaining = maximum - render(new Map()).length - bodyLineCount
    if (remaining < 0) throw new Error('LOCAL_RUN_V4_DELIVERY_BUDGET_EXCEEDED')
    const included = new Map()
    let pendingFields = bodyFields.length
    for (const [key, body] of bodyFields) {
      const share = pendingFields > 0 ? Math.floor(remaining / pendingFields) : 0
      const value = body.slice(0, Math.max(0, share))
      included.set(key, value)
      remaining -= value.length
      pendingFields -= 1
    }
    const result = render(included)
    if (result.length > maximum) throw new Error('LOCAL_RUN_V4_DELIVERY_BUDGET_EXCEEDED')
    return result
  }

  v4CheckpointRole(phase, slot, coordinationPlan, workAssignment = null) {
    if (['proposal', 'discussion', 'challenge'].includes(phase)) return 'participant'
    const assignment = phase === 'work'
      ? (workAssignment || this.v4CoordinationAssignment(coordinationPlan, slot.agentKind))
      : (phase === 'synthesis'
        ? this.v4CoordinationAssignment(coordinationPlan, slot.agentKind, { role: 'integrator' })
          || this.v4CoordinationAssignment(coordinationPlan, slot.agentKind)
        : this.v4CoordinationAssignment(coordinationPlan, slot.agentKind))
    if (phase === 'verification') {
      if (coordinationPlan?.verifierKinds?.includes(slot.agentKind)) return 'verifier'
      return assignment?.role || 'writer'
    }
    return assignment?.role || 'writer'
  }

  v4PromptRole(phase, kind, coordinationPlan, workAssignment = null) {
    if (['proposal', 'discussion', 'challenge'].includes(phase)) return 'participant'
    if (phase === 'verification') {
      if (!coordinationPlan?.verifierKinds?.includes(kind)) {
        throw new Error('LOCAL_RUN_V4_COORDINATION_PLAN_INVALID')
      }
      return 'verifier'
    }
    const assignment = phase === 'work'
      ? workAssignment
      : (phase === 'synthesis'
        ? this.v4CoordinationAssignment(coordinationPlan, kind, { role: 'integrator' })
          || this.v4CoordinationAssignment(coordinationPlan, kind)
        : this.v4CoordinationAssignment(coordinationPlan, kind))
    if (!assignment) throw new Error('LOCAL_RUN_V4_COORDINATION_PLAN_INVALID')
    return assignment.role
  }

  v4BlackboardOwner(coordinationPlan, kind) {
    const assignment = this.v4CoordinationAssignment(coordinationPlan, kind, { role: 'integrator' })
      || this.v4CoordinationAssignment(coordinationPlan, kind)
    if (!assignment) {
      throw new Error('LOCAL_RUN_V4_COORDINATION_PLAN_INVALID')
    }
    return {
      type: 'agent',
      agentKind: kind,
      role: assignment.role,
    }
  }

  v4ArtifactContext(
    receiptRecords, phase, coordinationPlan, kind, limit = 3600, workTaskId = '',
  ) {
    let selected = []
    if (phase === 'work') {
      const assignment = this.v4CoordinationAssignment(
        coordinationPlan, kind, { taskId: workTaskId },
      )
      const dependencies = new Set(assignment?.dependsOn || [])
      selected = receiptRecords.filter(record => (
        record?.receipt?.phase === 'work' && dependencies.has(record.receipt.workItemId)
      ))
    } else if (phase === 'synthesis') {
      const workItems = new Set(coordinationPlan?.assignments?.map(item => item.taskId) || [])
      selected = receiptRecords.filter(record => (
        record?.receipt?.phase === 'work' && workItems.has(record.receipt.workItemId)
      ))
    } else if (phase === 'verification') {
      const latest = this.v4LatestReceipt(receiptRecords, 'synthesis')
      selected = latest ? [latest] : []
    }
    const latestByKey = new Map()
    for (const record of selected) {
      const receipt = record.receipt
      const key = receipt.workItemId || `${receipt.phase}:${receipt.agentKind}`
      latestByKey.set(key, record)
    }
    const records = [...latestByKey.values()].sort((left, right) => (
      String(left.receipt.workItemId || left.receipt.agentKind)
        .localeCompare(String(right.receipt.workItemId || right.receipt.agentKind))
    ))
    if (!records.length) return ''
    const artifacts = records.flatMap((record, recordIndex) => {
      const receipt = record.receipt
      return (receipt.artifactIds || []).map((artifactId, artifactIndex) => ({
        key: `${recordIndex}:${artifactIndex}`,
        artifactId,
        receipt,
      }))
    }).map(({ key, artifactId, receipt }) => {
      let identity
      try { identity = this.v4ArtifactIdentity(artifactId) } catch {
        throw new Error('LOCAL_RUN_V4_REFERENCE_INVALID')
      }
      const mediaType = String(identity.artifact.contentRef?.mediaType || '')
      const raw = String(identity.content || '').trim()
      const body = mediaType === 'text/plain'
        ? this.v4SanitizeDeliveryText(raw, Number.MAX_SAFE_INTEGER)
        : ''
      return {
        key,
        artifactId,
        receipt,
        mediaType,
        raw,
        body,
        header: `Artifact ${artifactId} from ${receipt.agentKind} work=${receipt.workItemId || receipt.phase}`,
      }
    })
    if (!artifacts.length) return ''
    const maximum = Number.isSafeInteger(limit) && limit >= 0 ? limit : 3600
    const textArtifacts = artifacts.filter(artifact => artifact.mediaType === 'text/plain'
      && artifact.body)
    const fixedOmissions = artifacts.flatMap((artifact) => {
      if (artifact.mediaType !== 'text/plain') {
        return [`${artifact.artifactId} reason=non-text mediaType=${artifact.mediaType || 'unknown'}`]
      }
      if (!artifact.raw) return [`${artifact.artifactId} reason=empty`]
      return artifact.body === artifact.raw
        ? []
        : [`${artifact.artifactId} reason=safety-filter`]
    })
    const potentialBudgetOmissions = textArtifacts.map(artifact => (
      `${artifact.artifactId} reason=budget`
    ))
    const structuralLines = [
      'MELDWORK_V4_REFERENCED_ARTIFACTS_V1',
      ...artifacts.map(artifact => artifact.header),
    ]
    const reservedManifest = [...fixedOmissions, ...potentialBudgetOmissions]
    const reservedLines = reservedManifest.length
      ? [...structuralLines, 'MELDWORK_V4_OMITTED_ARTIFACT_BODIES_V1', ...reservedManifest]
      : structuralLines
    const bodySeparators = textArtifacts.length
    const bodyBudget = maximum - reservedLines.join('\n').length - bodySeparators
    if (bodyBudget < 0) throw new Error('LOCAL_RUN_V4_DELIVERY_BUDGET_EXCEEDED')
    let remaining = bodyBudget
    let remainingArtifacts = textArtifacts.length
    const includedByKey = new Map()
    for (const artifact of textArtifacts) {
      const share = remainingArtifacts > 0 ? Math.floor(remaining / remainingArtifacts) : 0
      const included = artifact.body.slice(0, Math.max(0, share))
      includedByKey.set(artifact.key, included)
      remaining -= included.length
      remainingArtifacts -= 1
    }
    const budgetOmissions = textArtifacts.filter(artifact => (
      includedByKey.get(artifact.key).length < artifact.body.length
    )).map(artifact => `${artifact.artifactId} reason=budget`)
    const lines = ['MELDWORK_V4_REFERENCED_ARTIFACTS_V1']
    for (const artifact of artifacts) {
      lines.push(artifact.header)
      const included = includedByKey.get(artifact.key) || ''
      if (included) lines.push(included)
    }
    const omissions = [...fixedOmissions, ...budgetOmissions]
    if (omissions.length) {
      lines.push('MELDWORK_V4_OMITTED_ARTIFACT_BODIES_V1', ...omissions)
    }
    const result = lines.join('\n')
    if (result.length > maximum) throw new Error('LOCAL_RUN_V4_DELIVERY_BUDGET_EXCEEDED')
    return result
  }

  v4DeliveryPrompt(group, controller, input) {
    const {
      kind, phase, snapshot, receiptRecords, role, targetKinds, slot, options,
      sessionBinding, skillHints = [],
    } = input
    const full = sessionBinding.sessionRotated === true || sessionBinding.hasSession !== true
    const packageFloor = phase === 'proposal' ? 0 : collaborationPackageIndexText(targetKinds).length
    let remaining = 6000 - packageFloor
    let assignedProposalText = phase === 'challenge'
      ? this.v4SanitizeDeliveryText(options.assignedProposalText || '', 1600)
      : ''
    if (assignedProposalText) {
      remaining = Math.max(0, remaining - 2)
      assignedProposalText = assignedProposalText.slice(0, remaining)
      remaining -= assignedProposalText.length
    }
    const rawExtraContext = String(options.extraContext || '').trim()
    const requestedExtraContext = this.v4SanitizeDeliveryText(rawExtraContext, 6000)
    const artifactContextPlan = options.artifactContext?.coordinationPlan || null
    const structuredArtifactContext = ['synthesis', 'verification'].includes(phase)
      && options.artifactContext && typeof options.artifactContext === 'object'
      && !Array.isArray(options.artifactContext)
    if ((phase === 'work' || structuredArtifactContext) && rawExtraContext.length > 6000) {
      throw new Error('LOCAL_RUN_V4_DELIVERY_BUDGET_EXCEEDED')
    }
    if ((phase === 'work' || structuredArtifactContext)
        && requestedExtraContext !== rawExtraContext) {
      throw new Error('LOCAL_RUN_V4_ASSIGNMENT_REFERENCE_INVALID')
    }
    const extraLimit = Math.max(0, remaining - 2)
    let extraContext = requestedExtraContext
    if (structuredArtifactContext) {
      const artifactLimit = extraLimit - (extraContext ? extraContext.length + 2 : 0)
      const artifactContext = this.v4ArtifactContext(
        receiptRecords,
        phase,
        artifactContextPlan,
        kind,
        Math.max(0, artifactLimit),
      )
      extraContext = [extraContext, artifactContext].filter(Boolean).join('\n\n')
      if (extraContext.length > extraLimit) {
        throw new Error('LOCAL_RUN_V4_DELIVERY_BUDGET_EXCEEDED')
      }
    } else if (extraContext.length > extraLimit) {
      if (phase === 'work') throw new Error('LOCAL_RUN_V4_DELIVERY_BUDGET_EXCEEDED')
      const marker = 'MELDWORK_V4_CONTEXT_TRUNCATED_V1'
      if (extraLimit <= marker.length + 1) {
        extraContext = ''
      } else {
        let prefix = extraContext.slice(0, extraLimit - marker.length - 1)
        const boundary = prefix.lastIndexOf('\n')
        if (boundary > 0) prefix = prefix.slice(0, boundary)
        extraContext = `${prefix.trimEnd()}\n${marker}`
      }
    }
    if (extraContext) remaining -= extraContext.length + 2
    const packageRecord = phase === 'proposal'
      ? null
      : this.v4Package(receiptRecords, {
          recipientKind: kind,
          sessionBinding,
          deliveryState: controller.orchestration?.deliveryState || [],
          targetKinds,
          snapshotHash: controller.orchestration?.snapshotHash,
          forceFull: full,
          totalLimit: packageFloor + remaining,
        })
    const deliveryId = `delivery-${hashValue({
      runId: controller.runId, recipientKind: kind, slotId: slot.slotId,
      operationId: slot.operationId, packageHash: packageRecord?.packageHash || '', now: Date.now(),
    }).slice(0, 64)}`
    const delivery = packageRecord?.receipts?.length ? {
      deliveryId,
      packageHash: packageRecord.packageHash,
      entries: packageRecord.receipts.map(receipt => ({
        recipientKind: kind,
        sessionRefHash: sessionBinding.sessionRefHash,
        sessionProvenanceHash: sessionBinding.sessionProvenanceHash,
        sourceAgentKind: receipt.agentKind,
        sourcePhase: receipt.phase,
        watermark: receipt.deliveryWatermark,
        snapshotHash: receipt.snapshotHash,
        operationId: receipt.operationId,
        packageHash: packageRecord.packageHash,
        deliveryId,
        status: 'prepared',
        updatedAt: Date.now(),
      })),
    } : null
    this.v4PrepareDelivery(group, controller, delivery)
    return {
      prompt: this.v4PhasePrompt(group, kind, phase, snapshot, receiptRecords, role, {
        reviewTarget: options.reviewTarget,
        assignedProposalText,
        packageText: packageRecord?.text || '',
        extraContext,
        snapshotHash: controller.orchestration?.snapshotHash,
        skillHints,
      }),
      delivery,
    }
  }

  v4PrepareDelivery(group, controller, delivery) {
    if (delivery) {
      const replaced = new Set(delivery.entries.map(entry => [
        entry.recipientKind, entry.sessionRefHash, entry.sessionProvenanceHash,
        entry.sourceAgentKind, entry.sourcePhase,
      ].join('\u0000')))
      const deliveryState = [
        ...(controller.orchestration?.deliveryState || []).filter(entry => (
          (!delivery.natural || entry.recipientKind !== delivery.entries[0].recipientKind
            || (entry.sessionRefHash === delivery.entries[0].sessionRefHash
              && entry.sessionProvenanceHash === delivery.entries[0].sessionProvenanceHash))
          && !replaced.has([
          entry.recipientKind, entry.sessionRefHash, entry.sessionProvenanceHash,
          entry.sourceAgentKind, entry.sourcePhase,
        ].join('\u0000')))),
        ...delivery.entries,
      ].sort((left, right) => [
        left.recipientKind, left.sessionRefHash, left.sessionProvenanceHash,
        left.sourceAgentKind, left.sourcePhase,
      ].join('\u0000').localeCompare([
        right.recipientKind, right.sessionRefHash, right.sessionProvenanceHash,
        right.sourceAgentKind, right.sourcePhase,
      ].join('\u0000')))
      this.checkpointOrchestration(group, controller, { deliveryState })
    }
  }

  v4SetDeliveryStatus(group, controller, delivery, status, binding = null) {
    if (!delivery?.entries?.length) return
    const deliveryState = (controller.orchestration?.deliveryState || []).map(entry => {
      const matched = delivery.entries.some(candidate => candidate.deliveryId === entry.deliveryId
        && candidate.sourceAgentKind === entry.sourceAgentKind
        && candidate.sourcePhase === entry.sourcePhase
        && entry.status === 'prepared')
      let sourceMessages = entry.sourceMessages
      if (matched && sourceMessages && status === 'acknowledged'
          && binding?.sessionRefHash === entry.sessionRefHash
          && binding?.sessionProvenanceHash === entry.sessionProvenanceHash) {
        const previous = delivery.previousEntries?.find(candidate => (
          candidate.sourceAgentKind === entry.sourceAgentKind
          && candidate.sourcePhase === entry.sourcePhase
        ))
        sourceMessages = [...new Map([
          ...(previous?.sourceMessages || []), ...sourceMessages,
        ].map(message => [message.id, message])).values()].slice(-100)
      }
      return matched ? {
        ...entry,
        ...(sourceMessages ? { sourceMessages } : {}),
        ...(binding ? {
          sessionRefHash: binding.sessionRefHash,
          sessionProvenanceHash: binding.sessionProvenanceHash,
        } : {}),
        status,
        updatedAt: Date.now(),
      } : entry
    }).sort((left, right) => [
      left.recipientKind, left.sessionRefHash, left.sessionProvenanceHash,
      left.sourceAgentKind, left.sourcePhase,
    ].join('\u0000').localeCompare([
      right.recipientKind, right.sessionRefHash, right.sessionProvenanceHash,
      right.sourceAgentKind, right.sourcePhase,
    ].join('\u0000')))
    this.checkpointOrchestration(group, controller, { deliveryState })
  }

  v4ChallengeTarget(kind, targetKinds, round = 1, seed = '') {
    const kinds = Array.isArray(targetKinds) ? targetKinds : []
    const index = kinds.indexOf(kind)
    if (index < 0 || kinds.length < 2) return ''
    const digest = createHash('sha256').update(JSON.stringify([seed, round, kinds])).digest('hex')
    const offset = 1 + (Number.parseInt(digest.slice(0, 8), 16) % (kinds.length - 1))
    return kinds[(index + offset) % kinds.length] || ''
  }

  v4ChallengeBindings({ controller, targetKinds, round, snapshotRecord, slots, receiptRecords }) {
    const kinds = [...new Set(Array.isArray(targetKinds) ? targetKinds : [])].sort()
    if (kinds.length < 2 || !Number.isSafeInteger(round) || round < 2) {
      throw new Error('LOCAL_RUN_V4_CHALLENGE_BINDING_INVALID')
    }
    const digest = createHash('sha256').update(JSON.stringify([
      snapshotRecord?.bodyHash || '', kinds,
    ])).digest('hex')
    const initialOffset = 1 + (Number.parseInt(digest.slice(0, 8), 16) % (kinds.length - 1))
    const offset = 1 + ((initialOffset - 1 + (round - 2)) % (kinds.length - 1))
    const slotsByKind = new Map(slots.map(slot => [slot.agentKind, slot]))
    const proposalsByKind = new Map()
    for (const record of receiptRecords) {
      const receipt = record?.receipt
      if (receipt?.phase === 'proposal' && kinds.includes(receipt.agentKind)) {
        proposalsByKind.set(receipt.agentKind, receipt)
      }
    }
    return kinds.map((reviewerKind, index) => {
      const proposalKind = kinds[(index + offset) % kinds.length]
      const reviewerSlot = slotsByKind.get(reviewerKind)
      const proposalSlot = slotsByKind.get(proposalKind)
      const proposalReceipt = proposalsByKind.get(proposalKind)
      if (!reviewerSlot || !proposalSlot || !proposalReceipt) {
        throw new Error('LOCAL_RUN_V4_CHALLENGE_BINDING_INVALID')
      }
      return {
        round,
        reviewerKind,
        reviewerSlotId: reviewerSlot.slotId,
        reviewerOperationId: this.v4OperationId(
          controller, reviewerKind, 'challenge', reviewerSlot.slotId,
        ),
        proposalKind,
        proposalSlotId: proposalSlot.slotId,
        proposalOperationId: proposalReceipt.operationId,
        proposalReceiptId: proposalReceipt.receiptId,
        artifactIds: [...(proposalReceipt.artifactIds || [])],
        evidenceIds: [...(proposalReceipt.evidenceIds || [])],
      }
    })
  }

  v4PhasePrompt(group, kind, phase, snapshot, receiptRecords, role, options = {}) {
    const collaborationPackage = phase === 'proposal'
      ? ''
      : String(options.packageText || this.v4Package(receiptRecords, {
          recipientKind: kind,
          forceFull: options.forceFullPackage === true,
          snapshotHash: options.snapshotHash,
        }).text)
    const reviewTarget = phase === 'challenge' ? String(options.reviewTarget || '') : ''
    const assignedProposalText = phase === 'challenge'
      ? this.v4SanitizeDeliveryText(options.assignedProposalText || '', 1600) : ''
    const extraContext = this.v4SanitizeDeliveryText(options.extraContext || '', 6000)
    return [
      v4Prompt({
        group, kind, phase, snapshot, role, skillHints: options.skillHints,
        naturalResponse: this.naturalAgentResponses,
      }),
      reviewTarget
        ? `Coverage responsibility: explicitly incorporate or challenge ${reviewTarget}'s proposal while negotiating with every peer. This coverage duty does not assign responsibilities or authorize you to allocate work for others.`
        : '',
      assignedProposalText,
      collaborationPackage
        ? `Selected records from completed phases:\n${collaborationPackage}`
        : '',
      extraContext,
    ].filter(Boolean).join('\n\n')
  }

  v4NaturalMessageMatchesBinding(message, controller) {
    const phase = String(message?.trace?.phase || '')
    const kind = String(message?.agentKind || '')
    const round = Number(message?.trace?.round) || 0
    if (!['proposal', 'discussion'].includes(phase) || !kind || round < 1) return false
    if (message.trace?.runId !== controller.runId) return false
    const slot = controller.orchestration?.slots?.find(candidate => candidate.agentKind === kind)
    const snapshotHash = String(controller.orchestration?.snapshotHash || '')
    if (!slot?.slotId || !snapshotHash) return false
    const operationPhase = phase === 'discussion' ? `discussion:${round}` : phase
    const expectedOperationId = this.v4OperationId(
      controller, kind, operationPhase, slot.slotId, round,
    )
    return message.trace?.context?.operationId === expectedOperationId
      && message.trace?.context?.snapshotHash === snapshotHash
  }

  v4NaturalMessageContent(message) {
    const text = String(message.content || '')
    if (text.length < MAX_MESSAGE_TEXT_CHARS && message.trace?.truncated !== true) {
      return { text, partial: false }
    }
    for (const artifactId of message.trace?.context?.outcomeRefs?.artifactIds || []) {
      try {
        const { artifact, content } = this.v4ArtifactIdentity(artifactId)
        if (artifact.name !== `${message.agentKind}-conclusion.txt`
            || artifact.producedBy?.runId !== message.trace?.runId
            || artifact.producedBy?.agentRunId !== message.trace?.agentRunId
            || artifact.producedBy?.agentKind !== message.agentKind
            || !content.startsWith(text)) continue
        return { text: content, partial: false }
      } catch { /* Historical blobs may be unavailable; identify the excerpt below. */ }
    }
    return { text, partial: true }
  }

  v4NaturalThreadEntries(group, threadRootId, options = {}) {
    const rounds = Array.isArray(options.rounds) ? new Set(options.rounds) : null
    const entries = this.state().messages.filter(message => (
      message.groupId === group.id
      && message.threadRootId === threadRootId
      && message.role === 'agent'
      && message.agentKind
      && (!rounds || rounds.has(Number(message.trace?.round) || 0))
      && (!options.controller || this.v4NaturalMessageMatchesBinding(
        message, options.controller,
      ))
    )).map(message => ({
      ...this.v4NaturalMessageContent(message),
      id: message.id,
      agentKind: message.agentKind,
      round: Number(message.trace?.round) || 0,
      phase: message.trace?.phase || 'proposal',
      operationId: message.trace?.context?.operationId || '',
    })).map(entry => ({
      ...entry, text: this.v4SanitizeDeliveryText(entry.text, Number.MAX_SAFE_INTEGER),
    }))
    return entries.map(entry => ({ ...entry, hash: hashValue(entry) }))
  }

  v4NaturalThreadTranscript(group, threadRootId, options = {}) {
    return packNaturalDiscussionTranscript(this.v4NaturalThreadEntries(group, threadRootId, options))
  }

  v4NaturalDeliveryPrompt(group, controller, threadRootId, kind, slot, binding, promptBuilder) {
    const entries = this.v4NaturalThreadEntries(group, threadRootId, { controller })
    const previousEntries = binding.hasSession && !binding.sessionRotated
      ? (controller.orchestration?.deliveryState || []).filter(entry => (
          entry.recipientKind === kind && entry.status === 'acknowledged'
          && entry.sessionRefHash === binding.sessionRefHash
          && entry.sessionProvenanceHash === binding.sessionProvenanceHash
          && entry.snapshotHash === controller.orchestration.snapshotHash
          && entry.sourceMessages
        ))
      : []
    const seen = new Set(previousEntries.flatMap(entry => entry.sourceMessages.map(message => (
      [entry.sourceAgentKind, entry.sourcePhase, message.id, message.hash].join('\u0000')
    ))))
    const unseen = entries.filter(entry => !seen.has([
      entry.agentKind, entry.phase, entry.id, entry.hash,
    ].join('\u0000')))
    const packed = packNaturalDiscussionTranscript(unseen, {
      withEntries: true,
      prefix: unseen.length < entries.length
        ? 'Previously delivered turns are not repeated here. They were supplied to this native session; ask peers to restate missing evidence if your current context is incomplete. Their omission does not imply agreement or task completion.'
        : '',
    })
    const included = new Set(packed.completeMessageIds)
    const sources = new Map()
    for (const entry of unseen) {
      if (!included.has(entry.id)) continue
      const key = `${entry.agentKind}\u0000${entry.phase}`
      const source = sources.get(key) || {
        sourceAgentKind: entry.agentKind, sourcePhase: entry.phase,
        watermark: 0, operationId: entry.operationId, sourceMessages: [],
      }
      source.watermark = Math.max(source.watermark, entry.round)
      source.sourceMessages.push({ id: entry.id, hash: entry.hash })
      sources.set(key, source)
    }
    const packageHash = hashValue(packed.text)
    const deliveryId = `delivery-${hashValue({
      runId: controller.runId, kind, operationId: slot.operationId,
      packageHash, binding, now: Date.now(),
    })}`
    const delivery = sources.size ? {
      natural: true, previousEntries, packageHash, deliveryId,
      entries: [...sources.values()].map(source => ({
        ...source, recipientKind: kind,
        sessionRefHash: binding.sessionRefHash,
        sessionProvenanceHash: binding.sessionProvenanceHash,
        snapshotHash: controller.orchestration.snapshotHash,
        packageHash, deliveryId, status: 'prepared', updatedAt: Date.now(),
      })),
    } : null
    this.v4PrepareDelivery(group, controller, delivery)
    return { prompt: promptBuilder(packed.text), delivery }
  }

  v4NaturalRecoveredPhaseResult(group, controller, threadRootId, phase, kind, slot) {
    if (!this.naturalAgentResponses || !slot || controller.currentRound < 1) return null
    if (!['proposal', 'discussion'].includes(phase)) return null
    const operationId = String(slot.operationId || '')
    const snapshotHash = String(slot.snapshotHash || '')
    if (!operationId || !snapshotHash) return null
    const matchesBinding = context => (
      context?.operationId === operationId && context?.snapshotHash === snapshotHash
    )
    const scopedMessages = [...this.state().messages].reverse().filter(message => (
      message.groupId === group.id
      && message.threadRootId === threadRootId
      && message.role === 'agent'
      && message.agentKind === kind
      && message.trace?.runId === controller.runId
      && message.trace?.phase === phase
      && Number(message.trace?.round) === controller.currentRound
    ))
    if (scopedMessages.some(message => !matchesBinding(message.trace?.context))) {
      throw new Error('LOCAL_RUN_COLLABORATION_SCOPE_INVALID')
    }
    const existingMessage = scopedMessages.find(message => matchesBinding(message.trace?.context))
    let content = String(existingMessage?.content || '')
    let trace = existingMessage?.trace || null
    let metadata = existingMessage ? {
      ...(existingMessage.elapsedMs != null ? { elapsedMs: existingMessage.elapsedMs } : {}),
      ...(Array.isArray(existingMessage.toolCalls) ? { toolCalls: existingMessage.toolCalls } : {}),
      ...(Array.isArray(existingMessage.attachments)
        ? { attachments: existingMessage.attachments } : {}),
      ...(existingMessage.responseVersionRootId
        ? { responseVersionRootId: existingMessage.responseVersionRootId } : {}),
      trace,
    } : null
    if (!content || !trace?.agentRunId) {
      const scopedRuns = [...(controller.harness?.snapshot?.() || [])].reverse().filter(run => (
        run.kind === kind
        && run.round === controller.currentRound
        && run.status === 'completed'
        && String(run.output || '')
      ))
      if (scopedRuns.some(run => !matchesBinding(run.context))) {
        throw new Error('LOCAL_RUN_COLLABORATION_SCOPE_INVALID')
      }
      const recoveredRun = scopedRuns.find(run => matchesBinding(run.context))
      if (!recoveredRun) return null
      content = String(recoveredRun.output)
      trace = traceCapsuleFromAgentRun(recoveredRun, {
        runId: controller.runId,
        status: recoveredRun.status,
        phase,
      })
      if (!trace?.agentRunId) return null
      metadata = { trace }
    }
    return {
      text: content,
      pendingMessage: {
        groupId: group.id,
        role: 'agent',
        content,
        agentKind: kind,
        threadRootId,
        system: null,
        metadata,
      },
      collaboration: trace.context?.taskDecision
        ? { summary: trace.context.taskDecision.reason, taskDecision: trace.context.taskDecision }
        : null,
      outcomeRefs: trace.context?.outcomeRefs || {},
      operationId: slot.operationId,
      consensus: false,
    }
  }

  v4NaturalRecoveredDiscussionResult(group, controller, threadRootId, kind, slot) {
    return this.v4NaturalRecoveredPhaseResult(
      group, controller, threadRootId, 'discussion', kind, slot,
    )
  }

  v4NaturalPhasePrompt(group, kind, phase, snapshot, receiptRecords, activeKinds, options = {}) {
    const transcript = String(options.transcript || '')
    const agentList = activeKinds.map(agentKind => `@${agentKind}`).join(', ')
    const humanResponses = options.runId ? this.taskDecisionResponses(options.runId) : []
    return [
      v4Prompt({
        group, kind, phase, snapshot, role: 'participant',
        skillHints: options.skillHints, naturalResponse: true,
      }),
      transcript ? `Completed peer turns:\n${transcript}` : '',
      humanResponses.length
        ? `Human responses for this task (clarification, not a change to workspace permissions):\n${packNaturalDiscussionTranscript(humanResponses)}`
        : '',
      phase === 'discussion' && options.writerKind
        ? (kind === options.writerKind
          ? 'You are the designated workspace writer for this task. Perform only writes required by the user task within the authorized workspace, and verify the resulting deliverables. Other participants are read-only.'
          : `Workspace writes are assigned to @${options.writerKind}. Your invocation is read-only; request their contribution when a change is needed.`)
        : '',
      phase === 'discussion' && options.ownerKind
        ? [
            `The current delivery owner is @${options.ownerKind}. Ownership starts with the first selected participant and can be handed off explicitly by that owner.`,
            kind === options.ownerKind
              ? [
                  'You are responsible for judging progress against the original user task and the actual available deliverables. Decide whether to continue work, report a blocker, request a human decision, or declare completion. Silence from peers is not evidence of completion. You may continue working yourself; another reviewer is optional.',
                  'In your final collaboration receipt use taskDecision.status completed, continue, blocked or needs-human to judge the whole task. A completed judgment requires actual deliverables. This is your task judgment, not human adoption or independent system verification.',
                  'To hand off responsibility, use status continue and add handoffTo with one exact selected Agent kind inside taskDecision. Do not hand off to an absent participant. Append nothing after the receipt.',
                ].join('\n')
              : 'Contribute freely and request peers when useful. Only the current delivery owner can decide task completion or hand off that responsibility.',
          ].join('\n')
        : '',
      phase === 'discussion' && options.allowRouting === true
        ? [
            'Read the completed peer turns across recent rounds. Decide who should contribute next from their earlier evidence, unresolved questions, and work still needed; do not automatically reply only to whoever last mentioned you.',
            `Address peers naturally inside your explanation: ${agentList}. Put each request beside its concrete question or requested contribution. Prose mentions are discussion only; they do not dispatch peers.`,
            'Selected peers are external Meldwork participants; their @handles are not addresses for your native agent messaging or wait tools. Meldwork dispatches requested peers only after this invocation completes. Put the request in your final response and finish this invocation so they can run; do not wait inside this invocation for their reply.',
            `In taskDecision.nextKinds list the selected Agent identifiers whose contribution you actually request next, chosen from ${JSON.stringify(activeKinds)}, or [] when none is needed. Use status continue for a nonempty list. Multiple kinds request a concurrent batch. Do not request yourself or absent participants. Historical, negated and explanatory mentions do not belong in nextKinds.`,
            'Avoid repeating the same handoff or conclusions. Invite a peer who has not recently contributed when their earlier proposal can resolve the issue, and state what new evidence or decision you need.',
            'Request a peer only when you need their contribution. You may finish your own contribution with nextKinds: []; the delivery owner will judge overall task completion.',
          ].join('\n')
        : '',
      phase === 'discussion'
        ? 'After your natural answer append exactly one receipt: [[MELDWORK_COLLABORATION:{"summary":"concise result","taskDecision":{"status":"continue","reason":"what you accomplished and what remains","deliverables":[],"nextKinds":[]}}]]. This receipt is transport metadata: Meldwork removes it before displaying your answer. User requirements such as exact text, one line, JSON only, or no explanation apply to the visible answer before the receipt; preserve that requested answer exactly and still append the receipt separately. Do not explain the receipt in the visible answer. List actual deliverables when available. Only the current delivery owner judges the whole task; other participants report their contribution and may request peers with nextKinds. Merge any owner judgment or handoffTo into this same receipt. Append nothing after it.'
        : '',
    ].filter(Boolean).join('\n\n')
  }

  v4NaturalDiscussionOperationIds(controller, slots, kinds, round) {
    return new Map(kinds.map((kind) => {
      const slot = slots.find(candidate => candidate.agentKind === kind)
      return [kind, this.v4OperationId(
        controller, kind, `discussion:${round}`, slot?.slotId || '', round,
      )]
    }))
  }

  v4NaturalDiscussionRoundMessages(group, controller, threadRootId, round) {
    return this.state().messages.filter(message => (
      message.groupId === group.id
      && message.threadRootId === threadRootId
      && message.role === 'agent'
      && message.trace?.runId === controller.runId
      && message.trace?.phase === 'discussion'
      && Number(message.trace?.round) === round
      && this.v4NaturalMessageMatchesBinding(message, controller)
    ))
  }

  async runV4SequentialDiscussion(group, controller, threadRootId, context, input) {
    const {
      targetKinds, activeKinds: initialActiveKinds, writerKind, batchId,
      snapshot, snapshotRecord, snapshotHash, slots: initialSlots, receiptRecords,
      checkpointPhase, removePhaseFailures, addRoundLimitNotice,
    } = input
    let activeKinds = [...initialActiveKinds]
    let slots = initialSlots
    let round = Math.max(1, Number(controller.currentRound) || 1)
    let pendingKinds = controller.orchestration?.discussionStyle === 'sequential'
      && controller.orchestration?.phase === 'discussion'
      && controller.orchestration?.round === round
      ? (controller.orchestration.pendingKinds || []).filter(kind => activeKinds.includes(kind))
      : [...activeKinds]
    if (!pendingKinds.length && controller.orchestration?.phase === 'discussion') {
      const outcome = await this.v4NaturalRoundOutcome(group, controller, threadRootId, round, activeKinds)
      if (outcome.status) return outcome.status
      if (!controller.unlimitedRounds && round >= (controller.maxRounds || 6)) {
        addRoundLimitNotice()
        return 'round-limit'
      }
      round += 1
      pendingKinds = outcome.ownerReview ? outcome.nextKinds : [...activeKinds]
    }
    while (!controller.signal.aborted) {
      controller.currentRound = round
      while (pendingKinds.length && !controller.signal.aborted) {
        const kind = pendingKinds[0]
        const remainingKinds = pendingKinds.slice(1)
        const dispatch = await this.runV4Phase(group, controller, threadRootId, context, {
          phase: 'discussion',
          activeKinds: [kind],
          targetKinds,
          participantKinds: activeKinds,
          writerKind,
          batchId,
          snapshot,
          snapshotRecord,
          snapshotHash,
          slots,
          receiptRecords,
          challengeBindings: null,
          coordinationPlan: null,
          workReceipts: [],
          operationIds: this.v4NaturalDiscussionOperationIds(
            controller, slots, [kind], round,
          ),
          pendingKinds,
          remainingKinds,
          sessionPolicy: null,
          resumedGate: input.resumedGate,
          disableDeliveryPrompt: true,
          promptBuilder: ({ kind: promptKind, transcript }) => this.v4NaturalPhasePrompt(
            group, promptKind, 'discussion', snapshot, receiptRecords, activeKinds, {
              runId: controller.runId,
              transcript: transcript ?? this.v4NaturalThreadTranscript(
                group, threadRootId, { controller },
              ),
              skillHints: context.rootSkillsByKind.get(promptKind) || [],
              ownerKind: this.v4NaturalOwner(group, controller, threadRootId),
              writerKind,
              allowRouting: true,
            },
          ),
        })
        slots = dispatch.slots || slots
        if (!dispatch.ok) {
          if (controller.signal.aborted) return terminalRunStatusForReason(controller.stopReason)
          const failedKinds = removePhaseFailures(dispatch)
          activeKinds = activeKinds.filter(agentKind => !failedKinds.includes(agentKind))
          if (!activeKinds.length) {
            return dispatch.phasePendingMessages?.length ? 'partial' : 'failed'
          }
        }
        pendingKinds = remainingKinds.filter(agentKind => activeKinds.includes(agentKind))
      }
      const outcome = await this.v4NaturalRoundOutcome(group, controller, threadRootId, round, activeKinds)
      if (outcome.status) return outcome.status
      if (!controller.unlimitedRounds && round >= (controller.maxRounds || 6)) {
        addRoundLimitNotice()
        return 'round-limit'
      }
      round += 1
      controller.currentRound = round
      pendingKinds = outcome.ownerReview ? outcome.nextKinds : [...activeKinds]
    }
    return terminalRunStatusForReason(controller.stopReason)
  }

  async runV4AgentLedDiscussion(group, controller, threadRootId, context, input) {
    const {
      targetKinds, activeKinds: initialActiveKinds, writerKind, batchId,
      snapshot, snapshotRecord, snapshotHash, slots: initialSlots, receiptRecords,
      latestFor, runPhase, checkpointPhase, removePhaseFailures, addRoundLimitNotice,
    } = input
    let activeKinds = [...initialActiveKinds]
    let slots = initialSlots
    let round = Math.max(1, Number(controller.currentRound) || 1)
    const proposalCompleteBeforeRun = activeKinds.every(kind => Boolean(latestFor('proposal', kind)))
    if (!proposalCompleteBeforeRun) {
      controller.currentRound = 1
      const proposal = await runPhase('proposal', activeKinds)
      slots = proposal.slots || slots
      if (!proposal.ok) {
        const failedKinds = removePhaseFailures(proposal)
        activeKinds = activeKinds.filter(kind => !failedKinds.includes(kind))
        checkpointPhase('proposal', [], slots, null)
        if (!activeKinds.length) return proposal.phasePendingMessages?.length ? 'partial' : 'failed'
      }
    }
    const proposalComplete = activeKinds.every(kind => Boolean(latestFor('proposal', kind)))
    if (!proposalComplete) {
      return activeKinds.some(kind => Boolean(latestFor('proposal', kind))) ? 'partial' : 'failed'
    }
    if (!controller.unlimitedRounds && (controller.maxRounds || 6) <= 1) {
      addRoundLimitNotice()
      return 'round-limit'
    }

    let nextKinds = []
    if (controller.orchestration?.phase === 'discussion') {
      round = Math.max(2, Number(controller.orchestration.round) || 2)
      nextKinds = (controller.orchestration.pendingKinds || [])
        .filter(kind => activeKinds.includes(kind))
      if (!nextKinds.length) {
        if (this.v4NaturalStopRepeatingDiscussion(
          group, controller, threadRootId, round, activeKinds,
        )) return 'partial'
        const outcome = await this.v4NaturalRoundOutcome(group, controller, threadRootId, round, activeKinds)
        if (outcome.status) return outcome.status
        nextKinds = outcome.nextKinds
        if (!controller.unlimitedRounds && round >= (controller.maxRounds || 6)) {
          addRoundLimitNotice()
          return 'round-limit'
        }
        round += 1
      }
    } else {
      round = 2
      // The first discussion round is a full participant round: every selected
      // Agent reacts to the proposal set before the delivery owner reviews and
      // judges completion, so a group run cannot collapse to owner-only turns.
      nextKinds = [...activeKinds]
    }

    while (!controller.signal.aborted) {
      controller.currentRound = round
      const dispatch = await this.runV4Phase(group, controller, threadRootId, context, {
        phase: 'discussion',
        activeKinds: nextKinds,
        targetKinds,
        participantKinds: activeKinds,
        writerKind,
        batchId,
        snapshot,
        snapshotRecord,
        snapshotHash,
        slots,
        receiptRecords,
        challengeBindings: null,
        coordinationPlan: null,
        workReceipts: [],
        operationIds: this.v4NaturalDiscussionOperationIds(
          controller, slots, nextKinds, round,
        ),
        pendingKinds: nextKinds,
        remainingKinds: [],
        sessionPolicy: null,
        resumedGate: input.resumedGate,
        disableDeliveryPrompt: true,
        promptBuilder: ({ kind, transcript }) => this.v4NaturalPhasePrompt(
          group, kind, 'discussion', snapshot, receiptRecords, activeKinds, {
            runId: controller.runId,
            transcript: transcript ?? this.v4NaturalThreadTranscript(group, threadRootId, { controller }),
            skillHints: context.rootSkillsByKind.get(kind) || [],
            allowRouting: true,
            ownerKind: this.v4NaturalOwner(group, controller, threadRootId),
            writerKind,
          },
        ),
      })
      slots = dispatch.slots || slots
      if (!dispatch.ok) {
        if (controller.signal.aborted) return terminalRunStatusForReason(controller.stopReason)
        const failedKinds = removePhaseFailures(dispatch)
        activeKinds = activeKinds.filter(kind => !failedKinds.includes(kind))
        if (!activeKinds.length) return dispatch.phasePendingMessages?.length ? 'partial' : 'failed'
      }
      if (this.v4NaturalStopRepeatingDiscussion(
        group, controller, threadRootId, round, activeKinds,
      )) return 'partial'
      const outcome = await this.v4NaturalRoundOutcome(group, controller, threadRootId, round, activeKinds)
      if (outcome.status) return outcome.status
      nextKinds = outcome.nextKinds
      if (!controller.unlimitedRounds && round >= (controller.maxRounds || 6)) {
        addRoundLimitNotice()
        return 'round-limit'
      }
      round += 1
      controller.currentRound = round
    }
    return terminalRunStatusForReason(controller.stopReason)
  }

  async runV4NaturalDiscussion(group, controller, threadRootId, context, input) {
    if (input.resume && controller.orchestration?.phase === 'discussion') {
      for (const slot of input.slots) {
        if (slot.permission !== 'workspace-write' || !slot.agentRunId
            || slot.commitStatus === 'committed'
            || !['running', 'waiting', 'stopped', 'failed'].includes(slot.status)) continue
        if (this.v4NaturalRecoveredDiscussionResult(group, controller, threadRootId, slot.agentKind, slot)) continue
        if (input.resumedGate?.operationId === slot.operationId
            && input.resumedGate.agentKind === slot.agentKind
            && input.resumedGate.status === 'approved') continue
        if (!this.requestHumanGate) throw new Error('LOCAL_RUN_RETRY_GATE_INVALID')
        const binding = {
          agentRunId: slot.agentRunId, agentKind: slot.agentKind,
          round: controller.currentRound, phase: 'discussion', slotId: slot.slotId,
          operationId: slot.operationId, snapshotHash: input.snapshotHash,
        }
        const request = {
          phase: 'discussion-writer-recovery', batchId: input.batchId,
          slotId: slot.slotId, operationId: slot.operationId, attempt: slot.attempt,
          outcomeCertainty: 'unknown_outcome', sideEffectsPossible: true,
        }
        const gate = await this.requestHumanGate({
          type: 'retry', runId: controller.runId, agentRunId: slot.agentRunId,
          agentKind: slot.agentKind,
          summary: 'The interrupted discussion writer may already have changed the workspace.',
          options: [
            { optionId: 'retry-once', name: 'Retry once', kind: 'allow_once' },
            { optionId: 'cancel-retry', name: 'Do not retry', kind: 'reject_once' },
          ],
          request,
        }, {
          signal: controller.signal,
          preserveOnAbort: () => controller.stopReason === 'shutdown',
          continuation: { resumeKind: 'agent_slot', ...binding },
        })
        if (gate.status !== 'approved') {
          if (this.completeHumanGateContinuation?.(controller.runId, gate.gateId, 'cancelled') !== true
              && this.hasRunLedger()) throw new Error('LOCAL_RUN_PERSIST_FAILED')
          controller.stopReason = 'human_gate_rejected'
          return 'stopped'
        }
        if (gate.optionId !== 'retry-once') throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
        input.resumedGate = { ...binding, gateId: gate.gateId, type: 'retry',
          status: gate.status, optionId: gate.optionId, request, used: false }
      }
    }
    if (input.resumedGate?.type === 'retry'
        && input.resumedGate.request?.phase === 'discussion-writer-recovery') {
      const gate = input.resumedGate
      const slot = input.slots.find(item => item.slotId === gate.slotId)
      if (gate.status !== 'approved' || gate.optionId !== 'retry-once'
          || !slot || slot.agentKind !== gate.agentKind
          || slot.operationId !== gate.operationId
          || slot.snapshotHash !== gate.snapshotHash
          || slot.attempt !== gate.request.attempt) throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
      if (this.completeHumanGateContinuation?.(controller.runId, gate.gateId, 'completed') !== true
          && this.hasRunLedger()) throw new Error('LOCAL_RUN_PERSIST_FAILED')
    }
    const style = controller.orchestration?.discussionStyle
      || controller.discussionStyle
      || 'sequential'
    return style === 'agent-led'
      ? this.runV4AgentLedDiscussion(group, controller, threadRootId, context, input)
      : this.runV4SequentialDiscussion(group, controller, threadRootId, context, input)
  }

  recordV4ReviewerFindings({ controller, phase, kind, result, verdict, summary,
    reviewedArtifactId = '' }) {
    if (!this.outcomeStore || !['challenge', 'verification'].includes(phase)
        || !['support', 'contradict'].includes(verdict) || !reviewedArtifactId) return []
    const trace = result?.pendingMessage?.metadata?.trace || result?.message?.trace || {}
    const runId = String(controller?.runId || '')
    const agentRunId = String(trace.agentRunId || '')
    if (!runId || !agentRunId) return []
    const sourceEvidenceIds = Array.isArray(result?.outcomeRefs?.evidenceIds)
      ? result.outcomeRefs.evidenceIds.filter(value => typeof value === 'string').slice(0, 62)
      : []
    try {
      const { artifact, contentHash } = this.v4ArtifactIdentity(reviewedArtifactId)
      const reviewEvidence = this.outcomeStore.putEvidence({
        kind: 'review',
        level: 'observed',
        subject: { type: 'artifact', artifactId: reviewedArtifactId },
        summary: publicCollaborationText(summary || '', 4000) || 'Agent review recorded.',
        recordedBy: { kind: 'agent', runId, agentRunId, agentKind: kind },
        refs: [
          { type: 'artifact', artifactId: reviewedArtifactId },
          { type: 'blob', contentRef: artifact.contentRef, contentHash },
          ...sourceEvidenceIds.map(evidenceId => ({ type: 'evidence', evidenceId })),
        ],
      })
      const input = {
        artifactId: reviewedArtifactId,
        relation: verdict,
        summary: publicCollaborationText(summary || '', 4000) || 'Agent review recorded.',
        reviewer: { kind: 'agent', runId, agentRunId, agentKind: kind },
        evidenceIds: [reviewEvidence.evidenceId],
      }
      const candidate = createReviewerFindingRecord(input)
      try { return [this.outcomeStore.getReviewerFinding(candidate.reviewerFindingId)] }
      catch { return [this.outcomeStore.putReviewerFinding(candidate)] }
    } catch {
      return []
    }
  }

  v4ReceiptForResult(result, phase, kind, slot, snapshotHash, options = {}) {
    let raw = result?.collaboration
    if ((!raw || typeof raw !== 'object' || Array.isArray(raw))
        && this.naturalAgentResponses && ['proposal', 'discussion'].includes(phase)) {
      const visibleSummary = (publicCollaborationText(
        result?.text || result?.message?.content || '', 800,
      ) || `Completed the ${phase} phase.`).replace(/\s+/gu, ' ').trim()
      raw = {
        summary: visibleSummary,
        capabilities: ['Delivered a natural-language response'],
        intendedWork: ['Addressed the current user task'],
        deliverables: ['Natural-language Markdown response'],
        dependencies: [],
      }
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_REQUIRED')
    }
    const summary = publicCollaborationText(raw.summary || '', 800)
    if (!summary) throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
    const parsedStatus = publicCollaborationText(raw.status || '', 40)
    const status = ['completed', 'accepted', 'continue', 'needs-review', 'rejected']
      .includes(parsedStatus)
      ? parsedStatus
      : 'completed'
    const verdict = publicCollaborationText(raw.verdict || '', 80)
    const deliveryWatermark = (Number(slot.deliveryWatermark) || 0) + 1
    const outcomeRefs = phase === 'work'
      ? (result?.producedOutcomeRefs || {})
      : (result?.outcomeRefs || {})
    const artifactIds = Array.isArray(outcomeRefs.artifactIds)
      ? outcomeRefs.artifactIds.filter(value => typeof value === 'string').slice(0, 64)
      : []
    const evidenceIds = Array.isArray(outcomeRefs.evidenceIds)
      ? outcomeRefs.evidenceIds.filter(value => typeof value === 'string')
        .slice(0, 64)
      : []
    const findingIds = Array.isArray(raw.findingIds)
      ? raw.findingIds.filter(value => typeof value === 'string').slice(0, 64)
      : []
    let unresolved = Array.isArray(raw.unresolved)
      ? raw.unresolved.filter(value => value && typeof value === 'object')
        .slice(0, 32)
        .map(value => ({
          id: publicCollaborationText(value.id || '', 120),
          summary: publicCollaborationText(value.summary || '', 800),
          refs: Array.isArray(value.refs)
            ? value.refs.filter(ref => typeof ref === 'string').slice(0, 64)
            : [],
        }))
        .filter(value => value.id && value.summary)
      : []
    const findings = Array.isArray(raw.findings)
      ? raw.findings.filter(value => value && typeof value === 'object')
        .slice(0, 16)
        .map(value => ({
          kind: publicCollaborationText(value.kind || 'observation', 80) || 'observation',
          summary: publicCollaborationText(value.summary || '', 800),
          ...(value.severity ? { severity: publicCollaborationText(value.severity, 40) } : {}),
          refs: Array.isArray(value.refs)
            ? value.refs.filter(ref => typeof ref === 'string').slice(0, 64)
            : [],
        }))
        .filter(value => value.summary)
      : []
    const listFieldFrom = (value, limit = 32) => Array.isArray(value)
      ? value.filter(item => typeof item === 'string').slice(0, limit)
        .map(item => publicCollaborationText(item, 120))
        .filter(Boolean)
      : []
    const listField = (field, limit = 32) => Array.isArray(raw[field])
      ? raw[field].filter(value => typeof value === 'string').slice(0, limit)
      : []
    const proposedAssignments = Array.isArray(raw.proposedAssignments)
      ? raw.proposedAssignments.filter(value => value && typeof value === 'object').slice(0, 32)
        .map(value => ({
          taskId: publicCollaborationText(value.taskId || '', 120),
          ownerKind: publicCollaborationText(value.ownerKind || '', 120),
          role: publicCollaborationText(value.role || '', 40),
          objective: publicCollaborationText(value.objective || '', 2000),
          expectedOutput: publicCollaborationText(value.expectedOutput || '', 2000),
          inputRefs: listFieldFrom(value.inputRefs, 64),
          artifactIds: listFieldFrom(value.artifactIds, 64),
          dependsOn: listFieldFrom(value.dependsOn, 32),
        }))
        .filter(value => value.taskId && value.ownerKind && value.role
          && value.objective && value.expectedOutput)
      : []
    const reviewerFindings = this.recordV4ReviewerFindings({
      controller: options.controller,
      phase,
      kind,
      result,
      verdict,
      summary,
      reviewedArtifactId: options.reviewedArtifactId || '',
    })
    for (const finding of reviewerFindings) {
      if (finding?.reviewerFindingId && !findingIds.includes(finding.reviewerFindingId)) {
        findingIds.push(finding.reviewerFindingId)
      }
      for (const evidenceId of finding?.evidenceIds || []) {
        if (!evidenceIds.includes(evidenceId) && evidenceIds.length < 64) {
          evidenceIds.push(evidenceId)
        }
      }
    }
    if (['challenge', 'verification'].includes(phase)
        && verdict === 'contradict' && unresolved.length === 0) {
      if (reviewerFindings.length === 0) {
        throw new Error('LOCAL_RUN_V4_REVIEW_FINDING_INVALID')
      }
      unresolved = reviewerFindings.slice(0, 32).map(finding => ({
        id: this.v4IssueId({ receipt: { phase } }, finding.reviewerFindingId),
        summary: publicCollaborationText(finding.summary || summary, 800) || summary,
        refs: [finding.reviewerFindingId],
      }))
    }
    const taskDecision = raw.taskDecision ? parseTaskDecision(raw.taskDecision) : null
    // Public receipts exclude paths; the Agent run retains its original decision.
    if (taskDecision) {
      taskDecision.reason = publicCollaborationText(taskDecision.reason, 1600)
      taskDecision.deliverables = taskDecision.deliverables
        .map(value => publicCollaborationText(value, 800))
    }
    const receipt = createCollaborationReceipt({
      phase,
      agentKind: kind,
      slotId: slot.slotId,
      operationId: slot.operationId,
      status,
      summary,
      conclusion: '',
      ...(taskDecision ? { taskDecision } : {}),
      artifactIds,
      evidenceIds,
      findingIds,
      unresolved,
      findings,
      claims: Array.isArray(raw.claims)
        ? raw.claims.filter(value => typeof value === 'string').slice(0, 16)
        : [],
      refs: Array.isArray(raw.refs)
        ? raw.refs.filter(value => typeof value === 'string').slice(0, 64)
        : [],
      capabilities: listField('capabilities', 32),
      intendedWork: listField('intendedWork', 32),
      deliverables: listField('deliverables', 32),
      dependencies: listField('dependencies', 32),
      proposedAssignments,
      ...(typeof raw.finalizerKind === 'string' && raw.finalizerKind
        ? { finalizerKind: publicCollaborationText(raw.finalizerKind, 120) } : {}),
      ...(Array.isArray(raw.verifierKinds)
        ? {
            verifierKinds: listField(
              'verifierKinds',
              Math.max(1, (options.controller?.targetKinds?.length || 2) - 1),
            ),
          }
        : {}),
      ...(typeof raw.supportedPlanHash === 'string' && raw.supportedPlanHash
        ? { supportedPlanHash: raw.supportedPlanHash } : {}),
      ...(typeof raw.agreeToPlan === 'boolean' ? { agreeToPlan: raw.agreeToPlan } : {}),
      ...(typeof raw.workItemId === 'string' && raw.workItemId
        ? { workItemId: publicCollaborationText(raw.workItemId, 120) } : {}),
      deliveryWatermark,
      snapshotHash,
    })
    const resolvedIssueIds = Array.isArray(raw.resolvedIssueIds)
      ? raw.resolvedIssueIds
        .filter(value => typeof value === 'string')
        .map(value => publicCollaborationText(value, 120))
        .filter(Boolean)
        .slice(0, 32)
      : []
    return {
      receipt,
      verdict,
      resolvedIssueIds,
    }
  }

  v4PhaseSlots({ controller, targetKinds, phase, activeKinds, slots, snapshotHash,
    writerKind, operationIds = null, allowWrite = false, now = Date.now() }) {
    const active = new Set(activeKinds)
    return slots.map((slot, index) => {
      const running = active.has(slot.agentKind)
      const previousHistory = Array.isArray(slot.resultRefs?.workflowOutcomeRefs)
        ? slot.resultRefs.workflowOutcomeRefs
        : []
      const operationId = running
        ? (operationIds?.get(slot.agentKind)
          || this.v4OperationId(controller, slot.agentKind, phase, slot.slotId))
        : slot.operationId
      const { agentRunId: previousAgentRunId, ...retainedSlot } = slot
      return {
        ...retainedSlot,
        ...(!running && operationId === slot.operationId && previousAgentRunId
          ? { agentRunId: previousAgentRunId }
          : {}),
        slotId: slot.slotId || `slot-${index + 1}-${slot.agentKind}`,
        phase: running ? phase : (slot.phase || phase),
        status: running ? 'planned' : (slot.status || 'completed'),
        operationId,
        queuePosition: index,
        snapshotHash,
        deliveryWatermark: Number(slot.deliveryWatermark) || 0,
        receiptId: running ? '' : (slot.receiptId || ''),
        resultHash: running ? '' : (slot.resultHash || ''),
        assignedAt: slot.assignedAt || now,
        startedAt: running ? now : (slot.startedAt || now),
        finishedAt: running ? null : (slot.finishedAt || now),
        commitStatus: running ? 'pending' : (slot.commitStatus || 'committed'),
        attempt: (Number.isSafeInteger(slot.attempt) ? slot.attempt : 0) + (running ? 1 : 0),
        permission: allowWrite && slot.agentKind === writerKind
          && (phase === 'synthesis' || (this.naturalAgentResponses && phase === 'discussion'))
          ? 'workspace-write'
          : 'read-only',
        resultRefs: {
          artifactIds: Array.isArray(slot.resultRefs?.artifactIds)
            ? [...slot.resultRefs.artifactIds]
            : [],
          evidenceIds: Array.isArray(slot.resultRefs?.evidenceIds)
            ? [...slot.resultRefs.evidenceIds]
            : [],
          workflowOutcomeRefs: [...previousHistory],
        },
      }
    })
  }

  v4CheckpointPhase(group, controller, {
    targetKinds, phase, batchId, snapshotRecord, snapshotHash, slots,
    writerKind, currentKinds = [], pendingKinds = [], receipts = [], commitState = null,
    participantKinds = targetKinds,
    challengeBindings = controller.orchestration?.round === controller.currentRound
      ? controller.orchestration?.challengeBindings
      : null,
    synthesisBinding = controller.orchestration?.synthesisBinding || null,
    synthesisRecovery = controller.orchestration?.synthesisRecovery || null,
    convergence = controller.orchestration?.convergence || null,
    coordinationPlan = controller.orchestration?.coordinationPlan || null,
    workReceipts = controller.orchestration?.workReceipts || [],
    candidateCommit = controller.orchestration?.candidateCommit || null,
    workAssignments = [],
  }) {
    const current = controller.orchestration
    const naturalWriterKind = this.naturalAgentResponses && ['proposal', 'discussion'].includes(phase)
      && !coordinationPlan && !synthesisBinding ? writerKind : ''
    if (current?.version === 4
        && (current.phase !== phase || current.round !== controller.currentRound)) {
      this.assertV4PhaseCanAdvance(controller)
    }
    const workAssignmentsByKind = new Map(workAssignments.map(assignment => (
      [assignment.ownerKind, assignment]
    )))
    const assignments = slots.map((slot, index) => ({
      agentKind: slot.agentKind,
      slotId: slot.slotId,
      role: this.v4CheckpointRole(
        phase, slot, coordinationPlan, workAssignmentsByKind.get(slot.agentKind) || null,
      ),
      operationId: slot.operationId,
      objective: phase === 'proposal'
        ? 'Produce an independent bounded proposal.'
        : (phase === 'work' && workAssignmentsByKind.has(slot.agentKind)
          ? workAssignmentsByKind.get(slot.agentKind).objective
          : `Complete the ${phase} collaboration phase using the peer-agreed responsibility plan.`),
      expectedOutput: phase === 'work' && workAssignmentsByKind.has(slot.agentKind)
        ? workAssignmentsByKind.get(slot.agentKind).expectedOutput
        : 'Return a concise structured collaboration result.',
      inputRefs: receipts.map(item => item.receipt?.receiptId).filter(Boolean).slice(-64),
      readOnly: slot.permission !== 'workspace-write',
      index,
    }))
    const plan = {
      version: 1,
      snapshotHash,
      assignments: assignments.map(({ index: _index, ...assignment }) => assignment),
      createdAt: snapshotRecord.capturedAt,
      barrier: 'phase',
    }
    const watermarks = Array.isArray(controller.v4Watermarks)
      ? controller.v4Watermarks
      : []
    const commit = commitState || {
      status: 'pending',
      writerKind: naturalWriterKind ? null : writerKind || null,
      committedKinds: [],
      pendingKinds: [...participantKinds],
      operationId: '',
      attempt: 0,
      updatedAt: Date.now(),
      committedSlotIds: [],
      messageIds: [],
      blackboardEntryIds: [],
    }
    const record = {
      version: 4,
      workflow: 'auto',
      template: 'discussion',
      phase,
      discussionStyle: controller.discussionStyle
        || controller.orchestration?.discussionStyle
        || 'sequential',
      ...(naturalWriterKind ? { discussionWriterKind: naturalWriterKind } : {}),
      batchId,
      round: Math.max(0, Number(controller.currentRound) || 0),
      currentKind: '',
      currentKinds: [...currentKinds],
      pendingKinds: [...pendingKinds],
      activeKinds: [...participantKinds],
      successfulKinds: slots
        .filter(slot => ['completed', 'partial'].includes(slot.status))
        .map(slot => slot.agentKind),
      agreementKinds: [],
      attachmentRecipients: [],
      totalSuccesses: slots.filter(slot => slot.status === 'completed').length,
      terminalFailureOccurred: slots.some(slot => slot.status === 'failed'),
      snapshotHash,
      snapshot: snapshotRecord,
      plan,
      slots,
      deliveryWatermarks: watermarks,
      ...(Array.isArray(controller.orchestration?.deliveryState)
        ? { deliveryState: controller.orchestration.deliveryState.map(entry => ({ ...entry })) }
        : {}),
      commitState: commit,
      ...(candidateCommit ? { candidateCommit: { ...candidateCommit } } : {}),
      collaboration: controller.orchestration?.collaboration || emptyCollaborationState(),
      ...(Array.isArray(challengeBindings)
        ? { challengeBindings: challengeBindings.map(binding => ({
            ...binding,
            artifactIds: [...binding.artifactIds],
            evidenceIds: [...binding.evidenceIds],
          })) }
        : {}),
      ...(synthesisBinding ? {
        synthesisBinding: {
          ...synthesisBinding,
          candidates: synthesisBinding.candidates.map(candidate => ({
            ...candidate,
            ...(candidate.evidence ? { evidence: { ...candidate.evidence } } : {}),
          })),
          verificationKinds: [...synthesisBinding.verificationKinds],
        },
      } : {}),
      ...(synthesisRecovery ? {
        synthesisRecovery: {
          ...synthesisRecovery,
          verificationKinds: [...synthesisRecovery.verificationKinds],
          rankedKinds: [...synthesisRecovery.rankedKinds],
          triedWriters: [...synthesisRecovery.triedWriters],
          attempts: synthesisRecovery.attempts.map(attempt => ({ ...attempt })),
          ...(synthesisRecovery.pendingGate
            ? { pendingGate: { ...synthesisRecovery.pendingGate } }
            : {}),
        },
      } : {}),
      ...(convergence ? { convergence: { ...convergence, openIssueIds: [...convergence.openIssueIds] } } : {}),
      ...(coordinationPlan ? {
        coordinationPlan: {
          ...coordinationPlan,
          assignments: coordinationPlan.assignments.map(assignment => ({ ...assignment })),
          verifierKinds: [...coordinationPlan.verifierKinds],
          agreedBy: [...coordinationPlan.agreedBy],
          ...(coordinationPlan.supportReceiptIds
            ? { supportReceiptIds: [...coordinationPlan.supportReceiptIds] }
            : {}),
        },
      } : {}),
      ...(coordinationPlan ? {
        workReceipts: workReceipts.map(receipt => ({
          ...receipt,
          snapshotContentRef: { ...receipt.snapshotContentRef },
          collaborationReceipt: { ...receipt.collaborationReceipt },
          artifacts: receipt.artifacts.map(artifact => ({
            ...artifact,
            contentRef: { ...artifact.contentRef },
          })),
        })),
      } : {}),
    }
    this.checkpointOrchestration(group, controller, record)
    return record
  }

  completeV4ResumedAgentSlotContinuation(controller, resumedGate) {
    if (!resumedGate?.gateId) return true
    const current = controller.continuation
    const exactBinding = current?.resumeKind === 'agent_slot'
      && current.agentKind === resumedGate.agentKind
      && current.round === resumedGate.round
      && current.phase === resumedGate.phase
      && current.slotId === resumedGate.slotId
      && current.operationId === resumedGate.operationId
      && current.snapshotHash === resumedGate.snapshotHash
    if (current?.gateId === resumedGate.gateId) {
      if (!exactBinding || current.gateType !== resumedGate.type) return false
      if (current.state === 'completed') return true
      if (!['pending', 'ready', 'resuming'].includes(current.state)) return false
      controller.waitingGateIds.delete(resumedGate.gateId)
      controller.continuation = {
        ...current,
        state: 'completed',
        updatedAt: Math.max(Number(current.updatedAt) || 0, Date.now()),
      }
      return true
    }
    return Boolean(
      resumedGate.type === 'permission'
      && current?.gateType === 'permission'
      && current.state === 'completed'
      && exactBinding,
    ) || !this.hasRunLedger()
  }

  commitV4PhaseMessage({ group, controller, threadRootId, phase, kind, pendingMessage }) {
    if (!pendingMessage?.content || !kind) return null
    const agentRunId = pendingMessage.metadata?.trace?.agentRunId || ''
    return this.commitV4AgentMessage({
      messageId: `message-${hashValue({
        agentKind: kind,
        agentRunId,
        phase,
        runId: controller.runId,
        taskId: controller.taskId,
      })}`,
      groupId: group.id,
      agentKind: kind,
      threadRootId,
      content: pendingMessage.content,
      metadata: pendingMessage.metadata || {},
    })
  }

  async runV4ProposalBatch(group, controller, threadRootId, phaseInput) {
    const {
      targetKinds, writerKind, batchId, snapshotRecord, snapshotHash,
      phaseSlots, receiptRecords, dispatches, resumedGate = null,
      participantKinds = targetKinds,
    } = phaseInput
    const phaseReceipts = []
    const phasePendingMessages = []
    const failures = []
    const pendingKinds = () => phaseSlots
      .filter(slot => ['planned', 'queued', 'running', 'waiting'].includes(slot.status))
      .map(slot => slot.agentKind)
    const checkpoint = () => this.v4CheckpointPhase(group, controller, {
      targetKinds,
      phase: 'proposal',
      batchId,
      snapshotRecord,
      snapshotHash,
      slots: phaseSlots,
      writerKind,
      currentKinds: pendingKinds(),
      pendingKinds: pendingKinds(),
      participantKinds,
      receipts: receiptRecords,
    })
    const failSlot = (slot, kind, error) => {
      slot.status = 'failed'
      slot.commitStatus = 'failed'
      slot.finishedAt = Date.now()
      failures.push({ kind, error })
      if (!controller.signal.aborted) {
        this.recordAgentFailure(group.id, kind, error, threadRootId, new Set())
      }
    }

    for (const slot of phaseSlots) {
      if (dispatches.some(dispatch => dispatch.kind === slot.agentKind)) slot.status = 'running'
    }
    const settled = await Promise.all(dispatches.map(async (dispatch) => {
      const { kind, slot, context } = dispatch
      try {
        const recoveredResult = this.v4NaturalRecoveredPhaseResult(
          group, controller, threadRootId, 'proposal', kind, slot,
        )
        const invocation = recoveredResult
          ? { result: recoveredResult }
          : await this.invokeWithUnauthorizedRecovery({
              group,
              kind,
              controller,
              activeKinds: participantKinds,
              threadRootId,
              context: {
                ...context,
                onLeaseAcquired: (leaseState) => {
                  if (!leaseState?.agentRunId) throw new Error('LOCAL_RUN_PERSIST_FAILED')
                  slot.agentRunId = leaseState.agentRunId
                  slot.status = 'running'
                  checkpoint()
                },
              },
            })
        if (controller.signal.aborted) {
          slot.status = 'stopped'
          slot.commitStatus = 'partial'
          slot.finishedAt = Date.now()
          checkpoint()
          return
        }
        const result = invocation.result
        if (!result) {
          failSlot(slot, kind, invocation.error || new Error('LOCAL_AGENT_UNKNOWN_FAILURE'))
          checkpoint()
          return
        }
        const reportedOperationId = result?.message?.trace?.context?.operationId
          || result?.pendingMessage?.metadata?.trace?.context?.operationId
        if (reportedOperationId && reportedOperationId !== slot.operationId) {
          throw new Error('LOCAL_RUN_COLLABORATION_SCOPE_INVALID')
        }
        const receiptRecord = this.v4ReceiptForResult(
          result, 'proposal', kind, slot, snapshotHash, { controller },
        )
        if (!['completed', 'accepted'].includes(receiptRecord.receipt.status)) {
          throw new Error('LOCAL_RUN_COLLABORATION_PROPOSAL_UNSUCCESSFUL')
        }
        const duplicate = receiptRecords.find(existing => (
          existing?.receipt?.receiptId === receiptRecord.receipt.receiptId
        ))
        if (!duplicate) {
          phaseReceipts.push(receiptRecord)
          receiptRecords.push(receiptRecord)
        }
        const effectiveReceiptRecord = duplicate || receiptRecord
        controller.v4ReceiptRecords = receiptRecords
        slot.status = 'completed'
        slot.commitStatus = 'pending'
        slot.finishedAt = Date.now()
        slot.receiptId = effectiveReceiptRecord.receipt.receiptId
        slot.deliveryWatermark = effectiveReceiptRecord.receipt.deliveryWatermark
        slot.resultHash = hashValue(effectiveReceiptRecord.receipt)
        slot.resultRefs = {
          artifactIds: result.outcomeRefs?.artifactIds || [],
          evidenceIds: result.outcomeRefs?.evidenceIds || [],
          workflowOutcomeRefs: [
            ...(slot.resultRefs?.workflowOutcomeRefs || []),
            {
              receipt: effectiveReceiptRecord.receipt,
              ...(effectiveReceiptRecord.verdict
                ? { verdict: effectiveReceiptRecord.verdict }
                : {}),
              ...(effectiveReceiptRecord.resolvedIssueIds.length
                ? { resolvedIssueIds: effectiveReceiptRecord.resolvedIssueIds }
                : {}),
            },
          ],
        }
        const watermark = {
          agentKind: effectiveReceiptRecord.receipt.agentKind,
          phase: effectiveReceiptRecord.receipt.phase,
          watermark: effectiveReceiptRecord.receipt.deliveryWatermark,
          operationId: effectiveReceiptRecord.receipt.operationId,
          snapshotHash: effectiveReceiptRecord.receipt.snapshotHash,
          updatedAt: Date.now(),
        }
        controller.v4Watermarks = [
          ...(controller.v4Watermarks || []).filter(existing => (
            existing.agentKind !== watermark.agentKind || existing.phase !== watermark.phase
          )),
          watermark,
        ]
        if (result.pendingMessage) {
          phasePendingMessages.push({ kind, pendingMessage: result.pendingMessage })
          this.commitV4PhaseMessage({
            group, controller, threadRootId, phase: 'proposal', kind,
            pendingMessage: result.pendingMessage,
          })
          slot.commitStatus = 'committed'
        }
        if (resumedGate?.agentKind === slot.agentKind
            && !this.completeV4ResumedAgentSlotContinuation(controller, resumedGate)) {
          throw new Error('LOCAL_RUN_PERSIST_FAILED')
        }
        checkpoint()
      } catch (error) {
        failSlot(slot, kind, error)
        checkpoint()
      }
    }))
    void settled
    checkpoint()
    controller.currentKind = ''
    controller.progress = []
    controller.completedKinds = [...new Set([
      ...(controller.completedKinds || []),
      ...phaseSlots.filter(slot => slot.status === 'completed').map(slot => slot.agentKind),
    ])]
    controller.failedKinds = [...new Set([
      ...(controller.failedKinds || []),
      ...failures.map(item => item.kind),
    ])]
    this.emitChanged()
    return {
      slots: phaseSlots,
      receiptRecords,
      phaseReceipts,
      failures,
      phasePendingMessages,
      synthesisPendingMessage: null,
      ok: failures.length === 0,
    }
  }

  v4AdmitWorkSettlement(group, controller, threadRootId, item, input) {
    const {
      targetKinds, writerKind, batchId, snapshotRecord, snapshotHash,
      phaseSlots, receiptRecords, challengeBindings, coordinationPlan, workAssignments,
      participantKinds = targetKinds,
    } = input
    const slot = phaseSlots.find(candidate => candidate.agentKind === item.kind)
    const result = item.invocation?.result
    const liveSlot = controller.orchestration?.slots?.find(candidate => (
      candidate.slotId === slot?.slotId
    ))
    if (!slot || controller.signal.aborted
        || ['completed', 'failed', 'stopped', 'committed'].includes(
          controller.orchestration?.phase,
        )
        || !liveSlot || liveSlot.operationId !== slot.operationId
        || !['planned', 'queued', 'running', 'waiting'].includes(liveSlot.status)) {
      if (slot) {
        slot.status = 'stopped'
        slot.commitStatus = 'partial'
        slot.finishedAt = Date.now()
      }
      return { workReceipts: input.workReceipts, failure: null }
    }
    if (!result) {
      const error = item.error || item.invocation?.error
        || new Error('LOCAL_AGENT_UNKNOWN_FAILURE')
      slot.status = 'failed'
      slot.commitStatus = 'failed'
      slot.finishedAt = Date.now()
      this.recordAgentFailure(group.id, item.kind, error, threadRootId, new Set())
      return { workReceipts: input.workReceipts, failure: { ...item, error } }
    }
    try {
      const resultTrace = result?.message?.trace || result?.pendingMessage?.metadata?.trace
      const reportedOperationId = result?.operationId || resultTrace?.context?.operationId
      if (reportedOperationId !== slot.operationId
          || resultTrace?.runId !== controller.runId) {
        throw new Error('LOCAL_RUN_COLLABORATION_SCOPE_INVALID')
      }
      const assignment = workAssignments?.find(candidate => candidate.ownerKind === item.kind)
      const receiptRecord = this.v4ReceiptForResult(
        result, 'work', item.kind, slot, snapshotHash, {
          controller,
          workItemId: assignment?.taskId || '',
        },
      )
      if (!assignment || receiptRecord.receipt.workItemId !== assignment.taskId
          || !this.v4ReceiptReferencesComplete(receiptRecord, '', {
            runId: controller.runId,
            agentRunId: resultTrace?.agentRunId,
            agentKind: item.kind,
            operationId: slot.operationId,
          })) {
        throw new Error('LOCAL_RUN_V4_WORK_RECEIPT_INVALID')
      }
      const exactReceipt = this.v4ExactWorkReceipt(
        receiptRecord, assignment, slot, snapshotRecord, snapshotHash, coordinationPlan,
      )
      const durableReceipts = Array.isArray(controller.orchestration?.workReceipts)
        ? controller.orchestration.workReceipts
        : input.workReceipts
      const appended = appendWorkReceipt(durableReceipts, exactReceipt)
      const assignmentOrder = new Map(coordinationPlan.assignments.map((candidate, index) => (
        [candidate.taskId, index]
      )))
      const workReceipts = [...appended].sort((left, right) => (
        assignmentOrder.get(left.taskId) - assignmentOrder.get(right.taskId)
      ))
      const duplicate = receiptRecords.find(existing => (
        existing?.receipt?.receiptId === receiptRecord.receipt.receiptId
      ))
      if (!duplicate) receiptRecords.push(receiptRecord)
      const effectiveReceiptRecord = duplicate || receiptRecord
      if (!duplicate) input.phaseReceipts.push(receiptRecord)
      controller.v4ReceiptRecords = receiptRecords
      controller.v4WorkReceipts = workReceipts
      slot.status = 'completed'
      slot.commitStatus = 'pending'
      slot.finishedAt = Date.now()
      slot.receiptId = effectiveReceiptRecord.receipt.receiptId
      slot.deliveryWatermark = effectiveReceiptRecord.receipt.deliveryWatermark
      slot.resultHash = hashValue(effectiveReceiptRecord.receipt)
      slot.resultRefs = {
        artifactIds: result.producedOutcomeRefs?.artifactIds || [],
        evidenceIds: result.producedOutcomeRefs?.evidenceIds || [],
        workflowOutcomeRefs: [
          ...(slot.resultRefs?.workflowOutcomeRefs || []),
          ...(!duplicate ? [{ receipt: effectiveReceiptRecord.receipt }] : []),
        ],
      }
      const watermark = {
        agentKind: effectiveReceiptRecord.receipt.agentKind,
        phase: effectiveReceiptRecord.receipt.phase,
        watermark: effectiveReceiptRecord.receipt.deliveryWatermark,
        operationId: effectiveReceiptRecord.receipt.operationId,
        snapshotHash: effectiveReceiptRecord.receipt.snapshotHash,
        updatedAt: Date.now(),
      }
      controller.v4Watermarks = [
        ...(controller.v4Watermarks || []).filter(existing => (
          existing.agentKind !== watermark.agentKind || existing.phase !== watermark.phase
        )),
        watermark,
      ]
      const pendingKinds = phaseSlots.filter(candidate => (
        ['planned', 'queued', 'running', 'waiting'].includes(candidate.status)
      )).map(candidate => candidate.agentKind)
      if (input.resumedGate
          && !this.completeV4ResumedAgentSlotContinuation(controller, input.resumedGate)) {
        throw new Error('LOCAL_RUN_PERSIST_FAILED')
      }
      this.v4CheckpointPhase(group, controller, {
        targetKinds,
        phase: 'work',
        batchId,
        snapshotRecord,
        snapshotHash,
        slots: phaseSlots,
        writerKind,
        currentKinds: pendingKinds,
        pendingKinds,
        participantKinds,
        receipts: receiptRecords,
        challengeBindings,
        coordinationPlan,
        workReceipts,
        workAssignments,
      })
      return { workReceipts, failure: null }
    } catch (error) {
      if (error?.message === 'LOCAL_RUN_PERSIST_FAILED'
          || String(error?.message || '').startsWith('TEST_CRASH:')) throw error
      slot.status = 'failed'
      slot.commitStatus = 'failed'
      slot.finishedAt = Date.now()
      this.recordAgentFailure(group.id, item.kind, error, threadRootId, new Set())
      return { workReceipts: input.workReceipts, failure: { ...item, error } }
    }
  }

  async runV4Phase(group, controller, threadRootId, context, phaseInput) {
    const {
      phase, activeKinds, targetKinds, writerKind, batchId,
      snapshot, snapshotRecord, snapshotHash, slots, receiptRecords, challengeBindings,
    } = phaseInput
    const participantKinds = Array.isArray(phaseInput.participantKinds)
      ? phaseInput.participantKinds
      : targetKinds
    const coordinationPlan = phaseInput.coordinationPlan || null
    const workAssignments = phase === 'work' && Array.isArray(phaseInput.workAssignments)
      ? phaseInput.workAssignments
      : []
    const workAssignmentsByKind = new Map(workAssignments.map(assignment => (
      [assignment.ownerKind, assignment]
    )))
    if (phase === 'work' && (workAssignments.length !== activeKinds.length
        || workAssignmentsByKind.size !== activeKinds.length
        || activeKinds.some(kind => {
          const assignment = workAssignmentsByKind.get(kind)
          return !assignment || !coordinationPlan?.assignments?.some(candidate => (
            candidate.taskId === assignment.taskId && candidate.ownerKind === kind
          ))
        }))) {
      throw new Error('LOCAL_RUN_V4_COORDINATION_PLAN_INVALID')
    }
    let workReceipts = Array.isArray(phaseInput.workReceipts)
      ? [...phaseInput.workReceipts]
      : []
    const deliveryReceiptRecords = Array.isArray(phaseInput.deliveryReceiptRecords)
      ? phaseInput.deliveryReceiptRecords
      : [...receiptRecords]
    const workContextLimit = Math.max(
      0, 6000 - collaborationPackageIndexText(participantKinds).length - 2,
    )
    const extraContextFor = kind => phase === 'work'
      ? this.v4WorkAssignmentText(
          coordinationPlan,
          kind,
          workAssignmentsByKind.get(kind)?.taskId,
          snapshot,
          workContextLimit,
          deliveryReceiptRecords,
        )
      : (phase === 'challenge' ? phaseInput.coordinationText || '' : '')
    let synthesisRecovery = phaseInput.synthesisRecovery || null
    const synthesisAttempt = phase === 'synthesis'
      ? this.v4ActiveSynthesisAttempt(synthesisRecovery)
      : null
    const operationIds = phaseInput.operationIds instanceof Map
      ? phaseInput.operationIds
      : synthesisAttempt
      ? new Map([[synthesisAttempt.writerKind, synthesisAttempt.operationId]])
      : (phase === 'work'
        ? new Map(activeKinds.map((kind) => {
            const slot = slots.find(candidate => candidate.agentKind === kind)
            const assignment = workAssignmentsByKind.get(kind)
            return [kind, this.v4OperationId(
              controller, kind, `work:${assignment.taskId}`, slot?.slotId || '',
            )]
          }))
        : null)
    const phaseSlots = this.v4PhaseSlots({
      controller,
      targetKinds,
      phase,
      activeKinds,
      slots,
      snapshotHash,
      writerKind,
      operationIds,
      allowWrite: group.allowWrite === true,
    })
    const resumedGate = phaseInput.resumedGate
    const resumedGateFor = slot => (
      resumedGate?.phase === phase
        && resumedGate.agentKind === slot.agentKind
        && resumedGate.slotId === slot.slotId
        && resumedGate.operationId === slot.operationId
        && resumedGate.snapshotHash === snapshotHash
        && resumedGate.round === controller.currentRound
        ? resumedGate
        : null
    )
    const activeSet = new Set(activeKinds)
    const phaseReceipts = []
    const snapshotSourceMessageIds = [snapshot.messageId, ...snapshot.history.map(item => item.id)]
    for (const slot of phaseSlots) {
      if (activeSet.has(slot.agentKind)) {
        slot.status = phase === 'synthesis' ? 'queued' : 'running'
      }
    }
    const cursorPendingKinds = Array.isArray(phaseInput.pendingKinds)
      ? phaseInput.pendingKinds
      : activeKinds
    this.v4CheckpointPhase(group, controller, {
      targetKinds,
      phase,
      batchId,
      snapshotRecord,
      snapshotHash,
      slots: phaseSlots,
      writerKind,
      currentKinds: activeKinds,
      pendingKinds: cursorPendingKinds,
      participantKinds,
      receipts: receiptRecords,
      challengeBindings,
      synthesisRecovery,
      coordinationPlan,
      workReceipts,
      workAssignments,
    })
    this.emitChanged()

    if (phase === 'proposal') {
      const dispatches = activeKinds.map(kind => {
        const slot = phaseSlots.find(candidate => candidate.agentKind === kind)
        const prompt = this.v4PhasePrompt(
          group, kind, phase, snapshot, receiptRecords, 'participant', {
            reviewTarget: '',
            packageText: '',
            skillHints: context.rootSkillsByKind.get(kind) || [],
          },
        )
        const sessionPolicy = this.naturalAgentResponses ? null : 'frozen'
        return {
          kind,
          slot,
          context: {
            v4: true,
            phase,
            batchId,
            slotId: slot.slotId,
            snapshotHash,
            ...(sessionPolicy ? { sessionPolicy } : {}),
            promptOverride: prompt,
            contextPackId: controller.contextPackId,
            snapshotSourceMessageIds,
            snapshotSourceEntries: snapshot.history,
            permissionMode: 'read-only',
            singleWriterKind: writerKind,
            parallelGraph: true,
            deferMessage: true,
            allowMissingProposalReceipt: true,
            allowMissingV4Receipt: this.naturalAgentResponses,
            operationId: slot.operationId,
            ...(resumedGateFor(slot) ? { resumedGate: resumedGateFor(slot) } : {}),
            skillHints: context.rootSkillsByKind.get(kind) || [],
            knowledgeBaseHints: context.rootKnowledgeBasesByKind.get(kind) || [],
          },
        }
      })
      return this.runV4ProposalBatch(group, controller, threadRootId, {
        targetKinds,
        participantKinds,
        writerKind,
        batchId,
        snapshotRecord,
        snapshotHash,
        phaseSlots,
        receiptRecords,
        dispatches,
        resumedGate,
      })
    }

    const failures = []
    const phasePendingMessages = []
    let synthesisPendingMessage = null
    let workAdmissionClosed = false
    let workAdmissionTail = Promise.resolve()
    const admitWork = (item) => {
      const admission = workAdmissionTail.then(() => {
        if (workAdmissionClosed) return { ...item, workSettled: true }
        const admitted = this.v4AdmitWorkSettlement(
          group, controller, threadRootId, item, {
            targetKinds,
            participantKinds,
            writerKind,
            batchId,
            snapshotRecord,
            snapshotHash,
            phaseSlots,
            receiptRecords,
            challengeBindings,
            coordinationPlan,
            workReceipts,
            phaseReceipts,
            workAssignments,
            resumedGate: resumedGateFor(phaseSlots.find(candidate => (
              candidate.agentKind === item.kind
            ))),
          },
        )
        workReceipts = admitted.workReceipts
        if (admitted.failure) failures.push(admitted.failure)
        return { ...item, workSettled: true }
      })
      workAdmissionTail = admission.catch(() => { workAdmissionClosed = true })
      return admission
    }
    const settled = await Promise.all(activeKinds.map(async kind => {
      const slot = phaseSlots.find(candidate => candidate.agentKind === kind)
      const challengeBinding = phase === 'challenge'
        ? challengeBindings?.find(binding => binding.reviewerKind === kind) || null
        : null
      const assignedProposalText = challengeBinding
        ? this.v4ChallengeProposalText(challengeBinding, kind)
        : ''
      const role = this.v4PromptRole(
        phase, kind, coordinationPlan, workAssignmentsByKind.get(kind) || null,
      )
      const extraContext = extraContextFor(kind)
      const promptOptions = {
        reviewTarget: phase === 'challenge'
          ? challengeBinding?.proposalKind || ''
          : '',
        assignedProposalText,
        packageText: '',
        extraContext,
        snapshotHash,
        skillHints: context.rootSkillsByKind.get(kind) || [],
      }
      const prompt = typeof phaseInput.promptBuilder === 'function'
        ? phaseInput.promptBuilder({
            kind, slot, role, options: promptOptions,
            ...(phaseInput.disableDeliveryPrompt === true ? { transcript: '' } : {}),
          })
        : this.v4PhasePrompt(
          group,
          kind,
          phase,
          snapshot,
          deliveryReceiptRecords,
          role,
          promptOptions,
        )
      const sessionPolicy = phaseInput.sessionPolicy === undefined
        ? 'frozen'
        : phaseInput.sessionPolicy
      let preparedDelivery = null
      let item
      const resumedSlotGate = resumedGateFor(slot)
      const recoveredResult = phase === 'discussion'
        ? this.v4NaturalRecoveredDiscussionResult(
            group, controller, threadRootId, kind, slot,
          )
        : null
      if (recoveredResult) return { kind, invocation: { result: recoveredResult } }
      try {
        const invocation = await this.invokeWithUnauthorizedRecovery({
          group,
          kind,
          controller,
          activeKinds: participantKinds,
          threadRootId,
          context: {
            v4: true,
            phase,
            batchId,
            slotId: slot.slotId,
            snapshotHash,
            ...(sessionPolicy ? { sessionPolicy } : {}),
            promptOverride: prompt,
            contextPackId: controller.contextPackId,
            snapshotSourceMessageIds,
            snapshotSourceEntries: snapshot.history,
            permissionMode: group.allowWrite === true
              && (phase === 'synthesis' || (this.naturalAgentResponses && phase === 'discussion'))
              && kind === writerKind
              ? 'workspace-write'
              : 'read-only',
            singleWriterKind: writerKind,
            parallelGraph: true,
            deferMessage: true,
            allowMissingV4Receipt: this.naturalAgentResponses,
            operationId: slot.operationId,
            ...(resumedSlotGate ? { resumedGate: resumedSlotGate } : {}),
            v4SynthesisRecovery: phase === 'synthesis',
            onLeaseAcquired: (leaseState) => {
              if (!leaseState?.agentRunId) throw new Error('LOCAL_RUN_PERSIST_FAILED')
              slot.agentRunId = leaseState.agentRunId
              if (phase === 'synthesis') {
                const activeAttempt = this.v4ActiveSynthesisAttempt(synthesisRecovery)
                if (!activeAttempt || activeAttempt.operationId !== slot.operationId) {
                  throw new Error('LOCAL_RUN_V4_SYNTHESIS_RECOVERY_INVALID')
                }
                synthesisRecovery = this.v4UpdateSynthesisAttempt(
                  synthesisRecovery,
                  activeAttempt.operationId,
                  {
                    status: 'leased',
                    permission: leaseState?.permissionMode === 'workspace-write'
                      ? 'workspace-write' : 'read-only',
                    leaseAcquired: true,
                    sideEffectsPossible: leaseState?.sideEffectsPossible === true,
                    outcomeCertainty: leaseState?.sideEffectsPossible === true
                      ? 'unknown_outcome' : 'not_started',
                  },
                )
              }
              slot.status = 'running'
              this.v4CheckpointPhase(group, controller, {
                targetKinds,
                phase,
                batchId,
                snapshotRecord,
                snapshotHash,
                slots: phaseSlots,
                writerKind,
                currentKinds: activeKinds,
                pendingKinds: cursorPendingKinds,
                participantKinds,
                receipts: receiptRecords,
                challengeBindings,
                synthesisRecovery,
                coordinationPlan,
                workReceipts,
                workAssignments,
              })
            },
            ...(phaseInput.disableDeliveryPrompt === true
              ? {
                  v4PromptBuilder: sessionBinding => {
                    const built = this.v4NaturalDeliveryPrompt(
                      group, controller, threadRootId, kind, slot, sessionBinding,
                      transcript => phaseInput.promptBuilder({ kind, slot, role, options: promptOptions, transcript }),
                    )
                    preparedDelivery = built.delivery
                    return built
                  },
                }
              : {
                  v4PromptBuilder: (sessionBinding) => {
                    const built = this.v4DeliveryPrompt(group, controller, {
                      kind, phase, snapshot, receiptRecords: deliveryReceiptRecords,
                      role, targetKinds: participantKinds, slot,
                      options: {
                        reviewTarget: phase === 'challenge'
                          ? challengeBinding?.proposalKind || ''
                          : '',
                        assignedProposalText,
                        extraContext,
                        ...(['synthesis', 'verification'].includes(phase)
                          ? { artifactContext: { coordinationPlan } }
                          : {}),
                      },
                      sessionBinding,
                      skillHints: context.rootSkillsByKind.get(kind) || [],
                    })
                    preparedDelivery = built.delivery
                    return built
                  },
                }),
            skillHints: context.rootSkillsByKind.get(kind) || [],
            knowledgeBaseHints: context.rootKnowledgeBasesByKind.get(kind) || [],
          },
        })
        if (invocation.result?.v4Delivery) {
          this.v4SetDeliveryStatus(
            group, controller, invocation.result.v4Delivery, 'acknowledged',
            invocation.result.v4SessionBinding,
          )
        } else if (preparedDelivery) {
          this.v4SetDeliveryStatus(group, controller, preparedDelivery, 'uncertain')
        }
        item = { kind, invocation }
      } catch (error) {
        if (preparedDelivery) this.v4SetDeliveryStatus(group, controller, preparedDelivery, 'uncertain')
        if (stalePermissionResumeFailure(error, resumedSlotGate)) {
          this.resetAgentSession(group, kind, true, controller.taskId)
          item = { kind, error, permissionRestartRecovery: true }
        } else {
          item = { kind, error }
        }
      }
      return phase === 'work' ? admitWork(item) : item
    }))

    for (const item of phase === 'work' ? [] : settled) {
      const slot = phaseSlots.find(candidate => candidate.agentKind === item.kind)
      const result = item.invocation?.result
      if (controller.signal.aborted) {
        slot.status = 'stopped'
        slot.commitStatus = 'partial'
        slot.finishedAt = Date.now()
        continue
      }
      if (!result) {
        const error = item.error || item.invocation?.error
          || new Error('LOCAL_AGENT_UNKNOWN_FAILURE')
        slot.status = 'failed'
        slot.commitStatus = 'failed'
        slot.finishedAt = Date.now()
        failures.push({ ...item, error })
        if (!controller.signal.aborted) {
          this.recordAgentFailure(group.id, item.kind, error, threadRootId, new Set())
        }
        if (phase === 'synthesis' && synthesisRecovery) {
          const activeAttempt = this.v4ActiveSynthesisAttempt(synthesisRecovery)
          if (activeAttempt?.operationId === slot.operationId) {
            const failure = error?.invocationFailure || {}
            const unknownWrite = activeAttempt.permission === 'workspace-write'
              && activeAttempt.leaseAcquired
              && (item.permissionRestartRecovery === true
                || (failure.outcomeCertainty !== 'not_started'
                  && failure.outcomeCertainty !== 'known_failed'))
            synthesisRecovery = this.v4UpdateSynthesisAttempt(
              synthesisRecovery,
              activeAttempt.operationId,
              unknownWrite ? {
                status: 'unknown_outcome',
                sideEffectsPossible: true,
                outcomeCertainty: 'unknown_outcome',
              } : {
                status: 'failed',
                sideEffectsPossible: false,
                outcomeCertainty: failure.outcomeCertainty === 'not_started'
                  ? 'not_started' : 'known_failed',
              },
            )
          }
        }
        continue
      }
      try {
        const reportedOperationId = result?.message?.trace?.context?.operationId
          || result?.pendingMessage?.metadata?.trace?.context?.operationId
        if (reportedOperationId && reportedOperationId !== slot.operationId) {
          throw new Error('LOCAL_RUN_COLLABORATION_SCOPE_INVALID')
        }
        const receiptRecord = this.v4ReceiptForResult(
          result,
          phase,
          item.kind,
          slot,
          snapshotHash,
          {
            controller,
            ...(phase === 'work'
              ? { workItemId: workAssignmentsByKind.get(item.kind)?.taskId || '' }
              : {}),
            reviewedArtifactId: phase === 'challenge'
              ? challengeBindings?.find(binding => (
                binding.reviewerKind === item.kind
              ))?.artifactIds?.[0] || ''
              : (phase === 'verification'
                ? [...receiptRecords].reverse().find(record => (
                  record.receipt?.phase === 'synthesis'
                ))?.receipt?.artifactIds?.[0] || ''
                : ''),
          },
        )
        if (phase === 'work') {
          const assignment = workAssignmentsByKind.get(item.kind)
          if (!assignment || receiptRecord.receipt.workItemId !== assignment.taskId) {
            throw new Error('LOCAL_RUN_V4_WORK_RECEIPT_INVALID')
          }
          if (!this.v4ReceiptReferencesComplete(receiptRecord)) {
            throw new Error('LOCAL_RUN_V4_WORK_RECEIPT_INVALID')
          }
        }
        const duplicate = receiptRecords.find(existing => (
          existing?.receipt?.receiptId === receiptRecord.receipt.receiptId
        ))
        if (!duplicate) {
          phaseReceipts.push(receiptRecord)
          receiptRecords.push(receiptRecord)
        }
        const effectiveReceiptRecord = duplicate || receiptRecord
        controller.v4ReceiptRecords = receiptRecords
        slot.status = 'completed'
        slot.commitStatus = 'pending'
        slot.finishedAt = Date.now()
        slot.receiptId = effectiveReceiptRecord.receipt.receiptId
        slot.deliveryWatermark = effectiveReceiptRecord.receipt.deliveryWatermark
        slot.resultHash = hashValue(effectiveReceiptRecord.receipt)
        slot.resultRefs = {
          artifactIds: result.outcomeRefs?.artifactIds || [],
          evidenceIds: result.outcomeRefs?.evidenceIds || [],
          workflowOutcomeRefs: [
            ...(slot.resultRefs?.workflowOutcomeRefs || []),
            {
              receipt: effectiveReceiptRecord.receipt,
              ...(effectiveReceiptRecord.verdict ? { verdict: effectiveReceiptRecord.verdict } : {}),
              ...(effectiveReceiptRecord.resolvedIssueIds.length
                ? { resolvedIssueIds: effectiveReceiptRecord.resolvedIssueIds }
                : {}),
            },
          ],
        }
        if (phase === 'synthesis' && !duplicate) {
          synthesisPendingMessage = result.pendingMessage || result.message || null
        } else if (result.pendingMessage?.content) {
          phasePendingMessages.push({ kind: item.kind, pendingMessage: result.pendingMessage })
          if (['discussion', 'challenge'].includes(phase)) {
            this.commitV4PhaseMessage({
              group, controller, threadRootId, phase, kind: item.kind,
              pendingMessage: result.pendingMessage,
            })
            slot.commitStatus = 'committed'
          }
        }
        if (phase === 'synthesis' && synthesisRecovery) {
          const activeAttempt = this.v4ActiveSynthesisAttempt(synthesisRecovery)
          if (!activeAttempt || activeAttempt.operationId !== slot.operationId) {
            throw new Error('LOCAL_RUN_V4_SYNTHESIS_RECOVERY_INVALID')
          }
          synthesisRecovery = this.v4UpdateSynthesisAttempt(
            synthesisRecovery,
            activeAttempt.operationId,
            { status: 'completed', outcomeCertainty: 'succeeded' },
          )
        }
      } catch (error) {
        slot.status = 'failed'
        slot.commitStatus = 'failed'
        slot.finishedAt = Date.now()
        failures.push({ ...item, error })
        if (phase === 'synthesis' && synthesisRecovery) {
          const activeAttempt = this.v4ActiveSynthesisAttempt(synthesisRecovery)
          if (activeAttempt?.operationId === slot.operationId) {
            const failure = error?.invocationFailure || {}
            const unknownWrite = activeAttempt.permission === 'workspace-write'
              && activeAttempt.leaseAcquired
              && failure.outcomeCertainty !== 'not_started'
              && failure.outcomeCertainty !== 'known_failed'
            synthesisRecovery = this.v4UpdateSynthesisAttempt(
              synthesisRecovery,
              activeAttempt.operationId,
              unknownWrite ? {
                status: 'unknown_outcome',
                sideEffectsPossible: true,
                outcomeCertainty: 'unknown_outcome',
              } : {
                status: 'failed',
                sideEffectsPossible: false,
                outcomeCertainty: failure.outcomeCertainty === 'not_started'
                  ? 'not_started' : 'known_failed',
              },
            )
          }
        }
        if (!controller.signal.aborted) {
          this.recordAgentFailure(group.id, item.kind, error, threadRootId, new Set())
        }
      }
    }
    const newWatermarks = phaseReceipts.map(item => ({
      agentKind: item.receipt.agentKind,
      phase: item.receipt.phase,
      watermark: item.receipt.deliveryWatermark,
      operationId: item.receipt.operationId,
      snapshotHash: item.receipt.snapshotHash,
      updatedAt: Date.now(),
    }))
    controller.v4Watermarks = [
      ...(controller.v4Watermarks || []).filter(existing => (
        !newWatermarks.some(next => (
          next.agentKind === existing.agentKind && next.phase === existing.phase
        ))
      )),
      ...newWatermarks,
    ]
    if (phase === 'synthesis') {
      const activeAttempt = this.v4ActiveSynthesisAttempt(synthesisRecovery)
      if (activeAttempt?.status === 'unknown_outcome' && !synthesisRecovery.pendingGate) {
        synthesisRecovery = {
          ...synthesisRecovery,
          pendingGate: this.v4SynthesisRecoveryGate(controller, synthesisRecovery),
        }
      }
    }
    const resumedSlot = phaseSlots.find(slot => (
      slot.status === 'completed' && resumedGateFor(slot)
    ))
    if (resumedSlot
        && !this.completeV4ResumedAgentSlotContinuation(controller, resumedGate)) {
      throw new Error('LOCAL_RUN_PERSIST_FAILED')
    }
    const remainingKinds = Array.isArray(phaseInput.remainingKinds)
      ? phaseInput.remainingKinds
      : []
    this.v4CheckpointPhase(group, controller, {
      targetKinds,
      phase,
      batchId,
      snapshotRecord,
      snapshotHash,
      slots: phaseSlots,
      writerKind,
      currentKinds: [],
      pendingKinds: remainingKinds,
      participantKinds,
      receipts: receiptRecords,
      challengeBindings,
      synthesisRecovery,
      coordinationPlan,
      workReceipts,
      workAssignments,
    })
    controller.currentKind = ''
    controller.progress = []
    controller.completedKinds = [...new Set([
      ...(controller.completedKinds || []),
      ...activeKinds.filter(kind => !failures.some(item => item.kind === kind)),
    ])]
    controller.failedKinds = [...new Set([
      ...(controller.failedKinds || []),
      ...failures.map(item => item.kind),
    ])]
    this.emitChanged()
    return {
      slots: phaseSlots,
      receiptRecords,
      phaseReceipts,
      phasePendingMessages,
      failures,
      synthesisPendingMessage,
      synthesisRecovery,
      workReceipts,
      ok: failures.length === 0,
    }
  }

  async v4CommitAcceptedCandidate({
    group, controller, threadRootId, targetKinds, batchId, snapshotRecord, snapshotHash,
    slots, receiptRecords, challengeBindings, synthesisBinding, synthesisRecovery,
    coordinationPlan, workReceipts, convergence, writerKind, verificationKinds, acceptance,
    participantKinds = targetKinds,
  }) {
    if (controller.signal.aborted) return terminalRunStatusForReason(controller.stopReason)
    const synthesisRecord = this.v4LatestReceipt(receiptRecords, 'synthesis', writerKind)
    const evidenceIds = [...(synthesisRecord?.receipt?.evidenceIds || [])]
    const { artifact, contentHash, content } = this.v4ArtifactIdentity(
      acceptance.candidateArtifactId,
    )
    if (!content || contentHash !== acceptance.candidateHash
        || !evidenceIds.length
        || !evidenceIds.some(evidenceId => this.v4EvidenceSupportsArtifact(
          evidenceId, acceptance.candidateArtifactId, contentHash,
        ))) {
      throw new Error('LOCAL_RUN_V4_CANDIDATE_INVALID')
    }
    const identity = {
      runId: controller.runId,
      taskId: controller.taskId,
      candidateContentHash: contentHash,
    }
    const previous = controller.orchestration?.candidateCommit || null
    const collaborationAtIntent = controller.orchestration?.collaboration || emptyCollaborationState()
    const writerOwner = this.v4BlackboardOwner(coordinationPlan, writerKind)
    const blackboardSequence = previous?.blackboardSequence
      || (collaborationAtIntent.entries.at(-1)?.lifecycle?.sequence || 0) + 1
    const blackboardRecordedAt = previous?.blackboardRecordedAt ?? 0
    const commitId = candidateCommitSinkId(identity, 'commit')
    const blackboardEntryAtIntent = createBlackboardEntryRecord({
      entryType: 'artifact-ref',
      subject: `candidate-commit:${commitId}`,
      statement: candidateCommitBlackboardStatement({
        candidateArtifactId: acceptance.candidateArtifactId,
        candidateContentHash: contentHash,
      }),
      value: contentHash,
      owner: writerOwner,
      audience: { roles: [], agentKinds: [...targetKinds].sort() },
      lifecycle: {
        state: 'active', sequence: blackboardSequence,
        recordedAt: blackboardRecordedAt, supersedesEntryId: null,
      },
      provenance: {
        runId: controller.runId, taskId: controller.taskId,
        round: controller.currentRound, agentRunId: null,
        artifactIds: [acceptance.candidateArtifactId], evidenceIds,
      },
      refs: [acceptance.candidateArtifactId, ...evidenceIds],
    })
    const base = {
      runId: controller.runId,
      taskId: controller.taskId,
      groupId: group.id,
      threadRootId,
      candidateArtifactId: acceptance.candidateArtifactId,
      candidateContentHash: contentHash,
      candidateContentRef: { ...artifact.contentRef },
      evidenceIds,
      writerKind,
      writerRole: writerOwner.role,
      commitId,
      messageId: candidateCommitSinkId(identity, 'message'),
      blackboardEntryId: blackboardEntryAtIntent.entryId,
      blackboardSequence,
      blackboardRecordedAt,
    }
    if (previous) {
      const bound = Object.fromEntries(Object.keys(base).map(key => [key, previous[key]]))
      if (canonicalJson(bound) !== canonicalJson(base)) {
        throw new Error('LOCAL_RUN_COMMIT_INVALID')
      }
    }
    let candidateCommit = previous || {
      ...base,
      status: 'intent',
      messageStatus: 'pending',
      blackboardStatus: 'pending',
      attempt: 1,
      updatedAt: Date.now(),
    }
    const checkpoint = (phase, nextCommit, collaboration, nextSlots = slots) => {
      candidateCommit = nextCommit
      if (collaboration) {
        controller.orchestration = { ...controller.orchestration, collaboration }
      }
      this.v4CheckpointPhase(group, controller, {
        targetKinds,
        phase,
        batchId,
        snapshotRecord,
        snapshotHash,
        slots: nextSlots,
        writerKind,
        currentKinds: [],
        pendingKinds: [],
        participantKinds,
        receipts: receiptRecords,
        challengeBindings,
        synthesisBinding,
        synthesisRecovery,
        coordinationPlan,
        workReceipts,
        convergence,
        candidateCommit,
      })
    }
    if (!previous) checkpoint('commit', candidateCommit, controller.orchestration?.collaboration)

    const messageInput = {
      messageId: candidateCommit.messageId,
      groupId: group.id,
      agentKind: writerKind,
      threadRootId,
      content,
      metadata: {},
    }
    const existingMessage = this.state().messages.find(message => (
      message.id === candidateCommit.messageId
    ))
    if (candidateCommit.messageStatus === 'committed' && !existingMessage) {
      throw new Error('LOCAL_RUN_COMMIT_INVALID')
    }
    if (controller.signal.aborted) return terminalRunStatusForReason(controller.stopReason)
    if (!this.commitV4AgentMessage) throw new Error('LOCAL_RUN_COMMIT_INVALID')
    const committedMessage = this.commitV4AgentMessage(messageInput)
    if (committedMessage.id !== candidateCommit.messageId) {
      throw new Error('LOCAL_RUN_COMMIT_INVALID')
    }
    if (controller.signal.aborted) return terminalRunStatusForReason(controller.stopReason)
    if (candidateCommit.status === 'intent') {
      candidateCommit = {
        ...candidateCommit,
        status: 'message-committed',
        messageStatus: 'committed',
        updatedAt: Date.now(),
      }
      checkpoint('commit', candidateCommit, controller.orchestration.collaboration)
    }

    let collaboration = controller.orchestration.collaboration || emptyCollaborationState()
    const existingEntry = collaboration.entries.find(entry => (
      entry.entryId === candidateCommit.blackboardEntryId
    ))
    const blackboardEntry = createBlackboardEntryRecord({
      entryType: 'artifact-ref',
      subject: `candidate-commit:${candidateCommit.commitId}`,
      statement: candidateCommitBlackboardStatement(candidateCommit),
      value: contentHash,
      owner: { type: 'agent', agentKind: writerKind, role: candidateCommit.writerRole },
      audience: { roles: [], agentKinds: [...targetKinds].sort() },
      lifecycle: {
        state: 'active',
        sequence: candidateCommit.blackboardSequence,
        recordedAt: candidateCommit.blackboardRecordedAt,
        supersedesEntryId: null,
      },
      provenance: {
        runId: controller.runId,
        taskId: controller.taskId,
        round: controller.currentRound,
        agentRunId: null,
        artifactIds: [acceptance.candidateArtifactId],
        evidenceIds,
      },
      refs: [acceptance.candidateArtifactId, ...evidenceIds],
    })
    if (blackboardEntry.entryId !== candidateCommit.blackboardEntryId) {
      throw new Error('LOCAL_RUN_COMMIT_INVALID')
    }
    if (existingEntry && canonicalJson(existingEntry) !== canonicalJson(blackboardEntry)) {
      throw new Error('LOCAL_RUN_COMMIT_INVALID')
    }
    if (candidateCommit.blackboardStatus === 'committed' && !existingEntry) {
      throw new Error('LOCAL_RUN_COMMIT_INVALID')
    }
    if (controller.signal.aborted) return terminalRunStatusForReason(controller.stopReason)
    if (!existingEntry) {
      const {
        entryId: _entryId,
        version: _version,
        recordType: _recordType,
        ...blackboardInput
      } = blackboardEntry
      collaboration = appendBlackboardEntry(collaboration, blackboardInput)
      const appended = collaboration.entries.find(entry => entry.entryId === blackboardEntry.entryId)
      if (!appended || canonicalJson(appended) !== canonicalJson(blackboardEntry)) {
        throw new Error('LOCAL_RUN_COMMIT_INVALID')
      }
    }
    if (controller.signal.aborted) return terminalRunStatusForReason(controller.stopReason)
    if (candidateCommit.status === 'message-committed') {
      candidateCommit = {
        ...candidateCommit,
        status: 'sinks-committed',
        blackboardStatus: 'committed',
        updatedAt: Date.now(),
      }
      checkpoint('commit', candidateCommit, collaboration)
    }

    if (controller.signal.aborted) return terminalRunStatusForReason(controller.stopReason)
    const finalSlots = slots.map(slot => ({
      ...slot,
      phase: slot.agentKind === writerKind ? 'completed' : slot.phase,
      status: ['failed', 'stopped', 'timeout', 'interrupted'].includes(slot.status)
        ? slot.status : 'completed',
      finishedAt: slot.finishedAt || Date.now(),
      commitStatus: 'committed',
    }))
    candidateCommit = {
      ...candidateCommit,
      status: 'completed',
      messageStatus: 'committed',
      blackboardStatus: 'committed',
      updatedAt: Date.now(),
    }
    checkpoint('completed', candidateCommit, collaboration, finalSlots)
    controller.completedKinds = [...participantKinds]
    controller.failedKinds = targetKinds.filter(kind => !participantKinds.includes(kind))
    controller.currentKind = ''
    controller.progress = []
    this.emitChanged()
    return 'completed'
  }

  async runV4Discussion(group, controller, threadRootId, context, resume = false, resumedGate = null) {
    const snapshotTargetKinds = [...controller.targetKinds]
    const existing = controller.orchestration?.version === 4
      ? controller.orchestration
      : null
    const targetKinds = [...snapshotTargetKinds]
    controller.discussionStyle = existing?.discussionStyle
      || controller.discussionStyle
      || 'sequential'
    let activeKinds = Array.isArray(existing?.activeKinds) && existing.activeKinds.length
      ? existing.activeKinds.filter(kind => targetKinds.includes(kind))
      : [...targetKinds]
    const removedKinds = new Set(targetKinds.filter(kind => !activeKinds.includes(kind)))
    if (existing?.synthesisBinding) {
      throw new Error('LOCAL_RUN_V4_LEGACY_SYNTHESIS_BINDING_UNSUPPORTED')
    }
    let synthesisBinding = existing?.synthesisBinding
      ? {
          ...existing.synthesisBinding,
          candidates: existing.synthesisBinding.candidates.map(candidate => ({
            ...candidate,
            ...(candidate.evidence ? { evidence: { ...candidate.evidence } } : {}),
          })),
          verificationKinds: [...existing.synthesisBinding.verificationKinds],
        }
      : null
    let synthesisRecovery = existing?.synthesisRecovery
      ? {
          ...existing.synthesisRecovery,
          verificationKinds: [...existing.synthesisRecovery.verificationKinds],
          rankedKinds: [...existing.synthesisRecovery.rankedKinds],
          triedWriters: [...existing.synthesisRecovery.triedWriters],
          attempts: existing.synthesisRecovery.attempts.map(attempt => ({ ...attempt })),
          ...(existing.synthesisRecovery.pendingGate
            ? { pendingGate: { ...existing.synthesisRecovery.pendingGate } }
            : {}),
        }
      : null
    let coordinationPlan = existing?.coordinationPlan
      ? {
          ...existing.coordinationPlan,
          assignments: existing.coordinationPlan.assignments.map(assignment => ({
            ...assignment,
            inputRefs: [...assignment.inputRefs],
            artifactIds: [...assignment.artifactIds],
            dependsOn: [...assignment.dependsOn],
          })),
          verifierKinds: [...existing.coordinationPlan.verifierKinds],
          agreedBy: [...existing.coordinationPlan.agreedBy],
          ...(existing.coordinationPlan.supportReceiptIds
            ? { supportReceiptIds: [...existing.coordinationPlan.supportReceiptIds] }
            : {}),
        }
      : null
    const postSynthesisPhases = new Set([
      'synthesis', 'verification', 'human-gate', 'commit', 'committed', 'completed',
    ])
    const synthesisObservable = existing && (
      postSynthesisPhases.has(existing.phase)
      || commitDeliveryObservable(existing.commitState)
      || existing.slots?.some(slot => (
        postSynthesisPhases.has(slot.phase)
        || (slot.resultRefs?.workflowOutcomeRefs || []).some(item => (
          ['synthesis', 'verification'].includes(item?.receipt?.phase)
        ))
      ))
    )
    if (!synthesisBinding && !coordinationPlan && synthesisObservable) {
      throw new Error('LOCAL_RUN_V4_SYNTHESIS_BINDING_REQUIRED')
    }
    let writerKind = synthesisRecovery?.activeWriterKind
      || coordinationPlan?.finalizerKind || synthesisBinding?.writerKind
      || existing?.discussionWriterKind
      || (!existing && this.naturalAgentResponses && group.allowWrite === true
        ? targetKinds.find(kind => this.canWriteWorkspace(kind)) : '') || ''
    controller.currentRound = Math.max(1, controller.currentRound || existing?.round || 0)
    const rootMessage = existing ? null : this.state().messages.find(message => (
      message.id === threadRootId && message.groupId === group.id && message.role === 'user'
    ))
    const snapshot = existing
      ? this.v4LoadSnapshot(existing, {
          taskId: controller.taskId,
          messageId: threadRootId,
          groupId: controller.groupId,
          targetKinds: snapshotTargetKinds,
        })
      : v4Snapshot({
          state: this.state(),
          group,
          taskId: threadRootId,
          targetKinds: snapshotTargetKinds,
          message: rootMessage,
          skillHintsByKind: context.rootSkillsByKind,
          phase: 'proposal',
          writerKind,
        })
    if (existing && this.naturalAgentResponses && !coordinationPlan && !synthesisBinding
        && (snapshot.writerKind || '') !== writerKind) {
      throw new Error('LOCAL_RUN_COLLABORATION_SCOPE_INVALID')
    }
    if (existing) {
      const persistedSkills = this.v4SnapshotSkillHints(snapshot, snapshotTargetKinds)
      const hasPersistedSkills = snapshotTargetKinds.some(kind => (
        (persistedSkills.get(kind) || []).length > 0
      ))
      context = {
        rootAttachments: [],
        rootSkillsByKind: hasPersistedSkills
          ? await this.v4RestoreSnapshotSkills(snapshot, snapshotTargetKinds, persistedSkills)
          : persistedSkills,
        rootKnowledgeBasesByKind: new Map(snapshotTargetKinds.map(kind => [kind, []])),
      }
    }
    const builtSnapshot = existing
      ? { record: existing.snapshot, snapshotHash: existing.snapshotHash }
      : this.v4SnapshotRecord(controller, snapshot, snapshotTargetKinds)
    const snapshotRecord = builtSnapshot.record
    const snapshotHash = builtSnapshot.snapshotHash
    const batchId = existing?.batchId || this.v4BatchId(controller, 'discussion')
    const receiptRecords = this.v4RestoreReceipts(controller)
    let workReceipts = Array.isArray(existing?.workReceipts)
      ? existing.workReceipts.map(receipt => ({
          ...receipt,
          snapshotContentRef: { ...receipt.snapshotContentRef },
          collaborationReceipt: { ...receipt.collaborationReceipt },
          artifacts: receipt.artifacts.map(artifact => ({
            ...artifact,
            contentRef: { ...artifact.contentRef },
          })),
        }))
      : []
    controller.v4WorkReceipts = workReceipts
    let challengeBindings = Array.isArray(existing?.challengeBindings)
      ? existing.challengeBindings.map(binding => ({
          ...binding,
          artifactIds: [...binding.artifactIds],
          evidenceIds: [...binding.evidenceIds],
        }))
      : null
    controller.v4Watermarks = existing?.deliveryWatermarks
      ? existing.deliveryWatermarks.map(item => ({ ...item }))
      : []
    const initialSlots = existing?.slots?.length
      ? existing.slots.map(slot => ({ ...slot }))
      : targetKinds.map((kind, index) => ({
          slotId: `slot-${index + 1}-${kind}`,
          agentKind: kind,
          phase: 'proposal',
          status: 'planned',
          operationId: this.v4OperationId(
            controller, kind, 'proposal', `slot-${index + 1}-${kind}`,
          ),
          queuePosition: index,
          snapshotHash,
          deliveryWatermark: 0,
          receiptId: '',
          resultHash: '',
          assignedAt: Date.now(),
          startedAt: Date.now(),
          finishedAt: null,
          commitStatus: 'pending',
          attempt: 0,
          permission: 'read-only',
          resultRefs: { artifactIds: [], evidenceIds: [], workflowOutcomeRefs: [] },
        }))
    let slots = initialSlots
    if (!existing) {
      this.v4CheckpointPhase(group, controller, {
        targetKinds,
        participantKinds: activeKinds,
        phase: 'proposal',
        batchId,
        snapshotRecord,
        snapshotHash,
        slots,
        writerKind,
        currentKinds: targetKinds,
        pendingKinds: targetKinds,
        receipts: receiptRecords,
      })
      this.emitChanged()
    }

    const latestFor = (phase, kind) => this.v4LatestReceipt(receiptRecords, phase, kind)
    const pendingKindsFor = (phase, activeKinds, workAssignments = []) => activeKinds.filter(kind => {
      if (phase === 'work') {
        const assignment = workAssignments.find(candidate => candidate.ownerKind === kind)
        return !assignment || !workReceipts.some(receipt => (
          receipt.planHash === coordinationPlan.planHash
          && receipt.taskId === assignment.taskId
          && receipt.ownerKind === kind
        ))
      }
      const latest = latestFor(phase, kind)
      if (!latest) return true
      if (phase === 'proposal') return false
      const slot = slots.find(candidate => candidate.agentKind === kind)
      const synthesisAttempt = phase === 'synthesis'
        ? [...(synthesisRecovery?.attempts || [])].reverse().find(attempt => (
            attempt.writerKind === kind
          ))
        : null
      const expected = synthesisAttempt?.operationId || (slot
        ? this.v4OperationId(controller, kind, phase, slot.slotId)
        : '')
      return latest.receipt.operationId !== expected
    })
    const checkpointPhase = (phase, activeKinds, phaseSlots = slots, bindings = challengeBindings) => {
      this.v4CheckpointPhase(group, controller, {
        targetKinds,
        participantKinds: activeKindsForRun(),
        phase,
        batchId,
        snapshotRecord,
        snapshotHash,
        slots: phaseSlots,
        writerKind,
        currentKinds: [...activeKinds],
        pendingKinds: [...activeKinds],
        receipts: receiptRecords,
        challengeBindings: bindings,
        synthesisBinding,
        synthesisRecovery,
        coordinationPlan,
        workReceipts,
      })
    }
    const activeKindsForRun = () => [...activeKinds]
    const runPhase = async (phase, requestedKinds, bindings = challengeBindings, options = {}) => {
      const workAssignments = Array.isArray(options.workAssignments)
        ? options.workAssignments
        : []
      const pending = pendingKindsFor(phase, requestedKinds, workAssignments)
      if (!pending.length) {
        checkpointPhase(phase, [], slots)
        return { ok: true, phaseReceipts: [], synthesisPendingMessage: null }
      }
      const runPending = async (phaseKinds) => {
        const result = await this.runV4Phase(group, controller, threadRootId, context, {
          phase,
          activeKinds: phaseKinds,
          targetKinds,
          participantKinds: activeKindsForRun(),
          writerKind,
          batchId,
          snapshot,
          snapshotRecord,
          snapshotHash,
          slots,
          receiptRecords,
          challengeBindings: bindings,
          synthesisBinding,
          synthesisRecovery,
          coordinationPlan,
          workReceipts,
          deliveryReceiptRecords: options.deliveryReceiptRecords,
          coordinationText: options.coordinationText || '',
          workAssignments,
          resumedGate,
        })
        slots = result.slots
        if (result.synthesisRecovery) synthesisRecovery = result.synthesisRecovery
        if (result.workReceipts) {
          workReceipts = result.workReceipts
          controller.v4WorkReceipts = workReceipts
        }
        return result
      }
      if (!['challenge', 'verification'].includes(phase) || pending.length <= 1) {
        return runPending(pending)
      }
      const aggregate = {
        slots,
        receiptRecords,
        phaseReceipts: [],
        phasePendingMessages: [],
        failures: [],
        synthesisPendingMessage: null,
        ok: true,
      }
      for (const kind of pending) {
        const result = await runPending([kind])
        aggregate.slots = result.slots
        aggregate.phaseReceipts.push(...(result.phaseReceipts || []))
        aggregate.phasePendingMessages.push(...(result.phasePendingMessages || []))
        aggregate.failures.push(...(result.failures || []))
        if (!result.ok) aggregate.ok = false
      }
      return aggregate
    }
    const commitPhaseMessages = (phase, result) => {
      // Proposal/work runners commit each pending Agent message at the same
      // time they persist its receipt and slot. Replaying those messages here
      // creates a second commit attempt with live metadata and can reject a
      // valid first-round result as LOCAL_RUN_COMMIT_INVALID.
      return (result?.phasePendingMessages || []).filter(item => (
        item?.pendingMessage?.content && item.kind
      )).length
    }
    const removePhaseFailures = (result) => {
      const failedKinds = [...new Set((result?.failures || [])
        .filter((item) => {
          const failure = normalizeFailure(item.error)
          return !['budget', 'cancellation', 'permission'].includes(failure.category)
            && !failure.code.startsWith('COLLABORATION_CONTROL_')
        })
        .map(item => item.kind)
        .filter(Boolean))]
      const removed = []
      for (const kind of failedKinds) {
        const failure = (result?.failures || []).find(item => item.kind === kind)?.error
        // Every failure is a run-scoped exclusion. Group membership is never
        // edited, so a later turn can use the Agent again.
        const didRemove = this.shouldPauseFailedAgent(failure)
          ? this.pauseFailedAgentForRun(group, controller, kind, threadRootId, failure)
          : false
        // The failed slot is still isolated from this run's active queue even
        // when its configured group membership is retained.
        removed.push(kind)
        if (didRemove) {
          removedKinds.add(kind)
        }
      }
      return removed
    }
    const finalStatus = (status) => {
      if (status !== 'completed') return status
      if (!removedKinds.size && !controller.failedKinds.length) return status
      controller.failedKinds = [...new Set([...controller.failedKinds, ...removedKinds])]
      return 'partial'
    }
    const addRoundLimitNotice = () => {
      if (this.state().messages.some(message => (
        message.threadRootId === threadRootId
          && message.system?.key === 'system.autoRoundLimit'
      ))) return
      this.addMessage(
        group.id,
        'system',
        `Automatic discussion reached its ${controller.maxRounds || 6}-round limit. The latest replies above are the current result.`,
        '',
        threadRootId,
        { key: 'system.autoRoundLimit', params: { rounds: controller.maxRounds || 6 } },
      )
    }
    const requestStableGate = async (convergence) => {
      if (!this.requestHumanGate) return 'round-limit'
      const gateAgentRunId = this.v4OperationId(controller, writerKind, 'human-gate',
        slots.find(slot => slot.agentKind === writerKind)?.slotId || '')
      const publicAgentRunId = slots.find(slot => slot.agentKind === writerKind)?.agentRunId || ''
      checkpointPhase('human-gate', [], slots)
      const gate = await this.requestHumanGate({
        type: 'decision',
        runId: controller.runId,
        agentRunId: gateAgentRunId,
        agentKind: writerKind,
        summary: 'The candidate and unresolved issues have remained unchanged for two rounds.',
        options: [
          { optionId: 'continue-discussion', name: 'Continue', kind: 'accept' },
          { optionId: 'stop-discussion', name: 'Stop', kind: 'reject' },
        ],
        request: {
          phase: 'discussion',
          round: convergence.lastCompletedRound,
          candidateHash: convergence.candidateContentHash,
          unresolvedIssueIds: [...convergence.openIssueIds],
          stateEpoch: convergence.stateEpoch,
        },
      }, {
        signal: controller.signal,
        preserveOnAbort: () => controller.stopReason === 'shutdown',
        continuation: {
          resumeKind: 'v4_human_gate',
          agentRunId: gateAgentRunId,
          ...(publicAgentRunId ? { publicAgentRunId } : {}),
          agentKind: writerKind,
          round: convergence.lastCompletedRound,
          stateEpoch: convergence.stateEpoch,
        },
      })
      if (gate.status !== 'approved') {
        if (gate.gateId) this.completeHumanGateContinuation?.(
          controller.runId, gate.gateId, 'cancelled',
        )
        return 'stopped'
      }
      const current = controller.orchestration?.convergence
      if (!current || current.stateEpoch !== convergence.stateEpoch
          || current.stateKey !== convergence.stateKey) {
        throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
      }
      controller.orchestration = {
        ...controller.orchestration,
        convergence: { ...current, acknowledgedGateEpoch: current.stateEpoch },
      }
      if (gate.gateId && this.completeHumanGateContinuation?.(
        controller.runId, gate.gateId, 'completed',
      ) !== true && this.hasRunLedger()) throw new Error('LOCAL_RUN_PERSIST_FAILED')
      return 'continue'
    }
    const requestSynthesisRecoveryGate = async () => {
      const binding = synthesisRecovery?.pendingGate
      if (!binding || !this.requestHumanGate) return 'failed'
      const publicAgentRunId = slots.find(slot => (
        slot.slotId === binding.slotId && slot.agentKind === binding.writerKind
      ))?.agentRunId || ''
      const permissionContinuation = controller.continuation
      if (permissionContinuation?.gateType === 'permission'
          && permissionContinuation.resumeKind === 'agent_slot'
          && permissionContinuation.phase === 'synthesis'
          && permissionContinuation.agentKind === binding.writerKind
          && permissionContinuation.slotId === binding.slotId
          && permissionContinuation.operationId === binding.operationId) {
        if (this.completeHumanGateContinuation?.(
          controller.runId, permissionContinuation.gateId, 'completed',
        ) !== true && this.hasRunLedger()) throw new Error('LOCAL_RUN_PERSIST_FAILED')
      }
      slots = slots.map(slot => slot.status === 'running'
        ? { ...slot, status: 'waiting' }
        : slot)
      checkpointPhase('human-gate', [], slots)
      const gate = await this.requestHumanGate({
        type: 'decision',
        runId: controller.runId,
        agentRunId: binding.operationId,
        agentKind: binding.writerKind,
        summary: 'The workspace-write synthesis attempt may have produced side effects, but its result is unknown.',
        options: [
          { optionId: 'retry-original-writer', name: 'Retry original writer', kind: 'accept' },
          ...(binding.proposedReplacementKind ? [{
            optionId: 'replace-next-writer', name: 'Replace with next writer', kind: 'accept',
          }] : []),
          { optionId: 'stop-discussion', name: 'Stop', kind: 'reject' },
        ],
        request: {
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
        },
      }, {
        signal: controller.signal,
        preserveOnAbort: () => controller.stopReason === 'shutdown',
        continuation: {
          resumeKind: 'v4_synthesis_recovery',
          agentRunId: binding.operationId,
          ...(publicAgentRunId ? { publicAgentRunId } : {}),
          agentKind: binding.writerKind,
          round: binding.round,
          stateEpoch: binding.stateEpoch,
        },
      })
      if (gate.status !== 'approved' || gate.optionId === 'stop-discussion') {
        synthesisRecovery = this.v4CancelSynthesisRecovery(synthesisRecovery)
        checkpointPhase('human-gate', [], slots)
        if (gate.gateId) this.completeHumanGateContinuation?.(
          controller.runId, gate.gateId, 'cancelled',
        )
        return 'stopped'
      }
      if (!['retry-original-writer', 'replace-next-writer'].includes(gate.optionId)) {
        throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
      }
      const nextWriterKind = gate.optionId === 'replace-next-writer'
        ? binding.proposedReplacementKind
        : binding.writerKind
      if (!nextWriterKind) throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
      if (gate.gateId && this.completeHumanGateContinuation?.(
        controller.runId, gate.gateId, 'completed',
      ) !== true && this.hasRunLedger()) throw new Error('LOCAL_RUN_PERSIST_FAILED')
      synthesisRecovery = this.v4AppendSynthesisAttempt(
        controller, coordinationPlan || synthesisBinding, synthesisRecovery, slots, nextWriterKind,
      )
      writerKind = synthesisRecovery.activeWriterKind
      const nextAttempt = this.v4ActiveSynthesisAttempt(synthesisRecovery)
      slots = slots.map((slot) => {
        if (slot.agentKind !== writerKind) return { ...slot, permission: 'read-only' }
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
          permission: group.allowWrite === true ? 'workspace-write' : 'read-only',
        }
      })
      checkpointPhase('synthesis', [writerKind], slots)
      return 'continue'
    }

    let round = Math.max(1, Number(existing?.round) || controller.currentRound || 1)
    const acknowledgedGateResume = resume === true
      && existing?.phase === 'challenge'
      && existing.convergence?.acknowledgedGateEpoch === existing.convergence?.stateEpoch
      && existing.convergence?.lastCompletedRound === round
      && controller.continuation?.resumeKind === 'v4_human_gate'
      && controller.continuation?.state === 'completed'
    if (acknowledgedGateResume) {
      this.assertV4PhaseCanAdvance(controller)
      round += 1
      controller.currentRound = round
      challengeBindings = null
    }
    let proposalComplete = activeKinds.every(kind => Boolean(latestFor('proposal', kind)))
    const legacyBoundRun = Boolean(synthesisBinding && !coordinationPlan)
    const postChallengePhases = new Set([
      'coordination', 'work', 'synthesis', 'verification',
      'human-gate', 'commit', 'committed', 'completed',
    ])
    const challengeObservable = existing && (
      postChallengePhases.has(existing.phase)
      || existing.slots?.some(slot => (
        (slot.phase === 'challenge' && slot.status !== 'planned')
        || postChallengePhases.has(slot.phase)
        || (slot.resultRefs?.workflowOutcomeRefs || []).some(item => (
          item?.receipt?.phase === 'challenge'
        ))
      ))
    )
    if (!coordinationPlan && !legacyBoundRun
        && !challengeBindings && challengeObservable && !acknowledgedGateResume) {
      throw new Error('LOCAL_RUN_V4_CHALLENGE_BINDING_REQUIRED')
    }
    if (!coordinationPlan && !legacyBoundRun
        && challengeBindings?.some(binding => binding.round !== round)) {
      throw new Error('LOCAL_RUN_V4_CHALLENGE_BINDING_INVALID')
    }
    if (existing?.candidateCommit) {
      const verificationKinds = synthesisRecovery?.verificationKinds
        || coordinationPlan?.verifierKinds
        || synthesisBinding?.verificationKinds
        || []
      const validationSlots = slots.map(slot => (
        slot.agentKind === writerKind && slot.phase === 'completed'
          ? { ...slot, phase: 'synthesis' }
          : slot
      ))
      const acceptance = this.v4Acceptance(
        receiptRecords, activeKinds, writerKind, verificationKinds,
        {
          runId: controller.runId,
          round,
          slots: validationSlots,
          challengeBindings,
          previousConvergence: null,
          coordinationPlan,
          workReceipts,
        },
      )
      if (!acceptance.accepted
          || acceptance.candidateArtifactId !== existing.candidateCommit.candidateArtifactId
          || acceptance.candidateHash !== existing.candidateCommit.candidateContentHash) {
        throw new Error('LOCAL_RUN_V4_CANDIDATE_INVALID')
      }
      return this.v4CommitAcceptedCandidate({
        group, controller, threadRootId, targetKinds, batchId, snapshotRecord, snapshotHash,
        slots, receiptRecords, challengeBindings, synthesisBinding, synthesisRecovery,
        coordinationPlan, workReceipts, convergence: existing.convergence,
        writerKind, verificationKinds, acceptance, participantKinds: activeKinds,
      })
    }
    if (this.naturalAgentResponses && !coordinationPlan && !synthesisBinding && !synthesisRecovery) {
      return this.runV4NaturalDiscussion(group, controller, threadRootId, context, {
        resume,
        resumedGate,
        targetKinds,
        activeKinds,
        writerKind,
        batchId,
        snapshot,
        snapshotRecord,
        snapshotHash,
        slots,
        receiptRecords,
        latestFor,
        runPhase,
        checkpointPhase,
        removePhaseFailures,
        addRoundLimitNotice,
      })
    }
    while (!controller.signal.aborted) {
      controller.currentRound = round
      if (!proposalComplete) {
        const proposal = await runPhase('proposal', activeKinds)
        commitPhaseMessages('proposal', proposal)
        if (!proposal.ok) {
          const failedKinds = removePhaseFailures(proposal)
          activeKinds = activeKinds.filter(kind => !failedKinds.includes(kind))
          checkpointPhase('proposal', [], slots)
          if (!failedKinds.length || activeKinds.length < 2) {
            return proposal.phasePendingMessages?.length ? 'partial' : 'failed'
          }
        }
        proposalComplete = activeKinds.every(kind => Boolean(latestFor('proposal', kind)))
        if (!proposalComplete) {
          return activeKinds.some(kind => Boolean(latestFor('proposal', kind))) ? 'partial' : 'failed'
        }
      }

      if (!coordinationPlan && !legacyBoundRun) {
        if (round === 1) {
          if (!controller.unlimitedRounds && round >= (controller.maxRounds || 6)) {
            addRoundLimitNotice()
            return 'round-limit'
          }
          this.assertV4PhaseCanAdvance(controller)
          round = 2
          controller.currentRound = round
        }

        if (!challengeBindings || challengeBindings[0]?.round !== round) {
          const activeSet = new Set(activeKinds)
          slots = slots.map((slot) => {
            if (!activeSet.has(slot.agentKind)) return slot
            const { agentRunId: _agentRunId, ...retainedSlot } = slot
            return {
              ...retainedSlot,
              phase: 'challenge',
              status: 'planned',
              operationId: this.v4OperationId(
                controller, slot.agentKind, 'challenge', slot.slotId,
              ),
              receiptId: '',
              resultHash: '',
              startedAt: Date.now(),
              finishedAt: null,
              commitStatus: 'pending',
              permission: 'read-only',
            }
          })
          challengeBindings = this.v4ChallengeBindings({
            controller,
            targetKinds: activeKinds,
            round,
            snapshotRecord,
            slots,
            receiptRecords,
          })
          checkpointPhase('challenge', activeKinds, slots, challengeBindings)
          this.emitChanged()
        }

        const knownCoordination = this.v4CoordinationResult({
          receiptRecords,
          targetKinds: activeKinds,
          snapshotHash,
          snapshot,
          requireSupport: false,
        })
        const challenge = await runPhase('challenge', activeKinds, challengeBindings, {
          coordinationText: this.v4CoordinationText(knownCoordination),
        })
        commitPhaseMessages('challenge', challenge)
        if (!challenge.ok) {
          if (controller.signal.aborted) return 'stopped'
          const failedKinds = removePhaseFailures(challenge)
          activeKinds = activeKinds.filter(kind => !failedKinds.includes(kind))
          if (!failedKinds.length || activeKinds.length < 2
              || (!controller.unlimitedRounds && round >= (controller.maxRounds || 6))) {
            return challenge.phasePendingMessages?.length ? 'partial' : 'failed'
          }
          this.assertV4PhaseCanAdvance(controller)
          round += 1
          controller.currentRound = round
          challengeBindings = null
          this.emitChanged()
          continue
        }
        if (controller.signal.aborted) return terminalRunStatusForReason(controller.stopReason)

        const coordination = this.v4CoordinationResult({
          receiptRecords,
          targetKinds: activeKinds,
          snapshotHash,
          snapshot,
          challengeBindings,
        })
        if (!coordination.plan) {
          if (!controller.unlimitedRounds && round >= (controller.maxRounds || 6)) {
            addRoundLimitNotice()
            return 'round-limit'
          }
          this.assertV4PhaseCanAdvance(controller)
          round += 1
          controller.currentRound = round
          challengeBindings = null
          this.emitChanged()
          continue
        }
        coordinationPlan = coordination.plan
        writerKind = coordinationPlan.finalizerKind
        this.v4CheckpointPhase(group, controller, {
          targetKinds,
          participantKinds: activeKinds,
          phase: 'coordination',
          batchId,
          snapshotRecord,
          snapshotHash,
          slots,
          writerKind,
          currentKinds: [],
          pendingKinds: [],
          receipts: receiptRecords,
          challengeBindings,
          coordinationPlan,
        })
        this.emitChanged()
      }

      if (coordinationPlan) {
        while (!controller.signal.aborted) {
          const workState = this.v4WorkState(workReceipts, coordinationPlan)
          if (!workState.pending.length) break
          if (!workState.ready.length) return 'failed'
          const readyAssignments = []
          const readyOwners = new Set()
          for (const assignment of workState.ready) {
            if (readyOwners.has(assignment.ownerKind)) continue
            readyOwners.add(assignment.ownerKind)
            readyAssignments.push(assignment)
          }
          const readyKinds = activeKinds.filter(kind => readyOwners.has(kind))
          const completedBefore = workState.completed.size
          const work = await runPhase('work', readyKinds, challengeBindings, {
            deliveryReceiptRecords: [...receiptRecords],
            workAssignments: readyAssignments,
          })
          if (!work.ok) return controller.signal.aborted ? 'stopped' : 'failed'
          const completedAfter = this.v4WorkState(workReceipts, coordinationPlan).completed.size
          if (completedAfter <= completedBefore) return 'failed'
        }
        if (controller.signal.aborted) return terminalRunStatusForReason(controller.stopReason)
        writerKind = coordinationPlan.finalizerKind
      } else {
        writerKind = synthesisRecovery?.activeWriterKind || synthesisBinding.writerKind
      }

      const roleBinding = coordinationPlan || synthesisBinding
      if (!roleBinding) return 'failed'
      if (!synthesisRecovery) {
        synthesisRecovery = this.v4CreateSynthesisRecovery(
          controller,
          roleBinding,
          slots,
          { stateEpoch: controller.orchestration?.convergence?.stateEpoch || 0 },
        )
        writerKind = synthesisRecovery.activeWriterKind
      } else if (!this.v4ActiveSynthesisAttempt(synthesisRecovery)) {
        const latestAttempt = synthesisRecovery.attempts.at(-1)
        const currentRoundOperationId = latestAttempt
          ? this.v4SynthesisAttemptOperationId(
              controller,
              latestAttempt.writerKind,
              latestAttempt.slotId,
              latestAttempt.attempt,
            )
          : ''
        if (latestAttempt?.status === 'completed'
            && latestAttempt.operationId !== currentRoundOperationId) {
          synthesisRecovery = this.v4AppendSynthesisAttempt(
            controller,
            roleBinding,
            synthesisRecovery,
            slots,
            synthesisRecovery.activeWriterKind,
          )
        }
      }
      let activeAttempt = this.v4ActiveSynthesisAttempt(synthesisRecovery)
      if (activeAttempt?.status === 'leased'
          && activeAttempt.permission === 'workspace-write'
          && activeAttempt.leaseAcquired === true) {
        const acceptedReceipt = this.v4TrustedSynthesisResult({
          controller,
          slots,
          activeAttempt,
          synthesisRecovery,
          coordinationPlan,
          snapshotHash,
        })
        if (!acceptedReceipt) {
          synthesisRecovery = this.v4UpdateSynthesisAttempt(
            synthesisRecovery,
            activeAttempt.operationId,
            {
              status: 'unknown_outcome',
              sideEffectsPossible: true,
              outcomeCertainty: 'unknown_outcome',
            },
          )
          synthesisRecovery = {
            ...synthesisRecovery,
            pendingGate: this.v4SynthesisRecoveryGate(controller, synthesisRecovery),
          }
          activeAttempt = this.v4ActiveSynthesisAttempt(synthesisRecovery)
        }
      }
      if (activeAttempt?.status === 'unknown_outcome') {
        if (!synthesisRecovery.pendingGate) {
          synthesisRecovery = {
            ...synthesisRecovery,
            pendingGate: this.v4SynthesisRecoveryGate(controller, synthesisRecovery),
          }
        }
        const recoveryResult = await requestSynthesisRecoveryGate()
        if (recoveryResult !== 'continue') return recoveryResult
      }
      let verificationKinds = [...synthesisRecovery.verificationKinds]
      let synthesis = null
      while (!controller.signal.aborted) {
        writerKind = synthesisRecovery.activeWriterKind
        verificationKinds = [...synthesisRecovery.verificationKinds]
        synthesis = await runPhase('synthesis', [writerKind])
        if (synthesis.ok) break
        if (controller.signal.aborted) return 'stopped'
        const failedAttempt = [...synthesisRecovery.attempts].reverse()[0]
        if (failedAttempt?.status === 'unknown_outcome') {
          const recoveryResult = await requestSynthesisRecoveryGate()
          if (recoveryResult !== 'continue') return recoveryResult
          continue
        }
        const replacement = coordinationPlan
          ? null
          : this.v4ReplaceSynthesisWriter(
              controller, synthesisBinding, synthesisRecovery, slots,
            )
        if (!replacement) return 'failed'
        synthesisRecovery = replacement
        writerKind = replacement.activeWriterKind
        verificationKinds = [...replacement.verificationKinds]
      }
      if (!synthesis?.ok) return controller.signal.aborted ? 'stopped' : 'failed'
      let synthesisPendingMessage = synthesis.synthesisPendingMessage
      const synthesisReceipt = latestFor('synthesis', writerKind)
      if (!synthesisPendingMessage && synthesisReceipt) {
        const candidateArtifactId = synthesisReceipt.receipt.artifactIds?.[0]
        let candidateContent = ''
        if (candidateArtifactId) {
          try { candidateContent = this.v4ArtifactIdentity(candidateArtifactId).content } catch {}
        }
        synthesisPendingMessage = {
          groupId: group.id,
          role: 'agent',
          content: candidateContent
            || synthesisReceipt.receipt.conclusion
            || synthesisReceipt.receipt.summary,
          agentKind: writerKind,
          threadRootId,
          system: null,
          metadata: {},
        }
      }
      if (!synthesisPendingMessage) return 'failed'
      const previousConvergence = controller.orchestration?.convergence || null
      this.v4RoundState(
        receiptRecords, activeKinds, writerKind, verificationKinds,
        {
          runId: controller.runId,
          round,
          slots,
          challengeBindings,
          previousConvergence,
          coordinationPlan,
          includeVerification: false,
        },
      )
      const verification = await runPhase('verification', verificationKinds)
      if (!verification.ok) return controller.signal.aborted ? 'stopped' : 'partial'

      const acceptance = this.v4Acceptance(
        receiptRecords, activeKinds, writerKind, verificationKinds,
        {
          runId: controller.runId,
          round,
          slots,
          challengeBindings,
          previousConvergence,
          coordinationPlan,
          workReceipts,
        },
      )
      const convergence = this.v4NextConvergence(
        previousConvergence,
        {
          artifactId: acceptance.candidateArtifactId,
          contentHash: acceptance.candidateHash,
        },
        acceptance.openIssueIds,
        round,
        writerKind,
      )
      this.v4CheckpointPhase(group, controller, {
        targetKinds,
        participantKinds: activeKinds,
        phase: 'verification',
        batchId,
        snapshotRecord,
        snapshotHash,
        slots,
        writerKind,
        currentKinds: [],
        pendingKinds: [],
        receipts: receiptRecords,
        challengeBindings,
        synthesisBinding,
        coordinationPlan,
        convergence,
      })
      const acceptedStable = controller.unlimitedRounds
        ? convergence.consecutiveStableRounds >= 2
        : round >= (controller.maxRounds || 6)
      if (acceptance.accepted && acceptedStable) {
        return finalStatus(await this.v4CommitAcceptedCandidate({
          group, controller, threadRootId, targetKinds, batchId, snapshotRecord, snapshotHash,
          slots, receiptRecords, challengeBindings, synthesisBinding, synthesisRecovery,
          coordinationPlan, workReceipts, convergence,
          writerKind, verificationKinds, acceptance, participantKinds: activeKinds,
        }))
      }

      if (this.v4ShouldOpenStableGate(convergence, controller.unlimitedRounds)) {
        const gateResult = await requestStableGate(convergence)
        if (gateResult !== 'continue') return gateResult
      }
      if (!controller.unlimitedRounds && round >= (controller.maxRounds || 6)) {
        addRoundLimitNotice()
        return 'round-limit'
      }
      if (controller.signal.aborted) break
      this.assertV4PhaseCanAdvance(controller)
      round += 1
      controller.currentRound = round
      if (coordinationPlan) {
        challengeBindings = null
        if (Object.hasOwn(controller.orchestration || {}, 'challengeBindings')) {
          const { challengeBindings: _challengeBindings, ...orchestration } = controller.orchestration
          controller.orchestration = orchestration
        }
      }
      this.emitChanged()
    }
    return terminalRunStatusForReason(controller.stopReason)
  }

  async runRounds(group, controller, threadRootId, maxRounds, context, resume = false) {
    const {
      rootAttachments,
      rootSkillsByKind,
      rootKnowledgeBasesByKind,
    } = context
    const cursor = resume ? controller.orchestration : null
    const attachmentRecipients = new Set(cursor?.attachmentRecipients || [])
    let terminalFailureOccurred = cursor?.terminalFailureOccurred === true
    let activeKinds = cursor ? [...cursor.activeKinds] : [...controller.targetKinds]
    let executionSequence = Number(cursor?.executionSequence) || 0
    let totalSuccesses = cursor?.totalSuccesses || 0
    let consensusReached = false
    const reportedFailures = new Set()
    const firstRound = resume ? Math.max(0, controller.currentRound - 1) : 0

    for (
      let round = firstRound;
      (controller.unlimitedRounds || round < maxRounds) && !controller.signal.aborted;
      round += 1
    ) {
      const resumedRound = resume && round === firstRound
      const successfulKinds = new Set(resumedRound ? cursor.successfulKinds : [])
      const agreementKinds = new Set(resumedRound ? cursor.agreementKinds : [])
      const replacementInstructions = new Map()
      const roundQueue = resumedRound ? [...cursor.pendingKinds] : [...activeKinds]
      controller.currentRound = round + 1
      controller.completedKinds = resumedRound
        ? activeKinds.filter(kind => !roundQueue.includes(kind))
        : []
      controller.failedKinds = resumedRound
        ? controller.completedKinds.filter(kind => !successfulKinds.has(kind))
        : []
      if (!resumedRound) {
        this.checkpointOrchestration(group, controller, {
          currentKind: '',
          pendingKinds: [...roundQueue],
          activeKinds: [...activeKinds],
          successfulKinds: [],
          agreementKinds: [],
          attachmentRecipients: [...attachmentRecipients],
          totalSuccesses,
          terminalFailureOccurred,
          executionSequence,
        })
      }
      this.emitChanged()

      while (roundQueue.length) {
        const kind = roundQueue.shift()
        if (!activeKinds.includes(kind)) {
          this.checkpointOrchestration(group, controller, { pendingKinds: [...roundQueue] })
          continue
        }
        if (controller.signal.aborted) break
        const executionKind = kind
        executionSequence += 1
        this.setCurrentAgent(controller, executionKind)
        this.checkpointOrchestration(group, controller, {
          currentKind: executionKind,
          pendingKinds: [...roundQueue],
          activeKinds: [...activeKinds],
          successfulKinds: [...successfulKinds],
          agreementKinds: [...agreementKinds],
          attachmentRecipients: [...attachmentRecipients],
          totalSuccesses,
          terminalFailureOccurred,
          executionSequence,
        })
        try {
          if (controller.attemptHistory.length >= MAX_RUN_AGENT_ATTEMPTS) {
            throw circuitBreakerError()
          }
          const collaborationPackage = this.prepareCollaborationPackage(
            group, controller, activeKinds, executionKind, threadRootId,
          )
          const attachments = attachmentRecipients.has(executionKind)
            ? []
            : rootAttachments.map(attachment => attachment.path)
          const invocation = await this.invokeWithUnauthorizedRecovery({
            group,
            kind: executionKind,
            controller,
            activeKinds,
            threadRootId,
            context: {
              attachments,
              attachmentSnapshots: attachments.length ? rootAttachments : [],
              skillHints: rootSkillsByKind.get(executionKind) || [],
              knowledgeBaseHints: rootKnowledgeBasesByKind.get(executionKind) || [],
              runtimeInstruction: replacementInstructions.get(executionKind) || '',
              collaborationPackage,
              contextOptions: {
                focusUserMessageId: threadRootId,
                omitAgentThreadRootId: threadRootId,
              },
              executionSequence,
            },
            reportedFailures,
          })
          replacementInstructions.delete(executionKind)
          if (invocation.control?.action === 'replace') {
            this.recordAgentInterruption(
              group.id, executionKind, invocation.error, threadRootId, 'stopped', reportedFailures,
            )
            if (!controller.failedKinds.includes(executionKind)) {
              controller.failedKinds.push(executionKind)
            }
            if (!controller.completedKinds.includes(executionKind)) {
              controller.completedKinds.push(executionKind)
            }
            successfulKinds.delete(executionKind)
            agreementKinds.delete(executionKind)
            const replacementKind = invocation.control.replacementKind
            activeKinds = activeKinds.filter(activeKind => activeKind !== executionKind)
            replacementInstructions.set(
              replacementKind,
              this.replacementInstruction(executionKind),
            )
            if (!roundQueue.includes(replacementKind)) roundQueue.unshift(replacementKind)
            controller.currentKind = ''
            controller.progress = []
            this.checkpointOrchestration(group, controller, {
              currentKind: '',
              pendingKinds: [...roundQueue],
              activeKinds: [...activeKinds],
              successfulKinds: [...successfulKinds],
              agreementKinds: [...agreementKinds],
            })
            this.emitChanged()
            continue
          }
          if (invocation.control?.action === 'cancel') {
            this.recordAgentInterruption(
              group.id, executionKind, invocation.error, threadRootId, 'stopped', reportedFailures,
            )
            if (!controller.failedKinds.includes(executionKind)) {
              controller.failedKinds.push(executionKind)
            }
            if (!controller.completedKinds.includes(executionKind)) {
              controller.completedKinds.push(executionKind)
            }
            successfulKinds.delete(executionKind)
            agreementKinds.delete(executionKind)
            controller.currentKind = ''
            controller.progress = []
            this.checkpointOrchestration(group, controller, {
              currentKind: '',
              pendingKinds: [...roundQueue],
              successfulKinds: [...successfulKinds],
              agreementKinds: [...agreementKinds],
            })
            this.emitChanged()
            continue
          }
          const result = invocation.result
          if (attachments.length) attachmentRecipients.add(executionKind)
          successfulKinds.add(executionKind)
          if (result.consensus) agreementKinds.add(executionKind)
          else agreementKinds.delete(executionKind)
          this.recordCollaborationResult(
            group, controller, activeKinds, executionKind, result,
          )
        } catch (error) {
          if (circuitBreakerFailure(error)) {
            controller.stopReason = 'circuit_breaker'
            controller.abort()
            break
          }
          const hardBudget = hardBudgetFailure(error)
          if (hardBudget) {
            this.recordAgentFailure(
              group.id, executionKind, error, threadRootId, reportedFailures,
            )
            successfulKinds.delete(executionKind)
            agreementKinds.delete(executionKind)
            if (!controller.failedKinds.includes(executionKind)) {
              controller.failedKinds.push(executionKind)
            }
            if (!controller.completedKinds.includes(executionKind)) {
              controller.completedKinds.push(executionKind)
            }
            terminalFailureOccurred = true
            controller.stopReason = 'hard_budget'
            controller.abort()
            break
          }
          if (controller.signal.aborted) {
            const interruptedKind = controller.currentKind || executionKind
            if (error?.runTrace) {
              this.recordAgentInterruption(
                group.id,
                interruptedKind,
                error,
                threadRootId,
                controller.stopReason === 'shutdown' ? 'interrupted' : 'stopped',
                reportedFailures,
              )
              if (!controller.completedKinds.includes(interruptedKind)) {
                controller.completedKinds.push(interruptedKind)
              }
              controller.currentKind = ''
              controller.progress = []
              this.emitChanged()
            }
            break
          }
          this.recordAgentFailure(
            group.id, executionKind, error, threadRootId, reportedFailures,
          )
          successfulKinds.delete(executionKind)
          agreementKinds.delete(executionKind)
          if (!controller.failedKinds.includes(executionKind)) {
            controller.failedKinds.push(executionKind)
          }
          terminalFailureOccurred = true
          // Failed CLIs leave only this run's active queue; the configured
          // group keeps them so the next turn can retry.
          if (this.shouldPauseFailedAgent(error)) {
            this.pauseFailedAgentForRun(group, controller, executionKind, threadRootId, error)
          }
          activeKinds = activeKinds.filter(activeKind => activeKind !== executionKind)
        }
        if (controller.signal.aborted) break
        if (!controller.completedKinds.includes(executionKind)) {
          controller.completedKinds.push(executionKind)
        }
        controller.currentKind = ''
        controller.progress = []
        this.checkpointOrchestration(group, controller, {
          currentKind: '',
          pendingKinds: [...roundQueue],
          activeKinds: [...activeKinds],
          successfulKinds: [...successfulKinds],
          agreementKinds: [...agreementKinds],
          attachmentRecipients: [...attachmentRecipients],
          totalSuccesses,
          terminalFailureOccurred,
          executionSequence,
        })
        this.emitChanged()
      }

      if (controller.signal.aborted) break
      const successes = activeKinds.filter(kind => successfulKinds.has(kind)).length
      const agreements = activeKinds.filter(kind => agreementKinds.has(kind)).length
      totalSuccesses += successes
      this.checkpointOrchestration(group, controller, {
        currentKind: '',
        pendingKinds: [],
        activeKinds: [...activeKinds],
        successfulKinds: [...successfulKinds],
        agreementKinds: [...agreementKinds],
        attachmentRecipients: [...attachmentRecipients],
        totalSuccesses,
        terminalFailureOccurred,
        executionSequence,
      })
      if (activeKinds.length < 2) break
      const crossReviewComplete = !controller.unlimitedRounds || controller.currentRound >= 2
      if (crossReviewComplete
          && successes === activeKinds.length
          && agreements === activeKinds.length) {
        consensusReached = true
        break
      }
    }

    let runStatus
    if (controller.signal.aborted) {
      runStatus = terminalRunStatusForReason(controller.stopReason)
    } else if (terminalFailureOccurred) runStatus = totalSuccesses > 0 ? 'partial' : 'failed'
    else if (consensusReached) runStatus = 'completed'
    else runStatus = totalSuccesses > 0 ? 'round-limit' : 'failed'
    if (!terminalFailureOccurred && !controller.unlimitedRounds
        && (runStatus === 'round-limit' || runStatus === 'failed')) {
      this.addMessage(
        group.id,
        'system',
        `Automatic discussion reached its ${maxRounds}-round limit. The latest replies above are the current result.`,
        '',
        threadRootId,
        { key: 'system.autoRoundLimit', params: { rounds: maxRounds } },
      )
    }
    if (controller.stopReason === 'circuit_breaker') {
      this.addMessage(
        group.id,
        'system',
        `Automatic discussion stopped after ${MAX_RUN_AGENT_ATTEMPTS} Agent attempts.`,
        '',
        threadRootId,
        {
          key: 'system.runCircuitBreaker',
          params: { maxAttempts: MAX_RUN_AGENT_ATTEMPTS },
        },
      )
    }
    return runStatus
  }

  start(
    group, targetKinds, threadRootId, maxRounds, reservation = null, preparedContext = null,
    unlimitedRounds = false, taskGraph = null,
  ) {
    const v4 = reservation?.v4 === true
    if (!v4) reservation.orchestration = this.orchestrationCursor(targetKinds, taskGraph)
    const controller = this.beginRun(
      group.id, 'auto', targetKinds, threadRootId, reservation, maxRounds, unlimitedRounds,
    )
    controller.v4 = v4
    controller.discussionStyle = reservation?.discussionStyle || 'sequential'
    const promise = (async () => {
      let runStatus = 'failed'
      try {
        const context = await this.automaticContext(
          group, controller, threadRootId, preparedContext,
        )
        runStatus = v4
          ? await this.runV4Discussion(group, controller, threadRootId, context)
          : taskGraph
          ? await this.runTaskGraph(group, controller, threadRootId, context)
          : await this.runRounds(group, controller, threadRootId, maxRounds, context)
      } catch (error) {
        runStatus = controller.signal.aborted
          ? terminalRunStatusForReason(controller.stopReason)
          : 'failed'
        if (!controller.signal.aborted) {
          const rawReason = cleanText(error?.message || error, 2000)
          const reason = /^[A-Z][A-Z0-9_]+$/.test(rawReason)
            ? rawReason
            : 'LOCAL_AGENT_UNKNOWN_FAILURE'
          try {
            this.addMessage(
              group.id,
              'system',
              `Automatic discussion stopped: ${reason}`,
              '',
              threadRootId,
              { key: 'system.autoStopped', params: { reason } },
            )
          } catch { /* persistence failures cannot be reported through the same store */ }
        }
      } finally {
        controller.currentKind = ''
        controller.progress = []
        if (controller.signal.aborted) {
          runStatus = terminalRunStatusForReason(controller.stopReason)
        }
        await this.finishRun(group.id, controller, runStatus)
      }
    })()
    controller.promise = promise
    promise.catch(() => {})
    return controller
  }

  async resume(group, durable, controller, replayedResult = null, resumedGate = null) {
    if (controller.orchestration?.version === 4 || controller.v4 === true) {
      controller.v4 = true
      const context = {
        rootAttachments: [],
        rootSkillsByKind: new Map(controller.targetKinds.map(kind => [kind, []])),
        rootKnowledgeBasesByKind: new Map(controller.targetKinds.map(kind => [kind, []])),
      }
      return this.runV4Discussion(
        group, controller, durable.threadRootId, context, true, resumedGate,
      )
    }
    if (controller.orchestration?.version === 3) {
      const cursor = parseTaskGraphCursor(controller.orchestration.taskGraph)
      const runningNodeId = cursor.currentNodeIds.length === 1
        ? cursor.currentNodeIds[0]
        : ''
      const node = cursor.graph.nodes.find(candidate => candidate.nodeId === runningNodeId)
      if (replayedResult && node?.role !== 'human') {
        this.applyTaskGraphAgentResult(group, controller, node, replayedResult)
      }
      const context = await this.automaticContext(
        group, controller, durable.threadRootId, null,
      )
      return this.runTaskGraph(group, controller, durable.threadRootId, context)
    }
    if (controller.orchestration?.version === 1) {
      controller.orchestration = {
        ...controller.orchestration,
        version: 2,
        collaboration: emptyCollaborationState(),
      }
      const persisted = this.checkpointRun?.(group.id, controller)
      if (this.hasRunLedger() && persisted !== true) {
        throw new Error('LOCAL_RUN_PERSIST_FAILED')
      }
    }
    const context = await this.automaticContext(
      group, controller, durable.threadRootId, null,
    )
    return this.runRounds(
      group, controller, durable.threadRootId, durable.maxRounds, context, true,
    )
  }

  async resumeDecision(group, durable, controller, decision) {
    const cursor = parseTaskGraphCursor(controller.orchestration?.taskGraph)
    const waiting = cursor.nodeStates.find(state => state.status === 'waiting')
    const node = cursor.graph.nodes.find(candidate => candidate.nodeId === waiting?.nodeId)
    if (!node || node.role !== 'human') throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
    const expectedAgentRunId = this.taskGraphDecisionAgentRunId(cursor.graph.graphId, node.nodeId)
    if (durable.continuation?.agentRunId !== expectedAgentRunId) {
      throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
    }
    const accepted = this.applyTaskGraphHumanDecision(group, controller, node, decision)
    if (this.completeHumanGateContinuation?.(
      controller.runId,
      durable.continuation.gateId,
      accepted ? 'completed' : 'cancelled',
    ) !== true && this.hasRunLedger()) {
      throw new Error('LOCAL_RUN_PERSIST_FAILED')
    }
    const context = await this.automaticContext(
      group, controller, durable.threadRootId, null,
    )
    return this.runTaskGraph(group, controller, durable.threadRootId, context)
  }
}

Object.assign(
  LocalWorkspaceAutoRunner.prototype,
  v4NaturalDecisionMethods,
  v4OutcomeMethods,
)

module.exports = { LocalWorkspaceAutoRunner }

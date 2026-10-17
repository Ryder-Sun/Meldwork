// Failed, interrupted and unauthorized invocations: retry policy, pausing an Agent for the run, and recovery prompts.
const { createHash } = require('node:crypto')
const {
  MAX_RUN_AGENT_ATTEMPTS,
  boundedBackoffDelay,
  normalizeAttemptHistoryEntry,
  normalizeFailure,
  normalizeFailureOutcome,
  retryDecision,
} = require('../runs/failure-policy.cjs')
const {
  circuitBreakerError,
  sanitizedAuthenticationError,
  unauthorizedFailure,
} = require('./local-workspace-auto-runner-support.cjs')

const recoveryMethods = {
  setCurrentAgent(controller, kind) {
    controller.currentKind = kind
    controller.progress = []
    this.emitChanged()
  },

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
  },

  shouldPauseFailedAgent(error) {
    const category = normalizeFailure(error).category
    // Runtime, provider, rate-limit, protocol, and timeout failures stay
    // silent run-scoped exclusions; their own failure message explains them.
    // Authentication and compatibility failures get an explicit notice
    // because the user usually has to act (sign in or update the CLI).
    return ['authentication', 'compatibility'].includes(category)
  },

  replacementInstruction(failedKind) {
    return [
      `You are replacing ${this.agentLabel(failedKind)} for this turn.`,
      'Complete the interrupted Agent slot using the shared task context, then return your own conclusion.',
      'Do not claim that the interrupted Agent completed this work.',
    ].join('\n')
  },

  retryDelay(failedAttempt) {
    return boundedBackoffDelay(failedAttempt, {
      baseDelayMs: this.retryBaseDelayMs,
      maxDelayMs: this.retryMaxDelayMs,
    })
  },

  operationIdFor(controller, kind, mode) {
    const digest = createHash('sha256').update(JSON.stringify({
      runId: controller.runId,
      kind,
      mode,
      round: controller.currentRound || 0,
    })).digest('hex')
    return `agent-operation-${digest}`
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },
}

module.exports = { recoveryMethods }

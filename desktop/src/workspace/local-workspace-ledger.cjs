const {
  DEFAULT_MAX_OUTPUT_CHARS,
  traceCapsuleFromAgentRun,
} = require('../runs/run-harness.cjs')
const {
  MAX_SYSTEM_PARAM_TEXT_CHARS,
  RECOVERABLE_AGENT_STATUSES,
  RUN_LEDGER_CHECKPOINT_DELAY_MS,
  budgetTerminalPrefix,
  cleanText,
  isSupportedAgentKind,
  normalizeLoadedMessage,
  terminalMessageContent,
  terminalStatusPrefix,
  terminalStatusPrefixFromMessage,
} = require('./local-workspace-inputs.cjs')
const { MAX_RUN_AGENT_ATTEMPTS } = require('../runs/failure-policy.cjs')

class LocalWorkspaceRunLedger {
  constructor(options) {
    this.runLedger = options.runLedger
    this.state = options.state
    this.save = options.save
    this.createId = options.createId
    this.now = options.now
    this.agentLabel = options.agentLabel
    this.preserveWaitingRun = options.preserveWaitingRun
    this.preparingRuns = options.preparingRuns
    this.timers = options.timers
  }

  restoreInterruptedRuns() {
    let recovered = []
    let records = []
    try {
      recovered = this.runLedger?.recoverInterrupted?.({
        preserveWaitingRun: this.preserveWaitingRun,
      }) || []
      records = this.runLedger?.list?.() || recovered
    } catch {
      return
    }
    const state = this.state()
    let changed = false
    for (const record of records) {
      const group = state.groups.find(item => item.id === record.groupId)
      if (!group) {
        try { this.runLedger?.deleteGroup?.(record.groupId) } catch {}
        continue
      }
      const agentRuns = Array.isArray(record.agentRuns) ? record.agentRuns : []
      const latestAttemptByKind = new Map()
      for (const attempt of Array.isArray(record.attemptHistory) ? record.attemptHistory : []) {
        const previous = latestAttemptByKind.get(attempt.agentKind)
        if (!previous || attempt.sequence > previous.sequence) {
          latestAttemptByKind.set(attempt.agentKind, attempt)
        }
      }
      const latestTerminalFailureByKind = new Map()
      for (const agentRun of agentRuns) {
        if (['failed', 'timeout'].includes(String(agentRun?.status || '').toLowerCase())) {
          latestTerminalFailureByKind.set(agentRun.kind, agentRun.agentRunId)
        }
      }
      for (const agentRun of agentRuns) {
        const status = String(agentRun?.status || '').toLowerCase()
        if (!RECOVERABLE_AGENT_STATUSES.has(status)
            || !isSupportedAgentKind(agentRun?.kind)) continue
        if (['failed', 'timeout'].includes(status)) {
          const latestAttempt = latestAttemptByKind.get(agentRun.kind)
          if (latestAttempt?.finalOutcome === 'succeeded'
              || latestTerminalFailureByKind.get(agentRun.kind) !== agentRun.agentRunId) {
            continue
          }
        }
        const output = cleanText(agentRun.output, DEFAULT_MAX_OUTPUT_CHARS)
        const trace = traceCapsuleFromAgentRun({
          ...agentRun,
          summary: output || agentRun.reason || '',
        }, {
          runId: record.runId,
          status,
          context: {
            ...agentRun.context,
            ...(record.contextPackState === 'legacy-unavailable'
              && !agentRun.context?.contextPackId
              ? { contextPackState: 'legacy-unavailable' }
              : {}),
          },
        })
        if (!trace) continue
        const label = this.agentLabel(agentRun.kind)
        const completed = status === 'completed' || status === 'partial'
        const interrupted = status === 'interrupted'
        const stopped = status === 'stopped'
        const reason = cleanText(agentRun.reason, MAX_SYSTEM_PARAM_TEXT_CHARS)
          || (status === 'timeout' ? 'LOCAL_AGENT_TIMEOUT' : 'LOCAL_AGENT_UNKNOWN_FAILURE')
        const budgetExhausted = reason === 'LOCAL_BUDGET_EXHAUSTED'
          && Boolean(record.budget?.exhaustion)
        const fallbackContent = budgetExhausted
          ? budgetTerminalPrefix(label)
          : terminalStatusPrefix(label, status, reason)
        const existingMessage = state.messages.find(message => (
          message.trace?.agentRunId === trace.agentRunId
        ))
        if (existingMessage) {
          if (['completed', 'partial'].includes(existingMessage.trace?.status) && !completed) continue
          if (!completed && output) {
            const prefix = terminalStatusPrefixFromMessage(
              existingMessage, label, status, reason,
            )
            const content = terminalMessageContent(prefix, output)
            if (content !== existingMessage.content) {
              existingMessage.content = content
              changed = true
            }
          }
          continue
        }
        const duplicateStableFailure = ['failed', 'timeout'].includes(status)
          && state.messages.some(message => (
            message.groupId === group.id
              && message.role === 'system'
              && message.agentKind === agentRun.kind
              && message.system?.key === (budgetExhausted
                ? 'system.agentBudgetExhausted'
                : 'system.agentCallFailed')
              && cleanText(message.system?.params?.reason, MAX_SYSTEM_PARAM_TEXT_CHARS) === reason
              && message.trace?.runId === trace.runId
              && message.trace?.status === status
              && message.trace?.agentRunId !== trace.agentRunId
              && (!output || message.content === terminalMessageContent(fallbackContent, output))
          ))
        if (duplicateStableFailure) continue
        const exhaustion = record.budget?.exhaustion
        const system = completed
          ? null
          : interrupted
            ? { key: 'system.agentInterrupted', params: { agent: label } }
            : stopped
              ? { key: 'system.agentStopped', params: { agent: label } }
              : budgetExhausted
                ? {
                    key: 'system.agentBudgetExhausted',
                    params: {
                      agent: label,
                      dimension: exhaustion.dimension,
                      limit: exhaustion.limit,
                      priorUsed: exhaustion.priorUsed,
                      attemptedUsage: exhaustion.attemptedUsage,
                      used: exhaustion.used,
                    },
                  }
                : { key: 'system.agentCallFailed', params: { agent: label, reason } }
        const message = normalizeLoadedMessage({
          id: this.createId(),
          groupId: group.id,
          role: completed ? 'agent' : 'system',
          agentKind: agentRun.kind,
          content: completed
            ? output
            : terminalMessageContent(fallbackContent, output),
          createdAt: this.now(),
          threadRootId: record.threadRootId,
          system,
          trace,
        })
        if (!message) continue
        state.messages.push(message)
        group.updatedAt = message.createdAt
        changed = true
      }
      if (record.status === 'circuit-breaker' && !state.messages.some(message => (
        message.groupId === group.id
          && message.threadRootId === record.threadRootId
          && message.system?.key === 'system.runCircuitBreaker'
      ))) {
        const message = normalizeLoadedMessage({
          id: this.createId(),
          groupId: group.id,
          role: 'system',
          content: `Run stopped after ${MAX_RUN_AGENT_ATTEMPTS} Agent attempts.`,
          createdAt: this.now(),
          threadRootId: record.threadRootId,
          system: {
            key: 'system.runCircuitBreaker',
            params: { maxAttempts: MAX_RUN_AGENT_ATTEMPTS },
          },
        })
        if (message) {
          state.messages.push(message)
          group.updatedAt = message.createdAt
          changed = true
        }
      }
    }
    if (changed) this.save()
  }

  record(groupId, controller, status = '') {
    const group = this.state().groups.find(item => item.id === groupId)
    const agentRuns = (controller.harness?.snapshot?.() || []).map((agentRun) => {
      const reason = controller.agentFailureReasons?.get(agentRun.agentRunId) || ''
      return reason ? { ...agentRun, reason } : agentRun
    })
    return {
      runId: controller.runId,
      taskId: controller.taskId,
      contextPackId: controller.contextPackId,
      contextPackState: 'captured',
      groupId,
      threadRootId: controller.threadRootId,
      mode: controller.mode === 'auto' ? 'auto' : 'manual',
      targetKinds: controller.targetKinds,
      status: status || (this.preparingRuns.get(groupId) === controller ? 'preparing' : 'running'),
      startedAt: controller.startedAt,
      updatedAt: Date.now(),
      reason: controller.stopReason,
      permissionMode: group?.allowWrite ? 'workspace-write' : 'read-only',
      currentRound: controller.currentRound,
      maxRounds: controller.maxRounds,
      unlimitedRounds: controller.unlimitedRounds,
      budget: controller.budget?.snapshot?.(),
      attemptHistory: controller.attemptHistory,
      continuation: controller.continuation,
      orchestration: controller.orchestration,
      agentRuns,
    }
  }

  checkpoint(groupId, controller, status = '') {
    if (!this.runLedger || !controller?.runId) return false
    try {
      this.runLedger.checkpoint(this.record(groupId, controller, status))
      return true
    } catch {
      return false
    }
  }

  schedule(groupId, controller) {
    if (!this.runLedger || !controller?.runId) return
    const key = controller.runId
    const previous = this.timers.get(key)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(() => {
      this.timers.delete(key)
      this.checkpoint(groupId, controller)
    }, RUN_LEDGER_CHECKPOINT_DELAY_MS)
    timer.unref?.()
    this.timers.set(key, timer)
  }

  finish(groupId, controller, status) {
    if (!this.runLedger || !controller?.runId) return false
    const timer = this.timers.get(controller.runId)
    if (timer) clearTimeout(timer)
    this.timers.delete(controller.runId)
    let terminalRecord
    try {
      const current = this.record(groupId, controller, status)
      terminalRecord = this.runLedger.recordTerminalIntent?.(current) || current
    } catch { return false }
    try {
      this.runLedger.checkpoint(terminalRecord)
    } catch { return false }
    try {
      this.runLedger.finish?.(controller.runId, status, terminalRecord.reason || '')
      try { this.runLedger.clearTerminalIntent?.(controller.runId) } catch { /* committed state is authoritative */ }
      return true
    } catch {
      return false
    }
  }
}

module.exports = { LocalWorkspaceRunLedger }

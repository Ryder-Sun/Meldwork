const { randomUUID } = require('node:crypto')
const { RunHarness } = require('../runs/run-harness.cjs')
const { boundedBackoffDelay } = require('../runs/failure-policy.cjs')
const {
  RunBudget,
  normalizeRunBudgetConfiguration,
} = require('../runs/run-budget.cjs')
const {
  RUN_STATUSES,
  cleanRunMaxRounds,
  cleanText,
  isSupportedAgentKind,
  terminalRunStatusForReason,
} = require('./local-workspace-inputs.cjs')

const TASK_ID = /^[A-Za-z0-9._:-]{1,120}$/
const CONTEXT_PACK_ID = /^context-pack-[a-f0-9]{64}$/
const FINISHED_AGENT_STATUSES = new Set([
  'completed', 'partial', 'failed', 'stopped', 'timeout', 'interrupted',
])
const FAILED_AGENT_STATUSES = new Set(['failed', 'stopped', 'timeout'])
const TERMINAL_PERSIST_ATTEMPTS = 3

function persistenceFailure(state) {
  return Object.assign(new Error('LOCAL_RUN_TERMINAL_PERSIST_FAILED'), {
    code: 'LOCAL_RUN_TERMINAL_PERSIST_FAILED',
    persistence: { ...state },
  })
}

class LocalWorkspaceRunCoordinator {
  constructor(options) {
    this.preparingRuns = options.preparingRuns
    this.activeRuns = options.activeRuns
    this.createRunId = options.createRunId
    this.getRunSilenceWarningMs = typeof options.getRunSilenceWarningMs === 'function'
      ? options.getRunSilenceWarningMs
      : () => options.runSilenceWarningMs
    this.setTimeout = options.setTimeout || setTimeout
    this.clearTimeout = options.clearTimeout || clearTimeout
    this.isShuttingDown = options.isShuttingDown
    this.setShuttingDown = options.setShuttingDown
    this.checkpointRun = options.checkpointRun
    this.hasRunLedger = typeof options.hasRunLedger === 'function'
      ? options.hasRunLedger
      : () => false
    this.validateContextPack = options.validateContextPack
    this.finishRunCheckpoint = options.finishRunCheckpoint
    this.scheduleRunCheckpoint = options.scheduleRunCheckpoint
    this.emitChanged = options.emitChanged
    this.emit = options.emit
    this.runBudgetDefaults = normalizeRunBudgetConfiguration(options.runBudgetDefaults || {})
    this.terminalRetryBaseDelayMs = Number.isFinite(options.retryBaseDelayMs)
      ? Math.max(1, Math.floor(options.retryBaseDelayMs))
      : 250
    this.terminalRetryMaxDelayMs = Number.isFinite(options.retryMaxDelayMs)
      ? Math.max(this.terminalRetryBaseDelayMs, Math.floor(options.retryMaxDelayMs))
      : 2000
    this.terminalRetrySleep = options.terminalRetrySleep
      || (delayMs => new Promise(resolve => this.setTimeout(resolve, delayMs)))
  }

  createController(mode, targetKinds, threadRootId, maxRounds = 0, unlimitedRounds = false) {
    const controller = new AbortController()
    let done = false
    let resolveDone
    controller.done = new Promise(resolve => { resolveDone = resolve })
    controller.resolveDone = () => {
      if (done) return
      done = true
      resolveDone()
    }
    controller.mode = mode
    controller.runId = String(this.createRunId() || '')
    controller.taskId = TASK_ID.test(String(threadRootId || '')) ? String(threadRootId) : ''
    controller.contextPackId = ''
    controller.taskBound = false
    controller.targetKinds = [...targetKinds]
    controller.completedKinds = []
    controller.failedKinds = []
    controller.currentKind = ''
    controller.progress = []
    controller.threadRootId = threadRootId
    controller.currentRound = 0
    controller.unlimitedRounds = mode === 'auto' && unlimitedRounds === true
    controller.maxRounds = mode === 'auto' && !controller.unlimitedRounds
      ? cleanRunMaxRounds(maxRounds)
      : 0
    controller.startedAt = Date.now()
    controller.budget = new RunBudget({
      startedAt: controller.startedAt,
      limits: this.runBudgetDefaults.limits,
      enforcement: this.runBudgetDefaults.enforcement,
    })
    controller.stopReason = ''
    controller.harness = null
    controller.agentFailureReasons = new Map()
    controller.silenceTimers = new Map()
    controller.agentControllers = new Map()
    controller.agentSlotKinds = new Set()
    controller.agentControlRequests = new Map()
    controller.manualRetryCounts = new Map()
    controller.waitingGateIds = new Set()
    controller.attemptHistory = []
    controller.continuation = null
    controller.orchestration = null
    controller.finished = false
    controller.terminalOutbox = null
    controller.terminalPersistence = null
    controller.finishingPromise = null
    controller.terminalRetryTimer = null
    return controller
  }

  configureBudget(controller, input = {}) {
    if (!controller || controller.taskBound) throw new Error('LOCAL_RUN_BUDGET_LOCKED')
    const requested = normalizeRunBudgetConfiguration(input || {})
    controller.budget = new RunBudget({
      startedAt: controller.startedAt,
      limits: { ...this.runBudgetDefaults.limits, ...requested.limits },
      enforcement: { ...this.runBudgetDefaults.enforcement, ...requested.enforcement },
    })
    return controller.budget.snapshot()
  }

  checkpointRequired(groupId, controller, status) {
    const persisted = this.checkpointRun(groupId, controller, status)
    if (this.hasRunLedger() && persisted !== true) {
      throw new Error('LOCAL_RUN_PERSIST_FAILED')
    }
    return persisted
  }

  isGroupBusy(groupId) {
    return this.preparingRuns.has(groupId) || this.activeRuns.has(groupId)
  }

  reserve(
    groupId, mode, targetKinds, threadRootId = '', maxRounds = 0, unlimitedRounds = false,
  ) {
    if (this.isShuttingDown()) throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
    if (this.isGroupBusy(groupId)) throw new Error('LOCAL_GROUP_RUNNING')
    const controller = this.createController(
      mode, targetKinds, threadRootId, maxRounds, unlimitedRounds,
    )
    controller.groupId = groupId
    this.preparingRuns.set(groupId, controller)
    try {
      this.emitChanged()
    } catch (error) {
      if (this.preparingRuns.get(groupId) === controller) this.preparingRuns.delete(groupId)
      controller.abort()
      controller.resolveDone()
      throw error
    }
    return controller
  }

  bindTask(groupId, controller, taskId, threadRootId = '', contextPackId = '') {
    if (this.preparingRuns.get(groupId) !== controller || controller.signal.aborted) {
      throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
    }
    const nextTaskId = String(taskId || '')
    const nextThreadRootId = String(threadRootId || '')
    const nextContextPackId = String(contextPackId || '')
    if (!TASK_ID.test(nextTaskId)
        || (nextThreadRootId && !TASK_ID.test(nextThreadRootId))
        || !CONTEXT_PACK_ID.test(nextContextPackId)) {
      throw new Error('LOCAL_RUN_TASK_INVALID')
    }
    let contextPackValid = false
    try {
      contextPackValid = this.validateContextPack?.(nextContextPackId, nextTaskId) === true
    } catch { /* normalize store failures to a stable lifecycle error */ }
    if (!contextPackValid) throw new Error('LOCAL_RUN_CONTEXT_PACK_INVALID')
    const previousTaskId = controller.taskId
    const previousThreadRootId = controller.threadRootId
    const previousContextPackId = controller.contextPackId
    controller.taskId = nextTaskId
    controller.threadRootId = nextThreadRootId
    controller.contextPackId = nextContextPackId
    try {
      this.checkpointRequired(groupId, controller, 'preparing')
      controller.taskBound = true
    } catch (error) {
      controller.taskId = previousTaskId
      controller.threadRootId = previousThreadRootId
      controller.contextPackId = previousContextPackId
      throw error
    }
    this.emitChanged()
    return true
  }

  releasePreparation(groupId, controller) {
    if (this.preparingRuns.get(groupId) !== controller) return false
    this.preparingRuns.delete(groupId)
    if (controller.taskBound) {
      this.finishRunCheckpoint(
        groupId,
        controller,
        controller.signal.aborted
          ? terminalRunStatusForReason(controller.stopReason)
          : 'failed',
      )
    }
    try {
      this.emitChanged()
    } finally {
      controller.resolveDone()
    }
    return true
  }

  begin(
    groupId, mode, targetKinds, threadRootId, reservation = null, maxRounds = 0,
    unlimitedRounds = false,
  ) {
    if (this.isShuttingDown()) throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
    let controller = reservation
    const reserved = Boolean(controller)
    if (controller) {
      if (this.preparingRuns.get(groupId) !== controller || controller.signal.aborted) {
        throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
      }
      if (this.activeRuns.has(groupId)) throw new Error('LOCAL_GROUP_RUNNING')
      if (!controller.taskBound
          || !TASK_ID.test(String(controller.taskId || ''))
          || !CONTEXT_PACK_ID.test(String(controller.contextPackId || ''))) {
        throw new Error('LOCAL_RUN_TASK_INVALID')
      }
    } else {
      throw new Error('LOCAL_RUN_TASK_INVALID')
    }
    controller.mode = mode
    controller.groupId = groupId
    controller.taskId = TASK_ID.test(String(controller.taskId || ''))
      ? controller.taskId
      : (TASK_ID.test(String(threadRootId || '')) ? String(threadRootId) : '')
    controller.targetKinds = [...targetKinds]
    controller.completedKinds = []
    controller.failedKinds = []
    controller.currentKind = ''
    controller.progress = []
    controller.threadRootId = threadRootId
    controller.currentRound = 0
    controller.unlimitedRounds = mode === 'auto'
      && (unlimitedRounds === true || controller.unlimitedRounds === true)
    controller.maxRounds = mode === 'auto' && !controller.unlimitedRounds
      ? cleanRunMaxRounds(maxRounds || controller.maxRounds)
      : 0
    controller.startedAt = Date.now()
    controller.stopReason = ''
    this.activeRuns.set(groupId, controller)
    try {
      this.checkpointRequired(groupId, controller, 'running')
      if (reserved) this.preparingRuns.delete(groupId)
      this.emitChanged()
    } catch (error) {
      if (this.activeRuns.get(groupId) === controller) this.activeRuns.delete(groupId)
      if (reserved) this.preparingRuns.set(groupId, controller)
      else {
        controller.abort()
        controller.resolveDone()
      }
      throw error
    }
    return controller
  }

  resume(record) {
    if (this.isShuttingDown() || !record || typeof record !== 'object') {
      throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
    }
    const groupId = String(record.groupId || '')
    if (!groupId || this.isGroupBusy(groupId)
        || !TASK_ID.test(String(record.taskId || ''))
        || !CONTEXT_PACK_ID.test(String(record.contextPackId || ''))
        || !record.continuation
        || !['pending', 'ready', 'resuming'].includes(record.continuation.state)) {
      throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
    }
    if (this.validateContextPack?.(record.contextPackId, record.taskId) !== true) {
      throw new Error('LOCAL_RUN_CONTEXT_PACK_INVALID')
    }
    const controller = this.createController(
      record.mode,
      record.targetKinds,
      record.threadRootId,
      record.maxRounds,
      record.unlimitedRounds,
    )
    controller.runId = record.runId
    controller.taskId = record.taskId
    controller.contextPackId = record.contextPackId
    controller.taskBound = true
    controller.groupId = groupId
    controller.currentRound = record.currentRound || 0
    controller.startedAt = record.startedAt
    controller.attemptHistory = [...(record.attemptHistory || [])]
    controller.orchestration = record.orchestration ? structuredClone(record.orchestration) : null
    const targetKinds = new Set(controller.targetKinds)
    const latestAgentStatuses = new Map()
    for (const agentRun of Array.isArray(record.agentRuns) ? record.agentRuns : []) {
      if (!targetKinds.has(agentRun?.kind) || !isSupportedAgentKind(agentRun.kind)
          || !FINISHED_AGENT_STATUSES.has(agentRun.status)) continue
      latestAgentStatuses.set(agentRun.kind, agentRun.status)
    }
    controller.completedKinds = [...latestAgentStatuses.keys()]
    controller.failedKinds = [...latestAgentStatuses]
      .filter(([, status]) => FAILED_AGENT_STATUSES.has(status))
      .map(([kind]) => kind)
    controller.continuation = { ...record.continuation, state: 'resuming', updatedAt: Date.now() }
    controller.waitingGateIds = new Set([record.continuation.gateId])
    controller.harness = new RunHarness({
      runId: record.runId,
      groupId,
      threadRootId: record.threadRootId,
      targetKinds: record.targetKinds,
      agentRuns: record.agentRuns,
    })
    if (record.budget) {
      controller.budget = new RunBudget({
        ...record.budget,
        now: Date.now,
      })
    }
    this.activeRuns.set(groupId, controller)
    try {
      this.checkpointRequired(groupId, controller, 'running')
      this.emitChanged()
    } catch (error) {
      this.activeRuns.delete(groupId)
      controller.abort()
      controller.resolveDone()
      throw error
    }
    return controller
  }

  finish(groupId, controller, status) {
    if (controller.finished) return controller.done
    if (controller.finishingPromise) return controller.finishingPromise
    if (controller.terminalRetryTimer) {
      this.clearTimeout(controller.terminalRetryTimer)
      controller.terminalRetryTimer = null
    }
    this.clearRunSilence(controller)
    const preserveContinuation = status === 'interrupted'
      && ['pending', 'ready', 'resuming'].includes(controller.continuation?.state)
    if (preserveContinuation) {
      controller.finished = false
      try {
        this.checkpointRequired(groupId, controller, 'waiting')
      } finally {
        controller.finished = true
        if (this.activeRuns.get(groupId) === controller) this.activeRuns.delete(groupId)
        try { this.emitChanged() } catch {}
        controller.resolveDone()
      }
      return
    }
    if (!controller.terminalOutbox) {
      controller.terminalOutbox = {
        status: RUN_STATUSES.has(status) ? status : 'failed',
        finishedAt: Date.now(),
      }
    }
    const finishing = this.commitTerminal(groupId, controller)
    controller.finishingPromise = finishing
    finishing.then(() => {}, () => {
      if (!controller.finished && controller.finishingPromise === finishing) {
        controller.finishingPromise = null
        this.scheduleTerminalRetry(groupId, controller)
      }
    })
    return finishing
  }

  scheduleTerminalRetry(groupId, controller) {
    if (controller.finished || controller.terminalRetryTimer) return
    const delayMs = this.terminalRetryMaxDelayMs
    controller.terminalPersistence.nextRetryAt = Date.now() + delayMs
    controller.terminalRetryTimer = this.setTimeout(() => {
      controller.terminalRetryTimer = null
      if (controller.finished) return
      this.finish(groupId, controller, controller.terminalOutbox.status).catch(() => {})
    }, delayMs)
    controller.terminalRetryTimer?.unref?.()
    try { this.emitChanged() } catch {}
  }

  async commitTerminal(groupId, controller) {
    const finalStatus = controller.terminalOutbox.status
    for (let attempt = 1; attempt <= TERMINAL_PERSIST_ATTEMPTS; attempt += 1) {
      const attempts = (controller.terminalPersistence?.attempts || 0) + 1
      controller.terminalPersistence = {
        state: attempt === 1 ? 'pending' : 'retrying',
        status: finalStatus,
        attempts,
        nextRetryAt: 0,
        code: '',
      }
      const requiresLedger = this.hasRunLedger()
      let persisted = false
      try {
        const result = this.finishRunCheckpoint(groupId, controller, finalStatus)
        persisted = !requiresLedger || result === true
      } catch { persisted = !requiresLedger }
      if (persisted) return this.acknowledgeTerminal(groupId, controller)
      controller.terminalPersistence = {
        ...controller.terminalPersistence,
        state: attempt < TERMINAL_PERSIST_ATTEMPTS ? 'retrying' : 'failed',
        code: 'LOCAL_RUN_PERSIST_FAILED',
      }
      if (attempt < TERMINAL_PERSIST_ATTEMPTS) {
        const delayMs = boundedBackoffDelay(attempt, {
          baseDelayMs: this.terminalRetryBaseDelayMs,
          maxDelayMs: this.terminalRetryMaxDelayMs,
        })
        controller.terminalPersistence.nextRetryAt = Date.now() + delayMs
        try { this.emitChanged() } catch {}
        await this.terminalRetrySleep(delayMs)
      }
    }
    try { this.emitChanged() } catch {}
    throw persistenceFailure(controller.terminalPersistence)
  }

  acknowledgeTerminal(groupId, controller) {
    const finalStatus = controller.terminalOutbox.status
    controller.finished = true
    controller.terminalPersistence = {
      ...controller.terminalPersistence,
      state: 'committed',
      nextRetryAt: 0,
      code: '',
    }
    const ownsActiveRun = this.activeRuns.get(groupId) === controller
    if (ownsActiveRun) this.activeRuns.delete(groupId)
    const payload = {
      groupId: cleanText(groupId, 100),
      runId: cleanText(controller.runId, 120),
      taskId: cleanText(controller.taskId, 120),
      contextPackId: CONTEXT_PACK_ID.test(String(controller.contextPackId || ''))
        ? controller.contextPackId
        : '',
      contextPackState: CONTEXT_PACK_ID.test(String(controller.contextPackId || ''))
        ? 'captured'
        : 'legacy-unavailable',
      mode: controller.mode === 'auto' ? 'auto' : 'manual',
      status: finalStatus,
      threadRootId: cleanText(controller.threadRootId, 100),
      targetKinds: controller.targetKinds.filter(isSupportedAgentKind),
      completedKinds: controller.completedKinds.filter(isSupportedAgentKind),
      failedKinds: controller.failedKinds.filter(isSupportedAgentKind),
      startedAt: Number.isFinite(controller.startedAt) ? controller.startedAt : Date.now(),
      finishedAt: controller.terminalOutbox.finishedAt,
    }
    try {
      if (ownsActiveRun) this.emitChanged()
    } catch {}
    try {
      this.emit('run-finished', payload)
    } catch {}
    controller.resolveDone()
    return payload
  }

  ensureHarness(group, controller, threadRootId = '') {
    if (!controller) return null
    if (!controller.harness) {
      controller.harness = new RunHarness({
        runId: controller.runId || randomUUID(),
        groupId: group.id,
        threadRootId,
        targetKinds: controller.targetKinds,
        createId: randomUUID,
      })
    }
    return controller.harness
  }

  emitRunEvent(event) {
    if (!event) return
    try { this.emit('run-event', event) } catch {}
  }

  clearAgentSilence(controller, kind, round, agentRunId = '') {
    const key = agentRunId || `${kind}:${round}`
    const timer = controller?.silenceTimers?.get(key)
    if (timer) this.clearTimeout(timer)
    controller?.silenceTimers?.delete(key)
  }

  armAgentSilence(controller, kind, round, agentRunId = '') {
    const warningMs = this.getRunSilenceWarningMs()
    if (!controller || !warningMs) return
    const key = agentRunId || `${kind}:${round}`
    this.clearAgentSilence(controller, kind, round, agentRunId)
    const timer = this.setTimeout(() => {
      const warning = controller.harness?.markSilent(kind, round, agentRunId)
      if (warning) {
        this.emitRunEvent(warning)
        this.scheduleRunCheckpoint(controller.groupId, controller)
      }
    }, warningMs)
    timer.unref?.()
    controller.silenceTimers.set(key, timer)
  }

  clearRunSilence(controller) {
    for (const timer of controller?.silenceTimers?.values?.() || []) this.clearTimeout(timer)
    controller?.silenceTimers?.clear?.()
  }

  registerAgentController(controller, kind, agentRunId, agentController) {
    if (!controller || !(agentController instanceof AbortController)) return false
    const current = controller.agentControllers.get(kind)
    if (current && current.agentController !== agentController) {
      throw new Error('LOCAL_AGENT_ATTEMPT_RUNNING')
    }
    controller.agentControllers.set(kind, { agentRunId, agentController })
    return true
  }

  unregisterAgentController(controller, kind, agentRunId, agentController) {
    const current = controller?.agentControllers?.get(kind)
    if (!current || current.agentRunId !== agentRunId
        || current.agentController !== agentController) return false
    controller.agentControllers.delete(kind)
    return true
  }

  controlAgent(groupId, runId, kind, action, replacementKind = '') {
    const controller = this.activeRuns.get(groupId)
    if (!controller || controller.runId !== runId) return false
    if (!['cancel', 'retry', 'replace'].includes(action)) return false
    if (action === 'replace' && (!replacementKind || replacementKind === kind)) return false
    const active = controller.agentControllers.get(kind)
    if (!active || active.agentController.signal.aborted) return false
    controller.agentControlRequests.set(kind, {
      action,
      replacementKind: action === 'replace' ? replacementKind : '',
      requestedAt: Date.now(),
    })
    active.agentController.abort()
    this.scheduleRunCheckpoint(groupId, controller)
    this.emitChanged()
    return true
  }

  consumeAgentControl(controller, kind) {
    const request = controller?.agentControlRequests?.get(kind) || null
    controller?.agentControlRequests?.delete(kind)
    return request
  }

  stop(groupId, runId) {
    const controller = this.activeRuns.get(groupId) || this.preparingRuns.get(groupId)
    if (!controller || !runId || controller.runId !== runId) return false
    controller.stopReason ||= 'user'
    controller.abort()
    return true
  }

  async stopAll() {
    this.setShuttingDown(true)
    const controllers = new Set([
      ...this.preparingRuns.values(),
      ...this.activeRuns.values(),
    ])
    for (const controller of controllers) {
      if (controller.terminalOutbox) continue
      controller.stopReason ||= 'shutdown'
      controller.abort()
    }
    await Promise.allSettled([...controllers].map(controller => controller.done))
  }
}

module.exports = { LocalWorkspaceRunCoordinator }

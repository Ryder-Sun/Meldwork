const {
  SYSTEM_REJECT_OPTION_ID,
  publicHumanGate,
} = require('./human-gate-records.cjs')
const { HumanGateStore } = require('./human-gate-store.cjs')

const APPROVED_OPTION_KINDS = new Set(['allow_once', 'allow_always', 'accept', 'respond'])
const REJECTED_OPTION_KINDS = new Set(['reject_once', 'reject_always', 'reject', 'reopen'])

function gateError(code) {
  return Object.assign(new Error(code), { code })
}

function rejectedOption(record) {
  return record.options.find(option => (
    ['reject_once', 'reject_always', 'reject'].includes(option.kind)
  )) || {
    optionId: SYSTEM_REJECT_OPTION_ID,
  }
}

function statusForHumanGateOption(option) {
  if (APPROVED_OPTION_KINDS.has(option?.kind)) return 'approved'
  if (REJECTED_OPTION_KINDS.has(option?.kind)) return 'rejected'
  throw gateError('HUMAN_GATE_DECISION_INVALID')
}

class HumanGateCoordinator {
  constructor(options = {}) {
    if (!(options.store instanceof HumanGateStore)) {
      throw gateError('HUMAN_GATE_STORE_REQUIRED')
    }
    this.store = options.store
    this.now = typeof options.now === 'function'
      ? options.now
      : () => new Date().toISOString()
    this.onChanged = typeof options.onChanged === 'function' ? options.onChanged : () => {}
    this.onWaiting = typeof options.onWaiting === 'function' ? options.onWaiting : () => {}
    this.onResumed = typeof options.onResumed === 'function' ? options.onResumed : () => {}
    this.canResume = typeof options.canResume === 'function' ? options.canResume : () => false
    this.onOrphanDecision = typeof options.onOrphanDecision === 'function'
      ? options.onOrphanDecision
      : () => {}
    this.onResumeFailed = typeof options.onResumeFailed === 'function'
      ? options.onResumeFailed
      : () => {}
    this.setTimeout = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout
    this.clearTimeout = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout
    this.waiters = new Map()
    this.expiryTimers = new Map()
    this.resumePromises = new Map()
    this.reconciledDecisionIds = new Set()
  }

  list(options = {}) {
    return this.store.list(options)
  }

  expiryDelay(record) {
    if (!record?.expiresAt) return null
    const expiresAt = Date.parse(record.expiresAt)
    const current = Date.parse(this.now())
    if (!Number.isFinite(expiresAt) || !Number.isFinite(current)) return 0
    return Math.max(0, expiresAt - current)
  }

  clearExpiry(gateId) {
    const timer = this.expiryTimers.get(gateId)
    if (timer) this.clearTimeout(timer)
    this.expiryTimers.delete(gateId)
  }

  expire(record) {
    const current = this.store.get(record.gateId)
    if (current.status !== 'pending') return current
    const rejected = rejectedOption(current)
    const expired = this.store.decide(current.gateId, {
      status: 'rejected',
      optionId: rejected.optionId,
      actorId: 'meldwork-system',
      decidedAt: this.now(),
    })
    this.clearExpiry(expired.gateId)
    try {
      this.onResumed(expired, expired.decision)
    } catch (error) {
      this.store.rollbackDecision(expired.gateId, expired.decision)
      try { this.onChanged() } catch {}
      throw error
    }
    const waiter = this.waiters.get(expired.gateId)
    if (waiter) {
      this.waiters.delete(expired.gateId)
      waiter.signal?.removeEventListener('abort', waiter.abortHandler)
      waiter.resolve(expired.decision)
      this.reconciledDecisionIds.add(expired.gateId)
    } else {
      const resumed = Promise.resolve().then(() => (
        this.onOrphanDecision(expired, expired.decision)
      )).catch((error) => {
        this.onResumeFailed(expired, error)
      }).finally(() => {
        this.resumePromises.delete(expired.gateId)
      })
      this.resumePromises.set(expired.gateId, resumed)
    }
    this.onChanged()
    return expired
  }

  armExpiry(record) {
    const delay = this.expiryDelay(record)
    if (delay === null) return false
    if (delay === 0) {
      this.expire(record)
      return true
    }
    const timer = this.setTimeout(() => {
      this.expiryTimers.delete(record.gateId)
      try { this.expire(record) } catch { /* The pending Gate remains retryable. */ }
    }, delay)
    timer?.unref?.()
    this.expiryTimers.set(record.gateId, timer)
    return true
  }

  async wait(input = {}, options = {}) {
    if (options.signal?.aborted) throw gateError('LOCAL_AGENT_EXECUTION_STOPPED')
    const record = this.store.create({
      ...input,
      createdAt: input.createdAt || this.now(),
    })
    options.onCreated?.(record)
    if (record.status !== 'pending') return record.decision
    if (this.waiters.has(record.gateId)) throw gateError('HUMAN_GATE_ALREADY_WAITING')

    let abortHandler = null
    const result = new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal: options.signal, abortHandler: null }
      this.waiters.set(record.gateId, waiter)
      abortHandler = () => {
        const waiter = this.waiters.get(record.gateId)
        if (!waiter) return
        this.waiters.delete(record.gateId)
        this.clearExpiry(record.gateId)
        if (options.preserveOnAbort?.() === true) {
          try { this.onChanged() } catch {}
          reject(gateError('LOCAL_AGENT_EXECUTION_STOPPED'))
          return
        }
        const rejected = rejectedOption(record)
        let rejectedRecord = null
        try {
          rejectedRecord = this.store.decide(record.gateId, {
            status: 'rejected',
            optionId: rejected.optionId,
            actorId: 'meldwork-system',
            decidedAt: this.now(),
          })
          this.onResumed(rejectedRecord, rejectedRecord.decision)
          this.reconciledDecisionIds.add(record.gateId)
        } catch {
          if (rejectedRecord?.status !== 'pending') {
            try { this.store.rollbackDecision(record.gateId, rejectedRecord.decision) } catch {}
          }
        }
        try { this.onChanged() } catch {}
        reject(gateError('LOCAL_AGENT_EXECUTION_STOPPED'))
      }
      waiter.abortHandler = abortHandler
      options.signal?.addEventListener('abort', abortHandler, { once: true })
    })
    try {
      this.onWaiting(record, options.continuation || null)
      this.armExpiry(record)
      this.onChanged()
    } catch (error) {
      const waiter = this.waiters.get(record.gateId)
      if (waiter?.abortHandler === abortHandler) this.waiters.delete(record.gateId)
      options.signal?.removeEventListener('abort', abortHandler)
      this.clearExpiry(record.gateId)
      throw error
    }
    try {
      return await result
    } finally {
      options.signal?.removeEventListener('abort', abortHandler)
    }
  }

  decide(gateId, input = {}) {
    const normalizedGateId = String(gateId || '')
    const current = this.store.get(normalizedGateId)
    const option = current.options.find(candidate => candidate.optionId === input.optionId)
    if (!option) throw gateError('HUMAN_GATE_DECISION_INVALID')
    const status = statusForHumanGateOption(option)
    if (status === 'approved' && this.store.publicRecord(current).decisionContextUnavailable) {
      throw gateError('HUMAN_GATE_CONTEXT_UNAVAILABLE')
    }
    if (Object.hasOwn(input, 'status') && input.status !== status) {
      throw gateError('HUMAN_GATE_DECISION_INVALID')
    }
    const response = typeof input.response === 'string' ? input.response : ''
    if ((current.type === 'input' && status === 'approved' && !response.trim())
        || response.length > 32 * 1024
        || (current.type !== 'input' && Object.hasOwn(input, 'response'))
        || (status !== 'approved' && Object.hasOwn(input, 'response'))) {
      throw gateError('HUMAN_GATE_DECISION_INVALID')
    }
    const record = this.store.decide(normalizedGateId, {
      status,
      optionId: option.optionId,
      actorId: input.actorId || 'local-user',
      decidedAt: input.decidedAt || current.decision?.decidedAt || this.now(),
      ...(response ? { response } : {}),
    })
    // Recovery owns recorded decisions; repeated submissions must not dispatch them again.
    if (current.status !== 'pending') return publicHumanGate(record)
    this.clearExpiry(record.gateId)
    try {
      this.onResumed(record, record.decision)
    } catch (error) {
      if (current.status === 'pending') {
        this.store.rollbackDecision(record.gateId, record.decision)
        try { this.onChanged() } catch {}
      }
      throw error
    }
    const waiter = this.waiters.get(record.gateId)
    if (waiter) {
      this.waiters.delete(record.gateId)
      waiter.signal?.removeEventListener('abort', waiter.abortHandler)
      waiter.resolve(record.decision)
    }
    this.reconciledDecisionIds.add(record.gateId)
    if (!waiter) {
      const resumed = Promise.resolve().then(() => (
        this.onOrphanDecision(record, record.decision)
      )).catch((error) => {
        this.onResumeFailed(record, error)
      }).finally(() => {
        this.resumePromises.delete(record.gateId)
      })
      this.resumePromises.set(record.gateId, resumed)
    }
    this.onChanged()
    return publicHumanGate(record)
  }

  reconcileDecisions() {
    const reconciled = []
    for (const candidate of this.store.list()) {
      if (candidate.status === 'pending'
          || this.waiters.has(candidate.gateId)
          || this.resumePromises.has(candidate.gateId)
          || this.reconciledDecisionIds.has(candidate.gateId)) continue
      const record = this.store.get(candidate.gateId)
      let resumable = false
      try { resumable = this.canResume(record) === true } catch {}
      if (!resumable) {
        try {
          this.onResumeFailed(record, gateError('LOCAL_RUN_CONTINUATION_INVALID'))
        } catch { /* invalid durable continuations remain fail closed */ }
        continue
      }
      try {
        this.onResumed(record, record.decision)
        this.reconciledDecisionIds.add(record.gateId)
        reconciled.push(publicHumanGate(record))
      } catch (error) {
        try { this.onResumeFailed(record, error) } catch {}
      }
    }
    if (reconciled.length) this.onChanged()
    return reconciled
  }

  reconcileOrphans() {
    const reconciled = []
    for (const pending of this.store.list({ pendingOnly: true })) {
      if (this.waiters.has(pending.gateId)) continue
      const record = this.store.get(pending.gateId)
      if (this.expiryDelay(record) === 0) {
        reconciled.push(publicHumanGate(this.expire(record)))
        continue
      }
      let resumable = false
      try { resumable = this.canResume(record) === true } catch {}
      if (resumable) {
        reconciled.push(publicHumanGate(record))
        continue
      }
      const rejected = rejectedOption(record)
      const rejectedRecord = this.store.decide(record.gateId, {
        status: 'rejected',
        optionId: rejected.optionId,
        actorId: 'meldwork-system',
        decidedAt: this.now(),
      })
      reconciled.push(publicHumanGate(rejectedRecord))
      try {
        this.onResumeFailed(rejectedRecord, gateError('LOCAL_RUN_CONTINUATION_INVALID'))
      } catch { /* the durable Gate rejection remains authoritative */ }
    }
    if (reconciled.length) this.onChanged()
    return reconciled
  }
}

module.exports = { HumanGateCoordinator, statusForHumanGateOption }

const DEFAULT_TASK_CONCURRENCY = null
const DEFAULT_WORKSPACE_CONCURRENCY = null
const DEFAULT_GLOBAL_CONCURRENCY = null
const schedulerPauseTokens = new WeakMap()
const schedulerLeaseBindings = new WeakMap()

function positiveLimit(value, fallback) {
  if (value == null) return fallback
  const number = Number(value)
  if (!Number.isFinite(number) || number < 1) return fallback
  return Math.min(1024, Math.floor(number))
}

function belowLimit(active, limit) {
  return limit === null || active < limit
}

function schedulerError(code) {
  return Object.assign(new Error(code), { code })
}

function resourceKey(value, code) {
  const key = String(value || '')
  if (!key || key.length > 256 || /[\u0000-\u001f\u007f]/.test(key)) throw schedulerError(code)
  return key
}

function installTaskPause(scheduler, taskId) {
  const token = Object.freeze({})
  const pauses = schedulerPauseTokens.get(scheduler)
  const tokens = pauses.get(taskId) || new Set()
  tokens.add(token)
  pauses.set(taskId, tokens)
  return token
}

function removeTaskPause(scheduler, taskId, token) {
  const pauses = schedulerPauseTokens.get(scheduler)
  const tokens = pauses.get(taskId)
  if (!tokens) return
  tokens.delete(token)
  if (!tokens.size) pauses.delete(taskId)
}

function taskPauseAllows(scheduler, entry) {
  const tokens = schedulerPauseTokens.get(scheduler).get(entry.taskId)
  return !tokens?.size || (entry.pauseToken && tokens.has(entry.pauseToken))
}

class RunScheduler {
  constructor(options = {}) {
    this.limits = Object.freeze({
      task: positiveLimit(options.taskLimit, DEFAULT_TASK_CONCURRENCY),
      workspace: positiveLimit(options.workspaceLimit, DEFAULT_WORKSPACE_CONCURRENCY),
      global: positiveLimit(options.globalLimit, DEFAULT_GLOBAL_CONCURRENCY),
    })
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.activeGlobal = 0
    this.activeTasks = new Map()
    this.activeWorkspaces = new Map()
    this.activeWorkspaceWriters = new Set()
    this.queue = []
    this.sequence = 0
    schedulerPauseTokens.set(this, new Map())
  }

  resourceCount(collection, key) {
    return collection.get(key) || 0
  }

  canGrant(entry) {
    return taskPauseAllows(this, entry)
      && (entry.permissionMode !== 'workspace-write'
        || !this.activeWorkspaceWriters.has(entry.workspaceKey))
      && belowLimit(this.activeGlobal, this.limits.global)
      && belowLimit(this.resourceCount(this.activeTasks, entry.taskId), this.limits.task)
      && belowLimit(this.resourceCount(this.activeWorkspaces, entry.workspaceKey), this.limits.workspace)
  }

  changeCount(collection, key, change) {
    const next = this.resourceCount(collection, key) + change
    if (next > 0) collection.set(key, next)
    else collection.delete(key)
  }

  grant(entry) {
    this.activeGlobal += 1
    this.changeCount(this.activeTasks, entry.taskId, 1)
    this.changeCount(this.activeWorkspaces, entry.workspaceKey, 1)
    if (entry.permissionMode === 'workspace-write') this.activeWorkspaceWriters.add(entry.workspaceKey)
    entry.signal?.removeEventListener('abort', entry.abortHandler)
    let released = false
    const lease = Object.freeze({
      leaseId: entry.requestId,
      taskId: entry.taskId,
      workspaceKey: entry.workspaceKey,
      permissionMode: entry.permissionMode,
      queuedAt: entry.queuedAt,
      acquiredAt: this.now(),
      release: () => {
        if (released) return false
        released = true
        this.activeGlobal -= 1
        this.changeCount(this.activeTasks, entry.taskId, -1)
        this.changeCount(this.activeWorkspaces, entry.workspaceKey, -1)
        if (entry.permissionMode === 'workspace-write') this.activeWorkspaceWriters.delete(entry.workspaceKey)
        this.drain()
        return true
      },
    })
    schedulerLeaseBindings.set(lease, Object.freeze({
      taskId: entry.taskId,
      workspaceKey: entry.workspaceKey,
      permissionMode: entry.permissionMode,
      signal: entry.signal,
    }))
    entry.resolve(lease)
  }

  drain() {
    for (let index = 0; index < this.queue.length;) {
      const entry = this.queue[index]
      if (entry.cancelled) {
        this.queue.splice(index, 1)
        continue
      }
      if (!this.canGrant(entry)) {
        index += 1
        continue
      }
      this.queue.splice(index, 1)
      this.grant(entry)
    }
  }

  #enqueueAcquire(input = {}, pauseToken = null) {
    let taskId
    let workspaceKey
    const permissionMode = input.permissionMode == null ? 'read-only' : input.permissionMode
    try {
      taskId = resourceKey(input.taskId, 'RUN_SCHEDULER_TASK_REQUIRED')
      workspaceKey = resourceKey(input.workspaceKey, 'RUN_SCHEDULER_WORKSPACE_REQUIRED')
      if (!['read-only', 'workspace-write'].includes(permissionMode)) {
        throw schedulerError('RUN_SCHEDULER_PERMISSION_INVALID')
      }
    } catch (error) {
      return Promise.reject(error)
    }
    const signal = input.signal
    if (signal?.aborted) return Promise.reject(schedulerError('RUN_SCHEDULER_ABORTED'))
    return new Promise((resolve, reject) => {
      const entry = {
        requestId: `lease-${++this.sequence}`,
        taskId,
        workspaceKey,
        permissionMode,
        queuedAt: this.now(),
        signal,
        resolve,
        reject,
        cancelled: false,
        abortHandler: null,
        pauseToken,
      }
      entry.abortHandler = () => {
        if (entry.cancelled) return
        entry.cancelled = true
        const index = this.queue.indexOf(entry)
        if (index >= 0) this.queue.splice(index, 1)
        reject(schedulerError('RUN_SCHEDULER_ABORTED'))
        this.drain()
      }
      signal?.addEventListener('abort', entry.abortHandler, { once: true })
      this.queue.push(entry)
      this.drain()
    })
  }

  acquire(input = {}) {
    return this.#enqueueAcquire(input)
  }

  async withLease(input, operation) {
    if (typeof operation !== 'function') throw schedulerError('RUN_SCHEDULER_OPERATION_REQUIRED')
    let activeLease = await this.acquire(input)
    let closed = false
    const lease = Object.freeze({
      get leaseId() { return activeLease?.leaseId || '' },
      get taskId() { return activeLease?.taskId || '' },
      get workspaceKey() { return activeLease?.workspaceKey || '' },
      get permissionMode() { return activeLease?.permissionMode || '' },
      get queuedAt() { return activeLease?.queuedAt || 0 },
      get acquiredAt() { return activeLease?.acquiredAt || 0 },
      release: () => {
        if (closed) return false
        closed = true
        const current = activeLease
        activeLease = null
        return current?.release() || false
      },
      suspend: async (waitingOperation, options = {}) => {
        if (typeof waitingOperation !== 'function') {
          throw schedulerError('RUN_SCHEDULER_OPERATION_REQUIRED')
        }
        if (closed || !activeLease) throw schedulerError('RUN_SCHEDULER_LEASE_INACTIVE')
        const binding = schedulerLeaseBindings.get(activeLease)
        const taskId = binding.taskId
        const pauseToken = options?.pauseTask === true
          ? installTaskPause(this, taskId)
          : null
        try {
          activeLease.release()
          activeLease = null
          let result
          let failure
          try {
            result = await waitingOperation()
          } catch (error) {
            failure = error
          }
          if (!closed && !binding.signal?.aborted) {
            activeLease = await this.#enqueueAcquire(binding, pauseToken)
          }
          if (failure) throw failure
          return result
        } finally {
          if (pauseToken) {
            removeTaskPause(this, taskId, pauseToken)
            this.drain()
          }
        }
      },
    })
    try {
      return await operation(lease)
    } finally {
      lease.release()
    }
  }

  snapshot() {
    return {
      limits: { ...this.limits },
      active: {
        global: this.activeGlobal,
        tasks: [...this.activeTasks.entries()].map(([taskId, count]) => ({ taskId, count })),
        workspaces: [...this.activeWorkspaces.entries()]
          .map(([workspaceKey, count]) => ({ workspaceKey, count })),
      },
      queued: this.queue.filter(entry => !entry.cancelled).map(entry => ({
        requestId: entry.requestId,
        taskId: entry.taskId,
        workspaceKey: entry.workspaceKey,
        queuedAt: entry.queuedAt,
      })),
    }
  }
}

const processRunScheduler = new RunScheduler()

module.exports = {
  DEFAULT_GLOBAL_CONCURRENCY,
  DEFAULT_TASK_CONCURRENCY,
  DEFAULT_WORKSPACE_CONCURRENCY,
  RunScheduler,
  processRunScheduler,
}

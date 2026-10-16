const test = require('node:test')
const assert = require('node:assert/strict')

const {
  RunScheduler,
  processRunScheduler,
} = require('../../src/runs/run-scheduler.cjs')

function deferredState(promise) {
  const state = { settled: false, value: null }
  promise.then(
    value => { state.settled = true; state.value = value },
    error => { state.settled = true; state.value = error },
  )
  return state
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

test('exports one process-wide scheduler with no run deadline', () => {
  assert.equal(processRunScheduler instanceof RunScheduler, true)
  assert.equal(Object.hasOwn(processRunScheduler.snapshot(), 'timeoutMs'), false)
})

test('default capacity is unlimited and starts every Agent in a collaboration batch', async (t) => {
  const scheduler = new RunScheduler()
  const leases = []
  t.after(() => leases.forEach(lease => lease.release()))

  assert.deepEqual(scheduler.snapshot().limits, { task: null, workspace: null, global: null })

  for (let index = 0; index < 40; index += 1) {
    void scheduler.acquire({
      taskId: 'shared-task',
      workspaceKey: 'shared-workspace',
    }).then(lease => { leases.push(lease) })
  }
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(scheduler.snapshot().active.global, 40)
  assert.equal(scheduler.snapshot().queued.length, 0)
})

test('grants FIFO leases when shared capacity becomes available and records fake-clock queue timing', async () => {
  let now = 100
  const scheduler = new RunScheduler({
    taskLimit: 2, workspaceLimit: 2, globalLimit: 1, now: () => now,
  })
  const first = await scheduler.acquire({ taskId: 'task-1', workspaceKey: 'workspace-a' })
  now = 200
  const secondPromise = scheduler.acquire({ taskId: 'task-2', workspaceKey: 'workspace-b' })
  const secondState = deferredState(secondPromise)
  now = 300
  const thirdPromise = scheduler.acquire({ taskId: 'task-3', workspaceKey: 'workspace-c' })
  const thirdState = deferredState(thirdPromise)
  await Promise.resolve()

  assert.equal(secondState.settled, false)
  assert.equal(thirdState.settled, false)
  assert.deepEqual(scheduler.snapshot().queued.map(item => item.taskId), ['task-2', 'task-3'])

  now = 400
  assert.equal(first.release(), true)
  const second = await secondPromise
  assert.equal(second.queuedAt, 200)
  assert.equal(second.acquiredAt, 400)
  await Promise.resolve()
  assert.equal(thirdState.settled, false)

  now = 500
  second.release()
  const third = await thirdPromise
  assert.equal(third.acquiredAt, 500)
  third.release()
  assert.equal(first.release(), false)
})

test('enforces Task and Workspace limits independently', async () => {
  const taskScheduler = new RunScheduler({ taskLimit: 1, workspaceLimit: 3, globalLimit: 3 })
  const taskLease = await taskScheduler.acquire({ taskId: 'same-task', workspaceKey: 'one' })
  const taskQueued = taskScheduler.acquire({ taskId: 'same-task', workspaceKey: 'two' })
  const taskState = deferredState(taskQueued)
  await Promise.resolve()
  assert.equal(taskState.settled, false)
  taskLease.release()
  ;(await taskQueued).release()

  const workspaceScheduler = new RunScheduler({ taskLimit: 3, workspaceLimit: 1, globalLimit: 3 })
  const workspaceLease = await workspaceScheduler.acquire({
    taskId: 'task-one', workspaceKey: 'same-workspace',
  })
  const workspaceQueued = workspaceScheduler.acquire({
    taskId: 'task-two', workspaceKey: 'same-workspace',
  })
  const workspaceState = deferredState(workspaceQueued)
  await Promise.resolve()
  assert.equal(workspaceState.settled, false)
  workspaceLease.release()
  ;(await workspaceQueued).release()
})

test('workspace writers serialize across tasks while readers and other directories remain concurrent', async () => {
  const scheduler = new RunScheduler()
  const lease = await scheduler.acquire({
    taskId: 'writer', workspaceKey: 'shared', permissionMode: 'workspace-write',
  })
  const reader = await scheduler.acquire({ taskId: 'reader', workspaceKey: 'shared' })
  const nextWriter = scheduler.acquire({
    taskId: 'writer2', workspaceKey: 'shared', permissionMode: 'workspace-write',
  })
  const nextState = deferredState(nextWriter)
  const other = await scheduler.acquire({
    taskId: 'other', workspaceKey: 'other', permissionMode: 'workspace-write',
  })
  const laterReader = await scheduler.acquire({ taskId: 'later', workspaceKey: 'shared' })
  assert.equal(lease.permissionMode, 'workspace-write')
  assert.equal(nextState.settled, false)
  lease.release()
  ;(await nextWriter).release()
  reader.release()
  laterReader.release()
  other.release()
  assert.equal(scheduler.snapshot().active.global, 0)
})

test('cancelling a queued writer does not block the next writer', async () => {
  const scheduler = new RunScheduler()
  const first = await scheduler.acquire({
    taskId: 'first', workspaceKey: 'shared', permissionMode: 'workspace-write',
  })
  const controller = new AbortController()
  const writer = scheduler.acquire({
    taskId: 'writer', workspaceKey: 'shared', permissionMode: 'workspace-write', signal: controller.signal,
  })
  const later = scheduler.acquire({ taskId: 'later', workspaceKey: 'shared', permissionMode: 'workspace-write' })
  controller.abort()
  await assert.rejects(writer, { message: 'RUN_SCHEDULER_ABORTED' })
  first.release()
  ;(await later).release()
})

test('a suspended writer reacquires exclusive access using its original permission', async () => {
  const scheduler = new RunScheduler()
  const gate = deferred()
  const paused = deferred()
  const input = { taskId: 'writer', workspaceKey: 'shared', permissionMode: 'workspace-write' }
  const writer = scheduler.withLease(input, async lease => {
    await lease.suspend(async () => {
      paused.resolve()
      await gate.promise
    }, { pauseTask: true })
    assert.equal(lease.permissionMode, 'workspace-write')
  })
  await paused.promise
  input.permissionMode = 'read-only'
  const otherWriter = await scheduler.acquire({
    taskId: 'other', workspaceKey: 'shared', permissionMode: 'workspace-write',
  })
  const sibling = scheduler.acquire({
    taskId: 'writer', workspaceKey: 'shared', permissionMode: 'workspace-write',
  })
  const siblingState = deferredState(sibling)
  gate.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(scheduler.snapshot().queued.length, 2)
  assert.equal(siblingState.settled, false)
  otherWriter.release()
  await writer
  ;(await sibling).release()
  assert.equal(scheduler.snapshot().active.global, 0)
})

test('rejects unknown scheduler permissions', async () => {
  await assert.rejects(new RunScheduler().acquire({
    taskId: 'task', workspaceKey: 'workspace', permissionMode: 'unrestricted',
  }), { message: 'RUN_SCHEDULER_PERMISSION_INVALID' })
})

test('grants later eligible work when an earlier request is blocked by a scoped limit', async () => {
  const scheduler = new RunScheduler({ taskLimit: 1, workspaceLimit: 3, globalLimit: 2 })
  const active = await scheduler.acquire({ taskId: 'same-task', workspaceKey: 'workspace-a' })
  const blocked = scheduler.acquire({ taskId: 'same-task', workspaceKey: 'workspace-b' })
  const blockedState = deferredState(blocked)
  const eligible = await scheduler.acquire({ taskId: 'other-task', workspaceKey: 'workspace-c' })

  await Promise.resolve()
  assert.equal(blockedState.settled, false)
  assert.deepEqual(scheduler.snapshot().queued.map(item => item.taskId), ['same-task'])

  eligible.release()
  active.release()
  ;(await blocked).release()
})

test('removes an aborted queued request without blocking the next lease', async () => {
  const scheduler = new RunScheduler({ taskLimit: 3, workspaceLimit: 3, globalLimit: 1 })
  const first = await scheduler.acquire({ taskId: 'task-1', workspaceKey: 'workspace-a' })
  const controller = new AbortController()
  const aborted = scheduler.acquire({
    taskId: 'task-2', workspaceKey: 'workspace-b', signal: controller.signal,
  })
  const next = scheduler.acquire({ taskId: 'task-3', workspaceKey: 'workspace-c' })

  controller.abort()
  await assert.rejects(aborted, { message: 'RUN_SCHEDULER_ABORTED' })
  assert.deepEqual(scheduler.snapshot().queued.map(item => item.taskId), ['task-3'])
  first.release()
  ;(await next).release()
})

test('withLease releases capacity in finally after success or failure', async () => {
  const scheduler = new RunScheduler({ globalLimit: 1 })
  await assert.rejects(
    scheduler.withLease(
      { taskId: 'task-1', workspaceKey: 'workspace-a' },
      async () => { throw new Error('operation failed') },
    ),
    { message: 'operation failed' },
  )
  assert.equal(scheduler.snapshot().active.global, 0)

  const result = await scheduler.withLease(
    { taskId: 'task-2', workspaceKey: 'workspace-b' },
    async lease => lease.leaseId,
  )
  assert.match(result, /^lease-\d+$/)
  assert.equal(scheduler.snapshot().active.global, 0)
})

test('suspended leases release capacity and reacquire it before continuing', async () => {
  const scheduler = new RunScheduler({
    taskLimit: 2, workspaceLimit: 2, globalLimit: 1,
  })
  let resumeWaiting
  const waiting = new Promise(resolve => { resumeWaiting = resolve })
  const order = []
  const first = scheduler.withLease(
    { taskId: 'task-1', workspaceKey: 'workspace-a' },
    async (lease) => {
      order.push('first-acquired')
      await lease.suspend(async () => {
        order.push('first-suspended')
        await waiting
      })
      order.push('first-reacquired')
    },
  )
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(scheduler.snapshot().active.global, 0)

  await scheduler.withLease(
    { taskId: 'task-2', workspaceKey: 'workspace-b' },
    async () => { order.push('second-completed') },
  )
  resumeWaiting()
  await first

  assert.deepEqual(order, [
    'first-acquired', 'first-suspended', 'second-completed', 'first-reacquired',
  ])
  assert.equal(scheduler.snapshot().active.global, 0)
})

test('four suspended global leases consume no capacity while waiting', async () => {
  const scheduler = new RunScheduler({
    taskLimit: 4, workspaceLimit: 4, globalLimit: 4,
  })
  const releases = []
  const suspended = Array.from({ length: 4 }, (_, index) => scheduler.withLease({
    taskId: `task-${index}`,
    workspaceKey: `workspace-${index}`,
  }, lease => lease.suspend(() => new Promise((resolve) => { releases[index] = resolve }))))
  while (releases.length < 4) await new Promise(resolve => setImmediate(resolve))

  assert.equal(scheduler.snapshot().active.global, 0)
  for (const release of releases) release()
  await Promise.all(suspended)
  assert.equal(scheduler.snapshot().active.global, 0)
})

test('task pause blocks queued same-task work while another task uses released capacity', async () => {
  const scheduler = new RunScheduler({ taskLimit: 1, workspaceLimit: 3, globalLimit: 1 })
  const ownerReady = deferred()
  const startSuspend = deferred()
  const gate = deferred()
  const suspended = deferred()
  const owner = scheduler.withLease({ taskId: 'task-1', workspaceKey: 'workspace-a' }, async lease => {
    ownerReady.resolve()
    await startSuspend.promise
    await lease.suspend(async () => {
      suspended.resolve()
      await gate.promise
    }, { pauseTask: true })
  })
  await ownerReady.promise

  const sameTask = scheduler.acquire({ taskId: 'task-1', workspaceKey: 'workspace-b' })
  const sameTaskState = deferredState(sameTask)
  const otherTask = scheduler.acquire({ taskId: 'task-2', workspaceKey: 'workspace-c' })
  const otherTaskState = deferredState(otherTask)
  startSuspend.resolve()
  await suspended.promise
  await new Promise(resolve => setImmediate(resolve))

  const observed = {
    sameTaskSettled: sameTaskState.settled,
    otherTaskSettled: otherTaskState.settled,
  }
  let sameTaskLease = observed.sameTaskSettled ? await sameTask : null
  sameTaskLease?.release()
  const otherTaskLease = await otherTask
  otherTaskLease.release()
  gate.resolve()
  await owner
  sameTaskLease ||= await sameTask
  sameTaskLease.release()

  assert.deepEqual(observed, { sameTaskSettled: false, otherTaskSettled: true })
  assert.equal(scheduler.snapshot().active.global, 0)
})

test('task-pause owner reacquires before an older queued same-task request', async () => {
  const scheduler = new RunScheduler({ taskLimit: 1, workspaceLimit: 2, globalLimit: 1 })
  const ownerReady = deferred()
  const startSuspend = deferred()
  const gate = deferred()
  const suspended = deferred()
  const order = []
  const owner = scheduler.withLease({ taskId: 'task-1', workspaceKey: 'workspace-a' }, async lease => {
    ownerReady.resolve()
    await startSuspend.promise
    await lease.suspend(async () => {
      suspended.resolve()
      await gate.promise
    }, { pauseTask: true })
    order.push('owner-reacquired')
  })
  await ownerReady.promise
  const queued = scheduler.acquire({ taskId: 'task-1', workspaceKey: 'workspace-b' })
    .then(lease => {
      order.push('queued-acquired')
      lease.release()
    })
  startSuspend.resolve()
  await suspended.promise

  gate.resolve()
  await Promise.all([owner, queued])

  assert.deepEqual(order, ['owner-reacquired', 'queued-acquired'])
  assert.equal(scheduler.snapshot().active.global, 0)
})

test('task-pause reacquire keeps the validated lease binding when caller input mutates', async () => {
  const scheduler = new RunScheduler({ taskLimit: 1, workspaceLimit: 3, globalLimit: 2 })
  const originalController = new AbortController()
  const mutatedController = new AbortController()
  mutatedController.abort()
  const input = {
    taskId: 'task-original',
    workspaceKey: 'workspace-original',
    signal: originalController.signal,
  }
  const gate = deferred()
  const suspended = deferred()
  const ownerReacquired = deferred()
  const releaseOwner = deferred()
  let reacquiredBinding = null
  const owner = scheduler.withLease(input, async lease => {
    await lease.suspend(async () => {
      input.taskId = 'task-mutated'
      input.workspaceKey = 'workspace-mutated'
      input.signal = mutatedController.signal
      suspended.resolve()
      await gate.promise
    }, { pauseTask: true })
    reacquiredBinding = { taskId: lease.taskId, workspaceKey: lease.workspaceKey }
    ownerReacquired.resolve()
    await releaseOwner.promise
  })
  await suspended.promise
  const queued = scheduler.acquire({
    taskId: 'task-original', workspaceKey: 'workspace-queued',
  })
  const queuedState = deferredState(queued)

  gate.resolve()
  await ownerReacquired.promise
  await new Promise(resolve => setImmediate(resolve))
  const queuedWhileOwnerActive = queuedState.settled
  releaseOwner.resolve()
  await owner
  const queuedLease = await queued
  queuedLease.release()

  assert.deepEqual(reacquiredBinding, {
    taskId: 'task-original', workspaceKey: 'workspace-original',
  })
  assert.equal(queuedWhileOwnerActive, false)
  assert.equal(scheduler.snapshot().active.global, 0)
})

test('task-pause rejection reacquires before rethrow and leaves the task usable', async () => {
  const scheduler = new RunScheduler({ taskLimit: 1, workspaceLimit: 2, globalLimit: 1 })
  const waiting = deferred()
  const suspended = deferred()
  const failureCaught = deferred()
  const releaseOwner = deferred()
  const failure = new Error('GATE_CHECKPOINT_FAILED')
  let caughtBinding = null
  let caughtFailure = null
  const owner = scheduler.withLease({
    taskId: 'task-1', workspaceKey: 'workspace-a',
  }, async lease => {
    try {
      await lease.suspend(async () => {
        suspended.resolve()
        await waiting.promise
      }, { pauseTask: true })
    } catch (error) {
      caughtFailure = error
      caughtBinding = { taskId: lease.taskId, workspaceKey: lease.workspaceKey }
      failureCaught.resolve()
      await releaseOwner.promise
      throw error
    }
  })
  await suspended.promise
  const queued = scheduler.acquire({ taskId: 'task-1', workspaceKey: 'workspace-b' })
  const queuedState = deferredState(queued)

  waiting.reject(failure)
  await failureCaught.promise
  await new Promise(resolve => setImmediate(resolve))
  const queuedBeforeRethrow = queuedState.settled
  releaseOwner.resolve()
  await assert.rejects(owner, error => error === failure)
  const queuedLease = await queued
  queuedLease.release()
  const nextLease = await scheduler.acquire({ taskId: 'task-1', workspaceKey: 'workspace-a' })
  nextLease.release()

  assert.equal(caughtFailure, failure)
  assert.deepEqual(caughtBinding, { taskId: 'task-1', workspaceKey: 'workspace-a' })
  assert.equal(queuedBeforeRethrow, false)
  assert.deepEqual(scheduler.snapshot().active, { global: 0, tasks: [], workspaces: [] })
  assert.deepEqual(scheduler.snapshot().queued, [])
})

test('multiple task-pause tokens keep queued same-task work blocked until the final Gate settles', async () => {
  const scheduler = new RunScheduler({ taskLimit: 2, workspaceLimit: 3, globalLimit: 2 })
  const startSuspend = deferred()
  const firstGate = deferred()
  const secondGate = deferred()
  const firstSuspended = deferred()
  const secondSuspended = deferred()
  const firstReady = deferred()
  const secondReady = deferred()
  const first = scheduler.withLease({ taskId: 'task-1', workspaceKey: 'workspace-a' }, async lease => {
    firstReady.resolve()
    await startSuspend.promise
    await lease.suspend(async () => {
      firstSuspended.resolve()
      await firstGate.promise
    }, { pauseTask: true })
  })
  const second = scheduler.withLease({ taskId: 'task-1', workspaceKey: 'workspace-b' }, async lease => {
    secondReady.resolve()
    await startSuspend.promise
    await lease.suspend(async () => {
      secondSuspended.resolve()
      await secondGate.promise
    }, { pauseTask: true })
  })
  await Promise.all([firstReady.promise, secondReady.promise])
  const queued = scheduler.acquire({ taskId: 'task-1', workspaceKey: 'workspace-c' })
  const queuedState = deferredState(queued)
  startSuspend.resolve()
  await Promise.all([firstSuspended.promise, secondSuspended.promise])
  await new Promise(resolve => setImmediate(resolve))
  const beforeResolution = queuedState.settled

  firstGate.resolve()
  await first
  await new Promise(resolve => setImmediate(resolve))
  const afterFirstResolution = queuedState.settled

  secondGate.resolve()
  await second
  const queuedLease = await queued
  queuedLease.release()

  assert.equal(beforeResolution, false)
  assert.equal(afterFirstResolution, false)
  assert.equal(scheduler.snapshot().active.global, 0)
})

test('abort while task-paused removes the pause without reacquiring the aborted lease', async () => {
  const scheduler = new RunScheduler({ taskLimit: 1, workspaceLimit: 2, globalLimit: 1 })
  const controller = new AbortController()
  const suspended = deferred()
  const owner = scheduler.withLease({
    taskId: 'task-1', workspaceKey: 'workspace-a', signal: controller.signal,
  }, lease => lease.suspend(() => new Promise((resolve, reject) => {
    suspended.resolve()
    controller.signal.addEventListener('abort', () => reject(new Error('GATE_ABORTED')), { once: true })
  }), { pauseTask: true }))
  await suspended.promise
  const queued = scheduler.acquire({ taskId: 'task-1', workspaceKey: 'workspace-b' })
  const queuedState = deferredState(queued)
  await new Promise(resolve => setImmediate(resolve))
  const settledBeforeAbort = queuedState.settled

  controller.abort()
  await assert.rejects(owner, { message: 'GATE_ABORTED' })
  const queuedLease = await queued
  queuedLease.release()

  assert.equal(settledBeforeAbort, false)
  assert.deepEqual(scheduler.snapshot().active, { global: 0, tasks: [], workspaces: [] })
  assert.deepEqual(scheduler.snapshot().queued, [])
})

test('legacy suspension still dispatches older queued same-task work while waiting', async () => {
  const scheduler = new RunScheduler({ taskLimit: 1, workspaceLimit: 2, globalLimit: 1 })
  const ownerReady = deferred()
  const startSuspend = deferred()
  const gate = deferred()
  const suspended = deferred()
  const owner = scheduler.withLease({ taskId: 'task-1', workspaceKey: 'workspace-a' }, async lease => {
    ownerReady.resolve()
    await startSuspend.promise
    await lease.suspend(async () => {
      suspended.resolve()
      await gate.promise
    })
  })
  await ownerReady.promise
  const queued = scheduler.acquire({ taskId: 'task-1', workspaceKey: 'workspace-b' })
  const queuedState = deferredState(queued)
  startSuspend.resolve()
  await suspended.promise
  await new Promise(resolve => setImmediate(resolve))
  const dispatchedWhileWaiting = queuedState.settled

  const queuedLease = await queued
  queuedLease.release()
  gate.resolve()
  await owner

  assert.equal(dispatchedWhileWaiting, true)
  assert.equal(scheduler.snapshot().active.global, 0)
})

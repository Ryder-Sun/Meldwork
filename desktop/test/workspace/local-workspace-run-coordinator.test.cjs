const assert = require('node:assert/strict')
const fs = require('node:fs')
const test = require('node:test')

const coordinatorApi = require('../../src/workspace/local-workspace-run-coordinator.cjs')
const { LocalWorkspaceRunCoordinator } = coordinatorApi
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { fixture: workspaceFixture } = require('../support/local-workspace-test-helpers.cjs')

const CONTEXT_PACK_ID = `context-pack-${'a'.repeat(64)}`

function fixture(overrides = {}) {
  const preparingRuns = new Map()
  const activeRuns = new Map()
  const calls = []
  let shuttingDown = false
  let nextRunId = 0
  let runSilenceWarningMs = overrides.runSilenceWarningMs ?? 20
  const coordinator = new LocalWorkspaceRunCoordinator({
    preparingRuns,
    activeRuns,
    createRunId: () => `run-${++nextRunId}`,
    getRunSilenceWarningMs: () => runSilenceWarningMs,
    setTimeout: overrides.setTimeout,
    clearTimeout: overrides.clearTimeout,
    isShuttingDown: () => shuttingDown,
    setShuttingDown: (value) => {
      shuttingDown = value
      calls.push(['shutdown', value])
    },
    checkpointRun: overrides.checkpointRun || ((...args) => {
      calls.push(['checkpoint', ...args])
      return true
    }),
    hasRunLedger: () => overrides.hasRunLedger === true,
    validateContextPack: overrides.validateContextPack || (() => true),
    finishRunCheckpoint: overrides.finishRunCheckpoint || ((...args) => {
      calls.push(['ledger-finish', ...args])
      return true
    }),
    scheduleRunCheckpoint: (...args) => calls.push(['schedule', ...args]),
    emitChanged: overrides.emitChanged || (() => calls.push(['changed'])),
    emit: (...args) => calls.push(['emit', ...args]),
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 4,
    terminalRetrySleep: overrides.terminalRetrySleep || (() => Promise.resolve()),
  })
  return {
    activeRuns,
    calls,
    coordinator,
    isShuttingDown: () => shuttingDown,
    preparingRuns,
    setRunSilenceWarningMs: value => { runSilenceWarningMs = value },
  }
}

test('run coordinator exposes one class and LocalWorkspace keeps its public lifecycle methods', () => {
  assert.deepEqual(Object.keys(coordinatorApi), ['LocalWorkspaceRunCoordinator'])
  const methods = [
    'createRunController', 'isGroupBusy', 'reserveRun', 'bindRunTask',
    'releasePreparation', 'beginRun',
    'finishRun', 'ensureRunHarness', 'emitRunEvent', 'clearAgentSilence',
    'armAgentSilence', 'clearRunSilence', 'stop', 'stopAll',
  ]
  for (const method of methods) assert.equal(typeof LocalWorkspace.prototype[method], 'function')
})

test('LocalWorkspace collaborators share the original run Map identities', (t) => {
  const { directory, options } = workspaceFixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)

  assert.equal(workspace.runCoordinator.preparingRuns, workspace.preparingRuns)
  assert.equal(workspace.runLedgerCoordinator.preparingRuns, workspace.preparingRuns)
  assert.equal(workspace.runCoordinator.activeRuns, workspace.activeRuns)
  assert.equal(workspace.runMessages.activeRuns, workspace.activeRuns)
  assert.equal(workspace.agentInvocation.activeRuns, workspace.activeRuns)
  assert.equal(workspace.runLedgerCoordinator.timers, workspace.runCheckpointTimers)
})

test('workspace snapshots surface only the typed terminal persistence state', (t) => {
  const { directory, options } = workspaceFixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  const controller = workspace.createRunController('manual', ['codex'], 'task-1')
  controller.groupId = 'group-1'
  controller.taskBound = true
  controller.contextPackId = CONTEXT_PACK_ID
  controller.terminalPersistence = {
    state: 'failed',
    status: 'completed',
    attempts: 3,
    nextRetryAt: 0,
    code: 'LOCAL_RUN_PERSIST_FAILED',
    privateDiagnostic: '/private/run-ledger.json',
  }
  workspace.activeRuns.set('group-1', controller)

  assert.deepEqual(workspace.snapshot().runs[0].terminalPersistence, {
    state: 'failed',
    status: 'completed',
    attempts: 3,
    nextRetryAt: 0,
    code: 'LOCAL_RUN_PERSIST_FAILED',
  })
})

test('workspace snapshots preserve completed V4 orchestration and terminal slot statuses', (t) => {
  const { directory, options } = workspaceFixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  const controller = workspace.createRunController('manual', ['codex', 'hermes'], 'task-v4')
  controller.groupId = 'group-v4'
  controller.taskBound = true
  controller.contextPackId = CONTEXT_PACK_ID
  controller.orchestration = {
    version: 4,
    template: 'concurrent-batch',
    phase: 'completed',
    round: 4,
    currentKinds: [],
    plan: {
      assignments: [
        { agentKind: 'codex', role: 'writer' },
        { agentKind: 'hermes', role: 'verifier' },
      ],
    },
    slots: [
      { agentKind: 'codex', phase: 'completed', status: 'completed', attempt: 1 },
      { agentKind: 'hermes', phase: 'completed', status: 'partial', attempt: 2 },
    ],
    commitState: { status: 'committed' },
  }
  controller.terminalPersistence = {
    state: 'failed',
    status: 'completed',
    attempts: 3,
    nextRetryAt: 100,
    code: 'LOCAL_RUN_PERSIST_FAILED',
    privateDiagnostic: '/private/run-ledger.json',
  }
  workspace.activeRuns.set('group-v4', controller)

  const publicRun = workspace.snapshot().runs[0]
  assert.deepEqual(publicRun.orchestration, {
    version: 4,
    phase: 'completed',
    currentKinds: [],
    slots: [
      { agentKind: 'codex', phase: 'completed', status: 'completed', role: 'writer', round: 4 },
      { agentKind: 'hermes', phase: 'completed', status: 'partial', role: 'verifier', round: 4 },
    ],
  })
  assert.equal(publicRun.taskId, undefined)
  assert.equal(publicRun.contextPackId, undefined)
  assert.equal(publicRun.contextPackState, undefined)
  assert.equal(publicRun.terminalPersistence, undefined)
})

test('workspace snapshots expose coordination and work V4 phases through the safe projection', (t) => {
  const { directory, options } = workspaceFixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  const controller = workspace.createRunController('manual', ['codex'], 'task-v4-phases')
  controller.groupId = 'group-v4-phases'
  controller.taskBound = true
  controller.orchestration = {
    version: 4,
    template: 'discussion',
    phase: 'coordination',
    currentKinds: ['codex', '../private'],
    plan: { assignments: [{ agentKind: 'codex', role: '../private' }] },
    slots: [{
      agentKind: 'codex',
      phase: 'coordination',
      status: 'running',
      attempt: 1,
      executable: '/private/codex',
      prompt: 'must not cross the bridge',
    }],
    coordinationPlan: { privatePrompt: 'must not cross the bridge' },
    commitState: { status: 'pending' },
  }
  workspace.activeRuns.set('group-v4-phases', controller)

  const coordination = workspace.snapshot().runs[0].orchestration
  assert.equal(coordination.phase, 'coordination')
  assert.deepEqual(coordination.currentKinds, ['codex'])
  assert.equal(coordination.slots[0].phase, 'coordination')
  assert.equal(coordination.slots[0].role, undefined)
  assert.equal(coordination.slots[0].executable, undefined)
  assert.equal(coordination.coordinationPlan, undefined)

  controller.orchestration.phase = 'work'
  controller.orchestration.slots[0].phase = 'work'
  const work = workspace.snapshot().runs[0].orchestration
  assert.equal(work.phase, 'work')
  assert.equal(work.slots[0].phase, 'work')
})

test('workspace snapshots keep a safe controllable run shell for an unknown V4 orchestration phase', (t) => {
  const { directory, options } = workspaceFixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  const controller = workspace.createRunController('manual', ['codex'], 'task-v4-invalid-phase')
  controller.groupId = 'group-v4-invalid-phase'
  controller.taskBound = true
  controller.orchestration = {
    version: 4,
    phase: 'private-phase',
    currentKinds: ['codex'],
    slots: [{ agentKind: 'codex', phase: 'proposal', status: 'running' }],
    privatePrompt: 'must not cross the bridge',
  }
  controller.terminalPersistence = {
    state: 'failed',
    status: 'completed',
    attempts: 2,
    nextRetryAt: 100,
    code: 'LOCAL_RUN_PERSIST_FAILED',
  }
  workspace.activeRuns.set(controller.groupId, controller)

  const snapshot = workspace.snapshot()
  assert.deepEqual(snapshot.runningGroupIds, ['group-v4-invalid-phase'])
  assert.equal(snapshot.runs.length, 1)
  const publicRun = snapshot.runs[0]
  assert.equal(publicRun.groupId, 'group-v4-invalid-phase')
  assert.equal(publicRun.runId, controller.runId)
  assert.equal(publicRun.phase, 'running')
  assert.equal(publicRun.mode, 'manual')
  assert.deepEqual(publicRun.targetKinds, ['codex'])
  assert.deepEqual(publicRun.orchestration, { version: 4 })
  assert.equal(publicRun.taskId, undefined)
  assert.equal(publicRun.contextPackId, undefined)
  assert.equal(publicRun.contextPackState, undefined)
  assert.equal(publicRun.terminalPersistence, undefined)
  assert.deepEqual(Object.keys(publicRun).sort(), [
    'agentRuns', 'budget', 'completedKinds', 'currentKind', 'currentRound', 'failedKinds',
    'groupId', 'maxRounds', 'mode', 'orchestration', 'phase', 'progress',
    'responseVersionRootId', 'runId', 'startedAt', 'targetKinds', 'threadRootId',
    'unlimitedRounds', 'waitingGateIds',
  ])
})

test('workspace snapshots drop V4 slots with unknown phase or status values', (t) => {
  const { directory, options } = workspaceFixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  const controller = workspace.createRunController('manual', ['codex', 'hermes'], 'task-v4-invalid-slots')
  controller.groupId = 'group-v4-invalid-slots'
  controller.taskBound = true
  controller.orchestration = {
    version: 4,
    phase: 'proposal',
    round: 2,
    currentKinds: ['codex', 'hermes'],
    slots: [
      { agentKind: 'codex', phase: 'private-phase', status: 'running' },
      { agentKind: 'hermes', phase: 'proposal', status: 'private-status' },
      { agentKind: 'codex', phase: 'proposal', status: 'completed' },
    ],
  }
  workspace.activeRuns.set(controller.groupId, controller)

  assert.deepEqual(workspace.snapshot().runs[0].orchestration.slots, [
    { agentKind: 'codex', phase: 'proposal', status: 'completed', round: 2 },
  ])
})

test('controller construction copies targets and keeps its completion state idempotent', async () => {
  const { coordinator } = fixture()
  const targets = ['codex', 'hermes']
  const controller = coordinator.createController('auto', targets, 'root-1', 20)
  targets.push('kimi')

  assert.equal(controller.runId, 'run-1')
  assert.equal(controller.taskId, 'root-1')
  assert.equal(controller.taskBound, false)
  assert.deepEqual(controller.targetKinds, ['codex', 'hermes'])
  assert.equal(controller.maxRounds, 10)
  assert.equal(controller.unlimitedRounds, false)
  assert.equal(controller.signal.aborted, false)
  assert.equal(controller.agentFailureReasons instanceof Map, true)
  assert.equal(controller.silenceTimers instanceof Map, true)

  let completed = 0
  controller.done.then(() => { completed += 1 })
  controller.resolveDone()
  controller.resolveDone()
  await controller.done
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(completed, 1)
})

test('reservation migrates the same controller into active state and preserves lifecycle order', async () => {
  const { activeRuns, calls, coordinator, preparingRuns } = fixture()
  const reservation = coordinator.reserve('group-1', 'auto', ['codex'], 'root-1', 3)

  assert.equal(preparingRuns.get('group-1'), reservation)
  assert.deepEqual(calls.map(call => call[0]), ['changed'])

  calls.length = 0
  assert.equal(coordinator.bindTask(
    'group-1', reservation, 'task-1', 'root-1', CONTEXT_PACK_ID,
  ), true)
  assert.equal(reservation.taskId, 'task-1')
  assert.equal(reservation.threadRootId, 'root-1')
  assert.equal(reservation.contextPackId, CONTEXT_PACK_ID)
  assert.equal(reservation.taskBound, true)
  assert.deepEqual(calls.map(call => call[0]), ['checkpoint', 'changed'])
  assert.equal(calls[0][3], 'preparing')

  calls.length = 0
  const started = coordinator.begin(
    'group-1', 'auto', ['codex'], 'root-1', reservation, 3,
  )
  assert.equal(started, reservation)
  assert.equal(preparingRuns.has('group-1'), false)
  assert.equal(activeRuns.get('group-1'), reservation)
  assert.deepEqual(calls.map(call => call[0]), ['checkpoint', 'changed'])
  assert.equal(calls[0][3], 'running')

  calls.length = 0
  await coordinator.finish('group-1', reservation, 'completed')
  await reservation.done
  assert.equal(activeRuns.has('group-1'), false)
  assert.deepEqual(calls.map(call => call[0]), ['ledger-finish', 'changed', 'emit'])
  assert.equal(calls[0][3], 'completed')
  assert.equal(calls[2][1], 'run-finished')
  assert.equal(calls[2][2].status, 'completed')
  assert.equal(calls[2][2].taskId, 'task-1')
})

test('resume restores the latest durable completion and failure state per Agent', async () => {
  const { activeRuns, calls, coordinator } = fixture()
  const controller = coordinator.resume({
    runId: 'run-durable',
    taskId: 'task-1',
    contextPackId: CONTEXT_PACK_ID,
    groupId: 'group-1',
    threadRootId: 'root-1',
    mode: 'manual',
    targetKinds: ['codex', 'hermes', 'kimi', 'workbuddy'],
    currentRound: 2,
    startedAt: 100,
    attemptHistory: [],
    continuation: {
      gateId: 'gate-1',
      gateType: 'permission',
      resumeKind: 'agent_slot',
      state: 'ready',
      agentRunId: 'agent-run-hermes-2',
      agentKind: 'hermes',
      round: 2,
      createdAt: 100,
      updatedAt: 200,
    },
    agentRuns: [
      { agentRunId: 'agent-run-codex-1', kind: 'codex', status: 'failed' },
      { agentRunId: 'agent-run-codex-2', kind: 'codex', status: 'completed' },
      { agentRunId: 'agent-run-hermes-1', kind: 'hermes', status: 'completed' },
      { agentRunId: 'agent-run-hermes-2', kind: 'hermes', status: 'stopped' },
      { agentRunId: 'agent-run-kimi-1', kind: 'kimi', status: 'waiting' },
      { agentRunId: 'agent-run-workbuddy-1', kind: 'workbuddy', status: 'interrupted' },
    ],
  })

  assert.equal(controller.runId, 'run-durable')
  assert.equal(activeRuns.get('group-1'), controller)
  assert.deepEqual(controller.completedKinds, ['codex', 'hermes', 'workbuddy'])
  assert.deepEqual(controller.failedKinds, ['hermes'])

  calls.length = 0
  await coordinator.finish('group-1', controller, 'completed')
  await controller.done
  const event = calls.find(call => call[0] === 'emit' && call[1] === 'run-finished')[2]
  assert.deepEqual(event.completedKinds, ['codex', 'hermes', 'workbuddy'])
  assert.deepEqual(event.failedKinds, ['hermes'])
})

test('the first durable Task checkpoint fails closed without creating a Run', async () => {
  const calls = []
  const { activeRuns, coordinator, preparingRuns } = fixture({
    hasRunLedger: true,
    checkpointRun: (...args) => {
      calls.push(args)
      return false
    },
  })

  const controller = coordinator.reserve('group-1', 'manual', ['codex'])
  assert.throws(
    () => coordinator.bindTask(
      'group-1', controller, 'task-1', 'root-1', CONTEXT_PACK_ID,
    ),
    { message: 'LOCAL_RUN_PERSIST_FAILED' },
  )

  assert.equal(controller.taskBound, false)
  assert.equal(controller.contextPackId, '')
  assert.equal(preparingRuns.get('group-1'), controller)
  assert.equal(activeRuns.size, 0)
  assert.equal(coordinator.releasePreparation('group-1', controller), true)
  assert.equal(calls.some(call => call[0] === 'ledger-finish'), false)
  await controller.done
})

test('Context Pack validation happens before the first durable checkpoint', async () => {
  const validationCalls = []
  const { calls, coordinator } = fixture({
    validateContextPack: (...args) => {
      validationCalls.push(args)
      return false
    },
  })
  const controller = coordinator.reserve('group-1', 'manual', ['codex'])
  calls.length = 0

  assert.throws(
    () => coordinator.bindTask(
      'group-1', controller, 'task-1', 'root-1', CONTEXT_PACK_ID,
    ),
    { message: 'LOCAL_RUN_CONTEXT_PACK_INVALID' },
  )

  assert.deepEqual(validationCalls, [[CONTEXT_PACK_ID, 'task-1']])
  assert.deepEqual(calls, [])
  assert.equal(controller.taskBound, false)
  assert.equal(controller.contextPackId, '')
  coordinator.releasePreparation('group-1', controller)
  await controller.done
})

test('LocalWorkspace rejects a Context Pack captured for another Task', async (t) => {
  const { directory, options } = workspaceFixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Pack binding', agentKinds: ['codex'], workdir: directory,
  })
  const firstTask = workspace.addMessage(group.id, 'user', 'First Task')
  const secondTask = workspace.addMessage(group.id, 'user', 'Second Task')
  const firstPack = workspace.createContextPack({
    group,
    taskId: firstTask.id,
    mode: 'manual',
    targetKinds: ['codex'],
    message: firstTask,
  })
  const controller = workspace.reserveRun(
    group.id, 'manual', ['codex'], secondTask.id,
  )

  assert.throws(
    () => workspace.bindRunTask(
      group.id, controller, secondTask.id, secondTask.id, firstPack.contextPackId,
    ),
    { message: 'LOCAL_RUN_CONTEXT_PACK_INVALID' },
  )
  assert.equal(controller.taskBound, false)
  assert.equal(controller.contextPackId, '')
  workspace.releasePreparation(group.id, controller)
  await controller.done
})

test('changed failures abort and release newly reserved or active controllers', async () => {
  const expected = new Error('listener failed')
  const first = fixture({ emitChanged: () => { throw expected } })
  let reservation = null
  const createController = first.coordinator.createController.bind(first.coordinator)
  first.coordinator.createController = (...args) => {
    reservation = createController(...args)
    return reservation
  }
  assert.throws(() => {
    first.coordinator.reserve('group-1', 'manual', ['codex'])
  }, expected)
  assert.equal(first.preparingRuns.has('group-1'), false)
  assert.equal(reservation.signal.aborted, true)

  const second = fixture()
  const secondReservation = second.coordinator.reserve('group-2', 'manual', ['codex'])
  second.coordinator.bindTask(
    'group-2', secondReservation, 'task-2', 'root-2', CONTEXT_PACK_ID,
  )
  second.coordinator.emitChanged = () => { throw expected }
  assert.throws(() => {
    second.coordinator.begin(
      'group-2', 'manual', ['codex'], 'root-2', secondReservation,
    )
  }, expected)
  assert.equal(second.activeRuns.has('group-2'), false)
  assert.equal(second.preparingRuns.get('group-2'), secondReservation)
  assert.equal(secondReservation.signal.aborted, false)
  second.coordinator.emitChanged = () => {}
  second.coordinator.releasePreparation('group-2', secondReservation)

  await Promise.all([reservation.done, secondReservation.done])
})

test('stale finish keeps a newer active controller while still publishing completion', async () => {
  const { activeRuns, calls, coordinator } = fixture()
  const stale = coordinator.createController('manual', ['codex'], 'root-1')
  const current = coordinator.createController('manual', ['hermes'], 'root-2')
  activeRuns.set('group-1', current)

  await coordinator.finish('group-1', stale, 'completed')
  await stale.done

  assert.equal(activeRuns.get('group-1'), current)
  assert.deepEqual(calls.map(call => call[0]), ['ledger-finish', 'emit'])
  assert.equal(calls[1][2].runId, stale.runId)
})

test('terminal persistence retries automatically before completion is acknowledged', async () => {
  let attempts = 0
  const delays = []
  const { activeRuns, calls, coordinator } = fixture({
    hasRunLedger: true,
    finishRunCheckpoint: (...args) => {
      calls.push(['ledger-finish', ...args])
      attempts += 1
      return attempts > 1
    },
    terminalRetrySleep: async delayMs => { delays.push(delayMs) },
  })
  const controller = coordinator.createController('manual', ['codex'], 'task-1')
  controller.groupId = 'group-1'
  controller.taskBound = true
  controller.contextPackId = CONTEXT_PACK_ID
  activeRuns.set('group-1', controller)

  await coordinator.finish('group-1', controller, 'completed')

  assert.equal(attempts, 2)
  assert.deepEqual(delays, [1])
  assert.equal(activeRuns.has('group-1'), false)
  assert.equal(controller.terminalPersistence.state, 'committed')
  assert.equal(calls.filter(call => call[0] === 'emit' && call[1] === 'run-finished').length, 1)
  await controller.done
})

test('permanent terminal persistence failure retains the controller and typed outbox state', async () => {
  const { activeRuns, calls, coordinator } = fixture({
    hasRunLedger: true,
    finishRunCheckpoint: (...args) => {
      calls.push(['ledger-finish', ...args])
      return false
    },
  })
  const controller = coordinator.createController('manual', ['codex'], 'task-1')
  controller.groupId = 'group-1'
  controller.taskBound = true
  controller.contextPackId = CONTEXT_PACK_ID
  activeRuns.set('group-1', controller)

  await assert.rejects(
    coordinator.finish('group-1', controller, 'completed'),
    error => error?.code === 'LOCAL_RUN_TERMINAL_PERSIST_FAILED'
      && error.persistence?.state === 'failed',
  )

  assert.equal(activeRuns.get('group-1'), controller)
  assert.equal(controller.finished, false)
  assert.deepEqual(controller.terminalOutbox.status, 'completed')
  assert.deepEqual(controller.terminalPersistence, {
    state: 'failed',
    status: 'completed',
    attempts: 3,
    nextRetryAt: 0,
    code: 'LOCAL_RUN_PERSIST_FAILED',
  })
  assert.equal(calls.filter(call => call[0] === 'ledger-finish').length, 3)
  assert.equal(calls.some(call => call[0] === 'emit' && call[1] === 'run-finished'), false)
  assert.equal(controller.finishingPromise, null)
})

test('a retained terminal outbox can be retried without downgrading its original status', async () => {
  let writable = false
  const { activeRuns, calls, coordinator } = fixture({
    hasRunLedger: true,
    finishRunCheckpoint: (...args) => {
      calls.push(['ledger-finish', ...args])
      return writable
    },
  })
  const controller = coordinator.createController('manual', ['codex'], 'task-1')
  controller.groupId = 'group-1'
  controller.taskBound = true
  controller.contextPackId = CONTEXT_PACK_ID
  activeRuns.set('group-1', controller)

  await assert.rejects(
    coordinator.finish('group-1', controller, 'completed'),
    { message: 'LOCAL_RUN_TERMINAL_PERSIST_FAILED' },
  )
  writable = true
  await coordinator.finish('group-1', controller, 'failed')

  const event = calls.find(call => call[0] === 'emit' && call[1] === 'run-finished')[2]
  assert.equal(event.status, 'completed')
  assert.equal(controller.terminalPersistence.state, 'committed')
  assert.equal(activeRuns.has('group-1'), false)
})

test('RunHarness and silence warnings remain lazy, dynamic, and checkpointed in order', () => {
  let scheduled = null
  const cleared = []
  const fakeSetTimeout = (handler, delay) => {
    const timer = { unref() {} }
    scheduled = { delay, handler, timer }
    return timer
  }
  const {
    calls, coordinator, setRunSilenceWarningMs,
  } = fixture({
    clearTimeout: timer => cleared.push(timer),
    runSilenceWarningMs: 20,
    setTimeout: fakeSetTimeout,
  })
  const controller = coordinator.createController('manual', ['codex'], 'root-1')
  controller.groupId = 'group-1'
  const group = { id: 'group-1' }
  const harness = coordinator.ensureHarness(group, controller, 'root-1')
  assert.equal(coordinator.ensureHarness(group, controller, 'other-root'), harness)

  controller.harness = {
    markSilent: () => {
      calls.push(['mark-silent'])
      return { type: 'warning', title: 'waiting_for_output' }
    },
  }
  setRunSilenceWarningMs(75)
  coordinator.armAgentSilence(controller, 'codex', 1, 'agent-run-1')
  assert.equal(scheduled.delay, 75)
  scheduled.handler()

  assert.deepEqual(calls.slice(-3).map(call => call[0]), ['mark-silent', 'emit', 'schedule'])
  assert.equal(calls.at(-2)[1], 'run-event')
  coordinator.clearRunSilence(controller)
  assert.deepEqual(cleared, [scheduled.timer])
  assert.equal(controller.silenceTimers.size, 0)
})

test('stopAll deduplicates controllers, preserves stop reasons, and waits for done', async () => {
  const { activeRuns, coordinator, isShuttingDown, preparingRuns } = fixture()
  const controller = coordinator.createController('manual', ['codex'], '')
  controller.stopReason = 'user'
  let aborts = 0
  const abort = controller.abort.bind(controller)
  controller.abort = () => {
    aborts += 1
    abort()
  }
  preparingRuns.set('group-1', controller)
  activeRuns.set('group-1', controller)

  let settled = false
  const stopping = coordinator.stopAll().then(() => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(isShuttingDown(), true)
  assert.equal(aborts, 1)
  assert.equal(controller.stopReason, 'user')
  assert.equal(settled, false)
  assert.throws(
    () => coordinator.reserve('group-2', 'manual', ['codex']),
    { message: 'LOCAL_AGENT_EXECUTION_STOPPED' },
  )

  controller.resolveDone()
  await stopping
  assert.equal(settled, true)
})

test('shutdown settles a waiting Run even when its final continuation checkpoint fails', async () => {
  const { activeRuns, coordinator } = fixture({
    hasRunLedger: true,
    checkpointRun: (_groupId, _controller, status) => status !== 'waiting',
  })
  const controller = coordinator.createController('manual', ['codex'], 'task-1')
  controller.groupId = 'group-1'
  controller.continuation = {
    gateId: 'human-gate-pending',
    state: 'pending',
  }
  activeRuns.set('group-1', controller)

  const stopping = coordinator.stopAll()
  assert.throws(
    () => coordinator.finish('group-1', controller, 'interrupted'),
    { message: 'LOCAL_RUN_PERSIST_FAILED' },
  )

  let timeout
  const settled = await Promise.race([
    stopping.then(() => true),
    new Promise(resolve => { timeout = setTimeout(() => resolve(false), 100) }),
  ])
  clearTimeout(timeout)
  assert.equal(settled, true)
  assert.equal(controller.finished, true)
  assert.equal(activeRuns.has('group-1'), false)
})

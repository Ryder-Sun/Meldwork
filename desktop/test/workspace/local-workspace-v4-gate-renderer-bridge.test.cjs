const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  v4ManualRecoveryGateInput,
} = require('../../src/workspace/local-workspace-message-submission.cjs')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { RunLedger } = require('../../src/runs/run-ledger.cjs')
const { RunScheduler } = require('../../src/runs/run-scheduler.cjs')
const { fixture } = require('../support/local-workspace-test-helpers.cjs')

const repositoryRoot = path.resolve(__dirname, '../../..')
const frontendRoot = path.join(repositoryRoot, 'frontend')

let normalizeSnapshot

test.before(async () => {
  const { rolldown } = require(path.join(frontendRoot, 'node_modules/rolldown'))
  const bundle = await rolldown({ input: path.join(frontendRoot, 'src/desktop-snapshot.js') })
  try {
    const generated = await bundle.generate({ format: 'cjs', exports: 'named' })
    const chunk = generated.output.find(output => output.type === 'chunk')
    const module = { exports: {} }
    Function('module', 'exports', 'require', chunk.code)(module, module.exports, require)
    ;({ normalizeSnapshot } = module.exports)
  } finally {
    await bundle.close()
  }
})

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function proposalCollaboration(summary) {
  return {
    version: 1,
    phase: 'proposal',
    summary,
    capabilities: ['Independent analysis'],
    intendedWork: ['Complete the assigned proposal'],
    deliverables: ['Proposal'],
    dependencies: [],
  }
}

async function waitFor(predicate, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await delay(10)
  }
  throw new Error(`TEST_TIMEOUT:${label}`)
}

function waitForPendingGate(workspace, timeoutMs = 2000) {
  const current = workspace.listHumanGates({ pendingOnly: true })[0]
  if (current) return Promise.resolve(current)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      workspace.off('changed', changed)
      reject(new Error('TEST_HUMAN_GATE_TIMEOUT'))
    }, timeoutMs)
    const changed = () => {
      const gate = workspace.listHumanGates({ pendingOnly: true })[0]
      if (!gate) return
      clearTimeout(timer)
      workspace.off('changed', changed)
      resolve(gate)
    }
    workspace.on('changed', changed)
  })
}

async function runningV4Workspace(t, {
  mode = 'auto',
  phase = 'human-gate',
  round = 2,
  targetKinds = ['codex'],
} = {}) {
  const { directory, options } = fixture()
  const workspace = new LocalWorkspace(options)
  t.after(() => {
    for (const controller of new Set([
      ...workspace.preparingRuns.values(),
      ...workspace.activeRuns.values(),
    ])) {
      controller.abort()
      controller.resolveDone()
    }
    workspace.preparingRuns.clear()
    workspace.activeRuns.clear()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'V4 Gate renderer bridge',
    agentKinds: targetKinds,
    workdir: directory,
    allowWrite: true,
  })
  const controller = workspace.createRunController(
    mode, targetKinds, 'thread-v4-gate', mode === 'auto' ? 4 : 0,
  )
  controller.groupId = group.id
  controller.taskBound = true
  controller.currentRound = round
  controller.orchestration = {
    version: 4,
    phase,
    currentKinds: [...targetKinds],
    slots: targetKinds.map(agentKind => ({
      agentKind,
      phase,
      status: 'waiting',
    })),
  }
  workspace.activeRuns.set(group.id, controller)
  return { controller, group, workspace }
}

function addAttempt(workspace, group, controller, kind, round, status = 'failed') {
  const harness = workspace.ensureRunHarness(group, controller, controller.threadRootId)
  const event = harness.beginAgent(kind, round)
  harness.finishAgent(kind, round, status, `${kind} ${status}`, {}, event.agentRunId)
  return event.agentRunId
}

function bindPrivateAttempt(controller, agentKind, publicAgentRunId) {
  const slot = controller.orchestration.slots.find(candidate => candidate.agentKind === agentKind)
  slot.agentRunId = publicAgentRunId
  return publicAgentRunId
}

async function pendingSnapshot(workspace, input, continuation) {
  const waiting = workspace.requestHumanGate(input, { continuation })
  const gate = await waitForPendingGate(workspace)
  return {
    gate,
    raw: workspace.snapshot(),
    settle: async () => {
      const rejection = gate.options.find(option => option.kind.includes('reject'))
      workspace.decideHumanGate(gate.gateId, { optionId: rejection.optionId })
      await waiting
    },
  }
}

const bridgeScenarios = [
  {
    name: 'Manual V4 unknown-writer Gate',
    mode: 'manual',
    phase: 'proposal',
    gate({ controller }) {
      const slot = {
        agentKind: 'codex',
        slotId: 'slot-1-codex',
        operationId: `agent-operation-${'a'.repeat(64)}`,
        attempt: 2,
      }
      Object.assign(controller.orchestration.slots[0], slot)
      return {
        input: v4ManualRecoveryGateInput(controller.runId, 'batch-private-manual', slot),
        continuation: {
          resumeKind: 'agent_slot',
          agentRunId: slot.operationId,
          agentKind: slot.agentKind,
          round: controller.currentRound,
          phase: 'proposal',
          slotId: slot.slotId,
          operationId: slot.operationId,
          snapshotHash: 'snapshot-private-manual',
        },
        privateIds: [slot.operationId, 'batch-private-manual'],
      }
    },
  },
  {
    name: 'Auto V4 stalled-convergence Gate',
    mode: 'auto',
    phase: 'human-gate',
    gate({ controller, workspace }) {
      const operationId = workspace.autoRunner.v4OperationId(
        controller, 'codex', 'human-gate', 'slot-1-codex',
      )
      return {
        input: {
          type: 'decision',
          runId: controller.runId,
          agentRunId: operationId,
          agentKind: 'codex',
          summary: 'The candidate and unresolved issues have remained unchanged for two rounds.',
          options: [
            { optionId: 'continue-discussion', name: 'Continue', kind: 'accept' },
            { optionId: 'stop-discussion', name: 'Stop', kind: 'reject' },
          ],
          request: {
            phase: 'discussion',
            round: controller.currentRound,
            candidateHash: 'candidate-private-convergence',
            unresolvedIssueIds: [],
            stateEpoch: 3,
          },
        },
        continuation: {
          resumeKind: 'v4_human_gate',
          agentRunId: operationId,
          agentKind: 'codex',
          round: controller.currentRound,
          stateEpoch: 3,
        },
        privateIds: [operationId],
      }
    },
  },
  {
    name: 'Auto V4 synthesis-recovery Gate',
    mode: 'auto',
    phase: 'human-gate',
    gate({ controller, workspace }) {
      const operationId = workspace.autoRunner.v4OperationId(
        controller, 'codex', 'synthesis', 'slot-1-codex',
      )
      return {
        input: {
          type: 'decision',
          runId: controller.runId,
          agentRunId: operationId,
          agentKind: 'codex',
          summary: 'The workspace-write synthesis attempt may have produced side effects, but its result is unknown.',
          options: [
            { optionId: 'retry-original-writer', name: 'Retry original writer', kind: 'accept' },
            { optionId: 'stop-discussion', name: 'Stop', kind: 'reject' },
          ],
          request: {
            phase: 'synthesis-recovery',
            bindingHash: 'binding-private-synthesis',
            writerKind: 'codex',
            slotId: 'slot-1-codex',
            operationId,
            attempt: 1,
            proposedReplacementKind: '',
            round: controller.currentRound,
            stateEpoch: 4,
            outcomeCertainty: 'unknown_outcome',
          },
        },
        continuation: {
          resumeKind: 'v4_synthesis_recovery',
          agentRunId: operationId,
          agentKind: 'codex',
          round: controller.currentRound,
          stateEpoch: 4,
        },
        privateIds: [operationId],
      }
    },
  },
]

for (const scenario of bridgeScenarios) {
  test(`${scenario.name} keeps its explicitly bound earlier Harness attempt`, async (t) => {
    const context = await runningV4Workspace(t, scenario)
    const boundAgentRunId = bindPrivateAttempt(
      context.controller,
      'codex',
      addAttempt(context.workspace, context.group, context.controller, 'codex', 1, 'completed'),
    )
    const newerAgentRunId = addAttempt(
      context.workspace, context.group, context.controller, 'codex', 2,
    )
    const gateInput = scenario.gate(context)
    const pending = await pendingSnapshot(
      context.workspace, gateInput.input, {
        ...gateInput.continuation,
        publicAgentRunId: boundAgentRunId,
      },
    )
    try {
      const normalized = normalizeSnapshot(pending.raw)
      assert.deepEqual(normalized.humanGates.map(gate => ({
        gateId: gate.gateId,
        agentRunId: gate.agentRunId,
        agentKind: gate.agentKind,
      })), [{
        gateId: pending.gate.gateId,
        agentRunId: boundAgentRunId,
        agentKind: 'codex',
      }])
      assert.deepEqual(normalized.runs[0].waitingGateIds, [pending.gate.gateId])
      assert.notEqual(newerAgentRunId, boundAgentRunId)
      assert.equal(pending.raw.humanGates[0].agentRunId, boundAgentRunId)
      assert.equal(
        context.controller.continuation.agentRunId,
        gateInput.continuation.agentRunId,
      )
      const publicJson = JSON.stringify(pending.raw)
      for (const privateId of gateInput.privateIds) assert.equal(publicJson.includes(privateId), false)
    } finally {
      await pending.settle()
    }
  })
}

test('private V4 Gate ignores a Harness attempt whose ID collides with its operation ID', async (t) => {
  const context = await runningV4Workspace(t, {
    mode: 'auto',
    phase: 'human-gate',
  })
  const boundAgentRunId = bindPrivateAttempt(
    context.controller,
    'codex',
    addAttempt(context.workspace, context.group, context.controller, 'codex', 1, 'completed'),
  )
  const operationId = context.workspace.autoRunner.v4OperationId(
    context.controller, 'codex', 'human-gate', 'slot-1-codex',
  )
  const collidingAgentRunId = addAttempt(
    context.workspace, context.group, context.controller, 'codex', 2,
  )
  const collidingAttempt = context.controller.harness.agentRuns.find(attempt => (
    attempt.agentRunId === collidingAgentRunId
  ))
  collidingAttempt.agentRunId = operationId
  const pending = await pendingSnapshot(context.workspace, {
    type: 'decision',
    runId: context.controller.runId,
    agentRunId: operationId,
    agentKind: 'codex',
    summary: 'The candidate and unresolved issues have remained unchanged for two rounds.',
    options: [
      { optionId: 'continue-discussion', name: 'Continue', kind: 'accept' },
      { optionId: 'stop-discussion', name: 'Stop', kind: 'reject' },
    ],
    request: { phase: 'discussion', stateEpoch: 3 },
  }, {
    resumeKind: 'v4_human_gate',
    agentRunId: operationId,
    publicAgentRunId: boundAgentRunId,
    agentKind: 'codex',
    round: 2,
    stateEpoch: 3,
  })
  try {
    const normalized = normalizeSnapshot(pending.raw)
    assert.equal(pending.raw.humanGates[0].agentRunId, boundAgentRunId)
    assert.equal(normalized.humanGates[0].agentRunId, boundAgentRunId)
    assert.deepEqual(normalized.runs[0].waitingGateIds, [pending.gate.gateId])
  } finally {
    await pending.settle()
  }
})

test('durable waiting V4 Gate projects the visible Harness attempt after restart', async (t) => {
  const context = await runningV4Workspace(t, {
    mode: 'auto',
    phase: 'human-gate',
  })
  const boundAgentRunId = bindPrivateAttempt(
    context.controller,
    'codex',
    addAttempt(context.workspace, context.group, context.controller, 'codex', 1, 'completed'),
  )
  addAttempt(
    context.workspace, context.group, context.controller, 'codex', 2,
  )
  const gateInput = bridgeScenarios[1].gate(context)
  const pending = await pendingSnapshot(
    context.workspace, gateInput.input, {
      ...gateInput.continuation,
      publicAgentRunId: boundAgentRunId,
    },
  )
  const durableRun = {
    runId: context.controller.runId,
    groupId: context.group.id,
    status: 'waiting',
    mode: 'auto',
    targetKinds: ['codex'],
    currentRound: context.controller.currentRound,
    maxRounds: context.controller.maxRounds,
    unlimitedRounds: false,
    continuation: structuredClone(context.controller.continuation),
    orchestration: structuredClone(context.controller.orchestration),
    agentRuns: context.controller.harness.snapshot(),
    threadRootId: context.controller.threadRootId,
    startedAt: context.controller.startedAt,
  }
  try {
    context.workspace.activeRuns.delete(context.group.id)
    context.workspace.runLedger = { list: () => [durableRun] }
    const raw = context.workspace.snapshot()
    const normalized = normalizeSnapshot(raw)

    assert.equal(raw.humanGates[0].agentRunId, boundAgentRunId)
    assert.equal(normalized.humanGates[0].agentRunId, boundAgentRunId)
    assert.deepEqual(normalized.runs[0].waitingGateIds, [pending.gate.gateId])
    assert.equal(durableRun.continuation.agentRunId, gateInput.continuation.agentRunId)
    assert.equal(JSON.stringify(raw).includes(gateInput.continuation.agentRunId), false)
  } finally {
    context.workspace.runLedger = null
    context.workspace.activeRuns.set(context.group.id, context.controller)
    await pending.settle()
  }
})

test('Manual V4 lease crash restart keeps its recovery Gate visible to the renderer', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const recoveryLedgerPath = path.join(directory, 'run-ledger-renderer-recovery.json')
  const recoveryStoragePath = path.join(directory, 'workspace-renderer-recovery.json')
  const ledger = new RunLedger({
    storagePath: ledgerPath,
    now: () => Date.now(),
  })
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 1, workspaceLimit: 1, globalLimit: 1 })
  options.runAgent = async agent => ({
    text: `${agent.kind} original leased proposal`,
    sessionRef: `${agent.kind}-original-session`,
    collaboration: proposalCollaboration(`${agent.kind} original leased summary`),
  })
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Manual V4 renderer recovery',
    agentKinds: ['codex', 'workbuddy', 'hermes'],
    workdir: directory,
    allowWrite: true,
  })
  let crashRecord = null
  let releaseCrash
  const crashCheckpoint = new Promise(resolve => { releaseCrash = resolve })
  const checkpointRun = workspace.checkpointRun.bind(workspace)
  workspace.checkpointRun = (groupId, controller, status = '') => {
    const persisted = checkpointRun(groupId, controller, status)
    const leasedWriter = controller.orchestration?.slots?.find(slot => (
      slot.permission === 'workspace-write' && slot.status === 'running' && slot.attempt === 1
    ))
    if (!crashRecord && leasedWriter) {
      crashRecord = structuredClone(ledger.get(controller.runId))
      fs.copyFileSync(options.storagePath, recoveryStoragePath)
      fs.copyFileSync(ledgerPath, recoveryLedgerPath)
      releaseCrash()
      throw new Error('TEST_CRASH:MANUAL_V4_WRITER_LEASED')
    }
    return persisted
  }
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Require a durable decision before replaying an uncertain writer.',
    mode: 'manual',
    targetKinds: ['codex', 'workbuddy', 'hermes'],
    protocol: 'v4',
  })
  await crashCheckpoint
  assert.ok(crashRecord)
  const writerSlot = crashRecord.orchestration.slots.find(slot => (
    slot.permission === 'workspace-write' && slot.status === 'running'
  ))
  const writerKind = writerSlot.agentKind
  assert.equal(writerSlot.status, 'running')
  assert.equal(writerSlot.permission, 'workspace-write')

  await workspace.stopAll()
  await send
  const recoveryLedger = new RunLedger({
    storagePath: recoveryLedgerPath,
    now: () => Date.now(),
  })
  const copiedRecord = recoveryLedger.get(crashRecord.runId)
  assert.ok(copiedRecord)
  assert.equal(copiedRecord.orchestration.slots.find(slot => (
    slot.agentKind === writerKind
  )).agentRunId, writerSlot.agentRunId)
  const recovered = new LocalWorkspace({
    ...options,
    storagePath: recoveryStoragePath,
    runLedger: recoveryLedger,
    runScheduler: new RunScheduler({ taskLimit: 1, workspaceLimit: 1, globalLimit: 1 }),
    runAgent: async agent => ({
      text: `${agent.kind} recovered proposal`,
      sessionRef: `${agent.kind}-recovered-session`,
      collaboration: proposalCollaboration(`${agent.kind} recovered summary`),
    }),
  })
  await recovered.refreshAgents()
  const gate = await waitFor(
    () => recovered.listHumanGates({ pendingOnly: true })[0],
    'Manual V4 renderer recovery Gate',
  )
  const durable = recoveryLedger.get(crashRecord.runId)
  assert.equal(recovered.canResumeHumanGateRecord(durable, gate), true)
  const missingBinding = structuredClone(durable)
  delete missingBinding.continuation.publicAgentRunId
  assert.equal(recovered.canResumeHumanGateRecord(missingBinding, gate), false)
  const mismatchedBinding = structuredClone(durable)
  mismatchedBinding.continuation.publicAgentRunId = 'agent-run-unbound-peer'
  assert.equal(recovered.canResumeHumanGateRecord(mismatchedBinding, gate), false)
  const duplicateBinding = structuredClone(durable)
  duplicateBinding.agentRuns.push(structuredClone(duplicateBinding.agentRuns.find(attempt => (
    attempt.agentRunId === duplicateBinding.continuation.publicAgentRunId
  ))))
  assert.equal(recovered.canResumeHumanGateRecord(duplicateBinding, gate), false)
  const collidingOperationBinding = structuredClone(durable)
  const collidingSlot = collidingOperationBinding.orchestration.slots.find(slot => (
    slot.slotId === collidingOperationBinding.continuation.slotId
  ))
  collidingSlot.agentRunId = gate.agentRunId
  collidingOperationBinding.agentRuns.push({
    ...structuredClone(collidingOperationBinding.agentRuns.find(attempt => (
      attempt.kind === writerKind
    ))),
    agentRunId: gate.agentRunId,
  })
  assert.equal(recovered.canResumeHumanGateRecord(collidingOperationBinding, gate), false)
  const raw = recovered.snapshot()
  const normalized = normalizeSnapshot(raw)
  const visibleAttempt = crashRecord.agentRuns
    .filter(agentRun => agentRun.kind === writerKind)
    .at(-1)

  assert.deepEqual(normalized.humanGates.map(item => ({
    gateId: item.gateId,
    agentRunId: item.agentRunId,
    agentKind: item.agentKind,
  })), [{
    gateId: gate.gateId,
    agentRunId: visibleAttempt?.agentRunId,
    agentKind: writerKind,
  }])
  assert.ok(visibleAttempt)
  assert.equal(raw.humanGates[0].agentRunId, visibleAttempt.agentRunId)
  assert.deepEqual(normalized.runs[0].waitingGateIds, [gate.gateId])
  assert.equal(recoveryLedger.get(crashRecord.runId).continuation.agentRunId, writerSlot.operationId)
  assert.notEqual(visibleAttempt.agentRunId, writerSlot.operationId)
  assert.equal(JSON.stringify(raw).includes(writerSlot.operationId), false)

  recovered.decideHumanGate(gate.gateId, {
    status: 'rejected', optionId: 'cancel-retry', actorId: 'local-user',
  })
  await waitFor(() => {
    const record = recoveryLedger.get(crashRecord.runId)
    return ['completed', 'partial', 'failed', 'stopped'].includes(record?.status)
  }, 'rejected Manual V4 renderer recovery')
})

test('V4 permission Gate keeps its exact visible Harness binding', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runScheduler = new RunScheduler({ taskLimit: 3, workspaceLimit: 3, globalLimit: 3 })
  options.runAgent = async (agent, _prompt, _workdir, runOptions) => {
    if (agent.kind === 'codex') {
      const decision = await runOptions.onPermissionRequest({
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
        ],
        operation: { kind: 'read', path: 'proposal-evidence.txt' },
      }, { signal: runOptions.signal })
      assert.equal(decision.optionId, 'allow-once')
    }
    return {
      text: `${agent.kind} permission proposal`,
      sessionRef: `${agent.kind}-permission-session`,
      collaboration: proposalCollaboration(`${agent.kind} permission summary`),
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'V4 permission renderer binding',
    agentKinds: ['codex', 'workbuddy', 'hermes'],
    workdir: directory,
    allowWrite: false,
  })
  const gatePromise = waitForPendingGate(workspace)
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Keep the real permission attempt bound in the renderer.',
    mode: 'manual',
    targetKinds: ['codex', 'workbuddy', 'hermes'],
    protocol: 'v4',
  })
  const gate = await gatePromise
  const controller = workspace.activeRuns.get(group.id)
  assert.ok(controller)
  const exactAttempt = controller.harness.snapshot().find(agentRun => (
    agentRun.agentRunId === gate.agentRunId && agentRun.kind === gate.agentKind
  ))
  assert.ok(exactAttempt)
  const laterAgentRunId = addAttempt(
    workspace, group, controller, gate.agentKind, controller.currentRound + 1,
  )
  const raw = workspace.snapshot()
  const normalized = normalizeSnapshot(raw)

  assert.notEqual(laterAgentRunId, exactAttempt.agentRunId)
  assert.equal(raw.humanGates[0].agentRunId, exactAttempt.agentRunId)
  assert.equal(normalized.humanGates[0].agentRunId, exactAttempt.agentRunId)
  assert.deepEqual(normalized.runs[0].waitingGateIds, [gate.gateId])

  workspace.decideHumanGate(gate.gateId, {
    status: 'approved', optionId: 'allow-once', actorId: 'local-user',
  })
  await send
})

test('initial Harness checkpoint failure prevents the V4 lease callback and Agent execution', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const scheduler = new RunScheduler({ taskLimit: 1, workspaceLimit: 1, globalLimit: 1 })
  options.runScheduler = scheduler
  const ledger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger-initial-checkpoint.json'),
    now: () => Date.now(),
  })
  options.runLedger = ledger
  let runAgentCalls = 0
  let leaseCalls = 0
  options.runAgent = async () => {
    runAgentCalls += 1
    return {
      text: 'The Agent must not start.',
      sessionRef: 'unexpected-session',
      collaboration: proposalCollaboration('The Agent must not start.'),
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'V4 lease hook cleanup',
    agentKinds: ['codex'],
    workdir: directory,
    allowWrite: true,
  })
  const task = workspace.addMessage(group.id, 'user', 'Start only after the lease checkpoint.')
  const contextPack = workspace.createContextPack({
    group,
    taskId: task.id,
    mode: 'manual',
    targetKinds: ['codex'],
    message: task,
  })
  const reservation = workspace.reserveRun(group.id, 'manual', ['codex'], task.id)
  workspace.bindRunTask(
    group.id, reservation, task.id, task.id, contextPack.contextPackId,
  )
  const controller = workspace.beginRun(
    group.id, 'manual', ['codex'], task.id, reservation,
  )
  controller.currentKind = 'codex'
  const checkpoint = ledger.checkpoint.bind(ledger)
  let rejectedInitialCheckpoint = false
  ledger.checkpoint = (record) => {
    if (!rejectedInitialCheckpoint && record.agentRuns?.some(attempt => (
      attempt.status === 'running'
    ))) {
      rejectedInitialCheckpoint = true
      throw new Error('TEST_INITIAL_CHECKPOINT_UNAVAILABLE')
    }
    return checkpoint(record)
  }

  await assert.rejects(
    workspace.invokeAgent(
      group,
      'codex',
      'manual',
      controller.signal,
      task.id,
      {
        v4: true,
        phase: 'proposal',
        taskId: task.id,
        sessionPolicy: 'frozen',
        promptOverride: 'Produce the bounded proposal.',
        contextPackId: contextPack.contextPackId,
        permissionMode: 'workspace-write',
        singleWriterKind: 'codex',
        operationId: 'operation-v4-lease-hook-cleanup',
        onLeaseAcquired: () => { leaseCalls += 1 },
      },
    ),
    (error) => {
      assert.equal(error.message, 'LOCAL_RUN_PERSIST_FAILED')
      assert.deepEqual(error.invocationFailure, {
        outcomeCertainty: 'not_started',
        sideEffectsPossible: false,
        operationId: 'operation-v4-lease-hook-cleanup',
        idempotencyMode: 'none',
      })
      return true
    },
  )
  const attempts = controller.harness?.snapshot() || []

  assert.equal(runAgentCalls, 0)
  assert.equal(leaseCalls, 0)
  assert.equal(rejectedInitialCheckpoint, true)
  assert.equal(attempts.length, 1)
  assert.equal(attempts[0].status, 'failed')
  assert.deepEqual(scheduler.snapshot().active, { global: 0, tasks: [], workspaces: [] })
  assert.deepEqual(scheduler.snapshot().queued, [])
  assert.equal(controller.agentControllers.size, 0)
  assert.equal(controller.silenceTimers.size, 0)
  await workspace.finishRun(group.id, controller, 'failed')
})

test('successful V4 lease callback receives the Harness attempt ID before Agent execution', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let leaseState = null
  let observedAttempt = null
  options.runAgent = async () => {
    observedAttempt = leaseState?.agentRunId || null
    return {
      text: 'Bound before execution.',
      sessionRef: 'lease-binding-session',
      collaboration: proposalCollaboration('Bound before execution.'),
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'V4 Harness lease binding', agentKinds: ['codex'], workdir: directory, allowWrite: false,
  })
  const task = workspace.addMessage(group.id, 'user', 'Bind the exact Harness attempt.')
  const contextPack = workspace.createContextPack({
    group, taskId: task.id, mode: 'manual', targetKinds: ['codex'], message: task,
  })
  const reservation = workspace.reserveRun(group.id, 'manual', ['codex'], task.id)
  workspace.bindRunTask(group.id, reservation, task.id, task.id, contextPack.contextPackId)
  const controller = workspace.beginRun(group.id, 'manual', ['codex'], task.id, reservation)

  await workspace.invokeAgent(group, 'codex', 'manual', controller.signal, task.id, {
    v4: true,
    phase: 'proposal',
    taskId: task.id,
    sessionPolicy: 'frozen',
    promptOverride: 'Produce a bounded proposal.',
    contextPackId: contextPack.contextPackId,
    permissionMode: 'read-only',
    operationId: 'operation-v4-harness-binding',
    onLeaseAcquired: value => { leaseState = value },
  })
  const attempts = controller.harness.snapshot()

  assert.equal(attempts.length, 1)
  assert.equal(leaseState.agentRunId, attempts[0].agentRunId)
  assert.equal(observedAttempt, attempts[0].agentRunId)
  await workspace.finishRun(group.id, controller, 'completed')
})

test('legacy Gate association remains exact instead of falling back by Agent kind', async (t) => {
  const context = await runningV4Workspace(t, { mode: 'manual', phase: 'proposal' })
  context.controller.orchestration = null
  addAttempt(context.workspace, context.group, context.controller, 'codex', 1)
  const pending = await pendingSnapshot(context.workspace, {
    type: 'retry',
    runId: context.controller.runId,
    agentRunId: 'agent-run-stale-legacy',
    agentKind: 'codex',
    summary: 'The previous Agent attempt failed.',
    options: [
      { optionId: 'retry-once', name: 'Retry once', kind: 'allow_once' },
      { optionId: 'cancel-retry', name: 'Do not retry', kind: 'reject_once' },
    ],
    request: { phase: 'legacy-retry' },
  }, {
    resumeKind: 'agent_slot',
    agentRunId: 'agent-run-stale-legacy',
    agentKind: 'codex',
    round: 1,
  })
  try {
    const normalized = normalizeSnapshot(pending.raw)
    assert.deepEqual(normalized.humanGates, [])
    assert.deepEqual(normalized.runs[0].waitingGateIds, [])
    assert.equal(pending.raw.humanGates[0].agentRunId, 'agent-run-stale-legacy')
  } finally {
    await pending.settle()
  }
})

for (const scenario of [
  { name: 'missing', binding: 'missing' },
  { name: 'mismatched', binding: 'mismatched' },
  { name: 'ambiguous duplicate', binding: 'duplicate' },
]) {
  test(`V4 operation Gate fails closed when its visible Agent attempt is ${scenario.name}`, async (t) => {
    const context = await runningV4Workspace(t, {
      mode: 'auto',
      phase: 'human-gate',
      targetKinds: ['codex', 'hermes'],
    })
    let publicAgentRunId
    if (scenario.binding === 'duplicate') {
      publicAgentRunId = addAttempt(context.workspace, context.group, context.controller, 'codex', 2)
      const harness = context.controller.harness
      harness.agentRuns.push({
        ...harness.agentRuns.at(-1),
        events: [],
        eventIndexes: new Map(),
        seenSeqs: [],
      })
      bindPrivateAttempt(context.controller, 'codex', publicAgentRunId)
    } else if (scenario.binding === 'mismatched') {
      const slotAgentRunId = addAttempt(
        context.workspace, context.group, context.controller, 'codex', 1,
      )
      publicAgentRunId = addAttempt(
        context.workspace, context.group, context.controller, 'codex', 2,
      )
      bindPrivateAttempt(context.controller, 'codex', slotAgentRunId)
    } else {
      const slotAgentRunId = addAttempt(
        context.workspace, context.group, context.controller, 'codex', 2,
      )
      bindPrivateAttempt(context.controller, 'codex', slotAgentRunId)
    }
    const operationId = context.workspace.autoRunner.v4OperationId(
      context.controller, 'codex', 'human-gate', 'slot-1-codex',
    )
    const pending = await pendingSnapshot(context.workspace, {
      type: 'decision',
      runId: context.controller.runId,
      agentRunId: operationId,
      agentKind: 'codex',
      summary: 'The candidate and unresolved issues have remained unchanged for two rounds.',
      options: [
        { optionId: 'continue-discussion', name: 'Continue', kind: 'accept' },
        { optionId: 'stop-discussion', name: 'Stop', kind: 'reject' },
      ],
      request: { phase: 'discussion', stateEpoch: 3 },
    }, {
      resumeKind: 'v4_human_gate',
      agentRunId: operationId,
      agentKind: 'codex',
      round: 2,
      stateEpoch: 3,
      ...(publicAgentRunId ? { publicAgentRunId } : {}),
    })
    try {
      assert.deepEqual(pending.raw.humanGates, [])
      assert.deepEqual(pending.raw.runs[0].waitingGateIds, [])
      assert.equal(JSON.stringify(pending.raw).includes(operationId), false)
    } finally {
      await pending.settle()
    }
  })
}

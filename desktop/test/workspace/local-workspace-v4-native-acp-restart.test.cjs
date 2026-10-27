const test = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const adapters = require('../../src/agents/cli/cli-adapters.cjs')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { RunLedger } = require('../../src/runs/run-ledger.cjs')
const { RunScheduler } = require('../../src/runs/run-scheduler.cjs')
const { executable } = require('../support/cli-adapters-test-helpers.cjs')
const { fixture } = require('../support/local-workspace-test-helpers.cjs')

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await delay(10)
  }
  throw new Error(`TEST_TIMEOUT:${label}`)
}

function pendingGate(workspace, predicate = () => true) {
  return waitFor(
    () => workspace.listHumanGates({ pendingOnly: true }).find(predicate),
    'pending Human Gate',
  )
}

function terminalRun(ledger, runId) {
  return waitFor(() => {
    const record = ledger.get(runId)
    return ['completed', 'partial', 'failed', 'stopped', 'round-limit'].includes(record?.status)
      ? record
      : null
  }, `terminal Run ${runId}`, 30000)
}

function proposalReceipt(agentKind) {
  return {
    version: 1,
    phase: 'proposal',
    summary: `${agentKind} proposal`,
    capabilities: [`${agentKind} capability`],
    intendedWork: [`${agentKind} work`],
    deliverables: [`${agentKind} Artifact`],
    dependencies: [],
  }
}

function challengeReceipt(agentKind) {
  return {
    version: 1,
    phase: 'challenge',
    verdict: 'support',
    summary: `${agentKind} supports Hermes as finalizer`,
    proposedAssignments: [
      {
        taskId: 'codex-work', ownerKind: 'codex', role: 'worker',
        objective: 'Complete the Codex work package.', expectedOutput: 'Codex Artifact.',
        inputRefs: [], artifactIds: [], dependsOn: [],
      },
      {
        taskId: 'workbuddy-work', ownerKind: 'workbuddy', role: 'worker',
        objective: 'Complete the WorkBuddy work package.', expectedOutput: 'WorkBuddy Artifact.',
        inputRefs: [], artifactIds: [], dependsOn: [],
      },
      {
        taskId: 'hermes-integration', ownerKind: 'hermes', role: 'integrator',
        objective: 'Integrate the completed work packages.', expectedOutput: 'Candidate Artifact.',
        inputRefs: [], artifactIds: [], dependsOn: ['codex-work', 'workbuddy-work'],
      },
    ],
    finalizerKind: 'hermes',
    verifierKinds: ['codex', 'workbuddy'],
    agreeToPlan: true,
  }
}

function autoReceipt(agentKind, phase, prompt = '') {
  if (phase === 'proposal') return proposalReceipt(agentKind)
  if (phase === 'challenge') return challengeReceipt(agentKind)
  if (phase === 'work') {
    const workItemId = prompt.match(/^Work item: ([A-Za-z0-9._:-]+)$/m)?.[1] || ''
    return {
      version: 1,
      phase,
      summary: `${agentKind} completed ${workItemId}`,
      workItemId,
      deliverables: [`${agentKind} Artifact`],
    }
  }
  if (phase === 'synthesis') {
    return { version: 1, phase, summary: 'Hermes integrated the candidate.', resolvedIssueIds: [] }
  }
  return {
    version: 1,
    phase: 'verification',
    verdict: 'support',
    summary: `${agentKind} accepts the candidate`,
  }
}

function hermesAcpExecutable(directory) {
  return executable(directory, 'hermes-v4-native-permission.cjs', `
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
const update = (sessionId, value) => send({
  jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value },
})
const assignments = [
  {
    taskId: 'codex-work', ownerKind: 'codex', role: 'worker',
    objective: 'Complete the Codex work package.', expectedOutput: 'Codex Artifact.',
    inputRefs: [], artifactIds: [], dependsOn: [],
  },
  {
    taskId: 'workbuddy-work', ownerKind: 'workbuddy', role: 'worker',
    objective: 'Complete the WorkBuddy work package.', expectedOutput: 'WorkBuddy Artifact.',
    inputRefs: [], artifactIds: [], dependsOn: [],
  },
  {
    taskId: 'hermes-integration', ownerKind: 'hermes', role: 'integrator',
    objective: 'Integrate the completed work packages.', expectedOutput: 'Candidate Artifact.',
    inputRefs: [], artifactIds: [], dependsOn: ['codex-work', 'workbuddy-work'],
  },
]
let pendingPrompt = null
let permissionId = 70
function receipt(phase, prompt) {
  if (phase === 'proposal') return {
    version: 1, phase, summary: 'hermes proposal', capabilities: ['hermes capability'],
    intendedWork: ['hermes work'], deliverables: ['hermes Artifact'], dependencies: [],
  }
  if (phase === 'challenge') return {
    version: 1, phase, verdict: 'support', summary: 'hermes supports Hermes as finalizer',
    proposedAssignments: assignments, finalizerKind: 'hermes',
    verifierKinds: ['codex', 'workbuddy'], agreeToPlan: true,
  }
  if (phase === 'work') {
    const workItemId = prompt.match(/Work item: ([A-Za-z0-9._:-]+)/)?.[1] || ''
    return {
      version: 1, phase, summary: 'hermes completed ' + workItemId,
      workItemId, deliverables: ['hermes Artifact'],
    }
  }
  if (phase === 'synthesis') return {
    version: 1, phase, summary: 'Hermes integrated the candidate.', resolvedIssueIds: [],
  }
  return {
    version: 1, phase: 'verification', verdict: 'support', summary: 'hermes accepts the candidate',
  }
}
function finish(message, sessionId, phase, prompt) {
  const body = 'hermes ' + phase + '\\n[[MELDWORK_COLLABORATION:'
    + JSON.stringify(receipt(phase, prompt)) + ']]'
  update(sessionId, {
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: body },
  })
  send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
}
input.on('line', line => {
  const message = JSON.parse(line)
  const sessionId = message.params?.sessionId || 'hermes-v4-native-session'
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId } })
  } else if (message.method === 'session/resume' || message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    const prompt = JSON.stringify(message.params || {})
    const phase = prompt.match(/Phase: ([a-z-]+)/)?.[1] || 'proposal'
    if (phase === process.env.MELDWORK_TEST_PERMISSION_PHASE) {
      pendingPrompt = { message, sessionId, phase, prompt }
      permissionId += 1
      send({
        jsonrpc: '2.0', id: permissionId, method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: {
            toolCallId: 'tool-' + phase, title: 'write workspace candidate',
            kind: 'edit', status: 'pending',
          },
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
          ],
        },
      })
    } else {
      finish(message, sessionId, phase, prompt)
    }
  } else if (pendingPrompt && message.id === permissionId) {
    finish(
      pendingPrompt.message, pendingPrompt.sessionId, pendingPrompt.phase, pendingPrompt.prompt,
    )
    pendingPrompt = null
  } else if (message.method === 'session/cancel') {
    process.exit(0)
  }
})
`)
}

function nativeWorkspaceOptions(options, cli, permissionPhase, calls) {
  options.detectAgents = async () => [
    { kind: 'codex', name: 'Codex CLI', executable: '/tmp/codex', version: '1' },
    { kind: 'hermes', name: 'Hermes CLI', executable: cli, version: '2', acpAvailable: true },
    { kind: 'workbuddy', name: 'WorkBuddy CLI', executable: '/tmp/workbuddy', version: '3' },
  ]
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || 'proposal'
    calls.push({
      kind: agent.kind,
      phase,
      operationId: runOptions.operationId,
      sessionRef: runOptions.sessionRef || '',
      sandbox: runOptions.sandbox,
    })
    if (agent.kind === 'hermes') {
      return adapters.runAgent(agent, prompt, workdir, {
        ...runOptions,
        env: { MELDWORK_TEST_PERMISSION_PHASE: permissionPhase },
      })
    }
    return {
      text: `${agent.kind} ${phase}`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-${phase}-session`,
      collaboration: autoReceipt(agent.kind, phase, prompt),
    }
  }
}

async function createManualPermissionRestart(t, restartOptions = {}) {
  const { directory, options } = fixture()
  const cli = hermesAcpExecutable(directory)
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath, now: () => Date.now() })
  const calls = []
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 3, workspaceLimit: 3, globalLimit: 3 })
  nativeWorkspaceOptions(options, cli, 'proposal', calls)
  t.after(async () => {
    await adapters.shutdownAcpSessionRuntime()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  let workspace = new LocalWorkspace(options)
  let send
  await workspace.refreshAgents()
  workspace.messageSubmission.v4WriterKind = () => 'hermes'
  const group = workspace.createGroup({
    name: 'Manual V4 native ACP restart',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: true,
  })
  const originalGatePromise = pendingGate(workspace, gate => gate.type === 'permission')
  send = workspace.sendMessage({
    groupId: group.id,
    text: 'Recover the exact Manual writer after native ACP runtime loss.',
    mode: 'manual',
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    protocol: 'v4',
  })
  const originalGate = await originalGatePromise
  const waiting = await waitFor(() => {
    const record = ledger.get(originalGate.runId)
    const peers = record?.orchestration?.slots.filter(slot => (
      slot.agentKind !== 'hermes' && slot.status === 'completed'
    ))
    return peers?.length === 2 ? record : null
  }, 'Manual V4 settled peers')
  const writerSlot = waiting.orchestration.slots.find(slot => slot.agentKind === 'hermes')
  assert.equal(writerSlot.permission, 'workspace-write')
  assert.equal(writerSlot.status, 'running')
  assert.equal(writerSlot.attempt, 1)
  assert.equal(
    workspace.canResumeHumanGateRecord(
      waiting, workspace.humanGateStore.get(originalGate.gateId),
    ),
    true,
    JSON.stringify({ continuation: waiting.continuation, orchestration: waiting.orchestration }),
  )

  const workspaceBytes = fs.readFileSync(options.storagePath)
  const gateStorePath = path.join(directory, 'meldwork-private', 'human-gates.json')
  const gateBytes = fs.readFileSync(gateStorePath)
  assert.equal(JSON.parse(gateBytes).gates.find(gate => (
    gate.gateId === originalGate.gateId
  ))?.status, 'pending')
  await adapters.shutdownAcpSessionRuntime()
  await send.catch(() => {})
  fs.writeFileSync(options.storagePath, workspaceBytes)
  fs.writeFileSync(gateStorePath, gateBytes)
  assert.match(waiting.continuation.requestId, /^[a-f0-9]{64}$/)
  assert.match(waiting.continuation.requestHash, /^[a-f0-9]{64}$/)
  assert.match(waiting.continuation.sessionRefHash, /^[a-f0-9]{64}$/)
  assert.match(waiting.continuation.sessionProvenanceHash, /^[a-f0-9]{64}$/)
  const restartedLedger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger-restarted.json'),
    now: () => Date.now(),
  })
  restartedLedger.checkpoint(waiting)
  if (restartOptions.coherentCursorRewrite) {
    const durable = restartedLedger.runs.find(record => record.runId === originalGate.runId)
    const batchId = `batch-${'a'.repeat(32)}`
    const operationId = `agent-operation-${createHash('sha256').update(
      `${durable.runId}:${batchId}:hermes`,
    ).digest('hex')}`
    const slot = durable.orchestration.slots.find(item => item.agentKind === 'hermes')
    durable.orchestration.batchId = batchId
    slot.operationId = operationId
    durable.orchestration.plan.assignments.find(item => item.agentKind === 'hermes')
      .operationId = operationId
    durable.orchestration.deliveryWatermarks.find(item => item.agentKind === 'hermes')
      .operationId = operationId
    durable.continuation.operationId = operationId
  }
  if (restartOptions.acceptedReceipt) {
    const durable = restartedLedger.runs.find(record => record.runId === originalGate.runId)
    const slot = durable.orchestration.slots.find(item => item.agentKind === 'hermes')
    slot.resultRefs.workflowOutcomeRefs = [{
      receipt: { phase: 'proposal', operationId: slot.operationId, status: 'completed' },
    }]
  }
  if (restartOptions.sessionState === 'missing' || restartOptions.sessionState === 'rotated') {
    const persisted = JSON.parse(fs.readFileSync(options.storagePath, 'utf8'))
    for (const key of Object.keys(persisted.sessions || {})) {
      if (persisted.sessions[key] !== 'hermes-v4-native-session') continue
      if (restartOptions.sessionState === 'missing') {
        delete persisted.sessions[key]
        delete persisted.sessionMeta[key]
      } else {
        persisted.sessionMeta[key] = {
          ...(persisted.sessionMeta[key] || {}),
          turns: 18,
        }
      }
    }
    fs.writeFileSync(options.storagePath, JSON.stringify(persisted, null, 2))
  }
  if (restartOptions.tamperSessionHash) {
    restartedLedger.runs.find(record => record.runId === originalGate.runId)
      .continuation.sessionRefHash = 'f'.repeat(64)
  }
  const restarted = new LocalWorkspace({
    ...options,
    runLedger: restartedLedger,
    runScheduler: new RunScheduler({ taskLimit: 3, workspaceLimit: 3, globalLimit: 3 }),
  })
  await restarted.refreshAgents()
  const beforeApprovalCalls = calls.length
  if (!restartOptions.tamperSessionHash) {
    assert.equal(restarted.humanGateStore.get(originalGate.gateId).status, 'pending')
    restarted.decideHumanGate(originalGate.gateId, {
      status: 'approved', optionId: 'allow-once', actorId: 'local-user',
    })
  }
  return {
    calls,
    group,
    originalGate,
    restarted,
    restartedLedger,
    beforeApprovalCalls,
    waiting,
    writerSlot,
  }
}

test('Manual V4 native ACP permission restart resumes the persisted Session without a fresh Gate',
  async (t) => {
  const recovery = await createManualPermissionRestart(t)
  const {
    calls, originalGate, restarted, restartedLedger, beforeApprovalCalls, writerSlot,
  } = recovery
  const terminal = await terminalRun(restartedLedger, originalGate.runId)
  const recoveredWriter = terminal.orchestration.slots.find(slot => slot.agentKind === 'hermes')
  const hermesCalls = calls.filter(call => call.kind === 'hermes')

  assert.equal(calls.length, beforeApprovalCalls + 1)
  assert.equal(calls.at(-1).sessionRef, 'hermes-v4-native-session')
  assert.equal(terminal.status, 'completed', terminal.reason)
  assert.equal(recoveredWriter.status, 'completed')
  assert.equal(recoveredWriter.attempt, writerSlot.attempt)
  assert.equal(recoveredWriter.operationId, writerSlot.operationId)
  assert.equal(hermesCalls.length, 2)
  assert.deepEqual(hermesCalls.map(call => call.operationId), [
    writerSlot.operationId, writerSlot.operationId,
  ])
  assert.equal(restarted.listHumanGates({ pendingOnly: true }).length, 0)
  for (const kind of ['codex', 'workbuddy']) {
    assert.equal(calls.filter(call => call.kind === kind).length, 1)
  }
})

test('Manual V4 native permission Session binding tamper fails before invocation', async (t) => {
  const recovery = await createManualPermissionRestart(t, { tamperSessionHash: true })
  const { calls, originalGate, restarted, restartedLedger, beforeApprovalCalls } = recovery
  const terminal = await terminalRun(restartedLedger, originalGate.runId)

  assert.equal(terminal.status, 'failed')
  assert.equal(terminal.reason, 'human_gate_continuation_invalid')
  assert.equal(calls.length, beforeApprovalCalls)
  assert.equal(restarted.listHumanGates({ pendingOnly: true }).length, 0)
})

test('Manual V4 native permission continuation persists the exact V4 slot binding', async (t) => {
  const recovery = await createManualPermissionRestart(t, { tamperSessionHash: true })
  const { waiting, writerSlot } = recovery

  assert.deepEqual({
    phase: waiting.continuation.phase,
    slotId: waiting.continuation.slotId,
    operationId: waiting.continuation.operationId,
    snapshotHash: waiting.continuation.snapshotHash,
  }, {
    phase: 'proposal',
    slotId: writerSlot.slotId,
    operationId: writerSlot.operationId,
    snapshotHash: waiting.orchestration.snapshotHash,
  })
})

test('Manual V4 native permission rejects a coherent batch and operation rewrite before invocation',
  async (t) => {
    const recovery = await createManualPermissionRestart(t, { coherentCursorRewrite: true })
    const { calls, originalGate, restarted, restartedLedger, beforeApprovalCalls } = recovery
    const outcome = await waitFor(() => {
      const record = restartedLedger.get(originalGate.runId)
      const replacementGate = restarted.listHumanGates({ pendingOnly: true }).find(gate => (
        gate.gateId !== originalGate.gateId
      ))
      return record?.status === 'failed' || replacementGate ? { record, replacementGate } : null
    }, 'coherent Manual binding rewrite rejection')

    assert.equal(outcome.record.status, 'failed')
    assert.equal(outcome.record.reason, 'LOCAL_RUN_ORCHESTRATION_RESUME_UNAVAILABLE')
    assert.equal(outcome.replacementGate, undefined)
    assert.equal(calls.length, beforeApprovalCalls)
  })

test('Manual V4 native permission rejects an already accepted bound operation before invocation',
  async (t) => {
    const recovery = await createManualPermissionRestart(t, { acceptedReceipt: true })
    const { calls, originalGate, restarted, restartedLedger, beforeApprovalCalls } = recovery
    const outcome = await waitFor(() => {
      const record = restartedLedger.get(originalGate.runId)
      const replacementGate = restarted.listHumanGates({ pendingOnly: true }).find(gate => (
        gate.gateId !== originalGate.gateId
      ))
      return record?.status === 'failed' || replacementGate ? { record, replacementGate } : null
    }, 'accepted Manual operation rejection')

    assert.equal(outcome.record.status, 'failed')
    assert.equal(outcome.record.reason, 'LOCAL_RUN_ORCHESTRATION_RESUME_UNAVAILABLE')
    assert.equal(outcome.replacementGate, undefined)
    assert.equal(calls.length, beforeApprovalCalls)
  })

test('Manual V4 native permission restart recovers a missing Session and preserves a V4 Session',
  async (t) => {
  for (const sessionState of ['missing', 'rotated']) {
    await t.test(sessionState, async (subtest) => {
      const recovery = await createManualPermissionRestart(subtest, { sessionState })
      const {
        calls, originalGate, restarted, restartedLedger, beforeApprovalCalls, writerSlot,
      } = recovery
      if (sessionState === 'rotated') {
        const terminal = await terminalRun(restartedLedger, originalGate.runId)
        const recoveredWriter = terminal.orchestration.slots.find(slot => (
          slot.agentKind === writerSlot.agentKind
        ))
        assert.equal(calls.length, beforeApprovalCalls + 1)
        assert.equal(calls.at(-1).sessionRef, 'hermes-v4-native-session')
        assert.equal(terminal.status, 'completed', terminal.reason)
        assert.equal(recoveredWriter.status, 'completed')
        assert.equal(recoveredWriter.operationId, writerSlot.operationId)
        assert.equal(recoveredWriter.attempt, writerSlot.attempt)
        assert.equal(restarted.listHumanGates({ pendingOnly: true }).length, 0)
        return
      }
      const recoveryGate = await pendingGate(restarted, gate => (
        gate.type === 'retry' && gate.gateId !== originalGate.gateId
      ))
      const recovered = restartedLedger.get(originalGate.runId)
      const recoveredWriter = recovered.orchestration.slots.find(slot => (
        slot.agentKind === writerSlot.agentKind
      ))

      assert.equal(calls.length, beforeApprovalCalls)
      assert.equal(recovered.status, 'waiting')
      assert.equal(recoveredWriter.status, 'running')
      assert.equal(recoveredWriter.operationId, writerSlot.operationId)
      assert.equal(recoveredWriter.attempt, writerSlot.attempt)
      assert.equal(restarted.humanGateStore.request(recoveryGate.gateId).outcomeCertainty,
        'unknown_outcome')

      restarted.decideHumanGate(recoveryGate.gateId, {
        status: 'rejected', optionId: 'cancel-retry', actorId: 'local-user',
      })
      const terminal = await terminalRun(restartedLedger, originalGate.runId)
      assert.equal(terminal.status, 'stopped')
    })
  }
})

test('Auto V4 read-only native ACP permission restart resumes the persisted Session', async (t) => {
  const { directory, options } = fixture()
  const cli = hermesAcpExecutable(directory)
  const ledger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger.json'), now: () => Date.now(),
  })
  const calls = []
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 3, workspaceLimit: 3, globalLimit: 3 })
  nativeWorkspaceOptions(options, cli, 'proposal', calls)
  t.after(async () => {
    await adapters.shutdownAcpSessionRuntime()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Auto V4 native read-only restart',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: false,
  })
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Resume one native read-only proposal through its persisted Session.',
    mode: 'auto',
    maxRounds: 3,
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    protocol: 'v4',
  })
  const originalGate = await pendingGate(workspace, gate => (
    gate.type === 'permission' && gate.agentKind === 'hermes'
  ))
  const waiting = await waitFor(() => {
    const record = ledger.get(originalGate.runId)
    return record?.orchestration?.slots.filter(slot => (
      slot.agentKind !== 'hermes' && slot.status === 'completed'
    )).length === 2 ? record : null
  }, 'Auto native read-only settled peers')
  const gatedSlot = waiting.orchestration.slots.find(slot => slot.agentKind === 'hermes')
  const workspaceBytes = fs.readFileSync(options.storagePath)
  const gateStorePath = path.join(directory, 'meldwork-private', 'human-gates.json')
  const gateBytes = fs.readFileSync(gateStorePath)

  await adapters.shutdownAcpSessionRuntime()
  await send.catch(() => {})
  fs.writeFileSync(options.storagePath, workspaceBytes)
  fs.writeFileSync(gateStorePath, gateBytes)
  const restartedLedger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger-read-only-restarted.json'),
    now: () => Date.now(),
  })
  restartedLedger.checkpoint(waiting)
  const restarted = new LocalWorkspace({
    ...options,
    runLedger: restartedLedger,
    runScheduler: new RunScheduler({ taskLimit: 3, workspaceLimit: 3, globalLimit: 3 }),
  })
  await restarted.refreshAgents()
  const beforeApprovalCalls = calls.length
  restarted.decideHumanGate(originalGate.gateId, {
    status: 'approved', optionId: 'allow-once', actorId: 'local-user',
  })

  const terminal = await terminalRun(restartedLedger, originalGate.runId)
  const resumedCalls = calls.filter(call => (
    call.kind === 'hermes' && call.phase === 'proposal'
  ))
  assert.equal(calls[beforeApprovalCalls].kind, 'hermes')
  assert.equal(calls[beforeApprovalCalls].phase, 'proposal')
  assert.equal(calls[beforeApprovalCalls].sessionRef, 'hermes-v4-native-session')
  assert.deepEqual(resumedCalls.map(call => call.operationId), [
    gatedSlot.operationId, gatedSlot.operationId,
  ])
  assert.equal(resumedCalls.at(-1).sessionRef, 'hermes-v4-native-session')
  assert.equal(terminal.status, 'completed', terminal.reason)
  assert.equal(restarted.listHumanGates({ pendingOnly: true }).length, 0)
  for (const kind of ['codex', 'workbuddy']) {
    assert.equal(calls.filter(call => call.kind === kind && call.phase === 'proposal').length, 1)
  }
})

test('Auto V4 synthesis native ACP permission restart enters existing recovery Gate', async (t) => {
  const { directory, options } = fixture()
  const cli = hermesAcpExecutable(directory)
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath, now: () => Date.now() })
  const calls = []
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 3, workspaceLimit: 3, globalLimit: 3 })
  nativeWorkspaceOptions(options, cli, 'synthesis', calls)
  let workspace
  let send
  t.after(async () => {
    await adapters.shutdownAcpSessionRuntime()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Auto V4 native synthesis restart',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: true,
  })
  send = workspace.sendMessage({
    groupId: group.id,
    text: 'Negotiate Hermes as finalizer and recover a lost native synthesis Session.',
    mode: 'auto',
    maxRounds: 3,
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    protocol: 'v4',
  })
  const originalOutcome = await waitFor(() => {
    const gate = workspace.listHumanGates({ pendingOnly: true }).find(candidate => (
      candidate.type === 'permission' && candidate.agentKind === 'hermes'
    ))
    const record = ledger.list().at(-1)
    return gate || ['completed', 'partial', 'failed', 'stopped', 'round-limit'].includes(record?.status)
      ? { gate, record }
      : null
  }, 'initial Auto synthesis permission outcome', 10000)
  assert.ok(originalOutcome.gate, JSON.stringify({
    status: originalOutcome.record?.status,
    reason: originalOutcome.record?.reason,
    phase: originalOutcome.record?.orchestration?.phase,
    calls,
  }))
  const originalGate = originalOutcome.gate
  const waiting = ledger.get(originalGate.runId)
  const originalAttempt = waiting.orchestration.synthesisRecovery.attempts.at(-1)
  assert.equal(waiting.orchestration.phase, 'synthesis')
  assert.equal(originalAttempt.status, 'leased')
  assert.equal(originalAttempt.permission, 'workspace-write')
  assert.equal(originalAttempt.leaseAcquired, true)

  const workspaceBytes = fs.readFileSync(options.storagePath)
  const gateStorePath = path.join(directory, 'meldwork-private', 'human-gates.json')
  const gateBytes = fs.readFileSync(gateStorePath)
  await adapters.shutdownAcpSessionRuntime()
  await send.catch(() => {})
  fs.writeFileSync(options.storagePath, workspaceBytes)
  fs.writeFileSync(gateStorePath, gateBytes)
  assert.match(waiting.continuation.sessionRefHash, /^[a-f0-9]{64}$/)
  const restartedLedger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger-restarted.json'),
    now: () => Date.now(),
  })
  restartedLedger.checkpoint(waiting)
  const restarted = new LocalWorkspace({
    ...options,
    runLedger: restartedLedger,
    runScheduler: new RunScheduler({ taskLimit: 3, workspaceLimit: 3, globalLimit: 3 }),
  })
  await restarted.refreshAgents()
  const beforeApprovalCalls = calls.length
  restarted.decideHumanGate(originalGate.gateId, {
    status: 'approved', optionId: 'allow-once', actorId: 'local-user',
  })

  const recoveryOutcome = await waitFor(() => {
    const gate = restarted.listHumanGates({ pendingOnly: true }).find(candidate => (
      candidate.type === 'decision' && candidate.gateId !== originalGate.gateId
    ))
    const record = restartedLedger.get(originalGate.runId)
    return gate || ['completed', 'partial', 'failed', 'stopped'].includes(record?.status)
      ? { gate, record }
      : null
  }, 'Auto synthesis recovery outcome')
  assert.ok(recoveryOutcome.gate, JSON.stringify({
    status: recoveryOutcome.record?.status,
    reason: recoveryOutcome.record?.reason,
    phase: recoveryOutcome.record?.orchestration?.phase,
    attempt: recoveryOutcome.record?.orchestration?.synthesisRecovery?.attempts?.at(-1),
    calls,
  }))
  const recoveryGate = recoveryOutcome.gate
  const recovered = restartedLedger.get(originalGate.runId)
  const recoveredAttempt = recovered.orchestration.synthesisRecovery.attempts.find(attempt => (
    attempt.operationId === originalAttempt.operationId
  ))
  const binding = recovered.orchestration.synthesisRecovery.pendingGate
  const request = restarted.humanGateStore.request(recoveryGate.gateId)

  assert.equal(calls.length, beforeApprovalCalls)
  assert.equal(calls.filter(call => call.phase === 'verification').length, 0)
  assert.equal(recovered.orchestration.candidateCommit || null, null)
  assert.equal(recoveredAttempt.status, 'unknown_outcome')
  assert.equal(recoveredAttempt.outcomeCertainty, 'unknown_outcome')
  assert.equal(recoveredAttempt.operationId, originalAttempt.operationId)
  assert.equal(recoveredAttempt.attempt, originalAttempt.attempt)
  assert.equal(binding.writerKind, originalAttempt.writerKind)
  assert.equal(binding.slotId, originalAttempt.slotId)
  assert.equal(binding.operationId, originalAttempt.operationId)
  assert.equal(binding.attempt, originalAttempt.attempt)
  assert.equal(binding.round, waiting.orchestration.round)
  assert.equal(request.stateEpoch, binding.stateEpoch)
  assert.equal(request.bindingHash, binding.bindingHash)
  assert.equal(calls.filter(call => call.phase === 'synthesis').length, 2)

  restarted.decideHumanGate(recoveryGate.gateId, {
    status: 'rejected', optionId: 'stop-discussion', actorId: 'local-user',
  })
  const terminal = await terminalRun(restartedLedger, originalGate.runId)
  assert.equal(terminal.status, 'stopped')
  assert.equal(terminal.continuation.state, 'cancelled')
  assert.equal(calls.filter(call => call.phase === 'synthesis').length, 2)
  assert.equal(calls.filter(call => call.phase === 'verification').length, 0)
})

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { RunLedger } = require('../../src/runs/run-ledger.cjs')
const { RunScheduler } = require('../../src/runs/run-scheduler.cjs')
const { deferred, fixture } = require('../support/local-workspace-test-helpers.cjs')

function pendingGate(workspace, timeoutMs = 3000) {
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

async function waitFor(predicate, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`TEST_TIMEOUT:${label}`)
}

function proposalReceipt(agentKind, summary) {
  return {
    version: 1,
    phase: 'proposal',
    summary,
    capabilities: [`${agentKind} capability`],
    intendedWork: [`${agentKind} intended work`],
    deliverables: [`${agentKind} proposal Artifact`],
    dependencies: [],
  }
}

function autoV4Receipt(agentKind, phase, workItemId = '') {
  const assignments = [
    {
      taskId: 'codex-work', ownerKind: 'codex', role: 'worker',
      objective: 'Complete the Codex work package.', expectedOutput: 'Codex Artifact.',
      inputRefs: [], artifactIds: [], dependsOn: [],
    },
    {
      taskId: 'hermes-work', ownerKind: 'hermes', role: 'worker',
      objective: 'Complete the Hermes work package.', expectedOutput: 'Hermes Artifact.',
      inputRefs: [], artifactIds: [], dependsOn: [],
    },
    {
      taskId: 'workbuddy-integration', ownerKind: 'workbuddy', role: 'integrator',
      objective: 'Integrate the work packages.', expectedOutput: 'Integrated Artifact.',
      inputRefs: [], artifactIds: [], dependsOn: ['codex-work', 'hermes-work'],
    },
  ]
  if (phase === 'proposal') return proposalReceipt(agentKind, `${agentKind} proposal`)
  if (phase === 'challenge') {
    return {
      version: 1, phase, verdict: 'support', summary: `${agentKind} supports the plan`,
      proposedAssignments: assignments,
      finalizerKind: 'workbuddy', verifierKinds: ['codex', 'hermes'], agreeToPlan: true,
    }
  }
  if (phase === 'work') {
    return {
      version: 1, phase, summary: `${agentKind} completed ${workItemId}`,
      workItemId, deliverables: [`${agentKind} Artifact`],
    }
  }
  if (phase === 'synthesis') {
    return { version: 1, phase, summary: 'Integrated candidate.', resolvedIssueIds: [] }
  }
  return { version: 1, phase, verdict: 'support', summary: `${agentKind} accepts` }
}

function sequentialAutoV4Receipt(agentKind, phase, workItemId = '') {
  const assignments = [
    {
      taskId: 'codex-work-1', ownerKind: 'codex', role: 'worker',
      objective: 'Complete the first Codex work package.', expectedOutput: 'Codex Artifact 1.',
      inputRefs: [], artifactIds: [], dependsOn: [],
    },
    {
      taskId: 'codex-work-2', ownerKind: 'codex', role: 'worker',
      objective: 'Continue from the first Codex work package.', expectedOutput: 'Codex Artifact 2.',
      inputRefs: [], artifactIds: [], dependsOn: ['codex-work-1'],
    },
    {
      taskId: 'hermes-work', ownerKind: 'hermes', role: 'worker',
      objective: 'Complete the Hermes work package.', expectedOutput: 'Hermes Artifact.',
      inputRefs: [], artifactIds: [], dependsOn: [],
    },
    {
      taskId: 'workbuddy-integration', ownerKind: 'workbuddy', role: 'integrator',
      objective: 'Integrate the completed work packages.', expectedOutput: 'Integrated Artifact.',
      inputRefs: [], artifactIds: [], dependsOn: ['codex-work-2', 'hermes-work'],
    },
  ]
  if (phase === 'proposal') return proposalReceipt(agentKind, `${agentKind} proposal`)
  if (phase === 'challenge') {
    return {
      version: 1, phase, verdict: 'support', summary: `${agentKind} supports the plan`,
      proposedAssignments: assignments,
      finalizerKind: 'workbuddy', verifierKinds: ['codex', 'hermes'], agreeToPlan: true,
    }
  }
  if (phase === 'work') {
    return {
      version: 1, phase, summary: `${agentKind} completed ${workItemId}`,
      workItemId, deliverables: [`${workItemId} Artifact`],
    }
  }
  if (phase === 'synthesis') {
    return { version: 1, phase, summary: 'Integrated candidate.', resolvedIssueIds: [] }
  }
  return { version: 1, phase, verdict: 'support', summary: `${agentKind} accepts` }
}

async function restartAutoV4ProposalGate(t, tamper = '') {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath, now: () => Date.now() })
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 3, workspaceLimit: 3, globalLimit: 3 })
  const invocations = []
  const permissionRequest = {
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
    ],
    operation: { kind: 'read', path: 'proposal-evidence.txt' },
  }
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    const workItemId = prompt.match(/^Work item: ([A-Za-z0-9._:-]+)$/m)?.[1] || ''
    invocations.push({ kind: agent.kind, phase, operationId: runOptions.operationId })
    if (agent.kind === 'codex' && phase === 'proposal') {
      await runOptions.onSessionRef('codex-auto-v4-gate-session', { transport: 'acp' })
      const decision = await runOptions.onPermissionRequest(permissionRequest, {
        signal: runOptions.signal,
      })
      assert.equal(decision.optionId, 'allow-once')
    }
    return {
      text: `${agent.kind} ${phase}`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-${phase}-session`,
      collaboration: autoV4Receipt(agent.kind, phase, workItemId),
    }
  }

  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Auto V4 proposal Gate restart',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: false,
  })
  const gatePromise = pendingGate(workspace)
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Resume only the exact gated Auto proposal slot.',
    mode: 'auto',
    maxRounds: 3,
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    protocol: 'v4',
  })
  const gate = await gatePromise
  const waiting = await waitFor(() => {
    const record = ledger.get(gate.runId)
    const peers = record?.orchestration?.slots.filter(slot => (
      slot.agentKind !== gate.agentKind && slot.status === 'completed'
    ))
    return peers?.length === 2 ? record : null
  }, 'completed Auto V4 proposal peers')
  const gatedSlot = waiting.orchestration.slots.find(slot => slot.agentKind === gate.agentKind)
  assert.equal(waiting.orchestration.phase, 'proposal')
  assert.equal(gatedSlot.phase, 'proposal')
  assert.equal(gatedSlot.snapshotHash, waiting.orchestration.snapshotHash)
  assert.equal(gate.agentKind, gatedSlot.agentKind)
  assert.equal(waiting.continuation.agentRunId, gate.agentRunId)
  assert.equal(invocations.find(call => (
    call.kind === gate.agentKind && call.phase === 'proposal'
  )).operationId, gatedSlot.operationId)
  assert.equal(waiting.continuation.round, waiting.orchestration.round)
  const controller = workspace.activeRuns.get(group.id)
  assert.equal(workspace.canResumeV4AutoAgentSlot(waiting, gate, controller), true)
  for (const tamperBinding of [
    durable => {
      durable.orchestration.slots.find(slot => slot.agentKind === gate.agentKind).operationId =
        `operation-${'a'.repeat(64)}`
    },
    durable => { durable.orchestration.phase = 'challenge' },
    durable => {
      durable.orchestration.slots.find(slot => slot.agentKind === gate.agentKind).slotId =
        `slot-tampered-${gate.agentKind}`
    },
    durable => {
      durable.orchestration.slots.find(slot => slot.agentKind === gate.agentKind).snapshotHash =
        'tampered-snapshot'
    },
    durable => { durable.continuation.agentKind = 'hermes' },
    durable => {
      durable.orchestration.plan.assignments.find(item => item.agentKind === gate.agentKind)
        .operationId = `operation-${'b'.repeat(64)}`
    },
    durable => {
      const slot = durable.orchestration.slots.find(item => item.agentKind === gate.agentKind)
      slot.resultRefs.workflowOutcomeRefs.push({
        receipt: { phase: 'proposal', operationId: slot.operationId },
      })
    },
  ]) {
    const tampered = structuredClone(waiting)
    tamperBinding(tampered)
    assert.equal(workspace.canResumeV4AutoAgentSlot(tampered, gate, controller), false)
  }

  await workspace.stopAll()
  await send
  assert.equal(ledger.get(gate.runId).status, 'waiting')
  const restartedLedger = new RunLedger({ storagePath: ledgerPath, now: () => Date.now() })
  const beforeApprovalCalls = invocations.length
  const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
  let resumedProposalRecord = null
  if (!tamper) {
    const checkpointRun = restarted.checkpointRun.bind(restarted)
    restarted.checkpointRun = (groupId, activeController, status = '') => {
      const persisted = checkpointRun(groupId, activeController, status)
      const record = restartedLedger.get(activeController.runId)
      if (!resumedProposalRecord && record?.continuation?.state === 'completed'
          && record.orchestration?.phase === 'proposal'
          && record.orchestration.slots.every(slot => slot.status === 'completed')) {
        resumedProposalRecord = structuredClone(record)
      }
      return persisted
    }
  }
  if (tamper === 'round') {
    const markResumed = restarted.markHumanGateResumed.bind(restarted)
    restarted.humanGateCoordinator.onResumed = record => {
      markResumed(record)
      restartedLedger.runs.find(item => item.runId === record.runId).continuation.round += 1
    }
  }
  await restarted.refreshAgents()
  restarted.decideHumanGate(gate.gateId, {
    status: tamper === 'rejected' ? 'rejected' : 'approved',
    optionId: tamper === 'rejected' ? 'reject-once' : 'allow-once',
    actorId: 'local-user',
  })

  if (tamper === 'rejected') {
    const stopped = await waitFor(() => {
      const record = restartedLedger.get(gate.runId)
      return record?.status === 'stopped' ? record : null
    }, 'rejected Auto V4 Gate')
    assert.equal(invocations.length, beforeApprovalCalls)
    assert.equal(stopped.continuation.state, 'cancelled')
    return
  }
  if (tamper) {
    const failed = await waitFor(() => {
      const record = restartedLedger.get(gate.runId)
      return record?.status === 'failed' ? record : null
    }, `rejected Auto V4 ${tamper} binding`)
    assert.equal(invocations.length, beforeApprovalCalls)
    assert.equal(failed.reason, 'human_gate_continuation_invalid')
    assert.equal(failed.continuation.state, 'failed')
    return
  }

  const completed = await waitFor(() => {
    const record = restartedLedger.get(gate.runId)
    return ['completed', 'failed', 'partial', 'stopped', 'interrupted'].includes(record?.status)
      ? record
      : null
  }, 'completed Auto V4 proposal Gate restart', 30000)
  assert.equal(completed.status, 'completed', JSON.stringify({
    reason: completed.reason,
    phase: completed.orchestration?.phase,
    continuation: completed.continuation,
  }))
  assert.deepEqual(
    invocations.filter(call => call.phase === 'proposal' && call.kind === 'codex')
      .map(call => call.operationId),
    [gatedSlot.operationId, gatedSlot.operationId],
  )
  for (const kind of ['hermes', 'workbuddy']) {
    assert.equal(invocations.filter(call => call.phase === 'proposal' && call.kind === kind).length, 1)
  }
  assert.equal(completed.continuation.state, 'completed')
  assert.deepEqual(
    new Set(completed.orchestration.slots.flatMap(slot => (
      slot.resultRefs.workflowOutcomeRefs.map(record => record.receipt.phase)
    ))),
    new Set(['proposal', 'challenge', 'work', 'synthesis', 'verification']),
  )
  assert.ok(resumedProposalRecord)
  const recoveryLedger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger-post-proposal-recovery.json'),
  })
  const crashRecord = structuredClone(resumedProposalRecord)
  crashRecord.status = 'running'
  delete crashRecord.finishedAt
  recoveryLedger.checkpoint(crashRecord)
  const recoveryCalls = []
  const recoveryStoragePath = path.join(directory, 'workspace-post-proposal-recovery.json')
  fs.copyFileSync(options.storagePath, recoveryStoragePath)
  const recovered = new LocalWorkspace({
    ...options,
    storagePath: recoveryStoragePath,
    runLedger: recoveryLedger,
    runAgent: async (agent, prompt, _workdir, runOptions) => {
      const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
      const workItemId = prompt.match(/^Work item: ([A-Za-z0-9._:-]+)$/m)?.[1] || ''
      recoveryCalls.push({ kind: agent.kind, phase, operationId: runOptions.operationId })
      return {
        text: `${agent.kind} ${phase}`,
        sessionRef: `${agent.kind}-${phase}-recovery-session`,
        outcome: 'completed',
        collaboration: autoV4Receipt(agent.kind, phase, workItemId),
      }
    },
  })
  const recoveredController = recovered.activeRuns.get(group.id)
  assert.ok(recoveredController)
  await recovered.refreshAgents()
  await recoveredController.done
  const recoveredFinal = recoveryLedger.get(gate.runId)
  assert.equal(recoveryCalls.some(call => call.phase === 'proposal'), false)
  assert.equal(recoveredFinal.status, 'completed', JSON.stringify({
    reason: recoveredFinal.reason,
    phase: recoveredFinal.orchestration?.phase,
    continuation: recoveredFinal.continuation,
  }))
  assert.equal(recoveredFinal.continuation.state, 'completed')
}

async function restartAutoV4SecondWorkGate(t, rejected = false) {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath, now: () => Date.now() })
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 3, workspaceLimit: 3, globalLimit: 3 })
  const invocations = []
  const permissionRequest = {
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
    ],
    operation: { kind: 'read', path: 'codex-work-2.txt' },
  }
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    const workItemId = prompt.match(/^Work item: ([A-Za-z0-9._:-]+)$/m)?.[1] || ''
    invocations.push({ kind: agent.kind, phase, workItemId, operationId: runOptions.operationId })
    if (agent.kind === 'codex' && phase === 'work' && workItemId === 'codex-work-2') {
      await runOptions.onSessionRef('codex-auto-v4-work-session', { transport: 'acp' })
      const decision = await runOptions.onPermissionRequest(permissionRequest, {
        signal: runOptions.signal,
      })
      assert.equal(decision.optionId, 'allow-once')
    }
    return {
      text: `${agent.kind} ${phase} ${workItemId}`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-${phase}-${workItemId || 'phase'}-session`,
      collaboration: sequentialAutoV4Receipt(agent.kind, phase, workItemId),
    }
  }

  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Auto V4 second work Gate restart',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: false,
  })
  const gatePromise = pendingGate(workspace)
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Resume only the second dependency-ordered Codex work package.',
    mode: 'auto',
    maxRounds: 3,
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    protocol: 'v4',
  })
  const gate = await gatePromise
  const waiting = await waitFor(() => {
    const record = ledger.get(gate.runId)
    const completedTasks = new Set(
      (record?.orchestration?.workReceipts || []).map(receipt => receipt.taskId),
    )
    return record?.orchestration?.phase === 'work'
      && completedTasks.has('codex-work-1')
      && !completedTasks.has('codex-work-2')
      ? record
      : null
  }, 'second Auto V4 work package Gate')
  const gatedSlot = waiting.orchestration.slots.find(slot => slot.agentKind === 'codex')
  const secondCall = invocations.find(call => (
    call.kind === 'codex' && call.phase === 'work' && call.workItemId === 'codex-work-2'
  ))
  assert.equal(gate.agentKind, 'codex')
  assert.equal(secondCall.operationId, gatedSlot.operationId)
  assert.equal(invocations.filter(call => call.workItemId === 'codex-work-1').length, 1)
  assert.equal(invocations.filter(call => call.workItemId === 'codex-work-2').length, 1)
  const controller = workspace.activeRuns.get(group.id)
  assert.equal(workspace.canResumeV4AutoAgentSlot(waiting, gate, controller), true)
  assert.deepEqual({
    phase: waiting.continuation.phase,
    slotId: waiting.continuation.slotId,
    operationId: waiting.continuation.operationId,
    snapshotHash: waiting.continuation.snapshotHash,
  }, {
    phase: 'work',
    slotId: gatedSlot.slotId,
    operationId: gatedSlot.operationId,
    snapshotHash: waiting.orchestration.snapshotHash,
  })

  await workspace.stopAll()
  await send
  assert.equal(ledger.get(gate.runId).status, 'waiting')
  const restartedLedger = new RunLedger({ storagePath: ledgerPath, now: () => Date.now() })
  const beforeDecisionCalls = invocations.length
  const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
  let resumedWorkRecord = null
  if (!rejected) {
    const checkpointRun = restarted.checkpointRun.bind(restarted)
    restarted.checkpointRun = (groupId, activeController, status = '') => {
      const persisted = checkpointRun(groupId, activeController, status)
      const record = restartedLedger.get(activeController.runId)
      if (!resumedWorkRecord && record?.continuation?.state === 'completed'
          && record.orchestration?.phase === 'work'
          && record.orchestration.workReceipts?.some(receipt => (
            receipt.taskId === 'codex-work-2'
          ))) {
        resumedWorkRecord = structuredClone(record)
      }
      return persisted
    }
  }
  await restarted.refreshAgents()
  restarted.decideHumanGate(gate.gateId, {
    status: rejected ? 'rejected' : 'approved',
    optionId: rejected ? 'reject-once' : 'allow-once',
    actorId: 'local-user',
  })

  if (rejected) {
    const stopped = await waitFor(() => {
      const record = restartedLedger.get(gate.runId)
      return record?.status === 'stopped' ? record : null
    }, 'rejected second Auto V4 work Gate')
    assert.equal(invocations.length, beforeDecisionCalls)
    assert.equal(stopped.continuation.state, 'cancelled')
    return
  }

  const completed = await waitFor(() => {
    const record = restartedLedger.get(gate.runId)
    return ['completed', 'failed', 'partial', 'stopped', 'interrupted'].includes(record?.status)
      ? record
      : null
  }, 'completed second Auto V4 work Gate restart', 20000)
  assert.equal(completed.status, 'completed', JSON.stringify({
    reason: completed.reason,
    phase: completed.orchestration?.phase,
    continuation: completed.continuation,
  }))
  assert.equal(invocations.filter(call => call.workItemId === 'codex-work-1').length, 1)
  assert.deepEqual(
    invocations.filter(call => call.workItemId === 'codex-work-2').map(call => call.operationId),
    [gatedSlot.operationId, gatedSlot.operationId],
  )
  assert.equal(
    completed.orchestration.workReceipts.filter(receipt => receipt.taskId === 'codex-work-2').length,
    1,
  )
  assert.equal(completed.continuation.state, 'completed')
  assert.ok(resumedWorkRecord)

  const recoveryLedger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger-post-work-recovery.json'),
  })
  const crashRecord = structuredClone(resumedWorkRecord)
  crashRecord.status = 'running'
  delete crashRecord.finishedAt
  recoveryLedger.checkpoint(crashRecord)
  const recoveryCalls = []
  const recoveryStoragePath = path.join(directory, 'workspace-post-work-recovery.json')
  fs.copyFileSync(options.storagePath, recoveryStoragePath)
  const recovered = new LocalWorkspace({
    ...options,
    storagePath: recoveryStoragePath,
    runLedger: recoveryLedger,
    runAgent: async (agent, prompt, _workdir, runOptions) => {
      const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
      const workItemId = prompt.match(/^Work item: ([A-Za-z0-9._:-]+)$/m)?.[1] || ''
      recoveryCalls.push({ kind: agent.kind, phase, workItemId, operationId: runOptions.operationId })
      return {
        text: `${agent.kind} ${phase} ${workItemId}`,
        sessionRef: `${agent.kind}-${phase}-recovery-session`,
        outcome: 'completed',
        collaboration: sequentialAutoV4Receipt(agent.kind, phase, workItemId),
      }
    },
  })
  await recovered.refreshAgents()
  const recoveredFinal = await waitFor(() => {
    const record = recoveryLedger.get(gate.runId)
    return ['completed', 'failed', 'partial', 'stopped', 'interrupted'].includes(record?.status)
      ? record
      : null
  }, 'post-work Auto V4 recovery')
  assert.equal(
    recoveryCalls.some(call => ['codex-work-1', 'codex-work-2'].includes(call.workItemId)),
    false,
  )
  assert.equal(recoveredFinal.status, 'completed')
  assert.equal(
    recoveredFinal.orchestration.workReceipts
      .filter(receipt => receipt.taskId === 'codex-work-2').length,
    1,
  )
  assert.equal(recoveredFinal.continuation.state, 'completed')
}

test('Auto V4 proposal Gate restart resumes the exact slot and completes receipts', { timeout: 30000 }, async (t) => {
  await restartAutoV4ProposalGate(t)
})

test('Auto V4 proposal Gate restart rejects a tampered round before replay', async (t) => {
  for (const tamper of ['round']) {
    await t.test(tamper, async (subtest) => restartAutoV4ProposalGate(subtest, tamper))
  }
})

test('Auto V4 proposal Gate rejection stops without replay', async (t) => {
  await restartAutoV4ProposalGate(t, 'rejected')
})

test('Auto V4 work Gate restart replays only the second sequential package', async (t) => {
  await restartAutoV4SecondWorkGate(t)
})

test('Auto V4 work Gate rejection stops without replay', async (t) => {
  await restartAutoV4SecondWorkGate(t, true)
})

test('V4 parallel permission Gate pauses queued same-task Agents until approval', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runScheduler = new RunScheduler({ taskLimit: 2, workspaceLimit: 2, globalLimit: 2 })
  const peerRelease = deferred()
  const peerFinished = deferred()
  const started = []
  const completed = []
  options.runAgent = async (agent, _prompt, _workdir, runOptions) => {
    started.push(agent.kind)
    if (agent.kind === 'codex') {
      const decision = await runOptions.onPermissionRequest({
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
        ],
        operation: { kind: 'write', path: 'proposal.txt' },
      }, { signal: runOptions.signal })
      assert.equal(decision.optionId, 'allow-once')
    } else if (agent.kind === 'hermes') {
      await peerRelease.promise
      peerFinished.resolve()
    }
    completed.push(agent.kind)
    return {
      text: `${agent.kind} proposal`,
      sessionRef: `${agent.kind}-session`,
      collaboration: proposalReceipt(agent.kind, `${agent.kind} independent proposal`),
    }
  }

  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'V4 Gate pause',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: false,
  })
  const gatePromise = pendingGate(workspace)
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Produce independent proposals without dispatching past a Gate.',
    mode: 'manual',
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    protocol: 'v4',
  })
  const gate = await gatePromise

  peerRelease.resolve()
  await peerFinished.promise
  await new Promise(resolve => setImmediate(resolve))
  const startedBeforeDecision = [...started]
  const completedBeforeDecision = [...completed]

  workspace.decideHumanGate(gate.gateId, {
    status: 'approved', optionId: 'allow-once', actorId: 'local-user',
  })
  await send

  assert.deepEqual(startedBeforeDecision, ['codex', 'hermes'])
  assert.deepEqual(completedBeforeDecision, ['hermes'])
  assert.deepEqual(started, ['codex', 'hermes', 'workbuddy'])
  assert.equal(options.runScheduler.snapshot().active.global, 0)
  assert.deepEqual(options.runScheduler.snapshot().queued, [])
})

test('Manual V4 restart approval resumes only the bound gated slot with its operation ID', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath, now: () => Date.now() })
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 3, workspaceLimit: 3, globalLimit: 3 })
  const invocations = []
  const permissionRequest = {
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
    ],
    operation: { kind: 'write', path: 'writer-result.txt' },
  }
  options.runAgent = async (agent, _prompt, _workdir, runOptions) => {
    invocations.push({
      kind: agent.kind,
      operationId: runOptions.operationId,
      sandbox: runOptions.sandbox,
    })
    if (agent.kind === 'codex') {
      await runOptions.onSessionRef(`${agent.kind}-v4-gate-session`, { transport: 'acp' })
      const decision = await runOptions.onPermissionRequest(
        permissionRequest,
        { signal: runOptions.signal },
      )
      assert.equal(decision.optionId, 'allow-once')
    }
    return {
      text: `${agent.kind} gated proposal`,
      sessionRef: `${agent.kind}-v4-gate-session`,
      collaboration: proposalReceipt(agent.kind, `${agent.kind} gated summary`),
    }
  }

  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Manual V4 Gate restart',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: true,
  })
  const gatePromise = pendingGate(workspace)
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Resume only the exact gated writer slot.',
    mode: 'manual',
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    protocol: 'v4',
  })
  const gate = await gatePromise
  const beforeRestart = await waitFor(() => {
    const record = ledger.get(gate.runId)
    const settledPeers = record?.orchestration?.slots.filter(slot => (
      slot.agentKind !== gate.agentKind && slot.status === 'completed'
    ))
    return settledPeers?.length === 2 ? record : null
  }, 'settled V4 Gate peers')
  const writerSlot = beforeRestart.orchestration.slots.find(slot => (
    slot.agentKind === gate.agentKind
  ))
  assert.ok(writerSlot)

  await workspace.stopAll()
  await send
  assert.equal(ledger.get(gate.runId).status, 'waiting')

  const restartedLedger = new RunLedger({ storagePath: ledgerPath, now: () => Date.now() })
  const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
  await restarted.refreshAgents()
  restarted.decideHumanGate(gate.gateId, {
    status: 'approved', optionId: 'allow-once', actorId: 'local-user',
  })
  const completed = await waitFor(() => {
    const record = restartedLedger.get(gate.runId)
    return ['completed', 'failed', 'partial', 'stopped'].includes(record?.status) ? record : null
  }, 'completed Manual V4 Gate restart')

  assert.equal(completed.status, 'completed', JSON.stringify({
    reason: completed.reason,
    continuation: completed.continuation,
    phase: completed.orchestration?.phase,
  }))
  const counts = new Map(['codex', 'hermes', 'workbuddy'].map(kind => [
    kind, invocations.filter(call => call.kind === kind).length,
  ]))
  assert.equal(counts.get(gate.agentKind), 2)
  for (const kind of ['codex', 'hermes', 'workbuddy'].filter(kind => kind !== gate.agentKind)) {
    assert.equal(counts.get(kind), 1)
  }
  assert.deepEqual(
    invocations.filter(call => call.kind === gate.agentKind).map(call => call.operationId),
    [writerSlot.operationId, writerSlot.operationId],
  )
  assert.equal(completed.continuation.state, 'completed')
  assert.deepEqual(completed.orchestration.commitState.committedKinds, [
    'codex', 'hermes', 'workbuddy',
  ])
})

test('Manual V4 Gate restart runs untouched safe peers before the stable barrier', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath, now: () => Date.now() })
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 1, workspaceLimit: 1, globalLimit: 1 })
  const invocations = []
  const permissionRequest = {
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
    ],
    operation: { kind: 'write', path: 'capacity-one-writer.txt' },
  }
  options.runAgent = async (agent, _prompt, _workdir, runOptions) => {
    invocations.push({
      kind: agent.kind,
      operationId: runOptions.operationId,
      sandbox: runOptions.sandbox,
    })
    if (agent.kind === 'codex') {
      await runOptions.onSessionRef(`${agent.kind}-capacity-one-session`, { transport: 'acp' })
      const decision = await runOptions.onPermissionRequest(
        permissionRequest,
        { signal: runOptions.signal },
      )
      assert.equal(decision.optionId, 'allow-once')
    }
    return {
      text: `${agent.kind} capacity-one proposal`,
      sessionRef: `${agent.kind}-capacity-one-session`,
      collaboration: proposalReceipt(agent.kind, `${agent.kind} capacity-one summary`),
    }
  }

  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Manual V4 Gate capacity one',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: true,
  })
  const gatePromise = pendingGate(workspace)
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Resume the writer, then run every untouched peer.',
    mode: 'manual',
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    protocol: 'v4',
  })
  const gate = await gatePromise
  const beforeRestart = ledger.get(gate.runId)
  const operations = new Map(beforeRestart.orchestration.slots.map(slot => [
    slot.agentKind, slot.operationId,
  ]))
  assert.deepEqual(invocations.map(call => call.kind), [gate.agentKind])

  await workspace.stopAll()
  await send
  assert.equal(ledger.get(gate.runId).status, 'waiting')

  const restartedLedger = new RunLedger({ storagePath: ledgerPath, now: () => Date.now() })
  const restarted = new LocalWorkspace({
    ...options,
    runLedger: restartedLedger,
    runScheduler: new RunScheduler({ taskLimit: 1, workspaceLimit: 1, globalLimit: 1 }),
  })
  await restarted.refreshAgents()
  restarted.decideHumanGate(gate.gateId, {
    status: 'approved', optionId: 'allow-once', actorId: 'local-user',
  })
  const terminal = await waitFor(() => {
    const record = restartedLedger.get(gate.runId)
    return ['completed', 'partial', 'failed'].includes(record?.status) ? record : null
  }, 'terminal capacity-one Gate restart')

  assert.equal(terminal.status, 'completed')
  assert.deepEqual(invocations.map(call => call.kind), [
    gate.agentKind,
    gate.agentKind,
    ...['codex', 'hermes', 'workbuddy'].filter(kind => kind !== gate.agentKind),
  ])
  assert.equal(invocations.filter(call => call.kind === gate.agentKind).length, 2)
  for (const call of invocations) {
    assert.equal(call.operationId, operations.get(call.kind))
  }
  assert.deepEqual(terminal.orchestration.commitState.committedKinds, [
    'codex', 'hermes', 'workbuddy',
  ])
})

test('Manual V4 read-only Gate restart preserves a queued writer through the stable barrier', async (t) => {
  const { directory, options } = fixture()
  const detectAgents = options.detectAgents
  options.detectAgents = async () => (await detectAgents()).map(agent => agent.kind === 'codex'
    ? { ...agent, routingCapabilities: { permissionModes: ['read-only'] } } : agent)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath, now: () => Date.now() })
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 1, workspaceLimit: 1, globalLimit: 1 })
  const invocations = []
  const permissionRequest = {
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
    ],
    operation: { kind: 'read', path: 'read-only-evidence.txt' },
  }
  options.runAgent = async (agent, _prompt, _workdir, runOptions) => {
    invocations.push({
      kind: agent.kind,
      operationId: runOptions.operationId,
      sandbox: runOptions.sandbox,
    })
    if (agent.kind === 'codex') {
      assert.equal(runOptions.sandbox, 'read-only')
      await runOptions.onSessionRef(`${agent.kind}-read-only-gate-session`, { transport: 'acp' })
      const decision = await runOptions.onPermissionRequest(
        permissionRequest,
        { signal: runOptions.signal },
      )
      assert.equal(decision.optionId, 'allow-once')
    }
    return {
      text: `${agent.kind} read-only Gate proposal`,
      sessionRef: `${agent.kind}-read-only-gate-session`,
      collaboration: proposalReceipt(agent.kind, `${agent.kind} read-only Gate summary`),
    }
  }

  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Manual V4 read-only Gate queued writer',
    agentKinds: ['codex', 'workbuddy', 'hermes'],
    workdir: directory,
    allowWrite: true,
  })
  const gatePromise = pendingGate(workspace)
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Resume the read-only Gate, then run the queued writer and remaining peer.',
    mode: 'manual',
    targetKinds: ['codex', 'workbuddy', 'hermes'],
    protocol: 'v4',
  })
  const gate = await gatePromise
  const beforeRestart = ledger.get(gate.runId)
  const operations = new Map(beforeRestart.orchestration.slots.map(slot => [
    slot.agentKind, slot.operationId,
  ]))
  const gatedSlot = beforeRestart.orchestration.slots.find(slot => (
    slot.agentKind === gate.agentKind
  ))
  const writerKind = beforeRestart.orchestration.commitState.writerKind
  const writerSlot = beforeRestart.orchestration.slots.find(slot => (
    slot.agentKind === writerKind
  ))
  assert.equal(gate.agentKind, 'codex')
  assert.equal(gatedSlot.permission, 'read-only')
  assert.ok(['workbuddy', 'hermes'].includes(writerKind))
  assert.equal(writerSlot.permission, 'workspace-write')
  assert.equal(writerSlot.status, 'queued')
  assert.deepEqual(invocations, [{
    kind: 'codex',
    operationId: operations.get('codex'),
    sandbox: 'read-only',
  }])

  await workspace.stopAll()
  await send
  const waiting = ledger.get(gate.runId)
  assert.equal(waiting.status, 'waiting')
  assert.equal(
    waiting.orchestration.slots.find(slot => slot.agentKind === writerKind).status,
    'queued',
  )

  const restartedLedger = new RunLedger({ storagePath: ledgerPath, now: () => Date.now() })
  const restarted = new LocalWorkspace({
    ...options,
    runLedger: restartedLedger,
    runScheduler: new RunScheduler({ taskLimit: 1, workspaceLimit: 1, globalLimit: 1 }),
  })
  await restarted.refreshAgents()
  restarted.decideHumanGate(gate.gateId, {
    status: 'approved', optionId: 'allow-once', actorId: 'local-user',
  })
  const terminal = await waitFor(() => {
    const record = restartedLedger.get(gate.runId)
    return ['completed', 'partial', 'failed'].includes(record?.status) ? record : null
  }, 'terminal read-only Gate queued-writer restart')

  assert.equal(terminal.status, 'completed')
  assert.deepEqual(invocations.map(call => call.kind), [
    'codex', 'codex', 'workbuddy', 'hermes',
  ])
  for (const call of invocations) {
    assert.equal(call.operationId, operations.get(call.kind))
    assert.equal(call.sandbox, call.kind === 'codex' ? 'read-only' : 'workspace-write')
  }
  assert.deepEqual(terminal.orchestration.commitState.committedKinds, [
    'codex', 'workbuddy', 'hermes',
  ])
})

test('Manual V4 rejects approved Gate continuations with mismatched slot bindings', async (t) => {
  for (const tamper of ['operation', 'slot', 'round']) {
    await t.test(tamper, async (subtest) => {
      const { directory, options } = fixture()
      subtest.after(() => fs.rmSync(directory, { recursive: true, force: true }))
      const ledgerPath = path.join(directory, 'run-ledger.json')
      const ledger = new RunLedger({ storagePath: ledgerPath, now: () => Date.now() })
      options.runLedger = ledger
      options.runScheduler = new RunScheduler({ taskLimit: 3, workspaceLimit: 3, globalLimit: 3 })
      const invocations = []
      const permissionRequest = {
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
        ],
        operation: { kind: 'write', path: 'bound-writer-result.txt' },
      }
      options.runAgent = async (agent, _prompt, _workdir, runOptions) => {
        invocations.push(agent.kind)
        if (agent.kind === 'codex') {
          await runOptions.onSessionRef(`${agent.kind}-binding-session`, { transport: 'acp' })
          await runOptions.onPermissionRequest(permissionRequest, { signal: runOptions.signal })
        }
        return {
          text: `${agent.kind} binding proposal`,
          sessionRef: `${agent.kind}-binding-session`,
          collaboration: proposalReceipt(agent.kind, `${agent.kind} binding summary`),
        }
      }

      const workspace = new LocalWorkspace(options)
      await workspace.refreshAgents()
      const group = workspace.createGroup({
        name: `Manual V4 Gate binding ${tamper}`,
        agentKinds: ['codex', 'hermes', 'workbuddy'],
        workdir: directory,
        allowWrite: true,
      })
      const gatePromise = pendingGate(workspace)
      const send = workspace.sendMessage({
        groupId: group.id,
        text: 'Reject any mismatched gated slot binding.',
        mode: 'manual',
        targetKinds: ['codex', 'hermes', 'workbuddy'],
        protocol: 'v4',
      })
      const gate = await gatePromise
      await waitFor(() => {
        const record = ledger.get(gate.runId)
        return record?.orchestration?.slots.filter(slot => (
          slot.agentKind !== gate.agentKind && slot.status === 'completed'
        )).length === 2
      }, `settled ${tamper} binding peers`)
      await workspace.stopAll()
      await send

      const durable = ledger.get(gate.runId)
      const restartedLedger = new RunLedger({ storagePath: ledgerPath, now: () => Date.now() })
      const tamperedRecord = restartedLedger.runs.find(record => record.runId === durable.runId)
      if (tamper === 'round') {
        tamperedRecord.continuation.round += 1
      } else {
        const orchestration = tamperedRecord.orchestration
        const slot = orchestration.slots.find(item => item.agentKind === gate.agentKind)
        const assignment = orchestration.plan.assignments.find(item => (
          item.agentKind === gate.agentKind
        ))
        if (tamper === 'operation') {
          const operationId = `agent-operation-${'a'.repeat(64)}`
          slot.operationId = operationId
          assignment.operationId = operationId
          orchestration.deliveryWatermarks.find(item => (
            item.agentKind === gate.agentKind
          )).operationId = operationId
        } else {
          const slotId = `slot-tampered-${gate.agentKind}`
          slot.slotId = slotId
          assignment.slotId = slotId
        }
      }
      const beforeDecisionCalls = invocations.length

      const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
      await restarted.refreshAgents()
      assert.throws(() => restarted.decideHumanGate(gate.gateId, {
        status: 'approved', optionId: 'allow-once', actorId: 'local-user',
      }), { message: tamper === 'slot'
        ? 'HUMAN_GATE_ALREADY_DECIDED'
        : 'RUN_LEDGER_RECORD_INVALID' })
      assert.equal(invocations.length, beforeDecisionCalls)
      assert.equal(
        restarted.humanGateStore.get(gate.gateId).status,
        tamper === 'slot' ? 'rejected' : 'pending',
      )
    })
  }
})

test('Manual V4 requires a Gate before retrying an unknown writable outcome', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger.json'),
    now: () => Date.now(),
  })
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 3, workspaceLimit: 3, globalLimit: 3 })
  const invocations = []
  let writerFailures = 0
  options.runAgent = async (agent, _prompt, _workdir, runOptions) => {
    invocations.push({
      kind: agent.kind,
      operationId: runOptions.operationId,
      sandbox: runOptions.sandbox,
    })
    if (runOptions.sandbox === 'workspace-write' && writerFailures === 0) {
      writerFailures += 1
      throw Object.assign(new Error('socket reset after write'), { code: 'ECONNRESET' })
    }
    return {
      text: `${agent.kind} retry-safe proposal`,
      sessionRef: `${agent.kind}-retry-session`,
      collaboration: proposalReceipt(agent.kind, `${agent.kind} retry-safe summary`),
    }
  }

  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Manual V4 unknown writable outcome',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: true,
  })
  const gatePromise = pendingGate(workspace)
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Gate any retry whose write outcome is unknown.',
    mode: 'manual',
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    protocol: 'v4',
  })
  const gate = await gatePromise
  assert.equal(gate.type, 'retry')
  const request = workspace.humanGateStore.request(gate.gateId)
  assert.equal(request.outcomeCertainty, 'unknown_outcome')
  assert.equal(request.sideEffectsPossible, true)
  await new Promise(resolve => setImmediate(resolve))

  const beforeApproval = invocations.filter(call => call.kind === gate.agentKind)
  assert.equal(beforeApproval.length, 1)
  assert.equal(beforeApproval[0].sandbox, 'workspace-write')
  assert.ok(invocations.every(call => call.sandbox === 'workspace-write'))

  workspace.decideHumanGate(gate.gateId, {
    status: 'approved', optionId: 'retry-once', actorId: 'local-user',
  })
  await send

  const writerCalls = invocations.filter(call => call.kind === gate.agentKind)
  assert.equal(writerCalls.length, 2)
  assert.deepEqual(writerCalls.map(call => call.operationId), [request.operationId, request.operationId])
  for (const kind of ['codex', 'hermes', 'workbuddy'].filter(kind => kind !== gate.agentKind)) {
    assert.equal(invocations.filter(call => call.kind === kind).length, 1)
    assert.equal(invocations.find(call => call.kind === kind).sandbox, 'workspace-write')
  }
  assert.deepEqual(ledger.get(gate.runId).orchestration.commitState.committedKinds, [
    'codex', 'hermes', 'workbuddy',
  ])
})

test('Auto V4 atomically checkpoints a resumed receipt with its completed continuation', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger.json'), now: () => Date.now(),
  })
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 3, workspaceLimit: 3, globalLimit: 3 })
  const calls = []
  let holdWorkbuddy = true
  const permissionRequest = {
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
    ],
    operation: { kind: 'read', path: 'resumed-proposal.txt' },
  }
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    const workItemId = prompt.match(/^Work item: ([A-Za-z0-9._:-]+)$/m)?.[1] || ''
    calls.push({ kind: agent.kind, phase, operationId: runOptions.operationId })
    if (agent.kind === 'workbuddy' && phase === 'proposal' && holdWorkbuddy) {
      const pending = deferred()
      const abort = () => pending.reject(Object.assign(
        new Error('LOCAL_AGENT_STOPPED'), { code: 'ABORT_ERR' },
      ))
      runOptions.signal.addEventListener('abort', abort, { once: true })
      try { await pending.promise } finally { runOptions.signal.removeEventListener('abort', abort) }
    }
    if (agent.kind === 'codex' && phase === 'proposal') {
      await runOptions.onSessionRef('codex-resumed-proposal-session', { transport: 'acp' })
      await runOptions.onPermissionRequest(permissionRequest, { signal: runOptions.signal })
    }
    return {
      text: `${agent.kind} ${phase}`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-${phase}-session`,
      collaboration: autoV4Receipt(agent.kind, phase, workItemId),
    }
  }

  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Auto V4 resumed receipt crash window',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: false,
  })
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Retire the resumed Gate before the pending peer finishes.',
    mode: 'auto',
    maxRounds: 3,
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    protocol: 'v4',
  })
  const gate = await pendingGate(workspace)
  const waiting = await waitFor(() => {
    const record = ledger.get(gate.runId)
    const hermes = record?.orchestration?.slots.find(slot => slot.agentKind === 'hermes')
    const workbuddy = record?.orchestration?.slots.find(slot => slot.agentKind === 'workbuddy')
    return hermes?.status === 'completed' && workbuddy?.status === 'running' ? record : null
  }, 'initial pending Auto proposal peer')
  const workspaceBytes = fs.readFileSync(options.storagePath)
  const gateStorePath = path.join(directory, 'meldwork-private', 'human-gates.json')
  const gateBytes = fs.readFileSync(gateStorePath)
  await workspace.stopAll()
  await send
  fs.writeFileSync(options.storagePath, workspaceBytes)
  fs.writeFileSync(gateStorePath, gateBytes)

  const resumedLedger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger-resumed-peer.json'), now: () => Date.now(),
  })
  resumedLedger.checkpoint(waiting)
  const resumed = new LocalWorkspace({
    ...options,
    runLedger: resumedLedger,
    runScheduler: new RunScheduler({ taskLimit: 3, workspaceLimit: 3, globalLimit: 3 }),
  })
  const checkpointRun = resumed.checkpointRun.bind(resumed)
  const crashCheckpoint = deferred()
  let crashRecord = null
  let crashWorkspaceBytes = null
  let crashGateBytes = null
  resumed.checkpointRun = (groupId, activeController, status = '') => {
    const persisted = checkpointRun(groupId, activeController, status)
    const record = resumedLedger.get(activeController.runId)
    const codex = record?.orchestration?.slots.find(slot => slot.agentKind === 'codex')
    const workbuddy = record?.orchestration?.slots.find(slot => slot.agentKind === 'workbuddy')
    if (!crashRecord && codex?.status === 'completed' && workbuddy?.status === 'running'
        && codex.resultRefs.workflowOutcomeRefs.some(item => (
          item.receipt?.phase === 'proposal' && item.receipt.operationId === codex.operationId
        ))) {
      crashRecord = structuredClone(record)
      crashWorkspaceBytes = fs.readFileSync(options.storagePath)
      crashGateBytes = fs.readFileSync(gateStorePath)
      crashCheckpoint.resolve()
      throw new Error('TEST_CRASH:after_atomic_resumed_receipt_checkpoint')
    }
    return persisted
  }
  await resumed.refreshAgents()
  resumed.decideHumanGate(gate.gateId, {
    status: 'approved', optionId: 'allow-once', actorId: 'local-user',
  })
  await crashCheckpoint.promise
  const proposalCallsBeforeRecovery = calls.filter(call => call.phase === 'proposal')

  await resumed.stopAll()
  assert.equal(crashRecord.continuation.state, 'completed')
  fs.writeFileSync(options.storagePath, crashWorkspaceBytes)
  fs.writeFileSync(gateStorePath, crashGateBytes)
  holdWorkbuddy = false
  const recoveryLedger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger-remaining-peer.json'), now: () => Date.now(),
  })
  recoveryLedger.checkpoint(crashRecord)
  const recovered = new LocalWorkspace({
    ...options,
    runLedger: recoveryLedger,
    runScheduler: new RunScheduler({ taskLimit: 3, workspaceLimit: 3, globalLimit: 3 }),
  })
  await recovered.refreshAgents()
  const terminal = await waitFor(() => {
    const record = recoveryLedger.get(gate.runId)
    return ['completed', 'failed', 'partial', 'stopped'].includes(record?.status) ? record : null
  }, 'remaining Auto proposal peer recovery', 15000)

  assert.equal(terminal.status, 'completed', terminal.reason)
  assert.equal(calls.filter(call => call.phase === 'proposal' && call.kind === 'codex').length,
    proposalCallsBeforeRecovery.filter(call => call.kind === 'codex').length)
  assert.equal(calls.filter(call => call.phase === 'proposal' && call.kind === 'hermes').length,
    proposalCallsBeforeRecovery.filter(call => call.kind === 'hermes').length)
  assert.equal(calls.filter(call => call.phase === 'proposal' && call.kind === 'workbuddy').length,
    proposalCallsBeforeRecovery.filter(call => call.kind === 'workbuddy').length + 1)
})

test('Auto V4 rejects a terminal proposal while its live permission Gate is pending', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger.json'), now: () => Date.now(),
  })
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 3, workspaceLimit: 3, globalLimit: 3 })
  const calls = []
  const permissionRequest = {
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
    ],
    operation: { kind: 'read', path: 'live-proposal.txt' },
  }
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    const workItemId = prompt.match(/^Work item: ([A-Za-z0-9._:-]+)$/m)?.[1] || ''
    calls.push({ kind: agent.kind, phase, operationId: runOptions.operationId })
    if (agent.kind === 'codex' && phase === 'proposal') {
      await runOptions.onSessionRef('codex-live-permission-session', { transport: 'acp' })
      void runOptions.onPermissionRequest(permissionRequest, { signal: runOptions.signal })
    }
    return {
      text: `${agent.kind} ${phase}`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-${phase}-session`,
      outcome: 'completed',
      collaboration: autoV4Receipt(agent.kind, phase, workItemId),
    }
  }

  const workspace = new LocalWorkspace(options)
  t.after(() => workspace.stopAll())
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Auto V4 live permission terminal race',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: false,
  })
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Do not advance beyond a pending proposal Gate.',
    mode: 'auto',
    maxRounds: 3,
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    protocol: 'v4',
  }).then(value => ({ value }), error => ({ error }))
  const gate = await pendingGate(workspace)
  await waitFor(() => calls.filter(call => call.phase === 'proposal').length === 3,
    'all proposal Agents dispatched')
  assert.doesNotThrow(() => workspace.decideHumanGate(gate.gateId, {
    status: 'rejected', optionId: 'reject-once', actorId: 'local-user',
  }))
  const outcome = await send
  assert.notEqual(outcome.error?.message, 'LOCAL_RUN_PERSIST_FAILED')
  const terminal = await waitFor(() => {
    const record = ledger.get(gate.runId)
    return ['failed', 'partial', 'stopped'].includes(record?.status) ? record : null
  }, 'terminal live permission race')

  assert.equal(workspace.humanGateStore.get(gate.gateId).status, 'rejected')
  assert.equal(terminal.orchestration.phase, 'proposal')
  assert.equal(terminal.orchestration.round, 1)
  assert.notEqual(terminal.reason, 'LOCAL_RUN_PERSIST_FAILED')
  assert.equal(calls.some(call => call.phase === 'challenge'), false)

  const previousOrchestration = { version: 4, phase: 'proposal', round: 1 }
  const checkpointController = { orchestration: previousOrchestration, currentRound: 2 }
  const checkpointRun = workspace.autoRunner.checkpointRun
  workspace.autoRunner.checkpointRun = () => false
  try {
    assert.throws(() => workspace.autoRunner.checkpointOrchestration(
      group, checkpointController, { phase: 'challenge' },
    ), { message: 'LOCAL_RUN_PERSIST_FAILED' })
    assert.equal(checkpointController.orchestration, previousOrchestration)
    assert.equal(checkpointController.currentRound, 1)
  } finally {
    workspace.autoRunner.checkpointRun = checkpointRun
  }
})

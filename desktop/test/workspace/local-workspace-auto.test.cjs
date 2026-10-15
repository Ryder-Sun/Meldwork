const test = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { agentRuntimeError } = require('../../src/agents/agent-runtime-contract.cjs')
const { MAX_RUN_AGENT_ATTEMPTS } = require('../../src/runs/failure-policy.cjs')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const {
  createCollaborationReceipt,
  createOrchestrationV4,
  hashValue,
} = require('../../src/collaboration/orchestration-v4-records.cjs')
const { RunLedger } = require('../../src/runs/run-ledger.cjs')
const { RunScheduler } = require('../../src/runs/run-scheduler.cjs')
const { v4Snapshot } = require('../../src/workspace/local-workspace-context.cjs')
const { deferred, fixture } = require('../support/local-workspace-test-helpers.cjs')

function pendingHumanGate(workspace, timeoutMs = 2000) {
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

function graphNode(overrides = {}) {
  return {
    nodeId: 'primary-codex', role: 'primary', agentKind: 'codex',
    dependsOn: [], inputNodeIds: [], expectedOutput: 'Produce one durable conclusion.',
    acceptance: { requireConclusion: true, minArtifactRefs: 1, minEvidenceRefs: 1 },
    terminal: false, parallel: false, decisionOptions: [],
    ...overrides,
  }
}

function challengeBindingInput(workspace, targetKinds, round, bodyHash = 'a'.repeat(64), runId = 'run-binding') {
  const controller = workspace.createRunController('auto', targetKinds, 'root-binding', 8, false)
  controller.runId = runId
  controller.taskId = 'task-binding'
  controller.currentRound = round
  const snapshotHash = 'b'.repeat(64)
  const slots = targetKinds.map((kind, index) => ({
    slotId: `slot-${index + 1}-${kind}`,
    agentKind: kind,
    operationId: workspace.autoRunner.v4OperationId(
      controller, kind, 'challenge', `slot-${index + 1}-${kind}`,
    ),
  }))
  const receiptRecords = slots.map((slot) => ({
    receipt: createCollaborationReceipt({
      phase: 'proposal',
      agentKind: slot.agentKind,
      slotId: slot.slotId,
      operationId: `operation-proposal-${slot.agentKind}`,
      status: 'completed',
      summary: `${slot.agentKind} proposal`,
      artifactIds: [`artifact-${slot.agentKind}-1`, `artifact-${slot.agentKind}-2`],
      evidenceIds: [`evidence-${slot.agentKind}-1`, `evidence-${slot.agentKind}-2`],
      snapshotHash,
      deliveryWatermark: 1,
    }),
  }))
  return {
    controller,
    targetKinds,
    round,
    snapshotRecord: { bodyHash },
    slots,
    receiptRecords,
  }
}

test('automatic local invocations default to yolo permission approval', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  delete options.defaultYolo
  let approvals = 0
  options.runAgent = async (agent, _prompt, _workdir, runOptions) => {
    const decision = await runOptions.onPermissionRequest({
      options: [{ optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' }],
      operation: { kind: 'write', path: 'result.txt' },
    }, { signal: runOptions.signal })
    assert.equal(decision.status, 'approved')
    approvals += 1
    return { text: `${agent.kind} completed`, sessionRef: `${agent.kind}-session` }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Default yolo permissions',
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
    allowWrite: true,
  })
  await workspace.sendMessage({
    groupId: group.id,
    text: 'Complete without interactive permission prompts.',
    mode: 'auto',
    maxRounds: 1,
    targetKinds: ['codex', 'hermes'],
  })
  await workspace.activeRuns.get(group.id).promise
  assert.equal(approvals, 2)
  assert.equal(workspace.listHumanGates({ pendingOnly: true }).length, 0)
})

function synthesisCandidates(targetKinds, overrides = {}) {
  return targetKinds.map((kind, index) => ({
    kind,
    eligible: true,
    exclusions: [],
    score: overrides[kind]?.score ?? 500 - index,
    ...(overrides[kind]?.evidence === null ? {} : {
      evidence: overrides[kind]?.evidence || {
        matrixVersion: 'fit-matrix-v1',
        score: 80 - index,
        confidence: 0.8,
        sampleSize: 8,
      },
    }),
  }))
}

function synthesisBindingInput(targetKinds, overrides = {}) {
  return {
    targetKinds,
    snapshotRecord: { bodyHash: overrides.bodyHash || overrides.contentHash || 'a'.repeat(64) },
    routingDecision: {
      selectedKinds: [...targetKinds],
      candidates: overrides.candidates || synthesisCandidates(targetKinds),
    },
  }
}

function agreedAssignments(targetKinds) {
  const finalizerKind = targetKinds.at(-1)
  const taskIds = new Map(targetKinds.map(kind => [kind, `work-${kind}`]))
  return targetKinds.map(kind => ({
    taskId: taskIds.get(kind),
    ownerKind: kind,
    role: kind === finalizerKind ? 'integrator' : 'worker',
    objective: `Complete the agreed ${kind} work package.`,
    expectedOutput: `${kind} work Artifact.`,
    inputRefs: [],
    artifactIds: [],
    dependsOn: kind === finalizerKind
      ? targetKinds.filter(candidate => candidate !== finalizerKind).map(candidate => taskIds.get(candidate))
      : [],
  }))
}

function v4ProposalCollaboration(agentKind, summary = `${agentKind} proposal`) {
  return {
    version: 1,
    phase: 'proposal',
    summary,
    capabilities: [`${agentKind} capability`],
    intendedWork: [`${agentKind} independent work package`],
    deliverables: [`${agentKind} proposal Artifact`],
    dependencies: [],
  }
}

function agreedV4Collaboration(agentKind, phase, prompt, targetKinds, options = {}) {
  const summary = options.summary || `${agentKind} ${phase}`
  if (phase === 'proposal') return v4ProposalCollaboration(agentKind, summary)
  if (phase === 'challenge') {
    return {
      version: 1,
      phase,
      verdict: 'support',
      summary,
      proposedAssignments: agreedAssignments(targetKinds),
      finalizerKind: targetKinds.at(-1),
      verifierKinds: targetKinds
        .filter(kind => kind !== targetKinds.at(-1))
        .slice(0, Math.min(2, targetKinds.length - 1)),
      agreeToPlan: true,
    }
  }
  if (phase === 'work') {
    return {
      version: 1,
      phase,
      summary,
      workItemId: prompt.match(/^Work item: ([A-Za-z0-9._:-]+)$/m)?.[1] || '',
      deliverables: [`${agentKind} work Artifact`],
    }
  }
  if (phase === 'synthesis') {
    return { version: 1, phase, summary, resolvedIssueIds: options.resolvedIssueIds || [] }
  }
  return {
    version: 1,
    phase,
    verdict: options.verificationVerdict || 'support',
    summary,
  }
}

function evidenceTaskGraph() {
  return {
    template: 'task-graph',
    nodes: [
      graphNode({ parallel: true }),
      graphNode({ nodeId: 'primary-hermes', agentKind: 'hermes', parallel: true }),
      graphNode({
        nodeId: 'review-workbuddy', role: 'reviewer', agentKind: 'workbuddy',
        dependsOn: ['primary-codex', 'primary-hermes'],
        inputNodeIds: ['primary-codex', 'primary-hermes'],
        expectedOutput: 'Review both Primary results independently.',
      }),
      graphNode({
        nodeId: 'decide-kimi', role: 'arbiter', agentKind: 'kimi',
        dependsOn: ['review-workbuddy'], inputNodeIds: ['review-workbuddy'],
        expectedOutput: 'Resolve the reviewed conflict using typed Evidence.',
        terminal: true,
      }),
    ],
  }
}

test('task graph runs independent branches in parallel and completes from typed Evidence', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  const primaryBarrier = deferred()
  let activePrimaries = 0
  let maxActivePrimaries = 0
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (['codex', 'hermes'].includes(agent.kind)) {
      activePrimaries += 1
      maxActivePrimaries = Math.max(maxActivePrimaries, activePrimaries)
      if (activePrimaries === 2) primaryBarrier.resolve()
      await primaryBarrier.promise
      activePrimaries -= 1
    }
    return {
      text: agent.kind === 'codex'
        ? 'Release is ready.'
        : (agent.kind === 'hermes' ? 'Release is blocked.' : `${agent.kind} typed decision.`),
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Evidence task graph',
    agentKinds: ['codex', 'hermes', 'workbuddy', 'kimi'],
    workdir: directory,
    allowWrite: false,
  })

  const started = await workspace.sendMessage({
    groupId: group.id,
    text: 'Assess release readiness with independent review.',
    mode: 'auto',
    maxRounds: 6,
    targetKinds: ['codex', 'hermes', 'workbuddy', 'kimi'],
    workflow: evidenceTaskGraph(),
  })
  await workspace.activeRuns.get(group.id).promise

  assert.equal(maxActivePrimaries, 2)
  assert.deepEqual(calls.map(call => call.agent.kind), [
    'codex', 'hermes', 'workbuddy', 'kimi',
  ])
  assert.equal(calls.every(call => !call.prompt.includes('MELDWORK_CONSENSUS')), true)
  assert.equal(calls[2].runOptions.sessionRef, '')
  assert.match(calls[2].prompt, /MELDWORK_TASK_GRAPH_V1/)
  assert.match(calls[2].prompt, /\[conflict\]/)
  assert.equal(calls[3].runOptions.sessionRef, '')

  const durable = ledger.list(group.id)[0]
  assert.equal(durable.status, 'completed')
  assert.equal(durable.orchestration.version, 3)
  assert.equal(durable.orchestration.taskGraph.terminalState, 'accepted')
  const states = Object.fromEntries(durable.orchestration.taskGraph.nodeStates.map(state => (
    [state.nodeId, state]
  )))
  assert.equal(states['review-workbuddy'].attention, 'review')
  assert.equal(states['decide-kimi'].attention, 'decision')
  assert.equal(durable.orchestration.taskGraph.nodeStates.every(state => (
    state.status === 'accepted'
  )), true)
  assert.equal(durable.orchestration.collaboration.entries.some(entry => (
    entry.entryType === 'decision'
    && entry.refs.some(reference => durable.orchestration.collaboration.entries.some(
      candidate => candidate.entryId === reference && candidate.entryType === 'conflict',
    ))
  )), true)
  assert.equal(workspace.snapshot().messages.filter(message => (
    message.threadRootId === started.threadRootId && message.role === 'agent'
  )).length, 4)
})

test('task graph Human node uses a typed decision instead of Agent consensus', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Human decision graph', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const graph = {
    template: 'task-graph',
    nodes: [
      graphNode(),
      graphNode({
        nodeId: 'human-release', role: 'human', agentKind: null,
        dependsOn: ['primary-codex'], inputNodeIds: ['primary-codex'],
        expectedOutput: 'Approve or reject the release decision.',
        acceptance: { requireConclusion: false, minArtifactRefs: 0, minEvidenceRefs: 0 },
        terminal: true,
        decisionOptions: [
          { optionId: 'approve-release', name: 'Approve release', kind: 'allow_once' },
          { optionId: 'reject-release', name: 'Reject release', kind: 'reject_once' },
        ],
      }),
    ],
  }

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Prepare a release decision.',
    mode: 'auto', maxRounds: 4, targetKinds: ['codex', 'hermes'], workflow: graph,
  })
  const gate = await pendingHumanGate(workspace)
  assert.equal(gate.type, 'decision')
  assert.equal(ledger.get(gate.runId).orchestration.taskGraph.nodeStates[1].status, 'waiting')
  workspace.decideHumanGate(gate.gateId, {
    status: 'approved', optionId: 'approve-release', actorId: 'local-user',
  })
  await workspace.activeRuns.get(group.id).promise

  const durable = ledger.get(gate.runId)
  assert.equal(durable.status, 'completed')
  assert.equal(durable.continuation.state, 'completed')
  assert.equal(durable.orchestration.taskGraph.nodeStates[1].decisionOptionId, 'approve-release')
  assert.equal(calls.length, 1)
})
test('auto send preflights atomically, persists one root, and starts at round one', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const firstCallEntered = deferred()
  const firstCallGate = deferred()
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (calls.length === 1) {
      firstCallEntered.resolve()
      await firstCallGate.promise
    }
    return {
      text: `${agent.kind} agrees\n[[MELDWORK_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  options.validateKnowledgeBaseSelections = (_targetKinds, selections) => selections.map(selection => ({
    ...selection,
    name: 'DingTalk',
    accessMode: 'cli',
    commandName: 'dws',
  }))
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '原子自动讨论', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const attachment = {
    id: 'auto-send-image', name: 'context.png', mimeType: 'image/png', size: 20,
  }
  const skill = {
    targetKind: 'hermes', namespace: 'global', slug: 'research', name: 'Research',
  }
  const knowledgeBase = { kind: 'dingtalk', targetKinds: ['hermes'] }

  const started = await workspace.sendMessage({
    groupId: group.id,
    text: '直接开始自动讨论',
    mode: 'auto',
    maxRounds: 2,
    targetKinds: ['codex', 'hermes'],
    attachments: [attachment],
    skillHints: [skill],
    knowledgeBaseHints: [knowledgeBase],
  })
  await firstCallEntered.promise

  const active = workspace.snapshot()
  const root = active.messages.find(message => message.role === 'user')
  assert.deepEqual(started, { started: true, maxRounds: 2, threadRootId: root.id })
  assert.equal(active.messages.filter(message => message.role === 'user').length, 1)
  assert.equal(root.threadRootId, undefined)
  assert.deepEqual(root.targetKinds, ['codex', 'hermes'])
  assert.deepEqual(root.knowledgeBaseHints, [{
    kind: 'dingtalk', name: 'DingTalk', accessMode: 'cli',
    commandName: 'dws', targetKinds: ['hermes'],
  }])
  assert.deepEqual(active.runs.map(run => ({
    mode: run.mode,
    currentRound: run.currentRound,
    maxRounds: run.maxRounds,
    threadRootId: run.threadRootId,
  })), [{ mode: 'auto', currentRound: 1, maxRounds: 2, threadRootId: root.id }])
  assert.equal(calls.length, 1)
  assert.match(calls[0].prompt, /MELDWORK_CONSENSUS/)
  assert.doesNotMatch(JSON.stringify(active), /sessionRef/)

  const pending = workspace.activeRuns.get(group.id).promise
  firstCallGate.resolve()
  await pending

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes'])
  assert.equal(calls.every(call => call.prompt.includes('MELDWORK_CONSENSUS')), true)
  assert.deepEqual(calls.map(call => call.runOptions.attachments), [
    [path.join(directory, 'attachments', 'auto-send-image.png')],
    [path.join(directory, 'attachments', 'auto-send-image.png')],
  ])
  assert.equal(calls[1].runOptions.skills, undefined)
  assert.match(calls[1].prompt, /global\/research: Research/)
  assert.doesNotMatch(calls[0].prompt, /configured dws command-line connection/)
  assert.match(calls[1].prompt, /configured dws command-line connection/)
  assert.deepEqual(
    workspace.snapshot().messages.filter(message => message.role === 'agent')
      .map(message => message.threadRootId),
    [root.id, root.id],
  )
  assert.equal(finished.length, 1)
  assert.equal(finished[0].mode, 'auto')
  assert.equal(finished[0].status, 'completed')
})

test('automatic Primary Reviewer Arbiter flow uses selective typed collaboration state', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  const conclusions = {
    codex: 'The release is ready after tests.',
    hermes: 'The release is blocked by missing package proof.',
    workbuddy: 'The release is ready because package proof is present.',
  }
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: `${conclusions[agent.kind]}\n[[MELDWORK_CONSENSUS:agree]]`,
      sessionRef: `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Typed collaboration',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
  })

  const started = await workspace.sendMessage({
    groupId: group.id,
    text: 'Assess release readiness using the available evidence.',
    mode: 'auto',
    maxRounds: 2,
    targetKinds: ['codex', 'hermes', 'workbuddy'],
  })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes', 'workbuddy'])
  assert.match(calls[0].prompt, /Role: primary/)
  assert.match(calls[0].prompt, /Selected blackboard entries: \(none\)/)
  assert.match(calls[1].prompt, /Role: reviewer/)
  assert.match(calls[1].prompt, /The release is ready after tests\./)
  assert.match(calls[2].prompt, /Role: arbiter/)
  assert.match(calls[2].prompt, /\[conflict\]/)
  assert.match(calls[2].prompt, /missing package proof/)
  assert.doesNotMatch(calls[2].prompt, /Recent conversation across the group:\n(?:Codex|Hermes):/)

  const messages = workspace.snapshot().messages.filter(message => message.role === 'agent')
  const arbiterMessage = messages.find(message => message.agentKind === 'workbuddy')
  const transcriptOnly = workspace.packedPromptContext(group.id, '', started.threadRootId, {
    beforeMessageId: arbiterMessage.id,
    focusUserMessageId: started.threadRootId,
  })
  assert.ok(transcriptOnly.context.includedCount > arbiterMessage.trace.context.includedCount)
  assert.ok(transcriptOnly.context.charCount > arbiterMessage.trace.context.charCount)
  assert.deepEqual(arbiterMessage.trace.sourceMessageIds, [started.threadRootId])

  const durable = ledger.list(group.id)[0]
  assert.equal(durable.orchestration.version, 2)
  assert.deepEqual(durable.orchestration.collaboration.handoffs.map(handoff => (
    handoff.destination.role
  )), ['primary', 'reviewer', 'arbiter'])
  assert.equal(durable.orchestration.collaboration.entries.some(entry => (
    entry.entryType === 'conflict'
  )), true)
})

test('unlimited automatic discussion continues past a finite cap until consensus', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const firstCallEntered = deferred()
  const firstCallGate = deferred()
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (calls.length === 1) {
      firstCallEntered.resolve()
      await firstCallGate.promise
    }
    const agreed = calls.length > 2
    return {
      text: `${agent.kind} response\n[[MELDWORK_CONSENSUS:${agreed ? 'agree' : 'continue'}]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '不限轮次讨论', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  const started = await workspace.sendMessage({
    groupId: group.id,
    text: '讨论到达成共识',
    mode: 'auto',
    maxRounds: 1,
    unlimitedRounds: true,
  })
  await firstCallEntered.promise

  const active = workspace.snapshot().runs[0]
  assert.deepEqual(started, {
    started: true,
    maxRounds: 0,
    threadRootId: active.threadRootId,
    unlimitedRounds: true,
  })
  assert.equal(active.currentRound, 1)
  assert.equal(active.maxRounds, 0)
  assert.equal(active.unlimitedRounds, true)

  const pending = workspace.activeRuns.get(group.id).promise
  firstCallGate.resolve()
  await pending

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes', 'codex', 'hermes'])
  assert.equal(finished[0].status, 'completed')
  assert.equal(workspace.snapshot().messages.some(message => (
    message.system?.key === 'system.autoRoundLimit'
  )), false)
})

test('unlimited automatic discussion gives every Agent an adversarial review contract', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: `${agent.kind} agrees\n[[MELDWORK_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '严格互审', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: '审核这项方案',
    mode: 'auto',
    targetKinds: ['codex', 'hermes'],
    unlimitedRounds: true,
  })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), [
    'codex', 'hermes', 'codex', 'hermes',
  ])
  for (const call of calls) {
    assert.match(call.prompt, /MELDWORK_UNLIMITED_REVIEW_V1/)
    assert.match(call.prompt, /Do not accept another Agent's claim without independent support/)
    assert.match(call.prompt, /Complete at least one full cross-review pass before declaring consensus/)
    assert.match(call.prompt, /Raise every material defect immediately/)
    assert.match(call.prompt, /Do not reveal private chain-of-thought/)
  }
})

test('V4 unlimited discussion activates only the next Agent in later rounds', async (t) => {
  const { directory, calls, options } = fixture()
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const secondRoundChallenge = deferred()
  const releaseSecondRound = deferred()
  let workspace = null
  let group = null
  let controller = null
  t.after(async () => {
    releaseSecondRound.resolve()
    if (workspace && group && controller && workspace.activeRuns.has(group.id)) {
      workspace.stop(group.id, controller.runId)
      try { await controller.promise } catch {}
    }
    fs.rmSync(directory, { recursive: true, force: true })
  })
  options.runLedger = new RunLedger({ storagePath: ledgerPath })
  let challengeCalls = 0
  const challengeOperationIds = [new Map(), new Map()]
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    if (phase === 'challenge') {
      challengeCalls += 1
      const challengeRound = challengeCalls <= 3 ? 0 : 1
      challengeOperationIds[challengeRound].set(agent.kind, runOptions.operationId)
      if (challengeCalls > 3) {
        if (challengeCalls === 4) secondRoundChallenge.resolve()
        await releaseSecondRound.promise
      }
    }
    const collaboration = phase === 'proposal'
      ? v4ProposalCollaboration(agent.kind)
      : phase === 'challenge'
        ? { version: 1, phase, verdict: 'support', summary: `${agent.kind} review` }
        : phase === 'synthesis'
          ? { version: 1, phase, summary: 'Candidate', resolvedIssueIds: [] }
          : {
              version: 1,
              phase,
              verdict: 'contradict',
              summary: 'One issue remains',
            }
    return {
      text: phase === 'synthesis' ? 'Candidate' : `${agent.kind} ${phase}`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
      collaboration,
    }
  }
  workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  group = workspace.createGroup({
    name: 'V4 round transition',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: false,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Continue reviewing until the issue is resolved.',
    mode: 'auto',
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    unlimitedRounds: true,
    protocol: 'v4',
  })
  controller = workspace.activeRuns.get(group.id)
  let timeout = null
  const transition = await Promise.race([
    secondRoundChallenge.promise.then(() => 'second-round'),
    controller.promise.then(
      () => 'finished',
      error => error?.code || error?.message || 'failed',
    ),
    new Promise(resolve => {
      timeout = setTimeout(() => resolve('timeout'), 5000)
      timeout.unref?.()
    }),
  ])
  clearTimeout(timeout)

  assert.equal(transition, 'second-round')
  const intermediate = new RunLedger({ storagePath: ledgerPath }).get(controller.runId)
  assert.equal(intermediate.currentRound, 3)
  assert.equal(intermediate.unlimitedRounds, true)
  assert.equal(intermediate.maxRounds, 0)
  assert.equal(intermediate.orchestration.phase, 'challenge')
  assert.equal(intermediate.orchestration.round, 3)
  assert.equal(intermediate.orchestration.currentKind, '')
  assert.deepEqual(intermediate.orchestration.currentKinds, ['codex'])
  assert.deepEqual(intermediate.orchestration.pendingKinds, ['codex'])
  assert.deepEqual(intermediate.orchestration.activeKinds, controller.targetKinds)
  assert.deepEqual(intermediate.orchestration.successfulKinds, [])
  assert.equal(intermediate.orchestration.totalSuccesses, 0)
  for (const slot of intermediate.orchestration.slots) {
    const firstOperationId = challengeOperationIds[0].get(slot.agentKind)
    const secondOperationId = challengeOperationIds[1].get(slot.agentKind)
    const expectedOperationId = `operation-${createHash('sha256').update(JSON.stringify([
      controller.runId,
      controller.taskId,
      slot.agentKind,
      slot.slotId,
      'challenge',
      3,
    ])).digest('hex')}`
    const assignment = intermediate.orchestration.plan.assignments.find(item => (
      item.agentKind === slot.agentKind
    ))
    assert.equal(slot.phase, 'challenge')
    assert.equal(slot.status, slot.agentKind === 'codex' ? 'running' : 'planned')
    if (slot.agentKind === 'codex') assert.equal(slot.finishedAt, null)
    else assert.equal(Number.isFinite(slot.finishedAt), true)
    assert.equal(slot.commitStatus, 'pending')
    assert.equal(slot.permission, 'read-only')
    assert.equal(slot.attempt, slot.agentKind === 'codex' ? 3 : 2)
    assert.equal(
      slot.deliveryWatermark,
      2,
      'delivery watermark advances only after an accepted result',
    )
    assert.equal(slot.operationId, expectedOperationId)
    if (secondOperationId) assert.equal(slot.operationId, secondOperationId)
    assert.notEqual(slot.operationId, firstOperationId)
    assert.equal(assignment.role, 'participant')
    assert.equal(assignment.operationId, slot.operationId)
  }
  assert.equal(workspace.stop(group.id, controller.runId), true)
  releaseSecondRound.resolve()
  await controller.promise
  assert.equal(new RunLedger({ storagePath: ledgerPath }).get(controller.runId).status, 'stopped')
})

test('V4 unlimited discussion requires two stable review rounds before completion', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  const targetKinds = ['codex', 'hermes']
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    calls.push({ kind: agent.kind, phase, prompt, runOptions })
    return {
      text: phase === 'synthesis' ? 'Stable reviewed candidate.' : `${agent.kind} ${phase}`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-${phase}`,
      collaboration: agreedV4Collaboration(agent.kind, phase, prompt, targetKinds),
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'V4 unlimited stable review', agentKinds: targetKinds, workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Review the candidate until the conclusion is stable.',
    mode: 'auto',
    targetKinds,
    unlimitedRounds: true,
    protocol: 'v4',
  })
  const controller = workspace.activeRuns.get(group.id)
  await controller.promise

  const phases = calls.map(call => call.phase)
  assert.equal(phases.filter(phase => phase === 'synthesis').length, 2)
  assert.equal(phases.filter(phase => phase === 'verification').length, 2)
  const durable = ledger.get(controller.runId)
  assert.equal(durable.status, 'completed')
  assert.equal(durable.currentRound, 3)
  assert.equal(durable.orchestration.convergence.consecutiveStableRounds, 2)
})

test('V4 bounded discussion completes the requested rounds before accepting consensus', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  const targetKinds = ['codex', 'hermes']
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    calls.push({ kind: agent.kind, phase, prompt, runOptions })
    return {
      text: phase === 'synthesis' ? 'Stable reviewed candidate.' : `${agent.kind} ${phase}`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-${phase}`,
      collaboration: agreedV4Collaboration(agent.kind, phase, prompt, targetKinds),
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'V4 bounded full rounds', agentKinds: targetKinds, workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Discuss for four complete rounds before accepting consensus.',
    mode: 'auto',
    targetKinds,
    maxRounds: 4,
    protocol: 'v4',
  })
  const controller = workspace.activeRuns.get(group.id)
  await controller.promise

  const phases = calls.map(call => call.phase)
  assert.equal(phases.filter(phase => phase === 'proposal').length, 2)
  assert.equal(phases.filter(phase => phase === 'synthesis').length, 3)
  assert.equal(phases.filter(phase => phase === 'verification').length, 3)
  const durable = ledger.get(controller.runId)
  assert.equal(durable.status, 'completed')
  assert.equal(durable.currentRound, 4)
})

test('V4 consensus requires verification from every non-finalizer Agent', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  const targetKinds = ['codex', 'hermes', 'workbuddy', 'kimi']
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    calls.push({ kind: agent.kind, phase, prompt, runOptions })
    const collaboration = agreedV4Collaboration(agent.kind, phase, prompt, targetKinds)
    if (phase === 'challenge') {
      collaboration.verifierKinds = targetKinds.filter(kind => kind !== targetKinds.at(-1))
    }
    return {
      text: phase === 'synthesis' ? 'Candidate accepted by the whole group.' : `${agent.kind} ${phase}`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-${phase}`,
      collaboration,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'V4 whole-group consensus', agentKinds: targetKinds, workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Reach explicit agreement across the whole group.',
    mode: 'auto',
    targetKinds,
    maxRounds: 2,
    protocol: 'v4',
  })
  const controller = workspace.activeRuns.get(group.id)
  await controller.promise

  assert.deepEqual(
    calls.filter(call => call.phase === 'verification').map(call => call.kind),
    ['codex', 'hermes', 'workbuddy'],
  )
  assert.equal(ledger.get(controller.runId).status, 'completed')
})

test('V4 later-round verification activates Agents serially', async (t) => {
  const { directory, calls, options } = fixture()
  const firstVerificationStarted = deferred()
  const secondVerificationStarted = deferred()
  const releaseFirstVerification = deferred()
  let workspace = null
  let group = null
  let controller = null
  t.after(async () => {
    releaseFirstVerification.resolve()
    if (workspace && group && controller && workspace.activeRuns.has(group.id)) {
      workspace.stop(group.id, controller.runId)
      try { await controller.promise } catch {}
    }
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const targetKinds = ['codex', 'hermes', 'workbuddy']
  options.runScheduler = new RunScheduler({ taskLimit: 4, workspaceLimit: 4, globalLimit: 4 })
  let verificationCalls = 0
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    calls.push({ kind: agent.kind, phase, prompt, runOptions })
    if (phase === 'verification') {
      verificationCalls += 1
      if (verificationCalls === 1) {
        firstVerificationStarted.resolve()
        await releaseFirstVerification.promise
      } else if (verificationCalls === 2) {
        secondVerificationStarted.resolve()
      }
    }
    return {
      text: phase === 'synthesis' ? 'Serially reviewed candidate.' : `${agent.kind} ${phase}`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-${phase}`,
      collaboration: agreedV4Collaboration(agent.kind, phase, prompt, targetKinds),
    }
  }
  workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  group = workspace.createGroup({
    name: 'V4 serial verification', agentKinds: targetKinds, workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Review the shared candidate one Agent at a time.',
    mode: 'auto',
    targetKinds,
    maxRounds: 2,
    protocol: 'v4',
  })
  controller = workspace.activeRuns.get(group.id)
  await firstVerificationStarted.promise
  const earlySecond = await Promise.race([
    secondVerificationStarted.promise.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 100)),
  ])
  assert.equal(earlySecond, false)
  releaseFirstVerification.resolve()
  await controller.promise
  assert.deepEqual(
    calls.filter(call => call.phase === 'verification').map(call => call.kind),
    ['codex', 'hermes'],
  )
})

test('V4 Auto creates deterministic mutual and rotating challenge bindings for 2 and 3 Agents', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()

  const mutual = workspace.autoRunner.v4ChallengeBindings(
    challengeBindingInput(workspace, ['codex', 'hermes'], 2),
  )
  assert.deepEqual(mutual.map(binding => [binding.reviewerKind, binding.proposalKind]), [
    ['codex', 'hermes'],
    ['hermes', 'codex'],
  ])
  assert.equal(mutual.every(binding => binding.reviewerKind !== binding.proposalKind), true)
  assert.deepEqual(mutual[0].artifactIds, ['artifact-hermes-1', 'artifact-hermes-2'])
  assert.deepEqual(mutual[0].evidenceIds, ['evidence-hermes-1', 'evidence-hermes-2'])

  const kinds = ['workbuddy', 'codex', 'hermes']
  const rounds = [2, 3].map(round => workspace.autoRunner.v4ChallengeBindings(
    challengeBindingInput(workspace, kinds, round, 'c'.repeat(64), `run-${round}`),
  ))
  for (const bindings of rounds) {
    assert.deepEqual(new Set(bindings.map(binding => binding.reviewerKind)), new Set(kinds))
    assert.deepEqual(new Set(bindings.map(binding => binding.proposalKind)), new Set(kinds))
    assert.equal(bindings.every(binding => binding.reviewerKind !== binding.proposalKind), true)
  }
  for (const reviewerKind of kinds) {
    assert.equal(new Set(rounds.map(bindings => (
      bindings.find(binding => binding.reviewerKind === reviewerKind).proposalKind
    ))).size, 2)
  }
  const repeated = workspace.autoRunner.v4ChallengeBindings(
    challengeBindingInput(workspace, [...kinds].reverse(), 2, 'c'.repeat(64), 'other-run'),
  )
  assert.deepEqual(
    Object.fromEntries(repeated.map(binding => [binding.reviewerKind, binding.proposalKind])),
    Object.fromEntries(rounds[0].map(binding => [binding.reviewerKind, binding.proposalKind])),
  )
})

test('V4 Auto retains a 32-Agent challenge-binding derangement without duplicates', async (t) => {
  const { directory, options } = fixture()
  const kinds = Array.from({ length: 32 }, (_value, index) => (
    `custom-${(index + 1).toString(16).padStart(16, '0')}`
  ))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.detectAgents = async () => kinds.map((kind, index) => ({
    kind, name: `Agent ${index + 1}`, executable: `/tmp/${kind}`, version: '1',
  }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()

  const bindings = workspace.autoRunner.v4ChallengeBindings(
    challengeBindingInput(workspace, kinds, 2, 'd'.repeat(64)),
  )
  assert.equal(bindings.length, 32)
  assert.deepEqual(new Set(bindings.map(binding => binding.reviewerKind)), new Set(kinds))
  assert.deepEqual(new Set(bindings.map(binding => binding.proposalKind)), new Set(kinds))
  assert.equal(bindings.every(binding => binding.reviewerKind !== binding.proposalKind), true)
})

test('V4 Auto bounds five-Agent long-output delivery and sends only acknowledged deltas', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  const targetKinds = ['agent-1', 'agent-2', 'agent-3', 'agent-4', 'agent-5']
  const snapshotHash = 'a'.repeat(64)
  const longOutputs = new Map(targetKinds.map((agentKind, index) => {
    const marker = `FULL_BODY_ONLY_${agentKind}_`
    return [agentKind, `${marker}${'x'.repeat(3000 + (index * 700) - marker.length)}`]
  }))
  assert.equal([...longOutputs.values()].every(output => (
    output.length >= 3000 && output.length <= 6000
  )), true)
  const receiptRecords = targetKinds.flatMap(agentKind => (
    ['proposal', 'challenge'].map((phase, phaseIndex) => ({
      receipt: createCollaborationReceipt({
        phase,
        agentKind,
        slotId: `slot-${agentKind}`,
        operationId: `operation-${phase}-${agentKind}`,
        status: 'completed',
        summary: `${agentKind} ${phase} ${'summary '.repeat(80)}`,
        conclusion: '',
        artifactIds: [`artifact-${createHash('sha256').update(
          `${phase}:${longOutputs.get(agentKind)}`,
        ).digest('hex')}`],
        evidenceIds: [`evidence-${phase}-${agentKind}`],
        snapshotHash,
        deliveryWatermark: phaseIndex + 1,
      }),
    }))
  ))
  const sessionBinding = {
    sessionRefHash: 'b'.repeat(64),
    sessionProvenanceHash: 'c'.repeat(64),
  }

  const full = workspace.autoRunner.v4Package(receiptRecords, {
    targetKinds,
    recipientKind: 'agent-1',
    sessionBinding,
    forceFull: true,
  })
  assert.equal(full.receipts.length, targetKinds.length)
  assert.ok(full.text.length <= 6000)
  assert.doesNotMatch(full.text, /FULL_BODY_ONLY_/)

  const deliveryState = full.receipts.map(receipt => ({
    recipientKind: 'agent-1',
    ...sessionBinding,
    sourceAgentKind: receipt.agentKind,
    sourcePhase: receipt.phase,
    watermark: receipt.deliveryWatermark,
    status: 'acknowledged',
  }))
  const unchanged = workspace.autoRunner.v4Package(receiptRecords, {
    targetKinds,
    recipientKind: 'agent-1',
    sessionBinding,
    deliveryState,
  })
  assert.equal(unchanged.receipts.length, 0)

  const changed = createCollaborationReceipt({
    phase: 'challenge',
    agentKind: 'agent-3',
    slotId: 'slot-agent-3',
    operationId: 'operation-challenge-agent-3-revised',
    status: 'completed',
    summary: `agent-3 revised ${'summary '.repeat(80)}`,
    conclusion: '',
    artifactIds: [`artifact-${createHash('sha256').update(
      `revised:${longOutputs.get('agent-3')}`,
    ).digest('hex')}`],
    evidenceIds: ['evidence-challenge-agent-3-revised'],
    snapshotHash,
    deliveryWatermark: 3,
  })
  const delta = workspace.autoRunner.v4Package([...receiptRecords, { receipt: changed }], {
    targetKinds,
    recipientKind: 'agent-1',
    sessionBinding,
    deliveryState,
  })
  assert.deepEqual(delta.receipts.map(receipt => receipt.agentKind), ['agent-3'])
  assert.ok(delta.text.length <= 6000)

  const rotated = workspace.autoRunner.v4Package([...receiptRecords, { receipt: changed }], {
    targetKinds,
    recipientKind: 'agent-1',
    sessionBinding,
    deliveryState,
    forceFull: true,
  })
  assert.equal(rotated.receipts.length, targetKinds.length)
  assert.ok(rotated.text.length <= 6000)
})

test('V4 package reconciles durable issue resolutions for full and delta delivery', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  const targetKinds = ['codex', 'hermes']
  const snapshotHash = 'a'.repeat(64)
  const staleSnapshotHash = '0'.repeat(64)
  const staleResolutionReceipt = createCollaborationReceipt({
    phase: 'synthesis', agentKind: 'hermes', slotId: 'slot-hermes',
    operationId: 'operation-hermes-stale-synthesis', status: 'completed',
    summary: 'A prior snapshot resolved issue 2.', artifactIds: ['artifact-hermes-stale'],
    evidenceIds: ['evidence-hermes-stale'], snapshotHash: staleSnapshotHash,
    deliveryWatermark: 0,
  })
  const issueReceipt = createCollaborationReceipt({
    phase: 'challenge', agentKind: 'hermes', slotId: 'slot-hermes',
    operationId: 'operation-hermes-challenge', status: 'completed',
    summary: 'Hermes identified two issues.', artifactIds: ['artifact-hermes'],
    evidenceIds: ['evidence-hermes'], snapshotHash, deliveryWatermark: 1,
    unresolved: [
      { id: 'issue-1', summary: 'Resolved issue must not be delivered.', refs: [] },
      { id: 'issue-2', summary: 'Open issue must remain visible.', refs: [] },
    ],
  })
  const resolutionReceipt = createCollaborationReceipt({
    phase: 'synthesis', agentKind: 'codex', slotId: 'slot-codex',
    operationId: 'operation-codex-synthesis', status: 'completed',
    summary: 'Codex resolved issue 1.', artifactIds: ['artifact-codex'],
    evidenceIds: ['evidence-codex'], snapshotHash, deliveryWatermark: 2,
  })
  const followupReceipt = createCollaborationReceipt({
    phase: 'synthesis', agentKind: 'codex', slotId: 'slot-codex',
    operationId: 'operation-codex-synthesis-followup', status: 'completed',
    summary: 'Codex follow-up retained the prior resolution.',
    artifactIds: ['artifact-codex-followup'], evidenceIds: ['evidence-codex-followup'],
    snapshotHash, deliveryWatermark: 3,
  })
  const receiptRecords = [
    { receipt: staleResolutionReceipt, resolvedIssueIds: ['issue-2'] },
    { receipt: issueReceipt, resolvedIssueIds: [] },
    { receipt: resolutionReceipt, resolvedIssueIds: ['issue-1'] },
    { receipt: followupReceipt, resolvedIssueIds: [] },
  ]
  const sessionBinding = {
    sessionRefHash: 'b'.repeat(64),
    sessionProvenanceHash: 'c'.repeat(64),
  }
  const render = deliveryState => workspace.autoRunner.v4Package(receiptRecords, {
    recipientKind: 'codex', sessionBinding, deliveryState, targetKinds, snapshotHash,
  })

  const full = render([])
  assert.ok(full.text.length <= 6000)
  assert.doesNotMatch(full.text, /Unresolved: issue-1\b/)
  assert.match(full.text, /Unresolved: issue-2\b/)

  const delta = render([{
    recipientKind: 'codex', ...sessionBinding,
    sourceAgentKind: 'codex', sourcePhase: 'synthesis', watermark: 3,
    status: 'acknowledged',
  }])
  assert.deepEqual(delta.receipts.map(receipt => receipt.agentKind), ['hermes'])
  assert.ok(delta.text.length <= 6000)
  assert.doesNotMatch(delta.text, /Unresolved: issue-1\b/)
  assert.match(delta.text, /Unresolved: issue-2\b/)
  assert.deepEqual(issueReceipt.unresolved.map(issue => issue.id), ['issue-1', 'issue-2'])
})

test('V4 delivery isolates five-Agent three-wave acknowledgement by native Session and Run', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  const targetKinds = ['codex', 'hermes', 'workbuddy', 'kimi', 'openclaw']
  const sessionA = {
    sessionRefHash: 'a'.repeat(64),
    sessionProvenanceHash: 'b'.repeat(64),
  }
  const rotatedSessionA = {
    sessionRefHash: 'c'.repeat(64),
    sessionProvenanceHash: 'd'.repeat(64),
  }
  const sessionB = {
    sessionRefHash: 'e'.repeat(64),
    sessionProvenanceHash: 'f'.repeat(64),
  }
  let deliveryStateA = []
  let deliveryStateB = []
  let receiptRecords = []
  const acknowledged = (state, recipientKind, binding, packageRecord) => [
    ...state.filter(entry => !packageRecord.receipts.some(receipt => (
      entry.recipientKind === recipientKind
        && entry.sessionRefHash === binding.sessionRefHash
        && entry.sessionProvenanceHash === binding.sessionProvenanceHash
        && entry.sourceAgentKind === receipt.agentKind
        && entry.sourcePhase === receipt.phase
    ))),
    ...packageRecord.receipts.map(receipt => ({
      recipientKind,
      ...binding,
      sourceAgentKind: receipt.agentKind,
      sourcePhase: receipt.phase,
      watermark: receipt.deliveryWatermark,
      status: 'acknowledged',
    })),
  ]
  const packageFor = (recipientKind, binding, deliveryState, forceFull = false) => (
    workspace.autoRunner.v4Package(receiptRecords, {
      recipientKind,
      sessionBinding: binding,
      deliveryState,
      targetKinds,
      forceFull,
    })
  )

  for (let wave = 1; wave <= 3; wave += 1) {
    const outputs = targetKinds.map((agentKind, index) => {
      const marker = `RAW_WAVE_${wave}_${agentKind}_ONLY_`
      return `${marker}${'x'.repeat(3000 + (index * 500) - marker.length)}`
    })
    assert.equal(outputs.every(output => output.length >= 3000 && output.length <= 6000), true)
    receiptRecords = receiptRecords.concat(targetKinds.map((agentKind, index) => ({
      output: outputs[index],
      receipt: createCollaborationReceipt({
        phase: 'proposal', agentKind, slotId: `slot-${agentKind}`,
        operationId: `operation-wave-${wave}-${agentKind}`,
        status: 'completed',
        summary: `wave ${wave} ${agentKind} ${'summary '.repeat(80)}`,
        conclusion: `WAVE_${wave}_${agentKind}_LATEST ${'conclusion '.repeat(60)}`,
        artifactIds: [`artifact-${wave}-${agentKind}`],
        evidenceIds: [`evidence-${wave}-${agentKind}`],
        snapshotHash: '9'.repeat(64),
        deliveryWatermark: wave,
      }),
    })))

    const bindingA = wave === 1 ? sessionA : rotatedSessionA
    const packageA = packageFor('codex', bindingA, deliveryStateA, wave <= 2)
    const packageB = packageFor('hermes', sessionB, deliveryStateB, wave === 1)
    for (const packageRecord of [packageA, packageB]) {
      assert.equal(packageRecord.receipts.length, targetKinds.length)
      assert.ok(packageRecord.text.length <= 6000)
      assert.doesNotMatch(packageRecord.text, /RAW_WAVE_\d+_.*_ONLY_/)
      for (const agentKind of targetKinds) {
        assert.match(packageRecord.text, new RegExp(`WAVE_${wave}_${agentKind}_LATEST`))
      }
      if (wave > 1) assert.doesNotMatch(packageRecord.text, new RegExp(`WAVE_${wave - 1}_`))
    }
    deliveryStateA = acknowledged(deliveryStateA, 'codex', bindingA, packageA)
    deliveryStateB = acknowledged(deliveryStateB, 'hermes', sessionB, packageB)

    const acknowledgedA = packageFor('codex', bindingA, deliveryStateA)
    const acknowledgedB = packageFor('hermes', sessionB, deliveryStateB)
    assert.equal(acknowledgedA.receipts.length, 0)
    assert.equal(acknowledgedB.receipts.length, 0)
  }

  const restartedStateA = JSON.parse(JSON.stringify(deliveryStateA))
  assert.equal(packageFor('codex', rotatedSessionA, restartedStateA).receipts.length, 0)

  const runBState = []
  assert.equal(packageFor('codex', rotatedSessionA, deliveryStateA).receipts.length, 0)
  assert.equal(packageFor('codex', rotatedSessionA, runBState).receipts.length, targetKinds.length)

  const uncertainStateB = deliveryStateB.map(entry => (
    entry.sourceAgentKind === 'kimi'
      ? { ...entry, status: 'uncertain' }
      : entry
  ))
  const retry = packageFor('hermes', sessionB, uncertainStateB)
  assert.deepEqual(retry.receipts.map(receipt => receipt.agentKind), ['kimi'])
})

test('V4 invocation boundary resumes delta delivery from durable acknowledgement after restart', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger-delivery.json')
  const ledger = new RunLedger({ storagePath: ledgerPath })
  let activeLedger = ledger
  options.runLedger = ledger
  const targetKinds = ['codex', 'hermes', 'workbuddy', 'kimi', 'openclaw']
  const runsByTag = new Map()
  const sessionGenerations = new Map()
  const calls = []
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const tag = prompt.includes('DELIVERY_RUN_B') ? 'B' : 'A'
    const run = runsByTag.get(tag)
    const attempt = prompt.match(/^Delivery attempt: ([A-Za-z0-9._:-]+)$/m)?.[1] || ''
    const durable = activeLedger.get(run.controller.runId)
    const prepared = durable.orchestration.deliveryState || []
    assert.ok(prepared.some(entry => (
      entry.recipientKind === agent.kind && entry.status === 'prepared'
    )))
    assert.equal(prepared.every(entry => entry.recipientKind === agent.kind), true)
    calls.push({ tag, attempt, prompt, sessionRef: runOptions.sessionRef })
    const sessionKey = `${tag}:${agent.kind}`
    const generation = runOptions.sessionRef
      ? sessionGenerations.get(sessionKey) || 1
      : (sessionGenerations.get(sessionKey) || 0) + 1
    sessionGenerations.set(sessionKey, generation)
    return {
      text: `${tag} ${attempt} ${'output '.repeat(500)}`,
      sessionRef: runOptions.sessionRef || `${tag}-${agent.kind}-native-${generation}`,
      collaboration: {
        version: 1, phase: 'verification', verdict: 'support',
        summary: `${tag} ${attempt} verified`,
      },
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()

  const beginDeliveryRun = (tag) => {
    const group = workspace.createGroup({
      name: `Delivery ${tag}`, agentKinds: targetKinds, workdir: directory,
    })
    const task = workspace.addMessage(group.id, 'user', `DELIVERY_RUN_${tag}`)
    const contextPack = workspace.createContextPack({
      group, taskId: task.id, mode: 'manual', targetKinds, message: task,
    })
    const reservation = workspace.reserveRun(group.id, 'manual', targetKinds, task.id)
    workspace.bindRunTask(
      group.id, reservation, task.id, task.id, contextPack.contextPackId,
    )
    const controller = workspace.beginRun(
      group.id, 'manual', targetKinds, task.id, reservation,
    )
    controller.orchestration = createOrchestrationV4({
      workflow: 'manual', template: 'concurrent-batch', targetKinds,
    }, { targetKinds, now: Date.now() })
    workspace.checkpointRun(group.id, controller)
    const run = { tag, group, task, contextPack, controller }
    runsByTag.set(tag, run)
    return run
  }
  const runA = beginDeliveryRun('A')
  const runB = beginDeliveryRun('B')
  assert.notEqual(runA.controller.runId, runB.controller.runId)

  const receiptsFor = (run, wave) => targetKinds.map((agentKind, index) => ({
    receipt: createCollaborationReceipt({
      phase: 'proposal', agentKind, slotId: `slot-${agentKind}`,
      operationId: `operation-${run.tag}-${wave}-${agentKind}`,
      status: 'completed',
      summary: `${run.tag} WAVE_${wave}_${agentKind}_LATEST ${'summary '.repeat(70)}`,
      artifactIds: [`artifact-${run.tag}-${wave}-${agentKind}`],
      evidenceIds: [`evidence-${run.tag}-${wave}-${agentKind}`],
      snapshotHash: run.controller.orchestration.snapshotHash,
      deliveryWatermark: wave,
    }),
    resolvedIssueIds: [],
  }))
  const deliver = async (activeWorkspace, run, receiptRecords, attempt) => {
    let preparedDelivery = null
    const slot = {
      slotId: `slot-recipient-${run.tag}`,
      operationId: `operation-recipient-${run.tag}-${attempt}`,
    }
    try {
      const result = await activeWorkspace.invokeAgent(
        run.group, 'codex', 'manual', run.controller.signal, run.task.id,
        {
          taskId: run.task.id,
          v4: true,
          phase: 'verification',
          sessionPolicy: 'frozen',
          promptOverride: `Delivery attempt: ${attempt}`,
          contextPackId: run.contextPack.contextPackId,
          snapshotSourceMessageIds: [run.task.id],
          snapshotSourceEntries: [],
          deferMessage: true,
          operationId: slot.operationId,
          v4PromptBuilder: (sessionBinding) => {
            const built = activeWorkspace.autoRunner.v4DeliveryPrompt(run.group, run.controller, {
              kind: 'codex', phase: 'verification',
              snapshot: {
                taskText: `DELIVERY_RUN_${run.tag}\nDelivery attempt: ${attempt}`,
                group: { name: run.group.name, topic: '' }, history: [],
              },
              receiptRecords,
              role: 'verifier',
              targetKinds,
              slot,
              options: { extraContext: `Delivery attempt: ${attempt}` },
              sessionBinding,
            })
            preparedDelivery = built.delivery
            return built
          },
        },
      )
      if (result.v4Delivery) {
        activeWorkspace.autoRunner.v4SetDeliveryStatus(
          run.group, run.controller, result.v4Delivery, 'acknowledged',
          result.v4SessionBinding,
        )
      }
      return { result, preparedDelivery }
    } catch (error) {
      if (preparedDelivery) {
        activeWorkspace.autoRunner.v4SetDeliveryStatus(
          run.group, run.controller, preparedDelivery, 'uncertain',
        )
      }
      return { error, preparedDelivery }
    }
  }

  const [firstA, firstB] = await Promise.all([
    deliver(workspace, runA, receiptsFor(runA, 1), 'wave-1'),
    deliver(workspace, runB, receiptsFor(runB, 1), 'wave-1'),
  ])
  assert.ok(firstA.result && firstB.result)
  assert.deepEqual(calls.filter(call => call.attempt === 'wave-1').map(call => call.sessionRef), ['', ''])
  const durableA = ledger.get(runA.controller.runId).orchestration.deliveryState
  const durableB = ledger.get(runB.controller.runId).orchestration.deliveryState
  assert.equal(durableA.every(entry => entry.status === 'acknowledged'), true)
  assert.equal(durableB.every(entry => entry.status === 'acknowledged'), true)
  assert.equal(new Set(durableA.map(entry => entry.packageHash)).size, 1)
  assert.equal(new Set(durableB.map(entry => entry.packageHash)).size, 1)
  assert.notEqual(durableA[0].packageHash, durableB[0].packageHash)

  const secondA = await deliver(workspace, runA, receiptsFor(runA, 2), 'wave-2')
  assert.ok(secondA.result)
  assert.equal(calls.find(call => call.tag === 'A' && call.attempt === 'wave-2').sessionRef,
    'A-codex-native-1')
  const sessionKeyA = workspace.sessionKey(runA.group.id, 'codex')
  workspace.state.sessionMeta[sessionKeyA] = {
    ...workspace.state.sessionMeta[sessionKeyA],
    turns: 1000,
    estimatedChars: 1000000,
  }
  workspace.save()
  const rotatedA = await deliver(workspace, runA, receiptsFor(runA, 3), 'wave-3-rotated')
  assert.ok(rotatedA.result)
  assert.equal(
    calls.find(call => call.tag === 'A' && call.attempt === 'wave-3-rotated').sessionRef,
    'A-codex-native-1',
  )
  assert.equal(workspace.state.sessions[sessionKeyA], 'A-codex-native-1')

  const durableAAtRestart = ledger.get(runA.controller.runId)
  const durableBAtRestart = ledger.get(runB.controller.runId)
  assert.equal(durableAAtRestart.status, 'running')
  assert.equal(durableBAtRestart.status, 'running')
  const restartedLedger = new RunLedger({ storagePath: ledgerPath })
  const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
  await restarted.refreshAgents()
  activeLedger = restartedLedger
  const recoveredController = restarted.createRunController(
    durableAAtRestart.mode,
    durableAAtRestart.targetKinds,
    durableAAtRestart.threadRootId,
    durableAAtRestart.maxRounds,
    durableAAtRestart.unlimitedRounds,
  )
  recoveredController.runId = durableAAtRestart.runId
  recoveredController.taskId = durableAAtRestart.taskId
  recoveredController.contextPackId = durableAAtRestart.contextPackId
  recoveredController.taskBound = true
  recoveredController.groupId = durableAAtRestart.groupId
  recoveredController.currentRound = durableAAtRestart.currentRound
  recoveredController.orchestration = structuredClone(durableAAtRestart.orchestration)
  recoveredController.v4 = true
  const recoveredRunA = {
    tag: 'A',
    group: restarted.getGroup(durableAAtRestart.groupId),
    task: restarted.snapshot().messages.find(message => message.id === durableAAtRestart.taskId),
    contextPack: { contextPackId: durableAAtRestart.contextPackId },
    controller: recoveredController,
  }
  restarted.activeRuns.set(recoveredRunA.group.id, recoveredController)
  runsByTag.set('A', recoveredRunA)

  const postRestartReceipts = [
    ...receiptsFor(recoveredRunA, 3),
    ...receiptsFor(recoveredRunA, 4).filter(record => record.receipt.agentKind === 'kimi'),
  ]
  const postRestart = await deliver(
    restarted, recoveredRunA, postRestartReceipts, 'post-restart-delta',
  )
  assert.ok(postRestart.result)
  assert.deepEqual(postRestart.preparedDelivery.entries.map(entry => ({
    sourceAgentKind: entry.sourceAgentKind,
    watermark: entry.watermark,
  })), [{ sourceAgentKind: 'kimi', watermark: 4 }])
  const postRestartCall = calls.find(call => call.attempt === 'post-restart-delta')
  assert.equal(postRestartCall.sessionRef, 'A-codex-native-1')
  assert.match(postRestartCall.prompt, /A WAVE_4_kimi_LATEST/)
  assert.doesNotMatch(postRestartCall.prompt, /A WAVE_3_/)
  assert.deepEqual(
    restartedLedger.get(runB.controller.runId).orchestration.deliveryState,
    durableBAtRestart.orchestration.deliveryState,
  )
  assert.deepEqual(
    restartedLedger.get(recoveredController.runId).orchestration.deliveryState
      .filter(entry => entry.sourceAgentKind === 'kimi'
        && entry.sessionRefHash === postRestart.result.v4SessionBinding.sessionRefHash
        && entry.sessionProvenanceHash
          === postRestart.result.v4SessionBinding.sessionProvenanceHash)
      .map(entry => ({ watermark: entry.watermark, status: entry.status })),
    [{ watermark: 4, status: 'acknowledged' }],
  )
  assert.equal(restarted.state.sessions[sessionKeyA], 'A-codex-native-1')
  restarted.activeRuns.delete(recoveredRunA.group.id)
})

test('V4 production callback keeps a newer acknowledgement after a late failed settlement', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const oldStarted = deferred()
  const releaseOldFailure = deferred()
  const retryStarted = deferred()
  let invocationCount = 0
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    invocationCount += 1
    if (invocationCount === 1) {
      oldStarted.resolve()
      await releaseOldFailure.promise
      throw agentRuntimeError('LOCAL_AGENT_AUTH_REQUIRED', 'HTTP 401: expired test token')
    }
    retryStarted.resolve()
    return {
      text: 'Retry challenge completed.',
      sessionRef: runOptions.sessionRef || 'codex-retry-session',
      outcomeRefs: {
        artifactIds: ['artifact-codex-retry'],
        evidenceIds: ['evidence-codex-retry'],
      },
      collaboration: agreedV4Collaboration(
        agent.kind, 'challenge', prompt, ['codex', 'hermes'],
      ),
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const targetKinds = ['codex', 'hermes']
  const group = workspace.createGroup({
    name: 'V4 stale delivery', agentKinds: targetKinds, workdir: directory,
  })
  const task = workspace.addMessage(group.id, 'user', 'Exercise the production delivery callback race.')
  const contextPack = workspace.createContextPack({
    group, taskId: task.id, mode: 'auto', targetKinds, message: task,
  })
  const reservation = workspace.reserveRun(group.id, 'auto', targetKinds, task.id, 4, false)
  workspace.bindRunTask(
    group.id, reservation, task.id, task.id, contextPack.contextPackId,
  )
  const controller = workspace.beginRun(
    group.id, 'auto', targetKinds, task.id, reservation, 4, false,
  )
  controller.currentRound = 2
  controller.v4 = true
  controller.orchestration = {}
  const snapshot = v4Snapshot({
    state: workspace.state,
    group,
    taskId: task.id,
    targetKinds,
    message: task,
    skillHintsByKind: new Map(targetKinds.map(kind => [kind, []])),
    phase: 'proposal',
    writerKind: 'hermes',
  })
  const builtSnapshot = workspace.autoRunner.v4SnapshotRecord(
    controller, snapshot, targetKinds,
  )
  const slots = targetKinds.map((agentKind, index) => ({
    slotId: `slot-${index + 1}-${agentKind}`,
    agentKind,
    phase: 'proposal',
    status: 'completed',
    operationId: `operation-proposal-${agentKind}`,
    resultRefs: { artifactIds: [], evidenceIds: [], workflowOutcomeRefs: [] },
  }))
  const proposalArtifactIds = new Map(targetKinds.map((agentKind) => {
    const contentRef = workspace.contentBlobStore.put(
      `${agentKind} concrete proposal body.`, { mediaType: 'text/plain' },
    )
    const artifact = workspace.outcomeStore.putArtifact({
      type: 'document',
      name: `${agentKind}-proposal.txt`,
      producedBy: {
        runId: controller.runId,
        agentRunId: `agent-run-${agentKind}-proposal`,
        agentKind,
      },
      contentRef,
      contentHash: contentRef.hash,
    })
    return [agentKind, artifact.artifactId]
  }))
  const receiptRecords = targetKinds.map((agentKind, index) => ({
    receipt: createCollaborationReceipt({
      phase: 'proposal', agentKind, slotId: slots[index].slotId,
      operationId: slots[index].operationId, status: 'completed',
      summary: `${agentKind} proposal`, artifactIds: [proposalArtifactIds.get(agentKind)],
      evidenceIds: [`evidence-${agentKind}-proposal`],
      snapshotHash: builtSnapshot.snapshotHash, deliveryWatermark: 1,
    }),
    resolvedIssueIds: [],
  }))
  const challengeBindings = workspace.autoRunner.v4ChallengeBindings({
    controller,
    targetKinds,
    round: 2,
    snapshotRecord: builtSnapshot.record,
    slots,
    receiptRecords,
  })
  const context = {
    rootSkillsByKind: new Map(targetKinds.map(kind => [kind, []])),
    rootKnowledgeBasesByKind: new Map(targetKinds.map(kind => [kind, []])),
  }
  const phaseInput = {
    phase: 'challenge',
    activeKinds: ['codex'],
    targetKinds,
    writerKind: 'hermes',
    batchId: 'batch-production-callback-race',
    snapshot,
    snapshotRecord: builtSnapshot.record,
    snapshotHash: builtSnapshot.snapshotHash,
    slots,
    receiptRecords,
    challengeBindings,
  }

  const oldPhase = workspace.autoRunner.runV4Phase(
    group, controller, task.id, context, phaseInput,
  )
  await oldStarted.promise
  const oldDeliveryState = structuredClone(controller.orchestration.deliveryState)
  assert.equal(oldDeliveryState.every(entry => entry.status === 'prepared'), true)
  const oldDeliveryIds = new Set(oldDeliveryState.map(entry => entry.deliveryId))
  while (Date.now() <= Math.max(...oldDeliveryState.map(entry => entry.updatedAt))) {
    await new Promise(resolve => setImmediate(resolve))
  }

  let sharedOrchestration = controller.orchestration
  Object.defineProperty(controller, 'orchestration', {
    configurable: true,
    get: () => sharedOrchestration,
    set: value => { sharedOrchestration = value },
  })
  const retryWorkspace = new LocalWorkspace(options)
  await retryWorkspace.refreshAgents()
  const retryController = retryWorkspace.createRunController(
    'auto', targetKinds, task.id, 4, false,
  )
  retryController.runId = controller.runId
  retryController.taskId = controller.taskId
  retryController.contextPackId = controller.contextPackId
  retryController.taskBound = true
  retryController.groupId = controller.groupId
  retryController.currentRound = controller.currentRound
  retryController.v4 = true
  Object.defineProperty(retryController, 'orchestration', {
    configurable: true,
    get: () => sharedOrchestration,
    set: value => { sharedOrchestration = value },
  })
  retryWorkspace.activeRuns.set(group.id, retryController)
  const retryPhase = retryWorkspace.autoRunner.runV4Phase(
    retryWorkspace.getGroup(group.id), retryController, task.id, context, phaseInput,
  )
  await retryStarted.promise
  const retryResult = await retryPhase
  assert.equal(retryResult.failures.length, 0)
  const acknowledgedState = structuredClone(sharedOrchestration.deliveryState)
  assert.equal(acknowledgedState.every(entry => entry.status === 'acknowledged'), true)
  assert.equal(acknowledgedState.some(entry => oldDeliveryIds.has(entry.deliveryId)), false)

  releaseOldFailure.resolve()
  const oldResult = await oldPhase
  assert.equal(oldResult.failures.length, 1)
  assert.deepEqual(sharedOrchestration.deliveryState, acknowledgedState)
  workspace.activeRuns.delete(group.id)
  retryWorkspace.activeRuns.delete(group.id)
})

test('V4 legacy synthesis-binding helper ranks one writer and exact distinct verifiers for 2, 3, and 32 Agents', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)

  for (const count of [2, 3, 32]) {
    const kinds = Array.from({ length: count }, (_value, index) => `agent-${index + 1}`)
    const candidates = synthesisCandidates(kinds, Object.fromEntries(
      kinds.map(kind => [kind, { score: 500 }]),
    ))
    const binding = workspace.autoRunner.v4SynthesisBinding(synthesisBindingInput(
      kinds, { candidates },
    ))
    assert.equal(binding.candidates.length, count)
    assert.equal(binding.writerKind, 'agent-1')
    assert.equal(binding.verificationKinds.length, Math.min(2, count - 1))
    assert.equal(new Set(binding.verificationKinds).size, binding.verificationKinds.length)
    assert.equal(binding.verificationKinds.includes(binding.writerKind), false)
  }
})

test('V4 Auto fails a read-only agreed finalizer once without automatic replacement', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  const synthesisKinds = []
  let failedWriter = ''
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    if (phase === 'synthesis') {
      synthesisKinds.push(agent.kind)
      if (!failedWriter) {
        failedWriter = agent.kind
        throw new Error('LOCAL_AGENT_PROCESS_FAILED')
      }
    }
    return {
      text: `${agent.kind} ${phase}`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-${phase}`,
      collaboration: agreedV4Collaboration(
        agent.kind, phase, prompt, ['codex', 'hermes', 'workbuddy'],
      ),
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'V4 read-only synthesis failover',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: false,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Produce and independently verify one candidate.',
    mode: 'auto',
    maxRounds: 2,
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    protocol: 'v4',
  })
  const controller = workspace.activeRuns.get(group.id)
  await controller.promise
  const durable = ledger.get(controller.runId)

  assert.equal(durable.status, 'failed')
  assert.equal(synthesisKinds.length, 1)
  assert.equal(synthesisKinds[0], failedWriter)
  assert.equal(durable.orchestration.coordinationPlan.finalizerKind, failedWriter)
  assert.equal(durable.orchestration.synthesisRecovery.activeWriterKind, failedWriter)
  assert.deepEqual(durable.orchestration.synthesisRecovery.triedWriters, synthesisKinds)
  assert.deepEqual(
    durable.orchestration.synthesisRecovery.attempts.map(attempt => attempt.status),
    ['failed'],
  )
  assert.deepEqual(
    durable.orchestration.synthesisRecovery.verificationKinds,
    durable.orchestration.coordinationPlan.verifierKinds,
  )
})

test('V4 Auto gates an unknown writable synthesis outcome before dispatching another writer', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  const synthesisCalls = []
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    if (phase === 'synthesis') {
      synthesisCalls.push({ kind: agent.kind, operationId: runOptions.operationId })
      throw Object.assign(new Error('socket reset after write'), { code: 'ECONNRESET' })
    }
    return {
      text: `${agent.kind} ${phase}`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-${phase}`,
      collaboration: agreedV4Collaboration(
        agent.kind, phase, prompt, ['codex', 'hermes', 'workbuddy'],
      ),
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'V4 writable synthesis recovery',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: true,
  })
  const gatePromise = pendingHumanGate(workspace)

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Produce one candidate without risking a duplicate workspace write.',
    mode: 'auto',
    maxRounds: 2,
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    protocol: 'v4',
  })
  const controller = workspace.activeRuns.get(group.id)
  const gate = await gatePromise
  const durable = ledger.get(controller.runId)
  const coordinationPlan = durable.orchestration.coordinationPlan
  const recovery = durable.orchestration.synthesisRecovery
  const recoveryBinding = recovery.pendingGate

  assert.equal(gate.type, 'decision')
  assert.deepEqual(gate.options.map(option => option.optionId), [
    'retry-original-writer', 'replace-next-writer', 'stop-discussion',
  ])
  assert.equal(coordinationPlan.finalizerKind, 'workbuddy')
  assert.deepEqual(coordinationPlan.verifierKinds, ['codex', 'hermes'])
  assert.equal(recoveryBinding.writerKind, coordinationPlan.finalizerKind)
  assert.equal(recoveryBinding.proposedReplacementKind, 'codex')
  assert.deepEqual(recovery.rankedKinds.slice(0, 2), ['workbuddy', 'codex'])
  assert.equal(coordinationPlan.assignments.some(assignment => (
    assignment.ownerKind === recoveryBinding.proposedReplacementKind
  )), true)
  assert.deepEqual(coordinationPlan.verifierKinds.filter(kind => (
    kind !== recoveryBinding.proposedReplacementKind
  )), ['hermes'])
  assert.equal(recoveryBinding.rankingFingerprint, recovery.rankingFingerprint)
  assert.equal(synthesisCalls.length, 1)
  assert.equal(durable.status, 'waiting')
  assert.equal(durable.continuation.resumeKind, 'v4_synthesis_recovery')
  assert.equal(durable.orchestration.phase, 'human-gate')
  assert.equal(durable.orchestration.synthesisRecovery.attempts.at(-1).status, 'unknown_outcome')
  assert.equal(durable.orchestration.synthesisRecovery.pendingGate.operationId,
    synthesisCalls[0].operationId)
  assert.equal(workspace.listHumanGates({ pendingOnly: true }).length, 1)

  workspace.decideHumanGate(gate.gateId, {
    status: 'rejected', optionId: 'stop-discussion', actorId: 'local-user',
  })
  await controller.promise
})

test('V4 Auto retries the original writer with a new operation after recovery approval', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  const synthesisCalls = []
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    if (phase === 'synthesis') {
      synthesisCalls.push({ kind: agent.kind, operationId: runOptions.operationId })
      if (synthesisCalls.length === 1) {
        throw Object.assign(new Error('socket reset after write'), { code: 'ECONNRESET' })
      }
    }
    return {
      text: `${agent.kind} ${phase}`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-${phase}`,
      collaboration: agreedV4Collaboration(
        agent.kind, phase, prompt, ['codex', 'hermes', 'workbuddy'],
      ),
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'V4 retry original synthesis writer',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: true,
  })
  const gatePromise = pendingHumanGate(workspace)

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Retry the bound writer only after explicit approval.',
    mode: 'auto',
    maxRounds: 2,
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    protocol: 'v4',
  })
  const controller = workspace.activeRuns.get(group.id)
  const gate = await gatePromise
  workspace.decideHumanGate(gate.gateId, {
    status: 'approved', optionId: 'retry-original-writer', actorId: 'local-user',
  })
  await controller.promise
  const durable = ledger.get(controller.runId)

  assert.equal(durable.status, 'completed')
  assert.equal(synthesisCalls.length, 2)
  assert.equal(synthesisCalls[0].kind, synthesisCalls[1].kind)
  assert.notEqual(synthesisCalls[0].operationId, synthesisCalls[1].operationId)
  assert.deepEqual(
    durable.orchestration.synthesisRecovery.attempts.map(attempt => attempt.status),
    ['superseded', 'completed'],
  )
  assert.equal(durable.orchestration.synthesisRecovery.attempts[0].outcomeCertainty,
    'unknown_outcome')
  assert.equal(workspace.humanGateStore.list().length, 1)
})

test('V4 Auto rejects a late synthesis result after the discussion is stopped', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  const synthesisStarted = deferred()
  const lateSynthesis = deferred()
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    if (phase === 'synthesis') {
      synthesisStarted.resolve({ kind: agent.kind, operationId: runOptions.operationId })
      return lateSynthesis.promise
    }
    return {
      text: `${agent.kind} ${phase}`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-${phase}`,
      collaboration: agreedV4Collaboration(
        agent.kind, phase, prompt, ['codex', 'hermes', 'workbuddy'],
      ),
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'V4 late synthesis result',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: true,
  })
  await workspace.sendMessage({
    groupId: group.id,
    text: 'Stop before the synthesis candidate returns.',
    mode: 'auto',
    maxRounds: 2,
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    protocol: 'v4',
  })
  const controller = workspace.activeRuns.get(group.id)
  const runningSynthesis = await synthesisStarted.promise

  assert.equal(workspace.stop(group.id, controller.runId), true)
  await controller.promise
  lateSynthesis.resolve({
    text: 'Late synthesis candidate must be ignored.',
    sessionRef: `${runningSynthesis.kind}-late-synthesis`,
    collaboration: agreedV4Collaboration(
      runningSynthesis.kind,
      'synthesis',
      '',
      ['codex', 'hermes', 'workbuddy'],
      { summary: 'Late synthesis candidate' },
    ),
  })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  const final = ledger.get(controller.runId)
  const writerSlot = final.orchestration.slots.find(slot => (
    slot.agentKind === runningSynthesis.kind
  ))
  assert.equal(final.status, 'stopped')
  assert.equal(writerSlot.status, 'stopped')
  assert.equal((writerSlot.resultRefs?.workflowOutcomeRefs || []).some(record => (
    record.receipt?.phase === 'synthesis'
  )), false)
  assert.deepEqual(final.orchestration.commitState.committedKinds, [])
  assert.deepEqual(final.orchestration.commitState.messageIds, [])
  assert.deepEqual(final.orchestration.commitState.blackboardEntryIds, [])
  assert.equal(workspace.snapshot().messages.some(message => (
    message.role === 'agent' && message.content === 'Late synthesis candidate must be ignored.'
  )), false)
})

test('V4 legacy synthesis-binding helper is stable across run state, rounds, input order, and reconstruction', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const kinds = ['codex', 'hermes', 'workbuddy']
  const candidates = synthesisCandidates(kinds, {
    codex: { score: 700 }, hermes: { score: 700 }, workbuddy: { score: 700 },
  })
  const first = new LocalWorkspace(options)
  const second = new LocalWorkspace(options)
  const input = synthesisBindingInput(kinds, { candidates, contentHash: 'c'.repeat(64) })
  const expected = first.autoRunner.v4SynthesisBinding(input)

  const controller = first.createRunController('auto', kinds, 'root-binding', 8, false)
  controller.runId = 'different-run'
  controller.currentRound = 17
  const reordered = second.autoRunner.v4SynthesisBinding(synthesisBindingInput(
    [...kinds].reverse(),
    { candidates: [...candidates].reverse(), contentHash: 'c'.repeat(64) },
  ))

  assert.deepEqual(reordered, expected)
  assert.deepEqual(first.autoRunner.v4SynthesisBinding(input), expected)
})

test('V4 legacy synthesis-binding helper hashes semantic body instead of snapshot identifiers', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const first = new LocalWorkspace(options)
  const second = new LocalWorkspace(options)
  const kinds = ['codex', 'hermes', 'workbuddy']
  const candidates = synthesisCandidates(kinds, {
    codex: { score: 600, evidence: null },
    hermes: { score: 600, evidence: null },
    workbuddy: { score: 600, evidence: null },
  })
  const controllerA = first.createRunController('auto', kinds, 'root-a', 8, false)
  controllerA.runId = 'run-a'
  controllerA.taskId = 'task-a'
  const controllerB = second.createRunController('auto', kinds, 'root-b', 8, false)
  controllerB.runId = 'run-b'
  controllerB.taskId = 'task-b'
  const content = {
    version: 1,
    targetKinds: kinds,
    skillHintsByKind: kinds.map(kind => ({ kind, skillHints: [] })),
    phase: 'proposal',
    writerKind: '',
    taskText: 'Produce the same evidence-backed answer.',
    group: { name: 'Semantic snapshot group', topic: 'Semantic snapshot topic' },
    history: [
      { id: 'history-a', role: 'user', agentKind: '', text: 'Keep the answer concise.' },
      { id: 'history-agent-a', role: 'agent', agentKind: 'codex', text: 'Prior finding.' },
    ],
  }
  const snapshotA = {
    ...content, taskId: 'task-a', messageId: 'message-a',
  }
  const snapshotB = {
    ...content,
    taskId: 'task-b',
    messageId: 'message-b',
    history: content.history.map((item, index) => ({ ...item, id: `other-${index}` })),
  }
  const recordA = first.autoRunner.v4SnapshotRecord(controllerA, snapshotA, kinds).record
  const recordB = second.autoRunner.v4SnapshotRecord(controllerB, snapshotB, kinds).record
  const bindingA = first.autoRunner.v4SynthesisBinding({
    targetKinds: kinds,
    snapshotRecord: recordA,
    routingDecision: { candidates },
  })
  const bindingB = second.autoRunner.v4SynthesisBinding({
    targetKinds: kinds,
    snapshotRecord: recordB,
    routingDecision: { candidates: [...candidates].reverse() },
  })

  assert.notEqual(recordA.contentHash, recordB.contentHash)
  assert.equal(recordA.bodyHash, recordB.bodyHash)
  assert.deepEqual(bindingA, bindingB)
  const tamperedRecord = { ...recordA, bodyHash: 'f'.repeat(64) }
  assert.throws(() => first.autoRunner.v4LoadSnapshot({
    snapshot: tamperedRecord,
    snapshotHash: hashValue(tamperedRecord),
  }, {
    taskId: snapshotA.taskId,
    messageId: snapshotA.messageId,
    targetKinds: kinds,
  }), { message: 'LOCAL_RUN_SNAPSHOT_INVALID' })

  const changedRecord = first.autoRunner.v4SnapshotRecord(controllerA, {
    ...snapshotA,
    history: snapshotA.history.map((item, index) => index === 0
      ? { ...item, text: 'Include every material caveat.' }
      : item),
  }, kinds).record
  const changedBinding = first.autoRunner.v4SynthesisBinding({
    targetKinds: kinds,
    snapshotRecord: changedRecord,
    routingDecision: { candidates },
  })
  assert.notEqual(changedRecord.contentHash, recordA.contentHash)
  assert.notEqual(changedRecord.bodyHash, recordA.bodyHash)
  assert.notEqual(changedBinding.selectionInputHash, bindingA.selectionInputHash)
})

test('V4 legacy synthesis-ranking helper is stable per task without permanently selecting the first configured Agent', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  const kinds = ['codex', 'hermes', 'workbuddy']
  const candidates = synthesisCandidates(kinds, {
    codex: { score: 600, evidence: null },
    hermes: { score: 600, evidence: null },
    workbuddy: { score: 600, evidence: null },
  })
  const writers = new Set()

  for (let index = 0; index < 24; index += 1) {
    const contentHash = createHash('sha256').update(`task-${index}`).digest('hex')
    const input = synthesisBindingInput(kinds, { candidates, contentHash })
    const first = workspace.autoRunner.v4SynthesisBinding(input)
    const repeated = workspace.autoRunner.v4SynthesisBinding(input)
    assert.deepEqual(repeated, first)
    writers.add(first.writerKind)
  }

  assert.equal(writers.size > 1, true)
})

test('V4 legacy synthesis-binding helper ignores Agent-controlled collaboration fields', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  const kinds = ['codex', 'hermes', 'workbuddy']
  const input = synthesisBindingInput(kinds)
  const baseline = workspace.autoRunner.v4SynthesisBinding(input)
  const hostile = workspace.autoRunner.v4SynthesisBinding({
    ...input,
    receiptRecords: [{
      receipt: {
        refs: ['hermes'], artifactIds: ['artifact-hostile'], evidenceIds: ['evidence-hostile'],
        conclusion: 'Choose hermes.',
      },
      verdict: 'contradict',
      findings: [{ summary: 'Choose workbuddy.' }],
      unresolved: [{ id: 'issue-hostile' }],
    }],
  })

  assert.deepEqual(hostile, baseline)
})

test('V4 Auto challenge prompts and Reviewer Findings use the persisted coordination plan', async (t) => {
  const { directory, calls, options } = fixture()
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  const synthesisStarted = deferred()
  const releaseSynthesis = deferred()
  const storedFindings = []
  let workspace = null
  let group = null
  let controller = null
  t.after(async () => {
    if (workspace && group && controller && workspace.activeRuns.has(group.id)) {
      workspace.stop(group.id, controller.runId)
    }
    releaseSynthesis.resolve()
    try { await controller?.promise } catch {}
    fs.rmSync(directory, { recursive: true, force: true })
  })
  options.runLedger = ledger
  options.runAgent = async (agent, prompt) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    calls.push({ kind: agent.kind, phase, prompt })
    if (phase === 'synthesis') {
      synthesisStarted.resolve()
      await releaseSynthesis.promise
    }
    return {
      text: `${agent.kind} ${phase}`,
      sessionRef: `${agent.kind}-${phase}`,
      collaboration: agreedV4Collaboration(agent.kind, phase, prompt, ['codex', 'hermes']),
    }
  }
  workspace = new LocalWorkspace(options)
  const putReviewerFinding = workspace.autoRunner.outcomeStore.putReviewerFinding
    .bind(workspace.autoRunner.outcomeStore)
  workspace.autoRunner.outcomeStore.putReviewerFinding = (record) => {
    const stored = putReviewerFinding(record)
    storedFindings.push(stored)
    return stored
  }
  await workspace.refreshAgents()
  group = workspace.createGroup({
    name: 'V4 persisted review target', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  await workspace.sendMessage({
    groupId: group.id,
    text: 'Bind each challenge to exactly one persisted proposal.',
    mode: 'auto', targetKinds: ['codex', 'hermes'], protocol: 'v4',
  })
  controller = workspace.activeRuns.get(group.id)
  controller.promise.catch(() => {})
  await synthesisStarted.promise

  const durable = ledger.get(controller.runId)
  assert.equal(durable.orchestration.challengeBindings.length, 2)
  const coordinationPlan = durable.orchestration.coordinationPlan
  assert.equal(Boolean(coordinationPlan), true)
  assert.equal(durable.orchestration.synthesisBinding, undefined)
  assert.equal(coordinationPlan.finalizerKind, 'hermes')
  assert.deepEqual(coordinationPlan.verifierKinds, ['codex'])
  assert.equal(durable.orchestration.commitState.writerKind, coordinationPlan.finalizerKind)
  assert.deepEqual(
    calls.filter(item => item.phase === 'synthesis').map(item => item.kind),
    [coordinationPlan.finalizerKind],
  )
  for (const binding of durable.orchestration.challengeBindings) {
    const call = calls.find(item => item.phase === 'challenge' && item.kind === binding.reviewerKind)
    assert.match(
      call.prompt,
      new RegExp(`Coverage responsibility: explicitly incorporate or challenge ${binding.proposalKind}`),
    )
    const finding = storedFindings.find(item => item.reviewer.agentKind === binding.reviewerKind)
    assert.equal(finding.artifactId, binding.artifactIds[0])
  }

  const invalid = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: path.join(directory, 'run-ledger-invalid-synthesis.json') }),
  })
  await invalid.refreshAgents()
  invalid.autoRunner.v4SynthesisBinding = () => {
    throw new Error('TEST_FRESH_SYNTHESIS_BINDING_DERIVED')
  }
  const assertMissingPlanFailsClosed = async (orchestration) => {
    const candidate = invalid.createRunController(
      'auto', durable.targetKinds, durable.threadRootId,
      durable.maxRounds, durable.unlimitedRounds,
    )
    candidate.runId = durable.runId
    candidate.taskId = durable.taskId
    candidate.contextPackId = durable.contextPackId
    candidate.taskBound = true
    candidate.groupId = durable.groupId
    candidate.currentRound = durable.currentRound
    candidate.orchestration = orchestration
    candidate.v4 = true
    const invalidContext = await invalid.autoRunner.automaticContext(
      invalid.getGroup(group.id), candidate, durable.threadRootId,
    )
    await assert.rejects(() => invalid.autoRunner.runV4Discussion(
      invalid.getGroup(group.id), candidate, durable.threadRootId, invalidContext, true,
    ), { message: 'LOCAL_RUN_V4_SYNTHESIS_BINDING_REQUIRED' })
  }
  for (const phase of ['verification', 'human-gate', 'commit', 'committed', 'completed']) {
    const orchestration = structuredClone(durable.orchestration)
    delete orchestration.coordinationPlan
    orchestration.phase = phase
    await assertMissingPlanFailsClosed(orchestration)
  }

  const observableSlot = structuredClone(durable.orchestration)
  delete observableSlot.coordinationPlan
  observableSlot.phase = 'challenge'
  await assertMissingPlanFailsClosed(observableSlot)

  const observableReceipt = structuredClone(durable.orchestration)
  delete observableReceipt.coordinationPlan
  observableReceipt.phase = 'challenge'
  observableReceipt.slots = observableReceipt.slots.map(slot => ({
    ...slot,
    phase: 'challenge',
    status: 'completed',
    finishedAt: slot.finishedAt || Date.now(),
  }))
  const receiptSlot = observableReceipt.slots[0]
  const startedReceipt = createCollaborationReceipt({
    phase: 'synthesis',
    agentKind: receiptSlot.agentKind,
    slotId: receiptSlot.slotId,
    operationId: receiptSlot.operationId,
    status: 'completed',
    summary: 'Synthesis already started.',
    snapshotHash: observableReceipt.snapshotHash,
    deliveryWatermark: 3,
  })
  observableReceipt.slots[0].resultRefs.workflowOutcomeRefs.push({ receipt: startedReceipt })
  await assertMissingPlanFailsClosed(observableReceipt)

  const commitObservableBase = structuredClone(durable.orchestration)
  delete commitObservableBase.coordinationPlan
  commitObservableBase.phase = 'proposal'
  commitObservableBase.currentKind = ''
  commitObservableBase.currentKinds = []
  commitObservableBase.pendingKinds = []
  commitObservableBase.slots = commitObservableBase.slots.map((slot) => {
    const workflowOutcomeRefs = slot.resultRefs.workflowOutcomeRefs.filter(item => (
      ['proposal', 'challenge'].includes(item.receipt.phase)
    ))
    const challengeReceipt = [...workflowOutcomeRefs].reverse().find(item => (
      item.receipt.phase === 'challenge'
    )).receipt
    return {
      ...slot,
      phase: 'challenge',
      status: 'completed',
      operationId: challengeReceipt.operationId,
      receiptId: challengeReceipt.receiptId,
      finishedAt: slot.finishedAt || Date.now(),
      commitStatus: 'pending',
      permission: 'read-only',
      resultRefs: { ...slot.resultRefs, workflowOutcomeRefs },
    }
  })
  const pendingCommitState = {
    ...commitObservableBase.commitState,
    status: 'pending',
    writerKind: null,
    committedKinds: [],
    pendingKinds: [...durable.targetKinds],
    operationId: '',
    attempt: 0,
    committedSlotIds: [],
    messageIds: [],
    blackboardEntryIds: [],
  }
  for (const commitState of [
    { ...pendingCommitState, status: 'committing' },
    { ...pendingCommitState, writerKind: durable.targetKinds[0] },
    { ...pendingCommitState, operationId: 'operation-commit-observable' },
    { ...pendingCommitState, messageIds: ['message-commit-observable'] },
  ]) {
    await assertMissingPlanFailsClosed({
      ...structuredClone(commitObservableBase),
      commitState,
    })
  }
  const recoveryLedger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger-synthesis-recovery.json'),
  })
  recoveryLedger.checkpoint(durable)
  const recoveredDurable = new RunLedger({
    storagePath: path.join(directory, 'run-ledger-synthesis-recovery.json'),
  }).get(durable.runId)
  const recoveryCalls = []
  const recovered = new LocalWorkspace({
    ...options,
    runLedger: null,
    runAgent: async (agent, prompt) => {
      const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
      recoveryCalls.push({ kind: agent.kind, phase })
      const artifactId = `artifact-${createHash('sha256').update(`${agent.kind}:${phase}:recovery`).digest('hex')}`
      const evidenceId = `evidence-${createHash('sha256').update(`${agent.kind}:${phase}:recovery`).digest('hex')}`
      return {
        text: `${agent.kind} ${phase}`,
        sessionRef: `${agent.kind}-${phase}-recovered`,
        outcomeRefs: { artifactIds: [artifactId], evidenceIds: [evidenceId] },
        collaboration: agreedV4Collaboration(
          agent.kind,
          phase,
          prompt,
          ['codex', 'hermes'],
          { summary: phase === 'synthesis' ? 'Recovered candidate' : 'Recovered verification' },
        ),
      }
    },
  })
  await recovered.refreshAgents()
  const recoveredController = recovered.createRunController(
    'auto', recoveredDurable.targetKinds, recoveredDurable.threadRootId,
    recoveredDurable.maxRounds, recoveredDurable.unlimitedRounds,
  )
  recoveredController.runId = recoveredDurable.runId
  recoveredController.taskId = recoveredDurable.taskId
  recoveredController.contextPackId = recoveredDurable.contextPackId
  recoveredController.taskBound = true
  recoveredController.groupId = recoveredDurable.groupId
  recoveredController.currentRound = recoveredDurable.currentRound
  recoveredController.orchestration = structuredClone(recoveredDurable.orchestration)
  recoveredController.v4 = true
  recovered.activeRuns.set(group.id, recoveredController)
  const recoveryGatePromise = pendingHumanGate(recovered)
  const recoveryRun = recovered.autoRunner.runV4Discussion(
    recovered.getGroup(group.id),
    recoveredController,
    durable.threadRootId,
    await recovered.autoRunner.automaticContext(
      recovered.getGroup(group.id), recoveredController, durable.threadRootId,
    ),
    true,
  )
  const recoveryGate = await recoveryGatePromise
  const recovery = recoveredController.orchestration.synthesisRecovery
  const recoveryBinding = recovery.pendingGate

  assert.deepEqual(recoveryCalls, [])
  assert.equal(recovery.attempts.length, 1)
  assert.equal(recovery.attempts[0].status, 'unknown_outcome')
  assert.equal(recoveryBinding.writerKind, coordinationPlan.finalizerKind)
  assert.equal(recoveryBinding.proposedReplacementKind, '')
  assert.deepEqual(recovery.verificationKinds, coordinationPlan.verifierKinds)
  assert.equal(recoveryGate.agentKind, coordinationPlan.finalizerKind)
  assert.equal(recoveryGate.agentRunId, recoveryBinding.operationId)
  assert.deepEqual(recoveryGate.options.map(option => option.optionId), [
    'retry-original-writer', 'stop-discussion',
  ])
  assert.equal(recovered.listHumanGates({ pendingOnly: true }).length, 1)

  recovered.decideHumanGate(recoveryGate.gateId, {
    status: 'rejected', optionId: 'stop-discussion', actorId: 'local-user',
  })
  assert.equal(await recoveryRun, 'stopped')
  recovered.activeRuns.delete(group.id)
})

test('V4 Auto verification recovery invokes only the persisted verification kinds', async (t) => {
  const { directory, options } = fixture()
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  const verificationStarted = deferred()
  const releaseVerification = deferred()
  let verificationCalls = 0
  let workspace = null
  let group = null
  let controller = null
  t.after(async () => {
    releaseVerification.resolve()
    if (workspace && group && controller && workspace.activeRuns.has(group.id)) {
      workspace.stop(group.id, controller.runId)
      try { await controller.promise } catch {}
    }
    fs.rmSync(directory, { recursive: true, force: true })
  })
  options.runLedger = ledger
  options.runAgent = async (agent, prompt) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    if (phase === 'verification') {
      verificationCalls += 1
      if (verificationCalls === 1) verificationStarted.resolve()
      await releaseVerification.promise
    }
    return {
      text: `${agent.kind} ${phase}`,
      sessionRef: `${agent.kind}-${phase}`,
      collaboration: agreedV4Collaboration(
        agent.kind, phase, prompt, ['codex', 'hermes', 'workbuddy'],
      ),
    }
  }
  workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  group = workspace.createGroup({
    name: 'V4 verification recovery',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
  })
  await workspace.sendMessage({
    groupId: group.id,
    text: 'Resume verification from the durable binding.',
    mode: 'auto',
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    protocol: 'v4',
  })
  controller = workspace.activeRuns.get(group.id)
  controller.promise.catch(() => {})
  await verificationStarted.promise
  const checkpoint = ledger.get(controller.runId)
  const coordinationPlan = checkpoint.orchestration.coordinationPlan
  assert.equal(checkpoint.orchestration.phase, 'verification')
  assert.equal(checkpoint.orchestration.synthesisBinding, undefined)
  assert.equal(Boolean(coordinationPlan), true)
  assert.equal(coordinationPlan.finalizerKind, 'workbuddy')
  assert.deepEqual(coordinationPlan.verifierKinds, ['codex', 'hermes'])

  workspace.stop(group.id, controller.runId)
  releaseVerification.resolve()
  await controller.promise

  const recoveryPath = path.join(directory, 'run-ledger-verification-recovery.json')
  new RunLedger({ storagePath: recoveryPath }).checkpoint(checkpoint)
  const recoveredDurable = new RunLedger({ storagePath: recoveryPath }).get(checkpoint.runId)
  const recoveryCalls = []
  const recoveredFirstVerificationStarted = deferred()
  const recoveredSecondVerificationStarted = deferred()
  const releaseRecoveredFirstVerification = deferred()
  const releaseRecoveredSecondVerification = deferred()
  const recovered = new LocalWorkspace({
    ...options,
    runLedger: null,
    runAgent: async (agent, prompt) => {
      const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
      recoveryCalls.push({ kind: agent.kind, phase })
      if (recoveryCalls.length === 1) {
        recoveredFirstVerificationStarted.resolve()
        await releaseRecoveredFirstVerification.promise
      } else if (new Set(recoveryCalls.map(call => call.kind)).size
          === coordinationPlan.verifierKinds.length) {
        recoveredSecondVerificationStarted.resolve()
        await releaseRecoveredSecondVerification.promise
      }
      return {
        text: `${agent.kind} ${phase}`,
        sessionRef: `${agent.kind}-${phase}-recovered`,
        collaboration: agreedV4Collaboration(
          agent.kind,
          phase,
          prompt,
          ['codex', 'hermes', 'workbuddy'],
          { summary: 'Recovered review' },
        ),
      }
    },
  })
  await recovered.refreshAgents()
  const recoveredController = recovered.createRunController(
    'auto', recoveredDurable.targetKinds, recoveredDurable.threadRootId,
    recoveredDurable.maxRounds, recoveredDurable.unlimitedRounds,
  )
  recoveredController.runId = recoveredDurable.runId
  recoveredController.taskId = recoveredDurable.taskId
  recoveredController.contextPackId = recoveredDurable.contextPackId
  recoveredController.taskBound = true
  recoveredController.groupId = recoveredDurable.groupId
  recoveredController.currentRound = recoveredDurable.currentRound
  recoveredController.orchestration = structuredClone(recoveredDurable.orchestration)
  recoveredController.v4 = true
  recovered.activeRuns.set(group.id, recoveredController)
  const recoveryRun = recovered.autoRunner.runV4Discussion(
    recovered.getGroup(group.id), recoveredController, recoveredDurable.threadRootId,
    await recovered.autoRunner.automaticContext(
      recovered.getGroup(group.id), recoveredController, recoveredDurable.threadRootId,
    ), true,
  )
  await recoveredFirstVerificationStarted.promise
  assert.deepEqual(recoveryCalls.map(call => call.kind), [coordinationPlan.verifierKinds[0]])
  releaseRecoveredFirstVerification.resolve()
  await recoveredSecondVerificationStarted.promise

  assert.deepEqual(
    new Set(recoveryCalls.map(call => call.kind)),
    new Set(coordinationPlan.verifierKinds),
  )
  assert.equal(recoveryCalls.every(call => call.phase === 'verification'), true)
  recoveredController.abort()
  releaseRecoveredSecondVerification.resolve()
  await recoveryRun
  recovered.activeRuns.delete(group.id)

  const invalidController = recovered.createRunController(
    'auto', recoveredDurable.targetKinds, recoveredDurable.threadRootId,
    recoveredDurable.maxRounds, recoveredDurable.unlimitedRounds,
  )
  invalidController.orchestration = structuredClone(recoveredDurable.orchestration)
  delete invalidController.orchestration.coordinationPlan
  invalidController.v4 = true
  await assert.rejects(() => recovered.autoRunner.runV4Discussion(
    recovered.getGroup(group.id), invalidController, recoveredDurable.threadRootId,
    {}, true,
  ), { message: 'LOCAL_RUN_V4_SYNTHESIS_BINDING_REQUIRED' })
})

test('V4 Auto round one runs concurrent primary proposals before round-two challenges', async (t) => {
  const { directory, calls, options } = fixture()
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  const firstChallenge = deferred()
  const releaseChallenges = deferred()
  let workspace = null
  let group = null
  let controller = null
  t.after(async () => {
    if (workspace && group && controller && workspace.activeRuns.has(group.id)) {
      workspace.stop(group.id, controller.runId)
    }
    releaseChallenges.resolve()
    try { await controller?.promise } catch {}
    fs.rmSync(directory, { recursive: true, force: true })
  })
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 2, workspaceLimit: 2, globalLimit: 2 })
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    calls.push({ kind: agent.kind, phase, prompt, runOptions })
    if (phase === 'challenge') {
      firstChallenge.resolve()
      await releaseChallenges.promise
    }
    return {
      text: `${agent.kind} ${phase}`,
      sessionRef: `${agent.kind}-${phase}`,
      collaboration: phase === 'proposal'
        ? v4ProposalCollaboration(agent.kind)
        : { version: 1, phase, verdict: 'support', summary: `${agent.kind} review` },
    }
  }
  workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  group = workspace.createGroup({
    name: 'V4 Auto proposal barrier', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Produce independent proposals before review.',
    mode: 'auto',
    targetKinds: ['codex', 'hermes'],
    protocol: 'v4',
  })
  controller = workspace.activeRuns.get(group.id)
  controller.promise.catch(() => {})
  await firstChallenge.promise

  assert.deepEqual(calls.slice(0, 2).map(call => call.phase), ['proposal', 'proposal'])
  assert.equal(calls.filter(call => call.phase === 'challenge').length, 1)
  assert.equal(calls.slice(0, 2).every(call => /Role: participant/.test(call.prompt)), true)
  assert.equal(calls.slice(0, 2).every(call => !/Role: (?:primary|reviewer|worker|synthesizer|verifier)/.test(call.prompt)), true)
  const firstChallengeCall = calls.find(call => call.phase === 'challenge')
  const firstChallengeIndex = ['codex', 'hermes'].indexOf(firstChallengeCall.kind)
  assert.equal(firstChallengeCall.runOptions.operationId, (
    `operation-${createHash('sha256').update(JSON.stringify([
      controller.runId,
      controller.taskId,
      firstChallengeCall.kind,
      `slot-${firstChallengeIndex + 1}-${firstChallengeCall.kind}`,
      'challenge',
      2,
    ])).digest('hex')}`
  ))
  const durable = ledger.get(controller.runId)
  assert.equal(durable.currentRound, 2)
  assert.equal(durable.orchestration.phase, 'challenge')
  assert.equal(durable.orchestration.plan.assignments.every(assignment => assignment.role === 'participant'), true)
})

test('V4 Auto preserves proposals and continues when a round-two Agent fails', async (t) => {
  const { directory, calls, options } = fixture()
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  let workspace = null
  let group = null
  let controller = null
  t.after(async () => {
    if (workspace && group && controller && workspace.activeRuns.has(group.id)) {
      workspace.stop(group.id, controller.runId)
    }
    try { await controller?.promise } catch {}
    fs.rmSync(directory, { recursive: true, force: true })
  })
  options.runLedger = ledger
  options.retrySleep = async () => {}
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    calls.push({ kind: agent.kind, phase, prompt, runOptions })
    if (phase === 'challenge' && agent.kind === 'openclaw') {
      throw new Error('LOCAL_AGENT_PROCESS_FAILED')
    }
    return {
      text: `${agent.kind} ${phase}`,
      sessionRef: `${agent.kind}-${phase}`,
      collaboration: phase === 'proposal'
        ? v4ProposalCollaboration(agent.kind)
        : agreedV4Collaboration(agent.kind, phase, prompt, ['codex', 'hermes']),
    }
  }
  workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  group = workspace.createGroup({
    name: 'V4 failed participant removal',
    agentKinds: ['codex', 'openclaw', 'hermes'],
    workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Continue after one participant fails.',
    mode: 'auto',
    targetKinds: ['codex', 'openclaw', 'hermes'],
    protocol: 'v4',
  })
  controller = workspace.activeRuns.get(group.id)
  await controller.promise

  assert.deepEqual(workspace.getGroup(group.id).agentKinds, ['codex', 'openclaw', 'hermes'])
  assert.deepEqual(
    workspace.snapshot().messages.filter(message => (
      message.role === 'agent' && message.threadRootId === controller.threadRootId
    )).map(message => [message.agentKind, message.content]),
    [
      ['codex', 'codex proposal'],
      ['openclaw', 'openclaw proposal'],
      ['hermes', 'hermes proposal'],
      ['codex', 'codex challenge'],
      ['hermes', 'hermes challenge'],
      ['codex', 'codex challenge'],
      ['hermes', 'hermes challenge'],
      ['hermes', 'hermes synthesis'],
    ],
  )
  assert.deepEqual(
    calls.filter(call => call.phase === 'challenge').map(call => call.kind),
    ['codex', 'openclaw', 'openclaw', 'openclaw', 'openclaw', 'hermes', 'codex', 'hermes'],
  )
  assert.equal(workspace.snapshot().messages.some(message => (
    message.system?.key === 'system.agentRemovedAfterFailure'
      && message.system.params.agent === 'OpenClaw'
  )), false)
  assert.equal(ledger.get(controller.runId).status, 'partial')
})

test('V4 Auto keeps an Agent in the group after an invalid collaboration control block', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.retrySleep = async () => {}
  options.runAgent = async (agent, prompt) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    if (phase === 'proposal') {
      return {
        text: `${agent.kind} proposal`,
        sessionRef: `${agent.kind}-proposal`,
        collaboration: v4ProposalCollaboration(agent.kind),
      }
    }
    const collaboration = agreedV4Collaboration(
      agent.kind, phase, prompt, ['codex', 'openclaw'],
    )
    if (agent.kind === 'openclaw') {
      collaboration.proposedAssignments[0].role = 'manager'
    }
    return {
      text: `${agent.kind} challenge`,
      sessionRef: `${agent.kind}-challenge`,
      collaboration,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'V4 invalid control retention',
    agentKinds: ['codex', 'openclaw'],
    workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Keep participants after a malformed coordination receipt.',
    mode: 'auto',
    targetKinds: ['codex', 'openclaw'],
    protocol: 'v4',
  })
  const controller = workspace.activeRuns.get(group.id)
  await controller.promise

  assert.deepEqual(workspace.getGroup(group.id).agentKinds, ['codex', 'openclaw'])
  assert.equal(workspace.snapshot().messages.some(message => (
    message.system?.key === 'system.agentRemovedAfterFailure'
      && message.agentKind === 'openclaw'
  )), false)
})

test('V4 Auto maxRounds one settles proposals without later phases or a final answer', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  options.runAgent = async (agent, prompt) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    calls.push({ kind: agent.kind, phase, prompt })
    return {
      text: `${agent.kind} proposal`,
      sessionRef: `${agent.kind}-proposal`,
      collaboration: v4ProposalCollaboration(agent.kind),
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'V4 one proposal round', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Stop after independent proposals.',
    mode: 'auto',
    targetKinds: ['codex', 'hermes'],
    maxRounds: 1,
    protocol: 'v4',
  })
  const controller = workspace.activeRuns.get(group.id)
  await controller.promise

  assert.deepEqual(calls.map(call => call.phase), ['proposal', 'proposal'])
  assert.equal(calls.every(call => /Role: participant/.test(call.prompt)), true)
  assert.equal(calls.every(call => !/Role: (?:primary|reviewer|worker|synthesizer|verifier)/.test(call.prompt)), true)
  assert.equal(ledger.get(controller.runId).status, 'round-limit')
  assert.deepEqual(
    workspace.snapshot().messages.filter(message => message.role === 'agent')
      .map(message => message.content),
    ['codex proposal', 'hermes proposal'],
  )
})

test('V4 Auto accepts visible proposal text when an Agent omits its structured receipt', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  options.runAgent = async (agent, prompt) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    calls.push({ kind: agent.kind, phase, prompt })
    return {
      text: `${agent.kind} visible proposal without a receipt`,
      sessionRef: `${agent.kind}-proposal`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'V4 visible proposal fallback', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Collect both visible proposals.',
    mode: 'auto',
    targetKinds: ['codex', 'hermes'],
    maxRounds: 1,
    protocol: 'v4',
  })
  const controller = workspace.activeRuns.get(group.id)
  await controller.promise

  assert.deepEqual(calls.map(call => call.phase), ['proposal', 'proposal'])
  assert.equal(ledger.get(controller.runId).status, 'round-limit')
  assert.equal(workspace.snapshot().messages.some(message => (
    message.threadRootId === controller.threadRootId
      && /LOCAL_RUN_COLLABORATION_RECEIPT/.test(message.content)
  )), false)
})

test('V4 Auto exposes successful proposals when a peer fails in the same batch', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  options.runAgent = async (agent) => {
    if (agent.kind === 'openclaw') throw new Error('HTTP 401: Invalid token')
    return {
      text: 'Codex retained proposal',
      sessionRef: 'codex-proposal',
      collaboration: v4ProposalCollaboration(agent.kind),
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'V4 partial proposal visibility', agentKinds: ['codex', 'openclaw'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Keep successful proposals visible if one Agent fails.',
    mode: 'auto',
    targetKinds: ['codex', 'openclaw'],
    protocol: 'v4',
  })
  const controller = workspace.activeRuns.get(group.id)
  await controller.promise

  const durable = ledger.get(controller.runId)
  assert.equal(durable.status, 'partial')
  assert.equal(workspace.snapshot().messages.some(message => (
    message.role === 'agent'
      && message.agentKind === 'codex'
      && message.threadRootId === controller.threadRootId
      && message.content === 'Codex retained proposal'
  )), true)
})

test('V4 Auto commits each completed proposal while a peer is still running', async (t) => {
  const { directory, options } = fixture()
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  const releaseCodex = deferred()
  const releaseHermes = deferred()
  const codexCompleted = deferred()
  let workspace = null
  let group = null
  let controller = null
  t.after(async () => {
    releaseCodex.resolve()
    releaseHermes.resolve()
    if (workspace && group && controller && workspace.activeRuns.has(group.id)) {
      workspace.stop(group.id, controller.runId)
    }
    try { await controller?.promise } catch {}
    fs.rmSync(directory, { recursive: true, force: true })
  })
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 2, workspaceLimit: 2, globalLimit: 2 })
  options.runAgent = async (agent) => {
    await (agent.kind === 'codex' ? releaseCodex.promise : releaseHermes.promise)
    return {
      text: `${agent.kind} durable proposal`,
      sessionRef: `${agent.kind}-proposal`,
      collaboration: v4ProposalCollaboration(agent.kind),
    }
  }
  workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const checkpointPhase = workspace.autoRunner.v4CheckpointPhase.bind(workspace.autoRunner)
  workspace.autoRunner.v4CheckpointPhase = (...args) => {
    const record = checkpointPhase(...args)
    if (args[2]?.phase === 'proposal' && args[2]?.slots?.some(slot => (
      slot.agentKind === 'codex' && slot.status === 'completed'
    ))) codexCompleted.resolve()
    return record
  }
  group = workspace.createGroup({
    name: 'V4 immediate proposal commit', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Publish each proposal as soon as it completes.',
    mode: 'auto',
    targetKinds: ['codex', 'hermes'],
    maxRounds: 1,
    protocol: 'v4',
  })
  controller = workspace.activeRuns.get(group.id)
  controller.promise.catch(() => {})
  releaseCodex.resolve()
  await codexCompleted.promise

  assert.equal(workspace.snapshot().messages.some(message => (
    message.role === 'agent'
      && message.agentKind === 'codex'
      && message.threadRootId === controller.threadRootId
      && message.content === 'codex durable proposal'
  )), true)
  assert.equal(ledger.get(controller.runId).orchestration.slots.find(slot => (
    slot.agentKind === 'hermes'
  )).status, 'running')
})

test('V4 Auto commits each completed challenge before the next reviewer settles', async (t) => {
  const { directory, options } = fixture()
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  const hermesChallengeStarted = deferred()
  const releaseHermesChallenge = deferred()
  let workspace = null
  let group = null
  let controller = null
  t.after(async () => {
    releaseHermesChallenge.resolve()
    if (workspace && group && controller && workspace.activeRuns.has(group.id)) {
      workspace.stop(group.id, controller.runId)
    }
    try { await controller?.promise } catch {}
    fs.rmSync(directory, { recursive: true, force: true })
  })
  options.runLedger = ledger
  options.runAgent = async (agent, prompt) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    if (phase === 'challenge' && agent.kind === 'hermes') {
      hermesChallengeStarted.resolve()
      await releaseHermesChallenge.promise
    }
    return {
      text: `${agent.kind} ${phase}`,
      sessionRef: `${agent.kind}-${phase}`,
      collaboration: phase === 'proposal'
        ? v4ProposalCollaboration(agent.kind)
        : agreedV4Collaboration(agent.kind, phase, prompt, ['codex', 'hermes']),
    }
  }
  workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  group = workspace.createGroup({
    name: 'V4 immediate challenge commit', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Publish each challenge before the next reviewer finishes.',
    mode: 'auto',
    targetKinds: ['codex', 'hermes'],
    maxRounds: 2,
    protocol: 'v4',
  })
  controller = workspace.activeRuns.get(group.id)
  controller.promise.catch(() => {})
  await hermesChallengeStarted.promise

  assert.equal(workspace.snapshot().messages.some(message => (
    message.role === 'agent'
      && message.agentKind === 'codex'
      && message.threadRootId === controller.threadRootId
      && message.content === 'codex challenge'
  )), true)
  assert.equal(ledger.get(controller.runId).orchestration.phase, 'challenge')
})

test('V4 Auto continues to round two with healthy Agents after a proposal peer fails', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  options.retrySleep = async () => {}
  options.runAgent = async (agent, prompt) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    calls.push({ kind: agent.kind, phase })
    if (phase === 'proposal' && agent.kind === 'openclaw') {
      throw new Error('LOCAL_AGENT_PROCESS_FAILED')
    }
    const collaboration = phase === 'proposal'
      ? v4ProposalCollaboration(agent.kind)
      : agreedV4Collaboration(agent.kind, phase, prompt, ['codex', 'hermes'])
    if (phase === 'challenge') {
      collaboration.proposedAssignments[0].objective += ` ${agent.kind}`
    }
    return {
      text: `${agent.kind} ${phase}`,
      sessionRef: `${agent.kind}-${phase}`,
      collaboration,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'V4 degraded proposal continuation',
    agentKinds: ['codex', 'openclaw', 'hermes'],
    workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Continue with the healthy participants after one proposal fails.',
    mode: 'auto',
    targetKinds: ['codex', 'openclaw', 'hermes'],
    maxRounds: 2,
    protocol: 'v4',
  })
  const controller = workspace.activeRuns.get(group.id)
  await controller.promise

  assert.deepEqual(
    calls.filter(call => call.phase === 'challenge').map(call => call.kind),
    ['codex', 'hermes'],
  )
  assert.deepEqual(workspace.getGroup(group.id).agentKinds, ['codex', 'openclaw', 'hermes'])
  const durable = ledger.get(controller.runId)
  assert.equal(durable.currentRound, 2)
  assert.deepEqual(durable.orchestration.snapshot.targetKinds, ['codex', 'openclaw', 'hermes'])
  assert.deepEqual(durable.orchestration.activeKinds, ['codex', 'hermes'])
  assert.equal(durable.status, 'round-limit')
  assert.deepEqual(
    workspace.snapshot().messages.filter(message => (
      message.role === 'agent' && message.threadRootId === controller.threadRootId
    )).map(message => [message.agentKind, message.content]),
    [
      ['codex', 'codex proposal'],
      ['hermes', 'hermes proposal'],
      ['codex', 'codex challenge'],
      ['hermes', 'hermes challenge'],
    ],
  )
})

test('V4 Auto isolates a heartbeat-only proposal Agent without deleting group membership', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  options.runAgentTimeoutMs = 20
  options.runAbortGraceMs = 20
  options.retrySleep = async () => {}
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    calls.push({ kind: agent.kind, phase })
    if (agent.kind === 'openclaw') {
      await new Promise((resolve, reject) => {
        const abort = () => reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED'))
        if (runOptions.signal.aborted) abort()
        else runOptions.signal.addEventListener('abort', abort, { once: true })
        const heartbeat = setInterval(() => runOptions.onActivity(), 1)
        runOptions.signal.addEventListener('abort', () => clearInterval(heartbeat), { once: true })
      })
    }
    const collaboration = phase === 'proposal'
      ? v4ProposalCollaboration(agent.kind)
      : agreedV4Collaboration(agent.kind, phase, prompt, ['codex', 'hermes'])
    return {
      text: `${agent.kind} ${phase}`,
      sessionRef: `${agent.kind}-${phase}`,
      collaboration,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'V4 heartbeat-only proposal isolation',
    agentKinds: ['codex', 'openclaw', 'hermes'],
    workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Continue with healthy peers after one Agent stops responding.',
    mode: 'auto',
    targetKinds: ['codex', 'openclaw', 'hermes'],
    maxRounds: 2,
    protocol: 'v4',
  })
  const controller = workspace.activeRuns.get(group.id)
  await controller.promise

  assert.deepEqual(
    calls.filter(call => call.phase === 'challenge').map(call => call.kind),
    ['codex', 'hermes'],
  )
  assert.deepEqual(workspace.getGroup(group.id).agentKinds, ['codex', 'openclaw', 'hermes'])
  assert.equal(ledger.get(controller.runId).currentRound, 2)
  assert.equal(workspace.snapshot().messages.some(message => (
    message.agentKind === 'openclaw' && message.system?.key === 'system.agentCallFailed'
  )), true)
  assert.equal(workspace.snapshot().messages.some(message => (
    message.agentKind === 'openclaw' && message.system?.key === 'system.agentRemovedAfterFailure'
  )), false)
})

test('V4 Auto publishes one visible message per Agent in every bounded discussion round', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  const challengeCounts = new Map()
  options.runAgent = async (agent, prompt) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    const round = phase === 'proposal'
      ? 1
      : 2 + (challengeCounts.get(agent.kind) || 0)
    if (phase === 'challenge') challengeCounts.set(agent.kind, round - 1)
    calls.push({ kind: agent.kind, phase, round })
    const collaboration = phase === 'proposal'
      ? v4ProposalCollaboration(agent.kind)
      : agreedV4Collaboration(agent.kind, phase, prompt, ['codex', 'openclaw', 'hermes'])
    if (phase === 'challenge') {
      collaboration.proposedAssignments[0].objective += ` ${agent.kind} round ${round}`
    }
    return {
      text: `${agent.kind} round ${round} ${phase}`,
      sessionRef: `${agent.kind}-${round}-${phase}`,
      collaboration,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'V4 visible bounded rounds',
    agentKinds: ['codex', 'openclaw', 'hermes'],
    workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Publish every contribution across three bounded rounds.',
    mode: 'auto',
    targetKinds: ['codex', 'openclaw', 'hermes'],
    maxRounds: 3,
    protocol: 'v4',
  })
  const controller = workspace.activeRuns.get(group.id)
  await controller.promise

  assert.deepEqual(calls.map(call => [call.kind, call.phase, call.round]), [
    ['codex', 'proposal', 1],
    ['openclaw', 'proposal', 1],
    ['hermes', 'proposal', 1],
    ['codex', 'challenge', 2],
    ['openclaw', 'challenge', 2],
    ['hermes', 'challenge', 2],
    ['codex', 'challenge', 3],
    ['openclaw', 'challenge', 3],
    ['hermes', 'challenge', 3],
  ])
  assert.deepEqual(
    workspace.snapshot().messages.filter(message => (
      message.role === 'agent' && message.threadRootId === controller.threadRootId
    )).map(message => message.content),
    [
      'codex round 1 proposal',
      'openclaw round 1 proposal',
      'hermes round 1 proposal',
      'codex round 2 challenge',
      'openclaw round 2 challenge',
      'hermes round 2 challenge',
      'codex round 3 challenge',
      'openclaw round 3 challenge',
      'hermes round 3 challenge',
    ],
  )
  const visible = workspace.snapshot().messages.filter(message => (
    message.role === 'agent' && message.threadRootId === controller.threadRootId
  ))
  assert.deepEqual(visible.map(message => [message.trace.round, message.trace.phase]), [
    [1, 'proposal'], [1, 'proposal'], [1, 'proposal'],
    [2, 'challenge'], [2, 'challenge'], [2, 'challenge'],
    [3, 'challenge'], [3, 'challenge'], [3, 'challenge'],
  ])
  assert.equal(new Set(visible.map(message => message.responseVersionRootId)).size, 9)
  assert.equal(ledger.get(controller.runId).status, 'round-limit')
  assert.equal(ledger.get(controller.runId).currentRound, 3)
})

test('V4 Auto freezes all thirty-two proposal dispatches before the first constrained lease', async (t) => {
  const { directory, calls, options } = fixture()
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  const kinds = Array.from({ length: 32 }, (_value, index) => (
    `custom-${(index + 1).toString(16).padStart(16, '0')}`
  ))
  const promptsBuilt = []
  let promptsAtFirstDispatch = 0
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.detectAgents = async () => kinds.map((kind, index) => ({
    kind, name: `Agent ${index + 1}`, executable: `/tmp/${kind}`, version: '1',
  }))
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 1, workspaceLimit: 1, globalLimit: 1 })
  options.runAgent = async (agent, prompt) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    calls.push({ kind: agent.kind, phase, prompt })
    return {
      text: `${agent.kind} ${phase}`,
      sessionRef: `${agent.kind}-${phase}`,
      collaboration: v4ProposalCollaboration(agent.kind),
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const buildPrompt = workspace.autoRunner.v4PhasePrompt.bind(workspace.autoRunner)
  workspace.autoRunner.v4PhasePrompt = (...args) => {
    if (args[2] === 'proposal') promptsBuilt.push(args[1])
    return buildPrompt(...args)
  }
  const invokeProposal = workspace.autoRunner.invokeWithUnauthorizedRecovery
    .bind(workspace.autoRunner)
  workspace.autoRunner.invokeWithUnauthorizedRecovery = (input) => {
    if (input.context?.phase === 'proposal' && !promptsAtFirstDispatch) {
      promptsAtFirstDispatch = promptsBuilt.length
    }
    return invokeProposal(input)
  }
  const group = workspace.createGroup({ name: 'V4 thirty-two proposals', agentKinds: kinds, workdir: directory })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Produce independent proposals before any review.',
    mode: 'auto', targetKinds: kinds, maxRounds: 1, protocol: 'v4',
  })
  const controller = workspace.activeRuns.get(group.id)
  await controller.promise

  assert.equal(promptsAtFirstDispatch, 32, 'all proposal prompts existed before the first dispatch')
  assert.equal(promptsBuilt.length, 32)
  assert.equal(new Set(promptsBuilt).size, 32)
  assert.equal(calls[0].kind, kinds[0])
  assert.equal(calls.length, 32)
  assert.equal(calls.every(call => call.phase === 'proposal'), true)
  assert.equal(new Set(calls.map(call => call.kind)).size, 32)
  assert.equal(new Set(
    ledger.get(controller.runId).orchestration.slots.map(slot => slot.snapshotHash),
  ).size, 1)
})

test('V4 Auto checkpoints a completed proposal before a queued peer and recovers only the peer', async (t) => {
  const { directory, options } = fixture()
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  const codexReturned = deferred()
  const releaseHermes = deferred()
  let workspace = null
  let group = null
  let controller = null
  t.after(async () => {
    if (workspace && group && controller && workspace.activeRuns.has(group.id)) {
      workspace.stop(group.id, controller.runId)
    }
    releaseHermes.resolve()
    try { await controller?.promise } catch {}
    fs.rmSync(directory, { recursive: true, force: true })
  })
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 1, workspaceLimit: 1, globalLimit: 1 })
  options.runAgent = async (agent, prompt) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    if (agent.kind === 'codex') codexReturned.resolve()
    if (agent.kind === 'hermes') await releaseHermes.promise
    return {
      text: `${agent.kind} ${phase}`,
      sessionRef: `${agent.kind}-${phase}`,
      collaboration: v4ProposalCollaboration(agent.kind),
    }
  }
  workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  group = workspace.createGroup({
    name: 'V4 partial proposal checkpoint', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  await workspace.sendMessage({
    groupId: group.id,
    text: 'Persist each safe proposal before the barrier completes.',
    mode: 'auto', targetKinds: ['codex', 'hermes'], maxRounds: 1, protocol: 'v4',
  })
  controller = workspace.activeRuns.get(group.id)
  controller.promise.catch(() => {})
  await codexReturned.promise
  await new Promise(resolve => setImmediate(resolve))

  const partial = ledger.get(controller.runId)
  assert.equal(partial.orchestration.phase, 'proposal')
  assert.equal(partial.orchestration.slots.find(slot => slot.agentKind === 'codex').status, 'completed')
  assert.match(
    partial.orchestration.slots.find(slot => slot.agentKind === 'hermes').status,
    /^(?:planned|queued|running)$/,
  )

  const recoveryLedger = new RunLedger({ storagePath: path.join(directory, 'run-ledger-recovery.json') })
  recoveryLedger.checkpoint(partial)
  workspace.stop(group.id, controller.runId)
  releaseHermes.resolve()
  await controller.promise
  const recoveryCalls = []
  const recovered = new LocalWorkspace({
    ...options,
    runLedger: recoveryLedger,
    runAgent: async (agent, prompt) => {
      const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
      recoveryCalls.push({ kind: agent.kind, phase })
      return {
        text: `${agent.kind} ${phase}`,
        sessionRef: `${agent.kind}-${phase}-recovered`,
        outcome: 'completed',
        collaboration: v4ProposalCollaboration(agent.kind, `${agent.kind} recovered proposal`),
      }
    },
  })
  await recovered.refreshAgents()
  const recoveredController = recovered.createRunController(
    'auto', partial.targetKinds, partial.threadRootId, partial.maxRounds, partial.unlimitedRounds,
  )
  recoveredController.runId = partial.runId
  recoveredController.taskId = partial.taskId
  recoveredController.contextPackId = partial.contextPackId
  recoveredController.taskBound = true
  recoveredController.groupId = partial.groupId
  recoveredController.currentRound = partial.currentRound
  recoveredController.orchestration = structuredClone(partial.orchestration)
  recoveredController.v4 = true
  recovered.activeRuns.set(group.id, recoveredController)
  const status = await recovered.autoRunner.runV4Discussion(
    recovered.getGroup(group.id), recoveredController, partial.threadRootId,
    {
      rootAttachments: [],
      rootSkillsByKind: new Map(partial.targetKinds.map(kind => [kind, []])),
      rootKnowledgeBasesByKind: new Map(partial.targetKinds.map(kind => [kind, []])),
      rootMediaRequest: null,
    }, true,
  )

  assert.equal(status, 'round-limit')
  assert.deepEqual(recoveryCalls.map(call => call.kind), ['hermes'])
  assert.deepEqual(recoveryCalls.map(call => call.phase), ['proposal'])
})

test('V4 Auto rejects unsuccessful proposal receipts before the round-two barrier', async (t) => {
  for (const proposalStatus of ['rejected', 'needs-review']) {
    await t.test(proposalStatus, async (t) => {
      const { directory, calls, options } = fixture()
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
      const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
      options.runLedger = ledger
      options.runAgent = async (agent, prompt) => {
        const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
        calls.push({ kind: agent.kind, phase })
        return {
          text: `${agent.kind} ${phase}`,
          sessionRef: `${agent.kind}-${phase}`,
          collaboration: v4ProposalCollaboration(agent.kind),
        }
      }
      const workspace = new LocalWorkspace(options)
      await workspace.refreshAgents()
      const receiptForResult = workspace.autoRunner.v4ReceiptForResult.bind(workspace.autoRunner)
      workspace.autoRunner.v4ReceiptForResult = (...args) => {
        const receiptRecord = receiptForResult(...args)
        return args[1] === 'proposal' && args[2] === 'hermes'
          ? {
              ...receiptRecord,
              receipt: { ...receiptRecord.receipt, status: proposalStatus },
            }
          : receiptRecord
      }
      const group = workspace.createGroup({
        name: `V4 ${proposalStatus} proposal barrier`, agentKinds: ['codex', 'hermes'], workdir: directory,
      })
      await workspace.sendMessage({
        groupId: group.id,
        text: 'Do not advance rejected proposals.',
        mode: 'auto', targetKinds: ['codex', 'hermes'], protocol: 'v4',
      })
      const controller = workspace.activeRuns.get(group.id)
      await controller.promise

      assert.deepEqual(calls.map(call => call.phase), ['proposal', 'proposal'])
      assert.equal(ledger.get(controller.runId).status, 'partial')
      assert.equal(ledger.get(controller.runId).orchestration.phase, 'proposal')
      assert.deepEqual(
        workspace.snapshot().messages
          .filter(message => message.role === 'agent')
          .map(message => [message.agentKind, message.content]),
        [['codex', 'codex proposal']],
      )
    })
  }
})

test('V4 Auto recovery resumes completed proposal barriers at round-two challenges', async (t) => {
  const { directory, options } = fixture()
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath })
  const firstChallenge = deferred()
  const releaseFirstChallenges = deferred()
  const initialCalls = []
  let initial = null
  let group = null
  let controller = null
  t.after(async () => {
    releaseFirstChallenges.resolve()
    if (initial && group && controller && initial.activeRuns.has(group.id)) {
      initial.stop(group.id, controller.runId)
      try { await controller.promise } catch {}
    }
    fs.rmSync(directory, { recursive: true, force: true })
  })
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 2, workspaceLimit: 2, globalLimit: 2 })
  options.runAgent = async (agent, prompt) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    initialCalls.push({ kind: agent.kind, phase })
    if (phase === 'challenge') {
      firstChallenge.resolve()
      await releaseFirstChallenges.promise
    }
    return {
      text: `${agent.kind} ${phase}`,
      sessionRef: `${agent.kind}-${phase}`,
      collaboration: phase === 'proposal'
        ? v4ProposalCollaboration(agent.kind)
        : { version: 1, phase, verdict: 'support', summary: `${agent.kind} review` },
    }
  }
  initial = new LocalWorkspace(options)
  await initial.refreshAgents()
  group = initial.createGroup({
    name: 'V4 restart proposal barrier', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  await initial.sendMessage({
    groupId: group.id,
    text: 'Resume only after the proposal barrier.',
    mode: 'auto', targetKinds: ['codex', 'hermes'], protocol: 'v4',
  })
  controller = initial.activeRuns.get(group.id)
  controller.promise.catch(() => {})
  await firstChallenge.promise
  const checkpoint = ledger.get(controller.runId)
  assert.equal(checkpoint.orchestration.phase, 'challenge')
  assert.equal(checkpoint.orchestration.round, 2)
  assert.equal(checkpoint.orchestration.challengeBindings.length, 2)
  assert.equal(checkpoint.orchestration.synthesisBinding, undefined)
  const checkpointBindings = structuredClone(checkpoint.orchestration.challengeBindings)
  assert.deepEqual(initialCalls.map(call => [call.kind, call.phase]), [
    ['codex', 'proposal'],
    ['hermes', 'proposal'],
    ['codex', 'challenge'],
  ])

  const recoveryLedger = new RunLedger({ storagePath: path.join(directory, 'run-ledger-recovery.json') })
  recoveryLedger.checkpoint(checkpoint)
  initial.stop(group.id, controller.runId)
  releaseFirstChallenges.resolve()
  await controller.promise
  const recoveryCalls = []
  const recoveredChallenge = deferred()
  const releaseRecoveredChallenge = deferred()
  const recovered = new LocalWorkspace({
    ...options,
    runLedger: recoveryLedger,
    runAgent: async (agent, prompt) => {
      const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
      recoveryCalls.push({ kind: agent.kind, phase, prompt })
      if (phase === 'challenge') {
        recoveredChallenge.resolve()
        await releaseRecoveredChallenge.promise
      }
      return {
        text: `${agent.kind} ${phase}`,
        sessionRef: `${agent.kind}-${phase}-recovered`,
        collaboration: phase === 'challenge'
          ? { version: 1, phase, verdict: 'support', summary: `${agent.kind} review` }
          : v4ProposalCollaboration(agent.kind),
      }
    },
  })
  await recovered.refreshAgents()
  const recoveredController = recovered.createRunController(
    'auto', checkpoint.targetKinds, checkpoint.threadRootId,
    checkpoint.maxRounds, checkpoint.unlimitedRounds,
  )
  recoveredController.runId = checkpoint.runId
  recoveredController.taskId = checkpoint.taskId
  recoveredController.contextPackId = checkpoint.contextPackId
  recoveredController.taskBound = true
  recoveredController.groupId = checkpoint.groupId
  recoveredController.currentRound = checkpoint.currentRound
  recoveredController.orchestration = structuredClone(checkpoint.orchestration)
  recoveredController.v4 = true
  recovered.activeRuns.set(group.id, recoveredController)
  const resumed = recovered.autoRunner.runV4Discussion(
    recovered.getGroup(group.id),
    recoveredController,
    checkpoint.threadRootId,
    await recovered.autoRunner.automaticContext(
      recovered.getGroup(group.id), recoveredController, checkpoint.threadRootId,
    ),
    true,
  )
  await recoveredChallenge.promise

  assert.equal(recoveryCalls.length >= 1, true)
  assert.equal(recoveryCalls.every(call => call.phase === 'challenge'), true)
  assert.deepEqual(recoveredController.orchestration.challengeBindings, checkpointBindings)
  for (const call of recoveryCalls) {
    const binding = checkpointBindings.find(item => item.reviewerKind === call.kind)
    assert.match(
      call.prompt,
      new RegExp(`Coverage responsibility: explicitly incorporate or challenge ${binding.proposalKind}`),
    )
  }
  assert.equal(recoveredController.currentRound, 2)
  recoveredController.abort()
  releaseRecoveredChallenge.resolve()
  await resumed

  const invalid = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: path.join(directory, 'run-ledger-invalid.json') }),
  })
  await invalid.refreshAgents()
  const invalidController = invalid.createRunController(
    'auto', checkpoint.targetKinds, checkpoint.threadRootId,
    checkpoint.maxRounds, checkpoint.unlimitedRounds,
  )
  invalidController.runId = checkpoint.runId
  invalidController.taskId = checkpoint.taskId
  invalidController.contextPackId = checkpoint.contextPackId
  invalidController.taskBound = true
  invalidController.groupId = checkpoint.groupId
  invalidController.currentRound = checkpoint.currentRound
  invalidController.orchestration = structuredClone(checkpoint.orchestration)
  delete invalidController.orchestration.challengeBindings
  invalidController.v4 = true
  const invalidContext = await invalid.autoRunner.automaticContext(
    invalid.getGroup(group.id), invalidController, checkpoint.threadRootId,
  )
  await assert.rejects(() => invalid.autoRunner.runV4Discussion(
    invalid.getGroup(group.id),
    invalidController,
    checkpoint.threadRootId,
    invalidContext,
    true,
  ), { message: 'LOCAL_RUN_V4_CHALLENGE_BINDING_REQUIRED' })
})

test('unlimited task graphs give isolated reviewers the adversarial review contract too', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: `${agent.kind} typed conclusion`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
      outcomeRefs: {
        artifactIds: [`artifact-${agent.kind}`],
        evidenceIds: [`evidence-${agent.kind}`],
      },
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '严格任务图',
    agentKinds: ['codex', 'hermes', 'workbuddy', 'kimi'],
    workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: '严格审核发布准备情况',
    mode: 'auto',
    targetKinds: ['codex', 'hermes', 'workbuddy', 'kimi'],
    workflow: evidenceTaskGraph(),
    unlimitedRounds: true,
  })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), [
    'codex', 'hermes', 'workbuddy', 'kimi',
  ])
  for (const call of calls) {
    assert.match(call.prompt, /MELDWORK_UNLIMITED_REVIEW_V1/)
    assert.match(call.prompt, /Raise every material defect immediately/)
  }
})

test('bounded automatic discussion does not use the unlimited adversarial review contract', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: `${agent.kind} agrees\n[[MELDWORK_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '固定轮数', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: '按固定轮数审核这项方案',
    mode: 'auto',
    targetKinds: ['codex', 'hermes'],
    maxRounds: 1,
  })
  await workspace.activeRuns.get(group.id).promise

  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.doesNotMatch(call.prompt, /MELDWORK_UNLIMITED_REVIEW_V1/)
  }
})

test('unlimited automatic discussion stops at the mandatory Agent-attempt circuit breaker', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: `${agent.kind} keeps going\n[[MELDWORK_CONSENSUS:continue]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Mandatory circuit breaker', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  const root = workspace.addMessage(group.id, 'user', 'Continue forever')
  workspace.startAuto({ groupId: group.id, threadRootId: root.id, unlimitedRounds: true })
  await workspace.activeRuns.get(group.id).promise

  assert.equal(calls.length, MAX_RUN_AGENT_ATTEMPTS)
  assert.equal(finished[0].status, 'circuit-breaker')
  const terminal = ledger.list(group.id)[0]
  assert.equal(terminal.status, 'circuit-breaker')
  assert.equal(terminal.reason, 'circuit_breaker')
  assert.equal(terminal.attemptHistory.length, MAX_RUN_AGENT_ATTEMPTS)
  assert.equal(workspace.snapshot().messages.some(message => (
    message.system?.key === 'system.runCircuitBreaker'
      && message.system.params.maxAttempts === MAX_RUN_AGENT_ATTEMPTS
  )), true)

  const storedWorkspace = JSON.parse(fs.readFileSync(options.storagePath, 'utf8'))
  storedWorkspace.messages = storedWorkspace.messages.filter(message => (
    message.system?.key !== 'system.runCircuitBreaker'
  ))
  fs.writeFileSync(options.storagePath, JSON.stringify(storedWorkspace), 'utf8')
  const restarted = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') }),
  })
  assert.equal(restarted.snapshot().messages.some(message => (
    message.system?.key === 'system.runCircuitBreaker'
  )), true)
})

test('transient retries cannot exceed the mandatory Agent-attempt circuit breaker', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const firstCallEntered = deferred()
  const releaseFirstCall = deferred()
  options.retrySleep = async () => {}
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    firstCallEntered.resolve()
    await releaseFirstCall.promise
    throw Object.assign(new Error('Provider temporarily unavailable'), { statusCode: 503 })
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Retry circuit breaker', agentKinds: ['hermes', 'codex'], workdir: directory,
    allowWrite: false,
  })
  workspace.addMessage(group.id, 'user', 'Do not exceed the retry ceiling')

  workspace.startAuto({ groupId: group.id, unlimitedRounds: true })
  const active = workspace.activeRuns.get(group.id)
  await firstCallEntered.promise
  active.attemptHistory = Array.from({ length: MAX_RUN_AGENT_ATTEMPTS - 1 }, (_, index) => ({
    sequence: index + 1,
  }))
  releaseFirstCall.resolve()
  await active.promise

  assert.equal(calls.length, 1)
  assert.equal(active.attemptHistory.length, MAX_RUN_AGENT_ATTEMPTS)
  assert.equal(finished[0].status, 'circuit-breaker')
  assert.equal(workspace.snapshot().messages.some(message => (
    message.system?.key === 'system.runCircuitBreaker'
  )), true)
})

test('later group rounds use a compact Harness continuation instead of the bootstrap template', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    const consensus = calls.length > 2 ? 'agree' : 'continue'
    return {
      text: `${agent.kind} round ${calls.length}\n[[MELDWORK_CONSENSUS:${consensus}]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '续接上下文',
    topic: '固定主题不应在每一轮重复发送',
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
  })

  const started = await workspace.sendMessage({
    groupId: group.id,
    text: '请围绕这个主题进行两轮讨论',
    mode: 'auto',
    maxRounds: 2,
  })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes', 'codex', 'hermes'])
  assert.match(calls[0].prompt, /You are participating in the local/)
  assert.match(calls[0].prompt, /Group topic: 固定主题/)
  assert.match(calls[2].prompt, /Harness-compressed shared context/)
  assert.doesNotMatch(calls[2].prompt, /You are participating in the local|Group topic:/)
  assert.doesNotMatch(calls[2].prompt, /Deliverable capture contract|Stable user instructions and constraints:/)
  assert.match(calls[2].prompt, /\[claim\].*hermes round 2/)
  assert.match(calls[2].prompt, /请围绕这个主题进行两轮讨论/)
  assert.ok(calls[2].prompt.length < 12000)
  assert.equal(calls[2].runOptions.sessionRef, 'codex-session')
  assert.equal(calls[3].runOptions.sessionRef, 'hermes-session')

  const root = workspace.snapshot().messages.find(message => message.id === started.threadRootId)
  const codexReplies = workspace.snapshot().messages.filter(message => (
    message.role === 'agent' && message.agentKind === 'codex'
  ))
  assert.equal(root.content, '请围绕这个主题进行两轮讨论')
  assert.equal(codexReplies.at(-1).trace.context.contextMode, 'continuation')
  assert.equal(codexReplies.at(-1).trace.context.promptChars, calls[2].prompt.length)
})

test('auto send rejects failed preflight without persisting a root or starting an Agent', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.validateSkillSelections = () => { throw new Error('LOCAL_SKILL_SELECTION_INVALID') }
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '自动预检失败', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  await assert.rejects(workspace.sendMessage({
    groupId: group.id,
    text: '不应持久化',
    mode: 'auto',
    targetKinds: ['codex', 'hermes'],
    skillHints: [{
      targetKind: 'hermes', namespace: 'global', slug: 'research', name: 'Research',
    }],
  }), { message: 'LOCAL_SKILL_SELECTION_INVALID' })

  assert.equal(calls.length, 0)
  assert.equal(workspace.snapshot().messages.length, 0)
  assert.deepEqual(workspace.snapshot().runningGroupIds, [])
  assert.deepEqual(workspace.snapshot().runs, [])
  assert.deepEqual(ledger.list(group.id), [])
  assert.deepEqual(finished, [])
})

test('auto send rolls back its root when the reserved run is cancelled during handoff', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  const finished = []
  let stopped = false
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '自动交接取消', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  workspace.on('changed', (snapshot) => {
    if (stopped || !snapshot.messages.some(message => message.role === 'user')) return
    if (!snapshot.runs.some(run => run.groupId === group.id && run.phase === 'preparing')) return
    stopped = true
    const run = snapshot.runs.find(item => item.groupId === group.id)
    workspace.stop(group.id, run.runId)
  })

  await assert.rejects(workspace.sendMessage({
    groupId: group.id,
    text: '取消时不应留下消息',
    mode: 'auto',
    maxRounds: 2,
  }), { message: 'LOCAL_AGENT_EXECUTION_STOPPED' })

  assert.equal(stopped, true)
  assert.equal(calls.length, 0)
  assert.equal(workspace.snapshot().messages.length, 0)
  assert.deepEqual(workspace.snapshot().runningGroupIds, [])
  assert.deepEqual(finished, [])
})

test('auto handoff rollback keeps memory and disk aligned when its save fails', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  let stopped = false
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '自动交接回滚失败', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  workspace.on('changed', (snapshot) => {
    if (stopped || !snapshot.messages.some(message => message.role === 'user')) return
    const run = snapshot.runs.find(item => item.groupId === group.id && item.phase === 'preparing')
    if (!run) return
    stopped = true
    workspace.stop(group.id, run.runId)
  })

  const originalSave = workspace.conversations.save
  let conversationSaveCalls = 0
  workspace.conversations.save = () => {
    conversationSaveCalls += 1
    if (conversationSaveCalls === 2) throw new Error('ROLLBACK_SAVE_FAILED')
    return originalSave()
  }

  let failure
  try {
    await workspace.sendMessage({
      groupId: group.id,
      text: '回滚失败时保留已落盘的消息',
      mode: 'auto',
      maxRounds: 2,
    })
  } catch (error) {
    failure = error
  }

  assert.equal(failure?.message, 'LOCAL_AGENT_EXECUTION_STOPPED')
  assert.equal(failure?.rollbackError?.message, 'ROLLBACK_SAVE_FAILED')
  assert.equal(stopped, true)
  assert.equal(calls.length, 0)
  assert.equal(conversationSaveCalls, 2)
  assert.equal(workspace.snapshot().messages.length, 1)
  assert.deepEqual(workspace.snapshot().runningGroupIds, [])

  const reloaded = new LocalWorkspace(options)
  assert.equal(reloaded.snapshot().messages.length, 1)
  assert.equal(reloaded.snapshot().messages[0].content, '回滚失败时保留已落盘的消息')
})

test('automatic dialogue continues complete rounds until every Agent agrees', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const replies = [
    'Codex still has one edge case.\n[[MELDWORK_CONSENSUS:continue]]',
    'Hermes agrees that clarification is needed.\n[[MELDWORK_CONSENSUS:continue]]',
    'Codex accepts the current conclusion.\n[[MELDWORK_CONSENSUS:agree]]',
    'Hermes accepts the current conclusion.\n[[MELDWORK_CONSENSUS:agree]]',
  ]
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: replies[calls.length - 1],
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '自动讨论', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const root = workspace.addMessage(group.id, 'user', '讨论本地 Agent 架构')
  workspace.startAuto({ groupId: group.id, maxRounds: 4 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes', 'codex', 'hermes'])
  assert.deepEqual(calls.map(call => call.runOptions.sessionRef), [
    '', '', 'codex-session', 'hermes-session',
  ])
  assert.equal(calls.every(call => call.prompt.includes('[[MELDWORK_CONSENSUS:agree]]')), true)
  assert.deepEqual(
    workspace.snapshot().messages.filter(message => message.role === 'agent')
      .map(message => message.threadRootId),
    [root.id, root.id, root.id, root.id],
  )
  assert.deepEqual(
    workspace.snapshot().messages.filter(message => message.role === 'agent')
      .map(message => message.content),
    [
      'Codex still has one edge case.',
      'Hermes agrees that clarification is needed.',
      'Codex accepts the current conclusion.',
      'Hermes accepts the current conclusion.',
    ],
  )
  assert.deepEqual(
    workspace.snapshot().messages.filter(message => message.role === 'agent')
      .map(message => message.trace.round),
    [1, 1, 2, 2],
  )
  assert.deepEqual(
    workspace.snapshot().messages.filter(message => message.role === 'agent')
      .map(message => message.trace.executionSequence),
    [1, 2, 3, 4],
  )
  const reloaded = new LocalWorkspace(options)
  await reloaded.refreshAgents()
  assert.deepEqual(
    reloaded.snapshot().messages.filter(message => message.role === 'agent')
      .map(message => message.trace.round),
    [1, 1, 2, 2],
  )
  assert.deepEqual(workspace.snapshot().runningGroupIds, [])
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'completed')
  assert.equal(finished[0].mode, 'auto')
})

test('automatic dialogue persists attempts beyond the live Harness window', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  options.runLedger = new RunLedger({ storagePath: ledgerPath })
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    const consensus = calls.length > 60 ? 'agree' : 'continue'
    return {
      text: `${agent.kind} round result\n[[MELDWORK_CONSENSUS:${consensus}]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Durable automatic history',
    agentKinds: ['codex', 'hermes', 'workbuddy', 'kimi', 'openclaw'],
    workdir: directory,
  })
  workspace.addMessage(group.id, 'user', 'Keep every automatic attempt durable')

  workspace.startAuto({ groupId: group.id, unlimitedRounds: true })
  const runId = workspace.activeRuns.get(group.id).runId
  await workspace.activeRuns.get(group.id).promise

  assert.equal(calls.length, 65)
  const restored = new RunLedger({ storagePath: ledgerPath }).get(runId)
  assert.equal(restored.agentRuns.length, 65)
  assert.equal(restored.agentRuns[0].round, 1)
  assert.equal(restored.agentRuns[0].kind, 'codex')
  assert.equal(restored.agentRuns.at(-1).round, 13)
  assert.equal(restored.agentRuns.at(-1).kind, 'openclaw')
})

test('automatic dialogue reuses Kimi ACP sessions across rounds', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    const agentCallCount = calls.filter(call => call.agent.kind === agent.kind).length
    const consensus = agentCallCount > 1 ? 'agree' : 'continue'
    const sessionRef = agent.kind === 'kimi'
      ? (runOptions.sessionRef || 'kimi-acp-session')
      : (runOptions.sessionRef || `${agent.kind}-session`)
    if (agent.kind === 'kimi') {
      await runOptions.onSessionRef(sessionRef, { transport: 'acp' })
    }
    return {
      text: `${agent.kind} ${consensus}\n[[MELDWORK_CONSENSUS:${consensus}]]`,
      sessionRef,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Kimi ACP discussion', agentKinds: ['codex', 'kimi'], workdir: directory,
  })

  const started = await workspace.sendMessage({
    groupId: group.id,
    text: 'Check ACP session continuity',
    mode: 'auto',
    maxRounds: 2,
  })
  assert.equal(started.started, true)
  await workspace.activeRuns.get(group.id).promise

  const kimiCalls = calls.filter(call => call.agent.kind === 'kimi')
  const kimiSessionKey = workspace.sessionKey(group.id, 'kimi')
  assert.deepEqual(kimiCalls.map(call => call.runOptions.sessionRef), ['', 'kimi-acp-session'])
  assert.deepEqual(kimiCalls.map(call => call.runOptions.sessionTransport), ['', 'acp'])
  assert.equal(workspace.state.sessions[kimiSessionKey], 'kimi-acp-session')
  assert.equal(workspace.state.sessionMeta[kimiSessionKey].transport, 'acp')
})

test('automatic dialogue keeps Hermes on one persistent ACP session across rounds', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    const agentCallCount = calls.filter(call => call.agent.kind === agent.kind).length
    const consensus = agentCallCount > 1 ? 'agree' : 'continue'
    const sessionRef = agent.kind === 'hermes'
      ? (runOptions.sessionRef || 'hermes-acp-session')
      : (runOptions.sessionRef || `${agent.kind}-session`)
    if (agent.kind === 'hermes') {
      await runOptions.onSessionRef(sessionRef, { transport: 'acp' })
    }
    return {
      text: `${agent.kind} ${consensus}\n[[MELDWORK_CONSENSUS:${consensus}]]`,
      sessionRef,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Hermes ACP discussion', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  const started = await workspace.sendMessage({
    groupId: group.id,
    text: 'Check Hermes session continuity',
    mode: 'auto',
    maxRounds: 2,
  })
  assert.equal(started.started, true)
  await workspace.activeRuns.get(group.id).promise

  const hermesCalls = calls.filter(call => call.agent.kind === 'hermes')
  const hermesSessionKey = workspace.sessionKey(group.id, 'hermes')
  assert.deepEqual(hermesCalls.map(call => call.runOptions.sessionRef), ['', 'hermes-acp-session'])
  assert.deepEqual(hermesCalls.map(call => call.runOptions.sessionTransport), ['', 'acp'])
  assert.deepEqual(hermesCalls.map(call => call.runOptions.hermesAcpAvailable), [true, true])
  assert.deepEqual(
    hermesCalls.map(call => call.runOptions.acpPersistenceKey),
    [hermesSessionKey, hermesSessionKey],
  )
  assert.equal(workspace.state.sessions[hermesSessionKey], 'hermes-acp-session')
  assert.equal(workspace.state.sessionMeta[hermesSessionKey].transport, 'acp')
})

test('automatic dialogue keeps an active Agent runnable through a transient catalog outage', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (calls.length === 2) {
      workspace.detectedAgents = workspace.detectedAgents.filter(item => item.kind !== 'openclaw')
    }
    const count = calls.filter(call => call.agent.kind === agent.kind).length
    return {
      text: `${agent.kind} ${count > 1 ? 'agree' : 'continue'}\n[[MELDWORK_CONSENSUS:${count > 1 ? 'agree' : 'continue'}]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Transient catalog outage', agentKinds: ['codex', 'openclaw'], workdir: directory,
  })

  await workspace.sendMessage({ groupId: group.id, text: 'Continue across a transient refresh', mode: 'auto', maxRounds: 2 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'openclaw', 'codex', 'openclaw'])
  assert.equal(workspace.snapshot().messages.some(message => (
    message.agentKind === 'openclaw' && message.system?.key === 'system.agentCallFailed'
  )), false)
})

test('automatic dialogue queues only the explicitly targeted group members', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: `${agent.kind} agrees\n[[MELDWORK_CONSENSUS:agree]]`,
      sessionRef: `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  const runFinished = deferred()
  workspace.on('run-finished', (result) => {
    finished.push(result)
    runFinished.resolve()
  })
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '定向自动讨论',
    agentKinds: ['codex', 'hermes', 'workbuddy', 'kimi', 'openclaw'],
    workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Codex、Hermes 和 Kimi 讨论',
    mode: 'auto',
    targetKinds: ['codex', 'hermes', 'kimi'],
    mentionedAgentKinds: ['codex', 'hermes', 'kimi'],
    maxRounds: 1,
  })
  await runFinished.promise

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes', 'kimi'])
  assert.deepEqual(
    workspace.snapshot().messages.find(message => message.role === 'user')?.targetKinds,
    ['codex', 'hermes', 'kimi'],
  )
  assert.deepEqual(finished[0].targetKinds, ['codex', 'hermes', 'kimi'])

  calls.length = 0
  const nextRoot = workspace.addMessage(group.id, 'user', '另一组继续讨论')
  workspace.startAuto({
    groupId: group.id,
    threadRootId: nextRoot.id,
    targetKinds: ['workbuddy', 'openclaw'],
    maxRounds: 1,
  })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), ['workbuddy', 'openclaw'])
  assert.deepEqual(finished[1].targetKinds, ['workbuddy', 'openclaw'])
})

test('automatic dialogue falls back to staged image files beyond native limits', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const attachmentRoot = path.join(directory, 'attachments')
  fs.mkdirSync(attachmentRoot)
  fs.writeFileSync(path.join(attachmentRoot, 'attachment-auto.png'), Buffer.alloc(128))
  fs.writeFileSync(path.join(attachmentRoot, 'attachment-detail.png'), Buffer.alloc(64))
  options.attachmentSupport = kind => ({
    image: options.imageAttachmentLimit(kind),
    file: 4,
  })
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: `${agent.kind} reply\n[[MELDWORK_CONSENSUS:continue]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '附件自动讨论', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const attachments = [
    { id: 'attachment-auto', name: 'architecture.png', mimeType: 'image/png', size: 128 },
    { id: 'attachment-detail', name: 'detail.png', mimeType: 'image/png', size: 64 },
  ]
  const skill = {
    targetKind: 'hermes', namespace: 'global', slug: 'research', name: 'Research',
  }
  workspace.addMessage(group.id, 'user', '审查这张架构图', '', '', null, {
    attachments, skillHints: [skill],
  })

  workspace.startAuto({ groupId: group.id, maxRounds: 1 })
  await workspace.activeRuns.get(group.id).promise

  const attachmentPath = path.join(directory, 'attachments', 'attachment-auto.png')
  const detailPath = path.join(directory, 'attachments', 'attachment-detail.png')
  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes'])
  assert.deepEqual(calls.map(call => call.runOptions.attachments), [
    [attachmentPath, detailPath], [attachmentPath],
  ])
  const hermesCalls = calls.filter(call => call.agent.kind === 'hermes')
  assert.equal(hermesCalls.every(call => call.runOptions.skills === undefined), true)
  assert.equal(hermesCalls.every(call => /global\/research: Research/.test(call.prompt)), true)
  assert.equal(hermesCalls.every(call => /\.meldwork-input\/\.run-[^/]+\/1-detail\.png/.test(call.prompt)), true)
})

test('automatic dialogue rejects unequal image context before starting any Agent', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '附件能力预检', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', '比较两张图', '', '', null, {
    attachments: [
      { id: 'attachment-a', name: 'a.png', mimeType: 'image/png', size: 128 },
      { id: 'attachment-b', name: 'b.png', mimeType: 'image/png', size: 128 },
    ],
  })

  assert.throws(
    () => workspace.startAuto({ groupId: group.id, maxRounds: 2 }),
    { message: 'LOCAL_AGENT_IMAGE_LIMIT' },
  )
  assert.deepEqual(workspace.snapshot().runningGroupIds, [])
  assert.equal(calls.length, 0)
})

test('automatic dialogue requires one final standalone consensus marker', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const replies = [
    [
      'Codex quoted [[MELDWORK_CONSENSUS:agree]] but still has a reservation.',
      '[[MELDWORK_CONSENSUS:agree]]',
    ].join('\n'),
    'Hermes accepts the current conclusion.\n[[MELDWORK_CONSENSUS:agree]]',
    'Codex has resolved the reservation.\n[[MELDWORK_CONSENSUS:agree]]',
    'Hermes confirms the final conclusion.\n[[MELDWORK_CONSENSUS:agree]]',
  ]
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: replies[calls.length - 1],
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '严格共识', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', '避免引用标记造成误判')

  workspace.startAuto({ groupId: group.id, maxRounds: 2 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes', 'codex', 'hermes'])
  assert.equal(workspace.snapshot().messages.some(message => (
    message.content.includes('[[MELDWORK_CONSENSUS:')
  )), false)
  assert.equal(workspace.snapshot().messages.some(message => (
    message.system?.key === 'system.autoRoundLimit'
  )), false)
})

test('automatic dialogue does not count an incomplete Agent turn as agreement', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: `${agent.kind} agrees.\n[[MELDWORK_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
      outcome: calls.length !== 1 ? 'completed' : 'partial',
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '完整回复', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', '截断回复不能作为共识')

  workspace.startAuto({ groupId: group.id, maxRounds: 2 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes', 'codex', 'hermes'])
  assert.equal(workspace.snapshot().messages.some(message => (
    message.system?.key === 'system.autoRoundLimit'
  )), false)
})

test('stopping automatic dialogue cancels the active round without a limit message', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let activeSignal
  let secondRoundStarted
  const secondRound = new Promise(resolve => { secondRoundStarted = resolve })
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (calls.length < 3) {
      return {
        text: `${agent.kind} continue\n[[MELDWORK_CONSENSUS:continue]]`,
        sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
      }
    }
    activeSignal = runOptions.signal
    secondRoundStarted()
    await new Promise((resolve, reject) => {
      if (runOptions.signal.aborted) {
        reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED'))
        return
      }
      runOptions.signal.addEventListener(
        'abort', () => reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED')), { once: true },
      )
    })
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '停止自动讨论', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', '讨论到手动停止为止')

  workspace.startAuto({ groupId: group.id, maxRounds: 4 })
  const pending = workspace.activeRuns.get(group.id).promise
  const runId = workspace.activeRuns.get(group.id).runId
  await secondRound

  assert.equal(workspace.stop(group.id, 'stale-run'), false)
  assert.equal(activeSignal.aborted, false)
  assert.equal(workspace.stop(group.id, runId), true)
  await pending

  assert.equal(activeSignal.aborted, true)
  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes', 'codex'])
  assert.equal(workspace.stop(group.id, runId), false)
  assert.deepEqual(workspace.snapshot().runningGroupIds, [])
  assert.equal(workspace.snapshot().messages.some(message => (
    ['system.autoRoundLimit', 'system.autoTimeout'].includes(message.system?.key)
  )), false)
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'stopped')
})

test('automatic HTTP 401 completes without a retry delay or recovery handoff', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const delays = []
  options.retrySleep = async delayMs => { delays.push(delayMs) }
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind !== 'hermes') {
      return {
        text: 'codex agrees\n[[MELDWORK_CONSENSUS:agree]]',
        sessionRef: runOptions.sessionRef || 'codex-session',
      }
    }
    throw new Error('HTTP 401: Invalid token')
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '401 retry stop', agentKinds: ['hermes', 'codex'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', 'Fail authentication without repeating it')

  workspace.startAuto({ groupId: group.id, unlimitedRounds: true })
  const active = workspace.activeRuns.get(group.id)
  await active.promise

  assert.deepEqual(calls.map(call => call.agent.kind), ['hermes', 'codex'])
  assert.deepEqual(delays, [])
  assert.deepEqual(workspace.getGroup(group.id).agentKinds, ['hermes', 'codex'])
  assert.equal(workspace.snapshot().messages.some(message => (
    message.agentKind === 'hermes' && message.system?.key === 'system.agentPausedAfterFailure'
  )), true)
  assert.equal(calls.some(call => call.prompt.includes('Harness recovery task')), false)
  assert.equal(workspace.snapshot().messages.some(message => (
    message.system?.key === 'system.autoTimeout'
  )), false)
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'partial')
})

test('per-Agent retry restarts only the interrupted Agent attempt', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  const firstAttempt = deferred()
  let codexAttempts = 0
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'codex' && ++codexAttempts === 1) {
      firstAttempt.resolve()
      await new Promise((resolve, reject) => {
        const abort = () => reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED'))
        if (runOptions.signal.aborted) abort()
        else runOptions.signal.addEventListener('abort', abort, { once: true })
      })
    }
    return {
      text: `${agent.kind} agrees\n[[MELDWORK_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Retry one Agent', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', 'Retry only the interrupted Agent')

  workspace.startAuto({ groupId: group.id, maxRounds: 1 })
  const active = workspace.activeRuns.get(group.id)
  await firstAttempt.promise
  assert.equal(workspace.controlAgent(group.id, active.runId, 'codex', 'retry'), true)
  await active.promise

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'codex', 'hermes'])
  assert.equal(workspace.snapshot().messages.some(message => (
    message.agentKind === 'codex' && message.system?.key === 'system.agentCallFailed'
  )), false)
  assert.deepEqual(ledger.list(group.id)[0].attemptHistory.find(entry => (
    entry.phase === 'manual_retry'
  )), {
    sequence: 1,
    agentKind: 'codex',
    phase: 'manual_retry',
    attempt: 1,
    failureCategory: 'cancellation',
    policyAction: 'retry',
    backoffMs: 1,
    recoveryAgentKind: '',
    finalOutcome: 'failed',
    timestamp: ledger.list(group.id)[0].attemptHistory[0].timestamp,
  })
})

test('per-Agent cancel preserves the Task and lets later Agents continue', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  const firstAttempt = deferred()
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'codex') {
      firstAttempt.resolve()
      await new Promise((resolve, reject) => {
        const abort = () => reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED'))
        if (runOptions.signal.aborted) abort()
        else runOptions.signal.addEventListener('abort', abort, { once: true })
      })
    }
    return {
      text: `${agent.kind} agrees\n[[MELDWORK_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Cancel one Agent', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', 'Cancel one Agent without stopping the Task')

  workspace.startAuto({ groupId: group.id, maxRounds: 1 })
  const active = workspace.activeRuns.get(group.id)
  await firstAttempt.promise
  assert.equal(workspace.controlAgent(group.id, active.runId, 'codex', 'cancel'), true)
  await active.promise

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes'])
  assert.equal(finished[0].status, 'round-limit')
  assert.equal(finished[0].failedKinds.includes('codex'), true)
  assert.equal(ledger.list(group.id)[0].attemptHistory.some(entry => (
    entry.phase === 'manual_retry'
    && entry.policyAction === 'cancel'
    && entry.finalOutcome === 'cancelled'
  )), true)
})

test('per-Agent replace makes the selected Agent take over the interrupted slot', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  const firstAttempt = deferred()
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'codex') {
      firstAttempt.resolve()
      await new Promise((resolve, reject) => {
        const abort = () => reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED'))
        if (runOptions.signal.aborted) abort()
        else runOptions.signal.addEventListener('abort', abort, { once: true })
      })
    }
    return {
      text: `${agent.kind} agrees\n[[MELDWORK_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Replace one Agent',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
  })
  workspace.addMessage(group.id, 'user', 'Replace the interrupted Agent')

  workspace.startAuto({ groupId: group.id, maxRounds: 1 })
  const active = workspace.activeRuns.get(group.id)
  await firstAttempt.promise
  assert.equal(
    workspace.controlAgent(group.id, active.runId, 'codex', 'replace', 'hermes'),
    true,
  )
  await active.promise

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes', 'workbuddy'])
  assert.match(calls[1].prompt, /replacing Codex/i)
  assert.equal(finished[0].status, 'completed')
  assert.equal(finished[0].failedKinds.includes('codex'), true)
  assert.equal(ledger.list(group.id)[0].attemptHistory.some(entry => (
    entry.phase === 'manual_retry'
    && entry.policyAction === 'replace_agent'
    && entry.recoveryAgentKind === 'hermes'
    && entry.finalOutcome === 'replaced'
  )), true)
})

test('automatic dialogue honors bounded Retry-After backoff and recovers', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const delays = []
  let hermesAttempts = 0
  options.retrySleep = async delayMs => { delays.push(delayMs) }
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'hermes' && ++hermesAttempts < 4) {
      throw Object.assign(new Error('Too many requests'), {
        statusCode: 429,
        retryAfterMs: 10,
      })
    }
    return {
      text: `${agent.kind} agrees\n[[MELDWORK_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Rate limit recovery', agentKinds: ['hermes', 'codex'], workdir: directory,
    allowWrite: false,
  })
  workspace.addMessage(group.id, 'user', 'Recover from a temporary rate limit')

  workspace.startAuto({ groupId: group.id, maxRounds: 1 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), [
    'hermes', 'hermes', 'hermes', 'hermes', 'codex',
  ])
  assert.deepEqual(delays, [4, 4, 4])
  assert.equal(new Set(calls.slice(0, 4).map(call => call.runOptions.operationId)).size, 1)
  assert.equal(finished[0].status, 'completed')
})

test('automatic dialogue retries one protocol failure without removing the Agent', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const delays = []
  let hermesAttempts = 0
  options.retrySleep = async delayMs => { delays.push(delayMs) }
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'hermes' && ++hermesAttempts === 1) {
      throw new Error('LOCAL_AGENT_PROCESS_FAILED')
    }
    return {
      text: `${agent.kind} agrees\n[[MELDWORK_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Protocol retry recovery', agentKinds: ['hermes', 'codex'], workdir: directory,
    allowWrite: false,
  })
  workspace.addMessage(group.id, 'user', 'Recover from one local Agent process failure')

  workspace.startAuto({ groupId: group.id, maxRounds: 1 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), ['hermes', 'hermes', 'codex'])
  assert.deepEqual(delays, [1])
  assert.equal(finished[0].status, 'completed')
  assert.deepEqual(workspace.getGroup(group.id).agentKinds, ['hermes', 'codex'])
  assert.equal(workspace.snapshot().messages.some(message => (
    message.system?.key === 'system.agentRemovedAfterFailure'
  )), false)
})

test('write-capable unknown outcomes wait for approval before replaying', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  const outputPath = path.join(directory, 'write-attempts.txt')
  let codexAttempts = 0
  options.runLedger = ledger
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'codex') {
      codexAttempts += 1
      fs.appendFileSync(outputPath, `attempt-${codexAttempts}\n`)
      if (codexAttempts === 1) {
        throw Object.assign(new Error('socket reset after write'), { code: 'ECONNRESET' })
      }
    }
    return {
      text: `${agent.kind} agrees\n[[MELDWORK_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Ambiguous write retry',
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
    allowWrite: true,
  })
  workspace.addMessage(group.id, 'user', 'Write exactly once unless I approve a retry')
  const gatePromise = pendingHumanGate(workspace)

  workspace.startAuto({ groupId: group.id, maxRounds: 1 })
  const active = workspace.activeRuns.get(group.id)
  const gate = await gatePromise

  assert.equal(gate.type, 'retry')
  assert.equal(codexAttempts, 1)
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'attempt-1\n')
  const waiting = ledger.get(gate.runId)
  const ambiguous = waiting.attemptHistory.at(-1)
  assert.deepEqual({
    policyAction: ambiguous.policyAction,
    outcomeCertainty: ambiguous.outcomeCertainty,
    sideEffectsPossible: ambiguous.sideEffectsPossible,
    idempotencyMode: ambiguous.idempotencyMode,
  }, {
    policyAction: 'human_gate',
    outcomeCertainty: 'unknown_outcome',
    sideEffectsPossible: true,
    idempotencyMode: 'none',
  })
  assert.match(ambiguous.operationId, /^agent-operation-[a-f0-9]{64}$/)

  workspace.decideHumanGate(gate.gateId, { optionId: 'retry-once' })
  await active.promise

  assert.equal(codexAttempts, 2)
  assert.equal(calls[0].runOptions.operationId, calls[1].runOptions.operationId)
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'attempt-1\nattempt-2\n')
})

test('automatic dialogue exhausts bounded transient retries before continuing', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const delays = []
  options.retrySleep = async delayMs => { delays.push(delayMs) }
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'hermes') {
      throw Object.assign(new Error('Provider temporarily unavailable'), { statusCode: 503 })
    }
    return {
      text: `${agent.kind} agrees\n[[MELDWORK_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Transient retry exhaustion', agentKinds: ['hermes', 'codex'], workdir: directory,
    allowWrite: false,
  })
  workspace.addMessage(group.id, 'user', 'Continue after retry exhaustion')

  workspace.startAuto({ groupId: group.id, maxRounds: 1 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), [
    'hermes', 'hermes', 'hermes', 'hermes', 'codex',
  ])
  assert.deepEqual(delays, [1, 2, 4])
  assert.equal(finished[0].status, 'partial')
  assert.deepEqual(workspace.getGroup(group.id).agentKinds, ['hermes', 'codex'])
  assert.equal(workspace.snapshot().messages.filter(message => (
    message.agentKind === 'hermes' && message.system?.key === 'system.agentCallFailed'
  )).length, 1)
  assert.equal(workspace.snapshot().messages.some(message => (
    message.agentKind === 'hermes' && message.system?.key === 'system.agentRemovedAfterFailure'
  )), false)
})

test('automatic dialogue fails HTTP 401 once, pauses the Agent for the run, and continues healthy slots', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let hermesAttempts = 0
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'hermes' && ++hermesAttempts < 4) {
      throw agentRuntimeError('LOCAL_AGENT_AUTH_REQUIRED', 'HTTP 401: Invalid token')
    }
    return {
      text: `${agent.kind} agrees\n[[MELDWORK_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '401 retry recovery', agentKinds: ['hermes', 'codex'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', 'Retry transient unauthorized failures')

  workspace.startAuto({ groupId: group.id, maxRounds: 1 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), [
    'hermes', 'codex',
  ])
  assert.deepEqual(workspace.getGroup(group.id).agentKinds, ['hermes', 'codex'])
  assert.equal(workspace.snapshot().messages.some(message => (
    message.agentKind === 'hermes' && message.system?.key === 'system.agentPausedAfterFailure'
  )), true)
  assert.equal(workspace.snapshot().messages.some(message => (
    message.system?.key === 'system.agentCallFailed'
  )), true)
  assert.equal(finished[0].status, 'partial')
})

test('direct dialogue reports HTTP 401 once without removing its Agent', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    throw agentRuntimeError('LOCAL_AGENT_AUTH_REQUIRED', 'HTTP 401: Invalid token')
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const direct = workspace.createGroup({
    name: 'Hermes',
    conversationType: 'direct',
    directAgentKind: 'hermes',
    agentKinds: ['hermes'],
    workdir: directory,
  })

  await workspace.sendMessage({ groupId: direct.id, text: 'Retry Hermes safely' })

  assert.equal(calls.length, 1)
  assert.deepEqual(workspace.getGroup(direct.id).agentKinds, ['hermes'])
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'failed')
  assert.deepEqual(finished[0].failedKinds, ['hermes'])
  const failures = workspace.snapshot().messages.filter(message => (
    message.agentKind === 'hermes' && message.system?.key === 'system.agentCallFailed'
  ))
  assert.equal(failures.length, 1)
  assert.equal(failures[0].system.params.reason, 'HTTP 401; authentication failed; Agent retained')
})

test('group authentication recovery retains the existing native session', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let authenticated = false
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (!authenticated) throw agentRuntimeError('LOCAL_AGENT_AUTH_REQUIRED', 'HTTP 401: expired credential')
    return { text: 'Recovered conversation', sessionRef: runOptions.sessionRef, outcome: 'completed' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({ name: 'Auth continuity', agentKinds: ['hermes'], workdir: directory })
  const key = workspace.sessionKey(group.id, 'hermes')
  workspace.state.sessions[key] = 'hermes-auth-session'
  workspace.save()
  await workspace.sendMessage({ groupId: group.id, text: 'First attempt', targetKinds: ['hermes'] })
  assert.equal(workspace.state.sessions[key], 'hermes-auth-session')

  authenticated = true
  workspace.markRuntimeCredential('hermes', 'ready')
  workspace.updateGroup(group.id, { agentKinds: ['hermes'] })
  await workspace.refreshAgents()
  await workspace.sendMessage({ groupId: group.id, text: 'Continue after login', targetKinds: ['hermes'] })
  assert.deepEqual(calls.map(call => call.runOptions.sessionRef), ['hermes-auth-session', 'hermes-auth-session'])
  assert.equal(workspace.state.sessions[key], 'hermes-auth-session')
  assert.equal(workspace.snapshot().messages.some(message => message.content === 'Recovered conversation'), true)
})

test('automatic dialogue does not send an authentication recovery handoff to another Agent', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let hermesAttempts = 0
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'hermes') {
      hermesAttempts += 1
      if (hermesAttempts === 1) await runOptions.onSessionRef('stale-hermes-session')
      if (hermesAttempts <= 4) {
        throw agentRuntimeError('LOCAL_AGENT_AUTH_REQUIRED', 'HTTP 401: Invalid token')
      }
    }
    return {
      text: `${agent.kind} ${prompt.includes('Harness recovery task') ? 'repaired auth' : 'agrees'}\n[[MELDWORK_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '401 Agent handoff', agentKinds: ['hermes', 'codex'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', 'Repair the failing Agent and continue')

  workspace.startAuto({ groupId: group.id, maxRounds: 1 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), [
    'hermes', 'codex',
  ])
  assert.doesNotMatch(calls[1].prompt, /Harness recovery task|Invalid token/)
  assert.deepEqual(workspace.getGroup(group.id).agentKinds, ['hermes', 'codex'])
  assert.equal(workspace.snapshot().messages.some(message => (
    message.agentKind === 'hermes' && message.system?.key === 'system.agentPausedAfterFailure'
  )), true)
  assert.equal(finished[0].status, 'partial')
})

test('automatic dialogue keeps a failed authentication slot out of later group context', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let hermesAttempts = 0
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'hermes' && ++hermesAttempts <= 4) {
      throw agentRuntimeError('LOCAL_AGENT_AUTH_REQUIRED', 'HTTP 401: Invalid token')
    }
    const recovery = prompt.includes('Harness recovery task')
    return {
      text: `${agent.kind} ${recovery ? 'repaired auth' : 'agrees'}\n[[MELDWORK_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-task-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Isolated 401 repair', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const root = workspace.addMessage(group.id, 'user', 'Repair auth without polluting the task')

  workspace.startAuto({ groupId: group.id, maxRounds: 1 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), [
    'codex', 'hermes',
  ])
  const normalCodexCall = calls[0]
  assert.equal(normalCodexCall.runOptions.sessionRef, '')
  const codexSessionKey = workspace.sessionKey(group.id, 'codex')
  assert.equal(workspace.state.sessions[codexSessionKey], 'codex-task-session')
  const agentMessages = workspace.snapshot().messages.filter(message => message.role === 'agent')
  assert.equal(agentMessages.some(message => /repaired auth/.test(message.content)), false)
  assert.equal(agentMessages.filter(message => message.agentKind === 'codex').length, 1)
  const packedContext = workspace.packedPromptContext(group.id, '', root.id)
  const persistedContext = `${packedContext.stableText}\n${packedContext.recentText}`
  assert.doesNotMatch(persistedContext, /Harness recovery task|repaired auth/)
})

test('automatic dialogue persists one failed 401 attempt and pauses the Agent for the run', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  options.runLedger = new RunLedger({ storagePath: ledgerPath })
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'hermes') {
      await runOptions.onSessionRef('unusable-hermes-session')
      throw agentRuntimeError('LOCAL_AGENT_AUTH_REQUIRED', 'HTTP 401: Invalid token')
    }
    return {
      text: `${agent.kind} ${prompt.includes('Harness recovery task') ? 'checked auth' : 'agrees'}\n[[MELDWORK_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '401 removal', agentKinds: ['hermes', 'codex', 'workbuddy'], workdir: directory,
  })
  const root = workspace.addMessage(
    group.id, 'user', 'Remove unrecoverable participants and continue',
  )

  workspace.startAuto({ groupId: group.id, maxRounds: 1 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), [
    'hermes', 'codex', 'workbuddy',
  ])
  assert.deepEqual(workspace.getGroup(group.id).agentKinds, ['hermes', 'codex', 'workbuddy'])
  assert.equal(workspace.snapshot().messages.some(message => (
    message.agentKind === 'hermes' && message.system?.key === 'system.agentPausedAfterFailure'
  )), true)
  assert.equal(
    workspace.state.sessions[workspace.sessionKey(group.id, 'hermes')],
    'unusable-hermes-session',
  )
  assert.equal(
    workspace.snapshot().agents.find(agent => agent.kind === 'hermes').credentialState,
    'missing',
  )
  const failure = workspace.snapshot().messages.find(message => (
    message.agentKind === 'hermes' && message.system?.key === 'system.agentCallFailed'
  ))
  assert.equal(failure.system.params.reason, 'HTTP 401; authentication failed; Agent retained')
  assert.equal(workspace.snapshot().messages.some(message => (
    message.agentKind === 'hermes' && message.system?.key === 'system.agentRemovedAfterFailure'
  )), false)
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'partial')
  assert.equal(finished[0].failedKinds.includes('hermes'), true)
  assert.equal(finished[0].completedKinds.includes('hermes'), true)
  const history = new RunLedger({ storagePath: ledgerPath }).list(group.id)[0].attemptHistory
    .filter(entry => entry.agentKind === 'hermes')
  assert.deepEqual(history.map(entry => [
    entry.phase,
    entry.attempt,
    entry.failureCategory,
    entry.policyAction,
    entry.recoveryAgentKind,
    entry.finalOutcome,
  ]), [
    ['initial', 1, 'authentication', 'fail', '', 'failed'],
  ])
  assert.doesNotMatch(
    fs.readFileSync(ledgerPath, 'utf8'),
    /Invalid token|unusable-hermes-session|command|\/Users\//i,
  )
})

test('automatic dialogue treats an adapter-classified 403 sign-in failure as terminal and pauses the Agent', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'hermes') {
      throw agentRuntimeError('LOCAL_AGENT_AUTH_REQUIRED', 'HTTP 403: Provider rejected the request')
    }
    return {
      text: `${agent.kind} agrees\n[[MELDWORK_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '403 removal', agentKinds: ['hermes', 'codex'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', 'Handle forbidden credentials')

  workspace.startAuto({ groupId: group.id, maxRounds: 1 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), [
    'hermes', 'codex',
  ])
  assert.deepEqual(workspace.getGroup(group.id).agentKinds, ['hermes', 'codex'])
  assert.equal(workspace.snapshot().messages.some(message => (
    message.agentKind === 'hermes' && message.system?.key === 'system.agentPausedAfterFailure'
  )), true)
  assert.equal(
    workspace.snapshot().agents.find(agent => agent.kind === 'hermes').credentialState,
    'missing',
  )
  const failure = workspace.snapshot().messages.find(message => (
    message.agentKind === 'hermes' && message.system?.key === 'system.agentCallFailed'
  ))
  assert.equal(failure.system.params.reason, 'HTTP 403; authentication failed; Agent retained')
})

test('automatic dialogue recovers repeated protocol failures without removing the Agent', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  options.runLedger = new RunLedger({ storagePath: ledgerPath })
  options.retrySleep = async () => {}
  let hermesAttempts = 0
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'hermes' && hermesAttempts++ < 2) {
      throw new Error('LOCAL_AGENT_PROCESS_FAILED')
    }
    return {
      text: `${agent.kind} reply\n[[MELDWORK_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '失败恢复', agentKinds: ['codex', 'hermes', 'workbuddy'], workdir: directory,
    allowWrite: false,
  })
  workspace.addMessage(group.id, 'user', '继续讨论直至共识')

  workspace.startAuto({ groupId: group.id, maxRounds: 1 })
  const runId = workspace.activeRuns.get(group.id).runId
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), [
    'codex', 'hermes', 'hermes', 'hermes', 'workbuddy',
  ])
  assert.deepEqual(workspace.snapshot().messages.filter(message => message.role === 'system'), [])
  assert.deepEqual(workspace.getGroup(group.id).agentKinds, ['codex', 'hermes', 'workbuddy'])
  assert.equal(options.runLedger.get(runId).agentRuns.filter(agentRun => (
    agentRun.kind === 'hermes' && agentRun.status === 'failed'
  )).length, 2)

  const recovered = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath }),
  })
  assert.equal(recovered.snapshot().messages.some(message => (
    message.agentKind === 'hermes' && message.system?.key === 'system.agentCallFailed'
  )), false)

  const repeated = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath }),
  })
  assert.equal(repeated.snapshot().messages.some(message => (
    message.agentKind === 'hermes' && message.system?.key === 'system.agentCallFailed'
  )), false)
  assert.equal(new RunLedger({ storagePath: ledgerPath }).get(runId).agentRuns.filter(agentRun => (
    agentRun.kind === 'hermes' && agentRun.status === 'failed'
  )).length, 2)
})

test('automatic dialogue retains a streamed conclusion while isolating the failed Agent', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  options.runLedger = new RunLedger({ storagePath: ledgerPath })
  options.retrySleep = async () => {}
  let hermesAttempts = 0
  options.runAgent = async (agent, _prompt, _workdir, runOptions) => {
    if (agent.kind === 'hermes') {
      hermesAttempts += 1
      runOptions.onEvent({
        type: 'answer_delta',
        status: 'running',
        delta: `Hermes partial conclusion ${hermesAttempts}`,
      })
      throw new Error('LOCAL_AGENT_PROCESS_FAILED')
    }
    return {
      text: `${agent.kind} continue\n[[MELDWORK_CONSENSUS:continue]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Distinct failure evidence', agentKinds: ['codex', 'hermes'], workdir: directory,
    allowWrite: false,
  })
  workspace.addMessage(group.id, 'user', 'Preserve distinct partial conclusions')

  workspace.startAuto({ groupId: group.id, maxRounds: 2 })
  await workspace.activeRuns.get(group.id).promise

  const liveFailures = workspace.snapshot().messages.filter(message => (
    message.agentKind === 'hermes' && message.system?.key === 'system.agentCallFailed'
  ))
  assert.equal(liveFailures.length, 1)
  assert.match(liveFailures[0].content, /Hermes partial conclusion 4/)
  assert.deepEqual(workspace.getGroup(group.id).agentKinds, ['codex', 'hermes'])

  const restored = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath }),
  })
  const restoredFailures = restored.snapshot().messages.filter(message => (
    message.agentKind === 'hermes' && message.system?.key === 'system.agentCallFailed'
  ))
  assert.equal(restoredFailures.length, 1)
  assert.deepEqual(restoredFailures.map(message => message.content), liveFailures.map(message => message.content))
})

test('automatic dialogue stops after every Agent fails while retaining group membership', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.retrySleep = async () => {}
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    throw new Error('LOCAL_AGENT_PROCESS_FAILED')
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '全员失败', agentKinds: ['codex', 'hermes'], workdir: directory,
    allowWrite: false,
  })
  const root = workspace.addMessage(group.id, 'user', '失败也要保留终止诊断')

  workspace.startAuto({ groupId: group.id, maxRounds: 2 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), [
    'codex', 'codex', 'codex', 'codex',
    'hermes', 'hermes', 'hermes', 'hermes',
  ])
  assert.deepEqual(workspace.getGroup(group.id).agentKinds, ['codex', 'hermes'])
  const removals = workspace.snapshot().messages.filter(message => (
    message.system?.key === 'system.agentRemovedAfterFailure'
  ))
  assert.equal(removals.length, 0)
  assert.equal(removals.every(message => message.threadRootId === root.id), true)
  assert.equal(workspace.snapshot().messages.some(message => (
    message.system?.key === 'system.autoRoundLimit'
  )), false)
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'failed')
})

test('automatic dialogue reuses a session captured before a successful protocol retry', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.retrySleep = async () => {}
  let kimiAttempts = 0
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'kimi' && kimiAttempts++ === 0) {
      await runOptions.onSessionRef('kimi-created-before-failure')
      throw new Error('LOCAL_AGENT_PROCESS_FAILED')
    }
    return {
      text: `${agent.kind} reply\n[[MELDWORK_CONSENSUS:${calls.length > 2 ? 'agree' : 'continue'}]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '失败后复用会话', agentKinds: ['kimi', 'codex'], workdir: directory,
    allowWrite: false,
  })
  const root = workspace.addMessage(group.id, 'user', '失败重试不能创建新会话')

  workspace.startAuto({ groupId: group.id, maxRounds: 2 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), ['kimi', 'kimi', 'codex', 'kimi', 'codex'])
  assert.equal(calls[0].runOptions.sessionRef, '')
  assert.equal(calls[1].runOptions.sessionRef, 'kimi-created-before-failure')
  assert.deepEqual(workspace.getGroup(group.id).agentKinds, ['kimi', 'codex'])
  assert.equal(
    workspace.state.sessions[workspace.sessionKey(group.id, 'kimi')],
    'kimi-created-before-failure',
  )
})

test('automatic dialogue defaults to six rounds and hides consensus markers at the cap', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: `${agent.kind} has not agreed.\n[[MELDWORK_CONSENSUS:continue]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '安全上限', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const root = workspace.addMessage(group.id, 'user', '讨论一个无法快速收敛的问题')

  const started = workspace.startAuto({ groupId: group.id })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(started, { started: true, maxRounds: 6 })
  assert.deepEqual(calls.map(call => call.agent.kind), [
    'codex', 'hermes', 'codex', 'hermes', 'codex', 'hermes',
    'codex', 'hermes', 'codex', 'hermes', 'codex', 'hermes',
  ])
  assert.equal(workspace.snapshot().messages.some(message => (
    message.content.includes('[[MELDWORK_CONSENSUS:')
  )), false)
  const limit = workspace.snapshot().messages.find(message => (
    message.system?.key === 'system.autoRoundLimit'
  ))
  assert.equal(limit.threadRootId, root.id)
  assert.deepEqual(limit.system.params, { rounds: 6 })
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'round-limit')
  assert.equal(finished[0].threadRootId, root.id)
  assert.doesNotMatch(
    fs.readFileSync(options.storagePath, 'utf8'),
    /"status"\s*:\s*"round-limit"|run-finished/,
  )
})

test('automatic dialogue accepts legacy maxTurns as a round limit', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: `${agent.kind} continue\n[[MELDWORK_CONSENSUS:continue]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '旧参数', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', '兼容旧参数')

  const started = workspace.startAuto({ groupId: group.id, maxTurns: 2 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(started, { started: true, maxRounds: 2 })
  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes', 'codex', 'hermes'])
})

test('automatic dialogue caps both round parameters at ten', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: `${agent.kind} agrees\n[[MELDWORK_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '十轮上限', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', '上限测试')

  const started = workspace.startAuto({ groupId: group.id, maxTurns: 999 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(started, { started: true, maxRounds: 10 })
  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes'])
})

test('automatic dialogue has no total runtime limit', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.autoRunTimeoutMs = 5
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (calls.length === 1) await new Promise(resolve => setTimeout(resolve, 20))
    return {
      text: `${agent.kind} agrees\n[[MELDWORK_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '无整体时限', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const root = workspace.addMessage(group.id, 'user', '只限制单个 Agent 的运行时间')

  workspace.startAuto({ groupId: group.id, maxRounds: 1 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes'])
  assert.equal(workspace.snapshot().messages.some(message => (
    message.system?.key === 'system.autoTimeout'
  )), false)
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'completed')
  assert.equal(finished[0].threadRootId, root.id)
})

test('automatic dialogue keeps its stable diagnostic and emits a failed terminal event', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '异常兜底', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const root = workspace.addMessage(group.id, 'user', '内部异常不能形成未处理拒绝')
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  const emitChanged = workspace.emitChanged.bind(workspace)
  let emitCount = 0
  workspace.emitChanged = () => {
    emitCount += 1
    if (emitCount === 4) throw new Error(`/private/workspace/${group.id}`)
    emitChanged()
  }

  workspace.startAuto({ groupId: group.id, maxRounds: 2 })
  await workspace.activeRuns.get(group.id).promise

  const stopped = workspace.snapshot().messages.find(message => (
    message.system?.key === 'system.autoStopped'
  ))
  assert.equal(stopped.threadRootId, root.id)
  assert.equal(stopped.content, 'Automatic discussion stopped: LOCAL_AGENT_UNKNOWN_FAILURE')
  assert.deepEqual(stopped.system.params, { reason: 'LOCAL_AGENT_UNKNOWN_FAILURE' })
  assert.deepEqual(workspace.snapshot().runningGroupIds, [])
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'failed')
  assert.equal(finished[0].threadRootId, root.id)
})

test('automatic dialogue requires a topic root and accepts an explicit one', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => ({
    text: `${agent.kind} agrees.\n[[MELDWORK_CONSENSUS:agree]]`,
    sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
  })
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '话题要求', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  assert.throws(
    () => workspace.startAuto({ groupId: group.id, maxRounds: 1 }),
    { message: 'LOCAL_AUTO_THREAD_REQUIRED' },
  )

  workspace.startAuto({ groupId: group.id, maxRounds: 1, threadRootId: 'topic-root' })
  await workspace.activeRuns.get(group.id).promise
  assert.deepEqual(
    workspace.snapshot().messages.filter(message => message.role === 'agent')
      .map(message => message.threadRootId),
    ['topic-root', 'topic-root'],
  )
})

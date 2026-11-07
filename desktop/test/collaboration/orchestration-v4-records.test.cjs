const test = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { createBlackboardEntryRecord } = require('../../src/collaboration/collaboration-records.cjs')

const {
  appendWorkReceipt,
  applyCollaborationReceipt,
  buildCollaborationPackage,
  collaborationPayloadBudget,
  createCollaborationReceipt,
  createCoordinationPlan,
  createOrchestrationV4,
  createSynthesisBinding,
  createWorkReceipt,
  hashValue,
  parseCollaborationControlBlock,
  parseCollaborationText,
  parseOrchestrationV4,
  parseResultCollaboration,
  resolveCoordinationConsensus,
} = require('../../src/collaboration/orchestration-v4-records.cjs')

function orchestration(overrides = {}) {
  return createOrchestrationV4({
    workflow: 'manual',
    template: 'concurrent-batch',
    targetKinds: ['codex', 'hermes'],
    ...overrides,
  }, { targetKinds: ['codex', 'hermes'], now: 1000 })
}

test('V4 rejects task graph cursors that ran ahead of their dependencies', () => {
  const { createTaskGraph, createTaskGraphCursor, updateTaskGraphCursor } = require('../../src/collaboration/task-graph-records.cjs')
  const node = (nodeId, agentKind, dependsOn, terminal) => ({ nodeId, agentKind, dependsOn,
    role: terminal ? 'reviewer' : 'primary', inputNodeIds: dependsOn, expectedOutput: 'Result',
    acceptance: { requireConclusion: true, minArtifactRefs: 0, minEvidenceRefs: 0 },
    terminal, parallel: false, decisionOptions: [] })
  const graph = createTaskGraph({ template: 'task-graph', nodes: [
    node('primary', 'codex', [], false), node('review', 'hermes', ['primary'], true),
  ] }, ['codex', 'hermes'])
  const cursor = createTaskGraphCursor(graph)
  const record = { ...orchestration(), taskGraph: cursor }
  assert.doesNotThrow(() => parseOrchestrationV4(record, { targetKinds: ['codex', 'hermes'] }))
  const invalid = { ...cursor, nodeStates: cursor.nodeStates.map(state => state.nodeId === 'review'
    ? { ...state, status: 'accepted' } : state), terminalState: 'accepted' }
  assert.throws(() => parseOrchestrationV4({ ...record, taskGraph: invalid }, { targetKinds: ['codex', 'hermes'] }),
    { message: 'ORCHESTRATION_V4_TASK_GRAPH_INVALID' })
  const primaryAccepted = updateTaskGraphCursor(cursor, 'primary', { status: 'accepted', conclusionHash: 'a'.repeat(64) })
  const valid = updateTaskGraphCursor(primaryAccepted, 'review', { status: 'accepted', conclusionHash: 'b'.repeat(64) })
  assert.doesNotThrow(() => parseOrchestrationV4({ ...record, taskGraph: valid }, { targetKinds: ['codex', 'hermes'] }))
})

test('V4 rejects legacy terminal states that hide unfinished independent work', () => {
  const { createTaskGraph, createTaskGraphCursor, updateTaskGraphCursor } = require('../../src/collaboration/task-graph-records.cjs')
  const node = (nodeId, agentKind, terminal) => ({ nodeId, agentKind, dependsOn: [], inputNodeIds: [],
    role: 'primary', expectedOutput: 'Result', acceptance: { requireConclusion: true, minArtifactRefs: 0, minEvidenceRefs: 0 },
    terminal, parallel: true, decisionOptions: [] })
  const graph = createTaskGraph({ template: 'task-graph', nodes: [
    node('work', 'codex', false), node('final', 'hermes', true),
  ] }, ['codex', 'hermes'])
  const cursor = updateTaskGraphCursor(createTaskGraphCursor(graph), 'final', { status: 'accepted', conclusionHash: 'a'.repeat(64) })
  const record = { ...orchestration(), taskGraph: cursor }
  assert.doesNotThrow(() => parseOrchestrationV4(record, { targetKinds: ['codex', 'hermes'] }))
  assert.throws(() => parseOrchestrationV4({ ...record, taskGraph: { ...cursor, terminalState: 'accepted' } },
    { targetKinds: ['codex', 'hermes'] }), { message: 'ORCHESTRATION_V4_TASK_GRAPH_INVALID' })
})

test('V4 rejects accepted task nodes without their required typed results', () => {
  const { createTaskGraph, createTaskGraphCursor, updateTaskGraphCursor } = require('../../src/collaboration/task-graph-records.cjs')
  const graph = createTaskGraph({ template: 'task-graph', nodes: [{ nodeId: 'work', role: 'primary',
    agentKind: 'codex', dependsOn: [], inputNodeIds: [], expectedOutput: 'Result',
    acceptance: { requireConclusion: true, minArtifactRefs: 1, minEvidenceRefs: 1 },
    terminal: true, parallel: false, decisionOptions: [] }] }, ['codex'])
  const base = updateTaskGraphCursor(createTaskGraphCursor(graph), 'work', { status: 'accepted',
    conclusionHash: 'a'.repeat(64), artifactIds: ['artifact-one'], evidenceIds: ['evidence-one'] })
  const record = { ...orchestration(), taskGraph: base }
  assert.doesNotThrow(() => parseOrchestrationV4(record, { targetKinds: ['codex', 'hermes'] }))
  for (const update of [{ conclusionHash: '' }, { artifactIds: [] }, { evidenceIds: [] }]) {
    const invalid = { ...base, nodeStates: [{ ...base.nodeStates[0], ...update }] }
    assert.throws(() => parseOrchestrationV4({ ...record, taskGraph: invalid }, { targetKinds: ['codex', 'hermes'] }),
      { message: 'ORCHESTRATION_V4_TASK_GRAPH_INVALID' })
  }
})

test('V4 binds completed human graph decisions to an option and durable entry', () => {
  const { createTaskGraph, createTaskGraphCursor, updateTaskGraphCursor } = require('../../src/collaboration/task-graph-records.cjs')
  const graph = createTaskGraph({ template: 'task-graph', nodes: [{ nodeId: 'decision', role: 'human',
    agentKind: null, dependsOn: [], inputNodeIds: [], expectedOutput: 'Decide',
    acceptance: { requireConclusion: false, minArtifactRefs: 0, minEvidenceRefs: 0 },
    terminal: true, parallel: false, decisionOptions: [
      { optionId: 'yes', name: 'Approve', kind: 'allow_once' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ] }] })
  const base = updateTaskGraphCursor(createTaskGraphCursor(graph), 'decision',
    { status: 'accepted', decisionOptionId: 'yes', entryIds: ['decision-entry'] })
  const record = { ...orchestration(), taskGraph: base }
  assert.doesNotThrow(() => parseOrchestrationV4(record, { targetKinds: ['codex', 'hermes'] }))
  for (const update of [{ decisionOptionId: '' }, { decisionOptionId: 'no' }, { entryIds: [] }]) {
    const invalid = { ...base, nodeStates: [{ ...base.nodeStates[0], ...update }] }
    assert.throws(() => parseOrchestrationV4({ ...record, taskGraph: invalid }, { targetKinds: ['codex', 'hermes'] }),
      { message: 'ORCHESTRATION_V4_TASK_GRAPH_INVALID' })
  }
})

test('V4 phase checkpoints preserve an existing task graph cursor', () => {
  const { createTaskGraph, createTaskGraphCursor } = require('../../src/collaboration/task-graph-records.cjs')
  const { v4PhaseMethods } = require('../../src/workspace/local-workspace-auto-runner-v4-phase.cjs')
  const graph = createTaskGraph({ template: 'task-graph', nodes: [{ nodeId: 'primary', role: 'primary',
    agentKind: 'codex', dependsOn: [], inputNodeIds: [], expectedOutput: 'Result',
    acceptance: { requireConclusion: true, minArtifactRefs: 0, minEvidenceRefs: 0 },
    terminal: true, parallel: false, decisionOptions: [] }] }, ['codex'])
  const cursor = createTaskGraphCursor(graph)
  const controller = { currentRound: 1, orchestration: { version: 4, phase: 'proposal', round: 1, taskGraph: cursor } }
  let saved
  const runner = { ...v4PhaseMethods, checkpointOrchestration: (_group, _controller, record) => { saved = record } }
  runner.v4CheckpointPhase({}, controller, { targetKinds: ['codex'], phase: 'proposal', batchId: 'batch',
    snapshotRecord: { capturedAt: 1000 }, snapshotHash: 'a'.repeat(64), slots: [], writerKind: '' })
  assert.deepEqual(saved.taskGraph, cursor)
  assert.notEqual(saved.taskGraph, cursor)
  saved.taskGraph.nodeStates[0].status = 'failed'
  assert.equal(cursor.nodeStates[0].status, 'pending')
})

function contentRef(hash = 'b'.repeat(64), size = 123) {
  return { algorithm: 'sha256', hash, size, mediaType: 'application/json' }
}

function discussionSnapshot(targetKinds, round = 0) {
  const hash = createHash('sha256').update(JSON.stringify({ targetKinds, round })).digest('hex')
  return {
    contextPackId: null,
    taskId: 'task-discussion',
    round,
    targetKinds: [...targetKinds],
    sourceIds: ['task-discussion'],
    capturedAt: 1000,
    charCount: 123,
    contentHash: hash,
    bodyHash: createHash('sha256').update(JSON.stringify({ targetKinds, round, body: true })).digest('hex'),
    contentRef: contentRef(hash),
  }
}

function challengeOrchestration(targetKinds = ['codex', 'hermes', 'workbuddy'], round = 2) {
  const base = createOrchestrationV4({
    workflow: 'auto',
    template: 'discussion',
    targetKinds,
    phase: 'challenge',
    round,
    snapshot: discussionSnapshot(targetKinds, round),
  }, { targetKinds, now: 1000 })
  const slots = base.slots.map((slot) => {
    const proposalReceipt = createCollaborationReceipt({
      phase: 'proposal',
      agentKind: slot.agentKind,
      slotId: slot.slotId,
      operationId: `operation-proposal-${slot.agentKind}`,
      status: 'completed',
      summary: `${slot.agentKind} proposal`,
      artifactIds: [`artifact-${slot.agentKind}`],
      evidenceIds: [`evidence-${slot.agentKind}`],
      snapshotHash: base.snapshotHash,
      deliveryWatermark: 1,
    })
    return {
      ...slot,
      resultRefs: {
        artifactIds: [`artifact-${slot.agentKind}`],
        evidenceIds: [`evidence-${slot.agentKind}`],
        workflowOutcomeRefs: [{ receipt: proposalReceipt }],
      },
    }
  })
  const challengeBindings = slots.map((slot, index) => {
    const proposalSlot = slots[(index + 1) % slots.length]
    const proposalReceipt = proposalSlot.resultRefs.workflowOutcomeRefs[0].receipt
    return {
      round,
      reviewerKind: slot.agentKind,
      reviewerSlotId: slot.slotId,
      reviewerOperationId: slot.operationId,
      proposalKind: proposalSlot.agentKind,
      proposalSlotId: proposalSlot.slotId,
      proposalOperationId: proposalReceipt.operationId,
      proposalReceiptId: proposalReceipt.receiptId,
      artifactIds: [...proposalReceipt.artifactIds],
      evidenceIds: [...proposalReceipt.evidenceIds],
    }
  })
  return { ...base, slots, challengeBindings }
}

function completedChallengeOrchestration(
  targetKinds = ['codex', 'hermes', 'workbuddy'], round = 2,
) {
  const record = challengeOrchestration(targetKinds, round)
  const slots = record.slots.map((slot) => {
    const challengeReceipt = createCollaborationReceipt({
      phase: 'challenge',
      agentKind: slot.agentKind,
      slotId: slot.slotId,
      operationId: slot.operationId,
      status: 'completed',
      summary: `${slot.agentKind} completed challenge`,
      snapshotHash: record.snapshotHash,
      deliveryWatermark: 2,
    })
    return {
      ...slot,
      phase: 'challenge',
      status: 'completed',
      finishedAt: 1001,
      receiptId: challengeReceipt.receiptId,
      resultHash: hashValue(challengeReceipt),
      resultRefs: {
        ...slot.resultRefs,
        workflowOutcomeRefs: [
          ...slot.resultRefs.workflowOutcomeRefs,
          { receipt: challengeReceipt, verdict: 'support' },
        ],
      },
    }
  })
  return {
    ...record,
    currentKind: '',
    currentKinds: [],
    pendingKinds: [],
    successfulKinds: [...targetKinds],
    totalSuccesses: targetKinds.length,
    slots,
  }
}

function synthesisBinding(targetKinds = ['codex', 'hermes', 'workbuddy'], snapshotContentHash = 'a'.repeat(64)) {
  return createSynthesisBinding({
    snapshotContentHash,
    targetKinds,
    candidates: targetKinds.map((kind, index) => ({
      kind,
      score: 700 - index,
      evidence: {
        matrixVersion: 'fit-matrix-v1',
        score: 90 - index,
        confidence: 0.9,
        sampleSize: 9,
      },
    })),
  })
}

function synthesisRecoveryOrchestration(overrides = {}) {
  const targetKinds = ['codex', 'hermes', 'workbuddy']
  const base = completedChallengeOrchestration(targetKinds)
  const binding = synthesisBinding(targetKinds, base.snapshot.bodyHash)
  const rankedKinds = ['codex', 'hermes', 'workbuddy']
  const writerKind = overrides.activeWriterKind || binding.writerKind
  const writerSlot = base.slots.find(slot => slot.agentKind === writerKind)
  const operationId = `operation-synthesis-${writerKind}-1`
  const slots = base.slots.map(slot => slot.agentKind === writerKind ? {
    ...slot,
    phase: 'synthesis',
    status: 'planned',
    operationId,
    permission: 'workspace-write',
    receiptId: '',
    resultHash: '',
    finishedAt: null,
  } : slot)
  const plan = {
    ...base.plan,
    assignments: base.plan.assignments.map(assignment => (
      assignment.agentKind === writerKind
        ? { ...assignment, operationId }
        : assignment
    )),
  }
  const recovery = {
    revision: 1,
    originalWriterKind: binding.writerKind,
    activeWriterKind: writerKind,
    verificationKinds: rankedKinds
      .filter(kind => kind !== writerKind)
      .slice(0, 2),
    rankedKinds,
    rankingFingerprint: hashValue({
      selectionInputHash: binding.selectionInputHash,
      rankedKinds,
    }),
    stateEpoch: 0,
    triedWriters: [writerKind],
    attempts: [{
      attemptId: `synthesis-attempt-${writerKind}-1`,
      writerKind,
      slotId: writerSlot.slotId,
      operationId,
      attempt: 1,
      status: 'intent',
      permission: 'workspace-write',
      leaseAcquired: false,
      sideEffectsPossible: false,
      outcomeCertainty: 'not_started',
      updatedAt: 1001,
    }],
    ...overrides,
  }
  return {
    targetKinds,
    binding,
    record: {
      ...base,
      phase: 'synthesis',
      currentKind: '',
      currentKinds: [writerKind],
      pendingKinds: [writerKind],
      plan,
      slots,
      synthesisBinding: binding,
      synthesisRecovery: recovery,
      commitState: { ...base.commitState, writerKind },
    },
  }
}

function candidateCommit(overrides = {}) {
  const runId = 'run-candidate-commit'
  const taskId = 'task-candidate-commit'
  const candidateBody = 'Candidate final body.'
  const candidateContentHash = createHash('sha256').update(candidateBody).digest('hex')
  const candidateArtifactId = `artifact-${'b'.repeat(64)}`
  const evidenceIds = [`evidence-${'c'.repeat(64)}`]
  const writerKind = 'codex'
  const writerRole = 'integrator'
  const sinkId = (prefix, sink) => {
    const body = JSON.stringify({ candidateContentHash, runId, sink, taskId })
    return `${prefix}-${createHash('sha256').update(body).digest('hex')}`
  }
  const commitId = sinkId('candidate-commit', 'commit')
  const blackboardEntry = createBlackboardEntryRecord({
    entryType: 'artifact-ref',
    subject: `candidate-commit:${commitId}`,
    statement: `Accepted candidate Artifact ${candidateArtifactId} `
      + `(sha256:${candidateContentHash}).`,
    value: candidateContentHash,
    owner: { type: 'agent', agentKind: writerKind, role: writerRole },
    audience: { roles: [], agentKinds: ['codex', 'hermes', 'workbuddy'] },
    lifecycle: { state: 'active', sequence: 1, recordedAt: 0, supersedesEntryId: null },
    provenance: {
      runId, taskId, round: 2, agentRunId: null,
      artifactIds: [candidateArtifactId], evidenceIds,
    },
    refs: [candidateArtifactId, ...evidenceIds],
  })
  return {
    status: 'intent',
    runId,
    taskId,
    groupId: 'group-candidate-commit',
    threadRootId: 'thread-candidate-commit',
    candidateArtifactId,
    candidateContentHash,
    candidateContentRef: {
      algorithm: 'sha256', hash: candidateContentHash, size: 23, mediaType: 'text/plain',
    },
    evidenceIds,
    writerKind,
    writerRole,
    commitId,
    messageId: sinkId('message', 'message'),
    blackboardEntryId: blackboardEntry.entryId,
    blackboardSequence: 1,
    blackboardRecordedAt: 0,
    messageStatus: 'pending',
    blackboardStatus: 'pending',
    attempt: 1,
    updatedAt: 1001,
    ...overrides,
  }
}

function candidateBlackboardEntry(commit, overrides = {}) {
  return createBlackboardEntryRecord({
    entryType: 'artifact-ref',
    subject: `candidate-commit:${commit.commitId}`,
    statement: `Accepted candidate Artifact ${commit.candidateArtifactId} `
      + `(sha256:${commit.candidateContentHash}).`,
    value: commit.candidateContentHash,
    owner: { type: 'agent', agentKind: commit.writerKind, role: commit.writerRole },
    audience: { roles: [], agentKinds: ['codex', 'hermes', 'workbuddy'] },
    lifecycle: {
      state: 'active', sequence: commit.blackboardSequence,
      recordedAt: commit.blackboardRecordedAt, supersedesEntryId: null,
    },
    provenance: {
      runId: commit.runId, taskId: commit.taskId, round: 2, agentRunId: null,
      artifactIds: [commit.candidateArtifactId], evidenceIds: commit.evidenceIds,
    },
    refs: [commit.candidateArtifactId, ...commit.evidenceIds],
    ...overrides,
  })
}

test('creates a strict v4 frozen batch with one operation and slot per selected Agent', () => {
  const record = orchestration()
  assert.equal(record.version, 4)
  assert.equal(record.template, 'concurrent-batch')
  assert.equal(record.plan.snapshotHash, record.snapshotHash)
  assert.deepEqual(record.slots.map(slot => slot.agentKind), ['codex', 'hermes'])
  assert.equal(new Set(record.slots.map(slot => slot.operationId)).size, 2)
  assert.deepEqual(record.commitState.pendingKinds, ['codex', 'hermes'])
  assert.deepEqual(parseOrchestrationV4(record, { targetKinds: ['codex', 'hermes'] }), record)
})

test('rejects an Auto V4 discussion snapshot without a content blob reference or body hash', () => {
  const targetKinds = ['codex', 'hermes']
  const record = createOrchestrationV4({
    workflow: 'auto',
    template: 'discussion',
    targetKinds,
    snapshot: discussionSnapshot(targetKinds),
  }, { targetKinds, now: 1000 })

  const { contentRef: _contentRef, ...snapshot } = record.snapshot
  assert.throws(() => parseOrchestrationV4({
    ...record,
    snapshot,
    snapshotHash: hashValue(snapshot),
    plan: { ...record.plan, snapshotHash: hashValue(snapshot) },
    slots: record.slots.map(slot => ({ ...slot, snapshotHash: hashValue(snapshot) })),
  }, { targetKinds }), {
    code: 'ORCHESTRATION_V4_SNAPSHOT_INVALID',
  })

  const { bodyHash: _bodyHash, ...snapshotWithoutBodyHash } = record.snapshot
  const snapshotHash = hashValue(snapshotWithoutBodyHash)
  assert.throws(() => parseOrchestrationV4({
    ...record,
    snapshot: snapshotWithoutBodyHash,
    snapshotHash,
    plan: { ...record.plan, snapshotHash },
    slots: record.slots.map(slot => ({ ...slot, snapshotHash })),
  }, { targetKinds }), {
    code: 'ORCHESTRATION_V4_SNAPSHOT_INVALID',
  })
})

test('accepts neutral participant roles in proposal and challenge checkpoint plans', () => {
  const record = orchestration()
  const participantRecord = {
    ...record,
    plan: {
      ...record.plan,
      assignments: record.plan.assignments.map(assignment => ({
        ...assignment,
        role: 'participant',
      })),
    },
  }

  assert.deepEqual(
    parseOrchestrationV4(participantRecord, { targetKinds: ['codex', 'hermes'] }),
    participantRecord,
  )
})

test('keeps legacy scalar activity and agreement fields inert in V4', () => {
  const record = orchestration({ currentKind: '', agreementKinds: [] })
  assert.equal(record.currentKind, '')
  assert.deepEqual(record.agreementKinds, [])
  assert.throws(() => parseOrchestrationV4({
    ...record,
    currentKind: 'codex',
  }), { code: 'ORCHESTRATION_V4_REFERENCE_INVALID' })
  assert.throws(() => parseOrchestrationV4({
    ...record,
    agreementKinds: ['codex'],
  }), { code: 'ORCHESTRATION_V4_REFERENCE_INVALID' })
})

test('rejects v4 snapshot, slot, plan, and commit binding tampering', () => {
  const record = orchestration()
  assert.throws(() => parseOrchestrationV4({
    ...record,
    snapshotHash: 'a'.repeat(64),
  }), { code: 'ORCHESTRATION_V4_SNAPSHOT_HASH_MISMATCH' })
  assert.throws(() => parseOrchestrationV4({
    ...record,
    slots: record.slots.map((slot, index) => index === 0
      ? { ...slot, operationId: record.slots[1].operationId }
      : slot),
  }), { code: 'ORCHESTRATION_V4_SLOT_INVALID' })
  assert.throws(() => parseOrchestrationV4({
    ...record,
    plan: { ...record.plan, extra: true },
  }), { code: 'ORCHESTRATION_V4_PLAN_INVALID' })
  assert.throws(() => parseOrchestrationV4({
    ...record,
    commitState: {
      ...record.commitState,
      committedKinds: ['codex'],
      pendingKinds: ['codex', 'hermes'],
    },
  }), { code: 'ORCHESTRATION_V4_COMMIT_STATE_INVALID' })
})

test('round-trips strict current-round challenge bindings and keeps older records readable', () => {
  const record = challengeOrchestration()
  assert.deepEqual(parseOrchestrationV4(record, {
    targetKinds: ['codex', 'hermes', 'workbuddy'],
  }), record)
  const { challengeBindings: _bindings, ...legacy } = record
  assert.deepEqual(parseOrchestrationV4(legacy, {
    targetKinds: ['codex', 'hermes', 'workbuddy'],
  }), legacy)
})

test('round-trips an optional strict synthesis binding while keeping older V4 records readable', () => {
  const targetKinds = ['codex', 'hermes', 'workbuddy']
  const record = completedChallengeOrchestration(targetKinds)
  const binding = synthesisBinding(targetKinds, record.snapshot.bodyHash)
  const bound = {
    ...record,
    synthesisBinding: binding,
    commitState: { ...record.commitState, writerKind: binding.writerKind },
  }

  assert.deepEqual(parseOrchestrationV4(bound, { targetKinds }), bound)
  assert.deepEqual(parseOrchestrationV4(record, { targetKinds }), record)
  const legacyStarted = { ...record, phase: 'synthesis' }
  assert.throws(() => parseOrchestrationV4(legacyStarted, { targetKinds }), {
    code: 'ORCHESTRATION_V4_SYNTHESIS_BINDING_REQUIRED',
  })
})

test('uses an Agent-agreed coordination plan through work and delivery without synthesis binding', () => {
  const targetKinds = ['codex', 'hermes', 'workbuddy']
  const record = completedChallengeOrchestration(targetKinds)
  const coordinationPlan = createCoordinationPlan({
    snapshotHash: record.snapshotHash,
    targetKinds,
    assignments: [
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
        objective: 'Integrate the agreed work.', expectedOutput: 'Integrated Artifact.',
        inputRefs: [], artifactIds: [], dependsOn: ['codex-work', 'hermes-work'],
      },
    ],
    finalizerKind: 'workbuddy',
    verifierKinds: ['codex', 'hermes'],
    agreedBy: targetKinds,
  })
  for (const phase of ['coordination', 'work', 'synthesis', 'verification']) {
    const coordinated = {
      ...record,
      phase,
      coordinationPlan,
      commitState: { ...record.commitState, writerKind: 'workbuddy' },
    }
    assert.equal(coordinated.synthesisBinding, undefined)
    assert.deepEqual(parseOrchestrationV4(coordinated, { targetKinds }), coordinated)
  }
})

test('allows only plan-ordered negotiated writer replacement while retaining independent verifiers', () => {
  const targetKinds = ['codex', 'hermes', 'qwen', 'workbuddy']
  const base = completedChallengeOrchestration(targetKinds)
  const coordinationPlan = createCoordinationPlan({
    snapshotHash: base.snapshotHash,
    targetKinds,
    assignments: [
      { taskId: 'a-final', ownerKind: 'workbuddy', role: 'integrator', objective: 'Integrate work.', expectedOutput: 'Integrated Artifact.', inputRefs: [], artifactIds: [], dependsOn: ['b-qwen', 'c-codex', 'd-hermes'] },
      { taskId: 'b-qwen', ownerKind: 'qwen', role: 'verifier', objective: 'Prepare Qwen evidence.', expectedOutput: 'Qwen Artifact.', inputRefs: [], artifactIds: [], dependsOn: [] },
      { taskId: 'c-codex', ownerKind: 'codex', role: 'verifier', objective: 'Prepare Codex evidence.', expectedOutput: 'Codex Artifact.', inputRefs: [], artifactIds: [], dependsOn: [] },
      { taskId: 'd-hermes', ownerKind: 'hermes', role: 'verifier', objective: 'Prepare Hermes evidence.', expectedOutput: 'Hermes Artifact.', inputRefs: [], artifactIds: [], dependsOn: [] },
    ],
    finalizerKind: 'workbuddy',
    verifierKinds: ['codex', 'hermes', 'qwen'],
    agreedBy: targetKinds,
  })
  const rankedKinds = ['workbuddy', 'codex', 'hermes', 'qwen']
  const rankingFingerprint = hashValue({ planHash: coordinationPlan.planHash, rankedKinds })
  const originalSlot = base.slots.find(slot => slot.agentKind === 'workbuddy')
  const replacementSlot = base.slots.find(slot => slot.agentKind === 'codex')
  const recovery = {
    revision: 2,
    originalWriterKind: 'workbuddy',
    activeWriterKind: 'codex',
    verificationKinds: ['hermes', 'qwen'],
    rankedKinds,
    rankingFingerprint,
    stateEpoch: 0,
    triedWriters: ['workbuddy', 'codex'],
    attempts: [
      {
        attemptId: 'synthesis-attempt-workbuddy-1',
        writerKind: 'workbuddy',
        slotId: originalSlot.slotId,
        operationId: originalSlot.operationId,
        attempt: 1,
        status: 'superseded',
        permission: 'workspace-write',
        leaseAcquired: true,
        sideEffectsPossible: true,
        outcomeCertainty: 'unknown_outcome',
        updatedAt: 1001,
      },
      {
        attemptId: 'synthesis-attempt-codex-1',
        writerKind: 'codex',
        slotId: replacementSlot.slotId,
        operationId: replacementSlot.operationId,
        attempt: 1,
        status: 'intent',
        permission: 'read-only',
        leaseAcquired: false,
        sideEffectsPossible: false,
        outcomeCertainty: 'not_started',
        updatedAt: 1002,
      },
    ],
  }
  const record = {
    ...base,
    phase: 'synthesis',
    currentKinds: ['codex'],
    pendingKinds: ['codex'],
    coordinationPlan,
    synthesisRecovery: recovery,
    commitState: { ...base.commitState, writerKind: 'codex' },
    slots: base.slots.map(slot => slot.agentKind === 'codex' ? {
      ...slot,
      phase: 'synthesis',
      status: 'planned',
      finishedAt: null,
      receiptId: '',
      resultHash: '',
      commitStatus: 'pending',
      permission: 'workspace-write',
    } : slot),
  }

  assert.deepEqual(parseOrchestrationV4(record, { targetKinds }), record)
  assert.throws(() => parseOrchestrationV4({
    ...record,
    slots: record.slots.map(slot => (
      ['codex', 'workbuddy'].includes(slot.agentKind)
        ? { ...slot, permission: 'workspace-write' }
        : slot
    )),
  }, { targetKinds }), { code: 'ORCHESTRATION_V4_PERMISSION_INVALID' })
  assert.throws(() => parseOrchestrationV4({
    ...record,
    slots: record.slots.map(slot => ({
      ...slot,
      permission: slot.agentKind === 'workbuddy' ? 'workspace-write' : 'read-only',
    })),
  }, { targetKinds }), { code: 'ORCHESTRATION_V4_PERMISSION_INVALID' })
})

test('round-trips exact work receipts bound to the active plan, snapshot, operation, and Artifact content', () => {
  const targetKinds = ['codex', 'hermes', 'workbuddy']
  const base = completedChallengeOrchestration(targetKinds)
  const coordinationPlan = createCoordinationPlan({
    snapshotHash: base.snapshotHash,
    targetKinds,
    assignments: [
      { taskId: 'codex-work', ownerKind: 'codex', role: 'worker', objective: 'Codex work.', expectedOutput: 'Codex Artifact.', inputRefs: [], artifactIds: [], dependsOn: [] },
      { taskId: 'hermes-work', ownerKind: 'hermes', role: 'worker', objective: 'Hermes work.', expectedOutput: 'Hermes Artifact.', inputRefs: [], artifactIds: [], dependsOn: [] },
      { taskId: 'integrate-work', ownerKind: 'workbuddy', role: 'integrator', objective: 'Integrate work.', expectedOutput: 'Integrated Artifact.', inputRefs: [], artifactIds: [], dependsOn: ['codex-work', 'hermes-work'] },
    ],
    finalizerKind: 'workbuddy',
    verifierKinds: ['codex', 'hermes'],
    agreedBy: targetKinds,
  })
  const slot = base.slots.find(candidate => candidate.agentKind === 'codex')
  const artifactId = `artifact-${'a'.repeat(64)}`
  const artifactHash = 'c'.repeat(64)
  const receipt = createCollaborationReceipt({
    phase: 'work',
    agentKind: 'codex',
    slotId: slot.slotId,
    operationId: slot.operationId,
    status: 'completed',
    summary: 'Codex completed its negotiated work package.',
    artifactIds: [artifactId],
    evidenceIds: [`evidence-${'d'.repeat(64)}`],
    workItemId: 'codex-work',
    snapshotHash: base.snapshotHash,
    deliveryWatermark: 3,
  })
  const workReceipt = createWorkReceipt({
    snapshotHash: base.snapshotHash,
    snapshotBodyHash: base.snapshot.bodyHash,
    snapshotContentRef: base.snapshot.contentRef,
    planHash: coordinationPlan.planHash,
    taskId: 'codex-work',
    ownerKind: 'codex',
    slotId: slot.slotId,
    operationId: slot.operationId,
    collaborationReceipt: receipt,
    artifacts: [{
      artifactId,
      contentHash: artifactHash,
      contentRef: contentRef(artifactHash, 42),
    }],
  })
  const record = {
    ...base,
    phase: 'work',
    coordinationPlan,
    workReceipts: [workReceipt],
    commitState: { ...base.commitState, writerKind: coordinationPlan.finalizerKind },
    slots: base.slots.map(candidate => candidate.slotId === slot.slotId ? {
      ...candidate,
      phase: 'work',
      status: 'completed',
      finishedAt: 1002,
      receiptId: receipt.receiptId,
      resultHash: hashValue(receipt),
      resultRefs: {
        ...(candidate.resultRefs || {}),
        artifactIds: [artifactId],
        evidenceIds: [...receipt.evidenceIds],
        workflowOutcomeRefs: [
          ...(candidate.resultRefs?.workflowOutcomeRefs || []),
          { receipt },
        ],
      },
    } : candidate),
  }

  assert.deepEqual(parseOrchestrationV4(record, { targetKinds }), record)
  assert.deepEqual(appendWorkReceipt([workReceipt], workReceipt), [workReceipt])

  const conflictingReceipt = createCollaborationReceipt({
    ...receipt,
    summary: 'Different canonical result for the same operation.',
    receiptId: undefined,
  })
  const conflictingWorkReceipt = createWorkReceipt({
    ...workReceipt,
    collaborationReceipt: conflictingReceipt,
    workReceiptId: undefined,
    resultHash: undefined,
  })
  assert.throws(() => appendWorkReceipt([workReceipt], conflictingWorkReceipt), {
    code: 'ORCHESTRATION_V4_WORK_RECEIPT_CONFLICT',
  })
  assert.throws(() => parseOrchestrationV4({
    ...record,
    workReceipts: [{ ...workReceipt, planHash: 'e'.repeat(64) }],
  }, { targetKinds }), { code: 'ORCHESTRATION_V4_WORK_RECEIPT_INVALID' })
  assert.throws(() => parseOrchestrationV4({
    ...record,
    workReceipts: [{
      ...workReceipt,
      artifacts: workReceipt.artifacts.map(artifact => ({
        ...artifact,
        contentHash: 'f'.repeat(64),
      })),
    }],
  }, { targetKinds }), { code: 'ORCHESTRATION_V4_WORK_RECEIPT_INVALID' })

  const hermesSlot = base.slots.find(candidate => candidate.agentKind === 'hermes')
  const canonicalStaleRecord = (overrides = {}) => {
    const bindings = {
      snapshotHash: overrides.snapshotHash || base.snapshotHash,
      taskId: overrides.taskId || 'codex-work',
      ownerKind: overrides.ownerKind || 'codex',
      slotId: overrides.slotId || slot.slotId,
      operationId: overrides.operationId || slot.operationId,
    }
    const staleReceipt = createCollaborationReceipt({
      ...receipt,
      agentKind: bindings.ownerKind,
      slotId: bindings.slotId,
      operationId: bindings.operationId,
      workItemId: bindings.taskId,
      snapshotHash: bindings.snapshotHash,
      receiptId: undefined,
    })
    const staleWorkReceipt = createWorkReceipt({
      ...workReceipt,
      ...bindings,
      snapshotBodyHash: overrides.snapshotBodyHash || base.snapshot.bodyHash,
      snapshotContentRef: overrides.snapshotContentRef || base.snapshot.contentRef,
      planHash: overrides.planHash || coordinationPlan.planHash,
      collaborationReceipt: staleReceipt,
      workReceiptId: undefined,
      resultHash: undefined,
    })
    return {
      ...record,
      workReceipts: [staleWorkReceipt],
      slots: record.slots.map(candidate => candidate.slotId === bindings.slotId ? {
        ...candidate,
        resultRefs: {
          ...candidate.resultRefs,
          workflowOutcomeRefs: [
            ...(candidate.resultRefs?.workflowOutcomeRefs || []),
            { receipt: staleReceipt },
          ],
        },
      } : candidate),
    }
  }
  for (const [name, overrides] of [
    ['snapshot', { snapshotHash: '1'.repeat(64) }],
    ['snapshot body', { snapshotBodyHash: '2'.repeat(64) }],
    ['snapshot content ref', { snapshotContentRef: contentRef('3'.repeat(64), 42) }],
    ['plan', { planHash: '4'.repeat(64) }],
    ['work item', { taskId: 'stale-work' }],
    ['owner', { ownerKind: 'hermes' }],
    ['slot', { slotId: hermesSlot.slotId }],
  ]) {
    assert.throws(() => parseOrchestrationV4(canonicalStaleRecord(overrides), { targetKinds }), {
      code: 'ORCHESTRATION_V4_WORK_RECEIPT_INVALID',
    }, `stale ${name} binding must fail closed`)
  }
})

test('round-trips historical same-slot work receipts after the latest watermark replaces them', () => {
  const targetKinds = ['codex', 'hermes', 'workbuddy']
  const base = completedChallengeOrchestration(targetKinds)
  const coordinationPlan = createCoordinationPlan({
    snapshotHash: base.snapshotHash,
    targetKinds,
    assignments: [
      { taskId: 'codex-analyze', ownerKind: 'codex', role: 'worker', objective: 'Analyze the task.', expectedOutput: 'Analysis Artifact.', inputRefs: [], artifactIds: [], dependsOn: [] },
      { taskId: 'codex-implement', ownerKind: 'codex', role: 'worker', objective: 'Implement the task.', expectedOutput: 'Implementation Artifact.', inputRefs: [], artifactIds: [], dependsOn: ['codex-analyze'] },
      { taskId: 'hermes-review', ownerKind: 'hermes', role: 'verifier', objective: 'Review the implementation.', expectedOutput: 'Review Artifact.', inputRefs: [], artifactIds: [], dependsOn: ['codex-implement'] },
      { taskId: 'integrate-work', ownerKind: 'workbuddy', role: 'integrator', objective: 'Integrate the work.', expectedOutput: 'Integrated Artifact.', inputRefs: [], artifactIds: [], dependsOn: ['hermes-review'] },
    ],
    finalizerKind: 'workbuddy',
    verifierKinds: ['codex', 'hermes'],
    agreedBy: targetKinds,
  })
  const slot = base.slots.find(candidate => candidate.agentKind === 'codex')
  const operations = ['operation-codex-analyze', 'operation-codex-implement']
  const tasks = ['codex-analyze', 'codex-implement']
  const receipts = operations.map((operationId, index) => {
    const artifactId = `artifact-${String(index + 1).repeat(64)}`
    return createCollaborationReceipt({
      phase: 'work',
      agentKind: 'codex',
      slotId: slot.slotId,
      operationId,
      status: 'completed',
      summary: `Codex completed ${tasks[index]}.`,
      artifactIds: [artifactId],
      workItemId: tasks[index],
      snapshotHash: base.snapshotHash,
      deliveryWatermark: index + 3,
    })
  })
  const workReceipts = receipts.map((receipt, index) => {
    const contentHash = String(index + 3).repeat(64)
    return createWorkReceipt({
      snapshotHash: base.snapshotHash,
      snapshotBodyHash: base.snapshot.bodyHash,
      snapshotContentRef: base.snapshot.contentRef,
      planHash: coordinationPlan.planHash,
      taskId: tasks[index],
      ownerKind: 'codex',
      slotId: slot.slotId,
      operationId: operations[index],
      collaborationReceipt: receipt,
      artifacts: [{
        artifactId: receipt.artifactIds[0],
        contentHash,
        contentRef: contentRef(contentHash, 42),
      }],
    })
  })
  const latestReceipt = receipts.at(-1)
  const record = {
    ...base,
    phase: 'work',
    coordinationPlan,
    workReceipts,
    commitState: { ...base.commitState, writerKind: coordinationPlan.finalizerKind },
    plan: {
      ...base.plan,
      assignments: base.plan.assignments.map(assignment => (
        assignment.agentKind === 'codex'
          ? { ...assignment, operationId: latestReceipt.operationId }
          : assignment
      )),
    },
    deliveryWatermarks: [{
      agentKind: 'codex',
      phase: 'work',
      watermark: latestReceipt.deliveryWatermark,
      operationId: latestReceipt.operationId,
      snapshotHash: base.snapshotHash,
      updatedAt: 1003,
    }],
    slots: base.slots.map(candidate => candidate.slotId === slot.slotId ? {
      ...candidate,
      phase: 'work',
      status: 'completed',
      operationId: latestReceipt.operationId,
      deliveryWatermark: latestReceipt.deliveryWatermark,
      receiptId: latestReceipt.receiptId,
      resultHash: hashValue(latestReceipt),
      finishedAt: 1003,
      resultRefs: {
        ...(candidate.resultRefs || {}),
        artifactIds: workReceipts.flatMap(receipt => (
          receipt.artifacts.map(artifact => artifact.artifactId)
        )),
        workflowOutcomeRefs: [
          ...(candidate.resultRefs?.workflowOutcomeRefs || []),
          ...receipts.map(receipt => ({ receipt })),
        ],
      },
    } : candidate),
  }

  assert.deepEqual(parseOrchestrationV4(record, { targetKinds }), record)

  const tampered = structuredClone(record)
  const historical = tampered.slots.find(candidate => candidate.slotId === slot.slotId)
    .resultRefs.workflowOutcomeRefs.find(item => (
      item.receipt?.receiptId === receipts[0].receiptId
    ))
  historical.receipt.summary = 'Tampered historical result.'
  assert.throws(() => parseOrchestrationV4(tampered, { targetKinds }), {
    code: 'ORCHESTRATION_V4_WORK_RECEIPT_INVALID',
  })
})

test('accepts a targeted synthesis revision after verification without stale challenge bindings', () => {
  const targetKinds = ['codex', 'hermes', 'workbuddy']
  const base = completedChallengeOrchestration(targetKinds)
  const coordinationPlan = createCoordinationPlan({
    snapshotHash: base.snapshotHash,
    targetKinds,
    assignments: [
      { taskId: 'codex-work', ownerKind: 'codex', role: 'worker', objective: 'Codex work.', expectedOutput: 'Codex Artifact.', inputRefs: [], artifactIds: [], dependsOn: [] },
      { taskId: 'hermes-work', ownerKind: 'hermes', role: 'worker', objective: 'Hermes work.', expectedOutput: 'Hermes Artifact.', inputRefs: [], artifactIds: [], dependsOn: [] },
      { taskId: 'integrate-work', ownerKind: 'workbuddy', role: 'integrator', objective: 'Integrate work.', expectedOutput: 'Integrated Artifact.', inputRefs: [], artifactIds: [], dependsOn: ['codex-work', 'hermes-work'] },
    ],
    finalizerKind: 'workbuddy',
    verifierKinds: ['codex', 'hermes'],
    agreedBy: targetKinds,
  })
  const writerSlot = base.slots.find(slot => slot.agentKind === 'workbuddy')
  const operationId = 'operation-synthesis-workbuddy-2'
  const candidateContentHash = 'c'.repeat(64)
  const openIssueIds = [`issue-${'d'.repeat(64)}`]
  const rankedKinds = ['workbuddy', 'codex', 'hermes']
  const { challengeBindings: _challengeBindings, ...withoutBindings } = base
  const revision = {
    ...withoutBindings,
    phase: 'synthesis',
    round: 3,
    currentKinds: ['workbuddy'],
    pendingKinds: ['workbuddy'],
    coordinationPlan,
    convergence: {
      candidateArtifactId: `artifact-${'e'.repeat(64)}`,
      candidateContentHash,
      openIssueIds,
      stateKey: hashValue({ candidateContentHash, openIssueIds }),
      lastCompletedRound: 2,
      consecutiveStableRounds: 1,
      stateEpoch: 1,
      acknowledgedGateEpoch: 0,
    },
    synthesisRecovery: {
      revision: 2,
      originalWriterKind: 'workbuddy',
      activeWriterKind: 'workbuddy',
      verificationKinds: ['codex', 'hermes'],
      rankedKinds,
      rankingFingerprint: hashValue({ planHash: coordinationPlan.planHash, rankedKinds }),
      stateEpoch: 1,
      triedWriters: ['workbuddy'],
      attempts: [
        { attemptId: 'synthesis-attempt-1', writerKind: 'workbuddy', slotId: writerSlot.slotId, operationId: 'operation-synthesis-workbuddy-1', attempt: 1, status: 'completed', permission: 'read-only', leaseAcquired: true, sideEffectsPossible: false, outcomeCertainty: 'succeeded', updatedAt: 1001 },
        { attemptId: 'synthesis-attempt-2', writerKind: 'workbuddy', slotId: writerSlot.slotId, operationId, attempt: 2, status: 'intent', permission: 'read-only', leaseAcquired: false, sideEffectsPossible: false, outcomeCertainty: 'not_started', updatedAt: 1002 },
      ],
    },
    plan: {
      ...base.plan,
      assignments: base.plan.assignments.map(assignment => assignment.agentKind === 'workbuddy'
        ? { ...assignment, operationId }
        : assignment),
    },
    slots: base.slots.map(slot => slot.agentKind === 'workbuddy'
      ? { ...slot, phase: 'synthesis', status: 'planned', operationId, receiptId: '', resultHash: '', finishedAt: null }
      : slot),
    commitState: { ...base.commitState, writerKind: 'workbuddy' },
  }

  assert.deepEqual(parseOrchestrationV4(revision, { targetKinds }), revision)
})

test('round-trips strict synthesis recovery intent bound to frozen ranking and effective writer', () => {
  const { targetKinds, record } = synthesisRecoveryOrchestration()

  assert.deepEqual(parseOrchestrationV4(record, { targetKinds }), record)
})

test('round-trips an unknown synthesis attempt bound to its frozen recovery Gate', () => {
  const { targetKinds, record } = synthesisRecoveryOrchestration()
  const attempt = {
    ...record.synthesisRecovery.attempts[0],
    status: 'unknown_outcome',
    leaseAcquired: true,
    sideEffectsPossible: true,
    outcomeCertainty: 'unknown_outcome',
  }
  const fields = {
    writerKind: attempt.writerKind,
    slotId: attempt.slotId,
    operationId: attempt.operationId,
    attempt: attempt.attempt,
    proposedReplacementKind: 'hermes',
    round: record.round,
    stateEpoch: record.synthesisRecovery.stateEpoch,
    rankingFingerprint: record.synthesisRecovery.rankingFingerprint,
  }
  const pendingGate = { bindingHash: hashValue(fields), ...fields }
  const gated = {
    ...record,
    phase: 'human-gate',
    currentKind: '',
    currentKinds: [],
    pendingKinds: [],
    synthesisRecovery: {
      ...record.synthesisRecovery,
      attempts: [attempt],
      pendingGate,
    },
  }

  assert.deepEqual(parseOrchestrationV4(gated, { targetKinds }), gated)
})

test('rejects drifted synthesis recovery writers, operations, verifiers, and replacement gates', () => {
  const { targetKinds, record } = synthesisRecoveryOrchestration()
  const reject = synthesisRecovery => assert.throws(() => parseOrchestrationV4({
    ...record,
    synthesisRecovery,
  }, { targetKinds }), { code: 'ORCHESTRATION_V4_SYNTHESIS_RECOVERY_INVALID' })

  reject({ ...record.synthesisRecovery, activeWriterKind: 'hermes' })
  reject({
    ...record.synthesisRecovery,
    attempts: record.synthesisRecovery.attempts.map(attempt => ({
      ...attempt,
      operationId: 'operation-drifted',
    })),
  })
  reject({ ...record.synthesisRecovery, verificationKinds: ['codex', 'hermes'] })
  reject({
    ...record.synthesisRecovery,
    attempts: record.synthesisRecovery.attempts.map(attempt => ({
      ...attempt,
      status: 'unknown_outcome',
      leaseAcquired: true,
      sideEffectsPossible: true,
      outcomeCertainty: 'unknown_outcome',
    })),
    pendingGate: {
      bindingHash: '1'.repeat(64),
      writerKind: record.synthesisRecovery.activeWriterKind,
      slotId: record.synthesisRecovery.attempts[0].slotId,
      operationId: record.synthesisRecovery.attempts[0].operationId,
      attempt: 1,
      proposedReplacementKind: 'workbuddy',
      round: record.round,
      stateEpoch: 0,
    },
  })
})

test('round-trips strict optional V4 convergence and rejects noncanonical state', () => {
  const targetKinds = ['codex', 'hermes', 'workbuddy']
  const record = completedChallengeOrchestration(targetKinds)
  const binding = synthesisBinding(targetKinds, record.snapshot.bodyHash)
  const candidateContentHash = '2'.repeat(64)
  const openIssueIds = [`issue-${'3'.repeat(64)}`, `issue-${'4'.repeat(64)}`]
  const stateKey = createHash('sha256').update(JSON.stringify({
    candidateContentHash,
    openIssueIds,
  })).digest('hex')
  const convergence = {
    candidateArtifactId: `artifact-${'1'.repeat(64)}`,
    candidateContentHash,
    openIssueIds,
    stateKey,
    lastCompletedRound: 2,
    consecutiveStableRounds: 1,
    stateEpoch: 1,
    acknowledgedGateEpoch: 0,
  }
  const bound = {
    ...record,
    synthesisBinding: binding,
    convergence,
    commitState: { ...record.commitState, writerKind: binding.writerKind },
  }

  assert.deepEqual(parseOrchestrationV4(bound, { targetKinds }), bound)
  assert.deepEqual(parseOrchestrationV4(record, { targetKinds }), record)
  for (const mutate of [
    value => { value.openIssueIds.reverse() },
    value => { value.openIssueIds.push(value.openIssueIds[0]) },
    value => { value.stateKey = 'not-a-hash' },
    value => { value.acknowledgedGateEpoch = value.stateEpoch + 1 },
  ]) {
    const invalid = structuredClone(bound)
    mutate(invalid.convergence)
    assert.throws(() => parseOrchestrationV4(invalid, { targetKinds }), {
      code: 'ORCHESTRATION_V4_CONVERGENCE_INVALID',
    })
  }
  assert.throws(() => parseOrchestrationV4({
    ...orchestration(), convergence,
  }, { targetKinds: ['codex', 'hermes'] }), {
    code: 'ORCHESTRATION_V4_CONVERGENCE_INVALID',
  })
})

test('allows synthesis binding only after every selected Agent completes the challenge barrier', () => {
  const targetKinds = ['codex', 'hermes', 'workbuddy']
  const completed = completedChallengeOrchestration(targetKinds)
  const binding = synthesisBinding(targetKinds, completed.snapshot.bodyHash)
  const bind = record => ({
    ...record,
    synthesisBinding: binding,
    commitState: { ...record.commitState, writerKind: binding.writerKind },
  })
  const proposal = createOrchestrationV4({
    workflow: 'auto', template: 'discussion', targetKinds, phase: 'proposal', round: 1,
    snapshot: discussionSnapshot(targetKinds, 1),
  }, { targetKinds, now: 1000 })
  const proposalBinding = synthesisBinding(targetKinds, proposal.snapshot.bodyHash)
  assert.throws(() => parseOrchestrationV4({
    ...proposal,
    synthesisBinding: proposalBinding,
    commitState: { ...proposal.commitState, writerKind: proposalBinding.writerKind },
  }, { targetKinds }), { code: 'ORCHESTRATION_V4_SYNTHESIS_BINDING_INVALID' })

  const incomplete = {
    ...completed,
    slots: completed.slots.map((slot, index) => index === 0 ? {
      ...slot,
      status: 'planned',
      finishedAt: null,
      receiptId: '',
      resultHash: '',
      resultRefs: {
        ...slot.resultRefs,
        workflowOutcomeRefs: slot.resultRefs.workflowOutcomeRefs.filter(item => (
          item.receipt.phase !== 'challenge'
        )),
      },
    } : slot),
  }
  assert.throws(() => parseOrchestrationV4(bind(incomplete), { targetKinds }), {
    code: 'ORCHESTRATION_V4_SYNTHESIS_BINDING_INVALID',
  })

  const bound = bind(completed)
  assert.deepEqual(parseOrchestrationV4(bound, { targetKinds }), bound)
  const verification = { ...bound, phase: 'verification' }
  assert.deepEqual(parseOrchestrationV4(verification, { targetKinds }), verification)
})

test('rejects synthesis binding when challenge barrier receipts drift from snapshot or operation', () => {
  const targetKinds = ['codex', 'hermes', 'workbuddy']
  const completed = completedChallengeOrchestration(targetKinds)
  const binding = synthesisBinding(targetKinds, completed.snapshot.bodyHash)
  const bound = {
    ...completed,
    synthesisBinding: binding,
    commitState: { ...completed.commitState, writerKind: binding.writerKind },
  }

  for (const [field, value] of [
    ['snapshotHash', 'f'.repeat(64)],
    ['operationId', 'operation-other-challenge'],
  ]) {
    const tampered = structuredClone(bound)
    const slot = tampered.slots[0]
    const challenge = slot.resultRefs.workflowOutcomeRefs.find(item => (
      item.receipt.phase === 'challenge'
    ))
    challenge.receipt[field] = value
    assert.throws(() => parseOrchestrationV4(tampered, { targetKinds }), {
      code: 'ORCHESTRATION_V4_SYNTHESIS_BINDING_INVALID',
    }, field)
  }
})

test('retained synthesis binding requires scoped post-challenge receipt evidence', () => {
  const targetKinds = ['codex', 'hermes', 'workbuddy']
  const completed = completedChallengeOrchestration(targetKinds)
  const binding = synthesisBinding(targetKinds, completed.snapshot.bodyHash)
  const retainedForPhase = (proofPhase) => {
    const proofKind = proofPhase === 'synthesis'
      ? binding.writerKind
      : binding.verificationKinds[0]
    const proofSlot = completed.slots.find(slot => slot.agentKind === proofKind)
    const proofReceipt = createCollaborationReceipt({
      phase: proofPhase,
      agentKind: proofKind,
      slotId: proofSlot.slotId,
      operationId: `operation-${proofPhase}-${proofKind}`,
      status: 'completed',
      summary: `${proofKind} completed ${proofPhase}`,
      snapshotHash: completed.snapshotHash,
      deliveryWatermark: 3,
    })
    const slots = completed.slots.map((slot) => ({
      ...slot,
      phase: 'challenge',
      status: 'planned',
      operationId: `operation-round-3-challenge-${slot.agentKind}`,
      receiptId: '',
      resultHash: '',
      finishedAt: null,
      resultRefs: {
        ...slot.resultRefs,
        workflowOutcomeRefs: [
          ...slot.resultRefs.workflowOutcomeRefs.map(item => structuredClone(item)),
          ...(slot.agentKind === proofKind ? [{ receipt: proofReceipt }] : []),
        ],
      },
    }))
    const slotsByKind = new Map(slots.map(slot => [slot.agentKind, slot]))
    const challengeWatermarks = completed.slots.map((slot) => {
      const receipt = slot.resultRefs.workflowOutcomeRefs.find(item => (
        item.receipt.phase === 'challenge'
      )).receipt
      return {
        agentKind: slot.agentKind,
        phase: 'challenge',
        watermark: receipt.deliveryWatermark,
        operationId: receipt.operationId,
        snapshotHash: completed.snapshotHash,
        updatedAt: 1002,
      }
    })
    return {
      ...completed,
      phase: 'challenge',
      round: 3,
      currentKind: '',
      currentKinds: [...targetKinds],
      pendingKinds: [...targetKinds],
      successfulKinds: [],
      totalSuccesses: 0,
      plan: {
        ...completed.plan,
        assignments: completed.plan.assignments.map(assignment => ({
          ...assignment,
          role: 'reviewer',
          operationId: slotsByKind.get(assignment.agentKind).operationId,
        })),
      },
      slots,
      deliveryWatermarks: [
        ...challengeWatermarks,
        {
          agentKind: proofKind,
          phase: proofPhase,
          watermark: proofReceipt.deliveryWatermark,
          operationId: proofReceipt.operationId,
          snapshotHash: completed.snapshotHash,
          updatedAt: 1003,
        },
      ],
      challengeBindings: completed.challengeBindings.map(challengeBinding => ({
        ...challengeBinding,
        round: 3,
        reviewerOperationId: slotsByKind.get(challengeBinding.reviewerKind).operationId,
      })),
      synthesisBinding: binding,
      commitState: { ...completed.commitState, writerKind: binding.writerKind },
    }
  }

  for (const proofPhase of ['synthesis', 'verification']) {
    const retained = retainedForPhase(proofPhase)
    assert.deepEqual(parseOrchestrationV4(retained, { targetKinds }), retained)

    for (const [field, value] of [
      ['snapshotHash', 'e'.repeat(64)],
      ['operationId', `operation-other-${proofPhase}`],
    ]) {
      const tampered = structuredClone(retained)
      const proof = tampered.slots
        .flatMap(slot => slot.resultRefs.workflowOutcomeRefs)
        .find(item => item.receipt.phase === proofPhase)
      proof.receipt[field] = value
      assert.throws(() => parseOrchestrationV4(tampered, { targetKinds }), {
        code: 'ORCHESTRATION_V4_SYNTHESIS_BINDING_INVALID',
      }, `${proofPhase} ${field}`)
    }
  }

  const foreignChallenge = retainedForPhase('synthesis')
  const challenge = foreignChallenge.slots[0].resultRefs.workflowOutcomeRefs.find(item => (
    item.receipt.phase === 'challenge'
  ))
  challenge.receipt.snapshotHash = 'f'.repeat(64)
  assert.throws(() => parseOrchestrationV4(foreignChallenge, { targetKinds }), {
    code: 'ORCHESTRATION_V4_SYNTHESIS_BINDING_INVALID',
  })
})

test('requires synthesis binding for every post-synthesis phase and observable receipt or slot', () => {
  const targetKinds = ['codex', 'hermes', 'workbuddy']
  const completed = completedChallengeOrchestration(targetKinds)
  for (const phase of [
    'synthesis', 'verification', 'human-gate', 'commit', 'committed', 'completed',
  ]) {
    assert.throws(() => parseOrchestrationV4({ ...completed, phase }, { targetKinds }), {
      code: 'ORCHESTRATION_V4_SYNTHESIS_BINDING_REQUIRED',
    })
  }

  assert.throws(() => parseOrchestrationV4({
    ...completed,
    slots: completed.slots.map((slot, index) => index === 0
      ? { ...slot, phase: 'synthesis', status: 'planned', finishedAt: null }
      : slot),
  }, { targetKinds }), { code: 'ORCHESTRATION_V4_SYNTHESIS_BINDING_REQUIRED' })

  const slot = completed.slots[0]
  const synthesisReceipt = createCollaborationReceipt({
    phase: 'synthesis',
    agentKind: slot.agentKind,
    slotId: slot.slotId,
    operationId: slot.operationId,
    status: 'completed',
    summary: 'Synthesis already started.',
    snapshotHash: completed.snapshotHash,
    deliveryWatermark: 3,
  })
  assert.throws(() => parseOrchestrationV4({
    ...completed,
    slots: completed.slots.map((candidate, index) => index === 0 ? {
      ...candidate,
      resultRefs: {
        ...candidate.resultRefs,
        workflowOutcomeRefs: [
          ...candidate.resultRefs.workflowOutcomeRefs,
          { receipt: synthesisReceipt },
        ],
      },
    } : candidate),
  }, { targetKinds }), { code: 'ORCHESTRATION_V4_SYNTHESIS_BINDING_REQUIRED' })
})

test('requires synthesis binding when Auto discussion commit delivery is observable', () => {
  const targetKinds = ['codex', 'hermes', 'workbuddy']
  const proposal = createOrchestrationV4({
    workflow: 'auto', template: 'discussion', targetKinds, phase: 'proposal', round: 1,
    snapshot: discussionSnapshot(targetKinds, 1),
  }, { targetKinds, now: 1000 })
  assert.deepEqual(parseOrchestrationV4(proposal, { targetKinds }), proposal)

  const writerKind = targetKinds[0]
  const remainingKinds = targetKinds.slice(1)
  const observableStates = [
    ['committing status', { ...proposal.commitState, status: 'committing' }],
    ['committed status', {
      ...proposal.commitState,
      status: 'committed',
      writerKind,
      committedKinds: [writerKind],
      pendingKinds: remainingKinds,
    }],
    ['partial status', { ...proposal.commitState, status: 'partial' }],
    ['failed status', { ...proposal.commitState, status: 'failed' }],
    ['writer binding', { ...proposal.commitState, writerKind }],
    ['operation binding', { ...proposal.commitState, operationId: 'operation-commit' }],
    ['committed kind binding', {
      ...proposal.commitState,
      committedKinds: [writerKind],
      pendingKinds: remainingKinds,
    }],
    ['committed slot binding', {
      ...proposal.commitState,
      committedSlotIds: [proposal.slots[0].slotId],
    }],
    ['message sink binding', {
      ...proposal.commitState,
      messageIds: ['message-commit'],
    }],
    ['blackboard sink binding', {
      ...proposal.commitState,
      blackboardEntryIds: [`blackboard-entry-${'a'.repeat(64)}`],
    }],
  ]
  for (const [name, commitState] of observableStates) {
    assert.throws(() => parseOrchestrationV4({
      ...proposal,
      commitState,
    }, { targetKinds }), {
      code: 'ORCHESTRATION_V4_SYNTHESIS_BINDING_REQUIRED',
    }, name)
  }
})

test('preserves strict Auto candidate commit state and rejects sink or transition tampering', () => {
  const targetKinds = ['codex', 'hermes', 'workbuddy']
  const completed = completedChallengeOrchestration(targetKinds)
  const binding = synthesisBinding(targetKinds, completed.snapshot.bodyHash)
  const commit = candidateCommit({ writerKind: binding.writerKind })
  const record = {
    ...completed,
    phase: 'commit',
    synthesisBinding: binding,
    commitState: { ...completed.commitState, writerKind: binding.writerKind },
    candidateCommit: commit,
  }
  assert.deepEqual(
    parseOrchestrationV4(record, { targetKinds }).candidateCommit,
    commit,
  )

  for (const candidateCommitOverride of [
    { ...commit, extra: true },
    { ...commit, candidateBody: 'Candidate final body.' },
    { ...commit, candidateContentHash: 'd'.repeat(64) },
    { ...commit, commitId: `candidate-commit-${'d'.repeat(64)}` },
    { ...commit, messageId: `message-${'d'.repeat(64)}` },
    { ...commit, blackboardEntryId: `blackboard-entry-${'d'.repeat(64)}` },
    { ...commit, status: 'message-committed' },
    { ...commit, status: 'sinks-committed', messageStatus: 'committed' },
    { ...commit, status: 'completed' },
    { ...commit, writerKind: binding.verificationKinds[0] },
  ]) {
    assert.throws(() => parseOrchestrationV4({
      ...record,
      candidateCommit: candidateCommitOverride,
    }, { targetKinds }), { code: 'ORCHESTRATION_V4_CANDIDATE_COMMIT_INVALID' })
  }
})

test('rejects conflicting committed candidate Blackboard body, author, Artifact, or hash', () => {
  const targetKinds = ['codex', 'hermes', 'workbuddy']
  const completed = completedChallengeOrchestration(targetKinds)
  const binding = synthesisBinding(targetKinds, completed.snapshot.bodyHash)
  const intent = candidateCommit({ writerKind: binding.writerKind })
  const committed = {
    ...intent,
    status: 'sinks-committed',
    messageStatus: 'committed',
    blackboardStatus: 'committed',
  }
  const entry = candidateBlackboardEntry(committed)
  const record = {
    ...completed,
    phase: 'commit',
    synthesisBinding: binding,
    commitState: { ...completed.commitState, writerKind: binding.writerKind },
    candidateCommit: committed,
    collaboration: { version: 1, handoffs: [], entries: [entry] },
  }
  assert.equal(
    parseOrchestrationV4(record, { targetKinds }).candidateCommit.status,
    'sinks-committed',
  )

  const conflicts = [
    candidateBlackboardEntry(committed, { statement: 'Conflicting candidate body.' }),
    candidateBlackboardEntry(committed, {
      owner: { type: 'agent', agentKind: binding.verificationKinds[0], role: 'verifier' },
    }),
    candidateBlackboardEntry(committed, {
      refs: [`artifact-${'d'.repeat(64)}`, ...committed.evidenceIds],
    }),
    candidateBlackboardEntry(committed, { value: 'd'.repeat(64) }),
  ]
  for (const conflictingEntry of conflicts) {
    assert.throws(() => parseOrchestrationV4({
      ...record,
      collaboration: { version: 1, handoffs: [], entries: [conflictingEntry] },
    }, { targetKinds }))
  }
})

test('rejects malformed synthesis bindings, hash drift, and commit writer disagreement', () => {
  const targetKinds = ['codex', 'hermes', 'workbuddy']
  const record = completedChallengeOrchestration(targetKinds)
  const binding = synthesisBinding(targetKinds, record.snapshot.bodyHash)
  const bound = {
    ...record,
    synthesisBinding: binding,
    commitState: { ...record.commitState, writerKind: binding.writerKind },
  }
  const reject = (synthesisBindingOverride, commitState = bound.commitState) => assert.throws(
    () => parseOrchestrationV4({
      ...bound,
      synthesisBinding: synthesisBindingOverride,
      commitState,
    }, { targetKinds }),
    { code: 'ORCHESTRATION_V4_SYNTHESIS_BINDING_INVALID' },
  )

  reject({ ...binding, extra: true })
  reject({ ...binding, selectionInputHash: 'f'.repeat(64) })
  reject({ ...binding, candidates: binding.candidates.slice(1) })
  reject({ ...binding, candidates: [binding.candidates[0], binding.candidates[0], binding.candidates[2]] })
  reject({ ...binding, writerKind: 'missing-agent' })
  reject({ ...binding, verificationKinds: [binding.writerKind, binding.verificationKinds[0]] })
  reject({ ...binding, verificationKinds: [binding.verificationKinds[0], binding.verificationKinds[0]] })
  reject({ ...binding, verificationKinds: binding.verificationKinds.slice(0, 1) })
  reject({
    ...binding,
    candidates: binding.candidates.map((candidate, index) => index === 0 ? {
      ...candidate,
      evidence: { ...candidate.evidence, confidence: 2 },
    } : candidate),
  })
  reject(binding, { ...bound.commitState, writerKind: binding.verificationKinds[0] })
})

test('requires bindings for observable challenge state and rejects them outside Auto discussion', () => {
  const record = challengeOrchestration()
  const { challengeBindings: _bindings, ...legacy } = record
  const running = {
    ...legacy,
    currentKind: legacy.slots[0].agentKind,
    currentKinds: [legacy.slots[0].agentKind],
    pendingKinds: [legacy.slots[0].agentKind],
    slots: legacy.slots.map((slot, index) => index === 0
      ? { ...slot, status: 'running' }
      : slot),
  }
  assert.throws(() => parseOrchestrationV4(running, {
    targetKinds: ['codex', 'hermes', 'workbuddy'],
  }), { code: 'ORCHESTRATION_V4_CHALLENGE_BINDING_REQUIRED' })

  const challengeReceipt = createCollaborationReceipt({
    phase: 'challenge',
    agentKind: legacy.slots[0].agentKind,
    slotId: legacy.slots[0].slotId,
    operationId: legacy.slots[0].operationId,
    status: 'completed',
    summary: 'Completed review without its Harness binding.',
    snapshotHash: legacy.snapshotHash,
    deliveryWatermark: 2,
  })
  assert.throws(() => parseOrchestrationV4({
    ...legacy,
    slots: legacy.slots.map((slot, index) => index === 0 ? {
      ...slot,
      resultRefs: {
        ...slot.resultRefs,
        workflowOutcomeRefs: [
          ...slot.resultRefs.workflowOutcomeRefs,
          { receipt: challengeReceipt },
        ],
      },
    } : slot),
  }, { targetKinds: ['codex', 'hermes', 'workbuddy'] }), {
    code: 'ORCHESTRATION_V4_CHALLENGE_BINDING_REQUIRED',
  })

  for (const phase of ['synthesis', 'verification', 'human-gate', 'commit', 'completed']) {
    assert.throws(() => parseOrchestrationV4({ ...legacy, phase }, {
      targetKinds: ['codex', 'hermes', 'workbuddy'],
    }), { code: 'ORCHESTRATION_V4_CHALLENGE_BINDING_REQUIRED' })
  }

  assert.throws(() => parseOrchestrationV4({ ...record, workflow: 'manual' }, {
    targetKinds: ['codex', 'hermes', 'workbuddy'],
  }), { code: 'ORCHESTRATION_V4_CHALLENGE_BINDING_INVALID' })
})

test('rejects challenge binding round, bijection, scope, receipt, and reference tampering', () => {
  const record = challengeOrchestration()
  const mutate = (index, changes) => ({
    ...record,
    challengeBindings: record.challengeBindings.map((binding, bindingIndex) => (
      bindingIndex === index ? { ...binding, ...changes } : binding
    )),
  })
  const invalid = [
    { ...record, challengeBindings: record.challengeBindings.slice(0, -1) },
    mutate(1, { reviewerKind: record.challengeBindings[0].reviewerKind }),
    mutate(0, { proposalKind: record.challengeBindings[0].reviewerKind }),
    mutate(0, { round: 3 }),
    mutate(0, { reviewerSlotId: record.challengeBindings[1].reviewerSlotId }),
    mutate(0, { reviewerOperationId: record.challengeBindings[1].reviewerOperationId }),
    mutate(0, { proposalSlotId: record.challengeBindings[0].reviewerSlotId }),
    mutate(0, { proposalOperationId: 'operation-proposal-tampered' }),
    mutate(0, { proposalReceiptId: 'receipt-tampered' }),
    mutate(0, { artifactIds: ['artifact-tampered'] }),
    mutate(0, { evidenceIds: ['evidence-tampered'] }),
    mutate(0, { extra: true }),
  ]
  for (const candidate of invalid) {
    assert.throws(() => parseOrchestrationV4(candidate, {
      targetKinds: ['codex', 'hermes', 'workbuddy'],
    }), { code: 'ORCHESTRATION_V4_CHALLENGE_BINDING_INVALID' })
  }
})

test('round-trips durable Manual V4 snapshot, result body, and per-slot commit bindings', () => {
  const initial = orchestration()
  const snapshot = {
    ...initial.snapshot,
    contentHash: 'b'.repeat(64),
    contentRef: contentRef(),
  }
  const snapshotHash = hashValue(snapshot)
  const slots = initial.slots.map((slot, index) => ({
    ...slot,
    snapshotHash,
    status: index === 0 ? 'completed' : 'planned',
    finishedAt: index === 0 ? 2000 : null,
    resultBodyArtifactId: index === 0 ? `artifact-${'c'.repeat(64)}` : '',
    commitId: `commit-${'d'.repeat(63)}${index}`,
    messageId: `message-${'e'.repeat(63)}${index}`,
    blackboardEntryId: index === 0 ? `blackboard-entry-${'f'.repeat(63)}${index}` : '',
  }))
  const record = orchestration({
    snapshot,
    snapshotHash,
    plan: {
      ...initial.plan,
      snapshotHash,
    },
    slots,
    currentKinds: ['hermes'],
    pendingKinds: ['hermes'],
    successfulKinds: ['codex'],
    totalSuccesses: 1,
    commitState: {
      status: 'pending',
      writerKind: null,
      committedKinds: [],
      pendingKinds: ['codex'],
      operationId: 'commit-operation-manual',
      attempt: 0,
      updatedAt: 2000,
      committedSlotIds: [],
      messageIds: [],
      blackboardEntryIds: [],
    },
  })

  assert.deepEqual(record.snapshot.contentRef, contentRef())
  assert.equal(record.slots[0].resultBodyArtifactId, `artifact-${'c'.repeat(64)}`)
  assert.equal(record.slots[0].commitId, `commit-${'d'.repeat(63)}0`)
  assert.equal(record.slots[0].messageId, `message-${'e'.repeat(63)}0`)
  assert.equal(record.slots[0].blackboardEntryId, `blackboard-entry-${'f'.repeat(63)}0`)
  assert.deepEqual(parseOrchestrationV4(record, {
    targetKinds: ['codex', 'hermes'],
  }), record)
})

test('rejects invalid Manual V4 content and result-body references', () => {
  const record = orchestration()
  assert.throws(() => parseOrchestrationV4({
    ...record,
    snapshot: { ...record.snapshot, contentRef: { ...record.snapshot.contentRef, size: -1 } },
  }), { code: 'ORCHESTRATION_V4_SNAPSHOT_INVALID' })
  assert.throws(() => parseOrchestrationV4({
    ...record,
    slots: record.slots.map((slot, index) => index === 0
      ? { ...slot, status: 'completed', finishedAt: 2000, resultBodyArtifactId: '' }
      : slot),
  }), { code: 'ORCHESTRATION_V4_SLOT_INVALID' })
  assert.throws(() => parseOrchestrationV4({
    ...record,
    slots: record.slots.map((slot, index) => index === 0
      ? { ...slot, commitId: record.slots[1].commitId }
      : slot),
  }), { code: 'ORCHESTRATION_V4_SLOT_INVALID' })
})

test('binds Manual V4 writer, slot permission, and assignment read-only state', () => {
  const initial = orchestration()
  const writable = {
    ...initial,
    plan: {
      ...initial.plan,
      assignments: initial.plan.assignments.map((assignment, index) => ({
        ...assignment,
        readOnly: index !== 0,
      })),
    },
    slots: initial.slots.map((slot, index) => ({
      ...slot,
      permission: index === 0 ? 'workspace-write' : 'read-only',
    })),
    commitState: {
      ...initial.commitState,
      writerKind: 'codex',
    },
  }
  assert.deepEqual(parseOrchestrationV4(writable, {
    targetKinds: ['codex', 'hermes'],
  }), writable)

  const invalid = [
    {
      ...writable,
      commitState: { ...writable.commitState, writerKind: null },
    },
    {
      ...writable,
      slots: writable.slots.map(slot => ({
        ...slot,
        permission: slot.agentKind === 'hermes' ? 'workspace-write' : 'read-only',
      })),
      plan: {
        ...writable.plan,
        assignments: writable.plan.assignments.map(assignment => ({
          ...assignment,
          readOnly: assignment.agentKind !== 'hermes',
        })),
      },
    },
    {
      ...writable,
      slots: writable.slots.map(slot => ({ ...slot, permission: 'workspace-write' })),
      plan: {
        ...writable.plan,
        assignments: writable.plan.assignments.map(assignment => ({
          ...assignment,
          readOnly: false,
        })),
      },
    },
    {
      ...writable,
      plan: {
        ...writable.plan,
        assignments: writable.plan.assignments.map(assignment => ({
          ...assignment,
          readOnly: false,
        })),
      },
    },
  ]
  for (const record of invalid) {
    assert.throws(() => parseOrchestrationV4(record, {
      targetKinds: ['codex', 'hermes'],
    }), { code: 'ORCHESTRATION_V4_PERMISSION_INVALID' })
  }
})

test('applies receipts idempotently and advances the delivery watermark', () => {
  const initial = orchestration()
  const record = orchestration({
    slots: initial.slots.map((slot, index) => index === 0 ? {
      ...slot,
      resultBodyArtifactId: `artifact-${'a'.repeat(64)}`,
      blackboardEntryId: `blackboard-entry-${'b'.repeat(64)}`,
    } : slot),
  })
  const slot = record.slots[0]
  const receipt = createCollaborationReceipt({
    phase: 'proposal',
    agentKind: slot.agentKind,
    slotId: slot.slotId,
    operationId: slot.operationId,
    status: 'completed',
    summary: 'Independent proposal.',
    snapshotHash: record.snapshotHash,
    deliveryWatermark: 3,
  })
  const updated = applyCollaborationReceipt(record, receipt, {
    targetKinds: ['codex', 'hermes'],
    now: 2000,
  })
  assert.equal(updated.slots[0].deliveryWatermark, 3)
  assert.equal(updated.slots[0].receiptId, receipt.receiptId)
  assert.deepEqual(updated.currentKinds, ['hermes'])
  assert.deepEqual(applyCollaborationReceipt(updated, receipt, {
    targetKinds: ['codex', 'hermes'],
    now: 2500,
  }), updated)
  assert.throws(() => applyCollaborationReceipt(updated, { ...receipt, deliveryWatermark: 2 }, {
    targetKinds: ['codex', 'hermes'],
    now: 3000,
  }), { code: 'COLLABORATION_RECEIPT_CONFLICT' })
  const conflict = createCollaborationReceipt({
    ...receipt,
    summary: 'Conflicting result for the same operation and watermark.',
    receiptId: undefined,
  })
  assert.throws(() => applyCollaborationReceipt(updated, conflict, {
    targetKinds: ['codex', 'hermes'],
    now: 3500,
  }), { code: 'COLLABORATION_RECEIPT_CONFLICT' })

  const stopped = {
    ...updated,
    phase: 'stopped',
    currentKinds: [],
    slots: updated.slots.map(candidate => ({
      ...candidate,
      status: 'stopped',
      finishedAt: candidate.finishedAt || 3600,
    })),
  }
  const lateSlot = stopped.slots[1]
  const late = createCollaborationReceipt({
    phase: 'proposal',
    agentKind: lateSlot.agentKind,
    slotId: lateSlot.slotId,
    operationId: lateSlot.operationId,
    status: 'completed',
    summary: 'Late result after terminal stop.',
    snapshotHash: stopped.snapshotHash,
    deliveryWatermark: 1,
  })
  assert.throws(() => applyCollaborationReceipt(stopped, late, {
    targetKinds: ['codex', 'hermes'],
    now: 4000,
  }), { code: 'COLLABORATION_RECEIPT_TERMINAL' })

  const cancelled = {
    ...updated,
    currentKinds: [],
    slots: updated.slots.map(candidate => candidate.slotId === lateSlot.slotId ? {
      ...candidate,
      status: 'cancelled',
      finishedAt: 3700,
    } : candidate),
  }
  assert.throws(() => applyCollaborationReceipt(cancelled, late, {
    targetKinds: ['codex', 'hermes'],
    now: 4100,
  }), { code: 'COLLABORATION_RECEIPT_TERMINAL' })

  const replacementOperationId = 'operation-replacement-hermes'
  const replaced = {
    ...updated,
    currentKinds: ['hermes'],
    plan: {
      ...updated.plan,
      assignments: updated.plan.assignments.map(assignment => (
        assignment.slotId === lateSlot.slotId
          ? { ...assignment, operationId: replacementOperationId }
          : assignment
      )),
    },
    slots: updated.slots.map(candidate => candidate.slotId === lateSlot.slotId ? {
      ...candidate,
      operationId: replacementOperationId,
      status: 'planned',
    } : candidate),
  }
  assert.throws(() => applyCollaborationReceipt(replaced, late, {
    targetKinds: ['codex', 'hermes'],
    now: 4200,
  }), { code: 'COLLABORATION_RECEIPT_SCOPE' })
})

test('parses result collaboration controls with bounded summaries and rejects unknown fields', () => {
  const result = {
    text: 'final answer',
    collaboration: {
      version: 1,
      phase: 'proposal',
      status: 'accepted',
      summary: 'Bounded result.',
      claims: ['claim'],
      findings: [{ kind: 'risk', summary: 'One risk.' }],
    },
  }
  assert.equal(parseResultCollaboration(result).summary, 'Bounded result.')
  assert.throws(() => parseCollaborationControlBlock({
    ...result.collaboration,
    secret: 'token=private',
  }), { code: 'COLLABORATION_CONTROL_BLOCK_INVALID' })
  assert.throws(() => parseCollaborationControlBlock({
    ...result.collaboration,
    summary: 'x'.repeat(801),
  }), { code: 'ORCHESTRATION_V4_TEXT_INVALID' })
  const marked = parseCollaborationText(
    'Answer.\n[[MELDWORK_COLLABORATION:{"version":1,"phase":"proposal","status":"completed","summary":"ok"}]]',
  )
  assert.equal(marked.text, 'Answer.')
  assert.equal(marked.collaboration.summary, 'ok')
})

test('reports collaboration budget without throwing at the caller boundary', () => {
  assert.deepEqual(collaborationPayloadBudget([
    { summary: 'a'.repeat(800), conclusion: '', unresolved: [] },
    { summary: 'b'.repeat(800), conclusion: '', unresolved: [] },
  ]), { ok: true, totalChars: 1600, summaryLimit: 800, totalLimit: 6000 })
  const over = collaborationPayloadBudget({
    summary: 'a'.repeat(801), conclusion: '', unresolved: [],
  })
  assert.equal(over.ok, false)
  assert.equal(over.error, 'COLLABORATION_PAYLOAD_BUDGET_EXCEEDED')

  const packageRecord = buildCollaborationPackage([{
    version: 1,
    phase: 'challenge',
    status: 'needs-review',
    summary: 'One unresolved issue.',
    unresolved: [{ id: 'issue-1', summary: 'Verify the release artifact.', refs: [] }],
  }])
  assert.match(packageRecord.text, /One unresolved issue/)
  assert.equal(packageRecord.receipts.length, 1)
})

test('normalizes multiple peer-owned work packages into a stable acyclic responsibility plan', () => {
  const targetKinds = ['codex', 'hermes', 'workbuddy']
  const snapshotHash = 'a'.repeat(64)
  const assignments = [
    {
      taskId: 'assemble-delivery',
      ownerKind: 'workbuddy',
      role: 'integrator',
      objective: 'Assemble the two independent work products.',
      expectedOutput: 'One integration-ready Artifact.',
      inputRefs: [],
      artifactIds: [],
      dependsOn: ['inspect-evidence', 'implement-change'],
    },
    {
      taskId: 'implement-change',
      ownerKind: 'hermes',
      role: 'worker',
      objective: 'Implement the agreed bounded change.',
      expectedOutput: 'A tested implementation Artifact.',
      inputRefs: [],
      artifactIds: [],
      dependsOn: [],
    },
    {
      taskId: 'inspect-evidence',
      ownerKind: 'codex',
      role: 'worker',
      objective: 'Inspect the current behavior and collect evidence.',
      expectedOutput: 'An evidence-backed findings Artifact.',
      inputRefs: [],
      artifactIds: [],
      dependsOn: [],
    },
    {
      taskId: 'verify-change',
      ownerKind: 'hermes',
      role: 'verifier',
      objective: 'Verify the bounded implementation after it completes.',
      expectedOutput: 'A verification Artifact.',
      inputRefs: [],
      artifactIds: [],
      dependsOn: ['implement-change'],
    },
  ]
  const plan = createCoordinationPlan({
    snapshotHash,
    targetKinds,
    assignments,
    finalizerKind: 'workbuddy',
    verifierKinds: ['hermes', 'codex'],
    agreedBy: ['workbuddy', 'codex', 'hermes'],
  })
  const reordered = createCoordinationPlan({
    snapshotHash,
    targetKinds: [...targetKinds].reverse(),
    assignments: [...assignments].reverse(),
    finalizerKind: 'workbuddy',
    verifierKinds: ['codex', 'hermes'],
    agreedBy: ['codex', 'hermes', 'workbuddy'],
  })

  assert.deepEqual(plan, reordered)
  assert.deepEqual(plan.assignments.map(item => item.taskId), [
    'assemble-delivery', 'implement-change', 'inspect-evidence', 'verify-change',
  ])
  assert.deepEqual(plan.verifierKinds, ['codex', 'hermes'])
  assert.equal(plan.planHash, hashValue({
    version: 1,
    snapshotHash,
    assignments: plan.assignments,
    finalizerKind: 'workbuddy',
    verifierKinds: ['codex', 'hermes'],
  }))

  assert.throws(() => createCoordinationPlan({
    snapshotHash,
    targetKinds,
    assignments: assignments.filter(item => item.ownerKind !== 'codex'),
    finalizerKind: 'workbuddy',
    verifierKinds: ['codex', 'hermes'],
    agreedBy: targetKinds,
  }), { code: 'ORCHESTRATION_V4_COORDINATION_PLAN_INVALID' })
  assert.throws(() => createCoordinationPlan({
    snapshotHash,
    targetKinds,
    assignments: assignments.map(item => item.taskId === 'inspect-evidence'
      ? { ...item, dependsOn: ['assemble-delivery'] }
      : item),
    finalizerKind: 'workbuddy',
    verifierKinds: ['codex', 'hermes'],
    agreedBy: targetKinds,
  }), { code: 'ORCHESTRATION_V4_COORDINATION_PLAN_INVALID' })
})

test('keeps 32 Agent members while allowing a bounded extra work package', () => {
  const targetKinds = Array.from({ length: 32 }, (_, index) => (
    `agent-${String(index + 1).padStart(2, '0')}`
  ))
  const snapshotHash = 'c'.repeat(64)
  const baseAssignments = targetKinds.map((ownerKind, index) => ({
    taskId: `task-${String(index + 1).padStart(2, '0')}`,
    ownerKind,
    role: index === targetKinds.length - 1 ? 'integrator' : 'worker',
    objective: `Complete work package ${index + 1}.`,
    expectedOutput: `Artifact ${index + 1}.`,
    inputRefs: [],
    artifactIds: [],
    dependsOn: index === targetKinds.length - 1
      ? targetKinds.slice(0, -1).map((_, dependencyIndex) => (
          `task-${String(dependencyIndex + 1).padStart(2, '0')}`
        ))
      : [],
  }))
  const extraAssignment = {
    taskId: 'task-extra-verification',
    ownerKind: targetKinds[0],
    role: 'verifier',
    objective: 'Verify the first work package.',
    expectedOutput: 'Verification Artifact.',
    inputRefs: [],
    artifactIds: [],
    dependsOn: ['task-01'],
  }
  const plan = createCoordinationPlan({
    snapshotHash,
    targetKinds,
    assignments: [...baseAssignments, extraAssignment],
    finalizerKind: targetKinds.at(-1),
    verifierKinds: targetKinds.slice(0, -1),
    agreedBy: targetKinds,
  })

  assert.equal(plan.assignments.length, 33)
  assert.equal(plan.assignments.filter(item => item.ownerKind === targetKinds[0]).length, 2)

  const oversizedAssignments = [
    ...baseAssignments,
    ...Array.from({ length: 33 }, (_, index) => ({
      ...extraAssignment,
      taskId: `task-extra-${String(index + 1).padStart(2, '0')}`,
    })),
  ]
  assert.throws(() => createCoordinationPlan({
    snapshotHash,
    targetKinds,
    assignments: oversizedAssignments,
    finalizerKind: targetKinds.at(-1),
    verifierKinds: targetKinds.slice(0, 2),
    agreedBy: targetKinds,
  }), { code: 'ORCHESTRATION_V4_COORDINATION_PLAN_INVALID' })
})

test('requires every Agent to support the same responsibility graph instead of selecting one', () => {
  const targetKinds = ['codex', 'hermes', 'workbuddy']
  const snapshotHash = 'b'.repeat(64)
  const baseAssignments = targetKinds.map((ownerKind, index) => ({
    taskId: `task-${index + 1}`,
    ownerKind,
    role: ownerKind === 'workbuddy' ? 'integrator' : 'worker',
    objective: `${ownerKind} owned work`,
    expectedOutput: `${ownerKind} Artifact`,
    inputRefs: [],
    artifactIds: [],
    dependsOn: ownerKind === 'workbuddy' ? ['task-1', 'task-2'] : [],
  }))
  const planA = createCoordinationPlan({
    snapshotHash,
    targetKinds,
    assignments: baseAssignments,
    finalizerKind: 'workbuddy',
    verifierKinds: ['codex', 'hermes'],
    agreedBy: targetKinds,
  })
  const planB = createCoordinationPlan({
    snapshotHash,
    targetKinds,
    assignments: baseAssignments.map(item => item.taskId === 'task-2'
      ? { ...item, objective: 'Hermes proposes a different responsibility.' }
      : item),
    finalizerKind: 'workbuddy',
    verifierKinds: ['codex', 'hermes'],
    agreedBy: targetKinds,
  })
  const proposalReceipt = (agentKind, plan) => ({
    version: 1,
    phase: 'challenge',
    agentKind,
    verdict: 'support',
    summary: `${agentKind} responsibility proposal`,
    proposedAssignments: plan.assignments,
    finalizerKind: plan.finalizerKind,
    verifierKinds: plan.verifierKinds,
    agreeToPlan: true,
  })
  const divided = [
    proposalReceipt('codex', planA),
    proposalReceipt('hermes', planB),
    proposalReceipt('workbuddy', planA),
  ]

  const unresolved = resolveCoordinationConsensus({
    targetKinds,
    snapshotHash,
    candidateReceipts: divided,
    supportReceipts: divided,
  })
  assert.equal(unresolved.plan, null)
  assert.deepEqual(unresolved.supportPlanHashes, [planA.planHash, planB.planHash, planA.planHash])

  const unanimous = resolveCoordinationConsensus({
    targetKinds,
    snapshotHash,
    candidateReceipts: divided,
    supportReceipts: targetKinds.map(agentKind => ({
      version: 1,
      phase: 'challenge',
      agentKind,
      verdict: 'support',
      summary: `${agentKind} supports the shared graph`,
      supportedPlanHash: planA.planHash,
      agreeToPlan: true,
    })),
  })
  assert.deepEqual(unanimous.plan, planA)
  assert.deepEqual(unanimous.plan.agreedBy, ['codex', 'hermes', 'workbuddy'])
})

test('binds unanimous coordination to latest support receipts and keeps contradiction unresolved', () => {
  const targetKinds = ['codex', 'hermes', 'workbuddy']
  const snapshotHash = 'c'.repeat(64)
  const assignments = targetKinds.map((ownerKind, index) => ({
    taskId: `task-${index + 1}`,
    ownerKind,
    role: ownerKind === 'workbuddy' ? 'integrator' : 'worker',
    objective: `${ownerKind} owned work`,
    expectedOutput: `${ownerKind} Artifact`,
    inputRefs: [],
    artifactIds: [],
    dependsOn: ownerKind === 'workbuddy' ? ['task-1', 'task-2'] : [],
  }))
  const candidate = createCoordinationPlan({
    snapshotHash,
    targetKinds,
    assignments,
    finalizerKind: 'workbuddy',
    verifierKinds: ['codex', 'hermes'],
    agreedBy: targetKinds,
  })
  const supportRecord = (agentKind, verdict = 'support') => ({
    receipt: createCollaborationReceipt({
      phase: 'challenge',
      agentKind,
      slotId: `slot-${agentKind}`,
      operationId: `operation-${agentKind}`,
      status: 'completed',
      summary: `${agentKind} supports the shared graph`,
      supportedPlanHash: candidate.planHash,
      agreeToPlan: true,
      snapshotHash,
      deliveryWatermark: 2,
    }),
    verdict,
  })
  const supportReceipts = targetKinds.map(kind => supportRecord(kind))

  const unanimous = resolveCoordinationConsensus({
    targetKinds,
    snapshotHash,
    candidateReceipts: [{
      phase: 'challenge',
      agentKind: 'codex',
      proposedAssignments: assignments,
      finalizerKind: 'workbuddy',
      verifierKinds: ['codex', 'hermes'],
    }],
    supportReceipts,
  })

  assert.deepEqual(unanimous.plan.supportReceiptIds, supportReceipts
    .map(record => record.receipt.receiptId).sort())
  const contradicted = resolveCoordinationConsensus({
    targetKinds,
    snapshotHash,
    candidateReceipts: [{
      phase: 'challenge',
      agentKind: 'codex',
      proposedAssignments: assignments,
      finalizerKind: 'workbuddy',
      verifierKinds: ['codex', 'hermes'],
    }],
    supportReceipts: [supportRecord('codex', 'contradict'), ...supportReceipts.slice(1)],
  })
  assert.equal(contradicted.plan, null)
  assert.deepEqual(contradicted.supportPlanHashes, [
    '', candidate.planHash, candidate.planHash,
  ])
})

test('ignores an invalid responsibility candidate so the next challenge round can repair it', () => {
  const targetKinds = ['codex', 'hermes', 'workbuddy']
  const snapshotHash = 'd'.repeat(64)
  const result = resolveCoordinationConsensus({
    targetKinds,
    snapshotHash,
    candidateReceipts: [{
      phase: 'challenge',
      agentKind: 'hermes',
      proposedAssignments: targetKinds.map((ownerKind, index) => ({
        taskId: `task-${index + 1}`,
        ownerKind,
        role: ownerKind === 'workbuddy' ? 'integrator' : 'worker',
        objective: `${ownerKind} work`,
        expectedOutput: `${ownerKind} Artifact`,
        inputRefs: [],
        artifactIds: [],
        dependsOn: ownerKind === 'workbuddy' ? ['task-1', 'task-2'] : [],
      })),
      finalizerKind: 'workbuddy',
      verifierKinds: ['codex'],
      agreeToPlan: true,
    }],
    supportReceipts: [],
  })

  assert.equal(result.plan, null)
  assert.deepEqual(result.candidates, [])
})

test('restores a bound coordination plan only while every latest challenge receipt supports its hash', () => {
  const targetKinds = ['codex', 'hermes', 'workbuddy']
  const base = challengeOrchestration(targetKinds)
  const candidate = createCoordinationPlan({
    snapshotHash: base.snapshotHash,
    targetKinds,
    assignments: targetKinds.map((ownerKind, index) => ({
      taskId: `task-${index + 1}`,
      ownerKind,
      role: ownerKind === 'workbuddy' ? 'integrator' : 'worker',
      objective: `${ownerKind} work`,
      expectedOutput: `${ownerKind} Artifact`,
      inputRefs: [],
      artifactIds: [],
      dependsOn: ownerKind === 'workbuddy' ? ['task-1', 'task-2'] : [],
    })),
    finalizerKind: 'workbuddy',
    verifierKinds: ['codex', 'hermes'],
    agreedBy: targetKinds,
  })
  const supportRecords = base.slots.map(slot => ({
    receipt: createCollaborationReceipt({
      phase: 'challenge',
      agentKind: slot.agentKind,
      slotId: slot.slotId,
      operationId: slot.operationId,
      status: 'completed',
      summary: `${slot.agentKind} supports the shared graph`,
      supportedPlanHash: candidate.planHash,
      agreeToPlan: true,
      snapshotHash: base.snapshotHash,
      deliveryWatermark: 2,
    }),
    verdict: 'support',
  }))
  const coordinationPlan = resolveCoordinationConsensus({
    targetKinds,
    snapshotHash: base.snapshotHash,
    candidateReceipts: [{
      phase: 'challenge',
      proposedAssignments: candidate.assignments,
      finalizerKind: candidate.finalizerKind,
      verifierKinds: candidate.verifierKinds,
    }],
    supportReceipts: supportRecords,
  }).plan
  const coordinated = {
    ...base,
    phase: 'coordination',
    currentKinds: [],
    pendingKinds: [],
    successfulKinds: [...targetKinds],
    totalSuccesses: targetKinds.length,
    slots: base.slots.map((slot) => {
      const support = supportRecords.find(record => record.receipt.agentKind === slot.agentKind)
      return {
        ...slot,
        phase: 'challenge',
        status: 'completed',
        finishedAt: 1001,
        receiptId: support.receipt.receiptId,
        resultHash: hashValue(support.receipt),
        resultRefs: {
          ...slot.resultRefs,
          workflowOutcomeRefs: [...slot.resultRefs.workflowOutcomeRefs, support],
        },
      }
    }),
    coordinationPlan,
    commitState: { ...base.commitState, writerKind: coordinationPlan.finalizerKind },
  }

  assert.deepEqual(parseOrchestrationV4(coordinated, { targetKinds }), coordinated)
  const stale = structuredClone(coordinated)
  const staleSlot = stale.slots.find(slot => slot.agentKind === 'hermes')
  const ordinaryReceipt = createCollaborationReceipt({
    phase: 'challenge',
    agentKind: 'hermes',
    slotId: staleSlot.slotId,
    operationId: staleSlot.operationId,
    status: 'completed',
    summary: 'Hermes discussed the proposal without supporting the plan.',
    snapshotHash: base.snapshotHash,
    deliveryWatermark: 3,
  })
  staleSlot.resultRefs.workflowOutcomeRefs.push({ receipt: ordinaryReceipt, verdict: 'support' })
  staleSlot.receiptId = ordinaryReceipt.receiptId
  staleSlot.resultHash = hashValue(ordinaryReceipt)
  staleSlot.deliveryWatermark = 3

  assert.throws(() => parseOrchestrationV4(stale, { targetKinds }), {
    code: 'ORCHESTRATION_V4_COORDINATION_PLAN_INVALID',
  })
})

test('renders a deterministic bounded package with a stable index for every selected Agent', () => {
  const targetKinds = Array.from({ length: 32 }, (_, index) => `agent-${String(index).padStart(2, '0')}`)
  const receipts = targetKinds.map((agentKind, index) => createCollaborationReceipt({
    phase: 'proposal',
    agentKind,
    slotId: `slot-${index}`,
    operationId: `operation-${index}`,
    status: 'completed',
    summary: `${agentKind} ${'summary '.repeat(98)}`,
    conclusion: `${agentKind} conclusion`,
    artifactIds: ['artifact-shared', `artifact-${index}`],
    evidenceIds: ['evidence-shared', `evidence-${index}`],
    unresolved: [{ id: `issue-${index}`, summary: `${agentKind} unresolved`, refs: [] }],
    snapshotHash: 'a'.repeat(64),
    deliveryWatermark: index + 1,
  }))
  const packageRecord = buildCollaborationPackage(receipts, { targetKinds })

  assert.ok(packageRecord.text.length <= 6000)
  assert.equal(packageRecord.totalChars, packageRecord.text.length)
  for (const agentKind of targetKinds) {
    assert.match(packageRecord.text, new RegExp(`\\[index\\] ${agentKind}\\b`))
  }
  assert.equal((packageRecord.text.match(/artifact-shared/g) || []).length, 1)
  assert.equal((packageRecord.text.match(/evidence-shared/g) || []).length, 1)
  assert.doesNotMatch(packageRecord.text, /Conclusion:/)
  assert.ok(packageRecord.receipts.every(receipt => receipt.summary.length <= 800))
})

test('returns the complete index without receipts when Agent prefixes exceed the package remainder', () => {
  const targetKinds = Array.from({ length: 32 }, (_value, index) => (
    `agent-${String(index + 1).padStart(2, '0')}-${'a'.repeat(108)}`
  ))
  const receipts = targetKinds.map((agentKind, index) => createCollaborationReceipt({
    phase: 'proposal',
    agentKind,
    slotId: `slot-${index + 1}`,
    operationId: `operation-${index + 1}`,
    status: 'completed',
    summary: `Proposal ${index + 1}`,
    snapshotHash: 'a'.repeat(64),
    deliveryWatermark: 1,
  }))
  const indexText = [
    'MELDWORK_V4_COLLABORATION_PACKAGE_V1',
    ...targetKinds.map(kind => `[index] ${kind}`),
  ].join('\n')

  const packageRecord = buildCollaborationPackage(receipts, {
    targetKinds,
    totalLimit: indexText.length,
  })

  assert.equal(packageRecord.text, indexText)
  assert.equal(packageRecord.totalChars, indexText.length)
  assert.deepEqual(packageRecord.receipts, [])
  assert.deepEqual(packageRecord.deliveryWatermarks, [])
})

test('keeps valid receipts valid when the rendered package has only index space', () => {
  const targetKinds = ['codex', 'hermes']
  const receipt = createCollaborationReceipt({
    phase: 'challenge',
    agentKind: 'hermes',
    slotId: 'slot-hermes',
    operationId: 'operation-hermes',
    status: 'completed',
    summary: 's'.repeat(700),
    capabilities: ['c'.repeat(700)],
    intendedWork: ['i'.repeat(700)],
    deliverables: ['d'.repeat(700)],
    snapshotHash: 'a'.repeat(64),
    deliveryWatermark: 2,
  })
  const indexText = [
    'MELDWORK_V4_COLLABORATION_PACKAGE_V1',
    '[index] codex',
    '[index] hermes',
  ].join('\n')

  const packageRecord = buildCollaborationPackage([receipt], {
    targetKinds,
    totalLimit: indexText.length,
  })

  assert.equal(packageRecord.text, indexText)
  assert.deepEqual(packageRecord.receipts, [])
})

test('reserves every selected Agent latest conclusion before optional package references', () => {
  const targetKinds = Array.from({ length: 32 }, (_, index) => `agent-${String(index).padStart(2, '0')}`)
  const receipts = targetKinds.map((agentKind, index) => createCollaborationReceipt({
    phase: 'proposal',
    agentKind,
    slotId: `slot-${index}`,
    operationId: `operation-${index}`,
    status: 'completed',
    summary: `${agentKind} ${'summary '.repeat(90)}`,
    artifactIds: Array.from({ length: 8 }, (_, refIndex) => (
      `artifact-${index}-${refIndex}-${'a'.repeat(30)}`
    )),
    evidenceIds: Array.from({ length: 8 }, (_, refIndex) => (
      `evidence-${index}-${refIndex}-${'b'.repeat(30)}`
    )),
    unresolved: Array.from({ length: 8 }, (_, issueIndex) => ({
      id: `issue-${index}-${issueIndex}`,
      summary: 'unresolved '.repeat(30),
      refs: [],
    })),
    snapshotHash: 'a'.repeat(64),
    deliveryWatermark: 1,
  }))

  const packageRecord = buildCollaborationPackage(receipts, { targetKinds })

  assert.ok(packageRecord.text.length <= 6000)
  assert.deepEqual(packageRecord.receipts.map(receipt => receipt.agentKind), targetKinds)
  for (const agentKind of targetKinds) {
    assert.match(packageRecord.text, new RegExp(`\\[proposal\\] agent=${agentKind} `))
  }
})

test('round-trips bounded recipient delivery acknowledgement without a native Session reference', () => {
  const record = orchestration({
    deliveryState: [{
      recipientKind: 'codex',
      sessionRefHash: '1'.repeat(64),
      sessionProvenanceHash: '2'.repeat(64),
      sourceAgentKind: 'hermes',
      sourcePhase: 'proposal',
      watermark: 3,
      snapshotHash: '3'.repeat(64),
      operationId: 'operation-hermes',
      packageHash: '4'.repeat(64),
      deliveryId: 'delivery-1',
      status: 'acknowledged',
      updatedAt: 1000,
    }],
  })
  assert.equal(record.deliveryState?.length, 1)
  assert.deepEqual(parseOrchestrationV4(record, { targetKinds: ['codex', 'hermes'] }), record)
  const natural = parseOrchestrationV4({
    ...record,
    deliveryState: [{ ...record.deliveryState[0], sourceMessages: [{ id: 'message-1', hash: '5'.repeat(64) }] }],
  }, { targetKinds: ['codex', 'hermes'] })
  assert.deepEqual(natural.deliveryState[0].sourceMessages, [{ id: 'message-1', hash: '5'.repeat(64) }])
  for (const sourceMessages of [
    [], [{ id: 'message-1', hash: 'bad' }], [{ id: 'message-1', hash: '5'.repeat(64), text: 'do not persist' }],
    Array.from({ length: 101 }, (_, index) => ({ id: `message-${index}`, hash: '5'.repeat(64) })),
    [{ id: 'message-1', hash: '5'.repeat(64) }, { id: 'message-1', hash: '6'.repeat(64) }],
  ]) {
    assert.throws(() => parseOrchestrationV4({
      ...record, deliveryState: [{ ...record.deliveryState[0], sourceMessages }],
    }, { targetKinds: ['codex', 'hermes'] }), { code: 'ORCHESTRATION_V4_DELIVERY_STATE_INVALID' })
  }
  assert.throws(() => parseOrchestrationV4({
    ...record,
    deliveryState: [{ ...record.deliveryState[0], sessionRef: 'must-not-persist' }],
  }, { targetKinds: ['codex', 'hermes'] }), { code: 'ORCHESTRATION_V4_DELIVERY_STATE_INVALID' })
})

test('round-trips an optional private Harness attempt binding without changing older slots', () => {
  const legacy = orchestration()
  assert.equal(Object.hasOwn(legacy.slots[0], 'agentRunId'), false)
  assert.deepEqual(parseOrchestrationV4(legacy, {
    targetKinds: ['codex', 'hermes'],
  }), legacy)

  const bound = parseOrchestrationV4({
    ...legacy,
    slots: legacy.slots.map((slot, index) => index === 0
      ? { ...slot, agentRunId: 'agent-run-private-codex' }
      : slot),
  }, { targetKinds: ['codex', 'hermes'] })

  assert.equal(bound.slots[0].agentRunId, 'agent-run-private-codex')
  assert.equal(Object.hasOwn(bound.slots[1], 'agentRunId'), false)
})

test('rejects malformed private Harness attempt bindings on V4 slots', () => {
  const record = orchestration()
  for (const agentRunId of ['', 'private attempt', '\u0000invalid']) {
    assert.throws(() => parseOrchestrationV4({
      ...record,
      slots: record.slots.map((slot, index) => index === 0
        ? { ...slot, agentRunId }
        : slot),
    }, { targetKinds: ['codex', 'hermes'] }), { code: 'ORCHESTRATION_V4_SLOT_INVALID' })
  }
})

const test = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { RunLedger } = require('../../src/runs/run-ledger.cjs')
const {
  appendHandoff,
  createBlackboardEntryRecord,
  emptyCollaborationState,
} = require('../../src/collaboration/collaboration-records.cjs')
const {
  createCollaborationReceipt,
  createCoordinationPlan,
  createOrchestrationV4,
  createSynthesisBinding,
  createWorkReceipt,
  hashValue,
} = require('../../src/collaboration/orchestration-v4-records.cjs')
const { createTaskGraph, createTaskGraphCursor } = require('../../src/collaboration/task-graph-records.cjs')

test('keeps the ledger facade limited to RunLedger', () => {
  assert.deepEqual(Object.keys(require('../../src/runs/run-ledger.cjs')), ['RunLedger'])
})

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-run-ledger-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return {
    directory,
    storagePath: path.join(directory, 'private', 'run-ledger.json'),
  }
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
    contentRef: {
      algorithm: 'sha256', hash, size: 123, mediaType: 'application/json',
    },
  }
}

function candidateCommitState({ runId, taskId, groupId, threadRootId, writerKind }) {
  const candidateBody = 'Ledger candidate body.'
  const candidateContentHash = createHash('sha256').update(candidateBody).digest('hex')
  const candidateArtifactId = `artifact-${'5'.repeat(64)}`
  const evidenceIds = [`evidence-${'7'.repeat(64)}`]
  const writerRole = 'integrator'
  const sinkId = (prefix, sink) => {
    const body = JSON.stringify({ candidateContentHash, runId, sink, taskId })
    return `${prefix}-${createHash('sha256').update(body).digest('hex')}`
  }
  const commitId = sinkId('candidate-commit', 'commit')
  const blackboardEntry = createBlackboardEntryRecord({
    entryType: 'artifact-ref', subject: `candidate-commit:${commitId}`,
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
    status: 'intent', runId, taskId, groupId, threadRootId,
    candidateArtifactId,
    candidateContentHash,
    candidateContentRef: {
      algorithm: 'sha256', hash: candidateContentHash, size: 31, mediaType: 'text/plain',
    },
    evidenceIds,
    writerKind, writerRole,
    commitId,
    messageId: sinkId('message', 'message'),
    blackboardEntryId: blackboardEntry.entryId,
    blackboardSequence: 1, blackboardRecordedAt: 0,
    messageStatus: 'pending', blackboardStatus: 'pending',
    attempt: 1, updatedAt: 1001,
  }
}

function runRecord(runId, groupId, status = 'running', agentRuns = []) {
  return {
    runId,
    taskId: `${runId}-task`,
    contextPackId: `context-pack-${'a'.repeat(64)}`,
    contextPackState: 'captured',
    groupId,
    threadRootId: `${groupId}-root`,
    mode: 'manual',
    targetKinds: ['codex'],
    status,
    permissionMode: 'read-only',
    agentRuns,
  }
}

test('recovers legacy multi-writer discussions as interrupted history with original backups', (t) => {
  const { directory, storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  const targetKinds = ['codex', 'hermes']
  const orchestration = createOrchestrationV4({
    workflow: 'auto', template: 'discussion', targetKinds, phase: 'proposal', round: 1,
    snapshot: discussionSnapshot(targetKinds, 1),
  }, { targetKinds, now: 1000 })
  ledger.checkpoint({ ...runRecord('legacy-run', 'legacy-group', 'running', [{
    agentRunId: 'legacy-agent', kind: 'codex', round: 1, status: 'completed',
    output: 'Preserved answer', sourceMessageIds: [], startedAt: 1000, lastActivityAt: 1000,
    context: { includedCount: 0, omittedCount: 0, charCount: 0 },
  }]), mode: 'auto',
    targetKinds, orchestration })
  const makeLegacy = (record) => {
    if (record.orchestration) record.orchestration.slots.forEach(slot => { slot.permission = 'workspace-write' })
    for (const agent of record.agentRuns || []) agent.context.taskDecision = {
      status: 'completed', reason: 'Done', deliverables: ['answer'], reviewedVersion: 'old',
    }
  }
  const snapshot = JSON.parse(fs.readFileSync(storagePath, 'utf8'))
  snapshot.runs.forEach(makeLegacy)
  const originalSnapshot = JSON.stringify(snapshot) + '\n'
  fs.writeFileSync(storagePath, originalSnapshot)
  const journalPath = `${storagePath}.journal`
  const entries = fs.readFileSync(journalPath, 'utf8').trim().split('\n').map(JSON.parse)
  for (const entry of entries) for (const run of entry.change?.upserts || []) makeLegacy(run)
  const originalJournal = entries.map(entry => JSON.stringify(entry)).join('\n') + '\n'
  fs.writeFileSync(journalPath, originalJournal)

  const restored = new RunLedger({ storagePath, now: () => 1100 })
  assert.equal(restored.loadError, null)
  assert.equal(restored.get('legacy-run').status, 'interrupted')
  assert.equal(restored.get('legacy-run').orchestration, undefined)
  assert.equal(restored.get('legacy-run').agentRuns[0].output, 'Preserved answer')
  assert.equal(restored.get('legacy-run').agentRuns[0].context.taskDecision, undefined)
  const backups = fs.readdirSync(path.dirname(storagePath)).filter(name => name.includes('.legacy-backup-'))
  assert.equal(backups.length, 2)
  assert.equal(fs.readFileSync(path.join(path.dirname(storagePath), backups.find(name => !name.includes('.journal'))), 'utf8'), originalSnapshot)
  assert.equal(fs.readFileSync(path.join(path.dirname(storagePath), backups.find(name => name.includes('.journal'))), 'utf8'), originalJournal)
  assert.equal(new RunLedger({ storagePath, now: () => 1200 }).loadError, null)
})

function budgetSnapshot(overrides = {}) {
  const dimensions = [
    'inputTokens', 'outputTokens', 'costMicros', 'toolCalls', 'outboundBytes', 'elapsedMs',
  ]
  return {
    limits: Object.fromEntries(dimensions.map(dimension => [dimension, null])),
    used: Object.fromEntries(dimensions.map(dimension => [dimension, 0])),
    source: Object.fromEntries(dimensions.map(dimension => [dimension, 'unknown'])),
    enforcement: Object.fromEntries(dimensions.map(dimension => [dimension, 'soft'])),
    startedAt: 1000,
    ...overrides,
  }
}

function attemptHistory() {
  return [{
    sequence: 1,
    agentKind: 'hermes',
    phase: 'initial',
    attempt: 1,
    failureCategory: 'authentication',
    policyAction: 'retry',
    backoffMs: 250,
    recoveryAgentKind: '',
    finalOutcome: 'failed',
    outcomeCertainty: 'unknown_outcome',
    sideEffectsPossible: true,
    operationId: `agent-operation-${'a'.repeat(64)}`,
    idempotencyMode: 'none',
    timestamp: 1000,
  }, {
    sequence: 2,
    agentKind: 'hermes',
    phase: 'recovery_agent',
    attempt: 1,
    failureCategory: null,
    policyAction: 'verify',
    backoffMs: 250,
    recoveryAgentKind: 'codex',
    finalOutcome: 'succeeded',
    sideEffectsPossible: false,
    operationId: `agent-operation-${'b'.repeat(64)}`,
    idempotencyMode: 'durable',
    timestamp: 1100,
  }]
}

test('loads exact v1 orchestration cursors and persists strict v2 collaboration state', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  const baseCursor = {
    workflow: 'auto',
    currentKind: '',
    pendingKinds: ['codex', 'hermes'],
    activeKinds: ['codex', 'hermes'],
    successfulKinds: [],
    agreementKinds: [],
    attachmentRecipients: [],
    totalSuccesses: 0,
    terminalFailureOccurred: false,
  }
  const legacy = ledger.checkpoint({
    ...runRecord('run-orchestration-v1', 'group-orchestration-v1'),
    mode: 'auto',
    targetKinds: ['codex', 'hermes'],
    currentRound: 1,
    maxRounds: 2,
    orchestration: { version: 1, ...baseCursor },
  })
  assert.deepEqual(legacy.orchestration, { version: 1, ...baseCursor })

  const collaboration = appendHandoff(emptyCollaborationState(), {
    source: { type: 'harness' },
    destination: { agentKind: 'codex', role: 'primary' },
    objective: 'Assess the release.',
    selectedEntryIds: [],
    expectedOutput: 'One conclusion.',
    acceptanceCriteria: ['Use selected state only.'],
    provenance: {
      runId: 'run-orchestration-v2',
      taskId: 'run-orchestration-v2-task',
      round: 1,
      agentRunId: null,
      artifactIds: [],
      evidenceIds: [],
    },
    createdAt: 1000,
  })
  const current = ledger.checkpoint({
    ...runRecord('run-orchestration-v2', 'group-orchestration-v2'),
    mode: 'auto',
    targetKinds: ['codex', 'hermes'],
    currentRound: 1,
    maxRounds: 2,
    orchestration: { version: 2, ...baseCursor, collaboration },
  })
  assert.deepEqual(current.orchestration.collaboration, collaboration)

  const restarted = new RunLedger({ storagePath, now: () => 1100 })
  assert.deepEqual(restarted.get(legacy.runId).orchestration, legacy.orchestration)
  assert.deepEqual(restarted.get(current.runId).orchestration, current.orchestration)
  assert.throws(() => ledger.checkpoint({
    ...runRecord('run-orchestration-invalid', 'group-orchestration-invalid'),
    mode: 'auto',
    targetKinds: ['codex', 'hermes'],
    currentRound: 1,
    maxRounds: 2,
    orchestration: { version: 1, ...baseCursor, collaboration },
  }), { message: 'RUN_LEDGER_RECORD_INVALID' })
})

test('persists strict v3 task-graph cursors without weakening v1 and v2 loading', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  const graph = createTaskGraph({
    template: 'task-graph',
    nodes: [{
      nodeId: 'primary-codex', role: 'primary', agentKind: 'codex',
      dependsOn: [], inputNodeIds: [], expectedOutput: 'Produce a durable conclusion.',
      acceptance: { requireConclusion: true, minArtifactRefs: 1, minEvidenceRefs: 1 },
      terminal: true, parallel: false, decisionOptions: [],
    }],
  }, ['codex'])
  const taskGraph = createTaskGraphCursor(graph, 1000)
  const saved = ledger.checkpoint({
    ...runRecord('run-orchestration-v3', 'group-orchestration-v3'),
    mode: 'auto',
    currentRound: 0,
    maxRounds: 2,
    orchestration: {
      version: 3,
      workflow: 'auto',
      template: 'task-graph',
      currentKind: '',
      pendingKinds: ['codex'],
      activeKinds: ['codex'],
      successfulKinds: [],
      agreementKinds: [],
      attachmentRecipients: [],
      totalSuccesses: 0,
      terminalFailureOccurred: false,
      collaboration: emptyCollaborationState(),
      taskGraph,
    },
  })
  assert.equal(saved.orchestration.version, 3)
  assert.deepEqual(saved.orchestration.taskGraph, taskGraph)
  assert.deepEqual(
    new RunLedger({ storagePath, now: () => 1100 }).get(saved.runId).orchestration,
    saved.orchestration,
  )
  assert.throws(() => ledger.checkpoint({
    runId: saved.runId,
    orchestration: {
      ...saved.orchestration,
      taskGraph: { ...taskGraph, terminalState: 'accepted' },
    },
  }), { message: 'RUN_LEDGER_RECORD_INVALID' })
})

test('persists strict v4 concurrent batch state and rejects mutated snapshot bindings', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  const orchestration = createOrchestrationV4({
    workflow: 'manual',
    template: 'concurrent-batch',
    targetKinds: ['codex', 'hermes'],
    collaboration: emptyCollaborationState(),
  }, { targetKinds: ['codex', 'hermes'], now: 1000 })
  const saved = ledger.checkpoint({
    ...runRecord('run-orchestration-v4', 'group-orchestration-v4'),
    targetKinds: ['codex', 'hermes'],
    orchestration,
  })
  assert.equal(saved.orchestration.version, 4)
  assert.deepEqual(saved.orchestration.currentKinds, ['codex', 'hermes'])
  assert.equal(saved.orchestration.plan.snapshotHash, saved.orchestration.snapshotHash)

  const restored = new RunLedger({ storagePath, now: () => 1100 })
  assert.deepEqual(restored.get(saved.runId).orchestration, saved.orchestration)
  assert.throws(() => ledger.checkpoint({
    runId: saved.runId,
    orchestration: {
      ...saved.orchestration,
      slots: saved.orchestration.slots.map((slot, index) => index === 0
        ? { ...slot, snapshotHash: 'b'.repeat(64) }
        : slot),
    },
  }), { message: 'RUN_LEDGER_RECORD_INVALID' })
  assert.deepEqual(ledger.get(saved.runId).orchestration, saved.orchestration)
})

test('roundtrips Auto candidate commit state and rejects parent or sink tampering', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  const targetKinds = ['codex', 'hermes', 'workbuddy']
  const base = createOrchestrationV4({
    workflow: 'auto', template: 'discussion', targetKinds, phase: 'coordination', round: 2,
    snapshot: discussionSnapshot(targetKinds, 2),
  }, { targetKinds, now: 1000 })
  const coordinationPlan = createCoordinationPlan({
    snapshotHash: base.snapshotHash,
    targetKinds,
    assignments: [
      { taskId: 'codex-work', ownerKind: 'codex', role: 'worker', objective: 'Codex work.', expectedOutput: 'Codex Artifact.', inputRefs: [], artifactIds: [], dependsOn: [] },
      { taskId: 'hermes-work', ownerKind: 'hermes', role: 'worker', objective: 'Hermes work.', expectedOutput: 'Hermes Artifact.', inputRefs: [], artifactIds: [], dependsOn: [] },
      { taskId: 'integrate-work', ownerKind: 'workbuddy', role: 'integrator', objective: 'Integrate work.', expectedOutput: 'Integrated Artifact.', inputRefs: [], artifactIds: [], dependsOn: ['codex-work', 'hermes-work'] },
    ],
    finalizerKind: 'workbuddy', verifierKinds: ['codex', 'hermes'], agreedBy: targetKinds,
  })
  const runId = 'run-v4-candidate-commit'
  const groupId = 'group-v4-candidate-commit'
  const parent = runRecord(runId, groupId)
  const candidateCommit = candidateCommitState({
    runId, taskId: parent.taskId, groupId, threadRootId: parent.threadRootId,
    writerKind: coordinationPlan.finalizerKind,
  })
  const orchestration = createOrchestrationV4({
    ...base,
    phase: 'commit',
    currentKinds: [], pendingKinds: [],
    coordinationPlan,
    commitState: { ...base.commitState, writerKind: coordinationPlan.finalizerKind },
    candidateCommit,
  }, { targetKinds, now: 1001 })
  const saved = ledger.checkpoint({
    ...parent, mode: 'auto', targetKinds, currentRound: 2, maxRounds: 3, orchestration,
  })

  assert.deepEqual(saved.orchestration.candidateCommit, candidateCommit)
  assert.deepEqual(
    new RunLedger({ storagePath, now: () => 1100 }).get(runId).orchestration.candidateCommit,
    candidateCommit,
  )
  for (const candidateCommitOverride of [
    { ...candidateCommit, taskId: 'different-task' },
    { ...candidateCommit, groupId: 'different-group' },
    { ...candidateCommit, threadRootId: 'different-thread' },
    { ...candidateCommit, messageId: `message-${'8'.repeat(64)}` },
  ]) {
    assert.throws(() => ledger.checkpoint({
      runId,
      orchestration: { ...saved.orchestration, candidateCommit: candidateCommitOverride },
    }))
  }
})

test('preserves validated V4 recipient delivery acknowledgement through the Run Ledger', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  const orchestration = createOrchestrationV4({
    workflow: 'manual',
    template: 'concurrent-batch',
    targetKinds: ['codex', 'hermes'],
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
  }, { targetKinds: ['codex', 'hermes'], now: 1000 })
  const saved = ledger.checkpoint({
    ...runRecord('run-v4-delivery-state', 'group-v4-delivery-state'),
    targetKinds: ['codex', 'hermes'],
    orchestration,
  })
  assert.equal(orchestration.deliveryState?.length, 1)
  assert.deepEqual(new RunLedger({ storagePath, now: () => 1100 }).get(saved.runId).orchestration.deliveryState,
    orchestration.deliveryState)
})

test('restart retains same-Run delivery acknowledgements without sharing a concurrent Run state', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  const targetKinds = ['codex', 'hermes', 'workbuddy', 'kimi', 'openclaw']
  const sessionBindings = [
    { recipientKind: 'codex', sessionRefHash: '1'.repeat(64), sessionProvenanceHash: '2'.repeat(64) },
    { recipientKind: 'hermes', sessionRefHash: '3'.repeat(64), sessionProvenanceHash: '4'.repeat(64) },
  ]
  const deliveryState = sessionBindings.flatMap(binding => targetKinds.map((sourceAgentKind) => ({
    ...binding,
    sourceAgentKind,
    sourcePhase: 'proposal',
    watermark: 3,
    snapshotHash: '5'.repeat(64),
    operationId: `operation-wave-3-${sourceAgentKind}`,
    packageHash: '6'.repeat(64),
    deliveryId: `delivery-${binding.recipientKind}-${sourceAgentKind}-wave-3`,
    status: 'acknowledged',
    updatedAt: 1000,
  }))).sort((left, right) => [
    left.recipientKind, left.sessionRefHash, left.sessionProvenanceHash,
    left.sourceAgentKind, left.sourcePhase,
  ].join('\u0000').localeCompare([
    right.recipientKind, right.sessionRefHash, right.sessionProvenanceHash,
    right.sourceAgentKind, right.sourcePhase,
  ].join('\u0000')))
  const orchestration = createOrchestrationV4({
    workflow: 'manual', template: 'concurrent-batch', targetKinds, deliveryState,
  }, { targetKinds, now: 1000 })
  const runA = ledger.checkpoint({
    ...runRecord('run-v4-restart-a', 'group-v4-restart-a'),
    targetKinds,
    orchestration,
  })
  const runB = ledger.checkpoint({
    ...runRecord('run-v4-restart-b', 'group-v4-restart-b'),
    targetKinds,
    orchestration: createOrchestrationV4({
      workflow: 'manual', template: 'concurrent-batch', targetKinds,
    }, { targetKinds, now: 1000 }),
  })

  const restarted = new RunLedger({ storagePath, now: () => 1100 })
  assert.deepEqual(restarted.get(runA.runId).orchestration.deliveryState, deliveryState)
  assert.equal(restarted.get(runB.runId).orchestration.deliveryState, undefined)
})

test('roundtrips V4 agent-slot invocation bindings and rejects legacy or tampered bindings', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  const targetKinds = ['codex']
  const orchestration = createOrchestrationV4({
    workflow: 'auto', template: 'discussion', targetKinds, phase: 'proposal', round: 1,
    snapshot: discussionSnapshot(targetKinds, 1),
  }, { targetKinds, now: 1000 })
  const slot = orchestration.slots[0]
  const continuation = {
    gateId: `human-gate-${'b'.repeat(64)}`,
    gateType: 'permission',
    resumeKind: 'agent_slot',
    state: 'pending',
    agentRunId: 'agent-run-v4-bound',
    agentKind: 'codex',
    round: 1,
    phase: 'proposal',
    slotId: slot.slotId,
    operationId: slot.operationId,
    snapshotHash: orchestration.snapshotHash,
    createdAt: 1000,
    updatedAt: 1000,
  }
  const saved = ledger.checkpoint({
    ...runRecord('run-v4-bound-continuation', 'group-v4-bound-continuation'),
    mode: 'auto',
    targetKinds,
    status: 'waiting',
    currentRound: 1,
    maxRounds: 3,
    orchestration,
    continuation,
  })

  assert.deepEqual(saved.continuation, continuation)
  assert.deepEqual(
    new RunLedger({ storagePath, now: () => 1100 }).get(saved.runId).continuation,
    continuation,
  )
  for (const patch of [
    { phase: 'challenge' },
    { slotId: 'slot-tampered-codex' },
    { operationId: 'operation-tampered-codex' },
    { snapshotHash: 'f'.repeat(64) },
    { round: 2 },
  ]) {
    assert.throws(() => ledger.checkpoint({
      runId: saved.runId,
      continuation: { ...continuation, ...patch },
    }), { message: 'RUN_LEDGER_RECORD_INVALID' })
    assert.deepEqual(ledger.get(saved.runId).continuation, continuation)
  }
  assert.throws(() => ledger.checkpoint({
    ...runRecord('run-legacy-bound-continuation', 'group-legacy-bound-continuation'),
    status: 'waiting',
    continuation,
  }), { message: 'RUN_LEDGER_RECORD_INVALID' })
})

test('roundtrips the optional public Harness attempt frozen for a private V4 Gate', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  const targetKinds = ['codex']
  const base = createOrchestrationV4({
    workflow: 'auto', template: 'discussion', targetKinds, phase: 'proposal', round: 1,
    snapshot: discussionSnapshot(targetKinds, 1),
  }, { targetKinds, now: 1000 })
  const orchestration = {
    ...base,
    slots: [{ ...base.slots[0], agentRunId: 'agent-run-private-gate' }],
  }
  const continuation = {
    gateId: `human-gate-${'d'.repeat(64)}`,
    gateType: 'decision',
    resumeKind: 'v4_human_gate',
    state: 'pending',
    agentRunId: 'operation-private-gate',
    publicAgentRunId: 'agent-run-private-gate',
    agentKind: 'codex',
    round: 1,
    stateEpoch: 1,
    createdAt: 1000,
    updatedAt: 1000,
  }
  const running = ledger.checkpoint({
    ...runRecord('run-private-gate-binding', 'group-private-gate-binding'),
    mode: 'auto', targetKinds, status: 'running', currentRound: 1, maxRounds: 3,
    agentRuns: [{
      agentRunId: 'agent-run-private-gate', kind: 'codex', round: 1, status: 'waiting',
    }],
    orchestration,
  })
  const saved = ledger.checkpoint({
    runId: running.runId,
    status: 'waiting',
    continuation,
  })

  assert.deepEqual(saved.continuation, continuation)
  assert.equal(saved.orchestration.slots[0].agentRunId, 'agent-run-private-gate')
  assert.deepEqual(
    new RunLedger({ storagePath, now: () => 1100 }).get(saved.runId).continuation,
    continuation,
  )

  for (const publicAgentRunId of ['', 'not valid', '\u0000invalid']) {
    assert.throws(() => ledger.checkpoint({
      runId: saved.runId,
      continuation: { ...continuation, publicAgentRunId },
    }), { message: 'RUN_LEDGER_RECORD_INVALID' })
  }
  for (const agentRuns of [
    [{ agentRunId: 'agent-run-other', kind: 'codex', round: 1, status: 'waiting' }],
    [
      { agentRunId: 'agent-run-private-gate', kind: 'codex', round: 1, status: 'waiting' },
      { agentRunId: 'agent-run-private-gate', kind: 'codex', round: 1, status: 'waiting' },
    ],
  ]) {
    assert.throws(() => ledger.checkpoint({
      runId: saved.runId,
      agentRuns,
    }), { message: 'RUN_LEDGER_RECORD_INVALID' })
  }

  const completed = ledger.checkpoint({
    runId: saved.runId,
    continuation: { ...continuation, state: 'completed', updatedAt: 1100 },
    orchestration: {
      ...orchestration,
      slots: [{ ...orchestration.slots[0], agentRunId: 'agent-run-next-operation' }],
    },
  })
  assert.equal(completed.continuation.publicAgentRunId, 'agent-run-private-gate')
  assert.equal(completed.orchestration.slots[0].agentRunId, 'agent-run-next-operation')
})

test('roundtrips Manual V4 invocation bindings and rejects a coherently rewritten cursor', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  const targetKinds = ['codex']
  const snapshot = { ...discussionSnapshot(targetKinds, 0), round: 0 }
  const orchestration = createOrchestrationV4({
    workflow: 'manual', template: 'concurrent-batch', targetKinds, phase: 'proposal',
    snapshot,
  }, { targetKinds, now: 1000 })
  const slot = orchestration.slots[0]
  const continuation = {
    gateId: `human-gate-${'c'.repeat(64)}`,
    gateType: 'permission',
    resumeKind: 'agent_slot',
    state: 'pending',
    agentRunId: 'agent-run-manual-v4-bound',
    agentKind: 'codex',
    round: 0,
    phase: 'proposal',
    slotId: slot.slotId,
    operationId: slot.operationId,
    snapshotHash: orchestration.snapshotHash,
    createdAt: 1000,
    updatedAt: 1000,
  }
  const saved = ledger.checkpoint({
    ...runRecord('run-manual-v4-bound', 'group-manual-v4-bound'),
    mode: 'manual',
    targetKinds,
    status: 'waiting',
    orchestration,
    continuation,
  })

  assert.deepEqual(saved.continuation, continuation)
  assert.deepEqual(
    new RunLedger({ storagePath, now: () => 1100 }).get(saved.runId).continuation,
    continuation,
  )
  const rewritten = structuredClone(orchestration)
  rewritten.batchId = `batch-${'a'.repeat(32)}`
  const operationId = `agent-operation-${'b'.repeat(64)}`
  rewritten.slots[0].operationId = operationId
  rewritten.plan.assignments[0].operationId = operationId
  if (rewritten.deliveryWatermarks[0]) {
    rewritten.deliveryWatermarks[0].operationId = operationId
  }
  assert.throws(() => ledger.checkpoint({
    runId: saved.runId,
    orchestration: rewritten,
  }), { message: 'RUN_LEDGER_RECORD_INVALID' })
  assert.deepEqual(ledger.get(saved.runId), saved)
})

test('preserves validated V4 challenge bindings through the Run Ledger allowlist', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  const targetKinds = ['codex', 'hermes']
  const base = createOrchestrationV4({
    workflow: 'auto', template: 'discussion', targetKinds, phase: 'challenge', round: 2,
    snapshot: discussionSnapshot(targetKinds, 2),
  }, { targetKinds, now: 1000 })
  const slots = base.slots.map((slot) => {
    const receipt = createCollaborationReceipt({
      phase: 'proposal', agentKind: slot.agentKind, slotId: slot.slotId,
      operationId: `operation-proposal-${slot.agentKind}`, status: 'completed',
      summary: `${slot.agentKind} proposal`, artifactIds: [`artifact-${slot.agentKind}`],
      evidenceIds: [`evidence-${slot.agentKind}`], snapshotHash: base.snapshotHash,
      deliveryWatermark: 1,
    })
    return {
      ...slot,
      resultRefs: {
        artifactIds: [...receipt.artifactIds], evidenceIds: [...receipt.evidenceIds],
        workflowOutcomeRefs: [{ receipt }],
      },
    }
  })
  const challengeBindings = slots.map((slot, index) => {
    const proposalSlot = slots[1 - index]
    const receipt = proposalSlot.resultRefs.workflowOutcomeRefs[0].receipt
    return {
      round: 2,
      reviewerKind: slot.agentKind,
      reviewerSlotId: slot.slotId,
      reviewerOperationId: slot.operationId,
      proposalKind: proposalSlot.agentKind,
      proposalSlotId: proposalSlot.slotId,
      proposalOperationId: receipt.operationId,
      proposalReceiptId: receipt.receiptId,
      artifactIds: [...receipt.artifactIds],
      evidenceIds: [...receipt.evidenceIds],
    }
  })
  const orchestration = { ...base, slots, challengeBindings }
  const saved = ledger.checkpoint({
    ...runRecord('run-v4-challenge-bindings', 'group-v4-challenge-bindings'),
    mode: 'auto', targetKinds, currentRound: 2, maxRounds: 3, orchestration,
  })

  assert.deepEqual(saved.orchestration.challengeBindings, challengeBindings)
  assert.deepEqual(
    new RunLedger({ storagePath, now: () => 1100 }).get(saved.runId).orchestration.challengeBindings,
    challengeBindings,
  )
})

test('roundtrips exact V4 work receipts and rejects tampered receipt hashes', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  const targetKinds = ['codex', 'hermes', 'workbuddy']
  const base = createOrchestrationV4({
    workflow: 'auto', template: 'discussion', targetKinds, phase: 'coordination', round: 2,
    snapshot: discussionSnapshot(targetKinds, 2),
  }, { targetKinds, now: 1000 })
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
  const artifactHash = 'b'.repeat(64)
  const collaborationReceipt = createCollaborationReceipt({
    phase: 'work', agentKind: 'codex', slotId: slot.slotId,
    operationId: slot.operationId, status: 'completed',
    summary: 'Codex completed its negotiated work package.',
    artifactIds: [artifactId], evidenceIds: [], workItemId: 'codex-work',
    snapshotHash: base.snapshotHash, deliveryWatermark: 3,
  })
  const workReceipt = createWorkReceipt({
    snapshotHash: base.snapshotHash,
    snapshotBodyHash: base.snapshot.bodyHash,
    snapshotContentRef: base.snapshot.contentRef,
    planHash: coordinationPlan.planHash,
    taskId: 'codex-work', ownerKind: 'codex', slotId: slot.slotId,
    operationId: slot.operationId, collaborationReceipt,
    artifacts: [{
      artifactId,
      contentHash: artifactHash,
      contentRef: {
        algorithm: 'sha256', hash: artifactHash, size: 42, mediaType: 'application/json',
      },
    }],
  })
  const orchestration = createOrchestrationV4({
    ...base,
    phase: 'work',
    currentKinds: ['hermes', 'workbuddy'],
    pendingKinds: ['hermes', 'workbuddy'],
    coordinationPlan,
    workReceipts: [workReceipt],
    commitState: { ...base.commitState, writerKind: coordinationPlan.finalizerKind },
    slots: base.slots.map(candidate => candidate.slotId === slot.slotId ? {
      ...candidate,
      phase: 'work',
      status: 'completed',
      finishedAt: 1001,
      receiptId: collaborationReceipt.receiptId,
      resultHash: hashValue(collaborationReceipt),
      resultRefs: {
        artifactIds: [artifactId],
        evidenceIds: [],
        workflowOutcomeRefs: [{ receipt: collaborationReceipt }],
      },
    } : { ...candidate, phase: 'work' }),
  }, { targetKinds, now: 1001 })
  const saved = ledger.checkpoint({
    ...runRecord('run-v4-work-receipt', 'group-v4-work-receipt'),
    mode: 'auto', targetKinds, currentRound: 2, maxRounds: 3, orchestration,
  })

  assert.deepEqual(saved.orchestration.workReceipts, [workReceipt])
  assert.deepEqual(
    new RunLedger({ storagePath, now: () => 1100 }).get(saved.runId).orchestration.workReceipts,
    [workReceipt],
  )
  assert.throws(() => ledger.checkpoint({
    runId: saved.runId,
    orchestration: {
      ...saved.orchestration,
      workReceipts: [{ ...workReceipt, resultHash: 'f'.repeat(64) }],
    },
  }), { message: 'RUN_LEDGER_RECORD_INVALID' })
  assert.deepEqual(ledger.get(saved.runId).orchestration.workReceipts, [workReceipt])
})

test('persists the V4 synthesis binding through journal recovery and restart', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  const targetKinds = ['codex', 'hermes']
  const base = createOrchestrationV4({
    workflow: 'auto', template: 'discussion', targetKinds, phase: 'challenge', round: 2,
    snapshot: discussionSnapshot(targetKinds, 2),
  }, { targetKinds, now: 1000 })
  const slots = base.slots.map((slot) => {
    const proposalReceipt = createCollaborationReceipt({
      phase: 'proposal', agentKind: slot.agentKind, slotId: slot.slotId,
      operationId: `operation-proposal-${slot.agentKind}`, status: 'completed',
      summary: `${slot.agentKind} proposal`, snapshotHash: base.snapshotHash,
      deliveryWatermark: 1,
    })
    const challengeReceipt = createCollaborationReceipt({
      phase: 'challenge', agentKind: slot.agentKind, slotId: slot.slotId,
      operationId: slot.operationId, status: 'completed',
      summary: `${slot.agentKind} challenge`, snapshotHash: base.snapshotHash,
      deliveryWatermark: 2,
    })
    return {
      ...slot,
      status: 'completed',
      finishedAt: 1001,
      resultRefs: {
        artifactIds: [], evidenceIds: [],
        workflowOutcomeRefs: [
          { receipt: proposalReceipt },
          { receipt: challengeReceipt, verdict: 'support' },
        ],
      },
    }
  })
  const challengeBindings = slots.map((slot, index) => {
    const proposalSlot = slots[1 - index]
    const proposalReceipt = proposalSlot.resultRefs.workflowOutcomeRefs[0].receipt
    return {
      round: 2,
      reviewerKind: slot.agentKind,
      reviewerSlotId: slot.slotId,
      reviewerOperationId: slot.operationId,
      proposalKind: proposalSlot.agentKind,
      proposalSlotId: proposalSlot.slotId,
      proposalOperationId: proposalReceipt.operationId,
      proposalReceiptId: proposalReceipt.receiptId,
      artifactIds: [],
      evidenceIds: [],
    }
  })
  const synthesisBinding = createSynthesisBinding({
    snapshotContentHash: base.snapshot.bodyHash,
    targetKinds,
    candidates: [
      { kind: 'codex', score: 700 },
      { kind: 'hermes', score: 600 },
    ],
  })
  const saved = ledger.checkpoint({
    ...runRecord('run-v4-synthesis-binding', 'group-v4-synthesis-binding'),
    mode: 'auto', targetKinds, currentRound: 2, maxRounds: 3,
    orchestration: {
      ...base,
      currentKinds: [],
      pendingKinds: [],
      slots,
      challengeBindings,
      synthesisBinding,
      commitState: { ...base.commitState, writerKind: synthesisBinding.writerKind },
    },
  })

  assert.deepEqual(saved.orchestration.synthesisBinding, synthesisBinding)
  assert.deepEqual(
    new RunLedger({ storagePath, now: () => 1100 }).get(saved.runId).orchestration.synthesisBinding,
    synthesisBinding,
  )

  const writerKind = synthesisBinding.writerKind
  const writerSlot = slots.find(slot => slot.agentKind === writerKind)
  const operationId = `operation-synthesis-${writerKind}-1`
  const rankedKinds = [writerKind, ...targetKinds.filter(kind => kind !== writerKind)]
  const recovery = {
    revision: 1,
    originalWriterKind: writerKind,
    activeWriterKind: writerKind,
    verificationKinds: rankedKinds.filter(kind => kind !== writerKind).slice(0, 1),
    rankedKinds,
    rankingFingerprint: createHash('sha256').update(JSON.stringify({
      rankedKinds,
      selectionInputHash: synthesisBinding.selectionInputHash,
    })).digest('hex'),
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
  }
  const recoverySlots = slots.map(slot => slot.agentKind === writerKind
    ? { ...slot, phase: 'synthesis', status: 'planned', operationId, permission: 'workspace-write' }
    : slot)
  const recoveryPlan = {
    ...base.plan,
    assignments: base.plan.assignments.map(assignment => assignment.agentKind === writerKind
      ? { ...assignment, operationId }
      : assignment),
  }
  const recovered = ledger.checkpoint({
    runId: saved.runId,
    orchestration: {
      ...saved.orchestration,
      phase: 'synthesis',
      currentKind: '',
      currentKinds: [writerKind],
      pendingKinds: [writerKind],
      plan: recoveryPlan,
      slots: recoverySlots,
      synthesisRecovery: recovery,
    },
  })
  assert.deepEqual(recovered.orchestration.synthesisRecovery, recovery)
  assert.deepEqual(
    new RunLedger({ storagePath, now: () => 1200 }).get(saved.runId).orchestration.synthesisRecovery,
    recovery,
  )
})

test('preserves strict V4 convergence and Gate epoch through restart', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  const targetKinds = ['codex', 'hermes']
  const base = createOrchestrationV4({
    workflow: 'auto', template: 'discussion', targetKinds, phase: 'challenge', round: 2,
    snapshot: discussionSnapshot(targetKinds, 2),
  }, { targetKinds, now: 1000 })
  const slots = base.slots.map((slot) => {
    const proposalReceipt = createCollaborationReceipt({
      phase: 'proposal', agentKind: slot.agentKind, slotId: slot.slotId,
      operationId: `operation-proposal-${slot.agentKind}`, status: 'completed',
      summary: `${slot.agentKind} proposal`, snapshotHash: base.snapshotHash,
      deliveryWatermark: 1,
    })
    const challengeReceipt = createCollaborationReceipt({
      phase: 'challenge', agentKind: slot.agentKind, slotId: slot.slotId,
      operationId: slot.operationId, status: 'completed',
      summary: `${slot.agentKind} challenge`, snapshotHash: base.snapshotHash,
      deliveryWatermark: 2,
    })
    return {
      ...slot,
      status: 'completed',
      finishedAt: 1001,
      resultRefs: {
        artifactIds: [], evidenceIds: [],
        workflowOutcomeRefs: [
          { receipt: proposalReceipt },
          { receipt: challengeReceipt, verdict: 'support' },
        ],
      },
    }
  })
  const challengeBindings = slots.map((slot, index) => {
    const proposalSlot = slots[1 - index]
    const proposalReceipt = proposalSlot.resultRefs.workflowOutcomeRefs[0].receipt
    return {
      round: 2,
      reviewerKind: slot.agentKind,
      reviewerSlotId: slot.slotId,
      reviewerOperationId: slot.operationId,
      proposalKind: proposalSlot.agentKind,
      proposalSlotId: proposalSlot.slotId,
      proposalOperationId: proposalReceipt.operationId,
      proposalReceiptId: proposalReceipt.receiptId,
      artifactIds: [],
      evidenceIds: [],
    }
  })
  const synthesisBinding = createSynthesisBinding({
    snapshotContentHash: base.snapshot.bodyHash,
    targetKinds,
    candidates: [
      { kind: 'codex', score: 700 },
      { kind: 'hermes', score: 600 },
    ],
  })
  const candidateContentHash = '2'.repeat(64)
  const openIssueIds = [`issue-${'3'.repeat(64)}`]
  const convergence = {
    candidateArtifactId: `artifact-${'1'.repeat(64)}`,
    candidateContentHash,
    openIssueIds,
    stateKey: createHash('sha256').update(JSON.stringify({
      candidateContentHash,
      openIssueIds,
    })).digest('hex'),
    lastCompletedRound: 2,
    consecutiveStableRounds: 2,
    stateEpoch: 7,
    acknowledgedGateEpoch: 7,
  }
  const saved = ledger.checkpoint({
    ...runRecord('run-v4-convergence', 'group-v4-convergence'),
    mode: 'auto', targetKinds, currentRound: 2, maxRounds: 3,
    orchestration: {
      ...base,
      currentKinds: [],
      pendingKinds: [],
      slots,
      challengeBindings,
      synthesisBinding,
      commitState: { ...base.commitState, writerKind: synthesisBinding.writerKind },
      convergence,
    },
  })

  assert.deepEqual(saved.orchestration.convergence, convergence)
  assert.deepEqual(
    new RunLedger({ storagePath, now: () => 1100 }).get(saved.runId).orchestration.convergence,
    convergence,
  )
})

test('persists sanitized attempt history through journal recovery and restart', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1200 })
  const saved = ledger.checkpoint({
    ...runRecord('run-attempt-history', 'group-attempt-history'),
    attemptHistory: attemptHistory(),
  })

  assert.deepEqual(saved.attemptHistory, attemptHistory())
  const serialized = fs.readFileSync(storagePath, 'utf8')
  assert.doesNotMatch(serialized, /error|command|credential|Users|private-token/i)

  fs.writeFileSync(storagePath, '{corrupt snapshot', 'utf8')
  const restored = new RunLedger({ storagePath, now: () => 1300 })
  assert.deepEqual(restored.get(saved.runId).attemptHistory, attemptHistory())
  assert.equal(restored.snapshotError instanceof Error, true)
})

test('rejects malformed durable attempt history without changing the Run', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  const saved = ledger.checkpoint({
    ...runRecord('run-attempt-invalid', 'group-attempt-invalid'),
    attemptHistory: attemptHistory(),
  })

  for (const value of [
    [{ ...attemptHistory()[0], phase: 'raw_retry' }],
    [{ ...attemptHistory()[0], failureCategory: 'HTTP 401 private-token' }],
    [{ ...attemptHistory()[0], outcomeCertainty: 'maybe' }],
    [attemptHistory()[1], attemptHistory()[0]],
  ]) {
    assert.throws(
      () => ledger.checkpoint({ runId: saved.runId, attemptHistory: value }),
      { message: 'RUN_LEDGER_RECORD_INVALID' },
    )
    assert.deepEqual(ledger.get(saved.runId), saved)
  }

  const sanitized = ledger.checkpoint({
    runId: saved.runId,
    attemptHistory: [{
      ...attemptHistory()[0],
      command: 'cat /Users/private/config',
      error: 'Authorization: Bearer private-token',
    }],
  })
  assert.equal('command' in sanitized.attemptHistory[0], false)
  assert.equal('error' in sanitized.attemptHistory[0], false)
})

test('persists strict budget snapshots through the journal and restart', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  const budget = budgetSnapshot({
    limits: { ...budgetSnapshot().limits, inputTokens: 4000, toolCalls: 1 },
    used: { ...budgetSnapshot().used, inputTokens: 750, toolCalls: 2 },
    source: { ...budgetSnapshot().source, inputTokens: 'estimated', toolCalls: 'reported' },
    enforcement: { ...budgetSnapshot().enforcement, inputTokens: 'hard', toolCalls: 'hard' },
    exhaustion: {
      dimension: 'toolCalls',
      limit: 1,
      priorUsed: 1,
      attemptedUsage: 1,
      used: 2,
      source: 'reported',
      enforcement: 'hard',
      reason: 'BUDGET_LIMIT_EXCEEDED',
    },
  })

  const saved = ledger.checkpoint({
    ...runRecord('run-budget', 'group-budget'),
    budget,
  })
  assert.deepEqual(saved.budget, budget)

  const updatedBudget = {
    ...budget,
    used: { ...budget.used, inputTokens: 1000, elapsedMs: 250 },
    source: { ...budget.source, elapsedMs: 'reported' },
  }
  ledger.checkpoint({ runId: saved.runId, status: 'waiting', budget: updatedBudget })

  const restored = new RunLedger({ storagePath, now: () => 2000 })
  assert.deepEqual(restored.get(saved.runId).budget, updatedBudget)
})

test('rejects malformed budget snapshots without changing the durable Run', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  const saved = ledger.checkpoint({
    ...runRecord('run-budget-invalid', 'group-budget-invalid'),
    budget: budgetSnapshot(),
  })

  for (const budget of [
    { ...budgetSnapshot(), secret: 'nope' },
    { ...budgetSnapshot(), used: { ...budgetSnapshot().used, inputTokens: -1 } },
    { ...budgetSnapshot(), source: { ...budgetSnapshot().source, costMicros: 'guessed' } },
    { ...budgetSnapshot(), enforcement: { ...budgetSnapshot().enforcement, toolCalls: 'warn' } },
    { ...budgetSnapshot(), limits: { inputTokens: null } },
  ]) {
    assert.throws(
      () => ledger.checkpoint({ runId: saved.runId, budget }),
      { message: 'RUN_LEDGER_RECORD_INVALID' },
    )
    assert.deepEqual(ledger.get(saved.runId), saved)
  }
})

test('rejects new Runs without a captured Context Pack', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })

  assert.throws(
    () => ledger.checkpoint({
      ...runRecord('run-no-context', 'group-no-context'),
      contextPackId: '',
      contextPackState: 'legacy-unavailable',
    }),
    { message: 'RUN_LEDGER_RECORD_INVALID' },
  )
  assert.deepEqual(ledger.list(), [])
})

test('keeps captured Task and Context Pack bindings immutable across checkpoints', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  const saved = ledger.checkpoint(runRecord('run-bound', 'group-bound'))

  for (const patch of [
    { taskId: 'different-task' },
    { contextPackId: `context-pack-${'b'.repeat(64)}` },
    { contextPackState: 'legacy-unavailable' },
  ]) {
    assert.throws(
      () => ledger.checkpoint({ runId: saved.runId, ...patch }),
      { message: 'RUN_LEDGER_RECORD_INVALID' },
    )
    assert.deepEqual(ledger.get(saved.runId), saved)
  }

  const updated = ledger.checkpoint({ runId: saved.runId, status: 'waiting' })
  assert.equal(updated.taskId, saved.taskId)
  assert.equal(updated.contextPackId, saved.contextPackId)
  assert.equal(updated.contextPackState, 'captured')
})

test('restart reconciliation downgrades missing Context Packs without losing delivery provenance', (t) => {
  const { storagePath } = fixture(t)
  const baseContextPackId = `context-pack-${'a'.repeat(64)}`
  const attemptContextPackId = `context-pack-${'b'.repeat(64)}`
  const deliveryRecordId = `delivery-record-${'c'.repeat(64)}`
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  const saved = ledger.checkpoint({
    ...runRecord('run-missing-pack', 'group-missing-pack', 'running', [{
      agentRunId: 'agent-missing-pack',
      kind: 'codex',
      status: 'running',
      context: {
        contextPackId: attemptContextPackId,
        deliveryRecordIds: [deliveryRecordId],
      },
    }]),
    contextPackId: baseContextPackId,
  })

  const [reconciled] = ledger.reconcileContextPacks(() => {
    throw new Error('CONTEXT_PACK_NOT_FOUND')
  })

  assert.equal(reconciled.contextPackId, '')
  assert.equal(reconciled.contextPackState, 'legacy-unavailable')
  assert.equal(reconciled.agentRuns[0].context.contextPackId, undefined)
  assert.equal(reconciled.agentRuns[0].context.contextPackState, 'legacy-unavailable')
  assert.deepEqual(reconciled.agentRuns[0].context.deliveryRecordIds, [deliveryRecordId])
  assert.equal(saved.contextPackState, 'captured')
  const restarted = new RunLedger({ storagePath, now: () => 2000 })
  assert.equal(restarted.get(saved.runId).contextPackState, 'legacy-unavailable')
})

test('restart reconciliation isolates a missing attempt Pack from a valid Run Pack', (t) => {
  const { storagePath } = fixture(t)
  const baseContextPackId = `context-pack-${'a'.repeat(64)}`
  const attemptContextPackId = `context-pack-${'b'.repeat(64)}`
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  const saved = ledger.checkpoint({
    ...runRecord('run-missing-attempt', 'group-missing-attempt', 'running', [{
      agentRunId: 'agent-missing-attempt',
      kind: 'codex',
      status: 'running',
      context: { contextPackId: attemptContextPackId },
    }]),
    contextPackId: baseContextPackId,
  })

  ledger.reconcileContextPacks(contextPackId => {
    if (contextPackId === baseContextPackId) {
      return { contextPackId, taskId: saved.taskId }
    }
    throw new Error('CONTEXT_PACK_TAMPERED')
  })

  const reconciled = ledger.get(saved.runId)
  assert.equal(reconciled.contextPackId, baseContextPackId)
  assert.equal(reconciled.contextPackState, 'captured')
  assert.equal(reconciled.agentRuns[0].context.contextPackId, undefined)
  assert.equal(reconciled.agentRuns[0].context.contextPackState, 'legacy-unavailable')
})

test('restart reconciliation downgrades a Context Pack assigned to another Task', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  const saved = ledger.checkpoint(runRecord('run-wrong-pack-task', 'group-wrong-pack-task'))

  ledger.reconcileContextPacks(contextPackId => ({
    contextPackId,
    taskId: 'another-task',
  }))

  const reconciled = ledger.get(saved.runId)
  assert.equal(reconciled.contextPackId, '')
  assert.equal(reconciled.contextPackState, 'legacy-unavailable')
})

test('Context Pack reconciliation fails closed when its downgrade cannot persist', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  const saved = ledger.checkpoint(runRecord('run-pack-write-failure', 'group-pack-write-failure'))
  failNextPersist(ledger)

  assert.throws(
    () => ledger.reconcileContextPacks(() => {
      throw new Error('CONTEXT_PACK_TAMPERED')
    }),
    { message: 'RUN_LEDGER_WRITE_FAILED' },
  )
  assert.deepEqual(ledger.get(saved.runId), saved)
})

function storedTraceRecord(
  runId = 'run-stored', groupId = 'group-stored', agentRunId = 'agent-stored',
) {
  return {
    ...runRecord(runId, groupId, 'completed', [{
      agentRunId,
      kind: 'codex',
      round: 1,
      status: 'completed',
      output: 'Done',
      events: [{
        runId,
        agentRunId,
        groupId,
        threadRootId: `${groupId}-root`,
        agentKind: 'codex',
        round: 1,
        seq: 1,
        timestamp: 1000,
        status: 'completed',
        type: 'warning',
        summary: 'Summary',
      }],
      sourceMessageIds: [`${runId}-message`],
      startedAt: 1000,
      lastActivityAt: 1000,
      finishedAt: 1000,
      silent: false,
      truncated: false,
      context: {
        includedCount: 1,
        omittedCount: 0,
        charCount: 100,
        sessionRotated: false,
      },
    }]),
    mode: 'auto',
    permissionMode: 'read-only',
    createdAt: 1000,
    startedAt: 1000,
    updatedAt: 1000,
    finishedAt: 1000,
    currentRound: 1,
    maxRounds: 2,
    unlimitedRounds: false,
  }
}

function failNextPersist(ledger) {
  const persist = ledger.persist.bind(ledger)
  let failed = false
  ledger.persist = (runs) => {
    if (!failed) {
      failed = true
      throw new Error('RUN_LEDGER_WRITE_FAILED')
    }
    return persist(runs)
  }
}

function journalEntries(storagePath) {
  return fs.readFileSync(`${storagePath}.journal`, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

test('compacts a committed journal to a recoverable baseline', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({
    storagePath,
    now: () => 1000,
    journalCompactionBytes: 1024,
  })
  ledger.checkpoint(runRecord('run-compact', 'group-compact'))
  ledger.finish('run-compact', 'completed')

  const entries = journalEntries(storagePath)
  assert.deepEqual(entries.map(entry => entry.sequence), [1, 2])
  assert.deepEqual(entries.map(entry => entry.phase), ['prepare', 'commit'])
  fs.writeFileSync(storagePath, '{corrupt snapshot', 'utf8')

  const restored = new RunLedger({ storagePath, now: () => 4000 })
  assert.equal(restored.loadError, null)
  assert.equal(restored.get('run-compact').status, 'completed')
})

test('roundtrips sanitized bounded run and Agent snapshots', (t) => {
  const { storagePath } = fixture(t)
  const events = Array.from({ length: 85 }, (_, index) => ({
    id: `event-${index}`,
    type: 'warning',
    status: 'waiting',
    seq: index + 1,
    timestamp: 1100 + index,
    title: `Warning ${index}`,
    summary: `Summary ${index}`,
    command: `cat /Users/private/${index}`,
  }))
  const sourceMessageIds = Array.from({ length: 40 }, (_, index) => `message-${index}`)
  const extraAgentRuns = Array.from({ length: 260 }, (_, index) => ({
    agentRunId: `extra-agent-${index}`,
    kind: 'codex',
    status: 'completed',
  }))
  const ledger = new RunLedger({ storagePath, now: () => 2000 })
  const saved = ledger.checkpoint({
    runId: 'run-1',
    taskId: 'task-1',
    contextPackId: `context-pack-${'a'.repeat(64)}`,
    contextPackState: 'captured',
    groupId: 'group-1',
    threadRootId: 'root-1',
    mode: 'auto',
    targetKinds: ['codex', 'hermes', 'codex', '../../private'],
    status: 'running',
    startedAt: '1970-01-01T00:00:01.000Z',
    permissionMode: 'workspace-write',
    currentRound: 12,
    maxRounds: 8,
    arbitrary: 'drop-me',
    agentRuns: [...extraAgentRuns, {
      agentRunId: 'agent-1',
      kind: 'codex',
      round: 2,
      status: 'running',
      output: `Final output ${'x'.repeat(21000)}`,
      events,
      sourceMessageIds,
      startedAt: 1050,
      lastActivityAt: 1200,
      silent: true,
      context: {
        includedCount: 2000,
        omittedCount: -4,
        charCount: 2000000,
        sessionRotated: true,
        externalRunRef: 'ocr+review:123',
      },
      seenSeqs: [1, 2, 3],
    }],
  })

  assert.deepEqual(saved.targetKinds, ['codex', 'hermes'])
  assert.equal(saved.taskId, 'task-1')
  assert.equal(saved.currentRound, 8)
  assert.equal(saved.startedAt, 1000)
  assert.equal('arbitrary' in saved, false)
  assert.equal(saved.agentRuns.length, 256)
  const boundedAgent = saved.agentRuns.at(-1)
  assert.equal(boundedAgent.output.length, 20000)
  assert.equal(boundedAgent.events.length, 80)
  assert.equal(boundedAgent.events[0].id, 'event-5')
  assert.equal(boundedAgent.sourceMessageIds.length, 32)
  assert.deepEqual(boundedAgent.context, {
    includedCount: 1000,
    omittedCount: 0,
    charCount: 1000000,
    sessionRotated: true,
    externalRunRef: 'ocr+review:123',
  })
  assert.equal(boundedAgent.truncated, true)
  assert.equal('seenSeqs' in boundedAgent, false)

  const restored = new RunLedger({ storagePath, now: () => 3000 })
  assert.deepEqual(restored.get('run-1'), saved)
  const detached = restored.list()
  detached[0].agentRuns.at(-1).context.charCount = 1
  assert.equal(restored.get('run-1').agentRuns.at(-1).context.charCount, 1000000)
})

test('loads equivalent Session provenance regardless of stored field order', (t) => {
  const { storagePath } = fixture(t)
  const contextPackId = `context-pack-${'a'.repeat(64)}`
  const deliveryRecordId = `delivery-record-${'b'.repeat(64)}`
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  const saved = ledger.checkpoint({
    ...runRecord('run-provenance-order', 'group-provenance-order', 'completed', [{
      agentRunId: 'agent-provenance-order',
      kind: 'codex',
      status: 'completed',
      context: {
        contextMode: 'continuation',
        promptChars: 1200,
        promptBytes: 1280,
        promptHash: 'c'.repeat(64),
        sourceCount: 3,
        sourceHash: 'd'.repeat(64),
        wirePayloadBytes: 1500,
        wirePayloadHash: 'e'.repeat(64),
        contextPackId,
        deliveryRecordIds: [deliveryRecordId],
        sessionProvenance: {
          scope: 'conversation',
          reuse: true,
          origin: 'resumed',
          originTaskId: 'task-origin',
          inheritedTaskIds: ['task-inherited'],
          completeness: 'complete',
        },
      },
    }]),
    contextPackId,
  })
  fs.unlinkSync(ledger.journalPath)
  const stored = JSON.parse(fs.readFileSync(storagePath, 'utf8'))
  stored.runs[0].agentRuns[0].context.sessionProvenance = {
    completeness: 'complete',
    inheritedTaskIds: ['task-inherited'],
    originTaskId: 'task-origin',
    origin: 'resumed',
    reuse: true,
    scope: 'conversation',
  }
  fs.writeFileSync(storagePath, `${JSON.stringify(stored, null, 2)}\n`)

  const restored = new RunLedger({ storagePath, now: () => 2000 })
  assert.equal(restored.loadError, null)
  assert.deepEqual(restored.get(saved.runId), saved)
})

test('merges sliding live Agent snapshots into durable history across restart', (t) => {
  const { storagePath } = fixture(t)
  let now = 1000
  const ledger = new RunLedger({ storagePath, now: () => now })
  const attempts = Array.from({ length: 65 }, (_, index) => ({
    agentRunId: `agent-${index + 1}`,
    kind: 'codex',
    round: index + 1,
    status: 'completed',
    output: `Output ${index + 1}`,
  }))

  const first = ledger.checkpoint(runRecord(
    'run-sliding', 'group-sliding', 'running', attempts.slice(0, 64),
  ))
  assert.deepEqual(
    first.agentRuns.map(agentRun => agentRun.agentRunId),
    attempts.slice(0, 64).map(attempt => attempt.agentRunId),
  )

  now = 2000
  const nextSnapshot = attempts.slice(1).map(attempt => (
    attempt.agentRunId === 'agent-32'
      ? { ...attempt, status: 'failed', output: 'Fresh terminal output', reason: 'updated' }
      : attempt
  ))
  const second = ledger.checkpoint(runRecord(
    'run-sliding', 'group-sliding', 'running', nextSnapshot,
  ))

  assert.equal(second.agentRuns.length, 65)
  assert.equal(second.agentRuns[0].agentRunId, 'agent-1')
  assert.equal(second.agentRuns.at(-1).agentRunId, 'agent-65')
  const updated = second.agentRuns.find(agentRun => agentRun.agentRunId === 'agent-32')
  assert.equal(updated.status, 'failed')
  assert.equal(updated.output, 'Fresh terminal output')
  assert.equal(updated.reason, 'updated')

  const restored = new RunLedger({ storagePath, now: () => 3000 }).get('run-sliding')
  assert.deepEqual(restored.agentRuns, second.agentRuns)
})

test('writer normalizes invalid Agent and event statuses before restart', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  const saved = ledger.checkpoint(runRecord('run-status-domains', 'group-status-domains', 'running', [{
    agentRunId: 'agent-status-domains',
    kind: 'codex',
    status: 'round-limit',
    events: [{
      type: 'warning',
      status: 'preparing',
      seq: 1,
      summary: 'Waiting for valid status normalization.',
    }],
  }]))

  assert.equal(saved.agentRuns[0].status, 'running')
  assert.equal(saved.agentRuns[0].events[0].status, 'running')

  const restored = new RunLedger({ storagePath, now: () => 2000 })
  assert.equal(restored.loadError, null)
  assert.deepEqual(restored.get('run-status-domains'), saved)
})

test('rejects paths, credentials, session references, raw commands, and arbitrary reasoning fields', (t) => {
  const { storagePath } = fixture(t)
  const googleKey = 'AIza12345678901234567890123456789012345'
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
  const basicCredential = 'dXNlcjpwYXNz'
  const legitimateText = 'Basic authentication is enabled. customer.platform.internal deadbeef.cafebabe.feedface'
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  const saved = ledger.checkpoint({
    runId: 'run-secure',
    taskId: 'task-secure',
    contextPackId: `context-pack-${'a'.repeat(64)}`,
    contextPackState: 'captured',
    groupId: 'group-secure',
    targetKinds: ['codex'],
    status: 'running',
    reason: `token=run-secret /Users/alice/project ${googleKey} ${jwt}`,
    executable: '/Applications/Agent.app',
    sessionRef: 'session-ref-secret',
    credentials: { apiKey: 'root-secret' },
    privateChainOfThought: 'hidden-run-reasoning',
    agentRuns: [{
      agentRunId: 'agent-secure',
      kind: 'codex',
      status: 'running',
      output: `Bearer abcdefghijklmnop Authorization: Basic ${basicCredential} /Users/alice/private-output https://url-user:url-pass@example.com ${googleKey} ${jwt} ${legitimateText}`,
      command: 'cat /Users/alice/private-command',
      sessionRef: 'agent-session-secret',
      privateReasoning: 'hidden-agent-reasoning',
      events: [{
        id: 'tool-1',
        type: 'tool_result_summary',
        status: 'completed',
        seq: 1,
        title: '/Users/alice/result',
        summary: `apiKey=event-secret ${googleKey} ${jwt} ${legitimateText}`,
        detail: 'Output: 2 lines, 30 bytes from /Users/alice/result',
        command: 'rg secret /Users/alice',
        chainOfThought: 'hidden-event-reasoning',
      }],
    }],
  })

  const serialized = fs.readFileSync(storagePath, 'utf8')
  for (const forbidden of [
    '/Users/alice', '/Applications/Agent.app', 'run-secret', 'root-secret',
    'session-ref-secret', 'agent-session-secret', 'event-secret', 'url-user', 'url-pass',
    'private-command', 'hidden-run-reasoning', 'hidden-agent-reasoning',
    'hidden-event-reasoning', googleKey, jwt, basicCredential,
  ]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.match(saved.reason, /\[redacted\]/)
  assert.match(saved.reason, /\[path\]/)
  assert.match(saved.agentRuns[0].output, /Bearer \[redacted\]/)
  assert.match(saved.agentRuns[0].output, new RegExp(legitimateText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(saved.agentRuns[0].events[0].summary, new RegExp(legitimateText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.equal('command' in saved.agentRuns[0].events[0], false)
  assert.equal('detail' in saved.agentRuns[0].events[0], false)
})

test('writes atomically with private file and directory permissions', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })

  ledger.checkpoint(runRecord('run-1', 'group-1'))
  ledger.checkpoint({ runId: 'run-1', currentRound: 1 })
  ledger.checkpoint(runRecord('run-2', 'group-1'))

  assert.equal(fs.statSync(storagePath).mode & 0o777, 0o600)
  assert.equal(fs.statSync(ledger.journalPath).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.dirname(storagePath)).mode & 0o777, 0o700)
  assert.deepEqual(fs.readdirSync(path.dirname(storagePath)).sort(), [
    'run-ledger.json', 'run-ledger.json.journal',
  ])
  assert.equal(JSON.parse(fs.readFileSync(storagePath, 'utf8')).version, 1)
  assert.deepEqual(ledger.list().map(record => record.runId), ['run-2', 'run-1'])
})

test('append-only journal recovers lifecycle state from a corrupt snapshot', (t) => {
  const { storagePath } = fixture(t)
  let now = 1000
  const ledger = new RunLedger({ storagePath, now: () => now })
  ledger.checkpoint({
    ...runRecord('run-journal', 'group-journal', 'running', [{
      agentRunId: 'agent-journal',
      kind: 'codex',
      round: 1,
      status: 'running',
      output: 'Private in-progress output must stay out of the journal.',
      events: [{
        id: 'tool-1', type: 'tool_update', status: 'running', seq: 18, timestamp: 1000,
        summary: 'Inspected local state.',
      }],
    }]),
    mode: 'auto',
    currentRound: 1,
    maxRounds: 2,
  })
  now = 2000
  ledger.checkpoint({
    runId: 'run-journal',
    currentRound: 1,
    agentRuns: [{
      agentRunId: 'agent-journal', kind: 'codex', round: 1, status: 'waiting',
      output: 'Private in-progress output must stay out of the journal.',
      events: [{
        id: 'tool-1', type: 'tool_update', status: 'waiting', seq: 24, timestamp: 2000,
        summary: 'Waiting for the tool result.',
      }],
    }],
  })

  const journal = fs.readFileSync(ledger.journalPath, 'utf8')
  assert.doesNotMatch(journal, /Private in-progress output/)
  assert.match(journal, /"eventCursor":24/)
  fs.writeFileSync(storagePath, '{corrupt snapshot', 'utf8')

  const restored = new RunLedger({ storagePath, now: () => 3000 })
  const recovered = restored.get('run-journal')
  assert.equal(restored.loadError, null)
  assert.equal(restored.snapshotError instanceof Error, true)
  assert.equal(recovered.status, 'running')
  assert.equal(recovered.currentRound, 1)
  assert.equal(recovered.agentRuns[0].status, 'waiting')
  assert.equal(recovered.agentRuns[0].eventCursor, 24)
  assert.equal(
    recovered.agentRuns[0].outputChars,
    'Private in-progress output must stay out of the journal.'.length,
  )
  assert.equal(recovered.agentRuns[0].output, '')
})

test('Outcome references survive checkpoint, journal recovery, and restart', (t) => {
  const { storagePath } = fixture(t)
  const artifactId = `artifact-${'a'.repeat(64)}`
  const evidenceId = `evidence-${'b'.repeat(64)}`
  const reviewerFindingId = `reviewer-finding-${'c'.repeat(64)}`
  const adoptionId = `adoption-${'d'.repeat(64)}`
  const workflowOutcomeRef = {
    algorithm: 'sha256',
    hash: 'e'.repeat(64),
    size: 128,
    mediaType: 'application/json',
  }
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  ledger.checkpoint(runRecord('run-outcomes', 'group-outcomes', 'completed', [{
    agentRunId: 'agent-outcomes',
    kind: 'codex',
    status: 'completed',
    context: {
      outcomeRefs: {
        artifactIds: [artifactId],
        evidenceIds: [evidenceId],
        reviewerFindingIds: [reviewerFindingId],
        adoptionIds: [adoptionId],
        workflowOutcomeRefs: [workflowOutcomeRef],
      },
    },
  }]))

  const expected = {
    artifactIds: [artifactId],
    evidenceIds: [evidenceId],
    reviewerFindingIds: [reviewerFindingId],
    adoptionIds: [adoptionId],
    workflowOutcomeRefs: [workflowOutcomeRef],
  }
  assert.deepEqual(ledger.get('run-outcomes').agentRuns[0].context.outcomeRefs, expected)
  assert.match(fs.readFileSync(ledger.journalPath, 'utf8'), new RegExp(artifactId))
  fs.writeFileSync(storagePath, '{corrupt snapshot', 'utf8')

  const restored = new RunLedger({ storagePath, now: () => 2000 })
  assert.deepEqual(restored.get('run-outcomes').agentRuns[0].context.outcomeRefs, expected)
  assert.equal(restored.snapshotError instanceof Error, true)
})

test('task judgments survive journal recovery and malformed completion evidence is rejected', (t) => {
  const { storagePath } = fixture(t)
  const taskDecision = {
    status: 'completed', reason: 'Checked the delivered answer.', deliverables: ['The answer is 42.'],
  }
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  ledger.checkpoint(runRecord('run-decision', 'group-decision', 'completed', [{
    agentRunId: 'agent-decision', kind: 'codex', status: 'completed', context: { taskDecision },
  }]))
  assert.deepEqual(ledger.get('run-decision').agentRuns[0].context.taskDecision, taskDecision)
  const journalText = fs.readFileSync(ledger.journalPath, 'utf8')
  const prepare = journalText.split('\n').filter(Boolean).map(line => JSON.parse(line))
    .find(entry => entry.change?.upserts?.some(run => run.runId === 'run-decision'))
  assert.ok(prepare)
  const malformed = structuredClone(prepare.change)
  malformed.upserts.find(run => run.runId === 'run-decision').agentRuns[0].context.taskDecision.deliverables = []
  assert.throws(() => ledger.journal.prepare(malformed, 1001), /RUN_JOURNAL_CHANGE_INVALID/)
  assert.equal(fs.readFileSync(ledger.journalPath, 'utf8'), journalText)
  fs.writeFileSync(storagePath, '{corrupt snapshot', 'utf8')
  const restored = new RunLedger({ storagePath, now: () => 2000 })
  assert.deepEqual(restored.get('run-decision').agentRuns[0].context.taskDecision, taskDecision)
})

test('committed journal lifecycle wins over a valid stale snapshot', (t) => {
  const { storagePath } = fixture(t)
  let now = 1000
  const ledger = new RunLedger({ storagePath, now: () => now })
  ledger.checkpoint({
    ...runRecord('run-stale', 'group-stale', 'running', [{
      agentRunId: 'agent-stale',
      kind: 'codex',
      round: 1,
      status: 'running',
      output: 'Snapshot detail before the lifecycle advance.',
      events: [{
        type: 'tool_update', status: 'running', seq: 1, timestamp: 1000,
        summary: 'Older snapshot detail.',
      }],
    }]),
    mode: 'auto',
    currentRound: 1,
    maxRounds: 2,
  })
  const staleSnapshot = fs.readFileSync(storagePath, 'utf8')

  now = 2000
  ledger.checkpoint({
    runId: 'run-stale',
    status: 'waiting',
    agentRuns: [{
      agentRunId: 'agent-stale',
      kind: 'codex',
      round: 1,
      status: 'waiting',
      output: 'Newer snapshot detail.',
      events: [{
        type: 'tool_update', status: 'waiting', seq: 2, timestamp: 2000,
        summary: 'Newer lifecycle detail.',
      }],
    }],
  })
  fs.writeFileSync(storagePath, staleSnapshot, 'utf8')

  const restored = new RunLedger({ storagePath, now: () => 3000 })
  const recovered = restored.get('run-stale')
  assert.equal(restored.loadError, null)
  assert.equal(restored.snapshotError, null)
  assert.equal(recovered.status, 'waiting')
  assert.equal(recovered.agentRuns[0].status, 'waiting')
  assert.equal(recovered.agentRuns[0].eventCursor, 2)
  assert.equal(recovered.agentRuns[0].output, 'Snapshot detail before the lifecycle advance.')
  assert.equal(recovered.agentRuns[0].events[0].summary, 'Older snapshot detail.')
})

test('does not mix snapshot detail from an uncommitted lifecycle transaction', (t) => {
  const { storagePath } = fixture(t)
  let now = 1000
  const ledger = new RunLedger({ storagePath, now: () => now })
  ledger.checkpoint({
    ...runRecord('run-prepare-crash', 'group-prepare-crash', 'running', [{
      agentRunId: 'agent-prepare-crash',
      kind: 'codex',
      round: 1,
      status: 'running',
      output: 'Committed running detail.',
      events: [{
        type: 'tool_update', status: 'running', seq: 1, timestamp: 1000,
        summary: 'Committed running event.',
      }],
    }]),
    mode: 'auto',
    currentRound: 1,
    maxRounds: 2,
  })

  now = 2000
  const persist = ledger.persist.bind(ledger)
  let persistCalls = 0
  ledger.persist = (runs) => {
    persistCalls += 1
    if (persistCalls === 1) return persist(runs)
    throw new Error('SIMULATED_CRASH_BEFORE_SNAPSHOT_ROLLBACK')
  }
  ledger.journal.commit = () => {
    throw new Error('SIMULATED_CRASH_BEFORE_JOURNAL_COMMIT')
  }

  assert.throws(
    () => ledger.checkpoint({
      runId: 'run-prepare-crash',
      agentRuns: [{
        agentRunId: 'agent-prepare-crash',
        kind: 'codex',
        round: 1,
        status: 'waiting',
        output: 'Uncommitted waiting detail.',
        events: [{
          type: 'tool_update', status: 'waiting', seq: 2, timestamp: 2000,
          summary: 'Uncommitted waiting event.',
        }],
      }],
    }),
    { message: 'RUN_LEDGER_WRITE_FAILED' },
  )
  const uncommittedSnapshot = JSON.parse(fs.readFileSync(storagePath, 'utf8')).runs[0]
  assert.equal(uncommittedSnapshot.status, 'running')
  assert.equal(uncommittedSnapshot.agentRuns[0].status, 'waiting')
  assert.equal(uncommittedSnapshot.agentRuns[0].output, 'Uncommitted waiting detail.')
  assert.equal(journalEntries(storagePath).at(-1).phase, 'prepare')

  const restored = new RunLedger({ storagePath, now: () => 3000 })
  const recovered = restored.get('run-prepare-crash')
  assert.equal(restored.loadError, null)
  assert.equal(recovered.status, 'running')
  assert.equal(recovered.agentRuns[0].status, 'running')
  assert.equal(recovered.agentRuns[0].eventCursor, 1)
  assert.equal(recovered.agentRuns[0].output, '')
  assert.deepEqual(recovered.agentRuns[0].events, [])
})

test('detail-only checkpoints do not grow the lifecycle journal', (t) => {
  const { storagePath } = fixture(t)
  let now = 1000
  const ledger = new RunLedger({ storagePath, now: () => now })
  ledger.checkpoint(runRecord('run-bounded-journal', 'group-bounded-journal', 'running', [{
    agentRunId: 'agent-bounded-journal',
    kind: 'codex',
    status: 'running',
    output: 'first detail',
  }]))
  const initialEntryCount = journalEntries(storagePath).length

  now = 2000
  ledger.checkpoint({
    runId: 'run-bounded-journal',
    agentRuns: [{
      agentRunId: 'agent-bounded-journal',
      kind: 'codex',
      status: 'running',
      output: 'second detail in the same four kilobyte bucket',
    }],
  })
  assert.equal(journalEntries(storagePath).length, initialEntryCount)
  assert.equal(
    JSON.parse(fs.readFileSync(storagePath, 'utf8')).runs[0].agentRuns[0].output,
    'second detail in the same four kilobyte bucket',
  )
  assert.equal(
    new RunLedger({ storagePath, now: () => 2500 })
      .get('run-bounded-journal').agentRuns[0].output,
    'second detail in the same four kilobyte bucket',
  )

  now = 3000
  ledger.checkpoint({
    runId: 'run-bounded-journal',
    agentRuns: [{
      agentRunId: 'agent-bounded-journal',
      kind: 'codex',
      status: 'running',
      output: 'x'.repeat(4096),
    }],
  })
  assert.equal(journalEntries(storagePath).length, initialEntryCount + 2)
})

test('journal retains completed attempts beyond the display snapshot limit', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  const attempts = Array.from({ length: 256 }, (_, index) => ({
    agentRunId: `agent-history-${index + 1}`,
    kind: 'codex',
    round: index + 1,
    status: 'completed',
  }))
  ledger.checkpoint(runRecord(
    'run-history-journal', 'group-history-journal', 'running', attempts,
  ))
  ledger.checkpoint(runRecord('run-history-journal', 'group-history-journal', 'running', [{
    agentRunId: 'agent-history-257',
    kind: 'codex',
    round: 257,
    status: 'completed',
  }]))

  const snapshot = JSON.parse(fs.readFileSync(storagePath, 'utf8')).runs[0]
  const journal = fs.readFileSync(`${storagePath}.journal`, 'utf8')
  assert.equal(snapshot.agentRuns.length, 256)
  assert.equal(snapshot.agentRuns.some(agentRun => agentRun.agentRunId === 'agent-history-1'), false)
  assert.match(journal, /"agentRunId":"agent-history-1"/)
  assert.match(journal, /"agentRunId":"agent-history-257"/)
})

test('journal ignores and repairs one truncated final append', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  ledger.checkpoint(runRecord('run-before-tail', 'group-tail'))
  fs.appendFileSync(ledger.journalPath, '{"version":1,"sequence":999')

  const restored = new RunLedger({ storagePath, now: () => 2000 })
  assert.equal(restored.loadError, null)
  assert.equal(restored.get('run-before-tail').runId, 'run-before-tail')
  assert.equal(fs.readFileSync(restored.journalPath, 'utf8').endsWith('\n'), true)
  restored.checkpoint(runRecord('run-after-tail', 'group-tail'))
  assert.deepEqual(new RunLedger({ storagePath }).list().map(record => record.runId), [
    'run-after-tail', 'run-before-tail',
  ])
})

test('journal failure prevents snapshot and in-memory mutation', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  ledger.checkpoint(runRecord('run-stable', 'group-stable'))
  const beforeMemory = ledger.list()
  const beforeDisk = fs.readFileSync(storagePath, 'utf8')
  const append = ledger.journal.append.bind(ledger.journal)
  let failed = false
  ledger.journal.append = (entry) => {
    if (!failed) {
      failed = true
      throw new Error('JOURNAL_APPEND_FAILED')
    }
    return append(entry)
  }

  assert.throws(
    () => ledger.checkpoint(runRecord('run-blocked', 'group-blocked')),
    { message: 'RUN_LEDGER_WRITE_FAILED' },
  )
  assert.deepEqual(ledger.list(), beforeMemory)
  assert.equal(fs.readFileSync(storagePath, 'utf8'), beforeDisk)

  assert.equal(ledger.checkpoint(runRecord('run-blocked', 'group-blocked')).runId, 'run-blocked')
  assert.equal(new RunLedger({ storagePath }).get('run-blocked').status, 'running')
})

test('journal rejects raw execution data and unknown lifecycle fields', (t) => {
  const { directory, storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  ledger.checkpoint(runRecord('run-journal-fields', 'group-journal-fields', 'running', [{
    agentRunId: 'agent-journal-fields', kind: 'codex', status: 'running',
  }]))
  const baselineEntries = journalEntries(storagePath)
  const prepareIndex = baselineEntries.findIndex(entry => (
    entry.phase === 'prepare' && entry.change?.upserts?.[0]?.agentRuns?.length
  ))
  assert.notEqual(prepareIndex, -1)
  const cases = [
    ['output', entry => { entry.change.upserts[0].agentRuns[0].output = 'raw output' }],
    ['events', entry => { entry.change.upserts[0].agentRuns[0].events = [] }],
    ['command', entry => { entry.change.upserts[0].agentRuns[0].command = 'run tool' }],
    ['unknown-agent', entry => { entry.change.upserts[0].agentRuns[0].privateState = true }],
    ['unknown-context', entry => {
      entry.change.upserts[0].agentRuns[0].context.privateState = true
    }],
  ]

  for (const [index, [name, mutate]] of cases.entries()) {
    const entries = JSON.parse(JSON.stringify(baselineEntries))
    mutate(entries[prepareIndex])
    const candidatePath = path.join(directory, `${name}.json`)
    fs.copyFileSync(storagePath, candidatePath)
    fs.writeFileSync(
      `${candidatePath}.journal`,
      `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`,
      'utf8',
    )

    const restored = new RunLedger({ storagePath: candidatePath, now: () => 2000 })
    assert.deepEqual(restored.list(), [], name)
    assert.equal(restored.loadError instanceof Error, true, name)
    assert.throws(
      () => restored.checkpoint(runRecord(`run-${index}`, 'group-new')),
      { message: 'RUN_LEDGER_LOAD_FAILED' },
      name,
    )
  }
})

test('remote recovery reattaches with a durable job id and cursor', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  ledger.checkpoint({
    ...runRecord('run-remote', 'group-remote', 'running', [{
      agentRunId: 'agent-remote', kind: 'codex', round: 1, status: 'running',
    }]),
    remoteJob: {
      connectorId: 'mock.remote',
      jobId: 'job-123',
      cursor: 'cursor-7',
    },
  })

  const restarted = new RunLedger({ storagePath, now: () => 2000 })
  const changed = restarted.recoverInterrupted({
    remoteConnectorIds: ['mock.remote'],
    recoveryOwnerId: 'desktop-recovery',
  })
  assert.equal(changed[0].status, 'reconciling')
  assert.equal(changed[0].agentRuns[0].status, 'running')
  const [claim] = restarted.remoteRecoveries('desktop-recovery')
  assert.deepEqual(claim, {
    runId: 'run-remote',
    taskId: 'run-remote-task',
    groupId: 'group-remote',
    connectorId: 'mock.remote',
    jobId: 'job-123',
    cursor: 'cursor-7',
  })

  for (const status of ['preparing', 'queued', 'reconciling']) {
    assert.throws(
      () => restarted.reconcileRemote(
        'run-remote', 'desktop-recovery', { status },
      ),
      { message: 'RUN_LEDGER_REMOTE_UPDATE_INVALID' },
      status,
    )
  }

  const mockConnector = ({ jobId, cursor, terminal = false }) => {
    assert.equal(jobId, 'job-123')
    return terminal
      ? { cursor: 'cursor-9', status: 'completed' }
      : { cursor: 'cursor-8', status: 'running' }
  }
  const running = restarted.reconcileRemote(
    'run-remote', 'desktop-recovery', mockConnector(claim),
  )
  assert.equal(running.status, 'running')
  assert.equal(running.remoteJob.cursor, 'cursor-8')
  assert.equal(running.remoteJob.recoveryOwnerId, 'desktop-recovery')
  assert.equal(
    restarted.remoteRecoveries('desktop-recovery')[0].cursor,
    'cursor-8',
  )

  const remoteResult = mockConnector({
    ...claim,
    cursor: running.remoteJob.cursor,
    terminal: true,
  })
  const completed = restarted.reconcileRemote(
    'run-remote', 'desktop-recovery', remoteResult,
  )
  assert.equal(completed.status, 'completed')
  assert.equal(completed.remoteJob.cursor, 'cursor-9')
  assert.equal(completed.remoteJob.recoveryOwnerId, '')
  assert.equal(completed.agentRuns[0].status, 'completed')

  const restored = new RunLedger({ storagePath, now: () => 3000 }).get('run-remote')
  assert.equal(restored.status, 'completed')
  assert.equal(restored.remoteJob.jobId, 'job-123')
  assert.equal(restored.remoteJob.cursor, 'cursor-9')
})

test('finish preserves Agent snapshots and records a terminal reason', (t) => {
  const { storagePath } = fixture(t)
  let now = 1000
  const ledger = new RunLedger({ storagePath, now: () => now })
  const active = ledger.checkpoint(runRecord('run-1', 'group-1', 'running', [{
    agentRunId: 'agent-1',
    kind: 'codex',
    status: 'completed',
    output: 'Done',
    context: { includedCount: 2, omittedCount: 1, charCount: 200 },
  }]))

  now = 2000
  const finished = ledger.finish('run-1', 'completed', 'user')

  assert.equal(finished.status, 'completed')
  assert.equal(finished.reason, 'user')
  assert.equal(finished.finishedAt, 2000)
  assert.deepEqual(finished.agentRuns, active.agentRuns)
})

test('recovers interrupted runs and Agent attempts once', (t) => {
  const { storagePath } = fixture(t)
  let now = 1000
  const ledger = new RunLedger({ storagePath, now: () => now })
  ledger.checkpoint(runRecord('run-active', 'group-1', 'preparing', [{
    agentRunId: 'agent-running',
    kind: 'codex',
    status: 'running',
    context: { includedCount: 3, omittedCount: 2, charCount: 400 },
  }, {
    agentRunId: 'agent-complete',
    kind: 'codex',
    status: 'completed',
  }]))
  ledger.checkpoint(runRecord('run-terminal', 'group-2', 'completed', [{
    agentRunId: 'agent-waiting',
    kind: 'codex',
    status: 'waiting',
    context: { includedCount: 1, omittedCount: 0, charCount: 50 },
  }]))

  now = 5000
  const restored = new RunLedger({ storagePath, now: () => now })
  const changed = restored.recoverInterrupted()

  assert.equal(changed.length, 2)
  const active = restored.get('run-active')
  assert.equal(active.status, 'interrupted')
  assert.equal(active.reason, 'app_restart')
  assert.equal(active.agentRuns[0].status, 'interrupted')
  assert.equal(active.agentRuns[0].reason, 'app_restart')
  assert.deepEqual(active.agentRuns[0].context, {
    includedCount: 3, omittedCount: 2, charCount: 400,
  })
  assert.equal(active.agentRuns[1].status, 'completed')
  const terminal = restored.get('run-terminal')
  assert.equal(terminal.status, 'completed')
  assert.equal(terminal.agentRuns[0].status, 'interrupted')
  assert.equal(terminal.agentRuns[0].reason, 'app_restart')

  const persisted = fs.readFileSync(storagePath, 'utf8')
  assert.deepEqual(restored.recoverInterrupted(), [])
  assert.equal(fs.readFileSync(storagePath, 'utf8'), persisted)
})

test('retention evicts the oldest terminal record before active records', (t) => {
  const { storagePath } = fixture(t)
  let now = 0
  const ledger = new RunLedger({ storagePath, maxRuns: 3, now: () => now })
  const add = (runId, status) => {
    now += 10
    ledger.checkpoint(runRecord(runId, 'group-1', status))
  }

  add('active-old', 'running')
  add('terminal-old', 'completed')
  add('terminal-new', 'failed')
  add('active-new', 'running')
  assert.deepEqual(ledger.list().map(record => record.runId), [
    'active-new', 'terminal-new', 'active-old',
  ])

  add('active-next', 'running')
  assert.deepEqual(ledger.list().map(record => record.runId), [
    'active-next', 'active-new', 'terminal-new', 'active-old',
  ])

  add('active-last', 'running')
  assert.deepEqual(ledger.list().map(record => record.runId), [
    'active-last', 'active-next', 'active-new', 'terminal-new', 'active-old',
  ])
  assert.deepEqual(
    new RunLedger({ storagePath, maxRuns: 3 }).list().map(record => record.runId),
    ['active-last', 'active-next', 'active-new', 'terminal-new', 'active-old'],
  )

  ledger.finish('active-last', 'completed')
  assert.deepEqual(ledger.list().map(record => record.runId), [
    'active-last', 'active-next', 'active-new', 'active-old',
  ])
  assert.equal(ledger.get('active-last').status, 'completed')
  assert.equal(new RunLedger({ storagePath, maxRuns: 3 }).get('active-last').status, 'completed')
})

test('uncertain journal compaction cannot append with a stale sequence', t => {
  if (process.platform === 'win32') return t.skip('directory sync is not portable on Windows')
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  ledger.checkpoint(runRecord('active-compaction', 'group-compaction'))
  const originalSync = fs.fsyncSync
  fs.fsyncSync = fd => {
    if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('SYNC_FAILED'), { code: 'EIO' })
    return originalSync(fd)
  }
  try {
    assert.throws(() => ledger.journal.compact(ledger.journalBaseline(), 1001), { message: 'SYNC_FAILED' })
  } finally { fs.fsyncSync = originalSync }
  assert.throws(() => ledger.checkpoint(runRecord('another-run', 'group-compaction')), { message: 'RUN_LEDGER_WRITE_FAILED' })
  const restarted = new RunLedger({ storagePath })
  assert.equal(restarted.loadError, null)
  assert.equal(restarted.get('active-compaction').status, 'running')
  assert.equal(restarted.get('another-run'), null)
  restarted.checkpoint(runRecord('another-run', 'group-compaction'))
  assert.equal(new RunLedger({ storagePath }).get('another-run').status, 'running')
})

test('failed journal append rollback prevents stale sequence reuse', t => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  ledger.checkpoint(runRecord('active-append', 'group-append'))
  const originalSync = fs.fsyncSync
  const originalTruncate = fs.truncateSync
  fs.fsyncSync = () => { throw Object.assign(new Error('SYNC_FAILED'), { code: 'EIO' }) }
  fs.truncateSync = () => { throw Object.assign(new Error('TRUNCATE_FAILED'), { code: 'EIO' }) }
  try {
    assert.throws(() => ledger.checkpoint(runRecord('failed-append', 'group-append')), { message: 'RUN_LEDGER_WRITE_FAILED' })
  } finally {
    fs.fsyncSync = originalSync
    fs.truncateSync = originalTruncate
  }
  assert.throws(() => ledger.checkpoint(runRecord('later-append', 'group-append')), { message: 'RUN_LEDGER_WRITE_FAILED' })
  const restarted = new RunLedger({ storagePath })
  assert.equal(restarted.loadError, null)
  assert.equal(restarted.get('active-append').status, 'running')
  assert.equal(restarted.get('failed-append'), null)
  restarted.checkpoint(runRecord('later-append', 'group-append'))
  assert.equal(new RunLedger({ storagePath }).get('later-append').status, 'running')
})

test('deleteGroup removes only matching records and persists the result', (t) => {
  const { storagePath } = fixture(t)
  let now = 0
  const ledger = new RunLedger({ storagePath, now: () => ++now })
  ledger.checkpoint(runRecord('run-a1', 'group-a'))
  ledger.checkpoint(runRecord('run-b1', 'group-b'))
  ledger.checkpoint(runRecord('run-a2', 'group-a'))

  assert.equal(ledger.deleteGroup('group-a'), 2)
  assert.deepEqual(ledger.list('group-a'), [])
  assert.deepEqual(ledger.list().map(record => record.runId), ['run-b1'])
  assert.deepEqual(
    new RunLedger({ storagePath }).list().map(record => record.runId),
    ['run-b1'],
  )
})

test('checkpoint remains retryable when persistence fails', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  ledger.checkpoint(runRecord('run-1', 'group-1'))
  const beforeMemory = ledger.list()
  const beforeDisk = fs.readFileSync(storagePath, 'utf8')
  const next = runRecord('run-2', 'group-2')
  failNextPersist(ledger)

  assert.throws(() => ledger.checkpoint(next), { message: 'RUN_LEDGER_WRITE_FAILED' })
  assert.deepEqual(ledger.list(), beforeMemory)
  assert.equal(fs.readFileSync(storagePath, 'utf8'), beforeDisk)

  assert.equal(ledger.checkpoint(next).runId, 'run-2')
  assert.deepEqual(new RunLedger({ storagePath }).list().map(record => record.runId), [
    'run-2', 'run-1',
  ])
})

test('finish remains retryable when persistence fails', (t) => {
  const { storagePath } = fixture(t)
  let now = 1000
  const ledger = new RunLedger({ storagePath, now: () => now })
  ledger.checkpoint(runRecord('run-1', 'group-1'))
  const beforeMemory = ledger.list()
  const beforeDisk = fs.readFileSync(storagePath, 'utf8')
  now = 2000
  failNextPersist(ledger)

  assert.throws(
    () => ledger.finish('run-1', 'completed', 'done'),
    { message: 'RUN_LEDGER_WRITE_FAILED' },
  )
  assert.deepEqual(ledger.list(), beforeMemory)
  assert.equal(fs.readFileSync(storagePath, 'utf8'), beforeDisk)

  assert.equal(ledger.finish('run-1', 'completed', 'done').status, 'completed')
  assert.equal(new RunLedger({ storagePath }).get('run-1').status, 'completed')
})

test('terminal outbox restores a completed run after snapshot persistence fails and restart', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  ledger.checkpoint(runRecord('run-outbox', 'group-outbox'))
  const completed = runRecord('run-outbox', 'group-outbox', 'completed', [{
    agentRunId: 'agent-outbox', kind: 'codex', status: 'completed',
    output: 'Durable completed answer.',
  }])
  ledger.recordTerminalIntent(completed)
  if (process.platform !== 'win32') {
    const directory = `${storagePath}.terminal-outbox`
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700)
    assert.equal(fs.statSync(path.join(directory, fs.readdirSync(directory)[0])).mode & 0o777, 0o600)
  }
  failNextPersist(ledger)
  assert.throws(() => ledger.checkpoint(completed), { message: 'RUN_LEDGER_WRITE_FAILED' })
  const restarted = new RunLedger({ storagePath, now: () => 2000 })
  assert.equal(restarted.loadError, null)
  assert.equal(restarted.get('run-outbox').status, 'completed')
  assert.equal(restarted.get('run-outbox').agentRuns[0].output, 'Durable completed answer.')
  assert.deepEqual(restarted.recoverInterrupted(), [])
  assert.equal(new RunLedger({ storagePath }).get('run-outbox').status, 'completed')
  assert.deepEqual(fs.readdirSync(`${storagePath}.terminal-outbox`), [])
})

test('terminal outbox returns its original intent on retry with changed output', t => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  ledger.checkpoint(runRecord('run-intent', 'group-intent'))
  const first = runRecord('run-intent', 'group-intent', 'completed', [{
    agentRunId: 'agent-intent', kind: 'codex', status: 'completed', output: 'First answer',
  }])
  const changed = { ...first, agentRuns: [{ ...first.agentRuns[0], output: 'Changed answer' }] }
  ledger.recordTerminalIntent(first)
  assert.deepEqual(ledger.recordTerminalIntent(changed), first)
  const restarted = new RunLedger({ storagePath })
  assert.equal(restarted.get('run-intent').agentRuns[0].output, 'First answer')
})

test('terminal intent survives abrupt process exit before the terminal checkpoint', (t) => {
  const { spawnSync } = require('node:child_process')
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  ledger.checkpoint(runRecord('run-crash', 'group-crash'))
  const completed = runRecord('run-crash', 'group-crash', 'completed')
  const script = `
const { RunLedger } = require(process.argv[1])
const ledger = new RunLedger({ storagePath: process.argv[2] })
ledger.recordTerminalIntent(JSON.parse(process.argv[3]))
process.exit(42)
`
  const child = spawnSync(process.execPath, [
    '-e', script, require.resolve('../../src/runs/run-ledger.cjs'), storagePath, JSON.stringify(completed),
  ], { encoding: 'utf8' })
  assert.equal(child.status, 42, child.stderr)
  const restarted = new RunLedger({ storagePath })
  assert.equal(restarted.loadError, null)
  assert.equal(restarted.get('run-crash').status, 'completed')
  assert.deepEqual(restarted.recoverInterrupted(), [])
})

test('terminal outbox rejects redirected storage', { skip: process.platform === 'win32' }, (t) => {
  const { storagePath, directory } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  ledger.checkpoint(runRecord('run-link', 'group-link'))
  const target = path.join(directory, 'unrelated')
  fs.mkdirSync(target)
  fs.symlinkSync(target, `${storagePath}.terminal-outbox`)
  assert.throws(() => ledger.recordTerminalIntent(runRecord('run-link', 'group-link', 'completed')))
  assert.deepEqual(fs.readdirSync(target), [])
  const restarted = new RunLedger({ storagePath })
  assert.ok(restarted.loadError)
})

test('terminal outbox reports parent directory sync failure', { skip: process.platform === 'win32' }, (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  ledger.checkpoint(runRecord('run-dir-sync', 'group-dir-sync'))
  const original = fs.fsyncSync
  fs.fsyncSync = fd => {
    if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('SYNC_FAILED'), { code: 'EIO' })
    return original(fd)
  }
  t.after(() => { fs.fsyncSync = original })
  assert.throws(() => ledger.recordTerminalIntent(runRecord('run-dir-sync', 'group-dir-sync', 'completed')), {
    message: 'SYNC_FAILED',
  })
  assert.equal(ledger.get('run-dir-sync').status, 'running')
})

test('terminal outbox cleanup is idempotent after a committed terminal checkpoint', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  ledger.checkpoint(runRecord('run-committed', 'group-committed'))
  const completed = runRecord('run-committed', 'group-committed', 'completed')
  ledger.recordTerminalIntent(completed)
  ledger.checkpoint(completed)
  const restarted = new RunLedger({ storagePath })
  assert.equal(restarted.loadError, null)
  assert.equal(restarted.get('run-committed').status, 'completed')
  assert.deepEqual(fs.readdirSync(`${storagePath}.terminal-outbox`), [])
})

test('terminal outbox cleanup syncs its directory, including retries after a sync failure', { skip: process.platform === 'win32' }, (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  ledger.checkpoint(runRecord('run-cleanup', 'group-cleanup'))
  const completed = runRecord('run-cleanup', 'group-cleanup', 'completed')
  ledger.recordTerminalIntent(completed)
  ledger.checkpoint(completed)
  const original = fs.fsyncSync
  let directorySyncs = 0
  fs.fsyncSync = fd => {
    if (fs.fstatSync(fd).isDirectory()) {
      directorySyncs += 1
      if (directorySyncs === 1) throw Object.assign(new Error('SYNC_FAILED'), { code: 'EIO' })
    }
    return original(fd)
  }
  t.after(() => { fs.fsyncSync = original })
  assert.throws(() => ledger.clearTerminalIntent(completed.runId), { message: 'SYNC_FAILED' })
  assert.equal(ledger.get(completed.runId).status, 'completed')
  ledger.clearTerminalIntent(completed.runId)
  assert.equal(directorySyncs, 2)
  assert.deepEqual(fs.readdirSync(`${storagePath}.terminal-outbox`), [])
})

test('outbox cleanup does not recreate a subsequently deleted group', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  ledger.checkpoint(runRecord('run-deleted', 'group-deleted'))
  const completed = runRecord('run-deleted', 'group-deleted', 'completed')
  ledger.recordTerminalIntent(completed)
  ledger.checkpoint(completed)
  assert.equal(ledger.deleteGroup('group-deleted'), 1)
  const restarted = new RunLedger({ storagePath })
  assert.equal(restarted.loadError, null)
  assert.equal(restarted.get('run-deleted'), null)
  assert.deepEqual(fs.readdirSync(`${storagePath}.terminal-outbox`), [])
})

test('corrupt terminal outbox stops recovery rather than dropping a run', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  ledger.checkpoint(runRecord('run-corrupt', 'group-corrupt'))
  ledger.recordTerminalIntent(runRecord('run-corrupt', 'group-corrupt', 'completed'))
  const directory = `${storagePath}.terminal-outbox`
  fs.writeFileSync(path.join(directory, fs.readdirSync(directory)[0]), '{invalid')
  const restarted = new RunLedger({ storagePath })
  assert.ok(restarted.loadError)
  assert.throws(() => restarted.recoverInterrupted(), { message: 'RUN_LEDGER_LOAD_FAILED' })
})

test('interruption recovery remains retryable without mutating nested Agent state', (t) => {
  const { storagePath } = fixture(t)
  let now = 1000
  const ledger = new RunLedger({ storagePath, now: () => now })
  ledger.checkpoint(runRecord('run-1', 'group-1', 'running', [{
    agentRunId: 'agent-1',
    kind: 'codex',
    status: 'running',
    output: 'Work in progress',
  }]))
  const beforeMemory = ledger.list()
  const beforeDisk = fs.readFileSync(storagePath, 'utf8')
  now = 2000
  failNextPersist(ledger)

  assert.throws(() => ledger.recoverInterrupted(), { message: 'RUN_LEDGER_WRITE_FAILED' })
  assert.deepEqual(ledger.list(), beforeMemory)
  assert.equal(ledger.get('run-1').agentRuns[0].status, 'running')
  assert.equal(fs.readFileSync(storagePath, 'utf8'), beforeDisk)

  assert.equal(ledger.recoverInterrupted()[0].status, 'interrupted')
  const restored = new RunLedger({ storagePath }).get('run-1')
  assert.equal(restored.status, 'interrupted')
  assert.equal(restored.agentRuns[0].status, 'interrupted')
})

test('group deletion remains retryable when persistence fails', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  ledger.checkpoint(runRecord('run-a', 'group-a'))
  ledger.checkpoint(runRecord('run-b', 'group-b'))
  const beforeMemory = ledger.list()
  const beforeDisk = fs.readFileSync(storagePath, 'utf8')
  failNextPersist(ledger)

  assert.throws(() => ledger.deleteGroup('group-a'), { message: 'RUN_LEDGER_WRITE_FAILED' })
  assert.deepEqual(ledger.list(), beforeMemory)
  assert.equal(fs.readFileSync(storagePath, 'utf8'), beforeDisk)

  assert.equal(ledger.deleteGroup('group-a'), 1)
  assert.deepEqual(new RunLedger({ storagePath }).list().map(record => record.runId), ['run-b'])
})

test('accepts bounded Unicode group identifiers without relaxing run identifiers', (t) => {
  const { storagePath } = fixture(t)
  const ledger = new RunLedger({ storagePath, now: () => 1000 })
  const groupId = '历史群聊 1'

  assert.equal(ledger.checkpoint(runRecord('run-unicode', groupId)).groupId, groupId)
  assert.equal(ledger.list(groupId)[0].groupId, groupId)
  assert.throws(
    () => ledger.checkpoint(runRecord('运行-1', groupId)),
    { message: 'RUN_LEDGER_RECORD_INVALID' },
  )
  assert.throws(
    () => ledger.checkpoint(runRecord('run-control', 'group\ninvalid')),
    { message: 'RUN_LEDGER_RECORD_INVALID' },
  )
  assert.equal(ledger.deleteGroup(groupId), 1)
})

test('corrupt or malformed stores stay read-only without deleting unrelated data', (t) => {
  const { directory, storagePath } = fixture(t)
  fs.mkdirSync(path.dirname(storagePath), { recursive: true })
  const sibling = path.join(path.dirname(storagePath), 'keep.txt')
  fs.writeFileSync(sibling, 'keep', 'utf8')

  for (const [name, contents] of [
    ['corrupt', '{not-json'],
    ['malformed', JSON.stringify({ version: 1, runs: {} })],
    ['invalid-record', JSON.stringify({ version: 1, runs: [{ runId: 'run-bad' }] })],
    ['invalid-target-kinds', JSON.stringify({
      version: 1,
      runs: [{ ...runRecord('run-bad-kinds', 'group-bad'), targetKinds: {} }],
    })],
    ['invalid-target-kind-element', JSON.stringify({
      version: 1,
      runs: [{ ...runRecord('run-bad-kind-element', 'group-bad'), targetKinds: [null] }],
    })],
    ['invalid-target-kind-value', JSON.stringify({
      version: 1,
      runs: [{ ...runRecord('run-bad-kind-value', 'group-bad'), targetKinds: ['../codex'] }],
    })],
    ['invalid-agent-runs', JSON.stringify({
      version: 1,
      runs: [{ ...runRecord('run-bad-agents', 'group-bad'), agentRuns: {} }],
    })],
    ['invalid-agent-run-element', JSON.stringify({
      version: 1,
      runs: [{ ...runRecord('run-bad-agent-element', 'group-bad'), agentRuns: [null] }],
    })],
    ['invalid-agent-run-record', JSON.stringify({
      version: 1,
      runs: [{ ...runRecord('run-bad-agent-record', 'group-bad'), agentRuns: [{}] }],
    })],
    ['invalid-agent-events', JSON.stringify({
      version: 1,
      runs: [runRecord('run-bad-events', 'group-bad', 'running', [{
        agentRunId: 'agent-bad-events',
        kind: 'codex',
        events: {},
      }])],
    })],
    ['invalid-agent-event-element', JSON.stringify({
      version: 1,
      runs: [runRecord('run-bad-event-element', 'group-bad', 'running', [{
        agentRunId: 'agent-bad-event-element',
        kind: 'codex',
        events: [null],
      }])],
    })],
    ['invalid-agent-event-record', JSON.stringify({
      version: 1,
      runs: [runRecord('run-bad-event-record', 'group-bad', 'running', [{
        agentRunId: 'agent-bad-event-record',
        kind: 'codex',
        events: [{}],
      }])],
    })],
    ['invalid-agent-source-ids', JSON.stringify({
      version: 1,
      runs: [runRecord('run-bad-source-ids', 'group-bad', 'running', [{
        agentRunId: 'agent-bad-source-ids',
        kind: 'codex',
        sourceMessageIds: {},
      }])],
    })],
    ['invalid-agent-source-id-element', JSON.stringify({
      version: 1,
      runs: [runRecord('run-bad-source-id-element', 'group-bad', 'running', [{
        agentRunId: 'agent-bad-source-id-element',
        kind: 'codex',
        sourceMessageIds: [null],
      }])],
    })],
    ['invalid-agent-source-id-value', JSON.stringify({
      version: 1,
      runs: [runRecord('run-bad-source-id-value', 'group-bad', 'running', [{
        agentRunId: 'agent-bad-source-id-value',
        kind: 'codex',
        sourceMessageIds: ['../message'],
      }])],
    })],
    ['invalid-agent-context', JSON.stringify({
      version: 1,
      runs: [runRecord('run-bad-context', 'group-bad', 'running', [{
        agentRunId: 'agent-bad-context',
        kind: 'codex',
        context: [],
      }])],
    })],
  ]) {
    const candidatePath = name === 'corrupt'
      ? storagePath
      : path.join(directory, `${name}.json`)
    fs.writeFileSync(candidatePath, contents, 'utf8')
    const ledger = new RunLedger({ storagePath: candidatePath, now: () => 1000 })

    assert.deepEqual(ledger.list(), [])
    assert.equal(ledger.loadError instanceof Error, true)
    for (const mutation of [
      () => ledger.checkpoint(runRecord('run-new', 'group-new')),
      () => ledger.finish('missing', 'failed'),
      () => ledger.recoverInterrupted(),
      () => ledger.deleteGroup('missing'),
    ]) {
      assert.throws(mutation, { message: 'RUN_LEDGER_LOAD_FAILED' })
    }
    assert.equal(fs.readFileSync(candidatePath, 'utf8'), contents)
    assert.equal(fs.readFileSync(sibling, 'utf8'), 'keep')
  }
})

test('rejects coercible persisted scalar containers at every nested level', (t) => {
  const { directory, storagePath } = fixture(t)
  fs.mkdirSync(path.dirname(storagePath), { recursive: true })
  const baseline = {
    ...runRecord('run-scalars', 'group-scalars', 'completed', [{
      agentRunId: 'agent-scalars',
      kind: 'codex',
      round: 1,
      status: 'completed',
      output: 'Done',
      events: [{
        runId: 'run-scalars',
        agentRunId: 'agent-scalars',
        groupId: 'group-scalars',
        threadRootId: 'group-scalars-root',
        agentKind: 'codex',
        round: 1,
        seq: 1,
        timestamp: 1000,
        status: 'completed',
        type: 'warning',
        id: 'event-scalars',
        title: 'Warning',
        summary: 'Summary',
        detail: 'Result: 1 item',
        delta: 'legacy delta',
      }],
      sourceMessageIds: ['message-scalars'],
      startedAt: 1000,
      lastActivityAt: 1000,
      finishedAt: 1000,
      silent: false,
      truncated: false,
      reason: 'done',
      context: {
        includedCount: 1,
        omittedCount: 0,
        charCount: 100,
        sessionRotated: false,
      },
    }]),
    mode: 'auto',
    permissionMode: 'read-only',
    createdAt: 1000,
    startedAt: 1000,
    updatedAt: 1000,
    finishedAt: 1000,
    currentRound: 1,
    maxRounds: 2,
    unlimitedRounds: false,
    reason: 'done',
  }
  const scalarPaths = [
    ['runId'], ['taskId'], ['groupId'], ['threadRootId'], ['mode'], ['status'], ['reason'],
    ['permissionMode'], ['createdAt'], ['startedAt'], ['updatedAt'], ['finishedAt'],
    ['currentRound'], ['maxRounds'], ['unlimitedRounds'],
    ['agentRuns', 0, 'agentRunId'], ['agentRuns', 0, 'kind'],
    ['agentRuns', 0, 'round'], ['agentRuns', 0, 'status'],
    ['agentRuns', 0, 'output'], ['agentRuns', 0, 'startedAt'],
    ['agentRuns', 0, 'lastActivityAt'], ['agentRuns', 0, 'finishedAt'],
    ['agentRuns', 0, 'silent'], ['agentRuns', 0, 'truncated'],
    ['agentRuns', 0, 'reason'],
    ['agentRuns', 0, 'events', 0, 'runId'],
    ['agentRuns', 0, 'events', 0, 'agentRunId'],
    ['agentRuns', 0, 'events', 0, 'groupId'],
    ['agentRuns', 0, 'events', 0, 'threadRootId'],
    ['agentRuns', 0, 'events', 0, 'agentKind'],
    ['agentRuns', 0, 'events', 0, 'round'],
    ['agentRuns', 0, 'events', 0, 'seq'],
    ['agentRuns', 0, 'events', 0, 'timestamp'],
    ['agentRuns', 0, 'events', 0, 'status'],
    ['agentRuns', 0, 'events', 0, 'type'],
    ['agentRuns', 0, 'events', 0, 'id'],
    ['agentRuns', 0, 'events', 0, 'title'],
    ['agentRuns', 0, 'events', 0, 'summary'],
    ['agentRuns', 0, 'events', 0, 'detail'],
    ['agentRuns', 0, 'events', 0, 'delta'],
    ['agentRuns', 0, 'context', 'includedCount'],
    ['agentRuns', 0, 'context', 'omittedCount'],
    ['agentRuns', 0, 'context', 'charCount'],
    ['agentRuns', 0, 'context', 'sessionRotated'],
  ]
  const scalarCases = [
    ...scalarPaths.map(scalarPath => [scalarPath, value => [value]]),
    ...[
      ['reason'],
      ['agentRuns', 0, 'output'],
      ['agentRuns', 0, 'events', 0, 'summary'],
      ['agentRuns', 0, 'context', 'includedCount'],
    ].map(scalarPath => [scalarPath, value => ({ value })]),
  ]

  for (const [index, [scalarPath, corrupt]] of scalarCases.entries()) {
    const record = JSON.parse(JSON.stringify(baseline))
    let container = record
    for (const field of scalarPath.slice(0, -1)) container = container[field]
    const field = scalarPath.at(-1)
    container[field] = corrupt(container[field])
    const candidatePath = index === 0
      ? storagePath
      : path.join(directory, `scalar-${index}.json`)
    const contents = JSON.stringify({ version: 1, runs: [record] })
    fs.writeFileSync(candidatePath, contents, 'utf8')

    const ledger = new RunLedger({ storagePath: candidatePath, now: () => 2000 })

    assert.equal(ledger.loadError instanceof Error, true, scalarPath.join('.'))
    assert.throws(
      () => ledger.checkpoint(runRecord('run-new', 'group-new')),
      { message: 'RUN_LEDGER_LOAD_FAILED' },
      scalarPath.join('.'),
    )
    assert.equal(fs.readFileSync(candidatePath, 'utf8'), contents)
  }
})

test('rejects persisted enums and bounded numbers that normalization would change', (t) => {
  const { directory, storagePath } = fixture(t)
  fs.mkdirSync(path.dirname(storagePath), { recursive: true })
  const cases = [
    ['mode', record => { record.mode = 'bogus' }],
    ['run-status', record => { record.status = 'bogus' }],
    ['permission', record => { record.permissionMode = 'bogus' }],
    ['manual-rounds', record => { record.mode = 'manual' }],
    ['unlimited-max', record => { record.unlimitedRounds = true }],
    ['round-over-max', record => { record.maxRounds = 1; record.currentRound = 2 }],
    ['current-negative', record => { record.currentRound = -1 }],
    ['current-fractional', record => { record.currentRound = 1.5 }],
    ['current-overflow', record => { record.currentRound = 100001 }],
    ['max-negative', record => { record.maxRounds = -1 }],
    ['max-overflow', record => { record.maxRounds = 100001 }],
    ['remote-job-container', record => { record.remoteJob = [] }],
    ['remote-connector', record => {
      record.remoteJob = { connectorId: '../remote', jobId: 'job-1' }
    }],
    ['remote-job-id', record => {
      record.remoteJob = { connectorId: 'mock.remote', jobId: 'job id' }
    }],
    ['remote-cursor', record => {
      record.remoteJob = { connectorId: 'mock.remote', jobId: 'job-1', cursor: 'bad cursor' }
    }],
    ['remote-owner', record => {
      record.remoteJob = {
        connectorId: 'mock.remote', jobId: 'job-1', recoveryOwnerId: '../owner',
      }
    }],
    ['remote-unknown', record => {
      record.remoteJob = { connectorId: 'mock.remote', jobId: 'job-1', secret: 'nope' }
    }],
    ['agent-status', record => { record.agentRuns[0].status = 'bogus' }],
    ['agent-run-only-status', record => { record.agentRuns[0].status = 'round-limit' }],
    ['agent-preparing-status', record => { record.agentRuns[0].status = 'preparing' }],
    ['agent-round-negative', record => { record.agentRuns[0].round = -1 }],
    ['agent-round-overflow', record => { record.agentRuns[0].round = 100001 }],
    ['event-cursor-negative', record => { record.agentRuns[0].eventCursor = -1 }],
    ['event-cursor-fractional', record => { record.agentRuns[0].eventCursor = 1.5 }],
    ['event-cursor-overflow', record => { record.agentRuns[0].eventCursor = 1000000001 }],
    ['output-chars-negative', record => { record.agentRuns[0].outputChars = -1 }],
    ['output-chars-fractional', record => { record.agentRuns[0].outputChars = 1.5 }],
    ['output-chars-overflow', record => { record.agentRuns[0].outputChars = 1000001 }],
    ['event-status', record => { record.agentRuns[0].events[0].status = 'bogus' }],
    ['event-run-only-status', record => { record.agentRuns[0].events[0].status = 'round-limit' }],
    ['event-preparing-status', record => { record.agentRuns[0].events[0].status = 'preparing' }],
    ['event-round-negative', record => { record.agentRuns[0].events[0].round = -1 }],
    ['event-round-overflow', record => { record.agentRuns[0].events[0].round = 100001 }],
    ['event-seq-zero', record => { record.agentRuns[0].events[0].seq = 0 }],
    ['event-seq-overflow', record => { record.agentRuns[0].events[0].seq = 1000000001 }],
    ['included-negative', record => { record.agentRuns[0].context.includedCount = -1 }],
    ['included-overflow', record => { record.agentRuns[0].context.includedCount = 1001 }],
    ['omitted-negative', record => { record.agentRuns[0].context.omittedCount = -1 }],
    ['omitted-overflow', record => { record.agentRuns[0].context.omittedCount = 100001 }],
    ['chars-negative', record => { record.agentRuns[0].context.charCount = -1 }],
    ['chars-overflow', record => { record.agentRuns[0].context.charCount = 1000001 }],
    ['source-count-negative', record => { record.agentRuns[0].context.sourceCount = -1 }],
    ['prompt-bytes-overflow', record => { record.agentRuns[0].context.promptBytes = 10000001 }],
    ['wire-bytes-fractional', record => { record.agentRuns[0].context.wirePayloadBytes = 1.5 }],
    ['source-hash-invalid', record => { record.agentRuns[0].context.sourceHash = 'invalid' }],
    ['prompt-hash-invalid', record => { record.agentRuns[0].context.promptHash = 'invalid' }],
    ['wire-hash-invalid', record => { record.agentRuns[0].context.wirePayloadHash = 'invalid' }],
  ]

  for (const [index, [name, mutate]] of cases.entries()) {
    const record = storedTraceRecord()
    mutate(record)
    const candidatePath = index === 0 ? storagePath : path.join(directory, `${name}.json`)
    const contents = JSON.stringify({ version: 1, runs: [record] })
    fs.writeFileSync(candidatePath, contents, 'utf8')

    const ledger = new RunLedger({ storagePath: candidatePath, now: () => 2000 })

    assert.equal(ledger.loadError instanceof Error, true, name)
    assert.throws(
      () => ledger.checkpoint(runRecord('run-new', 'group-new')),
      { message: 'RUN_LEDGER_LOAD_FAILED' },
      name,
    )
    assert.equal(fs.readFileSync(candidatePath, 'utf8'), contents, name)
  }
})

test('rejects explicit event provenance that disagrees with its parent', (t) => {
  const { directory, storagePath } = fixture(t)
  fs.mkdirSync(path.dirname(storagePath), { recursive: true })
  const cases = [
    ['runId', 'run-other'],
    ['agentRunId', 'agent-other'],
    ['groupId', 'group-other'],
    ['threadRootId', 'root-other'],
    ['agentKind', 'hermes'],
    ['round', 2],
  ]

  for (const [index, [field, value]] of cases.entries()) {
    const record = storedTraceRecord()
    record.agentRuns[0].events[0][field] = value
    const candidatePath = index === 0
      ? storagePath
      : path.join(directory, `provenance-${field}.json`)
    const contents = JSON.stringify({ version: 1, runs: [record] })
    fs.writeFileSync(candidatePath, contents, 'utf8')

    const ledger = new RunLedger({ storagePath: candidatePath, now: () => 2000 })

    assert.equal(ledger.loadError instanceof Error, true, field)
    assert.throws(
      () => ledger.finish('run-stored', 'failed'),
      { message: 'RUN_LEDGER_LOAD_FAILED' },
      field,
    )
    assert.equal(fs.readFileSync(candidatePath, 'utf8'), contents, field)
  }

  const legacyPath = path.join(directory, 'legacy-event.json')
  const legacy = storedTraceRecord()
  for (const field of [
    'runId', 'agentRunId', 'groupId', 'threadRootId', 'agentKind', 'round',
  ]) delete legacy.agentRuns[0].events[0][field]
  fs.writeFileSync(legacyPath, JSON.stringify({ version: 1, runs: [legacy] }), 'utf8')
  const restored = new RunLedger({ storagePath: legacyPath })

  assert.equal(restored.loadError, null)
  assert.deepEqual(
    Object.fromEntries([
      'runId', 'agentRunId', 'groupId', 'threadRootId', 'agentKind', 'round',
    ].map(field => [field, restored.get('run-stored').agentRuns[0].events[0][field]])),
    {
      runId: 'run-stored',
      agentRunId: 'agent-stored',
      groupId: 'group-stored',
      threadRootId: 'group-stored-root',
      agentKind: 'codex',
      round: 1,
    },
  )
})

test('rejects duplicate run and Agent run identities across the complete store', (t) => {
  const { directory, storagePath } = fixture(t)
  fs.mkdirSync(path.dirname(storagePath), { recursive: true })
  const duplicateAgent = storedTraceRecord()
  duplicateAgent.agentRuns.push(JSON.parse(JSON.stringify(duplicateAgent.agentRuns[0])))
  const outsideWindow = [
    storedTraceRecord('run-edge-first', 'group-edge', 'agent-global-duplicate'),
    ...Array.from({ length: 2047 }, (_, index) => (
      runRecord(`run-unique-${index}`, 'group-edge')
    )),
    storedTraceRecord('run-edge-last', 'group-edge', 'agent-global-duplicate'),
  ]
  const cases = [
    ['duplicate-run', [
      storedTraceRecord('run-duplicate', 'group-first', 'agent-first'),
      storedTraceRecord('run-duplicate', 'group-second', 'agent-second'),
    ]],
    ['duplicate-agent', [duplicateAgent]],
    ['duplicate-agent-across-runs', [
      storedTraceRecord('run-first', 'group-first', 'agent-duplicate'),
      storedTraceRecord('run-second', 'group-second', 'agent-duplicate'),
    ]],
    ['duplicate-agent-outside-window', outsideWindow],
  ]

  for (const [index, [name, runs]] of cases.entries()) {
    const candidatePath = index === 0 ? storagePath : path.join(directory, `${name}.json`)
    const contents = JSON.stringify({ version: 1, runs })
    fs.writeFileSync(candidatePath, contents, 'utf8')

    const ledger = new RunLedger({ storagePath: candidatePath, now: () => 2000 })

    assert.deepEqual(ledger.list(), [], name)
    assert.equal(ledger.loadError instanceof Error, true, name)
    assert.throws(
      () => ledger.deleteGroup('group-first'),
      { message: 'RUN_LEDGER_LOAD_FAILED' },
      name,
    )
    assert.equal(fs.readFileSync(candidatePath, 'utf8'), contents, name)
  }
})

test('validates malformed records before applying the retention window', (t) => {
  const { storagePath } = fixture(t)
  fs.mkdirSync(path.dirname(storagePath), { recursive: true })
  const contents = JSON.stringify({
    version: 1,
    runs: [
      null,
      ...Array.from({ length: 2048 }, (_, index) => (
        runRecord(`run-window-${index}`, 'group-window')
      )),
    ],
  })
  fs.writeFileSync(storagePath, contents, 'utf8')

  const ledger = new RunLedger({ storagePath, now: () => 1000 })

  assert.deepEqual(ledger.list(), [])
  assert.equal(ledger.loadError instanceof Error, true)
  assert.throws(
    () => ledger.checkpoint(runRecord('run-new', 'group-new')),
    { message: 'RUN_LEDGER_LOAD_FAILED' },
  )
  assert.equal(fs.readFileSync(storagePath, 'utf8'), contents)
})

test('loads legacy records with omitted nested arrays and remains writable', (t) => {
  const { storagePath } = fixture(t)
  fs.mkdirSync(path.dirname(storagePath), { recursive: true })
  fs.writeFileSync(storagePath, JSON.stringify({
    version: 1,
    runs: [{
      runId: 'run-legacy',
      groupId: 'group-legacy',
      status: 'running',
    }, {
      runId: 'run-legacy-agent',
      groupId: 'group-legacy',
      targetKinds: ['codex'],
      status: 'running',
      agentRuns: [{
        agentRunId: 'agent-legacy',
        kind: 'codex',
        status: 'running',
      }],
    }],
  }), 'utf8')

  const ledger = new RunLedger({ storagePath, now: () => 1000 })

  assert.equal(ledger.loadError, null)
  assert.equal(ledger.get('run-legacy').taskId, '')
  assert.equal(ledger.get('run-legacy').contextPackState, 'legacy-unavailable')
  assert.deepEqual(ledger.get('run-legacy').targetKinds, [])
  assert.deepEqual(ledger.get('run-legacy').agentRuns, [])
  assert.deepEqual(ledger.get('run-legacy-agent').agentRuns[0].events, [])
  assert.equal(ledger.get('run-legacy-agent').contextPackState, 'legacy-unavailable')
  assert.deepEqual(ledger.get('run-legacy-agent').agentRuns[0].sourceMessageIds, [])
  assert.deepEqual(ledger.get('run-legacy-agent').agentRuns[0].context, {})
  const finished = ledger.finish('run-legacy', 'completed')
  assert.equal(finished.status, 'completed')
  assert.equal(finished.contextPackState, 'legacy-unavailable')
  const restarted = new RunLedger({ storagePath, now: () => 2000 })
  assert.equal(restarted.get('run-legacy').contextPackState, 'legacy-unavailable')
})

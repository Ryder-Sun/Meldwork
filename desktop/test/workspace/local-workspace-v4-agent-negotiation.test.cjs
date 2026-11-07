const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  createCollaborationReceipt,
  createCoordinationPlan,
} = require('../../src/collaboration/orchestration-v4-records.cjs')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { RunLedger } = require('../../src/runs/run-ledger.cjs')
const { v4Prompt } = require('../../src/workspace/local-workspace-context.cjs')
const { deferred, fixture } = require('../support/local-workspace-test-helpers.cjs')

function proposedAssignments(objectiveSuffix = '') {
  return [
    {
      taskId: 'inspect-current-behavior',
      ownerKind: 'codex',
      role: 'worker',
      objective: `Inspect the current behavior and collect evidence${objectiveSuffix}`,
      expectedOutput: 'An evidence-backed findings Artifact.',
      inputRefs: [],
      artifactIds: [],
      dependsOn: [],
    },
    {
      taskId: 'implement-bounded-change',
      ownerKind: 'hermes',
      role: 'worker',
      objective: 'Implement the bounded change independently.',
      expectedOutput: 'A tested implementation Artifact.',
      inputRefs: [],
      artifactIds: [],
      dependsOn: [],
    },
    {
      taskId: 'verify-bounded-change',
      ownerKind: 'hermes',
      role: 'verifier',
      objective: 'Verify the bounded change after implementation.',
      expectedOutput: 'A verification Artifact.',
      inputRefs: [],
      artifactIds: [],
      dependsOn: ['implement-bounded-change'],
    },
    {
      taskId: 'assemble-team-delivery',
      ownerKind: 'workbuddy',
      role: 'integrator',
      objective: 'Combine the evidence and implementation into the final team delivery.',
      expectedOutput: 'An integration-ready Artifact.',
      inputRefs: [],
      artifactIds: [],
      dependsOn: ['inspect-current-behavior', 'verify-bounded-change'],
    },
  ]
}

test('V4 proposal receipt shape uses an empty dependencies array without a placeholder', () => {
  const prompt = v4Prompt({
    group: {},
    kind: 'hermes',
    phase: 'proposal',
    snapshot: {
      targetKinds: ['hermes'],
      group: { name: 'Receipt shape', topic: '' },
      messageId: 'task-1',
      taskText: 'Produce an independent proposal.',
      history: [],
      skillHintsByKind: [],
    },
  })
  const receiptShape = prompt.split('\n').find(line => line.startsWith('Receipt JSON shape:'))

  assert.match(receiptShape, /"dependencies":\[\]/)
  assert.doesNotMatch(receiptShape, /"dependencies":\["\.\.\."\]/)
})

test('V4 challenge contract separates finalizer, verifier, and contradiction semantics', () => {
  const prompt = v4Prompt({
    group: {},
    kind: 'hermes',
    phase: 'challenge',
    snapshot: {
      targetKinds: ['codex', 'hermes'],
      group: { name: 'Coordination contract', topic: '' },
      messageId: 'task-1',
      taskText: 'Negotiate responsibilities.',
      history: [],
    },
  })

  assert.match(prompt, /must include one finalizerKind owned by an integrator/)
  assert.match(prompt, /exactly 1 distinct verifierKinds from the selected Agents/)
  assert.match(prompt, /verifierKinds must not contain finalizerKind/)
  assert.match(prompt, /"verdict":"contradict"[\s\S]*"agreeToPlan":false/)
  assert.doesNotMatch(prompt, /"verdict":"support\|contradict"/)
})

function minimalAssignments(targetKinds) {
  const finalizerKind = targetKinds.at(-1)
  return targetKinds.map((ownerKind, index) => ({
    taskId: `t${String(index + 1).padStart(2, '0')}`,
    ownerKind,
    role: ownerKind === finalizerKind ? 'integrator' : 'worker',
    objective: 'o',
    expectedOutput: 'e',
    inputRefs: [],
    artifactIds: [],
    dependsOn: [],
  }))
}

function storeTextArtifact(workspace, content, name = 'Referenced work input', producedBy = null) {
  const contentRef = workspace.contentBlobStore.put(content, { mediaType: 'text/plain' })
  return workspace.outcomeStore.putArtifact({
    type: 'document',
    name,
    producedBy: producedBy || {
      runId: 'run-reference-test',
      agentRunId: 'agent-run-reference-test',
      agentKind: 'codex',
    },
    contentRef,
    contentHash: contentRef.hash,
  })
}

function storeArtifactEvidence(workspace, artifact, recordedBy = null) {
  return workspace.outcomeStore.putEvidence({
    kind: 'observation',
    level: 'observed',
    subject: { type: 'artifact', artifactId: artifact.artifactId },
    summary: 'The work Artifact was captured for downstream delivery.',
    recordedBy: recordedBy || { kind: 'system', actorId: 'meldwork-main' },
    refs: [
      { type: 'artifact', artifactId: artifact.artifactId },
      {
        type: 'blob',
        contentRef: artifact.contentRef,
        contentHash: artifact.contentHash,
      },
    ],
  })
}

test('V4 work packages resolve negotiated frozen input and direct Artifact references', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  const referencedArtifact = storeTextArtifact(
    workspace,
    'DIRECT_ARTIFACT_BODY_FROM_OUTCOME_STORE',
  )
  const targetKinds = ['codex', 'hermes']
  const plan = createCoordinationPlan({
    snapshotHash: 'a'.repeat(64),
    targetKinds,
    assignments: [
      {
        taskId: 'inspect-frozen-input', ownerKind: 'codex', role: 'worker',
        objective: 'Inspect the negotiated frozen input.',
        expectedOutput: 'A referenced-input finding.',
        inputRefs: ['history-message-1'],
        artifactIds: [referencedArtifact.artifactId],
        dependsOn: [],
      },
      {
        taskId: 'assemble-result', ownerKind: 'hermes', role: 'integrator',
        objective: 'Assemble the result.', expectedOutput: 'Integrated output.',
        inputRefs: [], artifactIds: [], dependsOn: ['inspect-frozen-input'],
      },
    ],
    finalizerKind: 'hermes',
    verifierKinds: ['codex'],
    agreedBy: targetKinds,
  })
  const snapshot = {
    messageId: 'current-message',
    taskText: 'Current user task.',
    history: [{
      id: 'history-message-1', role: 'user', agentKind: '',
      text: 'FROZEN_HISTORY_INPUT_BODY',
    }],
  }

  const text = workspace.autoRunner.v4WorkAssignmentText(
    plan, 'codex', 'inspect-frozen-input', snapshot,
  )

  assert.match(text, /Input refs: history-message-1/)
  assert.match(text, /FROZEN_HISTORY_INPUT_BODY/)
  assert.match(text, new RegExp(`Artifact refs: ${referencedArtifact.artifactId}`))
  assert.match(text, /DIRECT_ARTIFACT_BODY_FROM_OUTCOME_STORE/)
})

test('V4 rejects missing, non-text, and unsafe negotiated work references', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  const snapshot = {
    messageId: 'current-message',
    taskText: 'Current user task.',
    history: [{
      id: 'unsafe-history', role: 'user', agentKind: '',
      text: 'Session: private-session-reference',
    }],
  }
  const nonTextRef = workspace.contentBlobStore.put(
    JSON.stringify({ value: 1 }),
    { mediaType: 'application/json' },
  )
  const nonTextArtifact = workspace.outcomeStore.putArtifact({
    type: 'structured-data',
    name: 'Structured work input',
    producedBy: {
      runId: 'run-reference-test',
      agentRunId: 'agent-run-reference-test',
      agentKind: 'codex',
    },
    contentRef: nonTextRef,
    contentHash: nonTextRef.hash,
  })
  const unsafeArtifact = storeTextArtifact(
    workspace,
    'Session: private-artifact-session',
    'Unsafe work input',
  )
  const planFor = ({ inputRefs = [], artifactIds = [] }) => createCoordinationPlan({
    snapshotHash: 'b'.repeat(64),
    targetKinds: ['codex', 'hermes'],
    assignments: [
      {
        taskId: 'inspect-reference', ownerKind: 'codex', role: 'worker',
        objective: 'Inspect the negotiated reference.', expectedOutput: 'A finding.',
        inputRefs, artifactIds, dependsOn: [],
      },
      {
        taskId: 'assemble-result', ownerKind: 'hermes', role: 'integrator',
        objective: 'Assemble the result.', expectedOutput: 'Integrated output.',
        inputRefs: [], artifactIds: [], dependsOn: ['inspect-reference'],
      },
    ],
    finalizerKind: 'hermes', verifierKinds: ['codex'], agreedBy: ['codex', 'hermes'],
  })

  for (const [name, plan] of [
    ['missing frozen source', planFor({ inputRefs: ['missing-message'] })],
    ['unsafe frozen source', planFor({ inputRefs: ['unsafe-history'] })],
    ['non-text Artifact', planFor({ artifactIds: [nonTextArtifact.artifactId] })],
    ['unsafe Artifact', planFor({ artifactIds: [unsafeArtifact.artifactId] })],
  ]) {
    assert.throws(
      () => workspace.autoRunner.v4WorkAssignmentText(
        plan, 'codex', 'inspect-reference', snapshot,
      ),
      { message: 'LOCAL_RUN_V4_ASSIGNMENT_REFERENCE_INVALID' },
      name,
    )
  }
})

test('V4 work-package budgeting preserves structural identity and truncates only free text', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  const targetKinds = ['codex', 'hermes']
  const plan = createCoordinationPlan({
    snapshotHash: 'c'.repeat(64),
    targetKinds,
    assignments: [
      {
        taskId: 'bounded-work', ownerKind: 'codex', role: 'worker',
        objective: `OBJECTIVE_${'o'.repeat(1900)}`,
        expectedOutput: `EXPECTED_${'e'.repeat(1900)}`,
        inputRefs: [], artifactIds: [], dependsOn: [],
      },
      {
        taskId: 'integrate-work', ownerKind: 'hermes', role: 'integrator',
        objective: 'Integrate.', expectedOutput: 'Delivery.',
        inputRefs: [], artifactIds: [], dependsOn: ['bounded-work'],
      },
    ],
    finalizerKind: 'hermes', verifierKinds: ['codex'], agreedBy: targetKinds,
  })

  const text = workspace.autoRunner.v4WorkAssignmentText(
    plan,
    'codex',
    'bounded-work',
    { messageId: 'current-message', taskText: 'Current task.', history: [] },
    700,
  )

  assert.ok(text.length <= 700)
  assert.match(text, new RegExp(`Responsibility plan: ${plan.planHash}`))
  assert.match(text, /^Work item: bounded-work$/m)
  assert.match(text, /^Owner: codex$/m)
  assert.match(text, /^Role: worker$/m)
  assert.match(text, /^Input refs: \(none\)$/m)
  assert.match(text, /^Artifact refs: \(none\)$/m)
  assert.match(text, /^Dependencies: \(none\)$/m)
  assert.match(text, /MELDWORK_V4_TRUNCATED_FREE_TEXT_V1/)
  assert.match(text, /objective reason=budget/)
  assert.match(text, /expectedOutput reason=budget/)
})

test('V4 work delivery fails closed when typed context exceeds the 6000-character envelope', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  const controller = {
    runId: 'run-delivery-boundary', taskId: 'task-delivery-boundary',
    orchestration: { deliveryState: [], snapshotHash: 'd'.repeat(64) },
  }
  const requiredPrefix = [
    'MELDWORK_V4_AGREED_WORK_PACKAGE_V1',
    'Work item: preserve-this-identity',
    'Owner: codex',
  ].join('\n')

  assert.throws(
    () => workspace.autoRunner.v4DeliveryPrompt(
      { id: 'group-delivery-boundary', name: 'Delivery boundary' },
      controller,
      {
        kind: 'codex', phase: 'work',
        snapshot: {
          taskId: 'task-delivery-boundary', messageId: 'message-delivery-boundary',
          targetKinds: ['codex', 'hermes'], taskText: 'Execute the work.',
          group: { name: 'Delivery boundary', topic: '' }, history: [],
        },
        receiptRecords: [], role: 'worker', targetKinds: ['codex', 'hermes'],
        slot: { slotId: 'slot-codex', operationId: 'operation-codex' },
        options: { extraContext: `${requiredPrefix}\n${'OPTIONAL_BODY '.repeat(700)}` },
        sessionBinding: {
          sessionRotated: false, hasSession: true,
          sessionRefHash: 'e'.repeat(64), sessionProvenanceHash: 'f'.repeat(64),
        },
      },
    ),
    { message: 'LOCAL_RUN_V4_DELIVERY_BUDGET_EXCEEDED' },
  )
})

test('V4 keeps a complete minimal 32-Agent responsibility graph within the delivery budget', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  const targetKinds = Array.from({ length: 32 }, (_value, index) => `agent-${String(index + 1).padStart(2, '0')}`)
  const plan = createCoordinationPlan({
    snapshotHash: 'a'.repeat(64),
    targetKinds,
    assignments: minimalAssignments(targetKinds),
    finalizerKind: targetKinds.at(-1),
    verifierKinds: targetKinds.slice(0, -1),
    agreedBy: targetKinds,
  })

  const text = workspace.autoRunner.v4CoordinationText({
    candidates: [plan],
    supportPlanHashes: [plan.planHash],
  })

  assert.match(text, /Fields: h=planHash/)
  assert.match(text, new RegExp(`"h":"${plan.planHash}"`))
  for (const assignment of plan.assignments) {
    assert.ok(text.includes(`"t":"${assignment.taskId}"`))
    assert.ok(text.includes(`"o":"${assignment.ownerKind}"`))
    assert.ok(text.includes(`"r":"${assignment.role}"`))
    assert.ok(text.includes('"x":"o"'))
    assert.ok(text.includes('"y":"e"'))
    assert.ok(text.includes('"i":[]'))
    assert.ok(text.includes('"a":[]'))
    assert.ok(text.includes('"d":[]'))
  }
  assert.ok(text.length <= 6000)
})

test('V4 preserves the complete 32-Agent package index when peer context has little remainder', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  const targetKinds = Array.from({ length: 32 }, (_value, index) => (
    `agent-${String(index + 1).padStart(2, '0')}-${'a'.repeat(108)}`
  ))
  const receiptRecords = targetKinds.map((agentKind, index) => ({
    receipt: createCollaborationReceipt({
      phase: 'proposal',
      agentKind,
      slotId: `slot-${String(index + 1).padStart(2, '0')}`,
      operationId: `operation-${String(index + 1).padStart(2, '0')}`,
      status: 'completed',
      summary: `Proposal ${index + 1}`,
      snapshotHash: 'a'.repeat(64),
      deliveryWatermark: 1,
    }),
  }))
  const partialCandidateHash = 'c'.repeat(64)
  const controller = {
    runId: 'run-delivery', taskId: 'task-delivery',
    orchestration: { deliveryState: [] },
  }
  const delivery = workspace.autoRunner.v4DeliveryPrompt(
    { id: 'group-delivery', name: 'Delivery budget' },
    controller,
    {
      kind: targetKinds[0],
      phase: 'challenge',
      snapshot: {
        taskId: 'task-delivery', messageId: 'message-delivery', targetKinds,
        taskText: 'Review the complete member index.', history: [],
      },
      receiptRecords,
      role: 'participant',
      targetKinds,
      slot: {
        slotId: 'slot-01', operationId: 'operation-01',
      },
      options: {
        assignedProposalText: 'Assigned proposal excerpt '.repeat(120),
        extraContext: `${'filler '.repeat(640)}\nMELDWORK_V4_RESPONSIBILITY_CANDIDATES_V1\nFields: h=planHash\n{"h":"${partialCandidateHash}","a":[{"t":"partial-task"`,
      },
      sessionBinding: {
        sessionRotated: false, hasSession: true,
        sessionRefHash: 'b'.repeat(64), sessionProvenanceHash: 'd'.repeat(64),
      },
    },
  )

  for (const agentKind of targetKinds) {
    assert.ok(delivery.prompt.includes(`[index] ${agentKind}`))
  }
  assert.doesNotMatch(delivery.prompt, new RegExp(partialCandidateHash))
  assert.equal(delivery.delivery, null)
  assert.deepEqual(controller.orchestration.deliveryState, [])
})

test('V4 structurally allocates downstream Artifact context inside the final 32-Agent envelope', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  const targetKinds = Array.from({ length: 32 }, (_value, index) => (
    `agent-${String(index + 1).padStart(2, '0')}-${'a'.repeat(108)}`
  ))
  const snapshotHash = 'a'.repeat(64)
  const artifacts = Array.from({ length: 4 }, (_value, index) => ({
    artifact: storeTextArtifact(
      workspace,
      `ARTIFACT_${index + 1}_START_${String(index + 1).repeat(2400)}_ARTIFACT_${index + 1}_TAIL`,
      `Downstream Artifact ${index + 1}`,
    ),
    tail: `ARTIFACT_${index + 1}_TAIL`,
  }))
  const workReceiptRecords = artifacts.map(({ artifact }, index) => ({
    receipt: createCollaborationReceipt({
      phase: 'work',
      agentKind: targetKinds[index],
      slotId: `slot-${index + 1}`,
      operationId: `operation-${index + 1}`,
      status: 'completed',
      summary: `Completed work item ${index + 1}.`,
      artifactIds: [artifact.artifactId],
      evidenceIds: [],
      workItemId: `work-${index + 1}`,
      snapshotHash,
      deliveryWatermark: index + 1,
    }),
  }))
  const synthesisReceiptRecords = [{
    receipt: createCollaborationReceipt({
      phase: 'synthesis',
      agentKind: targetKinds.at(-1),
      slotId: 'slot-synthesis',
      operationId: 'operation-synthesis',
      status: 'completed',
      summary: 'Completed synthesis.',
      artifactIds: artifacts.map(({ artifact }) => artifact.artifactId),
      evidenceIds: [],
      snapshotHash,
      deliveryWatermark: 1,
    }),
  }]
  const coordinationPlan = {
    assignments: artifacts.map((_artifact, index) => ({ taskId: `work-${index + 1}` })),
  }

  for (const { phase, receiptRecords, kind, role } of [
    {
      phase: 'synthesis',
      receiptRecords: workReceiptRecords,
      kind: targetKinds.at(-1),
      role: 'integrator',
    },
    {
      phase: 'verification',
      receiptRecords: synthesisReceiptRecords,
      kind: targetKinds[0],
      role: 'verifier',
    },
  ]) {
    const controller = {
      runId: `run-${phase}`,
      taskId: `task-${phase}`,
      orchestration: { deliveryState: [], snapshotHash },
    }
    const delivery = workspace.autoRunner.v4DeliveryPrompt(
      { id: `group-${phase}`, name: `${phase} delivery` },
      controller,
      {
        kind,
        phase,
        snapshot: {
          taskId: `task-${phase}`,
          messageId: `message-${phase}`,
          targetKinds,
          taskText: `Complete ${phase}.`,
          history: [],
        },
        receiptRecords,
        role,
        targetKinds,
        slot: { slotId: `slot-${phase}`, operationId: `operation-${phase}` },
        options: { artifactContext: { coordinationPlan } },
        sessionBinding: {
          sessionRotated: false,
          hasSession: true,
          sessionRefHash: 'b'.repeat(64),
          sessionProvenanceHash: 'c'.repeat(64),
        },
      },
    )
    const contextStart = delivery.prompt.indexOf('MELDWORK_V4_COLLABORATION_PACKAGE_V1')
    assert.notEqual(contextStart, -1)
    const boundedContext = delivery.prompt.slice(contextStart)

    assert.ok(boundedContext.length <= 6000)
    assert.match(boundedContext, /MELDWORK_V4_REFERENCED_ARTIFACTS_V1/)
    assert.match(boundedContext, /MELDWORK_V4_OMITTED_ARTIFACT_BODIES_V1/)
    assert.doesNotMatch(boundedContext, /MELDWORK_V4_CONTEXT_TRUNCATED_V1/)
    for (const { artifact } of artifacts) {
      assert.ok(boundedContext.includes(`Artifact ${artifact.artifactId} from `))
      assert.ok(boundedContext.includes(`${artifact.artifactId} reason=budget`))
    }
    assert.ok(artifacts.some(({ tail }) => !boundedContext.includes(tail)))
  }
})

test('V4 review receipts preserve all 64 reported Evidence refs with durable reviewer provenance', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  const reviewedArtifact = storeTextArtifact(workspace, 'REVIEWED_ARTIFACT_BODY')
  const evidenceIds = Array.from({ length: 64 }, (_value, index) => (
    workspace.outcomeStore.putEvidence({
      kind: 'observation',
      level: 'observed',
      subject: { type: 'artifact', artifactId: reviewedArtifact.artifactId },
      summary: `Reported review Evidence ${index + 1}.`,
      recordedBy: { kind: 'system', actorId: 'meldwork-main' },
      refs: [
        { type: 'artifact', artifactId: reviewedArtifact.artifactId },
        {
          type: 'blob',
          contentRef: reviewedArtifact.contentRef,
          contentHash: reviewedArtifact.contentHash,
        },
      ],
    }).evidenceId
  ))

  for (const phase of ['challenge', 'verification']) {
    const runId = `run-${phase}-evidence-boundary`
    const agentRunId = `agent-run-${phase}-evidence-boundary`
    const record = workspace.autoRunner.v4ReceiptForResult(
      {
        outcomeRefs: { evidenceIds },
        collaboration: {
          version: 1,
          phase,
          verdict: 'support',
          summary: `Supports the reviewed Artifact during ${phase}.`,
        },
        pendingMessage: { metadata: { trace: { runId, agentRunId } } },
      },
      phase,
      'codex',
      { slotId: `slot-${phase}`, operationId: `operation-${phase}`, deliveryWatermark: 0 },
      'a'.repeat(64),
      { controller: { runId }, reviewedArtifactId: reviewedArtifact.artifactId },
    )

    assert.deepEqual(record.receipt.evidenceIds, evidenceIds)
    assert.equal(record.receipt.findingIds.length, 1)
    const finding = workspace.outcomeStore.getReviewerFinding(record.receipt.findingIds[0])
    assert.equal(finding.evidenceIds.length, 1)
    assert.ok(!record.receipt.evidenceIds.includes(finding.evidenceIds[0]))
    assert.equal(workspace.autoRunner.v4ReviewFindings(
      { record, reviewedArtifactId: reviewedArtifact.artifactId },
      { runId },
    ).length, 1)

    const underCapacity = structuredClone(record)
    underCapacity.receipt.evidenceIds = evidenceIds.slice(0, 63)
    assert.throws(() => workspace.autoRunner.v4ReviewFindings(
      { record: underCapacity, reviewedArtifactId: reviewedArtifact.artifactId },
      { runId },
    ), { message: 'LOCAL_RUN_V4_REVIEW_FINDING_INVALID' })
  }

  const runId = 'run-review-generated-evidence'
  const generatedOnly = workspace.autoRunner.v4ReceiptForResult(
    {
      outcomeRefs: {},
      collaboration: {
        version: 1,
        phase: 'challenge',
        verdict: 'support',
        summary: 'Records generated reviewer Evidence when no refs were reported.',
      },
      pendingMessage: {
        metadata: { trace: { runId, agentRunId: 'agent-run-review-generated-evidence' } },
      },
    },
    'challenge',
    'codex',
    { slotId: 'slot-generated', operationId: 'operation-generated', deliveryWatermark: 0 },
    'b'.repeat(64),
    { controller: { runId }, reviewedArtifactId: reviewedArtifact.artifactId },
  )
  const generatedFinding = workspace.outcomeStore.getReviewerFinding(
    generatedOnly.receipt.findingIds[0],
  )
  assert.deepEqual(generatedOnly.receipt.evidenceIds, generatedFinding.evidenceIds)
})

test('V4 review validation requires reviewer-matched direct Artifact Evidence', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  const reviewedArtifact = storeTextArtifact(workspace, 'REVIEW_VALIDATION_ARTIFACT')
  const sourceEvidence = storeArtifactEvidence(workspace, reviewedArtifact)
  const reviewer = {
    kind: 'agent',
    runId: 'run-review-validation',
    agentRunId: 'agent-run-review-validation',
    agentKind: 'codex',
  }
  const directRefs = [
    { type: 'artifact', artifactId: reviewedArtifact.artifactId },
    {
      type: 'blob',
      contentRef: reviewedArtifact.contentRef,
      contentHash: reviewedArtifact.contentHash,
    },
  ]
  const invalidEvidence = [
    ['mismatched reviewer', workspace.outcomeStore.putEvidence({
      kind: 'review',
      level: 'observed',
      subject: { type: 'artifact', artifactId: reviewedArtifact.artifactId },
      summary: 'Recorded by a different Agent run.',
      recordedBy: { ...reviewer, agentRunId: 'agent-run-other-reviewer' },
      refs: directRefs,
    })],
    ['non-exact blob ref', workspace.outcomeStore.putEvidence({
      kind: 'review',
      level: 'observed',
      subject: { type: 'artifact', artifactId: reviewedArtifact.artifactId },
      summary: 'Uses different blob metadata for the reviewed Artifact.',
      recordedBy: reviewer,
      refs: [
        directRefs[0],
        {
          type: 'blob',
          contentRef: {
            ...reviewedArtifact.contentRef,
            mediaType: 'application/octet-stream',
          },
          contentHash: reviewedArtifact.contentHash,
        },
      ],
    })],
    ['indirect Evidence chain', workspace.outcomeStore.putEvidence({
      kind: 'review',
      level: 'observed',
      subject: { type: 'artifact', artifactId: reviewedArtifact.artifactId },
      summary: 'References supporting Evidence without direct Artifact and blob refs.',
      recordedBy: reviewer,
      refs: [{ type: 'evidence', evidenceId: sourceEvidence.evidenceId }],
    })],
  ]

  for (const [name, evidence] of invalidEvidence) {
    const finding = workspace.outcomeStore.putReviewerFinding({
      artifactId: reviewedArtifact.artifactId,
      relation: 'support',
      summary: `Invalid review binding: ${name}.`,
      reviewer,
      evidenceIds: [evidence.evidenceId],
    })
    const record = {
      receipt: createCollaborationReceipt({
        phase: 'challenge',
        agentKind: reviewer.agentKind,
        slotId: `slot-${name.replaceAll(' ', '-')}`,
        operationId: `operation-${name.replaceAll(' ', '-')}`,
        status: 'completed',
        summary: 'Review validation boundary.',
        artifactIds: [],
        evidenceIds: [evidence.evidenceId],
        findingIds: [finding.reviewerFindingId],
        snapshotHash: 'c'.repeat(64),
        deliveryWatermark: 1,
      }),
      verdict: 'support',
    }

    assert.throws(() => workspace.autoRunner.v4ReviewFindings(
      { record, reviewedArtifactId: reviewedArtifact.artifactId },
      { runId: reviewer.runId },
    ), { message: 'LOCAL_RUN_V4_REVIEW_FINDING_INVALID' }, name)
  }
})

test('V4 work admission rejects foreign reported Artifacts or Evidence as current output', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  const foreignArtifact = storeTextArtifact(workspace, 'FOREIGN_WORK_OUTPUT')
  const foreignEvidence = storeArtifactEvidence(workspace, foreignArtifact)
  const currentProducedBy = {
    runId: 'run-current-work',
    agentRunId: 'agent-run-current-work',
    agentKind: 'codex',
  }
  const currentArtifact = storeTextArtifact(
    workspace,
    'CURRENT_WORK_OUTPUT',
    'Current work output',
    currentProducedBy,
  )
  const currentEvidence = storeArtifactEvidence(workspace, currentArtifact)
  const currentAuxiliaryEvidence = workspace.outcomeStore.putEvidence({
    kind: 'observation',
    level: 'observed',
    subject: { type: 'artifact', artifactId: currentArtifact.artifactId },
    summary: 'The current Agent recorded supporting work context.',
    recordedBy: { kind: 'agent', ...currentProducedBy },
    refs: [{ type: 'artifact', artifactId: currentArtifact.artifactId }],
  })
  const snapshotHash = 'a'.repeat(64)
  const snapshotContentRef = workspace.contentBlobStore.put('Frozen snapshot.', {
    mediaType: 'text/plain',
  })
  const coordinationPlan = createCoordinationPlan({
    snapshotHash,
    targetKinds: ['codex', 'hermes'],
    assignments: [
      {
        taskId: 'codex-work', ownerKind: 'codex', role: 'worker',
        objective: 'Produce current work.', expectedOutput: 'A current Artifact.',
        inputRefs: [], artifactIds: [], dependsOn: [],
      },
      {
        taskId: 'hermes-work', ownerKind: 'hermes', role: 'integrator',
        objective: 'Integrate current work.', expectedOutput: 'An integrated Artifact.',
        inputRefs: [], artifactIds: [], dependsOn: ['codex-work'],
      },
    ],
    finalizerKind: 'hermes',
    verifierKinds: ['codex'],
    agreedBy: ['codex', 'hermes'],
  })
  const admit = (producedOutcomeRefs, acceptance = null) => {
    const activePlan = acceptance ? createCoordinationPlan({ ...coordinationPlan, targetKinds: ['codex', 'hermes'],
      assignments: coordinationPlan.assignments.map(item => item.taskId === 'codex-work' ? { ...item, acceptance } : item) }) : coordinationPlan
    const slot = {
      agentKind: 'codex',
      slotId: 'slot-codex',
      operationId: 'operation-codex',
      status: 'running',
      workDependencyBinding: { taskId: 'codex-work', dependencyWorkReceiptIds: [] },
      deliveryWatermark: 0,
      resultRefs: { artifactIds: [], evidenceIds: [], workflowOutcomeRefs: [] },
    }
    const controller = {
      runId: currentProducedBy.runId,
      signal: new AbortController().signal,
      orchestration: {
        phase: 'work',
        slots: [{ ...slot }],
        workReceipts: [],
      },
    }
    const result = {
      collaboration: {
        version: 1,
        phase: 'work',
        summary: 'Claims the supplied refs as current work.',
        workItemId: 'codex-work',
        deliverables: ['A work Artifact.'],
      },
      outcomeRefs: producedOutcomeRefs,
      producedOutcomeRefs,
      pendingMessage: {
        metadata: {
          trace: {
            runId: controller.runId,
            agentRunId: currentProducedBy.agentRunId,
            context: { operationId: slot.operationId },
          },
        },
      },
    }
    return workspace.autoRunner.v4AdmitWorkSettlement(
      { id: 'group-current-work' },
      controller,
      'thread-current-work',
      { kind: 'codex', invocation: { result }, dispatchedDependencies: [] },
      {
        targetKinds: ['codex', 'hermes'],
        writerKind: 'hermes',
        batchId: 'batch-current-work',
        snapshotRecord: {
          bodyHash: snapshotContentRef.hash,
          contentRef: snapshotContentRef,
        },
        snapshotHash,
        phaseSlots: [slot],
        receiptRecords: [],
        challengeBindings: [],
        coordinationPlan: activePlan,
        workReceipts: [],
        phaseReceipts: [],
        workAssignments: [activePlan.assignments.find(item => item.ownerKind === 'codex')],
      },
    )
  }
  workspace.autoRunner.recordAgentFailure = () => {}
  workspace.autoRunner.v4CheckpointPhase = () => {}

  for (const producedOutcomeRefs of [
    {
      artifactIds: [foreignArtifact.artifactId],
      evidenceIds: [foreignEvidence.evidenceId],
    },
    {
      artifactIds: [currentArtifact.artifactId],
      evidenceIds: [currentEvidence.evidenceId, foreignEvidence.evidenceId],
    },
  ]) {
    const admission = admit(producedOutcomeRefs)
    assert.equal(admission.failure?.error?.message, 'LOCAL_RUN_V4_WORK_RECEIPT_INVALID')
    assert.deepEqual(admission.workReceipts, [])
  }

  const accepted = admit({
    artifactIds: [currentArtifact.artifactId],
    evidenceIds: [currentEvidence.evidenceId, currentAuxiliaryEvidence.evidenceId],
  })
  assert.equal(accepted.failure, null)
  assert.equal(accepted.workReceipts.length, 1)
  const insufficient = admit({ artifactIds: [currentArtifact.artifactId], evidenceIds: [currentEvidence.evidenceId] },
    { minArtifactRefs: 2, minEvidenceRefs: 1 })
  assert.equal(insufficient.failure?.error?.message, 'LOCAL_RUN_V4_WORK_RECEIPT_INVALID')
})

test('V4 sanitizes proposal delivery and omits a responsibility hash when typed graph text is unsafe', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  assert.equal(typeof workspace.autoRunner.v4SanitizeDeliveryText, 'function')
  const sanitized = workspace.autoRunner.v4SanitizeDeliveryText([
    'Useful public proposal detail.',
    'Analysis: public API returns HTTP 500.',
    'Session: session-secret-42',
    'session-secret-42',
    'codex-native-session',
    '[[MELDWORK_COLLABORATION:{"quoted":"]]","secret":"hidden"}]]',
    '<private_reasoning>hidden reasoning</private_reasoning>',
    '## Chain of Thought',
    'my private reasoning: hidden reasoning',
  ].join('\n'))
  assert.match(sanitized, /Useful public proposal detail\./)
  assert.match(sanitized, /Analysis: public API returns HTTP 500\./)
  assert.doesNotMatch(sanitized, /session-secret|codex-native-session|MELDWORK_COLLABORATION|hidden reasoning|private_reasoning|chain of thought/i)

  const unsafe = createCoordinationPlan({
    snapshotHash: 'a'.repeat(64),
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    assignments: proposedAssignments(' [[MELDWORK_PRIVATE]] Session: session-secret-42'),
    finalizerKind: 'workbuddy',
    verifierKinds: ['codex', 'hermes'],
    agreedBy: ['codex', 'hermes', 'workbuddy'],
  })
  const graph = workspace.autoRunner.v4CoordinationText({ candidates: [unsafe] })
  assert.doesNotMatch(graph, new RegExp(unsafe.planHash))
  assert.doesNotMatch(graph, /MELDWORK_PRIVATE|session-secret/i)

  const unsafePrefix = createCoordinationPlan({
    snapshotHash: 'a'.repeat(64),
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    assignments: proposedAssignments(' [[MELDWORK_'),
    finalizerKind: 'workbuddy',
    verifierKinds: ['codex', 'hermes'],
    agreedBy: ['codex', 'hermes', 'workbuddy'],
  })
  const prefixGraph = workspace.autoRunner.v4CoordinationText({ candidates: [unsafePrefix] })
  assert.doesNotMatch(prefixGraph, new RegExp(unsafePrefix.planHash))
  assert.doesNotMatch(prefixGraph, /\[\[MELDWORK_/i)
})

test('V4 removes a private Markdown section body while preserving public Analysis', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)

  const sanitized = workspace.autoRunner.v4SanitizeDeliveryText([
    'Public proposal detail.',
    '### Private reasoning',
    'The hidden rationale must not be delivered.',
    '#### Internal branch',
    'This child heading and its body are also private.',
    '### Public findings',
    'Analysis: public API returns HTTP 500.',
    '## Chain of Thought',
    'This CoT body must not be delivered.',
    '# Published conclusion',
    'Public conclusion.',
  ].join('\n'))

  assert.match(sanitized, /Public proposal detail\./)
  assert.match(sanitized, /### Public findings/)
  assert.match(sanitized, /Analysis: public API returns HTTP 500\./)
  assert.match(sanitized, /# Published conclusion/)
  assert.match(sanitized, /Public conclusion\./)
  assert.doesNotMatch(sanitized, /hidden rationale|internal branch|also private|private reasoning|CoT body|chain of thought/i)
})

test('V4 preserves the outer private Markdown section boundary across nested private headings', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)

  const sanitized = workspace.autoRunner.v4SanitizeDeliveryText([
    '## Private reasoning',
    'outer secret',
    '#### Chain of Thought',
    'nested secret',
    '### Still inside the outer private section',
    'THIS_MUST_NOT_LEAK',
    '## Public findings',
    'Analysis: public API returns HTTP 500.',
  ].join('\n'))

  assert.equal(sanitized, [
    '## Public findings',
    'Analysis: public API returns HTTP 500.',
  ].join('\n'))
})

test('V4 omits an oversized responsibility candidate rather than exposing a partial plan hash', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  const targetKinds = ['codex', 'hermes', 'workbuddy']
  const snapshotHash = 'a'.repeat(64)
  const complete = createCoordinationPlan({
    snapshotHash,
    targetKinds,
    assignments: proposedAssignments(),
    finalizerKind: 'workbuddy',
    verifierKinds: ['codex', 'hermes'],
    agreedBy: targetKinds,
  })
  const oversized = createCoordinationPlan({
    snapshotHash,
    targetKinds,
    assignments: proposedAssignments(' '.concat('oversized detail '.repeat(90))),
    finalizerKind: 'workbuddy',
    verifierKinds: ['codex', 'hermes'],
    agreedBy: targetKinds,
  })

  const text = workspace.autoRunner.v4CoordinationText({
    candidates: [complete, oversized],
    supportPlanHashes: [complete.planHash],
  }, 1800)

  assert.match(text, new RegExp(complete.planHash))
  assert.doesNotMatch(text, new RegExp(oversized.planHash))
  assert.match(text, /"y":"An evidence-backed findings Artifact\."/)
  assert.match(text, /"i":\[\]/)
  assert.match(text, /"a":\[\]/)
  assert.ok(text.length <= 1800)
})

test('V4 lets Agents negotiate responsibilities, execute every work package, and honor agreed delivery roles', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runLedger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger-agent-negotiation.json'),
  })
  const calls = []
  const challengeCounts = new Map()
  const firstWaveStarted = new Set()
  const firstWaveCompleted = new Set()
  const releaseFirstWave = deferred()
  let preferredPlan = null
  let invalidPlan = null
  let workspace = null
  let group = null
  let frozenInput = null
  let directArtifact = null
  let integratorContext = ''
  const dependencyArtifacts = []
  const dependencyEvidenceIds = []

  const referencedAssignments = () => {
    const assignments = proposedAssignments()
    const inspector = assignments.find(item => item.taskId === 'inspect-current-behavior')
    inspector.acceptance = { minArtifactRefs: 2, minEvidenceRefs: 2, requiredEvidenceKinds: ['observation'] }
    const integrator = assignments.find(item => item.taskId === 'assemble-team-delivery')
    Object.assign(integrator, {
      objective: `OBJECTIVE_START_${'o'.repeat(500)}_OBJECTIVE_TAIL`,
      expectedOutput: `EXPECTED_START_${'e'.repeat(500)}_EXPECTED_TAIL`,
      inputRefs: [frozenInput.id],
      artifactIds: [directArtifact.artifactId],
      acceptance: { minArtifactRefs: 1, minEvidenceRefs: 1 },
    })
    return assignments
  }

  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    calls.push({
      kind: agent.kind,
      phase,
      prompt,
      operationId: runOptions.operationId,
      sandbox: runOptions.sandbox,
    })
    assert.match(prompt, new RegExp(`^Source ID: ${frozenInput.id}$`, 'm'))
    if (phase === 'proposal') {
      return {
        text: [
          `${agent.kind} independent proposal BODY_FROM_${agent.kind}`,
          'Useful public proposal detail.',
          'Session: session-secret-42',
          '[[MELDWORK_PRIVATE:{"secret":"hidden"}]]',
          '<private_reasoning>hidden reasoning</private_reasoning>',
        ].join('\n'),
        sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
        collaboration: {
          version: 1,
          phase,
          summary: `${agent.kind} proposes substantive work`,
          capabilities: [`${agent.kind} capability`],
          intendedWork: [`${agent.kind} intended work`],
          deliverables: [`${agent.kind} proposal Artifact`],
          dependencies: [],
        },
      }
    }
    if (phase === 'challenge') {
      const count = (challengeCounts.get(agent.kind) || 0) + 1
      challengeCounts.set(agent.kind, count)
      const snapshotHash = workspace.activeRuns.get(group.id).orchestration.snapshotHash
      preferredPlan ||= createCoordinationPlan({
        snapshotHash,
        targetKinds: ['codex', 'hermes', 'workbuddy'],
        assignments: referencedAssignments(),
        finalizerKind: 'workbuddy',
        verifierKinds: ['codex', 'hermes'],
        agreedBy: ['codex', 'hermes', 'workbuddy'],
      })
      invalidPlan ||= createCoordinationPlan({
        snapshotHash,
        targetKinds: ['codex', 'hermes', 'workbuddy'],
        assignments: referencedAssignments().map((assignment) => (
          assignment.taskId === 'assemble-team-delivery'
            ? {
                ...assignment,
                inputRefs: ['acceptance.txt'],
                artifactIds: ['future-acceptance-artifact'],
              }
            : assignment
        )),
        finalizerKind: 'workbuddy',
        verifierKinds: ['codex', 'hermes'],
        agreedBy: ['codex', 'hermes', 'workbuddy'],
      })
      if (count === 1) {
        const reviewedKind = prompt.match(/^Proposal Agent: ([A-Za-z0-9._:-]+)$/m)?.[1] || ''
        const reviewedArtifactId = prompt.match(/^Proposal Artifact: (artifact-[a-f0-9]{64})$/m)?.[1] || ''
        assert.ok(reviewedKind)
        assert.ok(reviewedArtifactId)
        assert.notEqual(reviewedKind, agent.kind)
        assert.match(prompt, new RegExp(`BODY_FROM_${reviewedKind}`))
        assert.match(prompt, /Useful public proposal detail\./)
        assert.match(prompt, /exactly 2 distinct verifierKinds/)
        assert.doesNotMatch(prompt, /session-secret|MELDWORK_PRIVATE|hidden reasoning|private_reasoning/i)
        assert.match(prompt, /inputRefs are exact displayed frozen Source IDs/)
        assert.match(prompt, /artifactIds are existing immutable Artifact IDs/)
        assert.match(prompt, /future outputs flow only through dependsOn/)
        return {
          text: `${agent.kind} responsibility proposal`,
          sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
          collaboration: {
            version: 1,
            phase,
            verdict: 'support',
            summary: `${agent.kind} proposes a responsibility graph`,
            proposedAssignments: invalidPlan.assignments,
            finalizerKind: 'workbuddy',
            verifierKinds: ['codex', 'hermes'],
            agreeToPlan: true,
          },
        }
      }
      assert.doesNotMatch(prompt, new RegExp(invalidPlan.planHash))
      return {
        text: `${agent.kind} supports a corrected responsibility graph`,
        sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
        collaboration: {
          version: 1,
          phase,
          verdict: 'support',
          summary: `${agent.kind} supports the corrected responsibility graph`,
          proposedAssignments: preferredPlan.assignments,
          finalizerKind: 'workbuddy',
          verifierKinds: ['codex', 'hermes'],
          agreeToPlan: true,
        },
      }
    }
    if (phase === 'work') {
      assert.deepEqual([...challengeCounts.entries()].sort(), [
        ['codex', 2], ['hermes', 2], ['workbuddy', 2],
      ])
      const workItemId = prompt.match(/^Work item: ([A-Za-z0-9._:-]+)$/m)?.[1] || ''
      assert.ok(workItemId)
      if (['inspect-current-behavior', 'implement-bounded-change'].includes(workItemId)) {
        if (workItemId === 'inspect-current-behavior') {
          assert.match(prompt, /Required Artifact refs: 2; Evidence refs: 2/)
          assert.match(prompt, /Required Evidence kinds: observation/)
        }
        firstWaveStarted.add(agent.kind)
        if (firstWaveStarted.size === 2) releaseFirstWave.resolve()
        await releaseFirstWave.promise
        firstWaveCompleted.add(agent.kind)
      } else if (workItemId === 'verify-bounded-change') {
        assert.equal(agent.kind, 'hermes')
        assert.deepEqual([...firstWaveCompleted].sort(), ['codex', 'hermes'])
        assert.match(prompt, /implement-bounded-change/)
      } else {
        assert.equal(agent.kind, 'workbuddy')
        assert.deepEqual([...firstWaveCompleted].sort(), ['codex', 'hermes'])
        assert.match(prompt, /inspect-current-behavior/)
        assert.match(prompt, /verify-bounded-change/)
        const contextStart = prompt.indexOf('MELDWORK_V4_AGREED_WORK_PACKAGE_V1')
        assert.notEqual(contextStart, -1)
        integratorContext = prompt.slice(contextStart)
        assert.ok(integratorContext.length <= 6000)
        assert.match(integratorContext, new RegExp(`Responsibility plan: ${preferredPlan.planHash}`))
        assert.match(integratorContext, /^Work item: assemble-team-delivery$/m)
        assert.match(integratorContext, /^Owner: workbuddy$/m)
        assert.match(integratorContext, /^Role: integrator$/m)
        assert.match(integratorContext, new RegExp(`^Input refs: ${frozenInput.id}$`, 'm'))
        assert.match(integratorContext, new RegExp(`^Input ${frozenInput.id}:$`, 'm'))
        assert.match(integratorContext, new RegExp(
          `^Artifact refs: ${directArtifact.artifactId}$`, 'm',
        ))
        assert.match(integratorContext, new RegExp(`^Artifact ${directArtifact.artifactId}:$`, 'm'))
        assert.match(integratorContext, /^Dependencies: inspect-current-behavior, verify-bounded-change$/m)
        for (const artifact of dependencyArtifacts) {
          assert.match(integratorContext, new RegExp(artifact.artifactId))
        }
        assert.match(integratorContext, /MELDWORK_V4_TRUNCATED_FREE_TEXT_V1/)
        assert.match(integratorContext, /MELDWORK_V4_OMITTED_DIRECT_REFERENCE_BODIES_V1/)
        assert.match(integratorContext, /MELDWORK_V4_OMITTED_ARTIFACT_BODIES_V1/)
        assert.doesNotMatch(integratorContext, /MELDWORK_V4_CONTEXT_TRUNCATED_V1/)
        assert.doesNotMatch(integratorContext, /OBJECTIVE_TAIL|EXPECTED_TAIL/)
        assert.doesNotMatch(integratorContext, /FROZEN_INPUT_TAIL|DIRECT_ARTIFACT_TAIL/)
      }
      const result = {
        text: `${agent.kind} completed ${workItemId}`,
        sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
        collaboration: {
          version: 1,
          phase,
          summary: `${agent.kind} completed its agreed work package`,
          workItemId,
          deliverables: [`${agent.kind} work Artifact`],
        },
      }
      if (workItemId === 'inspect-current-behavior') {
        if (!dependencyArtifacts.length) {
          const activeController = workspace.activeRuns.get(group.id)
          const harnessRun = activeController?.harness?.current(
            agent.kind, activeController.currentRound,
          )
          assert.ok(harnessRun)
          const producedBy = {
            runId: activeController.runId,
            agentRunId: harnessRun.agentRunId,
            agentKind: agent.kind,
          }
          dependencyArtifacts.push(
            storeTextArtifact(
              workspace,
              `DEPENDENCY_ONE_START_${'a'.repeat(1500)}_DEPENDENCY_ONE_TAIL`,
              'First dependency Artifact',
              producedBy,
            ),
            storeTextArtifact(
              workspace,
              `DEPENDENCY_TWO_START_${'b'.repeat(1500)}_DEPENDENCY_TWO_TAIL`,
              'Second dependency Artifact',
              producedBy,
            ),
          )
          dependencyEvidenceIds.push(...dependencyArtifacts.map(
            artifact => storeArtifactEvidence(workspace, artifact, {
              kind: 'agent',
              ...producedBy,
            }).evidenceId,
          ))
        }
        result.outcomeRefs = {
          artifactIds: dependencyArtifacts.map(artifact => artifact.artifactId),
          evidenceIds: dependencyEvidenceIds,
        }
      }
      return result
    }
    if (phase === 'synthesis') {
      assert.equal(agent.kind, 'workbuddy')
      assert.match(prompt, /codex completed inspect-current-behavior/)
      assert.match(prompt, /hermes completed implement-bounded-change/)
      assert.match(prompt, /hermes completed verify-bounded-change/)
      assert.match(prompt, /workbuddy completed assemble-team-delivery/)
      return {
        text: 'Final delivery assembled from all agreed work products.',
        sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
        collaboration: {
          version: 1,
          phase,
          summary: 'WorkBuddy assembled the agreed team delivery.',
          resolvedIssueIds: [],
        },
      }
    }
    assert.equal(phase, 'verification')
    assert.ok(['codex', 'hermes'].includes(agent.kind))
    return {
      text: `${agent.kind} independently verified the final delivery`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
      collaboration: {
        version: 1,
        phase,
        verdict: 'support',
        summary: `${agent.kind} independently supports the final delivery`,
      },
    }
  }

  workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  group = workspace.createGroup({
    name: 'Agent-negotiated responsibilities',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: false,
  })
  frozenInput = workspace.addMessage(
    group.id,
    'user',
    `FROZEN_INPUT_START_${'f'.repeat(1700)}_FROZEN_INPUT_TAIL`,
  )
  directArtifact = storeTextArtifact(
    workspace,
    `DIRECT_ARTIFACT_START_${'d'.repeat(1700)}_DIRECT_ARTIFACT_TAIL`,
    'Direct negotiated Artifact',
  )
  workspace.autoRunner.v4SynthesisBinding = () => {
    throw new Error('HARNESS_ALLOCATOR_MUST_NOT_RUN')
  }

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Inspect, implement, integrate, and independently verify this task as a team.',
    mode: 'auto',
    maxRounds: 4,
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    protocol: 'v4',
  })
  const controller = workspace.activeRuns.get(group.id)
  await controller.promise

  assert.equal(controller.orchestration.phase, 'completed', JSON.stringify({
    stopReason: controller.stopReason,
    slots: controller.orchestration.slots.map(slot => ({
      agentKind: slot.agentKind,
      phase: slot.phase,
      status: slot.status,
    })),
    calls: calls.map(call => ({ kind: call.kind, phase: call.phase })),
    messages: workspace.snapshot().messages.map(message => ({
      role: message.role,
      agentKind: message.agentKind,
      content: message.content,
    })),
  }, null, 2))
  assert.deepEqual([...challengeCounts.entries()].sort(), [
    ['codex', 2], ['hermes', 2], ['workbuddy', 2],
  ])
  assert.ok(integratorContext)
  assert.match(integratorContext, /Required Artifact refs: 1; Evidence refs: 1/)
  const persistedPlan = controller.orchestration.coordinationPlan
  const { supportReceiptIds, ...persistedGraph } = persistedPlan
  assert.deepEqual(persistedGraph, preferredPlan)
  assert.equal(supportReceiptIds.length, 3)
  assert.deepEqual(supportReceiptIds, [...supportReceiptIds].sort())
  const workReceipts = controller.orchestration.workReceipts
  for (const assignment of preferredPlan.assignments) {
    const receipt = workReceipts.find(item => item.taskId === assignment.taskId)
    const dependencies = assignment.dependsOn.map(id => workReceipts.find(item => item.taskId === id).workReceiptId).sort()
    assert.deepEqual(receipt.dependencyWorkReceiptIds, dependencies)
    if (assignment.taskId === 'inspect-current-behavior') {
      assert.ok(receipt.collaborationReceipt.artifactIds.length >= 2)
      assert.ok(receipt.collaborationReceipt.evidenceIds.length >= 2)
    }
  }
  assert.deepEqual(
    calls.filter(call => call.phase === 'work').map(call => call.kind).sort(),
    ['codex', 'hermes', 'hermes', 'workbuddy'],
  )
  for (const call of calls.filter(item => item.phase === 'work')) {
    const workItemId = call.prompt.match(/^Work item: ([A-Za-z0-9._:-]+)$/m)?.[1] || ''
    const assignment = preferredPlan.assignments.find(item => item.taskId === workItemId)
    assert.match(call.prompt, new RegExp(`Role: ${assignment.role}`))
  }
  assert.equal(new Set(
    calls.filter(call => call.phase === 'work').map(call => call.operationId),
  ).size, 4)
  assert.deepEqual(
    calls.filter(call => call.phase === 'synthesis').map(call => call.kind),
    ['workbuddy', 'workbuddy'],
  )
  assert.match(calls.find(call => call.phase === 'synthesis').prompt, /Role: integrator/)
  assert.equal(calls.find(call => call.phase === 'synthesis').sandbox, 'read-only')
  assert.deepEqual(
    calls.filter(call => call.phase === 'verification').map(call => call.kind).sort(),
    ['codex', 'codex', 'hermes', 'hermes'],
  )
  const finalEntry = controller.orchestration.collaboration.entries.at(-1)
  assert.equal(finalEntry.owner.agentKind, preferredPlan.finalizerKind)
  assert.equal(finalEntry.owner.role, 'integrator')
  assert.deepEqual(finalEntry.audience.agentKinds, [...new Set(
    preferredPlan.assignments.map(item => item.ownerKind),
  )].sort())
  assert.deepEqual(finalEntry.audience.roles, [])
  assert.equal(
    controller.orchestration.slots.find(slot => slot.agentKind === preferredPlan.finalizerKind).permission,
    'read-only',
  )
  const visibleAgentMessages = workspace.snapshot().messages.filter(message => message.role === 'agent')
  assert.deepEqual(
    visibleAgentMessages.slice(0, 3).map(message => message.agentKind),
    ['codex', 'hermes', 'workbuddy'],
  )
  for (const message of visibleAgentMessages.slice(0, 3)) {
    assert.match(message.content, new RegExp(`^${message.agentKind} independent proposal BODY_FROM_${message.agentKind}`))
  }
  assert.deepEqual(
    visibleAgentMessages.slice(3, 6).map(message => message.content),
    [
      'codex responsibility proposal',
      'hermes responsibility proposal',
      'workbuddy responsibility proposal',
    ],
  )
  assert.deepEqual(
    visibleAgentMessages.slice(6, 9).map(message => message.content),
    [
      'codex supports a corrected responsibility graph',
      'hermes supports a corrected responsibility graph',
      'workbuddy supports a corrected responsibility graph',
    ],
  )
  assert.deepEqual(
    visibleAgentMessages.slice(9).map(message => message.content),
    ['Final delivery assembled from all agreed work products.'],
  )
  assert.equal(new Set(visibleAgentMessages.map(message => message.id)).size, 10)
})

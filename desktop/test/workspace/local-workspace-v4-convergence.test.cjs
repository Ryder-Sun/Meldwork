const test = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { ContentBlobStore } = require('../../src/attachments/content-blob-store.cjs')
const {
  createCollaborationReceipt,
} = require('../../src/collaboration/orchestration-v4-records.cjs')
const { OutcomeStore } = require('../../src/collaboration/outcome-store.cjs')
const { RunLedger } = require('../../src/runs/run-ledger.cjs')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { LocalWorkspaceAutoRunner } = require('../../src/workspace/local-workspace-auto-runner.cjs')
const { fixture: workspaceFixture } = require('../support/local-workspace-test-helpers.cjs')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-v4-convergence-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const contentBlobStore = new ContentBlobStore({
    rootPath: path.join(directory, 'content-blobs'),
  })
  const outcomeStore = new OutcomeStore({
    rootPath: path.join(directory, 'outcomes'),
    contentBlobStore,
  })
  const runner = new LocalWorkspaceAutoRunner({ outcomeStore })
  return { contentBlobStore, directory, outcomeStore, runner }
}

function storedOutput(fixtureValue, content, producer = {}) {
  const producedBy = {
    runId: producer.runId || 'run-v4',
    agentRunId: producer.agentRunId || 'agent-run-v4',
    agentKind: producer.agentKind || 'codex',
  }
  const contentRef = fixtureValue.contentBlobStore.put(content, { mediaType: 'text/plain' })
  const artifact = fixtureValue.outcomeStore.putArtifact({
    type: 'document',
    name: 'candidate.txt',
    producedBy,
    contentRef,
    contentHash: contentRef.hash,
  })
  const evidence = fixtureValue.outcomeStore.putEvidence({
    kind: 'observation',
    level: 'observed',
    subject: { type: 'artifact', artifactId: artifact.artifactId },
    summary: 'Meldwork captured the concrete Agent output.',
    recordedBy: { kind: 'system', actorId: 'meldwork-main' },
    refs: [
      { type: 'artifact', artifactId: artifact.artifactId },
      { type: 'blob', contentRef, contentHash: contentRef.hash },
    ],
  })
  return { artifact, evidence }
}

test('candidate evidence binds the exact artifact content reference', t => {
  const value = fixture(t)
  const output = storedOutput(value, 'Same bytes, different media type.')
  const alternateRef = value.contentBlobStore.put('Same bytes, different media type.', {
    mediaType: 'application/json',
  })
  const unrelated = value.outcomeStore.putEvidence({
    kind: 'observation', level: 'observed',
    subject: { type: 'artifact', artifactId: output.artifact.artifactId },
    summary: 'An observation with a different content reference.',
    recordedBy: { kind: 'system', actorId: 'meldwork-outcome-recorder' },
    refs: [{ type: 'blob', contentRef: alternateRef, contentHash: alternateRef.hash }],
  })
  assert.equal(value.runner.v4EvidenceSupportsArtifact(
    unrelated.evidenceId, output.artifact.artifactId, output.artifact.contentHash,
  ), false)
  assert.equal(value.runner.v4EvidenceSupportsArtifact(
    output.evidence.evidenceId, output.artifact.artifactId, output.artifact.contentHash,
  ), true)
})

function receiptRecord({
  phase,
  agentKind,
  operationId,
  output,
  snapshotHash = 'a'.repeat(64),
  verdict = '',
  findingIds = [],
  evidenceIds = null,
  resolvedIssueIds = [],
  conclusion = '',
}) {
  return {
    receipt: createCollaborationReceipt({
      phase,
      agentKind,
      slotId: `slot-${agentKind}`,
      operationId,
      status: 'completed',
      summary: `${agentKind} ${phase}`,
      conclusion,
      artifactIds: output ? [output.artifact.artifactId] : [],
      evidenceIds: evidenceIds || (output ? [output.evidence.evidenceId] : []),
      findingIds,
      snapshotHash,
      deliveryWatermark: 1,
    }),
    verdict,
    resolvedIssueIds,
  }
}

function finding(fixtureValue, output, overrides = {}) {
  return fixtureValue.outcomeStore.putReviewerFinding({
    artifactId: output.artifact.artifactId,
    relation: overrides.relation || 'support',
    summary: overrides.summary || 'The review is bound to the stored candidate.',
    reviewer: {
      kind: 'agent',
      runId: overrides.runId || 'run-v4',
      agentRunId: overrides.agentRunId || 'agent-run-review',
      agentKind: overrides.agentKind || 'hermes',
    },
    evidenceIds: overrides.evidenceIds || [output.evidence.evidenceId],
  })
}

function boundFinding(fixtureValue, output, overrides = {}) {
  const reviewer = {
    kind: 'agent',
    runId: overrides.runId || 'run-v4',
    agentRunId: overrides.agentRunId || 'agent-run-review',
    agentKind: overrides.agentKind || 'hermes',
  }
  const sourceEvidenceIds = overrides.sourceEvidenceIds || [output.evidence.evidenceId]
  const evidence = fixtureValue.outcomeStore.putEvidence({
    kind: 'review',
    level: 'observed',
    subject: { type: 'artifact', artifactId: output.artifact.artifactId },
    summary: overrides.summary || 'The review is bound to the stored candidate.',
    recordedBy: reviewer,
    refs: [
      { type: 'artifact', artifactId: output.artifact.artifactId },
      {
        type: 'blob',
        contentRef: output.artifact.contentRef,
        contentHash: output.artifact.contentHash,
      },
      ...sourceEvidenceIds.map(evidenceId => ({ type: 'evidence', evidenceId })),
    ],
  })
  return finding(fixtureValue, output, {
    ...overrides,
    evidenceIds: [evidence.evidenceId],
  })
}

function reviewEvidenceBoundary(fixtureValue, reviewedOutput, label) {
  return Array.from({ length: 64 }, (_value, index) => fixtureValue.outcomeStore.putEvidence({
    kind: 'observation',
    level: 'observed',
    subject: {
      type: 'artifact',
      artifactId: reviewedOutput.artifact.artifactId,
    },
    summary: `${label} reported Evidence ${index + 1}.`,
    recordedBy: { kind: 'system', actorId: 'meldwork-main' },
    refs: [
      { type: 'artifact', artifactId: reviewedOutput.artifact.artifactId },
      {
        type: 'blob',
        contentRef: reviewedOutput.artifact.contentRef,
        contentHash: reviewedOutput.artifact.contentHash,
      },
    ],
  }).evidenceId)
}

function outcomeRecordPath(value, category, id) {
  const hash = id.slice(id.lastIndexOf('-') + 1)
  return path.join(value.directory, 'outcomes', category, hash.slice(0, 2), `${id}.json`)
}

function carriedIssueFixture(t) {
  const value = fixture(t)
  const reviewed = storedOutput(value, 'Reviewed prior candidate.', { agentKind: 'codex' })
  const challengeOutput = storedOutput(value, 'Prior contradiction.', { agentKind: 'hermes' })
  const contradiction = boundFinding(value, reviewed, {
    relation: 'contradict',
    agentKind: 'hermes',
    summary: 'The prior candidate omits a required rollback.',
    sourceEvidenceIds: [challengeOutput.evidence.evidenceId],
  })
  const review = receiptRecord({
    phase: 'challenge',
    agentKind: 'hermes',
    operationId: 'operation-prior-challenge-hermes',
    output: challengeOutput,
    verdict: 'contradict',
    findingIds: [contradiction.reviewerFindingId],
    evidenceIds: [challengeOutput.evidence.evidenceId, ...contradiction.evidenceIds],
  })
  const issue = value.runner.v4IssuesFromReviews([
    { record: review, reviewedArtifactId: reviewed.artifact.artifactId },
  ], { runId: 'run-v4' })[0]
  const candidate = storedOutput(value, 'Current synthesis.', { agentKind: 'codex' })
  const synthesis = receiptRecord({
    phase: 'synthesis',
    agentKind: 'codex',
    operationId: 'operation-current-synthesis-codex',
    output: candidate,
  })
  const options = {
    runId: 'run-v4',
    slots: [{
      agentKind: 'codex',
      phase: 'synthesis',
      operationId: 'operation-current-synthesis-codex',
      status: 'completed',
    }],
    challengeBindings: [],
    previousConvergence: { openIssueIds: [issue.id] },
  }
  const records = [review, synthesis]
  const roundState = (overrides = {}) => {
    const { receiptRecords = records, ...optionOverrides } = overrides
    return value.runner.v4RoundState(
      structuredClone(receiptRecords), ['codex'], 'codex', [], {
        ...options,
        ...optionOverrides,
      },
    )
  }
  return { candidate, contradiction, issue, records, review, roundState, value }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

test('V4 derives fallback contradiction IDs from durable Reviewer Findings', (t) => {
  const value = fixture(t)
  const reviewed = storedOutput(value, 'Independent proposal.', { agentKind: 'codex' })
  const challenge = storedOutput(value, 'Contradictory review.', {
    runId: 'run-v4', agentRunId: 'agent-run-challenge', agentKind: 'hermes',
  })
  const record = value.runner.v4ReceiptForResult({
    collaboration: {
      version: 1,
      phase: 'challenge',
      verdict: 'contradict',
      summary: 'The proposal omits a deterministic reconciliation step.',
    },
    pendingMessage: { metadata: { trace: { agentRunId: 'agent-run-challenge' } } },
    outcomeRefs: {
      artifactIds: [challenge.artifact.artifactId],
      evidenceIds: [challenge.evidence.evidenceId],
    },
  }, 'challenge', 'hermes', {
    slotId: 'slot-hermes',
    operationId: 'operation-challenge-hermes',
    deliveryWatermark: 0,
  }, 'a'.repeat(64), {
    controller: { runId: 'run-v4' },
    reviewedArtifactId: reviewed.artifact.artifactId,
  })

  const openIssues = value.runner.v4IssuesFromReviews([{
    record,
    reviewedArtifactId: reviewed.artifact.artifactId,
  }], { runId: 'run-v4' })
  assert.equal(openIssues.length, 1)
  assert.deepEqual(record.receipt.unresolved.map(issue => issue.id), [openIssues[0].id])
  assert.deepEqual(value.runner.v4ResolveIssues(
    openIssues, record.receipt.unresolved.map(issue => issue.id),
  ), [])
})

test('V4 candidate identity hashes immutable Artifact bytes and ignores locator IDs', (t) => {
  const value = fixture(t)
  const first = storedOutput(value, 'Stable candidate body.', {
    runId: 'run-first', agentRunId: 'attempt-first', agentKind: 'codex',
  })
  const second = storedOutput(value, 'Stable candidate body.', {
    runId: 'run-second', agentRunId: 'attempt-second', agentKind: 'codex',
  })
  const changed = storedOutput(value, 'Changed candidate body.', {
    runId: 'run-third', agentRunId: 'attempt-third', agentKind: 'codex',
  })

  assert.notEqual(first.artifact.artifactId, second.artifact.artifactId)
  assert.notEqual(first.evidence.evidenceId, second.evidence.evidenceId)
  assert.deepEqual(
    value.runner.v4CandidateIdentity(receiptRecord({
      phase: 'synthesis', agentKind: 'codex', operationId: 'operation-first', output: first,
    })),
    { artifactId: first.artifact.artifactId, contentHash: sha256('Stable candidate body.') },
  )
  assert.equal(
    value.runner.v4CandidateIdentity(receiptRecord({
      phase: 'synthesis', agentKind: 'codex', operationId: 'operation-second', output: second,
    })).contentHash,
    sha256('Stable candidate body.'),
  )
  assert.notEqual(
    value.runner.v4CandidateIdentity(receiptRecord({
      phase: 'synthesis', agentKind: 'codex', operationId: 'operation-third', output: changed,
    })).contentHash,
    sha256('Stable candidate body.'),
  )
  assert.throws(() => value.runner.v4CandidateIdentity({
    receipt: { artifactIds: [`artifact-${'f'.repeat(64)}`] },
  }), { message: 'LOCAL_RUN_V4_CANDIDATE_INVALID' })
})

test('V4 contradictory issues come only from traceable durable Reviewer Findings', (t) => {
  const value = fixture(t)
  const reviewed = storedOutput(value, 'Reviewed proposal.', { agentKind: 'codex' })
  const challengeOutput = storedOutput(value, 'Challenge response.', { agentKind: 'hermes' })
  const contradiction = boundFinding(value, reviewed, {
    relation: 'contradict',
    agentKind: 'hermes',
    summary: 'The proposal omits the rollback condition.',
    sourceEvidenceIds: [challengeOutput.evidence.evidenceId],
  })
  const review = receiptRecord({
    phase: 'challenge',
    agentKind: 'hermes',
    operationId: 'operation-challenge-hermes',
    output: challengeOutput,
    verdict: 'contradict',
    findingIds: [contradiction.reviewerFindingId],
    evidenceIds: [challengeOutput.evidence.evidenceId, ...contradiction.evidenceIds],
  })

  const issues = value.runner.v4IssuesFromReviews([
    { record: review, reviewedArtifactId: reviewed.artifact.artifactId },
  ], { runId: 'run-v4' })
  assert.equal(issues.length, 1)
  assert.match(issues[0].id, /^issue-[a-f0-9]{64}$/)
  assert.equal(issues[0].artifactId, reviewed.artifact.artifactId)
  assert.equal(issues[0].findingId, contradiction.reviewerFindingId)

  const alternateOutput = storedOutput(value, 'Alternate challenge response.', {
    agentKind: 'hermes', agentRunId: 'alternate-challenge',
  })
  const alternateFinding = boundFinding(value, reviewed, {
    relation: 'contradict',
    agentKind: 'hermes',
    summary: 'The proposal omits the rollback condition.',
    sourceEvidenceIds: [alternateOutput.evidence.evidenceId],
  })
  const alternateReview = receiptRecord({
    phase: 'challenge',
    agentKind: 'hermes',
    operationId: 'operation-alternate-challenge-hermes',
    output: alternateOutput,
    verdict: 'contradict',
    findingIds: [alternateFinding.reviewerFindingId],
    evidenceIds: [alternateOutput.evidence.evidenceId, ...alternateFinding.evidenceIds],
  })
  const alternateIssue = value.runner.v4IssuesFromReviews([
    { record: alternateReview, reviewedArtifactId: reviewed.artifact.artifactId },
  ], { runId: 'run-v4' })[0]
  assert.notEqual(alternateIssue.id, issues[0].id)

  const forgedMarkerOnly = {
    ...review,
    receipt: { ...review.receipt, findingIds: [], unresolved: [{
      id: 'issue-forged', summary: 'Agent supplied only.', refs: [],
    }] },
  }
  assert.throws(() => value.runner.v4IssuesFromReviews([
    { record: forgedMarkerOnly, reviewedArtifactId: reviewed.artifact.artifactId },
  ], { runId: 'run-v4' }), { message: 'LOCAL_RUN_V4_REVIEW_FINDING_INVALID' })

  const unrelated = storedOutput(value, 'Unrelated proposal.', { agentKind: 'codex' })
  const unrelatedFinding = boundFinding(value, unrelated, { relation: 'contradict' })
  assert.throws(() => value.runner.v4IssuesFromReviews([{
    record: {
      ...review,
      receipt: {
        ...review.receipt,
        evidenceIds: [...review.receipt.evidenceIds, ...unrelatedFinding.evidenceIds],
        findingIds: [unrelatedFinding.reviewerFindingId],
      },
    },
    reviewedArtifactId: reviewed.artifact.artifactId,
  }], { runId: 'run-v4' }), { message: 'LOCAL_RUN_V4_REVIEW_FINDING_INVALID' })
})

test('V4 carried issues rehydrate durable Artifact and Finding provenance after restart', (t) => {
  const { issue, roundState } = carriedIssueFixture(t)
  assert.deepEqual(roundState().openIssues, [issue])
})

test('V4 carried issues rehydrate a full-capacity contradictory review after restart', (t) => {
  const { contradiction, issue, review, roundState, value } = carriedIssueFixture(t)
  review.receipt.evidenceIds = reviewEvidenceBoundary(value, {
    artifact: value.outcomeStore.getArtifact(contradiction.artifactId),
  }, 'Contradictory review')

  assert.equal(value.runner.v4ReviewReceiptComplete({
    record: review,
    reviewedArtifactId: contradiction.artifactId,
  }, { runId: 'run-v4' }), true)
  assert.deepEqual(roundState().openIssues, [issue])
})

test('V4 carried issues reject stale IDs without a contradictory durable chain', (t) => {
  const { roundState } = carriedIssueFixture(t)
  assert.throws(() => roundState({
    previousConvergence: { openIssueIds: [`issue-${'f'.repeat(64)}`] },
  }), { message: 'LOCAL_RUN_V4_ISSUE_INVALID' })
})

test('V4 carried issues reject a deleted Reviewer Finding chain after restart', (t) => {
  const { contradiction, roundState, value } = carriedIssueFixture(t)
  fs.rmSync(outcomeRecordPath(
    value, 'reviewer-findings', contradiction.reviewerFindingId,
  ))
  assert.throws(roundState, { message: 'LOCAL_RUN_V4_ISSUE_INVALID' })
})

test('V4 carried issues reject a tampered Evidence chain after restart', (t) => {
  const { contradiction, roundState, value } = carriedIssueFixture(t)
  const evidenceId = contradiction.evidenceIds[0]
  const filename = outcomeRecordPath(value, 'evidence', evidenceId)
  const stored = JSON.parse(fs.readFileSync(filename, 'utf8'))
  fs.writeFileSync(filename, JSON.stringify({ ...stored, summary: 'Tampered review evidence.' }))
  assert.throws(roundState, { message: 'LOCAL_RUN_V4_ISSUE_INVALID' })
})

test('V4 carried issues reject an incomplete contradictory receipt after restart', (t) => {
  const { contradiction, records, roundState } = carriedIssueFixture(t)
  const incomplete = structuredClone(records)
  incomplete[0].receipt.evidenceIds = incomplete[0].receipt.evidenceIds.filter(
    evidenceId => !contradiction.evidenceIds.includes(evidenceId),
  )
  assert.throws(() => roundState({ receiptRecords: incomplete }), {
    message: 'LOCAL_RUN_V4_ISSUE_INVALID',
  })
})

test('V4 synthesis resolutions are unique current-open subsets and close an issue once', (t) => {
  const { runner } = fixture(t)
  const openIssues = [
    { id: `issue-${'a'.repeat(64)}` },
    { id: `issue-${'b'.repeat(64)}` },
  ]

  assert.deepEqual(
    runner.v4ResolveIssues(openIssues, [openIssues[0].id]).map(issue => issue.id),
    [openIssues[1].id],
  )
  for (const resolutionIds of [
    [openIssues[0].id, openIssues[0].id],
    [`issue-${'c'.repeat(64)}`],
  ]) {
    assert.throws(
      () => runner.v4ResolveIssues(openIssues, resolutionIds),
      { message: 'LOCAL_RUN_V4_RESOLUTION_INVALID' },
    )
  }
  assert.throws(
    () => runner.v4ResolveIssues([], [openIssues[0].id]),
    { message: 'LOCAL_RUN_V4_RESOLUTION_INVALID' },
  )
})

test('V4 convergence counts only adjacent same-writer rounds and gates each epoch once', (t) => {
  const value = fixture(t)
  const first = storedOutput(value, 'Stable candidate.', {
    agentKind: 'codex', agentRunId: 'writer-first',
  })
  const second = storedOutput(value, 'Stable candidate.', {
    agentKind: 'codex', agentRunId: 'writer-second',
  })
  const otherWriter = storedOutput(value, 'Stable candidate.', {
    agentKind: 'hermes', agentRunId: 'writer-hermes',
  })
  const changed = storedOutput(value, 'Changed candidate.', {
    agentKind: 'codex', agentRunId: 'writer-changed',
  })
  const candidate = output => ({
    artifactId: output.artifact.artifactId,
    contentHash: output.artifact.contentHash,
  })

  const roundTwo = value.runner.v4NextConvergence(null, candidate(first), [
    `issue-${'b'.repeat(64)}`, `issue-${'a'.repeat(64)}`,
  ], 2, 'codex')
  const roundThree = value.runner.v4NextConvergence(
    roundTwo, candidate(second), [...roundTwo.openIssueIds], 3, 'codex',
  )
  assert.deepEqual(roundThree.openIssueIds, [
    `issue-${'a'.repeat(64)}`, `issue-${'b'.repeat(64)}`,
  ])
  assert.equal(roundThree.stateEpoch, 1)
  assert.equal(roundThree.consecutiveStableRounds, 2)
  assert.equal(value.runner.v4ShouldOpenStableGate(roundThree, true), true)
  assert.equal(value.runner.v4ShouldOpenStableGate(roundThree, false), false)

  const acknowledged = { ...roundThree, acknowledgedGateEpoch: roundThree.stateEpoch }
  assert.equal(value.runner.v4ShouldOpenStableGate(acknowledged, true), false)
  assert.equal(value.runner.v4NextConvergence(
    acknowledged, candidate(second), [...acknowledged.openIssueIds], 5, 'codex',
  ).consecutiveStableRounds, 1)
  assert.equal(value.runner.v4NextConvergence(
    acknowledged, candidate(otherWriter), [...acknowledged.openIssueIds], 4, 'hermes',
  ).consecutiveStableRounds, 1)

  const changedEpoch = value.runner.v4NextConvergence(
    acknowledged, candidate(changed), [...acknowledged.openIssueIds], 4, 'codex',
  )
  assert.equal(changedEpoch.stateEpoch, 2)
  assert.equal(changedEpoch.acknowledgedGateEpoch, 1)
  assert.equal(changedEpoch.consecutiveStableRounds, 1)
})

test('V4 acceptance requires the exact candidate Finding and complete required phase chains', (t) => {
  const value = fixture(t)
  const runId = 'run-v4'
  const targetKinds = ['codex', 'hermes']
  const proposalCodex = storedOutput(value, 'Codex proposal.', { agentKind: 'codex' })
  const proposalHermes = storedOutput(value, 'Hermes proposal.', { agentKind: 'hermes' })
  const challengeCodex = storedOutput(value, 'Codex challenge.', { agentKind: 'codex' })
  const challengeHermes = storedOutput(value, 'Hermes challenge.', { agentKind: 'hermes' })
  const candidate = storedOutput(value, 'Accepted candidate.', { agentKind: 'codex' })
  const verification = storedOutput(value, 'Hermes verification.', { agentKind: 'hermes' })
  const codexFinding = boundFinding(value, proposalHermes, {
    agentKind: 'codex',
    agentRunId: 'agent-run-challenge-codex',
    sourceEvidenceIds: [challengeCodex.evidence.evidenceId],
  })
  const hermesFinding = boundFinding(value, proposalCodex, {
    agentKind: 'hermes',
    agentRunId: 'agent-run-challenge-hermes',
    sourceEvidenceIds: [challengeHermes.evidence.evidenceId],
  })
  const supportFinding = boundFinding(value, candidate, {
    agentKind: 'hermes',
    agentRunId: 'agent-run-verification-hermes',
    sourceEvidenceIds: [verification.evidence.evidenceId],
  })
  const records = [
    receiptRecord({
      phase: 'proposal', agentKind: 'codex', operationId: 'operation-proposal-codex',
      output: proposalCodex,
    }),
    receiptRecord({
      phase: 'proposal', agentKind: 'hermes', operationId: 'operation-proposal-hermes',
      output: proposalHermes,
    }),
    receiptRecord({
      phase: 'challenge', agentKind: 'codex', operationId: 'operation-challenge-codex',
      output: challengeCodex, verdict: 'support', findingIds: [codexFinding.reviewerFindingId],
      evidenceIds: [challengeCodex.evidence.evidenceId, ...codexFinding.evidenceIds],
    }),
    receiptRecord({
      phase: 'challenge', agentKind: 'hermes', operationId: 'operation-challenge-hermes',
      output: challengeHermes, verdict: 'support', findingIds: [hermesFinding.reviewerFindingId],
      evidenceIds: [challengeHermes.evidence.evidenceId, ...hermesFinding.evidenceIds],
    }),
    receiptRecord({
      phase: 'synthesis', agentKind: 'codex', operationId: 'operation-synthesis-codex',
      output: candidate,
    }),
    receiptRecord({
      phase: 'verification', agentKind: 'hermes', operationId: 'operation-verification-hermes',
      output: verification, verdict: 'support', findingIds: [supportFinding.reviewerFindingId],
      evidenceIds: [verification.evidence.evidenceId, ...supportFinding.evidenceIds],
    }),
  ]
  const slots = [
    { agentKind: 'codex', slotId: 'slot-codex', phase: 'synthesis',
      operationId: 'operation-synthesis-codex', status: 'completed' },
    { agentKind: 'hermes', slotId: 'slot-hermes', phase: 'verification',
      operationId: 'operation-verification-hermes', status: 'completed' },
  ]
  const challengeBindings = [
    { reviewerKind: 'codex', reviewerOperationId: 'operation-challenge-codex',
      artifactIds: [proposalHermes.artifact.artifactId] },
    { reviewerKind: 'hermes', reviewerOperationId: 'operation-challenge-hermes',
      artifactIds: [proposalCodex.artifact.artifactId] },
  ]
  const options = {
    runId, round: 2, slots, challengeBindings, previousConvergence: null,
  }
  const accepted = value.runner.v4Acceptance(
    records, targetKinds, 'codex', ['hermes'], options,
  )
  assert.equal(accepted.accepted, true)
  assert.equal(accepted.candidateHash, sha256('Accepted candidate.'))
  assert.deepEqual(accepted.openIssueIds, [])

  for (const producer of [{ runId: 'run-other', agentKind: 'codex' },
    { runId, agentKind: 'hermes' }]) {
    const foreign = storedOutput(value, 'Foreign proposal.', producer)
    const altered = structuredClone(records)
    altered[0].receipt.artifactIds = [foreign.artifact.artifactId]
    altered[0].receipt.evidenceIds = [foreign.evidence.evidenceId]
    assert.equal(value.runner.v4Acceptance(
      altered, targetKinds, 'codex', ['hermes'], options,
    ).accepted, false)
  }

  const roundState = value.runner.v4RoundState(records, targetKinds, 'codex', ['hermes'], {
    ...options, includeVerification: true,
  })
  const foreignCandidate = storedOutput(value, 'Foreign synthesis.', { runId: 'run-other' })
  const foreignSynthesis = receiptRecord({ phase: 'synthesis', agentKind: 'codex',
    operationId: 'operation-synthesis-codex', output: foreignCandidate })
  const originalRoundState = value.runner.v4RoundState
  value.runner.v4RoundState = () => ({ ...roundState, synthesis: foreignSynthesis,
    candidate: { artifactId: foreignCandidate.artifact.artifactId,
      contentHash: foreignCandidate.artifact.contentHash } })
  try {
    assert.equal(value.runner.v4Acceptance(records, targetKinds, 'codex', ['hermes'], options).accepted, false)
  } finally {
    value.runner.v4RoundState = originalRoundState
  }

  const fullReviewReceipts = structuredClone(records)
  for (const [recordIndex, reviewedOutput, label] of [
    [2, proposalHermes, 'Codex challenge'],
    [3, proposalCodex, 'Hermes challenge'],
    [5, candidate, 'Hermes verification'],
  ]) {
    fullReviewReceipts[recordIndex].receipt.evidenceIds = reviewEvidenceBoundary(
      value,
      reviewedOutput,
      label,
    )
  }
  const restoredController = {
    orchestration: {
      slots: targetKinds.map(agentKind => ({
        agentKind,
        resultRefs: {
          workflowOutcomeRefs: fullReviewReceipts
            .filter(record => record.receipt.agentKind === agentKind),
        },
      })),
    },
  }
  const restoredFullReviewReceipts = value.runner.v4RestoreReceipts(restoredController)
  assert.equal(value.runner.v4Acceptance(
    restoredFullReviewReceipts, targetKinds, 'codex', ['hermes'], options,
  ).accepted, true)

  const missingCandidate = structuredClone(records)
  missingCandidate[4].receipt.artifactIds = [`artifact-${'f'.repeat(64)}`]
  assert.throws(() => value.runner.v4Acceptance(
    missingCandidate, targetKinds, 'codex', ['hermes'], options,
  ), { message: 'LOCAL_RUN_V4_CANDIDATE_INVALID' })

  const otherCandidate = storedOutput(value, 'Wrong candidate.', { agentKind: 'codex' })
  const wrongFinding = boundFinding(value, otherCandidate, {
    agentKind: 'hermes', sourceEvidenceIds: [verification.evidence.evidenceId],
  })
  const wrongCandidateReview = structuredClone(records)
  wrongCandidateReview[5].receipt.findingIds = [wrongFinding.reviewerFindingId]
  wrongCandidateReview[5].receipt.evidenceIds.push(...wrongFinding.evidenceIds)
  assert.throws(() => value.runner.v4Acceptance(
    wrongCandidateReview, targetKinds, 'codex', ['hermes'], options,
  ), { message: 'LOCAL_RUN_V4_REVIEW_FINDING_INVALID' })

  const incompleteFinding = finding(value, candidate, {
    agentKind: 'hermes', evidenceIds: [],
  })
  const incompleteEvidence = structuredClone(records)
  incompleteEvidence[5].receipt.findingIds = [incompleteFinding.reviewerFindingId]
  assert.throws(() => value.runner.v4Acceptance(
    incompleteEvidence, targetKinds, 'codex', ['hermes'], options,
  ), { message: 'LOCAL_RUN_V4_REVIEW_FINDING_INVALID' })

  const nonSuccessStatuses = [
    'planned', 'queued', 'running', 'waiting', 'partial', 'failed', 'stopped',
    'timeout', 'interrupted', 'prepared', 'settled', 'cancelled', 'unknown_outcome',
  ]
  for (const agentKind of targetKinds) {
    for (const status of nonSuccessStatuses) {
      assert.equal(value.runner.v4Acceptance(
        records, targetKinds, 'codex', ['hermes'], {
          ...options,
          slots: slots.map(slot => slot.agentKind === agentKind
            ? { ...slot, status }
            : slot),
        },
      ).accepted, false, `${agentKind}:${status}`)
    }
  }

  const unrelatedEvidence = boundFinding(value, otherCandidate, {
    agentKind: 'hermes',
    agentRunId: 'agent-run-verification-hermes',
    sourceEvidenceIds: [verification.evidence.evidenceId],
  })
  const wrongCandidateEvidence = finding(value, candidate, {
    agentKind: 'hermes',
    agentRunId: 'agent-run-verification-hermes',
    evidenceIds: unrelatedEvidence.evidenceIds,
  })
  const wrongEvidenceReview = structuredClone(records)
  wrongEvidenceReview[5].receipt.findingIds = [wrongCandidateEvidence.reviewerFindingId]
  wrongEvidenceReview[5].receipt.evidenceIds.push(...unrelatedEvidence.evidenceIds)
  assert.throws(() => value.runner.v4Acceptance(
    wrongEvidenceReview, targetKinds, 'codex', ['hermes'], options,
  ), { message: 'LOCAL_RUN_V4_REVIEW_FINDING_INVALID' })

  const legacyMarker = structuredClone(records.slice(0, -1))
  legacyMarker[4].receipt.conclusion = '[[MELDWORK_CONSENSUS:agree]]'
  assert.equal(value.runner.v4Acceptance(
    legacyMarker, targetKinds, 'codex', ['hermes'], options,
  ).accepted, false)
})

test('finite V4 round limit retains candidate and durable open issues without a Gate or answer', async (t) => {
  const { directory, options } = workspaceFixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    const workItemId = prompt.match(/^Work item: ([A-Za-z0-9._:-]+)$/m)?.[1] || ''
    const assignments = [
      {
        taskId: 'codex-analysis', ownerKind: 'codex', role: 'worker',
        objective: 'Prepare the bounded analysis.', expectedOutput: 'Analysis Artifact.',
        inputRefs: [], artifactIds: [], dependsOn: [],
      },
      {
        taskId: 'hermes-integration', ownerKind: 'hermes', role: 'integrator',
        objective: 'Integrate the agreed analysis.', expectedOutput: 'Candidate Artifact.',
        inputRefs: [], artifactIds: [], dependsOn: ['codex-analysis'],
      },
    ]
    return {
      text: phase === 'synthesis' ? 'Retained finite candidate.' : `${agent.kind} ${phase}`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
      collaboration: phase === 'proposal'
        ? {
            version: 1, phase, summary: `${agent.kind} proposal`,
            capabilities: [`${agent.kind} capability`],
            intendedWork: [`${agent.kind} work`],
            deliverables: [`${agent.kind} Artifact`],
            dependencies: [],
          }
        : phase === 'challenge'
          ? {
              version: 1, phase, verdict: 'support', summary: `${agent.kind} supports the plan`,
              proposedAssignments: assignments,
              finalizerKind: 'hermes',
              verifierKinds: ['codex'],
              agreeToPlan: true,
            }
          : phase === 'work'
            ? {
                version: 1, phase, summary: `${agent.kind} completed ${workItemId}`,
                workItemId, deliverables: [`${agent.kind} Artifact`],
              }
          : phase === 'synthesis'
            ? { version: 1, phase, summary: 'Retained candidate', resolvedIssueIds: [] }
            : { version: 1, phase, verdict: 'contradict', summary: 'One issue remains' },
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Finite V4 retention', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  await workspace.sendMessage({
    groupId: group.id,
    text: 'Retain the latest reviewed candidate at the finite limit.',
    mode: 'auto',
    targetKinds: ['codex', 'hermes'],
    maxRounds: 2,
    protocol: 'v4',
  })
  const controller = workspace.activeRuns.get(group.id)
  await controller.promise

  const durable = ledger.get(controller.runId)
  assert.equal(durable.status, 'round-limit')
  assert.match(durable.orchestration.convergence.candidateArtifactId, /^artifact-[a-f0-9]{64}$/)
  assert.equal(
    durable.orchestration.convergence.candidateContentHash,
    sha256('Retained finite candidate.'),
  )
  assert.equal(durable.orchestration.convergence.openIssueIds.length, 1)
  assert.deepEqual(workspace.listHumanGates(), [])
  assert.deepEqual(
    workspace.snapshot().messages.filter(message => message.role === 'agent')
      .map(message => ({ agentKind: message.agentKind, content: message.content })),
    [
      { agentKind: 'codex', content: 'codex proposal' },
      { agentKind: 'hermes', content: 'hermes proposal' },
      { agentKind: 'codex', content: 'codex challenge' },
      { agentKind: 'hermes', content: 'hermes challenge' },
    ],
  )
})

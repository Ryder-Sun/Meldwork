const test = require('node:test')
const assert = require('node:assert/strict')

const {
  appendBlackboardEntry,
  appendHandoff,
  createBlackboardEntryRecord,
  createHandoffRecord,
  emptyCollaborationState,
  parseCollaborationState,
  visibleBlackboardEntries,
} = require('../../src/collaboration/collaboration-records.cjs')

function provenance(overrides = {}) {
  return {
    runId: 'run-collaboration',
    taskId: 'task-collaboration',
    round: 1,
    agentRunId: null,
    artifactIds: [],
    evidenceIds: [],
    ...overrides,
  }
}

function claimInput(agentKind, role, value, sequence, overrides = {}) {
  return {
    entryType: 'claim',
    subject: 'release-readiness',
    statement: `Release readiness is ${value}.`,
    value,
    owner: { type: 'agent', agentKind, role },
    audience: { roles: ['reviewer', 'arbiter'], agentKinds: [] },
    lifecycle: {
      state: 'active', sequence, recordedAt: sequence, supersedesEntryId: null,
    },
    provenance: provenance({ agentRunId: `agent-run-${sequence}` }),
    refs: [],
    ...overrides,
  }
}

test('Handoff and Blackboard records are strict, content-addressed, and secret-safe', () => {
  const handoff = createHandoffRecord({
    source: { type: 'harness' },
    destination: { agentKind: 'codex', role: 'primary' },
    objective: 'Assess the current release.',
    selectedEntryIds: [],
    expectedOutput: 'One bounded conclusion.',
    acceptanceCriteria: ['Use only selected evidence.'],
    provenance: provenance(),
    createdAt: 1,
  })
  assert.match(handoff.handoffId, /^handoff-[a-f0-9]{64}$/)
  assert.deepEqual(createHandoffRecord({
    source: { type: 'harness' },
    destination: { agentKind: 'codex', role: 'primary' },
    objective: 'Assess the current release.',
    selectedEntryIds: [],
    expectedOutput: 'One bounded conclusion.',
    acceptanceCriteria: ['Use only selected evidence.'],
    provenance: provenance(),
    createdAt: 1,
  }), handoff)

  const claim = createBlackboardEntryRecord(claimInput('codex', 'primary', 'ready', 1))
  assert.match(claim.entryId, /^blackboard-entry-[a-f0-9]{64}$/)
  assert.throws(() => createHandoffRecord({
    source: { type: 'harness' },
    destination: { agentKind: 'codex', role: 'primary' },
    objective: 'Use api_key=secret-value.',
    selectedEntryIds: [],
    expectedOutput: 'One bounded conclusion.',
    acceptanceCriteria: ['Use only selected evidence.'],
    provenance: provenance(),
    createdAt: 1,
  }), { message: 'HANDOFF_FORBIDDEN_VALUE' })
  assert.throws(() => createBlackboardEntryRecord({
    ...claimInput('codex', 'primary', 'ready', 1),
    statement: 'Run /Users/example/bin/tool next.',
  }), { message: 'BLACKBOARD_ENTRY_FORBIDDEN_VALUE' })
  assert.throws(() => parseCollaborationState({
    version: 1,
    handoffs: [{ ...handoff, objective: 'Tampered objective.' }],
    entries: [],
  }), { message: 'HANDOFF_ID_MISMATCH' })
})

test('Blackboard entries retain the negotiated integrator owner role', () => {
  const entry = createBlackboardEntryRecord(claimInput('workbuddy', 'integrator', 'ready', 1))
  assert.equal(entry.owner.role, 'integrator')
})

test('Blackboard entries roundtrip negotiated worker and verifier owners only', () => {
  for (const role of ['worker', 'verifier']) {
    const entry = createBlackboardEntryRecord(claimInput('codex', role, 'ready', 1))
    const state = { version: 1, handoffs: [], entries: [entry] }
    assert.equal(parseCollaborationState(state).entries[0].owner.role, role)
  }
  assert.throws(() => createBlackboardEntryRecord(
    claimInput('codex', 'participant', 'ready', 1),
  ), { message: 'BLACKBOARD_ENTRY_SCHEMA_INVALID' })
})

test('conflicting claims append a conflict and remain selectively visible', () => {
  let state = emptyCollaborationState()
  state = appendBlackboardEntry(state, claimInput('codex', 'primary', 'ready', 1))
  state = appendBlackboardEntry(state, claimInput('hermes', 'reviewer', 'blocked', 2, {
    audience: { roles: ['primary', 'arbiter'], agentKinds: [] },
  }))

  assert.deepEqual(state.entries.map(entry => entry.entryType), [
    'claim', 'claim', 'conflict',
  ])
  assert.equal(state.entries[0].lifecycle.state, 'active')
  assert.equal(state.entries[1].lifecycle.state, 'active')
  assert.deepEqual(state.entries[2].refs, [state.entries[0].entryId, state.entries[1].entryId])
  assert.deepEqual(
    visibleBlackboardEntries(state, { agentKind: 'workbuddy', role: 'arbiter' })
      .map(entry => entry.entryType),
    ['claim', 'claim', 'conflict'],
  )
  assert.deepEqual(
    visibleBlackboardEntries(state, { agentKind: 'kimi', role: 'reviewer' })
      .map(entry => entry.entryType),
    ['claim', 'conflict'],
  )

  state = appendHandoff(state, {
    source: { type: 'agent', agentKind: 'hermes', role: 'reviewer' },
    destination: { agentKind: 'workbuddy', role: 'arbiter' },
    objective: 'Resolve release readiness.',
    selectedEntryIds: state.entries.map(entry => entry.entryId),
    expectedOutput: 'One adjudication.',
    acceptanceCriteria: ['Resolve the visible conflict.'],
    provenance: provenance(),
    createdAt: 3,
  })
  assert.deepEqual(parseCollaborationState(state), state)
})

test('peer transcripts keep workspace files readable and other local paths private', () => {
  const { peerCollaborationText } = require('../../src/collaboration/collaboration-records.cjs')
  const text = peerCollaborationText(
    'Edited /work/proj/src/app.ts (see file:///work/proj/docs/a.md). /api/users still fails; '
      + 'logs are in /Users/me/private.log and /tmp/run.log; run /login.',
    { workspaceRoot: '/work/proj' },
  )
  assert.equal(text,
    'Edited src/app.ts (see docs/a.md). /api/users still fails; '
      + 'logs are in [path] and [path]; run /login.')
})

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createHash } = require('node:crypto')

const { ContentBlobStore } = require('../../src/attachments/content-blob-store.cjs')
const { canonicalJson } = require('../../src/collaboration/outcome-records.cjs')
const {
  createHumanGateRecord,
  decideHumanGateRecord,
  parseHumanGateRecord,
  publicHumanGate,
} = require('../../src/gates/human-gate-records.cjs')
const { HumanGateStore } = require('../../src/gates/human-gate-store.cjs')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-human-gates-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const contentBlobStore = new ContentBlobStore({ rootPath: path.join(directory, 'blobs') })
  const storagePath = path.join(directory, 'gates.json')
  const store = new HumanGateStore({ storagePath, contentBlobStore })
  return { contentBlobStore, directory, storagePath, store }
}

function gateInput(contentBlobStore, overrides = {}) {
  const requestRef = contentBlobStore.put('{"tool":"write_file"}', {
    mediaType: 'application/json',
  })
  return {
    type: 'permission',
    runId: 'run-1',
    agentRunId: 'agent-run-1',
    agentKind: 'codex',
    requestRef,
    requestHash: requestRef.hash,
    summary: 'Agent requests permission to edit the workspace.',
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ],
    createdAt: '2026-08-04T00:00:00.000Z',
    ...overrides,
  }
}

test('creates content-addressed pending gates without public request references', (t) => {
  const { contentBlobStore } = fixture(t)
  const record = createHumanGateRecord(gateInput(contentBlobStore))
  const restored = parseHumanGateRecord(canonicalJson(record))
  const publicRecord = publicHumanGate(record)

  assert.match(record.gateId, /^human-gate-[a-f0-9]{64}$/)
  assert.equal(restored.gateId, record.gateId)
  assert.equal(record.status, 'pending')
  assert.equal(record.decision, null)
  assert.equal('requestRef' in publicRecord, false)
  assert.equal('requestHash' in publicRecord, false)
  assert.equal(JSON.stringify(publicRecord).includes('write_file'), false)
})

test('projects only bounded public task graph decision context', t => {
  const { store } = fixture(t)
  const graphId = `task-graph-${'a'.repeat(64)}`
  const nodeId = 'human'
  const agentRunId = `graph-decision-${createHash('sha256').update(JSON.stringify([graphId, nodeId])).digest('hex')}`
  const base = { type: 'decision', runId: 'run-1', agentRunId, agentKind: 'codex',
    summary: 'Choose an outcome.', options: [{ optionId: 'approve', name: 'Approve', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' }], createdAt: '2026-08-04T00:00:00.000Z' }
  store.create({ ...base, request: { graphId, nodeId, inputNodeIds: ['primary'],
    decisionContext: [{ agentKind: 'codex', text: 'The release is ready.', truncated: false }], privateValue: 'must-not-cross' } })
  const [gate] = store.list({ pendingOnly: true })
  assert.deepEqual(gate.decisionContext, [{ agentKind: 'codex', text: 'The release is ready.', truncated: false }])
  assert.doesNotMatch(JSON.stringify(gate), /must-not-cross|requestHash|requestRef/)
  store.create({ ...base, runId: 'run-2', request: { graphId, nodeId,
    decisionContext: [{ agentKind: 'codex', text: '/private/work/secrets.txt', truncated: false }] } })
  assert.deepEqual(store.list({ pendingOnly: true }).map(item => item.runId), ['run-1'])
})

test('accepts one idempotent decision and rejects conflicting decisions', (t) => {
  const { contentBlobStore } = fixture(t)
  const pending = createHumanGateRecord(gateInput(contentBlobStore))
  const decision = {
    status: 'approved',
    optionId: 'allow-once',
    actorId: 'local-user',
    decidedAt: '2026-08-04T00:01:00.000Z',
  }
  const decided = decideHumanGateRecord(pending, decision)

  assert.equal(decided.status, 'approved')
  assert.deepEqual(decided.decision, decision)
  assert.deepEqual(decideHumanGateRecord(decided, decision), decided)
  assert.throws(() => decideHumanGateRecord(decided, {
    ...decision, status: 'rejected', optionId: 'reject-once',
  }), { message: 'HUMAN_GATE_ALREADY_DECIDED' })
  assert.throws(() => decideHumanGateRecord(pending, {
    ...decision, optionId: 'missing-option',
  }), { message: 'HUMAN_GATE_DECISION_INVALID' })

  const withoutReject = createHumanGateRecord(gateInput(contentBlobStore, {
    options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
  }))
  const systemRejected = decideHumanGateRecord(withoutReject, {
    status: 'rejected',
    optionId: 'meldwork-system-reject',
    actorId: 'meldwork-system',
    decidedAt: '2026-08-04T00:01:00.000Z',
  })
  assert.equal(systemRejected.status, 'rejected')
  assert.throws(() => decideHumanGateRecord(withoutReject, {
    status: 'rejected',
    optionId: 'meldwork-system-reject',
    actorId: 'local-user',
    decidedAt: '2026-08-04T00:01:00.000Z',
  }), { message: 'HUMAN_GATE_DECISION_INVALID' })
})

test('persists an input response without exposing it through the public Gate', (t) => {
  const { store } = fixture(t)
  const pending = store.create({
    type: 'input',
    runId: 'run-input',
    agentRunId: 'agent-run-input',
    agentKind: 'custom-input',
    summary: 'Which release channel should this run use?',
    options: [
      { optionId: 'submit-input', name: 'Submit', kind: 'respond' },
      { optionId: 'cancel-input', name: 'Cancel', kind: 'reject' },
    ],
    createdAt: '2026-08-04T00:00:00.000Z',
    request: { requestId: 'request-1' },
  })
  const decided = store.decide(pending.gateId, {
    status: 'approved',
    optionId: 'submit-input',
    actorId: 'local-user',
    decidedAt: '2026-08-04T00:01:00.000Z',
    response: 'stable',
  })

  assert.equal(decided.decision.response, 'stable')
  assert.equal(Object.hasOwn(publicHumanGate(decided).decision, 'response'), false)
  assert.throws(() => decideHumanGateRecord(createHumanGateRecord(gateInput(
    store.contentBlobStore,
  )), {
    status: 'approved', optionId: 'allow-once', actorId: 'local-user',
    decidedAt: '2026-08-04T00:01:00.000Z', response: 'unexpected',
  }), { message: 'HUMAN_GATE_SCHEMA_INVALID' })
})

test('persists private requests, pending state, and decisions across restart', (t) => {
  const { contentBlobStore, storagePath, store } = fixture(t)
  const created = store.create({
    type: 'permission',
    runId: 'run-1',
    agentRunId: 'agent-run-1',
    agentKind: 'hermes',
    summary: 'Agent requests workspace access.',
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ],
    createdAt: '2026-08-04T00:00:00.000Z',
    request: { tool: 'write_file', path: '/private/work/report.md', token: 'private-token' },
  })

  assert.deepEqual(store.request(created.gateId), {
    path: '/private/work/report.md', token: 'private-token', tool: 'write_file',
  })
  assert.equal(fs.readFileSync(storagePath, 'utf8').includes('private-token'), false)
  assert.equal(fs.readFileSync(storagePath, 'utf8').includes('/private/work'), false)
  assert.deepEqual(store.list({ pendingOnly: true }).map(gate => gate.gateId), [created.gateId])

  const restarted = new HumanGateStore({ storagePath, contentBlobStore })
  const decided = restarted.decide(created.gateId, {
    status: 'rejected',
    optionId: 'reject-once',
    actorId: 'local-user',
    decidedAt: '2026-08-04T00:02:00.000Z',
  })
  assert.equal(decided.status, 'rejected')
  assert.deepEqual(
    new HumanGateStore({ storagePath, contentBlobStore }).list({ pendingOnly: true }),
    [],
  )
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(storagePath).mode & 0o777, 0o600)
  }
})

test('rolls back only the exact durable decision to a retryable pending gate', (t) => {
  const { contentBlobStore, storagePath, store } = fixture(t)
  const created = store.create({
    type: 'permission',
    runId: 'run-rollback',
    agentRunId: 'agent-run-rollback',
    agentKind: 'codex',
    summary: 'Agent requests permission to edit the workspace.',
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ],
    createdAt: '2026-08-04T00:00:00.000Z',
    request: { tool: 'write_file' },
  })
  const decision = {
    status: 'approved',
    optionId: 'allow-once',
    actorId: 'local-user',
    decidedAt: '2026-08-04T00:01:00.000Z',
  }
  store.decide(created.gateId, decision)

  assert.throws(() => store.rollbackDecision(created.gateId, {
    ...decision, optionId: 'reject-once', status: 'rejected',
  }), { message: 'HUMAN_GATE_ROLLBACK_INVALID' })
  const pending = store.rollbackDecision(created.gateId, decision)

  assert.equal(pending.status, 'pending')
  assert.equal(pending.decision, null)
  assert.deepEqual(
    new HumanGateStore({ storagePath, contentBlobStore }).list({ pendingOnly: true })
      .map(gate => gate.gateId),
    [created.gateId],
  )
  assert.throws(() => store.rollbackDecision(created.gateId, decision), {
    message: 'HUMAN_GATE_ROLLBACK_INVALID',
  })
})

test('accepts the typed decision Gate contract', (t) => {
  const { store } = fixture(t)
  const record = store.create({
    type: 'decision',
    runId: 'run-decision',
    agentRunId: 'agent-run-decision',
    agentKind: 'claude',
    summary: 'This run requires a human decision.',
    options: [
      { optionId: 'accept-artifact', name: 'Accept Artifact', kind: 'accept' },
      { optionId: 'reject-artifact', name: 'Reject Artifact', kind: 'reject' },
      { optionId: 'reopen-task', name: 'Reopen Task', kind: 'reopen' },
    ],
    createdAt: '2026-08-04T00:00:00.000Z',
    request: { reason: 'manual-confirmation' },
  })

  assert.equal(record.type, 'decision')
  assert.deepEqual(store.list({ pendingOnly: true })[0].options.map(option => (
    [option.optionId, option.kind]
  )), [
    ['accept-artifact', 'accept'],
    ['reject-artifact', 'reject'],
    ['reopen-task', 'reopen'],
  ])
})

test('fails closed for secret-bearing public summaries and missing request blobs', (t) => {
  const { contentBlobStore, store } = fixture(t)
  assert.throws(() => store.create({
    type: 'budget',
    runId: 'run-1',
    agentRunId: 'agent-run-1',
    agentKind: 'codex',
    summary: 'Authorization: Bearer private-value',
    options: [{ optionId: 'reject', name: 'Reject', kind: 'reject' }],
    createdAt: '2026-08-04T00:00:00.000Z',
    request: { dimension: 'outboundBytes' },
  }), { message: 'HUMAN_GATE_SCHEMA_INVALID' })

  const created = store.create({
    type: 'budget',
    runId: 'run-1',
    agentRunId: 'agent-run-1',
    agentKind: 'codex',
    summary: 'Outbound byte usage is unavailable.',
    options: [{ optionId: 'reject', name: 'Reject', kind: 'reject' }],
    createdAt: '2026-08-04T00:00:00.000Z',
    request: { dimension: 'outboundBytes' },
  })
  const blobPath = path.join(
    contentBlobStore.rootPath,
    'sha256',
    created.requestRef.hash.slice(0, 2),
    created.requestRef.hash,
  )
  fs.unlinkSync(blobPath)
  assert.throws(() => store.get(created.gateId), { message: 'HUMAN_GATE_REQUEST_NOT_FOUND' })
})

test('quarantines malformed records individually and preserves unrelated valid Gates', (t) => {
  const { contentBlobStore, storagePath, store } = fixture(t)
  const malformed = store.create({
    type: 'permission', runId: 'run-bad', agentRunId: 'agent-run-bad', agentKind: 'codex',
    summary: 'Malformed later.',
    options: [{ optionId: 'reject', name: 'Reject', kind: 'reject' }],
    createdAt: '2026-08-04T00:00:00.000Z', request: { requestId: 'bad' },
  })
  const missingBlob = store.create({
    type: 'permission', runId: 'run-missing', agentRunId: 'agent-run-missing', agentKind: 'codex',
    summary: 'Missing request later.',
    options: [{ optionId: 'reject', name: 'Reject', kind: 'reject' }],
    createdAt: '2026-08-04T00:01:00.000Z', request: { requestId: 'missing' },
  })
  const valid = store.create({
    type: 'permission', runId: 'run-valid', agentRunId: 'agent-run-valid', agentKind: 'codex',
    summary: 'Keep this Gate.',
    options: [{ optionId: 'reject', name: 'Reject', kind: 'reject' }],
    createdAt: '2026-08-04T00:02:00.000Z', request: { requestId: 'valid' },
  })
  const persisted = JSON.parse(fs.readFileSync(storagePath, 'utf8'))
  persisted.gates.find(gate => gate.gateId === malformed.gateId).summary = ''
  fs.writeFileSync(storagePath, `${JSON.stringify(persisted, null, 2)}\n`)
  const missingBlobPath = path.join(
    contentBlobStore.rootPath, 'sha256', missingBlob.requestRef.hash.slice(0, 2),
    missingBlob.requestRef.hash,
  )
  fs.unlinkSync(missingBlobPath)

  const restarted = new HumanGateStore({ storagePath, contentBlobStore })

  assert.deepEqual(restarted.list().map(gate => gate.gateId), [valid.gateId])
  assert.equal(restarted.quarantined.length, 2)
  assert.equal(fs.existsSync(`${storagePath}.quarantine.json`), true)
  assert.deepEqual(JSON.parse(fs.readFileSync(storagePath, 'utf8')).gates.map(gate => gate.gateId), [
    valid.gateId,
  ])
})

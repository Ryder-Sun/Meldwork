const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createHash } = require('node:crypto')

const { ContentBlobStore } = require('../../src/attachments/content-blob-store.cjs')
const { HumanGateCoordinator } = require('../../src/gates/human-gate-coordinator.cjs')
const { HumanGateStore } = require('../../src/gates/human-gate-store.cjs')

function fixture(t, callbacks = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-human-gate-coordinator-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const contentBlobStore = new ContentBlobStore({ rootPath: path.join(directory, 'blobs') })
  const store = new HumanGateStore({
    storagePath: path.join(directory, 'gates.json'),
    contentBlobStore,
  })
  const coordinator = new HumanGateCoordinator({
    store,
    now: () => '2026-08-04T00:00:00.000Z',
    ...callbacks,
  })
  return { coordinator, store }
}

function request({ rejectOption = true } = {}) {
  return {
    type: 'permission',
    runId: 'run-1',
    agentRunId: 'agent-run-1',
    agentKind: 'codex',
    summary: 'Agent requests permission to edit the workspace.',
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      ...(rejectOption
        ? [{ optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }]
        : []),
    ],
    request: { toolCall: { toolCallId: 'tool-1', title: 'Edit file' } },
  }
}

test('a task graph decision with unavailable context can be rejected but not approved', t => {
  const { coordinator, store } = fixture(t)
  const graphId = `task-graph-${'a'.repeat(64)}`
  const nodeId = 'human'
  const agentRunId = `graph-decision-${createHash('sha256').update(JSON.stringify([graphId, nodeId])).digest('hex')}`
  const record = store.create({ type: 'decision', runId: 'run-unavailable', agentRunId, agentKind: 'codex',
    summary: 'Choose an outcome.', options: [{ optionId: 'approve', name: 'Approve', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' }], createdAt: '2026-08-04T00:00:00.000Z',
    request: { graphId, nodeId, decisionContext: [{ agentKind: 'codex', text: '/private/work/file', truncated: false }] } })
  assert.equal(coordinator.list({ pendingOnly: true })[0].decisionContextUnavailable, true)
  assert.throws(() => coordinator.decide(record.gateId, { optionId: 'approve' }), { message: 'HUMAN_GATE_CONTEXT_UNAVAILABLE' })
  assert.equal(store.get(record.gateId).status, 'pending')
  assert.equal(coordinator.decide(record.gateId, { optionId: 'reject' }).status, 'rejected')
})

test('persists a pending gate and resumes its live waiter after one decision', async (t) => {
  const events = []
  const { coordinator } = fixture(t, {
    onWaiting: record => events.push(`waiting:${record.gateId}`),
    onResumed: (_record, decision) => events.push(`resumed:${decision.status}`),
  })
  const waiting = coordinator.wait(request())
  const [pending] = coordinator.list({ pendingOnly: true })
  assert.equal(pending.status, 'pending')

  const publicRecord = coordinator.decide(pending.gateId, {
    status: 'approved', optionId: 'allow-once',
  })
  assert.equal(publicRecord.status, 'approved')
  assert.deepEqual(await waiting, {
    status: 'approved',
    optionId: 'allow-once',
    actorId: 'local-user',
    decidedAt: '2026-08-04T00:00:00.000Z',
  })
  assert.deepEqual(events.map(value => value.split(':', 1)[0]), ['waiting', 'resumed'])
})

test('input gate preserves response whitespace while rejecting empty answers', async t => {
  const { coordinator, store } = fixture(t)
  const waiting = coordinator.wait({ ...request(), type: 'input',
    options: [{ optionId: 'submit', name: 'Submit', kind: 'respond' }] })
  const [pending] = coordinator.list({ pendingOnly: true })
  assert.throws(() => coordinator.decide(pending.gateId, { optionId: 'submit', response: '  \n' }),
    { message: 'HUMAN_GATE_DECISION_INVALID' })
  coordinator.decide(pending.gateId, { optionId: 'submit', response: '  indented\n' })
  assert.equal((await waiting).response, '  indented\n')
  assert.equal(store.get(pending.gateId).decision.response, '  indented\n')
})

test('repeated decisions return the persisted result without replaying resume callbacks', async t => {
  let resumed = 0
  let orphaned = 0
  let tick = 0
  const { coordinator, store } = fixture(t, {
    now: () => new Date(Date.UTC(2026, 7, 4, 0, 0, tick++)).toISOString(),
    onResumed: () => { resumed += 1 },
    onOrphanDecision: () => { orphaned += 1 },
  })
  const gate = store.create({ ...request(), createdAt: '2026-08-04T00:00:00.000Z' })
  const first = coordinator.decide(gate.gateId, { optionId: 'allow-once' })
  assert.deepEqual(coordinator.decide(gate.gateId, { optionId: 'allow-once' }), first)
  await coordinator.resumePromises.get(gate.gateId)
  assert.deepEqual(coordinator.decide(gate.gateId, { optionId: 'allow-once' }), first)
  assert.equal(resumed, 1)
  assert.equal(orphaned, 1)
  assert.throws(() => coordinator.decide(gate.gateId, { optionId: 'reject-once' }))
})

test('aborting a waiter rejects the request and durably selects a reject option', async (t) => {
  const { coordinator } = fixture(t)
  const controller = new AbortController()
  const waiting = coordinator.wait(request(), { signal: controller.signal })
  const [pending] = coordinator.list({ pendingOnly: true })
  controller.abort()

  await assert.rejects(waiting, { message: 'LOCAL_AGENT_EXECUTION_STOPPED' })
  assert.equal(coordinator.list({ pendingOnly: true }).length, 0)
  assert.deepEqual(coordinator.list().find(gate => gate.gateId === pending.gateId)?.decision, {
    status: 'rejected',
    optionId: 'reject-once',
    actorId: 'meldwork-system',
    decidedAt: '2026-08-04T00:00:00.000Z',
  })
})

test('restart reconciliation durably rejects a pending gate without a live Run waiter', (t) => {
  const { coordinator, store } = fixture(t)
  store.create({
    ...request({ rejectOption: false }),
    createdAt: '2026-08-04T00:00:00.000Z',
  })
  const restarted = new HumanGateCoordinator({
    store,
    now: () => '2026-08-04T00:01:00.000Z',
  })
  const [reconciled] = restarted.reconcileOrphans()
  assert.equal(restarted.list({ pendingOnly: true }).length, 0)
  assert.deepEqual(reconciled.decision, {
    status: 'rejected',
    optionId: 'meldwork-system-reject',
    actorId: 'meldwork-system',
    decidedAt: '2026-08-04T00:01:00.000Z',
  })
})

test('keeps a live waiter pending until continuation persistence succeeds and retries', async (t) => {
  let checkpointAttempts = 0
  const { coordinator } = fixture(t, {
    onResumed: () => {
      checkpointAttempts += 1
      if (checkpointAttempts === 1) throw new Error('LOCAL_RUN_PERSIST_FAILED')
    },
  })
  let settled = false
  const waiting = coordinator.wait(request()).then((decision) => {
    settled = true
    return decision
  })
  const [pending] = coordinator.list({ pendingOnly: true })

  assert.throws(() => coordinator.decide(pending.gateId, {
    status: 'approved', optionId: 'allow-once',
  }), { message: 'LOCAL_RUN_PERSIST_FAILED' })
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(coordinator.list({ pendingOnly: true })[0].gateId, pending.gateId)

  const decided = coordinator.decide(pending.gateId, { optionId: 'allow-once' })
  assert.equal(decided.status, 'approved')
  assert.equal((await waiting).status, 'approved')
  assert.equal(checkpointAttempts, 2)
  assert.equal(coordinator.list({ pendingOnly: true }).length, 0)
})

test('keeps an explicit rejection pending until continuation persistence succeeds', async (t) => {
  let checkpointAttempts = 0
  const { coordinator } = fixture(t, {
    onResumed: () => {
      checkpointAttempts += 1
      if (checkpointAttempts === 1) throw new Error('LOCAL_RUN_PERSIST_FAILED')
    },
  })
  let settled = false
  const waiting = coordinator.wait(request()).then((decision) => {
    settled = true
    return decision
  })
  const [pending] = coordinator.list({ pendingOnly: true })

  assert.throws(() => coordinator.decide(pending.gateId, {
    status: 'rejected', optionId: 'reject-once',
  }), { message: 'LOCAL_RUN_PERSIST_FAILED' })
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(coordinator.list({ pendingOnly: true })[0].gateId, pending.gateId)

  const decided = coordinator.decide(pending.gateId, { optionId: 'reject-once' })
  assert.equal(decided.status, 'rejected')
  assert.equal((await waiting).status, 'rejected')
  assert.equal(checkpointAttempts, 2)
})

test('derives reopen as rejected and fails closed on renderer status mismatches', async (t) => {
  const { coordinator } = fixture(t)
  const waiting = coordinator.wait({
    ...request(),
    type: 'decision',
    options: [
      { optionId: 'accept-artifact', name: 'Accept Artifact', kind: 'accept' },
      { optionId: 'reject-artifact', name: 'Reject Artifact', kind: 'reject' },
      { optionId: 'reopen-task', name: 'Reopen Task', kind: 'reopen' },
    ],
  })
  const [pending] = coordinator.list({ pendingOnly: true })

  assert.throws(() => coordinator.decide(pending.gateId, {
    status: 'approved', optionId: 'reopen-task',
  }), { message: 'HUMAN_GATE_DECISION_INVALID' })
  assert.equal(coordinator.list({ pendingOnly: true }).length, 1)

  const decided = coordinator.decide(pending.gateId, { optionId: 'reopen-task' })
  assert.equal(decided.status, 'rejected')
  assert.deepEqual(await waiting, {
    status: 'rejected',
    optionId: 'reopen-task',
    actorId: 'local-user',
    decidedAt: '2026-08-04T00:00:00.000Z',
  })
})

test('aborted waiters leave a retryable pending gate when rejection persistence fails', async (t) => {
  let checkpointAttempts = 0
  const { coordinator } = fixture(t, {
    onResumed: () => {
      checkpointAttempts += 1
      if (checkpointAttempts === 1) throw new Error('LOCAL_RUN_PERSIST_FAILED')
    },
  })
  const controller = new AbortController()
  const waiting = coordinator.wait(request(), { signal: controller.signal })
  const [pending] = coordinator.list({ pendingOnly: true })

  controller.abort()

  await assert.rejects(waiting, { message: 'LOCAL_AGENT_EXECUTION_STOPPED' })
  assert.equal(coordinator.list({ pendingOnly: true })[0].gateId, pending.gateId)
  const decided = coordinator.decide(pending.gateId, { optionId: 'reject-once' })
  assert.equal(decided.status, 'rejected')
  assert.equal(checkpointAttempts, 2)
})

test('expires a live Gate through the same durable rejection continuation', async (t) => {
  const resumed = []
  const { coordinator } = fixture(t, {
    onResumed: (_record, decision) => resumed.push(decision),
  })
  const decision = await coordinator.wait({
    ...request(),
    expiresAt: '2026-08-03T23:59:59.000Z',
  }, {
    continuation: {
      resumeKind: 'agent_slot', agentRunId: 'agent-run-1', agentKind: 'codex', round: 0,
    },
  })

  assert.equal(decision.status, 'rejected')
  assert.equal(decision.actorId, 'meldwork-system')
  assert.equal(coordinator.list({ pendingOnly: true }).length, 0)
  assert.equal(resumed.length, 1)
})

test('restart reconciliation expires a resumable orphan exactly once', async (t) => {
  const { store } = fixture(t)
  const record = store.create({
    ...request(),
    createdAt: '2026-08-03T23:00:00.000Z',
    expiresAt: '2026-08-03T23:59:59.000Z',
  })
  let resumed = 0
  const restarted = new HumanGateCoordinator({
    store,
    now: () => '2026-08-04T00:00:00.000Z',
    canResume: candidate => candidate.gateId === record.gateId,
    onOrphanDecision: () => { resumed += 1 },
  })

  const [expired] = restarted.reconcileOrphans()
  await new Promise(resolve => setImmediate(resolve))
  restarted.reconcileOrphans()

  assert.equal(expired.status, 'rejected')
  assert.equal(expired.decision.actorId, 'meldwork-system')
  assert.equal(resumed, 1)
})

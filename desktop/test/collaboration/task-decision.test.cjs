const test = require('node:test')
const assert = require('node:assert/strict')
const { parseTaskDecision } = require('../../src/collaboration/task-decision.cjs')

test('explicit next participants survive normalization without changing legacy decisions', () => {
  const legacy = { status: 'continue', reason: 'More evidence is needed.', deliverables: [] }
  assert.deepEqual(parseTaskDecision(legacy), legacy)
  for (const nextKinds of [[], ['hermes'], ['hermes', 'codex']]) {
    const decision = { ...legacy, nextKinds }
    assert.deepEqual(parseTaskDecision(decision), decision)
    assert.notStrictEqual(parseTaskDecision(decision).nextKinds, nextKinds)
  }
  assert.deepEqual(parseTaskDecision({ ...legacy, nextKinds: ['OpenClaw'] }).nextKinds, ['openclaw'])
  const fullGroup = Array.from({ length: 32 }, (_, i) => `agent-${i}`)
  assert.deepEqual(parseTaskDecision({ ...legacy, nextKinds: fullGroup }).nextKinds, fullGroup)
  for (const nextKinds of ['hermes', ['@hermes'], ['hermes', 'HERMES'], [null], [''], ['two words'],
    [...fullGroup, 'agent-32']]) {
    assert.throws(() => parseTaskDecision({ ...legacy, nextKinds }), /LOCAL_RUN_TASK_DECISION_INVALID/)
  }
  assert.throws(() => parseTaskDecision({ ...legacy, status: 'completed',
    deliverables: ['Result'], nextKinds: ['hermes'] }), /LOCAL_RUN_TASK_DECISION_INVALID/)
})

test('completion requires an explicit reason and deliverable evidence', () => {
  const decision = { status: 'completed', reason: 'Checked the requested output.', deliverables: ['result.txt'] }
  assert.deepEqual(parseTaskDecision(decision), decision)
  for (const input of [
    { ...decision, deliverables: [] },
    { ...decision, reason: ' ' },
    { ...decision, deliverables: [''] },
    { ...decision, status: 'success' },
    { ...decision, extra: true },
    { ...decision, handoffTo: 'other' },
  ]) assert.throws(() => parseTaskDecision(input), /LOCAL_RUN_TASK_DECISION_INVALID/)
})

test('unfinished decisions permit no deliverable and continuation permits an explicit handoff', () => {
  for (const status of ['continue', 'blocked', 'needs-human']) {
    const decision = { status, reason: 'More input is needed.', deliverables: [] }
    assert.deepEqual(parseTaskDecision(decision), decision)
  }
  const decision = { status: 'continue', reason: 'Review the output.', deliverables: [], handoffTo: 'custom-agent' }
  assert.deepEqual(parseTaskDecision(decision), decision)
  assert.throws(() => parseTaskDecision({ ...decision, handoffTo: '@ghost' }), /LOCAL_RUN_TASK_DECISION_INVALID/)
})

test('task decisions reject malformed and oversized payloads', () => {
  const decision = { status: 'continue', reason: 'Continue.', deliverables: [] }
  for (const input of [
    null, [], 'completed',
    { ...decision, reason: 'x'.repeat(1601) },
    { ...decision, reason: 'bad\u0000input' },
    { ...decision, deliverables: 'output' },
    { ...decision, deliverables: Array(17).fill('output') },
    { ...decision, deliverables: ['x'.repeat(801)] },
    { ...decision, deliverables: [42] },
  ]) assert.throws(() => parseTaskDecision(input), /LOCAL_RUN_TASK_DECISION_INVALID/)
})

test('lenient task decisions accept common hand-written slips', () => {
  const { normalizeTaskDecision, parseLenientTaskDecision } = require('../../src/collaboration/task-decision.cjs')
  assert.deepEqual(parseLenientTaskDecision({ status: 'Done', reason: 'Answered.' }), {
    status: 'completed', reason: 'Answered.', deliverables: ['The answer in this message'],
  })
  assert.deepEqual(parseLenientTaskDecision({
    status: 'in_progress', reason: 'Need review', deliverables: 'draft.md',
    nextKinds: ['@Hermes', 'hermes', 'Codex'], handoffTo: '@OpenClaw', note: 'extra key',
  }), {
    status: 'continue', reason: 'Need review', deliverables: ['draft.md'],
    handoffTo: 'openclaw', nextKinds: ['hermes', 'codex'],
  })
  // Requests only make sense while continuing; an explicit list is kept empty.
  assert.deepEqual(normalizeTaskDecision({ status: 'blocked', reason: 'No access', nextKinds: ['hermes'] }).nextKinds, [])
  assert.equal(parseLenientTaskDecision({ status: 'continue' }, { fallbackReason: 'Summary text' }).reason, 'Summary text')
  assert.throws(() => parseLenientTaskDecision({ status: 'maybe', reason: 'x' }), /LOCAL_RUN_TASK_DECISION_INVALID/)
})

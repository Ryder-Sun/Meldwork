const test = require('node:test')
const assert = require('node:assert/strict')
const {
  InvocationSession,
  connectorSessionBinding,
  createdSessionProvenance,
} = require('../../src/workspace/invocation-session.cjs')

function sessionFor({ kind = 'codex', conversationType = 'group', stored = {} } = {}) {
  const state = {
    sessions: { 'group-1:codex': 'native-1', ...stored.sessions },
    sessionMeta: { 'group-1:codex': { turns: 2, transport: 'acp' }, ...stored.sessionMeta },
  }
  const persisted = []
  const session = new InvocationSession({
    resolved: {
      key: 'group-1:codex',
      sessionRef: state.sessions['group-1:codex'],
      sessionMeta: state.sessionMeta['group-1:codex'],
      provenance: createdSessionProvenance('task-1'),
    },
    group: { id: 'group-1', conversationType },
    kind,
    taskId: 'task-9',
    deps: {
      commitSessionState: mutator => mutator(state),
      openClawSessionRef: (group, generation, taskId) => `openclaw:${group.id}:${generation.length}:${taskId}`,
      persistSessionState: (...args) => persisted.push(args),
    },
  })
  return { session, state, persisted }
}

test('a stored native session is resumed with its transport', () => {
  const { session } = sessionFor()
  assert.equal(session.ref, 'native-1')
  assert.equal(session.storedRef, 'native-1')
  assert.equal(session.transport, 'acp')
  assert.equal(session.rotated, false)
  assert.equal(session.meta.turns, 2)
})

test('discarding forgets the stored session and marks the turn as rebuilt', () => {
  const { session, state } = sessionFor()
  session.discard()
  assert.equal(session.ref, '')
  assert.equal(session.transport, '')
  assert.equal(session.rotated, true)
  assert.deepEqual(session.meta, {})
  assert.equal(session.provenance.originTaskId, 'task-9')
  assert.equal('group-1:codex' in state.sessions, false)
  assert.equal('group-1:codex' in state.sessionMeta, false)
})

test('OpenClaw gets a fresh named session straight away', () => {
  const group = sessionFor({ kind: 'openclaw' })
  group.session.discard()
  assert.match(group.session.ref, /^openclaw:group-1:12:task-9$/)
  assert.equal(group.state.sessions['group-1:codex'], group.session.ref)

  const direct = sessionFor({ kind: 'openclaw', conversationType: 'direct' })
  direct.session.discard()
  assert.match(direct.session.ref, /^openclaw:group-1:12:$/)
})

test('adopting a session id persists it with the provenance and a known transport only', () => {
  const { session, persisted } = sessionFor()
  session.adopt('native-2', { transport: 'legacy' })
  assert.equal(session.ref, 'native-2')
  assert.equal(session.transport, 'legacy')
  assert.equal(persisted.at(-1)[0], 'group-1:codex')
  assert.equal(persisted.at(-1)[1], 'native-2')
  assert.equal(persisted.at(-1)[2].transport, 'legacy')

  session.adopt('native-3', { transport: 'carrier-pigeon' })
  assert.equal(session.transport, 'legacy')
})

test('completing a turn stores the id the Agent returned, or keeps the current one', () => {
  const { session, persisted } = sessionFor()
  session.complete('native-9', { promptChars: 10, replyChars: 5, rotated: false, transport: 'acp' })
  assert.equal(persisted.at(-1)[1], 'native-9')
  assert.equal(persisted.at(-1)[2].turns, 3)
  session.complete('', { promptChars: 1, replyChars: 1 })
  assert.equal(persisted.at(-1)[1], 'native-1')
})

test('the binding changes with the native session so a decision cannot move to another one', () => {
  const { session } = sessionFor()
  const before = session.binding()
  assert.deepEqual(before, connectorSessionBinding('native-1', session.provenance))
  session.ref = 'native-2'
  assert.notEqual(session.binding().sessionRefHash, before.sessionRefHash)
  assert.equal(session.binding().sessionProvenanceHash, before.sessionProvenanceHash)
})

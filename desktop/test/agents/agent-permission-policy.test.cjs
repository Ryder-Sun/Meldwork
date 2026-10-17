const test = require('node:test')
const assert = require('node:assert/strict')
const { automaticPermissionResponse } = require('../../src/agents/agent-permission-policy.cjs')

const options = [
  { optionId: 'allow-always', kind: 'allow_always', name: 'Always' },
  { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
  { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
]

test('read-only turns approve only tools without side effects', () => {
  for (const kind of ['read', 'search', 'fetch', 'think']) {
    assert.deepEqual(
      automaticPermissionResponse({ toolCall: { kind }, options }, { allowWrite: false }),
      { status: 'approved', optionId: 'allow' },
      kind,
    )
  }
  for (const kind of ['edit', 'delete', 'move', 'execute', 'switch_mode', 'other', undefined]) {
    assert.deepEqual(
      automaticPermissionResponse({ toolCall: { kind }, options }, { allowWrite: false }),
      { status: 'rejected', optionId: 'reject' },
      String(kind),
    )
  }
})

test('a refused request without a reject option is answered with null instead of the user gate', () => {
  assert.equal(automaticPermissionResponse({
    toolCall: { kind: 'execute' },
    options: [{ optionId: 'allow', kind: 'allow_once' }],
  }, { allowWrite: false }), null)
})

test('writable turns approve everything the Agent offers, preferring a one-time allow', () => {
  assert.deepEqual(
    automaticPermissionResponse({ toolCall: { kind: 'execute' }, options }, { allowWrite: true }),
    { status: 'approved', optionId: 'allow' },
  )
  assert.deepEqual(
    automaticPermissionResponse({
      toolCall: { kind: 'edit' },
      options: [{ optionId: 'only', kind: 'something_else' }],
    }, { allowWrite: true }),
    { status: 'approved', optionId: 'only' },
  )
})

test('with nothing to choose the caller must ask the user', () => {
  assert.equal(
    automaticPermissionResponse({ toolCall: { kind: 'read' }, options: [] }, { allowWrite: false }),
    undefined,
  )
  assert.equal(automaticPermissionResponse(null, { allowWrite: true }), undefined)
})

const test = require('node:test')
const assert = require('node:assert/strict')
const { sharedContextExcerpt } = require('../../src/workspace/shared-context-excerpt.cjs')
const { packNaturalDiscussionTranscript, v4Snapshot, v4Prompt } = require('../../src/workspace/local-workspace-context.cjs')

test('extractive context retains middle constraints, decisions, evidence and unresolved contradictions', () => {
  const facts = ['Constraint: budget must not exceed 500.', 'Decision: use option B, not option A.', 'Evidence: https://example.org/report section 7.', 'Unresolved conflict: supplier cannot meet 2026-11-01.']
  const text = ['Opening context.', ...Array(50).fill('Background detail without a decision.'), ...facts, ...Array(50).fill('Repeated generic discussion.'), 'Closing handoff: verify the conflict.'].join('\n')
  const result = sharedContextExcerpt(text, 1300)
  assert.equal(result.excerpted, true)
  assert.ok(result.text.length <= 1300)
  for (const fact of facts) assert.ok(result.text.includes(fact), fact)
  assert.match(result.text, /do not infer agreement/)
})

test('compaction fairly represents all 32 peers, stays within budget and never acknowledges excerpts as full messages', () => {
  const entries = Array.from({ length: 32 }, (_, index) => ({ id: `message-${index}`, agentKind: `peer-${index}`, round: 1,
    text: `Evidence peer-${index}: source-${index}.\n${'Repeated background.\n'.repeat(500)}\nUnresolved peer-${index}: verify result.` }))
  const packed = packNaturalDiscussionTranscript(entries, { withEntries: true })
  assert.ok(packed.text.length <= 16000)
  for (let index = 0; index < 32; index++) {
    assert.ok(packed.text.includes(`@peer-${index} [`))
    assert.ok(packed.text.includes(`Unresolved peer-${index}`))
  }
  assert.deepEqual(packed.completeMessageIds, [])
  assert.equal(packed.excerptedMessageIds.length, 32)
  assert.ok(packed.deliveredChars / packed.sourceChars < 0.1)
})

test('all peers receive one frozen task and history identity, including early user constraints', () => {
  const group = { id: 'group', name: 'Shared', topic: 'Review' }
  const messages = Array.from({ length: 30 }, (_, index) => ({ id: `m-${index}`, groupId: group.id, role: index % 3 ? 'agent' : 'user', content: index === 0 ? 'Never publish private data. Budget limit: 500.' : `Historical turn ${index}.` }))
  const message = { id: 'current', groupId: group.id, role: 'user', content: 'Compare the proposals and list unresolved disagreements.' }
  const kinds = ['codex', 'hermes', 'workbuddy']
  const snapshot = v4Snapshot({ state: { messages: [...messages, message] }, group, taskId: message.id, targetKinds: kinds, message, skillHintsByKind: new Map() })
  assert.ok(snapshot.history.some(item => item.id === 'm-0'))
  assert.ok(snapshot.history.length <= 16)
  const original = JSON.stringify(snapshot)
  for (const kind of kinds) {
    const prompt = v4Prompt({ group, kind, snapshot, naturalResponse: true, phase: 'proposal' })
    assert.ok(prompt.includes(message.content))
    assert.match(prompt, /Never publish private data/)
    assert.match(prompt, /Budget limit: 500/)
    assert.equal(JSON.stringify(snapshot), original)
  }
})

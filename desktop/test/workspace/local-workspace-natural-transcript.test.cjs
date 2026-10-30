const test = require('node:test')
const assert = require('node:assert/strict')
const { packNaturalDiscussionTranscript, v4Prompt } = require('../../src/workspace/local-workspace-context.cjs')
const { LocalWorkspaceAutoRunner } = require('../../src/workspace/local-workspace-auto-runner.cjs')

function entry(index, agentKind, text) {
  return { id: `message-${index}`, round: index + 1, agentKind, text }
}

test('Natural proposal follows the group write authorization while allowing network research', () => {
  for (const kind of ['codex', 'hermes', 'local-example']) {
    const input = { group: {}, kind, snapshot: { taskText: 'Write result.txt' }, naturalResponse: true }
    const proposal = v4Prompt({ ...input, phase: 'proposal' })
    assert.match(proposal, /This invocation is read-only/u)
    assert.match(proposal, /Deliver the actual answer or complete implementation draft/u)
    assert.match(proposal, /Network search and fetching remain allowed/u)
    const writable = v4Prompt({ ...input, group: { allowWrite: true }, phase: 'proposal' })
    assert.match(writable, /user enabled workspace writes/iu)
    assert.match(writable, /including network research, commands and configured plugins/u)
    assert.doesNotMatch(writable, /This invocation is read-only/u)
    assert.doesNotMatch(v4Prompt({ ...input, phase: 'discussion' }), /independent first-round deliverable/u)
  }
})

test('Natural handoff tells every participant to return control to the outer scheduler', () => {
  const kinds = ['codex', 'hermes', 'local-example']
  for (const kind of kinds) {
    const prompt = LocalWorkspaceAutoRunner.prototype.v4NaturalPhasePrompt.call({},
      {}, kind, 'discussion', { taskText: 'Collaborate on the task.' }, [], kinds,
      { allowRouting: true, ownerKind: kinds[0] },
    )
    assert.match(prompt, /Selected peers are external Meldwork participants/u)
    assert.match(prompt, /Meldwork dispatches requested peers only after this invocation completes/u)
    assert.match(prompt, /Put the request in your final response and finish this invocation/u)
  }
})

test('Natural transcript retains complete short contributions in chronological order', () => {
  const entries = ['one', 'two', 'three'].map((kind, index) => entry(
    index, kind, `${kind}-opening\n${'x'.repeat(900)}\n${kind}-closing`,
  ))
  const text = packNaturalDiscussionTranscript(entries)
  assert.doesNotMatch(text, /partial|omitted/u)
  for (const item of entries) assert.ok(text.includes(item.text))
  assert.ok(text.indexOf('one-opening') < text.indexOf('three-opening'))
  assert.equal(packNaturalDiscussionTranscript([]), '')
})

test('Natural transcript stays bounded and prioritizes the latest contribution of a quiet peer', () => {
  const entries = [entry(0, 'quiet-peer', `QUIET_EVIDENCE\n${'q'.repeat(3000)}`)]
  for (let index = 1; index < 45; index += 1) {
    entries.push(entry(index, 'active-peer', `OLDER_${index}\n${'x'.repeat(4000)}`))
  }
  entries.push(entry(45, 'active-peer', 'NEWEST_HANDOFF: @quiet-peer verify the original evidence.'))
  const text = packNaturalDiscussionTranscript(entries)
  assert.ok(text.length <= 16000)
  assert.match(text, /This transcript is partial/u)
  assert.match(text, /Omission is not evidence of agreement or completion/u)
  assert.match(text, /QUIET_EVIDENCE/u)
  assert.match(text, /NEWEST_HANDOFF/u)
  assert.ok(text.indexOf('QUIET_EVIDENCE') < text.indexOf('NEWEST_HANDOFF'))
  assert.ok(entries[1].text.includes('OLDER_1'))
})

test('Oversized contributions preserve closing handoffs and mark the omitted middle', () => {
  const original = `OPENING_FINDING\n${'x'.repeat(100000)}\n@peer CLOSE_WITH_REQUEST`
  const text = packNaturalDiscussionTranscript([entry(0, 'author', original)])
  assert.ok(text.length <= 16000)
  assert.match(text, /OPENING_FINDING/u)
  assert.match(text, /Excerpt: omitted text/u)
  assert.match(text, /@peer CLOSE_WITH_REQUEST/u)
  assert.match(text, /Ask peers to restate any missing evidence/u)
})

test('Natural transcript cannot grow without bound through many tiny turns', () => {
  const entries = Array.from({ length: 1200 }, (_, index) => entry(index, 'peer', `TURN_${index}`))
  const text = packNaturalDiscussionTranscript(entries)
  assert.ok(text.length <= 16000)
  assert.match(text, /This transcript is partial/u)
  assert.match(text, /TURN_1199/u)
  assert.doesNotMatch(text, /TURN_0\n/u)
  assert.equal((text.match(/Round /gu) || []).length, 100)
})

test('Natural full-text recovery rejects foreign or unavailable artifacts and marks the fallback as partial', () => {
  const prefix = 'x'.repeat(20000)
  const message = {
    content: prefix, agentKind: 'codex',
    trace: { runId: 'run-1', agentRunId: 'agent-run-1', context: { outcomeRefs: { artifactIds: ['artifact-1'] } } },
  }
  const valid = {
    content: `${prefix}\nACTUAL_TAIL`,
    artifact: { name: 'codex-conclusion.txt', producedBy: { runId: 'run-1', agentRunId: 'agent-run-1', agentKind: 'codex' } },
  }
  const recover = identity => LocalWorkspaceAutoRunner.prototype.v4NaturalMessageContent.call({
    v4ArtifactIdentity: () => {
      if (!identity) throw new Error('LOCAL_RUN_V4_CANDIDATE_INVALID')
      return identity
    },
  }, message)
  assert.deepEqual(recover(valid), { text: valid.content, partial: false })
  const invalid = [null, { ...valid, content: 'FOREIGN_BODY' },
    { ...valid, artifact: { ...valid.artifact, name: 'other-output.txt' } },
    ...['runId', 'agentRunId', 'agentKind'].map(field => ({
      ...valid, artifact: { ...valid.artifact, producedBy: { ...valid.artifact.producedBy, [field]: 'foreign' } },
    })),
  ]
  for (const identity of invalid) {
    const result = recover(identity)
    assert.deepEqual(result, { text: prefix, partial: true })
    assert.match(packNaturalDiscussionTranscript([{ ...entry(0, 'codex', result.text), partial: result.partial }]), /This transcript is partial/u)
  }
  message.content = prefix.slice(0, -1)
  message.trace.truncated = true
  assert.deepEqual(recover(valid), { text: valid.content, partial: false })
})

test('Missing full text cannot prove that a long discussion is repeating', () => {
  const messages = Array.from({ length: 10 }, (_, index) => ({
    groupId: 'group', threadRootId: 'thread', role: 'agent', agentKind: 'codex',
    content: 'x'.repeat(20000), trace: { runId: 'run', phase: 'discussion', round: index + 1 },
  }))
  const runner = {
    state: () => ({ messages }),
    v4NaturalMessageMatchesBinding: () => true,
    v4NaturalMessageContent: LocalWorkspaceAutoRunner.prototype.v4NaturalMessageContent,
  }
  assert.equal(LocalWorkspaceAutoRunner.prototype.v4NaturalDiscussionIsRepeating.call(
    runner, { id: 'group' }, { runId: 'run' }, 'thread', 10, ['codex'],
  ), false)
})

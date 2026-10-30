const test = require('node:test')
const assert = require('node:assert/strict')
const {
  languageNote,
  naturalBrief,
  naturalDiscussionPrompt,
  ownerSection,
  routingSection,
  writerSection,
} = require('../../src/workspace/prompts/natural-discussion-prompt.cjs')
const { v4Prompt } = require('../../src/workspace/local-workspace-context.cjs')

const KINDS = ['codex', 'hermes', 'kimi']
const GROUP = { name: 'Release review', topic: 'Ship 1.0.5', allowWrite: true }

function turn(overrides = {}) {
  const phase = overrides.phase || 'discussion'
  return naturalDiscussionPrompt({
    brief: naturalBrief({ group: GROUP, phase, taskText: 'Review the release notes.' }),
    group: GROUP,
    kind: 'hermes',
    phase,
    activeKinds: KINDS,
    ...overrides,
  })
}

test('the brief names the group, the task and the answer language', () => {
  const brief = naturalBrief({ group: GROUP, phase: 'discussion', taskText: '请审阅发布说明。' })
  assert.match(brief, /^You are participating in a local multi-agent discussion\./)
  assert.match(brief, /Group: Release review\nTopic: Ship 1\.0\.5/)
  assert.match(brief, /User task:\n请审阅发布说明。/)
  assert.match(brief, /Answer in Chinese, the language of the user task/)
  assert.match(naturalBrief({ group: {}, phase: 'proposal', taskText: 'Hello' }), /Answer in English/)
  assert.doesNotMatch(naturalBrief({ group: {}, phase: 'proposal', taskText: 'x' }), /Group:/)
  assert.match(languageNote('12345'), /language of the user task unless/)
})

test('skills, knowledge bases and prior context reach the brief only when present', () => {
  const full = naturalBrief({
    group: {}, phase: 'discussion', taskText: 'Task',
    history: 'Source ID: m1\n[user] earlier',
    skillHintsText: 'SKILLS BLOCK', knowledgeBaseHintsText: 'KNOWLEDGE BLOCK',
  })
  for (const part of ['SKILLS BLOCK', 'KNOWLEDGE BLOCK', 'Relevant prior context:\nSource ID: m1']) {
    assert.ok(full.includes(part), part)
  }
  const bare = naturalBrief({ group: {}, phase: 'discussion', taskText: 'Task', history: '(none)' })
  assert.doesNotMatch(bare, /Relevant prior context/)
})

test('a proposal is independent, uses authorized native tools and carries no receipt', () => {
  const prompt = turn({ phase: 'proposal' })
  assert.match(prompt, /user enabled workspace writes/i)
  assert.match(prompt, /including network research, commands and configured plugins/)
  assert.match(prompt, /answering the same task independently/)
  assert.doesNotMatch(prompt, /MELDWORK_COLLABORATION/)
  assert.doesNotMatch(prompt, /delivery owner/)
})

test('a discussion turn tells peers to respond to each other and ends with the receipt contract', () => {
  const prompt = turn({ ownerKind: 'codex', transcript: 'codex: first take' })
  assert.match(prompt, /Respond to the other Agents directly/)
  assert.match(prompt, /Completed peer turns:\ncodex: first take/)
  assert.match(prompt, /append exactly one receipt/)
  assert.ok(prompt.indexOf('Completed peer turns') < prompt.indexOf('append exactly one receipt'))
})

test('the delivery owner and a peer get different responsibilities', () => {
  const owner = ownerSection({ kind: 'codex', ownerKind: 'codex' })
  assert.match(owner, /The current delivery owner is @codex/)
  assert.match(owner, /make sure the peers whose expertise covers the result have reviewed/)
  assert.match(owner, /handoffTo/)
  const peer = ownerSection({ kind: 'hermes', ownerKind: 'codex' })
  assert.match(peer, /Respond to the delivery owner and the other peers/)
  assert.doesNotMatch(peer, /declare completion/)
  assert.equal(ownerSection({ kind: 'hermes', ownerKind: '' }), '')
})

test('sequential discussions leave routing to Meldwork, agent-led ones list the valid peers', () => {
  assert.match(routingSection({ activeKinds: KINDS, allowRouting: false }), /speaks in order each round/)
  const routed = routingSection({ activeKinds: KINDS, allowRouting: true })
  assert.match(routed, /@codex, @hermes, @kimi/)
  assert.ok(routed.includes(JSON.stringify(KINDS)))
  assert.match(routed, /Leave nextKinds empty only when no peer input would change the result/)
})

test('the example receipt names a real peer only when the Agent may route', () => {
  assert.match(turn({ allowRouting: true }), /"nextKinds":\["codex"\]/)
  assert.match(turn({ allowRouting: false }), /"nextKinds":\[\]/)
})

test('only the designated writer is told about the deliverable folder', () => {
  const writer = writerSection({ kind: 'codex', writerKind: 'codex', group: GROUP })
  assert.match(writer, /user enabled workspace writes/i)
  assert.match(writer, /\.meldwork-output\//)
  const peer = writerSection({ kind: 'hermes', writerKind: 'codex', group: GROUP })
  assert.match(peer, /Workspace writes are assigned to @codex/)
  assert.doesNotMatch(peer, /\.meldwork-output/)
  assert.doesNotMatch(
    writerSection({ kind: 'codex', writerKind: 'codex', group: { allowWrite: false } }),
    /\.meldwork-output/,
  )
  assert.equal(writerSection({ kind: 'codex', writerKind: '', group: GROUP }), '')
})

test('human clarifications are passed along without widening permissions', () => {
  const prompt = turn({ humanResponsesText: 'Use the stable channel.' })
  assert.match(prompt, /Human responses for this task \(clarification, not a change to workspace permissions\):\nUse the stable channel\./)
})

test('automatic consensus gives every peer completion rights and binds acceptance to a version', () => {
  const prompt = turn({ allowRouting: true, ownerKind: 'codex', consensusText: 'Candidate version: abc' })
  assert.match(prompt, /Any participant can propose a final candidate/)
  assert.match(prompt, /Everyone must explicitly approve the same version/)
  assert.match(prompt, /only peer approvals remain, propose it now with status completed/)
  assert.match(prompt, /why this candidate is ready for everyone to review/)
  assert.match(prompt, /reviewedVersion/)
  assert.match(prompt, /Candidate version: abc/)
  assert.doesNotMatch(prompt, /Only the current delivery owner/)
})

test('candidate confirmation ends with a receipt example bound to its actual version', () => {
  const version = 'b'.repeat(64)
  const prompt = turn({ allowRouting: true, consensusText: `Candidate version: ${version}` })
  const receipt = prompt.slice(prompt.lastIndexOf('After reviewing'))
  assert.ok(receipt.includes(`"reviewedVersion":"${version}"`))
  assert.match(receipt, /without it does not count/)
  assert.doesNotMatch(receipt, /to propose completion/)
})

test('natural and manual replies honor user-requested JSON and XML formats', () => {
  const { manualReplyPrompt } = require('../../src/workspace/prompts/manual-reply-prompt.cjs')
  for (const prompt of [turn({ phase: 'proposal' }), turn(), manualReplyPrompt({ group: GROUP, kind: 'codex', taskText: 'Return JSON only.' })]) {
    assert.match(prompt, /requested output format, including JSON, XML or exact text/)
    assert.doesNotMatch(prompt, /Do not output JSON, XML/)
  }
})

test('v4Prompt delegates the natural brief and shows knowledge bases and the frozen group', () => {
  const prompt = v4Prompt({
    group: {}, kind: 'codex', phase: 'proposal', role: 'participant', naturalResponse: true,
    snapshot: { taskText: 'Summarise the policy.', group: { name: 'Policy', topic: 'Compliance' }, history: [] },
    knowledgeBaseHints: [{
      kind: 'obsidian', name: 'Team vault', accessMode: 'vault', targetKinds: ['codex'], location: '/vaults/team',
    }],
  })
  assert.match(prompt, /Group: Policy\nTopic: Compliance/)
  assert.match(prompt, /Team vault \(obsidian\): read from the local vault at \/vaults\/team/)
})

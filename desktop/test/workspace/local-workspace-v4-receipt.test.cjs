const test = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { runAgent: runCliAgent } = require('../../src/agents/cli/cli-adapters.cjs')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { parseV4CollaborationReceipt } = require('../../src/collaboration/collaboration-receipt.cjs')
const { v4Prompt } = require('../../src/workspace/local-workspace-context.cjs')
const {
  createLegacyOutboundPayload,
  outboundWirePayloadBytes,
} = require('../../src/collaboration/outbound-payload.cjs')
const { RunLedger } = require('../../src/runs/run-ledger.cjs')
const { executable } = require('../support/cli-adapters-test-helpers.cjs')
const { fixture } = require('../support/local-workspace-test-helpers.cjs')

function receiptFor(phase, summary) {
  if (phase === 'proposal') {
    return {
      version: 1,
      phase,
      summary,
      capabilities: ['Analyze the bounded task.'],
      intendedWork: ['Produce an independent proposal.'],
      deliverables: ['Proposal Artifact.'],
      dependencies: [],
    }
  }
  if (phase === 'synthesis') return { version: 1, phase, summary, resolvedIssueIds: [] }
  return { version: 1, phase, verdict: 'support', summary }
}

function runtimeReceiptFor(agentKind, phase, prompt, summary) {
  if (phase === 'challenge') {
    return {
      version: 1,
      phase,
      verdict: 'support',
      summary,
      proposedAssignments: [
        {
          taskId: 'codex-work', ownerKind: 'codex', role: 'worker',
          objective: 'Complete the independent work package.', expectedOutput: 'Work Artifact.',
          inputRefs: [], artifactIds: [], dependsOn: [],
        },
        {
          taskId: 'hermes-integration', ownerKind: 'hermes', role: 'integrator',
          objective: 'Integrate the agreed work package.', expectedOutput: 'Integrated Artifact.',
          inputRefs: [], artifactIds: [], dependsOn: ['codex-work'],
        },
      ],
      finalizerKind: 'hermes',
      verifierKinds: ['codex'],
      agreeToPlan: true,
    }
  }
  if (phase === 'work') {
    return {
      version: 1,
      phase,
      summary,
      workItemId: prompt.match(/^Work item: ([A-Za-z0-9._:-]+)$/m)?.[1] || '',
      deliverables: [`${agentKind} Artifact`],
    }
  }
  return receiptFor(phase, summary)
}

function blockMarker(receipt) {
  return `[[MELDWORK_COLLABORATION]]\n${JSON.stringify(receipt)}\n[[/MELDWORK_COLLABORATION]]`
}

function inlineMarker(receipt) {
  return `[[MELDWORK_COLLABORATION:${JSON.stringify(receipt)}]]`
}

test('V4 challenge receipts normalize a finalizer assignment role to integrator', () => {
  const receipt = runtimeReceiptFor('opencode', 'challenge', '', 'Shared plan')
  receipt.proposedAssignments[1].role = 'finalizer'

  const parsed = parseV4CollaborationReceipt({
    text: `OpenCode plan\n${inlineMarker(receipt)}`,
  }, true, 'challenge')

  assert.equal(parsed.text, 'OpenCode plan')
  assert.equal(parsed.collaboration.proposedAssignments[1].role, 'integrator')
})

function streamChunks(runOptions, value) {
  const widths = [1, 5, 2, 7, 3, 11]
  let start = 0
  let index = 0
  while (start < value.length) {
    const end = Math.min(value.length, start + widths[index % widths.length])
    runOptions.onEvent({ type: 'answer_delta', status: 'running', delta: value.slice(start, end) })
    start = end
    index += 1
  }
}

function storeTextArtifact(workspace, content, name) {
  const contentRef = workspace.contentBlobStore.put(content, { mediaType: 'text/plain' })
  return workspace.outcomeStore.putArtifact({
    type: 'document',
    name,
    producedBy: {
      runId: 'run-artifact-context-test',
      agentRunId: 'agent-run-artifact-context-test',
      agentKind: 'codex',
    },
    contentRef,
    contentHash: contentRef.hash,
  })
}

test('V4 downstream Artifact context includes every Artifact from a work receipt', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  const artifacts = [
    storeTextArtifact(workspace, 'FIRST_WORK_ARTIFACT_BODY', 'First work Artifact'),
    storeTextArtifact(workspace, 'SECOND_WORK_ARTIFACT_BODY', 'Second work Artifact'),
    storeTextArtifact(workspace, 'THIRD_WORK_ARTIFACT_BODY', 'Third work Artifact'),
  ]
  const coordinationPlan = {
    assignments: [
      { taskId: 'upstream-work', ownerKind: 'codex', dependsOn: [] },
      { taskId: 'downstream-work', ownerKind: 'hermes', dependsOn: ['upstream-work'] },
    ],
  }
  const receiptRecords = [{
    receipt: {
      phase: 'work', agentKind: 'codex', workItemId: 'upstream-work',
      artifactIds: artifacts.map(artifact => artifact.artifactId),
    },
  }]

  const first = workspace.autoRunner.v4ArtifactContext(
    receiptRecords, 'work', coordinationPlan, 'hermes', 3600, 'downstream-work',
  )
  const second = workspace.autoRunner.v4ArtifactContext(
    receiptRecords, 'work', coordinationPlan, 'hermes', 3600, 'downstream-work',
  )

  assert.equal(second, first)
  for (const artifact of artifacts) assert.match(first, new RegExp(artifact.artifactId))
  assert.match(first, /FIRST_WORK_ARTIFACT_BODY/)
  assert.match(first, /SECOND_WORK_ARTIFACT_BODY/)
  assert.match(first, /THIRD_WORK_ARTIFACT_BODY/)
})

test('V4 names every Artifact whose body is omitted by the delivery budget', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  const artifacts = [
    storeTextArtifact(workspace, `FIRST_${'a'.repeat(900)}`, 'First oversized Artifact'),
    storeTextArtifact(workspace, `SECOND_${'b'.repeat(900)}`, 'Second oversized Artifact'),
    storeTextArtifact(workspace, `THIRD_${'c'.repeat(900)}`, 'Third oversized Artifact'),
  ]
  const coordinationPlan = {
    assignments: [
      { taskId: 'upstream-work', ownerKind: 'codex', dependsOn: [] },
      { taskId: 'downstream-work', ownerKind: 'hermes', dependsOn: ['upstream-work'] },
    ],
  }
  const receiptRecords = [{
    receipt: {
      phase: 'work', agentKind: 'codex', workItemId: 'upstream-work',
      artifactIds: artifacts.map(artifact => artifact.artifactId),
    },
  }]

  const context = workspace.autoRunner.v4ArtifactContext(
    receiptRecords, 'work', coordinationPlan, 'hermes', 900, 'downstream-work',
  )

  assert.ok(context.length <= 900)
  for (const artifact of artifacts) assert.match(context, new RegExp(artifact.artifactId))
  assert.match(context, /MELDWORK_V4_OMITTED_ARTIFACT_BODIES_V1/)
  assert.match(context, /reason=budget/)
})

test('V4 receipt parser accepts only the phase receipt shape and strips its control tail', () => {
  const accepted = parseV4CollaborationReceipt({
    text: `Visible proposal\n${inlineMarker(receiptFor('proposal', 'Independent proposal.'))}`,
  }, true, 'proposal')
  assert.equal(accepted.text, 'Visible proposal')
  assert.deepEqual(accepted.collaboration, {
    ...receiptFor('proposal', 'Independent proposal.'),
  })
  for (const field of ['capabilities', 'intendedWork', 'deliverables', 'dependencies']) {
    const incomplete = receiptFor('proposal', `Missing ${field}.`)
    delete incomplete[field]
    assert.throws(
      () => parseV4CollaborationReceipt({ text: 'Visible proposal', collaboration: incomplete }, true, 'proposal'),
      /LOCAL_RUN_COLLABORATION_RECEIPT_INVALID/,
    )
  }
  for (const field of ['capabilities', 'intendedWork', 'deliverables']) {
    assert.throws(
      () => parseV4CollaborationReceipt({
        text: 'Visible proposal',
        collaboration: { ...receiptFor('proposal', `Empty ${field}.`), [field]: [] },
      }, true, 'proposal'),
      /LOCAL_RUN_COLLABORATION_RECEIPT_INVALID/,
    )
  }
  assert.throws(
    () => parseV4CollaborationReceipt({
      text: `Visible proposal\n${inlineMarker(receiptFor('proposal', 'First.'))}\n${inlineMarker(receiptFor('proposal', 'Second.'))}`,
    }, true, 'proposal'),
    /LOCAL_RUN_COLLABORATION_RECEIPT_INVALID/,
  )
  assert.throws(
    () => parseV4CollaborationReceipt({
      text: 'Visible review',
      collaboration: { version: 1, phase: 'challenge', verdict: 'support', summary: 'Review.' },
    }, true, 'verification'),
    /LOCAL_RUN_COLLABORATION_RECEIPT_INVALID/,
  )
  assert.throws(
    () => parseV4CollaborationReceipt({
      text: 'Visible proposal\n[[MELDWORK_COLLABORATION:not-json]]',
    }, true, 'proposal'),
    /LOCAL_RUN_COLLABORATION_RECEIPT_INVALID/,
  )
  assert.throws(
    () => parseV4CollaborationReceipt({
      text: `Visible proposal\n${inlineMarker(receiptFor('proposal', 'Tail receipt.'))}`,
      collaboration: receiptFor('proposal', 'Typed receipt.'),
    }, true, 'proposal'),
    /LOCAL_RUN_COLLABORATION_RECEIPT_MISMATCH/,
  )
  assert.throws(
    () => parseV4CollaborationReceipt({
      text: 'Visible proposal',
      collaboration: { version: 1, phase: 'proposal', summary: 'x'.repeat(801) },
    }, true, 'proposal'),
    /LOCAL_RUN_COLLABORATION_RECEIPT_INVALID/,
  )

  for (const collaboration of [
    null,
    { version: 1, phase: 'proposal', summary: 'Proposal.', status: 'completed' },
    { version: 1, phase: 'challenge', verdict: 'support', summary: 'Review.', unresolved: [] },
    { version: 1, phase: 'synthesis', summary: 'Conclusion.' },
  ]) {
    assert.throws(
      () => parseV4CollaborationReceipt({ text: 'Visible body', collaboration }, true, 'proposal'),
      /LOCAL_RUN_COLLABORATION_RECEIPT_(?:REQUIRED|INVALID)/,
    )
  }
})

test('V4 strips WorkBuddy protocol commentary around a valid terminal receipt', () => {
  const receipt = receiptFor('proposal', 'Independent proposal.')
  const englishMeta = [
    'This task is a coordination/self-introduction request within the MELDWORK framework, not a code implementation task.',
    "I've provided my introduction and the structured receipt marker above.",
    'No plan file or implementation planning is needed for this response.',
  ].join(' ')
  const chineseMeta = [
    '我已完成本阶段的提案输出（上方含结构化 receipt 标记）。',
    '鉴于本次 MELDWORK 任务为协作协调类文本产出，非代码实现任务，无需进入执行计划流程，故不调用 ExitPlanMode。',
    '我的提案与 receipt 标记即为本轮交付，等待后续质询/验证阶段的指令。',
  ].join('')

  for (const text of [
    `Normal user-facing proposal.\n\n${englishMeta}\n${inlineMarker(receipt)}`,
    `Normal user-facing proposal.\n${inlineMarker(receipt)}\n${chineseMeta}`,
  ]) {
    const parsed = parseV4CollaborationReceipt({ text }, true, 'proposal')
    assert.equal(parsed.text, 'Normal user-facing proposal.')
    assert.deepEqual(parsed.collaboration, receipt)
  }

  assert.throws(() => parseV4CollaborationReceipt({
    text: `First half.\n${inlineMarker(receipt)}\nSecond half of the user-facing proposal.`,
  }, true, 'proposal'), /LOCAL_RUN_COLLABORATION_RECEIPT_INVALID/)
})

test('Manual concurrent proposals preserve a valid visible response when a CLI omits its receipt', () => {
  const result = parseV4CollaborationReceipt({
    text: 'A complete user-facing response without a control block.',
  }, true, 'proposal', { allowMissingProposalReceipt: true })

  assert.equal(result.text, 'A complete user-facing response without a control block.')
  assert.deepEqual(result.collaboration, {
    version: 1,
    phase: 'proposal',
    summary: 'The Agent returned a visible proposal without a structured receipt.',
    capabilities: ['Delivered a user-facing proposal'],
    intendedWork: ['Addressed the current user task'],
    deliverables: ['Visible Agent response'],
    dependencies: [],
  })
  const malformed = parseV4CollaborationReceipt({
    text: 'A complete streamed response.\n\n[[MELDWORK_COLLABORATION:{"version":1',
  }, true, 'proposal', { allowMissingProposalReceipt: true })
  assert.equal(malformed.text, 'A complete streamed response.')
  assert.deepEqual(malformed.collaboration, {
    version: 1,
    phase: 'proposal',
    summary: 'The Agent returned a visible proposal without a valid structured receipt.',
    capabilities: ['Delivered a user-facing proposal'],
    intendedWork: ['Addressed the current user task'],
    deliverables: ['Visible Agent response'],
    dependencies: [],
  })
  assert.throws(
    () => parseV4CollaborationReceipt({ text: 'Visible body' }, true, 'challenge', {
      allowMissingProposalReceipt: true,
    }),
    /LOCAL_RUN_COLLABORATION_RECEIPT_REQUIRED/,
  )
})

test('Natural V4 responses may omit internal receipts without changing visible Markdown', () => {
  const result = parseV4CollaborationReceipt({
    text: '# Natural answer\n\nThe Agent explains the result in Markdown.',
  }, true, 'challenge', { allowMissingV4Receipt: true })

  assert.equal(result.text, '# Natural answer\n\nThe Agent explains the result in Markdown.')
  assert.equal(result.collaboration, null)
  assert.throws(
    () => parseV4CollaborationReceipt({ text: 'Natural answer' }, true, 'challenge'),
    /LOCAL_RUN_COLLABORATION_RECEIPT_REQUIRED/,
  )
})

test('Natural V4 prompts carry task context without exposing the receipt template', () => {
  const prompt = v4Prompt({
    group: { name: 'Local agents', topic: 'Discussion' },
    kind: 'pi',
    phase: 'proposal',
    role: 'participant',
    naturalResponse: true,
    snapshot: {
      taskText: 'Compare the available skills and suggest useful transfers.',
      targetKinds: ['codex', 'pi'],
      history: [],
    },
  })

  assert.match(prompt, /Compare the available skills/)
  assert.match(prompt, /requested output format, including JSON, XML or exact text/)
  assert.doesNotMatch(
    prompt,
    /current collaboration phase|your role|Receipt JSON shape|MELDWORK_COLLABORATION|MELDWORK_V4_FROZEN_SNAPSHOT_V1/i,
  )
})

test('Natural V4 challenge responses cannot fabricate a responsibility graph without a receipt', () => {
  const { directory, options } = fixture()
  const workspace = new LocalWorkspace({ ...options, naturalAgentResponses: true })
  try {
    const snapshotHash = 'a'.repeat(64)
    const controller = {
      targetKinds: ['pi', 'codex'],
      orchestration: {
        slots: [
          { agentKind: 'codex', phase: 'challenge', operationId: 'op-codex' },
          { agentKind: 'pi', phase: 'challenge', operationId: 'op-pi' },
        ],
      },
    }
    assert.throws(() => workspace.autoRunner.v4ReceiptForResult(
      { text: '## Review\n\nI support the shared direction.' },
      'challenge',
      'pi',
      { slotId: 'slot-pi', operationId: 'op-pi', deliveryWatermark: 0 },
      snapshotHash,
      { controller },
    ), /LOCAL_RUN_COLLABORATION_RECEIPT_REQUIRED/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('V4 preserves responsibility endorsements and assigned work item receipts', () => {
  const supportedPlanHash = 'a'.repeat(64)
  const challenge = parseV4CollaborationReceipt({
    text: 'I support the shared responsibility graph.',
    collaboration: {
      version: 1,
      phase: 'challenge',
      verdict: 'support',
      summary: 'Supports the shared graph.',
      supportedPlanHash,
      agreeToPlan: true,
    },
  }, true, 'challenge')
  assert.equal(challenge.collaboration.supportedPlanHash, supportedPlanHash)

  const work = parseV4CollaborationReceipt({
    text: 'Completed the assigned implementation package.',
    collaboration: {
      version: 1,
      phase: 'work',
      summary: 'Implementation package completed.',
      workItemId: 'implement-bounded-change',
      deliverables: ['Implementation Artifact'],
    },
  }, true, 'work')
  assert.equal(work.collaboration.workItemId, 'implement-bounded-change')
  assert.deepEqual(work.collaboration.deliverables, ['Implementation Artifact'])

  assert.throws(() => parseV4CollaborationReceipt({
    text: 'Invalid endorsement.',
    collaboration: {
      version: 1,
      phase: 'challenge',
      verdict: 'support',
      summary: 'Invalid hash.',
      supportedPlanHash: 'not-a-hash',
      agreeToPlan: true,
    },
  }, true, 'challenge'), /LOCAL_RUN_COLLABORATION_RECEIPT_INVALID/)
})

test('V4 rejects nonterminal collaboration controls case-insensitively', () => {
  for (const control of [
    '[[meldwork_collaboration:not-json]]',
    '[[Meldwork_Collaboration:{"summary":"not-terminal"}]]',
  ]) {
    assert.throws(
      () => parseV4CollaborationReceipt({
        text: `Visible body ${control} still visible.`,
        collaboration: receiptFor('proposal', 'Typed proposal.'),
      }, true, 'proposal'),
      /LOCAL_RUN_COLLABORATION_RECEIPT_INVALID/,
    )
  }
})

test('V4 rejects oversized typed receipts by canonical byte size', () => {
  const oversized = {
    version: 1,
    phase: 'synthesis',
    summary: 'Summary.',
    resolvedIssueIds: Array.from({ length: 16 }, () => '\u4e00'.repeat(800)),
  }
  assert.throws(
    () => parseV4CollaborationReceipt({ text: 'Visible synthesis.', collaboration: oversized }, true, 'synthesis'),
    /LOCAL_RUN_COLLABORATION_RECEIPT_INVALID/,
  )
})

test('V4 streams split receipts without exposing controls and commits the complete synthesis body', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const phaseCalls = []
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    phaseCalls.push({ agentKind: agent.kind, phase })
    const body = phase === 'synthesis'
      ? 'Visible synthesis conclusion.'
      : `${agent.kind} ${phase} visible body.`
    const legacyConsensus = phase === 'proposal' && agent.kind === 'codex'
      ? '\n[[MELDWORK_CONSENSUS:agree]]'
      : ''
    const receipt = runtimeReceiptFor(
      agent.kind, phase, prompt, `${agent.kind} ${phase} summary.`,
    )
    if (phase === 'challenge') {
      streamChunks(runOptions, body)
      return { text: body, collaboration: receipt, sessionRef: `${agent.kind}-${phase}` }
    }
    const marker = agent.kind === 'hermes' || phase === 'synthesis'
      ? blockMarker(receipt)
      : inlineMarker(receipt)
    streamChunks(runOptions, `${body}${legacyConsensus}\n${marker}`)
    return { text: `${body}${legacyConsensus}\n${marker}`, sessionRef: `${agent.kind}-${phase}` }
  }
  const events = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-event', event => events.push(event))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'V4 receipt streaming', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Produce one verified conclusion.',
    mode: 'auto',
    targetKinds: ['codex', 'hermes'],
    protocol: 'v4',
  })
  await workspace.activeRuns.get(group.id).promise

  const answerDeltas = events.filter(event => event.type === 'answer_delta')
    .map(event => event.delta)
    .join('')
  const verifierKind = phaseCalls.find(call => call.phase === 'verification')?.agentKind
  assert.ok(verifierKind)
  assert.doesNotMatch(answerDeltas, /MELDWORK_COLLABORATION|MELDWORK_CONSENSUS|"phase"|"summary"/)
  assert.equal(answerDeltas, [
    'codex proposal visible body.\n\n',
    'hermes proposal visible body.\n',
    'codex challenge visible body.',
    'hermes challenge visible body.',
    'codex work visible body.\n',
    'hermes work visible body.\n',
    'Visible synthesis conclusion.\n',
    `${verifierKind} verification visible body.\n`,
    'Visible synthesis conclusion.\n',
    `${verifierKind} verification visible body.\n`,
    'Visible synthesis conclusion.\n',
    `${verifierKind} verification visible body.\n`,
    'Visible synthesis conclusion.\n',
    `${verifierKind} verification visible body.\n`,
    'Visible synthesis conclusion.\n',
    `${verifierKind} verification visible body.\n`,
  ].join(''))
  assert.deepEqual(
    workspace.snapshot().messages.filter(message => message.role === 'agent').map(message => message.content),
    [
      'codex proposal visible body.',
      'hermes proposal visible body.',
      'codex challenge visible body.',
      'hermes challenge visible body.',
      'Visible synthesis conclusion.',
    ],
  )
})

test('V4 keeps multiline and long proposal bodies in Artifacts while receipts stay bounded', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const proposalBodies = {
    codex: [
      'I checked the existing collaboration constraints before proposing a bounded change.',
      'Proposal: freeze the batch snapshot before any scheduler lease and publish only after the barrier.',
      'This preserves independent reasoning while keeping retries and audit records deterministic.',
    ].join('\n'),
    hermes: [
      'Proposal: add a generic pre-dispatch contract for every selected Agent.',
      'The contract records the frozen snapshot, phase, slot, and delivery watermark.',
      'Detail: '.concat('bounded collaboration evidence '.repeat(110).trim()),
    ].join('\n\n'),
  }
  const phaseCalls = []
  options.runAgent = async (agent, prompt) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    phaseCalls.push({ kind: agent.kind, phase })
    const text = phase === 'proposal'
      ? proposalBodies[agent.kind]
      : `${agent.kind} ${phase} visible body.`
    return {
      text,
      collaboration: receiptFor(phase, `${agent.kind} ${phase} summary.`),
      sessionRef: `${agent.kind}-native-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'V4 bounded receipt bodies', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Produce independent proposals and challenge them.',
    mode: 'auto',
    maxRounds: 2,
    targetKinds: ['codex', 'hermes'],
    protocol: 'v4',
  })
  const controller = workspace.activeRuns.get(group.id)
  await controller.promise

  assert.deepEqual(
    phaseCalls.filter(call => call.phase === 'proposal').map(call => call.kind).sort(),
    ['codex', 'hermes'],
  )
  assert.deepEqual(
    phaseCalls.filter(call => call.phase === 'challenge').map(call => call.kind).sort(),
    ['codex', 'hermes'],
  )
  const proposalReceipts = controller.orchestration.slots
    .flatMap(slot => slot.resultRefs?.workflowOutcomeRefs || [])
    .map(record => record.receipt)
    .filter(receipt => receipt?.phase === 'proposal')
  assert.equal(proposalReceipts.length, 2)
  for (const receipt of proposalReceipts) {
    assert.equal(receipt.conclusion, '')
    assert.ok(receipt.summary.length <= 800)
  }

  const storedProposalBodies = new Map()
  for (const receipt of proposalReceipts) {
    const artifact = receipt.artifactIds
      .map(artifactId => workspace.outcomeStore.getArtifact(artifactId))
      .find(candidate => candidate.type === 'document')
    assert.ok(artifact?.contentRef)
    const evidence = receipt.evidenceIds
      .map(evidenceId => workspace.outcomeStore.getEvidence(evidenceId))
      .find(candidate => candidate.level === 'observed'
        && candidate.subject?.artifactId === artifact.artifactId)
    assert.ok(evidence)
    storedProposalBodies.set(
      receipt.agentKind,
      workspace.contentBlobStore.read(artifact.contentRef).toString('utf8'),
    )
  }
  assert.deepEqual(storedProposalBodies, new Map(Object.entries(proposalBodies)))
})

test('V4 preserves typed receipt visible suffixes that resemble partial controls', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const body = 'Visible typed body ending [[R'
  const calls = []
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    calls.push(agent.kind)
    runOptions.onEvent({ type: 'answer_delta', status: 'running', delta: body })
    return {
      text: body,
      collaboration: runtimeReceiptFor(agent.kind, phase, prompt, `${phase} summary.`),
      sessionRef: phase,
    }
  }
  const events = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-event', event => events.push(event))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'V4 typed suffixes', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Produce one verified conclusion.',
    mode: 'auto',
    targetKinds: ['codex', 'hermes'],
    protocol: 'v4',
  })
  await workspace.activeRuns.get(group.id).promise

  const answerDeltas = events.filter(event => event.type === 'answer_delta')
  for (const kind of ['codex', 'hermes']) {
    const expected = body.repeat(calls.filter(call => call === kind).length)
    assert.equal(answerDeltas.filter(event => event.agentKind === kind).map(event => event.delta).join(''), expected)
  }
  assert.deepEqual(
    workspace.snapshot().messages.filter(message => message.role === 'agent').map(message => message.content),
    [body, body, body, body, body],
  )
})

test('V4 Auto preserves visible proposals with missing or malformed receipts', async (t) => {
  for (const [name, collaboration] of [
    ['missing', null],
    ['malformed', { version: 1, phase: 'proposal', summary: 'Proposal.', status: 'completed' }],
  ]) {
    await t.test(name, async (t) => {
      const { directory, options } = fixture()
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
      const phases = []
      options.runAgent = async (_agent, prompt, _workdir, runOptions) => {
        phases.push(prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || '')
        runOptions.onEvent({ type: 'answer_delta', status: 'running', delta: 'Uncommitted body.' })
        return { text: 'Uncommitted body.', collaboration, sessionRef: 'v4-invalid' }
      }
      const workspace = new LocalWorkspace(options)
      await workspace.refreshAgents()
      const group = workspace.createGroup({
        name: `V4 invalid ${name}`, agentKinds: ['codex', 'hermes'], workdir: directory,
      })

      await workspace.sendMessage({
        groupId: group.id,
        text: 'Produce one verified conclusion.',
        mode: 'auto',
        targetKinds: ['codex', 'hermes'],
        maxRounds: 1,
        protocol: 'v4',
      })
      await workspace.activeRuns.get(group.id).promise

      const agentMessages = workspace.snapshot().messages.filter(message => message.role === 'agent')
      assert.deepEqual(agentMessages.map(message => message.content), [
        'Uncommitted body.',
        'Uncommitted body.',
      ])
      assert.equal(phases.length, 2)
      assert.equal(phases.every(phase => phase === 'proposal'), true)
      assert.equal(workspace.snapshot().messages.some(message => (
        /LOCAL_RUN_COLLABORATION_RECEIPT/.test(message.content)
      )), false)
    })
  }
})

test('V4 persists bounded per-session delivery acknowledgement after the invocation boundary', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const calls = []
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    const outbound = createLegacyOutboundPayload({
      prompt,
      command: agent.executable,
      args: ['chat', '--quiet', '--query'],
      cwd: directory,
      stdin: prompt,
      promptMode: 'stdin',
    })
    runOptions.onOutboundPayload(outbound)
    calls.push({ kind: agent.kind, phase, prompt, sessionRef: runOptions.sessionRef, outbound })
    const body = `${agent.kind} ${phase} body`
    return {
      text: body,
      collaboration: receiptFor(phase, `${agent.kind} ${phase} summary`),
      sessionRef: runOptions.sessionRef || `${agent.kind}-native-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'V4 durable delivery', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Unicode delivery: \u4e2d\u6587 \ud83d\ude80 e\u0301',
    mode: 'auto', targetKinds: ['codex', 'hermes'], protocol: 'v4', maxRounds: 2,
  })
  const active = workspace.activeRuns.get(group.id)
  await active.promise

  const challengeCalls = calls.filter(call => call.phase === 'challenge')
  assert.equal(challengeCalls.length, 2)
  assert.ok(challengeCalls.every(call => call.sessionRef.endsWith('-native-session')))
  assert.ok(challengeCalls.every(call => call.prompt.includes('MELDWORK_V4_COLLABORATION_PACKAGE_V1')))
  const deliveryState = active.orchestration.deliveryState || []
  assert.ok(deliveryState.length >= 2)
  assert.ok(deliveryState.every(entry => entry.status === 'acknowledged'))
  assert.doesNotMatch(JSON.stringify(deliveryState), /native-session/)
  assert.ok(deliveryState.every(entry => /^[a-f0-9]{64}$/.test(entry.sessionRefHash)))

  const unicodeCall = calls.find(call => call.prompt.includes('Unicode delivery: \u4e2d\u6587 \ud83d\ude80 e\u0301'))
  assert.ok(unicodeCall)
  const wirePayload = outboundWirePayloadBytes(unicodeCall.outbound)
  const telemetry = active.harness.agentRuns.find(run => (
    run.context?.promptHash === createHash('sha256').update(unicodeCall.prompt).digest('hex')
  ))?.context
  assert.ok(telemetry)
  assert.equal(telemetry.promptChars, unicodeCall.prompt.length)
  assert.equal(telemetry.promptBytes, Buffer.byteLength(unicodeCall.prompt, 'utf8'))
  assert.equal(telemetry.wirePayloadBytes, wirePayload.length)
  assert.equal(telemetry.wirePayloadHash, createHash('sha256').update(wirePayload).digest('hex'))
})

test('V4 Harness telemetry matches the real CLI legacy outbound payload bytes', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const cli = executable(directory, 'codex-v4-unicode.cjs', `
let prompt = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { prompt += chunk })
process.stdin.on('end', () => {
  const receipt = JSON.stringify({
    version: 1,
    phase: 'verification',
    verdict: 'support',
    summary: 'Unicode payload verified.',
  })
  const text = 'CLI verified the exact payload.\\n[[MELDWORK_COLLABORATION:' + receipt + ']]'
  for (const event of [
    { type: 'thread.started', thread_id: 'codex-v4-unicode-session' },
    { type: 'item.completed', item: { type: 'agent_message', text } },
    { type: 'turn.completed' },
  ]) process.stdout.write(JSON.stringify(event) + '\\n')
})
`)
  options.detectAgents = async () => [{
    kind: 'codex', name: 'Codex CLI', executable: cli, version: '1',
  }]
  options.runAgent = runCliAgent
  options.runLedger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger-cli-telemetry.json'),
  })
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'V4 CLI telemetry', agentKinds: ['codex'], workdir: directory,
  })
  const task = workspace.addMessage(group.id, 'user', 'Unicode CLI boundary')
  const contextPack = workspace.createContextPack({
    group, taskId: task.id, mode: 'manual', targetKinds: ['codex'], message: task,
  })
  const reservation = workspace.reserveRun(group.id, 'manual', ['codex'], task.id)
  workspace.bindRunTask(
    group.id, reservation, task.id, task.id, contextPack.contextPackId,
  )
  const controller = workspace.beginRun(
    group.id, 'manual', ['codex'], task.id, reservation,
  )
  const exactPrompt = 'Exact CLI prompt: \u4e2d\u6587 \ud83d\ude80 e\u0301'

  const result = await workspace.invokeAgent(
    group, 'codex', 'manual', controller.signal, task.id,
    {
      taskId: task.id,
      v4: true,
      phase: 'verification',
      sessionPolicy: 'frozen',
      promptOverride: exactPrompt,
      contextPackId: contextPack.contextPackId,
    },
  )
  await workspace.finishRun(group.id, controller, 'completed')

  const trace = result.message.trace.context
  const deliveryId = trace.deliveryRecordIds[0]
  const delivery = workspace.contextPackStore.getDelivery(deliveryId)
  const wirePayload = workspace.contentBlobStore.read(delivery.wirePayloadRef)
  const wireDocument = JSON.parse(wirePayload.toString('utf8'))
  assert.equal(wireDocument.stdin, exactPrompt)
  assert.equal(trace.promptChars, exactPrompt.length)
  assert.equal(trace.promptBytes, Buffer.byteLength(exactPrompt, 'utf8'))
  assert.equal(trace.promptHash, createHash('sha256').update(exactPrompt).digest('hex'))
  assert.equal(trace.wirePayloadBytes, wirePayload.length)
  assert.equal(trace.wirePayloadHash, createHash('sha256').update(wirePayload).digest('hex'))
  assert.equal(trace.wirePayloadBytes, delivery.wirePayloadBytes)
  assert.equal(trace.wirePayloadHash, delivery.wirePayloadHash)
})

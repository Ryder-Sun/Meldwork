const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const {
  createCollaborationReceipt,
  createSynthesisBinding,
} = require('../../src/collaboration/orchestration-v4-records.cjs')
const { RunLedger } = require('../../src/runs/run-ledger.cjs')
const { deferred, fixture } = require('../support/local-workspace-test-helpers.cjs')

async function waitFor(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`TEST_TIMEOUT:${label}`)
}

async function exerciseAutoCommitCrash(t, crashPoint, input = {}) {
  const candidateBody = input.candidateBody || 'Durable final candidate'
  const candidateSummary = input.candidateSummary || 'Durable final candidate'
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath })
  options.runLedger = ledger
  const calls = []
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    const workItemId = prompt.match(/^Work item: ([A-Za-z0-9._:-]+)$/m)?.[1] || ''
    calls.push({ kind: agent.kind, phase, operationId: runOptions.operationId })
    const assignments = [
      {
        taskId: 'codex-work', ownerKind: 'codex', role: 'worker',
        objective: 'Complete the Codex work package.', expectedOutput: 'Codex Artifact.',
        inputRefs: [], artifactIds: [], dependsOn: [],
      },
      {
        taskId: 'hermes-work', ownerKind: 'hermes', role: 'worker',
        objective: 'Complete the Hermes work package.', expectedOutput: 'Hermes Artifact.',
        inputRefs: [], artifactIds: [], dependsOn: [],
      },
      {
        taskId: 'workbuddy-integration', ownerKind: 'workbuddy', role: 'integrator',
        objective: 'Integrate the agreed work packages.', expectedOutput: 'Integrated Artifact.',
        inputRefs: [], artifactIds: [], dependsOn: ['codex-work', 'hermes-work'],
      },
    ]
    return {
      text: phase === 'synthesis' ? candidateBody : `${agent.kind} ${phase}`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-${phase}`,
      collaboration: phase === 'proposal'
        ? {
            version: 1, phase, summary: `${agent.kind} proposal`,
            capabilities: [`${agent.kind} capability`], intendedWork: [`${agent.kind} work`],
            deliverables: [`${agent.kind} Artifact`], dependencies: [],
          }
        : phase === 'challenge'
          ? {
              version: 1, phase, verdict: 'support', summary: `${agent.kind} supports the plan`,
              proposedAssignments: assignments,
              finalizerKind: 'workbuddy',
              verifierKinds: ['codex', 'hermes'],
              agreeToPlan: true,
            }
          : phase === 'work'
            ? {
                version: 1, phase, summary: `${agent.kind} completed ${workItemId}`,
                workItemId, deliverables: [`${agent.kind} Artifact`],
              }
        : phase === 'synthesis'
          ? { version: 1, phase, summary: candidateSummary, resolvedIssueIds: [] }
          : { version: 1, phase, verdict: 'support', summary: `${agent.kind} review` },
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Auto V4 commit crash',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: false,
  })
  let crashRecord = null
  const checkpointRun = workspace.checkpointRun.bind(workspace)
  const commitV4AgentMessage = workspace.autoRunner.commitV4AgentMessage
  workspace.checkpointRun = (groupId, controller, status = '') => {
    const phase = controller.orchestration?.phase
    const candidateStatus = controller.orchestration?.candidateCommit?.status || ''
    if (crashPoint === 'pre-intent' && phase === 'verification'
        && controller.orchestration?.convergence?.openIssueIds?.length === 0) {
      checkpointRun(groupId, controller, status)
      crashRecord ||= structuredClone(ledger.get(controller.runId))
      throw new Error('TEST_CRASH:AUTO_V4_PRE_INTENT')
    }
    if (crashPoint === 'post-intent' && candidateStatus === 'intent') {
      checkpointRun(groupId, controller, status)
      crashRecord ||= structuredClone(ledger.get(controller.runId))
      throw new Error('TEST_CRASH:AUTO_V4_POST_INTENT')
    }
    if (crashPoint === 'post-message-checkpoint' && candidateStatus === 'message-committed') {
      checkpointRun(groupId, controller, status)
      crashRecord ||= structuredClone(ledger.get(controller.runId))
      throw new Error('TEST_CRASH:AUTO_V4_POST_MESSAGE_CHECKPOINT')
    }
    if (crashPoint === 'post-blackboard-checkpoint' && candidateStatus === 'sinks-committed') {
      checkpointRun(groupId, controller, status)
      crashRecord ||= structuredClone(ledger.get(controller.runId))
      throw new Error('TEST_CRASH:AUTO_V4_POST_BLACKBOARD_CHECKPOINT')
    }
    if (crashPoint === 'stop-after-blackboard' && candidateStatus === 'sinks-committed') {
      const result = checkpointRun(groupId, controller, status)
      workspace.stop(groupId, controller.runId)
      crashRecord ||= structuredClone(ledger.get(controller.runId))
      return result
    }
    if (crashPoint === 'pre-terminal' && candidateStatus === 'completed') {
      crashRecord ||= structuredClone(ledger.get(controller.runId))
      throw new Error('TEST_CRASH:AUTO_V4_PRE_TERMINAL')
    }
    if (crashPoint === 'post-terminal' && candidateStatus === 'completed') {
      checkpointRun(groupId, controller, status)
      crashRecord ||= structuredClone(ledger.get(controller.runId))
      throw new Error('TEST_CRASH:AUTO_V4_POST_TERMINAL')
    }
    return checkpointRun(groupId, controller, status)
  }
  workspace.autoRunner.commitV4AgentMessage = (input) => {
    const running = workspace.activeRuns.get(group.id)
    const isCandidateMessage = running?.orchestration?.candidateCommit?.messageId === input.messageId
    if (crashPoint === 'pre-message' && isCandidateMessage) {
      crashRecord ||= structuredClone(ledger.get(running.runId))
      throw new Error('TEST_CRASH:AUTO_V4_PRE_MESSAGE')
    }
    const message = commitV4AgentMessage(input)
    if (crashPoint === 'stop-after-message' && isCandidateMessage) {
      workspace.stop(group.id, running.runId)
      return message
    }
    if (crashPoint === 'post-message' && isCandidateMessage) {
      crashRecord ||= structuredClone(ledger.get(running.runId))
      throw new Error('TEST_CRASH:AUTO_V4_POST_MESSAGE')
    }
    return message
  }

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Commit the accepted candidate exactly once.',
    mode: 'auto',
    maxRounds: 2,
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    protocol: 'v4',
  })
  const controller = workspace.activeRuns.get(group.id)
  await controller.promise
  const proposalContents = ['codex proposal', 'hermes proposal', 'workbuddy proposal']
  const visibleAgentMessages = workspace.snapshot().messages.filter(message => (
    message.groupId === group.id && message.role === 'agent'
  ))
  assert.deepEqual(
    visibleAgentMessages.filter(message => proposalContents.includes(message.content))
      .map(message => message.content),
    proposalContents,
  )
  if (['stop-after-message', 'stop-after-blackboard'].includes(crashPoint)) {
    const stopped = ledger.get(controller.runId)
    assert.equal(stopped.status, 'stopped')
    assert.notEqual(stopped.orchestration.candidateCommit?.status, 'completed')
    assert.equal(
      visibleAgentMessages.filter(message => message.content === candidateBody).length,
      1,
    )
    assert.equal(
      stopped.orchestration.collaboration.entries.filter(entry => (
        entry.entryId === stopped.orchestration.candidateCommit?.blackboardEntryId
      )).length,
      crashPoint === 'stop-after-blackboard' ? 1 : 0,
    )
    return
  }
  assert.ok(calls.some(call => call.phase === 'verification'))
  assert.ok(crashRecord)
  const crashCommit = crashRecord.orchestration.candidateCommit || null
  const expectedCrashStatus = {
    'pre-intent': null,
    'post-intent': 'intent',
    'post-message': 'intent',
    'post-message-checkpoint': 'message-committed',
    'post-blackboard-checkpoint': 'sinks-committed',
    'pre-terminal': 'sinks-committed',
    'post-terminal': 'completed',
  }[crashPoint]
  assert.equal(crashCommit?.status || null, expectedCrashStatus)
  if (crashCommit) {
    assert.match(crashCommit.commitId, /^candidate-commit-[a-f0-9]{64}$/)
    assert.match(crashCommit.messageId, /^message-[a-f0-9]{64}$/)
    assert.match(crashCommit.blackboardEntryId, /^blackboard-entry-[a-f0-9]{64}$/)
  }
  const boundMessageId = crashCommit?.messageId || ''
  const boundBlackboardEntryId = crashCommit?.blackboardEntryId || ''
  const synthesisReceipt = crashRecord.orchestration.slots
    .flatMap(slot => slot.resultRefs?.workflowOutcomeRefs || [])
    .find(record => record.receipt?.phase === 'synthesis')?.receipt
  assert.ok(synthesisReceipt)
  assert.equal(
    crashRecord.orchestration.collaboration.entries.length,
    ['post-blackboard-checkpoint', 'pre-terminal', 'post-terminal'].includes(crashPoint)
      ? 1 : 0,
  )
  assert.equal(
    visibleAgentMessages.filter(message => message.content === candidateBody).length,
    ['post-message', 'post-message-checkpoint', 'post-blackboard-checkpoint',
      'pre-terminal', 'post-terminal'].includes(crashPoint) ? 1 : 0,
  )
  const initialArtifactIds = new Set(crashRecord.orchestration.slots.flatMap(slot => (
    slot.resultRefs?.artifactIds || []
  )))

  const recoveryStoragePath = path.join(directory, 'workspace-recovery.json')
  fs.copyFileSync(options.storagePath, recoveryStoragePath)
  const recoveryLedger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger-recovery.json'),
  })
  recoveryLedger.checkpoint(crashRecord)
  const recoveredCalls = []
  const recovered = new LocalWorkspace({
    ...options,
    storagePath: recoveryStoragePath,
    runLedger: recoveryLedger,
    runAgent: async (agent) => {
      recoveredCalls.push(agent.kind)
      throw new Error('TEST_AGENT_MUST_NOT_RERUN')
    },
  })
  await recovered.refreshAgents()
  const final = await waitFor(() => {
    const record = recoveryLedger.get(crashRecord.runId)
    return ['completed', 'failed', 'partial', 'stopped', 'interrupted'].includes(record?.status)
      ? record : null
  }, 'Auto V4 commit recovery')

  assert.equal(final.status, 'completed', JSON.stringify({
    status: final.status,
    reason: final.reason,
    stopReason: recovered.activeRuns.get(group.id)?.stopReason,
  }))
  assert.deepEqual(recoveredCalls, [])
  assert.equal(final.orchestration.candidateCommit.status, 'completed')
  assert.equal(final.orchestration.candidateCommit.messageStatus, 'committed')
  assert.equal(final.orchestration.candidateCommit.blackboardStatus, 'committed')
  assert.equal(Object.hasOwn(final.orchestration.candidateCommit, 'candidateBody'), false)
  if (boundMessageId) assert.equal(final.orchestration.candidateCommit.messageId, boundMessageId)
  if (boundBlackboardEntryId) {
    assert.equal(final.orchestration.candidateCommit.blackboardEntryId, boundBlackboardEntryId)
  }
  const finalMessageId = final.orchestration.candidateCommit.messageId
  const finalBlackboardEntryId = final.orchestration.candidateCommit.blackboardEntryId
  const committedEntries = final.orchestration.collaboration.entries.filter(entry => (
    entry.entryId === finalBlackboardEntryId
  ))
  assert.equal(committedEntries.length, 1)
  assert.equal(
    committedEntries[0].statement,
    `Accepted candidate Artifact ${final.orchestration.candidateCommit.candidateArtifactId} `
      + `(sha256:${final.orchestration.candidateCommit.candidateContentHash}).`,
  )
  assert.ok(committedEntries[0].statement.length < 6000)
  assert.notEqual(committedEntries[0].statement, candidateBody)
  assert.equal(committedEntries[0].value, final.orchestration.candidateCommit.candidateContentHash)
  assert.deepEqual(
    committedEntries[0].refs,
    [...synthesisReceipt.artifactIds, ...synthesisReceipt.evidenceIds],
  )
  assert.deepEqual(
    new Set(final.orchestration.slots.flatMap(slot => slot.resultRefs?.artifactIds || [])),
    initialArtifactIds,
  )
  const recoveredMessages = recovered.snapshot().messages.filter(message => (
    message.groupId === group.id && message.role === 'agent'
  ))
  assert.deepEqual(
    recoveredMessages.filter(message => proposalContents.includes(message.content))
      .map(message => message.content),
    proposalContents,
  )
  assert.deepEqual(
    recoveredMessages.filter(message => message.content === candidateBody)
      .map(message => ({ id: message.id, content: message.content })),
    [{ id: finalMessageId, content: candidateBody }],
  )
}

for (const [name, stopPoint] of [
  ['after the message sink write', 'stop-after-message'],
  ['after both sink checkpoints', 'stop-after-blackboard'],
]) {
  test(`Auto V4 explicit stop ${name} cannot upgrade the Run to completed`, async (t) => {
    await exerciseAutoCommitCrash(t, stopPoint)
  })
}

test('deterministic candidate message reuse fails closed on body, author, group, or thread conflicts', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Candidate message conflict', agentKinds: ['codex', 'hermes'],
    workdir: directory, allowWrite: false,
  })
  const otherGroup = workspace.createGroup({
    name: 'Other candidate group', agentKinds: ['codex'],
    workdir: directory, allowWrite: false,
  })
  const input = {
    messageId: `message-${'a'.repeat(64)}`,
    groupId: group.id,
    agentKind: 'codex',
    threadRootId: 'thread-candidate',
    content: 'Exact accepted candidate body.',
    metadata: {},
  }
  const first = workspace.commitV4AgentMessage(input)
  assert.deepEqual(workspace.commitV4AgentMessage(input), first)
  for (const conflict of [
    { ...input, content: 'Conflicting candidate body.' },
    { ...input, agentKind: 'hermes' },
    { ...input, groupId: otherGroup.id },
    { ...input, threadRootId: 'different-thread' },
  ]) {
    assert.throws(() => workspace.commitV4AgentMessage(conflict), {
      message: 'LOCAL_RUN_COMMIT_INVALID',
    })
  }
  assert.equal(workspace.snapshot().messages.filter(message => message.id === input.messageId).length, 1)
})

for (const [name, crashPoint] of [
  ['before commit intent', 'pre-intent'],
  ['after commit intent', 'post-intent'],
  ['after the message write', 'post-message'],
  ['after the message checkpoint', 'post-message-checkpoint'],
  ['after the Blackboard checkpoint', 'post-blackboard-checkpoint'],
  ['before the terminal checkpoint', 'pre-terminal'],
  ['after the terminal orchestration checkpoint', 'post-terminal'],
]) {
  test(`Auto V4 recovers exactly once ${name}`, async (t) => {
    await exerciseAutoCommitCrash(t, crashPoint)
  })
}

test('Auto V4 recovers an accepted candidate over 6000 characters without truncation', async (t) => {
  const candidateBody = `${'L'.repeat(6001)}::LONG_CANDIDATE_END::`
  await exerciseAutoCommitCrash(t, 'post-blackboard-checkpoint', {
    candidateBody,
    candidateSummary: 'Accepted long candidate summary.',
  })
})

test('fresh Auto observes terminal persistence failure without hiding controller promise rejection', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger-terminal-failure.json') })
  options.runLedger = ledger
  options.terminalRetrySleep = () => Promise.resolve()
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Fresh Auto terminal persistence failure',
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
    allowWrite: false,
  })
  workspace.autoRunner.runV4Discussion = async () => 'completed'
  ledger.finish = () => { throw new Error('TEST_TERMINAL_PERSISTENCE_UNAVAILABLE') }
  const unhandled = []
  const onUnhandled = reason => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  t.after(() => process.removeListener('unhandledRejection', onUnhandled))

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Finish this fresh Auto run with a durable terminal checkpoint.',
    mode: 'auto',
    maxRounds: 2,
    targetKinds: ['codex', 'hermes'],
    protocol: 'v4',
  })
  const controller = workspace.activeRuns.get(group.id)
  assert.ok(controller)
  t.after(() => {
    for (const timer of workspace.runCheckpointTimers.values()) clearTimeout(timer)
    workspace.runCheckpointTimers.clear()
    workspace.activeRuns.delete(group.id)
    controller.resolveDone()
  })
  const originalPromise = controller.promise
  await waitFor(() => controller.terminalPersistence?.state === 'failed', 'failed terminal outbox')
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(unhandled, [])
  assert.equal(controller.promise, originalPromise)
  assert.equal(workspace.activeRuns.get(group.id), controller)
  assert.equal(controller.finished, false)
  assert.equal(controller.terminalOutbox.status, 'completed')
  assert.deepEqual(controller.terminalPersistence, {
    state: 'failed',
    status: 'completed',
    attempts: 3,
    nextRetryAt: 0,
    code: 'LOCAL_RUN_PERSIST_FAILED',
  })
  await assert.rejects(originalPromise, error => (
    error?.code === 'LOCAL_RUN_TERMINAL_PERSIST_FAILED'
      && error.persistence?.state === 'failed'
  ))
})

function negotiatedAssignments() {
  return [
    {
      taskId: 'codex-work', ownerKind: 'codex', role: 'worker',
      objective: 'Complete the first frozen work package.', expectedOutput: 'Codex Artifact.',
      inputRefs: [], artifactIds: [], dependsOn: [],
    },
    {
      taskId: 'hermes-work', ownerKind: 'hermes', role: 'worker',
      objective: 'Continue from the first frozen work package.', expectedOutput: 'Hermes Artifact.',
      inputRefs: [], artifactIds: [], dependsOn: ['codex-work'],
    },
    {
      taskId: 'workbuddy-integration', ownerKind: 'workbuddy', role: 'integrator',
      objective: 'Integrate the frozen work packages.', expectedOutput: 'Integrated Artifact.',
      inputRefs: [], artifactIds: [], dependsOn: ['hermes-work'],
    },
  ]
}

async function captureDiscussionCheckpoint(t, phase, predicate = () => true, setup = null) {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  const prompts = []
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const currentPhase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    const workItemId = prompt.match(/^Work item: ([A-Za-z0-9._:-]+)$/m)?.[1] || ''
    prompts.push({ kind: agent.kind, phase: currentPhase, prompt })
    return {
      text: currentPhase === 'synthesis' ? 'Frozen final candidate' : `${agent.kind} ${currentPhase}`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-${currentPhase}`,
      collaboration: currentPhase === 'proposal'
        ? {
            version: 1, phase: currentPhase, summary: `${agent.kind} proposal`,
            capabilities: [`${agent.kind} capability`], intendedWork: [`${agent.kind} work`],
            deliverables: [`${agent.kind} Artifact`], dependencies: [],
          }
        : currentPhase === 'challenge'
          ? {
              version: 1, phase: currentPhase, verdict: 'support',
              summary: `${agent.kind} supports the negotiated plan`,
              proposedAssignments: negotiatedAssignments(), finalizerKind: 'workbuddy',
              verifierKinds: ['codex', 'hermes'], agreeToPlan: true,
            }
          : currentPhase === 'work'
            ? {
                version: 1, phase: currentPhase, summary: `${agent.kind} completed ${workItemId}`,
                workItemId, deliverables: [`${agent.kind} Artifact`],
              }
            : currentPhase === 'synthesis'
              ? { version: 1, phase: currentPhase, summary: 'Frozen final candidate', resolvedIssueIds: [] }
              : { version: 1, phase: currentPhase, verdict: 'support', summary: `${agent.kind} review` },
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Frozen negotiation group',
    topic: 'Frozen negotiation topic',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: false,
  })
  const history = workspace.addMessage(group.id, 'user', 'Frozen historical body.')
  const setupState = setup ? await setup({ workspace, options, group, history }) : {}
  if (setupState.validateSkillSelections) {
    options.validateSkillSelections = setupState.validateSkillSelections
    workspace.validateSkillSelectionsFn = setupState.validateSkillSelections
  }
  let crashRecord = null
  const checkpointRun = workspace.checkpointRun.bind(workspace)
  workspace.checkpointRun = (groupId, controller, status = '') => {
    const result = checkpointRun(groupId, controller, status)
    if (!crashRecord && controller.orchestration?.phase === phase
        && predicate(controller.orchestration)) {
      crashRecord = structuredClone(ledger.get(controller.runId))
      throw new Error(`TEST_CRASH:AUTO_V4_${phase.toUpperCase()}`)
    }
    return result
  }
  await workspace.sendMessage({
    groupId: group.id,
    text: 'Frozen root task body.',
    mode: 'auto',
    maxRounds: 2,
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    protocol: 'v4',
    ...(setupState.messageInput || {}),
  })
  const controller = workspace.activeRuns.get(group.id)
  await controller.promise
  assert.ok(crashRecord)
  return {
    directory, options, workspace, group, history, crashRecord, prompts, setupState,
  }
}

async function recoverDiscussion(input, runAgent) {
  const recoveryLedger = new RunLedger({
    storagePath: path.join(input.directory, `recovery-${Date.now()}-${Math.random()}.json`),
  })
  recoveryLedger.checkpoint(input.crashRecord)
  const calls = []
  const recovered = new LocalWorkspace({
    ...input.options,
    runLedger: recoveryLedger,
    contentBlobStore: input.workspace.contentBlobStore,
    outcomeStore: input.workspace.outcomeStore,
    runAgent: async (...args) => {
      calls.push({ agent: args[0], prompt: args[1], runOptions: args[3] })
      return runAgent(...args)
    },
  })
  await recovered.refreshAgents()
  return { recovered, recoveryLedger, calls }
}

test('Auto V4 coordination recovery uses the byte-identical frozen snapshot after live mutation', async (t) => {
  const input = await captureDiscussionCheckpoint(t, 'coordination')
  const ref = input.crashRecord.orchestration.snapshot.contentRef
  assert.ok(ref)
  const frozenBytes = input.workspace.contentBlobStore.read(ref)
  input.group.name = 'MUTATED GROUP'
  input.group.topic = 'MUTATED TOPIC'
  input.workspace.deleteMessage(input.group.id, input.history.id)
  input.workspace.deleteMessage(input.group.id, input.crashRecord.threadRootId)
  input.workspace.save()

  const recovery = await recoverDiscussion(input, input.options.runAgent)
  const final = await waitFor(() => {
    const record = recovery.recoveryLedger.get(input.crashRecord.runId)
    return ['completed', 'failed', 'partial', 'stopped', 'interrupted'].includes(record?.status)
      ? record : null
  }, 'coordination recovery', 15000)

  assert.equal(final.status, 'completed', JSON.stringify({
    reason: final.reason,
    calls: recovery.calls.map(call => ({
      kind: call.agent.kind,
      phase: call.prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || '',
    })),
  }))
  assert.deepEqual(input.workspace.contentBlobStore.read(ref), frozenBytes)
  assert.ok(recovery.calls.length > 0)
  for (const call of recovery.calls) {
    assert.match(call.prompt, /Group: Frozen negotiation group/)
    assert.match(call.prompt, /Topic: Frozen negotiation topic/)
    assert.match(call.prompt, /Frozen root task body\./)
    assert.match(call.prompt, /Frozen historical body\./)
    assert.doesNotMatch(call.prompt, /MUTATED/)
  }
})

async function frozenSkillSetup({ workspace }) {
  const skillSnapshotBytes = Buffer.from('{"skill":"frozen-v4-snapshot","version":1}', 'utf8')
  const snapshotRef = workspace.contentBlobStore.put(skillSnapshotBytes, {
    mediaType: 'application/json',
  })
  const frozenSkill = {
    targetKind: 'codex', namespace: 'global', slug: 'frozen-review', name: 'Frozen Review',
    snapshotId: `skill-snapshot-${'a'.repeat(64)}`,
    manifestHash: 'a'.repeat(64),
    snapshotRef,
  }
  const entryPath = path.join(workspace.contentBlobStore.rootPath, 'frozen-review', 'SKILL.md')
  const runtimeHint = (selection = frozenSkill) => {
    const value = { ...selection, snapshotRef: { ...selection.snapshotRef } }
    Object.defineProperty(value, 'entryPath', { value: entryPath })
    return value
  }
  const validationCalls = []
  const validateSkillSelections = async (kind, selections) => {
    validationCalls.push({ kind, selections: structuredClone(selections) })
    if (!selections.length) return []
    if (!selections.every(skill => skill?.snapshotRef)) return [runtimeHint()]
    for (const skill of selections) {
      let bytes
      try { bytes = workspace.contentBlobStore.read(skill.snapshotRef) } catch {
        throw new Error('LOCAL_SKILL_SNAPSHOT_RESTORE_FAILED')
      }
      if (!bytes.equals(skillSnapshotBytes)) {
        throw new Error('LOCAL_SKILL_SNAPSHOT_RESTORE_FAILED')
      }
    }
    return selections.map(runtimeHint)
  }
  return {
    frozenSkill,
    entryPath,
    skillSnapshotBytes,
    validationCalls,
    validateSkillSelections,
    messageInput: {
      skillHints: [{
        targetKind: 'codex', namespace: 'global', slug: 'live-review', name: 'Live Review',
      }],
    },
  }
}

test('Auto V4 first dispatch and restart prompts use frozen target-scoped Skill hints', async (t) => {
  const input = await captureDiscussionCheckpoint(
    t, 'challenge', () => true, frozenSkillSetup,
  )
  const initialCodexPrompts = input.prompts.filter(call => call.kind === 'codex')
  assert.ok(initialCodexPrompts.length > 0)
  assert.equal(initialCodexPrompts.every(call => call.prompt.includes('Frozen Review')), true)
  assert.equal(initialCodexPrompts.every(call => call.prompt.includes(input.setupState.entryPath)), true)
  assert.equal(input.prompts.filter(call => call.kind !== 'codex')
    .every(call => !call.prompt.includes('Frozen Review')), true)
  const root = input.workspace.state.messages.find(message => (
    message.id === input.crashRecord.threadRootId
  ))
  assert.ok(root)
  input.group.name = 'MUTATED GROUP'
  input.group.topic = 'MUTATED TOPIC'
  input.history.content = 'MUTATED HISTORY'
  root.content = 'MUTATED ROOT TASK'
  root.attachments = [{
    id: 'live-root-image', name: 'live-root.png', mimeType: 'image/png', size: 128,
  }]
  root.skillHints = [{
    targetKind: 'codex', namespace: 'global', slug: 'mutated-live', name: 'Mutated Live',
  }]
  root.knowledgeBaseHints = [{
    kind: 'dingtalk', name: 'Mutated DingTalk', accessMode: 'cli',
    commandName: 'mutated-dws', targetKinds: ['codex'],
  }]
  input.workspace.save()

  let attachmentResolutionCalls = 0
  input.options.resolveAttachments = async () => {
    attachmentResolutionCalls += 1
    throw new Error('LOCAL_ATTACHMENT_REFERENCE_INVALID')
  }
  let knowledgeResolutionCalls = 0
  input.options.validateKnowledgeBaseSelections = async () => {
    knowledgeResolutionCalls += 1
    throw new Error('LOCAL_KNOWLEDGE_BASE_SELECTION_INVALID')
  }
  const validationCallCount = input.setupState.validationCalls.length
  const recovery = await recoverDiscussion(input, input.options.runAgent)
  const final = await waitFor(() => {
    const record = recovery.recoveryLedger.get(input.crashRecord.runId)
    return ['completed', 'failed', 'partial', 'stopped', 'interrupted'].includes(record?.status)
      ? record : null
  }, 'challenge recovery with mutable live attachment', 15000)

  assert.equal(final.status, 'completed', final.reason)
  assert.equal(attachmentResolutionCalls, 0)
  assert.equal(knowledgeResolutionCalls, 0)
  const recoverySkillCalls = input.setupState.validationCalls.slice(validationCallCount)
  assert.ok(recoverySkillCalls.length > 0)
  assert.deepEqual(recoverySkillCalls[0], {
    kind: 'codex', selections: [input.setupState.frozenSkill],
  })
  assert.ok(recovery.calls.length > 0)
  const recoveryCodexPrompts = recovery.calls.filter(call => call.agent.kind === 'codex')
  assert.ok(recoveryCodexPrompts.length > 0)
  assert.equal(recoveryCodexPrompts.every(call => call.prompt.includes('Frozen Review')), true)
  assert.equal(recoveryCodexPrompts
    .every(call => call.prompt.includes(input.setupState.entryPath)), true)
  assert.equal(recovery.calls.filter(call => call.agent.kind !== 'codex')
    .every(call => !call.prompt.includes('Frozen Review')), true)
  for (const call of recovery.calls) {
    assert.match(call.prompt, /Group: Frozen negotiation group/)
    assert.match(call.prompt, /Topic: Frozen negotiation topic/)
    assert.match(call.prompt, /Frozen root task body\./)
    assert.match(call.prompt, /Frozen historical body\./)
    assert.doesNotMatch(call.prompt, /MUTATED/)
  }
})

for (const corruption of ['missing', 'tampered']) {
  test(`Auto V4 recovery fails before Agent invocation when a frozen Skill blob is ${corruption}`, async (t) => {
    const input = await captureDiscussionCheckpoint(
      t, 'coordination', () => true, frozenSkillSetup,
    )
    const ref = input.setupState.frozenSkill.snapshotRef
    const blobPath = path.join(
      input.workspace.contentBlobStore.rootPath, 'sha256', ref.hash.slice(0, 2), ref.hash,
    )
    if (corruption === 'missing') fs.unlinkSync(blobPath)
    else fs.writeFileSync(blobPath, Buffer.alloc(ref.size, 0x78), { mode: 0o600 })
    const recovery = await recoverDiscussion(input, async () => {
      throw new Error('TEST_AGENT_MUST_NOT_RUN')
    })
    const final = await waitFor(() => {
      const record = recovery.recoveryLedger.get(input.crashRecord.runId)
      return record?.status === 'failed' ? record : null
    }, `${corruption} frozen Skill failure`, 1500)
    assert.deepEqual(recovery.calls, [])
    assert.equal(final.reason, 'LOCAL_RUN_SNAPSHOT_INVALID')
  })
}

test('Auto V4 work recovery invokes only work packages still pending in the negotiated plan', async (t) => {
  const input = await captureDiscussionCheckpoint(t, 'work', orchestration => (
    orchestration.workReceipts?.some(receipt => receipt.ownerKind === 'codex')
  ))
  const recovery = await recoverDiscussion(input, input.options.runAgent)
  await waitFor(() => recovery.recoveryLedger.get(input.crashRecord.runId)?.status === 'completed',
    'work recovery', 30000)
  const workKinds = recovery.calls
    .filter(call => /^Phase: work$/m.test(call.prompt))
    .map(call => call.agent.kind)
  assert.deepEqual(workKinds, ['hermes', 'workbuddy'])
})

test('Auto V4 checkpoints each concurrent work receipt before the dependency wave settles', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger-wave.json') })
  options.runLedger = ledger
  const delayedHermes = deferred()
  t.after(() => delayedHermes.resolve())
  const assignments = [
    {
      taskId: 'codex-work', ownerKind: 'codex', role: 'worker',
      objective: 'Complete Codex work.', expectedOutput: 'Codex Artifact.',
      inputRefs: [], artifactIds: [], dependsOn: [],
    },
    {
      taskId: 'hermes-work', ownerKind: 'hermes', role: 'worker',
      objective: 'Complete Hermes work.', expectedOutput: 'Hermes Artifact.',
      inputRefs: [], artifactIds: [], dependsOn: [],
    },
    {
      taskId: 'integrate-work', ownerKind: 'workbuddy', role: 'integrator',
      objective: 'Integrate both work packages.', expectedOutput: 'Integrated Artifact.',
      inputRefs: [], artifactIds: [], dependsOn: ['codex-work', 'hermes-work'],
    },
  ]
  const resultFor = async (agent, prompt, runOptions, delayHermes = true) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    const workItemId = prompt.match(/^Work item: ([A-Za-z0-9._:-]+)$/m)?.[1] || ''
    if (phase === 'work' && agent.kind === 'hermes' && delayHermes) {
      await delayedHermes.promise
    }
    return {
      text: phase === 'synthesis' ? 'Exact durable candidate' : `${agent.kind} ${phase}`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-${phase}`,
      collaboration: phase === 'proposal'
        ? {
            version: 1, phase, summary: `${agent.kind} proposal`,
            capabilities: [`${agent.kind} capability`], intendedWork: [`${agent.kind} work`],
            deliverables: [`${agent.kind} Artifact`], dependencies: [],
          }
        : phase === 'challenge'
          ? {
              version: 1, phase, verdict: 'support', summary: `${agent.kind} supports plan`,
              proposedAssignments: assignments, finalizerKind: 'workbuddy',
              verifierKinds: ['codex', 'hermes'], agreeToPlan: true,
            }
          : phase === 'work'
            ? {
                version: 1, phase, summary: `${agent.kind} completed ${workItemId}`,
                workItemId, deliverables: [`${agent.kind} Artifact`],
              }
            : phase === 'synthesis'
              ? { version: 1, phase, summary: 'Exact durable candidate', resolvedIssueIds: [] }
              : { version: 1, phase, verdict: 'support', summary: `${agent.kind} review` },
    }
  }
  options.runAgent = (agent, prompt, _workdir, runOptions) => (
    resultFor(agent, prompt, runOptions)
  )
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Concurrent exact work receipts',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: false,
  })
  let crashRecord = null
  const checkpointRun = workspace.checkpointRun.bind(workspace)
  workspace.checkpointRun = (groupId, controller, status = '') => {
    const persisted = checkpointRun(groupId, controller, status)
    if (!crashRecord && controller.orchestration?.phase === 'work'
        && controller.orchestration.workReceipts?.length === 1) {
      crashRecord = structuredClone(ledger.get(controller.runId))
      throw new Error('TEST_CRASH:AUTO_V4_FIRST_WORK_RECEIPT')
    }
    return persisted
  }

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Checkpoint each independent work package exactly as it finishes.',
    mode: 'auto', maxRounds: 2,
    targetKinds: ['codex', 'hermes', 'workbuddy'], protocol: 'v4',
  })
  const controller = workspace.activeRuns.get(group.id)
  await waitFor(() => crashRecord, 'first work receipt checkpoint', 15000)
  delayedHermes.resolve()
  await controller.promise

  assert.equal(crashRecord.orchestration.workReceipts.length, 1)
  assert.equal(crashRecord.orchestration.workReceipts[0].ownerKind, 'codex')
  const exact = crashRecord.orchestration.workReceipts[0]
  const hermesSlot = crashRecord.orchestration.slots.find(slot => slot.agentKind === 'hermes')
  const orphan = createCollaborationReceipt({
    phase: 'work', agentKind: 'hermes', slotId: hermesSlot.slotId,
    operationId: hermesSlot.operationId, status: 'completed',
    summary: 'Orphan receipt reusing another work package Artifact.',
    artifactIds: [...exact.collaborationReceipt.artifactIds],
    evidenceIds: [...exact.collaborationReceipt.evidenceIds],
    workItemId: 'hermes-work', snapshotHash: crashRecord.orchestration.snapshotHash,
    deliveryWatermark: hermesSlot.deliveryWatermark + 1,
  })
  hermesSlot.resultRefs.workflowOutcomeRefs.push({ receipt: orphan })

  const recovery = await recoverDiscussion({
    directory, options, workspace, group, crashRecord,
  }, options.runAgent)
  const final = await waitFor(() => {
    const record = recovery.recoveryLedger.get(crashRecord.runId)
    return ['completed', 'failed', 'partial', 'stopped', 'interrupted'].includes(record?.status)
      ? record : null
  }, 'exact work receipt recovery', 15000)
  const recoveredWorkKinds = recovery.calls
    .filter(call => /^Phase: work$/m.test(call.prompt))
    .map(call => call.agent.kind)

  assert.equal(final.status, 'completed', final.reason)
  assert.deepEqual(recoveredWorkKinds, ['hermes', 'workbuddy'])
  assert.deepEqual(
    final.orchestration.workReceipts.map(receipt => receipt.ownerKind).sort(),
    ['codex', 'hermes', 'workbuddy'],
  )
})

test('Auto V4 rejects a work result that arrives after the run is stopped', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger-late-work.json') })
  options.runLedger = ledger
  const workStarted = deferred()
  const lateWork = deferred()
  const assignments = negotiatedAssignments().map(assignment => ({
    ...assignment,
    dependsOn: assignment.ownerKind === 'workbuddy'
      ? ['codex-work', 'hermes-work'] : [],
  }))
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    const workItemId = prompt.match(/^Work item: ([A-Za-z0-9._:-]+)$/m)?.[1] || ''
    if (phase === 'work') {
      workStarted.resolve()
      await lateWork.promise
    }
    return {
      text: `${agent.kind} ${phase}`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-${phase}`,
      collaboration: phase === 'proposal'
        ? { version: 1, phase, summary: `${agent.kind} proposal`, capabilities: ['capability'], intendedWork: ['work'], deliverables: ['Artifact'], dependencies: [] }
        : phase === 'challenge'
          ? { version: 1, phase, verdict: 'support', summary: `${agent.kind} support`, proposedAssignments: assignments, finalizerKind: 'workbuddy', verifierKinds: ['codex', 'hermes'], agreeToPlan: true }
          : phase === 'work'
            ? { version: 1, phase, summary: `${agent.kind} completed ${workItemId}`, workItemId, deliverables: ['Artifact'] }
            : phase === 'synthesis'
              ? { version: 1, phase, summary: 'candidate', resolvedIssueIds: [] }
              : { version: 1, phase, verdict: 'support', summary: 'review' },
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Reject late Auto work', agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory, allowWrite: false,
  })
  await workspace.sendMessage({
    groupId: group.id, text: 'Stop before accepting late work.', mode: 'auto', maxRounds: 2,
    targetKinds: ['codex', 'hermes', 'workbuddy'], protocol: 'v4',
  })
  const controller = workspace.activeRuns.get(group.id)
  await workStarted.promise
  workspace.stop(group.id, controller.runId)
  lateWork.resolve()
  await controller.promise

  const final = ledger.get(controller.runId)
  assert.equal(final.status, 'stopped')
  assert.deepEqual(final.orchestration.workReceipts, [])
  assert.equal(final.orchestration.slots.some(slot => (
    slot.resultRefs?.workflowOutcomeRefs?.some(item => item.receipt?.phase === 'work')
  )), false)
})

for (const corruption of ['missing', 'tampered']) {
  test(`Auto V4 recovery fails before Agent invocation when the snapshot blob is ${corruption}`, async (t) => {
    const input = await captureDiscussionCheckpoint(t, 'coordination')
    const ref = input.crashRecord.orchestration.snapshot.contentRef
    const blobPath = path.join(
      input.workspace.contentBlobStore.rootPath, 'sha256', ref.hash.slice(0, 2), ref.hash,
    )
    if (corruption === 'missing') fs.unlinkSync(blobPath)
    else fs.writeFileSync(blobPath, Buffer.alloc(ref.size, 0x78), { mode: 0o600 })
    const recovery = await recoverDiscussion(input, async () => {
      throw new Error('TEST_AGENT_MUST_NOT_RUN')
    })
    const final = await waitFor(() => {
      const record = recovery.recoveryLedger.get(input.crashRecord.runId)
      return record?.status === 'failed' ? record : null
    }, `${corruption} snapshot failure`, 1500)
    assert.deepEqual(recovery.calls, [])
    assert.equal(final.reason, 'LOCAL_RUN_SNAPSHOT_INVALID')
  })
}

test('Auto V4 recovery rejects a legacy ranking-selected synthesis binding before execution', async (t) => {
  const input = await captureDiscussionCheckpoint(t, 'coordination')
  input.crashRecord.orchestration.synthesisBinding = createSynthesisBinding({
    snapshotContentHash: input.crashRecord.orchestration.snapshot.bodyHash,
    targetKinds: input.crashRecord.targetKinds,
    candidates: input.crashRecord.targetKinds.map((kind, index) => ({
      kind,
      score: 100 - index,
      evidence: { matrixVersion: 'legacy-v1', score: 90 - index, confidence: 0.9, sampleSize: 10 },
    })),
  })
  const recovery = await recoverDiscussion(input, async () => {
    throw new Error('TEST_AGENT_MUST_NOT_RUN')
  })
  const final = await waitFor(() => {
    const record = recovery.recoveryLedger.get(input.crashRecord.runId)
    return record?.status === 'failed' ? record : null
  }, 'legacy synthesis binding rejection', 1500)
  assert.deepEqual(recovery.calls, [])
  assert.equal(final.reason, 'LOCAL_RUN_V4_LEGACY_SYNTHESIS_BINDING_UNSUPPORTED')
})

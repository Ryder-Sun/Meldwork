const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { RunLedger } = require('../../src/runs/run-ledger.cjs')
const { RunScheduler } = require('../../src/runs/run-scheduler.cjs')
const { hashValue } = require('../../src/collaboration/orchestration-v4-records.cjs')
const { deferred, fixture } = require('../support/local-workspace-test-helpers.cjs')

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function proposalCollaboration(summary) {
  return {
    version: 1,
    phase: 'proposal',
    summary,
    capabilities: ['Independent analysis'],
    intendedWork: ['Complete the assigned proposal'],
    deliverables: ['Proposal'],
    dependencies: [],
  }
}

async function waitFor(predicate, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await delay(10)
  }
  throw new Error(`TEST_TIMEOUT:${label}`)
}

function installFrozenSkillValidation(workspace, options, directory, targetKind = 'hermes') {
  const skillSnapshotBytes = Buffer.from('{"skill":"manual-v4-frozen","version":1}', 'utf8')
  const snapshotRef = workspace.contentBlobStore.put(skillSnapshotBytes, {
    mediaType: 'application/json',
  })
  const frozenSkill = {
    targetKind,
    namespace: 'global',
    slug: 'frozen-review',
    name: 'Frozen Review',
    snapshotId: `skill-snapshot-${'a'.repeat(64)}`,
    manifestHash: 'a'.repeat(64),
    snapshotRef,
  }
  const entryPath = path.join(directory, 'frozen-skills', targetKind, 'SKILL.md')
  const runtimeHint = (selection = frozenSkill) => {
    const value = { ...selection, snapshotRef: { ...selection.snapshotRef } }
    Object.defineProperty(value, 'entryPath', { value: entryPath })
    return value
  }
  const validationCalls = []
  const validateSkillSelections = async (kind, selections) => {
    validationCalls.push({ kind, selections: structuredClone(selections) })
    if (!selections.length) return []
    assert.equal(kind, targetKind)
    if (!selections.every(skill => skill?.snapshotRef)) return [runtimeHint()]
    for (const skill of selections) {
      assert.deepEqual(workspace.contentBlobStore.read(skill.snapshotRef), skillSnapshotBytes)
    }
    return selections.map(runtimeHint)
  }
  options.validateSkillSelections = validateSkillSelections
  workspace.validateSkillSelectionsFn = validateSkillSelections
  return {
    entryPath,
    frozenSkill,
    validationCalls,
    selection: { targetKind, namespace: 'global', slug: 'frozen-review', name: 'Frozen Review' },
  }
}

test('Manual V4 freezes one durable snapshot and checkpoints each queued slot independently', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger.json'),
    now: () => Date.now(),
  })
  const checkpoints = []
  const checkpoint = ledger.checkpoint.bind(ledger)
  ledger.checkpoint = (record) => {
    const stored = checkpoint(record)
    checkpoints.push(structuredClone(stored))
    return stored
  }
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 2, workspaceLimit: 2, globalLimit: 2 })
  const calls = []
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const running = ledger.list(group.id)[0]
    const slot = running.orchestration.slots.find(candidate => candidate.agentKind === agent.kind)
    const attempt = running.agentRuns.find(candidate => (
      candidate.agentRunId === slot.agentRunId && candidate.kind === agent.kind
    ))
    calls.push({
      kind: agent.kind,
      prompt,
      sandbox: runOptions.sandbox,
      persistedAgentRunId: slot.agentRunId,
      persistedAttemptStatus: attempt?.status || '',
    })
    await delay({ codex: 35, hermes: 5, workbuddy: 15 }[agent.kind])
    return {
      text: `${agent.kind} durable proposal`,
      sessionRef: `${agent.kind}-session`,
      collaboration: proposalCollaboration(`${agent.kind} independent proposal`),
    }
  }

  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const selectedSkill = installFrozenSkillValidation(workspace, options, directory)
  const group = workspace.createGroup({
    name: 'Durable Manual V4',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: false,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Compare three independent approaches.',
    mode: 'manual',
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    protocol: 'v4',
    skillHints: [selectedSkill.selection],
  })

  const record = ledger.list(group.id)[0]
  assert.equal(record.orchestration.version, 4)
  assert.deepEqual(record.orchestration.slots.map(slot => slot.agentKind), [
    'codex', 'hermes', 'workbuddy',
  ])
  assert.equal(new Set(record.orchestration.slots.map(slot => slot.snapshotHash)).size, 1)
  assert.equal(record.orchestration.snapshotHash, record.orchestration.slots[0].snapshotHash)
  const frozenBody = JSON.parse(workspace.contentBlobStore.read(
    record.orchestration.snapshot.contentRef,
  ).toString('utf8'))
  assert.equal(frozenBody.taskText, 'Compare three independent approaches.')
  assert.deepEqual(frozenBody.targetKinds, ['codex', 'hermes', 'workbuddy'])
  assert.deepEqual(frozenBody.skillHintsByKind, [
    { kind: 'codex', skillHints: [] },
    { kind: 'hermes', skillHints: [selectedSkill.frozenSkill] },
    { kind: 'workbuddy', skillHints: [] },
  ])
  assert.equal(frozenBody.history.some(item => /durable proposal/.test(item.text)), false)
  assert.equal(calls.length, 3)
  assert.equal(calls.every(call => call.sandbox === 'read-only'), true)
  assert.equal(calls.every(call => call.persistedAgentRunId), true)
  assert.equal(
    calls.every(call => call.persistedAttemptStatus === 'running'), true,
  )
  assert.equal(calls.every(call => !/durable proposal/.test(call.prompt)), true)
  assert.match(calls.find(call => call.kind === 'hermes').prompt, /global\/frozen-review: Frozen Review/)
  assert.match(calls.find(call => call.kind === 'hermes').prompt, new RegExp(selectedSkill.entryPath))
  assert.equal(calls.filter(call => call.kind !== 'hermes')
    .every(call => !call.prompt.includes('Frozen Review')), true)
  assert.equal(record.orchestration.plan.assignments.every(assignment => assignment.readOnly), true)
  assert.equal(record.orchestration.collaboration.entries.length, 3)
  for (const entry of record.orchestration.collaboration.entries) {
    assert.equal(entry.statement, `${entry.owner.agentKind} independent proposal`)
    assert.equal(entry.value, entry.statement)
    assert.equal(entry.value.includes('durable proposal'), false)
    assert.ok(entry.provenance.artifactIds.length >= 1)
    assert.ok(entry.provenance.evidenceIds.length >= 1)
    assert.equal(entry.refs.includes(entry.provenance.artifactIds[0]), true)
    assert.equal(entry.refs.includes(entry.provenance.evidenceIds[0]), true)
  }

  for (const kind of ['codex', 'hermes', 'workbuddy']) {
    const statuses = checkpoints.flatMap(item => item.orchestration?.slots || [])
      .filter(slot => slot.agentKind === kind)
      .map(slot => slot.status)
    assert.equal(statuses.includes('running'), true, `${kind} running checkpoint`)
    assert.equal(statuses.includes('completed'), true, `${kind} completed checkpoint`)
  }
  const hermesCompleted = checkpoints.findIndex(item => item.orchestration?.slots?.some(slot => (
    slot.agentKind === 'hermes' && slot.status === 'completed'
  )))
  const codexCompleted = checkpoints.findIndex(item => item.orchestration?.slots?.some(slot => (
    slot.agentKind === 'codex' && slot.status === 'completed'
  )))
  assert.ok(hermesCompleted >= 0 && hermesCompleted < codexCompleted)
})

test('Manual V4 starts a four-Agent concurrent batch without task-level queueing', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger.json'),
    now: () => Date.now(),
  })
  options.runLedger = ledger
  options.runScheduler = new RunScheduler()
  const releases = new Map([
    ['codex', deferred()],
    ['hermes', deferred()],
    ['openclaw', deferred()],
    ['workbuddy', deferred()],
  ])
  options.runAgent = agent => releases.get(agent.kind).promise

  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const targetKinds = ['codex', 'hermes', 'openclaw', 'workbuddy']
  const group = workspace.createGroup({
    name: 'Four Agent concurrent batch',
    agentKinds: targetKinds,
    workdir: directory,
    allowWrite: false,
  })
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Start every selected Agent together.',
    mode: 'manual',
    targetKinds,
    protocol: 'v4',
  })

  const running = await waitFor(() => {
    const record = ledger.list(group.id)[0]
    return record?.orchestration?.slots.every(slot => slot.status === 'running') ? record : null
  }, 'all four slots running')
  assert.deepEqual(running.orchestration.currentKinds, targetKinds)
  assert.deepEqual(options.runScheduler.snapshot().queued, [])

  for (const kind of targetKinds) releases.get(kind).resolve({
    text: `${kind} concurrent response`,
    sessionRef: `${kind}-session`,
    collaboration: proposalCollaboration(`${kind} concurrent summary`),
  })
  await send
})

test('Manual V4 keeps its durable result body separate at the reported Artifact cap', async (t) => {
  for (const reportedCount of [63, 64]) {
    await t.test(`${reportedCount} reported Artifact IDs`, async (t) => {
      const { directory, options } = fixture()
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
      const ledger = new RunLedger({
        storagePath: path.join(directory, `run-ledger-${reportedCount}.json`),
        now: () => Date.now(),
      })
      options.runLedger = ledger
      options.runScheduler = new RunScheduler({ taskLimit: 2, workspaceLimit: 2, globalLimit: 2 })
      const exactBody = `codex exact body with ${reportedCount} reported Artifact IDs`
      let reportedArtifactIds = []
      options.runAgent = async agent => ({
        text: agent.kind === 'codex' ? exactBody : `${agent.kind} peer proposal`,
        sessionRef: `${agent.kind}-${reportedCount}-artifact-cap-session`,
        collaboration: proposalCollaboration(`${agent.kind} artifact-cap proposal`),
        ...(agent.kind === 'codex' ? {
          outcomeRefs: { artifactIds: reportedArtifactIds },
        } : {}),
      })

      const workspace = new LocalWorkspace(options)
      reportedArtifactIds = Array.from({ length: reportedCount }, (_, index) => {
        const contentRef = workspace.contentBlobStore.put(
          `Reported Artifact ${index + 1} of ${reportedCount}`,
          { mediaType: 'text/plain' },
        )
        return workspace.outcomeStore.putArtifact({
          type: 'document',
          name: `reported-${reportedCount}-${index + 1}.txt`,
          producedBy: {
            runId: `run-reported-artifacts-${reportedCount}`,
            agentRunId: `agent-run-reported-artifacts-${reportedCount}`,
            agentKind: 'codex',
          },
          contentRef,
          contentHash: contentRef.hash,
        }).artifactId
      })
      await workspace.refreshAgents()
      const group = workspace.createGroup({
        name: `Manual V4 ${reportedCount} Artifact cap`,
        agentKinds: ['codex', 'hermes'],
        workdir: directory,
        allowWrite: false,
      })

      await workspace.sendMessage({
        groupId: group.id,
        text: `Commit ${reportedCount} reported Artifacts without consuming the body slot.`,
        mode: 'manual',
        targetKinds: ['codex', 'hermes'],
        protocol: 'v4',
      })

      const final = ledger.list(group.id)[0]
      assert.ok(final)
      const failureReason = workspace.state.messages.find(message => (
        message.role === 'system' && message.agentKind === 'codex'
      ))?.system?.params?.reason
      assert.equal(final.status, 'completed', failureReason)
      assert.equal(final.orchestration.phase, 'completed')
      assert.equal(final.orchestration.commitState.status, 'committed')
      assert.deepEqual(final.orchestration.commitState.committedKinds, ['codex', 'hermes'])
      const slot = final.orchestration.slots.find(candidate => candidate.agentKind === 'codex')
      assert.ok(slot)
      assert.equal(slot.status, 'completed')
      assert.equal(slot.commitStatus, 'committed')
      assert.match(slot.resultBodyArtifactId, /^artifact-/)
      const workflowRecord = slot.resultRefs.workflowOutcomeRefs.find(item => (
        item.receipt?.receiptId === slot.receiptId
      ))
      assert.ok(workflowRecord)

      for (const artifactId of reportedArtifactIds) {
        assert.equal(workflowRecord.receipt.artifactIds.includes(artifactId), true)
        assert.equal(slot.resultRefs.artifactIds.includes(artifactId), true)
      }
      assert.ok(workflowRecord.receipt.artifactIds.length <= 64)
      assert.ok(slot.resultRefs.artifactIds.length <= 64)
      assert.equal(workflowRecord.receipt.artifactIds.includes(slot.resultBodyArtifactId), false)
      assert.equal(slot.resultRefs.artifactIds.includes(slot.resultBodyArtifactId), false)

      const storedBody = workspace.messageSubmission.loadV4ResultBody(slot)
      assert.equal(storedBody.content, exactBody)
      const committedMessage = workspace.state.messages.find(message => message.id === slot.messageId)
      assert.equal(committedMessage.content, exactBody)
      assert.equal(workflowRecord.blackboardEntry.refs.includes(slot.resultBodyArtifactId), true)
      assert.equal(slot.resultBodyArtifactId.length > 0, true)
    })
  }
})

test('Manual V4 restart retains a settled slot and reruns only unfinished safe slots', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger.json'),
    now: () => Date.now(),
  })
  const checkpoints = []
  const checkpoint = ledger.checkpoint.bind(ledger)
  ledger.checkpoint = (record) => {
    const stored = checkpoint(record)
    checkpoints.push(structuredClone(stored))
    return stored
  }
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 1, workspaceLimit: 1, globalLimit: 1 })
  const originalCalls = []
  options.runAgent = async (agent, prompt) => {
    originalCalls.push({ kind: agent.kind, prompt })
    await delay(5)
    return {
      text: `${agent.kind} original proposal`,
      sessionRef: `${agent.kind}-original-session`,
      collaboration: proposalCollaboration(`${agent.kind} original summary`),
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const selectedSkill = installFrozenSkillValidation(workspace, options, directory)
  const group = workspace.createGroup({
    name: 'Restart Manual V4',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: false,
  })
  await workspace.sendMessage({
    groupId: group.id,
    text: 'Recover the unfinished batch.',
    mode: 'manual',
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    protocol: 'v4',
    skillHints: [selectedSkill.selection],
  })

  const interrupted = checkpoints.find(record => {
    const statuses = new Map(record.orchestration?.slots?.map(slot => [slot.agentKind, slot.status]))
    return statuses.get('codex') === 'completed'
      && statuses.get('hermes') === 'running'
      && ['planned', 'running'].includes(statuses.get('workbuddy'))
  })
  assert.ok(interrupted, 'intermediate checkpoint captured')

  const workspaceState = JSON.parse(fs.readFileSync(options.storagePath, 'utf8'))
  workspaceState.messages = workspaceState.messages.filter(message => message.role !== 'agent')
  const recoveryStoragePath = path.join(directory, 'workspace-recovery.json')
  fs.writeFileSync(
    recoveryStoragePath,
    `${JSON.stringify(workspaceState, null, 2)}\n`,
  )
  const recoveryLedger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger-recovery.json'),
    now: () => Date.now(),
  })
  recoveryLedger.checkpoint(interrupted)
  const recoveryCalls = []
  const recoveryOptions = {
    ...options,
    storagePath: recoveryStoragePath,
    runLedger: recoveryLedger,
    runScheduler: new RunScheduler({ taskLimit: 1, workspaceLimit: 1, globalLimit: 1 }),
    runAgent: async (agent, prompt) => {
      recoveryCalls.push({ kind: agent.kind, prompt })
      return {
        text: `${agent.kind} recovered proposal`,
        sessionRef: `${agent.kind}-recovered-session`,
        collaboration: proposalCollaboration(`${agent.kind} recovered summary`),
        outcome: 'completed',
      }
    },
  }
  const recovered = new LocalWorkspace(recoveryOptions)
  await recovered.refreshAgents()
  await waitFor(() => {
    const record = recoveryLedger.get(interrupted.runId)
    return ['completed', 'partial'].includes(record?.status) ? record : null
  }, 'recovered Manual V4 run')

  assert.deepEqual(recoveryCalls.map(call => call.kind), ['hermes', 'workbuddy'])
  assert.match(originalCalls.find(call => call.kind === 'hermes').prompt, /Frozen Review/)
  assert.match(recoveryCalls.find(call => call.kind === 'hermes').prompt, /Frozen Review/)
  assert.match(recoveryCalls.find(call => call.kind === 'hermes').prompt,
    new RegExp(selectedSkill.entryPath))
  assert.doesNotMatch(recoveryCalls.find(call => call.kind === 'workbuddy').prompt, /Frozen Review/)
  assert.deepEqual(
    recovered.snapshot().messages.filter(message => message.role === 'agent')
      .map(message => `${message.agentKind}:${message.content}`),
    [
      'codex:codex original proposal',
      'hermes:hermes recovered proposal',
      'workbuddy:workbuddy recovered proposal',
    ],
  )
  const final = recoveryLedger.get(interrupted.runId)
  assert.deepEqual(final.orchestration.commitState.committedKinds, [
    'codex', 'hermes', 'workbuddy',
  ])
  assert.equal(new Set(final.orchestration.commitState.messageIds).size, 3)
  assert.equal(new Set(final.orchestration.commitState.blackboardEntryIds).size, 3)
})

test('Manual V4 recovery safely invokes a queued writer that never acquired a lease', async (t) => {
  const { directory, options } = fixture()
  const detectAgents = options.detectAgents
  options.detectAgents = async () => (await detectAgents()).map(agent => agent.kind === 'codex'
    ? { ...agent, routingCapabilities: { permissionModes: ['read-only'] } } : agent)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger.json'),
    now: () => Date.now(),
  })
  options.runLedger = ledger
  const scheduler = new RunScheduler({ taskLimit: 1, workspaceLimit: 1, globalLimit: 1 })
  options.runScheduler = scheduler
  const blocker = deferred()
  const initialCalls = []
  options.runAgent = async (agent) => {
    initialCalls.push(agent.kind)
    if (agent.kind === 'codex') return blocker.promise
    return {
      text: `${agent.kind} unexpected initial proposal`,
      sessionRef: `${agent.kind}-initial-session`,
      collaboration: proposalCollaboration(`${agent.kind} unexpected initial summary`),
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Manual V4 queued writer recovery',
    agentKinds: ['codex', 'workbuddy', 'hermes'],
    workdir: directory,
    allowWrite: true,
  })
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Recover a writer that crashed while still queued.',
    mode: 'manual',
    targetKinds: ['codex', 'workbuddy', 'hermes'],
    protocol: 'v4',
  })
  const crashRecord = await waitFor(() => {
    const record = ledger.list(group.id)[0]
    return scheduler.snapshot().queued.length === 2
      && record?.orchestration?.slots.length === 3
      ? structuredClone(record)
      : null
  }, 'queued writer checkpoint')
  const writerKind = crashRecord.orchestration.commitState.writerKind
  const writerSlot = crashRecord.orchestration.slots.find(slot => slot.agentKind === writerKind)
  assert.ok(['workbuddy', 'hermes'].includes(writerKind))
  assert.deepEqual(initialCalls, ['codex'])

  const recoveryStoragePath = path.join(directory, 'workspace-queued-writer.json')
  fs.copyFileSync(options.storagePath, recoveryStoragePath)
  const stopping = workspace.stopAll()
  blocker.resolve({
    text: 'codex result after captured crash',
    sessionRef: 'codex-captured-session',
    collaboration: proposalCollaboration('codex captured summary'),
  })
  await stopping
  await send
  assert.equal(writerSlot.status, 'queued')

  const recoveryLedger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger-queued-writer.json'),
    now: () => Date.now(),
  })
  recoveryLedger.checkpoint(crashRecord)
  const recoveryCalls = []
  const recovered = new LocalWorkspace({
    ...options,
    storagePath: recoveryStoragePath,
    runLedger: recoveryLedger,
    runScheduler: new RunScheduler({ taskLimit: 1, workspaceLimit: 1, globalLimit: 1 }),
    runAgent: async (agent, prompt, _workdir, runOptions) => {
      recoveryCalls.push({
        kind: agent.kind,
        operationId: runOptions.operationId,
        sandbox: runOptions.sandbox,
        prompt,
      })
      return {
        text: `${agent.kind} recovered queued proposal`,
        sessionRef: `${agent.kind}-recovered-session`,
        outcome: 'completed',
        collaboration: proposalCollaboration(`${agent.kind} recovered queued summary`),
      }
    },
  })
  await recovered.refreshAgents()
  const final = await waitFor(() => {
    const record = recoveryLedger.get(crashRecord.runId)
    return ['completed', 'partial', 'failed'].includes(record?.status) ? record : null
  }, 'recovered queued writer')

  assert.deepEqual(recoveryCalls.map(call => call.kind), ['codex', 'workbuddy', 'hermes'])
  assert.deepEqual(final.orchestration.slots.map(slot => ({
    kind: slot.agentKind,
    status: slot.status,
    commitStatus: slot.commitStatus,
  })), [
    { kind: 'codex', status: 'completed', commitStatus: 'committed' },
    { kind: 'workbuddy', status: 'completed', commitStatus: 'committed' },
    { kind: 'hermes', status: 'completed', commitStatus: 'committed' },
  ])
  assert.equal(final.status, 'completed')
  for (const call of recoveryCalls) {
    const slot = crashRecord.orchestration.slots.find(item => item.agentKind === call.kind)
    assert.equal(call.operationId, slot.operationId)
    assert.equal(call.sandbox, call.kind === 'codex' ? 'read-only' : 'workspace-write')
    assert.match(call.prompt, /Recover a writer that crashed while still queued\./)
    assert.match(
      call.prompt,
      call.kind === 'codex' ? /This reply is read-only/ : /user enabled workspace writes/i,
    )
    assert.equal(/This reply is read-only/.test(call.prompt), call.kind === 'codex')
  }
  assert.deepEqual(final.orchestration.commitState.committedKinds, [
    'codex', 'workbuddy', 'hermes',
  ])
})

test('Manual V4 recovers multiple interrupted writers with separate approvals', async (t) => {
  const { directory, options } = fixture()
  const release = deferred()
  const started = deferred()
  t.after(() => {
    release.resolve()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const ledger = new RunLedger({ storagePath: path.join(directory, 'original-ledger.json') })
  options.runLedger = ledger
  options.runScheduler = new RunScheduler()
  let count = 0
  options.runAgent = async agent => {
    if (++count === 3) started.resolve()
    await release.promise
    return { text: `${agent.kind} original response` }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Interrupted native writers', agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory, allowWrite: true,
  })
  const send = workspace.sendMessage({
    groupId: group.id, text: 'Write independent drafts.', mode: 'manual',
    protocol: 'v4', targetKinds: group.agentKinds,
  })
  await started.promise
  const crash = structuredClone(ledger.list(group.id)[0])
  assert.equal(crash.orchestration.slots.filter(slot => slot.status === 'running').length, 3)
  const recoveryPath = path.join(directory, 'recovery-workspace.json')
  fs.copyFileSync(options.storagePath, recoveryPath)
  release.resolve()
  await workspace.stopAll()
  await send
  const recoveryLedger = new RunLedger({ storagePath: path.join(directory, 'recovery-ledger.json') })
  recoveryLedger.checkpoint(crash)
  const calls = []
  const recovered = new LocalWorkspace({
    ...options, storagePath: recoveryPath, runLedger: recoveryLedger,
    runScheduler: new RunScheduler(),
    runAgent: async (agent, _prompt, _cwd, runtime) => {
      calls.push(agent.kind)
      assert.equal(runtime.sandbox, 'workspace-write')
      return { text: `${agent.kind} approved recovery`, outcome: 'completed' }
    },
  })
  await recovered.refreshAgents()
  const approved = []
  for (let index = 0; index < 3; index++) {
    const gate = await waitFor(() => recovered.listHumanGates({ pendingOnly: true })[0],
      `interrupted writer approval ${index}`)
    assert.deepEqual(calls, approved)
    approved.push(recoveryLedger.get(crash.runId).continuation.agentKind)
    recovered.decideHumanGate(gate.gateId, {
      status: 'approved', optionId: 'retry-once', actorId: 'local-user',
    })
    await waitFor(() => calls.length === index + 1, `approved writer ${index}`)
  }
  const final = await waitFor(() => {
    const run = recoveryLedger.get(crash.runId)
    return run.status === 'completed' ? run : null
  }, 'all interrupted writers recovered')
  assert.deepEqual(calls, approved)
  assert.equal(new Set(calls).size, 3)
  assert.equal(final.orchestration.commitState.committedKinds.length, 3)
})

test('Manual V4 restart requires a new Gate after an approved retry lease crashes', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger.json'),
    now: () => Date.now(),
  })
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 1, workspaceLimit: 1, globalLimit: 1 })
  options.runAgent = async agent => ({
    text: `${agent.kind} original leased proposal`,
    sessionRef: `${agent.kind}-original-session`,
    collaboration: proposalCollaboration(`${agent.kind} original leased summary`),
  })
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Manual V4 leased writer recovery',
    agentKinds: ['codex', 'workbuddy', 'hermes'],
    workdir: directory,
    allowWrite: true,
  })
  let crashRecord = null
  let releaseCrash
  const crashCheckpoint = new Promise(resolve => { releaseCrash = resolve })
  const checkpointRun = workspace.checkpointRun.bind(workspace)
  workspace.checkpointRun = (groupId, controller, status = '') => {
    const persisted = checkpointRun(groupId, controller, status)
    const leasedWriter = controller.orchestration?.slots?.find(slot => (
      slot.permission === 'workspace-write' && slot.status === 'running' && slot.attempt === 1
    ))
    if (!crashRecord && leasedWriter) {
      crashRecord = structuredClone(ledger.get(controller.runId))
      releaseCrash()
      throw new Error('TEST_CRASH:MANUAL_V4_WRITER_LEASED')
    }
    return persisted
  }
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Require a durable decision before replaying an uncertain writer.',
    mode: 'manual',
    targetKinds: ['codex', 'workbuddy', 'hermes'],
    protocol: 'v4',
  })
  await crashCheckpoint
  assert.ok(crashRecord)
  const writerSlot = crashRecord.orchestration.slots.find(slot => slot.permission === 'workspace-write' && slot.status === 'running')
  const writerKind = writerSlot.agentKind
  assert.equal(writerSlot.status, 'running')
  assert.equal(writerSlot.permission, 'workspace-write')
  assert.equal(writerSlot.attempt, 1)

  const recoveryStoragePath = path.join(directory, 'workspace-leased-writer-recovery.json')
  fs.copyFileSync(options.storagePath, recoveryStoragePath)
  await workspace.stopAll()
  await send
  const recoveryLedger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger-leased-writer-recovery.json'),
    now: () => Date.now(),
  })
  recoveryLedger.checkpoint(crashRecord)
  const recoveryCalls = []
  const recovered = new LocalWorkspace({
    ...options,
    storagePath: recoveryStoragePath,
    runLedger: recoveryLedger,
    runScheduler: new RunScheduler({ taskLimit: 1, workspaceLimit: 1, globalLimit: 1 }),
    runAgent: async (agent, _prompt, _workdir, runOptions) => {
      recoveryCalls.push({
        kind: agent.kind,
        operationId: runOptions.operationId,
        sandbox: runOptions.sandbox,
      })
      return {
        text: `${agent.kind} recovered after approval`,
        sessionRef: `${agent.kind}-recovered-session`,
        outcome: 'completed',
        collaboration: proposalCollaboration(`${agent.kind} recovered after approval summary`),
      }
    },
  })
  await recovered.refreshAgents()
  const gate = await waitFor(() => recovered.listHumanGates({ pendingOnly: true })[0],
    'leased writer recovery gate')
  const waiting = recoveryLedger.get(crashRecord.runId)

  assert.deepEqual(recoveryCalls, [])
  assert.equal(waiting.status, 'waiting')
  assert.equal(waiting.continuation.resumeKind, 'agent_slot')
  assert.equal(waiting.continuation.agentKind, writerKind)
  assert.equal(waiting.continuation.agentRunId, writerSlot.operationId)
  assert.deepEqual(waiting.orchestration.commitState.committedKinds, [])
  assert.equal(
    recovered.snapshot().messages.some(message => message.groupId === group.id && message.role === 'agent'),
    false,
  )

  assert.equal(recovered.humanGateStore.request(gate.gateId).attempt, 1)
  let retryCrashRecord = null
  let releaseRetryCrash
  const retryCrashCheckpoint = new Promise(resolve => { releaseRetryCrash = resolve })
  const recoveryCheckpointRun = recovered.checkpointRun.bind(recovered)
  recovered.checkpointRun = (groupId, controller, status = '') => {
    const persisted = recoveryCheckpointRun(groupId, controller, status)
    const retriedWriter = controller.orchestration?.slots?.find(slot => (
      slot.permission === 'workspace-write' && slot.status === 'running' && slot.attempt === 2
    ))
    if (!retryCrashRecord && retriedWriter) {
      retryCrashRecord = structuredClone(recoveryLedger.get(controller.runId))
      releaseRetryCrash()
      throw new Error('TEST_CRASH:MANUAL_V4_APPROVED_RETRY_LEASED')
    }
    return persisted
  }

  recovered.decideHumanGate(gate.gateId, {
    status: 'approved', optionId: 'retry-once', actorId: 'local-user',
  })
  await retryCrashCheckpoint
  assert.ok(retryCrashRecord)
  const retriedWriter = retryCrashRecord.orchestration.slots.find(slot => (
    slot.agentKind === writerKind
  ))
  assert.equal(retriedWriter.status, 'running')
  assert.equal(retriedWriter.attempt, 2)
  assert.equal(retryCrashRecord.continuation || null, null)
  assert.deepEqual(recoveryCalls, [])
  await waitFor(() => !recovered.activeRuns.has(group.id), 'first recovery crash cleanup')

  const secondRecoveryLedger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger-second-leased-writer-recovery.json'),
    now: () => Date.now(),
  })
  secondRecoveryLedger.checkpoint(retryCrashRecord)
  const secondRecoveryCalls = []
  const secondRecovered = new LocalWorkspace({
    ...options,
    storagePath: recoveryStoragePath,
    runLedger: secondRecoveryLedger,
    runScheduler: new RunScheduler({ taskLimit: 1, workspaceLimit: 1, globalLimit: 1 }),
    runAgent: async (agent, _prompt, _workdir, runOptions) => {
      secondRecoveryCalls.push({
        kind: agent.kind,
        operationId: runOptions.operationId,
        sandbox: runOptions.sandbox,
      })
      return {
        text: `${agent.kind} recovered after attempt-bound approval`,
        sessionRef: `${agent.kind}-attempt-bound-recovery-session`,
        outcome: 'completed',
        collaboration: proposalCollaboration(
          `${agent.kind} recovered after attempt-bound approval summary`,
        ),
      }
    },
  })
  await secondRecovered.refreshAgents()
  const secondGate = await waitFor(
    () => secondRecovered.listHumanGates({ pendingOnly: true })
      .find(candidate => candidate.gateId !== gate.gateId),
    'second leased writer recovery gate',
  )

  assert.deepEqual(secondRecoveryCalls, [])
  assert.notEqual(secondGate.gateId, gate.gateId)
  assert.equal(secondRecovered.humanGateStore.request(secondGate.gateId).attempt, 2)
  secondRecovered.decideHumanGate(secondGate.gateId, {
    status: 'rejected', optionId: 'cancel-retry', actorId: 'local-user',
  })
  const final = await waitFor(() => {
    const record = secondRecoveryLedger.get(crashRecord.runId)
    return ['completed', 'partial', 'failed', 'stopped'].includes(record?.status) ? record : null
  }, 'second rejected leased writer recovery')

  assert.equal(final.status, 'stopped', final.reason)
  assert.deepEqual(secondRecoveryCalls, [])
  assert.deepEqual(final.orchestration.commitState.committedKinds, [])
})

async function exerciseBarrierCrashRecovery(t, crashPoint) {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger.json'),
    now: () => Date.now(),
  })
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 2, workspaceLimit: 2, globalLimit: 2 })
  options.runAgent = async agent => ({
    text: `${agent.kind} crash-safe proposal`,
    sessionRef: `${agent.kind}-session`,
    collaboration: proposalCollaboration(`${agent.kind} crash-safe summary`),
  })
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: `Barrier crash ${crashPoint}`,
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: false,
  })

  let crashRecord = null
  if (crashPoint === 'before-first-write' || crashPoint === 'between-member-writes') {
    const commitMessage = workspace.commitV4AgentMessage.bind(workspace)
    let commitCalls = 0
    workspace.commitV4AgentMessage = (input) => {
      commitCalls += 1
      if ((crashPoint === 'before-first-write' && commitCalls === 1)
          || (crashPoint === 'between-member-writes' && commitCalls === 2)) {
        crashRecord = structuredClone(ledger.list(group.id)[0])
        throw new Error(`TEST_CRASH:${crashPoint}`)
      }
      return commitMessage(input)
    }
  } else {
    const checkpointRun = workspace.checkpointRun.bind(workspace)
    workspace.checkpointRun = (groupId, controller, status = '') => {
      if (!crashRecord && controller.orchestration?.phase === 'completed') {
        crashRecord = structuredClone(ledger.get(controller.runId))
        throw new Error(`TEST_CRASH:${crashPoint}`)
      }
      return checkpointRun(groupId, controller, status)
    }
  }

  await assert.rejects(workspace.sendMessage({
    groupId: group.id,
    text: 'Commit every settled response exactly once.',
    mode: 'manual',
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    protocol: 'v4',
  }), new RegExp(`TEST_CRASH:${crashPoint}`))
  assert.ok(crashRecord, 'durable pre-crash checkpoint captured')

  const recoveryStoragePath = path.join(directory, `workspace-recovery-${crashPoint}.json`)
  fs.copyFileSync(options.storagePath, recoveryStoragePath)
  const recoveryLedger = new RunLedger({
    storagePath: path.join(directory, `run-ledger-recovery-${crashPoint}.json`),
    now: () => Date.now(),
  })
  recoveryLedger.checkpoint(crashRecord)
  const recoveryCalls = []
  const recovered = new LocalWorkspace({
    ...options,
    storagePath: recoveryStoragePath,
    runLedger: recoveryLedger,
    runAgent: async (agent) => {
      recoveryCalls.push(agent.kind)
      throw new Error('TEST_AGENT_MUST_NOT_RERUN')
    },
  })
  await recovered.refreshAgents()
  const final = await waitFor(() => {
    const record = recoveryLedger.get(crashRecord.runId)
    return ['completed', 'partial'].includes(record?.status) ? record : null
  }, `recovered ${crashPoint}`)

  assert.deepEqual(recoveryCalls, [])
  assert.deepEqual(
    recovered.snapshot().messages.filter(message => (
      message.groupId === group.id && message.role === 'agent'
    )).map(message => `${message.agentKind}:${message.content}`),
    [
      'codex:codex crash-safe proposal',
      'hermes:hermes crash-safe proposal',
      'workbuddy:workbuddy crash-safe proposal',
    ],
  )
  assert.deepEqual(final.orchestration.commitState.committedKinds, [
    'codex', 'hermes', 'workbuddy',
  ])
  assert.equal(new Set(final.orchestration.commitState.messageIds).size, 3)
  assert.equal(new Set(final.orchestration.commitState.blackboardEntryIds).size, 3)
  assert.equal(final.orchestration.collaboration.entries.length, 3)
}

for (const [name, crashPoint] of [
  ['before the first barrier write', 'before-first-write'],
  ['between member barrier writes', 'between-member-writes'],
  ['after all writes before the terminal checkpoint', 'after-writes-before-terminal'],
]) {
  test(`Manual V4 recovery commits exactly once ${name}`, async (t) => {
    await exerciseBarrierCrashRecovery(t, crashPoint)
  })
}

test('Manual V4 rejects a late slot result after the batch is stopped', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger.json'),
    now: () => Date.now(),
  })
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 3, workspaceLimit: 3, globalLimit: 3 })
  const late = deferred()
  options.runAgent = async (agent) => {
    if (agent.kind === 'codex') return late.promise
    return {
      text: `${agent.kind} settled before stop`,
      sessionRef: `${agent.kind}-session`,
      collaboration: proposalCollaboration(`${agent.kind} settled summary`),
    }
  }

  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Manual V4 late result',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: false,
  })
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Stop the batch before the delayed result returns.',
    mode: 'manual',
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    protocol: 'v4',
  })
  const running = await waitFor(() => {
    const record = ledger.list(group.id)[0]
    const statuses = new Map(record?.orchestration?.slots.map(slot => [
      slot.agentKind, slot.status,
    ]))
    return statuses.get('codex') === 'running'
      && statuses.get('hermes') === 'completed'
      && statuses.get('workbuddy') === 'completed'
      ? record
      : null
  }, 'running late-result slot')

  assert.equal(workspace.stop(group.id, running.runId), true)
  await send
  late.resolve({
    text: 'codex late result must be ignored',
    sessionRef: 'codex-late-session',
    collaboration: proposalCollaboration('codex late summary'),
  })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  const final = ledger.get(running.runId)
  const lateSlot = final.orchestration.slots.find(slot => slot.agentKind === 'codex')
  assert.equal(final.status, 'stopped')
  assert.equal(lateSlot.status, 'stopped')
  assert.equal(lateSlot.resultBodyArtifactId, undefined)
  assert.deepEqual(lateSlot.resultRefs?.artifactIds || [], [])
  assert.equal(final.orchestration.commitState.committedKinds.includes('codex'), false)
  assert.deepEqual(final.orchestration.commitState.committedKinds, ['hermes', 'workbuddy'])
  assert.equal(final.orchestration.collaboration.entries.some(entry => (
    entry.owner?.agentKind === 'codex'
  )), false)
  assert.equal(workspace.snapshot().messages.some(message => (
    message.role === 'agent'
    && message.agentKind === 'codex'
    && message.content === 'codex late result must be ignored'
  )), false)
  assert.deepEqual(workspace.snapshot().messages.filter(message => (
    message.role === 'agent' && message.threadRootId === running.threadRootId
  )).map(message => `${message.agentKind}:${message.content}`), [
    'hermes:hermes settled before stop',
    'workbuddy:workbuddy settled before stop',
  ])
})

test('Manual V4 persists streamed output from a slot stopped by the user', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger.json'),
    now: () => Date.now(),
  })
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 2, workspaceLimit: 2, globalLimit: 2 })
  const codexStarted = deferred()
  options.runAgent = async (agent, _prompt, _workdir, runOptions) => {
    if (agent.kind !== 'codex') return {
      text: 'hermes settled before stop',
      sessionRef: 'hermes-session',
      collaboration: proposalCollaboration('hermes settled summary'),
    }
    runOptions.onEvent({
      type: 'answer_delta',
      status: 'running',
      delta: 'codex partial streamed response',
    })
    codexStarted.resolve()
    return await new Promise((_resolve, reject) => {
      runOptions.signal.addEventListener(
        'abort', () => reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED')), { once: true },
      )
    })
  }

  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Manual V4 streamed stop',
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
    allowWrite: false,
  })
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Keep partial output when this batch is stopped.',
    mode: 'manual',
    targetKinds: ['codex', 'hermes'],
    protocol: 'v4',
  })
  await codexStarted.promise
  const running = ledger.list(group.id)[0]

  assert.equal(workspace.stop(group.id, running.runId), true)
  await send

  const final = ledger.get(running.runId)
  const codexSlot = final.orchestration.slots.find(slot => slot.agentKind === 'codex')
  const stoppedMessage = workspace.snapshot().messages.find(message => (
    message.system?.key === 'system.agentStopped'
      && message.agentKind === 'codex'
      && message.threadRootId === running.threadRootId
  ))
  assert.equal(final.status, 'stopped')
  assert.equal(codexSlot.status, 'stopped')
  assert.equal(stoppedMessage.content, 'Codex was stopped.\ncodex partial streamed response')
  assert.equal(stoppedMessage.trace.status, 'stopped')
  assert.equal(stoppedMessage.trace.agentRunId, codexSlot.agentRunId)
})

test('Manual V4 recovery fails closed when immutable recovery bodies are missing', async (t) => {
  for (const missingBody of ['snapshot', 'result-body']) {
    await t.test(missingBody, async (subtest) => {
      const { directory, options } = fixture()
      subtest.after(() => fs.rmSync(directory, { recursive: true, force: true }))
      const ledger = new RunLedger({
        storagePath: path.join(directory, 'run-ledger.json'),
        now: () => Date.now(),
      })
      options.runLedger = ledger
      options.runScheduler = new RunScheduler({ taskLimit: 3, workspaceLimit: 3, globalLimit: 3 })
      options.runAgent = async agent => ({
        text: `${agent.kind} immutable proposal`,
        sessionRef: `${agent.kind}-session`,
        collaboration: proposalCollaboration(`${agent.kind} immutable summary`),
      })
      const workspace = new LocalWorkspace(options)
      await workspace.refreshAgents()
      const group = workspace.createGroup({
        name: `Missing ${missingBody}`,
        agentKinds: ['codex', 'hermes', 'workbuddy'],
        workdir: directory,
        allowWrite: false,
      })
      let crashRecord = null
      workspace.commitV4AgentMessage = () => {
        crashRecord = structuredClone(ledger.list(group.id)[0])
        throw new Error(`TEST_CRASH:${missingBody}`)
      }
      await assert.rejects(workspace.sendMessage({
        groupId: group.id,
        text: 'Never reconstruct immutable recovery data from chat history.',
        mode: 'manual',
        targetKinds: ['codex', 'hermes', 'workbuddy'],
        protocol: 'v4',
      }), new RegExp(`TEST_CRASH:${missingBody}`))
      assert.ok(crashRecord)

      const contentRef = missingBody === 'snapshot'
        ? crashRecord.orchestration.snapshot.contentRef
        : workspace.outcomeStore.getArtifact(
            crashRecord.orchestration.slots[0].resultBodyArtifactId,
          ).contentRef
      fs.unlinkSync(path.join(
        workspace.contentBlobStore.rootPath,
        'sha256',
        contentRef.hash.slice(0, 2),
        contentRef.hash,
      ))

      const recoveryStoragePath = path.join(directory, `workspace-recovery-${missingBody}.json`)
      fs.copyFileSync(options.storagePath, recoveryStoragePath)
      const recoveryLedger = new RunLedger({
        storagePath: path.join(directory, `run-ledger-recovery-${missingBody}.json`),
        now: () => Date.now(),
      })
      recoveryLedger.checkpoint(crashRecord)
      const recoveryCalls = []
      const recovered = new LocalWorkspace({
        ...options,
        storagePath: recoveryStoragePath,
        runLedger: recoveryLedger,
        runAgent: async (agent) => {
          recoveryCalls.push(agent.kind)
          throw new Error('TEST_AGENT_MUST_NOT_RUN')
        },
      })
      await recovered.refreshAgents()
      const failed = await waitFor(() => {
        const record = recoveryLedger.get(crashRecord.runId)
        return record?.status === 'failed' ? record : null
      }, `failed closed ${missingBody}`)

      assert.deepEqual(recoveryCalls, [])
      assert.equal(failed.reason, missingBody === 'snapshot'
        ? 'LOCAL_RUN_SNAPSHOT_INVALID'
        : 'LOCAL_RUN_RESULT_BODY_INVALID')
      assert.equal(recovered.snapshot().messages.some(message => (
        message.groupId === group.id && message.role === 'agent'
      )), false)
      assert.deepEqual(failed.orchestration.commitState.committedKinds, [])
    })
  }
})

test('Manual V4 recovery rejects another task\'s valid snapshot blob before invocation', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger.json'),
    now: () => Date.now(),
  })
  const preparedRecords = []
  const checkpoint = ledger.checkpoint.bind(ledger)
  ledger.checkpoint = (record) => {
    const stored = checkpoint(record)
    if (stored.orchestration?.version === 4
        && stored.orchestration.slots.every(slot => slot.status === 'planned')) {
      preparedRecords.push(structuredClone(stored))
    }
    return stored
  }
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 2, workspaceLimit: 2, globalLimit: 2 })
  options.runAgent = async agent => ({
    text: `${agent.kind} cross-task proposal`,
    sessionRef: `${agent.kind}-session`,
    collaboration: proposalCollaboration(`${agent.kind} cross-task summary`),
  })
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Manual V4 semantic binding',
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
    allowWrite: false,
  })
  for (const text of ['Execute task A.', 'Execute task B.']) {
    await workspace.sendMessage({
      groupId: group.id,
      text,
      mode: 'manual',
      targetKinds: ['codex', 'hermes'],
      protocol: 'v4',
    })
  }
  assert.equal(preparedRecords.length, 2)
  const [taskA, taskB] = preparedRecords
  const substituted = structuredClone(taskA)
  substituted.orchestration.snapshot = {
    ...substituted.orchestration.snapshot,
    contentRef: taskB.orchestration.snapshot.contentRef,
    contentHash: taskB.orchestration.snapshot.contentHash,
    charCount: taskB.orchestration.snapshot.charCount,
    ...(taskB.orchestration.snapshot.bodyHash
      ? { bodyHash: taskB.orchestration.snapshot.bodyHash }
      : {}),
  }
  substituted.orchestration.snapshotHash = hashValue(substituted.orchestration.snapshot)
  substituted.orchestration.plan.snapshotHash = substituted.orchestration.snapshotHash
  substituted.orchestration.slots = substituted.orchestration.slots.map(slot => ({
    ...slot,
    snapshotHash: substituted.orchestration.snapshotHash,
  }))

  const recoveryStoragePath = path.join(directory, 'workspace-semantic-binding.json')
  fs.copyFileSync(options.storagePath, recoveryStoragePath)
  const recoveryLedger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger-semantic-binding.json'),
    now: () => Date.now(),
  })
  recoveryLedger.checkpoint(substituted)
  const recoveryCalls = []
  const recovered = new LocalWorkspace({
    ...options,
    storagePath: recoveryStoragePath,
    runLedger: recoveryLedger,
    runAgent: async (agent, prompt) => {
      recoveryCalls.push({ kind: agent.kind, prompt })
      throw new Error('TEST_AGENT_MUST_NOT_RUN')
    },
  })
  await recovered.refreshAgents()
  const failed = await waitFor(() => {
    const record = recoveryLedger.get(substituted.runId)
    return record?.status === 'failed' ? record : null
  }, 'cross-task snapshot rejection')

  assert.deepEqual(recoveryCalls, [])
  assert.equal(failed.reason, 'LOCAL_RUN_SNAPSHOT_INVALID')
})

test('Manual V4 recovery rejects a tampered multi-writer cursor before invocation', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger.json'),
    now: () => Date.now(),
  })
  const checkpoints = []
  const checkpoint = ledger.checkpoint.bind(ledger)
  ledger.checkpoint = (record) => {
    const stored = checkpoint(record)
    checkpoints.push(structuredClone(stored))
    return stored
  }
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 3, workspaceLimit: 3, globalLimit: 3 })
  options.runAgent = async agent => ({
    text: `${agent.kind} writer binding proposal`,
    sessionRef: `${agent.kind}-session`,
    collaboration: proposalCollaboration(`${agent.kind} writer binding summary`),
  })
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Manual V4 writer binding recovery',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: true,
  })
  await workspace.sendMessage({
    groupId: group.id,
    text: 'Recover only the declared writable Agent.',
    mode: 'manual',
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    protocol: 'v4',
  })
  const prepared = checkpoints.find(record => (
    record.orchestration?.version === 4
    && record.orchestration.slots.every(slot => slot.status === 'planned')
  ))
  assert.ok(prepared)

  const workspaceState = JSON.parse(fs.readFileSync(options.storagePath, 'utf8'))
  workspaceState.messages = workspaceState.messages.filter(message => message.role !== 'agent')
  const recoveryStoragePath = path.join(directory, 'workspace-writer-binding.json')
  fs.writeFileSync(recoveryStoragePath, `${JSON.stringify(workspaceState, null, 2)}\n`)
  const recoveryLedger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger-writer-binding.json'),
    now: () => Date.now(),
  })
  recoveryLedger.checkpoint(prepared)
  const recoveryCalls = []
  const recovered = new LocalWorkspace({
    ...options,
    storagePath: recoveryStoragePath,
    runLedger: recoveryLedger,
    runAgent: async (agent, _prompt, _workdir, runOptions) => {
      recoveryCalls.push({ kind: agent.kind, sandbox: runOptions.sandbox })
      return {
        text: `${agent.kind} tampered recovery proposal`,
        sessionRef: `${agent.kind}-recovery-session`,
        collaboration: proposalCollaboration(`${agent.kind} tampered recovery summary`),
      }
    },
  })
  const recovery = [...recovered.pendingV4ManualRecoveries.values()][0]
  assert.ok(recovery)
  recovery.controller.orchestration.commitState.writerKind = null
  recovery.controller.orchestration.slots = recovery.controller.orchestration.slots
    .map((slot, index) => ({
      ...slot,
      permission: index < 2 ? 'workspace-write' : 'read-only',
    }))
  recovery.controller.orchestration.plan.assignments = recovery.controller.orchestration
    .plan.assignments.map((assignment, index) => ({
      ...assignment,
      readOnly: index >= 2,
    }))

  await recovered.refreshAgents()
  const failed = await waitFor(() => {
    const record = recoveryLedger.get(prepared.runId)
    return record?.status === 'failed' ? record : null
  }, 'rejected multi-writer recovery')

  assert.deepEqual(recoveryCalls, [])
  assert.equal(failed.reason, 'ORCHESTRATION_V4_PERMISSION_INVALID')
})

test('Manual V4 startup recovery owns permanent terminal persistence failure', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger.json'),
    now: () => Date.now(),
  })
  options.runLedger = ledger
  options.runScheduler = new RunScheduler({ taskLimit: 2, workspaceLimit: 2, globalLimit: 2 })
  options.runAgent = async agent => ({
    text: `${agent.kind} terminal persistence proposal`,
    sessionRef: `${agent.kind}-session`,
    collaboration: proposalCollaboration(`${agent.kind} terminal persistence summary`),
  })
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Manual V4 terminal persistence recovery',
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
    allowWrite: false,
  })
  let crashRecord = null
  workspace.commitV4AgentMessage = () => {
    crashRecord = structuredClone(ledger.list(group.id)[0])
    throw new Error('TEST_CRASH:terminal-persistence')
  }
  await assert.rejects(workspace.sendMessage({
    groupId: group.id,
    text: 'Retain failed startup recovery for terminal persistence retry.',
    mode: 'manual',
    targetKinds: ['codex', 'hermes'],
    protocol: 'v4',
  }), /TEST_CRASH:terminal-persistence/)
  assert.ok(crashRecord)

  const snapshotRef = crashRecord.orchestration.snapshot.contentRef
  fs.unlinkSync(path.join(
    workspace.contentBlobStore.rootPath,
    'sha256',
    snapshotRef.hash.slice(0, 2),
    snapshotRef.hash,
  ))
  const recoveryStoragePath = path.join(directory, 'workspace-terminal-persistence.json')
  fs.copyFileSync(options.storagePath, recoveryStoragePath)
  const recoveryLedger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger-terminal-persistence.json'),
    now: () => Date.now(),
  })
  recoveryLedger.checkpoint(crashRecord)
  const recovered = new LocalWorkspace({
    ...options,
    storagePath: recoveryStoragePath,
    runLedger: recoveryLedger,
    terminalRetrySleep: () => Promise.resolve(),
    runAgent: async () => {
      throw new Error('TEST_AGENT_MUST_NOT_RUN')
    },
  })
  const controller = recovered.activeRuns.get(group.id)
  assert.ok(controller)
  recoveryLedger.checkpoint = () => {
    throw new Error('TEST_TERMINAL_PERSISTENCE_UNAVAILABLE')
  }
  const unhandled = []
  const onUnhandled = reason => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  t.after(() => process.removeListener('unhandledRejection', onUnhandled))

  await recovered.refreshAgents()
  await waitFor(() => controller.terminalPersistence?.state === 'failed', 'failed terminal outbox')
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(unhandled, [])
  assert.equal(recovered.activeRuns.get(group.id), controller)
  assert.equal(controller.finished, false)
  assert.equal(controller.terminalOutbox.status, 'failed')
  assert.deepEqual(controller.terminalPersistence, {
    state: 'failed',
    status: 'failed',
    attempts: 3,
    nextRetryAt: 0,
    code: 'LOCAL_RUN_PERSIST_FAILED',
  })
})

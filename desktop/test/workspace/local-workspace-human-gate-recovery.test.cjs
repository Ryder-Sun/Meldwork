const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  createCollaborationReceipt,
} = require('../../src/collaboration/orchestration-v4-records.cjs')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { RunLedger } = require('../../src/runs/run-ledger.cjs')
const { deferred, fixture } = require('../support/local-workspace-test-helpers.cjs')

function pendingGate(workspace, timeoutMs = 2000) {
  const current = workspace.listHumanGates({ pendingOnly: true })[0]
  if (current) return Promise.resolve(current)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      workspace.off('changed', changed)
      reject(new Error('TEST_HUMAN_GATE_TIMEOUT'))
    }, timeoutMs)
    const changed = () => {
      const gate = workspace.listHumanGates({ pendingOnly: true })[0]
      if (!gate) return
      clearTimeout(timer)
      workspace.off('changed', changed)
      resolve(gate)
    }
    workspace.on('changed', changed)
  })
}

function v4Proposal(agentKind) {
  return {
    version: 1,
    phase: 'proposal',
    summary: `${agentKind} proposal`,
    capabilities: [`${agentKind} capability`],
    intendedWork: [`${agentKind} work`],
    deliverables: [`${agentKind} Artifact`],
    dependencies: [],
  }
}

function v4Challenge(agentKind) {
  return {
    version: 1,
    phase: 'challenge',
    verdict: 'support',
    summary: `${agentKind} supports the negotiated plan`,
    proposedAssignments: [
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
    ],
    finalizerKind: 'workbuddy',
    verifierKinds: ['codex', 'hermes'],
    agreeToPlan: true,
  }
}

function v4Work(agentKind, prompt) {
  const workItemId = prompt.match(/^Work item: ([A-Za-z0-9._:-]+)$/m)?.[1] || ''
  return {
    version: 1,
    phase: 'work',
    summary: `${agentKind} completed ${workItemId}`,
    workItemId,
    deliverables: [`${agentKind} Artifact`],
  }
}

async function waitForRunStatus(ledger, runId, status, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const record = ledger.get(runId)
    if (record?.status === status) return record
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`TEST_RUN_STATUS_TIMEOUT:${runId}:${status}`)
}

async function waitForTerminalRun(ledger, runId, timeoutMs = 5000) {
  const terminal = new Set(['completed', 'partial', 'failed', 'stopped', 'timeout', 'round-limit'])
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const record = ledger.get(runId)
    if (terminal.has(record?.status)) return record
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`TEST_RUN_TERMINAL_TIMEOUT:${runId}`)
}

async function waitForTerminalOrFreshGate(workspace, ledger, runId, gateId, timeoutMs = 5000) {
  const terminal = new Set(['completed', 'partial', 'failed', 'stopped', 'timeout', 'round-limit'])
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const record = ledger.get(runId)
    if (terminal.has(record?.status)) return { terminal: record }
    const freshGate = workspace.listHumanGates({ runId, pendingOnly: true })
      .find(candidate => candidate.gateId !== gateId)
    if (freshGate) return { freshGate }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`TEST_RUN_OR_GATE_TIMEOUT:${runId}`)
}

async function stoppedBudgetGate(options, directory, text) {
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: text, agentKinds: ['codex'], workdir: directory,
  })
  const gatePromise = pendingGate(workspace)
  const send = workspace.sendMessage({
    groupId: group.id,
    text,
    targetKinds: ['codex'],
    budget: {
      limits: { costMicros: 100 },
      enforcement: { costMicros: 'hard' },
    },
  })
  const pending = await gatePromise
  await workspace.stopAll()
  await send
  return { workspace, pending }
}

function approveGate(store, gateId) {
  return store.decide(gateId, {
    status: 'approved',
    optionId: 'continue-unmetered',
    actorId: 'local-user',
    decidedAt: '2026-07-28T00:00:00.000Z',
  })
}

function removeContextPack(workspace, contextPackId) {
  const hash = contextPackId.slice(contextPackId.lastIndexOf('-') + 1)
  fs.rmSync(path.join(
    workspace.contextPackStore.rootPath,
    'context-packs',
    hash.slice(0, 2),
    `${contextPackId}.json`,
  ))
}

function decisionTaskGraph() {
  return {
    template: 'task-graph',
    nodes: [{
      nodeId: 'primary-codex', role: 'primary', agentKind: 'codex',
      dependsOn: [], inputNodeIds: [], expectedOutput: 'Produce a durable recommendation.',
      acceptance: { requireConclusion: true, minArtifactRefs: 1, minEvidenceRefs: 1 },
      terminal: false, parallel: false, decisionOptions: [],
    }, {
      nodeId: 'human-decision', role: 'human', agentKind: null,
      dependsOn: ['primary-codex'], inputNodeIds: ['primary-codex'],
      expectedOutput: 'Approve or reject the recommendation.',
      acceptance: { requireConclusion: false, minArtifactRefs: 0, minEvidenceRefs: 0 },
      terminal: true, parallel: false,
      decisionOptions: [
        { optionId: 'approve-graph', name: 'Approve recommendation', kind: 'allow_once' },
        { optionId: 'reject-graph', name: 'Reject recommendation', kind: 'reject_once' },
      ],
    }],
  }
}

test('task-graph Human decisions resume from the durable v3 cursor after restart', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  options.runLedger = new RunLedger({ storagePath: ledgerPath })
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Restart task graph', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Prepare a durable recommendation for approval.',
    mode: 'auto', maxRounds: 4, targetKinds: ['codex', 'hermes'],
    workflow: decisionTaskGraph(),
  })
  const pending = await pendingGate(workspace)
  await workspace.stopAll()

  const waiting = new RunLedger({ storagePath: ledgerPath }).get(pending.runId)
  assert.equal(waiting.status, 'waiting')
  assert.equal(waiting.orchestration.version, 3)
  assert.deepEqual(waiting.orchestration.taskGraph.nodeStates.map(state => state.status), [
    'accepted', 'waiting',
  ])

  const restartedLedger = new RunLedger({ storagePath: ledgerPath })
  const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
  await restarted.refreshAgents()
  restarted.decideHumanGate(pending.gateId, {
    status: 'approved', optionId: 'approve-graph', actorId: 'local-user',
  })
  const terminal = await waitForTerminalRun(restartedLedger, pending.runId)

  assert.equal(terminal.status, 'completed', terminal.reason)
  assert.equal(terminal.continuation.state, 'completed')
  assert.equal(terminal.orchestration.taskGraph.terminalState, 'accepted')
  assert.equal(
    terminal.orchestration.taskGraph.nodeStates[1].decisionOptionId,
    'approve-graph',
  )
  assert.equal(calls.length, 1)

  const secondRestart = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath }),
  })
  await secondRestart.refreshAgents()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.length, 1)
})

test('task graph automatic recovery excludes active nodes, unfinished Agent runs and human continuations', () => {
  const base = { mode: 'auto', status: 'running', groupId: 'group', targetKinds: ['codex'], agentRuns: [],
    orchestration: { version: 3, workflow: 'auto', template: 'task-graph',
      taskGraph: { currentNodeIds: [], nodeStates: [{ status: 'pending' }] } } }
  const recoverable = record => LocalWorkspace.prototype.recoverableTaskGraphRecords.call({
    state: { groups: [{ id: 'group' }], messages: [] }, runLedger: { list: () => [record] },
    completedTaskGraphResults: LocalWorkspace.prototype.completedTaskGraphResults,
  }).length === 1
  assert.equal(recoverable(base), true)
  assert.equal(recoverable({ ...base, continuation: { state: 'pending' } }), false)
  assert.equal(recoverable({ ...base, agentRuns: [{ status: 'running' }] }), false)
  assert.equal(recoverable({ ...base, agentRuns: [{ status: 'interrupted' }] }), false)
  assert.equal(recoverable({ ...base, attemptHistory: [{ finalOutcome: 'unknown' }] }), false)
  assert.equal(recoverable({ ...base, orchestration: { ...base.orchestration,
    taskGraph: { currentNodeIds: ['active'], nodeStates: [{ status: 'running' }] } } }), false)
  assert.equal(recoverable({ ...base, status: 'stopped' }), false)
})

test('task graph recovers a completed running node only with one exactly bound durable message', () => {
  const node = { nodeId: 'first', role: 'primary', agentKind: 'codex' }
  const record = { runId: 'run', groupId: 'group', threadRootId: 'root', currentRound: 1,
    agentRuns: [{ agentRunId: 'attempt', kind: 'codex', round: 1, status: 'completed', output: 'done', context: {} }],
    orchestration: { taskGraph: { currentNodeIds: ['first'], nodeStates: [{ nodeId: 'first', status: 'running' }], graph: { nodes: [node] } } } }
  const message = { groupId: 'group', threadRootId: 'root', role: 'agent', agentKind: 'codex', content: 'done',
    trace: { runId: 'run', agentRunId: 'attempt', status: 'completed' } }
  const find = messages => LocalWorkspace.prototype.completedTaskGraphResults.call({ state: { messages } }, record)
  assert.equal(find([message]).length, 1)
  assert.equal(find([]), null)
  assert.equal(find([message, message]), null)
  assert.equal(find([{ ...message, content: 'different' }]), null)
  assert.equal(find([{ ...message, trace: { ...message.trace, agentRunId: 'other' } }]), null)
})

test('task graph resumes a persisted node boundary after restart without repeating completed work', async t => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath })
  options.runLedger = ledger
  const calls = []
  const finalStarted = deferred()
  options.runAgent = async (agent, _prompt, _workdir, runOptions) => {
    calls.push(agent.kind)
    if (agent.kind === 'workbuddy' && calls.filter(kind => kind === 'workbuddy').length === 1) {
      finalStarted.resolve()
      await new Promise((_, reject) => {
        if (runOptions.signal.aborted) return reject(new Error('stopped'))
        runOptions.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
      })
    }
    return { text: 'Shared conclusion.', outcome: 'completed' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({ name: 'Boundary recovery', agentKinds: ['codex', 'workbuddy'],
    workdir: directory, allowWrite: false })
  let boundarySnapshot = ''
  let boundaryJournal = ''
  const capture = () => {
    const record = ledger.list(group.id)[0]
    const states = record?.orchestration?.taskGraph?.nodeStates
    if (!boundarySnapshot && states?.[0]?.status === 'accepted' && states?.[1]?.status === 'pending') {
      boundarySnapshot = fs.readFileSync(ledgerPath, 'utf8')
      boundaryJournal = fs.readFileSync(`${ledgerPath}.journal`, 'utf8')
    }
  }
  workspace.on('changed', capture)
  const acceptance = { requireConclusion: true, minArtifactRefs: 0, minEvidenceRefs: 0 }
  const node = (nodeId, agentKind, rest = {}) => ({ nodeId, role: 'primary', agentKind,
    dependsOn: [], inputNodeIds: [], expectedOutput: 'Produce a conclusion.', acceptance,
    terminal: false, parallel: false, decisionOptions: [], ...rest })
  await workspace.sendMessage({ groupId: group.id, text: 'Review together', mode: 'auto', maxRounds: 3,
    targetKinds: ['codex', 'workbuddy'], workflow: { template: 'task-graph', nodes: [
      node('first', 'codex'), node('final', 'workbuddy', { dependsOn: ['first'], inputNodeIds: ['first'], terminal: true }),
    ] } })
  await finalStarted.promise
  assert.ok(boundarySnapshot)
  const runId = ledger.list(group.id)[0].runId
  await workspace.stopAll()
  workspace.off('changed', capture)
  fs.writeFileSync(ledgerPath, boundarySnapshot)
  fs.writeFileSync(`${ledgerPath}.journal`, boundaryJournal)
  const restartedLedger = new RunLedger({ storagePath: ledgerPath })
  const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
  await restarted.refreshAgents()
  const terminal = await waitForTerminalRun(restartedLedger, runId)
  assert.equal(terminal.status, 'completed', terminal.reason)
  assert.equal(calls.filter(kind => kind === 'codex').length, 1)
  assert.equal(calls.filter(kind => kind === 'workbuddy').length, 2)
})

test('task graph restores a durable completed result before its node checkpoint', async t => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath })
  options.runLedger = ledger
  const calls = []
  const finalStarted = deferred()
  options.runAgent = async (agent, _prompt, _workdir, runOptions) => {
    calls.push(agent.kind)
    if (agent.kind === 'workbuddy' && calls.filter(kind => kind === 'workbuddy').length === 1) {
      finalStarted.resolve()
      await new Promise((_, reject) => runOptions.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }))
    }
    return { text: 'Shared conclusion.', outcome: 'completed' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({ name: 'Result recovery', agentKinds: ['codex', 'workbuddy'], workdir: directory, allowWrite: false })
  let snapshot
  const original = workspace.autoRunner.applyTaskGraphAgentResult.bind(workspace.autoRunner)
  workspace.autoRunner.applyTaskGraphAgentResult = (...args) => {
    if (!snapshot && args[2].nodeId === 'first') snapshot = {
      ledger: fs.readFileSync(ledgerPath, 'utf8'), journal: fs.readFileSync(`${ledgerPath}.journal`, 'utf8'),
    }
    return original(...args)
  }
  const acceptance = { requireConclusion: true, minArtifactRefs: 0, minEvidenceRefs: 0 }
  const node = (nodeId, agentKind, rest = {}) => ({ nodeId, role: 'primary', agentKind, dependsOn: [],
    inputNodeIds: [], expectedOutput: 'Produce a conclusion.', acceptance, terminal: false, parallel: false, decisionOptions: [], ...rest })
  await workspace.sendMessage({ groupId: group.id, text: 'Review together', mode: 'auto', maxRounds: 3,
    targetKinds: ['codex', 'workbuddy'], workflow: { template: 'task-graph', nodes: [
      node('first', 'codex'), node('final', 'workbuddy', { dependsOn: ['first'], inputNodeIds: ['first'], terminal: true }),
    ] } })
  await finalStarted.promise
  assert.ok(snapshot)
  const runId = ledger.list(group.id)[0].runId
  await workspace.stopAll()
  fs.writeFileSync(ledgerPath, snapshot.ledger)
  fs.writeFileSync(`${ledgerPath}.journal`, snapshot.journal)
  const restartedLedger = new RunLedger({ storagePath: ledgerPath })
  const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
  await restarted.refreshAgents()
  const terminal = await waitForTerminalRun(restartedLedger, runId)
  assert.equal(terminal.status, 'completed', terminal.reason)
  assert.equal(calls.filter(kind => kind === 'codex').length, 1)
  assert.equal(terminal.orchestration.taskGraph.nodeStates.every(state => state.status === 'accepted'), true)
})

test('parallel task graph preserves completed work and resumes the remaining gated node after restart', async t => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath })
  options.runLedger = ledger
  const calls = []
  options.runAgent = async (agent, _prompt, _workdir, runOptions) => {
    calls.push(agent.kind)
    if (agent.kind === 'kimi') {
      await runOptions.onSessionRef('parallel-kimi-session', { transport: 'acp' })
      await runOptions.onPermissionRequest({
        options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }],
        toolCall: { kind: 'read', title: 'Read source' },
      }, { signal: runOptions.signal })
    }
    return { text: 'Shared conclusion.', sessionRef: agent.kind === 'kimi' ? 'parallel-kimi-session' : '' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({ name: 'Parallel recovery', agentKinds: ['codex', 'kimi', 'workbuddy'],
    workdir: directory, allowWrite: false })
  const acceptance = { requireConclusion: true, minArtifactRefs: 0, minEvidenceRefs: 0 }
  const node = (nodeId, agentKind, rest = {}) => ({ nodeId, role: 'primary', agentKind,
    dependsOn: [], inputNodeIds: [], expectedOutput: 'Produce a conclusion.', acceptance,
    terminal: false, parallel: true, decisionOptions: [], ...rest })
  await workspace.sendMessage({ groupId: group.id, text: 'Review together', mode: 'auto', maxRounds: 3,
    targetKinds: ['codex', 'kimi', 'workbuddy'], workflow: { template: 'task-graph', nodes: [
      node('fast', 'codex'), node('gated', 'kimi'),
      node('final', 'workbuddy', { dependsOn: ['fast', 'gated'], inputNodeIds: ['fast', 'gated'], terminal: true, parallel: false }),
    ] } })
  const gate = await pendingGate(workspace)
  const deadline = Date.now() + 5000
  while (ledger.get(gate.runId)?.orchestration?.taskGraph?.nodeStates.find(state => state.nodeId === 'fast')?.status !== 'accepted') {
    if (Date.now() > deadline) throw new Error('TEST_CHECKPOINT_TIMEOUT')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  await workspace.stopAll()
  const restartedLedger = new RunLedger({ storagePath: ledgerPath })
  const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
  await restarted.refreshAgents()
  restarted.decideHumanGate(gate.gateId, { status: 'approved', optionId: 'allow-once', actorId: 'local-user' })
  const terminal = await waitForTerminalRun(restartedLedger, gate.runId)
  assert.equal(terminal.status, 'completed', terminal.reason)
  assert.equal(terminal.orchestration.taskGraph.nodeStates.every(state => state.status === 'accepted'), true)
  assert.equal(calls.filter(kind => kind === 'codex').length, 1)
  assert.equal(calls.filter(kind => kind === 'kimi').length, 2)
})

test('task-graph Agent slots resume into typed acceptance after a permission Gate restart', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  options.runLedger = new RunLedger({ storagePath: ledgerPath })
  let appliedDecisions = 0
  options.runAgent = async (agent, _prompt, _workdir, runOptions) => {
    calls.push({ agent, runOptions })
    await runOptions.onSessionRef('kimi-task-graph-session', { transport: 'acp' })
    const decision = await runOptions.onPermissionRequest({
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
      ],
      operation: { kind: 'write', path: 'typed-result.txt' },
    }, { signal: runOptions.signal })
    appliedDecisions += 1
    return {
      text: `Typed result after ${decision.optionId}`,
      sessionRef: 'kimi-task-graph-session',
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Restart task graph Agent',
    agentKinds: ['kimi', 'codex'],
    workdir: directory,
    allowWrite: true,
  })
  await workspace.sendMessage({
    groupId: group.id,
    text: 'Produce the typed result after permission.',
    mode: 'auto', maxRounds: 2, targetKinds: ['kimi', 'codex'],
    workflow: {
      template: 'task-graph',
      nodes: [{
        nodeId: 'primary-kimi', role: 'primary', agentKind: 'kimi',
        dependsOn: [], inputNodeIds: [], expectedOutput: 'Produce a durable typed result.',
        acceptance: { requireConclusion: true, minArtifactRefs: 1, minEvidenceRefs: 1 },
        terminal: true, parallel: false, decisionOptions: [],
      }],
    },
  })
  const pending = await pendingGate(workspace)
  await workspace.stopAll()

  const waiting = new RunLedger({ storagePath: ledgerPath }).get(pending.runId)
  assert.deepEqual(waiting.orchestration.taskGraph.currentNodeIds, ['primary-kimi'])
  assert.equal(waiting.orchestration.taskGraph.nodeStates[0].status, 'running')

  const restartedLedger = new RunLedger({ storagePath: ledgerPath })
  const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
  await restarted.refreshAgents()
  restarted.decideHumanGate(pending.gateId, {
    status: 'approved', optionId: 'allow-once', actorId: 'local-user',
  })
  const terminal = await waitForTerminalRun(restartedLedger, pending.runId)

  assert.equal(terminal.status, 'completed', terminal.reason)
  assert.equal(terminal.orchestration.taskGraph.nodeStates[0].status, 'accepted')
  assert.equal(terminal.orchestration.taskGraph.nodeStates[0].artifactIds.length, 1)
  assert.equal(terminal.orchestration.taskGraph.nodeStates[0].evidenceIds.length, 1)
  assert.equal(calls.length, 2)
  assert.equal(appliedDecisions, 1)
})

async function verifyAutomaticGateRecovery(t, gateIndex) {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath })
  const targetOrders = [
    ['kimi', 'codex', 'workbuddy'],
    ['codex', 'kimi', 'workbuddy'],
    ['codex', 'workbuddy', 'kimi'],
  ]
  const targetKinds = targetOrders[gateIndex]
  const maxRounds = gateIndex === 1 ? 2 : 1
  const invokedKinds = []
  const completedTurns = new Map()
  let appliedDecisions = 0
  options.runLedger = ledger
  options.runAgent = async (agent, _prompt, _workdir, runOptions) => {
    invokedKinds.push(agent.kind)
    if (agent.kind !== 'kimi') {
      const completed = (completedTurns.get(agent.kind) || 0) + 1
      completedTurns.set(agent.kind, completed)
      const consensus = maxRounds > 1 && completed === maxRounds
        ? '\n[[MELDWORK_CONSENSUS:agree]]'
        : ''
      return {
        text: `${agent.kind} completed its automatic slot${consensus}`,
        sessionRef: `${agent.kind}-auto`,
      }
    }
    if (appliedDecisions > 0) {
      const completed = (completedTurns.get(agent.kind) || 0) + 1
      completedTurns.set(agent.kind, completed)
      const consensus = maxRounds > 1 && completed === maxRounds
        ? '\n[[MELDWORK_CONSENSUS:agree]]'
        : ''
      return {
        text: `Kimi completed its later automatic slot${consensus}`,
        sessionRef: 'kimi-auto-gate-session',
      }
    }
    await runOptions.onSessionRef('kimi-auto-gate-session', { transport: 'acp' })
    const decision = await runOptions.onPermissionRequest({
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
      ],
      operation: { kind: 'write', path: `auto-slot-${gateIndex}.txt` },
    }, { signal: runOptions.signal })
    appliedDecisions += 1
    const completed = (completedTurns.get(agent.kind) || 0) + 1
    completedTurns.set(agent.kind, completed)
    const consensus = maxRounds > 1 && completed === maxRounds
      ? '\n[[MELDWORK_CONSENSUS:agree]]'
      : ''
    return {
      text: `Kimi resumed:${decision.optionId}${consensus}`,
      sessionRef: 'kimi-auto-gate-session',
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: `Automatic Gate recovery ${gateIndex}`,
    agentKinds: targetKinds,
    workdir: directory,
    allowWrite: true,
  })
  const gatePromise = pendingGate(workspace)
  await workspace.sendMessage({
    groupId: group.id,
    text: `Resume automatic slot ${gateIndex} after restart`,
    mode: 'auto',
    maxRounds,
    targetKinds,
  })
  const pending = await gatePromise
  await workspace.stopAll()

  const waiting = new RunLedger({ storagePath: ledgerPath }).get(pending.runId)
  assert.equal(waiting.currentRound, 1)
  const { collaboration, ...waitingCursor } = waiting.orchestration
  assert.deepEqual(waitingCursor, {
    version: 2,
    workflow: 'auto',
    currentKind: 'kimi',
    pendingKinds: targetKinds.slice(gateIndex + 1),
    activeKinds: targetKinds,
    successfulKinds: targetKinds.slice(0, gateIndex),
    agreementKinds: [],
    attachmentRecipients: [],
    totalSuccesses: 0,
    terminalFailureOccurred: false,
    executionSequence: gateIndex + 1,
  })
  assert.equal(collaboration.version, 1)
  assert.deepEqual(
    collaboration.handoffs.map(handoff => handoff.destination.agentKind),
    targetKinds.slice(0, gateIndex + 1),
  )
  assert.equal(collaboration.entries.every(entry => (
    targetKinds.slice(0, gateIndex).includes(entry.owner.agentKind)
      || entry.owner.type === 'harness'
  )), true)

  const restartedLedger = new RunLedger({ storagePath: ledgerPath })
  const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
  await restarted.refreshAgents()
  restarted.decideHumanGate(pending.gateId, {
    status: 'approved', optionId: 'allow-once', actorId: 'local-user',
  })
  const terminal = await waitForTerminalRun(restartedLedger, pending.runId)

  assert.deepEqual(
    { status: terminal.status, reason: terminal.reason },
    { status: maxRounds > 1 ? 'completed' : 'round-limit', reason: '' },
  )
  assert.deepEqual(invokedKinds, [
    ...targetKinds.slice(0, gateIndex + 1),
    'kimi',
    ...targetKinds.slice(gateIndex + 1),
    ...(maxRounds > 1 ? targetKinds : []),
  ])
  assert.equal(appliedDecisions, 1)
  assert.equal(terminal.continuation.state, 'completed')
  assert.deepEqual(terminal.orchestration.pendingKinds, [])
  assert.deepEqual(terminal.orchestration.successfulKinds.sort(), [...targetKinds].sort())
  assert.equal(terminal.orchestration.totalSuccesses, targetKinds.length * maxRounds)
  for (const kind of targetKinds.slice(0, gateIndex)) {
    assert.equal(restarted.snapshot().messages.filter(message => (
      message.role === 'agent' && message.agentKind === kind
    )).length, maxRounds)
  }
  const sequences = terminal.agentRuns.flatMap(run => run.events.map(event => event.seq))
  assert.deepEqual(sequences, [...sequences].sort((left, right) => left - right))
  assert.equal(new Set(sequences).size, sequences.length)

  const invocationCount = invokedKinds.length
  const secondRestart = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath }),
  })
  await secondRestart.refreshAgents()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(invokedKinds.length, invocationCount)
}

test('approved V4 Human Gate resumes the next coordinated round once after restart', async (t) => {
  const { directory, calls, options } = fixture()
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath })
  let workspace = null
  let restarted = null
  let restartedLedger = null
  let restartedMode = false
  let pendingRunId = ''
  const restartedPhaseRecords = []
  const restartedPhases = []
  t.after(async () => {
    try { await workspace?.stopAll() } catch {}
    try { await restarted?.stopAll() } catch {}
    fs.rmSync(directory, { recursive: true, force: true })
  })
  options.runLedger = ledger
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    if (restartedMode) restartedPhases.push(phase)
    if (restartedMode && ['synthesis', 'verification'].includes(phase)) {
      restartedPhaseRecords.push(restartedLedger.get(pendingRunId))
    }
    const synthesisText = restartedMode ? 'Revised stable candidate' : 'Stable candidate'
    const collaboration = phase === 'proposal'
      ? v4Proposal(agent.kind)
      : phase === 'challenge'
        ? v4Challenge(agent.kind)
        : phase === 'work'
          ? v4Work(agent.kind, prompt)
        : phase === 'synthesis'
          ? { version: 1, phase, summary: synthesisText, resolvedIssueIds: [] }
          : {
              version: 1,
              phase,
              verdict: 'contradict',
              summary: 'One issue remains',
            }
    return {
      text: phase === 'synthesis' ? synthesisText : `${agent.kind} ${phase}`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
      collaboration,
    }
  }
  workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Restart V4 stable Gate',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: false,
  })
  await workspace.sendMessage({
    groupId: group.id,
    text: 'Keep reviewing the stable unresolved candidate.',
    mode: 'auto',
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    unlimitedRounds: true,
    protocol: 'v4',
  })
  const pending = await pendingGate(workspace, 5000)
  pendingRunId = pending.runId
  await workspace.stopAll()

  const waiting = new RunLedger({ storagePath: ledgerPath }).get(pending.runId)
  assert.equal(waiting.status, 'waiting')
  assert.equal(waiting.currentRound, 3)
  assert.equal(waiting.orchestration.phase, 'human-gate')
  assert.equal(Object.hasOwn(waiting.orchestration, 'challengeBindings'), false)
  assert.equal(waiting.continuation.resumeKind, 'v4_human_gate')
  assert.equal(waiting.continuation.state, 'pending')
  assert.equal(waiting.continuation.stateEpoch, waiting.orchestration.convergence.stateEpoch)
  assert.equal(waiting.orchestration.convergence.consecutiveStableRounds, 2)
  assert.equal(waiting.orchestration.convergence.acknowledgedGateEpoch, 0)
  const acknowledgedConvergence = {
    ...waiting.orchestration.convergence,
    acknowledgedGateEpoch: waiting.orchestration.convergence.stateEpoch,
  }

  options.now = () => '2026-07-29T00:00:00.000Z'
  restartedLedger = new RunLedger({ storagePath: ledgerPath })
  restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
  await restarted.refreshAgents()
  restartedMode = true
  restarted.decideHumanGate(pending.gateId, {
    status: 'approved', optionId: 'continue-discussion', actorId: 'local-user',
  })

  const nextGate = await pendingGate(restarted, 5000)
  assert.notEqual(nextGate.gateId, pending.gateId)
  const nextWaiting = restartedLedger.get(pending.runId)
  assert.equal(nextWaiting.status, 'waiting')
  assert.equal(nextWaiting.orchestration.phase, 'human-gate')
  assert.equal(nextWaiting.currentRound, waiting.currentRound + 2)
  assert.equal(nextWaiting.orchestration.convergence.consecutiveStableRounds, 2)
  assert.equal(
    nextWaiting.orchestration.convergence.stateEpoch > acknowledgedConvergence.stateEpoch,
    true,
  )
  assert.equal(Object.hasOwn(nextWaiting.orchestration, 'challengeBindings'), false)
  assert.deepEqual(nextWaiting.orchestration.coordinationPlan, waiting.orchestration.coordinationPlan)
  assert.equal(restartedPhaseRecords.some(record => record?.orchestration?.phase === 'synthesis'), true)
  assert.equal(restartedPhaseRecords.some(record => record?.orchestration?.phase === 'verification'), true)
  assert.equal(restartedPhases.includes('challenge'), false)
  assert.equal(restartedPhaseRecords.every(record => (
    record?.orchestration?.round > waiting.currentRound
      && !Object.hasOwn(record.orchestration, 'challengeBindings')
      && record.orchestration.coordinationPlan.planHash
        === waiting.orchestration.coordinationPlan.planHash
  )), true)
  restarted.decideHumanGate(nextGate.gateId, {
    status: 'rejected', optionId: 'stop-discussion', actorId: 'local-user',
  })
  const terminal = await waitForTerminalRun(restartedLedger, pending.runId)
  assert.equal(terminal.status, 'stopped')
  assert.equal(terminal.continuation.state, 'cancelled')
})

test('V4 synthesis recovery reuses the failed writer Gate after a real ambiguous write crash', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  const persistedGateClock = '2026-07-28T01:00:00.000Z'
  const restartGateClock = '2026-07-28T02:00:00.000Z'
  const initialSynthesisCalls = []
  options.runLedger = ledger
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    if (phase === 'synthesis') {
      initialSynthesisCalls.push({ kind: agent.kind, operationId: runOptions.operationId })
      throw Object.assign(new Error('socket reset after write'), { code: 'ECONNRESET' })
    }
    return {
      text: `${agent.kind} ${phase}`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-${phase}`,
      collaboration: phase === 'proposal'
        ? v4Proposal(agent.kind)
        : phase === 'challenge'
          ? v4Challenge(agent.kind)
          : v4Work(agent.kind, prompt),
    }
  }
  const workspace = new LocalWorkspace({ ...options, now: () => persistedGateClock })
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Restart real ambiguous V4 synthesis writer',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: true,
  })
  let resolvePersistedGateCrash
  const persistedGateCrash = new Promise(resolve => { resolvePersistedGateCrash = resolve })
  const markHumanGateWaiting = workspace.markHumanGateWaiting.bind(workspace)
  workspace.markHumanGateWaiting = (record, continuation) => {
    if (continuation?.resumeKind === 'v4_synthesis_recovery') {
      resolvePersistedGateCrash({
        gate: structuredClone(workspace.humanGateStore.get(record.gateId)),
        run: structuredClone(ledger.get(record.runId)),
      })
      throw new Error('TEST_CRASH:V4_SYNTHESIS_GATE_PERSISTED_AFTER_AMBIGUOUS_WRITE')
    }
    return markHumanGateWaiting(record, continuation)
  }

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Recover one real ambiguous workspace-write synthesis failure without duplicating Gates.',
    mode: 'auto',
    maxRounds: 2,
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    protocol: 'v4',
  })
  let persistedGateTimeout
  const persisted = await Promise.race([
    persistedGateCrash,
    new Promise((resolve, reject) => {
      persistedGateTimeout = setTimeout(
        () => reject(new Error('TEST_REAL_AMBIGUOUS_SYNTHESIS_GATE_WAS_NOT_PERSISTED')),
        5000,
      )
    }),
  ]).finally(() => clearTimeout(persistedGateTimeout))
  const binding = persisted.run.orchestration.synthesisRecovery.pendingGate
  const writerSlot = persisted.run.orchestration.slots.find(slot => (
    slot.slotId === binding.slotId
  ))

  assert.equal(initialSynthesisCalls.length, 1)
  assert.equal(initialSynthesisCalls[0].operationId, binding.operationId)
  assert.equal(persisted.gate.status, 'pending')
  assert.equal(persisted.run.continuation, undefined)
  assert.equal(persisted.run.orchestration.phase, 'human-gate')
  assert.equal(writerSlot.agentKind, binding.writerKind)
  assert.equal(writerSlot.operationId, binding.operationId)
  assert.equal(writerSlot.permission, 'workspace-write')
  assert.equal(writerSlot.status, 'failed')
  assert.equal(
    persisted.run.orchestration.synthesisRecovery.attempts.at(-1).status,
    'unknown_outcome',
  )
  assert.deepEqual(
    workspace.listHumanGates({ runId: persisted.run.runId }).map(item => item.gateId),
    [persisted.gate.gateId],
  )

  const recoveryLedgerPath = path.join(directory, 'run-ledger-real-ambiguous-recovery.json')
  const recoveryLedger = new RunLedger({ storagePath: recoveryLedgerPath })
  recoveryLedger.checkpoint(persisted.run)
  const restartedCalls = []
  assert.notEqual(persistedGateClock, restartGateClock)
  const restarted = new LocalWorkspace({
    ...options,
    runLedger: recoveryLedger,
    now: () => restartGateClock,
    runAgent: async (agent) => {
      restartedCalls.push(agent.kind)
      throw new Error('TEST_AGENT_MUST_NOT_RUN_BEFORE_REAL_SYNTHESIS_RECOVERY_GATE')
    },
  })
  await restarted.refreshAgents()
  const waiting = await waitForRunStatus(recoveryLedger, persisted.run.runId, 'waiting')
  const gates = restarted.listHumanGates({ runId: persisted.run.runId })

  assert.deepEqual(restartedCalls, [])
  assert.equal(gates.length, 1)
  assert.equal(gates[0].status, 'pending')
  assert.equal(gates[0].gateId, persisted.gate.gateId)
  assert.equal(waiting.continuation.gateId, persisted.gate.gateId)
  assert.equal(waiting.continuation.resumeKind, 'v4_synthesis_recovery')

  const secondRestart = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: recoveryLedgerPath }),
    now: () => '2026-07-28T03:00:00.000Z',
    runAgent: async (agent) => {
      restartedCalls.push(agent.kind)
      throw new Error('TEST_AGENT_MUST_NOT_RUN_WHILE_REAL_SYNTHESIS_GATE_IS_PENDING')
    },
  })
  await secondRestart.refreshAgents()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(restartedCalls, [])
  assert.deepEqual(
    secondRestart.listHumanGates({ runId: persisted.run.runId }).map(item => item.gateId),
    [persisted.gate.gateId],
  )
  assert.equal(
    secondRestart.runLedger.get(persisted.run.runId).continuation.gateId,
    persisted.gate.gateId,
  )

  restarted.decideHumanGate(persisted.gate.gateId, {
    status: 'rejected', optionId: 'stop-discussion', actorId: 'local-user',
  })
  await waitForTerminalRun(recoveryLedger, persisted.run.runId)
})

test('V4 synthesis recovery reuses one durable Gate after its continuation checkpoint crashes', async (t) => {
  const { directory, options } = fixture()
  let workspace = null
  let restarted = null
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  const synthesisCalls = []
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    if (phase === 'synthesis') synthesisCalls.push(agent.kind)
    return {
      text: `${agent.kind} ${phase}`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-${phase}`,
      collaboration: phase === 'proposal'
        ? v4Proposal(agent.kind)
        : phase === 'challenge'
          ? v4Challenge(agent.kind)
          : phase === 'work'
            ? v4Work(agent.kind, prompt)
            : phase === 'synthesis'
              ? { version: 1, phase, summary: `${agent.kind} candidate`, resolvedIssueIds: [] }
              : { version: 1, phase, verdict: 'support', summary: `${agent.kind} review` },
    }
  }
  workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Restart leased V4 synthesis writer',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: true,
  })
  let crashRecord = null
  let resolveLeasedCrash
  const leasedCrash = new Promise(resolve => { resolveLeasedCrash = resolve })
  const checkpointRun = workspace.checkpointRun.bind(workspace)
  workspace.checkpointRun = (groupId, controller, status = '') => {
    const persisted = checkpointRun(groupId, controller, status)
    const attempt = controller.orchestration?.synthesisRecovery?.attempts?.at(-1)
    if (!crashRecord && controller.orchestration?.phase === 'synthesis'
        && attempt?.status === 'leased' && attempt.permission === 'workspace-write') {
      crashRecord = structuredClone(ledger.get(controller.runId))
      resolveLeasedCrash()
      throw new Error('TEST_CRASH:V4_SYNTHESIS_LEASED')
    }
    return persisted
  }

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Gate a leased synthesis attempt after restart before invoking any Agent.',
    mode: 'auto',
    maxRounds: 2,
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    protocol: 'v4',
  })
  await leasedCrash
  assert.ok(crashRecord)
  assert.deepEqual(synthesisCalls, [])
  const leased = crashRecord.orchestration.synthesisRecovery.attempts.at(-1)
  assert.equal(leased.status, 'leased')
  assert.equal(leased.permission, 'workspace-write')
  assert.equal(leased.leaseAcquired, true)
  assert.equal(Object.hasOwn(crashRecord.orchestration.synthesisRecovery, 'pendingGate'), false)

  const unrelatedContentRef = workspace.contentBlobStore.put(
    'Unrelated durable output placed in another slot.',
    { mediaType: 'text/plain' },
  )
  const unrelatedArtifact = workspace.outcomeStore.putArtifact({
    type: 'document',
    name: 'foreign-synthesis.txt',
    producedBy: {
      runId: crashRecord.runId,
      agentRunId: 'agent-run-unrelated-synthesis',
      agentKind: leased.writerKind,
    },
    contentRef: unrelatedContentRef,
    contentHash: unrelatedContentRef.hash,
  })
  const unrelatedEvidence = workspace.outcomeStore.putEvidence({
    kind: 'observation',
    level: 'observed',
    subject: { type: 'artifact', artifactId: unrelatedArtifact.artifactId },
    summary: 'Meldwork captured the unrelated durable output.',
    recordedBy: { kind: 'system', actorId: 'meldwork-main' },
    refs: [
      { type: 'artifact', artifactId: unrelatedArtifact.artifactId },
      {
        type: 'blob',
        contentRef: unrelatedContentRef,
        contentHash: unrelatedContentRef.hash,
      },
    ],
  })
  const foreignSlotReceipt = createCollaborationReceipt({
    phase: 'synthesis',
    agentKind: leased.writerKind,
    slotId: leased.slotId,
    operationId: leased.operationId,
    status: 'completed',
    summary: 'Foreign slot claims the leased synthesis result completed.',
    artifactIds: [unrelatedArtifact.artifactId],
    evidenceIds: [unrelatedEvidence.evidenceId],
    snapshotHash: crashRecord.orchestration.snapshotHash,
    deliveryWatermark: 1,
  })
  const foreignSlot = crashRecord.orchestration.slots.find(slot => (
    slot.slotId !== leased.slotId
  ))
  assert.ok(foreignSlot)
  foreignSlot.resultRefs.artifactIds.push(unrelatedArtifact.artifactId)
  foreignSlot.resultRefs.evidenceIds.push(unrelatedEvidence.evidenceId)
  foreignSlot.resultRefs.workflowOutcomeRefs.push({ receipt: foreignSlotReceipt })

  const recoveryStoragePath = path.join(directory, 'workspace-recovery.json')
  fs.copyFileSync(options.storagePath, recoveryStoragePath)
  const recoveryLedger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger-recovery.json'),
  })
  recoveryLedger.checkpoint(crashRecord)
  await workspace.stopAll()
  const restartedCalls = []
  const gateCheckpointReached = new Promise((resolve) => {
    const gateCheckpointWorkspace = new LocalWorkspace({
      ...options,
      storagePath: recoveryStoragePath,
      runLedger: recoveryLedger,
      runAgent: async (agent) => {
        restartedCalls.push(agent.kind)
        throw new Error('TEST_AGENT_MUST_NOT_RUN_BEFORE_SYNTHESIS_RECOVERY_GATE')
      },
    })
    const checkpointRun = gateCheckpointWorkspace.checkpointRun.bind(gateCheckpointWorkspace)
    gateCheckpointWorkspace.checkpointRun = (groupId, controller, status = '') => {
      const persisted = checkpointRun(groupId, controller, status)
      if (controller.orchestration?.phase === 'human-gate'
          && controller.orchestration.synthesisRecovery?.pendingGate
          && !controller.continuation) {
        resolve(structuredClone(recoveryLedger.get(controller.runId)))
        throw new Error('TEST_CRASH:V4_SYNTHESIS_GATE_CHECKPOINTED')
      }
      return persisted
    }
    gateCheckpointWorkspace.refreshAgents()
  })
  let gateCheckpointTimeout
  const gateCheckpointRecord = await Promise.race([
    gateCheckpointReached,
    new Promise((resolve, reject) => {
      gateCheckpointTimeout = setTimeout(
        () => reject(new Error('TEST_SYNTHESIS_HISTORY_DID_NOT_OPEN_RECOVERY_GATE')),
        2000,
      )
    }),
  ]).finally(() => clearTimeout(gateCheckpointTimeout))

  assert.deepEqual(restartedCalls, [])
  assert.equal(gateCheckpointRecord.status, 'running')
  assert.equal(gateCheckpointRecord.orchestration.phase, 'human-gate')
  assert.equal(gateCheckpointRecord.continuation, undefined)
  assert.equal(gateCheckpointRecord.orchestration.synthesisRecovery.attempts.length, 1)
  assert.equal(
    gateCheckpointRecord.orchestration.synthesisRecovery.attempts[0].status,
    'unknown_outcome',
  )

  const postGateCrashLedgerPath = path.join(directory, 'run-ledger-post-gate-crash.json')
  const postGateCrashLedger = new RunLedger({ storagePath: postGateCrashLedgerPath })
  postGateCrashLedger.checkpoint(gateCheckpointRecord)
  const persistedGateClock = '2026-07-28T01:00:00.000Z'
  const restartGateClock = '2026-07-28T02:00:00.000Z'
  let resolvePersistedGateCrash
  const persistedGateCrash = new Promise(resolve => { resolvePersistedGateCrash = resolve })
  restarted = new LocalWorkspace({
    ...options,
    storagePath: recoveryStoragePath,
    runLedger: postGateCrashLedger,
    now: () => persistedGateClock,
    runAgent: async (agent) => {
      restartedCalls.push(agent.kind)
      throw new Error('TEST_AGENT_MUST_NOT_RUN_BEFORE_SYNTHESIS_RECOVERY_GATE')
    },
  })
  const markHumanGateWaiting = restarted.markHumanGateWaiting.bind(restarted)
  restarted.markHumanGateWaiting = (record, continuation) => {
    if (continuation?.resumeKind === 'v4_synthesis_recovery') {
      resolvePersistedGateCrash({
        gate: structuredClone(restarted.humanGateStore.get(record.gateId)),
        run: structuredClone(postGateCrashLedger.get(record.runId)),
      })
      throw new Error('TEST_CRASH:V4_SYNTHESIS_GATE_PERSISTED')
    }
    return markHumanGateWaiting(record, continuation)
  }
  await restarted.refreshAgents()
  let persistedGateTimeout
  const persisted = await Promise.race([
    persistedGateCrash,
    new Promise((resolve, reject) => {
      persistedGateTimeout = setTimeout(
        () => reject(new Error('TEST_SYNTHESIS_GATE_WAS_NOT_PERSISTED_BEFORE_CRASH')),
        2000,
      )
    }),
  ]).finally(() => clearTimeout(persistedGateTimeout))

  assert.deepEqual(restartedCalls, [])
  assert.equal(persisted.gate.status, 'pending')
  assert.equal(persisted.run.continuation, undefined)
  assert.deepEqual(
    restarted.listHumanGates({ runId: crashRecord.runId }).map(item => item.gateId),
    [persisted.gate.gateId],
  )

  const postPersistenceLedgerPath = path.join(
    directory, 'run-ledger-post-gate-persistence-crash.json',
  )
  const postPersistenceLedger = new RunLedger({ storagePath: postPersistenceLedgerPath })
  postPersistenceLedger.checkpoint(persisted.run)
  assert.notEqual(persistedGateClock, restartGateClock)
  const recovered = new LocalWorkspace({
    ...options,
    storagePath: recoveryStoragePath,
    runLedger: postPersistenceLedger,
    now: () => restartGateClock,
    runAgent: async (agent) => {
      restartedCalls.push(agent.kind)
      throw new Error('TEST_AGENT_MUST_NOT_RUN_BEFORE_SYNTHESIS_RECOVERY_GATE')
    },
  })
  await recovered.refreshAgents()
  const waiting = await waitForRunStatus(postPersistenceLedger, crashRecord.runId, 'waiting')
  const gates = recovered.listHumanGates({ runId: crashRecord.runId })

  assert.deepEqual(restartedCalls, [])
  assert.equal(gates.length, 1)
  const gate = gates[0]
  assert.equal(gate.status, 'pending')
  assert.equal(gate.gateId, persisted.gate.gateId)
  assert.equal(waiting.continuation.gateId, gate.gateId)
  assert.equal(waiting.continuation.resumeKind, 'v4_synthesis_recovery')
  assert.equal(waiting.continuation.agentRunId, leased.operationId)
  assert.equal(waiting.orchestration.synthesisRecovery.attempts.length, 1)
  assert.equal(waiting.orchestration.synthesisRecovery.attempts[0].status, 'unknown_outcome')
  assert.equal(waiting.orchestration.synthesisRecovery.pendingGate.operationId, leased.operationId)
  assert.equal(gate.agentRunId, leased.operationId)
  const secondRestart = new LocalWorkspace({
    ...options,
    storagePath: recoveryStoragePath,
    runLedger: new RunLedger({ storagePath: postPersistenceLedgerPath }),
    now: () => '2026-07-28T03:00:00.000Z',
    runAgent: async (agent) => {
      restartedCalls.push(agent.kind)
      throw new Error('TEST_AGENT_MUST_NOT_RUN_WHILE_SYNTHESIS_RECOVERY_GATE_IS_PENDING')
    },
  })
  await secondRestart.refreshAgents()
  await new Promise(resolve => setImmediate(resolve))
  const replayed = secondRestart.runLedger.get(crashRecord.runId)
  assert.deepEqual(restartedCalls, [])
  assert.deepEqual(
    secondRestart.listHumanGates({ runId: crashRecord.runId }).map(item => item.gateId),
    [gate.gateId],
  )
  assert.equal(replayed.continuation.gateId, gate.gateId)
  assert.equal(replayed.orchestration.synthesisRecovery.attempts.length, 1)
  assert.equal(replayed.orchestration.synthesisRecovery.pendingGate.bindingHash,
    waiting.orchestration.synthesisRecovery.pendingGate.bindingHash)
  recovered.decideHumanGate(gate.gateId, {
    status: 'rejected', optionId: 'stop-discussion', actorId: 'local-user',
  })
  await waitForTerminalRun(postPersistenceLedger, crashRecord.runId)
})

test('V4 synthesis recovery replaces the unknown writer once after restart', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  options.runLedger = new RunLedger({ storagePath: ledgerPath })
  const synthesisCalls = []
  const phaseCalls = []
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    phaseCalls.push({ kind: agent.kind, phase, sandbox: runOptions.sandbox })
    if (phase === 'synthesis') {
      synthesisCalls.push({
        kind: agent.kind,
        operationId: runOptions.operationId,
        sandbox: runOptions.sandbox,
      })
      if (synthesisCalls.length === 1) {
        throw Object.assign(new Error('socket reset after write'), { code: 'ECONNRESET' })
      }
    }
    return {
      text: `${agent.kind} ${phase}`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-${phase}`,
      collaboration: phase === 'proposal'
        ? v4Proposal(agent.kind)
        : phase === 'challenge'
          ? v4Challenge(agent.kind)
          : phase === 'work'
            ? v4Work(agent.kind, prompt)
          : phase === 'synthesis'
          ? { version: 1, phase, summary: `${agent.kind} candidate`, resolvedIssueIds: [] }
          : { version: 1, phase, verdict: 'support', summary: `${agent.kind} review` },
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Restart V4 synthesis recovery',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: true,
  })
  const gatePromise = pendingGate(workspace, 5000)
  await workspace.sendMessage({
    groupId: group.id,
    text: 'Replace an uncertain synthesis writer only after restart approval.',
    mode: 'auto',
    maxRounds: 2,
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    protocol: 'v4',
  })
  const pending = await gatePromise
  await workspace.stopAll()

  const waiting = new RunLedger({ storagePath: ledgerPath }).get(pending.runId)
  assert.equal(waiting.status, 'waiting')
  assert.equal(waiting.continuation.resumeKind, 'v4_synthesis_recovery')
  assert.equal(waiting.orchestration.synthesisRecovery.attempts.at(-1).status, 'unknown_outcome')
  assert.equal(
    waiting.orchestration.synthesisRecovery.pendingGate.proposedReplacementKind,
    'codex',
  )

  const restartedLedger = new RunLedger({ storagePath: ledgerPath })
  const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
  await restarted.refreshAgents()
  let replacementCheckpoint = null
  let replacementLeaseCheckpoint = null
  const checkpointRun = restarted.checkpointRun.bind(restarted)
  restarted.checkpointRun = (groupId, controller, status = '') => {
    const persisted = checkpointRun(groupId, controller, status)
    const recovery = controller.orchestration?.synthesisRecovery
    const selectedSlot = controller.orchestration?.slots?.find(slot => (
      slot.agentKind === recovery?.activeWriterKind
    ))
    if (!replacementCheckpoint && controller.orchestration?.phase === 'synthesis'
        && recovery?.activeWriterKind === waiting.orchestration.synthesisRecovery
          .pendingGate.proposedReplacementKind
        && recovery.attempts.at(-1)?.status === 'intent'
        && selectedSlot?.status === 'planned') {
      replacementCheckpoint = structuredClone(restartedLedger.get(controller.runId))
    }
    if (!replacementLeaseCheckpoint && controller.orchestration?.phase === 'synthesis'
        && recovery?.activeWriterKind === waiting.orchestration.synthesisRecovery
          .pendingGate.proposedReplacementKind
        && recovery.attempts.at(-1)?.status === 'leased'
        && selectedSlot?.status === 'running') {
      replacementLeaseCheckpoint = structuredClone(restartedLedger.get(controller.runId))
    }
    return persisted
  }
  restarted.decideHumanGate(pending.gateId, {
    status: 'approved', optionId: 'replace-next-writer', actorId: 'local-user',
  })
  const terminal = await waitForTerminalRun(restartedLedger, pending.runId)

  assert.equal(terminal.status, 'completed')
  assert.equal(terminal.continuation.state, 'completed')
  assert.equal(synthesisCalls.length, 2)
  assert.notEqual(synthesisCalls[0].kind, synthesisCalls[1].kind)
  assert.notEqual(synthesisCalls[0].operationId, synthesisCalls[1].operationId)
  const replacementRecovery = terminal.orchestration.synthesisRecovery
  const effectiveWriterKind = synthesisCalls[1].kind
  assert.equal(replacementRecovery.activeWriterKind, effectiveWriterKind)
  assert.equal(replacementRecovery.verificationKinds.includes(effectiveWriterKind), false)
  assert.equal(replacementRecovery.verificationKinds.length >= 1, true)
  assert.deepEqual(
    terminal.orchestration.coordinationPlan,
    waiting.orchestration.coordinationPlan,
  )
  assert.equal(
    terminal.orchestration.coordinationPlan.planHash,
    waiting.orchestration.coordinationPlan.planHash,
  )
  assert.equal(Object.hasOwn(terminal.orchestration, 'synthesisBinding'), false)
  assert.equal(terminal.orchestration.coordinationPlan.finalizerKind, 'workbuddy')
  assert.deepEqual(synthesisCalls.map(call => call.kind), ['workbuddy', effectiveWriterKind])
  assert.equal(synthesisCalls[1].sandbox, 'workspace-write')
  assert.ok(replacementCheckpoint)
  const plannedReplacementSlot = replacementCheckpoint.orchestration.slots.find(slot => (
    slot.agentKind === effectiveWriterKind
  ))
  assert.equal(Object.hasOwn(plannedReplacementSlot, 'agentRunId'), false)
  assert.equal(
    plannedReplacementSlot.operationId,
    replacementCheckpoint.orchestration.synthesisRecovery.attempts.at(-1).operationId,
  )
  assert.deepEqual(
    replacementCheckpoint.orchestration.slots
      .filter(slot => slot.permission === 'workspace-write')
      .map(slot => slot.agentKind),
    [effectiveWriterKind],
  )
  assert.ok(replacementLeaseCheckpoint)
  const leasedReplacementSlot = replacementLeaseCheckpoint.orchestration.slots.find(slot => (
    slot.agentKind === effectiveWriterKind
  ))
  const leasedReplacementAttempt = replacementLeaseCheckpoint.agentRuns.find(attempt => (
    attempt.agentRunId === leasedReplacementSlot.agentRunId
  ))
  assert.ok(leasedReplacementAttempt)
  assert.equal(leasedReplacementAttempt.kind, effectiveWriterKind)
  assert.notEqual(
    leasedReplacementSlot.agentRunId,
    waiting.continuation.publicAgentRunId,
  )
  assert.equal(phaseCalls
    .filter(call => call.phase === 'verification')
    .every(call => call.sandbox === 'read-only'), true)
  assert.equal(terminal.orchestration.slots
    .every(slot => slot.permission === 'read-only'), true)
  assert.equal(terminal.orchestration.commitState.writerKind, effectiveWriterKind)
  const finalEntry = terminal.orchestration.collaboration.entries.at(-1)
  const assignment = terminal.orchestration.coordinationPlan.assignments.find(candidate => (
    candidate.ownerKind === effectiveWriterKind
  ))
  assert.deepEqual(finalEntry.owner, {
    type: 'agent', agentKind: effectiveWriterKind, role: assignment.role,
  })
  assert.deepEqual(
    terminal.orchestration.synthesisRecovery.attempts.map(attempt => attempt.status),
    ['superseded', 'completed'],
  )

  const secondRestart = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath }),
  })
  await secondRestart.refreshAgents()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(synthesisCalls.length, 2)
})

test('V4 synthesis recovery retries the original writer once after restart', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  options.runLedger = new RunLedger({ storagePath: ledgerPath })
  const synthesisCalls = []
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    if (phase === 'synthesis') {
      synthesisCalls.push({ kind: agent.kind, operationId: runOptions.operationId })
      if (synthesisCalls.length === 1) {
        throw Object.assign(new Error('socket reset after write'), { code: 'ECONNRESET' })
      }
    }
    return {
      text: `${agent.kind} ${phase}`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-${phase}`,
      collaboration: phase === 'proposal'
        ? v4Proposal(agent.kind)
        : phase === 'challenge'
          ? v4Challenge(agent.kind)
          : phase === 'work'
            ? v4Work(agent.kind, prompt)
          : phase === 'synthesis'
          ? { version: 1, phase, summary: `${agent.kind} candidate`, resolvedIssueIds: [] }
          : { version: 1, phase, verdict: 'support', summary: `${agent.kind} review` },
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Restart original V4 synthesis writer',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: true,
  })
  const gatePromise = pendingGate(workspace, 5000)
  await workspace.sendMessage({
    groupId: group.id,
    text: 'Retry the uncertain writer only after restart approval.',
    mode: 'auto',
    maxRounds: 2,
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    protocol: 'v4',
  })
  const pending = await gatePromise
  await workspace.stopAll()

  const restartedLedger = new RunLedger({ storagePath: ledgerPath })
  const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
  await restarted.refreshAgents()
  let resolveApprovalCrash
  const approvalCrash = new Promise(resolve => { resolveApprovalCrash = resolve })
  const checkpointRun = restarted.checkpointRun.bind(restarted)
  restarted.checkpointRun = (groupId, controller, status = '') => {
    const persisted = checkpointRun(groupId, controller, status)
    const recovery = controller.orchestration?.synthesisRecovery
    const selectedSlot = controller.orchestration?.slots?.find(slot => (
      slot.agentKind === recovery?.activeWriterKind
    ))
    if (controller.orchestration?.phase === 'synthesis'
        && recovery?.attempts.at(-1)?.status === 'intent'
        && selectedSlot?.status === 'planned') {
      resolveApprovalCrash(structuredClone(restartedLedger.get(controller.runId)))
      throw new Error('TEST_CRASH:V4_SYNTHESIS_APPROVAL_CHECKPOINTED')
    }
    return persisted
  }
  restarted.decideHumanGate(pending.gateId, {
    status: 'approved', optionId: 'retry-original-writer', actorId: 'local-user',
  })
  const approvalCrashRecord = await approvalCrash

  assert.equal(approvalCrashRecord.orchestration.phase, 'synthesis')
  assert.equal(approvalCrashRecord.continuation.state, 'completed')
  assert.deepEqual(
    approvalCrashRecord.orchestration.synthesisRecovery.attempts.map(attempt => attempt.status),
    ['superseded', 'intent'],
  )
  assert.equal(new Set(
    approvalCrashRecord.orchestration.synthesisRecovery.attempts.map(attempt => attempt.operationId),
  ).size, 2)
  const plannedRetrySlot = approvalCrashRecord.orchestration.slots.find(slot => (
    slot.agentKind === approvalCrashRecord.orchestration.synthesisRecovery.activeWriterKind
  ))
  assert.equal(Object.hasOwn(plannedRetrySlot, 'agentRunId'), false)
  assert.equal(
    plannedRetrySlot.operationId,
    approvalCrashRecord.orchestration.synthesisRecovery.attempts.at(-1).operationId,
  )

  const postApprovalCrashPath = path.join(directory, 'run-ledger-post-approval-crash.json')
  const postApprovalCrashLedger = new RunLedger({ storagePath: postApprovalCrashPath })
  postApprovalCrashLedger.checkpoint(approvalCrashRecord)
  const secondRestart = new LocalWorkspace({ ...options, runLedger: postApprovalCrashLedger })
  let retryLeaseCheckpoint = null
  const secondCheckpointRun = secondRestart.checkpointRun.bind(secondRestart)
  secondRestart.checkpointRun = (groupId, controller, status = '') => {
    const persisted = secondCheckpointRun(groupId, controller, status)
    const recovery = controller.orchestration?.synthesisRecovery
    const selectedSlot = controller.orchestration?.slots?.find(slot => (
      slot.agentKind === recovery?.activeWriterKind
    ))
    if (!retryLeaseCheckpoint && controller.orchestration?.phase === 'synthesis'
        && recovery?.attempts.at(-1)?.status === 'leased'
        && selectedSlot?.status === 'running') {
      retryLeaseCheckpoint = structuredClone(postApprovalCrashLedger.get(controller.runId))
    }
    return persisted
  }
  await secondRestart.refreshAgents()
  const terminal = await waitForTerminalRun(postApprovalCrashLedger, pending.runId)

  assert.equal(terminal.status, 'completed', terminal.reason)
  assert.equal(terminal.continuation.state, 'completed')
  assert.equal(synthesisCalls.length, 2)
  assert.equal(synthesisCalls[0].kind, synthesisCalls[1].kind)
  assert.notEqual(synthesisCalls[0].operationId, synthesisCalls[1].operationId)
  assert.deepEqual(
    terminal.orchestration.synthesisRecovery.attempts.map(attempt => attempt.status),
    ['superseded', 'completed'],
  )
  assert.equal(
    terminal.orchestration.synthesisRecovery.attempts[0].outcomeCertainty,
    'unknown_outcome',
  )
  assert.equal(terminal.orchestration.synthesisRecovery.attempts[1].permission, 'workspace-write')
  assert.equal(terminal.orchestration.synthesisRecovery.attempts[1].leaseAcquired, true)
  assert.ok(retryLeaseCheckpoint)
  const leasedRetrySlot = retryLeaseCheckpoint.orchestration.slots.find(slot => (
    slot.agentKind === retryLeaseCheckpoint.orchestration.synthesisRecovery.activeWriterKind
  ))
  const leasedRetryAttempt = retryLeaseCheckpoint.agentRuns.find(attempt => (
    attempt.agentRunId === leasedRetrySlot.agentRunId
  ))
  assert.ok(leasedRetryAttempt)
  assert.equal(leasedRetryAttempt.kind, leasedRetrySlot.agentKind)
  assert.notEqual(
    leasedRetrySlot.agentRunId,
    approvalCrashRecord.continuation.publicAgentRunId,
  )
  assert.equal(new Set(
    terminal.orchestration.synthesisRecovery.attempts.map(attempt => attempt.operationId),
  ).size, 2)

  const thirdRestart = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: postApprovalCrashPath }),
  })
  await thirdRestart.refreshAgents()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(synthesisCalls.length, 2)
})

for (const scenario of [
  {
    name: 'retry approval',
    optionId: 'retry-original-writer',
    expectsReplacement: false,
  },
  {
    name: 'replacement approval',
    optionId: 'replace-next-writer',
    expectsReplacement: true,
  },
]) {
  test(`V4 synthesis ${scenario.name} survives a crash after only continuation completion`, async (t) => {
    const { directory, options } = fixture()
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const ledgerPath = path.join(directory, `run-ledger-${scenario.optionId}.json`)
    let gateClock = '2026-07-28T04:00:00.000Z'
    options.now = () => gateClock
    options.runLedger = new RunLedger({ storagePath: ledgerPath })
    const synthesisCalls = []
    options.runAgent = async (agent, prompt, _workdir, runOptions) => {
      const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
      if (phase === 'synthesis') {
        synthesisCalls.push({ kind: agent.kind, operationId: runOptions.operationId })
        if (synthesisCalls.length === 1) {
          throw Object.assign(new Error('socket reset after write'), { code: 'ECONNRESET' })
        }
      }
      return {
        text: `${agent.kind} ${phase}`,
        sessionRef: runOptions.sessionRef || `${agent.kind}-${phase}`,
        collaboration: phase === 'proposal'
          ? v4Proposal(agent.kind)
          : phase === 'challenge'
            ? v4Challenge(agent.kind)
            : phase === 'work'
              ? v4Work(agent.kind, prompt)
              : phase === 'synthesis'
                ? { version: 1, phase, summary: `${agent.kind} candidate`, resolvedIssueIds: [] }
                : { version: 1, phase, verdict: 'support', summary: `${agent.kind} review` },
      }
    }
    const workspace = new LocalWorkspace(options)
    await workspace.refreshAgents()
    const group = workspace.createGroup({
      name: `Approval-only crash ${scenario.optionId}`,
      agentKinds: ['codex', 'hermes', 'workbuddy'],
      workdir: directory,
      allowWrite: true,
    })
    const gatePromise = pendingGate(workspace, 5000)
    await workspace.sendMessage({
      groupId: group.id,
      text: `Consume the durable ${scenario.name} without asking twice.`,
      mode: 'auto',
      maxRounds: 2,
      targetKinds: ['codex', 'hermes', 'workbuddy'],
      protocol: 'v4',
    })
    const pending = await gatePromise
    await workspace.stopAll()

    gateClock = '2026-07-28T04:01:00.000Z'
    const decisionLedger = new RunLedger({ storagePath: ledgerPath })
    const decisionWorkspace = new LocalWorkspace({ ...options, runLedger: decisionLedger })
    await decisionWorkspace.refreshAgents()
    let resolveApprovalOnlyCrash
    const approvalOnlyCrash = new Promise(resolve => { resolveApprovalOnlyCrash = resolve })
    const completeHumanGateContinuation = decisionWorkspace.completeHumanGateContinuation
      .bind(decisionWorkspace)
    decisionWorkspace.completeHumanGateContinuation = (runId, gateId, state) => {
      const persisted = completeHumanGateContinuation(runId, gateId, state)
      const durable = decisionLedger.get(runId)
      if (gateId === pending.gateId && state === 'completed'
          && durable.continuation.state === 'completed'
          && durable.orchestration.phase === 'human-gate'
          && durable.orchestration.synthesisRecovery.attempts.at(-1)?.status
            === 'unknown_outcome') {
        resolveApprovalOnlyCrash(structuredClone(durable))
        throw new Error('TEST_CRASH:V4_SYNTHESIS_APPROVAL_ONLY_CHECKPOINTED')
      }
      return persisted
    }
    decisionWorkspace.decideHumanGate(pending.gateId, {
      status: 'approved', optionId: scenario.optionId, actorId: 'local-user',
    })
    const approvalOnlyRecord = await approvalOnlyCrash

    assert.equal(approvalOnlyRecord.continuation.state, 'completed')
    assert.equal(approvalOnlyRecord.orchestration.phase, 'human-gate')
    assert.deepEqual(
      approvalOnlyRecord.orchestration.synthesisRecovery.attempts.map(attempt => attempt.status),
      ['unknown_outcome'],
    )
    assert.equal(
      approvalOnlyRecord.orchestration.synthesisRecovery.pendingGate.operationId,
      approvalOnlyRecord.continuation.agentRunId,
    )
    await decisionWorkspace.stopAll()

    const recoveryLedgerPath = path.join(directory, `recovery-${scenario.optionId}.json`)
    const recoveryLedger = new RunLedger({ storagePath: recoveryLedgerPath })
    recoveryLedger.checkpoint(approvalOnlyRecord)
    gateClock = '2026-07-28T04:02:00.000Z'
    const restarted = new LocalWorkspace({ ...options, runLedger: recoveryLedger })
    let plannedCheckpoint = null
    let leaseCheckpoint = null
    const checkpointRun = restarted.checkpointRun.bind(restarted)
    restarted.checkpointRun = (groupId, controller, status = '') => {
      const persisted = checkpointRun(groupId, controller, status)
      const recovery = controller.orchestration?.synthesisRecovery
      const selectedSlot = controller.orchestration?.slots?.find(slot => (
        slot.agentKind === recovery?.activeWriterKind
      ))
      if (!plannedCheckpoint && controller.orchestration?.phase === 'synthesis'
          && recovery?.attempts.at(-1)?.status === 'intent'
          && selectedSlot?.status === 'planned') {
        plannedCheckpoint = structuredClone(recoveryLedger.get(controller.runId))
      }
      if (!leaseCheckpoint && controller.orchestration?.phase === 'synthesis'
          && recovery?.attempts.at(-1)?.status === 'leased'
          && selectedSlot?.status === 'running') {
        leaseCheckpoint = structuredClone(recoveryLedger.get(controller.runId))
      }
      return persisted
    }
    await restarted.refreshAgents()
    const outcome = await waitForTerminalOrFreshGate(
      restarted, recoveryLedger, pending.runId, pending.gateId,
    )

    assert.equal(outcome.freshGate, undefined, outcome.freshGate?.gateId)
    const terminal = outcome.terminal
    assert.equal(terminal.status, 'completed', terminal.reason)
    assert.equal(terminal.continuation.state, 'completed')
    assert.equal(synthesisCalls.length, 2)
    assert.equal(
      synthesisCalls[0].kind === synthesisCalls[1].kind,
      !scenario.expectsReplacement,
    )
    assert.notEqual(synthesisCalls[0].operationId, synthesisCalls[1].operationId)
    assert.deepEqual(
      restarted.listHumanGates({ runId: pending.runId }).map(gate => gate.gateId),
      [pending.gateId],
    )
    assert.ok(plannedCheckpoint)
    const plannedSlot = plannedCheckpoint.orchestration.slots.find(slot => (
      slot.agentKind === plannedCheckpoint.orchestration.synthesisRecovery.activeWriterKind
    ))
    assert.equal(Object.hasOwn(plannedSlot, 'agentRunId'), false)
    assert.equal(
      plannedSlot.operationId,
      plannedCheckpoint.orchestration.synthesisRecovery.attempts.at(-1).operationId,
    )
    assert.ok(leaseCheckpoint)
    const leasedSlot = leaseCheckpoint.orchestration.slots.find(slot => (
      slot.agentKind === leaseCheckpoint.orchestration.synthesisRecovery.activeWriterKind
    ))
    const leasedAttempt = leaseCheckpoint.agentRuns.find(attempt => (
      attempt.agentRunId === leasedSlot.agentRunId
    ))
    assert.ok(leasedAttempt)
    assert.equal(leasedAttempt.kind, leasedSlot.agentKind)
    assert.notEqual(leasedSlot.agentRunId, approvalOnlyRecord.continuation.publicAgentRunId)

    const thirdRestart = new LocalWorkspace({
      ...options,
      runLedger: new RunLedger({ storagePath: recoveryLedgerPath }),
    })
    await thirdRestart.refreshAgents()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(synthesisCalls.length, 2)
  })
}

test('V4 synthesis Stop survives a crash before continuation completion', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath })
  const synthesisCalls = []
  options.runLedger = ledger
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    if (phase === 'synthesis') {
      synthesisCalls.push({ kind: agent.kind, operationId: runOptions.operationId })
      throw Object.assign(new Error('socket reset after write'), { code: 'ECONNRESET' })
    }
    return {
      text: `${agent.kind} ${phase}`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-${phase}`,
      collaboration: phase === 'proposal'
        ? v4Proposal(agent.kind)
        : phase === 'challenge'
          ? v4Challenge(agent.kind)
          : v4Work(agent.kind, prompt),
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Crash-safe V4 synthesis Stop',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: true,
  })
  const gatePromise = pendingGate(workspace, 5000)
  await workspace.sendMessage({
    groupId: group.id,
    text: 'Stop the uncertain writer without replaying after restart.',
    mode: 'auto',
    maxRounds: 2,
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    protocol: 'v4',
  })
  const pending = await gatePromise
  await workspace.stopAll()

  const decisionLedger = new RunLedger({ storagePath: ledgerPath })
  const decisionWorkspace = new LocalWorkspace({ ...options, runLedger: decisionLedger })
  await decisionWorkspace.refreshAgents()
  let resolveStopCrash
  const stopCrash = new Promise(resolve => { resolveStopCrash = resolve })
  let stopCrashCaptured = false
  const completeHumanGateContinuation = decisionWorkspace.completeHumanGateContinuation
    .bind(decisionWorkspace)
  decisionWorkspace.completeHumanGateContinuation = (runId, gateId, state) => {
    const durable = decisionLedger.get(runId)
    if (gateId === pending.gateId && state === 'cancelled'
        && !stopCrashCaptured
        && durable.orchestration.synthesisRecovery.attempts.at(-1)?.status === 'cancelled') {
      stopCrashCaptured = true
      resolveStopCrash(structuredClone(durable))
      throw new Error('TEST_CRASH:V4_SYNTHESIS_STOP_CHECKPOINTED')
    }
    return completeHumanGateContinuation(runId, gateId, state)
  }
  decisionWorkspace.decideHumanGate(pending.gateId, {
    status: 'rejected', optionId: 'stop-discussion', actorId: 'local-user',
  })
  const stopCrashRecord = await stopCrash

  assert.equal(stopCrashRecord.orchestration.phase, 'human-gate')
  assert.equal(stopCrashRecord.continuation.state, 'resuming')
  assert.equal(
    stopCrashRecord.orchestration.synthesisRecovery.attempts.at(-1).status,
    'cancelled',
  )
  const stoppedBinding = stopCrashRecord.orchestration.synthesisRecovery.pendingGate
  assert.ok(stoppedBinding)
  assert.equal(stoppedBinding.operationId, stopCrashRecord.continuation.agentRunId)
  assert.equal(decisionWorkspace.canResumeAutoOrchestration(stopCrashRecord), true)

  const postStopCrashPath = path.join(directory, 'run-ledger-post-stop-crash.json')
  const postStopCrashLedger = new RunLedger({ storagePath: postStopCrashPath })
  postStopCrashLedger.checkpoint(stopCrashRecord)
  const restartedCalls = []
  const restarted = new LocalWorkspace({
    ...options,
    runLedger: postStopCrashLedger,
    runAgent: async (agent) => {
      restartedCalls.push(agent.kind)
      throw new Error('TEST_AGENT_MUST_NOT_RUN_AFTER_SYNTHESIS_STOP')
    },
  })
  await restarted.refreshAgents()
  const terminal = await waitForTerminalRun(postStopCrashLedger, pending.runId)

  assert.equal(terminal.status, 'stopped', terminal.reason)
  assert.equal(terminal.continuation.state, 'cancelled')
  assert.deepEqual(restartedCalls, [])
  assert.equal(synthesisCalls.length, 1)
})

test('V4 synthesis Stop survives a crash after continuation cancellation', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger-late-stop.json')
  const ledger = new RunLedger({ storagePath: ledgerPath })
  const synthesisCalls = []
  options.runLedger = ledger
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const phase = prompt.match(/^Phase: ([a-z-]+)$/m)?.[1] || ''
    if (phase === 'synthesis') {
      synthesisCalls.push({ kind: agent.kind, operationId: runOptions.operationId })
      throw Object.assign(new Error('socket reset after write'), { code: 'ECONNRESET' })
    }
    return {
      text: `${agent.kind} ${phase}`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-${phase}`,
      collaboration: phase === 'proposal'
        ? v4Proposal(agent.kind)
        : phase === 'challenge'
          ? v4Challenge(agent.kind)
          : v4Work(agent.kind, prompt),
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Late crash-safe V4 synthesis Stop',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: true,
  })
  const gatePromise = pendingGate(workspace, 5000)
  await workspace.sendMessage({
    groupId: group.id,
    text: 'Persist the terminal Stop after its continuation is cancelled.',
    mode: 'auto',
    maxRounds: 2,
    targetKinds: ['codex', 'hermes', 'workbuddy'],
    protocol: 'v4',
  })
  const pending = await gatePromise
  await workspace.stopAll()

  const decisionLedger = new RunLedger({ storagePath: ledgerPath })
  const decisionWorkspace = new LocalWorkspace({ ...options, runLedger: decisionLedger })
  await decisionWorkspace.refreshAgents()
  let resolveLateStopCrash
  const lateStopCrash = new Promise(resolve => { resolveLateStopCrash = resolve })
  let lateStopCrashRecord = null
  const finishRun = decisionWorkspace.finishRun.bind(decisionWorkspace)
  decisionWorkspace.finishRun = async (groupId, controller, status) => {
    if (!lateStopCrashRecord && status === 'stopped'
        && controller.continuation?.state === 'cancelled') {
      lateStopCrashRecord = structuredClone(decisionLedger.get(controller.runId))
      resolveLateStopCrash(lateStopCrashRecord)
      throw new Error('TEST_CRASH:V4_SYNTHESIS_STOP_CONTINUATION_CANCELLED')
    }
    return finishRun(groupId, controller, status)
  }
  decisionWorkspace.decideHumanGate(pending.gateId, {
    status: 'rejected', optionId: 'stop-discussion', actorId: 'local-user',
  })
  const stopCrashRecord = await lateStopCrash

  assert.equal(stopCrashRecord.continuation.state, 'cancelled')
  assert.equal(stopCrashRecord.orchestration.phase, 'human-gate')
  assert.equal(
    stopCrashRecord.orchestration.synthesisRecovery.attempts.at(-1).status,
    'cancelled',
  )
  assert.equal(['completed', 'partial', 'failed', 'stopped', 'timeout', 'interrupted']
    .includes(stopCrashRecord.status), false)

  const restartLedger = new RunLedger({
    storagePath: path.join(directory, 'run-ledger-post-late-stop-crash.json'),
  })
  restartLedger.checkpoint(stopCrashRecord)
  const restartedCalls = []
  const restarted = new LocalWorkspace({
    ...options,
    runLedger: restartLedger,
    runAgent: async (agent) => {
      restartedCalls.push(agent.kind)
      throw new Error('TEST_AGENT_MUST_NOT_RUN_AFTER_LATE_SYNTHESIS_STOP')
    },
  })
  await restarted.refreshAgents()
  const terminal = await waitForTerminalRun(restartLedger, pending.runId)

  assert.equal(terminal.status, 'stopped', terminal.reason)
  assert.equal(terminal.continuation.state, 'cancelled')
  assert.deepEqual(restartedCalls, [])
  assert.equal(synthesisCalls.length, 1)
})

test('legacy Role Review continuations fail closed without reading workflow data', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Legacy workflow', agentKinds: ['codex'], workdir: directory,
  })
  const durable = {
    runId: 'run-legacy-workflow',
    groupId: group.id,
    continuation: {
      gateId: 'gate-legacy-workflow',
      resumeKind: 'role_review_decision',
    },
  }
  const controller = {
    signal: new AbortController().signal,
    stopReason: '',
  }
  let requestRead = false
  let completed
  let finished
  workspace.runLedger = { get: () => durable }
  workspace.canResumeHumanGateRecord = () => true
  workspace.runCoordinator.resume = () => controller
  workspace.humanGateStore.request = () => {
    requestRead = true
    return {}
  }
  workspace.completeHumanGateContinuation = (...args) => { completed = args }
  workspace.finishRun = (...args) => { finished = args }

  await workspace.resumeHumanGateDecision({
    gateId: durable.continuation.gateId,
    runId: durable.runId,
    type: 'decision',
  }, { status: 'approved', optionId: 'accept-artifact' })

  assert.equal(requestRead, false)
  assert.equal(controller.stopReason, 'LOCAL_WORKFLOW_UNSUPPORTED')
  assert.deepEqual(completed, [durable.runId, durable.continuation.gateId, 'failed'])
  assert.deepEqual(finished, [group.id, controller, 'failed'])
  assert.equal(calls.length, 0)
})

test('retry approval survives restart and reuses the durable operation ID once', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath })
  const operationIds = []
  let invocations = 0
  options.runLedger = ledger
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    invocations += 1
    operationIds.push(runOptions.operationId)
    if (invocations === 1) {
      throw Object.assign(new Error('socket reset after write'), { code: 'ECONNRESET' })
    }
    return { text: 'approved retry completed', sessionRef: 'retry-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Durable retry approval',
    agentKinds: ['codex'],
    workdir: directory,
    allowWrite: true,
  })
  const gatePromise = pendingGate(workspace)
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Do not replay this uncertain write without approval',
    targetKinds: ['codex'],
  })
  const gate = await gatePromise

  await workspace.stopAll()
  await send
  assert.equal(invocations, 1)
  assert.equal(ledger.get(gate.runId).status, 'waiting')

  const restartedLedger = new RunLedger({ storagePath: ledgerPath })
  const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
  await restarted.refreshAgents()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(invocations, 1)

  restarted.decideHumanGate(gate.gateId, { optionId: 'retry-once' })
  const terminal = await waitForRunStatus(restartedLedger, gate.runId, 'completed')

  assert.equal(invocations, 2)
  assert.equal(operationIds[0], operationIds[1])
  assert.equal(terminal.continuation.state, 'completed')
})

test('restart resumes a durable Gate decision whose continuation checkpoint stayed pending once', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath })
  let invocations = 0
  options.runLedger = ledger
  options.runAgent = async () => {
    invocations += 1
    return { text: 'Recovered approved result', sessionRef: 'codex-recovered-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Decision checkpoint crash', agentKinds: ['codex'], workdir: directory,
  })
  const gatePromise = pendingGate(workspace)
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Resume the already approved Gate after restart',
    targetKinds: ['codex'],
    budget: {
      limits: { costMicros: 100 },
      enforcement: { costMicros: 'hard' },
    },
  })
  const pending = await gatePromise
  await workspace.stopAll()
  await send

  approveGate(workspace.humanGateStore, pending.gateId)
  assert.equal(ledger.get(pending.runId).continuation.state, 'pending')
  assert.equal(invocations, 0)

  const restartedLedger = new RunLedger({ storagePath: ledgerPath })
  const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
  await restarted.refreshAgents()
  const completed = await waitForTerminalRun(restartedLedger, pending.runId)

  assert.deepEqual(
    { status: completed.status, reason: completed.reason },
    { status: 'completed', reason: '' },
  )
  assert.equal(invocations, 1)
  assert.equal(completed.continuation.state, 'completed')
  assert.equal(restarted.snapshot().messages.some(message => (
    message.role === 'agent'
      && message.content === 'Recovered approved result'
      && message.trace?.runId === pending.runId
  )), true)

  const secondRestart = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath }),
  })
  await secondRestart.refreshAgents()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(invocations, 1)
})

test('restart resumes a first-slot Agent Gate and completes the remaining manual slots', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath })
  const invokedKinds = []
  options.runLedger = ledger
  options.runAgent = async (agent, _prompt, _workdir, runOptions) => {
    invokedKinds.push(agent.kind)
    if (agent.kind === 'hermes') {
      return { text: 'Hermes completed the remaining slot', sessionRef: 'hermes-resumed-session' }
    }
    assert.equal(agent.kind, 'codex')
    await runOptions.onSessionRef('codex-non-final-session', { transport: 'acp' })
    const decision = await runOptions.onPermissionRequest({
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
      ],
      operation: { kind: 'write', path: 'first-slot.txt' },
    }, { signal: runOptions.signal })
    return { text: `decision:${decision.optionId}`, sessionRef: 'codex-non-final-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Non-final Gate recovery',
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
    allowWrite: true,
  })
  const gatePromise = pendingGate(workspace)
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Do not skip the second Agent slot after restart',
    targetKinds: ['codex', 'hermes'],
  })
  const pending = await gatePromise
  await workspace.stopAll()
  await send

  const restartedLedger = new RunLedger({ storagePath: ledgerPath })
  const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
  await restarted.refreshAgents()
  assert.deepEqual(restartedLedger.get(pending.runId).orchestration, {
    version: 1,
    workflow: 'manual',
    currentKind: 'codex',
    pendingKinds: ['hermes'],
    activeKinds: ['codex', 'hermes'],
    successfulKinds: [],
    agreementKinds: [],
    attachmentRecipients: [],
    totalSuccesses: 0,
    terminalFailureOccurred: false,
  })
  restarted.decideHumanGate(pending.gateId, {
    status: 'approved', optionId: 'allow-once', actorId: 'local-user',
  })
  const completed = await waitForTerminalRun(restartedLedger, pending.runId)

  assert.deepEqual(
    { status: completed.status, reason: completed.reason },
    { status: 'completed', reason: '' },
  )
  assert.deepEqual(invokedKinds, ['codex', 'codex', 'hermes'])
  assert.equal(completed.continuation.state, 'completed')
  assert.deepEqual(completed.orchestration.pendingKinds, [])
  assert.deepEqual(completed.orchestration.successfulKinds.sort(), ['codex', 'hermes'])
  assert.equal(restarted.snapshot().messages.some(message => (
    message.role === 'agent'
      && message.agentKind === 'hermes'
      && message.content === 'Hermes completed the remaining slot'
  )), true)
  const sequences = completed.agentRuns.flatMap(run => run.events.map(event => event.seq))
  assert.deepEqual(sequences, [...sequences].sort((left, right) => left - right))
  assert.equal(new Set(sequences).size, sequences.length)
})

test('restart resumes a middle Agent Gate without rerunning completed manual slots', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath })
  const invokedKinds = []
  options.runLedger = ledger
  options.runAgent = async (agent, _prompt, _workdir, runOptions) => {
    invokedKinds.push(agent.kind)
    if (agent.kind === 'codex') {
      return { text: 'Codex completed before the Gate', sessionRef: 'codex-first-session' }
    }
    if (agent.kind === 'workbuddy') {
      return { text: 'WorkBuddy completed after the Gate', sessionRef: 'workbuddy-last-session' }
    }
    await runOptions.onSessionRef('kimi-middle-session', { transport: 'acp' })
    const decision = await runOptions.onPermissionRequest({
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
      ],
      operation: { kind: 'write', path: 'middle-slot.txt' },
    }, { signal: runOptions.signal })
    return { text: `Kimi resumed:${decision.optionId}`, sessionRef: 'kimi-middle-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Middle Gate recovery',
    agentKinds: ['codex', 'kimi', 'workbuddy'],
    workdir: directory,
    allowWrite: true,
  })
  const gatePromise = pendingGate(workspace)
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Resume only the middle and remaining slots',
    targetKinds: ['codex', 'kimi', 'workbuddy'],
  })
  const pending = await gatePromise
  await workspace.stopAll()
  await send

  const restartedLedger = new RunLedger({ storagePath: ledgerPath })
  assert.deepEqual(restartedLedger.get(pending.runId).orchestration.successfulKinds, ['codex'])
  const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
  await restarted.refreshAgents()
  restarted.decideHumanGate(pending.gateId, {
    status: 'approved', optionId: 'allow-once', actorId: 'local-user',
  })
  const terminal = await waitForTerminalRun(restartedLedger, pending.runId)

  assert.deepEqual(
    { status: terminal.status, reason: terminal.reason },
    { status: 'completed', reason: '' },
  )
  assert.deepEqual(invokedKinds, ['codex', 'kimi', 'kimi', 'workbuddy'])
  assert.deepEqual(terminal.orchestration.successfulKinds.sort(), ['codex', 'kimi', 'workbuddy'])
  assert.equal(restarted.snapshot().messages.filter(message => (
    message.role === 'agent' && message.agentKind === 'codex'
  )).length, 1)
})

test('restart resumes the first automatic Agent slot and completes the round', async (t) => {
  await verifyAutomaticGateRecovery(t, 0)
})

test('restart resumes the middle automatic Agent slot without rerunning earlier Agents', async (t) => {
  await verifyAutomaticGateRecovery(t, 1)
})

test('restart resumes the final automatic Agent slot exactly once', async (t) => {
  await verifyAutomaticGateRecovery(t, 2)
})

test('a failed Gate resume checkpoint restores live continuation state for retry', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    await runOptions.onSessionRef('codex-checkpoint-retry-session', { transport: 'acp' })
    const decision = await runOptions.onPermissionRequest({
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
      ],
      operation: { kind: 'write', path: 'retry-after-checkpoint.txt' },
    }, { signal: runOptions.signal })
    return { text: `decision:${decision.optionId}`, sessionRef: 'codex-checkpoint-retry-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Gate checkpoint retry', agentKinds: ['codex'], workdir: directory, allowWrite: true,
  })
  const gatePromise = pendingGate(workspace)
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Retry the same decision after a transient checkpoint failure',
    targetKinds: ['codex'],
  })
  const pending = await gatePromise
  const controller = workspace.activeRuns.get(group.id)
  const originalCheckpointRun = workspace.checkpointRun.bind(workspace)
  let rejectNextCheckpoint = true
  workspace.checkpointRun = (...args) => {
    if (rejectNextCheckpoint) {
      rejectNextCheckpoint = false
      return false
    }
    return originalCheckpointRun(...args)
  }

  assert.throws(() => workspace.decideHumanGate(pending.gateId, {
    status: 'approved', optionId: 'allow-once', actorId: 'local-user',
  }), /LOCAL_RUN_PERSIST_FAILED/u)
  assert.equal(controller.waitingGateIds.has(pending.gateId), true)
  assert.equal(controller.continuation.gateId, pending.gateId)
  assert.equal(controller.continuation.state, 'pending')
  assert.equal(workspace.listHumanGates({ pendingOnly: true })[0].gateId, pending.gateId)

  workspace.decideHumanGate(pending.gateId, {
    status: 'approved', optionId: 'allow-once', actorId: 'local-user',
  })
  await send
  const completed = await waitForRunStatus(ledger, pending.runId, 'completed')

  assert.equal(completed.continuation.state, 'completed')
  assert.equal(workspace.snapshot().messages.some(message => (
    message.role === 'agent' && message.content === 'decision:allow-once'
  )), true)
})

test('a failed initial Gate checkpoint clears its waiter and restores the live Run for retry', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runLedger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Initial Gate checkpoint retry', agentKinds: ['codex'], workdir: directory,
  })
  const controller = workspace.createRunController('manual', ['codex'], 'task-gate-retry')
  controller.groupId = group.id
  workspace.activeRuns.set(group.id, controller)
  const input = {
    type: 'permission',
    runId: controller.runId,
    agentRunId: 'agent-run-gate-retry',
    agentKind: 'codex',
    summary: 'Agent requests permission to retry a tool action.',
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
    ],
    request: { operation: { kind: 'write', path: 'retry.txt' } },
  }
  const gateOptions = {
    continuation: {
      resumeKind: 'agent_slot',
      agentRunId: 'agent-run-gate-retry',
      agentKind: 'codex',
      round: 0,
    },
  }

  workspace.checkpointRun = () => false
  await assert.rejects(
    workspace.requestHumanGate(input, gateOptions),
    { message: 'LOCAL_RUN_PERSIST_FAILED' },
  )
  assert.equal(workspace.humanGateCoordinator.waiters.size, 0)
  assert.equal(workspace.humanGateWaitTails.size, 0)
  assert.equal(controller.continuation, null)
  assert.equal(controller.waitingGateIds.size, 0)
  assert.equal(workspace.listHumanGates({ pendingOnly: true }).length, 1)

  workspace.checkpointRun = () => true
  const retry = workspace.requestHumanGate(input, gateOptions)
  await new Promise(resolve => setImmediate(resolve))
  const [pending] = workspace.listHumanGates({ pendingOnly: true })
  assert.equal(workspace.humanGateCoordinator.waiters.size, 1)
  workspace.decideHumanGate(pending.gateId, { optionId: 'allow-once' })
  assert.equal((await retry).status, 'approved')
  assert.equal(workspace.humanGateCoordinator.waiters.size, 0)

  workspace.activeRuns.delete(group.id)
  controller.resolveDone()
})

test('parallel Agent gates are exposed one at a time without overwriting continuation', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Parallel Gate queue', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const controller = workspace.createRunController(
    'manual', ['codex', 'hermes'], 'parallel-gate-thread',
  )
  controller.groupId = group.id
  workspace.activeRuns.set(group.id, controller)
  const gateInput = (agentKind, suffix) => ({
    type: 'permission',
    runId: controller.runId,
    agentRunId: `agent-run-${suffix}`,
    agentKind,
    summary: 'Agent requests permission to continue a tool action.',
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
    ],
    request: {
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
      ],
      operation: { kind: 'write', path: `${suffix}.txt` },
    },
  })
  const gateOptions = (agentKind, suffix) => ({
    continuation: {
      resumeKind: 'agent_slot',
      agentRunId: `agent-run-${suffix}`,
      agentKind,
      round: 0,
    },
  })

  const firstDecision = workspace.requestHumanGate(
    gateInput('codex', 'first'), gateOptions('codex', 'first'),
  )
  const firstGate = await pendingGate(workspace)
  const secondDecision = workspace.requestHumanGate(
    gateInput('hermes', 'second'), gateOptions('hermes', 'second'),
  )
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(workspace.listHumanGates({ pendingOnly: true }).length, 1)
  assert.equal(controller.continuation.gateId, firstGate.gateId)
  assert.equal(controller.continuation.agentKind, 'codex')
  workspace.decideHumanGate(firstGate.gateId, {
    status: 'approved', optionId: 'allow-once', actorId: 'local-user',
  })
  await firstDecision

  const secondGate = await pendingGate(workspace)
  assert.notEqual(secondGate.gateId, firstGate.gateId)
  assert.equal(workspace.listHumanGates({ pendingOnly: true }).length, 1)
  assert.equal(controller.continuation.gateId, secondGate.gateId)
  assert.equal(controller.continuation.agentKind, 'hermes')
  workspace.decideHumanGate(secondGate.gateId, {
    status: 'approved', optionId: 'allow-once', actorId: 'local-user',
  })
  await secondDecision

  assert.equal(workspace.listHumanGates({ pendingOnly: true }).length, 0)
  workspace.activeRuns.delete(group.id)
})

test('restart approval resumes the exact permission request without replaying prior side effects', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath })
  let invocations = 0
  let preGateSideEffects = 0
  const permissionRequest = {
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
    ],
    operation: { kind: 'write', path: 'already-touched.txt' },
  }
  options.runLedger = ledger
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    invocations += 1
    await runOptions.onSessionRef('codex-side-effect-session', { transport: 'acp' })
    if (invocations === 1) preGateSideEffects += 1
    const decision = await runOptions.onPermissionRequest(
      permissionRequest,
      { signal: runOptions.signal },
    )
    return { text: `decision:${decision.optionId}`, sessionRef: 'codex-side-effect-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Permission replay guard', agentKinds: ['codex'], workdir: directory, allowWrite: true,
  })
  const gatePromise = pendingGate(workspace)
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Do not replay work completed before the permission request',
    targetKinds: ['codex'],
  })
  const pending = await gatePromise
  await workspace.stopAll()
  await send

  const restartedLedger = new RunLedger({ storagePath: ledgerPath })
  const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
  await restarted.refreshAgents()
  const waitingSnapshot = restarted.snapshot()
  assert.equal(waitingSnapshot.humanGates[0].gateId, pending.gateId)
  assert.equal(waitingSnapshot.runs[0].runId, pending.runId)

  restarted.decideHumanGate(pending.gateId, {
    status: 'approved', optionId: 'allow-once', actorId: 'local-user',
  })
  const completed = await waitForRunStatus(restartedLedger, pending.runId, 'completed')

  assert.equal(invocations, 2)
  assert.equal(preGateSideEffects, 1)
  assert.equal(completed.continuation.state, 'completed')
  assert.equal(restarted.snapshot().messages.some(message => (
    message.role === 'agent' && message.content === 'decision:allow-once'
  )), true)
  assert.equal(restarted.snapshot().messages.some(message => (
    message.role === 'system'
      && message.agentKind === 'codex'
      && message.system?.key === 'system.agentCallFailed'
  )), false)
})

test('restart approval fails closed when a permission continuation has no persisted Session', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath })
  let invocations = 0
  options.runLedger = ledger
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    invocations += 1
    const decision = await runOptions.onPermissionRequest({
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
      ],
      operation: { kind: 'write', path: 'must-not-replay.txt' },
    }, { signal: runOptions.signal })
    return { text: `decision:${decision.optionId}`, sessionRef: 'late-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Missing permission Session', agentKinds: ['codex'], workdir: directory, allowWrite: true,
  })
  const gatePromise = pendingGate(workspace)
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Never replay a permission continuation without a persisted Session',
    targetKinds: ['codex'],
  })
  const pending = await gatePromise
  await workspace.stopAll()
  await send

  const restartedLedger = new RunLedger({ storagePath: ledgerPath })
  const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
  await restarted.refreshAgents()
  restarted.decideHumanGate(pending.gateId, {
    status: 'approved', optionId: 'allow-once', actorId: 'local-user',
  })
  const failed = await waitForRunStatus(restartedLedger, pending.runId, 'failed')

  assert.equal(invocations, 1)
  assert.equal(failed.reason, 'LOCAL_RUN_PERMISSION_RESUME_UNAVAILABLE')
  assert.equal(failed.continuation.state, 'failed')
  assert.equal(restarted.snapshot().messages.some(message => (
    message.role === 'agent' && message.content === 'decision:allow-once'
  )), false)
})

test('restart approval fails closed when the resumed Session reissues a different permission request', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath })
  let invocations = 0
  const originalRequest = {
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
    ],
    operation: { kind: 'write', path: 'approved-target.txt' },
  }
  options.runLedger = ledger
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    invocations += 1
    await runOptions.onSessionRef('codex-mismatched-session', { transport: 'acp' })
    const request = invocations === 1
      ? originalRequest
      : { ...originalRequest, operation: { kind: 'write', path: 'different-target.txt' } }
    const decision = await runOptions.onPermissionRequest(request, { signal: runOptions.signal })
    return { text: `decision:${decision.optionId}`, sessionRef: 'codex-mismatched-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Mismatched permission request',
    agentKinds: ['codex'],
    workdir: directory,
    allowWrite: true,
  })
  const gatePromise = pendingGate(workspace)
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Apply approval only to the exact persisted permission request',
    targetKinds: ['codex'],
  })
  const pending = await gatePromise
  await workspace.stopAll()
  await send

  const restartedLedger = new RunLedger({ storagePath: ledgerPath })
  const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
  await restarted.refreshAgents()
  restarted.decideHumanGate(pending.gateId, {
    status: 'approved', optionId: 'allow-once', actorId: 'local-user',
  })
  const failed = await waitForRunStatus(restartedLedger, pending.runId, 'failed')

  assert.equal(invocations, 2)
  assert.equal(failed.reason, 'LOCAL_RUN_PERMISSION_REQUEST_MISMATCH')
  assert.equal(failed.continuation.state, 'failed')
  assert.equal(restarted.listHumanGates({ pendingOnly: true }).length, 0)
  assert.equal(restarted.snapshot().messages.some(message => (
    message.role === 'agent' && message.content === 'decision:allow-once'
  )), false)
})

test('restart fails an approved continuation closed when its Context Pack is missing', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath })
  let invocations = 0
  options.runLedger = ledger
  options.runAgent = async () => {
    invocations += 1
    return { text: 'Must not execute', sessionRef: 'codex-invalid-session' }
  }
  const { workspace, pending } = await stoppedBudgetGate(
    options, directory, 'Reject an approved Gate without immutable context',
  )
  approveGate(workspace.humanGateStore, pending.gateId)
  removeContextPack(workspace, ledger.get(pending.runId).contextPackId)

  const restartedLedger = new RunLedger({ storagePath: ledgerPath })
  const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
  await restarted.refreshAgents()
  const failed = await waitForRunStatus(restartedLedger, pending.runId, 'failed')

  assert.equal(invocations, 0)
  assert.equal(failed.reason, 'human_gate_continuation_invalid')
  assert.equal(failed.continuation.state, 'failed')
})

test('restart fails an approved Gate that belongs to a different Run closed', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath })
  let invocations = 0
  options.runLedger = ledger
  options.runAgent = async () => {
    invocations += 1
    return { text: 'Must not execute', sessionRef: 'codex-cross-run-session' }
  }
  const { workspace, pending } = await stoppedBudgetGate(
    options, directory, 'Reject a cross-Run Gate decision',
  )
  const originalRequest = workspace.humanGateStore.request(pending.gateId)
  const crossRunGate = workspace.humanGateStore.create({
    type: pending.type,
    runId: 'run-from-another-task',
    agentRunId: pending.agentRunId,
    agentKind: pending.agentKind,
    summary: pending.summary,
    options: pending.options,
    request: originalRequest,
    createdAt: '2026-07-28T00:00:00.000Z',
  })
  const durable = ledger.get(pending.runId)
  ledger.checkpoint({
    runId: durable.runId,
    continuation: { ...durable.continuation, gateId: crossRunGate.gateId },
  })
  approveGate(workspace.humanGateStore, crossRunGate.gateId)

  const restartedLedger = new RunLedger({ storagePath: ledgerPath })
  const restarted = new LocalWorkspace({ ...options, runLedger: restartedLedger })
  await restarted.refreshAgents()
  const failed = await waitForRunStatus(restartedLedger, pending.runId, 'failed')

  assert.equal(invocations, 0)
  assert.equal(failed.reason, 'human_gate_continuation_invalid')
  assert.equal(failed.continuation.state, 'failed')
})

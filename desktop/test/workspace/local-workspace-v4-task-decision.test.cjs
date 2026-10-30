const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { RunLedger } = require('../../src/runs/run-ledger.cjs')
const { fixture } = require('../support/local-workspace-test-helpers.cjs')

function reply(status, reason, extra = {}) {
  return `${reason}\n[[MELDWORK_COLLABORATION:${JSON.stringify({ summary: reason, taskDecision: {
    status, reason, deliverables: status === 'completed' ? ['The requested answer.'] : [], nextKinds: [], ...extra,
  } })}]]`
}

async function until(read, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = read()
    if (result) return result
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('TEST_TASK_DECISION_TIMEOUT')
}

async function start(t, style = 'agent-led', peerDecision = false) {
  const { directory, options } = fixture()
  const storagePath = path.join(directory, 'run-ledger.json')
  const calls = []
  const runAgent = async (agent, prompt, _workdir, input) => {
    const phase = prompt.includes('Work independently on the user task') ? 'proposal' : 'discussion'
    const version = prompt.match(/Candidate version: ([a-f0-9]{64})/)?.[1]
    calls.push({ kind: agent.kind, phase, prompt, sessionRef: input.sessionRef })
    return { outcome: 'completed', sessionRef: input.sessionRef || 'human-task-session',
      text: phase === 'proposal' ? 'I need the user to choose the target.'
        : prompt.includes('USER_CHOICE_B') ? reply('completed', 'The answer uses USER_CHOICE_B.', version ? { reviewedVersion: version } : {})
          : peerDecision && agent.kind === 'codex' ? reply('continue', 'Hermes should ask for the missing input.', { nextKinds: ['hermes'] })
          : reply('needs-human', 'Which target should be used?') }
  }
  const workspaceOptions = { ...options, naturalAgentResponses: true, runAgent }
  const ledger = new RunLedger({ storagePath })
  const workspace = new LocalWorkspace({ ...workspaceOptions, runLedger: ledger })
  const workspaces = [workspace]
  t.after(async () => {
    for (const instance of workspaces) await instance.stopAll()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  await workspace.refreshAgents()
  const group = workspace.createGroup({ name: 'Human task decision', agentKinds: peerDecision ? ['codex', 'hermes'] : ['codex'], workdir: directory, allowWrite: false })
  await workspace.sendMessage({ groupId: group.id, text: 'Answer after I choose the target.',
    mode: 'auto', protocol: 'v4', discussionStyle: style, targetKinds: group.agentKinds, maxRounds: 6 })
  const controller = workspace.activeRuns.get(group.id)
  const gate = await until(() => workspace.listHumanGates({ pendingOnly: true })[0])
  return { workspace, workspaceOptions, workspaces, ledger, storagePath, group, controller, gate, calls }
}

test('an invited automatic participant can request human input without becoming the owner', async t => {
  const { workspace, ledger, controller, gate } = await start(t, 'agent-led', true)
  assert.equal(gate.agentKind, 'hermes')
  const request = workspace.humanGateStore.request(gate.gateId)
  assert.equal(workspace.canResumeV4TaskDecision(ledger.get(controller.runId), gate, request), true)
  assert.equal(workspace.canResumeV4TaskDecision(ledger.get(controller.runId), { ...gate, agentKind: 'codex' }, request), false)
  workspace.decideHumanGate(gate.gateId, { optionId: 'respond', response: 'USER_CHOICE_B' })
  await controller.promise
  assert.equal(ledger.get(controller.runId).status, 'completed')
  const candidate = workspace.autoRunner.v4NaturalConsensus(workspace.state.groups.find(group => group.id === controller.groupId), controller, controller.threadRootId)
  assert.deepEqual([...candidate.approvedKinds], ['hermes', 'codex'])
})

for (const style of ['agent-led', 'sequential']) {
  test(`Natural ${style} needs-human waits for input and continues the same task`, async t => {
    const { workspace, ledger, controller, gate, calls } = await start(t, style)
    assert.equal(gate.type, 'input')
    const waiting = ledger.get(controller.runId)
    assert.equal(waiting.status, 'waiting')
    assert.equal(waiting.continuation.resumeKind, 'v4_task_decision')
    assert.ok(workspace.snapshot().humanGates.some(item => item.gateId === gate.gateId))
    const before = calls.length
    workspace.decideHumanGate(gate.gateId, { optionId: 'respond', response: 'USER_CHOICE_B' })
    await controller.promise
    const completed = ledger.get(controller.runId)
    assert.equal(completed.status, 'completed', completed.reason)
    assert.equal(calls.length, before + 1)
    assert.match(calls.at(-1).prompt, /Human responses for this task[\s\S]*USER_CHOICE_B/)
    assert.equal(completed.continuation.state, 'completed')
    assert.equal(calls.at(-1).sessionRef, 'human-task-session')
  })
}

test('Natural needs-human cancellation stops without invoking another Agent', async t => {
  const { workspace, ledger, controller, gate, calls } = await start(t)
  const before = calls.length
  workspace.decideHumanGate(gate.gateId, { optionId: 'cancel' })
  await controller.promise
  assert.equal(ledger.get(controller.runId).status, 'stopped')
  assert.equal(calls.length, before)
})

test('Natural needs-human survives shutdown and resumes after the user responds without replaying the request', async t => {
  const { workspace, workspaceOptions, workspaces, storagePath, controller, gate, calls } = await start(t)
  await workspace.stopAll()
  await controller.promise
  const ledger = new RunLedger({ storagePath })
  assert.equal(ledger.get(controller.runId).continuation.state, 'pending')
  const reopened = new LocalWorkspace({ ...workspaceOptions, runLedger: ledger })
  workspaces.push(reopened)
  await reopened.refreshAgents()
  const before = calls.length
  assert.equal(reopened.canResumeHumanGate(reopened.humanGateStore.get(gate.gateId)), true)
  reopened.decideHumanGate(gate.gateId, { optionId: 'respond', response: 'USER_CHOICE_B' })
  const final = await until(() => {
    const run = ledger.get(controller.runId)
    return ['completed', 'partial', 'failed', 'stopped'].includes(run.status) ? run : null
  })
  assert.equal(final.status, 'completed', final.reason)
  assert.equal(calls.length, before + 1)
  assert.match(calls.at(-1).prompt, /USER_CHOICE_B/)
  assert.equal(reopened.listHumanGates({ pendingOnly: true }).length, 0)
})

test('Natural needs-human rejects altered task, source, snapshot and owner bindings', async t => {
  const { workspace, ledger, controller, gate } = await start(t)
  const stored = workspace.humanGateStore.get(gate.gateId)
  const durable = ledger.get(controller.runId)
  const request = workspace.humanGateStore.request(gate.gateId)
  assert.equal(workspace.canResumeV4TaskDecision(durable, stored, request), true)
  for (const field of ['source', 'phase', 'round', 'slotId', 'operationId', 'snapshotHash', 'decisionHash']) {
    assert.equal(workspace.canResumeV4TaskDecision(durable, stored, {
      ...request, [field]: field === 'round' ? request.round + 1 : 'different',
    }), false, field)
  }
  assert.equal(workspace.canResumeV4TaskDecision(durable, { ...stored, runId: 'other-run' }, request), false)
  assert.equal(workspace.canResumeV4TaskDecision(durable, { ...stored, agentRunId: 'other-call' }, request), false)
  assert.equal(workspace.canResumeV4TaskDecision(durable, { ...stored, agentKind: 'hermes' }, request), false)
  assert.equal(workspace.canResumeV4TaskDecision(durable, {
    ...stored, options: [{ optionId: 'respond', kind: 'allow_always' }, stored.options[1]],
  }, request), false)
  const altered = structuredClone(durable)
  altered.agentRuns.at(-1).context.taskDecision.reason = 'A different question.'
  assert.equal(workspace.canResumeV4TaskDecision(altered, stored, request), false)
})

test('Natural needs-human resumes an approved decision after shutdown before continuation dispatch', async t => {
  const { workspace, workspaceOptions, workspaces, storagePath, controller, gate, calls } = await start(t)
  await workspace.stopAll()
  await controller.promise
  const ledger = new RunLedger({ storagePath })
  const deciding = new LocalWorkspace({ ...workspaceOptions, runLedger: ledger })
  workspaces.push(deciding)
  await deciding.refreshAgents()
  deciding.humanGateCoordinator.onOrphanDecision = () => {}
  deciding.decideHumanGate(gate.gateId, { optionId: 'respond', response: 'USER_CHOICE_B' })
  assert.equal(ledger.get(controller.runId).continuation.state, 'ready')
  await deciding.stopAll()
  const before = calls.length
  const recoveredLedger = new RunLedger({ storagePath })
  const recovered = new LocalWorkspace({ ...workspaceOptions, runLedger: recoveredLedger })
  workspaces.push(recovered)
  await recovered.refreshAgents()
  const final = await until(() => {
    const run = recoveredLedger.get(controller.runId)
    return ['completed', 'partial', 'failed', 'stopped'].includes(run.status) ? run : null
  })
  assert.equal(final.status, 'completed', final.reason)
  assert.equal(calls.length, before + 1)
  recovered.decideHumanGate(gate.gateId, { optionId: 'respond', response: 'USER_CHOICE_B' })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(calls.length, before + 1)
})

test('Natural needs-human recovers after applying input but before starting the next turn', async t => {
  const { workspace, workspaceOptions, workspaces, storagePath, controller, gate, calls } = await start(t)
  const recoveryPath = path.join(path.dirname(storagePath), 'recovery-ledger.json')
  const complete = workspace.completeHumanGateContinuation.bind(workspace)
  workspace.completeHumanGateContinuation = (...args) => {
    const result = complete(...args)
    if (args[2] === 'completed') {
      fs.copyFileSync(storagePath, recoveryPath)
      if (fs.existsSync(`${storagePath}.journal`)) fs.copyFileSync(`${storagePath}.journal`, `${recoveryPath}.journal`)
      throw new Error('TEST_CRASH_AFTER_INPUT_CHECKPOINT')
    }
    return result
  }
  workspace.decideHumanGate(gate.gateId, { optionId: 'respond', response: 'USER_CHOICE_B' })
  await controller.promise
  const ledger = new RunLedger({ storagePath: recoveryPath })
  assert.equal(ledger.get(controller.runId).continuation.state, 'completed')
  const before = calls.length
  const recovered = new LocalWorkspace({ ...workspaceOptions, runLedger: ledger })
  workspaces.push(recovered)
  await recovered.refreshAgents()
  const final = await until(() => {
    const run = ledger.get(controller.runId)
    return ['completed', 'partial', 'failed', 'stopped'].includes(run.status) ? run : null
  })
  assert.equal(final.status, 'completed', final.reason)
  assert.equal(calls.length, before + 1)
  assert.equal(recovered.listHumanGates({ runId: controller.runId }).length, 1)
})

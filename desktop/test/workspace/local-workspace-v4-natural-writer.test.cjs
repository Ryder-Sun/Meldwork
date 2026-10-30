const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { RunLedger } = require('../../src/runs/run-ledger.cjs')
const { parseOrchestrationV4 } = require('../../src/collaboration/orchestration-v4-records.cjs')
const { fixture } = require('../support/local-workspace-test-helpers.cjs')

function reply(text, prompt = '') {
  const reviewedVersion = prompt.match(/Candidate version: ([a-f0-9]{64})/)?.[1]
  return `${text}\n\n[[MELDWORK_COLLABORATION:${JSON.stringify({ summary: text,
    taskDecision: { status: 'completed', reason: text, deliverables: ['result.txt read back as OK'],
      ...(reviewedVersion ? { reviewedVersion } : {}) },
  })}]]`
}

async function waitFor(read, label) {
  const end = Date.now() + 10000
  while (Date.now() < end) {
    const value = read()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out: ${label}`)
}

for (const discussionStyle of ['sequential', 'agent-led']) {
  test(`Natural ${discussionStyle} respects writable group authorization for every participant`, async (t) => {
    const { directory, options } = fixture()
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const ledger = new RunLedger({ storagePath: path.join(directory, 'ledger.json') })
    options.runLedger = ledger
    options.naturalAgentResponses = true
    const calls = []
    options.runAgent = async (agent, prompt, workdir, runOptions) => {
      const discussion = prompt.includes('Continue from the available peer responses')
      calls.push({ kind: agent.kind, discussion, sandbox: runOptions.sandbox })
      if (runOptions.sandbox === 'workspace-write') {
        assert.match(prompt, /user enabled workspace writes/i)
        fs.writeFileSync(path.join(workdir, 'result.txt'), 'OK')
        assert.equal(fs.readFileSync(path.join(workdir, 'result.txt'), 'utf8'), 'OK')
      }
      return { text: discussion ? reply('The file was checked.', prompt) : 'I will inspect the requested result.', sessionRef: `${agent.kind}-session` }
    }
    const workspace = new LocalWorkspace(options)
    await workspace.refreshAgents()
    const group = workspace.createGroup({ name: 'Natural writer', agentKinds: ['codex', 'hermes'], workdir: directory, allowWrite: true })
    await workspace.sendMessage({ groupId: group.id, text: 'Write result.txt containing OK.', mode: 'auto', protocol: 'v4', discussionStyle, targetKinds: group.agentKinds, maxRounds: 4 })
    await workspace.activeRuns.get(group.id)?.promise
    const record = ledger.list(group.id)[0]
    assert.equal(record.status, 'completed', JSON.stringify(workspace.snapshot().messages.map(message => message.content)))
    assert.equal(record.orchestration.discussionWriterKind, 'codex')
    assert.ok(calls.some(call => call.sandbox === 'workspace-write'))
    assert.ok(calls.every(call => call.sandbox === 'workspace-write'))
    for (const slot of record.orchestration.slots) {
      const assignment = record.orchestration.plan.assignments.find(item => item.slotId === slot.slotId)
      assert.equal(assignment.readOnly, slot.permission === 'read-only')
    }
    for (const mutate of [
      cursor => { cursor.discussionWriterKind = 'not-a-participant' },
      ...(discussionStyle === 'sequential' ? [
        cursor => { delete cursor.discussionWriterKind },
      ] : [cursor => { cursor.slots[0].permission = 'read-only' }]),
      cursor => { cursor.plan.assignments[0].readOnly = !cursor.plan.assignments[0].readOnly },
    ]) {
      const tampered = structuredClone(record.orchestration)
      mutate(tampered)
      assert.throws(() => parseOrchestrationV4(tampered, { targetKinds: group.agentKinds }), /ORCHESTRATION_V4_PERMISSION_INVALID/)
    }
  })
}

for (const writerKind of ['hermes', '']) {
  test(`Natural writer selection respects declared capabilities: ${writerKind || 'no writable participant'}`, async (t) => {
    const { directory, options } = fixture()
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const detectAgents = options.detectAgents
    options.detectAgents = async () => (await detectAgents()).map(agent => ({
      ...agent,
      routingCapabilities: { permissionModes: agent.kind === writerKind ? ['read-only', 'workspace-write'] : ['read-only'] },
    }))
    const ledger = new RunLedger({ storagePath: path.join(directory, 'ledger.json') })
    options.runLedger = ledger
    options.naturalAgentResponses = true
    const calls = []
    options.runAgent = async (agent, prompt, _workdir, runOptions) => {
      const discussion = prompt.includes('Continue from the available peer responses')
      calls.push({ kind: agent.kind, discussion, sandbox: runOptions.sandbox })
      if (discussion && writerKind && agent.kind !== writerKind && !prompt.includes('Candidate version:')) {
        return { text: `The writable participant should deliver the update.\n\n[[MELDWORK_COLLABORATION:${JSON.stringify({ summary: 'Writer needed.',
          taskDecision: { status: 'continue', reason: 'Hand over delivery to the writable participant.', deliverables: [], handoffTo: writerKind, nextKinds: [writerKind] },
        })}]]`, sessionRef: `${agent.kind}-session` }
      }
      return { text: discussion ? reply('Result checked.', prompt) : 'Initial proposal.', sessionRef: `${agent.kind}-session` }
    }
    const workspace = new LocalWorkspace(options)
    t.after(() => workspace.stopAll())
    await workspace.refreshAgents()
    const group = workspace.createGroup({ name: 'Declared writer', agentKinds: ['codex', 'hermes'], workdir: directory, allowWrite: true })
    await workspace.sendMessage({ groupId: group.id, text: 'Inspect the result and update if needed.', mode: 'auto', protocol: 'v4', discussionStyle: 'agent-led', targetKinds: group.agentKinds, maxRounds: 4 })
    await workspace.activeRuns.get(group.id)?.promise
    const result = ledger.list(group.id)[0]
    assert.equal(result.status, 'completed', JSON.stringify(workspace.snapshot().messages.map(message => message.content)))
    assert.equal(result.orchestration.discussionWriterKind || '', writerKind)
    const writeCalls = calls.filter(call => call.sandbox === 'workspace-write')
    if (writerKind) {
      assert.ok(writeCalls.length >= 1)
      assert.ok(writeCalls.every(call => (
        call.kind === writerKind
      )))
      assert.ok(calls.filter(call => call.sandbox !== 'workspace-write')
        .every(call => call.sandbox === 'read-only'))
    } else {
      assert.deepEqual(writeCalls, [])
    }
  })
}

for (const { approved, restartGate, capturePhase = 'discussion' } of [
  { approved: false }, { approved: true }, { approved: true, restartGate: true },
  { approved: false, capturePhase: 'proposal' },
  { approved: true, capturePhase: 'proposal' },
  { approved: true, restartGate: true, capturePhase: 'proposal' },
]) {
  test(`Recovered natural ${capturePhase} writer ${approved ? 'retries only after approval' : 'does not replay after rejection'}${restartGate ? ' after reopening the Gate' : ''}`, async (t) => {
    const { directory, options } = fixture()
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const ledger = new RunLedger({ storagePath: path.join(directory, 'ledger.json') })
    const recoveryLedger = new RunLedger({ storagePath: path.join(directory, 'recovery-ledger.json') })
    const recoveryStoragePath = path.join(directory, 'recovery-workspace.json')
    options.runLedger = ledger
    options.naturalAgentResponses = true
    let captured
    options.runAgent = async (agent, prompt, _workdir, runOptions) => {
      const discussion = prompt.includes('Continue from the available peer responses')
      if ((discussion ? 'discussion' : 'proposal') === capturePhase && !captured) {
        captured = ledger.list()[0]
        recoveryLedger.checkpoint(captured)
        fs.copyFileSync(options.storagePath, recoveryStoragePath)
      }
      return { text: discussion ? reply('Work completed.') : 'Initial proposal.', sessionRef: `${agent.kind}-session` }
    }
    const workspace = new LocalWorkspace(options)
    await workspace.refreshAgents()
    const group = workspace.createGroup({ name: 'Writer recovery', agentKinds: ['codex'], workdir: directory, allowWrite: true })
    await workspace.sendMessage({ groupId: group.id, text: 'Write the requested file.', mode: 'auto', protocol: 'v4', discussionStyle: 'agent-led', targetKinds: group.agentKinds, maxRounds: 4 })
    await workspace.activeRuns.get(group.id)?.promise
    assert.ok(captured, JSON.stringify(workspace.snapshot().messages.map(message => message.content)))
    const calls = []
    const secondLedger = new RunLedger({ storagePath: path.join(directory, 'second-ledger.json') })
    const secondStoragePath = path.join(directory, 'second-workspace.json')
    let secondCaptured
    const createRecovered = () => new LocalWorkspace({ ...options, storagePath: recoveryStoragePath, runLedger: recoveryLedger,
      runAgent: async (agent, _prompt, _workdir, runOptions) => {
        calls.push({ kind: agent.kind, sandbox: runOptions.sandbox })
        secondCaptured = recoveryLedger.get(captured.runId)
        secondLedger.checkpoint(secondCaptured)
        fs.copyFileSync(recoveryStoragePath, secondStoragePath)
        return { text: reply('Recovered result checked.'), sessionRef: `${agent.kind}-session`, outcome: 'completed' }
      },
    })
    let recovered = createRecovered()
    t.after(() => recovered.stopAll())
    let controller = recovered.activeRuns.get(group.id)
    assert.ok(controller)
    await recovered.refreshAgents()
    const gate = await waitFor(() => recovered.listHumanGates({ pendingOnly: true })[0], 'unknown writer gate')
    assert.deepEqual(calls, [])
    assert.equal(recoveryLedger.get(captured.runId).status, 'waiting')
    if (restartGate) {
      await recovered.stopAll()
      assert.equal(recoveryLedger.get(captured.runId).status, 'waiting')
      recovered = createRecovered()
      controller = recovered.activeRuns.get(group.id)
      assert.equal(controller, undefined)
      await recovered.refreshAgents()
      assert.equal(recovered.listHumanGates({ pendingOnly: true })[0].gateId, gate.gateId)
      assert.deepEqual(calls, [])
    }
    recovered.decideHumanGate(gate.gateId, { status: approved ? 'approved' : 'rejected', optionId: approved ? 'retry-once' : 'cancel-retry', actorId: 'local-user' })
    await waitFor(() => ['completed', 'stopped', 'failed'].includes(recoveryLedger.get(captured.runId).status), 'writer recovery terminal result')
    await (controller || recovered.activeRuns.get(group.id))?.done
    const result = recoveryLedger.get(captured.runId)
    assert.equal(result.status, approved ? 'completed' : 'stopped', result.reason)
    assert.deepEqual(calls, approved ? Array.from({ length: capturePhase === 'proposal' ? 2 : 1 },
      () => ({ kind: 'codex', sandbox: 'workspace-write' })) : [])
    if (approved) {
      assert.equal(secondCaptured.continuation.state, 'completed')
      const secondCalls = []
      const second = new LocalWorkspace({ ...options, storagePath: secondStoragePath, runLedger: secondLedger,
        runAgent: async () => { secondCalls.push('unexpected'); return { text: reply('Unexpected replay'), outcome: 'completed' } },
      })
      t.after(() => second.stopAll())
      const secondController = second.activeRuns.get(group.id)
      await second.refreshAgents()
      const nextGate = await waitFor(() => second.listHumanGates({ pendingOnly: true })[0], 'second interrupted writer gate')
      assert.notEqual(nextGate.gateId, gate.gateId)
      assert.deepEqual(secondCalls, [])
      second.decideHumanGate(nextGate.gateId, { status: 'rejected', optionId: 'cancel-retry', actorId: 'local-user' })
      await secondController.done
      assert.equal(secondLedger.get(captured.runId).status, 'stopped')
    }
  })
}

test('A completed natural writer recovers its result without repeating the filesystem write', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'ledger.json') })
  const recoveryLedger = new RunLedger({ storagePath: path.join(directory, 'recovery-ledger.json') })
  const recoveryStoragePath = path.join(directory, 'recovery-workspace.json')
  options.runLedger = ledger
  options.naturalAgentResponses = true
  const output = path.join(directory, 'result.txt')
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    const discussion = prompt.includes('Continue from the available peer responses')
    if (discussion) {
      assert.equal(runOptions.sandbox, 'workspace-write')
      fs.appendFileSync(output, 'OK\n')
    }
    return { text: discussion ? reply('The result was read back.') : 'Ready to write.', sessionRef: `${agent.kind}-session` }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({ name: 'Completed writer recovery', agentKinds: ['codex'], workdir: directory, allowWrite: true })
  let captured
  const checkpoint = workspace.checkpointRun.bind(workspace)
  workspace.checkpointRun = (...args) => {
    const persisted = checkpoint(...args)
    const record = ledger.list(group.id)[0]
    if (!captured && record?.agentRuns.some(run => run.round === 2 && run.status === 'completed')) {
      captured = record
      recoveryLedger.checkpoint(record)
      fs.copyFileSync(options.storagePath, recoveryStoragePath)
    }
    return persisted
  }
  await workspace.sendMessage({ groupId: group.id, text: 'Append once to result.txt.', mode: 'auto', protocol: 'v4', discussionStyle: 'agent-led', targetKinds: group.agentKinds, maxRounds: 4 })
  await workspace.activeRuns.get(group.id)?.promise
  assert.ok(captured)
  const calls = []
  const recovered = new LocalWorkspace({ ...options, storagePath: recoveryStoragePath, runLedger: recoveryLedger,
    runAgent: async () => { calls.push('unexpected'); return { text: reply('Unexpected'), outcome: 'completed' } },
  })
  t.after(() => recovered.stopAll())
  const controller = recovered.activeRuns.get(group.id)
  await recovered.refreshAgents()
  await controller.done
  assert.equal(recoveryLedger.get(captured.runId).status, 'completed')
  assert.deepEqual(calls, [])
  assert.equal(recovered.listHumanGates({ pendingOnly: true }).length, 0)
  assert.equal(fs.readFileSync(output, 'utf8'), 'OK\n')
})

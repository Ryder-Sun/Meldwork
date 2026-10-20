const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { LocalWorkspaceAutoRunner } = require('../../src/workspace/local-workspace-auto-runner.cjs')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { RunLedger } = require('../../src/runs/run-ledger.cjs')
const { fixture } = require('../support/local-workspace-test-helpers.cjs')

function deliveryFixture() {
  const messages = []
  const runner = Object.create(LocalWorkspaceAutoRunner.prototype)
  runner.state = () => ({ messages })
  runner.v4NaturalMessageMatchesBinding = () => true
  runner.v4SanitizeDeliveryText = text => text
  runner.checkpointOrchestration = (_group, controller, update) => {
    controller.orchestration = structuredClone({ ...controller.orchestration, ...update })
  }
  const group = { id: 'group' }
  const controller = { runId: 'run', orchestration: { snapshotHash: '3'.repeat(64) } }
  const binding = { hasSession: true, sessionRefHash: '1'.repeat(64), sessionProvenanceHash: '2'.repeat(64) }
  const add = (text, kind = 'codex') => {
    const id = `message-${messages.length}`
    messages.push({ id, content: text, role: 'agent', agentKind: kind, groupId: group.id, threadRootId: 'thread',
      trace: { round: messages.length + 1, phase: 'discussion', context: { operationId: `operation-${id}` } } })
    return id
  }
  const prepare = (current = binding, kind = 'hermes') => runner.v4NaturalDeliveryPrompt(
    group, controller, 'thread', kind, { operationId: 'dispatch' }, current, text => `TASK\n${text}`,
  )
  const settle = (built, status = 'acknowledged', current = binding) => runner.v4SetDeliveryStatus(
    group, controller, built.delivery, status, current,
  )
  return { runner, group, controller, binding, messages, add, prepare, settle }
}

test('Natural delivery omits only unchanged complete messages acknowledged in this native session', () => {
  const f = deliveryFixture()
  f.add('FIRST_EVIDENCE')
  const first = f.prepare()
  assert.match(first.prompt, /FIRST_EVIDENCE/)
  const retry = f.prepare()
  assert.match(retry.prompt, /FIRST_EVIDENCE/, 'Preparing is not acknowledgement')
  f.settle(retry)
  assert.doesNotMatch(f.prepare().prompt, /FIRST_EVIDENCE/)
  f.add('SECOND_EVIDENCE')
  const second = f.prepare()
  assert.doesNotMatch(second.prompt, /FIRST_EVIDENCE/)
  assert.match(second.prompt, /SECOND_EVIDENCE/)
  f.settle(second)
  assert.equal(f.controller.orchestration.deliveryState[0].sourceMessages.length, 2)
  assert.doesNotMatch(f.prepare().prompt, /FIRST_EVIDENCE|SECOND_EVIDENCE/)
  f.messages[0].content = 'CORRECTED_EVIDENCE'
  assert.match(f.prepare().prompt, /CORRECTED_EVIDENCE/)
})

test('Natural delivery acknowledgements are scoped to recipient, provenance, snapshot, and session', () => {
  const f = deliveryFixture()
  f.add('SCOPED_EVIDENCE')
  f.settle(f.prepare())
  const acknowledged = structuredClone(f.controller.orchestration)
  for (const changed of [
    { hasSession: false }, { sessionRotated: true },
    { sessionRefHash: '4'.repeat(64) }, { sessionProvenanceHash: '5'.repeat(64) },
  ]) {
    f.controller.orchestration = structuredClone(acknowledged)
    assert.match(f.prepare({ ...f.binding, ...changed }).prompt, /SCOPED_EVIDENCE/)
  }
  f.controller.orchestration = structuredClone(acknowledged)
  assert.match(f.prepare(f.binding, 'codex').prompt, /SCOPED_EVIDENCE/)
  f.controller.orchestration = structuredClone(acknowledged)
  f.controller.orchestration.snapshotHash = '6'.repeat(64)
  assert.match(f.prepare().prompt, /SCOPED_EVIDENCE/)
})

test('Natural uncertain delivery is resent, and partial or omitted entries are never acknowledged', () => {
  const f = deliveryFixture()
  f.add('RETRY_EVIDENCE')
  f.settle(f.prepare(), 'uncertain')
  assert.match(f.prepare().prompt, /RETRY_EVIDENCE/)
  f.add(`LONG_START\n${'x'.repeat(100000)}\nLONG_END`)
  const partial = f.prepare()
  assert.match(partial.prompt, /Excerpt: omitted text/)
  assert.equal(partial.delivery.entries[0].sourceMessages.length, 1)
  f.settle(partial)
  const repeated = f.prepare()
  assert.doesNotMatch(repeated.prompt, /RETRY_EVIDENCE/)
  assert.match(repeated.prompt, /LONG_START/)
  assert.equal(repeated.delivery, null)
  assert.ok(repeated.prompt.length <= 48005)
})

test('A native session change at completion cannot inherit acknowledgements for unsent earlier input', () => {
  const f = deliveryFixture()
  f.add('EARLIER_INPUT')
  f.settle(f.prepare())
  f.add('CURRENT_INPUT')
  const current = f.prepare()
  const rotated = { ...f.binding, sessionRefHash: '7'.repeat(64) }
  f.settle(current, 'acknowledged', rotated)
  const rebuilt = f.prepare(rotated)
  assert.match(rebuilt.prompt, /EARLIER_INPUT/)
  assert.doesNotMatch(rebuilt.prompt, /CURRENT_INPUT/)
})

test('Natural acknowledged message records remain bounded and contain no conversation text', () => {
  const f = deliveryFixture()
  for (let index = 0; index < 101; index += 1) f.add(`EVIDENCE_${index}`)
  const packed = f.prepare()
  assert.equal(packed.delivery.entries[0].sourceMessages.length, 100)
  assert.doesNotMatch(JSON.stringify(packed.delivery.entries), /EVIDENCE_/)
  f.settle(packed)
  const remaining = f.prepare()
  assert.match(remaining.prompt, /EVIDENCE_0\n?$/)
  f.settle(remaining)
  assert.equal(f.controller.orchestration.deliveryState[0].sourceMessages.length, 100)
})

for (const staleSession of [false, true]) {
  test(`Natural sequential calls preserve task and unseen evidence with stale session=${staleSession}`, async (t) => {
    const { directory, options } = fixture()
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
    const calls = []
    const counts = new Map()
    let invalidated = false
    const workspace = new LocalWorkspace({
      ...options, runLedger: ledger, naturalAgentResponses: true,
      runAgent: async (agent, prompt, _workdir, runOptions) => {
        const count = (counts.get(agent.kind) || 0) + 1
        counts.set(agent.kind, count)
        calls.push({ kind: agent.kind, prompt, sessionRef: runOptions.sessionRef, count })
        if (staleSession && agent.kind === 'codex' && count === 3) {
          invalidated = true
          throw new Error('LOCAL_AGENT_SESSION_INVALID')
        }
        const text = count === 1 ? `PROPOSAL_${agent.kind}` : `CONTRIBUTION_${agent.kind}_${count}`
        return {
          outcome: 'completed', sessionRef: runOptions.sessionRef || `${agent.kind}-${invalidated ? 'new' : 'initial'}`,
          text: `${text}\n[[MELDWORK_COLLABORATION:${JSON.stringify({ summary: text,
            taskDecision: { status: 'continue', reason: text, deliverables: [] },
          })}]]`,
        }
      },
    })
    await workspace.refreshAgents()
    const group = workspace.createGroup({ name: 'Incremental context', agentKinds: ['codex', 'hermes'], workdir: directory, allowWrite: false })
    await workspace.sendMessage({
      groupId: group.id, text: 'AUTHORITATIVE_TASK', mode: 'auto', protocol: 'v4',
      discussionStyle: 'sequential', targetKinds: group.agentKinds, maxRounds: 3,
    })
    const controller = workspace.activeRuns.get(group.id)
    await controller.promise
    assert.equal(ledger.get(controller.runId).status, 'round-limit')
    const codex = calls.filter(call => call.kind === 'codex')
    assert.match(codex[1].prompt, /PROPOSAL_hermes/)
    assert.doesNotMatch(codex[2].prompt, /PROPOSAL_hermes|PROPOSAL_codex/)
    assert.match(codex[2].prompt, /CONTRIBUTION_hermes_2/)
    assert.ok(calls.every(call => call.prompt.includes('AUTHORITATIVE_TASK')))
    if (staleSession) {
      assert.equal(codex.length, 4)
      assert.equal(codex[3].sessionRef, '')
      assert.match(codex[3].prompt, /PROPOSAL_hermes|PROPOSAL_codex/)
      assert.match(codex[3].prompt, /CONTRIBUTION_hermes_2/)
    }
    const reopened = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
    assert.deepEqual(reopened.get(controller.runId).orchestration.deliveryState,
      ledger.get(controller.runId).orchestration.deliveryState)
    assert.ok(reopened.get(controller.runId).orchestration.deliveryState.some(entry => entry.sourceMessages?.length))
  })
}

test('Natural completion with an absolute deliverable path persists its receipt and terminal state', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  const decision = {
    status: 'completed', reason: `Verified ${path.join(directory, 'result.txt')}`,
    deliverables: [`File ${path.join(directory, 'result.txt')} contains the requested result.`],
  }
  let calls = 0
  const workspace = new LocalWorkspace({
    ...options, runLedger: ledger, naturalAgentResponses: true,
    runAgent: async () => ({ outcome: 'completed', sessionRef: 'native-path-session',
      text: ++calls === 1 ? 'Initial proposal.' : `Verified result.txt.\n[[MELDWORK_COLLABORATION:${JSON.stringify({ summary: 'Verified result.', taskDecision: decision })}]]`,
    }),
  })
  await workspace.refreshAgents()
  const group = workspace.createGroup({ name: 'File completion', agentKinds: ['codex'], workdir: directory, allowWrite: false })
  await workspace.sendMessage({ groupId: group.id, text: 'Verify the result.', mode: 'auto', protocol: 'v4', discussionStyle: 'agent-led', targetKinds: ['codex'], maxRounds: 3 })
  const controller = workspace.activeRuns.get(group.id)
  await controller.promise
  const record = ledger.get(controller.runId)
  assert.equal(record.status, 'completed')
  const receipt = record.orchestration.slots[0].resultRefs.workflowOutcomeRefs.at(-1).receipt
  assert.equal(receipt.taskDecision.reason, 'Verified [path]')
  assert.deepEqual(record.agentRuns.at(-1).context.taskDecision, decision)
})

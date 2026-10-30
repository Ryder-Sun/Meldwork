const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { RunLedger } = require('../../src/runs/run-ledger.cjs')
const { fixture } = require('../support/local-workspace-test-helpers.cjs')
const { naturalConsensusMethods } = require('../../src/workspace/local-workspace-auto-runner-natural-consensus.cjs')
const { parseTaskDecision, parseLenientTaskDecision } = require('../../src/collaboration/task-decision.cjs')
const { captureArtifactOutputState, captureAgentOutcomeDescriptors } = require('../../src/agents/agent-output-importer.cjs')

function reply(text, status = 'continue', extra = {}) {
  return `${text}\n[[MELDWORK_COLLABORATION:${JSON.stringify({ summary: text.slice(0, 500),
    taskDecision: { status, reason: text.slice(0, 500), deliverables: status === 'completed' ? ['Answer'] : [], ...extra },
  })}]]`
}

const versionFrom = prompt => prompt.match(/Candidate version: ([a-f0-9]{64})/)?.[1]

async function run(t, respond, input = {}) {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'ledger.json') })
  options.runLedger = ledger
  options.naturalAgentResponses = true
  options.captureArtifactOutputs = captureArtifactOutputState
  options.captureAgentOutcomeDescriptors = captureAgentOutcomeDescriptors
  const calls = []
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    const phase = prompt.includes('Work independently on the user task') ? 'proposal' : 'discussion'
    const call = { kind: agent.kind, phase, prompt, workdir, runOptions }
    calls.push(call)
    const text = await respond(call, calls)
    return { text, sessionRef: runOptions.sessionRef || `${agent.kind}-session` }
  }
  const workspace = new LocalWorkspace(options)
  t.after(() => workspace.stopAll())
  await workspace.refreshAgents()
  const group = workspace.createGroup({ name: 'Consensus', agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory, allowWrite: input.allowWrite === true })
  await workspace.sendMessage({ groupId: group.id, text: 'Deliver the reviewed result.', mode: 'auto',
    protocol: 'v4', discussionStyle: 'agent-led', targetKinds: group.agentKinds, maxRounds: 10, ...input })
  const controller = workspace.activeRuns.get(group.id)
  await controller.promise
  return { calls, workspace, group, controller, record: ledger.get(controller.runId) }
}

test('first-round deliverables run concurrently, then only the invited peer speaks; any peer can propose completion', async t => {
  let entered = 0
  let release
  const barrier = new Promise(resolve => { release = resolve })
  const result = await run(t, async ({ kind, phase, prompt }) => {
    if (phase === 'proposal') {
      if (++entered === 3) release()
      await barrier
      return `${kind} complete independent result`
    }
    const version = versionFrom(prompt)
    if (version) return reply('Explicit acceptance.', 'completed', { reviewedVersion: version })
    if (kind === 'codex') {
      for (const peer of ['codex', 'hermes', 'workbuddy']) assert.ok(prompt.includes(`${peer} complete independent result`))
      return reply('@hermes refine the result.', 'continue', { nextKinds: ['hermes'] })
    }
    return reply('Complete final answer from Hermes.', 'completed')
  })
  assert.equal(result.record.status, 'completed')
  assert.deepEqual(result.calls.map(call => `${call.phase}:${call.kind}`), [
    'proposal:codex', 'proposal:hermes', 'proposal:workbuddy',
    'discussion:codex', 'discussion:hermes', 'discussion:codex', 'discussion:workbuddy',
  ])
  const confirmations = result.calls.filter(call => versionFrom(call.prompt))
  assert.equal(new Set(confirmations.map(call => versionFrom(call.prompt))).size, 1)
  assert.ok(confirmations.every(call => call.runOptions.sandbox === 'read-only'))
  assert.equal(result.calls.find(call => call.kind === 'workbuddy').runOptions.maxTurns, 0)
})

test('invitations preserve the requested priority rather than participant registration order', async t => {
  const result = await run(t, ({ phase, kind, prompt }) => {
    if (phase === 'proposal') return `${kind} result`
    const version = versionFrom(prompt)
    if (version) return reply('Approved', 'completed', { reviewedVersion: version })
    if (kind === 'codex') return reply('@workbuddy review first, then @hermes.', 'continue', { nextKinds: ['workbuddy', 'hermes'] })
    if (kind === 'workbuddy') return reply('@hermes complete the proposed answer.', 'continue', { nextKinds: ['hermes'] })
    return reply('Complete proposed answer', 'completed')
  })
  assert.equal(result.record.status, 'completed')
  assert.deepEqual(result.calls.filter(call => call.phase === 'discussion').map(call => call.kind),
    ['codex', 'workbuddy', 'hermes', 'codex', 'workbuddy'])
})

test('an objection withdraws old approvals and the revised candidate needs every peer again', async t => {
  let revision = 1
  const versions = []
  const result = await run(t, ({ phase, kind, prompt }) => {
    if (phase === 'proposal') return `${kind} result`
    const version = versionFrom(prompt)
    if (version) {
      versions.push(version)
      if (kind === 'workbuddy' && revision === 1) {
        revision = 2
        return reply('@hermes correct the defect.', 'continue', { nextKinds: ['hermes'] })
      }
      return reply('I approve this exact result.', 'completed', { reviewedVersion: version })
    }
    return reply(`Full candidate revision ${revision}`, 'completed')
  }, { unlimitedRounds: true })
  assert.equal(result.record.status, 'completed')
  assert.equal(new Set(versions).size, 2)
  assert.deepEqual(result.calls.filter(call => call.phase === 'discussion').map(call => call.kind),
    ['codex', 'hermes', 'workbuddy', 'hermes', 'codex', 'workbuddy'])
})

test('stale or missing version acceptance cannot finish the task', async t => {
  const result = await run(t, ({ phase, kind, prompt }) => phase === 'proposal' ? `${kind} result`
    : versionFrom(prompt) ? reply('Stale vote', 'completed', { reviewedVersion: 'a'.repeat(64) })
      : reply('Candidate', 'completed'))
  assert.equal(result.record.status, 'partial')
  const candidate = result.workspace.autoRunner.v4NaturalConsensus(result.group, result.controller, result.controller.threadRootId)
  assert.deepEqual([...candidate.approvedKinds], ['codex'])
})

test('missing version confirmation retains the candidate and asks the same peer again', async t => {
  const versions = []
  let missed = false
  const result = await run(t, ({ phase, kind, prompt }) => {
    if (phase === 'proposal') return `${kind} result`
    const version = versionFrom(prompt)
    if (!version) return reply('Complete candidate', 'completed')
    versions.push(version)
    if (!missed) {
      missed = true
      return reply('I approve', 'completed')
    }
    return reply('I approve this version', 'completed', { reviewedVersion: version })
  })
  assert.equal(result.record.status, 'completed')
  assert.equal(new Set(versions).size, 1)
  assert.deepEqual(result.calls.filter(call => versionFrom(call.prompt)).map(call => call.kind),
    ['hermes', 'hermes', 'workbuddy'])
})

test('a failed participant is never silently counted as agreeing', async t => {
  const result = await run(t, ({ phase, kind, prompt }) => {
    if (kind === 'workbuddy') throw new Error('LOCAL_AGENT_TIMEOUT')
    if (phase === 'proposal') return `${kind} result`
    const version = versionFrom(prompt)
    return reply('Candidate or explicit acceptance', 'completed', version ? { reviewedVersion: version } : {})
  })
  assert.equal(result.record.status, 'partial')
})

test('writable participants keep native tools in parallel proposals and version confirmations', async t => {
  let entered = 0
  let release
  const barrier = new Promise(resolve => { release = resolve })
  const result = await run(t, async ({ phase, kind, prompt, runOptions }) => {
    assert.equal(runOptions.sandbox, 'workspace-write')
    if (phase === 'proposal') {
      if (++entered === 3) release()
      await barrier
      assert.match(prompt, /including network research, commands and configured plugins/)
      return `${kind} independent result`
    }
    const version = versionFrom(prompt)
    return reply('Complete result', 'completed', version ? { reviewedVersion: version } : {})
  }, { allowWrite: true })
  assert.equal(result.record.status, 'completed')
  assert.equal(entered, 3)
  assert.ok(result.calls.every(call => call.runOptions.sandbox === 'workspace-write'))
})

test('a native file edit during confirmation withdraws the candidate and requires fresh approvals', async t => {
  const versions = []
  let revised = false
  const result = await run(t, ({ phase, prompt, workdir, runOptions }) => {
    if (phase === 'proposal') return 'Independent result'
    assert.equal(runOptions.sandbox, 'workspace-write')
    const version = versionFrom(prompt)
    const filename = path.join(workdir, '.meldwork-output', 'result.txt')
    if (version) {
      versions.push(version)
      if (!revised) {
        revised = true
        fs.writeFileSync(filename, 'Version two')
      }
      return reply('Reviewed result', 'completed', { reviewedVersion: version })
    }
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    fs.writeFileSync(filename, revised ? 'Version two' : 'Version one')
    return reply(revised ? 'Complete version two' : 'Complete version one', 'completed')
  }, { allowWrite: true, unlimitedRounds: true })
  assert.equal(result.record.status, 'completed')
  assert.equal(new Set(versions).size, 2)
  const candidate = result.workspace.autoRunner.v4NaturalConsensus(result.group, result.controller, result.controller.threadRootId)
  assert.deepEqual([...candidate.approvedKinds].sort(), ['codex', 'hermes', 'workbuddy'])
  assert.equal(candidate.text, 'Complete version two')
})

test('the invited writable peer can take over edits using the group authorization', async t => {
  const result = await run(t, ({ kind, phase, prompt, workdir, runOptions }) => {
    if (phase === 'proposal') return `${kind} result`
    const version = versionFrom(prompt)
    if (version) return reply('Approved', 'completed', { reviewedVersion: version })
    assert.equal(runOptions.sandbox, 'workspace-write')
    if (kind === 'codex') return reply('@hermes implement the correction.', 'continue', { nextKinds: ['hermes'] })
    fs.mkdirSync(path.join(workdir, '.meldwork-output'), { recursive: true })
    fs.writeFileSync(path.join(workdir, '.meldwork-output', 'result.txt'), 'Corrected result')
    return reply('Corrected result.txt', 'completed')
  }, { allowWrite: true })
  assert.equal(result.record.status, 'completed', JSON.stringify(result.workspace.snapshot().messages))
  assert.ok(result.calls.some(call => call.kind === 'hermes' && call.runOptions.sandbox === 'workspace-write'))
  const candidate = result.workspace.autoRunner.v4NaturalConsensus(result.group, result.controller, result.controller.threadRootId)
  assert.equal(candidate.files[0].path, '.meldwork-output/result.txt')
})

test('automatic turns can finish more than twelve tools and retain their answer', async t => {
  const result = await run(t, ({ phase, kind, prompt, runOptions }) => {
    for (let index = 0; index < 25; index += 1) {
      runOptions.onEvent({ id: `tool-${index}`, type: 'tool_start', title: 'search', status: 'running' })
      runOptions.onEvent({ id: `tool-${index}`, type: 'tool_result_summary', title: 'search', status: 'completed' })
    }
    assert.equal(runOptions.signal.aborted, false)
    if (phase === 'proposal') return `${kind} result`
    const version = versionFrom(prompt)
    return reply('Result', 'completed', version ? { reviewedVersion: version } : {})
  }, { unlimitedRounds: true })
  assert.equal(result.record.status, 'completed')
})

test('versioned decisions survive parsing and malformed versions are rejected', () => {
  const decision = { status: 'completed', reason: 'Checked', deliverables: ['Answer'], reviewedVersion: 'a'.repeat(64) }
  assert.deepEqual(parseLenientTaskDecision(decision), decision)
  assert.deepEqual(parseTaskDecision(decision), decision)
  assert.throws(() => parseLenientTaskDecision({ ...decision, reviewedVersion: '@codex' }), /TASK_DECISION_INVALID/)
})

test('an explicit unlimited native loop omits max-turns while manual defaults stay unchanged', () => {
  const { invocation } = require('../../src/agents/cli/cli-invocations.cjs')
  const automatic = invocation('workbuddy', '/tmp/workbuddy', '/tmp', '', { maxTurns: 0 })
  const manual = invocation('workbuddy', '/tmp/workbuddy', '/tmp')
  assert.equal(automatic.args.includes('--max-turns'), false)
  assert.equal(manual.args[manual.args.indexOf('--max-turns') + 1], '8')
})

test('changing captured deliverable bytes invalidates approval of the old file', t => {
  const { directory } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { createHash } = require('node:crypto')
  const filename = path.join(directory, 'result.txt')
  fs.writeFileSync(filename, 'Version one')
  const contentHash = createHash('sha256').update('Version one').digest('hex')
  const message = { id: 'm', groupId: 'g', threadRootId: 't', role: 'agent', agentKind: 'codex', content: 'Final result',
    trace: { phase: 'discussion', context: { outcomeRefs: { artifactIds: ['file'] }, taskDecision: { status: 'completed' } } } }
  const runner = { ...naturalConsensusMethods, state: () => ({ messages: [message] }),
    v4NaturalMessageMatchesBinding: () => true, v4NaturalMessageContent: () => ({ text: message.content, partial: false }),
    v4ArtifactIdentity: () => ({ contentHash, artifact: { locationRef: { kind: 'workspace-relative', path: 'result.txt' }, contentRef: { size: 11 } } }) }
  assert.ok(runner.v4NaturalConsensus({ id: 'g', workdir: directory }, {}, 't'))
  fs.writeFileSync(filename, 'Version two')
  assert.equal(runner.v4NaturalConsensus({ id: 'g', workdir: directory }, {}, 't'), null)
})

test('consensus is reconstructed from durable messages and ignores stale bindings', () => {
  const base = { groupId: 'g', threadRootId: 't', role: 'agent', trace: { phase: 'discussion' } }
  const messages = [{ ...base, id: 'candidate', turnSeq: 1, agentKind: 'codex', content: 'Full result',
    trace: { phase: 'discussion', context: { taskDecision: { status: 'completed' } } } }]
  const runner = { ...naturalConsensusMethods, state: () => ({ messages }),
    v4NaturalMessageMatchesBinding: message => message.id !== 'stale', v4NaturalMessageContent: message => ({ text: message.content, partial: false }) }
  const candidate = runner.v4NaturalConsensus({ id: 'g' }, {}, 't')
  for (const [index, kind] of ['hermes', 'workbuddy'].entries()) messages.push({ ...base, id: kind, turnSeq: index + 2, agentKind: kind,
    trace: { phase: 'discussion', context: { taskDecision: { status: 'completed', reviewedVersion: candidate.version } } } })
  messages.push({ ...base, id: 'stale', turnSeq: 4, agentKind: 'codex', trace: { phase: 'discussion', context: { taskDecision: { status: 'continue' } } } })
  assert.deepEqual([...runner.v4NaturalConsensus({ id: 'g' }, {}, 't').approvedKinds], ['codex', 'hermes', 'workbuddy'])
  messages.push({ ...base, id: 'objection', turnSeq: 5, agentKind: 'hermes', trace: { phase: 'discussion', context: { taskDecision: { status: 'continue' } } } })
  assert.equal(runner.v4NaturalConsensus({ id: 'g' }, {}, 't'), null)
})

test('restart retains version approvals and only dispatches the remaining reviewer', async t => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'ledger.json') })
  const recoveryLedger = new RunLedger({ storagePath: path.join(directory, 'recovery-ledger.json') })
  const recoveryStoragePath = path.join(directory, 'recovery-workspace.json')
  options.naturalAgentResponses = true
  options.runLedger = ledger
  options.runAgent = async (agent, prompt, _workdir, runOptions) => ({
    text: prompt.includes('Work independently on the user task') ? `${agent.kind} independent result`
      : reply('Reviewed complete result', 'completed', versionFrom(prompt) ? { reviewedVersion: versionFrom(prompt) } : {}),
    sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
  })
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({ name: 'Restart consensus', agentKinds: ['codex', 'hermes', 'workbuddy'], workdir: directory, allowWrite: false })
  let captured = false
  const commit = workspace.commitV4AgentMessage.bind(workspace)
  workspace.commitV4AgentMessage = input => {
    const message = commit(input)
    if (!captured && input.agentKind === 'hermes' && input.metadata?.trace?.context?.taskDecision?.reviewedVersion) {
      captured = true
      recoveryLedger.checkpoint(ledger.list(group.id)[0])
      fs.copyFileSync(options.storagePath, recoveryStoragePath)
    }
    return message
  }
  await workspace.sendMessage({ groupId: group.id, text: 'Produce and agree on one result', mode: 'auto',
    protocol: 'v4', discussionStyle: 'agent-led', targetKinds: group.agentKinds, unlimitedRounds: true })
  await workspace.activeRuns.get(group.id).promise
  assert.equal(captured, true)
  const calls = []
  const recovered = new LocalWorkspace({ ...options, storagePath: recoveryStoragePath, runLedger: recoveryLedger,
    runAgent: async (agent, prompt, _workdir, runOptions) => {
      calls.push(agent.kind)
      assert.ok(versionFrom(prompt))
      return { outcome: 'completed', text: reply('Explicit approval after restart', 'completed', { reviewedVersion: versionFrom(prompt) }), sessionRef: runOptions.sessionRef }
    } })
  t.after(() => recovered.stopAll())
  const controller = recovered.activeRuns.get(group.id)
  assert.ok(controller)
  await recovered.refreshAgents()
  await controller.done
  assert.equal(recoveryLedger.get(controller.runId).status, 'completed')
  assert.deepEqual(calls, ['workbuddy'])
  const messages = recovered.snapshot().messages.filter(message => message.role === 'agent')
  assert.equal(messages.filter(message => message.agentKind === 'hermes' && message.trace.phase === 'discussion').length, 1)
})

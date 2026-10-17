const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const {
  createRuntimeEventEmitter,
} = require('../../src/agents/cli/cli-runtime-event-sanitizer.cjs')
const { fixture } = require('../support/local-workspace-test-helpers.cjs')

test('direct Hermes conversations reuse one persistent ACP runtime key across messages', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.detectAgents = async () => [{
    kind: 'hermes', name: 'Hermes CLI', executable: '/tmp/hermes', version: '2',
    acpAvailable: true,
  }]
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    const sessionRef = runOptions.sessionRef || 'hermes-acp-session'
    await runOptions.onSessionRef(sessionRef, { transport: 'acp' })
    return { text: `reply ${calls.length}`, sessionRef, outcome: 'completed' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Hermes ACP direct', agentKinds: ['hermes'], workdir: directory,
    conversationType: 'direct', directAgentKind: 'hermes',
  })

  await workspace.sendMessage({ groupId: group.id, text: 'first' })
  await workspace.sendMessage({ groupId: group.id, text: 'second' })

  assert.deepEqual(calls.map(call => call.runOptions.sessionRef), ['', 'hermes-acp-session'])
  assert.deepEqual(calls.map(call => call.runOptions.sessionTransport), ['', 'acp'])
  assert.deepEqual(calls.map(call => call.runOptions.hermesAcpAvailable), [true, true])
  assert.equal(typeof calls[0].runOptions.acpPersistenceKey, 'string')
  assert.equal(calls[0].runOptions.acpPersistenceKey.length > 0, true)
  assert.equal(calls[1].runOptions.acpPersistenceKey, calls[0].runOptions.acpPersistenceKey)
})

test('direct Pi conversations reuse the native JSON session across messages', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.detectAgents = async () => [{
    kind: 'pi', name: 'Pi Agent', executable: '/tmp/pi', version: '0.84.2',
  }]
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    const sessionRef = runOptions.sessionRef || 'pi-json-session'
    await runOptions.onSessionRef(sessionRef)
    return { text: `pi reply ${calls.length}`, sessionRef, outcome: 'completed' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Pi direct', agentKinds: ['pi'], workdir: directory,
    conversationType: 'direct', directAgentKind: 'pi',
  })

  await workspace.sendMessage({ groupId: group.id, text: 'first' })
  await workspace.sendMessage({ groupId: group.id, text: 'second' })

  assert.deepEqual(calls.map(call => call.agent.kind), ['pi', 'pi'])
  assert.deepEqual(calls.map(call => call.runOptions.sessionRef), ['', 'pi-json-session'])
  assert.deepEqual(calls.map(call => call.runOptions.sessionTransport), ['', ''])
})

test('direct conversations do not rotate their session after the default turn budget', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.detectAgents = async () => [{
    kind: 'pi', name: 'Pi Agent', executable: '/tmp/pi', version: '0.84.2',
  }]
  options.runAgent = async (_agent, prompt, _workdir, runOptions) => {
    calls.push({ prompt, runOptions })
    const sessionRef = runOptions.sessionRef || 'pi-long-session'
    await runOptions.onSessionRef(sessionRef)
    return { text: 'reply', sessionRef, outcome: 'completed' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Long direct', agentKinds: ['pi'], directAgentKind: 'pi',
    conversationType: 'direct', workdir: directory,
  })
  for (let index = 0; index < 20; index += 1) {
    await workspace.sendMessage({ groupId: group.id, text: `message-${index}` })
  }
  assert.equal(calls.length, 20)
  assert.equal(calls.filter(call => call.runOptions.sessionRef === '').length, 1)
  assert.equal(calls.slice(1).every(call => call.runOptions.sessionRef === 'pi-long-session'), true)
})

test('group conversations dispatch Pi alongside other available Agents', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.detectAgents = async () => [
    { kind: 'pi', name: 'Pi Agent', executable: '/tmp/pi', version: '0.84.2' },
    { kind: 'codex', name: 'Codex', executable: '/tmp/codex', version: '0.144.0' },
  ]
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    const sessionRef = runOptions.sessionRef || `${agent.kind}-session`
    await runOptions.onSessionRef(sessionRef)
    return { text: `${agent.kind} reply`, sessionRef, outcome: 'completed' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Pi group', agentKinds: ['pi', 'codex'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id, text: 'ask the group', targetKinds: ['pi', 'codex'],
  })

  assert.deepEqual(calls.map(call => call.agent.kind).sort(), ['codex', 'pi'])
  const messages = workspace.snapshot().messages.filter(item => item.role === 'agent')
  assert.deepEqual(messages.map(item => item.agentKind).sort(), ['codex', 'pi'])
})

test('group OpenCode conversations reuse one persistent ACP runtime key across rounds', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.detectAgents = async () => [
    { kind: 'codex', name: 'Codex CLI', executable: '/tmp/codex', version: '1' },
    { kind: 'opencode', name: 'OpenCode CLI', executable: '/tmp/opencode', version: '1' },
  ]
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    const sessionRef = runOptions.sessionRef || `${agent.kind}-acp-session`
    if (agent.kind === 'opencode') {
      await runOptions.onSessionRef(sessionRef, { transport: 'acp' })
    }
    return { text: `reply ${calls.length}`, sessionRef, outcome: 'completed' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'OpenCode ACP group', agentKinds: ['codex', 'opencode'], workdir: directory,
  })

  await workspace.sendMessage({ groupId: group.id, text: 'first', mode: 'auto', maxRounds: 2 })
  await workspace.activeRuns.get(group.id)?.promise

  const opencodeCalls = calls.filter(call => call.agent.kind === 'opencode')
  assert.deepEqual(opencodeCalls.map(call => call.runOptions.sessionRef), ['', 'opencode-acp-session'])
  assert.deepEqual(opencodeCalls.map(call => call.runOptions.sessionTransport), ['', 'acp'])
  assert.equal(typeof opencodeCalls[0].runOptions.acpPersistenceKey, 'string')
  assert.equal(opencodeCalls[1].runOptions.acpPersistenceKey, opencodeCalls[0].runOptions.acpPersistenceKey)
})

test('Natural V4 keeps Hermes, OpenCode, and Claude Code on one Session per group task',
  async (t) => {
    const { directory, calls, options } = fixture()
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    options.naturalAgentResponses = true
    options.detectAgents = async () => [
      {
        kind: 'hermes', name: 'Hermes CLI', executable: '/tmp/hermes', version: '2',
        acpAvailable: true,
      },
      { kind: 'opencode', name: 'OpenCode CLI', executable: '/tmp/opencode', version: '1' },
      { kind: 'claude', name: 'Claude Code', executable: '/tmp/claude', version: '1' },
    ]
    options.runAgent = async (agent, prompt, workdir, runOptions) => {
      calls.push({ agent, prompt, workdir, runOptions })
      const sessionRef = runOptions.sessionRef || `${agent.kind}-native-session`
      if (['hermes', 'opencode'].includes(agent.kind)) {
        await runOptions.onSessionRef(sessionRef, { transport: 'acp' })
      }
      const taskDecision = agent.kind === 'hermes' ? `\n[[MELDWORK_COLLABORATION:${JSON.stringify({
        summary: 'Continue the session-continuity exercise.',
        taskDecision: {
          status: 'continue', reason: 'Continue the requested rounds until the configured round budget is reached.',
          deliverables: [],
        },
      })}]]` : ''
      return { text: `${agent.kind} round response${taskDecision}`, sessionRef, outcome: 'completed' }
    }

    const workspace = new LocalWorkspace(options)
    await workspace.refreshAgents()
    const group = workspace.createGroup({
      name: 'Native Session continuity',
      agentKinds: ['hermes', 'opencode', 'claude'],
      workdir: directory,
    })

    await workspace.sendMessage({
      groupId: group.id,
      text: 'Continue one shared task for three rounds.',
      mode: 'auto',
      discussionStyle: 'sequential',
      targetKinds: group.agentKinds,
      maxRounds: 3,
      protocol: 'v4',
    })
    const controller = workspace.activeRuns.get(group.id)
    assert.ok(controller)
    await controller.promise

    for (const kind of group.agentKinds) {
      const agentCalls = calls.filter(call => call.agent.kind === kind)
      assert.deepEqual(agentCalls.map(call => call.runOptions.sessionRef), [
        '', `${kind}-native-session`, `${kind}-native-session`,
      ])
      assert.equal(typeof agentCalls[0].runOptions.acpPersistenceKey, 'string')
      assert.equal(agentCalls[0].runOptions.acpPersistenceKey.length > 0, true)
      assert.equal(agentCalls.every(call => (
        call.runOptions.acpPersistenceKey === agentCalls[0].runOptions.acpPersistenceKey
      )), true)
    }
    assert.deepEqual(
      calls.filter(call => call.agent.kind === 'hermes')
        .map(call => call.runOptions.sessionTransport),
      ['', 'acp', 'acp'],
    )
    assert.deepEqual(
      calls.filter(call => call.agent.kind === 'opencode')
        .map(call => call.runOptions.sessionTransport),
      ['', 'acp', 'acp'],
    )
  })

test('Workspace stream bridge redacts split credentials and paths while preserving tools', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const credential = 'workspace-stream-secret-value'
  const privatePath = '/Users/private/workspace/result.txt'
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    const runtimeEvents = createRuntimeEventEmitter(
      { onEvent: runOptions.onEvent },
      { WORKSPACE_STREAM_API_KEY: credential },
    )
    runtimeEvents.emit({
      type: 'answer_delta', status: 'running', delta: 'Credential workspace-stream-sec',
    })
    runtimeEvents.emit({
      type: 'answer_delta', status: 'running',
      delta: 'ret-value stored at /Users/private/work',
    })
    runtimeEvents.emit({
      type: 'answer_delta', status: 'running', delta: 'space/result.txt ready',
    })
    runtimeEvents.emit({
      id: 'workspace-tool', type: 'tool_start', status: 'running', title: 'Inspect',
      summary: `credential=${credential}`, detail: `Opening ${privatePath}`,
    })
    runtimeEvents.emit({
      id: 'workspace-tool', type: 'tool_update', status: 'running', title: 'Inspect',
      summary: `Reading ${privatePath}`,
    })
    runtimeEvents.emit({
      id: 'workspace-tool', type: 'tool_result_summary', status: 'completed', title: 'Inspect',
      summary: 'Inspection complete', detail: `credential=${credential}\nSaved ${privatePath}`,
    })
    runtimeEvents.emitFinalAnswer(
      `Credential ${credential} stored at ${privatePath} ready`,
    )
    return { text: 'Streaming review complete', sessionRef: 'codex-session', outcome: 'completed' }
  }
  const liveEvents = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-event', event => liveEvents.push(event))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Native stream bridge', agentKinds: ['codex'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id, text: 'Inspect the streamed output', targetKinds: ['codex'],
  })

  const streamed = liveEvents.filter(event => event.type === 'answer_delta')
    .reduce(
      (answer, event) => event.replace === true ? event.delta : answer + event.delta,
      '',
    )
  assert.equal(streamed, 'Credential [redacted] stored at [path] ready')
  assert.deepEqual(
    liveEvents.filter(event => event.id === 'workspace-tool').map(event => event.type),
    ['tool_start', 'tool_update', 'tool_result_summary'],
  )
  const message = workspace.snapshot().messages.find(item => item.role === 'agent')
  const traceTools = message.trace.events.filter(event => event.type.startsWith('tool_'))
  assert.deepEqual(
    traceTools.map(event => event.type),
    ['tool_result_summary'],
  )
  assert.equal(traceTools.every(event => /^E-R0-CODEX-\d{2}$/.test(event.evidenceId)), true)
  const exposed = JSON.stringify({ liveEvents, trace: message.trace })
  assert.doesNotMatch(exposed, /workspace-stream-secret-value|\/Users\/private\/workspace/)
  assert.match(exposed, /\[redacted\]/)
  assert.match(exposed, /\[path\]/)
})

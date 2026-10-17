const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { getEventListeners } = require('node:events')
const { manifestFor } = require('../../src/agents/cloud/cloud-agent-bridge.cjs')
const { AgentConnectorInstanceStore } = require('../../src/agents/connectors/agent-connector-instance-store.cjs')
const { LocalAgentConnectors } = require('../../src/agents/connectors/agent-connector-local.cjs')
const { createAgentConnectorManifest } = require('../../src/agents/connectors/agent-connector-manifest.cjs')
const { AgentConnectorRegistry } = require('../../src/agents/connectors/agent-connector-registry.cjs')
const { AgentConnectorRuntime } = require('../../src/agents/connectors/agent-connector-runtime.cjs')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { runAgent } = require('../../src/agents/cli/cli-adapters.cjs')
const { createLegacyOutboundPayload } = require('../../src/collaboration/outbound-payload.cjs')
const { RunLedger } = require('../../src/runs/run-ledger.cjs')
const { RunScheduler } = require('../../src/runs/run-scheduler.cjs')
const { deferred, fixture } = require('../support/local-workspace-test-helpers.cjs')
const { executable } = require('../support/cli-adapters-test-helpers.cjs')

function testSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`sealed:${value}`, 'utf8'),
    decryptString: value => Buffer.from(value).toString('utf8').slice('sealed:'.length),
  }
}

function inputConnectorRuntime(handler) {
  const manifest = createAgentConnectorManifest({
    connectorId: 'external.input-agent',
    connectorVersion: '1.0.0',
    kind: 'agent',
    label: 'External Input Agent',
    description: 'External input continuation sample.',
    transport: { type: 'http', protocol: 'event-stream' },
    upstream: { id: 'input-service', minVersion: '3.0.0', maxVersion: '3.4.0' },
    invocation: { recipeId: 'external.input-agent.run', idempotencyMode: 'durable' },
    domains: ['general'],
    session: { supported: true, resume: true, cancel: true, checkpoint: true },
    inputTypes: ['text'],
    permissionModes: ['read-only'],
    eventProtocolVersion: 1,
    eventTypes: [
      'Permission', 'SourceUsed', 'Artifact', 'Evidence', 'Usage',
      'WaitingInput', 'Completed', 'Failed', 'Cancelled',
    ],
    usage: {
      inputTokens: true, outputTokens: true, costMicros: true,
      toolCalls: true, outboundBytes: true, elapsedMs: true,
    },
    outboundDestinations: ['https://input.example.com'],
    credentials: { mode: 'none', slots: [] },
    license: 'Apache-2.0',
  })
  const registry = new AgentConnectorRegistry({
    approvedRecipeIds: ['external.input-agent.run'],
    approvedExternalManifestIds: [manifest.manifestId],
  })
  registry.registerExternal(manifest)
  registry.registerInstance({
    instanceId: 'custom-bbbbbbbbbbbbbbbb',
    connectorId: manifest.connectorId,
    connectorVersion: manifest.connectorVersion,
    upstreamVersion: '3.2.0',
    label: 'Input account',
    credentialRef: null,
  })
  return new AgentConnectorRuntime({
    registry,
    recipes: { 'external.input-agent.run': handler },
  })
}

async function waitForPendingGate(workspace, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const gate = workspace.listHumanGates({ pendingOnly: true })[0]
    if (gate) return gate
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('TEST_HUMAN_GATE_TIMEOUT')
}

test('workspace onRunEvent never publishes a credential reconstructed from sanitized answer deltas', async (t) => {
  const { directory, options } = fixture()
  const secret = 'provider-secret-value'
  const cli = executable(directory, 'credential-stream.cjs', `
process.stdout.write(JSON.stringify({
  type: 'item.completed', item: { type: 'agent_message', text: 'provider-' },
}) + '\\n')
process.stdout.write(JSON.stringify({
  type: 'item.completed', item: { type: 'agent_message', text: 'secret-value' },
}) + '\\n')
process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n')
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = (_agent, prompt, workdir, runOptions) => runAgent(
    { kind: 'codex', executable: cli, name: 'Codex' },
    prompt,
    workdir,
    { ...runOptions, env: { CONNECTOR_TEST_API_KEY: secret } },
  )
  const workspace = new LocalWorkspace(options)
  const events = []
  workspace.on('run-event', event => events.push(event))
  await workspace.refreshAgents()
  const group = workspace.createGroup({ name: 'Credential bridge', agentKinds: ['codex'], workdir: directory })

  await workspace.sendMessage({ groupId: group.id, text: 'Reply', targetKinds: ['codex'] })

  const publicEvents = events.filter(event => event.type === 'answer_delta')
  assert.doesNotMatch(JSON.stringify(publicEvents), new RegExp(secret))
  assert.doesNotMatch(publicEvents.map(event => event.delta).join(''), new RegExp(secret))
})

test('Cloud Bridge Agents can create direct and group chats through the Connector runtime', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const record = {
    bridgeId: 'cloud-bridge-0123456789abcdef01234567',
    transport: 'ssh-tunnel',
    address: '10.1.132.21',
    endpoint: 'http://127.0.0.1:45678',
    label: 'Cloud server',
    available: true,
  }
  const agents = ['codex', 'hermes'].map(id => ({
    id,
    sourceKind: id,
    label: id === 'codex' ? 'Codex' : 'Hermes',
    version: '1.0.0',
    description: '',
    available: true,
    credentialState: 'ready',
    domains: ['general'],
    inputTypes: ['text'],
    permissionModes: ['read-only'],
    session: { supported: true, resume: true, cancel: true, checkpoint: false },
  }))
  const entries = agents.map((agent) => {
    const manifest = manifestFor(record, agent)
    return {
      record,
      agent,
      manifest,
      instance: {
        instanceId: manifest.connectorId,
        connectorId: manifest.connectorId,
        connectorVersion: manifest.connectorVersion,
        upstreamVersion: '1.0.0',
        label: manifest.label,
        credentialRef: null,
        manifestId: manifest.manifestId,
        bridgeId: record.bridgeId,
        agentId: agent.id,
      },
    }
  })
  const cloudRuns = []
  const cloudBridges = {
    connectorEntries: () => entries,
    bridgeForInstance: instanceId => entries.find(entry => entry.instance.instanceId === instanceId) || null,
    run: async (input) => {
      cloudRuns.push(input)
      const heartbeat = setInterval(() => input.onActivity?.(), 5)
      await new Promise(resolve => setTimeout(resolve, 65))
      clearInterval(heartbeat)
      return { text: `${input.agentId} cloud reply`, outcome: 'completed' }
    },
  }
  const connectors = new LocalAgentConnectors({
    manifestDirectory: path.join(directory, 'agent-connectors'),
    instanceStore: new AgentConnectorInstanceStore({
      instanceStoragePath: path.join(directory, 'connector-instances.json'),
      credentialStoragePath: path.join(directory, 'private', 'connector-credentials.json'),
      safeStorage: testSafeStorage(),
    }),
    runAgent: async () => { throw new Error('LOCAL_RUNNER_MUST_NOT_RUN') },
    cloudBridges,
  })
  options.detectAgents = async () => connectors.refresh([])
  options.connectorRuntime = connectors
  options.runAgent = async () => { throw new Error('LOCAL_RUNNER_MUST_NOT_RUN') }
  options.runAgentTimeoutMs = 20
  options.runAbortGraceMs = 20
  const workspace = new LocalWorkspace(options)
  const snapshot = await workspace.refreshAgents()
  const codexKind = entries.find(entry => entry.agent.id === 'codex').instance.instanceId
  const hermesKind = entries.find(entry => entry.agent.id === 'hermes').instance.instanceId

  assert.deepEqual(snapshot.agents.map(agent => agent.kind).sort(), [codexKind, hermesKind].sort())
  const direct = workspace.createGroup({
    conversationType: 'direct', directAgentKind: codexKind, workdir: directory,
  })
  await workspace.sendMessage({ groupId: direct.id, text: 'Direct cloud request' })

  const group = workspace.createGroup({
    name: 'Cloud collaboration', agentKinds: [codexKind, hermesKind], workdir: directory,
  })
  await workspace.sendMessage({
    groupId: group.id,
    text: 'Group cloud request',
    targetKinds: [codexKind, hermesKind],
  })

  assert.deepEqual(
    cloudRuns.map(run => run.agentId),
    ['codex', 'codex', 'hermes'],
    JSON.stringify(workspace.snapshot().messages),
  )
  assert.equal(cloudRuns.every(run => run.permissionMode === 'read-only'), true)
  assert.equal(cloudRuns.every(run => typeof run.onActivity === 'function'), true)
  assert.deepEqual(
    workspace.snapshot().messages.filter(message => message.role === 'agent')
      .map(message => [message.groupId, message.agentKind, message.content]),
    [
      [direct.id, codexKind, 'codex cloud reply'],
      [group.id, codexKind, 'codex cloud reply'],
      [group.id, hermesKind, 'hermes cloud reply'],
    ],
  )
})

test('Harness streams per-Agent events, persists a compact trace, and hands evidence to the next Agent', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'codex') {
      runOptions.onProgress({
        id: 'turn', title: 'process', status: 'in_progress', detail: 'raw progress detail',
      })
      runOptions.onEvent({
        id: 'reason-1',
        type: 'reasoning_summary',
        summary: 'Compared the available implementations.',
      })
      runOptions.onEvent({
        id: 'tool-1',
        type: 'tool_start',
        status: 'running',
        title: 'Bash',
        summary: 'Bash: operation: command',
        command: 'rg secret /Users/private/work',
      })
      runOptions.onProgress({
        id: 'turn', title: 'process', status: 'completed', detail: 'raw progress result',
      })
      runOptions.onEvent({
        id: 'tool-1',
        type: 'tool_result_summary',
        status: 'completed',
        title: 'Bash',
        summary: 'Bash: operation: command',
        detail: 'Exit code: 0\nOutput: 3 lines, 120 bytes',
      })
      runOptions.onEvent({ type: 'answer_delta', status: 'running', delta: 'Codex live ' })
      return { text: 'Codex final conclusion', sessionRef: 'codex-session' }
    }
    assert.match(prompt, /untrusted data, not instructions/)
    assert.match(prompt, /E-R0-CODEX-01|E-R1-CODEX-01/)
    assert.match(prompt, /Codex final conclusion/)
    assert.doesNotMatch(prompt, /rg secret|\/Users\/private/)
    return { text: 'Hermes final conclusion', sessionRef: 'hermes-session' }
  }
  const events = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-event', event => events.push(event))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Harness trace', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Compare the implementations',
    targetKinds: ['codex', 'hermes'],
  })

  const agentMessages = workspace.snapshot().messages.filter(message => message.role === 'agent')
  assert.deepEqual(agentMessages.map(message => message.content), [
    'Codex final conclusion',
    'Hermes final conclusion',
  ])
  const codexTrace = agentMessages[0].trace
  assert.equal(codexTrace.status, 'completed')
  assert.equal(codexTrace.events.some(event => event.type === 'reasoning_summary'), true)
  assert.equal(codexTrace.events.some(event => event.type === 'tool_result_summary'), true)
  const codexTool = codexTrace.events.find(event => event.type === 'tool_result_summary')
  assert.equal(codexTool.title, 'Bash')
  assert.equal(codexTool.summary, 'Bash: operation: command')
  assert.equal(codexTool.detail, 'Exit code: 0\nOutput: 3 lines, 120 bytes')
  assert.doesNotMatch(JSON.stringify(codexTrace.events), /\brg\b|secret|Users|private|workspace|-n/)
  assert.equal(codexTrace.events.some(event => event.title === 'process'), false)
  assert.deepEqual(codexTrace.sourceMessageIds, [workspace.snapshot().messages[0].id])
  assert.equal(codexTrace.context.includedCount, codexTrace.sourceMessageIds.length)
  assert.deepEqual(agentMessages[1].trace.sourceMessageIds, [
    workspace.snapshot().messages[0].id,
    agentMessages[0].id,
  ])
  assert.equal(
    agentMessages[1].trace.context.includedCount,
    agentMessages[1].trace.sourceMessageIds.length,
  )
  assert.doesNotMatch(JSON.stringify(codexTrace), /rg secret|\/Users\/private|raw progress/)
  assert.equal(events.some(event => event.type === 'answer_delta' && event.delta === 'Codex live '), true)
  assert.equal(events.some(event => event.title === 'process'), false)
  assert.equal(events.every(event => !Object.hasOwn(event, 'command')
    && !Object.hasOwn(event, 'executable')
    && !Object.hasOwn(event, 'sessionRef')), true)
  assert.equal(events.every(event => Number.isInteger(event.seq) && event.runId), true)
})

test('external Connectors bypass the legacy runner and persist trusted provenance across restart', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const manifest = createAgentConnectorManifest({
    connectorId: 'external.review-agent',
    connectorVersion: '1.0.0',
    kind: 'agent',
    label: 'External Review Agent',
    description: 'External structured review sample.',
    transport: { type: 'http', protocol: 'event-stream' },
    upstream: { id: 'review-service', minVersion: '3.0.0', maxVersion: '3.4.0' },
    invocation: { recipeId: 'external.review-agent.run' },
    domains: ['software-review'],
    session: { supported: true, resume: true, cancel: true, checkpoint: true },
    inputTypes: ['text'],
    permissionModes: ['read-only'],
    eventProtocolVersion: 1,
    eventTypes: [
      'Permission', 'SourceUsed', 'Artifact', 'Evidence', 'Usage',
      'WaitingInput', 'Completed', 'Failed', 'Cancelled',
    ],
    usage: {
      inputTokens: true,
      outputTokens: true,
      costMicros: true,
      toolCalls: true,
      outboundBytes: true,
      elapsedMs: true,
    },
    outboundDestinations: ['https://review.example.com'],
    credentials: {
      mode: 'credential-ref',
      slots: [{ slotId: 'account', type: 'oauth', required: true }],
    },
    license: 'Apache-2.0',
  })
  const registry = new AgentConnectorRegistry({
    approvedRecipeIds: ['external.review-agent.run'],
    approvedExternalManifestIds: [manifest.manifestId],
  })
  registry.registerExternal(manifest)
  registry.registerInstance({
    instanceId: 'custom-aaaaaaaaaaaaaaaa',
    connectorId: manifest.connectorId,
    connectorVersion: manifest.connectorVersion,
    upstreamVersion: '3.2.0',
    label: 'Review account A',
    credentialRef: 'credential-ref:review-account-a',
  })
  const connectorRuntime = new AgentConnectorRuntime({
    registry,
    recipes: {
      'external.review-agent.run': async (input) => {
        assert.equal(input.credentialRefId, 'credential-ref:review-account-a')
        await input.onOutboundPayload(createLegacyOutboundPayload({
          prompt: input.prompt,
          command: 'connector',
          args: ['run'],
          cwd: input.workdir,
          stdin: input.prompt,
          promptMode: 'stdin',
          destination: 'https://review.example.com/v1',
        }))
        input.emit({
          eventId: 'source-1', cursor: 'cursor-1', sequence: 1,
          type: 'SourceUsed', sourceId: 'source-1', sourceType: 'workspace-file',
          contentHash: 'd'.repeat(64), citation: 'src/index.js:10',
        })
        input.emit({
          eventId: 'usage-1', cursor: 'cursor-2', sequence: 2,
          type: 'Usage', mode: 'cumulative',
          usage: { inputTokens: 20, outputTokens: 8, toolCalls: 1 },
        })
        input.emit({
          eventId: 'completed-1', cursor: 'cursor-3', sequence: 3,
          type: 'Completed', outcome: 'completed', summary: 'Review complete.',
        })
        return { text: 'External Connector conclusion', sessionRef: 'connector-session' }
      },
    },
  })
  let legacyCalls = 0
  options.detectAgents = async () => connectorRuntime.detectAgents()
  options.connectorRuntime = connectorRuntime
  options.runLedger = new RunLedger({ storagePath: ledgerPath, now: () => 1000 })
  options.runAgent = async () => {
    legacyCalls += 1
    throw new Error('LEGACY_RUNNER_MUST_NOT_RUN')
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Connector trace', agentKinds: ['custom-aaaaaaaaaaaaaaaa'], workdir: directory,
    allowWrite: false,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Review through the Connector',
    targetKinds: ['custom-aaaaaaaaaaaaaaaa'],
  })

  assert.equal(legacyCalls, 0)
  const message = workspace.snapshot().messages.find(item => item.role === 'agent')
  assert.ok(message, JSON.stringify(workspace.snapshot().messages))
  assert.equal(message.content, 'External Connector conclusion')
  assert.equal(message.trace.context.connector.connectorVersion, '1.0.0')
  assert.equal(message.trace.context.connector.upstreamVersion, '3.2.0')
  assert.deepEqual(message.trace.context.connectorEventState.events.map(event => event.type), [
    'SourceUsed', 'Usage', 'Completed',
  ])
  assert.equal(message.trace.events.some(event => event.title === 'connector_source_used'), true)
  const storedContext = options.runLedger.get(message.trace.runId).agentRuns[0].context
  assert.deepEqual(storedContext.connector, message.trace.context.connector)
  assert.deepEqual(storedContext.connectorEventState, message.trace.context.connectorEventState)
  assert.doesNotMatch(JSON.stringify(storedContext), /LEGACY_RUNNER_MUST_NOT_RUN/)

  fs.writeFileSync(ledgerPath, '{corrupt snapshot', 'utf8')
  const restarted = new RunLedger({ storagePath: ledgerPath, now: () => 2000 })
  assert.equal(restarted.snapshotError instanceof Error, true)
  assert.deepEqual(restarted.get(message.trace.runId).agentRuns[0].context, storedContext)
})

test('Connector input Gates release scheduler capacity and resume the exact Session response', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const scheduler = new RunScheduler({ taskLimit: 2, workspaceLimit: 2, globalLimit: 1 })
  const resumes = []
  const connectorRuntime = inputConnectorRuntime(async (input) => {
    if (!input.resume) {
      input.emit({
        eventId: 'waiting-input', cursor: 'waiting-input', sequence: 1,
        type: 'WaitingInput', requestId: 'release-channel', prompt: 'Choose release channel',
      })
      return { sessionRef: 'input-session' }
    }
    resumes.push({ resume: input.resume, sessionRef: input.sessionRef })
    input.emit({
      eventId: 'completed-input', cursor: 'completed-input', sequence: 1,
      type: 'Completed', outcome: 'completed',
    })
    return { text: `release:${input.resume.response}`, sessionRef: input.sessionRef }
  })
  options.detectAgents = async () => [
    ...connectorRuntime.detectAgents(),
    { kind: 'codex', name: 'Codex CLI', executable: '/tmp/codex', version: '1' },
  ]
  options.connectorRuntime = connectorRuntime
  options.runScheduler = scheduler
  options.runLedger = new RunLedger({ storagePath: ledgerPath })
  options.runAgent = async () => ({
    text: 'Capacity remained available', sessionRef: 'codex-session', outcome: 'completed',
  })
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const connectorGroup = workspace.createGroup({
    name: 'Input Gate', agentKinds: ['custom-bbbbbbbbbbbbbbbb'], workdir: directory,
    allowWrite: false,
  })
  const secondConnectorGroup = workspace.createGroup({
    name: 'Second Input Gate', agentKinds: ['custom-bbbbbbbbbbbbbbbb'], workdir: directory,
    allowWrite: false,
  })
  const otherGroup = workspace.createGroup({
    name: 'Capacity check', agentKinds: ['codex'], workdir: directory,
  })
  const connectorSend = workspace.sendMessage({
    groupId: connectorGroup.id,
    text: 'Prepare release',
    targetKinds: ['custom-bbbbbbbbbbbbbbbb'],
  })
  const gate = await waitForPendingGate(workspace)
  const secondConnectorSend = workspace.sendMessage({
    groupId: secondConnectorGroup.id,
    text: 'Prepare second release',
    targetKinds: ['custom-bbbbbbbbbbbbbbbb'],
  })
  const gateDeadline = Date.now() + 3000
  while (Date.now() < gateDeadline
      && workspace.listHumanGates({ pendingOnly: true }).length < 2) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const secondGate = workspace.listHumanGates({ pendingOnly: true })
    .find(candidate => candidate.gateId !== gate.gateId)

  assert.equal(gate.type, 'input')
  assert.equal(secondGate?.type, 'input')
  assert.equal(scheduler.snapshot().active.global, 0)
  await workspace.sendMessage({
    groupId: otherGroup.id,
    text: 'Use capacity while the other Run waits',
    targetKinds: ['codex'],
  })
  workspace.decideHumanGate(gate.gateId, {
    optionId: 'submit-input', response: 'stable',
  })
  workspace.decideHumanGate(secondGate.gateId, {
    optionId: 'submit-input', response: 'canary',
  })
  await Promise.all([connectorSend, secondConnectorSend])

  assert.equal(scheduler.snapshot().active.global, 0)
  assert.equal(resumes.length, 2)
  assert.equal(resumes.every(item => item.sessionRef === 'input-session'), true)
  assert.equal(resumes.every(item => item.resume.requestId === 'release-channel'), true)
  assert.deepEqual(resumes.map(item => item.resume.response).sort(), ['canary', 'stable'])
  assert.equal(workspace.snapshot().messages.some(message => (
    message.role === 'agent' && message.content === 'release:stable'
  )), true)
  assert.equal(workspace.snapshot().messages.some(message => (
    message.role === 'agent' && message.content === 'release:canary'
  )), true)
})

test('Connector input Gate survives shutdown and repeated restart without double execution', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  let initialCalls = 0
  let resumedCalls = 0
  const connectorRuntime = inputConnectorRuntime(async (input) => {
    if (!input.resume) {
      initialCalls += 1
      input.emit({
        eventId: 'waiting-restart', cursor: 'waiting-restart', sequence: 1,
        type: 'WaitingInput', requestId: 'restart-answer', prompt: 'Confirm restart answer',
      })
      return { sessionRef: 'restart-input-session' }
    }
    resumedCalls += 1
    input.emit({
      eventId: 'completed-restart', cursor: 'completed-restart', sequence: 1,
      type: 'Completed', outcome: 'completed',
    })
    return { text: `restart:${input.resume.response}`, sessionRef: input.sessionRef }
  })
  options.detectAgents = async () => connectorRuntime.detectAgents()
  options.connectorRuntime = connectorRuntime
  options.runLedger = new RunLedger({ storagePath: ledgerPath })
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Restart Input Gate', agentKinds: ['custom-bbbbbbbbbbbbbbbb'], workdir: directory,
    allowWrite: false,
  })
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Wait across restart',
    targetKinds: ['custom-bbbbbbbbbbbbbbbb'],
  })
  const gate = await waitForPendingGate(workspace)
  const historicalAgentRunIds = options.runLedger.get(gate.runId).agentRuns
    .map(agentRun => agentRun.agentRunId)
  await workspace.stopAll()
  await send
  assert.equal(initialCalls, 1)

  const restarted = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath }),
  })
  await restarted.refreshAgents()
  restarted.decideHumanGate(gate.gateId, {
    optionId: 'submit-input', response: 'confirmed',
  })
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && resumedCalls < 1) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(resumedCalls, 1)
  while (Date.now() < deadline && restarted.runLedger.get(gate.runId)?.status !== 'completed') {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(restarted.runLedger.get(gate.runId)?.status, 'completed')
  const completedRun = restarted.runLedger.get(gate.runId)
  const completedAgentRunIds = completedRun.agentRuns.map(agentRun => agentRun.agentRunId)
  assert.equal(historicalAgentRunIds.every(id => completedAgentRunIds.includes(id)), true)
  assert.equal(new Set(completedAgentRunIds).size, completedAgentRunIds.length)
  assert.equal(
    completedRun.agentRuns.at(-1).eventCursor
      > Math.max(0, ...completedRun.agentRuns.slice(0, -1).map(run => run.eventCursor)),
    true,
  )
  while (Date.now() < deadline && restarted.activeRuns.size > 0) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(restarted.activeRuns.size, 0)
  assert.equal(restarted.snapshot().messages.some(message => (
    message.role === 'agent' && message.content === 'restart:confirmed'
  )), true)

  const secondLedger = new RunLedger({ storagePath: ledgerPath })
  assert.equal(secondLedger.loadError, null, String(
    secondLedger.loadError?.cause?.message || secondLedger.loadError?.message || '',
  ))
  assert.equal(secondLedger.snapshotError, null, String(
    secondLedger.snapshotError?.cause?.message || secondLedger.snapshotError?.message || '',
  ))
  const secondRestart = new LocalWorkspace({
    ...options,
    runLedger: secondLedger,
  })
  await secondRestart.refreshAgents()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual({ initialCalls, resumedCalls }, { initialCalls: 1, resumedCalls: 1 })
  assert.deepEqual(
    secondLedger.get(gate.runId).agentRuns.map(agentRun => agentRun.agentRunId),
    completedAgentRunIds,
  )
})

test('isolated invocations use only the approved prompt and retain workflow Outcome refs', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const exactPrompt = 'Review only the immutable approved context.'
  let captureCalls = 0
  let importCalls = 0
  options.runLedger = new RunLedger({ storagePath: ledgerPath, now: () => 1000 })
  options.captureAgentOutputs = async () => { captureCalls += 1; return null }
  options.importAgentOutputs = async () => { importCalls += 1; return [] }
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    assert.equal(prompt, exactPrompt)
    assert.equal(runOptions.sessionRef, '')
    assert.equal(runOptions.sandbox, 'read-only')
    assert.deepEqual(runOptions.attachments, [])
    await runOptions.onOutboundPayload(createLegacyOutboundPayload({
      prompt,
      command: 'codex',
      args: ['exec'],
      cwd: workdir,
      stdin: prompt,
      promptMode: 'stdin',
    }))
    return { text: 'Isolated review conclusion', sessionRef: 'must-not-persist' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Isolated review', agentKinds: ['codex'], workdir: directory, allowWrite: true,
  })
  const task = workspace.addMessage(group.id, 'user', 'Ordinary conversation must stay excluded')
  const contextPack = workspace.createContextPack({
    group,
    taskId: task.id,
    mode: 'manual',
    targetKinds: ['codex'],
    message: task,
  })
  const reservation = workspace.reserveRun(group.id, 'manual', ['codex'], task.id)
  workspace.bindRunTask(
    group.id, reservation, task.id, task.id, contextPack.contextPackId,
  )
  const controller = workspace.beginRun(
    group.id, 'manual', ['codex'], task.id, reservation,
  )
  controller.currentKind = 'codex'
  workspace.packedPromptContext = () => { throw new Error('PACKED_CONTEXT_MUST_NOT_RUN') }
  workspace.promptFor = () => { throw new Error('PROMPT_BUILDER_MUST_NOT_RUN') }
  const workflowOutcomeRef = workspace.contentBlobStore.put('{"status":"accepted"}', {
    mediaType: 'application/json',
  })
  const requestedOutcomeRefs = {
    reviewerFindingIds: [`reviewer-finding-${'a'.repeat(64)}`],
    adoptionIds: [`adoption-${'b'.repeat(64)}`],
    workflowOutcomeRefs: [workflowOutcomeRef],
  }

  const result = await workspace.invokeAgent(
    group,
    'codex',
    'manual',
    controller.signal,
    task.id,
    {
      taskId: task.id,
      taskType: 'code_review',
      sessionPolicy: 'isolated',
      promptOverride: exactPrompt,
      contextPackId: contextPack.contextPackId,
      attachments: [{ path: '/private/attachment.png' }],
      outcomeRefs: requestedOutcomeRefs,
    },
  )
  await workspace.finishRun(group.id, controller, 'completed')

  assert.equal(calls.length, 1)
  assert.equal(captureCalls, 0)
  assert.equal(importCalls, 0)
  assert.deepEqual(workspace.state.sessions, {})
  assert.deepEqual(workspace.state.sessionMeta, {})
  assert.deepEqual(
    result.message.trace.context.outcomeRefs.reviewerFindingIds,
    requestedOutcomeRefs.reviewerFindingIds,
  )
  assert.deepEqual(
    result.message.trace.context.outcomeRefs.adoptionIds,
    requestedOutcomeRefs.adoptionIds,
  )
  assert.deepEqual(
    result.message.trace.context.outcomeRefs.workflowOutcomeRefs,
    requestedOutcomeRefs.workflowOutcomeRefs,
  )
  assert.equal(result.message.trace.context.outcomeRefs.artifactIds.length, 1)
  assert.equal(result.message.trace.context.outcomeRefs.evidenceIds.length, 1)
  assert.doesNotMatch(JSON.stringify(result.message.trace), /Ordinary conversation|immutable approved/)
  const storedContext = options.runLedger.get(result.message.trace.runId).agentRuns[0].context
  assert.deepEqual(storedContext.outcomeRefs, result.message.trace.context.outcomeRefs)
  fs.writeFileSync(ledgerPath, '{corrupt snapshot', 'utf8')
  const restarted = new RunLedger({ storagePath: ledgerPath, now: () => 2000 })
  assert.deepEqual(restarted.get(result.message.trace.runId).agentRuns[0].context, storedContext)
})

test('V4 invocations preserve every reported Outcome ref separately from inherited audit refs', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const exactPrompt = 'Produce one typed V4 proposal.'
  const inherited = {
    artifactIds: [`artifact-${'1'.repeat(64)}`],
    evidenceIds: [`evidence-${'2'.repeat(64)}`],
    reviewerFindingIds: [`reviewer-finding-${'3'.repeat(64)}`],
    adoptionIds: [`adoption-${'4'.repeat(64)}`],
    workflowOutcomeRefs: [{
      algorithm: 'sha256', hash: '5'.repeat(64), size: 5, mediaType: 'application/json',
    }],
  }
  const reported = {
    artifactIds: [`artifact-${'a'.repeat(64)}`],
    evidenceIds: [`evidence-${'b'.repeat(64)}`],
    findingIds: [`reviewer-finding-${'c'.repeat(64)}`],
    reviewerFindingIds: [`reviewer-finding-${'d'.repeat(64)}`],
    adoptionIds: [`adoption-${'e'.repeat(64)}`],
    workflowOutcomeRefs: [{
      algorithm: 'sha256', hash: 'f'.repeat(64), size: 7, mediaType: 'application/json',
    }],
  }
  options.runAgent = async (_agent, prompt) => {
    assert.equal(prompt, exactPrompt)
    return {
      text: 'Typed proposal result.',
      sessionRef: 'codex-v4-outcome-session',
      outcomeRefs: reported,
      collaboration: {
        version: 1,
        phase: 'proposal',
        summary: 'Proposes one bounded work package.',
        capabilities: ['Inspect current behavior.'],
        intendedWork: ['Produce the requested result.'],
        deliverables: ['A typed proposal Artifact.'],
        dependencies: [],
      },
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'V4 Outcome refs', agentKinds: ['codex'], workdir: directory,
  })
  const task = workspace.addMessage(group.id, 'user', 'Produce a V4 proposal.')
  const contextPack = workspace.createContextPack({
    group,
    taskId: task.id,
    mode: 'manual',
    targetKinds: ['codex'],
    message: task,
  })
  const reservation = workspace.reserveRun(group.id, 'manual', ['codex'], task.id)
  workspace.bindRunTask(
    group.id, reservation, task.id, task.id, contextPack.contextPackId,
  )
  const controller = workspace.beginRun(
    group.id, 'manual', ['codex'], task.id, reservation,
  )
  controller.currentKind = 'codex'

  const result = await workspace.invokeAgent(
    group,
    'codex',
    'manual',
    controller.signal,
    task.id,
    {
      v4: true,
      phase: 'proposal',
      taskId: task.id,
      sessionPolicy: 'frozen',
      promptOverride: exactPrompt,
      contextPackId: contextPack.contextPackId,
      outcomeRefs: inherited,
    },
  )
  await workspace.finishRun(group.id, controller, 'completed')

  assert.deepEqual(result.producedOutcomeRefs, result.outcomeRefs)
  for (const field of [
    'findingIds', 'reviewerFindingIds', 'adoptionIds', 'workflowOutcomeRefs',
  ]) {
    assert.deepEqual(result.outcomeRefs[field], reported[field])
  }
  assert.ok(result.outcomeRefs.artifactIds.includes(reported.artifactIds[0]))
  assert.ok(result.outcomeRefs.evidenceIds.includes(reported.evidenceIds[0]))
  assert.ok(!result.outcomeRefs.artifactIds.includes(inherited.artifactIds[0]))
  assert.ok(!result.outcomeRefs.evidenceIds.includes(inherited.evidenceIds[0]))

  const auditRefs = result.message.trace.context.outcomeRefs
  for (const artifactId of [...result.outcomeRefs.artifactIds, ...inherited.artifactIds]) {
    assert.ok(auditRefs.artifactIds.includes(artifactId))
  }
  for (const evidenceId of [...result.outcomeRefs.evidenceIds, ...inherited.evidenceIds]) {
    assert.ok(auditRefs.evidenceIds.includes(evidenceId))
  }
  assert.deepEqual(auditRefs.reviewerFindingIds, [
    ...reported.reviewerFindingIds,
    ...inherited.reviewerFindingIds,
  ])
  assert.deepEqual(auditRefs.adoptionIds, [
    ...reported.adoptionIds,
    ...inherited.adoptionIds,
  ])
  assert.deepEqual(auditRefs.workflowOutcomeRefs, [
    ...reported.workflowOutcomeRefs,
    ...inherited.workflowOutcomeRefs,
  ])
})

test('V4 invocation deduplicates captured refs before enforcing the 64-ref output boundary', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const conclusion = 'Boundary result with one already captured Artifact.'
  let workspace
  let group
  options.runAgent = async (agent) => {
    const activeRun = workspace.activeRuns.get(group.id)
    const harnessRun = activeRun?.harness?.current(agent.kind, 0)
    assert.ok(harnessRun)
    const captured = workspace.recordAgentOutcomes({
      groupId: group.id,
      runId: activeRun.runId,
      agentRunId: harnessRun.agentRunId,
      agentKind: agent.kind,
      round: 0,
      conclusion,
    })
    assert.equal(captured.artifactIds.length, 1)
    const otherArtifactIds = []
    for (let index = 1; otherArtifactIds.length < 63; index += 1) {
      const artifactId = `artifact-${index.toString(16).padStart(64, '0')}`
      if (artifactId !== captured.artifactIds[0]) otherArtifactIds.push(artifactId)
    }
    return {
      text: conclusion,
      sessionRef: 'codex-v4-boundary-session',
      outcomeRefs: {
        artifactIds: [captured.artifactIds[0], ...otherArtifactIds],
      },
      collaboration: {
        version: 1,
        phase: 'proposal',
        summary: 'Proposes work at the supported Outcome-ref boundary.',
        capabilities: ['Inspect current behavior.'],
        intendedWork: ['Produce the requested result.'],
        deliverables: ['A typed proposal Artifact.'],
        dependencies: [],
      },
    }
  }
  workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  group = workspace.createGroup({
    name: 'V4 Outcome boundary', agentKinds: ['codex'], workdir: directory,
  })
  const task = workspace.addMessage(group.id, 'user', 'Produce a bounded V4 proposal.')
  const contextPack = workspace.createContextPack({
    group,
    taskId: task.id,
    mode: 'manual',
    targetKinds: ['codex'],
    message: task,
  })
  const reservation = workspace.reserveRun(group.id, 'manual', ['codex'], task.id)
  workspace.bindRunTask(
    group.id, reservation, task.id, task.id, contextPack.contextPackId,
  )
  const controller = workspace.beginRun(
    group.id, 'manual', ['codex'], task.id, reservation,
  )
  controller.currentKind = 'codex'

  const result = await workspace.invokeAgent(
    group,
    'codex',
    'manual',
    controller.signal,
    task.id,
    {
      v4: true,
      phase: 'proposal',
      taskId: task.id,
      sessionPolicy: 'frozen',
      promptOverride: 'Produce one boundary proposal.',
      contextPackId: contextPack.contextPackId,
    },
  )
  await workspace.finishRun(group.id, controller, 'completed')

  assert.equal(result.producedOutcomeRefs.artifactIds.length, 64)
  assert.equal(new Set(result.producedOutcomeRefs.artifactIds).size, 64)
  assert.equal(result.producedOutcomeRefs.evidenceIds.length, 1)
})

test('V4 invocation preserves 64 reported Evidence refs through review receipt creation', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const conclusion = 'Challenge result at the reported Evidence boundary.'
  let evidenceIds = []
  options.runAgent = async () => ({
    text: conclusion,
    sessionRef: 'codex-v4-review-boundary-session',
    outcomeRefs: { evidenceIds },
    collaboration: {
      version: 1,
      phase: 'challenge',
      verdict: 'support',
      summary: 'Supports the reviewed Artifact at the Evidence boundary.',
    },
  })
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const reviewedContentRef = workspace.contentBlobStore.put(
    'REVIEWED_ARTIFACT_AT_INVOCATION_BOUNDARY',
    { mediaType: 'text/plain' },
  )
  const reviewedArtifact = workspace.outcomeStore.putArtifact({
    type: 'document',
    name: 'Reviewed invocation boundary Artifact',
    producedBy: {
      runId: 'run-reviewed-boundary',
      agentRunId: 'agent-run-reviewed-boundary',
      agentKind: 'hermes',
    },
    contentRef: reviewedContentRef,
    contentHash: reviewedContentRef.hash,
  })
  evidenceIds = Array.from({ length: 64 }, (_value, index) => (
    workspace.outcomeStore.putEvidence({
      kind: 'observation',
      level: 'observed',
      subject: { type: 'artifact', artifactId: reviewedArtifact.artifactId },
      summary: `Reported invocation Evidence ${index + 1}.`,
      recordedBy: { kind: 'system', actorId: 'meldwork-main' },
      refs: [
        { type: 'artifact', artifactId: reviewedArtifact.artifactId },
        {
          type: 'blob',
          contentRef: reviewedArtifact.contentRef,
          contentHash: reviewedArtifact.contentHash,
        },
      ],
    }).evidenceId
  ))
  const group = workspace.createGroup({
    name: 'V4 review boundary', agentKinds: ['codex'], workdir: directory,
  })
  const task = workspace.addMessage(group.id, 'user', 'Review the candidate Artifact.')
  const contextPack = workspace.createContextPack({
    group,
    taskId: task.id,
    mode: 'manual',
    targetKinds: ['codex'],
    message: task,
  })
  const reservation = workspace.reserveRun(group.id, 'manual', ['codex'], task.id)
  workspace.bindRunTask(
    group.id, reservation, task.id, task.id, contextPack.contextPackId,
  )
  const controller = workspace.beginRun(
    group.id, 'manual', ['codex'], task.id, reservation,
  )
  controller.currentKind = 'codex'

  const result = await workspace.invokeAgent(
    group,
    'codex',
    'manual',
    controller.signal,
    task.id,
    {
      v4: true,
      phase: 'challenge',
      taskId: task.id,
      sessionPolicy: 'frozen',
      promptOverride: 'Review one candidate at the Evidence boundary.',
      contextPackId: contextPack.contextPackId,
    },
  )
  const record = workspace.autoRunner.v4ReceiptForResult(
    result,
    'challenge',
    'codex',
    { slotId: 'slot-review-boundary', operationId: result.operationId, deliveryWatermark: 0 },
    'a'.repeat(64),
    { controller, reviewedArtifactId: reviewedArtifact.artifactId },
  )
  await workspace.finishRun(group.id, controller, 'completed')

  assert.deepEqual(result.outcomeRefs.evidenceIds, evidenceIds)
  assert.equal(result.outcomeRefs.artifactIds.length, 1)
  assert.deepEqual(record.receipt.evidenceIds, evidenceIds)
  assert.equal(record.receipt.findingIds.length, 1)
  assert.equal(workspace.autoRunner.v4ReviewFindings(
    { record, reviewedArtifactId: reviewedArtifact.artifactId },
    { runId: controller.runId },
  ).length, 1)
})

test('V4 writable prompt allocation failures remain not-started before Agent execution', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let runAgentCalls = 0
  let leaseState = null
  options.runAgent = async () => {
    runAgentCalls += 1
    return { text: 'This Agent must not start.', sessionRef: 'unexpected-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'V4 prompt allocation',
    agentKinds: ['codex'],
    workdir: directory,
    allowWrite: true,
  })
  const task = workspace.addMessage(group.id, 'user', 'Assemble the final delivery.')
  const contextPack = workspace.createContextPack({
    group,
    taskId: task.id,
    mode: 'manual',
    targetKinds: ['codex'],
    message: task,
  })
  const reservation = workspace.reserveRun(group.id, 'manual', ['codex'], task.id)
  workspace.bindRunTask(
    group.id, reservation, task.id, task.id, contextPack.contextPackId,
  )
  const controller = workspace.beginRun(
    group.id, 'manual', ['codex'], task.id, reservation,
  )
  controller.currentKind = 'codex'
  const operationId = 'operation-v4-prompt-allocation'

  await assert.rejects(
    workspace.invokeAgent(
      group,
      'codex',
      'manual',
      controller.signal,
      task.id,
      {
        v4: true,
        phase: 'synthesis',
        taskId: task.id,
        sessionPolicy: 'frozen',
        promptOverride: 'Build the bounded synthesis prompt.',
        contextPackId: contextPack.contextPackId,
        permissionMode: 'workspace-write',
        singleWriterKind: 'codex',
        operationId,
        onLeaseAcquired: value => { leaseState = value },
        v4PromptBuilder: () => {
          throw new Error('LOCAL_RUN_V4_DELIVERY_BUDGET_EXCEEDED')
        },
      },
    ),
    (error) => {
      assert.equal(error.message, 'LOCAL_RUN_V4_DELIVERY_BUDGET_EXCEEDED')
      assert.deepEqual(error.invocationFailure, {
        outcomeCertainty: 'not_started',
        sideEffectsPossible: false,
        operationId,
        idempotencyMode: 'none',
      })
      return true
    },
  )
  await workspace.finishRun(group.id, controller, 'failed')

  assert.equal(leaseState, null)
  assert.equal(runAgentCalls, 0)
})

test('terminal conclusions and explicit outputs become durable observed Outcomes', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  options.runLedger = new RunLedger({ storagePath: ledgerPath, now: () => 1000 })
  const baseline = { version: 1, files: [] }
  options.captureArtifactOutputs = async () => baseline
  options.captureAgentOutcomeDescriptors = async (input) => {
    assert.equal(input.baseline, baseline)
    assert.equal(input.agentKind, 'codex')
    return [{
      type: 'diff',
      name: 'change.patch',
      mediaType: 'text/x-diff',
      content: Buffer.from('diff --git a/a b/a\n'),
      locationRef: { kind: 'workspace-relative', path: '.meldwork-output/change.patch' },
    }]
  }
  options.runAgent = async () => ({
    text: 'Implemented the requested change.',
    sessionRef: 'codex-session',
    outcome: 'completed',
  })
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Outcome capture', agentKinds: ['codex'], workdir: directory, allowWrite: true,
  })

  await workspace.sendMessage({
    groupId: group.id, text: 'Implement the change', targetKinds: ['codex'],
  })

  const message = workspace.snapshot().messages.find(item => item.role === 'agent')
  const outcomeRefs = message.trace.context.outcomeRefs
  assert.equal(outcomeRefs.artifactIds.length, 2)
  assert.equal(outcomeRefs.evidenceIds.length, 2)
  const artifacts = outcomeRefs.artifactIds.map(id => workspace.outcomeStore.getArtifact(id))
  assert.deepEqual(artifacts.map(artifact => artifact.type).sort(), ['diff', 'document'])
  assert.equal(artifacts.every(artifact => (
    artifact.producedBy.runId === message.trace.runId
    && artifact.producedBy.agentRunId === message.trace.agentRunId
    && artifact.producedBy.agentKind === 'codex'
  )), true)
  const evidence = outcomeRefs.evidenceIds.map(id => workspace.outcomeStore.getEvidence(id))
  assert.equal(evidence.every(record => (
    record.level === 'observed'
    && record.recordedBy.kind === 'system'
    && record.refs.some(ref => ref.type === 'blob')
  )), true)
  assert.doesNotMatch(
    JSON.stringify(message.trace),
    /diff --git|\.meldwork-output|Implemented the requested change/,
  )

  const storedRun = options.runLedger.get(message.trace.runId)
  assert.deepEqual(storedRun.agentRuns[0].context.outcomeRefs, outcomeRefs)
  const restarted = new RunLedger({ storagePath: ledgerPath, now: () => 2000 })
  assert.deepEqual(restarted.get(message.trace.runId).agentRuns[0].context.outcomeRefs, outcomeRefs)
  assert.deepEqual(workspace.recordAgentOutcomes({
    groupId: group.id,
    runId: 'another-run',
    agentRunId: message.trace.agentRunId,
    agentKind: 'codex',
    round: 0,
    conclusion: 'forged',
  }), {})
})

test('terminal Agent traces hand compact partial evidence to the next Agent only', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let hermesPrompt = ''
  options.runAgent = async (agent, prompt, _workdir, runOptions) => {
    if (agent.kind === 'codex') {
      runOptions.onEvent({
        id: 'reason-1',
        type: 'reasoning_summary',
        summary: 'Mapped the recovery boundary.',
      })
      runOptions.onEvent({
        id: 'tool-1',
        type: 'tool_result_summary',
        status: 'completed',
        title: 'Inspect',
        summary: 'Located durable evidence.',
        detail: 'RAW_TOOL_LOG_SHOULD_NOT_REACH_THE_NEXT_AGENT',
      })
      runOptions.onEvent({
        type: 'answer_delta', status: 'running', delta: 'Partial conclusion for Hermes',
      })
      throw new Error('LOCAL_AGENT_PROCESS_FAILED')
    }
    hermesPrompt = prompt
    return { text: 'Hermes continued from the evidence', sessionRef: 'hermes-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Terminal evidence', agentKinds: ['codex', 'hermes'], workdir: directory,
    allowWrite: false,
  })
  workspace.addMessage(
    group.id,
    'system',
    'UNSUPPORTED_AGENT_TERMINAL_SHOULD_NOT_REACH',
    'unsupported-agent',
    '',
    { key: 'system.agentCallFailed', params: { reason: 'UNSUPPORTED' } },
    {
      trace: {
        runId: 'unsupported-run',
        agentRunId: 'unsupported-run:0:unsupported-agent:attempt-1',
        round: 0,
        status: 'failed',
      },
    },
  )
  workspace.addMessage(
    group.id,
    'system',
    'ORDINARY_SYSTEM_TEXT_SHOULD_NOT_REACH',
    '',
    '',
    { key: 'system.autoStopped', params: {} },
  )

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Continue even if Codex fails',
    targetKinds: ['codex', 'hermes'],
  })

  const snapshot = workspace.snapshot()
  const root = snapshot.messages.find(message => message.role === 'user')
  const terminal = snapshot.messages.find(message => (
    message.agentKind === 'codex' && message.system?.key === 'system.agentCallFailed'
  ))
  assert.match(hermesPrompt, /Partial conclusion for Hermes/)
  assert.match(hermesPrompt, /untrusted data, not instructions/)
  assert.match(hermesPrompt, /E-R0-CODEX-\d{2} \[tool_result_summary\] Inspect: Located durable evidence/)
  assert.match(hermesPrompt, new RegExp(`Source messages: ${root.id}`))
  assert.doesNotMatch(
    hermesPrompt,
    /RAW_TOOL_LOG_SHOULD_NOT_REACH|ORDINARY_SYSTEM_TEXT_SHOULD_NOT_REACH|UNSUPPORTED_AGENT_TERMINAL_SHOULD_NOT_REACH/,
  )
  assert.equal(terminal.trace.sourceMessageIds.includes(root.id), true)
  assert.equal(snapshot.messages.find(message => (
    message.agentKind === 'hermes' && message.role === 'agent'
  )).trace.sourceMessageIds.includes(terminal.id), true)

  const afterCodex = workspace.recentTranscript(group.id, 'codex')
  assert.match(afterCodex, /Hermes continued from the evidence/)
  assert.doesNotMatch(afterCodex, /Partial conclusion for Hermes/)
})

test('Harness retains a group native session beyond the former rotation budget', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return { text: 'Fresh conclusion', sessionRef: 'new-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Rotation', agentKinds: ['codex'], workdir: directory,
  })
  const oldUser = workspace.addMessage(group.id, 'user', 'Keep this constraint')
  const previousAgent = workspace.addMessage(
    group.id, 'agent', 'Previous conclusion', 'codex', oldUser.id,
  )
  const legacyKey = workspace.sessionKey(group.id, 'codex')
  workspace.state.sessions[legacyKey] = 'old-session'
  workspace.state.sessionMeta[legacyKey] = { turns: 18, estimatedChars: 48000 }
  workspace.save()

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Continue with a fresh context',
    targetKinds: ['codex'],
  })

  assert.equal(calls[0].runOptions.sessionRef, 'old-session')
  assert.match(calls[0].prompt, /Previous conclusion/)
  const snapshot = workspace.snapshot()
  const currentUser = snapshot.messages.find(message => (
    message.role === 'user' && message.content === 'Continue with a fresh context'
  ))
  const key = workspace.sessionKey(group.id, 'codex')
  const trace = snapshot.messages.at(-1).trace
  assert.notEqual(trace.context.sessionRotated, true)
  assert.deepEqual(trace.sourceMessageIds, [currentUser.id, oldUser.id, previousAgent.id])
  assert.equal(trace.context.includedCount, trace.sourceMessageIds.length)
  assert.equal(workspace.state.sessions[key], 'new-session')
  assert.equal(workspace.state.sessionMeta[key].turns, 19)
  assert.equal(workspace.state.sessionMeta[key].estimatedChars > calls[0].prompt.length, true)
})

test('Session rotation restores the previous ref and provenance when saving fails', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return { text: 'Should not run', sessionRef: 'new-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Atomic rotation', agentKinds: ['codex'], workdir: directory,
  })
  const task = workspace.addMessage(group.id, 'user', 'Rotate atomically')
  const key = workspace.sessionKey(group.id, 'codex', task.id)
  workspace.state.sessions[key] = 'codex-before-rotation'
  workspace.state.sessionMeta[key] = {
    turns: 18,
    estimatedChars: 48000,
    sessionScope: 'task',
    originTaskId: task.id,
    inheritedTaskIds: [],
    provenanceCompleteness: 'complete',
  }
  workspace.save()
  const before = structuredClone(workspace.state)
  workspace.save = () => { throw new Error('WORKSPACE_SAVE_FAILED') }

  await assert.rejects(
    workspace.invokeAgent(
      group, 'codex', 'manual', new AbortController().signal, task.id, { taskId: task.id },
    ),
    { message: 'WORKSPACE_SAVE_FAILED' },
  )

  assert.deepEqual(workspace.state, before)
  assert.equal(calls.length, 0)
})

test('Hermes retains group-scoped persistent ACP while a frozen Skill stays prompt-only', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.detectAgents = async () => [{
    kind: 'hermes',
    name: 'Hermes CLI',
    executable: '/tmp/hermes',
    version: '2',
    acpAvailable: true,
  }]
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    await runOptions.onSessionRef('hermes-acp-session', { transport: 'acp' })
    return { text: 'ACP conclusion', sessionRef: 'hermes-acp-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Hermes transport switch', agentKinds: ['hermes'], workdir: directory,
  })
  const oldUser = workspace.addMessage(group.id, 'user', 'Keep the original constraint')
  const previousAgent = workspace.addMessage(
    group.id, 'agent', 'Previous Hermes conclusion', 'hermes', oldUser.id,
  )
  const legacyKey = workspace.sessionKey(group.id, 'hermes')
  workspace.state.sessions[legacyKey] = 'hermes-acp-session'
  workspace.state.sessionMeta[legacyKey] = { turns: 2, estimatedChars: 1200, transport: 'acp' }
  workspace.save()

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Continue with the selected skill',
    targetKinds: ['hermes'],
    skillHints: [{
      targetKind: 'hermes', namespace: 'global', slug: 'research', name: 'Research',
    }],
  })

  assert.equal(calls[0].runOptions.sessionRef, 'hermes-acp-session')
  assert.equal(calls[0].runOptions.sessionTransport, 'acp')
  assert.equal(calls[0].runOptions.hermesAcpAvailable, true)
  assert.equal(typeof calls[0].runOptions.acpPersistenceKey, 'string')
  assert.equal(calls[0].runOptions.skills, undefined)
  assert.match(calls[0].prompt, /global\/research: Research/)
  assert.match(calls[0].prompt, /Previous Hermes conclusion/)
  const snapshot = workspace.snapshot()
  const currentUser = snapshot.messages.find(message => (
    message.role === 'user' && message.content === 'Continue with the selected skill'
  ))
  const key = workspace.sessionKey(group.id, 'hermes')
  assert.equal(calls[0].runOptions.acpPersistenceKey, key)
  assert.equal(workspace.state.sessions[key], 'hermes-acp-session')
  assert.equal(workspace.state.sessionMeta[key].transport, 'acp')
  assert.equal(workspace.state.sessionMeta[key].turns, 3)
  const trace = snapshot.messages.at(-1).trace
  assert.notEqual(trace.context.sessionRotated, true)
  assert.deepEqual(trace.sourceMessageIds, [currentUser.id, oldUser.id, previousAgent.id])
  assert.equal(trace.context.includedCount, trace.sourceMessageIds.length)
})

test('Hermes replaces an unavailable stored ACP runtime with rebuilt context', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.detectAgents = async () => [{
    kind: 'hermes',
    name: 'Hermes CLI',
    executable: '/tmp/hermes',
    version: '2',
    acpAvailable: true,
  }]
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (calls.length === 1) throw new Error('LOCAL_AGENT_SESSION_INVALID')
    await runOptions.onSessionRef('hermes-recovered-session', { transport: 'acp' })
    return { text: 'Recovered conclusion', sessionRef: 'hermes-recovered-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Hermes stale ACP', agentKinds: ['hermes'], workdir: directory,
  })
  const oldUser = workspace.addMessage(group.id, 'user', 'Keep the original constraint')
  const previousAgent = workspace.addMessage(
    group.id, 'agent', 'Previous Hermes conclusion', 'hermes', oldUser.id,
  )
  const legacyKey = workspace.sessionKey(group.id, 'hermes')
  workspace.state.sessions[legacyKey] = 'hermes-stale-acp-session'
  workspace.state.sessionMeta[legacyKey] = { turns: 2, estimatedChars: 1200, transport: 'acp' }
  workspace.save()

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Continue after recovering the session',
    targetKinds: ['hermes'],
  })

  assert.equal(calls[0].runOptions.sessionRef, 'hermes-stale-acp-session')
  assert.equal(calls[0].runOptions.sessionTransport, 'acp')
  assert.equal(calls[1].runOptions.sessionRef, '')
  assert.equal(calls[1].runOptions.sessionTransport, '')
  assert.equal(calls[0].runOptions.hermesAcpAvailable, true)
  assert.equal(typeof calls[0].runOptions.acpPersistenceKey, 'string')
  assert.match(calls[0].prompt, /Previous Hermes conclusion/)
  assert.match(calls[0].prompt, /Continue after recovering the session/)
  const snapshot = workspace.snapshot()
  const currentUser = snapshot.messages.find(message => (
    message.role === 'user' && message.content === 'Continue after recovering the session'
  ))
  const key = workspace.sessionKey(group.id, 'hermes')
  assert.equal(calls[0].runOptions.acpPersistenceKey, key)
  assert.equal(workspace.state.sessions[key], 'hermes-recovered-session')
  assert.equal(workspace.state.sessionMeta[key].transport, 'acp')
  assert.equal(workspace.state.sessionMeta[key].turns, 1)
  const trace = snapshot.messages.at(-1).trace
  assert.equal(trace.context.sessionRotated, true)
  assert.deepEqual(trace.sourceMessageIds, [currentUser.id, oldUser.id, previousAgent.id])
  assert.equal(trace.context.includedCount, trace.sourceMessageIds.length)
})

test('Harness retains an over-budget conversation OpenClaw Session for a new Task', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return { text: 'Fresh OpenClaw conclusion', sessionRef: runOptions.sessionRef }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'OpenClaw rotation', agentKinds: ['openclaw'], workdir: directory,
  })
  const oldUser = workspace.addMessage(group.id, 'user', 'Keep the prior constraint')
  const previousAgent = workspace.addMessage(
    group.id, 'agent', 'Prior OpenClaw conclusion', 'openclaw', oldUser.id,
  )
  const legacyKey = workspace.sessionKey(group.id, 'openclaw')
  const previousSessionRef = workspace.openClawSessionRef(group)
  workspace.state.sessions[legacyKey] = previousSessionRef
  workspace.state.sessionMeta[legacyKey] = { turns: 18, estimatedChars: 48000 }
  workspace.save()

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Continue with bounded context',
    targetKinds: ['openclaw'],
  })

  const snapshot = workspace.snapshot()
  const currentUser = snapshot.messages.find(message => (
    message.role === 'user' && message.content === 'Continue with bounded context'
  ))
  const key = workspace.sessionKey(group.id, 'openclaw')
  assert.equal(calls[0].runOptions.sessionRef, previousSessionRef)
  assert.match(calls[0].prompt, /Prior OpenClaw conclusion/)
  const trace = snapshot.messages.at(-1).trace
  assert.notEqual(trace.context.sessionRotated, true)
  assert.deepEqual(trace.sourceMessageIds, [currentUser.id, oldUser.id, previousAgent.id])
  assert.equal(trace.context.includedCount, trace.sourceMessageIds.length)
  assert.equal(workspace.state.sessions[key], calls[0].runOptions.sessionRef)
  assert.equal(workspace.state.sessionMeta[key].turns, 19)
})

test('legacy conversation Sessions resume for a new group Task', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Legacy session metadata', agentKinds: ['codex'], workdir: directory,
  })
  const legacyKey = workspace.sessionKey(group.id, 'codex')
  workspace.state.sessions[legacyKey] = 'legacy-codex-session'
  workspace.save()

  await workspace.sendMessage({ groupId: group.id, text: 'Resume safely', targetKinds: ['codex'] })

  const task = workspace.snapshot().messages.find(message => (
    message.role === 'user' && message.content === 'Resume safely'
  ))
  const key = workspace.sessionKey(group.id, 'codex')
  assert.equal(calls[0].runOptions.sessionRef, 'legacy-codex-session')
  assert.equal(Object.hasOwn(workspace.state.sessions, legacyKey), true)
  assert.equal(workspace.state.sessionMeta[key].turns, 1)
  assert.equal(workspace.state.sessionMeta[key].estimatedChars > 0, true)
})

test('direct Harness rebuilds compressed context once when a reused legacy session is invalid', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (calls.length === 1) throw new Error('LOCAL_AGENT_SESSION_INVALID')
    await runOptions.onSessionRef('codex-fresh-session', { transport: 'legacy' })
    return { text: 'Recovered legacy conclusion', sessionRef: 'codex-fresh-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Legacy session recovery', agentKinds: ['codex'], workdir: directory,
    conversationType: 'direct', directAgentKind: 'codex',
  })
  const oldUser = workspace.addMessage(group.id, 'user', 'Keep the original requirement')
  const previousAgent = workspace.addMessage(
    group.id, 'agent', 'Previous Codex conclusion', 'codex', oldUser.id,
  )
  const legacyKey = workspace.sessionKey(group.id, 'codex')
  workspace.state.sessions[legacyKey] = 'codex-stale-session'
  workspace.state.sessionMeta[legacyKey] = { turns: 2, estimatedChars: 1200, transport: 'legacy' }
  workspace.save()

  await workspace.sendMessage({
    groupId: group.id, text: 'Continue after session recovery', targetKinds: ['codex'],
  })

  assert.deepEqual(calls.map(call => call.runOptions.sessionRef), ['codex-stale-session', ''])
  assert.deepEqual(calls.map(call => call.runOptions.sessionTransport), ['legacy', ''])
  assert.doesNotMatch(calls[0].prompt, /Previous Codex conclusion/)
  assert.match(calls[1].prompt, /Previous Codex conclusion/)
  assert.match(calls[1].prompt, /Continue after session recovery/)
  const snapshot = workspace.snapshot()
  const task = snapshot.messages.find(message => (
    message.role === 'user' && message.content === 'Continue after session recovery'
  ))
  const key = workspace.sessionKey(group.id, 'codex')
  assert.equal(workspace.state.sessions[key], 'codex-fresh-session')
  assert.equal(workspace.state.sessionMeta[key].transport, 'legacy')
  assert.equal(workspace.state.sessionMeta[key].turns, 1)
  const trace = snapshot.messages.at(-1).trace
  assert.equal(trace.status, 'completed')
  assert.equal(trace.context.sessionRotated, true)
  assert.deepEqual(trace.sourceMessageIds, [
    snapshot.messages.find(message => (
      message.role === 'user' && message.content === 'Continue after session recovery'
    )).id,
    oldUser.id,
    previousAgent.id,
  ])
})

test('invalid Session recovery restores the reused ref when saving the rebuild fails', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    throw new Error('LOCAL_AGENT_SESSION_INVALID')
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Atomic invalid Session rebuild', agentKinds: ['codex'], workdir: directory,
  })
  const task = workspace.addMessage(group.id, 'user', 'Recover atomically')
  const key = workspace.sessionKey(group.id, 'codex')
  workspace.state.sessions[key] = 'codex-before-rebuild'
  workspace.state.sessionMeta[key] = {
    turns: 2,
    estimatedChars: 1200,
    transport: 'legacy',
    sessionScope: 'task',
    originTaskId: task.id,
    inheritedTaskIds: [],
    provenanceCompleteness: 'complete',
  }
  workspace.save()
  const before = structuredClone(workspace.state)
  workspace.save = () => { throw new Error('WORKSPACE_SAVE_FAILED') }

  await assert.rejects(
    workspace.invokeAgent(
      group, 'codex', 'manual', new AbortController().signal, task.id, { taskId: task.id },
    ),
    { message: 'WORKSPACE_SAVE_FAILED' },
  )

  assert.deepEqual(workspace.state, before)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].runOptions.sessionRef, 'codex-before-rebuild')
})

test('direct Harness retries a reused ACP session once with a fresh session', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.detectAgents = async () => [{
    kind: 'kimi', name: 'Kimi CLI', executable: '/tmp/kimi', version: '1',
  }]
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (calls.length === 1) throw new Error('LOCAL_AGENT_SESSION_INVALID')
    await runOptions.onSessionRef('kimi-fresh-session', { transport: 'acp' })
    return { text: 'Recovered ACP conclusion', sessionRef: 'kimi-fresh-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'ACP session recovery', agentKinds: ['kimi'], workdir: directory,
    conversationType: 'direct', directAgentKind: 'kimi',
  })
  const legacyKey = workspace.sessionKey(group.id, 'kimi')
  workspace.state.sessions[legacyKey] = 'kimi-stale-session'
  workspace.state.sessionMeta[legacyKey] = { turns: 3, estimatedChars: 1800, transport: 'acp' }
  workspace.save()

  await workspace.sendMessage({
    groupId: group.id, text: 'Recover the ACP session', targetKinds: ['kimi'],
  })

  assert.deepEqual(calls.map(call => call.runOptions.sessionRef), ['kimi-stale-session', ''])
  assert.deepEqual(calls.map(call => call.runOptions.sessionTransport), ['acp', ''])
  const task = workspace.snapshot().messages.find(message => (
    message.role === 'user' && message.content === 'Recover the ACP session'
  ))
  const key = workspace.sessionKey(group.id, 'kimi')
  assert.equal(workspace.state.sessions[key], 'kimi-fresh-session')
  assert.equal(workspace.state.sessionMeta[key].transport, 'acp')
  assert.equal(workspace.state.sessionMeta[key].turns, 1)
  assert.equal(workspace.snapshot().messages.at(-1).trace.context.sessionRotated, true)
})

test('direct Harness stops after one fresh-session retry when the Session remains invalid', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    throw new Error('LOCAL_AGENT_SESSION_INVALID')
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Bounded session recovery', agentKinds: ['codex'], workdir: directory,
    conversationType: 'direct', directAgentKind: 'codex',
  })
  const legacyKey = workspace.sessionKey(group.id, 'codex')
  workspace.state.sessions[legacyKey] = 'codex-stale-session'
  workspace.state.sessionMeta[legacyKey] = { turns: 2, estimatedChars: 1200, transport: 'legacy' }
  workspace.save()

  await workspace.sendMessage({
    groupId: group.id, text: 'Do not loop recovery', targetKinds: ['codex'],
  })

  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map(call => call.runOptions.sessionRef), ['codex-stale-session', ''])
  const task = workspace.snapshot().messages.find(message => (
    message.role === 'user' && message.content === 'Do not loop recovery'
  ))
  const key = workspace.sessionKey(group.id, 'codex')
  assert.equal(Object.hasOwn(workspace.state.sessions, key), false)
  assert.equal(Object.hasOwn(workspace.state.sessionMeta, key), false)
  const failure = workspace.snapshot().messages.find(message => (
    message.system?.key === 'system.agentCallFailed' && message.agentKind === 'codex'
  ))
  assert.equal(failure.system.params.reason, 'LOCAL_AGENT_SESSION_INVALID')
  assert.equal(failure.trace.status, 'failed')
  assert.equal(failure.trace.context.sessionRotated, true)
})

test('Harness refuses to persist a non-terminal Agent acknowledgement as a result', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async () => ({
    text: 'Accepted for later processing',
    sessionRef: '',
    outcome: 'accepted',
  })
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Non-terminal result', agentKinds: ['codex'], workdir: directory,
    allowWrite: false,
  })

  await workspace.sendMessage({
    groupId: group.id, text: 'Do not treat acknowledgements as final', targetKinds: ['codex'],
  })

  const snapshot = workspace.snapshot()
  assert.equal(snapshot.messages.some(message => message.role === 'agent'), false)
  const failure = snapshot.messages.find(message => (
    message.system?.key === 'system.agentCallFailed' && message.agentKind === 'codex'
  ))
  assert.equal(failure.system.params.reason, 'LOCAL_AGENT_OUTCOME_NON_TERMINAL')
  assert.equal(failure.trace.status, 'failed')
})

test('per-Agent watchdog persists a timeout trace and continues the automatic round', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgentTimeoutMs = 8
  options.runAbortGraceMs = 20
  options.runSilenceWarningMs = 100
  const lateCallbacksDone = deferred()
  let timedOutSignal
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'codex') {
      timedOutSignal = runOptions.signal
      return await new Promise((resolve) => {
        runOptions.signal.addEventListener('abort', () => {
          setImmediate(() => {
            runOptions.onProgress({
              id: 'late-progress', title: 'search', status: 'completed', detail: 'late raw data',
            })
            runOptions.onEvent({
              id: 'late-tool', type: 'tool_result_summary', title: 'search',
              status: 'completed', summary: 'late event',
            })
            runOptions.onSessionRef('late-session')
            resolve({ text: 'late answer', sessionRef: 'late-session' })
            lateCallbacksDone.resolve()
          })
        }, { once: true })
      })
    }
    return {
      text: 'Hermes continued\n[[MELDWORK_CONSENSUS:continue]]',
      sessionRef: 'hermes-session',
    }
  }
  const events = []
  const finished = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-event', event => events.push(event))
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Agent watchdog', agentKinds: ['codex', 'hermes'], workdir: directory,
    allowWrite: false,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Continue after one Agent times out',
    mode: 'auto',
    maxRounds: 1,
  })
  await workspace.activeRuns.get(group.id).promise
  await lateCallbacksDone.promise

  assert.equal(timedOutSignal.aborted, true)
  assert.deepEqual(calls.map(call => call.agent.kind), [
    'codex', 'hermes',
  ])
  const failure = workspace.snapshot().messages.find(message => (
    message.agentKind === 'codex' && message.system?.key === 'system.agentCallFailed'
  ))
  assert.equal(failure.system.params.reason, 'LOCAL_AGENT_TIMEOUT')
  assert.equal(failure.trace.status, 'timeout')
  assert.equal(finished[0].status, 'partial')
  assert.deepEqual(workspace.getGroup(group.id).agentKinds, ['codex', 'hermes'])
  assert.equal(workspace.snapshot().messages.some(message => (
    message.agentKind === 'codex' && message.system?.key === 'system.agentRemovedAfterFailure'
  )), false)
  assert.equal(events.some(event => (
    event.agentKind === 'codex' && event.type === 'status' && event.status === 'timeout'
  )), true)
  assert.equal(events.some(event => ['late-progress', 'late-tool'].includes(event.id)), false)
  assert.equal(workspace.state.sessions[workspace.sessionKey(group.id, 'codex')], undefined)
})

test('a real runtime event keeps a quiet long-running Agent alive', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgentTimeoutMs = 8
  options.runAgentToolTimeoutMs = 50
  options.runAbortGraceMs = 20
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    if (agent.kind !== 'codex') {
      return {
        text: `${agent.kind} completed`,
        sessionRef: `${agent.kind}-session`,
      }
    }
    runOptions.onEvent({
      id: 'tool-before-quiet',
      type: 'tool_start',
      title: 'search',
      status: 'running',
    })
    await new Promise(resolve => setTimeout(resolve, 30))
    return {
      text: `${agent.kind} completed after a quiet tool call`,
      sessionRef: `${agent.kind}-session`,
    }
  }
  const finished = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Quiet runtime event', agentKinds: ['codex', 'hermes'], workdir: directory,
    allowWrite: false,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Complete after a long-running tool call',
    mode: 'auto',
    maxRounds: 1,
  })
  await workspace.activeRuns.get(group.id).promise

  assert.equal(finished[0].status, 'round-limit')
  assert.equal(workspace.snapshot().messages.some(message => (
    message.system?.key === 'system.agentCallFailed'
      && message.agentKind === 'codex'
  )), false)
})

test('an unmatched tool start cannot keep an automatic discussion running forever', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgentTimeoutMs = 8
  options.runAgentToolTimeoutMs = 20
  options.runAbortGraceMs = 20
  options.runSilenceWarningMs = 1000
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    if (agent.kind !== 'codex') {
      return {
        text: `${agent.kind} completed`,
        sessionRef: `${agent.kind}-session`,
      }
    }
    runOptions.onEvent({
      id: 'tool-without-terminal-event',
      type: 'tool_start',
      title: 'search',
      status: 'running',
    })
    return new Promise((resolve, reject) => {
      const heartbeat = setInterval(() => runOptions.onActivity(), 1)
      const abort = () => {
        clearInterval(heartbeat)
        reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED'))
      }
      if (runOptions.signal.aborted) abort()
      else runOptions.signal.addEventListener('abort', abort, { once: true })
    })
  }
  const finished = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Unmatched tool lifecycle',
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
    allowWrite: false,
  })
  workspace.addMessage(group.id, 'user', 'Do not remain running after a tool stalls')

  workspace.startAuto({ groupId: group.id, maxRounds: 1 })
  const runPromise = workspace.activeRuns.get(group.id).promise
  const settled = await Promise.race([
    runPromise.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 100)),
  ])
  if (!settled) await workspace.stopAll()

  assert.equal(settled, true)
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'partial')
  const failure = workspace.snapshot().messages.find(message => (
    message.agentKind === 'codex' && message.system?.key === 'system.agentCallFailed'
  ))
  assert.equal(failure?.system?.params?.reason, 'LOCAL_AGENT_TIMEOUT')
  assert.equal(failure?.trace?.status, 'timeout')
})

test('automatic discussion keeps a live but slow-starting Agent past the startup deadline', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgentTimeoutMs = 20
  options.runAbortGraceMs = 20
  options.runSilenceWarningMs = 1000
  options.retrySleep = async () => {}
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'codex') {
      // Thinking for longer than the startup deadline while the process keeps
      // producing output must not be treated as a dead Agent.
      for (let tick = 0; tick < 8; tick += 1) {
        await new Promise(resolve => setTimeout(resolve, 5))
        runOptions.onActivity()
      }
    }
    return {
      text: `${agent.kind} answered\n[[MELDWORK_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const finished = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Slow starting Agent', agentKinds: ['codex', 'hermes'], workdir: directory,
    allowWrite: false,
  })
  workspace.addMessage(group.id, 'user', 'Think before answering')

  workspace.startAuto({ groupId: group.id, maxRounds: 1 })
  await workspace.activeRuns.get(group.id).promise

  assert.equal(workspace.snapshot().messages.some(message => (
    message.agentKind === 'codex' && message.role === 'agent'
      && message.content.startsWith('codex answered')
  )), true)
  assert.equal(workspace.snapshot().messages.some(message => (
    message.system?.params?.reason === 'LOCAL_AGENT_TIMEOUT'
  )), false)
  assert.equal(finished[0].status, 'completed')
})

test('automatic discussion hard-stops a heartbeat-only Agent and continues later rounds', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgentTimeoutMs = 20
  options.runAbortGraceMs = 20
  options.runSilenceWarningMs = 1000
  options.retrySleep = async () => {}
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'codex') {
      await new Promise((resolve, reject) => {
        const abort = () => reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED'))
        if (runOptions.signal.aborted) abort()
        else runOptions.signal.addEventListener('abort', abort, { once: true })
        const heartbeat = setInterval(() => runOptions.onActivity(), 1)
        runOptions.signal.addEventListener('abort', () => clearInterval(heartbeat), { once: true })
      })
    }
    return {
      text: `${agent.kind} continues`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const finished = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Heartbeat-only Agent isolation',
    agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory,
    allowWrite: false,
  })
  workspace.addMessage(group.id, 'user', 'Continue for two rounds after one Agent stalls')

  workspace.startAuto({ groupId: group.id, maxRounds: 2 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.agent.kind), [
    'codex',
    'hermes', 'workbuddy', 'hermes', 'workbuddy',
  ])
  assert.equal(
    workspace.snapshot().messages.filter(message => message.role === 'agent').length,
    4,
  )
  assert.deepEqual(workspace.getGroup(group.id).agentKinds, ['codex', 'hermes', 'workbuddy'])
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'partial')
  assert.equal(workspace.snapshot().messages.some(message => (
    message.agentKind === 'codex' && message.system?.key === 'system.agentCallFailed'
  )), true)
})

test('manual Agent watchdog finishes the run as timeout and removes the parent abort listener', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgentTimeoutMs = 8
  options.runAbortGraceMs = 20
  options.runSilenceWarningMs = 100
  const started = deferred()
  let timedOutSignal
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    timedOutSignal = runOptions.signal
    started.resolve()
    return await new Promise(() => {})
  }
  const finished = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Manual watchdog', agentKinds: ['codex'], workdir: directory,
    conversationType: 'direct', directAgentKind: 'codex',
    allowWrite: false,
  })

  const send = workspace.sendMessage({ groupId: group.id, text: 'Do not wait forever' })
  await started.promise
  const parentSignal = workspace.activeRuns.get(group.id).signal
  assert.equal(getEventListeners(parentSignal, 'abort').length, 1)
  await send

  assert.equal(timedOutSignal.aborted, true)
  assert.equal(getEventListeners(parentSignal, 'abort').length, 0)
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'timeout')
  const failure = workspace.snapshot().messages.find(message => (
    message.agentKind === 'codex' && message.system?.key === 'system.agentCallFailed'
  ))
  assert.equal(failure.system.params.reason, 'LOCAL_AGENT_TIMEOUT')
  assert.equal(failure.trace.status, 'timeout')
})

test('a slow Agent that keeps reporting progress is not timed out by elapsed wall time', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgentTimeoutMs = 12
  options.runSilenceWarningMs = 1000
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    for (let tick = 0; tick < 8; tick += 1) {
      await new Promise(resolve => setTimeout(resolve, 6))
      runOptions.onActivity()
    }
    return { text: 'Slow but active reply', sessionRef: 'codex-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Slow active Agent', agentKinds: ['codex'], workdir: directory,
  })

  await workspace.sendMessage({ groupId: group.id, text: 'Keep working', targetKinds: ['codex'] })

  const reply = workspace.snapshot().messages.find(message => message.agentKind === 'codex')
  assert.equal(reply.content, 'Slow but active reply')
  assert.equal(reply.trace.status, 'completed')
})

test('cloud Agent activity releases the initial watchdog deadline', async (t) => {
  const { directory, options } = fixture()
  const cloudKind = 'cloud-0123456789abcdef01234567'
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgentTimeoutMs = 20
  options.runSilenceWarningMs = 1000
  options.detectAgents = async () => [{
    kind: cloudKind, name: 'Hermes @ Cloud server', version: '1', available: true,
    compatibilityState: 'compatible', cloud: true,
  }]
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    const heartbeat = setInterval(() => runOptions.onActivity(), 5)
    try {
      await new Promise(resolve => setTimeout(resolve, 65))
      return { text: 'Cloud reply arrived', sessionRef: 'cloud-session' }
    } finally {
      clearInterval(heartbeat)
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Cloud watchdog', agentKinds: [cloudKind], workdir: directory,
  })

  await workspace.sendMessage({ groupId: group.id, text: 'Wait for the cloud reply' })

  const reply = workspace.snapshot().messages.find(message => message.role === 'agent')
  assert.equal(reply.content, 'Cloud reply arrived')
  assert.equal(reply.trace.status, 'completed')
})

test('terminal Agent states persist conclusion text already streamed through answer deltas', async (t) => {
  const scenarios = [
    {
      name: 'failure',
      action: 'fail',
      expectedKey: 'system.agentCallFailed',
      expectedPrefix: 'Codex failed: LOCAL_AGENT_PROCESS_FAILED',
    },
    {
      name: 'timeout',
      action: 'timeout',
      expectedKey: 'system.agentCallFailed',
      expectedPrefix: 'Codex failed: LOCAL_AGENT_TIMEOUT',
    },
    {
      name: 'stop',
      action: 'stop',
      expectedKey: 'system.agentStopped',
      expectedPrefix: 'Codex was stopped.',
    },
    {
      name: 'interruption',
      action: 'interrupt',
      expectedKey: 'system.agentInterrupted',
      expectedPrefix: 'Codex was interrupted when Meldwork closed.',
    },
  ]

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (t) => {
      const { directory, options } = fixture()
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
      const started = deferred()
      const conclusion = `${scenario.name} streamed conclusion`
      options.runAbortGraceMs = 20
      options.runSilenceWarningMs = 100
      if (scenario.action === 'timeout') options.runAgentTimeoutMs = 8
      options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
        runOptions.onEvent({
          type: 'reasoning_summary', status: 'running', summary: 'Trace-only reasoning summary',
        })
        runOptions.onEvent({ type: 'answer_delta', status: 'running', delta: conclusion })
        started.resolve()
        if (scenario.action === 'fail') throw new Error('LOCAL_AGENT_PROCESS_FAILED')
        return await new Promise((_resolve, reject) => {
          runOptions.signal.addEventListener(
            'abort', () => reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED')), { once: true },
          )
        })
      }
      const workspace = new LocalWorkspace(options)
      await workspace.refreshAgents()
      const group = workspace.createGroup({
        name: `Streamed ${scenario.name}`, agentKinds: ['codex'], workdir: directory,
        allowWrite: false,
      })

      const send = workspace.sendMessage({
        groupId: group.id, text: `Exercise ${scenario.name}`, targetKinds: ['codex'],
      })
      await started.promise
      if (scenario.action === 'stop') {
        const runId = workspace.activeRuns.get(group.id).runId
        assert.equal(workspace.stop(group.id, runId), true)
        await send
      } else if (scenario.action === 'interrupt') {
        await Promise.all([send, workspace.stopAll()])
      } else {
        await send
      }

      const terminal = workspace.snapshot().messages.find(message => (
        message.agentKind === 'codex' && message.system?.key === scenario.expectedKey
      ))
      assert.equal(terminal.content, `${scenario.expectedPrefix}\n${conclusion}`)
      assert.doesNotMatch(terminal.content, /Trace-only reasoning summary/)
      const persisted = JSON.parse(fs.readFileSync(options.storagePath, 'utf8'))
      assert.equal(
        persisted.messages.find(message => message.id === terminal.id).content,
        terminal.content,
      )
    })
  }
})

test('completed Agents clear watchdog and silence timers', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgentTimeoutMs = 5
  options.runSilenceWarningMs = 5
  let completedSignal
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    completedSignal = runOptions.signal
    return { text: 'Completed immediately', sessionRef: 'codex-session' }
  }
  const events = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-event', event => events.push(event))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Timer cleanup', agentKinds: ['codex'], workdir: directory,
  })

  await workspace.sendMessage({ groupId: group.id, text: 'Finish', targetKinds: ['codex'] })
  await new Promise(resolve => setTimeout(resolve, 20))

  assert.equal(completedSignal.aborted, false)
  assert.equal(events.some(event => event.type === 'warning'), false)
  assert.deepEqual(workspace.snapshot().runningGroupIds, [])
})

test('progress heartbeats reset the soft silence warning', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runSilenceWarningMs = 30
  options.runAgentTimeoutMs = 500
  const heartbeatsComplete = deferred()
  const releaseAgent = deferred()
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    for (let tick = 0; tick < 8; tick += 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
      runOptions.onProgress({ id: 'heartbeat', title: 'process', status: 'in_progress' })
    }
    heartbeatsComplete.resolve()
    await releaseAgent.promise
    return { text: 'Finished after progress', sessionRef: 'codex-session' }
  }
  const events = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-event', event => events.push(event))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Progress heartbeat', agentKinds: ['codex'], workdir: directory,
  })

  const send = workspace.sendMessage({
    groupId: group.id, text: 'Keep reporting', targetKinds: ['codex'],
  })
  await heartbeatsComplete.promise

  assert.equal(events.some(event => event.type === 'warning'), false)
  assert.equal(events.some(event => event.type.startsWith('tool_') || event.title === 'process'), false)

  await new Promise(resolve => setTimeout(resolve, 45))
  const warning = events.find(event => event.type === 'warning')
  assert.equal(warning?.title, 'waiting_for_output')

  releaseAgent.resolve()
  await send
  const reply = workspace.snapshot().messages.find(message => message.agentKind === 'codex')
  assert.equal(reply.trace.events.some(event => event.title === 'process'), false)
})

test('Harness emits a soft waiting warning without cancelling a long-running Agent', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runSilenceWarningMs = 5
  const gate = deferred()
  const started = deferred()
  options.runAgent = async () => {
    started.resolve()
    await gate.promise
    return { text: 'Eventually finished', sessionRef: 'codex-session' }
  }
  const events = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-event', event => events.push(event))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Silence warning', agentKinds: ['codex'], workdir: directory,
  })

  const send = workspace.sendMessage({ groupId: group.id, text: 'Wait', targetKinds: ['codex'] })
  await started.promise
  await new Promise(resolve => setTimeout(resolve, 25))
  const warning = events.find(event => event.type === 'warning')
  assert.equal(warning?.status, 'waiting')
  assert.equal(warning?.title, 'waiting_for_output')
  assert.equal(workspace.snapshot().runningGroupIds.includes(group.id), true)
  gate.resolve()
  await send
  assert.equal(workspace.snapshot().messages.at(-1).content, 'Eventually finished')
})

test('Automatic Harness conclusions stream without exposing the consensus control marker', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    runOptions.onEvent({ type: 'reasoning_summary', summary: agent.kind + ' compared the proposals' })
    runOptions.onEvent({ type: 'answer_delta', status: 'running', delta: agent.kind + ' conclusion\n[[MELDWORK_CONSENSUS:' })
    runOptions.onEvent({ type: 'answer_delta', status: 'running', delta: 'agree]]' })
    return {
      text: agent.kind + ' conclusion\n[[MELDWORK_CONSENSUS:agree]]',
      sessionRef: runOptions.sessionRef || agent.kind + '-session',
    }
  }
  const events = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-event', event => events.push(event))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Automatic harness', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  const started = await workspace.sendMessage({
    groupId: group.id,
    text: 'Reach consensus',
    mode: 'auto',
    maxRounds: 1,
  })
  assert.equal(started.started, true)
  await workspace.activeRuns.get(group.id).promise

  const answerText = events.filter(event => event.type === 'answer_delta')
    .map(event => event.delta)
    .join('')
  assert.doesNotMatch(answerText, /MELDWORK_CONSENSUS/)
  assert.equal(events.some(event => event.type === 'reasoning_summary'), true)
  assert.deepEqual(
    workspace.snapshot().messages.filter(message => message.role === 'agent')
      .map(message => message.content),
    ['codex conclusion', 'hermes conclusion'],
  )
})

test('Run Ledger checkpoints bounded trace state and is cleared with its conversation', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const checkpoints = []
  const finishes = []
  const deletedGroups = []
  options.runLedger = {
    recoverInterrupted: () => [],
    checkpoint: record => checkpoints.push(structuredClone(record)),
    finish: (runId, status, reason) => finishes.push({ runId, status, reason }),
    deleteGroup: groupId => deletedGroups.push(groupId),
  }
  options.runAgent = async (_agent, prompt, _workdir, runOptions) => {
    await runOptions.onOutboundPayload(createLegacyOutboundPayload({
      prompt,
      command: '/private/bin/mock-agent',
      args: ['--prompt', prompt],
      cwd: '/private/workspace',
      stdin: prompt,
      promptMode: 'stdin',
    }))
    runOptions.onEvent({
      id: 'plan-1', type: 'plan', status: 'running', summary: 'Inspect the current implementation.',
    })
    return { text: 'Ledger-backed result', sessionRef: 'codex-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Ledger lifecycle', agentKinds: ['codex'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id, text: 'Trace this run', targetKinds: ['codex'],
  })

  assert.equal(checkpoints.some(record => record.status === 'preparing'), true)
  assert.equal(checkpoints.some(record => record.status === 'running'), true)
  const terminal = checkpoints.findLast(record => record.status === 'completed')
  const task = workspace.snapshot().messages.find(message => (
    message.role === 'user' && message.content === 'Trace this run'
  ))
  assert.equal(terminal.taskId, task.id)
  assert.equal(terminal.threadRootId, task.id)
  assert.equal(terminal.agentRuns[0].status, 'completed')
  assert.equal(terminal.agentRuns[0].events.some(event => event.type === 'plan'), true)
  assert.equal(terminal.agentRuns[0].context.includedCount, 1)
  assert.equal(terminal.budget.startedAt <= terminal.startedAt, true)
  assert.equal(terminal.budget.used.outboundBytes > 0, true)
  assert.equal(terminal.budget.source.outboundBytes, 'reported')
  assert.deepEqual(finishes, [{ runId: terminal.runId, status: 'completed', reason: '' }])

  workspace.deleteGroup(group.id)
  assert.deepEqual(deletedGroups, [group.id])
})

test('durable Task acceptance fails closed at every pre-execution Ledger checkpoint', async (t) => {
  for (const failureAttempt of [1, 2]) {
    await t.test(`checkpoint ${failureAttempt}`, async (subtest) => {
      const { directory, calls, options } = fixture()
      subtest.after(() => fs.rmSync(directory, { recursive: true, force: true }))
      let checkpointAttempts = 0
      options.runLedger = {
        recoverInterrupted: () => [],
        list: () => [],
        checkpoint: () => {
          checkpointAttempts += 1
          if (checkpointAttempts === failureAttempt) throw new Error('RUN_LEDGER_WRITE_FAILED')
        },
        finish: () => {},
      }
      const workspace = new LocalWorkspace(options)
      await workspace.refreshAgents()
      const group = workspace.createGroup({
        name: `Ledger gate ${failureAttempt}`, agentKinds: ['codex'], workdir: directory,
      })
      const previousUpdatedAt = group.updatedAt

      await assert.rejects(
        workspace.sendMessage({
          groupId: group.id,
          text: `Do not execute after checkpoint ${failureAttempt}`,
          targetKinds: ['codex'],
        }),
        { message: 'LOCAL_RUN_PERSIST_FAILED' },
      )

      assert.equal(calls.length, 0)
      assert.equal(workspace.snapshot().messages.length, 0)
      assert.deepEqual(workspace.snapshot().runningGroupIds, [])
      assert.deepEqual(workspace.snapshot().runs, [])
      assert.equal(workspace.getGroup(group.id).updatedAt, previousUpdatedAt)
    })
  }
})

test('the durable Task link exists before the Agent process starts', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  let workspace
  let group
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    const userTask = workspace.state.messages.findLast(message => message.role === 'user')
    const active = workspace.activeRuns.get(group.id)
    const durable = ledger.get(active.runId)
    assert.equal(durable.status, 'running')
    assert.equal(durable.taskId, userTask.id)
    assert.match(durable.contextPackId, /^context-pack-[a-f0-9]{64}$/)
    assert.equal(workspace.contextPackStore.get(durable.contextPackId).taskId, userTask.id)
    assert.equal(durable.threadRootId, userTask.id)
    assert.equal(durable.permissionMode, 'read-only')
    assert.equal(runOptions.sandbox, 'read-only')
    return { text: 'Durably linked result', sessionRef: runOptions.sessionRef || 'codex-session' }
  }
  workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  group = workspace.createGroup({
    name: 'Durable Task link', agentKinds: ['codex'], workdir: directory, allowWrite: false,
  })

  await workspace.sendMessage({
    groupId: group.id, text: 'Persist this Task before execution', targetKinds: ['codex'],
  })

  const task = workspace.snapshot().messages.find(message => message.role === 'user')
  const run = ledger.list(group.id)[0]
  assert.equal(run.taskId, task.id)
  assert.equal(run.status, 'completed')
  assert.equal(run.permissionMode, 'read-only')
})

test('explicit workspace write authorization is recorded and passed to the Agent', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    assert.equal(runOptions.sandbox, 'workspace-write')
    return { text: 'Authorized result', sessionRef: 'codex-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Authorized Task', agentKinds: ['codex'], workdir: directory, allowWrite: true,
  })

  await workspace.sendMessage({
    groupId: group.id, text: 'Use the approved workspace permission', targetKinds: ['codex'],
  })

  assert.equal(ledger.list(group.id)[0].permissionMode, 'workspace-write')
})

test('direct Tasks persist without inventing a group thread root', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Durable direct Task',
    agentKinds: ['codex'],
    conversationType: 'direct',
    directAgentKind: 'codex',
    workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id, text: 'Persist this direct Task', targetKinds: ['codex'],
  })

  const task = workspace.snapshot().messages.find(message => message.role === 'user')
  const run = ledger.list(group.id)[0]
  assert.equal(run.taskId, task.id)
  assert.equal(run.threadRootId, '')
  assert.equal(run.status, 'completed')
})

test('resuming automatic discussion checkpoints its existing Task before execution', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  options.runLedger = ledger
  let workspace
  let group
  options.runAgent = async (agent, _prompt, _workdir, runOptions) => {
    calls.push({ agent, runOptions })
    const active = workspace.activeRuns.get(group.id)
    const durable = ledger.get(active.runId)
    assert.equal(durable.status, 'running')
    assert.equal(durable.taskId, active.threadRootId)
    return {
      text: `${agent.kind} agrees\n[[MELDWORK_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  group = workspace.createGroup({
    name: 'Durable resumed discussion',
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
  })
  const task = workspace.addMessage(group.id, 'user', 'Resume this durable Task')

  workspace.startAuto({ groupId: group.id, maxRounds: 1 })
  await workspace.activeRuns.get(group.id).promise

  const run = ledger.list(group.id)[0]
  assert.equal(calls.length, 2)
  assert.equal(run.taskId, task.id)
  assert.equal(run.threadRootId, task.id)
  assert.equal(run.status, 'completed')
})

test('resuming automatic discussion fails closed when its running checkpoint is not durable', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let checkpointAttempts = 0
  options.runLedger = {
    recoverInterrupted: () => [],
    list: () => [],
    checkpoint: () => {
      checkpointAttempts += 1
      if (checkpointAttempts === 2) throw new Error('RUN_LEDGER_WRITE_FAILED')
    },
    finish: () => {},
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Durable resume gate', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const task = workspace.addMessage(group.id, 'user', 'Do not resume without durable state')

  assert.throws(
    () => workspace.startAuto({ groupId: group.id, maxRounds: 1 }),
    { message: 'LOCAL_RUN_PERSIST_FAILED' },
  )

  assert.equal(calls.length, 0)
  assert.equal(workspace.snapshot().messages.some(message => message.id === task.id), true)
  assert.deepEqual(workspace.snapshot().runningGroupIds, [])
})

test('Run Ledger finalization automatically retries the full terminal snapshot before finish', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const ledger = new RunLedger({ storagePath: ledgerPath, now: () => 1000 })
  options.runLedger = ledger
  const workspace = new LocalWorkspace(options)
  const finishedEvents = []
  workspace.on('run-finished', event => finishedEvents.push(event))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Retry terminal checkpoint', agentKinds: ['codex'], workdir: directory,
  })
  const task = workspace.addMessage(group.id, 'user', 'Retry this terminal checkpoint')
  const contextPack = workspace.createContextPack({
    group,
    taskId: task.id,
    mode: 'manual',
    targetKinds: ['codex'],
    message: task,
  })
  const reservation = workspace.reserveRun(group.id, 'manual', ['codex'], task.id)
  workspace.bindRunTask(
    group.id, reservation, task.id, task.id, contextPack.contextPackId,
  )
  const controller = workspace.beginRun(
    group.id, 'manual', ['codex'], task.id, reservation,
  )
  controller.startedAt = 1000
  let agentRuns = [{
    agentRunId: `${controller.runId}:0:codex:agent-1`,
    kind: 'codex',
    status: 'running',
    output: 'Stale output',
  }]
  controller.harness = { snapshot: () => structuredClone(agentRuns) }
  assert.equal(workspace.checkpointRun(group.id, controller, 'running'), true)

  const persist = ledger.persist.bind(ledger)
  let failed = false
  ledger.persist = (runs) => {
    if (!failed) {
      failed = true
      throw new Error('RUN_LEDGER_WRITE_FAILED')
    }
    return persist(runs)
  }
  agentRuns = [{
    ...agentRuns[0],
    status: 'completed',
    output: 'Fresh terminal output',
  }]

  await workspace.finishRun(group.id, controller, 'completed')
  const finished = ledger.get(controller.runId)
  assert.equal(finished.status, 'completed')
  assert.equal(finished.agentRuns[0].status, 'completed')
  assert.equal(finished.agentRuns[0].output, 'Fresh terminal output')
  assert.equal(workspace.activeRuns.has(group.id), false)
  assert.equal(finishedEvents.length, 1)
  assert.equal(finishedEvents[0].status, 'completed')
})

test('a Unicode group identifier preserves native sessions and every runtime path', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const groupId = '历史群聊 1'
  let id = 0
  const checkpoints = []
  const ledgerFinishes = []
  options.createId = () => id++ === 0 ? groupId : `message-${id}`
  options.runLedger = {
    recoverInterrupted: () => [],
    list: () => [],
    checkpoint: record => checkpoints.push(structuredClone(record)),
    finish: (runId, status) => ledgerFinishes.push({ runId, status }),
  }
  const events = []
  const finished = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-event', event => events.push(event))
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Unicode group',
    agentKinds: ['codex'],
    conversationType: 'direct',
    directAgentKind: 'codex',
    workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id, text: 'Send through every lifecycle boundary', targetKinds: ['codex'],
  })
  await workspace.sendMessage({
    groupId: group.id, text: 'Reuse the native session', targetKinds: ['codex'],
  })

  const sessionKey = workspace.sessionKey(group.id, 'codex')
  const persisted = JSON.parse(fs.readFileSync(options.storagePath, 'utf8'))
  assert.equal(workspace.sessionKey('group-1', 'codex'), 'group-1:codex')
  assert.match(sessionKey, /^session:[a-f0-9]{64}$/)
  assert.doesNotMatch(sessionKey, /历史群聊/)
  assert.equal(persisted.sessions[sessionKey], 'codex-session')
  assert.deepEqual(calls.map(call => call.runOptions.sessionRef), ['', 'codex-session'])

  const restarted = new LocalWorkspace(options)
  await restarted.refreshAgents()
  await restarted.sendMessage({
    groupId: group.id, text: 'Reuse after restart', targetKinds: ['codex'],
  })

  assert.equal(group.id, groupId)
  assert.equal(checkpoints.length > 0, true)
  assert.equal(checkpoints.every(record => record.groupId === groupId), true)
  assert.deepEqual(ledgerFinishes.map(item => item.status), [
    'completed', 'completed', 'completed',
  ])
  assert.equal(events.length > 0, true)
  assert.equal(events.every(event => event.groupId === groupId), true)
  assert.equal(finished.every(result => result.groupId === groupId), true)
  assert.deepEqual(calls.map(call => call.runOptions.sessionRef), [
    '', 'codex-session', 'codex-session',
  ])
  assert.equal(restarted.snapshot().messages.every(message => message.groupId === groupId), true)
})

test('conversation deletion remains retryable when a corrupt Run Ledger blocks cleanup', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let deleteAttempts = 0
  options.runLedger = {
    recoverInterrupted: () => [],
    deleteGroup: () => {
      deleteAttempts += 1
      if (deleteAttempts === 1) throw new Error('RUN_LEDGER_LOAD_FAILED')
    },
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Ledger cleanup failure', agentKinds: ['codex'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', 'Keep this conversation until cleanup succeeds')
  const beforeDisk = fs.readFileSync(options.storagePath, 'utf8')

  assert.throws(() => workspace.deleteGroup(group.id), { message: 'RUN_LEDGER_LOAD_FAILED' })
  assert.equal(workspace.snapshot().groups.some(item => item.id === group.id), true)
  assert.equal(workspace.snapshot().messages.some(message => message.groupId === group.id), true)
  assert.equal(fs.readFileSync(options.storagePath, 'utf8'), beforeDisk)

  workspace.deleteGroup(group.id)
  assert.equal(workspace.snapshot().groups.some(item => item.id === group.id), false)
  assert.equal(deleteAttempts, 2)
})

test('malformed workspace state enters read-only recovery without touching valid Ledger data', (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(options.storagePath, '{partially-written')
  const ledgerCalls = []
  options.runLedger = {
    reconcileContextPacks: () => ledgerCalls.push('reconcileContextPacks'),
    recoverInterrupted: () => ledgerCalls.push('recoverInterrupted'),
    list: () => [{ runId: 'run-1', groupId: 'group-1', status: 'completed' }],
    deleteGroup: groupId => ledgerCalls.push(`deleteGroup:${groupId}`),
  }

  const workspace = new LocalWorkspace(options)
  const firstSnapshot = workspace.snapshot()
  const restarted = new LocalWorkspace(options)

  assert.deepEqual(ledgerCalls, [])
  assert.deepEqual(firstSnapshot.recovery, {
    state: 'read-only',
    status: 'corrupt',
    diagnostic: 'LOCAL_WORKSPACE_STATE_CORRUPT',
  })
  assert.deepEqual(restarted.snapshot().recovery, firstSnapshot.recovery)
  assert.equal(fs.readFileSync(options.storagePath, 'utf8'), '{partially-written')
  assert.throws(
    () => workspace.save(),
    { message: 'LOCAL_WORKSPACE_STATE_CORRUPT' },
  )
  assert.equal(fs.readFileSync(options.storagePath, 'utf8'), '{partially-written')
})

test('conversation state rolls back when workspace deletion persistence fails', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const deletedGroups = []
  options.runLedger = {
    recoverInterrupted: () => [],
    deleteGroup: groupId => deletedGroups.push(groupId),
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Workspace cleanup failure', agentKinds: ['codex'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', 'Keep the local state retryable')
  const save = workspace.save.bind(workspace)
  workspace.save = () => { throw new Error('WORKSPACE_SAVE_FAILED') }

  assert.throws(() => workspace.deleteGroup(group.id), { message: 'WORKSPACE_SAVE_FAILED' })
  assert.equal(workspace.snapshot().groups.some(item => item.id === group.id), true)
  assert.equal(workspace.snapshot().messages.some(message => message.groupId === group.id), true)
  assert.deepEqual(deletedGroups, [])

  workspace.save = save
  workspace.deleteGroup(group.id)
  assert.equal(workspace.snapshot().groups.some(item => item.id === group.id), false)
  assert.deepEqual(deletedGroups, [group.id])
})

test('conversation mutations restore in-memory state when persistence fails', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Transactional conversation', agentKinds: ['codex'], workdir: directory,
  })
  const message = workspace.addMessage(group.id, 'user', 'Keep this message')
  workspace.state.sessions[`${group.id}:codex`] = 'session-before-failure'
  workspace.state.sessionMeta[`${group.id}:codex`] = { updatedAt: 'before-failure' }
  const before = structuredClone(workspace.state)
  const save = workspace.save.bind(workspace)
  workspace.save = () => { throw new Error('WORKSPACE_SAVE_FAILED') }

  assert.throws(() => workspace.createGroup({
    name: 'Unsaved group', agentKinds: ['codex'], workdir: directory,
  }), { message: 'WORKSPACE_SAVE_FAILED' })
  assert.deepEqual(workspace.state, before)

  assert.throws(() => workspace.updateGroup(group.id, {
    name: 'Unsaved rename', workdir: path.join(directory, 'other'), allowWrite: false,
  }), { message: 'WORKSPACE_SAVE_FAILED' })
  assert.deepEqual(workspace.state, before)

  assert.throws(() => workspace.deleteMessage(group.id, message.id), {
    message: 'WORKSPACE_SAVE_FAILED',
  })
  assert.deepEqual(workspace.state, before)

  assert.throws(() => workspace.addMessage(group.id, 'agent', 'Unsaved response', 'codex'), {
    message: 'WORKSPACE_SAVE_FAILED',
  })
  assert.deepEqual(workspace.state, before)

  workspace.save = save
})

test('conversation validation failures do not leave partial state behind', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Validated conversation', agentKinds: ['codex'], workdir: directory,
  })
  const before = structuredClone(workspace.state)

  assert.throws(() => workspace.updateGroup(group.id, {
    name: 'Partial rename',
    workdir: path.join(directory, 'invalid-update'),
    agentKinds: ['missing-agent'],
  }), { message: 'LOCAL_GROUP_AGENT_REQUIRED' })
  assert.deepEqual(workspace.state, before)

  assert.throws(() => workspace.addMessage('missing-group', 'user', 'Orphan message'), {
    message: 'LOCAL_GROUP_NOT_FOUND',
  })
  assert.deepEqual(workspace.state, before)
})

test('restart recovery persists the last nonterminal Agent trace as interrupted', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const initial = new LocalWorkspace(options)
  await initial.refreshAgents()
  const group = initial.createGroup({
    name: 'Interrupted recovery', agentKinds: ['codex'], workdir: directory,
  })
  const root = initial.addMessage(group.id, 'user', 'Keep the last useful evidence')
  const recoveredOptions = {
    ...options,
    runLedger: {
      recoverInterrupted: () => [{
        runId: 'run-crashed',
        groupId: group.id,
        threadRootId: root.id,
        targetKinds: ['codex'],
        agentRuns: [{
          agentRunId: 'run-crashed:1:codex:agent-1',
          kind: 'codex',
          round: 1,
          status: 'interrupted',
          sourceMessageIds: [root.id],
          context: { includedCount: 1, omittedCount: 2, charCount: 640 },
          events: [{
            type: 'reasoning_summary', status: 'running',
            summary: 'Located the failing lifecycle boundary.',
          }],
        }],
      }],
    },
  }

  const restored = new LocalWorkspace(recoveredOptions)
  const interrupted = restored.snapshot().messages.find(message => (
    message.system?.key === 'system.agentInterrupted'
  ))

  assert.equal(interrupted.threadRootId, root.id)
  assert.equal(interrupted.trace.status, 'interrupted')
  assert.equal(interrupted.trace.summary, 'Located the failing lifecycle boundary.')
  assert.deepEqual(interrupted.trace.sourceMessageIds, [root.id])
  assert.equal(interrupted.trace.context.omittedCount, 2)
})

test('restart never downgrades an already completed conversation result from a stale Run', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const initial = new LocalWorkspace(options)
  await initial.refreshAgents()
  const group = initial.createGroup({
    name: 'Completed result recovery', agentKinds: ['codex'], workdir: directory,
  })
  const root = initial.addMessage(group.id, 'user', 'Keep the completed result')
  const contextPack = initial.createContextPack({
    group,
    taskId: root.id,
    mode: 'manual',
    targetKinds: ['codex'],
    message: root,
  })
  initial.addMessage(
    group.id,
    'agent',
    'Durable completed answer',
    'codex',
    root.id,
    null,
    {
      trace: {
        runId: 'run-stale-terminal',
        agentRunId: 'run-stale-terminal:0:codex:agent-1',
        round: 0,
        status: 'completed',
      },
    },
  )
  const ledger = new RunLedger({ storagePath: ledgerPath, now: () => 1000 })
  ledger.checkpoint({
    runId: 'run-stale-terminal',
    taskId: root.id,
    contextPackId: contextPack.contextPackId,
    contextPackState: 'captured',
    groupId: group.id,
    threadRootId: root.id,
    targetKinds: ['codex'],
    status: 'running',
    agentRuns: [{
      agentRunId: 'run-stale-terminal:0:codex:agent-1',
      kind: 'codex',
      round: 0,
      status: 'running',
      output: 'Durable completed answer',
    }],
  })

  const restored = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath, now: () => 2000 }),
  })
  const result = restored.snapshot().messages.find(message => (
    message.trace?.agentRunId === 'run-stale-terminal:0:codex:agent-1'
  ))

  assert.equal(result.role, 'agent')
  assert.equal(result.content, 'Durable completed answer')
  assert.equal(result.trace.status, 'completed')
})

test('restart reconciles after recovery message persistence fails and then deduplicates', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const initial = new LocalWorkspace(options)
  await initial.refreshAgents()
  const group = initial.createGroup({
    name: 'Retry interrupted recovery', agentKinds: ['codex'], workdir: directory,
  })
  const root = initial.addMessage(group.id, 'user', 'Recover this once')
  const contextPack = initial.createContextPack({
    group,
    taskId: root.id,
    mode: 'manual',
    targetKinds: ['codex'],
    message: root,
  })
  const seeded = new RunLedger({ storagePath: ledgerPath, now: () => 1000 })
  seeded.checkpoint({
    runId: 'run-crashed',
    taskId: root.id,
    contextPackId: contextPack.contextPackId,
    contextPackState: 'captured',
    groupId: group.id,
    threadRootId: root.id,
    targetKinds: ['codex'],
    status: 'running',
    agentRuns: [{
      agentRunId: 'run-crashed:1:codex:agent-1',
      kind: 'codex',
      round: 1,
      status: 'running',
      output: 'Useful partial output',
      sourceMessageIds: [root.id],
    }],
  })

  class FailingRecoveryWorkspace extends LocalWorkspace {
    save() { throw new Error('WORKSPACE_SAVE_FAILED') }
  }
  assert.throws(() => new FailingRecoveryWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath, now: () => 2000 }),
  }), { message: 'WORKSPACE_SAVE_FAILED' })
  assert.equal(
    new RunLedger({ storagePath: ledgerPath }).get('run-crashed').agentRuns[0].status,
    'interrupted',
  )

  const recoveredStartup = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath, now: () => 3000 }),
  })
  const restored = recoveredStartup.snapshot().messages.filter(message => (
    message.trace?.agentRunId === 'run-crashed:1:codex:agent-1'
  ))
  assert.equal(restored.length, 1)
  assert.equal(restored[0].system.key, 'system.agentInterrupted')
  assert.equal(restored[0].trace.status, 'interrupted')

  const repeatedStartup = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath, now: () => 4000 }),
  })
  assert.equal(repeatedStartup.snapshot().messages.filter(message => (
    message.trace?.agentRunId === 'run-crashed:1:codex:agent-1'
  )).length, 1)
})

test('restart reconciliation enriches an existing terminal message with Ledger output once', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const initial = new LocalWorkspace(options)
  await initial.refreshAgents()
  const group = initial.createGroup({
    name: 'Existing terminal recovery', agentKinds: ['codex'], workdir: directory,
  })
  const root = initial.addMessage(group.id, 'user', 'Preserve the streamed conclusion')
  const contextPack = initial.createContextPack({
    group,
    taskId: root.id,
    mode: 'manual',
    targetKinds: ['codex'],
    message: root,
  })
  initial.addMessage(
    group.id,
    'system',
    'Codex failed: LOCAL_AGENT_PROCESS_FAILED',
    'codex',
    root.id,
    {
      key: 'system.agentCallFailed',
      params: { agent: 'Codex', reason: 'LOCAL_AGENT_PROCESS_FAILED' },
    },
    {
      trace: {
        runId: 'run-existing-terminal',
        agentRunId: 'run-existing-terminal:0:codex:agent-1',
        round: 0,
        status: 'failed',
      },
    },
  )
  const ledger = new RunLedger({ storagePath: ledgerPath, now: () => 1000 })
  ledger.checkpoint({
    runId: 'run-existing-terminal',
    taskId: root.id,
    contextPackId: contextPack.contextPackId,
    contextPackState: 'captured',
    groupId: group.id,
    threadRootId: root.id,
    targetKinds: ['codex'],
    status: 'failed',
    agentRuns: [{
      agentRunId: 'run-existing-terminal:0:codex:agent-1',
      kind: 'codex',
      round: 0,
      status: 'failed',
      output: 'Conclusion recovered from answer deltas',
      reason: 'LOCAL_AGENT_PROCESS_FAILED',
    }],
  })

  const restored = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath, now: () => 2000 }),
  })
  const matching = restored.snapshot().messages.filter(message => (
    message.trace?.agentRunId === 'run-existing-terminal:0:codex:agent-1'
  ))
  assert.equal(matching.length, 1)
  assert.equal(
    matching[0].content,
    'Codex failed: LOCAL_AGENT_PROCESS_FAILED\nConclusion recovered from answer deltas',
  )

  const repeated = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath, now: () => 3000 }),
  })
  const repeatedMatching = repeated.snapshot().messages.filter(message => (
    message.trace?.agentRunId === 'run-existing-terminal:0:codex:agent-1'
  ))
  assert.equal(repeatedMatching.length, 1)
  assert.equal(
    repeatedMatching[0].content.match(/Conclusion recovered from answer deltas/g)?.length,
    1,
  )
})

test('restart keeps a long failure prefix aligned with its streamed conclusion', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const longReason = `LOCAL_AGENT_PROCESS_FAILED:${'x'.repeat(1200)}`
  const boundedReason = longReason.slice(0, 1000)
  const conclusion = 'Conclusion streamed before the long failure.'
  options.runLedger = new RunLedger({ storagePath: ledgerPath, now: () => 1000 })
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    runOptions.onEvent({ type: 'answer_delta', status: 'running', delta: conclusion })
    throw new Error(longReason)
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Long failure restart', agentKinds: ['codex'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id, text: 'Fail after streaming', targetKinds: ['codex'],
  })

  const persisted = JSON.parse(fs.readFileSync(options.storagePath, 'utf8'))
  const persistedFailure = persisted.messages.find(message => (
    message.system?.key === 'system.agentCallFailed'
  ))
  const persistedPrefix = `Codex failed: ${persistedFailure.system.params.reason}`
  assert.equal(persistedFailure.system.params.reason, boundedReason)
  assert.equal(persistedFailure.content, `${persistedPrefix}\n${conclusion}`)

  const restored = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath, now: () => 2000 }),
  })
  const restoredFailure = restored.snapshot().messages.find(message => (
    message.system?.key === 'system.agentCallFailed'
  ))
  const restoredPrefix = `Codex failed: ${restoredFailure.system.params.reason}`
  assert.equal(restoredFailure.system.params.reason, persistedFailure.system.params.reason)
  assert.equal(restoredFailure.content.startsWith(`${restoredPrefix}\n`), true)
  assert.equal(restoredFailure.content.includes(conclusion), true)
  assert.equal(restoredFailure.content.indexOf(conclusion), restoredFailure.content.lastIndexOf(conclusion))
})

test('maximum Harness conclusion survives terminal persistence and authoritative restart repair', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const conclusion = 'x'.repeat(20000)
  const prefix = 'Codex failed: LOCAL_AGENT_PROCESS_FAILED'
  options.runLedger = new RunLedger({ storagePath: ledgerPath, now: () => 1000 })
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    for (let offset = 0; offset < conclusion.length; offset += 4000) {
      runOptions.onEvent({
        type: 'answer_delta', status: 'running', delta: conclusion.slice(offset, offset + 4000),
      })
    }
    throw new Error('LOCAL_AGENT_PROCESS_FAILED')
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Maximum terminal conclusion', agentKinds: ['codex'], workdir: directory,
    allowWrite: false,
  })

  await workspace.sendMessage({
    groupId: group.id, text: 'Stream the maximum output', targetKinds: ['codex'],
  })

  const liveFailure = workspace.snapshot().messages.find(message => (
    message.system?.key === 'system.agentCallFailed'
  ))
  assert.equal(liveFailure.content, `${prefix}\n${conclusion}`)
  const persisted = JSON.parse(fs.readFileSync(options.storagePath, 'utf8'))
  const persistedFailure = persisted.messages.find(message => message.id === liveFailure.id)
  assert.equal(persistedFailure.content, liveFailure.content)

  persistedFailure.content = `${prefix}\n${conclusion.slice(0, 250)}`
  fs.writeFileSync(options.storagePath, `${JSON.stringify(persisted, null, 2)}\n`)

  const restored = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath, now: () => 2000 }),
  })
  const restoredFailure = restored.snapshot().messages.find(message => (
    message.trace?.agentRunId === liveFailure.trace.agentRunId
  ))
  assert.equal(restoredFailure.content, `${prefix}\n${conclusion}`)
  const repaired = JSON.parse(fs.readFileSync(options.storagePath, 'utf8'))
  assert.equal(
    repaired.messages.find(message => message.id === liveFailure.id).content,
    restoredFailure.content,
  )

  const repeated = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath, now: () => 3000 }),
  })
  assert.equal(
    repeated.snapshot().messages.find(message => message.id === liveFailure.id).content,
    `${prefix}\n${conclusion}`,
  )
})

test('restart restores only the final failure after superseded Agent attempts', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  const initial = new LocalWorkspace(options)
  await initial.refreshAgents()
  const group = initial.createGroup({
    name: 'Terminal checkpoint recovery', agentKinds: ['codex'], workdir: directory,
  })
  const root = initial.addMessage(group.id, 'user', 'Restore terminal attempts')
  const contextPack = initial.createContextPack({
    group,
    taskId: root.id,
    mode: 'manual',
    targetKinds: ['codex'],
    message: root,
  })
  const ledger = new RunLedger({ storagePath: ledgerPath, now: () => 1000 })
  ledger.checkpoint({
    runId: 'run-terminal',
    taskId: root.id,
    contextPackId: contextPack.contextPackId,
    contextPackState: 'captured',
    groupId: group.id,
    threadRootId: root.id,
    targetKinds: ['codex'],
    status: 'completed',
    agentRuns: [
      { agentRunId: 'agent-completed', kind: 'codex', status: 'completed', output: 'Completed output' },
      { agentRunId: 'agent-partial', kind: 'codex', status: 'partial', output: 'Partial output' },
      { agentRunId: 'agent-failed', kind: 'codex', status: 'failed', output: 'Failure output', reason: 'LOCAL_AGENT_UNKNOWN_FAILURE' },
      { agentRunId: 'agent-failed-other-output', kind: 'codex', status: 'failed', output: 'Distinct failure output', reason: 'LOCAL_AGENT_UNKNOWN_FAILURE' },
      { agentRunId: 'agent-failed-other-reason', kind: 'codex', status: 'failed', reason: 'LOCAL_AGENT_AUTH_FAILED' },
      { agentRunId: 'agent-timeout', kind: 'codex', status: 'timeout', output: 'Timeout output', reason: 'LOCAL_AGENT_TIMEOUT' },
      { agentRunId: 'agent-stopped', kind: 'codex', status: 'stopped', output: 'Stopped output' },
      { agentRunId: 'agent-interrupted', kind: 'codex', status: 'interrupted', output: 'Interrupted output' },
    ],
  })

  const restored = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath, now: () => 2000 }),
  })
  const byAgentRunId = new Map(restored.snapshot().messages
    .filter(message => message.trace?.agentRunId)
    .map(message => [message.trace.agentRunId, message]))

  assert.equal(byAgentRunId.get('agent-completed').role, 'agent')
  assert.equal(byAgentRunId.get('agent-completed').content, 'Completed output')
  assert.equal(byAgentRunId.get('agent-completed').trace.status, 'completed')
  assert.equal(byAgentRunId.get('agent-partial').role, 'agent')
  assert.equal(byAgentRunId.get('agent-partial').content, 'Partial output')
  assert.equal(byAgentRunId.get('agent-partial').trace.status, 'partial')
  assert.equal(byAgentRunId.has('agent-failed'), false)
  assert.equal(byAgentRunId.has('agent-failed-other-output'), false)
  assert.equal(byAgentRunId.has('agent-failed-other-reason'), false)
  assert.equal(byAgentRunId.get('agent-timeout').system.params.reason, 'LOCAL_AGENT_TIMEOUT')
  assert.match(byAgentRunId.get('agent-timeout').content, /Timeout output/)
  assert.equal(byAgentRunId.get('agent-timeout').trace.status, 'timeout')
  assert.equal(byAgentRunId.get('agent-stopped').system.key, 'system.agentStopped')
  assert.equal(byAgentRunId.get('agent-stopped').trace.status, 'stopped')
  assert.equal(byAgentRunId.get('agent-interrupted').system.key, 'system.agentInterrupted')
  assert.equal(byAgentRunId.get('agent-interrupted').trace.status, 'interrupted')

  const repeated = new LocalWorkspace({
    ...options,
    runLedger: new RunLedger({ storagePath: ledgerPath, now: () => 3000 }),
  })
  assert.equal(repeated.snapshot().messages.filter(message => (
    message.trace?.runId === 'run-terminal'
  )).length, 5)
})

test('stopping during output capture prevents the Agent from launching', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const captureEntered = deferred()
  const captureGate = deferred()
  options.runAbortGraceMs = 20
  let captureSignal
  options.captureAgentOutputs = async (_workdir, captureOptions) => {
    captureSignal = captureOptions.signal
    captureEntered.resolve()
    return await captureGate.promise
  }
  const finished = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Stop during capture', agentKinds: ['codex'], workdir: directory, allowWrite: true,
  })

  const send = workspace.sendMessage({ groupId: group.id, text: 'Generate a file' })
  await captureEntered.promise
  const runId = workspace.activeRuns.get(group.id).runId
  assert.equal(workspace.stop(group.id, runId), true)
  await send

  assert.equal(captureSignal.aborted, true)
  assert.equal(calls.length, 0)
  assert.equal(finished[0].status, 'stopped')
  assert.equal(workspace.snapshot().messages.some(message => message.role === 'agent'), false)
  const stoppedTrace = workspace.snapshot().messages.find(message => (
    message.system?.key === 'system.agentStopped' && message.agentKind === 'codex'
  ))
  assert.equal(stoppedTrace.trace.status, 'stopped')
  assert.equal(stoppedTrace.trace.agentRunId.includes(runId), true)
  captureGate.resolve({ marker: 'late capture' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(workspace.snapshot().messages.some(message => message.role === 'agent'), false)
})

test('stopping during output import never persists the late completed reply', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const importEntered = deferred()
  const importGate = deferred()
  options.runAbortGraceMs = 20
  let importSignal
  options.importAgentOutputs = async (input) => {
    importSignal = input.signal
    importEntered.resolve()
    return await importGate.promise
  }
  const finished = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Stop during import', agentKinds: ['codex'], workdir: directory, allowWrite: true,
  })

  const send = workspace.sendMessage({ groupId: group.id, text: 'Generate a file' })
  await importEntered.promise
  const runId = workspace.activeRuns.get(group.id).runId
  assert.equal(workspace.stop(group.id, runId), true)
  await send

  assert.equal(importSignal.aborted, true)
  assert.equal(finished[0].status, 'stopped')
  assert.equal(workspace.snapshot().messages.some(message => message.role === 'agent'), false)
  importGate.resolve([
    { id: 'late-image', name: 'late.png', mimeType: 'image/png', size: 10 },
  ])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(workspace.snapshot().messages.some(message => message.role === 'agent'), false)
})

test('a stopped run keeps the group lock until the Agent cleanup settles', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAbortGraceMs = 100
  const firstStarted = deferred()
  let attempts = 0
  let cleanupFinished = false
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    attempts += 1
    if (attempts > 1) return { text: 'Second run', sessionRef: 'codex-session-2' }
    return await new Promise((resolve, reject) => {
      runOptions.signal.addEventListener('abort', () => {
        setTimeout(() => {
          cleanupFinished = true
          reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED'))
        }, 30)
      }, { once: true })
      firstStarted.resolve()
    })
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Cleanup lock', agentKinds: ['codex'], workdir: directory,
  })

  const firstSend = workspace.sendMessage({ groupId: group.id, text: 'First run' })
  await firstStarted.promise
  const runId = workspace.activeRuns.get(group.id).runId
  assert.equal(workspace.stop(group.id, runId), true)
  await assert.rejects(
    workspace.sendMessage({ groupId: group.id, text: 'Too early' }),
    { message: 'LOCAL_GROUP_RUNNING' },
  )
  await firstSend

  assert.equal(cleanupFinished, true)
  await workspace.sendMessage({ groupId: group.id, text: 'Second run' })
  assert.equal(workspace.snapshot().messages.at(-1).content, 'Second run')
})

test('a stop acknowledgement keeps deletion blocked until run cleanup settles', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const started = deferred()
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => await new Promise((resolve, reject) => {
    started.resolve()
    runOptions.signal.addEventListener('abort', () => {
      setImmediate(() => reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED')))
    }, { once: true })
  })
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Stop then delete', agentKinds: ['codex'], workdir: directory,
  })

  const send = workspace.sendMessage({ groupId: group.id, text: 'Stop this run' })
  await started.promise
  const runId = workspace.activeRuns.get(group.id).runId
  assert.equal(workspace.stop(group.id, runId), true)
  assert.throws(() => workspace.deleteGroup(group.id), { message: 'LOCAL_GROUP_RUNNING' })

  await send
  assert.doesNotThrow(() => workspace.deleteGroup(group.id))
  assert.equal(workspace.snapshot().groups.some(item => item.id === group.id), false)
})

test('a stopped run keeps the group lock until output import cleanup settles', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAbortGraceMs = 100
  const importStarted = deferred()
  let attempts = 0
  let importCleanupFinished = false
  options.importAgentOutputs = async (input) => {
    attempts += 1
    if (attempts > 1) return []
    return await new Promise((resolve) => {
      input.signal.addEventListener('abort', () => {
        setTimeout(() => {
          importCleanupFinished = true
          resolve([])
        }, 30)
      }, { once: true })
      importStarted.resolve()
    })
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Import cleanup lock', agentKinds: ['codex'], workdir: directory, allowWrite: true,
  })

  const firstSend = workspace.sendMessage({ groupId: group.id, text: 'First import' })
  await importStarted.promise
  const runId = workspace.activeRuns.get(group.id).runId
  assert.equal(workspace.stop(group.id, runId), true)
  await assert.rejects(
    workspace.sendMessage({ groupId: group.id, text: 'Too early' }),
    { message: 'LOCAL_GROUP_RUNNING' },
  )
  await firstSend

  assert.equal(importCleanupFinished, true)
  await workspace.sendMessage({ groupId: group.id, text: 'After cleanup' })
  assert.equal(workspace.snapshot().messages.some(message => (
    message.role === 'user' && message.content === 'After cleanup'
  )), true)
})

test('the Agent watchdog covers output capture and import phases', async (t) => {
  const phases = ['capture', 'import']
  for (const phase of phases) {
    await t.test(phase, async (subtest) => {
      const { directory, calls, options } = fixture()
      subtest.after(() => fs.rmSync(directory, { recursive: true, force: true }))
      options.runAgentTimeoutMs = 8
      options.runAbortGraceMs = 20
      if (phase === 'capture') options.captureAgentOutputs = async () => await new Promise(() => {})
      else options.importAgentOutputs = async () => await new Promise(() => {})
      const finished = []
      const workspace = new LocalWorkspace(options)
      workspace.on('run-finished', result => finished.push(result))
      await workspace.refreshAgents()
      const group = workspace.createGroup({
        name: `Watchdog ${phase}`, agentKinds: ['codex'], workdir: directory, allowWrite: true,
      })

      const send = workspace.sendMessage({ groupId: group.id, text: 'Do not hang' })
      if (phase === 'import') {
        const gate = await waitForPendingGate(workspace)
        const request = workspace.humanGateStore.request(gate.gateId)
        assert.equal(gate.type, 'retry')
        assert.equal(request.failureCategory, 'timeout')
        assert.equal(request.sideEffectsPossible, true)
        workspace.decideHumanGate(gate.gateId, {
          status: 'rejected', optionId: 'cancel-retry', actorId: 'local-user',
        })
      }
      await send

      assert.equal(calls.length, phase === 'capture' ? 0 : 1)
      assert.equal(finished[0].status, phase === 'capture' ? 'timeout' : 'stopped')
      if (phase === 'capture') {
        const failure = workspace.snapshot().messages.find(message => (
          message.system?.key === 'system.agentCallFailed'
        ))
        assert.equal(failure.system.params.reason, 'LOCAL_AGENT_TIMEOUT')
        assert.equal(failure.trace.status, 'timeout')
      }
      assert.equal(workspace.snapshot().messages.some(message => message.role === 'agent'), false)
    })
  }
})

test('reset before migration revokes conversation, thread and legacy task sessions only for its Agent', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  const group = { id: 'reset-group', conversationType: 'group' }
  const taskIds = ['legacy-task', 'legacy/task-with-hashed-key']
  workspace.state.messages.push(...taskIds.map(id => ({ id, groupId: group.id, role: 'user', content: 'Prior task' })))
  const revokedKeys = [
    workspace.sessionKey(group.id, 'codex'),
    ...taskIds.map(id => workspace.sessionKey(group.id, 'codex', id)),
    `${group.id}:codex:thread:legacy-root`,
    `${group.id}:task:orphan-task:codex`,
    workspace.sessionKey(group.id, 'codex', 'pending/task'),
  ]
  assert.match(revokedKeys[2], /^session:/)
  const retainedKeys = [workspace.sessionKey(group.id, 'hermes', taskIds[0]), workspace.sessionKey('other-group', 'codex', taskIds[0])]
  for (const key of [...revokedKeys, ...retainedKeys]) {
    workspace.state.sessions[key] = 'legacy-native-session'
    workspace.state.sessionMeta[key] = { turns: 2, estimatedChars: 100 }
  }
  workspace.resetAgentSession(group, 'codex', true, 'pending/task')
  for (const key of revokedKeys) {
    assert.equal(workspace.state.sessions[key], undefined, key)
    assert.equal(workspace.state.sessionMeta[key], undefined, key)
  }
  for (const key of retainedKeys) assert.equal(workspace.state.sessions[key], 'legacy-native-session', key)
  assert.equal(workspace.sessionState(group, 'codex', taskIds[0], taskIds[0]).sessionRef, '')
  assert.equal(workspace.sessionState(group, 'codex', taskIds[1], taskIds[1]).sessionRef, '')
})

test('session references stay opaque and OpenClaw group scopes do not collide', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const privateSessionRef = '/Users/private/token=secret'
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    runOptions.onSessionRef(privateSessionRef)
    return { text: 'Safe reply', sessionRef: privateSessionRef }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Opaque sessions', agentKinds: ['codex'], workdir: directory,
  })

  await workspace.sendMessage({ groupId: group.id, text: 'Keep the session private' })

  const task = workspace.snapshot().messages.find(message => (
    message.role === 'user' && message.content === 'Keep the session private'
  ))
  assert.equal(workspace.state.sessions[workspace.sessionKey(group.id, 'codex')], undefined)
  assert.equal(
    workspace.state.sessions[workspace.sessionKey(group.id, 'codex', task.id)],
    undefined,
  )
  assert.doesNotMatch(fs.readFileSync(options.storagePath, 'utf8'), /Users\/private|token=secret/)
  assert.equal(workspace.persistSessionRef(
    workspace.sessionKey(group.id, 'codex'),
    'sk-abcdefghijklmnop1234',
  ), false)
  const first = workspace.openClawSessionRef({ id: 'group-abcdefghijkl-1' })
  const second = workspace.openClawSessionRef({ id: 'group-abcdefghijkl-2' })
  assert.notEqual(first, second)
  assert.match(first, /^agent:main:desktop-meldwork-[a-f0-9]{20}-openclaw$/)
  assert.match(second, /^agent:main:desktop-meldwork-[a-f0-9]{20}-openclaw$/)

  const legacyGroup = { id: 'group-abcdefghijkl-1' }
  const legacyKey = workspace.sessionKey(legacyGroup.id, 'openclaw')
  workspace.state.sessions[legacyKey] = 'agent:main:desktop-meldwork-groupabcdefg-openclaw'
  workspace.state.sessionMeta[legacyKey] = { turns: 4, estimatedChars: 1200 }
  assert.equal(workspace.sessionRef(legacyGroup, 'openclaw'), first)
  assert.deepEqual(workspace.state.sessionMeta[legacyKey], {
    turns: 4,
    estimatedChars: 1200,
    sessionScope: 'unknown-legacy',
    originTaskId: '',
    inheritedTaskIds: [],
    provenanceCompleteness: 'unknown-legacy',
  })
})

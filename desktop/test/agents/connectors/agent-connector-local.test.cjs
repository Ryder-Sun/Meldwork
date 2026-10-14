const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { createAgentConnectorManifest, serializeAgentConnectorManifest } = require('../../../src/agents/connectors/agent-connector-manifest.cjs')
const { manifestFor } = require('../../../src/agents/cloud/cloud-agent-bridge.cjs')
const { AgentConnectorInstanceStore } = require('../../../src/agents/connectors/agent-connector-instance-store.cjs')
const { isSupportedAgentKind } = require('../../../src/workspace/local-workspace-contracts.cjs')
const {
  LocalAgentConnectors,
  SAMPLE_AGENT_CONNECTOR_MANIFEST,
  SAMPLE_CREDENTIAL_AGENT_CONNECTOR_MANIFEST,
  semanticVersionFrom,
} = require('../../../src/agents/connectors/agent-connector-local.cjs')
const { runAgent } = require('../../../src/agents/cli/cli-adapters.cjs')
const {
  executable,
  readWhenReady,
  within,
} = require('../../support/cli-adapters-test-helpers.cjs')

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`sealed:${value}`, 'utf8'),
    decryptString: value => {
      const text = Buffer.from(value).toString('utf8')
      if (!text.startsWith('sealed:')) throw new Error('ciphertext invalid')
      return text.slice('sealed:'.length)
    },
  }
}

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-agent-connectors-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const calls = []
  const instanceStoragePath = path.join(directory, 'instances.json')
  const credentialStoragePath = path.join(directory, 'private', 'credentials.json')
  const createInstanceStore = () => new AgentConnectorInstanceStore({
    instanceStoragePath,
    credentialStoragePath,
    safeStorage: fakeSafeStorage(),
  })
  const instanceStore = createInstanceStore()
  const connectors = new LocalAgentConnectors({
    manifestDirectory: path.join(directory, 'manifests'),
    instanceStore,
    runAgent: async (...args) => {
      calls.push(args)
      return options.runAgent ? options.runAgent(...args) : {
        text: 'Delegated result', sessionRef: 'codex-session', outcome: 'completed',
      }
    },
    seedSample: options.seedSample,
    cloudBridges: options.cloudBridges,
  })
  return {
    calls,
    connectors,
    createInstanceStore,
    credentialStoragePath,
    directory,
    instanceStore,
    instanceStoragePath,
  }
}

function codex(version = 'codex-cli 0.147.0', executablePath = '/private/bin/codex') {
  return {
    kind: 'codex', name: 'Codex CLI', version, executable: executablePath,
    compatibilityState: 'compatible',
  }
}

test('production bootstrap does not add the sample Agent unless it was explicitly installed', (t) => {
  const { connectors, directory } = fixture(t)
  assert.deepEqual(connectors.refresh([codex()]), [])
  assert.deepEqual(connectors.catalog(), [])
  assert.deepEqual(fs.readdirSync(path.join(directory, 'manifests')), [])
})

test('discovers an explicitly installed approved sample and exposes generic sanitized catalog metadata', async (t) => {
  const { calls, connectors } = fixture(t, { seedSample: true })
  assert.deepEqual(connectors.refresh([codex()]), [])
  const configured = connectors.configure({
    manifestId: SAMPLE_AGENT_CONNECTOR_MANIFEST.manifestId,
    label: 'Codex review account',
    credentials: null,
  })
  const [agent] = connectors.detectAgents()
  assert.equal(agent.kind, configured.instanceId)
  assert.match(agent.kind, /^custom-[a-f0-9]{16}$/)
  assert.equal(isSupportedAgentKind(agent.kind), true)
  assert.equal(agent.connectorId, SAMPLE_AGENT_CONNECTOR_MANIFEST.connectorId)
  assert.equal(agent.upstreamVersion, '0.147.0')
  assert.equal(agent.credentialConfigured, false)
  assert.equal(Object.hasOwn(agent, 'executable'), false)
  assert.equal(Object.hasOwn(agent, 'credentialRef'), false)
  const [catalog] = connectors.catalog()
  assert.equal(catalog.kind, agent.kind)
  assert.equal(catalog.connector, true)
  assert.equal(catalog.description, SAMPLE_AGENT_CONNECTOR_MANIFEST.description)
  assert.doesNotMatch(JSON.stringify(catalog), /private\/bin|credential-ref/i)

  const result = await connectors.run(agent, 'Review this', '/tmp/workspace', {
    runId: 'run-1', agentRunId: 'agent-run-1', sandbox: 'read-only',
  })
  assert.equal(result.outcome, 'completed')
  assert.equal(result.text, 'Delegated result')
  assert.equal(result.connector.connectorVersion, '1.0.0')
  assert.equal(result.connector.upstreamVersion, '0.147.0')
  assert.equal(Object.hasOwn(result.connector, 'credentialRefId'), false)
  assert.deepEqual(result.connectorEventState.events.map(event => event.type), ['Completed'])
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0].executable, '/private/bin/codex')
  assert.equal(calls[0][3].sandbox, 'read-only')
})

test('discovers and runs an Agent exposed by a Cloud Agent Bridge', async (t) => {
  const record = {
    bridgeId: 'cloud-bridge-0123456789abcdef01234567',
    address: 'https://203.0.113.10:8443',
    label: 'Research server',
    available: true,
  }
  const agent = {
    id: 'codex', sourceKind: 'codex', label: 'Codex CLI', version: '0.146.1', description: '',
    credentialState: 'ready',
    domains: ['general'], inputTypes: ['text'], permissionModes: ['read-only'],
    session: { supported: true, resume: true, cancel: true, checkpoint: false },
  }
  const manifest = manifestFor(record, agent)
  const entry = {
    record, agent, manifest,
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
  let cloudRunInput
  const { connectors } = fixture(t, {
    cloudBridges: {
      connectorEntries: () => [entry],
      bridgeForInstance: instanceId => instanceId === entry.instance.instanceId ? entry : null,
      run: async (input) => {
        cloudRunInput = input
        return { text: 'cloud reply', outcome: 'completed' }
      },
    },
  })
  const [detected] = connectors.refresh([])
  assert.equal(detected.cloud, true)
  assert.equal(isSupportedAgentKind(detected.kind), true)
  const cloudCatalog = connectors.catalog()[0]
  assert.equal(cloudCatalog.cloud, true)
  assert.equal(cloudCatalog.custom, false)
  assert.equal(cloudCatalog.sourceKind, 'codex')
  assert.equal(cloudCatalog.version, '0.146.1')
  assert.equal(cloudCatalog.credentialState, 'ready')
  const result = await connectors.run(detected, 'hello cloud', '/tmp/workspace', {
    runId: 'run-cloud-1', agentRunId: 'agent-cloud-1', operationId: 'operation-cloud-1', sandbox: 'read-only',
  })
  assert.equal(result.text, 'cloud reply')
  assert.equal(result.outcome, 'completed')
  assert.equal(cloudRunInput.permissionMode, 'read-only')
  assert.deepEqual(result.connectorEventState.events.map(event => event.type), ['Completed'])
})

test('runs a Codex Agent discovered through SSH without declaring an HTTP outbound destination', async (t) => {
  const record = {
    bridgeId: 'cloud-bridge-0123456789abcdef01234567',
    transport: 'ssh',
    address: '10.1.132.21',
    label: 'Research server',
    available: true,
  }
  const agent = {
    id: 'codex', label: 'Codex CLI', version: '0.121.0', description: '',
    domains: ['general'], inputTypes: ['text'], permissionModes: ['read-only'],
    session: { supported: false, resume: false, cancel: true, checkpoint: false },
  }
  const manifest = manifestFor(record, agent)
  const entry = {
    record, agent, manifest,
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
  const { connectors } = fixture(t, {
    cloudBridges: {
      connectorEntries: () => [entry],
      bridgeForInstance: instanceId => instanceId === entry.instance.instanceId ? entry : null,
      run: async () => ({ text: 'SSH reply', outcome: 'completed' }),
    },
  })
  const [detected] = connectors.refresh([])
  const result = await connectors.run(detected, 'hello SSH', '/tmp/workspace', {
    runId: 'run-cloud-ssh-1', agentRunId: 'agent-cloud-ssh-1', operationId: 'operation-cloud-ssh-1', sandbox: 'read-only',
  })
  assert.equal(result.text, 'SSH reply')
  assert.deepEqual(result.connectorEventState.events.map(event => event.type), ['Completed'])
})

test('delegated local Connector receives a streaming profile event before completion', async (t) => {
  const releaseFile = path.join(os.tmpdir(), `meldwork-connector-release-${process.pid}-${Date.now()}`)
  t.after(async () => {
    try { fs.writeFileSync(releaseFile, 'release') } catch { /* test cleanup */ }
    await new Promise(resolve => setTimeout(resolve, 30))
    fs.rmSync(releaseFile, { force: true })
  })
  const { connectors, directory } = fixture(t, { seedSample: true, runAgent })
  const cli = executable(directory, 'delegated-codex.cjs', `
const fs = require('node:fs')
const start = {
  type: 'item.started',
  item: {
    id: 'delegated-tool', type: 'command_execution',
    command: 'rg target /Users/private/workspace', status: 'in_progress',
  },
}
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'delegated-session' }) + '\\n')
process.stdout.write(JSON.stringify(start) + '\\n')
const finish = () => {
  if (!fs.existsSync(${JSON.stringify(releaseFile)})) return setTimeout(finish, 10)
  process.stdout.write(JSON.stringify({
    type: 'item.completed',
    item: {
      ...start.item, aggregated_output: 'one match', exit_code: 0, status: 'completed',
    },
  }) + '\\n')
  process.stdout.write(JSON.stringify({
    type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'Delegated result' },
  }) + '\\n')
  process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n')
}
finish()
`)
  connectors.refresh([codex('codex-cli 0.147.0', cli)])
  connectors.configure({
    manifestId: SAMPLE_AGENT_CONNECTOR_MANIFEST.manifestId,
    label: 'Codex delegated runtime',
    credentials: null,
  })
  const [agent] = connectors.detectAgents()
  const events = []
  let firstRuntimeEventResolve
  const firstRuntimeEvent = new Promise(resolve => { firstRuntimeEventResolve = resolve })
  let resultResolved = false
  const resultPromise = connectors.run(agent, 'Review this', directory, {
    runId: 'run-runtime-event',
    agentRunId: 'agent-run-runtime-event',
    sandbox: 'read-only',
    onEvent: event => {
      events.push(event)
      if (event.type === 'tool_start') firstRuntimeEventResolve(event)
    },
  }).then((result) => {
    resultResolved = true
    return result
  })

  const runtimeEvent = await within(firstRuntimeEvent)
  assert.equal(resultResolved, false)
  assert.deepEqual(runtimeEvent, {
    id: 'delegated-tool',
    type: 'tool_start',
    title: 'search',
    status: 'running',
    summary: 'Bash: operation: command',
  })
  assert.doesNotMatch(JSON.stringify(runtimeEvent), /Users|private|workspace|\brg\b|-n/)
  fs.writeFileSync(releaseFile, 'release')
  const result = await resultPromise
  assert.equal(result.text, 'Delegated result')
  assert.equal(result.connectorEventState.status, 'completed')
  assert.equal(events[0], runtimeEvent)
})

test('delegated local Connector keeps a final-only profile silent until close', async (t) => {
  const { connectors, directory } = fixture(t, {
    seedSample: true,
    runAgent: (upstream, prompt, workdir, options) => runAgent({
      ...upstream,
      kind: 'opencodereview',
      executable: finalOnlyCli,
      name: 'OpenCodeReview',
    }, prompt, workdir, options),
  })
  const readyFile = path.join(directory, 'final-only-ready')
  const releaseFile = path.join(directory, 'final-only-release')
  const finalOnlyCli = executable(directory, 'delegated-final-only.cjs', `
const fs = require('node:fs')
process.stdout.write(JSON.stringify({
  status: 'complete', message: 'Delegated final result', comments: [],
  manifest: { schema_version: 'ocr.run-manifest/v1', operation: 'review', terminal_state: 'complete' },
}))
fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready')
const finish = () => {
  if (!fs.existsSync(${JSON.stringify(releaseFile)})) return setTimeout(finish, 10)
}
finish()
`)
  t.after(() => {
    try { fs.writeFileSync(releaseFile, 'release') } catch { /* test cleanup */ }
  })
  connectors.refresh([codex()])
  connectors.configure({
    manifestId: SAMPLE_AGENT_CONNECTOR_MANIFEST.manifestId,
    label: 'Final-only delegated runtime',
    credentials: null,
  })
  const [agent] = connectors.detectAgents()
  const events = []
  let resultResolved = false
  const resultPromise = connectors.run(agent, 'Review this', directory, {
    runId: 'run-final-only',
    agentRunId: 'agent-run-final-only',
    sandbox: 'read-only',
    onEvent: event => events.push(event),
  }).then((result) => {
    resultResolved = true
    return result
  })

  await readWhenReady(readyFile)
  assert.equal(resultResolved, false)
  assert.equal(events.some(event => event.type === 'answer_delta'), false)
  fs.writeFileSync(releaseFile, 'release')
  const result = await resultPromise

  assert.equal(result.text, 'Delegated final result')
  assert.equal(result.connectorEventState.status, 'completed')
  assert.deepEqual(events.filter(event => event.type === 'answer_delta'), [{
    type: 'answer_delta', status: 'completed', delta: 'Delegated final result',
  }])
})

test('delegate failures preserve the upstream classification in the terminal Connector state', async (t) => {
  const upstreamError = Object.assign(new Error('LOCAL_AGENT_AUTH_REQUIRED'), {
    code: 'LOCAL_AGENT_AUTH_REQUIRED',
    failure: {
      code: 'LOCAL_AGENT_AUTH_REQUIRED',
      category: 'authentication',
      retryable: true,
    },
  })
  const { connectors } = fixture(t, {
    seedSample: true,
    runAgent: async () => { throw upstreamError },
  })
  connectors.refresh([codex()])
  connectors.configure({
    manifestId: SAMPLE_AGENT_CONNECTOR_MANIFEST.manifestId,
    label: 'Codex review account',
    credentials: null,
  })
  const [agent] = connectors.detectAgents()
  const result = await connectors.run(agent, 'Review this', '/tmp/workspace', {
    runId: 'run-2', agentRunId: 'agent-run-2', sandbox: 'read-only',
  })
  assert.equal(result.outcome, 'failed')
  assert.deepEqual(result.failure, {
    code: 'LOCAL_AGENT_AUTH_REQUIRED', category: 'authentication', retryable: true,
  })
  assert.equal(result.connectorEventState.status, 'failed')
  assert.deepEqual(result.connectorEventState.events.map(event => ({
    type: event.type,
    code: event.code,
    category: event.category,
    retryable: event.retryable,
  })), [{
    type: 'Failed',
    code: 'LOCAL_AGENT_AUTH_REQUIRED',
    category: 'authentication',
    retryable: true,
  }])
  assert.doesNotMatch(JSON.stringify(result), /LOCAL_AGENT_INCOMPLETE_RESPONSE/)
})

test('untrusted and incompatible local Manifests fail closed', (t) => {
  const { connectors, directory, instanceStore } = fixture(t)
  const manifestDirectory = path.join(directory, 'manifests')
  fs.mkdirSync(manifestDirectory, { recursive: true })
  const {
    manifestId: _manifestId,
    schemaVersion: _schemaVersion,
    recordType: _recordType,
    ...sampleInput
  } = SAMPLE_AGENT_CONNECTOR_MANIFEST
  const untrusted = createAgentConnectorManifest({
    ...sampleInput,
    connectorId: 'external.untrusted',
  })
  fs.writeFileSync(
    path.join(manifestDirectory, `${untrusted.manifestId}.json`),
    serializeAgentConnectorManifest(untrusted),
  )
  fs.writeFileSync(
    path.join(manifestDirectory, `${SAMPLE_AGENT_CONNECTOR_MANIFEST.manifestId}.json`),
    serializeAgentConnectorManifest(SAMPLE_AGENT_CONNECTOR_MANIFEST),
  )
  instanceStore.create({
    manifestId: SAMPLE_AGENT_CONNECTOR_MANIFEST.manifestId,
    connectorId: SAMPLE_AGENT_CONNECTOR_MANIFEST.connectorId,
    connectorVersion: SAMPLE_AGENT_CONNECTOR_MANIFEST.connectorVersion,
    label: 'Incompatible Codex account',
    credentials: null,
  })
  assert.deepEqual(connectors.refresh([codex('codex-cli 1000000.0.0')]), [])
  assert.equal(connectors.diagnostics().some(item => (
    item.code === 'AGENT_CONNECTOR_MANIFEST_UNTRUSTED'
  )), true)
  assert.equal(connectors.diagnostics().some(item => (
    item.code === 'AGENT_CONNECTOR_UPSTREAM_INCOMPATIBLE'
  )), true)
  assert.equal(semanticVersionFrom('not a version'), '')
})

test('restores multiple credential-bearing accounts and drops invalid references', async (t) => {
  const {
    calls, connectors, createInstanceStore, credentialStoragePath, directory,
  } = fixture(t, { seedSample: true })
  connectors.refresh([codex()])
  const first = connectors.configure({
    manifestId: SAMPLE_CREDENTIAL_AGENT_CONNECTOR_MANIFEST.manifestId,
    label: 'Codex account A',
    credentials: { 'openai-api-key': 'connector-secret-a' },
  })
  const second = connectors.configure({
    manifestId: SAMPLE_CREDENTIAL_AGENT_CONNECTOR_MANIFEST.manifestId,
    label: 'Codex account B',
    credentials: { 'openai-api-key': 'connector-secret-b' },
  })
  assert.notEqual(first.instanceId, second.instanceId)
  assert.equal(first.credentialConfigured, true)
  assert.equal(second.credentialConfigured, true)
  assert.doesNotMatch(JSON.stringify(connectors.list()), /credential-ref|connector-secret/i)

  const restarted = new LocalAgentConnectors({
    manifestDirectory: path.join(directory, 'manifests'),
    instanceStore: createInstanceStore(),
    runAgent: connectors.runAgent,
  })
  const agents = restarted.refresh([codex()])
  assert.deepEqual(agents.map(agent => agent.label), ['Codex account A', 'Codex account B'])
  assert.equal(agents.every(agent => agent.credentialConfigured), true)

  await restarted.run(agents[0], 'Review this', '/tmp/workspace', {
    runId: 'run-3', agentRunId: 'agent-run-3', sandbox: 'read-only',
  })
  assert.equal(calls.at(-1)[3].env.OPENAI_API_KEY, 'connector-secret-a')
  assert.equal(calls.at(-1)[3].connectorCredentialIsolation, true)
  assert.equal(Object.hasOwn(calls.at(-1)[3], 'credentialRefId'), false)

  const records = createInstanceStore().listRecords()
  const firstRecord = records.find(item => item.instanceId === first.instanceId)
  const credentialDocument = JSON.parse(fs.readFileSync(credentialStoragePath, 'utf8'))
  credentialDocument.credentials[firstRecord.credentialRef].encrypted = 'not-base64'
  fs.writeFileSync(credentialStoragePath, JSON.stringify(credentialDocument))
  const remaining = restarted.refresh([codex()])
  assert.deepEqual(remaining.map(agent => agent.label), ['Codex account B'])
  assert.equal(restarted.diagnostics().some(item => (
    item.code === 'AGENT_CONNECTOR_CREDENTIAL_UNAVAILABLE'
  )), true)

  restarted.delete(second.instanceId)
  assert.deepEqual(restarted.detectAgents(), [])
})

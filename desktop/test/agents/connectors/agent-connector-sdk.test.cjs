const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { outboundWirePayloadBytes } = require('../../../src/collaboration/outbound-payload.cjs')
const { LocalWorkspace } = require('../../../src/workspace/local-workspace.cjs')
const { fixture: workspaceFixture } = require('../../support/local-workspace-test-helpers.cjs')

const { AgentConnectorInstanceStore } = require('../../../src/agents/connectors/agent-connector-instance-store.cjs')
const { createAgentConnectorManifest } = require('../../../src/agents/connectors/agent-connector-manifest.cjs')
const {
  AgentConnectorPackageStore,
  SDK_HTTP_JSON_RECIPE_ID,
  createAgentConnectorPackage,
  serializeAgentConnectorPackage,
} = require('../../../src/agents/connectors/agent-connector-package-store.cjs')
const {
  LocalAgentConnectors,
  SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE,
} = require('../../../src/agents/connectors/agent-connector-local.cjs')

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`sealed:${value}`, 'utf8'),
    decryptString: value => Buffer.from(value).toString('utf8').slice('sealed:'.length),
  }
}

function fixture(t, fetch) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-connector-sdk-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const packageStore = new AgentConnectorPackageStore({
    rootPath: path.join(directory, 'private', 'packages'),
  })
  const delegatedCalls = []
  const connectors = new LocalAgentConnectors({
    manifestDirectory: path.join(directory, 'manifests'),
    packageStore,
    instanceStore: new AgentConnectorInstanceStore({
      instanceStoragePath: path.join(directory, 'instances.json'),
      credentialStoragePath: path.join(directory, 'private', 'credentials.json'),
      safeStorage: fakeSafeStorage(),
    }),
    fetch,
    runAgent: async (...args) => {
      delegatedCalls.push(args)
      return { text: 'unexpected delegation', outcome: 'completed' }
    },
  })
  return { connectors, delegatedCalls, directory, packageStore }
}

function install(store, packageRecord, filename = 'connector.json') {
  store.import(serializeAgentConnectorPackage(packageRecord), filename)
  store.approve(packageRecord.packageId)
  store.install(packageRecord.packageId)
}

function httpPackage() {
  const manifest = createAgentConnectorManifest({
    connectorId: 'external.http-json-test',
    connectorVersion: '1.0.0',
    kind: 'agent',
    label: 'HTTP JSON Test',
    description: 'Conformance fixture for the bounded HTTP JSON provider.',
    transport: { type: 'http', protocol: 'json' },
    upstream: { id: 'meldwork-sdk', minVersion: '1.0.0', maxVersion: '1.0.0' },
    invocation: { recipeId: SDK_HTTP_JSON_RECIPE_ID },
    domains: ['general'],
    session: { supported: true, resume: true, cancel: true, checkpoint: false },
    inputTypes: ['text'],
    permissionModes: ['read-only'],
    eventProtocolVersion: 1,
    eventTypes: ['Completed', 'Failed', 'Cancelled'],
    usage: {
      inputTokens: false, outputTokens: false, costMicros: false,
      toolCalls: false, outboundBytes: false, elapsedMs: false,
    },
    outboundDestinations: ['https://connector.example.com'],
    credentials: {
      mode: 'credential-ref',
      slots: [{ slotId: 'access-token', type: 'token', required: true }],
    },
    license: 'MIT',
  })
  return createAgentConnectorPackage({
    publisher: { id: 'example.publisher', name: 'Example Publisher' },
    provider: {
      id: SDK_HTTP_JSON_RECIPE_ID,
      config: {
        endpoint: 'https://connector.example.com/v1/run',
        authSlotId: 'access-token',
      },
    },
    manifest,
  })
}

test('installs and runs the non-delegate local echo sample end to end', async (t) => {
  const { connectors, delegatedCalls, directory, packageStore } = fixture(t)
  install(packageStore, SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE, 'local-echo.connector.json')
  connectors.refresh([])
  const configured = connectors.configure({
    manifestId: SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE.manifest.manifestId,
    label: 'Local echo',
    credentials: null,
  })
  const [agent] = connectors.detectAgents()
  assert.equal(agent.kind, configured.instanceId)
  assert.equal(agent.upstreamVersion, '1.0.0')
  const result = await connectors.run(agent, 'echo this', directory, {
    runId: 'run-echo', agentRunId: 'agent-run-echo', sandbox: 'read-only',
  })
  assert.equal(result.text, 'echo this')
  assert.equal(result.outcome, 'completed')

  const resumed = await connectors.run(agent, 'ignored', directory, {
    runId: 'run-resume', agentRunId: 'agent-run-resume', sandbox: 'read-only',
    connectorResume: {
      type: 'input', requestId: 'request-1', response: 'resumed text',
      requestHash: 'a'.repeat(64), sessionRefHash: 'b'.repeat(64),
      sessionProvenanceHash: 'c'.repeat(64),
    },
  })
  assert.equal(resumed.text, 'resumed text')

  const controller = new AbortController()
  controller.abort()
  const cancelled = await connectors.run(agent, 'cancel', directory, {
    runId: 'run-cancel', agentRunId: 'agent-run-cancel', sandbox: 'read-only',
    signal: controller.signal,
  })
  assert.equal(cancelled.outcome, 'cancelled')
  assert.equal((await connectors.test(agent.kind, directory)).passed, true)
  assert.equal(delegatedCalls.length, 0)
  await assert.rejects(connectors.run(agent, 'write', directory, {
    runId: 'run-write', agentRunId: 'agent-run-write', sandbox: 'workspace-write',
  }), { message: 'AGENT_CONNECTOR_PERMISSION_MODE_UNSUPPORTED' })
})

test('HTTP JSON provider enforces destinations, credentials, cancellation, and failure semantics', async (t) => {
  const calls = []
  const { connectors, directory, packageStore } = fixture(t, async (url, options) => {
    calls.push({ url, options })
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ text: 'remote result', sessionRef: 'remote-session' }),
    }
  })
  const packageRecord = httpPackage()
  assert.throws(() => createAgentConnectorPackage({
    publisher: packageRecord.publisher,
    provider: {
      ...packageRecord.provider,
      config: {
        ...packageRecord.provider.config,
        endpoint: 'https://connector.example.com/v1/run?token=hidden',
      },
    },
    manifest: packageRecord.manifest,
  }), { message: 'AGENT_CONNECTOR_PACKAGE_SCHEMA_INVALID' })
  install(packageStore, packageRecord, 'http.connector.json')
  connectors.refresh([])
  const configured = connectors.configure({
    manifestId: packageRecord.manifest.manifestId,
    label: 'HTTP account',
    credentials: { 'access-token': 'private-token' },
  })
  const [agent] = connectors.detectAgents()
  let recordedOutbound
  const result = await connectors.run(agent, 'remote prompt', directory, {
    runId: 'run-http', agentRunId: 'agent-run-http', sandbox: 'read-only',
    onOutboundPayload: value => { recordedOutbound = value },
  })
  assert.equal(result.text, 'remote result')
  assert.equal(calls[0].url, 'https://connector.example.com/v1/run')
  assert.equal(calls[0].options.redirect, 'error')
  assert.equal(calls[0].options.headers.authorization, 'Bearer private-token')
  assert.doesNotMatch(JSON.stringify(result), /private-token|credential-ref/i)
  assert.equal(JSON.parse(calls[0].options.body).prompt, 'remote prompt')
  assert.equal(outboundWirePayloadBytes(recordedOutbound).toString('utf8'), calls[0].options.body)
  assert.doesNotMatch(outboundWirePayloadBytes(recordedOutbound).toString('utf8'), /private-token/)

  const rejected = await connectors.run(agent, 'blocked', directory, {
    runId: 'run-blocked', agentRunId: 'agent-run-blocked', sandbox: 'read-only',
    onOutboundPayload: async () => {
      await new Promise(resolve => setImmediate(resolve))
      throw new Error('OUTBOUND_RECORD_FAILED')
    },
  })
  assert.equal(rejected.outcome, 'failed')
  assert.equal(calls.length, 1)

  connectors.fetch = async () => ({ ok: false, status: 503, text: async () => '' })
  const failed = await connectors.run(agent, 'fail', directory, {
    runId: 'run-fail', agentRunId: 'agent-run-fail', sandbox: 'read-only',
  })
  assert.deepEqual(failed.failure, {
    code: 'AGENT_CONNECTOR_HTTP_FAILED', category: 'execution', retryable: true,
  })

  connectors.fetch = async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) }
  const controller = new AbortController()
  controller.abort()
  const cancelled = await connectors.run(agent, 'cancel', directory, {
    runId: 'run-http-cancel', agentRunId: 'agent-run-http-cancel',
    sandbox: 'read-only', signal: controller.signal,
  })
  assert.equal(cancelled.outcome, 'cancelled')
  assert.equal(configured.credentialConfigured, true)
})

test('HTTP Connector completes a workspace chat with verified outbound bytes', async t => {
  const requests = []
  const { connectors, packageStore } = fixture(t, async (_url, options) => {
    requests.push(options)
    return { ok: true, status: 200, text: async () => JSON.stringify({ text: 'real connector reply' }) }
  })
  const packageRecord = httpPackage()
  install(packageStore, packageRecord)
  connectors.refresh([])
  connectors.configure({ manifestId: packageRecord.manifest.manifestId,
    label: 'HTTP account', credentials: { 'access-token': 'private-token' } })
  const [agent] = connectors.detectAgents()
  const { directory, options } = workspaceFixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = (_agent, prompt, workdir, runOptions) => connectors.run(agent, prompt, workdir, {
    ...runOptions, runId: 'run-http-workspace', agentRunId: 'agent-run-http-workspace',
  })
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({ name: 'HTTP workspace', agentKinds: ['codex'], workdir: directory, allowWrite: false })
  await workspace.sendMessage({ groupId: group.id, text: 'Test connector', targetKinds: ['codex'] })
  const message = workspace.snapshot().messages.find(item => item.role === 'agent')
  assert.equal(message?.content, 'real connector reply', JSON.stringify(workspace.snapshot().messages))
  const delivery = workspace.contextPackStore.getDelivery(message.trace.context.deliveryRecordIds[0])
  assert.equal(workspace.contentBlobStore.read(delivery.wirePayloadRef).toString('utf8'), requests[0].body)
  assert.equal(workspace.contextPacks.compareDelivery(delivery.deliveryRecordId).status, 'match')
  assert.doesNotMatch(requests[0].body, /private-token/)
})

test('disable, reinstall, revoke, and remove fail closed around configured instances', (t) => {
  const { connectors, packageStore } = fixture(t)
  const packageRecord = SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE
  install(packageStore, packageRecord)
  connectors.refresh([])
  const configured = connectors.configure({
    manifestId: packageRecord.manifest.manifestId,
    label: 'Lifecycle echo',
    credentials: null,
  })
  assert.equal(connectors.disablePackage(packageRecord.packageId).state, 'disabled')
  assert.deepEqual(connectors.detectAgents(), [])
  assert.equal(connectors.installPackage(packageRecord.packageId).state, 'installed')
  assert.deepEqual(connectors.detectAgents().map(agent => agent.kind), [configured.instanceId])
  assert.equal(connectors.revokePackage(packageRecord.packageId).state, 'revoked')
  assert.deepEqual(connectors.detectAgents(), [])
  assert.throws(() => connectors.removePackage(packageRecord.packageId), {
    message: 'AGENT_CONNECTOR_PACKAGE_IN_USE',
  })
  connectors.delete(configured.instanceId)
  assert.equal(connectors.removePackage(packageRecord.packageId).state, 'removed')
})

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const http = require('node:http')
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

function fixture(t, fetch, extra = {}) {
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
    ...extra,
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

function httpPackage(sessionOverrides = {}) {
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
    session: { supported: true, resume: true, cancel: true, checkpoint: false, ...sessionOverrides },
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

test('concurrent HTTP Connector accounts use only their own credentials at the transport boundary', async t => {
  const requests = []
  const previous = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = 'unrelated-global-provider-secret'
  t.after(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous })
  const { connectors, directory, packageStore } = fixture(t, async (_url, options) => {
    requests.push({ prompt: JSON.parse(options.body).prompt, authorization: options.headers.authorization })
    return { ok: true, text: async () => JSON.stringify({ text: 'done' }) }
  })
  const pkg = httpPackage()
  install(packageStore, pkg)
  connectors.refresh([])
  const first = connectors.configure({ manifestId: pkg.manifest.manifestId, label: 'Account A',
    credentials: { 'access-token': 'account-a-secret' } })
  const second = connectors.configure({ manifestId: pkg.manifest.manifestId, label: 'Account B',
    credentials: { 'access-token': 'account-b-secret' } })
  const agents = connectors.detectAgents()
  const agentA = agents.find(agent => agent.kind === first.instanceId)
  const agentB = agents.find(agent => agent.kind === second.instanceId)
  assert.ok(agentA && agentB)
  const results = await Promise.all([
    connectors.run(agentA, 'prompt-a', directory, { runId: 'run-a', agentRunId: 'agent-a', sandbox: 'read-only' }),
    connectors.run(agentB, 'prompt-b', directory, { runId: 'run-b', agentRunId: 'agent-b', sandbox: 'read-only' }),
  ])
  assert.deepEqual(requests.sort((a, b) => a.prompt.localeCompare(b.prompt)), [
    { prompt: 'prompt-a', authorization: 'Bearer account-a-secret' },
    { prompt: 'prompt-b', authorization: 'Bearer account-b-secret' },
  ])
  assert.doesNotMatch(JSON.stringify(results), /account-[ab]-secret|unrelated-global-provider-secret/)
})

test('HTTP transport timeout starts after outbound recording', async t => {
  let requestSignal
  const { connectors, directory, packageStore } = fixture(t, async (_url, { signal }) => {
    requestSignal = signal
    return { ok: true, text: async () => JSON.stringify({ text: 'completed' }) }
  }, { httpTimeoutMs: 30 })
  const pkg = httpPackage()
  install(packageStore, pkg)
  connectors.refresh([])
  connectors.configure({ manifestId: pkg.manifest.manifestId, label: 'Slow record', credentials: { 'access-token': 'private-token' } })
  const [agent] = connectors.detectAgents()
  const result = await connectors.run(agent, 'request', directory, {
    runId: 'run-slow-record', agentRunId: 'agent-run-slow-record', sandbox: 'read-only',
    onOutboundPayload: () => new Promise(resolve => setTimeout(resolve, 60)),
  })
  assert.equal(requestSignal.aborted, false)
  assert.equal(result.outcome, 'completed')
  assert.equal(result.text, 'completed')
  const auditDirectory = path.join(directory, 'private', 'agent-connector-executions')
  const [auditName] = fs.readdirSync(auditDirectory)
  const audit = JSON.parse(fs.readFileSync(path.join(auditDirectory, auditName), 'utf8'))
  assert.equal(audit.runId, 'run-slow-record')
  assert.equal(audit.recipeId, SDK_HTTP_JSON_RECIPE_ID)
  assert.match(audit.credentialRefId, /^credential-ref:/)
  assert.doesNotMatch(JSON.stringify(result), /credential-ref|private-token/)
})

test('HTTP transport does not send when stopped during outbound recording', async t => {
  let sent = false
  const { connectors, directory, packageStore } = fixture(t, async () => { sent = true })
  const pkg = httpPackage()
  install(packageStore, pkg)
  connectors.refresh([])
  connectors.configure({ manifestId: pkg.manifest.manifestId, label: 'Stopped record', credentials: { 'access-token': 'private-token' } })
  const [agent] = connectors.detectAgents()
  const controller = new AbortController()
  const result = await connectors.run(agent, 'request', directory, {
    runId: 'run-stopped-record', agentRunId: 'agent-run-stopped-record', sandbox: 'read-only',
    signal: controller.signal,
    onOutboundPayload: () => { controller.abort() },
  })
  assert.equal(sent, false)
  assert.equal(result.outcome, 'cancelled')
})

test('HTTP transport stops while outbound recording remains pending', async t => {
  let sent = false
  let entered
  const recording = new Promise(resolve => { entered = resolve })
  const { connectors, directory, packageStore } = fixture(t, async () => { sent = true })
  const pkg = httpPackage()
  install(packageStore, pkg)
  connectors.refresh([])
  connectors.configure({ manifestId: pkg.manifest.manifestId, label: 'Pending record', credentials: { 'access-token': 'private-token' } })
  const [agent] = connectors.detectAgents()
  const controller = new AbortController()
  const pending = connectors.run(agent, 'request', directory, {
    runId: 'run-pending-record', agentRunId: 'agent-run-pending-record', sandbox: 'read-only',
    signal: controller.signal,
    onOutboundPayload: () => { entered(); return new Promise(() => {}) },
  })
  await recording
  controller.abort()
  const result = await pending
  assert.equal(sent, false)
  assert.equal(result.outcome, 'cancelled')
})

for (const action of ['disable', 'revoke', 'disable-and-reinstall', 'delete-instance']) {
  test(`HTTP transport does not send after ${action} during outbound recording`, async t => {
    let sent = false
    const { connectors, directory, packageStore } = fixture(t, async () => { sent = true })
    const pkg = httpPackage()
    install(packageStore, pkg)
    connectors.refresh([])
    connectors.configure({ manifestId: pkg.manifest.manifestId, label: 'Revoked account',
      credentials: { 'access-token': 'private-token' } })
    const [agent] = connectors.detectAgents()
    const result = await connectors.run(agent, 'request', directory, {
      runId: `run-${action}`, agentRunId: `agent-${action}`, sandbox: 'read-only',
      onOutboundPayload: () => {
        if (action === 'delete-instance') connectors.delete(agent.kind)
        else if (action === 'revoke') connectors.revokePackage(pkg.packageId)
        else {
          connectors.disablePackage(pkg.packageId)
          if (action === 'disable-and-reinstall') connectors.installPackage(pkg.packageId)
        }
      },
    })
    assert.equal(sent, false)
    assert.equal(result.outcome, 'failed')
    assert.doesNotMatch(JSON.stringify(result), /private-token/)
  })
}

for (const action of ['disable', 'revoke', 'delete-instance']) {
  test(`HTTP transport aborts an active request after ${action} and reports an unknown outcome`, async t => {
    let started
    const entered = new Promise(resolve => { started = resolve })
    let observedAbort = false
    const { connectors, directory, packageStore } = fixture(t, (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        observedAbort = true
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      }, { once: true })
      started()
    }))
    const pkg = httpPackage()
    install(packageStore, pkg)
    connectors.refresh([])
    connectors.configure({ manifestId: pkg.manifest.manifestId, label: 'Active account',
      credentials: { 'access-token': 'private-token' } })
    const [agent] = connectors.detectAgents()
    const pending = connectors.run(agent, 'request', directory, {
      runId: `run-active-${action}`, agentRunId: `agent-active-${action}`, sandbox: 'read-only',
    })
    await entered
    if (action === 'delete-instance') connectors.delete(agent.kind)
    else if (action === 'revoke') connectors.revokePackage(pkg.packageId)
    else connectors.disablePackage(pkg.packageId)
    const result = await pending
    assert.equal(observedAbort, true)
    assert.equal(result.outcome, 'failed')
    assert.deepEqual(result.failure, { code: 'AGENT_CONNECTOR_HTTP_TRUST_CHANGED', category: 'unknown', retryable: false })
    assert.equal(connectors.httpRequests.size, 0)
    assert.doesNotMatch(JSON.stringify(result), /private-token/)
  })
}

test('an active Connector result cannot succeed after trust is revoked even if fetch ignores abort', async t => {
  let started
  let finish
  const entered = new Promise(resolve => { started = resolve })
  const { connectors, directory, packageStore } = fixture(t, () => new Promise(resolve => { finish = resolve; started() }))
  const pkg = httpPackage()
  install(packageStore, pkg)
  connectors.refresh([])
  connectors.configure({ manifestId: pkg.manifest.manifestId, label: 'Active account',
    credentials: { 'access-token': 'private-token' } })
  const [agent] = connectors.detectAgents()
  const pending = connectors.run(agent, 'request', directory, {
    runId: 'run-ignore-abort', agentRunId: 'agent-ignore-abort', sandbox: 'read-only',
  })
  await entered
  connectors.revokePackage(pkg.packageId)
  finish({ ok: true, text: async () => JSON.stringify({ text: 'late response' }) })
  const result = await pending
  assert.equal(result.outcome, 'failed')
  assert.equal(result.failure.category, 'unknown')
  assert.equal(result.failure.retryable, false)
})

test('deleting one Connector instance does not abort another account request', async t => {
  let started
  const bothStarted = new Promise(resolve => { started = resolve })
  const pendingFetches = []
  const { connectors, directory, packageStore } = fixture(t, (_url, { signal }) => new Promise((resolve, reject) => {
    pendingFetches.push({ resolve, signal })
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    if (pendingFetches.length === 2) started()
  }))
  const pkg = httpPackage()
  install(packageStore, pkg)
  connectors.refresh([])
  const first = connectors.configure({ manifestId: pkg.manifest.manifestId, label: 'Account A',
    credentials: { 'access-token': 'private-a' } })
  const second = connectors.configure({ manifestId: pkg.manifest.manifestId, label: 'Account B',
    credentials: { 'access-token': 'private-b' } })
  const agents = connectors.detectAgents()
  const run = (instance, suffix) => connectors.run(agents.find(agent => agent.kind === instance.instanceId), 'request', directory, {
    runId: `run-isolation-${suffix}`, agentRunId: `agent-isolation-${suffix}`, sandbox: 'read-only',
  })
  const a = run(first, 'a')
  const b = run(second, 'b')
  await bothStarted
  connectors.delete(first.instanceId)
  assert.equal(pendingFetches[0].signal.aborted, true)
  assert.equal(pendingFetches[1].signal.aborted, false)
  pendingFetches[1].resolve({ ok: true, text: async () => JSON.stringify({ text: 'second account completed' }) })
  assert.equal((await a).failure.category, 'unknown')
  assert.equal((await b).outcome, 'completed')
})

test('HTTP transport times out and releases its request', async t => {
  let aborted = false
  const { connectors, directory, packageStore } = fixture(t, (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) }, { once: true })
  }), { httpTimeoutMs: 20 })
  const pkg = httpPackage()
  install(packageStore, pkg)
  connectors.refresh([])
  connectors.configure({ manifestId: pkg.manifest.manifestId, label: 'Timeout', credentials: { 'access-token': 'private-token' } })
  const [agent] = connectors.detectAgents()
  const result = await connectors.run(agent, 'request', directory, {
    runId: 'run-timeout', agentRunId: 'agent-run-timeout', sandbox: 'read-only',
  })
  assert.equal(aborted, true)
  assert.equal(result.outcome, 'failed')
  assert.deepEqual(result.failure, { code: 'AGENT_CONNECTOR_HTTP_TIMEOUT', category: 'timeout', retryable: false })
})

for (const stage of ['headers', 'body']) {
  test(`HTTP Connector timeout settles when ${stage} ignores abort`, { timeout: 3000 }, async t => {
    const never = () => new Promise(() => {})
    const { connectors, directory, packageStore } = fixture(t,
      stage === 'headers' ? never : async () => ({ ok: true, text: never }), { httpTimeoutMs: 20 })
    const pkg = httpPackage()
    install(packageStore, pkg)
    connectors.refresh([])
    connectors.configure({ manifestId: pkg.manifest.manifestId, label: 'Timeout', credentials: { 'access-token': 'private-token' } })
    const [agent] = connectors.detectAgents()
    const result = await connectors.run(agent, 'request', directory, {
      runId: 'run-hung-http', agentRunId: 'agent-hung-http', sandbox: 'read-only',
    })
    assert.deepEqual(result.failure, { code: 'AGENT_CONNECTOR_HTTP_TIMEOUT', category: 'timeout', retryable: false })
  })
}

test('HTTP timeout closes a response body that stops streaming', async t => {
  let closed
  const responseClosed = new Promise(resolve => { closed = resolve })
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.write('{"text":"')
    response.on('close', closed)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}/run`
  const { connectors, directory, packageStore } = fixture(t,
    (_endpoint, options) => fetch(url, options), { httpTimeoutMs: 200 })
  const pkg = httpPackage()
  install(packageStore, pkg)
  connectors.refresh([])
  connectors.configure({ manifestId: pkg.manifest.manifestId, label: 'Stalled body', credentials: { 'access-token': 'private-token' } })
  const [agent] = connectors.detectAgents()
  const result = await connectors.run(agent, 'request', directory, {
    runId: 'run-body-timeout', agentRunId: 'agent-run-body-timeout', sandbox: 'read-only',
  })
  assert.equal(result.failure.code, 'AGENT_CONNECTOR_HTTP_TIMEOUT')
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('response not closed')), 2000)
    responseClosed.then(() => { clearTimeout(timer); resolve() })
  })
})

test('revoking an HTTP Connector closes an active streaming response', async t => {
  let started
  let closed
  const responseStarted = new Promise(resolve => { started = resolve })
  const responseClosed = new Promise(resolve => { closed = resolve })
  const server = http.createServer((_request, response) => {
    response.on('close', closed)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.write('{"text":"')
    started()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}/run`
  const { connectors, directory, packageStore } = fixture(t, (_endpoint, options) => fetch(url, options))
  const pkg = httpPackage()
  install(packageStore, pkg)
  connectors.refresh([])
  connectors.configure({ manifestId: pkg.manifest.manifestId, label: 'Streaming account',
    credentials: { 'access-token': 'private-token' } })
  const [agent] = connectors.detectAgents()
  const pending = connectors.run(agent, 'request', directory, {
    runId: 'run-stream-revoke', agentRunId: 'agent-stream-revoke', sandbox: 'read-only',
  })
  await responseStarted
  connectors.revokePackage(pkg.packageId)
  const result = await pending
  assert.equal(result.outcome, 'failed')
  assert.deepEqual(result.failure, { code: 'AGENT_CONNECTOR_HTTP_TRUST_CHANGED', category: 'unknown', retryable: false })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('response not closed')), 2000)
    responseClosed.then(() => { clearTimeout(timer); resolve() })
  })
})

for (const cancel of [false, true]) test(`stopping an HTTP Connector with cancel=${cancel} does not claim remote cancellation`, async t => {
  let started
  const requestStarted = new Promise(resolve => { started = resolve })
  let aborted = false
  const { connectors, directory, packageStore } = fixture(t, (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) }, { once: true })
    started()
  }))
  const pkg = httpPackage({ cancel })
  install(packageStore, pkg)
  connectors.refresh([])
  connectors.configure({ manifestId: pkg.manifest.manifestId, label: 'No cancel', credentials: { 'access-token': 'private-token' } })
  const [agent] = connectors.detectAgents()
  const controller = new AbortController()
  const pending = connectors.run(agent, 'request', directory, {
    runId: 'run-transport-stop', agentRunId: 'agent-run-transport-stop', sandbox: 'read-only', signal: controller.signal,
  })
  await requestStarted
  controller.abort()
  const result = await pending
  assert.equal(aborted, true)
  assert.equal(result.outcome, 'failed')
  assert.equal(result.failure.code, 'AGENT_CONNECTOR_HTTP_TRANSPORT_ABORTED')
  assert.equal(result.failure.retryable, false)
})

test('SDK packages reject capabilities their providers cannot emit or resume', () => {
  for (const pkg of [SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE, httpPackage()]) {
    const { manifestId, schemaVersion, recordType, ...input } = pkg.manifest
    for (const change of [
      { session: { ...input.session, checkpoint: true } },
      { invocation: { ...input.invocation, idempotencyMode: 'durable' } },
      { eventTypes: [...input.eventTypes, 'Permission'] },
      { eventTypes: [...input.eventTypes, 'Usage'], usage: { ...input.usage, inputTokens: true } },
    ]) {
      const manifest = createAgentConnectorManifest({ ...input, ...change })
      assert.throws(() => createAgentConnectorPackage({
        publisher: pkg.publisher, provider: pkg.provider, manifest,
      }), { message: 'AGENT_CONNECTOR_PACKAGE_SCHEMA_INVALID' })
    }
  }
})

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

test('local echo respects a stateless manifest', async t => {
  const { connectors, directory, packageStore } = fixture(t)
  const { manifestId, schemaVersion, recordType, ...content } = SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE.manifest
  const manifest = createAgentConnectorManifest({ ...content,
    session: { supported: false, resume: false, cancel: true, checkpoint: false } })
  const packageRecord = createAgentConnectorPackage({
    publisher: SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE.publisher,
    provider: SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE.provider, manifest,
  })
  install(packageStore, packageRecord)
  connectors.refresh([])
  connectors.configure({ manifestId: manifest.manifestId, label: 'Stateless echo', credentials: null })
  const [agent] = connectors.detectAgents()
  const result = await connectors.run(agent, 'stateless reply', directory, {
    runId: 'run-stateless', agentRunId: 'agent-run-stateless', sandbox: 'read-only',
  })
  assert.equal(result.outcome, 'completed')
  assert.equal(result.text, 'stateless reply')
  assert.equal(result.sessionRef, '')
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
  assert.throws(() => createAgentConnectorPackage({
    publisher: packageRecord.publisher,
    provider: { ...packageRecord.provider, config: {
      ...packageRecord.provider.config, endpoint: 'invalid-url-private-token',
    } },
    manifest: packageRecord.manifest,
  }), error => error.message === 'AGENT_CONNECTOR_PACKAGE_SCHEMA_INVALID'
    && !JSON.stringify(error).includes('private-token'))
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

  const originalFetch = connectors.fetch
  for (const outcome of ['partial', 'failed', 'cancelled', 'unexpected']) {
    connectors.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ text: 'remote reply', outcome }) })
    const remote = await connectors.run(agent, 'check outcome', directory, {
      runId: `run-outcome-${outcome}`, agentRunId: `agent-run-outcome-${outcome}`, sandbox: 'read-only',
    })
    assert.equal(remote.outcome, outcome === 'unexpected' ? 'failed' : outcome)
    if (outcome === 'failed') assert.equal(remote.failure.code, 'AGENT_CONNECTOR_HTTP_REMOTE_FAILED')
    if (outcome === 'unexpected') assert.equal(remote.failure.code, 'AGENT_CONNECTOR_HTTP_RESPONSE_INVALID')
  }
  for (const extra of [{ success: false }, { error: { message: 'request failed' } }]) {
    connectors.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ text: 'no delivery', ...extra }) })
    const remote = await connectors.run(agent, 'check failure', directory, {
      runId: 'run-explicit-failure', agentRunId: 'agent-run-explicit-failure', sandbox: 'read-only',
    })
    assert.equal(remote.outcome, 'failed')
    assert.equal(remote.failure.code, 'AGENT_CONNECTOR_HTTP_REMOTE_FAILED')
  }
  for (const leaked of [{ text: 'response contains private-token' },
    { text: 'response', sessionRef: 'session-private-token' }]) {
    connectors.fetch = async () => ({ ok: true, text: async () => JSON.stringify(leaked) })
    const rejected = await connectors.run(agent, 'check response', directory, {
      runId: `run-leak-${leaked.sessionRef ? 'session' : 'text'}`,
      agentRunId: `agent-run-leak-${leaked.sessionRef ? 'session' : 'text'}`, sandbox: 'read-only',
    })
    assert.equal(rejected.outcome, 'failed')
    assert.equal(rejected.failure.code, 'AGENT_CONNECTOR_HTTP_RESPONSE_INVALID')
    assert.doesNotMatch(JSON.stringify(rejected), /private-token/)
  }
  const runtimeEvents = []
  connectors.fetch = async () => { throw Object.assign(new Error('request failed'), { code: 'private-token' }) }
  const leakedFailure = await connectors.run(agent, 'check error', directory, {
    runId: 'run-leak-error', agentRunId: 'agent-run-leak-error', sandbox: 'read-only',
    onEvent: event => runtimeEvents.push(event),
  })
  assert.equal(leakedFailure.outcome, 'failed')
  assert.equal(leakedFailure.failure.code, 'AGENT_CONNECTOR_HTTP_FAILED')
  assert.doesNotMatch(JSON.stringify({ leakedFailure, runtimeEvents }), /private-token/)
  connectors.fetch = async () => ({ ok: true, body: new ReadableStream({
    start(controller) {
      const bytes = Buffer.from(JSON.stringify({ text: '分块回复' }))
      const split = bytes.indexOf(Buffer.from('分')) + 1
      controller.enqueue(bytes.subarray(0, split))
      controller.enqueue(bytes.subarray(split))
      controller.close()
    },
  }) })
  const streamed = await connectors.run(agent, 'stream response', directory, {
    runId: 'run-stream', agentRunId: 'agent-run-stream', sandbox: 'read-only',
  })
  assert.equal(streamed.text, '分块回复')
  connectors.fetch = originalFetch

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

  let reads = 0
  let cancelledStream = false
  connectors.fetch = async () => ({ ok: true, body: new ReadableStream({
    pull(controller) {
      reads += 1
      controller.enqueue(new Uint8Array(1024 * 1024))
    },
    cancel() { cancelledStream = true },
  }) })
  const oversized = await connectors.run(agent, 'large response', directory, {
    runId: 'run-oversized', agentRunId: 'agent-run-oversized', sandbox: 'read-only',
  })
  assert.equal(oversized.outcome, 'failed')
  assert.equal(oversized.failure.code, 'AGENT_CONNECTOR_HTTP_RESPONSE_INVALID')
  assert.equal(cancelledStream, true)
  assert.ok(reads <= 6)

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
  connectors.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ text: 'private-token' }) })
  await workspace.sendMessage({ groupId: group.id, text: 'Check second reply', targetKinds: ['codex'] })
  assert.doesNotMatch(JSON.stringify(workspace.snapshot()), /private-token/)
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

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { CloudAgentBridgeStore } = require('../../../src/agents/cloud/cloud-agent-bridge.cjs')
const { LocalAgentConnectors } = require('../../../src/agents/connectors/agent-connector-local.cjs')
const { AgentConnectorInstanceStore } = require('../../../src/agents/connectors/agent-connector-instance-store.cjs')
const { LocalWorkspace } = require('../../../src/workspace/local-workspace.cjs')
const { fixture } = require('../../support/local-workspace-test-helpers.cjs')

for (const transport of ['bridge', 'ssh-tunnel', 'ssh']) {
  test(`${transport} cloud chat records the bytes actually sent`, async t => {
    const { directory, options } = fixture()
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    let sent = ''
    const store = new CloudAgentBridgeStore({
      storagePath: path.join(directory, 'bridges.json'),
      fetch: async (_url, request) => {
        sent = request.body
        return { ok: true, status: 200, text: async () => JSON.stringify({ text: 'cloud reply', outcome: 'completed' }) }
      },
      sshExecute: async request => {
        sent = request.input
        return { stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'cloud reply' } }), stderr: '' }
      },
    })
    const agent = { id: 'codex', sourceKind: 'codex', label: 'Codex', version: '1.0.0',
      available: true, credentialState: 'ready', domains: ['general'], inputTypes: ['text'],
      permissionModes: ['read-only'], session: { supported: false, resume: false, cancel: true, checkpoint: false } }
    const record = store.normalizeRecord({
      bridgeId: 'cloud-bridge-0123456789abcdef01234567', transport,
      address: transport === 'bridge' ? 'https://203.0.113.10:8443' : '10.1.132.21',
      ...(transport === 'ssh-tunnel' ? { endpoint: 'http://127.0.0.1:45678' } : {}),
      label: 'Cloud', agents: [agent], available: true,
    })
    record.available = true
    store.records = [record]
    const instanceStore = new AgentConnectorInstanceStore({
      instanceStoragePath: path.join(directory, 'instances.json'),
      credentialStoragePath: path.join(directory, 'credentials.json'),
      safeStorage: { isEncryptionAvailable: () => true, encryptString: Buffer.from, decryptString: value => value.toString() },
    })
    const connectors = new LocalAgentConnectors({
      manifestDirectory: path.join(directory, 'manifests'), instanceStore,
      cloudBridges: store, runAgent: async () => { throw new Error('unexpected local execution') },
    })
    const [cloudAgent] = connectors.refresh([])
    options.runAgent = (_agent, prompt, workdir, runOptions) => connectors.run(cloudAgent, prompt, workdir, {
      ...runOptions, runId: `run-${transport}`, agentRunId: `agent-${transport}`,
    })
    const workspace = new LocalWorkspace(options)
    await workspace.refreshAgents()
    const group = workspace.createGroup({ name: 'Cloud', agentKinds: ['codex'], workdir: directory, allowWrite: false })
    await workspace.sendMessage({ groupId: group.id, text: 'Cloud task', targetKinds: ['codex'] })
    const message = workspace.snapshot().messages.find(item => item.role === 'agent')
    assert.equal(message?.content, 'cloud reply', JSON.stringify(workspace.snapshot().messages))
    const delivery = workspace.contextPackStore.getDelivery(message.trace.context.deliveryRecordIds[0])
    assert.equal(workspace.contentBlobStore.read(delivery.wirePayloadRef).toString('utf8'), sent)
    assert.equal(workspace.contextPacks.compareDelivery(delivery.deliveryRecordId).status, 'match')
    assert.deepEqual(new LocalWorkspace(options).contextPacks.compareDelivery(delivery.deliveryRecordId),
      workspace.contextPacks.compareDelivery(delivery.deliveryRecordId))
    sent = ''
    await assert.rejects(store.run({ bridgeId: record.bridgeId, agentId: 'codex', prompt: 'blocked',
      permissionMode: 'read-only', operationId: 'operation-blocked',
      onOutboundPayload: async () => { throw new Error('OUTBOUND_RECORD_FAILED') },
    }), { message: 'OUTBOUND_RECORD_FAILED' })
    assert.equal(sent, '')
  })
}

for (const cancel of [false, true]) test(`cloud HTTP stop aborts the actual transport without asserting remote cancellation (cancel=${cancel})`, async t => {
  const { directory } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let started
  const ready = new Promise(resolve => { started = resolve })
  let transportAborted = false
  const store = new CloudAgentBridgeStore({
    storagePath: path.join(directory, 'bridges.json'),
    fetch: (_url, request) => new Promise((_resolve, reject) => {
      request.signal.addEventListener('abort', () => {
        transportAborted = true
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      }, { once: true })
      started()
    }),
  })
  const record = store.normalizeRecord({
    bridgeId: 'cloud-bridge-0123456789abcdef01234567', address: 'https://203.0.113.10:8443',
    label: 'Cloud', available: true, agents: [{ id: 'codex', sourceKind: 'codex', label: 'Codex',
      version: '1.0.0', available: true, domains: ['general'],
      session: { supported: true, resume: true, cancel, checkpoint: false } }],
  })
  store.records = [record]
  const connectors = new LocalAgentConnectors({
    manifestDirectory: path.join(directory, 'manifests'), cloudBridges: store,
    instanceStore: new AgentConnectorInstanceStore({ instanceStoragePath: path.join(directory, 'instances.json'),
      credentialStoragePath: path.join(directory, 'credentials.json'),
      safeStorage: { isEncryptionAvailable: () => true, encryptString: Buffer.from, decryptString: value => value.toString() } }),
    runAgent: async () => { throw new Error('unexpected local execution') },
  })
  const [agent] = connectors.refresh([])
  const controller = new AbortController()
  const pending = connectors.run(agent, 'cloud task', directory, { runId: 'cloud-stop', agentRunId: 'cloud-stop-agent',
    operationId: 'cloud-stop-operation', sandbox: 'read-only', signal: controller.signal })
  await ready
  controller.abort()
  const result = await pending
  assert.equal(transportAborted, true)
  assert.deepEqual(result.failure, { code: 'CLOUD_AGENT_BRIDGE_TRANSPORT_ABORTED', category: 'unknown', retryable: false })
})

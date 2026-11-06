const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { outboundWirePayloadBytes } = require('../../../src/collaboration/outbound-payload.cjs')
const os = require('node:os')
const path = require('node:path')

const {
  CloudAgentBridgeStore,
  loginShellCommand,
  manifestFor,
  normalizeAddress,
} = require('../../../src/agents/cloud/cloud-agent-bridge.cjs')

test('runs fixed SSH bridge commands inside the remote login environment', () => {
  assert.equal(loginShellCommand('exec node -'), "bash -lc 'exec node -'")
  assert.equal(
    loginShellCommand("printf '%s' ready"),
    "bash -lc 'printf '\"'\"'%s'\"'\"' ready'",
  )
})

test('keeps a cloud CLI request alive for the local Agent runtime timeout', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cloud-timeout-'))
  try {
    const store = new CloudAgentBridgeStore({
      storagePath: path.join(directory, 'bridges.json'),
      fetch: async () => response(manifest()),
    })
    assert.equal(store.timeoutMs, 3 * 60 * 1000)
    assert.equal(store.runTimeoutMs, 10 * 60 * 1000)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('Bridge requests cancel oversized streams and respect a pre-aborted caller', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cloud-response-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let cancelled = false
  const store = new CloudAgentBridgeStore({
    storagePath: path.join(directory, 'bridges.json'),
    fetch: async () => ({ ok: true, body: new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(128 * 1024)) },
      cancel() { cancelled = true },
    }) }),
  })
  await assert.rejects(store.request('/test', { address: 'https://203.0.113.10' }), {
    code: 'CLOUD_AGENT_BRIDGE_RESPONSE_TOO_LARGE',
  })
  assert.equal(cancelled, true)
  const controller = new AbortController()
  controller.abort()
  store.fetch = async (_url, options) => {
    assert.equal(options.signal.aborted, true)
    throw Object.assign(new Error('aborted'), { name: 'AbortError' })
  }
  await assert.rejects(store.request('/test', { address: 'https://203.0.113.10', signal: controller.signal }), {
    code: 'LOCAL_AGENT_EXECUTION_STOPPED',
  })
  store.fetch = async () => { throw Object.assign(new Error('timeout'), { name: 'AbortError' }) }
  await assert.rejects(store.request('/test', { address: 'https://203.0.113.10' }), {
    code: 'CLOUD_AGENT_BRIDGE_TIMEOUT',
  })
  const lateCaller = new AbortController()
  store.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      lateCaller.abort()
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }, { once: true })
  })
  await assert.rejects(store.request('/test', {
    address: 'https://203.0.113.10', signal: lateCaller.signal, timeoutMs: 1000,
  }), { code: 'CLOUD_AGENT_BRIDGE_TIMEOUT' })
})

for (const stage of ['headers', 'body']) {
  test(`Bridge timeout rejects a late ${stage} response even when the transport ignores abort`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cloud-late-response-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const store = new CloudAgentBridgeStore({
      storagePath: path.join(directory, 'bridges.json'),
      fetch: async (_url, options) => {
        if (stage === 'headers') return new Promise(resolve => {
          options.signal.addEventListener('abort', () => resolve(response({ text: 'late' })), { once: true })
        })
        return { ok: true, text: () => new Promise(resolve => {
          options.signal.addEventListener('abort', () => resolve(JSON.stringify({ text: 'late' })), { once: true })
        }) }
      },
    })
    await assert.rejects(store.request('/test', { address: 'https://203.0.113.10', timeoutMs: 1000 }),
      { code: 'CLOUD_AGENT_BRIDGE_TIMEOUT' })
  })
}

test('reports activity while a cloud Agent request is waiting for its final response', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cloud-activity-'))
  const activity = []
  try {
    const store = new CloudAgentBridgeStore({
      storagePath: path.join(directory, 'bridges.json'),
      runTimeoutMs: 1000,
      fetch: async (_url, options) => {
        await new Promise(resolve => setTimeout(resolve, 275))
        return response({ text: 'remote reply', outcome: 'completed' })
      },
    })
    store.records = [store.normalizeRecord({
      bridgeId: 'cloud-bridge-0123456789abcdef01234567',
      address: 'https://203.0.113.10:8443',
      label: 'Research server',
      available: true,
      agents: manifest().agents,
    })]
    const record = store.records[0]
    let outbound
    const result = await store.run({
      bridgeId: record.bridgeId,
      agentId: 'codex',
      prompt: 'hello',
      permissionMode: 'read-only',
      onActivity: () => activity.push(Date.now()),
    })
    assert.equal(result.text, 'remote reply')
    assert.ok(activity.length >= 2, `expected initial and heartbeat activity, got ${activity.length}`)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function response(value, ok = true, status = 200) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(value),
  }
}

test('does not send to a removed or changed cloud bridge after outbound review', async t => {
  for (const transport of ['bridge', 'ssh-tunnel', 'ssh']) {
    for (const change of ['remove', 'address', 'server', 'agent', 'abort']) {
      await t.test(`${transport}: ${change}`, async t => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cloud-target-'))
        t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
        let sent = false
        const store = new CloudAgentBridgeStore({
          storagePath: path.join(directory, 'bridges.json'),
          fetch: async () => { sent = true; return response({ text: 'reply', outcome: 'completed' }) },
        })
        store.sshCommand = async () => { sent = true; return { stdout: '' } }
        const record = store.normalizeRecord({
          bridgeId: 'cloud-bridge-0123456789abcdef01234567', transport,
          address: transport === 'bridge' ? 'https://203.0.113.10' : '203.0.113.10',
          endpoint: 'http://127.0.0.1:45678', available: true, agents: manifest().agents,
        })
        record.available = true
        store.records = [record]
        const controller = new AbortController()
        await assert.rejects(store.run({
          bridgeId: record.bridgeId, agentId: 'codex', prompt: 'hello',
          permissionMode: 'read-only', signal: controller.signal,
          onOutboundPayload: async () => {
            if (change === 'remove') store.remove(record.bridgeId)
            if (change === 'address') record.address = '203.0.113.11'
            if (change === 'server') record.serverId = 'replacement-server'
            if (change === 'agent') record.agents[0].available = false
            if (change === 'abort') controller.abort()
          },
        }), { code: change === 'abort' ? 'LOCAL_AGENT_EXECUTION_STOPPED' : 'CLOUD_AGENT_BRIDGE_NOT_FOUND' })
        assert.equal(sent, false)
      })
    }
  }
})

for (const changed of [false, true]) {
  test(`cloud response ${changed ? 'rejects a changed server identity' : 'accepts a matching reconnected server'}`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cloud-identity-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    let finish
    const store = new CloudAgentBridgeStore({
      storagePath: path.join(directory, 'bridges.json'),
      fetch: () => new Promise(resolve => { finish = () => resolve(response({ text: 'reply', outcome: 'completed' })) }),
    })
    const record = store.normalizeRecord({ bridgeId: 'cloud-bridge-0123456789abcdef01234567',
      address: 'https://203.0.113.10', serverId: 'original-server', label: 'Server',
      available: true, agents: manifest().agents })
    store.records = [record]
    const result = store.run({ bridgeId: record.bridgeId, agentId: 'codex', prompt: 'hello', permissionMode: 'read-only' })
    await new Promise(resolve => setImmediate(resolve))
    store.records[0] = { ...record, serverId: changed ? 'replacement-server' : record.serverId }
    finish()
    if (changed) await assert.rejects(result, { code: 'CLOUD_AGENT_BRIDGE_CHANGED', category: 'unknown' })
    else assert.equal((await result).text, 'reply')
  })
}

for (const transport of ['bridge', 'ssh-tunnel', 'ssh']) {
  test(`${transport} bridge removal aborts only its active run and rejects a late reply`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cloud-remove-active-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const pending = new Map()
    const store = new CloudAgentBridgeStore({
      storagePath: path.join(directory, 'bridges.json'),
      fetch: (url, options) => new Promise(resolve => {
        const key = url.includes('203.0.113.11') || url.includes('45679') ? 'second' : 'first'
        pending.set(key, { signal: options.signal, resolve: () => resolve(response({ text: 'reply', outcome: 'completed' })) })
      }),
      sshExecute: request => new Promise(resolve => {
        const key = request.address.includes('203.0.113.11') ? 'second' : 'first'
        pending.set(key, { signal: request.signal, resolve: () => resolve({ stdout: JSON.stringify({
          type: 'item.completed', item: { type: 'agent_message', text: 'reply' },
        }) }) })
      }),
    })
    for (const [index, host] of ['203.0.113.10', '203.0.113.11'].entries()) {
      const record = store.normalizeRecord({
        bridgeId: `cloud-bridge-${String(index + 1).repeat(24)}`, transport,
        address: transport === 'bridge' ? `https://${host}` : host,
        endpoint: `http://127.0.0.1:${45678 + index}`, label: `Server ${index}`,
        available: true, agents: manifest().agents,
      })
      record.available = true
      store.records.push(record)
    }
    const run = record => store.run({ bridgeId: record.bridgeId, agentId: 'codex',
      prompt: 'hello', permissionMode: 'read-only' })
    const first = run(store.records[0])
    const second = run(store.records[1])
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(pending.size, 2)
    store.remove(store.records[0].bridgeId)
    assert.equal(pending.get('first').signal.aborted, true)
    assert.equal(pending.get('second').signal.aborted, false)
    pending.get('first').resolve()
    pending.get('second').resolve()
    await assert.rejects(first, { code: 'CLOUD_AGENT_BRIDGE_REMOVED', category: 'unknown' })
    assert.equal((await second).text, 'reply')
  })
}

function manifest() {
  return {
    protocol: 'meldwork-agent-bridge',
    version: 1,
    server: { id: 'server-1', label: 'Research server' },
    agents: [{
      id: 'codex',
      sourceKind: 'codex',
      label: 'Codex CLI',
      version: '0.1.0',
      available: true,
      credentialState: 'ready',
      skills: [{ namespace: 'codex', slug: 'review', name: 'Review' }],
      domains: ['general'],
      inputTypes: ['text'],
      permissionModes: ['read-only', 'workspace-write'],
    }],
  }
}

test('normalizes an IP HTTPS address and rejects non-IP destinations', () => {
  assert.equal(normalizeAddress('https://203.0.113.10:8443/'), 'https://203.0.113.10:8443')
  assert.equal(normalizeAddress('203.0.113.10:8443'), 'https://203.0.113.10:8443')
  assert.throws(() => normalizeAddress('http://203.0.113.10:8443'), {
    code: 'CLOUD_AGENT_BRIDGE_ADDRESS_INVALID',
  })
  assert.throws(() => normalizeAddress('https://agent.example.com'), {
    code: 'CLOUD_AGENT_BRIDGE_ADDRESS_INVALID',
  })
})

test('connects, persists, and exposes a bridge Agent as a connector entry', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cloud-bridge-'))
  const storagePath = path.join(directory, 'bridges.json')
  const calls = []
  const store = new CloudAgentBridgeStore({
    storagePath,
    fetch: async (url, options) => {
      calls.push({ url, options })
      if (options?.method === 'POST') return response({ text: 'remote reply', outcome: 'completed' })
      return response(manifest())
    },
  })
  try {
    const connected = await store.connect({ address: 'https://203.0.113.10:8443' })
    assert.equal(connected.label, 'Research server')
    assert.equal(connected.available, true)
    assert.deepEqual(connected.agents.map(agent => agent.id), ['codex'])
    assert.equal(connected.agents[0].sourceKind, 'codex')
    assert.equal(connected.agents[0].credentialState, 'ready')
    assert.deepEqual(connected.agents[0].skills, [
      { namespace: 'codex', slug: 'review', name: 'Review' },
    ])

    const [entry] = store.connectorEntries()
    assert.equal(entry.agent.id, 'codex')
    assert.equal(entry.manifest.transport.type, 'http')
    assert.equal(entry.manifest.invocation.recipeId, 'external.cloud-agent-bridge')
    assert.equal(entry.instance.bridgeId, connected.bridgeId)
    assert.match(entry.manifest.manifestId, /^connector-manifest-[a-f0-9]{64}$/)

    const result = await store.run({
      bridgeId: connected.bridgeId,
      agentId: 'codex',
      prompt: 'hello',
      permissionMode: 'read-only',
      operationId: 'operation-1',
      onOutboundPayload: value => { outbound = value },
    })
    assert.deepEqual(result, { text: 'remote reply', outcome: 'completed' })
    assert.equal(calls.at(-1).url, 'https://203.0.113.10:8443/v1/agents/codex/runs')
    assert.equal(outboundWirePayloadBytes(outbound).toString('utf8'), calls.at(-1).options.body)

    const restarted = new CloudAgentBridgeStore({
      storagePath,
      fetch: async () => response(manifest()),
    })
    assert.equal(restarted.list()[0].bridgeId, connected.bridgeId)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('keeps installed but unavailable cloud Agents in the catalog and out of runtime entries', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cloud-catalog-'))
  const storagePath = path.join(directory, 'bridges.json')
  const unavailableManifest = manifest()
  unavailableManifest.agents.push({
    id: 'claude', sourceKind: 'claude', label: 'Claude Code', version: '2.1.123',
    available: false, credentialState: 'missing', skills: [], domains: ['general'],
    inputTypes: ['text'], permissionModes: ['read-only'],
  })
  unavailableManifest.agents.push({
    id: 'pi', sourceKind: 'pi', label: 'Pi Agent', version: '1.2.3',
    available: true, executionSupported: false, credentialState: 'unknown',
    skills: [], domains: ['general'], inputTypes: ['text'], permissionModes: ['read-only'],
  })
  unavailableManifest.agents.push({
    id: 'writeonly', sourceKind: 'writeonly', label: 'Write-only Agent', version: '1.0.0',
    available: true, credentialState: 'ready', skills: [], domains: ['general'],
    inputTypes: ['text'], permissionModes: ['workspace-write'],
  })
  const store = new CloudAgentBridgeStore({
    storagePath,
    fetch: async () => response(unavailableManifest),
  })
  try {
    await store.connect({ address: 'https://203.0.113.10:8443' })
    assert.deepEqual(store.connectorEntries().map(entry => entry.agent.id), ['codex'])
    assert.deepEqual(store.catalogEntries().map(agent => [agent.sourceKind, agent.available]), [
      ['codex', true],
      ['claude', false],
      ['pi', false],
      ['writeonly', false],
    ])
    const claude = store.catalogEntries().find(agent => agent.sourceKind === 'claude')
    assert.equal(claude.credentialState, 'missing')
    assert.equal(store.catalogEntries().find(agent => agent.sourceKind === 'pi').availabilitySource, 'cloud-bridge-unsupported')
    assert.equal(store.catalogEntries().find(agent => agent.sourceKind === 'writeonly').availabilitySource, 'cloud-bridge-unsupported')
    assert.deepEqual(store.skillsForInstance(claude.kind), [])
    const codex = store.catalogEntries().find(agent => agent.sourceKind === 'codex')
    assert.deepEqual(store.skillsForInstance(codex.kind), [
      { namespace: 'codex', slug: 'review', name: 'Review' },
    ])
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('SSH fallback discovers multiple CLI types without advertising unsupported execution', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cloud-fallback-'))
  const store = new CloudAgentBridgeStore({
    storagePath: path.join(directory, 'bridges.json'),
    fetch: async () => response(manifest()),
    sshExecute: async () => ({ stdout: '__MELDWORK_CLI__codex\tcodex-cli 0.146.1\n__MELDWORK_CLI__pi\tpi 0.86.1\n__MELDWORK_CLI__kimi\tkimi 0.19.2\n', stderr: '' }),
  })
  try {
    const result = await store.probeSsh('203.0.113.10')
    assert.deepEqual(result.agents.map(agent => [agent.id, agent.available, agent.executionSupported]), [
      ['codex', true, true], ['pi', false, false], ['kimi', false, false],
    ])
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('marks a persisted bridge unavailable after a failed refresh', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cloud-bridge-'))
  const storagePath = path.join(directory, 'bridges.json')
  const store = new CloudAgentBridgeStore({
    storagePath,
    fetch: async () => response(manifest()),
  })
  try {
    const connected = await store.connect({ address: 'https://198.51.100.12' })
    store.fetch = async () => response({ error: 'offline' }, false, 503)
    const [refreshed] = await store.refresh()
    assert.equal(refreshed.bridgeId, connected.bridgeId)
    assert.equal(refreshed.available, false)
    assert.equal(refreshed.lastError, 'CLOUD_AGENT_BRIDGE_HTTP_503')
    assert.deepEqual(store.connectorEntries(), [])
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('generates a valid manifest from a persisted bridge record', () => {
  const manifestRecord = manifestFor({
    bridgeId: 'cloud-bridge-0123456789abcdef01234567',
    address: 'https://203.0.113.10:8443',
    label: 'Server',
  }, {
    id: 'codex', label: 'Codex', version: '1.0.0', domains: ['general'],
    inputTypes: ['text', 'image', 'file'], permissionModes: ['read-only', 'workspace-write'],
    session: { supported: true, resume: true, cancel: true, checkpoint: false },
  })
  assert.equal(manifestRecord.connectorVersion, '1.0.0')
  assert.deepEqual(manifestRecord.inputTypes, ['text'])
  assert.deepEqual(manifestRecord.permissionModes, ['read-only'])
  assert.deepEqual(manifestRecord.outboundDestinations, ['https://203.0.113.10:8443'])
})

test('cloud Agents must explicitly declare session, resume, and cancel capabilities', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cloud-session-'))
  const remote = manifest()
  remote.agents[0].session = { supported: false, resume: true }
  const store = new CloudAgentBridgeStore({
    storagePath: path.join(directory, 'bridges.json'), fetch: async () => response(remote),
  })
  try {
    await store.connect({ address: 'https://203.0.113.10:8443' })
    assert.deepEqual(store.connectorEntries()[0].manifest.session, {
      supported: false, resume: false, cancel: false, checkpoint: false,
    })
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('discovers and runs a remote Codex CLI through existing SSH configuration', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cloud-ssh-'))
  const storagePath = path.join(directory, 'bridges.json')
  const calls = []
  const store = new CloudAgentBridgeStore({
    storagePath,
    fetch: async () => response(manifest()),
    sshTunnelStart: async () => { throw new Error('tunnel mocked unavailable') },
    sshExecute: async input => {
      calls.push(input)
      if (input.command.includes('codex --version')) return { stdout: 'codex-cli 0.121.0\n', stderr: '' }
      return {
        stdout: [
          JSON.stringify({ type: 'thread.started', thread_id: 'remote-thread-1' }),
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'remote reply' } }),
          JSON.stringify({ type: 'turn.completed' }),
        ].join('\n'),
        stderr: '',
      }
    },
  })
  try {
    const connected = await store.connect({ address: '10.1.132.21' })
    assert.equal(connected.transport, 'ssh')
    assert.equal(connected.address, '10.1.132.21')
    assert.deepEqual(connected.agents.map(agent => agent.label), ['Codex CLI'])

    const [entry] = store.connectorEntries()
    assert.equal(entry.manifest.invocation.recipeId, 'external.cloud-agent-ssh')
    assert.deepEqual(entry.manifest.permissionModes, ['read-only'])
    assert.deepEqual(entry.manifest.outboundDestinations, [])

    let outbound
    const result = await store.run({
      bridgeId: connected.bridgeId,
      agentId: 'codex',
      prompt: 'hello remotely',
      permissionMode: 'read-only',
    })
    assert.deepEqual(result, { text: 'remote reply', sessionRef: '', outcome: 'completed' })
    assert.equal(calls[0].command.includes('codex --version'), true)
    assert.equal(calls[1].command, 'exec codex exec --json --skip-git-repo-check --sandbox read-only -')
    assert.equal(calls[1].input, 'hello remotely')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('upgrades a persisted direct SSH connection to the enhanced tunnel without changing its id', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cloud-ssh-upgrade-'))
  const storagePath = path.join(directory, 'bridges.json')
  const store = new CloudAgentBridgeStore({
    storagePath,
    fetch: async () => response(manifest()),
    sshTunnelStart: async () => { throw new Error('initial tunnel unavailable') },
    sshExecute: async () => ({ stdout: 'codex-cli 0.121.0\n', stderr: '' }),
  })
  try {
    const connected = await store.connect({ address: '10.1.132.21' })
    assert.equal(connected.transport, 'ssh')
    store.sshTunnelStart = async () => ({
      child: { killed: false, kill() { this.killed = true }, once() {} },
      endpoint: 'http://127.0.0.1:45678',
    })

    const [upgraded] = await store.refresh()

    assert.equal(upgraded.bridgeId, connected.bridgeId)
    assert.equal(upgraded.transport, 'ssh-tunnel')
    assert.equal(upgraded.agents[0].sourceKind, 'codex')
  } finally {
    store.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('keeps an SSH discovery failure when the HTTPS fallback is unavailable', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cloud-ssh-failure-'))
  const store = new CloudAgentBridgeStore({
    storagePath: path.join(directory, 'bridges.json'),
    fetch: async () => { throw new Error('network unavailable') },
    sshTunnelStart: async () => { throw new Error('tunnel mocked unavailable') },
    sshExecute: async () => ({ stdout: '', stderr: '' }),
  })
  try {
    await assert.rejects(store.connect({ address: '10.1.132.21' }), {
      code: 'CLOUD_AGENT_SSH_NO_AGENT',
    })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('connects through an SSH-local Agent Bridge tunnel and reuses its HTTP protocol', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cloud-tunnel-'))
  const storagePath = path.join(directory, 'bridges.json')
  const calls = []
  const child = { killed: false, kill() { this.killed = true } }
  const store = new CloudAgentBridgeStore({
    storagePath,
    fetch: async (url, options) => {
      calls.push({ url, options })
      if (options?.method === 'POST') return response({ text: 'tunneled reply', outcome: 'completed' })
      return response(manifest())
    },
    sshTunnelStart: async () => ({ child, endpoint: 'http://127.0.0.1:45678' }),
  })
  try {
    const connected = await store.connect({ address: '10.1.132.21', label: 'SSH tunnel server' })
    assert.equal(connected.transport, 'ssh-tunnel')
    assert.equal(connected.address, '10.1.132.21')
    const result = await store.run({
      bridgeId: connected.bridgeId,
      agentId: 'codex',
      prompt: 'through tunnel',
      permissionMode: 'read-only',
      operationId: 'tunnel-operation-1',
      onOutboundPayload: value => { outbound = value },
    })
    assert.deepEqual(result, { text: 'tunneled reply', outcome: 'completed' })
    assert.equal(calls.at(-1).url, 'http://127.0.0.1:45678/v1/agents/codex/runs')
    assert.equal(outbound.tunneled, true)
    assert.equal(outboundWirePayloadBytes(outbound).toString('utf8'), calls.at(-1).options.body)
    store.remove(connected.bridgeId)
    assert.equal(child.killed, true)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('passes a caller abort signal through to cloud Agent execution', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cloud-bridge-'))
  const storagePath = path.join(directory, 'bridges.json')
  const controller = new AbortController()
  let receivedSignal = null
  let resolveRun = null
  const store = new CloudAgentBridgeStore({
    storagePath,
    fetch: async (url, options) => {
      receivedSignal = options.signal
      if (options.method === 'POST') {
        return new Promise(resolve => { resolveRun = () => resolve(response({ text: 'done', outcome: 'completed' })) })
      }
      return response(manifest())
    },
  })
  try {
    const connected = await store.connect({ address: 'https://203.0.113.10:8443' })
    const runPromise = store.run({
      bridgeId: connected.bridgeId,
      agentId: 'codex',
      prompt: 'cancel me',
      permissionMode: 'read-only',
      operationId: 'operation-2',
      signal: controller.signal,
    })
    await new Promise(resolve => setImmediate(resolve))
    assert.notEqual(receivedSignal, controller.signal)
    assert.equal(receivedSignal.aborted, false)
    controller.abort()
    assert.equal(receivedSignal.aborted, true)
    resolveRun()
    await assert.rejects(runPromise, { code: 'LOCAL_AGENT_EXECUTION_STOPPED' })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

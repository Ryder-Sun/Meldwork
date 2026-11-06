const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const catalogApi = require('../../src/workspace/local-workspace-agent-catalog.cjs')
const { agentVerificationIdentity, projectVerificationIdentity } = require('../../src/workspace/agent-verification-identity.cjs')
const { NATIVE_CONFIG_IDENTITY_DIRECTORY, NATIVE_ENVIRONMENT_IDENTITY, NATIVE_AUTH_IDENTITY_FILES, nativeEnvironmentIdentity } = require('../../src/agents/native-config-directory.cjs')
const { LocalWorkspaceAgentCatalog } = catalogApi

test('Agent verification identity changes when the executable is replaced', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-agent-identity-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const executable = path.join(directory, 'agent')
  fs.writeFileSync(executable, 'first binary')
  const agent = { kind: 'codex', executable, version: '1.0.0' }
  const first = agentVerificationIdentity(agent)
  fs.renameSync(executable, path.join(directory, 'old-agent'))
  fs.writeFileSync(executable, 'second binary')
  assert.notEqual(agentVerificationIdentity(agent), first)
  assert.doesNotMatch(first, /agent-identity|codex/)
})

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function fixture(overrides = {}) {
  const state = {
    messages: [],
    agentPreferences: {},
    agentRuntime: {},
  }
  let agents = overrides.initialAgents || []
  const events = []
  const catalog = new LocalWorkspaceAgentCatalog({
    state: () => state,
    detectedAgents: () => agents,
    isKnownAgent: overrides.isKnownAgent,
    setDetectedAgents: (next) => { agents = next },
    detectAgents: overrides.detectAgents || (async () => []),
    credentialState: overrides.credentialState || (async () => ({
      state: 'unknown', source: 'unverified',
    })),
    save: () => events.push('save'),
    emitChanged: () => events.push('emit'),
    snapshot: () => {
      events.push('snapshot')
      return { agents }
    },
    now: overrides.now || (() => '2026-08-03T00:00:00.000Z'),
  })
  return { agents: () => agents, catalog, events, state }
}

for (const [kind, config] of [['zcode', 'zcode.json'], ['opencode', 'opencode.json'],
  ['mimo', '.mimocode/mimocode.json'], ['mimo', 'mimocode.json'], ['gemini', '.gemini/settings.json'],
  ['qwen', '.qwen/settings.json']]) {
  test(`${kind} project verification cannot cross directories or survive a configuration change`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-project-verification-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const first = path.join(root, 'first')
    const second = path.join(root, 'second')
    fs.mkdirSync(first); fs.mkdirSync(second)
    const filename = path.join(first, config)
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    fs.writeFileSync(filename, '{"model":"first"}')
    const agent = { kind, executable: '/tmp/agent', version: '1', available: true, compatibilityState: 'compatible' }
    const { catalog, state } = fixture({ initialAgents: [agent] })
    const verificationIdentity = agentVerificationIdentity(agent)
    const projectIdentity = projectVerificationIdentity(kind, first)
    catalog.markRuntimeCredential(kind, 'ready', { verificationIdentity, projectIdentity, workdir: first })
    assert.equal(catalog.isRecentlyVerified(kind, first), true)
    assert.equal(catalog.isRecentlyVerified(kind, second), false)
    assert.doesNotMatch(JSON.stringify(state.agentRuntime), /meldwork-project-verification/)
    fs.writeFileSync(filename, '{"model":"replacement"}')
    assert.equal(catalog.isRecentlyVerified(kind, first), false)
    catalog.markRuntimeCredential(kind, 'ready', { verificationIdentity, projectIdentity, workdir: first })
    assert.equal(catalog.isRecentlyVerified(kind, first), false)
  })
}

test('project authentication failures clear on CLI replacement or retry refresh', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-project-failure-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let current = { kind: 'zcode', executable: '/tmp/zcode-old', version: '1', available: true }
  let now = '2026-08-03T00:00:00.000Z'
  const { catalog, state } = fixture({ initialAgents: [current], detectAgents: async () => [current],
    credentialState: async () => ({ state: 'ready', source: 'native-auth-status' }), now: () => now })
  const fail = () => catalog.markRuntimeCredential('zcode', 'missing', {
    verificationIdentity: agentVerificationIdentity(current), workdir: directory,
    projectIdentity: projectVerificationIdentity('zcode', directory),
  })
  fail()
  await catalog.refresh()
  assert.ok(state.agentRuntime.zcode.projectFailureIdentity)
  now = '2026-08-03T00:00:31.000Z'
  await catalog.refresh()
  assert.equal(state.agentRuntime.zcode?.projectFailureIdentity, undefined)
  fail()
  current = { ...current, executable: '/tmp/zcode-new', version: '2' }
  await catalog.refresh()
  assert.equal(state.agentRuntime.zcode?.projectFailureIdentity, undefined)
})

test('a late result from an older CLI cannot verify its replacement', () => {
  const oldAgent = { kind: 'codex', executable: '/tmp/codex-old', version: '1' }
  const current = { kind: 'codex', executable: '/tmp/codex-new', version: '2', available: false, recentlyVerified: false }
  const { catalog, agents, state } = fixture({ initialAgents: [current] })
  catalog.markRuntimeCredential('codex', 'ready', {
    verificationIdentity: agentVerificationIdentity(oldAgent),
  })
  assert.equal(catalog.isRecentlyVerified('codex'), false)
  assert.equal(agents()[0].recentlyVerified, false)
  assert.equal(agents()[0].available, false)
  assert.equal(state.agentRuntime.codex, undefined)
})

for (const credentialState of ['ready', 'missing']) {
  test(`a late ${credentialState} result cannot update an Agent removed during its run`, async () => {
    const original = { kind: 'codex', executable: '/tmp/codex-original', version: '1', compatibilityState: 'compatible' }
    let detected = []
    const { catalog, state, agents } = fixture({ initialAgents: [original], detectAgents: async () => detected })
    const identity = agentVerificationIdentity(original)
    await catalog.refresh()
    assert.equal(agents().length, 0)
    catalog.markRuntimeCredential('codex', credentialState, { verificationIdentity: identity })
    assert.equal(state.agentRuntime.codex, undefined)
    detected = [{ ...original, executable: '/tmp/codex-reinstalled', version: '2' }]
    await catalog.refresh()
    assert.notEqual(agents()[0].credentialState, 'missing')
    assert.equal(agents()[0].recentlyVerified, false)
  })
}

test('a late authentication failure from an older CLI cannot block its replacement', () => {
  const oldAgent = { kind: 'codex', executable: '/tmp/codex-old', version: '1' }
  const current = { kind: 'codex', executable: '/tmp/codex-new', version: '2', available: true,
    credentialState: 'ready' }
  const { catalog, agents, state } = fixture({ initialAgents: [current] })
  catalog.markRuntimeCredential('codex', 'missing', { verificationIdentity: agentVerificationIdentity(oldAgent) })
  assert.equal(agents()[0].available, true)
  assert.equal(agents()[0].credentialState, 'ready')
  assert.equal(state.agentRuntime.codex, undefined)
})

test('an authentication failure does not block a replacement CLI during the cooldown', async () => {
  let detected = [{ kind: 'codex', executable: '/tmp/codex-original', version: '1', compatibilityState: 'compatible' }]
  const { catalog, agents, state } = fixture({ detectAgents: async () => detected })
  await catalog.refresh()
  const identity = agentVerificationIdentity(agents()[0], state.agentPreferences)
  catalog.markRuntimeCredential('codex', 'missing', { verificationIdentity: identity })
  assert.equal(agents()[0].available, false)
  await catalog.refresh()
  assert.equal(agents()[0].available, false)
  assert.equal(state.agentRuntime.codex.failureIdentity, identity)
  detected = [{ kind: 'codex', executable: '/tmp/codex-reinstalled', version: '2', compatibilityState: 'compatible' }]
  await catalog.refresh()
  assert.equal(state.agentRuntime.codex, undefined)
  assert.equal(agents()[0].credentialState, 'unknown')
  assert.equal(agents()[0].available, true)
})

test('a failed probe cannot borrow a successful run from another installation', async () => {
  const oldAgent = { kind: 'codex', executable: '/tmp/codex-old', version: '1', compatibilityState: 'compatible' }
  const current = { kind: 'codex', executable: '/tmp/codex-new', version: '2', compatibilityState: 'compatible' }
  const { catalog, agents, state } = fixture({
    detectAgents: async () => [current],
    credentialState: async () => ({ state: 'unknown', source: 'native-probe-failed' }),
  })
  state.agentRuntime.codex = { credentialState: 'ready', checkedAt: '2026-08-03T00:00:00.000Z',
    verificationSource: 'successful-run', verificationIdentity: agentVerificationIdentity(oldAgent) }
  await catalog.refresh()
  assert.equal(agents()[0].recentlyVerified, false)
  assert.equal(agents()[0].runtimePrerequisitesReady, false)
  assert.equal(agents()[0].available, false)
})

test('probe failure cannot retain availability when the executable changes', async () => {
  const oldAgent = { kind: 'codex', executable: '/tmp/codex-old', version: '1',
    compatibilityState: 'compatible', available: true, credentialState: 'ready' }
  const current = { ...oldAgent, executable: '/tmp/codex-new', version: '2' }
  const { catalog, agents } = fixture({ initialAgents: [oldAgent], detectAgents: async () => [current],
    credentialState: async () => ({ state: 'unknown', source: 'native-probe-failed' }) })
  await catalog.refresh()
  assert.equal(agents()[0].available, false)
})

test('probe failure cannot retain availability after an in-place executable replacement', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-agent-replaced-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const executable = path.join(directory, 'agent')
  fs.writeFileSync(executable, 'old executable')
  const agent = { kind: 'codex', executable, version: '1', compatibilityState: 'compatible',
    available: true, credentialState: 'ready' }
  const { catalog, agents } = fixture({ initialAgents: [agent], detectAgents: async () => [{ ...agent }],
    credentialState: async () => ({ state: 'unknown', source: 'native-probe-failed' }) })
  fs.renameSync(executable, path.join(directory, 'old-agent'))
  fs.writeFileSync(executable, 'new executable')
  await catalog.refresh()
  assert.equal(agents()[0].available, false)
})

test('a native configuration switch invalidates previous and late verification', async () => {
  const agent = { kind: 'hermes', executable: '/tmp/hermes', version: '1',
    compatibilityState: 'compatible', available: true, credentialState: 'ready' }
  const { catalog, agents, state } = fixture({ initialAgents: [agent], detectAgents: async () => [{ ...agent }],
    credentialState: async () => ({ state: 'unknown', source: 'native-probe-failed' }) })
  state.agentPreferences.hermes = { nativeConfigDirectory: '/tmp/profile-a' }
  const oldIdentity = agentVerificationIdentity(agent, state.agentPreferences)
  catalog.markRuntimeCredential('hermes', 'ready', { verificationIdentity: oldIdentity })
  state.agentPreferences.hermes.nativeConfigDirectory = '/tmp/profile-b'
  await catalog.refresh()
  assert.equal(agents()[0].available, false)
  assert.equal(agents()[0].recentlyVerified, false)
  catalog.markRuntimeCredential('hermes', 'ready', { verificationIdentity: oldIdentity })
  assert.equal(agents()[0].available, false)
})

test('a native environment change invalidates successful and late verification without exposing values', async () => {
  let credential = 'first-secret'
  const detected = () => ({ kind: 'hermes', executable: '/tmp/hermes', version: '1',
    compatibilityState: 'compatible',
    [NATIVE_ENVIRONMENT_IDENTITY]: nativeEnvironmentIdentity({ PROVIDER_API_KEY: credential }) })
  const { catalog, agents, state } = fixture({ detectAgents: async () => [detected()],
    credentialState: async () => ({ state: 'unknown', source: 'unverified' }) })
  await catalog.refresh()
  const oldIdentity = agentVerificationIdentity(agents()[0], state.agentPreferences)
  catalog.markRuntimeCredential('hermes', 'ready', { verificationIdentity: oldIdentity })
  assert.equal(agents()[0].recentlyVerified, true)
  assert.doesNotMatch(JSON.stringify(agents()), /first-secret|PROVIDER_API_KEY/)
  credential = 'second-secret'
  await catalog.refresh()
  assert.equal(agents()[0].recentlyVerified, false)
  catalog.markRuntimeCredential('hermes', 'ready', { verificationIdentity: oldIdentity })
  assert.equal(agents()[0].recentlyVerified, false)
})

test('editing selected native configuration invalidates a previous and late successful run', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-agent-config-identity-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const config = path.join(directory, 'config.yaml')
  fs.writeFileSync(config, 'model: first\n')
  const agent = { kind: 'hermes', executable: '/tmp/hermes', version: '1', compatibilityState: 'compatible' }
  const { catalog, agents, state } = fixture({ detectAgents: async () => [{ ...agent }],
    credentialState: async () => ({ state: 'unknown', source: 'unverified' }) })
  state.agentPreferences.hermes = { nativeConfigDirectory: directory }
  await catalog.refresh()
  const oldIdentity = agentVerificationIdentity(agent, state.agentPreferences)
  catalog.markRuntimeCredential('hermes', 'ready', { verificationIdentity: oldIdentity })
  assert.equal(agents()[0].recentlyVerified, true)
  fs.writeFileSync(config, 'model: another-provider\n')
  catalog.markRuntimeCredential('hermes', 'ready', { verificationIdentity: oldIdentity })
  await catalog.refresh()
  assert.equal(agents()[0].recentlyVerified, false)
  assert.equal(agents()[0].authenticated, false)
  assert.equal(agents()[0].invocable, true)
})

test('credential files inside selected native directories participate in verification identity', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-agent-credential-identity-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const credentials = path.join(directory, 'credentials')
  fs.mkdirSync(credentials)
  const filename = path.join(credentials, 'profile.json')
  fs.writeFileSync(filename, 'first')
  const agent = { kind: 'kimi' }
  const preferences = { kimi: { nativeConfigDirectory: directory } }
  const first = agentVerificationIdentity(agent, preferences)
  fs.writeFileSync(filename, 'second account')
  assert.notEqual(agentVerificationIdentity(agent, preferences), first)
})

test('Gemini native credential changes invalidate a successful verification', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-gemini-identity-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'oauth_creds.json')
  fs.writeFileSync(filename, '{"refresh_token":"first"}')
  const detected = () => {
    const agent = { kind: 'gemini', executable: '/tmp/gemini', version: '1', compatibilityState: 'compatible' }
    Object.defineProperty(agent, NATIVE_CONFIG_IDENTITY_DIRECTORY, { value: directory })
    return agent
  }
  const { catalog, agents, state } = fixture({ detectAgents: async () => [detected()],
    credentialState: async () => ({ state: 'unknown', source: 'unverified' }) })
  await catalog.refresh()
  const identity = agentVerificationIdentity(agents()[0], state.agentPreferences)
  catalog.markRuntimeCredential('gemini', 'ready', { verificationIdentity: identity })
  assert.equal(agents()[0].recentlyVerified, true)
  assert.doesNotMatch(JSON.stringify(agents()), /gemini-identity|refresh_token/)
  fs.writeFileSync(filename, '{"refresh_token":"replacement"}')
  await catalog.refresh()
  assert.equal(agents()[0].recentlyVerified, false)
  catalog.markRuntimeCredential('gemini', 'ready', { verificationIdentity: identity })
  assert.equal(agents()[0].recentlyVerified, false)
})

test('OpenCode authentication file changes invalidate successful and late verification', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-opencode-auth-identity-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'auth.json')
  fs.writeFileSync(filename, '{"provider":{"type":"api","key":"first"}}')
  const detected = () => {
    const agent = { kind: 'opencode', executable: '/tmp/opencode', version: '1', compatibilityState: 'compatible' }
    Object.defineProperty(agent, NATIVE_AUTH_IDENTITY_FILES, { value: [filename] })
    return agent
  }
  const { catalog, agents, state } = fixture({ detectAgents: async () => [detected()],
    credentialState: async () => ({ state: 'unknown', source: 'unverified' }) })
  await catalog.refresh()
  const identity = agentVerificationIdentity(agents()[0], state.agentPreferences)
  catalog.markRuntimeCredential('opencode', 'ready', { verificationIdentity: identity })
  assert.equal(agents()[0].recentlyVerified, true)
  assert.doesNotMatch(JSON.stringify(agents()), /opencode-auth-identity|first/)
  fs.writeFileSync(filename, '{"provider":{"type":"api","key":"replacement"}}')
  await catalog.refresh()
  assert.equal(agents()[0].recentlyVerified, false)
  catalog.markRuntimeCredential('opencode', 'ready', { verificationIdentity: identity })
  assert.equal(agents()[0].recentlyVerified, false)
})

test('Gemini selected cloud credential changes invalidate prior and late verification', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-gemini-cloud-identity-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'credentials.json')
  fs.writeFileSync(filename, '{"token":"first"}')
  const { nativeAuthIdentityFiles } = require('../../src/agents/native-config-directory.cjs')
  const detected = () => {
    const agent = { kind: 'gemini', executable: '/tmp/gemini', version: '1', compatibilityState: 'compatible' }
    Object.defineProperty(agent, NATIVE_AUTH_IDENTITY_FILES, { value: nativeAuthIdentityFiles('gemini', {
      GOOGLE_APPLICATION_CREDENTIALS: filename,
    }, directory) })
    return agent
  }
  const { catalog, agents, state } = fixture({ detectAgents: async () => [detected()],
    credentialState: async () => ({ state: 'unknown', source: 'unverified' }) })
  await catalog.refresh()
  const identity = agentVerificationIdentity(agents()[0], state.agentPreferences)
  catalog.markRuntimeCredential('gemini', 'ready', { verificationIdentity: identity })
  assert.equal(agents()[0].recentlyVerified, true)
  fs.writeFileSync(filename, '{"token":"replacement"}')
  await catalog.refresh()
  assert.equal(agents()[0].recentlyVerified, false)
  catalog.markRuntimeCredential('gemini', 'ready', { verificationIdentity: identity })
  assert.equal(agents()[0].recentlyVerified, false)
  assert.doesNotMatch(JSON.stringify(agents()), /gemini-cloud-identity|replacement/)
})

test('DeepSeek profile edits immediately invalidate routing verification without a catalog refresh', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-dsh-profile-identity-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const profile = path.join(directory, 'profiles', 'acp')
  fs.mkdirSync(profile, { recursive: true })
  const config = path.join(profile, 'cordis.patch.yml')
  fs.writeFileSync(config, 'model: first\n')
  const agent = { kind: 'deepseek', executable: '/tmp/dsh', version: '1', compatibilityState: 'compatible' }
  const { catalog, state, agents } = fixture({ detectAgents: async () => [{ ...agent }],
    credentialState: async () => ({ state: 'unknown', source: 'unverified' }) })
  state.agentPreferences.deepseek = { nativeConfigDirectory: directory }
  await catalog.refresh()
  catalog.markRuntimeCredential('deepseek', 'ready')
  assert.equal(catalog.isRecentlyVerified('deepseek'), true)
  const { AgentRouter } = require('../../src/agents/agent-routing.cjs')
  const router = new AgentRouter({ isRecentlyVerified: item => catalog.isRecentlyVerified(item.kind) })
  const request = { agents: agents(), group: { id: 'group', agentKinds: ['deepseek'], allowWrite: false },
    input: { routingMode: 'automatic', targetKinds: [] }, mode: 'manual', inputTypes: ['text'], minContextChars: 20 }
  assert.deepEqual(router.route(request).selectedKinds, ['deepseek'])
  fs.writeFileSync(config, 'model: second-provider\n')
  assert.equal(catalog.isRecentlyVerified('deepseek'), false)
  assert.throws(() => router.route(request), { message: 'LOCAL_AGENT_ROUTING_UNVERIFIED' })
})

test('automatically discovered native directories invalidate verification without exposing the path', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-agent-auto-identity-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const config = path.join(directory, 'config.toml')
  fs.writeFileSync(config, 'model = "first"\n')
  const { NATIVE_CONFIG_IDENTITY_DIRECTORY } = require('../../src/agents/native-config-directory.cjs')
  const agent = { kind: 'codex', executable: '/tmp/codex', version: '1', compatibilityState: 'compatible' }
  Object.defineProperty(agent, NATIVE_CONFIG_IDENTITY_DIRECTORY, { value: directory })
  const { catalog, agents } = fixture({ detectAgents: async () => [agent],
    credentialState: async () => ({ state: 'unknown', source: 'unverified' }) })
  await catalog.refresh()
  catalog.markRuntimeCredential('codex', 'ready')
  assert.equal(catalog.isRecentlyVerified('codex'), true)
  assert.equal(Object.keys(agents()[0]).includes('nativeConfigIdentityDirectory'), false)
  assert.doesNotMatch(JSON.stringify(agents()), /meldwork-agent-auto-identity/)
  fs.writeFileSync(config, 'model = "different"\n')
  assert.equal(catalog.isRecentlyVerified('codex'), false)
})

test('Agent catalog module exposes only its coordinator', () => {
  assert.deepEqual(Object.keys(catalogApi), ['LocalWorkspaceAgentCatalog'])
})

test('sidebar preferences can hide an unavailable discovered Agent without enabling execution', () => {
  const kind = 'cloud-unavailable'
  const { catalog, state, agents } = fixture({ isKnownAgent: candidate => candidate === kind })
  catalog.setSidebarVisibility(kind, false)
  assert.equal(state.agentPreferences[kind].showInSidebar, false)
  assert.deepEqual(agents(), [])
  catalog.setSidebarVisibility(kind, true)
  assert.equal(state.agentPreferences[kind].showInSidebar, true)
  assert.throws(() => catalog.setSidebarVisibility('unknown', false), /LOCAL_AGENT_NOT_INSTALLED/)
})

test('WorkBuddy encrypted desktop login blocks standalone invocation with a specific configuration reason', async () => {
  const { catalog, agents, state } = fixture({
    detectAgents: async () => [{ kind: 'workbuddy', version: '2.132.0', compatibilityState: 'compatible' }],
    credentialState: async () => ({ state: 'unknown', source: 'workbuddy-desktop-locked' }),
  })
  state.messages.push({ role: 'agent', agentKind: 'workbuddy' })
  await catalog.refresh()
  assert.equal(agents()[0].available, false)
  assert.equal(agents()[0].availabilitySource, 'workbuddy-desktop-locked')
})

test('old Agent replies and expired runtime verification do not imply current authentication', async () => {
  const { catalog, agents, state } = fixture({
    detectAgents: async () => [{ kind: 'codex', version: '0.146.0', compatibilityState: 'compatible' }],
    credentialState: async () => ({ state: 'unknown', source: 'native-config-unknown' }),
  })
  state.messages.push({ role: 'agent', agentKind: 'codex' })
  state.agentRuntime.codex = { credentialState: 'ready', checkedAt: '2026-07-01T00:00:00.000Z' }
  await catalog.refresh()
  assert.equal(agents()[0].credentialState, 'unknown')
  assert.equal(agents()[0].recentlyVerified, false)
  assert.notEqual(agents()[0].availabilitySource, 'verified-run')
})

test('sidebar visibility preserves a selected WorkBuddy model', async () => {
  const { catalog, state } = fixture({ detectAgents: async () => [{ kind: 'workbuddy' }] })
  state.agentPreferences.workbuddy = { modelId: 'native-text' }
  await catalog.refresh()
  catalog.setSidebarVisibility('workbuddy', false)
  assert.deepEqual(state.agentPreferences.workbuddy, { modelId: 'native-text', showInSidebar: false })
})

test('one credential probe failure retains that installation and does not hide healthy peers', async () => {
  const { catalog } = fixture({
    detectAgents: async () => ['codex', 'claude'].map(kind => ({ kind, compatibilityState: 'compatible' })),
    credentialState: async (kind) => {
      if (kind === 'codex') throw new Error('probe failed')
      return { state: 'ready', source: 'native-auth-status' }
    },
  })
  const { agents } = await catalog.refresh()
  assert.deepEqual(agents.map(agent => agent.kind), ['codex', 'claude'])
  assert.deepEqual(agents.map(agent => agent.installed), [true, true])
  assert.deepEqual(agents.map(agent => agent.available), [false, true])
  assert.equal(agents[0].credentialState, 'unknown')
  assert.equal(agents[0].availabilitySource, 'native-probe-failed')
})

test('refresh starts credential checks concurrently and reads current runtime state after them', async () => {
  const codex = deferred()
  const hermes = deferred()
  const started = []
  const { agents, catalog, events, state } = fixture({
    detectAgents: async () => [
      { kind: 'codex', executable: '/tmp/codex', compatibilityState: 'compatible' },
      { kind: 'hermes', executable: '/tmp/hermes', compatibilityState: 'compatible' },
    ],
    credentialState: (kind) => {
      started.push(kind)
      return kind === 'codex' ? codex.promise : hermes.promise
    },
  })

  const refresh = catalog.refresh()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(started, ['codex', 'hermes'])
  state.agentRuntime.codex = { credentialState: 'missing' }
  codex.resolve({ state: 'ready', source: 'native-auth-status' })
  hermes.resolve({ state: 'ready', source: 'native-credential' })

  const snapshot = await refresh
  assert.deepEqual(agents().map(agent => agent.kind), ['codex', 'hermes'])
  assert.deepEqual(snapshot.agents.map(agent => agent.credentialState), ['missing', 'ready'])
  assert.deepEqual(snapshot.agents.map(agent => agent.invocable), [false, true])
  assert.equal(snapshot.agents[0].availabilitySource, 'runtime-auth-failure')
  assert.deepEqual(events, ['emit', 'snapshot'])
})

test('concurrent refresh requests run in order instead of racing Agent snapshots', async () => {
  const first = deferred()
  const second = deferred()
  let calls = 0
  let active = 0
  let maxActive = 0
  const { agents, catalog } = fixture({
    detectAgents: async () => {
      calls += 1
      active += 1
      maxActive = Math.max(maxActive, active)
      const result = await (calls === 1 ? first.promise : second.promise)
      active -= 1
      return result
    },
  })

  const initial = catalog.refresh()
  await new Promise(resolve => setImmediate(resolve))
  const queued = catalog.refresh()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
  assert.equal(maxActive, 1)

  first.resolve([{ kind: 'hermes', compatibilityState: 'compatible' }])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 2)
  assert.equal(maxActive, 1)

  second.resolve([{ kind: 'codex', compatibilityState: 'compatible' }])
  await Promise.all([initial, queued])
  assert.deepEqual(agents().map(agent => agent.kind), ['codex'])
  assert.equal(active, 0)
})

test('incompatible Agents remain installed but unavailable with ready credentials', async () => {
  const { agents, catalog, events } = fixture({
    detectAgents: async () => [{
      kind: 'codex',
      executable: '/tmp/codex',
      compatibilityState: 'incompatible',
      resolvedVersion: '0.147.0',
      incompatibilityReason: 'LOCAL_AGENT_VERSION_UNSUPPORTED',
    }],
    credentialState: async () => ({ state: 'ready', source: 'native-auth-status' }),
  })

  await catalog.refresh()

  assert.equal(agents()[0].installed, true)
  assert.equal(agents()[0].versionIdentified, true)
  assert.equal(agents()[0].compatible, false)
  assert.equal(agents()[0].configured, true)
  assert.equal(agents()[0].authenticated, true)
  assert.equal(agents()[0].invocable, false)
  assert.equal(agents()[0].credentialState, 'ready')
  assert.equal(agents()[0].available, false)
  assert.equal(agents()[0].showInSidebar, true)
  assert.equal(agents()[0].availabilitySource, 'incompatible')
  assert.equal(agents()[0].incompatibilityReason, 'LOCAL_AGENT_VERSION_UNSUPPORTED')
  assert.deepEqual(events, ['emit', 'snapshot'])
  catalog.setSidebarVisibility('codex', false)
  assert.equal(agents()[0].showInSidebar, false)
  catalog.setSidebarVisibility('codex', true)
  assert.equal(agents()[0].showInSidebar, true)
  assert.equal(agents()[0].available, false)
})

test('locally detected compatible Agents remain invocable when native configuration cannot be inspected', async () => {
  const { agents, catalog } = fixture({
    detectAgents: async () => [{
      kind: 'pi', executable: '/tmp/pi', compatibilityState: 'compatible',
    }, {
      kind: 'opencode', executable: '/tmp/opencode', compatibilityState: 'compatible',
    }],
  })

  await catalog.refresh()

  assert.deepEqual(agents().map(agent => ({
    kind: agent.kind,
    configured: agent.configured,
    authenticated: agent.authenticated,
    invocable: agent.invocable,
    available: agent.available,
    availabilitySource: agent.availabilitySource,
  })), [{
    kind: 'pi', configured: false, authenticated: false, invocable: true,
    available: true, availabilitySource: 'local-cli',
  }, {
    kind: 'opencode', configured: false, authenticated: false, invocable: true,
    available: true, availabilitySource: 'local-cli',
  }])
})

test('a discovered credential allows a manual attempt without claiming verified authentication', async () => {
  const { agents, catalog } = fixture({
    detectAgents: async () => [{ kind: 'codex', executable: '/tmp/codex', compatibilityState: 'compatible' }],
    credentialState: async () => ({ state: 'ready', source: 'native-credential' }),
  })
  await catalog.refresh()
  assert.equal(agents()[0].configured, true)
  assert.equal(agents()[0].authenticated, false)
  assert.equal(agents()[0].invocable, true)
  assert.equal(agents()[0].recentlyVerified, false)
  catalog.markRuntimeCredential('codex', 'ready')
  assert.equal(agents()[0].authenticated, true)
  assert.equal(agents()[0].recentlyVerified, true)
})

test('native readiness cannot override a recorded runtime auth failure', async () => {
  const { agents, catalog, events, state } = fixture({
    detectAgents: async () => [{
      kind: 'codex', executable: '/tmp/codex', compatibilityState: 'compatible',
    }],
    credentialState: async () => ({ state: 'ready', source: 'native-credential' }),
  })
  state.agentRuntime.codex = {
    credentialState: 'missing', checkedAt: '2026-08-03T00:00:00.000Z',
  }

  await catalog.refresh()

  assert.equal(agents()[0].credentialState, 'missing')
  assert.equal(agents()[0].available, false)
  assert.equal(agents()[0].availabilitySource, 'runtime-auth-failure')
  assert.deepEqual(events, ['emit', 'snapshot'])
})

test('expired auth failures allow native credentials to be tried again', async () => {
  const { agents, catalog, state } = fixture({
    detectAgents: async () => [{ kind: 'codex', compatibilityState: 'compatible' }],
    credentialState: async () => ({ state: 'unknown', source: 'unverified' }),
  })
  state.agentRuntime.codex = {
    credentialState: 'missing', checkedAt: '2026-08-02T23:59:29.000Z',
  }
  await catalog.refresh()
  assert.equal(agents()[0].invocable, true)
  assert.equal(state.agentRuntime.codex, undefined)
  assert.equal(agents()[0].recentlyVerified, false)
})

test('legacy authentication failures with missing or invalid timestamps permit re-evaluation', async () => {
  for (const checkedAt of [undefined, 'invalid', '2026-08-04T00:00:00.000Z']) {
    const { agents, catalog, state } = fixture({
      detectAgents: async () => [{ kind: 'pi', compatibilityState: 'compatible' }],
    })
    state.agentRuntime.pi = { credentialState: 'missing', checkedAt }
    await catalog.refresh()
    assert.equal(agents()[0].invocable, true)
    assert.equal(agents()[0].recentlyVerified, false)
    assert.equal(state.agentRuntime.pi, undefined)
  }
})

test('recent runtime authentication failures stay blocked during the retry cooldown', async () => {
  const { agents, catalog, state } = fixture({
    detectAgents: async () => [{ kind: 'codex', compatibilityState: 'compatible' }],
    credentialState: async () => ({ state: 'ready', source: 'native-credential' }),
  })
  state.agentRuntime.codex = {
    credentialState: 'missing', checkedAt: '2026-08-02T23:59:45.000Z',
  }
  await catalog.refresh()
  assert.equal(agents()[0].invocable, false)
  assert.equal(agents()[0].availabilitySource, 'runtime-auth-failure')
})

test('Claude API key and cloud status cannot erase a recent runtime authentication failure', async () => {
  const { resolveNativeCredentialState } = require('../../src/agents/local-agent-readiness.cjs')
  for (const authMethod of ['api_key', 'third_party']) {
    const { agents, catalog, state } = fixture({
      detectAgents: async () => [{ kind: 'claude', compatibilityState: 'compatible' }],
      credentialState: () => resolveNativeCredentialState('claude', {
        executable: '/tmp/claude', env: { ANTHROPIC_API_KEY: 'unverified-key' },
        execFileFn: async () => ({ stdout: JSON.stringify({ loggedIn: true, authMethod }) }),
      }),
    })
    state.agentRuntime.claude = {
      credentialState: 'missing', checkedAt: '2026-08-02T23:59:45.000Z',
    }
    await catalog.refresh()
    assert.equal(agents()[0].invocable, false)
    assert.equal(agents()[0].availabilitySource, 'runtime-auth-failure')
    assert.equal(state.agentRuntime.claude.credentialState, 'missing')
  }
})

test('configured credentials do not make an Agent invocable when runtime prerequisites fail', async () => {
  const { agents, catalog } = fixture({
    detectAgents: async () => [{
      kind: 'openclaw',
      executable: '/tmp/openclaw',
      resolvedVersion: '2026.7.1-2',
      compatibilityState: 'compatible',
    }],
    credentialState: async () => ({
      state: 'unknown', source: 'native-runtime-unavailable',
    }),
  })

  await catalog.refresh()

  assert.deepEqual(Object.fromEntries([
    'installed', 'versionIdentified', 'compatible', 'configured', 'authenticated',
    'invocable', 'recentlyVerified', 'available',
  ].map(key => [key, agents()[0][key]])), {
    installed: true,
    versionIdentified: true,
    compatible: true,
    configured: true,
    authenticated: false,
    invocable: false,
    recentlyVerified: false,
    available: false,
  })
  assert.equal(agents()[0].availabilitySource, 'native-runtime-unavailable')
  catalog.markRuntimeCredential('openclaw', 'ready')
  assert.equal(agents()[0].available, false)
  assert.equal(agents()[0].invocable, false)
  assert.equal(agents()[0].availabilitySource, 'native-runtime-unavailable')
})

test('review-only custom Agents stay out of the sidebar across runtime credential changes', async () => {
  const kind = 'custom-0123456789abcdef'
  const { agents, catalog } = fixture({
    detectAgents: async () => [{ kind, custom: true, capabilities: { domains: ['software-review'] } }],
    credentialState: async () => ({ state: 'ready', source: 'native-credential' }),
  })
  await catalog.refresh()
  assert.equal(agents()[0].task, 'code_review')
  assert.equal(agents()[0].showInSidebar, false)
  catalog.markRuntimeCredential(kind, 'missing')
  catalog.markRuntimeCredential(kind, 'ready')
  assert.equal(agents()[0].showInSidebar, false)
})

test('runtime credential changes do not clear a WorkBuddy native model blocker', async () => {
  const { agents, catalog } = fixture({
    detectAgents: async () => [{ kind: 'workbuddy', compatibilityState: 'compatible' }],
    credentialState: async () => ({ state: 'ready', source: 'workbuddy-model-unavailable' }),
  })
  await catalog.refresh()
  assert.equal(agents()[0].available, false)
  catalog.markRuntimeCredential('workbuddy', 'missing')
  catalog.markRuntimeCredential('workbuddy', 'ready')
  assert.equal(agents()[0].available, false)
  assert.equal(agents()[0].availabilitySource, 'workbuddy-model-unavailable')
})

test('runtime credentials do not make an uninstalled Agent invocable', () => {
  const { agents, catalog } = fixture({ initialAgents: [{
    kind: 'codex', installed: false, compatible: true, compatibilityState: 'compatible',
    versionIdentified: true, task: 'general',
  }] })
  catalog.markRuntimeCredential('codex', 'ready')
  assert.equal(agents()[0].invocable, false)
  assert.equal(agents()[0].available, false)
})

test('unidentified product versions remain unavailable after credential validation', async () => {
  const { agents, catalog } = fixture({
    detectAgents: async () => [{
      kind: 'kimi',
      executable: '/tmp/kimi',
      resolvedVersion: '',
      compatibilityState: 'unknown',
    }],
    credentialState: async () => ({ state: 'ready', source: 'native-auth-status' }),
  })

  await catalog.refresh()

  assert.equal(agents()[0].versionIdentified, false)
  assert.equal(agents()[0].compatible, false)
  assert.equal(agents()[0].configured, true)
  assert.equal(agents()[0].authenticated, true)
  assert.equal(agents()[0].invocable, false)
  assert.equal(agents()[0].recentlyVerified, false)
  assert.equal(agents()[0].available, false)
})

test('catalog does not route an ambiguous product version even when capability and auth probes succeed', async () => {
  const { detectAgents } = require('../../src/agents/cli/cli-discovery.cjs')
  const { agents, catalog } = fixture({
    detectAgents: () => detectAgents({
      platform: 'darwin', env: {},
      resolveExecutableFn: async kind => kind === 'kimi' ? '/tmp/kimi' : null,
      execFileFn: async () => ({ stdout: 'Kimi Code 0.19.2\nKimi Code 0.20.0\n', stderr: '' }),
      probeAgentCapabilitiesFn: async () => ({ compatibilityState: 'compatible' }),
    }),
    credentialState: async () => ({ state: 'ready', source: 'native-auth-status' }),
  })
  await catalog.refresh()
  assert.equal(agents()[0].compatible, true)
  assert.equal(agents()[0].versionIdentified, false)
  assert.equal(agents()[0].invocable, false)
  assert.equal(agents()[0].available, false)
})

test('Zcode native multi-component version output remains invocable after detection', async () => {
  const { detectAgents } = require('../../src/agents/cli/cli-discovery.cjs')
  const { agents, catalog } = fixture({
    detectAgents: () => detectAgents({
      platform: 'darwin', env: {},
      resolveExecutableFn: async kind => kind === 'zcode' ? '/tmp/zcode' : null,
      execFileFn: async () => ({ stdout: 'zcode-app-cli 3.7.5-11\nzcode-runtime 0.16.1\n', stderr: '' }),
      probeAgentCapabilitiesFn: async () => ({ compatibilityState: 'compatible' }),
    }),
    credentialState: async () => ({ state: 'ready', source: 'native-auth-status' }),
  })
  await catalog.refresh()
  assert.equal(agents()[0].resolvedVersion, '0.16.1')
  assert.equal(agents()[0].versionIdentified, true)
  assert.equal(agents()[0].invocable, true)
  assert.equal(agents()[0].available, true)
})

test('authoritative native validation persists recovery from a runtime auth failure', async () => {
  const { agents, catalog, events, state } = fixture({
    detectAgents: async () => [{
      kind: 'mimo', executable: '/tmp/mimo', compatibilityState: 'compatible',
    }],
    credentialState: async () => ({ state: 'ready', source: 'native-auth-status' }),
  })
  state.agentRuntime.mimo = { credentialState: 'missing' }

  await catalog.refresh()

  assert.deepEqual(state.agentRuntime.mimo, {
    credentialState: 'ready', checkedAt: '2026-08-03T00:00:00.000Z',
  })
  assert.equal(agents()[0].credentialState, 'ready')
  assert.equal(agents()[0].recentlyVerified, false)
  assert.equal(agents()[0].invocable, true)
  assert.equal(agents()[0].available, true)
  assert.equal(agents()[0].availabilitySource, 'native-auth-status')
  assert.deepEqual(events, ['save', 'emit', 'snapshot'])
})

test('failed refresh preserves the previous Agent list without emitting changes', async () => {
  const previous = [{ kind: 'codex', available: true }]
  const { agents, catalog, events } = fixture({
    initialAgents: previous,
    detectAgents: async () => { throw new Error('installation discovery failed') },
  })

  await assert.rejects(catalog.refresh(), { message: 'installation discovery failed' })
  assert.equal(agents(), previous)
  assert.deepEqual(events, [])
})

test('sidebar and runtime credential mutations preserve persistence and event ordering', () => {
  const initialAgent = {
    kind: 'codex', available: true, credentialState: 'ready', showInSidebar: true,
  }
  const { agents, catalog, events, state } = fixture({ initialAgents: [initialAgent] })

  assert.deepEqual(catalog.setSidebarVisibility('codex', false), { agents: [initialAgent] })
  assert.deepEqual(events, ['save', 'emit', 'snapshot'])
  assert.equal(state.agentPreferences.codex.showInSidebar, false)

  events.length = 0
  catalog.markRuntimeCredential('codex', 'missing')
  assert.deepEqual(events, ['save', 'emit'])
  assert.deepEqual(state.agentRuntime.codex, {
    credentialState: 'missing', checkedAt: '2026-08-03T00:00:00.000Z',
  })
  assert.equal(agents()[0].available, false)
  assert.equal(agents()[0].availabilitySource, 'runtime-auth-failure')
  assert.equal(agents()[0].showInSidebar, false)

  events.length = 0
  state.agentRuntime.hermes = { credentialState: 'missing' }
  catalog.markRuntimeCredential('codex', 'unknown')
  assert.deepEqual(events, ['save', 'emit'])
  assert.equal(state.agentRuntime.codex.credentialState, 'unknown')
  assert.equal(state.agentRuntime.hermes.credentialState, 'missing')
  assert.equal(agents()[0].credentialState, 'unknown')
  assert.equal(agents()[0].available, false)
  assert.equal(agents()[0].availabilitySource, 'unverified')
})

test('OpenCodeReview can be enabled in the conversation sidebar', () => {
  const reviewAgent = {
    kind: 'opencodereview', available: true, credentialState: 'ready', showInSidebar: false,
  }
  const { agents, catalog, events, state } = fixture({ initialAgents: [reviewAgent] })

  assert.deepEqual(catalog.setSidebarVisibility('opencodereview', true), { agents: [reviewAgent] })
  assert.deepEqual(events, ['save', 'emit', 'snapshot'])
  assert.equal(state.agentPreferences.opencodereview.showInSidebar, true)
  assert.equal(agents()[0].showInSidebar, true)
})

test('runtime failure and recovery preserve sidebar preference independently of availability', async () => {
  const { catalog, agents } = fixture({
    detectAgents: async () => [{ kind: 'codex', compatibilityState: 'compatible' }],
    credentialState: async () => ({ state: 'ready', source: 'native-credential' }),
  })
  await catalog.refresh()
  catalog.markRuntimeCredential('codex', 'missing')
  assert.equal(agents()[0].available, false)
  assert.equal(agents()[0].showInSidebar, true)
  await catalog.refresh()
  assert.equal(agents()[0].showInSidebar, true)
  catalog.setSidebarVisibility('codex', false)
  catalog.markRuntimeCredential('codex', 'ready')
  assert.equal(agents()[0].available, true)
  assert.equal(agents()[0].showInSidebar, false)
  await catalog.refresh()
  assert.equal(agents()[0].showInSidebar, false)
})

test('runtime credential cleanup removes only missing entries and never emits', () => {
  const { catalog, events, state } = fixture()
  state.agentRuntime = {
    codex: { credentialState: 'missing' },
    hermes: { credentialState: 'ready' },
    kimi: { credentialState: 'unknown' },
  }

  assert.equal(catalog.clearRuntimeCredentialFailures(), true)
  assert.deepEqual(state.agentRuntime, {
    hermes: { credentialState: 'ready' },
    kimi: { credentialState: 'unknown' },
  })
  assert.deepEqual(events, ['save'])

  events.length = 0
  assert.equal(catalog.clearRuntimeCredentialFailures(), false)
  assert.deepEqual(events, [])
})

function clock(start = '2026-08-03T00:00:00.000Z') {
  let current = Date.parse(start)
  return {
    now: () => new Date(current).toISOString(),
    advance: (ms) => { current += ms },
  }
}

const OPENCLAW = {
  kind: 'openclaw', executable: '/tmp/openclaw', resolvedVersion: '2026.7.1-2', compatibilityState: 'compatible',
}

test('an Agent that was usable stays usable while its readiness probe is inconclusive, for a bounded time', async () => {
  const time = clock()
  let probe = { state: 'ready', source: 'native-auth-status' }
  const { agents, catalog } = fixture({
    now: time.now,
    detectAgents: async () => [OPENCLAW],
    credentialState: async () => probe,
  })

  await catalog.refresh()
  assert.equal(agents()[0].available, true)
  assert.equal(agents()[0].availabilitySource, 'native-auth-status')

  // The 7 second status check times out: no answer, not "signed out".
  probe = { state: 'unknown', source: 'native-probe-failed' }
  time.advance(60 * 1000)
  await catalog.refresh()
  assert.equal(agents()[0].available, true)
  assert.equal(agents()[0].authenticated, true)
  assert.equal(agents()[0].credentialState, 'ready')
  assert.equal(agents()[0].availabilitySource, 'native-auth-status')

  time.advance(8 * 60 * 1000)
  await catalog.refresh()
  assert.equal(agents()[0].available, true, 'still inside the 10 minute window')

  time.advance(2 * 60 * 1000)
  await catalog.refresh()
  assert.equal(agents()[0].available, false, 'a probe that keeps failing is eventually reported')

  // One good answer restores it and restarts the window.
  probe = { state: 'ready', source: 'native-auth-status' }
  await catalog.refresh()
  assert.equal(agents()[0].available, true)
  probe = { state: 'unknown', source: 'native-probe-failed' }
  time.advance(60 * 1000)
  await catalog.refresh()
  assert.equal(agents()[0].available, true)
})

test('an Agent that was never usable is not made available by an inconclusive probe', async () => {
  const { agents, catalog } = fixture({
    detectAgents: async () => [OPENCLAW],
    credentialState: async () => ({ state: 'unknown', source: 'native-runtime-unavailable' }),
  })
  await catalog.refresh()
  await catalog.refresh()
  assert.equal(agents()[0].available, false)
})

test('OpenClaw immediately becomes unavailable when its guarded runtime is unavailable', async () => {
  let probe = { state: 'ready', source: 'native-auth-status' }
  const { agents, catalog } = fixture({
    detectAgents: async () => [OPENCLAW], credentialState: async () => probe,
  })
  await catalog.refresh()
  assert.equal(agents()[0].available, true)
  probe = { state: 'unknown', source: 'native-runtime-unavailable' }
  await catalog.refresh()
  assert.equal(agents()[0].runtimePrerequisitesReady, false)
  assert.equal(agents()[0].available, false)
  assert.equal(agents()[0].availabilitySource, 'native-runtime-unavailable')
})

test('a definitive signed-out answer, a recorded auth failure or an incompatible version is never softened', async () => {
  const time = clock()
  let probe = { state: 'ready', source: 'native-auth-status' }
  let detected = { ...OPENCLAW }
  const { agents, catalog, state } = fixture({
    now: time.now,
    detectAgents: async () => [detected],
    credentialState: async () => probe,
  })
  await catalog.refresh()
  assert.equal(agents()[0].available, true)

  probe = { state: 'missing', source: 'native-auth-status' }
  await catalog.refresh()
  assert.equal(agents()[0].available, false)

  probe = { state: 'ready', source: 'native-auth-status' }
  await catalog.refresh()
  assert.equal(agents()[0].available, true)
  state.agentRuntime.openclaw = { credentialState: 'missing', checkedAt: time.now() }
  probe = { state: 'unknown', source: 'native-probe-failed' }
  await catalog.refresh()
  assert.equal(agents()[0].available, false)

  delete state.agentRuntime.openclaw
  probe = { state: 'ready', source: 'native-auth-status' }
  await catalog.refresh()
  assert.equal(agents()[0].available, true)
  detected = { ...OPENCLAW, compatibilityState: 'incompatible' }
  probe = { state: 'unknown', source: 'native-probe-failed' }
  await catalog.refresh()
  assert.equal(agents()[0].available, false)
})

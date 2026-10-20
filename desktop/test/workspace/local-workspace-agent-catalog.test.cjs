const assert = require('node:assert/strict')
const test = require('node:test')

const catalogApi = require('../../src/workspace/local-workspace-agent-catalog.cjs')
const { LocalWorkspaceAgentCatalog } = catalogApi

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

test('Agent catalog module exposes only its coordinator', () => {
  assert.deepEqual(Object.keys(catalogApi), ['LocalWorkspaceAgentCatalog'])
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
    kind: 'pi', configured: true, authenticated: true, invocable: true,
    available: true, availabilitySource: 'local-cli',
  }, {
    kind: 'opencode', configured: true, authenticated: true, invocable: true,
    available: true, availabilitySource: 'local-cli',
  }])
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
  assert.equal(agents()[0].recentlyVerified, true)
  assert.equal(agents()[0].available, false)
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
  assert.equal(agents()[0].recentlyVerified, true)
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
  probe = { state: 'unknown', source: 'native-runtime-unavailable' }
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
  probe = { state: 'unknown', source: 'native-runtime-unavailable' }
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

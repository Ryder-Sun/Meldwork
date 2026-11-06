const test = require('node:test')
const assert = require('node:assert/strict')

const {
  AgentRouter,
  normalizeFitMatrix,
  normalizeRoutingDecision,
} = require('../../src/agents/agent-routing.cjs')
const frozenMatrix = require('../../src/evaluations/data/agent-fit-matrix.v1.json')

function agent(kind, overrides = {}) {
  return { kind, available: true, invocable: true, recentlyVerified: true, ...overrides }
}

function request(overrides = {}) {
  return {
    agents: [agent('codex'), agent('hermes')],
    group: {
      id: 'group-routing',
      agentKinds: ['codex', 'hermes'],
      allowWrite: false,
    },
    input: { targetKinds: ['codex'] },
    mode: 'manual',
    inputTypes: ['text'],
    minContextChars: 20,
    ...overrides,
  }
}

test('explicit routing rejects malformed targets instead of silently reducing them', () => {
  const router = new AgentRouter()
  assert.throws(
    () => router.route(request({ input: { targetKinds: 'codex' } })),
    { message: 'LOCAL_MESSAGE_TARGET_REQUIRED' },
  )
  assert.throws(
    () => router.route(request({ input: { targetKinds: ['codex', 'codex'] } })),
    error => error.code === 'LOCAL_MESSAGE_TARGET_DUPLICATE'
      && error.routingDiagnostic.code === error.code,
  )
  assert.throws(
    () => router.route(request({ input: { targetKinds: ['unknown-agent'] } })),
    { message: 'LOCAL_MESSAGE_TARGET_UNKNOWN' },
  )
  assert.throws(
    () => router.route(request({ input: { targetKinds: ['qwen'] } })),
    error => error.code === 'LOCAL_MESSAGE_TARGET_OUT_OF_GROUP'
      && error.routingDiagnostic.kind === 'qwen',
  )
  assert.throws(
    () => router.route(request({
      agents: [agent('codex', { available: false, invocable: false }), agent('hermes')],
    })),
    error => error.code === 'LOCAL_AGENT_UNAVAILABLE'
      && error.routingDiagnostic.kind === 'codex',
  )
})

test('an explicit target bypasses automatic formation and remains authoritative', () => {
  const decision = new AgentRouter().route(request({
    input: { routingMode: 'automatic', targetKinds: ['hermes'] },
  }))

  assert.equal(decision.mode, 'explicit')
  assert.deepEqual(decision.selectedKinds, ['hermes'])
  assert.equal(decision.rationale, 'explicit-user-selection')
})

test('automatic routing excludes unverified Agents while explicit selection can start a first run', () => {
  const router = new AgentRouter()
  const agents = [agent('codex', { recentlyVerified: false, credentialState: 'ready' }), agent('hermes')]
  const automatic = router.route(request({ agents, input: { routingMode: 'automatic', targetKinds: [] } }))
  assert.deepEqual(automatic.selectedKinds, ['hermes'])
  assert.deepEqual(automatic.candidates.find(candidate => candidate.kind === 'codex').exclusions, ['unverified'])
  const explicit = router.route(request({ agents, input: { targetKinds: ['codex'] } }))
  assert.deepEqual(explicit.selectedKinds, ['codex'])
  assert.throws(() => router.route(request({ agents: [agents[0]],
    group: { id: 'group-routing', agentKinds: ['codex'], allowWrite: false },
    input: { routingMode: 'automatic', targetKinds: [] } })), { message: 'LOCAL_AGENT_ROUTING_UNVERIFIED' })
  assert.throws(() => router.route(request({ agents, mode: 'auto',
    input: { routingMode: 'automatic', targetKinds: [] } })), { message: 'LOCAL_AGENT_ROUTING_UNVERIFIED' })
})

test('explicit specialized Agents are not assigned an invented general-domain requirement', () => {
  const specialized = agent('custom-aaaaaaaaaaaaaaaa', {
    routingCapabilities: {
      domains: ['software-review'],
      inputTypes: ['text'],
      outputTypes: ['text', 'evidence'],
      toolClasses: ['agent-native'],
      permissionModes: ['read-only'],
      latencyBand: 'unknown',
      costBand: 'unknown',
      contextLimitChars: 20000,
      resumable: true,
    },
  })
  const router = new AgentRouter()
  const base = request({
    agents: [specialized],
    group: {
      id: 'group-routing',
      agentKinds: [specialized.kind],
      allowWrite: false,
    },
    input: { targetKinds: [specialized.kind] },
  })

  const decision = router.route(base)
  assert.deepEqual(decision.requirements.domains, [])
  assert.deepEqual(decision.selectedKinds, [specialized.kind])
  assert.throws(
    () => router.route({
      ...base,
      input: {
        targetKinds: [specialized.kind],
        routingRequirements: { domains: ['general'] },
      },
    }),
    { message: 'LOCAL_AGENT_CAPABILITY_MISMATCH' },
  )
})

test('explicit OpenCodeReview targets keep writable direct conversations routable as read-only review work', () => {
  const decision = new AgentRouter().route(request({
    agents: [agent('opencodereview')],
    group: {
      id: 'group-routing',
      agentKinds: ['opencodereview'],
      allowWrite: true,
    },
    input: { targetKinds: ['opencodereview'] },
  }))

  assert.deepEqual(decision.selectedKinds, ['opencodereview'])
  assert.equal(decision.requirements.permissionMode, 'read-only')
  assert.deepEqual(
    decision.candidates.find(candidate => candidate.kind === 'opencodereview').exclusions,
    [],
  )
})

test('explicit Connector Agents use their declared runtime capabilities', () => {
  const connector = agent('custom-bbbbbbbbbbbbbbbb', {
    capabilities: {
      domains: ['software-review'],
      inputTypes: ['text'],
      permissionModes: ['read-only'],
      session: { supported: true, resume: true },
      eventTypes: ['SourceUsed', 'Evidence', 'Completed'],
    },
  })
  const decision = new AgentRouter().route(request({
    agents: [connector],
    group: {
      id: 'group-routing',
      agentKinds: [connector.kind],
      allowWrite: false,
    },
    input: { targetKinds: [connector.kind] },
    inputTypes: ['text'],
  }))

  assert.deepEqual(decision.selectedKinds, [connector.kind])
  assert.deepEqual(decision.candidates[0].exclusions, [])
})

test('automatic routing chooses the smallest suitable approved team', () => {
  const router = new AgentRouter()
  const single = router.route(request({
    agents: [agent('codex'), agent('hermes'), agent('qwen')],
    group: {
      id: 'group-routing',
      agentKinds: ['codex', 'hermes'],
      allowWrite: false,
    },
    input: { routingMode: 'automatic', targetKinds: [] },
  }))
  assert.equal(single.mode, 'automatic')
  assert.deepEqual(single.selectedKinds, ['codex'])
  assert.deepEqual(single.candidates.map(candidate => candidate.kind), ['codex', 'hermes'])

  const collaborative = router.route(request({
    input: { routingMode: 'automatic', targetKinds: [] },
    mode: 'auto',
  }))
  assert.deepEqual(collaborative.selectedKinds, ['codex', 'hermes'])
  assert.equal(collaborative.requirements.collaboration, 'required')
})

test('automatic routing respects permissions and capability requirements', () => {
  const restricted = agent('custom-aaaaaaaaaaaaaaaa', {
    routingCapabilities: {
      domains: ['general'],
      inputTypes: ['text'],
      outputTypes: ['text'],
      toolClasses: ['agent-native'],
      permissionModes: ['read-only'],
      latencyBand: 'low',
      costBand: 'low',
      contextLimitChars: 20000,
      resumable: false,
    },
  })
  const router = new AgentRouter()
  const decision = router.route(request({
    agents: [restricted, agent('codex')],
    group: {
      id: 'group-routing',
      agentKinds: [restricted.kind, 'codex'],
      allowWrite: true,
    },
    input: { routingMode: 'automatic', targetKinds: [] },
  }))

  assert.deepEqual(decision.selectedKinds, ['codex'])
  assert.deepEqual(
    decision.candidates.find(candidate => candidate.kind === restricted.kind).exclusions,
    ['permission'],
  )
})

test('frozen Eval Harness evidence influences routing without static brand preference', () => {
  const router = new AgentRouter({
    fitMatrix: {
      version: 'fit-matrix-2026-08-10',
      entries: [
        { kind: 'codex', domains: ['general'], score: 70, confidence: 0.8, sampleSize: 10 },
        { kind: 'hermes', domains: ['general'], score: 92, confidence: 0.9, sampleSize: 12 },
      ],
    },
  })
  const decision = router.route(request({
    input: { routingMode: 'automatic', targetKinds: [] },
  }))

  assert.deepEqual(decision.selectedKinds, ['hermes'])
  assert.equal(decision.rationale, 'evidence-ranked-team')
  assert.equal(decision.evidenceVersion, 'fit-matrix-2026-08-10')
  assert.equal(decision.candidates.find(candidate => candidate.kind === 'hermes').evidence.sampleSize, 12)
})

test('automatic routing ignores low-sample or low-confidence Eval evidence', () => {
  const router = new AgentRouter({
    fitMatrix: {
      version: 'fit-matrix-insufficient-v1',
      entries: [
        { kind: 'codex', domains: ['general'], score: 10, confidence: 0.9, sampleSize: 2 },
        { kind: 'hermes', domains: ['general'], score: 100, confidence: 0.59, sampleSize: 20 },
      ],
    },
  })
  const decision = router.route(request({
    input: { routingMode: 'automatic', targetKinds: [] },
  }))

  assert.deepEqual(decision.selectedKinds, ['codex'])
  assert.equal(decision.rationale, 'smallest-suitable-team')
  assert.equal(decision.evidenceVersion, '')
  assert.equal(decision.candidates.some(candidate => candidate.evidence), false)
})

test('routing consumes a strict content-addressed frozen matrix without weak evidence', () => {
  const normalized = normalizeFitMatrix(frozenMatrix)
  assert.equal(normalized.version, frozenMatrix.matrixId)
  assert.deepEqual(normalized.entries, [])

  const decision = new AgentRouter({ fitMatrix: frozenMatrix }).route(request({
    input: { routingMode: 'automatic', targetKinds: [] },
  }))
  assert.equal(decision.rationale, 'smallest-suitable-team')
  assert.equal(decision.evidenceVersion, '')
})

test('persisted routing decisions use a strict bounded public schema', () => {
  const decision = new AgentRouter().route(request())
  assert.deepEqual(normalizeRoutingDecision(decision), decision)
  assert.equal(normalizeRoutingDecision({ ...decision, executable: '/tmp/codex' }), null)
  assert.equal(normalizeRoutingDecision({
    ...decision,
    candidates: [{
      ...decision.candidates[0],
      exclusions: ['credential-secret'],
    }],
  }), null)
})

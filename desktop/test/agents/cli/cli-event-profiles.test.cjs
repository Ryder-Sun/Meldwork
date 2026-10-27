const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  CONNECTOR_EVENT_PROFILES,
  connectorLimitedRuntimeEvent,
  resolveConnectorEventProfile,
} = require('../../../src/agents/cli/cli-event-profiles.cjs')
const { invocation } = require('../../../src/agents/cli/cli-invocations.cjs')

const GEMINI_TOOL_FIXTURE = path.join(
  __dirname, '..', '..', 'fixtures', 'agent-output', 'gemini-tool-lifecycle.jsonl',
)

const PROFILE_EXPECTATIONS = {
  zcode: {
    profileId: 'zcode-prompt-json-v1', protocol: 'zcode-prompt-json', framing: 'document',
    source: 'stdout', answerMode: 'final', tools: { start: false, update: false, result: false },
    plan: false, reasoning: false, session: true, terminal: true,
  },
  codex: {
    profileId: 'codex-app-server-jsonl-v1', protocol: 'codex-app-server', framing: 'jsonl',
    source: 'stdout', answerMode: 'delta', tools: { start: true, update: false, result: true },
    plan: true, reasoning: true, session: true, terminal: true,
  },
  hermes: {
    profileId: 'acp-jsonrpc-v1', protocol: 'acp', framing: 'jsonrpc-jsonl',
    source: 'acp', answerMode: 'delta', tools: { start: true, update: true, result: true },
    plan: true, reasoning: false, session: true, terminal: true,
  },
  openclaw: {
    profileId: 'acp-jsonrpc-v1', protocol: 'acp', framing: 'jsonrpc-jsonl',
    source: 'acp', answerMode: 'delta', tools: { start: true, update: true, result: true },
    plan: true, reasoning: false, session: true, terminal: true,
  },
  workbuddy: {
    profileId: 'workbuddy-terminal-result-json-v1', protocol: 'workbuddy-terminal-result-json',
    framing: 'document', source: 'stdout', answerMode: 'final',
    tools: { start: false, update: false, result: false },
    plan: false, reasoning: false, session: true, terminal: true,
  },
  kimi: {
    profileId: 'acp-jsonrpc-v1', protocol: 'acp', framing: 'jsonrpc-jsonl',
    source: 'acp', answerMode: 'delta', tools: { start: true, update: true, result: true },
    plan: true, reasoning: false, session: true, terminal: true,
  },
  mimo: {
    profileId: 'mimo-json-events-v1', protocol: 'mimo-json-events', framing: 'jsonl',
    source: 'stdout', answerMode: 'delta', tools: { start: false, update: false, result: false },
    plan: false, reasoning: false, session: true, terminal: true,
  },
  pi: {
    profileId: 'pi-json-events-v2', protocol: 'pi-json', framing: 'jsonl',
    source: 'stdout', answerMode: 'delta', tools: { start: true, update: true, result: true },
    plan: false, reasoning: true, session: true, terminal: true,
  },
  claude: {
    profileId: 'anthropic-stream-json-v1', protocol: 'anthropic-stream-json', framing: 'jsonl',
    source: 'stdout', answerMode: 'delta', tools: { start: true, update: true, result: true },
    plan: true, reasoning: true, session: true, terminal: true,
  },
  gemini: {
    profileId: 'gemini-stream-json-v1', protocol: 'gemini-stream-json', framing: 'jsonl',
    source: 'stdout', answerMode: 'delta', tools: { start: true, update: false, result: true },
    plan: false, reasoning: false, session: true, terminal: true,
  },
  opencode: {
    profileId: 'opencode-json-events-v1', protocol: 'opencode-json-events', framing: 'jsonl',
    source: 'stdout', answerMode: 'delta', tools: { start: false, update: false, result: false },
    plan: false, reasoning: false, session: true, terminal: true,
  },
  qwen: {
    profileId: 'anthropic-stream-json-v1', protocol: 'anthropic-stream-json', framing: 'jsonl',
    source: 'stdout', answerMode: 'delta', tools: { start: true, update: true, result: true },
    plan: true, reasoning: true, session: true, terminal: true,
  },
  opencodereview: {
    profileId: 'opencodereview-terminal-document-v1', protocol: 'opencodereview-terminal-document',
    framing: 'document', source: 'stdout', answerMode: 'final',
    tools: { start: false, update: false, result: false },
    plan: false, reasoning: false, session: false, terminal: true,
  },
}

test('ConnectorEventProfile registry declares the trusted protocol capabilities for every CLI Agent', () => {
  assert.deepEqual(Object.keys(CONNECTOR_EVENT_PROFILES).sort(), Object.keys(PROFILE_EXPECTATIONS).sort())

  for (const [kind, expected] of Object.entries(PROFILE_EXPECTATIONS)) {
    const profile = resolveConnectorEventProfile(kind)
    assert.ok(profile, kind)
    assert.equal(profile.profileId, expected.profileId, kind)
    assert.equal(profile.protocol, expected.protocol, kind)
    assert.equal(profile.framing, expected.framing, kind)
    assert.equal(profile.source, expected.source, kind)
    assert.deepEqual(profile.capabilities, {
      answerMode: expected.answerMode,
      tools: expected.tools,
      plan: expected.plan,
      reasoning: expected.reasoning,
      session: expected.session,
      terminal: expected.terminal,
    }, kind)
    if (expected.framing === 'document') assert.equal(profile.createDecoder, null, kind)
    else assert.equal(typeof profile.createDecoder, 'function', kind)
    assert.equal(typeof profile.createState, 'function', kind)
    assert.equal(typeof profile.mapEvent, 'function', kind)
    assert.equal(typeof profile.mapProgress, 'function', kind)
    assert.equal(typeof profile.createRunContext, 'function', kind)
    assert.equal(typeof profile.resolveSessionRef, 'function', kind)
    assert.equal(typeof profile.finalizeResult, 'function', kind)
    assert.equal(typeof profile.createFinalOutputAccumulator, 'function', kind)
  }
})

test('every built-in invocation transport resolves its reusable profile and capability warning', () => {
  const cases = [
    { kind: 'zcode', profileId: 'zcode-prompt-json-v1', limited: true },
    { kind: 'codex', profileId: 'codex-app-server-jsonl-v1', limited: false },
    { kind: 'hermes', profileId: 'acp-jsonrpc-v1', limited: false },
    {
      kind: 'hermes', options: { hermesAcpAvailable: false },
      profileId: 'terminal-text-v1', limited: true,
    },
    { kind: 'openclaw', profileId: 'acp-jsonrpc-v1', limited: false },
    {
      kind: 'openclaw', options: { invocationTransport: 'legacy' },
      profileId: 'openclaw-terminal-document-v1', limited: true,
    },
    { kind: 'workbuddy', profileId: 'anthropic-stream-json-v1', limited: false },
    { kind: 'kimi', profileId: 'acp-jsonrpc-v1', limited: false },
    {
      kind: 'kimi', options: { sandbox: 'workspace-write' },
      profileId: 'assistant-jsonl-v1', limited: true,
    },
    { kind: 'mimo', profileId: 'acp-jsonrpc-v1', limited: false },
    {
      kind: 'mimo', options: { invocationTransport: 'json' },
      profileId: 'mimo-json-events-v1', limited: true,
    },
    { kind: 'pi', profileId: 'pi-json-events-v2', limited: false },
    { kind: 'claude', profileId: 'anthropic-stream-json-v1', limited: false },
    { kind: 'gemini', profileId: 'gemini-stream-json-v1', limited: false },
    { kind: 'opencode', profileId: 'acp-jsonrpc-v1', limited: false },
    {
      kind: 'opencode', options: { invocationTransport: 'json' },
      profileId: 'opencode-json-events-v1', limited: true,
    },
    { kind: 'qwen', profileId: 'anthropic-stream-json-v1', limited: false },
    {
      kind: 'opencodereview', profileId: 'opencodereview-terminal-document-v1', limited: true,
    },
  ]

  assert.deepEqual(new Set(cases.map(item => item.kind)), new Set(Object.keys(PROFILE_EXPECTATIONS)))
  for (const item of cases) {
    const spec = invocation(item.kind, `/tmp/${item.kind}`, '/tmp/work', '', item.options)
    const profile = resolveConnectorEventProfile(item.kind, { transport: spec.eventTransport })
    assert.equal(profile?.profileId, item.profileId, `${item.kind}:${spec.eventTransport || 'base'}`)
    assert.equal(Boolean(connectorLimitedRuntimeEvent(item.kind, profile)), item.limited,
      `${item.kind}:${spec.eventTransport || 'base'}`)
  }

  assert.equal(resolveConnectorEventProfile('codex', { transport: 'untrusted' }), null)
  assert.equal(resolveConnectorEventProfile('untrusted-agent'), null)
})

test('profiles own Codex progress and legacy terminal Session/final recovery hooks', async () => {
  const codex = resolveConnectorEventProfile('codex')
  assert.deepEqual(codex.mapProgress({ type: 'turn.started' }), {
    id: 'turn', title: 'process', status: 'in_progress',
  })

  const legacy = resolveConnectorEventProfile('hermes', { transport: 'legacy' })
  const lifecycle = []
  const runContext = legacy.createRunContext({
    hermesMessageWatermarkFn: () => 41,
  })
  const sessionRef = legacy.resolveSessionRef({
    stderr: 'diagnostic\nsession_id: hermes-session-final\n',
    sessionRef: 'previous-session',
    runContext,
  })
  const result = await legacy.finalizeResult({
    result: { text: 'quiet fallback', sessionRef, outcome: 'completed' },
    sessionRef,
    runContext,
    options: {
      onSessionRef: async value => lifecycle.push(`session:${value}`),
      hermesFinalResponseFn: (value, lookupOptions) => {
        lifecycle.push(`lookup:${value}:${lookupOptions.afterMessageId}`)
        return 'authoritative final'
      },
    },
  })

  assert.equal(legacy.mapProgress({ type: 'terminal_line', text: '┊ review diff' }), null)
  assert.equal(sessionRef, 'hermes-session-final')
  assert.deepEqual(result, {
    text: 'authoritative final', sessionRef: 'hermes-session-final', outcome: 'completed',
  })
  assert.deepEqual(lifecycle, [
    'session:hermes-session-final',
    'lookup:hermes-session-final:41',
  ])
})

test('legacy profile bounds an authoritative DB final to one MiB', async () => {
  const legacy = resolveConnectorEventProfile('hermes', { transport: 'legacy' })
  const sessionRef = 'hermes-session-bounded-final'
  const lifecycle = []
  const result = await legacy.finalizeResult({
    result: { text: 'quiet fallback', sessionRef, outcome: 'completed' },
    sessionRef,
    runContext: { messageWatermark: 73 },
    options: {
      onSessionRef: async value => lifecycle.push(`session:${value}`),
      hermesFinalResponseFn: (value, lookupOptions) => {
        lifecycle.push(`lookup:${value}:${lookupOptions.afterMessageId}`)
        return `${'x'.repeat(1024 * 1024)}y`
      },
    },
  })

  assert.equal(result.text.length, 1024 * 1024)
  assert.equal(result.text.at(-1), 'x')
  assert.deepEqual(lifecycle, [
    'session:hermes-session-bounded-final',
    'lookup:hermes-session-bounded-final:73',
  ])
})

test('ConnectorEventProfile decoders emit JSON values across arbitrary byte boundaries', () => {
  const profile = resolveConnectorEventProfile('gemini')
  const values = []
  const decoder = profile.createDecoder(value => values.push(value))
  const first = Buffer.from('{"type":"message","content":"你好"}\n', 'utf8')
  const second = Buffer.from('{"type":"result","status":"success"}\n', 'utf8')

  for (const byte of first) decoder.write(Buffer.from([byte]))
  assert.deepEqual(values, [{ type: 'message', content: '你好' }])
  for (const byte of second) decoder.write(Buffer.from([byte]))
  decoder.end()
  assert.deepEqual(values, [
    { type: 'message', content: '你好' },
    { type: 'result', status: 'success' },
  ])
})

test('ConnectorEventProfile final accumulators use distinct document schemas and immutable registry entries', () => {
  const openClaw = resolveConnectorEventProfile('openclaw', { transport: 'legacy' })
  const review = resolveConnectorEventProfile('opencodereview')
  assert.notEqual(openClaw.profileId, review.profileId)
  assert.notEqual(openClaw.createFinalOutputAccumulator, review.createFinalOutputAccumulator)
  assert.equal(openClaw.createFinalOutputAccumulator().format, 'document')
  assert.equal(review.createFinalOutputAccumulator().format, 'document')
  assert.equal(Object.isFrozen(CONNECTOR_EVENT_PROFILES), true)
  assert.equal(Object.isFrozen(openClaw), true)
  assert.equal(Object.isFrozen(openClaw.capabilities), true)
})

test('ConnectorEventProfile accumulators retain ACP message records and bounded Hermes terminal text', () => {
  const acp = resolveConnectorEventProfile('kimi').createFinalOutputAccumulator('kimi-session')
  assert.equal(acp.format, 'protocol-record')
  acp.ingest({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'first ' } })
  acp.ingest({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'second' } })
  assert.deepEqual(acp.end({ sessionRef: 'acp-session', stopReason: 'end_turn' }), {
    text: 'first second', sessionRef: 'acp-session', outcome: 'completed',
  })

  const hermes = resolveConnectorEventProfile('hermes', { transport: 'legacy' })
    .createFinalOutputAccumulator('hermes-session')
  assert.equal(hermes.format, 'text')
  hermes.write(Buffer.from('\u001b[31mfinal reply\u001b[0m', 'utf8'))
  const result = hermes.end()
  assert.deepEqual(result, {
    text: 'final reply', sessionRef: 'hermes-session', outcome: 'completed',
  })

  const workbuddy = resolveConnectorEventProfile('workbuddy', { transport: 'stream-json' })
    .createFinalOutputAccumulator('workbuddy-session')
  workbuddy.capture(Buffer.from(JSON.stringify([
    { type: 'result', result: 'compatible final', session_id: 'workbuddy-session' },
  ]), 'utf8'))
  assert.deepEqual(workbuddy.end(), {
    text: 'compatible final', sessionRef: 'workbuddy-session', outcome: 'completed',
  })

  const bounded = resolveConnectorEventProfile('hermes', { transport: 'legacy' })
    .createFinalOutputAccumulator()
  bounded.write(Buffer.from('x'.repeat(1024 * 1024 + 1), 'utf8'))
  assert.equal(bounded.end({ outcome: 'completed' }).text.length, 1024 * 1024)
})

test('ConnectorEventProfile document profiles defer parsing to their final accumulator', () => {
  const profile = resolveConnectorEventProfile('openclaw', { transport: 'legacy' })
  assert.equal(profile.createDecoder, null)
  const accumulator = profile.createFinalOutputAccumulator()

  for (const byte of Buffer.from('{"result":{"text":"final"}}', 'utf8')) {
    accumulator.write(Buffer.from([byte]))
  }
  assert.deepEqual(accumulator.end(), {
    text: 'final', sessionRef: '', outcome: 'partial',
  })
})

test('ConnectorEventProfile routes each reusable mapper through its state factory', () => {
  const codex = resolveConnectorEventProfile('codex')
  assert.deepEqual(codex.mapEvent({
    type: 'item.completed', item: { type: 'agent_message', text: 'Codex reply' },
  }, codex.createState()), [{ type: 'answer_delta', status: 'running', delta: 'Codex reply' }])

  const claude = resolveConnectorEventProfile('claude')
  assert.deepEqual(claude.mapEvent({
    type: 'stream_event', event: {
      type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Claude reply' },
    },
  }, claude.createState()), [{ type: 'answer_delta', status: 'running', delta: 'Claude reply' }])

  const acp = resolveConnectorEventProfile('kimi')
  assert.deepEqual(acp.mapEvent({
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ACP reply' },
  }, acp.createState()), [{ type: 'answer_delta', status: 'running', delta: 'ACP reply' }])

  const gemini = resolveConnectorEventProfile('gemini')
  const fixtureEvents = fs.readFileSync(GEMINI_TOOL_FIXTURE, 'utf8').trim().split('\n')
    .map(line => JSON.parse(line))
    .flatMap(event => gemini.mapEvent(event, gemini.createState()))
  assert.deepEqual(fixtureEvents.map(event => [event.type, event.id, event.status]), [
    ['tool_start', 'gemini-tool-search-1', 'running'],
    ['tool_result_summary', 'gemini-tool-search-1', 'completed'],
  ])
  assert.deepEqual(gemini.mapEvent({
    type: 'tool_use', tool_name: 'missing-id', parameters: {},
  }, gemini.createState()), [])
})

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { createRuntimeEventEmitter } = require('../../../src/agents/cli/cli-runtime-event-sanitizer.cjs')
const {
  connectorLimitedRuntimeEvent,
  resolveConnectorEventProfile,
} = require('../../../src/agents/cli/cli-event-profiles.cjs')

const FIXTURE_DIRECTORY = path.join(__dirname, '..', '..', 'fixtures', 'agent-output')
const MANIFEST = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIRECTORY, 'manifest.json'), 'utf8'))

const STREAMING_FIXTURES = [
  {
    kind: 'gemini',
    agent: 'Gemini',
    version: '0.55.1',
    protocol: 'gemini-stream-json',
    evidence: 'source-derived',
    file: 'gemini.jsonl',
    expectedTypes: ['answer_delta', 'tool_start', 'tool_result_summary'],
  },
  {
    kind: 'workbuddy',
    transport: 'stream-json',
    agent: 'WorkBuddy',
    version: '2.115.0',
    protocol: 'anthropic-stream-json',
    evidence: 'source-derived',
    file: 'workbuddy-stream-json.jsonl',
    expectedTypes: ['answer_delta', 'tool_start', 'tool_update', 'tool_result_summary'],
  },
  {
    kind: 'kimi',
    transport: 'stream-json',
    agent: 'Kimi',
    version: '0.19.2',
    protocol: 'assistant-jsonl',
    evidence: 'captured-fixture',
    file: 'kimi.jsonl',
    expectedTypes: ['answer_delta'],
  },
  {
    kind: 'mimo',
    agent: 'MiMo',
    version: '0.1.0',
    protocol: 'mimo-json-events',
    evidence: 'captured-fixture',
    file: 'mimo.jsonl',
    expectedTypes: ['answer_delta'],
  },
  {
    kind: 'pi',
    agent: 'Pi Agent',
    version: '0.84.2',
    protocol: 'pi-json',
    evidence: 'captured-fixture',
    file: 'pi.jsonl',
    expectedTypes: ['reasoning_summary', 'reasoning_summary', 'reasoning_summary', 'answer_delta'],
  },
  {
    kind: 'opencode',
    agent: 'OpenCode',
    version: '1.18.18',
    protocol: 'opencode-json-events',
    evidence: 'captured-fixture',
    file: 'opencode.jsonl',
    expectedTypes: ['answer_delta'],
  },
  {
    kind: 'dsh',
    agent: 'DeepSeek Harness',
    version: '0.2.2-rc.1',
    protocol: 'dsh-json-events',
    evidence: 'captured-fixture',
    file: 'dsh.jsonl',
    expectedTypes: ['tool_start', 'tool_result_summary', 'answer_delta'],
  },
]

function fixtureRecords(file) {
  return fs.readFileSync(path.join(FIXTURE_DIRECTORY, file), 'utf8').trim().split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

function fixtureMetadata(fixture) {
  const entry = MANIFEST.fixtures.find(candidate => candidate.kind === fixture.kind
    && (candidate.file === fixture.file || candidate.variants?.some(variant => variant.file === fixture.file)))
  if (!entry) return null
  if (entry.file === fixture.file) return entry
  return { kind: entry.kind, ...entry.variants.find(variant => variant.file === fixture.file) }
}

function streamingEvents(profile, records) {
  const events = []
  const state = profile.createState()
  const decoder = profile.createDecoder(record => {
    events.push(...profile.mapEvent(record, state))
  })
  for (const record of records) {
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8')
    for (const byte of bytes) decoder.write(Buffer.from([byte]))
  }
  return { decoder, events }
}

test('recorded protocol fixtures retain evidence provenance outside runtime records', () => {
  for (const fixture of STREAMING_FIXTURES) {
    const metadata = fixtureMetadata(fixture)
    assert.deepEqual(metadata, {
      kind: fixture.kind,
      ...(fixture.transport ? { transport: fixture.transport } : {}),
      agent: fixture.agent,
      version: fixture.version,
      protocol: fixture.protocol,
      evidence: fixture.evidence,
      file: fixture.file,
    }, fixture.file)
    assert.equal(fixtureRecords(fixture.file).every(record => !('fixture' in record)), true, fixture.file)
  }
})

test('protocol-family mappers emit verified stream records before close across arbitrary UTF-8 chunks', () => {
  const gemini = resolveConnectorEventProfile('gemini')
  const utf8 = streamingEvents(gemini, [{
    type: 'message', role: 'assistant', content: 'UTF-8 你好', delta: true,
  }])
  assert.deepEqual(utf8.events, [{ type: 'answer_delta', status: 'running', delta: 'UTF-8 你好' }])
  utf8.decoder.end()

  for (const fixture of STREAMING_FIXTURES) {
    const profile = resolveConnectorEventProfile(fixture.kind, { transport: fixture.transport })
    const records = fixtureRecords(fixture.file)
    const { decoder, events } = streamingEvents(profile, records)

    assert.deepEqual(events.map(event => event.type), fixture.expectedTypes, fixture.kind)
    assert.equal(events.some(event => event.type === 'answer_delta' || event.type === 'tool_start'), true,
      `${fixture.kind} emitted before close`)
    decoder.end()
    assert.deepEqual(events.map(event => event.type), fixture.expectedTypes, `${fixture.kind} did not defer output`)
  }
})

test('verified tool lifecycles reuse their wire IDs, ignore terminal answer duplicates, and sanitize summaries', () => {
  const fixtures = STREAMING_FIXTURES.filter(fixture => ['gemini', 'workbuddy'].includes(fixture.kind))
  for (const fixture of fixtures) {
    const profile = resolveConnectorEventProfile(fixture.kind, { transport: fixture.transport })
    const records = fixtureRecords(fixture.file)
    const { decoder, events } = streamingEvents(profile, records)
    decoder.end()

    const toolEvents = events.filter(event => event.type.startsWith('tool_'))
    assert.ok(toolEvents.length >= 2, fixture.kind)
    assert.equal(new Set(toolEvents.map(event => event.id)).size, 1, fixture.kind)
    assert.equal(new Set(toolEvents.map(event => event.title)).size, 1, fixture.kind)
    assert.equal(profile.mapEvent(records.at(-1), profile.createState()).some(event => event.type === 'answer_delta'), false,
      `${fixture.kind} terminal record must not duplicate the streamed answer`)

    const emitted = []
    const runtimeEvents = createRuntimeEventEmitter(
      { onEvent: event => emitted.push(event) },
      { CONNECTOR_TEST_API_KEY: 'fixture-private-token' },
    )
    for (const event of toolEvents) runtimeEvents.emit(event)
    assert.doesNotMatch(JSON.stringify(emitted), /fixture-private-token|\/Users\/private/i, fixture.kind)
  }
})

test('runtime finalization closes provider-omitted tool results once as unverified partials', () => {
  const emitted = []
  const runtimeEvents = createRuntimeEventEmitter({ onEvent: event => emitted.push(event) }, {})

  runtimeEvents.emit({
    type: 'tool_start',
    id: 'tool-open',
    status: 'running',
    title: 'read',
  })
  assert.equal(runtimeEvents.finalize({ text: 'done', status: 'completed' }), true)
  assert.equal(runtimeEvents.finalize({ text: 'done', status: 'completed' }), false)

  const toolEvents = emitted.filter(event => event.id === 'tool-open')
  assert.deepEqual(toolEvents.map(event => event.type), [
    'tool_start',
    'tool_result_summary',
  ])
  assert.deepEqual(toolEvents.at(-1), {
    type: 'tool_result_summary',
    id: 'tool-open',
    status: 'partial',
    title: 'read',
  })
})

test('runtime finalization preserves non-success terminal tool statuses', () => {
  for (const status of ['partial', 'failed', 'stopped', 'timeout']) {
    const emitted = []
    const runtimeEvents = createRuntimeEventEmitter({ onEvent: event => emitted.push(event) }, {})

    runtimeEvents.emit({ type: 'tool_start', id: `tool-${status}`, status: 'running', title: 'read' })
    runtimeEvents.finalize({ status })

    assert.deepEqual(emitted.filter(event => event.id === `tool-${status}`), [
      { type: 'tool_start', id: `tool-${status}`, status: 'running', title: 'read' },
      {
        type: 'tool_result_summary',
        id: `tool-${status}`,
        status,
        title: 'read',
      },
    ])
  }
})

test('runtime finalization marks every partial terminal answer reconciliation path as partial', () => {
  const cases = [
    { streamed: '', final: 'partial answer', replace: false },
    { streamed: 'partial ', final: 'partial answer', replace: false },
    { streamed: 'draft ', final: 'partial answer', replace: true },
  ]

  for (const fixture of cases) {
    const emitted = []
    const runtimeEvents = createRuntimeEventEmitter({ onEvent: event => emitted.push(event) }, {})
    if (fixture.streamed) {
      runtimeEvents.emit({ type: 'answer_delta', status: 'running', delta: fixture.streamed })
    }
    runtimeEvents.emitFinalAnswer(fixture.final, 'partial')

    const terminal = emitted.filter(event => event.type === 'answer_delta').at(-1)
    assert.equal(terminal.status, 'partial', JSON.stringify(fixture))
    assert.equal(terminal.replace === true, fixture.replace, JSON.stringify(fixture))
  }
})

test('runtime finalization replays an exact streamed answer with its terminal outcome', () => {
  for (const outcome of ['completed', 'partial']) {
    const emitted = []
    const runtimeEvents = createRuntimeEventEmitter({ onEvent: event => emitted.push(event) }, {})

    runtimeEvents.emit({ type: 'answer_delta', status: 'running', delta: 'partial answer.' })
    runtimeEvents.emitFinalAnswer('partial answer.', outcome)

    assert.deepEqual(emitted.filter(event => event.type === 'answer_delta'), [
      { type: 'answer_delta', status: 'running', delta: 'partial answer.' },
      { type: 'answer_delta', status: outcome, replace: true, delta: 'partial answer.' },
    ], outcome)
  }
})

test('runtime finalization emits one terminal answer when its pending flush completes an exact answer', () => {
  const emitted = []
  const runtimeEvents = createRuntimeEventEmitter({ onEvent: event => emitted.push(event) }, {})

  runtimeEvents.emit({ type: 'answer_delta', status: 'running', delta: 'safe answer' })
  runtimeEvents.emitFinalAnswer('safe answer')

  const answerEvents = emitted.filter(event => event.type === 'answer_delta')
  const answer = answerEvents.reduce(
    (value, event) => event.replace === true ? event.delta : value + event.delta,
    '',
  )
  assert.equal(answer, 'safe answer')
  assert.equal(answerEvents.filter(event => event.status === 'completed').length, 1)
})

test('runtime finalization marks a withheld partial answer flush as partial', () => {
  const emitted = []
  const runtimeEvents = createRuntimeEventEmitter({ onEvent: event => emitted.push(event) }, {})

  runtimeEvents.emit({ type: 'answer_delta', status: 'running', delta: 'secret' })
  runtimeEvents.emitFinalAnswer('', 'partial')

  assert.deepEqual(emitted.filter(event => event.type === 'answer_delta'), [
    { type: 'answer_delta', status: 'partial', delta: 'secret' },
  ])
})

test('runtime finalization does not duplicate an explicit tool result', () => {
  const emitted = []
  const runtimeEvents = createRuntimeEventEmitter({ onEvent: event => emitted.push(event) }, {})

  runtimeEvents.emit({ type: 'tool_start', id: 'tool-complete', status: 'running', title: 'read' })
  runtimeEvents.emit({
    type: 'tool_result_summary',
    id: 'tool-complete',
    status: 'completed',
    title: 'read',
  })
  runtimeEvents.emitFinalAnswer('done')

  assert.deepEqual(emitted.filter(event => event.id === 'tool-complete').map(event => event.type), [
    'tool_start',
    'tool_result_summary',
  ])
})

test('runtime answer delivery never reconstructs an environment credential split at any character boundary', () => {
  const secret = 'provider-secret-value'
  for (let split = 1; split < secret.length; split += 1) {
    const emitted = []
    const runtimeEvents = createRuntimeEventEmitter(
      { onEvent: event => emitted.push(event) },
      { CONNECTOR_TEST_API_KEY: secret },
    )
    runtimeEvents.emit({ type: 'answer_delta', status: 'running', delta: `before ${secret.slice(0, split)}` })
    runtimeEvents.emit({ type: 'answer_delta', status: 'running', delta: `${secret.slice(split)} after` })
    runtimeEvents.emitFinalAnswer('')

    const delivered = emitted.filter(event => event.type === 'answer_delta')
      .map(event => event.delta).join('')
    assert.doesNotMatch(delivered, new RegExp(secret), `split ${split}`)
    assert.doesNotMatch(JSON.stringify(emitted), new RegExp(secret), `split ${split}`)
  }
})

test('runtime answer delivery fails closed when a withheld credential prefix is followed by a close-time final answer', () => {
  const secret = 'provider-secret-value'
  const emitted = []
  const runtimeEvents = createRuntimeEventEmitter(
    { onEvent: event => emitted.push(event) },
    { CONNECTOR_TEST_API_KEY: secret },
  )
  runtimeEvents.emit({ type: 'answer_delta', status: 'running', delta: 'provider-' })
  runtimeEvents.emitFinalAnswer(secret)

  const delivered = emitted.filter(event => event.type === 'answer_delta').map(event => event.delta).join('')
  assert.doesNotMatch(delivered, /provider-|provider-secret-value/)
  assert.match(delivered, /\[redacted\]/)
})

test('runtime answer delivery handles overlapping secret prefixes without retaining public fragments', () => {
  const secret = 'abcabcab'
  const emitted = []
  const runtimeEvents = createRuntimeEventEmitter(
    { onEvent: event => emitted.push(event) },
    { CONNECTOR_TEST_API_KEY: secret },
  )
  runtimeEvents.emit({ type: 'answer_delta', status: 'running', delta: 'abcabc' })
  runtimeEvents.emit({ type: 'answer_delta', status: 'running', delta: 'ab' })
  runtimeEvents.emitFinalAnswer('')

  assert.doesNotMatch(emitted.map(event => event.delta).join(''), new RegExp(secret))
})

test('runtime answer delivery never reconstructs generic sanitizer credential forms across arbitrary boundaries', () => {
  const cases = [
    { value: 'AKIA1234567890ABCDEF', payload: 'AKIA1234567890ABCDEF' },
    { value: 'Bearer abcdefghijklmnopqrstuvwxyz', payload: 'abcdefghijklmnopqrstuvwxyz' },
    { value: 'api_key=abcdefghijklmnop', payload: 'abcdefghijklmnop' },
    { value: 'MY_API_KEY=embedded-secret-value', payload: 'embedded-secret-value' },
    { value: 'MY_ACCESS_TOKEN=embedded-secret-value', payload: 'embedded-secret-value' },
    { value: 'MY_TOKEN=embedded-secret-value', payload: 'embedded-secret-value' },
    { value: 'https://user:password@example.com', payload: 'password' },
  ]
  for (const { value, payload } of cases) {
    for (let split = 1; split < value.length; split += 1) {
      const emitted = []
      const runtimeEvents = createRuntimeEventEmitter({ onEvent: event => emitted.push(event) }, {})
      runtimeEvents.emit({ type: 'answer_delta', status: 'running', delta: value.slice(0, split) })
      runtimeEvents.emit({ type: 'answer_delta', status: 'running', delta: value.slice(split) })
      runtimeEvents.emitFinalAnswer('')
      const delivered = emitted.filter(event => event.type === 'answer_delta').map(event => event.delta).join('')
      assert.doesNotMatch(delivered, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${value} at ${split}`)
      assert.doesNotMatch(delivered, new RegExp(payload.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${payload} at ${split}`)
    }
  }
})

test('runtime answer delivery retains a prefixed assignment through its terminator', () => {
  const emitted = []
  const runtimeEvents = createRuntimeEventEmitter({ onEvent: event => emitted.push(event) }, {})
  runtimeEvents.emit({ type: 'answer_delta', status: 'running', delta: 'MY_API_KEY=emb' })
  runtimeEvents.emit({ type: 'answer_delta', status: 'running', delta: 'edded-secret-value done' })
  runtimeEvents.emitFinalAnswer('')
  const delivered = emitted.map(event => event.delta).join('')
  assert.doesNotMatch(delivered, /embedded-secret-value|edded-secret-value/)
  assert.match(delivered, /done/)
})

test('runtime answer delivery keeps a trailing local path atomic across assignment-prefix retention', () => {
  const emitted = []
  const runtimeEvents = createRuntimeEventEmitter({ onEvent: event => emitted.push(event) }, {})
  runtimeEvents.emit({ type: 'answer_delta', status: 'running', delta: 'saved /tmp/runtime-output-c' })
  runtimeEvents.emitFinalAnswer('')

  assert.equal(emitted.map(event => event.delta).join(''), 'saved [path]')
})

test('runtime answer delivery redacts every leading slash-run absolute path without corrupting HTTPS', () => {
  const paths = [
    '//Users/private/workspace',
    '///Users/private/workspace',
    '//server/share/private',
  ]
  const privateFragments = /Users|server|share|private|workspace/
  const deliveredText = events => events.reduce(
    (answer, event) => event.replace === true ? event.delta : answer + event.delta,
    '',
  )

  for (const value of paths) {
    const singleChunkEvents = []
    const singleChunkRuntimeEvents = createRuntimeEventEmitter(
      { onEvent: event => singleChunkEvents.push(event) },
      {},
    )
    singleChunkRuntimeEvents.emit({ type: 'answer_delta', status: 'running', delta: `saved ${value}` })
    singleChunkRuntimeEvents.emitFinalAnswer('')
    assert.equal(deliveredText(singleChunkEvents), 'saved [path]', `single chunk ${value}`)
    assert.doesNotMatch(deliveredText(singleChunkEvents), privateFragments, `single chunk ${value}`)

    for (let split = 1; split < value.length; split += 1) {
      const emitted = []
      const runtimeEvents = createRuntimeEventEmitter({ onEvent: event => emitted.push(event) }, {})
      runtimeEvents.emit({ type: 'answer_delta', status: 'running', delta: `saved ${value.slice(0, split)}` })
      runtimeEvents.emit({ type: 'answer_delta', status: 'running', delta: value.slice(split) })
      runtimeEvents.emitFinalAnswer('')
      assert.equal(deliveredText(emitted), 'saved [path]', `split ${value} at ${split}`)
      assert.doesNotMatch(deliveredText(emitted), privateFragments, `split ${value} at ${split}`)

      const replacementEvents = []
      const replacementRuntimeEvents = createRuntimeEventEmitter(
        { onEvent: event => replacementEvents.push(event) },
        {},
      )
      replacementRuntimeEvents.emit({
        type: 'answer_delta', status: 'running', delta: `draft ${value.slice(0, split)}`,
      })
      replacementRuntimeEvents.emitFinalAnswer(`saved ${value}`)
      assert.equal(deliveredText(replacementEvents), 'saved [path]', `replacement ${value} at ${split}`)
      assert.doesNotMatch(deliveredText(replacementEvents), privateFragments, `replacement ${value} at ${split}`)
    }
  }
})

test('runtime answer delivery preserves HTTPS URLs across every chunk boundary and final replacement', () => {
  const url = 'https://example.com/docs'
  for (let split = 1; split < url.length; split += 1) {
    const emitted = []
    const runtimeEvents = createRuntimeEventEmitter({ onEvent: event => emitted.push(event) }, {})
    const answer = `Read ${url} now`
    const boundary = 'Read '.length + split
    runtimeEvents.emit({ type: 'answer_delta', status: 'running', delta: answer.slice(0, boundary) })
    runtimeEvents.emit({ type: 'answer_delta', status: 'running', delta: answer.slice(boundary) })
    runtimeEvents.emitFinalAnswer('')
    assert.equal(emitted.map(event => event.delta).join(''), answer, `chunk ${split}`)

    const replacementEvents = []
    const replacementRuntimeEvents = createRuntimeEventEmitter(
      { onEvent: event => replacementEvents.push(event) },
      {},
    )
    replacementRuntimeEvents.emit({
      type: 'answer_delta', status: 'running', delta: `Draft ${url.slice(0, split)}`,
    })
    replacementRuntimeEvents.emitFinalAnswer(`Final ${url}`)
    const replaced = replacementEvents.reduce(
      (answerText, event) => event.replace === true ? event.delta : answerText + event.delta,
      '',
    )
    assert.equal(replaced, `Final ${url}`, `replacement ${split}`)
  }
})

test('runtime answer delivery fails closed for an unfinished private-key marker', () => {
  const marker = '-----BEGIN PRIVATE KEY-----\nprivate material'
  const emitted = []
  const runtimeEvents = createRuntimeEventEmitter({ onEvent: event => emitted.push(event) }, {})
  runtimeEvents.emit({ type: 'answer_delta', status: 'running', delta: marker.slice(0, 12) })
  runtimeEvents.emit({ type: 'answer_delta', status: 'running', delta: marker.slice(12) })
  runtimeEvents.emitFinalAnswer('')
  assert.doesNotMatch(emitted.map(event => event.delta).join(''), /private material/)
})

test('runtime answer delivery fails closed for a split RSA private-key header', () => {
  const marker = '-----BEGIN RSA PRIVATE KEY-----\nprivate material'
  const split = marker.indexOf('PRIVATE') + 3
  const emitted = []
  const runtimeEvents = createRuntimeEventEmitter({ onEvent: event => emitted.push(event) }, {})
  runtimeEvents.emit({ type: 'answer_delta', status: 'running', delta: marker.slice(0, split) })
  runtimeEvents.emit({ type: 'answer_delta', status: 'running', delta: marker.slice(split) })
  runtimeEvents.emitFinalAnswer('')
  assert.doesNotMatch(emitted.map(event => event.delta).join(''), /private material/)
})

test('runtime answer delivery preserves conclusively safe pending text at terminal flush', () => {
  for (const value of ['secret', 'https://example.com']) {
    const emitted = []
    const runtimeEvents = createRuntimeEventEmitter({ onEvent: event => emitted.push(event) }, {})
    runtimeEvents.emit({ type: 'answer_delta', status: 'running', delta: value })
    runtimeEvents.emitFinalAnswer('')
    assert.equal(emitted.map(event => event.delta).join(''), value, value)
  }
})

test('terminal answers preserve safe text ending in a one-character secret prefix', () => {
  const emitted = []
  const runtimeEvents = createRuntimeEventEmitter(
    { onEvent: event => emitted.push(event) },
    { OPENCLAW_GATEWAY_TOKEN: 'y0123456789abcdefghijklmnopqrstuvwxyz' },
  )

  runtimeEvents.emitFinalAnswer('OpenClaw fixture reply')

  assert.equal(
    emitted.filter(event => event.type === 'answer_delta').map(event => event.delta).join(''),
    'OpenClaw fixture reply',
  )
})

test('terminal reconciliation never reconstructs an exact 8-byte child secret', () => {
  for (const secret of ['abcdefgh', '\u5bc6\u5bc6ab']) {
    assert.equal(Buffer.byteLength(secret, 'utf8'), 8)
    for (let split = 1; split < secret.length; split += 1) {
      const emitted = []
      const runtimeEvents = createRuntimeEventEmitter(
        { onEvent: event => emitted.push(event) },
        { OPENCLAW_GATEWAY_TOKEN: secret },
      )

      runtimeEvents.emit({
        type: 'answer_delta', status: 'running', delta: secret.slice(0, split),
      })
      runtimeEvents.emitFinalAnswer(secret.slice(split))

      const raw = JSON.stringify(emitted)
      const joined = emitted.filter(event => event.type === 'answer_delta')
        .map(event => event.delta).join('')
      assert.doesNotMatch(raw, new RegExp(secret), `${secret} raw split ${split}`)
      assert.doesNotMatch(joined, new RegExp(secret), `${secret} joined split ${split}`)
    }
  }
})

test('AWS access keys are redacted across every streaming boundary', () => {
  const secret = 'AKIATESTACCESSKEY1234'
  for (let split = 1; split < secret.length; split += 1) {
    const emitted = []
    const runtimeEvents = createRuntimeEventEmitter(
      { onEvent: event => emitted.push(event) }, { AWS_ACCESS_KEY_ID: secret },
    )
    runtimeEvents.emit({ type: 'answer_delta', status: 'running', delta: secret.slice(0, split) })
    runtimeEvents.emit({ type: 'answer_delta', status: 'running', delta: secret.slice(split) })
    runtimeEvents.emitFinalAnswer(secret)
    assert.equal(JSON.stringify(emitted).includes(secret), false)
    assert.equal(emitted.filter(event => event.type === 'answer_delta')
      .map(event => event.delta).join('').includes(secret), false)
  }
})

test('runtime answer delivery reconciles empty and incomplete deltas with the terminal answer', () => {
  for (const deltas of [[], [''], ['authoritative ']]) {
    const emitted = []
    const runtimeEvents = createRuntimeEventEmitter({ onEvent: event => emitted.push(event) }, {})
    for (const delta of deltas) {
      runtimeEvents.emit({ type: 'answer_delta', status: 'running', delta })
    }
    runtimeEvents.emitFinalAnswer('authoritative final')

    assert.equal(
      emitted.filter(event => event.type === 'answer_delta').map(event => event.delta).join(''),
      'authoritative final',
      JSON.stringify(deltas),
    )
  }
})

test('runtime answer delivery replaces divergent streamed text with the authoritative terminal answer', () => {
  const emitted = []
  const runtimeEvents = createRuntimeEventEmitter({ onEvent: event => emitted.push(event) }, {})
  runtimeEvents.emit({ type: 'answer_delta', status: 'running', delta: 'partial' })
  runtimeEvents.emitFinalAnswer('authoritative final')

  const answerEvents = emitted.filter(event => event.type === 'answer_delta')
  let answer = ''
  for (const event of answerEvents) {
    answer = event.replace === true ? event.delta : answer + event.delta
  }

  assert.equal(answer, 'authoritative final')
  assert.deepEqual(answerEvents.at(-1), {
    type: 'answer_delta',
    status: 'completed',
    replace: true,
    delta: 'authoritative final',
  })
})

test('ACP tool summaries exclude arbitrary upstream titles', () => {
  const profile = resolveConnectorEventProfile('openclaw')
  const state = profile.createState()
  const events = profile.mapEvent({
    sessionUpdate: 'tool_call',
    toolCallId: 'tool-1',
    title: 'Search confidential acquisition target Project Atlas',
    kind: 'search',
    status: 'in_progress',
    rawInput: { query: 'Project Atlas confidential acquisition target' },
  }, state)

  assert.equal(events.length, 1)
  assert.equal(events[0].title, 'search')
  assert.equal(events[0].summary, 'search: query: text (45 chars)')
  assert.doesNotMatch(JSON.stringify(events), /confidential|acquisition|Project Atlas/i)
})

test('protocol profiles publish collision-resistant lifecycle IDs for opaque upstream tool IDs', () => {
  const profile = resolveConnectorEventProfile('gemini')
  const state = profile.createState()
  const prefix = 'x'.repeat(100)
  const opaqueIds = [`${prefix}-first`, `${prefix}-second`, 'tool / space']
  const emitted = []
  const runtimeEvents = createRuntimeEventEmitter({ onEvent: event => emitted.push(event) }, {})

  for (const id of opaqueIds) {
    for (const event of profile.mapEvent({
      type: 'tool_use', tool_id: id, tool_name: 'search', parameters: { query: 'Meldwork' },
    }, state)) runtimeEvents.emit(event)
    for (const event of profile.mapEvent({
      type: 'tool_result', tool_id: id, status: 'success', output: 'one result',
    }, state)) runtimeEvents.emit(event)
  }

  const lifecycleIds = emitted.filter(event => event.type.startsWith('tool_')).map(event => event.id)
  assert.equal(new Set(lifecycleIds).size, opaqueIds.length)
  assert.equal(lifecycleIds.every(id => /^[A-Za-z0-9._:-]{1,100}$/.test(id)), true)
  assert.equal(opaqueIds.every(id => !JSON.stringify(emitted).includes(id)), true)
  for (const id of new Set(lifecycleIds)) {
    assert.equal(lifecycleIds.filter(candidate => candidate === id).length, 2)
  }
})

test('Anthropic reasoning lifecycle keys include the message id and clean up after each stop', () => {
  const profile = resolveConnectorEventProfile('claude')
  const state = profile.createState()
  const records = [
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'message-one' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 }, uuid: 'stop-one' },
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'message-two' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 }, uuid: 'stop-two' },
  ]
  const events = records.flatMap(record => profile.mapEvent(record, state))

  assert.deepEqual(events.map(event => [event.type, event.id, event.status]), [
    ['reasoning_summary', 'reasoning:root:message-one:0', 'running'],
    ['reasoning_summary', 'reasoning:root:message-one:0', 'completed'],
    ['reasoning_summary', 'reasoning:root:message-two:0', 'running'],
    ['reasoning_summary', 'reasoning:root:message-two:0', 'completed'],
  ])
  assert.equal(state.blockIds.size, 0)
})

test('profile capabilities produce connector-limited warnings without Agent-kind branching', () => {
  const limited = [
    ['workbuddy'],
    ['openclaw', { transport: 'legacy' }],
    ['opencodereview'],
    ['kimi', { transport: 'stream-json' }],
    ['mimo'],
    ['opencode'],
  ]
  for (const [kind, options] of limited) {
    assert.deepEqual(
      connectorLimitedRuntimeEvent(kind, resolveConnectorEventProfile(kind, options)),
      { id: `${kind}-connector`, type: 'warning', status: 'waiting', title: 'connector_limited' },
      kind,
    )
  }

  const complete = [
    ['codex'], ['hermes'], ['openclaw'], ['pi', { transport: 'acp' }], ['kimi'], ['claude'], ['qwen'], ['gemini'],
    ['workbuddy', { transport: 'stream-json' }],
  ]
  for (const [kind, options] of complete) {
    assert.equal(connectorLimitedRuntimeEvent(kind, resolveConnectorEventProfile(kind, options)), null, kind)
  }
})

test('unverified tool-shaped records remain silent for text-only protocol families', () => {
  const fixtures = [
    { kind: 'kimi', transport: 'stream-json', event: { role: 'tool', tool_call_id: 'tool-1', content: 'ignored' } },
    { kind: 'mimo', event: { type: 'tool_use', part: { type: 'tool', tool: 'read' } } },
    { kind: 'opencode', event: { type: 'tool_use', part: { type: 'tool', tool: 'read' } } },
  ]
  for (const fixture of fixtures) {
    const profile = resolveConnectorEventProfile(fixture.kind, { transport: fixture.transport })
    assert.deepEqual(profile.mapEvent(fixture.event, profile.createState()), [], fixture.kind)
  }
})

test('final-only protocol families declare no runtime decoder and expose no unsupported runtime events', () => {
  const fixtures = [
    { kind: 'openclaw', transport: 'legacy', file: 'openclaw.json' },
    { kind: 'opencodereview', file: 'opencodereview.json' },
    { kind: 'workbuddy', file: 'workbuddy.jsonl' },
  ]
  for (const fixture of fixtures) {
    const profile = resolveConnectorEventProfile(fixture.kind, { transport: fixture.transport })
    const bytes = fs.readFileSync(path.join(FIXTURE_DIRECTORY, fixture.file))
    const accumulator = profile.createFinalOutputAccumulator()
    assert.equal(profile.createDecoder, null, fixture.kind)
    assert.equal(profile.framing, 'document', fixture.kind)
    accumulator.capture?.(bytes)
    accumulator.write?.(bytes)
    assert.deepEqual(profile.capabilities, {
      answerMode: 'final',
      tools: { start: false, update: false, result: false },
      plan: false,
      reasoning: false,
      session: fixture.kind === 'workbuddy',
      terminal: true,
    }, fixture.kind)
    assert.ok(accumulator.end().text, fixture.kind)
    assert.deepEqual(profile.mapEvent({}, profile.createState()), [], fixture.kind)
  }
})

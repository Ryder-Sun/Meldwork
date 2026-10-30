const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { executable, within } = require('../../support/cli-adapters-test-helpers.cjs')
const { runAgent } = require('../../../src/agents/cli/cli-adapters.cjs')
const { invocation } = require('../../../src/agents/cli/cli-invocations.cjs')
const { resolveConnectorEventProfile } = require('../../../src/agents/cli/cli-event-profiles.cjs')
const { createRuntimeEventEmitter } = require('../../../src/agents/cli/cli-runtime-events.cjs')
const { failedAgentProcessError } = require('../../../src/agents/cli/cli-process-support.cjs')

test('Zcode prompts explicitly select permissions and only resume the requested session', () => {
  for (const sandbox of ['read-only', 'workspace-write']) {
    const spec = invocation('zcode', '/bin/zcode', '/tmp/work', 'sess_saved', { sandbox })
    assert.deepEqual(spec.args, ['--json', '--no-color', '--verbose', '--cwd', '/tmp/work', '--mode',
      sandbox === 'workspace-write' ? 'edit' : 'plan', '--resume', 'sess_saved', '--prompt'])
    assert.equal(spec.promptArg, true)
  }
})

test('Zcode reports its explicit missing-provider credential without a write retry', () => {
  assert.equal(failedAgentProcessError('Error: Turn execution failed\nCause: AiSdkModelAdapterError: Model provider is missing an API key: zai',
    { kind: 'zcode' }).code, 'LOCAL_AGENT_AUTH_REQUIRED')
  assert.equal(failedAgentProcessError('Error: Turn execution failed', { kind: 'zcode' }).code, 'LOCAL_AGENT_PROCESS_FAILED')
})

test('Zcode JSON result survives byte splits without displaying JSON or diagnostics', () => {
  const profile = resolveConnectorEventProfile('zcode')
  const accumulator = profile.createFinalOutputAccumulator()
  const bytes = Buffer.from(JSON.stringify({ sessionId: 'sess_new', response: '中文结果', projection: { status: 'idle' } }))
  for (const byte of bytes) accumulator.capture(Buffer.from([byte]))
  assert.deepEqual(accumulator.end(), { sessionRef: 'sess_new', text: '中文结果', outcome: 'completed' })
  const malformed = profile.createFinalOutputAccumulator()
  malformed.capture(Buffer.from('Error: provider not configured'))
  assert.deepEqual(malformed.end(), { text: '', outcome: 'failed' })
})

test('Chinese slash-separated prose is preserved while standalone paths remain hidden', () => {
  const events = []
  const emitter = createRuntimeEventEmitter({ onEvent: event => events.push(event) }, {})
  const text = '融资 A 轮/A+ 轮，云/端，玩偶/教育。 文件 /Users/person/private.txt 结束。'
  for (const delta of text) emitter.emit({ type: 'answer_delta', status: 'running', delta })
  emitter.finalize({ status: 'completed' })
  const rendered = events.filter(e => e.type === 'answer_delta').map(e => e.delta).join('')
  assert.equal(rendered, '融资 A 轮/A+ 轮，云/端，玩偶/教育。 文件 [path] 结束。')
})

test('Hermes uses ACP mode changes across read-only, writer and confirmation turns', () => {
  for (const [sandbox, sessionRef, mode] of [
    ['read-only', '', 'default'],
    ['workspace-write', 'hermes-session', 'accept_edits'],
    ['read-only', 'hermes-session', 'default'],
  ]) {
    const spec = invocation('hermes', '/bin/hermes', '/tmp', sessionRef, {
      sandbox, hermesStreamJsonAvailable: true, hermesAcpAvailable: true,
      ...(sessionRef ? { sessionTransport: 'acp' } : {}),
    })
    assert.equal(spec.eventTransport, 'acp')
    assert.deepEqual(spec.args, ['acp'])
    assert.equal(spec.acpMode, mode)
  }
})

test('Hermes native streaming keeps deltas, tools, final text and session identity', async () => {
  const spec = invocation('hermes', '/bin/hermes', '/tmp', '', { hermesStreamJsonAvailable: true, hermesAcpAvailable: false })
  assert.equal(spec.eventTransport, 'stream-json')
  assert.deepEqual(spec.args, ['chat', '--format', 'stream-json', '--query'])
  const profile = resolveConnectorEventProfile('hermes', { transport: 'stream-json' })
  const accumulator = profile.createFinalOutputAccumulator()
  const state = profile.createState()
  const events = []
  for (const record of [
    { type: 'system', subtype: 'init', session_id: 'hermes-native-session' },
    { type: 'text', text: '中文' },
    { type: 'tool_use', name: 'web_search', tool_call_id: 'call_1' },
    { type: 'tool_result', name: 'web_search', tool_call_id: 'call_1', is_error: false },
    { type: 'text', text: '结果' },
    { type: 'result', exit_code: 0, text: '中文结果', session_id: 'hermes-native-session' },
  ]) {
    accumulator.ingest(record)
    events.push(...profile.mapEvent(record, state))
  }
  assert.equal(events.filter(e => e.type === 'answer_delta').map(e => e.delta).join(''), '中文结果')
  assert.deepEqual(events.filter(e => e.id === 'call_1').map(e => e.status), ['running', 'completed'])
  const result = accumulator.end()
  assert.deepEqual(result, { text: '中文结果', sessionRef: 'hermes-native-session', outcome: 'completed' })
  const sessions = []
  await profile.finalizeResult({ result, options: { onSessionRef: (...args) => sessions.push(args) } })
  assert.deepEqual(sessions, [['hermes-native-session', { transport: 'legacy' }]])
  const failed = profile.createFinalOutputAccumulator()
  failed.ingest({ type: 'result', text: '', exit_code: 1, error: 'Authentication required' })
  assert.equal(failed.end().outcome, 'failed')
})

test('native Hermes streaming and Zcode JSON execute through the process adapter', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-native-formats-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  for (const kind of ['zcode', 'hermes']) {
    const cli = executable(directory, `${kind}.cjs`, `
const args = process.argv.slice(2)
if (!args.includes(${JSON.stringify(kind === 'zcode' ? '--json' : '--format')})) process.exit(2)
const output = ${JSON.stringify(kind === 'zcode'
  ? [{ response: '中文结果', sessionId: 'native-session', projection: { status: 'idle' } }]
  : [{ type: 'text', text: '中文' }, { type: 'text', text: '结果' },
      { type: 'result', text: '中文结果', exit_code: 0, session_id: 'native-session' }])}
for (const record of output) process.stdout.write(JSON.stringify(record) + '\\n')
`)
    const events = []
    const result = await within(runAgent({ kind, executable: cli, streamJsonAvailable: true, acpAvailable: false },
      'hello', directory, { onEvent: e => events.push(e) }), 5000)
    assert.equal(result.text, '中文结果')
    assert.equal(result.outcome, 'completed')
    assert.equal(result.sessionRef, 'native-session')
    const rendered = events.filter(e => e.type === 'answer_delta')
      .reduce((text, e) => e.replace ? e.delta : text + e.delta, '')
    assert.equal(rendered, '中文结果')
  }
})

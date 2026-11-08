const test = require('node:test')
const assert = require('node:assert/strict')

const {
  classifyCliOutcome,
  parseDshOutput,
} = require('../../../src/agents/cli/cli-output-parsers.cjs')
const { invocation } = require('../../../src/agents/cli/cli-invocations.cjs')
const {
  createDshRuntimeState,
  dshRuntimeEvents,
} = require('../../../src/agents/cli/cli-runtime-event-mappers.cjs')
const { resolveConnectorEventProfile } = require('../../../src/agents/cli/cli-event-profiles.cjs')

function ingestDshEvents(events) {
  const profile = resolveConnectorEventProfile('dsh', { transport: 'json' })
  const accumulator = profile.createFinalOutputAccumulator('')
  for (const event of events) accumulator.ingest(event)
  return accumulator.end({})
}

const RUN = [
  { type: 'session', sessionId: 'session-abc', cwd: '/tmp/work' },
  { type: 'status', phase: 'turn_start', turn: 1 },
  { type: 'thinking', text: 'Private reasoning the renderer must not see.' },
  { type: 'tool_call', callId: 'call-1', tool: 'bash', input: { command: 'ls' } },
  { type: 'tool_result', callId: 'call-1', status: 'completed', result: 'a\nb' },
  { type: 'text', text: 'Done.' },
  { type: 'final', sessionId: 'session-abc', reason: { kind: 'completed' }, text: 'Done.' },
].map(event => JSON.stringify(event)).join('\n')

test('dsh invocation uses the headless profile, stdin prompt, and bounded permission modes', () => {
  const read = invocation('dsh', 'dsh', '/tmp/work', '', {})
  assert.deepEqual(read, {
    command: 'dsh',
    args: ['--profile', 'headless', '--json', '--permission-mode', 'read-only', '-'],
    stdin: true,
    eventTransport: 'json',
  })

  const write = invocation('dsh', 'dsh', '/tmp/work', 'session-abc', { sandbox: 'workspace-write' })
  assert.deepEqual(write.args, [
    '--profile', 'headless', '--json', '--permission-mode', 'workspace-write',
    '--session-id', 'session-abc', '-',
  ])
})

test('parseDshOutput takes the final answer and session id from terminal events', () => {
  assert.deepEqual(parseDshOutput(RUN), { text: 'Done.', sessionRef: 'session-abc' })
  assert.deepEqual(parseDshOutput(''), { text: '', sessionRef: '' })
  // No JSONL at all: fall back to the raw output so failures stay visible.
  assert.deepEqual(parseDshOutput('dsh: boom'), { text: 'dsh: boom', sessionRef: '' })
  // JSONL that never reached a final answer: no invented text.
  assert.deepEqual(parseDshOutput('{"type":"session","sessionId":"session-abc"}'), {
    text: '',
    sessionRef: 'session-abc',
  })
})

test('classifyCliOutcome maps dsh terminal reasons to run outcomes', () => {
  assert.equal(classifyCliOutcome('dsh', RUN).outcome, 'completed')
  assert.equal(classifyCliOutcome('dsh', `${RUN}\n{"type":"final","reason":{"kind":"aborted"},"text":""}`).outcome,
    'cancelled')
  assert.equal(classifyCliOutcome('dsh', '{"type":"error","message":"boom"}').outcome, 'failed')
  assert.equal(classifyCliOutcome('dsh', '{"type":"session","sessionId":"s"}').outcome, 'partial')
})

test('dsh runtime events expose tool lifecycle and answer deltas but never thinking text', () => {
  const state = createDshRuntimeState()
  const events = []
  for (const line of RUN.split('\n')) {
    events.push(...dshRuntimeEvents(JSON.parse(line), state))
  }
  assert.deepEqual(events, [
    { id: 'call-1', type: 'tool_start', title: 'bash', status: 'running', summary: 'bash: operation: command' },
    {
      id: 'call-1',
      type: 'tool_result_summary',
      title: 'bash',
      status: 'completed',
      summary: 'bash: operation: command',
      detail: 'Output: 2 lines, 3 bytes',
    },
    { type: 'answer_delta', status: 'running', delta: 'Done.' },
  ])
  assert.equal(events.some(event => JSON.stringify(event).includes('Private reasoning')), false)
  assert.deepEqual(dshRuntimeEvents(null, state), [])
  assert.deepEqual(dshRuntimeEvents({ type: 'status', phase: 'turn_start' }, state), [])
})

test('dsh ingest keeps failed tool calls non-terminal and records error events', () => {
  // A failed tool call is ordinary execution; the run still completes.
  const toolFailure = ingestDshEvents([
    { type: 'session', sessionId: 'session-abc' },
    { type: 'tool_call', callId: 'call-1', tool: 'bash', input: { command: 'false' } },
    { type: 'tool_result', callId: 'call-1', status: 'error', result: 'exit 1' },
    { type: 'text', text: 'Recovered.' },
    { type: 'final', sessionId: 'session-abc', reason: { kind: 'completed' }, text: 'Recovered.' },
  ])
  assert.equal(toolFailure.outcome, 'completed')
  assert.equal(toolFailure.text, 'Recovered.')
  assert.equal(toolFailure.sessionRef, 'session-abc')

  // A dedicated error event without a final answer fails the run and keeps
  // the CLI's message as the diagnostic.
  const errorOnly = ingestDshEvents([{ type: 'error', message: 'boom' }])
  assert.equal(errorOnly.outcome, 'failed')
  assert.equal(errorOnly.diagnostic, 'boom')
  assert.equal(errorOnly.failure?.code, 'LOCAL_AGENT_PROCESS_FAILED')

  // A terminal final answer stays authoritative after an error event.
  const errorThenFinal = ingestDshEvents([
    { type: 'error', message: 'transient' },
    { type: 'final', sessionId: 'session-abc', reason: { kind: 'completed' }, text: 'Done.' },
  ])
  assert.equal(errorThenFinal.outcome, 'completed')
  assert.equal(errorThenFinal.text, 'Done.')
  assert.equal(errorThenFinal.diagnostic, undefined)
  assert.equal(errorThenFinal.failure, undefined)
})

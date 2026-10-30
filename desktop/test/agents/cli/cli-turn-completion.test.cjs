const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createTurnCompletion } = require('../../../src/agents/cli/cli-turn-completion.cjs')
const adapters = require('../../../src/agents/cli/cli-adapters.cjs')
const { executable, within } = require('../../support/cli-adapters-test-helpers.cjs')

const markerOf = boundary => boundary.instruction.match(/\[\[MELDWORK_TURN_DONE:[^\]]+\]\]/)[0]

test('contribution boundary hides a split signal and ignores later acknowledgements', () => {
  const boundary = createTurnCompletion()
  const marker = markerOf(boundary)
  const chunks = ['Actual answer.\n', ...marker, '\nConfirmed again.']
  let visible = ''
  for (const chunk of chunks) visible += boundary.push(chunk).delta
  assert.equal(visible, 'Actual answer.\n')
  assert.equal(boundary.completed, true)
})

test('only an invocation-bound assistant signal outside a quotation with finished tools can end a contribution', () => {
  for (const value of ['Confirmed. '.repeat(30), markerOf(createTurnCompletion()),
    '\n```\nSIGNAL\n```', '\n> SIGNAL', '\n    SIGNAL', '\nQuoted SIGNAL']) {
    const boundary = createTurnCompletion()
    const text = 'Answer.\n' + value.replace('SIGNAL', markerOf(boundary))
    assert.equal(boundary.push(text).completed, false)
  }
  const boundary = createTurnCompletion()
  assert.equal(boundary.push(`Answer.\n${markerOf(boundary)}`, false).completed, false)
})

test('a quoted signal does not prevent a later explicit final signal', () => {
  const boundary = createTurnCompletion()
  const marker = markerOf(boundary)
  assert.equal(boundary.push(`Example:\n\`\`\`\n${marker}\n\`\`\`\n`).completed, false)
  assert.equal(boundary.push(`Actual contribution.\n${marker}`).completed, true)
})

for (const kind of ['opencode', 'mimo', 'hermes']) {
  test(`${kind} returns an explicit contribution normally even when native prompt never returns before cancel`, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-turn-boundary-'))
    t.after(async () => {
      await adapters.shutdownAcpSessionRuntime()
      fs.rmSync(directory, { recursive: true, force: true })
    })
    const cli = executable(directory, `${kind}-boundary.cjs`, `
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
let request
const sessionId = 'boundary-session'
const update = text => send({ jsonrpc: '2.0', method: 'session/update', params: {
  sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
} })
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  else if (message.method === 'session/new') send({ jsonrpc: '2.0', id: message.id, result: { sessionId } })
  else if (message.method === 'session/set_mode' || message.method === 'session/resume') send({ jsonrpc: '2.0', id: message.id, result: {} })
  else if (message.method === 'session/prompt') {
    request = message
    const marker = message.params.prompt[0].text.match(/\\[\\[MELDWORK_TURN_DONE:[^\\]]+\\]\\]/)[0]
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
      sessionUpdate: 'tool_call', toolCallId: 'tool-proof', status: 'completed',
      title: 'Read evidence', kind: 'read', rawOutput: marker,
    } } })
    update('My completed contribution.\\n')
    for (const char of marker) update(char)
    update('\\nRepeated closing acknowledgement.'.repeat(30))
  } else if (message.method === 'session/cancel') {
    update('Late cancelled output must be ignored.')
    send({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'cancelled' } })
  }
})
`)
    const events = []
    let outbound
    const result = await within(adapters.runAgent({ kind, executable: cli, acpAvailable: true },
      'Give one complete contribution.', directory, {
        turnCompletion: true,
        acpPersistenceKey: 'boundary-test',
        onEvent: event => events.push(event),
        onOutboundPayload: payload => { outbound = payload },
      }), 10000)
    assert.equal(result.outcome, 'completed')
    assert.equal(result.text, 'My completed contribution.')
    assert.match(outbound.prompt, /MELDWORK_TURN_DONE:/)
    assert.ok(events.some(event => event.type === 'answer_delta'))
    assert.ok(events.every(event => !/MELDWORK_TURN_DONE|Repeated closing|Late cancelled/.test(event.delta || '')))
    const next = await within(adapters.runAgent({ kind, executable: cli, acpAvailable: true },
      'Give the next contribution.', directory, {
        turnCompletion: true, acpPersistenceKey: 'boundary-test', sessionRef: result.sessionRef,
        sessionTransport: 'acp',
      }), 10000)
    assert.equal(next.outcome, 'completed')
    assert.equal(next.sessionRef, result.sessionRef)
    assert.equal(next.text, 'My completed contribution.')
  })
}

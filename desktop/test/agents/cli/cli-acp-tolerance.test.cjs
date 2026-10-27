const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const adapters = require('../../../src/agents/cli/cli-adapters.cjs')
const { executable, within } = require('../../support/cli-adapters-test-helpers.cjs')

function noisyHermes(directory) {
  return executable(directory, 'hermes-noisy-acp.cjs', `
const fs = require('node:fs')
const readline = require('node:readline')
if (process.argv[2] !== 'acp') {
  process.stdout.write('legacy fallback')
  process.exit(0)
}
const input = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
process.stdout.write('Hermes 9.9.9 starting up...\\n')
input.on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  const sessionId = message.params?.sessionId || 'noisy-session'
  if (message.id >= 9001 && message.id <= 9004 && !message.method) {
    fs.appendFileSync(process.env.MELDWORK_TEST_UNKNOWN_RESPONSE, JSON.stringify(message) + '\\n')
    return
  }
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId } })
  } else if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'another-session', update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'unrelated session output' },
    } } })
    process.stdout.write('WARNING: update available (not protocol traffic)\\n')
    send({ jsonrpc: '2.0', method: '_vendor/progress', params: { done: 1 } })
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'brand_new_update_kind', payload: 1 } } })
    send({ jsonrpc: '2.0', id: 9001, method: 'vendor/unknown_request', params: { sessionId } })
    // Methods the client never advertised: a conforming Agent does not call
    // them, a non-conforming one must get an error, never a made-up success.
    send({ jsonrpc: '2.0', id: 9002, method: 'fs/read_text_file', params: { sessionId, path: '/etc/hosts' } })
    send({ jsonrpc: '2.0', id: 9003, method: 'fs/write_text_file', params: { sessionId, path: '/tmp/x', content: 'x' } })
    send({ jsonrpc: '2.0', id: 9004, method: 'terminal/create', params: { sessionId, command: 'id' } })
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'acp answer despite the noise' },
    } } })
    setTimeout(() => send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } }), 50)
  }
})
`)
}

test('ACP turns survive banners, unknown notifications, new update kinds and unknown requests', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-acp-tolerance-'))
  t.after(async () => {
    await adapters.shutdownAcpSessionRuntime?.()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const unknownResponse = path.join(directory, 'unknown-responses.jsonl')
  const agent = { kind: 'hermes', executable: noisyHermes(directory), name: 'Hermes' }

  const result = await within(adapters.runAgent(agent, 'say something', directory, {
    acpPersistenceKey: 'workspace:hermes:tolerance',
    env: { MELDWORK_TEST_UNKNOWN_RESPONSE: unknownResponse },
  }), 10000)

  assert.equal(result.text, 'acp answer despite the noise')
  // Every request the client does not support is answered with an error, so
  // the Agent is never left waiting and never receives a made-up success.
  const deadline = Date.now() + 5000
  let responses = []
  while (Date.now() < deadline) {
    try {
      responses = fs.readFileSync(unknownResponse, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    } catch { /* not written yet */ }
    if (responses.length >= 4) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.deepEqual(responses.map(response => response.id).sort(), [9001, 9002, 9003, 9004])
  for (const response of responses) {
    assert.equal('result' in response, false, `request ${response.id} must not succeed`)
    assert.equal(typeof response.error?.code, 'number')
  }
  assert.equal(responses.find(response => response.id === 9001).error.code, -32601)
})

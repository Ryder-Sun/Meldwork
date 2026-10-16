const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const adapters = require('../../../src/agents/cli/cli-adapters.cjs')
const {
  executable,
  readJsonWhenReady,
  within,
} = require('../../support/cli-adapters-test-helpers.cjs')

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
  if (message.id === 9001 && !message.method) {
    fs.writeFileSync(process.env.MELDWORK_TEST_UNKNOWN_RESPONSE, JSON.stringify(message))
    return
  }
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId } })
  } else if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    process.stdout.write('WARNING: update available (not protocol traffic)\\n')
    send({ jsonrpc: '2.0', method: '_vendor/progress', params: { done: 1 } })
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'brand_new_update_kind', payload: 1 } } })
    send({ jsonrpc: '2.0', id: 9001, method: 'vendor/unknown_request', params: { sessionId } })
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
  const unknownResponse = path.join(directory, 'unknown-response.json')
  const agent = { kind: 'hermes', executable: noisyHermes(directory), name: 'Hermes' }

  const result = await within(adapters.runAgent(agent, 'say something', directory, {
    acpPersistenceKey: 'workspace:hermes:tolerance',
    env: { MELDWORK_TEST_UNKNOWN_RESPONSE: unknownResponse },
  }), 10000)

  assert.equal(result.text, 'acp answer despite the noise')
  // The Agent is told the method is unknown instead of being left waiting.
  const response = await readJsonWhenReady(unknownResponse)
  assert.equal(response.id, 9001)
  assert.equal(response.error?.code, -32601)
})

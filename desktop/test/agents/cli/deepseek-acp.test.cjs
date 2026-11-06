const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { runAgent, invocation, shutdownAcpSessionRuntime } = require('../../../src/agents/cli/cli-adapters.cjs')
const { childEnvironment } = require('../../../src/agents/cli/cli-process-support.cjs')
const { executable } = require('../../support/cli-adapters-test-helpers.cjs')

test('DeepSeek ACP keeps mode-bound sessions, resumes, and rejects escalations', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-dsh-'))
  const cli = executable(directory, 'dsh.cjs', `
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
let prompt
input.on('line', line => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  else if (message.method === 'session/new') send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'abc-123' } })
  else if (message.method === 'session/resume') {
    if (message.params.sessionId !== 'abc-123') process.exit(2)
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    if (message.params.prompt[0].text === 'missing key') {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32603,
        message: 'Internal error: turn failed: llm-pi-ai: no credential for provider route "zgci"' } })
      return
    }
    prompt = message
    send({ jsonrpc: '2.0', id: 42, method: 'session/request_permission', params: {
      sessionId: 'abc-123', toolCall: { toolCallId: 'tool-1', title: 'escalate', status: 'pending' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }],
    } })
  } else if (message.id === 42) {
    if (message.result?.outcome?.optionId !== 'reject') process.exit(3)
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'abc-123', update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'DeepSeek answer' },
    } } })
    send({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } })
  }
})
`)
  t.after(async () => {
    await shutdownAcpSessionRuntime()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const agent = { kind: 'deepseek', executable: cli, name: 'DeepSeek' }
  const options = { sandbox: 'read-only', onPermissionRequest: () => ({ status: 'approved', optionId: 'allow' }) }
  const first = await runAgent(agent, 'first', directory, options)
  assert.equal(first.text, 'DeepSeek answer')
  assert.equal(first.sessionRef, 'dsh-read:abc-123')
  const resumed = await runAgent(agent, 'second', directory, { ...options, sessionRef: first.sessionRef })
  assert.equal(resumed.text, 'DeepSeek answer')
  assert.equal(resumed.sessionRef, first.sessionRef)
  await assert.rejects(runAgent(agent, 'write', directory, {
    ...options, sandbox: 'workspace-write', sessionRef: first.sessionRef,
  }), { code: 'LOCAL_AGENT_SESSION_INVALID' })
  const write = await runAgent(agent, 'write', directory, { ...options, sandbox: 'workspace-write' })
  assert.equal(write.sessionRef, 'dsh-write:abc-123')
  await assert.rejects(runAgent(agent, 'missing key', directory, options), { code: 'LOCAL_AGENT_AUTH_REQUIRED' })
})

test('DeepSeek invocation pins policy and preserves only its allowed native environment', () => {
  const read = invocation('deepseek', '/bin/dsh', '/tmp', '', { sandbox: 'read-only' })
  const write = invocation('deepseek', '/bin/dsh', '/tmp', '', { sandbox: 'workspace-write' })
  assert.match(read.args.at(-1), /deepseek-read\.yml$/)
  assert.match(write.args.at(-1), /deepseek-write\.yml$/)
  assert.match(fs.readFileSync(read.args[3], 'utf8'), /model: smart-router-v2/)
  for (const [spec, mode] of [[read, 'read-only'], [write, 'workspace-write']]) {
    const policy = fs.readFileSync(spec.args.at(-1), 'utf8')
    assert.match(policy, new RegExp(`mode: ${mode}`))
    assert.match(policy, /policy: never/)
    assert.match(policy, /id: permission\s+disabled: true/)
  }
  const env = childEnvironment({ kind: 'deepseek', executable: '/bin/dsh' }, '/tmp', {
    env: { ZGCI_API_KEY: 'test-key', DSH_HOME: '/tmp/dsh', DSH_PERMISSION_MODE: 'danger-full-access' },
  }, process.platform)
  assert.equal(env.ZGCI_API_KEY, 'test-key')
  assert.equal(env.DSH_HOME, '/tmp/dsh')
  assert.equal(env.DSH_PERMISSION_MODE, undefined)
})

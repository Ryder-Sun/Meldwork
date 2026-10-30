const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const adapters = require('../../../src/agents/cli/cli-adapters.cjs')
const { normalizeFailure } = require('../../../src/runs/failure-policy.cjs')
const { executable, within, readWhenReady } = require('../../support/cli-adapters-test-helpers.cjs')

for (const [kind, paraphrased] of [['opencode', false], ['mimo', false], ['opencode', true]]) test(`${kind} ${paraphrased ? 'paraphrased' : 'exact'} native output loops are cancelled, preserve streamed text and never auto-retry as success`, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-acp-runaway-'))
  t.after(async () => { await adapters.shutdownAcpSessionRuntime(); fs.rmSync(directory, { recursive: true, force: true }) })
  const cancelled = path.join(directory, 'cancelled')
  const cli = executable(directory, kind, `
const fs = require('node:fs')
if (process.argv.includes('--help')) { console.log('opencode acp'); process.exit(0) }
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
const text = ${JSON.stringify(paraphrased
    ? '# 表决：赞成。收到，本轮调研交付已收尾。确认，本轮调研正式收尾。本轮调研交付完成。确认，本轮调研结束。本轮调研已正式结束。确认。'
    : '# 表决：赞成——全场一致通过\n我投赞成票，确认讨论阶段完结。全场只读，工作区零改动。成果就绪，等待用户回复授权写入后按共识计划交付 AI 硬件创业公司调研报告全文以及一页执行摘要。')}
let timer, request
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line), sessionId = 'native-loop-session'
  if (message.method === 'initialize') send({jsonrpc:'2.0',id:message.id,result:{protocolVersion:1}})
  else if (message.method === 'session/new') send({jsonrpc:'2.0',id:message.id,result:{sessionId}})
  else if (message.method === 'session/set_mode') send({jsonrpc:'2.0',id:message.id,result:{}})
  else if (message.method === 'session/prompt') {
    request = message.id
    timer = setInterval(() => send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}}), 5)
  } else if (message.method === 'session/cancel') {
    clearInterval(timer); fs.writeFileSync(${JSON.stringify(cancelled)}, 'cancelled')
    send({jsonrpc:'2.0',id:request,result:{stopReason:'cancelled'}})
  }
})
`)
  const events = []
  await assert.rejects(within(adapters.runAgent({ kind, executable: cli }, 'return one answer', directory, {
    onEvent: event => events.push(event),
  }), 10000), error => {
    assert.equal(error.code, 'LOCAL_AGENT_REPEATED_OUTPUT')
    assert.equal(normalizeFailure(error).retryability, 'never')
    return true
  })
  assert.equal(await readWhenReady(cancelled), 'cancelled')
  const text = events.filter(event => event.type === 'answer_delta').map(event => event.delta).join('')
  assert.match(text, /表决：赞成/)
  assert.ok(text.length < 1500)
  assert.ok(!events.some(event => event.status === 'completed'))
})

test('Hermes native JSON streaming is terminated when it repeats short acknowledgements forever', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-hermes-runaway-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const terminated = path.join(directory, 'terminated')
  const cli = executable(directory, 'hermes', `
process.on('SIGTERM', () => { require('node:fs').writeFileSync(${JSON.stringify(terminated)}, 'terminated'); process.exit(0) })
setInterval(() => console.log(JSON.stringify({type:'text',text:'已确认，随时待命。'})), 5)
`)
  const events = []
  await assert.rejects(within(adapters.runAgent({ kind: 'hermes', executable: cli, streamJsonAvailable: true, acpAvailable: false }, 'one conclusion', directory, {
    onEvent: event => events.push(event),
  }), 10000), { code: 'LOCAL_AGENT_REPEATED_OUTPUT' })
  assert.equal(await readWhenReady(terminated), 'terminated')
  assert.match(events.filter(event => event.type === 'answer_delta').map(event => event.delta).join(''), /已确认/)
})

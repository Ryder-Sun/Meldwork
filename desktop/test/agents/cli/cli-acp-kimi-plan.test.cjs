const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const adapters = require('../../../src/agents/cli/cli-adapters.cjs')
const { automaticPermissionResponse } = require('../../../src/agents/agent-permission-policy.cjs')
const { executable, within, readWhenReady } = require('../../support/cli-adapters-test-helpers.cjs')

test('Kimi read-only queries use manual mode and still reject writes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-kimi-query-'))
  t.after(async () => { await adapters.shutdownAcpSessionRuntime(); fs.rmSync(directory, { recursive: true, force: true }) })
  const cli = executable(directory, 'kimi', `
const send = value => console.log(JSON.stringify(value))
let promptId, mode
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line)
 if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1}})
 else if(m.method==='session/new')send({jsonrpc:'2.0',id:m.id,result:{sessionId:'query'}})
 else if(m.method==='session/set_mode'){mode=m.params.modeId;send({jsonrpc:'2.0',id:m.id,result:{}})}
 else if(m.method==='session/prompt'){
  promptId=m.id
  send({jsonrpc:'2.0',id:99,method:'session/request_permission',params:{sessionId:'query',toolCall:{toolCallId:'write',kind:'edit',status:'pending',title:'Write file'},options:[{optionId:'allow',kind:'allow_once',name:'Allow'},{optionId:'reject',kind:'reject_once',name:'Reject'}]}})
 }else if(m.id===99&&m.result){
  const text=mode==='default'&&m.result.outcome?.optionId==='reject'?'ANSWER_WITHOUT_WRITES':'WRONG_MODE_OR_PERMISSION'
  send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'query',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}})
  send({jsonrpc:'2.0',id:promptId,result:{stopReason:'end_turn'}})
 }
})
`)
  const result = await within(adapters.runAgent({kind:'kimi',executable:cli}, 'answer a query', directory, {
    sandbox:'read-only', onPermissionRequest:request=>automaticPermissionResponse(request,{allowWrite:false}),
  }),10000)
  assert.equal(result.text,'ANSWER_WITHOUT_WRITES')
})

for (const callback of [false, true]) test(`Kimi plan review refuses and exits instead of revising without feedback: ${callback}`, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-kimi-plan-'))
  t.after(async () => { await adapters.shutdownAcpSessionRuntime(); fs.rmSync(directory, { recursive: true, force: true }) })
  const selected = path.join(directory, 'selected')
  const cli = executable(directory, 'kimi', `
const send = value => console.log(JSON.stringify(value))
const sessionId = 'kimi-plan-session'
let promptId
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line)
 if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1}})
 else if(m.method==='session/new')send({jsonrpc:'2.0',id:m.id,result:{sessionId}})
 else if(m.method==='session/set_mode')send({jsonrpc:'2.0',id:m.id,result:{}})
 else if(m.method==='session/prompt'){
   promptId=m.id
   send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Initial analysis and proposed next steps.'}}}})
   send({jsonrpc:'2.0',id:99,method:'session/request_permission',params:{sessionId,toolCall:{toolCallId:'plan',kind:'switch_mode',status:'pending',title:'ExitPlanMode'},options:[{optionId:'plan_approve',kind:'allow_once',name:'Approve'},{optionId:'plan_revise',kind:'reject_once',name:'Revise'},{optionId:'plan_reject_and_exit',kind:'reject_once',name:'Reject and Exit'}]}})
 }else if(m.id===99&&m.result){
   const id=m.result.outcome?.optionId
   require('node:fs').writeFileSync(${JSON.stringify(selected)},id||'cancelled')
   if(id==='plan_reject_and_exit')send({jsonrpc:'2.0',id:promptId,result:{stopReason:'end_turn'}})
 }
})
`)
  const result = await within(adapters.runAgent({ kind: 'kimi', executable: cli }, 'one independent contribution', directory, {
    ...(callback ? { onPermissionRequest: request => automaticPermissionResponse(request, { allowWrite: false }) } : {}),
  }), 10000)
  assert.equal(await readWhenReady(selected), 'plan_reject_and_exit')
  assert.equal(result.text, 'Initial analysis and proposed next steps.')
})

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const adapters = require('../../../src/agents/cli/cli-adapters.cjs')
const { executable, within } = require('../../support/cli-adapters-test-helpers.cjs')

for (const latePermission of [false, true]) test(`MiMo drains the exact message tail and rejects late authority: ${latePermission}`, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-mimo-terminal-'))
  t.after(async () => { await adapters.shutdownAcpSessionRuntime(); fs.rmSync(directory, { recursive: true, force: true }) })
  const cli = executable(directory, 'mimo', `
const send = value => console.log(JSON.stringify(value))
const sessionId = 'mimo-terminal-session'
const delta = (messageId, text) => send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',messageId,content:{type:'text',text}}}})
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line)
 if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1}})
 else if(m.method==='session/new')send({jsonrpc:'2.0',id:m.id,result:{sessionId}})
 else if(m.method==='session/set_mode')send({jsonrpc:'2.0',id:m.id,result:{}})
 else if(m.method==='session/prompt'){
   delta('answer-1','MELDWORK')
   send({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}})
   setTimeout(()=>{
     delta('answer-1','_OK')
     delta('unsolicited-message','MUST NOT MERGE')
     if(${latePermission})send({jsonrpc:'2.0',id:99,method:'session/request_permission',params:{sessionId,toolCall:{toolCallId:'late-write',kind:'edit',status:'pending'},options:[{optionId:'allow',kind:'allow_once',name:'Allow write'}]}})
   },10)
 }
})
`)
  let approvals = 0
  const run = within(adapters.runAgent({ kind: 'mimo', executable: cli }, 'return one answer', directory, {
    sandbox: 'workspace-write', onPermissionRequest: async () => { approvals++; return { status: 'approved', optionId: 'allow' } },
  }), 10000)
  if (latePermission) await assert.rejects(run, { code: 'LOCAL_AGENT_PERMISSION_TERMINAL_RACE' })
  else assert.equal((await run).text, 'MELDWORK_OK')
  assert.equal(approvals, 0)
})

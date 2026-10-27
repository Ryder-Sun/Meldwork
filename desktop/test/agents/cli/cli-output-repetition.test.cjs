const test = require('node:test')
const assert = require('node:assert/strict')
const { createOutputRepetitionGuard } = require('../../../src/agents/cli/cli-output-repetition.cjs')

const answer = '# 表决：赞成——全场一致通过\n\n我投赞成票，确认讨论阶段完结。全场只读，工作区零改动。\n\n成果就绪，等待用户回复“**授权写入**”后按共识计划交付《AI 硬件创业公司调研报告.md》全文 + 一页执行摘要。'
const update = text => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })

test('detects the reported Chinese vote loop across arbitrary stream chunks', () => {
  for (const size of [1, 7, 83, 257]) {
    const guard = createOutputRepetitionGuard()
    const text = answer.repeat(80)
    let stoppedAt = 0
    for (let offset = 0; offset < text.length; offset += size) {
      if (guard(update(text.slice(offset, offset + size)))) { stoppedAt = offset + size; break }
    }
    assert.ok(stoppedAt > 0 && stoppedAt < answer.length * 7, `chunk size ${size}: ${stoppedAt}`)
  }
})

test('does not reject ordinary long answers, repeated characters or three quotations', () => {
  for (const text of [answer.repeat(3), '*'.repeat(30000), Array.from({ length: 500 }, (_, index) => `Company ${index}: evidence varies by company and round ${index}.\n`).join('')]) {
    const guard = createOutputRepetitionGuard()
    for (let offset = 0; offset < text.length; offset += 41) assert.equal(guard(update(text.slice(offset, offset + 41))), false)
  }
})

test('real tools reset the window but repeated thoughts do not hide an output loop', () => {
  const guard = createOutputRepetitionGuard()
  for (let index = 0; index < 10; index++) {
    assert.equal(guard(update(answer.repeat(2))), false)
    guard({ sessionUpdate: 'tool_call', toolCallId: `tool-${index}`, status: 'in_progress' })
  }
  let repeated = false
  for (let index = 0; index < 8 && !repeated; index++) {
    guard({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } })
    repeated = guard(update(answer))
  }
  assert.equal(repeated, true)
})

test('independent turns do not share repetition state', () => {
  for (let index = 0; index < 8; index++) assert.equal(createOutputRepetitionGuard()(update(answer.repeat(2))), false)
})

test('detects MiMo short acknowledgements and native JSON-stream answer deltas', () => {
  for (const phrase of ['已确认，随时待命。', 'MELDWORK_OK']) {
    const guard = createOutputRepetitionGuard()
    let count = 0
    while (++count < 20 && !guard({ type: 'answer_delta', delta: phrase })) {}
    assert.ok(count < 20, phrase)
  }
})

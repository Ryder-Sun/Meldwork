// Detect a runaway native turn, rather than deduplicating its visible answer.
// Exact repetitions and sustained paraphrased closing acknowledgements count;
// real tool activity resets the window.
const CLOSING_ACKNOWLEDGEMENT = /^(?:(?:确认(?:收到)?|收到|本轮).{0,100}(?:收尾|结束|完成|定稿|后续轮次|按.{0,16}分工).{0,30}|确认|收到|确认收到|(?:confirmed|acknowledged|done)(?:[,:;].{0,100})?)$/iu

function createOutputRepetitionGuard() {
  const windows = { answer: { text: '', unchecked: 0 }, thought: { text: '', unchecked: 0 } }
  return update => {
    const type = update?.sessionUpdate || update?.type
    if (['tool_call', 'tool_call_update', 'tool_start', 'tool_result_summary'].includes(type)) {
      for (const window of Object.values(windows)) { window.text = ''; window.unchecked = 0 }
      return false
    }
    const window = type === 'agent_thought_chunk' ? windows.thought : windows.answer
    const value = type === 'answer_delta' ? update.delta
      : ['agent_message_chunk', 'agent_thought_chunk'].includes(type)
        && update.content?.type === 'text' ? update.content.text : ''
    const chunk = String(value || '').replace(/\s/g, '')
    if (!chunk) return false
    window.text = (window.text + chunk).slice(-8192)
    window.unchecked += chunk.length
    const text = window.text
    if (window.unchecked < 32 || text.length < 64) return false
    window.unchecked = 0
    const clauses = text.split(/[。！？.!?]+/u).filter(Boolean).slice(-12)
    if (window === windows.answer
        && clauses.filter(clause => CLOSING_ACKNOWLEDGEMENT.test(clause)).length >= 8) return true
    if (new Set(text).size < 6) return false
    const anchor = text.slice(-8)
    let previous = text.lastIndexOf(anchor, text.length - 16)
    while (previous >= 0) {
      const period = text.length - 8 - previous
      if (period > 2048) break
      const copies = window === windows.thought ? (period < 80 ? 16 : 8) : (period < 80 ? 8 : 4)
      if (period * copies <= text.length) {
        const block = text.slice(-period)
        if (new Set(block).size >= 6 && text.endsWith(block.repeat(copies))) return true
      }
      previous = previous > 0 ? text.lastIndexOf(anchor, previous - 1) : -1
    }
    return false
  }
}

module.exports = { createOutputRepetitionGuard }

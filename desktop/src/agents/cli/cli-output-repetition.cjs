// Detect a runaway native turn, rather than deduplicating its visible answer.
// Exact repetitions and sustained paraphrased closing acknowledgements count;
// real tool activity resets the window.
const CLOSING_ACKNOWLEDGEMENT = /^(?:(?:确认(?:收到)?|收到|本轮).{0,100}(?:收尾|结束|完成|定稿|后续轮次|按.{0,16}分工).{0,30}|确认|收到|确认收到|(?:confirmed|acknowledged|done)(?:[,:;].{0,100})?)$/iu

function createOutputRepetitionGuard() {
  let text = ''
  let unchecked = 0
  return update => {
    const type = update?.sessionUpdate || update?.type
    if (['tool_call', 'tool_call_update', 'tool_start', 'tool_result_summary'].includes(type)) {
      text = ''
      unchecked = 0
      return false
    }
    const value = type === 'answer_delta' ? update.delta
      : type === 'agent_message_chunk' && update.content?.type === 'text' ? update.content.text : ''
    const chunk = String(value || '').replace(/\s/g, '')
    if (!chunk) return false
    text = (text + chunk).slice(-8192)
    unchecked += chunk.length
    if (unchecked < 32 || text.length < 64) return false
    unchecked = 0
    const clauses = text.split(/[。！？.!?]+/u).filter(Boolean).slice(-12)
    if (clauses.filter(clause => CLOSING_ACKNOWLEDGEMENT.test(clause)).length >= 8) return true
    if (new Set(text).size < 6) return false
    const anchor = text.slice(-8)
    let previous = text.lastIndexOf(anchor, text.length - 16)
    while (previous >= 0) {
      const period = text.length - 8 - previous
      if (period > 2048) break
      const copies = period < 80 ? 8 : 4
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

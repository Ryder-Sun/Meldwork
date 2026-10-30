const { randomUUID } = require('node:crypto')

// A contribution ends only on an explicit, invocation-specific signal from
// the assistant. Tool output and acknowledgements cannot finish a turn.
function createTurnCompletion() {
  const marker = `[[MELDWORK_TURN_DONE:${randomUUID()}]]`
  let text = ''
  let delivered = 0
  let completed = false
  return {
    instruction: `This is one scheduled contribution. Other participants cannot run until you return. Complete only the contribution requested for this invocation; do not poll or wait for their approvals. After your answer and any required collaboration receipt, output this exact signal on its own final line: ${marker}\nThe signal ends only your invocation, never the group task. Do not quote or explain it, and do not output it before all your tools have finished.`,
    push(delta, toolsFinished = true) {
      if (completed) return { delta: '', completed: true }
      text += delta
      const index = text.lastIndexOf(marker)
      if (toolsFinished && index > 0 && text[index - 1] === '\n'
          && /^(?:[ \t]*\r?\n|[ \t]*$)/.test(text.slice(index + marker.length))) {
        const before = text.slice(0, index)
        const fences = before.match(/^\s*(?:```|~~~)/gm) || []
        if (fences.length % 2 === 0 && before.trim()) {
          completed = true
          const visible = before.slice(delivered)
          text = before
          delivered = text.length
          return { delta: visible, completed: true }
        }
      }
      let held = 0
      for (let length = Math.min(marker.length, text.length); length > 0; length--) {
        if (text.endsWith(marker.slice(0, length))) { held = length; break }
      }
      const end = text.length - held
      const visible = text.slice(delivered, end)
      delivered = end
      return { delta: visible, completed: false }
    },
    get completed() { return completed },
  }
}

module.exports = { createTurnCompletion }

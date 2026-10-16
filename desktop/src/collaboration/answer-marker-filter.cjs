const { V4_RECEIPT_MARKER_PREFIX } = require('./collaboration-receipt.cjs')

// Control markers an Agent appends to its answer. They steer the harness and
// must never reach the user's screen, even while the answer is still streaming.
const CONSENSUS_MARKERS = Object.freeze([
  '[[MELDWORK_CONSENSUS:agree]]',
  '[[MELDWORK_CONSENSUS:continue]]',
])

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Length of the longest buffer suffix that could still grow into a marker.
function heldSuffixLength(buffer, markers) {
  let hold = 0
  for (const marker of markers) {
    for (let size = Math.min(marker.length - 1, buffer.length); size > hold; size -= 1) {
      if (buffer.slice(-size).toLowerCase() === marker.slice(0, size).toLowerCase()) {
        hold = size
        break
      }
    }
  }
  return hold
}

// Streams answer deltas through a marker filter.
//   plain    nothing to hide: deltas pass through untouched.
//   auto     hide the legacy consensus markers.
//   receipt  hide the consensus markers and everything from the start of the
//            collaboration receipt on (the receipt is parsed from the final text).
// `push` returns the text that is safe to show now; text that might be the
// start of a marker is held back until the next delta settles it, and
// `flush` releases what is left once the answer has finished.
function createAnswerMarkerFilter({ mode = 'plain' } = {}) {
  if (mode === 'plain') {
    return { push: delta => String(delta || ''), flush: () => '' }
  }
  const hideReceipt = mode === 'receipt'
  const markers = hideReceipt
    ? [...CONSENSUS_MARKERS, V4_RECEIPT_MARKER_PREFIX]
    : [...CONSENSUS_MARKERS]
  const pattern = new RegExp(markers.map(escapeRegExp).join('|'), 'i')
  let buffer = ''
  let receiptStarted = false
  return {
    push(delta) {
      if (receiptStarted) return ''
      buffer += String(delta || '')
      let visible = ''
      while (buffer && !receiptStarted) {
        const match = pattern.exec(buffer)
        if (match) {
          visible += buffer.slice(0, match.index)
          buffer = buffer.slice(match.index + match[0].length)
          if (hideReceipt
              && match[0].toLowerCase() === V4_RECEIPT_MARKER_PREFIX.toLowerCase()) {
            receiptStarted = true
          }
          continue
        }
        const hold = heldSuffixLength(buffer, markers)
        visible += hold ? buffer.slice(0, -hold) : buffer
        buffer = hold ? buffer.slice(-hold) : ''
        break
      }
      return visible
    },
    flush(finalText = '') {
      const rest = buffer
      buffer = ''
      if (!hideReceipt) return rest
      // A held fragment is real answer text only when the final answer ends
      // with it; otherwise it was the start of the (hidden) receipt.
      return !receiptStarted && rest && String(finalText).endsWith(rest) ? rest : ''
    },
  }
}

module.exports = { CONSENSUS_MARKERS, createAnswerMarkerFilter }

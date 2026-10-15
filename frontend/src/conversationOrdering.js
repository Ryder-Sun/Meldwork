// One ordering rule for group conversations, shared by the timeline and the
// run trace panel.
//
// The backend assigns every Agent turn a per-topic `turnSeq` when it is
// dispatched (slot order for concurrent replies, dispatch order for
// discussions), and stamps failure and system notices with the turn they
// belong to. Live bubbles carry the same number as the reply that later
// replaces them, so nothing moves when a reply is saved. Older history has
// no `turnSeq` and keeps its saved chronological order.

export function positiveSequence(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

export function timestampValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : 0
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

export function messageTurnSequence(message) {
  return positiveSequence(message?.turnSeq)
    ?? positiveSequence(message?.liveAgentRun?.turnSeq)
}

// Returns a sortable key for one timeline message. `topicIndex` places the
// message's topic; `index` is the stable position in the source array.
export function timelineSortKey(message, { topicIndex, index }) {
  if (message?.role === 'user' && !message.threadRootId) return [topicIndex, 0, 0, 0, index]
  const turnSeq = messageTurnSequence(message)
  if (turnSeq != null) return [topicIndex, 2, turnSeq, 0, index]
  // Legacy history (and a live bubble whose number has not arrived yet) keeps
  // chronological order. Live bubbles without a number go after numbered
  // turns of their topic because they are the newest activity.
  if (message?.provisional) {
    return [topicIndex, 3, timestampValue(message.createdAt), 0, index]
  }
  return [topicIndex, 1, timestampValue(message?.createdAt), 0, index]
}

export function compareSortKeys(left, right) {
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference) return difference
  }
  return 0
}

// Trace panel items: rounds stay grouped, then turn order, then the Agent's
// position in the run's own target list (never the mutable group list).
export function compareTraceItems(left, right, targetOrder = new Map()) {
  return (Number(left?.round) || 0) - (Number(right?.round) || 0)
    || (positiveSequence(left?.turnSeq) ?? Number.MAX_SAFE_INTEGER)
      - (positiveSequence(right?.turnSeq) ?? Number.MAX_SAFE_INTEGER)
    || (targetOrder.get(left?.agentKind) ?? 99) - (targetOrder.get(right?.agentKind) ?? 99)
    || timestampValue(left?.createdAt || left?.startedAt)
      - timestampValue(right?.createdAt || right?.startedAt)
}

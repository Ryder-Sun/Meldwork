const REAL_CLOCK = Object.freeze({
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: handle => clearTimeout(handle),
})

function positiveFinite(value) {
  return Number.isFinite(value) && value > 0
}

// Stops an Agent invocation that has gone quiet. Three windows apply:
//  - startup: strict turns (autonomous discussion) must show any sign of life
//    within `timeoutMs`; once they do, the deadline is lifted.
//  - inactivity: any activity refreshes `timeoutMs`, or `toolTimeoutMs` while a
//    tool call is running.
//  - stall: strict turns also stop after three inactivity windows without
//    substantive progress, so a CLI that emits empty heartbeats forever still
//    ends and the remaining participants can continue. Other turns keep
//    running while the process is active; the user can stop them.
// Raw process output only proves liveness (`liveness`); mapped events, answer
// text, tool lifecycle and structured progress count as progress (`progress`).
function createInvocationWatchdog({
  timeoutMs,
  toolTimeoutMs,
  maxDurationMs,
  answerIdleMs,
  maxToolCalls,
  strict = false,
  isStopped = () => false,
  onTimeout = () => {},
  clock = REAL_CLOCK,
} = {}) {
  const enabled = positiveFinite(timeoutMs)
  const startedAt = clock.now()
  const startupDeadlineAt = strict && enabled ? startedAt + timeoutMs : Number.POSITIVE_INFINITY
  let hardDeadlineAt = positiveFinite(maxDurationMs)
    ? startedAt + maxDurationMs : Number.POSITIVE_INFINITY
  const toolCallLimit = positiveFinite(maxToolCalls) ? Math.floor(maxToolCalls) : 0
  const toolCallIds = new Set()
  const activeToolIds = new Set()
  let lastProgressAt = startedAt
  let lastSubstantiveAt = startedAt
  let hasAnswer = false
  let paused = false
  let pausedAt = null
  let established = false
  let toolActive = false
  let closed = false
  let timedOut = false
  let timeoutError = null
  let timer = null
  let rejectTimeout = () => {}
  const promise = new Promise((_, reject) => { rejectTimeout = reject })
  promise.catch(() => {})

  function disarm() {
    clock.clearTimeout(timer)
    timer = null
  }

  function arm() {
    if (timer || paused || isStopped() || (!enabled && !positiveFinite(maxDurationMs))) return
    const now = clock.now()
    const inactivityWindowMs = toolActive ? toolTimeoutMs : timeoutMs
    const inactivityRemainingMs = enabled
      ? Math.max(0, inactivityWindowMs - (now - lastProgressAt))
      : Number.POSITIVE_INFINITY
    const startupRemainingMs = Math.max(
      0, (established ? Number.POSITIVE_INFINITY : startupDeadlineAt) - now,
    )
    const stallWindowMs = !strict
      ? Number.POSITIVE_INFINITY
      : (toolActive ? toolTimeoutMs : timeoutMs * 3)
    const stallRemainingMs = Math.max(0, stallWindowMs - (now - lastSubstantiveAt))
    const hardRemainingMs = Math.max(0, hardDeadlineAt - now)
    const answerIdleRemainingMs = hasAnswer && !toolActive && positiveFinite(answerIdleMs)
      ? Math.max(0, answerIdleMs - (now - lastSubstantiveAt))
      : Number.POSITIVE_INFINITY
    const remainingMs = Math.min(
      inactivityRemainingMs, startupRemainingMs, stallRemainingMs,
      hardRemainingMs, answerIdleRemainingMs,
    )
    timer = clock.setTimeout(() => {
      timer = null
      if (paused || isStopped()) return
      timedOut = true
      timeoutError = new Error('LOCAL_AGENT_TIMEOUT')
      onTimeout(timeoutError)
      rejectTimeout(timeoutError)
    }, remainingMs)
  }

  function rearm() {
    if (paused) return
    disarm()
    arm()
  }

  function inactive() {
    return closed || isStopped()
  }

  // The process produced something meaningful: refresh every window.
  function progress() {
    if (inactive()) return
    lastProgressAt = clock.now()
    lastSubstantiveAt = lastProgressAt
    rearm()
  }

  arm()

  return {
    promise,
    get timedOut() { return timedOut },
    get error() { return timeoutError },
    progress,
    answer() {
      hasAnswer = true
      progress()
    },
    // The process is alive but has not said anything yet (stdout/stderr bytes,
    // ACP traffic): lift the startup deadline and refresh the inactivity
    // window outside tool calls.
    liveness() {
      if (inactive()) return
      established = true
      if (!toolActive) lastProgressAt = clock.now()
      rearm()
    },
    // First proof that the run started. Lifts the startup deadline only.
    establish() {
      if (established || isStopped()) return
      established = true
      rearm()
    },
    toolStarted(toolCallId = '') {
      const id = String(toolCallId || '')
      if (id && !toolCallIds.has(id)) {
        toolCallIds.add(id)
        if (toolCallLimit && toolCallIds.size > toolCallLimit) {
          timedOut = true
          timeoutError = new Error('LOCAL_AGENT_TOOL_LIMIT')
          disarm()
          onTimeout(timeoutError)
          rejectTimeout(timeoutError)
          return false
        }
      }
      if (id) activeToolIds.add(id)
      toolActive = true
      progress()
      return true
    },
    toolProgress() {
      toolActive = true
      progress()
    },
    toolFinished(toolCallId = '') {
      const id = String(toolCallId || '')
      if (id) activeToolIds.delete(id)
      else activeToolIds.clear()
      toolActive = id ? activeToolIds.size > 0 : false
      progress()
    },
    // Waiting for a person (Human Gate) is not the Agent being quiet.
    pause() {
      paused = true
      pausedAt = clock.now()
      disarm()
    },
    resume() {
      const pausedMs = pausedAt == null ? 0 : Math.max(0, clock.now() - pausedAt)
      if (Number.isFinite(hardDeadlineAt)) {
        hardDeadlineAt += pausedMs
      }
      lastSubstantiveAt += pausedMs
      pausedAt = null
      paused = false
      lastProgressAt = clock.now()
      arm()
    },
    close() {
      closed = true
      disarm()
    },
  }
}

module.exports = { createInvocationWatchdog }

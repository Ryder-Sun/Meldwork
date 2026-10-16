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
  strict = false,
  isStopped = () => false,
  onTimeout = () => {},
  clock = REAL_CLOCK,
} = {}) {
  const enabled = positiveFinite(timeoutMs)
  const startedAt = clock.now()
  const startupDeadlineAt = strict && enabled ? startedAt + timeoutMs : Number.POSITIVE_INFINITY
  let lastProgressAt = startedAt
  let lastSubstantiveAt = startedAt
  let paused = false
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
    if (timer || paused || isStopped() || !enabled) return
    const now = clock.now()
    const inactivityWindowMs = toolActive ? toolTimeoutMs : timeoutMs
    const inactivityRemainingMs = Math.max(0, inactivityWindowMs - (now - lastProgressAt))
    const startupRemainingMs = Math.max(
      0, (established ? Number.POSITIVE_INFINITY : startupDeadlineAt) - now,
    )
    const stallWindowMs = !strict
      ? Number.POSITIVE_INFINITY
      : (toolActive ? toolTimeoutMs : timeoutMs * 3)
    const stallRemainingMs = Math.max(0, stallWindowMs - (now - lastSubstantiveAt))
    const remainingMs = Math.min(inactivityRemainingMs, startupRemainingMs, stallRemainingMs)
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
    toolStarted() {
      toolActive = true
      progress()
    },
    toolFinished() {
      toolActive = false
      progress()
    },
    // Waiting for a person (Human Gate) is not the Agent being quiet.
    pause() {
      paused = true
      disarm()
    },
    resume() {
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

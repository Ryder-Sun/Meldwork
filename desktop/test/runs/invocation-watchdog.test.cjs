const test = require('node:test')
const assert = require('node:assert/strict')
const { createInvocationWatchdog } = require('../../src/runs/invocation-watchdog.cjs')

// A manual clock: timers only fire when the test advances time.
function fakeClock() {
  let current = 1_000
  let nextId = 1
  const timers = new Map()
  return {
    now: () => current,
    setTimeout(callback, ms) {
      const id = nextId++
      timers.set(id, { at: current + ms, callback })
      return id
    },
    clearTimeout(id) { timers.delete(id) },
    advance(ms) {
      const target = current + ms
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        current = Math.max(current, due[1].at)
        due[1].callback()
      }
      current = target
    },
    pending: () => timers.size,
  }
}

function watchdogFor(overrides = {}) {
  const clock = fakeClock()
  const aborted = { value: false }
  const watchdog = createInvocationWatchdog({
    timeoutMs: 1000,
    toolTimeoutMs: 5000,
    isStopped: () => aborted.value,
    onTimeout: () => { aborted.value = true },
    clock,
    ...overrides,
  })
  return { clock, aborted, watchdog }
}

test('an Agent that never shows any activity times out after the inactivity window', async () => {
  const { clock, watchdog } = watchdogFor()
  clock.advance(999)
  assert.equal(watchdog.timedOut, false)
  clock.advance(1)
  assert.equal(watchdog.timedOut, true)
  assert.equal(watchdog.error.message, 'LOCAL_AGENT_TIMEOUT')
  await assert.rejects(watchdog.promise, /LOCAL_AGENT_TIMEOUT/)
})

test('progress refreshes the window and liveness lifts the startup deadline', () => {
  const { clock, watchdog } = watchdogFor({ strict: true })
  clock.advance(900)
  watchdog.liveness()
  clock.advance(900)
  assert.equal(watchdog.timedOut, false)
  watchdog.progress()
  clock.advance(900)
  assert.equal(watchdog.timedOut, false)
  clock.advance(100)
  assert.equal(watchdog.timedOut, true)
})

test('establishing the run keeps the inactivity timer armed', () => {
  // The first event used to clear the timer without re-arming it, so an Agent
  // that went silent right after its first event was never stopped.
  const { clock, watchdog } = watchdogFor()
  clock.advance(500)
  watchdog.establish()
  assert.equal(clock.pending(), 1)
  clock.advance(499)
  assert.equal(watchdog.timedOut, false)
  clock.advance(1)
  assert.equal(watchdog.timedOut, true)
})

test('strict turns stop after three windows without substantive progress, other turns keep running', () => {
  const strict = watchdogFor({ strict: true })
  for (let step = 0; step < 3; step += 1) {
    strict.clock.advance(900)
    strict.watchdog.liveness()
  }
  strict.clock.advance(900)
  strict.watchdog.liveness()
  assert.equal(strict.watchdog.timedOut, true)

  const relaxed = watchdogFor()
  for (let step = 0; step < 10; step += 1) {
    relaxed.clock.advance(900)
    relaxed.watchdog.liveness()
  }
  assert.equal(relaxed.watchdog.timedOut, false)
})

test('a running tool uses the longer window and its own liveness does not extend it', () => {
  const { clock, watchdog } = watchdogFor()
  watchdog.toolStarted()
  clock.advance(4000)
  watchdog.liveness()
  clock.advance(999)
  assert.equal(watchdog.timedOut, false)
  clock.advance(1)
  assert.equal(watchdog.timedOut, true)

  const finished = watchdogFor()
  finished.watchdog.toolStarted()
  finished.clock.advance(4000)
  finished.watchdog.toolFinished()
  finished.clock.advance(999)
  assert.equal(finished.watchdog.timedOut, false)
})

test('the absolute invocation deadline stops continuous tool activity', async () => {
  const { clock, watchdog } = watchdogFor({ strict: true, maxDurationMs: 3000 })
  watchdog.establish()
  watchdog.toolStarted('search-1')
  clock.advance(900)
  watchdog.toolFinished()
  watchdog.toolStarted('search-2')
  clock.advance(900)
  watchdog.toolFinished()
  watchdog.toolStarted('search-3')
  clock.advance(1199)
  assert.equal(watchdog.timedOut, false)
  clock.advance(1)
  assert.equal(watchdog.timedOut, true)
  assert.equal(watchdog.error.message, 'LOCAL_AGENT_TIMEOUT')
  await assert.rejects(watchdog.promise, /LOCAL_AGENT_TIMEOUT/)
})

test('a human gate pauses the absolute invocation deadline', () => {
  const { clock, watchdog } = watchdogFor({ timeoutMs: 5000, maxDurationMs: 3000 })
  watchdog.pause()
  clock.advance(10_000)
  watchdog.resume()
  clock.advance(2999)
  assert.equal(watchdog.timedOut, false)
  clock.advance(1)
  assert.equal(watchdog.timedOut, true)
})

test('the per-invocation tool call limit is independent of completed tool activity', async () => {
  const { watchdog } = watchdogFor({ maxToolCalls: 2 })
  assert.equal(watchdog.toolStarted('search-1'), true)
  watchdog.toolFinished()
  assert.equal(watchdog.toolStarted('search-2'), true)
  watchdog.toolFinished()
  assert.equal(watchdog.toolStarted('search-3'), false)
  assert.equal(watchdog.timedOut, true)
  assert.equal(watchdog.error.message, 'LOCAL_AGENT_TOOL_LIMIT')
  await assert.rejects(watchdog.promise, /LOCAL_AGENT_TOOL_LIMIT/)
})

test('an answered turn stops after silence even when protocol traffic stays alive', async () => {
  const { clock, watchdog } = watchdogFor({ strict: true, answerIdleMs: 300 })
  watchdog.answer()
  clock.advance(200)
  watchdog.liveness()
  clock.advance(99)
  assert.equal(watchdog.timedOut, false)
  clock.advance(1)
  assert.equal(watchdog.error.message, 'LOCAL_AGENT_TIMEOUT')
  await assert.rejects(watchdog.promise, /LOCAL_AGENT_TIMEOUT/)
})

test('an answered turn waits for all active tools before applying its idle window', () => {
  const { clock, watchdog } = watchdogFor({ answerIdleMs: 300 })
  watchdog.answer()
  watchdog.toolStarted('search-1')
  watchdog.toolStarted('search-2')
  watchdog.toolFinished('search-1')
  clock.advance(300)
  assert.equal(watchdog.timedOut, false)
  watchdog.toolFinished('search-2')
  clock.advance(299)
  assert.equal(watchdog.timedOut, false)
  clock.advance(1)
  assert.equal(watchdog.timedOut, true)
})

test('waiting for a person pauses the answered-turn idle window', () => {
  const { clock, watchdog } = watchdogFor({ answerIdleMs: 300 })
  watchdog.answer()
  clock.advance(200)
  watchdog.pause()
  clock.advance(10_000)
  watchdog.resume()
  clock.advance(99)
  assert.equal(watchdog.timedOut, false)
  clock.advance(1)
  assert.equal(watchdog.timedOut, true)
})

test('waiting for a person pauses the watchdog and resuming restarts the window', () => {
  const { clock, watchdog } = watchdogFor()
  watchdog.pause()
  clock.advance(60_000)
  assert.equal(watchdog.timedOut, false)
  watchdog.resume()
  clock.advance(999)
  assert.equal(watchdog.timedOut, false)
  clock.advance(1)
  assert.equal(watchdog.timedOut, true)
})

test('a stopped or closed invocation never reports a timeout', () => {
  const stopped = watchdogFor()
  stopped.aborted.value = true
  stopped.clock.advance(10_000)
  assert.equal(stopped.watchdog.timedOut, false)

  const closed = watchdogFor()
  closed.watchdog.close()
  closed.clock.advance(10_000)
  assert.equal(closed.watchdog.timedOut, false)
  closed.watchdog.progress()
  assert.equal(closed.clock.pending(), 0)
})

test('a disabled timeout never arms a timer', () => {
  const { clock, watchdog } = watchdogFor({ timeoutMs: Number.POSITIVE_INFINITY })
  assert.equal(clock.pending(), 0)
  clock.advance(1e9)
  assert.equal(watchdog.timedOut, false)
})

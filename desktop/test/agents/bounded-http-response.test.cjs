const assert = require('node:assert/strict')
const test = require('node:test')
const { abortableHttpOperation, boundedHttpResponseText, discardLateHttpResponse } = require('../../src/agents/bounded-http-response.cjs')

test('aborted reads release the reader even when the underlying stream never settles', async () => {
  const controller = new AbortController()
  let cancelled = false
  let released = false
  const reader = {
    read: () => new Promise(() => {}),
    cancel: () => { cancelled = true; return new Promise(() => {}) },
    releaseLock: () => { released = true },
  }
  const pending = boundedHttpResponseText({ body: { getReader: () => reader } }, 16, 'TOO_LARGE', controller.signal)
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(cancelled, true)
  assert.equal(released, true)
})

test('an aborted stream cancels its reader without waiting for cancellation to finish', async () => {
  let cancelled = false
  const controller = new AbortController()
  const response = { body: new ReadableStream({
    cancel() { cancelled = true; return new Promise(() => {}) },
  }) }
  const pending = abortableHttpOperation(boundedHttpResponseText(response, 16, 'TOO_LARGE', controller.signal), controller.signal)
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(cancelled, true)
})

test('a failed response read cancels the stream without masking the original error', async () => {
  let cancelled = 0
  let released = false
  const error = new Error('read failed')
  const reader = { read: async () => { throw error }, cancel: () => { cancelled += 1; return new Promise(() => {}) },
    releaseLock: () => { released = true } }
  await assert.rejects(boundedHttpResponseText({ body: { getReader: () => reader } }, 16, 'TOO_LARGE'),
    failure => failure === error)
  assert.equal(cancelled, 1)
  assert.equal(released, true)
})

test('a response arriving after abort has its body discarded', async () => {
  let resolveResponse
  let cancelled = false
  const controller = new AbortController()
  const pending = new Promise(resolve => { resolveResponse = resolve })
  discardLateHttpResponse(pending, controller.signal)
  const result = abortableHttpOperation(pending, controller.signal)
  controller.abort()
  await assert.rejects(result, { name: 'AbortError' })
  resolveResponse({ body: { cancel: () => { cancelled = true } } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cancelled, true)
})

test('an oversized response fails even if stream cancellation never settles', async () => {
  let cancelled = false
  const response = { body: new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(8)) },
    cancel() { cancelled = true; return new Promise(() => {}) },
  }) }
  let timer
  try {
    await assert.rejects(Promise.race([
      boundedHttpResponseText(response, 4, 'RESPONSE_TOO_LARGE'),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('TIMEOUT')), 1000) }),
    ]), { code: 'RESPONSE_TOO_LARGE' })
    assert.equal(cancelled, true)
  } finally { clearTimeout(timer) }
})

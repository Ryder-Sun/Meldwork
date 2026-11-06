const assert = require('node:assert/strict')
const test = require('node:test')
const { boundedHttpResponseText } = require('../../src/agents/bounded-http-response.cjs')

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

async function abortableHttpOperation(operation, signal) {
  const pending = Promise.resolve(operation)
  if (!signal) return pending
  if (signal.aborted) {
    pending.catch(() => {})
    throw signal.reason
  }
  let onAbort
  const aborted = new Promise((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try { return await Promise.race([pending, aborted]) }
  finally { signal.removeEventListener('abort', onAbort) }
}

function discardLateHttpResponse(operation, signal) {
  Promise.resolve(operation).then(response => {
    if (signal?.aborted && typeof response?.body?.cancel === 'function') {
      try { Promise.resolve(response.body.cancel()).catch(() => {}) } catch { /* already closed */ }
    }
  }, () => {})
}

async function boundedHttpResponseText(response, limit, errorCode, signal) {
  const invalid = () => { throw Object.assign(new Error(errorCode), { code: errorCode }) }
  if (!response.body?.getReader) {
    const text = await response.text()
    if (typeof text !== 'string' || Buffer.byteLength(text) > limit) invalid()
    return text
  }
  const reader = response.body.getReader()
  const onAbort = () => {
    try { Promise.resolve(reader.cancel()).catch(() => {}) } catch { /* already closed */ }
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      total += chunk.length
      if (total > limit) {
        try { Promise.resolve(reader.cancel()).catch(() => {}) } catch { /* response may already be closed */ }
        invalid()
      }
      chunks.push(chunk)
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

module.exports = { abortableHttpOperation, boundedHttpResponseText, discardLateHttpResponse }

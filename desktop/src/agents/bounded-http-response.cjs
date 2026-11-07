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

function discardHttpResponse(response) {
  if (typeof response?.body?.cancel === 'function') {
    try { Promise.resolve(response.body.cancel()).catch(() => {}) } catch { /* already closed */ }
  }
}

function discardLateHttpResponse(operation, signal) {
  Promise.resolve(operation).then(response => {
    if (signal?.aborted) discardHttpResponse(response)
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
  let cancelled = false
  const cancelReader = () => {
    if (cancelled) return
    cancelled = true
    try { Promise.resolve(reader.cancel()).catch(() => {}) } catch { /* already closed */ }
  }
  signal?.addEventListener('abort', cancelReader, { once: true })
  if (signal?.aborted) cancelReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await abortableHttpOperation(reader.read(), signal)
      if (done) break
      const chunk = Buffer.from(value)
      total += chunk.length
      if (total > limit) invalid()
      chunks.push(chunk)
    }
  } catch (error) {
    cancelReader()
    throw error
  } finally {
    signal?.removeEventListener('abort', cancelReader)
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

module.exports = { abortableHttpOperation, boundedHttpResponseText, discardHttpResponse, discardLateHttpResponse }

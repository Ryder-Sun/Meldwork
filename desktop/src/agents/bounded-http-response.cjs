async function boundedHttpResponseText(response, limit, errorCode) {
  const invalid = () => { throw Object.assign(new Error(errorCode), { code: errorCode }) }
  if (!response.body?.getReader) {
    const text = await response.text()
    if (typeof text !== 'string' || Buffer.byteLength(text) > limit) invalid()
    return text
  }
  const reader = response.body.getReader()
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
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks, total).toString('utf8')
}

module.exports = { boundedHttpResponseText }

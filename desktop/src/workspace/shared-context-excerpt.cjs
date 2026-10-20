// Extract source sentences, never generate new conclusions or turn omissions
// into agreement. Full messages remain in the local conversation/artifact store.
function sharedContextExcerpt(value, limit) {
  const text = String(value || '').trim()
  if (text.length <= limit) return { text, excerpted: false }
  const marker = '\n[Excerpt: omitted text remains in the original message; do not infer agreement.]\n'
  const budget = Math.max(0, limit - marker.length)
  const segments = [...new Set(text.split(/\n+|(?<=[。！？.!?])\s+/u).filter(Boolean))]
  const ranked = segments.map((body, index) => ({ body, index, priority:
    /^(?:constraint|decision|evidence|unresolved(?: conflict)?|risk|blocker|source|约束|决定|证据|未决|风险|阻塞|来源)\s*[:：]/iu.test(body) ? 5 :
    /不得|不能|必须|禁止|不要|未决|阻塞|冲突|不支持|not\b|never\b|must\b|unresolved|disagree|https?:/iu.test(body) ? 4 :
    /不得|不能|必须|禁止|不要|未决|风险|阻塞|冲突|来源|证据|决定|约束|不支持|not\b|never\b|must\b|constraint|decision|risk|blocker|unresolved|disagree|source|evidence|https?:|\d/iu.test(body) ? 3 : 1,
  }))
  const selected = new Map()
  let used = 0
  const take = item => {
    if (!item || selected.has(item.index) || used + item.body.length + 1 > budget) return
    selected.set(item.index, item)
    used += item.body.length + 1
  }
  // Preserve the opening context and the closing request when they fit, then
  // retain constraints, evidence and open issues from the middle of the source.
  take(ranked[0])
  take(ranked.at(-1))
  for (const item of ranked.sort((a, b) => b.priority - a.priority || a.index - b.index)) take(item)
  if (!selected.size) {
    const edge = Math.floor(budget / 2)
    const head = text.slice(0, edge).replace(/[\uD800-\uDBFF]$/u, '')
    const tail = edge ? text.slice(-edge).replace(/^[\uDC00-\uDFFF]/u, '') : ''
    return { text: `${head}${marker}${tail}`.slice(0, limit), excerpted: true }
  }
  return { text: [...selected.values()].sort((a, b) => a.index - b.index).map(item => item.body).join('\n') + marker, excerpted: true }
}

module.exports = { sharedContextExcerpt }

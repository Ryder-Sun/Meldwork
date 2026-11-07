function hermesDotenvAssignments(content, env = {}) {
  const values = { ...env }
  const assignments = []
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!match) continue
    const [, key, raw] = match
    const quoted = raw.match(/^(['"])(.*?)\1\s*(?:#.*)?$/)
    if (/^['"]/.test(raw) && !quoted) {
      assignments.push([key, null])
      continue
    }
    let value = quoted ? quoted[2] : raw.replace(/\s+#.*$/, '').trim()
    if (quoted?.[1] === '"') value = value.replace(/\\([nr"\\])/g, (_, c) => ({ n: '\n', r: '\r', '"': '"', '\\': '\\' })[c])
    if (quoted?.[1] === "'") value = value.replace(/\\(['\\])/g, '$1')
    value = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
      (_, name, fallback) => Object.hasOwn(values, name) ? values[name] : fallback || '')
    values[key] = value
    assignments.push([key, value])
  }
  return assignments
}

module.exports = { hermesDotenvAssignments }

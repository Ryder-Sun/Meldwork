const ALL_AGENT_PREFIXES = [
  /^(?:你们|各位|大家(?!庭))/u,
  /^(?:所有|全部|全体)(?:的)?\s*(?:agents?|智能体|助手)/iu,
  /^(?:everyone|all\s+agents?|all\s+of\s+you)\b/iu,
]

function skipCourtesyPrefix(value) {
  let offset = value.search(/\S/u)
  if (offset < 0) return value.length

  const chinese = /^(?:请|麻烦|劳烦)\s*/u.exec(value.slice(offset))
  if (chinese) return offset + chinese[0].length

  const english = /^please(?:\s+|\s*[,，:：]\s*)/iu.exec(value.slice(offset))
  return english ? offset + english[0].length : offset
}

function agentAliases(profile) {
  const label = String(profile?.label || '').trim()
  const shortLabel = label.replace(/\s+(?:code|cli)$/iu, '').trim()
  return [...new Set([profile?.kind, profile?.sourceKind, label, shortLabel]
    .map(value => String(value || '').trim())
    .filter(Boolean))]
}

function aliasMatches(value, lowerValue, offset, alias) {
  if (!lowerValue.startsWith(alias.lower, offset)) return false
  const next = value[offset + alias.value.length] || ''
  return !next || !/[A-Za-z0-9_.-]/u.test(next)
}

function skipRecipientSeparators(value, offset) {
  let cursor = offset
  while (cursor < value.length) {
    const separators = /^[\s,，、/&+]+/u.exec(value.slice(cursor))
    if (separators) {
      cursor += separators[0].length
      continue
    }
    const connector = /^(?:and\b|和|与|及)\s*/iu.exec(value.slice(cursor))
    if (connector) {
      cursor += connector[0].length
      continue
    }
    break
  }
  return cursor
}

function agentAliasOccurrences(value, lowerValue, aliases) {
  const matches = []
  for (const alias of aliases) {
    let offset = lowerValue.indexOf(alias.lower)
    while (offset >= 0) {
      const previous = value[offset - 1] || ''
      const next = value[offset + alias.value.length] || ''
      if ((!previous || !/[A-Za-z0-9_.-]/u.test(previous))
          && (!next || !/[A-Za-z0-9_.-]/u.test(next))) {
        matches.push({ ...alias, offset, end: offset + alias.value.length })
      }
      offset = lowerValue.indexOf(alias.lower, offset + alias.value.length)
    }
  }
  const selected = []
  for (const match of matches.sort((left, right) => (
    left.offset - right.offset || right.value.length - left.value.length
  ))) {
    if (selected.some(item => match.offset < item.end && match.end > item.offset)) continue
    selected.push(match)
  }
  return selected.sort((left, right) => left.offset - right.offset)
}

function occurrenceIsExcluded(value, occurrence) {
  const before = value.slice(Math.max(0, occurrence.offset - 32), occurrence.offset)
  const after = value.slice(occurrence.end, occurrence.end + 40)
  const action = '(?:运行|回答|参与|回复|发言|执行|响应|工作)'
  const beforeChinese = new RegExp(`(?:(?:不要|别|无需|不用|不必)\\s*(?:让|叫)?|不让|不叫|排除)\\s*$`, 'u')
  const afterChinese = new RegExp(`^\\s*${action}`, 'u')
  const afterChineseNegation = new RegExp(`^\\s*(?:(?:不要|别|无需|不用|不必)\\s*|不)${action}`, 'u')
  if ((beforeChinese.test(before) && afterChinese.test(after)) || afterChineseNegation.test(after)) {
    return true
  }
  const englishAction = '(?:run|answer|respond|participate|reply|work|execute)'
  if (/(?:without|exclude|excluding)\s*$/iu.test(before)) return true
  if (/(?:do\s+not|don['’]t|must\s+not|should\s+not)\s+(?:let|have|ask)\s*$/iu.test(before)
      && new RegExp(`^\\s*(?:to\\s+)?${englishAction}\\b`, 'iu').test(after)) {
    return true
  }
  if (/(?:do\s+not|don['’]t|must\s+not|should\s+not)\s*$/iu.test(before)
      && new RegExp(`^\\s*(?:to\\s+)?${englishAction}\\b`, 'iu').test(after)) {
    return true
  }
  return new RegExp(
    `^\\s*(?:do\\s+not|don['’]t|must\\s+not|should\\s+not)\\s+${englishAction}\\b`,
    'iu',
  ).test(after)
}

export function parseAgentRoutingPrefix(text, profiles, groupKinds) {
  const value = String(text || '')
  const availableKinds = [...new Set((Array.isArray(groupKinds) ? groupKinds : [])
    .map(kind => String(kind || ''))
    .filter(Boolean))]
  if (!value.trim() || !availableKinds.length) return { targetKinds: [], all: false }

  const available = new Set(availableKinds)
  const offset = skipCourtesyPrefix(value)
  const remaining = value.slice(offset)
  if (ALL_AGENT_PREFIXES.some(pattern => pattern.test(remaining))) {
    return { targetKinds: availableKinds, all: true }
  }

  const aliases = (Array.isArray(profiles) ? profiles : [])
    .filter(profile => available.has(String(profile?.kind || '')))
    .flatMap(profile => agentAliases(profile).map(alias => ({
      kind: String(profile.kind),
      value: alias,
      lower: alias.toLocaleLowerCase(),
    })))
    .sort((left, right) => right.value.length - left.value.length)
  const lowerValue = value.toLocaleLowerCase()
  const selected = new Set()
  let cursor = offset

  while (cursor < value.length) {
    const match = aliases.find(alias => aliasMatches(value, lowerValue, cursor, alias))
    if (!match) break
    selected.add(match.kind)
    const next = skipRecipientSeparators(value, cursor + match.value.length)
    if (next <= cursor) break
    cursor = next
  }

  const occurrences = agentAliasOccurrences(value, lowerValue, aliases)
  const excluded = new Set(occurrences
    .filter(occurrence => occurrenceIsExcluded(value, occurrence))
    .map(occurrence => occurrence.kind))
  const mentionedKinds = new Set(occurrences
    .map(occurrence => occurrence.kind)
    .filter(kind => !excluded.has(kind)))
  if (mentionedKinds.size >= 2) {
    for (const kind of mentionedKinds) selected.add(kind)
  }
  if (excluded.size) {
    for (const occurrence of occurrences) {
      if (!excluded.has(occurrence.kind)) selected.add(occurrence.kind)
    }
  }

  return {
    targetKinds: availableKinds.filter(kind => selected.has(kind) && !excluded.has(kind)),
    all: false,
  }
}

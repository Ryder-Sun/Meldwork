const VERSION_PATTERN = /\bv?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?\b/
const ANSI_PATTERN = /\x1b\[[0-?]*[ -\/]*[@-~]/g
const AGENT_VERSION_IDENTITIES = Object.freeze({
  codex: [/\bcodex(?:-cli)?\b/i],
  hermes: [/\bhermes(?:\s+agent)?\b/i],
  openclaw: [/\bopenclaw\b/i],
  workbuddy: [/\b(?:workbuddy|codebuddy)\b/i],
  zcode: [/\bzcode\b/i],
  pi: [/\bpi(?:\s+agent)?\b/i],
  kimi: [/\bkimi(?:\s+code)?\b/i],
  mimo: [/\bmimo(?:\s+code)?\b/i, /\bmimocode\b/i],
  claude: [/\bclaude(?:\s+code)?\b/i],
  gemini: [/\bgemini(?:\s+cli)?\b/i],
  opencode: [/\bopencode\b/i, /\bopen\s+code\b/i],
  qwen: [/\bqwen(?:\s+code)?\b/i],
  opencodereview: [/\bopen[-\s]?code[-\s]?review\b/i],
})
const AGENT_EXECUTABLE_NAMES = Object.freeze({
  codex: ['codex'],
  hermes: ['hermes'],
  openclaw: ['openclaw'],
  workbuddy: ['codebuddy'],
  zcode: ['zcode'],
  pi: ['pi', 'pi-agent', 'piagent'],
  kimi: ['kimi'],
  mimo: ['mimo'],
  claude: ['claude'],
  gemini: ['gemini'],
  opencode: ['opencode'],
  qwen: ['qwen'],
  opencodereview: ['ocr'],
})

const AGENT_COMPATIBILITY = Object.freeze({
  codex: profile('0.137.0', '0.146.0', [
    probe('codex-exec', ['exec', '--help'], [
      '--json', '--sandbox', '--skip-git-repo-check', '--image',
      'read-only', 'workspace-write',
    ]),
    probe('codex-resume', ['exec', 'resume', '--help'], [
      '--json', '--skip-git-repo-check',
    ]),
  ], ['0.146.0-alpha.9.2']),
  hermes: profile('0.19.1', '0.20.0', [
    probe('hermes-chat', ['chat', '--help'], [
      '--quiet', '--query', '--provider', '--model', '--resume',
      '--image', '--yolo',
    ]),
  ]),
  openclaw: exactProfile('2026.7.1-2', [
    probe('openclaw-agent', ['agent', '--help'], [
      '--local', '--agent', '--session-key', '--message', '--json',
    ]),
  ]),
  workbuddy: profile('2.115.0', '2.132.0', [
    probe('workbuddy-print', ['--help'], [
      '--print', '--output-format', '--permission-mode', '--max-turns', '--resume',
      'json', 'plan', 'acceptEdits',
    ]),
  ]),
  zcode: exactProfile('0.16.1', [
    probe('zcode-prompt', ['--help'], ['--prompt', '--json', '--mode', '--resume', 'plan', 'edit']),
  ]),
  pi: exactProfile('0.84.2', [
    probe('pi-cli', ['--help'], [
      '--mode', '--print', '--session', '--tools', '--approve', '--no-approve', 'json',
    ]),
  ]),
  kimi: profile('0.19.2', '0.32.0', [
    probe('kimi-stream', ['--help'], [
      '--output-format', '--auto', '--session', '--prompt', 'stream-json',
    ]),
    probe('kimi-acp', ['acp', '--help'], []),
  ]),
  mimo: profile('0.1.0', '0.1.9', [
    probe('mimo-run', ['run', '--help'], [
      '--pure', '--agent', '--format', '--dir', '--session', 'json',
    ]),
  ]),
  claude: profile('2.1.165', '2.1.221', [
    probe('claude-print', ['--help'], [
      '--print', '--output-format', '--include-partial-messages', '--verbose',
      '--permission-mode', '--resume', 'stream-json', 'plan', 'acceptEdits',
    ]),
  ]),
  gemini: exactProfile('0.53.1', [
    probe('gemini-stream', ['--help'], [
      '--output-format', '--approval-mode', '--resume', '--prompt', 'stream-json',
    ]),
  ]),
  opencode: profile('1.18.9', '1.18.12', [
    probe('opencode-run', ['run', '--help'], [
      '--format', '--agent', '--session', '--file', 'json',
    ]),
  ]),
  qwen: profile('0.10.0', '0.21.5', [
    probe('qwen-stream', ['--help'], [
      '--output-format', '--include-partial-messages', '--approval-mode',
      '--auth-type', '--model', '--resume', 'stream-json', 'plan', 'auto-edit',
    ]),
  ]),
  opencodereview: profile('1.8.4', '1.8.6', [
    probe('opencodereview-review', ['review', '--help'], [
      '--audience', '--format', '--repo', '--background', 'json', 'agent',
    ]),
  ]),
})

function probe(id, args, requiredText, validateOutput = null, timeout = null) {
  return Object.freeze({
    id,
    args: Object.freeze([...args]),
    requiredText: Object.freeze([...requiredText]),
    validateOutput,
    timeout,
  })
}

function profile(minVersion, maxVersion, probes, prereleaseVersions = []) {
  return Object.freeze({
    minVersion,
    maxVersion,
    supportedVersionRange: `${minVersion}..${maxVersion}`,
    probes: Object.freeze(probes),
    prereleaseVersions: Object.freeze([...prereleaseVersions]),
  })
}

function exactProfile(version, probes) {
  return Object.freeze({
    exactVersion: version,
    supportedVersionRange: version,
    probes: Object.freeze(probes),
  })
}

function extractAgentVersion(value) {
  const match = String(value || '').match(VERSION_PATTERN)
  if (!match) return ''
  return `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ''}`
}

function normalizedVersionLines(outputs) {
  return (Array.isArray(outputs) ? outputs : [outputs])
    .flatMap(output => String(output || '').replace(ANSI_PATTERN, '').split(/\r?\n/))
    .map(line => line.trim())
    .filter(Boolean)
}

function uniqueVersionCandidate(lines) {
  const candidates = lines
    .map(line => ({ line, resolvedVersion: extractAgentVersion(line) }))
    .filter(candidate => candidate.resolvedVersion)
  const versions = [...new Set(candidates.map(candidate => candidate.resolvedVersion))]
  return versions.length === 1
    ? candidates.find(candidate => candidate.resolvedVersion === versions[0])
    : null
}

function versionMatches(line) {
  const pattern = new RegExp(VERSION_PATTERN.source, 'g')
  return [...line.matchAll(pattern)].map((match) => ({
    index: match.index,
    end: match.index + match[0].length,
    resolvedVersion: extractAgentVersion(match[0]),
  }))
}

function identifiedVersionCandidate(kind, lines) {
  const identities = AGENT_VERSION_IDENTITIES[kind] || []
  const candidates = []
  for (const line of lines) {
    const identityMatches = identities.map(identity => identity.exec(line)).filter(Boolean)
    const versions = versionMatches(line)
    const weighted = []
    for (const identity of identityMatches) {
      const identityEnd = identity.index + identity[0].length
      for (const version of versions) {
        const distance = version.end <= identity.index
          ? identity.index - version.end
          : version.index >= identityEnd
            ? version.index - identityEnd
            : 0
        weighted.push({ ...version, distance })
      }
    }
    const closestDistance = Math.min(...weighted.map(candidate => candidate.distance))
    const closestVersions = [...new Set(weighted
      .filter(candidate => candidate.distance === closestDistance)
      .map(candidate => candidate.resolvedVersion))]
    if (closestVersions.length === 1) {
      candidates.push({ line, resolvedVersion: closestVersions[0] })
    }
  }
  const versions = [...new Set(candidates.map(candidate => candidate.resolvedVersion))]
  return versions.length === 1
    ? candidates.find(candidate => candidate.resolvedVersion === versions[0])
    : null
}

function executableIdentifiesAgent(kind, executable) {
  const basename = String(executable || '')
    .split(/[\\/]/).at(-1)?.replace(/\.(?:bat|cmd|com|exe)$/i, '').toLowerCase()
  return (AGENT_EXECUTABLE_NAMES[kind] || []).includes(basename)
}

function identifyAgentVersion(kind, outputs, options = {}) {
  const lines = normalizedVersionLines(outputs)
  const identified = identifiedVersionCandidate(kind, lines)
  if (identified) return identified

  if (!executableIdentifiesAgent(kind, options.executable)) return null
  return uniqueVersionCandidate(lines.filter(line => (
    new RegExp(`^v?${VERSION_PATTERN.source}$`, 'i').test(line)
  )))
}

function compareReleaseVersions(left, right) {
  const parse = (value) => {
    const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)$/)
    return match ? match.slice(1).map(Number) : null
  }
  const leftParts = parse(left)
  const rightParts = parse(right)
  if (!leftParts || !rightParts) return null
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index]
  }
  return 0
}

function assessAgentVersion(kind, rawVersion) {
  const contract = AGENT_COMPATIBILITY[kind]
  const resolvedVersion = extractAgentVersion(rawVersion)
  const base = {
    resolvedVersion,
    supportedVersionRange: contract?.supportedVersionRange || '',
  }
  if (!contract || !resolvedVersion) {
    return {
      ...base,
      compatibilityState: 'unknown',
      incompatibilityReason: '',
    }
  }
  const supported = contract.exactVersion
    ? resolvedVersion === contract.exactVersion
    : contract.prereleaseVersions.includes(resolvedVersion)
      || (!resolvedVersion.includes('-')
        && compareReleaseVersions(resolvedVersion, contract.minVersion) >= 0
        && compareReleaseVersions(resolvedVersion, contract.maxVersion) <= 0)
  return supported
    ? {
        ...base,
        compatibilityState: 'compatible',
        incompatibilityReason: '',
      }
    : {
        ...base,
        compatibilityState: 'incompatible',
        incompatibilityReason: 'LOCAL_AGENT_VERSION_UNSUPPORTED',
      }
}

function capabilityProbes(kind) {
  return AGENT_COMPATIBILITY[kind]?.probes || []
}

module.exports = {
  AGENT_COMPATIBILITY,
  assessAgentVersion,
  capabilityProbes,
  compareReleaseVersions,
  extractAgentVersion,
  identifyAgentVersion,
}

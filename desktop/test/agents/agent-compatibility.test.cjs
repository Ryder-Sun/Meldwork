const assert = require('node:assert/strict')
const test = require('node:test')

const {
  AGENT_COMPATIBILITY,
  assessAgentVersion,
  capabilityProbes,
  extractAgentVersion,
  identifyAgentVersion,
} = require('../../src/agents/agent-compatibility.cjs')

test('extracts connector versions from decorated CLI output', () => {
  assert.equal(extractAgentVersion('codex-cli 0.137.0'), '0.137.0')
  assert.equal(extractAgentVersion('codex-cli 0.146.0-alpha.9.2'), '0.146.0-alpha.9.2')
  assert.equal(extractAgentVersion('Hermes Agent v0.19.1 (2026.7.30)'), '0.19.1')
  assert.equal(extractAgentVersion('OpenClaw 2026.7.1-2 (0790d9f)'), '2026.7.1-2')
  assert.equal(extractAgentVersion('open-code-review v1.8.6 darwin/arm64'), '1.8.6')
  assert.equal(extractAgentVersion('Please log in'), '')
})

test('identifies product versions without selecting unrelated warnings', () => {
  assert.deepEqual(identifyAgentVersion('kimi', [
    '\u001b[33mWarning: Node.js 22.5.1 is experimental\u001b[0m',
    '\u001b[32mKimi Code 0.19.2\u001b[0m',
  ], { executable: '/tmp/kimi' }), {
    line: 'Kimi Code 0.19.2',
    resolvedVersion: '0.19.2',
  })
  assert.deepEqual(identifyAgentVersion('kimi', [
    'Warning: Node.js 22.5.1 is experimental',
    '0.19.2',
  ], { executable: '/tmp/kimi' }), {
    line: '0.19.2',
    resolvedVersion: '0.19.2',
  })
  assert.equal(identifyAgentVersion('kimi', [
    'Kimi Code 0.19.2',
    'Kimi Code 0.20.0',
  ], { executable: '/tmp/kimi' }), null)
  assert.equal(identifyAgentVersion('kimi', 'Node.js 22.5.1', {
    executable: '/tmp/kimi',
  }), null)
  assert.deepEqual(identifyAgentVersion(
    'kimi',
    'Warning: Node.js 22.5.1 could not initialize Kimi Code 0.19.2',
    { executable: '/tmp/kimi' },
  ), {
    line: 'Warning: Node.js 22.5.1 could not initialize Kimi Code 0.19.2',
    resolvedVersion: '0.19.2',
  })
  assert.equal(identifyAgentVersion('kimi', '0.19.2', {
    executable: '/tmp/not-kimi',
  }), null)
})

test('keeps unidentified versions distinct from verified incompatibility', () => {
  assert.deepEqual(assessAgentVersion('kimi', ''), {
    resolvedVersion: '',
    supportedVersionRange: '0.19.2..0.32.0',
    compatibilityState: 'unknown',
    incompatibilityReason: '',
  })
})

test('accepts the verified Pi Agent release', () => {
  assert.deepEqual(assessAgentVersion('pi', '0.84.2'), {
    resolvedVersion: '0.84.2',
    supportedVersionRange: '0.84.2',
    compatibilityState: 'compatible',
    incompatibilityReason: '',
  })
})

test('accepts inclusive release ranges and rejects unvalidated versions', () => {
  for (const [kind, contract] of Object.entries(AGENT_COMPATIBILITY)) {
    const supported = contract.exactVersion
      ? [contract.exactVersion]
      : [contract.minVersion, contract.maxVersion, ...contract.prereleaseVersions]
    for (const version of supported) {
      assert.equal(assessAgentVersion(kind, version).compatibilityState, 'compatible', kind)
    }
  }

  for (const [kind, version] of [
    ['codex', '0.136.9'],
    ['codex', '0.146.1'],
    ['codex', '0.146.0-alpha.9.3'],
    ['hermes', '0.19.1-beta.1'],
    ['openclaw', '2026.7.1'],
    ['pi', '0.2.0'],
    ['gemini', '0.53.2'],
    ['opencodereview', '1.8.7'],
  ]) {
    assert.deepEqual(assessAgentVersion(kind, version), {
      resolvedVersion: version,
      supportedVersionRange: AGENT_COMPATIBILITY[kind].supportedVersionRange,
      compatibilityState: 'incompatible',
      incompatibilityReason: 'LOCAL_AGENT_VERSION_UNSUPPORTED',
    })
  }
})

test('defines required capability probes for every supported connector', () => {
  assert.deepEqual(Object.keys(AGENT_COMPATIBILITY).sort(), [
    'claude', 'codex', 'gemini', 'hermes', 'kimi', 'mimo', 'openclaw', 'pi',
    'opencode', 'opencodereview', 'qwen', 'workbuddy', 'zcode',
  ].sort())
  for (const kind of Object.keys(AGENT_COMPATIBILITY)) {
    assert.ok(capabilityProbes(kind).length > 0, kind)
  }
  assert.deepEqual(capabilityProbes('kimi').map(item => item.id), [
    'kimi-stream', 'kimi-acp',
  ])
  assert.ok(capabilityProbes('codex')[0].requiredText.includes('--json'))
  assert.equal(capabilityProbes('hermes')[0].requiredText.includes('--skills'), false)
  assert.ok(capabilityProbes('opencodereview')[0].requiredText.includes('--background'))
})

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  boundedBackoffDelay,
  normalizeAttemptHistory,
  normalizeAttemptHistoryEntry,
  normalizeFailure,
  normalizeFailureOutcome,
  parseRetryAfter,
  retryDecision,
} = require('../../src/runs/failure-policy.cjs')

test('normalizes only bounded structured attempt history without raw failure details', () => {
  const entry = normalizeAttemptHistoryEntry({
    sequence: 1,
    agentKind: 'hermes',
    phase: 'automatic_retry',
    attempt: 2,
    failureCategory: 'authentication',
    policyAction: 'retry',
    backoffMs: 500,
    recoveryAgentKind: 'codex',
    finalOutcome: 'failed',
    timestamp: 1000,
    error: 'Authorization: Bearer private-token',
    command: 'cat /Users/private/config',
  })

  assert.deepEqual(entry, {
    sequence: 1,
    agentKind: 'hermes',
    phase: 'automatic_retry',
    attempt: 2,
    failureCategory: 'authentication',
    policyAction: 'retry',
    backoffMs: 500,
    recoveryAgentKind: 'codex',
    finalOutcome: 'failed',
    timestamp: 1000,
  })
  assert.deepEqual(normalizeAttemptHistory([entry]), [entry])
  assert.equal(normalizeAttemptHistory([{ ...entry, phase: 'unknown' }]), null)
  assert.equal(normalizeAttemptHistory([entry, { ...entry, sequence: 1 }]), null)
})

test('classifies authentication and compatibility failures without generic retries', () => {
  const authentication = normalizeFailure(
    Object.assign(new Error('provider rejected request'), { statusCode: 401 }),
  )
  assert.deepEqual(authentication, {
    code: 'LOCAL_AGENT_UNKNOWN_FAILURE',
    category: 'authentication',
    retryability: 'never',
    httpStatus: 401,
    retryAfterMs: null,
    fingerprint: 'authentication:LOCAL_AGENT_UNKNOWN_FAILURE:401',
  })
  assert.equal(retryDecision(authentication).action, 'fail')

  const mislabeledAuthentication = normalizeFailure({
    status: 403,
    failure: { code: 'LOCAL_AGENT_AUTH_REQUIRED', retryable: true },
  })
  assert.equal(mislabeledAuthentication.retryability, 'never')
  assert.equal(retryDecision(mislabeledAuthentication).action, 'fail')

  const compatibility = normalizeFailure(
    Object.assign(new Error('unsupported'), { code: 'LOCAL_AGENT_PROTOCOL_UNAVAILABLE' }),
  )
  assert.equal(compatibility.category, 'compatibility')
  assert.equal(retryDecision(compatibility).action, 'fail')
})

test('bounds Session refresh to one fresh attempt', () => {
  const failure = normalizeFailure(Object.assign(
    new Error('LOCAL_AGENT_SESSION_INVALID'),
    { code: 'LOCAL_AGENT_SESSION_INVALID' },
  ))

  assert.equal(retryDecision(failure, { attempt: 1 }).action, 'refresh_session')
  assert.deepEqual(
    retryDecision(failure, { attempt: 2 }),
    {
      failure,
      attempt: 2,
      maxAttempts: 2,
      delayMs: 0,
      action: 'fail',
      exhausted: true,
    },
  )
})

test('parses Retry-After seconds and dates against an injected clock', () => {
  const now = Date.parse('2026-08-04T00:00:00.000Z')
  assert.equal(parseRetryAfter('2.5', now), 2500)
  assert.equal(parseRetryAfter('Tue, 04 Aug 2026 00:00:04 GMT', now), 4000)
  assert.equal(parseRetryAfter('invalid', now), null)
})

test('uses injectable jitter while keeping backoff and Retry-After bounded', () => {
  const jitterCalls = []
  const delay = boundedBackoffDelay(2, {
    baseDelayMs: 100,
    maxDelayMs: 500,
    jitter: (raw, context) => {
      jitterCalls.push({ raw, context })
      return raw + 25
    },
  })
  assert.equal(delay, 225)
  assert.deepEqual(jitterCalls, [{
    raw: 200,
    context: { attempt: 2, baseDelayMs: 100, maxDelayMs: 500 },
  }])

  const fakeNow = Date.parse('2026-08-04T00:00:00.000Z')
  const limited = normalizeFailure({
    status: 429,
    response: { headers: { 'Retry-After': '3' } },
  }, { now: () => fakeNow })
  assert.equal(limited.category, 'rate_limit')
  // Provider throttling honors Retry-After beyond the generic process-retry
  // cap, bounded by the rate-limit cap (60 s by default).
  assert.equal(retryDecision(limited, {
    attempt: 1,
    maxAttempts: 4,
    baseDelayMs: 250,
    maxDelayMs: 2000,
    jitter: raw => raw / 2,
  }).delayMs, 3000)
  const slow = normalizeFailure({
    status: 429,
    response: { headers: { 'Retry-After': '120' } },
  }, { now: () => fakeNow })
  assert.equal(retryDecision(slow, { attempt: 1, maxDelayMs: 2000 }).delayMs, 60000)
  assert.equal(retryDecision(slow, {
    attempt: 1, maxDelayMs: 2000, rateLimitMaxDelayMs: 5000,
  }).delayMs, 5000)
  const unhinted = normalizeFailure({ status: 429 }, { now: () => fakeNow })
  assert.equal(retryDecision(unhinted, {
    attempt: 1, baseDelayMs: 250, maxDelayMs: 2000, rateLimitMinDelayMs: 1500,
  }).delayMs, 1500)
})

test('retries only transient categories and stops at the total attempt bound', () => {
  const network = normalizeFailure(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
  assert.equal(network.category, 'network')
  assert.deepEqual(retryDecision(network, {
    attempt: 1, maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100,
  }), {
    failure: network,
    attempt: 1,
    maxAttempts: 3,
    delayMs: 10,
    action: 'retry',
    exhausted: false,
  })
  assert.equal(retryDecision(network, { attempt: 3, maxAttempts: 3 }).action, 'fail')

  const provider = normalizeFailure({ status: 503, headers: { 'retry-after': '1' } })
  assert.equal(provider.category, 'provider')
  assert.equal(retryDecision(provider, { attempt: 1, maxDelayMs: 5000 }).delayMs, 1000)

  const cancelled = normalizeFailure(Object.assign(
    new Error('cancelled'), { code: 'LOCAL_AGENT_EXECUTION_STOPPED' },
  ))
  assert.equal(cancelled.category, 'cancellation')
  assert.equal(retryDecision(cancelled).action, 'fail')
})

test('retries recoverable Agent protocol failures before the total attempt bound', () => {
  for (const code of [
    'LOCAL_RUN_COLLABORATION_RECEIPT_INVALID',
    'LOCAL_AGENT_EMPTY_RESPONSE',
    'LOCAL_AGENT_PROCESS_FAILED',
    'LOCAL_AGENT_EXITED',
  ]) {
    const failure = normalizeFailure(Object.assign(new Error(code), { code }))
    assert.equal(failure.category, 'protocol')
    assert.equal(failure.retryability, 'retry')
    assert.equal(retryDecision(failure, { attempt: 1, maxAttempts: 4 }).action, 'retry')
    assert.equal(retryDecision(failure, { attempt: 4, maxAttempts: 4 }).action, 'fail')
  }
})

test('retries a bounded Agent timeout while preserving the write-safety gate', () => {
  const timeout = normalizeFailure(Object.assign(
    new Error('LOCAL_AGENT_TIMEOUT'), { code: 'LOCAL_AGENT_TIMEOUT' },
  ))
  assert.equal(timeout.category, 'timeout')
  assert.equal(timeout.retryability, 'retry')
  assert.equal(retryDecision(timeout, { attempt: 1, maxAttempts: 4 }).action, 'retry')
  assert.equal(retryDecision(timeout, {
    attempt: 1,
    maxAttempts: 4,
    safety: { sideEffectsPossible: true, idempotencyMode: 'none' },
  }).action, 'human_gate')
})

test('requires approval before retrying side-effectful ambiguous failures', () => {
  const error = Object.assign(new Error('socket reset after dispatch'), {
    code: 'ECONNRESET',
    invocationFailure: {
      outcomeCertainty: 'unknown_outcome',
      sideEffectsPossible: true,
      operationId: `agent-operation-${'a'.repeat(64)}`,
      idempotencyMode: 'none',
    },
  })
  const failure = normalizeFailure(error)
  const safety = normalizeFailureOutcome(error)

  assert.deepEqual(safety, {
    outcomeCertainty: 'unknown_outcome',
    sideEffectsPossible: true,
    operationId: `agent-operation-${'a'.repeat(64)}`,
    idempotencyMode: 'none',
  })
  assert.equal(retryDecision(failure, { safety }).action, 'human_gate')
  assert.equal(retryDecision(failure, {
    safety: { ...safety, idempotencyMode: 'durable' },
  }).action, 'retry')
  assert.equal(retryDecision(failure, {
    safety: { ...safety, outcomeCertainty: 'not_started', sideEffectsPossible: false },
  }).action, 'retry')
})

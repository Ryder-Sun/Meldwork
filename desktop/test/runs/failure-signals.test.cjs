const test = require('node:test')
const assert = require('node:assert/strict')
const {
  authFailureCertainty,
  isContextOverflow,
  isNetworkFailure,
  isProviderUnavailable,
  isRateLimited,
  retryAfterFromText,
} = require('../../src/runs/failure-signals.cjs')

test('explicit sign-in and API key statements are definitive authentication failures', () => {
  for (const text of [
    'Please log in first',
    'Error: Not logged in · Please run /login',
    'Invalid API key · Please run /login',
    '[ERROR] expired access token',
    'OAuth token has expired. Please obtain a new token.',
    'HTTP 401: Unauthorized',
    'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    'Incorrect API key provided: sk-***',
    'select an auth type',
    'Provider rejected sk-redacted',
    '请先登录',
    '认证失败，请检查密钥',
  ]) {
    assert.equal(authFailureCertainty(text), 'definitive', text)
  }
})

test('refusals that do not prove missing credentials are only ambiguous', () => {
  for (const text of [
    'HTTP 403: Forbidden',
    'API Error: 403 {"type":"error","error":{"type":"permission_error"}}',
    '403 Forbidden',
    'Error: Unauthorized',
  ]) {
    assert.equal(authFailureCertainty(text), 'ambiguous', text)
  }
})

test('unrelated diagnostics never look like authentication failures', () => {
  for (const text of [
    '',
    'thread \'main\' panicked at src/session.rs: invalid utf-8',
    'SyntaxError: Unexpected token } in JSON at position 4',
    'Compiled 12 files; login page renders correctly',
    'socket hang up',
    'Failed to download documentation: HTTP 403 Forbidden',
    'request failed: unauthorized resource in fixture',
  ]) {
    assert.equal(authFailureCertainty(text), '', text)
  }
})

test('transient provider conditions are recognized from CLI text', () => {
  assert.equal(isRateLimited('Error: 429 Too Many Requests'), true)
  assert.equal(isRateLimited('{"type":"overloaded_error"}'), true)
  assert.equal(isRateLimited('Rate limit reached for gpt-5 in organization'), true)
  assert.equal(isRateLimited('All 12 tests passed'), false)
  assert.equal(isNetworkFailure('fetch failed: getaddrinfo ENOTFOUND api.example.com'), true)
  assert.equal(isNetworkFailure('read ECONNRESET'), true)
  assert.equal(isNetworkFailure('Wrote network.md'), false)
  assert.equal(isProviderUnavailable('HTTP 503: Service Unavailable'), true)
  assert.equal(isProviderUnavailable('{"type":"error","error":{"type":"api_error"}}'), true)
  assert.equal(isProviderUnavailable('Processed 500 records'), false)
})

test('context overflow is detected across provider wordings', () => {
  for (const text of [
    'Prompt is too long: 210000 tokens > 200000 maximum',
    'This model\'s maximum context length is 128000 tokens',
    'context_length_exceeded',
    'Input is too long for requested model.',
  ]) {
    assert.equal(isContextOverflow(text), true, text)
  }
  assert.equal(isContextOverflow('The context of this change is the login flow'), false)
})

test('retry hints in CLI text become bounded delays', () => {
  assert.equal(retryAfterFromText('429 Too Many Requests; retry after 20s'), 20000)
  assert.equal(retryAfterFromText('Rate limited. Please try again in 1.5 seconds.'), 1500)
  assert.equal(retryAfterFromText('retry-after: 750ms'), 750)
  assert.equal(retryAfterFromText('quota resets in 2 minutes'), 120000)
  assert.equal(retryAfterFromText('try again in 90 minutes'), 300000)
  assert.equal(retryAfterFromText('no hint here'), null)
})

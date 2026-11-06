const test = require('node:test')
const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { networkEnvironment } = require('../../../src/agents/cli/cli-network-environment.cjs')
const { systemChildEnvironment } = require('../../../src/agents/cli/cli-discovery.cjs')
const { childEnvironment } = require('../../../src/agents/cli/cli-process-support.cjs')
const { resolveNativeShellEnvironment, resolveNativeCredentialState } = require('../../../src/agents/local-agent-readiness.cjs')
const { redactChildSecrets, createRuntimeEventEmitter } = require('../../../src/agents/cli/cli-runtime-event-sanitizer.cjs')

test('network configuration preserves POSIX proxy case and explicit empty overrides without runtime injection', () => {
  const source = {
    HTTP_PROXY: 'http://upper.example:8080', http_proxy: 'http://lower.example:8081',
    HTTPS_PROXY: '', NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: '',
    NODE_EXTRA_CA_CERTS: '/certs/company.pem', REQUESTS_CA_BUNDLE: '/certs/python.pem',
    NODE_USE_ENV_PROXY: '1', NODE_OPTIONS: '--require=/untrusted.cjs',
    NODE_TLS_REJECT_UNAUTHORIZED: '0', OPENAI_API_KEY: 'unrelated-secret',
  }
  const expected = { ...source }
  for (const key of ['NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'OPENAI_API_KEY']) delete expected[key]
  assert.deepEqual(networkEnvironment(source, 'darwin'), expected)
  const child = systemChildEnvironment(source, 'darwin')
  for (const [key, value] of Object.entries(expected)) assert.equal(child[key], value)
  assert.equal(child.NODE_OPTIONS, undefined)
  assert.equal(child.NODE_TLS_REJECT_UNAUTHORIZED, undefined)
  assert.equal(child.OPENAI_API_KEY, undefined)
  assert.deepEqual(networkEnvironment({ Https_Proxy: 'http://windows.example:8080' }, 'win32'), {
    HTTPS_PROXY: 'http://windows.example:8080',
  })
})

test('login shell proxy and CA settings survive credential probes and actual child construction', { skip: process.platform === 'win32' }, async () => {
  const source = {
    PATH: '/usr/bin:/bin', HTTPS_PROXY: 'http://inherited.example:8080',
    http_proxy: 'http://shell.example:3128', NO_PROXY: 'localhost,127.0.0.1',
    NODE_EXTRA_CA_CERTS: '/certs/trusted.pem',
  }
  const shell = await resolveNativeShellEnvironment({
    cache: false, platform: 'linux', shell: '/bin/sh', home: '/tmp/meldwork-network-test', env: source,
    execFileFn: async (_file, args, options) => {
      assert.equal(options.env.http_proxy, source.http_proxy)
      return promisify(execFile)('/bin/sh', ['-c', `HTTPS_PROXY=''; export HTTPS_PROXY\n${args[1]}`], {
        env: { ...options.env, NODE_OPTIONS: 'must-not-be-returned' },
      })
    },
  })
  assert.equal(shell.env.HTTPS_PROXY, '')
  assert.equal(shell.env.NODE_OPTIONS, undefined)
  for (const key of ['http_proxy', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS']) assert.equal(shell.env[key], source[key])
  let probed = false
  await resolveNativeCredentialState('claude', {
    executable: '/tmp/claude-network-test', home: '/tmp/meldwork-network-test', env: shell.env,
    execFileFn: async (_file, _args, options) => {
      probed = true
      assert.equal(options.env.http_proxy, source.http_proxy)
      assert.equal(options.env.HTTPS_PROXY, '')
      return { stdout: '{"loggedIn":true}', stderr: '' }
    },
  })
  assert.equal(probed, true)
  const env = childEnvironment({ kind: 'claude' }, '/tmp/workspace', {
    env: networkEnvironment(shell.env), sandbox: 'read-only',
  }, 'linux')
  assert.equal(env.http_proxy, source.http_proxy)
  assert.equal(env.HTTPS_PROXY, '')
  assert.equal(env.NODE_EXTRA_CA_CERTS, source.NODE_EXTRA_CA_CERTS)
})

test('shell-unset network and XDG values do not reappear in Agent children', t => {
  const oldProxy = process.env.HTTPS_PROXY
  const oldConfig = process.env.XDG_CONFIG_HOME
  process.env.HTTPS_PROXY = 'http://stale.example:8080'
  process.env.XDG_CONFIG_HOME = '/stale/config'
  t.after(() => {
    if (oldProxy === undefined) delete process.env.HTTPS_PROXY
    else process.env.HTTPS_PROXY = oldProxy
    if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = oldConfig
  })
  const options = { env: {}, nativeUnsetKeys: ['HTTPS_PROXY', 'XDG_CONFIG_HOME'] }
  const child = childEnvironment({ kind: 'claude' }, '/tmp/workspace', options, 'linux')
  assert.equal(child.HTTPS_PROXY, undefined)
  assert.equal(child.XDG_CONFIG_HOME, undefined)
  const overridden = childEnvironment({ kind: 'claude' }, '/tmp/workspace', {
    ...options, env: { HTTPS_PROXY: 'http://chosen.example', XDG_CONFIG_HOME: '/chosen/config' },
  }, 'linux')
  assert.equal(overridden.HTTPS_PROXY, 'http://chosen.example')
  assert.equal(overridden.XDG_CONFIG_HOME, '/chosen/config')
})

test('proxy credentials are redacted in diagnostics and across every streamed split', () => {
  const proxy = 'http://proxy-user:proxy%40password@proxy.example:3128'
  const env = { https_proxy: proxy }
  const values = [proxy, 'proxy-user:proxy%40password', 'proxy-user:proxy@password',
    'proxy%40password', 'proxy@password', Buffer.from('proxy-user:proxy@password').toString('base64')]
  for (const value of values) {
    assert.equal(redactChildSecrets(`Connection failed: ${value}`, env), 'Connection failed: [redacted]')
    for (let split = 1; split < value.length; split += 1) {
      const emitted = []
      const events = createRuntimeEventEmitter({ onEvent: event => emitted.push(event) }, env)
      events.emit({ type: 'answer_delta', status: 'running', delta: `Connection failed: ${value.slice(0, split)}` })
      events.emit({ type: 'answer_delta', status: 'running', delta: `${value.slice(split)}. Retry later.` })
      events.emitFinalAnswer(`Connection failed: ${value}. Retry later.`)
      const delivered = emitted.filter(event => event.type === 'answer_delta').map(event => event.delta).join('')
      assert.equal(delivered.includes(value), false, `split ${split}`)
      assert.match(delivered, /\[redacted\]/)
    }
  }
  assert.equal(redactChildSecrets('https://public.example', { HTTPS_PROXY: 'https://public.example' }), 'https://public.example')
  assert.equal(redactChildSecrets('Bad proxy: user:private-password@', { HTTP_PROXY: 'user:private-password@' }), 'Bad proxy: [redacted]')
})

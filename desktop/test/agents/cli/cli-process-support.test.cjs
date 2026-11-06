const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')

const { childEnvironment, failedAgentProcessError, terminateWindowsProcessTree } = require('../../../src/agents/cli/cli-process-support.cjs')
const { redactChildSecrets } = require('../../../src/agents/cli/cli-runtime-event-sanitizer.cjs')
const { nativeOpenClawOptions } = require('../../../src/agents/cli/openclaw-runtime.cjs')
const { workBuddyInstall } = require('../../support/cli-adapters-test-helpers.cjs')

test('Windows termination requires successful taskkill and observed child exit', async () => {
  const child = new EventEmitter()
  child.pid = 4321
  const killer = new EventEmitter()
  killer.unref = () => {}
  let settled = false
  const promise = terminateWindowsProcessTree(child, (command, args) => {
    assert.equal(command, 'taskkill.exe')
    assert.deepEqual(args, ['/PID', '4321', '/T', '/F'])
    return killer
  }, 1000).then(() => { settled = true })
  killer.emit('close', 0)
  await Promise.resolve()
  assert.equal(settled, false)
  child.emit('close', 1, 'SIGTERM')
  await promise
  assert.equal(settled, true)
})

test('Windows termination reports spawn errors, nonzero exits and timeouts', async () => {
  for (const mode of ['throw', 'error', 'nonzero', 'alive', 'timeout']) {
    const child = new EventEmitter()
    child.pid = 4321
    const killer = new EventEmitter()
    killer.unref = () => {}
    const promise = terminateWindowsProcessTree(child, () => {
      if (mode === 'throw') throw new Error('spawn failed')
      return killer
    }, 20)
    if (mode === 'error') killer.emit('error', new Error('spawn failed'))
    if (mode === 'nonzero') killer.emit('close', 1)
    if (mode === 'alive') killer.emit('close', 0)
    await assert.rejects(promise, { message: 'LOCAL_AGENT_TERMINATION_FAILED' }, mode)
  }
})

test('a refused Hermes resume policy rebuilds the session before executing work', () => {
  const detail = "Resume retains gateway session policy; creation overrides are unsupported on resume. --yolo differs from this session's launch: resume without it and use /yolo after resuming to switch."
  const error = failedAgentProcessError(detail, { kind: 'hermes', sessionRef: 'existing-session' })
  assert.equal(error.code, 'LOCAL_AGENT_SESSION_INVALID')
  assert.equal(error.failure.sessionInvalid, true)
  assert.equal(failedAgentProcessError(detail, { kind: 'hermes' }).code, 'LOCAL_AGENT_PROCESS_FAILED')
  assert.equal(failedAgentProcessError('An unrelated tool failed while running.', { kind: 'hermes', sessionRef: 'existing-session' }).code, 'LOCAL_AGENT_PROCESS_FAILED')
})

test('MiMo and OpenCode cannot wait for terminal-only plan or question dialogs', () => {
  for (const kind of ['mimo', 'opencode']) {
    for (const sandbox of ['read-only', 'workspace-write']) {
      const env = childEnvironment({ kind }, '/tmp', { sandbox }, 'darwin')
      const permissions = JSON.parse(env[kind === 'mimo' ? 'MIMOCODE_PERMISSION' : 'OPENCODE_PERMISSION'])
      assert.equal(permissions.plan_exit, 'deny')
      assert.equal(permissions.plan_enter, 'deny')
      assert.equal(permissions.question, 'deny')
      if (kind === 'opencode' && sandbox === 'read-only') {
        assert.equal(permissions['*'], 'deny')
        assert.equal(permissions.read, 'allow')
        assert.equal(permissions.webfetch, 'allow')
      } else assert.equal(permissions['*'], undefined)
    }
  }
})

function openClawChildEnvRuntime(directory, workdir) {
  return nativeOpenClawOptions({
    storageRoot: directory,
    workdir,
    sessionRef: 'agent:main:child-env',
    runtime: {
      model: 'native/model',
      provider: {
        id: 'native',
        baseUrl: 'https://native.example.com/v1',
        api: 'openai-completions',
        apiKey: 'selected-openclaw-key',
        model: { id: 'model', name: 'Native Model', input: ['text'] },
      },
    },
  })
}

test('local Agent child environments keep supported runtime settings but reject process injection', () => {
  const env = childEnvironment(
    { kind: 'pi' }, '/tmp/workspace', {
      env: {
        OPENAI_BASE_URL: 'https://provider.example/v1',
        HTTPS_PROXY: 'http://proxy.example:3128',
        GITHUB_TOKEN: 'unrelated-secret',
        NODE_OPTIONS: '--require=/tmp/injected.js',
        DYLD_INSERT_LIBRARIES: '/tmp/injected.dylib',
      },
    }, 'darwin',
  )
  assert.equal(env.OPENAI_BASE_URL, 'https://provider.example/v1')
  assert.equal(env.HTTPS_PROXY, 'http://proxy.example:3128')
  assert.equal(Object.hasOwn(env, 'GITHUB_TOKEN'), false)
  assert.equal(Object.hasOwn(env, 'NODE_OPTIONS'), false)
  assert.equal(Object.hasOwn(env, 'DYLD_INSERT_LIBRARIES'), false)
})

test('Pi receives and redacts credentials declared in native models configuration', () => {
  const env = childEnvironment({ kind: 'pi' }, '/tmp/workspace', {
    env: { CUSTOM_PROVIDER_TOKEN: 'synthetic-private-value', UNRELATED_TOKEN: 'not-shared' },
    nativeCredentialKeys: ['CUSTOM_PROVIDER_TOKEN'],
  }, 'darwin')
  assert.equal(env.CUSTOM_PROVIDER_TOKEN, 'synthetic-private-value')
  assert.equal(env.UNRELATED_TOKEN, undefined)
  assert.doesNotMatch(redactChildSecrets('failure synthetic-private-value', env), /synthetic-private-value/)
})

test('a single Agent retains and redacts more than 32 declared credentials', () => {
  const keys = Array.from({ length: 40 }, (_, index) => `DECLARED_${index}`)
  const source = Object.fromEntries(keys.map(key => [key, `synthetic-value-${key}`]))
  const env = childEnvironment({ kind: 'pi' }, '/tmp/workspace', {
    env: source, nativeCredentialKeys: keys,
  }, 'darwin')
  assert.equal(env.DECLARED_39, 'synthetic-value-DECLARED_39')
  assert.doesNotMatch(redactChildSecrets('synthetic-value-DECLARED_39', env), /synthetic-value-DECLARED_39/)
})

test('OpenCode receives and redacts credentials declared by native provider configuration', () => {
  const env = childEnvironment({ kind: 'opencode' }, '/tmp/workspace', {
    env: { CUSTOM_PROVIDER_TOKEN: 'synthetic-private-value', UNRELATED_TOKEN: 'not-shared' },
    nativeCredentialKeys: ['CUSTOM_PROVIDER_TOKEN'],
  }, 'darwin')
  assert.equal(env.CUSTOM_PROVIDER_TOKEN, 'synthetic-private-value')
  assert.equal(env.UNRELATED_TOKEN, undefined)
  assert.doesNotMatch(redactChildSecrets('synthetic-private-value', env), /synthetic-private-value/)
})

test('native Agent child environments preserve shell-selected XDG directories', () => {
  const env = childEnvironment({ kind: 'opencode' }, '/tmp/workspace', {
    env: { XDG_CONFIG_HOME: '/native/config', XDG_DATA_HOME: '/native/data',
      XDG_RUNTIME_DIR: '', XDG_UNRELATED: 'ignored' },
  }, 'darwin')
  assert.equal(env.XDG_CONFIG_HOME, '/native/config')
  assert.equal(env.XDG_DATA_HOME, '/native/data')
  assert.equal(env.XDG_RUNTIME_DIR, '')
  assert.equal(env.XDG_UNRELATED, undefined)
})

test('Agent processes do not inherit another Agent native configuration directory', (t) => {
  const keys = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  })
  Object.assign(process.env, { CODEX_HOME: '/native/codex', CLAUDE_CONFIG_DIR: '/native/claude', PI_CODING_AGENT_DIR: '/native/pi' })
  const env = childEnvironment({ kind: 'codex' }, '/tmp/workspace', { env: { CODEX_HOME: '/selected/codex' } }, 'darwin')
  assert.equal(env.CODEX_HOME, '/selected/codex')
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined)
  assert.equal(env.PI_CODING_AGENT_DIR, undefined)
  const isolated = childEnvironment({ kind: 'codex' }, '/tmp/workspace', { env: {} }, 'darwin')
  for (const key of keys) assert.equal(isolated[key], undefined)
})

test('Pi child environment receives native cloud configuration without process injection', () => {
  const source = {
    AWS_PROFILE: 'native-profile', AZURE_OPENAI_API_KEY: 'synthetic-azure',
    GOOGLE_APPLICATION_CREDENTIALS: '/tmp/adc.json', GITHUB_TOKEN: 'unrelated',
    NODE_OPTIONS: '--require=/tmp/injected.js',
  }
  const env = childEnvironment({ kind: 'pi' }, '/tmp/workspace', { env: source }, 'darwin')
  assert.equal(env.AWS_PROFILE, source.AWS_PROFILE)
  assert.equal(env.AZURE_OPENAI_API_KEY, source.AZURE_OPENAI_API_KEY)
  assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, source.GOOGLE_APPLICATION_CREDENTIALS)
  assert.equal(env.GITHUB_TOKEN, undefined)
  assert.equal(env.NODE_OPTIONS, undefined)
})

test('WorkBuddy runs load the lite bundle only when that is all the install ships', (t) => {
  const liteOnly = workBuddyInstall(t, ['codebuddy-lite-wb.mjs'])
  const withHeadless = workBuddyInstall(t, ['codebuddy-lite-wb.mjs', 'codebuddy-headless.js'])
  const environmentFor = (kind, executable) => childEnvironment(
    { kind, executable }, '/tmp/workspace', { env: {} }, process.platform,
  )

  assert.equal(environmentFor('workbuddy', liteOnly).CODEBUDDY_FORCE_LITE_WB_BUNDLE, '1')
  assert.equal(Object.hasOwn(environmentFor('workbuddy', withHeadless), 'CODEBUDDY_FORCE_LITE_WB_BUNDLE'), false)
  assert.equal(Object.hasOwn(environmentFor('claude', liteOnly), 'CODEBUDDY_FORCE_LITE_WB_BUNDLE'), false)
})

test('process diagnostics require explicit authentication failure evidence', () => {
  for (const diagnostic of [
    'EACCES: permission denied opening auth-service.ts',
    'Cannot find module credential-parser',
    'Model configuration failed: connection timed out',
    'Failed to download documentation: HTTP 403 Forbidden',
  ]) {
    assert.equal(failedAgentProcessError(diagnostic).code, 'LOCAL_AGENT_PROCESS_FAILED')
  }
  for (const diagnostic of [
    'Invalid API key',
    'Authentication failed',
    'Please log in before continuing',
    'Select an auth type first.',
    'HTTP 401: Unauthorized',
    '认证失败，请重新登录',
  ]) {
    assert.equal(failedAgentProcessError(diagnostic).code, 'LOCAL_AGENT_AUTH_REQUIRED')
  }
})

test('OpenClaw child environment keeps only its guarded runtime and selected credential', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-openclaw-child-env-'))
  const workdir = path.join(directory, 'workspace')
  fs.mkdirSync(workdir)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const previous = {}
  for (const key of ['GITHUB_TOKEN', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'APPDATA', 'LOCALAPPDATA']) {
    previous[key] = process.env[key]
  }
  process.env.GITHUB_TOKEN = 'ambient-secret'
  process.env.XDG_CONFIG_HOME = '/tmp/native-config'
  process.env.XDG_DATA_HOME = '/tmp/native-data'
  process.env.APPDATA = '/tmp/native-appdata'
  process.env.LOCALAPPDATA = '/tmp/native-localappdata'
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
  })

  const runtime = openClawChildEnvRuntime(directory, workdir)
  const env = childEnvironment(
    { kind: 'openclaw' },
    workdir,
    {
      ...runtime,
      env: {
        ...runtime.env,
        https_proxy: 'http://proxy.example:3128',
        NO_PROXY: 'localhost,127.0.0.1,::1',
        NODE_EXTRA_CA_CERTS: '/certs/company.pem',
        MELDWORK_OPENCLAW_API_KEY: 'legacy-openclaw-key',
        GITHUB_TOKEN: 'caller-secret',
        ANTHROPIC_API_KEY: 'caller-anthropic-secret',
        XDG_CONFIG_HOME: '/tmp/caller-config',
      },
    },
    process.platform,
  )

  assert.equal(env.MELDWORK_OPENCLAW_NATIVE_API_KEY, 'selected-openclaw-key')
  assert.equal(env.https_proxy, 'http://proxy.example:3128')
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1')
  assert.equal(env.NODE_EXTRA_CA_CERTS, '/certs/company.pem')
  assert.equal(env.OPENCLAW_GATEWAY_TOKEN, runtime.env.OPENCLAW_GATEWAY_TOKEN)
  assert.equal(env.OPENCLAW_DISABLE_BONJOUR, '1')
  assert.equal(Object.hasOwn(env, 'MELDWORK_OPENCLAW_API_KEY'), false)
  assert.equal(Object.hasOwn(env, 'GITHUB_TOKEN'), false)
  assert.equal(Object.hasOwn(env, 'ANTHROPIC_API_KEY'), false)
  assert.equal(env.OPENCLAW_WORKSPACE_DIR, workdir)
  assert.equal(env.HOME, runtime.env.OPENCLAW_HOME)
  assert.equal(env.USERPROFILE, runtime.env.OPENCLAW_HOME)
  assert.ok(env.XDG_CONFIG_HOME.startsWith(runtime.env.OPENCLAW_HOME))
  assert.ok(env.XDG_DATA_HOME.startsWith(runtime.env.OPENCLAW_HOME))
  assert.ok(env.XDG_STATE_HOME.startsWith(runtime.env.OPENCLAW_HOME))
  assert.ok(env.XDG_CACHE_HOME.startsWith(runtime.env.OPENCLAW_HOME))
  assert.ok(env.TMPDIR.startsWith(runtime.env.OPENCLAW_HOME))
  assert.equal(env.TMP, env.TMPDIR)
  assert.equal(env.TEMP, env.TMPDIR)
  assert.equal(env.OPENCLAW_DISABLE_BONJOUR, '1')
  assert.notEqual(env.XDG_CONFIG_HOME, '/tmp/native-config')
  assert.notEqual(env.APPDATA, '/tmp/native-appdata')
  assert.notEqual(env.LOCALAPPDATA, '/tmp/native-localappdata')
})

test('every OpenClaw child requires an app-owned runtime guard', () => {
  assert.throws(() => childEnvironment(
    { kind: 'openclaw' },
    '/tmp/workspace',
    {},
    process.platform,
  ), { message: 'OPENCLAW_RUNTIME_GUARD_REQUIRED' })
})

test('native Agent children preserve the discovered shell PATH without ambient secrets', () => {
  const env = childEnvironment(
    { kind: 'codex' },
    '/tmp/workspace',
    {
      env: {
        PATH: '/opt/custom-agent/bin:/usr/bin',
        OPENAI_API_KEY: 'selected-provider-key',
      },
    },
    'darwin',
  )

  assert.match(env.PATH, /(?:^|:)\/opt\/custom-agent\/bin(?::|$)/)
  assert.equal(env.OPENAI_API_KEY, 'selected-provider-key')
  assert.equal(Object.hasOwn(env, 'GITHUB_TOKEN'), false)
})

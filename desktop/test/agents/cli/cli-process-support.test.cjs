const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { childEnvironment, failedAgentProcessError } = require('../../../src/agents/cli/cli-process-support.cjs')
const { nativeOpenClawOptions } = require('../../../src/agents/cli/openclaw-runtime.cjs')
const { workBuddyInstall } = require('../../support/cli-adapters-test-helpers.cjs')

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

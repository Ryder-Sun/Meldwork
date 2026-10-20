const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  nativeCredentialEnvironment,
  nativeCredentialState,
  resolveNativeOpenClawRuntime,
  resolveNativeCredentialState,
  resolveNativeShellEnvironment,
} = require('../../src/agents/local-agent-readiness.cjs')

test('native environment cache observes credential and proxy changes without a PATH change', async () => {
  const base = { platform: 'win32', home: 'C:\\meldwork-cache-test', env: { PATH: 'C:\\bin',
    ANTHROPIC_API_KEY: 'synthetic-before', HTTPS_PROXY: 'http://before.example:8080' } }
  const before = await resolveNativeShellEnvironment(base)
  const after = await resolveNativeShellEnvironment({ ...base, env: { ...base.env,
    ANTHROPIC_API_KEY: 'synthetic-after', HTTPS_PROXY: '' } })
  assert.equal(before.env.ANTHROPIC_API_KEY, 'synthetic-before')
  assert.equal(after.env.ANTHROPIC_API_KEY, 'synthetic-after')
  assert.equal(after.env.HTTPS_PROXY, '')
  const removed = await resolveNativeShellEnvironment({ ...base, env: { PATH: base.env.PATH } })
  assert.equal(removed.env.ANTHROPIC_API_KEY, undefined)
  assert.equal(removed.env.HTTPS_PROXY, undefined)
})

test('explicit refresh replaces cached native shell settings and subsequent calls share the new result', {
  skip: process.platform === 'win32',
}, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-shell-refresh-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const shell = path.join(home, 'sh')
  const settings = path.join(home, 'native-env')
  fs.writeFileSync(shell, '#!/bin/sh\n. "$HOME/native-env"\nexec /bin/sh "$@"\n', { mode: 0o700 })
  fs.writeFileSync(settings, 'export ANTHROPIC_BASE_URL=https://before.example\n', { mode: 0o600 })
  const options = { home, shell, platform: 'linux', env: { PATH: '/usr/bin:/bin' } }
  const first = await resolveNativeShellEnvironment(options)
  assert.equal(first.env.ANTHROPIC_BASE_URL, 'https://before.example')
  fs.writeFileSync(settings, 'export ANTHROPIC_BASE_URL=https://after.example\n', { mode: 0o600 })
  assert.strictEqual(await resolveNativeShellEnvironment(options), first)
  const refreshed = await resolveNativeShellEnvironment({ ...options, refresh: true })
  assert.equal(refreshed.env.ANTHROPIC_BASE_URL, 'https://after.example')
  assert.strictEqual(await resolveNativeShellEnvironment(options), refreshed)
})

test('a login shell that stops answering keeps the last environment it produced instead of the bare app environment', {
  skip: process.platform === 'win32',
}, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-shell-last-good-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const shell = path.join(home, 'sh')
  fs.writeFileSync(
    shell,
    '#!/bin/sh\n[ -f "$HOME/broken" ] && exit 3\n. "$HOME/native-env"\nexec /bin/sh "$@"\n',
    { mode: 0o700 },
  )
  fs.writeFileSync(path.join(home, 'native-env'), [
    'export ANTHROPIC_BASE_URL=https://gateway.example',
    'export PATH="/opt/user/bin:$PATH"',
    '',
  ].join('\n'), { mode: 0o600 })
  const options = { home, shell, platform: 'linux', env: { PATH: '/usr/bin:/bin' } }

  const good = await resolveNativeShellEnvironment(options)
  assert.equal(good.source, 'native-shell')
  assert.equal(good.env.ANTHROPIC_BASE_URL, 'https://gateway.example')

  fs.writeFileSync(path.join(home, 'broken'), '')
  const afterFailure = await resolveNativeShellEnvironment({ ...options, refresh: true })
  assert.equal(afterFailure.source, 'native-shell')
  assert.equal(afterFailure.env.ANTHROPIC_BASE_URL, 'https://gateway.example')
  assert.ok(afterFailure.env.PATH.split(':').includes('/opt/user/bin'))
  assert.deepEqual(Object.keys(afterFailure).sort(), ['env', 'source'])

  // The failure is not remembered: once the shell works again the new
  // settings are picked up on the next explicit refresh.
  fs.rmSync(path.join(home, 'broken'))
  fs.writeFileSync(path.join(home, 'native-env'), 'export ANTHROPIC_BASE_URL=https://other.example\n', { mode: 0o600 })
  const recovered = await resolveNativeShellEnvironment({ ...options, refresh: true })
  assert.equal(recovered.env.ANTHROPIC_BASE_URL, 'https://other.example')
})

test('without any earlier success a failed login shell still falls back to the process environment', {
  skip: process.platform === 'win32',
}, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-shell-first-failure-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const shell = path.join(home, 'sh')
  fs.writeFileSync(shell, '#!/bin/sh\nexit 3\n', { mode: 0o700 })
  const result = await resolveNativeShellEnvironment({
    home, shell, platform: 'linux', env: { PATH: '/usr/bin:/bin', OPENAI_API_KEY: 'from-process' },
  })
  assert.equal(result.source, 'process')
  assert.equal(result.env.OPENAI_API_KEY, 'from-process')
})

function openClawModelsCatalog(apiKey, baseUrl = 'https://provider.example/v1') {
  return JSON.stringify({
    providers: {
      provider: {
        baseUrl,
        api: 'openai-completions',
        apiKey,
        models: [{ id: 'model', name: 'Model', input: ['text'] }],
      },
    },
  })
}

test('native readiness respects custom config roots and the Pi coding agent auth directory', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-native-roots-'))
  const cases = [
    ['pi', {}, path.join(home, '.pi', 'agent', 'auth.json')],
    ['pi', { PI_CODING_AGENT_DIR: path.join(home, 'custom-pi') }, path.join(home, 'custom-pi', 'auth.json')],
    ['codex', { CODEX_HOME: path.join(home, 'custom-codex') }, path.join(home, 'custom-codex', 'auth.json')],
    ['claude', { CLAUDE_CONFIG_DIR: path.join(home, 'custom-claude') }, path.join(home, 'custom-claude', '.credentials.json')],
    ['opencode', { XDG_DATA_HOME: path.join(home, 'data') }, path.join(home, 'data', 'opencode', 'auth.json')],
  ]
  try {
    for (const [kind, env, filename] of cases) {
      fs.mkdirSync(path.dirname(filename), { recursive: true })
      fs.writeFileSync(filename, JSON.stringify({ provider: kind === 'pi'
        ? { type: 'api_key', key: 'test-only-secret' }
        : { apiKey: 'test-only-secret' } }))
      assert.deepEqual(nativeCredentialState(kind, { home, env }), {
        state: 'ready', source: 'native-credential',
      })
      if (kind !== 'opencode') {
        assert.deepEqual(nativeCredentialEnvironment(kind, env), env)
      }
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('Pi native OAuth credentials use access and refresh fields', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-pi-oauth-'))
  const directory = path.join(home, '.pi', 'agent')
  try {
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'auth.json'), JSON.stringify({
      anthropic: { type: 'oauth', access: 'test-access', refresh: 'test-refresh' },
    }))
    assert.deepEqual(nativeCredentialState('pi', { home, env: {} }), {
      state: 'ready', source: 'native-credential',
    })
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('Hermes readiness detects a native credential without returning its value', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-hermes-readiness-'))
  const secret = 'hermes-secret-value'
  fs.mkdirSync(path.join(home, '.hermes'), { recursive: true })
  fs.writeFileSync(path.join(home, '.hermes', '.env'), `OPENAI_API_KEY=${secret}\n`)

  try {
    const result = nativeCredentialState('hermes', { home })
    assert.deepEqual(result, { state: 'ready', source: 'native-credential' })
    assert.equal(JSON.stringify(result).includes(secret), false)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('custom Provider config is recognized while unresolved Env references remain unverified', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-custom-provider-readiness-'))
  const config = path.join(home, '.hermes', 'config.yaml')
  fs.mkdirSync(path.dirname(config), { recursive: true })
  try {
    fs.writeFileSync(config, [
      'provider: custom',
      'base_url: https://gateway.example/v1',
      'model: local-model',
      'api_key: sk-custom-provider',
    ].join('\n'))
    assert.deepEqual(nativeCredentialState('hermes', { home, env: {} }), {
      state: 'ready', source: 'native-credential',
    })

    fs.writeFileSync(config, 'api_key: ${OPENROUTER_API_KEY}\n')
    assert.deepEqual(nativeCredentialState('hermes', { home, env: {} }), {
      state: 'unknown', source: 'unverified',
    })
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('login shell discovery returns only allowlisted Agent Provider values', async () => {
  const calls = []
  const result = await resolveNativeShellEnvironment({
    cache: false,
    platform: 'darwin',
    home: '/Users/Ryder',
    shell: '/bin/zsh',
    env: {
      PATH: '/usr/bin',
      GITHUB_TOKEN: 'ambient-secret',
      MELDWORK_PRIVATE_VALUE: 'desktop-private-value',
    },
    execFileFn: async (command, args, options) => {
      calls.push({ command, args, options })
      return {
        stdout: [
          'shell startup banner\n__MELDWORK_NATIVE_ENV_V1__',
          'PATH=/opt/custom/bin:/usr/bin',
          'OPENROUTER_API_KEY=openrouter-secret',
          'OPENAI_BASE_URL=https://openrouter.ai/api/v1',
          'OPENAI_MODEL=openrouter/model',
          'GITHUB_TOKEN=must-not-be-read',
          '',
        ].join('\u0000'),
      }
    },
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, '/bin/zsh')
  assert.equal(calls[0].args[0], '-lic')
  assert.equal(calls[0].options.env.GITHUB_TOKEN, undefined)
  assert.equal(calls[0].options.env.MELDWORK_PRIVATE_VALUE, undefined)
  assert.equal(calls[0].args[1].includes('ambient-secret'), false)
  assert.deepEqual(result, {
    source: 'native-shell',
    env: {
      PATH: '/opt/custom/bin:/usr/bin',
      OPENROUTER_API_KEY: 'openrouter-secret',
      OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
      OPENAI_MODEL: 'openrouter/model',
    },
  })
})

test('shell discovery failure falls back to allowlisted process Provider values', async () => {
  const result = await resolveNativeShellEnvironment({
    cache: false,
    platform: 'darwin',
    shell: '/bin/zsh',
    env: {
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'process-provider-key',
      OPENAI_BASE_URL: 'https://gateway.example/v1',
      MELDWORK_PRIVATE_VALUE: 'desktop-private-value',
    },
    execFileFn: async () => { throw new Error('shell unavailable') },
  })

  assert.deepEqual(result, {
    source: 'process',
    env: {
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'process-provider-key',
      OPENAI_BASE_URL: 'https://gateway.example/v1',
    },
  })
})

test('OpenRouter credentials loaded from the native shell mark Hermes ready', async () => {
  const result = await resolveNativeCredentialState('hermes', {
    env: {
      OPENROUTER_API_KEY: 'openrouter-key',
      OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
      OPENAI_MODEL: 'openrouter/model',
    },
    credentialSource: 'native-shell',
  })

  assert.deepEqual(result, { state: 'ready', source: 'native-shell' })
})

test('WorkBuddy readiness requires a selected model and never exposes configured keys', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-workbuddy-readiness-'))
  const secret = 'workbuddy-secret-value'
  fs.mkdirSync(path.join(home, '.workbuddy'), { recursive: true })
  fs.writeFileSync(path.join(home, '.workbuddy', 'models.json'), JSON.stringify([
    { id: 'glm', apiKey: secret, url: 'https://model.example/v1', supportsToolCall: true },
  ]))

  try {
    assert.deepEqual(nativeCredentialState('workbuddy', { home, env: {} }), { state: 'unknown', source: 'unverified' })
    const result = nativeCredentialState('workbuddy', { home, env: {}, modelId: 'glm' })
    assert.deepEqual(result, { state: 'ready', source: 'native-credential' })
    assert.equal(JSON.stringify(result).includes(secret), false)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('native readiness recognizes credential files for every supported CLI', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-native-readiness-'))
  const fixtures = [
    ['codex', ['.codex', 'auth.json'], { tokens: { access_token: 'codex-secret' } }],
    ['hermes', ['.hermes', 'auth.json'], { access_token: 'hermes-secret' }],
    ['openclaw', ['.openclaw', 'openclaw.json'], { gateway: { auth: { token: 'claw-secret' } } }],
    ['pi', ['.pi', 'auth.json'], { access_token: 'pi-secret' }],
    ['kimi', ['.kimi-code', 'credentials', 'kimi-code.json'], { refresh_token: 'kimi-secret' }],
    ['claude', ['.claude', '.credentials.json'], { oauth: { accessToken: 'claude-secret' } }],
    ['qwen', ['.qwen', 'oauth_creds.json'], { access_token: 'qwen-secret' }],
    ['gemini', ['.gemini', 'oauth_creds.json'], { refresh_token: 'gemini-secret' }],
    ['opencode', ['.local', 'share', 'opencode', 'auth.json'], { openai: { token: 'opencode-secret' } }],
    ['opencodereview', ['.opencodereview', 'config.json'], { llm: { auth_token: 'ocr-secret' } }],
  ]
  try {
    for (const [, segments, value] of fixtures) {
      const filename = path.join(home, ...segments)
      fs.mkdirSync(path.dirname(filename), { recursive: true })
      fs.writeFileSync(filename, JSON.stringify(value))
    }
    for (const [kind] of fixtures) {
      assert.deepEqual(nativeCredentialState(kind, { home, env: {} }), {
        state: 'ready', source: 'native-credential',
      })
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('Claude readiness uses the official auth status without exposing OAuth data', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-claude-readiness-'))
  const calls = []
  try {
    const result = await resolveNativeCredentialState('claude', {
      home,
      env: { PATH: '/usr/bin', MELDWORK_PRIVATE_VALUE: 'desktop-private-value' },
      executable: '/tmp/claude',
      execFileFn: async (command, args, options) => {
        calls.push({ command, args, env: options.env })
        return { stdout: JSON.stringify({ loggedIn: true, authMethod: 'oauth_token' }) }
      },
    })

    assert.deepEqual(result, { state: 'ready', source: 'native-auth-status' })
    assert.deepEqual(calls[0].args, ['auth', 'status', '--json'])
    assert.equal(calls[0].env.MELDWORK_PRIVATE_VALUE, undefined)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('OpenClaw readiness uses the official model status when auth is stored outside its config', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-openclaw-readiness-'))
  const agentDir = path.join(home, '.openclaw', 'agents', 'main', 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      provider: {
        baseUrl: 'https://provider.example/v1',
        api: 'openai-completions',
        apiKey: 'native-openclaw-secret',
        models: [{ id: 'model', name: 'Model', input: ['text'] }],
      },
    },
  }))
  const calls = []
  try {
    const result = await resolveNativeCredentialState('openclaw', {
      home,
      env: { PATH: '/usr/bin', MELDWORK_PRIVATE_VALUE: 'desktop-private-value' },
      executable: '/tmp/openclaw',
      execFileFn: async (command, args, options) => {
        calls.push({ command, args, env: options.env })
        return {
          stdout: JSON.stringify({
            defaultModel: 'provider/model',
            resolvedDefault: 'provider/model',
            agentDir,
            auth: { missingProvidersInUse: [], unusableProfiles: ['unused-expired-profile'] },
          }),
        }
      },
    })

    assert.deepEqual(result, { state: 'ready', source: 'native-auth-status' })
    assert.deepEqual(calls[0].args, ['models', 'status', '--check', '--json'])
    assert.equal(calls[0].env.MELDWORK_PRIVATE_VALUE, undefined)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('OpenClaw native runtime extracts only the current validated Provider', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-openclaw-runtime-status-'))
  const agentDir = path.join(home, '.openclaw', 'agents', 'main', 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const secret = 'native-openclaw-secret'
  const calls = []
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      provider: {
        baseUrl: 'https://provider.example/v1/',
        api: 'openai-completions',
        apiKey: secret,
        headers: { Authorization: 'must-not-copy' },
        tools: { allow: ['exec'] },
        models: [
          { id: 'other', name: 'Other' },
          {
            id: 'model-v1',
            name: 'Model V1',
            input: ['text'],
            contextWindow: 128000,
            maxTokens: 4096,
            reasoning: false,
            cost: { input: 0, output: 0, unsafe: 1 },
            params: { unsafe: true },
          },
        ],
      },
    },
  }))

  const runtime = await resolveNativeOpenClawRuntime({
    home,
    env: {},
    executable: '/tmp/openclaw',
    execFileFn: async (_command, args, options) => {
      calls.push({ args, env: options.env })
      return { stdout: JSON.stringify({
        resolvedDefault: 'provider/model-v1',
        agentDir,
        auth: { missingProvidersInUse: [], profiles: [{ token: 'ignored' }] },
      }) }
    },
  })

  assert.deepEqual(runtime, {
    model: 'provider/model-v1',
    provider: {
      id: 'provider',
      baseUrl: 'https://provider.example/v1',
      api: 'openai-completions',
      apiKey: secret,
      model: {
        id: 'model-v1',
        name: 'Model V1',
        input: ['text'],
        contextWindow: 128000,
        maxTokens: 4096,
        reasoning: false,
        cost: { input: 0, output: 0 },
      },
    },
  })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args, ['models', 'status', '--check', '--json'])
  assert.equal(Object.hasOwn(runtime, 'auth'), false)
  assert.equal(Object.hasOwn(runtime, 'agentDir'), false)
  assert.equal(Object.hasOwn(runtime.provider, 'headers'), false)
  assert.equal(Object.hasOwn(runtime.provider.model, 'params'), false)
})

test('OpenClaw native runtime resolves allowlisted Env SecretRefs from the shell environment', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-openclaw-env-runtime-'))
  const agentDir = path.join(home, '.openclaw', 'agents', 'main', 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, 'models.json'), openClawModelsCatalog({
    source: 'env', provider: 'default', id: 'OPENROUTER_API_KEY',
  }, 'https://openrouter.ai/api/v1'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))

  const runtime = await resolveNativeOpenClawRuntime({
    home,
    env: { OPENROUTER_API_KEY: 'openrouter-native-key' },
    executable: '/tmp/openclaw',
    execFileFn: async () => ({ stdout: JSON.stringify({
      resolvedDefault: 'provider/model', agentDir,
      auth: { missingProvidersInUse: [] },
    }) }),
  })

  assert.equal(runtime.provider.apiKey, 'openrouter-native-key')
  assert.equal(JSON.stringify(runtime).includes('OPENROUTER_API_KEY'), false)
})

test('OpenClaw native runtime rejects Env SecretRefs without reading unrelated process secrets', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-openclaw-runtime-env-'))
  const agentDir = path.join(home, '.openclaw', 'agents', 'main', 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      provider: {
        baseUrl: 'https://attacker.example/v1',
        api: 'openai-responses',
        apiKey: { source: 'env', provider: 'default', id: 'GITHUB_TOKEN' },
        models: [{ id: 'model', name: 'Model', input: ['text'] }],
      },
    },
  }))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const calls = []
  await assert.rejects(resolveNativeOpenClawRuntime({
    home,
    env: { PATH: '/usr/bin', GITHUB_TOKEN: 'must-not-leave-process' },
    executable: '/tmp/openclaw',
    execFileFn: async (_command, args, options) => {
      calls.push({ args, env: options.env })
      return { stdout: JSON.stringify({
        resolvedDefault: 'provider/model', agentDir,
        auth: { missingProvidersInUse: [] },
      }) }
    },
  }), { message: 'OPENCLAW_NATIVE_RUNTIME_UNAVAILABLE' })

  assert.equal(calls[0].env.GITHUB_TOKEN, undefined)
})

test('OpenClaw native runtime rejects every structured and string SecretRef marker', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-openclaw-secretrefs-'))
  const agentDir = path.join(home, '.openclaw', 'agents', 'main', 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const refs = [
    { source: 'env', provider: 'default', id: 'GITHUB_TOKEN' },
    { source: 'file', provider: 'default', id: '/tmp/secret' },
    { source: 'exec', provider: 'default', id: 'secret-command' },
    { source: 'env', id: 'GITHUB_TOKEN' },
    '$GITHUB_TOKEN',
    '${GITHUB_TOKEN}',
    'secretref-env:GITHUB_TOKEN',
    '__env__:GITHUB_TOKEN',
    'secretref-managed',
    'GITHUB_TOKEN',
    'AWS_PROFILE',
    'oauth:github',
    'custom-local',
    'gcp-vertex-credentials',
  ]

  for (const apiKey of refs) {
    fs.writeFileSync(path.join(agentDir, 'models.json'), openClawModelsCatalog(apiKey))
    await assert.rejects(resolveNativeOpenClawRuntime({
      home,
      env: {
        PATH: '/usr/bin',
        GITHUB_TOKEN: 'must-not-leave-process',
        AWS_PROFILE: 'must-not-leave-process',
      },
      executable: '/tmp/openclaw',
      execFileFn: async (_command, _args, options) => {
        assert.equal(options.env.GITHUB_TOKEN, undefined)
        assert.equal(options.env.AWS_PROFILE, undefined)
        return { stdout: JSON.stringify({
          resolvedDefault: 'provider/model', agentDir,
          auth: { missingProvidersInUse: [] },
        }) }
      },
    }), { message: 'OPENCLAW_NATIVE_RUNTIME_UNAVAILABLE' })
  }
})

test('OpenClaw native runtime rejects ancestor path changes while reading models', {
  skip: process.platform === 'win32',
}, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-openclaw-model-path-'))
  const agentDir = path.join(home, '.openclaw', 'agents', 'main', 'agent')
  const external = path.join(home, 'external-agent')
  fs.mkdirSync(agentDir, { recursive: true })
  fs.mkdirSync(external)
  fs.writeFileSync(path.join(agentDir, 'models.json'), openClawModelsCatalog('inside-key'))
  fs.writeFileSync(path.join(external, 'models.json'), openClawModelsCatalog('outside-key'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))

  const canonicalAgentDir = fs.realpathSync(agentDir)
  const modelsPath = path.join(canonicalAgentDir, 'models.json')
  const originalLstat = fs.lstatSync
  let redirected = false
  fs.lstatSync = function guardedLstat(filename, ...args) {
    const stat = originalLstat.call(this, filename, ...args)
    if (!redirected && String(filename) === modelsPath) {
      redirected = true
      fs.renameSync(agentDir, `${agentDir}.original`)
      fs.symlinkSync(external, agentDir, 'dir')
    }
    return stat
  }

  try {
    await assert.rejects(resolveNativeOpenClawRuntime({
      home,
      env: {},
      executable: '/tmp/openclaw',
      execFileFn: async () => ({ stdout: JSON.stringify({
        resolvedDefault: 'provider/model', agentDir,
        auth: { missingProvidersInUse: [] },
      }) }),
    }), { message: 'OPENCLAW_NATIVE_RUNTIME_UNAVAILABLE' })
  } finally {
    fs.lstatSync = originalLstat
  }
})

test('OpenClaw native runtime rejects models file identity changes after opening', {
  skip: process.platform === 'win32',
}, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-openclaw-model-inode-'))
  const agentDir = path.join(home, '.openclaw', 'agents', 'main', 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, 'models.json'), openClawModelsCatalog('inside-key'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))

  const modelsPath = path.join(fs.realpathSync(agentDir), 'models.json')
  const originalOpen = fs.openSync
  let replaced = false
  fs.openSync = function guardedOpen(filename, ...args) {
    const descriptor = originalOpen.call(this, filename, ...args)
    if (!replaced && String(filename) === modelsPath) {
      replaced = true
      fs.renameSync(modelsPath, `${modelsPath}.original`)
      fs.writeFileSync(modelsPath, openClawModelsCatalog('replacement-key'))
    }
    return descriptor
  }

  try {
    await assert.rejects(resolveNativeOpenClawRuntime({
      home,
      env: {},
      executable: '/tmp/openclaw',
      execFileFn: async () => ({ stdout: JSON.stringify({
        resolvedDefault: 'provider/model', agentDir,
        auth: { missingProvidersInUse: [] },
      }) }),
    }), { message: 'OPENCLAW_NATIVE_RUNTIME_UNAVAILABLE' })
  } finally {
    fs.openSync = originalOpen
  }
})

test('OpenClaw native runtime rejects in-place models changes while reading', {
  skip: process.platform === 'win32',
}, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-openclaw-model-content-'))
  const agentDir = path.join(home, '.openclaw', 'agents', 'main', 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, 'models.json'), openClawModelsCatalog('inside-key'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))

  const modelsPath = path.join(fs.realpathSync(agentDir), 'models.json')
  const originalReadFile = fs.readFileSync
  const originalIdentity = fs.statSync(modelsPath).ino
  let modified = false
  fs.readFileSync = function guardedReadFile(filename, ...args) {
    const contents = originalReadFile.call(this, filename, ...args)
    if (!modified && typeof filename === 'number') {
      modified = true
      fs.writeFileSync(modelsPath, openClawModelsCatalog('edited-key'))
      assert.equal(fs.statSync(modelsPath).ino, originalIdentity)
    }
    return contents
  }

  try {
    await assert.rejects(resolveNativeOpenClawRuntime({
      home,
      env: {},
      executable: '/tmp/openclaw',
      execFileFn: async () => ({ stdout: JSON.stringify({
        resolvedDefault: 'provider/model', agentDir,
        auth: { missingProvidersInUse: [] },
      }) }),
    }), { message: 'OPENCLAW_NATIVE_RUNTIME_UNAVAILABLE' })
  } finally {
    fs.readFileSync = originalReadFile
  }
})

test('OpenClaw native runtime rejects unsafe status and Provider descriptors', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-openclaw-runtime-invalid-'))
  const agentDir = path.join(home, '.openclaw', 'agents', 'main', 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const validStatus = {
    resolvedDefault: 'provider/model', agentDir,
    auth: { missingProvidersInUse: [] },
  }
  const validProvider = {
    baseUrl: 'https://provider.example/v1',
    api: 'openai-completions',
    apiKey: 'secret',
    models: [{ id: 'model', name: 'Model', input: ['text'] }],
  }
  const outsideAgentDir = path.join(home, 'outside-agent')
  fs.mkdirSync(outsideAgentDir)
  fs.writeFileSync(path.join(outsideAgentDir, 'models.json'), JSON.stringify({
    providers: { provider: validProvider },
  }))
  const invalid = [
    [{ resolvedDefault: 'provider/model', auth: { missingProvidersInUse: [] } }, validProvider],
    [{ ...validStatus, agentDir: 'relative' }, validProvider],
    [{ ...validStatus, resolvedDefault: 'provider.id/model' }, validProvider],
    [{ ...validStatus, agentDir: path.join(home, 'missing') }, validProvider],
    [{ ...validStatus, agentDir: outsideAgentDir }, validProvider],
    [validStatus, { ...validProvider, baseUrl: 'http://provider.example/v1' }],
    [validStatus, { ...validProvider, api: 'unknown-api' }],
    [validStatus, { ...validProvider, apiKey: '' }],
    [validStatus, { ...validProvider, models: [{ id: 'other', name: 'Other', input: ['text'] }] }],
    [validStatus, {
      ...validProvider,
      apiKey: { source: 'file', provider: 'default', id: '/tmp/secret' },
    }],
  ]

  for (const [status, provider] of invalid) {
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
      providers: { provider },
    }))
    await assert.rejects(
      resolveNativeOpenClawRuntime({
        home,
        env: {},
        executable: '/tmp/openclaw',
        execFileFn: async () => ({ stdout: JSON.stringify(status) }),
      }),
      { message: 'OPENCLAW_NATIVE_RUNTIME_UNAVAILABLE' },
    )
    assert.deepEqual(await resolveNativeCredentialState('openclaw', {
      home,
      env: {},
      executable: '/tmp/openclaw',
      execFileFn: async () => ({ stdout: JSON.stringify(status) }),
    }), {
      state: 'unknown', source: 'native-runtime-unavailable',
    })
  }

  if (process.platform !== 'win32') {
    const outsideModels = path.join(home, 'outside-models.json')
    fs.writeFileSync(outsideModels, JSON.stringify({ providers: { provider: validProvider } }))
    fs.rmSync(path.join(agentDir, 'models.json'), { force: true })
    fs.symlinkSync(outsideModels, path.join(agentDir, 'models.json'))
    await assert.rejects(resolveNativeOpenClawRuntime({
      home,
      env: {},
      executable: '/tmp/openclaw',
      execFileFn: async () => ({ stdout: JSON.stringify(validStatus) }),
    }), { message: 'OPENCLAW_NATIVE_RUNTIME_UNAVAILABLE' })
  }
})

test('OpenClaw model status overrides a stale gateway token without exposing auth details', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-openclaw-stale-auth-'))
  const configPath = path.join(home, '.openclaw', 'openclaw.json')
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify({ gateway: { auth: { token: 'gateway-only-token' } } }))
  try {
    const error = Object.assign(new Error('missing provider auth'), {
      stdout: JSON.stringify({
        defaultModel: 'provider/model',
        resolvedDefault: 'provider/model',
        auth: { missingProvidersInUse: ['provider'], unusableProfiles: [] },
      }),
    })
    const result = await resolveNativeCredentialState('openclaw', {
      home,
      env: {},
      executable: '/tmp/openclaw',
      execFileFn: async () => { throw error },
    })

    assert.deepEqual(result, { state: 'missing', source: 'native-auth-status' })
    assert.equal(JSON.stringify(result).includes('gateway-only-token'), false)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('MiMo readiness uses the installed CLI identity without forwarding private values', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-mimo-auth-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const calls = []
  for (const stdout of [
    '\u001b[32mProvider: MiMo\u001b[0m\nUser ID: user-123',
    'Provider: MiMo\nType: OAuth',
  ]) {
    const result = await resolveNativeCredentialState('mimo', {
      home,
      env: { PATH: '/usr/bin', MELDWORK_PRIVATE_VALUE: 'desktop-private-value' },
      executable: '/tmp/mimo',
      execFileFn: async (command, args, options) => {
        calls.push({ command, args, env: options.env })
        return { stdout }
      },
    })

    assert.deepEqual(result, { state: 'ready', source: 'native-auth-status' })
  }
  assert.deepEqual(calls.map(call => call.args), [
    ['providers', 'whoami'],
    ['providers', 'whoami'],
  ])
  assert.equal(calls.every(call => call.env.MELDWORK_PRIVATE_VALUE === undefined), true)
})

test('MiMo readiness recognizes ANSI-colored logged-out output even when the CLI exits zero', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-mimo-auth-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const result = await resolveNativeCredentialState('mimo', {
    home,
    env: {},
    executable: '/tmp/mimo',
    execFileFn: async () => ({
      stdout: '\u001b[0m\n\u001b[31mNot logged in. Run `mimo auth login` to log in.\u001b[0m',
    }),
  })

  assert.deepEqual(result, { state: 'missing', source: 'native-auth-status' })
})

test('MiMo readiness remains unknown for missing or malformed identity output', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-mimo-auth-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  assert.deepEqual(await resolveNativeCredentialState('mimo', { home, env: {} }), {
    state: 'unknown', source: 'unverified',
  })

  for (const stdout of [
    '',
    'Provider: MiMo\nUser ID:',
    'Provider: Other\nUser ID: user-123',
    'User ID: user-123',
    'Authentication status unavailable',
  ]) {
    const result = await resolveNativeCredentialState('mimo', {
      home,
      env: {},
      executable: '/tmp/mimo',
      execFileFn: async () => ({ stdout }),
    })
    assert.deepEqual(result, { state: 'unknown', source: 'unverified' })
  }
})

test('Claude auth status overrides a stale credential file', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-claude-stale-auth-'))
  const credentialPath = path.join(home, '.claude', '.credentials.json')
  fs.mkdirSync(path.dirname(credentialPath), { recursive: true })
  fs.writeFileSync(credentialPath, JSON.stringify({ oauth: { accessToken: 'expired-token' } }))
  let calls = 0
  try {
    const result = await resolveNativeCredentialState('claude', {
      home,
      env: {},
      executable: '/tmp/claude',
      execFileFn: async () => {
        calls += 1
        return { stdout: JSON.stringify({ loggedIn: false }) }
      },
    })

    assert.deepEqual(result, { state: 'missing', source: 'native-auth-status' })
    assert.equal(calls, 1)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('Claude probes native auth with cloud configuration even when a direct API key exists', async () => {
  let calls = 0
  const env = {
    ANTHROPIC_API_KEY: 'unused-direct-key', CLAUDE_CODE_USE_BEDROCK: '1',
    AWS_PROFILE: 'native-profile', AWS_REGION: 'us-east-1',
    AWS_SESSION_TOKEN: 'native-session-token', GITHUB_TOKEN: 'unrelated-secret',
  }
  const result = await resolveNativeCredentialState('claude', {
    env, executable: '/tmp/claude',
    execFileFn: async (command, args, options) => {
      calls += 1
      assert.deepEqual(args, ['auth', 'status', '--json'])
      assert.equal(options.env.AWS_PROFILE, env.AWS_PROFILE)
      assert.equal(options.env.AWS_SESSION_TOKEN, env.AWS_SESSION_TOKEN)
      assert.equal(options.env.CLAUDE_CODE_USE_BEDROCK, '1')
      assert.equal(options.env.GITHUB_TOKEN, undefined)
      return { stdout: JSON.stringify({ loggedIn: false }) }
    },
  })
  assert.equal(calls, 1)
  assert.deepEqual(result, { state: 'missing', source: 'native-auth-status' })
})

test('Claude API key status remains configuration evidence rather than verified authentication', async () => {
  const result = await resolveNativeCredentialState('claude', {
    env: { ANTHROPIC_API_KEY: 'unverified-api-key' }, executable: '/tmp/claude',
    execFileFn: async () => ({ stdout: JSON.stringify({ loggedIn: true, authMethod: 'api_key' }) }),
  })
  assert.deepEqual(result, { state: 'ready', source: 'native-credential' })
})

test('Claude cloud provider recognition alone does not verify SDK credentials', async () => {
  for (const apiProvider of ['bedrock', 'vertex', 'foundry']) {
    const result = await resolveNativeCredentialState('claude', {
      env: { ANTHROPIC_API_KEY: 'unused-direct-key' }, executable: '/tmp/claude',
      execFileFn: async () => ({ stdout: JSON.stringify({
        loggedIn: true, authMethod: 'third_party', apiProvider,
      }) }),
    })
    assert.deepEqual(result, { state: 'unknown', source: 'unverified' })
  }
})

test('real shell extraction preserves explicit empty cloud and credential overrides', {
  skip: process.platform === 'win32',
}, async () => {
  const execFile = require('node:util').promisify(require('node:child_process').execFile)
  const result = await resolveNativeShellEnvironment({
    cache: false, platform: 'linux', shell: '/bin/sh',
    env: { AWS_PROFILE: 'stale-profile', ANTHROPIC_API_KEY: 'stale-key', PATH: '/usr/bin:/bin' },
    execFileFn: (command, args, options) => execFile(command, ['-c',
      "export AWS_PROFILE='' ANTHROPIC_API_KEY='' CLAUDE_CODE_USE_BEDROCK='0'\n" + args[1],
    ], options),
  })
  assert.equal(result.source, 'native-shell')
  assert.equal(result.env.AWS_PROFILE, '')
  assert.equal(result.env.ANTHROPIC_API_KEY, '')
  assert.equal(result.env.CLAUDE_CODE_USE_BEDROCK, '0')
  assert.deepEqual(nativeCredentialEnvironment('claude', result.env), {
    AWS_PROFILE: '', ANTHROPIC_API_KEY: '', CLAUDE_CODE_USE_BEDROCK: '0',
  })
  const fallback = await resolveNativeShellEnvironment({
    cache: false, platform: 'win32', env: { AWS_PROFILE: '', ANTHROPIC_API_KEY: '' },
  })
  assert.equal(fallback.env.AWS_PROFILE, '')
  assert.equal(fallback.env.ANTHROPIC_API_KEY, '')
})

test('model-specific Vertex regions participate in cache identity and stay scoped to the native Agent', async () => {
  const key = 'VERTEX_REGION_CLAUDE_FUTURE_MODEL'
  const base = { platform: 'win32', home: 'C:\\vertex-region-test', env: { PATH: 'C:\\bin', [key]: 'us-east5' } }
  const before = await resolveNativeShellEnvironment(base)
  const after = await resolveNativeShellEnvironment({ ...base, env: { ...base.env, [key]: '' } })
  assert.equal(before.env[key], 'us-east5')
  assert.equal(after.env[key], '')
  assert.deepEqual(nativeCredentialEnvironment('claude', after.env), { [key]: '' })
  assert.deepEqual(nativeCredentialEnvironment('gemini', before.env), {})
  assert.deepEqual(nativeCredentialEnvironment('codex', before.env), {})
  const removed = await resolveNativeShellEnvironment({ ...base, env: { PATH: base.env.PATH } })
  assert.equal(removed.env[key], undefined)
  assert.deepEqual(nativeCredentialEnvironment('claude', {
    VERTEX_REGION_: 'empty-model', VERTEX_REGION_lowercase: 'invalid',
    'VERTEX_REGION_MODEL;bad': 'invalid', NODE_OPTIONS: '--require untrusted',
  }), {})
})

for (const shell of ['/bin/sh', '/bin/bash', '/bin/zsh']) {
  test(`native shell ${shell} extracts exported dynamic regions without unrelated values or value evaluation`, {
    skip: process.platform === 'win32' || !fs.existsSync(shell),
  }, async t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-region-'))
    t.after(() => fs.rmSync(home, { recursive: true, force: true }))
    const execFile = require('node:util').promisify(require('node:child_process').execFile)
    let output = ''
    const resolved = await resolveNativeShellEnvironment({
      cache: false, home, shell, env: { PATH: '/usr/bin:/bin' },
      execFileFn: async (command, args, options) => {
        const result = await execFile(command, ['-c', [
          "export VERTEX_REGION_CLAUDE_FUTURE_MODEL=us-east5",
          "export VERTEX_REGION_CLAUDE_EMPTY=''",
          "export VERTEX_REGION_LITERAL='$(touch should-not-exist)'",
          "export MELDWORK_UNRELATED='synthetic-unrelated-secret'",
          "export NODE_OPTIONS='--require /nonexistent/untrusted-module.cjs'",
          args[1],
        ].join('\n')], { ...options, cwd: home })
        output = result.stdout
        return result
      },
    })
    assert.equal(resolved.source, 'native-shell')
    assert.equal(resolved.env.VERTEX_REGION_CLAUDE_FUTURE_MODEL, 'us-east5')
    assert.equal(resolved.env.VERTEX_REGION_CLAUDE_EMPTY, '')
    assert.equal(resolved.env.VERTEX_REGION_LITERAL, '$(touch should-not-exist)')
    assert.equal(resolved.env.MELDWORK_UNRELATED, undefined)
    assert.equal(resolved.env.NODE_OPTIONS, undefined)
    assert.equal(output.includes('synthetic-unrelated-secret'), false)
    assert.equal(fs.existsSync(path.join(home, 'should-not-exist')), false)
  })
}

test('native cloud configuration is forwarded only to compatible Agents', () => {
  const cloud = {
    CLAUDE_CODE_USE_VERTEX: '1', AWS_PROFILE: 'native', AWS_ACCESS_KEY_ID: 'access-key',
    AWS_SECRET_ACCESS_KEY: 'secret-key', AZURE_CLIENT_SECRET: 'azure-secret',
    GOOGLE_APPLICATION_CREDENTIALS: '/tmp/adc.json', GOOGLE_CLOUD_PROJECT: 'native-project',
    CLOUD_ML_REGION: 'us-east5', ANTHROPIC_FOUNDRY_RESOURCE: 'native-resource',
  }
  assert.deepEqual(nativeCredentialEnvironment('claude', cloud), cloud)
  assert.deepEqual(nativeCredentialEnvironment('gemini', cloud), {
    GOOGLE_APPLICATION_CREDENTIALS: '/tmp/adc.json', GOOGLE_CLOUD_PROJECT: 'native-project',
  })
  assert.deepEqual(nativeCredentialEnvironment('codex', cloud), {})
})

test('an installed Agent without credential evidence remains unverified', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-missing-readiness-'))
  try {
    assert.deepEqual(nativeCredentialState('workbuddy', { home }), {
      state: 'unknown', source: 'unverified',
    })
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('native environment forwarding includes only the current Agent credential keys', () => {
  assert.deepEqual(nativeCredentialEnvironment('claude', {
    ANTHROPIC_API_KEY: 'claude-key',
    OPENAI_API_KEY: 'unrelated-openai-key',
    MELDWORK_PRIVATE_VALUE: 'desktop-private-value',
  }), {
    ANTHROPIC_API_KEY: 'claude-key',
  })

  assert.deepEqual(nativeCredentialEnvironment('hermes', {
    OPENROUTER_API_KEY: 'openrouter-key',
    OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
    OPENAI_MODEL: 'openrouter/model',
    GITHUB_TOKEN: 'unrelated-secret',
  }), {
    OPENROUTER_API_KEY: 'openrouter-key',
    OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
    OPENAI_MODEL: 'openrouter/model',
  })
})

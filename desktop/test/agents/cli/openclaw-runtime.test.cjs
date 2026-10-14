const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  configureOpenClawGatewayRuntime,
  nativeOpenClawOptions,
  refreshOpenClawRuntimeAfterStartup,
  validateOpenClawRuntimeGuard,
} = require('../../../src/agents/cli/openclaw-runtime.cjs')
const {
  executable,
  readJsonWhenReady,
  readWhenReady,
} = require('../../support/cli-adapters-test-helpers.cjs')
const { invocation } = require('../../../src/agents/cli/cli-invocations.cjs')

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-openclaw-runtime-'))
  const workdir = path.join(directory, 'workspace')
  fs.mkdirSync(workdir)
  return { directory, workdir }
}

function nativeRuntime(apiKey = 'native-openclaw-key') {
  return {
    model: 'native/model',
    provider: {
      id: 'native',
      baseUrl: 'https://native.example.com/v1',
      api: 'openai-completions',
      apiKey,
      model: {
        id: 'model',
        name: 'Native Model',
        input: ['text'],
        contextWindow: 128000,
        maxTokens: 4096,
      },
    },
  }
}

function runtimeScope(sessionRef, workdir) {
  return crypto.createHash('sha256')
    .update(`${sessionRef || 'configure'}\0${path.resolve(workdir)}`)
    .digest('hex')
    .slice(0, 24)
}

test('native runtime scope is keyed by session, workspace, and CLI version', (t) => {
  const { directory, workdir } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const base = {
    storageRoot: directory,
    workdir,
    sessionRef: 'agent:main:desktop-meldwork-scope-openclaw',
    runtime: nativeRuntime(),
  }
  const versionA = nativeOpenClawOptions({ ...base, openclawVersion: 'OpenClaw 2026.7.1-2 (a1b2c3)' })
  const versionARepeat = nativeOpenClawOptions({ ...base, openclawVersion: 'OpenClaw 2026.7.1-2 (a1b2c3)' })
  const versionB = nativeOpenClawOptions({ ...base, openclawVersion: 'OpenClaw 2026.9.1 (ad6fe23)' })
  const unversioned = nativeOpenClawOptions({ ...base })

  assert.equal(versionA.env.OPENCLAW_STATE_DIR, versionARepeat.env.OPENCLAW_STATE_DIR)
  assert.notEqual(versionA.env.OPENCLAW_STATE_DIR, versionB.env.OPENCLAW_STATE_DIR)
  assert.notEqual(versionA.env.OPENCLAW_STATE_DIR, unversioned.env.OPENCLAW_STATE_DIR)
  assert.equal(versionB.env.OPENCLAW_STATE_DIR.startsWith(fs.realpathSync(directory)), true)
})

test('Gateway setup rewrites the guarded config without persisting credentials', (t) => {
  const { directory, workdir } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const runtime = nativeOpenClawOptions({
    storageRoot: directory,
    workdir,
    sessionRef: 'agent:main:gateway-runtime',
    runtime: nativeRuntime(),
  })

  const configured = configureOpenClawGatewayRuntime(runtime, 43123)
  const configText = fs.readFileSync(configured.env.OPENCLAW_CONFIG_PATH, 'utf8')
  const config = JSON.parse(configText)

  assert.notEqual(configured.openClawRuntimeGuard, runtime.openClawRuntimeGuard)
  assert.equal(validateOpenClawRuntimeGuard(
    configured.openClawRuntimeGuard,
    configured.env,
  ), true)
  assert.throws(() => validateOpenClawRuntimeGuard(
    runtime.openClawRuntimeGuard,
    runtime.env,
  ), { message: 'OPENCLAW_RUNTIME_UNSAFE_PATH' })
  assert.equal(config.gateway.port, 43123)
  assert.equal(config.gateway.mode, 'local')
  assert.equal(config.gateway.bind, 'loopback')
  assert.equal(config.gateway.controlUi.enabled, false)
  assert.equal(config.gateway.tailscale.mode, 'off')
  assert.deepEqual(config.gateway.auth.token, {
    source: 'env', provider: 'default', id: 'OPENCLAW_GATEWAY_TOKEN',
  })
  assert.equal(config.discovery.mdns.mode, 'off')
  assert.equal(config.discovery.wideArea.enabled, false)
  assert.equal(config.update.checkOnStart, false)
  assert.equal(config.update.auto.enabled, false)
  assert.equal(config.logging.file, path.join(runtime.env.OPENCLAW_STATE_DIR, 'gateway.log'))
  assert.equal(configText.includes(runtime.env.MELDWORK_OPENCLAW_NATIVE_API_KEY), false)
  assert.equal(configText.includes(runtime.env.OPENCLAW_GATEWAY_TOKEN), false)
})

test('startup migration refreshes the guard without changing execution policy', (t) => {
  const { directory, workdir } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const options = configureOpenClawGatewayRuntime(nativeOpenClawOptions({
    storageRoot: directory, workdir, runtime: nativeRuntime(),
  }), 43123)
  const configPath = options.env.OPENCLAW_CONFIG_PATH
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  config.agents.entries = { main: {} }
  config.discovery.wideArea = {}
  config.meta = { migrations: { modelPolicyAllowlist: true }, lastTouchedVersion: '2026.9.1' }
  fs.writeFileSync(`${configPath}.migrated`, JSON.stringify(config), { mode: 0o600 })
  fs.renameSync(`${configPath}.migrated`, configPath)
  assert.throws(() => validateOpenClawRuntimeGuard(options.openClawRuntimeGuard, options.env))
  const migrated = refreshOpenClawRuntimeAfterStartup(options)
  assert.equal(validateOpenClawRuntimeGuard(migrated.openClawRuntimeGuard, migrated.env), true)
  config.tools.allow.push('exec')
  fs.writeFileSync(configPath, JSON.stringify(config))
  assert.throws(() => validateOpenClawRuntimeGuard(migrated.openClawRuntimeGuard, migrated.env))
})

test('startup migration rejects changed policies, credentials, paths and unknown configuration', async (t) => {
  for (const [name, mutate] of Object.entries({
    tools: config => { config.tools.allow.push('exec') },
    workspace: config => { config.agents.defaults.workspace = os.homedir() },
    agentOverride: config => { config.agents.entries = { main: { tools: { allow: ['exec'] } } } },
    credentials: config => { config.gateway.auth.token = 'replacement-token' },
    provider: config => { config.models.providers.native.baseUrl = 'https://other.example' },
    bind: config => { config.gateway.bind = 'lan' },
    discovery: config => { config.discovery.wideArea.enabled = true },
    unknown: config => { config.plugins = { enabled: true } },
    metadata: config => { config.meta = { unrecognized: true } },
  })) {
    await t.test(name, () => {
      const { directory, workdir } = fixture()
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
      const options = configureOpenClawGatewayRuntime(nativeOpenClawOptions({
        storageRoot: directory, workdir, runtime: nativeRuntime(),
      }), 43123)
      const configPath = options.env.OPENCLAW_CONFIG_PATH
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      mutate(config)
      fs.writeFileSync(configPath, JSON.stringify(config))
      assert.throws(() => refreshOpenClawRuntimeAfterStartup(options), {
        message: 'OPENCLAW_RUNTIME_UNSAFE_PATH',
      })
    })
  }
})

test('startup migration rejects symlinks and broadened file permissions', (t) => {
  const { directory, workdir } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const options = nativeOpenClawOptions({ storageRoot: directory, workdir, runtime: nativeRuntime() })
  const configPath = options.env.OPENCLAW_CONFIG_PATH
  fs.renameSync(configPath, `${configPath}.original`)
  fs.symlinkSync(`${configPath}.original`, configPath)
  assert.throws(() => refreshOpenClawRuntimeAfterStartup(options), { message: 'OPENCLAW_RUNTIME_UNSAFE_PATH' })
  fs.unlinkSync(configPath)
  fs.renameSync(`${configPath}.original`, configPath)
  if (process.platform !== 'win32') {
    fs.chmodSync(configPath, 0o644)
    assert.throws(() => refreshOpenClawRuntimeAfterStartup(options), { message: 'OPENCLAW_RUNTIME_UNSAFE_PATH' })
  }
})

test('startup migration rejects an oversized config before parsing it', (t) => {
  const { directory, workdir } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const options = nativeOpenClawOptions({ storageRoot: directory, workdir, runtime: nativeRuntime() })
  fs.appendFileSync(options.env.OPENCLAW_CONFIG_PATH, ' '.repeat(256 * 1024))
  assert.throws(() => refreshOpenClawRuntimeAfterStartup(options), {
    message: 'OPENCLAW_RUNTIME_UNSAFE_PATH',
  })
})

test('Gateway lifecycle retries setup before callback and closes the isolated process', async (t) => {
  const { withOpenClawGateway } = require('../../../src/agents/cli/cli-openclaw-gateway.cjs')
  const { directory, workdir } = fixture()
  const attemptsFile = path.join(directory, 'gateway-attempts.txt')
  const probeFile = path.join(directory, 'gateway-probe.json')
  const healthProbeFile = path.join(directory, 'gateway-health-probe.json')
  const stoppedFile = path.join(directory, 'gateway-stopped.txt')
  const cli = executable(directory, 'openclaw-gateway.cjs', `
const fs = require('node:fs')
const args = process.argv.slice(2)
const globalArgs = ['--no-color', '--log-level', 'info']
const commandOffset = globalArgs.every((value, index) => args[index] === value)
  ? globalArgs.length
  : -1
const command = args[commandOffset + 1]
const token = process.env.OPENCLAW_GATEWAY_TOKEN || ''
if (commandOffset < 0 || args[commandOffset] !== 'gateway') process.exit(2)
if (command === 'health') {
  fs.writeFileSync(${JSON.stringify(healthProbeFile)}, JSON.stringify({
    args,
    configPath: process.env.OPENCLAW_CONFIG_PATH,
    hasToken: token.length >= 32,
    tokenInArgs: Boolean(token && args.join(' ').includes(token)),
  }))
  process.stdout.write(JSON.stringify({ ok: true }))
  process.exit(0)
}
if (command !== 'run') process.exit(2)
const attemptsFile = ${JSON.stringify(attemptsFile)}
const attempts = fs.existsSync(attemptsFile) ? Number(fs.readFileSync(attemptsFile, 'utf8')) : 0
fs.writeFileSync(attemptsFile, String(attempts + 1))
const migratedConfigPath = process.env.OPENCLAW_CONFIG_PATH
const migratedConfig = JSON.parse(fs.readFileSync(migratedConfigPath, 'utf8'))
migratedConfig.agents.entries = { main: {} }
migratedConfig.discovery.wideArea = {}
migratedConfig.meta = { migrations: { modelPolicyAllowlist: true }, lastTouchedVersion: '2026.9.1' }
fs.writeFileSync(migratedConfigPath + '.migrated', JSON.stringify(migratedConfig), { mode: 0o600 })
fs.renameSync(migratedConfigPath + '.migrated', migratedConfigPath)
if (attempts === 0) {
  process.stderr.write('listen EADDRINUSE: address already in use\\n')
  process.exit(1)
}
fs.writeFileSync(${JSON.stringify(probeFile)}, JSON.stringify({
  args,
  configPath: process.env.OPENCLAW_CONFIG_PATH,
  hasToken: token.length >= 32,
  home: process.env.HOME,
  state: process.env.OPENCLAW_STATE_DIR,
  temp: process.env.TMPDIR,
  tokenInArgs: Boolean(token && args.join(' ').includes(token)),
}))
process.stdout.write('[gateway] ready\\n')
process.on('SIGTERM', () => {
  fs.writeFileSync(${JSON.stringify(stoppedFile)}, 'stopped')
  process.exit(0)
})
setInterval(() => {}, 1000)
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const runtime = nativeOpenClawOptions({
    storageRoot: directory,
    workdir,
    sessionRef: 'agent:main:gateway-lifecycle',
    runtime: nativeRuntime(),
  })
  let callbackPort

  const result = await withOpenClawGateway({
    executable: cli,
    workdir,
    ...runtime,
  }, async (gatewayOptions) => {
    callbackPort = gatewayOptions.gatewayPort
    assert.equal(gatewayOptions.gatewayUrl, `ws://127.0.0.1:${callbackPort}`)
    assert.equal(validateOpenClawRuntimeGuard(
      gatewayOptions.openClawRuntimeGuard,
      gatewayOptions.env,
    ), true)
    assert.equal(fs.existsSync(healthProbeFile), true)
    assert.equal(fs.existsSync(stoppedFile), false)
    return 'callback-result'
  })

  assert.equal(result, 'callback-result')
  assert.equal(await readWhenReady(attemptsFile), '2')
  assert.equal(await readWhenReady(stoppedFile), 'stopped')
  const probe = await readJsonWhenReady(probeFile)
  assert.deepEqual(probe.args, [
    '--no-color', '--log-level', 'info', 'gateway', 'run',
    '--bind', 'loopback',
    '--port', String(callbackPort),
    '--auth', 'token',
    '--tailscale', 'off',
    '--ws-log', 'compact',
  ])
  assert.equal(probe.hasToken, true)
  assert.equal(probe.tokenInArgs, false)
  assert.equal(probe.configPath, runtime.env.OPENCLAW_CONFIG_PATH)
  assert.equal(probe.home, runtime.env.OPENCLAW_HOME)
  assert.equal(probe.state, runtime.env.OPENCLAW_STATE_DIR)
  assert.ok(probe.temp.startsWith(runtime.env.OPENCLAW_HOME))
  const healthProbe = await readJsonWhenReady(healthProbeFile)
  assert.deepEqual(healthProbe.args, [
    '--no-color', '--log-level', 'info', 'gateway', 'health',
    '--port', String(callbackPort),
    '--timeout', '5000',
    '--json',
  ])
  assert.equal(healthProbe.hasToken, true)
  assert.equal(healthProbe.tokenInArgs, false)
  assert.equal(healthProbe.configPath, runtime.env.OPENCLAW_CONFIG_PATH)
})

test('Gateway lifecycle closes the process when the callback fails', async (t) => {
  const { withOpenClawGateway } = require('../../../src/agents/cli/cli-openclaw-gateway.cjs')
  const { directory, workdir } = fixture()
  const stoppedFile = path.join(directory, 'gateway-callback-failed.txt')
  const cli = executable(directory, 'openclaw-gateway-callback-failed.cjs', `
const fs = require('node:fs')
const args = process.argv.slice(2)
const globalArgs = ['--no-color', '--log-level', 'info']
const commandOffset = globalArgs.every((value, index) => args[index] === value)
  ? globalArgs.length
  : -1
if (commandOffset < 0) process.exit(2)
if (args[commandOffset + 1] === 'health') {
  process.stdout.write(JSON.stringify({ ok: true }))
  process.exit(0)
}
process.stdout.write('[gateway] ready\\n')
process.on('SIGTERM', () => {
  fs.writeFileSync(${JSON.stringify(stoppedFile)}, 'stopped')
  process.exit(0)
})
setInterval(() => {}, 1000)
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const runtime = nativeOpenClawOptions({
    storageRoot: directory,
    workdir,
    sessionRef: 'agent:main:gateway-callback-failed',
    runtime: nativeRuntime(),
  })

  await assert.rejects(() => withOpenClawGateway({
    executable: cli,
    workdir,
    ...runtime,
  }, async () => {
    throw new Error('CALLBACK_FAILED')
  }), { message: 'CALLBACK_FAILED' })
  assert.equal(await readWhenReady(stoppedFile), 'stopped')
})

test('Gateway lifecycle requires a healthy authenticated process before callback', async (t) => {
  const { withOpenClawGateway } = require('../../../src/agents/cli/cli-openclaw-gateway.cjs')
  for (const scenario of [
    { name: 'nonzero exit', output: JSON.stringify({ ok: true }), exitCode: 1 },
    { name: 'unhealthy JSON', output: JSON.stringify({ ok: false }), exitCode: 0 },
    { name: 'gateway exit', output: JSON.stringify({ ok: true }), exitCode: 0, stopGateway: true },
  ]) {
    await t.test(scenario.name, async (t) => {
      const { directory, workdir } = fixture()
      const gatewayPidFile = path.join(directory, 'gateway-health-pid.txt')
      const stoppedFile = path.join(directory, 'gateway-health-stopped.txt')
      const cli = executable(directory, `openclaw-gateway-health-${scenario.exitCode}.cjs`, `
const fs = require('node:fs')
const args = process.argv.slice(2)
const globalArgs = ['--no-color', '--log-level', 'info']
const commandOffset = globalArgs.every((value, index) => args[index] === value)
  ? globalArgs.length
  : -1
if (commandOffset < 0) process.exit(2)
if (args[commandOffset + 1] === 'health') {
  if (${JSON.stringify(Boolean(scenario.stopGateway))}) {
    process.kill(Number(fs.readFileSync(${JSON.stringify(gatewayPidFile)}, 'utf8')), 'SIGTERM')
    setTimeout(() => {
      process.stdout.write(${JSON.stringify(scenario.output)})
      process.exit(${scenario.exitCode})
    }, 50)
  } else {
    process.stdout.write(${JSON.stringify(scenario.output)})
    process.exit(${scenario.exitCode})
  }
} else {
  fs.writeFileSync(${JSON.stringify(gatewayPidFile)}, String(process.pid))
  process.stdout.write('[gateway] ready\\n')
  process.on('SIGTERM', () => {
    fs.writeFileSync(${JSON.stringify(stoppedFile)}, 'stopped')
    process.exit(0)
  })
  setInterval(() => {}, 1000)
}
`)
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
      const runtime = nativeOpenClawOptions({
        storageRoot: directory,
        workdir,
        sessionRef: `agent:main:gateway-health-${scenario.name}`,
        runtime: nativeRuntime(),
      })
      let callbackCalled = false

      await assert.rejects(() => withOpenClawGateway({
        executable: cli,
        workdir,
        ...runtime,
      }, async () => {
        callbackCalled = true
      }), { message: 'OPENCLAW_GATEWAY_START_FAILED' })
      assert.equal(callbackCalled, false)
      assert.equal(await readWhenReady(stoppedFile), 'stopped')
    })
  }
})

test('OpenClaw ACP keeps deterministic global CLI flags before the subcommand', () => {
  const sessionRef = 'agent:main:desktop-meldwork-test-openclaw'
  const spec = invocation('openclaw', '/tmp/openclaw', '/tmp/workspace', sessionRef, {
    sandbox: 'read-only',
  })

  assert.deepEqual(spec.args, [
    '--no-color', '--log-level', 'info', 'acp',
    '--session', sessionRef,
    '--no-prefix-cwd',
    '--verbose',
  ])
})

test('write authorization uses an immutable config and preserves the topic state', (t) => {
  const { directory, workdir } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const input = {
    storageRoot: directory,
    workdir,
    sessionRef: 'agent:main:desktop-meldwork-group-topic-openclaw',
    runtime: nativeRuntime(),
  }
  const readOnly = nativeOpenClawOptions(input)
  const writable = nativeOpenClawOptions({ ...input, allowWrite: true })
  const readOnlyConfig = JSON.parse(fs.readFileSync(readOnly.env.OPENCLAW_CONFIG_PATH, 'utf8'))
  const writableConfig = JSON.parse(fs.readFileSync(writable.env.OPENCLAW_CONFIG_PATH, 'utf8'))

  assert.equal(writable.env.OPENCLAW_STATE_DIR, readOnly.env.OPENCLAW_STATE_DIR)
  assert.notEqual(writable.env.OPENCLAW_CONFIG_PATH, readOnly.env.OPENCLAW_CONFIG_PATH)
  assert.equal(readOnlyConfig.tools.allow.includes('write'), false)
  assert.deepEqual(writableConfig.tools.allow.slice(-3), ['write', 'edit', 'apply_patch'])
  assert.ok(writableConfig.tools.deny.includes('exec'))
  assert.ok(writableConfig.tools.deny.includes('process'))
  assert.equal(writableConfig.tools.exec.security, 'deny')
})

test('native auth uses the isolated tool policy without importing user configuration', (t) => {
  const { directory, workdir } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const nativeOptions = nativeOpenClawOptions({
    storageRoot: directory,
    workdir,
    sessionRef: 'agent:main:desktop-meldwork-native-openclaw',
    runtime: {
      ...nativeRuntime(),
      provider: {
        ...nativeRuntime().provider,
        model: { ...nativeRuntime().provider.model, params: { unsafe: true } },
      },
      agentDir: '/Users/example/.openclaw/agents/main/agent',
      tools: { allow: ['exec'] },
    },
  })
  const nativeConfig = JSON.parse(fs.readFileSync(nativeOptions.env.OPENCLAW_CONFIG_PATH, 'utf8'))

  assert.deepEqual(nativeConfig.tools.allow, [
    'read', 'web_search', 'web_fetch', 'memory_search', 'memory_get', 'session_status',
  ])
  assert.equal(nativeConfig.models.mode, 'replace')
  assert.equal(nativeConfig.agents.defaults.model.primary, 'native/model')
  assert.equal(Object.hasOwn(nativeConfig.agents, 'list'), false)
  assert.equal(Object.hasOwn(nativeConfig, '$include'), false)
  assert.equal(Object.hasOwn(nativeConfig, 'plugins'), false)
  assert.equal(Object.hasOwn(nativeConfig, 'channels'), false)
  assert.deepEqual(Object.keys(nativeConfig.models.providers), ['native'])
  assert.deepEqual(nativeConfig.models.providers.native.apiKey, {
    source: 'env', provider: 'default', id: 'MELDWORK_OPENCLAW_NATIVE_API_KEY',
  })
  assert.equal(JSON.stringify(nativeConfig).includes('native-openclaw-key'), false)
  assert.equal(Object.hasOwn(nativeConfig.models.providers.native.models[0], 'params'), false)
  assert.equal(nativeOptions.env.MELDWORK_OPENCLAW_NATIVE_API_KEY, 'native-openclaw-key')
  assert.ok(nativeOptions.env.OPENCLAW_STATE_DIR.startsWith(fs.realpathSync(directory)))
})

test('native write mode remains workspace scoped and keeps high-risk tools denied', (t) => {
  const { directory, workdir } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const options = nativeOpenClawOptions({
    storageRoot: directory,
    workdir,
    allowWrite: true,
    runtime: nativeRuntime(),
  })
  const config = JSON.parse(fs.readFileSync(options.env.OPENCLAW_CONFIG_PATH, 'utf8'))

  assert.deepEqual(config.tools.allow.slice(-3), ['write', 'edit', 'apply_patch'])
  assert.equal(config.tools.fs.workspaceOnly, true)
  assert.ok(config.tools.deny.includes('exec'))
  assert.ok(config.tools.deny.includes('browser'))
  assert.ok(config.tools.deny.includes('message'))
  assert.ok(config.tools.deny.includes('sessions_spawn'))
  assert.equal(config.agents.defaults.workspace, workdir)
})

test('native runtime descriptors fail closed before a config is written', (t) => {
  const { directory, workdir } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  for (const runtime of [
    null,
    { ...nativeRuntime(), model: 'invalid model' },
    { ...nativeRuntime(), provider: { ...nativeRuntime().provider, id: 'native.id' } },
    { ...nativeRuntime(), provider: { ...nativeRuntime().provider, apiKey: '' } },
    {
      ...nativeRuntime(),
      provider: {
        ...nativeRuntime().provider,
        apiKey: { source: 'env', provider: 'default', id: 'GITHUB_TOKEN' },
      },
    },
    { ...nativeRuntime(), provider: { ...nativeRuntime().provider, api: 'invalid' } },
    { ...nativeRuntime(), provider: { ...nativeRuntime().provider, baseUrl: 'http://native.example/v1' } },
    {
      ...nativeRuntime(),
      provider: {
        ...nativeRuntime().provider,
        model: { ...nativeRuntime().provider.model, id: 'different' },
      },
    },
  ]) {
    assert.throws(() => nativeOpenClawOptions({
      storageRoot: directory, workdir, runtime,
    }), { message: 'OPENCLAW_NATIVE_RUNTIME_INVALID' })
  }
})

test('native runtime boundaries reject every SecretRef form', (t) => {
  const { directory, workdir } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const references = [
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

  for (const apiKey of references) {
    assert.throws(() => nativeOpenClawOptions({
      storageRoot: directory,
      workdir,
      runtime: {
        ...nativeRuntime(),
        provider: { ...nativeRuntime().provider, apiKey },
      },
    }), { message: 'OPENCLAW_NATIVE_RUNTIME_INVALID' })
  }
})

test('runtime paths reject pre-existing symlinks without writing outside app storage', {
  skip: process.platform === 'win32',
}, (t) => {
  const { directory, workdir } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const sessionRef = 'agent:main:symlink-test'
  const scope = runtimeScope(sessionRef, workdir)

  for (const position of ['managed', 'scope', 'home', 'state']) {
    const storageRoot = path.join(directory, `storage-${position}`)
    const external = path.join(directory, `external-${position}`)
    const managed = path.join(storageRoot, 'openclaw-managed')
    const runtimeRoot = path.join(managed, scope)
    fs.mkdirSync(storageRoot)
    fs.mkdirSync(external)
    if (position !== 'managed') fs.mkdirSync(managed)
    if (['home', 'state'].includes(position)) fs.mkdirSync(runtimeRoot)
    if (position === 'state') fs.mkdirSync(path.join(runtimeRoot, 'home'))
    const target = {
      managed,
      scope: runtimeRoot,
      home: path.join(runtimeRoot, 'home'),
      state: path.join(runtimeRoot, 'state'),
    }[position]
    fs.symlinkSync(external, target, 'dir')

    assert.throws(() => nativeOpenClawOptions({
      storageRoot,
      workdir,
      sessionRef,
      runtime: nativeRuntime(),
    }), { message: 'OPENCLAW_RUNTIME_UNSAFE_PATH' })
    assert.deepEqual(fs.readdirSync(external), [])
  }
})

test('runtime paths repair overly broad directory permissions', {
  skip: process.platform === 'win32',
}, (t) => {
  const { directory, workdir } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const storageRoot = path.join(directory, 'permission-storage')
  const sessionRef = 'agent:main:permission-test'
  const managed = path.join(storageRoot, 'openclaw-managed')
  const runtimeRoot = path.join(managed, runtimeScope(sessionRef, workdir))
  const directories = [managed, runtimeRoot, path.join(runtimeRoot, 'home'), path.join(runtimeRoot, 'state')]
  fs.mkdirSync(storageRoot)
  for (const target of directories) {
    fs.mkdirSync(target)
    fs.chmodSync(target, 0o777)
  }

  nativeOpenClawOptions({ storageRoot, workdir, sessionRef, runtime: nativeRuntime() })

  for (const target of directories) {
    assert.equal(fs.statSync(target).mode & 0o777, 0o700)
  }
})

test('runtime config atomically replaces a matching-content symlink before execution', {
  skip: process.platform === 'win32',
}, (t) => {
  const { directory, workdir } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const input = {
    storageRoot: directory,
    workdir,
    sessionRef: 'agent:main:config-symlink-test',
    runtime: nativeRuntime(),
  }
  const initial = nativeOpenClawOptions(input)
  const expected = fs.readFileSync(initial.env.OPENCLAW_CONFIG_PATH, 'utf8')
  const external = path.join(directory, 'external-openclaw.json')
  fs.writeFileSync(external, expected)
  fs.rmSync(initial.env.OPENCLAW_CONFIG_PATH)
  fs.symlinkSync(external, initial.env.OPENCLAW_CONFIG_PATH)

  const repaired = nativeOpenClawOptions(input)

  assert.equal(fs.lstatSync(repaired.env.OPENCLAW_CONFIG_PATH).isSymbolicLink(), false)
  assert.equal(fs.statSync(repaired.env.OPENCLAW_CONFIG_PATH).mode & 0o777, 0o600)
  fs.writeFileSync(external, JSON.stringify({ tools: { allow: ['exec'] } }))
  const config = JSON.parse(fs.readFileSync(repaired.env.OPENCLAW_CONFIG_PATH, 'utf8'))
  assert.equal(config.tools.allow.includes('exec'), false)
  assert.equal(config.tools.deny.includes('exec'), true)
})

test('runtime config creation revalidates parent identities before writing', {
  skip: process.platform === 'win32',
}, (t) => {
  const { directory, workdir } = fixture()
  const external = path.join(directory, 'external-runtime')
  fs.mkdirSync(external)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const originalRealpath = fs.realpathSync
  let redirected = false
  fs.realpathSync = function guardedRealpath(filename, ...args) {
    const resolved = originalRealpath.call(this, filename, ...args)
    if (!redirected && path.basename(String(filename)) === 'state') {
      redirected = true
      const runtimeRoot = path.dirname(String(filename))
      fs.renameSync(runtimeRoot, `${runtimeRoot}.original`)
      fs.symlinkSync(external, runtimeRoot, 'dir')
    }
    return resolved
  }

  try {
    assert.throws(() => nativeOpenClawOptions({
      storageRoot: directory,
      workdir,
      sessionRef: 'agent:main:runtime-parent-change',
      runtime: nativeRuntime(),
    }), { message: 'OPENCLAW_RUNTIME_UNSAFE_PATH' })
  } finally {
    fs.realpathSync = originalRealpath
  }
  assert.deepEqual(fs.readdirSync(external), [])
})

test('runtime guard rejects directory and config identity changes before execution', {
  skip: process.platform === 'win32',
}, (t) => {
  const { directory, workdir } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const directoryOptions = nativeOpenClawOptions({
    storageRoot: directory,
    workdir,
    sessionRef: 'agent:main:runtime-directory-guard',
    runtime: nativeRuntime(),
  })
  const runtimeRoot = path.dirname(directoryOptions.env.OPENCLAW_CONFIG_PATH)
  const originalRuntimeRoot = `${runtimeRoot}.original`
  const external = path.join(directory, 'external-runtime-guard')
  fs.mkdirSync(external)
  fs.renameSync(runtimeRoot, originalRuntimeRoot)
  fs.symlinkSync(external, runtimeRoot, 'dir')

  assert.throws(() => validateOpenClawRuntimeGuard(
    directoryOptions.openClawRuntimeGuard,
    directoryOptions.env,
  ), { message: 'OPENCLAW_RUNTIME_UNSAFE_PATH' })

  const fileOptions = nativeOpenClawOptions({
    storageRoot: directory,
    workdir,
    sessionRef: 'agent:main:runtime-file-guard',
    runtime: nativeRuntime(),
  })
  const configPath = fileOptions.env.OPENCLAW_CONFIG_PATH
  const contents = fs.readFileSync(configPath)
  fs.renameSync(configPath, `${configPath}.original`)
  fs.writeFileSync(configPath, contents, { mode: 0o600 })

  assert.throws(() => validateOpenClawRuntimeGuard(
    fileOptions.openClawRuntimeGuard,
    fileOptions.env,
  ), { message: 'OPENCLAW_RUNTIME_UNSAFE_PATH' })
})

test('runtime guard rejects in-place config and credential changes without exposing secret state', (t) => {
  const { directory, workdir } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const configOptions = nativeOpenClawOptions({
    storageRoot: directory,
    workdir,
    sessionRef: 'agent:main:runtime-content-guard',
    runtime: nativeRuntime(),
  })
  const serializedGuard = JSON.stringify(configOptions.openClawRuntimeGuard)
  const credentialDigest = crypto.createHash('sha256')
    .update(configOptions.env.MELDWORK_OPENCLAW_NATIVE_API_KEY)
    .digest('hex')
  const gatewayDigest = crypto.createHash('sha256')
    .update(configOptions.env.OPENCLAW_GATEWAY_TOKEN)
    .digest('hex')
  assert.equal(serializedGuard.includes(configOptions.env.MELDWORK_OPENCLAW_NATIVE_API_KEY), false)
  assert.equal(serializedGuard.includes(configOptions.env.OPENCLAW_GATEWAY_TOKEN), false)
  assert.equal(serializedGuard.includes(credentialDigest), false)
  assert.equal(serializedGuard.includes(gatewayDigest), false)

  const configPath = configOptions.env.OPENCLAW_CONFIG_PATH
  const originalIdentity = fs.statSync(configPath).ino
  const originalConfig = fs.readFileSync(configPath, 'utf8')
  fs.writeFileSync(configPath, originalConfig.replace('"read"', '"exec"'), { mode: 0o600 })
  assert.equal(fs.statSync(configPath).ino, originalIdentity)
  assert.throws(() => validateOpenClawRuntimeGuard(
    configOptions.openClawRuntimeGuard,
    configOptions.env,
  ), { message: 'OPENCLAW_RUNTIME_UNSAFE_PATH' })

  const credentialOptions = nativeOpenClawOptions({
    storageRoot: directory,
    workdir,
    sessionRef: 'agent:main:runtime-credential-guard',
    runtime: nativeRuntime(),
  })
  assert.throws(() => validateOpenClawRuntimeGuard(
    credentialOptions.openClawRuntimeGuard,
    {
      ...credentialOptions.env,
      MELDWORK_OPENCLAW_NATIVE_API_KEY: 'tampered-openclaw-key',
    },
  ), { message: 'OPENCLAW_RUNTIME_CREDENTIAL_SCOPE_INVALID' })
  assert.throws(() => validateOpenClawRuntimeGuard(
    credentialOptions.openClawRuntimeGuard,
    {
      ...credentialOptions.env,
      OPENCLAW_GATEWAY_TOKEN: 'tampered-gateway-token',
    },
  ), { message: 'OPENCLAW_RUNTIME_CREDENTIAL_SCOPE_INVALID' })
})

test('runtime guard rejects permissions broadened after creation', {
  skip: process.platform === 'win32',
}, (t) => {
  const { directory, workdir } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  for (const target of ['directory', 'config']) {
    const options = nativeOpenClawOptions({
      storageRoot: directory,
      workdir,
      sessionRef: `agent:main:runtime-${target}-permission-guard`,
      runtime: nativeRuntime(),
    })
    fs.chmodSync(
      target === 'directory' ? options.env.OPENCLAW_HOME : options.env.OPENCLAW_CONFIG_PATH,
      target === 'directory' ? 0o755 : 0o644,
    )
    assert.throws(() => validateOpenClawRuntimeGuard(
      options.openClawRuntimeGuard,
      options.env,
    ), { message: 'OPENCLAW_RUNTIME_UNSAFE_PATH' })
  }
})

test('runtime paths are stable and isolated per topic and workspace', (t) => {
  const { directory, workdir } = fixture()
  const otherWorkdir = path.join(directory, 'workspace-other')
  fs.mkdirSync(otherWorkdir)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const input = {
    storageRoot: directory,
    workdir,
    sessionRef: 'agent:main:desktop-meldwork-group-topic-openclaw',
    runtime: nativeRuntime(),
  }

  const first = nativeOpenClawOptions(input)
  const repeated = nativeOpenClawOptions(input)
  const otherTopic = nativeOpenClawOptions({ ...input, sessionRef: `${input.sessionRef}-other` })
  const otherWorkspace = nativeOpenClawOptions({ ...input, workdir: otherWorkdir })

  assert.equal(repeated.env.OPENCLAW_STATE_DIR, first.env.OPENCLAW_STATE_DIR)
  assert.notEqual(otherTopic.env.OPENCLAW_STATE_DIR, first.env.OPENCLAW_STATE_DIR)
  assert.notEqual(otherWorkspace.env.OPENCLAW_STATE_DIR, first.env.OPENCLAW_STATE_DIR)
  assert.equal(otherWorkspace.env.OPENCLAW_WORKSPACE_DIR, otherWorkdir)
})

test('invalid runtime scopes fail closed', (t) => {
  const { directory, workdir } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  assert.throws(() => nativeOpenClawOptions({
    storageRoot: 'relative', workdir, runtime: nativeRuntime(),
  }), { message: 'OPENCLAW_RUNTIME_INVALID_SCOPE' })
})

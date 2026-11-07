const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { serializeAgentConnectorManifest } = require('../../src/agents/connectors/agent-connector-manifest.cjs')
const {
  SAMPLE_AGENT_CONNECTOR_MANIFEST,
  SAMPLE_CREDENTIAL_AGENT_CONNECTOR_MANIFEST,
  SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE,
} = require('../../src/agents/connectors/agent-connector-local.cjs')
const { serializeAgentConnectorPackage } = require('../../src/agents/connectors/agent-connector-package-store.cjs')
const {
  LOCAL_IPC_CHANNELS,
  deferred,
  eventFor,
  loadMain,
  pngHeader,
  waitFor,
} = require('../support/main-security-test-harness.cjs')

test('local desktop authorization requires the current main frame and exact frontend file', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-main-security-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { main } = loadMain(directory)
  const frontend = path.join(directory, 'frontend', 'index.html')
  const frontendUrl = `${pathToFileURL(frontend).href}?desktop=1#/chat`
  const trusted = eventFor(frontendUrl)

  assert.equal(main.isTrustedLocalRenderer(trusted.event, trusted.sender, frontend), true)
  assert.equal(main.isTrustedLocalWebContents(trusted.sender, frontend), true)
  assert.equal(main.isTrustedLocalRenderer({
    sender: trusted.sender,
    senderFrame: { url: frontendUrl, processId: 1, routingId: 999 },
  }, trusted.sender, frontend), false)
  assert.equal(main.isTrustedLocalRenderer(
    eventFor(pathToFileURL(path.join(directory, 'offline.html')).href).event,
    trusted.sender,
    frontend,
  ), false)
})

test('a second desktop process exits before ready initialization', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-single-instance-denied-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory, { singleInstanceLock: false })

  assert.equal(harness.singleInstanceLockCalls, 1)
  assert.equal(harness.quitCount, 1)
  assert.equal(harness.readyRegistered, false)
  assert.equal(harness.workspaceInstances.length, 0)
  assert.equal(harness.windows.length, 0)
})

test('product data migration failure stops ready initialization before stores or windows', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-migration-startup-stop-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const diagnostic = { status: 'recovery-required', failedStep: 3, rollbackFailures: [{}] }
  const reported = []
  const originalError = console.error
  console.error = (...args) => { reported.push(args) }
  t.after(() => { console.error = originalError })
  const { harness } = loadMain(directory, {
    moduleMocks: {
      './product-data-migration.cjs': {
        migrateLegacyProductData: () => {
          throw Object.assign(new Error('MELDWORK_PRODUCT_DATA_MIGRATION_RECOVERY_REQUIRED'), {
            code: 'MELDWORK_PRODUCT_DATA_MIGRATION_RECOVERY_REQUIRED',
            diagnostic,
          })
        },
      },
    },
  })

  await harness.ready()

  assert.equal(harness.quitCount, 1)
  assert.equal(harness.workspaceInstances.length, 0)
  assert.equal(harness.knowledgeBaseStoreInstances.length, 0)
  assert.equal(harness.windows.length, 0)
  assert.deepEqual(reported, [[
    'MELDWORK_PRODUCT_DATA_MIGRATION_ABORTED', diagnostic,
  ]])
})

test('a corrupt run ledger opens a recovery page without changing the history', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-ledger-startup-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'meldwork-run-ledger.json')
  const original = '{invalid ledger'
  fs.writeFileSync(filename, original)
  class WorkspaceWithLedger {
    constructor(input) { input.runLedger.reconcileContextPacks(() => null) }
  }
  const { harness } = loadMain(directory, {
    moduleMocks: { './workspace/local-workspace.cjs': { LocalWorkspace: WorkspaceWithLedger } },
  })
  await harness.ready()
  assert.equal(fs.readFileSync(filename, 'utf8'), original)
  assert.equal(harness.windows.length, 1)
  assert.match(harness.windows[0].loads[0].filename, /offline\.html$/)
  assert.deepEqual(harness.windows[0].loads[0].options, { query: { code: 'RUN_LEDGER_LOAD_FAILED' } })
  assert.equal(harness.ipcHandlers.has('local-workspace:send-message'), false)
  harness.windows[0].windowListeners.get('closed')()
  harness.appListeners.get('second-instance')()
  assert.equal(harness.windows.length, 2)
  assert.match(harness.windows[1].loads[0].filename, /offline\.html$/)
  assert.deepEqual(harness.windows[1].loads[0].options, { query: { code: 'RUN_LEDGER_LOAD_FAILED' } })
  assert.equal(fs.readFileSync(filename, 'utf8'), original)
})

test('the ledger recovery page explains data preservation in Chinese and English', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../src/offline.html'), 'utf8')
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script)
  for (const [language, expected] of [['zh-CN', '备份'], ['en-US', 'Back up']]) {
    const elements = Object.fromEntries(['status', 'title', 'message', 'error-code'].map(id => [id, { textContent: '' }]))
    const document = { documentElement: {}, querySelector: selector => elements[selector.slice(1)] }
    require('node:vm').runInNewContext(script, {
      navigator: { language }, document, location: { search: '?code=RUN_LEDGER_LOAD_FAILED' }, URLSearchParams,
    })
    assert.match(elements.message.textContent, new RegExp(expected))
    assert.match(elements['error-code'].textContent, /RUN_LEDGER_LOAD_FAILED/)
  }
})

test('desktop startup restricts existing application-owned data directories', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX permissions are not Windows ACLs')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-private-startup-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const privateRoot = path.join(directory, 'meldwork-private')
  fs.mkdirSync(privateRoot)
  fs.chmodSync(directory, 0o755)
  fs.chmodSync(privateRoot, 0o755)
  const { harness } = loadMain(directory)
  await harness.ready()
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700)
  assert.equal(fs.statSync(privateRoot).mode & 0o777, 0o700)
})

test('controlled media protocol serves attachment bytes with range support and rejects invalid ids', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-media-protocol-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const mediaBytes = Buffer.from('ID3-audio-payload')
  const { harness } = loadMain(directory, {
    mediaMetadata: {
      id: 'generated-audio', name: 'briefing.mp3', mimeType: 'audio/mpeg', size: mediaBytes.length,
    },
    mediaBytes,
  })

  assert.equal(harness.registeredSchemes.some(entry => (
    entry.scheme === 'meldwork-media'
      && entry.privileges?.secure === true
      && entry.privileges?.standard === true
  )), true)
  await harness.ready()
  const handler = harness.protocolHandlers.get('meldwork-media')
  assert.equal(typeof handler, 'function')

  const response = await handler(new Request(
    'meldwork-media://attachment/generated-audio',
    { headers: { Range: 'bytes=4-8' } },
  ))
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('content-type'), 'audio/mpeg')
  assert.equal(response.headers.get('content-range'), `bytes 4-8/${mediaBytes.length}`)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), mediaBytes.subarray(4, 9))

  const readsBeforeInvalid = harness.attachmentInstances[0].readWithMetadataCalls.length
  const invalid = await handler(new Request('meldwork-media://attachment/..%2Fsecret'))
  assert.equal(invalid.status, 404)
  assert.equal(harness.attachmentInstances[0].readWithMetadataCalls.length, readsBeforeInvalid)
})

test('every local IPC handler rejects an untrusted renderer before dispatch', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-ipc-security-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory)
  await harness.ready()

  assert.deepEqual([...harness.ipcHandlers.keys()], LOCAL_IPC_CHANNELS)
  const trustedEvent = harness.event()
  const untrustedEvent = {
    sender: trustedEvent.sender,
    senderFrame: {
      ...trustedEvent.senderFrame,
      routingId: trustedEvent.senderFrame.routingId + 1,
    },
  }
  for (const channel of LOCAL_IPC_CHANNELS) {
    await assert.rejects(
      async () => harness.ipcHandlers.get(channel)(untrustedEvent),
      { message: 'DESKTOP_CLIENT_ACCESS_DENIED' },
      channel,
    )
  }
})

test('detected Agent verification directory stays internal to the main process', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-native-identity-main-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const nativeHome = path.join(directory, 'private-hermes')
  const { harness } = loadMain(directory, {
    nativeShellEnvironment: () => ({ env: { HERMES_HOME: nativeHome }, source: 'native-shell' }),
    detectAgents: () => [{ kind: 'hermes', version: '1', compatibilityState: 'compatible' }],
  })
  await harness.ready()
  const [agent] = await harness.installerInstances[0].input.detectAgents()
  const { NATIVE_CONFIG_IDENTITY_DIRECTORY } = require('../../src/agents/native-config-directory.cjs')
  assert.equal(agent[NATIVE_CONFIG_IDENTITY_DIRECTORY], nativeHome)
  assert.doesNotMatch(JSON.stringify({ ...agent }), /private-hermes/)
})

test('Zcode native configuration changes invalidate its private verification identity', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-zcode-auth-main-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const nativeHome = path.join(directory, 'private-home')
  const nativeConfig = path.join(nativeHome, '.zcode', 'cli', 'config.json')
  fs.mkdirSync(path.dirname(nativeConfig), { recursive: true })
  fs.writeFileSync(nativeConfig, '{"model":{"main":"first/model"}}')
  const { harness } = loadMain(directory, {
    nativeShellEnvironment: () => ({ env: { HOME: nativeHome, USERPROFILE: nativeHome }, source: 'native-shell' }),
    detectAgents: () => [{ kind: 'zcode', version: '1', compatibilityState: 'compatible' }],
  })
  await harness.ready()
  const [agent] = await harness.installerInstances[0].input.detectAgents()
  const { agentVerificationIdentity } = require('../../src/workspace/agent-verification-identity.cjs')
  const first = agentVerificationIdentity(agent)
  fs.writeFileSync(nativeConfig, '{"model":{"main":"replacement/model"}}')
  assert.notEqual(agentVerificationIdentity(agent), first)
  assert.doesNotMatch(JSON.stringify({ ...agent }), /private-home|replacement/)
})

test('OpenCode authentication identity remains private and follows the native XDG data directory', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-opencode-auth-main-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const data = path.join(directory, 'private-data')
  fs.mkdirSync(path.join(data, 'opencode'), { recursive: true })
  const auth = path.join(data, 'opencode', 'auth.json')
  fs.writeFileSync(auth, '{"provider":{"type":"api","key":"first"}}')
  const { harness } = loadMain(directory, {
    nativeShellEnvironment: () => ({ env: { XDG_DATA_HOME: data }, source: 'native-shell' }),
    detectAgents: () => [{ kind: 'opencode', version: '1', compatibilityState: 'compatible' }],
  })
  await harness.ready()
  const [agent] = await harness.installerInstances[0].input.detectAgents()
  const { agentVerificationIdentity } = require('../../src/workspace/agent-verification-identity.cjs')
  const first = agentVerificationIdentity(agent)
  fs.writeFileSync(auth, '{"provider":{"type":"api","key":"replacement"}}')
  assert.notEqual(agentVerificationIdentity(agent), first)
  assert.doesNotMatch(JSON.stringify({ ...agent }), /private-data|replacement/)
})

test('native credential changes invalidate the main-process Agent identity without exposing credentials', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-native-env-identity-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let credential = 'first-private-key'
  const { harness } = loadMain(directory, {
    nativeShellEnvironment: () => ({ env: { OPENAI_API_KEY: credential }, source: 'native-shell' }),
    nativeEnvironment: (_kind, env) => ({ OPENAI_API_KEY: env.OPENAI_API_KEY }),
    detectAgents: () => [{ kind: 'hermes', version: '1', compatibilityState: 'compatible' }],
  })
  await harness.ready()
  const { agentVerificationIdentity } = require('../../src/workspace/agent-verification-identity.cjs')
  const [first] = await harness.installerInstances[0].input.detectAgents()
  credential = 'second-private-key'
  const [second] = await harness.installerInstances[0].input.detectAgents()
  assert.notEqual(agentVerificationIdentity(first), agentVerificationIdentity(second))
  assert.doesNotMatch(JSON.stringify({ ...first, ...second }), /private-key|OPENAI_API_KEY/)
})

test('Pi native configuration declarations reach discovery and execution', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-pi-env-main-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'models.json'), '{}')
  let discoveryKeys
  let selectedDirectory
  const { harness } = loadMain(directory, {
    nativeShellEnvironment: input => ({ env: input.extraEnvKeys?.includes('CUSTOM_TOKEN')
      ? { CUSTOM_TOKEN: 'private-value' } : {}, source: 'native-shell' }),
    piDeclaredCredentialKeys: input => { selectedDirectory = input.env.PI_CODING_AGENT_DIR; return ['CUSTOM_TOKEN'] },
    nativeEnvironment: (_kind, env, keys) => keys?.includes('CUSTOM_TOKEN') ? { CUSTOM_TOKEN: env.CUSTOM_TOKEN } : {},
    detectAgents: input => { discoveryKeys = input.nativeCredentialKeysForKind('pi'); return [] },
  })
  await harness.ready()
  const workspace = harness.workspaceInstances[0]
  workspace.state.agentPreferences = { pi: { nativeConfigDirectory: directory } }
  await harness.installerInstances[0].input.detectAgents()
  assert.equal(selectedDirectory, directory)
  assert.deepEqual(discoveryKeys, ['CUSTOM_TOKEN'])
  await workspace.input.runAgent({ kind: 'pi', executable: '/tmp/pi' }, 'hello', directory, {})
  const options = harness.runAgentCalls.at(-1)[3]
  assert.equal(options.env.CUSTOM_TOKEN, 'private-value')
  assert.deepEqual(options.nativeCredentialKeys, ['CUSTOM_TOKEN'])
})

test('caller cannot add native credential declarations to an Agent subprocess', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-native-env-untrusted-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory, {
    nativeShellEnvironment: () => ({ env: {}, source: 'native-shell' }),
  })
  await harness.ready()
  const agent = { kind: 'pi', executable: '/tmp/pi' }
  await harness.workspaceInstances[0].input.runAgent(agent, 'hello', directory, {
    nativeCredentialKeys: ['UNTRUSTED_TOKEN', 'NODE_OPTIONS'],
    env: { UNTRUSTED_TOKEN: 'synthetic-secret', NODE_OPTIONS: '--require evil' },
  })
  const options = harness.runAgentCalls.at(-1)[3]
  assert.equal(options.nativeCredentialKeys.includes('UNTRUSTED_TOKEN'), false)
  const { childEnvironment } = require('../../src/agents/cli/cli-process-support.cjs')
  const child = childEnvironment(agent, directory, options, process.platform)
  assert.equal(child.UNTRUSTED_TOKEN, undefined)
  assert.equal(child.NODE_OPTIONS, undefined)
})

test('OpenCode project provider references reach its execution without leaking to other Agents', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-opencode-env-main-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'opencode.json'), JSON.stringify({ provider: {
    custom: { options: { apiKey: '{env:PROJECT_PROVIDER_KEY}' } },
  } }))
  const readiness = require('../../src/agents/local-agent-readiness.cjs')
  const { harness } = loadMain(directory, {
    nativeShellEnvironment: input => ({ env: input.extraEnvKeys?.includes('PROJECT_PROVIDER_KEY')
      ? { PROJECT_PROVIDER_KEY: 'synthetic-project-secret' } : {}, source: 'native-shell' }),
    nativeEnvironment: readiness.nativeCredentialEnvironment,
  })
  await harness.ready()
  const workspace = harness.workspaceInstances[0]
  await workspace.input.runAgent({ kind: 'opencode', executable: '/tmp/opencode' }, 'hello', directory, {})
  const options = harness.runAgentCalls.at(-1)[3]
  assert.equal(options.env.PROJECT_PROVIDER_KEY, 'synthetic-project-secret')
  assert.ok(options.nativeCredentialKeys.includes('PROJECT_PROVIDER_KEY'))
  await workspace.input.runAgent({ kind: 'codex', executable: '/tmp/codex' }, 'hello', directory, {})
  assert.equal(harness.runAgentCalls.at(-1)[3].env.PROJECT_PROVIDER_KEY, undefined)
})

test('OpenCode resolves a shell-selected model before collecting its provider credentials', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-opencode-model-env-main-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const cache = path.join(directory, 'cache', 'opencode')
  fs.mkdirSync(cache, { recursive: true })
  fs.writeFileSync(path.join(cache, 'models.json'), JSON.stringify({ groq: { env: ['GROQ_API_KEY'] } }))
  fs.writeFileSync(path.join(directory, 'opencode.json'), JSON.stringify({ model: '{env:MODEL_CHOICE}' }))
  const readiness = require('../../src/agents/local-agent-readiness.cjs')
  const { harness } = loadMain(directory, {
    nativeShellEnvironment: input => ({ env: { XDG_CACHE_HOME: path.dirname(cache),
      ...(input.extraEnvKeys?.includes('MODEL_CHOICE') ? { MODEL_CHOICE: 'groq/model' } : {}),
      ...(input.extraEnvKeys?.includes('GROQ_API_KEY') ? { GROQ_API_KEY: 'synthetic-secret' } : {}) }, source: 'native-shell' }),
    nativeEnvironment: readiness.nativeCredentialEnvironment,
  })
  await harness.ready()
  const workspace = harness.workspaceInstances[0]
  await workspace.input.runAgent({ kind: 'opencode', executable: '/tmp/opencode' }, 'hello', directory, {})
  const options = harness.runAgentCalls.at(-1)[3]
  assert.equal(options.env.MODEL_CHOICE, 'groq/model')
  assert.equal(options.env.GROQ_API_KEY, 'synthetic-secret')
  await workspace.input.runAgent({ kind: 'codex', executable: '/tmp/codex' }, 'hello', directory, {})
  assert.equal(harness.runAgentCalls.at(-1)[3].env.GROQ_API_KEY, undefined)
})

test('OpenCode default model discovery captures only present native provider credentials', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-opencode-default-env-main-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const cache = path.join(directory, 'cache', 'opencode')
  fs.mkdirSync(cache, { recursive: true })
  const providers = Object.fromEntries(Array.from({ length: 180 }, (_, index) => [
    `provider-${index}`, { env: [`PROVIDER_${String(index).padStart(3, '0')}_API_KEY`] },
  ]))
  fs.writeFileSync(path.join(cache, 'models.json'), JSON.stringify(providers))
  const readiness = require('../../src/agents/local-agent-readiness.cjs')
  const { harness } = loadMain(directory, {
    nativeShellEnvironment: input => ({ env: { XDG_CACHE_HOME: path.dirname(cache),
      ...(input.extraEnvKeys?.includes('PROVIDER_179_API_KEY') ? { PROVIDER_179_API_KEY: 'synthetic-secret' } : {}) }, source: 'native-shell' }),
    nativeEnvironment: readiness.nativeCredentialEnvironment,
  })
  await harness.ready()
  const workspace = harness.workspaceInstances[0]
  await workspace.input.runAgent({ kind: 'opencode', executable: '/tmp/opencode' }, 'hello', directory, {})
  const options = harness.runAgentCalls.at(-1)[3]
  assert.equal(options.env.PROVIDER_179_API_KEY, 'synthetic-secret')
  assert.ok(options.nativeCredentialKeys.includes('PROVIDER_179_API_KEY'))
  assert.equal(options.nativeCredentialKeys.includes('PROVIDER_000_API_KEY'), false)
  await workspace.input.runAgent({ kind: 'codex', executable: '/tmp/codex' }, 'hello', directory, {})
  assert.equal(harness.runAgentCalls.at(-1)[3].env.PROVIDER_179_API_KEY, undefined)
})

test('OpenCode does not forward credentials for providers disabled by a resolved environment setting', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-opencode-enabled-main-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const cache = path.join(directory, 'cache', 'opencode')
  fs.mkdirSync(cache, { recursive: true })
  fs.writeFileSync(path.join(cache, 'models.json'), JSON.stringify({
    deepseek: { env: ['DEEPSEEK_API_KEY'] }, groq: { env: ['GROQ_API_KEY'] },
  }))
  fs.writeFileSync(path.join(directory, 'opencode.json'), JSON.stringify({ enabled_providers: ['{env:ENABLED_PROVIDER}'] }))
  const readiness = require('../../src/agents/local-agent-readiness.cjs')
  const values = { ENABLED_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'deepseek-secret', GROQ_API_KEY: 'groq-secret' }
  const { harness } = loadMain(directory, {
    nativeShellEnvironment: input => ({ env: { XDG_CACHE_HOME: path.dirname(cache),
      ...Object.fromEntries((input.extraEnvKeys || []).filter(key => Object.hasOwn(values, key)).map(key => [key, values[key]])) },
    source: 'native-shell' }),
    nativeEnvironment: readiness.nativeCredentialEnvironment,
  })
  await harness.ready()
  const workspace = harness.workspaceInstances[0]
  await workspace.input.runAgent({ kind: 'opencode', executable: '/tmp/opencode' }, 'hello', directory, {})
  const options = harness.runAgentCalls.at(-1)[3]
  assert.equal(options.env.DEEPSEEK_API_KEY, 'deepseek-secret')
  assert.equal(options.env.GROQ_API_KEY, undefined)
})

test('selected OpenCode configuration supplies its declared credentials to execution', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-opencode-selected-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const selected = path.join(directory, 'selected'); fs.mkdirSync(selected)
  fs.writeFileSync(path.join(selected, 'opencode.jsonc'), '{ provider: { custom: { options: { apiKey: "{env:SELECTED_KEY}" } } } }')
  const readiness = require('../../src/agents/local-agent-readiness.cjs')
  const { harness } = loadMain(directory, {
    dialogResult: { canceled: false, filePaths: [selected] },
    nativeShellEnvironment: input => ({ env: input.extraEnvKeys?.includes('SELECTED_KEY')
      ? { SELECTED_KEY: 'selected-secret' } : {}, source: 'native-shell' }),
    nativeEnvironment: readiness.nativeCredentialEnvironment,
  })
  await harness.ready()
  const workspace = harness.workspaceInstances[0]
  workspace.activeRuns = new Map()
  workspace.state.agentPreferences = {}
  workspace.state.agentRuntime = {}
  workspace.save = () => {}
  const chosen = await harness.ipcHandlers.get('local-agent-native-config:choose')(harness.event(), 'opencode')
  assert.equal(chosen.directory, fs.realpathSync(selected))
  await workspace.input.runAgent({ kind: 'opencode', executable: '/tmp/opencode' }, 'hello', directory, {})
  const options = harness.runAgentCalls.at(-1)[3]
  assert.equal(options.env.OPENCODE_CONFIG_DIR, chosen.directory)
  assert.equal(options.env.SELECTED_KEY, 'selected-secret')
})

test('selected Gemini configuration uses its parent as the native CLI home', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-gemini-selected-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const selected = path.join(directory, '.gemini'); fs.mkdirSync(selected)
  fs.writeFileSync(path.join(selected, 'settings.json'), '{}')
  const readiness = require('../../src/agents/local-agent-readiness.cjs')
  const { harness } = loadMain(directory, {
    dialogResult: { canceled: false, filePaths: [selected] },
    nativeShellEnvironment: () => ({ env: { GEMINI_CLI_HOME: '/previous' }, source: 'native-shell' }),
    nativeEnvironment: readiness.nativeCredentialEnvironment,
  })
  await harness.ready()
  const workspace = harness.workspaceInstances[0]
  workspace.state.agentPreferences = {}
  workspace.state.agentRuntime = {}
  workspace.activeRuns = new Map()
  workspace.save = () => {}
  const chosen = await harness.ipcHandlers.get('local-agent-native-config:choose')(harness.event(), 'gemini')
  assert.equal(chosen.directory, selected)
  await workspace.input.runAgent({ kind: 'gemini', executable: '/tmp/gemini' }, 'hello', directory, {})
  assert.equal(harness.runAgentCalls.at(-1)[3].env.GEMINI_CLI_HOME, directory)
})

test('native credentials from multiple Agents are captured in bounded batches without restoring unset values', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-native-env-batches-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const hermesKeys = Array.from({ length: 20 }, (_, index) => `HERMES_TEST_KEY_${index}`)
  const piKeys = Array.from({ length: 40 }, (_, index) => `PI_TEST_KEY_${index}`)
  const unset = piKeys.at(-1)
  const previous = process.env[unset]
  process.env[unset] = 'stale-process-value'
  t.after(() => { if (previous === undefined) delete process.env[unset]; else process.env[unset] = previous })
  const queries = []
  const readiness = require('../../src/agents/local-agent-readiness.cjs')
  const { harness } = loadMain(directory, {
    hermesDeclaredCredentialKeys: () => hermesKeys,
    piDeclaredCredentialKeys: () => piKeys,
    nativeEnvironment: readiness.nativeCredentialEnvironment,
    nativeShellEnvironment: input => {
      const keys = input.extraEnvKeys || []
      if (keys.length) queries.push(keys)
      return { source: 'native-shell', env: Object.fromEntries(keys.filter(key => key !== unset).map(key => [key, `value-${key}`])),
        unsetKeys: keys.includes(unset) ? [unset] : [] }
    },
  })
  await harness.ready()
  await harness.workspaceInstances[0].input.runAgent({ kind: 'pi', executable: '/tmp/pi' }, 'hello', directory, {})
  const options = harness.runAgentCalls.at(-1)[3]
  assert.ok(queries.some(keys => keys.length === 32))
  assert.ok(queries.some(keys => keys.includes(piKeys[38])))
  assert.ok(queries.every(keys => keys.length <= 32))
  assert.equal(options.env[piKeys[38]], `value-${piKeys[38]}`)
  assert.equal(options.env[hermesKeys[0]], undefined)
  assert.equal(options.env[unset], undefined)
  assert.ok(options.nativeUnsetKeys.includes(unset))
})

test('native Agent configuration selection is validated and used for execution', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-native-config-ipc-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const native = path.join(directory, 'hermes-native')
  fs.mkdirSync(native)
  fs.writeFileSync(path.join(native, 'config.yaml'), 'model:\n  provider: "custom:work"\n  api_key: synthetic-secret\n')
  const selection = { canceled: false, filePaths: [native] }
  let detectedEnvironment
  let credentialEnvironment
  const { harness } = loadMain(directory, { dialogResult: selection,
    nativeShellEnvironment: () => ({ env: {}, source: 'native-shell' }),
    nativeEnvironment: (_kind, env) => ({ HERMES_HOME: env.HERMES_HOME }),
    detectAgents: input => { detectedEnvironment = input.nativeEnvironmentForKind('hermes'); return [] },
    nativeCredentialState: (_kind, input) => { credentialEnvironment = input.env; return { state: 'ready', source: 'native-credential' } },
  })
  await harness.ready()
  const workspace = harness.workspaceInstances[0]
  workspace.state.agentPreferences = {}
  workspace.state.agentRuntime = {}
  workspace.activeRuns = new Map()
  workspace.save = () => {}
  const choose = harness.ipcHandlers.get('local-agent-native-config:choose')
  const get = harness.ipcHandlers.get('local-agent-native-config:get')
  const clear = harness.ipcHandlers.get('local-agent-native-config:clear')
  await assert.rejects(() => choose(harness.event(), 'unsupported'), { message: 'LOCAL_NATIVE_CONFIG_INVALID' })
  const invalidations = harness.skillCatalogInstances[0].invalidateCalls
  const chosen = await choose(harness.event(), 'hermes')
  assert.equal(harness.skillCatalogInstances[0].invalidateCalls, invalidations + 1)
  assert.equal(chosen.directory, fs.realpathSync(native))
  assert.equal((await get(harness.event(), 'hermes')).directory, chosen.directory)
  const summary = await get(harness.event(), 'hermes')
  assert.equal(summary.provider, 'custom:work')
  assert.doesNotMatch(JSON.stringify(summary), /synthetic-secret/)
  await harness.installerInstances[0].input.detectAgents()
  assert.equal(detectedEnvironment.HERMES_HOME, chosen.directory)
  await workspace.input.credentialState('hermes', { executable: '/tmp/hermes' })
  assert.equal(credentialEnvironment.HERMES_HOME, chosen.directory)
  await workspace.input.runAgent({ kind: 'hermes', executable: '/tmp/hermes' }, 'hello', directory, { env: { HERMES_HOME: '/other' } })
  assert.equal(harness.runAgentCalls.at(-1)[3].env.HERMES_HOME, chosen.directory)
  selection.filePaths = [directory]
  await assert.rejects(() => choose(harness.event(), 'hermes'), { message: 'LOCAL_NATIVE_CONFIG_INVALID' })
  assert.equal((await get(harness.event(), 'hermes')).directory, chosen.directory)
  fs.unlinkSync(path.join(native, 'config.yaml'))
  const missing = await get(harness.event(), 'hermes')
  assert.equal(missing.directory, chosen.directory)
  assert.equal(missing.directoryMissing, true)
  assert.doesNotMatch(JSON.stringify(missing), /synthetic-secret/)
  assert.deepEqual(await workspace.input.credentialState('hermes', { executable: '/tmp/hermes' }),
    { state: 'unknown', source: 'native-runtime-unavailable' })
  const previousCalls = harness.runAgentCalls.length
  await assert.rejects(() => workspace.input.runAgent({ kind: 'hermes', executable: '/tmp/hermes' },
    'hello', directory, {}), { message: 'LOCAL_NATIVE_CONFIG_INVALID' })
  assert.equal(harness.runAgentCalls.length, previousCalls)
  workspace.activeRuns.set('busy', {})
  await assert.rejects(() => clear(harness.event(), 'hermes'), { message: 'LOCAL_WORK_PREFERENCES_BUSY' })
  workspace.activeRuns.clear()
  assert.equal((await clear(harness.event(), 'hermes')).directory, '')
  assert.equal((await get(harness.event(), 'hermes')).directory, '')
})

test('shell-unset provider credentials are not restored from the desktop process', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-shell-unset-main-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const previous = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = 'stale-provider-secret'
  t.after(() => {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previous
  })
  const readiness = require('../../src/agents/local-agent-readiness.cjs')
  const { harness } = loadMain(directory, {
    nativeEnvironment: readiness.nativeCredentialEnvironment,
    nativeShellEnvironment: () => ({ source: 'native-shell', env: {}, unsetKeys: ['ANTHROPIC_API_KEY', 'HTTPS_PROXY'] }),
  })
  await harness.ready()
  await harness.workspaceInstances[0].input.runAgent({ kind: 'claude', executable: '/tmp/claude' }, 'hello', directory, {})
  assert.equal(harness.runAgentCalls.at(-1)[3].env.ANTHROPIC_API_KEY, undefined)
  assert.deepEqual(harness.runAgentCalls.at(-1)[3].nativeUnsetKeys, ['ANTHROPIC_API_KEY', 'HTTPS_PROXY'])
})

test('Codex selected config passes its declared credential only to Codex', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-codex-env-main-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const native = path.join(directory, 'native'); fs.mkdirSync(native)
  fs.writeFileSync(path.join(native, 'config.toml'), "model_provider = 'custom'\n[model_providers.custom]\nenv_key = 'CUSTOM_CREDENTIAL'\n")
  const readiness = require('../../src/agents/local-agent-readiness.cjs')
  const { harness } = loadMain(directory, {
    codexDeclaredCredentialKeys: readiness.codexDeclaredCredentialKeys,
    nativeEnvironment: readiness.nativeCredentialEnvironment,
    nativeShellEnvironment: input => ({ source: 'native-shell', env: input.extraEnvKeys?.includes('CUSTOM_CREDENTIAL')
      ? { CUSTOM_CREDENTIAL: 'synthetic-secret', UNRELATED_SECRET: 'private' } : {} }),
  })
  await harness.ready()
  harness.workspaceInstances[0].state.agentPreferences = { codex: { nativeConfigDirectory: native } }
  const summary = await harness.ipcHandlers.get('local-agent-native-config:get')(harness.event(), 'codex')
  assert.equal(summary.provider, 'custom')
  assert.doesNotMatch(JSON.stringify(summary), /CUSTOM_CREDENTIAL|synthetic-secret/)
  await harness.workspaceInstances[0].input.runAgent({ kind: 'codex', executable: '/tmp/codex' }, 'hello', directory, {})
  const options = harness.runAgentCalls.at(-1)[3]
  assert.equal(options.env.CUSTOM_CREDENTIAL, 'synthetic-secret')
  assert.equal(options.env.UNRELATED_SECRET, undefined)
  assert.deepEqual(options.nativeCredentialKeys, ['CODEX_API_KEY', 'CUSTOM_CREDENTIAL'])
  await harness.workspaceInstances[0].input.runAgent({ kind: 'hermes', executable: '/tmp/hermes' }, 'hello', directory, {})
  assert.equal(harness.runAgentCalls.at(-1)[3].env.CUSTOM_CREDENTIAL, undefined)
})

test('Zcode selected native configuration controls detection, credentials and execution home', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-zcode-config-main-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const home = path.join(directory, 'selected-home')
  const selected = path.join(home, '.zcode', 'cli')
  fs.mkdirSync(selected, { recursive: true })
  fs.writeFileSync(path.join(selected, 'config.json'), JSON.stringify({ model: { main: 'selected/model' },
    provider: { selected: { kind: 'openai', name: 'Selected' } } }))
  const readiness = require('../../src/agents/local-agent-readiness.cjs')
  let detected
  const { harness } = loadMain(directory, {
    dialogResult: { canceled: false, filePaths: [selected] },
    zcodeDeclaredCredentialKeys: readiness.zcodeDeclaredCredentialKeys,
    nativeEnvironment: readiness.nativeCredentialEnvironment,
    nativeShellEnvironment: input => ({ source: 'native-shell', env: input.extraEnvKeys?.includes('SELECTED_API_KEY')
      ? { SELECTED_API_KEY: 'synthetic-selected' } : {} }),
    detectAgents: input => { detected = input.nativeEnvironmentForKind('zcode'); return [] },
  })
  await harness.ready()
  const workspace = harness.workspaceInstances[0]
  workspace.state.agentPreferences = {}
  workspace.state.agentRuntime = {}
  workspace.activeRuns = new Map()
  workspace.save = () => {}
  const choice = await harness.ipcHandlers.get('local-agent-native-config:choose')(harness.event(), 'zcode')
  assert.equal(choice.directory, path.resolve(selected))
  const summary = await harness.ipcHandlers.get('local-agent-native-config:get')(harness.event(), 'zcode')
  assert.equal(summary.provider, 'selected')
  assert.doesNotMatch(JSON.stringify(summary), /synthetic-selected|SELECTED_API_KEY/)
  await harness.installerInstances[0].input.detectAgents()
  assert.equal(detected.HOME, path.resolve(home))
  assert.equal(detected.SELECTED_API_KEY, 'synthetic-selected')
  await workspace.input.runAgent({ kind: 'zcode', executable: '/tmp/zcode' }, 'hello', directory, {})
  const env = harness.runAgentCalls.at(-1)[3].env
  assert.equal(env.HOME, path.resolve(home))
  assert.equal(env.SELECTED_API_KEY, 'synthetic-selected')
})

test('Qwen selected native configuration controls credentials, execution and Skill home', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-qwen-config-main-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const home = path.join(directory, 'selected-home')
  const selected = path.join(home, '.qwen')
  fs.mkdirSync(selected, { recursive: true })
  fs.writeFileSync(path.join(selected, 'settings.json'), JSON.stringify({ model: { name: 'chosen' },
    security: { auth: { selectedType: 'openai' } },
    modelProviders: { openai: [{ id: 'chosen', envKey: 'CHOSEN_TOKEN' }] } }))
  const readiness = require('../../src/agents/local-agent-readiness.cjs')
  let detected
  const { harness } = loadMain(directory, {
    dialogResult: { canceled: false, filePaths: [selected] },
    nativeEnvironment: readiness.nativeCredentialEnvironment,
    nativeShellEnvironment: input => ({ source: 'native-shell', env: input.extraEnvKeys?.includes('CHOSEN_TOKEN')
      ? { CHOSEN_TOKEN: 'synthetic-selected' } : {} }),
    detectAgents: input => { detected = input.nativeEnvironmentForKind('qwen'); return [] },
  })
  await harness.ready()
  const workspace = harness.workspaceInstances[0]
  workspace.state.agentPreferences = {}
  workspace.state.agentRuntime = {}
  workspace.activeRuns = new Map()
  workspace.save = () => {}
  const choice = await harness.ipcHandlers.get('local-agent-native-config:choose')(harness.event(), 'qwen')
  assert.equal(choice.directory, path.resolve(selected))
  const summary = await harness.ipcHandlers.get('local-agent-native-config:get')(harness.event(), 'qwen')
  assert.equal(summary.authType, 'openai')
  assert.doesNotMatch(JSON.stringify(summary), /synthetic-selected|CHOSEN_TOKEN/)
  await harness.installerInstances[0].input.detectAgents()
  assert.equal(detected.HOME, path.resolve(home))
  assert.equal(detected.CHOSEN_TOKEN, 'synthetic-selected')
  await workspace.input.runAgent({ kind: 'qwen', executable: '/tmp/qwen' }, 'hello', directory, {})
  const env = harness.runAgentCalls.at(-1)[3].env
  assert.equal(env.HOME, path.resolve(home))
  assert.equal(env.CHOSEN_TOKEN, 'synthetic-selected')
  assert.equal(harness.skillCatalogInstances[0].input.configDirectoryForKind('qwen'), path.resolve(home))
})

test('OpenCodeReview selected native directory reaches detection and execution', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-ocr-config-main-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const home = path.join(directory, 'selected-home')
  const selected = path.join(home, '.opencodereview')
  fs.mkdirSync(selected, { recursive: true })
  fs.writeFileSync(path.join(selected, 'config.json'), '{}')
  const readiness = require('../../src/agents/local-agent-readiness.cjs')
  let detected
  const { harness } = loadMain(directory, {
    dialogResult: { canceled: false, filePaths: [selected] },
    nativeEnvironment: readiness.nativeCredentialEnvironment,
    detectAgents: input => { detected = input.nativeEnvironmentForKind('opencodereview'); return [] },
  })
  await harness.ready()
  const workspace = harness.workspaceInstances[0]
  workspace.state.agentPreferences = {}
  workspace.state.agentRuntime = {}
  workspace.activeRuns = new Map()
  workspace.save = () => {}
  const choice = await harness.ipcHandlers.get('local-agent-native-config:choose')(harness.event(), 'opencodereview')
  assert.equal(choice.directory, selected)
  await harness.installerInstances[0].input.detectAgents()
  assert.equal(detected.HOME, home)
  await workspace.input.runAgent({ kind: 'opencodereview', executable: '/tmp/ocr' }, 'hello', directory, {})
  assert.equal(harness.runAgentCalls.at(-1)[3].env.HOME, home)
})

test('Qwen verification follows the selected native home environment file', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-qwen-selected-identity-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const home = path.join(directory, 'selected-home')
  const selected = path.join(home, '.qwen')
  fs.mkdirSync(selected, { recursive: true })
  fs.writeFileSync(path.join(selected, 'settings.json'), '{}')
  const dotenv = path.join(home, '.env')
  fs.writeFileSync(dotenv, 'CHOSEN_TOKEN=synthetic-one\n')
  const { harness } = loadMain(directory, {
    nativeShellEnvironment: () => ({ source: 'native-shell', env: { HOME: directory } }),
    detectAgents: () => [{ kind: 'qwen', name: 'Qwen', executable: '/tmp/qwen', version: '0.10.0' }],
  })
  await harness.ready()
  const workspace = harness.workspaceInstances[0]
  workspace.state.agentPreferences = { qwen: { nativeConfigDirectory: selected } }
  const [agent] = await harness.installerInstances[0].input.detectAgents()
  const { agentVerificationIdentity } = require('../../src/workspace/agent-verification-identity.cjs')
  const before = agentVerificationIdentity(agent, workspace.state.agentPreferences)
  fs.appendFileSync(dotenv, 'CHANGED=true\n')
  assert.notEqual(agentVerificationIdentity(agent, workspace.state.agentPreferences), before)
})

test('Hermes selected config captures only its declared native credential for execution', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-hermes-env-main-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const native = path.join(directory, 'native'); fs.mkdirSync(native)
  fs.writeFileSync(path.join(native, 'config.yaml'), [
    'model:', '  provider: custom', '  key_env: CUSTOM_CREDENTIAL',
    'fallback_providers:', '  - provider: alternate', '    model: backup', '    key_env: FALLBACK_CREDENTIAL',
  ].join('\n'))
  const readiness = require('../../src/agents/local-agent-readiness.cjs')
  const { harness } = loadMain(directory, {
    hermesDeclaredCredentialKeys: readiness.hermesDeclaredCredentialKeys,
    nativeEnvironment: readiness.nativeCredentialEnvironment,
    nativeShellEnvironment: input => ({ source: 'native-shell', env: input.extraEnvKeys?.includes('CUSTOM_CREDENTIAL')
      ? { CUSTOM_CREDENTIAL: 'synthetic-secret', FALLBACK_CREDENTIAL: 'synthetic-backup', UNRELATED_SECRET: 'private' } : {} }),
  })
  await harness.ready()
  harness.workspaceInstances[0].state.agentPreferences = { hermes: { nativeConfigDirectory: native } }
  await harness.workspaceInstances[0].input.runAgent({ kind: 'hermes', executable: '/tmp/hermes' }, 'hello', directory, {})
  const options = harness.runAgentCalls.at(-1)[3]
  assert.equal(options.env.CUSTOM_CREDENTIAL, 'synthetic-secret')
  assert.equal(options.env.FALLBACK_CREDENTIAL, 'synthetic-backup')
  assert.equal(options.env.UNRELATED_SECRET, undefined)
  assert.deepEqual(options.nativeCredentialKeys, ['ALTERNATE_API_KEY', 'CUSTOM_CREDENTIAL', 'FALLBACK_CREDENTIAL'])
  await harness.workspaceInstances[0].input.runAgent({ kind: 'codex', executable: '/tmp/codex' }, 'hello', directory, {})
  assert.equal(harness.runAgentCalls.at(-1)[3].env.CUSTOM_CREDENTIAL, undefined)
  assert.equal(harness.runAgentCalls.at(-1)[3].env.FALLBACK_CREDENTIAL, undefined)
})

test('MiMo receives its native provider reference from the shell without leaking it to Codex', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-mimo-env-main-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.mkdirSync(path.join(directory, 'mimocode'))
  fs.writeFileSync(path.join(directory, 'mimocode', 'mimocode.json'), JSON.stringify({
    model: 'custom/model', provider: { custom: { options: { apiKey: '{env:MIMO_CUSTOM_SECRET}' } } },
  }))
  const readiness = require('../../src/agents/local-agent-readiness.cjs')
  const { harness } = loadMain(directory, {
    nativeEnvironment: readiness.nativeCredentialEnvironment,
    nativeShellEnvironment: input => ({ source: 'native-shell', env: {
      XDG_CONFIG_HOME: directory,
      ...(input.extraEnvKeys?.includes('MIMO_CUSTOM_SECRET') ? { MIMO_CUSTOM_SECRET: 'abc' } : {}),
    } }),
  })
  await harness.ready()
  const workspace = harness.workspaceInstances[0]
  await workspace.input.runAgent({ kind: 'mimo', executable: '/tmp/mimo' }, 'hello', directory, {})
  assert.equal(harness.runAgentCalls.at(-1)[3].env.MIMO_CUSTOM_SECRET, 'abc')
  assert.deepEqual(harness.runAgentCalls.at(-1)[3].nativeCredentialKeys, ['MIMO_CUSTOM_SECRET'])
  await workspace.input.runAgent({ kind: 'codex', executable: '/tmp/codex' }, 'hello', directory, {})
  assert.equal(harness.runAgentCalls.at(-1)[3].env.MIMO_CUSTOM_SECRET, undefined)
})

test('Qwen resolves only the selected project model credential at the main-process boundary', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-qwen-project-main-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const projects = ['a', 'b'].map(name => path.join(directory, name))
  for (const [index, project] of projects.entries()) {
    fs.mkdirSync(path.join(project, '.qwen'), { recursive: true })
    fs.writeFileSync(path.join(project, '.qwen', 'settings.json'), JSON.stringify({
      model: { name: 'chosen' }, security: { auth: { selectedType: 'openai' } },
      modelProviders: { openai: [{ id: 'chosen', envKey: `PROJECT_${index}_KEY` }] },
    }))
  }
  const readiness = require('../../src/agents/local-agent-readiness.cjs')
  const { harness } = loadMain(directory, {
    nativeEnvironment: readiness.nativeCredentialEnvironment,
    nativeShellEnvironment: input => ({ source: 'native-shell', env: {
      QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(directory, 'missing.json'),
      ...Object.fromEntries((input.extraEnvKeys || []).map(key => [key, `value-${key}`])),
    } }),
  })
  await harness.ready()
  const workspace = harness.workspaceInstances[0]
  for (const [index, project] of projects.entries()) {
    await workspace.input.runAgent({ kind: 'qwen', executable: '/tmp/qwen' }, 'hello', project, {})
    const options = harness.runAgentCalls.at(-1)[3]
    assert.equal(options.env[`PROJECT_${index}_KEY`], `value-PROJECT_${index}_KEY`)
    assert.equal(options.env[`PROJECT_${1 - index}_KEY`], undefined)
    assert.deepEqual(options.nativeCredentialKeys, [`PROJECT_${index}_KEY`])
  }
  await workspace.input.runAgent({ kind: 'codex', executable: '/tmp/codex' }, 'hello', projects[0], {})
  assert.equal(harness.runAgentCalls.at(-1)[3].env.PROJECT_0_KEY, undefined)
})

test('MiMo resolves project credentials for each chat working directory', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-mimo-project-main-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const projects = ['a', 'b'].map(name => path.join(directory, name))
  for (const [index, project] of projects.entries()) {
    fs.mkdirSync(project)
    fs.writeFileSync(path.join(project, 'mimocode.json'), JSON.stringify({
      model: 'custom/model', provider: { custom: { options: { apiKey: `{env:PROJECT_${index}_KEY}` } } },
    }))
  }
  const readiness = require('../../src/agents/local-agent-readiness.cjs')
  const { harness } = loadMain(directory, {
    nativeEnvironment: readiness.nativeCredentialEnvironment,
    nativeShellEnvironment: input => ({ source: 'native-shell', env: Object.fromEntries(
      (input.extraEnvKeys || []).map(key => [key, `value-${key}`]),
    ) }),
  })
  await harness.ready()
  const workspace = harness.workspaceInstances[0]
  for (const [index, project] of projects.entries()) {
    await workspace.input.runAgent({ kind: 'mimo', executable: '/tmp/mimo' }, 'hello', project, {})
    const options = harness.runAgentCalls.at(-1)[3]
    assert.equal(options.env[`PROJECT_${index}_KEY`], `value-PROJECT_${index}_KEY`)
    assert.equal(options.env[`PROJECT_${1 - index}_KEY`], undefined)
  }
})

test('MiMo captures an env-selected project model and only its provider credential', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-mimo-model-main-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'mimocode.json'), JSON.stringify({ model: '{env:MODEL_CHOICE}',
    provider: { custom: { options: { apiKey: 'prefix-{env:CUSTOM_KEY}', headers: { authorization: '{env:HEADER_KEY}' } } },
      other: { options: { apiKey: '{env:OTHER_KEY}' } } } }))
  const readiness = require('../../src/agents/local-agent-readiness.cjs')
  const values = { MODEL_CHOICE: 'custom/model', CUSTOM_KEY: 'synthetic', HEADER_KEY: 'header', OTHER_KEY: 'unrelated' }
  const { harness } = loadMain(directory, {
    nativeEnvironment: readiness.nativeCredentialEnvironment,
    nativeShellEnvironment: input => ({ source: 'native-shell', env: Object.fromEntries(
      (input.extraEnvKeys || []).filter(key => Object.hasOwn(values, key)).map(key => [key, values[key]]),
    ) }),
  })
  await harness.ready()
  await harness.workspaceInstances[0].input.runAgent({ kind: 'mimo', executable: '/tmp/mimo' }, 'hello', directory, {})
  const options = harness.runAgentCalls.at(-1)[3]
  assert.equal(options.env.MODEL_CHOICE, 'custom/model')
  assert.equal(options.env.CUSTOM_KEY, 'synthetic')
  assert.equal(options.env.HEADER_KEY, 'header')
  assert.equal(options.env.OTHER_KEY, undefined)
})

test('project environment identities follow the selected native credential without revealing it', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-project-env-identity-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'mimocode.json'), JSON.stringify({ model: 'custom/model',
    provider: { custom: { options: { apiKey: '{env:CUSTOM_KEY}' } } } }))
  const readiness = require('../../src/agents/local-agent-readiness.cjs')
  let secret = 'first-synthetic-secret'
  const { harness } = loadMain(directory, {
    nativeEnvironment: readiness.nativeCredentialEnvironment,
    nativeShellEnvironment: input => ({ source: 'native-shell', env: input.extraEnvKeys?.includes('CUSTOM_KEY')
      ? { CUSTOM_KEY: secret } : {} }),
  })
  await harness.ready()
  const resolve = harness.workspaceInstances[0].input.resolveProjectEnvironmentIdentities
  const first = await resolve(directory, ['mimo'])
  secret = 'second-synthetic-secret'
  const second = await resolve(directory, ['mimo'])
  assert.match(first.mimo, /^[a-f0-9]{64}$/)
  assert.notEqual(first.mimo, second.mimo)
  assert.doesNotMatch(JSON.stringify([first, second]), /synthetic-secret|CUSTOM_KEY/)
})

test('native project identity changes when the CLI tool search path changes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-native-path-identity-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let nativePath = '/synthetic/first-tool-bin'
  const { harness } = loadMain(directory, {
    nativeShellEnvironment: () => ({ source: 'native-shell', env: { PATH: nativePath } }),
  })
  await harness.ready()
  const resolve = harness.workspaceInstances[0].input.resolveProjectEnvironmentIdentities
  const first = await resolve(directory, ['codex'])
  nativePath = '/synthetic/second-tool-bin'
  const second = await resolve(directory, ['codex'])
  assert.notEqual(first.codex, second.codex)
  assert.doesNotMatch(JSON.stringify([first, second]), /synthetic|tool-bin/)
})

test('Codex and Hermes project identities track only their own native credentials', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-native-project-identities-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const readiness = require('../../src/agents/local-agent-readiness.cjs')
  const values = { CODEX_CUSTOM_KEY: 'codex-first', HERMES_CUSTOM_KEY: 'hermes-first' }
  const { harness } = loadMain(directory, {
    codexDeclaredCredentialKeys: () => ['CODEX_CUSTOM_KEY'],
    hermesDeclaredCredentialKeys: () => ['HERMES_CUSTOM_KEY'],
    nativeEnvironment: readiness.nativeCredentialEnvironment,
    nativeShellEnvironment: input => ({ source: 'native-shell', env: Object.fromEntries(
      (input.extraEnvKeys || []).filter(key => Object.hasOwn(values, key)).map(key => [key, values[key]]),
    ) }),
  })
  await harness.ready()
  const resolve = harness.workspaceInstances[0].input.resolveProjectEnvironmentIdentities
  const first = await resolve(directory, ['codex', 'hermes'])
  values.CODEX_CUSTOM_KEY = 'codex-second'
  const second = await resolve(directory, ['codex', 'hermes'])
  assert.match(first.codex, /^[a-f0-9]{64}$/)
  assert.match(first.hermes, /^[a-f0-9]{64}$/)
  assert.notEqual(first.codex, second.codex)
  assert.equal(first.hermes, second.hermes)
  values.HERMES_CUSTOM_KEY = 'hermes-second'
  const third = await resolve(directory, ['codex', 'hermes'])
  assert.equal(second.codex, third.codex)
  assert.notEqual(second.hermes, third.hermes)
  assert.doesNotMatch(JSON.stringify([first, second, third]), /codex-first|hermes-first|CUSTOM_KEY/)
})

test('Pi and Claude project identities follow their native authentication environment', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-native-auth-identities-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const readiness = require('../../src/agents/local-agent-readiness.cjs')
  const values = { PI_CUSTOM_KEY: 'pi-first', CLAUDE_CODE_OAUTH_TOKEN: 'claude-first' }
  const { harness } = loadMain(directory, {
    piDeclaredCredentialKeys: () => ['PI_CUSTOM_KEY'],
    nativeEnvironment: readiness.nativeCredentialEnvironment,
    nativeShellEnvironment: input => ({ source: 'native-shell', env: {
      CLAUDE_CODE_OAUTH_TOKEN: values.CLAUDE_CODE_OAUTH_TOKEN,
      ...(input.extraEnvKeys?.includes('PI_CUSTOM_KEY') ? { PI_CUSTOM_KEY: values.PI_CUSTOM_KEY } : {}),
    } }),
  })
  await harness.ready()
  const resolve = harness.workspaceInstances[0].input.resolveProjectEnvironmentIdentities
  const first = await resolve(directory, ['pi', 'claude'])
  values.PI_CUSTOM_KEY = 'pi-second'
  const second = await resolve(directory, ['pi', 'claude'])
  assert.notEqual(first.pi, second.pi)
  assert.equal(first.claude, second.claude)
  values.CLAUDE_CODE_OAUTH_TOKEN = 'claude-second'
  const third = await resolve(directory, ['pi', 'claude'])
  assert.equal(second.pi, third.pi)
  assert.notEqual(second.claude, third.claude)
  assert.doesNotMatch(JSON.stringify([first, second, third]), /pi-first|claude-first|CUSTOM_KEY|AUTH_TOKEN/)
})

test('OpenClaw project identity tracks its guarded native runtime without exposing credentials', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-openclaw-project-identity-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let secret = 'openclaw-first-secret'
  let unavailable = false
  const { harness } = loadMain(directory, {
    nativeOpenClawRuntime: input => {
      assert.equal(input.executable, '/native/openclaw')
      if (unavailable) throw new Error('OPENCLAW_NATIVE_RUNTIME_UNAVAILABLE')
      return { model: 'native/model', provider: { id: 'native', baseUrl: 'https://example.test', apiKey: secret } }
    },
  })
  await harness.ready()
  harness.workspaceInstances[0].detectedAgents = [{ kind: 'openclaw', executable: '/native/openclaw' }]
  const resolve = harness.workspaceInstances[0].input.resolveProjectEnvironmentIdentities
  const first = await resolve(directory, ['openclaw', 'codex'])
  secret = 'openclaw-second-secret'
  const second = await resolve(directory, ['openclaw', 'codex'])
  assert.match(first.openclaw, /^[a-f0-9]{64}$/)
  assert.notEqual(first.openclaw, second.openclaw)
  assert.equal(first.codex, second.codex)
  assert.doesNotMatch(JSON.stringify([first, second]), /openclaw-first-secret|openclaw-second-secret/)
  unavailable = true
  const failed = await resolve(directory, ['openclaw', 'codex'])
  assert.equal(failed.openclaw, undefined)
  assert.equal(failed.codex, second.codex)
})

test('MiMo captures the recent model provider credential for a project', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-mimo-recent-main-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const state = path.join(directory, 'state', 'mimocode')
  fs.mkdirSync(state, { recursive: true })
  fs.writeFileSync(path.join(state, 'model.json'), JSON.stringify({ recent: [
    { providerID: 'missing', modelID: 'example' }, { providerID: 'custom', modelID: 'example' },
  ] }))
  fs.writeFileSync(path.join(directory, 'mimocode.json'), JSON.stringify({ provider: {
    custom: { options: { apiKey: '{env:CUSTOM_KEY}' } }, other: { options: { apiKey: '{env:OTHER_KEY}' } },
  } }))
  const readiness = require('../../src/agents/local-agent-readiness.cjs')
  const { harness } = loadMain(directory, {
    nativeEnvironment: readiness.nativeCredentialEnvironment,
    nativeShellEnvironment: input => ({ source: 'native-shell', env: { XDG_STATE_HOME: path.dirname(state),
      ...(input.extraEnvKeys?.includes('CUSTOM_KEY') ? { CUSTOM_KEY: 'synthetic' } : {}),
      ...(input.extraEnvKeys?.includes('OTHER_KEY') ? { OTHER_KEY: 'unrelated' } : {}) } }),
  })
  await harness.ready()
  await harness.workspaceInstances[0].input.runAgent({ kind: 'mimo', executable: '/tmp/mimo' }, 'hello', directory, {})
  const options = harness.runAgentCalls.at(-1)[3]
  assert.equal(options.env.CUSTOM_KEY, 'synthetic')
  assert.equal(options.env.OTHER_KEY, undefined)
})

test('Zcode receives only its native provider credential', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-zcode-env-main-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const readiness = require('../../src/agents/local-agent-readiness.cjs')
  const { harness } = loadMain(directory, {
    zcodeDeclaredCredentialKeys: () => ['ACME_API_KEY'],
    nativeEnvironment: readiness.nativeCredentialEnvironment,
    nativeShellEnvironment: input => ({ source: 'native-shell', env: input.extraEnvKeys?.includes('ACME_API_KEY')
      ? { ACME_API_KEY: 'synthetic-secret', UNRELATED_SECRET: 'private' } : {} }),
  })
  await harness.ready()
  const workspace = harness.workspaceInstances[0]
  await workspace.input.runAgent({ kind: 'zcode', executable: '/tmp/zcode' }, 'hello', directory, {})
  const options = harness.runAgentCalls.at(-1)[3]
  assert.equal(options.env.ACME_API_KEY, 'synthetic-secret')
  assert.equal(options.env.UNRELATED_SECRET, undefined)
  assert.deepEqual(options.nativeCredentialKeys, ['ACME_API_KEY'])
  await workspace.input.runAgent({ kind: 'codex', executable: '/tmp/codex' }, 'hello', directory, {})
  assert.equal(harness.runAgentCalls.at(-1)[3].env.ACME_API_KEY, undefined)
})

test('Zcode execution captures the provider for its current project only', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-zcode-project-main-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const projects = ['alpha', 'beta'].map(name => {
    const project = path.join(directory, name)
    fs.mkdirSync(project)
    fs.writeFileSync(path.join(project, 'zcode.json'), JSON.stringify({ model: { main: `${name}/model` } }))
    return project
  })
  const readiness = require('../../src/agents/local-agent-readiness.cjs')
  const { harness } = loadMain(directory, {
    zcodeDeclaredCredentialKeys: readiness.zcodeDeclaredCredentialKeys,
    nativeEnvironment: readiness.nativeCredentialEnvironment,
    nativeShellEnvironment: input => ({ source: 'native-shell', env: Object.fromEntries(
      (input.extraEnvKeys || []).map(key => [key, `value-${key}`]),
    ) }),
  })
  await harness.ready()
  const workspace = harness.workspaceInstances[0]
  for (const [index, project] of projects.entries()) {
    await workspace.input.runAgent({ kind: 'zcode', executable: '/tmp/zcode' }, 'hello', project, {})
    const env = harness.runAgentCalls.at(-1)[3].env
    const selected = index === 0 ? 'ALPHA_API_KEY' : 'BETA_API_KEY'
    const other = index === 0 ? 'BETA_API_KEY' : 'ALPHA_API_KEY'
    assert.equal(env[selected], `value-${selected}`)
    assert.equal(env[other], undefined)
  }
})

test('Hermes environment-selected provider is captured without a native config file', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-hermes-env-provider-main-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const readiness = require('../../src/agents/local-agent-readiness.cjs')
  const { harness } = loadMain(directory, {
    hermesDeclaredCredentialKeys: readiness.hermesDeclaredCredentialKeys,
    nativeEnvironment: readiness.nativeCredentialEnvironment,
    nativeShellEnvironment: input => ({ source: 'native-shell', env: {
      HERMES_INFERENCE_PROVIDER: 'north-star',
      ...(input.extraEnvKeys?.includes('NORTH_STAR_API_KEY') ? { NORTH_STAR_API_KEY: 'synthetic-secret' } : {}),
    } }),
  })
  await harness.ready()
  const workspace = harness.workspaceInstances[0]
  await workspace.input.runAgent({ kind: 'hermes', executable: '/tmp/hermes' }, 'hello', directory, {})
  const options = harness.runAgentCalls.at(-1)[3]
  assert.equal(options.env.HERMES_INFERENCE_PROVIDER, 'north-star')
  assert.equal(options.env.NORTH_STAR_API_KEY, 'synthetic-secret')
  assert.equal(options.env.OPENAI_BASE_URL, undefined)
  await workspace.input.runAgent({ kind: 'codex', executable: '/tmp/codex' }, 'hello', directory, {})
  assert.equal(harness.runAgentCalls.at(-1)[3].env.NORTH_STAR_API_KEY, undefined)
})

test('Skill discovery follows native shell directories and explicit selections take precedence', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-native-skill-env-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let nativeDirectory = '~/custom-hermes'
  const { harness } = loadMain(directory, {
    nativeShellEnvironment: () => ({ env: { HERMES_HOME: nativeDirectory }, source: 'native-shell' }),
  })
  await harness.ready()
  const catalog = harness.skillCatalogInstances[0]
  await harness.installerInstances[0].input.listSkills('hermes')
  assert.equal(catalog.input.configDirectoryForKind('hermes'), path.join(directory, 'Home', 'custom-hermes'))
  const invalidations = catalog.invalidateCalls
  nativeDirectory = path.join(directory, 'other-hermes')
  await harness.installerInstances[0].input.listSkills('hermes')
  assert.equal(catalog.invalidateCalls, invalidations + 1)
  assert.equal(catalog.input.configDirectoryForKind('hermes'), nativeDirectory)
  const selected = path.join(directory, 'selected-hermes')
  harness.workspaceInstances[0].state.agentPreferences = { hermes: { nativeConfigDirectory: selected } }
  assert.equal(catalog.input.configDirectoryForKind('hermes'), selected)
})

test('Kimi native directory selection reaches detection, execution, and Skill discovery', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-kimi-config-ipc-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const native = path.join(directory, 'kimi-home')
  fs.mkdirSync(native)
  fs.writeFileSync(path.join(native, 'config.toml'), '')
  let detected
  const { harness } = loadMain(directory, {
    dialogResult: { canceled: false, filePaths: [native] },
    nativeShellEnvironment: () => ({ env: { KIMI_CODE_HOME: '/previous' }, source: 'native-shell' }),
    nativeEnvironment: (_kind, env) => ({ KIMI_CODE_HOME: env.KIMI_CODE_HOME }),
    detectAgents: input => { detected = input.nativeEnvironmentForKind('kimi'); return [] },
  })
  await harness.ready()
  const workspace = harness.workspaceInstances[0]
  workspace.state.agentPreferences = {}
  workspace.state.agentRuntime = {}
  workspace.activeRuns = new Map()
  workspace.save = () => {}
  const chosen = await harness.ipcHandlers.get('local-agent-native-config:choose')(harness.event(), 'kimi')
  await harness.installerInstances[0].input.detectAgents()
  assert.equal(detected.KIMI_CODE_HOME, chosen.directory)
  await workspace.input.runAgent({ kind: 'kimi', executable: '/tmp/kimi' }, 'hello', directory, {})
  assert.equal(harness.runAgentCalls.at(-1)[3].env.KIMI_CODE_HOME, chosen.directory)
  assert.equal(harness.skillCatalogInstances[0].input.configDirectoryForKind('kimi'), chosen.directory)
})

test('DeepSeek native directory selection reaches detection, execution, and Skill discovery', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-dsh-config-ipc-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const native = path.join(directory, 'dsh-home')
  fs.mkdirSync(path.join(native, 'profiles'), { recursive: true })
  let detected
  const { harness } = loadMain(directory, {
    dialogResult: { canceled: false, filePaths: [native] },
    nativeShellEnvironment: () => ({ env: { DSH_HOME: '/previous' }, source: 'native-shell' }),
    nativeEnvironment: (_kind, env) => ({ DSH_HOME: env.DSH_HOME }),
    detectAgents: input => { detected = input.nativeEnvironmentForKind('deepseek'); return [] },
  })
  await harness.ready()
  const workspace = harness.workspaceInstances[0]
  workspace.state.agentPreferences = {}
  workspace.state.agentRuntime = {}
  workspace.activeRuns = new Map()
  workspace.save = () => {}
  const chosen = await harness.ipcHandlers.get('local-agent-native-config:choose')(harness.event(), 'deepseek')
  await harness.installerInstances[0].input.detectAgents()
  assert.equal(detected.DSH_HOME, chosen.directory)
  await workspace.input.runAgent({ kind: 'deepseek', executable: '/tmp/dsh' }, 'hello', directory, { env: { DSH_HOME: '/other' } })
  assert.equal(harness.runAgentCalls.at(-1)[3].env.DSH_HOME, chosen.directory)
  assert.equal(harness.skillCatalogInstances[0].input.configDirectoryForKind('deepseek'), chosen.directory)
})

test('DeepSeek native provider credentials reach detection and execution without unrelated keys', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-dsh-native-env-ipc-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const native = path.join(directory, 'dsh-home')
  fs.mkdirSync(path.join(native, 'profiles', 'acp'), { recursive: true })
  fs.writeFileSync(path.join(native, 'profiles', 'acp', 'cordis.patch.yml'), [
    '- id: llm-pi-ai', '  config:', '    providers:', '      custom:', '        apiKeyEnv: CUSTOM_DSH_KEY',
    '- id: acp', '  config:', '    provider: custom', '    model: chosen-model',
  ].join('\n'))
  const actualNativeEnvironment = require('../../src/agents/agent-native-environment.cjs').nativeCredentialEnvironment
  let detected
  const { harness } = loadMain(directory, {
    nativeShellEnvironment: input => ({ env: { DSH_HOME: native, ZGCI_API_KEY: 'unrelated',
      ...(input.extraEnvKeys?.includes('CUSTOM_DSH_KEY') ? { CUSTOM_DSH_KEY: 'native-secret' } : {}),
      ...(input.extraEnvKeys?.includes('DEEPSEEK_API_KEY') ? { DEEPSEEK_API_KEY: 'official-secret' } : {}) }, source: 'native-shell' }),
    nativeEnvironment: (...args) => actualNativeEnvironment(...args),
    detectAgents: input => { detected = input.nativeEnvironmentForKind('deepseek'); return [] },
  })
  await harness.ready()
  await harness.installerInstances[0].input.detectAgents()
  assert.equal(detected.CUSTOM_DSH_KEY, 'native-secret')
  assert.equal(detected.ZGCI_API_KEY, undefined)
  const workspace = harness.workspaceInstances[0]
  await workspace.input.runAgent({ kind: 'deepseek', executable: '/tmp/dsh' }, 'hello', directory, {})
  const options = harness.runAgentCalls.at(-1)[3]
  assert.equal(options.env.CUSTOM_DSH_KEY, 'native-secret')
  assert.equal(options.env.ZGCI_API_KEY, undefined)
  assert.deepEqual(options.nativeCredentialKeys, ['CUSTOM_DSH_KEY'])
  fs.writeFileSync(path.join(native, 'profiles', 'acp', 'cordis.patch.yml'), '- id: acp\n  config:\n    provider: deepseek-official\n')
  await harness.installerInstances[0].input.detectAgents()
  assert.equal(detected.DEEPSEEK_API_KEY, 'official-secret')
  assert.equal(detected.ZGCI_API_KEY, undefined)
})

test('DeepSeek project verification identity follows its selected native credential', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-dsh-project-identity-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const native = path.join(directory, 'dsh-home')
  fs.mkdirSync(path.join(native, 'profiles', 'acp'), { recursive: true })
  fs.writeFileSync(path.join(native, 'profiles', 'acp', 'cordis.patch.yml'), [
    '- id: llm-pi-ai', '  config:', '    providers:', '      custom:', '        apiKeyEnv: CUSTOM_DSH_KEY',
    '- id: acp', '  config:', '    provider: custom', '    model: chosen-model',
  ].join('\n'))
  const { nativeCredentialEnvironment } = require('../../src/agents/agent-native-environment.cjs')
  let secret = 'first-synthetic-secret'
  const { harness } = loadMain(directory, {
    nativeEnvironment: nativeCredentialEnvironment,
    nativeShellEnvironment: input => ({ source: 'native-shell', env: {
      DSH_HOME: native,
      ...(input.extraEnvKeys?.includes('CUSTOM_DSH_KEY') ? { CUSTOM_DSH_KEY: secret } : {}),
    } }),
  })
  await harness.ready()
  const resolve = harness.workspaceInstances[0].input.resolveProjectEnvironmentIdentities
  const first = await resolve(directory, ['deepseek', 'codex'])
  secret = 'second-synthetic-secret'
  const second = await resolve(directory, ['deepseek', 'codex'])
  assert.match(first.deepseek, /^[a-f0-9]{64}$/)
  assert.notEqual(first.deepseek, second.deepseek)
  assert.equal(first.codex, second.codex)
  assert.doesNotMatch(JSON.stringify([first, second]), /synthetic-secret|CUSTOM_DSH_KEY/)
})

test('DeepSeek shared Skill directory follows the native shell and invalidates its cache', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-dsh-shared-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let shared = '~/shared-agents'
  const { harness } = loadMain(directory, {
    nativeShellEnvironment: () => ({ env: { DSH_AGENTS_HOME: shared }, source: 'native-shell' }),
  })
  await harness.ready()
  await harness.installerInstances[0].input.listSkills('deepseek')
  const catalog = harness.skillCatalogInstances[0]
  assert.equal(catalog.input.sharedDirectoryForKind('deepseek'), path.join(directory, 'Home', 'shared-agents'))
  assert.equal(catalog.input.sharedDirectoryForKind('codex'), '')
  const invalidations = catalog.invalidateCalls
  shared = path.join(directory, 'other-agents')
  await harness.installerInstances[0].input.listSkills('deepseek')
  assert.equal(catalog.invalidateCalls, invalidations + 1)
  assert.equal(catalog.input.sharedDirectoryForKind('deepseek'), shared)
})

test('WorkBuddy selected directory supplies model settings, execution, and Skill discovery', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-workbuddy-config-ipc-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const native = path.join(directory, 'workbuddy-home')
  fs.mkdirSync(native)
  fs.writeFileSync(path.join(native, 'models.json'), JSON.stringify([{ id: 'native-model', name: 'Native',
    apiKey: 'synthetic-secret', url: 'https://example.test/v1', supportsToolCall: true }]))
  let credentialEnvironment
  const { harness } = loadMain(directory, {
    dialogResult: { canceled: false, filePaths: [native] },
    nativeShellEnvironment: () => ({ env: { CODEBUDDY_CONFIG_DIR: '/previous' }, source: 'native-shell' }),
    nativeCredentialState: (_kind, input) => { credentialEnvironment = input.env; return { state: 'ready', source: 'native-credential' } },
  })
  await harness.ready()
  const workspace = harness.workspaceInstances[0]
  workspace.state.agentPreferences = {}
  workspace.state.agentRuntime = {}
  workspace.activeRuns = new Map()
  workspace.save = () => {}
  const chosen = await harness.ipcHandlers.get('local-agent-native-config:choose')(harness.event(), 'workbuddy')
  const settings = await harness.ipcHandlers.get('local-workbuddy:settings')(harness.event())
  assert.deepEqual(settings.models, [{ id: 'native-model', name: 'Native' }])
  assert.doesNotMatch(JSON.stringify(settings), /synthetic-secret/)
  workspace.state.agentPreferences.workbuddy.modelId = 'native-model'
  await workspace.input.credentialState('workbuddy', { executable: '/tmp/workbuddy' })
  assert.equal(credentialEnvironment.CODEBUDDY_CONFIG_DIR, chosen.directory)
  await workspace.input.runAgent({ kind: 'workbuddy', executable: '/tmp/workbuddy' }, 'hello', directory, {})
  const env = harness.runAgentCalls.at(-1)[3].env
  assert.equal(env.CODEBUDDY_CONFIG_DIR, chosen.directory)
  assert.equal(env.CODEBUDDY_API_KEY, 'synthetic-secret')
  assert.equal(harness.skillCatalogInstances[0].input.configDirectoryForKind('workbuddy'), chosen.directory)
})

test('native configuration cannot change if a run starts while the picker is open', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-native-config-race-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'config.yaml'), 'model: native\n')
  let resolvePicker
  const picker = new Promise(resolve => { resolvePicker = resolve })
  const { harness } = loadMain(directory, { onOpenDialog: () => picker })
  await harness.ready()
  const workspace = harness.workspaceInstances[0]
  workspace.state.agentPreferences = {}
  workspace.state.agentRuntime = {}
  workspace.activeRuns = new Map()
  workspace.save = () => assert.fail('must not save while a run is active')
  const choosing = harness.ipcHandlers.get('local-agent-native-config:choose')(harness.event(), 'hermes')
  workspace.activeRuns.set('busy', {})
  resolvePicker({ canceled: false, filePaths: [directory] })
  await assert.rejects(() => choosing, { message: 'LOCAL_WORK_PREFERENCES_BUSY' })
  assert.equal(workspace.state.agentPreferences.hermes, undefined)
})

test('a stale native configuration picker cannot overwrite a newer selection', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-native-config-stale-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'config.yaml'), 'model: native\n')
  let resolvePicker
  const picker = new Promise(resolve => { resolvePicker = resolve })
  const { harness } = loadMain(directory, { onOpenDialog: () => picker })
  await harness.ready()
  const workspace = harness.workspaceInstances[0]
  workspace.state.agentPreferences = {}
  workspace.state.agentRuntime = {}
  workspace.activeRuns = new Map()
  workspace.save = () => assert.fail('must not save a stale selection')
  const choosing = harness.ipcHandlers.get('local-agent-native-config:choose')(harness.event(), 'hermes')
  workspace.state.agentPreferences.hermes = { nativeConfigDirectory: '/newer-selection' }
  resolvePicker({ canceled: false, filePaths: [directory] })
  await assert.rejects(() => choosing, { message: 'LOCAL_WORK_PREFERENCES_BUSY' })
  assert.equal(workspace.state.agentPreferences.hermes.nativeConfigDirectory, '/newer-selection')
})

test('native configuration switching preserves sessions and refuses waiting runs', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-native-session-ipc-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'config.yaml'), 'model: native\n')
  const { harness } = loadMain(directory, { dialogResult: { canceled: false, filePaths: [directory] } })
  await harness.ready()
  const workspace = harness.workspaceInstances[0]
  workspace.state.agentPreferences = {}
  workspace.state.agentRuntime = {}
  workspace.state.groups = [{ id: 'direct', agentKinds: ['hermes'] }]
  workspace.state.messages = []
  workspace.state.sessions = { 'direct:hermes': 'session-a' }
  workspace.state.sessionMeta = {}
  workspace.activeRuns = new Map()
  workspace.runLedger = { assertLoaded() {}, list: () => [{ status: 'waiting' }] }
  workspace.save = () => {}
  const choose = harness.ipcHandlers.get('local-agent-native-config:choose')
  const clear = harness.ipcHandlers.get('local-agent-native-config:clear')
  await assert.rejects(() => choose(harness.event(), 'hermes'), { message: 'LOCAL_WORK_PREFERENCES_BUSY' })
  assert.equal(workspace.state.sessions['direct:hermes'], 'session-a')
  workspace.runLedger = { assertLoaded() { throw new Error('ledger unavailable') } }
  await assert.rejects(() => choose(harness.event(), 'hermes'), { message: 'LOCAL_WORK_PREFERENCES_BUSY' })
  workspace.runLedger = { list: () => [{ status: 'interrupted', continuation: { state: 'ready' } }] }
  await assert.rejects(() => choose(harness.event(), 'hermes'), { message: 'LOCAL_WORK_PREFERENCES_BUSY' })
  workspace.runLedger.list = () => []
  workspace.save = () => { throw new Error('save failed') }
  await assert.rejects(() => choose(harness.event(), 'hermes'), { message: 'save failed' })
  assert.equal(workspace.state.sessions['direct:hermes'], 'session-a')
  assert.equal(workspace.state.nativeSessionProfiles, undefined)
  workspace.save = () => {}
  await choose(harness.event(), 'hermes')
  assert.equal(workspace.state.sessions['direct:hermes'], undefined)
  workspace.state.sessions['direct:hermes'] = 'session-b'
  await clear(harness.event(), 'hermes')
  assert.equal(workspace.state.sessions['direct:hermes'], 'session-a')
  await choose(harness.event(), 'hermes')
  assert.equal(workspace.state.sessions['direct:hermes'], 'session-b')
})

test('ready activates one fixed local workspace and loads the bundled frontend', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-ready-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory)

  await harness.ready()

  assert.equal(harness.workspaceInstances.length, 1)
  assert.equal(
    harness.workspaceInstances[0].input.storagePath,
    path.join(directory, 'meldwork-workspace.json'),
  )
  assert.equal(
    harness.workspaceInstances[0].input.runLedger.storagePath,
    path.join(directory, 'meldwork-run-ledger.json'),
  )
  assert.match(
    harness.workspaceInstances[0].input.agentFitMatrix.matrixId,
    /^fit-matrix-[a-f0-9]{64}$/,
  )
  assert.equal(harness.workspaceInstances[0].refreshCount, 0)
  assert.equal(harness.customAgentStoreInstances[0].input.storagePath,
    path.join(directory, 'meldwork-custom-agents.json'))
  assert.equal(harness.knowledgeBaseStoreInstances[0].input.storagePath,
    path.join(directory, 'meldwork-knowledge-base.json'))
  assert.equal(harness.attachmentInstances[0].input.rootPath,
    path.join(directory, 'attachments'))
  assert.equal(harness.skillCatalogInstances[0].input.home,
    path.join(directory, 'Home'))
  assert.equal(
    harness.skillSnapshotStoreInstances[0].input.contentBlobStore,
    harness.workspaceInstances[0].input.contentBlobStore,
  )
  assert.equal(
    harness.skillSnapshotSelectionInstances[0].input.contentBlobStore,
    harness.workspaceInstances[0].input.contentBlobStore,
  )
  assert.equal(
    harness.skillSnapshotSelectionInstances[0].input.snapshotStore,
    harness.skillSnapshotStoreInstances[0],
  )
  assert.equal(
    harness.skillSnapshotSelectionInstances[0].input.catalog,
    harness.skillCatalogInstances[0],
  )
  assert.equal(
    harness.skillSnapshotSelectionInstances[0].input.trustStore,
    harness.skillTrustStoreInstances[0],
  )
  assert.equal(
    harness.skillTrustStoreInstances[0].input.storagePath,
    path.join(directory, 'meldwork-private', 'skill-trust-audit.jsonl'),
  )
  assert.equal(typeof harness.skillSnapshotSelectionInstances[0].input.requestTrust, 'function')
  const selectedSkills = [{
    targetKind: 'codex', namespace: 'global', slug: 'review', name: 'Review',
  }]
  assert.deepEqual(
    await harness.workspaceInstances[0].input.validateSkillSelections('codex', selectedSkills),
    selectedSkills,
  )
  assert.deepEqual(harness.skillSnapshotSelectionInstances[0].prepareCalls, [{
    kind: 'codex', selections: selectedSkills,
  }])
  const detected = await harness.workspaceInstances[0].input.detectAgents()
  assert.deepEqual(detected, [])
  assert.equal(harness.installerInstances[0].detectedCount, 1)
  assert.equal(harness.customAgentStoreInstances[0].detectCount, 1)
  assert.equal(typeof harness.workspaceInstances[0].input.connectorRuntime.run, 'function')
  assert.equal(typeof harness.workspaceInstances[0].input.resolveAttachments, 'function')
  assert.equal(typeof harness.workspaceInstances[0].input.validateSkillSelections, 'function')
  assert.equal(typeof harness.workspaceInstances[0].input.validateKnowledgeBaseSelections, 'function')
  assert.equal(typeof harness.workspaceInstances[0].input.imageAttachmentLimit, 'function')
  assert.equal(typeof harness.workspaceInstances[0].input.agentLabel, 'function')
  assert.equal(harness.cloudAgentRuntimeInstances.length, 1)
  assert.equal(harness.cloudAgentRuntimeInstances[0].input.runLedger,
    harness.workspaceInstances[0].input.runLedger)
  assert.equal(harness.cloudAgentRuntimeInstances[0].input.outcomeStore,
    harness.workspaceInstances[0].input.outcomeStore)
  assert.deepEqual(harness.cloudAgentRuntimeInstances[0].input.connectors, [])
  assert.equal(harness.cloudAgentRuntimeInstances[0].startCount, 1)
  assert.equal(harness.cloudAgentOperationStoreInstances[0].input.storagePath,
    path.join(directory, 'meldwork-private', 'cloud-agent-operations.json'))
  assert.equal(harness.channelIngressRuntimeInstances.length, 1)
  assert.equal(
    harness.channelIngressRuntimeInstances[0].input.store,
    harness.channelInboxStoreInstances[0],
  )
  assert.deepEqual(harness.channelIngressRuntimeInstances[0].input.connectors, [])
  assert.equal(harness.channelIngressRuntimeInstances[0].startCount, 1)
  assert.equal(harness.channelIngressRuntimeInstances[0].status().receiverCount, 0)
  assert.equal(harness.channelInboxStoreInstances[0].input.storagePath,
    path.join(directory, 'meldwork-private', 'channel-inbox.json'))
  assert.deepEqual(harness.attachmentInstances[0].cleanupCalls, [[]])
  assert.equal(harness.windows.length, 1)
  assert.equal(harness.windows[0].input.icon?.isEmpty?.(), false)
  assert.match(harness.nativeImagePathCalls[0], /frontend[\\/]public[\\/]logos[\\/]meldwork-app\.png$/)
  if (process.platform === 'darwin') assert.equal(harness.dockIconCalls.length, 1)
  assert.equal(
    harness.windows[0].input.backgroundColor,
    process.platform === 'darwin' ? '#e7edef' : '#f3f6f8',
  )
  if (process.platform === 'darwin') {
    assert.equal(harness.windows[0].input.titleBarStyle, 'hiddenInset')
    assert.deepEqual(harness.windows[0].input.trafficLightPosition, { x: 18, y: 16 })
  } else {
    assert.equal('titleBarStyle' in harness.windows[0].input, false)
    assert.equal('trafficLightPosition' in harness.windows[0].input, false)
  }
  assert.equal(
    harness.windows[0].loads[0].filename,
    path.resolve(__dirname, '../../../frontend/dist/index.html'),
  )
  assert.deepEqual(harness.windows[0].loads[0].options, { hash: '/chat' })
  assert.deepEqual(
    [...harness.ipcHandlers.keys()].filter(name => name.includes('cloud')),
    [
      'local-cloud-agent:provide-input',
      'local-cloud-agent:decide-permission',
      'local-cloud-agent:cancel',
      'local-cloud-agent-bridge:list',
      'local-cloud-agent-bridge:connect',
      'local-cloud-agent-bridge:refresh',
      'local-cloud-agent-bridge:delete',
    ],
  )
  assert.equal([...harness.ipcHandlers.keys()].some(name => (
    name.startsWith('local-cloud-agent:') && name.includes('configure')
  )), false)
  assert.equal([...harness.ipcHandlers.keys()].some(name => name.includes('channel')), false)
  assert.equal(harness.ipcListeners.size, 0)
})

test('an explicitly installed Agent Connector is available through generic catalog metadata and main runtime', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-agent-connector-main-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const manifestDirectory = path.join(directory, 'agent-connectors', 'manifests')
  fs.mkdirSync(manifestDirectory, { recursive: true })
  fs.writeFileSync(
    path.join(manifestDirectory, `${SAMPLE_AGENT_CONNECTOR_MANIFEST.manifestId}.json`),
    serializeAgentConnectorManifest(SAMPLE_AGENT_CONNECTOR_MANIFEST),
  )
  const { harness } = loadMain(directory, {
    detectedAgents: [{
      kind: 'codex', name: 'Codex CLI', executable: '/private/bin/codex',
      version: 'codex-cli 0.147.0', compatibilityState: 'compatible',
    }],
  })
  await harness.ready()
  await assert.rejects(
    harness.ipcHandlers.get('local-agent-connector:configure')(
      harness.event(),
      {
        manifestId: SAMPLE_AGENT_CONNECTOR_MANIFEST.manifestId,
        label: 'Codex review account',
        credentials: null,
        credentialRef: 'credential-ref:renderer-must-not-control',
      },
    ),
    { message: 'AGENT_CONNECTOR_REQUEST_INVALID' },
  )
  const configured = await harness.ipcHandlers.get('local-agent-connector:configure')(
    harness.event(),
    {
      manifestId: SAMPLE_AGENT_CONNECTOR_MANIFEST.manifestId,
      label: 'Codex review account',
      credentials: null,
    },
  )
  assert.equal(configured.credentialConfigured, false)
  assert.equal(Object.hasOwn(configured, 'credentialRef'), false)
  const workspace = harness.workspaceInstances[0]
  const agents = await workspace.input.detectAgents()
  const connector = agents.find(agent => agent.connectorInstanceId)
  assert.ok(connector)
  const catalog = await harness.ipcHandlers.get('local-agent-installer:catalog')(harness.event())
  const profile = catalog.agents.find(agent => agent.kind === connector.kind)
  assert.equal(profile.connector, true)
  assert.equal(profile.description, SAMPLE_AGENT_CONNECTOR_MANIFEST.description)
  assert.doesNotMatch(JSON.stringify(profile), /private\/bin|credential-ref/i)

  const result = await workspace.input.connectorRuntime.run(
    connector,
    'Review through the installed Connector',
    directory,
    { runId: 'run-1', agentRunId: 'agent-run-1', sandbox: 'read-only' },
  )
  assert.equal(result.outcome, 'completed')
  assert.equal(result.connector.upstreamVersion, '0.147.0')
  assert.equal(Object.hasOwn(result.connector, 'credentialRefId'), false)
  assert.equal(harness.runAgentCalls.length, 1)
  assert.equal(harness.runAgentCalls[0][0].executable, '/private/bin/codex')
  const tested = await harness.ipcHandlers.get('local-agent-connector:test')(
    harness.event(), connector.kind,
  )
  assert.equal(tested.passed, true)
  const testWorkdir = harness.runAgentCalls.at(-1)[2]
  assert.notEqual(testWorkdir, directory)
  assert.equal(path.dirname(testWorkdir), os.tmpdir())
  assert.match(path.basename(testWorkdir), /^meldwork-connector-test-/)
  assert.equal(fs.existsSync(testWorkdir), false)
})

test('Connector test removes its temporary workspace when execution fails', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-connector-failure-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const manifestDirectory = path.join(directory, 'agent-connectors', 'manifests')
  fs.mkdirSync(manifestDirectory, { recursive: true })
  fs.writeFileSync(path.join(manifestDirectory, `${SAMPLE_AGENT_CONNECTOR_MANIFEST.manifestId}.json`),
    serializeAgentConnectorManifest(SAMPLE_AGENT_CONNECTOR_MANIFEST))
  let testWorkdir
  const { harness } = loadMain(directory, {
    detectedAgents: [{ kind: 'codex', name: 'Codex CLI', executable: '/private/bin/codex',
      version: 'codex-cli 0.147.0', compatibilityState: 'compatible' }],
    moduleMocks: { './agents/cli/cli-adapters.cjs': {
      detectAgents: async () => [], imageAttachmentLimit: () => 0,
      runAgent: async (_agent, _prompt, workdir) => {
        testWorkdir = workdir
        assert.deepEqual(fs.readdirSync(workdir), [])
        throw new Error('simulated failure')
      },
    } },
  })
  await harness.ready()
  const configured = await harness.ipcHandlers.get('local-agent-connector:configure')(harness.event(), {
    manifestId: SAMPLE_AGENT_CONNECTOR_MANIFEST.manifestId, label: 'Failing connector', credentials: null,
  })
  const result = await harness.ipcHandlers.get('local-agent-connector:test')(harness.event(), configured.instanceId)
  assert.equal(result.passed, false)
  assert.equal(path.dirname(testWorkdir), os.tmpdir())
  assert.equal(fs.existsSync(testWorkdir), false)
})

test('Agent Connector main process persists isolated accounts without returning CredentialRefs or secrets', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-agent-connector-accounts-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const manifestDirectory = path.join(directory, 'agent-connectors', 'manifests')
  fs.mkdirSync(manifestDirectory, { recursive: true })
  fs.writeFileSync(
    path.join(
      manifestDirectory,
      `${SAMPLE_CREDENTIAL_AGENT_CONNECTOR_MANIFEST.manifestId}.json`,
    ),
    serializeAgentConnectorManifest(SAMPLE_CREDENTIAL_AGENT_CONNECTOR_MANIFEST),
  )
  const options = {
    detectedAgents: [{
      kind: 'codex', name: 'Codex CLI', executable: '/private/bin/codex',
      version: 'codex-cli 0.147.0', compatibilityState: 'compatible',
    }],
    nativeShellEnvironment: () => ({ env: { XDG_CONFIG_HOME: '/native/private-config' }, source: 'native-shell' }),
  }
  const { harness } = loadMain(directory, options)
  await harness.ready()
  const configure = harness.ipcHandlers.get('local-agent-connector:configure')
  const list = harness.ipcHandlers.get('local-agent-connector:list')
  const remove = harness.ipcHandlers.get('local-agent-connector:delete')

  const workspace = harness.workspaceInstances[0]
  await workspace.input.detectAgents()
  const first = workspace.input.connectorRuntime.configure({
    manifestId: SAMPLE_CREDENTIAL_AGENT_CONNECTOR_MANIFEST.manifestId,
    label: 'Codex account A',
    credentials: { 'openai-api-key': 'connector-main-secret-a' },
  })
  const second = workspace.input.connectorRuntime.configure({
    manifestId: SAMPLE_CREDENTIAL_AGENT_CONNECTOR_MANIFEST.manifestId,
    label: 'Codex account B',
    credentials: { 'openai-api-key': 'connector-main-secret-b' },
  })
  assert.notEqual(first.instanceId, second.instanceId)
  assert.equal(first.credentialConfigured, true)
  const listed = await list(harness.event())
  assert.deepEqual(listed.map(item => item.label), ['Codex account A', 'Codex account B'])
  assert.doesNotMatch(JSON.stringify(listed), /credential-ref|connector-main-secret/i)

  const agents = await workspace.input.detectAgents()
  const result = await workspace.input.connectorRuntime.run(
    agents.find(agent => agent.kind === first.instanceId),
    'Review with account A',
    directory,
    { runId: 'run-account-a', agentRunId: 'agent-run-account-a', sandbox: 'read-only' },
  )
  assert.doesNotMatch(JSON.stringify(result), /credential-ref|connector-main-secret/i)
  assert.equal(harness.runAgentCalls.at(-1)[3].env.CODEX_API_KEY, 'connector-main-secret-a')
  assert.equal(harness.runAgentCalls.at(-1)[3].env.OPENAI_API_KEY, undefined)
  assert.equal(Object.hasOwn(harness.runAgentCalls.at(-1)[3].env, 'OPENAI_BASE_URL'), false)
  assert.equal(Object.hasOwn(harness.runAgentCalls.at(-1)[3].env, 'OPENAI_MODEL'), false)
  const firstEnv = harness.runAgentCalls.at(-1)[3].env
  const firstOptions = harness.runAgentCalls.at(-1)[3]
  assert.match(firstEnv.CODEX_HOME, /connector-native/)
  assert.equal(firstEnv.XDG_CONFIG_HOME, path.join(firstEnv.CODEX_HOME, 'config'))
  assert.equal(fs.statSync(firstEnv.CODEX_HOME).isDirectory(), true)
  assert.equal(Object.hasOwn(harness.runAgentCalls.at(-1)[3], 'connectorCredentialIsolation'), false)
  assert.equal(Object.hasOwn(harness.runAgentCalls.at(-1)[3], 'connectorInstanceId'), false)
  const { childEnvironment } = require('../../src/agents/cli/cli-process-support.cjs')
  const previousXdg = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = '/unrelated/global-profile'
  let child
  try {
    child = childEnvironment({ kind: 'codex', executable: '/private/bin/codex' }, directory,
      harness.runAgentCalls.at(-1)[3], process.platform)
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
  }
  assert.equal(child.CODEX_HOME, firstEnv.CODEX_HOME)
  assert.equal(child.XDG_CONFIG_HOME, firstEnv.XDG_CONFIG_HOME)
  assert.equal(child.CODEX_API_KEY, 'connector-main-secret-a')

  await workspace.input.connectorRuntime.run(
    agents.find(agent => agent.kind === second.instanceId),
    'Review with account B',
    directory,
    { runId: 'run-account-b', agentRunId: 'agent-run-account-b', sandbox: 'read-only' },
  )
  assert.equal(harness.runAgentCalls.at(-1)[3].env.CODEX_API_KEY, 'connector-main-secret-b')
  const secondOptions = harness.runAgentCalls.at(-1)[3]
  assert.notEqual(secondOptions.env.CODEX_HOME, firstEnv.CODEX_HOME)
  const { executable } = require('../support/cli-adapters-test-helpers.cjs')
  const { runAgent } = require('../../src/agents/cli/cli-adapters.cjs')
  const cli = executable(directory, 'connector-codex.cjs', [
    'const path = require("node:path")',
    'const home = process.env.CODEX_HOME',
    'const scoped = process.env.XDG_CONFIG_HOME === path.join(home, "config")',
    'const account = process.env.CODEX_API_KEY === "connector-main-secret-a" ? "a" : process.env.CODEX_API_KEY === "connector-main-secret-b" ? "b" : "other"',
    'const noGlobalProvider = process.env.OPENAI_API_KEY === undefined',
    'process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:`${account}:${scoped}:${noGlobalProvider}`}}) + "\\n")',
  ].join('\n'))
  const previousGlobalKey = process.env.OPENAI_API_KEY
  const previousCodexKey = process.env.CODEX_API_KEY
  process.env.OPENAI_API_KEY = 'unrelated-global-provider'
  process.env.CODEX_API_KEY = 'unrelated-global-codex'
  try {
    const results = await Promise.all([firstOptions, secondOptions].map(options =>
      runAgent({ kind: 'codex', name: 'Codex', executable: cli }, 'hello', directory, options)))
    assert.deepEqual(results.map(result => result.text), ['a:true:true', 'b:true:true'])
  } finally {
    if (previousGlobalKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousGlobalKey
    if (previousCodexKey === undefined) delete process.env.CODEX_API_KEY
    else process.env.CODEX_API_KEY = previousCodexKey
  }

  const instanceFile = fs.readFileSync(
    path.join(directory, 'agent-connectors', 'instances.json'),
    'utf8',
  )
  const credentialFile = fs.readFileSync(
    path.join(directory, 'meldwork-private', 'agent-connector-credentials.json'),
    'utf8',
  )
  assert.match(instanceFile, /credential-ref:/)
  assert.doesNotMatch(instanceFile, /connector-main-secret|encrypted/i)
  assert.doesNotMatch(credentialFile, /connector-main-secret|Codex account/i)

  const { harness: restarted } = loadMain(directory, options)
  await restarted.ready()
  const restored = await restarted.ipcHandlers.get('local-agent-connector:list')(
    restarted.event(),
  )
  assert.deepEqual(restored.map(item => item.label), ['Codex account A', 'Codex account B'])
  const restartedWorkspace = restarted.workspaceInstances[0]
  const restartedAgents = await restartedWorkspace.input.detectAgents()
  await restartedWorkspace.input.connectorRuntime.run(
    restartedAgents.find(agent => agent.kind === first.instanceId), 'Resume account A', directory,
    { runId: 'run-account-a-restart', agentRunId: 'agent-run-account-a-restart', sandbox: 'read-only' },
  )
  assert.equal(restarted.runAgentCalls.at(-1)[3].env.CODEX_HOME, firstEnv.CODEX_HOME)
  await restarted.ipcHandlers.get('local-agent-connector:delete')(
    restarted.event(), first.instanceId,
  )
  const afterDelete = await restarted.ipcHandlers.get('local-agent-connector:list')(
    restarted.event(),
  )
  assert.deepEqual(afterDelete.map(item => item.label), ['Codex account B'])

  await assert.rejects(
    remove(harness.event(), {
      instanceId: second.instanceId,
      credentialRef: 'credential-ref:renderer-controlled',
    }),
    { message: 'AGENT_CONNECTOR_REQUEST_INVALID' },
  )
  await assert.rejects(
    configure(harness.event(), {
      manifestId: SAMPLE_CREDENTIAL_AGENT_CONNECTOR_MANIFEST.manifestId,
      label: 'Invalid account',
      credentials: { unexpected: 'connector-main-secret-c' },
    }),
    { message: 'AGENT_CONNECTOR_REQUEST_INVALID' },
  )
})

test('Agent Connector package IPC keeps paths private and requires native approval', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-agent-connector-package-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const packagePath = path.join(directory, 'local-echo.connector.json')
  fs.writeFileSync(
    packagePath,
    serializeAgentConnectorPackage(SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE),
  )
  const { harness } = loadMain(directory, {
    dialogResult: { canceled: false, filePaths: [packagePath] },
    messageBoxResult: { response: 0 },
  })
  await harness.ready()
  const invoke = name => harness.ipcHandlers.get(`local-agent-connector:${name}`)
  const imported = await invoke('import')(harness.event())
  assert.equal(imported.canceled, false)
  assert.equal(imported.package.state, 'imported')
  assert.equal(imported.package.origin.filename, path.basename(packagePath))
  assert.doesNotMatch(JSON.stringify(imported), new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  const packageId = SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE.packageId
  const approved = await invoke('approve')(harness.event(), packageId)
  assert.equal(approved.canceled, false)
  assert.equal(approved.package.state, 'approved')
  const approvalOptions = harness.dialogCalls.at(-1)[1]
  assert.match(approvalOptions.detail, /Meldwork/)
  assert.match(approvalOptions.detail, /Transport: cli\/json/)
  assert.match(approvalOptions.detail, /Permissions: read-only/)
  assert.match(approvalOptions.detail, /Credential slots: None/)
  assert.match(approvalOptions.detail, /Outbound destinations: None/)
  assert.doesNotMatch(approvalOptions.detail, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  assert.equal((await invoke('install')(harness.event(), packageId)).state, 'installed')
  const configured = await invoke('configure')(harness.event(), {
    manifestId: SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE.manifest.manifestId,
    label: 'Main-process echo',
    credentials: null,
  })
  const tested = await invoke('test')(harness.event(), configured.instanceId)
  assert.equal(tested.passed, true)
  assert.equal(Object.hasOwn(tested, 'text'), false)
  assert.equal(harness.runAgentCalls.length, 0)
  assert.deepEqual((await invoke('audit')(harness.event(), packageId)).map(event => event.action), [
    'imported', 'approved', 'installed',
  ])
  assert.equal((await invoke('disable')(harness.event(), packageId)).state, 'disabled')
  assert.equal((await invoke('install')(harness.event(), packageId)).state, 'installed')
  assert.equal((await invoke('revoke')(harness.event(), packageId)).state, 'revoked')
  await invoke('delete')(harness.event(), configured.instanceId)
  assert.equal((await invoke('remove')(harness.event(), packageId)).state, 'removed')
})

test('Connector approval rejects a package reimported while confirmation is open', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-connector-approval-race-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const packagePath = path.join(directory, 'sample.connector.json')
  fs.writeFileSync(packagePath, serializeAgentConnectorPackage(SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE))
  const decision = deferred()
  const { harness } = loadMain(directory, {
    dialogResult: { canceled: false, filePaths: [packagePath] }, messageBoxResult: decision.promise,
  })
  await harness.ready()
  const invoke = name => harness.ipcHandlers.get(`local-agent-connector:${name}`)
  const packageId = SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE.packageId
  await invoke('import')(harness.event())
  const approval = invoke('approve')(harness.event(), packageId)
  await waitFor(() => harness.dialogCalls.length >= 2)
  await invoke('remove')(harness.event(), packageId)
  await invoke('import')(harness.event())
  decision.resolve({ response: 0 })
  await assert.rejects(approval, { message: 'AGENT_CONNECTOR_PACKAGE_CHANGED' })
  assert.equal((await invoke('inspect')(harness.event(), packageId)).state, 'imported')
})

test('Connector credential confirmation does not read the shell after trust changes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-connector-env-race-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { createAgentConnectorManifest } = require('../../src/agents/connectors/agent-connector-manifest.cjs')
  const { createAgentConnectorPackage, SDK_HTTP_JSON_RECIPE_ID } = require('../../src/agents/connectors/agent-connector-package-store.cjs')
  const manifest = createAgentConnectorManifest({ connectorId: 'external.env-race', connectorVersion: '1.0.0',
    kind: 'agent', label: 'Env test', description: 'Environment credential test.',
    transport: { type: 'http', protocol: 'json' }, upstream: { id: 'meldwork-sdk', minVersion: '1.0.0', maxVersion: '1.0.0' },
    invocation: { recipeId: SDK_HTTP_JSON_RECIPE_ID }, domains: ['general'],
    session: { supported: false, resume: false, cancel: false, checkpoint: false }, inputTypes: ['text'],
    permissionModes: ['read-only'], eventProtocolVersion: 1, eventTypes: ['Completed', 'Failed', 'Cancelled'],
    usage: { inputTokens: false, outputTokens: false, costMicros: false, toolCalls: false, outboundBytes: false, elapsedMs: false },
    outboundDestinations: ['https://connector.example.com'],
    credentials: { mode: 'credential-ref', slots: [{ slotId: 'access-token', type: 'token', required: true }] }, license: 'MIT' })
  const pkg = createAgentConnectorPackage({ publisher: { id: 'example', name: 'Example' },
    provider: { id: SDK_HTTP_JSON_RECIPE_ID, config: { endpoint: 'https://connector.example.com/run', authSlotId: 'access-token' } }, manifest })
  const decision = deferred()
  const reads = []
  let environmentGate = null
  const { harness } = loadMain(directory, { messageBoxResult: decision.promise,
    nativeShellEnvironment: input => {
      if (input.extraEnvKeys) { reads.push(input.extraEnvKeys); if (environmentGate) return environmentGate.promise }
      return { env: {}, source: 'process' }
    } })
  await harness.ready()
  const connectors = harness.workspaceInstances[0].input.connectorRuntime
  const store = connectors.packageStore
  store.import(serializeAgentConnectorPackage(pkg), 'connector.json')
  store.approve(pkg.packageId)
  store.install(pkg.packageId)
  connectors.refresh([])
  const invoke = name => harness.ipcHandlers.get(`local-agent-connector:${name}`)
  const pending = invoke('configure-from-environment')(harness.event(), { packageId: pkg.packageId,
    label: 'Account', environmentKeys: { 'access-token': 'CONNECTOR_API_KEY' } })
  await waitFor(() => harness.dialogCalls.length >= 1)
  store.disable(pkg.packageId)
  store.install(pkg.packageId)
  decision.resolve({ response: 0 })
  await assert.rejects(pending, { message: 'AGENT_CONNECTOR_PACKAGE_CHANGED' })
  assert.deepEqual(reads, [])
  assert.deepEqual(connectors.instanceStore.list(), [])
  environmentGate = deferred()
  const duringRead = invoke('configure-from-environment')(harness.event(), { packageId: pkg.packageId,
    label: 'Account', environmentKeys: { 'access-token': 'CONNECTOR_API_KEY' } })
  await waitFor(() => reads.length === 1)
  store.disable(pkg.packageId)
  store.install(pkg.packageId)
  environmentGate.resolve({ env: { CONNECTOR_API_KEY: 'synthetic-secret' }, source: 'native-shell' })
  await assert.rejects(duringRead, { message: 'AGENT_CONNECTOR_PACKAGE_CHANGED' })
  assert.deepEqual(connectors.instanceStore.list(), [])
})

test('Connector credentials can be read from the native shell only after native confirmation', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-connector-env-ipc-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { createAgentConnectorManifest } = require('../../src/agents/connectors/agent-connector-manifest.cjs')
  const { createAgentConnectorPackage, SDK_HTTP_JSON_RECIPE_ID } = require('../../src/agents/connectors/agent-connector-package-store.cjs')
  const manifest = createAgentConnectorManifest({ connectorId: 'external.env-test', connectorVersion: '1.0.0',
    kind: 'agent', label: 'Env test', description: 'Environment credential test.',
    transport: { type: 'http', protocol: 'json' }, upstream: { id: 'meldwork-sdk', minVersion: '1.0.0', maxVersion: '1.0.0' },
    invocation: { recipeId: SDK_HTTP_JSON_RECIPE_ID }, domains: ['general'],
    session: { supported: false, resume: false, cancel: false, checkpoint: false }, inputTypes: ['text'],
    permissionModes: ['read-only'], eventProtocolVersion: 1, eventTypes: ['Completed', 'Failed', 'Cancelled'],
    usage: { inputTokens: false, outputTokens: false, costMicros: false, toolCalls: false, outboundBytes: false, elapsedMs: false },
    outboundDestinations: ['https://connector.example.com'],
    credentials: { mode: 'credential-ref', slots: [{ slotId: 'access-token', type: 'token', required: true }] }, license: 'MIT' })
  const pkg = createAgentConnectorPackage({ publisher: { id: 'example', name: 'Example' },
    provider: { id: SDK_HTTP_JSON_RECIPE_ID, config: { endpoint: 'https://connector.example.com/run', authSlotId: 'access-token' } }, manifest })
  const packagePath = path.join(directory, 'connector.json')
  fs.writeFileSync(packagePath, serializeAgentConnectorPackage(pkg))
  const decision = { response: 0 }
  const reads = []
  const { harness } = loadMain(directory, {
    dialogResult: { canceled: false, filePaths: [packagePath] }, messageBoxResult: decision,
    nativeShellEnvironment: input => {
      if (input.extraEnvKeys) reads.push(input.extraEnvKeys)
      return { source: 'native-shell', env: {
        ...(input.extraEnvKeys?.includes('CONNECTOR_API_KEY') ? { CONNECTOR_API_KEY: 'synthetic-private-value' } : {}),
        ...(input.extraEnvKeys?.includes('SECOND_API_KEY') ? { SECOND_API_KEY: 'second-private-value' } : {}),
      } }
    },
  })
  await harness.ready()
  const invoke = name => harness.ipcHandlers.get(`local-agent-connector:${name}`)
  await invoke('import')(harness.event())
  await invoke('approve')(harness.event(), pkg.packageId)
  await invoke('install')(harness.event(), pkg.packageId)
  const request = { packageId: pkg.packageId, label: 'Private account', environmentKeys: { 'access-token': 'CONNECTOR_API_KEY' } }
  decision.response = 1
  assert.deepEqual(await invoke('configure-from-environment')(harness.event(), request), { canceled: true })
  assert.equal(reads.some(keys => keys.includes('CONNECTOR_API_KEY')), false)
  decision.response = 0
  const configured = await invoke('configure-from-environment')(harness.event(), request)
  assert.equal(configured.canceled, false)
  assert.equal(configured.instance.credentialConfigured, true)
  assert.doesNotMatch(JSON.stringify(configured), /synthetic-private-value|credential-ref/)
  const stored = fs.readFileSync(path.join(directory, 'meldwork-private', 'agent-connector-credentials.json'), 'utf8')
  assert.doesNotMatch(stored, /synthetic-private-value/)
  const instanceStore = harness.workspaceInstances[0].input.connectorRuntime.instanceStore
  const internal = instanceStore.listRecords().find(item => item.instanceId === configured.instance.instanceId)
  assert.deepEqual(instanceStore.resolveCredential(internal.credentialRef), { 'access-token': 'synthetic-private-value' })
  assert.match(harness.dialogCalls.at(-1)[1].detail, /CONNECTOR_API_KEY/)
  assert.doesNotMatch(harness.dialogCalls.at(-1)[1].detail, /synthetic-private-value/)
  const second = await invoke('configure-from-environment')(harness.event(), {
    ...request, label: 'Second account', environmentKeys: { 'access-token': 'SECOND_API_KEY' },
  })
  const secondInternal = instanceStore.listRecords().find(item => item.instanceId === second.instance.instanceId)
  assert.notEqual(secondInternal.credentialRef, internal.credentialRef)
  assert.deepEqual(instanceStore.resolveCredential(secondInternal.credentialRef), { 'access-token': 'second-private-value' })
  const connectorRuntime = harness.workspaceInstances[0].input.connectorRuntime
  const authorizations = []
  connectorRuntime.fetch = async (_endpoint, options) => {
    authorizations.push(options.headers.authorization)
    return { ok: true, text: async () => '{"text":"ok"}' }
  }
  const agents = await harness.workspaceInstances[0].input.detectAgents()
  for (const [index, instance] of [configured.instance, second.instance].entries()) {
    const agent = agents.find(item => item.kind === instance.instanceId)
    const result = await connectorRuntime.run(agent, 'hello', directory, {
      runId: `run-env-${index}`, agentRunId: `agent-run-env-${index}`, sandbox: 'read-only',
    })
    assert.equal(result.outcome, 'completed')
    assert.doesNotMatch(JSON.stringify(result), /private-value|credential-ref/)
  }
  assert.deepEqual(authorizations, ['Bearer synthetic-private-value', 'Bearer second-private-value'])
  await assert.rejects(() => invoke('configure-from-environment')(harness.event(), {
    ...request, environmentKeys: { 'access-token': 'NODE_OPTIONS' },
  }), { message: 'AGENT_CONNECTOR_CREDENTIAL_INVALID' })
  await assert.rejects(() => invoke('configure-from-environment')(harness.event(), {
    ...request, environmentKeys: { 'access-token': 'MISSING_KEY' },
  }), { message: 'AGENT_CONNECTOR_CREDENTIAL_ENV_MISSING' })
})

test('unsigned Skill trust uses native approval and exposes only review and revocation', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-skill-trust-ipc-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const bindingId = `skill-trust-binding-${'a'.repeat(64)}`
  const record = {
    bindingId,
    state: 'approved',
    decisionId: `skill-trust-decision-${'b'.repeat(64)}`,
  }
  const { harness } = loadMain(directory, {
    messageBoxResult: { response: 0 },
    skillTrustRecords: [record],
  })
  await harness.ready()
  const manifest = {
    identity: { id: 'global/review', version: '1.0.0' },
    origin: { type: 'local-unsigned', publisher: 'Local author' },
    agents: [{ kind: 'codex', minVersion: '0.100.0', maxVersion: '1.0.0' }],
    inputTypes: ['text'],
    tools: ['filesystem'],
    credentials: [],
    permissionMode: 'read-only',
    networkDestinations: [],
    sideEffectClass: 'none',
  }
  const approved = await harness.skillSnapshotSelectionInstances[0].input.requestTrust({
    binding: {
      bindingId,
      contractHash: 'c'.repeat(64),
      contentHash: 'd'.repeat(64),
    },
    coordinates: {
      targetKind: 'codex', namespace: 'global', slug: 'review', name: 'Review',
    },
    manifest,
  })
  assert.equal(approved, true)
  const approvalOptions = harness.dialogCalls.at(-1)[1]
  assert.match(approvalOptions.detail, /Skill: Review \(global\/review 1\.0\.0\)/)
  assert.match(approvalOptions.detail, /Permission: read-only/)
  assert.match(approvalOptions.detail, /Side-effect class: none/)
  assert.doesNotMatch(approvalOptions.detail, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  assert.deepEqual(
    await harness.ipcHandlers.get('local-skill-trust:list')(harness.event()),
    [record],
  )
  assert.deepEqual(
    await harness.ipcHandlers.get('local-skill-trust:revoke')(harness.event(), bindingId),
    { bindingId, revoked: true },
  )
  assert.deepEqual(harness.skillTrustStoreInstances[0].revocations, [bindingId])
  assert.throws(
    () => harness.ipcHandlers.get('local-skill-trust:revoke')(harness.event(), { bindingId }),
    { message: 'LOCAL_SKILL_TRUST_REQUEST_INVALID' },
  )
})

test('Custom Agent IPC keeps executable paths private and refreshes the local catalog', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-custom-agent-ipc-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const selectedExecutable = '/private/tools/review-agent'
  const { harness } = loadMain(directory, {
    dialogResult: { canceled: false, filePaths: [selectedExecutable] },
  })
  await harness.ready()

  const result = await harness.ipcHandlers.get('local-custom-agent:create')(
    harness.event(),
    {
      label: 'Review Agent',
      description: 'Reviews repository changes.',
      args: ['review', '--format=text'],
      promptMode: 'stdin',
      executable: '/renderer/must-not-control-this',
    },
  )

  assert.equal(result.canceled, false)
  assert.equal(result.agent.kind, 'custom-0123456789abcdef')
  assert.equal(result.agent.commandName, 'review-agent')
  assert.equal('executable' in result.agent, false)
  assert.equal('args' in result.agent, false)
  assert.doesNotMatch(JSON.stringify(result), /private\/tools|renderer\/must-not-control/)
  assert.deepEqual(harness.customAgentStoreInstances[0].created, [{
    input: {
      label: 'Review Agent',
      description: 'Reviews repository changes.',
      args: ['review', '--format=text'],
      promptMode: 'stdin',
    },
    executable: selectedExecutable,
  }])
  assert.equal(harness.workspaceInstances[0].refreshCount, 1)

  let outboundCalls = 0
  const onOutboundPayload = () => { outboundCalls += 1 }
  const signal = new AbortController().signal
  const customReply = await harness.workspaceInstances[0].input.runAgent(
    { kind: result.agent.kind },
    'Review this change',
    '/tmp/project',
    {
      sandbox: 'read-only',
      signal,
      attachments: ['/tmp/project/input.txt'],
      onProgress: () => {},
      onEvent: () => {},
      onOutboundPayload,
    },
  )
  assert.deepEqual(customReply, { text: 'custom reply', sessionRef: '' })
  assert.equal(harness.customAgentRunCalls.length, 1)
  assert.equal(outboundCalls, 0)
  const [runKind, runPrompt, runWorkdir, runOptions] = harness.customAgentRunCalls[0]
  assert.equal(runKind, result.agent.kind)
  assert.equal(runPrompt, 'Review this change')
  assert.equal(runWorkdir, '/tmp/project')
  assert.equal(runOptions.signal, signal)
  assert.equal(runOptions.sandbox, 'read-only')
  assert.deepEqual(runOptions.attachments, ['/tmp/project/input.txt'])
  assert.equal(runOptions.onOutboundPayload, onOutboundPayload)
  assert.equal(harness.runAgentCalls.length, 0)

  const catalog = await harness.ipcHandlers.get('local-agent-installer:catalog')(harness.event())
  const custom = catalog.agents.find(agent => agent.kind === 'custom-0123456789abcdef')
  assert.equal(custom.custom, true)
  assert.equal(custom.commandName, 'review-agent')
  assert.equal('executable' in custom, false)
  assert.equal('args' in custom, false)
  assert.deepEqual(
    await harness.ipcHandlers.get('local-agent-installer:skills')(
      harness.event(), 'custom-0123456789abcdef',
    ),
    { supported: false, skills: [], total: 0, limit: 0 },
  )
})

test('Custom Agent deletion is blocked while a local conversation references it', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-custom-agent-delete-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const kind = 'custom-0123456789abcdef'
  const { harness } = loadMain(directory, {
    customAgents: [{
      kind,
      label: 'Review Agent',
      description: '',
      commandName: 'review-agent',
      promptMode: 'stdin',
      custom: true,
      installed: true,
    }],
    workspaceSnapshot: {
      agents: [],
      groups: [{ id: 'group-1', agentKinds: [kind] }],
      messages: [],
      localOnly: true,
    },
  })
  await harness.ready()

  await assert.rejects(
    harness.ipcHandlers.get('local-custom-agent:delete')(harness.event(), kind),
    { message: 'CUSTOM_AGENT_IN_USE' },
  )
  assert.deepEqual(harness.customAgentStoreInstances[0].removed, [])

  harness.workspaceInstances[0].state.groups = []
  assert.deepEqual(
    await harness.ipcHandlers.get('local-custom-agent:delete')(harness.event(), kind),
    { deleted: true, kind },
  )
  assert.deepEqual(harness.customAgentStoreInstances[0].removed, [kind])
})

test('a second desktop launch restores and focuses the existing window', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-single-instance-focus-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory, {
    windowFocused: false,
    windowMinimized: true,
  })
  await harness.ready()

  harness.appListeners.get('second-instance')()

  assert.equal(harness.windows.length, 1)
  assert.equal(harness.windows[0].restoreCount, 1)
  assert.equal(harness.windows[0].showCount, 1)
  assert.equal(harness.windows[0].focusCount, 1)
})

test('application activation cannot recreate a window after shutdown starts', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-shutdown-activate-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory)
  await harness.ready()
  const originalWindow = harness.windows[0]

  harness.appListeners.get('before-quit')({ preventDefault: () => {} })
  originalWindow.windowListeners.get('closed')()
  harness.appListeners.get('activate')()

  assert.equal(harness.windows.length, 1)
  await waitFor(() => harness.exitCalls.length === 1)
  assert.deepEqual(harness.exitCalls, [0])
})

test('quit cleanup has a strict deadline when a runtime does not settle', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-quit-timeout-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { main } = loadMain(directory)

  const result = await main.runQuitCleanup([
    () => new Promise(() => {}),
    () => Promise.reject(new Error('cleanup failed')),
  ], 5)

  assert.deepEqual(result, { timedOut: true })
})

test('closing the app window does not stop an active main-process Channel receiver', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-channel-background-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory, { channelReceiverCount: 1 })
  await harness.ready()
  const runtime = harness.channelIngressRuntimeInstances[0]

  harness.appListeners.get('window-all-closed')()

  assert.equal(runtime.startCount, 1)
  assert.equal(runtime.shutdownCount, 0)
  assert.equal(harness.quitCount, 0)
})

test('run completion uses sanitized renderer events and a localized background notification', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-notification-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory, { locale: 'zh-CN', windowFocused: false })
  await harness.ready()
  const window = harness.windows[0]
  const workspace = harness.workspaceInstances[0]

  workspace.emit('run-finished', {
    groupId: '历史群聊 1',
    runId: 'run:trace.1',
    mode: 'auto',
    status: 'partial',
    threadRootId: 'thread-1',
    targetKinds: ['hermes', '../../private', 'hermes'],
    completedKinds: ['hermes'],
    failedKinds: ['codex', '../../private', 'codex'],
    startedAt: 100,
    finishedAt: 200,
    path: '/private/workspace',
    sessionRef: 'secret-session',
    content: 'secret message body',
  })

  const finished = window.webContents.sent.find(([channel]) => (
    channel === 'local-workspace:run-finished'
  ))
  assert.deepEqual(finished, ['local-workspace:run-finished', {
    groupId: '历史群聊 1',
    runId: 'run:trace.1',
    mode: 'auto',
    status: 'partial',
    threadRootId: 'thread-1',
    targetKinds: ['hermes'],
    completedKinds: ['hermes'],
    failedKinds: ['codex'],
    startedAt: 100,
    finishedAt: 200,
  }])
  assert.equal(harness.notificationInstances.length, 1)
  const notification = harness.notificationInstances[0]
  assert.equal(notification.input.title, 'Meldwork · 部分完成')
  assert.equal(notification.input.body, '1 个 Agent 完成，1 个未完成')
  assert.equal(notification.input.icon?.isEmpty?.(), false)
  assert.equal(notification.showCount, 1)
  assert.doesNotMatch(
    JSON.stringify(notification.input),
    /private|secret-session|secret message|历史群聊|thread-1/,
  )

  notification.emit('click')
  assert.equal(window.showCount, 1)
  assert.equal(window.focusCount, 1)
  assert.deepEqual(window.webContents.sent.at(-1), [
    'local-workspace:open-group', { groupId: '历史群聊 1' },
  ])

  workspace.emit('run-finished', {
    groupId: 'group-1', status: 'completed', targetKinds: [], completedKinds: [],
  })
  assert.equal(harness.notificationInstances.length, 1)
})

test('runtime trace IPC forwards only sanitized allowlisted fields', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-run-event-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory)
  await harness.ready()
  const window = harness.windows[0]
  const workspace = harness.workspaceInstances[0]

  workspace.emit('run-event', {
    runId: 'run-1',
    agentRunId: 'run-1:1:codex:agent-1',
    groupId: '历史群聊 1',
    threadRootId: 'thread-1',
    agentKind: 'codex',
    round: 1,
    seq: 2,
    timestamp: 100,
    id: 'tool-1',
    type: 'tool_result_summary',
    status: 'completed',
    title: 'search',
    summary: 'Read /Users/private/work with token=private-value',
    command: 'rg private',
    executable: '/tmp/codex',
    sessionRef: 'private-session',
    env: { SECRET: 'private' },
  })

  assert.deepEqual(window.webContents.sent.at(-1), [
    'local-workspace:run-event',
    {
      runId: 'run-1',
      agentRunId: 'run-1:1:codex:agent-1',
      groupId: '历史群聊 1',
      threadRootId: 'thread-1',
      agentKind: 'codex',
      round: 1,
      seq: 2,
      timestamp: 100,
      status: 'completed',
      id: 'tool-1',
      type: 'tool_result_summary',
      title: 'search',
      summary: 'Read [path] with credential=[redacted]',
    },
  ])

  const sentCount = window.webContents.sent.length
  workspace.emit('run-event', {
    runId: 'run-2', agentRunId: 'agent-2', groupId: 'group-1',
    agentKind: '../../private', round: 1, seq: 1, timestamp: 100,
    type: 'status', status: 'running',
  })
  assert.equal(window.webContents.sent.length, sentCount)
})

test('a completion notification restores a closed window and opens its local group', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-notification-restore-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory, { deferRestoredWindowLoad: true })
  await harness.ready()
  const originalWindow = harness.windows[0]
  const workspace = harness.workspaceInstances[0]
  originalWindow.windowListeners.get('closed')()

  workspace.emit('run-finished', {
    groupId: 'group-restore',
    status: 'completed',
    targetKinds: ['codex'],
    completedKinds: ['codex'],
  })

  assert.equal(harness.notificationInstances.length, 1)
  assert.equal(harness.notificationInstances[0].input.title, 'Meldwork · Run completed')
  assert.equal(harness.notificationInstances[0].input.body, '1 Agent completed the reply')
  assert.equal(harness.notificationInstances[0].input.icon?.isEmpty?.(), false)
  assert.equal(originalWindow.webContents.sent.length, 0)

  harness.notificationInstances[0].emit('click')

  assert.equal(harness.windows.length, 2)
  const restoredWindow = harness.windows[1]
  assert.equal(restoredWindow.showCount, 1)
  assert.equal(restoredWindow.focusCount, 1)
  assert.equal(restoredWindow.webContents.mainFrame.url, 'about:blank')
  assert.deepEqual(restoredWindow.webContents.sent, [])

  restoredWindow.finishLoad()
  assert.deepEqual(restoredWindow.webContents.sent.at(-1), [
    'local-workspace:open-group', { groupId: 'group-restore' },
  ])
  restoredWindow.finishLoad()
  assert.equal(restoredWindow.webContents.sent.length, 1)
})

test('attachment storage initialization failure does not block text chat startup', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-attachment-fallback-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory, {
    attachmentInitError: new Error('sensitive local storage path'),
  })

  await harness.ready()

  assert.equal(harness.attachmentConstructionCount, 1)
  assert.equal(harness.attachmentInstances.length, 0)
  assert.equal(harness.windows.length, 1)
  await assert.doesNotReject(
    harness.ipcHandlers.get('local-workspace:send')(
      harness.event(),
      { groupId: 'group-1', text: 'text still works', targetKinds: ['codex'], attachments: [] },
    ),
  )
  for (const [channel, args] of [
    ['local-attachments:pick', []],
    ['local-attachments:import', [{ name: 'x.png', mimeType: 'image/png', bytes: [1] }]],
    ['local-attachments:preview', ['attachment-1']],
    ['local-attachments:open', ['attachment-1']],
    ['local-attachments:discard', [['attachment-1']]],
  ]) {
    await assert.rejects(
      async () => harness.ipcHandlers.get(channel)(harness.event(), ...args),
      { message: 'LOCAL_ATTACHMENT_STORAGE_UNAVAILABLE' },
    )
  }
})

test('workspace run IPC requires an explicit non-empty Agent target contract', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-target-contract-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory)
  await harness.ready()

  for (const [channel, input] of [
    ['local-workspace:send', { groupId: 'group-1', text: 'Do the work' }],
    ['local-workspace:send', { groupId: 'group-1', text: 'Do the work', targetKinds: [] }],
  ]) {
    await assert.rejects(
      async () => harness.ipcHandlers.get(channel)(harness.event(), input),
      { message: 'LOCAL_MESSAGE_TARGET_REQUIRED' },
      channel,
    )
  }
  await assert.doesNotReject(() => harness.ipcHandlers.get('local-workspace:send')(
    harness.event(),
    { groupId: 'group-1', text: 'Route the work', targetKinds: [], routingMode: 'automatic' },
  ))
})

test('workspace run IPC normalizes one strict collaboration protocol', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-protocol-contract-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory)
  await harness.ready()
  const send = harness.ipcHandlers.get('local-workspace:send')
  const workspace = harness.workspaceInstances[0]
  const request = { groupId: 'group-1', text: 'Do the work', targetKinds: ['codex', 'hermes'] }

  for (const selectors of [
    { protocol: 'v4 ' },
    { protocol: 'unknown', harnessVersion: 4 },
    { protocol: 'legacy', harnessVersion: 4 },
    { harnessVersion: 5 },
    { collaborationVersion: 2 },
    { v4: 'true' },
  ]) {
    await assert.rejects(
      async () => send(harness.event(), { ...request, ...selectors }),
      { message: 'LOCAL_MESSAGE_PROTOCOL_INVALID' },
    )
  }
  assert.deepEqual(workspace.sendMessageCalls, [])

  for (const [selectors, protocol] of [
    [{}, 'legacy'],
    [{ protocol: 'legacy' }, 'legacy'],
    [{ protocol: 'v4' }, 'v4'],
    [{ harnessVersion: 4 }, 'v4'],
    [{ collaborationVersion: 4, v4: true }, 'v4'],
    [{ harnessVersion: 3, collaborationVersion: 3, v4: false }, 'legacy'],
  ]) {
    await send(harness.event(), { ...request, ...selectors })
    assert.deepEqual(workspace.sendMessageCalls.at(-1), { ...request, protocol })
  }
})

test('workspace stop IPC forwards only a validated group and run pair', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-stop-contract-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory)
  await harness.ready()
  const stop = harness.ipcHandlers.get('local-workspace:stop')
  const workspace = harness.workspaceInstances[0]

  assert.equal(await stop(harness.event(), 'group-1', 'run:trace.1'), true)
  assert.equal(await stop(harness.event(), '历史群聊 1', 'run-legacy'), true)
  assert.deepEqual(workspace.stopCalls, [
    { groupId: 'group-1', runId: 'run:trace.1' },
    { groupId: '历史群聊 1', runId: 'run-legacy' },
  ])

  assert.equal(await stop(harness.event(), 'group-1', ''), false)
  assert.equal(await stop(harness.event(), 'group\ninvalid', 'run-2'), false)
  assert.equal(await stop(harness.event(), 'group-1', '../run'), false)
  assert.equal(workspace.stopCalls.length, 2)
})

test('workspace Agent control IPC accepts only a bound active Agent request', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-agent-control-contract-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory)
  await harness.ready()
  const control = harness.ipcHandlers.get('local-workspace:control-agent')
  const workspace = harness.workspaceInstances[0]

  assert.equal(await control(
    harness.event(), '群聊 1', 'run:trace.1', 'hermes', 'retry', '',
  ), true)
  assert.equal(await control(
    harness.event(), '群聊 1', 'run:trace.1', 'hermes', 'replace', 'codex',
  ), true)
  assert.deepEqual(workspace.agentControlCalls, [
    {
      groupId: '群聊 1', runId: 'run:trace.1', kind: 'hermes', action: 'retry', replacementKind: '',
    },
    {
      groupId: '群聊 1', runId: 'run:trace.1', kind: 'hermes', action: 'replace', replacementKind: 'codex',
    },
  ])

  for (const args of [
    ['group\ninvalid', 'run-1', 'hermes', 'cancel', ''],
    ['group-1', '../run', 'hermes', 'cancel', ''],
    ['group-1', 'run-1', '../hermes', 'cancel', ''],
    ['group-1', 'run-1', 'hermes', 'restart', ''],
    ['group-1', 'run-1', 'hermes', 'retry', 'codex'],
    ['group-1', 'run-1', 'hermes', 'replace', 'hermes'],
  ]) assert.equal(await control(harness.event(), ...args), false)
  assert.equal(workspace.agentControlCalls.length, 2)
})

test('workspace Human Gate IPC derives decisions from the persisted option', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-human-gate-contract-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory)
  await harness.ready()
  const decide = harness.ipcHandlers.get('local-workspace:decide-human-gate')
  const workspace = harness.workspaceInstances[0]
  const gateId = `human-gate-${'b'.repeat(64)}`
  const inputGateId = `human-gate-${'c'.repeat(64)}`
  workspace.state.humanGates = [{
    gateId,
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      { optionId: 'reopen-task', name: 'Reopen Task', kind: 'reopen' },
    ],
  }, {
    gateId: inputGateId,
    type: 'input',
    options: [
      { optionId: 'submit-input', name: 'Submit', kind: 'respond' },
      { optionId: 'cancel-input', name: 'Cancel', kind: 'reject' },
    ],
  }]

  assert.deepEqual(await decide(harness.event(), gateId, {
    status: 'approved', optionId: 'allow-once',
  }), { gateId, status: 'approved', optionId: 'allow-once' })
  assert.deepEqual(await decide(harness.event(), gateId, {
    optionId: 'reopen-task',
  }), { gateId, status: 'rejected', optionId: 'reopen-task' })
  assert.deepEqual(await decide(harness.event(), inputGateId, {
    optionId: 'submit-input', response: 'stable',
  }), {
    gateId: inputGateId, status: 'approved', optionId: 'submit-input', response: 'stable',
  })
  assert.deepEqual(workspace.humanGateDecisionCalls, [
    { gateId, decision: { status: 'approved', optionId: 'allow-once' } },
    { gateId, decision: { status: 'rejected', optionId: 'reopen-task' } },
    {
      gateId: inputGateId,
      decision: { status: 'approved', optionId: 'submit-input', response: 'stable' },
    },
  ])

  for (const [invalidGateId, decision] of [
    ['gate-1', { status: 'approved', optionId: 'allow-once' }],
    [gateId, { status: 'pending', optionId: 'allow-once' }],
    [gateId, { status: 'approved', optionId: '../allow' }],
    [gateId, { status: 'approved', optionId: 'allow-once', actorId: 'renderer' }],
    [gateId, { status: 'approved', optionId: 'reopen-task' }],
    [gateId, { optionId: 'allow-once', response: 'unexpected' }],
    [inputGateId, { optionId: 'submit-input' }],
    [inputGateId, { optionId: 'cancel-input', response: 'unexpected' }],
    [gateId, { optionId: 'missing-option' }],
  ]) {
    await assert.rejects(
      async () => decide(harness.event(), invalidGateId, decision),
      { message: 'HUMAN_GATE_DECISION_INVALID' },
    )
  }
  assert.equal(workspace.humanGateDecisionCalls.length, 3)
})

test('Cloud Agent IPC exposes only validated continuation and cancel actions', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cloud-agent-ipc-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory)
  await harness.ready()
  const runtime = harness.cloudAgentRuntimeInstances[0]
  const provideInput = harness.ipcHandlers.get('local-cloud-agent:provide-input')
  const decidePermission = harness.ipcHandlers.get('local-cloud-agent:decide-permission')
  const cancel = harness.ipcHandlers.get('local-cloud-agent:cancel')
  runtime.provideInput = (runId, requestId, value) => {
    runtime.inputCalls.push({ runId, requestId, value })
    return {
      runId,
      agentRunId: 'agent-run-cloud-1',
      status: 'waiting_input',
      connectorId: 'cloud-test',
      jobId: 'private-job-1',
      cursor: 'private-cursor-1',
      artifactIds: ['artifact-1'],
      evidenceIds: ['evidence-1'],
      waiting: {
        type: 'input', requestId, prompt: 'Which branch?',
        jobId: 'nested-private-job', cursor: 'nested-private-cursor',
      },
    }
  }
  runtime.decidePermission = (runId, requestId, decision) => {
    runtime.permissionCalls.push({ runId, requestId, decision })
    return {
      runId,
      agentRunId: 'agent-run-cloud-1',
      status: 'waiting_permission',
      connectorId: 'cloud-test',
      jobId: 'private-job-1',
      cursor: 'private-cursor-2',
      artifactIds: ['artifact-1'],
      evidenceIds: ['evidence-1'],
      waiting: {
        type: 'permission', requestId, permission: 'workspace-write', summary: 'Apply patch',
        jobId: 'nested-private-job', cursor: 'nested-private-cursor',
      },
    }
  }

  assert.deepEqual(
    await provideInput(harness.event(), 'run-cloud-1', 'question-1', 'release/next'),
    {
      runId: 'run-cloud-1',
      agentRunId: 'agent-run-cloud-1',
      status: 'waiting_input',
      connectorId: 'cloud-test',
      artifactIds: ['artifact-1'],
      evidenceIds: ['evidence-1'],
      waiting: { type: 'input', requestId: 'question-1', prompt: 'Which branch?' },
    },
  )
  assert.deepEqual(
    await decidePermission(harness.event(), 'run-cloud-1', 'permission-1', 'approved'),
    {
      runId: 'run-cloud-1',
      agentRunId: 'agent-run-cloud-1',
      status: 'waiting_permission',
      connectorId: 'cloud-test',
      artifactIds: ['artifact-1'],
      evidenceIds: ['evidence-1'],
      waiting: {
        type: 'permission', requestId: 'permission-1',
        permission: 'workspace-write', summary: 'Apply patch',
      },
    },
  )
  assert.equal(await cancel(harness.event(), 'run-cloud-1'), true)
  assert.deepEqual(runtime.inputCalls, [{
    runId: 'run-cloud-1', requestId: 'question-1', value: 'release/next',
  }])
  assert.deepEqual(runtime.permissionCalls, [{
    runId: 'run-cloud-1', requestId: 'permission-1', decision: 'approved',
  }])
  assert.deepEqual(runtime.cancelCalls, ['run-cloud-1'])

  assert.throws(
    () => provideInput(harness.event(), '../run', 'question-1', 'value'),
    { message: 'CLOUD_AGENT_INPUT_INVALID' },
  )
  assert.throws(
    () => provideInput(harness.event(), 'run-cloud-1', 'question-1', ['private']),
    { message: 'CLOUD_AGENT_INPUT_INVALID' },
  )
  assert.throws(
    () => decidePermission(harness.event(), 'run-cloud-1', 'permission-1', 'allow'),
    { message: 'CLOUD_AGENT_PERMISSION_DECISION_INVALID' },
  )
  assert.throws(
    () => cancel(harness.event(), '../run'),
    { message: 'CLOUD_AGENT_RUN_INVALID' },
  )
  assert.equal(runtime.inputCalls.length, 1)
  assert.equal(runtime.permissionCalls.length, 1)
  assert.equal(runtime.cancelCalls.length, 1)
})

test('Outcome IPC persists every Adoption action with a main-owned human actor', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-outcome-ipc-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory)
  await harness.ready()
  const workspace = harness.workspaceInstances[0]
  const { contentBlobStore, outcomeStore } = workspace.input
  const contentRef = contentBlobStore.put('Outcome IPC report', { mediaType: 'text/plain' })
  const artifact = outcomeStore.putArtifact({
    type: 'document',
    name: 'outcome-ipc-report.txt',
    producedBy: {
      runId: 'run-outcome-1',
      agentRunId: 'agent-run-outcome-1',
      agentKind: 'codex',
    },
    contentRef,
    contentHash: contentRef.hash,
  })
  const recordAdoption = harness.ipcHandlers.get('local-outcome:record-adoption')
  let previousAdoptionId = null

  for (const status of ['exported', 'applied', 'committed', 'sent']) {
    const request = {
      artifactId: artifact.artifactId,
      status,
      summary: `The local user recorded ${status}.`,
      destinationRef: { kind: 'workspace-relative', path: `adoptions/${status}.json` },
      previousAdoptionId,
    }
    const result = await recordAdoption(harness.event(), request)
    assert.deepEqual(Object.keys(result).sort(), [
      'adoptionId', 'artifactId', 'previousAdoptionId', 'status',
    ])
    assert.equal(result.artifactId, artifact.artifactId)
    assert.equal(result.status, status)
    assert.equal(result.previousAdoptionId, previousAdoptionId)
    const stored = outcomeStore.getAdoption(result.adoptionId)
    assert.deepEqual(stored.actor, { kind: 'human', actorId: 'local-user' })
    assert.deepEqual(stored.destinationRef, request.destinationRef)
    previousAdoptionId = result.adoptionId
  }

  assert.throws(
    () => recordAdoption(harness.event(), {
      artifactId: artifact.artifactId,
      status: 'exported',
      destinationRef: { kind: 'workspace-relative', path: 'adoptions/exported.json' },
      actor: { kind: 'agent', agentKind: 'codex' },
    }),
    { message: 'LOCAL_ADOPTION_REQUEST_INVALID' },
  )
  assert.throws(
    () => recordAdoption(harness.event(), {
      artifactId: `artifact-${'a'.repeat(64)}`,
      status: 'exported',
      destinationRef: { kind: 'workspace-relative', path: 'adoptions/exported.json' },
    }),
    { message: 'ARTIFACT_NOT_FOUND' },
  )
  assert.throws(
    () => recordAdoption(harness.event(), {
      artifactId: artifact.artifactId,
      status: 'accepted',
      destinationRef: { kind: 'workspace-relative', path: 'adoptions/accepted.json' },
    }),
    { message: 'LOCAL_ADOPTION_REQUEST_INVALID' },
  )
  assert.throws(
    () => recordAdoption(harness.event(), {
      artifactId: artifact.artifactId,
      status: 'exported',
    }),
    { message: 'LOCAL_ADOPTION_REQUEST_INVALID' },
  )
  assert.throws(
    () => recordAdoption(harness.event(), {
      artifactId: artifact.artifactId,
      status: 'sent',
      summary: 'Authorization: Bearer renderer-secret-value',
      destinationRef: { kind: 'uri', uri: 'https://example.test/delivery/1' },
    }),
    { message: 'ADOPTION_FORBIDDEN_VALUE' },
  )
})

test('startup attachment cleanup receives every persisted message reference once', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-attachment-cleanup-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'meldwork-workspace.json'), JSON.stringify({
    version: 2,
    groups: [{ id: 'one' }, { id: 'two' }],
    messages: [
      { groupId: 'one', attachments: [{ id: 'shared' }, { id: 'only-one' }] },
      { groupId: 'two', attachments: [{ id: 'shared' }] },
    ],
    sessions: {},
  }))
  const { harness } = loadMain(directory, {
    workspaceSnapshot: {
      agents: [],
      groups: [{ id: 'one' }, { id: 'two' }],
      messages: [
        { groupId: 'one', attachments: [{ id: 'shared' }, { id: 'only-one' }] },
        { groupId: 'two', attachments: [{ id: 'shared' }] },
      ],
      localOnly: true,
    },
  })

  await harness.ready()

  assert.deepEqual(harness.attachmentInstances[0].cleanupCalls, [['shared', 'only-one']])
})

test('startup attachment cleanup failure keeps the validated store available', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-attachment-cleanup-fallback-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory, {
    attachmentCleanupError: new Error('temporary cleanup failure'),
  })

  await harness.ready()

  assert.deepEqual(harness.attachmentInstances[0].cleanupCalls, [[]])
  await assert.doesNotReject(
    harness.ipcHandlers.get('local-attachments:pick')(harness.event(), 1),
  )
})

test('startup skips destructive attachment cleanup when the workspace file is malformed', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-attachment-corrupt-workspace-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'meldwork-workspace.json'), '{not-json')
  const { harness } = loadMain(directory)

  await harness.ready()

  assert.equal(harness.windows.length, 1)
  assert.deepEqual(harness.attachmentInstances[0].cleanupCalls, [])
})

test('ready creates the desktop window without eagerly duplicating renderer Agent detection', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-ready-window-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory)

  await harness.ready()
  assert.equal(harness.windows.length, 1)
  assert.equal(harness.workspaceInstances[0].refreshCount, 0)
})

test('Electron safeStorage stays lazy during startup', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-ready-safe-storage-'))
  const safeStorageAccesses = []
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory, {
    onSafeStorageAccess: windowCount => safeStorageAccesses.push(windowCount),
  })

  await harness.ready()
  assert.deepEqual(safeStorageAccesses, [])
  assert.equal(harness.windows.length, 1)
})

test('window navigation permits only local app pages and credential-free HTTPS links', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-navigation-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory)
  await harness.ready()
  const window = harness.windows[0]

  assert.equal(harness.permissionHandlers.check(), false)
  let granted = true
  harness.permissionHandlers.request(null, 'camera', value => { granted = value })
  assert.equal(granted, false)
  assert.equal(harness.permissionHandlers.device(), false)

  assert.deepEqual(window.openHandler({ url: 'https://example.com/docs' }), { action: 'deny' })
  assert.deepEqual(window.openHandler({ url: 'http://example.com' }), { action: 'deny' })
  assert.deepEqual(window.openHandler({ url: 'https://user:pass@example.com' }), { action: 'deny' })
  assert.deepEqual(harness.externalUrls, ['https://example.com/docs'])

  const navigate = window.webContents.listeners.get('will-navigate')
  let prevented = 0
  navigate({ preventDefault: () => { prevented += 1 } }, window.loads[0].url)
  assert.equal(prevented, 0)

  navigate(
    { preventDefault: () => { prevented += 1 } },
    pathToFileURL(path.join(directory, 'untrusted.html')).href,
  )
  navigate({ preventDefault: () => { prevented += 1 } }, 'https://example.com/help')
  navigate({ preventDefault: () => { prevented += 1 } }, 'javascript:alert(1)')
  assert.equal(prevented, 3)
  assert.deepEqual(harness.externalUrls, [
    'https://example.com/docs',
    'https://example.com/help',
  ])
})

test('Knowledge base IPC exposes status, safe guides, and a local Obsidian directory picker', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-knowledge-base-ipc-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const vaultPath = path.join(directory, 'Obsidian Vault')
  fs.mkdirSync(vaultPath)
  const { harness } = loadMain(directory, {
    dialogResult: { canceled: false, filePaths: [vaultPath] },
    knowledgeBaseGuideUrl: (kind, action) => (
      kind === 'unsafe'
        ? 'http://example.com/unsafe'
        : `https://example.com/${kind}/${action}`
    ),
  })
  await harness.ready()

  const status = await harness.ipcHandlers.get('local-knowledge-base:status')(harness.event())
  assert.deepEqual(status, [{ kind: 'obsidian', installed: true, vaultPath: '' }])
  assert.equal(harness.knowledgeBaseResolveCalls[0].home, path.join(directory, 'Home'))

  const opened = await harness.ipcHandlers.get('local-knowledge-base:open-guide')(
    harness.event(), 'feishu', 'login',
  )
  assert.equal(opened, true)
  assert.deepEqual(harness.externalUrls, ['https://example.com/feishu/login'])

  const unsafe = await harness.ipcHandlers.get('local-knowledge-base:open-guide')(
    harness.event(), 'unsafe', 'login',
  )
  assert.equal(unsafe, false)
  assert.deepEqual(harness.externalUrls, ['https://example.com/feishu/login'])

  const picked = await harness.ipcHandlers.get('local-knowledge-base:pick-obsidian-vault')(
    harness.event(),
  )
  assert.deepEqual(harness.dialogCalls[0][1], {
    properties: ['openDirectory', 'createDirectory'],
  })
  assert.deepEqual(harness.knowledgeBaseStoreInstances[0].savedVaultPaths, [vaultPath])
  assert.deepEqual(picked, [{ kind: 'obsidian', installed: true, vaultPath }])
})

test('Knowledge Connector IPC exposes a sanitized complete lifecycle with main-owned source grants', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-knowledge-connector-ipc-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const vaultPath = path.join(directory, 'Private Obsidian Vault')
  const notePath = path.join(vaultPath, 'notes', 'decision.md')
  fs.mkdirSync(path.dirname(notePath), { recursive: true })
  fs.writeFileSync(notePath, [
    'Connector evidence for a decision.',
    'api_key=sk-renderer-must-not-see-123456',
  ].join('\n'))
  const { harness } = loadMain(directory, { obsidianVaultPath: vaultPath })
  await harness.ready()
  const list = harness.ipcHandlers.get('local-knowledge-connector:list')
  const probe = harness.ipcHandlers.get('local-knowledge-connector:probe')
  const search = harness.ipcHandlers.get('local-knowledge-connector:search')
  const fetch = harness.ipcHandlers.get('local-knowledge-connector:fetch')
  const snapshot = harness.ipcHandlers.get('local-knowledge-connector:snapshot')
  const citation = harness.ipcHandlers.get('local-knowledge-connector:citation')
  const revoke = harness.ipcHandlers.get('local-knowledge-connector:revoke')
  const authorize = harness.ipcHandlers.get('local-knowledge-connector:authorize')
  const select = harness.ipcHandlers.get('local-knowledge-connector:select')

  const instances = await list(harness.event())
  assert.equal(instances.length, 2)
  const instance = instances.find(item => item.connectorId === 'knowledge.filesystem')
  assert.ok(instance)
  const probed = await probe(harness.event(), instance.instanceId)
  const [source] = await search(harness.event(), instance.instanceId, {
    query: 'evidence', limit: 5,
  })
  const sourceRequest = { sourceId: source.sourceId, locator: source.locator }
  const fetched = await fetch(harness.event(), instance.instanceId, sourceRequest)
  const captured = await snapshot(harness.event(), instance.instanceId, sourceRequest)
  const cited = await citation(harness.event(), instance.instanceId, {
    snapshotId: captured.snapshotId,
  })
  const selected = await select(harness.event(), instance.instanceId, {
    ...sourceRequest,
    captureMode: 'snapshot',
  })
  const rendererPayload = JSON.stringify({
    instances, probed, source, fetched, captured, cited, selected,
  })
  assert.equal(instance.accessMode, 'read-only')
  assert.equal(probed.status, 'ready')
  assert.equal(Object.hasOwn(selected, 'locator'), false)
  assert.equal(Object.hasOwn(captured, 'contentRef'), false)
  assert.equal(Object.hasOwn(cited.citation, 'contentRef'), false)
  assert.match(fetched.content, /\[redacted\]/)
  assert.doesNotMatch(rendererPayload, new RegExp(vaultPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(rendererPayload, /credentialRef|sk-renderer-must-not-see/i)

  const validated = await harness.workspaceInstances[0].input.validateKnowledgeBaseSelections(
    ['codex'],
    [{ kind: 'obsidian', targetKinds: ['codex'], selectionId: selected.selectionId }],
  )
  assert.equal(validated[0].connectorSource.snapshot.sourceId, source.sourceId)
  assert.equal(validated[0].connectorSource.citation.verification, 'snapshot')
  fs.writeFileSync(notePath, 'Mutated after main-owned snapshot')
  assert.match(
    harness.workspaceInstances[0].input.contentBlobStore
      .read(validated[0].connectorSource.snapshot.contentRef).toString('utf8'),
    /Connector evidence/,
  )

  assert.throws(
    () => list(harness.event(), 'unexpected'),
    { message: 'LOCAL_KNOWLEDGE_CONNECTOR_REQUEST_INVALID' },
  )
  await assert.rejects(
    () => search(harness.event(), instance.instanceId, {
      query: 'evidence', limit: 5, vaultPath,
    }),
    { message: 'LOCAL_KNOWLEDGE_SEARCH_INVALID' },
  )
  await assert.rejects(
    () => select(harness.event(), instance.instanceId, {
      sourceId: source.sourceId,
      locator: source.locator,
      captureMode: 'snapshot',
      credentialRef: 'credential-ref:renderer-controlled',
    }),
    { message: 'LOCAL_KNOWLEDGE_SELECTION_INVALID' },
  )
  await assert.rejects(
    () => fetch(harness.event(), instance.instanceId, {
      sourceId: `knowledge-source-${'a'.repeat(64)}`,
      locator: 'notes/private.md',
    }),
    { message: 'LOCAL_KNOWLEDGE_SOURCE_NOT_GRANTED' },
  )
  await assert.rejects(
    () => harness.workspaceInstances[0].input.validateKnowledgeBaseSelections(
      ['codex'],
      [{
        kind: 'obsidian', targetKinds: ['codex'], selectionId: selected.selectionId,
        locator: source.locator,
      }],
    ),
    { message: 'LOCAL_KNOWLEDGE_BASE_SELECTION_INVALID' },
  )
  const revoked = await revoke(harness.event(), instance.instanceId)
  assert.equal(revoked.authorized, false)
  const reauthorized = await authorize(harness.event(), 'knowledge.filesystem')
  assert.equal(reauthorized.instanceId, instance.instanceId)
})

test('Knowledge base status IPC shares concurrent source probes', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-knowledge-base-single-flight-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const result = deferred()
  const expected = [{ kind: 'feishu', installed: true, ready: true }]
  const { harness } = loadMain(directory, {
    resolveKnowledgeBaseSources: () => result.promise,
  })
  await harness.ready()
  const status = harness.ipcHandlers.get('local-knowledge-base:status')

  const first = status(harness.event())
  const second = status(harness.event())
  await waitFor(() => harness.knowledgeBaseResolveCalls.length === 1)
  assert.equal(harness.knowledgeBaseResolveCalls.length, 1)

  result.resolve(expected)
  assert.deepEqual(await Promise.all([first, second]), [expected, expected])

  assert.deepEqual(await status(harness.event()), expected)
  assert.equal(harness.knowledgeBaseResolveCalls.length, 2)
})

test('Knowledge base selections derive safe access from main-process source status', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-knowledge-base-selection-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const source = {
    kind: 'dingtalk',
    label: 'DingTalk',
    accessMode: 'cli',
    commandName: 'dws',
    ready: true,
  }
  const hintCalls = []
  const { harness } = loadMain(directory, {
    knowledgeBaseSources: [source],
    knowledgeBaseSelectionHint: (cachedSource, targetKinds) => {
      hintCalls.push({ cachedSource, targetKinds })
      return cachedSource?.kind === 'dingtalk' ? {
        kind: 'dingtalk',
        name: 'DingTalk',
        accessMode: 'cli',
        commandName: cachedSource.commandName,
        targetKinds,
      } : null
    },
  })
  await harness.ready()

  const validate = harness.workspaceInstances[0].input.validateKnowledgeBaseSelections
  const validated = await validate(['codex', 'hermes'], [{
    kind: 'dingtalk',
    targetKinds: ['hermes'],
    commandName: 'renderer-controlled-command',
  }])

  assert.deepEqual(validated, [{
    kind: 'dingtalk', name: 'DingTalk', accessMode: 'cli',
    commandName: 'dws', targetKinds: ['hermes'],
  }])
  assert.deepEqual(hintCalls, [{ cachedSource: source, targetKinds: ['hermes'] }])
  assert.equal(harness.knowledgeBaseResolveCalls.length, 1)

  await assert.rejects(validate(['codex'], [{
    kind: 'dingtalk', targetKinds: ['hermes'],
  }]), { message: 'LOCAL_KNOWLEDGE_BASE_SELECTION_INVALID' })
})

test('directory picker uses the operating system localized title', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-directory-dialog-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory)
  await harness.ready()

  const selected = await harness.ipcHandlers.get('local-workspace:pick-directory')(harness.event())

  assert.equal(selected, '')
  assert.equal(harness.dialogCalls.length, 1)
  assert.deepEqual(harness.dialogCalls[0][1], {
    properties: ['openDirectory', 'createDirectory'],
  })
})

test('Skills IPC uses the installed-Agent gate and the shared local catalog', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-skills-ipc-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const skillsResult = {
    supported: true,
    total: 1,
    limit: 100,
    skills: [{ targetKind: 'codex', namespace: 'global', slug: 'review', name: 'Review' }],
  }
  const { harness } = loadMain(directory, { skillsResult })
  await harness.ready()

  const result = await harness.ipcHandlers.get('local-agent-installer:skills')(
    harness.event(), 'codex',
  )

  assert.deepEqual(result, skillsResult)
  assert.equal(harness.installerInstances[0].skillsKind, 'codex')
  assert.deepEqual(await harness.installerInstances[0].input.listSkills('codex'), skillsResult)
  assert.deepEqual(harness.skillCatalogInstances[0].listCalls, ['codex'])
})

test('Cloud Agent catalog and Skills IPC preserve remote metadata without exposing paths', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cloud-skills-ipc-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const kind = 'cloud-0123456789abcdef01234567'
  class TestCloudAgentBridgeStore {
    refresh() { return Promise.resolve([]) }
    connectorEntries() { return [] }
    catalogEntries() {
      return [{
        kind, sourceKind: 'claude', label: 'Claude Code @ Research server',
        description: 'Remote Claude Code', version: '2.1.123', installed: true,
        installSupported: false, custom: false,
        connector: true, cloud: true, available: false, credentialState: 'missing',
        serverLabel: 'Research server',
      }]
    }
    skillsForInstance(instanceId) {
      return instanceId === kind
        ? [{ namespace: 'claude', slug: 'research', name: 'Research' }]
        : null
    }
    close() {}
  }
  const { harness } = loadMain(directory, {
    moduleMocks: {
      './agents/cloud/cloud-agent-bridge.cjs': { CloudAgentBridgeStore: TestCloudAgentBridgeStore },
    },
  })
  await harness.ready()

  const catalog = await harness.ipcHandlers.get('local-agent-installer:catalog')(harness.event())
  const cloudAgent = catalog.agents.find(agent => agent.kind === kind)
  assert.equal(harness.workspaceInstances[0].input.isKnownAgent(kind), true)
  assert.equal(harness.workspaceInstances[0].input.isKnownAgent('unknown'), false)
  assert.equal(cloudAgent.sourceKind, 'claude')
  assert.equal(cloudAgent.version, '2.1.123')
  assert.equal(cloudAgent.credentialState, 'missing')
  assert.equal(cloudAgent.available, false)
  assert.equal(cloudAgent.showInSidebar, true)
  assert.equal(cloudAgent.custom, false)
  assert.equal('executable' in cloudAgent, false)

  harness.workspaceInstances[0].state.agentPreferences = { [kind]: { showInSidebar: false } }
  const hiddenCatalog = await harness.ipcHandlers.get('local-agent-installer:catalog')(harness.event())
  assert.equal(hiddenCatalog.agents.find(agent => agent.kind === kind).showInSidebar, false)

  assert.deepEqual(
    await harness.ipcHandlers.get('local-agent-installer:skills')(harness.event(), kind),
    {
      supported: true,
      total: 1,
      limit: 64,
      skills: [{ targetKind: kind, namespace: 'claude', slug: 'research', name: 'Research' }],
    },
  )
})

test('attachment IPC returns bounded metadata, opens private files, and never exposes paths', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-image-ipc-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const first = path.join(directory, 'diagram.png')
  const second = path.join(directory, 'flow.png')
  const third = path.join(directory, 'overflow.png')
  const { harness } = loadMain(directory, {
    dialogResult: { canceled: false, filePaths: [first, second, third] },
  })
  await harness.ready()

  const picked = await harness.ipcHandlers.get('local-attachments:pick')(
    harness.event(), 2,
  )
  assert.equal(picked.attachments.length, 2)
  assert.equal(picked.truncated, true)
  assert.deepEqual(harness.attachmentInstances[0].importedFiles, [first, second])
  assert.deepEqual(harness.dialogCalls[0][1], {
    properties: ['openFile', 'multiSelections'],
    filters: [{
      name: 'Files',
      extensions: require('../../src/attachments/attachment-records.cjs').ATTACHMENT_FILE_EXTENSIONS,
    }],
  })
  for (const attachment of picked.attachments) {
    assert.deepEqual(Object.keys(attachment).sort(), [
      'id', 'mimeType', 'name', 'previewDataUrl', 'size',
    ])
    assert.equal(attachment.previewDataUrl, 'data:image/png;base64,AQID')
    assert.equal(JSON.stringify(attachment).includes(directory), false)
  }

  const imported = await harness.ipcHandlers.get('local-attachments:import')(
    harness.event(),
    { name: 'paste.png', mimeType: 'image/png', bytes: [1, 2, 3] },
  )
  assert.equal(imported.name, 'paste.png')
  assert.equal(imported.previewDataUrl, 'data:image/png;base64,AQID')
  assert.deepEqual(harness.attachmentInstances[0].importedBuffers, [
    { name: 'paste.png', mimeType: 'image/png', bytes: [1, 2, 3] },
  ])

  const previewed = await harness.ipcHandlers.get('local-attachments:preview')(
    harness.event(), picked.attachments[0].id,
  )
  assert.equal(previewed.previewDataUrl, 'data:image/png;base64,AQID')
  assert.deepEqual(harness.attachmentInstances[0].readWithMetadataCalls, [
    picked.attachments[0].id,
    picked.attachments[1].id,
    imported.id,
    picked.attachments[0].id,
  ])
  assert.deepEqual(harness.attachmentInstances[0].resolved, [])
  assert.equal('path' in previewed, false)

  const opened = await harness.ipcHandlers.get('local-attachments:open')(
    harness.event(), picked.attachments[0].id,
  )
  assert.equal(opened, true)
  assert.deepEqual(harness.attachmentInstances[0].resolved, [[picked.attachments[0].id]])
  assert.deepEqual(harness.openPathCalls, [
    path.join(directory, 'attachments', picked.attachments[0].id, 'image.png'),
  ])
  assert.equal(JSON.stringify(opened).includes(directory), false)
})

test('image picker does not import files after application shutdown starts', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-image-shutdown-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const dialogResult = deferred()
  const selected = path.join(directory, 'late-selection.png')
  const { harness } = loadMain(directory, { dialogResult: dialogResult.promise })
  await harness.ready()

  const picking = harness.ipcHandlers.get('local-attachments:pick')(harness.event())
  await waitFor(() => harness.dialogCalls.length === 1)
  harness.appListeners.get('before-quit')({ preventDefault: () => {} })
  dialogResult.resolve({ canceled: false, filePaths: [selected] })

  await assert.rejects(picking, { message: 'DESKTOP_CLIENT_SHUTTING_DOWN' })
  assert.deepEqual(harness.attachmentInstances[0].importedFiles, [])
})

test('image dimensions are bounded before nativeImage decoding and checked again afterward', async (t) => {
  const firstDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-image-pixels-before-'))
  const secondDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-image-pixels-after-'))
  t.after(() => fs.rmSync(firstDirectory, { recursive: true, force: true }))
  t.after(() => fs.rmSync(secondDirectory, { recursive: true, force: true }))
  const oversizedBeforeDecode = loadMain(firstDirectory, {
    attachmentBytes: pngHeader(8193, 4096),
  })
  await oversizedBeforeDecode.harness.ready()

  await assert.rejects(
    async () => oversizedBeforeDecode.harness.ipcHandlers.get('local-attachments:import')(
      oversizedBeforeDecode.harness.event(),
      { name: 'large.png', mimeType: 'image/png', bytes: [1, 2, 3] },
    ),
    { message: 'LOCAL_ATTACHMENT_TOO_LARGE' },
  )
  assert.equal(oversizedBeforeDecode.harness.nativeImageCalls.length, 0)
  assert.equal(oversizedBeforeDecode.harness.attachmentInstances[0].discarded.length, 1)

  const oversizedAfterDecode = loadMain(secondDirectory, {
    attachmentBytes: pngHeader(1, 1),
    nativeImageSize: { width: 8193, height: 4096 },
  })
  await oversizedAfterDecode.harness.ready()
  await assert.rejects(
    async () => oversizedAfterDecode.harness.ipcHandlers.get('local-attachments:import')(
      oversizedAfterDecode.harness.event(),
      { name: 'decoded-large.png', mimeType: 'image/png', bytes: [1, 2, 3] },
    ),
    { message: 'LOCAL_ATTACHMENT_TOO_LARGE' },
  )
  assert.equal(oversizedAfterDecode.harness.nativeImageCalls.length, 1)
  assert.equal(oversizedAfterDecode.harness.attachmentInstances[0].discarded.length, 1)
})

test('discard IPC is idempotent and refuses to delete attachments referenced by messages', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-discard-ipc-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory, {
    workspaceSnapshot: {
      agents: [],
      groups: [{ id: 'group-1' }],
      messages: [{
        groupId: 'group-1',
        attachments: [{ id: 'referenced' }],
      }],
      localOnly: true,
    },
  })
  await harness.ready()
  const discard = harness.ipcHandlers.get('local-attachments:discard')

  assert.deepEqual(
    await discard(harness.event(), ['referenced', 'orphan', 'already-absent', 'orphan']),
    {
      discardedIds: ['orphan', 'already-absent'],
      retainedIds: ['referenced'],
    },
  )
  assert.deepEqual(harness.attachmentInstances[0].discarded, [
    ['orphan', 'already-absent'],
  ])
  assert.deepEqual(
    await discard(harness.event(), ['already-absent']),
    { discardedIds: ['already-absent'], retainedIds: [] },
  )
})

test('deleting a conversation removes only attachments no longer referenced elsewhere', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-delete-attachments-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory, {
    workspaceSnapshot: {
      agents: [],
      groups: [{ id: 'group-one' }, { id: 'group-two' }],
      messages: [
        {
          groupId: 'group-one',
          attachments: [{ id: 'shared' }, { id: 'only-one' }],
        },
        { groupId: 'group-two', attachments: [{ id: 'shared' }] },
      ],
      localOnly: true,
    },
  })
  await harness.ready()

  const snapshot = await harness.ipcHandlers.get('local-workspace:delete-group')(
    harness.event(), 'group-one',
  )

  assert.deepEqual(snapshot.groups, [{ id: 'group-two' }])
  assert.deepEqual(snapshot.messages, [
    { groupId: 'group-two', attachments: [{ id: 'shared' }] },
  ])
  assert.deepEqual(harness.attachmentInstances[0].discarded, [['only-one']])
})

test('deleting a message normalizes identifiers and discards only newly unreferenced attachments', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-delete-message-attachments-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory, {
    workspaceSnapshot: {
      agents: [],
      groups: [{ id: '42' }],
      messages: [
        {
          id: '7', groupId: '42', role: 'agent',
          attachments: [{ id: 'shared' }, { id: 'only-message' }],
        },
        {
          id: '8', groupId: '42', role: 'agent',
          attachments: [{ id: 'shared' }],
        },
      ],
      localOnly: true,
    },
  })
  await harness.ready()

  const snapshot = await harness.ipcHandlers.get('local-workspace:delete-message')(
    harness.event(), 42, 7,
  )

  assert.deepEqual(harness.workspaceInstances[0].deleteMessageCalls, [['42', '7']])
  assert.deepEqual(snapshot.messages, [{
    id: '8', groupId: '42', role: 'agent', attachments: [{ id: 'shared' }],
  }])
  assert.deepEqual(harness.attachmentInstances[0].discarded, [['only-message']])
})

test('native Agent credentials are injected only through local Agent execution options', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-native-routing-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory, {
    nativeShellEnvironment: () => ({
      env: { PATH: '/opt/native-agent/bin:/usr/bin', https_proxy: 'http://proxy.example:3128', NO_PROXY: 'localhost,127.0.0.1', ANTHROPIC_API_KEY: 'native-hermes-key', XDG_CONFIG_HOME: '/native/config', XDG_DATA_HOME: '/native/data' },
      source: 'native-shell',
    }),
    nativeEnvironment: (...args) => require('../../src/agents/local-agent-readiness.cjs')
      .nativeCredentialEnvironment(...args),
  })
  await harness.ready()

  await harness.workspaceInstances[0].input.runAgent(
    { kind: 'hermes', executable: '/tmp/hermes' },
    'hello', directory, { env: { CURRENT_RUN: '1' } },
  )

  const options = harness.runAgentCalls[0][3]
  assert.equal(options.env.ANTHROPIC_API_KEY, 'native-hermes-key')
  assert.equal(options.env.CURRENT_RUN, '1')
  assert.equal(options.env.PATH, '/opt/native-agent/bin:/usr/bin')
  assert.equal(options.env.https_proxy, 'http://proxy.example:3128')
  assert.equal(options.env.NO_PROXY, 'localhost,127.0.0.1')
  assert.equal(options.env.XDG_CONFIG_HOME, '/native/config')
  assert.equal(options.env.XDG_DATA_HOME, '/native/data')
})

test('OpenClaw discovery binds workspace-relative TLS bundles to verification identity', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-openclaw-ca-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const certificate = path.join(directory, 'ca.pem')
  fs.writeFileSync(certificate, 'first certificate')
  const { harness } = loadMain(directory, {
    detectAgents: async () => [{ kind: 'openclaw', name: 'OpenClaw', executable: '/tmp/openclaw', version: '2026.7.1-2' }],
    nativeShellEnvironment: () => ({ env: { SSL_CERT_FILE: 'ca.pem' }, source: 'native-shell' }),
  })
  await harness.ready()
  const detected = await harness.installerInstances[0].input.detectAgents()
  const agent = detected.find(item => item.kind === 'openclaw')
  const { projectVerificationIdentity } = require('../../src/workspace/agent-verification-identity.cjs')
  const before = projectVerificationIdentity('openclaw', directory, agent, 'environment')
  fs.writeFileSync(certificate, 'replacement certificate')
  assert.notEqual(projectVerificationIdentity('openclaw', directory, agent, 'environment'), before)
})

test('Pi execution receives its native cloud configuration from the shell', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-pi-native-cloud-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { harness } = loadMain(directory, {
    nativeShellEnvironment: () => ({
      env: { AWS_PROFILE: 'native', AZURE_OPENAI_API_KEY: 'synthetic-azure',
        GOOGLE_CLOUD_PROJECT: 'native-project', GITHUB_TOKEN: 'unrelated' },
      source: 'native-shell',
    }),
    nativeEnvironment: (...args) => require('../../src/agents/local-agent-readiness.cjs')
      .nativeCredentialEnvironment(...args),
  })
  await harness.ready()
  await harness.workspaceInstances[0].input.runAgent({ kind: 'pi' }, 'hello', directory, {})
  const env = harness.runAgentCalls[0][3].env
  assert.equal(env.AWS_PROFILE, 'native')
  assert.equal(env.AZURE_OPENAI_API_KEY, 'synthetic-azure')
  assert.equal(env.GOOGLE_CLOUD_PROJECT, 'native-project')
  assert.equal(env.GITHUB_TOKEN, undefined)
})

test('OpenClaw native auth is routed through the app-owned isolated runtime', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-openclaw-native-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const credentialChecks = []
  const { harness } = loadMain(directory, {
    moduleMocks: {
      './agents/local-agent-readiness.cjs': {
        codexDeclaredCredentialKeys: () => [],
        hermesDeclaredCredentialKeys: () => [],
        zcodeDeclaredCredentialKeys: () => [],
        piDeclaredCredentialKeys: () => [],
        nativeCredentialEnvironment: kind => kind === 'openclaw'
          ? {
            OPENCLAW_NATIVE_CONFIG: 'available',
            OPENAI_API_KEY: 'unrelated-openai-key',
            OPENROUTER_API_KEY: 'unrelated-openrouter-key',
          }
          : {},
        resolveNativeOpenClawRuntime: async () => ({
          model: 'native/model',
          provider: {
            id: 'native',
            baseUrl: 'https://native.example.com/v1',
            api: 'openai-completions',
            apiKey: 'native-openclaw-key',
            model: { id: 'model', name: 'Native Model', input: ['text'] },
          },
        }),
        resolveNativeShellEnvironment: async () => ({
          env: { PATH: '/opt/native-agent/bin:/usr/bin', https_proxy: 'http://proxy.example:3128' },
          source: 'native-shell',
        }),
        resolveNativeCredentialState: async (kind, input) => {
          credentialChecks.push({ kind, input })
          return { state: 'ready', source: 'native-credential' }
        },
      },
    },
  })
  await harness.ready()
  const workspace = harness.workspaceInstances[0]

  const readiness = await workspace.input.credentialState('openclaw', {
    executable: '/tmp/openclaw',
  })
  assert.deepEqual(readiness, { state: 'ready', source: 'native-credential' })
  assert.equal(credentialChecks.length, 1)
  assert.equal(credentialChecks[0].kind, 'openclaw')
  assert.equal(credentialChecks[0].input.executable, '/tmp/openclaw')
  assert.equal(credentialChecks[0].input.env.PATH, '/opt/native-agent/bin:/usr/bin')
  assert.equal(credentialChecks[0].input.credentialSource, 'native-shell')

  await workspace.input.runAgent(
    { kind: 'openclaw', executable: '/tmp/openclaw' },
    'hello', directory, {
      sessionRef: 'agent:main:desktop-native-openclaw',
      env: {
        GITHUB_TOKEN: 'caller-secret',
        OPENAI_API_KEY: 'caller-openai-secret',
        OPENROUTER_API_KEY: 'caller-openrouter-secret',
      },
    },
  )
  const options = harness.runAgentCalls[0][3]
  assert.equal(options.env.https_proxy, 'http://proxy.example:3128')
  assert.equal(Object.hasOwn(options.env, 'OPENCLAW_NATIVE_CONFIG'), false)
  assert.equal(Object.hasOwn(options.env, 'OPENAI_API_KEY'), false)
  assert.equal(Object.hasOwn(options.env, 'OPENROUTER_API_KEY'), false)
  assert.equal(Object.hasOwn(options.env, 'GITHUB_TOKEN'), false)
  assert.equal(Object.hasOwn(options.env, 'MANAGED_OPENCLAW'), false)
  const isolated = JSON.parse(options.env.NATIVE_OPENCLAW)
  assert.equal(isolated.workdir, directory)
  assert.equal(isolated.sessionRef, 'agent:main:desktop-native-openclaw')
  assert.equal(isolated.allowWrite, false)
  assert.deepEqual(isolated.runtime, {
    model: 'native/model',
    provider: {
      id: 'native',
      baseUrl: 'https://native.example.com/v1',
      api: 'openai-completions',
      apiKey: 'native-openclaw-key',
      model: { id: 'model', name: 'Native Model', input: ['text'] },
    },
  })
})

test('manual Agent refresh updates native shell settings before detection and credential checks', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-refresh-environment-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let configured = 'before'
  let cached = 'before'
  const refreshes = []
  const { harness } = loadMain(directory, {
    nativeShellEnvironment: input => {
      if (input.refresh) { cached = configured; refreshes.push(cached) }
      return { env: { ANTHROPIC_API_KEY: `synthetic-${cached}` }, source: 'native-shell' }
    },
    onRefresh: async () => { assert.equal(cached, configured) },
  })
  await harness.ready()
  configured = 'after'
  await harness.ipcHandlers.get('local-workspace:refresh-agents')(harness.event())
  assert.deepEqual(refreshes, ['after'])
  assert.equal(harness.workspaceInstances[0].refreshCount, 1)
})

test('manual Agent refreshes remain serialized', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-refresh-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const firstGate = deferred()
  const secondGate = deferred()
  const { harness } = loadMain(directory, {
    onRefresh: async (_workspace, count) => {
      if (count === 1) await firstGate.promise
      if (count === 2) await secondGate.promise
    },
  })
  await harness.ready()
  const handler = harness.ipcHandlers.get('local-workspace:refresh-agents')

  const first = handler(harness.event())
  const second = handler(harness.event())
  await waitFor(() => harness.workspaceInstances[0].refreshCount === 1)
  assert.equal(harness.workspaceInstances[0].maxConcurrentRefreshes, 1)

  firstGate.resolve()
  await waitFor(() => harness.workspaceInstances[0].refreshCount === 2)
  assert.equal(harness.workspaceInstances[0].maxConcurrentRefreshes, 1)
  secondGate.resolve()
  await Promise.all([first, second])
  assert.equal(harness.workspaceInstances[0].clearRuntimeCredentialFailuresCount, 0)
  assert.equal(harness.installerInstances[0].invalidateCount, 2)
  assert.equal(harness.skillCatalogInstances[0].invalidateCalls, 2)
})

test('before-quit waits for local workspace and installer cleanup', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-quit-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspaceStopGate = deferred()
  const installerIdleGate = deferred()
  const cloudShutdownGate = deferred()
  const { harness } = loadMain(directory, {
    workspaceStopGate,
    installerIdleGate,
    cloudShutdownGate,
    windowFocused: false,
    installerState: { phase: 'installing', canCancel: true, taskId: 'task-1' },
  })
  await harness.ready()
  let prevented = 0

  harness.appListeners.get('before-quit')({ preventDefault: () => { prevented += 1 } })
  assert.equal(prevented, 1)
  assert.equal(harness.installerInstances[0].pendingCancelCount, 1)
  assert.deepEqual(harness.installerInstances[0].cancelled, ['task-1'])
  assert.equal(harness.channelIngressRuntimeInstances[0].shutdownCount, 1)
  assert.equal(harness.cloudAgentRuntimeInstances[0].shutdownCount, 1)
  assert.equal(harness.quitCount, 0)

  harness.workspaceInstances[0].emit('run-finished', {
    groupId: 'group-1', status: 'stopped', targetKinds: [], completedKinds: [],
  })
  assert.equal(harness.notificationInstances.length, 0)

  for (const channel of LOCAL_IPC_CHANNELS) {
    await assert.rejects(
      Promise.resolve().then(() => harness.ipcHandlers.get(channel)(harness.event())),
      { message: 'DESKTOP_CLIENT_SHUTTING_DOWN' },
      `${channel} should reject after shutdown starts`,
    )
  }

  workspaceStopGate.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(harness.quitCount, 0)
  installerIdleGate.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(harness.quitCount, 0)
  cloudShutdownGate.resolve()
  await waitFor(() => harness.exitCalls.length === 1)
  assert.deepEqual(harness.exitCalls, [0])
  assert.equal(harness.workspaceInstances[0].stopCount, 1)
})

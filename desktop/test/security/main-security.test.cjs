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
})

test('Agent Connector IPC persists isolated accounts without returning CredentialRefs or secrets', async (t) => {
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
  }
  const { harness } = loadMain(directory, options)
  await harness.ready()
  const configure = harness.ipcHandlers.get('local-agent-connector:configure')
  const list = harness.ipcHandlers.get('local-agent-connector:list')
  const remove = harness.ipcHandlers.get('local-agent-connector:delete')

  const first = await configure(harness.event(), {
    manifestId: SAMPLE_CREDENTIAL_AGENT_CONNECTOR_MANIFEST.manifestId,
    label: 'Codex account A',
    credentials: { 'openai-api-key': 'connector-main-secret-a' },
  })
  const second = await configure(harness.event(), {
    manifestId: SAMPLE_CREDENTIAL_AGENT_CONNECTOR_MANIFEST.manifestId,
    label: 'Codex account B',
    credentials: { 'openai-api-key': 'connector-main-secret-b' },
  })
  assert.notEqual(first.instanceId, second.instanceId)
  assert.equal(first.credentialConfigured, true)
  const listed = await list(harness.event())
  assert.deepEqual(listed.map(item => item.label), ['Codex account A', 'Codex account B'])
  assert.doesNotMatch(JSON.stringify(listed), /credential-ref|connector-main-secret/i)

  const workspace = harness.workspaceInstances[0]
  const agents = await workspace.input.detectAgents()
  const result = await workspace.input.connectorRuntime.run(
    agents.find(agent => agent.kind === first.instanceId),
    'Review with account A',
    directory,
    { runId: 'run-account-a', agentRunId: 'agent-run-account-a', sandbox: 'read-only' },
  )
  assert.doesNotMatch(JSON.stringify(result), /credential-ref|connector-main-secret/i)
  assert.equal(harness.runAgentCalls.at(-1)[3].env.OPENAI_API_KEY, 'connector-main-secret-a')
  assert.equal(Object.hasOwn(harness.runAgentCalls.at(-1)[3].env, 'OPENAI_BASE_URL'), false)
  assert.equal(Object.hasOwn(harness.runAgentCalls.at(-1)[3].env, 'OPENAI_MODEL'), false)
  assert.equal(Object.hasOwn(harness.runAgentCalls.at(-1)[3], 'connectorCredentialIsolation'), false)

  await workspace.input.connectorRuntime.run(
    agents.find(agent => agent.kind === second.instanceId),
    'Review with account B',
    directory,
    { runId: 'run-account-b', agentRunId: 'agent-run-account-b', sandbox: 'read-only' },
  )
  assert.equal(harness.runAgentCalls.at(-1)[3].env.OPENAI_API_KEY, 'connector-main-secret-b')

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
    { message: 'AGENT_CONNECTOR_CREDENTIAL_INVALID' },
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
  assert.deepEqual(harness.installerInstances[0].input.listSkills('codex'), skillsResult)
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
  assert.equal(cloudAgent.sourceKind, 'claude')
  assert.equal(cloudAgent.version, '2.1.123')
  assert.equal(cloudAgent.credentialState, 'missing')
  assert.equal(cloudAgent.available, false)
  assert.equal(cloudAgent.custom, false)
  assert.equal('executable' in cloudAgent, false)

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
      env: { PATH: '/opt/native-agent/bin:/usr/bin', https_proxy: 'http://proxy.example:3128', NO_PROXY: 'localhost,127.0.0.1', ANTHROPIC_API_KEY: 'native-hermes-key' },
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
})

test('OpenClaw native auth is routed through the app-owned isolated runtime', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-openclaw-native-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const credentialChecks = []
  const { harness } = loadMain(directory, {
    moduleMocks: {
      './agents/local-agent-readiness.cjs': {
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

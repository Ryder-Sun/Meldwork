const electron = require('electron')
const { app, BrowserWindow, dialog, ipcMain, Menu, Notification, protocol, shell } = electron
const fs = require('node:fs')
const path = require('node:path')
const { redactSecrets } = require('./security/secret-redaction.cjs')
const { AttachmentStore } = require('./attachments/attachment-store.cjs')
const { ContentBlobStore } = require('./attachments/content-blob-store.cjs')
const { ContextPackStore } = require('./collaboration/context-pack-store.cjs')
const { OutcomeStore } = require('./collaboration/outcome-store.cjs')
const FROZEN_AGENT_FIT_MATRIX = require('./evaluations/data/agent-fit-matrix.v1.json')
const {
  MEDIA_SCHEME,
  attachmentIdsFromSnapshot,
  createAttachmentService,
  persistedAttachmentReferences,
} = require('./attachments/attachment-service.cjs')
const {
  captureAgentOutputState,
  captureAgentOutcomeDescriptors,
  captureArtifactOutputState,
  importAgentOutputs,
} = require('./agents/agent-output-importer.cjs')
const {
  detectAgents,
  imageAttachmentLimit,
  runAgent,
  shutdownAcpSessionRuntime,
} = require('./agents/cli/cli-adapters.cjs')
const { AgentInstaller } = require('./agents/installer/agent-installer.cjs')
const { networkEnvironment } = require('./agents/cli/cli-network-environment.cjs')
const { AgentConnectorInstanceStore } = require('./agents/connectors/agent-connector-instance-store.cjs')
const { LocalAgentConnectors } = require('./agents/connectors/agent-connector-local.cjs')
const { AgentConnectorPackageStore } = require('./agents/connectors/agent-connector-package-store.cjs')
const { CloudAgentOperationStore } = require('./agents/cloud/cloud-agent-operation-store.cjs')
const { CloudAgentBridgeStore } = require('./agents/cloud/cloud-agent-bridge.cjs')
const {
  CloudAgentRuntime,
  createCloudAgentStartRetry = ({ runtime }) => Object.freeze({
    start: () => Promise.resolve().then(() => runtime.start()).then(() => true, () => false),
    cancel() {},
  }),
} = require('./agents/cloud/cloud-agent-runtime.cjs')
const { ChannelInboxStore } = require('./channels/channel-inbox-store.cjs')
const { ChannelIngressRuntime } = require('./channels/channel-ingress-runtime.cjs')
const { CustomAgentStore } = require('./agents/custom-agent-store.cjs')
const {
  nativeCredentialEnvironment,
  resolveNativeOpenClawRuntime,
  resolveNativeCredentialState,
  resolveNativeShellEnvironment,
} = require('./agents/local-agent-readiness.cjs')
const { LocalWorkspace } = require('./workspace/local-workspace.cjs')
const { registerDesktopIpc } = require('./shell/main-ipc.cjs')
const { workBuddyEnvironment, workBuddySettings } = require('./agents/cli/workbuddy-runtime.cjs')
const {
  isAllowedExternalUrl,
  isAllowedLocalNavigation: isAllowedLocalNavigationForPaths,
  isTrustedLocalRenderer,
  isTrustedLocalWebContents: isTrustedLocalWebContentsForPath,
} = require('./shell/main-renderer-security.cjs')
const { createRunNotificationCoordinator } = require('./shell/main-run-notifications.cjs')
const { normalizeRunEvent } = require('./runs/run-harness.cjs')
const { RunLedger } = require('./runs/run-ledger.cjs')
const { LocalSkillCatalog } = require('./skills/local-skill-catalog.cjs')
const { LocalSkillSnapshotSelections } = require('./skills/local-skill-snapshot-selections.cjs')
const { LocalSkillSnapshotStore } = require('./skills/local-skill-snapshot.cjs')
const { LocalSkillTrustStore } = require('./skills/local-skill-trust-store.cjs')
const { KnowledgeBaseStore } = require('./knowledge/knowledge-base-store.cjs')
const {
  knowledgeBaseSelectionHint,
  knowledgeBaseGuideUrl,
  resolveKnowledgeBaseSources,
} = require('./knowledge/local-knowledge-base.cjs')
const { LocalKnowledgeConnectors } = require('./knowledge/local-knowledge-connectors.cjs')
const { nativeOpenClawOptions } = require('./agents/cli/openclaw-runtime.cjs')
const { migrateLegacyProductData } = require('./product-data-migration.cjs')
const LOCAL_AGENT_KINDS = new Set([
  'codex', 'hermes', 'openclaw', 'workbuddy', 'pi', 'kimi', 'mimo', 'claude', 'gemini', 'opencode', 'qwen',
  'opencodereview',
])
const QUIT_CLEANUP_TIMEOUT_MS = 2500
let mainWindow = null

// Faults outside a request handler are written to a small private log in
// userData (secrets redacted, size-capped) instead of disappearing or
// taking the app down, so instability reports have evidence.
function recordMainProcessFault(kind, detail) {
  const text = String(detail?.stack || detail?.message || detail || '').slice(0, 4000)
  console.error(`[meldwork] ${kind}`, text)
  try {
    const file = path.join(app.getPath('userData'), 'meldwork-diagnostics.log')
    try {
      if (fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, `${file}.1`)
    } catch { /* first entry */ }
    fs.appendFileSync(file, `${new Date().toISOString()} ${kind} ${redactSecrets(text)}\n`, { mode: 0o600 })
  } catch { /* diagnostics must never throw */ }
}
process.on('unhandledRejection', reason => recordMainProcessFault('unhandledRejection', reason))
process.on('uncaughtException', error => recordMainProcessFault('uncaughtException', error))
let workspace = null
let workspaceChangedListener = null
let workspaceRunFinishedListener = null
let workspaceRunEventListener = null
let installer = null
let localAgentRefreshQueue = Promise.resolve()
let customAgentStore = null
let agentConnectors = null
let cloudAgentRuntime = null
let cloudAgentBridges = null
let cloudAgentStartRetry = null
let channelIngressRuntime = null
let knowledgeBaseStore = null
let knowledgeConnectors = null
let knowledgeBaseStatusPromise = null
const knowledgeBaseSourcesCache = new Map()
let attachmentStore = null
let skillCatalog = null
let skillTrustStore = null
let shutdownStarted = false
let quitCleanup = null
let cachedAppIcon

function runQuitCleanup(cleanups, timeoutMs = QUIT_CLEANUP_TIMEOUT_MS) {
  const tasks = cleanups.map((cleanup) => {
    try {
      return Promise.resolve(cleanup())
    } catch (error) {
      return Promise.reject(error)
    }
  })
  const pending = Promise.allSettled(tasks)
  return new Promise((resolve) => {
    let settled = false
    let timer = null
    const finish = (timedOut) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ timedOut })
    }
    pending.then(() => finish(false))
    timer = setTimeout(() => finish(true), timeoutMs)
  })
}

const attachments = createAttachmentService({
  getStore: () => attachmentStore,
  getSnapshot: () => workspace?.snapshot(),
  nativeImage: electron.nativeImage,
  openPath: filename => shell.openPath(filename),
})

protocol?.registerSchemesAsPrivileged?.([{
  scheme: MEDIA_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
  },
}])

const lazySafeStorage = Object.freeze({
  isEncryptionAvailable: () => electron.safeStorage.isEncryptionAvailable(),
  encryptString: value => electron.safeStorage.encryptString(value),
  decryptString: value => electron.safeStorage.decryptString(value),
})

function frontendPath() {
  return app.isPackaged
    ? path.join(__dirname, '../frontend/index.html')
    : path.resolve(__dirname, '../../frontend/dist/index.html')
}

function offlinePath() {
  return path.join(__dirname, 'offline.html')
}

function appIconPath() {
  return app.isPackaged
    ? path.join(__dirname, '../frontend/logos/meldwork-app.png')
    : path.resolve(__dirname, '../../frontend/public/logos/meldwork-app.png')
}

function appIconImage() {
  if (cachedAppIcon !== undefined) return cachedAppIcon
  try {
    const image = electron.nativeImage.createFromPath(appIconPath())
    cachedAppIcon = image?.isEmpty?.() === false ? image : null
  } catch {
    cachedAppIcon = null
  }
  return cachedAppIcon
}

function isLocalAgentKind(kind) {
  return LOCAL_AGENT_KINDS.has(kind)
    || customAgentStore?.has(kind) === true
    || agentConnectors?.has(kind) === true
}

function loadFrontend() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.loadFile(frontendPath(), { hash: '/chat' }).catch(() => showOfflinePage('FRONTEND_LOAD_FAILED'))
}

function showOfflinePage(errorCode) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.loadFile(offlinePath(), {
    query: { code: String(errorCode) },
  }).catch(() => {})
}

function isTrustedLocalWebContents(webContents, expectedFrontendPath = frontendPath()) {
  return isTrustedLocalWebContentsForPath(webContents, expectedFrontendPath)
}

function requireDesktopRenderer(event) {
  if (!isTrustedLocalRenderer(event, mainWindow?.webContents, frontendPath())) {
    throw new Error('DESKTOP_CLIENT_ACCESS_DENIED')
  }
}

function registerTrustedHandle(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    requireDesktopRenderer(event)
    if (shutdownStarted) throw new Error('DESKTOP_CLIENT_SHUTTING_DOWN')
    return handler(...args)
  })
}

function isAllowedLocalNavigation(value, allowedPaths = [frontendPath(), offlinePath()]) {
  return isAllowedLocalNavigationForPaths(value, allowedPaths)
}

function openExternalUrl(value) {
  if (!isAllowedExternalUrl(value)) return false
  Promise.resolve(shell.openExternal(value)).catch(() => {})
  return true
}

async function nativeShellEnvironment(options = {}) {
  const home = app.getPath('home')
  const resolved = await resolveNativeShellEnvironment({ home, refresh: options.refresh === true })
  return {
    ...resolved,
    env: { ...process.env, ...resolved.env },
    home,
  }
}

async function detectLocalAgents() {
  const shellEnvironment = await nativeShellEnvironment()
  return detectAgents({ env: shellEnvironment.env, home: shellEnvironment.home })
}

function workspaceStoragePath(userData = app.getPath('userData')) {
  return path.join(userData, 'meldwork-workspace.json')
}

function notifyWorkspaceChanged(snapshot) {
  if (mainWindow && !mainWindow.isDestroyed()
      && isTrustedLocalWebContents(mainWindow.webContents)) {
    mainWindow.webContents.send('local-workspace:changed', snapshot)
  }
}

function rememberKnowledgeBaseSources(sources) {
  for (const source of Array.isArray(sources) ? sources : []) {
    const kind = String(source?.kind || '')
    if (kind) knowledgeBaseSourcesCache.set(kind, source)
  }
  return sources
}

async function loadKnowledgeBaseSources(kind = '') {
  const selectedKind = String(kind || '').trim()
  if (knowledgeBaseStatusPromise) {
    const shared = await knowledgeBaseStatusPromise
    if (!selectedKind || shared.some(source => source?.kind === selectedKind)) return shared
  }
  const request = resolveKnowledgeBaseSources({
    store: knowledgeBaseStore,
    home: app.getPath('home'),
    kind: selectedKind,
  }).then(rememberKnowledgeBaseSources)
  knowledgeBaseStatusPromise = request
  try {
    return await request
  } finally {
    if (knowledgeBaseStatusPromise === request) knowledgeBaseStatusPromise = null
  }
}

async function validateKnowledgeBaseSelections(targetKinds, selections) {
  const targets = [...new Set((Array.isArray(targetKinds) ? targetKinds : [])
    .map(kind => String(kind || ''))
    .filter(isLocalAgentKind))]
  const requested = Array.isArray(selections) ? selections : []
  if (!requested.length) return []
  if (!targets.length) throw new Error('LOCAL_KNOWLEDGE_BASE_SELECTION_INVALID')
  const genericKinds = [...new Set(requested
    .filter(source => !source?.selectionId)
    .map(source => String(source?.kind || '')))]
  if (genericKinds.some(kind => !knowledgeBaseSourcesCache.has(kind))) {
    await loadKnowledgeBaseSources()
  }
  return Promise.all(requested.map(async (selection) => {
    const selectionTargets = [...new Set((Array.isArray(selection?.targetKinds) ? selection.targetKinds : [])
      .map(kind => String(kind || ''))
      .filter(kind => targets.includes(kind)))]
    if (!selectionTargets.length
        || selectionTargets.length !== new Set(selection?.targetKinds || []).size) {
      throw new Error('LOCAL_KNOWLEDGE_BASE_SELECTION_INVALID')
    }
    const selectionId = String(selection?.selectionId || '')
    if (selectionId) {
      const keys = Reflect.ownKeys(selection || {})
      if (!knowledgeConnectors
          || keys.some(key => !['kind', 'selectionId', 'targetKinds'].includes(key))) {
        throw new Error('LOCAL_KNOWLEDGE_BASE_SELECTION_INVALID')
      }
      try {
        const preparedSource = await knowledgeConnectors.prepareSelection(selectionId)
        if (String(selection?.kind || '') !== preparedSource.kind) {
          throw new Error('LOCAL_KNOWLEDGE_BASE_SELECTION_INVALID')
        }
        return knowledgeConnectors.runtimeHint(selectionTargets, preparedSource)
      } catch {
        throw new Error('LOCAL_KNOWLEDGE_BASE_SELECTION_INVALID')
      }
    }
    const hint = knowledgeBaseSelectionHint(
      knowledgeBaseSourcesCache.get(String(selection?.kind || '')),
      selectionTargets,
    )
    if (!hint) throw new Error('LOCAL_KNOWLEDGE_BASE_SELECTION_INVALID')
    return hint
  }))
}

async function runCoreAgent(agent, prompt, workdir, options = {}) {
  const connectorCredentialIsolation = options.connectorCredentialIsolation === true
  const runOptions = { ...options }
  delete runOptions.connectorCredentialIsolation
  const shellEnvironment = connectorCredentialIsolation ? null : await nativeShellEnvironment()
  // OpenClaw runs through its isolated native runtime scope; every other Agent
  // CLI uses its own native credentials.
  const nativeRuntime = !connectorCredentialIsolation && agent.kind === 'openclaw'
    ? await resolveNativeOpenClawRuntime({
        executable: agent.executable,
        env: shellEnvironment.env,
        home: shellEnvironment.home,
      })
    : null
  const injected = connectorCredentialIsolation || agent.kind !== 'openclaw' || !nativeRuntime
    ? {}
    : nativeOpenClawOptions({
        storageRoot: app.getPath('userData'),
        workdir,
        sessionRef: runOptions.sessionRef,
        allowWrite: runOptions.sandbox === 'workspace-write',
        runtime: nativeRuntime,
        openclawVersion: agent.version,
      })
  const nativeEnv = connectorCredentialIsolation || agent.kind === 'openclaw'
    ? {}
    : {
        ...nativeCredentialEnvironment(agent.kind, shellEnvironment.env),
        ...(agent.kind === 'workbuddy' ? workBuddyEnvironment({
          env: shellEnvironment.env, home: shellEnvironment.home,
          modelId: workspace?.state.agentPreferences.workbuddy?.modelId,
        }) : {}),
        ...(shellEnvironment.env.PATH ? { PATH: shellEnvironment.env.PATH } : {}),
      }
  const callerEnv = connectorCredentialIsolation || agent.kind !== 'openclaw'
    ? runOptions.env
    : {}
  return runAgent(agent, prompt, workdir, {
    ...runOptions,
    ...injected,
    env: {
      ...networkEnvironment(shellEnvironment?.env),
      ...nativeEnv, ...callerEnv, ...injected.env,
    },
  })
}

function localAttachmentSupport(kind) {
  if (customAgentStore?.has(kind)) {
    return { image: 32, audio: 32, video: 32, file: 32 }
  }
  const connectorSupport = agentConnectors?.attachmentSupport(kind)
  if (connectorSupport) return connectorSupport
  return {
    image: imageAttachmentLimit(kind),
    file: kind === 'opencodereview' ? 0 : 32,
  }
}

async function requestLocalSkillTrust({ binding, coordinates, manifest }) {
  const locale = String(app.getLocale?.() || '').toLowerCase()
  const compatibility = manifest.agents.map(agent => (
    `${agent.kind} ${agent.minVersion} - ${agent.maxVersion}`
  )).join(', ')
  const credentials = manifest.credentials.map(item => (
    `${item.credentialId} (${item.type})`
  )).join(', ') || (locale.startsWith('zh') ? '无' : 'None')
  const destinations = manifest.networkDestinations.join(', ')
    || (locale.startsWith('zh') ? '无' : 'None')
  const tools = manifest.tools.join(', ') || (locale.startsWith('zh') ? '无' : 'None')
  const detail = locale.startsWith('zh')
    ? [
        `Skill：${coordinates.name} (${manifest.identity.id} ${manifest.identity.version})`,
        `来源：${manifest.origin.type} / ${manifest.origin.publisher}`,
        `适配 Agent：${compatibility}`,
        `输入类型：${manifest.inputTypes.join(', ')}`,
        `工具：${tools}`,
        `权限：${manifest.permissionMode}`,
        `凭据：${credentials}`,
        `外联目标：${destinations}`,
        `副作用等级：${manifest.sideEffectClass}`,
        `清单哈希：${binding.contractHash}`,
        `内容哈希：${binding.contentHash}`,
      ].join('\n')
    : [
        `Skill: ${coordinates.name} (${manifest.identity.id} ${manifest.identity.version})`,
        `Origin: ${manifest.origin.type} / ${manifest.origin.publisher}`,
        `Compatible Agents: ${compatibility}`,
        `Input types: ${manifest.inputTypes.join(', ')}`,
        `Tools: ${tools}`,
        `Permission: ${manifest.permissionMode}`,
        `Credentials: ${credentials}`,
        `Network destinations: ${destinations}`,
        `Side-effect class: ${manifest.sideEffectClass}`,
        `Manifest hash: ${binding.contractHash}`,
        `Content hash: ${binding.contentHash}`,
      ].join('\n')
  const decision = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: locale.startsWith('zh') ? '批准本地 Skill' : 'Approve Local Skill',
    message: locale.startsWith('zh')
      ? '这是未签名的本地 Skill。仅在确认来源和权限范围后批准。'
      : 'This is an unsigned local Skill. Approve only after verifying its origin and permissions.',
    detail,
    buttons: locale.startsWith('zh') ? ['批准', '取消'] : ['Approve', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  })
  return decision.response === 0
}

function createWorkspace() {
  cloudAgentStartRetry?.cancel()
  const privateRoot = path.join(app.getPath('userData'), 'meldwork-private')
  const contentBlobStore = new ContentBlobStore({
    rootPath: path.join(privateRoot, 'content-blobs'),
  })
  const skillSnapshotStore = new LocalSkillSnapshotStore({
    contentBlobStore,
    rootPath: path.join(privateRoot, 'skill-snapshots'),
  })
  skillTrustStore = new LocalSkillTrustStore({
    storagePath: path.join(privateRoot, 'skill-trust-audit.jsonl'),
  })
  const skillSnapshotSelections = new LocalSkillSnapshotSelections({
    catalog: skillCatalog,
    snapshotStore: skillSnapshotStore,
    contentBlobStore,
    trustStore: skillTrustStore,
    requestTrust: requestLocalSkillTrust,
  })
  knowledgeConnectors = new LocalKnowledgeConnectors({
    contentBlobStore,
    getObsidianVaultPath: () => knowledgeBaseStore?.state().obsidianVaultPath || '',
    storagePath: path.join(privateRoot, 'knowledge-connector-records.json'),
  })
  agentConnectors = new LocalAgentConnectors({
    manifestDirectory: path.join(app.getPath('userData'), 'agent-connectors', 'manifests'),
    packageStore: new AgentConnectorPackageStore({
      rootPath: path.join(privateRoot, 'agent-connector-packages'),
    }),
    instanceStore: new AgentConnectorInstanceStore({
      instanceStoragePath: path.join(app.getPath('userData'), 'agent-connectors', 'instances.json'),
      credentialStoragePath: path.join(privateRoot, 'agent-connector-credentials.json'),
      safeStorage: lazySafeStorage,
    }),
    runAgent: runCoreAgent,
    cloudBridges: cloudAgentBridges,
  })
  const outcomeStore = new OutcomeStore({
    rootPath: path.join(privateRoot, 'outcomes'),
    contentBlobStore,
  })
  const runLedger = new RunLedger({
    storagePath: path.join(app.getPath('userData'), 'meldwork-run-ledger.json'),
  })
  const runtime = new CloudAgentRuntime({
    runLedger,
    outcomeStore,
    contentBlobStore,
    operationStore: new CloudAgentOperationStore({
      storagePath: path.join(privateRoot, 'cloud-agent-operations.json'),
    }),
    connectors: [],
  })
  cloudAgentRuntime = runtime
  channelIngressRuntime = new ChannelIngressRuntime({
    store: new ChannelInboxStore({
      storagePath: path.join(privateRoot, 'channel-inbox.json'),
    }),
    connectors: [],
  })
  const localWorkspace = new LocalWorkspace({
    storagePath: workspaceStoragePath(),
    contentBlobStore,
    contextPackStore: new ContextPackStore({
      rootPath: path.join(privateRoot, 'context-packs'),
    }),
    outcomeStore,
    agentFitMatrix: FROZEN_AGENT_FIT_MATRIX,
    runLedger: cloudAgentRuntime.workspaceLedger(),
    detectAgents: async () => {
      await cloudAgentBridges?.refresh()
      const [installedAgents, customAgents] = await Promise.all([
        installer.detectedAgents(),
        customAgentStore.detectAgents(),
      ])
      return [
        ...installedAgents,
        ...customAgents,
        ...agentConnectors.refresh(installedAgents),
      ]
    },
    resolveAttachments: input => attachments.availableStore().resolve(input),
    captureAgentOutputs: workdir => captureAgentOutputState(workdir),
    captureArtifactOutputs: (workdir, options) => captureArtifactOutputState(workdir, options),
    captureAgentOutcomeDescriptors,
    importAgentOutputs: input => importAgentOutputs(input, attachments.availableStore()),
    validateSkillSelections: (kind, selections) => skillSnapshotSelections.prepare(kind, selections),
    validateKnowledgeBaseSelections,
    imageAttachmentLimit,
    attachmentSupport: localAttachmentSupport,
    credentialState: async (kind, agent) => {
      if (customAgentStore.has(kind)) return { state: 'ready', source: 'custom-agent' }
      if (agentConnectors.has(kind)) return { state: 'ready', source: 'agent-connector' }
      const shellEnvironment = await nativeShellEnvironment()
      return resolveNativeCredentialState(kind, {
        executable: agent?.executable,
        env: shellEnvironment.env,
        home: shellEnvironment.home,
        credentialSource: shellEnvironment.source,
        ...(kind === 'workbuddy' ? { modelId: workspace?.state.agentPreferences.workbuddy?.modelId } : {}),
      })
    },
    agentLabel: kind => customAgentStore.label(kind) || agentConnectors.label(kind),
    connectorRuntime: agentConnectors,
    naturalAgentResponses: true,
    runAgent: async (agent, prompt, workdir, options = {}) => {
      if (customAgentStore.has(agent.kind)) {
        return customAgentStore.run(agent.kind, prompt, workdir, {
          sandbox: options.sandbox,
          signal: options.signal,
          onActivity: options.onActivity,
          onProgress: options.onProgress,
          onEvent: options.onEvent,
          onOutboundPayload: options.onOutboundPayload,
          attachments: options.attachments,
        })
      }
      return runCoreAgent(agent, prompt, workdir, options)
    },
  })
  cloudAgentStartRetry = createCloudAgentStartRetry({
    runtime,
    isActive: candidate => !shutdownStarted && cloudAgentRuntime === candidate,
  })
  cloudAgentStartRetry.start()
  channelIngressRuntime.start().catch(() => {})
  return localWorkspace
}

async function localAgentCatalog() {
  await cloudAgentBridges?.refresh()
  const [catalog, customAgents, installedAgents] = await Promise.all([
    installer.catalog(),
    customAgentStore.catalog(),
    installer.detectedAgents(),
  ])
  agentConnectors?.refresh(installedAgents)
  const connectorAgents = agentConnectors?.catalog() || []
  const mergedAgents = new Map()
  for (const agent of [...catalog.agents, ...customAgents, ...connectorAgents]) {
    mergedAgents.set(agent.kind, agent)
  }
  for (const agent of cloudAgentBridges?.catalogEntries?.() || []) {
    mergedAgents.set(agent.kind, { ...(mergedAgents.get(agent.kind) || {}), ...agent })
  }
  const states = new Map((workspace?.snapshot().agents || []).map(agent => [agent.kind, agent]))
  return {
    ...catalog,
    agents: [...mergedAgents.values()].map((agent) => {
      const state = states.get(agent.kind)
      const support = localAttachmentSupport(agent.kind)
      return {
        ...agent,
        versionIdentified: Boolean(agent.installed && (state?.versionIdentified
          ?? agent.versionIdentified ?? agent.resolvedVersion)),
        compatible: Boolean(agent.installed && (state?.compatible
          ?? agent.compatible ?? agent.compatibilityState === 'compatible')),
        configured: Boolean(agent.installed && state?.configured),
        authenticated: Boolean(agent.installed && state?.authenticated),
        invocable: Boolean(agent.installed && state?.invocable),
        recentlyVerified: Boolean(agent.installed && state?.recentlyVerified),
        capabilities: state?.capabilities || agent.capabilities || null,
        available: Boolean(agent.installed && state?.invocable),
        credentialState: agent.installed
          ? (state?.credentialState || agent.credentialState || 'unknown')
          : 'missing',
        availabilitySource: agent.installed ? (state?.availabilitySource || 'unverified') : 'none',
        showInSidebar: Boolean(agent.installed && state?.showInSidebar),
        attachmentTypes: Object.entries(support)
          .filter(([, limit]) => Number(limit) > 0)
          .map(([type]) => type),
      }
    }),
  }
}

async function refreshLocalAgentState() {
  const target = workspace
  if (!target) return null
  const task = localAgentRefreshQueue.then(async () => {
    if (workspace !== target) return workspace?.snapshot() || null
    await nativeShellEnvironment({ refresh: true })
    const snapshot = await target.refreshAgents()
    if (workspace !== target) return workspace?.snapshot() || null
    return snapshot
  })
  localAgentRefreshQueue = task.catch(() => {})
  return task
}

function initializeWorkspace() {
  if (workspace) return workspace
  const next = createWorkspace()
  workspace = next
  workspaceChangedListener = notifyWorkspaceChanged
  workspaceRunFinishedListener = notifyRunFinished
  workspaceRunEventListener = notifyWorkspaceRunEvent
  next.on('changed', workspaceChangedListener)
  next.on('run-finished', workspaceRunFinishedListener)
  next.on('run-event', workspaceRunEventListener)
  return next
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    title: 'Meldwork',
    icon: appIconImage() || appIconPath(),
    backgroundColor: process.platform === 'darwin' ? '#e7edef' : '#f3f6f8',
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 18, y: 16 },
    } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  })
  mainWindow.webContents.session.setPermissionCheckHandler?.(() => false)
  mainWindow.webContents.session.setPermissionRequestHandler?.((
    _webContents, _permission, callback,
  ) => callback(false))
  mainWindow.webContents.session.setDevicePermissionHandler?.(() => false)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedLocalNavigation(url)) return
    event.preventDefault()
    openExternalUrl(url)
  })
  mainWindow.webContents.on('did-fail-load', (
    _event, errorCode, _errorDescription, validatedUrl, isMainFrame,
  ) => {
    if (!isMainFrame || errorCode === -3) return
    try {
      if (new URL(validatedUrl).pathname.endsWith('/offline.html')) return
    } catch { /* invalid URLs fall through to the offline page */ }
    showOfflinePage(errorCode)
  })
  mainWindow.webContents.on('did-finish-load', flushPendingOpenGroup)
  // A crashed renderer used to leave a blank window; reload it so the
  // workspace (whose state lives in the main process) comes back.
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    recordMainProcessFault('render-process-gone', details?.reason || 'unknown')
    if (details?.reason !== 'clean-exit' && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.reload()
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  loadFrontend()
  flushPendingOpenGroup()
  return mainWindow
}

const {
  activateMainWindow,
  flushPendingOpenGroup,
  notifyRunFinished,
  notifyWorkspaceRunEvent,
} = createRunNotificationCoordinator({
  Notification,
  app,
  appIconImage,
  appIconPath,
  createWindow,
  getMainWindow: () => mainWindow,
  isLocalAgentKind,
  isShutdownStarted: () => shutdownStarted,
  isTrustedLocalWebContents,
  normalizeRunEvent,
})

function registerIpc() {
  registerDesktopIpc({
    app,
    attachmentIdsFromSnapshot,
    attachments,
    customAgentStore,
    dialog,
    getAttachmentStore: () => attachmentStore,
    getAgentConnectors: () => agentConnectors,
    getCloudAgentRuntime: () => cloudAgentRuntime,
    getCloudAgentBridges: () => cloudAgentBridges,
    getMainWindow: () => mainWindow,
    getWorkspace: () => workspace,
    getWorkBuddySettings: async () => {
      const shell = await nativeShellEnvironment()
      return workBuddySettings({ ...shell, modelId: workspace?.state.agentPreferences.workbuddy?.modelId })
    },
    installer,
    isShutdownStarted: () => shutdownStarted,
    knowledgeBaseStore,
    getKnowledgeConnectors: () => knowledgeConnectors,
    knowledgeBaseGuideUrl,
    loadKnowledgeBaseSources,
    localAgentCatalog,
    openExternalUrl,
    getOutcomeStore: () => workspace?.outcomeStore,
    getSkillTrustStore: () => skillTrustStore,
    refreshLocalAgentState,
    registerTrustedHandle,
    skillCatalog,
  })
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', activateMainWindow)

  app.whenReady().then(async () => {
    try {
      migrateLegacyProductData(app.getPath('userData'))
    } catch (error) {
      console.error(
        'MELDWORK_PRODUCT_DATA_MIGRATION_ABORTED',
        error?.diagnostic || { status: 'failed', code: String(error?.code || '') },
      )
      app.quit()
      return
    }
    const attachmentReferences = persistedAttachmentReferences(workspaceStoragePath())
    customAgentStore = new CustomAgentStore({
      storagePath: path.join(app.getPath('userData'), 'meldwork-custom-agents.json'),
    })
    cloudAgentBridges = new CloudAgentBridgeStore({
      storagePath: path.join(app.getPath('userData'), 'meldwork-cloud-agent-bridges.json'),
      fetch: globalThis.fetch,
    })
    // The shared Provider store was removed; drop any legacy encrypted
    // credentials so they do not linger on disk unread.
    try {
      const { rmSync } = require('node:fs')
      rmSync(path.join(app.getPath('userData'), 'meldwork-provider.json'), { force: true })
    } catch { /* best-effort cleanup */ }
    knowledgeBaseStore = new KnowledgeBaseStore({
      storagePath: path.join(app.getPath('userData'), 'meldwork-knowledge-base.json'),
    })
    try {
      attachmentStore = new AttachmentStore({
        rootPath: path.join(app.getPath('userData'), 'attachments'),
      })
    } catch {
      attachmentStore = null
    }
    attachments.registerProtocol(protocol)
    skillCatalog = new LocalSkillCatalog({ home: app.getPath('home') })
    installer = new AgentInstaller({
      detectAgents: detectLocalAgents,
      listSkills: kind => skillCatalog.list(kind),
    })
    installer.on('changed', state => {
      if (mainWindow && !mainWindow.isDestroyed()
          && isTrustedLocalWebContents(mainWindow.webContents)) {
        mainWindow.webContents.send('local-agent-installer:changed', state)
      }
      if (state.phase === 'completed') {
        refreshLocalAgentState().catch(() => {})
      }
    })
    initializeWorkspace()
    if (attachmentStore && attachmentReferences) {
      try {
        attachmentStore.cleanup(attachmentReferences)
      } catch { /* orphan cleanup is best effort; the validated store remains usable */ }
    }
    registerIpc()
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]))
    if (process.platform === 'darwin') {
      const icon = appIconImage()
      if (icon) app.dock?.setIcon?.(icon)
    }
    createWindow()
    app.on('activate', () => {
      if (shutdownStarted) return
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    let channelReceiverActive = false
    try {
      channelReceiverActive = channelIngressRuntime?.status().receiverCount > 0
    } catch { /* An unavailable optional Channel must not keep the process alive. */ }
    if (process.platform !== 'darwin' && !channelReceiverActive) app.quit()
  })

  app.on('before-quit', (event) => {
    event.preventDefault()
    if (quitCleanup) return
    shutdownStarted = true
    cloudAgentStartRetry?.cancel()
    cloudAgentStartRetry = null
    installer?.cancelPending()
    const installerState = installer?.state()
    const installRunning = Boolean(installerState?.canCancel)
    if (installRunning) installer.cancel(installerState.taskId)
    quitCleanup = runQuitCleanup([
      () => channelIngressRuntime?.shutdown(),
      () => cloudAgentBridges?.close(),
      () => cloudAgentRuntime?.shutdown(),
      async () => {
        try {
          await workspace?.stopAll()
        } finally {
          await shutdownAcpSessionRuntime()
        }
      },
      () => installer?.waitForIdle(),
    ]).then(() => {
      app.exit(0)
    })
  })
}

module.exports = {
  isTrustedLocalRenderer,
  isTrustedLocalWebContents,
  runQuitCleanup,
}

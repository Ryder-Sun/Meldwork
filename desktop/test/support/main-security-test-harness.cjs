const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const Module = require('node:module')
const { EventEmitter } = require('node:events')

function pngHeader(width = 1, height = 1) {
  const bytes = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

const LOCAL_IPC_CHANNELS = Object.freeze([
  'local-delivery:save',
  'local-delivery:review',
  'local-delivery:revise',
  'local-delivery:reuse',
  'local-delivery:export',
  'local-workspace:get',
  'local-workspace:refresh-agents',
  'local-workspace:create-group',
  'local-workspace:update-group',
  'local-workspace:delete-group',
  'local-workspace:delete-message',
  'local-workspace:send',
  'local-workspace:stop',
  'local-workspace:control-agent',
  'local-workspace:decide-human-gate',
  'local-cloud-agent:provide-input',
  'local-cloud-agent:decide-permission',
  'local-cloud-agent:cancel',
  'local-cloud-agent-bridge:list',
  'local-cloud-agent-bridge:connect',
  'local-cloud-agent-bridge:refresh',
  'local-cloud-agent-bridge:delete',
  'local-outcome:record-adoption',
  'local-workspace:pick-directory',
  'local-workspace:default-directory',
  'local-agent-installer:catalog',
  'local-agent-installer:skills',
  'local-skill-trust:list',
  'local-skill-trust:revoke',
  'local-agent-installer:state',
  'local-agent-installer:start',
  'local-agent-installer:cancel',
  'local-agent-installer:set-sidebar-visibility',
  'local-custom-agent:create',
  'local-custom-agent:delete',
  'local-agent-connector:list',
  'local-agent-connector:packages',
  'local-agent-connector:import',
  'local-agent-connector:inspect',
  'local-agent-connector:audit',
  'local-agent-connector:approve',
  'local-agent-connector:install',
  'local-agent-connector:disable',
  'local-agent-connector:revoke',
  'local-agent-connector:upgrade',
  'local-agent-connector:remove',
  'local-agent-connector:configure',
  'local-agent-connector:delete',
  'local-agent-connector:test',
  'local-attachments:pick',
  'local-attachments:import',
  'local-attachments:preview',
  'local-attachments:open',
  'local-attachments:discard',
  'local-knowledge-connector:list',
  'local-knowledge-connector:authorize',
  'local-knowledge-connector:revoke',
  'local-knowledge-connector:probe',
  'local-knowledge-connector:search',
  'local-knowledge-connector:fetch',
  'local-knowledge-connector:snapshot',
  'local-knowledge-connector:citation',
  'local-knowledge-connector:select',
  'local-knowledge-base:status',
  'local-knowledge-base:open-guide',
  'local-knowledge-base:pick-obsidian-vault',
])

let nextRoutingId = 1

function deferred() {
  let resolve
  const promise = new Promise(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

async function waitFor(check, message = 'Timed out waiting for test state.') {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error(message)
}

function eventFor(url) {
  const mainFrame = { url, processId: 1, routingId: nextRoutingId++ }
  const sender = { mainFrame }
  return { event: { sender, senderFrame: { ...mainFrame } }, sender }
}

function loadMain(userData, options = {}) {
  const appListeners = new Map()
  const ipcHandlers = new Map()
  const ipcListeners = new Map()
  const windows = []
  const workspaceInstances = []
  const installerInstances = []
  const customAgentStoreInstances = []
  const knowledgeBaseStoreInstances = []
  const knowledgeBaseResolveCalls = []
  const attachmentInstances = []
  const skillCatalogInstances = []
  const skillSnapshotStoreInstances = []
  const skillSnapshotSelectionInstances = []
  const skillTrustStoreInstances = []
  const cloudAgentRuntimeInstances = []
  const cloudAgentOperationStoreInstances = []
  const channelInboxStoreInstances = []
  const channelIngressRuntimeInstances = []
  const runAgentCalls = []
  const customAgentRunCalls = []
  const externalUrls = []
  const openPathCalls = []
  const dialogCalls = []
  const permissionHandlers = {}
  const nativeImageCalls = []
  const nativeImagePathCalls = []
  const dockIconCalls = []
  const notificationInstances = []
  const protocolHandlers = new Map()
  const registeredSchemes = []
  let readyCallback
  let appReady = false
  let quitCount = 0
  const exitCalls = []
  let singleInstanceLockCalls = 0
  let attachmentConstructionCount = 0

  class TestWorkspace extends EventEmitter {
    constructor(input) {
      super()
      this.input = input
      this.outcomeStore = input.outcomeStore
      this.state = structuredClone(options.workspaceSnapshot || {
        agents: [], groups: [], messages: [], localOnly: true,
      })
      this.refreshCount = 0
      this.concurrentRefreshes = 0
      this.maxConcurrentRefreshes = 0
      this.clearRuntimeCredentialFailuresCount = 0
      this.runtimeCredentialMarks = []
      this.stopCount = 0
      this.deleteMessageCalls = []
      this.stopCalls = []
      this.sendMessageCalls = []
      this.agentControlCalls = []
      this.humanGateDecisionCalls = []
      workspaceInstances.push(this)
    }

    async refreshAgents() {
      this.refreshCount += 1
      this.concurrentRefreshes += 1
      this.maxConcurrentRefreshes = Math.max(
        this.maxConcurrentRefreshes,
        this.concurrentRefreshes,
      )
      try {
        await options.onRefresh?.(this, this.refreshCount)
        return this.snapshot()
      } finally {
        this.concurrentRefreshes -= 1
      }
    }

    snapshot() { return this.state }
    clearRuntimeCredentialFailures() { this.clearRuntimeCredentialFailuresCount += 1 }
    markRuntimeCredential(kind, credentialState) {
      this.runtimeCredentialMarks.push({ kind, credentialState })
    }
    createGroup() { return this.snapshot() }
    updateGroup() { return this.snapshot() }
    deleteGroup(groupId) {
      this.state.groups = this.state.groups.filter(group => group.id !== groupId)
      this.state.messages = this.state.messages.filter(message => message.groupId !== groupId)
    }
    deleteMessage(groupId, messageId) {
      this.deleteMessageCalls.push([groupId, messageId])
      const target = this.state.messages.find(message => (
        message.groupId === groupId && message.id === messageId
      ))
      if (!target) throw new Error('LOCAL_MESSAGE_NOT_FOUND')
      const deletedIds = new Set([target.id])
      if (target.role === 'user' && !target.threadRootId) {
        for (const message of this.state.messages) {
          if (message.groupId === groupId && message.threadRootId === target.id) {
            deletedIds.add(message.id)
          }
        }
      }
      this.state.messages = this.state.messages.filter(message => !deletedIds.has(message.id))
    }
    sendMessage(input) {
      this.sendMessageCalls.push(structuredClone(input))
      return Promise.resolve(this.snapshot())
    }
    startAuto() { return this.snapshot() }
    stop(groupId, runId) {
      this.stopCalls.push({ groupId, runId })
      return true
    }
    controlAgent(groupId, runId, kind, action, replacementKind) {
      this.agentControlCalls.push({ groupId, runId, kind, action, replacementKind })
      return true
    }
    listHumanGates() { return this.state.humanGates || [] }
    decideHumanGate(gateId, decision) {
      this.humanGateDecisionCalls.push({ gateId, decision })
      return { gateId, ...decision }
    }
    setSidebarVisibility() { return this.snapshot() }
    async stopAll() {
      this.stopCount += 1
      if (options.workspaceStopGate) await options.workspaceStopGate.promise
    }
  }

  class TestInstaller extends EventEmitter {
    constructor(input) {
      super()
      this.input = input
      this.cancelled = []
      this.pendingCancelCount = 0
      this.invalidateCount = 0
      this.detectedCount = 0
      installerInstances.push(this)
    }

    catalog() { return Promise.resolve({ agents: [] }) }
    skills(kind) {
      this.skillsKind = kind
      return Promise.resolve(options.skillsResult || {
        supported: true, total: 0, limit: 100, skills: [],
      })
    }
    detectedAgents() {
      this.detectedCount += 1
      return Promise.resolve(options.detectedAgents || [])
    }
    state() { return options.installerState || { phase: 'idle', canCancel: false } }
    start() { return this.state() }
    cancel(taskId) { this.cancelled.push(taskId); return true }
    cancelPending() { this.pendingCancelCount += 1; return true }
    invalidateDetectionCache() { this.invalidateCount += 1 }
    async waitForIdle() {
      if (options.installerIdleGate) await options.installerIdleGate.promise
    }
  }

  class TestCustomAgentStore {
    constructor(input) {
      this.input = input
      this.created = []
      this.removed = []
      this.detectCount = 0
      this.agents = structuredClone(options.customAgents || [])
      customAgentStoreInstances.push(this)
    }

    has(kind) {
      return this.agents.some(agent => agent.kind === kind)
    }

    label(kind) {
      return this.agents.find(agent => agent.kind === kind)?.label || ''
    }

    async detectAgents() {
      this.detectCount += 1
      return this.agents.filter(agent => agent.installed !== false).map(agent => ({
        ...agent,
        executable: agent.executable || `/private/${agent.commandName || 'custom-agent'}`,
      }))
    }

    async catalog() {
      return this.agents.map(({ executable: _executable, args: _args, ...agent }) => ({
        installed: agent.installed !== false,
        installSupported: false,
        imageAttachmentLimit: 0,
        ...agent,
        custom: true,
      }))
    }

    create(input, executable) {
      this.created.push({ input, executable })
      const agent = {
        kind: 'custom-0123456789abcdef',
        label: String(input?.label || ''),
        description: String(input?.description || ''),
        commandName: path.basename(executable),
        promptMode: input?.promptMode,
        custom: true,
        installed: true,
        installSupported: false,
        imageAttachmentLimit: 0,
        version: '1.0.0',
        executable,
      }
      this.agents.push(agent)
      const { executable: _privatePath, ...profile } = agent
      return profile
    }

    remove(kind) {
      this.removed.push(kind)
      this.agents = this.agents.filter(agent => agent.kind !== kind)
      return true
    }

    run(...args) {
      customAgentRunCalls.push(args)
      return Promise.resolve({ text: 'custom reply', sessionRef: '' })
    }
  }

  class TestCloudAgentOperationStore {
    constructor(input) {
      this.input = input
      cloudAgentOperationStoreInstances.push(this)
    }
  }

  class TestCloudAgentRuntime {
    constructor(input) {
      this.input = input
      this.startCount = 0
      this.shutdownCount = 0
      this.inputCalls = []
      this.permissionCalls = []
      this.cancelCalls = []
      cloudAgentRuntimeInstances.push(this)
    }

    workspaceLedger() { return this.input.runLedger }
    async start() { this.startCount += 1; return [] }
    async shutdown() {
      this.shutdownCount += 1
      if (options.cloudShutdownGate) await options.cloudShutdownGate.promise
    }
    provideInput(runId, requestId, value) {
      this.inputCalls.push({ runId, requestId, value })
      return { runId, status: 'running' }
    }
    decidePermission(runId, requestId, decision) {
      this.permissionCalls.push({ runId, requestId, decision })
      return { runId, status: 'running' }
    }
    cancel(runId) {
      this.cancelCalls.push(runId)
      return true
    }
  }

  class TestChannelInboxStore {
    constructor(input) {
      this.input = input
      channelInboxStoreInstances.push(this)
    }
  }

  class TestChannelIngressRuntime {
    constructor(input) {
      this.input = input
      this.startCount = 0
      this.shutdownCount = 0
      channelIngressRuntimeInstances.push(this)
    }

    status() {
      return {
        started: this.startCount > this.shutdownCount,
        connectorIds: [],
        receiverCount: options.channelReceiverCount || 0,
        queuedDeliveries: 0,
        queuedOutbound: 0,
      }
    }

    async start() {
      this.startCount += 1
      return this.status()
    }

    async shutdown() {
      this.shutdownCount += 1
    }
  }

  class TestAttachmentStore {
    constructor(input) {
      attachmentConstructionCount += 1
      if (options.attachmentInitError) throw options.attachmentInitError
      this.input = input
      this.cleanupCalls = []
      this.importedBuffers = []
      this.importedFiles = []
      this.discarded = []
      this.resolved = []
      this.readWithMetadataCalls = []
      this.metadataById = new Map()
      this.nextId = 0
      attachmentInstances.push(this)
    }

    metadata(name = 'diagram.png', mimeType = 'image/png', size = 3) {
      const metadata = { id: `attachment-${++this.nextId}`, name, mimeType, size }
      this.metadataById.set(metadata.id, metadata)
      return metadata
    }

    importBuffer(input) {
      this.importedBuffers.push(input)
      return this.metadata(input.name, input.mimeType, input.bytes?.length || 3)
    }

    importFile(filename) {
      this.importedFiles.push(filename)
      return this.metadata(path.basename(filename), 'image/png', 3)
    }

    resolve(refs) {
      this.resolved.push(refs)
      return refs.map((ref) => {
        const metadata = typeof ref === 'string'
          ? this.metadataById.get(ref)
            || { id: ref, name: 'diagram.png', mimeType: 'image/png', size: 3 }
          : ref
        return {
          ...metadata,
          path: path.join(userData, 'attachments', metadata.id, 'image.png'),
        }
      })
    }

    readWithMetadata(id) {
      this.readWithMetadataCalls.push(id)
      return {
        metadata: options.mediaMetadata || this.metadataById.get(id)
          || { id, name: 'diagram.png', mimeType: 'image/png', size: 3 },
        bytes: options.mediaBytes || options.attachmentBytes || pngHeader(),
      }
    }
    discard(refs) {
      this.discarded.push(refs)
      return refs.map(ref => typeof ref === 'string' ? ref : ref.id)
    }
    cleanup(refs) {
      this.cleanupCalls.push([...refs])
      if (options.attachmentCleanupError) throw options.attachmentCleanupError
      return { discardedIds: [], removedTemporaryEntries: 0 }
    }
  }

  class TestLocalSkillCatalog {
    constructor(input) {
      this.input = input
      this.invalidateCalls = 0
      this.listCalls = []
      this.validationCalls = []
      skillCatalogInstances.push(this)
    }

    invalidate() {
      this.invalidateCalls += 1
    }

    list(kind) {
      this.listCalls.push(kind)
      return options.skillsResult || { supported: true, total: 0, limit: 100, skills: [] }
    }

    validateSelections(kind, selections) {
      this.validationCalls.push({ kind, selections })
      return selections
    }

    resolveSelections(kind, selections) {
      return this.validateSelections(kind, selections)
    }
  }

  class TestLocalSkillSnapshotStore {
    constructor(input) {
      this.input = input
      skillSnapshotStoreInstances.push(this)
    }
  }

  class TestLocalSkillSnapshotSelections {
    constructor(input) {
      this.input = input
      this.prepareCalls = []
      skillSnapshotSelectionInstances.push(this)
    }

    prepare(kind, selections) {
      this.prepareCalls.push({ kind, selections })
      return selections
    }
  }

  class TestLocalSkillTrustStore {
    constructor(input) {
      this.input = input
      this.records = options.skillTrustRecords || []
      this.revocations = []
      skillTrustStoreInstances.push(this)
    }

    list() { return this.records }
    revoke(bindingId) {
      this.revocations.push(bindingId)
      return { bindingId, revoked: true }
    }
  }

  class TestKnowledgeBaseStore {
    constructor(input) {
      this.input = input
      this.savedVaultPaths = []
      this.vaultPath = options.obsidianVaultPath || ''
      knowledgeBaseStoreInstances.push(this)
    }

    state() {
      return {
        version: 1,
        obsidianVaultPath: this.vaultPath,
      }
    }

    saveObsidianVaultPath(value) {
      this.vaultPath = String(value || '')
      this.savedVaultPaths.push(this.vaultPath)
      return {
        version: 1,
        obsidianVaultPath: this.vaultPath,
      }
    }
  }

  class TestBrowserWindow {
    constructor(input) {
      this.input = input
      this.loads = []
      this.windowListeners = new Map()
      this.destroyed = false
      this.focused = options.windowFocused !== false
      this.minimized = options.windowMinimized === true
      this.focusCount = 0
      this.restoreCount = 0
      this.showCount = 0
      const mainFrame = { url: 'about:blank', processId: 1, routingId: nextRoutingId++ }
      this.webContents = {
        mainFrame,
        listeners: new Map(),
        sent: [],
        session: {
          setPermissionCheckHandler: listener => { permissionHandlers.check = listener },
          setPermissionRequestHandler: listener => { permissionHandlers.request = listener },
          setDevicePermissionHandler: listener => { permissionHandlers.device = listener },
        },
        on: (name, listener) => this.webContents.listeners.set(name, listener),
        send: (...args) => this.webContents.sent.push(args),
        setWindowOpenHandler: listener => { this.openHandler = listener },
      }
      windows.push(this)
    }

    isDestroyed() { return this.destroyed }
    isFocused() { return this.focused }
    isMinimized() { return this.minimized }
    focus() { this.focused = true; this.focusCount += 1 }
    restore() { this.minimized = false; this.restoreCount += 1 }
    show() { this.showCount += 1 }

    loadFile(filename, loadOptions = {}) {
      let url = pathToFileURL(filename).href
      if (loadOptions.query) url += `?${new URLSearchParams(loadOptions.query)}`
      if (loadOptions.hash) url += `#${loadOptions.hash}`
      const deferred = options.deferRestoredWindowLoad === true && windows.indexOf(this) > 0
      if (deferred) this.pendingLoadUrl = url
      else this.webContents.mainFrame.url = url
      this.loads.push({ filename, options: loadOptions, url })
      return Promise.resolve()
    }

    finishLoad() {
      if (this.pendingLoadUrl) {
        this.webContents.mainFrame.url = this.pendingLoadUrl
        this.pendingLoadUrl = ''
      }
      this.webContents.listeners.get('did-finish-load')?.()
    }

    on(name, listener) {
      this.windowListeners.set(name, name === 'closed'
        ? () => {
            this.destroyed = true
            listener()
          }
        : listener)
    }
  }
  TestBrowserWindow.getAllWindows = () => windows.filter(window => !window.destroyed)

  class TestNotification extends EventEmitter {
    constructor(input) {
      super()
      this.input = input
      this.showCount = 0
      notificationInstances.push(this)
    }

    show() { this.showCount += 1 }
  }
  TestNotification.isSupported = () => options.notificationSupported !== false

  const iconImage = {
    isEmpty: () => false,
    getSize: () => ({ width: 512, height: 512 }),
    resize: () => iconImage,
    toDataURL: () => 'data:image/png;base64,AQID',
  }

  const electron = {
    app: {
      getPath: name => name === 'documents'
        ? path.join(userData, 'Documents')
        : name === 'home' ? path.join(userData, 'Home') : userData,
      getLocale: () => options.locale || 'en-US',
      isPackaged: false,
      isReady: () => appReady,
      on: (name, listener) => appListeners.set(name, listener),
      quit: () => { quitCount += 1 },
      exit: code => exitCalls.push(code),
      requestSingleInstanceLock: () => {
        singleInstanceLockCalls += 1
        return options.singleInstanceLock !== false
      },
      whenReady: () => ({ then: listener => { readyCallback = listener } }),
      dock: {
        setIcon: icon => dockIconCalls.push(icon),
      },
    },
    BrowserWindow: TestBrowserWindow,
    Notification: TestNotification,
    dialog: {
      showOpenDialog: async (...args) => {
        dialogCalls.push(args)
        return options.dialogResult || { canceled: true, filePaths: [] }
      },
      showMessageBox: async (...args) => {
        dialogCalls.push(args)
        return options.messageBoxResult || { response: 1 }
      },
    },
    ipcMain: {
      handle: (name, listener) => ipcHandlers.set(name, listener),
      on: (name, listener) => ipcListeners.set(name, listener),
    },
    protocol: {
      registerSchemesAsPrivileged: schemes => registeredSchemes.push(...schemes),
      handle: (scheme, listener) => protocolHandlers.set(scheme, listener),
    },
    Menu: {
      buildFromTemplate: template => template,
      setApplicationMenu: () => {},
    },
    shell: {
      openExternal: url => {
        externalUrls.push(url)
        return Promise.resolve()
      },
      openPath: filename => {
        openPathCalls.push(filename)
        return Promise.resolve(options.openPathResult || '')
      },
    },
    nativeImage: {
      createFromPath: filename => {
        nativeImagePathCalls.push(filename)
        return iconImage
      },
      createFromBuffer: (bytes) => {
        nativeImageCalls.push(bytes)
        const image = {
          isEmpty: () => false,
          getSize: () => options.nativeImageSize || { width: 640, height: 320 },
          resize: () => image,
          toDataURL: () => 'data:image/png;base64,AQID',
        }
        return image
      },
    },
  }
  Object.defineProperty(electron, 'safeStorage', {
    enumerable: true,
    get: () => {
      options.onSafeStorageAccess?.(windows.length)
      return options.safeStorage || {
        isEncryptionAvailable: () => true,
        encryptString: value => Buffer.from(value),
        decryptString: value => Buffer.from(value).toString('utf8'),
      }
    },
  })

  const openClawRuntimeMock = {
    nativeOpenClawOptions: input => ({ env: { NATIVE_OPENCLAW: JSON.stringify(input) } }),
  }

  const moduleMocks = {
    electron,
    './agents/cli/cli-adapters.cjs': {
      detectAgents: async () => [],
      imageAttachmentLimit: kind => ({ codex: 4, hermes: 1, opencode: 4 })[kind] || 0,
      runAgent: async (...args) => {
        runAgentCalls.push(args)
        return { text: 'local reply', sessionRef: 'local-session' }
      },
    },
    './agents/installer/agent-installer.cjs': { AgentInstaller: TestInstaller },
    './agents/cloud/cloud-agent-operation-store.cjs': { CloudAgentOperationStore: TestCloudAgentOperationStore },
    './agents/cloud/cloud-agent-runtime.cjs': { CloudAgentRuntime: TestCloudAgentRuntime },
    './channels/channel-inbox-store.cjs': { ChannelInboxStore: TestChannelInboxStore },
    './channels/channel-ingress-runtime.cjs': { ChannelIngressRuntime: TestChannelIngressRuntime },
    './agents/custom-agent-store.cjs': { CustomAgentStore: TestCustomAgentStore },
    './attachments/attachment-store.cjs': { AttachmentStore: TestAttachmentStore },
    './agents/local-agent-readiness.cjs': {
      nativeCredentialEnvironment: (...args) => options.nativeEnvironment?.(...args) || {},
      resolveNativeShellEnvironment: async input => options.nativeShellEnvironment?.(input) || ({
        env: { PATH: process.env.PATH || '' },
        source: 'process',
      }),
      resolveNativeOpenClawRuntime: async input => options.nativeOpenClawRuntime?.(input) || ({
        model: 'native/model',
        provider: {
          id: 'native',
          baseUrl: 'https://native.example.com/v1',
          api: 'openai-completions',
          apiKey: 'native-openclaw-key',
          model: { id: 'model', name: 'Native Model', input: ['text'] },
        },
      }),
      resolveNativeCredentialState: async () => ({ state: 'ready', source: 'native-credential' }),
    },
    './workspace/local-workspace.cjs': { LocalWorkspace: TestWorkspace },
    './skills/local-skill-catalog.cjs': { LocalSkillCatalog: TestLocalSkillCatalog },
    './skills/local-skill-snapshot.cjs': { LocalSkillSnapshotStore: TestLocalSkillSnapshotStore },
    './skills/local-skill-snapshot-selections.cjs': {
      LocalSkillSnapshotSelections: TestLocalSkillSnapshotSelections,
    },
    './skills/local-skill-trust-store.cjs': { LocalSkillTrustStore: TestLocalSkillTrustStore },
    './agents/cli/openclaw-runtime.cjs': openClawRuntimeMock,
    '../agents/cli/openclaw-runtime.cjs': openClawRuntimeMock,
    './knowledge/knowledge-base-store.cjs': { KnowledgeBaseStore: TestKnowledgeBaseStore },
    './knowledge/local-knowledge-base.cjs': {
      knowledgeBaseSelectionHint: (source, targetKinds) => {
        if (options.knowledgeBaseSelectionHint) {
          return options.knowledgeBaseSelectionHint(source, targetKinds)
        }
        return source?.ready ? {
          kind: source.kind,
          name: source.label || source.kind,
          accessMode: source.accessMode,
          targetKinds,
          ...(source.accessMode === 'vault'
            ? { location: source.vaultPath }
            : { commandName: source.commandName }),
        } : null
      },
      knowledgeBaseGuideUrl: (kind, action) => (
        options.knowledgeBaseGuideUrl?.(kind, action) || `https://example.com/${kind}/${action}`
      ),
      resolveKnowledgeBaseSources: async (input) => {
        knowledgeBaseResolveCalls.push(input)
        if (options.resolveKnowledgeBaseSources) {
          return options.resolveKnowledgeBaseSources(input)
        }
        return options.knowledgeBaseSources || [{
          kind: 'obsidian',
          installed: true,
          vaultPath: input.store?.state?.().obsidianVaultPath || '',
        }]
      },
    },
    ...options.moduleMocks,
  }

  const originalLoad = Module._load
  Module._load = function load(request, parent, isMain) {
    if (Object.hasOwn(moduleMocks, request)) return moduleMocks[request]
    return originalLoad.call(this, request, parent, isMain)
  }
  const filename = require.resolve('../../src/main.cjs')
  delete require.cache[filename]
  try {
    const main = require(filename)
    return {
      main,
      harness: {
        appListeners,
        attachmentInstances,
        get attachmentConstructionCount() { return attachmentConstructionCount },
        ipcHandlers,
        ipcListeners,
        installerInstances,
        customAgentStoreInstances,
        customAgentRunCalls,
        cloudAgentRuntimeInstances,
        cloudAgentOperationStoreInstances,
        channelInboxStoreInstances,
        channelIngressRuntimeInstances,
        dockIconCalls,
        nativeImageCalls,
        nativeImagePathCalls,
        notificationInstances,
        knowledgeBaseResolveCalls,
        knowledgeBaseStoreInstances,
        dialogCalls,
        externalUrls,
        openPathCalls,
        permissionHandlers,
        protocolHandlers,
        registeredSchemes,
        runAgentCalls,
        skillCatalogInstances,
        skillSnapshotStoreInstances,
        skillSnapshotSelectionInstances,
        skillTrustStoreInstances,
        windows,
        workspaceInstances,
        exitCalls,
        get quitCount() { return quitCount },
        get readyRegistered() { return typeof readyCallback === 'function' },
        get singleInstanceLockCalls() { return singleInstanceLockCalls },
        event: () => {
          const sender = windows.at(-1)?.webContents
          return { sender, senderFrame: sender ? { ...sender.mainFrame } : null }
        },
        ready: async () => {
          assert.equal(typeof readyCallback, 'function')
          appReady = true
          await readyCallback()
        },
      },
    }
  } finally {
    Module._load = originalLoad
    delete require.cache[filename]
  }
}

module.exports = {
  LOCAL_IPC_CHANNELS,
  deferred,
  eventFor,
  loadMain,
  pngHeader,
  waitFor,
}

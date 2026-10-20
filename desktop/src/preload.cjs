const { contextBridge, ipcRenderer } = require('electron')

const MAX_ATTACHMENT_BYTES = 128 * 1024 * 1024
const ATTACHMENT_LIMITS = new Map([
  ['image/png', 8 * 1024 * 1024],
  ['image/jpeg', 8 * 1024 * 1024],
  ['image/gif', 8 * 1024 * 1024],
  ['image/webp', 8 * 1024 * 1024],
  ['audio/mpeg', 32 * 1024 * 1024],
  ['audio/wav', 64 * 1024 * 1024],
  ['audio/mp4', 64 * 1024 * 1024],
  ['video/mp4', MAX_ATTACHMENT_BYTES],
  ['video/quicktime', MAX_ATTACHMENT_BYTES],
  ['video/webm', MAX_ATTACHMENT_BYTES],
  ['application/pdf', 32 * 1024 * 1024],
  ['text/plain', 8 * 1024 * 1024],
  ['text/markdown', 8 * 1024 * 1024],
  ['text/csv', 8 * 1024 * 1024],
  ['application/json', 8 * 1024 * 1024],
  ['application/rtf', 8 * 1024 * 1024],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 32 * 1024 * 1024],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 32 * 1024 * 1024],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 32 * 1024 * 1024],
  ['application/msword', 32 * 1024 * 1024],
  ['application/vnd.ms-excel', 32 * 1024 * 1024],
  ['application/vnd.ms-powerpoint', 32 * 1024 * 1024],
  ['application/zip', MAX_ATTACHMENT_BYTES],
  ['application/gzip', MAX_ATTACHMENT_BYTES],
  ['application/x-tar', MAX_ATTACHMENT_BYTES],
  ['application/x-7z-compressed', MAX_ATTACHMENT_BYTES],
])

function attachmentError(code) {
  return Object.assign(new Error(code), { code })
}

function normalizeAttachmentImport(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || typeof input.name !== 'string' || input.name.length > 4096
      || typeof input.mimeType !== 'string' || input.mimeType.length > 128) {
    throw attachmentError('LOCAL_ATTACHMENT_INPUT_INVALID')
  }
  const declaredMimeType = input.mimeType.split(';', 1)[0].trim().toLowerCase()
  const mimeType = declaredMimeType === 'image/jpg' ? 'image/jpeg' : declaredMimeType
  const limit = ATTACHMENT_LIMITS.get(mimeType)
  if (!limit) {
    throw attachmentError('LOCAL_ATTACHMENT_TYPE_UNSUPPORTED')
  }
  const bytes = input.bytes
  if (!ArrayBuffer.isView(bytes)
      || Object.prototype.toString.call(bytes) !== '[object Uint8Array]'
      || bytes.byteLength <= 0) {
    throw attachmentError('LOCAL_ATTACHMENT_BYTES_INVALID')
  }
  if (bytes.byteLength > limit) {
    throw attachmentError('LOCAL_ATTACHMENT_TOO_LARGE')
  }
  return {
    name: input.name,
    mimeType,
    bytes: Uint8Array.from(bytes),
  }
}

const isLocalDocument = location.protocol === 'file:'
const desktopApi = {
  isDesktop: true,
  localOnly: true,
  platform: process.platform,
}

if (isLocalDocument) Object.assign(desktopApi, {
  localWorkspace: Object.freeze({
    get: () => ipcRenderer.invoke('local-workspace:get'),
    refreshAgents: () => ipcRenderer.invoke('local-workspace:refresh-agents'),
    createGroup: input => ipcRenderer.invoke('local-workspace:create-group', input),
    updateGroup: (groupId, input) => ipcRenderer.invoke('local-workspace:update-group', groupId, input),
    deleteGroup: groupId => ipcRenderer.invoke('local-workspace:delete-group', groupId),
    deleteMessage: (groupId, messageId) => ipcRenderer.invoke('local-workspace:delete-message', groupId, messageId),
    send: input => ipcRenderer.invoke('local-workspace:send', input),
    stop: (groupId, runId) => ipcRenderer.invoke('local-workspace:stop', groupId, runId),
    controlAgent: (groupId, runId, kind, action, replacementKind = '') => ipcRenderer.invoke(
      'local-workspace:control-agent', groupId, runId, kind, action, replacementKind,
    ),
    decideHumanGate: (gateId, decision) => ipcRenderer.invoke(
      'local-workspace:decide-human-gate', gateId, decision,
    ),
    pickDirectory: () => ipcRenderer.invoke('local-workspace:pick-directory'),
    defaultDirectory: () => ipcRenderer.invoke('local-workspace:default-directory'),
    onChanged: callback => {
      const listener = (_event, snapshot) => callback(snapshot)
      ipcRenderer.on('local-workspace:changed', listener)
      return () => ipcRenderer.removeListener('local-workspace:changed', listener)
    },
    onRunFinished: callback => {
      const listener = (_event, result) => callback(result)
      ipcRenderer.on('local-workspace:run-finished', listener)
      return () => ipcRenderer.removeListener('local-workspace:run-finished', listener)
    },
    onRunEvent: callback => {
      const listener = (_event, event) => callback(event)
      ipcRenderer.on('local-workspace:run-event', listener)
      return () => ipcRenderer.removeListener('local-workspace:run-event', listener)
    },
    onOpenGroup: callback => {
      const listener = (_event, request) => callback(request)
      ipcRenderer.on('local-workspace:open-group', listener)
      return () => ipcRenderer.removeListener('local-workspace:open-group', listener)
    },
  }),
  cloudAgent: Object.freeze({
    provideInput: (runId, requestId, value) => ipcRenderer.invoke(
      'local-cloud-agent:provide-input', runId, requestId, value,
    ),
    decidePermission: (runId, requestId, decision) => ipcRenderer.invoke(
      'local-cloud-agent:decide-permission', runId, requestId, decision,
    ),
    cancel: runId => ipcRenderer.invoke('local-cloud-agent:cancel', runId),
  }),
  cloudAgentBridge: Object.freeze({
    list: () => ipcRenderer.invoke('local-cloud-agent-bridge:list'),
    connect: input => ipcRenderer.invoke('local-cloud-agent-bridge:connect', input),
    refresh: () => ipcRenderer.invoke('local-cloud-agent-bridge:refresh'),
    delete: bridgeId => ipcRenderer.invoke('local-cloud-agent-bridge:delete', bridgeId),
  }),
  localOutcome: Object.freeze({
    recordAdoption: input => ipcRenderer.invoke('local-outcome:record-adoption', input),
  }),
  localDelivery: Object.freeze({
    save: input => ipcRenderer.invoke('local-delivery:save', input),
    review: input => ipcRenderer.invoke('local-delivery:review', input),
    revise: input => ipcRenderer.invoke('local-delivery:revise', input),
    reuse: input => ipcRenderer.invoke('local-delivery:reuse', input),
    export: input => ipcRenderer.invoke('local-delivery:export', input),
  }),
  workBuddy: Object.freeze({
    settings: () => ipcRenderer.invoke('local-workbuddy:settings'),
    setModel: modelId => ipcRenderer.invoke('local-workbuddy:set-model', modelId),
  }),
  agentInstaller: Object.freeze({
    catalog: () => ipcRenderer.invoke('local-agent-installer:catalog'),
    skills: kind => ipcRenderer.invoke('local-agent-installer:skills', kind),
    state: () => ipcRenderer.invoke('local-agent-installer:state'),
    start: kind => ipcRenderer.invoke('local-agent-installer:start', kind),
    cancel: taskId => ipcRenderer.invoke('local-agent-installer:cancel', taskId),
    setSidebarVisibility: (kind, visible) => ipcRenderer.invoke(
      'local-agent-installer:set-sidebar-visibility', kind, visible,
    ),
    onChanged: callback => {
      const listener = (_event, state) => callback(state)
      ipcRenderer.on('local-agent-installer:changed', listener)
      return () => ipcRenderer.removeListener('local-agent-installer:changed', listener)
    },
  }),
  localSkillTrust: Object.freeze({
    list: () => ipcRenderer.invoke('local-skill-trust:list'),
    revoke: bindingId => ipcRenderer.invoke('local-skill-trust:revoke', bindingId),
  }),
  customAgent: Object.freeze({
    create: input => ipcRenderer.invoke('local-custom-agent:create', input),
    delete: kind => ipcRenderer.invoke('local-custom-agent:delete', kind),
  }),
  localAgentConnector: Object.freeze({
    list: () => ipcRenderer.invoke('local-agent-connector:list'),
    packages: () => ipcRenderer.invoke('local-agent-connector:packages'),
    import: () => ipcRenderer.invoke('local-agent-connector:import'),
    inspect: packageId => ipcRenderer.invoke('local-agent-connector:inspect', packageId),
    audit: packageId => ipcRenderer.invoke('local-agent-connector:audit', packageId),
    approve: packageId => ipcRenderer.invoke('local-agent-connector:approve', packageId),
    install: packageId => ipcRenderer.invoke('local-agent-connector:install', packageId),
    configure: input => ipcRenderer.invoke('local-agent-connector:configure', input),
    test: instanceId => ipcRenderer.invoke('local-agent-connector:test', instanceId),
    disable: packageId => ipcRenderer.invoke('local-agent-connector:disable', packageId),
    revoke: packageId => ipcRenderer.invoke('local-agent-connector:revoke', packageId),
    upgrade: packageId => ipcRenderer.invoke('local-agent-connector:upgrade', packageId),
    remove: packageId => ipcRenderer.invoke('local-agent-connector:remove', packageId),
    delete: instanceId => ipcRenderer.invoke('local-agent-connector:delete', instanceId),
  }),
  localAttachments: Object.freeze({
    pickAttachments: remainingCapacity => ipcRenderer.invoke(
      'local-attachments:pick', remainingCapacity,
    ),
    importAttachment: input => ipcRenderer.invoke(
      'local-attachments:import', normalizeAttachmentImport(input),
    ),
    preview: id => ipcRenderer.invoke('local-attachments:preview', id),
    open: id => ipcRenderer.invoke('local-attachments:open', id),
    discard: ids => ipcRenderer.invoke('local-attachments:discard', ids),
  }),
  localKnowledgeBase: Object.freeze({
    status: kind => (kind ? ipcRenderer.invoke('local-knowledge-base:status', kind) : ipcRenderer.invoke('local-knowledge-base:status')),
    openGuide: (kind, action) => ipcRenderer.invoke('local-knowledge-base:open-guide', kind, action),
    pickObsidianVault: () => ipcRenderer.invoke('local-knowledge-base:pick-obsidian-vault'),
  }),
  localKnowledgeConnector: Object.freeze({
    authorize: connectorId => ipcRenderer.invoke(
      'local-knowledge-connector:authorize', connectorId,
    ),
    revoke: instanceId => ipcRenderer.invoke('local-knowledge-connector:revoke', instanceId),
    list: () => ipcRenderer.invoke('local-knowledge-connector:list'),
    probe: instanceId => ipcRenderer.invoke('local-knowledge-connector:probe', instanceId),
    search: (instanceId, input) => ipcRenderer.invoke(
      'local-knowledge-connector:search', instanceId, input,
    ),
    fetch: (instanceId, input) => ipcRenderer.invoke(
      'local-knowledge-connector:fetch', instanceId, input,
    ),
    snapshot: (instanceId, input) => ipcRenderer.invoke(
      'local-knowledge-connector:snapshot', instanceId, input,
    ),
    citation: (instanceId, input) => ipcRenderer.invoke(
      'local-knowledge-connector:citation', instanceId, input,
    ),
    select: (instanceId, input) => ipcRenderer.invoke(
      'local-knowledge-connector:select', instanceId, input,
    ),
  }),
})

contextBridge.exposeInMainWorld('meldworkDesktop', Object.freeze(desktopApi))

import { flushPromises, mount } from '@vue/test-utils'
import { vi } from 'vitest'
import App from '../../App.vue'
import { AGENTS } from '../../catalog.js'

function baseSnapshot() {
  return {
    agents: AGENTS.filter(agent => ['codex', 'hermes'].includes(agent.kind)).map(agent => ({
      kind: agent.kind,
      installed: true,
      available: true,
      credentialState: 'ready',
      version: '1.0.0',
    })),
    groups: [],
    messages: [],
    runningGroupIds: [],
    runs: [],
    humanGates: [],
  }
}

function knowledgeBaseStatuses(vaultPath = '') {
  const vaultReady = Boolean(vaultPath)
  return [
    {
      kind: 'feishu',
      label: 'Feishu Docs',
      badge: 'FS',
      type: 'cloud',
      accessMode: 'cli',
      installed: false,
      configured: false,
      loginState: 'missing',
      permissionState: 'unknown',
      commandName: '',
      vaultPath: '',
      readable: false,
      writable: false,
      probeState: 'ready',
      errorCode: '',
      ready: false,
      installCommand: 'npm install -g @larksuite/cli@latest',
      statusCommand: 'lark-cli auth status',
      loginCommand: 'lark-cli auth login',
      permissionCommand: 'lark-cli docs +search --query . --page-size 1 --as user',
    },
    {
      kind: 'dingtalk',
      label: 'DingTalk Docs',
      badge: 'DT',
      type: 'cloud',
      accessMode: 'cli',
      installed: true,
      configured: false,
      loginState: 'ready',
      permissionState: 'ready',
      commandName: 'dws',
      vaultPath: '',
      readable: true,
      writable: false,
      probeState: 'ready',
      errorCode: '',
      ready: true,
      installCommand: 'npm install -g dingtalk-workspace-cli --registry=https://registry.npmmirror.com',
      statusCommand: 'dws auth status',
      loginCommand: 'dws auth login',
      permissionCommand: 'dws doc list --page-size 1',
    },
    {
      kind: 'obsidian',
      label: 'Obsidian',
      badge: 'OB',
      type: 'local',
      accessMode: 'vault',
      installed: true,
      configured: false,
      loginState: 'ready',
      permissionState: 'ready',
      commandName: 'Obsidian app',
      vaultPath,
      vaultDetails: {
        exists: vaultReady,
        directory: vaultReady,
        readable: vaultReady,
        writable: vaultReady,
      },
      readable: false,
      writable: false,
      probeState: 'ready',
      errorCode: '',
      ready: vaultReady,
    },
  ]
}

export function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

export function imageAttachment(id, name = `${id}.png`) {
  return {
    id,
    name,
    mimeType: 'image/png',
    size: 3,
    previewDataUrl: 'data:image/png;base64,AQID',
  }
}

export function createBridge() {
  const state = baseSnapshot()
  let workspaceChanged = null
  let runEvent = null
  let runFinished = null
  let openGroup = null
  const snapshot = value => structuredClone(value || state)
  const cloneInput = input => structuredClone(input)
  const workspace = {
    get: vi.fn(async () => snapshot()),
    refreshAgents: vi.fn(async () => snapshot()),
    createGroup: vi.fn(async input => ({
      id: 'group-1',
      createdAt: '2026-07-29T08:00:00Z',
      ...cloneInput(input),
    })),
    updateGroup: vi.fn(async (_groupId, input) => cloneInput(input)),
    deleteGroup: vi.fn(async () => snapshot()),
    deleteMessage: vi.fn(async () => snapshot()),
    send: vi.fn(async input => {
      cloneInput(input)
      return snapshot()
    }),
    stop: vi.fn(async () => true),
    controlAgent: vi.fn(async () => true),
    decideHumanGate: vi.fn(async (gateId, decision) => {
      const gate = state.humanGates.find(candidate => candidate.gateId === gateId)
      const option = gate?.options?.find(candidate => candidate.optionId === decision.optionId)
      const status = ['allow_once', 'allow_always', 'accept'].includes(option?.kind)
        ? 'approved'
        : 'rejected'
      return {
        gateId,
        status,
        decision: { status, optionId: decision.optionId },
      }
    }),
    pickDirectory: vi.fn(async () => '/tmp/meldwork-workspace'),
    defaultDirectory: vi.fn(async () => '/tmp/meldwork-workspace'),
    onChanged: vi.fn((callback) => {
      workspaceChanged = callback
      return vi.fn(() => { if (workspaceChanged === callback) workspaceChanged = null })
    }),
    onRunEvent: vi.fn((callback) => {
      runEvent = callback
      return vi.fn(() => { if (runEvent === callback) runEvent = null })
    }),
    onRunFinished: vi.fn((callback) => {
      runFinished = callback
      return vi.fn(() => { if (runFinished === callback) runFinished = null })
    }),
    onOpenGroup: vi.fn((callback) => {
      openGroup = callback
      return vi.fn(() => { if (openGroup === callback) openGroup = null })
    }),
  }
  const agentInstaller = {
    catalog: vi.fn(async () => ({
      platform: 'darwin',
      agents: AGENTS.map(agent => ({
        kind: agent.kind,
        installed: true,
        installSupported: true,
      })),
    })),
    state: vi.fn(async () => ({ taskId: '', kind: '', phase: 'idle', canCancel: false, errorCode: '' })),
    skills: vi.fn(async () => ({ skills: [] })),
    start: vi.fn(async kind => ({ taskId: 'install-1', kind, phase: 'checking', canCancel: true })),
    cancel: vi.fn(async () => true),
    onChanged: vi.fn(() => vi.fn()),
  }
  const localKnowledgeBase = {
    status: vi.fn(async () => knowledgeBaseStatuses()),
    openGuide: vi.fn(async () => true),
    pickObsidianVault: vi.fn(async () => (
      knowledgeBaseStatuses('/Users/rydersun/Documents/Knowledge')
    )),
  }
  const localAttachments = {
    pickAttachments: vi.fn(async () => ({ attachments: [] })),
    importAttachment: vi.fn(async input => ({
      id: 'attachment-1',
      name: input.name,
      mimeType: input.mimeType,
      size: input.bytes.length,
      previewDataUrl: 'data:image/png;base64,AQID',
    })),
    preview: vi.fn(async id => ({
      id,
      name: `${id}.png`,
      mimeType: 'image/png',
      size: 3,
      previewDataUrl: 'data:image/png;base64,AQID',
    })),
    open: vi.fn(async () => true),
    discard: vi.fn(async ids => ({ discardedIds: [...ids], retainedIds: [] })),
  }
  return {
    bridge: {
      localWorkspace: workspace,
      agentInstaller,
      customAgent: {
        create: vi.fn(async () => ({ canceled: true })),
        delete: vi.fn(async kind => ({ deleted: true, kind })),
      },
      localKnowledgeBase,
      localAttachments,
    },
    state,
    emitWorkspaceChanged(value = state) { workspaceChanged?.(snapshot(value)) },
    emitRunEvent(value) { runEvent?.(structuredClone(value)) },
    emitRunFinished(value) { runFinished?.(structuredClone(value)) },
    emitOpenGroup(value) { openGroup?.(structuredClone(value)) },
  }
}

export async function mountApp(configure = () => {}) {
  const fixture = createBridge()
  configure(fixture)
  window.meldworkDesktop = fixture.bridge
  const wrapper = mount(App, { attachTo: document.body })
  await flushPromises()
  return { wrapper, ...fixture }
}

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

function loadPreload(protocol) {
  const invocations = []
  const listeners = new Map()
  let exposedName
  let exposed
  const electron = {
    contextBridge: {
      exposeInMainWorld: (name, value) => { exposedName = name; exposed = value },
    },
    ipcRenderer: {
      invoke: (channel, ...args) => {
        invocations.push({ channel, args })
        return Promise.resolve({ configured: true })
      },
      on: (channel, listener) => listeners.set(channel, listener),
      removeListener: (channel, listener) => {
        if (listeners.get(channel) === listener) listeners.delete(channel)
      },
      send: () => {},
    },
  }
  const originalLoad = Module._load
  const originalWindow = global.window
  const originalLocation = global.location
  const originalLocalStorage = global.localStorage
  const originalSetInterval = global.setInterval
  Module._load = function load(request, parent, isMain) {
    if (request === 'electron') return electron
    return originalLoad.call(this, request, parent, isMain)
  }
  global.window = { addEventListener: () => {} }
  global.location = { protocol }
  global.localStorage = { getItem: () => '' }
  global.setInterval = () => 0
  const filename = require.resolve('../../src/preload.cjs')
  delete require.cache[filename]
  try {
    require(filename)
  } finally {
    Module._load = originalLoad
    global.window = originalWindow
    global.location = originalLocation
    global.localStorage = originalLocalStorage
    global.setInterval = originalSetInterval
    delete require.cache[filename]
  }
  return { api: exposed, exposedName, invocations, listeners }
}

test('local preload exposes the local-only Meldwork API', async () => {
  const { api, exposedName, invocations } = loadPreload('file:')

  assert.equal(exposedName, 'meldworkDesktop')
  assert.equal(Object.isFrozen(api), true)
  assert.equal(api.localOnly, true)
  assert.equal(api.platform, process.platform)
  assert.equal(Object.isFrozen(api.localAgentConnector), true)
  assert.equal(Object.isFrozen(api.localSkillTrust), true)
  assert.equal(Object.isFrozen(api.cloudAgent), true)
  assert.equal(Object.isFrozen(api.cloudAgentBridge), true)
  assert.equal(Object.isFrozen(api.localOutcome), true)
  assert.deepEqual(Object.keys(api.localOutcome), ['recordAdoption'])
  assert.deepEqual(
    Object.keys(api.cloudAgent).sort(),
    ['cancel', 'decidePermission', 'provideInput'],
  )
  assert.deepEqual(
    Object.keys(api.cloudAgentBridge).sort(),
    ['connect', 'delete', 'list', 'refresh'],
  )
  assert.deepEqual(
    Object.keys(api.localWorkspace).sort(),
    [
      'controlAgent', 'createGroup', 'decideHumanGate', 'defaultDirectory', 'deleteGroup', 'deleteMessage', 'get', 'onChanged',
      'onOpenGroup', 'onRunEvent', 'onRunFinished', 'pickDirectory', 'refreshAgents', 'send',
      'stop', 'updateGroup',
    ].sort(),
  )
  assert.equal('configure' in api.localWorkspace, false)
  assert.equal('cancelConfigure' in api.localWorkspace, false)
  assert.equal('localAgentProvider' in api, false)
  await api.localWorkspace.deleteMessage('group-1', 'message-1')
  assert.deepEqual(invocations, [{
    channel: 'local-workspace:delete-message',
    args: ['group-1', 'message-1'],
  }])
  invocations.length = 0

  assert.deepEqual(
    Object.keys(api.localAgentConnector).sort(),
    [
      'approve', 'audit', 'configure', 'delete', 'disable', 'import', 'inspect',
      'install', 'list', 'packages', 'remove', 'revoke', 'test', 'upgrade',
    ].sort(),
  )
  const packageId = `connector-package-${'b'.repeat(64)}`
  const configuration = {
    manifestId: `connector-manifest-${'a'.repeat(64)}`,
    label: 'Review account',
    credentials: { account: 'renderer-entered-secret' },
  }
  await api.localAgentConnector.list()
  await api.localAgentConnector.packages()
  await api.localAgentConnector.import()
  await api.localAgentConnector.inspect(packageId)
  await api.localAgentConnector.audit(packageId)
  await api.localAgentConnector.approve(packageId)
  await api.localAgentConnector.install(packageId)
  await api.localAgentConnector.configure(configuration)
  await api.localAgentConnector.test('custom-0123456789abcdef')
  await api.localAgentConnector.disable(packageId)
  await api.localAgentConnector.revoke(packageId)
  await api.localAgentConnector.upgrade(packageId)
  await api.localAgentConnector.remove(packageId)
  await api.localAgentConnector.delete('custom-0123456789abcdef')
  assert.deepEqual(invocations, [
    { channel: 'local-agent-connector:list', args: [] },
    { channel: 'local-agent-connector:packages', args: [] },
    { channel: 'local-agent-connector:import', args: [] },
    { channel: 'local-agent-connector:inspect', args: [packageId] },
    { channel: 'local-agent-connector:audit', args: [packageId] },
    { channel: 'local-agent-connector:approve', args: [packageId] },
    { channel: 'local-agent-connector:install', args: [packageId] },
    { channel: 'local-agent-connector:configure', args: [configuration] },
    { channel: 'local-agent-connector:test', args: ['custom-0123456789abcdef'] },
    { channel: 'local-agent-connector:disable', args: [packageId] },
    { channel: 'local-agent-connector:revoke', args: [packageId] },
    { channel: 'local-agent-connector:upgrade', args: [packageId] },
    { channel: 'local-agent-connector:remove', args: [packageId] },
    {
      channel: 'local-agent-connector:delete',
      args: ['custom-0123456789abcdef'],
    },
  ])
})

test('local preload exposes the complete narrow Knowledge Connector lifecycle', async () => {
  const { api, invocations } = loadPreload('file:')

  assert.equal(Object.isFrozen(api.localKnowledgeBase), true)
  assert.deepEqual(
    Object.keys(api.localKnowledgeBase).sort(),
    ['openGuide', 'pickObsidianVault', 'status'],
  )
  assert.equal('readVault' in api.localKnowledgeBase, false)
  assert.equal('runCommand' in api.localKnowledgeBase, false)
  assert.equal(Object.isFrozen(api.localKnowledgeConnector), true)
  assert.deepEqual(
    Object.keys(api.localKnowledgeConnector).sort(),
    [
      'authorize', 'citation', 'fetch', 'list', 'probe', 'revoke',
      'search', 'select', 'snapshot',
    ],
  )

  await api.localKnowledgeBase.status()
  await api.localKnowledgeBase.openGuide('feishu', 'login')
  await api.localKnowledgeBase.pickObsidianVault()
  await api.localKnowledgeConnector.authorize('knowledge.filesystem')
  await api.localKnowledgeConnector.list()
  await api.localKnowledgeConnector.probe('obsidian-vault-1')
  const sourceRequest = {
    sourceId: `knowledge-source-${'a'.repeat(64)}`,
    locator: 'notes/decision.md',
  }
  await api.localKnowledgeConnector.search('obsidian-vault-1', { query: 'decision', limit: 5 })
  await api.localKnowledgeConnector.fetch('obsidian-vault-1', sourceRequest)
  await api.localKnowledgeConnector.snapshot('obsidian-vault-1', sourceRequest)
  await api.localKnowledgeConnector.citation('obsidian-vault-1', {
    snapshotId: `knowledge-snapshot-${'b'.repeat(64)}`,
  })
  await api.localKnowledgeConnector.select('obsidian-vault-1', {
    ...sourceRequest,
    captureMode: 'snapshot',
  })
  await api.localKnowledgeConnector.revoke('obsidian-vault-1')

  assert.deepEqual(invocations, [
    { channel: 'local-knowledge-base:status', args: [] },
    { channel: 'local-knowledge-base:open-guide', args: ['feishu', 'login'] },
    { channel: 'local-knowledge-base:pick-obsidian-vault', args: [] },
    { channel: 'local-knowledge-connector:authorize', args: ['knowledge.filesystem'] },
    { channel: 'local-knowledge-connector:list', args: [] },
    { channel: 'local-knowledge-connector:probe', args: ['obsidian-vault-1'] },
    {
      channel: 'local-knowledge-connector:search',
      args: ['obsidian-vault-1', { query: 'decision', limit: 5 }],
    },
    {
      channel: 'local-knowledge-connector:fetch',
      args: ['obsidian-vault-1', sourceRequest],
    },
    {
      channel: 'local-knowledge-connector:snapshot',
      args: ['obsidian-vault-1', sourceRequest],
    },
    {
      channel: 'local-knowledge-connector:citation',
      args: ['obsidian-vault-1', {
        snapshotId: `knowledge-snapshot-${'b'.repeat(64)}`,
      }],
    },
    {
      channel: 'local-knowledge-connector:select',
      args: ['obsidian-vault-1', {
        sourceId: `knowledge-source-${'a'.repeat(64)}`,
        locator: 'notes/decision.md',
        captureMode: 'snapshot',
      }],
    },
    { channel: 'local-knowledge-connector:revoke', args: ['obsidian-vault-1'] },
  ])
})

test('local preload exposes cancellable read-only run lifecycle subscriptions', () => {
  const { api, invocations, listeners } = loadPreload('file:')
  const finished = []
  const events = []
  const opened = []
  const cancelFinished = api.localWorkspace.onRunFinished(result => finished.push(result))
  const cancelEvent = api.localWorkspace.onRunEvent(event => events.push(event))
  const cancelOpened = api.localWorkspace.onOpenGroup(request => opened.push(request))

  listeners.get('local-workspace:run-finished')({}, {
    groupId: 'group-1', status: 'completed',
  })
  listeners.get('local-workspace:run-event')({}, {
    runId: 'run-1', agentRunId: 'agent-1', type: 'status', status: 'running',
  })
  listeners.get('local-workspace:open-group')({}, { groupId: 'group-1' })
  assert.deepEqual(finished, [{ groupId: 'group-1', status: 'completed' }])
  assert.deepEqual(events, [{
    runId: 'run-1', agentRunId: 'agent-1', type: 'status', status: 'running',
  }])
  assert.deepEqual(opened, [{ groupId: 'group-1' }])
  assert.deepEqual(invocations, [])

  cancelFinished()
  cancelEvent()
  cancelOpened()
  assert.equal(listeners.has('local-workspace:run-finished'), false)
  assert.equal(listeners.has('local-workspace:run-event'), false)
  assert.equal(listeners.has('local-workspace:open-group'), false)
})

test('local preload binds stop requests to the visible run identifier', async () => {
  const { api, invocations } = loadPreload('file:')

  await api.localWorkspace.stop('group-1', 'run-1')

  assert.deepEqual(invocations, [
    { channel: 'local-workspace:stop', args: ['group-1', 'run-1'] },
  ])
})

test('local preload exposes narrow Cloud Agent continuation and cancel methods', async () => {
  const { api, invocations } = loadPreload('file:')

  await api.cloudAgent.provideInput('run-cloud-1', 'question-1', 'release/next')
  await api.cloudAgent.decidePermission('run-cloud-1', 'permission-1', 'approved')
  await api.cloudAgent.cancel('run-cloud-1')

  assert.deepEqual(invocations, [
    {
      channel: 'local-cloud-agent:provide-input',
      args: ['run-cloud-1', 'question-1', 'release/next'],
    },
    {
      channel: 'local-cloud-agent:decide-permission',
      args: ['run-cloud-1', 'permission-1', 'approved'],
    },
    { channel: 'local-cloud-agent:cancel', args: ['run-cloud-1'] },
  ])
})

test('local preload exposes one narrow Adoption recording method', async () => {
  const { api, invocations } = loadPreload('file:')
  const request = {
    artifactId: `artifact-${'a'.repeat(64)}`,
    status: 'exported',
    evidenceIds: [],
    findingIds: [],
    destinationRef: { kind: 'workspace-relative', path: 'exports/report.md' },
    previousAdoptionId: null,
  }

  await api.localOutcome.recordAdoption(request)

  assert.deepEqual(invocations, [{
    channel: 'local-outcome:record-adoption',
    args: [request],
  }])
})

test('local preload exposes narrow Human Gate and per-Agent control requests', async () => {
  const { api, invocations } = loadPreload('file:')
  const gateId = `human-gate-${'a'.repeat(64)}`

  await api.localWorkspace.controlAgent('group-1', 'run-1', 'hermes', 'retry')
  await api.localWorkspace.controlAgent('group-1', 'run-1', 'hermes', 'replace', 'codex')
  await api.localWorkspace.decideHumanGate(gateId, {
    status: 'approved', optionId: 'allow-once',
  })

  assert.deepEqual(invocations, [
    {
      channel: 'local-workspace:control-agent',
      args: ['group-1', 'run-1', 'hermes', 'retry', ''],
    },
    {
      channel: 'local-workspace:control-agent',
      args: ['group-1', 'run-1', 'hermes', 'replace', 'codex'],
    },
    {
      channel: 'local-workspace:decide-human-gate',
      args: [gateId, { status: 'approved', optionId: 'allow-once' }],
    },
  ])
})

test('local preload exposes only the narrow Agent installer methods', async () => {
  const { api, invocations } = loadPreload('file:')

  assert.equal(Object.isFrozen(api.agentInstaller), true)
  assert.deepEqual(
    Object.keys(api.agentInstaller).sort(),
    ['cancel', 'catalog', 'onChanged', 'setSidebarVisibility', 'skills', 'start', 'state'],
  )
  await api.agentInstaller.skills('codex')
  await api.agentInstaller.setSidebarVisibility('hermes', true)
  assert.deepEqual(invocations, [
    { channel: 'local-agent-installer:skills', args: ['codex'] },
    { channel: 'local-agent-installer:set-sidebar-visibility', args: ['hermes', true] },
  ])
})

test('WorkBuddy preload exposes only native model listing and ID selection', async () => {
  const { api, invocations } = loadPreload('file:')
  assert.equal(Object.isFrozen(api.workBuddy), true)
  assert.deepEqual(Object.keys(api.workBuddy).sort(), ['setModel', 'settings'])
  await api.workBuddy.settings()
  await api.workBuddy.setModel('text')
  assert.deepEqual(invocations, [
    { channel: 'local-workbuddy:settings', args: [] },
    { channel: 'local-workbuddy:set-model', args: ['text'] },
  ])
})

test('work preferences preload exposes only local get and save', async () => {
  const { api, invocations } = loadPreload('file:')
  assert.equal(Object.isFrozen(api.workPreferences), true)
  assert.deepEqual(Object.keys(api.workPreferences).sort(), ['get', 'save'])
  await api.workPreferences.get()
  await api.workPreferences.save({ detail: 'concise' })
  assert.deepEqual(invocations, [
    { channel: 'local-work-preferences:get', args: [] },
    { channel: 'local-work-preferences:save', args: [{ detail: 'concise' }] },
  ])
})

test('local preload exposes only review and revocation for Skill trust', async () => {
  const { api, invocations } = loadPreload('file:')
  const bindingId = `skill-trust-binding-${'a'.repeat(64)}`

  assert.equal(Object.isFrozen(api.localSkillTrust), true)
  assert.deepEqual(Object.keys(api.localSkillTrust).sort(), ['list', 'revoke'])
  await api.localSkillTrust.list()
  await api.localSkillTrust.revoke(bindingId)
  assert.deepEqual(invocations, [
    { channel: 'local-skill-trust:list', args: [] },
    { channel: 'local-skill-trust:revoke', args: [bindingId] },
  ])
})

test('local preload exposes only create and delete for Custom Agents', async () => {
  const { api, invocations } = loadPreload('file:')

  assert.equal(Object.isFrozen(api.customAgent), true)
  assert.deepEqual(Object.keys(api.customAgent).sort(), ['create', 'delete'])
  assert.equal('list' in api.customAgent, false)
  assert.equal('run' in api.customAgent, false)
  assert.equal('pickExecutable' in api.customAgent, false)

  await api.customAgent.create({
    label: 'Review Agent',
    description: 'Reviews changes.',
    args: ['review'],
    promptMode: 'stdin',
  })
  await api.customAgent.delete('custom-0123456789abcdef')

  assert.deepEqual(invocations, [
    {
      channel: 'local-custom-agent:create',
      args: [{
        label: 'Review Agent',
        description: 'Reviews changes.',
        args: ['review'],
        promptMode: 'stdin',
      }],
    },
    {
      channel: 'local-custom-agent:delete',
      args: ['custom-0123456789abcdef'],
    },
  ])
})

test('local preload exposes attachment import and open without filesystem read or path resolution', async () => {
  const { api, invocations } = loadPreload('file:')

  assert.equal(Object.isFrozen(api.localAttachments), true)
  assert.deepEqual(
    Object.keys(api.localAttachments).sort(),
    ['discard', 'importAttachment', 'open', 'pickAttachments', 'preview'],
  )
  assert.equal('read' in api.localAttachments, false)
  assert.equal('resolve' in api.localAttachments, false)
  const bytes = Uint8Array.from([1, 2, 3])
  await api.localAttachments.pickAttachments(2)
  await api.localAttachments.importAttachment({
    name: 'diagram.png', mimeType: 'image/png', bytes,
  })
  bytes[0] = 9
  const documentBytes = Uint8Array.from(Buffer.from('%PDF-1.7'))
  await api.localAttachments.importAttachment({
    name: 'brief.pdf', mimeType: 'application/pdf', bytes: documentBytes,
  })
  documentBytes[0] = 0
  const archiveBytes = Uint8Array.from(Buffer.from('PK\u0003\u0004archive'))
  await api.localAttachments.importAttachment({
    name: 'source.zip', mimeType: 'application/zip', bytes: archiveBytes,
  })
  archiveBytes[0] = 0
  await api.localAttachments.preview('attachment-1')
  await api.localAttachments.open('attachment-1')
  await api.localAttachments.discard(['attachment-1'])
  assert.deepEqual(invocations, [
    { channel: 'local-attachments:pick', args: [2] },
    {
      channel: 'local-attachments:import',
      args: [{ name: 'diagram.png', mimeType: 'image/png', bytes: Uint8Array.from([1, 2, 3]) }],
    },
    {
      channel: 'local-attachments:import',
      args: [{
        name: 'brief.pdf',
        mimeType: 'application/pdf',
        bytes: Uint8Array.from(Buffer.from('%PDF-1.7')),
      }],
    },
    {
      channel: 'local-attachments:import',
      args: [{
        name: 'source.zip',
        mimeType: 'application/zip',
        bytes: Uint8Array.from(Buffer.from('PK\u0003\u0004archive')),
      }],
    },
    { channel: 'local-attachments:preview', args: ['attachment-1'] },
    { channel: 'local-attachments:open', args: ['attachment-1'] },
    { channel: 'local-attachments:discard', args: [['attachment-1']] },
  ])
})

test('local preload rejects unbounded or unsupported renderer attachment payloads before IPC', async () => {
  const { api, invocations } = loadPreload('file:')

  assert.throws(
    () => api.localAttachments.importAttachment({
      name: 'array.png', mimeType: 'image/png', bytes: [1, 2, 3],
    }),
    { code: 'LOCAL_ATTACHMENT_BYTES_INVALID' },
  )
  await api.localAttachments.importAttachment({
    name: 'animation.gif', mimeType: 'image/gif', bytes: Uint8Array.from([1]),
  })
  await api.localAttachments.importAttachment({
    name: 'preview.webp', mimeType: 'image/webp', bytes: Uint8Array.from([1]),
  })
  assert.throws(
    () => api.localAttachments.importAttachment({
      name: 'large.png', mimeType: 'image/png', bytes: new Uint8Array((8 * 1024 * 1024) + 1),
    }),
    { code: 'LOCAL_ATTACHMENT_TOO_LARGE' },
  )
  assert.deepEqual(invocations, [
    {
      channel: 'local-attachments:import',
      args: [{ name: 'animation.gif', mimeType: 'image/gif', bytes: Uint8Array.from([1]) }],
    },
    {
      channel: 'local-attachments:import',
      args: [{ name: 'preview.webp', mimeType: 'image/webp', bytes: Uint8Array.from([1]) }],
    },
  ])
})

test('remote preload does not expose local credentials, workspace, or installer APIs', () => {
  const { api, exposedName } = loadPreload('https:')

  assert.equal(exposedName, 'meldworkDesktop')
  assert.equal(api.isDesktop, true)
  assert.equal(api.localOnly, true)
  assert.equal('getAuthToken' in api, false)
  assert.equal('localWorkspace' in api, false)
  assert.equal('workBuddy' in api, false)
  assert.equal('workPreferences' in api, false)
  assert.equal('cloudAgent' in api, false)
  assert.equal('localOutcome' in api, false)
  assert.equal('agentInstaller' in api, false)
  assert.equal('localSkillTrust' in api, false)
  assert.equal('customAgent' in api, false)
  assert.equal('localAttachments' in api, false)
  assert.equal('localAgentProvider' in api, false)
  assert.equal('localKnowledgeBase' in api, false)
})

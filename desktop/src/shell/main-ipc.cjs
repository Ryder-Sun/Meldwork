const { ADOPTION_ACTION_STATUSES } = require('../collaboration/outcome-records.cjs')
const { statusForHumanGateOption } = require('../gates/human-gate-coordinator.cjs')
const { ATTACHMENT_FILE_EXTENSIONS } = require('../attachments/attachment-records.cjs')
const { registerDeliveryIpc } = require('./delivery-ipc.cjs')

const LOCAL_GROUP_IDENTIFIER = /^[^\u0000-\u001f\u007f]{1,100}$/u
const LOCAL_RUN_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const LOCAL_AGENT_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/
const HUMAN_GATE_IDENTIFIER = /^human-gate-[a-f0-9]{64}$/
const HUMAN_GATE_OPTION_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const ARTIFACT_IDENTIFIER = /^artifact-[a-f0-9]{64}$/
const EVIDENCE_IDENTIFIER = /^evidence-[a-f0-9]{64}$/
const REVIEWER_FINDING_IDENTIFIER = /^reviewer-finding-[a-f0-9]{64}$/
const ADOPTION_IDENTIFIER = /^adoption-[a-f0-9]{64}$/
const AGENT_CONTROL_ACTIONS = new Set(['cancel', 'retry', 'replace'])
const ADOPTION_STATUS_SET = new Set(ADOPTION_ACTION_STATUSES)
const ADOPTION_REQUEST_KEYS = new Set([
  'artifactId', 'destinationRef', 'evidenceIds', 'findingIds',
  'previousAdoptionId', 'status', 'summary',
])
const MAX_CLOUD_INPUT_BYTES = 64 * 1024

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function normalizeWorkspaceProtocol(input) {
  if (!isPlainObject(input)) return input
  const selected = []
  if (Object.hasOwn(input, 'protocol')) {
    if (!['legacy', 'v4'].includes(input.protocol)) {
      throw new Error('LOCAL_MESSAGE_PROTOCOL_INVALID')
    }
    selected.push(input.protocol)
  }
  for (const key of ['harnessVersion', 'collaborationVersion']) {
    if (!Object.hasOwn(input, key)) continue
    if (![3, 4].includes(input[key])) throw new Error('LOCAL_MESSAGE_PROTOCOL_INVALID')
    selected.push(input[key] === 4 ? 'v4' : 'legacy')
  }
  if (Object.hasOwn(input, 'v4')) {
    if (typeof input.v4 !== 'boolean') throw new Error('LOCAL_MESSAGE_PROTOCOL_INVALID')
    selected.push(input.v4 ? 'v4' : 'legacy')
  }
  if (new Set(selected).size > 1) throw new Error('LOCAL_MESSAGE_PROTOCOL_INVALID')
  const normalized = { ...input, protocol: selected[0] || 'legacy' }
  delete normalized.harnessVersion
  delete normalized.collaborationVersion
  delete normalized.v4
  return normalized
}

function boundedIds(value, pattern) {
  return Array.isArray(value) && value.length <= 64
    && new Set(value).size === value.length
    && value.every(item => typeof item === 'string' && pattern.test(item))
}

function adoptionDestination(value) {
  if (!isPlainObject(value)) return null
  const keys = Reflect.ownKeys(value)
  if (value.kind === 'workspace-relative'
      && keys.length === 2 && keys.includes('kind') && keys.includes('path')
      && typeof value.path === 'string') {
    return { kind: value.kind, path: value.path }
  }
  if (value.kind === 'uri'
      && keys.length === 2 && keys.includes('kind') && keys.includes('uri')
      && typeof value.uri === 'string') {
    return { kind: value.kind, uri: value.uri }
  }
  return null
}

function normalizeAdoptionRequest(input) {
  if (!isPlainObject(input)
      || Reflect.ownKeys(input).some(key => (
        typeof key !== 'string' || !ADOPTION_REQUEST_KEYS.has(key)
      ))
      || !ARTIFACT_IDENTIFIER.test(String(input.artifactId || ''))
      || !ADOPTION_STATUS_SET.has(input.status)
      || !Object.hasOwn(input, 'destinationRef')
      || (Object.hasOwn(input, 'summary')
        && (typeof input.summary !== 'string' || !input.summary || input.summary.length > 4000))
      || (Object.hasOwn(input, 'evidenceIds')
        && !boundedIds(input.evidenceIds, EVIDENCE_IDENTIFIER))
      || (Object.hasOwn(input, 'findingIds')
        && !boundedIds(input.findingIds, REVIEWER_FINDING_IDENTIFIER))
      || (Object.hasOwn(input, 'previousAdoptionId')
        && input.previousAdoptionId !== null
        && !ADOPTION_IDENTIFIER.test(String(input.previousAdoptionId || '')))) {
    throw new Error('LOCAL_ADOPTION_REQUEST_INVALID')
  }
  const destinationRef = Object.hasOwn(input, 'destinationRef')
    ? adoptionDestination(input.destinationRef)
    : null
  if (Object.hasOwn(input, 'destinationRef') && !destinationRef) {
    throw new Error('LOCAL_ADOPTION_REQUEST_INVALID')
  }
  return {
    artifactId: input.artifactId,
    status: input.status,
    ...(Object.hasOwn(input, 'summary') ? { summary: input.summary } : {}),
    evidenceIds: Object.hasOwn(input, 'evidenceIds') ? input.evidenceIds : [],
    findingIds: Object.hasOwn(input, 'findingIds') ? input.findingIds : [],
    ...(destinationRef ? { destinationRef } : {}),
    previousAdoptionId: Object.hasOwn(input, 'previousAdoptionId')
      ? input.previousAdoptionId
      : null,
  }
}

function sanitizeAdoptionSnapshot(record) {
  if (!isPlainObject(record)
      || !ADOPTION_IDENTIFIER.test(String(record.adoptionId || ''))
      || !ARTIFACT_IDENTIFIER.test(String(record.artifactId || ''))
      || !ADOPTION_STATUS_SET.has(record.status)
      || (record.previousAdoptionId !== null
        && !ADOPTION_IDENTIFIER.test(String(record.previousAdoptionId || '')))) {
    throw new Error('LOCAL_ADOPTION_RESPONSE_INVALID')
  }
  return {
    adoptionId: record.adoptionId,
    artifactId: record.artifactId,
    status: record.status,
    previousAdoptionId: record.previousAdoptionId,
  }
}

function sanitizeCloudAgentSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('CLOUD_AGENT_RESPONSE_INVALID')
  }
  const stringValue = value => (typeof value === 'string' ? value : '')
  const stringIds = value => (Array.isArray(value)
    ? value.filter(item => typeof item === 'string')
    : [])
  let waiting = null
  if (snapshot.waiting?.type === 'input') {
    waiting = {
      type: 'input',
      requestId: stringValue(snapshot.waiting.requestId),
      prompt: stringValue(snapshot.waiting.prompt),
    }
  } else if (snapshot.waiting?.type === 'permission') {
    waiting = {
      type: 'permission',
      requestId: stringValue(snapshot.waiting.requestId),
      permission: stringValue(snapshot.waiting.permission),
      summary: stringValue(snapshot.waiting.summary),
    }
  }
  return {
    runId: stringValue(snapshot.runId),
    agentRunId: stringValue(snapshot.agentRunId),
    status: stringValue(snapshot.status),
    connectorId: stringValue(snapshot.connectorId),
    artifactIds: stringIds(snapshot.artifactIds),
    evidenceIds: stringIds(snapshot.evidenceIds),
    waiting,
  }
}

function registerDesktopIpc(options) {
  registerDeliveryIpc(options)
  const {
    app,
    attachmentIdsFromSnapshot,
    attachments,
    customAgentStore,
    dialog,
    getAttachmentStore,
    getAgentConnectors,
    getCloudAgentRuntime,
    getCloudAgentBridges,
    getKnowledgeConnectors,
    getMainWindow,
    getOutcomeStore,
    getSkillTrustStore,
    getWorkspace,
    getWorkBuddySettings,
    installer,
    isShutdownStarted,
    knowledgeBaseStore,
    knowledgeBaseGuideUrl,
    loadKnowledgeBaseSources,
    localAgentCatalog,
    openExternalUrl,
    refreshLocalAgentState,
    registerTrustedHandle,
    skillCatalog,
  } = options

  registerTrustedHandle('local-workspace:get', () => {
    const workspace = getWorkspace()
    if (!workspace) throw new Error('LOCAL_WORKSPACE_UNAVAILABLE')
    return workspace.snapshot()
  })
  registerTrustedHandle('local-workspace:refresh-agents', async () => {
    const workspace = getWorkspace()
    if (!workspace) throw new Error('LOCAL_WORKSPACE_UNAVAILABLE')
    installer.invalidateDetectionCache()
    skillCatalog?.invalidate()
    return refreshLocalAgentState()
  })
  registerTrustedHandle('local-workspace:create-group', (input) => {
    const workspace = getWorkspace()
    if (!workspace) throw new Error('LOCAL_WORKSPACE_UNAVAILABLE')
    return workspace.createGroup(input || {})
  })
  registerTrustedHandle('local-workspace:update-group', (groupId, input) => {
    const workspace = getWorkspace()
    if (!workspace) throw new Error('LOCAL_WORKSPACE_UNAVAILABLE')
    return workspace.updateGroup(String(groupId || ''), input || {})
  })
  registerTrustedHandle('local-workspace:delete-group', (groupId) => {
    const workspace = getWorkspace()
    if (!workspace) throw new Error('LOCAL_WORKSPACE_UNAVAILABLE')
    const normalizedGroupId = String(groupId || '')
    const candidates = attachmentIdsFromSnapshot(workspace.snapshot(), normalizedGroupId)
    workspace.deleteGroup(normalizedGroupId)
    const snapshot = workspace.snapshot()
    if (getAttachmentStore() && candidates.length) {
      try { attachments.discardUnreferenced(candidates, Number.POSITIVE_INFINITY) } catch { /* startup cleanup retries */ }
    }
    return snapshot
  })
  registerTrustedHandle('local-workspace:delete-message', (groupId, messageId) => {
    const workspace = getWorkspace()
    if (!workspace) throw new Error('LOCAL_WORKSPACE_UNAVAILABLE')
    const normalizedGroupId = String(groupId || '')
    const normalizedMessageId = String(messageId || '')
    const beforeMessages = [...workspace.snapshot().messages]
    workspace.deleteMessage(normalizedGroupId, normalizedMessageId)
    const snapshot = workspace.snapshot()
    if (getAttachmentStore()) {
      const retainedMessageIds = new Set(snapshot.messages.map(message => message.id))
      const deletedMessages = beforeMessages.filter(message => !retainedMessageIds.has(message.id))
      const candidates = attachmentIdsFromSnapshot({ messages: deletedMessages })
      if (candidates.length) {
        try { attachments.discardUnreferenced(candidates, Number.POSITIVE_INFINITY) } catch { /* startup cleanup retries */ }
      }
    }
    return snapshot
  })
  registerTrustedHandle('local-workspace:send', async (input) => {
    const workspace = getWorkspace()
    if (!workspace) throw new Error('LOCAL_WORKSPACE_UNAVAILABLE')
    const normalizedInput = normalizeWorkspaceProtocol(input)
    if ((!Array.isArray(normalizedInput?.targetKinds) || !normalizedInput.targetKinds.length)
        && normalizedInput?.routingMode !== 'automatic') {
      throw new Error('LOCAL_MESSAGE_TARGET_REQUIRED')
    }
    return workspace.sendMessage(normalizedInput)
  })
  registerTrustedHandle('local-workspace:stop', (groupId, runId) => {
    const workspace = getWorkspace()
    if (!workspace) return false
    const normalizedGroupId = String(groupId || '')
    const normalizedRunId = String(runId || '')
    if (!LOCAL_GROUP_IDENTIFIER.test(normalizedGroupId)
        || !LOCAL_RUN_IDENTIFIER.test(normalizedRunId)) return false
    return workspace.stop(normalizedGroupId, normalizedRunId)
  })
  registerTrustedHandle('local-workspace:control-agent', (
    groupId, runId, kind, action, replacementKind = '',
  ) => {
    const workspace = getWorkspace()
    if (!workspace) return false
    const normalizedGroupId = String(groupId || '')
    const normalizedRunId = String(runId || '')
    const normalizedKind = String(kind || '')
    const normalizedAction = String(action || '')
    const normalizedReplacement = String(replacementKind || '')
    if (!LOCAL_GROUP_IDENTIFIER.test(normalizedGroupId)
        || !LOCAL_RUN_IDENTIFIER.test(normalizedRunId)
        || !LOCAL_AGENT_IDENTIFIER.test(normalizedKind)
        || !AGENT_CONTROL_ACTIONS.has(normalizedAction)
        || (normalizedAction === 'replace'
          ? (!LOCAL_AGENT_IDENTIFIER.test(normalizedReplacement)
            || normalizedReplacement === normalizedKind)
          : Boolean(normalizedReplacement))) return false
    return workspace.controlAgent(
      normalizedGroupId,
      normalizedRunId,
      normalizedKind,
      normalizedAction,
      normalizedReplacement,
    )
  })
  registerTrustedHandle('local-workspace:decide-human-gate', (gateId, decision) => {
    const workspace = getWorkspace()
    if (!workspace) throw new Error('LOCAL_WORKSPACE_UNAVAILABLE')
    const normalizedGateId = String(gateId || '')
    const optionId = typeof decision?.optionId === 'string' ? decision.optionId : ''
    const hasResponse = Object.hasOwn(decision || {}, 'response')
    const response = hasResponse && typeof decision.response === 'string'
      ? decision.response.trim()
      : ''
    const hasStatus = Object.hasOwn(decision || {}, 'status')
    const requestedStatus = hasStatus ? decision.status : ''
    if (!HUMAN_GATE_IDENTIFIER.test(normalizedGateId)
        || !HUMAN_GATE_OPTION_IDENTIFIER.test(optionId)
        || !isPlainObject(decision)
        || (hasStatus && !['approved', 'rejected'].includes(requestedStatus))
        || (hasResponse && (!response || response.length > 32 * 1024))
        || Reflect.ownKeys(decision).some(key => !['status', 'optionId', 'response'].includes(key))) {
      throw new Error('HUMAN_GATE_DECISION_INVALID')
    }
    const gates = workspace.listHumanGates()
    const gate = Array.isArray(gates)
      ? gates.find(candidate => candidate.gateId === normalizedGateId)
      : null
    const option = gate?.options?.find(candidate => candidate.optionId === optionId)
    let status = ''
    try { status = statusForHumanGateOption(option) } catch {}
    if (!status || (hasStatus && requestedStatus !== status)) {
      throw new Error('HUMAN_GATE_DECISION_INVALID')
    }
    if ((gate?.type === 'input' && status === 'approved' && !response)
        || (gate?.type !== 'input' && hasResponse)
        || (status !== 'approved' && hasResponse)) {
      throw new Error('HUMAN_GATE_DECISION_INVALID')
    }
    return workspace.decideHumanGate(normalizedGateId, {
      status, optionId, ...(response ? { response } : {}),
    })
  })
  registerTrustedHandle('local-cloud-agent:provide-input', (runId, requestId, value) => {
    const runtime = getCloudAgentRuntime?.()
    const normalizedRunId = String(runId || '')
    const normalizedRequestId = String(requestId || '')
    if (!runtime) throw new Error('CLOUD_AGENT_RUNTIME_UNAVAILABLE')
    if (!LOCAL_RUN_IDENTIFIER.test(normalizedRunId)
        || !LOCAL_RUN_IDENTIFIER.test(normalizedRequestId)
        || typeof value !== 'string' || !value || value.includes('\u0000')
        || Buffer.byteLength(value) > MAX_CLOUD_INPUT_BYTES) {
      throw new Error('CLOUD_AGENT_INPUT_INVALID')
    }
    return Promise.resolve(runtime.provideInput(normalizedRunId, normalizedRequestId, value))
      .then(sanitizeCloudAgentSnapshot)
  })
  registerTrustedHandle('local-cloud-agent:decide-permission', (runId, requestId, decision) => {
    const runtime = getCloudAgentRuntime?.()
    const normalizedRunId = String(runId || '')
    const normalizedRequestId = String(requestId || '')
    const normalizedDecision = String(decision || '')
    if (!runtime) throw new Error('CLOUD_AGENT_RUNTIME_UNAVAILABLE')
    if (!LOCAL_RUN_IDENTIFIER.test(normalizedRunId)
        || !LOCAL_RUN_IDENTIFIER.test(normalizedRequestId)
        || !['approved', 'rejected'].includes(normalizedDecision)) {
      throw new Error('CLOUD_AGENT_PERMISSION_DECISION_INVALID')
    }
    return Promise.resolve(runtime.decidePermission(
      normalizedRunId, normalizedRequestId, normalizedDecision,
    )).then(sanitizeCloudAgentSnapshot)
  })
  registerTrustedHandle('local-cloud-agent:cancel', (runId) => {
    const runtime = getCloudAgentRuntime?.()
    const normalizedRunId = String(runId || '')
    if (!runtime) throw new Error('CLOUD_AGENT_RUNTIME_UNAVAILABLE')
    if (!LOCAL_RUN_IDENTIFIER.test(normalizedRunId)) throw new Error('CLOUD_AGENT_RUN_INVALID')
    return runtime.cancel(normalizedRunId)
  })
  registerTrustedHandle('local-cloud-agent-bridge:list', (...args) => {
    if (args.length) throw new Error('CLOUD_AGENT_BRIDGE_REQUEST_INVALID')
    const bridges = getCloudAgentBridges?.()
    if (!bridges) throw new Error('CLOUD_AGENT_BRIDGE_RUNTIME_UNAVAILABLE')
    return bridges.list()
  })
  registerTrustedHandle('local-cloud-agent-bridge:connect', async (...args) => {
    if (args.length !== 1 || !args[0] || typeof args[0] !== 'object'
        || Array.isArray(args[0])
        || Reflect.ownKeys(args[0]).some(key => !['address', 'label'].includes(key))
        || typeof args[0].address !== 'string'
        || (args[0].label !== undefined && typeof args[0].label !== 'string')) {
      throw new Error('CLOUD_AGENT_BRIDGE_REQUEST_INVALID')
    }
    const bridges = getCloudAgentBridges?.()
    if (!bridges) throw new Error('CLOUD_AGENT_BRIDGE_RUNTIME_UNAVAILABLE')
    const result = await bridges.connect(args[0])
    await refreshLocalAgentState()
    return result
  })
  registerTrustedHandle('local-cloud-agent-bridge:refresh', async (...args) => {
    if (args.length) throw new Error('CLOUD_AGENT_BRIDGE_REQUEST_INVALID')
    const bridges = getCloudAgentBridges?.()
    if (!bridges) throw new Error('CLOUD_AGENT_BRIDGE_RUNTIME_UNAVAILABLE')
    const result = await bridges.refresh()
    await refreshLocalAgentState()
    return result
  })
  registerTrustedHandle('local-cloud-agent-bridge:delete', async (...args) => {
    if (args.length !== 1 || typeof args[0] !== 'string') {
      throw new Error('CLOUD_AGENT_BRIDGE_REQUEST_INVALID')
    }
    const bridges = getCloudAgentBridges?.()
    if (!bridges) throw new Error('CLOUD_AGENT_BRIDGE_RUNTIME_UNAVAILABLE')
    const result = bridges.remove(args[0])
    await refreshLocalAgentState()
    return result
  })
  registerTrustedHandle('local-outcome:record-adoption', (...args) => {
    if (args.length !== 1) throw new Error('LOCAL_ADOPTION_REQUEST_INVALID')
    const outcomeStore = getOutcomeStore?.()
    if (!outcomeStore || typeof outcomeStore.recordHumanAdoption !== 'function') {
      throw new Error('LOCAL_OUTCOME_STORE_UNAVAILABLE')
    }
    return sanitizeAdoptionSnapshot(
      outcomeStore.recordHumanAdoption(normalizeAdoptionRequest(args[0])),
    )
  })
  registerTrustedHandle('local-workspace:pick-directory', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? '' : result.filePaths[0]
  })
  registerTrustedHandle('local-workspace:default-directory', () => app.getPath('documents'))
  registerTrustedHandle('local-agent-installer:catalog', async () => localAgentCatalog())
  registerTrustedHandle('local-workbuddy:settings', () => getWorkBuddySettings())
  registerTrustedHandle('local-workbuddy:set-model', async (...args) => {
    if (args.length !== 1 || typeof args[0] !== 'string' || args[0].length > 120) {
      throw new Error('LOCAL_WORKBUDDY_MODEL_UNAVAILABLE')
    }
    const workspace = getWorkspace()
    if (!workspace) throw new Error('LOCAL_WORKSPACE_UNAVAILABLE')
    const modelId = args[0]
    const settings = await getWorkBuddySettings()
    if (modelId && !settings.models.some(model => model.id === modelId)) {
      throw new Error('LOCAL_WORKBUDDY_MODEL_UNAVAILABLE')
    }
    if (workspace.activeRuns.size || workspace.preparingRuns?.size) {
      throw new Error('LOCAL_WORKBUDDY_BUSY')
    }
    const before = workspace.state.agentPreferences.workbuddy
    const runtime = workspace.state.agentRuntime.workbuddy
    workspace.state.agentPreferences.workbuddy = { ...before, modelId }
    delete workspace.state.agentRuntime.workbuddy
    try { workspace.save() } catch (error) {
      if (before) workspace.state.agentPreferences.workbuddy = before
      else delete workspace.state.agentPreferences.workbuddy
      if (runtime) workspace.state.agentRuntime.workbuddy = runtime
      throw error
    }
    await refreshLocalAgentState()
    return { ...settings, modelId }
  })
  registerTrustedHandle('local-agent-installer:skills', async (kind) => {
    const selectedKind = String(kind || '')
    if (customAgentStore.has(selectedKind)) {
      return { supported: false, skills: [], total: 0, limit: 0 }
    }
    const cloudSkills = getCloudAgentBridges?.()?.skillsForInstance?.(selectedKind)
    if (cloudSkills !== null && cloudSkills !== undefined) {
      const skills = cloudSkills.map(skill => ({ ...skill, targetKind: selectedKind }))
      return { supported: true, skills, total: skills.length, limit: 64 }
    }
    return installer.skills(selectedKind)
  })
  registerTrustedHandle('local-skill-trust:list', () => {
    const store = getSkillTrustStore?.()
    if (!store) throw new Error('LOCAL_SKILL_TRUST_STORE_UNAVAILABLE')
    return store.list()
  })
  registerTrustedHandle('local-skill-trust:revoke', (...args) => {
    if (args.length !== 1 || typeof args[0] !== 'string') {
      throw new Error('LOCAL_SKILL_TRUST_REQUEST_INVALID')
    }
    const store = getSkillTrustStore?.()
    if (!store) throw new Error('LOCAL_SKILL_TRUST_STORE_UNAVAILABLE')
    return store.revoke(args[0])
  })
  registerTrustedHandle('local-agent-installer:state', () => installer.state())
  registerTrustedHandle('local-agent-installer:start', kind => installer.start(String(kind || '')))
  registerTrustedHandle('local-agent-installer:cancel', taskId => installer.cancel(String(taskId || '')))
  registerTrustedHandle('local-agent-installer:set-sidebar-visibility', (kind, visible) => {
    const workspace = getWorkspace()
    if (!workspace) throw new Error('LOCAL_WORKSPACE_UNAVAILABLE')
    return workspace.setSidebarVisibility(String(kind || ''), visible === true)
  })
  registerTrustedHandle('local-custom-agent:create', async (input) => {
    const locale = String(app.getLocale?.() || '').toLowerCase()
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: locale.startsWith('zh') ? '选择 Agent CLI 可执行文件' : 'Choose Agent CLI executable',
      properties: ['openFile'],
    })
    if (isShutdownStarted()) throw new Error('DESKTOP_CLIENT_SHUTTING_DOWN')
    if (result.canceled || !result.filePaths[0]) return { canceled: true }
    const agent = customAgentStore.create({
      label: input?.label,
      description: input?.description,
      args: input?.args,
      promptMode: input?.promptMode,
    }, result.filePaths[0])
    await refreshLocalAgentState()
    return { canceled: false, agent }
  })
  registerTrustedHandle('local-custom-agent:delete', async (kind) => {
    const selectedKind = String(kind || '')
    const referenced = (getWorkspace()?.snapshot().groups || []).some(group => (
      group?.directAgentKind === selectedKind
      || (Array.isArray(group?.agentKinds) && group.agentKinds.includes(selectedKind))
    ))
    if (referenced) throw new Error('CUSTOM_AGENT_IN_USE')
    customAgentStore.remove(selectedKind)
    await refreshLocalAgentState()
    return { deleted: true, kind: selectedKind }
  })
  registerTrustedHandle('local-agent-connector:list', async (...args) => {
    if (args.length) throw new Error('AGENT_CONNECTOR_REQUEST_INVALID')
    const connectors = getAgentConnectors?.()
    if (!connectors) throw new Error('AGENT_CONNECTOR_RUNTIME_UNAVAILABLE')
    connectors.refresh(await installer.detectedAgents())
    return connectors.list()
  })
  registerTrustedHandle('local-agent-connector:packages', (...args) => {
    if (args.length) throw new Error('AGENT_CONNECTOR_REQUEST_INVALID')
    const connectors = getAgentConnectors?.()
    if (!connectors) throw new Error('AGENT_CONNECTOR_RUNTIME_UNAVAILABLE')
    return connectors.packages()
  })
  registerTrustedHandle('local-agent-connector:import', async (...args) => {
    if (args.length) throw new Error('AGENT_CONNECTOR_REQUEST_INVALID')
    const connectors = getAgentConnectors?.()
    if (!connectors) throw new Error('AGENT_CONNECTOR_RUNTIME_UNAVAILABLE')
    const locale = String(app.getLocale?.() || '').toLowerCase()
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: locale.startsWith('zh') ? '导入 Agent Connector 包' : 'Import Agent Connector package',
      properties: ['openFile'],
      filters: [{ name: 'Agent Connector', extensions: ['json'] }],
    })
    if (isShutdownStarted()) throw new Error('DESKTOP_CLIENT_SHUTTING_DOWN')
    if (result.canceled || !result.filePaths[0]) return { canceled: true }
    return { canceled: false, package: connectors.importPackageFile(result.filePaths[0]) }
  })
  registerTrustedHandle('local-agent-connector:inspect', (...args) => {
    if (args.length !== 1 || typeof args[0] !== 'string') {
      throw new Error('AGENT_CONNECTOR_REQUEST_INVALID')
    }
    const connectors = getAgentConnectors?.()
    if (!connectors) throw new Error('AGENT_CONNECTOR_RUNTIME_UNAVAILABLE')
    return connectors.inspectPackage(args[0])
  })
  registerTrustedHandle('local-agent-connector:audit', (...args) => {
    if (args.length !== 1 || typeof args[0] !== 'string') {
      throw new Error('AGENT_CONNECTOR_REQUEST_INVALID')
    }
    const connectors = getAgentConnectors?.()
    if (!connectors) throw new Error('AGENT_CONNECTOR_RUNTIME_UNAVAILABLE')
    return connectors.auditPackage(args[0])
  })
  registerTrustedHandle('local-agent-connector:approve', async (...args) => {
    if (args.length !== 1 || typeof args[0] !== 'string') {
      throw new Error('AGENT_CONNECTOR_REQUEST_INVALID')
    }
    const connectors = getAgentConnectors?.()
    if (!connectors) throw new Error('AGENT_CONNECTOR_RUNTIME_UNAVAILABLE')
    const inspected = connectors.inspectPackage(args[0])
    const manifest = inspected.manifest
    const locale = String(app.getLocale?.() || '').toLowerCase()
    const slots = manifest.credentials.slots.map(slot => (
      `${slot.slotId} (${slot.type}${slot.required
        ? locale.startsWith('zh') ? '，必填' : ', required'
        : ''})`
    )).join(', ') || (locale.startsWith('zh') ? '无' : 'None')
    const destinations = manifest.outboundDestinations.join(', ')
      || (locale.startsWith('zh') ? '无' : 'None')
    const detail = locale.startsWith('zh')
      ? [
          `发布者：${inspected.publisher.name} (${inspected.publisher.id})`,
          `来源：${inspected.origin.filename}`,
          `来源哈希：${inspected.origin.sha256}`,
          `Connector：${manifest.connectorId} ${manifest.connectorVersion}`,
          `传输：${manifest.transport.type}/${manifest.transport.protocol}`,
          `权限：${manifest.permissionModes.join(', ')}`,
          `凭据槽：${slots}`,
          `外联目标：${destinations}`,
          `SDK Provider：${inspected.provider.id}`,
        ].join('\n')
      : [
          `Publisher: ${inspected.publisher.name} (${inspected.publisher.id})`,
          `Origin: ${inspected.origin.filename}`,
          `Origin hash: ${inspected.origin.sha256}`,
          `Connector: ${manifest.connectorId} ${manifest.connectorVersion}`,
          `Transport: ${manifest.transport.type}/${manifest.transport.protocol}`,
          `Permissions: ${manifest.permissionModes.join(', ')}`,
          `Credential slots: ${slots}`,
          `Outbound destinations: ${destinations}`,
          `SDK provider: ${inspected.provider.id}`,
        ].join('\n')
    const decision = await dialog.showMessageBox(getMainWindow(), {
      type: 'warning',
      title: locale.startsWith('zh') ? '批准 Agent Connector' : 'Approve Agent Connector',
      message: locale.startsWith('zh')
        ? '仅在确认发布者与权限范围后批准。'
        : 'Approve only after verifying the publisher and permission scope.',
      detail,
      buttons: locale.startsWith('zh') ? ['批准', '取消'] : ['Approve', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    if (decision.response !== 0) return { canceled: true }
    return { canceled: false, package: connectors.approvePackage(args[0]) }
  })
  for (const [channel, method] of [
    ['install', 'installPackage'],
    ['disable', 'disablePackage'],
    ['revoke', 'revokePackage'],
    ['upgrade', 'upgradePackage'],
    ['remove', 'removePackage'],
  ]) {
    registerTrustedHandle(`local-agent-connector:${channel}`, async (...args) => {
      if (args.length !== 1 || typeof args[0] !== 'string') {
        throw new Error('AGENT_CONNECTOR_REQUEST_INVALID')
      }
      const connectors = getAgentConnectors?.()
      if (!connectors) throw new Error('AGENT_CONNECTOR_RUNTIME_UNAVAILABLE')
      const result = connectors[method](args[0])
      await refreshLocalAgentState()
      return result
    })
  }
  registerTrustedHandle('local-agent-connector:configure', async (...args) => {
    if (args.length !== 1 || !args[0] || typeof args[0] !== 'object'
        || Array.isArray(args[0])
        || Reflect.ownKeys(args[0]).sort().join(',') !== 'credentials,label,manifestId') {
      throw new Error('AGENT_CONNECTOR_REQUEST_INVALID')
    }
    const connectors = getAgentConnectors?.()
    if (!connectors) throw new Error('AGENT_CONNECTOR_RUNTIME_UNAVAILABLE')
    const input = args[0]
    connectors.refresh(await installer.detectedAgents())
    const result = connectors.configure({
      manifestId: input.manifestId,
      label: input.label,
      credentials: input.credentials === null ? null : input.credentials,
    })
    await refreshLocalAgentState()
    return result
  })
  registerTrustedHandle('local-agent-connector:delete', async (...args) => {
    if (args.length !== 1 || typeof args[0] !== 'string') {
      throw new Error('AGENT_CONNECTOR_REQUEST_INVALID')
    }
    const connectors = getAgentConnectors?.()
    if (!connectors) throw new Error('AGENT_CONNECTOR_RUNTIME_UNAVAILABLE')
    const instanceId = String(args[0] || '')
    const referenced = (getWorkspace()?.snapshot().groups || []).some(group => (
      group?.directAgentKind === instanceId
      || (Array.isArray(group?.agentKinds) && group.agentKinds.includes(instanceId))
    ))
    if (referenced) throw new Error('AGENT_CONNECTOR_INSTANCE_IN_USE')
    const result = connectors.delete(instanceId)
    await refreshLocalAgentState()
    return result
  })
  registerTrustedHandle('local-agent-connector:test', async (...args) => {
    if (args.length !== 1 || typeof args[0] !== 'string') {
      throw new Error('AGENT_CONNECTOR_REQUEST_INVALID')
    }
    const connectors = getAgentConnectors?.()
    if (!connectors) throw new Error('AGENT_CONNECTOR_RUNTIME_UNAVAILABLE')
    connectors.refresh(await installer.detectedAgents())
    return connectors.test(args[0], app.getPath('userData'))
  })
  registerTrustedHandle('local-attachments:pick', async (remainingCapacity) => {
    attachments.availableStore()
    const limit = attachments.normalizePickLimit(remainingCapacity)
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openFile', 'multiSelections'],
      filters: [{
        name: 'Files',
        extensions: ATTACHMENT_FILE_EXTENSIONS,
      }],
    })
    if (isShutdownStarted()) throw new Error('DESKTOP_CLIENT_SHUTTING_DOWN')
    if (result.canceled) return { attachments: [], truncated: false }
    const filenames = result.filePaths.slice(0, limit)
    return {
      attachments: attachments.importFiles(filenames),
      truncated: result.filePaths.length > filenames.length,
    }
  })
  registerTrustedHandle('local-attachments:import', input => attachments.importBuffer(input))
  registerTrustedHandle('local-attachments:preview', id => attachments.preview(String(id || '')))
  registerTrustedHandle('local-attachments:open', id => attachments.open(String(id || '')))
  registerTrustedHandle('local-attachments:discard', ids => attachments.discardUnreferenced(ids))
  registerTrustedHandle('local-knowledge-connector:list', (...args) => {
    if (args.length) throw new Error('LOCAL_KNOWLEDGE_CONNECTOR_REQUEST_INVALID')
    const connectors = getKnowledgeConnectors?.()
    if (!connectors) throw new Error('LOCAL_KNOWLEDGE_CONNECTOR_UNAVAILABLE')
    return connectors.list()
  })
  registerTrustedHandle('local-knowledge-connector:authorize', (...args) => {
    if (args.length !== 1) throw new Error('LOCAL_KNOWLEDGE_CONNECTOR_REQUEST_INVALID')
    const connectors = getKnowledgeConnectors?.()
    if (!connectors) throw new Error('LOCAL_KNOWLEDGE_CONNECTOR_UNAVAILABLE')
    return connectors.authorize(args[0])
  })
  registerTrustedHandle('local-knowledge-connector:revoke', (...args) => {
    if (args.length !== 1) throw new Error('LOCAL_KNOWLEDGE_CONNECTOR_REQUEST_INVALID')
    const connectors = getKnowledgeConnectors?.()
    if (!connectors) throw new Error('LOCAL_KNOWLEDGE_CONNECTOR_UNAVAILABLE')
    return connectors.revoke(args[0])
  })
  registerTrustedHandle('local-knowledge-connector:probe', (...args) => {
    if (args.length !== 1) throw new Error('LOCAL_KNOWLEDGE_CONNECTOR_REQUEST_INVALID')
    const connectors = getKnowledgeConnectors?.()
    if (!connectors) throw new Error('LOCAL_KNOWLEDGE_CONNECTOR_UNAVAILABLE')
    return connectors.probe(args[0])
  })
  registerTrustedHandle('local-knowledge-connector:search', (...args) => {
    if (args.length !== 2) throw new Error('LOCAL_KNOWLEDGE_CONNECTOR_REQUEST_INVALID')
    const connectors = getKnowledgeConnectors?.()
    if (!connectors) throw new Error('LOCAL_KNOWLEDGE_CONNECTOR_UNAVAILABLE')
    return connectors.search(args[0], args[1])
  })
  registerTrustedHandle('local-knowledge-connector:fetch', (...args) => {
    if (args.length !== 2) throw new Error('LOCAL_KNOWLEDGE_CONNECTOR_REQUEST_INVALID')
    const connectors = getKnowledgeConnectors?.()
    if (!connectors) throw new Error('LOCAL_KNOWLEDGE_CONNECTOR_UNAVAILABLE')
    return connectors.fetch(args[0], args[1])
  })
  registerTrustedHandle('local-knowledge-connector:snapshot', (...args) => {
    if (args.length !== 2) throw new Error('LOCAL_KNOWLEDGE_CONNECTOR_REQUEST_INVALID')
    const connectors = getKnowledgeConnectors?.()
    if (!connectors) throw new Error('LOCAL_KNOWLEDGE_CONNECTOR_UNAVAILABLE')
    return connectors.snapshot(args[0], args[1])
  })
  registerTrustedHandle('local-knowledge-connector:citation', (...args) => {
    if (args.length !== 2) throw new Error('LOCAL_KNOWLEDGE_CONNECTOR_REQUEST_INVALID')
    const connectors = getKnowledgeConnectors?.()
    if (!connectors) throw new Error('LOCAL_KNOWLEDGE_CONNECTOR_UNAVAILABLE')
    return connectors.citation(args[0], args[1])
  })
  registerTrustedHandle('local-knowledge-connector:select', (...args) => {
    if (args.length !== 2) throw new Error('LOCAL_KNOWLEDGE_CONNECTOR_REQUEST_INVALID')
    const connectors = getKnowledgeConnectors?.()
    if (!connectors) throw new Error('LOCAL_KNOWLEDGE_CONNECTOR_UNAVAILABLE')
    return connectors.select(args[0], args[1])
  })
  registerTrustedHandle('local-knowledge-base:status', async (kind = '') => (
    loadKnowledgeBaseSources(kind)
  ))
  registerTrustedHandle('local-knowledge-base:open-guide', async (kind, action) => {
    const url = knowledgeBaseGuideUrl(String(kind || ''), String(action || ''))
    if (!url) return false
    return openExternalUrl(url)
  })
  registerTrustedHandle('local-knowledge-base:pick-obsidian-vault', async () => {
    if (!knowledgeBaseStore) throw new Error('LOCAL_KNOWLEDGE_BASE_UNAVAILABLE')
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openDirectory', 'createDirectory'],
    })
    if (isShutdownStarted()) throw new Error('DESKTOP_CLIENT_SHUTTING_DOWN')
    if (result.canceled) return knowledgeBaseStore.state()
    knowledgeBaseStore.saveObsidianVaultPath(result.filePaths[0] || '')
    await getKnowledgeConnectors?.()?.refresh(true)
    return loadKnowledgeBaseSources()
  })
}

module.exports = { registerDesktopIpc }

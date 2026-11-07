const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { detectAttachmentType } = require('../../attachments/attachment-records.cjs')
const { automaticPermissionResponse, READ_ONLY_SAFE_TOOL_KINDS } = require('../agent-permission-policy.cjs')
const { SDK_HTTP_JSON_RECIPE_ID } = require('./agent-connector-package-store.cjs')
const { normalizeSessionRef } = require('../../runs/session-reference.cjs')

const { canonicalJson } = require('../../collaboration/outcome-records.cjs')
const {
  createRunEventState,
  parseConnectorRunEvent,
  reduceRunEvent,
} = require('../../runs/run-event-protocol.cjs')

const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const SHA256 = /^[a-f0-9]{64}$/
const MAX_PROMPT_BYTES = 4 * 1024 * 1024
const MAX_INPUT_RESPONSE_BYTES = 128 * 1024
// Keep this aligned with the workspace message attachment limit.
const MAX_ATTACHMENTS = 32
const OUTBOUND_TRANSPORTS = new Set(['http', 'a2a'])
const ABORTABLE_TRANSPORT_RECIPES = new Set([
  SDK_HTTP_JSON_RECIPE_ID, 'external.cloud-agent-bridge', 'external.cloud-agent-ssh',
])

function runtimeError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function fail(code) {
  throw runtimeError(code)
}

function clone(value) {
  return JSON.parse(canonicalJson(value))
}

function attachmentFileType(filename) {
  if (typeof filename !== 'string' || filename.length > 4096 || !path.isAbsolute(filename)
      || /[\u0000-\u001f\u007f]/.test(filename)) return null
  let fd
  try {
    const initial = fs.lstatSync(filename)
    if (initial.isSymbolicLink() || !initial.isFile()) return null
    fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.dev !== initial.dev || stat.ino !== initial.ino || stat.size > 128 * 1024 * 1024) return null
    const bytes = Buffer.alloc(Math.min(stat.size, 512))
    const size = fs.readSync(fd, bytes, 0, bytes.length, 0)
    return { size: stat.size, detected: detectAttachmentType(bytes.subarray(0, size)) }
  } catch { return null } finally { if (fd !== undefined) fs.closeSync(fd) }
}

function attachmentInputType(attachment) {
  if (typeof attachment === 'string') {
    const file = attachmentFileType(attachment)
    return file && file.size <= 8 * 1024 * 1024 && file.detected?.mimeType.startsWith('image/') ? 'image' : ''
  }
  if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) return ''
  const mimeType = String(attachment.mimeType || attachment.mediaType || '').toLowerCase()
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType) return 'file'
  if (Object.hasOwn(attachment, 'path')) return ''
  const declared = String(attachment.inputType || attachment.type || '')
  if (['image', 'audio', 'video', 'file', 'structured-data'].includes(declared)) {
    return declared
  }
  return ''
}

function validatedAttachments(value, capabilities) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) {
    fail('AGENT_CONNECTOR_ATTACHMENTS_INVALID')
  }
  const attachments = [...value]
  for (const attachment of attachments) {
    if (typeof attachment === 'string' && !capabilities.inputTypes.includes('image')) {
      fail('AGENT_CONNECTOR_ATTACHMENT_UNSUPPORTED')
    }
    const inputType = attachmentInputType(attachment)
    if (!inputType) fail('AGENT_CONNECTOR_ATTACHMENTS_INVALID')
    if (!capabilities.inputTypes.includes(inputType)) {
      fail('AGENT_CONNECTOR_ATTACHMENT_UNSUPPORTED')
    }
    if (attachment && typeof attachment === 'object' && inputType !== 'structured-data'
        && !Object.hasOwn(attachment, 'path')) fail('AGENT_CONNECTOR_ATTACHMENTS_INVALID')
    if (attachment && typeof attachment === 'object' && Object.hasOwn(attachment, 'path')) {
      const file = attachmentFileType(attachment.path)
      const declared = String(attachment.mimeType || attachment.mediaType || '').toLowerCase()
      if (!file || (['image', 'audio', 'video'].includes(inputType)
          && (file.detected?.mimeType !== declared || file.size > file.detected.maxBytes))
          || (inputType === 'file' && /^(?:image|audio|video)\//.test(file.detected?.mimeType || ''))) {
        fail('AGENT_CONNECTOR_ATTACHMENTS_INVALID')
      }
    }
  }
  return attachments
}

function outboundOrigin(value) {
  try {
    const parsed = new URL(String(value || ''))
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return ''
    return parsed.origin
  } catch {
    return ''
  }
}

function assertOutboundDestination(connector, value, outbound = {}) {
  const destinations = connector.capabilities.outboundDestinations
  const destination = String(value || '')
  if (!destination) {
    if (connector.recipeId === 'external.cloud-agent-bridge'
        && connector.upstreamId === 'meldwork-cloud'
        && outbound.tunneled === true && destinations.length === 0) return ''
    if (destinations.length || OUTBOUND_TRANSPORTS.has(connector.transport.type)) {
      fail('AGENT_CONNECTOR_OUTBOUND_DESTINATION_REQUIRED')
    }
    return ''
  }
  const origin = outboundOrigin(destination)
  if (!origin || !destinations.includes(origin)) {
    fail('AGENT_CONNECTOR_OUTBOUND_DESTINATION_UNSUPPORTED')
  }
  return origin
}

function assertEventCapabilities(connector, input, permissionMode) {
  const type = String(input?.type || '')
  if (!connector.capabilities.eventTypes.includes(type)) {
    fail('AGENT_CONNECTOR_EVENT_UNDECLARED')
  }
  if (type === 'Cancelled' && !connector.capabilities.session.cancel) {
    fail('AGENT_CONNECTOR_CANCEL_UNSUPPORTED')
  }
  if (type === 'Permission' && input.permission === 'workspace-write'
      && permissionMode !== 'workspace-write') {
    fail('AGENT_CONNECTOR_PERMISSION_MODE_UNSUPPORTED')
  }
  if (type === 'Usage') {
    for (const field of Object.keys(input?.usage || {})) {
      if (connector.capabilities.usage[field] !== true) {
        fail('AGENT_CONNECTOR_USAGE_UNDECLARED')
      }
    }
  }
}

function validatedSessionRef(value) {
  if (value == null) return ''
  if (typeof value !== 'string' || (value !== '' && normalizeSessionRef(value) !== value)) {
    fail('AGENT_CONNECTOR_SESSION_INVALID')
  }
  return value
}

function assertResultCapabilities(connector, result, state) {
  if (validatedSessionRef(result?.sessionRef) && !connector.capabilities.session.supported) {
    fail('AGENT_CONNECTOR_SESSION_UNSUPPORTED')
  }
  if (result?.outcome === 'cancelled' && !connector.capabilities.session.cancel) {
    fail('AGENT_CONNECTOR_CANCEL_UNSUPPORTED')
  }
  if (result.usage != null) {
    if (typeof result.usage !== 'object' || Array.isArray(result.usage)) fail('AGENT_CONNECTOR_USAGE_UNDECLARED')
    for (const [field, value] of Object.entries(result.usage)) {
      if (connector.capabilities.usage[field] !== true) fail('AGENT_CONNECTOR_USAGE_UNDECLARED')
      if (!state.events.some(event => event.type === 'Usage' && Object.hasOwn(event.usage, field))
          || value !== state.usage[field]) fail('AGENT_CONNECTOR_USAGE_UNREPORTED')
    }
  }
}

function observedUsage(state) {
  const fields = new Set(state.events.filter(event => event.type === 'Usage')
    .flatMap(event => Object.keys(event.usage)))
  return Object.fromEntries([...fields].map(field => [field, state.usage[field]]))
}

function validatedOutcomeRefs(result, state) {
  const refs = result?.outcomeRefs
  if (refs != null) {
    if (typeof refs !== 'object' || Array.isArray(refs)
        || Object.keys(refs).some(key => !['artifactIds', 'evidenceIds'].includes(key))) {
      fail('AGENT_CONNECTOR_OUTCOME_UNDECLARED')
    }
    for (const field of ['artifactIds', 'evidenceIds']) {
      if (refs[field] == null) continue
      if (!Array.isArray(refs[field]) || refs[field].some(id => !state[field].includes(id))) {
        fail('AGENT_CONNECTOR_OUTCOME_UNDECLARED')
      }
    }
  }
  if (!refs && !state.artifactIds.length && !state.evidenceIds.length) return undefined
  return { artifactIds: [...state.artifactIds], evidenceIds: [...state.evidenceIds] }
}

function normalizeResume(input) {
  if (input == null) return null
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('AGENT_CONNECTOR_RESUME_INVALID')
  }
  const type = String(input.type || '')
  const requestId = String(input.requestId || '')
  const requestHash = String(input.requestHash || '')
  const sessionRefHash = String(input.sessionRefHash || '')
  const sessionProvenanceHash = String(input.sessionProvenanceHash || '')
  if (!['input', 'permission'].includes(type) || !PUBLIC_ID.test(requestId)
      || !SHA256.test(requestHash) || !SHA256.test(sessionRefHash)
      || !SHA256.test(sessionProvenanceHash)) {
    fail('AGENT_CONNECTOR_RESUME_INVALID')
  }
  if (type === 'input') {
    const response = typeof input.response === 'string' ? input.response : ''
    if (!response.trim() || Buffer.byteLength(response) > MAX_INPUT_RESPONSE_BYTES) {
      fail('AGENT_CONNECTOR_RESUME_INVALID')
    }
    return Object.freeze({
      type, requestId, requestHash, sessionRefHash, sessionProvenanceHash, response,
    })
  }
  const status = String(input.status || '')
  const optionId = String(input.optionId || '')
  const permission = input.permission == null ? '' : String(input.permission)
  if (!['approved', 'rejected'].includes(status) || !PUBLIC_ID.test(optionId)) {
    fail('AGENT_CONNECTOR_RESUME_INVALID')
  }
  if (permission && !['workspace-read', 'workspace-write', 'network', 'browser', 'external-message'].includes(permission)) {
    fail('AGENT_CONNECTOR_RESUME_INVALID')
  }
  return Object.freeze({
    type, requestId, requestHash, sessionRefHash, sessionProvenanceHash, status, optionId,
    ...(permission ? { permission } : {}),
  })
}

function recipeEntries(value) {
  if (value instanceof Map) return [...value.entries()]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.entries(value)
}

function uiEventId(eventId) {
  return `connector-${crypto.createHash('sha256').update(eventId).digest('hex').slice(0, 16)}`
}

function usageSummary(usage) {
  return Object.entries(usage || {})
    .filter(([, value]) => Number.isSafeInteger(value) && value >= 0)
    .map(([field, value]) => `${field}=${value}`)
    .join(', ')
    .slice(0, 800)
}

function harnessEvent(event) {
  const base = { id: uiEventId(event.eventId) }
  if (event.type === 'Permission') {
    return {
      ...base,
      type: 'warning',
      status: event.decision === 'requested' ? 'waiting' : 'completed',
      title: 'connector_permission',
      summary: event.summary || `${event.permission}: ${event.decision}`,
    }
  }
  if (event.type === 'SourceUsed') {
    return {
      ...base,
      type: 'tool_result_summary',
      status: 'completed',
      title: 'connector_source_used',
      summary: event.citation || `${event.sourceType}: ${event.sourceId}`,
    }
  }
  if (event.type === 'Artifact' || event.type === 'Evidence') {
    const reference = event.type === 'Artifact' ? event.artifactId : event.evidenceId
    return {
      ...base,
      type: 'tool_result_summary',
      status: 'completed',
      title: event.type === 'Artifact' ? 'connector_artifact' : 'connector_evidence',
      summary: reference,
    }
  }
  if (event.type === 'Usage') {
    return {
      ...base,
      type: 'tool_update',
      status: 'running',
      title: 'connector_usage',
      summary: usageSummary(event.usage),
    }
  }
  if (event.type === 'WaitingInput') {
    return {
      ...base,
      type: 'warning',
      status: 'waiting',
      title: 'connector_waiting_input',
      summary: event.prompt,
    }
  }
  if (event.type === 'Completed') {
    return {
      ...base,
      type: 'status',
      status: event.outcome,
      title: 'connector_completed',
      summary: event.summary || '',
    }
  }
  if (event.type === 'Failed') {
    return {
      ...base,
      type: 'warning',
      status: 'failed',
      title: 'connector_failed',
      summary: event.summary || `${event.category}: ${event.code}`,
    }
  }
  if (event.type === 'Cancelled') {
    return {
      ...base,
      type: 'warning',
      status: 'stopped',
      title: 'connector_cancelled',
      summary: event.summary || event.reason,
    }
  }
  return {
    ...base,
    type: 'warning',
    status: 'running',
    title: 'connector_unknown_event',
    summary: event.summary,
  }
}

class AgentConnectorRuntime {
  constructor(options = {}) {
    if (!options.registry
        || typeof options.registry.resolveExecution !== 'function'
        || typeof options.registry.runSnapshot !== 'function'
        || typeof options.registry.listInstances !== 'function') {
      fail('AGENT_CONNECTOR_RUNTIME_REGISTRY_REQUIRED')
    }
    this.registry = options.registry
    this.recordExecution = options.recordExecution || (() => {})
    this.recipes = new Map()
    this.trustedLegacyEventRecipes = new Set(options.trustedLegacyEventRecipes || [])
    for (const [recipeId, handler] of recipeEntries(options.recipes)) {
      this.registerRecipe(recipeId, handler)
    }
  }

  registerRecipe(recipeId, handler) {
    if (!PUBLIC_ID.test(String(recipeId || '')) || typeof handler !== 'function') {
      fail('AGENT_CONNECTOR_RECIPE_INVALID')
    }
    if (this.recipes.has(recipeId)) fail('AGENT_CONNECTOR_RECIPE_CONFLICT')
    this.recipes.set(recipeId, handler)
    return this
  }

  detectAgents() {
    return this.registry.listInstances().map((instance) => {
      const { manifest } = this.registry.resolveInstance(instance.instanceId)
      const snapshot = this.registry.runSnapshot(instance.instanceId)
      return Object.freeze({
        kind: instance.instanceId,
        name: instance.label,
        label: instance.label,
        version: instance.upstreamVersion,
        installed: true,
        available: true,
        invocable: true,
        custom: true,
        compatibilityState: 'compatible',
        connectorInstanceId: instance.instanceId,
        connectorId: manifest.connectorId,
        connectorVersion: manifest.connectorVersion,
        upstreamVersion: instance.upstreamVersion,
        acpAvailable: manifest.transport.type === 'acp',
        idempotencyMode: manifest.invocation.idempotencyMode || 'none',
        routingCapabilities: Object.freeze({
          domains: snapshot.capabilities.domains,
          inputTypes: snapshot.capabilities.inputTypes,
          outputTypes: Object.freeze([
            'text',
            ...(snapshot.capabilities.eventTypes.includes('Artifact') ? ['artifact'] : []),
            ...(snapshot.capabilities.eventTypes.includes('Evidence') ? ['evidence'] : []),
          ]),
          toolClasses: Object.freeze(['agent-native']),
          permissionModes: snapshot.capabilities.permissionModes,
          latencyBand: 'unknown',
          costBand: 'unknown',
          contextLimitChars: MAX_PROMPT_BYTES,
          resumable: snapshot.capabilities.session.resume,
        }),
      })
    })
  }

  async run(agent, prompt, workdir, options = {}) {
    const instanceId = String(agent?.connectorInstanceId || '')
    const runId = String(options.runId || '')
    const agentRunId = String(options.agentRunId || '')
    if (!PUBLIC_ID.test(instanceId) || !PUBLIC_ID.test(runId) || !PUBLIC_ID.test(agentRunId)) {
      fail('AGENT_CONNECTOR_RUN_ID_INVALID')
    }
    const promptText = String(prompt || '')
    if (!promptText || promptText.includes('\u0000')
        || Buffer.byteLength(promptText) > MAX_PROMPT_BYTES) {
      fail('AGENT_CONNECTOR_PROMPT_INVALID')
    }
    const resolvedWorkdir = String(workdir || '')
    if (!resolvedWorkdir || resolvedWorkdir.includes('\u0000')) {
      fail('AGENT_CONNECTOR_WORKDIR_INVALID')
    }

    const execution = this.registry.resolveExecution(instanceId)
    const connector = this.registry.runSnapshot(instanceId)
    const requestedOperationId = String(options.operationId || '')
    if (connector.capabilities.idempotencyMode === 'durable'
        && !PUBLIC_ID.test(requestedOperationId)) {
      fail('AGENT_CONNECTOR_OPERATION_ID_REQUIRED')
    }
    const operationId = PUBLIC_ID.test(requestedOperationId)
      ? requestedOperationId
      : `agent-operation-${crypto.createHash('sha256')
          .update(canonicalJson({ runId, agentRunId, instanceId }))
          .digest('hex')}`
    const provenance = {
      ...execution.provenance,
      runId,
      agentRunId,
    }
    let state = createRunEventState(provenance)
    const notifyState = (event = null) => {
      options.onConnectorState?.({
        connector,
        connectorEventState: clone(state),
      }, event)
    }
    notifyState()
    const handler = this.recipes.get(execution.recipeId)
    if (!handler) fail('AGENT_CONNECTOR_RECIPE_UNAVAILABLE')
    const permissionMode = options.sandbox === 'workspace-write'
      ? 'workspace-write'
      : 'read-only'
    if (!connector.capabilities.permissionModes.includes(permissionMode)) {
      fail('AGENT_CONNECTOR_PERMISSION_MODE_UNSUPPORTED')
    }
    if (!connector.capabilities.inputTypes.includes('text')) {
      fail('AGENT_CONNECTOR_INPUT_UNSUPPORTED')
    }
    const sessionRef = validatedSessionRef(options.sessionRef)
    if (sessionRef && !connector.capabilities.session.supported) {
      fail('AGENT_CONNECTOR_SESSION_UNSUPPORTED')
    }
    if (sessionRef && !connector.capabilities.session.resume) {
      fail('AGENT_CONNECTOR_RESUME_UNSUPPORTED')
    }
    const resume = normalizeResume(options.connectorResume)
    if (resume && (!connector.capabilities.session.supported
        || !connector.capabilities.session.resume)) {
      fail('AGENT_CONNECTOR_RESUME_UNSUPPORTED')
    }
    if (resume && !connector.capabilities.eventTypes.includes(resume.type === 'input' ? 'WaitingInput' : 'Permission')) {
      fail('AGENT_CONNECTOR_RESUME_UNSUPPORTED')
    }
    if (resume && crypto.createHash('sha256').update(sessionRef).digest('hex') !== resume.sessionRefHash) {
      fail('AGENT_CONNECTOR_SESSION_MISMATCH')
    }
    if (options.signal?.aborted && !connector.capabilities.session.cancel) {
      fail('AGENT_CONNECTOR_CANCEL_UNSUPPORTED')
    }
    const attachments = validatedAttachments(options.attachments, connector.capabilities)
    this.recordExecution({ ...execution.runtimeProvenance, runId, agentRunId })
    const emit = (input) => {
      assertEventCapabilities(connector, input, permissionMode)
      if (input?.type === 'Permission' && input.decision !== 'requested'
          && (resume?.type !== 'permission' || resume.requestId !== input.requestId
            || resume.status !== input.decision || resume.permission !== input.permission)) {
        fail('AGENT_CONNECTOR_PERMISSION_DECISION_UNBOUND')
      }
      const event = parseConnectorRunEvent(input, provenance)
      const duplicate = state.events.find(existing => existing.eventId === event.eventId)
      if (duplicate && canonicalJson(duplicate) === canonicalJson(event)) return event
      const next = reduceRunEvent(state, event)
      state = next
      notifyState(event)
      try { options.onEvent?.(harnessEvent(event)) } catch { /* Renderer events are best effort. */ }
      return event
    }
    const onOutboundPayload = (outbound = {}) => {
      assertOutboundDestination(connector, outbound.destination, outbound)
      return options.onOutboundPayload?.(outbound)
    }
    const onPermissionRequest = connector.capabilities.eventTypes.includes('Permission')
      && typeof options.onPermissionRequest === 'function'
      ? (request, context) => {
          if (permissionMode === 'read-only' && (['workspace-write', 'write'].includes(request?.permission)
              || (request?.toolCall && !READ_ONLY_SAFE_TOOL_KINDS.has(request.toolCall.kind)))) {
            return automaticPermissionResponse(request, { allowWrite: false })
          }
          return options.onPermissionRequest(request, context)
        }
      : undefined

    const result = await handler(Object.freeze({
      agent: Object.freeze({
        kind: String(agent?.kind || ''),
        label: String(agent?.label || agent?.name || ''),
      }),
      connector,
      credentialRefId: execution.credentialRef,
      provenance: execution.runtimeProvenance,
      runId,
      agentRunId,
      operationId,
      idempotencyKey: operationId,
      prompt: promptText,
      workdir: resolvedWorkdir,
      permissionMode,
      sessionRef,
      attachments,
      signal: connector.capabilities.session.cancel ? options.signal : undefined,
      transportSignal: ABORTABLE_TRANSPORT_RECIPES.has(execution.recipeId) ? options.signal : undefined,
      onActivity: options.onActivity,
      emit,
      onProgress: this.trustedLegacyEventRecipes.has(execution.recipeId) ? options.onProgress : undefined,
      onRuntimeEvent: this.trustedLegacyEventRecipes.has(execution.recipeId) ? options.onEvent : undefined,
      onOutboundPayload,
      assertOutboundDestination: destination => assertOutboundDestination(
        connector, destination,
      ),
      onPermissionRequest,
      resume,
    }))

    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      fail('AGENT_CONNECTOR_RESULT_INVALID')
    }
    if (result.progress != null && !this.trustedLegacyEventRecipes.has(execution.recipeId)) {
      fail('AGENT_CONNECTOR_EVENT_UNDECLARED')
    }
    assertResultCapabilities(connector, result, state)
    const usage = observedUsage(state)
    const outcomeRefs = validatedOutcomeRefs(result, state)
    if (result.outcome != null && result.outcome !== state.status) {
      fail('AGENT_CONNECTOR_RESULT_MISMATCH')
    }
    if (['waiting_input', 'waiting_permission'].includes(state.status)) {
      if (!connector.capabilities.session.supported || !connector.capabilities.session.resume) {
        fail('AGENT_CONNECTOR_RESUME_UNSUPPORTED')
      }
      const waiting = state.events.at(-1)
      const validWaiting = state.status === 'waiting_input'
        ? waiting?.type === 'WaitingInput'
        : waiting?.type === 'Permission' && waiting.decision === 'requested'
      if (!validWaiting) fail('AGENT_CONNECTOR_WAITING_EVENT_REQUIRED')
      return {
        ...result,
        ...(outcomeRefs ? { outcomeRefs } : {}),
        outcome: state.status,
        usage,
        waitingRequest: clone(waiting),
        connector,
        connectorEventState: clone(state),
      }
    }
    if (!['completed', 'partial', 'failed', 'cancelled'].includes(state.status)) {
      fail('AGENT_CONNECTOR_TERMINAL_EVENT_REQUIRED')
    }
    const terminal = state.events.at(-1)
    if (state.status === 'failed') {
      return {
        text: terminal?.summary || '',
        sessionRef: '',
        outcome: 'failed',
        failure: {
          code: terminal?.code || 'AGENT_CONNECTOR_FAILED',
          category: terminal?.category || 'protocol',
          retryable: terminal?.retryable === true,
        },
        usage,
        connector,
        connectorEventState: clone(state),
      }
    }
    if (state.status === 'cancelled') {
      return {
        text: terminal?.summary || '',
        sessionRef: '',
        outcome: 'cancelled',
        usage,
        connector,
        connectorEventState: clone(state),
      }
    }
    return {
      ...result,
      ...(outcomeRefs ? { outcomeRefs } : {}),
      outcome: state.status,
      usage,
      connector,
      connectorEventState: clone(state),
    }
  }
}

module.exports = {
  AgentConnectorRuntime,
  harnessEvent,
}

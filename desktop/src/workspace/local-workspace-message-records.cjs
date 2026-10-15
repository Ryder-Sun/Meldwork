const path = require('node:path')
const { normalizeContentBlobRef } = require('../attachments/content-blob-store.cjs')
const { normalizeTraceCapsule } = require('../runs/run-harness.cjs')
const { normalizeRoutingDecision } = require('../agents/agent-routing.cjs')
const {
  CUSTOM_AGENT_KIND,
  MAX_SYSTEM_PARAM_TEXT_CHARS,
  cleanInline,
  cleanText,
  defaultAgentLabel,
  isSupportedAgentKind,
} = require('./local-workspace-contracts.cjs')
const {
  cleanElapsedMs,
  cleanProgressSteps,
  terminalMessageContentLimit,
} = require('./local-workspace-runtime-contracts.cjs')

const MAX_MESSAGE_ATTACHMENTS = 32
const MAX_SKILL_HINTS = 4
const MAX_KNOWLEDGE_BASE_HINTS = 4
const MAX_ATTACHMENT_BYTES = 128 * 1024 * 1024
const USER_ATTACHMENT_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'audio/mpeg', 'audio/wav', 'audio/mp4',
  'video/mp4', 'video/quicktime', 'video/webm',
  'application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json',
  'application/rtf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
  'application/zip', 'application/gzip', 'application/x-tar', 'application/x-7z-compressed',
])
const ATTACHMENT_MIME_TYPES = new Set([
  ...USER_ATTACHMENT_MIME_TYPES,
  'audio/mpeg', 'audio/wav', 'audio/mp4',
  'video/mp4', 'video/quicktime', 'video/webm',
])
const ATTACHMENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const SKILL_SNAPSHOT_ID = /^skill-snapshot-[a-f0-9]{64}$/
const SHA256 = /^[a-f0-9]{64}$/
const KNOWLEDGE_BASE_KINDS = new Set(['feishu', 'dingtalk', 'obsidian'])

function emptyState() {
  return {
    version: 3,
    groups: [],
    messages: [],
    sessions: {},
    sessionMeta: {},
    agentPreferences: {},
    agentRuntime: {},
  }
}

function normalizeSystemParams(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const params = {}
  for (const [rawKey, rawValue] of Object.entries(input).slice(0, 12)) {
    const key = cleanInline(rawKey, 60)
    if (!key) continue
    if (typeof rawValue === 'string') {
      params[key] = cleanText(rawValue, MAX_SYSTEM_PARAM_TEXT_CHARS)
    }
    else if (typeof rawValue === 'boolean') params[key] = rawValue
    else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) params[key] = rawValue
  }
  return params
}

function normalizeAttachmentMetadata(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const id = String(input.id || '')
  const name = cleanInline(input.name, 160)
  const mimeType = String(input.mimeType || '').toLowerCase()
  const size = Number(input.size)
  if (!ATTACHMENT_ID.test(id) || !name || !ATTACHMENT_MIME_TYPES.has(mimeType)
      || !Number.isSafeInteger(size) || size <= 0 || size > MAX_ATTACHMENT_BYTES) {
    return null
  }
  return { id, name, mimeType, size }
}

function attachmentType(mimeType) {
  const normalized = String(mimeType || '').toLowerCase()
  if (normalized.startsWith('image/')) return 'image'
  if (normalized.startsWith('audio/')) return 'audio'
  if (normalized.startsWith('video/')) return 'video'
  return USER_ATTACHMENT_MIME_TYPES.has(normalized) ? 'file' : ''
}

function attachmentLimitError(type, limited = false) {
  if (type === 'image') return limited ? 'LOCAL_AGENT_IMAGE_LIMIT' : 'LOCAL_AGENT_IMAGE_UNSUPPORTED'
  if (type === 'file') return limited ? 'LOCAL_AGENT_FILE_LIMIT' : 'LOCAL_AGENT_FILE_UNSUPPORTED'
  return limited ? 'LOCAL_AGENT_MEDIA_LIMIT' : 'LOCAL_AGENT_MEDIA_UNSUPPORTED'
}

function normalizeSkillHint(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const targetKind = cleanInline(input.targetKind, 40)
  const namespace = cleanInline(input.namespace, 100)
  const slug = cleanInline(input.slug, 100)
  const name = cleanInline(input.name, 100)
  if (!isSupportedAgentKind(targetKind) || !namespace || !slug || !name) return null
  const hint = { targetKind, namespace, slug, name }
  const snapshotFields = ['snapshotId', 'manifestHash', 'snapshotRef']
  const hasSnapshot = snapshotFields.some(field => Object.hasOwn(input, field))
  if (!hasSnapshot) return hint
  if (!snapshotFields.every(field => Object.hasOwn(input, field))) return null
  const snapshotId = String(input.snapshotId || '')
  const manifestHash = String(input.manifestHash || '')
  if (!SKILL_SNAPSHOT_ID.test(snapshotId) || !SHA256.test(manifestHash)
      || snapshotId !== `skill-snapshot-${manifestHash}`) return null
  let snapshotRef
  try { snapshotRef = normalizeContentBlobRef(input.snapshotRef) } catch { return null }
  if (snapshotRef.mediaType !== 'application/json') return null
  return { ...hint, snapshotId, manifestHash, snapshotRef }
}

function normalizeKnowledgeBaseHint(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const kind = cleanInline(input.kind, 40)
  const name = cleanInline(input.name, 100)
  const accessMode = cleanInline(input.accessMode, 20)
  const targetKinds = normalizeTargetKinds(input.targetKinds)
  if (!KNOWLEDGE_BASE_KINDS.has(kind) || !name || !['cli', 'vault'].includes(accessMode)
      || !targetKinds.length) return null
  if (accessMode === 'vault') {
    const location = cleanText(input.location, 1000)
    if (!path.isAbsolute(location)) return null
    return { kind, name, accessMode, targetKinds, location: path.normalize(location) }
  }
  const commandName = cleanInline(input.commandName, 80)
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(commandName)) return null
  return { kind, name, accessMode, targetKinds, commandName }
}

function normalizeTargetKinds(input) {
  return [...new Set((Array.isArray(input) ? input : [])
    .map(kind => cleanInline(kind, 40))
    .filter(isSupportedAgentKind))]
}

function skillHintsPrompt(hints) {
  if (!hints.length) return ''
  return [
    'The user explicitly selected these immutable Skill snapshots for this Agent. Load and follow only the recorded snapshot when relevant; do not reload the live installed Skill:',
    ...hints.map((skill) => {
      const entryPath = typeof skill.entryPath === 'string' && path.isAbsolute(skill.entryPath)
        && !/[\u0000-\u001f\u007f]/.test(skill.entryPath)
        ? path.normalize(skill.entryPath)
        : ''
      return entryPath
        ? `- ${skill.namespace}/${skill.slug}: ${skill.name}; entry ${entryPath}`
        : `- ${skill.namespace}/${skill.slug}: ${skill.name}; snapshot ${skill.snapshotId || 'unavailable'}`
    }),
  ].join('\n')
}

function knowledgeBaseHintsPrompt(hints) {
  if (!hints.length) return ''
  return [
    'The user explicitly granted this Agent read access to these configured knowledge bases for this task. Use them when relevant, identify the source used in the answer, and do not modify source content:',
    ...hints.map((source) => {
      if (source.accessMode === 'vault') {
        return `- ${source.name} (${source.kind}): read from the local vault at ${source.location}`
      }
      return `- ${source.name} (${source.kind}): use the configured ${source.commandName} command-line connection with read-only operations`
    }),
  ].join('\n')
}

function normalizeLoadedGroup(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const id = cleanText(input.id, 100)
  const normalizeKinds = values => [...new Set((Array.isArray(values) ? values : [])
    .map(kind => cleanInline(kind, 40))
    .filter(isSupportedAgentKind))]
  let agentKinds = normalizeKinds(input.agentKinds)
  // Earlier builds could persistently remove every member of a group after
  // repeated failures. Dropping such a group would also drop its messages,
  // so rebuild the membership from the Agents that replied in it instead.
  if (!agentKinds.length) agentKinds = normalizeKinds(options.recoveredAgentKinds)
  if (!id || !agentKinds.length) return null

  const group = {
    id,
    name: cleanText(input.name, 60),
    topic: cleanText(input.topic, 200),
    agentKinds,
    workdir: path.resolve(cleanText(input.workdir, 1000) || process.cwd()),
    allowWrite: input.allowWrite === true,
    createdAt: cleanText(input.createdAt, 80),
    updatedAt: cleanText(input.updatedAt, 80),
  }
  if (input.conversationType === 'direct') {
    const requestedDirectKind = cleanInline(input.directAgentKind, 40)
    const directAgentKind = isSupportedAgentKind(requestedDirectKind)
      ? requestedDirectKind
      : agentKinds[0]
    group.conversationType = 'direct'
    group.directAgentKind = directAgentKind
    group.agentKinds = [directAgentKind]
  }
  return group
}

function normalizeLoadedMessage(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const id = cleanText(input.id, 100)
  const groupId = cleanText(input.groupId, 100)
  const role = ['user', 'agent', 'system'].includes(input.role) ? input.role : ''
  const requestedAgentKind = cleanInline(input.agentKind, 40)
  const agentKind = isSupportedAgentKind(requestedAgentKind) ? requestedAgentKind : ''
  if (!id || !groupId || !role || (role === 'agent' && !agentKind)) return null
  const systemKey = role === 'system' ? cleanInline(input.system?.key, 100) : ''
  const turnSeq = Number(input.turnSeq)

  const message = {
    ...(Number.isSafeInteger(turnSeq) && turnSeq > 0 ? { turnSeq } : {}),
    id,
    groupId,
    role,
    agentKind,
    senderName: role === 'user'
      ? 'User'
      : (role === 'agent'
          ? (CUSTOM_AGENT_KIND.test(agentKind)
              ? cleanInline(input.senderName, 60) || defaultAgentLabel(agentKind)
              : defaultAgentLabel(agentKind))
          : 'System'),
    content: cleanText(
      input.content,
      terminalMessageContentLimit(role, agentKind, systemKey),
    ),
    createdAt: cleanText(input.createdAt, 80),
  }
  const threadRootId = cleanText(input.threadRootId, 100)
  if (threadRootId) message.threadRootId = threadRootId
  if (systemKey) {
    message.system = {
      key: systemKey,
      params: normalizeSystemParams(input.system?.params),
    }
  }
  if (role === 'agent') {
    const elapsedMs = cleanElapsedMs(input.elapsedMs)
    const toolCalls = cleanProgressSteps(input.toolCalls)
    const responseVersionRootId = cleanText(input.responseVersionRootId, 100)
    const attachments = (Array.isArray(input.attachments) ? input.attachments : [])
      .slice(0, MAX_MESSAGE_ATTACHMENTS)
      .map(normalizeAttachmentMetadata)
      .filter(Boolean)
    if (elapsedMs != null) message.elapsedMs = elapsedMs
    if (toolCalls.length) message.toolCalls = toolCalls
    if (attachments.length) message.attachments = attachments
    if (responseVersionRootId) message.responseVersionRootId = responseVersionRootId
  }
  if (role === 'agent' || (role === 'system' && agentKind)) {
    const trace = normalizeTraceCapsule(input.trace)
    if (trace) message.trace = trace
  }
  if (role === 'user') {
    const attachments = (Array.isArray(input.attachments) ? input.attachments : [])
      .slice(0, MAX_MESSAGE_ATTACHMENTS)
      .map(normalizeAttachmentMetadata)
      .filter(attachment => attachment && USER_ATTACHMENT_MIME_TYPES.has(attachment.mimeType))
    const skillHints = (Array.isArray(input.skillHints) ? input.skillHints : [])
      .slice(0, MAX_SKILL_HINTS)
      .map(normalizeSkillHint)
      .filter(Boolean)
    const knowledgeBaseHints = (Array.isArray(input.knowledgeBaseHints) ? input.knowledgeBaseHints : [])
      .slice(0, MAX_KNOWLEDGE_BASE_HINTS)
      .map(normalizeKnowledgeBaseHint)
      .filter(Boolean)
    const targetKinds = normalizeTargetKinds(input.targetKinds)
    const routingDecision = normalizeRoutingDecision(input.routingDecision)
    if (attachments.length) message.attachments = attachments
    if (skillHints.length) message.skillHints = skillHints
    if (knowledgeBaseHints.length) message.knowledgeBaseHints = knowledgeBaseHints
    if (targetKinds.length) message.targetKinds = targetKinds
    if (routingDecision) message.routingDecision = routingDecision
  }
  return message
}

module.exports = {
  ATTACHMENT_ID,
  KNOWLEDGE_BASE_KINDS,
  MAX_ATTACHMENT_BYTES,
  MAX_KNOWLEDGE_BASE_HINTS,
  MAX_MESSAGE_ATTACHMENTS,
  MAX_SKILL_HINTS,
  USER_ATTACHMENT_MIME_TYPES,
  attachmentLimitError,
  attachmentType,
  emptyState,
  knowledgeBaseHintsPrompt,
  normalizeAttachmentMetadata,
  normalizeKnowledgeBaseHint,
  normalizeLoadedGroup,
  normalizeLoadedMessage,
  normalizeSkillHint,
  normalizeTargetKinds,
  skillHintsPrompt,
}

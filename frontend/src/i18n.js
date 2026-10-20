import { ref } from 'vue'
import en from './locales/en.js'
import zh from './locales/zh.js'
import { readProductPreference, writeProductPreference } from './product-preferences.js'

const messages = { en, zh }

function initialLocale() {
  try {
    const saved = readProductPreference('locale')
    if (saved === 'en' || saved === 'zh') return saved
  } catch { /* localStorage may be unavailable */ }
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

export const locale = ref(initialLocale())

export function setLocale(value) {
  locale.value = value === 'zh' ? 'zh' : 'en'
  if (typeof document !== 'undefined') document.documentElement.lang = locale.value === 'zh' ? 'zh-CN' : 'en'
  try { writeProductPreference('locale', locale.value) } catch { /* noop */ }
}

function expandParam(name, params, depth, trail) {
  const value = String(params[name])
  if (depth <= 0) return value
  return value.replace(/\{([^{}]+)\}/g, (placeholder, nestedName) => {
    if (!Object.hasOwn(params, nestedName) || trail.has(nestedName)) return placeholder
    return expandParam(nestedName, params, depth - 1, new Set([...trail, nestedName]))
  })
}

export function t(key, params = {}, options = {}) {
  const template = messages[locale.value]?.[key] ?? messages.en[key] ?? key
  const values = params && typeof params === 'object' ? params : {}
  const expandedNames = new Set(Array.isArray(options?.expand) ? options.expand : [])
  const requestedDepth = Number(options?.maxDepth)
  const maxDepth = Number.isInteger(requestedDepth) ? Math.max(0, Math.min(5, requestedDepth)) : 3
  return template.replace(/\{([^{}]+)\}/g, (placeholder, name) => {
    if (!Object.hasOwn(values, name)) return placeholder
    return expandedNames.has(name)
      ? expandParam(name, values, maxDepth, new Set([name]))
      : String(values[name])
  })
}

export function messageKeys(language) {
  return Object.keys(messages[language] || {}).sort()
}

export const DESKTOP_ERROR_MESSAGE_KEYS = Object.freeze({
  LOCAL_DELIVERY_INVALID: 'delivery.error.invalid',
  LOCAL_DELIVERY_NOT_FOUND: 'delivery.error.notFound',
  LOCAL_DELIVERY_LOCKED: 'delivery.error.locked',
  LOCAL_DELIVERY_REVISION_REQUIRED: 'delivery.error.revision',
  LOCAL_DELIVERY_NOT_READY: 'delivery.error.notReady',
  LOCAL_DELIVERY_INPUT_LIMIT: 'delivery.error.limit',
  LOCAL_DELIVERY_EXPORT_FAILED: 'delivery.error.export',
  LOCAL_WORKSPACE_UNAVAILABLE: 'error.workspaceUnavailable',
  LOCAL_GROUP_AGENT_REQUIRED: 'error.groupAgentRequired',
  LOCAL_GROUP_NOT_FOUND: 'error.groupNotFound',
  INSTALL_AGENT_BUSY: 'error.installBusy',
  INSTALL_AGENT_NODE_REQUIRED: 'error.installNode',
  INSTALL_AGENT_PLATFORM_UNSUPPORTED: 'error.installUnsupported',
  INSTALL_AGENT_UNSUPPORTED: 'error.installUnsupported',
  INSTALL_AGENT_DOWNLOAD_BLOCKED: 'error.installDownloadBlocked',
  INSTALL_AGENT_DOWNLOAD_FAILED: 'error.installDownloadFailed',
  INSTALL_AGENT_INTEGRITY_FAILED: 'error.installIntegrity',
  INSTALL_AGENT_COMMAND_BLOCKED: 'error.installCommandBlocked',
  INSTALL_AGENT_PROCESS_FAILED: 'error.installProcessFailed',
  INSTALL_AGENT_ALREADY_INSTALLED: 'error.installAlreadyInstalled',
  INSTALL_AGENT_FAILED: 'error.installFailed',
  INSTALL_AGENT_VERIFY_FAILED: 'error.installVerify',
  LOCAL_GROUP_RUNNING: 'error.groupRunning',
  LOCAL_MESSAGE_NOT_FOUND: 'error.messageNotFound',
  LOCAL_MESSAGE_REQUIRED: 'error.messageRequired',
  LOCAL_MESSAGE_TARGET_REQUIRED: 'error.messageTargetRequired',
  LOCAL_MESSAGE_TARGET_DUPLICATE: 'error.messageTargetDuplicate',
  LOCAL_MESSAGE_TARGET_UNKNOWN: 'error.messageTargetUnknown',
  LOCAL_MESSAGE_TARGET_OUT_OF_GROUP: 'error.messageTargetOutOfGroup',
  LOCAL_MESSAGE_TARGET_LIMIT: 'error.messageTargetLimit',
  LOCAL_MESSAGE_REGENERATION_INVALID: 'error.regenerationInvalid',
  LOCAL_AGENT_NOT_INSTALLED: 'error.agentUnavailable',
  LOCAL_AGENT_UNAVAILABLE: 'error.agentUnavailable',
  LOCAL_AGENT_CAPABILITY_MISMATCH: 'error.agentCapabilityMismatch',
  LOCAL_AGENT_ROUTING_NO_MATCH: 'error.agentRoutingNoMatch',
  LOCAL_AGENT_ROUTING_CONTEXT_CONFLICT: 'error.agentRoutingContextConflict',
  LOCAL_AGENT_ROUTING_MODE_INVALID: 'error.agentRoutingInvalid',
  LOCAL_AGENT_ROUTING_REQUIREMENTS_INVALID: 'error.agentRoutingInvalid',
  LOCAL_AGENT_ROUTING_DECISION_INVALID: 'error.agentRoutingInvalid',
  LOCAL_AGENT_ALL_CALLS_FAILED: 'error.allAgentsFailed',
  LOCAL_AUTO_AGENT_COUNT: 'error.autoAgentCount',
  LOCAL_AUTO_THREAD_REQUIRED: 'error.autoThreadRequired',
  LOCAL_AGENT_EXECUTION_STOPPED: 'error.executionStopped',
  LOCAL_AGENT_TIMEOUT: 'error.agentTimeout',
  LOCAL_CLI_WRAPPER_UNSUPPORTED: 'error.cliWrapperUnsupported',
  CODEX_SANDBOX_UNSUPPORTED: 'error.codexSandboxUnsupported',
  LOCAL_AGENT_KIND_UNSUPPORTED: 'error.agentKindUnsupported',
  LOCAL_AGENT_AUTH_REQUIRED: 'error.agentAuthRequired',
  LOCAL_WORKBUDDY_MODEL_UNAVAILABLE: 'workbuddy.modelUnavailable',
  LOCAL_WORKBUDDY_BUSY: 'workbuddy.busy',
  LOCAL_WORKBUDDY_PROVIDER_AUTH: 'workbuddy.providerAuth',
  LOCAL_WORK_PREFERENCES_INVALID: 'workPreferences.invalid',
  LOCAL_WORK_PREFERENCES_BUSY: 'workPreferences.busy',
  LOCAL_AGENT_ACCESS_DENIED: 'error.agentAccessDenied',
  LOCAL_AGENT_SESSION_INVALID: 'error.agentSessionInvalid',
  LOCAL_AGENT_OUTPUT_LIMIT: 'error.agentOutputLimit',
  LOCAL_AGENT_SEND_FAILED: 'error.agentSendFailed',
  LOCAL_AGENT_REFUSED: 'error.agentRefused',
  LOCAL_AGENT_PERMISSION_TERMINAL_RACE: 'error.agentPermissionRace',
  LOCAL_AGENT_VERSION_UNSUPPORTED: 'agent.incompatibleVersion',
  LOCAL_AGENT_REQUIRED_CAPABILITY_MISSING: 'agent.incompatibleCapability',
  LOCAL_AGENT_PROTOCOL_UNAVAILABLE: 'agent.incompatibleProtocol',
  LOCAL_RUN_TASK_DECISION_INVALID: 'error.taskDecisionInvalid',
  LOCAL_RUN_COLLABORATION_RECEIPT_INVALID: 'error.collaborationReceiptInvalid',
  LOCAL_RUN_COLLABORATION_RECEIPT_REQUIRED: 'error.collaborationReceiptInvalid',
  LOCAL_RUN_COLLABORATION_RECEIPT_MISMATCH: 'error.collaborationReceiptInvalid',
  LOCAL_RUN_REQUIRED_CONTEXT_OVERFLOW: 'error.contextOverflow',
  LOCAL_RUN_PERSIST_FAILED: 'error.runPersistFailed',
  LOCAL_RUN_TERMINAL_PERSIST_FAILED: 'error.runPersistFailed',
  LOCAL_RUN_CIRCUIT_BREAKER: 'error.runCircuitBreaker',
  LOCAL_AGENT_PROCESS_FAILED: 'error.agentProcessFailed',
  LOCAL_AGENT_EXITED: 'error.agentExited',
  LOCAL_AGENT_EMPTY_RESPONSE: 'error.agentEmptyResponse',
  LOCAL_AGENT_UNKNOWN_FAILURE: 'error.agentUnknownFailure',
  LOCAL_AGENT_SPAWN_FAILED: 'error.agentSpawnFailed',
  MEDIA_GENERATION_MODEL_UNAVAILABLE: 'error.mediaModelUnavailable',
  MEDIA_GENERATION_PROVIDER_UNAVAILABLE: 'error.mediaProviderUnavailable',
  CUSTOM_AGENT_LIMIT: 'error.customAgentLimit',
  CUSTOM_AGENT_LABEL_REQUIRED: 'error.customAgentLabel',
  CUSTOM_AGENT_DESCRIPTION_INVALID: 'error.customAgentDescription',
  CUSTOM_AGENT_ARGUMENTS_INVALID: 'error.customAgentArguments',
  CUSTOM_AGENT_SECRET_ARGUMENT_BLOCKED: 'error.customAgentSecret',
  CUSTOM_AGENT_PROMPT_MODE_INVALID: 'error.customAgentPromptMode',
  CUSTOM_AGENT_EXECUTABLE_INVALID: 'error.customAgentExecutable',
  CUSTOM_AGENT_EXECUTABLE_UNSUPPORTED: 'error.customAgentExecutableUnsupported',
  CUSTOM_AGENT_ID_UNAVAILABLE: 'error.customAgentUnavailable',
  CUSTOM_AGENT_NOT_FOUND: 'error.customAgentUnavailable',
  CUSTOM_AGENT_IN_USE: 'error.customAgentInUse',
  CUSTOM_AGENT_PROMPT_INVALID: 'error.customAgentPrompt',
  CUSTOM_AGENT_OUTPUT_LIMIT: 'error.customAgentOutputLimit',
  CUSTOM_AGENT_SPAWN_FAILED: 'error.customAgentSpawn',
  CUSTOM_AGENT_PROCESS_FAILED: 'error.customAgentProcess',
  LOCAL_AGENT_IMAGE_UNSUPPORTED: 'error.imageUnsupported',
  LOCAL_AGENT_IMAGE_LIMIT: 'error.imageLimit',
  LOCAL_AGENT_FILE_UNSUPPORTED: 'error.fileUnsupported',
  LOCAL_AGENT_FILE_LIMIT: 'error.fileLimit',
  LOCAL_AGENT_MEDIA_UNSUPPORTED: 'error.mediaUnsupported',
  LOCAL_AGENT_MEDIA_LIMIT: 'error.mediaLimit',
  LOCAL_ATTACHMENT_BYTES_INVALID: 'error.attachmentInvalid',
  LOCAL_ATTACHMENT_COUNT_LIMIT: 'error.attachmentLimit',
  LOCAL_ATTACHMENT_CREATE_ID_INVALID: 'error.attachmentUnavailable',
  LOCAL_ATTACHMENT_FILE_MISSING: 'error.attachmentUnavailable',
  LOCAL_ATTACHMENT_ID_CONFLICT: 'error.attachmentUnavailable',
  LOCAL_ATTACHMENT_ID_INVALID: 'error.attachmentInvalid',
  LOCAL_ATTACHMENT_INPUT_INVALID: 'error.attachmentInvalid',
  LOCAL_ATTACHMENT_NOT_FOUND: 'error.attachmentUnavailable',
  LOCAL_ATTACHMENT_REFERENCE_INVALID: 'error.attachmentInvalid',
  LOCAL_ATTACHMENT_ROOT_REQUIRED: 'error.attachmentUnavailable',
  LOCAL_ATTACHMENT_ROOT_UNSAFE: 'error.attachmentUnavailable',
  LOCAL_ATTACHMENT_STAGE_UNAVAILABLE: 'error.attachmentUnavailable',
  LOCAL_ATTACHMENT_SOURCE_INVALID: 'error.attachmentInvalid',
  LOCAL_ATTACHMENT_SOURCE_UNAVAILABLE: 'error.attachmentUnavailable',
  LOCAL_ATTACHMENT_SOURCE_UNSAFE: 'error.attachmentUnavailable',
  LOCAL_ATTACHMENT_STORAGE_UNAVAILABLE: 'error.attachmentUnavailable',
  LOCAL_ATTACHMENT_TAMPERED: 'error.attachmentUnavailable',
  LOCAL_ATTACHMENT_TOO_LARGE: 'error.attachmentTooLarge',
  LOCAL_ATTACHMENT_TYPE_MISMATCH: 'error.attachmentType',
  LOCAL_ATTACHMENT_TYPE_UNSUPPORTED: 'error.attachmentType',
  LOCAL_ATTACHMENT_OPEN_UNAVAILABLE: 'error.attachmentOpen',
  LOCAL_ATTACHMENT_OPEN_FAILED: 'error.attachmentOpen',
  LOCAL_SKILL_LIMIT: 'error.skillLimit',
  LOCAL_SKILL_SELECTION_INVALID: 'error.skillInvalid',
  LOCAL_KNOWLEDGE_BASE_SELECTION_INVALID: 'error.knowledgeBaseInvalid',
  CLOUD_AGENT_BRIDGE_ADDRESS_INVALID: 'error.cloudAgentBridgeAddress',
  CLOUD_AGENT_BRIDGE_MANIFEST_INVALID: 'error.cloudAgentBridgeManifest',
  CLOUD_AGENT_BRIDGE_TIMEOUT: 'error.cloudAgentBridgeNetwork',
  CLOUD_AGENT_BRIDGE_PROBE_FAILED: 'error.cloudAgentBridgeNetwork',
  CLOUD_AGENT_BRIDGE_RESPONSE_INVALID: 'error.cloudAgentBridgeProtocol',
  CLOUD_AGENT_BRIDGE_RESPONSE_TOO_LARGE: 'error.cloudAgentBridgeProtocol',
  CLOUD_AGENT_BRIDGE_HTTP_401: 'error.cloudAgentBridgeAuth',
  CLOUD_AGENT_BRIDGE_HTTP_403: 'error.cloudAgentBridgeAuth',
  CLOUD_AGENT_BRIDGE_HTTP_404: 'error.cloudAgentBridgeProtocol',
  CLOUD_AGENT_BRIDGE_HTTP_500: 'error.cloudAgentBridgeNetwork',
  CLOUD_AGENT_SSH_ADDRESS_INVALID: 'error.cloudAgentSshAddress',
  CLOUD_AGENT_SSH_UNAVAILABLE: 'error.cloudAgentSshUnavailable',
  CLOUD_AGENT_SSH_NO_AGENT: 'error.cloudAgentSshNoAgent',
  CLOUD_AGENT_SSH_RESPONSE_INVALID: 'error.cloudAgentSshProtocol',
  CLOUD_AGENT_SSH_RESPONSE_TOO_LARGE: 'error.cloudAgentSshProtocol',
  CLOUD_AGENT_SSH_PERMISSION_UNSUPPORTED: 'error.cloudAgentSshPermission',
  CLOUD_AGENT_SSH_TUNNEL_INVALID: 'error.cloudAgentSshUnavailable',
  CLOUD_AGENT_SSH_TUNNEL_TIMEOUT: 'error.cloudAgentSshUnavailable',
  CLOUD_AGENT_SSH_TUNNEL_UNAVAILABLE: 'error.cloudAgentSshUnavailable',
  CLOUD_AGENT_SSH_TUNNEL_FAILED: 'error.cloudAgentSshUnavailable',
  CLOUD_AGENT_SSH_TUNNEL_PROTOCOL: 'error.cloudAgentSshProtocol',
})

const LEGACY_ERROR_PATTERNS = [
  [/Desktop workspace is unavailable/i, 'error.workspaceUnavailable'],
  [/active run/i, 'error.groupRunning'],
]

function translatedErrorKey(error) {
  const raw = String(error?.code || error?.message || error || '').trim()
  const codes = raw.toUpperCase().match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) || []
  for (const code of codes) {
    if (DESKTOP_ERROR_MESSAGE_KEYS[code]) return DESKTOP_ERROR_MESSAGE_KEYS[code]
  }
  return LEGACY_ERROR_PATTERNS.find(([pattern]) => pattern.test(raw))?.[1] || ''
}

export function translateError(error) {
  const key = translatedErrorKey(error)
  return key ? t(key) : t('error.generic')
}

export function translateSystemMessage(message) {
  const key = String(message?.system?.key || '')
  const hasTranslation = Object.hasOwn(messages[locale.value] || {}, key) || Object.hasOwn(messages.en, key)
  if (!key || !hasTranslation) return String(message?.content || '')
  const params = { ...(message.system?.params || {}) }
  const reasonKey = translatedErrorKey(params.reason)
  if (reasonKey) params.reason = t(reasonKey)
  return t(key, params)
}

setLocale(locale.value)

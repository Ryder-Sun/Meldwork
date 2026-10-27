const { authFailureCertainty } = require('../runs/failure-signals.cjs')
const AGENT_OUTCOMES = Object.freeze([
  'accepted',
  'running',
  'waiting_input',
  'waiting_permission',
  'partial',
  'completed',
  'failed',
  'cancelled',
])

const OUTCOME_SET = new Set(AGENT_OUTCOMES)
const NON_TERMINAL_OUTCOMES = new Set([
  'accepted', 'running', 'waiting_input', 'waiting_permission',
])
const SUCCESSFUL_OUTCOMES = new Set(['partial', 'completed'])
const EXTERNAL_RUN_REF = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$/

const AGENT_CAPABILITY_DOMAINS = Object.freeze([
  'general', 'software-development', 'software-review', 'research',
  'document-production', 'tool-use', 'automation',
])
const AGENT_INPUT_TYPES = Object.freeze([
  'text', 'image', 'audio', 'video', 'file', 'structured-data',
])
const AGENT_OUTPUT_TYPES = Object.freeze(['text', 'artifact', 'evidence'])
const AGENT_TOOL_CLASSES = Object.freeze([
  'agent-native', 'filesystem', 'filesystem-read', 'shell', 'network', 'browser',
])
const AGENT_PERMISSION_MODES = Object.freeze(['read-only', 'workspace-write'])
const AGENT_LATENCY_BANDS = Object.freeze(['low', 'medium', 'high', 'unknown'])
const AGENT_COST_BANDS = Object.freeze(['low', 'medium', 'high', 'unknown'])

function capabilityProfile(input) {
  return Object.freeze({
    task: input.task,
    domains: Object.freeze([...input.domains]),
    inputTypes: Object.freeze([...input.inputTypes]),
    outputTypes: Object.freeze([...input.outputTypes]),
    toolClasses: Object.freeze([...input.toolClasses]),
    permissionModes: Object.freeze([...input.permissionModes]),
    latencyBand: input.latencyBand,
    costBand: input.costBand,
    contextLimitChars: input.contextLimitChars,
    resumable: input.resumable,
  })
}

function generalProfile(overrides = {}) {
  return capabilityProfile({
    task: 'general',
    domains: ['general'],
    inputTypes: ['text', 'file'],
    outputTypes: ['text', 'artifact', 'evidence'],
    toolClasses: ['agent-native'],
    permissionModes: ['read-only', 'workspace-write'],
    latencyBand: 'unknown',
    costBand: 'unknown',
    contextLimitChars: 20000,
    resumable: true,
    ...overrides,
  })
}

const AGENT_RUNTIME_CAPABILITIES = Object.freeze({
  codex: generalProfile({
    domains: ['general', 'software-development', 'software-review', 'tool-use'],
    inputTypes: ['text', 'image', 'file'],
    toolClasses: ['filesystem', 'shell'],
  }),
  hermes: generalProfile({
    domains: ['general', 'research', 'document-production', 'tool-use'],
    inputTypes: ['text', 'image', 'file'],
  }),
  openclaw: generalProfile({
    domains: ['general', 'research', 'tool-use', 'automation'],
  }),
  workbuddy: generalProfile({
    domains: ['general', 'software-development', 'document-production'],
    toolClasses: ['filesystem', 'shell'],
  }),
  zcode: generalProfile({
    domains: ['general', 'software-development', 'research'],
    toolClasses: ['filesystem', 'shell'],
  }),
  pi: generalProfile({
    domains: ['general', 'software-development'],
    toolClasses: ['filesystem', 'shell'],
  }),
  kimi: generalProfile({
    domains: ['general', 'software-development', 'research', 'document-production'],
    toolClasses: ['filesystem', 'shell'],
  }),
  mimo: generalProfile({
    domains: ['general', 'software-development'],
    toolClasses: ['filesystem', 'shell'],
  }),
  claude: generalProfile({
    domains: ['general', 'software-development', 'research', 'document-production'],
    toolClasses: ['filesystem', 'shell'],
  }),
  gemini: generalProfile({
    domains: ['general', 'research', 'document-production'],
    toolClasses: ['filesystem', 'shell'],
  }),
  opencode: generalProfile({
    domains: ['general', 'software-development'],
    inputTypes: ['text', 'image', 'file'],
    toolClasses: ['filesystem', 'shell'],
  }),
  qwen: generalProfile({
    domains: ['general', 'software-development', 'research'],
    toolClasses: ['filesystem', 'shell'],
  }),
  opencodereview: capabilityProfile({
    task: 'code_review',
    domains: ['software-review'],
    inputTypes: ['text'],
    outputTypes: ['text', 'evidence'],
    toolClasses: ['filesystem-read'],
    permissionModes: ['read-only'],
    latencyBand: 'unknown',
    costBand: 'unknown',
    contextLimitChars: 20000,
    resumable: false,
  }),
})

const DEFAULT_RUNTIME_CAPABILITIES = generalProfile({ resumable: false })
const REVIEW_ONLY_AGENT_KINDS = Object.freeze(new Set())

function boundedValues(value, allowed, fallback) {
  if (!Array.isArray(value) || !value.length) return [...fallback]
  const selected = [...new Set(value.filter(item => allowed.includes(item)))]
  return selected.length ? selected : [...fallback]
}

function declaredRoutingCapabilities(agent) {
  if (agent?.routingCapabilities && typeof agent.routingCapabilities === 'object') {
    return agent.routingCapabilities
  }
  const declared = agent?.capabilities
  if (!declared || typeof declared !== 'object') return null
  return {
    domains: declared.domains,
    inputTypes: declared.inputTypes,
    outputTypes: [
      'text',
      ...(Array.isArray(declared.eventTypes) && declared.eventTypes.includes('Artifact')
        ? ['artifact']
        : []),
      ...(Array.isArray(declared.eventTypes) && (
        declared.eventTypes.includes('Evidence') || declared.eventTypes.includes('SourceUsed')
      ) ? ['evidence'] : []),
    ],
    toolClasses: declared.toolClasses || ['agent-native'],
    permissionModes: declared.permissionModes,
    latencyBand: declared.latencyBand,
    costBand: declared.costBand,
    contextLimitChars: declared.contextLimitChars,
    resumable: typeof declared.resumable === 'boolean'
      ? declared.resumable
      : declared.session?.resume === true,
  }
}

function agentRuntimeCapabilities(kind, options = {}) {
  const base = AGENT_RUNTIME_CAPABILITIES[kind] || DEFAULT_RUNTIME_CAPABILITIES
  const declared = declaredRoutingCapabilities(options.agent)
  const support = options.attachmentSupport || {}
  const supportedInputs = [
    ...(declared?.inputTypes || base.inputTypes),
    ...AGENT_INPUT_TYPES.filter(type => type !== 'text' && Number(support[type]) > 0),
    ...(Number(support.file) > 0 ? ['image', 'audio', 'video', 'file'] : []),
  ]
  const domains = boundedValues(declared?.domains, AGENT_CAPABILITY_DOMAINS, base.domains)
  const task = domains.length === 1 && domains[0] === 'software-review'
    ? 'code_review'
    : base.task
  return capabilityProfile({
    task,
    domains,
    inputTypes: boundedValues(supportedInputs, AGENT_INPUT_TYPES, base.inputTypes),
    outputTypes: boundedValues(
      declared?.outputTypes, AGENT_OUTPUT_TYPES, base.outputTypes,
    ),
    toolClasses: boundedValues(
      declared?.toolClasses, AGENT_TOOL_CLASSES, base.toolClasses,
    ),
    permissionModes: boundedValues(
      declared?.permissionModes, AGENT_PERMISSION_MODES, base.permissionModes,
    ),
    latencyBand: AGENT_LATENCY_BANDS.includes(declared?.latencyBand)
      ? declared.latencyBand
      : base.latencyBand,
    costBand: AGENT_COST_BANDS.includes(declared?.costBand)
      ? declared.costBand
      : base.costBand,
    contextLimitChars: Number.isSafeInteger(declared?.contextLimitChars)
      && declared.contextLimitChars > 0
      ? Math.min(4 * 1024 * 1024, declared.contextLimitChars)
      : base.contextLimitChars,
    resumable: typeof declared?.resumable === 'boolean' ? declared.resumable : base.resumable,
  })
}

function normalizeOutcome(value) {
  const outcome = String(value || '')
  return OUTCOME_SET.has(outcome) ? outcome : ''
}

function normalizeExternalRunRef(value) {
  const ref = String(value || '')
  return EXTERNAL_RUN_REF.test(ref) ? ref : ''
}

function terminalAuthenticationDiagnostic(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text || text.length > 2000) return ''
  return /^HTTP\s+(?:401|403)\s*:\s*(?:unauthorized|forbidden|(?:invalid|expired|missing)\s+(?:access\s+token|token|credentials?|api[ _-]?key|authentication))(?:\s*\(request[ _-]?id:\s*[^()]{1,160}\))?\.?$/i
    .test(text)
    ? text
    : ''
}

// True only for explicit sign-in or API-key statements. Ambiguous refusals
// (HTTP 403, proxy or region blocks, "provider rejected") are classified as
// LOCAL_AGENT_ACCESS_DENIED so they are retried instead of signing the Agent out.
function authConfigurationFailure(detail) {
  return authFailureCertainty(detail) === 'definitive'
}

function authFailureCode(detail) {
  const certainty = authFailureCertainty(detail)
  if (certainty === 'definitive') return 'LOCAL_AGENT_AUTH_REQUIRED'
  if (certainty === 'ambiguous') return 'LOCAL_AGENT_ACCESS_DENIED'
  return ''
}

function failureCategory(code) {
  const value = String(code || '')
  if (value === 'LOCAL_AGENT_SESSION_INVALID') return 'session'
  if (value === 'LOCAL_AGENT_AUTH_REQUIRED' || value === 'LOCAL_WORKBUDDY_PROVIDER_AUTH') return 'authentication'
  if (value === 'LOCAL_AGENT_ACCESS_DENIED') return 'provider'
  if (value === 'LOCAL_AGENT_TIMEOUT') return 'timeout'
  if (value === 'LOCAL_AGENT_EXECUTION_STOPPED') return 'cancellation'
  if (value === 'LOCAL_AGENT_REFUSED') return 'refusal'
  if (/SPAWN|EXITED|PROCESS|OUTCOME|PROTOCOL|OUTPUT_LIMIT|EMPTY_RESPONSE/.test(value)) {
    return 'protocol'
  }
  return 'execution'
}

function agentRuntimeFailure(code, options = {}) {
  const normalizedCode = String(code || 'LOCAL_AGENT_UNKNOWN_FAILURE')
  const category = String(options.category || failureCategory(normalizedCode))
  return Object.freeze({
    code: normalizedCode,
    category,
    retryable: options.retryable === true
      || normalizedCode === 'LOCAL_AGENT_SESSION_INVALID',
    sessionInvalid: normalizedCode === 'LOCAL_AGENT_SESSION_INVALID',
  })
}

function agentRuntimeError(code, diagnostic = '', options = {}) {
  const failure = agentRuntimeFailure(code, options)
  const error = Object.assign(new Error(failure.code), { code: failure.code })
  Object.defineProperty(error, 'failure', {
    value: failure,
    enumerable: false,
    configurable: true,
  })
  const detail = String(diagnostic || '').trim()
  if (detail) {
    Object.defineProperty(error, 'diagnostic', {
      value: detail,
      enumerable: false,
      configurable: true,
    })
  }
  return error
}

function outcomeForAcpStopReason(stopReason) {
  if (stopReason === 'end_turn') return { outcome: 'completed' }
  if (['max_tokens', 'max_turn_requests'].includes(stopReason)) {
    return { outcome: 'partial' }
  }
  if (stopReason === 'cancelled') return { outcome: 'cancelled' }
  if (stopReason === 'refusal') {
    return {
      outcome: 'failed',
      failure: agentRuntimeFailure('LOCAL_AGENT_REFUSED'),
    }
  }
  return {
    outcome: 'failed',
    failure: agentRuntimeFailure('LOCAL_AGENT_OUTCOME_INVALID'),
  }
}

function normalizeAgentResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw agentRuntimeError('LOCAL_AGENT_OUTCOME_INVALID')
  }
  const outcome = normalizeOutcome(result.outcome)
  if (!outcome) throw agentRuntimeError('LOCAL_AGENT_OUTCOME_MISSING')
  return { ...result, outcome }
}

function requireTerminalAgentResult(result) {
  const normalized = normalizeAgentResult(result)
  if (NON_TERMINAL_OUTCOMES.has(normalized.outcome)) {
    throw agentRuntimeError('LOCAL_AGENT_OUTCOME_NON_TERMINAL', normalized.outcome)
  }
  if (normalized.outcome === 'cancelled') {
    throw agentRuntimeError('LOCAL_AGENT_EXECUTION_STOPPED')
  }
  if (normalized.outcome === 'failed') {
    let failure = normalized.failure?.code
      ? normalized.failure
      : agentRuntimeFailure('LOCAL_AGENT_PROCESS_FAILED')
    const diagnostic = String(normalized.diagnostic || normalized.text || '')
    // A structured failure whose diagnostic names an authentication problem is
    // an authentication failure even when the CLI reported a generic process
    // error, so the catalog can mark the Agent as needing a fresh login.
    if (failure.category !== 'authentication' && authConfigurationFailure(diagnostic)) {
      failure = agentRuntimeFailure('LOCAL_AGENT_AUTH_REQUIRED')
    } else if (failure.code === 'LOCAL_AGENT_PROCESS_FAILED'
        && authFailureCertainty(normalized.diagnostic) === 'ambiguous') {
      failure = agentRuntimeFailure('LOCAL_AGENT_ACCESS_DENIED')
    }
    throw agentRuntimeError(
      failure.code,
      normalized.diagnostic || normalized.text,
      failure,
    )
  }
  const authenticationDiagnostic = terminalAuthenticationDiagnostic(normalized.text)
  if (authenticationDiagnostic) {
    throw agentRuntimeError(
      authFailureCode(authenticationDiagnostic) || 'LOCAL_AGENT_ACCESS_DENIED',
      authenticationDiagnostic,
    )
  }
  return normalized
}

function isReviewOnlyAgentKind(kind) {
  return REVIEW_ONLY_AGENT_KINDS.has(kind)
}

function isCodeReviewAgentKind(kind) {
  return agentRuntimeCapabilities(kind).task === 'code_review'
}

module.exports = {
  AGENT_OUTCOMES,
  AGENT_CAPABILITY_DOMAINS,
  AGENT_COST_BANDS,
  AGENT_INPUT_TYPES,
  AGENT_LATENCY_BANDS,
  AGENT_OUTPUT_TYPES,
  AGENT_PERMISSION_MODES,
  AGENT_RUNTIME_CAPABILITIES,
  AGENT_TOOL_CLASSES,
  NON_TERMINAL_OUTCOMES,
  SUCCESSFUL_OUTCOMES,
  agentRuntimeCapabilities,
  agentRuntimeError,
  agentRuntimeFailure,
  authConfigurationFailure,
  authFailureCode,
  isCodeReviewAgentKind,
  isReviewOnlyAgentKind,
  normalizeAgentResult,
  normalizeExternalRunRef,
  normalizeOutcome,
  outcomeForAcpStopReason,
  requireTerminalAgentResult,
  terminalAuthenticationDiagnostic,
}

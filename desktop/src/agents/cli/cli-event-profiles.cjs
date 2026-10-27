const { StringDecoder } = require('node:string_decoder')
const { createHash } = require('node:crypto')
const {
  classifyCliOutcome,
  codexProgressEvent,
  createJsonLineParser,
  createStructuredOutputAccumulator,
  hermesSessionRef,
  normalizeOpenClawOutput,
  parseClaudeQwenOutput,
  parseCodexOutput,
  parseGeminiOutput,
  parseKimiOutput,
  parseMimoOutput,
  parseOpenCodeOutput,
  parseOpenCodeReviewOutput,
  parsePiOutput,
  parseWorkBuddyOutput,
  readHermesFinalResponse,
  readHermesMessageWatermark,
  stripAnsi,
} = require('./cli-output-parsers.cjs')
const {
  acpRuntimeEvents,
  claudeQwenRuntimeEvents,
  codexRuntimeEvents,
  createAcpRuntimeState,
  createClaudeQwenRuntimeState,
  createGeminiRuntimeState,
  createPiRuntimeState,
  finalOnlyRuntimeEvents,
  geminiStreamJsonRuntimeEvents,
  kimiStreamJsonRuntimeEvents,
  mimoJsonRuntimeEvents,
  openCodeJsonRuntimeEvents,
  piJsonRuntimeEvents,
} = require('./cli-runtime-event-mappers.cjs')

function createStatelessRuntimeState() {
  return {}
}

function publicLifecycleId(state, value) {
  const raw = String(value || '')
  if (!raw) return ''
  if (/^[A-Za-z0-9._:-]{1,100}$/.test(raw)) return raw
  const ids = state?.publicLifecycleIds
  if (ids?.has(raw)) return ids.get(raw)
  const publicId = `lifecycle:${createHash('sha256').update(raw).digest('hex')}`
  ids?.set(raw, publicId)
  return publicId
}

function noProgressEvent() {
  return null
}

function createDefaultRunContext() {
  return null
}

function resolveDefaultSessionRef(input = {}) {
  return String(input.sessionRef || '')
}

async function finalizeDefaultResult(input = {}) {
  return input.result
}

const MAX_FINAL_TEXT_CHARS = 1024 * 1024

function appendFinalText(state, value) {
  const remaining = MAX_FINAL_TEXT_CHARS - state.text.length
  if (remaining > 0) state.text += String(value || '').slice(0, remaining)
}

const FINAL_OUTPUT_PARSERS = Object.freeze({
  codex: parseCodexOutput,
  openclaw: stdout => ({ text: normalizeOpenClawOutput(stdout), sessionRef: '' }),
  workbuddy: parseWorkBuddyOutput,
  pi: parsePiOutput,
  kimi: parseKimiOutput,
  mimo: parseMimoOutput,
  claude: parseClaudeQwenOutput,
  gemini: parseGeminiOutput,
  opencode: parseOpenCodeOutput,
  qwen: parseClaudeQwenOutput,
  opencodereview: parseOpenCodeReviewOutput,
})

function createFinalOutputAccumulator(kind) {
  return (sessionRef = '') => {
    const structured = createStructuredOutputAccumulator(kind, sessionRef)
    const decoder = new StringDecoder('utf8')
    const raw = { text: '' }
    return {
      ...structured,
      capture(chunk) {
        appendFinalText(raw, decoder.write(chunk))
      },
      end(context = {}) {
        appendFinalText(raw, decoder.end())
        const classification = classifyCliOutcome(kind, raw.text)
        const result = structured.end(context)
        if (result) return result
        const parsed = FINAL_OUTPUT_PARSERS[kind](raw.text)
        const text = String(parsed?.text || '').trim()
        return {
          ...parsed,
          text,
          sessionRef: String(parsed?.sessionRef || context.sessionRef || sessionRef || ''),
          outcome: parsed?.outcome || context.outcome || classification.outcome
            || (text ? 'partial' : 'failed'),
          ...((context.failure || classification.failure) && !parsed?.failure
            ? { failure: context.failure || classification.failure }
            : {}),
          ...((context.diagnostic || classification.diagnostic) && !parsed?.diagnostic
            ? { diagnostic: context.diagnostic || classification.diagnostic }
            : {}),
        }
      },
    }
  }
}

function protocolStopOutcome(stopReason, fallback, text) {
  if (['accepted', 'running', 'waiting_input', 'waiting_permission', 'partial', 'completed', 'failed', 'cancelled']
    .includes(fallback)) return fallback
  if (['end_turn', 'stop', 'success'].includes(String(stopReason || '').toLowerCase())) {
    return 'completed'
  }
  if (['error', 'failed', 'refusal'].includes(String(stopReason || '').toLowerCase())) return 'failed'
  if (['cancelled', 'canceled', 'aborted'].includes(String(stopReason || '').toLowerCase())) {
    return 'cancelled'
  }
  return text ? 'partial' : 'failed'
}

function createAcpFinalOutputAccumulator(sessionRef = '') {
  const state = { sessionRef: String(sessionRef || ''), stopReason: '', text: '' }
  return {
    format: 'protocol-record',
    ingest(record) {
      const update = record?.params?.update || record?.update || record
      const nextSessionRef = record?.params?.sessionId || record?.sessionId || update?.sessionId
      if (typeof nextSessionRef === 'string' && nextSessionRef) state.sessionRef = nextSessionRef
      if (typeof update?.stopReason === 'string') state.stopReason = update.stopReason
      if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        appendFinalText(state, update.content.text)
      }
    },
    end(context = {}) {
      const text = stripAnsi(state.text).trim()
      return {
        text,
        sessionRef: String(context.sessionRef || state.sessionRef || ''),
        outcome: protocolStopOutcome(context.stopReason || state.stopReason, context.outcome, text),
      }
    },
  }
}

function createHermesLegacyFinalOutputAccumulator(sessionRef = '') {
  const decoder = new StringDecoder('utf8')
  const state = { text: '' }
  return {
    format: 'text',
    write(chunk) {
      appendFinalText(state, decoder.write(chunk))
    },
    end(context = {}) {
      appendFinalText(state, decoder.end())
      const text = stripAnsi(state.text).trim()
      return {
        text,
        sessionRef: String(context.sessionRef || sessionRef || ''),
        outcome: protocolStopOutcome(context.stopReason, context.outcome || 'completed', text),
      }
    },
  }
}

function createHermesLegacyRunContext(options = {}) {
  const watermarkFn = options.hermesMessageWatermarkFn || readHermesMessageWatermark
  try {
    const messageWatermark = watermarkFn({
      home: options.home,
      existsFn: options.hermesStateExistsFn,
      queryFn: options.hermesStateQueryFn,
    })
    return {
      messageWatermark: Number.isSafeInteger(messageWatermark) && messageWatermark >= 0
        ? messageWatermark
        : null,
    }
  } catch {
    return { messageWatermark: null }
  }
}

function resolveHermesLegacySessionRef(input = {}) {
  return hermesSessionRef(input.stderr) || String(input.sessionRef || '')
}

async function finalizeHermesLegacyResult(input = {}) {
  const { options = {}, result, runContext, sessionRef } = input
  if (sessionRef && typeof options.onSessionRef === 'function') {
    await options.onSessionRef(sessionRef, { transport: 'legacy' })
  }
  if (!sessionRef || !Number.isSafeInteger(runContext?.messageWatermark)) return result
  const finalResponseFn = options.hermesFinalResponseFn || readHermesFinalResponse
  let finalResponse = ''
  try {
    finalResponse = finalResponseFn(sessionRef, {
      home: options.home,
      afterMessageId: runContext.messageWatermark,
      existsFn: options.hermesStateExistsFn,
      queryFn: options.hermesStateQueryFn,
    })
  } catch { /* fall back to the official --quiet stdout */ }
  const text = typeof finalResponse === 'string'
    ? finalResponse.trim().slice(0, MAX_FINAL_TEXT_CHARS)
    : ''
  return text ? { ...result, text } : result
}

function profile(input) {
  const createState = () => {
    const state = input.createState()
    const runtimeState = state && typeof state === 'object' ? state : {}
    runtimeState.publicLifecycleIds ||= new Map()
    return runtimeState
  }
  return Object.freeze({
    profileId: input.profileId,
    protocol: input.protocol,
    framing: input.framing,
    source: input.source,
    capabilities: Object.freeze({
      answerMode: input.capabilities.answerMode,
      tools: Object.freeze({ ...input.capabilities.tools }),
      plan: input.capabilities.plan,
      reasoning: input.capabilities.reasoning,
      session: input.capabilities.session,
      terminal: input.capabilities.terminal,
    }),
    createDecoder: input.createDecoder,
    createState,
    mapEvent(event, state) {
      return input.mapEvent(event, state).map(runtimeEvent => (
        runtimeEvent?.id
          ? { ...runtimeEvent, id: publicLifecycleId(state, runtimeEvent.id) }
          : runtimeEvent
      ))
    },
    mapProgress: input.mapProgress || noProgressEvent,
    createRunContext: input.createRunContext || createDefaultRunContext,
    resolveSessionRef: input.resolveSessionRef || resolveDefaultSessionRef,
    finalizeResult: input.finalizeResult || finalizeDefaultResult,
    createFinalOutputAccumulator: input.createFinalOutputAccumulator,
  })
}

const FULL_TOOL_LIFECYCLE = Object.freeze({ start: true, update: true, result: true })
const START_RESULT_TOOL_LIFECYCLE = Object.freeze({ start: true, update: false, result: true })
const START_ONLY_TOOL_LIFECYCLE = Object.freeze({ start: true, update: false, result: false })
const NO_TOOL_LIFECYCLE = Object.freeze({ start: false, update: false, result: false })

const CODEX_APP_SERVER_PROFILE = profile({
  profileId: 'codex-app-server-jsonl-v1',
  protocol: 'codex-app-server',
  framing: 'jsonl',
  source: 'stdout',
  capabilities: {
    answerMode: 'delta', tools: START_RESULT_TOOL_LIFECYCLE,
    plan: true, reasoning: true, session: true, terminal: true,
  },
  createDecoder: createJsonLineParser,
  createState: createStatelessRuntimeState,
  mapEvent: codexRuntimeEvents,
  mapProgress: codexProgressEvent,
  createFinalOutputAccumulator: createFinalOutputAccumulator('codex'),
})

const ANTHROPIC_STREAM_JSON_PROFILE = profile({
  profileId: 'anthropic-stream-json-v1',
  protocol: 'anthropic-stream-json',
  framing: 'jsonl',
  source: 'stdout',
  capabilities: {
    answerMode: 'delta', tools: FULL_TOOL_LIFECYCLE,
    plan: true, reasoning: true, session: true, terminal: true,
  },
  createDecoder: createJsonLineParser,
  createState: createClaudeQwenRuntimeState,
  mapEvent: claudeQwenRuntimeEvents,
  createFinalOutputAccumulator: createFinalOutputAccumulator('claude'),
})

const ACP_JSONRPC_PROFILE = profile({
  profileId: 'acp-jsonrpc-v1',
  protocol: 'acp',
  framing: 'jsonrpc-jsonl',
  source: 'acp',
  capabilities: {
    answerMode: 'delta', tools: FULL_TOOL_LIFECYCLE,
    plan: true, reasoning: false, session: true, terminal: true,
  },
  createDecoder: createJsonLineParser,
  createState: createAcpRuntimeState,
  mapEvent: acpRuntimeEvents,
  createFinalOutputAccumulator: createAcpFinalOutputAccumulator,
})

const MIMO_JSON_EVENTS_PROFILE = profile({
  profileId: 'mimo-json-events-v1',
  protocol: 'mimo-json-events',
  framing: 'jsonl',
  source: 'stdout',
  capabilities: {
    answerMode: 'delta', tools: NO_TOOL_LIFECYCLE,
    plan: false, reasoning: false, session: true, terminal: true,
  },
  createDecoder: createJsonLineParser,
  createState: createStatelessRuntimeState,
  mapEvent: mimoJsonRuntimeEvents,
  createFinalOutputAccumulator: createFinalOutputAccumulator('mimo'),
})

const GEMINI_STREAM_JSON_PROFILE = profile({
  profileId: 'gemini-stream-json-v1',
  protocol: 'gemini-stream-json',
  framing: 'jsonl',
  source: 'stdout',
  capabilities: {
    answerMode: 'delta', tools: START_RESULT_TOOL_LIFECYCLE,
    plan: false, reasoning: false, session: true, terminal: true,
  },
  createDecoder: createJsonLineParser,
  createState: createGeminiRuntimeState,
  mapEvent: geminiStreamJsonRuntimeEvents,
  createFinalOutputAccumulator: createFinalOutputAccumulator('gemini'),
})

const OPENCODE_JSON_EVENTS_PROFILE = profile({
  profileId: 'opencode-json-events-v1',
  protocol: 'opencode-json-events',
  framing: 'jsonl',
  source: 'stdout',
  capabilities: {
    answerMode: 'delta', tools: NO_TOOL_LIFECYCLE,
    plan: false, reasoning: false, session: true, terminal: true,
  },
  createDecoder: createJsonLineParser,
  createState: createStatelessRuntimeState,
  mapEvent: openCodeJsonRuntimeEvents,
  createFinalOutputAccumulator: createFinalOutputAccumulator('opencode'),
})

const PI_JSON_EVENTS_PROFILE = profile({
  profileId: 'pi-json-events-v2',
  protocol: 'pi-json',
  framing: 'jsonl',
  source: 'stdout',
  capabilities: {
    answerMode: 'delta', tools: FULL_TOOL_LIFECYCLE,
    plan: false, reasoning: true, session: true, terminal: true,
  },
  createDecoder: createJsonLineParser,
  createState: createPiRuntimeState,
  mapEvent: piJsonRuntimeEvents,
  createFinalOutputAccumulator: createFinalOutputAccumulator('pi'),
})

const OPENCLAW_TERMINAL_DOCUMENT_PROFILE = profile({
  profileId: 'openclaw-terminal-document-v1',
  protocol: 'openclaw-terminal-document',
  framing: 'document',
  source: 'stdout',
  capabilities: {
    answerMode: 'final', tools: NO_TOOL_LIFECYCLE,
    plan: false, reasoning: false, session: false, terminal: true,
  },
  createDecoder: null,
  createState: createStatelessRuntimeState,
  mapEvent: finalOnlyRuntimeEvents,
  createFinalOutputAccumulator: createFinalOutputAccumulator('openclaw'),
})

const OPENCODE_REVIEW_TERMINAL_DOCUMENT_PROFILE = profile({
  profileId: 'opencodereview-terminal-document-v1',
  protocol: 'opencodereview-terminal-document',
  framing: 'document',
  source: 'stdout',
  capabilities: {
    answerMode: 'final', tools: NO_TOOL_LIFECYCLE,
    plan: false, reasoning: false, session: false, terminal: true,
  },
  createDecoder: null,
  createState: createStatelessRuntimeState,
  mapEvent: finalOnlyRuntimeEvents,
  createFinalOutputAccumulator: createFinalOutputAccumulator('opencodereview'),
})

const WORKBUDDY_TERMINAL_RESULT_PROFILE = profile({
  profileId: 'workbuddy-terminal-result-json-v1',
  protocol: 'workbuddy-terminal-result-json',
  framing: 'document',
  source: 'stdout',
  capabilities: {
    answerMode: 'final', tools: NO_TOOL_LIFECYCLE,
    plan: false, reasoning: false, session: true, terminal: true,
  },
  createDecoder: null,
  createState: createStatelessRuntimeState,
  mapEvent: finalOnlyRuntimeEvents,
  createFinalOutputAccumulator: createFinalOutputAccumulator('workbuddy'),
})

const KIMI_STREAM_JSON_PROFILE = profile({
  profileId: 'assistant-jsonl-v1',
  protocol: 'assistant-jsonl',
  framing: 'jsonl',
  source: 'stdout',
  capabilities: {
    answerMode: 'delta', tools: NO_TOOL_LIFECYCLE,
    plan: false, reasoning: false, session: true, terminal: true,
  },
  createDecoder: createJsonLineParser,
  createState: createStatelessRuntimeState,
  mapEvent: kimiStreamJsonRuntimeEvents,
  createFinalOutputAccumulator: createFinalOutputAccumulator('kimi'),
})

const HERMES_FINAL_TEXT_PROFILE = profile({
  profileId: 'terminal-text-v1',
  protocol: 'terminal-text',
  framing: 'document',
  source: 'stdout',
  capabilities: {
    answerMode: 'final', tools: NO_TOOL_LIFECYCLE,
    plan: false, reasoning: false, session: true, terminal: true,
  },
  createDecoder: null,
  createState: createStatelessRuntimeState,
  mapEvent: finalOnlyRuntimeEvents,
  createRunContext: createHermesLegacyRunContext,
  resolveSessionRef: resolveHermesLegacySessionRef,
  finalizeResult: finalizeHermesLegacyResult,
  createFinalOutputAccumulator: createHermesLegacyFinalOutputAccumulator,
})

const HERMES_STREAM_JSON_PROFILE = profile({
  profileId: 'hermes-stream-json-v1',
  protocol: 'hermes-stream-json',
  framing: 'jsonl',
  source: 'stdout',
  capabilities: {
    answerMode: 'delta', tools: START_RESULT_TOOL_LIFECYCLE,
    plan: false, reasoning: false, session: true, terminal: true,
  },
  createDecoder: createJsonLineParser,
  createState: createStatelessRuntimeState,
  mapEvent(event) {
    if (event.type === 'text' && typeof event.text === 'string') {
      return [{ type: 'answer_delta', status: 'running', delta: event.text }]
    }
    if (['tool_use', 'tool_result'].includes(event.type)) {
      return [{
        id: event.tool_call_id || event.name,
        type: event.type === 'tool_use' ? 'tool_start' : 'tool_result_summary',
        title: event.name || 'tool',
        status: event.type === 'tool_use' ? 'running' : event.is_error ? 'failed' : 'completed',
      }]
    }
    return []
  },
  async finalizeResult({ result, options }) {
    // Both native chat formats use the same resumable conversation IDs.
    if (result.sessionRef) await options.onSessionRef?.(result.sessionRef, { transport: 'legacy' })
    return result
  },
  createFinalOutputAccumulator(sessionRef = '') {
    const state = { text: '', sessionRef, outcome: 'partial' }
    const ingest = event => {
      if (typeof event.session_id === 'string' && event.session_id) state.sessionRef = event.session_id
      if (event.type === 'text' && typeof event.text === 'string') appendFinalText(state, event.text)
      if (event.type === 'result') {
        if (typeof event.text === 'string') state.text = event.text.slice(0, MAX_FINAL_TEXT_CHARS)
        state.outcome = event.exit_code === 0 && !event.error ? 'completed' : 'failed'
        if (event.error) state.error = String(event.error)
      }
    }
    const parser = createJsonLineParser(ingest)
    return {
      ingest,
      write: chunk => parser.write(chunk),
      end() {
        parser.end()
        return { ...state }
      },
    }
  },
})

const ZCODE_JSON_PROFILE = profile({
  profileId: 'zcode-prompt-json-v1',
  protocol: 'zcode-prompt-json',
  framing: 'document',
  source: 'stdout',
  capabilities: {
    answerMode: 'final', tools: NO_TOOL_LIFECYCLE,
    plan: false, reasoning: false, session: true, terminal: true,
  },
  createState: createStatelessRuntimeState,
  createDecoder: null,
  mapEvent: finalOnlyRuntimeEvents,
  createFinalOutputAccumulator() {
    const decoder = new StringDecoder('utf8')
    const raw = { text: '' }
    return {
      capture(chunk) { appendFinalText(raw, decoder.write(chunk)) },
      end() {
        appendFinalText(raw, decoder.end())
        let value
        try { value = JSON.parse(raw.text) } catch { return { text: '', outcome: 'failed' } }
        if (typeof value.response !== 'string' || typeof value.sessionId !== 'string') {
          return { text: '', outcome: 'failed' }
        }
        return {
          text: value.response,
          sessionRef: value.sessionId,
          outcome: ['idle', 'completed'].includes(value.projection?.status) ? 'completed' : 'partial',
        }
      },
    }
  },
})

const CONNECTOR_EVENT_PROFILES = Object.freeze({
  codex: CODEX_APP_SERVER_PROFILE,
  hermes: ACP_JSONRPC_PROFILE,
  openclaw: ACP_JSONRPC_PROFILE,
  workbuddy: WORKBUDDY_TERMINAL_RESULT_PROFILE,
  zcode: ZCODE_JSON_PROFILE,
  pi: PI_JSON_EVENTS_PROFILE,
  kimi: ACP_JSONRPC_PROFILE,
  mimo: MIMO_JSON_EVENTS_PROFILE,
  claude: ANTHROPIC_STREAM_JSON_PROFILE,
  gemini: GEMINI_STREAM_JSON_PROFILE,
  opencode: OPENCODE_JSON_EVENTS_PROFILE,
  qwen: ANTHROPIC_STREAM_JSON_PROFILE,
  opencodereview: OPENCODE_REVIEW_TERMINAL_DOCUMENT_PROFILE,
})

const TRANSPORT_EVENT_PROFILES = Object.freeze({
  hermes: Object.freeze({ legacy: HERMES_FINAL_TEXT_PROFILE, 'stream-json': HERMES_STREAM_JSON_PROFILE }),
  openclaw: Object.freeze({ legacy: OPENCLAW_TERMINAL_DOCUMENT_PROFILE }),
  kimi: Object.freeze({ 'stream-json': KIMI_STREAM_JSON_PROFILE }),
  mimo: Object.freeze({ acp: ACP_JSONRPC_PROFILE }),
  pi: Object.freeze({ json: PI_JSON_EVENTS_PROFILE }),
  opencode: Object.freeze({ acp: ACP_JSONRPC_PROFILE }),
  workbuddy: Object.freeze({ 'stream-json': ANTHROPIC_STREAM_JSON_PROFILE }),
})

function resolveConnectorEventProfile(kind, options = {}) {
  const base = CONNECTOR_EVENT_PROFILES[kind]
  if (!base) return null
  const transport = typeof options.transport === 'string' ? options.transport : ''
  if (!transport || transport === base.protocol) return base
  return TRANSPORT_EVENT_PROFILES[kind]?.[transport] || null
}

function connectorLimitedRuntimeEvent(kind, profile) {
  const tools = profile?.capabilities?.tools
  const limited = profile?.capabilities?.answerMode === 'final' || !tools?.start || !tools?.result
  if (!profile || !limited || !/^[A-Za-z0-9._:-]{1,80}$/.test(String(kind || ''))) return null
  return {
    id: `${kind}-connector`,
    type: 'warning',
    status: 'waiting',
    title: 'connector_limited',
  }
}

module.exports = {
  CONNECTOR_EVENT_PROFILES,
  connectorLimitedRuntimeEvent,
  resolveConnectorEventProfile,
}

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { StringDecoder } = require('node:string_decoder')
const { JSONParser } = require('@streamparser/json')
const { agentRuntimeFailure } = require('../agent-runtime-contract.cjs')
const { codexProgressTitle } = require('./cli-runtime-summaries.cjs')

const MAX_RUNTIME_JSON_PENDING_CHARS = 1024 * 1024
const MAX_STRUCTURED_JSON_BYTES = 64 * 1024 * 1024
const MAX_STRUCTURED_TEXT_CHARS = 1024 * 1024
const STRUCTURED_JSONL_KINDS = new Set([
  'codex', 'workbuddy', 'pi', 'kimi', 'mimo', 'claude', 'gemini', 'opencode', 'qwen',
])
const STRUCTURED_DOCUMENT_KINDS = new Set(['openclaw', 'opencodereview'])
function parseCodexOutput(stdout) {
  let sessionRef = ''
  const texts = []
  for (const line of String(stdout || '').split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
        sessionRef = event.thread_id
      }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message'
          && typeof event.item.text === 'string') {
        texts.push(event.item.text)
      }
    } catch { /* ignore non-JSON diagnostics */ }
  }
  return { text: texts.join('\n').trim(), sessionRef }
}

function codexProgressEvent(event) {
  if (event?.type === 'turn.started') {
    return { id: 'turn', title: 'process', status: 'in_progress' }
  }
  if (event?.type === 'turn.completed') {
    return { id: 'turn', title: 'process', status: 'completed' }
  }
  if (!['item.started', 'item.completed'].includes(event?.type)
      || !event.item || event.item.type === 'agent_message') {
    return null
  }
  const rawId = String(event.item.id || '')
  const id = /^[A-Za-z0-9._:-]{1,100}$/.test(rawId) ? rawId : ''
  const failed = event.item.status === 'failed'
    || (Number.isInteger(event.item.exit_code) && event.item.exit_code !== 0)
  return {
    ...(id ? { id } : {}),
    title: codexProgressTitle(event.item),
    status: failed
      ? 'failed'
      : event.type === 'item.started' ? 'in_progress' : 'completed',
  }
}

function createJsonLineParser(onEvent) {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  const consume = (flush = false) => {
    const lines = pending.split(/\r?\n/)
    const remainder = lines.pop() || ''
    pending = flush ? '' : remainder
    if (flush && remainder.trim()) lines.push(remainder)
    for (const line of lines) {
      if (!line.trim()) continue
      try { onEvent(JSON.parse(line)) } catch { /* ignore non-JSON diagnostics */ }
    }
  }
  return {
    write(chunk) {
      pending += decoder.write(chunk)
      consume(false)
      if (pending.length > MAX_RUNTIME_JSON_PENDING_CHARS) pending = ''
    },
    end() {
      pending += decoder.end()
      consume(true)
    },
  }
}

function appendStructuredText(state, value, separator = '\n') {
  const text = String(value || '')
  if (!text || state.text.length >= MAX_STRUCTURED_TEXT_CHARS) return
  const prefix = state.text && separator ? separator : ''
  const remaining = MAX_STRUCTURED_TEXT_CHARS - state.text.length
  state.text += `${prefix}${text}`.slice(0, remaining)
}

function stripPiInternalPromptEcho(value) {
  let text = String(value || '').trim()
  if (!text) return ''
  const preamble = /^You are participating in a local multi-agent discussion\.[\s\S]*?^Answer the user naturally(?: in Markdown)?\.?\s*/im
  text = text.replace(preamble, '').trim()
  // Pi may resume from a compact continuation prompt and echo only the
  // protocol instructions or the selected Harness records. Remove those
  // internal lines while preserving any user-facing text on the same line.
  text = text.replace(/^Do not output JSON, XML, receipt markers, protocol labels, hidden orchestration instructions, or a fixed response template\.\s*/im, '')
  text = text.replace(/^Do not claim another Agent performed work, and do not modify shared workspace state unless this turn explicitly grants that permission\.\s*/im, '')
  const lines = text.split(/\r?\n/)
  const cleaned = []
  let inRecords = false
  for (const line of lines) {
    const valueLine = line.trim()
    if (/^Selected records from completed phases:\s*$/i.test(valueLine)) {
      inRecords = true
      continue
    }
    if (inRecords) {
      if (/^MELDWORK_V4_COLLABORATION_PACKAGE_V1$/i.test(valueLine)
          || /^\[index\]\s+\S+/i.test(valueLine)
          || /^Artifact:\s+\S+/i.test(valueLine)
          || /^Evidence:\s+\S+/i.test(valueLine)) continue
      const phasePrefix = /^(?:\[(?:challenge|proposal)\]\s+agent=\S+\s+Completed the (?:challenge|proposal) phase\.\s*)/i
      const remainder = line.replace(phasePrefix, '')
      if (remainder !== line) {
        if (remainder.trim()) cleaned.push(remainder)
        continue
      }
      inRecords = false
    }
    cleaned.push(line)
  }
  return cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function stripPiPromptEcho(value, prompt) {
  const text = String(value || '').trim()
  const expected = String(prompt || '').trim()
  if (expected && text.startsWith(expected)) {
    return text.slice(expected.length).trim()
  }
  return stripPiInternalPromptEcho(text)
}

function stripExactMeldworkPromptEcho(value, prompt) {
  const text = String(value || '')
  const expected = String(prompt || '').trim()
  if (!expected.includes('Current user task (authoritative):')
      || !expected.startsWith('You are participating in the local ')) {
    return text.trim()
  }
  const candidate = text.trimStart()
  return candidate.startsWith(expected)
    ? candidate.slice(expected.length).trimStart()
    : text.trim()
}

function markStructuredFailure(state, code = 'LOCAL_AGENT_PROCESS_FAILED', diagnostic = '') {
  state.outcome = 'failed'
  state.failure = agentRuntimeFailure(code)
  if (diagnostic) state.diagnostic = diagnostic
}

function structuredEventFailed(event) {
  return event?.type === 'error'
    || event?.status === 'failed'
    || event?.status === 'error'
    || event?.is_error === true
    || String(event?.subtype || '').startsWith('error')
}

function stepFinishOutcome(reason) {
  const value = String(reason || '').toLowerCase()
  if (['stop', 'end_turn'].includes(value)) return 'completed'
  if (['length', 'max_tokens', 'max_turn_requests'].includes(value)) return 'partial'
  if (['cancelled', 'canceled', 'aborted'].includes(value)) return 'cancelled'
  if (['error', 'refusal'].includes(value)) return 'failed'
  return 'partial'
}

function structuredResultDiagnostic(event) {
  const parts = []
  if (typeof event?.error === 'string' && event.error.trim()) parts.push(event.error.trim())
  else if (event?.error?.message) parts.push(String(event.error.message))
  if (typeof event?.result === 'string' && event.result.trim()) parts.push(event.result.trim())
  if (Array.isArray(event?.errors)) {
    parts.push(...event.errors.map(value => String(value || '').trim()).filter(Boolean))
  }
  return parts.join('\n')
}

function ingestStructuredEvent(state, event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return
  state.seen = true
  if (['workbuddy', 'claude', 'qwen'].includes(state.kind)
      && event.type === 'result') {
    if (typeof event.session_id === 'string') state.sessionRef = event.session_id
    if (typeof event.result === 'string') {
      state.failure = null
      state.diagnostic = ''
      state.text = ''
      appendStructuredText(state, event.result, '')
      state.outcome = event.is_error === true ? 'partial' : 'completed'
      return
    }
    // An error result without a usable result string still carries the CLI's
    // error list; keep it as the failure diagnostic so authentication and
    // session problems are classified instead of surfacing as a bare
    // LOCAL_AGENT_PROCESS_FAILED.
    if (event.is_error === true || String(event.subtype || '').startsWith('error')) {
      markStructuredFailure(state, 'LOCAL_AGENT_PROCESS_FAILED', structuredResultDiagnostic(event))
    }
    return
  }
  if (structuredEventFailed(event)) {
    markStructuredFailure(state)
    return
  }

  if (state.kind === 'codex') {
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      state.sessionRef = event.thread_id
    }
    if (event.type === 'item.completed' && event.item?.type === 'agent_message'
        && typeof event.item.text === 'string') {
      appendStructuredText(state, event.item.text)
    }
    if (event.type === 'turn.completed') state.outcome = 'completed'
    return
  }

  if (['workbuddy', 'claude', 'qwen'].includes(state.kind)) return

  if (state.kind === 'kimi') {
    if (event.role === 'assistant' && typeof event.content === 'string') {
      appendStructuredText(state, event.content)
    }
    if (event.type === 'session.resume_hint' && typeof event.session_id === 'string') {
      state.sessionRef = event.session_id
      state.outcome = 'completed'
    }
    return
  }

  if (state.kind === 'pi') {
    if (event.type === 'session' && typeof event.id === 'string') state.sessionRef = event.id
    const update = event.assistantMessageEvent
    if (event.type === 'message_update' && update?.type === 'text_delta'
        && typeof update.delta === 'string') {
      appendStructuredText(state, update.delta, '')
    }
    if (event.type === 'message_end' && event.message?.role === 'assistant'
        && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          if (!state.text) appendStructuredText(state, block.text, '')
        }
      }
      const stopReason = event.message.stopReason
      if (stopReason) state.outcome = stepFinishOutcome(stopReason)
    }
    if (event.type === 'turn_end') {
      state.outcome = stepFinishOutcome(event.message?.stopReason || event.stopReason || 'stop')
    }
    if (event.type === 'agent_end') {
      const lastAssistant = event.messages?.findLast(message => message?.role === 'assistant')
      if (lastAssistant?.stopReason) state.outcome = stepFinishOutcome(lastAssistant.stopReason)
      else if (!state.outcome) state.outcome = 'completed'
      if (state.outcome === 'completed' && event.willRetry !== true) {
        state.failure = null
        state.diagnostic = ''
      }
    }
    if (state.outcome === 'failed') markStructuredFailure(state)
    return
  }

  if (['mimo', 'opencode'].includes(state.kind)) {
    if (typeof event.sessionID === 'string') state.sessionRef = event.sessionID
    if (event.type === 'text' && event.part?.type === 'text'
        && typeof event.part.text === 'string') {
      appendStructuredText(state, event.part.text)
    }
    if (event.type === 'step_finish' || event.part?.type === 'step-finish') {
      state.outcome = stepFinishOutcome(event.part?.reason || event.reason)
      if (state.outcome === 'failed') markStructuredFailure(state)
    }
    return
  }

  if (state.kind === 'gemini') {
    if (event.type === 'init' && typeof event.session_id === 'string') {
      state.sessionRef = event.session_id
    }
    if (event.type === 'message' && event.role === 'assistant'
        && typeof event.content === 'string') {
      appendStructuredText(state, event.content, '')
    }
    if (event.type === 'result') {
      if (event.status === 'success') state.outcome = 'completed'
      else if (event.status === 'cancelled') state.outcome = 'cancelled'
      else markStructuredFailure(state, 'LOCAL_AGENT_OUTCOME_INVALID')
    }
  }
}

function openClawDocumentValue(state, input) {
  const stack = input.stack.map(item => item.key).filter(value => value != null)
  const parentKey = stack.at(-1)
  if (['text', 'content'].includes(input.key)
      && ['payloads', 'messages', 'result', 'response'].includes(stack[0])) {
    appendStructuredText(state, input.value)
  }
  if (input.key === 'stopReason' || input.key === 'finishReason') {
    state.stopReason = String(input.value || '')
  }
  if (input.key === 'aborted' && parentKey === 'meta') state.aborted = input.value === true
}

function openCodeReviewCommentText(comment) {
  if (!comment || typeof comment !== 'object') return ''
  const location = typeof comment.path === 'string' && comment.path.trim()
    ? `${comment.path.trim()}${Number.isInteger(comment.start_line)
      ? `:${comment.start_line}${Number.isInteger(comment.end_line)
        && comment.end_line !== comment.start_line ? `-${comment.end_line}` : ''}`
      : ''}`
    : ''
  const metadata = [comment.category, comment.severity]
    .filter(value => typeof value === 'string' && value.trim())
    .map(value => value.trim())
    .join(' / ')
  const content = typeof comment.content === 'string' ? comment.content.trim() : ''
  const suggestion = typeof comment.suggestion_code === 'string'
    ? comment.suggestion_code.trim()
    : ''
  const header = [location, metadata && `[${metadata}]`].filter(Boolean).join(' ')
  return [
    header,
    content,
    suggestion ? `Suggested change:\n${suggestion}` : '',
  ].filter(Boolean).join('\n')
}

function openCodeReviewDocumentValue(state, input) {
  const stack = input.stack.map(item => item.key).filter(value => value != null)
  if (input.key === 'manifest' && stack.length === 0) state.manifestSeen = true
  if (input.key === 'message' && stack.length === 0) appendStructuredText(state, input.value)
  if (input.key === 'project_summary' && stack.length === 0) {
    appendStructuredText(state, input.value)
  }
  if (input.key === 'session_id' && stack.length === 0) {
    state.externalRunRef = String(input.value || '')
  }
  if (input.key === 'status' && stack.length === 0) state.reviewStatus = String(input.value || '')
  if (stack[0] === 'manifest') {
    if (input.key === 'schema_version') state.manifest.schema_version = input.value
    if (input.key === 'operation') state.manifest.operation = input.value
    if (input.key === 'terminal_state') state.manifest.terminal_state = input.value
  }
  if (stack[0] === 'comments' && Number.isInteger(input.key)) {
    appendStructuredText(state, openCodeReviewCommentText(input.value))
  }
}

function openCodeReviewTerminal(status, manifest, manifestPresent = manifest != null) {
  if (manifestPresent) {
    if (manifest.schema_version !== 'ocr.run-manifest/v1') {
      return { diagnostic: 'OpenCodeReview returned an unsupported manifest schema.' }
    }
    if (manifest.operation !== 'review') {
      return { diagnostic: 'OpenCodeReview returned an unsupported manifest operation.' }
    }
    const terminalState = String(manifest.terminal_state || '')
    if (status !== terminalState) {
      return { diagnostic: 'OpenCodeReview returned inconsistent terminal states.' }
    }
    return {
      outcome: ({
        complete: 'completed', partial: 'partial', failed: 'failed', skipped: 'completed',
      })[terminalState] || '',
    }
  }
  return {
    outcome: ({
      success: 'completed',
      complete: 'completed',
      skipped: 'completed',
      completed_with_warnings: 'completed',
      partial: 'partial',
      completed_with_errors: 'partial',
      budget_exceeded: 'partial',
      failed: 'failed',
    })[status] || '',
  }
}

function finalizeStructuredState(state, context = {}) {
  if (state.parseError) {
    return {
      text: '',
      sessionRef: state.sessionRef,
      outcome: 'failed',
      failure: agentRuntimeFailure(state.parseError.code),
      diagnostic: state.parseError.diagnostic,
    }
  }

  if (state.kind === 'openclaw') {
    state.outcome = state.aborted ? 'cancelled' : stepFinishOutcome(state.stopReason)
  }
  if (state.kind === 'opencodereview') {
    const terminal = openCodeReviewTerminal(
      state.reviewStatus, state.manifest, state.manifestSeen,
    )
    if (terminal.diagnostic || !terminal.outcome) {
      markStructuredFailure(
        state,
        'LOCAL_AGENT_OUTCOME_INVALID',
        terminal.diagnostic || 'OpenCodeReview returned an unknown terminal state.',
      )
    } else {
      state.outcome = terminal.outcome
      if (state.outcome === 'failed') {
        markStructuredFailure(
          state,
          'LOCAL_AGENT_PROCESS_FAILED',
          state.text || 'OpenCodeReview reported a failed review.',
        )
      }
      if (state.outcome === 'completed' && !state.text) {
        state.text = 'OpenCodeReview completed without findings.'
      }
    }
  }

  if (!state.seen && !state.text && !state.outcome) return null
  const outcome = state.outcome || (state.text ? 'partial' : 'failed')
  const result = {
    text: state.kind === 'pi'
      ? stripPiPromptEcho(state.text, context.prompt)
      : state.text.trim(),
    sessionRef: state.sessionRef,
    outcome,
  }
  if (state.failure) result.failure = state.failure
  if (state.diagnostic) result.diagnostic = state.diagnostic
  if (state.externalRunRef) result.externalRunRef = state.externalRunRef
  return result
}

function createStructuredOutputAccumulator(kind, sessionRef = '') {
  if (!STRUCTURED_JSONL_KINDS.has(kind) && !STRUCTURED_DOCUMENT_KINDS.has(kind)) return null
  const state = {
    kind,
    sessionRef: String(sessionRef || ''),
    text: '',
    outcome: '',
    failure: null,
    diagnostic: '',
    externalRunRef: '',
    seen: false,
    bytes: 0,
    parseError: null,
    stopReason: '',
    aborted: false,
    reviewStatus: '',
    manifest: {},
    manifestSeen: false,
  }
  if (STRUCTURED_JSONL_KINDS.has(kind)) {
    return {
      format: 'jsonl',
      ingest: event => ingestStructuredEvent(state, event),
      end: context => finalizeStructuredState(state, context),
    }
  }

  const paths = kind === 'openclaw'
    ? [
        '$.payloads.*.text', '$.payloads.*.content',
        '$.messages.*.text', '$.messages.*.content',
        '$.result.text', '$.result.content',
        '$.response.text', '$.response.content',
        '$.meta.aborted', '$.meta.stopReason',
        '$.meta.completion.stopReason', '$.meta.completion.finishReason',
      ]
    : [
        '$.status', '$.message', '$.project_summary', '$.session_id',
        '$.comments.*', '$.manifest', '$.manifest.schema_version', '$.manifest.operation',
        '$.manifest.terminal_state',
      ]
  const parser = new JSONParser({ paths, keepStack: false, stringBufferSize: 64 * 1024 })
  parser.onValue = input => {
    state.seen = true
    if (kind === 'openclaw') openClawDocumentValue(state, input)
    else openCodeReviewDocumentValue(state, input)
  }
  parser.onError = (error) => {
    state.parseError ||= {
      code: 'LOCAL_AGENT_OUTCOME_INVALID',
      diagnostic: String(error?.message || error),
    }
  }
  return {
    format: 'document',
    write(chunk) {
      if (state.parseError) return
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      state.bytes += bytes.length
      if (state.bytes > MAX_STRUCTURED_JSON_BYTES) {
        state.parseError = {
          code: 'LOCAL_AGENT_OUTPUT_LIMIT',
          diagnostic: 'Structured Agent output exceeded the safe limit.',
        }
        return
      }
      try {
        parser.write(bytes)
      } catch (error) {
        state.parseError = {
          code: 'LOCAL_AGENT_OUTCOME_INVALID',
          diagnostic: String(error?.message || error),
        }
      }
    },
    end() {
      if (!state.parseError && !parser.isEnded) {
        try {
          parser.end()
        } catch (error) {
          state.parseError = {
            code: 'LOCAL_AGENT_OUTCOME_INVALID',
            diagnostic: String(error?.message || error),
          }
        }
      }
      return finalizeStructuredState(state)
    },
  }
}

function parseMimoOutput(stdout) {
  let sessionRef = ''
  const texts = []
  const errors = []
  for (const line of String(stdout || '').split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (typeof event.sessionID === 'string') sessionRef = event.sessionID
      if (event.type === 'text' && typeof event.part?.text === 'string') {
        texts.push(event.part.text)
      }
      if (event.type === 'error') {
        const detail = event.error?.data?.message || event.error?.message || event.error?.name
        if (detail) errors.push(String(detail))
      }
    } catch { /* ignore non-JSON diagnostics */ }
  }
  return { text: texts.join('\n').trim(), sessionRef, error: errors.join('\n').trim() }
}

function normalizeOpenClawOutput(stdout) {
  const raw = String(stdout || '').trim()
  if (!raw) return ''
  try {
    const value = JSON.parse(raw)
    const texts = []
    const visit = (node) => {
      if (!node) return
      if (typeof node === 'string') texts.push(node)
      else if (Array.isArray(node)) node.forEach(visit)
      else if (typeof node === 'object') {
        if (typeof node.text === 'string') texts.push(node.text)
        else if (typeof node.content === 'string') texts.push(node.content)
        else for (const key of ['payloads', 'messages', 'result', 'response']) visit(node[key])
      }
    }
    visit(value)
    return texts.filter(Boolean).join('\n').trim() || raw
  } catch {
    return raw
  }
}

function parseJsonOutputEvents(stdout) {
  const raw = String(stdout || '').trim()
  if (!raw) return []
  try {
    const value = JSON.parse(raw)
    return (Array.isArray(value) ? value : [value])
      .filter(event => event && typeof event === 'object')
  } catch { /* fall through to JSONL parsing */ }
  const events = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line)
      const parsed = Array.isArray(value) ? value : [value]
      events.push(...parsed.filter(event => event && typeof event === 'object'))
    } catch { /* ignore non-JSON diagnostics */ }
  }
  return events
}

function parseResultOutput(stdout) {
  const raw = String(stdout || '').trim()
  if (!raw) return { text: '', sessionRef: '' }
  const result = parseJsonOutputEvents(raw)
    .findLast(event => event?.type === 'result' && typeof event.result === 'string')
  if (result) {
    return {
      text: result.result.trim(),
      sessionRef: typeof result.session_id === 'string' ? result.session_id : '',
    }
  }
  return { text: raw, sessionRef: '' }
}

function parseClaudeQwenOutput(stdout) {
  const raw = String(stdout || '').trim()
  if (!raw) return { text: '', sessionRef: '' }
  const events = parseJsonOutputEvents(raw)
  if (!events.length) return { text: raw, sessionRef: '' }
  let sessionRef = ''
  let resultText = ''
  const assistantTexts = []
  const partialTexts = []
  for (const event of events) {
    if (typeof event.session_id === 'string') sessionRef = event.session_id
    if (event.type === 'result' && typeof event.result === 'string') {
      resultText = event.result
      continue
    }
    const isRoot = event.parent_tool_use_id == null || event.parent_tool_use_id === ''
    if (!isRoot) continue
    if (event.type === 'assistant') {
      const content = event.message?.content
      const blocks = Array.isArray(content) ? content : [content]
      for (const block of blocks) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          assistantTexts.push(block.text)
        }
      }
    }
    if (event.type === 'stream_event' && event.event?.type === 'content_block_delta'
        && event.event.delta?.type === 'text_delta'
        && typeof event.event.delta.text === 'string') {
      partialTexts.push(event.event.delta.text)
    }
  }
  return {
    text: (resultText || assistantTexts.join('') || partialTexts.join('')).trim(),
    sessionRef,
  }
}

function parseWorkBuddyOutput(stdout) {
  return parseResultOutput(stdout)
}

function parseKimiOutput(stdout) {
  const raw = String(stdout || '').trim()
  if (!raw) return { text: '', sessionRef: '' }
  const texts = []
  let parsedLine = false
  let sessionRef = ''
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      parsedLine = true
      if (event?.role === 'assistant' && typeof event.content === 'string') {
        texts.push(event.content)
      }
      if (event?.type === 'session.resume_hint' && typeof event.session_id === 'string') {
        sessionRef = event.session_id
      }
    } catch { /* fall back to raw output when the CLI did not emit JSONL */ }
  }
  return {
    text: texts.join('\n').trim() || (parsedLine ? '' : raw),
    sessionRef,
  }
}

function parseGeminiOutput(stdout) {
  const raw = String(stdout || '').trim()
  if (!raw) return { text: '', sessionRef: '' }
  const texts = []
  let parsedLine = false
  let sessionRef = ''
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      parsedLine = true
      if (event?.type === 'init' && typeof event.session_id === 'string') {
        sessionRef = event.session_id
      }
      if (event?.type === 'message' && event.role === 'assistant'
          && typeof event.content === 'string') {
        texts.push(event.content)
      }
    } catch { /* fall back to raw output when the CLI did not emit JSONL */ }
  }
  return {
    text: texts.join('').trim() || (parsedLine ? '' : raw),
    sessionRef,
  }
}

function parseOpenCodeOutput(stdout) {
  const raw = String(stdout || '').trim()
  if (!raw) return { text: '', sessionRef: '' }
  const texts = []
  let parsedLine = false
  let sessionRef = ''
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      parsedLine = true
      if (typeof event?.sessionID === 'string') sessionRef = event.sessionID
      if (event?.type === 'text' && event.part?.type === 'text'
          && typeof event.part.text === 'string') {
        texts.push(event.part.text)
      }
    } catch { /* fall back to raw output when the CLI did not emit JSONL */ }
  }
  return {
    text: texts.join('\n').trim() || (parsedLine ? '' : raw),
    sessionRef,
  }
}

function parsePiOutput(stdout) {
  const events = parseJsonOutputEvents(stdout)
  let sessionRef = ''
  let text = ''
  for (const event of events) {
    if (typeof event.id === 'string' && event.type === 'session') sessionRef = event.id
    if (event.type === 'message_update'
        && event.assistantMessageEvent?.type === 'text_delta'
        && typeof event.assistantMessageEvent.delta === 'string') {
      text += event.assistantMessageEvent.delta
    }
    if (!text && event.type === 'message_end' && event.message?.role === 'assistant'
        && Array.isArray(event.message?.content)) {
      text = event.message.content
        .filter(block => block?.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('')
    }
  }
  const parsedText = text.trim()
  const answer = stripPiInternalPromptEcho(parsedText)
  return { text: parsedText ? answer : events.length ? '' : String(stdout || '').trim(), sessionRef }
}

function openCodeReviewText(output) {
  const sections = []
  if (typeof output.message === 'string' && output.message.trim()) {
    sections.push(output.message.trim())
  }
  if (typeof output.project_summary === 'string' && output.project_summary.trim()) {
    sections.push(output.project_summary.trim())
  }
  for (const comment of Array.isArray(output.comments) ? output.comments : []) {
    const finding = openCodeReviewCommentText(comment)
    if (finding) sections.push(finding)
  }
  return sections.join('\n\n').trim()
}

function invalidOpenCodeReviewOutput(diagnostic) {
  return {
    text: '',
    sessionRef: '',
    outcome: 'failed',
    failure: agentRuntimeFailure('LOCAL_AGENT_OUTCOME_INVALID'),
    diagnostic,
  }
}

function parseOpenCodeReviewOutput(stdout) {
  const raw = String(stdout || '').trim()
  if (!raw) return invalidOpenCodeReviewOutput('OpenCodeReview returned no JSON result.')
  let output
  try {
    output = JSON.parse(raw)
  } catch {
    return invalidOpenCodeReviewOutput('OpenCodeReview returned malformed JSON.')
  }
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return invalidOpenCodeReviewOutput('OpenCodeReview returned an invalid JSON result.')
  }

  const status = String(output.status || '')
  const terminal = openCodeReviewTerminal(status, output.manifest, output.manifest != null)
  if (terminal.diagnostic) return invalidOpenCodeReviewOutput(terminal.diagnostic)
  const outcome = terminal.outcome
  if (!outcome) {
    return invalidOpenCodeReviewOutput('OpenCodeReview returned an unknown terminal state.')
  }

  const text = openCodeReviewText(output)
    || (outcome === 'completed' ? 'OpenCodeReview completed without findings.' : '')
  const result = {
    text,
    sessionRef: '',
    outcome,
    ...(typeof output.session_id === 'string' && output.session_id
      ? { externalRunRef: output.session_id }
      : {}),
  }
  if (outcome === 'failed') {
    result.failure = agentRuntimeFailure('LOCAL_AGENT_PROCESS_FAILED')
    result.diagnostic = text || 'OpenCodeReview reported a failed review.'
  }
  return result
}

function classifyCliOutcome(kind, stdout) {
  if (kind === 'hermes') return { outcome: 'completed' }
  if (kind === 'opencodereview') {
    const parsed = parseOpenCodeReviewOutput(stdout)
    return {
      outcome: parsed.outcome,
      ...(parsed.failure ? { failure: parsed.failure } : {}),
      ...(parsed.diagnostic ? { diagnostic: parsed.diagnostic } : {}),
    }
  }

  const events = parseJsonOutputEvents(stdout)
  if (['workbuddy', 'claude', 'qwen'].includes(kind)) {
    const result = events.findLast(event => event?.type === 'result' && typeof event.result === 'string')
    if (result) {
      return {
        outcome: result.is_error === true ? 'partial' : 'completed',
      }
    }
  }
  const failed = events.findLast(event => (
    event?.type === 'error'
      || event?.status === 'failed'
      || event?.status === 'error'
      || event?.is_error === true
      || String(event?.subtype || '').startsWith('error')
  ))
  if (failed) {
    return {
      outcome: 'failed',
      failure: agentRuntimeFailure('LOCAL_AGENT_PROCESS_FAILED'),
    }
  }
  if (kind === 'codex') {
    return {
      outcome: events.some(event => event?.type === 'turn.completed')
        ? 'completed'
        : 'partial',
    }
  }
  if (kind === 'kimi') {
    return {
      outcome: events.some(event => event?.type === 'session.resume_hint')
        ? 'completed'
        : 'partial',
    }
  }
  if (kind === 'pi') {
    const terminal = events.findLast(event => event?.type === 'turn_end' || event?.type === 'agent_end')
    const lastAssistant = terminal?.messages?.findLast(message => message?.role === 'assistant')
    const previousTurn = events.findLast(event => event?.type === 'turn_end')
    const reason = terminal?.message?.stopReason || terminal?.stopReason || lastAssistant?.stopReason
      || previousTurn?.message?.stopReason || previousTurn?.stopReason
    return { outcome: reason ? stepFinishOutcome(reason) : terminal ? 'completed' : 'partial' }
  }
  if (['mimo', 'opencode'].includes(kind)) {
    const finish = events.findLast(event => (
      event?.type === 'step_finish' || event?.part?.type === 'step-finish'
    ))
    return { outcome: finish ? stepFinishOutcome(finish.part?.reason || finish.reason) : 'partial' }
  }
  if (kind === 'gemini') {
    const result = events.findLast(event => event?.type === 'result')
    if (!result) return { outcome: 'partial' }
    if (result.status === 'success') return { outcome: 'completed' }
    if (result.status === 'cancelled') return { outcome: 'cancelled' }
    return {
      outcome: 'failed',
      failure: agentRuntimeFailure('LOCAL_AGENT_OUTCOME_INVALID'),
    }
  }
  if (kind === 'openclaw') {
    const raw = String(stdout || '').trim()
    try {
      const value = JSON.parse(raw)
      const stopReason = value?.meta?.completion?.stopReason
        || value?.meta?.completion?.finishReason
        || value?.meta?.stopReason
      return {
        outcome: value?.meta?.aborted === true ? 'cancelled' : stepFinishOutcome(stopReason),
      }
    } catch {
      return { outcome: 'partial' }
    }
  }
  return { outcome: 'partial' }
}

function structuredCliError(stdout) {
  const failed = parseJsonOutputEvents(stdout)
    .findLast(event => event?.is_error || event?.subtype?.startsWith('error'))
  if (!failed) return ''
  return structuredResultDiagnostic(failed)
}

function hermesSessionRef(stderr) {
  const matches = [...String(stderr || '').matchAll(/\bsession_id:\s*([^\s]+)/gi)]
  return matches.at(-1)?.[1] || ''
}

function stripAnsi(value) {
  return String(value || '').replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
}

function queryHermesState(databasePath, sql, params, options = {}) {
  if (typeof options.queryFn === 'function') {
    return options.queryFn({ databasePath, sql, params, readOnly: true })
  }
  let database
  try {
    const { DatabaseSync } = require('node:sqlite')
    database = new DatabaseSync(databasePath, { readOnly: true })
    return database.prepare(sql).get(...params)
  } finally {
    try { database?.close() } catch { /* database was already closed */ }
  }
}

function readHermesMessageWatermark(options = {}) {
  const databasePath = path.join(options.home || os.homedir(), '.hermes', 'state.db')
  const existsFn = options.existsFn || fs.existsSync
  if (!existsFn(databasePath)) return 0
  try {
    const row = queryHermesState(databasePath, `
      SELECT COALESCE(MAX(id), 0) AS max_id
      FROM messages
    `, [], options)
    const watermark = Number(row?.max_id)
    return Number.isSafeInteger(watermark) && watermark >= 0 ? watermark : null
  } catch {
    return null
  }
}

function readHermesFinalResponse(sessionRef, options = {}) {
  const afterMessageId = Number(options.afterMessageId)
  if (!sessionRef || !Number.isSafeInteger(afterMessageId) || afterMessageId < 0) return ''
  const databasePath = path.join(options.home || os.homedir(), '.hermes', 'state.db')
  const existsFn = options.existsFn || fs.existsSync
  if (!existsFn(databasePath)) return ''
  try {
    const row = queryHermesState(databasePath, `
      SELECT content
      FROM messages
      WHERE session_id = ?
        AND id > ?
        AND role = 'assistant'
        AND finish_reason IN ('stop', 'length')
        AND length(trim(content)) > 0
      ORDER BY id DESC
      LIMIT 1
    `, [sessionRef, afterMessageId], options)
    return String(row?.content || '').trim()
  } catch {
    return ''
  }
}

module.exports = {
  codexProgressEvent,
  createJsonLineParser,
  createStructuredOutputAccumulator,
  hermesSessionRef,
  normalizeOpenClawOutput,
  parseClaudeQwenOutput,
  parseCodexOutput,
  parseGeminiOutput,
  parseJsonOutputEvents,
  parseKimiOutput,
  parseMimoOutput,
  parseOpenCodeOutput,
  parsePiOutput,
  parseOpenCodeReviewOutput,
  parseWorkBuddyOutput,
  readHermesFinalResponse,
  readHermesMessageWatermark,
  stripAnsi,
  stripExactMeldworkPromptEcho,
  structuredCliError,
  classifyCliOutcome,
}

const { canonicalJson } = require('./context-pack-records.cjs')
const { parseLenientTaskDecision } = require('./task-decision.cjs')

const SHA256 = /^[a-f0-9]{64}$/

const V4_AGENT_PHASES = new Set([
  'proposal', 'discussion', 'challenge', 'work', 'synthesis', 'verification',
])
const V4_RECEIPT_MARKER_PREFIX = '[[MELDWORK_COLLABORATION'
const V4_RECEIPT_MARKER = /\s*\[\[MELDWORK_COLLABORATION(?:_JSON)?:([\s\S]*?)\]\]/i
const V4_RECEIPT_BLOCK = /\s*\[\[MELDWORK_COLLABORATION(?:_JSON)?\]\]([\s\S]*?)\[\[\/MELDWORK_COLLABORATION(?:_JSON)?\]\]/i
const LEGACY_CONSENSUS_MARKER = /^\s*\[\[MELDWORK_CONSENSUS:(?:agree|continue)\]\]\s*$/gim
const V4_RECEIPT_MAX_TEXT = 800
const V4_RECEIPT_MAX_ITEMS = 16
const V4_RECEIPT_MAX_BYTES = 16 * 1024

function isV4InternalProtocolCommentary(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text || text.length > 4000 || /\[\[MELDWORK_COLLABORATION/i.test(text)) return false
  const mentionsControl = /(?:\breceipt\b|structured marker|MELDWORK framework|ExitPlanMode|\u7ed3\u6784\u5316\s*receipt|receipt\s*\u6807\u8bb0)/i.test(text)
  const describesInternalProcess = /(?:coordination\/self-introduction|not a code implementation task|no plan file|implementation planning|plan mode|waiting for (?:the )?(?:next|subsequent).*(?:phase|instruction)|\u534f\u4f5c\u534f\u8c03\u7c7b\u6587\u672c\u4ea7\u51fa|\u975e\u4ee3\u7801\u5b9e\u73b0\u4efb\u52a1|\u6267\u884c\u8ba1\u5212\u6d41\u7a0b|\u4e0d\u8c03\u7528\s*ExitPlanMode|\u672c\u8f6e\u4ea4\u4ed8|\u7b49\u5f85\u540e\u7eed.*(?:\u9636\u6bb5|\u6307\u4ee4))/i.test(text)
  return mentionsControl && describesInternalProcess
}

function stripV4InternalProtocolTail(value) {
  const paragraphs = String(value || '').trim().split(/\n{2,}/)
  while (paragraphs.length && isV4InternalProtocolCommentary(paragraphs.at(-1))) {
    paragraphs.pop()
  }
  return paragraphs.join('\n\n').trim()
}

function boundedReceiptText(value, limit = V4_RECEIPT_MAX_TEXT) {
  if (typeof value !== 'string' || value.trim().length > limit) return ''
  const text = cleanReceiptText(value, limit)
  return text && !text.includes('\u0000') ? text : ''
}

function boundedReceiptList(value) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > V4_RECEIPT_MAX_ITEMS) {
    throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
  }
  const result = value.map(item => boundedReceiptText(item))
  if (result.some(item => !item)) throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
  return result
}

// A decision that is still unreadable after normalisation is treated as no
// decision: the orchestrator then asks the owner again instead of failing
// the Agent and removing it from the discussion.
function leniencyTaskDecision(value, summary) {
  try {
    return { taskDecision: parseLenientTaskDecision(value, { fallbackReason: summary }) }
  } catch {
    return {}
  }
}

function parseV4CollaborationReceiptStrict(result, required = false, expectedPhase = '', options = {}) {
  const rawText = typeof result?.text === 'string' ? result.text : ''
  if (!required) return { text: rawText, collaboration: null }
  let text = rawText
  let receipt = result?.collaboration
  // Natural discussion turns are free-form answers; a slightly malformed
  // receipt there must not fail the turn and end the discussion. Strict
  // phased-V4 receipts keep failing closed.
  const lenient = expectedPhase === 'discussion'
  let trailingVisibleText = ''
  let unreadableReceipt = false
  const block = rawText.match(V4_RECEIPT_BLOCK) || rawText.match(V4_RECEIPT_MARKER)
  if (block) {
    const markerStart = Number(block.index) || 0
    const suffix = rawText.slice(markerStart + block[0].length).trim()
    // A closing code fence after the receipt is formatting, not content.
    if (suffix && !isV4InternalProtocolCommentary(suffix) && !/^[\s`~]*$/.test(suffix)) {
      if (!lenient) throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
      trailingVisibleText = suffix
    }
    const encoded = String(block[1] || '').trim()
    if (!encoded || Buffer.byteLength(encoded) > V4_RECEIPT_MAX_BYTES) {
      if (!lenient) throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
      unreadableReceipt = true
    }
    if (!unreadableReceipt) {
      try {
        let parsed
        try {
          parsed = JSON.parse(encoded)
        } catch (error) {
          if (!lenient) throw error
          // Common hand-written slips: smart quotes and trailing commas.
          parsed = JSON.parse(encoded
            .replace(/[\u201c\u201d]/g, '"')
            .replace(/[\u2018\u2019]/g, "'")
            .replace(/,\s*([}\]])/g, '$1'))
        }
        if (receipt != null && canonicalJson(receipt) !== canonicalJson(parsed)) {
          throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_MISMATCH')
        }
        receipt = parsed
      } catch (error) {
        if (error?.message === 'LOCAL_RUN_COLLABORATION_RECEIPT_MISMATCH') throw error
        if (!lenient) throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
        unreadableReceipt = true
      }
    }
    text = rawText.slice(0, markerStart) + (trailingVisibleText ? `\n\n${trailingVisibleText}` : '')
  } else if (/\[\[MELDWORK_COLLABORATION/i.test(rawText)) {
    if (!lenient) throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
    unreadableReceipt = true
    text = rawText.slice(0, rawText.search(/\[\[MELDWORK_COLLABORATION/i))
  }
  if (unreadableReceipt) receipt = null
  if (lenient && receipt && typeof receipt === 'object' && !Array.isArray(receipt)) {
    // Keep only discussion fields and fill a missing summary, so an extra key
    // or a long summary does not discard the Agent's whole contribution.
    const decisionReason = typeof receipt.taskDecision?.reason === 'string'
      ? receipt.taskDecision.reason
      : ''
    const summary = typeof receipt.summary === 'string' && receipt.summary.trim()
      ? receipt.summary.trim().slice(0, V4_RECEIPT_MAX_TEXT)
      : (decisionReason.trim().slice(0, V4_RECEIPT_MAX_TEXT) || 'Discussion contribution')
    receipt = {
      version: 1,
      phase: 'discussion',
      summary,
      ...(receipt.taskDecision != null ? { taskDecision: receipt.taskDecision } : {}),
    }
  }
  text = stripV4InternalProtocolTail(
    text.replace(LEGACY_CONSENSUS_MARKER, '').replace(/\n{3,}/g, '\n\n'),
  )
  if (receipt == null && options.allowMissingV4Receipt === true && text) {
    return { text, collaboration: null }
  }
  if (receipt == null && expectedPhase === 'proposal'
      && options.allowMissingProposalReceipt === true && text) {
    receipt = {
      version: 1,
      phase: 'proposal',
      summary: 'The Agent returned a visible proposal without a structured receipt.',
      capabilities: ['Delivered a user-facing proposal'],
      intendedWork: ['Addressed the current user task'],
      deliverables: ['Visible Agent response'],
      dependencies: [],
    }
  }
  if (receipt == null) throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_REQUIRED')
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
  }
  try {
    if (Buffer.byteLength(canonicalJson(receipt)) > V4_RECEIPT_MAX_BYTES) {
      throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
    }
  } catch (error) {
    if (error?.message === 'LOCAL_RUN_COLLABORATION_RECEIPT_INVALID') throw error
    throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
  }
  const phase = String(expectedPhase || '')
  const summary = boundedReceiptText(receipt.summary)
  const allowed = new Set([
    'version', 'phase', 'summary',
    ...(phase === 'discussion' ? ['taskDecision'] : []),
    ...(['challenge', 'verification'].includes(phase) ? ['verdict'] : []),
    ...(phase === 'proposal'
      ? ['capabilities', 'intendedWork', 'deliverables', 'dependencies'] : []),
    ...(phase === 'challenge'
      ? [
          'proposedAssignments', 'finalizerKind', 'verifierKinds',
          'supportedPlanHash', 'agreeToPlan',
        ] : []),
    ...(phase === 'work' ? ['workItemId', 'deliverables'] : []),
    ...(phase === 'synthesis' ? ['resolvedIssueIds'] : []),
  ])
  if (!V4_AGENT_PHASES.has(phase) || !summary
      || Object.keys(receipt).some(key => !allowed.has(key))
      || (receipt.version != null && receipt.version !== 1)
      || (receipt.phase != null && receipt.phase !== phase)) {
    throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
  }
  if (['challenge', 'verification'].includes(phase)
      && !['support', 'contradict'].includes(receipt.verdict)) {
    throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
  }
  const resolvedIssueIds = phase === 'synthesis'
    ? boundedReceiptList(receipt.resolvedIssueIds)
    : null
  if (phase === 'synthesis' && !Array.isArray(receipt.resolvedIssueIds)) {
    throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
  }
  if (phase === 'challenge' && receipt.supportedPlanHash != null
      && !SHA256.test(String(receipt.supportedPlanHash))) {
    throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
  }
  const proposalList = (field, requireItem = false) => {
    if (!Array.isArray(receipt[field])) {
      throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
    }
    const list = boundedReceiptList(receipt[field])
    if (requireItem && list.length === 0) {
      throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
    }
    return list
  }
  const boundedList = value => {
    if (value == null) return []
    if (!Array.isArray(value) || value.length > V4_RECEIPT_MAX_ITEMS) {
      throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
    }
    const result = value.map(item => boundedReceiptText(item))
    if (result.some(item => !item)) throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
    return result
  }
  const normalized = {
    version: 1,
    phase,
    summary,
    ...(phase === 'discussion' && receipt.taskDecision != null
      ? leniencyTaskDecision(receipt.taskDecision, summary) : {}),
    ...(['challenge', 'verification'].includes(phase) ? { verdict: receipt.verdict } : {}),
    ...(phase === 'proposal' ? {
      capabilities: proposalList('capabilities', true),
      intendedWork: proposalList('intendedWork', true),
      deliverables: proposalList('deliverables', true),
      dependencies: proposalList('dependencies'),
    } : {}),
    ...(phase === 'challenge' ? {
      ...(Array.isArray(receipt.proposedAssignments)
        ? {
            proposedAssignments: receipt.proposedAssignments.map(assignment => (
              assignment && typeof assignment === 'object' && !Array.isArray(assignment)
                && assignment.role === 'finalizer'
                ? { ...assignment, role: 'integrator' }
                : assignment
            )),
          }
        : {}),
      ...(receipt.finalizerKind ? { finalizerKind: boundedReceiptText(receipt.finalizerKind, 120) } : {}),
      ...(Array.isArray(receipt.verifierKinds) ? { verifierKinds: boundedList(receipt.verifierKinds) } : {}),
      ...(receipt.supportedPlanHash ? { supportedPlanHash: receipt.supportedPlanHash } : {}),
      ...(typeof receipt.agreeToPlan === 'boolean' ? { agreeToPlan: receipt.agreeToPlan } : {}),
    } : {}),
    ...(phase === 'work' ? {
      ...(receipt.workItemId ? { workItemId: boundedReceiptText(receipt.workItemId, 120) } : {}),
      deliverables: boundedList(receipt.deliverables),
    } : {}),
    ...(phase === 'synthesis' ? { resolvedIssueIds } : {}),
  }
  return { text, collaboration: Object.freeze(JSON.parse(canonicalJson(normalized))) }
}

function parseV4CollaborationReceipt(result, required = false, expectedPhase = '', options = {}) {
  try {
    return parseV4CollaborationReceiptStrict(result, required, expectedPhase, options)
  } catch (error) {
    const code = String(error?.message || '')
    if (expectedPhase !== 'proposal'
        || options.allowMissingProposalReceipt !== true
        || !['LOCAL_RUN_COLLABORATION_RECEIPT_INVALID', 'LOCAL_RUN_COLLABORATION_RECEIPT_REQUIRED']
          .includes(code)) {
      throw error
    }
    const rawText = typeof result?.text === 'string' ? result.text : ''
    const markerIndex = rawText.search(/\[\[MELDWORK_COLLABORATION/i)
    const visibleText = (markerIndex >= 0 ? rawText.slice(0, markerIndex) : rawText)
      .replace(LEGACY_CONSENSUS_MARKER, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    if (!visibleText) throw error
    return {
      text: visibleText,
      collaboration: Object.freeze({
        version: 1,
        phase: 'proposal',
        summary: 'The Agent returned a visible proposal without a valid structured receipt.',
        capabilities: ['Delivered a user-facing proposal'],
        intendedWork: ['Addressed the current user task'],
        deliverables: ['Visible Agent response'],
        dependencies: [],
      }),
    }
  }
}

function cleanReceiptText(value, limit) {
  return String(value || '').trim().slice(0, limit)
}

module.exports = {
  V4_AGENT_PHASES,
  V4_RECEIPT_MARKER_PREFIX,
  parseV4CollaborationReceipt,
}

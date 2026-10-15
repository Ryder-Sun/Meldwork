const { createHash } = require('node:crypto')
const { normalizeTraceCapsule } = require('../runs/run-harness.cjs')
const {
  AGENT_LABELS,
  MAX_SYSTEM_PARAM_TEXT_CHARS,
  budgetTerminalPrefix,
  cleanText,
  terminalMessageContent,
  terminalStatusPrefix,
} = require('./local-workspace-inputs.cjs')

function turnSeqMetadata(error) {
  const turnSeq = Number(error?.turnSeq)
  return Number.isSafeInteger(turnSeq) && turnSeq > 0 ? { turnSeq } : {}
}

class LocalWorkspaceRunMessages {
  constructor(options) {
    this.state = options.state
    this.activeRuns = options.activeRuns
    this.agentLabel = options.agentLabel
    this.checkpointRun = options.checkpointRun
    this.addMessage = options.addMessage
  }

  responseVersionRootId(groupId, kind, threadRootId, trace = null) {
    const traceRound = Number(trace?.round)
    const round = Number.isInteger(traceRound) && traceRound >= 0 ? traceRound : 1
    const phase = cleanText(trace?.phase, 40)
      || cleanText(trace?.context?.phase, 40)
      || 'response'
    return `response-${createHash('sha256').update(JSON.stringify([
      String(groupId || ''), String(threadRootId || ''), String(kind || ''), round, phase,
    ])).digest('hex').slice(0, 48)}`
  }

  recordFailure(groupId, kind, error, threadRootId, reportedFailures = null) {
    const label = this.agentLabel(kind)
    const reason = cleanText(error?.message || error, MAX_SYSTEM_PARAM_TEXT_CHARS)
      || 'LOCAL_AGENT_UNKNOWN_FAILURE'
    const controller = this.activeRuns.get(groupId)
    const agentRunId = error?.runTrace?.agentRunId
    if (controller && agentRunId) {
      controller.agentFailureReasons.set(agentRunId, reason)
      this.checkpointRun(groupId, controller)
    }
    const streamedConclusion = this.streamedConclusion(groupId, agentRunId)
    const trace = error?.runTrace || null
    const responseVersionRootId = this.responseVersionRootId(groupId, kind, threadRootId, trace)
    const hardBudget = reason === 'LOCAL_BUDGET_EXHAUSTED'
      && error?.decision?.action === 'terminal'
    const content = terminalMessageContent(
      hardBudget
        ? budgetTerminalPrefix(label)
        : terminalStatusPrefix(label, 'failed', reason),
      streamedConclusion,
    )
    const failureKey = `${kind}:${reason}:${createHash('sha256').update(content).digest('hex')}`
    if (!reportedFailures || !reportedFailures.has(failureKey)) {
      reportedFailures?.add(failureKey)
      const system = hardBudget
        ? {
            key: 'system.agentBudgetExhausted',
            params: {
              agent: label,
              dimension: error.decision.dimension,
              limit: error.decision.limit,
              priorUsed: error.decision.priorUsed,
              attemptedUsage: error.decision.attemptedUsage,
              used: error.decision.used,
            },
          }
        : { key: 'system.agentCallFailed', params: { agent: label, reason } }
      this.addMessage(
        groupId,
        'system',
        content,
        kind,
        threadRootId,
        system,
        { trace, responseVersionRootId, ...turnSeqMetadata(error) },
      )
    }
    return { label, reason }
  }

  streamedConclusion(groupId, agentRunId) {
    if (!agentRunId) return ''
    const agentRun = this.activeRuns.get(groupId)?.harness?.snapshot?.().find(run => (
      run.agentRunId === agentRunId
    ))
    return cleanText(agentRun?.output)
  }

  recordInterruption(
    groupId, kind, error, threadRootId, status = 'stopped', reportedFailures = null,
  ) {
    const trace = normalizeTraceCapsule(error?.runTrace
      ? { ...error.runTrace, status }
      : null)
    if (!trace) return null
    const label = AGENT_LABELS[kind] || kind
    const interruptionKey = `${kind}:${trace.agentRunId}:${status}`
    if (reportedFailures?.has(interruptionKey)) return trace
    reportedFailures?.add(interruptionKey)
    if (this.state().messages.some(message => message.trace?.agentRunId === trace.agentRunId)) {
      return trace
    }
    const interrupted = status === 'interrupted'
    const streamedConclusion = this.streamedConclusion(groupId, trace.agentRunId)
    const responseVersionRootId = this.responseVersionRootId(groupId, kind, threadRootId, trace)
    this.addMessage(
      groupId,
      'system',
      terminalMessageContent(terminalStatusPrefix(label, status), streamedConclusion),
      kind,
      threadRootId,
      {
        key: interrupted ? 'system.agentInterrupted' : 'system.agentStopped',
        params: { agent: label },
      },
      { trace, responseVersionRootId, ...turnSeqMetadata(error) },
    )
    return trace
  }
}

module.exports = { LocalWorkspaceRunMessages }

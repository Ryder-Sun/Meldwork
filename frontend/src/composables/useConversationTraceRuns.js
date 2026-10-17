import { computed } from 'vue'
import { compareTraceItems } from '../conversationOrdering.js'
import { agentLabel } from '../catalog.js'
import { normalizeOrchestration } from '../desktop-normalization.js'
import {
  retainedTraceEvents,
  runStatusTone,
  traceRound,
} from '../conversationTimelineModel.js'

const CONTROLLER_TERMINAL_KEYS = new Set([
  'system.autoTimeout',
  'system.autoRoundLimit',
  'system.autoStopped',
  'system.autoTaskDecisionMissing',
  'system.autoTaskBlocked',
  'system.autoTaskNeedsHuman',
])

function orchestrationFor(run, agent) {
  return normalizeOrchestration(agent?.orchestration || run?.orchestration)
}

export function useConversationTraceRuns({
  activeGroup,
  activeMessages,
  activeRun,
  activeRunAgentRuns,
  runOutcomes,
  messageThreadRootId,
  scopedTargetKinds,
  t,
  topLevelUserMessages,
  translateSystemMessage,
}) {
  function traceSourceItems(sourceIds) {
    const messagesById = new Map(activeMessages.value.map(message => [message.id, message]))
    return (Array.isArray(sourceIds) ? sourceIds : []).map((id) => {
      const message = messagesById.get(id)
      if (!message) return { id, available: false, label: t('trace.sourceUnavailable') }
      const sender = message.role === 'user'
        ? t('conversation.you')
        : message.agentKind ? agentLabel(message.agentKind) : t('conversation.system')
      const content = message.role === 'system' ? translateSystemMessage(message) : message.content
      const summary = String(content || '').trim().replace(/\s+/g, ' ').slice(0, 96)
        || t('conversation.attachmentTurn')
      return { id, available: true, label: `${sender}: ${summary}` }
    })
  }

  const allTracePanelItems = computed(() => {
    const byRunAgentId = new Map()
    for (const agent of activeRunAgentRuns.value) {
      const runId = String(activeRun.value?.runId || '')
      if (!runId) continue
      byRunAgentId.set(`${runId}\u0000${agent.agentRunId}`, {
        runId,
        agentRunId: agent.agentRunId,
        agentKind: agent.kind,
        round: agent.round,
        status: agent.status,
        output: agent.output || '',
        summary: '',
        events: agent.events || [],
        sourceMessageIds: agent.sourceMessageIds || [],
        sources: traceSourceItems(agent.sourceMessageIds),
        truncated: agent.truncated === true,
        context: agent.context || {},
        orchestration: orchestrationFor(activeRun.value, agent),
        threadRootId: activeRun.value?.threadRootId || '',
        createdAt: agent.startedAt,
        startedAt: agent.startedAt,
        turnSeq: agent.turnSeq,
        live: true,
      })
    }
    for (const message of activeMessages.value) {
      const trace = message?.trace
      if (!['agent', 'system'].includes(message.role) || !message.agentKind || !trace?.runId || !trace?.agentRunId) continue
      const key = `${trace.runId}\u0000${trace.agentRunId}`
      if (message.role === 'system' && byRunAgentId.has(key)) continue
      const durable = {
        runId: trace.runId,
        agentRunId: trace.agentRunId,
        agentKind: message.agentKind,
        round: traceRound(trace),
        status: trace.status,
        output: message.role === 'agent' ? message.content || '' : '',
        summary: trace.summary || '',
        events: trace.events || [],
        sourceMessageIds: trace.sourceMessageIds || [],
        sources: traceSourceItems(trace.sourceMessageIds),
        truncated: trace.truncated === true,
        context: trace.context || {},
        orchestration: normalizeOrchestration(trace.orchestration || activeRun.value?.orchestration),
        messageId: message.id,
        threadRootId: messageThreadRootId(message),
        createdAt: message.createdAt,
        turnSeq: message.turnSeq,
        live: false,
      }
      const live = byRunAgentId.get(key)
      byRunAgentId.set(key, live ? {
        ...durable,
        round: live.round || durable.round,
        status: live.status || durable.status,
        output: durable.output || live.output,
        events: live.events?.length ? live.events : durable.events,
        sourceMessageIds: live.sourceMessageIds?.length
          ? live.sourceMessageIds
          : durable.sourceMessageIds,
        sources: live.sources?.length ? live.sources : durable.sources,
        truncated: live.truncated || durable.truncated,
        orchestration: live.orchestration || durable.orchestration,
        threadRootId: live.threadRootId || durable.threadRootId,
        createdAt: live.createdAt || durable.createdAt,
        startedAt: live.startedAt || durable.startedAt,
        turnSeq: durable.turnSeq || live.turnSeq,
        live: true,
      } : durable)
    }
    const targetOrder = new Map((activeRun.value?.targetKinds
      || activeGroup.value?.agentKinds || []).map((kind, index) => [kind, index]))
    return [...byRunAgentId.values()].sort((left, right) => compareTraceItems(left, right, targetOrder))
  })

  const historicalGroupRun = computed(() => {
    const group = activeGroup.value
    if (!group || group.conversationType === 'direct' || activeRun.value) return null
    const rootOrder = new Map(topLevelUserMessages.value.map((message, index) => [message.id, index]))
    const outcome = runOutcomes?.value?.find(item => item.groupId === group.id
      && item.threadRootId === topLevelUserMessages.value.at(-1)?.id)
    if (outcome && ['preparing', 'queued', 'running', 'waiting', 'reconciling'].includes(outcome.status)) return null
    const runs = new Map()
    for (const item of allTracePanelItems.value) {
      if (!item.runId || !item.threadRootId) continue
      const current = runs.get(item.runId) || {
        runId: item.runId,
        threadRootId: item.threadRootId,
        agentRuns: [],
        orchestration: item.orchestration || null,
        rootIndex: rootOrder.get(item.threadRootId) ?? -1,
        createdAt: 0,
      }
      current.agentRuns.push(item)
      if (item.orchestration) current.orchestration = item.orchestration
      current.createdAt = Math.max(current.createdAt, Date.parse(item.createdAt || item.startedAt || '') || 0)
      runs.set(item.runId, current)
    }
    const latest = outcome ? (runs.get(outcome.runId) || {
      runId: outcome.runId, threadRootId: outcome.threadRootId, agentRuns: [], orchestration: null,
    }) : [...runs.values()].sort((left, right) => (
      left.rootIndex - right.rootIndex || left.createdAt - right.createdAt
    )).at(-1)
    if (!latest || latest.threadRootId !== topLevelUserMessages.value.at(-1)?.id) return null

    const topicMessages = activeMessages.value.filter(message => (
      message.id === latest.threadRootId || messageThreadRootId(message) === latest.threadRootId
    ))
    const rootMessage = topicMessages.find(message => message.id === latest.threadRootId)
    const targetKinds = outcome?.targetKinds || scopedTargetKinds(rootMessage, group)
    const systemKeys = new Set(topicMessages.map(message => message?.system?.key).filter(Boolean))
    if (!targetKinds.length || (!outcome && [...CONTROLLER_TERMINAL_KEYS].some(key => systemKeys.has(key)))) return null
    const visibleTerminalKinds = new Set(topicMessages
      .filter(message => ['agent', 'system'].includes(message.role) && message.agentKind)
      .map(message => message.agentKind))
    if (!outcome && targetKinds.some(kind => !visibleTerminalKinds.has(kind))) return null
    const latestByKind = new Map()
    for (const item of latest.agentRuns) {
      const previous = latestByKind.get(item.agentKind)
      if (!previous || traceRound(item) >= traceRound(previous)) latestByKind.set(item.agentKind, item)
    }
    const agentRuns = targetKinds.map(kind => latestByKind.get(kind)).filter(Boolean)
    const statuses = agentRuns.map(item => runStatusTone(item.status))
    let status = 'completed'
    if (statuses.length && statuses.every(value => value === 'failed')) status = 'failed'
    else if (statuses.includes('failed') || statuses.includes('partial')) status = 'partial'
    return {
      ...latest,
      targetKinds,
      agentRuns,
      status: outcome?.status || status,
      authoritative: Boolean(outcome),
      eventCount: latest.agentRuns.reduce(
        (count, item) => count + retainedTraceEvents(item.events).length,
        0,
      ),
    }
  })

  return {
    allTracePanelItems,
    historicalGroupRun,
  }
}

import { computed, ref } from 'vue'
import {
  compareSortKeys,
  positiveSequence,
  timelineSortKey,
  timestampValue,
} from '../conversationOrdering.js'
import { agentLabel } from '../catalog.js'
import {
  durableRunTurnStatus,
  messageAgentRunId,
  messageElementId,
  messageExecutionSteps,
  messageHasTrace,
  messageTraceEvents,
  messageTraceKey,
  messageTraceStatus,
  messageTraceSummary,
  retainedTraceEvents,
  responseVersionRootId,
  runStatusTone,
  terminalSystemConclusion,
  terminalSystemFallback,
  traceRound,
} from '../conversationTimelineModel.js'
import { orchestrationPhase, orchestrationSlotCompleted } from '../desktop-normalization.js'
import { messageScopedTargetKinds } from '../messageContext.js'
import { useConversationTimelineLabels } from './useConversationTimelineLabels.js'
import { useConversationTimelineUiState } from './useConversationTimelineUiState.js'
import { useConversationTraceRuns } from './useConversationTraceRuns.js'
import { useConversationTopics } from './useConversationTopics.js'
import { useRunTracePanel } from './useRunTracePanel.js'

export { durableRunTurnStatus, retainedTraceEvents, runStatusTone, traceRound }

const TERMINAL_AGENT_SYSTEM_KEYS = new Set([
  'system.agentCallFailed', 'system.agentStopped', 'system.agentInterrupted',
  'system.agentBudgetExhausted',
])

export function useConversationTimeline({
  activeGroup,
  activeView,
  blockingOverlayOpen,
  conversationTitleBlock,
  locale,
  mergedCatalog,
  selectedGroupId,
  snapshot,
  t,
  translateSystemMessage,
}) {
  const {
    dismissedSystemMessageIds,
    dismissSystemMessage,
    hasFinishedDirectRun,
    isAgentReplyExpanded,
    isDirectTraceOpen,
    isDismissibleSystemWarning,
    setFinishedDirectRun,
    syncDirectTraceDisclosure,
    toggleAgentReply,
  } = useConversationTimelineUiState()
  const selectedResponseVersionIds = ref(new Map())

  const activeMessages = computed(() => (
    snapshot.value.messages.filter(message => message.groupId === selectedGroupId.value)
  ))
  const runOutcomes = computed(() => (snapshot.value.runOutcomes || [])
    .filter(outcome => outcome.groupId === selectedGroupId.value))
  const {
    activeTurnId,
    clearActiveTurn,
    clearDeletedTurnState,
    durableTopicStatuses,
    expandTopic,
    failedTopicIds,
    focusTurn,
    formatTime,
    isTopicExpanded,
    isTopicRoot,
    messageThreadRootId,
    rememberRunFinishedTurnStatus,
    runFinishedTurnStatus,
    toggleTopic,
    topLevelUserMessages,
    topicReplyAgentKinds,
    topicReplyCount,
    topicReplyLabel,
    topicToggleLabel,
  } = useConversationTopics({ activeGroup, activeMessages, locale, selectedGroupId, t })
  const {
    localizedStepTitle,
    messageElapsedLabel,
    runStatusLabel,
    traceEventTitle,
    traceEventTypeLabel,
    turnRailLabel,
  } = useConversationTimelineLabels({ activeGroup, locale, t, topicReplyLabel })
  const activeRun = computed(() => snapshot.value.runs.find(run => run.groupId === selectedGroupId.value) || null)
  const activeRunAgentRuns = computed(() => (
    Array.isArray(activeRun.value?.agentRuns) ? activeRun.value.agentRuns : []
  ))
  const activeRunHasAgentRuns = computed(() => activeRunAgentRuns.value.length > 0)
  const activeRunProgress = computed(() => Array.isArray(activeRun.value?.progress) ? activeRun.value.progress.slice(0, 8) : [])
  const liveOutputSignature = computed(() => activeRunAgentRuns.value.map(agent => (
    `${agent.agentRunId}:${String(agent.output || '').length}:${agent.events?.at(-1)?.seq || 0}`
  )).join('\u0000'))
  const directConclusionLiveStatus = computed(() => {
    if (activeGroup.value?.conversationType !== 'direct') return ''
    const agent = activeRunAgentRuns.value.at(-1)
    if (!agent?.output) return ''
    const status = ['completed', 'succeeded', 'failed', 'cancelled', 'stopped', 'partial', 'timeout', 'interrupted']
      .includes(String(agent.status || '').toLowerCase())
      ? agent.status
      : 'streaming'
    return [agentLabel(agent.kind), t('trace.conclusion'), runStatusLabel(status)].join(' / ')
  })
  const directTraceEventLiveStatus = computed(() => {
    if (activeGroup.value?.conversationType !== 'direct') return ''
    const agent = activeRunAgentRuns.value.at(-1)
    const event = retainedTraceEvents(agent?.events).at(-1)
    if (!agent || !event) return ''
    return [...new Set([
      agentLabel(agent.kind),
      t('trace.process'),
      traceEventTypeLabel(event.type),
      traceEventTitle(event),
      runStatusLabel(event.status),
    ].filter(Boolean))].join(' / ')
  })

  function latestAgentRunForKind(kind) {
    return activeRunAgentRuns.value.filter(agent => agent.kind === kind).at(-1) || null
  }

  const runTargetKinds = computed(() => {
    if (!activeRun.value) return []
    const runTargets = Array.isArray(activeRun.value.targetKinds) ? activeRun.value.targetKinds : []
    const rootMessage = activeMessages.value.find(message => message.id === activeRun.value.threadRootId)
    const messageTargets = scopedTargetKinds(rootMessage, activeGroup.value)
    const targets = runTargets.length
      ? runTargets
      : activeRunAgentRuns.value.length
        ? activeRunAgentRuns.value.map(agent => agent.kind)
        : messageTargets
    return [...new Set(targets)]
  })
  const isCoordinatedRun = computed(() => (
    activeGroup.value?.conversationType !== 'direct' && runTargetKinds.value.length > 1
  ))
  const activeRunAgentKind = computed(() => (
    activeRun.value?.currentKind
    || activeRunAgentRuns.value.at(-1)?.kind
    || runTargetKinds.value[0]
    || activeGroup.value?.directAgentKind
    || ''
  ))
  const activeRunAgentStatus = computed(() => runAgentStatus(activeRunAgentKind.value))
  const runCompletedKinds = computed(() => {
    const targets = new Set(runTargetKinds.value)
    const completed = activeRunAgentRuns.value
      .filter(agent => ['completed', 'succeeded'].includes(agent.status))
      .map(agent => agent.kind)
    return [...new Set([...(activeRun.value?.completedKinds || []), ...completed])].filter(kind => targets.has(kind))
  })
  const runFailedKinds = computed(() => {
    const targets = new Set(runTargetKinds.value)
    const failed = activeRunAgentRuns.value
      .filter(agent => ['failed', 'timeout'].includes(agent.status))
      .map(agent => agent.kind)
    return [...new Set([...(activeRun.value?.failedKinds || []), ...failed])].filter(kind => targets.has(kind))
  })
  const activeRunLabel = computed(() => {
    if (!activeRun.value || !activeGroup.value) return ''
    if (!isCoordinatedRun.value) {
      const agent = agentLabel(activeRunAgentKind.value)
      return activeRunAgentStatus.value === 'running'
        ? t('conversation.directWorking', { agent })
        : agent
    }
    return t('conversation.groupWorking')
  })
  const activeRunTopicRootId = computed(() => {
    if (!activeRun.value) return ''
    if (activeRun.value?.threadRootId) return activeRun.value.threadRootId
    if (activeGroup.value?.conversationType !== 'direct') return ''
    return topLevelUserMessages.value.at(-1)?.id || ''
  })
  const runRoundProgress = computed(() => {
    const current = Number(activeRun.value?.currentRound)
    const max = Number(activeRun.value?.maxRounds)
    if (!Number.isInteger(current) || current < 1) return null
    if (activeRun.value?.unlimitedRounds === true) return { current, unlimited: true }
    if (!Number.isInteger(max) || max < current) return null
    return { current, max }
  })
  const provisionalMessages = computed(() => {
    const run = activeRun.value
    const group = activeGroup.value
    if (!run || !group || !activeRunAgentRuns.value.length) return []
    const durableAgentRunIds = new Set(activeMessages.value
      .map(message => message?.trace?.agentRunId)
      .filter(Boolean))
    const rootId = run.threadRootId || topLevelUserMessages.value.at(-1)?.id || ''
    // While a retry is still live, earlier attempts render as response
    // versions of the same turn. Once the retry's reply is saved, a failed
    // earlier attempt has no message of its own and would linger as a ghost
    // bubble next to the real reply, so it is dropped.
    const supersededAttempt = agent => ['failed', 'timeout', 'stopped', 'interrupted'].includes(agent.status)
      && activeRunAgentRuns.value.some(other => (
        other !== agent && other.kind === agent.kind
          && durableAgentRunIds.has(other.agentRunId)
          && timestampValue(other.startedAt) > timestampValue(agent.startedAt)
      ))
    return activeRunAgentRuns.value
      .filter(agent => !durableAgentRunIds.has(agent.agentRunId))
      .filter(agent => !supersededAttempt(agent))
      .filter(agent => group.conversationType === 'direct' || agent.output || (agent.events || []).some(event => event.type !== 'answer_delta'))
      .map(agent => ({
        id: `run-message-${agent.agentRunId}`,
        groupId: group.id,
        role: 'agent',
        agentKind: agent.kind,
        content: agent.output || '',
        createdAt: agent.startedAt || Date.now(),
        ...(positiveSequence(agent.turnSeq) ? { turnSeq: positiveSequence(agent.turnSeq) } : {}),
        threadRootId: rootId,
        provisional: true,
        traceRunId: run.runId,
        tracePhase: run.orchestration?.phase || run.phase || '',
        liveAgentRun: agent,
        sourceMessageIds: agent.sourceMessageIds || [],
        ...(run.responseVersionRootId
          ? { responseVersionRootId: run.responseVersionRootId }
          : {}),
      }))
  })
  const messagesWithLiveTrace = computed(() => {
    const run = activeRun.value
    if (!run) return activeMessages.value
    const liveByAgentRunId = new Map(activeRunAgentRuns.value.map(agent => [agent.agentRunId, agent]))
    return activeMessages.value.map((message) => {
      if (!run.runId || !message?.trace?.runId || message.trace.runId !== run.runId) return message
      const liveAgentRun = liveByAgentRunId.get(message.trace.agentRunId)
      return liveAgentRun
        ? { ...message, liveAgentRun, traceRunId: run.runId }
        : message
    })
  })

  const { allTracePanelItems, historicalGroupRun } = useConversationTraceRuns({
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
  })
  const displayedRun = computed(() => activeRun.value || historicalGroupRun.value)
  const displayedRunAgentRuns = computed(() => (
    activeRun.value ? activeRunAgentRuns.value : historicalGroupRun.value?.agentRuns || []
  ))
  const displayedRunTargetKinds = computed(() => (
    activeRun.value ? runTargetKinds.value : historicalGroupRun.value?.targetKinds || []
  ))
  const displayedRunOrchestration = computed(() => (
    displayedRun.value?.orchestration && typeof displayedRun.value.orchestration === 'object'
      ? displayedRun.value.orchestration
      : null
  ))
  const displayedRunPhase = computed(() => {
    return orchestrationPhase(
      displayedRunOrchestration.value?.phase
      || activeRun.value?.phase,
    )
  })
  const displayedRunPhaseLabel = computed(() => (
    displayedRunPhase.value ? t(`run.phase.${displayedRunPhase.value}`) : ''
  ))
  const displayedRunPhaseSlots = computed(() => {
    const orchestrationSlots = Array.isArray(displayedRunOrchestration.value?.slots)
      ? displayedRunOrchestration.value.slots
      : []
    const kinds = orchestrationSlots.length
      ? orchestrationSlots.map(slot => slot.agentKind)
      : (Array.isArray(displayedRunOrchestration.value?.currentKinds)
          && displayedRunOrchestration.value.currentKinds.length
        ? displayedRunOrchestration.value.currentKinds
        : displayedRunTargetKinds.value)
    const seen = new Set()
    return kinds.filter(Boolean).filter(kind => {
      if (seen.has(kind)) return false
      seen.add(kind)
      return true
    }).map(kind => {
      const slot = orchestrationSlots.find(item => item.agentKind === kind)
      const status = String(slot?.status || displayedRunAgentStatusForKind(kind) || 'pending').toLowerCase()
      return {
        agentKind: kind,
        phase: slot?.phase || displayedRunPhase.value,
        status,
        statusLabel: runStatusLabel(status),
      }
    })
  })
  const displayedRunPhaseLiveStatus = computed(() => {
    if (!displayedRunPhaseLabel.value) return ''
    const slots = displayedRunPhaseSlots.value
    const completed = slots.filter(slot => orchestrationSlotCompleted(slot.status)).length
    return [
      displayedRunPhaseLabel.value,
      slots.length ? t('run.phaseSlots', { completed, total: slots.length }) : '',
    ].filter(Boolean).join(' / ')
  })
  const isDisplayedCoordinatedRun = computed(() => (
    activeGroup.value?.conversationType !== 'direct' && displayedRunTargetKinds.value.length > 1
  ))
  const displayedRunAgentKind = computed(() => (
    activeRun.value?.currentKind
    || displayedRunAgentRuns.value.at(-1)?.agentKind
    || displayedRunAgentRuns.value.at(-1)?.kind
    || displayedRunTargetKinds.value[0]
    || activeGroup.value?.directAgentKind
    || ''
  ))
  const displayedRunAgentStatus = computed(() => displayedRunAgentStatusForKind(displayedRunAgentKind.value))
  const displayedRunAgentTone = computed(() => runStatusTone(displayedRunAgentStatus.value))
  const displayedRunTopicRootId = computed(() => (
    activeRunTopicRootId.value || historicalGroupRun.value?.threadRootId || ''
  ))
  const displayedRunLabel = computed(() => {
    if (!displayedRun.value || !activeGroup.value) return ''
    if (!activeRun.value) return historicalGroupRun.value?.authoritative
      ? `${t('conversation.groupRunHistory')} · ${runStatusLabel(historicalGroupRun.value.status)}`
      : t('conversation.groupRunHistory')
    return activeRunLabel.value
  })
  const {
    closeTracePanel,
    jumpToTraceSource,
    openDisplayedRunTrace,
    openDisplayedTraceForAgent,
    openTraceForMessage,
    openTracePanel,
    selectTraceAgentRun,
    selectedTraceAgentRunId,
    traceDrawerBlocking,
    tracePanel,
    tracePanelDrawer,
    tracePanelGroupId,
    tracePanelItems,
    tracePanelOpen,
    tracePanelRunId,
  } = useRunTracePanel({
    activeGroup,
    activeMessages,
    activeRun,
    activeView,
    allTracePanelItems,
    blockingOverlayOpen,
    conversationTitleBlock,
    displayedRun,
    displayedRunAgentForKind,
    displayedRunAgentKind,
    displayedRunAgentRuns,
    expandTopic,
    isTopicExpanded,
    messageAgentRunId,
    messageElementId,
    messageThreadRootId,
    retainedTraceEvents,
    selectedGroupId,
    snapshot,
  })
  const turnRailItems = computed(() => topLevelUserMessages.value.map((message) => {
    const replyCount = topicReplyCount(message.id)
    const finishedStatus = runFinishedTurnStatus(message.id)
    const durableStatus = durableTopicStatuses.value.get(message.id) || ''
    const outcome = runOutcomes.value.find(item => item.threadRootId === message.id)
    return {
      id: message.id,
      query: String(message.content || '').trim().replace(/\s+/g, ' ').slice(0, 56) || t('conversation.attachmentTurn'),
      time: formatTime(message.createdAt),
      replyCount,
      status: activeRunTopicRootId.value === message.id
        ? 'running'
        : outcome?.status || finishedStatus || durableStatus || (replyCount > 0
          ? 'completed'
          : failedTopicIds.value.has(message.id) ? 'failed' : 'pending'),
    }
  }))
  const activeTurnRailId = computed(() => (
    activeRunTopicRootId.value || activeTurnId.value || turnRailItems.value.at(-1)?.id || ''
  ))
  const activeRunTopicSignature = computed(() => {
    if (!activeRunTopicRootId.value) return ''
    return `${activeRun.value?.groupId || ''}\u0000${activeRunTopicRootId.value}`
  })
  const versionedTimelineMessages = computed(() => {
    const messages = [
      ...messagesWithLiveTrace.value,
      ...provisionalMessages.value,
    ]
    const roundRoots = new Map()
    const runIdentity = message => {
      const trace = message?.liveAgentRun || message?.trace
      const runId = String(message?.traceRunId || trace?.runId || '')
      const kind = String(message?.agentKind || trace?.agentKind || '')
      const round = Number(trace?.round)
      if (!runId || !kind || !Number.isInteger(round) || round < 1) return ''
      return `${runId}\u0000${kind}\u0000${round}`
    }

    // A phase-less terminal record can be a recovered attempt for the same
    // visible turn. Only alias it when that round has one unambiguous root.
    for (const message of messages) {
      const rootId = responseVersionRootId(message)
      const phase = String(message?.tracePhase
        || message?.trace?.phase
        || message?.liveAgentRun?.phase
        || message?.trace?.context?.phase
        || '').trim()
      const key = runIdentity(message)
      if (!key || !rootId || !phase || !rootId.startsWith('run-response:')) continue
      const roots = roundRoots.get(key) || new Set()
      roots.add(rootId)
      roundRoots.set(key, roots)
    }

    return messages.map((message) => {
      if (responseVersionRootId(message)) return message
      const key = runIdentity(message)
      const roots = key ? roundRoots.get(key) : null
      if (!roots || roots.size !== 1) return message
      const isTerminal = message?.role === 'agent'
        || (message?.role === 'system' && TERMINAL_AGENT_SYSTEM_KEYS.has(message?.system?.key))
      if (!isTerminal) return message
      return { ...message, responseVersionRootId: [...roots][0], _phaseLessResponseVersionAlias: true }
    })
  })
  const responseVersionGroups = computed(() => {
    const groups = new Map()
    for (const message of versionedTimelineMessages.value) {
      const rootId = responseVersionRootId(message)
      if (!rootId) continue
      const versions = groups.get(rootId) || []
      versions.push(message)
      groups.set(rootId, versions)
    }
    for (const versions of groups.values()) {
      versions.sort((left, right) => {
        const leftFailed = left?._phaseLessResponseVersionAlias === true
        const rightFailed = right?._phaseLessResponseVersionAlias === true
        return Number(rightFailed) - Number(leftFailed)
      })
    }
    return groups
  })

  function responseVersionInfo(message) {
    const rootId = responseVersionRootId(message)
    const versions = rootId ? responseVersionGroups.value.get(rootId) || [] : []
    const current = Math.max(0, versions.findIndex(version => version.id === message?.id))
    return {
      current: current + 1,
      total: versions.length,
      hasPrevious: current > 0,
      hasNext: current >= 0 && current < versions.length - 1,
    }
  }

  function selectedResponseVersionId(rootId, versions) {
    const selected = selectedResponseVersionIds.value.get(rootId)
    return versions.some(message => message.id === selected)
      ? selected
      : versions.at(-1)?.id || ''
  }

  function selectResponseVersion(message, direction) {
    const rootId = responseVersionRootId(message)
    const versions = rootId ? responseVersionGroups.value.get(rootId) || [] : []
    if (versions.length < 2) return
    const selectedId = selectedResponseVersionId(rootId, versions)
    const current = versions.findIndex(version => version.id === selectedId)
    const nextIndex = Math.max(0, Math.min(versions.length - 1, current + direction))
    const next = new Map(selectedResponseVersionIds.value)
    next.set(rootId, versions[nextIndex].id)
    selectedResponseVersionIds.value = next
  }

  function showLatestResponseVersion(message) {
    const rootId = responseVersionRootId(message)
    if (!rootId) return
    const next = new Map(selectedResponseVersionIds.value)
    next.delete(rootId)
    selectedResponseVersionIds.value = next
  }

  function isSelectedResponseVersion(message) {
    const rootId = responseVersionRootId(message)
    if (!rootId) return true
    const versions = responseVersionGroups.value.get(rootId) || []
    return message.id === selectedResponseVersionId(rootId, versions)
  }

  const selectedVersionMessages = computed(() => {
    const emittedRoots = new Set()
    return versionedTimelineMessages.value.flatMap((message) => {
      const rootId = responseVersionRootId(message)
      if (!rootId) return [message]
      if (emittedRoots.has(rootId)) return []
      emittedRoots.add(rootId)
      const versions = responseVersionGroups.value.get(rootId) || []
      return versions.filter(isSelectedResponseVersion)
    })
  })

  const timelineMessages = computed(() => {
    const messages = selectedVersionMessages.value.filter((message) => {
      if (dismissedSystemMessageIds.value.has(message.id)) return false
      const rootId = messageThreadRootId(message)
      return !rootId || isTopicExpanded(rootId)
    })
    if (activeGroup.value?.conversationType === 'direct') return messages
    const topicOrder = new Map(topLevelUserMessages.value.map((message, index) => [message.id, index]))
    const unanchoredTopicOrder = topLevelUserMessages.value.length + 1
    const topicIndexFor = (message) => {
      const rootId = message.role === 'user' && !message.threadRootId
        ? message.id
        : messageThreadRootId(message)
      return rootId && topicOrder.has(rootId) ? topicOrder.get(rootId) : unanchoredTopicOrder
    }
    return messages
      .map((message, index) => ({
        message,
        key: timelineSortKey(message, { topicIndex: topicIndexFor(message), index }),
      }))
      .sort((left, right) => compareSortKeys(left.key, right.key))
      .map(item => item.message)
  })
  const conversationEmptyVisible = computed(() => (
    activeView.value === 'conversation'
    && Boolean(activeGroup.value)
    && !timelineMessages.value.length
    && !activeRun.value
  ))

  function scopedTargetKinds(message, group) {
    return messageScopedTargetKinds(message, group, mergedCatalog.value)
  }

  function isActiveRunTopic(message) {
    const rootId = activeRunTopicRootId.value
    return Boolean(rootId && (message?.id === rootId || messageThreadRootId(message) === rootId))
  }

  async function focusRunTopic() {
    await focusTurn(activeRunTopicRootId.value)
  }

  function runAgentForKind(kind) {
    return latestAgentRunForKind(kind)
  }

  function runAgentStatus(kind) {
    const agent = runAgentForKind(kind)
    const latestStatus = String(agent?.status || '').trim().toLowerCase()
    if (['failed', 'partial', 'stopped', 'timeout', 'cancelled', 'interrupted'].includes(latestStatus)) {
      return latestStatus
    }
    if (activeRun.value?.currentKind === kind) return 'running'
    if (latestStatus) return latestStatus
    if (runFailedKinds.value.includes(kind)) return 'failed'
    if (runCompletedKinds.value.includes(kind)) return 'completed'
    return 'queued'
  }

  function displayedRunAgentForKind(kind) {
    if (activeRun.value) return runAgentForKind(kind)
    return displayedRunAgentRuns.value.filter(item => item.agentKind === kind).at(-1) || null
  }

  function displayedRunAgentStatusForKind(kind) {
    if (activeRun.value) return runAgentStatus(kind)
    const agent = displayedRunAgentForKind(kind)
    return agent?.status || 'not-started'
  }

  function displayedRunAgentToneForKind(kind) {
    return runStatusTone(displayedRunAgentStatusForKind(kind))
  }

  function displayedRunAgentTraceLabel(kind) {
    const agent = displayedRunAgentForKind(kind)
    return t('trace.viewAgentProcess', {
      agent: agentLabel(kind),
      status: runStatusLabel(agent?.status || displayedRunAgentStatusForKind(kind)),
    })
  }

  return {
    activeMessages,
    activeRun,
    activeRunAgentKind,
    activeRunAgentRuns,
    activeRunAgentStatus,
    activeRunHasAgentRuns,
    activeRunLabel,
    activeRunProgress,
    activeRunTopicRootId,
    activeRunTopicSignature,
    activeTurnRailId,
    allTracePanelItems,
    closeTracePanel,
    clearActiveTurn,
    clearDeletedTurnState,
    conversationEmptyVisible,
    directConclusionLiveStatus,
    directTraceEventLiveStatus,
    dismissSystemMessage,
    displayedRun,
    displayedRunAgentForKind,
    displayedRunAgentKind,
    displayedRunAgentRuns,
    displayedRunAgentStatus,
    displayedRunAgentStatusForKind,
    displayedRunAgentTone,
    displayedRunAgentToneForKind,
    displayedRunAgentTraceLabel,
    displayedRunLabel,
    displayedRunOrchestration,
    displayedRunPhase,
    displayedRunPhaseLabel,
    displayedRunPhaseLiveStatus,
    displayedRunPhaseSlots,
    displayedRunTargetKinds,
    displayedRunTopicRootId,
    focusRunTopic,
    focusTurn,
    formatTime,
    hasFinishedDirectRun,
    isActiveRunTopic,
    isAgentReplyExpanded,
    isCoordinatedRun,
    isDirectTraceOpen,
    isDismissibleSystemWarning,
    isDisplayedCoordinatedRun,
    isTopicExpanded,
    isTopicRoot,
    jumpToTraceSource,
    liveOutputSignature,
    localizedStepTitle,
    messageAgentRunId,
    messageElapsedLabel,
    messageElementId,
    messageExecutionSteps,
    messageHasTrace,
    messageThreadRootId,
    messageTraceEvents,
    messageTraceKey,
    messageTraceStatus,
    messageTraceSummary,
    openDisplayedRunTrace,
    openDisplayedTraceForAgent,
    openTraceForMessage,
    openTracePanel,
    provisionalMessages,
    retainedTraceEvents,
    responseVersionInfo,
    runCompletedKinds,
    runFailedKinds,
    rememberRunFinishedTurnStatus,
    runRoundProgress,
    runStatusLabel,
    runStatusTone,
    runTargetKinds,
    selectResponseVersion,
    selectTraceAgentRun,
    selectedTraceAgentRunId,
    setFinishedDirectRun,
    showLatestResponseVersion,
    syncDirectTraceDisclosure,
    terminalSystemConclusion,
    terminalSystemFallback,
    timelineMessages,
    toggleTopic,
    toggleAgentReply,
    topLevelUserMessages,
    topicReplyAgentKinds,
    topicReplyCount,
    topicReplyLabel,
    topicToggleLabel,
    traceDrawerBlocking,
    traceEventTitle,
    traceEventTypeLabel,
    tracePanel,
    tracePanelDrawer,
    tracePanelGroupId,
    tracePanelItems,
    tracePanelOpen,
    tracePanelRunId,
    turnRailLabel,
    turnRailItems,
  }
}

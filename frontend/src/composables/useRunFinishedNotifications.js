const RUN_FINISHED_STATUSES = new Set([
  'completed', 'partial', 'failed', 'stopped', 'timeout', 'interrupted', 'round-limit',
  'budget-exhausted', 'circuit-breaker',
])

export function useRunFinishedNotifications({
  hasFinishedDirectRun,
  rememberRunFinishedTurnStatus,
  setFinishedDirectRun,
  snapshot,
}) {
  const pendingEvents = new Map()

  function normalizeStatus(status) {
    const normalized = String(status || '').trim().toLowerCase()
    return RUN_FINISHED_STATUSES.has(normalized) ? normalized : 'failed'
  }

  function latestTopLevelUserMessage(groupId) {
    return snapshot.value.messages.filter(message => (
      message.groupId === groupId && message.role === 'user' && !message.threadRootId
    )).at(-1) || null
  }

  function rememberTurn(event, group) {
    const groupId = String(event?.groupId || '')
    const rootId = String(event?.threadRootId || '')
      || (group?.conversationType === 'direct' ? latestTopLevelUserMessage(groupId)?.id : '')
    if (!groupId || !rootId) return false
    rememberRunFinishedTurnStatus(groupId, rootId, normalizeStatus(event?.status))
    return true
  }

  function pendingKey(event) {
    const groupId = String(event?.groupId || '')
    const turnId = String(event?.threadRootId || event?.runId || '')
    return `${groupId}\u0000${turnId}`
  }

  function clearFinishedRun(event) {
    const groupId = String(event?.groupId || '')
    const runId = String(event?.runId || '')
    if (!groupId) return
    const runs = Array.isArray(snapshot.value.runs) ? snapshot.value.runs : []
    const groupRuns = runs.filter(run => run?.groupId === groupId)
    if (!runId && groupRuns.length > 1) return
    let removed = false
    const nextRuns = runs.filter((run) => {
      const matches = run?.groupId === groupId
        && (runId ? run?.runId === runId : groupRuns.length === 1)
      if (matches) removed = true
      return !matches
    })
    const clearStaleRunningOnly = !removed && groupRuns.length === 0
    if (!removed && !clearStaleRunningOnly) return
    const hasRemainingGroupRun = nextRuns.some(run => run?.groupId === groupId)
    const runningGroupIds = Array.isArray(snapshot.value.runningGroupIds)
      ? snapshot.value.runningGroupIds
      : []
    const nextRunningGroupIds = hasRemainingGroupRun
      ? runningGroupIds
      : runningGroupIds.filter(id => id !== groupId)
    if (!removed && nextRunningGroupIds.length === runningGroupIds.length) return
    snapshot.value = {
      ...snapshot.value,
      runs: nextRuns,
      runningGroupIds: nextRunningGroupIds,
    }
  }

  function handleRunFinished(event) {
    const groupId = String(event?.groupId || '')
    if (!groupId) return
    const group = snapshot.value.groups.find(item => item.id === groupId)
    const normalizedEvent = {
      groupId,
      runId: String(event?.runId || ''),
      status: normalizeStatus(event?.status),
      threadRootId: String(event?.threadRootId || ''),
    }
    const key = pendingKey(normalizedEvent)
    if (!group || !rememberTurn(normalizedEvent, group)) {
      pendingEvents.set(key, { ...normalizedEvent })
      if (!group) return
    } else {
      pendingEvents.delete(key)
    }
    clearFinishedRun(normalizedEvent)
    if (normalizedEvent.status !== 'completed') {
      if (hasFinishedDirectRun(groupId)) setFinishedDirectRun(groupId, false)
      return
    }
    setFinishedDirectRun(groupId, true)
  }

  function flushPendingRunFinishedEvents() {
    const readyEvents = [...pendingEvents.entries()].filter(([, event]) => (
      snapshot.value.groups.some(group => group.id === event.groupId)
    ))
    for (const [key] of readyEvents) pendingEvents.delete(key)
    for (const [, event] of readyEvents) handleRunFinished(event)
  }

  function clearPendingRunFinishedEvents() {
    pendingEvents.clear()
  }

  return {
    clearPendingRunFinishedEvents,
    flushPendingRunFinishedEvents,
    handleRunFinished,
  }
}

const DEFAULT_MAX_EVENTS_PER_AGENT = 80
const DEFAULT_MAX_OUTPUT_CHARS = 20000
const DEFAULT_MAX_AGENT_RUNS = 64
const MAX_SEEN_EVENT_SEQUENCES = 512

const {
  EVENT_TYPES,
  FINAL_STATUSES,
  boundedNumber,
  cleanGroupId,
  cleanId,
  cleanStatus,
  cleanText,
  lifecycleEventKey,
  normalizeContextStats,
  normalizeOutcomeRefs,
  normalizeRawEvent,
  normalizeRunEvent,
  normalizeSourceMessageIds,
  normalizeTraceCapsule,
  safeTimestamp,
  sameLifecycleEvent,
  traceCapsuleFromAgentRun,
} = require('./run-harness-normalization.cjs')
const {
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_CONTEXT_ENTRY_LIMIT,
  DEFAULT_SESSION_CHARS,
  DEFAULT_SESSION_TURNS,
  evidenceCapsuleText,
  nextSessionMeta,
  normalizeSessionMeta,
  packContextEntries,
  shouldRotateSession,
} = require('./run-harness-context.cjs')

class RunHarness {
  constructor(options = {}) {
    this.runId = cleanId(options.runId)
    this.groupId = cleanGroupId(options.groupId)
    this.threadRootId = cleanId(options.threadRootId)
    if (!this.runId || !this.groupId) throw new Error('RUN_HARNESS_ID_REQUIRED')
    this.targetKinds = Object.freeze([
      ...new Set((Array.isArray(options.targetKinds) ? options.targetKinds : [])
        .map(kind => cleanId(kind))
        .filter(Boolean)),
    ])
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.createId = typeof options.createId === 'function'
      ? options.createId
      : (() => `${Date.now()}-${Math.random().toString(16).slice(2)}`)
    this.maxEventsPerAgent = Math.max(8, boundedNumber(
      options.maxEventsPerAgent, DEFAULT_MAX_EVENTS_PER_AGENT, 500,
    ))
    this.maxOutputChars = Math.max(1000, boundedNumber(
      options.maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS, 200000,
    ))
    this.maxAgentRuns = Math.max(1, boundedNumber(
      options.maxAgentRuns, DEFAULT_MAX_AGENT_RUNS, 512,
    ))
    this.agentRuns = (Array.isArray(options.agentRuns) ? options.agentRuns : [])
      .slice(-this.maxAgentRuns)
      .map((run) => {
        const events = Array.isArray(run?.events) ? run.events.map(event => ({ ...event })) : []
        const seenSeqs = [...new Set([
          ...(Array.isArray(run?.seenSeqs) ? run.seenSeqs : []),
          ...events.map(event => event?.seq),
        ].map(value => boundedNumber(value, 0, 1000000000)).filter(Boolean))]
          .slice(-MAX_SEEN_EVENT_SEQUENCES)
        const eventCursor = Math.max(
          boundedNumber(run?.eventCursor, 0, 1000000000),
          ...seenSeqs,
        )
        const eventIndexes = new Map()
        events.forEach((event, index) => {
          const key = lifecycleEventKey(event)
          if (key) eventIndexes.set(key, index)
        })
        return {
          agentRunId: cleanId(run?.agentRunId),
          kind: cleanId(run?.kind),
          round: boundedNumber(run?.round, 0, 100000),
          status: cleanStatus(run?.status, 'interrupted'),
          output: cleanText(run?.output, this.maxOutputChars, { redactPaths: false }),
          events,
          eventIndexes,
          sourceMessageIds: normalizeSourceMessageIds(run?.sourceMessageIds),
          startedAt: safeTimestamp(run?.startedAt, 0),
          lastActivityAt: safeTimestamp(run?.lastActivityAt, 0),
          silent: run?.silent === true,
          truncated: run?.truncated === true,
          seenSeqs,
          eventCursor,
          context: normalizeContextStats(run?.context),
        }
      })
      .filter(run => run.agentRunId && run.kind && this.targetKinds.includes(run.kind))
    this.agentRunIds = new Set(this.agentRuns.map(run => run.agentRunId))
    this.sequence = this.agentRuns.reduce((highest, run) => Math.max(
      highest,
      run.eventCursor,
    ), 0)
  }

  timestamp() {
    return safeTimestamp(this.now(), Date.now())
  }

  addTargetKind(kind) {
    const safeKind = cleanId(kind)
    if (!safeKind) throw new Error('RUN_HARNESS_AGENT_REQUIRED')
    if (this.targetKinds.includes(safeKind)) return false
    this.targetKinds = Object.freeze([...this.targetKinds, safeKind])
    return true
  }

  latest(kind, round) {
    for (let index = this.agentRuns.length - 1; index >= 0; index -= 1) {
      const run = this.agentRuns[index]
      if (run.kind === kind && run.round === round) return run
    }
    return null
  }

  current(kind, round, agentRunId = '') {
    const safeKind = cleanId(kind)
    if (!safeKind || !this.targetKinds.includes(safeKind)) return null
    const run = this.latest(safeKind, boundedNumber(round, 0, 100000))
    if (!run) return null
    const expectedAgentRunId = cleanId(agentRunId)
    if (agentRunId && (!expectedAgentRunId || run.agentRunId !== expectedAgentRunId)) return null
    return run
  }

  nextEvent(run, event) {
    const next = {
      runId: this.runId,
      agentRunId: run.agentRunId,
      groupId: this.groupId,
      threadRootId: this.threadRootId,
      agentKind: run.kind,
      round: run.round,
      seq: ++this.sequence,
      timestamp: this.timestamp(),
      status: cleanStatus(event.status, run.status),
      ...event,
    }
    run.eventCursor = next.seq
    return next
  }

  beginAgent(kind, round = 0, sourceMessageIds = [], options = {}) {
    const safeKind = cleanId(kind)
    if (!safeKind) throw new Error('RUN_HARNESS_AGENT_REQUIRED')
    if (!this.targetKinds.includes(safeKind)) {
      throw new Error('RUN_HARNESS_AGENT_NOT_TARGETED')
    }
    const safeRound = boundedNumber(round, 0, 100000)
    const token = cleanId(this.createId(), `${this.agentRuns.length + 1}`)
    let agentRunId = cleanId(`${this.runId}:${safeRound}:${safeKind}:${token}`)
      || cleanId(`${this.runId}:${safeRound}:${safeKind}:${this.agentRuns.length + 1}`)
    if (!agentRunId) throw new Error('RUN_HARNESS_AGENT_RUN_ID_INVALID')
    let suffix = this.agentRuns.length + 1
    while (this.agentRunIds.has(agentRunId)) {
      suffix += 1
      agentRunId = cleanId(`${this.runId}:${safeRound}:${safeKind}:${suffix}`)
      if (!agentRunId) throw new Error('RUN_HARNESS_AGENT_RUN_ID_INVALID')
    }
    this.agentRunIds.add(agentRunId)
    const timestamp = this.timestamp()
    const run = {
      agentRunId,
      kind: safeKind,
      round: safeRound,
      status: 'running',
      output: '',
      events: [],
      eventIndexes: new Map(),
      sourceMessageIds: normalizeSourceMessageIds(sourceMessageIds),
      startedAt: timestamp,
      lastActivityAt: timestamp,
      silent: false,
      truncated: false,
      seenSeqs: [],
      eventCursor: 0,
      context: {},
      // Per-topic dispatch order; the live bubble and the saved reply share it.
      ...(Number.isSafeInteger(options?.turnSeq) && options.turnSeq > 0
        ? { turnSeq: options.turnSeq }
        : {}),
    }
    this.agentRuns.push(run)
    while (this.agentRuns.length > this.maxAgentRuns) {
      const removable = this.agentRuns.findIndex(item => FINAL_STATUSES.has(item.status))
      this.agentRuns.splice(removable >= 0 ? removable : 0, 1)
    }
    return this.record(run, { id: 'agent', type: 'status', status: 'running', title: 'agent' })
  }

  record(run, normalized) {
    let input = normalized
    if (normalized.type === 'answer_delta') {
      const currentLength = normalized.replace === true ? 0 : run.output.length
      const remaining = Math.max(0, this.maxOutputChars - currentLength)
      if (!remaining) {
        run.truncated = true
        return null
      }
      const delta = String(normalized.delta || '')
      if (delta.length > remaining) {
        input = { ...normalized, delta: delta.slice(0, remaining) }
        run.truncated = true
      }
    }
    const eventKey = lifecycleEventKey(input)
    const existingIndex = eventKey ? run.eventIndexes.get(eventKey) : null
    if (existingIndex != null
        && sameLifecycleEvent(run.events[existingIndex], input, run.status)) return null

    const event = this.nextEvent(run, input)
    run.lastActivityAt = event.timestamp
    run.silent = false
    run.seenSeqs.push(event.seq)
    if (run.seenSeqs.length > MAX_SEEN_EVENT_SEQUENCES) {
      run.seenSeqs.splice(0, run.seenSeqs.length - MAX_SEEN_EVENT_SEQUENCES)
    }
    if (event.type === 'answer_delta') {
      const next = event.replace === true ? event.delta : `${run.output}${event.delta}`
      if (next.length > this.maxOutputChars) run.truncated = true
      run.output = next.slice(0, this.maxOutputChars)
      return event
    }

    if (existingIndex != null) {
      run.events[existingIndex] = event
      return event
    }
    if (run.events.length >= this.maxEventsPerAgent) {
      run.events.shift()
      run.truncated = true
      run.eventIndexes.clear()
      run.events.forEach((item, index) => {
        const key = lifecycleEventKey(item)
        if (key) run.eventIndexes.set(key, index)
      })
    }
    if (eventKey) run.eventIndexes.set(eventKey, run.events.length)
    run.events.push(event)
    return event
  }

  ingest(kind, round, rawEvent, agentRunId = '') {
    const normalized = normalizeRawEvent(rawEvent)
    if (!normalized) return null
    const run = this.current(kind, round, agentRunId)
    if (!run || FINAL_STATUSES.has(run.status)) return null
    if (normalized.type === 'status' && normalized.status) run.status = normalized.status
    return this.record(run, normalized)
  }

  markSilent(kind, round, agentRunId = '') {
    const run = this.current(kind, round, agentRunId)
    if (!run || run.silent || FINAL_STATUSES.has(run.status)) return null
    run.silent = true
    const event = this.nextEvent(run, {
      id: 'silence',
      type: 'warning',
      status: 'waiting',
      title: 'waiting_for_output',
    })
    run.lastActivityAt = event.timestamp
    run.seenSeqs.push(event.seq)
    if (run.seenSeqs.length > MAX_SEEN_EVENT_SEQUENCES) {
      run.seenSeqs.splice(0, run.seenSeqs.length - MAX_SEEN_EVENT_SEQUENCES)
    }
    if (run.events.length >= this.maxEventsPerAgent) {
      run.events.shift()
      run.truncated = true
      run.eventIndexes.clear()
      run.events.forEach((item, index) => {
        const key = lifecycleEventKey(item)
        if (key) run.eventIndexes.set(key, index)
      })
    }
    run.events.push(event)
    return event
  }

  finishAgent(kind, round, status, finalText, context = {}, agentRunId = '') {
    const run = this.current(kind, round, agentRunId)
    if (!run) throw new Error('RUN_HARNESS_AGENT_NOT_FOUND')
    run.status = FINAL_STATUSES.has(status) ? status : 'failed'
    run.silent = false
    const finalOutput = cleanText(finalText, this.maxOutputChars, { redactPaths: false })
    if (finalOutput) {
      if (String(finalText || '').length > this.maxOutputChars) run.truncated = true
      run.output = finalOutput
    }
    const event = this.record(run, {
      id: 'agent',
      type: 'status',
      status: run.status,
      title: 'agent',
    })
    const phase = context && typeof context === 'object' ? context.phase : ''
    run.context = normalizeContextStats(context)
    const capsule = traceCapsuleFromAgentRun(run, {
      runId: this.runId,
      status: run.status,
      phase,
      executionSequence: context && Number.isInteger(context.executionSequence)
        ? context.executionSequence
        : undefined,
      context: run.context,
    })
    return { event, capsule }
  }

  snapshot() {
    return this.agentRuns.map(run => ({
      agentRunId: run.agentRunId,
      kind: run.kind,
      round: run.round,
      status: run.status,
      output: run.output,
      events: run.events.map(({ delta: _delta, ...event }) => ({ ...event })),
      sourceMessageIds: [...run.sourceMessageIds],
      startedAt: run.startedAt,
      lastActivityAt: run.lastActivityAt,
      silent: run.silent,
      truncated: run.truncated,
      seenSeqs: [...run.seenSeqs],
      eventCursor: run.eventCursor,
      context: { ...run.context },
      ...(run.turnSeq ? { turnSeq: run.turnSeq } : {}),
    }))
  }
}

module.exports = {
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_CONTEXT_ENTRY_LIMIT,
  DEFAULT_MAX_EVENTS_PER_AGENT,
  DEFAULT_MAX_AGENT_RUNS,
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_SESSION_CHARS,
  DEFAULT_SESSION_TURNS,
  EVENT_TYPES,
  RunHarness,
  evidenceCapsuleText,
  nextSessionMeta,
  normalizeRawEvent,
  normalizeOutcomeRefs,
  normalizeRunEvent,
  normalizeSessionMeta,
  normalizeTraceCapsule,
  packContextEntries,
  shouldRotateSession,
  traceCapsuleFromAgentRun,
}

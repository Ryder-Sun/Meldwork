const fs = require('node:fs')

const { atomicWritePrivateFile } = require('../security/private-file.cjs')
const { RunJournal } = require('./run-journal.cjs')
const {
  DEFAULT_MAX_DURABLE_AGENT_RUNS,
  RUN_STATUSES,
  TERMINAL_STATUSES,
  boundedNumber,
  cleanGroupId,
  cleanId,
  cleanOpaqueRemoteValue,
  clone,
  hasValidStoredRecordShape,
  isRecord,
  newestFirst,
  normalizeRecord,
  pruneRecords,
  safeTimestamp,
} = require('./run-ledger-records.cjs')

const STORE_VERSION = 1
const DEFAULT_MAX_RUNS = 64
const MAX_RUNS = 512
const JOURNAL_OUTPUT_BUCKET_CHARS = 4096

function mergeAgentRuns(existingRuns, incomingRuns, targetKinds) {
  const allowedKinds = new Set(targetKinds)
  const merged = (Array.isArray(existingRuns) ? existingRuns : [])
    .filter(agentRun => allowedKinds.has(agentRun.kind))
    .map(clone)
  const indexes = new Map(merged.map((agentRun, index) => [agentRun.agentRunId, index]))
  for (const agentRun of Array.isArray(incomingRuns) ? incomingRuns : []) {
    const index = indexes.get(agentRun.agentRunId)
    if (index === undefined) {
      indexes.set(agentRun.agentRunId, merged.length)
      merged.push(agentRun)
    } else {
      merged[index] = agentRun
    }
  }
  return merged.slice(-DEFAULT_MAX_DURABLE_AGENT_RUNS)
}

function journalAgentRun(agentRun) {
  const record = {
    agentRunId: agentRun.agentRunId,
    kind: agentRun.kind,
    round: agentRun.round,
    status: agentRun.status,
    sourceMessageIds: agentRun.sourceMessageIds,
    startedAt: agentRun.startedAt,
    lastActivityAt: agentRun.lastActivityAt,
    silent: agentRun.silent,
    truncated: agentRun.truncated,
    context: agentRun.context,
    eventCursor: agentRun.eventCursor,
    outputChars: agentRun.outputChars,
  }
  if (agentRun.reason) record.reason = agentRun.reason
  if (agentRun.finishedAt != null) record.finishedAt = agentRun.finishedAt
  return record
}

function journalAgentSignature(agentRun) {
  return JSON.stringify({
    status: agentRun.status,
    reason: agentRun.reason || '',
    eventCursor: agentRun.eventCursor || 0,
    outputBucket: Math.floor((agentRun.outputChars || 0) / JOURNAL_OUTPUT_BUCKET_CHARS),
    silent: agentRun.silent === true,
    truncated: agentRun.truncated === true,
    sourceMessageIds: agentRun.sourceMessageIds || [],
    context: agentRun.context || {},
    finishedAt: agentRun.finishedAt || 0,
  })
}

function journalRunSignature(record) {
  return JSON.stringify({
    runId: record.runId,
    taskId: record.taskId,
    contextPackId: record.contextPackId,
    contextPackState: record.contextPackState,
    groupId: record.groupId,
    threadRootId: record.threadRootId,
    mode: record.mode,
    targetKinds: record.targetKinds,
    status: record.status,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt || 0,
    reason: record.reason || '',
    permissionMode: record.permissionMode,
    currentRound: record.currentRound,
    maxRounds: record.maxRounds,
    unlimitedRounds: record.unlimitedRounds,
    budget: record.budget || null,
    attemptHistory: record.attemptHistory,
    continuation: record.continuation || null,
    orchestration: record.orchestration || null,
    remoteJob: record.remoteJob || null,
  })
}

function journalRun(record, existing = null, includeAllAgents = false) {
  const previous = new Map((existing?.agentRuns || []).map(agentRun => [
    agentRun.agentRunId, agentRun,
  ]))
  const publicAgentRunId = record.continuation?.publicAgentRunId || ''
  const agentRuns = record.agentRuns.filter((agentRun) => {
    if (includeAllAgents || agentRun.agentRunId === publicAgentRunId) return true
    const prior = previous.get(agentRun.agentRunId)
    return !prior || journalAgentSignature(prior) !== journalAgentSignature(agentRun)
  }).map(journalAgentRun)
  const run = {
    runId: record.runId,
    taskId: record.taskId,
    contextPackId: record.contextPackId,
    contextPackState: record.contextPackState,
    groupId: record.groupId,
    threadRootId: record.threadRootId,
    mode: record.mode,
    targetKinds: record.targetKinds,
    status: record.status,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    reason: record.reason,
    permissionMode: record.permissionMode,
    currentRound: record.currentRound,
    maxRounds: record.maxRounds,
    unlimitedRounds: record.unlimitedRounds,
    attemptHistory: record.attemptHistory,
    agentRuns,
  }
  if (record.continuation) run.continuation = record.continuation
  if (record.orchestration) run.orchestration = record.orchestration
  if (record.budget) run.budget = record.budget
  if (record.finishedAt != null) run.finishedAt = record.finishedAt
  if (record.remoteJob) run.remoteJob = record.remoteJob
  return run
}

function stableWriteError(error) {
  if (error?.message === 'RUN_LEDGER_WRITE_FAILED') return error
  const wrapped = new Error('RUN_LEDGER_WRITE_FAILED')
  wrapped.cause = error
  return wrapped
}

class RunLedger {
  constructor(options = {}) {
    this.storagePath = typeof options.storagePath === 'string'
      ? options.storagePath.trim()
      : ''
    if (!this.storagePath) throw new Error('RUN_LEDGER_STORAGE_REQUIRED')
    this.journalPath = typeof options.journalPath === 'string' && options.journalPath.trim()
      ? options.journalPath.trim()
      : `${this.storagePath}.journal`
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.maxRuns = Math.max(1, Math.min(
      MAX_RUNS,
      boundedNumber(options.maxRuns, DEFAULT_MAX_RUNS, MAX_RUNS),
    ))
    this.loadError = null
    this.snapshotError = null
    this.journal = new RunJournal({
      storagePath: this.journalPath,
      compactionBytes: options.journalCompactionBytes,
    })
    this.runs = this.load()
  }

  timestamp() {
    return safeTimestamp(this.now(), Date.now())
  }

  loadSnapshot() {
    try {
      if (!fs.existsSync(this.storagePath)) return { exists: false, runs: [] }
      const parsed = JSON.parse(fs.readFileSync(this.storagePath, 'utf8'))
      if (!isRecord(parsed) || parsed.version !== STORE_VERSION || !Array.isArray(parsed.runs)) {
        throw new Error('RUN_LEDGER_STORE_INVALID')
      }
      const runIds = new Set()
      const agentRunIds = new Set()
      for (const rawRecord of parsed.runs) {
        const normalized = hasValidStoredRecordShape(rawRecord)
          ? normalizeRecord(rawRecord, { now: 0, allowLegacyContext: true })
          : null
        if (!normalized || runIds.has(normalized.runId)) {
          throw new Error('RUN_LEDGER_STORE_INVALID')
        }
        runIds.add(normalized.runId)
        for (const agentRun of rawRecord.agentRuns || []) {
          if (agentRunIds.has(agentRun.agentRunId)) {
            throw new Error('RUN_LEDGER_STORE_INVALID')
          }
          agentRunIds.add(agentRun.agentRunId)
        }
      }
      const byId = new Map()
      for (const rawRecord of parsed.runs) {
        const normalized = normalizeRecord(rawRecord, { now: 0, allowLegacyContext: true })
        byId.set(normalized.runId, normalized)
      }
      return { exists: true, runs: pruneRecords([...byId.values()], this.maxRuns) }
    } catch (error) {
      return {
        exists: true,
        runs: [],
        error: error instanceof Error ? error : new Error(String(error)),
      }
    }
  }

  normalizeRecoveredRuns(value) {
    const records = []
    const runIds = new Set()
    const agentRunIds = new Set()
    for (const rawRecord of Array.isArray(value) ? value : []) {
      const normalized = normalizeRecord(rawRecord, { now: 0, allowLegacyContext: true })
      if (!normalized || runIds.has(normalized.runId)) {
        throw new Error('RUN_JOURNAL_STORE_INVALID')
      }
      runIds.add(normalized.runId)
      for (const agentRun of normalized.agentRuns) {
        if (agentRunIds.has(agentRun.agentRunId)) {
          throw new Error('RUN_JOURNAL_STORE_INVALID')
        }
        agentRunIds.add(agentRun.agentRunId)
      }
      records.push(normalized)
    }
    return pruneRecords(records, this.maxRuns)
  }

  enrichRecoveredRuns(recoveredRuns, snapshotRuns) {
    const snapshotById = new Map(snapshotRuns.map(record => [record.runId, record]))
    return recoveredRuns.map((record) => {
      const snapshot = snapshotById.get(record.runId)
      if (!snapshot) return record
      const runLifecycleAligned = journalRunSignature(snapshot) === journalRunSignature(record)
      const snapshotIsOlder = snapshot.updatedAt < record.updatedAt
      if (!runLifecycleAligned && !snapshotIsOlder) {
        return record
      }
      const snapshotAgents = new Map(snapshot.agentRuns.map(agentRun => [
        agentRun.agentRunId, agentRun,
      ]))
      return {
        ...record,
        agentRuns: record.agentRuns.map((agentRun) => {
          const details = snapshotAgents.get(agentRun.agentRunId)
          if (!details || details.kind !== agentRun.kind) return agentRun
          const agentLifecycleAligned = journalAgentSignature(details)
            === journalAgentSignature(agentRun)
          const detailsAreOlder = snapshotIsOlder
            && details.round === agentRun.round
            && details.startedAt === agentRun.startedAt
            && details.lastActivityAt <= agentRun.lastActivityAt
            && details.eventCursor <= agentRun.eventCursor
          if (!agentLifecycleAligned && !detailsAreOlder) {
            return agentRun
          }
          return {
            ...agentRun,
            output: details.output,
            events: clone(details.events),
          }
        }),
      }
    })
  }

  load() {
    const snapshot = this.loadSnapshot()
    if (this.journal.loadError) {
      this.loadError = this.journal.loadError
      return []
    }
    let recovered = null
    try {
      recovered = this.journal.recover()
    } catch (error) {
      this.loadError = error instanceof Error ? error : new Error(String(error))
      return []
    }
    if (recovered) {
      try {
        const normalized = this.normalizeRecoveredRuns(recovered)
        if (!snapshot.error && snapshot.exists) {
          return this.enrichRecoveredRuns(normalized, snapshot.runs)
        }
        this.snapshotError = snapshot.error || new Error('RUN_LEDGER_SNAPSHOT_MISSING')
        return normalized
      } catch (error) {
        this.loadError = error instanceof Error ? error : new Error(String(error))
        return []
      }
    }
    if (snapshot.error) this.loadError = snapshot.error
    return snapshot.runs
  }

  assertLoaded() {
    if (this.loadError) throw new Error('RUN_LEDGER_LOAD_FAILED')
  }

  persist(runs = this.runs) {
    atomicWritePrivateFile(
      this.storagePath,
      `${JSON.stringify({ version: STORE_VERSION, runs })}\n`,
    )
  }

  journalBaseline() {
    return this.runs.map(record => journalRun(record, null, true))
  }

  journalChange(nextRuns, upsertRunIds = []) {
    const previousById = new Map(this.runs.map(record => [record.runId, record]))
    const nextById = new Map(nextRuns.map(record => [record.runId, record]))
    const upserts = [...new Set(upsertRunIds)]
      .map(runId => nextById.get(runId))
      .filter(Boolean)
      .map((record) => {
        const existing = previousById.get(record.runId)
        const patch = journalRun(record, existing)
        return !existing
          || journalRunSignature(existing) !== journalRunSignature(record)
          || patch.agentRuns.length
          ? patch
          : null
      })
      .filter(Boolean)
    return {
      replace: false,
      upserts,
      removedRunIds: this.runs
        .filter(record => !nextById.has(record.runId))
        .map(record => record.runId),
    }
  }

  commit(nextRuns, upsertRunIds = []) {
    const timestamp = this.timestamp()
    let change
    let transactionId = ''
    try {
      this.journal.ensureBaseline(this.journalBaseline(), timestamp)
      change = this.journalChange(nextRuns, upsertRunIds)
      if (change.upserts.length || change.removedRunIds.length) {
        transactionId = this.journal.prepare(change, timestamp)
      }
    } catch (error) {
      throw stableWriteError(error)
    }
    try {
      this.persist(nextRuns)
    } catch (error) {
      throw stableWriteError(error)
    }
    if (transactionId) {
      try {
        this.journal.commit(transactionId, timestamp)
      } catch (error) {
        try {
          this.persist(this.runs)
        } catch (rollbackError) {
          if (error && typeof error === 'object') error.rollbackError = rollbackError
        }
        throw stableWriteError(error)
      }
    }
    this.runs = nextRuns
    this.snapshotError = null
    this.journal.compactIfNeeded(this.journalBaseline(), timestamp)
  }

  checkpoint(record) {
    this.assertLoaded()
    if (!isRecord(record) || !cleanId(record.runId)) {
      throw new Error('RUN_LEDGER_RECORD_INVALID')
    }
    const index = this.runs.findIndex(item => item.runId === record.runId)
    const existing = index >= 0 ? this.runs[index] : null
    if (!existing && (
      record.contextPackState !== 'captured'
      || !cleanId(record.taskId)
      || !record.contextPackId
    )) {
      throw new Error('RUN_LEDGER_RECORD_INVALID')
    }
    if (existing?.contextPackState === 'captured' && [
      'taskId', 'contextPackId', 'contextPackState',
    ].some(field => Object.hasOwn(record, field) && record[field] !== existing[field])) {
      throw new Error('RUN_LEDGER_RECORD_INVALID')
    }
    if (existing?.contextPackState === 'legacy-unavailable'
        && (record.contextPackState === 'captured' || record.contextPackId)) {
      throw new Error('RUN_LEDGER_RECORD_INVALID')
    }
    const normalized = normalizeRecord(record, {
      existing,
      now: this.timestamp(),
      touch: true,
    })
    if (!normalized) throw new Error('RUN_LEDGER_RECORD_INVALID')
    if (existing) {
      normalized.agentRuns = mergeAgentRuns(
        existing.agentRuns,
        normalized.agentRuns,
        normalized.targetKinds,
      )
    }
    const nextRuns = this.runs.filter((_item, recordIndex) => recordIndex !== index)
    nextRuns.push(normalized)
    this.commit(pruneRecords(nextRuns, this.maxRuns), [normalized.runId])
    return clone(normalized)
  }

  reconcileContextPacks(resolveContextPack) {
    this.assertLoaded()
    if (typeof resolveContextPack !== 'function') {
      throw new Error('RUN_LEDGER_CONTEXT_RESOLVER_REQUIRED')
    }
    const validity = new Map()
    const isValid = (contextPackId, taskId) => {
      const key = `${contextPackId}\u0000${taskId}`
      if (validity.has(key)) return validity.get(key)
      let valid = false
      try {
        const pack = resolveContextPack(contextPackId)
        valid = Boolean(
          pack
          && pack.contextPackId === contextPackId
          && pack.taskId === taskId,
        )
      } catch { /* missing and tampered packs are both unavailable */ }
      validity.set(key, valid)
      return valid
    }
    const nextRuns = clone(this.runs)
    const changedRunIds = []
    for (const record of nextRuns) {
      let changed = false
      const runContextAvailable = record.contextPackState === 'captured'
        && isValid(record.contextPackId, record.taskId)
      if (!runContextAvailable && record.contextPackState === 'captured') {
        record.contextPackId = ''
        record.contextPackState = 'legacy-unavailable'
        changed = true
      }
      for (const agentRun of record.agentRuns) {
        const context = agentRun.context
        if (!context?.contextPackId) continue
        if (runContextAvailable && isValid(context.contextPackId, record.taskId)) continue
        agentRun.context = {
          ...context,
          contextPackState: 'legacy-unavailable',
        }
        delete agentRun.context.contextPackId
        changed = true
      }
      if (changed) changedRunIds.push(record.runId)
    }
    if (changedRunIds.length) this.commit(nextRuns, changedRunIds)
    return clone(nextRuns.filter(record => changedRunIds.includes(record.runId)))
  }

  finish(runId, status, reason = '') {
    this.assertLoaded()
    const id = cleanId(runId)
    const index = this.runs.findIndex(record => record.runId === id)
    if (index < 0) return null
    const requestedStatus = String(status || '').toLowerCase()
    const terminalStatus = TERMINAL_STATUSES.has(requestedStatus) ? requestedStatus : 'failed'
    const now = this.timestamp()
    const normalized = normalizeRecord({
      runId: id,
      status: terminalStatus,
      reason,
      finishedAt: now,
    }, {
      existing: this.runs[index],
      now,
      touch: true,
    })
    const nextRuns = this.runs.filter((_record, recordIndex) => recordIndex !== index)
    nextRuns.push(normalized)
    this.commit(pruneRecords(nextRuns, this.maxRuns), [normalized.runId])
    return clone(normalized)
  }

  recoverInterrupted(options = {}) {
    this.assertLoaded()
    const now = this.timestamp()
    const recoveryOwnerId = cleanId(options.recoveryOwnerId)
    const remoteConnectorIds = new Set((Array.isArray(options.remoteConnectorIds)
      ? options.remoteConnectorIds
      : []).map(cleanId).filter(Boolean))
    const preserveWaitingRun = typeof options.preserveWaitingRun === 'function'
      ? options.preserveWaitingRun
      : () => false
    const nextRuns = clone(this.runs)
    const changed = []
    for (let index = 0; index < nextRuns.length; index += 1) {
      const record = nextRuns[index]
      let recordChanged = false
      if (!TERMINAL_STATUSES.has(record.status)) {
        let preserveWaiting = false
        try { preserveWaiting = preserveWaitingRun(clone(record)) === true } catch {}
        const canReconcileRemote = Boolean(
          recoveryOwnerId
          && record.remoteJob?.jobId
          && remoteConnectorIds.has(record.remoteJob.connectorId),
        )
        if (preserveWaiting) {
          record.status = 'waiting'
          record.reason = 'human_gate_pending'
          delete record.finishedAt
        } else if (canReconcileRemote) {
          record.status = 'reconciling'
          record.reason = 'app_restart'
          delete record.finishedAt
          record.remoteJob.recoveryOwnerId = recoveryOwnerId
        } else {
          record.status = 'interrupted'
          record.reason = 'app_restart'
          record.finishedAt = now
        }
        recordChanged = true
      }
      if (record.status !== 'reconciling') {
        for (const agentRun of record.agentRuns) {
          if (TERMINAL_STATUSES.has(agentRun.status)) continue
          agentRun.status = 'interrupted'
          agentRun.reason = 'app_restart'
          agentRun.lastActivityAt = now
          agentRun.finishedAt = now
          agentRun.silent = false
          recordChanged = true
        }
      }
      if (!recordChanged) continue
      record.updatedAt = now
      const normalized = normalizeRecord(record, {
        now,
        allowLegacyContext: record.contextPackState === 'legacy-unavailable',
      })
      nextRuns[index] = normalized
      changed.push(normalized)
    }
    if (changed.length) this.commit(nextRuns, changed.map(record => record.runId))
    return clone(newestFirst(changed))
  }

  remoteRecoveries(recoveryOwnerId) {
    const ownerId = cleanId(recoveryOwnerId)
    if (!ownerId) return []
    return newestFirst(this.runs.filter(record => (
      !TERMINAL_STATUSES.has(record.status)
      && record.remoteJob?.recoveryOwnerId === ownerId
    ))).map(record => ({
      runId: record.runId,
      taskId: record.taskId,
      groupId: record.groupId,
      connectorId: record.remoteJob.connectorId,
      jobId: record.remoteJob.jobId,
      cursor: record.remoteJob.cursor,
    }))
  }

  reconcileRemote(runId, recoveryOwnerId, update = {}) {
    this.assertLoaded()
    const id = cleanId(runId)
    const ownerId = cleanId(recoveryOwnerId)
    const index = this.runs.findIndex(record => record.runId === id)
    const existing = index >= 0 ? this.runs[index] : null
    if (!existing?.remoteJob || TERMINAL_STATUSES.has(existing.status)
        || !ownerId || existing.remoteJob.recoveryOwnerId !== ownerId) {
      throw new Error('RUN_LEDGER_RECOVERY_OWNER_INVALID')
    }
    const requestedStatus = String(update.status || 'running').toLowerCase()
    if (!RUN_STATUSES.has(requestedStatus)
        || ['preparing', 'queued', 'reconciling'].includes(requestedStatus)) {
      throw new Error('RUN_LEDGER_REMOTE_UPDATE_INVALID')
    }
    const requestedCursor = update.cursor == null
      ? existing.remoteJob.cursor
      : cleanOpaqueRemoteValue(update.cursor)
    if (update.cursor != null && !requestedCursor) {
      throw new Error('RUN_LEDGER_REMOTE_UPDATE_INVALID')
    }
    const agentRuns = clone(existing.agentRuns)
    if (TERMINAL_STATUSES.has(requestedStatus)) {
      for (const agentRun of agentRuns) {
        if (TERMINAL_STATUSES.has(agentRun.status)) continue
        agentRun.status = requestedStatus === 'round-limit'
          ? 'partial'
          : (requestedStatus === 'budget-exhausted'
              ? 'failed'
              : (requestedStatus === 'circuit-breaker' ? 'stopped' : requestedStatus))
        agentRun.lastActivityAt = this.timestamp()
        agentRun.finishedAt = agentRun.lastActivityAt
        agentRun.silent = false
      }
    }
    return this.checkpoint({
      runId: id,
      status: requestedStatus,
      reason: String(update.reason || ''),
      ...(TERMINAL_STATUSES.has(requestedStatus) ? { finishedAt: this.timestamp() } : {}),
      remoteJob: {
        ...existing.remoteJob,
        cursor: requestedCursor,
        recoveryOwnerId: TERMINAL_STATUSES.has(requestedStatus) ? '' : ownerId,
      },
      agentRuns,
    })
  }

  list(groupId = '') {
    const requestedGroupId = String(groupId || '')
    const normalizedGroupId = requestedGroupId ? cleanGroupId(requestedGroupId) : ''
    if (requestedGroupId && !normalizedGroupId) return []
    const records = normalizedGroupId
      ? this.runs.filter(record => record.groupId === normalizedGroupId)
      : this.runs
    return clone(newestFirst(records))
  }

  get(runId) {
    const id = cleanId(runId)
    const record = id ? this.runs.find(item => item.runId === id) : null
    return record ? clone(record) : null
  }

  deleteGroup(groupId) {
    this.assertLoaded()
    const id = cleanGroupId(groupId)
    if (!id) return 0
    const before = this.runs.length
    const nextRuns = this.runs.filter(record => record.groupId !== id)
    const removed = before - nextRuns.length
    if (removed) this.commit(nextRuns)
    return removed
  }
}

module.exports = { RunLedger }

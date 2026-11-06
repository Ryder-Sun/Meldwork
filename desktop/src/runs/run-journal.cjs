const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { hasValidStoredRecordShape } = require('./run-ledger-records.cjs')
const { atomicWritePrivateFile } = require('../security/private-file.cjs')
const { isLegacyMultiWriter, recoverLegacyRecord } = require('./run-ledger-legacy.cjs')

const JOURNAL_VERSION = 1
const DEFAULT_COMPACTION_BYTES = 4 * 1024 * 1024
const JOURNAL_ID = /^[A-Za-z0-9._:-]{1,160}$/
const MAX_CHANGE_ITEMS = 1024
const CHANGE_FIELDS = new Set(['replace', 'upserts', 'removedRunIds'])
const RUN_FIELDS = new Set([
  'runId', 'taskId', 'contextPackId', 'contextPackState', 'groupId', 'threadRootId', 'mode',
  'targetKinds', 'status', 'createdAt', 'startedAt', 'updatedAt', 'finishedAt',
  'reason', 'permissionMode', 'currentRound', 'maxRounds', 'unlimitedRounds',
  'budget', 'attemptHistory', 'continuation', 'orchestration', 'remoteJob', 'agentRuns',
])
const AGENT_RUN_FIELDS = new Set([
  'agentRunId', 'kind', 'round', 'status', 'reason', 'sourceMessageIds',
  'startedAt', 'lastActivityAt', 'finishedAt', 'silent', 'truncated', 'context',
  'eventCursor', 'outputChars',
])
const REMOTE_JOB_FIELDS = new Set([
  'connectorId', 'jobId', 'cursor', 'recoveryOwnerId',
])
const CONTEXT_FIELDS = new Set([
  'includedCount', 'omittedCount', 'charCount', 'sessionRotated', 'externalRunRef',
  'contextMode', 'promptChars', 'contextPackId', 'contextPackState', 'deliveryRecordIds',
  'sessionProvenance', 'outcomeRefs', 'sourceCount', 'sourceHash', 'promptBytes',
  'promptHash', 'wirePayloadBytes', 'wirePayloadHash', 'operationId', 'snapshotHash',
  'connector', 'connectorEventState', 'taskDecision',
])

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function validId(value) {
  return typeof value === 'string' && JOURNAL_ID.test(value)
}

function validChange(change) {
  if (!change || typeof change !== 'object' || Array.isArray(change)) return false
  if (Object.keys(change).some(field => !CHANGE_FIELDS.has(field))) return false
  if (change.replace !== true && change.replace !== false) return false
  if (!Array.isArray(change.upserts) || change.upserts.length > MAX_CHANGE_ITEMS) return false
  if (!Array.isArray(change.removedRunIds)
      || change.removedRunIds.length > MAX_CHANGE_ITEMS
      || change.removedRunIds.some(id => !validId(id))) return false
  return change.upserts.every((run) => {
    if (!run || typeof run !== 'object' || Array.isArray(run)) return false
    if (Object.keys(run).some(field => !RUN_FIELDS.has(field))) return false
    if (!validId(run.runId) || typeof run.groupId !== 'string') return false
    if (!hasValidStoredRecordShape(run)) return false
    if (run.remoteJob && Object.keys(run.remoteJob).some(
      field => !REMOTE_JOB_FIELDS.has(field),
    )) return false
    if (!Array.isArray(run.agentRuns) || run.agentRuns.length > MAX_CHANGE_ITEMS) return false
    return run.agentRuns.every(agentRun => (
      agentRun && typeof agentRun === 'object' && !Array.isArray(agentRun)
      && Object.keys(agentRun).every(field => AGENT_RUN_FIELDS.has(field))
      && validId(agentRun.agentRunId)
      && (!agentRun.context || Object.keys(agentRun.context).every(
        field => CONTEXT_FIELDS.has(field),
      ))
    ))
  })
}

function mergeRun(existing, patch) {
  const next = { ...(existing || {}), ...patch, agentRuns: [] }
  const agentRuns = Array.isArray(existing?.agentRuns) ? existing.agentRuns.map(clone) : []
  const indexes = new Map(agentRuns.map((agentRun, index) => [agentRun.agentRunId, index]))
  for (const agentRun of patch.agentRuns) {
    const index = indexes.get(agentRun.agentRunId)
    if (index === undefined) {
      indexes.set(agentRun.agentRunId, agentRuns.length)
      agentRuns.push(clone(agentRun))
    } else {
      agentRuns[index] = { ...agentRuns[index], ...clone(agentRun) }
    }
  }
  next.agentRuns = agentRuns
  return next
}

class RunJournal {
  constructor(options = {}) {
    this.storagePath = typeof options.storagePath === 'string'
      ? options.storagePath.trim()
      : ''
    if (!this.storagePath) throw new Error('RUN_JOURNAL_STORAGE_REQUIRED')
    this.compactionBytes = Number.isFinite(options.compactionBytes)
      ? Math.max(1024, Math.floor(options.compactionBytes))
      : DEFAULT_COMPACTION_BYTES
    this.sequence = 0
    this.loadError = null
    this.hasBaseline = false
    this.runs = new Map()
    this.pending = new Map()
    this.legacyRunIds = new Set()
    this.load()
  }

  repairTruncatedTail(buffer) {
    if (!buffer.length || buffer.at(-1) === 0x0a) return buffer
    const lastNewline = buffer.lastIndexOf(0x0a)
    const length = lastNewline >= 0 ? lastNewline + 1 : 0
    fs.truncateSync(this.storagePath, length)
    return buffer.subarray(0, length)
  }

  load() {
    try {
      if (!fs.existsSync(this.storagePath)) return
      const stat = fs.lstatSync(this.storagePath)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('RUN_JOURNAL_STORE_INVALID')
      const buffer = this.repairTruncatedTail(fs.readFileSync(this.storagePath))
      const lines = buffer.toString('utf8').split('\n').filter(Boolean)
      // Detect legacy run IDs across the complete journal before replaying
      // partial patches, so none can restore a previously unsafe policy.
      for (const line of lines) {
        const entry = JSON.parse(line)
        for (const run of entry?.change?.upserts || []) {
          if (isLegacyMultiWriter(run)) this.legacyRunIds.add(run.runId)
        }
      }
      const committed = new Set()
      for (const line of lines) {
        const entry = JSON.parse(line)
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)
            || entry.version !== JOURNAL_VERSION
            || !Number.isInteger(entry.sequence) || entry.sequence !== this.sequence + 1
            || !validId(entry.transactionId)
            || !Number.isFinite(entry.timestamp) || entry.timestamp < 0
            || !['prepare', 'commit'].includes(entry.phase)) {
          throw new Error('RUN_JOURNAL_STORE_INVALID')
        }
        this.sequence = entry.sequence
        if (entry.phase === 'prepare') {
          if (entry.change && Array.isArray(entry.change.upserts)) {
            entry.change.upserts = entry.change.upserts.map(run => (
              this.legacyRunIds.has(run?.runId) ? recoverLegacyRecord(run) : run
            ))
          }
          if (!validChange(entry.change) || this.pending.has(entry.transactionId)
              || committed.has(entry.transactionId)) {
            throw new Error('RUN_JOURNAL_STORE_INVALID')
          }
          this.pending.set(entry.transactionId, clone(entry.change))
          continue
        }
        const change = this.pending.get(entry.transactionId)
        if (!change || committed.has(entry.transactionId)) {
          throw new Error('RUN_JOURNAL_STORE_INVALID')
        }
        this.apply(change)
        this.pending.delete(entry.transactionId)
        committed.add(entry.transactionId)
      }
    } catch (error) {
      this.loadError = error instanceof Error ? error : new Error(String(error))
      this.runs.clear()
      this.pending.clear()
      this.hasBaseline = false
    }
  }

  assertLoaded() {
    if (this.loadError) throw new Error('RUN_JOURNAL_LOAD_FAILED')
  }

  apply(change) {
    if (change.replace) {
      this.runs.clear()
      this.hasBaseline = true
    }
    for (const runId of change.removedRunIds) this.runs.delete(runId)
    for (const patch of change.upserts) {
      this.runs.set(patch.runId, mergeRun(this.runs.get(patch.runId), patch))
    }
  }

  append(entry) {
    this.assertLoaded()
    const directory = path.dirname(this.storagePath)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    let originalSize = 0
    if (fs.existsSync(this.storagePath)) {
      const stat = fs.lstatSync(this.storagePath)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('RUN_JOURNAL_WRITE_FAILED')
      originalSize = stat.size
    }
    const next = {
      version: JOURNAL_VERSION,
      sequence: this.sequence + 1,
      ...entry,
    }
    let descriptor
    try {
      descriptor = fs.openSync(this.storagePath, 'a', 0o600)
      fs.writeFileSync(descriptor, `${JSON.stringify(next)}\n`, 'utf8')
      fs.fsyncSync(descriptor)
      fs.closeSync(descriptor)
      descriptor = undefined
      fs.chmodSync(this.storagePath, 0o600)
      this.sequence = next.sequence
      return next.sequence
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor) } catch { /* already closed */ }
      }
      try { fs.truncateSync(this.storagePath, originalSize) } catch { /* append did not create a file */ }
      throw error
    }
  }

  prepare(change, timestamp) {
    this.assertLoaded()
    if (!validChange(change)) throw new Error('RUN_JOURNAL_CHANGE_INVALID')
    const transactionId = `txn-${timestamp}-${crypto.randomBytes(8).toString('hex')}`
    this.append({
      transactionId,
      timestamp,
      phase: 'prepare',
      change,
    })
    this.pending.set(transactionId, clone(change))
    return transactionId
  }

  commit(transactionId, timestamp) {
    this.assertLoaded()
    const change = this.pending.get(transactionId)
    if (!change) throw new Error('RUN_JOURNAL_TRANSACTION_INVALID')
    this.append({ transactionId, timestamp, phase: 'commit' })
    this.apply(change)
    this.pending.delete(transactionId)
  }

  ensureBaseline(runs, timestamp) {
    this.assertLoaded()
    if (this.hasBaseline) return
    const transactionId = this.prepare({
      replace: true,
      upserts: clone(runs),
      removedRunIds: [],
    }, timestamp)
    this.commit(transactionId, timestamp)
  }

  compact(runs, timestamp) {
    this.assertLoaded()
    const change = {
      replace: true,
      upserts: clone(runs),
      removedRunIds: [],
    }
    if (!validChange(change)) throw new Error('RUN_JOURNAL_CHANGE_INVALID')
    const transactionId = `txn-${timestamp}-${crypto.randomBytes(8).toString('hex')}`
    const entries = [
      {
        version: JOURNAL_VERSION,
        sequence: 1,
        transactionId,
        timestamp,
        phase: 'prepare',
        change,
      },
      {
        version: JOURNAL_VERSION,
        sequence: 2,
        transactionId,
        timestamp,
        phase: 'commit',
      },
    ]
    try {
      atomicWritePrivateFile(
        this.storagePath,
        `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`,
      )
    } catch (error) {
      // The rename may already have succeeded even when the parent sync failed.
      // Do not append using the old sequence until the journal is reloaded.
      this.loadError = error
      throw error
    }
    this.sequence = 2
    this.runs.clear()
    this.pending.clear()
    this.hasBaseline = false
    this.apply(change)
  }

  compactIfNeeded(runs, timestamp) {
    this.assertLoaded()
    try {
      if (!fs.existsSync(this.storagePath) || fs.statSync(this.storagePath).size < this.compactionBytes) {
        return false
      }
      this.compact(runs, timestamp)
      return true
    } catch {
      return false
    }
  }

  recover() {
    this.assertLoaded()
    return this.hasBaseline ? clone([...this.runs.values()]) : null
  }
}

module.exports = { RunJournal }

const { parseOrchestrationV4 } = require('../collaboration/orchestration-v4-records.cjs')
const { parseTaskDecision } = require('../collaboration/task-decision.cjs')

// Older discussion runs admitted multiple writers. Never resume that policy.
function isLegacyMultiWriter(record) {
  const value = record?.orchestration
  if (value?.version !== 4 || value.workflow !== 'auto' || value.template !== 'discussion'
      || !Array.isArray(value.slots)
      || value.slots.filter(slot => slot?.permission === 'workspace-write').length < 2) return false
  try { parseOrchestrationV4(value); return false } catch (error) {
    return error?.message === 'ORCHESTRATION_V4_PERMISSION_INVALID'
  }
}

function recoverLegacyRecord(record) {
  const result = structuredClone(record)
  result.orchestration = null
  result.continuation = null
  if (['preparing', 'queued', 'running', 'waiting', 'reconciling'].includes(result.status)) {
    result.status = 'interrupted'
    result.reason = 'Legacy discussion requires a new run.'
  }
  for (const agent of result.agentRuns || []) {
    const decision = agent?.context?.taskDecision
    if (!decision) continue
    try { parseTaskDecision(decision) } catch {
      if (Object.keys(decision).sort().join(',') !== 'deliverables,reason,reviewedVersion,status'
          || typeof decision.status !== 'string' || typeof decision.reason !== 'string'
          || typeof decision.reviewedVersion !== 'string' || !Array.isArray(decision.deliverables)) throw new Error('RUN_LEDGER_STORE_INVALID')
      delete agent.context.taskDecision
    }
  }
  return result
}

module.exports = { isLegacyMultiWriter, recoverLegacyRecord }

const crypto = require('node:crypto')
const { parseTaskDecision } = require('./task-decision.cjs')

const { normalizeContentBlobRef } = require('../attachments/content-blob-store.cjs')
const { canonicalJson } = require('./context-pack-records.cjs')
const { redactSecrets } = require('../security/secret-redaction.cjs')

const ORCHESTRATION_V4_VERSION = 4
const V4_TEMPLATES = new Set(['concurrent-batch', 'discussion'])
const V4_WORKFLOWS = new Set(['manual', 'auto', 'concurrent-batch', 'discussion'])
const V4_PHASES = new Set([
  'prepare', 'dispatch', 'running', 'reconcile',
  'proposal', 'discussion', 'challenge', 'coordination', 'work', 'synthesis', 'verification',
  'commit', 'committed', 'completed', 'failed', 'stopped', 'human-gate',
])
const V4_SLOT_STATUSES = new Set([
  'planned', 'queued', 'running', 'waiting',
  'completed', 'partial', 'failed', 'stopped', 'timeout', 'interrupted',
  'prepared', 'settled', 'cancelled', 'unknown_outcome',
])
const V4_COMMIT_STATUSES = new Set(['pending', 'committing', 'committed', 'partial', 'failed'])
const V4_CANDIDATE_COMMIT_STATUSES = new Set([
  'intent', 'message-committed', 'sinks-committed', 'completed',
])
const V4_CANDIDATE_SINK_STATUSES = new Set(['pending', 'committed'])
const V4_SYNTHESIS_ATTEMPT_STATUSES = new Set([
  'intent', 'leased', 'failed', 'unknown_outcome', 'completed', 'cancelled', 'superseded',
])
const V4_OUTCOME_CERTAINTIES = new Set([
  'not_started', 'known_failed', 'unknown_outcome', 'succeeded', 'cancelled',
])
const V4_RECEIPT_STATUSES = new Set([
  'queued', 'running', 'completed', 'partial', 'failed', 'stopped', 'timeout', 'interrupted',
  'accepted', 'continue', 'needs-review', 'rejected',
])
const V4_CONTROL_KINDS = new Set(V4_PHASES)
const V4_POST_SYNTHESIS_PHASES = new Set([
  'synthesis', 'verification', 'human-gate', 'commit', 'committed', 'completed',
])
const V4_COMPLETED_CHALLENGE_STATUSES = new Set([
  'completed', 'accepted', 'continue', 'needs-review', 'rejected',
])

const MAX_V4_SLOTS = 32
const MAX_V4_ASSIGNMENTS = 64
const MAX_V4_WATERMARKS = 256
const MAX_V4_DELIVERY_STATE = 256
const MAX_V4_REFS = 64
const MAX_V4_SUMMARY_CHARS = 800
const MAX_V4_TOTAL_CHARS = 6000
const MAX_V4_UNRESOLVED = 32
const MAX_V4_TEXT_CHARS = 2000
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const ARTIFACT_ID = /^artifact-[a-f0-9]{64}$/u
const WORK_RECEIPT_ID = /^work-receipt-[a-f0-9]{64}$/u
const ISSUE_ID = /^issue-[a-f0-9]{64}$/u
const BLACKBOARD_ENTRY_ID = /^blackboard-entry-[a-f0-9]{64}$/u
const CANDIDATE_COMMIT_ID = /^candidate-commit-[a-f0-9]{64}$/u
const MESSAGE_ID = /^message-[a-f0-9]{64}$/u
const EVIDENCE_ID = /^evidence-[a-f0-9]{64}$/u

const ORCHESTRATION_FIELDS = new Set([
  'version', 'workflow', 'template', 'phase', 'discussionStyle', 'discussionWriterKind', 'batchId', 'round',
  'currentKind', 'currentKinds', 'pendingKinds', 'activeKinds',
  'successfulKinds', 'agreementKinds', 'attachmentRecipients',
  'totalSuccesses', 'terminalFailureOccurred', 'collaboration', 'taskGraph',
  'snapshotHash', 'snapshot', 'plan', 'slots', 'deliveryWatermarks', 'deliveryState', 'commitState',
  'candidateCommit',
  'challengeBindings', 'synthesisBinding', 'synthesisRecovery', 'convergence',
  'coordinationPlan', 'workReceipts',
])

function protocolError(code) {
  return Object.assign(new Error(code), { code })
}

function fail(code) {
  throw protocolError(code)
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function exactFields(value, fields) {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const ownKeys = Reflect.ownKeys(value)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return ownKeys.every(key => typeof key === 'string'
    && fields.includes(key)
    && descriptors[key].enumerable
    && typeof descriptors[key].get !== 'function'
    && typeof descriptors[key].set !== 'function')
}

function boundedInteger(value, fallback = 0, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= max ? value : fallback
}

function cleanId(value) {
  return typeof value === 'string' && PUBLIC_ID.test(value) ? value : ''
}

function cleanText(value, limit = MAX_V4_TEXT_CHARS) {
  if (typeof value !== 'string') return ''
  const text = redactSecrets(value)
    .replace(/\bfile:\/\/\/[^\s"'`<>]+/giu, '[path]')
    .replace(/(^|[\s("'`])\/(?!\/)[^\s"'`<>)]*/gmu, '$1[path]')
    .replace(/\b[A-Za-z]:\\(?:[^\s"'`<>]+\\)*[^\s"'`<>]*/gu, '[path]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .trim()
  return text.length <= limit ? text : text.slice(0, limit)
}

function safeText(value, limit = MAX_V4_TEXT_CHARS, required = false) {
  const raw = typeof value === 'string' ? redactSecrets(value) : String(value ?? '')
  const text = cleanText(value, limit)
  if (raw.length > limit) fail('ORCHESTRATION_V4_TEXT_INVALID')
  if (required && !text) fail('ORCHESTRATION_V4_TEXT_INVALID')
  if (redactSecrets(String(value ?? '')) !== String(value ?? '')
      || (typeof value === 'string' && /[\u0000-\u001f\u007f]/u.test(value))) {
    fail('ORCHESTRATION_V4_TEXT_INVALID')
  }
  return text
}

function uniqueIds(value, max = MAX_V4_SLOTS, required = false) {
  if (!Array.isArray(value) || value.length > max
      || (required && value.length === 0)
      || value.some(item => !cleanId(item))
      || new Set(value).size !== value.length) {
    fail('ORCHESTRATION_V4_REFERENCE_INVALID')
  }
  return [...value]
}

function safeTimestamp(value, fallback = 0) {
  if (Number.isSafeInteger(value) && value >= 0) return value
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function hashValue(value) {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

function candidateCommitSinkId(input, sink) {
  const runId = cleanId(input?.runId)
  const taskId = cleanId(input?.taskId)
  const candidateContentHash = String(input?.candidateContentHash || '')
  const prefixes = {
    commit: 'candidate-commit',
    message: 'message',
  }
  if (!runId || !taskId || !SHA256.test(candidateContentHash) || !prefixes[sink]) {
    fail('ORCHESTRATION_V4_CANDIDATE_COMMIT_INVALID')
  }
  return `${prefixes[sink]}-${hashValue({ candidateContentHash, runId, sink, taskId })}`
}

function candidateCommitBlackboardStatement(input) {
  const candidateArtifactId = String(input?.candidateArtifactId || '')
  const candidateContentHash = String(input?.candidateContentHash || '')
  if (!ARTIFACT_ID.test(candidateArtifactId) || !SHA256.test(candidateContentHash)) {
    fail('ORCHESTRATION_V4_CANDIDATE_COMMIT_INVALID')
  }
  return `Accepted candidate Artifact ${candidateArtifactId} (sha256:${candidateContentHash}).`
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function normalizeWorkflow(input, template) {
  const workflow = typeof input === 'string' ? input : ''
  if (workflow && !V4_WORKFLOWS.has(workflow)) fail('ORCHESTRATION_V4_WORKFLOW_INVALID')
  if (template && !V4_TEMPLATES.has(template)) fail('ORCHESTRATION_V4_TEMPLATE_INVALID')
  if (workflow === 'concurrent-batch' || workflow === 'discussion') {
    if (template && template !== workflow) fail('ORCHESTRATION_V4_TEMPLATE_MISMATCH')
    return { workflow, template: workflow }
  }
  const resolvedTemplate = template || (workflow === 'auto' ? 'discussion' : 'concurrent-batch')
  const resolvedWorkflow = workflow || (resolvedTemplate === 'discussion' ? 'auto' : 'manual')
  if (!V4_TEMPLATES.has(resolvedTemplate) || !V4_WORKFLOWS.has(resolvedWorkflow)) {
    fail('ORCHESTRATION_V4_WORKFLOW_INVALID')
  }
  return { workflow: resolvedWorkflow, template: resolvedTemplate }
}

function phaseForTemplate(template, phase) {
  if (!V4_PHASES.has(phase)) fail('ORCHESTRATION_V4_PHASE_INVALID')
  if (template === 'concurrent-batch'
      && ['challenge', 'synthesis', 'verification'].includes(phase)) {
    fail('ORCHESTRATION_V4_PHASE_INVALID')
  }
  if (template === 'discussion'
      && ['dispatch', 'reconcile'].includes(phase)) {
    fail('ORCHESTRATION_V4_PHASE_INVALID')
  }
  return phase
}

function normalizeSnapshot(input, snapshotHash) {
  if (input == null) return null
  if (!isRecord(input) || !exactFields(input, [
    'contextPackId', 'taskId', 'messageId', 'groupId', 'round', 'targetKinds', 'sourceIds',
    'capturedAt', 'charCount', 'contentHash', 'bodyHash', 'contentRef',
  ])) fail('ORCHESTRATION_V4_SNAPSHOT_INVALID')
  let contentRef = null
  if (input.contentRef != null) {
    try { contentRef = normalizeContentBlobRef(input.contentRef) } catch {
      fail('ORCHESTRATION_V4_SNAPSHOT_INVALID')
    }
  }
  const snapshot = {
    contextPackId: input.contextPackId == null ? null : cleanId(input.contextPackId),
    taskId: input.taskId == null ? null : cleanId(input.taskId),
    ...(hasOwn(input, 'messageId') ? { messageId: cleanId(input.messageId) } : {}),
    ...(hasOwn(input, 'groupId') ? { groupId: cleanId(input.groupId) } : {}),
    round: boundedInteger(input.round, 0, 100000),
    targetKinds: uniqueIds(input.targetKinds || [], MAX_V4_SLOTS),
    sourceIds: uniqueIds(input.sourceIds || [], MAX_V4_REFS),
    capturedAt: safeTimestamp(input.capturedAt, 0),
    charCount: boundedInteger(input.charCount, 0, 10000000),
    contentHash: typeof input.contentHash === 'string' ? input.contentHash : '',
    ...(hasOwn(input, 'bodyHash') ? { bodyHash: String(input.bodyHash || '') } : {}),
    ...(contentRef ? { contentRef } : {}),
  }
  if ((input.contextPackId != null && !snapshot.contextPackId)
      || (input.taskId != null && !snapshot.taskId)
      || (hasOwn(input, 'messageId') && !snapshot.messageId)
      || (hasOwn(input, 'groupId') && !snapshot.groupId)
      || !SHA256.test(snapshot.contentHash)
      || (hasOwn(input, 'bodyHash') && !SHA256.test(snapshot.bodyHash))
      || (contentRef && contentRef.hash !== snapshot.contentHash)) {
    fail('ORCHESTRATION_V4_SNAPSHOT_INVALID')
  }
  if (snapshotHash && snapshotHash !== hashValue(snapshot)) {
    fail('ORCHESTRATION_V4_SNAPSHOT_HASH_MISMATCH')
  }
  return snapshot
}

function normalizeAssignment(input, targetKinds, index) {
  if (!isRecord(input) || !exactFields(input, [
    'agentKind', 'slotId', 'role', 'operationId', 'objective',
    'expectedOutput', 'inputRefs', 'readOnly',
  ])) fail('ORCHESTRATION_V4_PLAN_INVALID')
  const agentKind = cleanId(input.agentKind)
  const slotId = cleanId(input.slotId)
  const operationId = cleanId(input.operationId)
  if (!agentKind || !targetKinds.includes(agentKind) || !slotId || !operationId) {
    fail('ORCHESTRATION_V4_PLAN_INVALID')
  }
  const role = typeof input.role === 'string' && [
    'primary', 'reviewer', 'arbiter', 'worker', 'integrator',
    'synthesizer', 'verifier', 'writer', 'participant',
  ].includes(input.role)
    ? input.role
    : ''
  if (!role) fail('ORCHESTRATION_V4_PLAN_INVALID')
  return {
    agentKind,
    slotId,
    role,
    operationId,
    objective: safeText(input.objective, MAX_V4_TEXT_CHARS, true),
    expectedOutput: safeText(input.expectedOutput, MAX_V4_TEXT_CHARS, true),
    inputRefs: uniqueIds(input.inputRefs || [], MAX_V4_REFS),
    readOnly: input.readOnly === true,
    index,
  }
}

function normalizeCoordinationAssignment(input, targetKinds, index) {
  if (!isRecord(input) || !exactFields(input, [
    'taskId', 'ownerKind', 'role', 'objective', 'expectedOutput',
    'inputRefs', 'artifactIds', 'dependsOn',
  ])) fail('ORCHESTRATION_V4_COORDINATION_PLAN_INVALID')
  const taskId = cleanId(input.taskId)
  const ownerKind = cleanId(input.ownerKind)
  const role = typeof input.role === 'string' && ['worker', 'integrator', 'verifier'].includes(input.role)
    ? input.role : ''
  if (!taskId || !ownerKind || !targetKinds.includes(ownerKind) || !role) {
    fail('ORCHESTRATION_V4_COORDINATION_PLAN_INVALID')
  }
  return {
    taskId,
    ownerKind,
    role,
    objective: safeText(input.objective, MAX_V4_TEXT_CHARS, true),
    expectedOutput: safeText(input.expectedOutput, MAX_V4_TEXT_CHARS, true),
    inputRefs: uniqueIds(input.inputRefs || [], MAX_V4_REFS).sort(),
    artifactIds: uniqueIds(input.artifactIds || [], MAX_V4_REFS).sort(),
    dependsOn: uniqueIds(input.dependsOn || [], MAX_V4_ASSIGNMENTS).sort(),
    index,
  }
}

function coordinationPlanCycle(assignments) {
  const dependencies = new Map(assignments.map(assignment => [
    assignment.taskId, assignment.dependsOn,
  ]))
  const visiting = new Set()
  const visited = new Set()
  const visit = (taskId) => {
    if (visiting.has(taskId)) return true
    if (visited.has(taskId)) return false
    visiting.add(taskId)
    for (const dependency of dependencies.get(taskId) || []) {
      if (visit(dependency)) return true
    }
    visiting.delete(taskId)
    visited.add(taskId)
    return false
  }
  return assignments.some(assignment => visit(assignment.taskId))
}

function createCoordinationPlan(input = {}) {
  const snapshotHash = String(input.snapshotHash || '')
  const targetKinds = uniqueIds(input.targetKinds || [], MAX_V4_SLOTS, true).sort()
  if (!SHA256.test(snapshotHash) || targetKinds.length < 2
      || !Array.isArray(input.assignments)
      || input.assignments.length < 1
      || input.assignments.length > MAX_V4_ASSIGNMENTS) {
    fail('ORCHESTRATION_V4_COORDINATION_PLAN_INVALID')
  }
  const assignments = input.assignments.map((assignment, index) => (
    normalizeCoordinationAssignment(assignment, targetKinds, index)
  )).sort((left, right) => left.taskId.localeCompare(right.taskId))
  const taskIds = assignments.map(assignment => assignment.taskId)
  const ownerKinds = assignments.map(assignment => assignment.ownerKind)
  if (new Set(taskIds).size !== taskIds.length
      || targetKinds.some(kind => !ownerKinds.includes(kind))
      || assignments.some(assignment => assignment.dependsOn.some(taskId => (
        taskId === assignment.taskId || !taskIds.includes(taskId)
      )))
      || coordinationPlanCycle(assignments)) {
    fail('ORCHESTRATION_V4_COORDINATION_PLAN_INVALID')
  }
  const finalizerKind = cleanId(input.finalizerKind)
  const verifierKinds = uniqueIds(
    input.verifierKinds || [], MAX_V4_SLOTS, true,
  ).sort()
  const agreedBy = uniqueIds(input.agreedBy || [], MAX_V4_SLOTS, true).sort()
  const supportReceiptIds = input.supportReceiptIds == null
    ? null
    : uniqueIds(input.supportReceiptIds, MAX_V4_SLOTS, true).sort()
  const requiredVerifierCount = targetKinds.length - 1
  if (!finalizerKind || !targetKinds.includes(finalizerKind)
      || verifierKinds.length !== requiredVerifierCount
      || verifierKinds.some(kind => !targetKinds.includes(kind) || kind === finalizerKind)
      || agreedBy.length !== targetKinds.length
      || targetKinds.some(kind => !agreedBy.includes(kind))
      || (supportReceiptIds && supportReceiptIds.length !== targetKinds.length)
      || !assignments.some(assignment => (
        assignment.ownerKind === finalizerKind && assignment.role === 'integrator'
      ))) {
    fail('ORCHESTRATION_V4_COORDINATION_PLAN_INVALID')
  }
  const graph = {
    version: 1,
    snapshotHash,
    assignments: assignments.map(({ index: _index, ...assignment }) => assignment),
    finalizerKind,
    verifierKinds,
  }
  return {
    ...graph,
    agreedBy,
    ...(supportReceiptIds ? { supportReceiptIds } : {}),
    planHash: hashValue(graph),
  }
}

function normalizeCoordinationPlan(input, targetKinds, snapshotHash) {
  if (!isRecord(input) || !exactFields(input, [
    'version', 'snapshotHash', 'assignments', 'finalizerKind', 'verifierKinds',
    'agreedBy', 'supportReceiptIds', 'planHash',
  ]) || input.version !== 1 || input.snapshotHash !== snapshotHash) {
    fail('ORCHESTRATION_V4_COORDINATION_PLAN_INVALID')
  }
  const normalized = createCoordinationPlan({
    ...input,
    targetKinds,
  })
  if (input.planHash !== normalized.planHash) {
    fail('ORCHESTRATION_V4_COORDINATION_PLAN_INVALID')
  }
  return normalized
}

function validateCoordinationAgreement(
  coordinationPlan, slots, challengeBindings, targetKinds, snapshotHash,
) {
  if (!coordinationPlan?.supportReceiptIds) return
  const boundReceiptIds = new Set(coordinationPlan.supportReceiptIds)
  const bindingsByKind = new Map((challengeBindings || []).map(binding => (
    [binding.reviewerKind, binding]
  )))
  const matchedReceiptIds = new Set()
  for (const agentKind of targetKinds) {
    const slot = slots.find(candidate => candidate.agentKind === agentKind)
    let latest = null
    for (const item of slot?.resultRefs?.workflowOutcomeRefs || []) {
      let receipt
      try { receipt = parseCollaborationControlBlock(item?.receipt) } catch { continue }
      if (receipt?.phase !== 'challenge' || receipt.agentKind !== agentKind
          || receipt.snapshotHash !== snapshotHash
          || (latest && receipt.deliveryWatermark < latest.receipt.deliveryWatermark)) {
        continue
      }
      latest = { item, receipt }
    }
    const binding = bindingsByKind.get(agentKind)
    let candidate = null
    try {
      candidate = coordinationCandidateFromReceipt(latest?.receipt, { targetKinds, snapshotHash })
    } catch { /* invalid candidates cannot support a persisted plan */ }
    const supportedPlanHash = latest?.receipt?.agreeToPlan === true
      ? String(latest.receipt.supportedPlanHash || candidate?.planHash || '')
      : ''
    if (!latest || latest.item.verdict !== 'support'
        || supportedPlanHash !== coordinationPlan.planHash
        || !boundReceiptIds.has(latest.receipt.receiptId)
        || (binding && latest.receipt.operationId !== binding.reviewerOperationId)) {
      fail('ORCHESTRATION_V4_COORDINATION_PLAN_INVALID')
    }
    matchedReceiptIds.add(latest.receipt.receiptId)
  }
  if (matchedReceiptIds.size !== boundReceiptIds.size) {
    fail('ORCHESTRATION_V4_COORDINATION_PLAN_INVALID')
  }
}

function coordinationRecoveryKinds(coordinationPlan) {
  if (!isRecord(coordinationPlan)
      || !Array.isArray(coordinationPlan.assignments)
      || !Array.isArray(coordinationPlan.verifierKinds)) {
    fail('ORCHESTRATION_V4_SYNTHESIS_RECOVERY_INVALID')
  }
  const verifierKinds = coordinationPlan.verifierKinds
  const nonVerifierOwners = coordinationPlan.assignments
    .map(assignment => assignment.ownerKind)
    .filter(kind => (
      kind !== coordinationPlan.finalizerKind && !verifierKinds.includes(kind)
    ))
  return [...new Set([
    coordinationPlan.finalizerKind,
    ...nonVerifierOwners,
    ...verifierKinds,
  ])].filter(kind => (
    kind === coordinationPlan.finalizerKind
      || verifierKinds.some(verifierKind => verifierKind !== kind)
  ))
}

function normalizeWorkArtifact(input) {
  if (!isRecord(input) || !exactFields(input, [
    'artifactId', 'contentHash', 'contentRef',
  ])) fail('ORCHESTRATION_V4_WORK_RECEIPT_INVALID')
  const artifactId = String(input.artifactId || '')
  const contentHash = String(input.contentHash || '')
  let contentRef
  try { contentRef = normalizeContentBlobRef(input.contentRef) } catch {
    fail('ORCHESTRATION_V4_WORK_RECEIPT_INVALID')
  }
  if (!ARTIFACT_ID.test(artifactId) || !SHA256.test(contentHash)
      || contentRef.hash !== contentHash) {
    fail('ORCHESTRATION_V4_WORK_RECEIPT_INVALID')
  }
  return { artifactId, contentHash, contentRef }
}

function createWorkReceipt(input = {}) {
  const snapshotHash = String(input.snapshotHash || '')
  const snapshotBodyHash = String(input.snapshotBodyHash || '')
  let snapshotContentRef
  try { snapshotContentRef = normalizeContentBlobRef(input.snapshotContentRef) } catch {
    fail('ORCHESTRATION_V4_WORK_RECEIPT_INVALID')
  }
  const planHash = String(input.planHash || '')
  const taskId = cleanId(input.taskId)
  const ownerKind = cleanId(input.ownerKind)
  const slotId = cleanId(input.slotId)
  const operationId = cleanId(input.operationId)
  let collaborationReceipt
  try { collaborationReceipt = parseCollaborationControlBlock(input.collaborationReceipt) } catch {
    fail('ORCHESTRATION_V4_WORK_RECEIPT_INVALID')
  }
  if (!SHA256.test(snapshotHash) || !SHA256.test(snapshotBodyHash)
      || !SHA256.test(planHash) || !taskId || !ownerKind || !slotId || !operationId
      || collaborationReceipt.phase !== 'work'
      || !['completed', 'accepted'].includes(collaborationReceipt.status)
      || collaborationReceipt.workItemId !== taskId
      || collaborationReceipt.agentKind !== ownerKind
      || collaborationReceipt.slotId !== slotId
      || collaborationReceipt.operationId !== operationId
      || collaborationReceipt.snapshotHash !== snapshotHash) {
    fail('ORCHESTRATION_V4_WORK_RECEIPT_INVALID')
  }
  if (!Array.isArray(input.artifacts) || input.artifacts.length < 1
      || input.artifacts.length > MAX_V4_REFS) {
    fail('ORCHESTRATION_V4_WORK_RECEIPT_INVALID')
  }
  const artifacts = input.artifacts.map(normalizeWorkArtifact)
  if (new Set(artifacts.map(artifact => artifact.artifactId)).size !== artifacts.length
      || canonicalJson(artifacts.map(artifact => artifact.artifactId))
        !== canonicalJson(collaborationReceipt.artifactIds)) {
    fail('ORCHESTRATION_V4_WORK_RECEIPT_INVALID')
  }
  const resultHash = hashValue({ collaborationReceipt, artifacts })
  const body = {
    version: 1,
    snapshotHash,
    snapshotBodyHash,
    snapshotContentRef,
    planHash,
    taskId,
    ownerKind,
    slotId,
    operationId,
    collaborationReceipt,
    resultHash,
    artifacts,
  }
  return {
    ...body,
    workReceiptId: `work-receipt-${hashValue(body)}`,
  }
}

function normalizeWorkReceipt(input) {
  if (!isRecord(input) || !exactFields(input, [
    'version', 'workReceiptId', 'snapshotHash', 'snapshotBodyHash',
    'snapshotContentRef', 'planHash', 'taskId', 'ownerKind', 'slotId',
    'operationId', 'collaborationReceipt', 'resultHash', 'artifacts',
  ]) || input.version !== 1 || !WORK_RECEIPT_ID.test(String(input.workReceiptId || ''))) {
    fail('ORCHESTRATION_V4_WORK_RECEIPT_INVALID')
  }
  const normalized = createWorkReceipt(input)
  if (input.workReceiptId !== normalized.workReceiptId
      || input.resultHash !== normalized.resultHash) {
    fail('ORCHESTRATION_V4_WORK_RECEIPT_INVALID')
  }
  return normalized
}

function appendWorkReceipt(receiptsInput, receiptInput) {
  if (!Array.isArray(receiptsInput) || receiptsInput.length > MAX_V4_ASSIGNMENTS) {
    fail('ORCHESTRATION_V4_WORK_RECEIPT_INVALID')
  }
  const receipts = receiptsInput.map(normalizeWorkReceipt)
  const receipt = normalizeWorkReceipt(receiptInput)
  const existing = receipts.find(candidate => (
    candidate.operationId === receipt.operationId
      || candidate.taskId === receipt.taskId
      || candidate.workReceiptId === receipt.workReceiptId
  ))
  if (!existing) return [...receipts, receipt]
  if (canonicalJson(existing) !== canonicalJson(receipt)) {
    fail('ORCHESTRATION_V4_WORK_RECEIPT_CONFLICT')
  }
  return receipts
}

function coordinationCandidateFromReceipt(receipt, input) {
  const hasAssignments = Array.isArray(receipt?.proposedAssignments)
  const hasFinalizer = typeof receipt?.finalizerKind === 'string' && receipt.finalizerKind
  const hasVerifiers = Array.isArray(receipt?.verifierKinds)
  if (!hasAssignments && !hasFinalizer && !hasVerifiers) return null
  if (!hasAssignments || !hasFinalizer || !hasVerifiers) {
    fail('ORCHESTRATION_V4_COORDINATION_PLAN_INVALID')
  }
  return createCoordinationPlan({
    snapshotHash: input.snapshotHash,
    targetKinds: input.targetKinds,
    assignments: receipt.proposedAssignments,
    finalizerKind: receipt.finalizerKind,
    verifierKinds: receipt.verifierKinds,
    agreedBy: input.targetKinds,
  })
}

function resolveCoordinationConsensus(input = {}) {
  const snapshotHash = String(input.snapshotHash || '')
  const targetKinds = uniqueIds(input.targetKinds || [], MAX_V4_SLOTS, true).sort()
  const candidateReceipts = Array.isArray(input.candidateReceipts) ? input.candidateReceipts : []
  const supportReceipts = Array.isArray(input.supportReceipts) ? input.supportReceipts : []
  if (!SHA256.test(snapshotHash) || targetKinds.length < 2
      || candidateReceipts.length > MAX_V4_SLOTS * 8
      || ![0, targetKinds.length].includes(supportReceipts.length)) {
    fail('ORCHESTRATION_V4_COORDINATION_PLAN_INVALID')
  }
  const candidatesByHash = new Map()
  for (const value of candidateReceipts) {
    const receipt = isRecord(value?.receipt) ? value.receipt : value
    let candidate = null
    try {
      candidate = coordinationCandidateFromReceipt(receipt, { targetKinds, snapshotHash })
    } catch (error) {
      if (error?.code !== 'ORCHESTRATION_V4_COORDINATION_PLAN_INVALID') throw error
    }
    if (candidate) candidatesByHash.set(candidate.planHash, candidate)
  }
  const supportsByKind = new Map()
  const supportReceiptIdsByKind = new Map()
  for (const value of supportReceipts) {
    const receipt = isRecord(value?.receipt) ? value.receipt : value
    const verdict = String(isRecord(value?.receipt) ? value.verdict || '' : value?.verdict || '')
    const agentKind = cleanId(receipt?.agentKind)
    if (!agentKind || !targetKinds.includes(agentKind) || supportsByKind.has(agentKind)
        || receipt?.phase !== 'challenge'
        || !['support', 'contradict'].includes(verdict)) {
      fail('ORCHESTRATION_V4_COORDINATION_PLAN_INVALID')
    }
    let candidate = null
    try {
      candidate = coordinationCandidateFromReceipt(receipt, { targetKinds, snapshotHash })
    } catch (error) {
      if (error?.code !== 'ORCHESTRATION_V4_COORDINATION_PLAN_INVALID') throw error
    }
    if (candidate) candidatesByHash.set(candidate.planHash, candidate)
    const supportedPlanHash = verdict === 'support' && receipt?.agreeToPlan === true
      ? String(receipt.supportedPlanHash || candidate?.planHash || '')
      : ''
    if (supportedPlanHash && (!SHA256.test(supportedPlanHash)
        || !candidatesByHash.has(supportedPlanHash)
        || (candidate && candidate.planHash !== supportedPlanHash))) {
      fail('ORCHESTRATION_V4_COORDINATION_PLAN_INVALID')
    }
    supportsByKind.set(agentKind, supportedPlanHash)
    const receiptId = cleanId(receipt?.receiptId)
    if (supportedPlanHash && receiptId?.startsWith('receipt-')) {
      supportReceiptIdsByKind.set(agentKind, receiptId)
    }
  }
  const supportPlanHashes = supportReceipts.length
    ? targetKinds.map(kind => supportsByKind.get(kind) || '')
    : []
  const unanimousHash = supportPlanHashes[0]
    && supportPlanHashes.every(planHash => planHash === supportPlanHashes[0])
    ? supportPlanHashes[0]
    : ''
  const candidate = unanimousHash ? candidatesByHash.get(unanimousHash) : null
  const supportReceiptIds = candidate && supportReceiptIdsByKind.size === targetKinds.length
    ? targetKinds.map(kind => supportReceiptIdsByKind.get(kind)).sort()
    : null
  return {
    plan: candidate && supportReceiptIds
      ? { ...candidate, supportReceiptIds }
      : candidate,
    candidates: [...candidatesByHash.values()].sort((left, right) => (
      left.planHash.localeCompare(right.planHash)
    )),
    supportPlanHashes,
  }
}

function normalizePlan(input, snapshotHash, targetKinds, now) {
  if (input == null) return null
  if (Array.isArray(input)) {
    input = { version: 1, snapshotHash, assignments: input, createdAt: now }
  }
  if (!isRecord(input) || !exactFields(input, [
    'version', 'snapshotHash', 'assignments', 'createdAt', 'barrier',
  ]) || input.version !== 1 || input.snapshotHash !== snapshotHash
      || !Array.isArray(input.assignments) || input.assignments.length < 1
      || input.assignments.length > MAX_V4_ASSIGNMENTS) {
    fail('ORCHESTRATION_V4_PLAN_INVALID')
  }
  const assignments = input.assignments.map((assignment, index) => (
    normalizeAssignment(assignment, targetKinds, index)
  ))
  const slotIds = new Set()
  const operationIds = new Set()
  const kinds = new Set()
  for (const assignment of assignments) {
    if (slotIds.has(assignment.slotId) || operationIds.has(assignment.operationId)
        || kinds.has(assignment.agentKind)) fail('ORCHESTRATION_V4_PLAN_INVALID')
    slotIds.add(assignment.slotId)
    operationIds.add(assignment.operationId)
    kinds.add(assignment.agentKind)
  }
  const barrier = input.barrier == null ? 'batch' : input.barrier
  if (!['batch', 'phase'].includes(barrier)) fail('ORCHESTRATION_V4_PLAN_INVALID')
  return {
    version: 1,
    snapshotHash,
    assignments: assignments.map(({ index, ...assignment }) => assignment),
    createdAt: safeTimestamp(input.createdAt, now),
    barrier,
  }
}

function normalizeSlot(input, targetKinds, topPhase, index, template) {
  if (!isRecord(input) || !exactFields(input, [
    'slotId', 'agentKind', 'phase', 'status', 'operationId', 'agentRunId', 'queuePosition',
    'snapshotHash', 'deliveryWatermark', 'receiptId', 'resultHash',
    'assignedAt', 'startedAt', 'finishedAt', 'commitStatus', 'attempt', 'permission',
    'resultRefs', 'resultBodyArtifactId', 'commitId', 'messageId', 'blackboardEntryId',
  ])) fail('ORCHESTRATION_V4_SLOT_INVALID')
  const slotId = cleanId(input.slotId)
  const agentKind = cleanId(input.agentKind)
  const operationId = cleanId(input.operationId)
  const hasAgentRunId = hasOwn(input, 'agentRunId')
  const agentRunId = cleanId(input.agentRunId)
  const phase = String(input.phase || '')
  const status = String(input.status || '')
  if (!slotId || !agentKind || !targetKinds.includes(agentKind) || !operationId
      || (hasAgentRunId && !agentRunId)
      || !V4_PHASES.has(phase) || !V4_SLOT_STATUSES.has(status)) {
    fail('ORCHESTRATION_V4_SLOT_INVALID')
  }
  if (phase !== topPhase && status === 'running') fail('ORCHESTRATION_V4_SLOT_INVALID')
  const snapshotHash = String(input.snapshotHash || '')
  if (!SHA256.test(snapshotHash)) fail('ORCHESTRATION_V4_SLOT_INVALID')
  const receiptId = input.receiptId == null ? '' : cleanId(input.receiptId)
  const resultHash = input.resultHash == null ? '' : String(input.resultHash)
  const commitStatus = input.commitStatus == null ? 'pending' : String(input.commitStatus)
  if (receiptId && !receiptId.startsWith('receipt-')) fail('ORCHESTRATION_V4_SLOT_INVALID')
  if (resultHash && !SHA256.test(resultHash)) fail('ORCHESTRATION_V4_SLOT_INVALID')
  if (!['pending', 'committing', 'committed', 'partial', 'failed'].includes(commitStatus)) {
    fail('ORCHESTRATION_V4_SLOT_INVALID')
  }
  const attempt = input.attempt == null ? 0 : boundedInteger(input.attempt, 0, 1000000)
  if (hasOwn(input, 'attempt') && input.attempt !== attempt) fail('ORCHESTRATION_V4_SLOT_INVALID')
  const permission = input.permission == null ? '' : String(input.permission)
  if (permission && !['read-only', 'workspace-write'].includes(permission)) {
    fail('ORCHESTRATION_V4_SLOT_INVALID')
  }
  const resultBodyArtifactId = input.resultBodyArtifactId == null
    ? '' : String(input.resultBodyArtifactId)
  const commitId = input.commitId == null ? '' : cleanId(input.commitId)
  const messageId = input.messageId == null ? '' : cleanId(input.messageId)
  const blackboardEntryId = input.blackboardEntryId == null
    ? '' : String(input.blackboardEntryId)
  if ((resultBodyArtifactId && !ARTIFACT_ID.test(resultBodyArtifactId))
      || (input.commitId != null && !commitId)
      || (input.messageId != null && !messageId)
      || (blackboardEntryId && !BLACKBOARD_ENTRY_ID.test(blackboardEntryId))) {
    fail('ORCHESTRATION_V4_SLOT_INVALID')
  }
  if (template === 'concurrent-batch' && (!commitId || !messageId
      || (['completed', 'partial'].includes(status)
        && (!resultBodyArtifactId || !blackboardEntryId)))) {
    fail('ORCHESTRATION_V4_SLOT_INVALID')
  }
  let resultRefs = null
  if (input.resultRefs != null) {
    if (!isRecord(input.resultRefs) || Object.keys(input.resultRefs).some(field => (
      !['artifactIds', 'evidenceIds', 'findingIds', 'reviewerFindingIds', 'adoptionIds', 'workflowOutcomeRefs'].includes(field)
    ))) fail('ORCHESTRATION_V4_SLOT_INVALID')
    resultRefs = {}
    for (const [field, value] of Object.entries(input.resultRefs)) {
      if (!Array.isArray(value) || value.length > MAX_V4_REFS) fail('ORCHESTRATION_V4_SLOT_INVALID')
      if (field === 'workflowOutcomeRefs') {
        if (value.some(item => !isRecord(item))) fail('ORCHESTRATION_V4_SLOT_INVALID')
        const serialized = JSON.stringify(value)
        if (redactSecrets(serialized) !== serialized
            || /(?:^|[\s"'`])\/(?!\/)[^\s"'`<>)]*/u.test(serialized)) {
          fail('ORCHESTRATION_V4_SLOT_INVALID')
        }
        resultRefs[field] = value.map(item => clone(item))
      } else {
        resultRefs[field] = uniqueIds(value, MAX_V4_REFS)
      }
    }
  }
  const queuePosition = boundedInteger(input.queuePosition, index, 1000000)
  const deliveryWatermark = boundedInteger(input.deliveryWatermark, 0, 1000000000)
  const assignedAt = safeTimestamp(input.assignedAt, 0)
  const startedAt = safeTimestamp(input.startedAt, assignedAt)
  const finishedAt = input.finishedAt == null ? null : safeTimestamp(input.finishedAt, startedAt)
  if (finishedAt == null && V4_SLOT_STATUSES.has(status)
      && ['completed', 'partial', 'failed', 'stopped', 'timeout', 'interrupted',
        'settled', 'cancelled', 'unknown_outcome'].includes(status)) {
    fail('ORCHESTRATION_V4_SLOT_INVALID')
  }
  return {
    slotId, agentKind, phase, status, operationId,
    ...(hasAgentRunId ? { agentRunId } : {}),
    queuePosition, snapshotHash,
    deliveryWatermark, receiptId, resultHash, assignedAt, startedAt, finishedAt, commitStatus,
    attempt,
    ...(permission ? { permission } : {}),
    ...(resultRefs ? { resultRefs } : {}),
    ...(resultBodyArtifactId ? { resultBodyArtifactId } : {}),
    ...(commitId ? { commitId } : {}),
    ...(messageId ? { messageId } : {}),
    ...(blackboardEntryId ? { blackboardEntryId } : {}),
  }
}

function normalizeWatermark(input, targetKinds, index) {
  if (!isRecord(input) || !exactFields(input, [
    'agentKind', 'phase', 'watermark', 'operationId', 'snapshotHash', 'updatedAt',
  ])) fail('ORCHESTRATION_V4_WATERMARK_INVALID')
  const agentKind = cleanId(input.agentKind)
  const phase = String(input.phase || '')
  const rawOperationId = input.operationId == null ? '' : input.operationId
  if (rawOperationId !== '' && typeof rawOperationId !== 'string') {
    fail('ORCHESTRATION_V4_WATERMARK_INVALID')
  }
  const operationId = cleanId(rawOperationId)
  const snapshotHash = String(input.snapshotHash || '')
  if (!agentKind || !targetKinds.includes(agentKind) || !V4_PHASES.has(phase)
      || !Number.isSafeInteger(input.watermark) || input.watermark < 0
      || (rawOperationId && !operationId)
      || !SHA256.test(snapshotHash)) fail('ORCHESTRATION_V4_WATERMARK_INVALID')
  return {
    agentKind,
    phase,
    watermark: input.watermark,
    operationId: operationId || '',
    snapshotHash,
    updatedAt: safeTimestamp(input.updatedAt, index),
  }
}

function normalizeDeliveryState(input, targetKinds, index) {
  if (!isRecord(input) || !exactFields(input, [
    'recipientKind', 'sessionRefHash', 'sessionProvenanceHash',
    'sourceAgentKind', 'sourcePhase', 'watermark', 'snapshotHash', 'operationId',
    'packageHash', 'deliveryId', 'status', 'updatedAt', 'sourceMessages',
  ])) fail('ORCHESTRATION_V4_DELIVERY_STATE_INVALID')
  const recipientKind = cleanId(input.recipientKind)
  const sourceAgentKind = cleanId(input.sourceAgentKind)
  const sourcePhase = String(input.sourcePhase || '')
  const sessionRefHash = String(input.sessionRefHash || '')
  const sessionProvenanceHash = String(input.sessionProvenanceHash || '')
  const snapshotHash = String(input.snapshotHash || '')
  const operationId = cleanId(input.operationId)
  const packageHash = String(input.packageHash || '')
  const deliveryId = cleanId(input.deliveryId)
  const status = String(input.status || '')
  let sourceMessages
  if (hasOwn(input, 'sourceMessages')) {
    if (!Array.isArray(input.sourceMessages) || !input.sourceMessages.length
        || input.sourceMessages.length > 100) fail('ORCHESTRATION_V4_DELIVERY_STATE_INVALID')
    sourceMessages = input.sourceMessages.map(message => {
      if (!isRecord(message) || !exactFields(message, ['id', 'hash'])
          || !cleanId(message.id) || cleanId(message.id) !== message.id
          || typeof message.hash !== 'string' || !SHA256.test(message.hash)) fail('ORCHESTRATION_V4_DELIVERY_STATE_INVALID')
      return { id: message.id, hash: message.hash }
    })
    if (new Set(sourceMessages.map(message => message.id)).size !== sourceMessages.length) {
      fail('ORCHESTRATION_V4_DELIVERY_STATE_INVALID')
    }
  }
  if (!recipientKind || !sourceAgentKind || !targetKinds.includes(recipientKind)
      || !targetKinds.includes(sourceAgentKind) || !V4_PHASES.has(sourcePhase)
      || !Number.isSafeInteger(input.watermark) || input.watermark < 0
      || !SHA256.test(sessionRefHash) || !SHA256.test(sessionProvenanceHash)
      || !SHA256.test(snapshotHash) || !operationId || !SHA256.test(packageHash)
      || !deliveryId || !['prepared', 'acknowledged', 'uncertain'].includes(status)) {
    fail('ORCHESTRATION_V4_DELIVERY_STATE_INVALID')
  }
  return {
    recipientKind,
    sessionRefHash,
    sessionProvenanceHash,
    sourceAgentKind,
    sourcePhase,
    watermark: input.watermark,
    snapshotHash,
    operationId,
    packageHash,
    deliveryId,
    status,
    ...(sourceMessages ? { sourceMessages } : {}),
    updatedAt: safeTimestamp(input.updatedAt, index),
  }
}

function normalizeCommitState(input, targetKinds, now) {
  if (!isRecord(input) || !exactFields(input, [
    'status', 'writerKind', 'committedKinds', 'pendingKinds',
    'operationId', 'attempt', 'updatedAt', 'committedSlotIds', 'messageIds',
    'blackboardEntryIds',
  ])) fail('ORCHESTRATION_V4_COMMIT_STATE_INVALID')
  const status = String(input.status || '')
  const writerKind = input.writerKind == null ? null : cleanId(input.writerKind)
  const committedKinds = uniqueIds(input.committedKinds || [], MAX_V4_SLOTS)
  const pendingKinds = uniqueIds(input.pendingKinds || [], MAX_V4_SLOTS)
  const rawOperationId = input.operationId == null ? '' : input.operationId
  if (rawOperationId !== '' && typeof rawOperationId !== 'string') {
    fail('ORCHESTRATION_V4_COMMIT_STATE_INVALID')
  }
  const operationId = cleanId(rawOperationId)
  const committedSlotIds = input.committedSlotIds == null
    ? [] : uniqueIds(input.committedSlotIds, MAX_V4_SLOTS)
  const messageIds = input.messageIds == null ? [] : uniqueIds(input.messageIds, MAX_V4_REFS)
  const blackboardEntryIds = input.blackboardEntryIds == null
    ? [] : uniqueIds(input.blackboardEntryIds, MAX_V4_REFS)
  if (!V4_COMMIT_STATUSES.has(status)
      || (input.writerKind != null && !writerKind)
      || (writerKind && !targetKinds.includes(writerKind))
      || (rawOperationId && !operationId)
      || committedKinds.some(kind => !targetKinds.includes(kind))
      || pendingKinds.some(kind => !targetKinds.includes(kind))
      || committedKinds.some(kind => pendingKinds.includes(kind))) {
    fail('ORCHESTRATION_V4_COMMIT_STATE_INVALID')
  }
  return {
    status,
    writerKind,
    committedKinds,
    pendingKinds,
    operationId: operationId || '',
    attempt: boundedInteger(input.attempt, 0, 1000000),
    updatedAt: safeTimestamp(input.updatedAt, now),
    ...(hasOwn(input, 'committedSlotIds') ? { committedSlotIds } : {}),
    ...(hasOwn(input, 'messageIds') ? { messageIds } : {}),
    ...(hasOwn(input, 'blackboardEntryIds') ? { blackboardEntryIds } : {}),
  }
}

function commitDeliveryObservable(commitState) {
  if (!isRecord(commitState)) return false
  return ['committing', 'committed', 'partial', 'failed'].includes(commitState.status)
    || Boolean(commitState.writerKind)
    || Boolean(commitState.operationId)
    || (Array.isArray(commitState.committedKinds) && commitState.committedKinds.length > 0)
    || (Array.isArray(commitState.committedSlotIds) && commitState.committedSlotIds.length > 0)
    || (Array.isArray(commitState.messageIds) && commitState.messageIds.length > 0)
    || (Array.isArray(commitState.blackboardEntryIds) && commitState.blackboardEntryIds.length > 0)
}

function normalizeCandidateCommit(input, targetKinds, now, round) {
  if (!isRecord(input) || !exactFields(input, [
    'status', 'runId', 'taskId', 'groupId', 'threadRootId',
    'candidateArtifactId', 'candidateContentHash', 'candidateContentRef',
    'evidenceIds', 'writerKind', 'writerRole', 'commitId', 'messageId', 'blackboardEntryId',
    'blackboardSequence', 'blackboardRecordedAt',
    'messageStatus', 'blackboardStatus', 'attempt', 'updatedAt',
  ])) fail('ORCHESTRATION_V4_CANDIDATE_COMMIT_INVALID')
  const status = String(input.status || '')
  const runId = cleanId(input.runId)
  const taskId = cleanId(input.taskId)
  const groupId = cleanId(input.groupId)
  const threadRootId = cleanId(input.threadRootId)
  const candidateArtifactId = String(input.candidateArtifactId || '')
  const candidateContentHash = String(input.candidateContentHash || '')
  const writerKind = cleanId(input.writerKind)
  const writerRole = String(input.writerRole || '')
  const evidenceIds = Array.isArray(input.evidenceIds) ? [...input.evidenceIds] : []
  let candidateContentRef
  try { candidateContentRef = normalizeContentBlobRef(input.candidateContentRef) } catch {
    fail('ORCHESTRATION_V4_CANDIDATE_COMMIT_INVALID')
  }
  const messageStatus = String(input.messageStatus || '')
  const blackboardStatus = String(input.blackboardStatus || '')
  const expectedMessageStatus = status === 'intent' ? 'pending' : 'committed'
  const expectedBlackboardStatus = ['intent', 'message-committed'].includes(status)
    ? 'pending' : 'committed'
  if (!V4_CANDIDATE_COMMIT_STATUSES.has(status)
      || !runId || !taskId || !groupId || !threadRootId
      || !ARTIFACT_ID.test(candidateArtifactId) || !SHA256.test(candidateContentHash)
      || candidateContentRef.hash !== candidateContentHash
      || !evidenceIds.length || evidenceIds.length > MAX_V4_REFS
      || new Set(evidenceIds).size !== evidenceIds.length
      || evidenceIds.some(evidenceId => !EVIDENCE_ID.test(evidenceId))
      || !writerKind || !targetKinds.includes(writerKind)
      || !['primary', 'reviewer', 'arbiter', 'integrator', 'worker', 'verifier']
        .includes(writerRole)
      || !CANDIDATE_COMMIT_ID.test(String(input.commitId || ''))
      || !MESSAGE_ID.test(String(input.messageId || ''))
      || !BLACKBOARD_ENTRY_ID.test(String(input.blackboardEntryId || ''))
      || !V4_CANDIDATE_SINK_STATUSES.has(messageStatus)
      || !V4_CANDIDATE_SINK_STATUSES.has(blackboardStatus)
      || messageStatus !== expectedMessageStatus
      || blackboardStatus !== expectedBlackboardStatus
      || !Number.isSafeInteger(input.attempt) || input.attempt < 1 || input.attempt > 1000000
      || !Number.isSafeInteger(input.blackboardSequence)
      || input.blackboardSequence < 1 || input.blackboardSequence > 1000000
      || !Number.isSafeInteger(input.blackboardRecordedAt) || input.blackboardRecordedAt < 0
      || !Number.isSafeInteger(input.updatedAt) || input.updatedAt < 0) {
    fail('ORCHESTRATION_V4_CANDIDATE_COMMIT_INVALID')
  }
  const identity = { runId, taskId, candidateContentHash }
  if (input.commitId !== candidateCommitSinkId(identity, 'commit')
      || input.messageId !== candidateCommitSinkId(identity, 'message')) {
    fail('ORCHESTRATION_V4_CANDIDATE_COMMIT_INVALID')
  }
  const blackboardBody = {
    version: 1,
    recordType: 'blackboard-entry',
    entryType: 'artifact-ref',
    subject: `candidate-commit:${input.commitId}`,
    statement: candidateCommitBlackboardStatement({ candidateArtifactId, candidateContentHash }),
    value: candidateContentHash,
    owner: { type: 'agent', agentKind: writerKind, role: writerRole },
    audience: { roles: [], agentKinds: [...targetKinds].sort() },
    lifecycle: {
      state: 'active', sequence: input.blackboardSequence,
      recordedAt: input.blackboardRecordedAt, supersedesEntryId: null,
    },
    provenance: {
      runId, taskId, round, agentRunId: null,
      artifactIds: [candidateArtifactId], evidenceIds,
    },
    refs: [candidateArtifactId, ...evidenceIds],
  }
  if (input.blackboardEntryId !== `blackboard-entry-${hashValue(blackboardBody)}`) {
    fail('ORCHESTRATION_V4_CANDIDATE_COMMIT_INVALID')
  }
  return {
    status, runId, taskId, groupId, threadRootId,
    candidateArtifactId, candidateContentHash, candidateContentRef,
    evidenceIds, writerKind, writerRole,
    commitId: input.commitId,
    messageId: input.messageId,
    blackboardEntryId: input.blackboardEntryId,
    blackboardSequence: input.blackboardSequence,
    blackboardRecordedAt: input.blackboardRecordedAt,
    messageStatus, blackboardStatus,
    attempt: input.attempt,
    updatedAt: safeTimestamp(input.updatedAt, now),
  }
}

function normalizeChallengeBindings(input, targetKinds, round) {
  if (!Array.isArray(input) || targetKinds.length < 2
      || input.length !== targetKinds.length || input.length > MAX_V4_ASSIGNMENTS) {
    fail('ORCHESTRATION_V4_CHALLENGE_BINDING_INVALID')
  }
  const bindings = input.map((binding) => {
    if (!isRecord(binding) || !exactFields(binding, [
      'round',
      'reviewerKind', 'reviewerSlotId', 'reviewerOperationId',
      'proposalKind', 'proposalSlotId', 'proposalOperationId', 'proposalReceiptId',
      'artifactIds', 'evidenceIds',
    ])) fail('ORCHESTRATION_V4_CHALLENGE_BINDING_INVALID')
    const normalized = {
      round: boundedInteger(binding.round, 0, 100000),
      reviewerKind: cleanId(binding.reviewerKind),
      reviewerSlotId: cleanId(binding.reviewerSlotId),
      reviewerOperationId: cleanId(binding.reviewerOperationId),
      proposalKind: cleanId(binding.proposalKind),
      proposalSlotId: cleanId(binding.proposalSlotId),
      proposalOperationId: cleanId(binding.proposalOperationId),
      proposalReceiptId: cleanId(binding.proposalReceiptId),
      artifactIds: uniqueIds(binding.artifactIds, MAX_V4_REFS),
      evidenceIds: uniqueIds(binding.evidenceIds, MAX_V4_REFS),
    }
    if (normalized.round < 2 || normalized.round !== round
        || !targetKinds.includes(normalized.reviewerKind)
        || !targetKinds.includes(normalized.proposalKind)
        || normalized.reviewerKind === normalized.proposalKind
        || !normalized.reviewerSlotId || !normalized.reviewerOperationId
        || !normalized.proposalSlotId || !normalized.proposalOperationId
        || !normalized.proposalReceiptId) {
      fail('ORCHESTRATION_V4_CHALLENGE_BINDING_INVALID')
    }
    return normalized
  })
  const reviewers = bindings.map(binding => binding.reviewerKind)
  const proposals = bindings.map(binding => binding.proposalKind)
  if (new Set(reviewers).size !== targetKinds.length
      || new Set(proposals).size !== targetKinds.length
      || targetKinds.some(kind => !reviewers.includes(kind) || !proposals.includes(kind))) {
    fail('ORCHESTRATION_V4_CHALLENGE_BINDING_INVALID')
  }
  return bindings
}

function normalizeSynthesisCandidate(input) {
  const fields = ['kind', 'score']
  if (isRecord(input?.evidence)) fields.push('evidence')
  if (!isRecord(input) || !exactFields(input, fields)) {
    fail('ORCHESTRATION_V4_SYNTHESIS_BINDING_INVALID')
  }
  const kind = cleanId(input.kind)
  if (!kind || !Number.isSafeInteger(input.score) || input.score < 0 || input.score > 1000) {
    fail('ORCHESTRATION_V4_SYNTHESIS_BINDING_INVALID')
  }
  let evidence
  if (hasOwn(input, 'evidence')) {
    if (!isRecord(input.evidence) || !exactFields(input.evidence, [
      'matrixVersion', 'score', 'confidence', 'sampleSize',
    ])) fail('ORCHESTRATION_V4_SYNTHESIS_BINDING_INVALID')
    const matrixVersion = cleanId(input.evidence.matrixVersion)
    if (!matrixVersion
        || !Number.isFinite(input.evidence.score)
        || input.evidence.score < 0 || input.evidence.score > 100
        || !Number.isFinite(input.evidence.confidence)
        || input.evidence.confidence < 0 || input.evidence.confidence > 1
        || !Number.isSafeInteger(input.evidence.sampleSize)
        || input.evidence.sampleSize < 1) {
      fail('ORCHESTRATION_V4_SYNTHESIS_BINDING_INVALID')
    }
    evidence = {
      matrixVersion,
      score: input.evidence.score,
      confidence: input.evidence.confidence,
      sampleSize: input.evidence.sampleSize,
    }
  }
  return { kind, score: input.score, ...(evidence ? { evidence } : {}) }
}

function createSynthesisBinding({ snapshotContentHash, targetKinds, candidates } = {}) {
  if (!SHA256.test(String(snapshotContentHash || ''))
      || !Array.isArray(targetKinds) || targetKinds.length < 2
      || targetKinds.length > MAX_V4_SLOTS || new Set(targetKinds).size !== targetKinds.length
      || targetKinds.some(kind => !cleanId(kind))
      || !Array.isArray(candidates) || candidates.length !== targetKinds.length) {
    fail('ORCHESTRATION_V4_SYNTHESIS_BINDING_INVALID')
  }
  const normalizedCandidates = candidates.map(normalizeSynthesisCandidate)
    .sort((left, right) => (left.kind < right.kind ? -1 : (left.kind > right.kind ? 1 : 0)))
  const candidateKinds = normalizedCandidates.map(candidate => candidate.kind)
  if (new Set(candidateKinds).size !== targetKinds.length
      || targetKinds.some(kind => !candidateKinds.includes(kind))) {
    fail('ORCHESTRATION_V4_SYNTHESIS_BINDING_INVALID')
  }
  const selectionInputHash = hashValue({
    snapshotContentHash,
    candidates: normalizedCandidates,
  })
  const ranked = rankedSynthesisCandidates(selectionInputHash, normalizedCandidates)
  const writerKind = ranked[0].kind
  return {
    selectionInputHash,
    candidates: normalizedCandidates,
    writerKind,
    verificationKinds: ranked
      .filter(candidate => candidate.kind !== writerKind)
      .slice(0, Math.min(2, targetKinds.length - 1))
      .map(candidate => candidate.kind),
  }
}

function rankedSynthesisCandidates(selectionInputHash, candidates) {
  return [...candidates].sort((left, right) => {
    const leftEvidence = left.evidence
      ? left.evidence.score * left.evidence.confidence : -1
    const rightEvidence = right.evidence
      ? right.evidence.score * right.evidence.confidence : -1
    const leftTieHash = hashValue({ selectionInputHash, kind: left.kind })
    const rightTieHash = hashValue({ selectionInputHash, kind: right.kind })
    return right.score - left.score
      || rightEvidence - leftEvidence
      || (right.evidence?.confidence || 0) - (left.evidence?.confidence || 0)
      || (right.evidence?.sampleSize || 0) - (left.evidence?.sampleSize || 0)
      || (leftTieHash < rightTieHash ? -1 : (leftTieHash > rightTieHash ? 1 : 0))
  })
}

function rankedSynthesisKinds(binding) {
  if (!isRecord(binding) || !SHA256.test(String(binding.selectionInputHash || ''))
      || !Array.isArray(binding.candidates)) {
    fail('ORCHESTRATION_V4_SYNTHESIS_RECOVERY_INVALID')
  }
  return rankedSynthesisCandidates(binding.selectionInputHash, binding.candidates)
    .map(candidate => candidate.kind)
}

function normalizeSynthesisBinding(input, targetKinds, snapshotContentHash) {
  if (!isRecord(input) || !exactFields(input, [
    'selectionInputHash', 'candidates', 'writerKind', 'verificationKinds',
  ])) fail('ORCHESTRATION_V4_SYNTHESIS_BINDING_INVALID')
  const expected = createSynthesisBinding({
    snapshotContentHash,
    targetKinds,
    candidates: input.candidates,
  })
  if (input.selectionInputHash !== expected.selectionInputHash
      || input.writerKind !== expected.writerKind
      || canonicalJson(input.verificationKinds) !== canonicalJson(expected.verificationKinds)) {
    fail('ORCHESTRATION_V4_SYNTHESIS_BINDING_INVALID')
  }
  return expected
}

function normalizeSynthesisRecoveryAttempt(input, targetKinds, index) {
  if (!isRecord(input) || !exactFields(input, [
    'attemptId', 'writerKind', 'slotId', 'operationId', 'attempt', 'status',
    'permission', 'leaseAcquired', 'sideEffectsPossible', 'outcomeCertainty', 'updatedAt',
  ])) fail('ORCHESTRATION_V4_SYNTHESIS_RECOVERY_INVALID')
  const attemptId = cleanId(input.attemptId)
  const writerKind = cleanId(input.writerKind)
  const slotId = cleanId(input.slotId)
  const operationId = cleanId(input.operationId)
  const status = String(input.status || '')
  const permission = String(input.permission || '')
  const outcomeCertainty = String(input.outcomeCertainty || '')
  if (!attemptId || !writerKind || !targetKinds.includes(writerKind) || !slotId || !operationId
      || !Number.isSafeInteger(input.attempt) || input.attempt < 1 || input.attempt > 1000000
      || !V4_SYNTHESIS_ATTEMPT_STATUSES.has(status)
      || !['read-only', 'workspace-write'].includes(permission)
      || typeof input.leaseAcquired !== 'boolean'
      || typeof input.sideEffectsPossible !== 'boolean'
      || !V4_OUTCOME_CERTAINTIES.has(outcomeCertainty)) {
    fail('ORCHESTRATION_V4_SYNTHESIS_RECOVERY_INVALID')
  }
  const validState = status === 'intent'
    ? !input.leaseAcquired && !input.sideEffectsPossible && outcomeCertainty === 'not_started'
    : status === 'leased'
      ? input.leaseAcquired
      : status === 'unknown_outcome'
        ? input.leaseAcquired && permission === 'workspace-write'
          && input.sideEffectsPossible && outcomeCertainty === 'unknown_outcome'
        : status === 'completed'
          ? input.leaseAcquired && outcomeCertainty === 'succeeded'
          : ['cancelled', 'superseded'].includes(status)
            ? outcomeCertainty === 'cancelled'
              || (input.leaseAcquired && permission === 'workspace-write'
                && input.sideEffectsPossible && outcomeCertainty === 'unknown_outcome')
            : ['not_started', 'known_failed', 'cancelled'].includes(outcomeCertainty)
  if (!validState || (permission === 'read-only' && input.sideEffectsPossible)) {
    fail('ORCHESTRATION_V4_SYNTHESIS_RECOVERY_INVALID')
  }
  return {
    attemptId,
    writerKind,
    slotId,
    operationId,
    attempt: input.attempt,
    status,
    permission,
    leaseAcquired: input.leaseAcquired,
    sideEffectsPossible: input.sideEffectsPossible,
    outcomeCertainty,
    updatedAt: safeTimestamp(input.updatedAt, index),
  }
}

function normalizeSynthesisRecoveryGate(input, recovery, round) {
  if (!isRecord(input) || !exactFields(input, [
    'bindingHash', 'writerKind', 'slotId', 'operationId', 'attempt',
    'proposedReplacementKind', 'round', 'stateEpoch', 'rankingFingerprint',
  ])) fail('ORCHESTRATION_V4_SYNTHESIS_RECOVERY_INVALID')
  const writerKind = cleanId(input.writerKind)
  const slotId = cleanId(input.slotId)
  const operationId = cleanId(input.operationId)
  const proposedReplacementKind = input.proposedReplacementKind === ''
    ? '' : cleanId(input.proposedReplacementKind)
  const fields = {
    writerKind,
    slotId,
    operationId,
    attempt: input.attempt,
    proposedReplacementKind,
    round: input.round,
    stateEpoch: input.stateEpoch,
    rankingFingerprint: recovery.rankingFingerprint,
  }
  const currentIndex = recovery.rankedKinds.indexOf(recovery.activeWriterKind)
  const expectedReplacement = recovery.rankedKinds[currentIndex + 1] || ''
  if (!SHA256.test(String(input.bindingHash || '')) || input.bindingHash !== hashValue(fields)
      || input.rankingFingerprint !== recovery.rankingFingerprint
      || writerKind !== recovery.activeWriterKind || !slotId || !operationId
      || !Number.isSafeInteger(input.attempt) || input.attempt < 1
      || proposedReplacementKind !== expectedReplacement
      || !Number.isSafeInteger(input.round) || input.round !== round
      || !Number.isSafeInteger(input.stateEpoch) || input.stateEpoch !== recovery.stateEpoch) {
    fail('ORCHESTRATION_V4_SYNTHESIS_RECOVERY_INVALID')
  }
  return { bindingHash: input.bindingHash, ...fields }
}

function normalizeSynthesisRecovery(input, targetKinds, synthesisBinding, coordinationPlan, round) {
  const fields = [
    'revision', 'originalWriterKind', 'activeWriterKind', 'verificationKinds',
    'rankedKinds', 'rankingFingerprint', 'stateEpoch', 'triedWriters', 'attempts',
  ]
  if (isRecord(input?.pendingGate)) fields.push('pendingGate')
  if (!isRecord(input) || !exactFields(input, fields)
      || (!synthesisBinding && !coordinationPlan)) {
    fail('ORCHESTRATION_V4_SYNTHESIS_RECOVERY_INVALID')
  }
  const rankedKinds = coordinationPlan
    ? coordinationRecoveryKinds(coordinationPlan)
    : rankedSynthesisKinds(synthesisBinding)
  const originalWriterKind = cleanId(input.originalWriterKind)
  const activeWriterKind = cleanId(input.activeWriterKind)
  const verificationKinds = uniqueIds(input.verificationKinds, MAX_V4_SLOTS)
  const triedWriters = uniqueIds(input.triedWriters, MAX_V4_SLOTS, true)
  const expectedVerifiers = coordinationPlan
    ? coordinationPlan.verifierKinds.filter(kind => kind !== activeWriterKind)
    : rankedKinds
      .filter(kind => kind !== activeWriterKind)
      .slice(0, Math.min(2, targetKinds.length - 1))
  const activeIndex = rankedKinds.indexOf(activeWriterKind)
  const expectedTried = activeIndex < 0 ? [] : rankedKinds.slice(0, activeIndex + 1)
  const originalWriter = coordinationPlan?.finalizerKind || synthesisBinding?.writerKind
  const rankingFingerprint = coordinationPlan
    ? hashValue({ planHash: coordinationPlan.planHash, rankedKinds })
    : hashValue({ selectionInputHash: synthesisBinding.selectionInputHash, rankedKinds })
  if (!Number.isSafeInteger(input.revision) || input.revision < 1 || input.revision > 1000000
      || originalWriterKind !== originalWriter || activeIndex < 0
      || canonicalJson(input.rankedKinds) !== canonicalJson(rankedKinds)
      || input.rankingFingerprint !== rankingFingerprint
      || canonicalJson(verificationKinds) !== canonicalJson(expectedVerifiers)
      || canonicalJson(triedWriters) !== canonicalJson(expectedTried)
      || !Number.isSafeInteger(input.stateEpoch) || input.stateEpoch < 0) {
    fail('ORCHESTRATION_V4_SYNTHESIS_RECOVERY_INVALID')
  }
  if (!Array.isArray(input.attempts) || input.attempts.length < 1 || input.attempts.length > 128) {
    fail('ORCHESTRATION_V4_SYNTHESIS_RECOVERY_INVALID')
  }
  const attempts = input.attempts.map((attempt, index) => (
    normalizeSynthesisRecoveryAttempt(attempt, targetKinds, index)
  ))
  const attemptIds = attempts.map(attempt => attempt.attemptId)
  const operationIds = attempts.map(attempt => attempt.operationId)
  const activeAttempts = attempts.filter(attempt => (
    ['intent', 'leased', 'unknown_outcome'].includes(attempt.status)
  ))
  if (new Set(attemptIds).size !== attemptIds.length
      || new Set(operationIds).size !== operationIds.length
      || attempts.some(attempt => !triedWriters.includes(attempt.writerKind))
      || activeAttempts.length > 1
      || (activeAttempts.length === 1 && activeAttempts[0].writerKind !== activeWriterKind)) {
    fail('ORCHESTRATION_V4_SYNTHESIS_RECOVERY_INVALID')
  }
  const recovery = {
    revision: input.revision,
    originalWriterKind,
    activeWriterKind,
    verificationKinds,
    rankedKinds,
    rankingFingerprint,
    stateEpoch: input.stateEpoch,
    triedWriters,
    attempts,
  }
  const unknownAttempt = attempts.find(attempt => attempt.status === 'unknown_outcome')
  const pendingGate = hasOwn(input, 'pendingGate')
    ? normalizeSynthesisRecoveryGate(input.pendingGate, recovery, round)
    : null
  const gateAttempt = pendingGate ? attempts.find(attempt => (
    attempt.writerKind === pendingGate.writerKind
    && attempt.slotId === pendingGate.slotId
    && attempt.operationId === pendingGate.operationId
    && attempt.attempt === pendingGate.attempt
  )) : null
  const validGateAttempt = gateAttempt?.status === 'unknown_outcome'
    || (gateAttempt?.status === 'cancelled'
      && gateAttempt.sideEffectsPossible === true
      && gateAttempt.outcomeCertainty === 'unknown_outcome')
  if ((unknownAttempt && !pendingGate) || (pendingGate && !validGateAttempt)
      || (unknownAttempt && gateAttempt !== unknownAttempt)) {
    fail('ORCHESTRATION_V4_SYNTHESIS_RECOVERY_INVALID')
  }
  return { ...recovery, ...(pendingGate ? { pendingGate } : {}) }
}

function normalizeConvergence(input, round) {
  if (!isRecord(input) || !exactFields(input, [
    'candidateArtifactId', 'candidateContentHash', 'openIssueIds', 'stateKey',
    'lastCompletedRound', 'consecutiveStableRounds', 'stateEpoch',
    'acknowledgedGateEpoch',
  ])) fail('ORCHESTRATION_V4_CONVERGENCE_INVALID')
  const candidateArtifactId = String(input.candidateArtifactId || '')
  const candidateContentHash = String(input.candidateContentHash || '')
  const openIssueIds = Array.isArray(input.openIssueIds) ? [...input.openIssueIds] : null
  const stateKey = String(input.stateKey || '')
  const lastCompletedRound = input.lastCompletedRound
  const consecutiveStableRounds = input.consecutiveStableRounds
  const stateEpoch = input.stateEpoch
  const acknowledgedGateEpoch = input.acknowledgedGateEpoch
  if (!ARTIFACT_ID.test(candidateArtifactId) || !SHA256.test(candidateContentHash)
      || !openIssueIds || openIssueIds.length > MAX_V4_UNRESOLVED
      || openIssueIds.some(issueId => typeof issueId !== 'string' || !ISSUE_ID.test(issueId))
      || new Set(openIssueIds).size !== openIssueIds.length
      || canonicalJson(openIssueIds) !== canonicalJson([...openIssueIds].sort())
      || !SHA256.test(stateKey)
      || stateKey !== hashValue({ candidateContentHash, openIssueIds })
      || !Number.isSafeInteger(lastCompletedRound) || lastCompletedRound < 2
      || !Number.isSafeInteger(round) || lastCompletedRound > round
      || !Number.isSafeInteger(consecutiveStableRounds) || consecutiveStableRounds < 1
      || consecutiveStableRounds > lastCompletedRound
      || !Number.isSafeInteger(stateEpoch) || stateEpoch < 1
      || !Number.isSafeInteger(acknowledgedGateEpoch) || acknowledgedGateEpoch < 0
      || acknowledgedGateEpoch > stateEpoch) {
    fail('ORCHESTRATION_V4_CONVERGENCE_INVALID')
  }
  return {
    candidateArtifactId,
    candidateContentHash,
    openIssueIds,
    stateKey,
    lastCompletedRound,
    consecutiveStableRounds,
    stateEpoch,
    acknowledgedGateEpoch,
  }
}

function scopedSlotReceipt(item, slot, snapshotHash) {
  try {
    const receipt = parseCollaborationControlBlock(item?.receipt)
    return receipt.agentKind === slot.agentKind
      && receipt.slotId === slot.slotId
      && receipt.snapshotHash === snapshotHash
      ? receipt
      : null
  } catch {
    return null
  }
}

function receiptOperationBound(receipt, slot, deliveryWatermarks) {
  if (receipt.operationId === slot.operationId && receipt.phase === slot.phase) return true
  return deliveryWatermarks.some(watermark => (
    watermark.agentKind === receipt.agentKind
    && watermark.phase === receipt.phase
    && watermark.operationId === receipt.operationId
    && watermark.snapshotHash === receipt.snapshotHash
    && watermark.watermark >= receipt.deliveryWatermark
  ))
}

function completedChallengeEvidence(
  slots, targetKinds, snapshotHash, challengeBindings, deliveryWatermarks = [],
  allowHistoricalOperation = false,
) {
  return targetKinds.every(kind => {
    const slot = slots.find(candidate => candidate.agentKind === kind)
    const challengeBinding = challengeBindings?.find(binding => (
      binding.reviewerKind === kind && binding.reviewerSlotId === slot?.slotId
    ))
    const operationId = slot?.phase === 'challenge'
      ? slot.operationId
      : challengeBinding?.reviewerOperationId
    return Boolean(slot && (slot.resultRefs?.workflowOutcomeRefs || []).some((item) => {
      const receipt = scopedSlotReceipt(item, slot, snapshotHash)
      return receipt?.phase === 'challenge'
        && V4_COMPLETED_CHALLENGE_STATUSES.has(receipt.status)
        && (receipt.operationId === operationId
          || (allowHistoricalOperation
            && receiptOperationBound(receipt, slot, deliveryWatermarks)))
    }))
  })
}

function postChallengeReceiptObservable(slots, deliveryWatermarks, snapshotHash) {
  return slots.some(slot => (slot.resultRefs?.workflowOutcomeRefs || []).some((item) => {
    const receipt = scopedSlotReceipt(item, slot, snapshotHash)
    return ['synthesis', 'verification'].includes(receipt?.phase)
      && V4_COMPLETED_CHALLENGE_STATUSES.has(receipt.status)
      && receiptOperationBound(receipt, slot, deliveryWatermarks)
  }))
}

function postChallengeReceiptPresent(slots) {
  return slots.some(slot => (slot.resultRefs?.workflowOutcomeRefs || []).some(item => (
    ['synthesis', 'verification'].includes(item?.receipt?.phase)
  )))
}

function synthesisStateObservable(phase, slots) {
  return V4_POST_SYNTHESIS_PHASES.has(phase)
    || slots.some(slot => V4_POST_SYNTHESIS_PHASES.has(slot.phase))
    || postChallengeReceiptPresent(slots)
}

function validateV4Relations(orchestration, targetKinds) {
  const allowedKinds = new Set(targetKinds || [])
  const allKinds = [
    ...orchestration.currentKinds,
    ...(orchestration.currentKind ? [orchestration.currentKind] : []),
    ...(orchestration.pendingKinds || []),
    ...(orchestration.activeKinds || []),
    ...(orchestration.successfulKinds || []),
    ...(orchestration.agreementKinds || []),
    ...(orchestration.attachmentRecipients || []),
    ...orchestration.slots.map(slot => slot.agentKind),
    ...orchestration.plan.assignments.map(assignment => assignment.agentKind),
    ...orchestration.deliveryWatermarks.map(watermark => watermark.agentKind),
    ...orchestration.commitState.committedKinds,
    ...orchestration.commitState.pendingKinds,
    ...(orchestration.commitState.writerKind ? [orchestration.commitState.writerKind] : []),
    ...(orchestration.candidateCommit?.writerKind ? [orchestration.candidateCommit.writerKind] : []),
    ...(orchestration.challengeBindings || []).flatMap(binding => [
      binding.reviewerKind, binding.proposalKind,
    ]),
    ...(orchestration.synthesisBinding?.candidates || []).map(candidate => candidate.kind),
    ...(orchestration.synthesisBinding ? [
      orchestration.synthesisBinding.writerKind,
      ...orchestration.synthesisBinding.verificationKinds,
    ] : []),
    ...(orchestration.synthesisRecovery ? [
      orchestration.synthesisRecovery.originalWriterKind,
      orchestration.synthesisRecovery.activeWriterKind,
      ...orchestration.synthesisRecovery.verificationKinds,
      ...orchestration.synthesisRecovery.rankedKinds,
      ...orchestration.synthesisRecovery.triedWriters,
      ...orchestration.synthesisRecovery.attempts.map(attempt => attempt.writerKind),
    ] : []),
    ...(orchestration.coordinationPlan ? [
      orchestration.coordinationPlan.finalizerKind,
      ...orchestration.coordinationPlan.verifierKinds,
      ...orchestration.coordinationPlan.agreedBy,
      ...orchestration.coordinationPlan.assignments.map(assignment => assignment.ownerKind),
    ] : []),
    ...(orchestration.workReceipts || []).map(receipt => receipt.ownerKind),
  ]
  if (targetKinds && allKinds.some(kind => !allowedKinds.has(kind))) {
    fail('ORCHESTRATION_V4_REFERENCE_INVALID')
  }
  const slotIds = orchestration.slots.map(slot => slot.slotId)
  const operationIds = orchestration.slots.map(slot => slot.operationId)
  const commitIds = orchestration.slots.map(slot => slot.commitId).filter(Boolean)
  const messageIds = orchestration.slots.map(slot => slot.messageId).filter(Boolean)
  if (new Set(slotIds).size !== slotIds.length
      || new Set(operationIds).size !== operationIds.length
      || new Set(commitIds).size !== commitIds.length
      || new Set(messageIds).size !== messageIds.length) {
    fail('ORCHESTRATION_V4_SLOT_INVALID')
  }
  const planSlotIds = orchestration.plan.assignments.map(assignment => assignment.slotId)
  const planKinds = orchestration.plan.assignments.map(assignment => assignment.agentKind)
  if (new Set(planSlotIds).size !== planSlotIds.length
      || planSlotIds.length !== slotIds.length
      || slotIds.some(slotId => !planSlotIds.includes(slotId))
      || planKinds.some(kind => !slotIds.some(slotId => (
        orchestration.slots.find(slot => slot.slotId === slotId)?.agentKind === kind
      )))) {
    fail('ORCHESTRATION_V4_PLAN_INVALID')
  }
  if (targetKinds && targetKinds.some(kind => (
    !planKinds.includes(kind) || !orchestration.slots.some(slot => slot.agentKind === kind)
  ))) {
    fail('ORCHESTRATION_V4_REFERENCE_INVALID')
  }
  if (orchestration.workReceipts) {
    if (!orchestration.coordinationPlan || !orchestration.snapshot?.bodyHash
        || !orchestration.snapshot?.contentRef) {
      fail('ORCHESTRATION_V4_WORK_RECEIPT_INVALID')
    }
    const receiptIds = new Set()
    const taskIds = new Set()
    const operationIds = new Set()
    for (const workReceipt of orchestration.workReceipts) {
      const assignment = orchestration.coordinationPlan.assignments.find(candidate => (
        candidate.taskId === workReceipt.taskId
      ))
      const slot = orchestration.slots.find(candidate => candidate.slotId === workReceipt.slotId)
      const historicalReceipt = slot?.resultRefs?.workflowOutcomeRefs?.find(item => (
        item?.receipt?.receiptId === workReceipt.collaborationReceipt.receiptId
      ))?.receipt
      const operationBound = slot?.operationId === workReceipt.operationId
        || historicalReceipt?.operationId === workReceipt.operationId
        || orchestration.deliveryWatermarks.some(watermark => (
          watermark.agentKind === workReceipt.ownerKind
          && watermark.phase === 'work'
          && watermark.operationId === workReceipt.operationId
          && watermark.snapshotHash === workReceipt.snapshotHash
          && watermark.watermark >= workReceipt.collaborationReceipt.deliveryWatermark
        ))
      if (!assignment || assignment.ownerKind !== workReceipt.ownerKind
          || !slot || slot.agentKind !== workReceipt.ownerKind
          || !operationBound
          || workReceipt.snapshotHash !== orchestration.snapshotHash
          || workReceipt.snapshotBodyHash !== orchestration.snapshot.bodyHash
          || canonicalJson(workReceipt.snapshotContentRef)
            !== canonicalJson(orchestration.snapshot.contentRef)
          || workReceipt.planHash !== orchestration.coordinationPlan.planHash
          || !historicalReceipt
          || canonicalJson(parseCollaborationControlBlock(historicalReceipt))
            !== canonicalJson(workReceipt.collaborationReceipt)
          || receiptIds.has(workReceipt.workReceiptId)
          || taskIds.has(workReceipt.taskId)
          || operationIds.has(workReceipt.operationId)) {
        fail('ORCHESTRATION_V4_WORK_RECEIPT_INVALID')
      }
      receiptIds.add(workReceipt.workReceiptId)
      taskIds.add(workReceipt.taskId)
      operationIds.add(workReceipt.operationId)
    }
  }
  const assignmentsBySlot = new Map(orchestration.plan.assignments.map(item => [item.slotId, item]))
  for (const slot of orchestration.slots) {
    const assignment = assignmentsBySlot.get(slot.slotId)
    if (assignment && (assignment.agentKind !== slot.agentKind
        || assignment.operationId !== slot.operationId)) {
      fail('ORCHESTRATION_V4_PLAN_INVALID')
    }
    if (slot.snapshotHash !== orchestration.snapshotHash) {
      fail('ORCHESTRATION_V4_SNAPSHOT_HASH_MISMATCH')
    }
  }
  if (orchestration.workflow === 'manual' && orchestration.template === 'concurrent-batch') {
    const writerKind = orchestration.commitState.writerKind
    const writableSlots = orchestration.slots.filter(slot => (
      slot.permission === 'workspace-write'
    ))
    const writableAssignments = orchestration.plan.assignments.filter(assignment => (
      assignment.readOnly === false
    ))
    const validWriterBinding = writerKind
      ? writableSlots.some(slot => slot.agentKind === writerKind)
        && writableSlots.length === writableAssignments.length
        && writableSlots.every(slot => writableAssignments.some(assignment => (
          assignment.slotId === slot.slotId && assignment.agentKind === slot.agentKind
            && (writableSlots.length === 1 || assignment.role === 'writer')
        )))
      : writableSlots.length === 0 && writableAssignments.length === 0
    if (!validWriterBinding) fail('ORCHESTRATION_V4_PERMISSION_INVALID')
  }
  if (orchestration.workflow === 'auto' && orchestration.template === 'discussion') {
    const writableSlots = orchestration.slots.filter(slot => (
      slot.permission === 'workspace-write'
    ))
    const effectiveWriterKind = orchestration.synthesisRecovery?.activeWriterKind
      || orchestration.synthesisBinding?.writerKind
      || orchestration.coordinationPlan?.finalizerKind
      || orchestration.commitState.writerKind
      || orchestration.discussionWriterKind
    const nativeWrites = Boolean(orchestration.discussionWriterKind
      && !orchestration.coordinationPlan && !orchestration.synthesisBinding
      && ['proposal', 'discussion'].includes(orchestration.phase))
    if (!nativeWrites && (writableSlots.length > 1 || writableSlots.some(slot => (
      slot.agentKind !== effectiveWriterKind
        || !['discussion', 'synthesis', 'human-gate'].includes(orchestration.phase)
        || (orchestration.phase === 'discussion' && !orchestration.discussionWriterKind)
    )))) fail('ORCHESTRATION_V4_PERMISSION_INVALID')
    for (const assignment of ['proposal', 'discussion'].includes(orchestration.phase) ? orchestration.plan.assignments : []) {
      const slot = orchestration.slots.find(item => item.slotId === assignment.slotId)
      if (slot && assignment.readOnly !== (slot.permission !== 'workspace-write')) {
        fail('ORCHESTRATION_V4_PERMISSION_INVALID')
      }
    }
  }
  const watermarkKeys = orchestration.deliveryWatermarks.map(item => `${item.agentKind}\u0000${item.phase}`)
  if (new Set(watermarkKeys).size !== watermarkKeys.length) {
    fail('ORCHESTRATION_V4_WATERMARK_INVALID')
  }
  if (orchestration.currentKinds.some(kind => !orchestration.slots.some(slot => (
    slot.agentKind === kind && ['planned', 'prepared', 'queued', 'running', 'waiting'].includes(slot.status)
  )))) fail('ORCHESTRATION_V4_REFERENCE_INVALID')
  const operationIdsByKind = new Map()
  for (const slot of orchestration.slots) {
    const ids = new Set([slot.operationId])
    for (const item of slot.resultRefs?.workflowOutcomeRefs || []) {
      if (item?.receipt?.operationId) ids.add(item.receipt.operationId)
    }
    operationIdsByKind.set(slot.agentKind, ids)
  }
  for (const watermark of orchestration.deliveryWatermarks) {
    const validOperations = operationIdsByKind.get(watermark.agentKind)
    if (!validOperations || (watermark.operationId && !validOperations.has(watermark.operationId))) {
      fail('ORCHESTRATION_V4_WATERMARK_INVALID')
    }
  }
  const slotIdSet = new Set(slotIds)
  for (const slotId of orchestration.commitState.committedSlotIds || []) {
    if (!slotIdSet.has(slotId)) fail('ORCHESTRATION_V4_COMMIT_STATE_INVALID')
  }
  if (orchestration.commitState.writerKind
      && !targetKinds?.includes(orchestration.commitState.writerKind)
      && !orchestration.slots.some(slot => slot.agentKind === orchestration.commitState.writerKind)) {
    fail('ORCHESTRATION_V4_COMMIT_STATE_INVALID')
  }
  const writerKind = orchestration.commitState.writerKind
  const effectiveSynthesisWriter = orchestration.synthesisRecovery?.activeWriterKind
    || orchestration.coordinationPlan?.finalizerKind
    || orchestration.synthesisBinding?.writerKind || ''
  if (orchestration.synthesisBinding && writerKind !== effectiveSynthesisWriter) {
    fail(orchestration.synthesisRecovery
      ? 'ORCHESTRATION_V4_SYNTHESIS_RECOVERY_INVALID'
      : 'ORCHESTRATION_V4_SYNTHESIS_BINDING_INVALID')
  }
  const coordinatedWriter = orchestration.synthesisRecovery?.activeWriterKind
    || orchestration.coordinationPlan?.finalizerKind || ''
  if (orchestration.coordinationPlan && (
    orchestration.template !== 'discussion'
      || orchestration.coordinationPlan.snapshotHash !== orchestration.snapshotHash
      || (writerKind && coordinatedWriter !== writerKind)
      || (effectiveSynthesisWriter && coordinatedWriter !== effectiveSynthesisWriter)
  )) fail('ORCHESTRATION_V4_COORDINATION_PLAN_INVALID')
  if (orchestration.synthesisRecovery) {
    const slotsById = new Map(orchestration.slots.map(slot => [slot.slotId, slot]))
    for (const attempt of orchestration.synthesisRecovery.attempts) {
      const slot = slotsById.get(attempt.slotId)
      if (!slot || slot.agentKind !== attempt.writerKind) {
        fail('ORCHESTRATION_V4_SYNTHESIS_RECOVERY_INVALID')
      }
      if (['intent', 'leased', 'unknown_outcome'].includes(attempt.status)
          && slot.operationId !== attempt.operationId) {
        fail('ORCHESTRATION_V4_SYNTHESIS_RECOVERY_INVALID')
      }
    }
    const activeAttempt = [...orchestration.synthesisRecovery.attempts].reverse().find(attempt => (
      ['intent', 'leased', 'unknown_outcome'].includes(attempt.status)
    ))
    if (activeAttempt && activeAttempt.writerKind !== effectiveSynthesisWriter) {
      fail('ORCHESTRATION_V4_SYNTHESIS_RECOVERY_INVALID')
    }
  }
  if (writerKind && orchestration.template === 'discussion') {
    if (orchestration.commitState.committedKinds.some(kind => kind !== writerKind)) {
      fail('ORCHESTRATION_V4_COMMIT_STATE_INVALID')
    }
    const committedSlotKinds = new Set((orchestration.commitState.committedSlotIds || [])
      .map(slotId => orchestration.slots.find(slot => slot.slotId === slotId)?.agentKind)
      .filter(Boolean))
    if ([...committedSlotKinds].some(kind => kind !== writerKind)
        || (orchestration.commitState.status === 'committed'
          && !orchestration.commitState.committedKinds.includes(writerKind))) {
      fail('ORCHESTRATION_V4_COMMIT_STATE_INVALID')
    }
  }
  if (orchestration.candidateCommit) {
    const candidateCommit = orchestration.candidateCommit
    const writerAssignments = orchestration.coordinationPlan?.assignments.filter(assignment => (
      assignment.ownerKind === candidateCommit.writerKind
    )) || []
    const expectedWriterRole = writerAssignments.find(assignment => (
      assignment.role === 'integrator'
    ))?.role || writerAssignments[0]?.role || 'integrator'
    if (orchestration.workflow !== 'auto' || orchestration.template !== 'discussion'
        || candidateCommit.writerKind !== effectiveSynthesisWriter
        || candidateCommit.writerRole !== expectedWriterRole
        || (orchestration.convergence && (
          orchestration.convergence.candidateArtifactId !== candidateCommit.candidateArtifactId
          || orchestration.convergence.candidateContentHash !== candidateCommit.candidateContentHash
          || orchestration.convergence.openIssueIds.length !== 0
        ))
        || (candidateCommit.status === 'completed' && orchestration.phase !== 'completed')
        || (candidateCommit.status !== 'completed' && orchestration.phase !== 'commit')) {
      fail('ORCHESTRATION_V4_CANDIDATE_COMMIT_INVALID')
    }
    const entry = orchestration.collaboration?.entries?.find(candidate => (
      candidate.entryId === candidateCommit.blackboardEntryId
    ))
    if (candidateCommit.blackboardStatus === 'committed') {
      if (!entry || entry.entryType !== 'artifact-ref'
          || entry.subject !== `candidate-commit:${candidateCommit.commitId}`
          || entry.value !== candidateCommit.candidateContentHash
          || entry.statement !== candidateCommitBlackboardStatement(candidateCommit)
          || entry.owner?.type !== 'agent'
          || entry.owner.agentKind !== candidateCommit.writerKind
          || entry.owner.role !== candidateCommit.writerRole
          || entry.provenance?.runId !== candidateCommit.runId
          || entry.provenance?.taskId !== candidateCommit.taskId
          || canonicalJson(entry.provenance.artifactIds)
            !== canonicalJson([candidateCommit.candidateArtifactId])
          || canonicalJson(entry.provenance.evidenceIds)
            !== canonicalJson(candidateCommit.evidenceIds)
          || canonicalJson(entry.refs) !== canonicalJson([
            candidateCommit.candidateArtifactId, ...candidateCommit.evidenceIds,
          ])) {
        fail('ORCHESTRATION_V4_CANDIDATE_COMMIT_INVALID')
      }
    } else if (entry) {
      fail('ORCHESTRATION_V4_CANDIDATE_COMMIT_INVALID')
    }
  }
  if (orchestration.challengeBindings) {
    const slotsByKind = new Map(orchestration.slots.map(slot => [slot.agentKind, slot]))
    for (const binding of orchestration.challengeBindings) {
      const reviewerSlot = slotsByKind.get(binding.reviewerKind)
      const proposalSlot = slotsByKind.get(binding.proposalKind)
      if (!reviewerSlot || reviewerSlot.slotId !== binding.reviewerSlotId
          || !proposalSlot || proposalSlot.slotId !== binding.proposalSlotId) {
        fail('ORCHESTRATION_V4_CHALLENGE_BINDING_INVALID')
      }
      const challengeOperations = new Set([reviewerSlot.operationId])
      for (const item of reviewerSlot.resultRefs?.workflowOutcomeRefs || []) {
        try {
          const receipt = parseCollaborationControlBlock(item?.receipt)
          if (receipt.phase === 'challenge') challengeOperations.add(receipt.operationId)
        } catch { /* non-receipt workflow records are unrelated */ }
      }
      if (!challengeOperations.has(binding.reviewerOperationId)) {
        fail('ORCHESTRATION_V4_CHALLENGE_BINDING_INVALID')
      }
      let proposalReceipt = null
      for (const item of proposalSlot.resultRefs?.workflowOutcomeRefs || []) {
        try {
          const receipt = parseCollaborationControlBlock(item?.receipt)
          if (receipt.phase === 'proposal' && receipt.agentKind === binding.proposalKind) {
            proposalReceipt = receipt
          }
        } catch { /* non-receipt workflow records are unrelated */ }
      }
      if (!proposalReceipt
          || proposalReceipt.slotId !== binding.proposalSlotId
          || proposalReceipt.operationId !== binding.proposalOperationId
          || proposalReceipt.receiptId !== binding.proposalReceiptId
          || canonicalJson(proposalReceipt.artifactIds || []) !== canonicalJson(binding.artifactIds)
          || canonicalJson(proposalReceipt.evidenceIds || []) !== canonicalJson(binding.evidenceIds)) {
        fail('ORCHESTRATION_V4_CHALLENGE_BINDING_INVALID')
      }
    }
  }
}

function parseOrchestrationV4(input, options = {}) {
  if (!isRecord(input) || input.version !== ORCHESTRATION_V4_VERSION
      || !exactFields(input, [...ORCHESTRATION_FIELDS])) {
    fail('ORCHESTRATION_V4_SCHEMA_INVALID')
  }
  for (const field of [
    'workflow', 'template', 'phase', 'batchId', 'currentKinds', 'snapshotHash',
    'plan', 'slots', 'deliveryWatermarks', 'commitState',
  ]) {
    if (!hasOwn(input, field)) fail('ORCHESTRATION_V4_SCHEMA_INVALID')
  }
  const { workflow, template } = normalizeWorkflow(input.workflow, input.template)
  const phase = phaseForTemplate(template, String(input.phase || ''))
  const discussionStyle = hasOwn(input, 'discussionStyle')
    ? String(input.discussionStyle || '')
    : ''
  if (discussionStyle && (
    workflow !== 'auto'
    || template !== 'discussion'
    || !['sequential', 'agent-led'].includes(discussionStyle)
  )) fail('ORCHESTRATION_V4_SCHEMA_INVALID')
  const batchId = cleanId(input.batchId)
  const snapshotHash = String(input.snapshotHash || '')
  if (!batchId || !SHA256.test(snapshotHash)) fail('ORCHESTRATION_V4_SCHEMA_INVALID')
  const targetKinds = Array.isArray(options.targetKinds)
    ? uniqueIds(options.targetKinds, MAX_V4_SLOTS, true)
    : null
  const currentKinds = uniqueIds(input.currentKinds || [], MAX_V4_SLOTS)
  const snapshot = normalizeSnapshot(input.snapshot, snapshotHash)
  if (['concurrent-batch', 'discussion'].includes(template) && !snapshot?.contentRef) {
    fail('ORCHESTRATION_V4_SNAPSHOT_INVALID')
  }
  if (template === 'discussion' && !snapshot?.bodyHash) {
    fail('ORCHESTRATION_V4_SNAPSHOT_INVALID')
  }
  const inferredKinds = uniqueIds([...new Set([
    ...currentKinds,
    ...(Array.isArray(input.pendingKinds) ? input.pendingKinds : []),
    ...(Array.isArray(input.activeKinds) ? input.activeKinds : []),
    ...(Array.isArray(input.successfulKinds) ? input.successfulKinds : []),
    ...(Array.isArray(input.agreementKinds) ? input.agreementKinds : []),
    ...(Array.isArray(input.attachmentRecipients) ? input.attachmentRecipients : []),
    ...(snapshot?.targetKinds || []),
    ...(Array.isArray(input.plan?.assignments)
      ? input.plan.assignments.map(assignment => assignment?.agentKind)
      : []),
    ...(Array.isArray(input.slots) ? input.slots.map(slot => slot?.agentKind) : []),
    ...(Array.isArray(input.commitState?.committedKinds) ? input.commitState.committedKinds : []),
    ...(Array.isArray(input.commitState?.pendingKinds) ? input.commitState.pendingKinds : []),
    ...(input.commitState?.writerKind ? [input.commitState.writerKind] : []),
    ...(input.candidateCommit?.writerKind ? [input.candidateCommit.writerKind] : []),
    ...(input.synthesisRecovery?.originalWriterKind ? [input.synthesisRecovery.originalWriterKind] : []),
    ...(input.synthesisRecovery?.activeWriterKind ? [input.synthesisRecovery.activeWriterKind] : []),
    ...(Array.isArray(input.synthesisRecovery?.verificationKinds)
      ? input.synthesisRecovery.verificationKinds : []),
    ...(Array.isArray(input.synthesisRecovery?.rankedKinds)
      ? input.synthesisRecovery.rankedKinds : []),
    ...(Array.isArray(input.workReceipts)
      ? input.workReceipts.map(receipt => receipt?.ownerKind) : []),
  ].filter(Boolean))], MAX_V4_SLOTS)
  const effectiveTargetKinds = targetKinds || inferredKinds
  const plan = normalizePlan(
    input.plan, snapshotHash, effectiveTargetKinds, safeTimestamp(options.now, 0),
  )
  if (!plan) fail('ORCHESTRATION_V4_PLAN_INVALID')
  const planKinds = plan.assignments.map(assignment => assignment.agentKind)
  const effectiveKinds = targetKinds || [...new Set([...inferredKinds, ...planKinds])]
  if (currentKinds.some(kind => !effectiveKinds.includes(kind))) fail('ORCHESTRATION_V4_REFERENCE_INVALID')
  const activeKinds = hasOwn(input, 'activeKinds')
    ? uniqueIds(input.activeKinds, MAX_V4_SLOTS)
    : effectiveKinds
  if (activeKinds.some(kind => !effectiveKinds.includes(kind))) {
    fail('ORCHESTRATION_V4_REFERENCE_INVALID')
  }
  const participantKinds = workflow === 'auto' && template === 'discussion'
    ? activeKinds
    : effectiveKinds
  if (!Array.isArray(input.slots) || input.slots.length > MAX_V4_SLOTS) {
    fail('ORCHESTRATION_V4_SLOT_INVALID')
  }
  const slots = input.slots.map((slot, index) => (
    normalizeSlot(slot, effectiveKinds, phase, index, template)
  ))
  const commitState = normalizeCommitState(
    input.commitState, effectiveKinds, safeTimestamp(options.now, 0),
  )
  const candidateCommit = hasOwn(input, 'candidateCommit')
    ? normalizeCandidateCommit(
        input.candidateCommit, effectiveKinds, safeTimestamp(options.now, 0), input.round,
      )
    : null
  if (candidateCommit && (workflow !== 'auto' || template !== 'discussion')) {
    fail('ORCHESTRATION_V4_CANDIDATE_COMMIT_INVALID')
  }
  const deliveryWatermarks = Array.isArray(input.deliveryWatermarks)
    ? input.deliveryWatermarks.map((item, index) => normalizeWatermark(item, effectiveKinds, index))
    : []
  if (deliveryWatermarks.length > MAX_V4_WATERMARKS) fail('ORCHESTRATION_V4_WATERMARK_INVALID')
  const deliveryState = Array.isArray(input.deliveryState)
    ? input.deliveryState.map((item, index) => normalizeDeliveryState(item, effectiveKinds, index))
    : []
  if (deliveryState.length > MAX_V4_DELIVERY_STATE) fail('ORCHESTRATION_V4_DELIVERY_STATE_INVALID')
  const deliveryStateKeys = deliveryState.map(item => [
    item.recipientKind, item.sessionRefHash, item.sessionProvenanceHash,
    item.sourceAgentKind, item.sourcePhase,
  ].join('\u0000'))
  if (new Set(deliveryStateKeys).size !== deliveryStateKeys.length
      || deliveryStateKeys.some((key, index) => index > 0 && key < deliveryStateKeys[index - 1])) {
    fail('ORCHESTRATION_V4_DELIVERY_STATE_INVALID')
  }
  const challengeBindings = hasOwn(input, 'challengeBindings')
    ? normalizeChallengeBindings(input.challengeBindings, participantKinds, input.round)
    : null
  if (challengeBindings && (workflow !== 'auto' || template !== 'discussion')) {
    fail('ORCHESTRATION_V4_CHALLENGE_BINDING_INVALID')
  }
  const synthesisBinding = hasOwn(input, 'synthesisBinding')
    ? normalizeSynthesisBinding(input.synthesisBinding, participantKinds, snapshot?.bodyHash)
    : null
  if (synthesisBinding && (workflow !== 'auto' || template !== 'discussion')) {
    fail('ORCHESTRATION_V4_SYNTHESIS_BINDING_INVALID')
  }
  const coordinationPlan = hasOwn(input, 'coordinationPlan')
    ? normalizeCoordinationPlan(input.coordinationPlan, participantKinds, snapshotHash)
    : null
  if (coordinationPlan && (workflow !== 'auto' || template !== 'discussion')) {
    fail('ORCHESTRATION_V4_COORDINATION_PLAN_INVALID')
  }
  const discussionWriterKind = hasOwn(input, 'discussionWriterKind') ? cleanId(input.discussionWriterKind) : ''
  if (hasOwn(input, 'discussionWriterKind') && (!discussionWriterKind
      || input.discussionWriterKind !== discussionWriterKind
      || !effectiveKinds.includes(discussionWriterKind)
      || workflow !== 'auto' || template !== 'discussion'
      || !['proposal', 'discussion', 'stopped', 'failed'].includes(phase)
      || synthesisBinding || coordinationPlan || commitState.writerKind)) {
    fail('ORCHESTRATION_V4_PERMISSION_INVALID')
  }
  if (coordinationPlan) {
    validateCoordinationAgreement(
      coordinationPlan, slots, challengeBindings, participantKinds, snapshotHash,
    )
  }
  const workReceipts = hasOwn(input, 'workReceipts')
    ? (() => {
        if (!Array.isArray(input.workReceipts)
            || input.workReceipts.length > MAX_V4_ASSIGNMENTS) {
          fail('ORCHESTRATION_V4_WORK_RECEIPT_INVALID')
        }
        return input.workReceipts.map(normalizeWorkReceipt)
      })()
    : null
  if (workReceipts && (!coordinationPlan || workflow !== 'auto' || template !== 'discussion')) {
    fail('ORCHESTRATION_V4_WORK_RECEIPT_INVALID')
  }
  const synthesisRecovery = hasOwn(input, 'synthesisRecovery')
    ? normalizeSynthesisRecovery(
        input.synthesisRecovery, participantKinds, synthesisBinding, coordinationPlan, input.round,
      )
    : null
  if (synthesisRecovery && (workflow !== 'auto' || template !== 'discussion')) {
    fail('ORCHESTRATION_V4_SYNTHESIS_RECOVERY_INVALID')
  }
  const convergence = hasOwn(input, 'convergence')
    ? normalizeConvergence(input.convergence, input.round)
    : null
  if (convergence && (workflow !== 'auto' || template !== 'discussion'
      || (!synthesisBinding && !coordinationPlan))) {
    fail('ORCHESTRATION_V4_CONVERGENCE_INVALID')
  }
  const hasCompletedChallengeEvidence = completedChallengeEvidence(
    slots, participantKinds, snapshotHash, challengeBindings,
  )
  const synthesisObservable = workflow === 'auto' && template === 'discussion'
    && (synthesisStateObservable(phase, slots)
      || commitDeliveryObservable(commitState)
      || Boolean(candidateCommit))
  const completedChallengeCheckpoint = phase === 'challenge'
    && currentKinds.length === 0
    && (!Array.isArray(input.pendingKinds) || input.pendingKinds.length === 0)
    && participantKinds.every(kind => slots.some(slot => (
      slot.agentKind === kind && slot.status === 'completed'
    )))
  const retainedChallengeBinding = phase === 'challenge'
    && completedChallengeEvidence(
      slots, participantKinds, snapshotHash, challengeBindings, deliveryWatermarks, true,
    )
    && postChallengeReceiptObservable(slots, deliveryWatermarks, snapshotHash)
  if (synthesisBinding && (
    phase === 'proposal'
    || (!hasCompletedChallengeEvidence && !retainedChallengeBinding)
    || (phase === 'challenge' && !completedChallengeCheckpoint && !synthesisObservable)
  )) fail('ORCHESTRATION_V4_SYNTHESIS_BINDING_INVALID')
  if (coordinationPlan && phase === 'proposal') {
    fail('ORCHESTRATION_V4_COORDINATION_PLAN_INVALID')
  }
  const challengeObservable = workflow === 'auto' && template === 'discussion' && (
    V4_POST_SYNTHESIS_PHASES.has(phase)
    || slots.some(slot => (
      (slot.phase === 'challenge' && slot.status !== 'planned')
      || V4_POST_SYNTHESIS_PHASES.has(slot.phase)
      || (slot.resultRefs?.workflowOutcomeRefs || []).some(item => (
        item?.receipt?.phase === 'challenge'
      ))
    ))
  )
  if (challengeObservable && !challengeBindings && !coordinationPlan) {
    fail('ORCHESTRATION_V4_CHALLENGE_BINDING_REQUIRED')
  }
  if (synthesisObservable && !synthesisBinding && !coordinationPlan) {
    fail('ORCHESTRATION_V4_SYNTHESIS_BINDING_REQUIRED')
  }
  if (targetKinds && template === 'concurrent-batch'
      && ['prepare', 'dispatch', 'running', 'proposal'].includes(phase)) {
    const participating = new Set([
      ...planKinds,
      ...slots.map(slot => slot.agentKind),
    ])
    if (targetKinds.some(kind => !participating.has(kind))) {
      fail('ORCHESTRATION_V4_REFERENCE_INVALID')
    }
  }
  for (const field of [
    'pendingKinds', 'activeKinds', 'successfulKinds', 'attachmentRecipients',
  ]) {
    if (hasOwn(input, field)) uniqueIds(input[field], MAX_V4_SLOTS)
  }
  if (hasOwn(input, 'currentKind') && input.currentKind !== '') {
    fail('ORCHESTRATION_V4_REFERENCE_INVALID')
  }
  if (hasOwn(input, 'agreementKinds')
      && (!Array.isArray(input.agreementKinds) || input.agreementKinds.length !== 0)) {
    fail('ORCHESTRATION_V4_REFERENCE_INVALID')
  }
  for (const field of ['round', 'totalSuccesses']) {
    if (hasOwn(input, field) && (!Number.isSafeInteger(input[field]) || input[field] < 0)) {
      fail('ORCHESTRATION_V4_SCHEMA_INVALID')
    }
  }
  if (hasOwn(input, 'terminalFailureOccurred')
      && typeof input.terminalFailureOccurred !== 'boolean') {
    fail('ORCHESTRATION_V4_SCHEMA_INVALID')
  }
  if (hasOwn(input, 'collaboration')) {
    try {
      const { parseCollaborationState } = require('./collaboration-records.cjs')
      parseCollaborationState(input.collaboration)
    } catch {
      fail('ORCHESTRATION_V4_COLLABORATION_INVALID')
    }
  }
  if (hasOwn(input, 'taskGraph')) {
    try {
      const { parseTaskGraphCursor } = require('./task-graph-records.cjs')
      parseTaskGraphCursor(input.taskGraph, effectiveKinds)
    } catch {
      fail('ORCHESTRATION_V4_TASK_GRAPH_INVALID')
    }
  }
  const result = {
    version: 4,
    workflow,
    template,
    phase,
    ...(discussionStyle ? { discussionStyle } : {}),
    ...(discussionWriterKind ? { discussionWriterKind } : {}),
    batchId,
    currentKinds,
    activeKinds,
    snapshotHash,
    ...(snapshot ? { snapshot } : {}),
    plan,
    slots,
    deliveryWatermarks,
    ...(deliveryState.length ? { deliveryState } : {}),
    commitState,
    ...(candidateCommit ? { candidateCommit } : {}),
    ...(challengeBindings ? { challengeBindings } : {}),
    ...(synthesisBinding ? { synthesisBinding } : {}),
    ...(synthesisRecovery ? { synthesisRecovery } : {}),
    ...(convergence ? { convergence } : {}),
    ...(coordinationPlan ? { coordinationPlan } : {}),
    ...(workReceipts ? { workReceipts } : {}),
  }
  for (const key of [
    'round', 'currentKind', 'pendingKinds', 'successfulKinds',
    'agreementKinds', 'attachmentRecipients', 'totalSuccesses', 'terminalFailureOccurred',
    'collaboration', 'taskGraph',
  ]) {
    if (hasOwn(input, key)) result[key] = clone(input[key])
  }
  validateV4Relations(result, targetKinds)
  return JSON.parse(canonicalJson(result))
}

function createOrchestrationV4(input = {}, options = {}) {
  const targetKinds = Array.isArray(options.targetKinds)
    ? uniqueIds(options.targetKinds, MAX_V4_SLOTS, true)
    : uniqueIds(input.targetKinds || input.currentKinds || [], MAX_V4_SLOTS)
  const now = safeTimestamp(options.now, Date.now())
  const { workflow, template } = normalizeWorkflow(input.workflow, input.template)
  const currentKinds = uniqueIds(input.currentKinds || targetKinds, MAX_V4_SLOTS)
  const defaultSnapshotBody = {
    targetKinds,
    round: boundedInteger(input.round, 0, 100000),
  }
  const defaultSnapshotContent = canonicalJson(defaultSnapshotBody)
  const defaultSnapshotHash = hashValue(defaultSnapshotBody)
  const snapshot = input.snapshot || {
    contextPackId: null,
    taskId: null,
    round: boundedInteger(input.round, 0, 100000),
    targetKinds,
    sourceIds: [],
    capturedAt: now,
    charCount: 0,
    contentHash: defaultSnapshotHash,
    ...(template === 'discussion' ? { bodyHash: defaultSnapshotHash } : {}),
    ...(template === 'concurrent-batch' ? {
      contentRef: {
        algorithm: 'sha256',
        hash: defaultSnapshotHash,
        size: Buffer.byteLength(defaultSnapshotContent),
        mediaType: 'application/json',
      },
    } : {}),
  }
  const snapshotHash = input.snapshotHash || hashValue(snapshot)
  const batchId = cleanId(input.batchId) || `batch-${hashValue({ snapshotHash, template, now }).slice(0, 32)}`
  const phase = input.phase || (template === 'discussion' ? 'proposal' : 'prepare')
  const planInput = input.plan || {
    version: 1,
    snapshotHash,
    assignments: currentKinds.map((agentKind, index) => ({
      agentKind,
      slotId: `slot-${batchId}-${agentKind}`,
      role: ['synthesis', 'commit'].includes(phase)
        ? (index === 0 ? 'writer' : 'verifier')
        : 'primary',
      operationId: `operation-${hashValue({ batchId, agentKind }).slice(0, 32)}`,
      objective: template === 'discussion' ? 'Produce an independent bounded collaboration result.' : 'Produce an independent bounded response.',
      expectedOutput: 'Return a concise structured collaboration result.',
      inputRefs: [],
      readOnly: true,
    })),
    createdAt: now,
    barrier: 'batch',
  }
  const slots = input.slots || planInput.assignments.map((assignment, index) => ({
    slotId: assignment.slotId,
    agentKind: assignment.agentKind,
    phase,
    status: 'planned',
    operationId: assignment.operationId,
    queuePosition: index,
    snapshotHash,
    deliveryWatermark: 0,
    receiptId: '',
    resultHash: '',
    assignedAt: now,
    startedAt: now,
    finishedAt: null,
    commitStatus: 'pending',
    ...(template === 'concurrent-batch' ? {
      resultBodyArtifactId: '',
      commitId: `commit-${hashValue({ batchId, slotId: assignment.slotId }).slice(0, 64)}`,
      messageId: `message-${hashValue({ batchId, slotId: assignment.slotId }).slice(0, 64)}`,
      blackboardEntryId: '',
    } : {}),
  }))
  return parseOrchestrationV4({
    version: 4,
    workflow,
    template,
    phase,
    batchId,
    currentKinds,
    snapshotHash,
    snapshot,
    plan: planInput,
    slots,
    deliveryWatermarks: input.deliveryWatermarks || [],
    ...(hasOwn(input, 'deliveryState') ? { deliveryState: input.deliveryState } : {}),
    commitState: input.commitState || {
      status: 'pending',
      writerKind: null,
      committedKinds: [],
      pendingKinds: currentKinds,
      operationId: '',
      attempt: 0,
      updatedAt: now,
    },
    ...Object.fromEntries([...ORCHESTRATION_FIELDS]
      .filter(key => hasOwn(input, key) && ![
        'version', 'workflow', 'template', 'phase', 'batchId', 'currentKinds',
        'snapshotHash', 'snapshot', 'plan', 'slots', 'deliveryWatermarks', 'deliveryState', 'commitState',
      ].includes(key))
      .map(key => [key, input[key]])),
  }, { targetKinds, now })
}

function parseCollaborationControlBlock(input, options = {}) {
  if (input == null) return null
  if (!isRecord(input) || !exactFields(input, [
    'version', 'phase', 'agentKind', 'slotId', 'operationId', 'status',
    'summary', 'conclusion', 'artifactIds', 'evidenceIds', 'findingIds',
    'unresolved', 'deliveryWatermark', 'snapshotHash', 'receiptId',
    'claims', 'findings', 'refs', 'writer', 'writerKind', 'batchId', 'entryIds',
    'capabilities', 'intendedWork', 'deliverables', 'dependencies',
    'proposedAssignments', 'finalizerKind', 'verifierKinds', 'supportedPlanHash',
    'agreeToPlan', 'workItemId', 'taskDecision',
  ]) || input.version !== 1) {
    fail('COLLABORATION_CONTROL_BLOCK_INVALID')
  }
  const phase = String(input.phase || '')
  const status = String(input.status || '')
  if (!V4_CONTROL_KINDS.has(phase) || !V4_RECEIPT_STATUSES.has(status)) {
    fail('COLLABORATION_CONTROL_BLOCK_INVALID')
  }
  const summary = safeText(input.summary, MAX_V4_SUMMARY_CHARS, true)
  const taskDecision = input.taskDecision == null ? null : parseTaskDecision(input.taskDecision)
  if (taskDecision && phase !== 'discussion') fail('COLLABORATION_CONTROL_BLOCK_INVALID')
  const boundedList = (value, limit = MAX_V4_REFS, textLimit = MAX_V4_TEXT_CHARS) => {
    if (value == null) return []
    if (!Array.isArray(value) || value.length > limit) fail('COLLABORATION_CONTROL_BLOCK_INVALID')
    return value.map(item => safeText(item, textLimit, true))
  }
  const normalizeOptionalIds = value => boundedList(value, MAX_V4_REFS, 120)
  const conclusion = safeText(input.conclusion, MAX_V4_TEXT_CHARS, false)
  const artifactIds = normalizeOptionalIds(input.artifactIds)
  const evidenceIds = normalizeOptionalIds(input.evidenceIds)
  const findingIds = normalizeOptionalIds(input.findingIds)
  const entryIds = normalizeOptionalIds(input.entryIds)
  const claims = boundedList(input.claims, MAX_V4_REFS, MAX_V4_SUMMARY_CHARS)
  const refs = boundedList(input.refs, MAX_V4_REFS, 120)
  const capabilities = boundedList(input.capabilities, MAX_V4_SLOTS, MAX_V4_SUMMARY_CHARS)
  const intendedWork = boundedList(input.intendedWork, MAX_V4_ASSIGNMENTS, MAX_V4_SUMMARY_CHARS)
  const deliverables = boundedList(input.deliverables, MAX_V4_ASSIGNMENTS, MAX_V4_SUMMARY_CHARS)
  const dependencies = boundedList(input.dependencies, MAX_V4_ASSIGNMENTS, MAX_V4_SUMMARY_CHARS)
  if (input.proposedAssignments != null && (!Array.isArray(input.proposedAssignments)
      || input.proposedAssignments.length > MAX_V4_ASSIGNMENTS)) {
    fail('COLLABORATION_CONTROL_BLOCK_INVALID')
  }
  const proposedAssignments = (input.proposedAssignments || []).map(item => {
    if (!isRecord(item) || !exactFields(item, [
      'taskId', 'ownerKind', 'role', 'objective', 'expectedOutput',
      'inputRefs', 'artifactIds', 'dependsOn',
    ])) fail('COLLABORATION_CONTROL_BLOCK_INVALID')
    const taskId = safeText(item.taskId, 120, true)
    const ownerKind = safeText(item.ownerKind, 120, true)
    const role = safeText(item.role, 40, true)
    if (!['worker', 'integrator', 'verifier'].includes(role)) {
      fail('COLLABORATION_CONTROL_BLOCK_INVALID')
    }
    return {
      taskId,
      ownerKind,
      role,
      objective: safeText(item.objective, MAX_V4_TEXT_CHARS, true),
      expectedOutput: safeText(item.expectedOutput, MAX_V4_TEXT_CHARS, true),
      inputRefs: boundedList(item.inputRefs || [], MAX_V4_REFS, 120),
      artifactIds: boundedList(item.artifactIds || [], MAX_V4_REFS, 120),
      dependsOn: boundedList(item.dependsOn || [], MAX_V4_ASSIGNMENTS, 120),
    }
  })
  const finalizerKind = input.finalizerKind == null ? '' : safeText(input.finalizerKind, 120, false)
  const verifierKinds = boundedList(input.verifierKinds, MAX_V4_SLOTS, 120)
  const supportedPlanHash = input.supportedPlanHash == null
    ? '' : String(input.supportedPlanHash)
  const workItemId = input.workItemId == null ? '' : safeText(input.workItemId, 120, false)
  if (input.finalizerKind != null && !finalizerKind) fail('COLLABORATION_CONTROL_BLOCK_INVALID')
  if ((input.supportedPlanHash != null && !SHA256.test(supportedPlanHash))
      || (input.workItemId != null && !workItemId)) {
    fail('COLLABORATION_CONTROL_BLOCK_INVALID')
  }
  if (input.agreeToPlan != null && typeof input.agreeToPlan !== 'boolean') {
    fail('COLLABORATION_CONTROL_BLOCK_INVALID')
  }
  if (input.findings != null && (!Array.isArray(input.findings)
      || input.findings.length > MAX_V4_REFS)) {
    fail('COLLABORATION_CONTROL_BLOCK_INVALID')
  }
  const findings = (input.findings || []).map(item => {
    if (typeof item === 'string') {
      return { kind: 'observation', summary: safeText(item, MAX_V4_SUMMARY_CHARS, true) }
    }
    if (!isRecord(item) || Object.keys(item).some(key => (
      !['kind', 'summary', 'severity', 'refs'].includes(key)
    ))) {
      fail('COLLABORATION_CONTROL_BLOCK_INVALID')
    }
    const kind = safeText(item.kind || 'observation', 80, true)
    const findingSummary = safeText(item.summary, MAX_V4_SUMMARY_CHARS, true)
    const severity = item.severity == null ? '' : safeText(item.severity, 40, false)
    if (item.severity != null && !severity) fail('COLLABORATION_CONTROL_BLOCK_INVALID')
    const findingRefs = boundedList(item.refs || [], MAX_V4_REFS, 120)
    return {
      kind,
      summary: findingSummary,
      ...(severity ? { severity } : {}),
      ...(findingRefs.length ? { refs: findingRefs } : {}),
    }
  })
  if (input.unresolved != null && (!Array.isArray(input.unresolved)
      || input.unresolved.length > MAX_V4_UNRESOLVED)) {
    fail('COLLABORATION_CONTROL_BLOCK_INVALID')
  }
  const unresolved = (input.unresolved || []).map(item => {
    if (!isRecord(item) || !exactFields(item, ['id', 'summary', 'refs'])) {
      fail('COLLABORATION_CONTROL_BLOCK_INVALID')
    }
    const id = cleanId(item.id)
    if (!id) fail('COLLABORATION_CONTROL_BLOCK_INVALID')
    return {
      id,
      summary: safeText(item.summary, MAX_V4_SUMMARY_CHARS, true),
      refs: boundedList(item.refs || [], MAX_V4_REFS, 120),
    }
  })
  const hasBinding = [
    'agentKind', 'slotId', 'operationId', 'snapshotHash', 'receiptId',
  ].some(key => hasOwn(input, key))
  const agentKind = cleanId(input.agentKind)
  const slotId = cleanId(input.slotId)
  const operationId = cleanId(input.operationId)
  const snapshotHash = String(input.snapshotHash || '')
  const receiptId = cleanId(input.receiptId)
  if (hasBinding && (!agentKind || !slotId || !operationId || !SHA256.test(snapshotHash)
      || !receiptId || !receiptId.startsWith('receipt-'))) {
    fail('COLLABORATION_CONTROL_BLOCK_INVALID')
  }
  if (hasOwn(input, 'writer') && typeof input.writer !== 'boolean') {
    fail('COLLABORATION_CONTROL_BLOCK_INVALID')
  }
  if (hasOwn(input, 'writerKind') && input.writerKind !== '' && !cleanId(input.writerKind)) {
    fail('COLLABORATION_CONTROL_BLOCK_INVALID')
  }
  if (hasOwn(input, 'batchId') && input.batchId !== '' && !cleanId(input.batchId)) {
    fail('COLLABORATION_CONTROL_BLOCK_INVALID')
  }
  if (options.agentKind && options.agentKind !== agentKind) fail('COLLABORATION_CONTROL_BLOCK_SCOPE')
  if (options.slotId && options.slotId !== slotId) fail('COLLABORATION_CONTROL_BLOCK_SCOPE')
  if (options.operationId && options.operationId !== operationId) fail('COLLABORATION_CONTROL_BLOCK_SCOPE')
  const deliveryWatermark = hasOwn(input, 'deliveryWatermark')
    ? boundedInteger(input.deliveryWatermark, 0, 1000000000)
    : 0
  const block = {
    version: 1,
    phase,
    status,
    summary,
    conclusion,
    ...(taskDecision ? { taskDecision } : {}),
    artifactIds,
    evidenceIds,
    findingIds,
    unresolved,
    deliveryWatermark,
    ...(claims.length ? { claims } : {}),
    ...(findings.length ? { findings } : {}),
    ...(refs.length ? { refs } : {}),
    ...(entryIds.length ? { entryIds } : {}),
    ...(capabilities.length ? { capabilities } : {}),
    ...(intendedWork.length ? { intendedWork } : {}),
    ...(deliverables.length ? { deliverables } : {}),
    ...(dependencies.length ? { dependencies } : {}),
    ...(proposedAssignments.length ? { proposedAssignments } : {}),
    ...(finalizerKind ? { finalizerKind } : {}),
    ...(verifierKinds.length ? { verifierKinds } : {}),
    ...(supportedPlanHash ? { supportedPlanHash } : {}),
    ...(typeof input.agreeToPlan === 'boolean' ? { agreeToPlan: input.agreeToPlan } : {}),
    ...(workItemId ? { workItemId } : {}),
    ...(hasOwn(input, 'writer') ? { writer: input.writer === true } : {}),
    ...(cleanId(input.writerKind) ? { writerKind: cleanId(input.writerKind) } : {}),
    ...(cleanId(input.batchId) ? { batchId: cleanId(input.batchId) } : {}),
    ...(hasBinding ? { agentKind, slotId, operationId, snapshotHash, receiptId } : {}),
  }
  enforceCollaborationBudget(block, options)
  return JSON.parse(canonicalJson(block))
}

function collaborationChars(block) {
  if (!isRecord(block)) return 0
  return [
    block.summary,
    block.conclusion,
    ...(Array.isArray(block.unresolved) ? block.unresolved.flatMap(item => [item.summary]) : []),
    ...(Array.isArray(block.capabilities) ? block.capabilities : []),
    ...(Array.isArray(block.intendedWork) ? block.intendedWork : []),
    ...(Array.isArray(block.deliverables) ? block.deliverables : []),
    ...(Array.isArray(block.dependencies) ? block.dependencies : []),
    ...(block.taskDecision ? [block.taskDecision.reason, ...block.taskDecision.deliverables] : []),
    ...(Array.isArray(block.proposedAssignments)
      ? block.proposedAssignments.flatMap(item => [item.objective, item.expectedOutput])
      : []),
  ].filter(value => typeof value === 'string' && value.length > 0).join('\n').length
}

function enforceCollaborationBudget(value, options = {}) {
  const summaryLimit = Number.isSafeInteger(options.summaryLimit)
    ? options.summaryLimit : MAX_V4_SUMMARY_CHARS
  const totalLimit = Number.isSafeInteger(options.totalLimit)
    ? options.totalLimit : MAX_V4_TOTAL_CHARS
  const perAgent = Array.isArray(value)
    ? value
    : (Array.isArray(value?.receipts) ? value.receipts : [value])
  const total = perAgent.reduce((sum, item) => sum + collaborationChars(item), 0)
  if (perAgent.some(item => String(item?.summary || '').length > summaryLimit)
      || total > totalLimit) {
    fail('COLLABORATION_PAYLOAD_BUDGET_EXCEEDED')
  }
  return { totalChars: total, summaryLimit, totalLimit }
}

function collaborationPayloadBudget(value, options = {}) {
  try {
    return { ok: true, ...enforceCollaborationBudget(value, options) }
  } catch (error) {
    if (error?.code !== 'COLLABORATION_PAYLOAD_BUDGET_EXCEEDED') throw error
    return {
      ok: false,
      error: error.code,
      ...enforceCollaborationBudget({ summary: '', conclusion: '', unresolved: [] }, options),
    }
  }
}

function buildCollaborationPackage(receipts, options = {}) {
  if (!Array.isArray(receipts) || receipts.length > MAX_V4_SLOTS * 8) {
    fail('COLLABORATION_PACKAGE_INVALID')
  }
  const parsed = receipts.map(receipt => parseCollaborationControlBlock(receipt))
    .filter(Boolean)
  const latest = new Map()
  for (const receipt of parsed) {
    const key = receipt.agentKind || `${receipt.phase}\u0000${receipt.summary}`
    const previous = latest.get(key)
    if (!previous || receipt.deliveryWatermark > previous.deliveryWatermark
        || (receipt.deliveryWatermark === previous.deliveryWatermark
          && receipt.phase.localeCompare(previous.phase) > 0)) {
      latest.set(key, receipt)
    }
  }
  const totalLimit = Number.isSafeInteger(options.totalLimit)
    ? options.totalLimit : MAX_V4_TOTAL_CHARS
  if (!Number.isSafeInteger(totalLimit) || totalLimit < 1 || totalLimit > MAX_V4_TOTAL_CHARS) {
    fail('COLLABORATION_PACKAGE_INVALID')
  }
  const selectedKinds = Array.isArray(options.targetKinds)
    ? uniqueIds(options.targetKinds, MAX_V4_SLOTS)
    : [...new Set(parsed.map(receipt => receipt.agentKind).filter(Boolean))].sort()
  const ordered = [...latest.values()].sort((left, right) => (
    String(left.agentKind || '').localeCompare(String(right.agentKind || ''))
      || left.phase.localeCompare(right.phase)
  ))
  const byKind = new Map(ordered.filter(receipt => receipt.agentKind)
    .map(receipt => [receipt.agentKind, receipt]))
  const indexText = collaborationPackageIndexText(selectedKinds)
  if (indexText.length > totalLimit) fail('COLLABORATION_PACKAGE_INVALID')
  const lines = indexText.split('\n')
  const append = (line, reservedChars = 0) => {
    const candidate = [...lines, line].join('\n')
    if (candidate.length + reservedChars > totalLimit) return false
    lines.push(line)
    return true
  }
  const selected = []
  const summaryMembers = selectedKinds.map(kind => {
    const receipt = byKind.get(kind)
    return receipt ? { receipt, prefix: `[${receipt.phase}] agent=${kind} ` } : null
  }).filter(Boolean)
  const summaryReserve = summaryMembers.reduce((total, member) => (
    total + member.prefix.length + 2
  ), 0)
  if (lines.join('\n').length + summaryReserve > totalLimit) {
    const text = lines.join('\n')
    return {
      version: 1,
      receipts: [],
      deliveryWatermarks: [],
      text,
      packageHash: hashValue(text),
      totalChars: text.length,
    }
  }
  const artifactIds = [...new Set(ordered.flatMap(receipt => receipt.artifactIds || []))].sort()
  const evidenceIds = [...new Set(ordered.flatMap(receipt => receipt.evidenceIds || []))].sort()
  const resolvedIssueIds = new Set(Array.isArray(options.resolvedIssueIds)
    ? options.resolvedIssueIds.filter(value => typeof value === 'string')
    : [])
  const unresolved = new Map()
  for (const receipt of ordered) {
    for (const issue of receipt.unresolved || []) {
      if (!resolvedIssueIds.has(issue.id) && !unresolved.has(issue.id)) {
        unresolved.set(issue.id, issue)
      }
    }
  }
  for (const issue of [...unresolved.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    append(`Unresolved: ${issue.id} ${issue.summary}`, summaryReserve)
  }
  for (const id of artifactIds) append(`Artifact: ${id}`, summaryReserve)
  for (const id of evidenceIds) append(`Evidence: ${id}`, summaryReserve)
  const remaining = totalLimit - lines.join('\n').length - summaryMembers.reduce((total, member) => (
    total + member.prefix.length + 1
  ), 0)
  const summaryLimit = Math.min(MAX_V4_SUMMARY_CHARS, Math.max(
    1, Math.floor(remaining / Math.max(1, summaryMembers.length)),
  ))
  for (const { receipt, prefix } of summaryMembers) {
    const body = String(receipt.conclusion || receipt.summary).slice(0, Math.max(
      0,
      Math.min(MAX_V4_SUMMARY_CHARS, summaryLimit, totalLimit - lines.join('\n').length - prefix.length - 1),
    ))
    if (body && append(`${prefix}${body}`)) selected.push(receipt)
  }
  for (const receipt of ordered.filter(item => !item.agentKind)) {
    const line = `[${receipt.phase}] ${receipt.summary.slice(0, MAX_V4_SUMMARY_CHARS)}`
    if (append(line)) selected.push(receipt)
  }
  const watermarks = selected.map(receipt => ({
    agentKind: receipt.agentKind,
    phase: receipt.phase,
    watermark: receipt.deliveryWatermark,
    ...(receipt.operationId ? { operationId: receipt.operationId } : {}),
    ...(receipt.snapshotHash ? { snapshotHash: receipt.snapshotHash } : {}),
  }))
  const text = lines.join('\n')
  return {
    version: 1,
    receipts: selected,
    deliveryWatermarks: watermarks,
    text,
    packageHash: hashValue(text),
    totalChars: text.length,
  }
}

function collaborationPackageIndexText(targetKinds) {
  const kinds = uniqueIds(targetKinds || [], MAX_V4_SLOTS)
  return ['MELDWORK_V4_COLLABORATION_PACKAGE_V1', ...kinds.map(kind => `[index] ${kind}`)]
    .join('\n')
}

function parseResultCollaboration(result, options = {}) {
  if (!isRecord(result)) return null
  if (!hasOwn(result, 'collaboration')) {
    return typeof result.text === 'string'
      ? parseCollaborationText(result.text, options).collaboration
      : null
  }
  return parseCollaborationControlBlock(result.collaboration, options)
}

function parseCollaborationText(input, options = {}) {
  const text = typeof input === 'string' ? input : ''
  if (!text) return { text: '', collaboration: null }
  const marker = text.match(/\[\[MELDWORK_COLLABORATION(?:_JSON)?:(\{[\s\S]*?\})\]\]/iu)
    || text.match(/\[\[MELDWORK_COLLABORATION(?:_JSON)?\]\]([\s\S]*?)\[\[\/MELDWORK_COLLABORATION(?:_JSON)?\]\]/iu)
  if (!marker) return { text, collaboration: null }
  let value
  try {
    value = JSON.parse(marker[1])
  } catch {
    fail('COLLABORATION_CONTROL_BLOCK_INVALID')
  }
  return {
    text: text.replace(marker[0], '').replace(/\n{3,}/gu, '\n\n').trim(),
    collaboration: parseCollaborationControlBlock(value, options),
  }
}

function createCollaborationReceipt(input, options = {}) {
  const receiptInput = {
    version: 1,
    phase: input.phase,
    agentKind: input.agentKind,
    slotId: input.slotId,
    operationId: input.operationId,
    status: input.status,
    summary: input.summary,
    conclusion: input.conclusion || '',
    artifactIds: input.artifactIds || [],
    evidenceIds: input.evidenceIds || [],
    findingIds: input.findingIds || [],
    unresolved: input.unresolved || [],
    claims: input.claims || [],
    findings: input.findings || [],
    refs: input.refs || [],
    entryIds: input.entryIds || [],
    capabilities: input.capabilities || [],
    intendedWork: input.intendedWork || [],
    deliverables: input.deliverables || [],
    dependencies: input.dependencies || [],
    proposedAssignments: input.proposedAssignments || [],
    ...(input.finalizerKind ? { finalizerKind: input.finalizerKind } : {}),
    ...(input.verifierKinds ? { verifierKinds: input.verifierKinds } : {}),
    ...(input.supportedPlanHash ? { supportedPlanHash: input.supportedPlanHash } : {}),
    ...(typeof input.agreeToPlan === 'boolean' ? { agreeToPlan: input.agreeToPlan } : {}),
    ...(input.workItemId ? { workItemId: input.workItemId } : {}),
    ...(input.taskDecision ? { taskDecision: input.taskDecision } : {}),
    deliveryWatermark: input.deliveryWatermark || 0,
    snapshotHash: input.snapshotHash,
    ...(typeof input.writer === 'boolean' ? { writer: input.writer } : {}),
    ...(input.writerKind ? { writerKind: input.writerKind } : {}),
    ...(input.batchId ? { batchId: input.batchId } : {}),
  }
  receiptInput.receiptId = input.receiptId || `receipt-${hashValue(receiptInput)}`
  const block = parseCollaborationControlBlock(receiptInput, options)
  return block
}

function applyCollaborationReceipt(input, receiptInput, options = {}) {
  const orchestration = parseOrchestrationV4(input, options)
  const receipt = parseCollaborationControlBlock(receiptInput)
  const slot = orchestration.slots.find(candidate => candidate.slotId === receipt.slotId)
  if (!slot || slot.agentKind !== receipt.agentKind || slot.operationId !== receipt.operationId
      || slot.snapshotHash !== receipt.snapshotHash) {
    fail('COLLABORATION_RECEIPT_SCOPE')
  }
  const resultHash = hashValue(receipt)
  const exactReplay = slot.receiptId === receipt.receiptId
    && slot.resultHash === resultHash
    && slot.deliveryWatermark === receipt.deliveryWatermark
  if (exactReplay) return orchestration
  if (slot.receiptId || slot.resultHash) fail('COLLABORATION_RECEIPT_CONFLICT')
  if (['completed', 'failed', 'stopped', 'committed'].includes(orchestration.phase)
      || ['completed', 'partial', 'failed', 'stopped', 'timeout', 'interrupted',
        'settled', 'cancelled', 'unknown_outcome'].includes(slot.status)) {
    fail('COLLABORATION_RECEIPT_TERMINAL')
  }
  if (receipt.deliveryWatermark <= slot.deliveryWatermark) {
    fail('COLLABORATION_RECEIPT_CONFLICT')
  }
  const slotStatus = receipt.status === 'accepted' ? 'completed'
    : (receipt.status === 'continue' ? 'running'
      : (receipt.status === 'needs-review' ? 'waiting'
        : (receipt.status === 'rejected' ? 'failed' : receipt.status)))
  const slots = orchestration.slots.map(candidate => candidate.slotId === slot.slotId
    ? {
      ...candidate,
      phase: receipt.phase,
      status: slotStatus === 'queued' ? 'queued' : slotStatus,
      deliveryWatermark: receipt.deliveryWatermark,
      receiptId: receipt.receiptId,
      resultHash,
      finishedAt: ['completed', 'partial', 'failed', 'stopped', 'timeout', 'interrupted'].includes(slotStatus)
        ? safeTimestamp(options.now, candidate.finishedAt || candidate.startedAt)
        : candidate.finishedAt,
    }
    : candidate)
  const watermarks = orchestration.deliveryWatermarks.filter(item => !(
    item.agentKind === receipt.agentKind && item.phase === receipt.phase
  ))
  watermarks.push({
    agentKind: receipt.agentKind,
    phase: receipt.phase,
    watermark: receipt.deliveryWatermark,
    operationId: receipt.operationId,
    snapshotHash: receipt.snapshotHash,
    updatedAt: safeTimestamp(options.now, 0),
  })
  const allTerminal = slots.every(candidate => [
    'completed', 'partial', 'failed', 'stopped', 'timeout', 'interrupted',
    'settled', 'cancelled', 'unknown_outcome',
  ].includes(candidate.status))
  const currentKinds = slots
    .filter(candidate => ['planned', 'prepared', 'queued', 'running', 'waiting'].includes(candidate.status))
    .map(candidate => candidate.agentKind)
  const next = {
    ...orchestration,
    slots,
    currentKinds,
    deliveryWatermarks: watermarks,
    ...(allTerminal && orchestration.phase !== 'commit'
      ? { phase: orchestration.template === 'discussion' ? 'synthesis' : 'commit' }
      : {}),
  }
  return parseOrchestrationV4(next, options)
}

module.exports = {
  MAX_V4_SUMMARY_CHARS,
  MAX_V4_TOTAL_CHARS,
  ORCHESTRATION_V4_VERSION,
  ORCHESTRATION_FIELDS,
  V4_COMMIT_STATUSES,
  V4_PHASES,
  V4_RECEIPT_STATUSES,
  V4_SLOT_STATUSES,
  V4_TEMPLATES,
  appendWorkReceipt,
  applyCollaborationReceipt,
  buildCollaborationPackage,
  collaborationPackageIndexText,
  collaborationChars,
  collaborationPayloadBudget,
  candidateCommitBlackboardStatement,
  candidateCommitSinkId,
  commitDeliveryObservable,
  coordinationRecoveryKinds,
  createCollaborationReceipt,
  createCoordinationPlan,
  createOrchestrationV4,
  createSynthesisBinding,
  createWorkReceipt,
  enforceCollaborationBudget,
  hashValue,
  rankedSynthesisKinds,
  parseCollaborationControlBlock,
  parseCollaborationText,
  parseOrchestrationV4,
  parseResultCollaboration,
  resolveCoordinationConsensus,
  normalizeCollaborationControlBlock: parseCollaborationControlBlock,
  normalizeOrchestrationV4: parseOrchestrationV4,
  parseCollaborationReceipt: parseCollaborationControlBlock,
}

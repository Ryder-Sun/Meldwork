const { createHash } = require('node:crypto')
const { z } = require('zod')

const { canonicalJson } = require('./context-pack-records.cjs')
const { redactSecrets } = require('../security/secret-redaction.cjs')
const {
  applyCollaborationReceipt,
  buildCollaborationPackage,
  collaborationPackageIndexText,
  collaborationChars,
  collaborationPayloadBudget,
  createCollaborationReceipt,
  createOrchestrationV4,
  enforceCollaborationBudget,
  parseCollaborationControlBlock,
  parseCollaborationText,
  parseOrchestrationV4,
  parseResultCollaboration,
  normalizeCollaborationControlBlock,
  normalizeOrchestrationV4,
  parseCollaborationReceipt,
} = require('./orchestration-v4-records.cjs')

const COLLABORATION_STATE_VERSION = 1
const HANDOFF_VERSION = 1
const BLACKBOARD_ENTRY_VERSION = 1
const MAX_HANDOFFS = 128
const MAX_BLACKBOARD_ENTRIES = 512
const MAX_SELECTED_ENTRIES = 128
const MAX_TEXT_CHARS = 6000

const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const HANDOFF_ID = /^handoff-[a-f0-9]{64}$/
const BLACKBOARD_ENTRY_ID = /^blackboard-entry-[a-f0-9]{64}$/
const SHA256 = /^[a-f0-9]{64}$/
const ROLES = ['primary', 'reviewer', 'arbiter']
const OWNER_ROLES = [...ROLES, 'integrator', 'worker', 'verifier']
const trustedStates = new WeakSet()

function collaborationError(code) {
  return Object.assign(new Error(code), { code })
}

function fail(code) {
  throw collaborationError(code)
}

function uniqueArray(schema, max) {
  return z.array(schema).max(max).superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message: 'duplicate value' })
    }
  })
}

const publicIdSchema = z.string().regex(PUBLIC_ID)
const handoffIdSchema = z.string().regex(HANDOFF_ID)
const entryIdSchema = z.string().regex(BLACKBOARD_ENTRY_ID)
const roleSchema = z.enum(ROLES)
const ownerRoleSchema = z.enum(OWNER_ROLES)
const boundedTextSchema = z.string().min(1).max(MAX_TEXT_CHARS)
const optionalTextSchema = z.string().max(MAX_TEXT_CHARS)

const actorSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('harness') }),
  z.strictObject({
    type: z.literal('agent'),
    agentKind: publicIdSchema,
    role: roleSchema,
  }),
])

const ownerSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('harness') }),
  z.strictObject({
    type: z.literal('agent'),
    agentKind: publicIdSchema,
    role: ownerRoleSchema,
  }),
])

const destinationSchema = z.strictObject({
  agentKind: publicIdSchema,
  role: roleSchema,
})

const provenanceSchema = z.strictObject({
  runId: publicIdSchema,
  taskId: publicIdSchema,
  round: z.number().int().min(1).max(100000),
  agentRunId: publicIdSchema.nullable(),
  artifactIds: uniqueArray(publicIdSchema, 128),
  evidenceIds: uniqueArray(publicIdSchema, 128),
})

const audienceSchema = z.strictObject({
  roles: uniqueArray(roleSchema, ROLES.length),
  agentKinds: uniqueArray(publicIdSchema, 32),
}).superRefine((audience, context) => {
  if (!audience.roles.length && !audience.agentKinds.length) {
    context.addIssue({ code: 'custom', message: 'empty audience' })
  }
})

const lifecycleSchema = z.strictObject({
  state: z.enum(['active', 'resolved', 'superseded']),
  sequence: z.number().int().min(1).max(1000000),
  recordedAt: z.number().int().min(0),
  supersedesEntryId: entryIdSchema.nullable(),
})

const handoffContentFields = {
  source: actorSchema,
  destination: destinationSchema,
  objective: boundedTextSchema,
  selectedEntryIds: uniqueArray(entryIdSchema, MAX_SELECTED_ENTRIES),
  expectedOutput: boundedTextSchema,
  acceptanceCriteria: uniqueArray(boundedTextSchema, 32),
  provenance: provenanceSchema,
  createdAt: z.number().int().min(0),
}
const handoffInputSchema = z.strictObject(handoffContentFields)
const handoffRecordSchema = z.strictObject({
  handoffId: handoffIdSchema,
  version: z.literal(HANDOFF_VERSION),
  recordType: z.literal('handoff'),
  ...handoffContentFields,
})

const entryContentFields = {
  entryType: z.enum([
    'claim', 'decision', 'question', 'artifact-ref', 'evidence-ref', 'conflict',
  ]),
  subject: boundedTextSchema,
  statement: optionalTextSchema,
  value: optionalTextSchema,
  owner: ownerSchema,
  audience: audienceSchema,
  lifecycle: lifecycleSchema,
  provenance: provenanceSchema,
  refs: uniqueArray(publicIdSchema.or(entryIdSchema), 128),
}
function validateEntryRelations(entry, context) {
  if (['claim', 'decision', 'question'].includes(entry.entryType) && !entry.statement) {
    context.addIssue({ code: 'custom', path: ['statement'], message: 'statement required' })
  }
  if (entry.entryType === 'claim' && !entry.value) {
    context.addIssue({ code: 'custom', path: ['value'], message: 'claim value required' })
  }
  const requiredRefs = entry.entryType === 'conflict' ? 2
    : (['artifact-ref', 'evidence-ref'].includes(entry.entryType) ? 1 : 0)
  if (entry.refs.length < requiredRefs) {
    context.addIssue({ code: 'custom', path: ['refs'], message: 'references required' })
  }
  if (entry.entryType === 'conflict'
      && entry.refs.some(reference => !BLACKBOARD_ENTRY_ID.test(reference))) {
    context.addIssue({ code: 'custom', path: ['refs'], message: 'entry references required' })
  }
}

const entryInputSchema = z.strictObject(entryContentFields).superRefine(validateEntryRelations)
const entryRecordSchema = z.strictObject({
  entryId: entryIdSchema,
  version: z.literal(BLACKBOARD_ENTRY_VERSION),
  recordType: z.literal('blackboard-entry'),
  ...entryContentFields,
}).superRefine(validateEntryRelations)

function forbiddenField(key) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  return normalized.includes('credential')
    || normalized.includes('password')
    || normalized.includes('apikey')
    || normalized.includes('accesskey')
    || normalized.includes('token')
    || normalized.includes('secret')
    || normalized.includes('authorization')
    || normalized.includes('privatekey')
    || normalized.includes('executable')
    || normalized.includes('command')
    || normalized.includes('reasoning')
    || normalized.includes('chainofthought')
    || normalized === 'cot'
    || normalized === 'thought'
    || normalized === 'thoughts'
    || normalized.includes('tooloutput')
    || normalized.includes('sessionref')
}

function containsLocalPath(value) {
  return /(?:^|[\s("'`])\/(?!\/)[^\s"'`<>)]*/u.test(value)
    || /\b[A-Za-z]:\\(?:[^\s"'`<>]+\\)*[^\s"'`<>]*/u.test(value)
}

function assertNoForbiddenContent(value, prefix, seen = new Set()) {
  if (typeof value === 'string') {
    if (redactSecrets(value) !== value || containsLocalPath(value)) {
      fail(`${prefix}_FORBIDDEN_VALUE`)
    }
    return
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') fail(`${prefix}_SCHEMA_INVALID`)
      if (forbiddenField(key)) fail(`${prefix}_FORBIDDEN_FIELD`)
      assertNoForbiddenContent(value[key], prefix, seen)
    }
  } finally {
    seen.delete(value)
  }
}

function validated(schema, input, prefix) {
  const result = schema.safeParse(input)
  if (!result.success) fail(`${prefix}_SCHEMA_INVALID`)
  return result.data
}

function deriveId(prefix, body) {
  return `${prefix}-${createHash('sha256').update(canonicalJson(body)).digest('hex')}`
}

function createHandoffRecord(input) {
  assertNoForbiddenContent(input, 'HANDOFF')
  const content = validated(handoffInputSchema, input, 'HANDOFF')
  const body = { version: HANDOFF_VERSION, recordType: 'handoff', ...content }
  return JSON.parse(canonicalJson({ handoffId: deriveId('handoff', body), ...body }))
}

function parseHandoffRecord(input) {
  assertNoForbiddenContent(input, 'HANDOFF')
  const record = validated(handoffRecordSchema, input, 'HANDOFF')
  const { handoffId, ...body } = record
  if (deriveId('handoff', body) !== handoffId) fail('HANDOFF_ID_MISMATCH')
  return JSON.parse(canonicalJson(record))
}

function createBlackboardEntryRecord(input) {
  assertNoForbiddenContent(input, 'BLACKBOARD_ENTRY')
  const content = validated(entryInputSchema, input, 'BLACKBOARD_ENTRY')
  const body = {
    version: BLACKBOARD_ENTRY_VERSION,
    recordType: 'blackboard-entry',
    ...content,
  }
  return JSON.parse(canonicalJson({
    entryId: deriveId('blackboard-entry', body),
    ...body,
  }))
}

function parseBlackboardEntryRecord(input) {
  assertNoForbiddenContent(input, 'BLACKBOARD_ENTRY')
  const record = validated(entryRecordSchema, input, 'BLACKBOARD_ENTRY')
  const { entryId, ...body } = record
  if (deriveId('blackboard-entry', body) !== entryId) {
    fail('BLACKBOARD_ENTRY_ID_MISMATCH')
  }
  return JSON.parse(canonicalJson(record))
}

function emptyCollaborationState() {
  const state = { version: COLLABORATION_STATE_VERSION, handoffs: [], entries: [] }
  trustedStates.add(state)
  return state
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactFields(value, fields) {
  return isRecord(value)
    && Object.keys(value).length === fields.length
    && Object.keys(value).every(field => fields.includes(field))
}

function uniqueValidArray(value, validator, max) {
  return Array.isArray(value)
    && value.length <= max
    && value.every(validator)
    && new Set(value).size === value.length
}

function validActor(value) {
  if (!isRecord(value) || !['harness', 'agent'].includes(value.type)) return false
  if (value.type === 'harness') return exactFields(value, ['type'])
  return exactFields(value, ['type', 'agentKind', 'role'])
    && PUBLIC_ID.test(value.agentKind) && ROLES.includes(value.role)
}

function validOwner(value) {
  if (!isRecord(value) || !['harness', 'agent'].includes(value.type)) return false
  if (value.type === 'harness') return exactFields(value, ['type'])
  return exactFields(value, ['type', 'agentKind', 'role'])
    && PUBLIC_ID.test(value.agentKind) && OWNER_ROLES.includes(value.role)
}

function validProvenance(value) {
  return exactFields(value, [
    'runId', 'taskId', 'round', 'agentRunId', 'artifactIds', 'evidenceIds',
  ])
    && PUBLIC_ID.test(value.runId)
    && PUBLIC_ID.test(value.taskId)
    && Number.isInteger(value.round) && value.round >= 1 && value.round <= 100000
    && (value.agentRunId === null || PUBLIC_ID.test(value.agentRunId))
    && uniqueValidArray(value.artifactIds, id => PUBLIC_ID.test(id), 128)
    && uniqueValidArray(value.evidenceIds, id => PUBLIC_ID.test(id), 128)
}

function validText(value, required = true) {
  return typeof value === 'string'
    && value.length <= MAX_TEXT_CHARS
    && (!required || value.length > 0)
}

function validHandoffRecord(record) {
  if (!exactFields(record, [
    'handoffId', 'version', 'recordType', 'source', 'destination', 'objective',
    'selectedEntryIds', 'expectedOutput', 'acceptanceCriteria', 'provenance', 'createdAt',
  ])) return false
  return HANDOFF_ID.test(record.handoffId)
    && record.version === HANDOFF_VERSION
    && record.recordType === 'handoff'
    && validActor(record.source)
    && exactFields(record.destination, ['agentKind', 'role'])
    && PUBLIC_ID.test(record.destination.agentKind)
    && ROLES.includes(record.destination.role)
    && validText(record.objective)
    && uniqueValidArray(record.selectedEntryIds, id => BLACKBOARD_ENTRY_ID.test(id), MAX_SELECTED_ENTRIES)
    && validText(record.expectedOutput)
    && uniqueValidArray(record.acceptanceCriteria, value => validText(value), 32)
    && validProvenance(record.provenance)
    && Number.isInteger(record.createdAt) && record.createdAt >= 0
}

function validEntryRecord(record) {
  if (!exactFields(record, [
    'entryId', 'version', 'recordType', 'entryType', 'subject', 'statement', 'value',
    'owner', 'audience', 'lifecycle', 'provenance', 'refs',
  ])) return false
  const entryTypes = [
    'claim', 'decision', 'question', 'artifact-ref', 'evidence-ref', 'conflict',
  ]
  if (!BLACKBOARD_ENTRY_ID.test(record.entryId)
      || record.version !== BLACKBOARD_ENTRY_VERSION
      || record.recordType !== 'blackboard-entry'
      || !entryTypes.includes(record.entryType)
      || !validText(record.subject)
      || !validText(record.statement, false)
      || !validText(record.value, false)
      || !validOwner(record.owner)
      || !exactFields(record.audience, ['roles', 'agentKinds'])
      || !uniqueValidArray(record.audience.roles, role => ROLES.includes(role), ROLES.length)
      || !uniqueValidArray(record.audience.agentKinds, id => PUBLIC_ID.test(id), 32)
      || (!record.audience.roles.length && !record.audience.agentKinds.length)
      || !exactFields(record.lifecycle, [
        'state', 'sequence', 'recordedAt', 'supersedesEntryId',
      ])
      || !['active', 'resolved', 'superseded'].includes(record.lifecycle.state)
      || !Number.isInteger(record.lifecycle.sequence)
      || record.lifecycle.sequence < 1 || record.lifecycle.sequence > 1000000
      || !Number.isInteger(record.lifecycle.recordedAt) || record.lifecycle.recordedAt < 0
      || (record.lifecycle.supersedesEntryId !== null
        && !BLACKBOARD_ENTRY_ID.test(record.lifecycle.supersedesEntryId))
      || !validProvenance(record.provenance)
      || !uniqueValidArray(record.refs, id => PUBLIC_ID.test(id), 128)) return false
  if (['claim', 'decision', 'question'].includes(record.entryType) && !record.statement) return false
  if (record.entryType === 'claim' && !record.value) return false
  if (record.entryType === 'conflict') {
    return record.refs.length >= 2
      && record.refs.every(id => BLACKBOARD_ENTRY_ID.test(id))
  }
  if (['artifact-ref', 'evidence-ref'].includes(record.entryType)) {
    return record.refs.length >= 1
  }
  return true
}

function parseCollaborationState(input) {
  if (!exactFields(input, ['version', 'handoffs', 'entries'])
      || input.version !== COLLABORATION_STATE_VERSION
      || !Array.isArray(input.handoffs) || input.handoffs.length > MAX_HANDOFFS
      || !Array.isArray(input.entries) || input.entries.length > MAX_BLACKBOARD_ENTRIES
      || !input.handoffs.every(validHandoffRecord)
      || !input.entries.every(validEntryRecord)) {
    fail('COLLABORATION_STATE_SCHEMA_INVALID')
  }
  assertNoForbiddenContent(input, 'COLLABORATION_STATE')
  const handoffs = input.handoffs
  const entries = input.entries
  for (const record of handoffs) {
    const { handoffId, ...body } = record
    if (deriveId('handoff', body) !== handoffId) fail('HANDOFF_ID_MISMATCH')
  }
  for (const record of entries) {
    const { entryId, ...body } = record
    if (deriveId('blackboard-entry', body) !== entryId) {
      fail('BLACKBOARD_ENTRY_ID_MISMATCH')
    }
  }
  if (new Set(handoffs.map(record => record.handoffId)).size !== handoffs.length
      || new Set(entries.map(record => record.entryId)).size !== entries.length) {
    fail('COLLABORATION_STATE_DUPLICATE_RECORD')
  }
  const entryIds = new Set(entries.map(record => record.entryId))
  if (handoffs.some(record => record.selectedEntryIds.some(id => !entryIds.has(id)))) {
    fail('COLLABORATION_STATE_ORPHAN_HANDOFF_ENTRY')
  }
  if (entries.some(record => (
    (record.lifecycle.supersedesEntryId
      && !entryIds.has(record.lifecycle.supersedesEntryId))
    || (record.entryType === 'conflict'
      && record.refs.some(id => !entryIds.has(id)))
  ))) {
    fail('COLLABORATION_STATE_ORPHAN_ENTRY_REFERENCE')
  }
  if (entries.some((entry, index) => (
    index > 0 && entry.lifecycle.sequence <= entries[index - 1].lifecycle.sequence
  ))) {
    fail('COLLABORATION_STATE_HISTORY_INVALID')
  }
  const state = { version: input.version, handoffs: [...handoffs], entries: [...entries] }
  trustedStates.add(state)
  return state
}

function activeState(input) {
  if (!trustedStates.has(input)) return parseCollaborationState(input)
  if (!input || input.version !== COLLABORATION_STATE_VERSION
      || !Array.isArray(input.handoffs) || !Array.isArray(input.entries)
      || input.handoffs.length > MAX_HANDOFFS
      || input.entries.length > MAX_BLACKBOARD_ENTRIES) {
    fail('COLLABORATION_STATE_SCHEMA_INVALID')
  }
  return input
}

function appendHandoff(state, input) {
  const current = activeState(state)
  const handoff = createHandoffRecord(input)
  if (current.handoffs.some(record => record.handoffId === handoff.handoffId)) return current
  if (current.handoffs.length >= MAX_HANDOFFS) fail('COLLABORATION_STATE_LIMIT')
  const entryIds = new Set(current.entries.map(record => record.entryId))
  if (handoff.selectedEntryIds.some(id => !entryIds.has(id))) {
    fail('COLLABORATION_STATE_ORPHAN_HANDOFF_ENTRY')
  }
  const next = {
    ...current,
    handoffs: [...current.handoffs, handoff],
  }
  trustedStates.add(next)
  return next
}

function appendBlackboardEntry(state, input) {
  const current = activeState(state)
  const entry = createBlackboardEntryRecord(input)
  if (current.entries.some(record => record.entryId === entry.entryId)) return current
  if (current.entries.length >= MAX_BLACKBOARD_ENTRIES) fail('COLLABORATION_STATE_LIMIT')
  const lastSequence = current.entries.at(-1)?.lifecycle.sequence || 0
  const entryIds = new Set(current.entries.map(record => record.entryId))
  if (entry.lifecycle.sequence <= lastSequence
      || (entry.lifecycle.supersedesEntryId
        && !entryIds.has(entry.lifecycle.supersedesEntryId))
      || (entry.entryType === 'conflict'
        && entry.refs.some(id => !entryIds.has(id)))) {
    fail('COLLABORATION_STATE_HISTORY_INVALID')
  }
  const entries = [...current.entries, entry]
  if (entry.entryType === 'claim' && entry.lifecycle.state === 'active') {
    const conflicting = [...current.entries].reverse().find(candidate => (
      candidate.entryType === 'claim'
      && candidate.lifecycle.state === 'active'
      && candidate.subject === entry.subject
      && candidate.value !== entry.value
      && candidate.owner.type === 'agent'
      && entry.owner.type === 'agent'
      && candidate.owner.agentKind !== entry.owner.agentKind
    ))
    if (conflicting) {
      if (entries.length >= MAX_BLACKBOARD_ENTRIES) fail('COLLABORATION_STATE_LIMIT')
      entries.push(createBlackboardEntryRecord({
        entryType: 'conflict',
        subject: entry.subject,
        statement: `Conflicting claims from ${conflicting.owner.agentKind} and ${entry.owner.agentKind}.`,
        value: '',
        owner: { type: 'harness' },
        audience: { roles: [...ROLES], agentKinds: [] },
        lifecycle: {
          state: 'active',
          sequence: entry.lifecycle.sequence + 1,
          recordedAt: entry.lifecycle.recordedAt,
          supersedesEntryId: null,
        },
        provenance: entry.provenance,
        refs: [conflicting.entryId, entry.entryId],
      }))
    }
  }
  const next = {
    ...current,
    entries,
  }
  trustedStates.add(next)
  return next
}

function visibleBlackboardEntries(state, destination) {
  const current = activeState(state)
  return current.entries.filter(entry => (
    entry.lifecycle.state === 'active'
    && (entry.audience.roles.includes(destination.role)
      || entry.audience.agentKinds.includes(destination.agentKind))
  )).slice(-16)
}

function roleForIndex(index) {
  if (index <= 0) return 'primary'
  if (index === 1) return 'reviewer'
  return 'arbiter'
}

function publicCollaborationText(value, limit = MAX_TEXT_CHARS) {
  return redactSecrets(String(value || ''))
    .replace(/\bfile:\/\/\/[^\s"'`<>]+/giu, '[path]')
    .replace(/(^|[\s("'`])\/(?!\/)[^\s"'`<>)]*/gmu, '$1[path]')
    .replace(/\b[A-Za-z]:\\(?:[^\s"'`<>]+\\)*[^\s"'`<>]*/gu, '[path]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, limit)
}

const PRIVATE_FILESYSTEM_ROOT = /^\/(?:Users|home|private|var|tmp|etc|opt|Volumes|root|usr|System|Library|Applications|mnt|srv)(?:\/|$)/

function peerPathText(candidate, workspaceRoot) {
  const trailing = candidate.match(/[.,;:!?]+$/)?.[0] || ''
  const clean = trailing ? candidate.slice(0, -trailing.length) : candidate
  if (workspaceRoot && (clean === workspaceRoot || clean.startsWith(`${workspaceRoot}/`))) {
    return `${clean === workspaceRoot ? '.' : clean.slice(workspaceRoot.length + 1)}${trailing}`
  }
  if (PRIVATE_FILESYSTEM_ROOT.test(clean)) return `[path]${trailing}`
  // Routes and commands such as /api/users or /login are not local files.
  return candidate
}

// Peer-visible text for natural discussion transcripts. Unlike
// publicCollaborationText, files inside the shared workspace stay readable as
// workspace-relative paths and non-filesystem tokens (API routes, slash
// commands) are kept; other absolute local paths and secrets stay redacted.
function peerCollaborationText(value, options = {}) {
  const workspaceRoot = typeof options.workspaceRoot === 'string'
    ? options.workspaceRoot.replace(/\/+$/, '')
    : ''
  return redactSecrets(String(value || ''))
    .replace(/\bfile:\/\/(\/[^\s"'`<>]+)/giu, (_match, filePath) => peerPathText(filePath, workspaceRoot))
    .replace(/(^|[\s("'`])(\/(?!\/)[^\s"'`<>)]*)/gmu, (_match, lead, candidate) => (
      `${lead}${peerPathText(candidate, workspaceRoot)}`
    ))
    .replace(/\b[A-Za-z]:\\(?:[^\s"'`<>]+\\)*[^\s"'`<>]*/gu, '[path]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
}

function collaborationPackageText(handoff, entries) {
  const lines = [
    'MELDWORK_COLLABORATION_PACKAGE_V1',
    `Role: ${handoff.destination.role}`,
    `Objective: ${handoff.objective}`,
    `Expected output: ${handoff.expectedOutput}`,
    `Acceptance criteria: ${handoff.acceptanceCriteria.join(' | ')}`,
  ]
  if (!entries.length) {
    lines.push('Selected blackboard entries: (none)')
  } else {
    lines.push('Selected blackboard entries:')
    for (const entry of entries) {
      const refs = entry.refs.length ? ` refs=${entry.refs.join(',')}` : ''
      lines.push(
        `- ${entry.entryId} [${entry.entryType}] ${entry.subject}: ${entry.statement || entry.value}${refs}`,
      )
    }
  }
  lines.push('Use only this selected collaboration state; private reasoning and unrelated tool output are intentionally unavailable.')
  return lines.join('\n')
}

module.exports = {
  peerCollaborationText,
  BLACKBOARD_ENTRY_VERSION,
  COLLABORATION_STATE_VERSION,
  HANDOFF_VERSION,
  ROLES,
  appendBlackboardEntry,
  appendHandoff,
  collaborationPackageText,
  createBlackboardEntryRecord,
  createHandoffRecord,
  emptyCollaborationState,
  parseBlackboardEntryRecord,
  parseCollaborationState,
  parseHandoffRecord,
  publicCollaborationText,
  roleForIndex,
  visibleBlackboardEntries,
  applyCollaborationReceipt,
  buildCollaborationPackage,
  collaborationPackageIndexText,
  collaborationChars,
  collaborationPayloadBudget,
  createCollaborationReceipt,
  createOrchestrationV4,
  enforceCollaborationBudget,
  parseCollaborationControlBlock,
  parseCollaborationText,
  parseOrchestrationV4,
  parseResultCollaboration,
  normalizeCollaborationControlBlock,
  normalizeOrchestrationV4,
  parseCollaborationReceipt,
}

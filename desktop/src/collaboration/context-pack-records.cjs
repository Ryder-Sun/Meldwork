const crypto = require('node:crypto')
const { z } = require('zod')

const {
  MAX_CONTENT_BLOB_BYTES,
} = require('../attachments/content-blob-store.cjs')
const { redactSecrets } = require('../security/secret-redaction.cjs')

const CONTEXT_PACK_VERSION = 1
const DELIVERY_RECORD_VERSION = 1
const MAX_CONTEXT_PACK_RECORD_BYTES = 2 * 1024 * 1024
const MAX_DELIVERY_RECORD_BYTES = 512 * 1024
const MAX_TARGET_KINDS = 32
const MAX_SOURCES = 256
const MAX_RUNTIME_ADDITIONS = 64
const MAX_INHERITED_TASKS = 64

const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const SHA256 = /^[a-f0-9]{64}$/
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/
const CONTEXT_PACK_ID = /^context-pack-[a-f0-9]{64}$/
const DELIVERY_RECORD_ID = /^delivery-record-[a-f0-9]{64}$/

function contextRecordError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function fail(code) {
  throw contextRecordError(code)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function canonicalValue(value, seen) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('CANONICAL_JSON_INVALID')
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (typeof value !== 'object') fail('CANONICAL_JSON_INVALID')
  if (seen.has(value)) fail('CANONICAL_JSON_INVALID')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return `[${value.map(item => canonicalValue(item, seen)).join(',')}]`
    }
    if (!isPlainObject(value)) fail('CANONICAL_JSON_INVALID')
    const ownKeys = Reflect.ownKeys(value)
    if (!ownKeys.every(key => typeof key === 'string')) fail('CANONICAL_JSON_INVALID')
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (ownKeys.some(key => !descriptors[key].enumerable
        || typeof descriptors[key].get === 'function'
        || typeof descriptors[key].set === 'function')) {
      fail('CANONICAL_JSON_INVALID')
    }
    return `{${ownKeys.sort().map(key => (
      `${JSON.stringify(key)}:${canonicalValue(value[key], seen)}`
    )).join(',')}}`
  } finally {
    seen.delete(value)
  }
}

function canonicalJson(value) {
  return canonicalValue(value, new Set())
}

function uniqueArray(schema, max, message) {
  return z.array(schema).min(1).max(max).superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message })
    }
  })
}

const publicIdSchema = z.string().min(1).max(120).regex(PUBLIC_ID)
const hashSchema = z.string().length(64).regex(SHA256)
const contextPackIdSchema = z.string().length(77).regex(CONTEXT_PACK_ID)
const deliveryRecordIdSchema = z.string().length(80).regex(DELIVERY_RECORD_ID)
const agentKindsSchema = uniqueArray(publicIdSchema, MAX_TARGET_KINDS, 'duplicate target kind')
const blobRefSchema = z.strictObject({
  algorithm: z.literal('sha256'),
  hash: hashSchema,
  size: z.number().int().nonnegative().max(MAX_CONTENT_BLOB_BYTES),
  mediaType: z.string().min(3).max(127).regex(MEDIA_TYPE).optional(),
})

const sourceSchema = z.strictObject({
  type: z.enum([
    'message',
    'attachment',
    'knowledge',
    'skill',
    'workspace-file',
    'system',
    'historical-placeholder',
    'other',
  ]),
  sourceId: publicIdSchema,
  contentRef: blobRefSchema,
  contentHash: hashSchema,
  targetKinds: agentKindsSchema,
  captureMode: z.enum(['snapshot', 'live-reference']).optional(),
}).superRefine((source, context) => {
  if (source.contentHash !== source.contentRef.hash) {
    context.addIssue({ code: 'custom', path: ['contentHash'], message: 'content hash mismatch' })
  }
  if (source.captureMode === 'live-reference'
      && !['knowledge', 'skill'].includes(source.type)) {
    context.addIssue({
      code: 'custom',
      path: ['captureMode'],
      message: 'live reference source type invalid',
    })
  }
})

const packContentFields = {
  parentPackId: contextPackIdSchema.nullable(),
  taskId: publicIdSchema,
  groupId: publicIdSchema.nullable(),
  mode: z.enum(['manual', 'auto', 'direct']),
  permissionMode: z.enum(['read-only', 'workspace-write']),
  targetKinds: agentKindsSchema,
  sources: z.array(sourceSchema).max(MAX_SOURCES),
  approvedPreviewRef: blobRefSchema,
  approvedPreviewHash: hashSchema,
}

function validatePackRelations(pack, context) {
  if (pack.approvedPreviewHash !== pack.approvedPreviewRef.hash) {
    context.addIssue({
      code: 'custom',
      path: ['approvedPreviewHash'],
      message: 'approved preview hash mismatch',
    })
  }
  const targetKinds = new Set(pack.targetKinds)
  pack.sources.forEach((source, index) => {
    if (source.targetKinds.some(kind => !targetKinds.has(kind))) {
      context.addIssue({
        code: 'custom',
        path: ['sources', index, 'targetKinds'],
        message: 'source target outside pack target scope',
      })
    }
  })
}

const contextPackInputSchema = z.strictObject(packContentFields).superRefine(validatePackRelations)
const contextPackRecordSchema = z.strictObject({
  contextPackId: contextPackIdSchema,
  version: z.literal(CONTEXT_PACK_VERSION),
  recordType: z.literal('context-pack'),
  ...packContentFields,
}).superRefine(validatePackRelations)

const runtimeAdditionSchema = z.strictObject({
  type: z.enum([
    'system',
    'connector',
    'session-history',
    'attachment',
    'environment',
    'other',
  ]),
  additionId: publicIdSchema,
  contentRef: blobRefSchema,
  contentHash: hashSchema,
}).superRefine((addition, context) => {
  if (addition.contentHash !== addition.contentRef.hash) {
    context.addIssue({ code: 'custom', path: ['contentHash'], message: 'content hash mismatch' })
  }
})

const sessionProvenanceSchema = z.strictObject({
  scope: z.enum(['task', 'conversation', 'group', 'unknown-legacy', 'none']),
  reuse: z.boolean(),
  origin: z.enum(['created', 'resumed', 'migrated', 'unknown-legacy', 'none']),
  originTaskId: publicIdSchema.nullable(),
  inheritedTaskIds: z.array(publicIdSchema).max(MAX_INHERITED_TASKS),
  completeness: z.enum(['complete', 'partial', 'unknown-legacy']),
}).superRefine((provenance, context) => {
  if (new Set(provenance.inheritedTaskIds).size !== provenance.inheritedTaskIds.length) {
    context.addIssue({
      code: 'custom', path: ['inheritedTaskIds'], message: 'duplicate inherited task',
    })
  }
  if (!provenance.reuse && provenance.inheritedTaskIds.length) {
    context.addIssue({
      code: 'custom', path: ['inheritedTaskIds'], message: 'new session cannot inherit Tasks',
    })
  }
  if (provenance.reuse && ['created', 'none'].includes(provenance.origin)) {
    context.addIssue({ code: 'custom', path: ['origin'], message: 'reused session origin invalid' })
  }
  if (!provenance.reuse && !['created', 'none'].includes(provenance.origin)) {
    context.addIssue({ code: 'custom', path: ['origin'], message: 'new session origin invalid' })
  }
  if (provenance.scope === 'none' && (
    provenance.reuse || provenance.origin !== 'none' || provenance.originTaskId !== null
    || provenance.inheritedTaskIds.length
    || provenance.completeness !== 'complete'
  )) {
    context.addIssue({ code: 'custom', path: ['scope'], message: 'stateless provenance invalid' })
  }
  const unknownLegacy = provenance.scope === 'unknown-legacy'
    || provenance.origin === 'unknown-legacy'
  if (unknownLegacy !== (provenance.completeness === 'unknown-legacy')) {
    context.addIssue({
      code: 'custom',
      path: ['completeness'],
      message: 'legacy ancestry completeness invalid',
    })
  }
  if (unknownLegacy && (
    provenance.originTaskId !== null || provenance.inheritedTaskIds.length
  )) {
    context.addIssue({
      code: 'custom', path: ['originTaskId'], message: 'legacy ancestry must stay unknown',
    })
  }
  if (!unknownLegacy && provenance.scope !== 'none' && !provenance.originTaskId) {
    context.addIssue({
      code: 'custom', path: ['originTaskId'], message: 'session origin Task required',
    })
  }
  if (provenance.scope === 'task' && provenance.inheritedTaskIds.length) {
    context.addIssue({
      code: 'custom', path: ['inheritedTaskIds'], message: 'Task session cannot inherit Tasks',
    })
  }
  if (provenance.originTaskId
      && provenance.inheritedTaskIds.includes(provenance.originTaskId)) {
    context.addIssue({
      code: 'custom', path: ['inheritedTaskIds'], message: 'origin Task cannot be inherited',
    })
  }
})

const deliveryContentFields = {
  contextPackId: contextPackIdSchema,
  runId: publicIdSchema,
  agentRunId: publicIdSchema,
  agentKind: publicIdSchema,
  payloadRef: blobRefSchema,
  payloadHash: hashSchema,
  wirePayloadRef: blobRefSchema,
  wirePayloadHash: hashSchema,
  wirePayloadBytes: z.number().int().nonnegative().max(MAX_CONTENT_BLOB_BYTES),
  serialization: z.enum([
    'cli-argv-stdin-v1',
    'acp-session-prompt-v1',
    'custom-cli-argv-stdin-v1',
  ]),
  runtimeAdditions: z.array(runtimeAdditionSchema).max(MAX_RUNTIME_ADDITIONS),
  sessionProvenance: sessionProvenanceSchema,
}

function validateDeliveryRelations(delivery, context) {
  if (delivery.payloadHash !== delivery.payloadRef.hash) {
    context.addIssue({ code: 'custom', path: ['payloadHash'], message: 'payload hash mismatch' })
  }
  if (delivery.wirePayloadHash !== delivery.wirePayloadRef.hash) {
    context.addIssue({
      code: 'custom',
      path: ['wirePayloadHash'],
      message: 'wire payload reference mismatch',
    })
  }
  if (delivery.wirePayloadBytes !== delivery.wirePayloadRef.size) {
    context.addIssue({
      code: 'custom',
      path: ['wirePayloadBytes'],
      message: 'wire payload byte count mismatch',
    })
  }
  const additionIds = delivery.runtimeAdditions.map(addition => addition.additionId)
  if (new Set(additionIds).size !== additionIds.length) {
    context.addIssue({
      code: 'custom',
      path: ['runtimeAdditions'],
      message: 'duplicate runtime addition',
    })
  }
}

const deliveryInputSchema = z.strictObject(deliveryContentFields)
  .superRefine(validateDeliveryRelations)
const deliveryRecordSchema = z.strictObject({
  deliveryRecordId: deliveryRecordIdSchema,
  version: z.literal(DELIVERY_RECORD_VERSION),
  recordType: z.literal('delivery-record'),
  ...deliveryContentFields,
}).superRefine(validateDeliveryRelations)

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
    || normalized.includes('sessionref')
    || normalized === 'thought'
    || normalized === 'thoughts'
}

function assertNoForbiddenContent(value, prefix, seen = new Set()) {
  if (typeof value === 'string') {
    if (redactSecrets(value) !== value) fail(`${prefix}_FORBIDDEN_VALUE`)
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

function parseInput(value, prefix, maxBytes) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || typeof value === 'string') {
    if (typeof value === 'string' && value.length > maxBytes) fail(`${prefix}_JSON_INVALID`)
    const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value)
    if (!bytes.length || bytes.length > maxBytes) fail(`${prefix}_JSON_INVALID`)
    let parsed
    try { parsed = JSON.parse(bytes.toString('utf8')) } catch { fail(`${prefix}_JSON_INVALID`) }
    return { parsed, serialized: bytes.toString('utf8') }
  }
  return { parsed: value, serialized: null }
}

function validated(schema, value, prefix) {
  const result = schema.safeParse(value)
  if (!result.success) {
    const error = contextRecordError(`${prefix}_SCHEMA_INVALID`)
    const field = result.error.issues.find(issue => (
      issue.code === 'custom' && ['wirePayloadHash', 'wirePayloadBytes'].includes(issue.path[0])
    ))?.path[0]
    if (field) error.field = field
    throw error
  }
  return result.data
}

function deriveId(prefix, body) {
  const hash = crypto.createHash('sha256').update(canonicalJson(body)).digest('hex')
  return `${prefix}-${hash}`
}

function enforceCanonicalSize(record, prefix, maxBytes) {
  const serialized = canonicalJson(record)
  if (Buffer.byteLength(serialized) > maxBytes) fail(`${prefix}_SCHEMA_INVALID`)
  return serialized
}

function createContextPackRecord(input) {
  assertNoForbiddenContent(input, 'CONTEXT_PACK')
  const content = validated(contextPackInputSchema, input, 'CONTEXT_PACK')
  const body = {
    version: CONTEXT_PACK_VERSION,
    recordType: 'context-pack',
    ...content,
  }
  const record = {
    contextPackId: deriveId('context-pack', body),
    ...body,
  }
  if (record.parentPackId === record.contextPackId) fail('CONTEXT_PACK_SCHEMA_INVALID')
  return JSON.parse(enforceCanonicalSize(record, 'CONTEXT_PACK', MAX_CONTEXT_PACK_RECORD_BYTES))
}

function parseContextPackRecord(input) {
  const { parsed, serialized } = parseInput(
    input, 'CONTEXT_PACK', MAX_CONTEXT_PACK_RECORD_BYTES,
  )
  if (!isPlainObject(parsed)) fail('CONTEXT_PACK_SCHEMA_INVALID')
  assertNoForbiddenContent(parsed, 'CONTEXT_PACK')
  const record = validated(contextPackRecordSchema, parsed, 'CONTEXT_PACK')
  const { contextPackId, ...body } = record
  if (deriveId('context-pack', body) !== contextPackId) fail('CONTEXT_PACK_ID_MISMATCH')
  if (record.parentPackId === contextPackId) fail('CONTEXT_PACK_SCHEMA_INVALID')
  const canonical = enforceCanonicalSize(record, 'CONTEXT_PACK', MAX_CONTEXT_PACK_RECORD_BYTES)
  if (serialized !== null && serialized !== canonical) fail('CONTEXT_PACK_JSON_NOT_CANONICAL')
  return JSON.parse(canonical)
}

function createDeliveryRecord(input) {
  assertNoForbiddenContent(input, 'DELIVERY_RECORD')
  const content = validated(deliveryInputSchema, input, 'DELIVERY_RECORD')
  const body = {
    version: DELIVERY_RECORD_VERSION,
    recordType: 'delivery-record',
    ...content,
  }
  const record = {
    deliveryRecordId: deriveId('delivery-record', body),
    ...body,
  }
  return JSON.parse(enforceCanonicalSize(record, 'DELIVERY_RECORD', MAX_DELIVERY_RECORD_BYTES))
}

function parseDeliveryRecord(input) {
  const { parsed, serialized } = parseInput(
    input, 'DELIVERY_RECORD', MAX_DELIVERY_RECORD_BYTES,
  )
  if (!isPlainObject(parsed)) fail('DELIVERY_RECORD_SCHEMA_INVALID')
  assertNoForbiddenContent(parsed, 'DELIVERY_RECORD')
  const record = validated(deliveryRecordSchema, parsed, 'DELIVERY_RECORD')
  const { deliveryRecordId, ...body } = record
  if (deriveId('delivery-record', body) !== deliveryRecordId) {
    fail('DELIVERY_RECORD_ID_MISMATCH')
  }
  const canonical = enforceCanonicalSize(
    record, 'DELIVERY_RECORD', MAX_DELIVERY_RECORD_BYTES,
  )
  if (serialized !== null && serialized !== canonical) {
    fail('DELIVERY_RECORD_JSON_NOT_CANONICAL')
  }
  return JSON.parse(canonical)
}

function normalizeContextPackId(value) {
  return typeof value === 'string' && CONTEXT_PACK_ID.test(value) ? value : ''
}

function normalizeDeliveryRecordId(value) {
  return typeof value === 'string' && DELIVERY_RECORD_ID.test(value) ? value : ''
}

function normalizeSessionProvenance(value) {
  const result = sessionProvenanceSchema.safeParse(value)
  return result.success ? JSON.parse(canonicalJson(result.data)) : null
}

function serializeContextPackRecord(input) {
  return canonicalJson(parseContextPackRecord(input))
}

function serializeDeliveryRecord(input) {
  return canonicalJson(parseDeliveryRecord(input))
}

module.exports = {
  CONTEXT_PACK_VERSION,
  DELIVERY_RECORD_VERSION,
  MAX_CONTEXT_PACK_RECORD_BYTES,
  MAX_DELIVERY_RECORD_BYTES,
  canonicalJson,
  createContextPackRecord,
  createDeliveryRecord,
  normalizeContextPackId,
  normalizeDeliveryRecordId,
  normalizeSessionProvenance,
  parseContextPackRecord,
  parseDeliveryRecord,
  serializeContextPackRecord,
  serializeDeliveryRecord,
}

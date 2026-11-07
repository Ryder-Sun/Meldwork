const crypto = require('node:crypto')
const { z } = require('zod')

const { canonicalJson } = require('../collaboration/outcome-records.cjs')
const { redactSecrets } = require('../security/secret-redaction.cjs')

const HUMAN_GATE_VERSION = 1
const SYSTEM_REJECT_OPTION_ID = 'meldwork-system-reject'
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const GATE_ID = /^human-gate-[a-f0-9]{64}$/
const SHA256 = /^[a-f0-9]{64}$/
const OPTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/

function gateError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function fail(code) {
  throw gateError(code)
}

const contentRefSchema = z.strictObject({
  algorithm: z.literal('sha256'),
  hash: z.string().regex(SHA256),
  size: z.number().int().nonnegative(),
  mediaType: z.literal('application/json'),
})

const optionSchema = z.strictObject({
  optionId: z.string().regex(OPTION_ID),
  name: z.string().min(1).max(160),
  kind: z.string().min(1).max(80).regex(OPTION_ID),
})

const baseFields = {
  type: z.enum(['permission', 'budget', 'decision', 'retry', 'input']),
  runId: z.string().regex(PUBLIC_ID),
  agentRunId: z.string().regex(PUBLIC_ID),
  agentKind: z.string().regex(PUBLIC_ID),
  requestRef: contentRefSchema,
  requestHash: z.string().regex(SHA256),
  summary: z.string().min(1).max(500),
  options: z.array(optionSchema).min(1).max(16).superRefine((options, context) => {
    if (new Set(options.map(option => option.optionId)).size !== options.length) {
      context.addIssue({ code: 'custom', message: 'duplicate option ID' })
    }
  }),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
}

const decisionSchema = z.strictObject({
  status: z.enum(['approved', 'rejected']),
  optionId: z.string().regex(OPTION_ID),
  actorId: z.string().regex(PUBLIC_ID),
  decidedAt: z.string().datetime(),
  response: z.string().min(1).max(32 * 1024).optional(),
})

const gateInputSchema = z.strictObject(baseFields)
const gateRecordSchema = z.strictObject({
  gateId: z.string().regex(GATE_ID),
  version: z.literal(HUMAN_GATE_VERSION),
  recordType: z.literal('human-gate'),
  ...baseFields,
  status: z.enum(['pending', 'approved', 'rejected']),
  decision: decisionSchema.nullable(),
}).superRefine((record, context) => {
  if (record.requestHash !== record.requestRef.hash) {
    context.addIssue({ code: 'custom', path: ['requestHash'], message: 'request hash mismatch' })
  }
  if (record.status === 'pending' && record.decision !== null) {
    context.addIssue({ code: 'custom', path: ['decision'], message: 'pending gate has a decision' })
  }
  if (record.status !== 'pending' && record.decision?.status !== record.status) {
    context.addIssue({ code: 'custom', path: ['decision'], message: 'decision status mismatch' })
  }
  if (record.type === 'input' && record.decision?.status === 'approved'
      && !record.decision.response) {
    context.addIssue({ code: 'custom', path: ['decision', 'response'], message: 'input response missing' })
  }
  if (record.type !== 'input' && record.decision?.response !== undefined) {
    context.addIssue({ code: 'custom', path: ['decision', 'response'], message: 'unexpected input response' })
  }
  if (record.decision
      && !record.options.some(option => option.optionId === record.decision.optionId)
      && !(record.decision.status === 'rejected'
        && record.decision.actorId === 'meldwork-system'
        && record.decision.optionId === SYSTEM_REJECT_OPTION_ID)) {
    context.addIssue({ code: 'custom', path: ['decision', 'optionId'], message: 'unknown option' })
  }
})

function normalizeSummary(value) {
  const summary = String(value || '').trim().replace(/\s+/g, ' ')
  if (!summary || summary.length > 500 || redactSecrets(summary) !== summary) {
    fail('HUMAN_GATE_SCHEMA_INVALID')
  }
  return summary
}

function deriveGateId(body) {
  const digest = crypto.createHash('sha256').update(canonicalJson(body)).digest('hex')
  return `human-gate-${digest}`
}

function validated(schema, value) {
  const result = schema.safeParse(value)
  if (!result.success) fail('HUMAN_GATE_SCHEMA_INVALID')
  return result.data
}

function createHumanGateRecord(input) {
  const normalized = validated(gateInputSchema, {
    ...input,
    summary: normalizeSummary(input?.summary),
  })
  if (normalized.options.some(option => redactSecrets(option.optionId) !== option.optionId
      || redactSecrets(option.kind) !== option.kind
      || redactSecrets(option.name) !== option.name || /[\u0000-\u001f\u007f]/u.test(option.name))) {
    fail('HUMAN_GATE_SCHEMA_INVALID')
  }
  if (normalized.requestHash !== normalized.requestRef.hash) fail('HUMAN_GATE_SCHEMA_INVALID')
  const body = {
    version: HUMAN_GATE_VERSION,
    recordType: 'human-gate',
    ...normalized,
    status: 'pending',
    decision: null,
  }
  return Object.freeze({ gateId: deriveGateId(body), ...body })
}

function parseHumanGateRecord(input) {
  let value = input
  let serialized = null
  if (typeof input === 'string' || Buffer.isBuffer(input) || input instanceof Uint8Array) {
    const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input)
    if (!bytes.length || bytes.length > 256 * 1024) fail('HUMAN_GATE_JSON_INVALID')
    serialized = bytes.toString('utf8')
    try { value = JSON.parse(serialized) } catch { fail('HUMAN_GATE_JSON_INVALID') }
  }
  const record = validated(gateRecordSchema, value)
  const { gateId, ...body } = record
  if (deriveGateId({ ...body, status: 'pending', decision: null }) !== gateId) {
    fail('HUMAN_GATE_ID_MISMATCH')
  }
  const canonical = canonicalJson(record)
  if (serialized !== null && serialized !== canonical) fail('HUMAN_GATE_JSON_NOT_CANONICAL')
  return Object.freeze(JSON.parse(canonical))
}

function decideHumanGateRecord(recordInput, decisionInput) {
  const record = parseHumanGateRecord(recordInput)
  const decision = validated(decisionSchema, decisionInput)
  const systemReject = decision.status === 'rejected'
    && decision.actorId === 'meldwork-system'
    && decision.optionId === SYSTEM_REJECT_OPTION_ID
  if (!systemReject && !record.options.some(option => option.optionId === decision.optionId)) {
    fail('HUMAN_GATE_DECISION_INVALID')
  }
  if (record.status !== 'pending') {
    if (canonicalJson(record.decision) === canonicalJson(decision)) return record
    fail('HUMAN_GATE_ALREADY_DECIDED')
  }
  return parseHumanGateRecord({
    ...record,
    status: decision.status,
    decision,
  })
}

function publicHumanGate(recordInput) {
  const record = parseHumanGateRecord(recordInput)
  return Object.freeze({
    gateId: record.gateId,
    type: record.type,
    runId: record.runId,
    agentRunId: record.agentRunId,
    agentKind: record.agentKind,
    summary: record.summary,
    options: record.options.map(option => Object.freeze({ ...option })),
    status: record.status,
    createdAt: record.createdAt,
    ...(record.decision ? {
      decision: Object.freeze({
        status: record.decision.status,
        optionId: record.decision.optionId,
        actorId: record.decision.actorId,
        decidedAt: record.decision.decidedAt,
      }),
      decidedAt: record.decision.decidedAt,
    } : {}),
  })
}

module.exports = {
  HUMAN_GATE_VERSION,
  SYSTEM_REJECT_OPTION_ID,
  createHumanGateRecord,
  decideHumanGateRecord,
  normalizeSummary,
  parseHumanGateRecord,
  publicHumanGate,
}

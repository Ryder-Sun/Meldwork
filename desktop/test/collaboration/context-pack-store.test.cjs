const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  MAX_CONTEXT_PACK_RECORD_BYTES,
  canonicalJson,
  createContextPackRecord,
  createDeliveryRecord,
  parseContextPackRecord,
  parseDeliveryRecord,
} = require('../../src/collaboration/context-pack-records.cjs')

test('rejects clearly oversized JSON strings before creating a UTF-8 buffer', () => {
  const input = 'x'.repeat(MAX_CONTEXT_PACK_RECORD_BYTES + 1)
  const original = Buffer.from
  let copied = false
  Buffer.from = function (value, ...args) {
    if (value === input) copied = true
    return original.call(this, value, ...args)
  }
  try {
    assert.throws(() => parseContextPackRecord(input), { message: 'CONTEXT_PACK_JSON_INVALID' })
    assert.equal(copied, false)
  } finally { Buffer.from = original }
})

test('still enforces byte limits for multibyte strings below the character precheck', () => {
  const input = '你'.repeat(Math.floor(MAX_CONTEXT_PACK_RECORD_BYTES / 2))
  assert.ok(input.length < MAX_CONTEXT_PACK_RECORD_BYTES)
  assert.throws(() => parseContextPackRecord(input), { message: 'CONTEXT_PACK_JSON_INVALID' })
})

test('a JSON string at the byte limit reaches schema validation', () => {
  const input = JSON.stringify('x'.repeat(MAX_CONTEXT_PACK_RECORD_BYTES - 2))
  assert.equal(Buffer.byteLength(input), MAX_CONTEXT_PACK_RECORD_BYTES)
  assert.throws(() => parseContextPackRecord(input), { message: 'CONTEXT_PACK_SCHEMA_INVALID' })
})
const { ContextPackStore } = require('../../src/collaboration/context-pack-store.cjs')

function contentRef(value, mediaType = 'application/octet-stream') {
  const bytes = Buffer.from(value)
  return {
    algorithm: 'sha256',
    hash: crypto.createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    mediaType,
  }
}

function packInput(overrides = {}) {
  const sourceRef = contentRef('source message', 'text/plain')
  const previewRef = contentRef('approved preview', 'text/plain')
  return {
    parentPackId: null,
    taskId: 'task-1',
    groupId: 'group-1',
    mode: 'manual',
    permissionMode: 'read-only',
    targetKinds: ['codex', 'hermes'],
    sources: [{
      type: 'message',
      sourceId: 'message-1',
      contentRef: sourceRef,
      contentHash: sourceRef.hash,
      targetKinds: ['codex', 'hermes'],
      captureMode: 'snapshot',
    }],
    approvedPreviewRef: previewRef,
    approvedPreviewHash: previewRef.hash,
    ...overrides,
  }
}

function deliveryInput(contextPackId, overrides = {}) {
  const payloadRef = contentRef('{"prompt":"approved preview"}', 'application/json')
  const wirePayloadRef = contentRef('{"args":["--prompt","approved preview"]}', 'application/json')
  const additionRef = contentRef('connector system wrapper', 'text/plain')
  return {
    contextPackId,
    runId: 'run-1',
    agentRunId: 'agent-run-1',
    agentKind: 'codex',
    payloadRef,
    payloadHash: payloadRef.hash,
    wirePayloadRef,
    wirePayloadHash: wirePayloadRef.hash,
    wirePayloadBytes: wirePayloadRef.size,
    serialization: 'cli-argv-stdin-v1',
    runtimeAdditions: [{
      type: 'connector',
      additionId: 'connector-wrapper-1',
      contentRef: additionRef,
      contentHash: additionRef.hash,
    }],
    sessionProvenance: {
      scope: 'conversation',
      reuse: true,
      origin: 'resumed',
      originTaskId: 'task-origin',
      inheritedTaskIds: ['task-previous'],
      completeness: 'partial',
    },
    ...overrides,
  }
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-context-packs-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const rootPath = path.join(directory, 'private', 'context-packs')
  return { directory, rootPath, store: new ContextPackStore({ rootPath }) }
}

function recordPath(rootPath, category, id) {
  const hash = id.slice(id.lastIndexOf('-') + 1)
  return path.join(rootPath, category, hash.slice(0, 2), `${id}.json`)
}

test('derives stable Context Pack IDs from canonical bounded content', () => {
  const record = createContextPackRecord(packInput())
  const reordered = createContextPackRecord({
    approvedPreviewHash: packInput().approvedPreviewHash,
    approvedPreviewRef: packInput().approvedPreviewRef,
    sources: packInput().sources,
    targetKinds: packInput().targetKinds,
    permissionMode: 'read-only',
    mode: 'manual',
    groupId: 'group-1',
    taskId: 'task-1',
    parentPackId: null,
  })
  const { contextPackId, ...body } = record
  const expectedHash = crypto.createHash('sha256').update(canonicalJson(body)).digest('hex')

  assert.equal(contextPackId, `context-pack-${expectedHash}`)
  assert.deepEqual(reordered, record)
  assert.deepEqual(parseContextPackRecord(canonicalJson(record)), record)
  const { version, ...remainingRecord } = record
  assert.throws(
    () => parseContextPackRecord(JSON.stringify({ version, ...remainingRecord })),
    { message: 'CONTEXT_PACK_JSON_NOT_CANONICAL' },
  )
})

test('supports parent packs and rejects forged content-derived IDs', () => {
  const parent = createContextPackRecord(packInput())
  const child = createContextPackRecord(packInput({
    parentPackId: parent.contextPackId,
    taskId: 'task-2',
  }))

  assert.equal(child.parentPackId, parent.contextPackId)
  assert.notEqual(child.contextPackId, parent.contextPackId)
  assert.throws(
    () => parseContextPackRecord({ ...child, taskId: 'task-forged' }),
    { message: 'CONTEXT_PACK_ID_MISMATCH' },
  )
})

test('distinguishes immutable snapshots from explicit live references', () => {
  const knowledgeRef = contentRef('live knowledge coordinates', 'application/json')
  const liveKnowledge = createContextPackRecord(packInput({
    sources: [{
      type: 'knowledge',
      sourceId: 'knowledge-1',
      contentRef: knowledgeRef,
      contentHash: knowledgeRef.hash,
      targetKinds: ['codex'],
      captureMode: 'live-reference',
    }],
  }))

  assert.equal(liveKnowledge.sources[0].captureMode, 'live-reference')
  assert.throws(() => createContextPackRecord(packInput({
    sources: [{ ...packInput().sources[0], captureMode: 'live-reference' }],
  })), { message: 'CONTEXT_PACK_SCHEMA_INVALID' })
  assert.throws(() => createContextPackRecord(packInput({
    sources: [{ ...packInput().sources[0], captureMode: 'unknown' }],
  })), { message: 'CONTEXT_PACK_SCHEMA_INVALID' })
})

test('creates per-Agent delivery records with exact payload and Session provenance', () => {
  const pack = createContextPackRecord(packInput())
  const delivery = createDeliveryRecord(deliveryInput(pack.contextPackId))
  const { deliveryRecordId, ...body } = delivery
  const expectedHash = crypto.createHash('sha256').update(canonicalJson(body)).digest('hex')

  assert.equal(deliveryRecordId, `delivery-record-${expectedHash}`)
  assert.equal(delivery.payloadHash, delivery.payloadRef.hash)
  assert.equal(delivery.wirePayloadHash, delivery.wirePayloadRef.hash)
  assert.equal(delivery.wirePayloadBytes, delivery.wirePayloadRef.size)
  assert.equal(delivery.serialization, 'cli-argv-stdin-v1')
  assert.equal(delivery.runtimeAdditions[0].contentHash, delivery.runtimeAdditions[0].contentRef.hash)
  assert.deepEqual(delivery.sessionProvenance, {
    scope: 'conversation',
    reuse: true,
    origin: 'resumed',
    originTaskId: 'task-origin',
    inheritedTaskIds: ['task-previous'],
    completeness: 'partial',
  })
  assert.deepEqual(parseDeliveryRecord(canonicalJson(delivery)), delivery)
})

test('requires explicit unknown legacy provenance instead of inventing complete ancestry', () => {
  const pack = createContextPackRecord(packInput())
  const legacy = createDeliveryRecord(deliveryInput(pack.contextPackId, {
    sessionProvenance: {
      scope: 'unknown-legacy',
      reuse: true,
      origin: 'unknown-legacy',
      originTaskId: null,
      inheritedTaskIds: [],
      completeness: 'unknown-legacy',
    },
  }))
  assert.equal(legacy.sessionProvenance.completeness, 'unknown-legacy')

  assert.throws(() => createDeliveryRecord(deliveryInput(pack.contextPackId, {
    sessionProvenance: {
      scope: 'unknown-legacy',
      reuse: true,
      origin: 'unknown-legacy',
      originTaskId: null,
      inheritedTaskIds: [],
      completeness: 'complete',
    },
  })), { message: 'DELIVERY_RECORD_SCHEMA_INVALID' })
})

test('rejects unknown, credential, executable, raw command, and reasoning fields', () => {
  const pack = createContextPackRecord(packInput())

  assert.throws(
    () => parseContextPackRecord({ ...pack, arbitrary: true }),
    { message: 'CONTEXT_PACK_SCHEMA_INVALID' },
  )
  assert.throws(
    () => createContextPackRecord({ ...packInput(), credentials: { token: 'secret' } }),
    { message: 'CONTEXT_PACK_FORBIDDEN_FIELD' },
  )
  assert.throws(() => createContextPackRecord(packInput({
    sources: [{ ...packInput().sources[0], executablePath: '/Applications/Agent' }],
  })), { message: 'CONTEXT_PACK_FORBIDDEN_FIELD' })
  assert.throws(() => createDeliveryRecord({
    ...deliveryInput(pack.contextPackId),
    rawCommand: 'agent --resume secret',
  }), { message: 'DELIVERY_RECORD_FORBIDDEN_FIELD' })
  assert.throws(() => createDeliveryRecord({
    ...deliveryInput(pack.contextPackId),
    privateChainOfThought: 'hidden reasoning',
  }), { message: 'DELIVERY_RECORD_FORBIDDEN_FIELD' })
})

test('delivery records accept token counts while still rejecting credential fields', () => {
  const pack = createContextPackRecord(packInput())
  const delivery = createDeliveryRecord(deliveryInput(pack.contextPackId, {
    inputTokenCount: 42, outputTokenCount: 7,
  }))
  assert.equal(delivery.inputTokenCount, 42)
  assert.equal(delivery.outputTokenCount, 7)
  assert.deepEqual(parseDeliveryRecord(canonicalJson(delivery)), delivery)
  for (const field of ['inputTokenCount', 'outputTokenCount']) {
    assert.throws(() => createDeliveryRecord(deliveryInput(pack.contextPackId, {
      [field]: 'synthetic-secret',
    })), { message: 'DELIVERY_RECORD_SCHEMA_INVALID' })
  }
  for (const field of ['accessToken', 'API_KEY', 'refresh_token', 'privateKey', 'rawCommand']) {
    assert.throws(() => createDeliveryRecord(deliveryInput(pack.contextPackId, {
      [field]: 'synthetic-secret',
    })), { message: 'DELIVERY_RECORD_FORBIDDEN_FIELD' }, field)
  }
  for (const field of ['commandHistoryCount', 'tokenizerVersion', 'apiKeyboard']) {
    assert.throws(() => createDeliveryRecord(deliveryInput(pack.contextPackId, {
      [field]: 2,
    })), { message: 'DELIVERY_RECORD_SCHEMA_INVALID' }, field)
  }
})

test('enforces collection bounds, uniqueness, target scope, and matching hashes', () => {
  assert.throws(() => createContextPackRecord(packInput({
    targetKinds: Array.from({ length: 33 }, (_, index) => `agent-${index}`),
  })), { message: 'CONTEXT_PACK_SCHEMA_INVALID' })
  assert.throws(() => createContextPackRecord(packInput({
    targetKinds: ['codex', 'codex'],
  })), { message: 'CONTEXT_PACK_SCHEMA_INVALID' })
  assert.throws(() => createContextPackRecord(packInput({
    sources: [{ ...packInput().sources[0], targetKinds: ['qwen'] }],
  })), { message: 'CONTEXT_PACK_SCHEMA_INVALID' })
  assert.throws(() => createContextPackRecord(packInput({
    approvedPreviewHash: '0'.repeat(64),
  })), { message: 'CONTEXT_PACK_SCHEMA_INVALID' })
  const pack = createContextPackRecord(packInput())
  assert.throws(() => createDeliveryRecord(deliveryInput(pack.contextPackId, {
    wirePayloadHash: '0'.repeat(64),
  })), { message: 'DELIVERY_RECORD_SCHEMA_INVALID', field: 'wirePayloadHash' })
  assert.throws(() => createDeliveryRecord(deliveryInput(pack.contextPackId, {
    wirePayloadBytes: 1,
  })), { message: 'DELIVERY_RECORD_SCHEMA_INVALID', field: 'wirePayloadBytes' })
})

test('roundtrips immutable Context Packs and Delivery Records with private canonical files', {
  skip: process.platform === 'win32',
}, (t) => {
  const { rootPath, store } = fixture(t)
  const parent = store.put(packInput())
  const child = store.put(packInput({ parentPackId: parent.contextPackId, taskId: 'task-2' }))
  const delivery = store.putDelivery(deliveryInput(child.contextPackId))
  const packFilename = recordPath(rootPath, 'context-packs', child.contextPackId)
  const deliveryFilename = recordPath(rootPath, 'deliveries', delivery.deliveryRecordId)

  assert.deepEqual(store.get(parent.contextPackId), parent)
  assert.deepEqual(store.get(child.contextPackId), child)
  assert.deepEqual(store.getDelivery(delivery.deliveryRecordId), delivery)
  assert.equal(fs.readFileSync(packFilename, 'utf8'), canonicalJson(child))
  assert.equal(fs.readFileSync(deliveryFilename, 'utf8'), canonicalJson(delivery))
  assert.equal(fs.statSync(rootPath).mode & 0o777, 0o700)
  assert.equal(fs.statSync(path.dirname(packFilename)).mode & 0o777, 0o700)
  assert.equal(fs.statSync(packFilename).mode & 0o777, 0o600)
  assert.equal(fs.statSync(deliveryFilename).mode & 0o777, 0o600)

  const restarted = new ContextPackStore({ rootPath })
  assert.deepEqual(restarted.get(child.contextPackId), child)
  assert.deepEqual(restarted.getDelivery(delivery.deliveryRecordId), delivery)
})

test('deduplicates exact records but never overwrites a tampered write-once path', (t) => {
  const { rootPath, store } = fixture(t)
  const input = packInput()
  const record = store.put(input)
  const filename = recordPath(rootPath, 'context-packs', record.contextPackId)
  const before = fs.statSync(filename)

  assert.deepEqual(store.put(input), record)
  const after = fs.statSync(filename)
  assert.equal(after.ino, before.ino)
  assert.equal(after.mtimeMs, before.mtimeMs)

  fs.writeFileSync(filename, '{}', { mode: 0o600 })
  assert.throws(() => store.put(input), { message: 'CONTEXT_PACK_TAMPERED' })
  assert.equal(fs.readFileSync(filename, 'utf8'), '{}')
  assert.equal(fs.readdirSync(path.dirname(filename)).some(name => name.startsWith('.tmp-')), false)
})

test('rejects identifier traversal, symlink roots, and symlink record files', {
  skip: process.platform === 'win32',
}, (t) => {
  const { directory, rootPath, store } = fixture(t)
  assert.throws(
    () => store.get('../context-pack-' + 'a'.repeat(64)),
    { message: 'CONTEXT_PACK_ID_INVALID' },
  )

  const realRoot = path.join(directory, 'real-record-root')
  const rootLink = path.join(directory, 'record-root-link')
  fs.mkdirSync(realRoot)
  fs.symlinkSync(realRoot, rootLink)
  assert.throws(
    () => new ContextPackStore({ rootPath: rootLink }),
    { message: 'CONTEXT_PACK_STORE_ROOT_UNSAFE' },
  )

  const record = store.put(packInput())
  const filename = recordPath(rootPath, 'context-packs', record.contextPackId)
  const outside = path.join(directory, 'outside-record.json')
  fs.writeFileSync(outside, canonicalJson(record))
  fs.unlinkSync(filename)
  fs.symlinkSync(outside, filename)
  assert.throws(() => store.get(record.contextPackId), { message: 'CONTEXT_PACK_TAMPERED' })
  assert.equal(fs.readFileSync(outside, 'utf8'), canonicalJson(record))
})

test('rejects non-canonical or modified stored records as tampered', (t) => {
  const { rootPath, store } = fixture(t)
  const record = store.put(packInput())
  const filename = recordPath(rootPath, 'context-packs', record.contextPackId)
  const { version, ...remainingRecord } = record
  fs.writeFileSync(filename, JSON.stringify({ version, ...remainingRecord }), { mode: 0o600 })

  assert.throws(() => store.get(record.contextPackId), { message: 'CONTEXT_PACK_TAMPERED' })
})

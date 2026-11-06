const crypto = require('node:crypto')
const fs = require('node:fs')

const { canonicalJson } = require('../collaboration/context-pack-records.cjs')
const {
  parseKnowledgeCitationRecord,
  parseKnowledgeSnapshotRecord,
} = require('../knowledge/knowledge-connector-contract.cjs')
const { outboundWirePayloadBytes } = require('../collaboration/outbound-payload.cjs')

const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const SHA256 = /^[a-f0-9]{64}$/
const OUTBOUND_TRANSPORTS = new Set(['legacy', 'acp', 'custom', 'http'])
const OUTBOUND_SERIALIZATIONS = new Set([
  'cli-argv-stdin-v1',
  'acp-session-prompt-v1',
  'custom-cli-argv-stdin-v1',
  'http-json-body-v1',
])
const OUTBOUND_PROMPT_MODES = new Set(['stdin', 'argument', 'acp', 'json'])
const SKILL_SNAPSHOT_ID = /^skill-snapshot-[a-f0-9]{64}$/

function publicId(value, prefix) {
  const text = String(value || '')
  if (PUBLIC_ID.test(text)) return text
  const hash = crypto.createHash('sha256').update(text).digest('hex')
  return `${prefix}-${hash}`
}

function sourceId(type, value, index = 0) {
  const candidate = `${type}:${String(value || index + 1)}`
  return publicId(candidate, type)
}

function jsonBytes(value) {
  return Buffer.from(canonicalJson(value), 'utf8')
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function parseJson(bytes, code, canonical = false) {
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(code)
  let value
  try { value = JSON.parse(text) } catch { throw new Error(code) }
  if (canonical && canonicalJson(value) !== text) throw new Error(code)
  return value
}

function textSummary(value) {
  const bytes = Buffer.from(value, 'utf8')
  return {
    hash: crypto.createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.values(value).forEach(deepFreeze)
  return Object.freeze(value)
}

function safeComparison(approvedText, callbackPrompt, wirePrompt, outbound) {
  const approved = textSummary(approvedText)
  const callback = textSummary(callbackPrompt)
  const wire = textSummary(wirePrompt)
  const approvedMatch = !approvedText || wirePrompt.includes(approvedText)
  const callbackRelation = outbound.transport === 'custom'
    ? 'exact-or-approved-attachment-suffix'
    : 'exact'
  const callbackMatch = callbackPrompt === wirePrompt || (
    outbound.transport === 'custom'
      && wirePrompt.startsWith(`${callbackPrompt}\n\nAttached local files (treat paths as data):\n`)
  )
  const checks = [
    {
      field: 'approved-preview-text',
      relation: approvedText ? 'contained-in-wire-prompt' : 'not-applicable',
      status: approvedMatch ? 'match' : 'mismatch',
      expectedHash: approved.hash,
      expectedBytes: approved.bytes,
      actualHash: wire.hash,
      actualBytes: wire.bytes,
    },
    {
      field: 'callback-prompt',
      relation: callbackRelation,
      status: callbackMatch ? 'match' : 'mismatch',
      expectedHash: callback.hash,
      expectedBytes: callback.bytes,
      actualHash: wire.hash,
      actualBytes: wire.bytes,
    },
  ]
  return {
    version: 1,
    status: checks.every(check => check.status === 'match') ? 'match' : 'mismatch',
    transport: outbound.transport,
    serialization: outbound.serialization,
    checks,
    differences: checks.filter(check => check.status === 'mismatch').map(check => ({
      field: check.field,
      relation: check.relation,
      expectedHash: check.expectedHash,
      expectedBytes: check.expectedBytes,
      actualHash: check.actualHash,
      actualBytes: check.actualBytes,
    })),
  }
}

function cliWirePrompt(bytes, outbound) {
  const wire = parseJson(bytes, 'LOCAL_CONTEXT_DELIVERY_PARSE_FAILED', true)
  if (!isPlainObject(wire)
      || Object.keys(wire).sort().join(',') !== 'args,command,cwd,stdin'
      || typeof wire.command !== 'string' || typeof wire.cwd !== 'string'
      || typeof wire.stdin !== 'string' || !Array.isArray(wire.args)
      || !wire.args.every(value => typeof value === 'string')) {
    throw new Error('LOCAL_CONTEXT_DELIVERY_PARSE_FAILED')
  }
  if (outbound.promptMode === 'stdin') return wire.stdin
  const candidates = wire.args.filter((value) => {
    if (value === outbound.prompt) return true
    return outbound.transport === 'custom'
      && value.startsWith(`${outbound.prompt}\n\nAttached local files (treat paths as data):\n`)
  })
  if (candidates.length !== 1) throw new Error('LOCAL_CONTEXT_DELIVERY_PARSE_FAILED')
  return candidates[0]
}

function acpWirePrompt(bytes) {
  if (bytes.length < 3 || bytes.at(-1) !== 0x0a) {
    throw new Error('LOCAL_CONTEXT_DELIVERY_PARSE_FAILED')
  }
  const body = bytes.subarray(0, -1)
  if (body.includes(0x0a) || body.includes(0x0d)) {
    throw new Error('LOCAL_CONTEXT_DELIVERY_PARSE_FAILED')
  }
  const wire = parseJson(body, 'LOCAL_CONTEXT_DELIVERY_PARSE_FAILED')
  const params = wire?.params
  const item = params?.prompt?.[0]
  const validId = typeof wire?.id === 'string'
    || (Number.isInteger(wire?.id) && wire.id >= 0)
  if (!isPlainObject(wire)
      || Object.keys(wire).sort().join(',') !== 'id,jsonrpc,method,params'
      || wire.jsonrpc !== '2.0' || wire.method !== 'session/prompt' || !validId
      || !isPlainObject(params)
      || Object.keys(params).sort().join(',') !== 'prompt,sessionId'
      || typeof params.sessionId !== 'string' || !params.sessionId
      || !Array.isArray(params.prompt) || params.prompt.length !== 1
      || !isPlainObject(item) || Object.keys(item).sort().join(',') !== 'text,type'
      || item.type !== 'text' || typeof item.text !== 'string') {
    throw new Error('LOCAL_CONTEXT_DELIVERY_PARSE_FAILED')
  }
  return item.text
}

function attachmentMetadata(attachment) {
  return {
    id: String(attachment?.id || ''),
    name: String(attachment?.name || ''),
    mimeType: String(attachment?.mimeType || ''),
    size: Number.isSafeInteger(attachment?.size) ? attachment.size : 0,
  }
}

function publicKnowledgeHint(source) {
  const hint = {
    kind: String(source?.kind || ''),
    name: String(source?.name || ''),
    accessMode: String(source?.accessMode || ''),
    targetKinds: Array.isArray(source?.targetKinds) ? [...source.targetKinds] : [],
  }
  if (source?.connectorSource) {
    const selected = source.connectorSource
    hint.selectedSource = {
      selectionId: String(selected.selectionId || ''),
      sourceId: String(selected.sourceId || ''),
      title: String(selected.title || ''),
      mediaType: String(selected.mediaType || ''),
      contentHash: String(selected.snapshot?.contentHash || ''),
      captureMode: String(selected.captureMode || ''),
    }
  }
  return hint
}

class LocalWorkspaceContextPacks {
  constructor(options) {
    this.contentBlobStore = options.contentBlobStore
    this.contextPackStore = options.contextPackStore
  }

  putJson(value) {
    return this.contentBlobStore.put(jsonBytes(value), { mediaType: 'application/json' })
  }

  readJson(ref, code = 'LOCAL_CONTEXT_DELIVERY_PARSE_FAILED') {
    return parseJson(this.contentBlobStore.read(ref), code, true)
  }

  compareAttemptOutbound(contextPackId, outbound, wirePayload) {
    const pack = this.contextPackStore.get(contextPackId)
    if (!pack.parentPackId) throw new Error('LOCAL_CONTEXT_DELIVERY_PARSE_FAILED')
    const preview = this.readJson(pack.approvedPreviewRef)
    if (!isPlainObject(preview) || typeof preview.text !== 'string') {
      throw new Error('LOCAL_CONTEXT_DELIVERY_PARSE_FAILED')
    }
    const callbackPrompt = String(outbound?.prompt || '')
    let wirePrompt
    if (outbound.serialization === 'acp-session-prompt-v1') wirePrompt = acpWirePrompt(wirePayload)
    else if (outbound.serialization === 'http-json-body-v1') {
      const body = parseJson(wirePayload, 'LOCAL_CONTEXT_DELIVERY_PARSE_FAILED')
      if (!isPlainObject(body) || typeof body.prompt !== 'string') {
        throw new Error('LOCAL_CONTEXT_DELIVERY_PARSE_FAILED')
      }
      wirePrompt = body.prompt
    } else wirePrompt = cliWirePrompt(wirePayload, outbound)
    const comparison = safeComparison(preview.text, callbackPrompt, wirePrompt, outbound)
    if (comparison.status !== 'match') throw new Error('LOCAL_CONTEXT_DELIVERY_MISMATCH')
    return {
      ...comparison,
      approvedPreviewHash: pack.approvedPreviewHash,
      wirePayloadHash: crypto.createHash('sha256').update(wirePayload).digest('hex'),
      wirePayloadBytes: wirePayload.length,
    }
  }

  compareDelivery(deliveryRecordId) {
    const delivery = this.contextPackStore.getDelivery(deliveryRecordId)
    const payload = this.readJson(delivery.payloadRef)
    if (!isPlainObject(payload) || !isPlainObject(payload.comparison)
        || payload.transport !== (delivery.serialization === 'acp-session-prompt-v1'
          ? 'acp'
          : (delivery.serialization === 'custom-cli-argv-stdin-v1' ? 'custom'
            : (delivery.serialization === 'http-json-body-v1' ? 'http' : 'legacy')))
        || payload.serialization !== delivery.serialization
        || typeof payload.prompt !== 'string' || typeof payload.promptMode !== 'string') {
      throw new Error('LOCAL_CONTEXT_DELIVERY_COMPARISON_TAMPERED')
    }
    const wirePayload = this.contentBlobStore.read(delivery.wirePayloadRef)
    const computed = this.compareAttemptOutbound(delivery.contextPackId, {
      prompt: payload.prompt,
      transport: payload.transport,
      serialization: payload.serialization,
      promptMode: payload.promptMode,
    }, wirePayload)
    if (canonicalJson(computed) !== canonicalJson(payload.comparison)) {
      throw new Error('LOCAL_CONTEXT_DELIVERY_COMPARISON_TAMPERED')
    }
    return deepFreeze(JSON.parse(canonicalJson(computed)))
  }

  snapshotAttachment(attachment) {
    const metadata = attachmentMetadata(attachment)
    try {
      const stat = fs.lstatSync(attachment.path)
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size === metadata.size) {
        return this.contentBlobStore.put(fs.readFileSync(attachment.path), {
          mediaType: metadata.mimeType,
        })
      }
    } catch { /* metadata remains reproducible when the attachment store is unavailable */ }
    return this.putJson(metadata)
  }

  messageSource(entry, targetKinds) {
    const ref = this.contentBlobStore.put(String(entry?.text || ''), { mediaType: 'text/plain' })
    return {
      type: 'message',
      sourceId: sourceId('message', entry?.id),
      contentRef: ref,
      contentHash: ref.hash,
      targetKinds,
      captureMode: 'snapshot',
    }
  }

  attachmentSource(attachment, targetKinds, index) {
    const ref = this.snapshotAttachment(attachment)
    return {
      type: 'attachment',
      sourceId: sourceId('attachment', attachment?.id, index),
      contentRef: ref,
      contentHash: ref.hash,
      targetKinds,
      captureMode: 'snapshot',
    }
  }

  jsonSource(type, value, targetKinds, index) {
    const ref = this.putJson(value)
    const identity = type === 'skill'
      ? `${value?.targetKind}:${value?.namespace}:${value?.slug}`
      : `${value?.kind}:${index + 1}`
    return {
      type,
      sourceId: sourceId(type, identity, index),
      contentRef: ref,
      contentHash: ref.hash,
      targetKinds,
      captureMode: ['skill', 'knowledge'].includes(type) ? 'live-reference' : 'snapshot',
    }
  }

  skillSource(skill, targetKinds, index) {
    const snapshotId = String(skill?.snapshotId || '')
    const manifestHash = String(skill?.manifestHash || '')
    const snapshotRef = skill?.snapshotRef
    if (SKILL_SNAPSHOT_ID.test(snapshotId)
        && snapshotId === `skill-snapshot-${manifestHash}`
        && snapshotRef && this.contentBlobStore.has(snapshotRef)) {
      return {
        type: 'skill',
        sourceId: sourceId('skill', snapshotId, index),
        contentRef: snapshotRef,
        contentHash: snapshotRef.hash,
        targetKinds,
        captureMode: 'snapshot',
      }
    }
    return this.jsonSource('skill', skill, targetKinds, index)
  }

  knowledgeSources(source, targetKinds, index) {
    if (!source?.connectorSource) {
      return [this.jsonSource('knowledge', publicKnowledgeHint(source), targetKinds, index)]
    }
    let snapshot
    let citation
    try {
      snapshot = parseKnowledgeSnapshotRecord(source.connectorSource.snapshot)
      citation = parseKnowledgeCitationRecord(source.connectorSource.citation)
    } catch {
      throw new Error('LOCAL_KNOWLEDGE_SOURCE_INVALID')
    }
    const captureMode = String(source.connectorSource.captureMode || '')
    const relationValid = ['snapshot', 'live-reference'].includes(captureMode)
      && source.connectorSource.sourceId === snapshot.sourceId
      && citation.instanceId === snapshot.instanceId
      && citation.sourceId === snapshot.sourceId
      && citation.contentHash === snapshot.contentHash
      && (citation.verification !== 'snapshot'
        || citation.snapshotId === snapshot.snapshotId)
    if (!relationValid || !this.contentBlobStore.has(snapshot.contentRef)) {
      throw new Error('LOCAL_KNOWLEDGE_SOURCE_INVALID')
    }
    const metadataRef = this.putJson({
      version: 1,
      kind: String(source.connectorSource.kind || ''),
      selectionId: String(source.connectorSource.selectionId || ''),
      sourceId: snapshot.sourceId,
      title: snapshot.title,
      mediaType: snapshot.mediaType,
      captureMode,
      snapshot,
      citation,
    })
    return [
      {
        type: 'knowledge',
        sourceId: snapshot.sourceId,
        contentRef: snapshot.contentRef,
        contentHash: snapshot.contentHash,
        targetKinds,
        captureMode,
      },
      {
        type: 'knowledge',
        sourceId: sourceId('knowledge', citation.citationId, index),
        contentRef: metadataRef,
        contentHash: metadataRef.hash,
        targetKinds,
        captureMode: 'snapshot',
      },
    ]
  }

  basePack({ group, taskId, mode, targetKinds, message, prepared = null }) {
    const attachments = prepared?.attachments || message?.attachments || []
    const skillHints = prepared?.skillHints || message?.skillHints || []
    const knowledgeBaseHints = prepared?.knowledgeBaseHints || message?.knowledgeBaseHints || []
    const preview = {
      taskId: publicId(taskId, 'task'),
      messageId: publicId(message?.id || taskId, 'message'),
      text: String(message?.content || ''),
      attachments: attachments.map(attachmentMetadata),
      skillHints,
      knowledgeBaseHints: knowledgeBaseHints.map(publicKnowledgeHint),
      targetKinds,
      ...(message?.routingDecision ? { routingDecision: message.routingDecision } : {}),
      group: {
        name: String(group?.name || ''),
        topic: String(group?.topic || ''),
      },
    }
    const approvedPreviewRef = this.putJson(preview)
    const sources = [this.messageSource({ id: message?.id || taskId, text: message?.content }, targetKinds)]
    attachments.forEach((attachment, index) => {
      sources.push(this.attachmentSource(attachment, targetKinds, index))
    })
    skillHints.forEach((skill, index) => {
      sources.push(this.skillSource(skill, [skill.targetKind], index))
    })
    knowledgeBaseHints.forEach((source, index) => {
      sources.push(...this.knowledgeSources(source, source.targetKinds, index))
    })
    return this.contextPackStore.put({
      parentPackId: null,
      taskId: publicId(taskId, 'task'),
      groupId: publicId(group?.id, 'group'),
      mode,
      permissionMode: group?.allowWrite === true ? 'workspace-write' : 'read-only',
      targetKinds,
      sources,
      approvedPreviewRef,
      approvedPreviewHash: approvedPreviewRef.hash,
    })
  }

  attemptPack({
    baseContextPackId,
    group,
    taskId,
    mode,
    kind,
    packedContext,
    attachments = [],
    skillHints = [],
    knowledgeBaseHints = [],
    approvedPrompt = '',
    forceReadOnly = false,
  }) {
    const base = this.contextPackStore.get(baseContextPackId)
    const targetKinds = [kind]
    const sources = (packedContext?.sourceEntries || []).map(entry => (
      this.messageSource(entry, targetKinds)
    ))
    const runtimeAdditions = []
    attachments.forEach((attachment, index) => {
      const source = this.attachmentSource(attachment, targetKinds, index)
      sources.push(source)
      runtimeAdditions.push({
        type: 'attachment',
        additionId: source.sourceId,
        contentRef: source.contentRef,
        contentHash: source.contentHash,
      })
    })
    skillHints.forEach((skill, index) => {
      sources.push(this.skillSource(skill, targetKinds, index))
    })
    knowledgeBaseHints.forEach((source, index) => {
      sources.push(...this.knowledgeSources(source, targetKinds, index))
    })
    const approvedPreviewRef = approvedPrompt
      ? this.putJson({ text: String(approvedPrompt) })
      : base.approvedPreviewRef
    const record = this.contextPackStore.put({
      parentPackId: base.contextPackId,
      taskId: publicId(taskId, 'task'),
      groupId: publicId(group?.id, 'group'),
      mode,
      permissionMode: group?.allowWrite === true && !forceReadOnly
        ? 'workspace-write'
        : 'read-only',
      targetKinds,
      sources,
      approvedPreviewRef,
      approvedPreviewHash: approvedPreviewRef.hash,
    })
    return { record, runtimeAdditions }
  }

  delivery({
    contextPackId,
    runId,
    agentRunId,
    kind,
    outbound,
    permissionMode,
    skills = [],
    runtimeAdditions = [],
    sessionProvenance,
  }) {
    const transport = String(outbound?.transport || '')
    const serialization = String(outbound?.serialization || '')
    const promptMode = String(outbound?.promptMode || '')
    const wirePayloadHash = String(outbound?.wirePayloadHash || '')
    const wirePayloadBytes = outbound?.wirePayloadBytes
    const wirePayload = outboundWirePayloadBytes(outbound)
    const transportShapeValid = (
      transport === 'legacy'
        && serialization === 'cli-argv-stdin-v1'
        && ['stdin', 'argument'].includes(promptMode)
    ) || (
      transport === 'custom'
        && serialization === 'custom-cli-argv-stdin-v1'
        && ['stdin', 'argument'].includes(promptMode)
    ) || (
      transport === 'acp'
        && serialization === 'acp-session-prompt-v1'
        && promptMode === 'acp'
    ) || (
      transport === 'http'
        && serialization === 'http-json-body-v1'
        && promptMode === 'json'
    )
    if (!OUTBOUND_TRANSPORTS.has(transport)
        || !OUTBOUND_SERIALIZATIONS.has(serialization)
        || !OUTBOUND_PROMPT_MODES.has(promptMode)
        || !transportShapeValid
        || !SHA256.test(wirePayloadHash)
        || !Number.isSafeInteger(wirePayloadBytes) || wirePayloadBytes < 0
        || !wirePayload || wirePayload.length !== wirePayloadBytes) {
      throw new Error('LOCAL_CONTEXT_DELIVERY_INVALID')
    }
    const comparison = this.compareAttemptOutbound(contextPackId, {
      prompt: String(outbound?.prompt || ''),
      transport,
      serialization,
      promptMode,
    }, wirePayload)
    const wirePayloadRef = this.contentBlobStore.put(wirePayload, {
      mediaType: 'application/json',
    })
    if (wirePayloadRef.hash !== wirePayloadHash || wirePayloadRef.size !== wirePayloadBytes) {
      throw new Error('LOCAL_CONTEXT_DELIVERY_INVALID')
    }
    const payloadRef = this.putJson({
      prompt: String(outbound?.prompt || ''),
      transport,
      serialization,
      promptMode,
      permissionMode,
      skills: skills.map(skill => ({
        namespace: skill.namespace,
        slug: skill.slug,
        ...(skill.snapshotId ? { snapshotId: skill.snapshotId } : {}),
      })),
      attachments: runtimeAdditions.map(addition => ({
        additionId: addition.additionId,
        contentHash: addition.contentHash,
      })),
      comparison,
    })
    return this.contextPackStore.putDelivery({
      contextPackId,
      runId: publicId(runId, 'run'),
      agentRunId: publicId(agentRunId, 'agent-run'),
      agentKind: publicId(kind, 'agent'),
      payloadRef,
      payloadHash: payloadRef.hash,
      wirePayloadRef,
      wirePayloadHash,
      wirePayloadBytes,
      serialization,
      runtimeAdditions,
      sessionProvenance,
    })
  }
}

module.exports = { LocalWorkspaceContextPacks }

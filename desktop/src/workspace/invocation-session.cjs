const { createHash, randomUUID } = require('node:crypto')
const { canonicalJson } = require('../collaboration/context-pack-records.cjs')
const { nextSessionMeta, normalizeSessionMeta } = require('../runs/run-harness.cjs')

const MAX_INHERITED_TASK_IDS = 64

function sha256(value) {
  return createHash('sha256').update(String(value || '')).digest('hex')
}

function createdSessionProvenance(taskId, stateless = false) {
  if (stateless) {
    return {
      scope: 'none', reuse: false, origin: 'none', originTaskId: null,
      inheritedTaskIds: [], completeness: 'complete',
    }
  }
  return {
    scope: 'conversation',
    reuse: false,
    origin: 'created',
    originTaskId: taskId || null,
    inheritedTaskIds: [],
    completeness: 'complete',
  }
}

function provenanceMeta(provenance) {
  if (provenance.scope === 'unknown-legacy') {
    return {
      sessionScope: 'unknown-legacy',
      originTaskId: '',
      inheritedTaskIds: [],
      provenanceCompleteness: 'unknown-legacy',
    }
  }
  if (provenance.scope === 'none') return {}
  return {
    sessionScope: provenance.scope,
    originTaskId: provenance.originTaskId || '',
    inheritedTaskIds: provenance.inheritedTaskIds || [],
    provenanceCompleteness: provenance.completeness,
  }
}

function completedSessionMeta(meta, provenance, taskId, usage) {
  let inheritedTaskIds = [...(provenance.inheritedTaskIds || [])]
  let completeness = provenance.completeness
  if (provenance.scope === 'conversation' && taskId
      && taskId !== provenance.originTaskId && !inheritedTaskIds.includes(taskId)) {
    inheritedTaskIds.push(taskId)
    if (inheritedTaskIds.length > MAX_INHERITED_TASK_IDS) {
      inheritedTaskIds = inheritedTaskIds.slice(-MAX_INHERITED_TASK_IDS)
      completeness = 'partial'
    }
  }
  return nextSessionMeta(meta, {
    ...usage,
    ...provenanceMeta({ ...provenance, inheritedTaskIds, completeness }),
  })
}

// Binds a pending permission or connector request to the exact native session
// it was raised in, so a decision cannot be replayed against another session.
function connectorSessionBinding(sessionRef, sessionProvenance) {
  const stableProvenance = {
    scope: String(sessionProvenance?.scope || 'none'),
    originTaskId: String(sessionProvenance?.originTaskId || ''),
    inheritedTaskIds: Array.isArray(sessionProvenance?.inheritedTaskIds)
      ? [...sessionProvenance.inheritedTaskIds]
      : [],
    completeness: String(sessionProvenance?.completeness || 'complete'),
  }
  return {
    sessionRefHash: sha256(sessionRef),
    sessionProvenanceHash: sha256(canonicalJson(stableProvenance)),
  }
}

// The native Agent session one invocation runs in. A conversation owns one
// native session for its lifetime: it is resumed on every turn and rebuilt
// only when the Agent reports that the stored session is no longer valid.
class InvocationSession {
  // `resolved` is what the workspace stored for this conversation; `deps`
  // carries the state hooks so this class never touches workspace state itself.
  constructor({ resolved, group, kind, taskId, deps }) {
    this.group = group
    this.kind = kind
    this.taskId = taskId
    this.deps = deps
    this.key = resolved.key
    this.storedRef = String(resolved.sessionRef || '')
    this.ref = this.storedRef
    this.meta = normalizeSessionMeta(resolved.sessionMeta)
    this.provenance = resolved.provenance
    this.rotated = resolved.sessionReset === true
    this.transport = this.ref ? String(this.meta.transport || '') : ''
  }

  binding() {
    return connectorSessionBinding(this.ref, this.provenance)
  }

  // Forget the native session so the next turn starts a fresh one. OpenClaw
  // addresses its sessions by name, so it gets a new name straight away.
  discard() {
    this.meta = {}
    this.provenance = createdSessionProvenance(this.taskId)
    this.transport = ''
    this.rotated = true
    this.deps.commitSessionState((nextState) => {
      delete nextState.sessions[this.key]
      delete nextState.sessionMeta[this.key]
      if (this.kind === 'openclaw') {
        const generation = randomUUID().replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'session'
        this.ref = this.deps.openClawSessionRef(
          this.group, generation, this.group.conversationType === 'direct' ? '' : this.taskId,
        )
        nextState.sessions[this.key] = this.ref
        nextState.sessionMeta[this.key] = normalizeSessionMeta(provenanceMeta(this.provenance))
      } else {
        this.ref = ''
      }
    })
  }

  // The Agent reported (or created) its native session id.
  adopt(nextRef, metadata = {}) {
    const transport = ['legacy', 'acp'].includes(metadata?.transport) ? metadata.transport : ''
    if (transport) this.transport = transport
    this.ref = String(nextRef || '')
    this.deps.persistSessionState(this.key, this.ref, normalizeSessionMeta({
      ...this.meta,
      ...provenanceMeta(this.provenance),
      ...(this.transport ? { transport: this.transport } : {}),
    }))
  }

  // A turn finished: record what it cost and which message it had seen.
  complete(resultRef, usage) {
    this.deps.persistSessionState(
      this.key,
      resultRef || this.ref,
      completedSessionMeta(this.meta, this.provenance, this.taskId, usage),
    )
  }
}

module.exports = {
  InvocationSession,
  completedSessionMeta,
  connectorSessionBinding,
  createdSessionProvenance,
  provenanceMeta,
  sha256,
}

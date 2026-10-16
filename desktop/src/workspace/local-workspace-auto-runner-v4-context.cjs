// What a V4 run freezes and shares: the task snapshot, stored receipts and the collaboration package.
const { createHash } = require('node:crypto')
const { peerCollaborationText, publicCollaborationText } = require('../collaboration/collaboration-records.cjs')
const {
  buildCollaborationPackage,
  hashValue,
  parseCollaborationControlBlock,
  resolveCoordinationConsensus,
} = require('../collaboration/orchestration-v4-records.cjs')
const { canonicalJson } = require('../collaboration/context-pack-records.cjs')
const {
  restoreV4SnapshotSkills,
  v4SnapshotBodyHash,
  v4SnapshotSkillHints,
  validateV4SnapshotBody,
} = require('./local-workspace-context.cjs')

const v4ContextMethods = {
  v4OperationId(
    controller, kind, phase, slotId = '', round = controller.currentRound || 0,
  ) {
    const digest = createHash('sha256').update(JSON.stringify([
      controller.runId,
      controller.taskId,
      kind,
      slotId,
      phase,
      round,
    ])).digest('hex')
    return `operation-${digest}`
  },

  v4SnapshotRecord(controller, snapshot, targetKinds) {
    if (!this.contentBlobStore) throw new Error('LOCAL_RUN_SNAPSHOT_STORE_UNAVAILABLE')
    const serialized = canonicalJson(snapshot)
    const contentRef = this.contentBlobStore.put(serialized, { mediaType: 'application/json' })
    const sourceIds = [snapshot?.messageId, ...(snapshot?.history || []).map(item => item.id)]
      .filter(Boolean).slice(-64)
    const taskId = snapshot?.taskId || controller.taskId || null
    const record = {
      contextPackId: controller.contextPackId || null,
      taskId,
      messageId: snapshot?.messageId || controller.threadRootId || null,
      groupId: snapshot?.group?.id || controller.groupId || null,
      round: Math.max(0, Number(controller.currentRound) || 0),
      targetKinds: [...targetKinds],
      sourceIds,
      capturedAt: Date.now(),
      charCount: Buffer.byteLength(serialized),
      contentHash: contentRef.hash,
      bodyHash: v4SnapshotBodyHash(snapshot),
      contentRef,
    }
    return { record, snapshotHash: hashValue(record) }
  },

  v4SnapshotSkillHints(snapshot, targetKinds) {
    return v4SnapshotSkillHints(snapshot, targetKinds)
  },

  async v4RestoreSnapshotSkills(snapshot, targetKinds, persisted = null) {
    return restoreV4SnapshotSkills({
      snapshot,
      targetKinds,
      validateSkillSelections: this.validateSkillSelections,
      persisted,
    })
  },

  v4LoadSnapshot(orchestration, { taskId, messageId, groupId, targetKinds }) {
    const record = orchestration?.snapshot
    if (!record?.contentRef || !this.contentBlobStore) {
      throw new Error('LOCAL_RUN_SNAPSHOT_INVALID')
    }
    let bytes
    try { bytes = this.contentBlobStore.read(record.contentRef) } catch {
      throw new Error('LOCAL_RUN_SNAPSHOT_INVALID')
    }
    const serialized = bytes.toString('utf8')
    let body
    try { body = JSON.parse(serialized) } catch {
      throw new Error('LOCAL_RUN_SNAPSHOT_INVALID')
    }
    return validateV4SnapshotBody({
      body,
      serialized,
      byteLength: bytes.length,
      record,
      orchestrationSnapshotHash: orchestration.snapshotHash,
      taskId,
      messageId,
      groupId,
      targetKinds,
    })
  },

  v4RestoreReceipts(controller) {
    if (Array.isArray(controller.v4ReceiptRecords)) {
      return controller.v4ReceiptRecords.map(item => ({
        receipt: item.receipt,
        verdict: item.verdict || '',
        resolvedIssueIds: Array.isArray(item.resolvedIssueIds)
          ? [...item.resolvedIssueIds]
          : [],
      }))
    }
    const restored = []
    const slots = Array.isArray(controller.orchestration?.slots)
      ? controller.orchestration.slots
      : []
    for (const slot of slots) {
      const records = slot?.resultRefs?.workflowOutcomeRefs
      if (!Array.isArray(records)) continue
      for (const record of records) {
        if (!record?.receipt) continue
        try {
          const receipt = parseCollaborationControlBlock(record.receipt)
          restored.push({
            receipt,
            verdict: typeof record.verdict === 'string' ? record.verdict : '',
            resolvedIssueIds: Array.isArray(record.resolvedIssueIds)
              ? record.resolvedIssueIds.filter(value => typeof value === 'string')
              : [],
          })
        } catch { /* malformed historical receipts are ignored and re-run */ }
      }
    }
    controller.v4ReceiptRecords = restored
    return restored
  },

  v4Package(receiptRecords, options = {}) {
    const recipientKind = String(options.recipientKind || '')
    const binding = options.sessionBinding || {}
    const deliveryState = Array.isArray(options.deliveryState) ? options.deliveryState : []
    const latest = new Map()
    for (const item of receiptRecords) {
      const receipt = item?.receipt
      if (!receipt) continue
      const key = receipt.agentKind || `${receipt.phase}\u0000${receipt.summary}`
      const previous = latest.get(key)
      if (!previous || (Number(receipt.deliveryWatermark) || 0)
          > (Number(previous.receipt.deliveryWatermark) || 0)
          || ((Number(receipt.deliveryWatermark) || 0)
            === (Number(previous.receipt.deliveryWatermark) || 0)
            && receipt.phase.localeCompare(previous.receipt.phase) > 0)) {
        latest.set(key, item)
      }
    }
    let selectedItems = [...latest.values()]
    const snapshotHash = typeof options.snapshotHash === 'string' ? options.snapshotHash : ''
    const targetKinds = new Set(Array.isArray(options.targetKinds) ? options.targetKinds : [])
    const resolvedIssueIds = []
    const resolved = new Set()
    for (const item of receiptRecords) {
      const receipt = item?.receipt
      if (!snapshotHash || receipt?.snapshotHash !== snapshotHash
          || (targetKinds.size && !targetKinds.has(receipt.agentKind))) continue
      for (const value of Array.isArray(item.resolvedIssueIds) ? item.resolvedIssueIds : []) {
        if (typeof value !== 'string' || !value || value.length > 120 || resolved.has(value)) continue
        resolved.add(value)
        resolvedIssueIds.push(value)
        if (resolvedIssueIds.length >= 256) break
      }
      if (resolvedIssueIds.length >= 256) break
    }
    if (recipientKind && binding.sessionRefHash && !options.forceFull) {
      const acknowledged = new Map(deliveryState
        .filter(item => item.recipientKind === recipientKind
          && item.sessionRefHash === binding.sessionRefHash
          && item.sessionProvenanceHash === binding.sessionProvenanceHash
          && item.status === 'acknowledged')
        .map(item => [`${item.sourceAgentKind}\u0000${item.sourcePhase}`, item.watermark]))
      selectedItems = selectedItems.filter(item => {
        const receipt = item.receipt
        const previous = acknowledged.get(`${receipt.agentKind}\u0000${receipt.phase}`) || 0
        return (Number(receipt.deliveryWatermark) || 0) > previous
      })
    }
    const selectedReceipts = selectedItems.map(item => item.receipt)
    const totalLimit = Number.isSafeInteger(options.totalLimit) ? options.totalLimit : 6000
    const packageRecord = buildCollaborationPackage(selectedReceipts, {
      targetKinds: options.targetKinds || [],
      totalLimit,
      resolvedIssueIds,
    })
    const text = this.v4SanitizeDeliveryText(packageRecord.text, packageRecord.text.length)
    return text === packageRecord.text
      ? packageRecord
      : { ...packageRecord, text, totalChars: text.length, packageHash: hashValue(text) }
  },

  v4CoordinationResult({
    receiptRecords, targetKinds, snapshotHash, snapshot = null,
    challengeBindings = [], requireSupport = true,
  }) {
    const candidateReceipts = receiptRecords
      .filter(record => record?.receipt?.phase === 'challenge')
    const supportReceipts = requireSupport
      ? targetKinds.map((kind) => {
          const operationId = challengeBindings.find(binding => (
            binding.reviewerKind === kind
          ))?.reviewerOperationId || ''
          return this.v4ReceiptForOperation(
            receiptRecords, 'challenge', kind, operationId,
          ) || null
        })
      : []
    if (supportReceipts.some(receipt => !receipt)) {
      const result = resolveCoordinationConsensus({
        targetKinds, snapshotHash, candidateReceipts, supportReceipts: [],
      })
      return this.v4SemanticCoordinationResult(result, snapshot)
    }
    const result = resolveCoordinationConsensus({
      targetKinds, snapshotHash, candidateReceipts, supportReceipts,
    })
    return this.v4SemanticCoordinationResult(result, snapshot)
  },

  v4SemanticCoordinationResult(result, snapshot) {
    const candidates = result.candidates.filter((candidate) => {
      try {
        for (const assignment of candidate.assignments) {
          this.v4DirectAssignmentReferences(assignment, snapshot)
        }
        return true
      } catch (error) {
        if (error?.message === 'LOCAL_RUN_V4_ASSIGNMENT_REFERENCE_INVALID') return false
        throw error
      }
    })
    const candidateHashes = new Set(candidates.map(candidate => candidate.planHash))
    return {
      ...result,
      plan: result.plan && candidateHashes.has(result.plan.planHash) ? result.plan : null,
      candidates,
    }
  },

  v4SanitizeDeliveryText(value, limit = 6000, options = {}) {
    const privateWrapper = '(?:private[ _-]?(?:reasoning|thoughts?)|analysis|chain[ _-]?of[ _-]?thought|cot)'
    const privateHeading = '(?:private[ _-]?(?:reasoning|thoughts?)|chain[ _-]?of[ _-]?thought|cot)'
    const stripped = this.v4StripMeldworkControls(
      options.workspaceRoot
        ? peerCollaborationText(value, { workspaceRoot: options.workspaceRoot })
        : publicCollaborationText(value, Number.MAX_SAFE_INTEGER),
    )
    const maximum = Number.isSafeInteger(limit) && limit >= 0 ? limit : 6000
    let privateSectionLevel = null
    const withoutPrivateSections = stripped.split(/\r?\n/).filter((line) => {
      const heading = line.match(/^\s*(#{1,6})\s+(.+)$/u)
      const level = heading?.[1].length
      if (heading && new RegExp(`^${privateHeading}\\b`, 'iu').test(heading[2].trim())) {
        privateSectionLevel = Math.min(privateSectionLevel ?? level, level)
        return false
      }
      if (privateSectionLevel !== null && heading && level <= privateSectionLevel) {
        privateSectionLevel = null
      }
      return privateSectionLevel === null
    }).join('\n')
    return withoutPrivateSections
      .replace(new RegExp(`<\\s*${privateWrapper}\\b[^>]*>[\\s\\S]*?<\\/\\s*${privateWrapper}\\s*>`, 'giu'), '')
      .replace(/(?:^|\n)\s*(?:my\s+)?private[ _-]?reasoning\s*:\s*[^\n]*/giu, '\n')
      .replace(/\b(?:session(?:[ _-]?(?:id|ref))?)\b\s*(?::|=)\s*[A-Za-z0-9][A-Za-z0-9._:-]*/giu, '[redacted]')
      .replace(/\b(?:session(?:[ _-]?(?:id|ref))?)\b\s+[A-Za-z0-9][A-Za-z0-9._:-]*/giu, '[redacted]')
      .replace(/\b(?:session[-_][A-Za-z0-9._:-]+|[A-Za-z0-9][A-Za-z0-9._:-]*-(?:native-)?session)\b/giu, '[redacted]')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, maximum)
  },

  v4StripMeldworkControls(text) {
    const marker = '[[MELDWORK_'
    const source = String(text || '')
    const upper = source.toUpperCase()
    let cursor = 0
    let output = ''
    while (true) {
      const start = upper.indexOf(marker, cursor)
      if (start < 0) return output + source.slice(cursor)
      output += source.slice(cursor, start)
      let quote = ''
      let escaped = false
      let braces = 0
      let brackets = 0
      let end = -1
      for (let index = start + 2; index < source.length - 1; index += 1) {
        const character = source[index]
        if (quote) {
          if (escaped) escaped = false
          else if (character === '\\') escaped = true
          else if (character === quote) quote = ''
          continue
        }
        if (character === '"' || character === "'") {
          quote = character
        } else if (character === '{') {
          braces += 1
        } else if (character === '}') {
          braces = Math.max(0, braces - 1)
        } else if (character === '[') {
          brackets += 1
        } else if (character === ']') {
          if (braces === 0 && brackets === 0 && source[index + 1] === ']') {
            end = index + 2
            break
          }
          brackets = Math.max(0, brackets - 1)
        }
      }
      if (end < 0) return output
      const header = source.slice(start, end)
      if (!header.includes(':')) {
        const closing = `[[/${header.slice(2, -2)}]]`.toUpperCase()
        const closingStart = upper.indexOf(closing, end)
        cursor = closingStart < 0 ? end : closingStart + closing.length
      } else {
        cursor = end
      }
    }
  },

  v4CoordinationText(result, limit = 4800) {
    const candidates = Array.isArray(result?.candidates) ? result.candidates : []
    if (!candidates.length) return ''
    const supportCounts = new Map()
    for (const planHash of result.supportPlanHashes || []) {
      if (planHash) supportCounts.set(planHash, (supportCounts.get(planHash) || 0) + 1)
    }
    const lines = [
      'MELDWORK_V4_RESPONSIBILITY_CANDIDATES_V1',
      'Fields: h=planHash;s=support;f=finalizer;v=verifiers;a=[t=taskId,o=owner,r=role,x=objective,y=expectedOutput,i=inputRefs,a=artifactRefs,d=dependencies]',
    ]
    const append = (line) => {
      const next = [...lines, line].join('\n')
      if (next.length > limit) return false
      lines.push(line)
      return true
    }
    for (const plan of candidates) {
      let safe = true
      const text = value => {
        const raw = String(value || '')
        const sanitized = this.v4SanitizeDeliveryText(raw, 2000)
        if (/\[\[MELDWORK_/iu.test(raw) || sanitized !== raw) safe = false
        return sanitized
      }
      const values = value => Array.isArray(value) ? value.map(text) : []
      const graph = {
        h: plan.planHash,
        s: supportCounts.get(plan.planHash) || 0,
        f: text(plan.finalizerKind),
        v: values(plan.verifierKinds),
        a: plan.assignments.map(assignment => ({
          t: text(assignment.taskId),
          o: text(assignment.ownerKind),
          r: text(assignment.role),
          x: text(assignment.objective),
          y: text(assignment.expectedOutput),
          i: values(assignment.inputRefs),
          a: values(assignment.artifactIds),
          d: values(assignment.dependsOn),
        })),
      }
      if (!safe) continue
      append(JSON.stringify(graph))
    }
    return lines.join('\n')
  },

  v4ChallengeProposalText(binding, reviewerKind, limit = 1600) {
    const proposalKind = String(binding?.proposalKind || '')
    if (!proposalKind || proposalKind === reviewerKind) {
      throw new Error('LOCAL_RUN_V4_CHALLENGE_BINDING_INVALID')
    }
    for (const artifactId of binding.artifactIds || []) {
      try {
        const { artifact, content } = this.v4ArtifactIdentity(artifactId)
        const body = this.v4SanitizeDeliveryText(content, limit)
        if (artifact.producedBy?.agentKind !== proposalKind || !body) continue
        return [
          'MELDWORK_V4_ASSIGNED_PROPOSAL_V1',
          `Proposal Agent: ${proposalKind}`,
          `Proposal Artifact: ${artifactId}`,
          'Proposal body excerpt:',
          body,
        ].join('\n')
      } catch { /* skip non-text and unavailable outcome refs */ }
    }
    throw new Error('LOCAL_RUN_V4_CHALLENGE_BINDING_INVALID')
  },

  v4CoordinationAssignment(coordinationPlan, kind, options = {}) {
    const owned = coordinationPlan?.assignments?.filter(item => item.ownerKind === kind) || []
    if (options.taskId) return owned.find(item => item.taskId === options.taskId) || null
    if (options.role) return owned.find(item => item.role === options.role) || null
    return owned[0] || null
  },
}

module.exports = { v4ContextMethods }

// How a V4 run hands context to each Agent: assignments, the blackboard owner, delivery prompts and delivery state.
const { createHash } = require('node:crypto')
const { collaborationPackageIndexText } = require('../collaboration/collaboration-records.cjs')
const { hashValue } = require('../collaboration/orchestration-v4-records.cjs')
const { v4Prompt } = require('./local-workspace-context.cjs')

const v4DeliveryMethods = {
  v4DirectAssignmentReferences(assignment, snapshot) {
    const snapshotSources = new Map([
      [snapshot?.messageId, snapshot?.taskText],
      ...(Array.isArray(snapshot?.history) ? snapshot.history : []).map(item => [item?.id, item?.text]),
    ].filter(([sourceId]) => typeof sourceId === 'string' && sourceId))
    const safeReferenceText = (value) => {
      const raw = String(value || '').trim()
      const sanitized = this.v4SanitizeDeliveryText(raw, Number.MAX_SAFE_INTEGER)
      if (!raw || sanitized !== raw || /\[\[MELDWORK_/iu.test(raw)) {
        throw new Error('LOCAL_RUN_V4_ASSIGNMENT_REFERENCE_INVALID')
      }
      return sanitized
    }
    const inputReferences = assignment.inputRefs.map((sourceId) => {
      if (!snapshotSources.has(sourceId)) {
        throw new Error('LOCAL_RUN_V4_ASSIGNMENT_REFERENCE_INVALID')
      }
      return {
        kind: 'input', id: sourceId, header: `Input ${sourceId}:`,
        body: safeReferenceText(snapshotSources.get(sourceId)),
      }
    })
    const directArtifacts = assignment.artifactIds.map((artifactId) => {
      let identity
      try { identity = this.v4ArtifactIdentity(artifactId) } catch {
        throw new Error('LOCAL_RUN_V4_ASSIGNMENT_REFERENCE_INVALID')
      }
      if (identity.artifact.contentRef?.mediaType !== 'text/plain') {
        throw new Error('LOCAL_RUN_V4_ASSIGNMENT_REFERENCE_INVALID')
      }
      return {
        kind: 'artifact', id: artifactId, header: `Artifact ${artifactId}:`,
        body: safeReferenceText(identity.content),
      }
    })
    return { inputReferences, directArtifacts }
  },

  v4WorkAssignmentText(
    coordinationPlan, kind, taskId, snapshot = null, limit = 6000, receiptRecords = [],
  ) {
    const assignment = this.v4CoordinationAssignment(coordinationPlan, kind, { taskId })
    if (!assignment) throw new Error('LOCAL_RUN_V4_COORDINATION_PLAN_INVALID')
    const { inputReferences, directArtifacts } = this.v4DirectAssignmentReferences(
      assignment, snapshot,
    )
    const directReferences = [...inputReferences, ...directArtifacts]
    const dependencies = new Set(assignment.dependsOn)
    const latestDependencies = new Map()
    for (const record of receiptRecords) {
      const receipt = record?.receipt
      if (receipt?.phase !== 'work' || !dependencies.has(receipt.workItemId)) continue
      latestDependencies.set(receipt.workItemId, record)
    }
    const dependencyArtifacts = [...latestDependencies.values()]
      .sort((left, right) => String(left.receipt.workItemId)
        .localeCompare(String(right.receipt.workItemId)))
      .flatMap(record => (record.receipt.artifactIds || []).map((artifactId, index) => ({
        artifactId,
        index,
        receipt: record.receipt,
      })))
      .map(({ artifactId, index, receipt }) => {
        let identity
        try { identity = this.v4ArtifactIdentity(artifactId) } catch {
          throw new Error('LOCAL_RUN_V4_REFERENCE_INVALID')
        }
        const mediaType = String(identity.artifact.contentRef?.mediaType || '')
        const raw = String(identity.content || '').trim()
        const body = mediaType === 'text/plain'
          ? this.v4SanitizeDeliveryText(raw, Number.MAX_SAFE_INTEGER)
          : ''
        let omission = ''
        if (mediaType !== 'text/plain') {
          omission = `${artifactId} reason=non-text mediaType=${mediaType || 'unknown'}`
        } else if (!raw) {
          omission = `${artifactId} reason=empty`
        } else if (body !== raw) {
          omission = `${artifactId} reason=safety-filter`
        }
        return {
          key: `${receipt.workItemId}:${index}`,
          artifactId,
          body,
          omission,
          header: `Artifact ${artifactId} from ${receipt.agentKind} work=${receipt.workItemId}`,
        }
      })
    const render = (included) => {
      const lines = [
        'MELDWORK_V4_AGREED_WORK_PACKAGE_V1',
        `Responsibility plan: ${coordinationPlan.planHash}`,
        `Work item: ${assignment.taskId}`,
        `Owner: ${assignment.ownerKind}`,
        `Role: ${assignment.role}`,
        `Input refs: ${assignment.inputRefs.length ? assignment.inputRefs.join(', ') : '(none)'}`,
        `Artifact refs: ${assignment.artifactIds.length ? assignment.artifactIds.join(', ') : '(none)'}`,
        `Dependencies: ${assignment.dependsOn.length ? assignment.dependsOn.join(', ') : '(none)'}`,
      ]
      if (inputReferences.length) {
        lines.push('MELDWORK_V4_FROZEN_INPUT_REFS_V1')
        for (const reference of inputReferences) {
          lines.push(reference.header)
          const body = included.get(`direct:${reference.kind}:${reference.id}`) || ''
          if (body) lines.push(body)
        }
      }
      if (directArtifacts.length) {
        lines.push('MELDWORK_V4_DIRECT_ARTIFACT_REFS_V1')
        for (const reference of directArtifacts) {
          lines.push(reference.header)
          const body = included.get(`direct:${reference.kind}:${reference.id}`) || ''
          if (body) lines.push(body)
        }
      }
      if (dependencyArtifacts.length) {
        lines.push('MELDWORK_V4_REFERENCED_ARTIFACTS_V1')
        for (const artifact of dependencyArtifacts) {
          lines.push(artifact.header)
          const body = included.get(`dependency:${artifact.key}`) || ''
          if (body) lines.push(body)
        }
      }
      const objective = included.get('objective') || ''
      const expectedOutput = included.get('expectedOutput') || ''
      lines.push(`Objective: ${objective}`, `Expected output: ${expectedOutput}`)
      const freeTextOmissions = [
        ...(objective.length < assignment.objective.length ? ['objective reason=budget'] : []),
        ...(expectedOutput.length < assignment.expectedOutput.length
          ? ['expectedOutput reason=budget'] : []),
      ]
      if (freeTextOmissions.length) {
        lines.push('MELDWORK_V4_TRUNCATED_FREE_TEXT_V1', ...freeTextOmissions)
      }
      const directOmissions = directReferences.filter(reference => (
        (included.get(`direct:${reference.kind}:${reference.id}`) || '').length
          < reference.body.length
      )).map(reference => `${reference.kind} ${reference.id} reason=budget`)
      if (directOmissions.length) {
        lines.push('MELDWORK_V4_OMITTED_DIRECT_REFERENCE_BODIES_V1', ...directOmissions)
      }
      const dependencyOmissions = dependencyArtifacts.flatMap((artifact) => {
        if (artifact.omission) return [artifact.omission]
        return (included.get(`dependency:${artifact.key}`) || '').length < artifact.body.length
          ? [`${artifact.artifactId} reason=budget`]
          : []
      })
      if (dependencyOmissions.length) {
        lines.push('MELDWORK_V4_OMITTED_ARTIFACT_BODIES_V1', ...dependencyOmissions)
      }
      return lines.join('\n')
    }
    const maximum = Number.isSafeInteger(limit) && limit >= 0 ? limit : 6000
    const fullIncluded = new Map([
      ['objective', assignment.objective],
      ['expectedOutput', assignment.expectedOutput],
      ...directReferences.map(reference => [
        `direct:${reference.kind}:${reference.id}`, reference.body,
      ]),
      ...dependencyArtifacts.filter(artifact => artifact.body).map(artifact => [
        `dependency:${artifact.key}`, artifact.body,
      ]),
    ])
    const full = render(fullIncluded)
    if (full.length <= maximum) return full
    const bodyFields = [...fullIncluded.entries()]
    const bodyLineCount = directReferences.length
      + dependencyArtifacts.filter(artifact => artifact.body).length
    let remaining = maximum - render(new Map()).length - bodyLineCount
    if (remaining < 0) throw new Error('LOCAL_RUN_V4_DELIVERY_BUDGET_EXCEEDED')
    const included = new Map()
    let pendingFields = bodyFields.length
    for (const [key, body] of bodyFields) {
      const share = pendingFields > 0 ? Math.floor(remaining / pendingFields) : 0
      const value = body.slice(0, Math.max(0, share))
      included.set(key, value)
      remaining -= value.length
      pendingFields -= 1
    }
    const result = render(included)
    if (result.length > maximum) throw new Error('LOCAL_RUN_V4_DELIVERY_BUDGET_EXCEEDED')
    return result
  },

  v4CheckpointRole(phase, slot, coordinationPlan, workAssignment = null) {
    if (['proposal', 'discussion', 'challenge'].includes(phase)) return 'participant'
    const assignment = phase === 'work'
      ? (workAssignment || this.v4CoordinationAssignment(coordinationPlan, slot.agentKind))
      : (phase === 'synthesis'
        ? this.v4CoordinationAssignment(coordinationPlan, slot.agentKind, { role: 'integrator' })
          || this.v4CoordinationAssignment(coordinationPlan, slot.agentKind)
        : this.v4CoordinationAssignment(coordinationPlan, slot.agentKind))
    if (phase === 'verification') {
      if (coordinationPlan?.verifierKinds?.includes(slot.agentKind)) return 'verifier'
      return assignment?.role || 'writer'
    }
    return assignment?.role || 'writer'
  },

  v4PromptRole(phase, kind, coordinationPlan, workAssignment = null) {
    if (['proposal', 'discussion', 'challenge'].includes(phase)) return 'participant'
    if (phase === 'verification') {
      if (!coordinationPlan?.verifierKinds?.includes(kind)) {
        throw new Error('LOCAL_RUN_V4_COORDINATION_PLAN_INVALID')
      }
      return 'verifier'
    }
    const assignment = phase === 'work'
      ? workAssignment
      : (phase === 'synthesis'
        ? this.v4CoordinationAssignment(coordinationPlan, kind, { role: 'integrator' })
          || this.v4CoordinationAssignment(coordinationPlan, kind)
        : this.v4CoordinationAssignment(coordinationPlan, kind))
    if (!assignment) throw new Error('LOCAL_RUN_V4_COORDINATION_PLAN_INVALID')
    return assignment.role
  },

  v4BlackboardOwner(coordinationPlan, kind) {
    const assignment = this.v4CoordinationAssignment(coordinationPlan, kind, { role: 'integrator' })
      || this.v4CoordinationAssignment(coordinationPlan, kind)
    if (!assignment) {
      throw new Error('LOCAL_RUN_V4_COORDINATION_PLAN_INVALID')
    }
    return {
      type: 'agent',
      agentKind: kind,
      role: assignment.role,
    }
  },

  v4ArtifactContext(
    receiptRecords, phase, coordinationPlan, kind, limit = 3600, workTaskId = '',
  ) {
    let selected = []
    if (phase === 'work') {
      const assignment = this.v4CoordinationAssignment(
        coordinationPlan, kind, { taskId: workTaskId },
      )
      const dependencies = new Set(assignment?.dependsOn || [])
      selected = receiptRecords.filter(record => (
        record?.receipt?.phase === 'work' && dependencies.has(record.receipt.workItemId)
      ))
    } else if (phase === 'synthesis') {
      const workItems = new Set(coordinationPlan?.assignments?.map(item => item.taskId) || [])
      selected = receiptRecords.filter(record => (
        record?.receipt?.phase === 'work' && workItems.has(record.receipt.workItemId)
      ))
    } else if (phase === 'verification') {
      const latest = this.v4LatestReceipt(receiptRecords, 'synthesis')
      selected = latest ? [latest] : []
    }
    const latestByKey = new Map()
    for (const record of selected) {
      const receipt = record.receipt
      const key = receipt.workItemId || `${receipt.phase}:${receipt.agentKind}`
      latestByKey.set(key, record)
    }
    const records = [...latestByKey.values()].sort((left, right) => (
      String(left.receipt.workItemId || left.receipt.agentKind)
        .localeCompare(String(right.receipt.workItemId || right.receipt.agentKind))
    ))
    if (!records.length) return ''
    const artifacts = records.flatMap((record, recordIndex) => {
      const receipt = record.receipt
      return (receipt.artifactIds || []).map((artifactId, artifactIndex) => ({
        key: `${recordIndex}:${artifactIndex}`,
        artifactId,
        receipt,
      }))
    }).map(({ key, artifactId, receipt }) => {
      let identity
      try { identity = this.v4ArtifactIdentity(artifactId) } catch {
        throw new Error('LOCAL_RUN_V4_REFERENCE_INVALID')
      }
      const mediaType = String(identity.artifact.contentRef?.mediaType || '')
      const raw = String(identity.content || '').trim()
      const body = mediaType === 'text/plain'
        ? this.v4SanitizeDeliveryText(raw, Number.MAX_SAFE_INTEGER)
        : ''
      return {
        key,
        artifactId,
        receipt,
        mediaType,
        raw,
        body,
        header: `Artifact ${artifactId} from ${receipt.agentKind} work=${receipt.workItemId || receipt.phase}`,
      }
    })
    if (!artifacts.length) return ''
    const maximum = Number.isSafeInteger(limit) && limit >= 0 ? limit : 3600
    const textArtifacts = artifacts.filter(artifact => artifact.mediaType === 'text/plain'
      && artifact.body)
    const fixedOmissions = artifacts.flatMap((artifact) => {
      if (artifact.mediaType !== 'text/plain') {
        return [`${artifact.artifactId} reason=non-text mediaType=${artifact.mediaType || 'unknown'}`]
      }
      if (!artifact.raw) return [`${artifact.artifactId} reason=empty`]
      return artifact.body === artifact.raw
        ? []
        : [`${artifact.artifactId} reason=safety-filter`]
    })
    const potentialBudgetOmissions = textArtifacts.map(artifact => (
      `${artifact.artifactId} reason=budget`
    ))
    const structuralLines = [
      'MELDWORK_V4_REFERENCED_ARTIFACTS_V1',
      ...artifacts.map(artifact => artifact.header),
    ]
    const reservedManifest = [...fixedOmissions, ...potentialBudgetOmissions]
    const reservedLines = reservedManifest.length
      ? [...structuralLines, 'MELDWORK_V4_OMITTED_ARTIFACT_BODIES_V1', ...reservedManifest]
      : structuralLines
    const bodySeparators = textArtifacts.length
    const bodyBudget = maximum - reservedLines.join('\n').length - bodySeparators
    if (bodyBudget < 0) throw new Error('LOCAL_RUN_V4_DELIVERY_BUDGET_EXCEEDED')
    let remaining = bodyBudget
    let remainingArtifacts = textArtifacts.length
    const includedByKey = new Map()
    for (const artifact of textArtifacts) {
      const share = remainingArtifacts > 0 ? Math.floor(remaining / remainingArtifacts) : 0
      const included = artifact.body.slice(0, Math.max(0, share))
      includedByKey.set(artifact.key, included)
      remaining -= included.length
      remainingArtifacts -= 1
    }
    const budgetOmissions = textArtifacts.filter(artifact => (
      includedByKey.get(artifact.key).length < artifact.body.length
    )).map(artifact => `${artifact.artifactId} reason=budget`)
    const lines = ['MELDWORK_V4_REFERENCED_ARTIFACTS_V1']
    for (const artifact of artifacts) {
      lines.push(artifact.header)
      const included = includedByKey.get(artifact.key) || ''
      if (included) lines.push(included)
    }
    const omissions = [...fixedOmissions, ...budgetOmissions]
    if (omissions.length) {
      lines.push('MELDWORK_V4_OMITTED_ARTIFACT_BODIES_V1', ...omissions)
    }
    const result = lines.join('\n')
    if (result.length > maximum) throw new Error('LOCAL_RUN_V4_DELIVERY_BUDGET_EXCEEDED')
    return result
  },

  v4DeliveryPrompt(group, controller, input) {
    const {
      kind, phase, snapshot, receiptRecords, role, targetKinds, slot, options,
      sessionBinding, skillHints = [],
    } = input
    const full = sessionBinding.sessionRotated === true || sessionBinding.hasSession !== true
    const packageFloor = phase === 'proposal' ? 0 : collaborationPackageIndexText(targetKinds).length
    let remaining = 6000 - packageFloor
    let assignedProposalText = phase === 'challenge'
      ? this.v4SanitizeDeliveryText(options.assignedProposalText || '', 1600)
      : ''
    if (assignedProposalText) {
      remaining = Math.max(0, remaining - 2)
      assignedProposalText = assignedProposalText.slice(0, remaining)
      remaining -= assignedProposalText.length
    }
    const rawExtraContext = String(options.extraContext || '').trim()
    const requestedExtraContext = this.v4SanitizeDeliveryText(rawExtraContext, 6000)
    const artifactContextPlan = options.artifactContext?.coordinationPlan || null
    const structuredArtifactContext = ['synthesis', 'verification'].includes(phase)
      && options.artifactContext && typeof options.artifactContext === 'object'
      && !Array.isArray(options.artifactContext)
    if ((phase === 'work' || structuredArtifactContext) && rawExtraContext.length > 6000) {
      throw new Error('LOCAL_RUN_V4_DELIVERY_BUDGET_EXCEEDED')
    }
    if ((phase === 'work' || structuredArtifactContext)
        && requestedExtraContext !== rawExtraContext) {
      throw new Error('LOCAL_RUN_V4_ASSIGNMENT_REFERENCE_INVALID')
    }
    const extraLimit = Math.max(0, remaining - 2)
    let extraContext = requestedExtraContext
    if (structuredArtifactContext) {
      const artifactLimit = extraLimit - (extraContext ? extraContext.length + 2 : 0)
      const artifactContext = this.v4ArtifactContext(
        receiptRecords,
        phase,
        artifactContextPlan,
        kind,
        Math.max(0, artifactLimit),
      )
      extraContext = [extraContext, artifactContext].filter(Boolean).join('\n\n')
      if (extraContext.length > extraLimit) {
        throw new Error('LOCAL_RUN_V4_DELIVERY_BUDGET_EXCEEDED')
      }
    } else if (extraContext.length > extraLimit) {
      if (phase === 'work') throw new Error('LOCAL_RUN_V4_DELIVERY_BUDGET_EXCEEDED')
      const marker = 'MELDWORK_V4_CONTEXT_TRUNCATED_V1'
      if (extraLimit <= marker.length + 1) {
        extraContext = ''
      } else {
        let prefix = extraContext.slice(0, extraLimit - marker.length - 1)
        const boundary = prefix.lastIndexOf('\n')
        if (boundary > 0) prefix = prefix.slice(0, boundary)
        extraContext = `${prefix.trimEnd()}\n${marker}`
      }
    }
    if (extraContext) remaining -= extraContext.length + 2
    const packageRecord = phase === 'proposal'
      ? null
      : this.v4Package(receiptRecords, {
          recipientKind: kind,
          sessionBinding,
          deliveryState: controller.orchestration?.deliveryState || [],
          targetKinds,
          snapshotHash: controller.orchestration?.snapshotHash,
          forceFull: full,
          totalLimit: packageFloor + remaining,
        })
    const deliveryId = `delivery-${hashValue({
      runId: controller.runId, recipientKind: kind, slotId: slot.slotId,
      operationId: slot.operationId, packageHash: packageRecord?.packageHash || '', now: Date.now(),
    }).slice(0, 64)}`
    const delivery = packageRecord?.receipts?.length ? {
      deliveryId,
      packageHash: packageRecord.packageHash,
      entries: packageRecord.receipts.map(receipt => ({
        recipientKind: kind,
        sessionRefHash: sessionBinding.sessionRefHash,
        sessionProvenanceHash: sessionBinding.sessionProvenanceHash,
        sourceAgentKind: receipt.agentKind,
        sourcePhase: receipt.phase,
        watermark: receipt.deliveryWatermark,
        snapshotHash: receipt.snapshotHash,
        operationId: receipt.operationId,
        packageHash: packageRecord.packageHash,
        deliveryId,
        status: 'prepared',
        updatedAt: Date.now(),
      })),
    } : null
    this.v4PrepareDelivery(group, controller, delivery)
    return {
      prompt: this.v4PhasePrompt(group, kind, phase, snapshot, receiptRecords, role, {
        reviewTarget: options.reviewTarget,
        assignedProposalText,
        packageText: packageRecord?.text || '',
        extraContext,
        snapshotHash: controller.orchestration?.snapshotHash,
        skillHints,
      }),
      delivery,
    }
  },

  v4PrepareDelivery(group, controller, delivery) {
    if (delivery) {
      const replaced = new Set(delivery.entries.map(entry => [
        entry.recipientKind, entry.sessionRefHash, entry.sessionProvenanceHash,
        entry.sourceAgentKind, entry.sourcePhase,
      ].join('\u0000')))
      const deliveryState = [
        ...(controller.orchestration?.deliveryState || []).filter(entry => (
          (!delivery.natural || entry.recipientKind !== delivery.entries[0].recipientKind
            || (entry.sessionRefHash === delivery.entries[0].sessionRefHash
              && entry.sessionProvenanceHash === delivery.entries[0].sessionProvenanceHash))
          && !replaced.has([
          entry.recipientKind, entry.sessionRefHash, entry.sessionProvenanceHash,
          entry.sourceAgentKind, entry.sourcePhase,
        ].join('\u0000')))),
        ...delivery.entries,
      ].sort((left, right) => [
        left.recipientKind, left.sessionRefHash, left.sessionProvenanceHash,
        left.sourceAgentKind, left.sourcePhase,
      ].join('\u0000').localeCompare([
        right.recipientKind, right.sessionRefHash, right.sessionProvenanceHash,
        right.sourceAgentKind, right.sourcePhase,
      ].join('\u0000')))
      this.checkpointOrchestration(group, controller, { deliveryState })
    }
  },

  v4SetDeliveryStatus(group, controller, delivery, status, binding = null) {
    if (!delivery?.entries?.length) return
    const deliveryState = (controller.orchestration?.deliveryState || []).map(entry => {
      const matched = delivery.entries.some(candidate => candidate.deliveryId === entry.deliveryId
        && candidate.sourceAgentKind === entry.sourceAgentKind
        && candidate.sourcePhase === entry.sourcePhase
        && entry.status === 'prepared')
      let sourceMessages = entry.sourceMessages
      if (matched && sourceMessages && status === 'acknowledged'
          && binding?.sessionRefHash === entry.sessionRefHash
          && binding?.sessionProvenanceHash === entry.sessionProvenanceHash) {
        const previous = delivery.previousEntries?.find(candidate => (
          candidate.sourceAgentKind === entry.sourceAgentKind
          && candidate.sourcePhase === entry.sourcePhase
        ))
        sourceMessages = [...new Map([
          ...(previous?.sourceMessages || []), ...sourceMessages,
        ].map(message => [message.id, message])).values()].slice(-100)
      }
      return matched ? {
        ...entry,
        ...(sourceMessages ? { sourceMessages } : {}),
        ...(binding ? {
          sessionRefHash: binding.sessionRefHash,
          sessionProvenanceHash: binding.sessionProvenanceHash,
        } : {}),
        status,
        updatedAt: Date.now(),
      } : entry
    }).sort((left, right) => [
      left.recipientKind, left.sessionRefHash, left.sessionProvenanceHash,
      left.sourceAgentKind, left.sourcePhase,
    ].join('\u0000').localeCompare([
      right.recipientKind, right.sessionRefHash, right.sessionProvenanceHash,
      right.sourceAgentKind, right.sourcePhase,
    ].join('\u0000')))
    this.checkpointOrchestration(group, controller, { deliveryState })
  },

  v4ChallengeTarget(kind, targetKinds, round = 1, seed = '') {
    const kinds = Array.isArray(targetKinds) ? targetKinds : []
    const index = kinds.indexOf(kind)
    if (index < 0 || kinds.length < 2) return ''
    const digest = createHash('sha256').update(JSON.stringify([seed, round, kinds])).digest('hex')
    const offset = 1 + (Number.parseInt(digest.slice(0, 8), 16) % (kinds.length - 1))
    return kinds[(index + offset) % kinds.length] || ''
  },

  v4ChallengeBindings({ controller, targetKinds, round, snapshotRecord, slots, receiptRecords }) {
    const kinds = [...new Set(Array.isArray(targetKinds) ? targetKinds : [])].sort()
    if (kinds.length < 2 || !Number.isSafeInteger(round) || round < 2) {
      throw new Error('LOCAL_RUN_V4_CHALLENGE_BINDING_INVALID')
    }
    const digest = createHash('sha256').update(JSON.stringify([
      snapshotRecord?.bodyHash || '', kinds,
    ])).digest('hex')
    const initialOffset = 1 + (Number.parseInt(digest.slice(0, 8), 16) % (kinds.length - 1))
    const offset = 1 + ((initialOffset - 1 + (round - 2)) % (kinds.length - 1))
    const slotsByKind = new Map(slots.map(slot => [slot.agentKind, slot]))
    const proposalsByKind = new Map()
    for (const record of receiptRecords) {
      const receipt = record?.receipt
      if (receipt?.phase === 'proposal' && kinds.includes(receipt.agentKind)) {
        proposalsByKind.set(receipt.agentKind, receipt)
      }
    }
    return kinds.map((reviewerKind, index) => {
      const proposalKind = kinds[(index + offset) % kinds.length]
      const reviewerSlot = slotsByKind.get(reviewerKind)
      const proposalSlot = slotsByKind.get(proposalKind)
      const proposalReceipt = proposalsByKind.get(proposalKind)
      if (!reviewerSlot || !proposalSlot || !proposalReceipt) {
        throw new Error('LOCAL_RUN_V4_CHALLENGE_BINDING_INVALID')
      }
      return {
        round,
        reviewerKind,
        reviewerSlotId: reviewerSlot.slotId,
        reviewerOperationId: this.v4OperationId(
          controller, reviewerKind, 'challenge', reviewerSlot.slotId,
        ),
        proposalKind,
        proposalSlotId: proposalSlot.slotId,
        proposalOperationId: proposalReceipt.operationId,
        proposalReceiptId: proposalReceipt.receiptId,
        artifactIds: [...(proposalReceipt.artifactIds || [])],
        evidenceIds: [...(proposalReceipt.evidenceIds || [])],
      }
    })
  },

  v4PhasePrompt(group, kind, phase, snapshot, receiptRecords, role, options = {}) {
    const collaborationPackage = phase === 'proposal'
      ? ''
      : String(options.packageText || this.v4Package(receiptRecords, {
          recipientKind: kind,
          forceFull: options.forceFullPackage === true,
          snapshotHash: options.snapshotHash,
        }).text)
    const reviewTarget = phase === 'challenge' ? String(options.reviewTarget || '') : ''
    const assignedProposalText = phase === 'challenge'
      ? this.v4SanitizeDeliveryText(options.assignedProposalText || '', 1600) : ''
    const extraContext = this.v4SanitizeDeliveryText(options.extraContext || '', 6000)
    return [
      v4Prompt({
        group, kind, phase, snapshot, role, skillHints: options.skillHints,
        knowledgeBaseHints: options.knowledgeBaseHints,
        naturalResponse: this.naturalAgentResponses,
      }),
      reviewTarget
        ? `Coverage responsibility: explicitly incorporate or challenge ${reviewTarget}'s proposal while negotiating with every peer. This coverage duty does not assign responsibilities or authorize you to allocate work for others.`
        : '',
      assignedProposalText,
      collaborationPackage
        ? `Selected records from completed phases:\n${collaborationPackage}`
        : '',
      extraContext,
    ].filter(Boolean).join('\n\n')
  },
}

module.exports = { v4DeliveryMethods }

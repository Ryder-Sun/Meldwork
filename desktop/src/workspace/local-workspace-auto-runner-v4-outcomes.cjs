const { createHash } = require('node:crypto')

const {
  coordinationRecoveryKinds,
  createWorkReceipt,
  hashValue,
} = require('../collaboration/orchestration-v4-records.cjs')
const { canonicalJson } = require('../collaboration/context-pack-records.cjs')

const v4OutcomeMethods = {
  v4LatestReceipt(receiptRecords, phase, agentKind = '') {
    return [...receiptRecords].reverse().find(record => (
      record?.receipt?.phase === phase
      && (!agentKind || record.receipt.agentKind === agentKind)
    )) || null
  },

  v4WorkState(workReceipts, coordinationPlan, runId = '') {
    if (!coordinationPlan) throw new Error('LOCAL_RUN_V4_COORDINATION_PLAN_INVALID')
    const completed = new Map()
    for (const assignment of coordinationPlan.assignments) {
      const exactReceipt = (Array.isArray(workReceipts) ? workReceipts : []).find(candidate => (
        candidate?.planHash === coordinationPlan.planHash
        && candidate.taskId === assignment.taskId
        && candidate.ownerKind === assignment.ownerKind
      ))
      if (!exactReceipt) continue
      const record = { receipt: exactReceipt.collaborationReceipt }
      const firstArtifact = runId && exactReceipt.artifacts[0]
        ? this.v4ArtifactIdentity(exactReceipt.artifacts[0].artifactId)
        : null
      const expectedProducer = runId ? {
        runId,
        agentRunId: firstArtifact?.artifact?.producedBy?.agentRunId,
        agentKind: assignment.ownerKind,
        operationId: exactReceipt.operationId,
      } : null
      if (!this.v4ReceiptReferencesComplete(record, '', expectedProducer)
          || exactReceipt.artifacts.some((binding) => {
            const identity = this.v4ArtifactIdentity(binding.artifactId)
            return identity.contentHash !== binding.contentHash
              || canonicalJson(identity.artifact.contentRef) !== canonicalJson(binding.contentRef)
          })) {
        throw new Error('LOCAL_RUN_V4_WORK_RECEIPT_INVALID')
      }
      completed.set(assignment.taskId, exactReceipt)
    }
    if (coordinationPlan.assignments.some(assignment => (
      completed.has(assignment.taskId) && assignment.dependsOn.some(id => !completed.has(id))
    ))) throw new Error('LOCAL_RUN_V4_WORK_RECEIPT_INVALID')
    for (const assignment of coordinationPlan.assignments) {
      const receipt = completed.get(assignment.taskId)
      if (!receipt || !Object.hasOwn(receipt, 'dependencyWorkReceiptIds')) continue
      const dependencies = assignment.dependsOn.map(id => completed.get(id).workReceiptId).sort()
      if (canonicalJson(receipt.dependencyWorkReceiptIds) !== canonicalJson(dependencies)) {
        throw new Error('LOCAL_RUN_V4_WORK_RECEIPT_INVALID')
      }
    }
    const pending = coordinationPlan.assignments.filter(assignment => !completed.has(assignment.taskId))
    const ready = pending.filter(assignment => (
      assignment.dependsOn.every(taskId => completed.has(taskId))
    ))
    return { completed, pending, ready }
  },

  v4ArtifactIdentity(artifactId) {
    if (!this.outcomeStore || !this.outcomeStore.contentBlobStore) {
      throw new Error('LOCAL_RUN_V4_CANDIDATE_INVALID')
    }
    try {
      const artifact = this.outcomeStore.getArtifact(artifactId)
      if (!artifact?.contentRef || artifact.contentHash !== artifact.contentRef.hash) {
        throw new Error('LOCAL_RUN_V4_CANDIDATE_INVALID')
      }
      const bytes = this.outcomeStore.contentBlobStore.read(artifact.contentRef)
      const contentHash = createHash('sha256').update(bytes).digest('hex')
      if (contentHash !== artifact.contentHash) {
        throw new Error('LOCAL_RUN_V4_CANDIDATE_INVALID')
      }
      return {
        artifact,
        contentHash,
        content: artifact.contentRef?.mediaType === 'text/plain'
          ? bytes.toString('utf8')
          : '',
      }
    } catch (error) {
      if (error?.message === 'LOCAL_RUN_V4_CANDIDATE_INVALID') throw error
      throw new Error('LOCAL_RUN_V4_CANDIDATE_INVALID')
    }
  },

  v4CandidateIdentity(record) {
    const artifactId = record?.receipt?.artifactIds?.[0]
    if (typeof artifactId !== 'string') throw new Error('LOCAL_RUN_V4_CANDIDATE_INVALID')
    const { contentHash } = this.v4ArtifactIdentity(artifactId)
    return { artifactId, contentHash }
  },

  v4EvidenceRecord(evidenceId, errorCode = 'LOCAL_RUN_V4_REFERENCE_INVALID') {
    try {
      const evidence = this.outcomeStore.getEvidence(evidenceId)
      const concrete = evidence.refs.some(reference => (
        reference.type === 'artifact'
        || reference.type === 'evidence'
        || reference.type === 'blob'
        || (reference.type === 'location' && Boolean(reference.contentHash))
      ))
      if (!concrete) throw new Error(errorCode)
      return evidence
    } catch (error) {
      if (error?.message === errorCode) throw error
      throw new Error(errorCode)
    }
  },

  v4EvidenceSupportsArtifact(evidenceId, artifactId, contentHash, seen = new Set()) {
    if (seen.has(evidenceId)) return false
    seen.add(evidenceId)
    const identity = this.v4ArtifactIdentity(artifactId)
    if (identity.contentHash !== contentHash) return false
    const evidence = this.v4EvidenceRecord(
      evidenceId, 'LOCAL_RUN_V4_REVIEW_FINDING_INVALID',
    )
    const artifactBound = evidence.subject?.type === 'artifact'
      && evidence.subject.artifactId === artifactId
      || evidence.refs.some(reference => (
        reference.type === 'artifact' && reference.artifactId === artifactId
      ))
    const contentBound = evidence.refs.some(reference => (
      reference.type === 'blob' && reference.contentHash === contentHash
        && canonicalJson(reference.contentRef) === canonicalJson(identity.artifact.contentRef)
    ))
    if (artifactBound && contentBound) return true
    return evidence.refs.some(reference => (
      reference.type === 'evidence'
      && this.v4EvidenceSupportsArtifact(
        reference.evidenceId, artifactId, contentHash, seen,
      )
    ))
  },

  v4ReceiptReferencesComplete(record, expectedArtifactId = '', expectedProducer = null) {
    const receipt = record?.receipt
    if (!receipt || !['completed', 'accepted'].includes(receipt.status)
        || !receipt.artifactIds?.length || !receipt.evidenceIds?.length) return false
    const artifacts = new Map()
    for (const artifactId of receipt.artifactIds) {
      const identity = this.v4ArtifactIdentity(artifactId)
      artifacts.set(artifactId, identity)
    }
    const evidences = receipt.evidenceIds.map(evidenceId => this.v4EvidenceRecord(evidenceId))
    if (expectedProducer) {
      const runId = String(expectedProducer.runId || '')
      const agentRunId = String(expectedProducer.agentRunId || '')
      const agentKind = String(expectedProducer.agentKind || '')
      const operationId = String(expectedProducer.operationId || '')
      if (!runId || !agentRunId || !agentKind || !operationId
          || receipt.agentKind !== agentKind || receipt.operationId !== operationId) return false
      const evidenceBindings = evidences.map((evidence) => {
        const recorder = evidence.recordedBy || {}
        const recorderBound = recorder.kind === 'system'
          ? recorder.actorId === 'meldwork-main'
          : recorder.kind === 'agent'
            && recorder.runId === runId
            && recorder.agentRunId === agentRunId
            && recorder.agentKind === agentKind
        if (!recorderBound) return null
        const boundArtifactIds = new Set([...artifacts.entries()]
          .filter(([artifactId, identity]) => {
            const artifactBound = evidence.subject?.type === 'artifact'
              && evidence.subject.artifactId === artifactId
              || evidence.refs.some(reference => (
                reference.type === 'artifact' && reference.artifactId === artifactId
              ))
            const contentBound = evidence.refs.some(reference => (
              reference.type === 'blob'
                && reference.contentHash === identity.contentHash
                && canonicalJson(reference.contentRef)
                  === canonicalJson(identity.artifact.contentRef)
            ))
            return artifactBound && contentBound
          })
          .map(([artifactId]) => artifactId))
        if (recorder.kind === 'system' && !boundArtifactIds.size) return null
        return boundArtifactIds
      })
      if (evidenceBindings.some(binding => !binding)) return false
      return [...artifacts.entries()].every(([artifactId, identity]) => {
        const artifact = identity.artifact
        return artifact.producedBy?.runId === runId
          && artifact.producedBy?.agentRunId === agentRunId
          && artifact.producedBy?.agentKind === agentKind
          && evidenceBindings.some(binding => binding.has(artifactId))
      })
    }
    const artifactId = expectedArtifactId || receipt.artifactIds[0]
    const identity = artifacts.get(artifactId)
    if (!identity) return false
    return evidences.some(evidence => {
      const artifactBound = evidence.subject?.type === 'artifact'
        && evidence.subject.artifactId === artifactId
        || evidence.refs.some(reference => (
          reference.type === 'artifact' && reference.artifactId === artifactId
        ))
      const contentBound = evidence.refs.some(reference => (
        reference.type === 'blob' && reference.contentHash === identity.contentHash
      ))
      return artifactBound && contentBound
    })
  },

  v4TrustedSynthesisResult({
    controller, slots, activeAttempt, synthesisRecovery, coordinationPlan, snapshotHash,
  }) {
    try {
      const rankedKinds = coordinationRecoveryKinds(coordinationPlan)
      if (!activeAttempt || !synthesisRecovery || !coordinationPlan?.planHash
          || coordinationPlan.snapshotHash !== snapshotHash
          || synthesisRecovery.originalWriterKind !== coordinationPlan.finalizerKind
          || synthesisRecovery.activeWriterKind !== activeAttempt.writerKind
          || canonicalJson(synthesisRecovery.rankedKinds) !== canonicalJson(rankedKinds)
          || synthesisRecovery.rankingFingerprint !== hashValue({
            planHash: coordinationPlan.planHash,
            rankedKinds,
          })) return false
      const slot = slots.find(candidate => candidate.slotId === activeAttempt.slotId)
      if (!slot || slot.agentKind !== activeAttempt.writerKind
          || slot.operationId !== activeAttempt.operationId
          || slot.snapshotHash !== snapshotHash) return false
      const records = Array.isArray(slot.resultRefs?.workflowOutcomeRefs)
        ? slot.resultRefs.workflowOutcomeRefs
        : []
      const record = [...records].reverse().find(candidate => {
        const receipt = candidate?.receipt
        return receipt?.phase === 'synthesis'
          && receipt.agentKind === activeAttempt.writerKind
          && receipt.slotId === activeAttempt.slotId
          && receipt.operationId === activeAttempt.operationId
          && receipt.snapshotHash === snapshotHash
          && ['completed', 'accepted'].includes(receipt.status)
      })
      const receipt = record?.receipt
      if (!receipt?.artifactIds?.length || !receipt.evidenceIds?.length
          || canonicalJson(receipt.artifactIds)
            !== canonicalJson(slot.resultRefs?.artifactIds || [])
          || canonicalJson(receipt.evidenceIds)
            !== canonicalJson(slot.resultRefs?.evidenceIds || [])) return false
      return receipt.artifactIds.every((artifactId) => {
        const { artifact, contentHash } = this.v4ArtifactIdentity(artifactId)
        if (artifact.producedBy?.runId !== controller.runId
            || artifact.producedBy?.agentKind !== activeAttempt.writerKind) return false
        return receipt.evidenceIds.some((evidenceId) => {
          const evidence = this.v4EvidenceRecord(evidenceId)
          return evidence.recordedBy?.kind === 'system'
            && evidence.recordedBy.actorId === 'meldwork-main'
            && evidence.subject?.type === 'artifact'
            && evidence.subject.artifactId === artifactId
            && evidence.refs.some(reference => (
              reference.type === 'artifact' && reference.artifactId === artifactId
            ))
            && evidence.refs.some(reference => (
              reference.type === 'blob'
                && reference.contentHash === contentHash
                && canonicalJson(reference.contentRef) === canonicalJson(artifact.contentRef)
            ))
        })
      })
    } catch {
      return false
    }
  },

  v4ExactWorkReceipt(receiptRecord, assignment, slot, snapshotRecord, snapshotHash,
    coordinationPlan, workReceipts) {
    const receipt = receiptRecord?.receipt
    if (!receipt || !assignment || !slot || !snapshotRecord?.bodyHash
        || !snapshotRecord?.contentRef || !coordinationPlan?.planHash) {
      throw new Error('LOCAL_RUN_V4_WORK_RECEIPT_INVALID')
    }
    const artifacts = receipt.artifactIds.map((artifactId) => {
      const { artifact, contentHash } = this.v4ArtifactIdentity(artifactId)
      return {
        artifactId,
        contentHash,
        contentRef: artifact.contentRef,
      }
    })
    const dependencyWorkReceiptIds = assignment.dependsOn.map(taskId => {
      const dependency = workReceipts?.find(item => item.taskId === taskId && item.planHash === coordinationPlan.planHash)
      if (!dependency?.workReceiptId) throw new Error('LOCAL_RUN_V4_WORK_RECEIPT_INVALID')
      return dependency.workReceiptId
    })
    return createWorkReceipt({
      snapshotHash,
      snapshotBodyHash: snapshotRecord.bodyHash,
      snapshotContentRef: snapshotRecord.contentRef,
      planHash: coordinationPlan.planHash,
      taskId: assignment.taskId,
      ownerKind: assignment.ownerKind,
      slotId: slot.slotId,
      operationId: slot.operationId,
      collaborationReceipt: receipt,
      artifacts,
      dependencyWorkReceiptIds,
    })
  },

  v4ReviewFindings(input, options = {}) {
    const record = input?.record
    const receipt = record?.receipt
    const reviewedArtifactId = String(input?.reviewedArtifactId || '')
    const runId = String(options.runId || '')
    const required = options.required === true || record?.verdict === 'contradict'
    if (!receipt || !['challenge', 'verification'].includes(receipt.phase)
        || !['support', 'contradict'].includes(record?.verdict)
        || !reviewedArtifactId || !runId) {
      throw new Error('LOCAL_RUN_V4_REVIEW_FINDING_INVALID')
    }
    const findingIds = Array.isArray(receipt.findingIds) ? receipt.findingIds : []
    if (required && findingIds.length === 0) {
      throw new Error('LOCAL_RUN_V4_REVIEW_FINDING_INVALID')
    }
    const { artifact, contentHash } = this.v4ArtifactIdentity(reviewedArtifactId)
    const receiptEvidenceIds = Array.isArray(receipt.evidenceIds) ? receipt.evidenceIds : []
    const receiptEvidenceSet = new Set(receiptEvidenceIds)
    return findingIds.map((findingId) => {
      let finding
      try { finding = this.outcomeStore.getReviewerFinding(findingId) } catch {
        throw new Error('LOCAL_RUN_V4_REVIEW_FINDING_INVALID')
      }
      if (finding.artifactId !== reviewedArtifactId
          || finding.relation !== record.verdict
          || finding.reviewer?.kind !== 'agent'
          || finding.reviewer.runId !== runId
          || finding.reviewer.agentKind !== receipt.agentKind
          || !finding.reviewer.agentRunId
          || !finding.evidenceIds.length) {
        throw new Error('LOCAL_RUN_V4_REVIEW_FINDING_INVALID')
      }
      for (const evidenceId of finding.evidenceIds) {
        if (!receiptEvidenceSet.has(evidenceId) && receiptEvidenceIds.length !== 64) {
          throw new Error('LOCAL_RUN_V4_REVIEW_FINDING_INVALID')
        }
        const evidence = this.v4EvidenceRecord(
          evidenceId, 'LOCAL_RUN_V4_REVIEW_FINDING_INVALID',
        )
        const recorder = evidence.recordedBy || {}
        const directArtifactBound = evidence.subject?.type === 'artifact'
          && evidence.subject.artifactId === reviewedArtifactId
          && evidence.refs.some(reference => (
            reference.type === 'artifact' && reference.artifactId === reviewedArtifactId
          ))
        const exactContentBound = evidence.refs.some(reference => (
          reference.type === 'blob'
            && reference.contentHash === contentHash
            && canonicalJson(reference.contentRef) === canonicalJson(artifact.contentRef)
        ))
        if (evidence.kind !== 'review'
            || recorder.kind !== 'agent'
            || recorder.runId !== finding.reviewer.runId
            || recorder.agentRunId !== finding.reviewer.agentRunId
            || recorder.agentKind !== finding.reviewer.agentKind
            || !directArtifactBound || !exactContentBound) {
          throw new Error('LOCAL_RUN_V4_REVIEW_FINDING_INVALID')
        }
      }
      return finding
    })
  },

  v4ReviewReceiptComplete(input, options = {}) {
    const status = input?.record?.receipt?.status
    if (!['completed', 'accepted'].includes(status)) return false
    return this.v4ReviewFindings(input, { ...options, required: true }).length > 0
  },

  v4IssueId(record, findingId) {
    return `issue-${hashValue({
      phase: record.receipt.phase,
      reviewerFindingId: findingId,
    })}`
  },

  v4IssueFromFinding(record, finding) {
    const { contentHash } = this.v4ArtifactIdentity(finding.artifactId)
    return {
      id: this.v4IssueId(record, finding.reviewerFindingId),
      artifactId: finding.artifactId,
      findingId: finding.reviewerFindingId,
      summary: finding.summary,
      semanticKey: hashValue({
        phase: record.receipt.phase,
        candidateContentHash: contentHash,
        relation: finding.relation,
        reviewerKind: finding.reviewer.agentKind,
        summary: finding.summary,
      }),
    }
  },

  v4IssuesFromReviews(inputs, options = {}) {
    const issues = new Map()
    for (const input of inputs) {
      const record = input?.record
      const findings = this.v4ReviewFindings(input, options)
      if (record.verdict !== 'contradict') continue
      for (const finding of findings) {
        const issue = this.v4IssueFromFinding(record, finding)
        issues.set(issue.id, issue)
      }
    }
    return [...issues.values()].sort((left, right) => left.id.localeCompare(right.id))
  },

  v4CarriedIssues(receiptRecords, openIssueIds, options = {}) {
    const requested = Array.isArray(openIssueIds) ? openIssueIds : []
    if (new Set(requested).size !== requested.length) {
      throw new Error('LOCAL_RUN_V4_ISSUE_INVALID')
    }
    if (requested.length === 0) return []
    const requestedSet = new Set(requested)
    const durableIssues = new Map()
    try {
      for (const record of receiptRecords) {
        if (!['challenge', 'verification'].includes(record?.receipt?.phase)
            || record.verdict !== 'contradict') continue
        const findingIds = Array.isArray(record.receipt.findingIds)
          ? record.receipt.findingIds : []
        if (findingIds.length === 0) throw new Error('LOCAL_RUN_V4_ISSUE_INVALID')
        for (const findingId of findingIds) {
          const issueId = this.v4IssueId(record, findingId)
          if (!requestedSet.has(issueId)) continue
          const finding = this.outcomeStore.getReviewerFinding(findingId)
          const scopedRecord = {
            ...record,
            receipt: { ...record.receipt, findingIds: [findingId] },
          }
          if (!this.v4ReviewReceiptComplete({
            record: scopedRecord,
            reviewedArtifactId: finding.artifactId,
          }, options)) throw new Error('LOCAL_RUN_V4_ISSUE_INVALID')
          const issues = this.v4IssuesFromReviews([{
            record: scopedRecord,
            reviewedArtifactId: finding.artifactId,
          }], options)
          for (const issue of issues) durableIssues.set(issue.id, issue)
        }
      }
    } catch {
      throw new Error('LOCAL_RUN_V4_ISSUE_INVALID')
    }
    return requested.map((issueId) => {
      const issue = durableIssues.get(issueId)
      if (!issue) throw new Error('LOCAL_RUN_V4_ISSUE_INVALID')
      return issue
    }).sort((left, right) => left.id.localeCompare(right.id))
  },

  v4ResolveIssues(openIssues, resolvedIssueIds) {
    const issues = Array.isArray(openIssues) ? openIssues : []
    const openIds = issues.map(issue => issue?.id)
    const resolved = Array.isArray(resolvedIssueIds) ? resolvedIssueIds : []
    if (openIds.some(issueId => typeof issueId !== 'string')
        || new Set(openIds).size !== openIds.length
        || resolved.some(issueId => typeof issueId !== 'string')
        || new Set(resolved).size !== resolved.length
        || resolved.some(issueId => !openIds.includes(issueId))) {
      throw new Error('LOCAL_RUN_V4_RESOLUTION_INVALID')
    }
    const closed = new Set(resolved)
    return issues.filter(issue => !closed.has(issue.id))
  },

  v4ReceiptForOperation(receiptRecords, phase, agentKind, operationId = '') {
    return [...receiptRecords].reverse().find(record => (
      record?.receipt?.phase === phase
      && record.receipt.agentKind === agentKind
      && (!operationId || record.receipt.operationId === operationId)
    )) || null
  },

  v4RoundState(receiptRecords, targetKinds, writerKind, verificationKinds, options = {}) {
    const slots = Array.isArray(options.slots) ? options.slots : []
    const challengeBindings = Array.isArray(options.challengeBindings)
      ? options.challengeBindings : []
    const coordinationSupportReceiptIds = new Set(
      options.coordinationPlan?.supportReceiptIds || [],
    )
    const challengeInputs = targetKinds.map((kind) => {
      const binding = challengeBindings.find(item => item.reviewerKind === kind)
      if (binding) {
        const record = this.v4ReceiptForOperation(
          receiptRecords, 'challenge', kind, binding.reviewerOperationId,
        )
        return record && binding.artifactIds?.[0]
          ? { record, reviewedArtifactId: binding.artifactIds[0] }
          : null
      }
      const record = [...receiptRecords].reverse().find(item => (
        item?.receipt?.phase === 'challenge'
          && item.receipt.agentKind === kind
          && coordinationSupportReceiptIds.has(item.receipt.receiptId)
      ))
      const findingId = record?.receipt?.findingIds?.[0]
      let reviewedArtifactId = ''
      try {
        reviewedArtifactId = findingId
          ? this.outcomeStore.getReviewerFinding(findingId).artifactId
          : ''
      } catch {}
      return record && reviewedArtifactId ? { record, reviewedArtifactId } : null
    }).filter(Boolean)
    const priorIssues = this.v4CarriedIssues(
      receiptRecords,
      options.previousConvergence?.openIssueIds || [],
      { runId: options.runId },
    )
    const challengeIssues = this.v4IssuesFromReviews(challengeInputs, { runId: options.runId })
    const issueMap = new Map(priorIssues.map(issue => [issue.id, issue]))
    for (const issue of challengeIssues) {
      const carried = [...issueMap.values()].some(existing => (
        existing.semanticKey === issue.semanticKey
      ))
      if (!carried) issueMap.set(issue.id, issue)
    }

    const writerSlot = slots.find(slot => slot.agentKind === writerKind)
    const synthesis = writerSlot && this.v4ReceiptForOperation(
      receiptRecords, 'synthesis', writerKind, writerSlot.operationId,
    )
    if (!synthesis) throw new Error('LOCAL_RUN_V4_CANDIDATE_INVALID')
    const candidate = this.v4CandidateIdentity(synthesis)
    if (!this.v4ReceiptReferencesComplete(synthesis, candidate.artifactId)) {
      throw new Error('LOCAL_RUN_V4_CANDIDATE_INVALID')
    }
    let openIssues = this.v4ResolveIssues(
      [...issueMap.values()], synthesis.resolvedIssueIds || [],
    )
    const verificationInputs = verificationKinds.map((kind) => {
      const slot = slots.find(candidateSlot => candidateSlot.agentKind === kind)
      const record = slot && this.v4ReceiptForOperation(
        receiptRecords, 'verification', kind, slot.operationId,
      )
      return record ? { record, reviewedArtifactId: candidate.artifactId } : null
    }).filter(Boolean)
    if (options.includeVerification === true) {
      const verificationIssues = this.v4IssuesFromReviews(
        verificationInputs, { runId: options.runId },
      )
      const nextIssues = new Map(openIssues.map(issue => [issue.id, issue]))
      for (const issue of verificationIssues) {
        const carried = [...nextIssues.values()].some(existing => (
          existing.semanticKey === issue.semanticKey
        ))
        if (!carried) nextIssues.set(issue.id, issue)
      }
      openIssues = [...nextIssues.values()].sort((left, right) => left.id.localeCompare(right.id))
    }
    return {
      candidate,
      synthesis,
      challengeInputs,
      verificationInputs,
      openIssues,
    }
  },

  v4NextConvergence(previous, candidate, openIssueIds, round, writerKind) {
    const { artifact, contentHash } = this.v4ArtifactIdentity(candidate?.artifactId)
    const sortedIssueIds = [...new Set(openIssueIds || [])].sort()
    if (contentHash !== candidate?.contentHash || artifact.producedBy.agentKind !== writerKind
        || !Number.isSafeInteger(round) || round < 2
        || sortedIssueIds.length !== (openIssueIds || []).length
        || sortedIssueIds.some(issueId => !/^issue-[a-f0-9]{64}$/.test(issueId))) {
      throw new Error('LOCAL_RUN_V4_CONVERGENCE_INVALID')
    }
    const stateKey = hashValue({ candidateContentHash: contentHash, openIssueIds: sortedIssueIds })
    const stateChanged = !previous || previous.stateKey !== stateKey
    let consecutiveStableRounds = 1
    if (!stateChanged && previous.lastCompletedRound === round - 1) {
      const previousArtifact = this.v4ArtifactIdentity(previous.candidateArtifactId).artifact
      if (previousArtifact.producedBy.agentKind === writerKind) {
        consecutiveStableRounds = previous.consecutiveStableRounds + 1
      }
    }
    return {
      candidateArtifactId: candidate.artifactId,
      candidateContentHash: contentHash,
      openIssueIds: sortedIssueIds,
      stateKey,
      lastCompletedRound: round,
      consecutiveStableRounds,
      stateEpoch: stateChanged ? (previous?.stateEpoch || 0) + 1 : previous.stateEpoch,
      acknowledgedGateEpoch: previous?.acknowledgedGateEpoch || 0,
    }
  },

  v4ShouldOpenStableGate(convergence, unlimitedRounds) {
    return unlimitedRounds === true
      && convergence?.consecutiveStableRounds >= 2
      && convergence.acknowledgedGateEpoch !== convergence.stateEpoch
  },

  v4Acceptance(receiptRecords, targetKinds, writerKind, verificationKinds, options = {}) {
    const state = this.v4RoundState(
      receiptRecords, targetKinds, writerKind, verificationKinds,
      { ...options, includeVerification: true },
    )
    const proposals = targetKinds.map(kind => (
      this.v4LatestReceipt(receiptRecords, 'proposal', kind)
    )).filter(Boolean)
    const workState = options.coordinationPlan
      ? this.v4WorkState(options.workReceipts, options.coordinationPlan, options.runId)
      : null
    const referencesForRun = (record, artifactId = '') => {
      if (!options.runId) return this.v4ReceiptReferencesComplete(record, artifactId)
      const receipt = record?.receipt
      const firstId = receipt?.artifactIds?.[0]
      if (!firstId) return false
      const identity = this.v4ArtifactIdentity(firstId)
      return this.v4ReceiptReferencesComplete(record, artifactId, {
        runId: options.runId,
        agentRunId: identity.artifact.producedBy?.agentRunId,
        agentKind: receipt.agentKind,
        operationId: receipt.operationId,
      })
    }
    const referencesComplete = proposals.length === targetKinds.length
      && proposals.every(record => referencesForRun(record))
      && (!workState || workState.completed.size === options.coordinationPlan.assignments.length)
      && referencesForRun(state.synthesis, state.candidate.artifactId)
      && state.challengeInputs.length === targetKinds.length
      && state.challengeInputs.every(input => this.v4ReviewReceiptComplete(
        input, { runId: options.runId },
      ))
      && state.verificationInputs.length === verificationKinds.length
      && state.verificationInputs.every(input => this.v4ReviewReceiptComplete(
        input, { runId: options.runId },
      ))
    const allSupport = state.verificationInputs.length === verificationKinds.length
      && state.verificationInputs.every(input => input.record.verdict === 'support')
    const requiredSlotsHealthy = targetKinds.every(kind => {
      if (options.coordinationPlan && kind !== writerKind
          && !verificationKinds.includes(kind)) {
        const assignments = options.coordinationPlan.assignments.filter(candidate => (
          candidate.ownerKind === kind
        ))
        return assignments.length > 0 && assignments.every(assignment => (
          workState?.completed.has(assignment.taskId)
        ))
      }
      const slot = options.slots?.find(candidate => candidate.agentKind === kind)
      const requiredPhase = kind === writerKind
        ? 'synthesis'
        : (verificationKinds.includes(kind)
          ? 'verification'
          : (options.coordinationPlan ? 'work' : 'challenge'))
      return slot?.status === 'completed' && slot.phase === requiredPhase
    })
    return {
      accepted: Boolean(referencesComplete && allSupport && requiredSlotsHealthy
        && state.openIssues.length === 0),
      candidateHash: state.candidate.contentHash,
      candidateArtifactId: state.candidate.artifactId,
      openIssueIds: state.openIssues.map(issue => issue.id),
      unresolved: state.openIssues,
      synthesis: state.synthesis,
      verifications: state.verificationInputs.map(input => input.record),
    }
  },
}

module.exports = { v4OutcomeMethods }

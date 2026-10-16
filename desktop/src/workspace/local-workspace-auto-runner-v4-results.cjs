// Turning an Agent result into a V4 receipt and committing it; proposal batches and work settlement.
const {
  appendBlackboardEntry,
  createBlackboardEntryRecord,
  emptyCollaborationState,
  publicCollaborationText,
} = require('../collaboration/collaboration-records.cjs')
const {
  appendWorkReceipt,
  candidateCommitBlackboardStatement,
  candidateCommitSinkId,
  createCollaborationReceipt,
  hashValue,
} = require('../collaboration/orchestration-v4-records.cjs')
const { createReviewerFindingRecord } = require('../collaboration/outcome-records.cjs')
const { canonicalJson } = require('../collaboration/context-pack-records.cjs')
const { parseTaskDecision } = require('../collaboration/task-decision.cjs')
const { terminalRunStatusForReason } = require('./local-workspace-auto-runner-support.cjs')

const v4ResultMethods = {
  recordV4ReviewerFindings({ controller, phase, kind, result, verdict, summary,
    reviewedArtifactId = '' }) {
    if (!this.outcomeStore || !['challenge', 'verification'].includes(phase)
        || !['support', 'contradict'].includes(verdict) || !reviewedArtifactId) return []
    const trace = result?.pendingMessage?.metadata?.trace || result?.message?.trace || {}
    const runId = String(controller?.runId || '')
    const agentRunId = String(trace.agentRunId || '')
    if (!runId || !agentRunId) return []
    const sourceEvidenceIds = Array.isArray(result?.outcomeRefs?.evidenceIds)
      ? result.outcomeRefs.evidenceIds.filter(value => typeof value === 'string').slice(0, 62)
      : []
    try {
      const { artifact, contentHash } = this.v4ArtifactIdentity(reviewedArtifactId)
      const reviewEvidence = this.outcomeStore.putEvidence({
        kind: 'review',
        level: 'observed',
        subject: { type: 'artifact', artifactId: reviewedArtifactId },
        summary: publicCollaborationText(summary || '', 4000) || 'Agent review recorded.',
        recordedBy: { kind: 'agent', runId, agentRunId, agentKind: kind },
        refs: [
          { type: 'artifact', artifactId: reviewedArtifactId },
          { type: 'blob', contentRef: artifact.contentRef, contentHash },
          ...sourceEvidenceIds.map(evidenceId => ({ type: 'evidence', evidenceId })),
        ],
      })
      const input = {
        artifactId: reviewedArtifactId,
        relation: verdict,
        summary: publicCollaborationText(summary || '', 4000) || 'Agent review recorded.',
        reviewer: { kind: 'agent', runId, agentRunId, agentKind: kind },
        evidenceIds: [reviewEvidence.evidenceId],
      }
      const candidate = createReviewerFindingRecord(input)
      try { return [this.outcomeStore.getReviewerFinding(candidate.reviewerFindingId)] }
      catch { return [this.outcomeStore.putReviewerFinding(candidate)] }
    } catch {
      return []
    }
  },

  v4ReceiptForResult(result, phase, kind, slot, snapshotHash, options = {}) {
    let raw = result?.collaboration
    if ((!raw || typeof raw !== 'object' || Array.isArray(raw))
        && this.naturalAgentResponses && ['proposal', 'discussion'].includes(phase)) {
      const visibleSummary = (publicCollaborationText(
        result?.text || result?.message?.content || '', 800,
      ) || `Completed the ${phase} phase.`).replace(/\s+/gu, ' ').trim()
      raw = {
        summary: visibleSummary,
        capabilities: ['Delivered a natural-language response'],
        intendedWork: ['Addressed the current user task'],
        deliverables: ['Natural-language Markdown response'],
        dependencies: [],
      }
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_REQUIRED')
    }
    const summary = publicCollaborationText(raw.summary || '', 800)
    if (!summary) throw new Error('LOCAL_RUN_COLLABORATION_RECEIPT_INVALID')
    const parsedStatus = publicCollaborationText(raw.status || '', 40)
    const status = ['completed', 'accepted', 'continue', 'needs-review', 'rejected']
      .includes(parsedStatus)
      ? parsedStatus
      : 'completed'
    const verdict = publicCollaborationText(raw.verdict || '', 80)
    const deliveryWatermark = (Number(slot.deliveryWatermark) || 0) + 1
    const outcomeRefs = phase === 'work'
      ? (result?.producedOutcomeRefs || {})
      : (result?.outcomeRefs || {})
    const artifactIds = Array.isArray(outcomeRefs.artifactIds)
      ? outcomeRefs.artifactIds.filter(value => typeof value === 'string').slice(0, 64)
      : []
    const evidenceIds = Array.isArray(outcomeRefs.evidenceIds)
      ? outcomeRefs.evidenceIds.filter(value => typeof value === 'string')
        .slice(0, 64)
      : []
    const findingIds = Array.isArray(raw.findingIds)
      ? raw.findingIds.filter(value => typeof value === 'string').slice(0, 64)
      : []
    let unresolved = Array.isArray(raw.unresolved)
      ? raw.unresolved.filter(value => value && typeof value === 'object')
        .slice(0, 32)
        .map(value => ({
          id: publicCollaborationText(value.id || '', 120),
          summary: publicCollaborationText(value.summary || '', 800),
          refs: Array.isArray(value.refs)
            ? value.refs.filter(ref => typeof ref === 'string').slice(0, 64)
            : [],
        }))
        .filter(value => value.id && value.summary)
      : []
    const findings = Array.isArray(raw.findings)
      ? raw.findings.filter(value => value && typeof value === 'object')
        .slice(0, 16)
        .map(value => ({
          kind: publicCollaborationText(value.kind || 'observation', 80) || 'observation',
          summary: publicCollaborationText(value.summary || '', 800),
          ...(value.severity ? { severity: publicCollaborationText(value.severity, 40) } : {}),
          refs: Array.isArray(value.refs)
            ? value.refs.filter(ref => typeof ref === 'string').slice(0, 64)
            : [],
        }))
        .filter(value => value.summary)
      : []
    const listFieldFrom = (value, limit = 32) => Array.isArray(value)
      ? value.filter(item => typeof item === 'string').slice(0, limit)
        .map(item => publicCollaborationText(item, 120))
        .filter(Boolean)
      : []
    const listField = (field, limit = 32) => Array.isArray(raw[field])
      ? raw[field].filter(value => typeof value === 'string').slice(0, limit)
      : []
    const proposedAssignments = Array.isArray(raw.proposedAssignments)
      ? raw.proposedAssignments.filter(value => value && typeof value === 'object').slice(0, 32)
        .map(value => ({
          taskId: publicCollaborationText(value.taskId || '', 120),
          ownerKind: publicCollaborationText(value.ownerKind || '', 120),
          role: publicCollaborationText(value.role || '', 40),
          objective: publicCollaborationText(value.objective || '', 2000),
          expectedOutput: publicCollaborationText(value.expectedOutput || '', 2000),
          inputRefs: listFieldFrom(value.inputRefs, 64),
          artifactIds: listFieldFrom(value.artifactIds, 64),
          dependsOn: listFieldFrom(value.dependsOn, 32),
        }))
        .filter(value => value.taskId && value.ownerKind && value.role
          && value.objective && value.expectedOutput)
      : []
    const reviewerFindings = this.recordV4ReviewerFindings({
      controller: options.controller,
      phase,
      kind,
      result,
      verdict,
      summary,
      reviewedArtifactId: options.reviewedArtifactId || '',
    })
    for (const finding of reviewerFindings) {
      if (finding?.reviewerFindingId && !findingIds.includes(finding.reviewerFindingId)) {
        findingIds.push(finding.reviewerFindingId)
      }
      for (const evidenceId of finding?.evidenceIds || []) {
        if (!evidenceIds.includes(evidenceId) && evidenceIds.length < 64) {
          evidenceIds.push(evidenceId)
        }
      }
    }
    if (['challenge', 'verification'].includes(phase)
        && verdict === 'contradict' && unresolved.length === 0) {
      if (reviewerFindings.length === 0) {
        throw new Error('LOCAL_RUN_V4_REVIEW_FINDING_INVALID')
      }
      unresolved = reviewerFindings.slice(0, 32).map(finding => ({
        id: this.v4IssueId({ receipt: { phase } }, finding.reviewerFindingId),
        summary: publicCollaborationText(finding.summary || summary, 800) || summary,
        refs: [finding.reviewerFindingId],
      }))
    }
    const taskDecision = raw.taskDecision ? parseTaskDecision(raw.taskDecision) : null
    // Public receipts exclude paths; the Agent run retains its original decision.
    if (taskDecision) {
      taskDecision.reason = publicCollaborationText(taskDecision.reason, 1600)
      taskDecision.deliverables = taskDecision.deliverables
        .map(value => publicCollaborationText(value, 800))
    }
    const receipt = createCollaborationReceipt({
      phase,
      agentKind: kind,
      slotId: slot.slotId,
      operationId: slot.operationId,
      status,
      summary,
      conclusion: '',
      ...(taskDecision ? { taskDecision } : {}),
      artifactIds,
      evidenceIds,
      findingIds,
      unresolved,
      findings,
      claims: Array.isArray(raw.claims)
        ? raw.claims.filter(value => typeof value === 'string').slice(0, 16)
        : [],
      refs: Array.isArray(raw.refs)
        ? raw.refs.filter(value => typeof value === 'string').slice(0, 64)
        : [],
      capabilities: listField('capabilities', 32),
      intendedWork: listField('intendedWork', 32),
      deliverables: listField('deliverables', 32),
      dependencies: listField('dependencies', 32),
      proposedAssignments,
      ...(typeof raw.finalizerKind === 'string' && raw.finalizerKind
        ? { finalizerKind: publicCollaborationText(raw.finalizerKind, 120) } : {}),
      ...(Array.isArray(raw.verifierKinds)
        ? {
            verifierKinds: listField(
              'verifierKinds',
              Math.max(1, (options.controller?.targetKinds?.length || 2) - 1),
            ),
          }
        : {}),
      ...(typeof raw.supportedPlanHash === 'string' && raw.supportedPlanHash
        ? { supportedPlanHash: raw.supportedPlanHash } : {}),
      ...(typeof raw.agreeToPlan === 'boolean' ? { agreeToPlan: raw.agreeToPlan } : {}),
      ...(typeof raw.workItemId === 'string' && raw.workItemId
        ? { workItemId: publicCollaborationText(raw.workItemId, 120) } : {}),
      deliveryWatermark,
      snapshotHash,
    })
    const resolvedIssueIds = Array.isArray(raw.resolvedIssueIds)
      ? raw.resolvedIssueIds
        .filter(value => typeof value === 'string')
        .map(value => publicCollaborationText(value, 120))
        .filter(Boolean)
        .slice(0, 32)
      : []
    return {
      receipt,
      verdict,
      resolvedIssueIds,
    }
  },

  completeV4ResumedAgentSlotContinuation(controller, resumedGate) {
    if (!resumedGate?.gateId) return true
    const current = controller.continuation
    const exactBinding = current?.resumeKind === 'agent_slot'
      && current.agentKind === resumedGate.agentKind
      && current.round === resumedGate.round
      && current.phase === resumedGate.phase
      && current.slotId === resumedGate.slotId
      && current.operationId === resumedGate.operationId
      && current.snapshotHash === resumedGate.snapshotHash
    if (current?.gateId === resumedGate.gateId) {
      if (!exactBinding || current.gateType !== resumedGate.type) return false
      if (current.state === 'completed') return true
      if (!['pending', 'ready', 'resuming'].includes(current.state)) return false
      controller.waitingGateIds.delete(resumedGate.gateId)
      controller.continuation = {
        ...current,
        state: 'completed',
        updatedAt: Math.max(Number(current.updatedAt) || 0, Date.now()),
      }
      return true
    }
    return Boolean(
      resumedGate.type === 'permission'
      && current?.gateType === 'permission'
      && current.state === 'completed'
      && exactBinding,
    ) || !this.hasRunLedger()
  },

  commitV4PhaseMessage({ group, controller, threadRootId, phase, kind, pendingMessage }) {
    if (!pendingMessage?.content || !kind) return null
    const agentRunId = pendingMessage.metadata?.trace?.agentRunId || ''
    return this.commitV4AgentMessage({
      messageId: `message-${hashValue({
        agentKind: kind,
        agentRunId,
        phase,
        runId: controller.runId,
        taskId: controller.taskId,
      })}`,
      groupId: group.id,
      agentKind: kind,
      threadRootId,
      content: pendingMessage.content,
      metadata: pendingMessage.metadata || {},
    })
  },

  async runV4ProposalBatch(group, controller, threadRootId, phaseInput) {
    const {
      targetKinds, writerKind, batchId, snapshotRecord, snapshotHash,
      phaseSlots, receiptRecords, dispatches, resumedGate = null,
      participantKinds = targetKinds,
    } = phaseInput
    const phaseReceipts = []
    const phasePendingMessages = []
    const failures = []
    const pendingKinds = () => phaseSlots
      .filter(slot => ['planned', 'queued', 'running', 'waiting'].includes(slot.status))
      .map(slot => slot.agentKind)
    const checkpoint = () => this.v4CheckpointPhase(group, controller, {
      targetKinds,
      phase: 'proposal',
      batchId,
      snapshotRecord,
      snapshotHash,
      slots: phaseSlots,
      writerKind,
      currentKinds: pendingKinds(),
      pendingKinds: pendingKinds(),
      participantKinds,
      receipts: receiptRecords,
    })
    const failSlot = (slot, kind, error) => {
      slot.status = 'failed'
      slot.commitStatus = 'failed'
      slot.finishedAt = Date.now()
      failures.push({ kind, error })
      if (!controller.signal.aborted) {
        this.recordAgentFailure(group.id, kind, error, threadRootId, new Set())
      }
    }

    for (const slot of phaseSlots) {
      if (dispatches.some(dispatch => dispatch.kind === slot.agentKind)) slot.status = 'running'
    }
    const settled = await Promise.all(dispatches.map(async (dispatch) => {
      const { kind, slot, context } = dispatch
      try {
        const recoveredResult = this.v4NaturalRecoveredPhaseResult(
          group, controller, threadRootId, 'proposal', kind, slot,
        )
        const invocation = recoveredResult
          ? { result: recoveredResult }
          : await this.invokeWithUnauthorizedRecovery({
              group,
              kind,
              controller,
              activeKinds: participantKinds,
              threadRootId,
              context: {
                ...context,
                onLeaseAcquired: (leaseState) => {
                  if (!leaseState?.agentRunId) throw new Error('LOCAL_RUN_PERSIST_FAILED')
                  slot.agentRunId = leaseState.agentRunId
                  slot.status = 'running'
                  checkpoint()
                },
              },
            })
        if (controller.signal.aborted) {
          slot.status = 'stopped'
          slot.commitStatus = 'partial'
          slot.finishedAt = Date.now()
          checkpoint()
          return
        }
        const result = invocation.result
        if (!result) {
          failSlot(slot, kind, invocation.error || new Error('LOCAL_AGENT_UNKNOWN_FAILURE'))
          checkpoint()
          return
        }
        const reportedOperationId = result?.message?.trace?.context?.operationId
          || result?.pendingMessage?.metadata?.trace?.context?.operationId
        if (reportedOperationId && reportedOperationId !== slot.operationId) {
          throw new Error('LOCAL_RUN_COLLABORATION_SCOPE_INVALID')
        }
        const receiptRecord = this.v4ReceiptForResult(
          result, 'proposal', kind, slot, snapshotHash, { controller },
        )
        if (!['completed', 'accepted'].includes(receiptRecord.receipt.status)) {
          throw new Error('LOCAL_RUN_COLLABORATION_PROPOSAL_UNSUCCESSFUL')
        }
        const duplicate = receiptRecords.find(existing => (
          existing?.receipt?.receiptId === receiptRecord.receipt.receiptId
        ))
        if (!duplicate) {
          phaseReceipts.push(receiptRecord)
          receiptRecords.push(receiptRecord)
        }
        const effectiveReceiptRecord = duplicate || receiptRecord
        controller.v4ReceiptRecords = receiptRecords
        slot.status = 'completed'
        slot.commitStatus = 'pending'
        slot.finishedAt = Date.now()
        slot.receiptId = effectiveReceiptRecord.receipt.receiptId
        slot.deliveryWatermark = effectiveReceiptRecord.receipt.deliveryWatermark
        slot.resultHash = hashValue(effectiveReceiptRecord.receipt)
        slot.resultRefs = {
          artifactIds: result.outcomeRefs?.artifactIds || [],
          evidenceIds: result.outcomeRefs?.evidenceIds || [],
          workflowOutcomeRefs: [
            ...(slot.resultRefs?.workflowOutcomeRefs || []),
            {
              receipt: effectiveReceiptRecord.receipt,
              ...(effectiveReceiptRecord.verdict
                ? { verdict: effectiveReceiptRecord.verdict }
                : {}),
              ...(effectiveReceiptRecord.resolvedIssueIds.length
                ? { resolvedIssueIds: effectiveReceiptRecord.resolvedIssueIds }
                : {}),
            },
          ],
        }
        const watermark = {
          agentKind: effectiveReceiptRecord.receipt.agentKind,
          phase: effectiveReceiptRecord.receipt.phase,
          watermark: effectiveReceiptRecord.receipt.deliveryWatermark,
          operationId: effectiveReceiptRecord.receipt.operationId,
          snapshotHash: effectiveReceiptRecord.receipt.snapshotHash,
          updatedAt: Date.now(),
        }
        controller.v4Watermarks = [
          ...(controller.v4Watermarks || []).filter(existing => (
            existing.agentKind !== watermark.agentKind || existing.phase !== watermark.phase
          )),
          watermark,
        ]
        if (result.pendingMessage) {
          phasePendingMessages.push({ kind, pendingMessage: result.pendingMessage })
          this.commitV4PhaseMessage({
            group, controller, threadRootId, phase: 'proposal', kind,
            pendingMessage: result.pendingMessage,
          })
          slot.commitStatus = 'committed'
        }
        if (resumedGate?.agentKind === slot.agentKind
            && !this.completeV4ResumedAgentSlotContinuation(controller, resumedGate)) {
          throw new Error('LOCAL_RUN_PERSIST_FAILED')
        }
        checkpoint()
      } catch (error) {
        failSlot(slot, kind, error)
        checkpoint()
      }
    }))
    void settled
    checkpoint()
    controller.currentKind = ''
    controller.progress = []
    controller.completedKinds = [...new Set([
      ...(controller.completedKinds || []),
      ...phaseSlots.filter(slot => slot.status === 'completed').map(slot => slot.agentKind),
    ])]
    controller.failedKinds = [...new Set([
      ...(controller.failedKinds || []),
      ...failures.map(item => item.kind),
    ])]
    this.emitChanged()
    return {
      slots: phaseSlots,
      receiptRecords,
      phaseReceipts,
      failures,
      phasePendingMessages,
      synthesisPendingMessage: null,
      ok: failures.length === 0,
    }
  },

  v4AdmitWorkSettlement(group, controller, threadRootId, item, input) {
    const {
      targetKinds, writerKind, batchId, snapshotRecord, snapshotHash,
      phaseSlots, receiptRecords, challengeBindings, coordinationPlan, workAssignments,
      participantKinds = targetKinds,
    } = input
    const slot = phaseSlots.find(candidate => candidate.agentKind === item.kind)
    const result = item.invocation?.result
    const liveSlot = controller.orchestration?.slots?.find(candidate => (
      candidate.slotId === slot?.slotId
    ))
    if (!slot || controller.signal.aborted
        || ['completed', 'failed', 'stopped', 'committed'].includes(
          controller.orchestration?.phase,
        )
        || !liveSlot || liveSlot.operationId !== slot.operationId
        || !['planned', 'queued', 'running', 'waiting'].includes(liveSlot.status)) {
      if (slot) {
        slot.status = 'stopped'
        slot.commitStatus = 'partial'
        slot.finishedAt = Date.now()
      }
      return { workReceipts: input.workReceipts, failure: null }
    }
    if (!result) {
      const error = item.error || item.invocation?.error
        || new Error('LOCAL_AGENT_UNKNOWN_FAILURE')
      slot.status = 'failed'
      slot.commitStatus = 'failed'
      slot.finishedAt = Date.now()
      this.recordAgentFailure(group.id, item.kind, error, threadRootId, new Set())
      return { workReceipts: input.workReceipts, failure: { ...item, error } }
    }
    try {
      const resultTrace = result?.message?.trace || result?.pendingMessage?.metadata?.trace
      const reportedOperationId = result?.operationId || resultTrace?.context?.operationId
      if (reportedOperationId !== slot.operationId
          || resultTrace?.runId !== controller.runId) {
        throw new Error('LOCAL_RUN_COLLABORATION_SCOPE_INVALID')
      }
      const assignment = workAssignments?.find(candidate => candidate.ownerKind === item.kind)
      const receiptRecord = this.v4ReceiptForResult(
        result, 'work', item.kind, slot, snapshotHash, {
          controller,
          workItemId: assignment?.taskId || '',
        },
      )
      if (!assignment || receiptRecord.receipt.workItemId !== assignment.taskId
          || !this.v4ReceiptReferencesComplete(receiptRecord, '', {
            runId: controller.runId,
            agentRunId: resultTrace?.agentRunId,
            agentKind: item.kind,
            operationId: slot.operationId,
          })) {
        throw new Error('LOCAL_RUN_V4_WORK_RECEIPT_INVALID')
      }
      const exactReceipt = this.v4ExactWorkReceipt(
        receiptRecord, assignment, slot, snapshotRecord, snapshotHash, coordinationPlan,
      )
      const durableReceipts = Array.isArray(controller.orchestration?.workReceipts)
        ? controller.orchestration.workReceipts
        : input.workReceipts
      const appended = appendWorkReceipt(durableReceipts, exactReceipt)
      const assignmentOrder = new Map(coordinationPlan.assignments.map((candidate, index) => (
        [candidate.taskId, index]
      )))
      const workReceipts = [...appended].sort((left, right) => (
        assignmentOrder.get(left.taskId) - assignmentOrder.get(right.taskId)
      ))
      const duplicate = receiptRecords.find(existing => (
        existing?.receipt?.receiptId === receiptRecord.receipt.receiptId
      ))
      if (!duplicate) receiptRecords.push(receiptRecord)
      const effectiveReceiptRecord = duplicate || receiptRecord
      if (!duplicate) input.phaseReceipts.push(receiptRecord)
      controller.v4ReceiptRecords = receiptRecords
      controller.v4WorkReceipts = workReceipts
      slot.status = 'completed'
      slot.commitStatus = 'pending'
      slot.finishedAt = Date.now()
      slot.receiptId = effectiveReceiptRecord.receipt.receiptId
      slot.deliveryWatermark = effectiveReceiptRecord.receipt.deliveryWatermark
      slot.resultHash = hashValue(effectiveReceiptRecord.receipt)
      slot.resultRefs = {
        artifactIds: result.producedOutcomeRefs?.artifactIds || [],
        evidenceIds: result.producedOutcomeRefs?.evidenceIds || [],
        workflowOutcomeRefs: [
          ...(slot.resultRefs?.workflowOutcomeRefs || []),
          ...(!duplicate ? [{ receipt: effectiveReceiptRecord.receipt }] : []),
        ],
      }
      const watermark = {
        agentKind: effectiveReceiptRecord.receipt.agentKind,
        phase: effectiveReceiptRecord.receipt.phase,
        watermark: effectiveReceiptRecord.receipt.deliveryWatermark,
        operationId: effectiveReceiptRecord.receipt.operationId,
        snapshotHash: effectiveReceiptRecord.receipt.snapshotHash,
        updatedAt: Date.now(),
      }
      controller.v4Watermarks = [
        ...(controller.v4Watermarks || []).filter(existing => (
          existing.agentKind !== watermark.agentKind || existing.phase !== watermark.phase
        )),
        watermark,
      ]
      const pendingKinds = phaseSlots.filter(candidate => (
        ['planned', 'queued', 'running', 'waiting'].includes(candidate.status)
      )).map(candidate => candidate.agentKind)
      if (input.resumedGate
          && !this.completeV4ResumedAgentSlotContinuation(controller, input.resumedGate)) {
        throw new Error('LOCAL_RUN_PERSIST_FAILED')
      }
      this.v4CheckpointPhase(group, controller, {
        targetKinds,
        phase: 'work',
        batchId,
        snapshotRecord,
        snapshotHash,
        slots: phaseSlots,
        writerKind,
        currentKinds: pendingKinds,
        pendingKinds,
        participantKinds,
        receipts: receiptRecords,
        challengeBindings,
        coordinationPlan,
        workReceipts,
        workAssignments,
      })
      return { workReceipts, failure: null }
    } catch (error) {
      if (error?.message === 'LOCAL_RUN_PERSIST_FAILED'
          || String(error?.message || '').startsWith('TEST_CRASH:')) throw error
      slot.status = 'failed'
      slot.commitStatus = 'failed'
      slot.finishedAt = Date.now()
      this.recordAgentFailure(group.id, item.kind, error, threadRootId, new Set())
      return { workReceipts: input.workReceipts, failure: { ...item, error } }
    }
  },

  async v4CommitAcceptedCandidate({
    group, controller, threadRootId, targetKinds, batchId, snapshotRecord, snapshotHash,
    slots, receiptRecords, challengeBindings, synthesisBinding, synthesisRecovery,
    coordinationPlan, workReceipts, convergence, writerKind, verificationKinds, acceptance,
    participantKinds = targetKinds,
  }) {
    if (controller.signal.aborted) return terminalRunStatusForReason(controller.stopReason)
    const synthesisRecord = this.v4LatestReceipt(receiptRecords, 'synthesis', writerKind)
    const evidenceIds = [...(synthesisRecord?.receipt?.evidenceIds || [])]
    const { artifact, contentHash, content } = this.v4ArtifactIdentity(
      acceptance.candidateArtifactId,
    )
    if (!content || contentHash !== acceptance.candidateHash
        || !evidenceIds.length
        || !evidenceIds.some(evidenceId => this.v4EvidenceSupportsArtifact(
          evidenceId, acceptance.candidateArtifactId, contentHash,
        ))) {
      throw new Error('LOCAL_RUN_V4_CANDIDATE_INVALID')
    }
    const identity = {
      runId: controller.runId,
      taskId: controller.taskId,
      candidateContentHash: contentHash,
    }
    const previous = controller.orchestration?.candidateCommit || null
    const collaborationAtIntent = controller.orchestration?.collaboration || emptyCollaborationState()
    const writerOwner = this.v4BlackboardOwner(coordinationPlan, writerKind)
    const blackboardSequence = previous?.blackboardSequence
      || (collaborationAtIntent.entries.at(-1)?.lifecycle?.sequence || 0) + 1
    const blackboardRecordedAt = previous?.blackboardRecordedAt ?? 0
    const commitId = candidateCommitSinkId(identity, 'commit')
    const blackboardEntryAtIntent = createBlackboardEntryRecord({
      entryType: 'artifact-ref',
      subject: `candidate-commit:${commitId}`,
      statement: candidateCommitBlackboardStatement({
        candidateArtifactId: acceptance.candidateArtifactId,
        candidateContentHash: contentHash,
      }),
      value: contentHash,
      owner: writerOwner,
      audience: { roles: [], agentKinds: [...targetKinds].sort() },
      lifecycle: {
        state: 'active', sequence: blackboardSequence,
        recordedAt: blackboardRecordedAt, supersedesEntryId: null,
      },
      provenance: {
        runId: controller.runId, taskId: controller.taskId,
        round: controller.currentRound, agentRunId: null,
        artifactIds: [acceptance.candidateArtifactId], evidenceIds,
      },
      refs: [acceptance.candidateArtifactId, ...evidenceIds],
    })
    const base = {
      runId: controller.runId,
      taskId: controller.taskId,
      groupId: group.id,
      threadRootId,
      candidateArtifactId: acceptance.candidateArtifactId,
      candidateContentHash: contentHash,
      candidateContentRef: { ...artifact.contentRef },
      evidenceIds,
      writerKind,
      writerRole: writerOwner.role,
      commitId,
      messageId: candidateCommitSinkId(identity, 'message'),
      blackboardEntryId: blackboardEntryAtIntent.entryId,
      blackboardSequence,
      blackboardRecordedAt,
    }
    if (previous) {
      const bound = Object.fromEntries(Object.keys(base).map(key => [key, previous[key]]))
      if (canonicalJson(bound) !== canonicalJson(base)) {
        throw new Error('LOCAL_RUN_COMMIT_INVALID')
      }
    }
    let candidateCommit = previous || {
      ...base,
      status: 'intent',
      messageStatus: 'pending',
      blackboardStatus: 'pending',
      attempt: 1,
      updatedAt: Date.now(),
    }
    const checkpoint = (phase, nextCommit, collaboration, nextSlots = slots) => {
      candidateCommit = nextCommit
      if (collaboration) {
        controller.orchestration = { ...controller.orchestration, collaboration }
      }
      this.v4CheckpointPhase(group, controller, {
        targetKinds,
        phase,
        batchId,
        snapshotRecord,
        snapshotHash,
        slots: nextSlots,
        writerKind,
        currentKinds: [],
        pendingKinds: [],
        participantKinds,
        receipts: receiptRecords,
        challengeBindings,
        synthesisBinding,
        synthesisRecovery,
        coordinationPlan,
        workReceipts,
        convergence,
        candidateCommit,
      })
    }
    if (!previous) checkpoint('commit', candidateCommit, controller.orchestration?.collaboration)

    const messageInput = {
      messageId: candidateCommit.messageId,
      groupId: group.id,
      agentKind: writerKind,
      threadRootId,
      content,
      metadata: {},
    }
    const existingMessage = this.state().messages.find(message => (
      message.id === candidateCommit.messageId
    ))
    if (candidateCommit.messageStatus === 'committed' && !existingMessage) {
      throw new Error('LOCAL_RUN_COMMIT_INVALID')
    }
    if (controller.signal.aborted) return terminalRunStatusForReason(controller.stopReason)
    if (!this.commitV4AgentMessage) throw new Error('LOCAL_RUN_COMMIT_INVALID')
    const committedMessage = this.commitV4AgentMessage(messageInput)
    if (committedMessage.id !== candidateCommit.messageId) {
      throw new Error('LOCAL_RUN_COMMIT_INVALID')
    }
    if (controller.signal.aborted) return terminalRunStatusForReason(controller.stopReason)
    if (candidateCommit.status === 'intent') {
      candidateCommit = {
        ...candidateCommit,
        status: 'message-committed',
        messageStatus: 'committed',
        updatedAt: Date.now(),
      }
      checkpoint('commit', candidateCommit, controller.orchestration.collaboration)
    }

    let collaboration = controller.orchestration.collaboration || emptyCollaborationState()
    const existingEntry = collaboration.entries.find(entry => (
      entry.entryId === candidateCommit.blackboardEntryId
    ))
    const blackboardEntry = createBlackboardEntryRecord({
      entryType: 'artifact-ref',
      subject: `candidate-commit:${candidateCommit.commitId}`,
      statement: candidateCommitBlackboardStatement(candidateCommit),
      value: contentHash,
      owner: { type: 'agent', agentKind: writerKind, role: candidateCommit.writerRole },
      audience: { roles: [], agentKinds: [...targetKinds].sort() },
      lifecycle: {
        state: 'active',
        sequence: candidateCommit.blackboardSequence,
        recordedAt: candidateCommit.blackboardRecordedAt,
        supersedesEntryId: null,
      },
      provenance: {
        runId: controller.runId,
        taskId: controller.taskId,
        round: controller.currentRound,
        agentRunId: null,
        artifactIds: [acceptance.candidateArtifactId],
        evidenceIds,
      },
      refs: [acceptance.candidateArtifactId, ...evidenceIds],
    })
    if (blackboardEntry.entryId !== candidateCommit.blackboardEntryId) {
      throw new Error('LOCAL_RUN_COMMIT_INVALID')
    }
    if (existingEntry && canonicalJson(existingEntry) !== canonicalJson(blackboardEntry)) {
      throw new Error('LOCAL_RUN_COMMIT_INVALID')
    }
    if (candidateCommit.blackboardStatus === 'committed' && !existingEntry) {
      throw new Error('LOCAL_RUN_COMMIT_INVALID')
    }
    if (controller.signal.aborted) return terminalRunStatusForReason(controller.stopReason)
    if (!existingEntry) {
      const {
        entryId: _entryId,
        version: _version,
        recordType: _recordType,
        ...blackboardInput
      } = blackboardEntry
      collaboration = appendBlackboardEntry(collaboration, blackboardInput)
      const appended = collaboration.entries.find(entry => entry.entryId === blackboardEntry.entryId)
      if (!appended || canonicalJson(appended) !== canonicalJson(blackboardEntry)) {
        throw new Error('LOCAL_RUN_COMMIT_INVALID')
      }
    }
    if (controller.signal.aborted) return terminalRunStatusForReason(controller.stopReason)
    if (candidateCommit.status === 'message-committed') {
      candidateCommit = {
        ...candidateCommit,
        status: 'sinks-committed',
        blackboardStatus: 'committed',
        updatedAt: Date.now(),
      }
      checkpoint('commit', candidateCommit, collaboration)
    }

    if (controller.signal.aborted) return terminalRunStatusForReason(controller.stopReason)
    const finalSlots = slots.map(slot => ({
      ...slot,
      phase: slot.agentKind === writerKind ? 'completed' : slot.phase,
      status: ['failed', 'stopped', 'timeout', 'interrupted'].includes(slot.status)
        ? slot.status : 'completed',
      finishedAt: slot.finishedAt || Date.now(),
      commitStatus: 'committed',
    }))
    candidateCommit = {
      ...candidateCommit,
      status: 'completed',
      messageStatus: 'committed',
      blackboardStatus: 'committed',
      updatedAt: Date.now(),
    }
    checkpoint('completed', candidateCommit, collaboration, finalSlots)
    controller.completedKinds = [...participantKinds]
    controller.failedKinds = targetKinds.filter(kind => !participantKinds.includes(kind))
    controller.currentKind = ''
    controller.progress = []
    this.emitChanged()
    return 'completed'
  },
}

module.exports = { v4ResultMethods }

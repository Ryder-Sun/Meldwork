// The V4 discussion run: snapshot, phases, resume and commit.
const { normalizeFailure } = require('../runs/failure-policy.cjs')
const { commitDeliveryObservable } = require('../collaboration/orchestration-v4-records.cjs')
const { v4Snapshot } = require('./local-workspace-context.cjs')
const { terminalRunStatusForReason } = require('./local-workspace-auto-runner-support.cjs')

const v4DiscussionMethods = {
  async runV4Discussion(group, controller, threadRootId, context, resume = false, resumedGate = null) {
    const snapshotTargetKinds = [...controller.targetKinds]
    const existing = controller.orchestration?.version === 4
      ? controller.orchestration
      : null
    const targetKinds = [...snapshotTargetKinds]
    controller.discussionStyle = existing?.discussionStyle
      || controller.discussionStyle
      || 'sequential'
    let activeKinds = Array.isArray(existing?.activeKinds) && existing.activeKinds.length
      ? existing.activeKinds.filter(kind => targetKinds.includes(kind))
      : [...targetKinds]
    const removedKinds = new Set(targetKinds.filter(kind => !activeKinds.includes(kind)))
    if (existing?.synthesisBinding) {
      throw new Error('LOCAL_RUN_V4_LEGACY_SYNTHESIS_BINDING_UNSUPPORTED')
    }
    let synthesisBinding = existing?.synthesisBinding
      ? {
          ...existing.synthesisBinding,
          candidates: existing.synthesisBinding.candidates.map(candidate => ({
            ...candidate,
            ...(candidate.evidence ? { evidence: { ...candidate.evidence } } : {}),
          })),
          verificationKinds: [...existing.synthesisBinding.verificationKinds],
        }
      : null
    let synthesisRecovery = existing?.synthesisRecovery
      ? {
          ...existing.synthesisRecovery,
          verificationKinds: [...existing.synthesisRecovery.verificationKinds],
          rankedKinds: [...existing.synthesisRecovery.rankedKinds],
          triedWriters: [...existing.synthesisRecovery.triedWriters],
          attempts: existing.synthesisRecovery.attempts.map(attempt => ({ ...attempt })),
          ...(existing.synthesisRecovery.pendingGate
            ? { pendingGate: { ...existing.synthesisRecovery.pendingGate } }
            : {}),
        }
      : null
    let coordinationPlan = existing?.coordinationPlan
      ? {
          ...existing.coordinationPlan,
          assignments: existing.coordinationPlan.assignments.map(assignment => ({
            ...assignment,
            inputRefs: [...assignment.inputRefs],
            artifactIds: [...assignment.artifactIds],
            dependsOn: [...assignment.dependsOn],
          })),
          verifierKinds: [...existing.coordinationPlan.verifierKinds],
          agreedBy: [...existing.coordinationPlan.agreedBy],
          ...(existing.coordinationPlan.supportReceiptIds
            ? { supportReceiptIds: [...existing.coordinationPlan.supportReceiptIds] }
            : {}),
        }
      : null
    const postSynthesisPhases = new Set([
      'synthesis', 'verification', 'human-gate', 'commit', 'committed', 'completed',
    ])
    const synthesisObservable = existing && (
      postSynthesisPhases.has(existing.phase)
      || commitDeliveryObservable(existing.commitState)
      || existing.slots?.some(slot => (
        postSynthesisPhases.has(slot.phase)
        || (slot.resultRefs?.workflowOutcomeRefs || []).some(item => (
          ['synthesis', 'verification'].includes(item?.receipt?.phase)
        ))
      ))
    )
    if (!synthesisBinding && !coordinationPlan && synthesisObservable) {
      throw new Error('LOCAL_RUN_V4_SYNTHESIS_BINDING_REQUIRED')
    }
    let writerKind = synthesisRecovery?.activeWriterKind
      || coordinationPlan?.finalizerKind || synthesisBinding?.writerKind
      || existing?.discussionWriterKind
      || (!existing && this.naturalAgentResponses && group.allowWrite === true
        ? targetKinds.find(kind => this.canWriteWorkspace(kind)) : '') || ''
    controller.currentRound = Math.max(1, controller.currentRound || existing?.round || 0)
    const rootMessage = existing ? null : this.state().messages.find(message => (
      message.id === threadRootId && message.groupId === group.id && message.role === 'user'
    ))
    const snapshot = existing
      ? this.v4LoadSnapshot(existing, {
          taskId: controller.taskId,
          messageId: threadRootId,
          groupId: controller.groupId,
          targetKinds: snapshotTargetKinds,
        })
      : v4Snapshot({
          state: this.state(),
          group,
          taskId: threadRootId,
          targetKinds: snapshotTargetKinds,
          message: rootMessage,
          skillHintsByKind: context.rootSkillsByKind,
          phase: 'proposal',
          writerKind,
        })
    if (existing && this.naturalAgentResponses && !coordinationPlan && !synthesisBinding
        && (snapshot.writerKind || '') !== writerKind) {
      throw new Error('LOCAL_RUN_COLLABORATION_SCOPE_INVALID')
    }
    if (existing) {
      const persistedSkills = this.v4SnapshotSkillHints(snapshot, snapshotTargetKinds)
      const hasPersistedSkills = snapshotTargetKinds.some(kind => (
        (persistedSkills.get(kind) || []).length > 0
      ))
      context = {
        rootAttachments: [],
        rootSkillsByKind: hasPersistedSkills
          ? await this.v4RestoreSnapshotSkills(snapshot, snapshotTargetKinds, persistedSkills)
          : persistedSkills,
        rootKnowledgeBasesByKind: new Map(snapshotTargetKinds.map(kind => [kind, []])),
      }
    }
    const builtSnapshot = existing
      ? { record: existing.snapshot, snapshotHash: existing.snapshotHash }
      : this.v4SnapshotRecord(controller, snapshot, snapshotTargetKinds)
    const snapshotRecord = builtSnapshot.record
    const snapshotHash = builtSnapshot.snapshotHash
    const batchId = existing?.batchId || this.v4BatchId(controller, 'discussion')
    const receiptRecords = this.v4RestoreReceipts(controller)
    let workReceipts = Array.isArray(existing?.workReceipts)
      ? existing.workReceipts.map(receipt => ({
          ...receipt,
          snapshotContentRef: { ...receipt.snapshotContentRef },
          collaborationReceipt: { ...receipt.collaborationReceipt },
          artifacts: receipt.artifacts.map(artifact => ({
            ...artifact,
            contentRef: { ...artifact.contentRef },
          })),
        }))
      : []
    controller.v4WorkReceipts = workReceipts
    let challengeBindings = Array.isArray(existing?.challengeBindings)
      ? existing.challengeBindings.map(binding => ({
          ...binding,
          artifactIds: [...binding.artifactIds],
          evidenceIds: [...binding.evidenceIds],
        }))
      : null
    controller.v4Watermarks = existing?.deliveryWatermarks
      ? existing.deliveryWatermarks.map(item => ({ ...item }))
      : []
    const initialSlots = existing?.slots?.length
      ? existing.slots.map(slot => ({ ...slot }))
      : targetKinds.map((kind, index) => ({
          slotId: `slot-${index + 1}-${kind}`,
          agentKind: kind,
          phase: 'proposal',
          status: 'planned',
          operationId: this.v4OperationId(
            controller, kind, 'proposal', `slot-${index + 1}-${kind}`,
          ),
          queuePosition: index,
          snapshotHash,
          deliveryWatermark: 0,
          receiptId: '',
          resultHash: '',
          assignedAt: Date.now(),
          startedAt: Date.now(),
          finishedAt: null,
          commitStatus: 'pending',
          attempt: 0,
          permission: 'read-only',
          resultRefs: { artifactIds: [], evidenceIds: [], workflowOutcomeRefs: [] },
        }))
    let slots = initialSlots
    if (!existing) {
      this.v4CheckpointPhase(group, controller, {
        targetKinds,
        participantKinds: activeKinds,
        phase: 'proposal',
        batchId,
        snapshotRecord,
        snapshotHash,
        slots,
        writerKind,
        currentKinds: targetKinds,
        pendingKinds: targetKinds,
        receipts: receiptRecords,
      })
      this.emitChanged()
    }

    const latestFor = (phase, kind) => this.v4LatestReceipt(receiptRecords, phase, kind)
    const pendingKindsFor = (phase, activeKinds, workAssignments = []) => activeKinds.filter(kind => {
      if (phase === 'work') {
        const assignment = workAssignments.find(candidate => candidate.ownerKind === kind)
        return !assignment || !workReceipts.some(receipt => (
          receipt.planHash === coordinationPlan.planHash
          && receipt.taskId === assignment.taskId
          && receipt.ownerKind === kind
        ))
      }
      const latest = latestFor(phase, kind)
      if (!latest) return true
      if (phase === 'proposal') return false
      const slot = slots.find(candidate => candidate.agentKind === kind)
      const synthesisAttempt = phase === 'synthesis'
        ? [...(synthesisRecovery?.attempts || [])].reverse().find(attempt => (
            attempt.writerKind === kind
          ))
        : null
      const expected = synthesisAttempt?.operationId || (slot
        ? this.v4OperationId(controller, kind, phase, slot.slotId)
        : '')
      return latest.receipt.operationId !== expected
    })
    const checkpointPhase = (phase, activeKinds, phaseSlots = slots, bindings = challengeBindings) => {
      this.v4CheckpointPhase(group, controller, {
        targetKinds,
        participantKinds: activeKindsForRun(),
        phase,
        batchId,
        snapshotRecord,
        snapshotHash,
        slots: phaseSlots,
        writerKind,
        currentKinds: [...activeKinds],
        pendingKinds: [...activeKinds],
        receipts: receiptRecords,
        challengeBindings: bindings,
        synthesisBinding,
        synthesisRecovery,
        coordinationPlan,
        workReceipts,
      })
    }
    const activeKindsForRun = () => [...activeKinds]
    const runPhase = async (phase, requestedKinds, bindings = challengeBindings, options = {}) => {
      const workAssignments = Array.isArray(options.workAssignments)
        ? options.workAssignments
        : []
      const pending = pendingKindsFor(phase, requestedKinds, workAssignments)
      if (!pending.length) {
        checkpointPhase(phase, [], slots)
        return { ok: true, phaseReceipts: [], synthesisPendingMessage: null }
      }
      const runPending = async (phaseKinds) => {
        const result = await this.runV4Phase(group, controller, threadRootId, context, {
          phase,
          activeKinds: phaseKinds,
          targetKinds,
          participantKinds: activeKindsForRun(),
          writerKind,
          batchId,
          snapshot,
          snapshotRecord,
          snapshotHash,
          slots,
          receiptRecords,
          challengeBindings: bindings,
          synthesisBinding,
          synthesisRecovery,
          coordinationPlan,
          workReceipts,
          deliveryReceiptRecords: options.deliveryReceiptRecords,
          coordinationText: options.coordinationText || '',
          workAssignments,
          resumedGate,
        })
        slots = result.slots
        if (result.synthesisRecovery) synthesisRecovery = result.synthesisRecovery
        if (result.workReceipts) {
          workReceipts = result.workReceipts
          controller.v4WorkReceipts = workReceipts
        }
        return result
      }
      if (!['challenge', 'verification'].includes(phase) || pending.length <= 1) {
        return runPending(pending)
      }
      const aggregate = {
        slots,
        receiptRecords,
        phaseReceipts: [],
        phasePendingMessages: [],
        failures: [],
        synthesisPendingMessage: null,
        ok: true,
      }
      for (const kind of pending) {
        const result = await runPending([kind])
        aggregate.slots = result.slots
        aggregate.phaseReceipts.push(...(result.phaseReceipts || []))
        aggregate.phasePendingMessages.push(...(result.phasePendingMessages || []))
        aggregate.failures.push(...(result.failures || []))
        if (!result.ok) aggregate.ok = false
      }
      return aggregate
    }
    const commitPhaseMessages = (phase, result) => {
      // Proposal/work runners commit each pending Agent message at the same
      // time they persist its receipt and slot. Replaying those messages here
      // creates a second commit attempt with live metadata and can reject a
      // valid first-round result as LOCAL_RUN_COMMIT_INVALID.
      return (result?.phasePendingMessages || []).filter(item => (
        item?.pendingMessage?.content && item.kind
      )).length
    }
    const removePhaseFailures = (result) => {
      const failedKinds = [...new Set((result?.failures || [])
        .filter((item) => {
          const failure = normalizeFailure(item.error)
          return !['budget', 'cancellation', 'permission'].includes(failure.category)
            && !failure.code.startsWith('COLLABORATION_CONTROL_')
        })
        .map(item => item.kind)
        .filter(Boolean))]
      const removed = []
      for (const kind of failedKinds) {
        const failure = (result?.failures || []).find(item => item.kind === kind)?.error
        // Every failure is a run-scoped exclusion. Group membership is never
        // edited, so a later turn can use the Agent again.
        const didRemove = this.shouldPauseFailedAgent(failure)
          ? this.pauseFailedAgentForRun(group, controller, kind, threadRootId, failure)
          : false
        // The failed slot is still isolated from this run's active queue even
        // when its configured group membership is retained.
        removed.push(kind)
        if (didRemove) {
          removedKinds.add(kind)
        }
      }
      return removed
    }
    const finalStatus = (status) => {
      if (status !== 'completed') return status
      if (!removedKinds.size && !controller.failedKinds.length) return status
      controller.failedKinds = [...new Set([...controller.failedKinds, ...removedKinds])]
      return 'partial'
    }
    const addRoundLimitNotice = () => {
      if (this.state().messages.some(message => (
        message.threadRootId === threadRootId
          && message.system?.key === 'system.autoRoundLimit'
      ))) return
      this.addMessage(
        group.id,
        'system',
        `Automatic discussion reached its ${controller.maxRounds || 6}-round limit. The latest replies above are the current result.`,
        '',
        threadRootId,
        { key: 'system.autoRoundLimit', params: { rounds: controller.maxRounds || 6 } },
      )
    }
    const requestStableGate = async (convergence) => {
      if (!this.requestHumanGate) return 'round-limit'
      const gateAgentRunId = this.v4OperationId(controller, writerKind, 'human-gate',
        slots.find(slot => slot.agentKind === writerKind)?.slotId || '')
      const publicAgentRunId = slots.find(slot => slot.agentKind === writerKind)?.agentRunId || ''
      checkpointPhase('human-gate', [], slots)
      const gate = await this.requestHumanGate({
        type: 'decision',
        runId: controller.runId,
        agentRunId: gateAgentRunId,
        agentKind: writerKind,
        summary: 'The candidate and unresolved issues have remained unchanged for two rounds.',
        options: [
          { optionId: 'continue-discussion', name: 'Continue', kind: 'accept' },
          { optionId: 'stop-discussion', name: 'Stop', kind: 'reject' },
        ],
        request: {
          phase: 'discussion',
          round: convergence.lastCompletedRound,
          candidateHash: convergence.candidateContentHash,
          unresolvedIssueIds: [...convergence.openIssueIds],
          stateEpoch: convergence.stateEpoch,
        },
      }, {
        signal: controller.signal,
        preserveOnAbort: () => controller.stopReason === 'shutdown',
        continuation: {
          resumeKind: 'v4_human_gate',
          agentRunId: gateAgentRunId,
          ...(publicAgentRunId ? { publicAgentRunId } : {}),
          agentKind: writerKind,
          round: convergence.lastCompletedRound,
          stateEpoch: convergence.stateEpoch,
        },
      })
      if (gate.status !== 'approved') {
        if (gate.gateId) this.completeHumanGateContinuation?.(
          controller.runId, gate.gateId, 'cancelled',
        )
        return 'stopped'
      }
      const current = controller.orchestration?.convergence
      if (!current || current.stateEpoch !== convergence.stateEpoch
          || current.stateKey !== convergence.stateKey) {
        throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
      }
      controller.orchestration = {
        ...controller.orchestration,
        convergence: { ...current, acknowledgedGateEpoch: current.stateEpoch },
      }
      if (gate.gateId && this.completeHumanGateContinuation?.(
        controller.runId, gate.gateId, 'completed',
      ) !== true && this.hasRunLedger()) throw new Error('LOCAL_RUN_PERSIST_FAILED')
      return 'continue'
    }
    const requestSynthesisRecoveryGate = async () => {
      const binding = synthesisRecovery?.pendingGate
      if (!binding || !this.requestHumanGate) return 'failed'
      const publicAgentRunId = slots.find(slot => (
        slot.slotId === binding.slotId && slot.agentKind === binding.writerKind
      ))?.agentRunId || ''
      const permissionContinuation = controller.continuation
      if (permissionContinuation?.gateType === 'permission'
          && permissionContinuation.resumeKind === 'agent_slot'
          && permissionContinuation.phase === 'synthesis'
          && permissionContinuation.agentKind === binding.writerKind
          && permissionContinuation.slotId === binding.slotId
          && permissionContinuation.operationId === binding.operationId) {
        if (this.completeHumanGateContinuation?.(
          controller.runId, permissionContinuation.gateId, 'completed',
        ) !== true && this.hasRunLedger()) throw new Error('LOCAL_RUN_PERSIST_FAILED')
      }
      slots = slots.map(slot => slot.status === 'running'
        ? { ...slot, status: 'waiting' }
        : slot)
      checkpointPhase('human-gate', [], slots)
      const gate = await this.requestHumanGate({
        type: 'decision',
        runId: controller.runId,
        agentRunId: binding.operationId,
        agentKind: binding.writerKind,
        summary: 'The workspace-write synthesis attempt may have produced side effects, but its result is unknown.',
        options: [
          { optionId: 'retry-original-writer', name: 'Retry original writer', kind: 'accept' },
          ...(binding.proposedReplacementKind ? [{
            optionId: 'replace-next-writer', name: 'Replace with next writer', kind: 'accept',
          }] : []),
          { optionId: 'stop-discussion', name: 'Stop', kind: 'reject' },
        ],
        request: {
          phase: 'synthesis-recovery',
          bindingHash: binding.bindingHash,
          writerKind: binding.writerKind,
          slotId: binding.slotId,
          operationId: binding.operationId,
          attempt: binding.attempt,
          proposedReplacementKind: binding.proposedReplacementKind,
          round: binding.round,
          stateEpoch: binding.stateEpoch,
          outcomeCertainty: 'unknown_outcome',
        },
      }, {
        signal: controller.signal,
        preserveOnAbort: () => controller.stopReason === 'shutdown',
        continuation: {
          resumeKind: 'v4_synthesis_recovery',
          agentRunId: binding.operationId,
          ...(publicAgentRunId ? { publicAgentRunId } : {}),
          agentKind: binding.writerKind,
          round: binding.round,
          stateEpoch: binding.stateEpoch,
        },
      })
      if (gate.status !== 'approved' || gate.optionId === 'stop-discussion') {
        synthesisRecovery = this.v4CancelSynthesisRecovery(synthesisRecovery)
        checkpointPhase('human-gate', [], slots)
        if (gate.gateId) this.completeHumanGateContinuation?.(
          controller.runId, gate.gateId, 'cancelled',
        )
        return 'stopped'
      }
      if (!['retry-original-writer', 'replace-next-writer'].includes(gate.optionId)) {
        throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
      }
      const nextWriterKind = gate.optionId === 'replace-next-writer'
        ? binding.proposedReplacementKind
        : binding.writerKind
      if (!nextWriterKind) throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
      if (gate.gateId && this.completeHumanGateContinuation?.(
        controller.runId, gate.gateId, 'completed',
      ) !== true && this.hasRunLedger()) throw new Error('LOCAL_RUN_PERSIST_FAILED')
      synthesisRecovery = this.v4AppendSynthesisAttempt(
        controller, coordinationPlan || synthesisBinding, synthesisRecovery, slots, nextWriterKind,
      )
      writerKind = synthesisRecovery.activeWriterKind
      const nextAttempt = this.v4ActiveSynthesisAttempt(synthesisRecovery)
      slots = slots.map((slot) => {
        if (slot.agentKind !== writerKind) return { ...slot, permission: 'read-only' }
        const { agentRunId: _agentRunId, ...retainedSlot } = slot
        return {
          ...retainedSlot,
          phase: 'synthesis',
          status: 'planned',
          operationId: nextAttempt.operationId,
          receiptId: '',
          resultHash: '',
          finishedAt: null,
          commitStatus: 'pending',
          permission: group.allowWrite === true ? 'workspace-write' : 'read-only',
        }
      })
      checkpointPhase('synthesis', [writerKind], slots)
      return 'continue'
    }

    let round = Math.max(1, Number(existing?.round) || controller.currentRound || 1)
    const acknowledgedGateResume = resume === true
      && existing?.phase === 'challenge'
      && existing.convergence?.acknowledgedGateEpoch === existing.convergence?.stateEpoch
      && existing.convergence?.lastCompletedRound === round
      && controller.continuation?.resumeKind === 'v4_human_gate'
      && controller.continuation?.state === 'completed'
    if (acknowledgedGateResume) {
      this.assertV4PhaseCanAdvance(controller)
      round += 1
      controller.currentRound = round
      challengeBindings = null
    }
    let proposalComplete = activeKinds.every(kind => Boolean(latestFor('proposal', kind)))
    const legacyBoundRun = Boolean(synthesisBinding && !coordinationPlan)
    const postChallengePhases = new Set([
      'coordination', 'work', 'synthesis', 'verification',
      'human-gate', 'commit', 'committed', 'completed',
    ])
    const challengeObservable = existing && (
      postChallengePhases.has(existing.phase)
      || existing.slots?.some(slot => (
        (slot.phase === 'challenge' && slot.status !== 'planned')
        || postChallengePhases.has(slot.phase)
        || (slot.resultRefs?.workflowOutcomeRefs || []).some(item => (
          item?.receipt?.phase === 'challenge'
        ))
      ))
    )
    if (!coordinationPlan && !legacyBoundRun
        && !challengeBindings && challengeObservable && !acknowledgedGateResume) {
      throw new Error('LOCAL_RUN_V4_CHALLENGE_BINDING_REQUIRED')
    }
    if (!coordinationPlan && !legacyBoundRun
        && challengeBindings?.some(binding => binding.round !== round)) {
      throw new Error('LOCAL_RUN_V4_CHALLENGE_BINDING_INVALID')
    }
    if (existing?.candidateCommit) {
      const verificationKinds = synthesisRecovery?.verificationKinds
        || coordinationPlan?.verifierKinds
        || synthesisBinding?.verificationKinds
        || []
      const validationSlots = slots.map(slot => (
        slot.agentKind === writerKind && slot.phase === 'completed'
          ? { ...slot, phase: 'synthesis' }
          : slot
      ))
      const acceptance = this.v4Acceptance(
        receiptRecords, activeKinds, writerKind, verificationKinds,
        {
          runId: controller.runId,
          round,
          slots: validationSlots,
          challengeBindings,
          previousConvergence: null,
          coordinationPlan,
          workReceipts,
        },
      )
      if (!acceptance.accepted
          || acceptance.candidateArtifactId !== existing.candidateCommit.candidateArtifactId
          || acceptance.candidateHash !== existing.candidateCommit.candidateContentHash) {
        throw new Error('LOCAL_RUN_V4_CANDIDATE_INVALID')
      }
      return this.v4CommitAcceptedCandidate({
        group, controller, threadRootId, targetKinds, batchId, snapshotRecord, snapshotHash,
        slots, receiptRecords, challengeBindings, synthesisBinding, synthesisRecovery,
        coordinationPlan, workReceipts, convergence: existing.convergence,
        writerKind, verificationKinds, acceptance, participantKinds: activeKinds,
      })
    }
    if (this.naturalAgentResponses && !coordinationPlan && !synthesisBinding && !synthesisRecovery) {
      return this.runV4NaturalDiscussion(group, controller, threadRootId, context, {
        resume,
        resumedGate,
        targetKinds,
        activeKinds,
        writerKind,
        batchId,
        snapshot,
        snapshotRecord,
        snapshotHash,
        slots,
        receiptRecords,
        latestFor,
        runPhase,
        checkpointPhase,
        removePhaseFailures,
        addRoundLimitNotice,
      })
    }
    while (!controller.signal.aborted) {
      controller.currentRound = round
      if (!proposalComplete) {
        const proposal = await runPhase('proposal', activeKinds)
        commitPhaseMessages('proposal', proposal)
        if (!proposal.ok) {
          const failedKinds = removePhaseFailures(proposal)
          activeKinds = activeKinds.filter(kind => !failedKinds.includes(kind))
          checkpointPhase('proposal', [], slots)
          if (!failedKinds.length || activeKinds.length < 2) {
            return proposal.phasePendingMessages?.length ? 'partial' : 'failed'
          }
        }
        proposalComplete = activeKinds.every(kind => Boolean(latestFor('proposal', kind)))
        if (!proposalComplete) {
          return activeKinds.some(kind => Boolean(latestFor('proposal', kind))) ? 'partial' : 'failed'
        }
      }

      if (!coordinationPlan && !legacyBoundRun) {
        if (round === 1) {
          if (!controller.unlimitedRounds && round >= (controller.maxRounds || 6)) {
            addRoundLimitNotice()
            return 'round-limit'
          }
          this.assertV4PhaseCanAdvance(controller)
          round = 2
          controller.currentRound = round
        }

        if (!challengeBindings || challengeBindings[0]?.round !== round) {
          const activeSet = new Set(activeKinds)
          slots = slots.map((slot) => {
            if (!activeSet.has(slot.agentKind)) return slot
            const { agentRunId: _agentRunId, ...retainedSlot } = slot
            return {
              ...retainedSlot,
              phase: 'challenge',
              status: 'planned',
              operationId: this.v4OperationId(
                controller, slot.agentKind, 'challenge', slot.slotId,
              ),
              receiptId: '',
              resultHash: '',
              startedAt: Date.now(),
              finishedAt: null,
              commitStatus: 'pending',
              permission: 'read-only',
            }
          })
          challengeBindings = this.v4ChallengeBindings({
            controller,
            targetKinds: activeKinds,
            round,
            snapshotRecord,
            slots,
            receiptRecords,
          })
          checkpointPhase('challenge', activeKinds, slots, challengeBindings)
          this.emitChanged()
        }

        const knownCoordination = this.v4CoordinationResult({
          receiptRecords,
          targetKinds: activeKinds,
          snapshotHash,
          snapshot,
          requireSupport: false,
        })
        const challenge = await runPhase('challenge', activeKinds, challengeBindings, {
          coordinationText: this.v4CoordinationText(knownCoordination),
        })
        commitPhaseMessages('challenge', challenge)
        if (!challenge.ok) {
          if (controller.signal.aborted) return 'stopped'
          const failedKinds = removePhaseFailures(challenge)
          activeKinds = activeKinds.filter(kind => !failedKinds.includes(kind))
          if (!failedKinds.length || activeKinds.length < 2
              || (!controller.unlimitedRounds && round >= (controller.maxRounds || 6))) {
            return challenge.phasePendingMessages?.length ? 'partial' : 'failed'
          }
          this.assertV4PhaseCanAdvance(controller)
          round += 1
          controller.currentRound = round
          challengeBindings = null
          this.emitChanged()
          continue
        }
        if (controller.signal.aborted) return terminalRunStatusForReason(controller.stopReason)

        const coordination = this.v4CoordinationResult({
          receiptRecords,
          targetKinds: activeKinds,
          snapshotHash,
          snapshot,
          challengeBindings,
        })
        if (!coordination.plan) {
          if (!controller.unlimitedRounds && round >= (controller.maxRounds || 6)) {
            addRoundLimitNotice()
            return 'round-limit'
          }
          this.assertV4PhaseCanAdvance(controller)
          round += 1
          controller.currentRound = round
          challengeBindings = null
          this.emitChanged()
          continue
        }
        coordinationPlan = coordination.plan
        writerKind = coordinationPlan.finalizerKind
        this.v4CheckpointPhase(group, controller, {
          targetKinds,
          participantKinds: activeKinds,
          phase: 'coordination',
          batchId,
          snapshotRecord,
          snapshotHash,
          slots,
          writerKind,
          currentKinds: [],
          pendingKinds: [],
          receipts: receiptRecords,
          challengeBindings,
          coordinationPlan,
        })
        this.emitChanged()
      }

      if (coordinationPlan) {
        while (!controller.signal.aborted) {
          const workState = this.v4WorkState(workReceipts, coordinationPlan)
          if (!workState.pending.length) break
          if (!workState.ready.length) return 'failed'
          const readyAssignments = []
          const readyOwners = new Set()
          for (const assignment of workState.ready) {
            if (readyOwners.has(assignment.ownerKind)) continue
            readyOwners.add(assignment.ownerKind)
            readyAssignments.push(assignment)
          }
          const readyKinds = activeKinds.filter(kind => readyOwners.has(kind))
          const completedBefore = workState.completed.size
          const work = await runPhase('work', readyKinds, challengeBindings, {
            deliveryReceiptRecords: [...receiptRecords],
            workAssignments: readyAssignments,
          })
          if (!work.ok) return controller.signal.aborted ? 'stopped' : 'failed'
          const completedAfter = this.v4WorkState(workReceipts, coordinationPlan).completed.size
          if (completedAfter <= completedBefore) return 'failed'
        }
        if (controller.signal.aborted) return terminalRunStatusForReason(controller.stopReason)
        writerKind = coordinationPlan.finalizerKind
      } else {
        writerKind = synthesisRecovery?.activeWriterKind || synthesisBinding.writerKind
      }

      const roleBinding = coordinationPlan || synthesisBinding
      if (!roleBinding) return 'failed'
      if (!synthesisRecovery) {
        synthesisRecovery = this.v4CreateSynthesisRecovery(
          controller,
          roleBinding,
          slots,
          { stateEpoch: controller.orchestration?.convergence?.stateEpoch || 0 },
        )
        writerKind = synthesisRecovery.activeWriterKind
      } else if (!this.v4ActiveSynthesisAttempt(synthesisRecovery)) {
        const latestAttempt = synthesisRecovery.attempts.at(-1)
        const currentRoundOperationId = latestAttempt
          ? this.v4SynthesisAttemptOperationId(
              controller,
              latestAttempt.writerKind,
              latestAttempt.slotId,
              latestAttempt.attempt,
            )
          : ''
        if (latestAttempt?.status === 'completed'
            && latestAttempt.operationId !== currentRoundOperationId) {
          synthesisRecovery = this.v4AppendSynthesisAttempt(
            controller,
            roleBinding,
            synthesisRecovery,
            slots,
            synthesisRecovery.activeWriterKind,
          )
        }
      }
      let activeAttempt = this.v4ActiveSynthesisAttempt(synthesisRecovery)
      if (activeAttempt?.status === 'leased'
          && activeAttempt.permission === 'workspace-write'
          && activeAttempt.leaseAcquired === true) {
        const acceptedReceipt = this.v4TrustedSynthesisResult({
          controller,
          slots,
          activeAttempt,
          synthesisRecovery,
          coordinationPlan,
          snapshotHash,
        })
        if (!acceptedReceipt) {
          synthesisRecovery = this.v4UpdateSynthesisAttempt(
            synthesisRecovery,
            activeAttempt.operationId,
            {
              status: 'unknown_outcome',
              sideEffectsPossible: true,
              outcomeCertainty: 'unknown_outcome',
            },
          )
          synthesisRecovery = {
            ...synthesisRecovery,
            pendingGate: this.v4SynthesisRecoveryGate(controller, synthesisRecovery),
          }
          activeAttempt = this.v4ActiveSynthesisAttempt(synthesisRecovery)
        }
      }
      if (activeAttempt?.status === 'unknown_outcome') {
        if (!synthesisRecovery.pendingGate) {
          synthesisRecovery = {
            ...synthesisRecovery,
            pendingGate: this.v4SynthesisRecoveryGate(controller, synthesisRecovery),
          }
        }
        const recoveryResult = await requestSynthesisRecoveryGate()
        if (recoveryResult !== 'continue') return recoveryResult
      }
      let verificationKinds = [...synthesisRecovery.verificationKinds]
      let synthesis = null
      while (!controller.signal.aborted) {
        writerKind = synthesisRecovery.activeWriterKind
        verificationKinds = [...synthesisRecovery.verificationKinds]
        synthesis = await runPhase('synthesis', [writerKind])
        if (synthesis.ok) break
        if (controller.signal.aborted) return 'stopped'
        const failedAttempt = [...synthesisRecovery.attempts].reverse()[0]
        if (failedAttempt?.status === 'unknown_outcome') {
          const recoveryResult = await requestSynthesisRecoveryGate()
          if (recoveryResult !== 'continue') return recoveryResult
          continue
        }
        const replacement = coordinationPlan
          ? null
          : this.v4ReplaceSynthesisWriter(
              controller, synthesisBinding, synthesisRecovery, slots,
            )
        if (!replacement) return 'failed'
        synthesisRecovery = replacement
        writerKind = replacement.activeWriterKind
        verificationKinds = [...replacement.verificationKinds]
      }
      if (!synthesis?.ok) return controller.signal.aborted ? 'stopped' : 'failed'
      let synthesisPendingMessage = synthesis.synthesisPendingMessage
      const synthesisReceipt = latestFor('synthesis', writerKind)
      if (!synthesisPendingMessage && synthesisReceipt) {
        const candidateArtifactId = synthesisReceipt.receipt.artifactIds?.[0]
        let candidateContent = ''
        if (candidateArtifactId) {
          try { candidateContent = this.v4ArtifactIdentity(candidateArtifactId).content } catch {}
        }
        synthesisPendingMessage = {
          groupId: group.id,
          role: 'agent',
          content: candidateContent
            || synthesisReceipt.receipt.conclusion
            || synthesisReceipt.receipt.summary,
          agentKind: writerKind,
          threadRootId,
          system: null,
          metadata: {},
        }
      }
      if (!synthesisPendingMessage) return 'failed'
      const previousConvergence = controller.orchestration?.convergence || null
      this.v4RoundState(
        receiptRecords, activeKinds, writerKind, verificationKinds,
        {
          runId: controller.runId,
          round,
          slots,
          challengeBindings,
          previousConvergence,
          coordinationPlan,
          includeVerification: false,
        },
      )
      const verification = await runPhase('verification', verificationKinds)
      if (!verification.ok) return controller.signal.aborted ? 'stopped' : 'partial'

      const acceptance = this.v4Acceptance(
        receiptRecords, activeKinds, writerKind, verificationKinds,
        {
          runId: controller.runId,
          round,
          slots,
          challengeBindings,
          previousConvergence,
          coordinationPlan,
          workReceipts,
        },
      )
      const convergence = this.v4NextConvergence(
        previousConvergence,
        {
          artifactId: acceptance.candidateArtifactId,
          contentHash: acceptance.candidateHash,
        },
        acceptance.openIssueIds,
        round,
        writerKind,
      )
      this.v4CheckpointPhase(group, controller, {
        targetKinds,
        participantKinds: activeKinds,
        phase: 'verification',
        batchId,
        snapshotRecord,
        snapshotHash,
        slots,
        writerKind,
        currentKinds: [],
        pendingKinds: [],
        receipts: receiptRecords,
        challengeBindings,
        synthesisBinding,
        coordinationPlan,
        convergence,
      })
      const acceptedStable = controller.unlimitedRounds
        ? convergence.consecutiveStableRounds >= 2
        : round >= (controller.maxRounds || 6)
      if (acceptance.accepted && acceptedStable) {
        return finalStatus(await this.v4CommitAcceptedCandidate({
          group, controller, threadRootId, targetKinds, batchId, snapshotRecord, snapshotHash,
          slots, receiptRecords, challengeBindings, synthesisBinding, synthesisRecovery,
          coordinationPlan, workReceipts, convergence,
          writerKind, verificationKinds, acceptance, participantKinds: activeKinds,
        }))
      }

      if (this.v4ShouldOpenStableGate(convergence, controller.unlimitedRounds)) {
        const gateResult = await requestStableGate(convergence)
        if (gateResult !== 'continue') return gateResult
      }
      if (!controller.unlimitedRounds && round >= (controller.maxRounds || 6)) {
        addRoundLimitNotice()
        return 'round-limit'
      }
      if (controller.signal.aborted) break
      this.assertV4PhaseCanAdvance(controller)
      round += 1
      controller.currentRound = round
      if (coordinationPlan) {
        challengeBindings = null
        if (Object.hasOwn(controller.orchestration || {}, 'challengeBindings')) {
          const { challengeBindings: _challengeBindings, ...orchestration } = controller.orchestration
          controller.orchestration = orchestration
        }
      }
      this.emitChanged()
    }
    return terminalRunStatusForReason(controller.stopReason)
  },
}

module.exports = { v4DiscussionMethods }

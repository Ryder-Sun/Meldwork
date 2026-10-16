// Running one V4 phase for a set of Agents.
const { collaborationPackageIndexText, emptyCollaborationState } = require('../collaboration/collaboration-records.cjs')
const { hashValue } = require('../collaboration/orchestration-v4-records.cjs')
const { stalePermissionResumeFailure } = require('./local-workspace-auto-runner-support.cjs')

const v4PhaseMethods = {
  v4PhaseAdvanceBlocked(controller) {
    const orchestration = controller.orchestration
    const continuation = controller.continuation
    return orchestration?.version === 4
      && continuation?.resumeKind === 'agent_slot'
      && continuation.phase === orchestration.phase
      && continuation.round === orchestration.round
      // `resuming` means the gate decision has already been accepted and the
      // continuation is actively replaying the gated slot. Blocking that
      // state makes the resume path fail with its own phase-gate error.
      && ['pending', 'ready'].includes(continuation.state)
  },

  assertV4PhaseCanAdvance(controller) {
    if (this.v4PhaseAdvanceBlocked(controller)) {
      throw new Error('LOCAL_RUN_V4_PHASE_GATE_PENDING')
    }
  },

  v4PhaseSlots({ controller, targetKinds, phase, activeKinds, slots, snapshotHash,
    writerKind, operationIds = null, allowWrite = false, now = Date.now() }) {
    const active = new Set(activeKinds)
    return slots.map((slot, index) => {
      const running = active.has(slot.agentKind)
      const previousHistory = Array.isArray(slot.resultRefs?.workflowOutcomeRefs)
        ? slot.resultRefs.workflowOutcomeRefs
        : []
      const operationId = running
        ? (operationIds?.get(slot.agentKind)
          || this.v4OperationId(controller, slot.agentKind, phase, slot.slotId))
        : slot.operationId
      const { agentRunId: previousAgentRunId, ...retainedSlot } = slot
      return {
        ...retainedSlot,
        ...(!running && operationId === slot.operationId && previousAgentRunId
          ? { agentRunId: previousAgentRunId }
          : {}),
        slotId: slot.slotId || `slot-${index + 1}-${slot.agentKind}`,
        phase: running ? phase : (slot.phase || phase),
        status: running ? 'planned' : (slot.status || 'completed'),
        operationId,
        queuePosition: index,
        snapshotHash,
        deliveryWatermark: Number(slot.deliveryWatermark) || 0,
        receiptId: running ? '' : (slot.receiptId || ''),
        resultHash: running ? '' : (slot.resultHash || ''),
        assignedAt: slot.assignedAt || now,
        startedAt: running ? now : (slot.startedAt || now),
        finishedAt: running ? null : (slot.finishedAt || now),
        commitStatus: running ? 'pending' : (slot.commitStatus || 'committed'),
        attempt: (Number.isSafeInteger(slot.attempt) ? slot.attempt : 0) + (running ? 1 : 0),
        permission: allowWrite && slot.agentKind === writerKind
          && (phase === 'synthesis' || (this.naturalAgentResponses && phase === 'discussion'))
          ? 'workspace-write'
          : 'read-only',
        resultRefs: {
          artifactIds: Array.isArray(slot.resultRefs?.artifactIds)
            ? [...slot.resultRefs.artifactIds]
            : [],
          evidenceIds: Array.isArray(slot.resultRefs?.evidenceIds)
            ? [...slot.resultRefs.evidenceIds]
            : [],
          workflowOutcomeRefs: [...previousHistory],
        },
      }
    })
  },

  v4CheckpointPhase(group, controller, {
    targetKinds, phase, batchId, snapshotRecord, snapshotHash, slots,
    writerKind, currentKinds = [], pendingKinds = [], receipts = [], commitState = null,
    participantKinds = targetKinds,
    challengeBindings = controller.orchestration?.round === controller.currentRound
      ? controller.orchestration?.challengeBindings
      : null,
    synthesisBinding = controller.orchestration?.synthesisBinding || null,
    synthesisRecovery = controller.orchestration?.synthesisRecovery || null,
    convergence = controller.orchestration?.convergence || null,
    coordinationPlan = controller.orchestration?.coordinationPlan || null,
    workReceipts = controller.orchestration?.workReceipts || [],
    candidateCommit = controller.orchestration?.candidateCommit || null,
    workAssignments = [],
  }) {
    const current = controller.orchestration
    const naturalWriterKind = this.naturalAgentResponses && ['proposal', 'discussion'].includes(phase)
      && !coordinationPlan && !synthesisBinding ? writerKind : ''
    if (current?.version === 4
        && (current.phase !== phase || current.round !== controller.currentRound)) {
      this.assertV4PhaseCanAdvance(controller)
    }
    const workAssignmentsByKind = new Map(workAssignments.map(assignment => (
      [assignment.ownerKind, assignment]
    )))
    const assignments = slots.map((slot, index) => ({
      agentKind: slot.agentKind,
      slotId: slot.slotId,
      role: this.v4CheckpointRole(
        phase, slot, coordinationPlan, workAssignmentsByKind.get(slot.agentKind) || null,
      ),
      operationId: slot.operationId,
      objective: phase === 'proposal'
        ? 'Produce an independent bounded proposal.'
        : (phase === 'work' && workAssignmentsByKind.has(slot.agentKind)
          ? workAssignmentsByKind.get(slot.agentKind).objective
          : `Complete the ${phase} collaboration phase using the peer-agreed responsibility plan.`),
      expectedOutput: phase === 'work' && workAssignmentsByKind.has(slot.agentKind)
        ? workAssignmentsByKind.get(slot.agentKind).expectedOutput
        : 'Return a concise structured collaboration result.',
      inputRefs: receipts.map(item => item.receipt?.receiptId).filter(Boolean).slice(-64),
      readOnly: slot.permission !== 'workspace-write',
      index,
    }))
    const plan = {
      version: 1,
      snapshotHash,
      assignments: assignments.map(({ index: _index, ...assignment }) => assignment),
      createdAt: snapshotRecord.capturedAt,
      barrier: 'phase',
    }
    const watermarks = Array.isArray(controller.v4Watermarks)
      ? controller.v4Watermarks
      : []
    const commit = commitState || {
      status: 'pending',
      writerKind: naturalWriterKind ? null : writerKind || null,
      committedKinds: [],
      pendingKinds: [...participantKinds],
      operationId: '',
      attempt: 0,
      updatedAt: Date.now(),
      committedSlotIds: [],
      messageIds: [],
      blackboardEntryIds: [],
    }
    const record = {
      version: 4,
      workflow: 'auto',
      template: 'discussion',
      phase,
      discussionStyle: controller.discussionStyle
        || controller.orchestration?.discussionStyle
        || 'sequential',
      ...(naturalWriterKind ? { discussionWriterKind: naturalWriterKind } : {}),
      batchId,
      round: Math.max(0, Number(controller.currentRound) || 0),
      currentKind: '',
      currentKinds: [...currentKinds],
      pendingKinds: [...pendingKinds],
      activeKinds: [...participantKinds],
      successfulKinds: slots
        .filter(slot => ['completed', 'partial'].includes(slot.status))
        .map(slot => slot.agentKind),
      agreementKinds: [],
      attachmentRecipients: [],
      totalSuccesses: slots.filter(slot => slot.status === 'completed').length,
      terminalFailureOccurred: slots.some(slot => slot.status === 'failed'),
      snapshotHash,
      snapshot: snapshotRecord,
      plan,
      slots,
      deliveryWatermarks: watermarks,
      ...(Array.isArray(controller.orchestration?.deliveryState)
        ? { deliveryState: controller.orchestration.deliveryState.map(entry => ({ ...entry })) }
        : {}),
      commitState: commit,
      ...(candidateCommit ? { candidateCommit: { ...candidateCommit } } : {}),
      collaboration: controller.orchestration?.collaboration || emptyCollaborationState(),
      ...(Array.isArray(challengeBindings)
        ? { challengeBindings: challengeBindings.map(binding => ({
            ...binding,
            artifactIds: [...binding.artifactIds],
            evidenceIds: [...binding.evidenceIds],
          })) }
        : {}),
      ...(synthesisBinding ? {
        synthesisBinding: {
          ...synthesisBinding,
          candidates: synthesisBinding.candidates.map(candidate => ({
            ...candidate,
            ...(candidate.evidence ? { evidence: { ...candidate.evidence } } : {}),
          })),
          verificationKinds: [...synthesisBinding.verificationKinds],
        },
      } : {}),
      ...(synthesisRecovery ? {
        synthesisRecovery: {
          ...synthesisRecovery,
          verificationKinds: [...synthesisRecovery.verificationKinds],
          rankedKinds: [...synthesisRecovery.rankedKinds],
          triedWriters: [...synthesisRecovery.triedWriters],
          attempts: synthesisRecovery.attempts.map(attempt => ({ ...attempt })),
          ...(synthesisRecovery.pendingGate
            ? { pendingGate: { ...synthesisRecovery.pendingGate } }
            : {}),
        },
      } : {}),
      ...(convergence ? { convergence: { ...convergence, openIssueIds: [...convergence.openIssueIds] } } : {}),
      ...(coordinationPlan ? {
        coordinationPlan: {
          ...coordinationPlan,
          assignments: coordinationPlan.assignments.map(assignment => ({ ...assignment })),
          verifierKinds: [...coordinationPlan.verifierKinds],
          agreedBy: [...coordinationPlan.agreedBy],
          ...(coordinationPlan.supportReceiptIds
            ? { supportReceiptIds: [...coordinationPlan.supportReceiptIds] }
            : {}),
        },
      } : {}),
      ...(coordinationPlan ? {
        workReceipts: workReceipts.map(receipt => ({
          ...receipt,
          snapshotContentRef: { ...receipt.snapshotContentRef },
          collaborationReceipt: { ...receipt.collaborationReceipt },
          artifacts: receipt.artifacts.map(artifact => ({
            ...artifact,
            contentRef: { ...artifact.contentRef },
          })),
        })),
      } : {}),
    }
    this.checkpointOrchestration(group, controller, record)
    return record
  },

  async runV4Phase(group, controller, threadRootId, context, phaseInput) {
    const {
      phase, activeKinds, targetKinds, writerKind, batchId,
      snapshot, snapshotRecord, snapshotHash, slots, receiptRecords, challengeBindings,
    } = phaseInput
    const participantKinds = Array.isArray(phaseInput.participantKinds)
      ? phaseInput.participantKinds
      : targetKinds
    const coordinationPlan = phaseInput.coordinationPlan || null
    const workAssignments = phase === 'work' && Array.isArray(phaseInput.workAssignments)
      ? phaseInput.workAssignments
      : []
    const workAssignmentsByKind = new Map(workAssignments.map(assignment => (
      [assignment.ownerKind, assignment]
    )))
    if (phase === 'work' && (workAssignments.length !== activeKinds.length
        || workAssignmentsByKind.size !== activeKinds.length
        || activeKinds.some(kind => {
          const assignment = workAssignmentsByKind.get(kind)
          return !assignment || !coordinationPlan?.assignments?.some(candidate => (
            candidate.taskId === assignment.taskId && candidate.ownerKind === kind
          ))
        }))) {
      throw new Error('LOCAL_RUN_V4_COORDINATION_PLAN_INVALID')
    }
    let workReceipts = Array.isArray(phaseInput.workReceipts)
      ? [...phaseInput.workReceipts]
      : []
    const deliveryReceiptRecords = Array.isArray(phaseInput.deliveryReceiptRecords)
      ? phaseInput.deliveryReceiptRecords
      : [...receiptRecords]
    const workContextLimit = Math.max(
      0, 6000 - collaborationPackageIndexText(participantKinds).length - 2,
    )
    const extraContextFor = kind => phase === 'work'
      ? this.v4WorkAssignmentText(
          coordinationPlan,
          kind,
          workAssignmentsByKind.get(kind)?.taskId,
          snapshot,
          workContextLimit,
          deliveryReceiptRecords,
        )
      : (phase === 'challenge' ? phaseInput.coordinationText || '' : '')
    let synthesisRecovery = phaseInput.synthesisRecovery || null
    const synthesisAttempt = phase === 'synthesis'
      ? this.v4ActiveSynthesisAttempt(synthesisRecovery)
      : null
    const operationIds = phaseInput.operationIds instanceof Map
      ? phaseInput.operationIds
      : synthesisAttempt
      ? new Map([[synthesisAttempt.writerKind, synthesisAttempt.operationId]])
      : (phase === 'work'
        ? new Map(activeKinds.map((kind) => {
            const slot = slots.find(candidate => candidate.agentKind === kind)
            const assignment = workAssignmentsByKind.get(kind)
            return [kind, this.v4OperationId(
              controller, kind, `work:${assignment.taskId}`, slot?.slotId || '',
            )]
          }))
        : null)
    const phaseSlots = this.v4PhaseSlots({
      controller,
      targetKinds,
      phase,
      activeKinds,
      slots,
      snapshotHash,
      writerKind,
      operationIds,
      allowWrite: group.allowWrite === true,
    })
    const resumedGate = phaseInput.resumedGate
    const resumedGateFor = slot => (
      resumedGate?.phase === phase
        && resumedGate.agentKind === slot.agentKind
        && resumedGate.slotId === slot.slotId
        && resumedGate.operationId === slot.operationId
        && resumedGate.snapshotHash === snapshotHash
        && resumedGate.round === controller.currentRound
        ? resumedGate
        : null
    )
    const activeSet = new Set(activeKinds)
    const phaseReceipts = []
    const snapshotSourceMessageIds = [snapshot.messageId, ...snapshot.history.map(item => item.id)]
    for (const slot of phaseSlots) {
      if (activeSet.has(slot.agentKind)) {
        slot.status = phase === 'synthesis' ? 'queued' : 'running'
      }
    }
    const cursorPendingKinds = Array.isArray(phaseInput.pendingKinds)
      ? phaseInput.pendingKinds
      : activeKinds
    this.v4CheckpointPhase(group, controller, {
      targetKinds,
      phase,
      batchId,
      snapshotRecord,
      snapshotHash,
      slots: phaseSlots,
      writerKind,
      currentKinds: activeKinds,
      pendingKinds: cursorPendingKinds,
      participantKinds,
      receipts: receiptRecords,
      challengeBindings,
      synthesisRecovery,
      coordinationPlan,
      workReceipts,
      workAssignments,
    })
    this.emitChanged()

    if (phase === 'proposal') {
      const proposalTurns = this.reserveTurnSeqs(group.id, threadRootId, activeKinds.length)
      const dispatches = activeKinds.map((kind, kindIndex) => {
        const slot = phaseSlots.find(candidate => candidate.agentKind === kind)
        const prompt = this.v4PhasePrompt(
          group, kind, phase, snapshot, receiptRecords, 'participant', {
            reviewTarget: '',
            packageText: '',
            skillHints: context.rootSkillsByKind.get(kind) || [],
            knowledgeBaseHints: context.rootKnowledgeBasesByKind.get(kind) || [],
          },
        )
        const sessionPolicy = this.naturalAgentResponses ? null : 'frozen'
        return {
          kind,
          slot,
          context: {
            v4: true,
            phase,
            batchId,
            slotId: slot.slotId,
            snapshotHash,
            ...(proposalTurns[kindIndex] ? { turnSeq: proposalTurns[kindIndex] } : {}),
            ...(sessionPolicy ? { sessionPolicy } : {}),
            promptOverride: prompt,
            contextPackId: controller.contextPackId,
            snapshotSourceMessageIds,
            snapshotSourceEntries: snapshot.history,
            permissionMode: 'read-only',
            singleWriterKind: writerKind,
            parallelGraph: true,
            deferMessage: true,
            allowMissingProposalReceipt: true,
            allowMissingV4Receipt: this.naturalAgentResponses,
            operationId: slot.operationId,
            ...(resumedGateFor(slot) ? { resumedGate: resumedGateFor(slot) } : {}),
            skillHints: context.rootSkillsByKind.get(kind) || [],
            knowledgeBaseHints: context.rootKnowledgeBasesByKind.get(kind) || [],
            ...(this.naturalAgentResponses && context.rootAttachments?.length
              ? { attachmentSnapshots: context.rootAttachments }
              : {}),
          },
        }
      })
      return this.runV4ProposalBatch(group, controller, threadRootId, {
        targetKinds,
        participantKinds,
        writerKind,
        batchId,
        snapshotRecord,
        snapshotHash,
        phaseSlots,
        receiptRecords,
        dispatches,
        resumedGate,
      })
    }

    const failures = []
    const phasePendingMessages = []
    let synthesisPendingMessage = null
    let workAdmissionClosed = false
    let workAdmissionTail = Promise.resolve()
    const admitWork = (item) => {
      const admission = workAdmissionTail.then(() => {
        if (workAdmissionClosed) return { ...item, workSettled: true }
        const admitted = this.v4AdmitWorkSettlement(
          group, controller, threadRootId, item, {
            targetKinds,
            participantKinds,
            writerKind,
            batchId,
            snapshotRecord,
            snapshotHash,
            phaseSlots,
            receiptRecords,
            challengeBindings,
            coordinationPlan,
            workReceipts,
            phaseReceipts,
            workAssignments,
            resumedGate: resumedGateFor(phaseSlots.find(candidate => (
              candidate.agentKind === item.kind
            ))),
          },
        )
        workReceipts = admitted.workReceipts
        if (admitted.failure) failures.push(admitted.failure)
        return { ...item, workSettled: true }
      })
      workAdmissionTail = admission.catch(() => { workAdmissionClosed = true })
      return admission
    }
    // Batched peers keep dispatch order in the timeline whatever order they
    // finish in.
    const phaseTurns = this.reserveTurnSeqs(group.id, threadRootId, activeKinds.length)
    const turnSeqByKind = new Map(activeKinds.map((kind, index) => [kind, phaseTurns[index]]))
    const settled = await Promise.all(activeKinds.map(async kind => {
      const slot = phaseSlots.find(candidate => candidate.agentKind === kind)
      const challengeBinding = phase === 'challenge'
        ? challengeBindings?.find(binding => binding.reviewerKind === kind) || null
        : null
      const assignedProposalText = challengeBinding
        ? this.v4ChallengeProposalText(challengeBinding, kind)
        : ''
      const role = this.v4PromptRole(
        phase, kind, coordinationPlan, workAssignmentsByKind.get(kind) || null,
      )
      const extraContext = extraContextFor(kind)
      const promptOptions = {
        reviewTarget: phase === 'challenge'
          ? challengeBinding?.proposalKind || ''
          : '',
        assignedProposalText,
        packageText: '',
        extraContext,
        snapshotHash,
        skillHints: context.rootSkillsByKind.get(kind) || [],
        knowledgeBaseHints: context.rootKnowledgeBasesByKind.get(kind) || [],
      }
      const prompt = typeof phaseInput.promptBuilder === 'function'
        ? phaseInput.promptBuilder({
            kind, slot, role, options: promptOptions,
            ...(phaseInput.disableDeliveryPrompt === true ? { transcript: '' } : {}),
          })
        : this.v4PhasePrompt(
          group,
          kind,
          phase,
          snapshot,
          deliveryReceiptRecords,
          role,
          promptOptions,
        )
      const sessionPolicy = phaseInput.sessionPolicy === undefined
        ? 'frozen'
        : phaseInput.sessionPolicy
      let preparedDelivery = null
      let item
      const resumedSlotGate = resumedGateFor(slot)
      const recoveredResult = phase === 'discussion'
        ? this.v4NaturalRecoveredDiscussionResult(
            group, controller, threadRootId, kind, slot,
          )
        : null
      if (recoveredResult) return { kind, invocation: { result: recoveredResult } }
      try {
        const invocation = await this.invokeWithUnauthorizedRecovery({
          group,
          kind,
          controller,
          activeKinds: participantKinds,
          threadRootId,
          context: {
            v4: true,
            phase,
            batchId,
            slotId: slot.slotId,
            snapshotHash,
            ...(turnSeqByKind.get(kind) ? { turnSeq: turnSeqByKind.get(kind) } : {}),
            ...(sessionPolicy ? { sessionPolicy } : {}),
            promptOverride: prompt,
            contextPackId: controller.contextPackId,
            snapshotSourceMessageIds,
            snapshotSourceEntries: snapshot.history,
            permissionMode: group.allowWrite === true
              && (phase === 'synthesis' || (this.naturalAgentResponses && phase === 'discussion'))
              && kind === writerKind
              ? 'workspace-write'
              : 'read-only',
            singleWriterKind: writerKind,
            parallelGraph: true,
            deferMessage: true,
            allowMissingV4Receipt: this.naturalAgentResponses,
            operationId: slot.operationId,
            ...(resumedSlotGate ? { resumedGate: resumedSlotGate } : {}),
            v4SynthesisRecovery: phase === 'synthesis',
            onLeaseAcquired: (leaseState) => {
              if (!leaseState?.agentRunId) throw new Error('LOCAL_RUN_PERSIST_FAILED')
              slot.agentRunId = leaseState.agentRunId
              if (phase === 'synthesis') {
                const activeAttempt = this.v4ActiveSynthesisAttempt(synthesisRecovery)
                if (!activeAttempt || activeAttempt.operationId !== slot.operationId) {
                  throw new Error('LOCAL_RUN_V4_SYNTHESIS_RECOVERY_INVALID')
                }
                synthesisRecovery = this.v4UpdateSynthesisAttempt(
                  synthesisRecovery,
                  activeAttempt.operationId,
                  {
                    status: 'leased',
                    permission: leaseState?.permissionMode === 'workspace-write'
                      ? 'workspace-write' : 'read-only',
                    leaseAcquired: true,
                    sideEffectsPossible: leaseState?.sideEffectsPossible === true,
                    outcomeCertainty: leaseState?.sideEffectsPossible === true
                      ? 'unknown_outcome' : 'not_started',
                  },
                )
              }
              slot.status = 'running'
              this.v4CheckpointPhase(group, controller, {
                targetKinds,
                phase,
                batchId,
                snapshotRecord,
                snapshotHash,
                slots: phaseSlots,
                writerKind,
                currentKinds: activeKinds,
                pendingKinds: cursorPendingKinds,
                participantKinds,
                receipts: receiptRecords,
                challengeBindings,
                synthesisRecovery,
                coordinationPlan,
                workReceipts,
                workAssignments,
              })
            },
            ...(phaseInput.disableDeliveryPrompt === true
              ? {
                  v4PromptBuilder: sessionBinding => {
                    const built = this.v4NaturalDeliveryPrompt(
                      group, controller, threadRootId, kind, slot, sessionBinding,
                      transcript => phaseInput.promptBuilder({ kind, slot, role, options: promptOptions, transcript }),
                    )
                    preparedDelivery = built.delivery
                    return built
                  },
                }
              : {
                  v4PromptBuilder: (sessionBinding) => {
                    const built = this.v4DeliveryPrompt(group, controller, {
                      kind, phase, snapshot, receiptRecords: deliveryReceiptRecords,
                      role, targetKinds: participantKinds, slot,
                      options: {
                        reviewTarget: phase === 'challenge'
                          ? challengeBinding?.proposalKind || ''
                          : '',
                        assignedProposalText,
                        extraContext,
                        ...(['synthesis', 'verification'].includes(phase)
                          ? { artifactContext: { coordinationPlan } }
                          : {}),
                      },
                      sessionBinding,
                      skillHints: context.rootSkillsByKind.get(kind) || [],
                    })
                    preparedDelivery = built.delivery
                    return built
                  },
                }),
            skillHints: context.rootSkillsByKind.get(kind) || [],
            knowledgeBaseHints: context.rootKnowledgeBasesByKind.get(kind) || [],
            ...(this.naturalAgentResponses && context.rootAttachments?.length
              ? { attachmentSnapshots: context.rootAttachments }
              : {}),
          },
        })
        if (invocation.result?.v4Delivery) {
          this.v4SetDeliveryStatus(
            group, controller, invocation.result.v4Delivery, 'acknowledged',
            invocation.result.v4SessionBinding,
          )
        } else if (preparedDelivery) {
          this.v4SetDeliveryStatus(group, controller, preparedDelivery, 'uncertain')
        }
        item = { kind, invocation }
      } catch (error) {
        if (preparedDelivery) this.v4SetDeliveryStatus(group, controller, preparedDelivery, 'uncertain')
        if (stalePermissionResumeFailure(error, resumedSlotGate)) {
          this.resetAgentSession(group, kind, true, controller.taskId)
          item = { kind, error, permissionRestartRecovery: true }
        } else {
          item = { kind, error }
        }
      }
      return phase === 'work' ? admitWork(item) : item
    }))

    for (const item of phase === 'work' ? [] : settled) {
      const slot = phaseSlots.find(candidate => candidate.agentKind === item.kind)
      const result = item.invocation?.result
      if (controller.signal.aborted) {
        slot.status = 'stopped'
        slot.commitStatus = 'partial'
        slot.finishedAt = Date.now()
        continue
      }
      if (!result) {
        const error = item.error || item.invocation?.error
          || new Error('LOCAL_AGENT_UNKNOWN_FAILURE')
        slot.status = 'failed'
        slot.commitStatus = 'failed'
        slot.finishedAt = Date.now()
        failures.push({ ...item, error })
        if (!controller.signal.aborted) {
          this.recordAgentFailure(group.id, item.kind, error, threadRootId, new Set())
        }
        if (phase === 'synthesis' && synthesisRecovery) {
          const activeAttempt = this.v4ActiveSynthesisAttempt(synthesisRecovery)
          if (activeAttempt?.operationId === slot.operationId) {
            const failure = error?.invocationFailure || {}
            const unknownWrite = activeAttempt.permission === 'workspace-write'
              && activeAttempt.leaseAcquired
              && (item.permissionRestartRecovery === true
                || (failure.outcomeCertainty !== 'not_started'
                  && failure.outcomeCertainty !== 'known_failed'))
            synthesisRecovery = this.v4UpdateSynthesisAttempt(
              synthesisRecovery,
              activeAttempt.operationId,
              unknownWrite ? {
                status: 'unknown_outcome',
                sideEffectsPossible: true,
                outcomeCertainty: 'unknown_outcome',
              } : {
                status: 'failed',
                sideEffectsPossible: false,
                outcomeCertainty: failure.outcomeCertainty === 'not_started'
                  ? 'not_started' : 'known_failed',
              },
            )
          }
        }
        continue
      }
      try {
        const reportedOperationId = result?.message?.trace?.context?.operationId
          || result?.pendingMessage?.metadata?.trace?.context?.operationId
        if (reportedOperationId && reportedOperationId !== slot.operationId) {
          throw new Error('LOCAL_RUN_COLLABORATION_SCOPE_INVALID')
        }
        const receiptRecord = this.v4ReceiptForResult(
          result,
          phase,
          item.kind,
          slot,
          snapshotHash,
          {
            controller,
            ...(phase === 'work'
              ? { workItemId: workAssignmentsByKind.get(item.kind)?.taskId || '' }
              : {}),
            reviewedArtifactId: phase === 'challenge'
              ? challengeBindings?.find(binding => (
                binding.reviewerKind === item.kind
              ))?.artifactIds?.[0] || ''
              : (phase === 'verification'
                ? [...receiptRecords].reverse().find(record => (
                  record.receipt?.phase === 'synthesis'
                ))?.receipt?.artifactIds?.[0] || ''
                : ''),
          },
        )
        if (phase === 'work') {
          const assignment = workAssignmentsByKind.get(item.kind)
          if (!assignment || receiptRecord.receipt.workItemId !== assignment.taskId) {
            throw new Error('LOCAL_RUN_V4_WORK_RECEIPT_INVALID')
          }
          if (!this.v4ReceiptReferencesComplete(receiptRecord)) {
            throw new Error('LOCAL_RUN_V4_WORK_RECEIPT_INVALID')
          }
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
              ...(effectiveReceiptRecord.verdict ? { verdict: effectiveReceiptRecord.verdict } : {}),
              ...(effectiveReceiptRecord.resolvedIssueIds.length
                ? { resolvedIssueIds: effectiveReceiptRecord.resolvedIssueIds }
                : {}),
            },
          ],
        }
        if (phase === 'synthesis' && !duplicate) {
          synthesisPendingMessage = result.pendingMessage || result.message || null
        } else if (result.pendingMessage?.content) {
          phasePendingMessages.push({ kind: item.kind, pendingMessage: result.pendingMessage })
          if (['discussion', 'challenge'].includes(phase)) {
            this.commitV4PhaseMessage({
              group, controller, threadRootId, phase, kind: item.kind,
              pendingMessage: result.pendingMessage,
            })
            slot.commitStatus = 'committed'
          }
        }
        if (phase === 'synthesis' && synthesisRecovery) {
          const activeAttempt = this.v4ActiveSynthesisAttempt(synthesisRecovery)
          if (!activeAttempt || activeAttempt.operationId !== slot.operationId) {
            throw new Error('LOCAL_RUN_V4_SYNTHESIS_RECOVERY_INVALID')
          }
          synthesisRecovery = this.v4UpdateSynthesisAttempt(
            synthesisRecovery,
            activeAttempt.operationId,
            { status: 'completed', outcomeCertainty: 'succeeded' },
          )
        }
      } catch (error) {
        slot.status = 'failed'
        slot.commitStatus = 'failed'
        slot.finishedAt = Date.now()
        failures.push({ ...item, error })
        if (phase === 'synthesis' && synthesisRecovery) {
          const activeAttempt = this.v4ActiveSynthesisAttempt(synthesisRecovery)
          if (activeAttempt?.operationId === slot.operationId) {
            const failure = error?.invocationFailure || {}
            const unknownWrite = activeAttempt.permission === 'workspace-write'
              && activeAttempt.leaseAcquired
              && failure.outcomeCertainty !== 'not_started'
              && failure.outcomeCertainty !== 'known_failed'
            synthesisRecovery = this.v4UpdateSynthesisAttempt(
              synthesisRecovery,
              activeAttempt.operationId,
              unknownWrite ? {
                status: 'unknown_outcome',
                sideEffectsPossible: true,
                outcomeCertainty: 'unknown_outcome',
              } : {
                status: 'failed',
                sideEffectsPossible: false,
                outcomeCertainty: failure.outcomeCertainty === 'not_started'
                  ? 'not_started' : 'known_failed',
              },
            )
          }
        }
        if (!controller.signal.aborted) {
          this.recordAgentFailure(group.id, item.kind, error, threadRootId, new Set())
        }
      }
    }
    const newWatermarks = phaseReceipts.map(item => ({
      agentKind: item.receipt.agentKind,
      phase: item.receipt.phase,
      watermark: item.receipt.deliveryWatermark,
      operationId: item.receipt.operationId,
      snapshotHash: item.receipt.snapshotHash,
      updatedAt: Date.now(),
    }))
    controller.v4Watermarks = [
      ...(controller.v4Watermarks || []).filter(existing => (
        !newWatermarks.some(next => (
          next.agentKind === existing.agentKind && next.phase === existing.phase
        ))
      )),
      ...newWatermarks,
    ]
    if (phase === 'synthesis') {
      const activeAttempt = this.v4ActiveSynthesisAttempt(synthesisRecovery)
      if (activeAttempt?.status === 'unknown_outcome' && !synthesisRecovery.pendingGate) {
        synthesisRecovery = {
          ...synthesisRecovery,
          pendingGate: this.v4SynthesisRecoveryGate(controller, synthesisRecovery),
        }
      }
    }
    const resumedSlot = phaseSlots.find(slot => (
      slot.status === 'completed' && resumedGateFor(slot)
    ))
    if (resumedSlot
        && !this.completeV4ResumedAgentSlotContinuation(controller, resumedGate)) {
      throw new Error('LOCAL_RUN_PERSIST_FAILED')
    }
    const remainingKinds = Array.isArray(phaseInput.remainingKinds)
      ? phaseInput.remainingKinds
      : []
    this.v4CheckpointPhase(group, controller, {
      targetKinds,
      phase,
      batchId,
      snapshotRecord,
      snapshotHash,
      slots: phaseSlots,
      writerKind,
      currentKinds: [],
      pendingKinds: remainingKinds,
      participantKinds,
      receipts: receiptRecords,
      challengeBindings,
      synthesisRecovery,
      coordinationPlan,
      workReceipts,
      workAssignments,
    })
    controller.currentKind = ''
    controller.progress = []
    controller.completedKinds = [...new Set([
      ...(controller.completedKinds || []),
      ...activeKinds.filter(kind => !failures.some(item => item.kind === kind)),
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
      phasePendingMessages,
      failures,
      synthesisPendingMessage,
      synthesisRecovery,
      workReceipts,
      ok: failures.length === 0,
    }
  },
}

module.exports = { v4PhaseMethods }

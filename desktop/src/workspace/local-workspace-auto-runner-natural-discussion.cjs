// Natural discussion, the production path for automatic group runs: transcript, prompts and the sequential and agent-led loops.
const path = require('node:path')
const { MAX_MESSAGE_TEXT_CHARS } = require('./local-workspace-contracts.cjs')
const { hashValue } = require('../collaboration/orchestration-v4-records.cjs')
const { packNaturalDiscussionTranscript, v4Prompt } = require('./local-workspace-context.cjs')
const { naturalDiscussionPrompt } = require('./prompts/natural-discussion-prompt.cjs')
const { terminalRunStatusForReason } = require('./local-workspace-auto-runner-support.cjs')
const { traceCapsuleFromAgentRun } = require('../runs/run-harness-normalization.cjs')

const naturalDiscussionMethods = {
  v4NaturalMessageMatchesBinding(message, controller) {
    const phase = String(message?.trace?.phase || '')
    const kind = String(message?.agentKind || '')
    const round = Number(message?.trace?.round) || 0
    if (!['proposal', 'discussion'].includes(phase) || !kind || round < 1) return false
    if (message.trace?.runId !== controller.runId) return false
    const slot = controller.orchestration?.slots?.find(candidate => candidate.agentKind === kind)
    const snapshotHash = String(controller.orchestration?.snapshotHash || '')
    if (!slot?.slotId || !snapshotHash) return false
    const operationPhase = phase === 'discussion' ? `discussion:${round}` : phase
    const expectedOperationId = this.v4OperationId(
      controller, kind, operationPhase, slot.slotId, round,
    )
    return message.trace?.context?.operationId === expectedOperationId
      && message.trace?.context?.snapshotHash === snapshotHash
  },

  v4NaturalMessageContent(message) {
    const text = String(message.content || '')
    if (text.length < MAX_MESSAGE_TEXT_CHARS && message.trace?.truncated !== true) {
      return { text, partial: false }
    }
    for (const artifactId of message.trace?.context?.outcomeRefs?.artifactIds || []) {
      try {
        const { artifact, content } = this.v4ArtifactIdentity(artifactId)
        if (artifact.name !== `${message.agentKind}-conclusion.txt`
            || artifact.producedBy?.runId !== message.trace?.runId
            || artifact.producedBy?.agentRunId !== message.trace?.agentRunId
            || artifact.producedBy?.agentKind !== message.agentKind
            || !content.startsWith(text)) continue
        return { text: content, partial: false }
      } catch { /* Historical blobs may be unavailable; identify the excerpt below. */ }
    }
    return { text, partial: true }
  },

  v4NaturalThreadEntries(group, threadRootId, options = {}) {
    const rounds = Array.isArray(options.rounds) ? new Set(options.rounds) : null
    const entries = this.state().messages.filter(message => (
      message.groupId === group.id
      && message.threadRootId === threadRootId
      && message.role === 'agent'
      && message.agentKind
      && (!rounds || rounds.has(Number(message.trace?.round) || 0))
      && (!options.controller || this.v4NaturalMessageMatchesBinding(
        message, options.controller,
      ))
    )).map((message, index) => ({ message, index }))
      // Peers read turns in dispatch order, the same order the user sees,
      // instead of the order replies happened to be saved in.
      .sort((left, right) => {
        const leftTurn = Number.isSafeInteger(left.message.turnSeq) ? left.message.turnSeq : 0
        const rightTurn = Number.isSafeInteger(right.message.turnSeq) ? right.message.turnSeq : 0
        return (leftTurn ? 1 : 0) - (rightTurn ? 1 : 0)
          || leftTurn - rightTurn
          || left.index - right.index
      })
      .map(({ message }) => message)
      .map(message => ({
      ...this.v4NaturalMessageContent(message),
      id: message.id,
      agentKind: message.agentKind,
      round: Number(message.trace?.round) || 0,
      phase: message.trace?.phase || 'proposal',
      operationId: message.trace?.context?.operationId || '',
    })).map(entry => ({
      // Peers collaborating on the same workspace must be able to name its
      // files; keep workspace paths readable as relative paths.
      ...entry, text: this.v4SanitizeDeliveryText(entry.text, Number.MAX_SAFE_INTEGER, {
        workspaceRoot: group.workdir ? path.resolve(group.workdir) : '',
      }),
    }))
    return entries.map(entry => ({ ...entry, hash: hashValue(entry) }))
  },

  v4NaturalThreadTranscript(group, threadRootId, options = {}) {
    return packNaturalDiscussionTranscript(this.v4NaturalThreadEntries(group, threadRootId, options))
  },

  v4NaturalDeliveryPrompt(group, controller, threadRootId, kind, slot, binding, promptBuilder) {
    const entries = this.v4NaturalThreadEntries(group, threadRootId, { controller })
    const previousEntries = binding.hasSession && !binding.sessionRotated
      ? (controller.orchestration?.deliveryState || []).filter(entry => (
          entry.recipientKind === kind && entry.status === 'acknowledged'
          && entry.sessionRefHash === binding.sessionRefHash
          && entry.sessionProvenanceHash === binding.sessionProvenanceHash
          && entry.snapshotHash === controller.orchestration.snapshotHash
          && entry.sourceMessages
        ))
      : []
    const seen = new Set(previousEntries.flatMap(entry => entry.sourceMessages.map(message => (
      [entry.sourceAgentKind, entry.sourcePhase, message.id, message.hash].join('\u0000')
    ))))
    const unseen = entries.filter(entry => !seen.has([
      entry.agentKind, entry.phase, entry.id, entry.hash,
    ].join('\u0000')))
    const packed = packNaturalDiscussionTranscript(unseen, {
      withEntries: true,
      prefix: unseen.length < entries.length
        ? 'Previously delivered turns are not repeated here. They were supplied to this native session; ask peers to restate missing evidence if your current context is incomplete. Their omission does not imply agreement or task completion.'
        : '',
    })
    const included = new Set(packed.completeMessageIds)
    const sources = new Map()
    for (const entry of unseen) {
      if (!included.has(entry.id)) continue
      const key = `${entry.agentKind}\u0000${entry.phase}`
      const source = sources.get(key) || {
        sourceAgentKind: entry.agentKind, sourcePhase: entry.phase,
        watermark: 0, operationId: entry.operationId, sourceMessages: [],
      }
      source.watermark = Math.max(source.watermark, entry.round)
      source.sourceMessages.push({ id: entry.id, hash: entry.hash })
      sources.set(key, source)
    }
    const packageHash = hashValue(packed.text)
    const deliveryId = `delivery-${hashValue({
      runId: controller.runId, kind, operationId: slot.operationId,
      packageHash, binding, now: Date.now(),
    })}`
    const delivery = sources.size ? {
      natural: true, previousEntries, packageHash, deliveryId,
      entries: [...sources.values()].map(source => ({
        ...source, recipientKind: kind,
        sessionRefHash: binding.sessionRefHash,
        sessionProvenanceHash: binding.sessionProvenanceHash,
        snapshotHash: controller.orchestration.snapshotHash,
        packageHash, deliveryId, status: 'prepared', updatedAt: Date.now(),
      })),
    } : null
    this.v4PrepareDelivery(group, controller, delivery)
    return { prompt: promptBuilder(packed.text), delivery }
  },

  v4NaturalRecoveredPhaseResult(group, controller, threadRootId, phase, kind, slot) {
    if (!this.naturalAgentResponses || !slot || controller.currentRound < 1) return null
    if (!['proposal', 'discussion'].includes(phase)) return null
    const operationId = String(slot.operationId || '')
    const snapshotHash = String(slot.snapshotHash || '')
    if (!operationId || !snapshotHash) return null
    const matchesBinding = context => (
      context?.operationId === operationId && context?.snapshotHash === snapshotHash
    )
    const scopedMessages = [...this.state().messages].reverse().filter(message => (
      message.groupId === group.id
      && message.threadRootId === threadRootId
      && message.role === 'agent'
      && message.agentKind === kind
      && message.trace?.runId === controller.runId
      && message.trace?.phase === phase
      && Number(message.trace?.round) === controller.currentRound
    ))
    if (scopedMessages.some(message => !matchesBinding(message.trace?.context))) {
      throw new Error('LOCAL_RUN_COLLABORATION_SCOPE_INVALID')
    }
    const existingMessage = scopedMessages.find(message => matchesBinding(message.trace?.context))
    let content = String(existingMessage?.content || '')
    let trace = existingMessage?.trace || null
    let metadata = existingMessage ? {
      ...(existingMessage.elapsedMs != null ? { elapsedMs: existingMessage.elapsedMs } : {}),
      ...(Array.isArray(existingMessage.toolCalls) ? { toolCalls: existingMessage.toolCalls } : {}),
      ...(Array.isArray(existingMessage.attachments)
        ? { attachments: existingMessage.attachments } : {}),
      ...(existingMessage.responseVersionRootId
        ? { responseVersionRootId: existingMessage.responseVersionRootId } : {}),
      trace,
    } : null
    if (!content || !trace?.agentRunId) {
      const scopedRuns = [...(controller.harness?.snapshot?.() || [])].reverse().filter(run => (
        run.kind === kind
        && run.round === controller.currentRound
        && run.status === 'completed'
        && String(run.output || '')
      ))
      if (scopedRuns.some(run => !matchesBinding(run.context))) {
        throw new Error('LOCAL_RUN_COLLABORATION_SCOPE_INVALID')
      }
      const recoveredRun = scopedRuns.find(run => matchesBinding(run.context))
      if (!recoveredRun) return null
      content = String(recoveredRun.output)
      trace = traceCapsuleFromAgentRun(recoveredRun, {
        runId: controller.runId,
        status: recoveredRun.status,
        phase,
      })
      if (!trace?.agentRunId) return null
      metadata = { trace }
    }
    return {
      text: content,
      pendingMessage: {
        groupId: group.id,
        role: 'agent',
        content,
        agentKind: kind,
        threadRootId,
        system: null,
        metadata,
      },
      collaboration: trace.context?.taskDecision
        ? { summary: trace.context.taskDecision.reason, taskDecision: trace.context.taskDecision }
        : null,
      outcomeRefs: trace.context?.outcomeRefs || {},
      operationId: slot.operationId,
      consensus: false,
    }
  },

  v4NaturalRecoveredDiscussionResult(group, controller, threadRootId, kind, slot) {
    return this.v4NaturalRecoveredPhaseResult(
      group, controller, threadRootId, 'discussion', kind, slot,
    )
  },

  v4NaturalPhasePrompt(group, kind, phase, snapshot, receiptRecords, activeKinds, options = {}) {
    const humanResponses = options.runId ? this.taskDecisionResponses(options.runId) : []
    return naturalDiscussionPrompt({
      brief: v4Prompt({
        group, kind, phase, snapshot, role: 'participant',
        skillHints: options.skillHints,
        knowledgeBaseHints: options.knowledgeBaseHints,
        naturalResponse: true,
      }),
      group,
      kind,
      phase,
      activeKinds,
      transcript: String(options.transcript || ''),
      humanResponsesText: humanResponses.length ? packNaturalDiscussionTranscript(humanResponses) : '',
      writerKind: options.writerKind,
      ownerKind: options.ownerKind,
      allowRouting: options.allowRouting === true,
    })
  },

  v4NaturalDiscussionOperationIds(controller, slots, kinds, round) {
    return new Map(kinds.map((kind) => {
      const slot = slots.find(candidate => candidate.agentKind === kind)
      return [kind, this.v4OperationId(
        controller, kind, `discussion:${round}`, slot?.slotId || '', round,
      )]
    }))
  },

  v4NaturalDiscussionRoundMessages(group, controller, threadRootId, round) {
    return this.state().messages.filter(message => (
      message.groupId === group.id
      && message.threadRootId === threadRootId
      && message.role === 'agent'
      && message.trace?.runId === controller.runId
      && message.trace?.phase === 'discussion'
      && Number(message.trace?.round) === round
      && this.v4NaturalMessageMatchesBinding(message, controller)
    ))
  },

  async runV4SequentialDiscussion(group, controller, threadRootId, context, input) {
    const {
      targetKinds, activeKinds: initialActiveKinds, writerKind, batchId,
      snapshot, snapshotRecord, snapshotHash, slots: initialSlots, receiptRecords,
      checkpointPhase, removePhaseFailures, addRoundLimitNotice,
    } = input
    let activeKinds = [...initialActiveKinds]
    let slots = initialSlots
    let round = Math.max(1, Number(controller.currentRound) || 1)
    let pendingKinds = controller.orchestration?.discussionStyle === 'sequential'
      && controller.orchestration?.phase === 'discussion'
      && controller.orchestration?.round === round
      ? (controller.orchestration.pendingKinds || []).filter(kind => activeKinds.includes(kind))
      : [...activeKinds]
    if (!pendingKinds.length && controller.orchestration?.phase === 'discussion') {
      const outcome = await this.v4NaturalRoundOutcome(group, controller, threadRootId, round, activeKinds)
      if (outcome.status) return outcome.status
      if (!controller.unlimitedRounds && round >= (controller.maxRounds || 6)) {
        addRoundLimitNotice()
        return 'round-limit'
      }
      round += 1
      pendingKinds = outcome.ownerReview ? outcome.nextKinds : [...activeKinds]
    }
    while (!controller.signal.aborted) {
      controller.currentRound = round
      while (pendingKinds.length && !controller.signal.aborted) {
        const kind = pendingKinds[0]
        const remainingKinds = pendingKinds.slice(1)
        const dispatch = await this.runV4Phase(group, controller, threadRootId, context, {
          phase: 'discussion',
          activeKinds: [kind],
          targetKinds,
          participantKinds: activeKinds,
          writerKind,
          batchId,
          snapshot,
          snapshotRecord,
          snapshotHash,
          slots,
          receiptRecords,
          challengeBindings: null,
          coordinationPlan: null,
          workReceipts: [],
          operationIds: this.v4NaturalDiscussionOperationIds(
            controller, slots, [kind], round,
          ),
          pendingKinds,
          remainingKinds,
          sessionPolicy: null,
          resumedGate: input.resumedGate,
          disableDeliveryPrompt: true,
          promptBuilder: ({ kind: promptKind, transcript }) => this.v4NaturalPhasePrompt(
            group, promptKind, 'discussion', snapshot, receiptRecords, activeKinds, {
              runId: controller.runId,
              transcript: transcript ?? this.v4NaturalThreadTranscript(
                group, threadRootId, { controller },
              ),
              skillHints: context.rootSkillsByKind.get(promptKind) || [],
              knowledgeBaseHints: context.rootKnowledgeBasesByKind.get(promptKind) || [],
              ownerKind: this.v4NaturalOwner(group, controller, threadRootId, activeKinds),
              writerKind,
              allowRouting: false,
            },
          ),
        })
        slots = dispatch.slots || slots
        if (!dispatch.ok) {
          if (controller.signal.aborted) return terminalRunStatusForReason(controller.stopReason)
          const failedKinds = removePhaseFailures(dispatch)
          activeKinds = activeKinds.filter(agentKind => !failedKinds.includes(agentKind))
          if (!activeKinds.length) {
            return dispatch.phasePendingMessages?.length ? 'partial' : 'failed'
          }
        }
        pendingKinds = remainingKinds.filter(agentKind => activeKinds.includes(agentKind))
      }
      const outcome = await this.v4NaturalRoundOutcome(group, controller, threadRootId, round, activeKinds)
      if (outcome.status) return outcome.status
      if (!controller.unlimitedRounds && round >= (controller.maxRounds || 6)) {
        addRoundLimitNotice()
        return 'round-limit'
      }
      round += 1
      controller.currentRound = round
      pendingKinds = outcome.ownerReview ? outcome.nextKinds : [...activeKinds]
    }
    return terminalRunStatusForReason(controller.stopReason)
  },

  async runV4AgentLedDiscussion(group, controller, threadRootId, context, input) {
    const {
      targetKinds, activeKinds: initialActiveKinds, writerKind, batchId,
      snapshot, snapshotRecord, snapshotHash, slots: initialSlots, receiptRecords,
      latestFor, runPhase, checkpointPhase, removePhaseFailures, addRoundLimitNotice,
    } = input
    let activeKinds = [...initialActiveKinds]
    let slots = initialSlots
    let round = Math.max(1, Number(controller.currentRound) || 1)
    const proposalCompleteBeforeRun = activeKinds.every(kind => Boolean(latestFor('proposal', kind)))
    if (!proposalCompleteBeforeRun) {
      controller.currentRound = 1
      const proposal = await runPhase('proposal', activeKinds)
      slots = proposal.slots || slots
      if (!proposal.ok) {
        const failedKinds = removePhaseFailures(proposal)
        activeKinds = activeKinds.filter(kind => !failedKinds.includes(kind))
        checkpointPhase('proposal', [], slots, null)
        if (!activeKinds.length) return proposal.phasePendingMessages?.length ? 'partial' : 'failed'
      }
    }
    const proposalComplete = activeKinds.every(kind => Boolean(latestFor('proposal', kind)))
    if (!proposalComplete) {
      return activeKinds.some(kind => Boolean(latestFor('proposal', kind))) ? 'partial' : 'failed'
    }
    if (!controller.unlimitedRounds && (controller.maxRounds || 6) <= 1) {
      addRoundLimitNotice()
      return 'round-limit'
    }

    let nextKinds = []
    if (controller.orchestration?.phase === 'discussion') {
      round = Math.max(2, Number(controller.orchestration.round) || 2)
      nextKinds = (controller.orchestration.pendingKinds || [])
        .filter(kind => activeKinds.includes(kind))
      if (!nextKinds.length) {
        if (this.v4NaturalStopRepeatingDiscussion(
          group, controller, threadRootId, round, activeKinds,
        )) return 'partial'
        const outcome = await this.v4NaturalRoundOutcome(group, controller, threadRootId, round, activeKinds)
        if (outcome.status) return outcome.status
        nextKinds = outcome.nextKinds
        if (!controller.unlimitedRounds && round >= (controller.maxRounds || 6)) {
          addRoundLimitNotice()
          return 'round-limit'
        }
        round += 1
      }
    } else {
      round = 2
      // The first discussion round is a full participant round: every selected
      // Agent reacts to the proposal set before the delivery owner reviews and
      // judges completion, so a group run cannot collapse to owner-only turns.
      nextKinds = [...activeKinds]
    }

    while (!controller.signal.aborted) {
      controller.currentRound = round
      const dispatch = await this.runV4Phase(group, controller, threadRootId, context, {
        phase: 'discussion',
        activeKinds: nextKinds,
        targetKinds,
        participantKinds: activeKinds,
        writerKind,
        batchId,
        snapshot,
        snapshotRecord,
        snapshotHash,
        slots,
        receiptRecords,
        challengeBindings: null,
        coordinationPlan: null,
        workReceipts: [],
        operationIds: this.v4NaturalDiscussionOperationIds(
          controller, slots, nextKinds, round,
        ),
        pendingKinds: nextKinds,
        remainingKinds: [],
        sessionPolicy: null,
        resumedGate: input.resumedGate,
        disableDeliveryPrompt: true,
        promptBuilder: ({ kind, transcript }) => this.v4NaturalPhasePrompt(
          group, kind, 'discussion', snapshot, receiptRecords, activeKinds, {
            runId: controller.runId,
            transcript: transcript ?? this.v4NaturalThreadTranscript(group, threadRootId, { controller }),
            skillHints: context.rootSkillsByKind.get(kind) || [],
            knowledgeBaseHints: context.rootKnowledgeBasesByKind.get(kind) || [],
            allowRouting: true,
            ownerKind: this.v4NaturalOwner(group, controller, threadRootId, activeKinds),
            writerKind,
          },
        ),
      })
      slots = dispatch.slots || slots
      if (!dispatch.ok) {
        if (controller.signal.aborted) return terminalRunStatusForReason(controller.stopReason)
        const failedKinds = removePhaseFailures(dispatch)
        activeKinds = activeKinds.filter(kind => !failedKinds.includes(kind))
        if (!activeKinds.length) return dispatch.phasePendingMessages?.length ? 'partial' : 'failed'
      }
      if (this.v4NaturalStopRepeatingDiscussion(
        group, controller, threadRootId, round, activeKinds,
      )) return 'partial'
      const outcome = await this.v4NaturalRoundOutcome(group, controller, threadRootId, round, activeKinds)
      if (outcome.status) return outcome.status
      nextKinds = outcome.nextKinds
      if (!controller.unlimitedRounds && round >= (controller.maxRounds || 6)) {
        addRoundLimitNotice()
        return 'round-limit'
      }
      round += 1
      controller.currentRound = round
    }
    return terminalRunStatusForReason(controller.stopReason)
  },

  async runV4NaturalDiscussion(group, controller, threadRootId, context, input) {
    if (input.resume && controller.orchestration?.phase === 'discussion') {
      for (const slot of input.slots) {
        if (slot.permission !== 'workspace-write' || !slot.agentRunId
            || slot.commitStatus === 'committed'
            || !['running', 'waiting', 'stopped', 'failed'].includes(slot.status)) continue
        if (this.v4NaturalRecoveredDiscussionResult(group, controller, threadRootId, slot.agentKind, slot)) continue
        if (input.resumedGate?.operationId === slot.operationId
            && input.resumedGate.agentKind === slot.agentKind
            && input.resumedGate.status === 'approved') continue
        if (!this.requestHumanGate) throw new Error('LOCAL_RUN_RETRY_GATE_INVALID')
        const binding = {
          agentRunId: slot.agentRunId, agentKind: slot.agentKind,
          round: controller.currentRound, phase: 'discussion', slotId: slot.slotId,
          operationId: slot.operationId, snapshotHash: input.snapshotHash,
        }
        const request = {
          phase: 'discussion-writer-recovery', batchId: input.batchId,
          slotId: slot.slotId, operationId: slot.operationId, attempt: slot.attempt,
          outcomeCertainty: 'unknown_outcome', sideEffectsPossible: true,
        }
        const gate = await this.requestHumanGate({
          type: 'retry', runId: controller.runId, agentRunId: slot.agentRunId,
          agentKind: slot.agentKind,
          summary: 'The interrupted discussion writer may already have changed the workspace.',
          options: [
            { optionId: 'retry-once', name: 'Retry once', kind: 'allow_once' },
            { optionId: 'cancel-retry', name: 'Do not retry', kind: 'reject_once' },
          ],
          request,
        }, {
          signal: controller.signal,
          preserveOnAbort: () => controller.stopReason === 'shutdown',
          continuation: { resumeKind: 'agent_slot', ...binding },
        })
        if (gate.status !== 'approved') {
          if (this.completeHumanGateContinuation?.(controller.runId, gate.gateId, 'cancelled') !== true
              && this.hasRunLedger()) throw new Error('LOCAL_RUN_PERSIST_FAILED')
          controller.stopReason = 'human_gate_rejected'
          return 'stopped'
        }
        if (gate.optionId !== 'retry-once') throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
        input.resumedGate = { ...binding, gateId: gate.gateId, type: 'retry',
          status: gate.status, optionId: gate.optionId, request, used: false }
      }
    }
    if (input.resumedGate?.type === 'retry'
        && input.resumedGate.request?.phase === 'discussion-writer-recovery') {
      const gate = input.resumedGate
      const slot = input.slots.find(item => item.slotId === gate.slotId)
      if (gate.status !== 'approved' || gate.optionId !== 'retry-once'
          || !slot || slot.agentKind !== gate.agentKind
          || slot.operationId !== gate.operationId
          || slot.snapshotHash !== gate.snapshotHash
          || slot.attempt !== gate.request.attempt) throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
      if (this.completeHumanGateContinuation?.(controller.runId, gate.gateId, 'completed') !== true
          && this.hasRunLedger()) throw new Error('LOCAL_RUN_PERSIST_FAILED')
    }
    const style = controller.orchestration?.discussionStyle
      || controller.discussionStyle
      || 'sequential'
    return style === 'agent-led'
      ? this.runV4AgentLedDiscussion(group, controller, threadRootId, context, input)
      : this.runV4SequentialDiscussion(group, controller, threadRootId, context, input)
  },
}

module.exports = { naturalDiscussionMethods }

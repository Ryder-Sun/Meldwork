// V2 round-based runs. Kept so older runs can be resumed; new runs do not use it.
const { MAX_RUN_AGENT_ATTEMPTS } = require('../runs/failure-policy.cjs')
const {
  circuitBreakerError,
  circuitBreakerFailure,
  hardBudgetFailure,
  terminalRunStatusForReason,
} = require('./local-workspace-auto-runner-support.cjs')

const roundsMethods = {
  async runRounds(group, controller, threadRootId, maxRounds, context, resume = false) {
    const {
      rootAttachments,
      rootSkillsByKind,
      rootKnowledgeBasesByKind,
    } = context
    const cursor = resume ? controller.orchestration : null
    const attachmentRecipients = new Set(cursor?.attachmentRecipients || [])
    let terminalFailureOccurred = cursor?.terminalFailureOccurred === true
    let activeKinds = cursor ? [...cursor.activeKinds] : [...controller.targetKinds]
    let executionSequence = Number(cursor?.executionSequence) || 0
    let totalSuccesses = cursor?.totalSuccesses || 0
    let consensusReached = false
    const reportedFailures = new Set()
    const firstRound = resume ? Math.max(0, controller.currentRound - 1) : 0

    for (
      let round = firstRound;
      (controller.unlimitedRounds || round < maxRounds) && !controller.signal.aborted;
      round += 1
    ) {
      const resumedRound = resume && round === firstRound
      const successfulKinds = new Set(resumedRound ? cursor.successfulKinds : [])
      const agreementKinds = new Set(resumedRound ? cursor.agreementKinds : [])
      const replacementInstructions = new Map()
      const roundQueue = resumedRound ? [...cursor.pendingKinds] : [...activeKinds]
      controller.currentRound = round + 1
      controller.completedKinds = resumedRound
        ? activeKinds.filter(kind => !roundQueue.includes(kind))
        : []
      controller.failedKinds = resumedRound
        ? controller.completedKinds.filter(kind => !successfulKinds.has(kind))
        : []
      if (!resumedRound) {
        this.checkpointOrchestration(group, controller, {
          currentKind: '',
          pendingKinds: [...roundQueue],
          activeKinds: [...activeKinds],
          successfulKinds: [],
          agreementKinds: [],
          attachmentRecipients: [...attachmentRecipients],
          totalSuccesses,
          terminalFailureOccurred,
          executionSequence,
        })
      }
      this.emitChanged()

      while (roundQueue.length) {
        const kind = roundQueue.shift()
        if (!activeKinds.includes(kind)) {
          this.checkpointOrchestration(group, controller, { pendingKinds: [...roundQueue] })
          continue
        }
        if (controller.signal.aborted) break
        const executionKind = kind
        executionSequence += 1
        this.setCurrentAgent(controller, executionKind)
        this.checkpointOrchestration(group, controller, {
          currentKind: executionKind,
          pendingKinds: [...roundQueue],
          activeKinds: [...activeKinds],
          successfulKinds: [...successfulKinds],
          agreementKinds: [...agreementKinds],
          attachmentRecipients: [...attachmentRecipients],
          totalSuccesses,
          terminalFailureOccurred,
          executionSequence,
        })
        try {
          if (controller.attemptHistory.length >= MAX_RUN_AGENT_ATTEMPTS) {
            throw circuitBreakerError()
          }
          const collaborationPackage = this.prepareCollaborationPackage(
            group, controller, activeKinds, executionKind, threadRootId,
          )
          const attachments = attachmentRecipients.has(executionKind)
            ? []
            : rootAttachments.map(attachment => attachment.path)
          const invocation = await this.invokeWithUnauthorizedRecovery({
            group,
            kind: executionKind,
            controller,
            activeKinds,
            threadRootId,
            context: {
              attachments,
              attachmentSnapshots: attachments.length ? rootAttachments : [],
              skillHints: rootSkillsByKind.get(executionKind) || [],
              knowledgeBaseHints: rootKnowledgeBasesByKind.get(executionKind) || [],
              runtimeInstruction: replacementInstructions.get(executionKind) || '',
              collaborationPackage,
              contextOptions: {
                focusUserMessageId: threadRootId,
                omitAgentThreadRootId: threadRootId,
              },
              executionSequence,
            },
            reportedFailures,
          })
          replacementInstructions.delete(executionKind)
          if (invocation.control?.action === 'replace') {
            this.recordAgentInterruption(
              group.id, executionKind, invocation.error, threadRootId, 'stopped', reportedFailures,
            )
            if (!controller.failedKinds.includes(executionKind)) {
              controller.failedKinds.push(executionKind)
            }
            if (!controller.completedKinds.includes(executionKind)) {
              controller.completedKinds.push(executionKind)
            }
            successfulKinds.delete(executionKind)
            agreementKinds.delete(executionKind)
            const replacementKind = invocation.control.replacementKind
            activeKinds = activeKinds.filter(activeKind => activeKind !== executionKind)
            replacementInstructions.set(
              replacementKind,
              this.replacementInstruction(executionKind),
            )
            if (!roundQueue.includes(replacementKind)) roundQueue.unshift(replacementKind)
            controller.currentKind = ''
            controller.progress = []
            this.checkpointOrchestration(group, controller, {
              currentKind: '',
              pendingKinds: [...roundQueue],
              activeKinds: [...activeKinds],
              successfulKinds: [...successfulKinds],
              agreementKinds: [...agreementKinds],
            })
            this.emitChanged()
            continue
          }
          if (invocation.control?.action === 'cancel') {
            this.recordAgentInterruption(
              group.id, executionKind, invocation.error, threadRootId, 'stopped', reportedFailures,
            )
            if (!controller.failedKinds.includes(executionKind)) {
              controller.failedKinds.push(executionKind)
            }
            if (!controller.completedKinds.includes(executionKind)) {
              controller.completedKinds.push(executionKind)
            }
            successfulKinds.delete(executionKind)
            agreementKinds.delete(executionKind)
            controller.currentKind = ''
            controller.progress = []
            this.checkpointOrchestration(group, controller, {
              currentKind: '',
              pendingKinds: [...roundQueue],
              successfulKinds: [...successfulKinds],
              agreementKinds: [...agreementKinds],
            })
            this.emitChanged()
            continue
          }
          const result = invocation.result
          if (attachments.length) attachmentRecipients.add(executionKind)
          successfulKinds.add(executionKind)
          if (result.consensus) agreementKinds.add(executionKind)
          else agreementKinds.delete(executionKind)
          this.recordCollaborationResult(
            group, controller, activeKinds, executionKind, result,
          )
        } catch (error) {
          if (circuitBreakerFailure(error)) {
            controller.stopReason = 'circuit_breaker'
            controller.abort()
            break
          }
          const hardBudget = hardBudgetFailure(error)
          if (hardBudget) {
            this.recordAgentFailure(
              group.id, executionKind, error, threadRootId, reportedFailures,
            )
            successfulKinds.delete(executionKind)
            agreementKinds.delete(executionKind)
            if (!controller.failedKinds.includes(executionKind)) {
              controller.failedKinds.push(executionKind)
            }
            if (!controller.completedKinds.includes(executionKind)) {
              controller.completedKinds.push(executionKind)
            }
            terminalFailureOccurred = true
            controller.stopReason = 'hard_budget'
            controller.abort()
            break
          }
          if (controller.signal.aborted) {
            const interruptedKind = controller.currentKind || executionKind
            if (error?.runTrace) {
              this.recordAgentInterruption(
                group.id,
                interruptedKind,
                error,
                threadRootId,
                controller.stopReason === 'shutdown' ? 'interrupted' : 'stopped',
                reportedFailures,
              )
              if (!controller.completedKinds.includes(interruptedKind)) {
                controller.completedKinds.push(interruptedKind)
              }
              controller.currentKind = ''
              controller.progress = []
              this.emitChanged()
            }
            break
          }
          this.recordAgentFailure(
            group.id, executionKind, error, threadRootId, reportedFailures,
          )
          successfulKinds.delete(executionKind)
          agreementKinds.delete(executionKind)
          if (!controller.failedKinds.includes(executionKind)) {
            controller.failedKinds.push(executionKind)
          }
          terminalFailureOccurred = true
          // Failed CLIs leave only this run's active queue; the configured
          // group keeps them so the next turn can retry.
          if (this.shouldPauseFailedAgent(error)) {
            this.pauseFailedAgentForRun(group, controller, executionKind, threadRootId, error)
          }
          activeKinds = activeKinds.filter(activeKind => activeKind !== executionKind)
        }
        if (controller.signal.aborted) break
        if (!controller.completedKinds.includes(executionKind)) {
          controller.completedKinds.push(executionKind)
        }
        controller.currentKind = ''
        controller.progress = []
        this.checkpointOrchestration(group, controller, {
          currentKind: '',
          pendingKinds: [...roundQueue],
          activeKinds: [...activeKinds],
          successfulKinds: [...successfulKinds],
          agreementKinds: [...agreementKinds],
          attachmentRecipients: [...attachmentRecipients],
          totalSuccesses,
          terminalFailureOccurred,
          executionSequence,
        })
        this.emitChanged()
      }

      if (controller.signal.aborted) break
      const successes = activeKinds.filter(kind => successfulKinds.has(kind)).length
      const agreements = activeKinds.filter(kind => agreementKinds.has(kind)).length
      totalSuccesses += successes
      this.checkpointOrchestration(group, controller, {
        currentKind: '',
        pendingKinds: [],
        activeKinds: [...activeKinds],
        successfulKinds: [...successfulKinds],
        agreementKinds: [...agreementKinds],
        attachmentRecipients: [...attachmentRecipients],
        totalSuccesses,
        terminalFailureOccurred,
        executionSequence,
      })
      if (activeKinds.length < 2) break
      const crossReviewComplete = !controller.unlimitedRounds || controller.currentRound >= 2
      if (crossReviewComplete
          && successes === activeKinds.length
          && agreements === activeKinds.length) {
        consensusReached = true
        break
      }
    }

    let runStatus
    if (controller.signal.aborted) {
      runStatus = terminalRunStatusForReason(controller.stopReason)
    } else if (terminalFailureOccurred) runStatus = totalSuccesses > 0 ? 'partial' : 'failed'
    else if (consensusReached) runStatus = 'completed'
    else runStatus = totalSuccesses > 0 ? 'round-limit' : 'failed'
    if (!terminalFailureOccurred && !controller.unlimitedRounds
        && (runStatus === 'round-limit' || runStatus === 'failed')) {
      this.addMessage(
        group.id,
        'system',
        `Automatic discussion reached its ${maxRounds}-round limit. The latest replies above are the current result.`,
        '',
        threadRootId,
        { key: 'system.autoRoundLimit', params: { rounds: maxRounds } },
      )
    }
    if (controller.stopReason === 'circuit_breaker') {
      this.addMessage(
        group.id,
        'system',
        `Automatic discussion stopped after ${MAX_RUN_AGENT_ATTEMPTS} Agent attempts.`,
        '',
        threadRootId,
        {
          key: 'system.runCircuitBreaker',
          params: { maxAttempts: MAX_RUN_AGENT_ATTEMPTS },
        },
      )
    }
    return runStatus
  },
}

module.exports = { roundsMethods }

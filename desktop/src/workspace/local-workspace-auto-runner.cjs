const { createHash } = require('node:crypto')
const { cleanText, normalizeKnowledgeBaseHint } = require('./local-workspace-inputs.cjs')
const { emptyCollaborationState } = require('../collaboration/collaboration-records.cjs')
const { parseTaskGraphCursor } = require('../collaboration/task-graph-records.cjs')
const { abortableDelay, terminalRunStatusForReason } = require('./local-workspace-auto-runner-support.cjs')
const { v4NaturalDecisionMethods } = require('./local-workspace-auto-runner-natural-decisions.cjs')
const { v4OutcomeMethods } = require('./local-workspace-auto-runner-v4-outcomes.cjs')
const { recoveryMethods } = require('./local-workspace-auto-runner-recovery.cjs')
const { collaborationMethods } = require('./local-workspace-auto-runner-collaboration.cjs')
const { taskGraphMethods } = require('./local-workspace-auto-runner-task-graph.cjs')
const { v4SynthesisMethods } = require('./local-workspace-auto-runner-v4-synthesis.cjs')
const { v4ContextMethods } = require('./local-workspace-auto-runner-v4-context.cjs')
const { v4DeliveryMethods } = require('./local-workspace-auto-runner-v4-delivery.cjs')
const { naturalDiscussionMethods } = require('./local-workspace-auto-runner-natural-discussion.cjs')
const { v4ResultMethods } = require('./local-workspace-auto-runner-v4-results.cjs')
const { v4PhaseMethods } = require('./local-workspace-auto-runner-v4-phase.cjs')
const { v4DiscussionMethods } = require('./local-workspace-auto-runner-v4-discussion.cjs')
const { roundsMethods } = require('./local-workspace-auto-runner-rounds.cjs')

class LocalWorkspaceAutoRunner {
  constructor(options) {
    this.state = options.state
    this.canWriteWorkspace = options.canWriteWorkspace || (() => false)
    this.beginRun = options.beginRun
    this.resolveAttachments = options.resolveAttachments
    this.validateSkillSelections = options.validateSkillSelections
    this.validateKnowledgeBaseSelections = options.validateKnowledgeBaseSelections
    this.invokeAgent = options.invokeAgent
    this.defaultYolo = options.defaultYolo !== false
    this.naturalAgentResponses = options.naturalAgentResponses === true
    this.resetAgentSession = options.resetAgentSession
    this.refreshAgents = options.refreshAgents
    this.consumeAgentControl = options.consumeAgentControl
    this.markRuntimeCredential = options.markRuntimeCredential
    this.agentLabel = options.agentLabel
    this.recordAgentFailure = options.recordAgentFailure
    this.recordAgentInterruption = options.recordAgentInterruption
    this.addMessage = options.addMessage
    this.reserveTurnSeqs = typeof options.reserveTurnSeqs === 'function'
      ? options.reserveTurnSeqs
      : () => []
    this.commitV4AgentMessage = typeof options.commitV4AgentMessage === 'function'
      ? options.commitV4AgentMessage
      : null
    this.emitChanged = options.emitChanged
    this.finishRun = options.finishRun
    this.outcomeStore = options.outcomeStore || null
    this.contentBlobStore = options.contentBlobStore || null
    this.checkpointRun = options.checkpointRun
    this.hasRunLedger = typeof options.hasRunLedger === 'function'
      ? options.hasRunLedger
      : () => false
    this.requestHumanGate = typeof options.requestHumanGate === 'function'
      ? options.requestHumanGate
      : null
    this.requestTaskDecision = options.requestTaskDecision || null
    this.taskDecisionResponses = options.taskDecisionResponses || (() => [])
    this.completeHumanGateContinuation = typeof options.completeHumanGateContinuation === 'function'
      ? options.completeHumanGateContinuation
      : null
    this.retryContract = typeof options.retryContract === 'function'
      ? options.retryContract
      : () => ({ idempotencyMode: 'none' })
    this.retryBaseDelayMs = Number.isFinite(options.retryBaseDelayMs)
      ? Math.max(1, Math.floor(options.retryBaseDelayMs))
      : 250
    this.retryMaxDelayMs = Number.isFinite(options.retryMaxDelayMs)
      ? Math.max(this.retryBaseDelayMs, Math.floor(options.retryMaxDelayMs))
      : 2000
    // Provider throttling without a Retry-After hint waits at least this long
    // so automatic retries do not burn the remaining quota within a second.
    this.retryRateLimitMinDelayMs = Number.isFinite(options.retryRateLimitMinDelayMs)
      ? Math.max(0, Math.floor(options.retryRateLimitMinDelayMs))
      : 2000
    this.sleep = options.retrySleep || abortableDelay
  }

  async automaticContext(group, controller, threadRootId, preparedContext = null) {
    let rootAttachments = preparedContext?.attachments
    let rootSkillsByKind = preparedContext?.skillHintsByKind
    let rootKnowledgeBasesByKind = preparedContext?.knowledgeBaseHintsByKind
    if (!rootAttachments || !rootSkillsByKind || !rootKnowledgeBasesByKind) {
      const rootMessage = this.state().messages.find(message => (
        message.id === threadRootId && message.groupId === group.id && message.role === 'user'
      ))
      rootAttachments = await this.resolveAttachments(rootMessage?.attachments || [])
      rootSkillsByKind = new Map()
      for (const kind of controller.targetKinds) {
        const scoped = (rootMessage?.skillHints || []).filter(skill => skill.targetKind === kind)
        if (!scoped.length) {
          rootSkillsByKind.set(kind, [])
          continue
        }
        try {
          const validated = await this.validateSkillSelections(kind, scoped)
          rootSkillsByKind.set(
            kind,
            Array.isArray(validated) && validated.every(skill => skill?.targetKind === kind)
              ? validated
              : [],
          )
        } catch {
          rootSkillsByKind.set(kind, [])
        }
      }
      let storedKnowledgeBaseHints = []
      try {
        const validated = await this.validateKnowledgeBaseSelections(
          controller.targetKinds,
          rootMessage?.knowledgeBaseHints || [],
        )
        storedKnowledgeBaseHints = (Array.isArray(validated) ? validated : [])
          .map(normalizeKnowledgeBaseHint)
          .filter(Boolean)
      } catch { /* unavailable knowledge bases are omitted when resuming */ }
      rootKnowledgeBasesByKind = new Map(controller.targetKinds.map(kind => [
        kind,
        storedKnowledgeBaseHints.filter(source => source.targetKinds.includes(kind)),
      ]))
    }
    return {
      rootAttachments,
      rootSkillsByKind,
      rootKnowledgeBasesByKind,
    }
  }

  v4Enabled(controller) {
    return controller?.v4 === true || controller?.orchestration?.version === 4
  }

  v4BatchId(controller, phase = 'proposal') {
    const digest = createHash('sha256').update(JSON.stringify([
      controller.runId,
      controller.taskId,
      phase,
      controller.currentRound || 0,
    ])).digest('hex').slice(0, 32)
    return `batch-${digest}`
  }

  start(
    group, targetKinds, threadRootId, maxRounds, reservation = null, preparedContext = null,
    unlimitedRounds = false, taskGraph = null,
  ) {
    const v4 = reservation?.v4 === true
    if (!v4) reservation.orchestration = this.orchestrationCursor(targetKinds, taskGraph)
    const controller = this.beginRun(
      group.id, 'auto', targetKinds, threadRootId, reservation, maxRounds, unlimitedRounds,
    )
    controller.v4 = v4
    controller.discussionStyle = reservation?.discussionStyle || 'sequential'
    const promise = (async () => {
      let runStatus = 'failed'
      try {
        const context = await this.automaticContext(
          group, controller, threadRootId, preparedContext,
        )
        runStatus = v4
          ? await this.runV4Discussion(group, controller, threadRootId, context)
          : taskGraph
          ? await this.runTaskGraph(group, controller, threadRootId, context)
          : await this.runRounds(group, controller, threadRootId, maxRounds, context)
      } catch (error) {
        runStatus = controller.signal.aborted
          ? terminalRunStatusForReason(controller.stopReason)
          : 'failed'
        if (!controller.signal.aborted) {
          const rawReason = cleanText(error?.message || error, 2000)
          const reason = /^[A-Z][A-Z0-9_]+$/.test(rawReason)
            ? rawReason
            : 'LOCAL_AGENT_UNKNOWN_FAILURE'
          try {
            this.addMessage(
              group.id,
              'system',
              `Automatic discussion stopped: ${reason}`,
              '',
              threadRootId,
              { key: 'system.autoStopped', params: { reason } },
            )
          } catch { /* persistence failures cannot be reported through the same store */ }
        }
      } finally {
        controller.currentKind = ''
        controller.progress = []
        if (controller.signal.aborted) {
          runStatus = terminalRunStatusForReason(controller.stopReason)
        }
        await this.finishRun(group.id, controller, runStatus)
      }
    })()
    controller.promise = promise
    promise.catch(() => {})
    return controller
  }

  async resume(group, durable, controller, replayedResult = null, resumedGate = null) {
    if (controller.orchestration?.version === 4 || controller.v4 === true) {
      controller.v4 = true
      const context = {
        rootAttachments: [],
        rootSkillsByKind: new Map(controller.targetKinds.map(kind => [kind, []])),
        rootKnowledgeBasesByKind: new Map(controller.targetKinds.map(kind => [kind, []])),
      }
      return this.runV4Discussion(
        group, controller, durable.threadRootId, context, true, resumedGate,
      )
    }
    if (controller.orchestration?.version === 3) {
      const cursor = parseTaskGraphCursor(controller.orchestration.taskGraph)
      const runningNodeId = cursor.currentNodeIds.length === 1
        ? cursor.currentNodeIds[0]
        : ''
      const node = cursor.graph.nodes.find(candidate => candidate.nodeId === runningNodeId)
      if (replayedResult && node?.role !== 'human') {
        this.applyTaskGraphAgentResult(group, controller, node, replayedResult)
      }
      const context = await this.automaticContext(
        group, controller, durable.threadRootId, null,
      )
      return this.runTaskGraph(group, controller, durable.threadRootId, context)
    }
    if (controller.orchestration?.version === 1) {
      controller.orchestration = {
        ...controller.orchestration,
        version: 2,
        collaboration: emptyCollaborationState(),
      }
      const persisted = this.checkpointRun?.(group.id, controller)
      if (this.hasRunLedger() && persisted !== true) {
        throw new Error('LOCAL_RUN_PERSIST_FAILED')
      }
    }
    const context = await this.automaticContext(
      group, controller, durable.threadRootId, null,
    )
    return this.runRounds(
      group, controller, durable.threadRootId, durable.maxRounds, context, true,
    )
  }

  async resumeDecision(group, durable, controller, decision) {
    const cursor = parseTaskGraphCursor(controller.orchestration?.taskGraph)
    const waiting = cursor.nodeStates.find(state => state.status === 'waiting')
    const node = cursor.graph.nodes.find(candidate => candidate.nodeId === waiting?.nodeId)
    if (!node || node.role !== 'human') throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
    const expectedAgentRunId = this.taskGraphDecisionAgentRunId(cursor.graph.graphId, node.nodeId)
    if (durable.continuation?.agentRunId !== expectedAgentRunId) {
      throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
    }
    const accepted = this.applyTaskGraphHumanDecision(group, controller, node, decision)
    if (this.completeHumanGateContinuation?.(
      controller.runId,
      durable.continuation.gateId,
      accepted ? 'completed' : 'cancelled',
    ) !== true && this.hasRunLedger()) {
      throw new Error('LOCAL_RUN_PERSIST_FAILED')
    }
    const context = await this.automaticContext(
      group, controller, durable.threadRootId, null,
    )
    return this.runTaskGraph(group, controller, durable.threadRootId, context)
  }
}

Object.assign(
  LocalWorkspaceAutoRunner.prototype,
  v4NaturalDecisionMethods,
  v4OutcomeMethods,
  recoveryMethods,
  collaborationMethods,
  taskGraphMethods,
  v4SynthesisMethods,
  v4ContextMethods,
  v4DeliveryMethods,
  naturalDiscussionMethods,
  v4ResultMethods,
  v4PhaseMethods,
  v4DiscussionMethods,
  roundsMethods,
)

module.exports = { LocalWorkspaceAutoRunner }

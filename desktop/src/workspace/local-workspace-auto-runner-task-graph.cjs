// V3 task-graph runs. Kept so older runs can be resumed; new runs do not use it.
const { createHash } = require('node:crypto')
const {
  appendBlackboardEntry,
  emptyCollaborationState,
  publicCollaborationText,
} = require('../collaboration/collaboration-records.cjs')
const { unlimitedReviewContract } = require('./local-workspace-context.cjs')
const {
  parseTaskGraphCursor,
  readyTaskGraphNodes,
  terminalTaskGraphState,
  updateTaskGraphCursor,
} = require('../collaboration/task-graph-records.cjs')
const {
  circuitBreakerFailure,
  hardBudgetFailure,
  terminalRunStatusForReason,
} = require('./local-workspace-auto-runner-support.cjs')

const taskGraphMethods = {
  unresolvedTaskGraphConflicts(collaborationInput = null) {
    const collaboration = collaborationInput || emptyCollaborationState()
    const resolved = new Set(collaboration.entries
      .filter(entry => entry.entryType === 'decision' && entry.lifecycle.state === 'active')
      .flatMap(entry => entry.refs))
    return collaboration.entries.filter(entry => (
      entry.entryType === 'conflict'
      && entry.lifecycle.state === 'active'
      && !resolved.has(entry.entryId)
    ))
  },

  taskGraphAcceptanceCriteria(node) {
    const criteria = []
    if (node.acceptance.requireConclusion) criteria.push('Return one concrete conclusion.')
    if (node.acceptance.minArtifactRefs) {
      criteria.push(`Produce at least ${node.acceptance.minArtifactRefs} durable Artifact reference(s).`)
    }
    if (node.acceptance.minEvidenceRefs) {
      criteria.push(`Produce at least ${node.acceptance.minEvidenceRefs} durable Evidence reference(s).`)
    }
    return criteria.length ? criteria : ['Complete the explicit Human decision.']
  },

  taskGraphSelectedEntryIds(controller, node) {
    const cursor = parseTaskGraphCursor(controller.orchestration.taskGraph)
    const states = new Map(cursor.nodeStates.map(state => [state.nodeId, state]))
    const selected = node.inputNodeIds.flatMap(nodeId => states.get(nodeId)?.entryIds || [])
    if (['reviewer', 'arbiter'].includes(node.role)) {
      selected.push(...this.unresolvedTaskGraphConflicts(
        controller.orchestration.collaboration,
      ).map(entry => entry.entryId))
    }
    return [...new Set(selected)]
  },

  taskGraphPrompt(node, objective, collaborationPackage, unlimitedRounds = false) {
    return [
      'MELDWORK_TASK_GRAPH_V1',
      `Node: ${node.nodeId}`,
      `Role: ${node.role}`,
      `Objective: ${objective}`,
      `Expected output: ${node.expectedOutput}`,
      `Acceptance criteria: ${this.taskGraphAcceptanceCriteria(node).join(' | ')}`,
      unlimitedReviewContract(unlimitedRounds),
      collaborationPackage.text,
      'Return the requested result directly. Completion is evaluated from durable typed records; do not emit a consensus marker.',
    ].join('\n')
  },

  checkpointTaskGraph(group, controller, cursorInput, options = {}) {
    let taskGraph = parseTaskGraphCursor(cursorInput)
    taskGraph = parseTaskGraphCursor({
      ...taskGraph,
      terminalState: terminalTaskGraphState(taskGraph),
    })
    const states = new Map(taskGraph.nodeStates.map(state => [state.nodeId, state]))
    const pendingKinds = taskGraph.graph.nodes
      .filter(node => states.get(node.nodeId)?.status === 'pending' && node.agentKind)
      .map(node => node.agentKind)
    const successfulKinds = taskGraph.graph.nodes
      .filter(node => states.get(node.nodeId)?.status === 'accepted' && node.agentKind)
      .map(node => node.agentKind)
    const uniquePendingKinds = [...new Set(pendingKinds)]
    const uniqueSuccessfulKinds = [...new Set(successfulKinds)]
    this.checkpointOrchestration(group, controller, {
      taskGraph,
      currentKind: options.currentKind || '',
      pendingKinds: uniquePendingKinds,
      successfulKinds: uniqueSuccessfulKinds,
      agreementKinds: [],
      totalSuccesses: taskGraph.nodeStates.filter(state => state.status === 'accepted').length,
      terminalFailureOccurred: taskGraph.terminalState === 'failed',
    })
    return taskGraph
  },

  taskGraphResultAccepted(node, result) {
    const conclusion = publicCollaborationText(result?.message?.content || '')
    const artifactIds = result?.outcomeRefs?.artifactIds || []
    const evidenceIds = result?.outcomeRefs?.evidenceIds || []
    return (!node.acceptance.requireConclusion || Boolean(conclusion))
      && artifactIds.length >= node.acceptance.minArtifactRefs
      && evidenceIds.length >= node.acceptance.minEvidenceRefs
  },

  applyTaskGraphAgentResult(group, controller, node, result) {
    const conflicts = this.unresolvedTaskGraphConflicts(controller.orchestration.collaboration)
    const entryIds = this.recordCollaborationResult(
      group,
      controller,
      controller.orchestration.activeKinds,
      node.agentKind,
      result,
      {
        role: node.role,
        entryType: node.role === 'arbiter' ? 'decision' : 'claim',
        subject: node.role === 'primary'
          ? `task:${controller.taskId}:conclusion`
          : `task:${controller.taskId}:node:${node.nodeId}`,
        refs: node.role === 'arbiter' ? conflicts.map(entry => entry.entryId) : [],
      },
    )
    const accepted = this.taskGraphResultAccepted(node, result)
    const conclusion = publicCollaborationText(result?.message?.content || '')
    const artifactIds = result?.outcomeRefs?.artifactIds || []
    const evidenceIds = result?.outcomeRefs?.evidenceIds || []
    let cursor = updateTaskGraphCursor(
      controller.orchestration.taskGraph,
      node.nodeId,
      {
        status: accepted ? 'accepted' : 'failed',
        entryIds,
        artifactIds,
        evidenceIds,
        conclusionHash: conclusion
          ? createHash('sha256').update(conclusion).digest('hex')
          : '',
      },
    )
    if (accepted) {
      if (!controller.completedKinds.includes(node.agentKind)) {
        controller.completedKinds.push(node.agentKind)
      }
    } else if (!controller.failedKinds.includes(node.agentKind)) {
      controller.failedKinds.push(node.agentKind)
    }
    cursor = this.checkpointTaskGraph(group, controller, cursor)
    return accepted
  },

  taskGraphDecisionAgentRunId(graphId, nodeId) {
    const digest = createHash('sha256').update(JSON.stringify([graphId, nodeId])).digest('hex')
    return `graph-decision-${digest}`
  },

  taskGraphDecisionAnchor(controller, node) {
    const graph = parseTaskGraphCursor(controller.orchestration.taskGraph)
    const byId = new Map(graph.graph.nodes.map(candidate => [candidate.nodeId, candidate]))
    return [...node.dependsOn].reverse()
      .map(nodeId => byId.get(nodeId)?.agentKind)
      .find(Boolean) || controller.targetKinds[0]
  },

  applyTaskGraphHumanDecision(group, controller, node, decision) {
    const option = node.decisionOptions.find(candidate => candidate.optionId === decision.optionId)
    if (!option) throw new Error('LOCAL_WORKFLOW_DECISION_INVALID')
    const accepted = decision.status === 'approved'
    const conflicts = this.unresolvedTaskGraphConflicts(controller.orchestration.collaboration)
    let collaboration = controller.orchestration.collaboration
    collaboration = appendBlackboardEntry(collaboration, {
      entryType: 'decision',
      subject: `task:${controller.taskId}:node:${node.nodeId}`,
      statement: `Human selected: ${option.name}`,
      value: '',
      owner: { type: 'harness' },
      audience: { roles: ['primary', 'reviewer', 'arbiter'], agentKinds: [] },
      lifecycle: {
        state: 'active',
        sequence: collaboration.entries.length + 1,
        recordedAt: Date.now(),
        supersedesEntryId: null,
      },
      provenance: {
        runId: controller.runId,
        taskId: controller.taskId,
        round: controller.currentRound,
        agentRunId: this.taskGraphDecisionAgentRunId(
          controller.orchestration.taskGraph.graph.graphId,
          node.nodeId,
        ),
        artifactIds: [],
        evidenceIds: [],
      },
      refs: conflicts.map(entry => entry.entryId),
    })
    const decisionEntryId = collaboration.entries.at(-1).entryId
    this.checkpointOrchestration(group, controller, { collaboration })
    let cursor = updateTaskGraphCursor(
      controller.orchestration.taskGraph,
      node.nodeId,
      {
        status: accepted ? 'accepted' : 'rejected',
        entryIds: [decisionEntryId],
        decisionOptionId: option.optionId,
      },
    )
    cursor = this.checkpointTaskGraph(group, controller, cursor)
    return accepted
  },

  async executeTaskGraphAgentNode(
    group, controller, threadRootId, context, node, parallelGraph = false,
  ) {
    const selectedEntryIds = this.taskGraphSelectedEntryIds(controller, node)
    const collaborationPackage = this.prepareCollaborationPackage(
      group,
      controller,
      controller.orchestration.activeKinds,
      node.agentKind,
      threadRootId,
      {
        role: node.role,
        selectedEntryIds,
        expectedOutput: node.expectedOutput,
        acceptanceCriteria: this.taskGraphAcceptanceCriteria(node),
      },
    )
    const isolated = ['reviewer', 'arbiter'].includes(node.role)
    const attachments = node.role === 'primary'
      && !controller.orchestration.attachmentRecipients.includes(node.agentKind)
      ? context.rootAttachments.map(attachment => attachment.path)
      : []
    const objective = this.collaborationObjective(group, controller, threadRootId)
    return this.invokeWithUnauthorizedRecovery({
      group,
      kind: node.agentKind,
      controller,
      threadRootId,
      context: {
        attachments,
        attachmentSnapshots: attachments.length ? context.rootAttachments : [],
        skillHints: context.rootSkillsByKind.get(node.agentKind) || [],
        knowledgeBaseHints: context.rootKnowledgeBasesByKind.get(node.agentKind) || [],
        collaborationPackage,
        completionPolicy: 'typed',
        parallelGraph,
        runtimeInstruction: isolated ? '' : [
          `Execute task-graph node ${node.nodeId} as ${node.role}.`,
          `Expected output: ${node.expectedOutput}`,
          'Do not emit a consensus marker.',
        ].join('\n'),
        ...(isolated ? {
          sessionPolicy: 'isolated',
          promptOverride: this.taskGraphPrompt(
            node, objective, collaborationPackage, controller.unlimitedRounds === true,
          ),
          contextPackId: controller.contextPackId,
        } : {}),
        contextOptions: {
          focusUserMessageId: threadRootId,
          omitAgentThreadRootId: threadRootId,
        },
      },
      mode: 'auto',
    })
  },

  async executeTaskGraphHumanNode(group, controller, node) {
    if (!this.requestHumanGate) throw new Error('LOCAL_WORKFLOW_DECISION_UNAVAILABLE')
    const anchorKind = this.taskGraphDecisionAnchor(controller, node)
    const agentRunId = this.taskGraphDecisionAgentRunId(
      controller.orchestration.taskGraph.graph.graphId,
      node.nodeId,
    )
    let cursor = updateTaskGraphCursor(
      controller.orchestration.taskGraph,
      node.nodeId,
      { status: 'waiting', attention: 'decision', attempts: 1 },
    )
    cursor = this.checkpointTaskGraph(group, controller, cursor, { currentKind: anchorKind })
    const gate = await this.requestHumanGate({
      type: 'decision',
      runId: controller.runId,
      agentRunId,
      agentKind: anchorKind,
      summary: node.expectedOutput,
      options: node.decisionOptions,
      request: {
        graphId: cursor.graph.graphId,
        nodeId: node.nodeId,
        inputNodeIds: node.inputNodeIds,
      },
    }, {
      signal: controller.signal,
      preserveOnAbort: () => controller.stopReason === 'shutdown',
      continuation: {
        resumeKind: 'role_review_decision',
        agentRunId,
        agentKind: anchorKind,
        round: controller.currentRound,
      },
    })
    const accepted = this.applyTaskGraphHumanDecision(group, controller, node, gate)
    if (this.completeHumanGateContinuation?.(
      controller.runId,
      gate.gateId,
      accepted ? 'completed' : 'cancelled',
    ) !== true && this.hasRunLedger()) {
      throw new Error('LOCAL_RUN_PERSIST_FAILED')
    }
    return accepted
  },

  taskGraphBatch(group, readyNodes) {
    const parallel = []
    const kinds = new Set()
    if (group.allowWrite !== true) {
      for (const node of readyNodes) {
        if (!node.parallel || node.role === 'human' || kinds.has(node.agentKind)) continue
        parallel.push(node)
        kinds.add(node.agentKind)
      }
    }
    return parallel.length > 1 ? parallel : readyNodes.slice(0, 1)
  },

  async runTaskGraph(group, controller, threadRootId, context) {
    while (!controller.signal.aborted) {
      let cursor = parseTaskGraphCursor(controller.orchestration.taskGraph)
      const terminalState = terminalTaskGraphState(cursor)
      if (terminalState !== 'running') {
        cursor = this.checkpointTaskGraph(group, controller, cursor)
        break
      }
      if (!controller.unlimitedRounds && controller.currentRound >= controller.maxRounds) break
      const readyNodes = readyTaskGraphNodes(cursor)
      if (!readyNodes.length) {
        cursor = parseTaskGraphCursor({ ...cursor, terminalState: 'failed' })
        this.checkpointTaskGraph(group, controller, cursor)
        break
      }
      const batch = this.taskGraphBatch(group, readyNodes)
      controller.currentRound += 1
      if (batch.length === 1 && batch[0].role === 'human') {
        await this.executeTaskGraphHumanNode(group, controller, batch[0])
        continue
      }
      const conflicts = this.unresolvedTaskGraphConflicts(controller.orchestration.collaboration)
      for (const node of batch) {
        cursor = updateTaskGraphCursor(cursor, node.nodeId, {
          status: 'running',
          attention: node.role === 'reviewer' && conflicts.length
            ? 'review'
            : (node.role === 'arbiter' && conflicts.length ? 'decision' : 'none'),
          attempts: cursor.nodeStates.find(state => state.nodeId === node.nodeId).attempts + 1,
        })
      }
      const currentKind = batch.length === 1 ? batch[0].agentKind : ''
      cursor = this.checkpointTaskGraph(group, controller, cursor, { currentKind })
      this.emitChanged()
      const settled = await Promise.allSettled(batch.map(node => (
        this.executeTaskGraphAgentNode(
          group, controller, threadRootId, context, node, batch.length > 1,
        )
      )))
      for (let index = 0; index < batch.length; index += 1) {
        const node = batch[index]
        const outcome = settled[index]
        if (outcome.status === 'fulfilled' && outcome.value?.result) {
          if (outcome.value.result.outcomeRefs?.artifactIds?.length
              && !controller.orchestration.attachmentRecipients.includes(node.agentKind)) {
            this.checkpointOrchestration(group, controller, {
              attachmentRecipients: [...controller.orchestration.attachmentRecipients, node.agentKind],
            })
          }
          this.applyTaskGraphAgentResult(group, controller, node, outcome.value.result)
          continue
        }
        const error = outcome.status === 'rejected'
          ? outcome.reason
          : (outcome.value?.error || new Error('LOCAL_AGENT_UNKNOWN_FAILURE'))
        if (controller.signal.aborted) continue
        this.recordAgentFailure(group.id, node.agentKind, error, threadRootId, new Set())
        cursor = updateTaskGraphCursor(
          controller.orchestration.taskGraph,
          node.nodeId,
          { status: 'failed' },
        )
        this.checkpointTaskGraph(group, controller, cursor)
        if (!controller.failedKinds.includes(node.agentKind)) {
          controller.failedKinds.push(node.agentKind)
        }
        if (circuitBreakerFailure(error)) {
          controller.stopReason = 'circuit_breaker'
          controller.abort()
        } else if (hardBudgetFailure(error)) {
          controller.stopReason = 'hard_budget'
          controller.abort()
        }
      }
      controller.currentKind = ''
      controller.progress = []
      this.emitChanged()
    }

    if (controller.signal.aborted) return terminalRunStatusForReason(controller.stopReason)
    const cursor = parseTaskGraphCursor(controller.orchestration.taskGraph)
    if (cursor.terminalState === 'accepted') return 'completed'
    if (cursor.terminalState === 'rejected') return 'stopped'
    if (cursor.terminalState === 'failed') {
      return cursor.nodeStates.some(state => state.status === 'accepted') ? 'partial' : 'failed'
    }
    return cursor.nodeStates.some(state => state.status === 'accepted') ? 'round-limit' : 'failed'
  },
}

module.exports = { taskGraphMethods }

// V3 task-graph runs. Kept so older runs can be resumed; new runs do not use it.
const { createHash } = require('node:crypto')
const { canonicalJson } = require('../collaboration/context-pack-records.cjs')
const {
  appendBlackboardEntry,
  emptyCollaborationState,
  publicCollaborationText,
} = require('../collaboration/collaboration-records.cjs')
const { unlimitedReviewContract } = require('./local-workspace-context.cjs')
const { explicitTaskFailure } = require('./local-workspace-auto-runner-natural-decisions.cjs')
const {
  assertTaskGraphDependencies,
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
  validateTaskGraphRecoveredResults(controller) {
    const cursor = parseTaskGraphCursor(controller.orchestration.taskGraph)
    const entries = controller.orchestration.collaboration?.entries || []
    for (const state of cursor.nodeStates) {
      const node = cursor.graph.nodes.find(candidate => candidate.nodeId === state.nodeId)
      if (state.status !== 'accepted' && !(node.role === 'human' && state.status === 'rejected')) continue
      if (node.role === 'human') {
        const option = node.decisionOptions.find(candidate => candidate.optionId === state.decisionOptionId)
        const decision = state.entryIds.length === 1
          ? entries.find(entry => entry.entryId === state.entryIds[0]) : null
        if (!option || option.kind !== (state.status === 'accepted' ? 'allow_once' : 'reject_once')
            || decision?.entryType !== 'decision' || decision.lifecycle?.state !== 'active'
            || (state.status === 'rejected' && decision.refs?.length !== 0)
            || decision.owner?.type !== 'harness' || decision.provenance?.runId !== controller.runId
            || decision.provenance.taskId !== controller.taskId
            || decision.provenance.agentRunId !== this.taskGraphDecisionAgentRunId(cursor.graph.graphId, node.nodeId)
            || decision.subject !== `task:${controller.taskId}:node:${node.nodeId}`
            || decision.statement !== `Human selected: ${option.name}`
            || decision.refs.some(id => !this.taskGraphHumanResolvableConflicts(controller, node).some(entry => entry.entryId === id))
            || (node.terminal && state.status === 'accepted'
              && this.unresolvedTaskGraphConflicts(controller.orchestration.collaboration).length > 0)
            || (decision.value !== option.optionId && !(decision.value === ''
              && node.decisionOptions.filter(candidate => candidate.name === option.name).length === 1))) {
          throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
        }
        continue
      }
      if (!state.entryIds.length && !node.acceptance.requireConclusion
          && !node.acceptance.minArtifactRefs && !node.acceptance.minEvidenceRefs) continue
      const selected = state.entryIds.map(id => entries.find(entry => entry.entryId === id))
      if (selected.some(entry => !entry || entry.lifecycle?.state !== 'active')) {
        throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
      }
      const claims = selected.filter(entry => ['claim', 'decision'].includes(entry.entryType)
        && entry.owner?.type === 'agent' && entry.owner.agentKind === node.agentKind
        && entry.provenance?.runId === controller.runId && entry.provenance.taskId === controller.taskId)
      if (claims.length > 1 || (node.acceptance.requireConclusion && claims.length !== 1)) {
        throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
      }
      const claim = claims[0]
      const anchor = claim || selected.find(entry => ['artifact-ref', 'evidence-ref'].includes(entry.entryType)
        && entry.owner?.type === 'agent' && entry.owner.agentKind === node.agentKind
        && entry.provenance?.runId === controller.runId && entry.provenance.taskId === controller.taskId)
      if (!anchor?.provenance.agentRunId) throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
      const subject = node.role === 'primary'
        ? (node.claimKey ? `task:${controller.taskId}:claim:${node.claimKey}` : `task:${controller.taskId}:conclusion`)
        : `task:${controller.taskId}:node:${node.nodeId}`
      const conclusionHash = claim?.statement ? createHash('sha256').update(claim.statement).digest('hex') : ''
      if (anchor.owner.role !== node.role || (claim && (claim.subject !== subject
          || claim.entryType !== (node.role === 'arbiter' ? 'decision' : 'claim')))
          || state.conclusionHash !== conclusionHash
          || canonicalJson(state.artifactIds) !== canonicalJson(anchor.provenance.artifactIds)
          || canonicalJson(state.evidenceIds) !== canonicalJson(anchor.provenance.evidenceIds)) {
        throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
      }
      const result = { message: { content: claim?.statement || '', trace: {
        status: 'completed', agentRunId: anchor.provenance.agentRunId,
      } }, outcomeRefs: { artifactIds: state.artifactIds, evidenceIds: state.evidenceIds } }
      const refs = this.taskGraphVerifiedOutcomeRefs(node, result, controller)
      if (canonicalJson(refs.artifactIds) !== canonicalJson(state.artifactIds)
          || canonicalJson(refs.evidenceIds) !== canonicalJson(state.evidenceIds)
          || !this.taskGraphResultAccepted(node, result, controller, refs)) {
        throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
      }
    }
    return true
  },

  restoreTaskGraphOutcomeReferences(group, controller) {
    this.validateTaskGraphRecoveredResults(controller)
    const cursor = parseTaskGraphCursor(controller.orchestration.taskGraph)
    for (const state of cursor.nodeStates) {
      if (state.status !== 'accepted') continue
      const node = cursor.graph.nodes.find(candidate => candidate.nodeId === state.nodeId)
      if (node.role === 'human') continue
      const entries = state.entryIds.map(id => controller.orchestration.collaboration.entries.find(entry => entry.entryId === id))
      const artifacts = entries.filter(entry => entry.entryType === 'artifact-ref')
      const evidence = entries.filter(entry => entry.entryType === 'evidence-ref')
      if (artifacts.length === state.artifactIds.length && evidence.length === state.evidenceIds.length) continue
      const claim = entries.find(entry => ['claim', 'decision'].includes(entry.entryType))
      const anchor = claim || artifacts[0] || evidence[0]
      if (!anchor?.provenance?.agentRunId) throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
      this.applyTaskGraphAgentResult(group, controller, node, {
        message: { content: claim?.statement || '', trace: { status: 'completed', agentRunId: anchor.provenance.agentRunId } },
        outcomeRefs: { artifactIds: state.artifactIds, evidenceIds: state.evidenceIds },
      })
    }
  },

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
      for (const conflict of this.unresolvedTaskGraphConflicts(controller.orchestration.collaboration)) {
        selected.push(conflict.entryId, ...conflict.refs)
        for (const state of cursor.nodeStates) {
          if (state.status === 'accepted' && state.entryIds.some(id => conflict.refs.includes(id))) {
            const outcomes = controller.orchestration.collaboration.entries.filter(entry => (
              state.entryIds.includes(entry.entryId) && ['artifact-ref', 'evidence-ref'].includes(entry.entryType)
            ))
            selected.push(...outcomes.map(entry => entry.entryId))
          }
        }
      }
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
      'Meldwork records your completed response as an Artifact and associated Evidence. Do not search for, invent, or output internal Artifact or Evidence IDs.',
      'Return the requested result directly. Completion is evaluated from durable typed records; do not emit a consensus marker.',
    ].join('\n')
  },

  taskGraphReviewOutcomeText(entries) {
    const lines = []
    let remaining = 24000
    for (const entry of entries) {
      if (!['artifact-ref', 'evidence-ref'].includes(entry.entryType)) continue
      const id = entry.refs?.[0]
      let label
      let raw
      if (entry.entryType === 'artifact-ref') {
        const identity = this.v4ArtifactIdentity(id)
        label = `Artifact ${id}`
        raw = identity.artifact.contentRef?.mediaType === 'text/plain'
          ? identity.content : '[Non-text artifact; content unavailable in this handoff.]'
      } else {
        const evidence = this.v4EvidenceRecord(id)
        label = `Evidence ${id} (${evidence.kind}, ${evidence.level})`
        raw = evidence.summary
      }
      const limit = Math.max(0, Math.min(6000, remaining))
      if (!limit) { lines.push('[Additional outcome content truncated.]'); break }
      const content = publicCollaborationText(raw || '', limit + 1)
      const truncated = content.length > limit
      const shown = content.slice(0, limit)
      lines.push(`${label}: ${shown}${truncated ? ' [Content truncated.]' : ''}`)
      remaining -= shown.length
    }
    return lines.length ? `Verified outcome content:\n${lines.join('\n')}\nDo not assume truncated or unavailable content was reviewed.` : ''
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

  taskGraphVerifiedOutcomeRefs(node, result, controller) {
    const artifacts = new Map()
    const evidence = new Set()
    for (const id of new Set(result?.outcomeRefs?.artifactIds || [])) {
      try {
        const identity = this.v4ArtifactIdentity(id)
        const producer = identity.artifact.producedBy
        if (producer.runId === controller?.runId && producer.agentRunId === result?.message?.trace?.agentRunId
            && producer.agentKind === node.agentKind) artifacts.set(id, identity)
      } catch { /* Missing or invalid outcomes cannot satisfy acceptance. */ }
    }
    for (const id of new Set(result?.outcomeRefs?.evidenceIds || [])) {
      try {
        const record = this.v4EvidenceRecord(id)
        const recorder = record.recordedBy || {}
        const authorized = recorder.kind === 'system' ? recorder.actorId === 'meldwork-main'
          : recorder.kind === 'agent' && recorder.runId === controller?.runId
            && recorder.agentRunId === result?.message?.trace?.agentRunId
            && recorder.agentKind === node.agentKind
        const bound = [...artifacts].some(([artifactId, identity]) => (
          (record.subject?.type === 'artifact' && record.subject.artifactId === artifactId
            || record.refs.some(reference => reference.type === 'artifact' && reference.artifactId === artifactId))
          && record.refs.some(reference => reference.type === 'blob'
            && reference.contentHash === identity.contentHash
            && canonicalJson(reference.contentRef) === canonicalJson(identity.artifact.contentRef))
        ))
        if (authorized && bound) {
          evidence.add(id)
        }
      } catch { /* Missing or invalid evidence cannot satisfy acceptance. */ }
    }
    return { artifactIds: [...artifacts.keys()], evidenceIds: [...evidence] }
  },

  taskGraphResultAccepted(node, result, controller, verifiedRefs = null) {
    const conclusion = publicCollaborationText(result?.message?.content || '')
    const refs = verifiedRefs || this.taskGraphVerifiedOutcomeRefs(node, result, controller)
    return result?.message?.trace?.status === 'completed'
      && !explicitTaskFailure(result?.message?.content)
      && (!node.acceptance.requireConclusion
        || (Boolean(conclusion) && result.message.trace.truncated !== true))
      && refs.artifactIds.length >= node.acceptance.minArtifactRefs
      && refs.evidenceIds.length >= node.acceptance.minEvidenceRefs
  },

  applyTaskGraphAgentResult(group, controller, node, result) {
    const conflicts = this.unresolvedTaskGraphConflicts(controller.orchestration.collaboration)
    const verifiedRefs = this.taskGraphVerifiedOutcomeRefs(node, result, controller)
    const verifiedResult = { ...result, outcomeRefs: verifiedRefs }
    const conclusion = publicCollaborationText(result?.message?.content || '')
    let accepted = this.taskGraphResultAccepted(node, result, controller, verifiedRefs)
    if (node.role === 'arbiter' && conflicts.length && !conclusion) accepted = false
    const acceptedDecision = node.role === 'arbiter' && accepted
    const subject = node.role === 'primary'
      ? (node.claimKey ? `task:${controller.taskId}:claim:${node.claimKey}` : `task:${controller.taskId}:conclusion`)
      : `task:${controller.taskId}:node:${node.nodeId}`
    const agentRunId = result?.message?.trace?.agentRunId
    const previous = agentRunId ? controller.orchestration.collaboration.entries.filter(entry => (
      entry.provenance.runId === controller.runId && entry.provenance.agentRunId === agentRunId
    )) : []
    if (previous.length) {
      const primary = previous.filter(entry => ['claim', 'decision'].includes(entry.entryType))
      const artifactEntries = previous.filter(entry => entry.entryType === 'artifact-ref')
      const evidenceEntries = previous.filter(entry => entry.entryType === 'evidence-ref')
      const conflictEntries = previous.filter(entry => entry.entryType === 'conflict')
      const matchesRefs = (entries, ids) => (entries.length === ids.length || (entries.length === 1 && ids.length > 1))
        && entries.every((entry, index) => entry.refs.length === 1 && entry.refs[0] === ids[index])
      const validConflicts = conflictEntries.every(entry => {
        const claim = primary[0]
        const otherId = entry.refs.find(id => id !== claim?.entryId)
        const other = controller.orchestration.collaboration.entries.find(candidate => candidate.entryId === otherId)
        return primary.length === 1 && claim.entryType === 'claim' && entry.owner.type === 'harness'
          && entry.lifecycle.state === 'active' && entry.subject === subject && entry.refs.length === 2
          && entry.refs.includes(claim.entryId) && other?.entryType === 'claim'
          && other.subject === subject && other.value !== claim.value
          && other.owner.type === 'agent' && other.owner.agentKind !== node.agentKind
          && entry.provenance.taskId === controller.taskId
          && canonicalJson(entry.provenance.artifactIds) === canonicalJson(verifiedRefs.artifactIds)
          && canonicalJson(entry.provenance.evidenceIds) === canonicalJson(verifiedRefs.evidenceIds)
      })
      const validReferences = previous.length === primary.length + artifactEntries.length + evidenceEntries.length + conflictEntries.length
        && validConflicts
        && matchesRefs(artifactEntries, verifiedRefs.artifactIds)
        && matchesRefs(evidenceEntries, verifiedRefs.evidenceIds)
        && [...artifactEntries, ...evidenceEntries].every(entry => entry.lifecycle.state === 'active'
          && entry.owner.type === 'agent' && entry.owner.agentKind === node.agentKind && entry.owner.role === node.role
          && entry.provenance.taskId === controller.taskId
          && canonicalJson(entry.provenance.artifactIds) === canonicalJson(verifiedRefs.artifactIds)
          && canonicalJson(entry.provenance.evidenceIds) === canonicalJson(verifiedRefs.evidenceIds)
          && entry.subject === `task:${controller.taskId}:${entry.entryType === 'artifact-ref' ? 'artifact' : 'evidence'}`)
      const artifactOnly = !conclusion && !node.acceptance.requireConclusion && primary.length === 0
      if (!validReferences || (!artifactOnly && (primary.length !== 1 || primary[0].entryType !== (acceptedDecision ? 'decision' : 'claim')
          || primary[0].subject !== subject || primary[0].statement !== conclusion
          || primary[0].owner.type !== 'agent' || primary[0].owner.agentKind !== node.agentKind
          || primary[0].provenance.taskId !== controller.taskId
          || canonicalJson(primary[0].provenance.artifactIds) !== canonicalJson(verifiedRefs.artifactIds)
          || canonicalJson(primary[0].provenance.evidenceIds) !== canonicalJson(verifiedRefs.evidenceIds)))) {
        throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
      }
      if (artifactEntries.length < verifiedRefs.artifactIds.length
          || evidenceEntries.length < verifiedRefs.evidenceIds.length) {
        let collaboration = controller.orchestration.collaboration
        for (const [entries, ids] of [[artifactEntries, verifiedRefs.artifactIds], [evidenceEntries, verifiedRefs.evidenceIds]]) {
          for (const id of ids.slice(entries.length)) {
            const { entryId, version, recordType, ...template } = entries[0]
            collaboration = appendBlackboardEntry(collaboration, {
              ...template,
              refs: [id],
              lifecycle: { ...template.lifecycle, sequence: (collaboration.entries.at(-1)?.lifecycle.sequence || 0) + 1,
                recordedAt: Date.now(), supersedesEntryId: null },
            })
            previous.push(collaboration.entries.at(-1))
          }
        }
        this.checkpointOrchestration(group, controller, { collaboration })
      }
    }
    const entryIds = previous.length ? previous.map(entry => entry.entryId) : this.recordCollaborationResult(
      group,
      controller,
      controller.orchestration.activeKinds,
      node.agentKind,
      verifiedResult,
      {
        role: node.role,
        audience: {
          ...this.collaborationAudience(node.role),
          agentKinds: [...new Set(controller.orchestration.taskGraph.graph.nodes
            .filter(candidate => candidate.inputNodeIds.includes(node.nodeId) && candidate.agentKind)
            .map(candidate => candidate.agentKind))],
        },
        deduplicateByAgentRun: true,
        allOutcomeRefs: true,
        entryType: acceptedDecision ? 'decision' : 'claim',
        subject,
        refs: acceptedDecision ? conflicts.map(entry => entry.entryId) : [],
      },
    )
    if (accepted && node.terminal && node.role !== 'arbiter'
        && this.unresolvedTaskGraphConflicts(controller.orchestration.collaboration).length) {
      accepted = false
    }
    const { artifactIds, evidenceIds } = verifiedRefs
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

  taskGraphHumanResolvableConflicts(controller, node) {
    const cursor = parseTaskGraphCursor(controller.orchestration.taskGraph)
    const selected = new Set(cursor.nodeStates.filter(state => node.inputNodeIds.includes(state.nodeId))
      .flatMap(state => state.entryIds))
    return (controller.orchestration.collaboration?.entries || []).filter(entry => (
      entry.entryType === 'conflict' && entry.lifecycle.state === 'active'
      && entry.refs.every(id => selected.has(id))
    ))
  },

  applyTaskGraphHumanDecision(group, controller, node, decision) {
    const option = node.decisionOptions.find(candidate => candidate.optionId === decision.optionId)
    if (!option) throw new Error('LOCAL_WORKFLOW_DECISION_INVALID')
    const accepted = decision.status === 'approved'
    if (decision.status !== (option.kind === 'allow_once' ? 'approved' : 'rejected')) {
      throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
    }
    const resolvable = this.taskGraphHumanResolvableConflicts(controller, node)
    const resolvableIds = new Set(resolvable.map(entry => entry.entryId))
    const unresolved = this.unresolvedTaskGraphConflicts(controller.orchestration.collaboration)
    const conflicts = unresolved.filter(entry => resolvableIds.has(entry.entryId))
    if (accepted && node.terminal && unresolved.some(entry => !resolvableIds.has(entry.entryId))) {
      throw new Error('LOCAL_WORKFLOW_INPUT_UNAVAILABLE')
    }
    let collaboration = controller.orchestration.collaboration
    const agentRunId = this.taskGraphDecisionAgentRunId(controller.orchestration.taskGraph.graph.graphId, node.nodeId)
    const subject = `task:${controller.taskId}:node:${node.nodeId}`
    const existing = collaboration.entries.filter(entry => entry.entryType === 'decision'
      && entry.provenance.agentRunId === agentRunId)
    const prior = existing[0]
    if (existing.length > 1 || (prior && (prior.provenance.runId !== controller.runId
        || prior.provenance.taskId !== controller.taskId || prior.subject !== subject || prior.owner.type !== 'harness'
        || prior.lifecycle.state !== 'active' || prior.statement !== `Human selected: ${option.name}`
        || (prior.value !== option.optionId && !(prior.value === ''
          && node.decisionOptions.filter(candidate => candidate.name === option.name).length === 1))
        || (!accepted && prior.refs.length)
        || prior.refs.some(id => !resolvableIds.has(id))))) throw new Error('LOCAL_RUN_CONTINUATION_INVALID')
    if (!prior) collaboration = appendBlackboardEntry(collaboration, {
      entryType: 'decision',
      subject,
      statement: `Human selected: ${option.name}`,
      value: option.optionId,
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
        agentRunId,
        artifactIds: [],
        evidenceIds: [],
      },
      refs: accepted ? conflicts.map(entry => entry.entryId) : [],
    })
    const decisionEntryId = prior?.entryId || collaboration.entries.at(-1).entryId
    if (!prior) this.checkpointOrchestration(group, controller, { collaboration })
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
    if (collaborationPackage.entries.length !== selectedEntryIds.length) {
      throw new Error('LOCAL_WORKFLOW_INPUT_UNAVAILABLE')
    }
    const isolated = ['reviewer', 'arbiter'].includes(node.role)
    if (isolated) {
      const outcomes = this.taskGraphReviewOutcomeText(collaborationPackage.entries)
      if (outcomes) collaborationPackage.text += `\n${outcomes}`
    }
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
          'Meldwork records your completed response as an Artifact and associated Evidence. Do not search for, invent, or output internal Artifact or Evidence IDs.',
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
    if (node.terminal) {
      const resolvable = new Set(this.taskGraphHumanResolvableConflicts(controller, node).map(entry => entry.entryId))
      if (this.unresolvedTaskGraphConflicts(controller.orchestration.collaboration).some(entry => !resolvable.has(entry.entryId))) {
        throw new Error('LOCAL_WORKFLOW_INPUT_UNAVAILABLE')
      }
    }
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
    // A terminal node must not finish the graph while other ready work can
    // still fail; independent nonterminal nodes may continue in parallel.
    const nonterminal = readyNodes.filter(node => !node.terminal)
    const candidates = nonterminal.length ? nonterminal : readyNodes
    const parallel = []
    const kinds = new Set()
    if (group.allowWrite !== true) {
      for (const node of candidates) {
        if (!node.parallel || node.role === 'human' || kinds.has(node.agentKind)) continue
        parallel.push(node)
        kinds.add(node.agentKind)
      }
    }
    return parallel.length > 1 ? parallel : candidates.slice(0, 1)
  },

  async runTaskGraph(group, controller, threadRootId, context) {
    while (!controller.signal.aborted) {
      this.restoreTaskGraphOutcomeReferences(group, controller)
      let cursor = assertTaskGraphDependencies(controller.orchestration.taskGraph)
      const terminalState = terminalTaskGraphState(cursor)
      if (cursor.terminalState !== terminalState) {
        cursor = this.checkpointTaskGraph(group, controller, cursor)
      }
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
      if (readyNodes.every(node => node.terminal)
          && cursor.graph.nodes.some(node => !node.terminal
            && cursor.nodeStates.find(state => state.nodeId === node.nodeId)?.status !== 'accepted')) {
        throw new Error('LOCAL_WORKFLOW_INVALID')
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
      const settled = await Promise.allSettled(batch.map(async node => {
        let outcome
        try {
          outcome = await this.executeTaskGraphAgentNode(
            group, controller, threadRootId, context, node, batch.length > 1,
          )
        } catch (error) { outcome = { error } }
        try {
          if (outcome?.result) {
            if (outcome.result.outcomeRefs?.artifactIds?.length
                && !controller.orchestration.attachmentRecipients.includes(node.agentKind)) {
              this.checkpointOrchestration(group, controller, {
                attachmentRecipients: [...controller.orchestration.attachmentRecipients, node.agentKind],
              })
            }
            this.applyTaskGraphAgentResult(group, controller, node, outcome.result)
            this.emitChanged()
          } else if (!controller.signal.aborted) {
            const error = outcome?.error || new Error('LOCAL_AGENT_UNKNOWN_FAILURE')
            this.recordAgentFailure(group.id, node.agentKind, error, threadRootId, new Set())
            const failed = updateTaskGraphCursor(controller.orchestration.taskGraph, node.nodeId, { status: 'failed' })
            this.checkpointTaskGraph(group, controller, failed)
            if (!controller.failedKinds.includes(node.agentKind)) controller.failedKinds.push(node.agentKind)
            if (circuitBreakerFailure(error)) {
              controller.stopReason = 'circuit_breaker'
              controller.abort()
            } else if (hardBudgetFailure(error)) {
              controller.stopReason = 'hard_budget'
              controller.abort()
            }
            this.emitChanged()
          }
        } catch (error) {
          return { checkpointError: error }
        }
        return outcome
      }))
      for (const outcome of settled) {
        if (outcome.status === 'fulfilled' && outcome.value?.checkpointError) throw outcome.value.checkpointError
        if (outcome.status === 'rejected') throw outcome.reason
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

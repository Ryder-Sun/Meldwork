// Collaboration records written while an automatic run progresses (roles, objectives, results).
const { createHash } = require('node:crypto')
const {
  appendBlackboardEntry,
  appendHandoff,
  collaborationPackageText,
  emptyCollaborationState,
  publicCollaborationText,
  roleForIndex,
  visibleBlackboardEntries,
} = require('../collaboration/collaboration-records.cjs')
const { createTaskGraphCursor } = require('../collaboration/task-graph-records.cjs')

const collaborationMethods = {
  orchestrationCursor(targetKinds, taskGraph = null) {
    if (taskGraph) {
      return {
        version: 3,
        workflow: 'auto',
        template: 'task-graph',
        currentKind: '',
        pendingKinds: [...targetKinds],
        activeKinds: [...targetKinds],
        successfulKinds: [],
        agreementKinds: [],
        attachmentRecipients: [],
        totalSuccesses: 0,
        terminalFailureOccurred: false,
        collaboration: emptyCollaborationState(),
        taskGraph: createTaskGraphCursor(taskGraph),
      }
    }
    return {
      version: 2,
      workflow: 'auto',
      currentKind: '',
      pendingKinds: [...targetKinds],
      activeKinds: [...targetKinds],
      successfulKinds: [],
      agreementKinds: [],
      attachmentRecipients: [],
      totalSuccesses: 0,
      terminalFailureOccurred: false,
      collaboration: emptyCollaborationState(),
    }
  },

  collaborationRole(activeKinds, kind) {
    return roleForIndex(Math.max(0, activeKinds.indexOf(kind)))
  },

  collaborationAudience(role) {
    return {
      roles: role === 'primary'
        ? ['reviewer', 'arbiter']
        : (role === 'reviewer' ? ['primary', 'arbiter'] : ['primary', 'reviewer']),
      agentKinds: [],
    }
  },

  collaborationAcceptance(role) {
    if (role === 'reviewer') {
      return [
        'Check the selected claims and outcome references.',
        'Identify unsupported assumptions, conflicts, or missing evidence.',
      ]
    }
    if (role === 'arbiter') {
      return [
        'Resolve visible conflicts using the selected evidence.',
        'Return one bounded conclusion and state whether consensus is reached.',
      ]
    }
    return [
      'Produce one concrete conclusion for the current task.',
      'Publish only claims and durable outcome references needed downstream.',
    ]
  },

  collaborationExpectedOutput(role) {
    if (role === 'reviewer') return 'A concise review with corrections or explicit acceptance.'
    if (role === 'arbiter') return 'A final adjudication of the selected claims and conflicts.'
    return 'A concise primary conclusion with any durable Artifact or Evidence references.'
  },

  collaborationObjective(group, controller, threadRootId) {
    const root = this.state().messages.find(message => (
      message.groupId === group.id && message.id === threadRootId && message.role === 'user'
    ))
    return publicCollaborationText(root?.content || 'Complete the current user task.', 3000)
      || 'Complete the current user task.'
  },

  prepareCollaborationPackage(
    group, controller, activeKinds, kind, threadRootId, options = {},
  ) {
    const collaboration = controller.orchestration?.collaboration || emptyCollaborationState()
    const destination = {
      agentKind: kind,
      role: options.role || this.collaborationRole(activeKinds, kind),
    }
    const selectedEntryIds = Array.isArray(options.selectedEntryIds)
      ? new Set(options.selectedEntryIds)
      : null
    const selectedEntries = selectedEntryIds
      ? collaboration.entries.filter(entry => selectedEntryIds.has(entry.entryId))
      : visibleBlackboardEntries(collaboration, destination)
    const objective = this.collaborationObjective(group, controller, threadRootId)
    const expectedOutput = options.expectedOutput
      || this.collaborationExpectedOutput(destination.role)
    const acceptanceCriteria = options.acceptanceCriteria
      || this.collaborationAcceptance(destination.role)
    const selectedIds = selectedEntries.map(entry => entry.entryId)
    const reusable = [...collaboration.handoffs].reverse().find(handoff => (
      handoff.destination.agentKind === destination.agentKind
      && handoff.destination.role === destination.role
      && handoff.objective === objective
      && handoff.expectedOutput === expectedOutput
      && handoff.selectedEntryIds.length === selectedIds.length
      && handoff.selectedEntryIds.every((id, index) => id === selectedIds[index])
      && handoff.acceptanceCriteria.length === acceptanceCriteria.length
      && handoff.acceptanceCriteria.every((value, index) => value === acceptanceCriteria[index])
    ))
    if (reusable) {
      return {
        handoff: reusable,
        entries: selectedEntries,
        text: collaborationPackageText(reusable, selectedEntries),
      }
    }
    const previousOwner = [...collaboration.entries].reverse().find(entry => (
      entry.owner.type === 'agent'
    ))?.owner
    const createdAt = Date.now()
    const next = appendHandoff(collaboration, {
      source: previousOwner || { type: 'harness' },
      destination,
      objective,
      selectedEntryIds: selectedIds,
      expectedOutput,
      acceptanceCriteria,
      provenance: {
        runId: controller.runId,
        taskId: controller.taskId,
        round: controller.currentRound,
        agentRunId: null,
        artifactIds: [],
        evidenceIds: [],
      },
      createdAt,
    })
    const handoff = next.handoffs.at(-1)
    this.checkpointOrchestration(group, controller, { collaboration: next })
    return {
      handoff,
      entries: selectedEntries,
      text: collaborationPackageText(handoff, selectedEntries),
    }
  },

  recordCollaborationResult(group, controller, activeKinds, kind, result, options = {}) {
    const role = options.role || this.collaborationRole(activeKinds, kind)
    const conclusion = publicCollaborationText(result?.message?.content || '')
    const trace = result?.message?.trace
    const provenance = {
      runId: controller.runId,
      taskId: controller.taskId,
      round: controller.currentRound,
      agentRunId: trace?.agentRunId || null,
      artifactIds: result?.outcomeRefs?.artifactIds || [],
      evidenceIds: result?.outcomeRefs?.evidenceIds || [],
    }
    let collaboration = controller.orchestration?.collaboration || emptyCollaborationState()
    const previousCollaboration = collaboration
    const previousEntryIds = new Set(collaboration.entries.map(entry => entry.entryId))
    let sequence = collaboration.entries.length + 1
    const recordedAt = Date.now()
    const conclusionValue = conclusion
      ? createHash('sha256').update(conclusion).digest('hex')
      : ''
    const entryType = options.entryType || 'claim'
    const subject = options.subject || `task:${controller.taskId}:conclusion`
    const entryRefs = Array.isArray(options.refs) ? options.refs : []
    const duplicateConclusion = conclusion && collaboration.entries.some(entry => (
      entry.entryType === entryType
      && entry.lifecycle.state === 'active'
      && entry.subject === subject
      && entry.value === conclusionValue
      && entry.owner.type === 'agent'
      && entry.owner.agentKind === kind
    ))
    if (conclusion && !duplicateConclusion) {
      collaboration = appendBlackboardEntry(collaboration, {
        entryType,
        subject,
        statement: conclusion,
        value: entryType === 'claim' ? conclusionValue : '',
        owner: { type: 'agent', agentKind: kind, role },
        audience: this.collaborationAudience(role),
        lifecycle: {
          state: 'active', sequence, recordedAt, supersedesEntryId: null,
        },
        provenance,
        refs: entryRefs,
      })
      sequence = collaboration.entries.length + 1
    }
    for (const artifactId of duplicateConclusion ? [] : provenance.artifactIds.slice(0, 1)) {
      collaboration = appendBlackboardEntry(collaboration, {
        entryType: 'artifact-ref',
        subject: `task:${controller.taskId}:artifact`,
        statement: 'Durable Artifact produced by the Agent.',
        value: '',
        owner: { type: 'agent', agentKind: kind, role },
        audience: this.collaborationAudience(role),
        lifecycle: {
          state: 'active', sequence, recordedAt, supersedesEntryId: null,
        },
        provenance,
        refs: [artifactId],
      })
      sequence = collaboration.entries.length + 1
    }
    for (const evidenceId of duplicateConclusion ? [] : provenance.evidenceIds.slice(0, 1)) {
      collaboration = appendBlackboardEntry(collaboration, {
        entryType: 'evidence-ref',
        subject: `task:${controller.taskId}:evidence`,
        statement: 'Durable Evidence recorded for the Agent conclusion.',
        value: '',
        owner: { type: 'agent', agentKind: kind, role },
        audience: this.collaborationAudience(role),
        lifecycle: {
          state: 'active', sequence, recordedAt, supersedesEntryId: null,
        },
        provenance,
        refs: [evidenceId],
      })
      sequence = collaboration.entries.length + 1
    }
    if (collaboration !== previousCollaboration) {
      this.checkpointOrchestration(group, controller, { collaboration })
    }
    return collaboration.entries
      .filter(entry => !previousEntryIds.has(entry.entryId))
      .map(entry => entry.entryId)
  },

  checkpointOrchestration(group, controller, updates = {}) {
    const previous = controller.orchestration
    controller.orchestration = { ...previous, ...updates }
    // A thrown callback has an unknown write outcome; only explicit failure is safe to roll back.
    const persisted = this.checkpointRun?.(group.id, controller)
    if (this.hasRunLedger() && persisted !== true) {
      controller.orchestration = previous
      if (previous?.version === 4) controller.currentRound = previous.round
      throw new Error('LOCAL_RUN_PERSIST_FAILED')
    }
  },
}

module.exports = { collaborationMethods }

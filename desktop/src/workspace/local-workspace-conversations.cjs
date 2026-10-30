const path = require('node:path')
const { normalizeTraceCapsule } = require('../runs/run-harness.cjs')
const { normalizeRoutingDecision } = require('../agents/agent-routing.cjs')
const {
  MAX_MESSAGE_ATTACHMENTS,
  cleanElapsedMs,
  cleanInline,
  cleanProgressSteps,
  cleanText,
  normalizeAttachmentMetadata,
  normalizeKnowledgeBaseHint,
  normalizeSkillHint,
  normalizeTargetKinds,
  terminalMessageContentLimit,
} = require('./local-workspace-inputs.cjs')

class LocalWorkspaceConversations {
  constructor(options) {
    this.reserveTurnSeq = typeof options.reserveTurnSeq === 'function' ? options.reserveTurnSeq : null
    this.state = options.state
    this.detectedAgents = options.detectedAgents
    this.save = options.save
    this.emitChanged = options.emitChanged
    this.isGroupBusy = options.isGroupBusy
    this.clearSessionState = options.clearSessionState
    this.runLedger = options.runLedger
    this.agentLabel = options.agentLabel
    this.createId = options.createId
    this.now = options.now
  }

  snapshotState() {
    const state = this.state()
    return {
      groups: state.groups.map(group => ({
        ...group,
        agentKinds: [...group.agentKinds],
      })),
      messages: [...state.messages],
      sessions: { ...state.sessions },
      sessionMeta: { ...state.sessionMeta },
      ...(state.deliveryTasks ? { deliveryTasks: structuredClone(state.deliveryTasks) } : {}),
    }
  }

  restoreState(snapshot) {
    Object.assign(this.state(), snapshot)
  }

  commit(mutator, afterSave = null) {
    const previous = this.snapshotState()
    let saved = false
    let result
    try {
      result = mutator(this.state())
      this.save()
      saved = true
      afterSave?.()
    } catch (error) {
      this.restoreState(previous)
      if (saved) {
        try {
          this.save()
        } catch (rollbackError) {
          if (error && typeof error === 'object') error.rollbackError = rollbackError
        }
      }
      throw error
    }
    this.emitChanged()
    return result
  }

  createGroup(input) {
    const available = new Set(this.detectedAgents()
      .filter(agent => agent.available)
      .map(agent => agent.kind))
    const conversationType = input.conversationType === 'direct' ? 'direct' : 'group'
    const directAgentKind = conversationType === 'direct'
      ? cleanInline(input.directAgentKind, 40)
      : ''
    const requestedKinds = conversationType === 'direct' ? [directAgentKind] : (input.agentKinds || [])
    const agentKinds = [...new Set(requestedKinds.filter(kind => available.has(kind)))]
    if (!agentKinds.length) throw new Error('LOCAL_GROUP_AGENT_REQUIRED')
    const name = cleanText(input.name, 60)
      || (conversationType === 'direct' ? this.agentLabel(directAgentKind) : '')
    const workdir = path.resolve(cleanText(input.workdir, 1000) || process.cwd())
    const timestamp = this.now()
    const group = {
      id: this.createId(),
      name,
      topic: cleanText(input.topic, 200),
      agentKinds,
      workdir,
      allowWrite: input.allowWrite !== false,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    if (conversationType === 'direct') {
      group.conversationType = 'direct'
      group.directAgentKind = directAgentKind
    }
    return this.commit((state) => {
      state.groups.unshift(group)
      return group
    })
  }

  updateGroup(groupId, input) {
    const group = this.getGroup(groupId)
    if (this.isGroupBusy(group.id)) {
      if (Object.keys(input).some(key => key !== 'name')) throw new Error('LOCAL_GROUP_RUNNING')
      return this.commit(() => {
        group.name = cleanText(input.name, 60) || group.name
        group.updatedAt = this.now()
        return group
      })
    }
    const nextName = input.name != null ? cleanText(input.name, 60) || group.name : group.name
    const nextTopic = input.topic != null ? cleanText(input.topic, 200) : group.topic
    const nextWorkdir = input.workdir != null
      ? path.resolve(cleanText(input.workdir, 1000))
      : group.workdir
    const workdirChanged = nextWorkdir !== group.workdir
    const nextAllowWrite = input.allowWrite != null ? input.allowWrite === true : group.allowWrite
    let nextAgentKinds = group.agentKinds
    if (input.agentKinds != null) {
      const available = new Set(this.detectedAgents()
        .filter(agent => agent.available)
        .map(agent => agent.kind))
      const kinds = [...new Set(input.agentKinds.filter(kind => available.has(kind)))]
      if (!kinds.length) throw new Error('LOCAL_GROUP_AGENT_REQUIRED')
      nextAgentKinds = kinds
    }
    if (group.conversationType === 'direct') nextAgentKinds = [group.directAgentKind]
    return this.commit(() => {
      group.name = nextName
      group.topic = nextTopic
      group.workdir = nextWorkdir
      group.allowWrite = nextAllowWrite
      group.agentKinds = nextAgentKinds
      group.updatedAt = this.now()
      if (workdirChanged) this.clearSessionState(group.id)
      return group
    })
  }

  removeAgent(groupId, kind) {
    const group = this.getGroup(groupId)
    if (group.conversationType === 'direct' || !group.agentKinds.includes(kind)) return false
    // A group without members cannot be loaded again, which would discard
    // its whole history. Membership edits must always keep one Agent.
    if (group.agentKinds.length <= 1) return false
    return this.commit(() => {
      group.agentKinds = group.agentKinds.filter(agentKind => agentKind !== kind)
      group.updatedAt = this.now()
      return true
    })
  }

  deleteGroup(groupId) {
    if (this.isGroupBusy(groupId)) throw new Error('LOCAL_GROUP_RUNNING')
    const state = this.state()
    if (!state.groups.some(group => group.id === groupId)) {
      throw new Error('LOCAL_GROUP_NOT_FOUND')
    }
    this.commit(() => {
      this.clearSessionState(groupId)
      state.groups = state.groups.filter(group => group.id !== groupId)
      state.messages = state.messages.filter(message => message.groupId !== groupId)
      if (state.deliveryTasks) state.deliveryTasks = state.deliveryTasks.filter(task => task.groupId !== groupId)
    }, () => this.runLedger?.deleteGroup?.(groupId))
  }

  deleteMessage(groupId, messageId) {
    const group = this.getGroup(groupId)
    if (this.isGroupBusy(group.id)) throw new Error('LOCAL_GROUP_RUNNING')
    const state = this.state()
    const target = state.messages.find(message => (
      message.id === messageId && message.groupId === group.id
    ))
    if (!target) throw new Error('LOCAL_MESSAGE_NOT_FOUND')

    const deletedIds = new Set([target.id])
    const deletesConversationTurn = target.role === 'user' && !target.threadRootId
    if (deletesConversationTurn) {
      for (const message of state.messages) {
        if (message.groupId === group.id && message.threadRootId === target.id) {
          deletedIds.add(message.id)
        }
      }
      if (group.conversationType === 'direct') {
        let insideTurn = false
        for (const message of state.messages) {
          if (message.groupId !== group.id) continue
          if (message.id === target.id) {
            insideTurn = true
            continue
          }
          if (!insideTurn) continue
          if (message.role === 'user' && !message.threadRootId) break
          deletedIds.add(message.id)
        }
      }
    }

    return this.commit(() => {
      state.messages = state.messages.filter(message => !deletedIds.has(message.id))
      return { deletedMessageIds: [...deletedIds] }
    })
  }

  rollbackAddedMessage(groupId, messageId, previousUpdatedAt) {
    const group = this.getGroup(groupId)
    const state = this.state()
    if (!state.messages.some(message => message.id === messageId && message.groupId === group.id)) {
      return false
    }
    return this.commit(() => {
      state.messages = state.messages.filter(message => (
        message.id !== messageId || message.groupId !== group.id
      ))
      group.updatedAt = previousUpdatedAt
      return true
    })
  }

  getGroup(groupId) {
    const group = this.state().groups.find(item => item.id === groupId)
    if (!group) throw new Error('LOCAL_GROUP_NOT_FOUND')
    return group
  }

  addMessage(
    groupId, role, content, agentKind = '', threadRootId = '', system = null, metadata = {},
  ) {
    const group = this.getGroup(groupId)
    const systemKey = role === 'system' ? cleanInline(system?.key, 100) : ''
    const message = {
      id: this.createId(),
      groupId,
      role,
      agentKind,
      senderName: role === 'user' ? 'User' : (agentKind ? this.agentLabel(agentKind) : 'System'),
      content: cleanText(
        content,
        terminalMessageContentLimit(role, agentKind, systemKey),
      ),
      createdAt: this.now(),
    }
    if (threadRootId) message.threadRootId = threadRootId
    // Group topics order by dispatch turn. Replies and failure notices carry
    // the number reserved at dispatch; any other topic message (system
    // notices, follow-up input) takes the next number when it is written.
    const requestedTurnSeq = Number(metadata.turnSeq)
    const turnSeq = Number.isSafeInteger(requestedTurnSeq) && requestedTurnSeq > 0
      ? requestedTurnSeq
      : (threadRootId && group.conversationType !== 'direct' && this.reserveTurnSeq
        ? this.reserveTurnSeq(groupId, threadRootId)
        : null)
    if (turnSeq) message.turnSeq = turnSeq
    if (systemKey) {
      message.system = {
        key: systemKey,
        params: system.params && typeof system.params === 'object' ? system.params : {},
      }
    }
    if (role === 'agent') {
      const elapsedMs = cleanElapsedMs(metadata.elapsedMs)
      const toolCalls = cleanProgressSteps(metadata.toolCalls)
      const responseVersionRootId = cleanText(metadata.responseVersionRootId, 100)
      const attachments = (Array.isArray(metadata.attachments) ? metadata.attachments : [])
        .slice(0, MAX_MESSAGE_ATTACHMENTS)
        .map(normalizeAttachmentMetadata)
        .filter(Boolean)
      if (elapsedMs != null) message.elapsedMs = elapsedMs
      if (toolCalls.length) message.toolCalls = toolCalls
      if (attachments.length) message.attachments = attachments
      if (responseVersionRootId) message.responseVersionRootId = responseVersionRootId
    }
    if (role === 'agent' || (role === 'system' && agentKind)) {
      const trace = normalizeTraceCapsule(metadata.trace)
      if (trace) message.trace = trace
    }
    if (role === 'user') {
      const attachments = (Array.isArray(metadata.attachments) ? metadata.attachments : [])
        .map(normalizeAttachmentMetadata)
        .filter(Boolean)
      const skillHints = (Array.isArray(metadata.skillHints) ? metadata.skillHints : [])
        .map(normalizeSkillHint)
        .filter(Boolean)
      const knowledgeBaseHints = (Array.isArray(metadata.knowledgeBaseHints) ? metadata.knowledgeBaseHints : [])
        .map(normalizeKnowledgeBaseHint)
        .filter(Boolean)
      const targetKinds = normalizeTargetKinds(metadata.targetKinds)
      const routingDecision = normalizeRoutingDecision(metadata.routingDecision)
      if (attachments.length) message.attachments = attachments
      if (skillHints.length) message.skillHints = skillHints
      if (knowledgeBaseHints.length) message.knowledgeBaseHints = knowledgeBaseHints
      if (targetKinds.length) message.targetKinds = targetKinds
      if (routingDecision) message.routingDecision = routingDecision
    }
    return this.commit((state) => {
      state.messages.push(message)
      group.updatedAt = message.createdAt
      return message
    })
  }
}

module.exports = { LocalWorkspaceConversations }

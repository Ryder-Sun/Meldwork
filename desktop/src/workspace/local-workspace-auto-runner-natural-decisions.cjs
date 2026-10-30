const { parseLenientTaskDecision } = require('../collaboration/task-decision.cjs')

const v4NaturalDecisionMethods = {
  v4NaturalRouteDecision(decision, activeKinds) {
    const participants = Array.isArray(activeKinds) ? activeKinds : []
    if (decision == null) return { status: 'none', kinds: [], dropped: [] }
    let parsed
    try { parsed = parseLenientTaskDecision(decision) }
    catch { return { status: 'none', kinds: [], dropped: [] } }
    const requested = parsed.nextKinds || []
    // A request for an absent or paused participant is dropped on its own;
    // it used to stop the whole discussion with a misleading message.
    const dropped = requested.filter(kind => !participants.includes(kind))
    const kinds = requested.filter(kind => participants.includes(kind))
    return { status: kinds.length ? 'valid' : 'none', kinds, dropped }
  },

  v4NaturalNotice(group, controller, threadRootId, key, text, params = {}) {
    const runParams = { ...params, runId: controller.runId }
    const duplicate = this.state().messages.some(message => (
      message.threadRootId === threadRootId
        && message.system?.key === key
        && JSON.stringify(message.system?.params || {}) === JSON.stringify(runParams)
    ))
    if (!duplicate) {
      this.addMessage(group.id, 'system', text, '', threadRootId, { key, params: runParams })
    }
  },

  async v4NaturalRoundOutcome(group, controller, threadRootId, round, activeKinds) {
    const messages = this.v4NaturalDiscussionRoundMessages(group, controller, threadRootId, round)
    if (!activeKinds.length) return { status: 'partial' }
    const nominalOwner = this.v4NaturalOwner(group, controller, threadRootId)
    const owner = this.v4NaturalOwner(group, controller, threadRootId, activeKinds)
    if (owner !== nominalOwner) {
      // The owner failed or was paused: the next selected participant takes
      // over instead of the discussion ending silently as partial.
      this.v4NaturalNotice(group, controller, threadRootId, 'system.autoOwnerChanged',
        `${this.agentLabel(owner)} took over as delivery owner because ${this.agentLabel(nominalOwner)} is no longer available.`,
        { agent: this.agentLabel(owner), previous: this.agentLabel(nominalOwner) })
    }
    const routes = messages.map(message => this.v4NaturalRouteDecision(
      message.trace?.context?.taskDecision, activeKinds,
    ))
    const dropped = [...new Set(routes.flatMap(route => route.dropped || []))]
    if (dropped.length) {
      this.v4NaturalNotice(group, controller, threadRootId, 'system.autoRouteIgnored',
        `Requests for ${dropped.map(kind => this.agentLabel(kind)).join(', ')} were skipped because they are not active in this discussion.`,
        { agents: dropped.map(kind => this.agentLabel(kind)).join(', ') })
    }
    const ownerMessage = messages.find(message => message.agentKind === owner)
    // A peer's blocker is input for the delivery owner, who judges the whole
    // task. It used to end the discussion as partial on the spot.
    const peerBlocker = messages.find(message => {
      if (message.agentKind === owner) return false
      const status = message.trace?.context?.taskDecision?.status
      return status === 'blocked' || status === 'needs-human'
    })
    const ownerSawBlocker = peerBlocker && ownerMessage
      && controller.discussionStyle === 'sequential'
      && messages.indexOf(ownerMessage) > messages.indexOf(peerBlocker)
    if (peerBlocker && !ownerSawBlocker) {
      const peerDecision = peerBlocker.trace?.context?.taskDecision
      this.v4NaturalNotice(group, controller, threadRootId, 'system.autoPeerBlockerForwarded',
        `${this.agentLabel(peerBlocker.agentKind)} reported a blocker; the delivery owner will decide how to proceed.`,
        { agent: this.agentLabel(peerBlocker.agentKind), reason: peerDecision.reason })
      return { nextKinds: [owner], ownerReview: true }
    }
    const nextKinds = this.v4NaturalNextKinds(group, controller, threadRootId, round, activeKinds)
    if (nextKinds.length) return { nextKinds, ownerReview: false }
    const decision = ownerMessage?.trace?.context?.taskDecision
    if (decision?.handoffTo && !activeKinds.includes(decision.handoffTo)) {
      this.v4NaturalNotice(group, controller, threadRootId, 'system.autoHandoffIgnored',
        `The handoff to ${this.agentLabel(decision.handoffTo)} was ignored because that Agent is not active; ${this.agentLabel(owner)} remains the delivery owner.`,
        { agent: this.agentLabel(decision.handoffTo), owner: this.agentLabel(owner) })
    }
    if (decision?.status === 'continue') return { nextKinds: [owner], ownerReview: false }
    const sawAllContributions = messages.length === 1
      || (controller.discussionStyle === 'sequential' && messages.at(-1)?.agentKind === owner)
    if (!ownerMessage || !sawAllContributions) return { nextKinds: [owner], ownerReview: true }
    if (!decision) {
      // Ask the owner once more for a judgment before giving up: a missing
      // or unreadable receipt is usually a formatting slip, not a verdict.
      if (!this.v4NaturalOwnerMissedDecisionBefore(group, controller, threadRootId, round, owner)) {
        this.v4NaturalNotice(group, controller, threadRootId, 'system.autoTaskDecisionRequested',
          `${this.agentLabel(owner)} did not include a readable task decision; asking for one before continuing.`,
          { agent: this.agentLabel(owner), round })
        return { nextKinds: [owner], ownerReview: true }
      }
      this.addMessage(group.id, 'system', 'Discussion stopped without a valid task completion decision.',
        '', threadRootId, { key: 'system.autoTaskDecisionMissing' })
      return { status: 'partial' }
    }
    if (decision.status === 'completed') {
      // The owner may not close the task before selected peers had one discussion
      // round of their own; otherwise a single full round collapses into an
      // owner-only review and peers never get to challenge the result.
      if (activeKinds.some(kind => kind !== owner)
          && !this.v4NaturalPriorPeerDiscussion(group, controller, threadRootId, round, owner)) {
        this.addMessage(
          group.id, 'system',
          'The delivery owner signaled completion before peer discussion; running one cross-review round first.',
          '', threadRootId, { key: 'system.autoCrossReview' },
        )
        return { nextKinds: [...activeKinds], ownerReview: false }
      }
      if (controller.failedKinds.length) {
        this.v4NaturalNotice(group, controller, threadRootId, 'system.autoCompletedWithout',
          `The delivery owner completed the task without ${controller.failedKinds.map(kind => this.agentLabel(kind)).join(', ')}, which stopped earlier in this discussion.`,
          { agents: controller.failedKinds.map(kind => this.agentLabel(kind)).join(', ') })
        return { status: 'partial' }
      }
      return { status: 'completed' }
    }
    if (decision.status === 'needs-human' && this.requestTaskDecision) {
      const response = await this.requestTaskDecision(group, controller, ownerMessage)
      if (response?.status === 'approved') return { nextKinds: [owner], ownerReview: true }
      if (response?.status === 'rejected') {
        controller.stopReason = 'human_gate_rejected'
        return { status: 'stopped' }
      }
    }
    this.addMessage(group.id, 'system', decision.reason, '', threadRootId, {
      key: decision.status === 'needs-human' ? 'system.autoTaskNeedsHuman' : 'system.autoTaskBlocked',
      params: { reason: decision.reason },
    })
    return { status: 'partial' }
  },

  v4NaturalNextKinds(group, controller, threadRootId, round, activeKinds) {
    const current = this.v4NaturalDiscussionRoundMessages(group, controller, threadRootId, round)
    const selected = new Set(current.flatMap(message => (
      this.v4NaturalRouteDecision(message.trace?.context?.taskDecision, activeKinds).kinds
        .filter(kind => kind !== message.agentKind)
    )))
    if (!selected.size) return []
    return [...selected]
  },

  v4NaturalPriorPeerDiscussion(group, controller, threadRootId, round, owner) {
    return this.state().messages.some(message => (
      message.groupId === group.id
      && message.threadRootId === threadRootId
      && message.role === 'agent'
      && message.agentKind !== owner
      && message.trace?.runId === controller.runId
      && message.trace?.phase === 'discussion'
      && Number(message.trace?.round) < round
      && this.v4NaturalMessageMatchesBinding(message, controller)
    ))
  },

  v4NaturalOwnerMissedDecisionBefore(group, controller, threadRootId, round, owner) {
    const earlier = this.state().messages.filter(message => (
      message.groupId === group.id
      && message.threadRootId === threadRootId
      && message.role === 'agent'
      && message.agentKind === owner
      && message.trace?.runId === controller.runId
      && message.trace?.phase === 'discussion'
      && Number(message.trace?.round) < round
      && this.v4NaturalMessageMatchesBinding(message, controller)
    ))
    const previous = earlier.at(-1)
    return Boolean(previous && !previous.trace?.context?.taskDecision)
  },

  // With activeKinds, an owner who failed or was paused hands ownership to
  // the first still-active selected participant.
  v4NaturalOwner(group, controller, threadRootId, activeKinds = null) {
    let owner = controller.targetKinds[0] || ''
    for (const message of this.state().messages) {
      if (message.groupId !== group.id || message.threadRootId !== threadRootId
          || message.role !== 'agent' || message.agentKind !== owner
          || message.trace?.phase !== 'discussion'
          || !this.v4NaturalMessageMatchesBinding(message, controller)) continue
      const decision = message.trace?.context?.taskDecision
      if (decision?.status === 'continue' && decision.handoffTo
          && controller.targetKinds.includes(decision.handoffTo)) owner = decision.handoffTo
    }
    if (Array.isArray(activeKinds) && activeKinds.length && !activeKinds.includes(owner)) {
      return controller.targetKinds.find(kind => activeKinds.includes(kind)) || owner
    }
    return owner
  },

  v4NaturalDiscussionIsRepeating(group, controller, threadRootId, round, activeKinds) {
    const window = Math.max(4, activeKinds.length * 2)
    if (round < window + 2) return false
    const firstRound = round - window + 1
    const previous = new Map()
    const observedRounds = new Set()
    const messages = this.state().messages
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      const messageRound = Number(message.trace?.round) || 0
      if (message.groupId !== group.id || message.threadRootId !== threadRootId
          || message.role !== 'agent' || message.trace?.phase !== 'discussion'
          || message.trace?.runId !== controller.runId || messageRound < 2
          || messageRound > round || !this.v4NaturalMessageMatchesBinding(message, controller)) continue
      const contribution = this.v4NaturalMessageContent(message)
      if (contribution.partial) return false
      const text = contribution.text
        .replace(/@[A-Za-z0-9][A-Za-z0-9_-]*/gu, '')
        .replace(/\s+/gu, ' ').trim()
      const files = []
      for (const artifactId of message.trace?.context?.outcomeRefs?.artifactIds || []) {
        try {
          const { artifact, contentHash } = this.v4ArtifactIdentity(artifactId)
          if (artifact.locationRef?.kind === 'workspace-relative') {
            files.push([artifact.locationRef.path, contentHash])
          }
        } catch { return false }
      }
      const content = JSON.stringify([text, message.trace?.context?.taskDecision?.reviewedVersion || '', files.sort()])
      if (previous.has(message.agentKind) && previous.get(message.agentKind) !== content) return false
      if (messageRound >= firstRound) {
        observedRounds.add(messageRound)
        previous.set(message.agentKind, content)
      } else {
        previous.delete(message.agentKind)
        if (observedRounds.size === window && previous.size === 0) return true
      }
    }
    return false
  },

  v4NaturalStopRepeatingDiscussion(group, controller, threadRootId, round, activeKinds) {
    if (!this.v4NaturalDiscussionIsRepeating(group, controller, threadRootId, round, activeKinds)) return false
    this.addMessage(
      group.id, 'system',
      'Automatic discussion stopped because repeated handoffs produced no new contribution.',
      '', threadRootId, { key: 'system.autoDiscussionStalled' },
    )
    return true
  },
}

module.exports = { v4NaturalDecisionMethods }

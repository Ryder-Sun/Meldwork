const { hashValue } = require('../collaboration/orchestration-v4-records.cjs')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

// Rebuild consensus from committed, operation-bound messages. No in-memory vote
// can survive a crash without its corresponding durable Agent response.
const naturalConsensusMethods = {
  v4NaturalConsensus(group, controller, threadRootId) {
    const messages = this.state().messages.filter(message => (
      message.groupId === group.id && message.threadRootId === threadRootId
      && message.role === 'agent'
      && this.v4NaturalMessageMatchesBinding(message, controller)
    )).sort((a, b) => (a.turnSeq || 0) - (b.turnSeq || 0))
    let candidate = null
    const files = new Map()
    for (const message of messages) {
      const artifactIds = message.trace?.context?.outcomeRefs?.artifactIds || []
      for (const artifactId of artifactIds) {
        const { artifact, contentHash } = this.v4ArtifactIdentity(artifactId)
        if (artifact.locationRef?.kind === 'workspace-relative') {
          files.set(artifact.locationRef.path, { path: artifact.locationRef.path,
            artifactId, contentHash, size: artifact.contentRef.size })
        }
      }
      if (message.trace?.phase !== 'discussion') continue
      const decision = message.trace?.context?.taskDecision
      if (!decision) continue
      if (decision.status !== 'completed') {
        candidate = null
        continue
      }
      if (decision.reviewedVersion) {
        if (candidate && decision.reviewedVersion === candidate.version) {
          candidate.approvedKinds.add(message.agentKind)
        }
        continue
      }
      // An unbound confirmation cannot replace the version being reviewed.
      // Revisions must first withdraw it with a non-completed decision.
      if (candidate) continue
      const contribution = this.v4NaturalMessageContent(message)
      if (contribution.partial || !contribution.text.trim()) {
        candidate = null
        continue
      }
      const candidateFiles = [...files.values()]
      candidate = {
        version: hashValue({ messageId: message.id, text: contribution.text, artifactIds, files: candidateFiles }),
        message,
        text: contribution.text,
        artifactIds,
        files: candidateFiles,
        approvedKinds: new Set([message.agentKind]),
      }
    }
    // Votes refer to captured bytes, not just a filename. Workspace edits made
    // outside the discussion must not inherit approval of the previous bytes.
    if (candidate?.files.length) {
      try {
        const root = fs.realpathSync(group.workdir)
        for (const file of candidate.files) {
          const filename = fs.realpathSync(path.resolve(root, file.path))
          const relative = path.relative(root, filename)
          if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
              || path.isAbsolute(relative) || fs.statSync(filename).size !== file.size
              || createHash('sha256').update(fs.readFileSync(filename)).digest('hex') !== file.contentHash) return null
        }
      } catch { return null }
    }
    return candidate
  },

  v4NaturalConsensusPrompt(group, controller, threadRootId) {
    const candidate = this.v4NaturalConsensus(group, controller, threadRootId)
    if (!candidate) return ''
    return [
      `Candidate version: ${candidate.version}`,
      `Proposed by @${candidate.message.agentKind}. Review this exact complete candidate, including its deliverable files, before accepting.`,
      `Candidate deliverables: ${JSON.stringify(candidate.message.trace.context.taskDecision.deliverables)}`,
      `Immutable artifact references: ${JSON.stringify(candidate.artifactIds)}`,
      `Deliverable file versions (read each file and verify its contents): ${JSON.stringify(candidate.files)}`,
      'Complete candidate answer (not a transcript excerpt):',
      candidate.text,
      `To accept this version, use status completed and reviewedVersion "${candidate.version}" in your receipt. Do not rewrite or replace the candidate while accepting it.`,
      'If anything needs changing, use status continue, explain the defect and request the peer who should fix it. This withdraws the candidate and all its approvals; the revised result needs fresh approval from everyone.',
      'This confirmation invocation is read-only. Missing, stale or implicit approval never counts as acceptance.',
    ].join('\n\n')
  },

  async v4NaturalAgentLedOutcome(group, controller, threadRootId, round, activeKinds) {
    const messages = this.v4NaturalDiscussionRoundMessages(group, controller, threadRootId, round)
    const candidate = this.v4NaturalConsensus(group, controller, threadRootId)
    if (candidate) {
      const missing = controller.targetKinds.filter(kind => !candidate.approvedKinds.has(kind))
      if (!missing.length) return { status: 'completed' }
      const available = missing.filter(kind => activeKinds.includes(kind))
      if (available.length) return { nextKinds: available }
      return { status: 'partial' }
    }
    const decisionMessage = messages.at(-1)
    const decision = decisionMessage?.trace?.context?.taskDecision
    const route = this.v4NaturalRouteDecision(decision, activeKinds)
    if (route.dropped.length) {
      this.v4NaturalNotice(group, controller, threadRootId, 'system.autoRouteIgnored',
        'Requests for unavailable participants were skipped.',
        { agents: route.dropped.map(kind => this.agentLabel(kind)).join(', ') })
    }
    if (decision?.status === 'needs-human' && this.requestTaskDecision) {
      const response = await this.requestTaskDecision(group, controller, decisionMessage)
      if (response?.status === 'approved') return { nextKinds: [decisionMessage.agentKind] }
      if (response?.status === 'rejected') {
        controller.stopReason = 'human_gate_rejected'
        return { status: 'stopped' }
      }
    }
    if (['blocked', 'needs-human'].includes(decision?.status)) {
      this.addMessage(group.id, 'system', decision.reason, '', threadRootId, {
        key: decision.status === 'needs-human' ? 'system.autoTaskNeedsHuman' : 'system.autoTaskBlocked',
        params: { reason: decision.reason },
      })
      return { status: 'partial' }
    }
    const nextKinds = this.v4NaturalNextKinds(group, controller, threadRootId, round, activeKinds)
    if (nextKinds.length) return { nextKinds }
    // A missing receipt is not approval. Ask the current speaker to finish
    // their handoff or propose a concrete candidate instead of inventing votes.
    return { nextKinds: [], fallbackKind: activeKinds.includes(decisionMessage?.agentKind)
      ? decisionMessage.agentKind : activeKinds[0] }
  },
}

module.exports = { naturalConsensusMethods }

// V4 synthesis recovery: choosing, replacing and cancelling the Agent that writes the final result.
const { createHash } = require('node:crypto')
const {
  coordinationRecoveryKinds,
  createSynthesisBinding,
  hashValue,
  rankedSynthesisKinds,
} = require('../collaboration/orchestration-v4-records.cjs')

const v4SynthesisMethods = {
  v4SynthesisBinding({ targetKinds, snapshotRecord, routingDecision }) {
    const selected = new Set(targetKinds)
    const candidates = (Array.isArray(routingDecision?.candidates)
      ? routingDecision.candidates : [])
      .filter(candidate => selected.has(candidate?.kind))
      .map(candidate => ({
        kind: candidate.kind,
        score: candidate.score,
        ...(candidate.evidence ? { evidence: { ...candidate.evidence } } : {}),
      }))
    return createSynthesisBinding({
      snapshotContentHash: snapshotRecord?.bodyHash,
      targetKinds,
      candidates,
    })
  },

  v4SynthesisRankedKinds(roleBinding) {
    return roleBinding?.planHash
      ? coordinationRecoveryKinds(roleBinding)
      : rankedSynthesisKinds(roleBinding)
  },

  v4SynthesisVerificationKinds(roleBinding, writerKind) {
    if (roleBinding?.planHash) {
      const rankedKinds = coordinationRecoveryKinds(roleBinding)
      const verificationKinds = roleBinding.verifierKinds.filter(kind => kind !== writerKind)
      if (!rankedKinds.includes(writerKind) || verificationKinds.length < 1) {
        throw new Error('LOCAL_RUN_V4_COORDINATION_PLAN_INVALID')
      }
      return verificationKinds
    }
    return rankedSynthesisKinds(roleBinding)
      .filter(kind => kind !== writerKind)
      .slice(0, Math.min(2, roleBinding.candidates.length - 1))
  },

  v4SynthesisAttemptOperationId(controller, kind, slotId, attempt) {
    const digest = createHash('sha256').update(JSON.stringify([
      controller.runId,
      controller.taskId,
      kind,
      slotId,
      'synthesis',
      controller.currentRound || 0,
      attempt,
    ])).digest('hex')
    return `operation-${digest}`
  },

  v4CreateSynthesisRecovery(controller, roleBinding, slots, options = {}) {
    const rankedKinds = this.v4SynthesisRankedKinds(roleBinding)
    const originalWriterKind = roleBinding?.planHash
      ? roleBinding.finalizerKind : roleBinding.writerKind
    const writerKind = String(options.writerKind || originalWriterKind)
    const writerSlot = slots.find(slot => slot.agentKind === writerKind)
    if (!writerSlot || !rankedKinds.includes(writerKind)) {
      throw new Error('LOCAL_RUN_V4_SYNTHESIS_RECOVERY_INVALID')
    }
    const attempt = Math.max(1, Number(options.attempt) || 1)
    const operationId = this.v4SynthesisAttemptOperationId(
      controller, writerKind, writerSlot.slotId, attempt,
    )
    return {
      revision: Math.max(1, Number(options.revision) || 1),
      originalWriterKind,
      activeWriterKind: writerKind,
      verificationKinds: this.v4SynthesisVerificationKinds(roleBinding, writerKind),
      rankedKinds,
      rankingFingerprint: roleBinding?.planHash
        ? hashValue({ planHash: roleBinding.planHash, rankedKinds })
        : hashValue({ selectionInputHash: roleBinding.selectionInputHash, rankedKinds }),
      stateEpoch: Math.max(0, Number(options.stateEpoch) || 0),
      triedWriters: rankedKinds.slice(0, rankedKinds.indexOf(writerKind) + 1),
      attempts: [{
        attemptId: `synthesis-attempt-${hashValue({ operationId, attempt }).slice(0, 64)}`,
        writerKind,
        slotId: writerSlot.slotId,
        operationId,
        attempt,
        status: 'intent',
        permission: 'read-only',
        leaseAcquired: false,
        sideEffectsPossible: false,
        outcomeCertainty: 'not_started',
        updatedAt: Date.now(),
      }],
    }
  },

  v4ActiveSynthesisAttempt(recovery) {
    return [...(recovery?.attempts || [])].reverse().find(attempt => (
      ['intent', 'leased', 'unknown_outcome'].includes(attempt.status)
    )) || null
  },

  v4UpdateSynthesisAttempt(recovery, operationId, updates) {
    let matched = false
    const attempts = recovery.attempts.map(attempt => {
      if (attempt.operationId !== operationId) return attempt
      matched = true
      return { ...attempt, ...updates, updatedAt: Date.now() }
    })
    if (!matched) throw new Error('LOCAL_RUN_V4_SYNTHESIS_RECOVERY_INVALID')
    return { ...recovery, attempts }
  },

  v4SynthesisRecoveryGate(controller, recovery) {
    const attempt = this.v4ActiveSynthesisAttempt(recovery)
    if (!attempt || attempt.status !== 'unknown_outcome') {
      throw new Error('LOCAL_RUN_V4_SYNTHESIS_RECOVERY_INVALID')
    }
    const currentIndex = recovery.rankedKinds.indexOf(recovery.activeWriterKind)
    const fields = {
      writerKind: attempt.writerKind,
      slotId: attempt.slotId,
      operationId: attempt.operationId,
      attempt: attempt.attempt,
      proposedReplacementKind: recovery.rankedKinds[currentIndex + 1] || '',
      round: controller.currentRound,
      stateEpoch: recovery.stateEpoch,
      rankingFingerprint: recovery.rankingFingerprint,
    }
    return { bindingHash: hashValue(fields), ...fields }
  },

  v4CancelSynthesisRecovery(recovery) {
    const binding = recovery?.pendingGate
    const boundAttempt = recovery?.attempts?.find(attempt => (
      attempt.operationId === binding?.operationId
    ))
    if (binding && boundAttempt?.status === 'cancelled'
        && boundAttempt.sideEffectsPossible === true
        && boundAttempt.outcomeCertainty === 'unknown_outcome') {
      return recovery
    }
    const attempt = this.v4ActiveSynthesisAttempt(recovery)
    if (!binding || !attempt || attempt.status !== 'unknown_outcome'
        || attempt.writerKind !== binding.writerKind
        || attempt.slotId !== binding.slotId
        || attempt.operationId !== binding.operationId
        || attempt.attempt !== binding.attempt) {
      throw new Error('LOCAL_RUN_V4_SYNTHESIS_RECOVERY_INVALID')
    }
    return this.v4UpdateSynthesisAttempt(recovery, attempt.operationId, {
      status: 'cancelled',
      sideEffectsPossible: true,
      outcomeCertainty: 'unknown_outcome',
    })
  },

  v4AppendSynthesisAttempt(controller, roleBinding, recovery, slots, writerKind) {
    let nextRecovery = recovery
    const activeAttempt = this.v4ActiveSynthesisAttempt(nextRecovery)
    if (activeAttempt?.status === 'unknown_outcome') {
      nextRecovery = this.v4UpdateSynthesisAttempt(
        nextRecovery,
        activeAttempt.operationId,
        {
          status: 'superseded',
          sideEffectsPossible: true,
          outcomeCertainty: 'unknown_outcome',
        },
      )
    } else if (activeAttempt) {
      throw new Error('LOCAL_RUN_V4_SYNTHESIS_RECOVERY_INVALID')
    }
    const { pendingGate: _pendingGate, ...withoutGate } = nextRecovery
    const writerSlot = slots.find(slot => slot.agentKind === writerKind)
    const writerIndex = withoutGate.rankedKinds.indexOf(writerKind)
    if (!writerSlot || writerIndex < 0) {
      throw new Error('LOCAL_RUN_V4_SYNTHESIS_RECOVERY_INVALID')
    }
    const attempt = withoutGate.attempts.filter(item => item.writerKind === writerKind).length + 1
    const operationId = this.v4SynthesisAttemptOperationId(
      controller, writerKind, writerSlot.slotId, attempt,
    )
    return {
      ...withoutGate,
      revision: withoutGate.revision + 1,
      activeWriterKind: writerKind,
      verificationKinds: this.v4SynthesisVerificationKinds(roleBinding, writerKind),
      triedWriters: withoutGate.rankedKinds.slice(0, writerIndex + 1),
      attempts: [...withoutGate.attempts, {
        attemptId: `synthesis-attempt-${hashValue({ operationId, attempt }).slice(0, 64)}`,
        writerKind,
        slotId: writerSlot.slotId,
        operationId,
        attempt,
        status: 'intent',
        permission: 'read-only',
        leaseAcquired: false,
        sideEffectsPossible: false,
        outcomeCertainty: 'not_started',
        updatedAt: Date.now(),
      }],
    }
  },

  v4ReplaceSynthesisWriter(controller, roleBinding, recovery, slots) {
    const currentIndex = recovery.rankedKinds.indexOf(recovery.activeWriterKind)
    const writerKind = recovery.rankedKinds[currentIndex + 1] || ''
    if (!writerKind) return null
    return this.v4AppendSynthesisAttempt(
      controller, roleBinding, recovery, slots, writerKind,
    )
  },
}

module.exports = { v4SynthesisMethods }

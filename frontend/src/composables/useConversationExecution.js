import { computed } from 'vue'
import { agentLabel } from '../catalog.js'
import { MAX_ATTACHMENTS } from './useComposerAttachments.js'

export function useConversationExecution({
  deliveryTaskId,
  activeGroup,
  activeRun,
  automaticTeamFormation,
  attachmentLimitMessage,
  composerAttachmentSupported,
  composerAttachments,
  composerContextVersion,
  composerMode,
  composerSkippedKinds,
  composerTargetKinds,
  composerTargetsReady,
  discardAttachments,
  draft,
  importingAttachment,
  maxRounds,
  normalizeSnapshot,
  notify,
  readyAgentKinds,
  restoreComposerContext,
  roundSettingsOpen,
  safeAttachmentPayload,
  sendingGroupIds,
  serializeComposerContext,
  showError,
  snapshot,
  t,
  unlimitedRounds,
  workspace,
  captureComposerContext,
  clearComposerContext,
}) {
  const canSendMessage = computed(() => (
    composerTargetsReady.value
    && composerTargetKinds.value.length > 0
    && !importingAttachment.value
    && composerAttachmentSupported.value
    && Boolean(draft.value.trim() || composerAttachments.value.length || deliveryTaskId?.value)
  ))

  function isGroupSending(groupId) {
    const current = sendingGroupIds.value
    if (current instanceof Set) return current.has(groupId)
    return Array.isArray(current) && current.includes(groupId)
  }

  function setGroupSending(groupId, value) {
    const next = new Set(sendingGroupIds.value instanceof Set ? sendingGroupIds.value : [])
    if (value) next.add(groupId)
    else next.delete(groupId)
    sendingGroupIds.value = next
  }

  async function sendMessage() {
    const group = activeGroup.value
    if (!group) return
    const groupId = group.id
    if (isGroupSending(groupId) || activeRun.value || importingAttachment.value) return
    const contextVersion = composerContextVersion.value
    const text = draft.value.trim()
    const attachments = composerAttachments.value.map(safeAttachmentPayload)
    const mode = composerMode.value
    const backendMode = mode === 'auto-beta' ? 'auto' : mode
    if (!text && !attachments.length && !deliveryTaskId?.value) {
      notify(t('composer.messageRequired'))
      return
    }
    const targets = [...composerTargetKinds.value]
    const skipped = [...composerSkippedKinds.value]
    if (!targets.length) {
      notify(t('composer.selectTarget'))
      return
    }
    if (targets.some(kind => !readyAgentKinds.value.has(kind))) {
      notify(t('error.agentUnavailable'))
      return
    }
    if (!composerAttachmentSupported.value || attachments.length > MAX_ATTACHMENTS) {
      notify(attachmentLimitMessage())
      return
    }
    const { mentionedAgentKinds, skillHints, knowledgeBaseHints } = serializeComposerContext(targets)
    const previousComposerContext = captureComposerContext()
    const previousAttachments = composerAttachments.value.map(attachment => ({ ...attachment }))
    const v4GroupRun = group.conversationType !== 'direct'
      && (backendMode === 'manual' || backendMode === 'auto')
      && (targets.length > 1 || backendMode === 'auto' || automaticTeamFormation.value)
    clearComposerContext()
    composerAttachments.value = []
    roundSettingsOpen.value = false
    setGroupSending(groupId, true)
    try {
      await workspace.value.send({
        groupId,
        ...(deliveryTaskId?.value ? { deliveryTaskId: deliveryTaskId.value } : {}),
        text,
        targetKinds: automaticTeamFormation.value ? [] : targets,
        ...(automaticTeamFormation.value ? { routingMode: 'automatic' } : {}),
        ...(mentionedAgentKinds.length ? { mentionedAgentKinds } : {}),
        skillHints,
        knowledgeBaseHints,
        attachments,
        mode: backendMode,
        ...(mode === 'auto-beta' ? { discussionStyle: 'agent-led' } : {}),
        ...(v4GroupRun ? { protocol: 'v4' } : {}),
        maxRounds: maxRounds.value,
        ...(backendMode === 'auto' && unlimitedRounds.value ? { unlimitedRounds: true } : {}),
      })
      snapshot.value = normalizeSnapshot(await workspace.value.get())
      if (skipped.length) {
        notify(t('composer.skippedUnavailable', { agents: skipped.map(agentLabel).join(', ') }))
      }
    } catch (error) {
      if (contextVersion === composerContextVersion.value && groupId === activeGroup.value?.id) {
        restoreComposerContext(previousComposerContext)
        composerAttachments.value = previousAttachments
      } else {
        void discardAttachments(previousAttachments)
      }
      showError(error)
    } finally {
      setGroupSending(groupId, false)
    }
  }

  async function stopRun() {
    const groupId = activeGroup.value?.id
    const runId = activeRun.value?.runId
    if (!groupId || !runId) return
    try { await workspace.value.stop(groupId, runId) } catch (error) { showError(error) }
  }

  return { canSendMessage, sendMessage, stopRun }
}

import { computed, nextTick, ref, watch } from 'vue'
import { parseAgentRoutingPrefix } from '../agent-routing.js'
import {
  MAX_KNOWLEDGE_BASES,
  MAX_SKILLS,
  parseSkillTrigger,
  skillKey,
  useComposerMentionMenu,
} from './useComposerMentionMenu.js'

export { MAX_KNOWLEDGE_BASES, MAX_SKILLS, parseSkillTrigger, skillKey }

const COMPOSER_INPUT_MIN_HEIGHT = 58
const COMPOSER_INPUT_MAX_HEIGHT = 180

export function normalizeSkill(skill, requestedTarget) {
  const targetKind = String(skill?.targetKind || requestedTarget || '')
  const namespace = String(skill?.namespace || '')
  const slug = String(skill?.slug || '')
  const name = String(skill?.name || slug)
  if (!targetKind || targetKind !== requestedTarget || !slug) return null
  return { targetKind, namespace, slug, name }
}

export function useComposerContext({
  activeGroup,
  activeRun,
  agentDescription,
  agentSkillsSnapshot,
  knowledgeBaseName,
  knowledgeBaseReady,
  loadAgentSkills,
  localKnowledgeBaseEntries,
  mergedCatalog,
  notify,
  onSubmit = () => {},
  preloadAgentSkills,
  sending,
  t,
  theme,
}) {
  const composerInput = ref(null)
  const draft = ref('')
  const targetKinds = ref([])
  const selectedAgentKinds = ref([])
  const activeMentionAgentKind = ref('')
  const selectedSkills = ref([])
  const selectedKnowledgeBases = ref([])
  const discussionMode = ref('auto')
  const automaticTeamFormation = ref(false)

  const addressedAgentKinds = computed(() => {
    const group = activeGroup.value
    if (!group || group.conversationType === 'direct') return []
    const natural = parseAgentRoutingPrefix(draft.value, mergedCatalog.value, group.agentKinds).targetKinds
    const addressed = new Set([...selectedAgentKinds.value, ...natural])
    return group.agentKinds.filter(kind => addressed.has(kind))
  })
  // Everyone in the group is a recipient unless the user addressed or picked
  // specific Agents.
  const implicitTargetKinds = computed(() => {
    const group = activeGroup.value
    if (!group || group.conversationType === 'direct') return []
    if (automaticTeamFormation.value || addressedAgentKinds.value.length) return []
    if (discussionMode.value !== 'auto' && targetKinds.value.length) return []
    return [...group.agentKinds]
  })
  // A member that is not ready is left out of an implicit send, so one broken
  // CLI does not stop the whole group from being used. When nobody is ready
  // the full list is kept and the send reports the Agent as unavailable.
  const composerSkippedKinds = computed(() => {
    const ready = new Set(mergedCatalog.value.filter(agent => agent.ready).map(agent => agent.kind))
    const implicit = implicitTargetKinds.value
    return implicit.some(kind => ready.has(kind))
      ? implicit.filter(kind => !ready.has(kind))
      : []
  })
  const composerTargetKinds = computed(() => {
    const group = activeGroup.value
    if (!group) return []
    if (automaticTeamFormation.value && group.conversationType !== 'direct') {
      const ready = new Set(mergedCatalog.value.filter(agent => agent.available).map(agent => agent.kind))
      return group.agentKinds.filter(kind => ready.has(kind))
    }
    if (group.conversationType !== 'direct' && addressedAgentKinds.value.length) {
      return [...addressedAgentKinds.value]
    }
    if (group.conversationType === 'direct') return [...group.agentKinds]
    if (implicitTargetKinds.value.length) {
      return implicitTargetKinds.value.filter(kind => !composerSkippedKinds.value.includes(kind))
    }
    return [...targetKinds.value]
  })
  const composerMode = computed(() => {
    if (activeGroup.value?.conversationType === 'direct') return 'manual'
    if (discussionMode.value === 'auto-beta') return 'auto-beta'
    return addressedAgentKinds.value.length === 1 ? 'manual' : discussionMode.value
  })
  const manualModeLabel = computed(() => (
    activeGroup.value?.conversationType !== 'direct' && composerTargetKinds.value.length > 1
      ? t('composer.concurrentResponses')
      : t('composer.manual')
  ))
  const sendButtonLabel = computed(() => t(composerMode.value === 'auto' ? 'composer.startAuto' : 'composer.send'))
  const skillTargetSignature = computed(() => composerTargetKinds.value.join('\u0000'))
  watch([
    () => addressedAgentKinds.value.length,
    () => selectedSkills.value.length,
    () => selectedKnowledgeBases.value.length,
  ], values => {
    if (values.some(Boolean)) automaticTeamFormation.value = false
  })
  const mentionMenu = useComposerMentionMenu({
    activeGroup,
    activeMentionAgentKind,
    addressedAgentKinds,
    agentDescription,
    agentSkillsSnapshot,
    composerInput,
    composerTargetKinds,
    draft,
    knowledgeBaseName,
    knowledgeBaseReady,
    loadAgentSkills,
    localKnowledgeBaseEntries,
    notify,
    preloadAgentSkills,
    selectedAgentKinds,
    selectedKnowledgeBases,
    selectedSkills,
    skillTargetSignature,
    t,
    theme,
  })
  const {
    activeSkillOptionId,
    addAgentMention,
    composerMenuGroups,
    composerMenuOptionDescription,
    composerMenuOptionDisabled,
    composerMenuOptionIndex,
    composerMenuOptionKey,
    composerMenuOptionKindLabel,
    composerMenuOptionLogo,
    composerMenuOptions,
    composerMenuOptionTitle,
    disposeMentionMenu,
    handleMentionInput,
    handleMentionKeydown,
    openSkillMenu,
    removeAgentMention,
    removeKnowledgeBase,
    removeSkill,
    resetMentionMenu,
    selectComposerMenuOption,
    skillActiveIndex,
    skillMenuOpen,
    skillsLoading,
  } = mentionMenu

  function resizeComposerInput() {
    const input = composerInput.value
    if (!input) return
    input.style.height = 'auto'
    const scrollHeight = Math.max(Number(input.scrollHeight) || 0, COMPOSER_INPUT_MIN_HEIGHT)
    input.style.height = `${Math.min(scrollHeight, COMPOSER_INPUT_MAX_HEIGHT)}px`
    input.style.overflowY = scrollHeight > COMPOSER_INPUT_MAX_HEIGHT ? 'auto' : 'hidden'
  }

  function scheduleComposerResize() {
    void nextTick(resizeComposerInput)
  }

  function handleComposerInput() {
    resizeComposerInput()
    handleMentionInput()
  }

  function toggleTarget(kind) {
    if (sending.value || activeRun.value || composerMode.value === 'auto') return
    if (selectedAgentKinds.value.length) {
      if (selectedAgentKinds.value.includes(kind)) removeAgentMention(kind)
      else void addAgentMention(kind)
      return
    }
    if (!targetKinds.value.length) {
      targetKinds.value = activeGroup.value.agentKinds.filter(item => item !== kind)
      return
    }
    if (targetKinds.value.includes(kind)) targetKinds.value = targetKinds.value.filter(item => item !== kind)
    else targetKinds.value = [...targetKinds.value, kind]
  }

  function isComposerTargetSelected(kind) {
    return !automaticTeamFormation.value && composerTargetKinds.value.includes(kind)
  }

  function toggleAutomaticTeamFormation() {
    if (sending.value || activeRun.value || activeGroup.value?.conversationType === 'direct') return
    if (
      addressedAgentKinds.value.length
      || selectedSkills.value.length
      || selectedKnowledgeBases.value.length
    ) return
    automaticTeamFormation.value = !automaticTeamFormation.value
  }

  function handleComposerKeydown(event) {
    if (handleMentionKeydown(event)) return
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      void onSubmit()
    }
  }

  function captureComposerContext() {
    return {
      draft: draft.value,
      selectedAgentKinds: [...selectedAgentKinds.value],
      activeMentionAgentKind: activeMentionAgentKind.value,
      selectedSkills: selectedSkills.value.map(skill => ({ ...skill })),
      selectedKnowledgeBases: selectedKnowledgeBases.value.map(source => ({
        ...source,
        targetKinds: [...source.targetKinds],
      })),
      automaticTeamFormation: automaticTeamFormation.value,
    }
  }

  function clearComposerContext() {
    draft.value = ''
    selectedAgentKinds.value = []
    activeMentionAgentKind.value = ''
    selectedSkills.value = []
    selectedKnowledgeBases.value = []
    resetMentionMenu()
  }

  function restoreComposerContext(context) {
    draft.value = String(context?.draft || '')
    selectedAgentKinds.value = [...(context?.selectedAgentKinds || [])]
    activeMentionAgentKind.value = String(context?.activeMentionAgentKind || '')
    selectedSkills.value = (context?.selectedSkills || []).map(skill => ({ ...skill }))
    selectedKnowledgeBases.value = (context?.selectedKnowledgeBases || []).map(source => ({
      ...source,
      targetKinds: [...(source.targetKinds || [])],
    }))
    automaticTeamFormation.value = context?.automaticTeamFormation === true
  }

  // Unsent text is kept per conversation while the app is open, so a quick look
  // at another conversation (or saving this one's settings) does not cost what
  // was typed. Attachments and mentions are still reset: they are tied to the
  // conversation's members and to files staged for it.
  const draftsByGroupId = new Map()

  function stashComposerDraft(groupId) {
    const id = String(groupId || '')
    if (!id) return
    if (draft.value.trim()) draftsByGroupId.set(id, draft.value)
    else draftsByGroupId.delete(id)
  }

  function restoreComposerDraft(groupId) {
    const text = draftsByGroupId.get(String(groupId || ''))
    if (text) draft.value = text
  }

  function pruneComposerDrafts(groupIds) {
    const live = new Set((Array.isArray(groupIds) ? groupIds : []).map(String))
    for (const id of draftsByGroupId.keys()) if (!live.has(id)) draftsByGroupId.delete(id)
  }

  function resetComposerContext(group) {
    discussionMode.value = group?.conversationType === 'direct' ? 'manual' : 'auto'
    automaticTeamFormation.value = false
    targetKinds.value = group?.conversationType === 'direct' ? [...group.agentKinds] : []
    clearComposerContext()
  }

  function serializeComposerContext(targets) {
    const allowedTargets = new Set(Array.isArray(targets) ? targets : [])
    return {
      mentionedAgentKinds: [...addressedAgentKinds.value],
      skillHints: selectedSkills.value
        .filter(skill => allowedTargets.has(skill.targetKind))
        .map(skill => ({
          targetKind: String(skill.targetKind),
          namespace: String(skill.namespace),
          slug: String(skill.slug),
          name: String(skill.name),
        })),
      knowledgeBaseHints: selectedKnowledgeBases.value
        .map(source => ({
          kind: String(source.kind),
          targetKinds: source.targetKinds.filter(kind => allowedTargets.has(kind)),
        }))
        .filter(source => source.kind && source.targetKinds.length),
    }
  }

  function disposeComposerContext() {
    disposeMentionMenu()
  }

  return {
    activeMentionAgentKind,
    automaticTeamFormation,
    activeSkillOptionId,
    addressedAgentKinds,
    captureComposerContext,
    clearComposerContext,
    composerInput,
    composerMenuGroups,
    composerMenuOptionDescription,
    composerMenuOptionDisabled,
    composerMenuOptionIndex,
    composerMenuOptionKey,
    composerMenuOptionKindLabel,
    composerMenuOptionLogo,
    composerMenuOptions,
    composerMenuOptionTitle,
    composerMode,
    composerSkippedKinds,
    composerTargetKinds,
    discussionMode,
    disposeComposerContext,
    draft,
    handleComposerInput,
    handleComposerKeydown,
    isComposerTargetSelected,
    manualModeLabel,
    openSkillMenu,
    pruneComposerDrafts,
    removeAgentMention,
    removeKnowledgeBase,
    removeSkill,
    resetComposerContext,
    restoreComposerContext,
    restoreComposerDraft,
    scheduleComposerResize,
    selectComposerMenuOption,
    selectedAgentKinds,
    selectedKnowledgeBases,
    selectedSkills,
    sendButtonLabel,
    serializeComposerContext,
    skillActiveIndex,
    skillMenuOpen,
    skillsLoading,
    stashComposerDraft,
    targetKinds,
    toggleTarget,
    toggleAutomaticTeamFormation,
  }
}

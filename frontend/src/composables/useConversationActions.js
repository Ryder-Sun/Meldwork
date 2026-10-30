import { computed, nextTick, reactive, ref } from 'vue'
import { normalizeSnapshot } from '../desktop.js'

function plainGroupPayload(form) {
  return {
    name: String(form?.name || ''),
    topic: String(form?.topic || ''),
    agentKinds: Array.isArray(form?.agentKinds) ? form.agentKinds.map(kind => String(kind)) : [],
    workdir: String(form?.workdir || ''),
    allowWrite: form?.allowWrite === true,
  }
}

export function useConversationActions({
  activeGroup,
  activeView,
  closeModal,
  conversationHeader,
  directGroupsFor,
  formError,
  groupName,
  isDirectCreationPending,
  isGroupRunning,
  modal,
  openAgentManager,
  preloadAgentSkills,
  readyAgents,
  saving,
  selectedGroupId,
  selectGroup,
  setDirectCreationPending,
  setSidebarAgentExpanded,
  showError,
  snapshot,
  t,
  translateError,
  workspace,
  workspaceModalContent,
}) {
  const defaultDirectory = ref('')
  const deleteArmed = ref(false)
  const sidebarDeleteGroupId = ref('')
  const sidebarDeletePopoverPoint = ref({ left: 0, top: 0 })
  const settingsIntent = ref('settings')
  const settingsReadOnly = computed(() => Boolean(activeGroup.value && isGroupRunning(activeGroup.value.id)))
  const inlineTitleEditing = ref(false)
  const inlineTitleDraft = ref('')
  const groupForm = reactive({ name: '', topic: '', agentKinds: [], workdir: '', allowWrite: true })
  const settingsForm = reactive({ name: '', topic: '', agentKinds: [], workdir: '', allowWrite: false })

  async function ensureDefaultDirectory() {
    if (defaultDirectory.value) return defaultDirectory.value
    defaultDirectory.value = await workspace.value?.defaultDirectory?.() || ''
    return defaultDirectory.value
  }

  async function openDirect(agent) {
    if (saving.value || isDirectCreationPending(agent?.kind)) return
    closeModal()
    if (agent?.kind) setSidebarAgentExpanded(agent.kind, true)
    const existing = directGroupsFor(agent.kind)[0]
    if (existing) {
      selectGroup(existing.id)
      return
    }
    if (!agent.ready) {
      openAgentManager(agent.kind)
      return
    }
    const group = await createDirectSession(agent, false)
    if (!group) return
    selectGroup(group.id)
  }

  async function createDirectSession(agent, select = true) {
    const kind = String(agent?.kind || '')
    if (saving.value || !kind || isDirectCreationPending(kind)) return null
    setDirectCreationPending(kind, true)
    closeModal()
    setSidebarAgentExpanded(kind, true)
    if (!agent?.ready) {
      openAgentManager(kind)
      setDirectCreationPending(kind, false)
      return null
    }
    try {
      const sessionCount = directGroupsFor(kind).length + 1
      const group = await workspace.value.createGroup({
        conversationType: 'direct',
        directAgentKind: kind,
        name: sessionCount === 1
          ? agent.label
          : t('conversation.directDefaultName', { agent: agent.label, count: sessionCount }),
        agentKinds: [kind],
        workdir: await ensureDefaultDirectory(),
        allowWrite: agent.cloud !== true,
      })
      snapshot.value = normalizeSnapshot(await workspace.value.get())
      void preloadAgentSkills(group.agentKinds)
      if (select) selectGroup(group.id)
      return group
    } catch (error) {
      showError(error)
      return null
    } finally {
      setDirectCreationPending(kind, false)
    }
  }

  function openNewGroup() {
    if (saving.value) return
    formError.value = ''
    groupForm.name = ''
    groupForm.topic = ''
    groupForm.agentKinds = readyAgents.value.slice(0, 2).map(agent => agent.kind)
    groupForm.workdir = defaultDirectory.value
    groupForm.allowWrite = true
    modal.value = 'new-group'
    void ensureDefaultDirectory().then(path => { if (!groupForm.workdir) groupForm.workdir = path })
  }

  async function pickGroupDirectory(target) {
    if (target === 'settings' && settingsReadOnly.value) return
    try {
      const path = await workspace.value.pickDirectory()
      if (!path) return
      if (target === 'settings') settingsForm.workdir = path
      else groupForm.workdir = path
    } catch (error) {
      showError(error)
    }
  }

  async function createGroup() {
    formError.value = ''
    if (!groupForm.agentKinds.length) {
      formError.value = t('group.createErrorAgents')
      return
    }
    if (!groupForm.workdir) {
      formError.value = t('group.createErrorWorkspace')
      return
    }
    saving.value = true
    try {
      const group = await workspace.value.createGroup(plainGroupPayload(groupForm))
      snapshot.value = normalizeSnapshot(await workspace.value.get())
      void preloadAgentSkills(group.agentKinds)
      closeModal({ force: true })
      selectGroup(group.id)
    } catch (error) {
      formError.value = translateError(error)
    } finally {
      saving.value = false
    }
  }

  function beginInlineTitleEdit() {
    if (!activeGroup.value || saving.value) return
    inlineTitleDraft.value = String(activeGroup.value.name || '')
    inlineTitleEditing.value = true
    void nextTick(() => conversationHeader.value?.focusTitleInput())
  }

  function restoreInlineTitleFocus() {
    void nextTick(() => conversationHeader.value?.focusTitleButton())
  }

  function cancelInlineTitleEdit(options = {}) {
    inlineTitleEditing.value = false
    inlineTitleDraft.value = ''
    if (options?.restoreFocus !== false) restoreInlineTitleFocus()
  }

  async function saveInlineTitle() {
    const group = activeGroup.value
    const name = inlineTitleDraft.value.trim()
    if (!group || !name || saving.value) {
      if (!name) cancelInlineTitleEdit()
      return
    }
    saving.value = true
    let saved = false
    try {
      await workspace.value.updateGroup(group.id, { name })
      snapshot.value = normalizeSnapshot(await workspace.value.get())
      inlineTitleEditing.value = false
      inlineTitleDraft.value = ''
      saved = true
    } catch (error) {
      showError(error)
    } finally {
      saving.value = false
    }
    if (saved) restoreInlineTitleFocus()
  }

  function openGroupSettings(intent = 'settings') {
    if (!activeGroup.value || saving.value) return
    settingsIntent.value = typeof intent === 'string' ? intent : 'settings'
    settingsForm.name = groupName(activeGroup.value)
    settingsForm.topic = activeGroup.value.topic || ''
    settingsForm.agentKinds = [...activeGroup.value.agentKinds]
    settingsForm.workdir = activeGroup.value.workdir || ''
    settingsForm.allowWrite = activeGroup.value.allowWrite === true
    formError.value = ''
    deleteArmed.value = false
    modal.value = 'settings'
  }

  function openConversationRename(group) {
    if (!group) return
    selectGroup(group.id)
    openGroupSettings('rename')
    void nextTick(() => workspaceModalContent.value?.focusSettingsName())
  }

  function positionSidebarDeletePopover(target) {
    const rect = target?.getBoundingClientRect?.()
    if (!rect) return
    const tooltipWidth = 278
    const gutter = 12
    sidebarDeletePopoverPoint.value = {
      left: Math.max(gutter, Math.min(rect.right + 10, window.innerWidth - tooltipWidth - gutter)),
      top: Math.max(86, rect.top + 12),
    }
  }

  function openSidebarConversationDelete(group, event) {
    if (!group || isGroupRunning(group.id) || saving.value) return
    if (sidebarDeleteGroupId.value === group.id) {
      sidebarDeleteGroupId.value = ''
      return
    }
    positionSidebarDeletePopover(event?.currentTarget)
    sidebarDeleteGroupId.value = group.id
  }

  function dismissSidebarDeleteConfirmation() {
    if (saving.value) return
    sidebarDeleteGroupId.value = ''
  }

  function requestDeleteConfirmation() {
    if (saving.value) return
    deleteArmed.value = true
  }

  function dismissDeleteConfirmation() {
    if (saving.value) return
    deleteArmed.value = false
  }

  async function saveGroupSettings() {
    if (!activeGroup.value) return
    if (settingsReadOnly.value && settingsIntent.value !== 'rename') return
    formError.value = ''
    if (!settingsForm.workdir) {
      formError.value = t('group.createErrorWorkspace')
      return
    }
    if (activeGroup.value.conversationType !== 'direct' && !settingsForm.agentKinds.length) {
      formError.value = t('group.createErrorAgents')
      return
    }
    saving.value = true
    try {
      await workspace.value.updateGroup(activeGroup.value.id, settingsIntent.value === 'rename'
        ? { name: settingsForm.name } : plainGroupPayload(settingsForm))
      snapshot.value = normalizeSnapshot(await workspace.value.get())
      closeModal({ force: true })
    } catch (error) {
      formError.value = translateError(error)
    } finally {
      saving.value = false
    }
  }

  async function deleteConversation() {
    if (saving.value) return
    if (!deleteArmed.value) {
      deleteArmed.value = true
      return
    }
    saving.value = true
    try {
      snapshot.value = normalizeSnapshot(await workspace.value.deleteGroup(activeGroup.value.id))
      selectedGroupId.value = ''
      activeView.value = 'home'
      closeModal({ force: true })
    } catch (error) {
      formError.value = translateError(error)
    } finally {
      saving.value = false
    }
  }

  async function deleteSidebarConversation(group) {
    if (!group || saving.value || sidebarDeleteGroupId.value !== group.id) return
    saving.value = true
    try {
      snapshot.value = normalizeSnapshot(await workspace.value.deleteGroup(group.id))
      if (selectedGroupId.value === group.id) {
        selectedGroupId.value = ''
        if (activeView.value === 'conversation') activeView.value = 'home'
      }
      sidebarDeleteGroupId.value = ''
    } catch (error) {
      showError(error)
    } finally {
      saving.value = false
    }
  }

  return {
    beginInlineTitleEdit,
    cancelInlineTitleEdit,
    createDirectSession,
    createGroup,
    defaultDirectory,
    deleteArmed,
    deleteConversation,
    deleteSidebarConversation,
    dismissDeleteConfirmation,
    dismissSidebarDeleteConfirmation,
    groupForm,
    inlineTitleDraft,
    inlineTitleEditing,
    openConversationRename,
    openDirect,
    openGroupSettings,
    openNewGroup,
    openSidebarConversationDelete,
    pickGroupDirectory,
    requestDeleteConfirmation,
    saveGroupSettings,
    saveInlineTitle,
    settingsForm,
    settingsIntent,
    settingsReadOnly,
    sidebarDeleteGroupId,
    sidebarDeletePopoverPoint,
  }
}

import { computed, reactive } from 'vue'

export function useAgentManagement({
  activeView,
  closeModal,
  customAgent,
  customAgentDeleteArmed,
  focusedAgentKind,
  formError,
  installConfirmKind,
  installer,
  installerState,
  modal,
  normalizeSnapshot,
  refreshAgents,
  saving,
  selectAgentDetail,
  selectedAgentDetail,
  showError,
  snapshot,
  systemSettingsSection,
  t,
  translateError,
}) {
  const customAgentForm = reactive({
    label: '',
    description: '',
    argumentsText: '',
    promptMode: 'stdin',
  })
  const installerBusy = computed(() => (
    !['', 'idle', 'completed', 'cancelled', 'failed'].includes(installerState.value.phase)
  ))
  const installerPhaseLabel = computed(() => t(`installer.phase.${installerState.value.phase}`))

  function openCustomAgentModal() {
    if (saving.value) return
    formError.value = ''
    customAgentForm.label = ''
    customAgentForm.description = ''
    customAgentForm.argumentsText = ''
    customAgentForm.promptMode = 'stdin'
    customAgentDeleteArmed.value = false
    modal.value = 'custom-agent'
  }

  async function createCustomAgent() {
    formError.value = ''
    if (!customAgentForm.label) {
      formError.value = t('customAgent.nameRequired')
      return
    }
    if (typeof customAgent.value?.create !== 'function') {
      formError.value = t('error.bridge')
      return
    }
    const args = customAgentForm.argumentsText
      .split(/\r?\n/)
      .map(argument => argument.trim())
      .filter(Boolean)
    saving.value = true
    try {
      const result = await customAgent.value.create({
        label: customAgentForm.label,
        description: customAgentForm.description,
        args,
        promptMode: customAgentForm.promptMode,
      })
      if (result?.canceled) return
      await refreshAgents()
      focusedAgentKind.value = String(result?.agent?.kind || '')
      closeModal({ force: true })
    } catch (error) {
      formError.value = translateError(error)
    } finally {
      saving.value = false
    }
  }

  function openAgentDetail(agent) {
    if (!agent || saving.value) return
    activeView.value = 'settings'
    systemSettingsSection.value = 'agents'
    focusedAgentKind.value = agent.kind
    installConfirmKind.value = ''
    formError.value = ''
    customAgentDeleteArmed.value = false
    modal.value = 'agent-detail'
    void selectAgentDetail(agent.kind)
  }

  async function setAgentSidebarVisibility(agent, visible) {
    if (!agent?.kind || typeof installer.value?.setSidebarVisibility !== 'function' || saving.value) return
    saving.value = true
    formError.value = ''
    try {
      snapshot.value = normalizeSnapshot(await installer.value.setSidebarVisibility(agent.kind, visible === true))
      void refreshAgents().catch(showError)
    } catch (error) {
      formError.value = translateError(error)
    } finally {
      saving.value = false
    }
  }

  async function deleteCustomAgent() {
    const agent = selectedAgentDetail.value
    if (!agent?.custom || typeof customAgent.value?.delete !== 'function' || saving.value) return
    if (!customAgentDeleteArmed.value) {
      customAgentDeleteArmed.value = true
      return
    }
    saving.value = true
    formError.value = ''
    try {
      await customAgent.value.delete(agent.kind)
      closeModal({ force: true })
      focusedAgentKind.value = ''
      await refreshAgents()
    } catch (error) {
      formError.value = translateError(error)
      customAgentDeleteArmed.value = false
    } finally {
      saving.value = false
    }
  }

  async function requestInstall(agent) {
    if (installConfirmKind.value !== agent.kind) {
      installConfirmKind.value = agent.kind
      return
    }
    installConfirmKind.value = ''
    try {
      installerState.value = await installer.value.start(agent.kind)
    } catch (error) {
      showError(error)
    }
  }

  async function cancelInstall() {
    try {
      await installer.value.cancel(installerState.value.taskId)
    } catch (error) {
      showError(error)
    }
  }

  return {
    cancelInstall,
    createCustomAgent,
    customAgentForm,
    deleteCustomAgent,
    installerBusy,
    installerPhaseLabel,
    openAgentDetail,
    openCustomAgentModal,
    requestInstall,
    setAgentSidebarVisibility,
  }
}

function normalizedSection(section) {
  if (section === 'cloud-agents') return 'cloud-agents'
  if (section === 'knowledge-bases') return 'knowledge-bases'
  if (section === 'general') return 'general'
  return 'agents'
}

export function useSystemSettingsNavigation({
  activeView,
  closeModal,
  focusedAgentKind,
  formError,
  installConfirmKind,
  loadKnowledgeBaseStatuses,
  modal,
  saving,
  systemSettingsSection,
}) {
  function openAgentManager(kind = '') {
    openSystemSettings('agents', kind)
  }

  function openSystemSettings(section = 'agents', kind = '') {
    if (saving.value) return
    if (modal.value) closeModal()
    activeView.value = 'settings'
    systemSettingsSection.value = normalizedSection(section)
    focusedAgentKind.value = systemSettingsSection.value === 'agents' ? kind : ''
    installConfirmKind.value = ''
    formError.value = ''
    if (systemSettingsSection.value === 'knowledge-bases') {
      void loadKnowledgeBaseStatuses()
    }
  }

  function selectSystemSettingsSection(section) {
    if (section === systemSettingsSection.value) return
    systemSettingsSection.value = normalizedSection(section)
    formError.value = ''
    if (systemSettingsSection.value === 'knowledge-bases') {
      void loadKnowledgeBaseStatuses()
    }
  }

  return {
    openAgentManager,
    openSystemSettings,
    selectSystemSettingsSection,
  }
}

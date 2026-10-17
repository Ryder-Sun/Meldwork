import { onBeforeUnmount, onMounted } from 'vue'

export function useAppWindowInteractions({
  closeCollapsedGroupMenu,
  closeModal,
  closeTracePanel,
  collapsedGroupMenu,
  collapsedGroupMenuButton,
  collapsedGroupMenuOpen,
  completeOnboarding,
  windowTitlebar,
  customAgentDeleteArmed,
  deleteArmed,
  messageDeleteArmedId,
  modal,
  onboardingVisible,
  openNewGroup,
  openSystemSettings,
  roundSettingsControl,
  roundSettingsOpen,
  selectGroup,
  selectedGroupId,
  shortcutMenuOpen,
  sidebarCollapsed,
  sidebarDeleteGroupId,
  skillMenuOpen,
  snapshot,
  sortByUpdated,
  tracePanelOpen,
  trapOverlayFocus,
}) {
  function selectAdjacentConversation(direction) {
    const groups = [...snapshot.value.groups].sort(sortByUpdated)
    if (!groups.length) return
    const activeIndex = groups.findIndex(group => group.id === selectedGroupId.value)
    const nextIndex = activeIndex < 0
      ? 0
      : (activeIndex + direction + groups.length) % groups.length
    selectGroup(groups[nextIndex].id)
  }

  function handleWindowKeydown(event) {
    if (trapOverlayFocus(event)) return
    if (event.key === 'Escape') {
      if (messageDeleteArmedId.value) {
        messageDeleteArmedId.value = ''
        return
      }
      if (collapsedGroupMenuOpen.value) {
        closeCollapsedGroupMenu({ restoreFocus: true })
        return
      }
      if (shortcutMenuOpen.value) {
        shortcutMenuOpen.value = false
        return
      }
      if (tracePanelOpen.value) {
        closeTracePanel()
        return
      }
      if (sidebarDeleteGroupId.value) {
        sidebarDeleteGroupId.value = ''
        return
      }
      if (onboardingVisible.value) {
        completeOnboarding()
        return
      }
      if (modal.value === 'settings' && deleteArmed.value) {
        deleteArmed.value = false
        return
      }
      if (modal.value === 'agent-detail' && customAgentDeleteArmed.value) {
        customAgentDeleteArmed.value = false
        return
      }
      if (modal.value) {
        closeModal()
        return
      }
      if (roundSettingsOpen.value) {
        roundSettingsOpen.value = false
        return
      }
      if (skillMenuOpen.value) {
        skillMenuOpen.value = false
      }
      return
    }
    if (event.isComposing || event.altKey || event.ctrlKey || !event.metaKey) return
    const key = String(event.key || '').toLowerCase()
    if (modal.value && (key === '[' || key === ']')) {
      event.preventDefault()
      return
    }
    if (key === 'b') {
      event.preventDefault()
      closeCollapsedGroupMenu()
      sidebarCollapsed.value = !sidebarCollapsed.value
      shortcutMenuOpen.value = false
      return
    }
    if (key === 'g') {
      event.preventDefault()
      closeCollapsedGroupMenu()
      shortcutMenuOpen.value = false
      openNewGroup()
      return
    }
    if (key === '[' || key === ']') {
      event.preventDefault()
      closeCollapsedGroupMenu()
      shortcutMenuOpen.value = false
      selectAdjacentConversation(key === '[' ? -1 : 1)
      return
    }
    if (key === ',') {
      event.preventDefault()
      closeCollapsedGroupMenu()
      shortcutMenuOpen.value = false
      openSystemSettings('agents')
    }
  }

  function handleWindowPointerDown(event) {
    const target = event.target
    if (
      messageDeleteArmedId.value
      && !(target instanceof Element && target.closest('.message-delete-button'))
    ) {
      messageDeleteArmedId.value = ''
    }
    if (
      sidebarDeleteGroupId.value
      && !(target instanceof Element && target.closest('.sidebar-delete-control, .sidebar-delete-popover'))
    ) {
      sidebarDeleteGroupId.value = ''
    }
    if (roundSettingsOpen.value && !roundSettingsControl.value?.contains(target)) {
      roundSettingsOpen.value = false
    }
    if (shortcutMenuOpen.value && !windowTitlebar.value?.containsShortcutTarget(target)) {
      shortcutMenuOpen.value = false
    }
    if (
      collapsedGroupMenuOpen.value
      && !collapsedGroupMenuButton.value?.contains(target)
      && !collapsedGroupMenu.value?.contains(target)
    ) {
      closeCollapsedGroupMenu()
    }
  }

  onMounted(() => {
    window.addEventListener('keydown', handleWindowKeydown)
    window.addEventListener('pointerdown', handleWindowPointerDown)
  })

  onBeforeUnmount(() => {
    window.removeEventListener('keydown', handleWindowKeydown)
    window.removeEventListener('pointerdown', handleWindowPointerDown)
  })
}

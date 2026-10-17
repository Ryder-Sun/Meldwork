import { defineComponent, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppWindowInteractions } from '../../composables/useAppWindowInteractions.js'

const mountedWrappers = []

function keyboardEvent(key, options = {}) {
  return new KeyboardEvent('keydown', { cancelable: true, key, ...options })
}

function mountInteractions(overrides = {}) {
  const collapsedGroupMenuOpen = ref(false)
  const modal = ref('')
  const onboardingVisible = ref(false)
  const selectedGroupId = ref('')
  const tracePanelOpen = ref(false)
  const deps = {
    closeCollapsedGroupMenu: vi.fn(() => { collapsedGroupMenuOpen.value = false }),
    closeModal: vi.fn(() => { modal.value = '' }),
    closeTracePanel: vi.fn(() => { tracePanelOpen.value = false }),
    collapsedGroupMenu: ref(null),
    collapsedGroupMenuButton: ref(null),
    collapsedGroupMenuOpen,
    completeOnboarding: vi.fn(() => { onboardingVisible.value = false }),
    windowTitlebar: ref({ containsShortcutTarget: () => false }),
    customAgentDeleteArmed: ref(false),
    deleteArmed: ref(false),
    messageDeleteArmedId: ref(''),
    modal,
    onboardingVisible,
    openNewGroup: vi.fn(),
    openSystemSettings: vi.fn(),
    roundSettingsControl: ref(null),
    roundSettingsOpen: ref(false),
    selectGroup: vi.fn(id => { selectedGroupId.value = id }),
    selectedGroupId,
    shortcutMenuOpen: ref(false),
    sidebarCollapsed: ref(false),
    sidebarDeleteGroupId: ref(''),
    skillMenuOpen: ref(false),
    snapshot: ref({ groups: [] }),
    sortByUpdated: (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    tracePanelOpen,
    trapOverlayFocus: vi.fn(() => false),
    ...overrides,
  }
  const wrapper = mount(defineComponent({
    setup() {
      useAppWindowInteractions(deps)
      return () => null
    },
  }))
  mountedWrappers.push(wrapper)
  return { deps, wrapper }
}

function pressEscape() {
  window.dispatchEvent(keyboardEvent('Escape'))
}

afterEach(() => {
  while (mountedWrappers.length) mountedWrappers.pop().unmount()
  document.body.replaceChildren()
})

describe('App window interactions', () => {
  it('dismisses overlapping UI state in the established Escape priority', () => {
    const { deps } = mountInteractions()
    deps.messageDeleteArmedId.value = 'message-1'
    deps.collapsedGroupMenuOpen.value = true
    deps.shortcutMenuOpen.value = true
    deps.tracePanelOpen.value = true
    deps.sidebarDeleteGroupId.value = 'group-1'
    deps.onboardingVisible.value = true
    deps.modal.value = 'settings'
    deps.deleteArmed.value = true
    deps.roundSettingsOpen.value = true
    deps.skillMenuOpen.value = true

    pressEscape()
    expect(deps.messageDeleteArmedId.value).toBe('')
    expect(deps.collapsedGroupMenuOpen.value).toBe(true)
    pressEscape()
    expect(deps.closeCollapsedGroupMenu).toHaveBeenLastCalledWith({ restoreFocus: true })
    pressEscape()
    expect(deps.shortcutMenuOpen.value).toBe(false)
    pressEscape()
    expect(deps.closeTracePanel).toHaveBeenCalledOnce()
    pressEscape()
    expect(deps.sidebarDeleteGroupId.value).toBe('')
    pressEscape()
    expect(deps.completeOnboarding).toHaveBeenCalledOnce()
    pressEscape()
    expect(deps.deleteArmed.value).toBe(false)
    expect(deps.modal.value).toBe('settings')
    pressEscape()
    expect(deps.closeModal).toHaveBeenCalledOnce()

    deps.modal.value = 'agent-detail'
    deps.customAgentDeleteArmed.value = true
    pressEscape()
    expect(deps.customAgentDeleteArmed.value).toBe(false)
    expect(deps.modal.value).toBe('agent-detail')
    pressEscape()
    expect(deps.closeModal).toHaveBeenCalledTimes(2)
    pressEscape()
    expect(deps.roundSettingsOpen.value).toBe(false)
    pressEscape()
    expect(deps.skillMenuOpen.value).toBe(false)
  })

  it('handles every application shortcut and ignores guarded key events', () => {
    const { deps } = mountInteractions()
    deps.snapshot.value.groups = [
      { id: 'older', updatedAt: '2026-08-01T00:00:00.000Z' },
      { id: 'newer', updatedAt: '2026-08-02T00:00:00.000Z' },
    ]
    deps.selectedGroupId.value = 'newer'
    deps.collapsedGroupMenuOpen.value = true
    deps.shortcutMenuOpen.value = true

    const sidebarEvent = keyboardEvent('b', { metaKey: true })
    window.dispatchEvent(sidebarEvent)
    expect(sidebarEvent.defaultPrevented).toBe(true)
    expect(deps.sidebarCollapsed.value).toBe(true)
    expect(deps.shortcutMenuOpen.value).toBe(false)

    window.dispatchEvent(keyboardEvent('g', { ctrlKey: true }))
    window.dispatchEvent(keyboardEvent(']', { ctrlKey: true }))
    expect(deps.openNewGroup).not.toHaveBeenCalled()
    expect(deps.selectGroup).not.toHaveBeenCalled()
    window.dispatchEvent(keyboardEvent('g', { metaKey: true }))
    expect(deps.openNewGroup).toHaveBeenCalledOnce()
    window.dispatchEvent(keyboardEvent(']', { metaKey: true }))
    expect(deps.selectGroup).toHaveBeenLastCalledWith('older')
    window.dispatchEvent(keyboardEvent('[', { metaKey: true }))
    expect(deps.selectGroup).toHaveBeenLastCalledWith('newer')
    window.dispatchEvent(keyboardEvent(',', { metaKey: true }))
    expect(deps.openSystemSettings).toHaveBeenCalledWith('agents')

    window.dispatchEvent(keyboardEvent('g', { metaKey: true, isComposing: true }))
    window.dispatchEvent(keyboardEvent('g', { altKey: true, metaKey: true }))
    window.dispatchEvent(keyboardEvent('g'))
    expect(deps.openNewGroup).toHaveBeenCalledOnce()
  })

  it('blocks adjacent-conversation shortcuts while a modal is open', () => {
    const { deps } = mountInteractions()
    deps.snapshot.value.groups = [
      { id: 'older', updatedAt: '2026-08-01T00:00:00.000Z' },
      { id: 'newer', updatedAt: '2026-08-02T00:00:00.000Z' },
    ]
    deps.selectedGroupId.value = 'newer'
    deps.modal.value = 'unlimited-confirm'

    const nextEvent = keyboardEvent(']', { metaKey: true })
    const previousEvent = keyboardEvent('[', { metaKey: true })
    window.dispatchEvent(nextEvent)
    window.dispatchEvent(previousEvent)

    expect(nextEvent.defaultPrevented).toBe(true)
    expect(previousEvent.defaultPrevented).toBe(true)
    expect(deps.selectGroup).not.toHaveBeenCalled()
    expect(deps.selectedGroupId.value).toBe('newer')
  })

  it('keeps inside pointer targets open and dismisses them on an outside pointerdown', () => {
    const inside = document.createElement('button')
    inside.className = 'message-delete-button sidebar-delete-popover'
    const roundControl = document.createElement('div')
    const collapsedMenu = document.createElement('div')
    roundControl.append(inside)
    collapsedMenu.append(roundControl)
    document.body.append(collapsedMenu)

    const { deps } = mountInteractions()
    deps.collapsedGroupMenu.value = collapsedMenu
    deps.windowTitlebar.value = { containsShortcutTarget: target => target === inside }
    deps.roundSettingsControl.value = roundControl
    deps.messageDeleteArmedId.value = 'message-1'
    deps.sidebarDeleteGroupId.value = 'group-1'
    deps.roundSettingsOpen.value = true
    deps.shortcutMenuOpen.value = true
    deps.collapsedGroupMenuOpen.value = true

    inside.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(deps.messageDeleteArmedId.value).toBe('message-1')
    expect(deps.sidebarDeleteGroupId.value).toBe('group-1')
    expect(deps.roundSettingsOpen.value).toBe(true)
    expect(deps.shortcutMenuOpen.value).toBe(true)
    expect(deps.collapsedGroupMenuOpen.value).toBe(true)

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(deps.messageDeleteArmedId.value).toBe('')
    expect(deps.sidebarDeleteGroupId.value).toBe('')
    expect(deps.roundSettingsOpen.value).toBe(false)
    expect(deps.shortcutMenuOpen.value).toBe(false)
    expect(deps.closeCollapsedGroupMenu).toHaveBeenCalledOnce()
  })

  it('removes window listeners when the owning component unmounts', () => {
    const { deps, wrapper } = mountInteractions()
    wrapper.unmount()
    deps.sidebarCollapsed.value = false
    deps.messageDeleteArmedId.value = 'message-1'

    window.dispatchEvent(keyboardEvent('b', { metaKey: true }))
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))

    expect(deps.sidebarCollapsed.value).toBe(false)
    expect(deps.messageDeleteArmedId.value).toBe('message-1')
    expect(deps.closeCollapsedGroupMenu).not.toHaveBeenCalled()
  })
})

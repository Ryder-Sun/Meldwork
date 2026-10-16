import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { useAppPreferences } from '../../composables/useAppPreferences.js'

function fakeColorScheme(initialDark) {
  const listeners = new Set()
  const query = {
    matches: initialDark,
    addEventListener: vi.fn((_type, listener) => listeners.add(listener)),
    removeEventListener: vi.fn((_type, listener) => listeners.delete(listener)),
  }
  return {
    query,
    matchMedia: vi.fn(() => query),
    setDark(value) {
      query.matches = value
      for (const listener of listeners) listener({ matches: value })
    },
  }
}

function mountPreferences() {
  let api = null
  const wrapper = mount(defineComponent({
    setup() {
      api = useAppPreferences()
      return () => h('div')
    },
  }))
  return { api, wrapper }
}

beforeEach(() => localStorage.clear())

afterEach(() => {
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.theme
})

describe('theme preference', () => {
  it('follows the system on first launch without saving a fixed theme', async () => {
    const scheme = fakeColorScheme(false)
    vi.stubGlobal('matchMedia', scheme.matchMedia)
    const { api, wrapper } = mountPreferences()

    expect(api.themePreference.value).toBe('system')
    expect(api.theme.value).toBe('light')
    expect(localStorage.getItem('meldwork-theme')).toBeNull()

    scheme.setDark(true)
    await nextTick()
    expect(api.theme.value).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem('meldwork-theme')).toBeNull()
    wrapper.unmount()
    expect(scheme.query.removeEventListener).toHaveBeenCalledTimes(1)
  })

  it('keeps an explicit choice and stops following the system until System is chosen again', async () => {
    const scheme = fakeColorScheme(false)
    vi.stubGlobal('matchMedia', scheme.matchMedia)
    const { api, wrapper } = mountPreferences()

    api.toggleTheme()
    await nextTick()
    expect(api.theme.value).toBe('dark')
    expect(localStorage.getItem('meldwork-theme')).toBe('dark')

    scheme.setDark(false)
    await nextTick()
    expect(api.theme.value).toBe('dark')

    api.setThemePreference('system')
    await nextTick()
    expect(api.theme.value).toBe('light')
    expect(localStorage.getItem('meldwork-theme')).toBe('system')
    scheme.setDark(true)
    await nextTick()
    expect(api.theme.value).toBe('dark')
    wrapper.unmount()
  })

  it('restores a saved explicit theme without listening to the system', () => {
    localStorage.setItem('meldwork-theme', 'dark')
    const scheme = fakeColorScheme(false)
    vi.stubGlobal('matchMedia', scheme.matchMedia)
    const { api, wrapper } = mountPreferences()

    expect(api.theme.value).toBe('dark')
    expect(scheme.query.addEventListener).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

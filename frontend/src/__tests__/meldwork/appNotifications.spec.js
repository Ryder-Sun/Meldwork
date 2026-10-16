import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { useAppNotifications } from '../../composables/useAppNotifications.js'
import { setLocale } from '../../i18n.js'

function mountNotifications() {
  let api = null
  const wrapper = mount(defineComponent({
    setup() {
      api = useAppNotifications()
      return () => h('div')
    },
  }))
  return { api, wrapper }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  setLocale('en')
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('app notifications', () => {
  it('keeps short notices for four seconds and longer ones long enough to read', () => {
    const { api, wrapper } = mountNotifications()

    api.notify('Saved.')
    vi.advanceTimersByTime(3900)
    expect(api.toastMessage.value).toBe('Saved.')
    vi.advanceTimersByTime(600)
    expect(api.toastMessage.value).toBe('')

    const long = 'x'.repeat(80)
    api.notify(long)
    // 4 s + 80 × 60 ms = 8.8 s.
    vi.advanceTimersByTime(8700)
    expect(api.toastMessage.value).toBe(long)
    vi.advanceTimersByTime(200)
    expect(api.toastMessage.value).toBe('')

    api.notify('y'.repeat(1000))
    vi.advanceTimersByTime(10_100)
    expect(api.toastMessage.value).toBe('')
    wrapper.unmount()
  })

  it('pauses while hovered and restarts the countdown when the pointer leaves', () => {
    const { api, wrapper } = mountNotifications()

    api.notify('Check the folder permissions.')
    api.pauseToast()
    vi.advanceTimersByTime(20_000)
    expect(api.toastMessage.value).toBe('Check the folder permissions.')

    api.resumeToast()
    vi.advanceTimersByTime(3000)
    expect(api.toastMessage.value).toBe('Check the folder permissions.')
    vi.advanceTimersByTime(3000)
    expect(api.toastMessage.value).toBe('')
    wrapper.unmount()
  })

  it('marks failures as errors and plain notices as warnings', () => {
    const { api, wrapper } = mountNotifications()

    api.notify('Select at least one Agent.')
    expect(api.toastTone.value).toBe('warning')

    api.showError(new Error('LOCAL_AGENT_TIMEOUT'))
    expect(api.toastTone.value).toBe('error')
    expect(api.toastMessage.value).toContain('took too long to respond')
    wrapper.unmount()
  })
})

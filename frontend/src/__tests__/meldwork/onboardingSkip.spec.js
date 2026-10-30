import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocale } from '../../i18n.js'
import { deferred, mountApp } from './app-test-harness.js'

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('meldwork-theme', 'light')
  setLocale('en')
})

afterEach(() => {
  vi.restoreAllMocks()
  delete window.meldworkDesktop
  document.body.className = ''
  document.body.innerHTML = ''
})

describe('first-run onboarding', () => {
  it('shows detection loading first, then allows skipping onboarding', async () => {
    vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const pendingDetection = deferred()
    const { wrapper } = await mountApp(({ bridge }) => {
      bridge.localWorkspace.refreshAgents.mockReturnValueOnce(pendingDetection.promise)
    })

    expect(wrapper.get('.agent-discovery-overlay').find('.wave-physics-loader').exists()).toBe(true)
    expect(wrapper.find('.onboarding-dialog').exists()).toBe(false)
    pendingDetection.resolve(undefined)
    await flushPromises()
    expect(wrapper.find('.agent-discovery-overlay').exists()).toBe(false)
    const skip = wrapper.get('.onboarding-skip')
    expect(skip.text()).toBe('Skip')
    await skip.trigger('click')
    await flushPromises()

    expect(wrapper.find('.onboarding-dialog').exists()).toBe(false)
    expect(localStorage.getItem('meldwork-onboarding-seen-v1')).toBe('1')
    expect(wrapper.get('.sidebar').attributes()).not.toHaveProperty('inert')
    wrapper.unmount()
  })

  it('moves between slides with the arrow keys', async () => {
    const { wrapper } = await mountApp()
    const dialog = wrapper.get('.onboarding-dialog')

    await dialog.trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.findAll('.onboarding-dot')[1].attributes('aria-current')).toBe('step')
    await dialog.trigger('keydown', { key: 'ArrowLeft' })
    expect(wrapper.findAll('.onboarding-dot')[0].attributes('aria-current')).toBe('step')
    // The first slide is the floor.
    await dialog.trigger('keydown', { key: 'ArrowLeft' })
    expect(wrapper.findAll('.onboarding-dot')[0].attributes('aria-current')).toBe('step')
    wrapper.unmount()
  })
})

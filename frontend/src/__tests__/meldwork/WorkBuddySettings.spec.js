import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import WorkBuddySettings from '../../components/WorkBuddySettings.vue'
import { locale } from '../../i18n.js'

afterEach(() => { delete window.meldworkDesktop })

describe('WorkBuddy model settings', () => {
  it('loads names, saves only the selected ID and refreshes after success', async () => {
    locale.value = 'en'
    const settings = { modelId: '', models: [{ id: 'text', name: 'Text model' }] }
    const setModel = vi.fn(async modelId => ({ ...settings, modelId }))
    window.meldworkDesktop = { workBuddy: { settings: vi.fn(async () => settings), setModel } }
    const wrapper = mount(WorkBuddySettings)
    await flushPromises()
    expect(wrapper.text()).toContain('Text model')
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined()
    await wrapper.get('select').setValue('text')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(setModel).toHaveBeenCalledWith('text')
    expect(wrapper.emitted('changed')).toHaveLength(1)
    wrapper.unmount()
  })

  it('keeps the choice and reports failure without claiming success', async () => {
    locale.value = 'zh'
    window.meldworkDesktop = { workBuddy: {
      settings: vi.fn(async () => ({ modelId: '', models: [{ id: 'text', name: 'Text' }] })),
      setModel: vi.fn(async () => { throw new Error('LOCAL_WORKBUDDY_BUSY') }),
    } }
    const wrapper = mount(WorkBuddySettings)
    await flushPromises()
    await wrapper.get('select').setValue('text')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('等待当前运行结束')
    expect(wrapper.get('select').element.value).toBe('text')
    expect(wrapper.emitted('changed')).toBeUndefined()
    wrapper.unmount()
  })
})

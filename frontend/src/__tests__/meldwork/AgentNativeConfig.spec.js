import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import AgentNativeConfig from '../../components/AgentNativeConfig.vue'
import { t } from '../../i18n.js'

afterEach(() => { delete window.meldworkDesktop })

it('selects and clears the native configuration directory', async () => {
  const api = { get: vi.fn().mockResolvedValue({ directory: '' }),
    choose: vi.fn().mockResolvedValue({ canceled: false, directory: '/native/hermes' }),
    clear: vi.fn().mockResolvedValue({ canceled: false, directory: '' }) }
  window.meldworkDesktop = { localAgentNativeConfig: api }
  const wrapper = mount(AgentNativeConfig, { props: { kind: 'hermes' } })
  await flushPromises()
  await wrapper.findAll('button').find(button => button.text() === t('nativeConfig.choose')).trigger('click')
  await flushPromises()
  expect(api.choose).toHaveBeenCalledWith('hermes')
  expect(wrapper.text()).toContain('/native/hermes')
  await wrapper.findAll('button').find(button => button.text() === t('nativeConfig.clear')).trigger('click')
  await flushPromises()
  expect(api.clear).toHaveBeenCalledWith('hermes')
  expect(wrapper.text()).toContain(t('nativeConfig.automatic'))
  wrapper.unmount()
})

it('shows expected configuration files when the selected directory is invalid', async () => {
  const api = { get: vi.fn().mockResolvedValue({ directory: '/previous' }),
    choose: vi.fn().mockRejectedValue(new Error('LOCAL_NATIVE_CONFIG_INVALID')) }
  window.meldworkDesktop = { localAgentNativeConfig: api }
  const wrapper = mount(AgentNativeConfig, { props: { kind: 'hermes' } })
  await flushPromises()
  await wrapper.findAll('button').find(button => button.text() === t('nativeConfig.choose')).trigger('click')
  await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toContain('config.yaml')
  expect(wrapper.text()).toContain('/previous')
  wrapper.unmount()
})

it('explains the DeepSeek Harness directory requirements', async () => {
  const api = { get: vi.fn().mockResolvedValue({ directory: '' }),
    choose: vi.fn().mockRejectedValue(new Error('LOCAL_NATIVE_CONFIG_INVALID')) }
  window.meldworkDesktop = { localAgentNativeConfig: api }
  const wrapper = mount(AgentNativeConfig, { props: { kind: 'deepseek' } })
  await flushPromises()
  await wrapper.findAll('button').find(button => button.text() === t('nativeConfig.choose')).trigger('click')
  await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toContain('profiles')
  wrapper.unmount()
})

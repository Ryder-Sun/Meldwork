import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import AgentNativeConfig from '../../components/AgentNativeConfig.vue'
import { t } from '../../i18n.js'

afterEach(() => { delete window.meldworkDesktop })

it('warns when a previously selected native directory is no longer valid', async () => {
  window.meldworkDesktop = { localAgentNativeConfig: {
    get: vi.fn().mockResolvedValue({ directory: '/native/hermes', directoryMissing: true }),
  } }
  const wrapper = mount(AgentNativeConfig, { props: { kind: 'hermes' } })
  await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toContain(t('nativeConfig.directoryMissing'))
  expect(wrapper.get('[role="alert"]').text()).toContain('config.yaml')
  expect(wrapper.text()).toContain('/native/hermes')
  wrapper.unmount()
})

it('does not claim automatic discovery when the saved directory cannot be read', async () => {
  window.meldworkDesktop = { localAgentNativeConfig: {
    get: vi.fn().mockRejectedValue(new Error('LOCAL_WORKSPACE_UNAVAILABLE')),
  } }
  const wrapper = mount(AgentNativeConfig, { props: { kind: 'hermes' } })
  await flushPromises()
  expect(wrapper.find('[role="alert"]').exists()).toBe(true)
  expect(wrapper.text()).not.toContain(t('nativeConfig.automatic'))
  wrapper.unmount()
})

it('explains the expected Kimi native configuration when selection is invalid', async () => {
  window.meldworkDesktop = { localAgentNativeConfig: {
    get: vi.fn().mockResolvedValue({ directory: '' }),
    choose: vi.fn().mockRejectedValue(new Error('LOCAL_NATIVE_CONFIG_INVALID')),
  } }
  const wrapper = mount(AgentNativeConfig, { props: { kind: 'kimi' } })
  await flushPromises()
  await wrapper.findAll('button').find(button => button.text() === t('nativeConfig.choose')).trigger('click')
  await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toContain('config.toml')
  wrapper.unmount()
})

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

it('shows the configured Hermes provider and refreshes it after selecting a directory', async () => {
  const api = { get: vi.fn().mockResolvedValueOnce({ directory: '', provider: 'auto' })
    .mockResolvedValueOnce({ directory: '/native/hermes', provider: 'custom:work' }),
  choose: vi.fn().mockResolvedValue({ canceled: false, directory: '/native/hermes' }) }
  window.meldworkDesktop = { localAgentNativeConfig: api }
  const wrapper = mount(AgentNativeConfig, { props: { kind: 'hermes' } })
  await flushPromises()
  expect(wrapper.text()).toContain('auto')
  await wrapper.findAll('button').find(button => button.text() === t('nativeConfig.choose')).trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('custom:work')
  expect(wrapper.text()).toContain(t('nativeConfig.configuredProvider'))
  wrapper.unmount()
})

it('identifies Codex provider information as user configuration', async () => {
  window.meldworkDesktop = { localAgentNativeConfig: { get: vi.fn().mockResolvedValue({ directory: '/native/codex', provider: 'custom' }) } }
  const wrapper = mount(AgentNativeConfig, { props: { kind: 'codex' } })
  await flushPromises()
  expect(wrapper.text()).toContain(t('nativeConfig.userConfiguredProvider'))
  expect(wrapper.text()).toContain('custom')
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

it('explains the WorkBuddy directory requirements', async () => {
  const api = { get: vi.fn().mockResolvedValue({ directory: '' }),
    choose: vi.fn().mockRejectedValue(new Error('LOCAL_NATIVE_CONFIG_INVALID')) }
  window.meldworkDesktop = { localAgentNativeConfig: api }
  const wrapper = mount(AgentNativeConfig, { props: { kind: 'workbuddy' } })
  await flushPromises()
  await wrapper.findAll('button').find(button => button.text() === t('nativeConfig.choose')).trigger('click')
  await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toContain('models.json')
  wrapper.unmount()
})

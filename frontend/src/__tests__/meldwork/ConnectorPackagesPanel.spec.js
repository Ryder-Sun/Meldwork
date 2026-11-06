import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ConnectorPackagesPanel from '../../components/ConnectorPackagesPanel.vue'
import { t } from '../../i18n.js'

afterEach(() => { delete window.meldworkDesktop })

describe('Connector package settings', () => {
  it('approves packages and configures credential-free instances', async () => {
    const item = { packageId: 'package', manifestId: 'manifest', state: 'imported', label: 'Example', connectorVersion: '1.0.0', publisher: { name: 'Publisher' } }
    const api = {
      packages: vi.fn().mockResolvedValue([item]),
      list: vi.fn().mockResolvedValue([]),
      approve: vi.fn(async () => { item.state = 'installed' }),
      inspect: vi.fn().mockResolvedValue({ manifest: { credentials: { slots: [] } } }),
      configure: vi.fn().mockResolvedValue({}),
    }
    window.meldworkDesktop = { localAgentConnector: api }
    const wrapper = mount(ConnectorPackagesPanel)
    await flushPromises()
    await wrapper.findAll('button').find(button => button.text() === t('connectorPackages.approve')).trigger('click')
    await flushPromises()
    expect(api.approve).toHaveBeenCalledWith('package')
    await wrapper.findAll('button').find(button => button.text() === t('connectorPackages.configure')).trigger('click')
    await flushPromises()
    expect(api.configure).toHaveBeenCalledWith({ manifestId: 'manifest', label: 'Example', credentials: null })
    wrapper.unmount()
  })

  it('does not request credentials in the renderer', async () => {
    const item = { packageId: 'package', manifestId: 'manifest', state: 'installed', label: 'Example', connectorVersion: '1.0.0', publisher: { name: 'Publisher' } }
    const api = { packages: vi.fn().mockResolvedValue([item]), list: vi.fn().mockResolvedValue([]), inspect: vi.fn().mockResolvedValue({ manifest: { credentials: { slots: [{ slotId: 'key' }] } } }), configure: vi.fn() }
    window.meldworkDesktop = { localAgentConnector: api }
    const wrapper = mount(ConnectorPackagesPanel)
    await flushPromises()
    await wrapper.findAll('button').find(button => button.text() === t('connectorPackages.configure')).trigger('click')
    await flushPromises()
    expect(api.configure).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain(t('connectorPackages.credentialsUnavailable'))
    wrapper.unmount()
  })

  it('tests instances and confirms deletion while surfacing in-use errors', async () => {
    const instance = { instanceId: 'instance', label: 'Example', available: true }
    const api = { packages: vi.fn().mockResolvedValue([]), list: vi.fn().mockResolvedValue([instance]),
      test: vi.fn().mockResolvedValue({ passed: true }),
      delete: vi.fn().mockRejectedValue(new Error('AGENT_CONNECTOR_INSTANCE_IN_USE')) }
    window.meldworkDesktop = { localAgentConnector: api }
    const wrapper = mount(ConnectorPackagesPanel)
    await flushPromises()
    await wrapper.findAll('button').find(button => button.text() === t('connectorPackages.test')).trigger('click')
    await flushPromises()
    expect(api.test).toHaveBeenCalledWith('instance')
    expect(wrapper.text()).toContain(t('connectorPackages.testPassed'))
    await wrapper.findAll('button').find(button => button.text() === t('connectorPackages.delete')).trigger('click')
    expect(api.delete).not.toHaveBeenCalled()
    await wrapper.findAll('button').find(button => button.text() === t('connectorPackages.delete')).trigger('click')
    await flushPromises()
    expect(api.delete).toHaveBeenCalledWith('instance')
    expect(wrapper.text()).toContain(t('connectorPackages.instanceInUse'))
    wrapper.unmount()
  })
})

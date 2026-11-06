import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ConnectorPackagesPanel from '../../components/ConnectorPackagesPanel.vue'
import { t } from '../../i18n.js'

afterEach(() => { delete window.meldworkDesktop })

describe('Connector package settings', () => {
  it('explains unsupported legacy packages and retains a disable action', async () => {
    const item = { packageId: 'old', connectorId: 'legacy', state: 'installed', supported: false,
      label: 'Legacy', connectorVersion: '1.0.0', publisher: { name: 'Publisher' } }
    window.meldworkDesktop = { localAgentConnector: { packages: vi.fn().mockResolvedValue([item]), list: vi.fn().mockResolvedValue([]) } }
    const wrapper = mount(ConnectorPackagesPanel)
    await flushPromises()
    expect(wrapper.text()).toContain(t('connectorPackages.unsupportedCapabilities'))
    expect(wrapper.text()).toContain(t('connectorPackages.disable'))
    expect(wrapper.text()).not.toContain(t('connectorPackages.configure'))
    wrapper.unmount()
  })
  it('offers upgrade instead of a conflicting install when another version is installed', async () => {
    const publisher = { name: 'Publisher' }
    const items = [
      { packageId: 'old', connectorId: 'example', state: 'installed', label: 'Old', connectorVersion: '1.0.0', publisher },
      { packageId: 'new', connectorId: 'example', state: 'approved', label: 'New', connectorVersion: '2.0.0', publisher },
      { packageId: 'disabled', connectorId: 'example', state: 'disabled', label: 'Disabled', connectorVersion: '0.9.0', publisher },
    ]
    const api = { packages: vi.fn().mockResolvedValue(items), list: vi.fn().mockResolvedValue([]), upgrade: vi.fn() }
    window.meldworkDesktop = { localAgentConnector: api }
    const wrapper = mount(ConnectorPackagesPanel)
    await flushPromises()
    const rows = wrapper.findAll('.connector-row')
    expect(rows[1].text()).toContain(t('connectorPackages.upgrade'))
    expect(rows[1].text()).not.toContain(t('connectorPackages.install'))
    expect(rows[2].text()).not.toContain(t('connectorPackages.install'))
    await rows[1].findAll('button').find(button => button.text() === t('connectorPackages.upgrade')).trigger('click')
    expect(api.upgrade).toHaveBeenCalledWith('new')
    wrapper.unmount()
  })

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

  it('displays inspected permissions and durable trust history', async () => {
    const item = { packageId: 'package', manifestId: 'manifest', state: 'imported', label: 'Example', connectorVersion: '1.0.0', publisher: { name: 'Publisher' } }
    const api = { packages: vi.fn().mockResolvedValue([item]), list: vi.fn().mockResolvedValue([]),
      inspect: vi.fn().mockResolvedValue({ packageId: 'package', origin: { filename: 'example.json', sha256: 'abc' }, manifest: {
        transport: { type: 'http', protocol: 'json' }, permissionModes: ['read-only'],
        credentials: { slots: [{ slotId: 'key' }] }, outboundDestinations: ['https://example.com'],
      } }), audit: vi.fn().mockResolvedValue([{ eventId: 'event', action: 'imported', timestamp: '2026-11-06T00:00:00Z' }]) }
    window.meldworkDesktop = { localAgentConnector: api }
    const wrapper = mount(ConnectorPackagesPanel)
    await flushPromises()
    await wrapper.findAll('button').find(button => button.text() === t('connectorPackages.inspect')).trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('read-only')
    expect(wrapper.text()).toContain('https://example.com')
    expect(wrapper.text()).toContain(t('connectorPackages.event.imported'))
    wrapper.unmount()
  })

  it('reloads after a failed action and removes stale controls if refresh fails', async () => {
    const item = { packageId: 'package', manifestId: 'manifest', state: 'installed', label: 'Example', connectorVersion: '1.0.0', publisher: { name: 'Publisher' } }
    const api = { packages: vi.fn().mockResolvedValueOnce([item]).mockRejectedValueOnce(new Error('refresh failed')).mockResolvedValueOnce([]),
      list: vi.fn().mockResolvedValue([]), disable: vi.fn().mockRejectedValue(new Error('refresh after mutation failed')) }
    window.meldworkDesktop = { localAgentConnector: api }
    const wrapper = mount(ConnectorPackagesPanel)
    await flushPromises()
    await wrapper.findAll('button').find(button => button.text() === t('connectorPackages.disable')).trigger('click')
    await flushPromises()
    expect(wrapper.text()).not.toContain('Example')
    expect(wrapper.text()).not.toContain(t('connectorPackages.empty'))
    expect(api.packages).toHaveBeenCalledTimes(2)
    await wrapper.findAll('button').find(button => button.text() === t('connectorPackages.retry')).trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain(t('connectorPackages.empty'))
    wrapper.unmount()
  })
})

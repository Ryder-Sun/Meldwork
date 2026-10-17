import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import CloudAgentBridgePanel from '../../components/CloudAgentBridgePanel.vue'
import { useCloudAgentBridges } from '../../composables/useCloudAgentBridges.js'
import { setLocale } from '../../i18n.js'

describe('Cloud Agent bridges', () => {
  it('refreshes the local Agent snapshot after connecting a server', async () => {
    const refreshAgents = vi.fn(async () => {})
    const bridgeApi = ref({
      connect: vi.fn(async () => ({ bridgeId: 'cloud-bridge-1' })),
      list: vi.fn(async () => []),
    })
    const bridges = useCloudAgentBridges({ bridgeApi, refreshAgents, showError: vi.fn() })

    bridges.address.value = '10.1.132.21'
    await bridges.connect()

    expect(bridgeApi.value.connect).toHaveBeenCalledWith({ address: '10.1.132.21' })
    expect(refreshAgents).toHaveBeenCalledTimes(1)
  })

  it('asks before deleting a connection and deletes only after confirming', async () => {
    setLocale('en')
    const remove = vi.fn(async () => {})
    const wrapper = mount(CloudAgentBridgePanel, {
      props: {
        controller: {
          address: ref(''),
          bridges: ref([{ bridgeId: 'bridge-1', label: 'Lab server', address: '203.0.113.10', available: true, transport: 'ssh', agents: [] }]),
          connect: vi.fn(),
          error: ref(''),
          label: ref(''),
          loading: ref(false),
          refresh: vi.fn(),
          remove,
          saving: ref(false),
        },
      },
    })

    await wrapper.get('[aria-label="Delete connection"]').trigger('click')
    expect(remove).not.toHaveBeenCalled()
    expect(wrapper.get('.cloud-agent-bridge-confirm').text()).toContain('Delete this connection?')

    await wrapper.get('.cloud-agent-bridge-confirm .secondary-button').trigger('click')
    expect(wrapper.find('.cloud-agent-bridge-confirm').exists()).toBe(false)
    expect(remove).not.toHaveBeenCalled()

    await wrapper.get('[aria-label="Delete connection"]').trigger('click')
    await wrapper.get('.cloud-agent-bridge-confirm .danger-button').trigger('click')
    expect(remove).toHaveBeenCalledWith('bridge-1')
    wrapper.unmount()
  })
})

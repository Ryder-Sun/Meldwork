import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AgentSettingsPanel from '../../components/AgentSettingsPanel.vue'

describe('Agent settings refresh', () => {
  it('rechecks cloud connections from cloud cards and local Agents from local cards', async () => {
    const agents = [
      { kind: 'codex', label: 'Codex', installed: true, ready: false },
      { kind: 'cloud-opencode', label: 'OpenCode @ Server', installed: true, ready: false, cloud: true },
    ]
    const wrapper = mount(AgentSettingsPanel, { props: {
      agentCatalogGroups: [{ id: 'all', titleKey: 'systemSettings.officialAgents', subtitleKey: 'systemSettings.officialAgentsHint', agents }],
      agentDescription: () => '', agentImageLabel: () => '', agentSkillLabel: () => '',
      agentState: () => ({ tone: 'warning', icon: 'span' }), agentStateNote: () => 'Unavailable',
      focusedAgentKind: '', installConfirmKind: '', installedCount: 2, installerBusy: false,
      installerPhaseLabel: '', installerState: { kind: '', phase: 'idle' },
      isDirectCreationPending: () => false, readyCount: 0, refreshing: false,
    } })
    const cards = wrapper.findAll('.settings-agent-card')
    await cards[0].get('.agent-card-recheck').trigger('click')
    await cards[1].get('.agent-card-recheck').trigger('click')
    expect(wrapper.emitted('refresh-agents')).toHaveLength(1)
    expect(wrapper.emitted('refresh-cloud-agents')).toHaveLength(1)
    expect(wrapper.emitted('open-agent-detail')).toBeUndefined()
    await cards[0].get('.agent-card-main').trigger('click')
    expect(wrapper.emitted('open-agent-detail')[0][0].kind).toBe('codex')
    wrapper.unmount()
  })
})

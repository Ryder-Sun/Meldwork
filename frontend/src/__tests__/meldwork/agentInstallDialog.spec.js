import { reactive, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import WorkspaceModalContent from '../../components/WorkspaceModalContent.vue'
import { useAgentManagement } from '../../composables/useAgentManagement.js'
import { setLocale, t } from '../../i18n.js'

describe('Agent installation in the detail dialog', () => {
  it('shows confirmation, starts once, and keeps progress and cancellation in the dialog', async () => {
    setLocale('en')
    const agent = { kind: 'pi', label: 'Pi Agent', installed: false, installSupported: true }
    const installConfirmKind = ref('')
    const installerState = ref({ kind: '', phase: 'idle' })
    const start = vi.fn(async kind => ({ kind, taskId: 'install-1', phase: 'installing', canCancel: true }))
    const cancel = vi.fn()
    const manager = useAgentManagement({ installConfirmKind, installerState, installer: ref({ start, cancel }), showError: vi.fn(), t })
    const controller = {
      modal: ref('agent-detail'), selectedAgentDetail: ref(agent),
      groupForm: reactive({ agentKinds: [] }), settingsForm: reactive({ agentKinds: [] }), readyAgentGroups: ref([]),
      agentState: () => ({}), agentDescription: () => '', agentImageLabel: () => '', agentSoul: () => '',
      agentDetailSkillItems: ref([]), saving: ref(false),
      installConfirmKind, installerState, installerBusy: manager.installerBusy, installerPhaseLabel: manager.installerPhaseLabel,
      requestInstall: manager.requestInstall, cancelInstall: manager.cancelInstall, t,
    }
    const wrapper = mount(WorkspaceModalContent, { props: { controller } })
    await wrapper.get('.primary-button').trigger('click')
    expect(start).not.toHaveBeenCalled()
    expect(wrapper.get('.install-confirm').text()).toContain('official installer')
    expect(wrapper.get('.primary-button').text()).toBe('Confirm install')
    await wrapper.get('.primary-button').trigger('click')
    expect(start).toHaveBeenCalledExactlyOnceWith('pi')
    expect(wrapper.get('.primary-button').element.disabled).toBe(true)
    expect(wrapper.text()).toContain('Installing')
    await wrapper.findAll('button').find(button => button.text() === t('installer.cancel')).trigger('click')
    expect(cancel).toHaveBeenCalledWith('install-1')
    installerState.value = { kind: 'pi', phase: 'failed', errorCode: 'INSTALL_AGENT_PROCESS_FAILED' }
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[role="alert"]').text()).toContain('installer exited')
    wrapper.unmount()
  })
})

import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useAgentManagement } from '../../composables/useAgentManagement.js'

describe('sidebar visibility', () => {
  it('releases the modal after saving even when agent discovery is still running', async () => {
    const saving = ref(false)
    const snapshot = ref({ agents: [] })
    const refreshAgents = vi.fn(() => new Promise(() => {}))
    const setSidebarVisibility = vi.fn(async () => ({ agents: [{ kind: 'zcode', showInSidebar: false }] }))
    const manager = useAgentManagement({
      installer: ref({ setSidebarVisibility }), installerState: ref({ phase: 'idle' }),
      saving, snapshot, refreshAgents, formError: ref(''), normalizeSnapshot: value => value,
      showError: vi.fn(), translateError: error => error.message, t: value => value,
    })
    await manager.setAgentSidebarVisibility({ kind: 'zcode' }, false)
    expect(setSidebarVisibility).toHaveBeenCalledWith('zcode', false)
    expect(snapshot.value.agents[0].showInSidebar).toBe(false)
    expect(refreshAgents).toHaveBeenCalledOnce()
    expect(saving.value).toBe(false)
  })
})

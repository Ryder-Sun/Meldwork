import { computed, ref, watch } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useAgentRefresh } from '../../composables/useAgentRefresh.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture() {
  const scan = deferred()
  let backend = { agents: [{ kind: 'codex', installed: true, available: false }] }
  const snapshot = ref(backend)
  const refresh = vi.fn(async () => { backend = await scan.promise; return backend })
  const catalog = vi.fn(async () => ({ platform: 'darwin', agents: backend.agents }))
  const inputs = {
    installCatalog: ref({ agents: backend.agents }),
    installer: ref({ catalog, state: vi.fn(async () => ({ phase: 'idle' })) }),
    installerState: ref({ phase: 'idle' }),
    invalidateAgentSkillCatalog: vi.fn(),
    loadAgentSkillStats: vi.fn(async () => {}),
    readyAgentSignature: computed(() => snapshot.value.agents.filter(a => a.available).map(a => a.kind).join(',')),
    refreshing: ref(false), showError: vi.fn(), snapshot,
    workspace: ref({ refreshAgents: refresh }),
  }
  return { ...inputs, ...useAgentRefresh(inputs), scan, refresh, catalog }
}

const ready = { agents: [{ kind: 'codex', installed: true, available: true }] }

describe('Agent refresh consistency', () => {
  it('shows verified installation before a slow workspace scan and preserves it if that scan fails', async () => {
    const f = fixture()
    f.installer.value.catalog.mockResolvedValue({ agents: [{ kind: 'pi', installed: true }] })
    const pending = f.refreshAfterInstall()
    await Promise.resolve()
    expect(f.installCatalog.value.agents).toEqual([{ kind: 'pi', installed: true }])
    expect(f.refreshing.value).toBe(true)
    f.scan.reject(new Error('readiness scan failed'))
    await pending
    expect(f.installCatalog.value.agents[0].installed).toBe(true)
    expect(f.showError).toHaveBeenCalled()
  })
  it('reads the catalog only after readiness refresh so both surfaces see the new state', async () => {
    const f = fixture()
    const pending = f.refreshAgents()
    await Promise.resolve()
    expect(f.refreshing.value).toBe(true)
    expect(f.catalog).not.toHaveBeenCalled()
    f.scan.resolve(ready)
    await pending
    expect(f.catalog).toHaveBeenCalledTimes(1)
    expect(f.snapshot.value.agents[0].available).toBe(true)
    expect(f.installCatalog.value.agents[0].available).toBe(true)
    expect(f.refreshing.value).toBe(false)
    expect(f.showError).not.toHaveBeenCalled()
  })

  it('retains a successful scan if the subsequent catalog read fails', async () => {
    const f = fixture()
    const error = new Error('catalog unavailable')
    f.catalog.mockRejectedValue(error)
    const pending = f.refreshAgents()
    f.scan.resolve(ready)
    await pending
    expect(f.snapshot.value.agents[0].available).toBe(true)
    expect(f.showError).toHaveBeenCalledWith(error)
    expect(f.refreshing.value).toBe(false)
  })

  it('invalidates skills before publishing readiness, even while the catalog is pending', async () => {
    const f = fixture()
    const catalogRead = deferred()
    f.catalog.mockReturnValue(catalogRead.promise)
    const observed = vi.fn(() => {
      expect(f.invalidateAgentSkillCatalog).toHaveBeenCalledTimes(1)
    })
    const stop = watch(f.readyAgentSignature, observed, { flush: 'sync' })
    const pending = f.refreshAgents()
    f.scan.resolve(ready)
    await vi.waitFor(() => expect(observed).toHaveBeenCalledTimes(1))
    expect(f.refreshing.value).toBe(true)
    catalogRead.resolve({ agents: ready.agents })
    await pending
    expect(f.invalidateAgentSkillCatalog).toHaveBeenCalledTimes(1)
    stop()
  })

  it('retains the last snapshot on scan failure and allows a subsequent refresh', async () => {
    const f = fixture()
    const error = new Error('scan unavailable')
    const pending = f.refreshAgents()
    f.scan.reject(error)
    await pending
    expect(f.snapshot.value.agents[0].installed).toBe(true)
    expect(f.catalog).not.toHaveBeenCalled()
    expect(f.showError).toHaveBeenCalledWith(error)
    expect(f.refreshing.value).toBe(false)
    f.refresh.mockResolvedValue(ready)
    await f.refreshAgents()
    expect(f.snapshot.value.agents[0].available).toBe(true)
    expect(f.catalog).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent requests into one follow-up scan', async () => {
    const f = fixture()
    const first = f.refreshAgents()
    expect(f.refreshAgents()).toBe(first)
    expect(f.refreshAgents()).toBe(first)
    f.scan.resolve(ready)
    await first
    expect(f.refresh).toHaveBeenCalledTimes(2)
    expect(f.catalog).toHaveBeenCalledTimes(2)
    expect(f.refreshing.value).toBe(false)
  })
})

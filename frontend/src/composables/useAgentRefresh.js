import { setCloudAgentProfiles, setCustomAgentProfiles } from '../catalog.js'
import { normalizeSnapshot } from '../desktop.js'

export function useAgentRefresh({
  installCatalog,
  installer,
  installerState,
  invalidateAgentSkillCatalog,
  loadAgentSkillStats,
  readyAgentSignature,
  refreshing,
  showError,
  snapshot,
  workspace,
}) {
  let refreshPromise = null
  let refreshAgain = false

  function applyInstallCatalog(value) {
    const catalog = value && typeof value === 'object'
      ? value
      : { platform: '', agents: [] }
    installCatalog.value = {
      ...catalog,
      agents: Array.isArray(catalog.agents) ? catalog.agents : [],
    }
    setCustomAgentProfiles(installCatalog.value.agents.filter(agent => agent?.custom === true))
    setCloudAgentProfiles(installCatalog.value.agents.filter(agent => agent?.cloud === true))
  }

  async function performAgentRefresh() {
    const previousReadyAgentSignature = readyAgentSignature.value
    const nextSnapshot = await workspace.value.refreshAgents()
    invalidateAgentSkillCatalog()
    snapshot.value = normalizeSnapshot(nextSnapshot)
    // The installer catalog merges readiness from the refreshed workspace.
    const [nextCatalog, nextInstaller] = await Promise.all([
      installer.value?.catalog?.() || installCatalog.value,
      installer.value?.state?.() || installerState.value,
    ])
    applyInstallCatalog(nextCatalog)
    installerState.value = nextInstaller || installerState.value
    if (readyAgentSignature.value && readyAgentSignature.value === previousReadyAgentSignature) {
      await loadAgentSkillStats()
    }
  }

  function refreshAgents() {
    if (!workspace.value) return Promise.resolve()
    if (refreshPromise) {
      refreshAgain = true
      return refreshPromise
    }
    refreshing.value = true
    refreshPromise = (async () => {
      do {
        refreshAgain = false
        try {
          await performAgentRefresh()
        } catch (error) {
          showError(error)
        }
      } while (refreshAgain)
    })().finally(() => {
      refreshing.value = false
      refreshPromise = null
    })
    return refreshPromise
  }

  async function refreshAfterInstall() {
    try {
      applyInstallCatalog(await installer.value.catalog())
    } catch (error) {
      showError(error)
    }
    return refreshAgents()
  }

  return {
    applyInstallCatalog,
    refreshAgents,
    refreshAfterInstall,
  }
}

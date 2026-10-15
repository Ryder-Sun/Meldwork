const {
  agentRuntimeCapabilities,
} = require('../agents/agent-runtime-contract.cjs')

const RECENT_VERIFICATION_MS = 24 * 60 * 60 * 1000
const AUTH_FAILURE_RETRY_MS = 30 * 1000

function expiredAuthFailure(runtime, now) {
  if (runtime?.credentialState !== 'missing') return false
  const checkedAt = Date.parse(String(runtime.checkedAt || ''))
  const current = Date.parse(String(now || ''))
  return !Number.isFinite(checkedAt) || (Number.isFinite(current)
    && (current < checkedAt || current - checkedAt >= AUTH_FAILURE_RETRY_MS))
}

function agentVersionIdentified(agent) {
  if (agent?.custom === true) return true
  if (typeof agent?.versionIdentified === 'boolean') return agent.versionIdentified
  if (agent?.compatibilityState === 'unknown') return false
  if (String(agent?.resolvedVersion || '').trim()) return true
  if (agent?.compatibilityState === 'compatible') return true
  return typeof agent?.compatibilityState === 'undefined'
}

function agentCompatible(agent) {
  return agent?.custom === true
    || agent?.compatibilityState === 'compatible'
    || typeof agent?.compatibilityState === 'undefined'
}

function recentlyVerified(runtime, now) {
  if (runtime?.credentialState !== 'ready') return false
  const checkedAt = Date.parse(String(runtime.checkedAt || ''))
  const current = Date.parse(String(now || ''))
  return Number.isFinite(checkedAt) && Number.isFinite(current)
    && current >= checkedAt && current - checkedAt <= RECENT_VERIFICATION_MS
}

class LocalWorkspaceAgentCatalog {
  constructor(options) {
    this.state = options.state
    this.detectedAgents = options.detectedAgents
    this.setDetectedAgents = options.setDetectedAgents
    this.detectAgents = options.detectAgents
    this.credentialState = options.credentialState
    this.attachmentSupport = options.attachmentSupport || (() => ({}))
    this.save = options.save
    this.emitChanged = options.emitChanged
    this.snapshot = options.snapshot
    this.now = options.now
    this.refreshTask = null
    this.refreshAgain = false
  }

  async refresh() {
    if (this.refreshTask) {
      this.refreshAgain = true
      return this.refreshTask
    }
    const task = (async () => {
      let snapshot
      do {
        this.refreshAgain = false
        snapshot = await this.refreshOnce()
      } while (this.refreshAgain)
      return snapshot
    })()
    const pending = task.finally(() => {
      if (this.refreshTask === pending) this.refreshTask = null
    })
    this.refreshTask = pending
    return pending
  }

  async refreshOnce() {
    const runtimeAtRefreshStart = new Map(Object.entries(this.state().agentRuntime))
    const detected = await this.detectAgents()
    const nativeStates = await Promise.all(detected.map(async (agent) => {
      try {
        return await this.credentialState(agent.kind, agent)
      } catch {
        return { state: 'unknown', source: 'native-probe-failed' }
      }
    }))
    const state = this.state()
    let recoveredRuntimeCredential = false
    const agents = detected.map((agent, index) => {
      const native = nativeStates[index]
      let runtime = state.agentRuntime[agent.kind]
      const nativeState = ['ready', 'missing'].includes(native?.state) ? native.state : 'unknown'
      const authoritativeNativeState = native?.source === 'native-auth-status'
      // Give corrected native credentials a retry after the cooldown, never erase a newer failure.
      if (expiredAuthFailure(runtime, this.now())
          && !(authoritativeNativeState && nativeState === 'ready')
          && runtime === runtimeAtRefreshStart.get(agent.kind)) {
        delete state.agentRuntime[agent.kind]
        runtime = undefined
        recoveredRuntimeCredential = true
      }
      // A probe that started before a newer runtime failure cannot clear that failure.
      if (authoritativeNativeState && nativeState === 'ready'
          && ['missing', 'unknown'].includes(runtime?.credentialState)
          && runtime === runtimeAtRefreshStart.get(agent.kind)) {
        runtime = {
          credentialState: 'ready',
          checkedAt: this.now(),
        }
        state.agentRuntime[agent.kind] = runtime
        recoveredRuntimeCredential = true
      }
      const runtimeMissing = runtime?.credentialState === 'missing'
      const verifiedReady = runtime?.credentialState === 'ready'
        || state.messages.some(message => (
          message.role === 'agent' && message.agentKind === agent.kind
        ))
      const nativeReadySource = nativeState === 'ready'
        ? (native.source || 'native-credential')
        : ''
      let credentialState = 'unknown'
      if (runtimeMissing || nativeState === 'missing') {
        credentialState = 'missing'
      }
      if (!runtimeMissing && nativeState === 'ready') credentialState = 'ready'
      else if (!runtimeMissing && verifiedReady && nativeState !== 'missing') credentialState = 'ready'
      const installed = true
      const versionIdentified = agentVersionIdentified(agent)
      const compatible = agentCompatible(agent)
      const nativeConfigurationUnknown = !runtimeMissing
        && nativeState === 'unknown'
        && native?.source !== 'native-runtime-unavailable'
        && native?.source !== 'native-probe-failed'
      const configured = nativeState === 'ready'
        || native?.source === 'native-auth-status'
        || native?.source === 'native-runtime-unavailable'
        || verifiedReady
        || runtimeMissing
        || nativeConfigurationUnknown
      const authenticated = !runtimeMissing && nativeState !== 'missing' && (
        nativeState === 'ready' || verifiedReady || nativeConfigurationUnknown
      )
      const runtimePrerequisitesReady = native?.source !== 'native-runtime-unavailable'
        && (native?.source !== 'native-probe-failed' || recentlyVerified(runtime, this.now()))
      const invocable = installed && versionIdentified && compatible && configured
        && authenticated && runtimePrerequisitesReady
      const verifiedRecently = (authoritativeNativeState && nativeState === 'ready')
        || recentlyVerified(runtime, this.now())
      const available = invocable
      const preferred = state.agentPreferences[agent.kind]?.showInSidebar
      const capabilities = agentRuntimeCapabilities(agent.kind, {
        agent,
        attachmentSupport: this.attachmentSupport(agent.kind),
      })
      let availabilitySource = 'unverified'
      if (!compatible) availabilitySource = 'incompatible'
      else if (runtimeMissing) availabilitySource = 'runtime-auth-failure'
      else if (nativeState === 'missing') availabilitySource = native.source || 'none'
      else if (native?.source === 'native-probe-failed') availabilitySource = 'native-probe-failed'
      else if (nativeReadySource) availabilitySource = nativeReadySource
      else if (verifiedReady) availabilitySource = 'verified-run'
      else if (nativeConfigurationUnknown) availabilitySource = 'local-cli'
      return {
        ...agent,
        installed,
        versionIdentified,
        compatible,
        configured,
        authenticated,
        invocable,
        recentlyVerified: verifiedRecently,
        credentialState,
        availabilitySource,
        available,
        task: capabilities.task,
        resumable: capabilities.resumable,
        capabilities,
        showInSidebar: typeof preferred === 'boolean' ? preferred : true,
      }
    })
    this.setDetectedAgents(agents)
    if (recoveredRuntimeCredential) this.save()
    this.emitChanged()
    return this.snapshot()
  }

  setSidebarVisibility(kind, visible) {
    const agent = this.detectedAgents().find(item => item.kind === kind)
    if (!agent) throw new Error('LOCAL_AGENT_NOT_INSTALLED')
    const state = this.state()
    state.agentPreferences[kind] = { showInSidebar: Boolean(visible) }
    agent.showInSidebar = Boolean(visible)
    this.save()
    this.emitChanged()
    return this.snapshot()
  }

  markRuntimeCredential(kind, credentialState) {
    const state = this.state()
    state.agentRuntime[kind] = {
      credentialState,
      checkedAt: this.now(),
    }
    const agent = this.detectedAgents().find(item => item.kind === kind)
    if (agent && !(credentialState === 'unknown' && agent.authenticated === true)) {
      agent.credentialState = credentialState
      agent.versionIdentified = agentVersionIdentified(agent)
      agent.compatible = agentCompatible(agent)
      agent.configured = credentialState !== 'unknown'
      agent.authenticated = credentialState === 'ready'
      agent.invocable = agent.versionIdentified && agent.compatible
        && agent.configured && agent.authenticated
      agent.recentlyVerified = credentialState === 'ready'
      agent.available = agent.invocable
      agent.availabilitySource = !agent.compatible
        ? 'incompatible'
        : credentialState === 'ready'
          ? 'verified-run'
          : credentialState === 'missing'
            ? 'runtime-auth-failure'
            : 'unverified'
      const preferred = state.agentPreferences[kind]?.showInSidebar
      agent.showInSidebar = typeof preferred === 'boolean' ? preferred : true
    }
    this.save()
    this.emitChanged()
  }

  clearRuntimeCredentialFailures() {
    const state = this.state()
    let changed = false
    for (const [kind, runtime] of Object.entries(state.agentRuntime)) {
      if (runtime?.credentialState !== 'missing') continue
      delete state.agentRuntime[kind]
      changed = true
    }
    if (changed) this.save()
    return changed
  }
}

module.exports = { LocalWorkspaceAgentCatalog }

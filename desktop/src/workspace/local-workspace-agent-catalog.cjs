const { agentVerificationIdentity, projectVerificationIdentity } = require('./agent-verification-identity.cjs')
const { NATIVE_CONFIG_IDENTITY_DIRECTORY, NATIVE_AUTH_IDENTITY_FILES, NATIVE_PROJECT_CONFIG_PATHS } = require('../agents/native-config-directory.cjs')
const {
  agentRuntimeCapabilities,
} = require('../agents/agent-runtime-contract.cjs')

const RECENT_VERIFICATION_MS = 24 * 60 * 60 * 1000
const AUTH_FAILURE_RETRY_MS = 30 * 1000
const MAX_PROJECT_AUTH_RECORDS = 64
const PROJECT_NATIVE_ENVIRONMENT_KINDS = new Set(['codex', 'hermes', 'zcode', 'mimo', 'opencode'])
// A readiness probe that times out or crashes says nothing about whether the
// Agent works: it is not a "not signed in" answer. An Agent that was usable
// stays usable through such results for this long; a definitive answer
// (signed out, incompatible, a recorded auth failure) applies immediately.
const INDETERMINATE_PROBE_GRACE_MS = 10 * 60 * 1000
const INDETERMINATE_PROBE_SOURCES = new Set(['native-probe-failed'])

function expiredAuthFailure(runtime, now) {
  if (runtime?.credentialState !== 'missing' && !runtime?.projectFailureIdentity) return false
  const checkedAt = Date.parse(String(runtime.projectFailureCheckedAt || runtime.checkedAt || ''))
  const current = Date.parse(String(now || ''))
  return !Number.isFinite(checkedAt) || (Number.isFinite(current)
    && (current < checkedAt || current - checkedAt >= AUTH_FAILURE_RETRY_MS))
}

function clearProjectFailure(runtime) {
  if ((runtime?.verificationSource !== 'successful-run' || runtime.credentialState !== 'ready')
      && !runtime?.projectVerifications?.length && !runtime?.projectFailures?.length) return undefined
  const { projectFailureIdentity, projectFailureCheckedAt, failureIdentity, ...retained } = runtime
  return retained
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

function sidebarVisible(agent, preferred) {
  if (typeof preferred === 'boolean') return preferred
  return !(agent.custom === true && agent.task && agent.task !== 'general')
}

function agentInvocable({ installed, versionIdentified, compatible, configured, authenticated, canAttempt, runtimePrerequisitesReady, unavailable }) {
  return installed !== false && versionIdentified && compatible
    && ((configured && authenticated) || canAttempt === true)
    && runtimePrerequisitesReady !== false && !unavailable
}

function recentlyVerified(runtime, now) {
  if (runtime?.credentialState !== 'ready') return false
  const checkedAt = Date.parse(String(runtime.checkedAt || ''))
  const current = Date.parse(String(now || ''))
  return Number.isFinite(checkedAt) && Number.isFinite(current)
    && current >= checkedAt && current - checkedAt <= RECENT_VERIFICATION_MS
}

function matchesRecentVerification(runtime, agent, now, preferences) {
  return runtime?.verificationSource === 'successful-run' && recentlyVerified(runtime, now)
    && Boolean(runtime.verificationIdentity) && runtime.verificationIdentity === agentVerificationIdentity(agent, preferences)
}

class LocalWorkspaceAgentCatalog {
  constructor(options) {
    this.state = options.state
    this.detectedAgents = options.detectedAgents
    this.setDetectedAgents = options.setDetectedAgents
    this.detectAgents = options.detectAgents
    this.isKnownAgent = options.isKnownAgent || (() => false)
    this.credentialState = options.credentialState
    this.resolveProjectEnvironmentIdentities = options.resolveProjectEnvironmentIdentities || null
    this.projectEnvironmentIdentities = new Map()
    this.projectEnvironmentGeneration = 0
    this.attachmentSupport = options.attachmentSupport || (() => ({}))
    this.save = options.save
    this.emitChanged = options.emitChanged
    this.snapshot = options.snapshot
    this.now = options.now
    this.refreshTask = null
    this.refreshAgain = false
    this.indeterminateSince = new Map()
    this.detectedIdentities = new Map(this.detectedAgents().map(agent => [agent.kind, agentVerificationIdentity(agent, this.state().agentPreferences)]))
  }

  async refreshProjectEnvironment(workdir, kinds) {
    if (!this.resolveProjectEnvironmentIdentities || typeof workdir !== 'string') return
    const selected = [...new Set((kinds || []).filter(kind => PROJECT_NATIVE_ENVIRONMENT_KINDS.has(kind)))]
    if (!selected.length) return
    const generation = ++this.projectEnvironmentGeneration
    const keys = selected.map(kind => JSON.stringify([kind, workdir]))
    for (const key of keys) this.projectEnvironmentIdentities.set(key, { generation, value: null })
    let identities = null
    try { identities = await this.resolveProjectEnvironmentIdentities(workdir, selected) } catch { /* Fail closed for routing. */ }
    for (let index = 0; index < selected.length; index += 1) {
      const current = this.projectEnvironmentIdentities.get(keys[index])
      if (current?.generation !== generation) continue
      const value = identities?.[selected[index]]
      current.value = typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null
    }
    while (this.projectEnvironmentIdentities.size > 256) {
      this.projectEnvironmentIdentities.delete(this.projectEnvironmentIdentities.keys().next().value)
    }
  }

  projectIdentity(kind, workdir, agent) {
    let environmentIdentity = ''
    if (this.resolveProjectEnvironmentIdentities && PROJECT_NATIVE_ENVIRONMENT_KINDS.has(kind)) {
      environmentIdentity = this.projectEnvironmentIdentities.get(JSON.stringify([kind, workdir]))?.value
      if (!environmentIdentity) return null
    }
    return projectVerificationIdentity(kind, workdir, agent, environmentIdentity)
  }

  isRecentlyVerified(kind, workdir) {
    const runtime = this.state().agentRuntime[kind]
    const agent = this.detectedAgents().find(item => item.kind === kind)
    if (workdir === undefined) return matchesRecentVerification(runtime, agent, this.now(), this.state().agentPreferences)
    if (this.isProjectAuthBlocked(kind, workdir)) return false
    const projectIdentity = this.projectIdentity(kind, workdir, agent)
    if (projectIdentity === '') return matchesRecentVerification(runtime, agent, this.now(), this.state().agentPreferences)
    if (!projectIdentity || runtime?.credentialState === 'missing') return false
    const identity = agentVerificationIdentity(agent, this.state().agentPreferences)
    const record = Array.isArray(runtime?.projectVerifications)
      ? runtime.projectVerifications.find(item => item?.projectIdentity === projectIdentity && item.verificationIdentity === identity)
      : null
    if (record) return recentlyVerified({ credentialState: 'ready', checkedAt: record.checkedAt }, this.now())
    return matchesRecentVerification(runtime, agent, this.now(), this.state().agentPreferences)
      && runtime.projectVerificationIdentity === projectIdentity
  }

  isProjectAuthBlocked(kind, workdir) {
    const runtime = this.state().agentRuntime[kind]
    const agent = this.detectedAgents().find(item => item.kind === kind)
    const identity = this.projectIdentity(kind, workdir, agent)
    const agentIdentity = agentVerificationIdentity(agent, this.state().agentPreferences)
    const failure = Array.isArray(runtime?.projectFailures)
      ? runtime.projectFailures.find(item => item?.projectIdentity === identity && item.verificationIdentity === agentIdentity)
      : null
    if (failure) return !expiredAuthFailure({ projectFailureIdentity: identity, projectFailureCheckedAt: failure.checkedAt }, this.now())
    return Boolean(identity && runtime?.projectFailureIdentity === identity
      && runtime.failureIdentity === agentIdentity
      && !expiredAuthFailure(runtime, this.now()))
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
    const previousAgents = new Map(this.detectedAgents().map(agent => [agent.kind, agent]))
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
      const workBuddyUnavailable = ['workbuddy-desktop-locked', 'workbuddy-model-unavailable'].includes(native?.source)
      const authoritativeNativeState = native?.source === 'native-auth-status'
      if ((runtime?.credentialState === 'missing' || runtime?.projectFailureIdentity) && runtime.failureIdentity
          && runtime.failureIdentity !== agentVerificationIdentity(agent, state.agentPreferences)
          && runtime === runtimeAtRefreshStart.get(agent.kind)) {
        delete state.agentRuntime[agent.kind]
        runtime = undefined
        recoveredRuntimeCredential = true
      }
      // Give corrected native credentials a retry after the cooldown, never erase a newer failure.
      if (expiredAuthFailure(runtime, this.now())
          && (runtime?.projectFailureIdentity || !(authoritativeNativeState && nativeState === 'ready'))
          && runtime === runtimeAtRefreshStart.get(agent.kind)) {
        const retained = clearProjectFailure(runtime)
        if (retained) state.agentRuntime[agent.kind] = retained
        else delete state.agentRuntime[agent.kind]
        runtime = retained
        recoveredRuntimeCredential = true
      }
      // A probe that started before a newer runtime failure cannot clear that failure.
      if (authoritativeNativeState && nativeState === 'ready'
          && ['missing', 'unknown'].includes(runtime?.credentialState)
          && !runtime?.projectFailureIdentity
          && runtime === runtimeAtRefreshStart.get(agent.kind)) {
        runtime = {
          ...runtime,
          credentialState: 'ready',
          checkedAt: this.now(),
        }
        state.agentRuntime[agent.kind] = runtime
        recoveredRuntimeCredential = true
      }
      const runtimeMissing = runtime?.credentialState === 'missing'
      const verifiedReady = matchesRecentVerification(runtime, agent, this.now(), state.agentPreferences)
      const nativeReadySource = nativeState === 'ready'
        ? (native.source || 'native-credential')
        : ''
      const retained = this.retainedAvailability({
        agent, previous: previousAgents.get(agent.kind), native, runtimeMissing,
      })
      let credentialState = 'unknown'
      if (runtimeMissing || nativeState === 'missing') {
        credentialState = 'missing'
      }
      if (!runtimeMissing && nativeState === 'ready') credentialState = 'ready'
      else if (!runtimeMissing && verifiedReady && nativeState !== 'missing') credentialState = 'ready'
      if (retained && retained.credentialState === 'ready') credentialState = 'ready'
      const installed = true
      const versionIdentified = agentVersionIdentified(agent)
      const compatible = agentCompatible(agent)
      const nativeConfigurationUnknown = !runtimeMissing
        && !workBuddyUnavailable
        && nativeState === 'unknown'
        && native?.source !== 'native-runtime-unavailable'
        && native?.source !== 'native-probe-failed'
      const configured = retained?.configured === true
        || nativeState === 'ready'
        || native?.source === 'native-auth-status'
        || native?.source === 'native-runtime-unavailable'
        || verifiedReady
        || runtimeMissing
      const authenticated = retained?.authenticated === true || (!runtimeMissing && nativeState !== 'missing' && (
        verifiedReady || (nativeState === 'ready' && native?.source === 'native-auth-status')
      ))
      const runtimePrerequisitesReady = retained !== null
        || (native?.source !== 'native-runtime-unavailable'
          && (native?.source !== 'native-probe-failed' || verifiedReady))
      const invocable = agentInvocable({ installed, versionIdentified, compatible, configured,
        authenticated, canAttempt: retained !== null || nativeConfigurationUnknown
          || (!runtimeMissing && nativeState === 'ready'),
        runtimePrerequisitesReady, unavailable: workBuddyUnavailable })
      const verifiedRecently = matchesRecentVerification(runtime, agent, this.now(), state.agentPreferences)
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
      else if (native?.source === 'native-runtime-unavailable') availabilitySource = 'native-runtime-unavailable'
      else if (nativeReadySource) availabilitySource = nativeReadySource
      else if (verifiedReady) availabilitySource = 'verified-run'
      else if (nativeConfigurationUnknown) availabilitySource = 'local-cli'
      if (retained) availabilitySource = retained.availabilitySource
      if (workBuddyUnavailable) availabilitySource = native.source
      const result = {
        ...agent,
        installed,
        versionIdentified,
        compatible,
        configured,
        authenticated,
        runtimePrerequisitesReady,
        runtimePrerequisitesSource: runtimePrerequisitesReady ? '' : native?.source || '',
        runtimeBlockSource: workBuddyUnavailable ? native.source : '',
        invocable,
        recentlyVerified: verifiedRecently,
        credentialState,
        availabilitySource,
        available,
        task: capabilities.task,
        resumable: capabilities.resumable,
        capabilities,
        showInSidebar: sidebarVisible({ ...agent, task: capabilities.task }, preferred),
      }
      if (agent[NATIVE_CONFIG_IDENTITY_DIRECTORY]) {
        Object.defineProperty(result, NATIVE_CONFIG_IDENTITY_DIRECTORY, { value: agent[NATIVE_CONFIG_IDENTITY_DIRECTORY] })
      }
      if (agent[NATIVE_AUTH_IDENTITY_FILES]) {
        Object.defineProperty(result, NATIVE_AUTH_IDENTITY_FILES, { value: agent[NATIVE_AUTH_IDENTITY_FILES] })
      }
      if (agent[NATIVE_PROJECT_CONFIG_PATHS]) {
        Object.defineProperty(result, NATIVE_PROJECT_CONFIG_PATHS, { value: agent[NATIVE_PROJECT_CONFIG_PATHS] })
      }
      return result
    })
    this.setDetectedAgents(agents)
    this.detectedIdentities = new Map(agents.map(agent => [agent.kind, agentVerificationIdentity(agent, state.agentPreferences)]))
    if (recoveredRuntimeCredential) this.save()
    this.emitChanged()
    return this.snapshot()
  }

  // The state an Agent keeps while a readiness probe is inconclusive, or null
  // when the probe result must be taken at face value.
  retainedAvailability({ agent, previous, native, runtimeMissing }) {
    if (!INDETERMINATE_PROBE_SOURCES.has(native?.source)) {
      this.indeterminateSince.delete(agent.kind)
      return null
    }
    const nowMs = Date.parse(String(this.now()))
    if (!this.indeterminateSince.has(agent.kind) && Number.isFinite(nowMs)) {
      this.indeterminateSince.set(agent.kind, nowMs)
    }
    const since = this.indeterminateSince.get(agent.kind)
    if (previous?.available !== true || runtimeMissing || !Number.isFinite(nowMs)
        || !Number.isFinite(since) || nowMs - since >= INDETERMINATE_PROBE_GRACE_MS
        || this.detectedIdentities.get(agent.kind) !== agentVerificationIdentity(agent, this.state().agentPreferences)
        || !agentVersionIdentified(agent) || !agentCompatible(agent)) return null
    return {
      credentialState: previous.credentialState,
      availabilitySource: previous.availabilitySource || 'native-probe-failed',
      configured: previous.configured === true,
      authenticated: previous.authenticated === true,
    }
  }

  setSidebarVisibility(kind, visible) {
    const agent = this.detectedAgents().find(item => item.kind === kind)
    if (!agent && !this.isKnownAgent(kind)) throw new Error('LOCAL_AGENT_NOT_INSTALLED')
    const state = this.state()
    state.agentPreferences[kind] = { ...state.agentPreferences[kind], showInSidebar: Boolean(visible) }
    if (agent) agent.showInSidebar = Boolean(visible)
    this.save()
    this.emitChanged()
    return this.snapshot()
  }

  markRuntimeCredential(kind, credentialState, { verifiedRun = true, verificationIdentity = '', workdir, projectIdentity } = {}) {
    const state = this.state()
    const agent = this.detectedAgents().find(item => item.kind === kind)
    if (projectIdentity === null) return
    if (verificationIdentity && (!agent || verificationIdentity !== agentVerificationIdentity(agent, state.agentPreferences))) return
    if (projectIdentity !== undefined && projectIdentity !== this.projectIdentity(kind, workdir, agent)) return
    const identity = verificationIdentity || agentVerificationIdentity(agent, state.agentPreferences)
    const projectFailure = credentialState === 'missing' && typeof projectIdentity === 'string' && Boolean(projectIdentity)
    const previous = state.agentRuntime[kind]
    const preserveSuccess = projectFailure && previous?.credentialState === 'ready'
      && previous.verificationSource === 'successful-run' && previous.verificationIdentity === identity
      && previous.projectVerificationIdentity !== projectIdentity
    const preserveFailure = credentialState === 'ready' && previous?.projectFailureIdentity
      && previous.projectFailureIdentity !== projectIdentity && previous.failureIdentity === identity
      && !expiredAuthFailure(previous, this.now())
    const effectiveState = projectFailure ? (preserveSuccess ? 'ready' : 'unknown') : credentialState
    state.agentRuntime[kind] = {
      ...(preserveSuccess ? previous : {}),
      credentialState: effectiveState,
      checkedAt: preserveSuccess ? previous.checkedAt : this.now(),
      ...(projectFailure ? { projectFailureIdentity: projectIdentity, projectFailureCheckedAt: this.now() } : {}),
      ...(preserveFailure ? { projectFailureIdentity: previous.projectFailureIdentity,
        projectFailureCheckedAt: previous.projectFailureCheckedAt || previous.checkedAt,
        failureIdentity: previous.failureIdentity } : {}),
      ...(credentialState === 'missing' && verificationIdentity ? { failureIdentity: verificationIdentity } : {}),
      ...(credentialState === 'ready' && verifiedRun && identity
        ? { verificationSource: 'successful-run', verificationIdentity: identity,
          ...(projectIdentity ? { projectVerificationIdentity: projectIdentity } : {}) } : {}),
    }
    if (projectIdentity && (credentialState === 'missing' || (credentialState === 'ready' && verifiedRun))) {
      const keep = records => (Array.isArray(records) ? records : [])
        .filter(item => item?.verificationIdentity === identity && item.projectIdentity !== projectIdentity)
        .slice(-(MAX_PROJECT_AUTH_RECORDS - 1))
      const projectVerifications = keep(previous?.projectVerifications)
      const projectFailures = keep(previous?.projectFailures)
      if (previous?.verificationSource === 'successful-run' && previous.verificationIdentity === identity
          && previous.projectVerificationIdentity && previous.projectVerificationIdentity !== projectIdentity
          && !projectVerifications.some(item => item.projectIdentity === previous.projectVerificationIdentity)) {
        projectVerifications.push({ projectIdentity: previous.projectVerificationIdentity,
          verificationIdentity: identity, checkedAt: previous.checkedAt })
      }
      if (previous?.failureIdentity === identity && previous.projectFailureIdentity
          && previous.projectFailureIdentity !== projectIdentity
          && !projectFailures.some(item => item.projectIdentity === previous.projectFailureIdentity)) {
        projectFailures.push({ projectIdentity: previous.projectFailureIdentity,
          verificationIdentity: identity, checkedAt: previous.projectFailureCheckedAt || previous.checkedAt })
      }
      const record = { projectIdentity, verificationIdentity: identity, checkedAt: this.now() }
      if (projectFailure) projectFailures.push(record)
      else projectVerifications.push(record)
      state.agentRuntime[kind].projectVerifications = projectVerifications.slice(-MAX_PROJECT_AUTH_RECORDS)
      state.agentRuntime[kind].projectFailures = projectFailures.slice(-MAX_PROJECT_AUTH_RECORDS)
    }
    if (credentialState === 'ready') this.indeterminateSince.delete(kind)
    if (agent && !(effectiveState === 'unknown' && agent.authenticated === true)) {
      agent.credentialState = effectiveState
      agent.versionIdentified = agentVersionIdentified(agent)
      agent.compatible = agentCompatible(agent)
      agent.configured = effectiveState !== 'unknown'
      agent.authenticated = effectiveState === 'ready'
      agent.invocable = agentInvocable({ ...agent, canAttempt: effectiveState === 'unknown' && agent.available === true,
        unavailable: Boolean(agent.runtimeBlockSource) })
      agent.recentlyVerified = this.isRecentlyVerified(kind)
      agent.available = agent.invocable
      agent.availabilitySource = !agent.compatible
        ? 'incompatible'
        : effectiveState === 'missing'
          ? 'runtime-auth-failure'
          : agent.runtimeBlockSource
            ? agent.runtimeBlockSource
          : agent.runtimePrerequisitesReady === false
            ? agent.runtimePrerequisitesSource || 'native-runtime-unavailable'
            : effectiveState === 'ready' ? (agent.recentlyVerified ? 'verified-run' : 'native-credential') : 'unverified'
      const preferred = state.agentPreferences[kind]?.showInSidebar
      agent.showInSidebar = sidebarVisible(agent, preferred)
    }
    this.save()
    this.emitChanged()
  }

  clearRuntimeCredentialFailures() {
    const state = this.state()
    let changed = false
    for (const [kind, runtime] of Object.entries(state.agentRuntime)) {
      if (runtime?.credentialState !== 'missing' && !runtime?.projectFailureIdentity && !runtime?.projectFailures?.length) continue
      const retained = clearProjectFailure(runtime)
      if (retained) {
        delete retained.projectFailures
        state.agentRuntime[kind] = retained
      }
      else delete state.agentRuntime[kind]
      changed = true
    }
    if (changed) this.save()
    return changed
  }
}

module.exports = { LocalWorkspaceAgentCatalog }

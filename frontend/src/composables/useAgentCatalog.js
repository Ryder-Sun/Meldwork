import { computed } from 'vue'
import {
  CheckmarkCircleOutline,
  DownloadOutline,
  WarningOutline,
} from '@vicons/ionicons5'
import { AGENTS, agentLogo } from '../catalog.js'
import { MAX_ATTACHMENTS } from './useComposerAttachments.js'

export function useAgentCatalog({
  activeGroup,
  directGroupsFor,
  installCatalog,
  snapshot,
  t,
  theme,
}) {
  const mergedCatalog = computed(() => {
    const registeredProfiles = new Map()
    for (const agent of [...(installCatalog.value.agents || []), ...snapshot.value.agents]) {
      if (!agent?.kind) continue
      registeredProfiles.set(agent.kind, { ...registeredProfiles.get(agent.kind), ...agent })
    }
    const extraProfiles = [...registeredProfiles.values()]
      .filter(agent => !AGENTS.some(profile => profile.kind === agent.kind))
      .map(agent => ({
        kind: agent.kind,
        sourceKind: agent.sourceKind,
        label: agent.label || agent.name || agent.kind,
        logo: agent.logo,
        imageLimit: Number(agent.imageAttachmentLimit || 0),
        custom: agent.custom === true,
        connector: agent.connector === true,
        description: agent.description || '',
        cloud: agent.cloud === true,
      }))
    const profiles = [...AGENTS, ...extraProfiles]
    return profiles.map((profile) => {
    const installedProfile = installCatalog.value.agents?.find(agent => agent.kind === profile.kind) || {}
    const detected = snapshot.value.agents.find(agent => agent.kind === profile.kind) || {}
    return {
      ...profile,
      ...installedProfile,
      ...detected,
      label: profile.label,
      logo: agentLogo(
        detected.sourceKind || installedProfile.sourceKind || profile.sourceKind || profile.kind,
        theme.value,
      ),
      imageLimit: profile.custom
        ? MAX_ATTACHMENTS
        : Number(detected.imageAttachmentLimit ?? installedProfile.imageAttachmentLimit ?? profile.imageLimit) || 0,
      installed: Boolean(installedProfile.installed || detected.installed),
      ready: detected.available === true,
    }
    })
  })

  const agentCatalogGroups = computed(() => [
    {
      id: 'official',
      titleKey: 'systemSettings.officialAgents',
      subtitleKey: 'systemSettings.officialAgentsHint',
      agents: mergedCatalog.value.filter(agent => !agent.custom && !agent.cloud),
    },
    {
      id: 'cloud',
      titleKey: 'systemSettings.cloudAgents',
      subtitleKey: 'systemSettings.cloudAgentsHint',
      agents: mergedCatalog.value.filter(agent => agent.cloud === true),
    },
    {
      id: 'custom',
      titleKey: 'systemSettings.customAgents',
      subtitleKey: 'systemSettings.customAgentsHint',
      agents: mergedCatalog.value.filter(agent => agent.custom && agent.cloud !== true),
    },
  ].filter(category => category.agents.length > 0))
  const readyAgents = computed(() => mergedCatalog.value.filter(agent => agent.ready))
  const readyAgentGroups = computed(() => [
    {
      id: 'local',
      titleKey: 'agentLocation.local',
      hintKey: 'group.agentLocationLocalHint',
      agents: readyAgents.value.filter(agent => !agent.cloud),
    },
    {
      id: 'cloud',
      titleKey: 'agentLocation.cloud',
      hintKey: 'group.agentLocationCloudHint',
      agents: readyAgents.value.filter(agent => agent.cloud),
    },
  ].filter(group => group.agents.length))
  const readyAgentSignature = computed(() => readyAgents.value.map(agent => agent.kind).join('\u0000'))
  const readyAgentKinds = computed(() => new Set(readyAgents.value.map(agent => agent.kind)))
  const readyCount = computed(() => readyAgents.value.length)
  const installedCount = computed(() => mergedCatalog.value.filter(agent => agent.installed).length)
  const sidebarAgents = computed(() => mergedCatalog.value.filter((agent) => {
    if ((agent.ready || agent.installed) && agent.showInSidebar !== false) return true
    return !agent.ready && directGroupsFor(agent.kind).length > 0
  }))
  const sidebarAgentGroups = computed(() => [
    {
      id: 'local',
      titleKey: 'agentLocation.local',
      agents: sidebarAgents.value.filter(agent => !agent.cloud),
    },
    {
      id: 'cloud',
      titleKey: 'agentLocation.cloud',
      agents: sidebarAgents.value.filter(agent => agent.cloud),
    },
  ].filter(group => group.agents.length))
  const activeDirectAgent = computed(() => {
    if (activeGroup.value?.conversationType !== 'direct') return null
    return mergedCatalog.value.find(agent => agent.kind === activeGroup.value.directAgentKind) || null
  })

  function agentDescription(kind) {
    const profile = mergedCatalog.value.find(agent => agent.kind === kind)
    if (profile?.connector && profile.description) return profile.description
    if (profile?.custom && profile.description) return profile.description
    if (profile?.custom) return t('customAgent.defaultDescription')
    return t(`agent.description.${kind}`)
  }

  function agentSoul(agent) {
    if (agent?.cloud) return agent.description || t('cloudAgents.agentDescription')
    if (agent?.connector) return agent.description || t('customAgent.detailBody')
    if (agent?.custom) return agent.description || t('customAgent.detailBody')
    return t(`agent.soul.${agent?.kind}`)
  }

  function agentImageLabel(agent) {
    return agent?.imageLimit > 0
      ? t('agent.images', { count: agent.imageLimit })
      : t('agent.noImages')
  }

  function agentState(agent) {
    if (agent.ready) return { label: t('agent.ready'), tone: 'ready', icon: CheckmarkCircleOutline }
    if (agent.custom) return { label: t('customAgent.executableUnavailable'), tone: 'warning', icon: WarningOutline }
    if (!agent.installed) return { label: t('agent.notInstalled'), tone: 'off', icon: DownloadOutline }
    if (agent.incompatibilityReason === 'LOCAL_AGENT_CAPABILITY_PROBE_TIMEOUT') {
      return { label: t('agent.detectionTimedOut'), tone: 'warning', icon: WarningOutline }
    }
    if (agent.compatibilityState === 'incompatible') {
      const reasonKey = ({
        LOCAL_AGENT_VERSION_UNSUPPORTED: 'agent.incompatibleVersion',
        LOCAL_AGENT_REQUIRED_CAPABILITY_MISSING: 'agent.incompatibleCapability',
        LOCAL_AGENT_PROTOCOL_UNAVAILABLE: 'agent.incompatibleProtocol',
      })[agent.incompatibilityReason] || 'agent.incompatible'
      return { label: t(reasonKey), tone: 'warning', icon: WarningOutline }
    }
    if (agent.credentialState === 'missing') return { label: t('agent.needsLogin'), tone: 'warning', icon: WarningOutline }
    return { label: t('agent.unverified'), tone: 'neutral', icon: WarningOutline }
  }

  // One plain sentence on why an installed Agent cannot be used and what to do
  // next. Empty when there is nothing to explain (ready, or not installed).
  function agentStateNote(agent) {
    if (!agent || agent.ready || agent.custom || !agent.installed) return ''
    const version = agent.resolvedVersion || agent.version || ''
    const params = { version: version || t('agent.versionUnknown') }
    const verified = agent.supportedVersionRange
      ? ` ${t('agent.note.verifiedRange', { range: agent.supportedVersionRange })}`
      : ''
    if (agent.incompatibilityReason === 'LOCAL_AGENT_CAPABILITY_PROBE_TIMEOUT') {
      return t('agent.note.probeTimeout')
    }
    if (agent.compatibilityState === 'incompatible') {
      const key = ({
        LOCAL_AGENT_VERSION_UNSUPPORTED: 'agent.note.versionUnsupported',
        LOCAL_AGENT_REQUIRED_CAPABILITY_MISSING: 'agent.note.cannotStart',
        LOCAL_AGENT_PROTOCOL_UNAVAILABLE: 'agent.note.protocolUnavailable',
      })[agent.incompatibilityReason] || 'agent.note.versionUnsupported'
      return `${t(key, params)}${verified}`
    }
    if (agent.credentialState === 'missing') {
      // A cloud Agent runs on the connected server, so that is where it signs in.
      return t(agent.cloud ? 'agent.note.needsLoginCloud' : 'agent.note.needsLogin')
    }
    return ''
  }

  return {
    activeDirectAgent,
    agentCatalogGroups,
    agentDescription,
    agentImageLabel,
    agentSoul,
    agentState,
    agentStateNote,
    installedCount,
    mergedCatalog,
    readyAgentKinds,
    readyAgentGroups,
    readyAgentSignature,
    readyAgents,
    readyCount,
    sidebarAgents,
    sidebarAgentGroups,
  }
}

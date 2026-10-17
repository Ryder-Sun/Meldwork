import { ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { AGENTS, agentLogo, setCloudAgentProfiles } from '../../catalog.js'
import { useAgentCatalog } from '../../composables/useAgentCatalog.js'
import { setLocale, t } from '../../i18n.js'

function catalogFor(agent) {
  const catalog = useAgentCatalog({
    activeGroup: ref(null),
    directGroupsFor: () => [],
    installCatalog: ref({ agents: [{ kind: agent.kind, installed: true }] }),
    snapshot: ref({ agents: [agent] }),
    t,
    theme: ref('light'),
  })
  const merged = catalog.mergedCatalog.value.find(item => item.kind === agent.kind)
  return catalog.agentState(merged)
}

describe('Agent compatibility state', () => {
  it('keeps installed unavailable Agents visible while respecting hidden preferences and runnable choices', () => {
    const snapshot = ref({ agents: [
      { kind: 'codex', installed: true, available: false, credentialState: 'missing', showInSidebar: true },
      { kind: 'hermes', installed: true, available: false, showInSidebar: false },
    ] })
    const catalog = useAgentCatalog({
      activeGroup: ref(null), directGroupsFor: () => [], installCatalog: ref({ agents: [] }),
      snapshot, t, theme: ref('light'),
    })
    expect(catalog.sidebarAgents.value.map(agent => agent.kind)).toEqual(['codex'])
    expect(catalog.readyAgents.value).toHaveLength(0)
    snapshot.value.agents[0].available = true
    expect(catalog.sidebarAgents.value.map(agent => agent.kind)).toEqual(['codex'])
    expect(catalog.readyAgentKinds.value.has('codex')).toBe(true)
  })

  it('retains custom and local connector registrations without changing built-in order', () => {
    const custom = { kind: 'custom-0123456789abcdef', label: 'My CLI', custom: true, installed: true }
    const connector = { kind: 'local-example', label: 'Example', connector: true, installed: true }
    const catalog = useAgentCatalog({
      activeGroup: ref(null), directGroupsFor: () => [],
      installCatalog: ref({ agents: [custom, connector] }),
      snapshot: ref({ agents: [
        { ...custom, available: true }, { ...connector, available: true },
      ] }),
      t, theme: ref('light'),
    })
    expect(catalog.mergedCatalog.value.map(agent => agent.kind)).toEqual([
      ...AGENTS.map(agent => agent.kind), custom.kind, connector.kind,
    ])
    expect(catalog.readyAgents.value.map(agent => agent.kind)).toEqual([custom.kind, connector.kind])
    expect(catalog.agentCatalogGroups.value.find(group => group.id === 'custom').agents[0].label).toBe('My CLI')
    expect(catalog.sidebarAgents.value).toHaveLength(2)
  })

  it('keeps cloud Agents out of the local catalog and groups ready Agents by execution location', () => {
    setLocale('en')
    const cloudAgent = {
      kind: 'cloud-0123456789abcdef01234567',
      sourceKind: 'codex',
      label: 'Cloud Codex',
      custom: false,
      connector: true,
      cloud: true,
      installed: true,
      available: true,
      credentialState: 'ready',
      showInSidebar: true,
    }
    const catalog = useAgentCatalog({
      activeGroup: ref(null),
      directGroupsFor: () => [],
      installCatalog: ref({ agents: [{ kind: 'codex', installed: true }, cloudAgent] }),
      snapshot: ref({ agents: [
        { kind: 'codex', installed: true, available: true, credentialState: 'ready', showInSidebar: true },
        cloudAgent,
      ] }),
      t,
      theme: ref('light'),
    })

    expect(catalog.agentCatalogGroups.value.find(group => group.id === 'official').agents.map(agent => agent.kind))
      .not.toContain('cloud-0123456789abcdef01234567')
    expect(catalog.readyAgentGroups.value.map(group => [group.id, group.agents.map(agent => agent.kind)]))
      .toEqual([['local', ['codex']], ['cloud', ['cloud-0123456789abcdef01234567']]])
    expect(catalog.sidebarAgentGroups.value.map(group => [group.id, group.agents.map(agent => agent.kind)]))
      .toEqual([['local', ['codex']], ['cloud', ['cloud-0123456789abcdef01234567']]])
    const mergedCloud = catalog.mergedCatalog.value.find(agent => agent.kind === 'cloud-0123456789abcdef01234567')
    expect(mergedCloud.logo).toContain('agent-logos/codex.svg')
    setCloudAgentProfiles([cloudAgent])
    expect(agentLogo('cloud-0123456789abcdef01234567')).toContain('agent-logos/codex.svg')
  })

  it('gives Gemini its own logo and name instead of the generic custom-Agent icon', () => {
    setLocale('en')
    const cloudAgent = {
      kind: 'cloud-fedcba987654321012345678',
      sourceKind: 'gemini',
      label: 'Gemini @ Server',
      custom: false,
      connector: true,
      cloud: true,
      installed: true,
      available: true,
      credentialState: 'ready',
      showInSidebar: true,
    }
    const catalog = useAgentCatalog({
      activeGroup: ref(null),
      directGroupsFor: () => [],
      installCatalog: ref({ agents: [{ kind: 'gemini', name: 'Gemini CLI', installed: true }, cloudAgent] }),
      snapshot: ref({ agents: [
        { kind: 'gemini', name: 'Gemini CLI', installed: true, available: true, credentialState: 'ready' },
        cloudAgent,
      ] }),
      t,
      theme: ref('light'),
    })

    const gemini = catalog.mergedCatalog.value.find(agent => agent.kind === 'gemini')
    expect(gemini.label).toBe('Gemini CLI')
    expect(gemini.logo).toContain('agent-logos/gemini.svg')
    expect(catalog.agentCatalogGroups.value.find(group => group.id === 'official').agents.map(agent => agent.kind))
      .toContain('gemini')
    expect(catalog.mergedCatalog.value.find(agent => agent.kind === cloudAgent.kind).logo)
      .toContain('agent-logos/gemini.svg')
    setCloudAgentProfiles([cloudAgent])
    expect(agentLogo(cloudAgent.kind)).toContain('agent-logos/gemini.svg')
    expect(agentLogo('gemini', 'dark')).toContain('agent-logos/gemini.svg')
    setCloudAgentProfiles([])

    const withoutGemini = useAgentCatalog({
      activeGroup: ref(null),
      directGroupsFor: () => [],
      installCatalog: ref({ agents: [] }),
      snapshot: ref({ agents: [] }),
      t,
      theme: ref('light'),
    })
    expect(withoutGemini.mergedCatalog.value.map(agent => agent.kind)).toEqual(AGENTS.map(agent => agent.kind))
  })

  it('keeps an installed cloud Agent that needs login in management but out of chat choices', () => {
    setLocale('en')
    const cloudAgent = {
      kind: 'cloud-claude', sourceKind: 'claude', label: 'Claude Code @ Server',
      cloud: true, connector: true, custom: false, installed: true,
      available: false, credentialState: 'missing', showInSidebar: true,
    }
    const catalog = useAgentCatalog({
      activeGroup: ref(null),
      directGroupsFor: () => [],
      installCatalog: ref({ agents: [cloudAgent] }),
      snapshot: ref({ agents: [] }),
      t,
      theme: ref('light'),
    })

    expect(catalog.agentCatalogGroups.value.find(group => group.id === 'cloud').agents)
      .toHaveLength(1)
    expect(catalog.readyAgents.value).toHaveLength(0)
    const mergedCloud = catalog.mergedCatalog.value.find(agent => agent.kind === 'cloud-claude')
    expect(catalog.agentState(mergedCloud).label).toBe('Needs sign-in')
  })

  it('keeps ready OpenCodeReview available for sidebar and composer targets', () => {
    setLocale('en')
    const catalog = useAgentCatalog({
      activeGroup: ref(null),
      directGroupsFor: () => [],
      installCatalog: ref({ agents: [{ kind: 'opencodereview', installed: true }] }),
      snapshot: ref({
        agents: [{
          kind: 'opencodereview',
          installed: true,
          available: true,
          credentialState: 'ready',
          showInSidebar: true,
          task: 'code_review',
          version: '1.8.6',
        }],
      }),
      t,
      theme: ref('light'),
    })

    expect(catalog.readyAgents.value.map(agent => agent.kind)).toContain('opencodereview')
    expect(catalog.sidebarAgents.value.map(agent => agent.kind)).toContain('opencodereview')
    expect(catalog.readyAgentKinds.value.has('opencodereview')).toBe(true)
  })

  it.each([
    ['LOCAL_AGENT_VERSION_UNSUPPORTED', 'Unsupported version'],
    ['LOCAL_AGENT_REQUIRED_CAPABILITY_MISSING', 'Required capability missing'],
    ['LOCAL_AGENT_PROTOCOL_UNAVAILABLE', 'Required protocol unavailable'],
  ])('shows a stable reason for %s', (incompatibilityReason, label) => {
    setLocale('en')
    const state = catalogFor({
      kind: 'codex',
      installed: true,
      available: false,
      credentialState: 'ready',
      compatibilityState: 'incompatible',
      incompatibilityReason,
    })

    expect(state.label).toBe(label)
    expect(state.tone).toBe('warning')
  })

  it('distinguishes a timed-out probe from an absent or incompatible installation', () => {
    setLocale('en')
    const state = catalogFor({
      kind: 'workbuddy', installed: true, available: false, credentialState: 'ready',
      compatibilityState: 'unknown', incompatibilityReason: 'LOCAL_AGENT_CAPABILITY_PROBE_TIMEOUT',
    })
    expect(state.label).toBe('Detection timed out; retry')
  })

  describe('explaining why an installed Agent is unavailable', () => {
    function noteFor(agent) {
      setLocale('en')
      const catalog = useAgentCatalog({
        activeGroup: ref(null),
        directGroupsFor: () => [],
        installCatalog: ref({ agents: [] }),
        snapshot: ref({ agents: [agent] }),
        t,
        theme: ref('light'),
      })
      return catalog.agentStateNote(catalog.mergedCatalog.value.find(item => item.kind === agent.kind))
    }

    it('names the installed version, the verified range, and why the CLI failed its startup check', () => {
      const note = noteFor({
        kind: 'workbuddy', installed: true, available: false,
        resolvedVersion: '2.161.0', supportedVersionRange: '2.115.0..2.132.0',
        compatibilityState: 'incompatible', incompatibilityReason: 'LOCAL_AGENT_REQUIRED_CAPABILITY_MISSING',
      })
      expect(note).toContain('2.161.0')
      expect(note).toContain('did not pass the startup check')
      expect(note).toContain('Verified versions: 2.115.0..2.132.0.')
    })

    it('distinguishes an unsupported version, a missing sign-in, and a detection timeout', () => {
      expect(noteFor({
        kind: 'codex', installed: true, available: false, resolvedVersion: '9.0.0',
        supportedVersionRange: '0.137.0..0.146.0',
        compatibilityState: 'incompatible', incompatibilityReason: 'LOCAL_AGENT_VERSION_UNSUPPORTED',
      })).toContain('outside the range Meldwork has verified')
      expect(noteFor({
        kind: 'codex', installed: true, available: false, credentialState: 'missing',
      })).toContain('finish signing in')
      expect(noteFor({
        kind: 'codex', installed: true, available: false,
        incompatibilityReason: 'LOCAL_AGENT_CAPABILITY_PROBE_TIMEOUT',
      })).toContain('Detection timed out')
    })

    it('sends a cloud Agent to its server to sign in, not to a local terminal', () => {
      const note = noteFor({
        kind: 'cloud-0123456789abcdef01234567', sourceKind: 'claude', cloud: true,
        installed: true, available: false, credentialState: 'missing',
      })
      expect(note).toContain('cloud Agent')
      expect(note).toContain('on its server')
      expect(note).not.toContain('terminal')
    })

    it('stays silent when there is nothing to explain', () => {
      expect(noteFor({ kind: 'codex', installed: true, available: true })).toBe('')
      expect(noteFor({ kind: 'codex', installed: false, available: false })).toBe('')
      // Without a verified range it still explains, just without the range sentence.
      expect(noteFor({
        kind: 'codex', installed: true, available: false,
        compatibilityState: 'incompatible', incompatibilityReason: 'LOCAL_AGENT_VERSION_UNSUPPORTED',
      })).not.toContain('Verified versions')
    })
  })
})

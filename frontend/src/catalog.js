export function publicAsset(path) {
  return `./${String(path || '').replace(/^\/+/, '')}`
}

export const AGENTS = Object.freeze([
  { kind: 'codex', label: 'Codex', logo: publicAsset('agent-logos/codex.svg'), imageLimit: 4, attachmentTypes: ['file'] },
  { kind: 'claude', label: 'Claude Code', logo: publicAsset('agent-logos/claude.png'), imageLimit: 0, attachmentTypes: ['file'] },
  {
    kind: 'hermes',
    label: 'Hermes',
    logo: publicAsset('agent-logos/hermes.svg'),
    darkLogo: publicAsset('agent-logos/hermes.png'),
    imageLimit: 1,
    attachmentTypes: ['file'],
  },
  { kind: 'workbuddy', label: 'WorkBuddy', logo: publicAsset('agent-logos/workbuddy.png'), imageLimit: 0, attachmentTypes: ['file'] },
  { kind: 'openclaw', label: 'OpenClaw', logo: publicAsset('agent-logos/openclaw-transparent.png'), imageLimit: 0, attachmentTypes: ['file'] },
  // Official asset: https://zcode.z.ai/favicon-192x192.png?v=20260707-transparent
  { kind: 'zcode', label: 'Zcode', logo: publicAsset('agent-logos/zcode.png'), imageLimit: 0, attachmentTypes: ['file'] },
  { kind: 'pi', label: 'Pi Agent', logo: publicAsset('agent-logos/pi.svg'), imageLimit: 0, attachmentTypes: ['file'] },
  { kind: 'opencode', label: 'OpenCode', logo: publicAsset('agent-logos/opencode.svg'), imageLimit: 4, attachmentTypes: ['file'] },
  { kind: 'opencodereview', label: 'OpenCodeReview', logo: publicAsset('agent-logos/opencodereview.svg'), imageLimit: 0 },
  { kind: 'kimi', label: 'Kimi Code', logo: publicAsset('agent-logos/kimi.png'), imageLimit: 0, attachmentTypes: ['file'] },
  { kind: 'mimo', label: 'MiMo Code', logo: publicAsset('agent-logos/mimo.svg'), imageLimit: 0, attachmentTypes: ['file'] },
  { kind: 'qwen', label: 'Qwen Code', logo: publicAsset('agent-logos/qwen.svg'), imageLimit: 0, attachmentTypes: ['file'] },
])

// Detected and runnable, but not in AGENTS: listing it there would show a "Not installed" card to everyone.
const DETECTED_ONLY_AGENTS = Object.freeze([
  { kind: 'gemini', label: 'Gemini CLI', logo: publicAsset('agent-logos/gemini.svg') },
])

const BY_KIND = new Map([...AGENTS, ...DETECTED_ONLY_AGENTS].map(agent => [agent.kind, agent]))
const CUSTOM_BY_KIND = new Map()
const CLOUD_BY_KIND = new Map()
const CUSTOM_AGENT_KIND = /^custom-[a-f0-9]{16}$/
const CLOUD_AGENT_KIND = /^cloud-[a-f0-9]{24}$/
const CUSTOM_AGENT_LOGO = publicAsset('agent-logos/custom-agent.svg')

export function isCloudAgentKind(kind) {
  return CLOUD_AGENT_KIND.test(String(kind || ''))
}

export function setCustomAgentProfiles(profiles = []) {
  CUSTOM_BY_KIND.clear()
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    const kind = String(profile?.kind || '')
    const label = String(profile?.label || '').trim().slice(0, 60)
    if (!CUSTOM_AGENT_KIND.test(kind) || !label || profile?.custom !== true) continue
    CUSTOM_BY_KIND.set(kind, {
      kind,
      label,
      logo: CUSTOM_AGENT_LOGO,
      imageLimit: 0,
      custom: true,
      description: String(profile?.description || '').trim().slice(0, 240),
      commandName: String(profile?.commandName || '').trim().slice(0, 160),
      promptMode: ['stdin', 'argument'].includes(profile?.promptMode) ? profile.promptMode : 'stdin',
    })
  }
}

export function setCloudAgentProfiles(profiles = []) {
  CLOUD_BY_KIND.clear()
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    const kind = String(profile?.kind || '')
    const sourceKind = String(profile?.sourceKind || '')
    if (!CLOUD_AGENT_KIND.test(kind) || !BY_KIND.has(sourceKind) || profile?.cloud !== true) continue
    CLOUD_BY_KIND.set(kind, { ...BY_KIND.get(sourceKind), kind })
  }
}

function agentProfile(kind) {
  return BY_KIND.get(kind) || CUSTOM_BY_KIND.get(kind) || CLOUD_BY_KIND.get(kind)
    || { kind, label: kind || 'Agent', logo: CUSTOM_AGENT_LOGO }
}

export function agentLabel(kind) {
  return agentProfile(kind).label
}

export function agentLogo(kind, displayTheme = '') {
  const profile = agentProfile(kind)
  return displayTheme === 'dark' && profile.darkLogo ? profile.darkLogo : profile.logo
}

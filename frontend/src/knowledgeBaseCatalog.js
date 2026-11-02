import feishuSvg from '../public/knowledge-base-logos/feishu.svg?raw'
import dingtalkSvg from '../public/knowledge-base-logos/dingtalk.svg?raw'
import obsidianSvg from '../public/knowledge-base-logos/obsidian.svg?raw'
import notionSvg from '../public/knowledge-base-logos/notion.svg?raw'
import confluenceSvg from '../public/knowledge-base-logos/confluence.svg?raw'
import googleDriveSvg from '../public/knowledge-base-logos/googledrive.svg?raw'
import sharepointSvg from '../public/knowledge-base-logos/sharepoint.svg?raw'

const logo = svg => `data:image/svg+xml,${encodeURIComponent(svg)}`

function defaultState(accessMode) {
  if (accessMode === 'vault') {
    return {
      installed: false,
      vaultPath: '',
      configured: false,
      readable: false,
      writable: false,
      probeState: 'idle',
      errorCode: '',
    }
  }
  if (accessMode === 'cli') {
    return {
      installed: false,
      commandName: '',
      loginState: 'missing',
      permissionState: 'unknown',
      configured: false,
      readable: false,
      writable: false,
      probeState: 'idle',
      errorCode: '',
    }
  }
  return {
    configured: false,
    connected: false,
    authState: 'missing',
    permissionState: 'unknown',
    readable: false,
    writable: false,
    probeState: 'idle',
    errorCode: '',
  }
}

export const KNOWLEDGE_BASE_CATALOG = Object.freeze([
  {
    kind: 'feishu',
    accessMode: 'cli',
    logo: logo(feishuSvg),
    defaultState: defaultState('cli'),
  },
  {
    kind: 'dingtalk',
    accessMode: 'cli',
    logo: logo(dingtalkSvg),
    defaultState: defaultState('cli'),
  },
  {
    kind: 'obsidian',
    accessMode: 'vault',
    logo: logo(obsidianSvg),
    defaultState: defaultState('vault'),
  },
  {
    kind: 'notion',
    accessMode: 'oauth',
    logo: logo(notionSvg),
    defaultState: defaultState('oauth'),
  },
  {
    kind: 'confluence',
    accessMode: 'oauth',
    logo: logo(confluenceSvg),
    defaultState: defaultState('oauth'),
  },
  {
    kind: 'googledrive',
    accessMode: 'oauth',
    logo: logo(googleDriveSvg),
    defaultState: defaultState('oauth'),
  },
  {
    kind: 'sharepoint',
    accessMode: 'oauth',
    logo: logo(sharepointSvg),
    defaultState: defaultState('oauth'),
  },
])

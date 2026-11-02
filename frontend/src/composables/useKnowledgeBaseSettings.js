import { computed, reactive, ref } from 'vue'
import {
  CheckmarkCircleOutline,
  CloudOutline,
  DownloadOutline,
  RefreshOutline,
  WarningOutline,
} from '@vicons/ionicons5'
import { errorCode } from '../desktop.js'
import { t } from '../i18n.js'
import { KNOWLEDGE_BASE_CATALOG } from '../knowledgeBaseCatalog.js'

const COMING_SOON_KINDS = new Set(['notion', 'confluence', 'googledrive', 'sharepoint'])

export function useKnowledgeBaseSettings({ knowledgeBase, showError }) {
  const sources = ref([])
  const loading = ref(false)
  const refreshingKinds = reactive(new Set())
  let statusPromise = null
  let requestGeneration = 0
  const latestRequestByKind = new Map()

  const sourceMap = computed(() => new Map(sources.value.map(source => [source.kind, source])))
  const entries = computed(() => KNOWLEDGE_BASE_CATALOG.map((definition) => ({
    ...definition,
    ...definition.defaultState,
    ...(sourceMap.value.get(definition.kind) || {}),
    logo: definition.logo,
  })))
  const localEntries = computed(() => entries.value.filter(source => !comingSoon(source)))
  const plannedEntries = computed(() => entries.value.filter(comingSoon))
  const readyCount = computed(() => localEntries.value.filter(ready).length)

  function definition(kind) {
    return KNOWLEDGE_BASE_CATALOG.find(source => source.kind === kind) || null
  }

  function name(kind) {
    const source = definition(kind)
    return source ? t(`knowledgeBase.source.${source.kind}`) : String(kind || '')
  }

  function logo(kind) {
    return definition(kind)?.logo || ''
  }

  function normalizeStatuses(nextSources) {
    const nextSourceMap = new Map((Array.isArray(nextSources) ? nextSources : [])
      .filter(source => source?.kind)
      .map(source => [source.kind, source]))
    return KNOWLEDGE_BASE_CATALOG.map((catalogEntry) => {
      const source = nextSourceMap.get(catalogEntry.kind)
      if (source) {
        return {
          ...source,
          kind: catalogEntry.kind,
          accessMode: source.accessMode || catalogEntry.accessMode,
        }
      }
      return {
        ...catalogEntry.defaultState,
        kind: catalogEntry.kind,
        accessMode: catalogEntry.accessMode,
        probeState: 'unknown',
        errorCode: 'KNOWLEDGE_BASE_STATUS_MISSING',
      }
    })
  }

  function fallbackStatuses(
    fallbackErrorCode = 'KNOWLEDGE_BASE_STATUS_MISSING',
    probeState = 'unknown',
  ) {
    return KNOWLEDGE_BASE_CATALOG.map(source => ({
      ...source.defaultState,
      kind: source.kind,
      accessMode: source.accessMode,
      probeState,
      errorCode: fallbackErrorCode,
    }))
  }

  function beginStatusRequest(selectedKind) {
    const generation = ++requestGeneration
    const kinds = selectedKind
      ? [selectedKind]
      : KNOWLEDGE_BASE_CATALOG.map(source => source.kind)
    for (const kind of kinds) latestRequestByKind.set(kind, generation)
    if (selectedKind) refreshingKinds.add(selectedKind)
    else {
      refreshingKinds.clear()
      loading.value = true
    }
    return generation
  }

  function applyStatusResult(nextSources, selectedKind, generation) {
    const candidates = new Map(normalizeStatuses(nextSources).map(source => [source.kind, source]))
    const nextSourceMap = new Map(sources.value.map(source => [source.kind, source]))
    const kinds = selectedKind
      ? [selectedKind]
      : KNOWLEDGE_BASE_CATALOG.map(source => source.kind)
    for (const kind of kinds) {
      if (latestRequestByKind.get(kind) !== generation) continue
      const source = candidates.get(kind)
      if (source) nextSourceMap.set(kind, source)
    }
    sources.value = KNOWLEDGE_BASE_CATALOG.map((catalogEntry) => (
      nextSourceMap.get(catalogEntry.kind) || {
        ...catalogEntry.defaultState,
        kind: catalogEntry.kind,
        accessMode: catalogEntry.accessMode,
        probeState: 'unknown',
        errorCode: 'KNOWLEDGE_BASE_STATUS_MISSING',
      }
    ))
    return sources.value
  }

  async function loadStatuses(targetKind = '') {
    const selectedKind = String(targetKind || '').trim()
    if (!selectedKind && statusPromise) return statusPromise
    const generation = beginStatusRequest(selectedKind)

    const request = (async () => {
      try {
        if (!knowledgeBase.value?.status) {
          return applyStatusResult(
            fallbackStatuses('LOCAL_KNOWLEDGE_BASE_UNAVAILABLE', 'error'),
            selectedKind,
            generation,
          )
        }
        const nextSources = await knowledgeBase.value.status(selectedKind || undefined)
        return applyStatusResult(nextSources, selectedKind, generation)
      } catch (error) {
        showError(error)
        const fallback = selectedKind
          ? [{
              kind: selectedKind,
              ...(definition(selectedKind)?.defaultState || {}),
              accessMode: definition(selectedKind)?.accessMode || 'cli',
              probeState: 'error',
              errorCode: errorCode(error) || 'KNOWLEDGE_BASE_PROBE_FAILED',
            }]
          : fallbackStatuses(errorCode(error) || 'KNOWLEDGE_BASE_PROBE_FAILED', 'error')
        return applyStatusResult(fallback, selectedKind, generation)
      } finally {
        if (selectedKind) {
          if (latestRequestByKind.get(selectedKind) === generation) refreshingKinds.delete(selectedKind)
        }
        else loading.value = false
      }
    })()

    if (!selectedKind) {
      statusPromise = request
      try {
        return await request
      } finally {
        if (statusPromise === request) statusPromise = null
      }
    }
    return request
  }

  function comingSoon(source) {
    return Boolean(source && COMING_SOON_KINDS.has(source.kind))
  }

  function pending(source) {
    if (!source || comingSoon(source)) return false
    return loading.value
      || refreshingKinds.has(source.kind)
      || ['idle', 'loading'].includes(source.probeState)
  }

  function configured(source) {
    if (!source || comingSoon(source)) return false
    if (source.probeState === 'error' || source.probeState === 'unknown') return false
    if (source.accessMode === 'vault') return Boolean(source.installed && source.vaultPath)
    if (source.accessMode === 'cli') {
      return Boolean(source.installed && source.loginState === 'ready')
    }
    return Boolean(source.configured || source.connected)
  }

  function canRead(source) {
    if (!source || comingSoon(source) || source.probeState !== 'ready') return false
    if (source.accessMode === 'vault') {
      return Boolean(source.installed && source.vaultPath
        && source.vaultDetails?.directory && source.vaultDetails?.readable)
    }
    if (source.accessMode === 'cli') {
      return Boolean(source.installed && source.loginState === 'ready'
        && source.permissionState === 'ready' && source.readable === true)
    }
    return Boolean(configured(source) && source.authState === 'ready'
      && source.permissionState === 'ready' && source.readable !== false)
  }

  function canWrite(source) {
    if (!source || comingSoon(source) || source.probeState !== 'ready') return false
    if (source.accessMode === 'vault') {
      return Boolean(source.installed && source.vaultPath
        && source.vaultDetails?.directory && source.vaultDetails?.writable)
    }
    if (source.accessMode === 'cli') {
      return Boolean(source.installed && source.loginState === 'ready'
        && source.permissionState === 'ready' && source.writable === true)
    }
    return Boolean(configured(source) && source.authState === 'ready'
      && source.permissionState === 'ready' && source.writable !== false)
  }

  function ready(source) {
    if (!source || comingSoon(source) || source.probeState !== 'ready') return false
    if (source.accessMode === 'vault') {
      return Boolean(source.installed && source.vaultPath && source.vaultDetails?.directory
        && source.vaultDetails?.readable && source.vaultDetails?.writable)
    }
    if (source.accessMode === 'cli') return canRead(source)
    return Boolean(source.configured && source.authState === 'ready'
      && source.permissionState === 'ready' && canRead(source) && canWrite(source))
  }

  function modeLabel(source) {
    const key = {
      cli: 'cli',
      vault: 'vault',
      oauth: 'oauth',
      token: 'apiToken',
    }[source?.accessMode] || 'cli'
    return t(`knowledgeBase.tag.mode.${key}`)
  }

  function tone(source) {
    if (!source) return 'checking'
    if (comingSoon(source) || pending(source)) return 'checking'
    if (source.probeState === 'error') return 'warning'
    if (source.probeState === 'unknown') return 'checking'
    if (ready(source)) return 'connected'
    if (source.accessMode === 'vault') return source.installed ? 'warning' : 'checking'
    if (source.accessMode === 'cli') {
      if (!source.installed) return 'warning'
      if (source.loginState === 'missing' || source.permissionState === 'needs-grant') return 'warning'
      return 'checking'
    }
    return configured(source) ? 'checking' : 'warning'
  }

  function icon(source) {
    if (!source) return RefreshOutline
    if (comingSoon(source)) return CloudOutline
    if (pending(source)) return RefreshOutline
    if (source.probeState === 'unknown') return WarningOutline
    if (ready(source)) return CheckmarkCircleOutline
    if (source.probeState === 'error') return WarningOutline
    if (source.accessMode === 'vault') return source.installed ? WarningOutline : DownloadOutline
    if (source.accessMode === 'cli') {
      if (!source.installed) return DownloadOutline
      return source.loginState === 'missing' || source.permissionState === 'needs-grant'
        ? WarningOutline
        : RefreshOutline
    }
    if (!configured(source)) return CloudOutline
    if (source.authState === 'missing' || source.permissionState === 'needs-grant') return WarningOutline
    return RefreshOutline
  }

  function statusLabel(source) {
    if (!source) return ''
    if (comingSoon(source)) return t('knowledgeBase.status.comingSoon')
    if (pending(source)) return t('knowledgeBase.status.checking')
    if (source.probeState === 'error') return t('knowledgeBase.status.error')
    if (source.probeState === 'unknown') return t('knowledgeBase.status.unknown')
    if (ready(source)) return t('knowledgeBase.status.ready')
    if (source.accessMode === 'vault') {
      if (!source.installed) return t('knowledgeBase.status.obsidianMissing')
      if (!source.vaultPath) return t('knowledgeBase.status.obsidianNeedVault')
      if (!source.vaultDetails?.directory
          || !source.vaultDetails?.readable || !source.vaultDetails?.writable) {
        return t('knowledgeBase.status.needsPermission')
      }
      return t('knowledgeBase.status.ready')
    }
    if (source.accessMode === 'cli') {
      if (!source.installed) return t('knowledgeBase.status.cliMissing')
      if (source.loginState === 'missing') return t('knowledgeBase.status.needsLogin')
      if (source.permissionState === 'needs-grant') return t('knowledgeBase.status.needsPermission')
      if (source.loginState === 'ready' && source.permissionState === 'ready') {
        return t('knowledgeBase.status.ready')
      }
      if (source.loginState === 'unknown' || source.permissionState === 'unknown') {
        return t('knowledgeBase.status.unknown')
      }
      return t('knowledgeBase.status.checking')
    }
    if (!configured(source)) return t('knowledgeBase.status.notConfigured')
    if (source.authState === 'missing') return t('knowledgeBase.status.needsLogin')
    if (source.permissionState === 'needs-grant') return t('knowledgeBase.status.needsPermission')
    if (source.authState === 'unknown' || source.permissionState === 'unknown') {
      return t('knowledgeBase.status.unknown')
    }
    if (ready(source)) return t('knowledgeBase.status.ready')
    return t('knowledgeBase.status.checking')
  }

  function tagItems(source) {
    if (!source) return []
    return [{ key: 'mode', label: modeLabel(source), tone: 'mode' }]
  }

  function primaryActionLabel(source) {
    if (!source) return ''
    if (comingSoon(source)) return t('knowledgeBase.action.viewDocumentation')
    if (pending(source)) return t('knowledgeBase.status.checking')
    if (source.probeState === 'error' || source.probeState === 'unknown') {
      return t('knowledgeBase.action.recheck')
    }
    if (source.accessMode === 'vault') {
      if (!source.installed) return t('knowledgeBase.action.installObsidian')
      if (!source.vaultPath) return t('knowledgeBase.action.pickDirectory')
      return t('knowledgeBase.action.changeDirectory')
    }
    if (source.accessMode === 'cli') {
      if (!source.installed) return t('knowledgeBase.action.installCli')
      if (source.loginState === 'missing') return t('knowledgeBase.action.goLogin')
      if (source.permissionState === 'needs-grant') return t('knowledgeBase.action.grantPermission')
      return t('knowledgeBase.action.recheck')
    }
    if (!configured(source)) return t('knowledgeBase.action.openSetupGuide')
    if (source.authState === 'missing') return t('knowledgeBase.action.goLogin')
    if (source.permissionState === 'needs-grant') return t('knowledgeBase.action.grantPermission')
    return t('knowledgeBase.action.recheck')
  }

  function locationLabel(source) {
    return source?.accessMode === 'vault' ? source.vaultPath || '' : ''
  }

  async function runPrimaryAction(source) {
    if (!source || !knowledgeBase.value || pending(source) || comingSoon(source)) return
    if (source.probeState === 'error' || source.probeState === 'unknown') {
      await loadStatuses(source.kind)
      return
    }
    if (source.accessMode === 'vault') {
      if (!source.installed) {
        await knowledgeBase.value.openGuide?.(source.kind, 'install')
        return
      }
      try {
        const next = await knowledgeBase.value.pickObsidianVault?.()
        if (Array.isArray(next)) sources.value = next
        else await loadStatuses()
      } catch (error) {
        showError(error)
      }
      return
    }
    if (source.accessMode === 'cli') {
      if (!source.installed) {
        await knowledgeBase.value.openGuide?.(source.kind, 'install')
        return
      }
      if (source.loginState === 'missing') {
        await knowledgeBase.value.openGuide?.(source.kind, 'login')
        return
      }
      if (source.permissionState === 'needs-grant') {
        await knowledgeBase.value.openGuide?.(source.kind, 'permission')
        return
      }
      await loadStatuses(source.kind)
      return
    }
    if (!configured(source)) {
      await knowledgeBase.value.openGuide?.(source.kind, 'install')
      return
    }
    if (source.authState === 'missing') {
      await knowledgeBase.value.openGuide?.(source.kind, 'login')
      return
    }
    if (source.permissionState === 'needs-grant') {
      await knowledgeBase.value.openGuide?.(source.kind, 'permission')
      return
    }
    await loadStatuses(source.kind)
  }

  return {
    knowledgeBaseIcon: icon,
    knowledgeBaseLoading: loading,
    knowledgeBaseLocationLabel: locationLabel,
    knowledgeBaseLogo: logo,
    knowledgeBaseName: name,
    knowledgeBasePending: pending,
    knowledgeBasePrimaryActionLabel: primaryActionLabel,
    knowledgeBaseReady: ready,
    knowledgeBaseStatusLabel: statusLabel,
    knowledgeBaseTagItems: tagItems,
    knowledgeBaseTone: tone,
    loadKnowledgeBaseStatuses: loadStatuses,
    localKnowledgeBaseEntries: localEntries,
    plannedKnowledgeBaseEntries: plannedEntries,
    readyKnowledgeBaseCount: readyCount,
    runKnowledgeBasePrimaryAction: runPrimaryAction,
  }
}

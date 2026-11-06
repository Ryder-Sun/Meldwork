import { computed, ref } from 'vue'
import { errorCode } from '../desktop.js'
import { useAttachmentPreviews } from './useAttachmentPreviews.js'

export const MAX_ATTACHMENTS = 32

const MAX_ATTACHMENT_BYTES = 128 * 1024 * 1024
const ATTACHMENT_TYPES = new Set(['image', 'audio', 'video', 'file'])
const MIME_BY_EXTENSION = new Map([
  ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'], ['webp', 'image/webp'],
  ['mp3', 'audio/mpeg'], ['wav', 'audio/wav'], ['m4a', 'audio/mp4'],
  ['mp4', 'video/mp4'], ['mov', 'video/quicktime'], ['webm', 'video/webm'],
    ['pdf', 'application/pdf'], ['txt', 'text/plain'], ['md', 'text/markdown'],
    ['markdown', 'text/markdown'], ['csv', 'text/csv'], ['json', 'application/json'],
    ['rtf', 'application/rtf'],
    ...[
      'html', 'htm', 'xml', 'yaml', 'yml', 'toml', 'ini', 'conf', 'config', 'log',
      'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'css', 'scss', 'sass', 'less', 'vue',
      'svelte', 'py', 'pyi', 'java', 'kt', 'kts', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp',
      'cs', 'go', 'rs', 'rb', 'php', 'sh', 'bash', 'zsh', 'fish', 'sql', 'graphql',
      'gql', 'proto', 'swift', 'dart', 'lua', 'r', 'rmd', 'tex', 'bib', 'svg', 'jsonl',
      'ndjson', 'diff', 'patch', 'properties', 'gradle', 'tf', 'hcl', 'sol', 'plist',
    ].map(extension => [extension, 'text/plain']),
    ['mdx', 'text/markdown'], ['ipynb', 'application/json'], ['geojson', 'application/json'],
    ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['doc', 'application/msword'], ['xls', 'application/vnd.ms-excel'],
    ['ppt', 'application/vnd.ms-powerpoint'],
    ...['zip', 'pages', 'numbers', 'key', 'odt', 'ods', 'odp', 'epub']
      .map(extension => [extension, 'application/zip']),
    ['gz', 'application/gzip'], ['tgz', 'application/gzip'],
    ['tar', 'application/x-tar'], ['7z', 'application/x-7z-compressed'],
])
const SUPPORTED_MIME_TYPES = new Set(MIME_BY_EXTENSION.values())

export function useComposerAttachments({
  activeGroup,
  attachmentsApi,
  composerDisabled,
  composerContextVersion,
  composerTargetKinds,
  mergedCatalog,
  notify,
  showError,
  t,
}) {
  const composerAttachments = ref([])
  const attachmentImportOperations = ref([])
  const composerDropActive = ref(false)
  let attachmentImportSequence = 0
  let composerDragDepth = 0

  function attachmentKind(attachment) {
    const mimeType = String(attachment?.mimeType || '').toLowerCase()
    if (mimeType.startsWith('image/')) return 'image'
    if (mimeType.startsWith('audio/')) return 'audio'
    if (mimeType.startsWith('video/')) return 'video'
    return 'file'
  }

  function normalizeAttachment(attachment) {
    const id = String(attachment?.id || '')
    const name = String(attachment?.name || '')
    const mimeType = String(attachment?.mimeType || '')
    const size = Number(attachment?.size || 0)
    const previewDataUrl = String(attachment?.previewDataUrl || '')
    const kind = attachmentKind({ mimeType })
    if (!id || !name || !ATTACHMENT_TYPES.has(kind)) return null
    return {
      id,
      name,
      mimeType,
      size: Number.isFinite(size) ? size : 0,
      ...(previewDataUrl ? { previewDataUrl } : {}),
    }
  }

  function fileMimeType(file) {
    const declared = String(file?.type || '').split(';', 1)[0].trim().toLowerCase()
    const normalized = declared === 'image/jpg'
      ? 'image/jpeg'
      : (['text/rtf', 'application/x-rtf'].includes(declared) ? 'application/rtf' : declared)
    if (SUPPORTED_MIME_TYPES.has(normalized)) return normalized
    const extension = String(file?.name || '').split('.').pop()?.toLowerCase() || ''
    return MIME_BY_EXTENSION.get(extension) || normalized
  }

  const {
    attachmentPreviewUrl,
    forgetAttachmentPreviews,
    rememberAttachmentPreview,
    vAttachmentPreview,
  } = useAttachmentPreviews({
    api: () => attachmentsApi.value,
    normalize: normalizeAttachment,
  })

  const importingAttachment = computed(() => attachmentImportOperations.value
    .some(operation => operation.contextVersion === composerContextVersion.value))
  function attachmentLimitFor(type) {
    const normalizedType = String(type || '')
    if (!ATTACHMENT_TYPES.has(normalizedType)) return 0
    const targets = composerTargetKinds.value
    if (!targets.length) return 0
    const limits = targets.map((kind) => {
      const agent = mergedCatalog.value.find(item => item.kind === kind)
      const attachmentTypes = Array.isArray(agent?.attachmentTypes) ? agent.attachmentTypes : []
      const nativeLimit = attachmentTypes.includes(normalizedType)
        ? MAX_ATTACHMENTS
        : (normalizedType === 'image'
        ? Math.max(0, Math.floor(Number(agent?.imageLimit) || 0))
        : 0)
      const fileFallbackLimit = !agent?.connector && attachmentTypes.includes('file') ? MAX_ATTACHMENTS : 0
      return Math.max(nativeLimit, fileFallbackLimit)
    })
    return Math.min(MAX_ATTACHMENTS, ...limits)
  }

  const composerAttachmentLimit = computed(() => Math.max(
    ...[...ATTACHMENT_TYPES].map(type => attachmentLimitFor(type)),
  ))
  const composerAttachmentSupported = computed(() => composerAttachments.value.every((attachment) => {
    const type = attachmentKind(attachment)
    if (!ATTACHMENT_TYPES.has(type)) return false
    return composerAttachments.value.filter(item => attachmentKind(item) === type).length <= attachmentLimitFor(type)
  }))
  const attachmentActionLabel = computed(() => {
    if (!composerTargetKinds.value.length) return t('composer.selectTarget')
    return composerAttachmentLimit.value > 0 ? t('composer.attachMedia') : t('composer.attachmentsUnsupported')
  })

  function uniqueFiles(values) {
    return [...new Map(Array.from(values || [])
      .filter(Boolean)
      .map(file => [`${file.name}:${file.size}:${file.lastModified}:${file.type}`, file])).values()]
  }

  function transferFiles(dataTransfer) {
    return uniqueFiles([
      ...Array.from(dataTransfer?.files || []),
      ...Array.from(dataTransfer?.items || [])
        .filter(item => item?.kind === 'file')
        .map(item => item.getAsFile?.())
        .filter(Boolean),
    ])
  }

  function safeAttachmentPayload(attachment) {
    return {
      id: String(attachment.id),
      name: String(attachment.name),
      mimeType: String(attachment.mimeType),
      size: Number(attachment.size) || 0,
    }
  }

  function messageAttachments(message) {
    return Array.isArray(message?.attachments) ? message.attachments : []
  }

  function isImageAttachment(attachment) {
    return attachmentKind(attachment) === 'image'
  }

  function attachmentMediaUrl(attachment) {
    const id = String(attachment?.id || '')
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)
        || !['image', 'audio', 'video'].includes(attachmentKind(attachment))) return ''
    return `meldwork-media://attachment/${id}`
  }

  function attachmentTypeLabel(attachment) {
    const extension = String(attachment?.name || '').split('.').pop()?.toUpperCase() || ''
    if (/^[A-Z0-9]{1,8}$/.test(extension)) return extension
    return String(attachment?.mimeType || 'FILE').split('/').pop()?.toUpperCase() || 'FILE'
  }

  function formatAttachmentSize(attachment) {
    const size = Math.max(0, Number(attachment?.size) || 0)
    if (size < 1024) return `${size} B`
    if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
    return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`
  }

  async function openAttachment(attachment) {
    const open = attachmentsApi.value?.open
    if (typeof open !== 'function') {
      notify(t('composer.attachmentsUnavailable'))
      return
    }
    try { await open(String(attachment?.id || '')) } catch (error) { showError(error) }
  }

  async function discardAttachments(values) {
    if (typeof attachmentsApi.value?.discard !== 'function') return
    const ids = [...new Set(values
      .map(value => String(typeof value === 'string' ? value : value?.id || ''))
      .filter(Boolean))]
    if (!ids.length) return
    try {
      const result = await attachmentsApi.value.discard(ids)
      forgetAttachmentPreviews(Array.isArray(result?.discardedIds) ? result.discardedIds : [])
    } catch (error) {
      console.error('[Meldwork]', errorCode(error))
    }
  }

  function attachmentLimitMessage(type = '') {
    const limit = ATTACHMENT_TYPES.has(type)
      ? attachmentLimitFor(type)
      : composerAttachmentLimit.value
    if (limit <= 0 && composerAttachmentLimit.value <= 0) {
      return t('composer.attachmentsUnsupported')
    }
    return limit < MAX_ATTACHMENTS
      ? t('composer.attachmentTypeLimit')
      : t('composer.attachmentLimit')
  }

  function addAttachments(values) {
    const normalized = values.map(normalizeAttachment).filter(Boolean)
    normalized.forEach(rememberAttachmentPreview)
    const existingIds = new Set(composerAttachments.value.map(attachment => attachment.id))
    const available = normalized.filter(attachment => !existingIds.has(attachment.id))
    const counts = new Map([...ATTACHMENT_TYPES].map(type => [
      type,
      composerAttachments.value.filter(attachment => attachmentKind(attachment) === type).length,
    ]))
    const accepted = []
    const overflow = []
    for (const attachment of available) {
      const type = attachmentKind(attachment)
      const used = counts.get(type) || 0
      if (used >= attachmentLimitFor(type) || accepted.length + composerAttachments.value.length >= MAX_ATTACHMENTS) {
        overflow.push(attachment)
        continue
      }
      counts.set(type, used + 1)
      accepted.push(attachment)
    }
    composerAttachments.value = [...composerAttachments.value, ...accepted]
    if (overflow.length) {
      notify(attachmentLimitMessage(attachmentKind(overflow[0])))
      void discardAttachments(overflow)
    }
  }

  function beginAttachmentImport() {
    const groupId = String(activeGroup.value?.id || '')
    if (!groupId) return null
    const operation = {
      id: ++attachmentImportSequence,
      groupId,
      contextVersion: composerContextVersion.value,
    }
    attachmentImportOperations.value = [...attachmentImportOperations.value, operation]
    return operation
  }

  function finishAttachmentImport(operation) {
    attachmentImportOperations.value = attachmentImportOperations.value.filter(item => item.id !== operation.id)
  }

  function attachmentImportIsCurrent(operation) {
    return operation.contextVersion === composerContextVersion.value
      && operation.groupId === String(activeGroup.value?.id || '')
  }

  function removeAttachment(id) {
    composerAttachments.value = composerAttachments.value.filter(attachment => attachment.id !== id)
    void discardAttachments([id])
  }

  async function pickAttachments() {
    const pick = attachmentsApi.value?.pickAttachments
    if (typeof pick !== 'function') {
      notify(t('composer.attachmentsUnavailable'))
      return
    }
    if (!composerTargetKinds.value.length) {
      notify(t('composer.selectTarget'))
      return
    }
    if (composerAttachmentLimit.value <= 0) {
      notify(t('composer.attachmentsUnsupported'))
      return
    }
    const remainingCapacity = Math.min(
      Math.max(0, MAX_ATTACHMENTS - composerAttachments.value.length),
      composerAttachmentLimit.value,
    )
    if (!remainingCapacity) {
      notify(attachmentLimitMessage())
      return
    }
    const operation = beginAttachmentImport()
    if (!operation) return
    try {
      const result = await pick(remainingCapacity)
      const values = Array.isArray(result) ? result : (Array.isArray(result?.attachments) ? result.attachments : [])
      if (attachmentImportIsCurrent(operation)) {
        addAttachments(values)
        if (result?.truncated) notify(attachmentLimitMessage())
      } else {
        void discardAttachments(values)
      }
    } catch (error) {
      if (attachmentImportIsCurrent(operation)) showError(error)
    } finally {
      finishAttachmentImport(operation)
    }
  }

  async function importFiles(inputFiles) {
    const importAttachment = attachmentsApi.value?.importAttachment
    if (typeof importAttachment !== 'function') return
    const files = uniqueFiles(inputFiles)
    if (!files.length) return
    if (importingAttachment.value) {
      notify(t('composer.attachmentImporting'))
      return
    }
    if (!composerTargetKinds.value.length) {
      notify(t('composer.selectTarget'))
      return
    }
    const room = Math.max(0, MAX_ATTACHMENTS - composerAttachments.value.length)
    if (!room) {
      notify(attachmentLimitMessage())
      return
    }
    if (files.length > room) notify(attachmentLimitMessage())
    const operation = beginAttachmentImport()
    if (!operation) return
    try {
      const imported = []
      const attachmentCounts = new Map([...ATTACHMENT_TYPES].map(type => [
        type,
        composerAttachments.value.filter(attachment => attachmentKind(attachment) === type).length,
      ]))
      for (const file of files.slice(0, room)) {
        if (!attachmentImportIsCurrent(operation)) break
        try {
          const mimeType = fileMimeType(file)
          const type = attachmentKind({ mimeType })
          if (!ATTACHMENT_TYPES.has(type) || (attachmentCounts.get(type) || 0) >= attachmentLimitFor(type)) {
            notify(attachmentLimitMessage(type))
            continue
          }
          if (Number(file.size) > MAX_ATTACHMENT_BYTES) {
            throw Object.assign(new Error('LOCAL_ATTACHMENT_TOO_LARGE'), {
              code: 'LOCAL_ATTACHMENT_TOO_LARGE',
            })
          }
          const bytes = new Uint8Array(await file.arrayBuffer())
          const attachment = await importAttachment({
            name: String(file.name || t('composer.pastedAttachment')),
            mimeType,
            bytes,
          })
          if (!attachmentImportIsCurrent(operation)) {
            void discardAttachments([attachment])
            break
          }
          imported.push(attachment)
          attachmentCounts.set(type, (attachmentCounts.get(type) || 0) + 1)
        } catch (error) {
          if (attachmentImportIsCurrent(operation)) showError(error)
        }
      }
      if (attachmentImportIsCurrent(operation)) addAttachments(imported)
      else void discardAttachments(imported)
    } finally {
      finishAttachmentImport(operation)
    }
  }

  async function handleComposerPaste(event) {
    const files = uniqueFiles([
      ...Array.from(event.clipboardData?.files || []),
      ...Array.from(event.clipboardData?.items || [])
        .filter(item => item.kind === 'file')
        .map(item => item.getAsFile?.())
        .filter(Boolean),
    ])
    if (!files.length) return
    event.preventDefault()
    await importFiles(files)
  }

  function hasDraggedFiles(event) {
    const dataTransfer = event?.dataTransfer
    if (!dataTransfer) return false
    if (Array.from(dataTransfer.files || []).length > 0
        || Array.from(dataTransfer.items || []).some(item => item?.kind === 'file')) return true
    return Array.from(dataTransfer.types || []).some((type) => {
      const normalized = String(type || '').toLowerCase()
      return normalized === 'files'
        || normalized === 'application/x-moz-file'
        || normalized === 'public.file-url'
    })
  }

  function handleComposerDragEnter(event) {
    if (!hasDraggedFiles(event)) return
    event.preventDefault()
    composerDragDepth += 1
    if (!composerDisabled?.value) composerDropActive.value = true
  }

  function handleComposerDragOver(event) {
    if (!hasDraggedFiles(event)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  }

  function handleComposerDragLeave(event) {
    if (!composerDragDepth) return
    event.preventDefault()
    composerDragDepth = Math.max(0, composerDragDepth - 1)
    if (!composerDragDepth) composerDropActive.value = false
  }

  async function handleComposerDrop(event) {
    if (!hasDraggedFiles(event)) return
    event.preventDefault()
    composerDragDepth = 0
    composerDropActive.value = false
    if (composerDisabled?.value) return
    await importFiles(transferFiles(event.dataTransfer))
  }

  return {
    attachmentActionLabel,
    attachmentKind,
    attachmentLimitMessage,
    attachmentMediaUrl,
    attachmentPreviewUrl,
    attachmentTypeLabel,
    composerAttachmentLimit,
    composerAttachmentSupported,
    composerAttachments,
    composerDropActive,
    discardAttachments,
    formatAttachmentSize,
    handleComposerDragEnter,
    handleComposerDragLeave,
    handleComposerDragOver,
    handleComposerDrop,
    handleComposerPaste,
    importingAttachment,
    isImageAttachment,
    messageAttachments,
    openAttachment,
    pickAttachments,
    removeAttachment,
    safeAttachmentPayload,
    vAttachmentPreview,
  }
}

const fs = require('node:fs')

const {
  assertImagePixelLimit,
  inspectImageDimensions,
} = require('./image-dimensions.cjs')

const MEDIA_SCHEME = 'meldwork-media'
const ATTACHMENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const MAX_ATTACHMENT_PICK_REQUEST = 32
const MAX_ATTACHMENT_DISCARD_REQUEST = 32

function attachmentIdsFromSnapshot(snapshot, groupId = '') {
  const ids = []
  for (const task of snapshot?.deliveryTasks || []) {
    if (groupId && task.groupId !== groupId) continue
    for (const version of task.versions) {
      for (const attachment of version.attachments) ids.push(attachment.id)
    }
    for (const attempt of task.attempts) {
      for (const source of attempt.sources) if (source.attachmentId) ids.push(source.attachmentId)
    }
  }
  for (const message of Array.isArray(snapshot?.messages) ? snapshot.messages : []) {
    if (groupId && message?.groupId !== groupId) continue
    for (const attachment of Array.isArray(message?.attachments) ? message.attachments : []) {
      if (typeof attachment?.id === 'string' && ATTACHMENT_ID.test(attachment.id)) {
        ids.push(attachment.id)
      }
    }
  }
  return [...new Set(ids)]
}

function persistedAttachmentReferences(storagePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(storagePath, 'utf8'))
    if (![1, 2, 3].includes(parsed?.version) || !Array.isArray(parsed.groups)
        || !Array.isArray(parsed.messages) || typeof parsed.sessions !== 'object') {
      return null
    }
    return attachmentIdsFromSnapshot(parsed)
  } catch (error) {
    return error.code === 'ENOENT' ? [] : null
  }
}

function normalizeDiscardIds(value, maxIds = MAX_ATTACHMENT_DISCARD_REQUEST) {
  if (!Array.isArray(value)) throw new Error('LOCAL_ATTACHMENT_REFERENCE_INVALID')
  if (value.length > maxIds) throw new Error('LOCAL_ATTACHMENT_COUNT_LIMIT')
  const ids = value.map((id) => {
    if (typeof id !== 'string' || !ATTACHMENT_ID.test(id)) {
      throw new Error('LOCAL_ATTACHMENT_ID_INVALID')
    }
    return id
  })
  return [...new Set(ids)]
}

function mediaRequestId(value) {
  try {
    const target = new URL(value)
    const id = decodeURIComponent(target.pathname.replace(/^\//, ''))
    if (target.protocol !== `${MEDIA_SCHEME}:` || target.hostname !== 'attachment'
        || target.username || target.password || target.port || target.search || target.hash
        || !ATTACHMENT_ID.test(id)) {
      return ''
    }
    return id
  } catch {
    return ''
  }
}

function mediaByteRange(value, size) {
  if (!value) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(value).trim())
  if (!match || (!match[1] && !match[2])) return false
  let start
  let end
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Number(match[2]) : size - 1
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || start >= size || end < start) return false
  return { start, end: Math.min(end, size - 1) }
}

function normalizeAttachmentPickLimit(value) {
  if (value == null) return MAX_ATTACHMENT_PICK_REQUEST
  const limit = Number(value)
  if (!Number.isFinite(limit)) return MAX_ATTACHMENT_PICK_REQUEST
  return Math.max(1, Math.min(MAX_ATTACHMENT_PICK_REQUEST, Math.floor(limit)))
}

function createAttachmentService({ getStore, getSnapshot, nativeImage, openPath }) {
  function availableStore() {
    const store = getStore()
    if (!store) throw new Error('LOCAL_ATTACHMENT_STORAGE_UNAVAILABLE')
    return store
  }

  function discardUnreferenced(value, maxIds = MAX_ATTACHMENT_DISCARD_REQUEST) {
    const store = availableStore()
    const ids = normalizeDiscardIds(value, maxIds)
    const referenced = new Set(attachmentIdsFromSnapshot(getSnapshot()))
    const retainedIds = ids.filter(id => referenced.has(id))
    const discardedIds = ids.filter(id => !referenced.has(id))
    if (discardedIds.length) store.discard(discardedIds)
    return { discardedIds, retainedIds }
  }

  function preview(id) {
    const { metadata, bytes } = availableStore().readWithMetadata(id)
    const attachment = {
      id: metadata.id,
      name: metadata.name,
      mimeType: metadata.mimeType,
      size: metadata.size,
    }
    if (!metadata.mimeType.startsWith('image/')) return attachment
    if (metadata.mimeType !== 'image/png' && metadata.mimeType !== 'image/jpeg') return attachment
    inspectImageDimensions(bytes)
    const source = nativeImage.createFromBuffer(bytes)
    if (source.isEmpty()) throw new Error('LOCAL_ATTACHMENT_TYPE_UNSUPPORTED')
    const { width, height } = source.getSize()
    assertImagePixelLimit({ width, height })
    const scale = Math.min(1, 320 / Math.max(width, height))
    const resized = scale < 1
      ? source.resize({
          width: Math.max(1, Math.round(width * scale)),
          height: Math.max(1, Math.round(height * scale)),
          quality: 'good',
        })
      : source
    const previewDataUrl = resized.toDataURL()
    if (!previewDataUrl.startsWith('data:image/png;base64,')
        || previewDataUrl.length > 2 * 1024 * 1024) {
      throw new Error('LOCAL_ATTACHMENT_TYPE_UNSUPPORTED')
    }
    return { ...attachment, previewDataUrl }
  }

  function mediaResponse(request) {
    const id = mediaRequestId(request?.url)
    if (!id) return new Response(null, { status: 404 })
    let entry
    try { entry = availableStore().readWithMetadata(id) } catch { return new Response(null, { status: 404 }) }
    const { metadata, bytes } = entry
    if (!/^(?:image|audio|video)\//.test(metadata.mimeType) || bytes.length !== metadata.size) {
      return new Response(null, { status: 415 })
    }
    const range = mediaByteRange(request?.headers?.get?.('range'), bytes.length)
    if (range === false) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${bytes.length}` },
      })
    }
    const body = range ? bytes.subarray(range.start, range.end + 1) : bytes
    const headers = {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=31536000, immutable',
      'Content-Length': String(body.length),
      'Content-Type': metadata.mimeType,
      'X-Content-Type-Options': 'nosniff',
    }
    if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${bytes.length}`
    return new Response(body, { status: range ? 206 : 200, headers })
  }

  function importBuffer(input) {
    const store = availableStore()
    const metadata = store.importBuffer(input)
    try {
      return preview(metadata.id)
    } catch (error) {
      try { store.discard([metadata]) } catch { /* best effort */ }
      throw error
    }
  }

  function importFiles(filenames) {
    if (filenames.length > MAX_ATTACHMENT_PICK_REQUEST) {
      throw new Error('LOCAL_ATTACHMENT_COUNT_LIMIT')
    }
    const store = availableStore()
    const imported = []
    try {
      for (const filename of filenames) {
        const metadata = store.importFile(filename)
        imported.push(metadata)
      }
      return imported.map(metadata => preview(metadata.id))
    } catch (error) {
      if (imported.length) {
        try { store.discard(imported) } catch { /* best effort */ }
      }
      throw error
    }
  }

  async function open(id) {
    if (typeof openPath !== 'function') throw new Error('LOCAL_ATTACHMENT_OPEN_UNAVAILABLE')
    const [entry] = availableStore().resolve([String(id || '')])
    const result = await openPath(entry.path)
    if (result) throw new Error('LOCAL_ATTACHMENT_OPEN_FAILED')
    return true
  }

  return {
    availableStore,
    discardUnreferenced,
    importBuffer,
    importFiles,
    normalizePickLimit: normalizeAttachmentPickLimit,
    open,
    preview,
    registerProtocol: protocol => protocol?.handle?.(MEDIA_SCHEME, request => mediaResponse(request)),
  }
}

module.exports = {
  MEDIA_SCHEME,
  attachmentIdsFromSnapshot,
  createAttachmentService,
  persistedAttachmentReferences,
}

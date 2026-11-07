const crypto = require('node:crypto')
const path = require('node:path')

const STORE_VERSION = 2
const ATTACHMENT_CHUNK_BYTES = 256 * 1024
const MAX_ATTACHMENT_BYTES = 128 * 1024 * 1024
const MAX_ATTACHMENTS = 4
const MAX_METADATA_BYTES = 64 * 1024
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024
const MAX_TEXT_BYTES = 8 * 1024 * 1024
const TEXT_FILE_EXTENSIONS = Object.freeze([
  'txt', 'html', 'htm', 'xml', 'yaml', 'yml', 'toml', 'ini', 'conf', 'config', 'log',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'css', 'scss', 'sass', 'less', 'vue', 'svelte',
  'py', 'pyi', 'java', 'kt', 'kts', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'cs', 'go',
  'rs', 'rb', 'php', 'sh', 'bash', 'zsh', 'fish', 'sql', 'graphql', 'gql', 'proto',
  'swift', 'dart', 'lua', 'r', 'rmd', 'tex', 'bib', 'svg', 'jsonl', 'ndjson', 'diff',
  'patch', 'properties', 'gradle', 'tf', 'hcl', 'sol', 'plist',
])
const ZIP_FILE_EXTENSIONS = Object.freeze([
  'zip', 'pages', 'numbers', 'key', 'odt', 'ods', 'odp', 'epub',
])
const GZIP_FILE_EXTENSIONS = Object.freeze(['gz', 'tgz'])

const ATTACHMENT_TYPES = Object.freeze([
  Object.freeze({ mimeType: 'image/png', extension: 'png', maxBytes: 8 * 1024 * 1024, storageBase: 'image' }),
  Object.freeze({ mimeType: 'image/jpeg', extension: 'jpg', maxBytes: 8 * 1024 * 1024, storageBase: 'image' }),
  Object.freeze({ mimeType: 'image/gif', extension: 'gif', maxBytes: 8 * 1024 * 1024, storageBase: 'image' }),
  Object.freeze({ mimeType: 'image/webp', extension: 'webp', maxBytes: 8 * 1024 * 1024, storageBase: 'image' }),
  Object.freeze({ mimeType: 'audio/mpeg', extension: 'mp3', maxBytes: 32 * 1024 * 1024, storageBase: 'media' }),
  Object.freeze({ mimeType: 'audio/wav', extension: 'wav', maxBytes: 64 * 1024 * 1024, storageBase: 'media' }),
  Object.freeze({ mimeType: 'audio/mp4', extension: 'm4a', maxBytes: 64 * 1024 * 1024, storageBase: 'media' }),
  Object.freeze({ mimeType: 'video/mp4', extension: 'mp4', maxBytes: MAX_ATTACHMENT_BYTES, storageBase: 'media' }),
  Object.freeze({ mimeType: 'video/quicktime', extension: 'mov', maxBytes: MAX_ATTACHMENT_BYTES, storageBase: 'media' }),
  Object.freeze({ mimeType: 'video/webm', extension: 'webm', maxBytes: MAX_ATTACHMENT_BYTES, storageBase: 'media' }),
  Object.freeze({ mimeType: 'application/pdf', extension: 'pdf', maxBytes: MAX_DOCUMENT_BYTES, storageBase: 'document' }),
  Object.freeze({
    mimeType: 'text/plain', extension: 'txt', maxBytes: MAX_TEXT_BYTES, storageBase: 'document',
    preserveExtensions: TEXT_FILE_EXTENSIONS,
  }),
  Object.freeze({
    mimeType: 'text/markdown', extension: 'md', maxBytes: MAX_TEXT_BYTES, storageBase: 'document',
    preserveExtensions: Object.freeze(['md', 'markdown', 'mdx']),
  }),
  Object.freeze({ mimeType: 'text/csv', extension: 'csv', maxBytes: MAX_TEXT_BYTES, storageBase: 'document' }),
  Object.freeze({
    mimeType: 'application/json', extension: 'json', maxBytes: MAX_TEXT_BYTES, storageBase: 'document',
    preserveExtensions: Object.freeze(['json', 'ipynb', 'geojson']),
  }),
  Object.freeze({ mimeType: 'application/rtf', extension: 'rtf', maxBytes: MAX_TEXT_BYTES, storageBase: 'document' }),
  Object.freeze({
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: 'docx', maxBytes: MAX_DOCUMENT_BYTES, storageBase: 'document',
  }),
  Object.freeze({
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: 'xlsx', maxBytes: MAX_DOCUMENT_BYTES, storageBase: 'document',
  }),
  Object.freeze({
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extension: 'pptx', maxBytes: MAX_DOCUMENT_BYTES, storageBase: 'document',
  }),
  Object.freeze({ mimeType: 'application/msword', extension: 'doc', maxBytes: MAX_DOCUMENT_BYTES, storageBase: 'document' }),
  Object.freeze({ mimeType: 'application/vnd.ms-excel', extension: 'xls', maxBytes: MAX_DOCUMENT_BYTES, storageBase: 'document' }),
  Object.freeze({ mimeType: 'application/vnd.ms-powerpoint', extension: 'ppt', maxBytes: MAX_DOCUMENT_BYTES, storageBase: 'document' }),
  Object.freeze({
    mimeType: 'application/zip', extension: 'zip', maxBytes: MAX_ATTACHMENT_BYTES, storageBase: 'document',
    preserveExtensions: ZIP_FILE_EXTENSIONS,
  }),
  Object.freeze({
    mimeType: 'application/gzip', extension: 'gz', maxBytes: MAX_ATTACHMENT_BYTES, storageBase: 'document',
    preserveExtensions: GZIP_FILE_EXTENSIONS,
  }),
  Object.freeze({ mimeType: 'application/x-tar', extension: 'tar', maxBytes: MAX_ATTACHMENT_BYTES, storageBase: 'document' }),
  Object.freeze({ mimeType: 'application/x-7z-compressed', extension: '7z', maxBytes: MAX_ATTACHMENT_BYTES, storageBase: 'document' }),
])
const TYPE_BY_MIME = new Map(ATTACHMENT_TYPES.map(type => [type.mimeType, type]))
const TYPE_BY_EXTENSION = new Map([
  ['png', TYPE_BY_MIME.get('image/png')],
  ['jpg', TYPE_BY_MIME.get('image/jpeg')],
  ['jpeg', TYPE_BY_MIME.get('image/jpeg')],
  ['gif', TYPE_BY_MIME.get('image/gif')],
  ['webp', TYPE_BY_MIME.get('image/webp')],
  ['mp3', TYPE_BY_MIME.get('audio/mpeg')],
  ['wav', TYPE_BY_MIME.get('audio/wav')],
  ['m4a', TYPE_BY_MIME.get('audio/mp4')],
  ['mp4', TYPE_BY_MIME.get('video/mp4')],
  ['mov', TYPE_BY_MIME.get('video/quicktime')],
  ['webm', TYPE_BY_MIME.get('video/webm')],
  ['pdf', TYPE_BY_MIME.get('application/pdf')],
  ['txt', TYPE_BY_MIME.get('text/plain')],
  ['md', TYPE_BY_MIME.get('text/markdown')],
  ['markdown', TYPE_BY_MIME.get('text/markdown')],
  ['csv', TYPE_BY_MIME.get('text/csv')],
  ['json', TYPE_BY_MIME.get('application/json')],
  ['rtf', TYPE_BY_MIME.get('application/rtf')],
  ['docx', TYPE_BY_MIME.get('application/vnd.openxmlformats-officedocument.wordprocessingml.document')],
  ['xlsx', TYPE_BY_MIME.get('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')],
  ['pptx', TYPE_BY_MIME.get('application/vnd.openxmlformats-officedocument.presentationml.presentation')],
  ['doc', TYPE_BY_MIME.get('application/msword')],
  ['xls', TYPE_BY_MIME.get('application/vnd.ms-excel')],
  ['ppt', TYPE_BY_MIME.get('application/vnd.ms-powerpoint')],
  ['tar', TYPE_BY_MIME.get('application/x-tar')],
  ['7z', TYPE_BY_MIME.get('application/x-7z-compressed')],
])
for (const extension of TEXT_FILE_EXTENSIONS) {
  TYPE_BY_EXTENSION.set(extension, TYPE_BY_MIME.get('text/plain'))
}
for (const extension of ['markdown', 'mdx']) {
  TYPE_BY_EXTENSION.set(extension, TYPE_BY_MIME.get('text/markdown'))
}
for (const extension of ['ipynb', 'geojson']) {
  TYPE_BY_EXTENSION.set(extension, TYPE_BY_MIME.get('application/json'))
}
for (const extension of ZIP_FILE_EXTENSIONS) {
  TYPE_BY_EXTENSION.set(extension, TYPE_BY_MIME.get('application/zip'))
}
for (const extension of GZIP_FILE_EXTENSIONS) {
  TYPE_BY_EXTENSION.set(extension, TYPE_BY_MIME.get('application/gzip'))
}
const ATTACHMENT_FILE_EXTENSIONS = Object.freeze([...TYPE_BY_EXTENSION.keys()])
const TEXT_MIME_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json'])
const LEGACY_OFFICE_MIME_TYPES = new Set([
  'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
])

function attachmentError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function fail(code) {
  throw attachmentError(code)
}

function isAttachmentError(error) {
  return /^LOCAL_ATTACHMENT_[A-Z0-9_]+$/.test(String(error?.message || ''))
}

function sortedKeys(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Reflect.ownKeys(value).sort().join(',')
    : ''
}

function normalizeId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    fail('LOCAL_ATTACHMENT_ID_INVALID')
  }
  return value
}

function normalizeReferences(value) {
  const refs = Array.isArray(value) ? value : [value]
  if (refs.length > MAX_ATTACHMENTS) fail('LOCAL_ATTACHMENT_COUNT_LIMIT')
  const ids = refs.map((ref) => normalizeId(
    typeof ref === 'string' ? ref : ref?.id,
  ))
  if (new Set(ids).size !== ids.length) fail('LOCAL_ATTACHMENT_REFERENCE_INVALID')
  return ids
}

function normalizeDiscardReferences(value) {
  const refs = Array.isArray(value) ? value : [value]
  const ids = refs.map(ref => normalizeId(typeof ref === 'string' ? ref : ref?.id))
  return [...new Set(ids)]
}

function normalizeReferencedIds(value) {
  if (value == null) return new Set()
  if (!Array.isArray(value) && !(value instanceof Set)) {
    fail('LOCAL_ATTACHMENT_REFERENCE_INVALID')
  }
  return new Set([...value].map(normalizeId))
}

function validUtf8Text(bytes) {
  if (bytes.includes(0x00)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

function detectedOoxmlType(bytes) {
  if (bytes.length < 4 || !bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
      || !bytes.includes(Buffer.from('[Content_Types].xml'))) return null
  if (bytes.includes(Buffer.from('word/'))) {
    return TYPE_BY_MIME.get('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  }
  if (bytes.includes(Buffer.from('xl/'))) {
    return TYPE_BY_MIME.get('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  }
  if (bytes.includes(Buffer.from('ppt/'))) {
    return TYPE_BY_MIME.get('application/vnd.openxmlformats-officedocument.presentationml.presentation')
  }
  return null
}

function detectAttachmentType(bytes, nameType = null, declaredMime = '') {
  if (bytes.length >= 8
      && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return TYPE_BY_MIME.get('image/png')
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return TYPE_BY_MIME.get('image/jpeg')
  }
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) {
    return TYPE_BY_MIME.get('image/gif')
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
      && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return TYPE_BY_MIME.get('image/webp')
  }
  const id3Header = bytes.length >= 10 && bytes.subarray(0, 3).toString('ascii') === 'ID3'
    && bytes[3] >= 2 && bytes[3] <= 4 && bytes[4] !== 0xff
    && [...bytes.subarray(6, 10)].every(byte => byte < 0x80)
  const mpegFrame = bytes.length >= 4 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0
    && ((bytes[1] >> 3) & 0x03) !== 1 && ((bytes[1] >> 1) & 0x03) !== 0
    && ((bytes[2] >> 4) & 0x0f) !== 15 && ((bytes[2] >> 2) & 0x03) !== 3
  if (id3Header || mpegFrame) {
    return TYPE_BY_MIME.get('audio/mpeg')
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
      && bytes.subarray(8, 12).toString('ascii') === 'WAVE') {
    return TYPE_BY_MIME.get('audio/wav')
  }
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = bytes.subarray(8, 12).toString('ascii')
    if (['M4A ', 'M4B ', 'F4A ', 'f4a '].includes(brand)) return TYPE_BY_MIME.get('audio/mp4')
    if (brand === 'qt  ') return TYPE_BY_MIME.get('video/quicktime')
    if (/^(?:iso[2-9m]|isom|avc1|mp4[12]|M4V |dash)$/.test(brand)) {
      return TYPE_BY_MIME.get('video/mp4')
    }
  }
  if (bytes.length >= 8 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
      && bytes.subarray(0, Math.min(bytes.length, 128)).includes(Buffer.from('webm'))) {
    return TYPE_BY_MIME.get('video/webm')
  }
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-') {
    return TYPE_BY_MIME.get('application/pdf')
  }
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '{\\rtf') {
    return TYPE_BY_MIME.get('application/rtf')
  }
  const ooxml = detectedOoxmlType(bytes)
  if (ooxml) return ooxml
  if (bytes.length >= 8
      && bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
      && LEGACY_OFFICE_MIME_TYPES.has(nameType?.mimeType)) {
    return nameType
  }
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    return TYPE_BY_MIME.get('application/zip')
  }
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return TYPE_BY_MIME.get('application/gzip')
  }
  if (bytes.length >= 265 && bytes.subarray(257, 262).toString('ascii') === 'ustar') {
    return TYPE_BY_MIME.get('application/x-tar')
  }
  if (bytes.length >= 6
      && bytes.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) {
    return TYPE_BY_MIME.get('application/x-7z-compressed')
  }
  const textType = nameType && TEXT_MIME_TYPES.has(nameType.mimeType)
    ? nameType
    : (TEXT_MIME_TYPES.has(declaredMime) ? TYPE_BY_MIME.get(declaredMime) : null)
  if (textType && validUtf8Text(bytes)) {
    if (textType.mimeType === 'application/json') {
      try { JSON.parse(bytes.toString('utf8')) } catch { return null }
    }
    return textType
  }
  return null
}

function declaredMimeType(value) {
  const mimeType = String(value || '').split(';', 1)[0].trim().toLowerCase()
  if (mimeType === 'image/jpg') return 'image/jpeg'
  if (['text/rtf', 'application/x-rtf'].includes(mimeType)) return 'application/rtf'
  return mimeType
}

function declaredNameType(name) {
  const basename = path.posix.basename(String(name || '').replace(/\\/g, '/'))
  const extension = path.posix.extname(basename).slice(1).toLowerCase()
  return TYPE_BY_EXTENSION.get(extension) || null
}

function sanitizeName(value, type) {
  let basename = path.posix.basename(String(value || '').normalize('NFKC').replace(/\\/g, '/'))
  basename = basename
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .trim()
  let stem = basename.replace(/\.[^.]*$/, '').replace(/^\.+/, '').replace(/[. ]+$/, '').trim()
  stem = stem.slice(0, 120).replace(/[. ]+$/, '') || 'attachment'
  const requestedExtension = path.posix.extname(basename).slice(1).toLowerCase()
  const extension = type.preserveExtensions?.includes(requestedExtension)
    ? requestedExtension
    : type.extension
  return `${stem}.${extension}`
}

function toBuffer(value) {
  const size = Array.isArray(value)
    ? value.length
    : Buffer.isBuffer(value) || value instanceof Uint8Array
      ? value.byteLength
      : value instanceof ArrayBuffer
        ? value.byteLength
        : -1
  if (size <= 0) fail('LOCAL_ATTACHMENT_BYTES_INVALID')
  if (size > MAX_ATTACHMENT_BYTES) fail('LOCAL_ATTACHMENT_TOO_LARGE')
  if (Array.isArray(value)) {
    if (!value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
      fail('LOCAL_ATTACHMENT_BYTES_INVALID')
    }
    return Buffer.from(value)
  }
  if (Buffer.isBuffer(value)) return Buffer.from(value)
  if (value instanceof Uint8Array) return Buffer.from(value)
  return Buffer.from(new Uint8Array(value))
}

function validateAttachment(bytes, name, mimeType, requireMimeType) {
  const declaredMime = declaredMimeType(mimeType)
  if (requireMimeType && !TYPE_BY_MIME.has(declaredMime)) {
    fail('LOCAL_ATTACHMENT_TYPE_UNSUPPORTED')
  }
  const nameType = declaredNameType(name)
  if (declaredMime && nameType && declaredMime !== nameType.mimeType) {
    fail('LOCAL_ATTACHMENT_TYPE_MISMATCH')
  }
  const actual = detectAttachmentType(bytes, nameType, declaredMime)
  if (!actual) fail('LOCAL_ATTACHMENT_TYPE_UNSUPPORTED')
  if (declaredMime && declaredMime !== actual.mimeType) {
    fail('LOCAL_ATTACHMENT_TYPE_MISMATCH')
  }
  if (nameType && nameType.mimeType !== actual.mimeType) {
    fail('LOCAL_ATTACHMENT_TYPE_MISMATCH')
  }
  if (bytes.length > actual.maxBytes) fail('LOCAL_ATTACHMENT_TOO_LARGE')
  return actual
}

function chunkHashes(bytes) {
  return Array.from({ length: Math.ceil(bytes.length / ATTACHMENT_CHUNK_BYTES) }, (_, index) => (
    crypto.createHash('sha256').update(bytes.subarray(
      index * ATTACHMENT_CHUNK_BYTES, (index + 1) * ATTACHMENT_CHUNK_BYTES,
    )).digest('hex')
  ))
}

function chunkChecksum(chunks) {
  return crypto.createHash('sha256').update(chunks.join('')).digest('hex')
}

function createAttachmentRecord(id, name, bytes, type) {
  const metadata = {
    id,
    name: sanitizeName(name, type),
    mimeType: type.mimeType,
    size: bytes.length,
  }
  const chunks = /^(?:image|audio|video)\//.test(type.mimeType) ? chunkHashes(bytes) : null
  return {
    metadata,
    document: {
      version: chunks ? STORE_VERSION : 1,
      ...metadata,
      checksum: chunks ? chunkChecksum(chunks) : crypto.createHash('sha256').update(bytes).digest('hex'),
      ...(chunks ? { chunks } : {}),
    },
  }
}

function parseAttachmentRecord(metadataBytes, id) {
  let document
  try { document = JSON.parse(metadataBytes.toString('utf8')) } catch { fail('LOCAL_ATTACHMENT_TAMPERED') }
  const legacy = document?.version === 1
  if (sortedKeys(document) !== (legacy
    ? 'checksum,id,mimeType,name,size,version' : 'checksum,chunks,id,mimeType,name,size,version')
      || (!legacy && document.version !== STORE_VERSION) || document.id !== id
      || typeof document.name !== 'string' || typeof document.mimeType !== 'string'
      || !Number.isSafeInteger(document.size) || document.size <= 0
      || document.size > MAX_ATTACHMENT_BYTES
      || typeof document.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(document.checksum)) {
    fail('LOCAL_ATTACHMENT_TAMPERED')
  }
  if (!legacy && (!Array.isArray(document.chunks)
      || document.chunks.length !== Math.ceil(document.size / ATTACHMENT_CHUNK_BYTES)
      || document.chunks.some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))
      || chunkChecksum(document.chunks) !== document.checksum)) {
    fail('LOCAL_ATTACHMENT_TAMPERED')
  }
  const type = TYPE_BY_MIME.get(document.mimeType)
  if (!type || sanitizeName(document.name, type) !== document.name) {
    fail('LOCAL_ATTACHMENT_TAMPERED')
  }
  return {
    document,
    type,
    metadata: {
      id: document.id,
      name: document.name,
      mimeType: document.mimeType,
      size: document.size,
    },
  }
}

function validateStoredAttachment(bytes, document) {
  if (bytes.length !== document.size
      || detectAttachmentType(
        bytes, declaredNameType(document.name), declaredMimeType(document.mimeType),
      )?.mimeType !== document.mimeType
      || (document.version === 1
        ? crypto.createHash('sha256').update(bytes).digest('hex') !== document.checksum
        : chunkChecksum(chunkHashes(bytes)) !== document.checksum)) {
    fail('LOCAL_ATTACHMENT_TAMPERED')
  }
}

module.exports = {
  ATTACHMENT_FILE_EXTENSIONS,
  ATTACHMENT_CHUNK_BYTES,
  MAX_ATTACHMENT_BYTES,
  MAX_METADATA_BYTES,
  attachmentError,
  createAttachmentRecord,
  detectAttachmentType,
  fail,
  isAttachmentError,
  normalizeDiscardReferences,
  normalizeId,
  normalizeReferencedIds,
  normalizeReferences,
  parseAttachmentRecord,
  sortedKeys,
  toBuffer,
  validateAttachment,
  validateStoredAttachment,
}

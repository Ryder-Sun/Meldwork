const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const {
  MAX_ATTACHMENT_BYTES,
  MAX_METADATA_BYTES,
  attachmentError,
  createAttachmentRecord,
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
} = require('./attachment-records.cjs')

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return Boolean(relative && !relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative))
}

function writePrivateFile(filename, contents) {
  let descriptor
  try {
    descriptor = fs.openSync(filename, 'wx', FILE_MODE)
    fs.writeFileSync(descriptor, contents)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.chmodSync(filename, FILE_MODE)
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch { /* already closed */ }
    }
    try { fs.unlinkSync(filename) } catch { /* absent */ }
    throw error
  }
}

function readExactFile(descriptor, size) {
  const bytes = Buffer.allocUnsafe(size)
  let offset = 0
  while (offset < size) {
    const count = fs.readSync(descriptor, bytes, offset, size - offset, offset)
    if (count === 0) break
    offset += count
  }
  const extra = Buffer.allocUnsafe(1)
  if (offset !== size || fs.readSync(descriptor, extra, 0, 1, size) !== 0) {
    throw new Error('file changed while reading')
  }
  return bytes
}

class AttachmentStore {
  constructor({ rootPath, createId = () => crypto.randomUUID() } = {}) {
    if (typeof rootPath !== 'string' || !rootPath || rootPath.length > 4096) {
      fail('LOCAL_ATTACHMENT_ROOT_REQUIRED')
    }
    if (typeof createId !== 'function') fail('LOCAL_ATTACHMENT_CREATE_ID_INVALID')
    this.rootPath = path.resolve(rootPath)
    if (this.rootPath === path.parse(this.rootPath).root) {
      fail('LOCAL_ATTACHMENT_ROOT_UNSAFE')
    }
    this.createId = createId
    this.rootRealPath = this.prepareRoot()
  }

  importBuffer(input) {
    return this.importBufferWithBytes(input).metadata
  }

  importBufferWithBytes(input) {
    if (sortedKeys(input) !== 'bytes,mimeType,name'
        || typeof input.name !== 'string' || input.name.length > 4096
        || typeof input.mimeType !== 'string') {
      fail('LOCAL_ATTACHMENT_INPUT_INVALID')
    }
    const bytes = toBuffer(input.bytes)
    return { metadata: this.importBytes(bytes, input.name, input.mimeType, true), bytes }
  }

  importFile(filename) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || filename.length > 4096) {
      fail('LOCAL_ATTACHMENT_SOURCE_INVALID')
    }
    let descriptor
    try {
      const sourceStat = fs.lstatSync(filename)
      if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
        fail('LOCAL_ATTACHMENT_SOURCE_UNSAFE')
      }
      const noFollow = process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW || 0)
      descriptor = fs.openSync(filename, fs.constants.O_RDONLY | noFollow)
      const stat = fs.fstatSync(descriptor)
      if (!stat.isFile()) fail('LOCAL_ATTACHMENT_SOURCE_UNSAFE')
      if (stat.size > MAX_ATTACHMENT_BYTES) fail('LOCAL_ATTACHMENT_TOO_LARGE')
      if (stat.size <= 0) fail('LOCAL_ATTACHMENT_BYTES_INVALID')
      const bytes = readExactFile(descriptor, stat.size)
      if (fs.fstatSync(descriptor).size !== stat.size) {
        fail('LOCAL_ATTACHMENT_SOURCE_UNAVAILABLE')
      }
      return this.importBytes(bytes, path.basename(filename), '', false)
    } catch (error) {
      if (isAttachmentError(error)) throw error
      throw attachmentError('LOCAL_ATTACHMENT_SOURCE_UNAVAILABLE')
    } finally {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor) } catch { /* already closed */ }
      }
    }
  }

  resolve(refs) {
    return normalizeReferences(refs).map((id) => {
      const entry = this.loadEntry(id)
      return { ...entry.metadata, path: entry.path }
    })
  }

  read(id) {
    return Buffer.from(this.loadEntry(normalizeId(id)).bytes)
  }

  readWithMetadata(id) {
    const entry = this.loadEntry(normalizeId(id))
    return {
      metadata: { ...entry.metadata },
      bytes: Buffer.from(entry.bytes),
    }
  }

  discard(refs) {
    this.assertRoot()
    const discardedIds = []
    for (const id of normalizeDiscardReferences(refs)) {
      const directory = path.join(this.rootPath, id)
      try {
        const stat = fs.lstatSync(directory)
        if (stat.isSymbolicLink() || !stat.isDirectory()) fail('LOCAL_ATTACHMENT_TAMPERED')
      } catch (error) {
        if (error.code === 'ENOENT') continue
        if (isAttachmentError(error)) throw error
        throw attachmentError('LOCAL_ATTACHMENT_STORAGE_UNAVAILABLE')
      }
      this.removeDirectory(directory)
      discardedIds.push(id)
    }
    return discardedIds
  }

  cleanup(referencedIds = []) {
    this.assertRoot()
    const referenced = normalizeReferencedIds(referencedIds)
    const discardedIds = []
    let removedTemporaryEntries = 0
    let entries
    try {
      entries = fs.readdirSync(this.rootPath, { withFileTypes: true })
    } catch {
      throw attachmentError('LOCAL_ATTACHMENT_STORAGE_UNAVAILABLE')
    }
    for (const entry of entries) {
      const candidate = path.join(this.rootPath, entry.name)
      if (entry.name.startsWith('.import-') || entry.name.startsWith('.discard-')) {
        this.removeTemporaryEntry(candidate)
        removedTemporaryEntries += 1
        continue
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(entry.name)
          || referenced.has(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
        continue
      }
      this.removeDirectory(candidate)
      discardedIds.push(entry.name)
    }
    return { discardedIds, removedTemporaryEntries }
  }

  prepareRoot() {
    try {
      try {
        const existing = fs.lstatSync(this.rootPath)
        if (existing.isSymbolicLink() || !existing.isDirectory()) {
          fail('LOCAL_ATTACHMENT_ROOT_UNSAFE')
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        fs.mkdirSync(this.rootPath, { recursive: true, mode: DIRECTORY_MODE })
      }
      const stat = fs.lstatSync(this.rootPath)
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail('LOCAL_ATTACHMENT_ROOT_UNSAFE')
      fs.chmodSync(this.rootPath, DIRECTORY_MODE)
      return fs.realpathSync(this.rootPath)
    } catch (error) {
      if (isAttachmentError(error)) throw error
      throw attachmentError('LOCAL_ATTACHMENT_STORAGE_UNAVAILABLE')
    }
  }

  assertRoot() {
    try {
      const stat = fs.lstatSync(this.rootPath)
      if (stat.isSymbolicLink() || !stat.isDirectory()
          || fs.realpathSync(this.rootPath) !== this.rootRealPath
          || (process.platform !== 'win32' && (stat.mode & 0o777) !== DIRECTORY_MODE)) {
        fail('LOCAL_ATTACHMENT_ROOT_UNSAFE')
      }
    } catch (error) {
      if (isAttachmentError(error)) throw error
      throw attachmentError('LOCAL_ATTACHMENT_ROOT_UNSAFE')
    }
  }

  removeDirectory(directory) {
    const tombstone = path.join(
      this.rootPath,
      `.discard-${process.pid}-${crypto.randomBytes(8).toString('hex')}`,
    )
    try {
      fs.renameSync(directory, tombstone)
      fs.rmSync(tombstone, { recursive: true, force: true })
    } catch (error) {
      if (error.code === 'ENOENT') return false
      throw attachmentError('LOCAL_ATTACHMENT_STORAGE_UNAVAILABLE')
    }
    return true
  }

  removeTemporaryEntry(filename) {
    try {
      const stat = fs.lstatSync(filename)
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        fs.rmSync(filename, { recursive: true, force: true })
      } else {
        fs.unlinkSync(filename)
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw attachmentError('LOCAL_ATTACHMENT_STORAGE_UNAVAILABLE')
    }
  }

  importBytes(bytes, name, mimeType, requireMimeType) {
    this.assertRoot()
    if (bytes.length > MAX_ATTACHMENT_BYTES) fail('LOCAL_ATTACHMENT_TOO_LARGE')
    const type = validateAttachment(bytes, name, mimeType, requireMimeType)
    let id
    try { id = normalizeId(this.createId()) } catch (error) {
      if (isAttachmentError(error)) throw error
      throw attachmentError('LOCAL_ATTACHMENT_CREATE_ID_INVALID')
    }
    const { metadata, document } = createAttachmentRecord(id, name, bytes, type)
    const finalDirectory = path.join(this.rootPath, id)
    let temporaryDirectory = ''
    try {
      if (fs.existsSync(finalDirectory)) fail('LOCAL_ATTACHMENT_ID_CONFLICT')
      temporaryDirectory = fs.mkdtempSync(path.join(this.rootPath, '.import-'))
      fs.chmodSync(temporaryDirectory, DIRECTORY_MODE)
      writePrivateFile(path.join(temporaryDirectory, `${type.storageBase}.${type.extension}`), bytes)
      writePrivateFile(
        path.join(temporaryDirectory, 'metadata.json'),
        Buffer.from(JSON.stringify(document), 'utf8'),
      )
      fs.renameSync(temporaryDirectory, finalDirectory)
      temporaryDirectory = ''
      return { ...metadata }
    } catch (error) {
      if (temporaryDirectory) {
        try { fs.rmSync(temporaryDirectory, { recursive: true, force: true }) } catch { /* best effort */ }
      }
      if (isAttachmentError(error)) throw error
      if (['EEXIST', 'ENOTEMPTY'].includes(error.code)) {
        throw attachmentError('LOCAL_ATTACHMENT_ID_CONFLICT')
      }
      throw attachmentError('LOCAL_ATTACHMENT_STORAGE_UNAVAILABLE')
    }
  }

  loadEntry(id) {
    this.assertRoot()
    const directory = path.join(this.rootPath, id)
    let directoryStat
    try {
      directoryStat = fs.lstatSync(directory)
    } catch (error) {
      if (error.code === 'ENOENT') fail('LOCAL_ATTACHMENT_NOT_FOUND')
      throw attachmentError('LOCAL_ATTACHMENT_STORAGE_UNAVAILABLE')
    }
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()
        || (process.platform !== 'win32' && (directoryStat.mode & 0o777) !== DIRECTORY_MODE)) {
      fail('LOCAL_ATTACHMENT_TAMPERED')
    }
    let realDirectory
    try { realDirectory = fs.realpathSync(directory) } catch { fail('LOCAL_ATTACHMENT_TAMPERED') }
    if (!isInside(this.rootRealPath, realDirectory)) fail('LOCAL_ATTACHMENT_TAMPERED')

    const metadataBytes = this.readStoredFile(
      path.join(directory, 'metadata.json'),
      'LOCAL_ATTACHMENT_FILE_MISSING',
      MAX_METADATA_BYTES,
    )
    const { document, type, metadata } = parseAttachmentRecord(metadataBytes, id)
    const contentPath = path.join(directory, `${type.storageBase}.${type.extension}`)
    const bytes = this.readStoredFile(
      contentPath,
      'LOCAL_ATTACHMENT_FILE_MISSING',
      MAX_ATTACHMENT_BYTES,
    )
    validateStoredAttachment(bytes, document)
    return {
      directory,
      path: contentPath,
      bytes,
      metadata,
    }
  }

  readStoredFile(filename, missingCode, maxBytes) {
    let descriptor
    try {
      const fileStat = fs.lstatSync(filename)
      if (fileStat.isSymbolicLink() || !fileStat.isFile()
          || fileStat.size <= 0 || fileStat.size > maxBytes
          || (process.platform !== 'win32' && (fileStat.mode & 0o777) !== FILE_MODE)) {
        fail('LOCAL_ATTACHMENT_TAMPERED')
      }
      const realPath = fs.realpathSync(filename)
      if (!isInside(this.rootRealPath, realPath)) fail('LOCAL_ATTACHMENT_TAMPERED')
      const noFollow = process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW || 0)
      descriptor = fs.openSync(filename, fs.constants.O_RDONLY | noFollow)
      const openedStat = fs.fstatSync(descriptor)
      if (!openedStat.isFile() || openedStat.size !== fileStat.size
          || (process.platform !== 'win32' && (openedStat.mode & 0o777) !== FILE_MODE)) {
        fail('LOCAL_ATTACHMENT_TAMPERED')
      }
      const bytes = readExactFile(descriptor, openedStat.size)
      if (fs.fstatSync(descriptor).size !== openedStat.size) {
        fail('LOCAL_ATTACHMENT_TAMPERED')
      }
      return bytes
    } catch (error) {
      if (isAttachmentError(error)) throw error
      if (error.code === 'ENOENT') throw attachmentError(missingCode)
      throw attachmentError('LOCAL_ATTACHMENT_TAMPERED')
    } finally {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor) } catch { /* already closed */ }
      }
    }
  }
}

module.exports = { AttachmentStore }

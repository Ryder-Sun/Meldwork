const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { createAttachmentService } = require('../../src/attachments/attachment-service.cjs')
const { AttachmentStore } = require('../../src/attachments/attachment-store.cjs')

test('importFiles rejects non-array inputs before accessing the store', () => {
  let accesses = 0
  const service = createAttachmentService({ getStore: () => { accesses++; return null } })
  for (const input of [undefined, null, 'file.txt', {}, 123]) {
    assert.throws(() => service.importFiles(input), { message: 'LOCAL_ATTACHMENT_REFERENCE_INVALID' })
  }
  assert.equal(accesses, 0)
})

test('importFiles retains empty-array and count-limit behavior', () => {
  const service = createAttachmentService({ getStore: () => ({}) })
  assert.deepEqual(service.importFiles([]), [])
  assert.throws(() => service.importFiles(Array(10000).fill('file.txt')), {
    message: 'LOCAL_ATTACHMENT_COUNT_LIMIT',
  })
})

test('valid filename arrays continue through import and preview', () => {
  const imported = []
  const store = {
    importFile(filename) { imported.push(filename); return { id: 'attachment-1' } },
    readWithMetadata() { return { metadata: { id: 'attachment-1', name: 'doc.pdf', mimeType: 'application/pdf', size: 3 } } },
  }
  const service = createAttachmentService({ getStore: () => store })
  assert.deepEqual(service.importFiles(['/tmp/doc.pdf']), [{
    id: 'attachment-1', name: 'doc.pdf', mimeType: 'application/pdf', size: 3,
  }])
  assert.deepEqual(imported, ['/tmp/doc.pdf'])
})

test('buffer import previews validated bytes without rereading the stored file', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-attachment-preview-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = new AttachmentStore({ rootPath: directory })
  const originalRead = store.readWithMetadata.bind(store)
  let reads = 0
  store.readWithMetadata = id => { reads++; return originalRead(id) }
  const service = createAttachmentService({ getStore: () => store })
  const bytes = Buffer.from('%PDF-1.7\n')
  const result = service.importBuffer({ bytes, name: 'doc.pdf', mimeType: 'application/pdf' })
  assert.equal(result.name, 'doc.pdf')
  assert.equal(reads, 0)
  assert.deepEqual(service.preview(result.id), result)
  assert.equal(reads, 1)
})

test('media ranges read and verify only intersecting chunks; legacy files retain full validation', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-media-range-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = new AttachmentStore({ rootPath: directory })
  const service = createAttachmentService({ getStore: () => store })
  let handler
  service.registerProtocol({ handle: (_scheme, value) => { handler = value } })
  const bytes = Buffer.alloc(800000, 0x31)
  Buffer.from('49443304000000000000', 'hex').copy(bytes)
  const item = store.importBuffer({ bytes, name: 'audio.mp3', mimeType: 'audio/mpeg' })
  const reads = []
  const original = fs.createReadStream
  fs.createReadStream = (filename, options) => { reads.push([options.start, options.end]); return original(filename, options) }
  t.after(() => { fs.createReadStream = original })
  const request = range => new Request(`meldwork-media://attachment/${item.id}`, { headers: { Range: range } })
  const response = handler(request('bytes=300000-300099'))
  assert.equal(response.status, 206)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(300000, 300100))
  assert.deepEqual(reads, [[262144, 524287]])
  reads.length = 0
  const across = handler(request('bytes=262140-262150'))
  assert.deepEqual(Buffer.from(await across.arrayBuffer()), bytes.subarray(262140, 262151))
  assert.deepEqual(reads, [[0, 262143], [262144, 524287]])
  const filename = path.join(directory, item.id, 'media.mp3')
  const fd = fs.openSync(filename, 'r+')
  fs.writeSync(fd, Buffer.from('X'), 0, 1, 300010)
  fs.closeSync(fd)
  await assert.rejects(handler(request('bytes=300000-300099')).arrayBuffer())
  fs.writeFileSync(filename, bytes)
  const metadataPath = path.join(directory, item.id, 'metadata.json')
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
  const badMetadata = structuredClone(metadata)
  badMetadata.chunks[1] = '0'.repeat(64)
  fs.writeFileSync(metadataPath, JSON.stringify(badMetadata))
  assert.equal(handler(request('bytes=300000-300099')).status, 404)
  metadata.version = 1
  delete metadata.chunks
  metadata.checksum = crypto.createHash('sha256').update(bytes).digest('hex')
  fs.writeFileSync(metadataPath, JSON.stringify(metadata))
  reads.length = 0
  assert.deepEqual(Buffer.from(await handler(request('bytes=10-19')).arrayBuffer()), bytes.subarray(10, 20))
  assert.deepEqual(reads, [])
  fs.writeFileSync(filename, Buffer.alloc(bytes.length))
  assert.equal(handler(request('bytes=10-19')).status, 404)
})

test('media rejects a replaced symlink before serving data', { skip: process.platform === 'win32' }, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-media-link-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = new AttachmentStore({ rootPath: directory })
  const bytes = Buffer.from('49443304000000000000', 'hex')
  const item = store.importBuffer({ bytes, name: 'audio.mp3', mimeType: 'audio/mpeg' })
  const media = path.join(directory, item.id, 'media.mp3')
  fs.unlinkSync(media)
  fs.symlinkSync('/etc/passwd', media)
  let handler
  createAttachmentService({ getStore: () => store }).registerProtocol({
    handle: (_scheme, value) => { handler = value },
  })
  assert.equal(handler(new Request(`meldwork-media://attachment/${item.id}`)).status, 404)
})

test('cancelling a media stream closes the underlying file', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-media-cancel-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = new AttachmentStore({ rootPath: directory })
  const bytes = Buffer.alloc(800000, 0x31)
  Buffer.from('49443304000000000000', 'hex').copy(bytes)
  const item = store.importBuffer({ bytes, name: 'audio.mp3', mimeType: 'audio/mpeg' })
  const media = path.join(directory, item.id, 'media.mp3')
  const open = fs.openSync
  const close = fs.closeSync
  let mediaFd
  let closed = false
  fs.openSync = (filename, ...args) => {
    const fd = open(filename, ...args)
    if (filename === media) mediaFd = fd
    return fd
  }
  fs.closeSync = fd => { if (fd === mediaFd) closed = true; return close(fd) }
  t.after(() => { fs.openSync = open; fs.closeSync = close })
  let handler
  createAttachmentService({ getStore: () => store }).registerProtocol({
    handle: (_scheme, value) => { handler = value },
  })
  const reader = handler(new Request(`meldwork-media://attachment/${item.id}`)).body.getReader()
  assert.equal((await reader.read()).done, false)
  await reader.cancel()
  for (let attempts = 0; !closed && attempts < 20; attempts += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(closed, true)
})

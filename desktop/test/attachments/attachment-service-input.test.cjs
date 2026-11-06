const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
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

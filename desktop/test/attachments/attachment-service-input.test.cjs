const test = require('node:test')
const assert = require('node:assert/strict')
const { createAttachmentService } = require('../../src/attachments/attachment-service.cjs')

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

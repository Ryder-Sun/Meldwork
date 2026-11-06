const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createAttachmentRecord,
  normalizeReferences,
  parseAttachmentRecord,
  toBuffer,
  validateAttachment,
  validateStoredAttachment,
} = require('../../src/attachments/attachment-records.cjs')

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
])

test('MP3 detection rejects AAC and reserved MPEG frame headers', () => {
  for (const bytes of [
    Buffer.from([0xff, 0xf1, 0x50, 0x80]), // AAC ADTS has reserved MPEG layer bits.
    Buffer.from([0xff, 0xeb, 0x90, 0x00]), // Reserved MPEG version.
    Buffer.from([0xff, 0xfb, 0xf0, 0x00]), // Reserved bitrate.
    Buffer.from([0xff, 0xfb, 0x9c, 0x00]), // Reserved sample rate.
    Buffer.from('ID3'),
  ]) {
    assert.throws(() => validateAttachment(bytes, 'audio.mp3', 'audio/mpeg', true),
      { message: 'LOCAL_ATTACHMENT_TYPE_UNSUPPORTED' })
  }
  assert.equal(validateAttachment(Buffer.from([0xff, 0xfb, 0x90, 0x00]), 'audio.mp3', 'audio/mpeg', true).mimeType, 'audio/mpeg')
  assert.equal(validateAttachment(Buffer.from('49443304000000000000', 'hex'), 'audio.mp3', 'audio/mpeg', true).mimeType, 'audio/mpeg')
})

test('roundtrips a sanitized attachment record without filesystem state', () => {
  const bytes = toBuffer([...PNG])
  const type = validateAttachment(bytes, '../../private\\portrait?.PNG', 'image/png', true)
  const { metadata, document } = createAttachmentRecord(
    'attachment-1',
    '../../private\\portrait?.PNG',
    bytes,
    type,
  )
  const parsed = parseAttachmentRecord(Buffer.from(JSON.stringify(document)), metadata.id)

  assert.deepEqual(metadata, {
    id: 'attachment-1',
    name: 'portrait_.png',
    mimeType: 'image/png',
    size: PNG.length,
  })
  assert.deepEqual(parsed.metadata, metadata)
  assert.doesNotThrow(() => validateStoredAttachment(bytes, parsed.document))
})

test('rejects malformed metadata and checksum changes with the stable tamper code', () => {
  const type = validateAttachment(PNG, 'image.png', 'image/png', true)
  const { document } = createAttachmentRecord('attachment-1', 'image.png', PNG, type)

  assert.throws(
    () => parseAttachmentRecord(Buffer.from('{"version":1}'), 'attachment-1'),
    { message: 'LOCAL_ATTACHMENT_TAMPERED' },
  )
  const changed = Buffer.from(PNG)
  changed[changed.length - 1] ^= 0xff
  assert.throws(
    () => validateStoredAttachment(changed, document),
    { message: 'LOCAL_ATTACHMENT_TAMPERED' },
  )
})

test('keeps reference count and duplicate validation in the record layer', () => {
  assert.deepEqual(normalizeReferences(['attachment-1', { id: 'attachment-2' }]), [
    'attachment-1', 'attachment-2',
  ])
  assert.throws(
    () => normalizeReferences(['attachment-1', 'attachment-1']),
    { message: 'LOCAL_ATTACHMENT_REFERENCE_INVALID' },
  )
  assert.throws(
    () => normalizeReferences(Array.from({ length: 5 }, (_, index) => `attachment-${index}`)),
    { message: 'LOCAL_ATTACHMENT_COUNT_LIMIT' },
  )
})

test('roundtrips validated text and document attachment records', () => {
  const fixtures = [
    [Buffer.from('%PDF-1.7\n'), 'report.pdf', 'application/pdf'],
    [Buffer.from('# Notes\n', 'utf8'), 'notes.md', 'text/markdown'],
    [Buffer.from('{"ok":true}', 'utf8'), 'data.json', 'application/json'],
    [Buffer.from('{\\rtf1 report}', 'ascii'), 'report.rtf', 'application/rtf'],
    [
      Buffer.from('PK\u0003\u0004[Content_Types].xml word/document.xml'),
      'report.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
  ]

  fixtures.forEach(([bytes, name, mimeType], index) => {
    const type = validateAttachment(bytes, name, mimeType, true)
    const { metadata, document } = createAttachmentRecord(
      `document-${index + 1}`, name, bytes, type,
    )
    assert.equal(metadata.name, name)
    assert.equal(metadata.mimeType, mimeType)
    assert.doesNotThrow(() => validateStoredAttachment(bytes, document))
  })

  assert.throws(
    () => validateAttachment(Buffer.from('{not-json}'), 'data.json', 'application/json', true),
    { message: 'LOCAL_ATTACHMENT_TYPE_UNSUPPORTED' },
  )
})

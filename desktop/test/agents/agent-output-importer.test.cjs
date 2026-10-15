const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { AttachmentStore } = require('../../src/attachments/attachment-store.cjs')
const {
  captureAgentOutcomeDescriptors,
  captureAgentOutputState,
  captureArtifactOutputState,
  importAgentOutputs,
} = require('../../src/agents/agent-output-importer.cjs')

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
])
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00\x00', 'binary')
const WEBP = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
])
const MP3 = Buffer.from('49443304000000000000', 'hex')
const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(8)])
const READ_SIZE = 128 * 1024

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-agent-output-'))
  const workdir = path.join(directory, 'workspace')
  const output = path.join(workdir, '.meldwork-output')
  fs.mkdirSync(output, { recursive: true })
  let sequence = 0
  const store = new AttachmentStore({
    rootPath: path.join(directory, 'attachments'),
    createId: () => `generated-${++sequence}`,
  })
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return { directory, workdir, output, store }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

test('imports only new or changed top-level attachments from the controlled output directory', (t) => {
  const { directory, workdir, output, store } = fixture(t)
  fs.writeFileSync(path.join(output, 'old.png'), PNG)
  fs.writeFileSync(path.join(output, 'ignore.txt'), 'not media')
  const baseline = captureAgentOutputState(workdir)
  const startedAt = Date.now()

  fs.writeFileSync(path.join(output, 'poster.png'), PNG)
  fs.writeFileSync(path.join(output, 'voice.mp3'), MP3)
  fs.writeFileSync(path.join(output, 'demo.mp4'), MP4)
  fs.writeFileSync(path.join(output, 'report.pdf'), '%PDF-1.7\n')
  fs.writeFileSync(path.join(output, 'renamed.jpg'), PNG)
  fs.mkdirSync(path.join(output, 'nested'))
  fs.writeFileSync(path.join(output, 'nested', 'hidden.png'), PNG)
  if (process.platform !== 'win32') {
    const outside = path.join(directory, 'outside.png')
    fs.writeFileSync(outside, PNG)
    fs.symlinkSync(outside, path.join(output, 'linked.png'))
  }

  const imported = importAgentOutputs({ workdir, baseline, startedAt }, store)

  assert.deepEqual(imported.map(item => item.name).sort(), [
    'demo.mp4', 'poster.png', 'report.pdf', 'voice.mp3',
  ])
  assert.equal(imported.length, 4)
  assert.equal(imported.some(item => item.name === 'old.png'), false)
  assert.equal(imported.some(item => item.name === 'hidden.png'), false)
  assert.equal(imported.some(item => item.name === 'linked.png'), false)
})

test('imports generated GIF and WebP media for conversation previews', (t) => {
  const { workdir, output, store } = fixture(t)
  const baseline = captureAgentOutputState(workdir)
  const startedAt = Date.now()
  fs.writeFileSync(path.join(output, 'animation.gif'), GIF)
  fs.writeFileSync(path.join(output, 'preview.webp'), WEBP)

  const imported = importAgentOutputs({ workdir, baseline, startedAt }, store)

  assert.deepEqual(imported.map(item => [item.name, item.mimeType]).sort(), [
    ['animation.gif', 'image/gif'],
    ['preview.webp', 'image/webp'],
  ])
})

test('requires a matching pre-run baseline and refuses symlinked output directories', {
  skip: process.platform === 'win32',
}, (t) => {
  const { directory, workdir, output, store } = fixture(t)
  fs.writeFileSync(path.join(output, 'poster.png'), PNG)

  assert.deepEqual(importAgentOutputs({ workdir, baseline: null, startedAt: Date.now() }, store), [])

  fs.rmSync(output, { recursive: true })
  const outside = path.join(directory, 'outside-output')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'outside.png'), PNG)
  fs.symlinkSync(outside, output)

  assert.deepEqual(captureAgentOutputState(workdir).files, {})
  assert.deepEqual(importAgentOutputs({
    workdir,
    baseline: { workdirRealPath: fs.realpathSync(workdir), files: {} },
    startedAt: Date.now(),
  }, store), [])
})

test('stops importing generated media when the run is aborted', (t) => {
  const { workdir, output } = fixture(t)
  const baseline = captureAgentOutputState(workdir)
  const startedAt = Date.now()
  fs.writeFileSync(path.join(output, 'first.png'), PNG)
  fs.writeFileSync(path.join(output, 'second.png'), PNG)

  const alreadyStopped = new AbortController()
  alreadyStopped.abort()
  const calls = []
  const store = {
    importFile(filename) {
      calls.push(filename)
      return { name: path.basename(filename) }
    },
  }
  assert.deepEqual(importAgentOutputs({
    workdir, baseline, startedAt, signal: alreadyStopped.signal,
  }, store), [])
  assert.equal(calls.length, 0)

  const controller = new AbortController()
  store.importFile = (filename) => {
    calls.push(filename)
    controller.abort()
    return { name: path.basename(filename) }
  }
  const imported = importAgentOutputs({
    workdir, baseline, startedAt, signal: controller.signal,
  }, store)

  assert.equal(imported.length, 1)
  assert.equal(calls.length, 1)
})

test('captures changed artifact types as deterministic workspace-relative snapshots', (t) => {
  const { workdir, output } = fixture(t)
  fs.writeFileSync(path.join(output, 'unchanged.txt'), 'before')
  fs.writeFileSync(path.join(output, 'mtime-only.md'), 'same content')
  const baseline = captureArtifactOutputState(workdir)
  const mtimeOnly = path.join(output, 'mtime-only.md')
  fs.utimesSync(mtimeOnly, new Date(), new Date(Date.now() + 5000))
  fs.writeFileSync(path.join(output, 'unchanged.txt'), 'after')
  fs.mkdirSync(path.join(output, 'docs'))
  const expected = new Map([
    ['bundle.zip', ['bundle', 'application/zip', Buffer.from('bundle')]],
    ['code.js', ['file', 'text/javascript', Buffer.from('export const value = 1\n')]],
    ['data.json', ['structured-data', 'application/json', Buffer.from('{"ok":true}')]],
    ['docs/report.md', ['document', 'text/markdown', Buffer.from('# Report\n')]],
    ['image.png', ['media', 'image/png', PNG]],
    ['result.patch', ['diff', 'text/x-diff', Buffer.from('--- a\n+++ b\n')]],
    ['unchanged.txt', ['document', 'text/plain', Buffer.from('after')]],
    ['unknown.bin', ['file', 'application/octet-stream', Buffer.from('binary')]],
  ])
  for (const [relativePath, [, , bytes]] of expected) {
    const filename = path.join(output, ...relativePath.split('/'))
    fs.writeFileSync(filename, bytes)
  }

  const artifacts = captureAgentOutcomeDescriptors({ workdir, baseline })

  assert.deepEqual(
    artifacts.map(item => item.locationRef.path),
    [...expected.keys()].map(value => `.meldwork-output/${value}`),
  )
  assert.equal(artifacts.some(item => item.name === 'mtime-only.md'), false)
  artifacts.forEach((artifact) => {
    const relativePath = artifact.locationRef.path.slice('.meldwork-output/'.length)
    const [type, mediaType, bytes] = expected.get(relativePath)
    assert.equal(artifact.type, type)
    assert.equal(artifact.mediaType, mediaType)
    assert.equal(artifact.name, path.posix.basename(relativePath))
    assert.deepEqual(artifact.content, bytes)
    assert.equal(artifact.contentHash, sha256(bytes))
    assert.equal(artifact.size, bytes.length)
    assert.equal(Number.isFinite(artifact.mtimeMs), true)
    assert.deepEqual(Object.keys(artifact.locationRef).sort(), ['kind', 'path'])
    assert.equal(Object.hasOwn(artifact, 'path'), false)
  })
  assert.equal(JSON.stringify(artifacts).includes(workdir), false)
})

test('accepts an absent output directory baseline but rejects forged traversal baselines', (t) => {
  const { workdir, output } = fixture(t)
  fs.rmSync(output, { recursive: true })
  const baseline = captureArtifactOutputState(workdir)
  assert.equal(baseline.complete, true)
  assert.deepEqual(baseline.files, [])
  fs.mkdirSync(output)
  fs.writeFileSync(path.join(output, 'created.md'), 'created after baseline')

  assert.deepEqual(
    captureAgentOutcomeDescriptors({ workdir, baseline }).map(item => item.name),
    ['created.md'],
  )
  const forged = {
    ...baseline,
    files: [{
      relativePath: '../outside.txt',
      size: 1,
      mtimeMs: 1,
      ctimeMs: 1,
      contentHash: '0'.repeat(64),
    }],
  }
  assert.deepEqual(captureAgentOutcomeDescriptors({ workdir, baseline: forged }), [])
  assert.deepEqual(captureAgentOutcomeDescriptors({
    workdir,
    baseline: { ...baseline, workdirRealPath: path.dirname(workdir) },
  }), [])
})

test('never follows artifact file, directory, or output-root symlinks', {
  skip: process.platform === 'win32',
}, (t) => {
  const { directory, workdir, output } = fixture(t)
  const baseline = captureArtifactOutputState(workdir)
  const outsideFile = path.join(directory, 'outside.txt')
  const outsideDirectory = path.join(directory, 'outside-directory')
  fs.writeFileSync(outsideFile, 'outside')
  fs.mkdirSync(outsideDirectory)
  fs.writeFileSync(path.join(outsideDirectory, 'nested.txt'), 'outside nested')
  fs.writeFileSync(path.join(output, 'inside.txt'), 'inside')
  fs.symlinkSync(outsideFile, path.join(output, 'linked.txt'))
  fs.symlinkSync(outsideDirectory, path.join(output, 'linked-directory'))

  assert.deepEqual(
    captureAgentOutcomeDescriptors({ workdir, baseline }).map(item => item.name),
    ['inside.txt'],
  )

  fs.rmSync(output, { recursive: true })
  fs.symlinkSync(outsideDirectory, output)
  assert.deepEqual(captureAgentOutcomeDescriptors({ workdir, baseline }), [])
  assert.equal(captureArtifactOutputState(workdir).complete, false)
})

test('enforces artifact count, per-file, total-byte, scan, and abort bounds', (t) => {
  const { workdir, output } = fixture(t)
  const baseline = captureArtifactOutputState(workdir, {
    limits: {
      maxFiles: 10,
      maxFileBytes: 100,
      maxTotalBytes: 100,
      maxScannedEntries: 20,
      maxDepth: 2,
    },
  })
  fs.writeFileSync(path.join(output, 'a.txt'), 'aaaaaa')
  fs.writeFileSync(path.join(output, 'b.txt'), 'bbbbbb')
  fs.writeFileSync(path.join(output, 'c.txt'), 'c')
  fs.writeFileSync(path.join(output, 'oversized.txt'), '123456789')

  assert.deepEqual(captureAgentOutcomeDescriptors({
    workdir,
    baseline,
    limits: { maxFiles: 2 },
  }).map(item => item.name), ['a.txt', 'b.txt'])
  assert.deepEqual(captureAgentOutcomeDescriptors({
    workdir,
    baseline,
    limits: { maxFiles: 10, maxFileBytes: 8, maxTotalBytes: 10 },
  }).map(item => item.name), ['a.txt', 'c.txt'])
  assert.deepEqual(captureAgentOutcomeDescriptors({
    workdir,
    baseline,
    limits: { maxScannedEntries: 2 },
  }), [])

  const controller = new AbortController()
  controller.abort()
  assert.deepEqual(captureAgentOutcomeDescriptors({
    workdir, baseline, signal: controller.signal,
  }), [])
})

test('drops a file that mutates while its artifact snapshot is being read', (t) => {
  const { workdir, output } = fixture(t)
  const baseline = captureArtifactOutputState(workdir)
  const filename = path.join(output, 'changing.bin')
  fs.writeFileSync(filename, Buffer.alloc(READ_SIZE, 0x41))
  const originalReadSync = fs.readSync
  let mutated = false
  fs.readSync = (...args) => {
    const count = originalReadSync(...args)
    if (!mutated && count > 0) {
      mutated = true
      fs.appendFileSync(filename, 'changed')
    }
    return count
  }
  try {
    assert.deepEqual(captureAgentOutcomeDescriptors({ workdir, baseline }), [])
  } finally {
    fs.readSync = originalReadSync
  }
  assert.equal(mutated, true)
})

test('preserves the existing four-media attachment import limit', (t) => {
  const { workdir, output, store } = fixture(t)
  const baseline = captureAgentOutputState(workdir)
  const startedAt = Date.now()
  const names = ['a.png', 'b.png', 'c.png', 'd.png', 'e.png']
  names.forEach((name, index) => {
    const filename = path.join(output, name)
    fs.writeFileSync(filename, PNG)
    const timestamp = new Date(startedAt + ((index + 1) * 1000))
    fs.utimesSync(filename, timestamp, timestamp)
  })

  const imported = importAgentOutputs({ workdir, baseline, startedAt }, store)
  assert.deepEqual(imported.map(item => item.name), ['e.png', 'd.png', 'c.png', 'b.png'])
})

test('reported paths import only files written during the run, outside input staging', (t) => {
  const { workdir, store } = fixture(t)
  const existing = path.join(workdir, 'README.png')
  fs.writeFileSync(existing, PNG)
  const old = new Date(Date.now() - 60 * 60 * 1000)
  fs.utimesSync(existing, old, old)
  const staged = path.join(workdir, '.meldwork-input', '.run-1', 'input.png')
  fs.mkdirSync(path.dirname(staged), { recursive: true })
  fs.writeFileSync(staged, PNG)
  const baseline = captureAgentOutputState(workdir)
  const startedAt = Date.now()
  const written = path.join(workdir, 'charts', 'result chart.png')
  fs.mkdirSync(path.dirname(written), { recursive: true })
  fs.writeFileSync(written, PNG)

  const imported = importAgentOutputs({
    workdir, baseline, startedAt, reportedPaths: [existing, staged, written],
  }, store)

  // A file the Agent only mentioned (or the user's staged input) is not an output.
  assert.deepEqual(imported.map(item => item.name), ['result chart.png'])
})

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const OUTPUT_DIRECTORY = '.meldwork-output'
const MAX_OUTPUT_ATTACHMENTS = 4
const MAX_SCANNED_ENTRIES = 512
const SUPPORTED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp3', '.wav', '.m4a', '.mp4', '.mov', '.webm',
  '.pdf', '.txt', '.md', '.csv', '.json', '.rtf', '.docx', '.xlsx', '.pptx',
])
const ARTIFACT_BASELINE_VERSION = 1
const ARTIFACT_OUTPUT_LIMITS = Object.freeze({
  maxFiles: 32,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxScannedEntries: 512,
  maxDepth: 8,
})
const READ_CHUNK_BYTES = 64 * 1024
const ARTIFACT_FORMATS = new Map([
  ['.md', ['document', 'text/markdown']],
  ['.txt', ['document', 'text/plain']],
  ['.pdf', ['document', 'application/pdf']],
  ['.rtf', ['document', 'application/rtf']],
  ['.html', ['document', 'text/html']],
  ['.htm', ['document', 'text/html']],
  ['.doc', ['document', 'application/msword']],
  ['.docx', ['document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']],
  ['.odt', ['document', 'application/vnd.oasis.opendocument.text']],
  ['.ppt', ['document', 'application/vnd.ms-powerpoint']],
  ['.pptx', ['document', 'application/vnd.openxmlformats-officedocument.presentationml.presentation']],
  ['.diff', ['diff', 'text/x-diff']],
  ['.patch', ['diff', 'text/x-diff']],
  ['.json', ['structured-data', 'application/json']],
  ['.jsonl', ['structured-data', 'application/x-ndjson']],
  ['.ndjson', ['structured-data', 'application/x-ndjson']],
  ['.csv', ['structured-data', 'text/csv']],
  ['.tsv', ['structured-data', 'text/tab-separated-values']],
  ['.xml', ['structured-data', 'application/xml']],
  ['.yaml', ['structured-data', 'application/yaml']],
  ['.yml', ['structured-data', 'application/yaml']],
  ['.toml', ['structured-data', 'application/toml']],
  ['.xlsx', ['structured-data', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']],
  ['.parquet', ['structured-data', 'application/vnd.apache.parquet']],
  ['.sqlite', ['structured-data', 'application/vnd.sqlite3']],
  ['.db', ['structured-data', 'application/vnd.sqlite3']],
  ['.png', ['media', 'image/png']],
  ['.jpg', ['media', 'image/jpeg']],
  ['.jpeg', ['media', 'image/jpeg']],
  ['.gif', ['media', 'image/gif']],
  ['.webp', ['media', 'image/webp']],
  ['.svg', ['media', 'image/svg+xml']],
  ['.mp3', ['media', 'audio/mpeg']],
  ['.wav', ['media', 'audio/wav']],
  ['.m4a', ['media', 'audio/mp4']],
  ['.mp4', ['media', 'video/mp4']],
  ['.mov', ['media', 'video/quicktime']],
  ['.webm', ['media', 'video/webm']],
  ['.zip', ['bundle', 'application/zip']],
  ['.tar', ['bundle', 'application/x-tar']],
  ['.gz', ['bundle', 'application/gzip']],
  ['.tgz', ['bundle', 'application/gzip']],
  ['.7z', ['bundle', 'application/x-7z-compressed']],
  ['.rar', ['bundle', 'application/vnd.rar']],
])
const CODE_MEDIA_TYPES = new Map([
  ['.js', 'text/javascript'], ['.cjs', 'text/javascript'], ['.mjs', 'text/javascript'],
  ['.jsx', 'text/jsx'], ['.ts', 'text/typescript'], ['.tsx', 'text/tsx'],
  ['.py', 'text/x-python'], ['.rb', 'text/x-ruby'], ['.go', 'text/x-go'],
  ['.rs', 'text/x-rust'], ['.java', 'text/x-java-source'], ['.kt', 'text/x-kotlin'],
  ['.kts', 'text/x-kotlin'], ['.c', 'text/x-c'], ['.h', 'text/x-c'],
  ['.cc', 'text/x-c++'], ['.cpp', 'text/x-c++'], ['.hpp', 'text/x-c++'],
  ['.cs', 'text/x-csharp'], ['.swift', 'text/x-swift'], ['.sh', 'text/x-shellscript'],
  ['.bash', 'text/x-shellscript'], ['.zsh', 'text/x-shellscript'],
  ['.ps1', 'text/plain'], ['.sql', 'application/sql'], ['.css', 'text/css'],
  ['.scss', 'text/x-scss'], ['.vue', 'text/plain'], ['.svelte', 'text/plain'],
])

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return Boolean(relative && relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function safeWorkdir(workdir) {
  if (typeof workdir !== 'string' || !path.isAbsolute(workdir) || workdir.length > 4096) return ''
  try {
    const stat = fs.statSync(workdir)
    return stat.isDirectory() ? fs.realpathSync(workdir) : ''
  } catch {
    return ''
  }
}

function safeOutputDirectory(workdirRealPath) {
  if (!workdirRealPath) return ''
  const outputPath = path.join(workdirRealPath, OUTPUT_DIRECTORY)
  try {
    const stat = fs.lstatSync(outputPath)
    if (stat.isSymbolicLink() || !stat.isDirectory()) return ''
    const realPath = fs.realpathSync(outputPath)
    return isInside(workdirRealPath, realPath) ? realPath : ''
  } catch {
    return ''
  }
}

function outputFiles(outputRealPath) {
  if (!outputRealPath) return []
  let entries
  try { entries = fs.readdirSync(outputRealPath, { withFileTypes: true }) } catch { return [] }
  const files = []
  for (const entry of entries.slice(0, MAX_SCANNED_ENTRIES)) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue
    if (!SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
    const filename = path.join(outputRealPath, entry.name)
    try {
      const stat = fs.lstatSync(filename)
      if (!stat.isFile() || stat.isSymbolicLink()) continue
      const realPath = fs.realpathSync(filename)
      if (!isInside(outputRealPath, realPath)) continue
      files.push({
        name: entry.name,
        path: realPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
      })
    } catch { /* a changing output file is skipped until a later run */ }
  }
  return files
}

function captureAgentOutputState(workdir) {
  const workdirRealPath = safeWorkdir(workdir)
  const files = {}
  for (const file of outputFiles(safeOutputDirectory(workdirRealPath))) {
    files[file.name] = {
      size: file.size,
      mtimeMs: file.mtimeMs,
      ctimeMs: file.ctimeMs,
    }
  }
  return { workdirRealPath, files }
}

function sameFileState(left, right) {
  return left && right
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
}

function boundedLimit(value, fallback, minimum = 1) {
  return Number.isSafeInteger(value) && value >= minimum
    ? Math.min(value, fallback)
    : fallback
}

function artifactLimits(value = {}, ceiling = ARTIFACT_OUTPUT_LIMITS) {
  const requested = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    maxFiles: boundedLimit(requested.maxFiles, ceiling.maxFiles),
    maxFileBytes: boundedLimit(requested.maxFileBytes, ceiling.maxFileBytes),
    maxTotalBytes: boundedLimit(requested.maxTotalBytes, ceiling.maxTotalBytes),
    maxScannedEntries: boundedLimit(requested.maxScannedEntries, ceiling.maxScannedEntries),
    maxDepth: boundedLimit(requested.maxDepth, ceiling.maxDepth, 0),
  }
}

function safeArtifactSegment(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 240
    && value !== '.' && value !== '..'
    && !/[\u0000-\u001f\u007f/\\]/.test(value)
}

function compareArtifactPaths(left, right) {
  return left.relativePath < right.relativePath
    ? -1
    : (left.relativePath > right.relativePath ? 1 : 0)
}

function artifactFiles(outputRealPath, limits) {
  if (!outputRealPath) return { complete: false, files: [] }
  const files = []
  let scannedEntries = 0
  let complete = true
  const visit = (directory, segments, depth) => {
    let entries
    try { entries = fs.readdirSync(directory, { withFileTypes: true }) } catch {
      complete = false
      return
    }
    entries.sort((left, right) => (
      left.name < right.name ? -1 : (left.name > right.name ? 1 : 0)
    ))
    for (const entry of entries) {
      scannedEntries += 1
      if (scannedEntries > limits.maxScannedEntries) {
        complete = false
        return
      }
      if (!safeArtifactSegment(entry.name) || entry.isSymbolicLink()) continue
      const nextSegments = [...segments, entry.name]
      const filename = path.join(directory, entry.name)
      let stat
      let realPath
      try {
        stat = fs.lstatSync(filename)
        if (stat.isSymbolicLink()) continue
        realPath = fs.realpathSync(filename)
        if (!isInside(outputRealPath, realPath)) continue
      } catch { continue }
      if (stat.isDirectory()) {
        if (depth >= limits.maxDepth) {
          complete = false
          continue
        }
        visit(realPath, nextSegments, depth + 1)
        if (!complete && scannedEntries > limits.maxScannedEntries) return
        continue
      }
      if (!stat.isFile()) continue
      const relativePath = nextSegments.join('/')
      if (relativePath.length > 1000) continue
      files.push({
        name: entry.name,
        relativePath,
        path: realPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        dev: stat.dev,
        ino: stat.ino,
      })
    }
  }
  visit(outputRealPath, [], 0)
  return { complete, files: files.sort(compareArtifactPaths) }
}

function artifactOutputDirectory(workdirRealPath) {
  if (!workdirRealPath) return { safe: false, path: '' }
  const outputPath = path.join(workdirRealPath, OUTPUT_DIRECTORY)
  try {
    const stat = fs.lstatSync(outputPath)
    if (stat.isSymbolicLink() || !stat.isDirectory()) return { safe: false, path: '' }
    const realPath = fs.realpathSync(outputPath)
    return isInside(workdirRealPath, realPath)
      ? { safe: true, path: realPath }
      : { safe: false, path: '' }
  } catch (error) {
    return error.code === 'ENOENT'
      ? { safe: true, path: '' }
      : { safe: false, path: '' }
  }
}

function stableArtifactSnapshot(file, outputRealPath, maxFileBytes, signal = null) {
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > maxFileBytes) return null
  const noFollow = process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW || 0)
  let descriptor
  try {
    descriptor = fs.openSync(file.path, fs.constants.O_RDONLY | noFollow)
    const before = fs.fstatSync(descriptor)
    if (!before.isFile() || before.size !== file.size
        || before.dev !== file.dev || before.ino !== file.ino
        || before.mtimeMs !== file.mtimeMs || before.ctimeMs !== file.ctimeMs) return null
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      if (signal?.aborted) return null
      const count = fs.readSync(
        descriptor,
        bytes,
        offset,
        Math.min(READ_CHUNK_BYTES, bytes.length - offset),
        offset,
      )
      if (count <= 0) return null
      offset += count
    }
    const after = fs.fstatSync(descriptor)
    if (after.size !== before.size || after.dev !== before.dev || after.ino !== before.ino
        || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return null
    const finalStat = fs.lstatSync(file.path)
    if (!finalStat.isFile() || finalStat.isSymbolicLink()
        || finalStat.dev !== after.dev || finalStat.ino !== after.ino) return null
    const finalPath = fs.realpathSync(file.path)
    if (!isInside(outputRealPath, finalPath) || finalPath !== file.path) return null
    return {
      bytes,
      contentHash: crypto.createHash('sha256').update(bytes).digest('hex'),
      size: after.size,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
    }
  } catch {
    return null
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch { /* already closed */ }
    }
  }
}

function artifactFormat(name) {
  const extension = path.extname(name).toLowerCase()
  if (ARTIFACT_FORMATS.has(extension)) {
    const [type, mediaType] = ARTIFACT_FORMATS.get(extension)
    return { type, mediaType }
  }
  if (CODE_MEDIA_TYPES.has(extension)) {
    return { type: 'file', mediaType: CODE_MEDIA_TYPES.get(extension) }
  }
  return { type: 'file', mediaType: 'application/octet-stream' }
}

function validArtifactBaseline(value, workdirRealPath) {
  if (value?.version !== ARTIFACT_BASELINE_VERSION
      || value.workdirRealPath !== workdirRealPath
      || value.complete !== true
      || !Array.isArray(value.files)
      || value.files.length > ARTIFACT_OUTPUT_LIMITS.maxScannedEntries) return false
  const paths = value.files.map(file => file?.relativePath)
  return new Set(paths).size === paths.length
    && paths.every((item, index) => index === 0 || paths[index - 1] < item)
    && value.files.every(file => (
      file && typeof file === 'object' && !Array.isArray(file)
      && typeof file.relativePath === 'string' && file.relativePath.length <= 1000
      && file.relativePath.split('/').every(safeArtifactSegment)
      && Number.isSafeInteger(file.size) && file.size >= 0
      && Number.isFinite(file.mtimeMs) && Number.isFinite(file.ctimeMs)
      && (file.contentHash === null
        || (typeof file.contentHash === 'string' && /^[a-f0-9]{64}$/.test(file.contentHash)))
    ))
}

function captureArtifactOutputState(workdir, options = {}) {
  const workdirRealPath = safeWorkdir(workdir)
  const limits = artifactLimits(options.limits)
  const output = artifactOutputDirectory(workdirRealPath)
  const scanned = output.path
    ? artifactFiles(output.path, limits)
    : { complete: output.safe, files: [] }
  const files = []
  let capturedBytes = 0
  if (scanned.complete && !options.signal?.aborted) {
    for (const file of scanned.files) {
      if (options.signal?.aborted) break
      let snapshot = null
      if (file.size <= limits.maxFileBytes
          && capturedBytes + file.size <= limits.maxTotalBytes) {
        snapshot = stableArtifactSnapshot(
          file, output.path, limits.maxFileBytes, options.signal,
        )
        if (snapshot) capturedBytes += snapshot.size
      }
      files.push({
        relativePath: file.relativePath,
        size: file.size,
        mtimeMs: file.mtimeMs,
        ctimeMs: file.ctimeMs,
        contentHash: snapshot?.contentHash || null,
      })
    }
  }
  return {
    version: ARTIFACT_BASELINE_VERSION,
    workdirRealPath,
    complete: Boolean(workdirRealPath && output.safe && scanned.complete && !options.signal?.aborted),
    limits,
    files,
  }
}

function captureAgentOutcomeDescriptors(input = {}) {
  if (input.signal?.aborted) return []
  const workdirRealPath = safeWorkdir(input.workdir)
  if (!workdirRealPath || !validArtifactBaseline(input.baseline, workdirRealPath)) return []
  const baselineLimits = artifactLimits(input.baseline.limits)
  const limits = artifactLimits(input.limits, baselineLimits)
  const output = artifactOutputDirectory(workdirRealPath)
  if (!output.path) return []
  const scanned = artifactFiles(output.path, limits)
  if (!scanned.complete) return []
  const baselineFiles = new Map(input.baseline.files.map(file => [file.relativePath, file]))
  const artifacts = []
  let totalBytes = 0
  for (const file of scanned.files) {
    if (input.signal?.aborted || artifacts.length >= limits.maxFiles) break
    const previous = baselineFiles.get(file.relativePath)
    if (sameFileState(previous, file)) continue
    if (file.size > limits.maxFileBytes || totalBytes + file.size > limits.maxTotalBytes) continue
    const snapshot = stableArtifactSnapshot(file, output.path, limits.maxFileBytes, input.signal)
    if (!snapshot || snapshot.contentHash === previous?.contentHash) continue
    if (totalBytes + snapshot.size > limits.maxTotalBytes) continue
    const format = artifactFormat(file.name)
    artifacts.push({
      type: format.type,
      name: file.name,
      mediaType: format.mediaType,
      content: snapshot.bytes,
      contentHash: snapshot.contentHash,
      locationRef: {
        kind: 'workspace-relative',
        path: `${OUTPUT_DIRECTORY}/${file.relativePath}`,
      },
      size: snapshot.size,
      mtimeMs: snapshot.mtimeMs,
    })
    totalBytes += snapshot.size
  }
  return artifacts
}

function importAgentOutputs(input, attachmentStore) {
  if (input?.signal?.aborted) return []
  if (!input?.baseline || !attachmentStore || typeof attachmentStore.importFile !== 'function') return []
  const workdirRealPath = safeWorkdir(input.workdir)
  if (!workdirRealPath || input.baseline.workdirRealPath !== workdirRealPath) return []
  const startedAt = Number(input.startedAt)
  if (!Number.isFinite(startedAt) || startedAt <= 0) return []
  const baselineFiles = input.baseline.files && typeof input.baseline.files === 'object'
    && !Array.isArray(input.baseline.files)
    ? input.baseline.files
    : {}
  const controlledCandidates = outputFiles(safeOutputDirectory(workdirRealPath))
    .filter(file => !sameFileState(baselineFiles[file.name], file))
    .filter(file => Math.max(file.mtimeMs, file.ctimeMs) >= startedAt - 2000)
    .sort((left, right) => (
      Math.max(right.mtimeMs, right.ctimeMs) - Math.max(left.mtimeMs, left.ctimeMs)
      || left.name.localeCompare(right.name)
    ))

  const reportedCandidates = []
  const reportedPaths = Array.isArray(input.reportedPaths) ? input.reportedPaths : []
  for (const reportedPath of reportedPaths.slice(0, MAX_SCANNED_ENTRIES)) {
    if (typeof reportedPath !== 'string' || !path.isAbsolute(reportedPath)) continue
    try {
      const realPath = fs.realpathSync(reportedPath)
      const stat = fs.statSync(realPath)
      const extension = path.extname(realPath).toLowerCase()
      // A path the Agent merely mentioned (a file it read, the user's input,
      // a staged attachment) is not an output. Only files written during this
      // run outside the input staging folder are imported.
      if (!stat.isFile() || !SUPPORTED_EXTENSIONS.has(extension)
          || stat.size > 64 * 1024 * 1024 || !isInside(workdirRealPath, realPath)
          || realPath.split(path.sep).includes('.meldwork-input')
          || stat.mtimeMs < startedAt - 2000) continue
      reportedCandidates.push({
        name: path.basename(realPath), path: realPath, size: stat.size,
        mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
      })
    } catch { /* reported paths are best effort */ }
  }
  const candidates = [...controlledCandidates, ...reportedCandidates]
    .filter((file, index, all) => all.findIndex(candidate => candidate.path === file.path) === index)

  const imported = []
  if (input.signal?.aborted) return imported
  for (const file of candidates) {
    if (input.signal?.aborted || imported.length >= MAX_OUTPUT_ATTACHMENTS) break
    try { imported.push(attachmentStore.importFile(file.path)) } catch { /* invalid media is ignored */ }
  }
  return imported
}

module.exports = {
  ARTIFACT_OUTPUT_LIMITS,
  captureArtifactOutputState,
  captureAgentOutcomeDescriptors,
  captureAgentOutputState,
  importAgentOutputs,
}

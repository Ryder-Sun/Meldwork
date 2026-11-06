const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { atomicWritePrivateFile, ensurePrivateDirectory } = require('../security/private-file.cjs')
const { TERMINAL_STATUSES, cleanId, isRecord } = require('./run-ledger-records.cjs')

function syncDirectory(directory) {
  let fd
  try {
    fd = fs.openSync(directory, 'r')
    fs.fsyncSync(fd)
  } catch (error) {
    const unsupported = ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)
      || (process.platform === 'win32' && ['EPERM', 'EISDIR'].includes(error.code))
    if (!unsupported) throw error
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

class RunTerminalOutbox {
  constructor(storagePath) {
    this.root = `${storagePath}.terminal-outbox`
  }

  filename(runId) {
    if (!cleanId(runId) || cleanId(runId) !== runId) throw new Error('RUN_TERMINAL_OUTBOX_INVALID')
    return path.join(this.root, `${crypto.createHash('sha256').update(runId).digest('hex')}.json`)
  }

  read(filename) {
    const stat = fs.lstatSync(filename)
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > 64 * 1024 * 1024
        || (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600)) {
      throw new Error('RUN_TERMINAL_OUTBOX_INVALID')
    }
    const noFollow = process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW || 0)
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | noFollow)
    try {
      const opened = fs.fstatSync(fd)
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size
          || (process.platform !== 'win32' && (opened.mode & 0o777) !== 0o600)) {
        throw new Error('RUN_TERMINAL_OUTBOX_INVALID')
      }
      const data = JSON.parse(fs.readFileSync(fd, 'utf8'))
      if (!isRecord(data) || Object.keys(data).sort().join(',') !== 'record,version'
          || data.version !== 1 || !isRecord(data.record)
          || !TERMINAL_STATUSES.has(data.record.status)
          || this.filename(data.record.runId) !== filename) throw new Error('RUN_TERMINAL_OUTBOX_INVALID')
      return data.record
    } finally { fs.closeSync(fd) }
  }

  prepare(record) {
    if (!isRecord(record) || !TERMINAL_STATUSES.has(record.status)) throw new Error('RUN_TERMINAL_OUTBOX_INVALID')
    ensurePrivateDirectory(this.root)
    syncDirectory(path.dirname(this.root))
    const filename = this.filename(record.runId)
    if (fs.existsSync(filename)) {
      const previous = this.read(filename)
      if (previous.status !== record.status || previous.groupId !== record.groupId
          || previous.taskId !== record.taskId || previous.contextPackId !== record.contextPackId) {
        throw new Error('RUN_TERMINAL_OUTBOX_CONFLICT')
      }
      return previous
    }
    const serialized = `${JSON.stringify({ version: 1, record })}\n`
    if (Buffer.byteLength(serialized) > 64 * 1024 * 1024) throw new Error('RUN_TERMINAL_OUTBOX_INVALID')
    atomicWritePrivateFile(filename, serialized)
    return record
  }

  list() {
    try { fs.lstatSync(this.root) } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
    ensurePrivateDirectory(this.root)
    const names = fs.readdirSync(this.root).filter(name => name.endsWith('.json'))
    if (names.some(name => !/^[a-f0-9]{64}\.json$/.test(name))) {
      throw new Error('RUN_TERMINAL_OUTBOX_INVALID')
    }
    return names.sort().map(name => this.read(path.join(this.root, name)))
  }

  remove(runId) {
    try { fs.lstatSync(this.root) } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    ensurePrivateDirectory(this.root)
    try { fs.unlinkSync(this.filename(runId)) } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    syncDirectory(this.root)
  }
}

module.exports = { RunTerminalOutbox }

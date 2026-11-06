const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

function atomicWritePrivateFile(filename, contents) {
  const directory = path.dirname(filename)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filename)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  )
  let descriptor
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600)
    fs.writeFileSync(descriptor, contents, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.chmodSync(temporaryPath, 0o600)
    fs.renameSync(temporaryPath, filename)
    let directoryDescriptor
    try {
      directoryDescriptor = fs.openSync(directory, 'r')
      fs.fsyncSync(directoryDescriptor)
    } catch (error) {
      const unsupported = ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)
        || (process.platform === 'win32' && ['EPERM', 'EISDIR'].includes(error.code))
      if (!unsupported) throw error
    } finally {
      if (directoryDescriptor !== undefined) fs.closeSync(directoryDescriptor)
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch { /* already closed */ }
    }
    try { fs.unlinkSync(temporaryPath) } catch { /* absent or already renamed */ }
    throw error
  }
}

module.exports = { atomicWritePrivateFile }

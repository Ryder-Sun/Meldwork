const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { atomicWritePrivateFile, ensurePrivateDirectory } = require('../../src/security/private-file.cjs')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-private-file-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('managed private directories repair broad permissions without changing their parent', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX permissions are not Windows ACLs')
  const directory = fixture(t)
  const managed = path.join(directory, 'managed')
  fs.mkdirSync(managed)
  fs.chmodSync(directory, 0o755)
  fs.chmodSync(managed, 0o755)
  ensurePrivateDirectory(managed)
  assert.equal(fs.statSync(managed).mode & 0o777, 0o700)
  assert.equal(fs.statSync(directory).mode & 0o777, 0o755)
})

test('managed private directories reject symlinks without changing their targets', (t) => {
  if (process.platform === 'win32') return t.skip('creating directory symlinks can require elevated privileges')
  const directory = fixture(t)
  const target = path.join(directory, 'target')
  const link = path.join(directory, 'link')
  fs.mkdirSync(target)
  fs.chmodSync(target, 0o755)
  fs.symlinkSync(target, link)
  assert.throws(() => ensurePrivateDirectory(link), { message: 'PRIVATE_DIRECTORY_INVALID' })
  assert.equal(fs.statSync(target).mode & 0o777, 0o755)
})

test('atomic writes do not change permissions of an arbitrary caller directory', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX permissions are not Windows ACLs')
  const directory = fixture(t)
  fs.chmodSync(directory, 0o755)
  atomicWritePrivateFile(path.join(directory, 'private.json'), 'data')
  assert.equal(fs.statSync(directory).mode & 0o777, 0o755)
})

test('private file writes replace contents atomically with restrictive permissions', (t) => {
  const directory = fixture(t)
  const filename = path.join(directory, 'nested', 'private.json')

  atomicWritePrivateFile(filename, 'first')
  atomicWritePrivateFile(filename, 'second')

  assert.equal(fs.readFileSync(filename, 'utf8'), 'second')
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600)
  assert.deepEqual(fs.readdirSync(path.dirname(filename)), ['private.json'])
})

test('private file writes sync the parent directory after replacement', (t) => {
  if (process.platform === 'win32') return t.skip('directory handles are not portable on Windows')
  const directory = fixture(t)
  const filename = path.join(directory, 'private.json')
  const original = fs.fsyncSync
  const types = []
  fs.fsyncSync = fd => { types.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file'); return original(fd) }
  t.after(() => { fs.fsyncSync = original })
  atomicWritePrivateFile(filename, 'durable')
  assert.deepEqual(types, ['file', 'directory'])
  assert.equal(fs.readFileSync(filename, 'utf8'), 'durable')
})

test('directory sync failures are surfaced rather than reported as durable writes', (t) => {
  if (process.platform === 'win32') return t.skip('directory handles are not portable on Windows')
  const directory = fixture(t)
  const filename = path.join(directory, 'private.json')
  const original = fs.fsyncSync
  fs.fsyncSync = fd => {
    if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('DIRECTORY_SYNC_FAILED'), { code: 'EIO' })
    return original(fd)
  }
  t.after(() => { fs.fsyncSync = original })
  assert.throws(() => atomicWritePrivateFile(filename, 'data'), { message: 'DIRECTORY_SYNC_FAILED' })
  assert.equal(fs.readFileSync(filename, 'utf8'), 'data')
})

test('private file writes remove their temporary file when replacement fails', (t) => {
  const directory = fixture(t)
  const filename = path.join(directory, 'occupied')
  fs.mkdirSync(filename)

  assert.throws(() => atomicWritePrivateFile(filename, 'blocked'))
  assert.deepEqual(fs.readdirSync(directory), ['occupied'])
})

test('permission failures leave the previous destination unchanged', (t) => {
  const directory = fixture(t)
  const filename = path.join(directory, 'private.json')
  atomicWritePrivateFile(filename, 'first')
  const chmodSync = fs.chmodSync
  fs.chmodSync = () => { throw new Error('CHMOD_FAILED') }
  t.after(() => { fs.chmodSync = chmodSync })

  assert.throws(
    () => atomicWritePrivateFile(filename, 'second'),
    { message: 'CHMOD_FAILED' },
  )
  assert.equal(fs.readFileSync(filename, 'utf8'), 'first')
  assert.deepEqual(fs.readdirSync(directory), ['private.json'])
})

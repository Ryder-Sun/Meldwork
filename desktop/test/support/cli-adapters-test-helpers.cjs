const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function executable(directory, name, source) {
  const filename = path.join(directory, name)
  fs.writeFileSync(filename, `#!/usr/bin/env node\n${source}`)
  fs.chmodSync(filename, 0o755)
  return filename
}

function workBuddyInstall(t, bundles) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-workbuddy-layout-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'bin'))
  fs.mkdirSync(path.join(root, 'dist'))
  const launcher = executable(path.join(root, 'bin'), 'codebuddy', '')
  for (const name of bundles) fs.writeFileSync(path.join(root, 'dist', name), '')
  return launcher
}

async function readWhenReady(filename, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const value = fs.readFileSync(filename, 'utf8')
      if (value) return value
    } catch {
      // Wait for the writer to create the file.
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${filename}`)
}

async function readJsonWhenReady(filename, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const value = fs.readFileSync(filename, 'utf8')
      if (value) return JSON.parse(value)
    } catch { /* wait for the writer to finish */ }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for complete JSON in ${filename}`)
}

async function within(promise, timeoutMs = 3000) {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Agent cancellation did not settle.')), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

async function waitForExit(pid, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') return
      throw error
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Process ${pid} did not exit.`)
}

module.exports = {
  executable,
  readJsonWhenReady,
  readWhenReady,
  waitForExit,
  within,
  workBuddyInstall,
}

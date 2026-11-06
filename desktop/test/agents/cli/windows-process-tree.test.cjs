const test = require('node:test')
const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const { once } = require('node:events')

test('Windows cancellation terminates a real process and its descendant', {
  skip: process.platform !== 'win32', timeout: 30000,
}, async t => {
  const { terminateWindowsProcessTree } = require('../../../src/agents/cli/cli-process-support.cjs')
  const child = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process')
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    descendant.once('spawn', () => process.send(descendant.pid))
    setInterval(() => {}, 1000)
  `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true })
  let descendantPid
  t.after(() => {
    for (const pid of [child.pid, descendantPid]) {
      if (!pid) continue
      try { execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch {}
    }
  })
  ;[descendantPid] = await once(child, 'message', { signal: AbortSignal.timeout(10000) })
  assert.ok(Number.isInteger(descendantPid) && descendantPid > 0)
  await terminateWindowsProcessTree(child, spawn, 10000)
  assert.ok(child.exitCode !== null || child.signalCode !== null)
  assert.throws(() => process.kill(descendantPid, 0), { code: 'ESRCH' })
})

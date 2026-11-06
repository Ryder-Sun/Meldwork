const { spawn } = require('node:child_process')
const net = require('node:net')
const path = require('node:path')

const {
  KILL_SETTLE_MS,
  terminateWindowsProcessTree,
  TERMINATE_GRACE_MS,
  childEnvironment,
} = require('./cli-process-support.cjs')
const {
  configureOpenClawGatewayRuntime,
  refreshOpenClawRuntimeAfterStartup,
} = require('./openclaw-runtime.cjs')

const GATEWAY_READY_MARKER = '[gateway] ready'
const GATEWAY_READY_TIMEOUT_MS = 15_000
const GATEWAY_HEALTH_TIMEOUT_MS = 7_500
const GATEWAY_HEALTH_OUTPUT_BYTES = 64 * 1024
const GATEWAY_SETUP_ATTEMPTS = 3
const OPENCLAW_GLOBAL_ARGS = Object.freeze(['--no-color', '--log-level', 'info'])

function gatewayStartError(retryable = false) {
  const error = new Error('OPENCLAW_GATEWAY_START_FAILED')
  error.retryable = retryable
  Object.defineProperty(error, 'acpFallbackAllowed', { value: true })
  return error
}

function isPortConflict(value) {
  return /EADDRINUSE|address already in use|port[^\n]{0,80}(?:busy|in use)/i
    .test(String(value || ''))
}

function attachRuntimeOptions(error, runtimeOptions) {
  if (error && (typeof error === 'object' || typeof error === 'function')) {
    Object.defineProperty(error, 'openClawRuntimeOptions', {
      value: {
        env: runtimeOptions.env,
        openClawRuntimeGuard: runtimeOptions.openClawRuntimeGuard,
      },
    })
  }
  return error
}

async function availableLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    const finish = (error, port) => {
      server.removeAllListeners()
      if (error) reject(error)
      else resolve(port)
    }
    server.once('error', error => finish(error))
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address()
      const port = address && typeof address === 'object' ? address.port : 0
      server.close(error => finish(error, port))
    })
    server.unref()
  })
}

async function terminateGateway(child, platform = process.platform) {
  if (!child || child.exitCode != null || child.signalCode != null) return
  if (platform === 'win32') {
    try { await terminateWindowsProcessTree(child, spawn) } finally {
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        if (stream && !stream.destroyed) stream.destroy()
      }
    }
    return
  }
  await new Promise((resolve) => {
    let settled = false
    let forceKillTimeout
    let forceSettleTimeout
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(forceKillTimeout)
      clearTimeout(forceSettleTimeout)
      child.removeListener('close', finish)
      child.removeListener('error', finish)
      resolve()
    }
    child.once('close', finish)
    child.once('error', finish)
    const signalTree = (signal) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal)
          return
        } catch { /* fall back to the direct child */ }
      }
      try { child.kill(signal) } catch { /* the process has already exited */ }
    }
    signalTree('SIGTERM')
    forceKillTimeout = setTimeout(() => signalTree('SIGKILL'), TERMINATE_GRACE_MS)
    forceSettleTimeout = setTimeout(finish, TERMINATE_GRACE_MS + KILL_SETTLE_MS)
  })
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    if (stream && !stream.destroyed) stream.destroy()
  }
}

async function waitForGatewayReady(child, signal) {
  return new Promise((resolve, reject) => {
    let settled = false
    let output = ''
    const timeout = setTimeout(
      () => finish(gatewayStartError()),
      GATEWAY_READY_TIMEOUT_MS,
    )
    const cleanup = () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      child.stdout?.removeListener('data', onData)
      child.stderr?.removeListener('data', onData)
      child.removeListener('error', onError)
      child.removeListener('close', onClose)
    }
    const finish = (error) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else {
        child.on('error', () => {})
        child.stdout?.resume()
        child.stderr?.resume()
        resolve()
      }
    }
    const onData = (chunk) => {
      output = `${output}${chunk.toString('utf8')}`.slice(-8192)
      if (output.includes(GATEWAY_READY_MARKER)) finish()
    }
    const onError = error => finish(gatewayStartError(
      error?.code === 'EADDRINUSE' || isPortConflict(error?.message),
    ))
    const onClose = () => finish(gatewayStartError(isPortConflict(output)))
    const abort = () => finish(new Error('LOCAL_AGENT_EXECUTION_STOPPED'))

    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('error', onError)
    child.once('close', onClose)
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

function gatewayChildAlive(child) {
  return Boolean(child && !child.killed && child.exitCode == null && child.signalCode == null)
}

async function verifyGatewayHealth({
  child: gatewayChild,
  env,
  executable,
  gatewayPort,
  signal,
  workdir,
}) {
  if (!gatewayChildAlive(gatewayChild)) throw gatewayStartError()
  const args = [
    ...OPENCLAW_GLOBAL_ARGS, 'gateway', 'health',
    '--port', String(gatewayPort),
    '--timeout', '5000',
    '--json',
  ]
  let healthChild
  try {
    healthChild = spawn(executable, args, {
      cwd: path.resolve(workdir),
      detached: process.platform !== 'win32',
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
  } catch {
    throw gatewayStartError()
  }

  await new Promise((resolve, reject) => {
    let settled = false
    let stdout = ''
    let stdoutBytes = 0
    const timeout = setTimeout(
      () => finish(gatewayStartError()),
      GATEWAY_HEALTH_TIMEOUT_MS,
    )
    const cleanup = () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      gatewayChild.removeListener('error', onGatewayExit)
      gatewayChild.removeListener('close', onGatewayExit)
      healthChild.stdout?.removeListener('data', onData)
      healthChild.removeListener('error', onHealthError)
      healthChild.removeListener('close', onHealthClose)
    }
    const finish = (error) => {
      if (settled) return
      settled = true
      cleanup()
      const stopHealth = error && gatewayChildAlive(healthChild)
        ? terminateGateway(healthChild)
        : Promise.resolve()
      stopHealth.catch(() => {}).then(() => {
        if (error) reject(error)
        else resolve()
      })
    }
    const onData = (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > GATEWAY_HEALTH_OUTPUT_BYTES) {
        finish(gatewayStartError())
        return
      }
      stdout += chunk.toString('utf8')
    }
    const onGatewayExit = () => finish(gatewayStartError())
    const onHealthError = () => finish(gatewayStartError())
    const onHealthClose = (code) => {
      if (code !== 0 || !gatewayChildAlive(gatewayChild)) {
        finish(gatewayStartError())
        return
      }
      let result
      try { result = JSON.parse(stdout.trim()) } catch { /* handled below */ }
      finish(result?.ok === true ? null : gatewayStartError())
    }
    const abort = () => finish(new Error('LOCAL_AGENT_EXECUTION_STOPPED'))

    healthChild.stdout?.on('data', onData)
    healthChild.once('error', onHealthError)
    healthChild.once('close', onHealthClose)
    gatewayChild.once('error', onGatewayExit)
    gatewayChild.once('close', onGatewayExit)
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

async function withOpenClawGateway(options, callback) {
  if (typeof callback !== 'function') throw new TypeError('OPENCLAW_GATEWAY_CALLBACK_REQUIRED')
  if (typeof options?.executable !== 'string' || !options.executable
      || typeof options?.workdir !== 'string' || !path.isAbsolute(options.workdir)) {
    throw new Error('OPENCLAW_GATEWAY_SCOPE_INVALID')
  }

  let runtimeOptions = options
  for (let attempt = 0; attempt < GATEWAY_SETUP_ATTEMPTS; attempt += 1) {
    if (options.signal?.aborted) throw new Error('LOCAL_AGENT_EXECUTION_STOPPED')
    const gatewayPort = await availableLoopbackPort()
    runtimeOptions = configureOpenClawGatewayRuntime(runtimeOptions, gatewayPort)
    const gatewayUrl = `ws://127.0.0.1:${gatewayPort}`
    const args = [
      ...OPENCLAW_GLOBAL_ARGS, 'gateway', 'run',
      '--bind', 'loopback',
      '--port', String(gatewayPort),
      '--auth', 'token',
      '--tailscale', 'off',
      '--ws-log', 'compact',
    ]
    const gatewayEnv = childEnvironment(
      { kind: 'openclaw' },
      options.workdir,
      runtimeOptions,
      process.platform,
    )
    const child = spawn(options.executable, args, {
      cwd: path.resolve(options.workdir),
      detached: process.platform !== 'win32',
      env: gatewayEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    try {
      await waitForGatewayReady(child, options.signal)
      await verifyGatewayHealth({
        child,
        env: gatewayEnv,
        executable: options.executable,
        gatewayPort,
        signal: options.signal,
        workdir: options.workdir,
      })
      runtimeOptions = refreshOpenClawRuntimeAfterStartup(runtimeOptions)
    } catch (error) {
      await terminateGateway(child)
      // Startup can migrate the config before a port conflict or health failure.
      runtimeOptions = refreshOpenClawRuntimeAfterStartup(runtimeOptions)
      if (error?.retryable && attempt + 1 < GATEWAY_SETUP_ATTEMPTS) continue
      throw attachRuntimeOptions(error, runtimeOptions)
    }

    try {
      return await callback({
        env: runtimeOptions.env,
        gatewayPort,
        gatewayUrl,
        openClawRuntimeGuard: runtimeOptions.openClawRuntimeGuard,
      })
    } catch (error) {
      throw attachRuntimeOptions(error, runtimeOptions)
    } finally {
      await terminateGateway(child)
    }
  }
  throw gatewayStartError()
}

module.exports = { withOpenClawGateway }

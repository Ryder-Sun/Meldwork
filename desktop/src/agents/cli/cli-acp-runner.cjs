const { spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { PassThrough, Readable, Writable } = require('node:stream')
const { AGENT_PROFILES, prepareCommand } = require('./cli-discovery.cjs')
const {
  outcomeForAcpStopReason,
  requireTerminalAgentResult,
} = require('../agent-runtime-contract.cjs')
const {
  createRuntimeEventEmitter,
  redactChildSecrets,
  stripAnsi,
} = require('./cli-runtime-events.cjs')
const { connectorLimitedRuntimeEvent } = require('./cli-event-profiles.cjs')
const {
  KILL_SETTLE_MS,
  TERMINATE_GRACE_MS,
  agentExecutionError,
  childEnvironment,
  failedAgentProcessError,
} = require('./cli-process-support.cjs')
const { createAcpOutboundPayload } = require('../../collaboration/outbound-payload.cjs')
const { redactSecrets } = require('../../security/secret-redaction.cjs')
const { createOutputRepetitionGuard } = require('./cli-output-repetition.cjs')
const { terminalPlanRejection } = require('../agent-permission-policy.cjs')

const ACP_CANCEL_GRACE_MS = 250
// After a stop or timeout the Agent gets this long to answer the cancelled
// prompt. A clean cancellation keeps the long-lived process and its native
// session; only an Agent that ignores cancel is torn down.
const ACP_CANCEL_SETTLE_MS = 3000
// MiMo can flush the last delta of a message just after its prompt response.
const MIMO_TERMINAL_DRAIN_MS = 50
const ACP_INITIALIZE_TIMEOUT_MS = 60 * 1000
const ACP_STDERR_TAIL_BYTES = 64 * 1024
// Process identity must not change when only volatile shell values change.
// Version managers such as fnm put a per-shell directory on PATH, so a fresh
// login-shell capture used to restart the ACP process and drop its session.
const ACP_VOLATILE_ENV_KEYS = new Set([
  'PATH', 'Path', 'TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'TERM_SESSION_ID',
  'SHLVL', 'PWD', 'OLDPWD', '_', 'TMPDIR', 'COLUMNS', 'LINES', 'SHELL',
  'FNM_MULTISHELL_PATH', 'FNM_DIR', 'FNM_VERSION_FILE_STRATEGY', 'FNM_LOGLEVEL',
  'FNM_NODE_DIST_MIRROR', 'FNM_ARCH', 'FNM_COREPACK_ENABLED', 'FNM_RESOLVE_ENGINES',
])
const ACP_MAX_LINE_BYTES = 4 * 1024 * 1024
const ACP_MAX_INPUT_BYTES = 16 * 1024 * 1024
const ACP_UNKNOWN_METHOD_NAME_LIMIT = 120
const ACP_MAX_REPLY_BYTES = 10 * 1024 * 1024
const ACP_PERSISTENT_RUNTIME_LIMIT = 16
const ACP_PERMISSION_OPTION_LIMIT = 16
const ACP_PERMISSION_ORDERING_SETTLE_MS = 25
const ACP_PERMISSION_OPTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const ACP_PERMISSION_OPTION_KINDS = new Set([
  'allow_once', 'allow_always', 'reject_once', 'reject_always',
])
const ACP_TOOL_KINDS = new Set([
  'read', 'edit', 'delete', 'move', 'search',
  'execute', 'think', 'fetch', 'switch_mode', 'other',
])
const ACP_TOOL_STATUSES = new Set(['pending', 'in_progress', 'completed', 'failed'])
let acpSdkPromise
const acpSessionRuntimes = new Map()
const acpRuntimeLocks = new Map()
const acpRuntimePreparations = new Set()
const acpInitializingRuntimes = new Set()
const acpDisposableRuntimes = new Set()
const acpShutdownBarriers = new Set()
let acpShutdownGeneration = 0

function loadAcpSdk() {
  acpSdkPromise ||= Promise.all([
    import('@agentclientprotocol/sdk'),
    import('@agentclientprotocol/sdk/dist/schema/zod.gen.js'),
  ]).then(([sdk, validators]) => ({ ...sdk, validators }))
  return acpSdkPromise
}

function registerAcpShutdownBarrier(signal) {
  const controller = new AbortController()
  const shutdownGeneration = acpShutdownGeneration
  const abort = () => controller.abort()
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  let resolveCompletion
  let completed = false
  const barrier = {
    controller,
    completion: new Promise(resolve => { resolveCompletion = resolve }),
  }
  acpShutdownBarriers.add(barrier)
  return {
    shutdownGeneration,
    signal: controller.signal,
    isCurrent() {
      return shutdownGeneration === acpShutdownGeneration && !controller.signal.aborted
    },
    complete() {
      if (completed) return
      completed = true
      signal?.removeEventListener('abort', abort)
      acpShutdownBarriers.delete(barrier)
      resolveCompletion()
    },
  }
}

function acpTransportError(diagnostic) {
  return agentExecutionError('LOCAL_AGENT_PROCESS_FAILED', diagnostic)
}

// Returns the message to deliver, or null for traffic that is safe to ignore.
// A newer Agent can send updates and notifications this client does not know;
// failing the whole turn over them would break Meldwork on every Agent upgrade,
// so only messages that decide what is executed or approved stay strict.
function validateAcpInboundMessage(message, validators, replyState, protocolLabel) {
  if (!message || typeof message !== 'object' || Array.isArray(message)
      || message.jsonrpc !== '2.0') {
    throw acpTransportError(`${protocolLabel} returned an invalid protocol message.`)
  }

  const hasId = Object.hasOwn(message, 'id')
  if (typeof message.method === 'string') {
    if (message.method === 'session/update' && !hasId) {
      const parsed = validators.zSessionNotification.safeParse(message.params)
      if (!parsed.success) {
        replyState.ignoredMessages = (replyState.ignoredMessages || 0) + 1
        return null
      }
      const update = parsed.data.update
      if (replyState.collecting !== false
          && update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        replyState.bytes += Buffer.byteLength(update.content.text, 'utf8')
        if (replyState.bytes > ACP_MAX_REPLY_BYTES) {
          throw acpTransportError(`${protocolLabel} reply exceeded the safe output limit.`)
        }
      }
      return message
    }
    if (message.method === 'session/request_permission' && hasId) {
      const validId = typeof message.id === 'string'
        || (Number.isInteger(message.id) && message.id >= 0)
      if (!validId || !validators.zRequestPermissionRequest.safeParse(message.params).success) {
        throw acpTransportError(`${protocolLabel} returned an invalid permission request.`)
      }
      return message
    }
    // An unknown request still gets the connection's "method not found"
    // answer, so the Agent is not left waiting. The SDK logs every request it
    // rejects together with its parameters, so only the method name is
    // forwarded. An unknown notification needs no answer and is dropped
    // before it can reach the SDK's logging.
    const validId = typeof message.id === 'string'
      || (Number.isInteger(message.id) && message.id >= 0)
    if (hasId && validId) {
      return {
        jsonrpc: '2.0',
        id: message.id,
        method: message.method.slice(0, ACP_UNKNOWN_METHOD_NAME_LIMIT),
        params: {},
      }
    }
    replyState.ignoredMessages = (replyState.ignoredMessages || 0) + 1
    return null
  }

  if (!Number.isInteger(message.id) || message.id < 0) {
    throw acpTransportError(`${protocolLabel} returned an invalid response identifier.`)
  }
  const hasResult = Object.hasOwn(message, 'result')
  const hasError = Object.hasOwn(message, 'error')
  if (hasResult === hasError) {
    throw acpTransportError(`${protocolLabel} returned an invalid response payload.`)
  }
  if (hasError) {
    const error = message.error
    if (!error || typeof error !== 'object' || Array.isArray(error)
        || !Number.isFinite(error.code) || typeof error.message !== 'string') {
      throw acpTransportError(`${protocolLabel} returned an invalid error response.`)
    }
  }
  return message
}

function createObservedAcpInput(input, replyState, protocolLabel) {
  const output = new PassThrough()
  let pending = Buffer.alloc(0)
  const cleanup = () => {
    input.removeListener('data', onData)
    input.removeListener('end', onEnd)
    input.removeListener('error', onError)
  }
  const onData = (chunk) => {
    replyState.observedInputBytes += chunk.length
    if (replyState.observedInputBytes > ACP_MAX_INPUT_BYTES) {
      output.destroy(acpTransportError(`${protocolLabel} input exceeded the safe total limit.`))
      return
    }
    pending = pending.length
      ? Buffer.concat([pending, chunk], pending.length + chunk.length)
      : Buffer.from(chunk)
    if (pending.length <= ACP_MAX_LINE_BYTES) {
      let newline
      while ((newline = pending.indexOf(0x0a)) !== -1) {
        const line = pending.subarray(0, newline).toString('utf8').trim()
        pending = pending.subarray(newline + 1)
        if (!line) continue
        let message
        try { message = JSON.parse(line) } catch { continue }
        if (message?.method === 'session/request_permission') {
          if (replyState.pendingPermissionRequestIds.has(message.id)) {
            output.destroy(acpTransportError(
              `${protocolLabel} reused an active permission request identifier.`,
            ))
            return
          }
          replyState.pendingPermissionRequestIds.add(message.id)
        } else if (replyState.collecting && !message?.method
            && replyState.promptRequestId != null && message?.id === replyState.promptRequestId
            && replyState.pendingPermissionRequestIds.size) {
          replyState.permissionPendingAtPromptTerminal = true
        }
      }
    } else {
      pending = Buffer.alloc(0)
    }
    output.write(chunk)
  }
  const onEnd = () => output.end()
  const onError = error => output.destroy(error)
  input.on('data', onData)
  input.once('end', onEnd)
  input.once('error', onError)
  output.once('close', cleanup)
  return output
}

function boundedAcpStream(
  output, input, validators,
  replyState = {
    bytes: 0,
    inputBytes: 0,
    collecting: true,
    pendingUpdateSequences: [],
    pendingPermissionRequestIds: new Set(),
    permissionPendingAtPromptTerminal: false,
    observedInputBytes: 0,
  },
  protocolLabel = 'ACP Agent', beforeWrite = null, onActivity = null,
) {
  const textEncoder = new TextEncoder()
  const readable = new ReadableStream({
    async start(controller) {
      const reader = input.getReader()
      let pending = Buffer.alloc(0)
      let updateSequence = 0
      const parseLine = (line) => {
        const text = line.toString('utf8').trim()
        if (!text) return
        // Some CLIs print banners or warnings on stdout next to the protocol.
        // Anything that is not an object is not protocol traffic.
        if (!text.startsWith('{')) {
          replyState.ignoredMessages = (replyState.ignoredMessages || 0) + 1
          return
        }
        let message
        try {
          message = JSON.parse(text)
        } catch {
          throw acpTransportError(`${protocolLabel} returned malformed JSON.`)
        }
        const validated = validateAcpInboundMessage(
          message, validators, replyState, protocolLabel,
        )
        if (!validated) return
        if (message.method === 'session/request_permission') {
          replyState.pendingPermissionRequestIds.add(message.id)
        } else if (message.method === 'session/update' && message.params?.update) {
          replyState.pendingUpdateSequences.push(++updateSequence)
        } else if (replyState.collecting && !message.method) {
          if (replyState.promptRequestId != null && message.id === replyState.promptRequestId) {
            replyState.promptTerminalSequence = updateSequence
          }
          if (replyState.pendingPermissionRequestIds.size) {
            replyState.permissionPendingAtPromptTerminal = true
          }
        }
        controller.enqueue(validated)
      }
      const append = (left, right) => {
        const size = left.length + right.length
        if (size > ACP_MAX_LINE_BYTES) {
          throw acpTransportError(`${protocolLabel} message exceeded the safe line limit.`)
        }
        return left.length ? Buffer.concat([left, right], size) : Buffer.from(right)
      }
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          if (!value?.byteLength) continue
          try { onActivity?.() } catch { /* activity is best-effort */ }
          const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
          replyState.inputBytes += chunk.length
          if (replyState.inputBytes > ACP_MAX_INPUT_BYTES) {
            throw acpTransportError(`${protocolLabel} input exceeded the safe total limit.`)
          }
          let offset = 0
          while (offset < chunk.length) {
            const newline = chunk.indexOf(0x0a, offset)
            if (newline === -1) {
              pending = append(pending, chunk.subarray(offset))
              break
            }
            const line = append(pending, chunk.subarray(offset, newline))
            pending = Buffer.alloc(0)
            parseLine(line)
            offset = newline + 1
          }
        }
        if (pending.length) parseLine(pending)
        controller.close()
      } catch (error) {
        controller.error(error)
      } finally {
        reader.releaseLock()
      }
    },
  })
  const writable = new WritableStream({
    async write(message) {
      const bytes = textEncoder.encode(`${JSON.stringify(message)}\n`)
      const permissionRequestId = !message?.method
        && replyState.pendingPermissionRequestIds.has(message?.id)
        ? message.id
        : null
      if (typeof beforeWrite === 'function') {
        await beforeWrite(
          message,
          Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        )
      }
      if (permissionRequestId != null) {
        await new Promise(resolve => setTimeout(resolve, ACP_PERMISSION_ORDERING_SETTLE_MS))
      }
      const writer = output.getWriter()
      try {
        await writer.write(bytes)
      } finally {
        writer.releaseLock()
        if (permissionRequestId != null) {
          replyState.pendingPermissionRequestIds.delete(permissionRequestId)
        }
      }
    },
  })
  return { readable, writable }
}

function permissionRejection(options) {
  return terminalPlanRejection(options || []) || (options || []).find(option => (
    ['reject_once', 'reject_always'].includes(option.kind)
      || /reject|deny/i.test(`${option.optionId || ''} ${option.name || ''}`)
  ))
}

function selectedPermissionOutcome(option) {
  return option
    ? { outcome: { outcome: 'selected', optionId: option.optionId } }
    : { outcome: { outcome: 'cancelled' } }
}

function sanitizePermissionText(value, childEnv, limit) {
  return stripAnsi(redactSecrets(redactChildSecrets(value, childEnv)))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/file:\/\/\/[^\s"'`<>|,;)}\]]+/gi, '[path]')
    .replace(/(?<![A-Za-z0-9:])(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`<>|,;)}\]]+/g, '[path]')
    .replace(/(?<![A-Za-z0-9:])\/(?!\/)[^\s"'`<>|,;)}\]]+/g, '[path]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

function sanitizePermissionOptions(options, childEnv) {
  const seen = new Set()
  const sanitized = []
  for (const option of options || []) {
    if (sanitized.length >= ACP_PERMISSION_OPTION_LIMIT) break
    const optionId = sanitizePermissionText(option?.optionId, childEnv, 120)
    const kind = String(option?.kind || '')
    const name = sanitizePermissionText(option?.name, childEnv, 160)
    if (optionId !== option?.optionId || !ACP_PERMISSION_OPTION_ID.test(optionId)
        || seen.has(optionId) || !ACP_PERMISSION_OPTION_KINDS.has(kind) || !name) continue
    seen.add(optionId)
    sanitized.push(Object.freeze({ optionId, name, kind }))
  }
  return Object.freeze(sanitized)
}

// Raw tool input, output, content, locations, and metadata never cross this callback boundary.
function sanitizePermissionRequest(params, childEnv) {
  const toolCall = params?.toolCall || {}
  const safeToolCall = {
    toolCallId: sanitizePermissionText(toolCall.toolCallId, childEnv, 120),
  }
  const title = sanitizePermissionText(toolCall.title, childEnv, 160)
  if (title) safeToolCall.title = title
  if (ACP_TOOL_KINDS.has(toolCall.kind)) safeToolCall.kind = toolCall.kind
  if (ACP_TOOL_STATUSES.has(toolCall.status)) safeToolCall.status = toolCall.status
  return Object.freeze({
    sessionId: sanitizePermissionText(params?.sessionId, childEnv, 160),
    toolCall: Object.freeze(safeToolCall),
    options: sanitizePermissionOptions(params?.options, childEnv),
  })
}

function validPermissionDecision(decision, permissionOptions) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) return null
  const prototype = Object.getPrototypeOf(decision)
  if (prototype !== Object.prototype && prototype !== null) return null
  const keys = Reflect.ownKeys(decision).sort()
  if (keys.length !== 2 || keys[0] !== 'optionId' || keys[1] !== 'status') return null
  if (!['approved', 'rejected'].includes(decision.status)
      || typeof decision.optionId !== 'string') return null
  const selected = permissionOptions.find(option => option.optionId === decision.optionId)
  if (!selected) return null
  if (decision.status === 'approved' && !selected.kind.startsWith('allow_')) return null
  if (decision.status === 'rejected' && !selected.kind.startsWith('reject_')) return null
  return selected
}

async function waitForPermissionDecision(callback, request, signal) {
  if (signal?.aborted) throw agentExecutionError('LOCAL_AGENT_EXECUTION_STOPPED')
  const context = Object.freeze({ signal })
  const callbackPromise = Promise.resolve().then(() => callback(request, context))
  if (!signal) return callbackPromise
  let abortListener
  const abortPromise = new Promise((_, reject) => {
    abortListener = () => reject(agentExecutionError('LOCAL_AGENT_EXECUTION_STOPPED'))
    signal.addEventListener('abort', abortListener, { once: true })
  })
  try {
    return await Promise.race([callbackPromise, abortPromise])
  } finally {
    signal.removeEventListener('abort', abortListener)
  }
}

async function permissionOutcome(params, options, childEnv) {
  const fallback = selectedPermissionOutcome(permissionRejection(params?.options))
  if (typeof options.onPermissionRequest !== 'function') return fallback
  const request = sanitizePermissionRequest(params, childEnv)
  if (!request.options.length) return fallback
  try {
    const decision = await waitForPermissionDecision(
      options.onPermissionRequest,
      request,
      options.signal,
    )
    const selected = validPermissionDecision(decision, request.options)
    return selected ? selectedPermissionOutcome(selected) : fallback
  } catch {
    return fallback
  }
}

function destroyChildPipes(child) {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    if (!stream?.destroyed) stream?.destroy()
  }
}

async function terminateChild(child, platform, spawnFn) {
  if (child.exitCode != null || child.signalCode != null) return
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
    if (platform === 'win32' && child.pid) {
      const killer = spawnFn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true,
      })
      killer.on('error', () => {})
      killer.unref()
      forceSettleTimeout = setTimeout(finish, TERMINATE_GRACE_MS + KILL_SETTLE_MS)
      return
    }
    const signalTree = (signal) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal)
          return
        } catch { /* fall back to the direct child */ }
      }
      try {
        child.kill(signal)
      } catch { /* the process has already exited */ }
    }
    signalTree('SIGTERM')
    forceKillTimeout = setTimeout(() => signalTree('SIGKILL'), TERMINATE_GRACE_MS)
    forceSettleTimeout = setTimeout(finish, TERMINATE_GRACE_MS + KILL_SETTLE_MS)
  })
}

async function settleWithin(promise, timeoutMs) {
  let timeout
  await Promise.race([
    Promise.resolve(promise).catch(() => {}),
    new Promise((resolve) => {
      timeout = setTimeout(resolve, timeoutMs)
      timeout.unref?.()
    }),
  ])
  clearTimeout(timeout)
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode != null || child.signalCode != null) return true
  return new Promise((resolve) => {
    let timeout
    const finish = (exited) => {
      clearTimeout(timeout)
      child.removeListener('close', onExit)
      child.removeListener('error', onExit)
      resolve(exited)
    }
    const onExit = () => finish(true)
    child.once('close', onExit)
    child.once('error', onExit)
    timeout = setTimeout(() => finish(false), timeoutMs)
    timeout.unref?.()
  })
}

async function closeAcpChild(child, platform, spawnFn) {
  if (child.exitCode != null || child.signalCode != null) return
  if (!child.stdin?.destroyed && !child.stdin?.writableEnded) {
    try { child.stdin.end() } catch { /* the process has already closed its input */ }
  }
  if (await waitForChildExit(child, TERMINATE_GRACE_MS)) return
  await terminateChild(child, platform, spawnFn)
  destroyChildPipes(child)
}

function acpProtocolError(error, childEnv, sessionRef = '') {
  if (/^LOCAL_AGENT_[A-Z_]+$/.test(String(error?.message || ''))) return error
  const detail = redactChildSecrets(error?.diagnostic || error?.message || error, childEnv).trim()
  return detail
    ? failedAgentProcessError(detail, { sessionRef })
    : agentExecutionError('LOCAL_AGENT_PROCESS_FAILED')
}

function allowAcpSetupFallback(error) {
  if (!error || typeof error !== 'object'
      || error.message === 'LOCAL_AGENT_EXECUTION_STOPPED'
      || error.acpFallbackAllowed === true) return error
  Object.defineProperty(error, 'acpFallbackAllowed', { value: true })
  return error
}

function persistenceKey(agent, options) {
  const value = String(options.acpPersistenceKey || '')
  if (!value) return ''
  if (value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw agentExecutionError('LOCAL_AGENT_SESSION_INVALID')
  }
  return `${agent.kind}:${value}`
}

const ACP_IMAGE_MIME_TYPES = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'],
])
const ACP_MAX_IMAGE_BYTES = 10 * 1024 * 1024

// Images travel as ACP content blocks only when the Agent advertises image
// prompts during initialize. Otherwise the turn fails before prompting so the
// adapter can fall back to a transport that accepts image arguments.
function acpImageBlocks(runtime, imageAttachments) {
  const images = Array.isArray(imageAttachments) ? imageAttachments : []
  if (!images.length) return []
  if (runtime.agentCapabilities?.promptCapabilities?.image !== true) {
    throw allowAcpSetupFallback(agentExecutionError('LOCAL_AGENT_IMAGE_UNSUPPORTED'))
  }
  return images.map((filename) => {
    const mimeType = ACP_IMAGE_MIME_TYPES.get(path.extname(filename).toLowerCase())
    if (!mimeType) throw agentExecutionError('LOCAL_AGENT_IMAGE_UNSUPPORTED')
    const stat = fs.statSync(filename)
    if (!stat.isFile() || stat.size > ACP_MAX_IMAGE_BYTES) {
      throw agentExecutionError('LOCAL_AGENT_IMAGE_LIMIT')
    }
    return { type: 'image', mimeType, data: fs.readFileSync(filename).toString('base64') }
  })
}

function withAcpRuntimeLock(key, callback) {
  const previous = acpRuntimeLocks.get(key) || Promise.resolve()
  const current = previous.catch(() => {}).then(callback)
  const tail = current.catch(() => {})
  acpRuntimeLocks.set(key, tail)
  return current.finally(() => {
    if (acpRuntimeLocks.get(key) === tail) acpRuntimeLocks.delete(key)
  })
}

function runtimeSignature(agent, workdir, spec, profile, childEnv) {
  const environment = Object.keys(childEnv).sort()
    .filter(key => !ACP_VOLATILE_ENV_KEYS.has(key))
    .map(key => [key, childEnv[key]])
  return createHash('sha256').update(JSON.stringify({
    kind: agent.kind,
    executable: agent.executable,
    workdir,
    command: spec.command,
    args: spec.args,
    // The native session mode is applied on every turn
    // with session/set_mode, so it does not identify a process. Anything that
    // really needs a separate process (a permission policy in the environment)
    // is already part of the environment below.
    profileId: profile.profileId,
    environment,
  })).digest('hex')
}

async function prepareAcpRuntime(agent, workdir, options, spec, profile) {
  const platform = options.platform || process.platform
  const spawnFn = options.spawnFn || spawn
  const loadAcpSdkFn = options.loadAcpSdkFn || loadAcpSdk
  const prepared = prepareCommand(spec.command, spec.args, { platform })
  const childEnv = childEnvironment(agent, workdir, options, platform)
  let sdk
  try {
    sdk = await loadAcpSdkFn()
  } catch (error) {
    throw allowAcpSetupFallback(acpProtocolError(error, childEnv))
  }
  return {
    agent,
    workdir,
    spec,
    profile,
    platform,
    spawnFn,
    loadAcpSdkFn,
    prepared,
    childEnv,
    sdk,
    signature: runtimeSignature(agent, workdir, spec, profile, childEnv),
    protocolLabel: `${agent.name || AGENT_PROFILES[agent.kind]?.label || 'Agent'} ACP`,
  }
}

async function createAcpRuntime(input) {
  const {
    agent, workdir, platform, spawnFn, prepared, childEnv, sdk, protocolLabel,
  } = input
  if (input.options?.signal?.aborted) throw agentExecutionError('LOCAL_AGENT_EXECUTION_STOPPED')
  let child
  try {
    child = spawnFn(prepared.command, prepared.args, {
      cwd: workdir,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: platform !== 'win32',
      windowsHide: true,
    })
  } catch (error) {
    throw allowAcpSetupFallback(agentExecutionError(
      'LOCAL_AGENT_SPAWN_FAILED',
      redactChildSecrets(error?.message || error, childEnv),
    ))
  }

  const { ClientSideConnection, PROTOCOL_VERSION, validators } = sdk
  const runtime = {
    ...input,
    child,
    connection: null,
    protocolSessionRef: '',
    publicSessionRef: '',
    activeTurn: null,
    active: false,
    ending: false,
    closed: false,
    failureError: null,
    lastUsedAt: Date.now(),
    replyState: {
      bytes: 0,
      inputBytes: 0,
      collecting: false,
      promptRequestId: null,
      promptTerminalSequence: null,
      pendingUpdateSequences: [],
      pendingPermissionRequestIds: new Set(),
      permissionPendingAtPromptTerminal: false,
      observedInputBytes: 0,
    },
    stderr: [],
    stderrBytes: 0,
    stopPromise: null,
  }
  let rejectFailure
  runtime.failurePromise = new Promise((_, reject) => { rejectFailure = reject })
  runtime.failurePromise.catch(() => {})
  const failRuntime = (error) => {
    if (runtime.ending || runtime.failureError) return
    runtime.failureError = error
    rejectFailure(error)
  }
  runtime.failRuntime = failRuntime
  child.once('error', (error) => failRuntime(agentExecutionError(
    'LOCAL_AGENT_SPAWN_FAILED',
    redactChildSecrets(error?.message || error, childEnv),
  )))
  child.once('close', () => {
    if (runtime.ending) return
    const detail = redactChildSecrets(
      Buffer.concat(runtime.stderr).toString('utf8').trim(),
      childEnv,
    )
    failRuntime(failedAgentProcessError(detail, { sessionRef: runtime.publicSessionRef }))
  })
  child.stderr.on('data', (chunk) => {
    try { runtime.activeTurn?.noteActivity?.() } catch { /* activity is best-effort */ }
    // Keep only recent stderr. A long-lived process used to keep the first
    // megabyte of its whole lifetime, so a new failure was classified from
    // stale early lines (for example an old auth warning).
    runtime.stderr.push(chunk)
    runtime.stderrBytes += chunk.length
    while (runtime.stderrBytes > ACP_STDERR_TAIL_BYTES && runtime.stderr.length > 1) {
      runtime.stderrBytes -= runtime.stderr.shift().length
    }
  })
  runtime.observedStdout = createObservedAcpInput(
    child.stdout, runtime.replyState, protocolLabel,
  )

  const client = {
    async requestPermission(params) {
      const turn = runtime.activeTurn
      if (runtime.agent.kind === 'mimo' && runtime.replyState.promptTerminalSequence != null) {
        runtime.replyState.permissionPendingAtPromptTerminal = true
        return { outcome: { outcome: 'cancelled' } }
      }
      const pending = permissionOutcome(params, turn?.options || {}, childEnv)
      turn?.pendingPermissionCallbacks.add(pending)
      pending.then(
        () => turn?.pendingPermissionCallbacks.delete(pending),
        () => turn?.pendingPermissionCallbacks.delete(pending),
      )
      return pending
    },
    async sessionUpdate(params) {
      const turn = runtime.activeTurn
      try { turn?.noteActivity?.() } catch { /* activity is best-effort */ }
      const sequence = runtime.replyState.pendingUpdateSequences.shift()
      if (!turn || !runtime.replyState.collecting) return
      if (params.sessionId !== runtime.protocolSessionRef) return
      if (runtime.replyState.promptTerminalSequence != null
          && Number.isInteger(sequence)
          && sequence > runtime.replyState.promptTerminalSequence
          && !(runtime.agent.kind === 'mimo'
            && params.update?.sessionUpdate === 'agent_message_chunk'
            && turn.lastMessageId
            && params.update.messageId === turn.lastMessageId)) return
      if (params.update?.sessionUpdate === 'agent_message_chunk' && params.update.messageId) {
        turn.lastMessageId = params.update.messageId
      }
      if (turn.repetitionGuard?.(params.update)) {
        turn.stopRepeatedOutput()
        return
      }
      turn.structuredOutput.ingest?.(params)
      for (const event of turn.profile.mapEvent(params.update, turn.runtimeState)) {
        turn.runtimeEvents.emit(event)
      }
    },
  }
  const stream = boundedAcpStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(runtime.observedStdout),
    validators,
    runtime.replyState,
    protocolLabel,
    async (message, wireBytes) => {
      const turn = runtime.activeTurn
      try { turn?.noteActivity?.() } catch { /* activity is best-effort */ }
      if (!turn || message?.method !== 'session/prompt') return
      runtime.replyState.promptRequestId = message.id
      if (typeof turn.options.onOutboundPayload !== 'function') return
      try {
        await turn.options.onOutboundPayload(createAcpOutboundPayload({
          prompt: turn.prompt,
          wireBytes,
        }))
      } catch (error) {
        turn.outboundPayloadFailed = true
        throw error
      }
    },
    () => {
      try { runtime.activeTurn?.noteActivity?.() } catch { /* activity is best-effort */ }
    },
  )
  runtime.connection = new ClientSideConnection(() => client, stream)
  acpInitializingRuntimes.add(runtime)
  const abortSignal = input.options?.signal
  const initializeTimeoutMs = Number.isFinite(input.options?.acpInitializeTimeoutMs)
    && input.options.acpInitializeTimeoutMs > 0
    ? input.options.acpInitializeTimeoutMs
    : ACP_INITIALIZE_TIMEOUT_MS
  let initializeTimer = null
  let abortListener = null
  try {
    // initialize used to wait forever while holding the per-conversation
    // lock, leaving the Agent unusable in that conversation until restart.
    const initialized = await Promise.race([
      runtime.connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }),
      runtime.failurePromise,
      new Promise((_, reject) => {
        initializeTimer = setTimeout(() => reject(agentExecutionError(
          'LOCAL_AGENT_PROTOCOL_UNAVAILABLE',
          `${protocolLabel} did not answer the ACP initialize request.`,
        )), initializeTimeoutMs)
      }),
      new Promise((_, reject) => {
        abortListener = () => reject(agentExecutionError('LOCAL_AGENT_EXECUTION_STOPPED'))
        if (abortSignal?.aborted) abortListener()
        else abortSignal?.addEventListener('abort', abortListener, { once: true })
      }),
    ])
    runtime.agentCapabilities = initialized?.agentCapabilities
      && typeof initialized.agentCapabilities === 'object'
      ? initialized.agentCapabilities
      : {}
  } catch (error) {
    await closeAcpRuntime(runtime)
    if (abortSignal?.aborted) throw agentExecutionError('LOCAL_AGENT_EXECUTION_STOPPED')
    throw allowAcpSetupFallback(acpProtocolError(error, childEnv))
  } finally {
    clearTimeout(initializeTimer)
    if (abortListener) abortSignal?.removeEventListener('abort', abortListener)
    acpInitializingRuntimes.delete(runtime)
  }
  return runtime
}

async function closeAcpRuntime(runtime) {
  if (!runtime) return
  if (!runtime.closed) {
    runtime.closed = true
    runtime.observedStdout?.destroy()
    runtime.failRuntime?.(agentExecutionError('LOCAL_AGENT_EXECUTION_STOPPED'))
    runtime.ending = true
    runtime.replyState.collecting = false
    runtime.stopPromise ||= closeAcpChild(runtime.child, runtime.platform, runtime.spawnFn)
  }
  if (runtime.stopPromise) await runtime.stopPromise
}

function publicSessionRef(value, childEnv) {
  const safe = redactChildSecrets(value, childEnv)
  return safe.includes('[redacted]') ? '' : safe
}

async function runAcpTurn(runtime, prompt, options, spec, profile) {
  if (runtime.closed || runtime.failureError) {
    throw runtime.failureError || agentExecutionError('LOCAL_AGENT_PROCESS_FAILED')
  }
  const noteActivity = () => {
    try { options.onActivity?.() } catch { /* activity is best-effort */ }
  }
  const runtimeEvents = createRuntimeEventEmitter({ ...options, onActivity: noteActivity }, runtime.childEnv)
  const capabilityWarning = connectorLimitedRuntimeEvent(runtime.agent.kind, profile)
  if (capabilityWarning) runtimeEvents.emit(capabilityWarning)
  const turn = {
    options,
    prompt,
    profile,
    runtimeEvents,
    runtimeState: profile.createState(),
    structuredOutput: profile.createFinalOutputAccumulator(
      spec.publicSessionRef || options.sessionRef || runtime.publicSessionRef,
    ),
    noteActivity,
    outboundPayloadFailed: false,
    pendingPermissionCallbacks: new Set(),
    repetitionGuard: ['opencode', 'mimo', 'hermes'].includes(runtime.agent.kind) ? createOutputRepetitionGuard() : null,
  }
  runtime.activeTurn = turn
  runtime.stderr = []
  runtime.stderrBytes = 0
  runtime.replyState.bytes = 0
  runtime.replyState.inputBytes = 0
  runtime.replyState.observedInputBytes = 0
  runtime.replyState.collecting = false
  runtime.replyState.promptRequestId = null
  runtime.replyState.promptTerminalSequence = null
  runtime.replyState.pendingPermissionRequestIds.clear()
  runtime.replyState.permissionPendingAtPromptTerminal = false
  let protocolSessionRef = runtime.protocolSessionRef
  let visibleSessionRef = String(
    runtime.publicSessionRef || spec.publicSessionRef || options.sessionRef || '',
  )
  if (!runtime.publicSessionRef && visibleSessionRef) {
    runtime.publicSessionRef = visibleSessionRef
  }
  let promptStarted = false
  let promptRequest = null
  let caughtError = null
  let abortRequested = false
  let timeoutRequested = false
  let cancelPromise = Promise.resolve()
  let rejectAbort
  const abortPromise = new Promise((_, reject) => { rejectAbort = reject })
  const abort = (error = agentExecutionError('LOCAL_AGENT_EXECUTION_STOPPED')) => {
    if (abortRequested) return
    abortRequested = true
    if (protocolSessionRef) {
      try {
        cancelPromise = Promise.resolve(runtime.connection.cancel({
          sessionId: protocolSessionRef,
        })).catch(() => {})
      } catch { /* the ACP stream has already closed */ }
    }
    rejectAbort(error instanceof Error ? error : agentExecutionError('LOCAL_AGENT_EXECUTION_STOPPED'))
  }
  turn.stopRepeatedOutput = () => {
    runtime.replyState.collecting = false
    abort(agentExecutionError('LOCAL_AGENT_REPEATED_OUTPUT',
      'The Agent repeated the same response without tool progress; the native turn was cancelled.'))
  }
  const operation = promise => Promise.race([promise, abortPromise, runtime.failurePromise])
  const timeout = setTimeout(() => {
    timeoutRequested = true
    abort()
  }, 2 * 60 * 60 * 1000)
  if (options.signal?.aborted) abort()
  else options.signal?.addEventListener('abort', abort, { once: true })

  try {
    if (!protocolSessionRef) {
      if (spec.acpSessionStrategy !== 'new' && options.sessionRef) {
        protocolSessionRef = String(options.sessionRef)
        await operation(runtime.connection.resumeSession({
          sessionId: protocolSessionRef,
          cwd: runtime.workdir,
          mcpServers: [],
        }))
        visibleSessionRef = protocolSessionRef
      } else {
        const session = await operation(runtime.connection.newSession({
          cwd: runtime.workdir,
          mcpServers: [],
        }))
        protocolSessionRef = String(session.sessionId || '')
        visibleSessionRef = String(
          spec.publicSessionRef || options.sessionRef || protocolSessionRef,
        )
      }
      if (!protocolSessionRef) throw agentExecutionError('LOCAL_AGENT_SESSION_INVALID')
      runtime.protocolSessionRef = protocolSessionRef
      runtime.publicSessionRef = visibleSessionRef
    }
    visibleSessionRef = publicSessionRef(visibleSessionRef, runtime.childEnv)
    if (spec.acpMode) {
      await operation(runtime.connection.setSessionMode({
        sessionId: protocolSessionRef,
        modeId: spec.acpMode,
      }))
    }
    if (visibleSessionRef && typeof options.onSessionRef === 'function') {
      await operation(options.onSessionRef(visibleSessionRef, { transport: 'acp' }))
    }
    const imageBlocks = acpImageBlocks(runtime, spec.imageAttachments)
    runtime.replyState.collecting = true
    let promptResult
    try {
      promptStarted = true
      promptRequest = Promise.resolve(runtime.connection.prompt({
        sessionId: protocolSessionRef,
        prompt: [{ type: 'text', text: prompt }, ...imageBlocks],
      }))
      promptRequest.catch(() => {})
      promptResult = await operation(promptRequest)
      if (runtime.agent.kind === 'mimo' && turn.lastMessageId) {
        await operation(new Promise(resolve => setTimeout(resolve, MIMO_TERMINAL_DRAIN_MS)))
      }
    } finally {
      runtime.replyState.collecting = false
    }
    if (turn.pendingPermissionCallbacks.size) {
      await operation(Promise.allSettled([...turn.pendingPermissionCallbacks]))
    }
    if (runtime.replyState.permissionPendingAtPromptTerminal) {
      throw agentExecutionError('LOCAL_AGENT_PERMISSION_TERMINAL_RACE')
    }
    const structuredResult = turn.structuredOutput.end({
      sessionRef: visibleSessionRef,
      stopReason: promptResult?.stopReason,
    })
    const text = redactChildSecrets(structuredResult?.text, runtime.childEnv)
    const result = requireTerminalAgentResult({
      ...structuredResult,
      text,
      sessionRef: visibleSessionRef,
      ...outcomeForAcpStopReason(promptResult?.stopReason),
    })
    if (!result.text) throw agentExecutionError('LOCAL_AGENT_EMPTY_RESPONSE')
    runtimeEvents.finalize({ text, status: result.outcome })
    return result
  } catch (error) {
    if (turn.outboundPayloadFailed) {
      runtimeEvents.finalize({ status: 'failed' })
      throw error
    }
    const normalized = acpProtocolError(error, runtime.childEnv, visibleSessionRef)
    runtimeEvents.finalize({
      status: timeoutRequested
        ? 'timeout'
        : normalized.failure?.category === 'cancellation' ? 'stopped' : 'failed',
    })
    if (promptStarted && options.sessionRef
        && runtime.replyState.bytes === 0
        && normalized.message === 'LOCAL_AGENT_REFUSED') {
      throw agentExecutionError('LOCAL_AGENT_SESSION_INVALID')
    }
    if (!promptStarted && normalized.message !== 'LOCAL_AGENT_SESSION_INVALID') {
      allowAcpSetupFallback(normalized)
    }
    caughtError = normalized
    throw normalized
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
    runtime.replyState.collecting = false
    runtime.replyState.promptRequestId = null
    runtime.replyState.promptTerminalSequence = null
    runtime.replyState.pendingPermissionRequestIds.clear()
    runtime.replyState.permissionPendingAtPromptTerminal = false
    turn.pendingPermissionCallbacks.clear()
    runtime.activeTurn = null
    runtime.lastUsedAt = Date.now()
    if (abortRequested) {
      await settleWithin(cancelPromise, ACP_CANCEL_GRACE_MS)
      // A user stop or watchdog timeout used to destroy the process and its
      // native session. Keep both when the Agent honours the cancellation.
      let promptSettled = false
      // Disposable runtimes are always closed after the turn; only a
      // persistent runtime is worth waiting for.
      if (promptRequest && !acpDisposableRuntimes.has(runtime)) {
        await settleWithin(
          promptRequest.then(() => { promptSettled = true }, () => { promptSettled = true }),
          ACP_CANCEL_SETTLE_MS,
        )
      }
      if (caughtError && caughtError.code !== 'LOCAL_AGENT_REPEATED_OUTPUT'
          && promptSettled && !runtime.closed && !runtime.failureError) {
        Object.defineProperty(caughtError, 'acpRuntimeReusable', {
          value: true, enumerable: false, configurable: true,
        })
      }
    }
  }
}

async function evictIdleAcpRuntimes() {
  while (acpSessionRuntimes.size > ACP_PERSISTENT_RUNTIME_LIMIT) {
    const candidate = [...acpSessionRuntimes.entries()]
      .filter(([, runtime]) => !runtime.active)
      .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0]
    if (!candidate) return
    acpSessionRuntimes.delete(candidate[0])
    await closeAcpRuntime(candidate[1])
  }
}

async function runPersistentAcpAgent(agent, prompt, workdir, options, spec, profile, key) {
  const shutdownGeneration = acpShutdownGeneration
  return withAcpRuntimeLock(key, async () => {
    if (shutdownGeneration !== acpShutdownGeneration) {
      throw agentExecutionError('LOCAL_AGENT_EXECUTION_STOPPED')
    }
    const preparation = prepareAcpRuntime(agent, workdir, options, spec, profile)
    acpRuntimePreparations.add(preparation)
    let input
    try {
      input = await preparation
    } finally {
      acpRuntimePreparations.delete(preparation)
    }
    if (shutdownGeneration !== acpShutdownGeneration) {
      throw agentExecutionError('LOCAL_AGENT_EXECUTION_STOPPED')
    }
    input.options = options
    let runtime = acpSessionRuntimes.get(key)
    if (runtime && options.sessionRef
        && String(options.sessionRef) !== runtime.publicSessionRef) {
      throw agentExecutionError('LOCAL_AGENT_SESSION_INVALID')
    }
    const incompatible = runtime && (
      runtime.closed || runtime.failureError
      || runtime.signature !== input.signature
      || runtime.spawnFn !== input.spawnFn
      || runtime.loadAcpSdkFn !== input.loadAcpSdkFn
      || !options.sessionRef
    )
    if (incompatible) {
      acpSessionRuntimes.delete(key)
      await closeAcpRuntime(runtime)
      runtime = null
      if (options.sessionRef) throw agentExecutionError('LOCAL_AGENT_SESSION_INVALID')
    }
    if (!runtime) {
      if (shutdownGeneration !== acpShutdownGeneration) {
        throw agentExecutionError('LOCAL_AGENT_EXECUTION_STOPPED')
      }
      runtime = await createAcpRuntime(input)
      runtime.active = true
      acpSessionRuntimes.set(key, runtime)
      await evictIdleAcpRuntimes()
    }
    runtime.active = true
    try {
      return await runAcpTurn(runtime, prompt, options, spec, profile)
    } catch (error) {
      if (error?.acpRuntimeReusable !== true) {
        acpSessionRuntimes.delete(key)
        await closeAcpRuntime(runtime)
      }
      throw error
    } finally {
      runtime.active = false
      runtime.lastUsedAt = Date.now()
      await evictIdleAcpRuntimes()
    }
  })
}

async function runDisposableAcpAgent(agent, prompt, workdir, options, spec, profile) {
  const shutdownGeneration = acpShutdownGeneration
  const preparation = prepareAcpRuntime(agent, workdir, options, spec, profile)
  acpRuntimePreparations.add(preparation)
  let input
  try {
    input = await preparation
  } finally {
    acpRuntimePreparations.delete(preparation)
  }
  if (shutdownGeneration !== acpShutdownGeneration) {
    throw agentExecutionError('LOCAL_AGENT_EXECUTION_STOPPED')
  }
  input.options = options
  let runtime
  try {
    runtime = await createAcpRuntime(input)
    if (shutdownGeneration !== acpShutdownGeneration) {
      throw agentExecutionError('LOCAL_AGENT_EXECUTION_STOPPED')
    }
    acpDisposableRuntimes.add(runtime)
    return await runAcpTurn(runtime, prompt, options, spec, profile)
  } finally {
    if (runtime) {
      acpDisposableRuntimes.delete(runtime)
      await closeAcpRuntime(runtime)
    }
  }
}

async function runAcpAgent(agent, prompt, workdir, options, spec, profile) {
  if (options.signal?.aborted
      || options.acpShutdownGeneration != null
        && options.acpShutdownGeneration !== acpShutdownGeneration) {
    throw agentExecutionError('LOCAL_AGENT_EXECUTION_STOPPED')
  }
  const key = persistenceKey(agent, options)
  return key
    ? runPersistentAcpAgent(agent, prompt, workdir, options, spec, profile, key)
    : runDisposableAcpAgent(agent, prompt, workdir, options, spec, profile)
}

async function shutdownAcpSessionRuntime() {
  acpShutdownGeneration += 1
  const preparations = [...acpRuntimePreparations]
  const barriers = [...acpShutdownBarriers]
  for (const barrier of barriers) barrier.controller.abort()
  const runtimes = [...new Set([
    ...acpSessionRuntimes.values(),
    ...acpInitializingRuntimes,
    ...acpDisposableRuntimes,
  ])]
  acpSessionRuntimes.clear()
  await Promise.allSettled([
    ...preparations,
    ...runtimes.map(closeAcpRuntime),
    ...barriers.map(barrier => barrier.completion),
  ])
}

module.exports = { registerAcpShutdownBarrier, runAcpAgent, shutdownAcpSessionRuntime }

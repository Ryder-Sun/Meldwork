const { spawn } = require('node:child_process')
const {
  ALLOWED_KINDS,
  detectAgents,
  prepareCommand,
  resolveExecutable,
  searchPath,
} = require('./cli-discovery.cjs')
const {
  createRuntimeEventEmitter,
  parseClaudeQwenOutput,
  parseCodexOutput,
  parseGeminiOutput,
  parseKimiOutput,
  parseMimoOutput,
  parseOpenCodeOutput,
  parseOpenCodeReviewOutput,
  parsePiOutput,
  parseWorkBuddyOutput,
  readHermesFinalResponse,
  readHermesMessageWatermark,
  redactChildSecrets,
  runtimeCommandSummary,
  stripExactMeldworkPromptEcho,
  structuredCliError,
} = require('./cli-runtime-events.cjs')
const {
  registerAcpShutdownBarrier,
  runAcpAgent,
  shutdownAcpSessionRuntime,
} = require('./cli-acp-runner.cjs')
const { withOpenClawGateway } = require('./cli-openclaw-gateway.cjs')
const { imageAttachmentLimit, invocation } = require('./cli-invocations.cjs')
const {
  connectorLimitedRuntimeEvent,
  resolveConnectorEventProfile,
} = require('./cli-event-profiles.cjs')
const {
  normalizeExternalRunRef,
  requireTerminalAgentResult,
} = require('../agent-runtime-contract.cjs')
const {
  KILL_SETTLE_MS,
  TERMINATE_GRACE_MS,
  agentExecutionError,
  childEnvironment,
  failedAgentProcessError,
} = require('./cli-process-support.cjs')
const { createLegacyOutboundPayload } = require('../../collaboration/outbound-payload.cjs')

const MAX_PROGRESS_STEPS = 8
const MAX_STDOUT_CAPTURE_BYTES = 10 * 1024 * 1024
const MAX_STDERR_CAPTURE_BYTES = 1024 * 1024
const OUTPUT_TRUNCATION_MARKER = Buffer.from('\n[output truncated]\n')

const BROKEN_INPUT_GRACE_MS = 5000

// A step that ends because the model asked for tools is followed by more
// steps (the tools run, then the model continues); only the last step's finish
// ends the run. Ending the process after the first one cut every tool-using
// MiMo or OpenCode turn short.
function stepFinishContinues(event) {
  const reason = String(event?.part?.reason || event?.reason || '').toLowerCase()
  return /^tool[-_ ]?(calls?|use)$/.test(reason)
}

function createBoundedOutputCapture(maxBytes) {
  const headLimit = Math.floor(maxBytes / 2)
  const tailLimit = maxBytes - headLimit
  const head = []
  const tail = []
  let headBytes = 0
  let tailBytes = 0
  let totalBytes = 0

  return {
    push(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (!bytes.length) return
      totalBytes = Math.min(maxBytes + 1, totalBytes + bytes.length)
      const headRemaining = headLimit - headBytes
      const headLength = Math.min(headRemaining, bytes.length)
      if (headLength > 0) {
        head.push(Buffer.from(bytes.subarray(0, headLength)))
        headBytes += headLength
      }
      if (headLength >= bytes.length) return
      const remainder = bytes.subarray(headLength)
      if (remainder.length >= tailLimit) {
        tail.length = 0
        tail.push(Buffer.from(remainder.subarray(remainder.length - tailLimit)))
        tailBytes = tailLimit
        return
      }
      tail.push(Buffer.from(remainder))
      tailBytes += remainder.length
      while (tailBytes > tailLimit) {
        const overflow = tailBytes - tailLimit
        if (tail[0].length <= overflow) {
          tailBytes -= tail.shift().length
        } else {
          tail[0] = Buffer.from(tail[0].subarray(overflow))
          tailBytes -= overflow
        }
      }
    },
    text() {
      const headBuffer = Buffer.concat(head, headBytes)
      const tailBuffer = Buffer.concat(tail, tailBytes)
      if (totalBytes <= maxBytes) {
        return Buffer.concat([headBuffer, tailBuffer], totalBytes).toString('utf8')
      }
      const markerOffset = Math.min(OUTPUT_TRUNCATION_MARKER.length, tailBuffer.length)
      return Buffer.concat([
        headBuffer,
        OUTPUT_TRUNCATION_MARKER,
        tailBuffer.subarray(markerOffset),
      ], maxBytes).toString('utf8')
    },
  }
}


async function runAgent(agent, prompt, workdir, options = {}) {
  if (options.signal?.aborted) throw agentExecutionError('LOCAL_AGENT_EXECUTION_STOPPED')
  const noteActivity = () => {
    try { options.onActivity?.() } catch { /* activity is best-effort */ }
  }
  const platform = options.platform || process.platform
  const spawnFn = options.spawnFn || spawn
  let sessionRef = String(options.sessionRef || '')
  const failureSessionRef = String(options.failureSessionRef || sessionRef)
  const hermesAcpAvailable = typeof options.hermesAcpAvailable === 'boolean'
    ? options.hermesAcpAvailable
    : agent.acpAvailable
  const spec = invocation(agent.kind, agent.executable, workdir, sessionRef, {
    platform,
    sandbox: options.sandbox,
    attachments: options.attachments,
    hermesAcpAvailable,
    invocationTransport: options.invocationTransport,
    sessionTransport: options.sessionTransport,
    maxTurns: options.maxTurns,
    model: agent.kind === 'workbuddy' ? options.env?.CODEBUDDY_MODEL : undefined,
  })
  const profile = resolveConnectorEventProfile(agent.kind, {
    transport: spec.eventTransport,
  })
  if (!profile) throw agentExecutionError('LOCAL_AGENT_PROTOCOL_UNSUPPORTED')
  if (agent.kind === 'hermes' && !spec.acpMode && options.sessionTransport === 'acp') {
    sessionRef = ''
  }
  if (spec.eventTransport === 'acp') {
    try {
      const executeAcp = runtimeOptions => runAcpAgent(
        agent, prompt, workdir, runtimeOptions, spec, profile,
      )
      if (!spec.openClawGateway) return await executeAcp(options)
      const shutdownBarrier = registerAcpShutdownBarrier(options.signal)
      try {
        if (!shutdownBarrier.isCurrent()) {
          throw agentExecutionError('LOCAL_AGENT_EXECUTION_STOPPED')
        }
        return await withOpenClawGateway({
          ...options,
          executable: agent.executable,
          signal: shutdownBarrier.signal,
          workdir,
        }, gatewayOptions => executeAcp({
          ...options,
          ...gatewayOptions,
          acpShutdownGeneration: shutdownBarrier.shutdownGeneration,
          signal: shutdownBarrier.signal,
        }))
      } finally {
        shutdownBarrier.complete()
      }
    } catch (error) {
      if (!spec.fallbackTransport || error?.acpFallbackAllowed !== true
          || options.signal?.aborted) throw error
      let fallbackPrompt = prompt
      if (spec.fallbackSessionPolicy === 'invalidate' && sessionRef
          && typeof options.onSessionInvalidated === 'function') {
        const recovery = await options.onSessionInvalidated({
          kind: agent.kind,
          sessionRef,
          transport: 'acp',
        })
        if (typeof recovery === 'string') fallbackPrompt = recovery
        else if (typeof recovery?.prompt === 'string') fallbackPrompt = recovery.prompt
      }
      try {
        const pending = options.onEvent?.({
          id: `${agent.kind}-acp-fallback`,
          type: 'warning',
          status: 'waiting',
          title: 'connector_fallback',
        })
        if (pending && typeof pending.catch === 'function') pending.catch(() => {})
      } catch { /* runtime events are best-effort */ }
      const fallbackRuntimeOptions = error?.openClawRuntimeOptions || {}
      return runAgent(agent, fallbackPrompt, workdir, {
        ...options,
        ...fallbackRuntimeOptions,
        sessionRef: spec.fallbackSessionPolicy === 'preserve' ? sessionRef : '',
        failureSessionRef,
        invocationTransport: spec.fallbackTransport,
        onSessionInvalidated: undefined,
      })
    }
  }
  const args = [...spec.args]
  if (spec.promptArg) args.push(prompt)
  if (spec.suffixArgs) args.push(...spec.suffixArgs)
  const prepared = prepareCommand(spec.command, args, { platform })
  const stdin = spec.stdin ? prompt : ''
  if (typeof options.onOutboundPayload === 'function') {
    await options.onOutboundPayload(createLegacyOutboundPayload({
      prompt,
      command: prepared.command,
      args: prepared.args,
      cwd: workdir,
      stdin,
      promptMode: spec.stdin ? 'stdin' : 'argument',
    }))
  }
  const childEnv = childEnvironment(agent, workdir, options, platform)
  const runtimeEvents = createRuntimeEventEmitter({ ...options, onActivity: noteActivity }, childEnv)
  const capabilityWarning = connectorLimitedRuntimeEvent(agent.kind, profile)
  if (capabilityWarning) runtimeEvents.emit(capabilityWarning)
  const profileRunContext = profile.createRunContext(options)
  return await new Promise((resolve, reject) => {
    const rejectTerminal = (error, status = 'failed') => {
      runtimeEvents.finalize({ status })
      reject(error)
    }
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
      rejectTerminal(agentExecutionError(
        'LOCAL_AGENT_SPAWN_FAILED',
        redactChildSecrets(error?.message || error, childEnv),
      ))
      return
    }
    const stdout = createBoundedOutputCapture(MAX_STDOUT_CAPTURE_BYTES)
    const stderr = createBoundedOutputCapture(MAX_STDERR_CAPTURE_BYTES)
    const structuredOutput = profile.createFinalOutputAccumulator(sessionRef)
    let settled = false
    let stopRequested = false
    let timeoutRequested = false
    let inputError = null
    let brokenInputTimer = null
    let timeout
    let forceKillTimeout
    let forceSettleTimeout
    let terminalKillTimer
    let terminalForceKillTimer
    const progress = []
    const progressIndexes = new Map()
    let anonymousProgressId = 0
    const emitProgress = (input) => {
      const event = {
        ...(input?.id ? { id: String(input.id) } : {}),
        title: String(input?.title || 'process'),
        status: ['completed', 'failed', 'in_progress'].includes(input?.status)
          ? input.status
          : 'completed',
      }
      const progressId = event.id || `anonymous-${++anonymousProgressId}`
      const existingIndex = progressIndexes.get(progressId)
      if (existingIndex != null) {
        progress[existingIndex] = event
      } else {
        if (progress.length >= MAX_PROGRESS_STEPS) return
        progressIndexes.set(progressId, progress.length)
        progress.push(event)
      }
      try { options.onProgress?.(event) } catch { /* progress is best-effort */ }
    }
    const runtimeState = profile.createState()
    const runtimeStreamParser = profile.source === 'stdout'
      && ['jsonl', 'jsonrpc-jsonl'].includes(profile.framing)
      && typeof profile.createDecoder === 'function'
      ? profile.createDecoder((event) => {
          structuredOutput.ingest?.(event)
          observeTerminalEvent(event)
          const progressEvent = profile.mapProgress(event)
          if (progressEvent) emitProgress(progressEvent)
          for (const runtimeEvent of profile.mapEvent(event, runtimeState)) {
            runtimeEvents.emit(runtimeEvent)
          }
        })
      : null
    const finish = (callback) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearTimeout(forceKillTimeout)
      clearTimeout(forceSettleTimeout)
      clearTimeout(terminalKillTimer)
      clearTimeout(terminalForceKillTimer)
      clearTimeout(brokenInputTimer)
      options.signal?.removeEventListener('abort', abort)
      callback()
    }
    const signalProcessTree = (signal) => {
      if (platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, signal)
          return
        } catch { /* fall back to the direct child */ }
      }
      try {
        child.kill(signal)
      } catch { /* the process has already exited */ }
    }
    let terminalObserved = false
    const observeTerminalEvent = (event) => {
      if (terminalObserved || !event || typeof event !== 'object') return
      const terminal = (
        (['workbuddy', 'claude', 'qwen'].includes(agent.kind) && event.type === 'result')
        || (agent.kind === 'pi' && event.type === 'agent_end')
        || (agent.kind === 'codex' && event.type === 'turn.completed')
        || (['mimo', 'opencode'].includes(agent.kind) && event.type === 'step_finish'
          && !stepFinishContinues(event))
        || (agent.kind === 'gemini' && event.type === 'result')
        || (agent.kind === 'kimi' && event.type === 'session.resume_hint')
      )
      if (!terminal) return
      terminalObserved = true
      terminalKillTimer = setTimeout(() => {
        if (settled) return
        signalProcessTree('SIGTERM')
        terminalForceKillTimer = setTimeout(() => {
          if (!settled) signalProcessTree('SIGKILL')
        }, 1500)
      }, 250)
    }
    const abort = () => {
      if (settled || stopRequested) return
      stopRequested = true
      const terminalError = inputError || new Error('LOCAL_AGENT_EXECUTION_STOPPED')
      if (platform === 'win32' && child.pid) {
        const killer = spawnFn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore', windowsHide: true,
        })
        killer.on('error', () => {})
        killer.unref()
        forceSettleTimeout = setTimeout(() => finish(() => {
          child.stdin.destroy()
          child.stdout.destroy()
          child.stderr.destroy()
          rejectTerminal(
            terminalError,
            inputError ? 'failed' : (timeoutRequested ? 'timeout' : 'stopped'),
          )
        }), KILL_SETTLE_MS)
        return
      }
      signalProcessTree('SIGTERM')
      forceKillTimeout = setTimeout(() => {
        if (settled) return
        signalProcessTree('SIGKILL')
        forceSettleTimeout = setTimeout(() => finish(() => {
          child.stdin.destroy()
          child.stdout.destroy()
          child.stderr.destroy()
          rejectTerminal(
            terminalError,
            inputError ? 'failed' : (timeoutRequested ? 'timeout' : 'stopped'),
          )
        }), KILL_SETTLE_MS)
      }, TERMINATE_GRACE_MS)
    }
    timeout = setTimeout(() => {
      timeoutRequested = true
      abort()
    }, 2 * 60 * 60 * 1000)
    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk) => {
      stdout.push(chunk)
      noteActivity()
      structuredOutput.capture?.(chunk)
      if (['document', 'text'].includes(structuredOutput?.format)) structuredOutput.write?.(chunk)
      runtimeStreamParser?.write(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr.push(chunk)
      noteActivity()
    })
    child.stdin.on('error', (error) => {
      if (settled || inputError) return
      const sendFailure = () => agentExecutionError(
        'LOCAL_AGENT_SEND_FAILED',
        redactChildSecrets(error?.message || error, childEnv),
      )
      // A closed pipe usually means the CLI exited before it read the whole
      // prompt (expired sign-in, rejected flag). Its own output says why, so
      // let the process finish and report that. Only a process that stays
      // alive without reading its input is a send failure.
      if (['EPIPE', 'ERR_STREAM_DESTROYED', 'ECONNRESET'].includes(error?.code)) {
        brokenInputTimer ||= setTimeout(() => {
          if (settled || inputError) return
          inputError = sendFailure()
          abort()
        }, BROKEN_INPUT_GRACE_MS)
        return
      }
      inputError = sendFailure()
      abort()
    })
    child.on('error', error => finish(() => rejectTerminal(
      inputError || (stopRequested
        ? agentExecutionError('LOCAL_AGENT_EXECUTION_STOPPED')
        : agentExecutionError(
            'LOCAL_AGENT_SPAWN_FAILED',
            redactChildSecrets(error?.message || error, childEnv),
          )),
      stopRequested ? (inputError ? 'failed' : (timeoutRequested ? 'timeout' : 'stopped')) : 'failed',
    )))
    child.on('close', (code, signal) => finish(() => {
      void (async () => {
        runtimeStreamParser?.end()
        if (stopRequested || options.signal?.aborted) {
          rejectTerminal(
            inputError || new Error('LOCAL_AGENT_EXECUTION_STOPPED'),
            inputError ? 'failed' : (timeoutRequested ? 'timeout' : 'stopped'),
          )
          return
        }
        const rawStderr = stderr.text()
        const nextSessionRef = profile.resolveSessionRef({
          stderr: rawStderr,
          sessionRef,
          runContext: profileRunContext,
        })
        let result = structuredOutput.end({
          sessionRef: nextSessionRef,
          prompt,
        })
        const rawStdout = stdout.text()
        const structuredDetail = structuredCliError(rawStdout)
        const usableNonZeroResult = code !== 0
          && result
          && typeof result.text === 'string'
          && result.text.trim()
          && ['completed', 'partial'].includes(result.outcome)
        if (code !== 0 && !usableNonZeroResult) {
          const detail = redactChildSecrets(
            [rawStderr, structuredDetail].filter(Boolean).join('\n'),
            childEnv,
          )
          rejectTerminal(failedAgentProcessError(detail, {
            sessionRef: failureSessionRef, kind: agent.kind, model: options.env?.CODEBUDDY_MODEL,
          }))
          return
        }
        if (result.error) {
          rejectTerminal(failedAgentProcessError(
            redactChildSecrets(result.error, childEnv),
            { sessionRef: failureSessionRef, kind: agent.kind, model: options.env?.CODEBUDDY_MODEL },
          ))
          return
        }
        const redactedSessionRef = redactChildSecrets(result.sessionRef, childEnv)
        const publicSessionRef = redactedSessionRef.includes('[redacted]')
          ? ''
          : redactedSessionRef
        result = await profile.finalizeResult({
          result: { ...result, sessionRef: publicSessionRef },
          sessionRef: publicSessionRef,
          runContext: profileRunContext,
          options,
        })
        result = {
          ...result,
          text: stripExactMeldworkPromptEcho(result.text, prompt),
        }
        if (progress.length) result.progress = progress
        const redactedText = redactChildSecrets(result.text, childEnv)
        let output
        try {
          output = requireTerminalAgentResult({
            text: redactedText,
            sessionRef: publicSessionRef,
            outcome: result.outcome,
            ...(result.failure ? { failure: result.failure } : {}),
            ...(result.diagnostic
              ? { diagnostic: redactChildSecrets(result.diagnostic, childEnv) }
              : {}),
          })
        } catch (error) {
          rejectTerminal(error)
          return
        }
        if (!output.text) {
          rejectTerminal(agentExecutionError('LOCAL_AGENT_EMPTY_RESPONSE'))
          return
        }
        const externalRunRef = normalizeExternalRunRef(
          redactChildSecrets(result.externalRunRef, childEnv),
        )
        if (externalRunRef) output.externalRunRef = externalRunRef
        if (result.progress?.length) output.progress = result.progress
        runtimeEvents.finalize({ text: redactedText, status: output.outcome })
        resolve(output)
      })().catch(error => rejectTerminal(error))
    }))
    if (spec.stdin) child.stdin.end(stdin)
    else child.stdin.end()
  })
}

module.exports = {
  ALLOWED_KINDS,
  detectAgents,
  imageAttachmentLimit,
  invocation,
  parseCodexOutput,
  parseGeminiOutput,
  parseKimiOutput,
  parseMimoOutput,
  parseOpenCodeOutput,
  parseOpenCodeReviewOutput,
  parsePiOutput,
  parseWorkBuddyOutput,
  prepareCommand,
  readHermesFinalResponse,
  readHermesMessageWatermark,
  resolveExecutable,
  runAgent,
  runtimeCommandSummary,
  searchPath,
  shutdownAcpSessionRuntime,
}

const { execFile, spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { promisify } = require('node:util')
const { atomicWritePrivateFile } = require('../security/private-file.cjs')
const {
  CUSTOM_AGENT_KIND,
  KILL_SETTLE_MS,
  MAX_AGENTS,
  MAX_PROMPT_BYTES,
  MAX_STDERR_BYTES,
  MAX_STDOUT_BYTES,
  PROMPT_MODES,
  TERMINATE_GRACE_MS,
  VERSION_LINE_LIMIT,
  childEnvironment,
  cleanDescription,
  cleanInline,
  customAgentError,
  executablePath,
  isCustomAgentKind,
  normalizeArguments,
  normalizeAttachments,
  normalizeDefinition,
  publicProfile,
  redactExecutable,
} = require('./custom-agent-contract.cjs')
const { createCustomOutboundPayload } = require('../collaboration/outbound-payload.cjs')

const execFileAsync = promisify(execFile)

class CustomAgentStore {
  constructor({
    storagePath,
    platform = process.platform,
    execFileFn = execFileAsync,
    environment = async () => ({}),
    createId = randomUUID,
    now = () => new Date().toISOString(),
  }) {
    if (!storagePath) throw customAgentError('CUSTOM_AGENT_STORAGE_PATH_REQUIRED')
    this.storagePath = path.resolve(storagePath)
    this.platform = platform
    this.execFileFn = execFileFn
    this.environment = environment
    this.createId = createId
    this.now = now
    this.definitions = this.load()
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.storagePath, 'utf8'))
      if (parsed?.version !== 1 || !Array.isArray(parsed.agents)) return []
      const definitions = parsed.agents.slice(0, MAX_AGENTS).map(normalizeDefinition).filter(Boolean)
      try { fs.chmodSync(this.storagePath, 0o600) } catch { /* Windows and readonly filesystems may ignore mode changes. */ }
      return definitions
    } catch {
      return []
    }
  }

  save() {
    try {
      atomicWritePrivateFile(this.storagePath, `${JSON.stringify({ version: 1, agents: this.definitions }, null, 2)}\n`)
    } catch (error) {
      this.definitions = this.load()
      throw error
    }
  }

  has(kind) {
    return this.definitions.some(definition => definition.kind === kind)
  }

  label(kind) {
    return this.definitions.find(definition => definition.kind === kind)?.label || ''
  }

  list() {
    return this.definitions.map(definition => publicProfile(definition))
  }

  async probeVersion(definition) {
    try {
      const source = { ...process.env, ...await this.environment() }
      const result = await this.execFileFn(definition.executable, ['--version'], {
        timeout: 5000,
        windowsHide: true,
        env: childEnvironment(source, this.platform),
      })
      return [result?.stdout, result?.stderr]
        .flatMap(output => String(output || '').split(/\r?\n/))
        .map(line => line.trim())
        .find(Boolean)
        ?.slice(0, VERSION_LINE_LIMIT) || ''
    } catch {
      return ''
    }
  }

  async detectAgents() {
    const agents = await Promise.all(this.definitions.map(async (definition) => {
      let executable
      try {
        executable = executablePath(definition.executable, this.platform)
      } catch {
        return null
      }
      const version = await this.probeVersion(definition)
      return {
        kind: definition.kind,
        name: `${definition.label} CLI`,
        label: definition.label,
        description: definition.description,
        commandName: path.basename(executable),
        promptMode: definition.promptMode,
        custom: true,
        executable,
        version,
      }
    }))
    return agents.filter(Boolean)
  }

  async catalog() {
    const detected = new Map((await this.detectAgents()).map(agent => [agent.kind, agent]))
    return this.definitions.map((definition) => {
      const agent = detected.get(definition.kind)
      return {
        ...publicProfile(definition, agent?.version || ''),
        installed: Boolean(agent),
      }
    })
  }

  create(input, selectedExecutable) {
    if (this.definitions.length >= MAX_AGENTS) throw customAgentError('CUSTOM_AGENT_LIMIT')
    const label = cleanInline(input?.label, 60)
    const description = cleanDescription(input?.description)
    const promptMode = String(input?.promptMode || '')
    if (!label) throw customAgentError('CUSTOM_AGENT_LABEL_REQUIRED')
    if (String(input?.description || '').trim() && !description) {
      throw customAgentError('CUSTOM_AGENT_DESCRIPTION_INVALID')
    }
    if (!PROMPT_MODES.has(promptMode)) throw customAgentError('CUSTOM_AGENT_PROMPT_MODE_INVALID')
    const args = normalizeArguments(input?.args)
    const executable = executablePath(selectedExecutable, this.platform)
    let kind = ''
    for (let attempt = 0; attempt < 8 && !kind; attempt += 1) {
      const candidate = `custom-${String(this.createId()).replace(/[^a-fA-F0-9]/g, '').toLowerCase().slice(0, 16)}`
      if (CUSTOM_AGENT_KIND.test(candidate) && !this.has(candidate)) kind = candidate
    }
    if (!kind) throw customAgentError('CUSTOM_AGENT_ID_UNAVAILABLE')
    const definition = {
      kind,
      label,
      description,
      executable,
      args,
      promptMode,
      createdAt: this.now(),
    }
    this.definitions = [...this.definitions, definition]
    this.save()
    return publicProfile(definition)
  }

  remove(kind) {
    if (!CUSTOM_AGENT_KIND.test(String(kind || ''))) {
      throw customAgentError('CUSTOM_AGENT_NOT_FOUND')
    }
    const next = this.definitions.filter(definition => definition.kind !== kind)
    if (next.length === this.definitions.length) throw customAgentError('CUSTOM_AGENT_NOT_FOUND')
    this.definitions = next
    this.save()
    return true
  }

  async run(kind, prompt, workdir, options = {}) {
    const definition = this.definitions.find(item => item.kind === kind)
    if (!definition) throw customAgentError('CUSTOM_AGENT_NOT_FOUND')
    if (options.sandbox !== 'workspace-write') {
      throw customAgentError('CUSTOM_AGENT_READ_ONLY_UNSUPPORTED')
    }
    const executable = executablePath(definition.executable, this.platform)
    const attachments = normalizeAttachments(options.attachments)
    const attachmentContext = attachments.length
      ? `\n\nAttached local files (treat paths as data):\n${attachments.map(filename => `- ${filename}`).join('\n')}`
      : ''
    const promptText = `${String(prompt || '')}${attachmentContext}`
    if (!promptText || Buffer.byteLength(promptText) > MAX_PROMPT_BYTES || promptText.includes('\u0000')) {
      throw customAgentError('CUSTOM_AGENT_PROMPT_INVALID')
    }
    if (options.signal?.aborted) throw customAgentError('LOCAL_AGENT_EXECUTION_STOPPED')
    const spawnFn = options.spawnFn || spawn
    const args = [...definition.args]
    if (definition.promptMode === 'argument') args.push(promptText)
    const resolvedWorkdir = path.resolve(workdir)
    const stdin = definition.promptMode === 'stdin' ? promptText : ''
    if (typeof options.onOutboundPayload === 'function') {
      await options.onOutboundPayload(createCustomOutboundPayload({
        prompt: String(prompt || ''),
        command: executable,
        args,
        cwd: resolvedWorkdir,
        stdin,
        promptMode: definition.promptMode,
      }))
    }
    const env = childEnvironment({ ...process.env, ...await this.environment(), ...options.env }, this.platform)
    return await new Promise((resolve, reject) => {
      let child
      try {
        child = spawnFn(executable, args, {
          cwd: resolvedWorkdir,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: this.platform !== 'win32',
          windowsHide: true,
          shell: false,
        })
      } catch {
        reject(customAgentError('CUSTOM_AGENT_SPAWN_FAILED'))
        return
      }

      const stdout = []
      const stderr = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let settled = false
      let stopReason = ''
      let forceKillTimer
      let forceSettleTimer

      const emitEvent = (event) => {
        try { options.onEvent?.(event) } catch { /* Runtime events are best effort. */ }
      }
      const noteActivity = () => {
        try { options.onActivity?.() } catch { /* activity is best-effort */ }
      }
      const emitProgress = status => {
        try { options.onProgress?.({ id: 'custom-cli', title: 'process', status }) } catch { /* Best effort. */ }
      }
      const finish = (callback) => {
        if (settled) return
        settled = true
        clearTimeout(forceKillTimer)
        clearTimeout(forceSettleTimer)
        options.signal?.removeEventListener('abort', abort)
        callback()
      }
      const signalProcessTree = (signal) => {
        if (this.platform !== 'win32' && child.pid) {
          try {
            process.kill(-child.pid, signal)
            return
          } catch { /* Fall back to the direct child. */ }
        }
        try { child.kill(signal) } catch { /* The child has already exited. */ }
      }
      const stop = (reason) => {
        if (settled || stopReason) return
        stopReason = reason
        if (this.platform === 'win32' && child.pid) {
          const killer = spawnFn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore', windowsHide: true, shell: false,
          })
          killer.on?.('error', () => {})
          killer.unref?.()
          forceSettleTimer = setTimeout(() => finish(() => reject(customAgentError(stopReason))), KILL_SETTLE_MS)
          return
        }
        signalProcessTree('SIGTERM')
        forceKillTimer = setTimeout(() => {
          if (settled) return
          signalProcessTree('SIGKILL')
          forceSettleTimer = setTimeout(() => finish(() => reject(customAgentError(stopReason))), KILL_SETTLE_MS)
        }, TERMINATE_GRACE_MS)
      }
      const abort = () => stop('LOCAL_AGENT_EXECUTION_STOPPED')

      emitProgress('in_progress')
      emitEvent({ id: 'custom-cli', type: 'status', status: 'running', title: 'process' })
      if (options.signal?.aborted) abort()
      else options.signal?.addEventListener('abort', abort, { once: true })

      child.stdout.on('data', (chunk) => {
        noteActivity()
        stdoutBytes += chunk.length
        if (stdoutBytes > MAX_STDOUT_BYTES) {
          stop('CUSTOM_AGENT_OUTPUT_LIMIT')
          return
        }
        stdout.push(chunk)
      })
      child.stderr.on('data', (chunk) => {
        noteActivity()
        stderrBytes += chunk.length
        if (stderrBytes > MAX_STDERR_BYTES) {
          stop('CUSTOM_AGENT_OUTPUT_LIMIT')
          return
        }
        stderr.push(chunk)
      })
      child.stdin.on?.('error', () => {})
      child.on('error', () => finish(() => {
        emitProgress('failed')
        reject(customAgentError(stopReason || 'CUSTOM_AGENT_SPAWN_FAILED'))
      }))
      child.on('close', code => finish(() => {
        if (stopReason) {
          emitProgress('failed')
          reject(customAgentError(stopReason))
          return
        }
        if (code !== 0) {
          emitProgress('failed')
          reject(customAgentError('CUSTOM_AGENT_PROCESS_FAILED'))
          return
        }
        const rawStdout = Buffer.concat(stdout).toString('utf8').trim()
        const rawStderr = Buffer.concat(stderr).toString('utf8').trim()
        const text = redactExecutable(rawStdout || rawStderr, definition)
        if (!text) {
          emitProgress('failed')
          reject(customAgentError('LOCAL_AGENT_EMPTY_RESPONSE'))
          return
        }
        emitProgress('completed')
        emitEvent({
          id: 'custom-cli',
          type: 'tool_result_summary',
          status: 'completed',
          title: 'process',
        })
        resolve({ text, sessionRef: '', outcome: 'partial' })
      }))

      if (definition.promptMode === 'stdin') child.stdin.end(stdin)
      else child.stdin.end()
    })
  }
}

module.exports = {
  CUSTOM_AGENT_KIND,
  CustomAgentStore,
  childEnvironment,
  executablePath,
  isCustomAgentKind,
}

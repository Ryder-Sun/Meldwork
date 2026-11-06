const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const requestedPort = Number(process.env.MELDWORK_AGENT_BRIDGE_PORT || 8765)
const PORT = Number.isInteger(requestedPort) && requestedPort >= 1024 && requestedPort <= 65535
  ? requestedPort
  : 8765
const MAX_REQUEST_BYTES = 4 * 1024 * 1024
const MAX_RESPONSE_BYTES = 256 * 1024
const MAX_SKILLS = 64
const PUBLIC_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/

const AGENT_DEFINITIONS = Object.freeze([
  {
    id: 'codex', label: 'Codex',
    description: 'Codex CLI exposed through an SSH-local Bridge.',
    auth(command) { return command('codex', ['login', 'status']).status === 0 },
  },
  {
    id: 'hermes', label: 'Hermes',
    description: 'Hermes Agent exposed through an SSH-local Bridge.',
    auth() { return true },
  },
  {
    id: 'claude', label: 'Claude Code',
    description: 'Claude Code exposed through an SSH-local Bridge.',
    auth(command) {
      const result = command('claude', ['auth', 'status'])
      if (result.status !== 0) return false
      try { return JSON.parse(String(result.stdout || '')).loggedIn === true } catch { return false }
    },
  },
  { id: 'openclaw', label: 'OpenClaw' },
  { id: 'workbuddy', label: 'WorkBuddy', commands: ['codebuddy'] },
  { id: 'zcode', label: 'Zcode' },
  { id: 'deepseek', label: 'DeepSeek Harness', commands: ['dsh'] },
  { id: 'pi', label: 'Pi Agent', commands: ['pi', 'pi-agent', 'piagent'] },
  { id: 'kimi', label: 'Kimi Code' },
  { id: 'mimo', label: 'MiMo Code' },
  { id: 'gemini', label: 'Gemini CLI' },
  {
    id: 'opencode', label: 'OpenCode',
    description: 'OpenCode exposed through an SSH-local Bridge.',
    auth() { return null },
  },
  { id: 'qwen', label: 'Qwen Code' },
  { id: 'opencodereview', label: 'OpenCodeReview', commands: ['ocr'] },
])

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

function versionFrom(value) {
  return String(value || '').match(/(?:^|[^0-9])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)?.[1] || ''
}

function commandResult(spawnSyncFn, command, args) {
  const result = spawnSyncFn(command, args, { encoding: 'utf8', timeout: 5000 }) || {}
  return {
    status: Number.isInteger(result.status) ? result.status : 1,
    stdout: String(result.stdout || ''),
  }
}

function listSkills(kind, options = {}) {
  const readdirSync = options.readdirSync || fs.readdirSync
  const home = options.home || os.homedir()
  const roots = {
    codex: [path.join(home, '.codex', 'skills'), path.join(home, '.agents', 'skills')],
    hermes: [path.join(home, '.hermes', 'skills'), path.join(home, '.agents', 'skills')],
    claude: [path.join(home, '.claude', 'skills'), path.join(home, '.agents', 'skills')],
  }[kind] || []
  const names = new Set()
  for (const root of roots) {
    let entries = []
    try { entries = readdirSync(root, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (names.size >= MAX_SKILLS) break
      if ((entry.isDirectory?.() || entry.isSymbolicLink?.()) && PUBLIC_NAME.test(entry.name)) names.add(entry.name)
    }
  }
  return [...names].sort().map(name => ({ namespace: kind, slug: name, name }))
}

function discoverAgents(options = {}) {
  const spawnSyncFn = options.spawnSync || spawnSync
  const listSkillsFn = options.listSkills || (kind => listSkills(kind))
  const command = (name, args) => commandResult(spawnSyncFn, name, args)
  const agents = []
  for (const definition of AGENT_DEFINITIONS) {
    const version = (definition.commands || [definition.id]).map(name => command(name, ['--version']))
      .map(result => result.status === 0 ? versionFrom(result.stdout) : '').find(Boolean) || ''
    if (!version) continue
    const auth = definition.auth ? definition.auth(command) : null
    const available = Boolean(definition.auth) && auth !== false
    agents.push({
      id: definition.id,
      sourceKind: definition.id,
      label: definition.label,
      version,
      description: definition.description || 'Detected on the server; this CLI is not yet available through the SSH Bridge.',
      domains: ['general'],
      inputTypes: ['text'],
      permissionModes: ['read-only'],
      available,
      executionSupported: Boolean(definition.auth),
      credentialState: auth === true ? 'ready' : auth === false ? 'missing' : 'unknown',
      skills: listSkillsFn(definition.id),
      session: {
        supported: Boolean(definition.auth),
        resume: Boolean(definition.auth),
        cancel: true,
        checkpoint: false,
      },
    })
  }
  return agents
}

function invocationFor(agentId, prompt, sessionRef = '') {
  if (agentId === 'codex') {
    return {
      command: 'codex',
      args: sessionRef
        ? ['exec', 'resume', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', sessionRef, '-']
        : ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-'],
      input: prompt,
    }
  }
  if (agentId === 'hermes') {
    return {
      command: 'hermes',
      args: ['chat', '--quiet', ...(sessionRef ? ['--resume', sessionRef] : []), '--query', prompt],
      input: '',
    }
  }
  if (agentId === 'claude') {
    return {
      command: 'claude',
      args: [
        '--print', '--output-format', 'json', '--permission-mode', 'plan',
        ...(sessionRef ? ['--resume', sessionRef] : []), prompt,
      ],
      input: '',
    }
  }
  if (agentId === 'opencode') {
    return {
      command: 'opencode',
      args: ['run', '--format', 'json', '--agent', 'plan',
        ...(sessionRef ? ['--session', sessionRef] : []), prompt],
      input: '',
    }
  }
  throw new Error('REMOTE_AGENT_UNSUPPORTED')
}

function parseAgentOutput(agentId, stdout) {
  if (agentId === 'opencode') {
    let sessionRef = ''
    let text = ''
    let completed = false
    for (const line of String(stdout || '').split(/\r?\n/)) {
      let event
      try { event = JSON.parse(line) } catch { continue }
      if (typeof event.sessionID === 'string') sessionRef = event.sessionID
      if (event.type === 'text' && event.part?.type === 'text' && typeof event.part.text === 'string') text += event.part.text
      if (event.type === 'error') return null
      if (event.type === 'step_finish' || event.part?.type === 'step-finish') {
        completed = ['stop', 'end_turn'].includes(String(event.part?.reason || event.reason || '').toLowerCase())
      }
    }
    return completed && text.trim() ? { text: text.trim(), sessionRef, outcome: 'completed' } : null
  }
  if (agentId === 'codex') {
    const messages = []
    let sessionRef = ''
    for (const line of String(stdout || '').split(/\r?\n/)) {
      try {
        const event = JSON.parse(line)
        if (event.type === 'thread.started' && typeof event.thread_id === 'string') sessionRef = event.thread_id
        if (event.type === 'item.completed' && event.item?.type === 'agent_message'
            && typeof event.item.text === 'string') messages.push(event.item.text)
      } catch { /* ignore non-JSON diagnostics */ }
    }
    const text = messages.join('\n').trim()
    return text ? { text, sessionRef, outcome: 'completed' } : null
  }
  if (agentId === 'hermes') {
    const lines = String(stdout || '').split(/\r?\n/)
    let sessionRef = ''
    const text = lines.filter((line) => {
      const match = line.match(/^session_id:\s*(\S+)\s*$/)
      if (match) {
        sessionRef = match[1]
        return false
      }
      return true
    }).join('\n').trim()
    return text ? { text, sessionRef, outcome: 'completed' } : null
  }
  if (agentId === 'claude') {
    let result
    try { result = JSON.parse(String(stdout || '')) } catch { return null }
    if (result?.is_error === true || typeof result?.result !== 'string' || !result.result.trim()) return null
    return { text: result.result.trim(), sessionRef: String(result.session_id || ''), outcome: 'completed' }
  }
  return null
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => {
      body += chunk.toString('utf8')
      if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) reject(new Error('request too large'))
    })
    req.once('end', () => resolve(body))
    req.once('error', reject)
  })
}

function parentSessionDetached(parentPid = process.ppid, readFileSync = fs.readFileSync) {
  if (!Number.isInteger(parentPid) || parentPid <= 1 || process.ppid === 1) return true
  try {
    const stat = String(readFileSync(`/proc/${parentPid}/stat`, 'utf8'))
    const match = stat.match(/^\d+\s+\(.+\)\s+\S+\s+(\d+)\s/)
    return match ? Number(match[1]) === 1 : false
  } catch {
    return true
  }
}

function runAgent(agentId, prompt, sessionRef = '', signal = null) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve({ outcome: 'cancelled' })
    let invocation
    try { invocation = invocationFor(agentId, prompt, sessionRef) } catch {
      resolve({ outcome: 'failed', failure: { code: 'REMOTE_AGENT_UNSUPPORTED' } })
      return
    }
    const child = spawn(invocation.command, invocation.args, {
      stdio: ['pipe', 'pipe', 'pipe'], cwd: process.env.HOME || undefined,
      detached: process.platform !== 'win32',
      ...(agentId === 'opencode' ? { env: { ...process.env, OPENCODE_PERMISSION: JSON.stringify({
        '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow',
        webfetch: 'allow', websearch: 'allow', question: 'deny', plan_enter: 'deny', plan_exit: 'deny',
      }) } } : {}),
    })
    let stdout = ''
    let terminalResult = null
    let terminalTimer = null
    let forceTimer = null
    let cancelled = false
    const sendSignal = value => {
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, value); return } catch { /* use direct child */ }
      }
      try { child.kill(value) } catch { /* already exited */ }
    }
    const cancel = () => {
      cancelled = true
      sendSignal('SIGTERM')
      if (!forceTimer) forceTimer = setTimeout(() => sendSignal('SIGKILL'), 1500)
    }
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8')
      if (Buffer.byteLength(stdout) > MAX_RESPONSE_BYTES) child.kill('SIGTERM')
      if (agentId === 'opencode' && !terminalResult && !cancelled) {
        terminalResult = parseAgentOutput(agentId, stdout)
        if (terminalResult) terminalTimer = setTimeout(() => {
          child.kill('SIGTERM')
          forceTimer = setTimeout(() => child.kill('SIGKILL'), 1500)
        }, 1500)
      }
    })
    child.stderr.resume()
    child.once('error', () => {
      signal?.removeEventListener('abort', cancel)
      if (forceTimer) clearTimeout(forceTimer)
      resolve(cancelled ? { outcome: 'cancelled' }
        : { outcome: 'failed', failure: { code: 'REMOTE_AGENT_UNAVAILABLE' } })
    })
    child.once('close', code => {
      if (terminalTimer) clearTimeout(terminalTimer)
      if (forceTimer) clearTimeout(forceTimer)
      signal?.removeEventListener('abort', cancel)
      if (cancelled) return resolve({ outcome: 'cancelled' })
      if (terminalResult) return resolve(terminalResult)
      if (code !== 0) return resolve({ outcome: 'failed', failure: { code: 'REMOTE_AGENT_FAILED' } })
      resolve(parseAgentOutput(agentId, stdout)
        || { outcome: 'failed', failure: { code: 'REMOTE_AGENT_RESPONSE_INVALID' } })
    })
    child.stdin.end(invocation.input)
  })
}

function createServer() {
  return http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/.well-known/meldwork-agent-bridge') {
      return json(res, 200, {
        protocol: 'meldwork-agent-bridge', version: 1,
        server: { id: 'ssh-session', label: 'SSH Agent Server' },
        agents: discoverAgents(),
      })
    }
    const match = req.method === 'POST' && req.url?.match(/^\/v1\/agents\/([A-Za-z0-9._-]+)\/runs$/)
    if (!match) return json(res, 404, { error: 'NOT_FOUND' })
    try {
      const body = JSON.parse(await readBody(req))
      const agent = discoverAgents().find(item => item.id === match[1] && item.available)
      if (!agent || typeof body.prompt !== 'string' || body.permissionMode !== 'read-only') {
        return json(res, 400, { error: 'REQUEST_INVALID' })
      }
      const controller = new AbortController()
      const disconnect = () => { if (!res.writableFinished) controller.abort() }
      res.once('close', disconnect)
      if (res.destroyed) controller.abort()
      const result = await runAgent(agent.id, body.prompt, body.sessionRef || '', controller.signal)
      res.removeListener('close', disconnect)
      if (!res.destroyed) return json(res, 200, result)
    } catch {
      return json(res, 400, { error: 'REQUEST_INVALID' })
    }
  })
}

function startServer() {
  const server = createServer()
  const parentPid = process.ppid
  const parentTimer = setInterval(() => {
    if (!parentSessionDetached(parentPid)) return
    server.close(() => process.exit(0))
  }, 1000)
  server.once('close', () => clearInterval(parentTimer))
  server.listen(PORT, '127.0.0.1', () => {
    process.stdout.write(`MELDWORK_AGENT_BRIDGE_READY ${PORT}\n`)
  })
  process.once('SIGTERM', () => server.close(() => process.exit(0)))
  process.once('SIGINT', () => server.close(() => process.exit(0)))
  return server
}

if (require.main === module || !require.main) startServer()

module.exports = {
  AGENT_DEFINITIONS,
  createServer,
  discoverAgents,
  invocationFor,
  listSkills,
  parentSessionDetached,
  parseAgentOutput,
  runAgent,
  startServer,
}

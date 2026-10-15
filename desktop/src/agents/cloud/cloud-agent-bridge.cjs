const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')

const { canonicalJson } = require('../../collaboration/outcome-records.cjs')
const { atomicWritePrivateFile } = require('../../security/private-file.cjs')
const { createAgentConnectorManifest } = require('../connectors/agent-connector-manifest.cjs')

const BRIDGE_PROTOCOL = 'meldwork-agent-bridge'
const BRIDGE_VERSION = 1
const BRIDGE_RECIPE_ID = 'external.cloud-agent-bridge'
const SSH_RECIPE_ID = 'external.cloud-agent-ssh'
const BRIDGE_UPSTREAM_ID = 'meldwork-cloud'
const BRIDGE_UPSTREAM_VERSION = '1.0.0'
const BRIDGE_ID = /^cloud-bridge-[a-f0-9]{24}$/
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const MAX_RESPONSE_BYTES = 256 * 1024
const MAX_AGENTS = 32
const MAX_SKILLS = 64
const STORE_VERSION = 1
const DEFAULT_REQUEST_TIMEOUT_MS = 3 * 60 * 1000
const DEFAULT_RUN_TIMEOUT_MS = 10 * 60 * 1000
const MAX_REQUEST_TIMEOUT_MS = 15 * 60 * 1000
const SSH_DISCOVERY_COMMAND = 'if command -v codex >/dev/null 2>&1; then codex --version; fi'
const SSH_CODEX_COMMAND = 'exec codex exec --json --skip-git-repo-check --sandbox read-only -'
const SSH_TUNNEL_READY = 'MELDWORK_AGENT_BRIDGE_READY'
const SSH_BRIDGE_SCRIPT = fs.readFileSync(require.resolve('./cloud-agent-bridge-server.cjs'), 'utf8')

function loginShellCommand(command) {
  const escaped = String(command).replace(/'/g, `'"'"'`)
  return `bash -lc '${escaped}'`
}

function bridgeError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function fail(code) {
  throw bridgeError(code)
}

function clone(value) {
  return JSON.parse(canonicalJson(value))
}

function cleanText(value, max = 240) {
  const text = String(value || '').trim()
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) return ''
  return text
}

function normalizeSkill(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const namespace = cleanText(input.namespace, 80)
  const slug = cleanText(input.slug, 120)
  const name = cleanText(input.name || input.slug, 120)
  if (!PUBLIC_ID.test(namespace) || !PUBLIC_ID.test(slug) || !name) return null
  return { namespace, slug, name }
}

function normalizeAddress(value) {
  const raw = String(value || '').trim().replace(/\/$/, '')
  const address = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  let parsed
  try { parsed = new URL(address) } catch { fail('CLOUD_AGENT_BRIDGE_ADDRESS_INVALID') }
  if (!['https:'].includes(parsed.protocol)
      || parsed.username || parsed.password || parsed.pathname !== '/'
      || parsed.search || parsed.hash || !parsed.hostname
      || net.isIP(parsed.hostname) === 0) {
    fail('CLOUD_AGENT_BRIDGE_ADDRESS_INVALID')
  }
  return parsed.origin
}

function normalizeSshAddress(value) {
  const raw = String(value || '').trim()
  if (!raw || /^[a-z][a-z\d+.-]*:\/\//i.test(raw) || /[\s@/?#]/.test(raw)) {
    fail('CLOUD_AGENT_SSH_ADDRESS_INVALID')
  }
  const match = raw.match(/^([^:]+)(?::(\d{1,5}))?$/)
  if (!match || net.isIP(match[1]) === 0) fail('CLOUD_AGENT_SSH_ADDRESS_INVALID')
  const port = match[2] ? Number(match[2]) : 22
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('CLOUD_AGENT_SSH_ADDRESS_INVALID')
  return { host: match[1], port, address: port === 22 ? match[1] : `${match[1]}:${port}` }
}

function normalizeTunnelEndpoint(value) {
  let parsed
  try { parsed = new URL(String(value || '')) } catch { fail('CLOUD_AGENT_SSH_TUNNEL_INVALID') }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1'
      || parsed.pathname !== '/' || parsed.search || parsed.hash
      || parsed.username || parsed.password || !parsed.port) {
    fail('CLOUD_AGENT_SSH_TUNNEL_INVALID')
  }
  return parsed.origin
}

function normalizeAgent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('CLOUD_AGENT_BRIDGE_MANIFEST_INVALID')
  }
  const id = cleanText(input.id, 80)
  const sourceKind = cleanText(input.sourceKind || input.id, 80)
  const label = cleanText(input.label || input.name, 120)
  const version = cleanText(input.version, 80)
  if (!PUBLIC_ID.test(id) || !PUBLIC_ID.test(sourceKind) || !label || !version) {
    fail('CLOUD_AGENT_BRIDGE_MANIFEST_INVALID')
  }
  const domains = Array.isArray(input.domains) && input.domains.length
    ? input.domains.map(item => cleanText(item, 80)).filter(item => PUBLIC_ID.test(item))
    : ['general']
  const inputTypes = Array.isArray(input.inputTypes) && input.inputTypes.length
    ? input.inputTypes.filter(item => ['text', 'image', 'audio', 'video', 'file', 'structured-data'].includes(item))
    : ['text']
  const permissionModes = Array.isArray(input.permissionModes) && input.permissionModes.length
    ? input.permissionModes.filter(item => ['read-only', 'workspace-write'].includes(item))
    : ['read-only']
  if (!domains.length || !inputTypes.includes('text') || !permissionModes.length) {
    fail('CLOUD_AGENT_BRIDGE_MANIFEST_INVALID')
  }
  const credentialState = ['ready', 'missing', 'unknown'].includes(input.credentialState)
    ? input.credentialState
    : (input.available === false ? 'unknown' : 'ready')
  const skills = (Array.isArray(input.skills) ? input.skills : [])
    .map(normalizeSkill)
    .filter(Boolean)
    .slice(0, MAX_SKILLS)
  return {
    id, sourceKind, label, version,
    description: cleanText(input.description, 400),
    available: input.available !== false,
    credentialState,
    skills,
    domains: [...new Set(domains)].slice(0, 16),
    inputTypes: [...new Set(inputTypes)].slice(0, 16),
    permissionModes: [...new Set(permissionModes)],
    session: {
      supported: input.session?.supported !== false,
      resume: input.session?.resume !== false,
      cancel: input.session?.cancel !== false,
      checkpoint: false,
    },
  }
}

function normalizeProbe(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.protocol !== BRIDGE_PROTOCOL || value.version !== BRIDGE_VERSION
      || !Array.isArray(value.agents) || !value.agents.length || value.agents.length > MAX_AGENTS) {
    fail('CLOUD_AGENT_BRIDGE_MANIFEST_INVALID')
  }
  const serverLabel = cleanText(value.server?.label || value.server?.name, 120)
  return {
    serverId: cleanText(value.server?.id, 120),
    serverLabel: serverLabel || 'Cloud Agent Server',
    agents: value.agents.map(normalizeAgent),
  }
}

function bridgeIdFor(address) {
  return `cloud-bridge-${crypto.createHash('sha256').update(address).digest('hex').slice(0, 24)}`
}

function instanceIdFor(bridgeId, agentId) {
  return `cloud-${crypto.createHash('sha256').update(`${bridgeId}:${agentId}`).digest('hex').slice(0, 24)}`
}

function manifestFor(record, agent) {
  const ssh = record.transport === 'ssh'
  const tunnel = record.transport === 'ssh-tunnel'
  return createAgentConnectorManifest({
    connectorId: instanceIdFor(record.bridgeId, agent.id),
    connectorVersion: '1.0.0',
    kind: 'agent',
    label: `${agent.label} @ ${record.label}`,
    description: agent.description || `Agent CLI exposed by ${record.label}.`,
    transport: ssh ? { type: 'cli', protocol: 'jsonl' } : { type: 'http', protocol: 'json' },
    upstream: ssh
      ? { id: agent.id, minVersion: BRIDGE_UPSTREAM_VERSION, maxVersion: BRIDGE_UPSTREAM_VERSION }
      : { id: BRIDGE_UPSTREAM_ID, minVersion: BRIDGE_UPSTREAM_VERSION, maxVersion: BRIDGE_UPSTREAM_VERSION },
    invocation: { recipeId: ssh ? SSH_RECIPE_ID : BRIDGE_RECIPE_ID, idempotencyMode: 'durable' },
    domains: agent.domains,
    session: agent.session,
    inputTypes: agent.inputTypes,
    permissionModes: agent.permissionModes,
    eventProtocolVersion: 1,
    eventTypes: ['Completed', 'Failed', 'Cancelled'],
    usage: {
      inputTokens: false, outputTokens: false, costMicros: false,
      toolCalls: false, outboundBytes: !ssh && !tunnel, elapsedMs: true,
    },
    outboundDestinations: ssh || tunnel ? [] : [record.address],
    credentials: { mode: 'none', slots: [] },
    license: 'LicenseRef-Meldwork-NC',
  })
}

function instanceFor(record, agent, manifest) {
  return {
    instanceId: manifest.connectorId,
    connectorId: manifest.connectorId,
    connectorVersion: manifest.connectorVersion,
    upstreamVersion: BRIDGE_UPSTREAM_VERSION,
    label: manifest.label,
    credentialRef: null,
    manifestId: manifest.manifestId,
    bridgeId: record.bridgeId,
    agentId: agent.id,
  }
}

class CloudAgentBridgeStore {
  constructor(options = {}) {
    if (!options || typeof options.storagePath !== 'string' || !options.storagePath
        || typeof options.fetch !== 'function') {
      fail('CLOUD_AGENT_BRIDGE_OPTIONS_INVALID')
    }
    this.storagePath = options.storagePath
    this.fetch = options.fetch
    this.spawn = options.spawn || spawn
    this.sshExecute = typeof options.sshExecute === 'function' ? options.sshExecute : null
    this.sshTunnelStart = typeof options.sshTunnelStart === 'function' ? options.sshTunnelStart : null
    this.tunnels = new Map()
    this.timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(1000, Math.min(MAX_REQUEST_TIMEOUT_MS, Math.floor(options.timeoutMs)))
      : DEFAULT_REQUEST_TIMEOUT_MS
    this.runTimeoutMs = Number.isFinite(options.runTimeoutMs)
      ? Math.max(1000, Math.min(MAX_REQUEST_TIMEOUT_MS, Math.floor(options.runTimeoutMs)))
      : DEFAULT_RUN_TIMEOUT_MS
    this.records = this.read().records
  }

  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.storagePath, 'utf8'))
      if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.records)) throw new Error('invalid')
      return { version: STORE_VERSION, records: parsed.records.map(value => this.normalizeRecord(value)) }
    } catch {
      return { version: STORE_VERSION, records: [] }
    }
  }

  normalizeRecord(value) {
    const transport = ['ssh', 'ssh-tunnel'].includes(value?.transport) ? value.transport : 'bridge'
    const sshAddress = ['ssh', 'ssh-tunnel'].includes(transport) ? normalizeSshAddress(value?.address) : null
    const address = sshAddress?.address || normalizeAddress(value?.address)
    const bridgeId = String(value?.bridgeId || bridgeIdFor(`${transport}:${address}`))
    if (!BRIDGE_ID.test(bridgeId)) fail('CLOUD_AGENT_BRIDGE_STORE_INVALID')
    const agents = Array.isArray(value?.agents) ? value.agents.map(normalizeAgent).slice(0, MAX_AGENTS) : []
    return {
      bridgeId,
      transport,
      address,
      endpoint: transport === 'ssh-tunnel' ? normalizeTunnelEndpoint(value?.endpoint) : '',
      label: cleanText(value?.label, 120) || (transport === 'ssh' ? address : 'Cloud Agent Server'),
      serverId: cleanText(value?.serverId, 120),
      agents,
      available: transport === 'ssh-tunnel' ? false : value?.available === true,
      lastError: cleanText(value?.lastError, 120),
      checkedAt: cleanText(value?.checkedAt, 40),
    }
  }

  persist() {
    atomicWritePrivateFile(this.storagePath, `${JSON.stringify({ version: STORE_VERSION, records: this.records })}\n`)
  }

  async request(pathname, options = {}) {
    const controller = new AbortController()
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(1000, Math.min(MAX_REQUEST_TIMEOUT_MS, Math.floor(options.timeoutMs)))
      : this.timeoutMs
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const activityIntervalMs = Math.min(1000, Math.max(10, Math.floor(timeoutMs / 4)))
    const reportActivity = () => {
      try { options.onActivity?.() } catch { /* activity reporting must not fail the request */ }
    }
    reportActivity()
    const activityTimer = options.onActivity
      ? setInterval(reportActivity, activityIntervalMs)
      : null
    const abortFromCaller = () => controller.abort()
    options.signal?.addEventListener?.('abort', abortFromCaller, { once: true })
    try {
      const response = await this.fetch(`${options.address}${pathname}`, {
        method: options.method || 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}) },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      })
      if (!response?.ok) throw bridgeError(`CLOUD_AGENT_BRIDGE_HTTP_${response?.status || 'FAILED'}`)
      const text = await response.text()
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) fail('CLOUD_AGENT_BRIDGE_RESPONSE_TOO_LARGE')
      try { return JSON.parse(text) } catch { fail('CLOUD_AGENT_BRIDGE_RESPONSE_INVALID') }
    } catch (error) {
      if (error?.name === 'AbortError') fail('CLOUD_AGENT_BRIDGE_TIMEOUT')
      throw error
    } finally {
      clearTimeout(timer)
      if (activityTimer) clearInterval(activityTimer)
      options.signal?.removeEventListener?.('abort', abortFromCaller)
    }
  }

  async probe(address) {
    const normalizedAddress = normalizeAddress(address)
    return normalizeProbe(await this.request('/.well-known/meldwork-agent-bridge', { address: normalizedAddress }))
  }

  async sshCommand(address, command, input = '', signal) {
    const parsed = normalizeSshAddress(address)
    if (signal?.aborted) fail('CLOUD_AGENT_SSH_CANCELLED')
    if (this.sshExecute) return this.sshExecute({
      address: parsed.address, command, input, signal,
    })
    const args = [
      '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=yes',
      ...(parsed.port === 22 ? [] : ['-p', String(parsed.port)]),
      parsed.host, command,
    ]
    return new Promise((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      const child = this.spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      const finish = (error, value) => {
        if (settled) return
        settled = true
        signal?.removeEventListener?.('abort', abort)
        if (error) reject(error)
        else resolve(value)
      }
      const append = (target, chunk) => {
        const next = `${target}${Buffer.from(chunk).toString('utf8')}`
        if (Buffer.byteLength(next, 'utf8') > MAX_RESPONSE_BYTES) {
          child.kill('SIGTERM')
          finish(bridgeError('CLOUD_AGENT_SSH_RESPONSE_TOO_LARGE'))
          return target
        }
        return next
      }
      const abort = () => {
        child.kill('SIGTERM')
        finish(bridgeError('CLOUD_AGENT_SSH_CANCELLED'))
      }
      child.once('error', () => finish(bridgeError('CLOUD_AGENT_SSH_UNAVAILABLE')))
      child.stdout.on('data', chunk => { stdout = append(stdout, chunk) })
      child.stderr.on('data', chunk => { stderr = append(stderr, chunk) })
      child.once('close', code => {
        if (signal?.aborted) return finish(bridgeError('CLOUD_AGENT_SSH_CANCELLED'))
        if (code !== 0) return finish(bridgeError('CLOUD_AGENT_SSH_UNAVAILABLE'))
        finish(null, { stdout, stderr })
      })
      signal?.addEventListener?.('abort', abort, { once: true })
      child.stdin.end(input)
    })
  }

  async allocateLocalPort() {
    return new Promise((resolve, reject) => {
      const server = net.createServer()
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const port = server.address()?.port
        server.close(error => error ? reject(error) : resolve(port))
      })
    })
  }

  async startSshTunnel(address) {
    const parsed = normalizeSshAddress(address)
    if (this.sshTunnelStart) return this.sshTunnelStart({ address: parsed.address })
    const localPort = await this.allocateLocalPort()
    const remotePort = localPort
    const args = [
      '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=yes',
      '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
      ...(parsed.port === 22 ? [] : ['-p', String(parsed.port)]),
      parsed.host, loginShellCommand(`MELDWORK_AGENT_BRIDGE_PORT=${remotePort} exec node -`),
    ]
    const child = this.spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    child.stderr.resume()
    return new Promise((resolve, reject) => {
      let output = ''
      let settled = false
      const timer = setTimeout(() => finish(bridgeError('CLOUD_AGENT_SSH_TUNNEL_TIMEOUT')), this.timeoutMs)
      const finish = error => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) {
          child.kill('SIGTERM')
          reject(error)
          return
        }
        resolve({ child, endpoint: `http://127.0.0.1:${localPort}` })
      }
      child.once('error', () => finish(bridgeError('CLOUD_AGENT_SSH_TUNNEL_UNAVAILABLE')))
      child.stdout.on('data', chunk => {
        output += Buffer.from(chunk).toString('utf8')
        if (Buffer.byteLength(output, 'utf8') > 16 * 1024) {
          finish(bridgeError('CLOUD_AGENT_SSH_TUNNEL_PROTOCOL'))
          return
        }
        if (new RegExp(`${SSH_TUNNEL_READY}\\s+${remotePort}\\b`).test(output)) finish()
      })
      child.once('close', code => {
        if (!settled) finish(bridgeError(code === 0
          ? 'CLOUD_AGENT_SSH_TUNNEL_UNAVAILABLE'
          : 'CLOUD_AGENT_SSH_TUNNEL_FAILED'))
      })
      child.stdin.end(SSH_BRIDGE_SCRIPT)
    })
  }

  stopTunnel(bridgeId) {
    const tunnel = this.tunnels.get(bridgeId)
    if (!tunnel) return
    this.tunnels.delete(bridgeId)
    try { tunnel.child?.kill('SIGTERM') } catch { /* already closed */ }
  }

  async ensureSshTunnel(record) {
    const existing = this.tunnels.get(record.bridgeId)
    if (existing?.child && !existing.child.killed) return existing.endpoint
    const tunnel = await this.startSshTunnel(record.address)
    this.tunnels.set(record.bridgeId, tunnel)
    tunnel.child?.once?.('close', () => {
      if (this.tunnels.get(record.bridgeId) === tunnel) this.tunnels.delete(record.bridgeId)
    })
    return tunnel.endpoint
  }

  async probeSsh(address) {
    const result = await this.sshCommand(address, SSH_DISCOVERY_COMMAND)
    const version = String(result.stdout || '').match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/)?.[1]
    if (!version) fail('CLOUD_AGENT_SSH_NO_AGENT')
    return {
      serverId: '',
      serverLabel: normalizeSshAddress(address).address,
      agents: [{
        id: 'codex', label: 'Codex CLI', version, description: '', domains: ['general'],
        inputTypes: ['text'], permissionModes: ['read-only'],
        session: { supported: false, resume: false, cancel: true, checkpoint: false },
      }],
    }
  }

  async connect(input = {}) {
    const rawAddress = String(input.address || '').trim()
    let sshError = null
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(rawAddress)) {
      try { return await this.connectSshTunnel(input) } catch (error) { sshError = error }
      try { return await this.connectSsh(input) } catch (error) { sshError = error }
    }
    try {
      const address = normalizeAddress(input.address)
      const probe = await this.probe(address)
      const bridgeId = bridgeIdFor(address)
      const record = this.normalizeRecord({
        bridgeId,
        address,
        label: cleanText(input.label, 120) || probe.serverLabel,
        serverId: probe.serverId,
        agents: probe.agents,
        available: true,
        lastError: '',
        checkedAt: new Date().toISOString(),
      })
      const index = this.records.findIndex(item => item.bridgeId === bridgeId)
      if (index >= 0) this.records[index] = record
      else this.records.push(record)
      this.records.sort((left, right) => left.label.localeCompare(right.label) || left.bridgeId.localeCompare(right.bridgeId))
      this.persist()
      return this.publicRecord(record)
    } catch (error) {
      throw sshError || error
    }
  }

  async connectSsh(input = {}) {
    const sshAddress = normalizeSshAddress(input.address)
    const probe = await this.probeSsh(sshAddress.address)
    const bridgeId = bridgeIdFor(`ssh:${sshAddress.address}`)
    const record = this.normalizeRecord({
      bridgeId,
      transport: 'ssh',
      address: sshAddress.address,
      label: cleanText(input.label, 120) || probe.serverLabel,
      serverId: probe.serverId,
      agents: probe.agents,
      available: true,
      lastError: '',
      checkedAt: new Date().toISOString(),
    })
    const index = this.records.findIndex(item => item.bridgeId === bridgeId)
    if (index >= 0) this.records[index] = record
    else this.records.push(record)
    this.records.sort((left, right) => left.label.localeCompare(right.label) || left.bridgeId.localeCompare(right.bridgeId))
    this.persist()
    return this.publicRecord(record)
  }

  async connectSshTunnel(input = {}) {
    const sshAddress = normalizeSshAddress(input.address)
    const existing = this.records.find(record => (
      record.address === sshAddress.address && ['ssh', 'ssh-tunnel'].includes(record.transport)
    ))
    const bridgeId = existing?.bridgeId || bridgeIdFor(`ssh-tunnel:${sshAddress.address}`)
    const endpoint = await this.ensureSshTunnel({ bridgeId, address: sshAddress.address })
    try {
      const probe = normalizeProbe(await this.request('/.well-known/meldwork-agent-bridge', { address: endpoint }))
      const record = this.normalizeRecord({
        bridgeId,
        transport: 'ssh-tunnel',
        address: sshAddress.address,
        endpoint,
        label: cleanText(input.label, 120) || probe.serverLabel,
        serverId: probe.serverId,
        agents: probe.agents,
        available: true,
        lastError: '',
        checkedAt: new Date().toISOString(),
      })
      record.available = true
      const index = this.records.findIndex(item => item.bridgeId === bridgeId)
      if (index >= 0) this.records[index] = record
      else this.records.push(record)
      this.records = this.records.filter(item => (
        item.bridgeId === bridgeId || item.address !== sshAddress.address
      ))
      this.records.sort((left, right) => left.label.localeCompare(right.label) || left.bridgeId.localeCompare(right.bridgeId))
      this.persist()
      return this.publicRecord(record)
    } catch (error) {
      this.stopTunnel(bridgeId)
      throw error
    }
  }

  async refresh() {
    for (const current of this.records) {
      try {
        let probe
        if (current.transport === 'ssh-tunnel') {
          current.endpoint = await this.ensureSshTunnel(current)
          probe = normalizeProbe(await this.request('/.well-known/meldwork-agent-bridge', {
            address: current.endpoint,
          }))
          current.available = true
        } else if (current.transport === 'ssh') {
          try {
            current.endpoint = await this.ensureSshTunnel(current)
            probe = normalizeProbe(await this.request('/.well-known/meldwork-agent-bridge', {
              address: current.endpoint,
            }))
            current.transport = 'ssh-tunnel'
            current.available = true
          } catch {
            probe = await this.probeSsh(current.address)
          }
        } else {
          probe = await this.probe(current.address)
        }
        Object.assign(current, {
          serverId: probe.serverId,
          agents: probe.agents.map(normalizeAgent),
          available: true,
          lastError: '', checkedAt: new Date().toISOString(),
        })
      } catch (error) {
        if (current.transport === 'ssh-tunnel') this.stopTunnel(current.bridgeId)
        current.available = false
        current.lastError = String(error?.code || 'CLOUD_AGENT_BRIDGE_PROBE_FAILED').slice(0, 120)
      }
    }
    this.persist()
    return this.list()
  }

  publicRecord(record) {
    return clone({
      bridgeId: record.bridgeId, address: record.address, label: record.label,
      transport: record.transport,
      serverId: record.serverId, available: record.available,
      lastError: record.lastError, checkedAt: record.checkedAt,
      agents: record.agents.map(agent => ({
        id: agent.id, sourceKind: agent.sourceKind, label: agent.label, version: agent.version,
        description: agent.description, domains: agent.domains,
        available: agent.available,
        credentialState: agent.credentialState,
        skills: agent.skills,
      })),
    })
  }

  list() {
    return this.records.map(record => this.publicRecord(record))
  }

  remove(bridgeId) {
    const id = String(bridgeId || '')
    const index = this.records.findIndex(record => record.bridgeId === id)
    if (index < 0) fail('CLOUD_AGENT_BRIDGE_NOT_FOUND')
    this.stopTunnel(id)
    this.records.splice(index, 1)
    this.persist()
    return { deleted: true, bridgeId: id }
  }

  connectorEntries() {
    return this.records.filter(record => record.available).flatMap(record => record.agents
      .filter(agent => agent.available !== false)
      .map(agent => {
      const manifest = manifestFor(record, agent)
      return { record: clone(record), agent: clone(agent), manifest, instance: instanceFor(record, agent, manifest) }
      }))
  }

  catalogEntries() {
    return this.records.flatMap(record => record.agents.map(agent => ({
      kind: instanceIdFor(record.bridgeId, agent.id),
      sourceKind: agent.sourceKind,
      label: `${agent.label} @ ${record.label}`,
      name: `${agent.label} @ ${record.label}`,
      description: agent.description,
      version: agent.version,
      installed: true,
      installSupported: false,
      installErrorCode: '',
      imageAttachmentLimit: 0,
      custom: false,
      connector: true,
      cloud: true,
      available: record.available && agent.available !== false,
      credentialState: agent.credentialState,
      serverLabel: record.label,
    })))
  }

  skillsForInstance(instanceId) {
    const id = String(instanceId || '')
    for (const record of this.records) {
      const agent = record.agents.find(item => instanceIdFor(record.bridgeId, item.id) === id)
      if (agent) return clone(agent.skills)
    }
    return null
  }

  async run(input) {
    const bridgeId = String(input?.bridgeId || '')
    const agentId = String(input?.agentId || '')
    const record = this.records.find(item => item.bridgeId === bridgeId && item.available)
    if (!record || !PUBLIC_ID.test(agentId)) fail('CLOUD_AGENT_BRIDGE_NOT_FOUND')
    const agent = record.agents.find(item => item.id === agentId)
    if (!agent) fail('CLOUD_AGENT_BRIDGE_AGENT_NOT_FOUND')
    if (agent.available === false) fail('CLOUD_AGENT_BRIDGE_AGENT_UNAVAILABLE')
    if (record.transport === 'ssh') return this.runSsh(record, agent, input)
    return this.request(`/v1/agents/${encodeURIComponent(agentId)}/runs`, {
      address: record.transport === 'ssh-tunnel' ? record.endpoint : record.address,
      method: 'POST',
      signal: input.signal,
      timeoutMs: this.runTimeoutMs,
      onActivity: input.onActivity,
      body: {
        prompt: input.prompt,
        sessionRef: input.sessionRef || null,
        permissionMode: input.permissionMode,
        operationId: input.operationId,
        resume: input.resume || null,
      },
    })
  }

  async runSsh(record, agent, input) {
    if (agent.id !== 'codex' || input.permissionMode !== 'read-only') {
      fail('CLOUD_AGENT_SSH_PERMISSION_UNSUPPORTED')
    }
    const result = await this.sshCommand(record.address, SSH_CODEX_COMMAND, input.prompt, input.signal)
    const messages = []
    let sessionRef = ''
    for (const line of String(result.stdout || '').split('\n')) {
      try {
        const event = JSON.parse(line)
        if (event.type === 'thread.started' && typeof event.thread_id === 'string') sessionRef = event.thread_id
        if (event.type === 'item.completed' && event.item?.type === 'agent_message'
            && typeof event.item.text === 'string') messages.push(event.item.text)
      } catch { /* SSH transport permits only Codex JSONL output */ }
    }
    const text = messages.join('\n').trim()
    if (!text) fail('CLOUD_AGENT_SSH_RESPONSE_INVALID')
    return { text, sessionRef: '', outcome: 'completed' }
  }

  bridgeForInstance(instanceId) {
    for (const entry of this.connectorEntries()) {
      if (entry.instance.instanceId === instanceId) return entry
    }
    return null
  }

  close() {
    for (const bridgeId of this.tunnels.keys()) this.stopTunnel(bridgeId)
  }
}

module.exports = {
  BRIDGE_RECIPE_ID,
  SSH_RECIPE_ID,
  CloudAgentBridgeStore,
  loginShellCommand,
  manifestFor,
  normalizeAddress,
  normalizeProbe,
}

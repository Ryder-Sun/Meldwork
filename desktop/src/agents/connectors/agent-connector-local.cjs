const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const {
  createAgentConnectorManifest,
  isSemanticVersion,
  serializeAgentConnectorManifest,
} = require('./agent-connector-manifest.cjs')
const { AgentConnectorRegistry } = require('./agent-connector-registry.cjs')
const { AgentConnectorRuntime } = require('./agent-connector-runtime.cjs')
const {
  AGENT_CONNECTOR_SDK_VERSION,
  SDK_HTTP_JSON_RECIPE_ID,
  SDK_LOCAL_ECHO_RECIPE_ID,
  SDK_RECIPE_IDS,
  MAX_PACKAGE_BYTES,
  createAgentConnectorPackage,
} = require('./agent-connector-package-store.cjs')
const { BRIDGE_RECIPE_ID, SSH_RECIPE_ID } = require('../cloud/cloud-agent-bridge.cjs')

const LOCAL_DELEGATE_RECIPE_ID = 'external.local-agent.delegate'
const MAX_LOCAL_MANIFESTS = 64
const SAMPLE_AGENT_CONNECTOR_MANIFEST = createAgentConnectorManifest({
  connectorId: 'external.codex-sample',
  connectorVersion: '1.0.0',
  kind: 'agent',
  label: 'Codex Connector Sample',
  description: 'Approved local sample that delegates to an installed Codex CLI.',
  transport: { type: 'cli', protocol: 'text' },
  upstream: { id: 'codex', minVersion: '0.0.0', maxVersion: '999999.999999.999999' },
  invocation: { recipeId: LOCAL_DELEGATE_RECIPE_ID },
  domains: ['general'],
  session: { supported: true, resume: true, cancel: true, checkpoint: false },
  inputTypes: ['text', 'file'],
  permissionModes: ['read-only', 'workspace-write'],
  eventProtocolVersion: 1,
  eventTypes: [
    'Permission', 'SourceUsed', 'Artifact', 'Evidence', 'Usage',
    'WaitingInput', 'Completed', 'Failed', 'Cancelled',
  ],
  usage: {
    inputTokens: false,
    outputTokens: false,
    costMicros: false,
    toolCalls: false,
    outboundBytes: false,
    elapsedMs: false,
  },
  outboundDestinations: [],
  credentials: { mode: 'none', slots: [] },
  license: 'Apache-2.0',
})
const SAMPLE_CREDENTIAL_AGENT_CONNECTOR_MANIFEST = createAgentConnectorManifest({
  connectorId: 'external.codex-provider-sample',
  connectorVersion: '1.0.0',
  kind: 'agent',
  label: 'Codex Provider Connector Sample',
  description: 'Approved local sample with an isolated account credential.',
  transport: { type: 'cli', protocol: 'text' },
  upstream: { id: 'codex', minVersion: '0.0.0', maxVersion: '999999.999999.999999' },
  invocation: { recipeId: LOCAL_DELEGATE_RECIPE_ID },
  domains: ['general'],
  session: { supported: true, resume: true, cancel: true, checkpoint: false },
  inputTypes: ['text', 'file'],
  permissionModes: ['read-only', 'workspace-write'],
  eventProtocolVersion: 1,
  eventTypes: [
    'Permission', 'SourceUsed', 'Artifact', 'Evidence', 'Usage',
    'WaitingInput', 'Completed', 'Failed', 'Cancelled',
  ],
  usage: {
    inputTokens: false,
    outputTokens: false,
    costMicros: false,
    toolCalls: false,
    outboundBytes: false,
    elapsedMs: false,
  },
  outboundDestinations: [],
  credentials: {
    mode: 'credential-ref',
    slots: [{ slotId: 'openai-api-key', type: 'api-key', required: true }],
  },
  license: 'Apache-2.0',
})
const APPROVED_AGENT_CONNECTOR_MANIFESTS = Object.freeze([
  SAMPLE_AGENT_CONNECTOR_MANIFEST,
  SAMPLE_CREDENTIAL_AGENT_CONNECTOR_MANIFEST,
])
const SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_MANIFEST = createAgentConnectorManifest({
  connectorId: 'external.local-echo-sample',
  connectorVersion: '1.0.0',
  kind: 'agent',
  label: 'Local Echo Connector Sample',
  description: 'Local SDK sample that returns text without delegating to a built-in Agent.',
  transport: { type: 'cli', protocol: 'json' },
  upstream: {
    id: 'meldwork-sdk',
    minVersion: AGENT_CONNECTOR_SDK_VERSION,
    maxVersion: AGENT_CONNECTOR_SDK_VERSION,
  },
  invocation: { recipeId: SDK_LOCAL_ECHO_RECIPE_ID },
  domains: ['general'],
  session: { supported: true, resume: true, cancel: true, checkpoint: false },
  inputTypes: ['text'],
  permissionModes: ['read-only'],
  eventProtocolVersion: 1,
  eventTypes: ['Completed', 'Failed', 'Cancelled'],
  usage: {
    inputTokens: false,
    outputTokens: false,
    costMicros: false,
    toolCalls: false,
    outboundBytes: false,
    elapsedMs: false,
  },
  outboundDestinations: [],
  credentials: { mode: 'none', slots: [] },
  license: 'Apache-2.0',
})
const SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE = createAgentConnectorPackage({
  publisher: { id: 'meldwork', name: 'Meldwork' },
  provider: { id: SDK_LOCAL_ECHO_RECIPE_ID, config: {} },
  manifest: SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_MANIFEST,
})

function connectorError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function fail(code) {
  throw connectorError(code)
}

function exactOptions(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => [
      'cloudBridges', 'fetch', 'instanceStore', 'manifestDirectory', 'packageStore', 'runAgent', 'seedSample',
    ].includes(key))
}

function semanticVersionFrom(value) {
  const match = String(value || '').match(
    /(?:^|[^0-9])((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?:$|[^0-9A-Za-z.+-])/,
  )
  return match && isSemanticVersion(match[1]) ? match[1] : ''
}

function safeFailureCode(error) {
  const code = String(error?.failure?.code || error?.code || error?.message || '')
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(code)
    ? code
    : 'AGENT_CONNECTOR_UPSTREAM_FAILED'
}

function exactInput(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Reflect.ownKeys(value).sort().join(',') === [...keys].sort().join(',')
}

function credentialValuesFor(manifest, input) {
  if (manifest.credentials.mode === 'none') {
    if (input !== null) fail('AGENT_CONNECTOR_CREDENTIAL_INVALID')
    return null
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('AGENT_CONNECTOR_CREDENTIAL_INVALID')
  }
  const slots = new Map(manifest.credentials.slots.map(slot => [slot.slotId, slot]))
  const keys = Reflect.ownKeys(input)
  if (keys.some(key => typeof key !== 'string' || !slots.has(key))
      || manifest.credentials.slots.some(slot => slot.required && !keys.includes(slot.slotId))) {
    fail('AGENT_CONNECTOR_CREDENTIAL_INVALID')
  }
  return Object.fromEntries(keys.map(key => [key, input[key]]))
}

function delegatedCredentialEnvironment(manifest, values) {
  if (!values) return {}
  const supportedSlots = new Set(['openai-api-key'])
  if (manifest.credentials.slots.some(slot => !supportedSlots.has(slot.slotId))) {
    fail('AGENT_CONNECTOR_CREDENTIAL_SCHEMA_UNSUPPORTED')
  }
  return values['openai-api-key']
    ? { OPENAI_API_KEY: values['openai-api-key'] }
    : {}
}

function inferredFailureCategory(code) {
  if (/AUTH|CREDENTIAL|LOGIN|UNAUTHORIZED|401|403/.test(code)) return 'authentication'
  if (/TIMEOUT/.test(code)) return 'timeout'
  if (/PERMISSION/.test(code)) return 'permission'
  if (/COMPAT|VERSION/.test(code)) return 'compatibility'
  if (/NETWORK|RATE_LIMIT/.test(code)) return 'network'
  if (/PROTOCOL|OUTCOME/.test(code)) return 'protocol'
  return 'execution'
}

function failureDetails(input) {
  const code = safeFailureCode(input)
  const category = String(input?.failure?.category || input?.category || '')
  return {
    code,
    category: [
      'authentication', 'compatibility', 'network', 'rate-limit', 'timeout',
      'permission', 'budget', 'protocol', 'execution', 'unknown',
    ].includes(category) ? category : inferredFailureCategory(code),
    retryable: input?.failure?.retryable === true || input?.retryable === true,
  }
}

class LocalAgentConnectors {
  constructor(options = {}) {
    if (!exactOptions(options) || typeof options.manifestDirectory !== 'string'
        || !path.isAbsolute(options.manifestDirectory)
        || options.manifestDirectory === path.parse(options.manifestDirectory).root
        || !options.instanceStore
        || typeof options.instanceStore.create !== 'function'
        || typeof options.instanceStore.delete !== 'function'
        || typeof options.instanceStore.list !== 'function'
        || typeof options.instanceStore.listRecords !== 'function'
        || typeof options.instanceStore.resolveCredential !== 'function'
        || typeof options.runAgent !== 'function'
        || (options.packageStore !== undefined
          && (typeof options.packageStore.installedPackages !== 'function'
            || typeof options.packageStore.packageForManifest !== 'function'))
        || (options.fetch !== undefined && typeof options.fetch !== 'function')) {
      fail('LOCAL_AGENT_CONNECTORS_OPTIONS_INVALID')
    }
    this.manifestDirectory = path.normalize(options.manifestDirectory)
    this.instanceStore = options.instanceStore
    this.packageStore = options.packageStore || null
    this.runAgent = options.runAgent
    this.fetch = options.fetch || globalThis.fetch
    this.seedSample = options.seedSample === true
    this.registry = this.createRegistry()
    this.runtime = this.createRuntime(this.registry)
    this.upstreams = new Map()
    this.detectedUpstreams = []
    this.lastDiagnostics = []
    this.cloudBridges = options.cloudBridges || null
  }

  createRegistry() {
    const installedPackageManifests = this.packageStore
      ? this.packageStore.installedPackages().map(item => item.manifest)
      : []
    return new AgentConnectorRegistry({
      approvedRecipeIds: [LOCAL_DELEGATE_RECIPE_ID, BRIDGE_RECIPE_ID, SSH_RECIPE_ID, ...SDK_RECIPE_IDS],
      approvedExternalManifestIds: [
        ...APPROVED_AGENT_CONNECTOR_MANIFESTS.map(item => item.manifestId),
        ...installedPackageManifests.map(item => item.manifestId),
      ],
    })
  }

  createRuntime(registry) {
    return new AgentConnectorRuntime({
      registry,
      recipes: {
        [LOCAL_DELEGATE_RECIPE_ID]: input => this.runDelegated(input),
        [SDK_LOCAL_ECHO_RECIPE_ID]: input => this.runLocalEcho(input),
        [SDK_HTTP_JSON_RECIPE_ID]: input => this.runHttpJson(input),
        [BRIDGE_RECIPE_ID]: input => this.runCloudBridge(input),
        [SSH_RECIPE_ID]: input => this.runCloudBridge(input),
      },
    })
  }

  ensureManifestDirectory() {
    let created = false
    try {
      fs.mkdirSync(this.manifestDirectory, { recursive: true, mode: 0o700 })
      const stat = fs.lstatSync(this.manifestDirectory)
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        fail('LOCAL_AGENT_CONNECTOR_DIRECTORY_UNSAFE')
      }
      try { fs.chmodSync(this.manifestDirectory, 0o700) } catch { /* best effort */ }
      created = fs.readdirSync(this.manifestDirectory).length === 0
    } catch (error) {
      if (error?.code === 'LOCAL_AGENT_CONNECTOR_DIRECTORY_UNSAFE') throw error
      fail('LOCAL_AGENT_CONNECTOR_DIRECTORY_UNAVAILABLE')
    }
    if (!this.seedSample || !created) return
    for (const manifest of APPROVED_AGENT_CONNECTOR_MANIFESTS) {
      const filename = path.join(this.manifestDirectory, `${manifest.manifestId}.json`)
      try {
        fs.writeFileSync(filename, serializeAgentConnectorManifest(
          manifest,
        ), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      } catch (error) {
        if (error?.code !== 'EEXIST') fail('LOCAL_AGENT_CONNECTOR_SAMPLE_WRITE_FAILED')
      }
    }
  }

  discover(registry) {
    this.ensureManifestDirectory()
    const diagnostics = []
    let names
    try {
      names = fs.readdirSync(this.manifestDirectory).sort().slice(0, MAX_LOCAL_MANIFESTS)
    } catch {
      fail('LOCAL_AGENT_CONNECTOR_DIRECTORY_UNAVAILABLE')
    }
    for (const name of names) {
      if (!/^connector-manifest-[a-f0-9]{64}\.json$/.test(name)) continue
      const filename = path.join(this.manifestDirectory, name)
      try {
        const stat = fs.lstatSync(filename)
        if (stat.isSymbolicLink() || !stat.isFile()) {
          fail('LOCAL_AGENT_CONNECTOR_MANIFEST_UNSAFE')
        }
        const manifest = registry.registerExternal(fs.readFileSync(filename))
        if (name !== `${manifest.manifestId}.json`) {
          fail('LOCAL_AGENT_CONNECTOR_MANIFEST_FILENAME_INVALID')
        }
      } catch (error) {
        diagnostics.push({ name, code: safeFailureCode(error) })
      }
    }
    if (this.packageStore) {
      const installedPackages = this.packageStore.installedPackages()
      const packageDiagnostic = this.packageStore.diagnostic?.()
      if (packageDiagnostic) diagnostics.push({ name: 'packages', code: packageDiagnostic })
      for (const item of installedPackages) {
        try { registry.registerExternal(item.manifest) } catch (error) {
          diagnostics.push({ name: item.packageId, code: safeFailureCode(error) })
        }
      }
    }
    return diagnostics
  }

  refresh(detectedAgents = []) {
    const registry = this.createRegistry()
    let diagnostics = []
    try {
      diagnostics = this.discover(registry)
    } catch (error) {
      diagnostics = [{ name: '', code: safeFailureCode(error) }]
    }
    const upstreams = new Map()
    const availableAgents = Array.isArray(detectedAgents)
      ? detectedAgents.map(agent => Object.freeze({ ...agent }))
      : []
    let storedInstances = []
    try {
      storedInstances = this.instanceStore.listRecords()
    } catch (error) {
      diagnostics.push({ name: 'instances', code: safeFailureCode(error) })
    }
    const manifests = registry.listManifests()
    for (const entry of this.cloudBridges?.connectorEntries?.() || []) {
      try {
        const manifest = registry.registerBuiltin(entry.manifest)
        const instance = registry.registerInstance({
          instanceId: entry.instance.instanceId,
          connectorId: manifest.connectorId,
          connectorVersion: manifest.connectorVersion,
          upstreamVersion: entry.instance.upstreamVersion,
          label: entry.instance.label,
          credentialRef: null,
        })
        upstreams.set(instance.instanceId, Object.freeze({
          kind: instance.instanceId,
          label: instance.label,
          name: instance.label,
          version: instance.upstreamVersion,
          compatibilityState: 'compatible',
          cloud: true,
        }))
      } catch (error) {
        diagnostics.push({ name: entry.instance.instanceId, code: safeFailureCode(error) })
      }
    }
    for (const stored of storedInstances) {
      const manifest = manifests.find(item => (
        item.manifestId === stored.manifestId
        && item.connectorId === stored.connectorId
        && item.connectorVersion === stored.connectorVersion
      ))
      if (!manifest) {
        diagnostics.push({ name: stored.instanceId, code: 'AGENT_CONNECTOR_MANIFEST_NOT_REGISTERED' })
        continue
      }
      const sdkPackage = this.packageStore?.packageForManifest(manifest.manifestId)
      const installed = sdkPackage ? {
        kind: 'meldwork-sdk',
        name: 'Meldwork Connector SDK',
        version: AGENT_CONNECTOR_SDK_VERSION,
        compatibilityState: 'compatible',
        packageId: sdkPackage.packageId,
      } : availableAgents.find(agent => (
        agent?.kind === manifest.upstream.id && semanticVersionFrom(agent.version)
      ))
      const upstream = installed?.compatibilityState === 'incompatible' ? null : installed
      if (!upstream) {
        if (installed) {
          diagnostics.push({ name: stored.instanceId, code: 'AGENT_CONNECTOR_UPSTREAM_INCOMPATIBLE' })
        }
        continue
      }
      try {
        if ((manifest.credentials.mode === 'credential-ref') !== Boolean(stored.credentialRef)) {
          fail('AGENT_CONNECTOR_CREDENTIAL_REF_INVALID')
        }
        if (stored.credentialRef) this.instanceStore.resolveCredential(stored.credentialRef)
        registry.registerInstance({
          instanceId: stored.instanceId,
          connectorId: manifest.connectorId,
          connectorVersion: manifest.connectorVersion,
          upstreamVersion: semanticVersionFrom(upstream.version),
          label: stored.label,
          credentialRef: stored.credentialRef,
        })
        upstreams.set(stored.instanceId, Object.freeze({ ...upstream }))
      } catch (error) {
        diagnostics.push({ name: stored.instanceId, code: safeFailureCode(error) })
      }
    }
    this.detectedUpstreams = availableAgents
    this.registry = registry
    this.upstreams = upstreams
    this.runtime = this.createRuntime(registry)
    this.lastDiagnostics = diagnostics
    return this.detectAgents()
  }

  detectAgents() {
    return this.runtime.detectAgents().map((agent) => {
      const { instance, manifest } = this.registry.resolveInstance(agent.connectorInstanceId)
      return Object.freeze({
        ...agent,
        cloud: [BRIDGE_RECIPE_ID, SSH_RECIPE_ID].includes(manifest.invocation.recipeId),
        credentialConfigured: Boolean(instance.credentialRef),
      })
    }).sort((left, right) => (
      left.label.localeCompare(right.label) || left.kind.localeCompare(right.kind)
    ))
  }

  list() {
    const agents = new Map(this.detectAgents().map(agent => [agent.kind, agent]))
    return this.instanceStore.list().map((instance) => {
      const agent = agents.get(instance.instanceId)
      return Object.freeze({
        ...instance,
        available: Boolean(agent),
        upstreamVersion: agent?.upstreamVersion || '',
      })
    }).sort((left, right) => (
      left.label.localeCompare(right.label) || left.instanceId.localeCompare(right.instanceId)
    ))
  }

  configure(input) {
    if (!exactInput(input, ['credentials', 'label', 'manifestId'])) {
      fail('AGENT_CONNECTOR_CONFIGURATION_INVALID')
    }
    const manifest = this.registry.listManifests().find(item => (
      item.manifestId === String(input.manifestId || '')
    ))
    if (!manifest) fail('AGENT_CONNECTOR_MANIFEST_NOT_REGISTERED')
    const sdkPackage = this.packageStore?.packageForManifest(manifest.manifestId)
    const upstream = sdkPackage ? {
      kind: 'meldwork-sdk', version: AGENT_CONNECTOR_SDK_VERSION,
      compatibilityState: 'compatible', packageId: sdkPackage.packageId,
    } : this.detectedUpstreams.find(agent => (
      agent?.kind === manifest.upstream.id
      && agent.compatibilityState !== 'incompatible'
      && semanticVersionFrom(agent.version)
    ))
    if (!upstream) fail('AGENT_CONNECTOR_UPSTREAM_UNAVAILABLE')
    const created = this.instanceStore.create({
      manifestId: manifest.manifestId,
      connectorId: manifest.connectorId,
      connectorVersion: manifest.connectorVersion,
      label: input.label,
      credentials: credentialValuesFor(manifest, input.credentials),
    })
    this.refresh(this.detectedUpstreams)
    return this.list().find(item => item.instanceId === created.instanceId)
  }

  delete(instanceId) {
    const result = this.instanceStore.delete(String(instanceId || ''))
    this.refresh(this.detectedUpstreams)
    return result
  }

  requirePackageStore() {
    if (!this.packageStore) fail('AGENT_CONNECTOR_PACKAGE_STORE_UNAVAILABLE')
    return this.packageStore
  }

  importPackageFile(filename) {
    const normalized = String(filename || '')
    if (!path.isAbsolute(normalized)) fail('AGENT_CONNECTOR_PACKAGE_ORIGIN_INVALID')
    let descriptor
    try {
      descriptor = fs.openSync(
        normalized,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
      )
      const stat = fs.fstatSync(descriptor)
      if (!stat.isFile() || stat.size > MAX_PACKAGE_BYTES) {
        fail('AGENT_CONNECTOR_PACKAGE_ORIGIN_INVALID')
      }
      return this.requirePackageStore().import(
        fs.readFileSync(descriptor),
        path.basename(normalized),
      )
    } catch (error) {
      if (error?.code?.startsWith('AGENT_CONNECTOR_')) throw error
      fail('AGENT_CONNECTOR_PACKAGE_ORIGIN_INVALID')
    } finally {
      if (descriptor !== undefined) try { fs.closeSync(descriptor) } catch {}
    }
  }

  packages() {
    return this.requirePackageStore().list()
  }

  inspectPackage(packageId) {
    return this.requirePackageStore().inspect(String(packageId || ''))
  }

  auditPackage(packageId) {
    return this.requirePackageStore().audit(String(packageId || ''))
  }

  packageTransition(action, packageId) {
    const store = this.requirePackageStore()
    const normalizedId = String(packageId || '')
    if (action === 'upgrade') {
      const target = store.inspect(normalizedId)
      const replaced = store.list().find(item => (
        item.state === 'installed'
        && item.connectorId === target.manifest.connectorId
        && item.packageId !== normalizedId
      ))
      if (replaced && this.instanceStore.listRecords().some(item => (
        item.manifestId === replaced.manifestId
      ))) fail('AGENT_CONNECTOR_PACKAGE_IN_USE')
    }
    if (action === 'remove') {
      const manifestId = store.inspect(normalizedId).manifest.manifestId
      if (this.instanceStore.listRecords().some(item => item.manifestId === manifestId)) {
        fail('AGENT_CONNECTOR_PACKAGE_IN_USE')
      }
    }
    const result = store[action](normalizedId)
    this.refresh(this.detectedUpstreams)
    return result
  }

  approvePackage(packageId) { return this.packageTransition('approve', packageId) }

  installPackage(packageId) { return this.packageTransition('install', packageId) }

  disablePackage(packageId) { return this.packageTransition('disable', packageId) }

  revokePackage(packageId) { return this.packageTransition('revoke', packageId) }

  upgradePackage(packageId) { return this.packageTransition('upgrade', packageId) }

  removePackage(packageId) { return this.packageTransition('remove', packageId) }

  async test(instanceId, workdir) {
    const agent = this.detectAgents().find(item => item.kind === String(instanceId || ''))
    if (!agent) fail('AGENT_CONNECTOR_INSTANCE_NOT_FOUND')
    const suffix = crypto.randomBytes(8).toString('hex')
    const result = await this.run(agent, 'Meldwork Connector conformance probe', workdir, {
      runId: `connector-test-${suffix}`,
      agentRunId: `connector-agent-test-${suffix}`,
      sandbox: 'read-only',
    })
    return Object.freeze({
      instanceId: agent.kind,
      passed: result.outcome === 'completed',
      outcome: result.outcome,
      failure: result.failure ? Object.freeze({ ...result.failure }) : null,
    })
  }

  catalog() {
    return this.detectAgents().map((agent) => {
      const { manifest } = this.registry.resolveInstance(agent.connectorInstanceId)
      const cloud = [BRIDGE_RECIPE_ID, SSH_RECIPE_ID].includes(manifest.invocation.recipeId)
      const cloudEntry = cloud ? this.cloudBridges?.bridgeForInstance?.(agent.kind) : null
      return Object.freeze({
        kind: agent.kind,
        sourceKind: cloudEntry?.agent?.sourceKind || '',
        label: agent.label,
        name: agent.name,
        description: manifest.description,
        version: cloudEntry?.agent?.version || agent.version,
        installed: true,
        installSupported: false,
        installErrorCode: '',
        imageAttachmentLimit: manifest.inputTypes.includes('image') ? 32 : 0,
        custom: !cloud,
        connector: true,
        cloud,
        credentialState: cloudEntry?.agent?.credentialState || 'unknown',
        serverLabel: cloudEntry?.record?.label || '',
        connectorId: manifest.connectorId,
        connectorVersion: manifest.connectorVersion,
        upstreamVersion: agent.upstreamVersion,
        credentialConfigured: agent.credentialConfigured,
      })
    })
  }

  has(kind) {
    return this.upstreams.has(String(kind || ''))
  }

  label(kind) {
    return this.detectAgents().find(agent => agent.kind === kind)?.label || ''
  }

  attachmentSupport(kind) {
    if (!this.has(kind)) return null
    const snapshot = this.registry.runSnapshot(kind)
    return {
      image: snapshot.capabilities.inputTypes.includes('image') ? 32 : 0,
      audio: snapshot.capabilities.inputTypes.includes('audio') ? 32 : 0,
      video: snapshot.capabilities.inputTypes.includes('video') ? 32 : 0,
      file: snapshot.capabilities.inputTypes.includes('file') ? 32 : 0,
    }
  }

  diagnostics() {
    return this.lastDiagnostics.map(item => Object.freeze({ ...item }))
  }

  run(...args) {
    return this.runtime.run(...args)
  }

  async runDelegated(input) {
    const upstream = this.upstreams.get(input.connector.instanceId)
    if (!upstream) fail('AGENT_CONNECTOR_UPSTREAM_UNAVAILABLE')
    const { manifest } = this.registry.resolveInstance(input.connector.instanceId)
    const credentialValues = input.credentialRefId
      ? this.instanceStore.resolveCredential(input.credentialRefId)
      : null
    const credentialEnv = delegatedCredentialEnvironment(manifest, credentialValues)
    const terminal = {
      eventId: `${input.agentRunId}:terminal`,
      cursor: `${input.agentRunId}:terminal`,
      sequence: 1,
    }
    try {
      const result = await this.runAgent(upstream, input.prompt, input.workdir, {
        signal: input.signal,
        sessionRef: input.sessionRef,
        sandbox: input.permissionMode,
        attachments: input.attachments,
        onActivity: input.onActivity,
        onProgress: input.onProgress,
        onEvent: input.onRuntimeEvent,
        onOutboundPayload: input.onOutboundPayload,
        onPermissionRequest: input.onPermissionRequest,
        operationId: input.operationId,
        idempotencyKey: input.idempotencyKey,
        connectorResume: input.resume,
        ...(input.credentialRefId ? { connectorCredentialIsolation: true } : {}),
        ...(Object.keys(credentialEnv).length ? { env: credentialEnv } : {}),
      })
      const outcome = String(result?.outcome || 'completed')
      if (outcome === 'completed' || outcome === 'partial') {
        input.emit({ ...terminal, type: 'Completed', outcome })
      } else if (outcome === 'waiting_input') {
        const waiting = result?.waitingRequest || result?.waitingInput
        input.emit({
          ...terminal,
          type: 'WaitingInput',
          requestId: waiting?.requestId,
          prompt: waiting?.prompt,
        })
      } else if (outcome === 'waiting_permission') {
        const waiting = result?.waitingRequest || result?.waitingPermission
        input.emit({
          ...terminal,
          type: 'Permission',
          requestId: waiting?.requestId,
          permission: waiting?.permission,
          decision: 'requested',
          ...(waiting?.summary ? { summary: waiting.summary } : {}),
        })
      } else if (outcome === 'cancelled') {
        input.emit({ ...terminal, type: 'Cancelled', reason: 'other' })
      } else if (outcome === 'failed') {
        const failure = failureDetails(result?.failure || result)
        input.emit({
          ...terminal,
          type: 'Failed',
          ...failure,
        })
      } else {
        input.emit({
          ...terminal,
          type: 'Failed',
          code: 'LOCAL_AGENT_OUTCOME_INVALID',
          category: 'protocol',
          retryable: false,
        })
      }
      return result || {}
    } catch (error) {
      const failure = failureDetails(error)
      input.emit({
        ...terminal,
        type: 'Failed',
        ...failure,
      })
      return { outcome: 'failed', failure }
    }
  }

  async runLocalEcho(input) {
    const terminal = {
      eventId: `${input.agentRunId}:terminal`,
      cursor: `${input.agentRunId}:terminal`,
      sequence: 1,
    }
    if (input.signal?.aborted) {
      input.emit({ ...terminal, type: 'Cancelled', reason: 'user' })
      return { outcome: 'cancelled', sessionRef: input.sessionRef || '' }
    }
    const text = input.resume?.type === 'input' ? input.resume.response : input.prompt
    input.emit({ ...terminal, type: 'Completed', outcome: 'completed' })
    return { text, outcome: 'completed', sessionRef: input.sessionRef || 'local-echo-session' }
  }

  async runHttpJson(input) {
    const packageRecord = this.packageStore?.packageForManifest(input.connector.manifestId)
    if (!packageRecord || packageRecord.provider.id !== SDK_HTTP_JSON_RECIPE_ID) {
      fail('AGENT_CONNECTOR_PACKAGE_NOT_INSTALLED')
    }
    const endpoint = packageRecord.provider.config.endpoint
    const terminal = {
      eventId: `${input.agentRunId}:terminal`,
      cursor: `${input.agentRunId}:terminal`,
      sequence: 1,
    }
    try {
      input.onOutboundPayload({ destination: endpoint, transport: 'http' })
      const headers = { 'content-type': 'application/json' }
      const authSlotId = packageRecord.provider.config.authSlotId
      if (authSlotId) {
        const credentials = this.instanceStore.resolveCredential(input.credentialRefId)
        headers.authorization = `Bearer ${credentials[authSlotId]}`
      }
      const response = await this.fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers,
        signal: input.signal,
        body: JSON.stringify({
          prompt: input.prompt,
          sessionRef: input.sessionRef || null,
          resume: input.resume,
          permissionMode: input.permissionMode,
          operationId: input.operationId,
        }),
      })
      if (!response?.ok) throw Object.assign(new Error('AGENT_CONNECTOR_HTTP_FAILED'), {
        code: 'AGENT_CONNECTOR_HTTP_FAILED', retryable: response?.status >= 500,
      })
      const text = await response.text()
      if (typeof text !== 'string' || Buffer.byteLength(text) > 4 * 1024 * 1024) {
        fail('AGENT_CONNECTOR_HTTP_RESPONSE_INVALID')
      }
      let parsed
      try { parsed = JSON.parse(text) } catch { fail('AGENT_CONNECTOR_HTTP_RESPONSE_INVALID') }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
          || typeof parsed.text !== 'string' || parsed.text.includes('\u0000')
          || (parsed.sessionRef !== undefined
            && (typeof parsed.sessionRef !== 'string' || parsed.sessionRef.length > 8192
              || /[\u0000-\u001f\u007f]/.test(parsed.sessionRef)))) {
        fail('AGENT_CONNECTOR_HTTP_RESPONSE_INVALID')
      }
      input.emit({ ...terminal, type: 'Completed', outcome: 'completed' })
      return { text: parsed.text, sessionRef: parsed.sessionRef || '', outcome: 'completed' }
    } catch (error) {
      if (input.signal?.aborted || error?.name === 'AbortError') {
        input.emit({ ...terminal, type: 'Cancelled', reason: 'user' })
        return { outcome: 'cancelled', sessionRef: input.sessionRef || '' }
      }
      const failure = failureDetails(error)
      input.emit({ ...terminal, type: 'Failed', ...failure })
      return { outcome: 'failed', failure }
    }
  }

  async runCloudBridge(input) {
    const entry = this.cloudBridges?.bridgeForInstance?.(input.connector.instanceId)
    if (!entry) fail('CLOUD_AGENT_BRIDGE_NOT_FOUND')
    const terminal = {
      eventId: `${input.agentRunId}:terminal`,
      cursor: `${input.agentRunId}:terminal`,
      sequence: 1,
    }
    try {
      if (!['ssh', 'ssh-tunnel'].includes(entry.record.transport)) {
        input.onOutboundPayload({ destination: entry.record.address, transport: 'http' })
      }
      const result = await this.cloudBridges.run({
        bridgeId: entry.record.bridgeId,
        agentId: entry.agent.id,
        prompt: input.prompt,
        sessionRef: input.sessionRef,
        // Cloud bridge tasks never receive local workspace write authority.
        permissionMode: 'read-only',
        operationId: input.operationId,
        resume: input.resume,
        signal: input.signal,
        onActivity: input.onActivity,
      })
      if (!result || typeof result !== 'object' || Array.isArray(result)
          || typeof result.text !== 'string' || result.text.includes('\u0000')
          || (result.sessionRef !== undefined
            && (typeof result.sessionRef !== 'string' || result.sessionRef.length > 8192
              || /[\u0000-\u001f\u007f]/.test(result.sessionRef)))
          || !['completed', 'partial', 'failed', 'cancelled'].includes(result.outcome || 'completed')) {
        fail('CLOUD_AGENT_BRIDGE_RESPONSE_INVALID')
      }
      if (result.outcome === 'failed') {
        const failure = failureDetails(result.failure || result)
        input.emit({ ...terminal, type: 'Failed', ...failure })
        return { outcome: 'failed', failure }
      }
      if (result.outcome === 'cancelled') {
        input.emit({ ...terminal, type: 'Cancelled', reason: 'user' })
        return { outcome: 'cancelled', sessionRef: result.sessionRef || input.sessionRef || '' }
      }
      input.emit({ ...terminal, type: 'Completed', outcome: result.outcome || 'completed' })
      return {
        text: result.text,
        sessionRef: typeof result.sessionRef === 'string' ? result.sessionRef : input.sessionRef || '',
        outcome: result.outcome || 'completed',
      }
    } catch (error) {
      if (input.signal?.aborted || error?.name === 'AbortError') {
        input.emit({ ...terminal, type: 'Cancelled', reason: 'user' })
        return { outcome: 'cancelled', sessionRef: input.sessionRef || '' }
      }
      const failure = failureDetails(error)
      input.emit({ ...terminal, type: 'Failed', ...failure })
      return { outcome: 'failed', failure }
    }
  }
}

module.exports = {
  LOCAL_DELEGATE_RECIPE_ID,
  LocalAgentConnectors,
  SAMPLE_AGENT_CONNECTOR_MANIFEST,
  SAMPLE_CREDENTIAL_AGENT_CONNECTOR_MANIFEST,
  SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_MANIFEST,
  SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE,
  semanticVersionFrom,
}

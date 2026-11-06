const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { ContentBlobStore } = require('../attachments/content-blob-store.cjs')
const {
  parseKnowledgeCitationRecord,
  parseKnowledgeSnapshotRecord,
} = require('./knowledge-connector-contract.cjs')
const {
  DEFAULT_FILESYSTEM_CONNECTOR_ID,
  FilesystemKnowledgeConnector,
} = require('./knowledge-connector-filesystem.cjs')
const {
  DEFAULT_MEMORY_CONNECTOR_ID,
  MemoryKnowledgeConnector,
} = require('./knowledge-connector-memory.cjs')
const { KnowledgeConnectorRegistry } = require('./knowledge-connector-registry.cjs')
const { redactSecrets } = require('../security/secret-redaction.cjs')
const { atomicWritePrivateFile } = require('../security/private-file.cjs')

const OBSIDIAN_KIND = 'obsidian'
const MEMORY_KIND = 'memory'
const SELECTION_ID = /^knowledge-selection-[a-f0-9]{64}$/
const SNAPSHOT_ID = /^knowledge-snapshot-[a-f0-9]{64}$/
const CITATION_ID = /^knowledge-citation-[a-f0-9]{64}$/
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const MAX_SELECTIONS = 128
const DEFAULT_MEMORY_DOCUMENTS = Object.freeze([Object.freeze({
  locator: 'meldwork/connector-runtime.md',
  title: 'Meldwork Connector Runtime',
  mediaType: 'text/markdown',
  content: 'Meldwork runs local Agent and Knowledge Connectors in the Electron main process.',
})])

function connectorError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function fail(code) {
  throw connectorError(code)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value, expected) {
  return isPlainObject(value)
    && Object.keys(value).sort().join(',') === [...expected].sort().join(',')
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.values(value).forEach(deepFreeze)
  return Object.freeze(value)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function pathIdentity(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function publicText(value, vaultPath = '') {
  let text = redactSecrets(String(value || ''))
    .replace(/\bcredential-ref:[A-Za-z0-9][A-Za-z0-9._:-]{0,199}\b/gi, 'credential-ref:[redacted]')
  if (vaultPath) text = text.split(vaultPath).join('[redacted path]')
  return text
}

function publicSearchResult(source, vaultPath) {
  return deepFreeze({
    sourceId: source.sourceId,
    connectorId: source.connectorId,
    scopeId: source.scopeId,
    locator: source.locator,
    title: publicText(source.title, vaultPath),
    mediaType: source.mediaType,
    contentHash: source.contentHash,
    size: source.size,
    snippet: publicText(source.snippet, vaultPath),
  })
}

function publicSnapshot(snapshot) {
  return deepFreeze({
    snapshotId: snapshot.snapshotId,
    connectorId: snapshot.connectorId,
    instanceId: snapshot.instanceId,
    sourceId: snapshot.sourceId,
    title: snapshot.title,
    mediaType: snapshot.mediaType,
    contentHash: snapshot.contentHash,
    size: snapshot.contentRef.size,
  })
}

function publicCitation(result, vaultPath) {
  return deepFreeze({
    citation: {
      citationId: result.citation.citationId,
      connectorId: result.citation.connectorId,
      instanceId: result.citation.instanceId,
      sourceId: result.citation.sourceId,
      contentHash: result.citation.contentHash,
      snapshotId: result.citation.snapshotId,
      verification: result.citation.verification,
    },
    content: publicText(result.content, vaultPath),
  })
}

function authorizeLocalInstance(registry, connectorId, input) {
  if (input.credentialLifecycle !== 'none' || input.credentialRef !== null) {
    fail('LOCAL_KNOWLEDGE_AUTO_AUTHORIZATION_FORBIDDEN')
  }
  return registry.authorize(connectorId, input)
}

class LocalKnowledgeConnectors {
  constructor(options = {}) {
    if (!isPlainObject(options)
        || Object.keys(options).some(key => ![
          'contentBlobStore', 'getObsidianVaultPath', 'memoryDocuments', 'storagePath',
        ].includes(key))
        || !(options.contentBlobStore instanceof ContentBlobStore)
        || typeof options.getObsidianVaultPath !== 'function'
        || (options.memoryDocuments !== undefined && !Array.isArray(options.memoryDocuments))) {
      fail('LOCAL_KNOWLEDGE_CONNECTORS_OPTIONS_INVALID')
    }
    this.contentBlobStore = options.contentBlobStore
    this.getObsidianVaultPath = options.getObsidianVaultPath
    this.memoryDocuments = options.memoryDocuments || DEFAULT_MEMORY_DOCUMENTS
    this.storagePath = options.storagePath || path.join(
      path.dirname(this.contentBlobStore.rootPath),
      'knowledge-connector-records.json',
    )
    if (typeof this.storagePath !== 'string' || !path.isAbsolute(this.storagePath)
        || this.storagePath === path.parse(this.storagePath).root) {
      fail('LOCAL_KNOWLEDGE_CONNECTORS_OPTIONS_INVALID')
    }
    this.registry = null
    this.configuredPath = null
    this.authorizationInputs = new Map()
    this.instanceIds = new Map()
    this.sourceGrants = new Map()
    this.selections = new Map()
    this.snapshots = new Map()
    this.citations = new Map()
    this.revokedConnectorIds = new Set()
    this.loadRecords()
  }

  async refresh(force = false) {
    const requested = String(this.getObsidianVaultPath() || '').trim()
    const vaultPath = requested && path.isAbsolute(requested) ? path.normalize(requested) : ''
    if (!force && this.registry && vaultPath === this.configuredPath) return this.listCurrent()

    const registry = new KnowledgeConnectorRegistry()
    const authorizationInputs = new Map()
    const instanceIds = new Map()
    const memoryInstance = {
      instanceId: 'memory-local-runtime',
      connectorId: DEFAULT_MEMORY_CONNECTOR_ID,
      accountId: 'local-user',
      label: 'Meldwork Local Memory',
      scope: { scopeId: 'memory-local-runtime', kind: 'memory' },
      accessMode: 'read-only',
      snapshotCapability: 'immutable',
      egressLimit: { maxResults: 20, maxContentBytes: 1024 * 1024 },
      credentialLifecycle: 'none',
      credentialRef: null,
    }
    registry.register(new MemoryKnowledgeConnector({
      connectorId: DEFAULT_MEMORY_CONNECTOR_ID,
      contentBlobStore: this.contentBlobStore,
      documents: this.memoryDocuments,
      scopeId: memoryInstance.scope.scopeId,
    }))
    authorizationInputs.set(DEFAULT_MEMORY_CONNECTOR_ID, memoryInstance)
    instanceIds.set(memoryInstance.instanceId, MEMORY_KIND)
    if (!this.revokedConnectorIds.has(DEFAULT_MEMORY_CONNECTOR_ID)) {
      await authorizeLocalInstance(registry, DEFAULT_MEMORY_CONNECTOR_ID, memoryInstance)
    }
    if (vaultPath) {
      const identity = pathIdentity(vaultPath)
      const scopeId = `obsidian-vault-${identity.slice(0, 32)}`
      const instanceId = `obsidian-vault-${identity.slice(0, 24)}`
      const connector = new FilesystemKnowledgeConnector({
        connectorId: DEFAULT_FILESYSTEM_CONNECTOR_ID,
        contentBlobStore: this.contentBlobStore,
        rootPath: vaultPath,
        scopeId,
      })
      registry.register(connector)
      const filesystemInstance = {
        instanceId,
        connectorId: DEFAULT_FILESYSTEM_CONNECTOR_ID,
        accountId: 'local-user',
        label: 'Obsidian Vault',
        scope: { scopeId, kind: 'filesystem' },
        accessMode: 'read-only',
        snapshotCapability: 'immutable',
        egressLimit: { maxResults: 20, maxContentBytes: 1024 * 1024 },
        credentialLifecycle: 'none',
        credentialRef: null,
      }
      authorizationInputs.set(DEFAULT_FILESYSTEM_CONNECTOR_ID, filesystemInstance)
      instanceIds.set(instanceId, OBSIDIAN_KIND)
      if (!this.revokedConnectorIds.has(DEFAULT_FILESYSTEM_CONNECTOR_ID)) {
        await authorizeLocalInstance(registry, DEFAULT_FILESYSTEM_CONNECTOR_ID, filesystemInstance)
      }
    }
    this.registry = registry
    this.configuredPath = vaultPath
    this.authorizationInputs = authorizationInputs
    this.instanceIds = instanceIds
    this.sourceGrants.clear()
    this.selections.clear()
    return this.listCurrent()
  }

  async authorize(connectorId) {
    await this.refresh()
    if (typeof connectorId !== 'string' || !PUBLIC_ID.test(connectorId)) {
      fail('LOCAL_KNOWLEDGE_CONNECTOR_ID_INVALID')
    }
    const input = this.authorizationInputs.get(connectorId)
    if (!input) fail('LOCAL_KNOWLEDGE_CONNECTOR_NOT_AVAILABLE')
    const existing = this.registry.listInstances().find(instance => (
      instance.connectorId === connectorId
    ))
    if (existing) return existing
    const authorized = await this.registry.authorize(connectorId, input)
    this.revokedConnectorIds.delete(connectorId)
    try {
      this.saveRecords()
    } catch (error) {
      this.revokedConnectorIds.add(connectorId)
      try { await this.registry.revoke(authorized.instanceId) } catch { this.registry = null }
      throw error
    }
    return authorized
  }

  async list() {
    await this.refresh()
    return this.listCurrent()
  }

  async probe(instanceId) {
    await this.refresh()
    this.requireInstanceId(instanceId)
    return this.registry.probe(instanceId)
  }

  async search(instanceId, input) {
    await this.refresh()
    this.requireInstanceId(instanceId)
    if (!exactKeys(input, ['query', 'limit'])) {
      fail('LOCAL_KNOWLEDGE_SEARCH_INVALID')
    }
    const results = await this.registry.search(instanceId, input)
    for (const source of results) {
      if (this.sourceGrants.size >= MAX_SELECTIONS) {
        this.sourceGrants.delete(this.sourceGrants.keys().next().value)
      }
      this.sourceGrants.set(`${instanceId}:${source.sourceId}`, deepFreeze(clone(source)))
    }
    return deepFreeze(results.map(source => publicSearchResult(source, this.configuredPath)))
  }

  async fetch(instanceId, input) {
    await this.refresh()
    this.requireInstanceId(instanceId)
    const request = this.grantedSourceRequest(instanceId, input)
    const fetched = await this.registry.fetch(instanceId, request)
    return deepFreeze({
      source: publicSearchResult(fetched.source, this.configuredPath),
      content: publicText(fetched.content, this.configuredPath),
    })
  }

  async snapshot(instanceId, input) {
    await this.refresh()
    this.requireInstanceId(instanceId)
    const request = this.grantedSourceRequest(instanceId, input)
    const snapshot = await this.registry.snapshot(instanceId, request)
    if (this.snapshots.size >= MAX_SELECTIONS) {
      this.snapshots.delete(this.snapshots.keys().next().value)
    }
    this.snapshots.set(snapshot.snapshotId, deepFreeze(clone(snapshot)))
    this.saveRecords()
    return publicSnapshot(snapshot)
  }

  async citation(instanceId, input) {
    await this.refresh()
    this.requireInstanceId(instanceId)
    if (!isPlainObject(input)) fail('LOCAL_KNOWLEDGE_CITATION_INVALID')
    const keys = Object.keys(input).sort().join(',')
    let result
    if (keys === 'snapshotId' && SNAPSHOT_ID.test(String(input.snapshotId || ''))) {
      const snapshot = this.snapshots.get(input.snapshotId)
      if (!snapshot || snapshot.instanceId !== instanceId) {
        fail('LOCAL_KNOWLEDGE_SNAPSHOT_NOT_FOUND')
      }
      result = await this.registry.citation(instanceId, { snapshot })
    } else if (keys === 'contentHash,locator,sourceId'
        && /^[a-f0-9]{64}$/.test(String(input.contentHash || ''))) {
      const request = this.grantedSourceRequest(instanceId, {
        sourceId: input.sourceId,
        locator: input.locator,
      })
      result = await this.registry.citation(instanceId, {
        ...request,
        contentHash: input.contentHash,
      })
    } else if (keys === 'citationId' && CITATION_ID.test(String(input.citationId || ''))) {
      const stored = this.citations.get(input.citationId)
      if (!stored || stored.citation.instanceId !== instanceId) {
        fail('LOCAL_KNOWLEDGE_CITATION_NOT_FOUND')
      }
      if (stored.citation.verification === 'snapshot') {
        const snapshot = this.snapshots.get(stored.citation.snapshotId)
        if (!snapshot) fail('LOCAL_KNOWLEDGE_SNAPSHOT_NOT_FOUND')
        result = await this.registry.citation(instanceId, { snapshot })
      } else {
        result = await this.registry.citation(instanceId, {
          sourceId: stored.citation.sourceId,
          locator: stored.citation.locator,
          contentHash: stored.citation.contentHash,
        })
      }
    } else {
      fail('LOCAL_KNOWLEDGE_CITATION_INVALID')
    }
    if (this.citations.size >= MAX_SELECTIONS) {
      this.citations.delete(this.citations.keys().next().value)
    }
    this.citations.set(result.citation.citationId, deepFreeze(clone(result)))
    this.saveRecords()
    return publicCitation(result, this.configuredPath)
  }

  async select(instanceId, input) {
    await this.refresh()
    this.requireInstanceId(instanceId)
    if (!exactKeys(input, ['captureMode', 'locator', 'sourceId'])
        || !['snapshot', 'live-reference'].includes(input.captureMode)) {
      fail('LOCAL_KNOWLEDGE_SELECTION_INVALID')
    }
    const request = this.grantedSourceRequest(instanceId, {
      sourceId: input.sourceId,
      locator: input.locator,
    })
    const fetched = await this.registry.fetch(instanceId, request)
    const selectionId = `knowledge-selection-${crypto.randomBytes(32).toString('hex')}`
    if (this.selections.size >= MAX_SELECTIONS) {
      this.selections.delete(this.selections.keys().next().value)
    }
    this.selections.set(selectionId, deepFreeze({
      selectionId,
      instanceId,
      sourceId: fetched.source.sourceId,
      locator: fetched.source.locator,
      captureMode: input.captureMode,
      kind: this.instanceIds.get(instanceId),
    }))
    return deepFreeze({
      selectionId,
      kind: this.instanceIds.get(instanceId),
      instanceId,
      sourceId: fetched.source.sourceId,
      title: publicText(fetched.source.title, this.configuredPath),
      mediaType: fetched.source.mediaType,
      contentHash: fetched.source.contentHash,
      size: fetched.source.size,
      captureMode: input.captureMode,
    })
  }

  async prepareSelection(selectionId) {
    await this.refresh()
    if (typeof selectionId !== 'string' || !SELECTION_ID.test(selectionId)) {
      fail('LOCAL_KNOWLEDGE_SELECTION_INVALID')
    }
    const selection = this.selections.get(selectionId)
    if (!selection) fail('LOCAL_KNOWLEDGE_SELECTION_NOT_FOUND')
    this.requireInstanceId(selection.instanceId)
    const request = { sourceId: selection.sourceId, locator: selection.locator }
    const fetched = await this.registry.fetch(selection.instanceId, request)
    const snapshot = await this.registry.snapshot(selection.instanceId, request)
    if (snapshot.contentHash !== fetched.source.contentHash
        || snapshot.contentRef.hash !== fetched.source.contentHash) {
      fail('LOCAL_KNOWLEDGE_SELECTION_SOURCE_CHANGED')
    }
    const citationResult = selection.captureMode === 'live-reference'
      ? await this.registry.citation(selection.instanceId, {
          ...request,
          contentHash: snapshot.contentHash,
        })
      : await this.registry.citation(selection.instanceId, { snapshot })
    return deepFreeze({
      version: 1,
      kind: selection.kind,
      selectionId,
      sourceId: snapshot.sourceId,
      title: snapshot.title,
      mediaType: snapshot.mediaType,
      captureMode: selection.captureMode,
      snapshot,
      citation: citationResult.citation,
    })
  }

  async verifyCitation(input) {
    await this.refresh()
    if (!exactKeys(input, ['citation', 'snapshot'])) {
      fail('LOCAL_KNOWLEDGE_CITATION_INVALID')
    }
    const citation = parseKnowledgeCitationRecord(input.citation)
    const snapshot = parseKnowledgeSnapshotRecord(input.snapshot)
    this.requireInstanceId(citation.instanceId)
    if (snapshot.instanceId !== citation.instanceId
        || snapshot.sourceId !== citation.sourceId
        || snapshot.contentHash !== citation.contentHash) {
      fail('LOCAL_KNOWLEDGE_CITATION_INVALID')
    }
    return citation.verification === 'snapshot'
      ? this.registry.citation(citation.instanceId, { snapshot })
      : this.registry.citation(citation.instanceId, {
          sourceId: citation.sourceId,
          locator: citation.locator,
          contentHash: citation.contentHash,
        })
  }

  async revoke(instanceId) {
    await this.refresh()
    this.requireInstanceId(instanceId)
    const revoked = await this.registry.revoke(instanceId)
    this.revokedConnectorIds.add(revoked.connectorId)
    this.sourceGrants = new Map([...this.sourceGrants].filter(([key]) => (
      !key.startsWith(`${instanceId}:`)
    )))
    this.selections = new Map([...this.selections].filter(([, selection]) => (
      selection.instanceId !== instanceId
    )))
    this.snapshots = new Map([...this.snapshots].filter(([, snapshot]) => (
      snapshot.instanceId !== instanceId
    )))
    this.citations = new Map([...this.citations].filter(([, result]) => (
      result.citation.instanceId !== instanceId
    )))
    this.saveRecords()
    return revoked
  }

  runtimeHint(targetKinds, preparedSource) {
    if (![OBSIDIAN_KIND, MEMORY_KIND].includes(preparedSource?.kind)
        || (preparedSource?.kind === OBSIDIAN_KIND && !this.configuredPath)
        || !Array.isArray(targetKinds) || !targetKinds.length) {
      fail('LOCAL_KNOWLEDGE_SELECTION_INVALID')
    }
    return {
      kind: preparedSource.kind,
      name: preparedSource.kind === OBSIDIAN_KIND ? 'Obsidian' : 'Memory',
      accessMode: preparedSource.kind === OBSIDIAN_KIND ? 'vault' : 'snapshot',
      targetKinds: [...targetKinds],
      ...(preparedSource.kind === OBSIDIAN_KIND ? { location: this.configuredPath } : {}),
      connectorSource: preparedSource,
    }
  }

  listCurrent() {
    if (!this.registry) return deepFreeze([])
    return deepFreeze(this.registry.listInstances().map(instance => clone(instance)))
  }

  requireInstanceId(instanceId) {
    if (typeof instanceId !== 'string' || !PUBLIC_ID.test(instanceId)
        || !this.instanceIds.has(instanceId)
        || !this.registry?.listInstances().some(instance => instance.instanceId === instanceId)) {
      fail('LOCAL_KNOWLEDGE_CONNECTOR_INSTANCE_INVALID')
    }
    return instanceId
  }

  grantedSourceRequest(instanceId, input) {
    if (!exactKeys(input, ['locator', 'sourceId'])) {
      fail('LOCAL_KNOWLEDGE_SOURCE_REQUEST_INVALID')
    }
    const source = this.sourceGrants.get(`${instanceId}:${String(input.sourceId || '')}`)
    if (!source || source.locator !== input.locator) {
      fail('LOCAL_KNOWLEDGE_SOURCE_NOT_GRANTED')
    }
    return { sourceId: source.sourceId, locator: source.locator }
  }

  loadRecords() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.storagePath, 'utf8'))
      if (!exactKeys(parsed, ['citations', 'revokedConnectorIds', 'snapshots', 'version'])
          || parsed.version !== 1 || !Array.isArray(parsed.snapshots)
          || !Array.isArray(parsed.citations) || !Array.isArray(parsed.revokedConnectorIds)
          || parsed.snapshots.length > MAX_SELECTIONS || parsed.citations.length > MAX_SELECTIONS
          || parsed.revokedConnectorIds.length > 64) return
      const snapshots = new Map()
      for (const input of parsed.snapshots) {
        const snapshot = parseKnowledgeSnapshotRecord(input)
        if (!this.contentBlobStore.has(snapshot.contentRef)) return
        snapshots.set(snapshot.snapshotId, deepFreeze(clone(snapshot)))
      }
      const citations = new Map()
      for (const input of parsed.citations) {
        const citation = parseKnowledgeCitationRecord(input)
        if (citation.verification === 'snapshot'
            && !snapshots.has(citation.snapshotId)) return
        citations.set(citation.citationId, deepFreeze({ citation: clone(citation) }))
      }
      const revokedConnectorIds = new Set(parsed.revokedConnectorIds)
      if (revokedConnectorIds.size !== parsed.revokedConnectorIds.length
          || [...revokedConnectorIds].some(id => !PUBLIC_ID.test(String(id || '')))) return
      this.snapshots = snapshots
      this.citations = citations
      this.revokedConnectorIds = revokedConnectorIds
    } catch { /* Missing or malformed private state fails closed to no durable grants. */ }
  }

  saveRecords() {
    atomicWritePrivateFile(this.storagePath, `${JSON.stringify({
      version: 1,
      revokedConnectorIds: [...this.revokedConnectorIds].sort(),
      snapshots: [...this.snapshots.values()],
      citations: [...this.citations.values()].map(result => result.citation),
    }, null, 2)}\n`)
  }
}

module.exports = {
  DEFAULT_MEMORY_DOCUMENTS,
  LocalKnowledgeConnectors,
  MEMORY_KIND,
  OBSIDIAN_KIND,
  SELECTION_ID,
  authorizeLocalInstance,
}

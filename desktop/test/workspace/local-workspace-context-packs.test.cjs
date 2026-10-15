const test = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { LocalKnowledgeConnectors } = require('../../src/knowledge/local-knowledge-connectors.cjs')
const {
  canonicalJson,
} = require('../../src/collaboration/context-pack-records.cjs')
const {
  createAcpOutboundPayload,
  createLegacyOutboundPayload,
} = require('../../src/collaboration/outbound-payload.cjs')
const { RunLedger } = require('../../src/runs/run-ledger.cjs')
const { fixture } = require('../support/local-workspace-test-helpers.cjs')
const { packedPromptContext } = require('../../src/workspace/local-workspace-context.cjs')

function jsonBlob(workspace, ref) {
  return JSON.parse(workspace.contentBlobStore.read(ref).toString('utf8'))
}

function deliveryForMessage(workspace, message, index = 0) {
  const deliveryId = message.trace.context.deliveryRecordIds[index]
  return workspace.contextPackStore.getDelivery(deliveryId)
}

function outboundPayload(prompt, transport = 'legacy') {
  if (transport === 'acp') {
    const frame = {
      jsonrpc: '2.0',
      id: 4,
      method: 'session/prompt',
      params: {
        sessionId: 'mock-acp-session',
        prompt: [{ type: 'text', text: prompt }],
      },
    }
    return createAcpOutboundPayload({
      prompt,
      wireBytes: Buffer.from(`${JSON.stringify(frame)}\n`, 'utf8'),
    })
  }
  if (transport === 'codex') {
    return createLegacyOutboundPayload({
      prompt,
      command: '/private/bin/codex',
      args: [
        'exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only',
        '-C', '/private/workspace', '-',
      ],
      cwd: '/private/workspace',
      stdin: prompt,
      promptMode: 'stdin',
    })
  }
  return createLegacyOutboundPayload({
    prompt,
    command: '/private/bin/mock-agent',
    args: ['--prompt', prompt],
    cwd: '/private/workspace',
    stdin: prompt,
    promptMode: 'stdin',
  })
}

test('persistent group context watermark excludes already delivered peer turns', () => {
  const state = {
    groups: [{ id: 'group-watermark', conversationType: 'group' }],
    messages: [
      { id: 'user-1', groupId: 'group-watermark', role: 'user', content: 'Initial task' },
      { id: 'agent-a-1', groupId: 'group-watermark', role: 'agent', agentKind: 'codex', content: 'First answer' },
      { id: 'agent-b-1', groupId: 'group-watermark', role: 'agent', agentKind: 'hermes', content: 'Peer answer' },
      { id: 'user-2', groupId: 'group-watermark', role: 'user', content: 'Follow-up task' },
      { id: 'agent-a-2', groupId: 'group-watermark', role: 'agent', agentKind: 'codex', content: 'Latest answer' },
    ],
  }
  const packed = packedPromptContext({
    state,
    groupId: 'group-watermark',
    afterAgentKind: '',
    afterMessageId: 'agent-b-1',
  })
  assert.equal(packed.latestMessageId, 'agent-a-2')
  assert.equal(packed.recentText.includes('First answer'), false)
  assert.equal(packed.recentText.includes('Peer answer'), false)
  assert.equal(packed.recentText.includes('Latest answer'), true)
})

test('explicit Connector selections persist immutable knowledge and citation sources without Vault paths', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runLedger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  const vaultPath = path.join(directory, 'Private Obsidian Vault')
  const notePath = path.join(vaultPath, 'notes', 'source.md')
  fs.mkdirSync(path.dirname(notePath), { recursive: true })
  fs.writeFileSync(notePath, 'Approved immutable Connector evidence')
  let connectors
  options.validateKnowledgeBaseSelections = async (_targetKinds, selections) => Promise.all(
    selections.map(async (selection) => connectors.runtimeHint(
      selection.targetKinds,
      await connectors.prepareSelection(selection.selectionId),
    )),
  )
  options.runAgent = async (_agent, prompt, _workdir, runOptions) => {
    await runOptions.onOutboundPayload(outboundPayload(prompt))
    return { text: 'Connector result', outcome: 'completed' }
  }
  const workspace = new LocalWorkspace(options)
  connectors = new LocalKnowledgeConnectors({
    contentBlobStore: workspace.contentBlobStore,
    getObsidianVaultPath: () => vaultPath,
  })
  await workspace.refreshAgents()
  const instance = (await connectors.list()).find(item => item.connectorId === 'knowledge.filesystem')
  assert.ok(instance)
  const [source] = await connectors.search(instance.instanceId, {
    query: 'immutable', limit: 5,
  })
  const selected = await connectors.select(instance.instanceId, {
    sourceId: source.sourceId,
    locator: source.locator,
    captureMode: 'snapshot',
  })
  const group = workspace.createGroup({
    name: 'Connector context', agentKinds: ['codex'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Use the selected source',
    targetKinds: ['codex'],
    knowledgeBaseHints: [{
      kind: 'obsidian', targetKinds: ['codex'], selectionId: selected.selectionId,
    }],
  })

  const task = workspace.snapshot().messages.find(message => message.role === 'user')
  const result = workspace.snapshot().messages.find(message => message.role === 'agent')
  const run = options.runLedger.list(group.id)[0]
  const basePack = workspace.contextPackStore.get(run.contextPackId)
  const attemptPack = workspace.contextPackStore.get(result.trace.context.contextPackId)
  const preview = jsonBlob(workspace, basePack.approvedPreviewRef)
  const baseKnowledge = basePack.sources.filter(item => item.type === 'knowledge')
  const snapshotSource = baseKnowledge.find(item => item.sourceId === selected.sourceId)
  const citationSource = baseKnowledge.find(item => item.sourceId !== selected.sourceId)
  const metadata = jsonBlob(workspace, citationSource.contentRef)

  assert.equal(baseKnowledge.length, 2)
  assert.equal(snapshotSource.captureMode, 'snapshot')
  assert.equal(metadata.snapshot.contentRef.hash, snapshotSource.contentHash)
  assert.equal(metadata.snapshot.sourceId, snapshotSource.sourceId)
  assert.equal(metadata.citation.verification, 'snapshot')
  assert.equal(metadata.citation.snapshotId, metadata.snapshot.snapshotId)
  assert.deepEqual(
    attemptPack.sources.find(item => item.sourceId === snapshotSource.sourceId).contentRef,
    snapshotSource.contentRef,
  )
  const persisted = JSON.stringify({ basePack, attemptPack, preview, metadata })
  assert.doesNotMatch(persisted, new RegExp(vaultPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(persisted, /credentialRef|apiKey|accessToken/i)
  assert.doesNotMatch(JSON.stringify(task), new RegExp(vaultPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.equal(Object.hasOwn(task, 'knowledgeBaseHints'), false)
  assert.equal(Object.hasOwn(preview.knowledgeBaseHints[0], 'location'), false)
  assert.equal(preview.knowledgeBaseHints[0].selectedSource.sourceId, selected.sourceId)

  fs.writeFileSync(notePath, 'Mutated live Vault content')
  assert.equal(
    workspace.contentBlobStore.read(snapshotSource.contentRef).toString('utf8'),
    'Approved immutable Connector evidence',
  )
  const [liveSource] = await connectors.search(instance.instanceId, {
    query: 'Mutated', limit: 5,
  })
  const liveSelection = await connectors.select(instance.instanceId, {
    sourceId: liveSource.sourceId,
    locator: liveSource.locator,
    captureMode: 'live-reference',
  })
  fs.writeFileSync(notePath, 'Latest live-reference Vault content')
  await workspace.sendMessage({
    groupId: group.id,
    text: 'Use the live selected source',
    targetKinds: ['codex'],
    knowledgeBaseHints: [{
      kind: 'obsidian', targetKinds: ['codex'], selectionId: liveSelection.selectionId,
    }],
  })
  const liveTask = workspace.snapshot().messages.find(message => (
    message.role === 'user' && message.content === 'Use the live selected source'
  ))
  const liveRun = options.runLedger.list(group.id).find(item => item.taskId === liveTask.id)
  const livePack = workspace.contextPackStore.get(liveRun.contextPackId)
  const livePackSource = livePack.sources.find(item => item.sourceId === liveSource.sourceId)
  const liveMetadataSource = livePack.sources.find(item => (
    item.type === 'knowledge' && item.sourceId !== liveSource.sourceId
  ))
  const liveMetadata = jsonBlob(workspace, liveMetadataSource.contentRef)
  assert.equal(livePackSource.captureMode, 'live-reference')
  assert.notEqual(livePackSource.contentHash, liveSelection.contentHash)
  assert.equal(liveMetadata.captureMode, 'live-reference')
  assert.equal(liveMetadata.citation.verification, 'live')
  const restarted = new LocalWorkspace(options)
  assert.equal(
    restarted.contentBlobStore.read(snapshotSource.contentRef).toString('utf8'),
    'Approved immutable Connector evidence',
  )
})

test('Run inputs and exact outbound payloads remain immutable across mutation and restart', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ledgerPath = path.join(directory, 'run-ledger.json')
  options.runLedger = new RunLedger({ storagePath: ledgerPath })
  const attachmentBytes = Buffer.from('immutable attachment bytes')
  const attachmentPath = path.join(directory, 'immutable.png')
  fs.writeFileSync(attachmentPath, attachmentBytes)
  options.resolveAttachments = async refs => refs.map(ref => ({
    ...ref,
    path: attachmentPath,
  }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    await runOptions.onOutboundPayload(outboundPayload(prompt))
    await runOptions.onSessionRef('codex-immutable-session', { transport: 'legacy' })
    return {
      text: 'Immutable result',
      sessionRef: 'codex-immutable-session',
      outcome: 'completed',
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Immutable input', agentKinds: ['codex'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Preserve this approved input',
    targetKinds: ['codex'],
    attachments: [{
      id: 'immutable-attachment',
      name: 'immutable.png',
      mimeType: 'image/png',
      size: attachmentBytes.length,
    }],
  })

  const task = workspace.snapshot().messages.find(message => message.role === 'user')
  const result = workspace.snapshot().messages.find(message => message.role === 'agent')
  const run = options.runLedger.list(group.id)[0]
  const basePack = workspace.contextPackStore.get(run.contextPackId)
  const attemptPack = workspace.contextPackStore.get(result.trace.context.contextPackId)
  const delivery = deliveryForMessage(workspace, result)
  const approvedPreview = jsonBlob(workspace, basePack.approvedPreviewRef)
  const deliveryPayload = jsonBlob(workspace, delivery.payloadRef)
  const exactWirePayload = jsonBlob(workspace, delivery.wirePayloadRef)
  const comparison = workspace.contextPacks.compareDelivery(delivery.deliveryRecordId)
  const attachmentSource = basePack.sources.find(source => source.type === 'attachment')

  assert.equal(basePack.taskId, task.id)
  assert.equal(attemptPack.parentPackId, basePack.contextPackId)
  assert.equal(delivery.contextPackId, attemptPack.contextPackId)
  assert.equal(approvedPreview.text, 'Preserve this approved input')
  assert.equal(deliveryPayload.prompt, calls[0].prompt)
  assert.equal(deliveryPayload.transport, 'legacy')
  assert.deepEqual(exactWirePayload, {
    args: ['--prompt', calls[0].prompt],
    command: '/private/bin/mock-agent',
    cwd: '/private/workspace',
    stdin: calls[0].prompt,
  })
  assert.equal(comparison.status, 'match')
  assert.deepEqual(comparison.differences, [])
  assert.equal(comparison.approvedPreviewHash, attemptPack.approvedPreviewHash)
  assert.equal(comparison.wirePayloadHash, delivery.wirePayloadHash)
  assert.equal(comparison.wirePayloadBytes, delivery.wirePayloadBytes)
  assert.deepEqual(deliveryPayload.comparison, comparison)
  assert.equal(Object.isFrozen(comparison), true)
  assert.equal(Object.isFrozen(comparison.checks), true)
  assert.doesNotMatch(
    JSON.stringify(comparison),
    /Preserve this approved input|private\/workspace|private\/bin|mock-agent/i,
  )
  assert.deepEqual(
    workspace.contentBlobStore.read(attachmentSource.contentRef),
    attachmentBytes,
  )
  assert.deepEqual(delivery.sessionProvenance, {
    scope: 'conversation',
    reuse: false,
    origin: 'created',
    originTaskId: task.id,
    inheritedTaskIds: [],
    completeness: 'complete',
  })

  workspace.state.messages.find(message => message.id === task.id).content = 'Mutated later'
  workspace.save()
  fs.writeFileSync(attachmentPath, 'mutated attachment bytes')

  assert.equal(jsonBlob(workspace, basePack.approvedPreviewRef).text, 'Preserve this approved input')
  assert.deepEqual(
    workspace.contentBlobStore.read(attachmentSource.contentRef),
    attachmentBytes,
  )

  fs.writeFileSync(ledgerPath, '{')
  const recovered = new RunLedger({ storagePath: ledgerPath }).get(run.runId)
  assert.equal(recovered.contextPackId, basePack.contextPackId)
  assert.deepEqual(
    recovered.agentRuns[0].context.deliveryRecordIds,
    result.trace.context.deliveryRecordIds,
  )
  assert.deepEqual(
    recovered.agentRuns[0].context.sessionProvenance,
    delivery.sessionProvenance,
  )
  const restarted = new LocalWorkspace(options)
  assert.deepEqual(
    restarted.contextPacks.compareDelivery(delivery.deliveryRecordId),
    comparison,
  )
})

test('Skill snapshot refs stay immutable while private materialization paths remain runtime-only', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runLedger = new RunLedger({ storagePath: path.join(directory, 'run-ledger.json') })
  let workspace
  const manifestHash = 'a'.repeat(64)
  const snapshotId = `skill-snapshot-${manifestHash}`
  const entryPath = path.join(directory, 'private-snapshots', snapshotId, 'SKILL.md')
  options.validateSkillSelections = (kind, selections) => selections.map(skill => ({
    ...skill,
    targetKind: kind,
    snapshotId,
    manifestHash,
    snapshotRef: workspace.contentBlobStore.put(JSON.stringify({ snapshotId }), {
      mediaType: 'application/json',
    }),
    entryPath,
  }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    await runOptions.onOutboundPayload(outboundPayload(prompt))
    return { text: 'Snapshot result', outcome: 'completed' }
  }
  workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Snapshot Skill', agentKinds: ['codex'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Use the approved Skill snapshot',
    targetKinds: ['codex'],
    skillHints: [{
      targetKind: 'codex', namespace: 'global', slug: 'review', name: 'Review',
    }],
  })

  const userMessage = workspace.snapshot().messages.find(message => message.role === 'user')
  const result = workspace.snapshot().messages.find(message => message.role === 'agent')
  const run = options.runLedger.list(group.id)[0]
  const basePack = workspace.contextPackStore.get(run.contextPackId)
  const attemptPack = workspace.contextPackStore.get(result.trace.context.contextPackId)
  const baseSkill = basePack.sources.find(source => source.type === 'skill')
  const attemptSkill = attemptPack.sources.find(source => source.type === 'skill')

  assert.equal(calls[0].prompt.includes(entryPath), true)
  assert.equal(JSON.stringify(userMessage).includes(entryPath), false)
  assert.equal(userMessage.skillHints[0].snapshotId, snapshotId)
  assert.equal(baseSkill.captureMode, 'snapshot')
  assert.equal(attemptSkill.captureMode, 'snapshot')
  assert.deepEqual(attemptSkill.contentRef, baseSkill.contentRef)
})

test('ACP Delivery comparison preserves exact JSON-RPC bytes and remains safe after restart', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (_agent, prompt, _workdir, runOptions) => {
    await runOptions.onOutboundPayload(outboundPayload(prompt, 'acp'))
    await runOptions.onSessionRef('private-acp-session', { transport: 'acp' })
    return { text: 'ACP result', sessionRef: 'private-acp-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'ACP comparison', agentKinds: ['kimi'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Compare this ACP input without exposing it',
    targetKinds: ['kimi'],
  })

  const result = workspace.snapshot().messages.find(message => message.role === 'agent')
  const delivery = deliveryForMessage(workspace, result)
  const wireBytes = workspace.contentBlobStore.read(delivery.wirePayloadRef)
  const frame = JSON.parse(wireBytes.toString('utf8'))
  const comparison = workspace.contextPacks.compareDelivery(delivery.deliveryRecordId)

  assert.equal(wireBytes.at(-1), 0x0a)
  assert.deepEqual(Object.keys(frame), ['jsonrpc', 'id', 'method', 'params'])
  assert.equal(frame.method, 'session/prompt')
  assert.equal(frame.params.sessionId, 'mock-acp-session')
  assert.equal(comparison.status, 'match')
  assert.deepEqual(comparison.differences, [])
  assert.equal(comparison.wirePayloadHash, delivery.wirePayloadHash)
  assert.equal(comparison.wirePayloadBytes, wireBytes.length)
  assert.doesNotMatch(
    JSON.stringify(comparison),
    /Compare this ACP input|mock-acp-session|private-acp-session|sessionId|command|\/private/i,
  )
  assert.throws(
    () => workspace.contextPacks.compareAttemptOutbound(delivery.contextPackId, {
      prompt: frame.params.prompt[0].text,
      transport: 'acp',
      serialization: 'acp-session-prompt-v1',
      promptMode: 'acp',
    }, Buffer.from('{"jsonrpc":"2.0"}\n', 'utf8')),
    { message: 'LOCAL_CONTEXT_DELIVERY_PARSE_FAILED' },
  )

  const restarted = new LocalWorkspace(options)
  assert.deepEqual(
    restarted.contextPacks.compareDelivery(delivery.deliveryRecordId),
    comparison,
  )
})

test('long in-budget requests verify the exact prompt that is actually delivered', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (_agent, prompt, _workdir, runOptions) => {
    calls.push({ prompt })
    await runOptions.onOutboundPayload(outboundPayload(prompt))
    return { text: 'Generated image request accepted', outcome: 'completed' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Long Codex request', agentKinds: ['codex'], workdir: directory,
    conversationType: 'direct', directAgentKind: 'codex',
  })
  const request = `Generate this image exactly: ${'dense visual direction '.repeat(180)}`.trim()

  await workspace.sendMessage({ groupId: group.id, text: request })

  const reply = workspace.snapshot().messages.find(message => message.role === 'agent')
  const attemptPack = workspace.contextPackStore.get(reply.trace.context.contextPackId)
  const approvedPreview = jsonBlob(workspace, attemptPack.approvedPreviewRef)
  const delivery = deliveryForMessage(workspace, reply)

  assert.equal(calls.length, 1)
  assert.equal(calls[0].prompt.includes(request), true)
  assert.equal(approvedPreview.text, calls[0].prompt)
  assert.equal(workspace.contextPacks.compareDelivery(delivery.deliveryRecordId).status, 'match')
})

test('a long current task reaches the Agent in full instead of failing the turn', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Long current task', agentKinds: ['codex'], workdir: directory,
    conversationType: 'direct', directAgentKind: 'codex',
  })
  // Longer than the former 6,000-character budget that failed every turn.
  const request = `Generate this image exactly: ${'dense visual direction '.repeat(800)}end-of-request`

  await workspace.sendMessage({ groupId: group.id, text: request })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].prompt.includes(request.trim()), true)
  assert.equal(workspace.snapshot().messages.some(message => (
    message.system?.params?.reason === 'LOCAL_RUN_REQUIRED_CONTEXT_OVERFLOW'
  )), false)
})

test('Codex-shaped stdin delivery verifies the exact budgeted prompt', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (_agent, prompt, _workdir, runOptions) => {
    calls.push({ prompt })
    await runOptions.onOutboundPayload(outboundPayload(prompt, 'codex'))
    return { text: 'Generated image request accepted', outcome: 'completed' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Codex stdin request', agentKinds: ['codex'], workdir: directory,
    conversationType: 'direct', directAgentKind: 'codex',
  })
  const request = `Generate this image exactly: ${'pixel and lighting direction '.repeat(180)}`

  await workspace.sendMessage({ groupId: group.id, text: request })

  const reply = workspace.snapshot().messages.find(message => message.role === 'agent')
  const delivery = deliveryForMessage(workspace, reply)
  const wire = jsonBlob(workspace, delivery.wirePayloadRef)
  const attemptPack = workspace.contextPackStore.get(reply.trace.context.contextPackId)
  const approvedPreview = jsonBlob(workspace, attemptPack.approvedPreviewRef)

  assert.equal(approvedPreview.text, calls[0].prompt)
  assert.equal(wire.stdin, calls[0].prompt)
  assert.equal(workspace.contextPacks.compareDelivery(delivery.deliveryRecordId).status, 'match')
})

test('Delivery comparison fails closed before a mismatched payload can dispatch', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let dispatched = false
  options.runAgent = async (_agent, prompt, _workdir, runOptions) => {
    await runOptions.onOutboundPayload(createLegacyOutboundPayload({
      prompt,
      command: '/private/bin/mock-agent',
      args: ['--prompt', 'different wire prompt'],
      cwd: '/private/workspace',
      stdin: 'different wire prompt',
      promptMode: 'stdin',
    }))
    dispatched = true
    return { text: 'must not complete', sessionRef: 'blocked-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Blocked comparison', agentKinds: ['codex'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Approved comparison input',
    targetKinds: ['codex'],
  })

  assert.equal(dispatched, false)
  const success = workspace.snapshot().messages.find(message => (
    message.role === 'agent' && message.content === 'must not complete'
  ))
  assert.equal(success, undefined)
})

test('group Tasks reuse native Sessions across automatic rounds and later Tasks', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    await runOptions.onOutboundPayload(outboundPayload(prompt))
    const sessionRef = runOptions.sessionRef || `${agent.kind}-task-session`
    await runOptions.onSessionRef(sessionRef, { transport: 'legacy' })
    const automatic = prompt.includes('MELDWORK_CONSENSUS')
    const kindAttempts = calls.filter(call => call.agent.kind === agent.kind).length
    const consensus = kindAttempts === 1 ? 'continue' : 'agree'
    return {
      text: automatic
        ? `Automatic result ${calls.length}\n[[MELDWORK_CONSENSUS:${consensus}]]`
        : 'Fresh Task result',
      sessionRef,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Task sessions', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  const automatic = await workspace.sendMessage({
    groupId: group.id,
    text: 'Use one Session for this automatic Task',
    mode: 'auto',
    maxRounds: 2,
  })
  await workspace.activeRuns.get(group.id).promise
  await workspace.sendMessage({
    groupId: group.id,
    text: 'Start a separate Task',
    targetKinds: ['codex'],
  })

  assert.deepEqual(calls.map(call => call.runOptions.sessionRef), [
    '', '', 'codex-task-session', 'hermes-task-session', 'codex-task-session',
  ])
  const results = workspace.snapshot().messages.filter(message => message.role === 'agent')
  const codexResults = results.filter(message => message.agentKind === 'codex')
  const deliveries = codexResults.map(message => deliveryForMessage(workspace, message))
  assert.deepEqual(deliveries.map(delivery => delivery.sessionProvenance), [
    {
      scope: 'conversation', reuse: false, origin: 'created',
      originTaskId: automatic.threadRootId, inheritedTaskIds: [], completeness: 'complete',
    },
    {
      scope: 'conversation', reuse: true, origin: 'resumed',
      originTaskId: automatic.threadRootId, inheritedTaskIds: [], completeness: 'complete',
    },
    {
      scope: 'conversation', reuse: true, origin: 'resumed',
      originTaskId: automatic.threadRootId,
      inheritedTaskIds: [], completeness: 'complete',
    },
  ])
  assert.notEqual(codexResults[0].threadRootId, codexResults[2].threadRootId)
  assert.equal(Object.keys(workspace.state.sessions).length, 2)
  assert.deepEqual(workspace.state.sessionMeta[workspace.sessionKey(group.id, 'codex')].inheritedTaskIds,
    [codexResults[2].threadRootId])
})

test('continuation traces describe only the exact outbound context and fingerprints', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let id = 0
  let workspace
  let expectedPacked
  options.createId = () => `context-id-${++id}`
  options.runAgent = async (_agent, prompt, _workdir, runOptions) => {
    calls.push({ prompt })
    expectedPacked = workspace.packedPromptContext(
      runOptions.groupId || workspace.snapshot().groups[0].id,
      'codex',
      'context-id-18',
    )
    await runOptions.onOutboundPayload(outboundPayload(prompt))
    return { text: 'Continuation result', sessionRef: runOptions.sessionRef, outcome: 'completed' }
  }
  workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Exact continuation context', agentKinds: ['codex'], workdir: directory,
  })
  for (let index = 0; index < 8; index += 1) {
    const user = workspace.addMessage(group.id, 'user', `Constraint ${index}`)
    workspace.addMessage(group.id, 'agent', `Conclusion ${index}`, 'hermes', user.id)
  }
  const taskId = 'context-id-18'
  const key = workspace.sessionKey(group.id, 'codex', taskId)
  workspace.state.sessions[key] = 'codex-existing-task-session'
  workspace.state.sessionMeta[key] = {
    turns: 1,
    estimatedChars: 800,
    transport: 'legacy',
    sessionScope: 'task',
    originTaskId: taskId,
    inheritedTaskIds: [],
    provenanceCompleteness: 'complete',
  }
  workspace.save()

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Continue with exact provenance',
    targetKinds: ['codex'],
  })

  const reply = workspace.snapshot().messages.find(message => (
    message.role === 'agent' && message.content === 'Continuation result'
  ))
  const context = reply.trace.context
  const attemptPack = workspace.contextPackStore.get(context.contextPackId)
  const sources = attemptPack.sources.map(source => ({
    type: source.type,
    sourceId: source.sourceId,
    contentHash: source.contentHash,
    targetKinds: source.targetKinds,
    captureMode: source.captureMode,
  }))
  const delivery = deliveryForMessage(workspace, reply)

  assert.equal(context.contextMode, 'continuation')
  assert.deepEqual(reply.trace.sourceMessageIds, expectedPacked.continuationSourceMessageIds)
  assert.notDeepEqual(reply.trace.sourceMessageIds, expectedPacked.sourceMessageIds)
  assert.equal(context.includedCount, reply.trace.sourceMessageIds.length)
  assert.equal(context.sourceCount, attemptPack.sources.length)
  assert.equal(context.sourceHash, createHash('sha256').update(canonicalJson(sources)).digest('hex'))
  assert.equal(context.promptChars, calls[0].prompt.length)
  assert.equal(context.promptBytes, Buffer.byteLength(calls[0].prompt))
  assert.equal(context.promptHash, createHash('sha256').update(calls[0].prompt).digest('hex'))
  assert.equal(context.wirePayloadBytes, delivery.wirePayloadBytes)
  assert.equal(context.wirePayloadHash, delivery.wirePayloadHash)
  assert.equal(context.sessionProvenance.reuse, true)
})

test('direct Session deliveries expose bounded Task ancestry across messages', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (_agent, prompt, _workdir, runOptions) => {
    await runOptions.onOutboundPayload(outboundPayload(prompt))
    const sessionRef = runOptions.sessionRef || 'codex-direct-session'
    await runOptions.onSessionRef(sessionRef, { transport: 'legacy' })
    return { text: `Direct result for ${prompt.length}`, sessionRef }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const direct = workspace.createGroup({
    name: 'Direct ancestry',
    conversationType: 'direct',
    directAgentKind: 'codex',
    agentKinds: ['codex'],
    workdir: directory,
  })

  await workspace.sendMessage({ groupId: direct.id, text: 'First direct Task' })
  await workspace.sendMessage({ groupId: direct.id, text: 'Second direct Task' })
  await workspace.sendMessage({ groupId: direct.id, text: 'Third direct Task' })

  const tasks = workspace.snapshot().messages.filter(message => message.role === 'user')
  const results = workspace.snapshot().messages.filter(message => message.role === 'agent')
  const provenances = results.map(message => deliveryForMessage(workspace, message).sessionProvenance)
  assert.deepEqual(provenances, [
    {
      scope: 'conversation', reuse: false, origin: 'created',
      originTaskId: tasks[0].id, inheritedTaskIds: [], completeness: 'complete',
    },
    {
      scope: 'conversation', reuse: true, origin: 'resumed',
      originTaskId: tasks[0].id, inheritedTaskIds: [], completeness: 'complete',
    },
    {
      scope: 'conversation', reuse: true, origin: 'resumed',
      originTaskId: tasks[0].id, inheritedTaskIds: [tasks[1].id], completeness: 'complete',
    },
  ])
  assert.deepEqual(
    workspace.state.sessionMeta[workspace.sessionKey(direct.id, 'codex')].inheritedTaskIds,
    [tasks[1].id, tasks[2].id],
  )
})

test('legacy conversation Sessions retain unknown provenance across group Tasks', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    await runOptions.onOutboundPayload(outboundPayload(prompt))
    const sessionRef = runOptions.sessionRef || `codex-session-${calls.length}`
    await runOptions.onSessionRef(sessionRef, { transport: 'legacy' })
    return { text: `Legacy migration ${calls.length}`, sessionRef }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Legacy migration', agentKinds: ['codex'], workdir: directory,
  })
  const legacyKey = workspace.sessionKey(group.id, 'codex')
  workspace.state.sessions[legacyKey] = 'codex-legacy-global'
  workspace.state.sessionMeta[legacyKey] = { turns: 3, estimatedChars: 900 }
  workspace.save()

  await workspace.sendMessage({ groupId: group.id, text: 'Migrate once', targetKinds: ['codex'] })
  await workspace.sendMessage({ groupId: group.id, text: 'Do not reuse it again', targetKinds: ['codex'] })

  assert.deepEqual(calls.map(call => call.runOptions.sessionRef), ['codex-legacy-global', 'codex-legacy-global'])
  const results = workspace.snapshot().messages.filter(message => message.role === 'agent')
  assert.deepEqual(deliveryForMessage(workspace, results[0]).sessionProvenance, {
    scope: 'unknown-legacy',
    reuse: true,
    origin: 'unknown-legacy',
    originTaskId: null,
    inheritedTaskIds: [],
    completeness: 'unknown-legacy',
  })
  assert.deepEqual(deliveryForMessage(workspace, results[1]).sessionProvenance, {
    scope: 'unknown-legacy',
    reuse: true,
    origin: 'unknown-legacy',
    originTaskId: null,
    inheritedTaskIds: [],
    completeness: 'unknown-legacy',
  })
  assert.equal(Object.hasOwn(workspace.state.sessions, legacyKey), true)
})

test('Session ref and provenance persistence rolls back together when saving fails', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const direct = workspace.createGroup({
    name: 'Atomic direct Session',
    conversationType: 'direct',
    directAgentKind: 'codex',
    agentKinds: ['codex'],
    workdir: directory,
  })
  const directKey = workspace.sessionKey(direct.id, 'codex')
  workspace.state.sessions[directKey] = 'codex-before-failure'
  workspace.state.sessionMeta[directKey] = {
    turns: 2,
    estimatedChars: 500,
    sessionScope: 'conversation',
    originTaskId: 'task-origin',
    inheritedTaskIds: [],
    provenanceCompleteness: 'complete',
  }
  workspace.save()
  const beforeDirect = structuredClone(workspace.state)
  const save = workspace.save.bind(workspace)
  workspace.save = () => { throw new Error('WORKSPACE_SAVE_FAILED') }

  assert.throws(() => workspace.persistSessionState(
    directKey,
    'codex-after-failure',
    {
      sessionScope: 'conversation',
      originTaskId: 'task-origin',
      inheritedTaskIds: ['task-next'],
      provenanceCompleteness: 'complete',
    },
  ), { message: 'WORKSPACE_SAVE_FAILED' })
  assert.deepEqual(workspace.state, beforeDirect)

  workspace.save = save
  const shared = workspace.createGroup({
    name: 'Atomic migration', agentKinds: ['codex'], workdir: directory,
  })
  const legacyKey = workspace.sessionKey(shared.id, 'codex')
  workspace.state.sessions[legacyKey] = 'codex-migration-before-failure'
  workspace.save()
  const beforeMigration = structuredClone(workspace.state)
  workspace.save = () => { throw new Error('WORKSPACE_SAVE_FAILED') }

  assert.throws(
    () => workspace.sessionState(shared, 'codex', 'task-migration', 'task-migration'),
    { message: 'WORKSPACE_SAVE_FAILED' },
  )
  assert.deepEqual(workspace.state, beforeMigration)
  workspace.save = save
})

test('invalid stored Session refs remove paired provenance metadata after restart', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Invalid Session cleanup', agentKinds: ['codex'], workdir: directory,
  })
  const taskId = 'task-invalid-session'
  const key = workspace.sessionKey(group.id, 'codex', taskId)
  const stored = JSON.parse(fs.readFileSync(options.storagePath, 'utf8'))
  stored.sessions[key] = 'invalid/session/ref'
  stored.sessionMeta[key] = {
    turns: 4,
    estimatedChars: 2400,
    sessionScope: 'task',
    originTaskId: taskId,
    inheritedTaskIds: [],
    provenanceCompleteness: 'complete',
  }
  fs.writeFileSync(options.storagePath, `${JSON.stringify(stored, null, 2)}\n`)
  const restarted = new LocalWorkspace(options)
  const restartedGroup = restarted.state.groups.find(item => item.id === group.id)

  assert.equal(Object.hasOwn(restarted.state.sessions, key), false)
  assert.equal(Object.hasOwn(restarted.state.sessionMeta, key), true)

  const resolved = restarted.sessionState(restartedGroup, 'codex', taskId, taskId)
  const persisted = JSON.parse(fs.readFileSync(options.storagePath, 'utf8'))

  assert.equal(resolved.sessionRef, '')
  assert.equal(Object.hasOwn(restarted.state.sessions, key), false)
  assert.equal(Object.hasOwn(restarted.state.sessionMeta, key), false)
  assert.equal(Object.hasOwn(persisted.sessions, key), false)
  assert.equal(Object.hasOwn(persisted.sessionMeta, key), false)
})

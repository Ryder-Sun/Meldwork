const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { ContentBlobStore } = require('../../src/attachments/content-blob-store.cjs')
const { HumanGateStore } = require('../../src/gates/human-gate-store.cjs')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { deferred, fixture } = require('../support/local-workspace-test-helpers.cjs')

test('installed Agents distinguish ready, local CLI, and missing credential states', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const readinessAgents = []
  options.credentialState = async (kind, agent) => {
    readinessAgents.push(agent)
    if (kind === 'hermes') return { state: 'missing', source: 'native-auth-status' }
    if (kind === 'kimi') return { state: 'unknown', source: 'unverified' }
    return { state: 'ready', source: 'native-credential' }
  }
  const workspace = new LocalWorkspace(options)

  const snapshot = await workspace.refreshAgents()
  const codex = snapshot.agents.find(agent => agent.kind === 'codex')
  const hermes = snapshot.agents.find(agent => agent.kind === 'hermes')
  const kimi = snapshot.agents.find(agent => agent.kind === 'kimi')

  assert.equal(codex.installed, true)
  assert.equal(codex.available, true)
  assert.equal(codex.showInSidebar, true)
  assert.deepEqual(Object.keys(codex.capabilities).sort(), [
    'contextLimitChars', 'costBand', 'domains', 'inputTypes', 'latencyBand',
    'outputTypes', 'permissionModes', 'resumable', 'task', 'toolClasses',
  ])
  assert.ok(codex.capabilities.domains.includes('software-development'))
  assert.equal(hermes.installed, true)
  assert.equal(hermes.available, false)
  assert.equal(hermes.credentialState, 'missing')
  assert.equal(hermes.showInSidebar, true)
  assert.equal(kimi.available, true)
  assert.equal(kimi.credentialState, 'unknown')
  assert.equal(kimi.availabilitySource, 'local-cli')
  assert.equal(kimi.showInSidebar, true)
  assert.equal(readinessAgents.find(agent => agent.kind === 'kimi').executable, '/tmp/kimi')
})

test('rejects unsupported workflow submissions before launching an Agent', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Standard group', agentKinds: ['codex'], workdir: directory,
  })

  await assert.rejects(workspace.sendMessage({
    groupId: group.id,
    text: 'Do not run this legacy workflow.',
    targetKinds: ['codex'],
    workflow: { template: 'role-review' },
  }), { message: 'LOCAL_WORKFLOW_UNSUPPORTED' })
  assert.equal(calls.length, 0)
})

test('workspace startup rejects orphaned Human Gates after restoring interrupted Runs', (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const privateRoot = path.join(directory, 'meldwork-private')
  const contentBlobStore = new ContentBlobStore({
    rootPath: path.join(privateRoot, 'content-blobs'),
  })
  const humanGateStore = new HumanGateStore({
    storagePath: path.join(privateRoot, 'human-gates.json'),
    contentBlobStore,
  })
  const pending = humanGateStore.create({
    type: 'permission',
    runId: 'run-orphaned',
    agentRunId: 'agent-run-orphaned',
    agentKind: 'codex',
    summary: 'Agent requests permission to edit the workspace.',
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ],
    createdAt: '2026-07-28T00:00:00.000Z',
    request: { tool: 'write_file' },
  })

  const workspace = new LocalWorkspace({ ...options, contentBlobStore, humanGateStore })

  assert.equal(workspace.listHumanGates({ pendingOnly: true }).length, 0)
  assert.deepEqual(workspace.listHumanGates().find(gate => gate.gateId === pending.gateId)?.decision, {
    status: 'rejected',
    optionId: 'reject-once',
    actorId: 'meldwork-system',
    decidedAt: '2026-07-28T00:00:00.000Z',
  })
})

test('OpenCodeReview can be shown in the sidebar and receive direct instructions', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.detectAgents = async () => [
    { kind: 'codex', name: 'Codex', executable: '/tmp/codex', version: '1.0.0' },
    {
      kind: 'opencodereview', name: 'OpenCodeReview', executable: '/tmp/ocr', version: '1.8.6',
    },
  ]
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: 'Review completed.', sessionRef: 'ignored-review-session', outcome: 'completed',
      externalRunRef: 'ocr-review-123',
    }
  }
  const workspace = new LocalWorkspace(options)
  const snapshot = await workspace.refreshAgents()
  const reviewAgent = snapshot.agents.find(agent => agent.kind === 'opencodereview')
  assert.equal(reviewAgent.available, true)
  assert.equal(reviewAgent.task, 'code_review')
  assert.equal(reviewAgent.showInSidebar, true)

  workspace.setSidebarVisibility('opencodereview', false)
  assert.equal(workspace.snapshot().agents.find(agent => agent.kind === 'opencodereview').showInSidebar, false)
  workspace.setSidebarVisibility('opencodereview', true)
  assert.equal(workspace.snapshot().agents.find(agent => agent.kind === 'opencodereview').showInSidebar, true)

  const directGroup = workspace.createGroup({
    conversationType: 'direct', directAgentKind: 'opencodereview', workdir: directory,
  })
  assert.deepEqual(directGroup.agentKinds, ['opencodereview'])

  await workspace.sendMessage({
    groupId: directGroup.id,
    text: 'Review the current diff and focus on regressions.',
    targetKinds: ['opencodereview'],
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].agent.kind, 'opencodereview')
  assert.match(calls[0].prompt, /Review the current diff and focus on regressions\./)
  assert.equal(calls[0].runOptions.sandbox, 'read-only')
  assert.equal(calls[0].runOptions.sessionRef, '')
  assert.equal(Object.keys(workspace.state.sessions).length, 0)
  assert.equal(Object.keys(workspace.state.sessionMeta).length, 0)
  const reply = workspace.snapshot().messages.find(message => message.role === 'agent')
  assert.equal(reply.agentKind, 'opencodereview')
  assert.equal(reply.trace.context.externalRunRef, 'ocr-review-123')
})

test('an explicit internal code-review task runs once and remains read-only', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.detectAgents = async () => [{
    kind: 'opencodereview', name: 'OpenCodeReview', executable: '/tmp/ocr', version: '1.8.6',
  }]
  let captureCalls = 0
  let importCalls = 0
  options.captureAgentOutputs = async () => { captureCalls += 1 }
  options.importAgentOutputs = async () => { importCalls += 1; return [] }
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: 'Review completed.', sessionRef: '', outcome: 'completed',
      externalRunRef: 'ocr-review-123',
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = {
    id: 'code-review-task', name: 'Code review', topic: '',
    agentKinds: ['opencodereview'], workdir: directory, allowWrite: true,
    createdAt: '2026-07-28T00:00:00.000Z', updatedAt: '2026-07-28T00:00:00.000Z',
  }
  workspace.state.groups.push(group)
  const task = workspace.addMessage(group.id, 'user', 'Review the current workspace')
  const contextPack = workspace.createContextPack({
    group,
    taskId: task.id,
    mode: 'manual',
    targetKinds: ['opencodereview'],
    message: task,
  })
  const reservation = workspace.reserveRun(
    group.id, 'manual', ['opencodereview'], task.id,
  )
  workspace.bindRunTask(
    group.id, reservation, task.id, task.id, contextPack.contextPackId,
  )
  const controller = workspace.beginRun(
    group.id, 'manual', ['opencodereview'], task.id, reservation,
  )
  controller.currentKind = 'opencodereview'

  const result = await workspace.invokeAgent(
    group,
    'opencodereview',
    'manual',
    controller.signal,
    '',
    { taskType: 'code_review' },
  )
  await workspace.finishRun(group.id, controller, 'completed')

  assert.equal(result.message.content, 'Review completed.')
  assert.equal(result.message.trace.context.externalRunRef, 'ocr-review-123')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].runOptions.sandbox, 'read-only')
  assert.equal(calls[0].runOptions.sessionRef, '')
  assert.equal(captureCalls, 0)
  assert.equal(importCalls, 0)
  assert.equal(Object.keys(workspace.state.sessions).length, 0)
  assert.equal(Object.keys(workspace.state.sessionMeta).length, 0)
})

test('Custom Agent kinds keep their dynamic label across execution and reload', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const kind = 'custom-0123456789abcdef'
  options.detectAgents = async () => [{
    kind,
    name: 'Repository Reviewer CLI',
    executable: '/tmp/review-agent',
    version: '1.0.0',
    custom: true,
  }]
  options.agentLabel = selectedKind => selectedKind === kind ? 'Repository Reviewer' : ''
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    conversationType: 'direct',
    directAgentKind: kind,
    agentKinds: [kind],
    workdir: directory,
  })

  await workspace.sendMessage({ groupId: group.id, text: 'Review this change', targetKinds: [kind] })

  assert.match(calls[0].prompt, /as Repository Reviewer\./)
  assert.equal(calls[0].runOptions.sandbox, 'workspace-write')
  const reply = workspace.snapshot().messages.find(message => message.role === 'agent')
  assert.equal(reply.agentKind, kind)
  assert.equal(reply.senderName, 'Repository Reviewer')

  const reloaded = new LocalWorkspace(options)
  assert.equal(reloaded.snapshot().groups[0].directAgentKind, kind)
  assert.equal(reloaded.snapshot().messages.find(message => message.role === 'agent').senderName,
    'Repository Reviewer')

  await reloaded.refreshAgents()
  const writeGroup = reloaded.createGroup({
    name: 'Writable review',
    agentKinds: [kind],
    allowWrite: true,
    workdir: directory,
  })
  await reloaded.sendMessage({
    groupId: writeGroup.id,
    text: 'Apply the approved change',
    targetKinds: [kind],
  })
  assert.equal(calls.at(-1).runOptions.sandbox, 'workspace-write')
})

test('a detected local Agent stays usable while native credential state is unverified', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const kimiState = { state: 'unknown', source: 'unverified' }
  options.credentialState = async kind => kind === 'kimi'
    ? kimiState
    : { state: 'ready', source: 'native-credential' }
  const workspace = new LocalWorkspace(options)
  const initial = await workspace.refreshAgents()
  const initialKimi = initial.agents.find(agent => agent.kind === 'kimi')
  assert.equal(initialKimi.available, true)
  assert.equal(initialKimi.credentialState, 'unknown')
  assert.equal(initialKimi.availabilitySource, 'local-cli')
  const group = workspace.createGroup({
    name: '首次验证', agentKinds: ['kimi'], workdir: directory,
  })
  await workspace.sendMessage({ groupId: group.id, text: '测试', targetKinds: ['kimi'] })

  assert.equal(calls[0].agent.kind, 'kimi')
  const kimi = workspace.snapshot().agents.find(agent => agent.kind === 'kimi')
  assert.equal(kimi.credentialState, 'ready')
  assert.equal(kimi.available, true)
  assert.equal(kimi.availabilitySource, 'verified-run')
})

test('an authentication failure keeps an Agent unavailable when later detection is unverified', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let nativeState = { state: 'ready', source: 'native-credential' }
  options.credentialState = async () => nativeState
  options.runAgent = async () => { throw new Error('Please log in first') }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '待验证', agentKinds: ['kimi'], workdir: directory,
  })

  await workspace.sendMessage({ groupId: group.id, text: '测试', targetKinds: ['kimi'] })
  assert.equal(workspace.snapshot().agents.find(agent => agent.kind === 'kimi').available, false)

  nativeState = { state: 'unknown', source: 'unverified' }
  await workspace.refreshAgents()
  const kimi = workspace.snapshot().agents.find(agent => agent.kind === 'kimi')
  assert.equal(kimi.credentialState, 'missing')
  assert.equal(kimi.available, false)
  assert.equal(kimi.availabilitySource, 'runtime-auth-failure')
})

test('runtime authentication failures require an explicit retry before native evidence recovers', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let nativeState = { state: 'ready', source: 'native-credential' }
  options.credentialState = async () => nativeState
  options.runAgent = async () => { throw new Error('Please log in first') }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '凭据恢复', agentKinds: ['kimi'], workdir: directory,
  })
  await workspace.sendMessage({ groupId: group.id, text: '测试', targetKinds: ['kimi'] })

  await workspace.refreshAgents()

  let kimi = workspace.snapshot().agents.find(agent => agent.kind === 'kimi')
  assert.equal(kimi.credentialState, 'missing')
  assert.equal(kimi.available, false)
  assert.equal(kimi.availabilitySource, 'runtime-auth-failure')

  assert.equal(workspace.clearRuntimeCredentialFailures(), true)
  await workspace.refreshAgents()

  kimi = workspace.snapshot().agents.find(agent => agent.kind === 'kimi')
  assert.equal(kimi.credentialState, 'ready')
  assert.equal(kimi.available, true)
  assert.equal(kimi.availabilitySource, 'native-credential')
})

test('authoritative native logout overrides historical successful runs', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let nativeState = { state: 'ready', source: 'native-auth-status' }
  options.credentialState = async () => nativeState
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '退出登录', agentKinds: ['codex'], workdir: directory,
  })
  await workspace.sendMessage({ groupId: group.id, text: '测试', targetKinds: ['codex'] })

  nativeState = { state: 'missing', source: 'native-auth-status' }
  await workspace.refreshAgents()

  const codex = workspace.snapshot().agents.find(agent => agent.kind === 'codex')
  assert.equal(codex.credentialState, 'missing')
  assert.equal(codex.available, false)
  assert.equal(codex.availabilitySource, 'native-auth-status')
})

test('a slow readiness refresh cannot overwrite a concurrent runtime authentication failure', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let refreshing = false
  let releaseClaude
  options.credentialState = async (kind) => {
    if (refreshing && kind === 'kimi') return { state: 'unknown', source: 'unverified' }
    if (refreshing && kind === 'hermes') {
      return new Promise(resolve => { releaseClaude = resolve })
    }
    return { state: 'ready', source: 'native-credential' }
  }
  options.runAgent = async () => { throw new Error('Please log in first') }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '并发刷新', agentKinds: ['kimi'], workdir: directory,
  })

  refreshing = true
  const refresh = workspace.refreshAgents()
  while (!releaseClaude) await new Promise(resolve => setImmediate(resolve))
  await workspace.sendMessage({ groupId: group.id, text: '测试', targetKinds: ['kimi'] })
  releaseClaude({ state: 'ready', source: 'native-credential' })
  await refresh

  const kimi = workspace.snapshot().agents.find(agent => agent.kind === 'kimi')
  assert.equal(kimi.credentialState, 'missing')
  assert.equal(kimi.available, false)
  assert.equal(kimi.availabilitySource, 'runtime-auth-failure')
})

test('sidebar visibility persists independently of Agent availability', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.credentialState = async kind => kind === 'hermes'
    ? { state: 'missing', source: 'none' }
    : { state: 'ready', source: 'native-credential' }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()

  workspace.setSidebarVisibility('codex', false)
  assert.equal(workspace.snapshot().agents.find(agent => agent.kind === 'codex').showInSidebar, false)
  workspace.setSidebarVisibility('hermes', true)
  assert.equal(workspace.snapshot().agents.find(agent => agent.kind === 'hermes').showInSidebar, true)
  assert.equal(workspace.snapshot().agents.find(agent => agent.kind === 'hermes').available, false)

  const restored = new LocalWorkspace(options)
  await restored.refreshAgents()
  assert.equal(restored.snapshot().agents.find(agent => agent.kind === 'codex').showInSidebar, false)
  assert.equal(restored.snapshot().agents.find(agent => agent.kind === 'hermes').showInSidebar, true)
})

test('groups and messages persist without exposing executable paths', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '本地测试群',
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
  })
  await workspace.sendMessage({
    groupId: group.id,
    text: '开始讨论',
    targetKinds: ['codex'],
    mentionedAgentKinds: ['codex'],
  })

  const restored = new LocalWorkspace(options)
  assert.equal(restored.snapshot().groups[0].name, '本地测试群')
  assert.equal(restored.snapshot().messages.length, 2)
  assert.deepEqual(restored.snapshot().messages[0].targetKinds, ['codex'])
  assert.equal(restored.snapshot().messages[0].routingDecision.mode, 'explicit')
  assert.equal('executable' in workspace.snapshot().agents[0], false)
})

test('invalid explicit targets fail before Task or message persistence', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Strict targets', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  for (const [targetKinds, code] of [
    [['codex', 'codex'], 'LOCAL_MESSAGE_TARGET_DUPLICATE'],
    [['unknown-agent'], 'LOCAL_MESSAGE_TARGET_UNKNOWN'],
    [['qwen'], 'LOCAL_MESSAGE_TARGET_OUT_OF_GROUP'],
  ]) {
    await assert.rejects(workspace.sendMessage({
      groupId: group.id, text: 'Must not persist', targetKinds,
    }), { message: code })
  }
  workspace.markRuntimeCredential('hermes', 'missing')
  await assert.rejects(workspace.sendMessage({
    groupId: group.id, text: 'Unavailable target', targetKinds: ['hermes'],
  }), { message: 'LOCAL_AGENT_UNAVAILABLE' })

  assert.equal(calls.length, 0)
  assert.equal(workspace.snapshot().messages.length, 0)
  assert.equal(workspace.runLedger?.list?.().length || 0, 0)
})

test('opt-in automatic routing persists the smallest evidence-ranked team', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.agentFitMatrix = {
    version: 'fit-matrix-test-v1',
    entries: [
      { kind: 'codex', domains: ['general'], score: 60, confidence: 0.8, sampleSize: 10 },
      { kind: 'hermes', domains: ['general'], score: 90, confidence: 0.9, sampleSize: 12 },
    ],
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Automatic routing', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Choose the smallest suitable team.',
    targetKinds: [],
    routingMode: 'automatic',
  })

  assert.deepEqual(calls.map(call => call.agent.kind), ['hermes'])
  const root = workspace.snapshot().messages.find(message => message.role === 'user')
  assert.deepEqual(root.targetKinds, ['hermes'])
  assert.equal(root.routingDecision.mode, 'automatic')
  assert.equal(root.routingDecision.rationale, 'evidence-ranked-team')
  assert.equal(root.routingDecision.evidenceVersion, 'fit-matrix-test-v1')
  assert.deepEqual(root.routingDecision.selectedKinds, ['hermes'])

  const restored = new LocalWorkspace(options)
  assert.deepEqual(
    restored.snapshot().messages.find(message => message.role === 'user').routingDecision,
    root.routingDecision,
  )
})

test('all supported workspace versions preserve stored or omitted read-only permission', (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  for (const version of [1, 2, 3]) {
    for (const storedPermission of [false, undefined]) {
      const group = {
        id: `workspace-v${version}-${storedPermission === false ? 'false' : 'omitted'}`,
        name: 'Stored group',
        agentKinds: ['codex'],
        workdir: directory,
      }
      if (storedPermission !== undefined) group.allowWrite = storedPermission
      fs.writeFileSync(options.storagePath, `${JSON.stringify({
        version,
        groups: [group],
        messages: [],
        sessions: {},
      })}\n`)

      const restored = new LocalWorkspace(options)
      assert.equal(restored.state.version, 3)
      assert.equal(restored.snapshot().groups[0].allowWrite, false)
    }
  }
})

test('Skills are validated and injected only into their selected target Agent', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const validationCalls = []
  options.validateSkillSelections = (kind, selections) => {
    validationCalls.push({ kind, selections })
    return selections
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Skill routing', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const review = {
    targetKind: 'codex', namespace: 'quality', slug: 'review', name: 'Review code',
  }
  const research = {
    targetKind: 'hermes', namespace: 'research', slug: 'sources', name: 'Find sources',
  }

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Compare the implementation',
    targetKinds: ['codex', 'hermes'],
    skillHints: [review, research],
  })

  assert.deepEqual(validationCalls, [
    { kind: 'codex', selections: [review] },
    { kind: 'hermes', selections: [research] },
  ])
  assert.match(calls[0].prompt, /quality\/review: Review code/)
  assert.doesNotMatch(calls[0].prompt, /research\/sources|Find sources/)
  assert.match(calls[1].prompt, /research\/sources: Find sources/)
  assert.doesNotMatch(calls[1].prompt, /quality\/review|Review code/)
  assert.equal(calls[0].runOptions.skills, undefined)
  assert.equal(calls[1].runOptions.skills, undefined)
  assert.deepEqual(workspace.snapshot().messages[0].skillHints, [review, research])

  await assert.rejects(
    workspace.sendMessage({
      groupId: group.id,
      text: 'Invalid target',
      targetKinds: ['codex'],
      skillHints: [research],
    }),
    { message: 'LOCAL_SKILL_SELECTION_INVALID' },
  )
  await assert.rejects(
    workspace.sendMessage({
      groupId: group.id,
      text: 'Invalid mention',
      targetKinds: ['codex'],
      mentionedAgentKinds: ['hermes'],
    }),
    { message: 'LOCAL_MESSAGE_TARGET_REQUIRED' },
  )
  assert.equal(workspace.snapshot().messages.filter(message => message.role === 'user').length, 1)
})

test('Skill contracts block permission escalation before the Agent process starts', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.detectAgents = async () => [{
    kind: 'codex', name: 'Codex CLI', executable: '/tmp/codex', version: '0.137.0',
  }]
  const selected = {
    targetKind: 'codex', namespace: 'global', slug: 'writer', name: 'Writer',
  }
  options.validateSkillSelections = (_kind, selections) => selections.map((selection) => {
    const runtime = { ...selection }
    Object.defineProperty(runtime, 'approvedSkillManifest', {
      enumerable: false,
      value: {
        schemaVersion: 1,
        recordType: 'meldwork-skill-manifest',
        identity: { id: 'global/writer', version: '1.0.0' },
        origin: { type: 'local-unsigned', publisher: 'Local author' },
        agents: [{ kind: 'codex', minVersion: '0.130.0', maxVersion: '0.200.0' }],
        inputTypes: ['text'],
        tools: ['filesystem'],
        credentials: [],
        permissionMode: 'workspace-write',
        networkDestinations: [],
        sideEffectClass: 'local-write',
      },
    })
    return runtime
  })
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Read-only Skill', agentKinds: ['codex'], workdir: directory, allowWrite: false,
  })

  await assert.rejects(workspace.sendMessage({
    groupId: group.id,
    text: 'Use the writer Skill',
    targetKinds: ['codex'],
    skillHints: [selected],
  }), { message: 'LOCAL_SKILL_PERMISSION_ESCALATION' })
  assert.equal(calls.length, 0)
})

test('Knowledge bases are validated, persisted, and injected only into selected Agents', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const vaultPath = path.join(directory, 'Obsidian Vault')
  const validationCalls = []
  let injectUnexpectedTarget = false
  options.validateKnowledgeBaseSelections = (targetKinds, selections) => {
    validationCalls.push({ targetKinds, selections })
    return selections.map((selection) => {
      if (selection.kind === 'obsidian') {
        return {
          kind: 'obsidian',
          name: 'Obsidian',
          accessMode: 'vault',
          location: vaultPath,
          targetKinds: injectUnexpectedTarget ? ['codex', 'hermes'] : selection.targetKinds,
        }
      }
      return {
        kind: 'dingtalk',
        name: 'DingTalk',
        accessMode: 'cli',
        commandName: 'dws',
        targetKinds: selection.targetKinds,
      }
    })
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Knowledge routing', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const requestedHints = [
    { kind: 'obsidian', targetKinds: ['codex'] },
    { kind: 'dingtalk', targetKinds: ['hermes'] },
  ]

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Compare the configured sources',
    targetKinds: ['codex', 'hermes'],
    knowledgeBaseHints: requestedHints,
  })

  assert.deepEqual(validationCalls[0], {
    targetKinds: ['codex', 'hermes'],
    selections: requestedHints,
  })
  assert.match(calls[0].prompt, /read from the local vault at/)
  assert.match(calls[0].prompt, new RegExp(vaultPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(calls[0].prompt, /configured dws command-line connection/)
  assert.match(calls[1].prompt, /configured dws command-line connection/)
  assert.doesNotMatch(calls[1].prompt, /read from the local vault at/)
  assert.match(calls[0].prompt, /do not modify source content/)

  const storedHints = workspace.snapshot().messages[0].knowledgeBaseHints
  assert.deepEqual(storedHints, [
    {
      kind: 'obsidian', name: 'Obsidian', accessMode: 'vault',
      location: vaultPath, targetKinds: ['codex'],
    },
    {
      kind: 'dingtalk', name: 'DingTalk', accessMode: 'cli',
      commandName: 'dws', targetKinds: ['hermes'],
    },
  ])
  const restored = new LocalWorkspace(options)
  assert.deepEqual(restored.snapshot().messages[0].knowledgeBaseHints, storedHints)

  await assert.rejects(workspace.sendMessage({
    groupId: group.id,
    text: 'Reject an out-of-scope source',
    targetKinds: ['codex'],
    knowledgeBaseHints: [{ kind: 'dingtalk', targetKinds: ['hermes'] }],
  }), { message: 'LOCAL_KNOWLEDGE_BASE_SELECTION_INVALID' })

  injectUnexpectedTarget = true
  await assert.rejects(workspace.sendMessage({
    groupId: group.id,
    text: 'Reject invalid main-process validation output',
    targetKinds: ['codex'],
    knowledgeBaseHints: [{ kind: 'obsidian', targetKinds: ['codex'] }],
  }), { message: 'LOCAL_KNOWLEDGE_BASE_SELECTION_INVALID' })
  assert.equal(workspace.snapshot().messages.filter(message => message.role === 'user').length, 1)
})

test('image-only messages persist safe metadata and pass resolved paths to supported CLIs', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Image review', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const attachment = {
    id: 'attachment-1', name: 'diagram.png', mimeType: 'image/png', size: 128,
  }

  await workspace.sendMessage({
    groupId: group.id,
    text: '',
    targetKinds: ['codex', 'hermes'],
    attachments: [attachment],
  })

  const expectedPath = path.join(directory, 'attachments', 'attachment-1.png')
  assert.deepEqual(calls.map(call => call.runOptions.attachments), [
    [expectedPath], [expectedPath],
  ])
  const storedMessage = workspace.snapshot().messages[0]
  assert.equal(storedMessage.content, '')
  assert.deepEqual(storedMessage.attachments, [attachment])
  assert.equal(JSON.stringify(storedMessage).includes(expectedPath), false)

  const restored = new LocalWorkspace(options)
  assert.deepEqual(restored.snapshot().messages[0].attachments, [attachment])
})

test('document messages use temporary relative Agent inputs without exposing private paths', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const sourceRoot = path.join(directory, 'attachments')
  const sourcePath = path.join(sourceRoot, 'report.pdf')
  fs.mkdirSync(sourceRoot)
  fs.writeFileSync(sourcePath, '%PDF-1.7\n')
  options.attachmentSupport = kind => ({
    image: options.imageAttachmentLimit(kind),
    file: 4,
  })
  options.resolveAttachments = async refs => refs.map(ref => ({ ...ref, path: sourcePath }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Document review', agentKinds: ['codex'], workdir: directory,
  })
  const attachment = {
    id: 'document-1', name: 'report.pdf', mimeType: 'application/pdf', size: 9,
  }

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Review the report',
    targetKinds: ['codex'],
    attachments: [attachment],
  })

  assert.deepEqual(calls[0].runOptions.attachments, [])
  assert.match(calls[0].prompt, /\.meldwork-input\/\.run-[^/]+\/1-report\.pdf/)
  assert.equal(calls[0].prompt.includes(sourceRoot), false)
  assert.equal(fs.existsSync(path.join(directory, '.meldwork-input')), false)
  assert.deepEqual(workspace.snapshot().messages[0].attachments, [attachment])
})

test('message deletion persists replies individually and removes a whole group topic from history', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Message cleanup', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const root = workspace.addMessage(group.id, 'user', 'Remove this topic', '', '', null, {
    attachments: [{
      id: 'attachment-root', name: 'root.png', mimeType: 'image/png', size: 10,
    }],
  })
  const reply = workspace.addMessage(group.id, 'agent', 'Remove only this reply', 'codex', root.id, null, {
    attachments: [{
      id: 'attachment-reply', name: 'reply.png', mimeType: 'image/png', size: 10,
    }],
  })
  const retainedReply = workspace.addMessage(group.id, 'agent', 'Remove with the topic', 'hermes', root.id)
  const topicStatus = workspace.addMessage(
    group.id,
    'system',
    'Topic stopped',
    '',
    root.id,
    { key: 'system.autoStopped', params: {} },
  )
  const otherRoot = workspace.addMessage(group.id, 'user', 'Keep this topic')
  const otherReply = workspace.addMessage(group.id, 'agent', 'Keep this reply', 'codex', otherRoot.id)

  assert.deepEqual(workspace.deleteMessage(group.id, reply.id), {
    deletedMessageIds: [reply.id],
  })
  let messages = workspace.snapshot().messages
  assert.equal(messages.some(message => message.id === reply.id), false)
  assert.equal(messages.some(message => message.id === retainedReply.id), true)
  assert.equal(new LocalWorkspace(options).snapshot().messages.some(message => message.id === reply.id), false)

  const deleted = workspace.deleteMessage(group.id, root.id)
  assert.deepEqual(new Set(deleted.deletedMessageIds), new Set([
    root.id, retainedReply.id, topicStatus.id,
  ]))
  messages = workspace.snapshot().messages
  assert.deepEqual(messages.map(message => message.id), [otherRoot.id, otherReply.id])
  assert.deepEqual(
    new LocalWorkspace(options).snapshot().messages.map(message => message.id),
    [otherRoot.id, otherReply.id],
  )
})

test('deleting a direct-chat user turn removes its inferred replies without touching later turns', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    conversationType: 'direct', directAgentKind: 'codex', agentKinds: ['codex'], workdir: directory,
  })
  const firstRoot = workspace.addMessage(group.id, 'user', 'First turn')
  const firstReply = workspace.addMessage(group.id, 'agent', 'First answer', 'codex')
  const firstFailure = workspace.addMessage(
    group.id,
    'system',
    'First failure',
    'codex',
    '',
    { key: 'system.agentCallFailed', params: { agent: 'Codex', reason: 'failed' } },
  )
  const secondRoot = workspace.addMessage(group.id, 'user', 'Second turn')
  const secondReply = workspace.addMessage(group.id, 'agent', 'Second answer', 'codex')

  const deleted = workspace.deleteMessage(group.id, firstRoot.id)

  assert.deepEqual(new Set(deleted.deletedMessageIds), new Set([
    firstRoot.id, firstReply.id, firstFailure.id,
  ]))
  assert.deepEqual(workspace.snapshot().messages.map(message => message.id), [secondRoot.id, secondReply.id])
  assert.deepEqual(
    new LocalWorkspace(options).snapshot().messages.map(message => message.id),
    [secondRoot.id, secondReply.id],
  )
})

test('message deletion rejects active, unknown, and cross-conversation targets', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const firstGroup = workspace.createGroup({
    name: 'First', agentKinds: ['codex'], workdir: directory,
  })
  const secondGroup = workspace.createGroup({
    name: 'Second', agentKinds: ['codex'], workdir: directory,
  })
  const firstMessage = workspace.addMessage(firstGroup.id, 'user', 'First message')
  const secondMessage = workspace.addMessage(secondGroup.id, 'user', 'Second message')

  assert.throws(
    () => workspace.deleteMessage(firstGroup.id, secondMessage.id),
    { message: 'LOCAL_MESSAGE_NOT_FOUND' },
  )
  assert.throws(
    () => workspace.deleteMessage(firstGroup.id, 'missing-message'),
    { message: 'LOCAL_MESSAGE_NOT_FOUND' },
  )

  workspace.activeRuns.set(
    firstGroup.id,
    workspace.createRunController('manual', ['codex'], firstMessage.id),
  )
  assert.throws(
    () => workspace.deleteMessage(firstGroup.id, firstMessage.id),
    { message: 'LOCAL_GROUP_RUNNING' },
  )
  workspace.activeRuns.delete(firstGroup.id)
  assert.equal(workspace.snapshot().messages.some(message => message.id === firstMessage.id), true)
})

test('WebP attachment metadata is accepted for image-capable Agents', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Unsupported image', agentKinds: ['codex'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Inspect',
    attachments: [{
      id: 'attachment-webp', name: 'preview.webp', mimeType: 'image/webp', size: 10,
    }],
  })
  assert.equal(calls.length, 1)
  assert.deepEqual(workspace.snapshot().messages.find(message => message.role === 'user').attachments, [{
    id: 'attachment-webp', name: 'preview.webp', mimeType: 'image/webp', size: 10,
  }])
})

test('generic file support delivers images to Agents without native image arguments', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const attachmentRoot = path.join(directory, 'attachments')
  fs.mkdirSync(attachmentRoot)
  fs.writeFileSync(path.join(attachmentRoot, 'attachment-1.png'), '0123456789')
  options.attachmentSupport = kind => ({
    image: options.imageAttachmentLimit(kind),
    file: 4,
  })
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const mixed = workspace.createGroup({
    name: 'Mixed image support', agentKinds: ['codex', 'workbuddy'], workdir: directory,
  })
  const first = { id: 'attachment-1', name: 'one.png', mimeType: 'image/png', size: 10 }

  await workspace.sendMessage({
    groupId: mixed.id,
    text: 'Inspect',
    targetKinds: ['codex', 'workbuddy'],
    attachments: [first],
  })

  const attachmentPath = path.join(attachmentRoot, 'attachment-1.png')
  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'workbuddy'])
  assert.deepEqual(calls.map(call => call.runOptions.attachments), [[attachmentPath], []])
  assert.doesNotMatch(calls[0].prompt, /\.meldwork-input/)
  assert.match(calls[1].prompt, /\.meldwork-input\/\.run-[^/]+\/1-one\.png/)
  assert.equal(fs.existsSync(path.join(directory, '.meldwork-input')), false)
  assert.equal(workspace.snapshot().messages.length, 3)
})

test('a failed run-start notification does not leave an active run behind', (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  const reservation = workspace.reserveRun('group-id', 'manual', ['codex'])
  reservation.taskId = 'thread-id'
  reservation.threadRootId = 'thread-id'
  reservation.contextPackId = `context-pack-${'a'.repeat(64)}`
  reservation.taskBound = true
  const failChanged = () => { throw new Error('listener failed') }
  workspace.on('changed', failChanged)

  assert.throws(
    () => workspace.beginRun(
      'group-id', 'manual', ['codex'], 'thread-id', reservation,
    ),
    { message: 'listener failed' },
  )
  workspace.off('changed', failChanged)
  workspace.releasePreparation('group-id', reservation)
  assert.deepEqual(workspace.snapshot().runningGroupIds, [])
})

test('manual send reserves its group throughout asynchronous attachment preflight', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const attachmentGate = deferred()
  options.resolveAttachments = async (refs) => {
    await attachmentGate.promise
    return refs.map(ref => ({
      ...ref,
      path: path.join(directory, 'attachments', `${ref.id}.png`),
    }))
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '预处理占位', agentKinds: ['codex'], workdir: directory,
  })
  const first = workspace.sendMessage({
    groupId: group.id,
    text: 'First',
    targetKinds: ['codex'],
    attachments: [{
      id: 'attachment-first', name: 'first.png', mimeType: 'image/png', size: 10,
    }],
  })

  assert.deepEqual(workspace.snapshot().runningGroupIds, [group.id])
  assert.deepEqual(workspace.snapshot().runs, [])
  await assert.rejects(
    workspace.sendMessage({ groupId: group.id, text: 'Second', targetKinds: ['codex'] }),
    { message: 'LOCAL_GROUP_RUNNING' },
  )
  assert.throws(
    () => workspace.updateGroup(group.id, { workdir: path.join(directory, 'other') }),
    { message: 'LOCAL_GROUP_RUNNING' },
  )
  assert.throws(
    () => workspace.deleteGroup(group.id),
    { message: 'LOCAL_GROUP_RUNNING' },
  )

  attachmentGate.resolve()
  await first

  assert.equal(calls.length, 1)
  assert.deepEqual(
    workspace.snapshot().messages.filter(message => message.role === 'user')
      .map(message => message.content),
    ['First'],
  )
  assert.deepEqual(workspace.snapshot().runningGroupIds, [])
})

test('automatic discussion cannot overtake a manual send in preflight', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const attachmentGate = deferred()
  options.resolveAttachments = async (refs) => {
    await attachmentGate.promise
    return refs.map(ref => ({
      ...ref,
      path: path.join(directory, 'attachments', `${ref.id}.png`),
    }))
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '发送与自动讨论互斥', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', 'Existing topic')
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Manual follow-up',
    targetKinds: ['codex'],
    attachments: [{
      id: 'attachment-follow-up', name: 'follow-up.png', mimeType: 'image/png', size: 10,
    }],
  })

  assert.throws(
    () => workspace.startAuto({ groupId: group.id, maxRounds: 2 }),
    { message: 'LOCAL_GROUP_RUNNING' },
  )
  attachmentGate.resolve()
  await send

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex'])
  assert.equal(workspace.snapshot().messages.some(message => (
    ['system.autoRoundLimit', 'system.autoTimeout'].includes(message.system?.key)
  )), false)
})

test('stopAll aborts an in-flight preflight and prevents it from launching an Agent', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const attachmentEntered = deferred()
  const attachmentGate = deferred()
  options.resolveAttachments = async (refs) => {
    attachmentEntered.resolve()
    await attachmentGate.promise
    return refs.map(ref => ({
      ...ref,
      path: path.join(directory, 'attachments', `${ref.id}.png`),
    }))
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '关闭时预处理', agentKinds: ['codex'], workdir: directory,
  })
  const send = workspace.sendMessage({
    groupId: group.id,
    text: 'Do not launch',
    targetKinds: ['codex'],
    attachments: [{
      id: 'attachment-shutdown', name: 'shutdown.png', mimeType: 'image/png', size: 10,
    }],
  })
  const stoppedSend = assert.rejects(send, { message: 'LOCAL_AGENT_EXECUTION_STOPPED' })
  await attachmentEntered.promise

  let shutdownComplete = false
  const shutdown = workspace.stopAll().then(() => { shutdownComplete = true })
  await Promise.all([stoppedSend, shutdown])

  assert.equal(shutdownComplete, true)
  assert.equal(calls.length, 0)
  assert.equal(workspace.snapshot().messages.length, 0)
  assert.deepEqual(workspace.snapshot().runningGroupIds, [])

  attachmentGate.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.length, 0)
  assert.equal(workspace.snapshot().messages.length, 0)
})

test('stop and stopAll bound preflight resolvers that ignore cancellation', async (t) => {
  const stages = ['attachment', 'skill', 'knowledge']
  const actions = ['stop', 'stopAll']
  for (const stage of stages) {
    for (const action of actions) {
      await t.test(`${action} during ${stage} preflight`, async (t) => {
        const { directory, calls, options } = fixture()
        t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
        const entered = deferred()
        const blocked = deferred()
        options.runAbortGraceMs = 100
        if (stage === 'attachment') {
          options.resolveAttachments = async () => {
            entered.resolve()
            return await blocked.promise
          }
        } else if (stage === 'skill') {
          options.validateSkillSelections = async () => {
            entered.resolve()
            return await blocked.promise
          }
        } else {
          options.validateKnowledgeBaseSelections = async () => {
            entered.resolve()
            return await blocked.promise
          }
        }
        const workspace = new LocalWorkspace(options)
        await workspace.refreshAgents()
        const group = workspace.createGroup({
          name: `${action} ${stage}`, agentKinds: ['codex'], workdir: directory,
        })
        const input = {
          groupId: group.id,
          text: 'Do not leave this Run preparing',
          targetKinds: ['codex'],
          ...(stage === 'attachment' ? {
            attachments: [{
              id: 'attachment-stuck', name: 'stuck.png', mimeType: 'image/png', size: 10,
            }],
          } : {}),
        }
        const send = workspace.sendMessage(input).then(
          value => ({ status: 'fulfilled', value }),
          error => ({ status: 'rejected', error }),
        )
        await entered.promise
        const controller = workspace.preparingRuns.get(group.id)
        assert.ok(controller)

        let stopPromise = Promise.resolve()
        if (action === 'stopAll') stopPromise = workspace.stopAll()
        else assert.equal(workspace.stop(group.id, controller.runId), true)
        let timer
        const completed = await Promise.race([
          Promise.all([send, controller.done, stopPromise]).then(([sendResult]) => sendResult),
          new Promise(resolve => {
            timer = setTimeout(() => resolve(null), options.runAbortGraceMs)
          }),
        ])
        if (timer) clearTimeout(timer)

        assert.ok(completed, `${action} did not settle ${stage} preflight within abort grace`)
        assert.equal(completed.status, 'rejected')
        assert.equal(completed.error?.message, 'LOCAL_AGENT_EXECUTION_STOPPED')
        assert.equal(workspace.preparingRuns.size, 0)
        assert.equal(workspace.activeRuns.size, 0)
        assert.equal(calls.length, 0)
        assert.equal(workspace.snapshot().messages.length, 0)
      })
    }
  }
})

test('stopAll records an in-flight Agent and its ledger checkpoint as interrupted', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const started = deferred()
  const checkpoints = []
  options.runAbortGraceMs = 20
  options.runLedger = {
    recoverInterrupted: () => [],
    list: () => [],
    checkpoint: record => checkpoints.push(structuredClone(record)),
    finish: () => {},
  }
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => await new Promise((
    _resolve, reject,
  ) => {
    started.resolve()
    if (runOptions.signal.aborted) {
      reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED'))
      return
    }
    runOptions.signal.addEventListener(
      'abort', () => reject(new Error('LOCAL_AGENT_EXECUTION_STOPPED')), { once: true },
    )
  })
  const finished = []
  const workspace = new LocalWorkspace(options)
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Shutdown trace', agentKinds: ['codex'], workdir: directory,
  })

  const send = workspace.sendMessage({
    groupId: group.id, text: 'Keep the shutdown evidence', targetKinds: ['codex'],
  })
  await started.promise
  await Promise.all([send, workspace.stopAll()])

  const interruption = workspace.snapshot().messages.find(message => (
    message.system?.key === 'system.agentInterrupted' && message.agentKind === 'codex'
  ))
  assert.equal(interruption.trace.status, 'interrupted')
  assert.equal(finished[0].status, 'interrupted')
  const terminalCheckpoint = checkpoints.findLast(record => record.status === 'interrupted')
  assert.equal(terminalCheckpoint.agentRuns[0].status, 'interrupted')
})

test('a stale controller cannot clear a newer active run for the same group', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  const first = workspace.createRunController('manual', ['codex'], '')
  const second = workspace.createRunController('manual', ['hermes'], '')
  workspace.activeRuns.set('group-id', first)
  workspace.activeRuns.set('group-id', second)

  await workspace.finishRun('group-id', first, 'completed')
  assert.equal(workspace.activeRuns.get('group-id'), second)

  await workspace.finishRun('group-id', second, 'stopped')
  assert.equal(workspace.activeRuns.has('group-id'), false)
})

test('run-finished listener failures do not change a completed manual result', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Best effort event', agentKinds: ['codex'], workdir: directory,
  })
  workspace.on('run-finished', () => { throw new Error('listener failed') })

  await assert.doesNotReject(workspace.sendMessage({
    groupId: group.id,
    text: 'Complete despite notification failure',
    targetKinds: ['codex'],
  }))

  assert.deepEqual(workspace.snapshot().runningGroupIds, [])
  assert.equal(
    workspace.snapshot().messages.some(message => message.agentKind === 'codex'),
    true,
  )
})

test('workspace loading allowlists local group and message fields', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '',
    icon: 'legacy-icon',
    agentKinds: ['codex'],
    workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Local topic',
    targetKinds: ['codex'],
    contextMessages: [{ sender: 'Remote participant', text: 'REMOTE_ONLY_MARKER' }],
  })

  assert.equal(group.name, '')
  assert.equal('icon' in group, false)
  assert.doesNotMatch(calls[0].prompt, /REMOTE_ONLY_MARKER|Remote participant/)

  const stored = JSON.parse(fs.readFileSync(options.storagePath, 'utf8'))
  stored.groups[0].icon = 'legacy-icon'
  stored.groups[0].channelId = 'remote-channel'
  stored.groups[0].participants = [{ type: 'human', id: 'remote-user' }]
  stored.messages[0].emoji = 'legacy-reaction'
  stored.messages[0].reactions = [{ name: 'thumbs-up' }]
  stored.messages[0].sticker = { id: 'legacy-sticker' }
  stored.messages[0].attachments = [{
    id: 'attachment-safe',
    name: 'diagram.png',
    mimeType: 'image/png',
    size: 128,
    path: '/private/attachment.png',
    previewDataUrl: 'data:image/png;base64,private',
  }]
  stored.messages[0].skillHints = [{
    targetKind: 'codex',
    namespace: 'global',
    slug: 'review',
    name: 'Review',
    path: '/private/SKILL.md',
  }]
  stored.messages[0].targetKinds = ['codex', 'unknown-agent', 'codex']
  stored.messages[1].elapsedMs = 12.4
  stored.messages[1].toolCalls = [
    ...Array.from({ length: 8 }, () => ({ title: 'write_file', status: 'completed' })),
    { title: '/private/tool-output', status: 'unknown' },
  ]
  stored.messages[1].executable = '/private/agent'
  stored.remoteChannels = [{ id: 'remote-channel' }]
  fs.writeFileSync(options.storagePath, `${JSON.stringify(stored)}\n`)
  const restored = new LocalWorkspace(options)
  const restoredSnapshot = restored.snapshot()
  for (const key of ['icon', 'channelId', 'participants']) {
    assert.equal(key in restoredSnapshot.groups[0], false)
  }
  for (const key of ['emoji', 'reactions', 'sticker']) {
    assert.equal(key in restoredSnapshot.messages[0], false)
  }
  assert.deepEqual(restoredSnapshot.messages[0].attachments, [{
    id: 'attachment-safe', name: 'diagram.png', mimeType: 'image/png', size: 128,
  }])
  assert.deepEqual(restoredSnapshot.messages[0].skillHints, [{
    targetKind: 'codex', namespace: 'global', slug: 'review', name: 'Review',
  }])
  assert.deepEqual(restoredSnapshot.messages[0].targetKinds, ['codex'])
  assert.equal(restoredSnapshot.messages[1].elapsedMs, 12)
  assert.equal(restoredSnapshot.messages[1].toolCalls.length, 8)
  assert.deepEqual(restoredSnapshot.messages[1].toolCalls.at(-1), {
    title: 'process', status: 'completed',
  })
  assert.equal('executable' in restoredSnapshot.messages[1], false)
  assert.equal(JSON.stringify(restoredSnapshot).includes('/private/'), false)
  assert.equal(JSON.stringify(restoredSnapshot).includes('previewDataUrl'), false)
  assert.equal('remoteChannels' in restored.state, false)
})

test('direct conversations force manual mode and reuse their group Agent session', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const direct = workspace.createGroup({
    name: 'Codex', workdir: directory,
    agentKinds: ['codex', 'hermes'],
    conversationType: 'direct', directAgentKind: 'codex',
  })

  await workspace.sendMessage({ groupId: direct.id, text: '第一条', mode: 'auto', maxRounds: 10 })
  await workspace.sendMessage({ groupId: direct.id, text: '第二条' })

  assert.deepEqual(direct.agentKinds, ['codex'])
  assert.equal(direct.conversationType, 'direct')
  assert.equal(direct.directAgentKind, 'codex')
  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'codex'])
  assert.deepEqual(calls.map(call => call.runOptions.sessionRef), ['', 'codex-session'])
  assert.equal(calls.some(call => call.prompt.includes('MELDWORK_CONSENSUS')), false)
  assert.equal(workspace.snapshot().messages.some(message => message.threadRootId), false)
  const restored = new LocalWorkspace(options)
  assert.deepEqual(restored.snapshot().groups[0], direct)
})

test('writable conversations persist validated Agent media outputs and enforce the delivery contract', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const captureCalls = []
  const importCalls = []
  const generated = [
    { id: 'generated-image', name: 'poster.png', mimeType: 'image/png', size: 128 },
    { id: 'generated-audio', name: 'briefing.mp3', mimeType: 'audio/mpeg', size: 256 },
    { id: 'generated-video', name: 'demo.mp4', mimeType: 'video/mp4', size: 512 },
  ]
  options.captureAgentOutputs = async (workdir) => {
    captureCalls.push(workdir)
    return { marker: 'before-run' }
  }
  options.importAgentOutputs = async (input) => {
    importCalls.push(input)
    return generated
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const direct = workspace.createGroup({
    name: 'Codex media', workdir: directory, allowWrite: true,
    conversationType: 'direct', directAgentKind: 'codex', agentKinds: ['codex'],
  })

  await workspace.sendMessage({ groupId: direct.id, text: '生成一张图、一段音频和一个视频' })

  assert.deepEqual(captureCalls, [directory])
  assert.equal(importCalls.length, 1)
  assert.equal(importCalls[0].workdir, directory)
  assert.deepEqual(importCalls[0].baseline, { marker: 'before-run' })
  assert.equal(Number.isFinite(importCalls[0].startedAt), true)
  assert.match(calls[0].prompt, /\.meldwork-output\//)
  assert.match(calls[0].prompt, /do not claim it was generated unless a real file exists/i)
  const reply = workspace.snapshot().messages.find(message => message.role === 'agent')
  assert.deepEqual(reply.attachments, generated)
  assert.equal(JSON.stringify(reply).includes(directory), false)

  const restored = new LocalWorkspace(options)
  const restoredReply = restored.snapshot().messages.find(message => message.role === 'agent')
  assert.deepEqual(restoredReply.attachments, generated)
})

test('every writable built-in conversational Agent owns media execution and retains imported outputs', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const kinds = [
    'codex', 'hermes', 'openclaw', 'workbuddy', 'pi', 'kimi',
    'mimo', 'claude', 'gemini', 'opencode', 'qwen',
  ]
  options.detectAgents = async () => kinds.map((kind, index) => ({
    kind,
    name: `${kind} CLI`,
    executable: `/tmp/${kind}`,
    version: String(index + 1),
  }))
  const requests = [
    { type: 'image', prompt: '请生成一张日出山谷图片', extension: 'png', mimeType: 'image/png' },
    { type: 'audio', prompt: '请生成一段日出山谷旁白音频', extension: 'wav', mimeType: 'audio/wav' },
    { type: 'video', prompt: '请生成一段日出山谷短视频', extension: 'mp4', mimeType: 'video/mp4' },
  ]
  const generationCalls = []
  let generated = null
  let activeRequest
  options.generateMedia = async input => { generationCalls.push(input); throw new Error('UNEXPECTED_MEDIA_DISPATCH') }
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    const request = activeRequest
    assert.ok(prompt.includes(request.prompt))
    generated = {
      id: `generated-${agent.kind}-${request.type}`,
      name: `generated-${request.type}-${agent.kind}.${request.extension}`,
      mimeType: request.mimeType,
      size: 128,
    }
    return { outcome: 'completed', text: `Created ${generated.name}.` }
  }
  options.captureAgentOutputs = async () => ({ marker: 'before-media' })
  options.importAgentOutputs = async () => generated ? [{ ...generated }] : []
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  for (const kind of kinds) {
    const direct = workspace.createGroup({
      name: `${kind} media`, workdir: directory, allowWrite: true,
      conversationType: 'direct', directAgentKind: kind, agentKinds: [kind],
    })
    for (const request of requests) {
      activeRequest = request
      await workspace.sendMessage({ groupId: direct.id, text: request.prompt })
    }
  }

  assert.equal(generationCalls.length, 0)
  assert.equal(calls.length, kinds.length * requests.length)
  assert.equal(calls.some(call => /Meldwork generated and will attach/.test(call.prompt)), false)
  const replies = workspace.snapshot().messages.filter(message => message.role === 'agent')
  assert.equal(replies.length, kinds.length * requests.length)
  assert.deepEqual(replies.map(reply => reply.attachments?.[0]?.mimeType), kinds.flatMap(() => (
    requests.map(request => request.mimeType)
  )))
})

test('targeted group Agents retain native media outputs without shared Provider dispatch', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const kinds = [
    'codex', 'hermes', 'openclaw', 'workbuddy', 'pi', 'kimi',
    'mimo', 'claude', 'gemini', 'opencode', 'qwen',
  ]
  options.detectAgents = async () => kinds.map((kind, index) => ({
    kind,
    name: `${kind} CLI`,
    executable: `/tmp/${kind}`,
    version: String(index + 1),
  }))
  const requests = [
    { type: 'image', prompt: 'Generate a group image preview', extension: 'png', mimeType: 'image/png' },
    { type: 'audio', prompt: 'Generate a group audio preview', extension: 'wav', mimeType: 'audio/wav' },
    { type: 'video', prompt: 'Generate a group video preview', extension: 'mp4', mimeType: 'video/mp4' },
  ]
  let generated = null
  options.captureAgentOutputs = async () => ({ marker: 'before-group-run' })
  options.importAgentOutputs = async () => generated ? [{ ...generated }] : []
  const generationCalls = []
  options.generateMedia = async input => { generationCalls.push(input); throw new Error('UNEXPECTED_MEDIA_DISPATCH') }
  let activeRequest
  options.runAgent = async (agent, prompt) => {
    const request = activeRequest
    assert.ok(prompt.includes(request.prompt))
    generated = {
      id: `group-${agent.kind}-${request.type}`,
      name: `group-${request.type}-${agent.kind}.${request.extension}`,
      mimeType: request.mimeType,
      size: 128,
    }
    return { outcome: 'completed', text: `Created ${generated.name}.` }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Media group', workdir: directory, allowWrite: true, conversationType: 'group',
    agentKinds: kinds,
  })

  for (const kind of kinds) {
    for (const request of requests) {
      activeRequest = request
      await workspace.sendMessage({
        groupId: group.id,
        text: request.prompt,
        targetKinds: [kind],
        mode: 'manual',
      })
    }
  }

  assert.equal(generationCalls.length, 0)
  const replies = workspace.snapshot().messages.filter(message => message.role === 'agent')
  assert.equal(replies.length, kinds.length * requests.length)
  assert.deepEqual(replies.map(reply => reply.agentKind), kinds.flatMap(kind => (
    requests.map(() => kind)
  )))
  assert.deepEqual(replies.map(reply => reply.attachments?.[0]?.mimeType), kinds.flatMap(() => (
    requests.map(request => request.mimeType)
  )))
  assert.equal(JSON.stringify(replies).includes(directory), false)
})

test('unavailable shared media Providers do not interfere with targeted Agent execution', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const generated = {
    id: 'native-agent-image', name: 'native-agent-image.png', mimeType: 'image/png', size: 128,
  }
  const error = new Error('MEDIA_GENERATION_MODEL_UNAVAILABLE')
  error.code = 'MEDIA_GENERATION_MODEL_UNAVAILABLE'
  options.generateMedia = async () => { throw error }
  options.captureAgentOutputs = async () => ({ marker: 'before-native-media' })
  options.importAgentOutputs = async () => [generated]
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Native media fallback', workdir: directory, allowWrite: true,
    conversationType: 'group', agentKinds: ['codex', 'hermes'],
  })

  await workspace.sendMessage({
    groupId: group.id, text: '请生成一张赛博朋克城市图片',
    targetKinds: ['codex'], mode: 'manual',
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].agent.kind, 'codex')
  assert.doesNotMatch(calls[0].prompt, /shared media generator was unavailable/i)
  assert.match(calls[0].prompt, /\.meldwork-output\//)
  const reply = workspace.snapshot().messages.find(message => message.role === 'agent')
  assert.deepEqual(reply.attachments, [generated])
  assert.equal(workspace.snapshot().messages.some(message => (
    message.role === 'system' && /MEDIA_GENERATION_MODEL_UNAVAILABLE/.test(message.content)
  )), false)
})

test('Agent media failure prose remains unchanged and cannot trigger a second Provider call', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const generated = {
    id: 'recovered-group-video', name: 'recovered-group-video.mp4', mimeType: 'video/mp4', size: 128,
  }
  let generationCount = 0
  options.generateMedia = async (input) => {
    generationCount += 1
    if (generationCount === 1) {
      const error = new Error('MEDIA_GENERATION_MODEL_UNAVAILABLE')
      error.code = 'MEDIA_GENERATION_MODEL_UNAVAILABLE'
      throw error
    }
    input.onEvent({
      id: 'media-recovered',
      type: 'tool_result_summary',
      status: 'completed',
      title: 'video_generation',
    })
    return { type: 'video', filename: generated.name }
  }
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: 'Codex failed: The configured Providers do not offer the required media model. Use a Provider credential with access to that image, audio, or video model.',
      sessionRef: runOptions.sessionRef || 'codex-session',
      outcome: 'completed',
    }
  }
  options.captureAgentOutputs = async () => ({ marker: 'before-recovery' })
  options.importAgentOutputs = async () => (generationCount >= 2 ? [generated] : [])
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Recovered group media', workdir: directory, allowWrite: true,
    conversationType: 'group', agentKinds: ['codex', 'hermes'],
  })

  await workspace.sendMessage({
    groupId: group.id,
    text: 'Generate a short product demo video',
    targetKinds: ['codex'],
    mode: 'manual',
  })

  assert.equal(generationCount, 0)
  assert.equal(calls.length, 1)
  const reply = workspace.snapshot().messages.find(message => message.role === 'agent')
  assert.equal(reply.content, 'Codex failed: The configured Providers do not offer the required media model. Use a Provider credential with access to that image, audio, or video model.')
  assert.equal(reply.attachments?.length || 0, 0)
})

test('direct media requests go to the native Agent without a shared Provider prerequisite', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const generated = {
    id: 'native-direct-image', name: 'native-direct-image.png', mimeType: 'image/png', size: 128,
  }
  const error = new Error('MEDIA_GENERATION_MODEL_UNAVAILABLE')
  error.code = 'MEDIA_GENERATION_MODEL_UNAVAILABLE'
  options.generateMedia = async () => { throw error }
  options.captureAgentOutputs = async () => ({ marker: 'before-native-media' })
  options.importAgentOutputs = async () => [generated]
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const direct = workspace.createGroup({
    name: 'Native direct media fallback', workdir: directory, allowWrite: true,
    conversationType: 'direct', directAgentKind: 'hermes', agentKinds: ['hermes'],
  })

  await workspace.sendMessage({
    groupId: direct.id, text: '请生成一张赛博朋克城市图片',
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].agent.kind, 'hermes')
  assert.doesNotMatch(calls[0].prompt, /shared media generator was unavailable/i)
  assert.match(calls[0].prompt, /\.meldwork-output\//)
  const reply = workspace.snapshot().messages.find(message => message.role === 'agent')
  assert.deepEqual(reply.attachments, [generated])
  assert.equal(workspace.snapshot().messages.some(message => (
    message.role === 'system' && /MEDIA_GENERATION_MODEL_UNAVAILABLE/.test(message.content)
  )), false)
})

test('new direct and group conversations default to workspace-write permission', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()

  const group = workspace.createGroup({
    name: 'Default writable group', agentKinds: ['codex'], workdir: directory,
  })
  const direct = workspace.createGroup({
    conversationType: 'direct', directAgentKind: 'hermes', agentKinds: ['hermes'], workdir: directory,
  })
  const readOnly = workspace.createGroup({
    name: 'Explicit read only', agentKinds: ['codex'], workdir: directory, allowWrite: false,
  })

  assert.equal(group.allowWrite, true)
  assert.equal(direct.allowWrite, true)
  assert.equal(readOnly.allowWrite, false)
})

test('read-only conversations forbid false media claims and do not scan for generated files', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let captureCount = 0
  let importCount = 0
  let generationCount = 0
  options.captureAgentOutputs = async () => { captureCount += 1; return {} }
  options.importAgentOutputs = async () => { importCount += 1; return [] }
  options.generateMedia = async () => { generationCount += 1; return { filename: 'unexpected.png' } }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const direct = workspace.createGroup({
    name: 'Read only Codex', workdir: directory,
    conversationType: 'direct', directAgentKind: 'codex', agentKinds: ['codex'],
    allowWrite: false,
  })

  await workspace.sendMessage({ groupId: direct.id, text: '生成图片' })

  assert.equal(captureCount, 0)
  assert.equal(importCount, 0)
  assert.equal(generationCount, 0)
  assert.match(calls[0].prompt, /read-only/i)
  assert.match(calls[0].prompt, /do not claim that a media file was generated/i)
})

test('Gemini and OpenCode messages keep their Agent names', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Agent names', agentKinds: ['codex'], workdir: directory,
  })

  workspace.addMessage(group.id, 'agent', 'Gemini reply', 'gemini')
  workspace.addMessage(group.id, 'agent', 'OpenCode reply', 'opencode')

  assert.deepEqual(
    workspace.snapshot().messages.map(message => message.senderName),
    ['Gemini', 'OpenCode'],
  )
})

test('group messages create distinct task roots while reusing one native session', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '会话测试', agentKinds: ['codex', 'hermes', 'workbuddy'], workdir: directory,
  })
  await workspace.sendMessage({ groupId: group.id, text: '第一条', targetKinds: ['codex'] })
  const firstRoot = workspace.snapshot().messages[0]
  await workspace.sendMessage({
    groupId: group.id, text: '第二条', targetKinds: ['codex'], threadRootId: firstRoot.id,
  })

  const userMessages = workspace.snapshot().messages.filter(message => message.role === 'user')
  const agentMessages = workspace.snapshot().messages.filter(message => message.role === 'agent')
  assert.equal(userMessages.length, 2)
  assert.equal(userMessages.every(message => !message.threadRootId), true)
  assert.notEqual(userMessages[0].id, userMessages[1].id)
  assert.deepEqual(agentMessages.map(message => message.threadRootId), userMessages.map(message => message.id))
  assert.deepEqual(calls.map(call => call.runOptions.sessionRef), ['', 'codex-session'])
  const key = workspace.sessionKey(group.id, 'codex')
  assert.deepEqual(workspace.state.sessions, { [key]: 'codex-session' })
  const restarted = new LocalWorkspace(options)
  await restarted.refreshAgents()
  await restarted.sendMessage({ groupId: group.id, text: '第三条', targetKinds: ['codex'] })
  assert.equal(calls.at(-1).runOptions.sessionRef, 'codex-session')
  assert.deepEqual(restarted.state.sessions, { [key]: 'codex-session' })
})

test('a new targeted group task reuses its conversation Session and stays authoritative', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Task isolation', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const oldRoot = workspace.addMessage(group.id, 'user', 'OLD_RESEARCH_TASK: 调研 GEO 市场并继续撰写报告')
  workspace.addMessage(group.id, 'agent', 'OLD_RESEARCH_CONCLUSION', 'codex', oldRoot.id)
  const globalKey = workspace.sessionKey(group.id, 'codex')
  workspace.state.sessions[globalKey] = 'legacy-shared-session'
  workspace.state.sessionMeta[globalKey] = { turns: 8, estimatedChars: 12000 }
  workspace.save()

  await workspace.sendMessage({
    groupId: group.id,
    text: 'NEW_IMAGE_TASK: 请生成一张未来城市海报',
    targetKinds: ['codex'],
    mode: 'manual',
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].runOptions.sessionRef, 'legacy-shared-session')
  assert.match(calls[0].prompt, /Current user task \(authoritative\):\nNEW_IMAGE_TASK/)
  assert.match(calls[0].prompt, /older group messages and conclusions as reference only/i)
  assert.match(calls[0].prompt, /Final response scope:[\s\S]*Do not append an answer to an older task/)
  assert.ok(calls[0].prompt.lastIndexOf('Final response scope:') > calls[0].prompt.lastIndexOf('OLD_RESEARCH_TASK'))
  assert.doesNotMatch(calls[0].prompt, /Continue this group Session/)
  assert.equal(Object.hasOwn(workspace.state.sessions, globalKey), true)
})

test('a targeted group image task preserves task authority and native output import', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const generationCalls = []
  options.generateMedia = async (input) => {
    generationCalls.push(input)
    return { type: 'image', filename: 'new-city-poster.png' }
  }
  options.captureAgentOutputs = async () => ({ marker: 'before-targeted-image' })
  options.importAgentOutputs = async () => ([
    { id: 'new-city-poster', name: 'new-city-poster.png', mimeType: 'image/png', size: 128 },
  ])
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Targeted media isolation', agentKinds: ['codex', 'hermes'], workdir: directory,
    allowWrite: true,
  })
  const oldRoot = workspace.addMessage(group.id, 'user', 'OLD_RESEARCH_TASK: 调研 GEO 市场')
  workspace.addMessage(group.id, 'agent', 'OLD_RESEARCH_CONCLUSION', 'codex', oldRoot.id)
  const legacyKey = workspace.sessionKey(group.id, 'hermes')
  workspace.state.sessions[legacyKey] = 'legacy-hermes-research-session'
  workspace.state.sessionMeta[legacyKey] = { turns: 6, estimatedChars: 8000 }
  workspace.save()

  await workspace.sendMessage({
    groupId: group.id,
    text: 'NEW_IMAGE_TASK: 请生成一张未来城市海报',
    targetKinds: ['hermes'],
    mode: 'manual',
  })

  assert.equal(generationCalls.length, 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].agent.kind, 'hermes')
  assert.equal(calls[0].runOptions.sessionRef, 'legacy-hermes-research-session')
  assert.match(calls[0].prompt, /Current user task \(authoritative\):\nNEW_IMAGE_TASK/)
  assert.doesNotMatch(calls[0].prompt, /Meldwork generated and will attach/)
  assert.match(calls[0].prompt, /Final response scope:[\s\S]*Do not append an answer to an older task/)
  assert.ok(calls[0].prompt.lastIndexOf('Final response scope:') > calls[0].prompt.lastIndexOf('OLD_RESEARCH_TASK'))
  assert.doesNotMatch(calls[0].prompt, /Continue this group Session/)
  assert.equal(Object.hasOwn(workspace.state.sessions, legacyKey), true)
  const reply = workspace.snapshot().messages.find(message => (
    message.role === 'agent' && message.threadRootId && message.agentKind === 'hermes'
  ))
  assert.deepEqual(reply.attachments, [
    { id: 'new-city-poster', name: 'new-city-poster.png', mimeType: 'image/png', size: 128 },
  ])
})

test('every built-in conversational Agent retains its group Session for a newly targeted task', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const kinds = [
    'codex', 'hermes', 'openclaw', 'workbuddy', 'pi', 'kimi',
    'mimo', 'claude', 'gemini', 'opencode', 'qwen',
  ]
  options.detectAgents = async () => kinds.map((kind, index) => ({
    kind,
    name: `${kind} CLI`,
    executable: `/tmp/${kind}`,
    version: String(index + 1),
  }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'All Agent task isolation', agentKinds: kinds, workdir: directory,
  })

  for (const kind of kinds) {
    const globalKey = workspace.sessionKey(group.id, kind)
    workspace.state.sessions[globalKey] = `legacy-${kind}-session`
    workspace.state.sessionMeta[globalKey] = { turns: 4, estimatedChars: 4000 }
    await workspace.sendMessage({
      groupId: group.id,
      text: `NEW_${kind.toUpperCase()}_TASK: answer only this task`,
      targetKinds: [kind],
      mode: 'manual',
    })
    assert.equal(Object.hasOwn(workspace.state.sessions, globalKey), true, kind)
  }

  assert.deepEqual(calls.map(call => call.agent.kind), kinds)
  for (const call of calls) {
    if (call.agent.kind === 'openclaw') {
      assert.match(
        call.runOptions.sessionRef,
        /^agent:main:desktop-meldwork-[a-f0-9]{20}-openclaw$/,
      )
    } else {
      assert.equal(call.runOptions.sessionRef, `legacy-${call.agent.kind}-session`, call.agent.kind)
    }
  }
  for (const [index, call] of calls.entries()) {
    assert.match(
      call.prompt,
      new RegExp(`Current user task \\(authoritative\\):\\nNEW_${kinds[index].toUpperCase()}_TASK`),
    )
    assert.doesNotMatch(call.prompt, /Continue this group Session/)
  }
})

test('group sessions migrate the current or most recent legacy root per Agent', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: `${agent.kind} agrees\n[[MELDWORK_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '旧会话迁移', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const oldestRoot = workspace.addMessage(group.id, 'user', '最早旧话题')
  const currentRoot = workspace.addMessage(group.id, 'user', '当前旧话题')
  const recentRoot = workspace.addMessage(group.id, 'user', '最近活跃话题')
  workspace.addMessage(group.id, 'agent', '最近活跃话题结论', 'hermes', recentRoot.id)
  workspace.state.sessions[`${group.id}:codex:thread:${recentRoot.id}`] = 'codex-recent-root'
  workspace.state.sessions[`${group.id}:codex:thread:${currentRoot.id}`] = 'codex-current-root'
  workspace.state.sessions[`${group.id}:hermes:thread:orphan-root`] = 'hermes-orphan-root'
  workspace.state.sessions[`${group.id}:hermes:thread:${oldestRoot.id}`] = 'hermes-oldest-root'
  workspace.state.sessions[`${group.id}:hermes:thread:${recentRoot.id}`] = 'hermes-recent-root'
  workspace.save()

  workspace.startAuto({ groupId: group.id, threadRootId: currentRoot.id, maxRounds: 1 })
  await workspace.activeRuns.get(group.id).promise

  assert.deepEqual(calls.map(call => call.runOptions.sessionRef), [
    'codex-current-root', 'hermes-recent-root',
  ])
  assert.equal(calls.every(call => call.prompt.includes('最近活跃话题结论')), true)
  assert.equal(
    workspace.state.sessions[workspace.sessionKey(group.id, 'codex')],
    'codex-current-root',
  )
  assert.equal(
    workspace.state.sessions[workspace.sessionKey(group.id, 'hermes')],
    'hermes-recent-root',
  )
  assert.equal(
    Object.hasOwn(workspace.state.sessions, `${group.id}:codex:thread:${currentRoot.id}`),
    false,
  )
  assert.equal(
    workspace.state.sessions[`${group.id}:hermes:thread:${recentRoot.id}`],
    undefined,
  )
  assert.doesNotMatch(JSON.stringify(workspace.snapshot()), /sessionRef|codex-current-root|hermes-recent-root/)
})

test('legacy GEO sessions survive across automatic rounds and subsequent user tasks', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: `${agent.kind} completed the GEO turn\n[[MELDWORK_CONSENSUS:agree]]`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-group-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Test', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const intro = workspace.addMessage(group.id, 'user', '你们好，互相介绍下自己吧')
  workspace.addMessage(group.id, 'agent', 'Codex 自我介绍', 'codex', intro.id)
  workspace.addMessage(group.id, 'agent', 'Hermes 自我介绍', 'hermes', intro.id)
  const task = workspace.addMessage(
    group.id,
    'user',
    '这是一个 GEO 调研任务，请结合各自特点分配岗位并开始。',
  )
  workspace.addMessage(group.id, 'agent', 'Codex 负责技术与证据研究', 'codex', task.id)
  workspace.addMessage(group.id, 'agent', 'Hermes 负责市场与内容策略', 'hermes', task.id)
  const scope = workspace.addMessage(
    group.id,
    'user',
    '通用课题，海外为主，目标是培养商业和市场洞悉力并完成行业摸底。',
  )
  workspace.state.sessions[`${group.id}:codex:thread:${task.id}`] = 'codex-old-task'
  workspace.state.sessions[`${group.id}:codex:thread:${scope.id}`] = 'codex-old-scope'
  workspace.state.sessions[`${group.id}:hermes:thread:${task.id}`] = 'hermes-old-task'
  workspace.state.sessions[`${group.id}:hermes:thread:${scope.id}`] = 'hermes-old-scope'
  workspace.save()

  const firstFinished = new Promise(resolve => workspace.once('run-finished', resolve))
  const first = await workspace.sendMessage({
    groupId: group.id,
    text: '你们自己讨论吧，等干完了再跟我说。',
    mode: 'auto',
    maxRounds: 2,
  })
  await firstFinished
  const secondFinished = new Promise(resolve => workspace.once('run-finished', resolve))
  const second = await workspace.sendMessage({
    groupId: group.id,
    text: '继续完成上面的 GEO 调研，不要重新询问任务。',
    mode: 'auto',
    maxRounds: 2,
  })
  await secondFinished

  assert.ok(first.threadRootId)
  assert.ok(second.threadRootId)
  assert.notEqual(first.threadRootId, second.threadRootId)
  assert.deepEqual(calls.map(call => call.runOptions.sessionRef), [
    'codex-old-scope', 'hermes-old-scope', 'codex-old-scope', 'hermes-old-scope',
  ])
  assert.equal(calls.every(call => call.prompt.includes('GEO 调研任务')), true)
  assert.equal(calls.every(call => call.prompt.includes('海外为主')), true)
  assert.equal(calls.every(call => call.prompt.includes('商业和市场洞悉力')), true)
  assert.equal(
    workspace.state.sessions[workspace.sessionKey(group.id, 'codex')],
    'codex-old-scope',
  )
  assert.equal(
    workspace.state.sessions[workspace.sessionKey(group.id, 'hermes')],
    'hermes-old-scope',
  )
  assert.equal(workspace.state.sessions[`${group.id}:codex:thread:${scope.id}`], undefined)
  assert.equal(workspace.state.sessions[`${group.id}:hermes:thread:${scope.id}`], undefined)
})

test('prompts retain bounded topic and stable user turns plus group-wide final messages', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '全群上下文',
    topic: `GEO 产品定位 ${'T'.repeat(240)} TOPIC_TAIL_SHOULD_BE_BOUNDED`,
    agentKinds: ['codex', 'hermes'],
    workdir: directory,
  })
  workspace.addMessage(group.id, 'user', '问候：请使用中文')
  workspace.addMessage(group.id, 'user', 'GEO 任务：分析检索可见性')
  workspace.addMessage(group.id, 'user', '补充约束：不引入云端存储')
  for (let index = 0; index < 20; index += 1) {
    workspace.addMessage(group.id, 'agent', `已持久化的最终正文 ${index}`, index % 2 ? 'hermes' : 'codex', `old-root-${index}`, null, {
      elapsedMs: 12,
      toolCalls: [{ title: 'write_file', status: 'completed' }],
    })
  }
  workspace.addMessage(
    group.id,
    'system',
    'PROCESS_METADATA_SHOULD_NOT_REACH_AGENT',
    '',
    'old-root-19',
    { key: 'system.agentCallFailed', params: { reason: 'private' } },
  )

  await workspace.sendMessage({
    groupId: group.id,
    text: '当前新指令：给出最终建议',
    targetKinds: ['codex'],
  })

  const prompt = calls.at(-1).prompt
  assert.match(prompt, /Group topic: GEO 产品定位/)
  assert.doesNotMatch(prompt, /TOPIC_TAIL_SHOULD_BE_BOUNDED/)
  assert.match(prompt, /问候：请使用中文/)
  assert.match(prompt, /GEO 任务：分析检索可见性/)
  assert.match(prompt, /补充约束：不引入云端存储/)
  assert.match(prompt, /当前新指令：给出最终建议/)
  assert.equal(prompt.match(/当前新指令：给出最终建议/g)?.length, 1)
  assert.match(prompt, /Hermes: 已持久化的最终正文 19/)
  assert.doesNotMatch(prompt, /PROCESS_METADATA_SHOULD_NOT_REACH_AGENT|write_file|elapsedMs/)
})

test('continued group sessions receive bounded shared conclusions from earlier tasks', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: `${agent.kind} final ${calls.length}`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
    }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '增量上下文', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  await workspace.sendMessage({
    groupId: group.id, text: '第一条稳定约束', targetKinds: ['codex', 'hermes'],
  })
  await workspace.sendMessage({
    groupId: group.id, text: '第二条当前任务', targetKinds: ['codex'],
  })
  await workspace.sendMessage({
    groupId: group.id, text: '第三条继续任务', targetKinds: ['codex'],
  })

  assert.deepEqual(calls.map(call => call.runOptions.sessionRef), [
    '', '', 'codex-session', 'codex-session',
  ])
  assert.match(calls[1].prompt, /Current user task \(authoritative\):\n第一条稳定约束/)
  assert.match(calls[1].prompt, /Codex: codex final 1/)
  assert.match(calls[2].prompt, /Hermes: hermes final 2/)
  assert.doesNotMatch(calls[2].prompt, /Codex: codex final 1/)
  assert.match(calls[2].prompt, /Stable constraints:\n[\s\S]*第一条稳定约束/)
  assert.match(calls[2].prompt, /Current user task \(authoritative\):\n第二条当前任务/)
  assert.equal(calls[2].prompt.match(/第二条当前任务/g)?.length, 1)
  assert.match(calls[3].prompt, /Current user task \(authoritative\):\n第三条继续任务/)
  assert.equal(calls[3].prompt.match(/第三条继续任务/g)?.length, 1)
  assert.doesNotMatch(calls[3].prompt, /Hermes: hermes final 2/)
  assert.doesNotMatch(calls[3].prompt, /Codex: codex final 3/)
})

test('Harness continuation context stays bounded while retaining the latest shared conclusion', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '上下文预算', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  workspace.addMessage(group.id, 'user', '稳定约束：必须保留最新结论')
  for (let index = 0; index < 30; index += 1) {
    workspace.addMessage(
      group.id,
      'agent',
      `共享结论 ${index} ${'x'.repeat(1500)}`,
      index % 2 ? 'hermes' : 'codex',
      'budget-root',
    )
  }

  const packed = workspace.packedPromptContext(group.id)

  assert.ok(packed.continuationText.length <= 6100)
  assert.match(packed.continuationText, /共享结论 29/)
  assert.equal(packed.currentTaskText, '稳定约束：必须保留最新结论')
  assert.doesNotMatch(packed.continuationText, /共享结论 0 /)
})

test('Kimi and OpenClaw retain native sessions within a group and isolate different groups', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const first = workspace.createGroup({
    name: '会话 A', agentKinds: ['kimi', 'openclaw'], workdir: directory, allowWrite: true,
  })
  const second = workspace.createGroup({
    name: '会话 B', agentKinds: ['openclaw'], workdir: directory,
  })

  await workspace.sendMessage({ groupId: first.id, text: 'Kimi 1', targetKinds: ['kimi'] })
  const firstRoot = workspace.snapshot().messages[0].id
  const openClawKey = workspace.sessionKey(first.id, 'openclaw')
  workspace.state.sessions[openClawKey] = 'explicit:meldwork-legacy-openclaw'
  workspace.save()
  await workspace.sendMessage({
    groupId: first.id, text: 'Kimi 2', targetKinds: ['kimi'], threadRootId: firstRoot,
  })
  await workspace.sendMessage({
    groupId: first.id, text: 'OpenClaw 1', targetKinds: ['openclaw'], threadRootId: firstRoot,
  })
  await workspace.sendMessage({
    groupId: first.id, text: 'OpenClaw 2', targetKinds: ['openclaw'], threadRootId: firstRoot,
  })
  await workspace.sendMessage({ groupId: second.id, text: 'OpenClaw B', targetKinds: ['openclaw'] })

  const sessionRefs = calls.map(call => call.runOptions.sessionRef)
  assert.deepEqual(sessionRefs.slice(0, 2), ['', 'kimi-session'])
  assert.match(sessionRefs[2], /^agent:main:desktop-meldwork-[a-f0-9]{20}-openclaw$/)
  assert.match(sessionRefs[3], /^agent:main:desktop-meldwork-[a-f0-9]{20}-openclaw$/)
  assert.equal(sessionRefs[3], sessionRefs[2])
  assert.notEqual(sessionRefs[4], sessionRefs[2])
  assert.notEqual(workspace.state.sessions[openClawKey], 'explicit:meldwork-legacy-openclaw')
  assert.notEqual(workspace.sessionKey(first.id, 'openclaw', firstRoot), openClawKey)
  assert.equal(calls[0].runOptions.sandbox, 'workspace-write')
  assert.equal(calls[1].runOptions.sandbox, 'workspace-write')
})

test('group write authorization defaults on and can still be explicitly disabled', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '写入授权', agentKinds: ['codex', 'kimi'], workdir: directory,
  })

  await workspace.sendMessage({ groupId: group.id, text: '默认授权', targetKinds: ['codex'] })
  assert.equal(calls[0].runOptions.sandbox, 'workspace-write')
  assert.match(calls[0].prompt, /execute the work instead of returning only a plan/i)
  workspace.updateGroup(group.id, { allowWrite: false })
  await workspace.sendMessage({ groupId: group.id, text: '显式只读', targetKinds: ['kimi'] })

  assert.equal(calls[1].runOptions.sandbox, 'read-only')
  assert.match(calls[1].prompt, /read-only/i)
  const restored = new LocalWorkspace(options)
  assert.equal(restored.snapshot().groups[0].allowWrite, false)
})

test('direct conversations also default to workspace-write', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const direct = workspace.createGroup({
    conversationType: 'direct',
    directAgentKind: 'codex',
    name: 'Codex',
    agentKinds: ['codex'],
    workdir: directory,
  })

  await workspace.sendMessage({ groupId: direct.id, text: '只读私聊' })

  assert.equal(direct.allowWrite, true)
  assert.equal(calls[0].runOptions.sandbox, 'workspace-write')
})

test('group settings cannot change execution context during an active run', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let releaseRun
  const runGate = new Promise(resolve => { releaseRun = resolve })
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    await runGate
    return { text: `${agent.kind} done`, sessionRef: runOptions.sessionRef || 'session-1' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '运行中配置', agentKinds: ['codex'], workdir: directory, allowWrite: true,
  })

  const send = workspace.sendMessage({ groupId: group.id, text: '开始', targetKinds: ['codex'] })
  await new Promise(resolve => setImmediate(resolve))
  assert.throws(
    () => workspace.updateGroup(group.id, { workdir: path.join(directory, 'other'), allowWrite: false }),
    { message: 'LOCAL_GROUP_RUNNING' },
  )
  releaseRun()
  await send
  assert.equal(workspace.getGroup(group.id).workdir, directory)
  assert.equal(workspace.getGroup(group.id).allowWrite, true)
})

test('changing a direct conversation workdir clears its continuous native session', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const firstWorkdir = path.join(directory, 'workspace-a')
  const secondWorkdir = path.join(directory, 'workspace-b')
  fs.mkdirSync(firstWorkdir)
  fs.mkdirSync(secondWorkdir)
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '工作区会话隔离',
    conversationType: 'direct',
    directAgentKind: 'codex',
    agentKinds: ['codex'],
    workdir: firstWorkdir,
  })

  await workspace.sendMessage({ groupId: group.id, text: 'A1', targetKinds: ['codex'] })
  workspace.updateGroup(group.id, { workdir: path.join(firstWorkdir, '.') })
  await workspace.sendMessage({ groupId: group.id, text: 'A2', targetKinds: ['codex'] })
  workspace.updateGroup(group.id, { workdir: secondWorkdir })
  assert.equal(workspace.state.sessions[workspace.sessionKey(group.id, 'codex')], undefined)
  await workspace.sendMessage({ groupId: group.id, text: 'B1', targetKinds: ['codex'] })

  assert.deepEqual(calls.map(call => call.workdir), [firstWorkdir, firstWorkdir, secondWorkdir])
  assert.deepEqual(calls.map(call => call.runOptions.sessionRef), ['', 'codex-session', ''])
})

test('one failed agent persists only its stable error code in a multi-agent message', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const diagnostic = 'Hermes executable /private/agents/hermes failed: upstream untranslated text'
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'hermes') {
      const error = new Error('LOCAL_AGENT_PROCESS_FAILED')
      Object.defineProperty(error, 'diagnostic', { value: diagnostic, enumerable: false })
      throw error
    }
    return { text: 'Codex 正常回复', sessionRef: 'codex-session' }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '部分失败', agentKinds: ['codex', 'hermes'], workdir: directory,
    allowWrite: false,
  })

  await workspace.sendMessage({
    groupId: group.id, text: '@所有人 测试', targetKinds: ['codex', 'hermes'],
  })

  const snapshot = workspace.snapshot()
  assert.deepEqual(calls.map(call => call.agent.kind), [
    'codex', 'hermes', 'hermes', 'hermes', 'hermes',
  ])
  assert.deepEqual(
    snapshot.messages.map(message => [message.role, message.agentKind, message.content]),
    [
      ['user', '', '@所有人 测试'],
      ['agent', 'codex', 'Codex 正常回复'],
      ['system', 'hermes', 'Hermes failed: LOCAL_AGENT_PROCESS_FAILED'],
    ],
  )
  const [root, codexReply, hermesError] = snapshot.messages
  assert.equal(codexReply.threadRootId, root.id)
  assert.equal(hermesError.threadRootId, root.id)
  assert.deepEqual(hermesError.system, {
    key: 'system.agentCallFailed',
    params: { agent: 'Hermes', reason: 'LOCAL_AGENT_PROCESS_FAILED' },
  })
  assert.equal(hermesError.trace.status, 'failed')
  assert.equal(hermesError.trace.agentRunId.includes(':hermes:'), true)
  const serialized = fs.readFileSync(options.storagePath, 'utf8')
  assert.match(serialized, /LOCAL_AGENT_PROCESS_FAILED/)
  assert.doesNotMatch(serialized, /\/private\/agents\/hermes|upstream untranslated text/)
  assert.doesNotMatch(JSON.stringify(snapshot), /\/private\/agents\/hermes|upstream untranslated text/)
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'partial')
})

test('running snapshots expose queued and active agents with the topic root', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let releaseCodex
  options.runAgent = async (agent, _prompt, _workdir, runOptions) => {
    if (agent.kind === 'codex') {
      await new Promise(resolve => { releaseCodex = resolve })
    }
    return { text: `${agent.kind} done`, sessionRef: runOptions.sessionRef || `${agent.kind}-session` }
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '运行状态', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  const send = workspace.sendMessage({ groupId: group.id, text: '开始', targetKinds: ['codex', 'hermes'] })
  await new Promise(resolve => setImmediate(resolve))
  const running = workspace.snapshot()

  assert.equal(running.runs.length, 1)
  assert.deepEqual(running.runs[0].targetKinds, ['codex', 'hermes'])
  assert.deepEqual(running.runs[0].completedKinds, [])
  assert.deepEqual(running.runs[0].failedKinds, [])
  assert.equal(running.runs[0].currentKind, 'codex')
  assert.equal(running.runs[0].threadRootId, running.messages[0].id)

  releaseCodex()
  await send
  assert.deepEqual(workspace.snapshot().runs, [])
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'completed')
  assert.equal(finished[0].groupId, group.id)
  assert.equal(finished[0].threadRootId, running.messages[0].id)
})

test('running snapshots distinguish failed Agents from successful completions', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let releaseHermes
  let markHermesStarted
  const hermesStarted = new Promise(resolve => { markHermesStarted = resolve })
  options.runAgent = async (agent, _prompt, _workdir, runOptions) => {
    if (agent.kind === 'codex') throw new Error('LOCAL_AGENT_PROCESS_FAILED')
    markHermesStarted()
    await new Promise(resolve => { releaseHermes = resolve })
    return { text: 'Hermes done', sessionRef: runOptions.sessionRef || 'hermes-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '失败状态', agentKinds: ['codex', 'hermes'], workdir: directory,
    allowWrite: false,
  })

  const send = workspace.sendMessage({
    groupId: group.id, text: '开始', targetKinds: ['codex', 'hermes'],
  })
  await hermesStarted
  const running = workspace.snapshot().runs[0]

  assert.deepEqual(running.completedKinds, ['codex'])
  assert.deepEqual(running.failedKinds, ['codex'])
  assert.equal(running.currentKind, 'hermes')

  releaseHermes()
  await send
})

test('legacy progress stays out of Harness trace while later Agents receive the final reply', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let releaseHermes
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    if (agent.kind === 'hermes') {
      runOptions.onEvent({
        id: 'hermes-connector', type: 'warning', status: 'waiting', title: 'connector_limited',
      })
      for (let index = 0; index < 9; index += 1) {
        runOptions.onProgress({
          title: 'write_file', status: 'completed', detail: 'raw-progress-output',
          command: 'cat /private/secret',
        })
      }
      runOptions.onProgress({
        title: '/private/review diff', status: 'unknown', detail: 'raw-review-output',
      })
      await new Promise(resolve => { releaseHermes = resolve })
      return { text: 'Hermes authoritative final', sessionRef: 'hermes-session' }
    }
    return { text: 'WorkBuddy used the final', sessionRef: 'workbuddy-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '最终结果传递', agentKinds: ['hermes', 'workbuddy'], workdir: directory,
  })

  const send = workspace.sendMessage({
    groupId: group.id,
    text: '开始研究',
    targetKinds: ['hermes', 'workbuddy'],
  })
  await new Promise(resolve => setImmediate(resolve))

  const active = workspace.snapshot().runs[0]
  assert.equal(active.currentKind, 'hermes')
  assert.equal(active.progress.length, 8)
  assert.deepEqual(active.progress.at(-1), { title: 'process', status: 'completed' })
  assert.doesNotMatch(JSON.stringify(active.progress), /private|review diff/)
  assert.equal(active.agentRuns[0].events.some(event => event.type.startsWith('tool_')), false)
  assert.equal(active.agentRuns[0].events.some(event => event.title === 'connector_limited'), true)

  releaseHermes()
  await send

  assert.match(calls[1].prompt, /Hermes: Hermes authoritative final/)
  assert.match(calls[1].prompt, /E-R0-HERMES-\d+ \[warning\] connector_limited/)
  assert.doesNotMatch(calls[1].prompt, /\[tool_result_summary\] (?:write_file|process)/)
  assert.doesNotMatch(calls[1].prompt, /raw-progress-output|raw-review-output|cat \/private|elapsedMs|private\/review diff/)
  const hermesReply = workspace.snapshot().messages.find(message => message.agentKind === 'hermes')
  assert.equal(hermesReply.content, 'Hermes authoritative final')
  assert.equal(hermesReply.toolCalls.length, 8)
  assert.deepEqual(hermesReply.trace.events.map(event => [event.type, event.title]), [
    ['warning', 'connector_limited'],
  ])
  assert.doesNotMatch(JSON.stringify(hermesReply.trace), /raw-progress-output|raw-review-output|cat \/private|review diff/)
  assert.equal(Number.isSafeInteger(hermesReply.elapsedMs), true)
  assert.equal(hermesReply.elapsedMs >= 0, true)

  const persisted = JSON.parse(fs.readFileSync(options.storagePath, 'utf8'))
  const persistedReply = persisted.messages.find(message => message.agentKind === 'hermes')
  assert.equal(persistedReply.content, 'Hermes authoritative final')
  assert.equal(persistedReply.toolCalls.length, 8)
  assert.equal(typeof persistedReply.elapsedMs, 'number')
})

test('running progress updates an existing Codex event instead of appending duplicates', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const release = deferred()
  options.runAgent = async (_agent, _prompt, _workdir, runOptions) => {
    runOptions.onProgress({ id: 'item-1', title: 'search', status: 'in_progress' })
    runOptions.onProgress({ id: 'item-1', title: 'search', status: 'completed' })
    await release.promise
    return { text: 'done', sessionRef: 'codex-session' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Codex progress', agentKinds: ['codex'], workdir: directory,
  })

  const send = workspace.sendMessage({ groupId: group.id, text: 'Search' })
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(workspace.snapshot().runs[0].progress, [
    { title: 'search', status: 'completed' },
  ])
  release.resolve()
  await send
})

test('all failed agents resolve after persisting one user message and recording failures', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    throw new Error(`${agent.kind} failed`)
  }
  const workspace = new LocalWorkspace(options)
  const finished = []
  workspace.on('run-finished', result => finished.push(result))
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: '全部失败', agentKinds: ['codex', 'hermes'], workdir: directory,
  })

  const result = await workspace.sendMessage({
    groupId: group.id,
    text: '@所有人 测试',
    targetKinds: ['codex', 'hermes'],
    attachments: [{ id: 'failure-image', name: 'failure.png', mimeType: 'image/png', size: 3 }],
  })

  assert.deepEqual(calls.map(call => call.agent.kind), ['codex', 'hermes'])
  const userMessages = result.messages.filter(message => message.role === 'user')
  assert.equal(userMessages.length, 1)
  assert.equal(userMessages[0].content, '@所有人 测试')
  assert.deepEqual(userMessages[0].attachments, [
    { id: 'failure-image', name: 'failure.png', mimeType: 'image/png', size: 3 },
  ])
  assert.deepEqual(
    workspace.snapshot().messages.filter(message => message.role === 'system')
      .map(message => message.content),
    ['Codex failed: codex failed', 'Hermes failed: hermes failed'],
  )
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'failed')
})

test('regenerating a group Agent reply preserves one user root and durable response versions', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const vaultPath = path.join(directory, 'Knowledge')
  options.validateKnowledgeBaseSelections = (_targetKinds, selections) => selections.map(source => ({
    ...source,
    name: 'Obsidian',
    accessMode: 'vault',
    location: vaultPath,
  }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Versioned response', agentKinds: ['codex', 'hermes'], workdir: directory,
  })
  const attachment = {
    id: 'regenerate-image', name: 'reference.png', mimeType: 'image/png', size: 128,
  }
  const skill = {
    targetKind: 'codex', namespace: 'quality', slug: 'review', name: 'Review carefully',
  }

  await workspace.sendMessage({
    groupId: group.id,
    text: 'ORIGINAL_QUERY_REGENERATE',
    targetKinds: ['codex'],
    attachments: [attachment],
    skillHints: [skill],
    knowledgeBaseHints: [{ kind: 'obsidian', targetKinds: ['codex'] }],
  })
  const firstSnapshot = workspace.snapshot()
  const originalUser = firstSnapshot.messages.find(message => message.role === 'user')
  const originalReply = firstSnapshot.messages.find(message => message.role === 'agent')
  await workspace.sendMessage({
    groupId: group.id, text: 'LATER_QUERY_MUST_STAY_OUT', targetKinds: ['codex'],
  })

  await assert.rejects(workspace.sendMessage({
    groupId: group.id,
    targetKinds: ['hermes'],
    mode: 'manual',
    regenerateMessageId: originalReply.id,
  }), { message: 'LOCAL_MESSAGE_REGENERATION_INVALID' })

  await workspace.sendMessage({
    groupId: group.id,
    targetKinds: ['codex'],
    mode: 'manual',
    regenerateMessageId: originalReply.id,
  })

  const snapshot = workspace.snapshot()
  const userMessages = snapshot.messages.filter(message => message.role === 'user')
  const versionedReplies = snapshot.messages.filter(message => (
    message.role === 'agent'
      && (message.id === originalReply.id || message.responseVersionRootId === originalReply.id)
  ))
  const regeneratedReply = versionedReplies.at(-1)
  assert.equal(userMessages.length, 2)
  assert.equal(userMessages[0].id, originalUser.id)
  assert.deepEqual(userMessages[0].attachments, [attachment])
  assert.deepEqual(userMessages[0].skillHints, [skill])
  assert.equal(versionedReplies.length, 2)
  assert.equal(regeneratedReply.threadRootId, originalUser.id)
  assert.equal(regeneratedReply.responseVersionRootId, originalReply.id)
  assert.equal(calls.length, 3)
  assert.equal(calls[2].runOptions.sessionRef, '')
  assert.equal(calls[2].runOptions.attachments.length, 1)
  assert.match(calls[2].prompt, /ORIGINAL_QUERY_REGENERATE/)
  assert.match(calls[2].prompt, /quality\/review: Review carefully/)
  assert.match(calls[2].prompt, new RegExp(vaultPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(calls[2].prompt, /Produce a fresh alternative response/)
  assert.doesNotMatch(calls[2].prompt, /codex reply 1|LATER_QUERY_MUST_STAY_OUT/)

  const packed = workspace.packedPromptContext(group.id)
  assert.equal(packed.sourceMessageIds.includes(originalReply.id), false)
  assert.equal(packed.sourceMessageIds.includes(regeneratedReply.id), true)
  const restored = new LocalWorkspace(options)
  assert.equal(
    restored.snapshot().messages.find(message => message.id === regeneratedReply.id)?.responseVersionRootId,
    originalReply.id,
  )
})

test('regenerating a direct reply stays attached to its original user turn', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const direct = workspace.createGroup({
    name: 'Codex', workdir: directory,
    conversationType: 'direct', directAgentKind: 'codex', agentKinds: ['codex'],
  })

  await workspace.sendMessage({ groupId: direct.id, text: 'DIRECT_ORIGINAL_QUERY' })
  const firstSnapshot = workspace.snapshot()
  const originalUser = firstSnapshot.messages.find(message => message.role === 'user')
  const originalReply = firstSnapshot.messages.find(message => message.role === 'agent')
  await workspace.sendMessage({ groupId: direct.id, text: 'DIRECT_LATER_QUERY' })
  await workspace.sendMessage({
    groupId: direct.id,
    targetKinds: ['codex'],
    mode: 'manual',
    regenerateMessageId: originalReply.id,
  })

  const snapshot = workspace.snapshot()
  const regeneratedReply = snapshot.messages.filter(message => (
    message.role === 'agent' && message.responseVersionRootId === originalReply.id
  )).at(-1)
  assert.equal(snapshot.messages.filter(message => message.role === 'user').length, 2)
  assert.equal(regeneratedReply.threadRootId, originalUser.id)
  assert.equal(regeneratedReply.responseVersionRootId, originalReply.id)
  assert.equal(calls[2].runOptions.sessionRef, '')
  assert.match(calls[2].prompt, /DIRECT_ORIGINAL_QUERY/)
  assert.doesNotMatch(calls[2].prompt, /DIRECT_LATER_QUERY|codex reply 1/)
})

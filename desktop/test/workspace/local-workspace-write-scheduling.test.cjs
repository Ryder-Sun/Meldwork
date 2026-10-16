const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { RunScheduler } = require('../../src/runs/run-scheduler.cjs')
const { deferred, fixture } = require('../support/local-workspace-test-helpers.cjs')

test('group chats sharing a folder, even through a symlink alias, run side by side', { timeout: 10000 }, async (t) => {
  const { directory, options } = fixture()
  const workdir = path.join(directory, 'work')
  const alias = path.join(directory, 'alias')
  fs.mkdirSync(workdir)
  fs.symlinkSync(workdir, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const bothStarted = deferred()
  const release = deferred()
  t.after(() => {
    release.resolve()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const scheduler = new RunScheduler()
  options.runScheduler = scheduler
  const calls = []
  options.runAgent = async (agent, _prompt, cwd, runOptions) => {
    calls.push({ kind: agent.kind, sandbox: runOptions.sandbox })
    if (calls.length === 2) bothStarted.resolve()
    await release.promise
    fs.appendFileSync(path.join(cwd, 'result.txt'), `${agent.kind}\n`)
    return { text: `Written by ${agent.kind}.`, sessionRef: `${agent.kind}-session` }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const first = workspace.createGroup({
    name: 'first writer', agentKinds: ['codex'], workdir, allowWrite: true,
  })
  const second = workspace.createGroup({
    name: 'second writer', agentKinds: ['hermes'], workdir: alias, allowWrite: true,
  })
  const firstRun = workspace.sendMessage({ groupId: first.id, text: 'Write the requested result.' })
  const secondRun = workspace.sendMessage({ groupId: second.id, text: 'Append the requested result.' })
  // The second group must not wait for the first: both Agents are running
  // while neither has finished.
  await bothStarted.promise
  assert.deepEqual(calls, [
    { kind: 'codex', sandbox: 'workspace-write' },
    { kind: 'hermes', sandbox: 'workspace-write' },
  ])
  assert.equal(scheduler.snapshot().queued.length, 0)
  assert.equal(scheduler.snapshot().active.workspaces.length, 2)
  release.resolve()
  await Promise.all([firstRun, secondRun])
  assert.deepEqual(
    fs.readFileSync(path.join(workdir, 'result.txt'), 'utf8').trim().split('\n').sort(),
    ['codex', 'hermes'],
  )
  assert.equal(scheduler.snapshot().active.global, 0)
})

test('the writer lease belongs to the conversation, not to the folder', { timeout: 10000 }, async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const scheduler = new RunScheduler()
  const leases = []
  options.runScheduler = {
    withLease: (input, operation) => {
      leases.push({ key: input.workspaceKey, permissionMode: input.permissionMode })
      return scheduler.withLease(input, operation)
    },
    snapshot: () => scheduler.snapshot(),
  }
  options.runAgent = async agent => ({ text: `${agent.kind} done.` })
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const [one, two] = ['one', 'two'].map(name => workspace.createGroup({
    name, agentKinds: ['codex'], workdir: directory, allowWrite: true,
  }))

  await workspace.sendMessage({ groupId: one.id, text: 'First turn.' })
  await workspace.sendMessage({ groupId: one.id, text: 'Second turn.' })
  await workspace.sendMessage({ groupId: two.id, text: 'Other conversation.' })

  assert.equal(leases.length, 3)
  assert.equal(leases.every(lease => lease.permissionMode === 'workspace-write'), true)
  assert.equal(leases[0].key, leases[1].key, 'turns of one conversation share a lease scope')
  assert.notEqual(leases[0].key, leases[2].key, 'another conversation in the same folder does not')
})

test('read-only group invocations retain parallel execution in the same directory', { timeout: 10000 }, async (t) => {
  const { directory, options } = fixture()
  const release = deferred()
  const bothStarted = deferred()
  t.after(() => {
    release.resolve()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  options.runScheduler = new RunScheduler()
  const permissions = []
  options.runAgent = async (_agent, _prompt, _cwd, runOptions) => {
    permissions.push(runOptions.sandbox)
    if (permissions.length === 2) bothStarted.resolve()
    await release.promise
    return { text: 'Read-only review completed.' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const groups = ['codex', 'hermes'].map(kind => workspace.createGroup({
    name: kind, agentKinds: [kind], workdir: directory, allowWrite: false,
  }))
  const runs = groups.map(group => workspace.sendMessage({ groupId: group.id, text: 'Review the files.' }))
  await bothStarted.promise
  assert.deepEqual(permissions, ['read-only', 'read-only'])
  release.resolve()
  await Promise.all(runs)
})

test('writable direct chats do not block another Agent in the same directory', { timeout: 10000 }, async (t) => {
  const { directory, options } = fixture()
  const release = deferred()
  const bothStarted = deferred()
  t.after(() => {
    release.resolve()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  options.runScheduler = new RunScheduler()
  const calls = []
  options.runAgent = async (agent, _prompt, _cwd, runOptions) => {
    calls.push({ kind: agent.kind, sandbox: runOptions.sandbox })
    if (calls.length === 2) bothStarted.resolve()
    await release.promise
    return { text: `${agent.kind} completed.` }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const groups = ['codex', 'hermes'].map(kind => workspace.createGroup({
    name: `${kind} direct`, agentKinds: [kind], directAgentKind: kind,
    conversationType: 'direct', workdir: directory, allowWrite: true,
  }))
  const runs = groups.map(group => workspace.sendMessage({ groupId: group.id, text: 'Run independently.' }))
  await bothStarted.promise
  assert.deepEqual(calls.map(call => call.sandbox), ['workspace-write', 'workspace-write'])
  release.resolve()
  await Promise.all(runs)
})

test('the same Agent answers in two conversations at once', { timeout: 10000 }, async (t) => {
  const { directory, options } = fixture()
  const release = deferred()
  const allStarted = deferred()
  t.after(() => {
    release.resolve()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const scheduler = new RunScheduler()
  options.runScheduler = scheduler
  const calls = []
  options.runAgent = async (agent, _prompt, _cwd, runOptions) => {
    calls.push({ kind: agent.kind, sandbox: runOptions.sandbox })
    if (calls.length === 3) allStarted.resolve()
    await release.promise
    return { text: `${agent.kind} completed.` }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const direct = [1, 2].map(number => workspace.createGroup({
    name: `Hermes chat ${number}`, agentKinds: ['hermes'], directAgentKind: 'hermes',
    conversationType: 'direct', workdir: directory, allowWrite: true,
  }))
  const group = workspace.createGroup({
    name: 'Team', agentKinds: ['hermes', 'codex'], workdir: directory, allowWrite: true,
  })

  const runs = [
    workspace.sendMessage({ groupId: direct[0].id, text: 'First chat.' }),
    workspace.sendMessage({ groupId: direct[1].id, text: 'Second chat.' }),
    workspace.sendMessage({ groupId: group.id, text: 'Ask the group.', targetKinds: ['hermes'] }),
  ]
  // Hermes is busy in three conversations and none of them waits for another.
  await allStarted.promise
  assert.deepEqual(calls.map(call => call.kind), ['hermes', 'hermes', 'hermes'])
  assert.equal(scheduler.snapshot().queued.length, 0)
  for (const run of workspace.snapshot().runs) {
    assert.equal('waitingForWorkspaceKinds' in run, false)
  }
  release.resolve()
  await Promise.all(runs)
  assert.equal(scheduler.snapshot().active.global, 0)
})

test('Manual V4 retains parallel readers alongside its single writer and stable message order', { timeout: 10000 }, async (t) => {
  const { directory, options } = fixture()
  const release = deferred()
  const allStarted = deferred()
  t.after(() => {
    release.resolve()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  options.runScheduler = new RunScheduler()
  const calls = []
  options.runAgent = async (agent, _prompt, _cwd, runOptions) => {
    calls.push({ kind: agent.kind, sandbox: runOptions.sandbox })
    if (calls.length === 3) allStarted.resolve()
    await release.promise
    return { text: `${agent.kind} result.` }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  workspace.messageSubmission.v4WriterKind = () => 'codex'
  const group = workspace.createGroup({
    name: 'manual batch', agentKinds: ['codex', 'hermes', 'workbuddy'],
    workdir: directory, allowWrite: true,
  })
  const run = workspace.sendMessage({
    groupId: group.id, text: 'Review and write the agreed result.',
    protocol: 'v4', mode: 'manual', targetKinds: group.agentKinds,
  })
  await allStarted.promise
  assert.deepEqual(calls.filter(call => call.sandbox === 'workspace-write').map(call => call.kind), ['codex'])
  assert.equal(calls.filter(call => call.sandbox === 'read-only').length, 2)
  release.resolve()
  await run
  const messages = workspace.snapshot().messages.filter(message => message.role === 'agent')
  assert.deepEqual(messages.map(message => message.agentKind), group.agentKinds)
})

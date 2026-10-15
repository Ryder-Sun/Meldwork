const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { RunScheduler } = require('../../src/runs/run-scheduler.cjs')
const { deferred, fixture } = require('../support/local-workspace-test-helpers.cjs')

test('workspace invocations serialize writes across groups and symlink aliases', { timeout: 10000 }, async (t) => {
  const { directory, options } = fixture()
  const workdir = path.join(directory, 'work')
  const alias = path.join(directory, 'alias')
  fs.mkdirSync(workdir)
  fs.symlinkSync(workdir, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const started = deferred()
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
    if (calls.length === 1) {
      started.resolve()
      await release.promise
    }
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
  await started.promise
  const secondRun = workspace.sendMessage({ groupId: second.id, text: 'Append the requested result.' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.length, 1)
  assert.equal(scheduler.snapshot().queued.length, 1)
  release.resolve()
  await Promise.all([firstRun, secondRun])
  assert.deepEqual(calls, [
    { kind: 'codex', sandbox: 'workspace-write' },
    { kind: 'hermes', sandbox: 'workspace-write' },
  ])
  assert.equal(fs.readFileSync(path.join(workdir, 'result.txt'), 'utf8'), 'codex\nhermes\n')
  assert.equal(scheduler.snapshot().active.global, 0)
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

test('writable chats in one folder take turns and show who is waiting', { timeout: 10000 }, async (t) => {
  const { directory, options } = fixture()
  const release = deferred()
  const firstStarted = deferred()
  t.after(() => {
    release.resolve()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  options.runScheduler = new RunScheduler()
  const calls = []
  options.runAgent = async (agent, _prompt, _cwd, runOptions) => {
    calls.push({ kind: agent.kind, sandbox: runOptions.sandbox })
    if (agent.kind === 'codex') {
      firstStarted.resolve()
      await release.promise
    }
    return { text: `${agent.kind} completed.` }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const groups = ['codex', 'hermes'].map(kind => workspace.createGroup({
    name: `${kind} direct`, agentKinds: [kind], directAgentKind: kind,
    conversationType: 'direct', workdir: directory, allowWrite: true,
  }))
  const first = workspace.sendMessage({ groupId: groups[0].id, text: 'Write first.' })
  await firstStarted.promise
  const second = workspace.sendMessage({ groupId: groups[1].id, text: 'Write second.' })
  // The second writer waits for the folder and the snapshot says so.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const run = workspace.snapshot().runs.find(item => item.groupId === groups[1].id)
    if (run?.waitingForWorkspaceKinds?.includes('hermes')) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const waitingRun = workspace.snapshot().runs.find(item => item.groupId === groups[1].id)
  assert.deepEqual(waitingRun.waitingForWorkspaceKinds, ['hermes'])
  assert.deepEqual(calls.map(call => call.kind), ['codex'])
  release.resolve()
  await Promise.all([first, second])
  assert.deepEqual(calls.map(call => [call.kind, call.sandbox]), [
    ['codex', 'workspace-write'], ['hermes', 'workspace-write'],
  ])
  assert.equal(workspace.snapshot().runs.some(run => run.waitingForWorkspaceKinds?.length), false)
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

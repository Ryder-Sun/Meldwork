const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { attachmentIdsFromSnapshot } = require('../../src/attachments/attachment-service.cjs')
const { registerDeliveryIpc } = require('../../src/shell/delivery-ipc.cjs')
const { AttachmentStore } = require('../../src/attachments/attachment-store.cjs')
const { captureAgentOutputState, importAgentOutputs } = require('../../src/agents/agent-output-importer.cjs')
const { fixture, deferred } = require('../support/local-workspace-test-helpers.cjs')

const brief = { title: 'Monthly brief', goal: 'Explain progress', output: 'A sourced brief', outputKind: 'text', criteria: ['Sources checked', 'Gaps listed'], language: 'en' }
async function setup(t, overrides = {}) {
  const f = fixture()
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace({ ...f.options, ...overrides })
  await workspace.refreshAgents()
  const group = workspace.createGroup({ name: 'Delivery', agentKinds: ['codex'], workdir: f.directory, allowWrite: false, conversationType: 'direct', directAgentKind: 'codex' })
  const taskId = workspace.delivery.save({ groupId: group.id, brief })
  const send = (extra = {}) => workspace.sendMessage({ groupId: group.id, deliveryTaskId: taskId, targetKinds: ['codex'], text: 'Current month only', mode: 'manual', ...extra })
  return { ...f, workspace, group, taskId, send }
}

test('task runs freeze inputs, create independent versions, require human acceptance and survive restart', async t => {
  const f = await setup(t)
  await f.send()
  let task = f.workspace.delivery.task(f.taskId)
  assert.equal(task.attempts[0].status, 'completed')
  assert.equal(task.versions.length, 1)
  assert.match(f.calls[0].prompt, /Explain progress/)
  assert.doesNotMatch(f.workspace.snapshot().messages.find(item => item.id === task.attempts[0].messageId).content, /Human acceptance is separate/)
  assert.equal(task.versions[0].acceptedAt, '')
  assert.throws(() => f.workspace.delivery.save({ groupId: f.group.id, taskId: f.taskId, brief }), /LOCKED/)
  const v1 = task.versions[0].id
  assert.throws(() => f.workspace.delivery.review({ taskId: f.taskId, versionId: v1, checks: ['met', 'unknown'], notes: '', accept: true }), /NOT_READY/)
  f.workspace.delivery.review({ taskId: f.taskId, versionId: v1, checks: ['met', 'met'], notes: 'Checked source data', accept: true })
  const acceptedAt = f.workspace.delivery.version(f.workspace.delivery.task(f.taskId), v1).acceptedAt
  f.workspace.delivery.revise({ taskId: f.taskId, baseVersionId: v1, note: 'Shorten the summary' })
  await f.send({ text: 'Use the new period' })
  task = f.workspace.delivery.task(f.taskId)
  assert.equal(task.versions.length, 2)
  assert.equal(task.versions[0].acceptedAt, acceptedAt)
  assert.deepEqual(task.versions[1].checks, ['pending', 'pending'])
  assert.equal(task.attempts[1].revision.baseVersionId, v1)
  assert.match(f.calls[1].prompt, /Shorten the summary/)
  assert.match(f.workspace.delivery.markdown(f.taskId, v1), /Checked source data/)
  const reopened = new LocalWorkspace(f.options)
  assert.equal(reopened.delivery.task(f.taskId).versions.length, 2)
  assert.equal(reopened.delivery.task(f.taskId).versions[0].acceptedAt, acceptedAt)
})

test('ordinary chat and other tasks in the same conversation cannot change a frozen version', async t => {
  const f = await setup(t)
  await f.send()
  const original = structuredClone(f.workspace.delivery.task(f.taskId).versions)
  await f.workspace.sendMessage({ groupId: f.group.id, targetKinds: ['codex'], text: 'Unrelated chat', mode: 'manual' })
  const secondId = f.workspace.delivery.save({ groupId: f.group.id, brief: { ...brief, title: 'Different task' } })
  await f.send({ deliveryTaskId: secondId, text: 'Different input' })
  assert.deepEqual(f.workspace.delivery.task(f.taskId).versions, original)
  assert.equal(f.workspace.delivery.task(secondId).versions.length, 1)
  assert.notEqual(f.workspace.delivery.task(secondId).versions[0].runId, original[0].runId)
})

test('manual V4 committed proposal messages are deliverables, uncommitted discussion is not', async t => {
  const f = await setup(t)
  const task = f.workspace.delivery.task(f.taskId)
  f.workspace.delivery.commit(() => task.attempts.push({ runId: 'v4-run', messageId: 'root', status: 'running', createdAt: f.workspace.now(), input: '', sources: [], revision: null }))
  f.workspace.state.messages.push(
    { id: 'root', role: 'user', groupId: f.group.id, content: 'Task' },
    { id: 'proposal', role: 'agent', groupId: f.group.id, agentKind: 'codex', content: 'Committed answer', threadRootId: 'root', trace: { runId: 'v4-run', phase: 'proposal' } },
    { id: 'discussion', role: 'agent', groupId: f.group.id, agentKind: 'codex', content: 'Internal discussion', threadRootId: 'root', trace: { runId: 'v4-run', phase: 'discussion' } },
  )
  f.workspace.delivery.complete('v4-run', 'completed', ['proposal'])
  assert.deepEqual(task.versions[0].responses.map(item => item.content), ['Committed answer'])
  f.workspace.delivery.complete('v4-run', 'completed', ['proposal'])
  assert.equal(task.versions.length, 1)
})

test('rejects invalid fields, cross-conversation binding and edits during a run', async t => {
  const pending = deferred()
  const f = await setup(t, { runAgent: async () => pending.promise })
  assert.throws(() => f.workspace.delivery.save({ groupId: f.group.id, brief: { ...brief, criteria: [] } }), /INVALID/)
  const other = f.workspace.createGroup({ name: 'Other', agentKinds: ['codex'], workdir: f.directory })
  await assert.rejects(f.send({ groupId: other.id }), /INVALID/)
  const running = f.send()
  for (let i = 0; i < 100 && !f.workspace.delivery.task(f.taskId).attempts.length; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.throws(() => f.workspace.delivery.save({ groupId: f.group.id, taskId: f.taskId, brief }), /RUNNING/)
  pending.resolve({ text: 'Actual result', outcome: 'completed' })
  await running
  assert.equal(f.workspace.delivery.task(f.taskId).versions.length, 1)
})

test('failed runs do not turn system errors into deliverables; file tasks require actual attachments', async t => {
  const f = await setup(t, { runAgent: async () => { throw new Error('offline') } })
  await f.send()
  assert.equal(f.workspace.delivery.task(f.taskId).versions.length, 0)
  assert.equal(f.workspace.delivery.task(f.taskId).attempts[0].status, 'failed')
  const good = await setup(t)
  good.workspace.delivery.save({ groupId: good.group.id, taskId: good.taskId, brief: { ...brief, outputKind: 'files' } })
  await good.send()
  const task = good.workspace.delivery.task(good.taskId)
  assert.throws(() => good.workspace.delivery.review({ taskId: task.id, versionId: task.versions[0].id, checks: ['met', 'met'], notes: '', accept: true }), /NOT_READY/)
})

test('version and attachment references survive message deletion; deleting the conversation removes tasks', async t => {
  const attachment = { id: 'file-output', name: 'result.csv', mimeType: 'text/csv', size: 10 }
  const f = await setup(t)
  await f.send()
  const task = f.workspace.delivery.task(f.taskId)
  // Exercise retention independently from the Agent importer protocol.
  f.workspace.delivery.commit(() => { task.versions[0].attachments = [attachment] })
  const messageId = task.versions[0].responses[0].messageId
  f.workspace.deleteMessage(f.group.id, messageId)
  assert.equal(f.workspace.delivery.task(f.taskId).versions.length, 1)
  assert.ok(attachmentIdsFromSnapshot(f.workspace.snapshot()).includes(attachment.id))
  f.workspace.deleteGroup(f.group.id)
  assert.equal(f.workspace.state.deliveryTasks.length, 0)
})

test('persistence failure rolls back task mutations and restart marks orphaned work interrupted', async t => {
  const f = await setup(t)
  const save = f.workspace.save.bind(f.workspace)
  f.workspace.save = () => { throw new Error('disk full') }
  assert.throws(() => f.workspace.delivery.save({ groupId: f.group.id, taskId: f.taskId, brief: { ...brief, title: 'Unsaved' } }), /disk full/)
  assert.equal(f.workspace.delivery.task(f.taskId).brief.title, brief.title)
  f.workspace.save = save
  f.workspace.delivery.commit(() => f.workspace.delivery.task(f.taskId).attempts.push({ runId: 'orphan', messageId: 'orphan-message', status: 'running', createdAt: f.workspace.now(), input: '', sources: [], revision: null }))
  const reopened = new LocalWorkspace(f.options)
  assert.equal(reopened.delivery.task(f.taskId).attempts[0].status, 'interrupted')
})

test('trusted export validates version ownership, handles cancellation and preserves acceptance; reuse clears context and writes', async t => {
  const f = await setup(t)
  await f.send()
  const handlers = new Map()
  let saveResult = { canceled: true }
  registerDeliveryIpc({
    registerTrustedHandle: (name, callback) => handlers.set(name, callback), getWorkspace: () => f.workspace,
    getAttachmentStore: () => null, getMainWindow: () => null,
    dialog: { showSaveDialog: async () => saveResult },
  })
  const version = f.workspace.delivery.task(f.taskId).versions[0]
  const payload = { taskId: f.taskId, versionId: version.id }
  const exportVersion = handlers.get('local-delivery:export')
  assert.deepEqual(await exportVersion(payload), { saved: false })
  await assert.rejects(exportVersion({ ...payload, filePath: '/tmp/unsafe' }), /INVALID/)
  await assert.rejects(exportVersion({ ...payload, attachmentId: 'another-file' }), /NOT_FOUND/)
  saveResult = { canceled: false, filePath: path.join(f.directory, 'export.md') }
  assert.deepEqual(await exportVersion(payload), { saved: true })
  assert.match(fs.readFileSync(saveResult.filePath, 'utf8'), /Input materials/)
  assert.equal(version.acceptedAt, '')
  saveResult.filePath = path.join(f.directory, 'missing', 'export.md')
  await assert.rejects(exportVersion(payload), /EXPORT_FAILED/)
  const reused = handlers.get('local-delivery:reuse')({ taskId: f.taskId })
  const newGroup = f.workspace.getGroup(reused.groupId)
  const newTask = f.workspace.delivery.task(reused.taskId)
  assert.equal(newGroup.allowWrite, false)
  assert.notEqual(newGroup.workdir, f.group.workdir)
  assert.deepEqual(fs.readdirSync(newGroup.workdir), [])
  assert.deepEqual(newTask.attempts, [])
  assert.deepEqual(newTask.versions, [])
  assert.equal(f.workspace.state.messages.some(item => item.groupId === reused.groupId), false)
})

test('actual generated files are imported, exported and carried into a revision with fresh source references', async t => {
  let store
  let fileNumber = 0
  const f = await setup(t, {
    attachmentSupport: () => ({ image: 4, file: 8, audio: 1, video: 1 }),
    resolveAttachments: refs => store.resolve(refs),
    captureAgentOutputs: captureAgentOutputState,
    importAgentOutputs: input => importAgentOutputs(input, store),
    runAgent: async (_agent, _prompt, workdir) => {
      const output = path.join(workdir, '.meldwork-output')
      fs.mkdirSync(output, { recursive: true })
      const filename = path.join(output, `brief-${++fileNumber}.csv`)
      fs.writeFileSync(filename, 'project,progress\nAlpha,75\n')
      return { text: `Generated [brief](${filename})`, outcome: 'completed' }
    },
  })
  store = new AttachmentStore({ rootPath: path.join(f.directory, 'attachments') })
  f.workspace.updateGroup(f.group.id, { allowWrite: true })
  f.workspace.delivery.save({ groupId: f.group.id, taskId: f.taskId, brief: { ...brief, outputKind: 'files' } })
  await f.send()
  const task = f.workspace.delivery.task(f.taskId)
  const version = task.versions[0]
  assert.equal(version.attachments.length, 1)
  const file = version.attachments[0]
  const handlers = new Map()
  const destination = path.join(f.directory, 'export.csv')
  registerDeliveryIpc({ registerTrustedHandle: (name, handler) => handlers.set(name, handler), getWorkspace: () => f.workspace, getAttachmentStore: () => store, getMainWindow: () => null, dialog: { showSaveDialog: async () => ({ canceled: false, filePath: destination }) } })
  await handlers.get('local-delivery:export')({ taskId: task.id, versionId: version.id, attachmentId: file.id })
  assert.equal(fs.readFileSync(destination, 'utf8'), 'project,progress\nAlpha,75\n')
  handlers.get('local-delivery:review')({ taskId: task.id, versionId: version.id, checks: ['met', 'met'], notes: '', accept: true })
  f.workspace.delivery.revise({ taskId: task.id, baseVersionId: version.id, note: 'Update the CSV' })
  await f.send()
  assert.ok(task.attempts[1].sources.some(item => item.attachmentId === file.id))
  assert.equal(task.versions.length, 2, JSON.stringify(f.workspace.snapshot().messages.at(-1)))
  assert.equal(task.versions[1].attachments.length, 1)
  assert.equal(task.versions[1].acceptedAt, '')
})

const fs = require('node:fs')
const path = require('node:path')
const { z } = require('zod')

const id = z.string().min(1).max(120).regex(/^[A-Za-z0-9._:-]+$/)
function request(schema, input) {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new Error('LOCAL_DELIVERY_INVALID')
  return parsed.data
}

function registerDeliveryIpc({ registerTrustedHandle, getWorkspace, getAttachmentStore, dialog, getMainWindow }) {
  const workspace = () => {
    const value = getWorkspace()
    if (!value) throw new Error('LOCAL_WORKSPACE_UNAVAILABLE')
    return value
  }
  for (const method of ['save', 'review', 'revise']) {
    registerTrustedHandle(`local-delivery:${method}`, input => {
      const current = workspace()
      if (method === 'review' && input?.accept === true) {
        const task = current.delivery.task(input.taskId)
        const version = current.delivery.version(task, input.versionId)
        for (const attachment of version.attachments) {
          const store = getAttachmentStore()
          if (!store) throw new Error('LOCAL_ATTACHMENT_STORAGE_UNAVAILABLE')
          store.read(attachment.id)
        }
      }
      const result = current.delivery[method](input)
      current.emitChanged()
      return { taskId: method === 'save' ? result : input.taskId }
    })
  }
  registerTrustedHandle('local-delivery:reuse', input => {
    const { taskId } = request(z.strictObject({ taskId: id }), input)
    const current = workspace()
    const task = current.delivery.task(taskId)
    const original = current.getGroup(task.groupId)
    const root = path.join(path.dirname(current.storagePath), 'delivery-workspaces')
    fs.mkdirSync(root, { recursive: true, mode: 0o700 })
    const workdir = fs.mkdtempSync(path.join(root, 'task-'))
    let group
    try {
      group = current.createGroup({
        name: task.brief.title, agentKinds: original.agentKinds,
        conversationType: original.conversationType,
        directAgentKind: original.directAgentKind,
        workdir, allowWrite: false,
      })
      const newTaskId = current.delivery.save({ groupId: group.id, brief: task.brief })
      current.emitChanged()
      return { taskId: newTaskId, groupId: group.id }
    } catch (error) {
      if (group) current.deleteGroup(group.id)
      fs.rmdirSync(workdir)
      throw error
    }
  })
  registerTrustedHandle('local-delivery:export', async input => {
    const { taskId, versionId, attachmentId } = request(z.strictObject({
      taskId: id, versionId: id, attachmentId: id.optional(),
    }), input)
    const current = workspace()
    const task = current.delivery.task(taskId)
    const version = current.delivery.version(task, versionId)
    const attachment = attachmentId ? version.attachments.find(item => item.id === attachmentId) : null
    if (attachmentId && !attachment) throw new Error('LOCAL_DELIVERY_NOT_FOUND')
    let bytes
    if (attachment) {
      const store = getAttachmentStore()
      if (!store) throw new Error('LOCAL_ATTACHMENT_STORAGE_UNAVAILABLE')
      bytes = store.read(attachment.id)
    } else bytes = Buffer.from(current.delivery.markdown(taskId, versionId), 'utf8')
    const filename = (attachment?.name || `${task.brief.title}-V${task.versions.indexOf(version) + 1}.md`)
      .replace(/[\\/\x00-\x1f:*?"<>|]/g, '_')
    const result = await dialog.showSaveDialog(getMainWindow(), { defaultPath: filename })
    if (result.canceled || !result.filePath) return { saved: false }
    try {
      fs.writeFileSync(result.filePath, bytes, { mode: 0o600, flag: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW })
    } catch { throw new Error('LOCAL_DELIVERY_EXPORT_FAILED') }
    return { saved: true }
  })
}

module.exports = { registerDeliveryIpc }

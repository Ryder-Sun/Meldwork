const { randomUUID } = require('node:crypto')
const { z } = require('zod')
const { normalizeAttachmentMetadata } = require('./local-workspace-message-records.cjs')

const id = z.string().min(1).max(120).regex(/^[A-Za-z0-9._:-]+$/)
const text = (max) => z.string().trim().min(1).max(max)
const briefSchema = z.strictObject({
  title: text(120), goal: text(4000), output: text(2000),
  outputKind: z.enum(['text', 'files']),
  criteria: z.array(text(300)).min(1).max(20),
  language: z.enum(['zh', 'en']),
})
const attachmentSchema = z.strictObject({
  id, name: text(160), mimeType: text(160), size: z.number().int().positive(),
})
const sourceSchema = z.strictObject({ name: text(200), kind: text(40), attachmentId: id.optional() })
const revisionSchema = z.strictObject({ baseVersionId: id, note: text(4000) })
const attemptSchema = z.strictObject({
  runId: id, messageId: id, status: text(40), createdAt: text(80),
  input: z.string().max(200000), sources: z.array(sourceSchema).max(41),
  revision: revisionSchema.nullable(),
})
const versionSchema = z.strictObject({
  id, runId: id, createdAt: text(80),
  responses: z.array(z.strictObject({ messageId: id, agentKind: text(40), content: z.string().max(1000000) })).max(32),
  attachments: z.array(attachmentSchema).max(128),
  checks: z.array(z.enum(['pending', 'met', 'unmet', 'unknown'])).max(20),
  notes: z.string().max(4000), acceptedAt: z.string().max(80),
})
const taskSchema = z.strictObject({
  id, groupId: text(100), brief: briefSchema, createdAt: text(80),
  attempts: z.array(attemptSchema).max(200), versions: z.array(versionSchema).max(200),
  revision: revisionSchema.nullable(),
})

function parse(schema, input) {
  const result = schema.safeParse(input)
  if (!result.success) throw new Error('LOCAL_DELIVERY_INVALID')
  return result.data
}

function parseDeliveryTasks(value = []) {
  return parse(z.array(taskSchema).max(1000), value)
}

class DeliveryTasks {
  constructor(workspace) {
    this.workspace = workspace
    this.pending = new Map()
  }

  get tasks() { return this.workspace.state.deliveryTasks || [] }

  task(taskId) {
    parse(id, taskId)
    const task = this.tasks.find(item => item.id === taskId)
    if (!task || !this.workspace.state.groups.some(group => group.id === task.groupId)) {
      throw new Error('LOCAL_DELIVERY_NOT_FOUND')
    }
    return task
  }

  version(task, versionId) {
    parse(id, versionId)
    const version = task.versions.find(item => item.id === versionId)
    if (!version) throw new Error('LOCAL_DELIVERY_NOT_FOUND')
    return version
  }

  commit(change) {
    const previous = structuredClone(this.tasks)
    try {
      this.workspace.state.deliveryTasks ||= []
      const result = change()
      parseDeliveryTasks(this.tasks)
      this.workspace.save()
      return result
    } catch (error) {
      this.workspace.state.deliveryTasks = previous
      throw error
    }
  }

  idle(task) {
    if (this.workspace.isGroupBusy(task.groupId) || this.pending.has(task.groupId)) {
      throw new Error('LOCAL_GROUP_RUNNING')
    }
  }

  save(input) {
    const request = parse(z.strictObject({ groupId: text(100), taskId: id.optional(), brief: briefSchema }), input)
    this.workspace.getGroup(request.groupId)
    if (this.workspace.isGroupBusy(request.groupId)) throw new Error('LOCAL_GROUP_RUNNING')
    const existing = request.taskId ? this.task(request.taskId) : null
    if (existing && (existing.groupId !== request.groupId || existing.attempts.length)) {
      throw new Error('LOCAL_DELIVERY_LOCKED')
    }
    return this.commit(() => {
      if (existing) { existing.brief = request.brief; return existing.id }
      const task = {
        id: `delivery-${randomUUID()}`, groupId: request.groupId, brief: request.brief,
        createdAt: this.workspace.now(), attempts: [], versions: [], revision: null,
      }
      this.tasks.push(task)
      return task.id
    })
  }

  prepare(input) {
    const task = this.task(input.deliveryTaskId)
    if (task.groupId !== input.groupId || input.regenerateMessageId || input.threadRootId) {
      throw new Error('LOCAL_DELIVERY_INVALID')
    }
    this.idle(task)
    if (task.versions.length && !task.revision) throw new Error('LOCAL_DELIVERY_REVISION_REQUIRED')
    const brief = task.brief
    const base = task.revision ? this.version(task, task.revision.baseVersionId) : null
    if (task.attempts.length >= 200) throw new Error('LOCAL_DELIVERY_INPUT_LIMIT')
    if (input.attachments != null && !Array.isArray(input.attachments)) throw new Error('LOCAL_DELIVERY_INVALID')
    const attachments = [...new Map([...(base?.attachments || []), ...(input.attachments || [])]
      .map(item => [item.id, item])).values()]
    if (attachments.length > 32) throw new Error('LOCAL_ATTACHMENT_COUNT_LIMIT')
    const prompt = [
      brief.language === 'zh' ? '工作交付要求（请用中文回答）' : 'Work delivery requirements (respond in English)',
      JSON.stringify(brief),
      'Produce the requested deliverable. Identify source materials for key claims, conflicting or missing information, and unresolved issues. Never invent missing data or claim that a file exists without creating it. Human acceptance is separate from your self-review.',
      ...(base ? ['Previous version:', ...base.responses.map(item => item.content), `Revision request: ${task.revision.note}`] : []),
      `Additional instructions: ${String(input.text || '')}`,
    ].join('\n\n')
    if (prompt.length > 200000) throw new Error('LOCAL_DELIVERY_INPUT_LIMIT')
    this.pending.set(task.groupId, { taskId: task.id, input: String(input.text || '') })
    const { deliveryTaskId: _id, ...rest } = input
    return { ...rest, text: prompt, attachments }
  }

  bind(groupId, controller, messageId) {
    const pending = this.pending.get(groupId)
    if (!pending) return
    const task = this.task(pending.taskId)
    const message = this.workspace.state.messages.find(item => item.id === messageId)
    if (!message || message.groupId !== groupId) throw new Error('LOCAL_DELIVERY_INVALID')
    this.commit(() => task.attempts.push({
      runId: controller.runId, messageId, status: 'running', createdAt: this.workspace.now(),
      input: pending.input, revision: task.revision ? { ...task.revision } : null,
      sources: [
        { name: this.workspace.getGroup(groupId).name || 'Conversation', kind: 'conversation' },
        ...(message.attachments || []).map(item => ({ name: item.name, kind: 'attachment', attachmentId: item.id })),
        ...(message.knowledgeBaseHints || []).map(item => ({ name: item.name, kind: item.kind })),
        ...(message.skillHints || []).map(item => ({ name: item.name, kind: 'skill' })),
      ],
    }))
  }

  complete(runId, status, committedMessageIds = []) {
    const task = this.tasks.find(item => item.attempts.some(attempt => attempt.runId === runId))
    if (!task) return
    const attempt = task.attempts.find(item => item.runId === runId)
    if (!['running', 'waiting', 'preparing'].includes(attempt.status)) return
    const messages = this.workspace.state.messages
    const rootIndex = messages.findIndex(item => item.id === attempt.messageId)
    const nextUserIndex = messages.findIndex((item, index) => index > rootIndex && item.groupId === task.groupId && item.role === 'user')
    const related = messages.filter((message, index) => {
      if (message.role !== 'agent' || message.groupId !== task.groupId) return false
      if (committedMessageIds.includes(message.id)) return true
      if (message.trace?.runId && message.trace.runId !== runId) return false
      return message.trace?.runId === runId
        || message.threadRootId === attempt.messageId
        || (!message.threadRootId && rootIndex >= 0 && index > rootIndex && (nextUserIndex < 0 || index < nextUserIndex))
    })
    const outputs = related.filter(message => {
      const phase = message.trace?.phase || message.trace?.context?.phase
      return committedMessageIds.includes(message.id)
        || !['proposal', 'discussion', 'challenge', 'coordination', 'work', 'verification'].includes(phase)
    }).filter(message => message.content?.trim())
    const attachments = [...new Map(related.flatMap(item => item.attachments || [])
      .map(normalizeAttachmentMetadata).filter(Boolean).map(item => [item.id, item])).values()]
    this.commit(() => {
      attempt.status = status
      if (!outputs.length && !attachments.length) return
      task.versions.push({
        id: `version-${randomUUID()}`, runId, createdAt: this.workspace.now(),
        responses: outputs.map(item => ({ messageId: item.id, agentKind: item.agentKind, content: item.content || '' })),
        attachments, checks: task.brief.criteria.map(() => 'pending'), notes: '', acceptedAt: '',
      })
      task.revision = null
    })
  }

  recover() {
    for (const task of this.tasks) {
      for (const attempt of task.attempts) {
        if (!['running', 'waiting', 'preparing'].includes(attempt.status)) continue
        const record = this.workspace.runLedger?.list?.().find(item => item.runId === attempt.runId)
        if (this.workspace.activeRuns.has(task.groupId)
            || (record?.status === 'waiting' && this.workspace.canResumeHumanGateRecord(record))) continue
        const status = record && !['running', 'waiting', 'preparing', 'queued'].includes(record.status)
          ? record.status : 'interrupted'
        this.complete(attempt.runId, status, [
          ...(record?.orchestration?.commitState?.messageIds || []),
          record?.orchestration?.candidateCommit?.messageId,
        ].filter(Boolean))
      }
    }
  }

  review(input) {
    const request = parse(z.strictObject({
      taskId: id, versionId: id, checks: z.array(z.enum(['pending', 'met', 'unmet', 'unknown'])).max(20),
      notes: z.string().max(4000), accept: z.boolean(),
    }), input)
    const task = this.task(request.taskId)
    this.idle(task)
    const version = this.version(task, request.versionId)
    if (version.acceptedAt || request.checks.length !== task.brief.criteria.length) throw new Error('LOCAL_DELIVERY_LOCKED')
    if (request.accept && (request.checks.some(check => check !== 'met')
        || (task.brief.outputKind === 'files' && !version.attachments.length))) {
      throw new Error('LOCAL_DELIVERY_NOT_READY')
    }
    this.commit(() => {
      version.checks = request.checks
      version.notes = request.notes.trim()
      if (request.accept) version.acceptedAt = this.workspace.now()
    })
  }

  revise(input) {
    const request = parse(z.strictObject({ taskId: id, baseVersionId: id, note: text(4000) }), input)
    const task = this.task(request.taskId)
    this.idle(task)
    this.version(task, request.baseVersionId)
    this.commit(() => { task.revision = { baseVersionId: request.baseVersionId, note: request.note } })
  }

  markdown(taskId, versionId) {
    const task = this.task(taskId)
    const version = this.version(task, versionId)
    const attempt = task.attempts.find(item => item.runId === version.runId)
    const zh = task.brief.language === 'zh'
    const checks = zh
      ? { pending: '待检查', met: '符合', unmet: '不符合', unknown: '无法判断' }
      : { pending: 'Not checked', met: 'Met', unmet: 'Not met', unknown: 'Unknown' }
    return [
      `# ${task.brief.title}`, `V${task.versions.indexOf(version) + 1} · ${version.createdAt}`,
      `${zh ? '采用时间' : 'Accepted at'}: ${version.acceptedAt || (zh ? '未采用' : 'Not accepted')}`,
      ...version.responses.map(item => `## ${item.agentKind}\n\n${item.content}`),
      `## ${zh ? '输入材料（不代表逐条引用已核实）' : 'Input materials (not verified claim-level citations)'}`,
      ...attempt.sources.map(item => `- ${item.name} (${item.kind})`),
      `## ${zh ? '人工验收' : 'Human review'}`,
      ...task.brief.criteria.map((criterion, index) => `- [${checks[version.checks[index]]}] ${criterion}`),
      `## ${zh ? '备注与未决事项' : 'Notes and unresolved issues'}`, version.notes || '—',
      `## ${zh ? '附件（需单独导出）' : 'Attachments (export separately)'}`,
      ...version.attachments.map(item => `- ${item.name}`),
    ].join('\n\n') + '\n'
  }
}

module.exports = { DeliveryTasks, parseDeliveryTasks }

const {
  runtimeCommandSummary,
  runtimeToolOperation,
  runtimeToolResultDetail,
  runtimeToolTitle,
} = require('./cli-runtime-summaries.cjs')
const { codexProgressEvent } = require('./cli-output-parsers.cjs')
const { runtimeEventStatus } = require('./cli-runtime-event-sanitizer.cjs')

function codexRuntimeEvents(event) {
  if (['turn.started', 'turn.completed'].includes(event?.type)) return []
  if (!['item.started', 'item.completed'].includes(event?.type) || !event.item) return []
  const item = event.item
  if (event.type === 'item.completed' && item.type === 'agent_message'
      && typeof item.text === 'string') {
    return [{ type: 'answer_delta', status: 'running', delta: item.text }]
  }
  if (item.type === 'reasoning') {
    return [{
      ...(item.id ? { id: String(item.id) } : { id: 'reasoning' }),
      type: 'reasoning_summary',
      title: 'reasoning',
      status: event.type === 'item.completed' ? 'completed' : 'running',
      ...(event.type === 'item.completed' && typeof item.summary === 'string'
        ? { summary: item.summary }
        : {}),
    }]
  }
  if (item.type === 'plan') {
    const summary = typeof item.summary === 'string' ? item.summary : item.text
    return [{
      ...(item.id ? { id: String(item.id) } : { id: 'plan' }),
      type: 'plan',
      title: 'plan',
      status: event.type === 'item.completed' ? 'completed' : 'running',
      ...(event.type === 'item.completed' && typeof summary === 'string' ? { summary } : {}),
    }]
  }
  const progress = codexProgressEvent(event)
  if (!progress) return []
  const summary = item.type === 'command_execution' && typeof item.command === 'string'
    ? `Bash: operation: ${runtimeCommandSummary(item.command)}`
    : runtimeToolOperation(item)
  const detail = event.type === 'item.completed' ? runtimeToolResultDetail(item) : ''
  return [{
    ...progress,
    type: event.type === 'item.started' ? 'tool_start' : 'tool_result_summary',
    status: runtimeEventStatus(progress.status, 'completed'),
    ...(summary ? { summary } : {}),
    ...(detail ? { detail } : {}),
  }]
}

function streamMessageBlocks(event) {
  const content = event?.message?.content
  if (Array.isArray(content)) return content
  return content && typeof content === 'object' ? [content] : []
}

function streamBlockId(event, update, index = update?.index, messageId = '') {
  const parent = event?.parent_tool_use_id || 'root'
  const message = messageId || update?.message_id || event?.message?.id || event?.uuid || 'message'
  return `${parent}:${message}:${Number.isInteger(index) ? index : 'block'}`
}

function streamBlockKey(event, index, messageId = '') {
  const parent = event?.parent_tool_use_id || 'root'
  const message = String(messageId || '')
  return `${parent}:${message ? `${message}:` : ''}${Number.isInteger(index) ? index : 'block'}`
}

function clearStreamBlock(state, blockKey, id) {
  if (state.blockIds.get(blockKey) === id) state.blockIds.delete(blockKey)
  state.blocks.delete(id)
}

function createClaudeQwenRuntimeState() {
  return {
    blocks: new Map(),
    blockIds: new Map(),
    completedTools: new Set(),
    messageIds: new Map(),
    plans: new Map(),
    reasoning: new Map(),
    startedTools: new Set(),
    toolSummaries: new Map(),
    toolTitles: new Map(),
  }
}

function createGeminiRuntimeState() {
  return {
    completedTools: new Set(),
    toolSummaries: new Map(),
    toolTitles: new Map(),
  }
}

function reasoningLifecycleEvent(state, id, status, summary = '') {
  const signature = `${status}:${summary}`
  if (state.reasoning.get(id) === signature) return null
  state.reasoning.set(id, signature)
  return {
    id,
    type: 'reasoning_summary',
    title: 'reasoning',
    status,
    ...(summary ? { summary } : {}),
  }
}

function planLifecycleEvent(state, value, id, fallbackStatus = 'running') {
  const summary = typeof value?.summary === 'string'
    ? value.summary
    : typeof value?.plan?.summary === 'string' ? value.plan.summary : ''
  const status = runtimeEventStatus(value?.status, fallbackStatus)
  const signature = `${status}:${summary}`
  if (state.plans.get(id) === signature) return null
  state.plans.set(id, signature)
  return {
    id,
    type: 'plan',
    title: 'plan',
    status,
    ...(summary ? { summary } : {}),
  }
}

function toolStartLifecycleEvent(state, block, fallbackId = '') {
  const id = String(block?.id || block?.tool_use_id || fallbackId)
  const title = runtimeToolTitle({ type: 'tool_use', name: block?.name })
  const summary = runtimeToolOperation(block)
  if (id && state.startedTools.has(id)) {
    const previous = state.toolSummaries.get(id) || ''
    const generic = !previous || previous === String(block?.name || '')
      || previous === state.toolTitles.get(id)
    if (!generic || !summary || summary.length <= previous.length) return null
    state.toolSummaries.set(id, summary)
    state.toolTitles.set(id, title)
    return {
      id,
      type: 'tool_update',
      title,
      status: 'running',
      summary,
    }
  }
  if (id) {
    state.startedTools.add(id)
    state.toolSummaries.set(id, summary)
    state.toolTitles.set(id, title)
  }
  return {
    ...(id ? { id } : {}),
    type: 'tool_start',
    title,
    status: 'running',
    ...(summary ? { summary } : {}),
  }
}

function toolResultLifecycleEvent(state, block, fallbackId = '') {
  const id = String(block?.tool_use_id || block?.toolUseId || block?.id || fallbackId)
  if (id && state.completedTools.has(id)) return null
  if (id) state.completedTools.add(id)
  for (const [key, blockId] of state.blockIds) {
    if (blockId === id) state.blockIds.delete(key)
  }
  state.blocks.delete(id)
  return {
    ...(id ? { id } : {}),
    type: 'tool_result_summary',
    title: state.toolTitles.get(id) || runtimeToolTitle({ type: 'tool_result' }),
    status: block?.is_error || block?.isError ? 'failed' : 'completed',
    ...(state.toolSummaries.get(id) ? { summary: state.toolSummaries.get(id) } : {}),
    ...(runtimeToolResultDetail(block) ? { detail: runtimeToolResultDetail(block) } : {}),
  }
}

function claudeQwenRuntimeEvents(event, state) {
  if (!event || typeof event !== 'object') return []
  if (event.type === 'stream_event') {
    const update = event.event
    if (!update || typeof update !== 'object') return []
    const parent = event.parent_tool_use_id || 'root'
    if (update.type === 'message_start' && typeof update.message?.id === 'string') {
      state.messageIds.set(parent, update.message.id)
      return []
    }
    const messageId = update.message_id || state.messageIds.get(parent) || ''
    const blockKey = streamBlockKey(event, update.index, messageId)
    let id = state.blockIds.get(blockKey) || streamBlockId(event, update, update.index, messageId)
    if (update.type === 'content_block_start') {
      const block = update.content_block
      if (!block || typeof block !== 'object') return []
      if (typeof block.id === 'string' && block.id) id = block.id
      state.blocks.set(id, block)
      state.blockIds.set(blockKey, id)
      if (block.type === 'tool_use') {
        return [toolStartLifecycleEvent(state, block, id)].filter(Boolean)
      }
      if (block.type === 'thinking') {
        return [reasoningLifecycleEvent(state, `reasoning:${id}`, 'running')].filter(Boolean)
      }
      if (block.type === 'plan') {
        return [planLifecycleEvent(state, block, `plan:${id}`)].filter(Boolean)
      }
      return []
    }
    if (update.type === 'content_block_delta') {
      if ((event.parent_tool_use_id == null || event.parent_tool_use_id === '')
          && update.delta?.type === 'text_delta' && typeof update.delta.text === 'string') {
        return [{ type: 'answer_delta', status: 'running', delta: update.delta.text }]
      }
      if (update.delta?.type === 'input_json_delta' && state.blocks.get(id)?.type === 'tool_use') {
        return [{
          id,
          type: 'tool_update',
          title: state.toolTitles.get(id) || runtimeToolTitle({ type: 'tool_use' }),
          status: 'running',
          ...(state.toolSummaries.get(id) ? { summary: state.toolSummaries.get(id) } : {}),
        }]
      }
      if (update.delta?.type === 'thinking_delta') {
        return [reasoningLifecycleEvent(state, `reasoning:${id}`, 'running')].filter(Boolean)
      }
      return []
    }
    if (update.type === 'content_block_stop') {
      const block = state.blocks.get(id)
      clearStreamBlock(state, blockKey, id)
      if (block?.type === 'thinking') {
        return [reasoningLifecycleEvent(state, `reasoning:${id}`, 'completed')].filter(Boolean)
      }
    }
    return []
  }

  const events = []
  if (event.type === 'assistant') {
    streamMessageBlocks(event).forEach((block, index) => {
      const id = streamBlockId(event, null, index)
      if (block?.type === 'tool_use') {
        events.push(toolStartLifecycleEvent(state, block, id))
      } else if (block?.type === 'thinking') {
        events.push(reasoningLifecycleEvent(state, `reasoning:${id}`, 'completed'))
      } else if (block?.type === 'reasoning_summary') {
        events.push(reasoningLifecycleEvent(
          state,
          `reasoning:${id}`,
          runtimeEventStatus(block.status, 'completed'),
          typeof block.summary === 'string' ? block.summary : '',
        ))
      } else if (block?.type === 'plan') {
        events.push(planLifecycleEvent(state, block, `plan:${id}`, 'completed'))
      }
    })
  } else if (event.type === 'user') {
    streamMessageBlocks(event).forEach((block, index) => {
      if (block?.type === 'tool_result') {
        events.push(toolResultLifecycleEvent(state, block, streamBlockId(event, null, index)))
      }
    })
  } else if (event.type === 'tool_use') {
    events.push(toolStartLifecycleEvent(state, event))
  } else if (event.type === 'tool_result') {
    events.push(toolResultLifecycleEvent(state, event))
  } else if (['plan', 'plan_update'].includes(event.type)) {
    events.push(planLifecycleEvent(state, event, String(event.id || 'plan')))
  } else if (event.type === 'reasoning_summary') {
    events.push(reasoningLifecycleEvent(
      state,
      String(event.id || 'reasoning'),
      runtimeEventStatus(event.status, 'running'),
      typeof event.summary === 'string' ? event.summary : '',
    ))
  }
  return events.filter(Boolean)
}

function kimiStreamJsonRuntimeEvents(event) {
  if (!event || typeof event !== 'object') return []
  if (event.role === 'assistant' && typeof event.content === 'string') {
    return [{ type: 'answer_delta', status: 'running', delta: event.content }]
  }
  return []
}

function mimoJsonRuntimeEvents(event) {
  if (!event || typeof event !== 'object') return []
  if (event.type === 'text' && typeof event.part?.text === 'string') {
    return [{ type: 'answer_delta', status: 'running', delta: event.part.text }]
  }
  return []
}

function geminiToolId(event) {
  return typeof event?.tool_id === 'string' && event.tool_id ? event.tool_id : ''
}

function geminiStreamJsonRuntimeEvents(event, state) {
  if (!event || typeof event !== 'object') return []
  if (event.type === 'message' && event.role === 'assistant'
      && typeof event.content === 'string') {
    return [{ type: 'answer_delta', status: 'running', delta: event.content }]
  }
  const id = geminiToolId(event)
  if (!id) return []
  if (event.type === 'tool_use') {
    const tool = { ...event, id, name: event.tool_name, input: event.parameters }
    const summary = runtimeToolOperation(tool)
    const title = runtimeToolTitle(tool)
    state?.toolSummaries.set(id, summary)
    state?.toolTitles.set(id, title)
    return [{
      id,
      type: 'tool_start',
      title,
      status: 'running',
      ...(summary ? { summary } : {}),
    }]
  }
  if (event.type === 'tool_result' && ['success', 'error'].includes(event.status)) {
    if (state?.completedTools.has(id)) return []
    state?.completedTools.add(id)
    const detail = runtimeToolResultDetail(event)
    return [{
      id,
      type: 'tool_result_summary',
      title: state?.toolTitles.get(id) || runtimeToolTitle(event),
      status: event.status === 'success' ? 'completed' : 'failed',
      ...(state?.toolSummaries.get(id) ? { summary: state.toolSummaries.get(id) } : {}),
      ...(detail ? { detail } : {}),
    }]
  }
  return []
}

function openCodeJsonRuntimeEvents(event) {
  if (!event || typeof event !== 'object') return []
  if (event.type === 'text' && event.part?.type === 'text'
      && typeof event.part.text === 'string') {
    return [{ type: 'answer_delta', status: 'running', delta: event.part.text }]
  }
  return []
}

function createPiRuntimeState() {
  return {
    reasoning: new Map(),
    tools: new Map(),
  }
}

function piJsonRuntimeEvents(event, state) {
  if (!event || typeof event !== 'object') return []
  const update = event.assistantMessageEvent
  if (event.type === 'message_update' && update && typeof update === 'object') {
    const index = Number.isInteger(update.contentIndex) ? update.contentIndex : 0
    const id = `content:${index}`
    if (update.type === 'thinking_start') {
      state.reasoning.set(id, '')
      return [{ id, type: 'reasoning_summary', title: 'reasoning', status: 'running' }]
    }
    if (update.type === 'thinking_delta' && typeof update.delta === 'string') {
      const summary = `${state.reasoning.get(id) || ''}${update.delta}`.slice(-2000)
      state.reasoning.set(id, summary)
      return [{ id, type: 'reasoning_summary', title: 'reasoning', status: 'running', summary }]
    }
    if (update.type === 'thinking_end') {
      const summary = String(update.content || state.reasoning.get(id) || '').trim()
      state.reasoning.set(id, summary)
      return [{ id, type: 'reasoning_summary', title: 'reasoning', status: 'completed', ...(summary ? { summary } : {}) }]
    }
    if (update.type === 'text_delta' && typeof update.delta === 'string') {
      return [{ type: 'answer_delta', status: 'running', delta: update.delta }]
    }
    if (['toolcall_start', 'tool_call_start'].includes(update.type)) {
      const toolId = String(update.toolCallId || update.id || `tool:${index}`)
      const title = String(update.toolName || update.name || 'tool')
      state.tools.set(toolId, title)
      return [{ id: toolId, type: 'tool_start', title, status: 'running' }]
    }
    if (['toolcall_end', 'tool_call_end'].includes(update.type)) {
      const toolId = String(update.toolCallId || update.id || `tool:${index}`)
      return [{
        id: toolId,
        type: 'tool_result_summary',
        title: state.tools.get(toolId) || String(update.toolName || update.name || 'tool'),
        status: update.isError === true || update.error ? 'failed' : 'completed',
      }]
    }
  }
  if (event.type === 'tool_execution_start' || event.type === 'tool_start') {
    const id = String(event.toolCallId || event.id || 'tool')
    const title = String(event.toolName || event.name || 'tool')
    state.tools.set(id, title)
    return [{ id, type: 'tool_start', title, status: 'running' }]
  }
  if (event.type === 'tool_execution_end' || event.type === 'tool_end') {
    const id = String(event.toolCallId || event.id || 'tool')
    return [{
      id,
      type: 'tool_result_summary',
      title: state.tools.get(id) || String(event.toolName || event.name || 'tool'),
      status: event.isError === true || event.error ? 'failed' : 'completed',
    }]
  }
  return []
}

function finalOnlyRuntimeEvents() {
  return []
}

function acpPlanSummary(update) {
  const plan = update.sessionUpdate === 'plan_update' ? update.plan : update
  if (Array.isArray(plan?.entries)) {
    return plan.entries.slice(0, 12).map(entry => {
      const status = runtimeEventStatus(entry?.status)
      return `${status ? `[${status}] ` : ''}${String(entry?.content || '')}`
    }).filter(Boolean).join('\n')
  }
  return typeof plan?.content === 'string' ? plan.content : ''
}

function createAcpRuntimeState() {
  return { tools: new Map(), reasoning: new Map() }
}

const ACP_TOOL_KINDS = new Set([
  'read', 'edit', 'delete', 'move', 'search',
  'execute', 'think', 'fetch', 'switch_mode', 'other',
])

function acpToolOperation(update) {
  const name = ACP_TOOL_KINDS.has(update.kind) ? update.kind : 'tool'
  const input = update.rawInput ?? update.input ?? update.arguments ?? update.args
  if (typeof update.command === 'string'
      || (input && typeof input === 'object' && !Array.isArray(input)
        && (Object.hasOwn(input, 'command') || Object.hasOwn(input, 'cmd')))) {
    return `${name}: [operation hidden]`
  }
  return runtimeToolOperation({ ...update, name, title: undefined })
}

function acpRuntimeEvents(update, state) {
  if (!update || typeof update !== 'object') return []
  if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
    // Close an open reasoning phase once the visible answer starts.
    const closed = state?.reasoning?.get('reasoning:acp')?.startsWith('running:')
      ? reasoningLifecycleEvent(state, 'reasoning:acp', 'completed')
      : null
    return [
      ...(closed ? [closed] : []),
      { type: 'answer_delta', status: 'running', delta: update.content.text },
    ]
  }
  if (update.sessionUpdate === 'agent_thought_chunk' && update.content?.type === 'text') {
    // Thinking is real progress: report a text-free reasoning status so the
    // watchdog and the trace know the Agent is working. The private thought
    // text itself never leaves the main process.
    if (!state?.reasoning) return []
    const event = reasoningLifecycleEvent(state, 'reasoning:acp', 'running')
    return event ? [event] : []
  }
  if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
    const status = runtimeEventStatus(update.status)
    const completed = ['completed', 'failed', 'stopped', 'timeout'].includes(status)
    const id = String(update.toolCallId || '')
    const operation = acpToolOperation(update)
    if (id && operation && update.sessionUpdate === 'tool_call') state?.tools.set(id, operation)
    const summary = state?.tools.get(id) || operation
    const detail = completed ? runtimeToolResultDetail(update) : ''
    return [{
      id,
      type: completed
        ? 'tool_result_summary'
        : update.sessionUpdate === 'tool_call' ? 'tool_start' : 'tool_update',
      title: runtimeToolTitle(update),
      status: status || (update.sessionUpdate === 'tool_call' ? 'running' : 'waiting'),
      ...(summary ? { summary } : {}),
      ...(detail ? { detail } : {}),
    }]
  }
  if (['plan', 'plan_update', 'plan_removed'].includes(update.sessionUpdate)) {
    const summary = acpPlanSummary(update)
    return [{
      id: update.id || update.plan?.id,
      type: 'plan',
      title: 'plan',
      status: update.sessionUpdate === 'plan_removed' ? 'stopped' : 'running',
      ...(summary ? { summary } : {}),
    }]
  }
  return []
}

module.exports = {
  acpRuntimeEvents,
  claudeQwenRuntimeEvents,
  codexRuntimeEvents,
  createAcpRuntimeState,
  createClaudeQwenRuntimeState,
  createGeminiRuntimeState,
  finalOnlyRuntimeEvents,
  geminiStreamJsonRuntimeEvents,
  kimiStreamJsonRuntimeEvents,
  mimoJsonRuntimeEvents,
  openCodeJsonRuntimeEvents,
  piJsonRuntimeEvents,
  createPiRuntimeState,
}

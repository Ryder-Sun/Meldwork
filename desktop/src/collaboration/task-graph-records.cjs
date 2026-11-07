const { createHash } = require('node:crypto')
const { z } = require('zod')

const { canonicalJson } = require('./context-pack-records.cjs')
const { redactSecrets } = require('../security/secret-redaction.cjs')

const TASK_GRAPH_VERSION = 1
const TASK_GRAPH_CURSOR_VERSION = 1
const MAX_GRAPH_NODES = 32
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const GRAPH_ID = /^task-graph-[a-f0-9]{64}$/
const OUTCOME_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const SHA256 = /^[a-f0-9]{64}$/
const ROLES = ['primary', 'reviewer', 'arbiter', 'human']
const STATUSES = ['pending', 'running', 'waiting', 'accepted', 'rejected', 'failed']
const ATTENTION_STATES = ['none', 'review', 'decision']
const TERMINAL_STATES = ['running', 'accepted', 'rejected', 'failed']

function taskGraphError(code) {
  return Object.assign(new Error(code), { code })
}

function fail(code) {
  throw taskGraphError(code)
}

function uniqueArray(schema, max = MAX_GRAPH_NODES) {
  return z.array(schema).max(max).superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message: 'duplicate value' })
    }
  })
}

const publicIdSchema = z.string().regex(PUBLIC_ID)
const boundedTextSchema = z.string().min(1).max(2000).superRefine((value, context) => {
  if (redactSecrets(value) !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    context.addIssue({ code: 'custom', message: 'unsafe text' })
  }
})
const acceptanceSchema = z.strictObject({
  requireConclusion: z.boolean(),
  minArtifactRefs: z.number().int().min(0).max(16),
  minEvidenceRefs: z.number().int().min(0).max(16),
})
const decisionOptionSchema = z.strictObject({
  optionId: publicIdSchema,
  name: z.string().min(1).max(160),
  kind: z.enum(['allow_once', 'reject_once']),
})
const nodeContentFields = {
  nodeId: publicIdSchema,
  role: z.enum(ROLES),
  agentKind: publicIdSchema.nullable(),
  dependsOn: uniqueArray(publicIdSchema),
  inputNodeIds: uniqueArray(publicIdSchema),
  expectedOutput: boundedTextSchema,
  claimKey: publicIdSchema.optional(),
  acceptance: acceptanceSchema,
  terminal: z.boolean(),
  parallel: z.boolean(),
  decisionOptions: uniqueArray(decisionOptionSchema, 16),
}
const nodeSchema = z.strictObject(nodeContentFields).superRefine((node, context) => {
  if (node.claimKey !== undefined && (node.role !== 'primary' || redactSecrets(node.claimKey) !== node.claimKey)) {
    context.addIssue({ code: 'custom', path: ['claimKey'], message: 'invalid claim key' })
  }
  if (node.inputNodeIds.some(nodeId => !node.dependsOn.includes(nodeId))) {
    context.addIssue({ code: 'custom', path: ['inputNodeIds'], message: 'input must be a dependency' })
  }
  if (node.dependsOn.includes(node.nodeId)) {
    context.addIssue({ code: 'custom', path: ['dependsOn'], message: 'self dependency' })
  }
  if (node.role === 'human') {
    if (node.agentKind !== null || node.parallel || node.acceptance.requireConclusion
        || node.acceptance.minArtifactRefs || node.acceptance.minEvidenceRefs
        || node.decisionOptions.length < 2) {
      context.addIssue({ code: 'custom', message: 'invalid human node' })
    }
  } else if (!node.agentKind || node.decisionOptions.length) {
    context.addIssue({ code: 'custom', message: 'invalid Agent node' })
  }
})
const graphContentFields = {
  template: z.literal('task-graph'),
  nodes: z.array(nodeSchema).min(1).max(MAX_GRAPH_NODES),
}
const graphInputSchema = z.strictObject(graphContentFields)
const graphRecordSchema = z.strictObject({
  graphId: z.string().regex(GRAPH_ID),
  version: z.literal(TASK_GRAPH_VERSION),
  recordType: z.literal('task-graph'),
  ...graphContentFields,
})

const nodeStateSchema = z.strictObject({
  nodeId: publicIdSchema,
  status: z.enum(STATUSES),
  attention: z.enum(ATTENTION_STATES),
  attempts: z.number().int().min(0).max(1000),
  entryIds: uniqueArray(publicIdSchema, 128),
  artifactIds: uniqueArray(z.string().regex(OUTCOME_ID), 128),
  evidenceIds: uniqueArray(z.string().regex(OUTCOME_ID), 128),
  conclusionHash: z.union([z.literal(''), z.string().regex(SHA256)]),
  decisionOptionId: z.union([z.literal(''), publicIdSchema]),
  updatedAt: z.number().int().min(0),
})
const cursorSchema = z.strictObject({
  version: z.literal(TASK_GRAPH_CURSOR_VERSION),
  graph: graphRecordSchema,
  nodeStates: z.array(nodeStateSchema).min(1).max(MAX_GRAPH_NODES),
  currentNodeIds: uniqueArray(publicIdSchema),
  terminalState: z.enum(TERMINAL_STATES),
})

function deriveId(prefix, body) {
  return `${prefix}-${createHash('sha256').update(canonicalJson(body)).digest('hex')}`
}

function validateGraphRelations(graph, targetKinds = null) {
  const nodeIds = new Set(graph.nodes.map(node => node.nodeId))
  if (nodeIds.size !== graph.nodes.length || !graph.nodes.some(node => node.terminal)) {
    fail('TASK_GRAPH_SCHEMA_INVALID')
  }
  const allowedKinds = targetKinds ? new Set(targetKinds) : null
  const terminalIds = new Set(graph.nodes.filter(node => node.terminal).map(node => node.nodeId))
  for (const node of graph.nodes) {
    if (node.dependsOn.some(nodeId => !nodeIds.has(nodeId))
        || node.inputNodeIds.some(nodeId => !nodeIds.has(nodeId))
        || new Set(node.decisionOptions.map(option => option.optionId)).size !== node.decisionOptions.length
        || (allowedKinds && node.agentKind && !allowedKinds.has(node.agentKind))) {
      fail('TASK_GRAPH_SCHEMA_INVALID')
    }
  }
  const visiting = new Set()
  const visited = new Set()
  const byId = new Map(graph.nodes.map(node => [node.nodeId, node]))
  const visit = (nodeId) => {
    if (visiting.has(nodeId)) fail('TASK_GRAPH_CYCLE')
    if (visited.has(nodeId)) return
    visiting.add(nodeId)
    for (const dependency of byId.get(nodeId).dependsOn) visit(dependency)
    visiting.delete(nodeId)
    visited.add(nodeId)
  }
  for (const node of graph.nodes) visit(node.nodeId)
  if (graph.nodes.some(node => !node.terminal && node.dependsOn.some(nodeId => terminalIds.has(nodeId)))) {
    fail('TASK_GRAPH_SCHEMA_INVALID')
  }
}

function createTaskGraph(input, targetKinds = null) {
  const parsed = graphInputSchema.safeParse(input)
  if (!parsed.success) fail('TASK_GRAPH_SCHEMA_INVALID')
  if (parsed.data.nodes.some(node => node.role === 'human'
      && (!node.decisionOptions.some(option => option.kind === 'allow_once')
        || !node.decisionOptions.some(option => option.kind === 'reject_once')))) {
    fail('TASK_GRAPH_SCHEMA_INVALID')
  }
  const body = {
    version: TASK_GRAPH_VERSION,
    recordType: 'task-graph',
    ...parsed.data,
  }
  const graph = JSON.parse(canonicalJson({ graphId: deriveId('task-graph', body), ...body }))
  validateGraphRelations(graph, targetKinds)
  return graph
}

function parseTaskGraph(input, targetKinds = null) {
  const parsed = graphRecordSchema.safeParse(input)
  if (!parsed.success) fail('TASK_GRAPH_SCHEMA_INVALID')
  const graph = JSON.parse(canonicalJson(parsed.data))
  const { graphId, ...body } = graph
  if (deriveId('task-graph', body) !== graphId) fail('TASK_GRAPH_ID_MISMATCH')
  validateGraphRelations(graph, targetKinds)
  return graph
}

function createTaskGraphCursor(graphInput, now = Date.now()) {
  const graph = parseTaskGraph(graphInput)
  return parseTaskGraphCursor({
    version: TASK_GRAPH_CURSOR_VERSION,
    graph,
    nodeStates: graph.nodes.map(node => ({
      nodeId: node.nodeId,
      status: 'pending',
      attention: 'none',
      attempts: 0,
      entryIds: [],
      artifactIds: [],
      evidenceIds: [],
      conclusionHash: '',
      decisionOptionId: '',
      updatedAt: now,
    })),
    currentNodeIds: [],
    terminalState: 'running',
  })
}

function legacyTerminalStateFor(graph, nodeStates) {
  const states = new Map(nodeStates.map(state => [state.nodeId, state]))
  const terminal = graph.nodes.filter(node => node.terminal)
  if (terminal.every(node => states.get(node.nodeId)?.status === 'accepted')) return 'accepted'
  if (terminal.some(node => states.get(node.nodeId)?.status === 'rejected')) return 'rejected'
  if (nodeStates.some(state => state.status === 'failed')) return 'failed'
  return 'running'
}

function terminalStateFor(graph, nodeStates) {
  if (nodeStates.some(state => state.status === 'rejected')) return 'rejected'
  if (nodeStates.some(state => state.status === 'failed')) return 'failed'
  if (nodeStates.every(state => state.status === 'accepted')) return 'accepted'
  return 'running'
}

function parseTaskGraphCursor(input, targetKinds = null) {
  const parsed = cursorSchema.safeParse(input)
  if (!parsed.success) fail('TASK_GRAPH_CURSOR_INVALID')
  const cursor = JSON.parse(canonicalJson(parsed.data))
  const graph = parseTaskGraph(cursor.graph, targetKinds)
  const nodeIds = graph.nodes.map(node => node.nodeId)
  if (cursor.nodeStates.length !== nodeIds.length
      || cursor.nodeStates.some((state, index) => state.nodeId !== nodeIds[index])
      || cursor.currentNodeIds.some(nodeId => !nodeIds.includes(nodeId))) {
    fail('TASK_GRAPH_CURSOR_INVALID')
  }
  const currentIds = new Set(cursor.currentNodeIds)
  if (cursor.nodeStates.some(state => (
    currentIds.has(state.nodeId)
      ? !['running', 'waiting'].includes(state.status)
      : ['running', 'waiting'].includes(state.status)
  ))) fail('TASK_GRAPH_CURSOR_INVALID')
  if (cursor.terminalState !== terminalStateFor(graph, cursor.nodeStates)
      && cursor.terminalState !== legacyTerminalStateFor(graph, cursor.nodeStates)) {
    fail('TASK_GRAPH_CURSOR_INVALID')
  }
  return { ...cursor, graph }
}

function assertTaskGraphDependencies(cursorInput) {
  const cursor = parseTaskGraphCursor(cursorInput)
  const states = new Map(cursor.nodeStates.map(state => [state.nodeId, state.status]))
  if (cursor.graph.nodes.some(node => states.get(node.nodeId) !== 'pending'
      && node.dependsOn.some(id => states.get(id) !== 'accepted'))) {
    fail('TASK_GRAPH_CURSOR_INVALID')
  }
  return cursor
}

function updateTaskGraphCursor(cursorInput, nodeId, updates, now = Date.now()) {
  const cursor = parseTaskGraphCursor(cursorInput)
  const index = cursor.nodeStates.findIndex(state => state.nodeId === nodeId)
  if (index < 0) fail('TASK_GRAPH_NODE_UNKNOWN')
  const nodeStates = cursor.nodeStates.map((state, stateIndex) => (
    stateIndex === index ? { ...state, ...updates, nodeId, updatedAt: now } : state
  ))
  const currentNodeIds = nodeStates
    .filter(state => ['running', 'waiting'].includes(state.status))
    .map(state => state.nodeId)
  return assertTaskGraphDependencies({
    ...cursor,
    nodeStates,
    currentNodeIds,
    terminalState: terminalStateFor(cursor.graph, nodeStates),
  })
}

function taskGraphNode(cursorInput, nodeId) {
  const cursor = parseTaskGraphCursor(cursorInput)
  return cursor.graph.nodes.find(node => node.nodeId === nodeId) || null
}

function readyTaskGraphNodes(cursorInput) {
  const cursor = parseTaskGraphCursor(cursorInput)
  const states = new Map(cursor.nodeStates.map(state => [state.nodeId, state]))
  return cursor.graph.nodes.filter(node => (
    states.get(node.nodeId).status === 'pending'
    && node.dependsOn.every(nodeId => states.get(nodeId)?.status === 'accepted')
  ))
}

function terminalTaskGraphState(cursorInput) {
  const cursor = parseTaskGraphCursor(cursorInput)
  return terminalStateFor(cursor.graph, cursor.nodeStates)
}

module.exports = {
  ATTENTION_STATES,
  ROLES,
  STATUSES,
  TASK_GRAPH_CURSOR_VERSION,
  TASK_GRAPH_VERSION,
  createTaskGraph,
  createTaskGraphCursor,
  assertTaskGraphDependencies,
  parseTaskGraph,
  parseTaskGraphCursor,
  readyTaskGraphNodes,
  taskGraphNode,
  terminalTaskGraphState,
  updateTaskGraphCursor,
}

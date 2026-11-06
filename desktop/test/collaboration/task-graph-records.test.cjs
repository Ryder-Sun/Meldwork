const test = require('node:test')
const assert = require('node:assert/strict')
const { taskGraphMethods } = require('../../src/workspace/local-workspace-auto-runner-task-graph.cjs')

const {
  createTaskGraph,
  createTaskGraphCursor,
  parseTaskGraph,
  parseTaskGraphCursor,
  readyTaskGraphNodes,
  terminalTaskGraphState,
  updateTaskGraphCursor,
} = require('../../src/collaboration/task-graph-records.cjs')

function node(overrides = {}) {
  return {
    nodeId: 'primary-codex',
    role: 'primary',
    agentKind: 'codex',
    dependsOn: [],
    inputNodeIds: [],
    expectedOutput: 'Produce one evidence-backed conclusion.',
    acceptance: {
      requireConclusion: true,
      minArtifactRefs: 1,
      minEvidenceRefs: 1,
    },
    terminal: false,
    parallel: true,
    decisionOptions: [],
    ...overrides,
  }
}

function workflow() {
  return {
    template: 'task-graph',
    nodes: [
      node(),
      node({
        nodeId: 'review-hermes',
        role: 'reviewer',
        agentKind: 'hermes',
        dependsOn: ['primary-codex'],
        inputNodeIds: ['primary-codex'],
        expectedOutput: 'Review the Primary result independently.',
        terminal: true,
        parallel: false,
      }),
    ],
  }
}

test('creates content-addressed acyclic task graphs and durable cursors', () => {
  const graph = createTaskGraph(workflow(), ['codex', 'hermes'])
  assert.match(graph.graphId, /^task-graph-[a-f0-9]{64}$/)
  assert.deepEqual(parseTaskGraph(graph, ['codex', 'hermes']), graph)

  let cursor = createTaskGraphCursor(graph, 1000)
  assert.deepEqual(readyTaskGraphNodes(cursor).map(candidate => candidate.nodeId), [
    'primary-codex',
  ])
  cursor = updateTaskGraphCursor(cursor, 'primary-codex', {
    status: 'running', attempts: 1,
  }, 1100)
  assert.deepEqual(cursor.currentNodeIds, ['primary-codex'])
  cursor = updateTaskGraphCursor(cursor, 'primary-codex', {
    status: 'accepted',
    entryIds: [`blackboard-entry-${'a'.repeat(64)}`],
    artifactIds: [`artifact-${'b'.repeat(64)}`],
    evidenceIds: [`evidence-${'c'.repeat(64)}`],
    conclusionHash: 'd'.repeat(64),
  }, 1200)
  assert.deepEqual(readyTaskGraphNodes(cursor).map(candidate => candidate.nodeId), [
    'review-hermes',
  ])
  cursor = updateTaskGraphCursor(cursor, 'review-hermes', {
    status: 'accepted', attempts: 1,
  }, 1300)
  assert.equal(terminalTaskGraphState(cursor), 'accepted')
  assert.deepEqual(parseTaskGraphCursor({ ...cursor, terminalState: 'accepted' }), {
    ...cursor,
    terminalState: 'accepted',
  })
})

test('nonterminal human rejection ends the graph and legacy cursors remain recoverable', () => {
  const graph = createTaskGraph({ template: 'task-graph', nodes: [
    node({ nodeId: 'decision', role: 'human', agentKind: null, parallel: false,
      acceptance: { requireConclusion: false, minArtifactRefs: 0, minEvidenceRefs: 0 },
      decisionOptions: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' },
        { optionId: 'no', name: 'No', kind: 'reject_once' }] }),
    node({ nodeId: 'after', dependsOn: ['decision'], inputNodeIds: ['decision'], terminal: true }),
  ] })
  let cursor = createTaskGraphCursor(graph)
  cursor = updateTaskGraphCursor(cursor, 'decision', { status: 'rejected', decisionOptionId: 'no' })
  assert.equal(cursor.terminalState, 'rejected')
  const legacy = { ...cursor, terminalState: 'running' }
  assert.equal(parseTaskGraphCursor(legacy).terminalState, 'running')
  assert.equal(terminalTaskGraphState(legacy), 'rejected')
})

test('terminal acceptance cannot hide unfinished or failed graph nodes, including legacy cursors', () => {
  const graph = createTaskGraph({ template: 'task-graph', nodes: [
    node({ nodeId: 'independent' }),
    node({ nodeId: 'terminal', agentKind: 'hermes', terminal: true }),
  ] })
  let cursor = createTaskGraphCursor(graph)
  cursor = updateTaskGraphCursor(cursor, 'terminal', { status: 'accepted' })
  assert.equal(terminalTaskGraphState(cursor), 'running')
  const legacy = { ...cursor, terminalState: 'accepted' }
  assert.equal(parseTaskGraphCursor(legacy).terminalState, 'accepted')
  assert.equal(terminalTaskGraphState(legacy), 'running')
  assert.deepEqual(readyTaskGraphNodes(legacy).map(candidate => candidate.nodeId), ['independent'])
  const failed = updateTaskGraphCursor(legacy, 'independent', { status: 'failed' })
  assert.equal(terminalTaskGraphState(failed), 'failed')
  const completed = updateTaskGraphCursor(legacy, 'independent', { status: 'accepted' })
  assert.equal(terminalTaskGraphState(completed), 'accepted')
})

test('runner normalizes legacy success before applying the round limit', async () => {
  const graph = createTaskGraph({ template: 'task-graph', nodes: [
    node({ nodeId: 'independent' }),
    node({ nodeId: 'terminal', agentKind: 'hermes', terminal: true }),
  ] })
  const cursor = updateTaskGraphCursor(createTaskGraphCursor(graph), 'terminal', { status: 'accepted' })
  const controller = { signal: { aborted: false }, unlimitedRounds: false, currentRound: 1, maxRounds: 1,
    orchestration: { taskGraph: { ...cursor, terminalState: 'accepted' } } }
  const runner = {
    checkpointTaskGraph(_group, current, value) {
      const normalized = { ...value, terminalState: terminalTaskGraphState(value) }
      current.orchestration.taskGraph = normalized
      return normalized
    },
  }
  const status = await taskGraphMethods.runTaskGraph.call(runner, {}, controller, '', {})
  assert.equal(status, 'round-limit')
  assert.equal(controller.orchestration.taskGraph.terminalState, 'running')
})

test('only primary nodes can declare a safe claim key and it survives graph serialization', () => {
  const input = workflow()
  input.nodes[0].claimKey = 'security-review'
  const graph = createTaskGraph(input, ['codex', 'hermes'])
  assert.equal(parseTaskGraph(graph).nodes[0].claimKey, 'security-review')
  const invalid = workflow()
  invalid.nodes[1].claimKey = 'security-review'
  assert.throws(() => createTaskGraph(invalid, ['codex', 'hermes']), /TASK_GRAPH_SCHEMA_INVALID/)
})

test('rejects cycles, unknown Agents, malformed Human decisions, and tampering', () => {
  assert.throws(() => createTaskGraph({
    template: 'task-graph',
    nodes: [
      node({ nodeId: 'a', dependsOn: ['b'], inputNodeIds: ['b'], terminal: true }),
      node({ nodeId: 'b', agentKind: 'hermes', dependsOn: ['a'], inputNodeIds: ['a'] }),
    ],
  }, ['codex', 'hermes']), { message: 'TASK_GRAPH_CYCLE' })
  assert.throws(() => createTaskGraph(workflow(), ['codex']), {
    message: 'TASK_GRAPH_SCHEMA_INVALID',
  })
  assert.throws(() => createTaskGraph({
    template: 'task-graph',
    nodes: [node({
      nodeId: 'human', role: 'human', agentKind: null, terminal: true, parallel: false,
      acceptance: { requireConclusion: false, minArtifactRefs: 0, minEvidenceRefs: 0 },
      decisionOptions: [{ optionId: 'accept', name: 'Accept', kind: 'allow_once' }],
    })],
  }), { message: 'TASK_GRAPH_SCHEMA_INVALID' })

  const graph = createTaskGraph(workflow())
  assert.throws(() => parseTaskGraph({ ...graph, graphId: `task-graph-${'0'.repeat(64)}` }), {
    message: 'TASK_GRAPH_ID_MISMATCH',
  })
})

const test = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { canonicalJson } = require('../../src/collaboration/context-pack-records.cjs')
const { taskGraphMethods } = require('../../src/workspace/local-workspace-auto-runner-task-graph.cjs')

const {
  createTaskGraph,
  createTaskGraphCursor,
  assertTaskGraphDependencies,
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

test('new task graphs reject human decision summaries that cannot be displayed', () => {
  const human = node({ nodeId: 'human', role: 'human', agentKind: null, terminal: true, parallel: false,
    acceptance: { requireConclusion: false, minArtifactRefs: 0, minEvidenceRefs: 0 },
    decisionOptions: [{ optionId: 'approve', name: 'Approve', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' }] })
  for (const expectedOutput of [' '.repeat(8), 'x'.repeat(501)]) {
    assert.throws(() => createTaskGraph({ template: 'task-graph', nodes: [{ ...human, expectedOutput }] }),
      { message: 'TASK_GRAPH_SCHEMA_INVALID' })
  }
  const valid = createTaskGraph({ template: 'task-graph', nodes: [{ ...human, expectedOutput: 'x'.repeat(500) }] })
  const { graphId, ...body } = { ...valid, nodes: [{ ...valid.nodes[0], expectedOutput: 'x'.repeat(501) }] }
  const legacy = { ...body, graphId: `task-graph-${createHash('sha256').update(canonicalJson(body)).digest('hex')}` }
  assert.deepEqual(parseTaskGraph(legacy), legacy)
})

test('restored task graphs enforce the same decision and terminal constraints as new graphs', () => {
  const graph = createTaskGraph(workflow())
  const signed = nodes => {
    const { graphId, ...body } = { ...graph, nodes }
    return { ...body, graphId: `task-graph-${createHash('sha256').update(canonicalJson(body)).digest('hex')}` }
  }
  const terminalDependency = signed([
    { ...graph.nodes[0], dependsOn: ['review-hermes'] },
    { ...graph.nodes[1], dependsOn: [], inputNodeIds: [] },
  ])
  const duplicateDecision = signed([
    { ...graph.nodes[0], role: 'human', agentKind: null, parallel: false,
      acceptance: { requireConclusion: false, minArtifactRefs: 0, minEvidenceRefs: 0 },
      decisionOptions: [{ optionId: 'same', name: 'Yes', kind: 'allow_once' },
        { optionId: 'same', name: 'No', kind: 'reject_once' }] },
    graph.nodes[1],
  ])
  for (const invalid of [terminalDependency, duplicateDecision]) {
    assert.throws(() => parseTaskGraph(invalid), { message: 'TASK_GRAPH_SCHEMA_INVALID' })
    assert.throws(() => parseTaskGraphCursor({ ...createTaskGraphCursor(graph), graph: invalid }),
      { message: 'TASK_GRAPH_SCHEMA_INVALID' })
  }
})

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
    node({ nodeId: 'terminal', agentKind: 'hermes', terminal: true,
      acceptance: { requireConclusion: false, minArtifactRefs: 0, minEvidenceRefs: 0 } }),
  ] })
  const cursor = updateTaskGraphCursor(createTaskGraphCursor(graph), 'terminal', { status: 'accepted' })
  const controller = { signal: { aborted: false }, unlimitedRounds: false, currentRound: 1, maxRounds: 1,
    orchestration: { taskGraph: { ...cursor, terminalState: 'accepted' } } }
  const runner = {
    ...taskGraphMethods,
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

test('cursor rejects work that ran before its dependencies were accepted', () => {
  const graph = createTaskGraph(workflow(), ['codex', 'hermes'])
  const cursor = createTaskGraphCursor(graph)
  for (const status of ['running', 'waiting', 'accepted', 'rejected', 'failed']) {
    assert.throws(() => updateTaskGraphCursor(cursor, 'review-hermes', { status }),
      { message: 'TASK_GRAPH_CURSOR_INVALID' })
  }
  const historical = { ...cursor, nodeStates: cursor.nodeStates.map(state => state.nodeId === 'review-hermes'
    ? { ...state, status: 'accepted' } : state), terminalState: 'accepted' }
  assert.doesNotThrow(() => parseTaskGraphCursor(historical))
  assert.throws(() => assertTaskGraphDependencies(historical), { message: 'TASK_GRAPH_CURSOR_INVALID' })
  const ready = updateTaskGraphCursor(cursor, 'primary-codex', { status: 'accepted' })
  assert.equal(updateTaskGraphCursor(ready, 'review-hermes', { status: 'running' }).nodeStates[1].status, 'running')
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

  for (const kind of ['allow_once', 'reject_once']) {
    assert.throws(() => createTaskGraph({
      template: 'task-graph',
      nodes: [node({
        nodeId: 'human', role: 'human', agentKind: null, terminal: true, parallel: false,
        acceptance: { requireConclusion: false, minArtifactRefs: 0, minEvidenceRefs: 0 },
        decisionOptions: [{ optionId: 'first', name: 'First', kind },
          { optionId: 'second', name: 'Second', kind }],
      })],
    }), { message: 'TASK_GRAPH_SCHEMA_INVALID' })
  }

  const legacyBody = {
    version: 1, recordType: 'task-graph', template: 'task-graph',
    nodes: [node({ nodeId: 'human', role: 'human', agentKind: null, terminal: true, parallel: false,
      acceptance: { requireConclusion: false, minArtifactRefs: 0, minEvidenceRefs: 0 },
      decisionOptions: [{ optionId: 'one', name: 'One', kind: 'allow_once' },
        { optionId: 'two', name: 'Two', kind: 'allow_once' }] })],
  }
  const legacyGraph = { ...legacyBody,
    graphId: `task-graph-${createHash('sha256').update(canonicalJson(legacyBody)).digest('hex')}` }
  assert.equal(parseTaskGraph(legacyGraph).graphId, legacyGraph.graphId)
  assert.throws(() => createTaskGraph({
    template: 'task-graph',
    nodes: [node({
      nodeId: 'human', role: 'human', agentKind: null, terminal: true, parallel: false,
      acceptance: { requireConclusion: false, minArtifactRefs: 0, minEvidenceRefs: 0 },
      decisionOptions: [{ optionId: 'same', name: 'Accept', kind: 'allow_once' },
        { optionId: 'same', name: 'Reject', kind: 'reject_once' }],
    })],
  }), { message: 'TASK_GRAPH_SCHEMA_INVALID' })

  const graph = createTaskGraph(workflow())
  assert.throws(() => parseTaskGraph({ ...graph, graphId: `task-graph-${'0'.repeat(64)}` }), {
    message: 'TASK_GRAPH_ID_MISMATCH',
  })
})

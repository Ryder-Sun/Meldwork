const test = require('node:test')
const assert = require('node:assert/strict')
const {
  attachErrorMetadata,
  attachInvocationFailure,
  resolveInvocationStop,
} = require('../../src/workspace/invocation-failure.cjs')
const {
  recordOutboundUsage,
  recordReplyUsage,
} = require('../../src/workspace/invocation-budget.cjs')
const {
  InvocationOutputs,
  extractReportedOutputPaths,
} = require('../../src/workspace/invocation-outputs.cjs')
const { assembleInvocationPrompt } = require('../../src/workspace/invocation-prompt.cjs')
const { createLegacyOutboundPayload } = require('../../src/collaboration/outbound-payload.cjs')

function stopInputs({ parentAborted = false, stopReason = '', agentAborted = false, timedOut = false } = {}) {
  const signal = { aborted: parentAborted }
  return {
    caughtError: new Error('something broke'),
    signal,
    parentAbortObserved: false,
    activeRun: { stopReason },
    agentController: { signal: { aborted: agentAborted || parentAborted || timedOut } },
    watchdog: { timedOut, error: timedOut ? new Error('LOCAL_AGENT_TIMEOUT') : null },
  }
}

test('an ordinary failure keeps its own error and status', () => {
  const inputs = stopInputs()
  const stop = resolveInvocationStop(inputs)
  assert.equal(stop.error, inputs.caughtError)
  assert.equal(stop.status, 'failed')
  assert.equal(stop.settleOutstanding, false)
})

test('a stopped run, a timed-out run and a shutdown are told apart', () => {
  const stopped = resolveInvocationStop(stopInputs({ parentAborted: true }))
  assert.equal(stopped.status, 'stopped')
  assert.equal(stopped.error.message, 'LOCAL_AGENT_EXECUTION_STOPPED')
  assert.equal(stopped.settleOutstanding, true)

  const timedOutRun = resolveInvocationStop(stopInputs({ parentAborted: true, stopReason: 'timeout' }))
  assert.equal(timedOutRun.status, 'timeout')
  assert.equal(timedOutRun.error.message, 'LOCAL_AGENT_TIMEOUT')

  const shutdown = resolveInvocationStop(stopInputs({ parentAborted: true, stopReason: 'shutdown' }))
  assert.equal(shutdown.status, 'interrupted')
})

test('the watchdog timeout and a self-cancelled Agent are reported distinctly', () => {
  const watchdog = resolveInvocationStop(stopInputs({ timedOut: true }))
  assert.equal(watchdog.status, 'timeout')
  assert.equal(watchdog.error.message, 'LOCAL_AGENT_TIMEOUT')
  assert.equal(watchdog.settleOutstanding, true)

  const cancelled = resolveInvocationStop(stopInputs({ agentAborted: true }))
  assert.equal(cancelled.status, 'stopped')
  assert.equal(cancelled.settleOutstanding, true)
})

test('error metadata is attached as hidden properties and empty values are skipped', () => {
  const error = new Error('x')
  attachErrorMetadata(error, { runTrace: { id: 1 }, turnSeq: 0 })
  assert.deepEqual(error.runTrace, { id: 1 })
  assert.equal('turnSeq' in error, false)
  assert.equal(Object.keys(error).includes('runTrace'), false)

  attachInvocationFailure(error, {
    outcomeCertainty: 'unknown_outcome', sideEffectsPossible: true, operationId: 'op', idempotencyMode: 'none',
  })
  attachInvocationFailure(error, {
    outcomeCertainty: 'not_started', sideEffectsPossible: false, operationId: 'other', idempotencyMode: 'durable',
  })
  assert.equal(error.invocationFailure.outcomeCertainty, 'unknown_outcome')
  assert.equal(error.invocationFailure.operationId, 'op')
  assert.equal(attachInvocationFailure('not an object', {}), 'not an object')
})

test('usage is recorded from what the CLI reported, falling back to estimates', () => {
  const batches = []
  const budget = { addUsageBatch: batch => batches.push(batch), elapsedValue: () => 42 }
  recordReplyUsage(budget, { usage: { outputTokens: 7, costMicros: 99 }, replyText: 'abcdefgh', toolCallCount: 3 })
  assert.deepEqual(batches[0].map(item => [item.dimension, item.source]), [
    ['outputTokens', 'reported'], ['toolCalls', 'estimated'], ['costMicros', 'reported'], ['elapsedMs', 'reported'],
  ])
  assert.equal(batches[0][0].amount, 7)

  recordReplyUsage(budget, { usage: {}, replyText: 'abcdefgh', toolCallCount: 0 })
  assert.deepEqual(batches[1].map(item => item.dimension), ['outputTokens', 'toolCalls', 'elapsedMs'])
  assert.equal(batches[1][0].amount, 2)
  assert.equal(batches[1][0].source, 'estimated')

  recordOutboundUsage(budget, createLegacyOutboundPayload({
    prompt: 'x'.repeat(40), command: 'codex', args: ['exec'], cwd: '/w', stdin: '', promptMode: 'argv',
  }))
  assert.deepEqual(batches[2].map(item => item.dimension), ['outboundBytes', 'inputTokens'])
  recordOutboundUsage(budget, { prompt: 'built elsewhere' })
  assert.equal(batches.length, 3)
  recordOutboundUsage(null, {})
  recordReplyUsage(undefined, { replyText: '' })
})

test('reported output paths keep spaces inside quotes and links but not trailing punctuation', () => {
  const text = [
    'Saved to `/Users/me/My Reports/final draft.md`, and also /tmp/plain.txt.',
    'See [the log](</home/dev/build logs/out.log>) and "/Volumes/Data/a b.png".',
  ].join('\n')
  assert.deepEqual(extractReportedOutputPaths(text).sort(), [
    '/Users/me/My Reports/final draft.md',
    '/Volumes/Data/a b.png',
    '/home/dev/build logs/out.log',
    '/tmp/plain.txt',
  ])
  assert.deepEqual(extractReportedOutputPaths(undefined), [])
})

test('output capture only runs for writable turns and shrugs off capture errors', async () => {
  const calls = []
  const controller = new AbortController()
  const deps = {
    captureAgentOutputs: async () => { calls.push('baseline'); return { files: [] } },
    captureArtifactOutputs: async () => { calls.push('artifacts'); throw new Error('disk gone') },
    importAgentOutputs: async (input) => {
      calls.push(['import', input.reportedPaths])
      return [{ id: 'a1', name: 'x.png', mimeType: 'image/png', size: 10 }, { bogus: true }]
    },
    captureAgentOutcomeDescriptors: async () => { calls.push('describe'); return [{ kind: 'file' }] },
  }
  const readOnly = new InvocationOutputs({
    enabled: false, workdir: '/w', signal: controller.signal, agentKind: 'codex', startedAt: 1, deps,
  })
  await readOnly.begin()
  assert.deepEqual(await readOnly.importMedia('/tmp/a.txt'), [])
  assert.deepEqual(await readOnly.describeOutcomes({}), [])
  assert.deepEqual(calls, [])

  const writable = new InvocationOutputs({
    enabled: true, workdir: '/w', signal: controller.signal, agentKind: 'codex', startedAt: 1, deps,
  })
  await writable.begin()
  assert.deepEqual(writable.baseline, { files: [] })
  assert.equal(writable.artifactBaseline, null)
  const attachments = await writable.importMedia('Wrote /tmp/a.txt')
  assert.deepEqual(attachments.map(item => item.id), ['a1'])
  assert.deepEqual(await writable.describeOutcomes({ runId: 'r', agentRunId: 'a' }), [])
  assert.equal(writable.pending().length, 3)
})

test('a stop request interrupts output capture instead of being swallowed', async () => {
  const controller = new AbortController()
  const outputs = new InvocationOutputs({
    enabled: true, workdir: '/w', signal: controller.signal, agentKind: 'codex', startedAt: 1,
    deps: {
      captureAgentOutputs: () => new Promise(() => {}),
      captureArtifactOutputs: () => new Promise(() => {}),
      importAgentOutputs: async () => [],
      captureAgentOutcomeDescriptors: async () => [],
    },
  })
  const pending = outputs.begin()
  controller.abort()
  await assert.rejects(pending)
})

function promptInputs(overrides = {}) {
  return {
    group: { id: 'g', conversationType: 'group' },
    kind: 'codex',
    mode: 'manual',
    threadRootId: 'root',
    context: {},
    activeRun: null,
    isolated: false,
    frozen: false,
    v4Prompt: '',
    promptMode: 'bootstrap',
    afterKind: '',
    packed: { currentTaskText: 'Do the thing', recentText: '', stableText: '' },
    session: { rotated: false, ref: 'native-1' },
    stagedInputs: null,
    promptFor: (...args) => `GROUP PROMPT mode=${args[2]} continuation=${args[8]}`,
    agentLabel: kind => `Label ${kind}`,
    ...overrides,
  }
}

test('frozen and isolated invocations send exactly the approved prompt', () => {
  assert.equal(assembleInvocationPrompt(promptInputs({ frozen: true, v4Prompt: 'APPROVED' })), 'APPROVED')
  assert.equal(assembleInvocationPrompt(promptInputs({ isolated: true, v4Prompt: 'ISOLATED' })), 'ISOLATED')
})

test('group prompts append recovery text and the response scope, in that order', () => {
  const prompt = assembleInvocationPrompt(promptInputs({
    context: { runtimeInstruction: 'Retry carefully', regenerationInstruction: 'Try another angle' },
    promptMode: 'continuation',
  }))
  const lines = prompt.split('\n')
  assert.equal(lines[0], 'GROUP PROMPT mode=manual continuation=continuation')
  assert.ok(prompt.indexOf('Harness recovery task:\nRetry carefully')
    < prompt.indexOf('Fresh response instruction:\nTry another angle'))
  assert.ok(prompt.indexOf('Fresh response instruction') < prompt.indexOf('Final response scope:'))
})

test('a V4 prompt replaces the workspace prompt, and a typed policy runs as a manual turn', () => {
  const v4 = assembleInvocationPrompt(promptInputs({ context: { v4: true }, v4Prompt: 'V4 PROMPT' }))
  assert.equal(v4.split('\n')[0], 'V4 PROMPT')
  const typed = assembleInvocationPrompt(promptInputs({ mode: 'auto', context: { completionPolicy: 'typed' } }))
  assert.match(typed, /mode=manual/)
})

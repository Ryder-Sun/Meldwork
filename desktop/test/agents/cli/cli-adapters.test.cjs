const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const {
  detectAgents,
  imageAttachmentLimit,
  invocation,
  parseCodexOutput,
  parseGeminiOutput,
  parseKimiOutput,
  parseMimoOutput,
  parseOpenCodeOutput,
  parsePiOutput,
  parseWorkBuddyOutput,
  prepareCommand,
  readHermesFinalResponse,
  readHermesMessageWatermark,
  resolveExecutable,
  runAgent,
  runtimeCommandSummary,
  searchPath,
} = require('../../../src/agents/cli/cli-adapters.cjs')
const { resolveConnectorEventProfile } = require('../../../src/agents/cli/cli-event-profiles.cjs')
const { nativeOpenClawOptions } = require('../../../src/agents/cli/openclaw-runtime.cjs')
function openClawAdapterRuntime(storageRoot, workdir, sessionRef = '') {
  return nativeOpenClawOptions({
    storageRoot,
    workdir,
    ...(sessionRef ? { sessionRef } : {}),
    runtime: {
      model: 'native/model',
      provider: {
        id: 'native',
        baseUrl: 'https://native.example.com/v1',
        api: 'openai-completions',
        apiKey: 'adapter-openclaw-key',
        model: { id: 'model', name: 'Native Model', input: ['text'] },
      },
    },
  })
}

const {
  executable,
  readJsonWhenReady,
  readWhenReady,
  waitForExit,
  within,
} = require('../../support/cli-adapters-test-helpers.cjs')

const OUTBOUND_PAYLOAD_KEYS = [
  'prompt',
  'promptMode',
  'serialization',
  'transport',
  'wirePayloadBytes',
  'wirePayloadHash',
]

function profileOutput(kind, stdout, sessionRef = '') {
  const profile = resolveConnectorEventProfile(
    kind,
    ['hermes', 'openclaw'].includes(kind) ? { transport: 'legacy' } : {},
  )
  const accumulator = profile.createFinalOutputAccumulator(sessionRef)
  const bytes = Buffer.from(stdout)
  accumulator.capture?.(bytes)
  accumulator.write?.(bytes)
  return accumulator.end({ sessionRef })
}

function wireFingerprint(value) {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8')
  return {
    wirePayloadHash: crypto.createHash('sha256').update(bytes).digest('hex'),
    wirePayloadBytes: bytes.length,
  }
}

function assertSafeOutboundPayload(payload) {
  assert.deepEqual(Object.keys(payload).sort(), OUTBOUND_PAYLOAD_KEYS)
  assert.equal(Object.isFrozen(payload), true)
}

test('new Codex sessions persist and default to the read-only sandbox', (t) => {
  const previous = process.env.MELDWORK_CODEX_SANDBOX
  delete process.env.MELDWORK_CODEX_SANDBOX
  t.after(() => {
    if (previous == null) delete process.env.MELDWORK_CODEX_SANDBOX
    else process.env.MELDWORK_CODEX_SANDBOX = previous
  })
  const spec = invocation('codex', '/tmp/codex', '/tmp/work')
  assert.equal(spec.stdin, true)
  assert.deepEqual(spec.args.slice(0, 2), ['exec', '--json'])
  assert.equal(spec.args.includes('--ephemeral'), false)
  assert.ok(spec.args.includes('read-only'))
  assert.equal(spec.args.at(-1), '-')
})

test('Codex accepts workspace-write only as an explicit per-call sandbox', () => {
  const spec = invocation('codex', '/tmp/codex', '/tmp/work', '', {
    sandbox: 'workspace-write',
  })
  assert.ok(spec.args.includes('workspace-write'))
  assert.throws(
    () => invocation('codex', '/tmp/codex', '/tmp/work', '', { sandbox: 'danger-full-access' }),
    { message: 'CODEX_SANDBOX_UNSUPPORTED' },
  )
})

test('unsafe Codex sandbox environment values fall back to read-only', (t) => {
  const previous = process.env.MELDWORK_CODEX_SANDBOX
  process.env.MELDWORK_CODEX_SANDBOX = 'danger-full-access'
  t.after(() => {
    if (previous == null) delete process.env.MELDWORK_CODEX_SANDBOX
    else process.env.MELDWORK_CODEX_SANDBOX = previous
  })
  const spec = invocation('codex', '/tmp/codex', '/tmp/work')
  assert.ok(spec.args.includes('read-only'))
  assert.equal(spec.args.includes('danger-full-access'), false)
})

test('Codex resume uses the native session id with the current sandbox', () => {
  const spec = invocation('codex', '/tmp/codex', '/tmp/work', 'thread-123')
  assert.deepEqual(spec.args, [
    'exec', 'resume', '--json', '--skip-git-repo-check',
    '-c', 'sandbox_mode="read-only"', 'thread-123', '-',
  ])

  const writable = invocation('codex', '/tmp/codex', '/tmp/work', 'thread-123', {
    sandbox: 'workspace-write',
  })
  assert.deepEqual(writable.args, [
    'exec', 'resume', '--json', '--skip-git-repo-check',
    '-c', 'sandbox_mode="workspace-write"', 'thread-123', '-',
  ])
})

test('Codex forwards every validated image to new and resumed sessions', () => {
  const first = path.resolve('diagram-one.png')
  const second = path.resolve('diagram-two.jpg')
  const created = invocation('codex', '/tmp/codex', '/tmp/work', '', {
    attachments: [first, second],
  })
  assert.deepEqual(created.args, [
    'exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only',
    '-C', '/tmp/work', '--image', first, '--image', second, '-',
  ])

  const resumed = invocation('codex', '/tmp/codex', '/tmp/work', 'thread-123', {
    attachments: [first],
  })
  assert.deepEqual(resumed.args, [
    'exec', 'resume', '--json', '--skip-git-repo-check',
    '-c', 'sandbox_mode="read-only"', '--image', first, 'thread-123', '-',
  ])
})

test('Codex JSONL output returns the reply and session id', () => {
  const output = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-123' }),
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: '第一段' },
    }),
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: '第二段' },
    }),
  ].join('\n')
  assert.deepEqual(parseCodexOutput(output), {
    text: '第一段\n第二段',
    sessionRef: 'thread-123',
  })
})

test('runtime command summaries retain no command content', () => {
  const commands = [
    'zsh -lc "ls /Users/private/workspace | head -5"',
    "/bin/bash -c 'git status --short'",
    'zsh -c pwd',
    "sh -c 'curl --header \"Authorization: Bearer private-token\" https://user:pass@example.test/private'",
    'API_KEY="top secret value" TOKEN=unquoted-secret rg -n https://example.test',
    'printf one\nrm -rf /tmp/private',
  ]
  for (const command of commands) {
    const summary = runtimeCommandSummary(command)
    assert.equal(summary, 'command')
    assert.doesNotMatch(summary, /pwd|rg|curl|ls|git|rm|-rf|--header|private|secret|Users/i)
  }
})

test('runAgent streams sanitized Codex operations and result summaries before the final reply', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-codex-progress-'))
  const cli = executable(directory, 'codex-progress.cjs', `
const events = [
  { type: 'thread.started', thread_id: 'thread-progress' },
  { type: 'turn.started' },
  {
    type: 'item.started',
    item: {
      id: 'item-search', type: 'command_execution',
      command: 'rg -n -pSuperSecret targetKinds /Users/private/workspace', status: 'in_progress',
    },
  },
  {
    type: 'item.completed',
    item: {
      id: 'item-search', type: 'command_execution',
      command: 'rg -n -pSuperSecret targetKinds /Users/private/workspace',
      aggregated_output: 'frontend/src/App.vue:2652: targetKinds\\nAWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF\\n',
      exit_code: 0, status: 'completed',
    },
  },
  {
    type: 'item.started',
    item: {
      id: 'item-shell', type: 'command_execution', command: 'zsh -c pwd', status: 'in_progress',
    },
  },
  {
    type: 'item.completed',
    item: {
      id: 'item-shell', type: 'command_execution', command: 'zsh -c pwd',
      aggregated_output: '/Users/private/workspace\\n', exit_code: 0, status: 'completed',
    },
  },
  {
    type: 'item.started',
    item: { id: 'item-image', type: 'image_generation', status: 'in_progress' },
  },
  {
    type: 'item.completed',
    item: { id: 'item-image', type: 'image_generation', status: 'completed' },
  },
  {
    type: 'item.completed',
    item: { id: 'item-message', type: 'agent_message', text: 'final reply' },
  },
  { type: 'turn.completed' },
]
let index = 0
function send() {
  if (index >= events.length) return
  const line = JSON.stringify(events[index++]) + '\\n'
  const split = Math.max(1, Math.floor(line.length / 2))
  process.stdout.write(line.slice(0, split))
  setTimeout(() => {
    process.stdout.write(line.slice(split))
    if (index >= events.length) return setTimeout(() => process.exit(0), 25)
    setTimeout(send, 25)
  }, 10)
}
send()
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const progress = []
  const events = []
  let firstProgressResolve
  const firstProgress = new Promise(resolve => { firstProgressResolve = resolve })
  let answerEventResolve
  const answerEvent = new Promise(resolve => { answerEventResolve = resolve })
  let resultResolved = false
  const resultPromise = runAgent(
    { kind: 'codex', executable: cli, name: 'Codex' },
    'hello',
    directory,
    {
      onProgress: step => {
        progress.push(step)
        firstProgressResolve()
      },
      onEvent: event => {
        events.push(event)
        if (event.type === 'answer_delta') answerEventResolve()
      },
    },
  ).then((result) => {
    resultResolved = true
    return result
  })

  await within(firstProgress)
  assert.equal(progress.length > 0, true)
  await within(answerEvent)
  assert.equal(resultResolved, false)
  const result = await resultPromise

  assert.equal(result.text, 'final reply')
  assert.equal(result.sessionRef, 'thread-progress')
  assert.deepEqual(result.progress, [
    { id: 'turn', title: 'process', status: 'completed' },
    { id: 'item-search', title: 'search', status: 'completed' },
    { id: 'item-shell', title: 'Bash', status: 'completed' },
    { id: 'item-image', title: 'image_generation', status: 'completed' },
  ])
  assert.equal(progress.some(step => step.id === 'item-search' && step.status === 'in_progress'), true)
  assert.equal(progress.some(step => step.id === 'item-search' && step.status === 'completed'), true)
  assert.doesNotMatch(JSON.stringify(progress), /Users|workspace|rg|pwd|-pSuperSecret/)
  assert.deepEqual(events.map(event => [event.type, event.status]), [
    ['tool_start', 'running'],
    ['tool_result_summary', 'completed'],
    ['tool_start', 'running'],
    ['tool_result_summary', 'completed'],
    ['tool_start', 'running'],
    ['tool_result_summary', 'completed'],
    ['answer_delta', 'running'],
    ['answer_delta', 'completed'],
  ])
  assert.equal(events.some(event => event.type === 'status' || event.title === 'process'), false)
  const answerEvents = events.filter(event => event.type === 'answer_delta')
  assert.equal(answerEvents[0]?.delta, 'final reply')
  assert.equal(answerEvents.at(-1)?.replace, true)
  const commandResult = events.find(event => (
    event.type === 'tool_result_summary' && event.id === 'item-search'
  ))
  assert.equal(commandResult.summary, 'Bash: operation: command')
  assert.match(commandResult.detail, /Exit code: 0/)
  assert.match(commandResult.detail, /Output: 2 lines/)
  assert.doesNotMatch(commandResult.detail, /frontend\/src\/App\.vue/)
  assert.doesNotMatch(commandResult.detail, /AKIA1234567890ABCDEF/)
  const shellResult = events.find(event => (
    event.type === 'tool_result_summary' && event.id === 'item-shell'
  ))
  assert.equal(shellResult.title, 'Bash')
  assert.equal(shellResult.summary, 'Bash: operation: command')
  assert.match(shellResult.detail, /Exit code: 0/)
  assert.doesNotMatch(shellResult.detail, /Users|private|workspace/)
  assert.equal(events.every(event => Object.keys(event).every(key => (
    ['id', 'type', 'status', 'title', 'summary', 'detail', 'delta', 'replace'].includes(key)
  ))), true)
  assert.doesNotMatch(
    JSON.stringify(events),
    /Users|private\/workspace|AKIA1234567890ABCDEF|SuperSecret|\brg\b|\bpwd\b|-pSuperSecret/,
  )
})

test('legacy CLI terminal paths close start-only tools with the matching non-success status', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-legacy-open-tool-terminal-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  await t.test('failure', async () => {
    const cli = executable(directory, 'codex-open-tool-failure.cjs', `
process.stdout.write(JSON.stringify({
  type: 'item.started',
  item: { id: 'legacy-failed-tool', type: 'command_execution', command: 'pwd', status: 'in_progress' },
}) + '\\n')
process.stderr.write('provider failed')
process.exit(2)
`)
    const events = []

    await assert.rejects(
      runAgent(
        { kind: 'codex', executable: cli, name: 'Codex' },
        'fail after starting a tool', directory, { onEvent: event => events.push(event) },
      ),
      error => error.message === 'LOCAL_AGENT_PROCESS_FAILED',
    )

    assert.deepEqual(events.find(event => event.type === 'tool_result_summary'), {
      type: 'tool_result_summary',
      id: 'legacy-failed-tool',
      status: 'failed',
      title: 'Bash',
    })
  })

  await t.test('cancellation', async () => {
    const readyFile = path.join(directory, 'cancel-ready')
    const cli = executable(directory, 'codex-open-tool-cancel.cjs', `
const fs = require('node:fs')
process.stdout.write(JSON.stringify({
  type: 'item.started',
  item: { id: 'legacy-stopped-tool', type: 'command_execution', command: 'pwd', status: 'in_progress' },
}) + '\\n')
fs.writeFileSync(process.env.MELDWORK_TEST_READY_FILE, 'ready')
setInterval(() => {}, 1000)
`)
    const controller = new AbortController()
    const events = []
    const result = runAgent(
      { kind: 'codex', executable: cli, name: 'Codex' },
      'stop after starting a tool', directory,
      {
        signal: controller.signal,
        env: { MELDWORK_TEST_READY_FILE: readyFile },
        onEvent: event => events.push(event),
      },
    )
    await readWhenReady(readyFile)

    controller.abort()

    await assert.rejects(result, error => error.message === 'LOCAL_AGENT_EXECUTION_STOPPED')
    assert.deepEqual(events.find(event => event.type === 'tool_result_summary'), {
      type: 'tool_result_summary',
      id: 'legacy-stopped-tool',
      status: 'stopped',
      title: 'Bash',
    })
  })
})

test('runAgent never reconstructs a configured credential across any answer-delta split', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-answer-redaction-'))
  const secret = 'provider-secret-value'
  const cli = executable(directory, 'answer-redaction.cjs', `
const secret = process.env.CONNECTOR_TEST_API_KEY
const split = Number(process.env.MELDWORK_SECRET_SPLIT)
for (const text of [secret.slice(0, split), secret.slice(split)]) {
  process.stdout.write(JSON.stringify({
    type: 'item.completed', item: { type: 'agent_message', text },
  }) + '\\n')
}
process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n')
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  for (let split = 1; split < secret.length; split += 1) {
    const events = []
    await runAgent(
      { kind: 'codex', executable: cli, name: 'Codex' },
      'reply',
      directory,
      {
        env: { CONNECTOR_TEST_API_KEY: secret, MELDWORK_SECRET_SPLIT: String(split) },
        onEvent: event => events.push(event),
      },
    )
    const delivered = events.filter(event => event.type === 'answer_delta').reduce(
      (answer, event) => event.replace === true ? event.delta : answer + event.delta,
      '',
    )
    assert.doesNotMatch(delivered, new RegExp(secret), `split ${split}`)
    assert.doesNotMatch(JSON.stringify(events), new RegExp(secret), `split ${split}`)
  }
})

test('WorkBuddy stream-json emits text and tool lifecycle events before child close', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-workbuddy-stream-'))
  const releaseFile = path.join(directory, 'release')
  const cli = executable(directory, 'workbuddy-stream.cjs', `
const fs = require('node:fs')
const records = [
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0,
    delta: { type: 'text_delta', text: 'streamed reply' } },
    session_id: 'workbuddy-stream-session', parent_tool_use_id: null, uuid: 'text-1' },
  { type: 'stream_event', event: { type: 'content_block_start', index: 1,
    content_block: { type: 'tool_use', id: 'workbuddy-tool-1', name: 'web_search', input: {} } },
    session_id: 'workbuddy-stream-session', parent_tool_use_id: null, uuid: 'tool-start-1' },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"query":"Meldwork"}' } },
    session_id: 'workbuddy-stream-session', parent_tool_use_id: null, uuid: 'tool-update-1' },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result',
    tool_use_id: 'workbuddy-tool-1', content: [{ type: 'text', text: 'one result' }],
    is_error: false }] }, session_id: 'workbuddy-stream-session' },
]
for (const record of records) process.stdout.write(JSON.stringify(record) + '\\n')
const finish = () => {
  if (!fs.existsSync(process.env.MELDWORK_TEST_RELEASE_FILE)) return setTimeout(finish, 10)
  process.stdout.write(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    result: 'streamed reply', session_id: 'workbuddy-stream-session',
  }) + '\\n')
}
finish()
`)
  t.after(() => {
    try { fs.writeFileSync(releaseFile, 'release') } catch { /* test cleanup */ }
    fs.rmSync(directory, { recursive: true, force: true })
  })

  const events = []
  let lifecycleResolve
  const lifecycle = new Promise(resolve => { lifecycleResolve = resolve })
  let resultResolved = false
  const resultPromise = runAgent(
    { kind: 'workbuddy', executable: cli, name: 'WorkBuddy' },
    'hello',
    directory,
    {
      env: { MELDWORK_TEST_RELEASE_FILE: releaseFile },
      onEvent: event => {
        events.push(event)
        if (event.type === 'tool_result_summary') lifecycleResolve()
      },
    },
  ).then((result) => {
    resultResolved = true
    return result
  })

  await within(lifecycle)
  assert.equal(resultResolved, false)
  assert.deepEqual(events.map(event => event.type), [
    'answer_delta', 'tool_start', 'tool_update', 'tool_result_summary',
  ])
  assert.equal(events.some(event => event.title === 'connector_limited'), false)
  fs.writeFileSync(releaseFile, 'release')
  const result = await resultPromise
  assert.equal(result.text, 'streamed reply')
  assert.equal(result.sessionRef, 'workbuddy-stream-session')
  assert.equal(events.filter(event => event.type === 'answer_delta')
    .reduce(
      (answer, event) => event.replace === true ? event.delta : answer + event.delta,
      '',
    ), result.text)
})

test('structured terminal output is kept when a CLI exits non-zero after producing a result', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cli-result-before-exit-'))
  const cli = executable(directory, 'result-before-exit.cjs', `
process.stdout.write(JSON.stringify({
  type: 'result', subtype: 'success', is_error: false,
  result: 'completed before cleanup failure', session_id: 'result-before-exit-session',
}) + '\\n')
process.exitCode = 1
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const events = []
  const result = await runAgent(
    { kind: 'workbuddy', executable: cli, name: 'WorkBuddy' },
    'hello',
    directory,
    { onEvent: event => events.push(event) },
  )

  assert.equal(result.outcome, 'completed')
  assert.equal(result.text, 'completed before cleanup failure')
  assert.equal(result.sessionRef, 'result-before-exit-session')
  assert.equal(events.some(event => event.type === 'answer_delta'), true)
})

for (const exitCode of [0, 1]) {
  test(`WorkBuddy authentication failures classify as auth-required with exit code ${exitCode}`, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `meldwork-workbuddy-auth-${exitCode}-`))
    const cli = executable(directory, 'workbuddy-auth-required.cjs', `
  process.stdout.write(JSON.stringify({
    type: 'system', subtype: 'init', session_id: 'workbuddy-auth-session',
    apiKeySource: 'www.workbuddy.cn',
  }) + '\\n')
  process.stdout.write(JSON.stringify({
    type: 'assistant', session_id: 'workbuddy-auth-session',
    message: { role: 'assistant', content: [
      { type: 'text', text: 'Authentication required. Please use /login command to sign in to your account' },
    ] },
  }) + '\\n')
  process.stdout.write(JSON.stringify({
    type: 'result', subtype: 'error_during_execution', is_error: true,
    session_id: 'workbuddy-auth-session',
    errors: ['Authentication required. Please use /login command to sign in to your account'],
  }) + '\\n')
  process.exitCode = ${exitCode}
  `)
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

    await assert.rejects(
      runAgent(
        { kind: 'workbuddy', executable: cli, name: 'WorkBuddy' },
        'hello',
        directory,
        { },
      ),
      (error) => {
        assert.equal(error.code, 'LOCAL_AGENT_AUTH_REQUIRED')
        assert.match(error.diagnostic || '', /Authentication required/u)
        return true
      },
    )
  })
}

test('Gemini profile state retains one real tool lifecycle id and summary', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-gemini-profile-state-'))
  const cli = executable(directory, 'gemini-profile-state.cjs', `
const records = [
  { type: 'init', session_id: 'gemini-profile-session' },
  { type: 'tool_use', tool_name: 'google_search', tool_id: 'gemini-tool-1',
    parameters: { query: 'Meldwork' } },
  { type: 'tool_result', tool_id: 'gemini-tool-1', status: 'success', output: 'one result' },
  { type: 'message', role: 'assistant', content: 'Gemini reply', delta: true },
  { type: 'result', status: 'success' },
]
for (const record of records) process.stdout.write(JSON.stringify(record) + '\\n')
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const events = []

  const result = await runAgent(
    { kind: 'gemini', executable: cli, name: 'Gemini' },
    'hello',
    directory,
    { onEvent: event => events.push(event) },
  )

  const lifecycle = events.filter(event => event.type.startsWith('tool_'))
  assert.equal(result.text, 'Gemini reply')
  assert.deepEqual(lifecycle.map(event => event.id), ['gemini-tool-1', 'gemini-tool-1'])
  assert.equal(lifecycle[0].title, lifecycle[1].title)
  assert.equal(lifecycle[0].summary, lifecycle[1].summary)
  assert.match(lifecycle[1].summary, /query/)
})

test('final-only profiles warn early but emit the completed answer only after close', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-final-only-profile-'))
  const readyFile = path.join(directory, 'ready')
  const releaseFile = path.join(directory, 'release')
  const cli = executable(directory, 'opencodereview-final-only.cjs', `
const fs = require('node:fs')
process.stdout.write(JSON.stringify({
  status: 'complete', message: 'Review complete.', comments: [], session_id: 'ocr-run-1',
  manifest: { schema_version: 'ocr.run-manifest/v1', operation: 'review', terminal_state: 'complete' },
}))
fs.writeFileSync(process.env.MELDWORK_TEST_READY_FILE, 'ready')
const finish = () => {
  if (!fs.existsSync(process.env.MELDWORK_TEST_RELEASE_FILE)) return setTimeout(finish, 10)
}
finish()
`)
  t.after(() => {
    try { fs.writeFileSync(releaseFile, 'release') } catch { /* test cleanup */ }
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const events = []
  let resultResolved = false
  const resultPromise = runAgent(
    { kind: 'opencodereview', executable: cli, name: 'OpenCodeReview' },
    'review',
    directory,
    {
      env: {
        MELDWORK_TEST_READY_FILE: readyFile,
        MELDWORK_TEST_RELEASE_FILE: releaseFile,
      },
      onEvent: event => events.push(event),
    },
  ).then((result) => {
    resultResolved = true
    return result
  })

  await readWhenReady(readyFile)
  assert.equal(resultResolved, false)
  assert.equal(events.some(event => event.type === 'answer_delta'), false)
  assert.equal(events.filter(event => event.title === 'connector_limited').length, 1)
  fs.writeFileSync(releaseFile, 'release')
  const result = await resultPromise
  const answers = events.filter(event => event.type === 'answer_delta')
  assert.equal(result.text, 'Review complete.')
  assert.deepEqual(answers.map(event => event.status), ['completed'])
  assert.equal(answers[0].delta, result.text)
})

test('Hermes starts ACP sessions but keeps unmarked historical sessions on the legacy transport', () => {
  const created = invocation('hermes', '/tmp/hermes', '/tmp')
  assert.deepEqual(created.args, ['acp'])
  assert.equal(created.acpMode, 'default')
  assert.equal(created.promptArg, undefined)

  const resumed = invocation('hermes', '/tmp/hermes', '/tmp', 'hermes-session-123', {
    sessionTransport: 'acp',
  })
  assert.deepEqual(resumed.args, ['acp'])
  assert.equal(resumed.acpMode, 'default')

  const legacy = invocation('hermes', '/tmp/hermes', '/tmp', 'hermes-session-123')
  assert.deepEqual(legacy.args, [
    'chat', '--quiet', '--resume', 'hermes-session-123', '--query',
  ])

  const writable = invocation('hermes', '/tmp/hermes', '/tmp', 'hermes-session-123', {
    sandbox: 'workspace-write',
    sessionTransport: 'acp',
  })
  assert.deepEqual(writable.args, ['acp'])
  assert.equal(writable.acpMode, 'accept_edits')
  for (const spec of [created, resumed, legacy, writable]) {
    assert.equal(spec.args.some(arg => /(?:tool.*(?:crop|trunc)|(?:crop|trunc).*tool)/iu.test(arg)), false)
  }
})

test('Hermes falls back to legacy quiet mode when ACP startup fails before the prompt', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-hermes-acp-fallback-'))
  const cli = executable(directory, 'hermes-acp-fallback.cjs', `
if (process.argv[2] !== 'chat' || !process.argv.includes('--quiet') || process.argv.includes('acp')) {
  process.stderr.write('expected legacy quiet mode')
  process.exit(2)
}
process.stdout.write('\\u001b[36mHermes legacy fallback\\u001b[0m\\n')
  process.stderr.write('session_id: hermes-fallback-session\\n')
`)
  const events = []
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = await runAgent(
    { kind: 'hermes', executable: cli, name: 'Hermes' },
    'hello',
    directory,
    {
      loadAcpSdkFn: async () => { throw new Error('ACP SDK unavailable') },
      hermesMessageWatermarkFn: () => null,
      onEvent: event => events.push(event),
    },
  )

  assert.deepEqual(result, {
    text: 'Hermes legacy fallback',
    sessionRef: 'hermes-fallback-session',
    outcome: 'completed',
  })
  assert.deepEqual(events[0], {
    id: 'hermes-acp-fallback',
    type: 'warning',
    status: 'waiting',
    title: 'connector_fallback',
  })
  assert.deepEqual(events[1], {
    id: 'hermes-connector',
    type: 'warning',
    status: 'waiting',
    title: 'connector_limited',
  })
})

test('Hermes invalidates a stale ACP session and rebuilds the legacy fallback prompt', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-hermes-acp-resume-fallback-'))
  const cli = executable(directory, 'hermes-acp-resume-fallback.cjs', `
if (process.argv[2] === 'acp') {
  const readline = require('node:readline')
  const input = readline.createInterface({ input: process.stdin })
  const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
  input.on('line', (line) => {
    const message = JSON.parse(line)
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
    } else if (message.method === 'session/resume') {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'session missing' } })
    }
  })
} else {
  if (process.argv[2] !== 'chat' || !process.argv.includes('--quiet') || process.argv.includes('--resume')) {
    process.stderr.write('expected a fresh legacy session')
    process.exit(2)
  }
  process.stdout.write(process.argv.at(-1) + '\\n')
  process.stderr.write('session_id: hermes-recovered-session\\n')
}
`)
  const invalidations = []
  const events = []
  const outboundPayloads = []
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = await runAgent(
    { kind: 'hermes', executable: cli, name: 'Hermes' },
    'incremental prompt',
    directory,
    {
      sessionRef: 'hermes-stale-session',
      sessionTransport: 'acp',
      hermesMessageWatermarkFn: () => null,
      onSessionInvalidated: (metadata) => {
        invalidations.push(metadata)
        return { prompt: 'rebuilt full context' }
      },
      onOutboundPayload: payload => outboundPayloads.push(payload),
      onEvent: event => events.push(event),
    },
  )

  assert.deepEqual(result, {
    text: 'rebuilt full context',
    sessionRef: 'hermes-recovered-session',
    outcome: 'completed',
  })
  assert.deepEqual(invalidations, [{
    kind: 'hermes',
    sessionRef: 'hermes-stale-session',
    transport: 'acp',
  }])
  assert.equal(outboundPayloads.length, 1)
  assertSafeOutboundPayload(outboundPayloads[0])
  assert.deepEqual(outboundPayloads[0], {
    prompt: 'rebuilt full context',
    transport: 'legacy',
    serialization: 'cli-argv-stdin-v1',
    promptMode: 'argument',
    ...wireFingerprint({
      args: ['chat', '--quiet', '--query', 'rebuilt full context'],
      command: cli,
      cwd: directory,
      stdin: '',
    }),
  })
  assert.equal(events.some(event => event.title === 'connector_fallback'), true)
})

test('runAgent reports minimal legacy payloads before argv and stdin delivery', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-outbound-payload-'))
  const lifecycleFile = path.join(directory, 'lifecycle.log')
  const wireFile = path.join(directory, 'wire.log')
  const codexCli = executable(directory, 'codex-outbound.cjs', `
const fs = require('node:fs')
let prompt = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { prompt += chunk })
process.stdin.on('end', () => {
  fs.appendFileSync(
    process.env.MELDWORK_TEST_WIRE_FILE,
    JSON.stringify({ args: process.argv.slice(2), stdin: prompt }) + '\\n',
  )
  fs.appendFileSync(process.env.MELDWORK_TEST_LIFECYCLE_FILE, 'stdin:' + prompt + '\\n')
  const events = [
    { type: 'thread.started', thread_id: 'codex-outbound-session' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'stdin reply' } },
    { type: 'turn.completed' },
  ]
  for (const event of events) process.stdout.write(JSON.stringify(event) + '\\n')
})
`)
  const workBuddyCli = executable(directory, 'workbuddy-outbound.cjs', `
const fs = require('node:fs')
fs.appendFileSync(
  process.env.MELDWORK_TEST_WIRE_FILE,
  JSON.stringify({ args: process.argv.slice(2), stdin: '' }) + '\\n',
)
fs.appendFileSync(
  process.env.MELDWORK_TEST_LIFECYCLE_FILE,
  'argv:' + process.argv.at(-1) + '\\n',
)
process.stdout.write(JSON.stringify([
  { type: 'result', result: 'argv reply', session_id: 'workbuddy-outbound-session' },
]))
`)
  const outboundPayloads = []
  const onOutboundPayload = async (payload) => {
    outboundPayloads.push(payload)
    fs.appendFileSync(lifecycleFile, 'hook:' + payload.prompt + '\n')
  }
  const options = {
    sandbox: 'read-only',
    env: {
      MELDWORK_TEST_LIFECYCLE_FILE: lifecycleFile,
      MELDWORK_TEST_WIRE_FILE: wireFile,
    },
    onOutboundPayload,
  }
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const stdinResult = await runAgent(
    { kind: 'codex', executable: codexCli, name: 'Codex' },
    'stdin prompt',
    directory,
    options,
  )
  const argvResult = await runAgent(
    { kind: 'workbuddy', executable: workBuddyCli, name: 'WorkBuddy' },
    'argv prompt',
    directory,
    { ...options, sessionRef: 'private-workbuddy-session' },
  )

  assert.equal(stdinResult.text, 'stdin reply')
  assert.equal(argvResult.text, 'argv reply')
  const [stdinWire, argvWire] = fs.readFileSync(wireFile, 'utf8')
    .trim().split('\n').map(line => JSON.parse(line))
  assert.equal(stdinWire.stdin, 'stdin prompt')
  assert.equal(argvWire.args.includes('private-workbuddy-session'), true)
  assert.equal(argvWire.args.at(-1), 'argv prompt')
  assert.equal(outboundPayloads.length, 2)
  outboundPayloads.forEach(assertSafeOutboundPayload)
  assert.deepEqual(outboundPayloads[0], {
    prompt: 'stdin prompt',
    transport: 'legacy',
    serialization: 'cli-argv-stdin-v1',
    promptMode: 'stdin',
    ...wireFingerprint({
      args: stdinWire.args,
      command: codexCli,
      cwd: directory,
      stdin: stdinWire.stdin,
    }),
  })
  assert.deepEqual(outboundPayloads[1], {
    prompt: 'argv prompt',
    transport: 'legacy',
    serialization: 'cli-argv-stdin-v1',
    promptMode: 'argument',
    ...wireFingerprint({
      args: argvWire.args,
      command: workBuddyCli,
      cwd: directory,
      stdin: argvWire.stdin,
    }),
  })
  const publicPayloads = JSON.stringify(outboundPayloads)
  assert.equal(publicPayloads.includes(directory), false)
  assert.equal(publicPayloads.includes(codexCli), false)
  assert.equal(publicPayloads.includes(workBuddyCli), false)
  assert.equal(publicPayloads.includes('private-workbuddy-session'), false)
  assert.deepEqual(
    fs.readFileSync(lifecycleFile, 'utf8').trim().split('\n'),
    ['hook:stdin prompt', 'stdin:stdin prompt', 'hook:argv prompt', 'argv:argv prompt'],
  )
})

test('legacy outbound callback failure prevents prompt delivery', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-outbound-blocked-'))
  const deliveryFile = path.join(directory, 'delivered.txt')
  const cli = executable(directory, 'workbuddy-outbound-blocked.cjs', `
const fs = require('node:fs')
fs.writeFileSync(process.env.MELDWORK_TEST_DELIVERY_FILE, process.argv.at(-1))
process.stdout.write(JSON.stringify([
  { type: 'result', result: 'unexpected', session_id: 'workbuddy-blocked-session' },
]))
`)
  const callbackError = new Error('outbound payload capture failed')
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  await assert.rejects(
    runAgent(
      { kind: 'workbuddy', executable: cli, name: 'WorkBuddy' },
      'must not be delivered',
      directory,
      {
        env: { MELDWORK_TEST_DELIVERY_FILE: deliveryFile },
        onOutboundPayload: async () => { throw callbackError },
      },
    ),
    error => error === callbackError,
  )
  assert.equal(fs.existsSync(deliveryFile), false)
})

test('legacy outbound fingerprint uses the command prepared from a Windows shim', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-outbound-windows-'))
  const shim = path.join(directory, 'codex.cmd')
  fs.writeFileSync(
    shim,
    '@"%~dp0\\node_modules\\codex\\bin\\codex.js" %*\r\n',
  )
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  let invocation
  let outboundPayload
  let spawnCalled = false
  let deliveredStdin = ''
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin.setEncoding('utf8')
  child.stdin.on('data', chunk => { deliveredStdin += chunk })
  child.stdin.on('finish', () => {
    setImmediate(() => {
      for (const event of [
        { type: 'thread.started', thread_id: 'windows-prepared-session' },
        { type: 'item.completed', item: { type: 'agent_message', text: 'prepared reply' } },
        { type: 'turn.completed' },
      ]) child.stdout.write(`${JSON.stringify(event)}\n`)
      child.emit('close', 0)
    })
  })
  child.kill = () => true

  const result = await runAgent(
    { kind: 'codex', executable: shim, name: 'Codex' },
    'prepared stdin prompt',
    directory,
    {
      platform: 'win32',
      sandbox: 'read-only',
      spawnFn: (command, args, options) => {
        spawnCalled = true
        invocation = { command, args, options }
        return child
      },
      onOutboundPayload: (payload) => {
        assert.equal(spawnCalled, false)
        outboundPayload = payload
      },
    },
  )

  assert.equal(invocation.command, 'node.exe')
  assert.match(invocation.args[0], /node_modules\\codex\\bin\\codex\.js$/)
  assert.equal(deliveredStdin, 'prepared stdin prompt')
  assert.deepEqual(outboundPayload, {
    prompt: 'prepared stdin prompt',
    transport: 'legacy',
    serialization: 'cli-argv-stdin-v1',
    promptMode: 'stdin',
    ...wireFingerprint({
      args: invocation.args,
      command: invocation.command,
      cwd: invocation.options.cwd,
      stdin: deliveredStdin,
    }),
  })
  assert.equal(JSON.stringify(outboundPayload).includes(shim), false)
  assert.equal(result.text, 'prepared reply')
})

test('Hermes ACP outbound callback failure cannot fall back to legacy delivery', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-hermes-outbound-blocked-'))
  const deliveryFile = path.join(directory, 'delivered.txt')
  const cli = executable(directory, 'hermes-outbound-blocked.cjs', `
const fs = require('node:fs')
if (process.argv[2] !== 'acp') {
  fs.writeFileSync(process.env.MELDWORK_TEST_DELIVERY_FILE, process.argv.at(-1))
  process.stdout.write('unexpected legacy reply\\n')
  process.exit(0)
}
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'hermes-blocked-session' } })
  } else if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    fs.writeFileSync(process.env.MELDWORK_TEST_DELIVERY_FILE, 'acp prompt delivered')
  }
})
`)
  const callbackError = new Error('Hermes outbound payload capture failed')
  let callbackCalls = 0
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  await assert.rejects(
    runAgent(
      { kind: 'hermes', executable: cli, name: 'Hermes' },
      'must not be delivered',
      directory,
      {
        env: { MELDWORK_TEST_DELIVERY_FILE: deliveryFile },
        onOutboundPayload: async () => {
          callbackCalls += 1
          if (callbackCalls === 1) throw callbackError
        },
      },
    ),
    error => error === callbackError,
  )
  assert.equal(callbackCalls, 1)
  assert.equal(fs.existsSync(deliveryFile), false)
})

test('Hermes ACP streams only the current turn after resume history replay', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-hermes-acp-'))
  const modeFile = path.join(directory, 'mode.txt')
  const cli = executable(directory, 'hermes-acp.cjs', `
const fs = require('node:fs')
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
const update = (sessionId, value) => send({
  jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value },
})
input.on('line', (line) => {
  const message = JSON.parse(line)
  const sessionId = message.params?.sessionId || 'hermes-session'
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/resume') {
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'previous answer' },
    })
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/set_mode') {
    fs.writeFileSync(process.env.MELDWORK_TEST_MODE_FILE, message.params.modeId)
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    update(sessionId, {
      sessionUpdate: 'plan',
      entries: [{ content: 'Inspect workspace', priority: 'medium', status: 'in_progress' }],
    })
    update(sessionId, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'PRIVATE_REASONING' },
    })
    update(sessionId, {
      sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'search',
      kind: 'search', status: 'in_progress',
      rawInput: { query: 'targetKinds', AWS_SECRET_ACCESS_KEY: 'aws-secret-value' },
    })
    update(sessionId, {
      sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', title: 'search',
      kind: 'search', status: 'completed', rawOutput: { matches: 2, password: 'hunter2' },
    })
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'current ' },
    })
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' },
    })
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late replay' },
    })
  }
})
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const events = []
  const sessionMetadata = []

  const result = await runAgent(
    { kind: 'hermes', executable: cli, name: 'Hermes' },
    'current prompt',
    directory,
    {
      sessionRef: 'hermes-session',
      sessionTransport: 'acp',
      env: { MELDWORK_TEST_MODE_FILE: modeFile },
      onEvent: event => events.push(event),
      onSessionRef: (sessionRef, metadata) => sessionMetadata.push({ sessionRef, metadata }),
    },
  )

  assert.equal(result.text, 'current answer')
  assert.equal(result.sessionRef, 'hermes-session')
  assert.equal(result.outcome, 'completed')
  assert.equal(fs.readFileSync(modeFile, 'utf8'), 'default')
  assert.equal(events.filter(event => event.type === 'answer_delta')
    .reduce(
      (answer, event) => event.replace === true ? event.delta : answer + event.delta,
      '',
    ), 'current answer')
  assert.equal(events.some(event => (
    event.type === 'reasoning_summary' && event.status === 'running' && !event.summary
  )), true)
  assert.deepEqual(events.filter(event => event.type !== 'reasoning_summary')
    .slice(0, 3).map(event => [event.type, event.status]), [
    ['plan', 'running'],
    ['tool_start', 'running'],
    ['tool_result_summary', 'completed'],
  ])
  assert.match(events.find(event => event.type === 'plan')?.summary || '', /Inspect workspace/)
  const toolResult = events.find(event => event.type === 'tool_result_summary')
  assert.match(toolResult.summary, /query: text \(11 chars\)/)
  assert.match(toolResult.detail, /matches/)
  assert.doesNotMatch(
    JSON.stringify(events),
    /previous answer|late replay|PRIVATE_REASONING|targetKinds|aws-secret-value|hunter2/,
  )
  assert.deepEqual(sessionMetadata, [{
    sessionRef: 'hermes-session', metadata: { transport: 'acp' },
  }])
})

test('MiMo ACP uses the selected profile for pre-terminal plan, tool, and text events', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-mimo-acp-profile-'))
  const readyFile = path.join(directory, 'ready')
  const releaseFile = path.join(directory, 'release')
  const cli = executable(directory, 'mimo-acp-profile.cjs', `
const fs = require('node:fs')
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
const update = (sessionId, value) => send({
  jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value },
})
input.on('line', (line) => {
  const message = JSON.parse(line)
  const sessionId = message.params?.sessionId || 'mimo-acp-session'
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId } })
  } else if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    update(sessionId, {
      sessionUpdate: 'plan',
      entries: [{ content: 'Inspect workspace', priority: 'medium', status: 'in_progress' }],
    })
    update(sessionId, {
      sessionUpdate: 'tool_call', toolCallId: 'mimo-tool-1', title: 'search',
      kind: 'search', status: 'in_progress', rawInput: { query: 'runtime bridge' },
    })
    update(sessionId, {
      sessionUpdate: 'tool_call_update', toolCallId: 'mimo-tool-1', title: 'search',
      kind: 'search', status: 'completed', rawOutput: { matches: 1 },
    })
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'MiMo ACP reply' },
    })
    fs.writeFileSync(process.env.MELDWORK_TEST_READY_FILE, 'ready')
    const finish = () => {
      if (!fs.existsSync(process.env.MELDWORK_TEST_RELEASE_FILE)) return setTimeout(finish, 10)
      send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
    }
    finish()
  }
})
`)
  t.after(() => {
    try { fs.writeFileSync(releaseFile, 'release') } catch { /* test cleanup */ }
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const events = []
  let answerResolve
  const answer = new Promise(resolve => { answerResolve = resolve })
  let resultResolved = false
  let resultError = null
  const resultPromise = runAgent(
    { kind: 'mimo', executable: cli, name: 'MiMo' },
    'hello',
    directory,
    {
      env: {
        MELDWORK_TEST_READY_FILE: readyFile,
        MELDWORK_TEST_RELEASE_FILE: releaseFile,
      },
      onEvent: event => {
        events.push(event)
        if (event.type === 'answer_delta') answerResolve()
      },
    },
  ).then((result) => {
    resultResolved = true
    return result
  }).catch((error) => {
    resultError = error
    return null
  })

  await within(answer)
  await readWhenReady(readyFile)
  assert.equal(resultResolved, false)
  assert.deepEqual(events.map(event => event.type), [
    'plan', 'tool_start', 'tool_result_summary', 'answer_delta',
  ])
  fs.writeFileSync(releaseFile, 'release')
  const result = await resultPromise
  assert.equal(resultError, null)
  assert.deepEqual(result, {
    text: 'MiMo ACP reply', sessionRef: 'mimo-acp-session', outcome: 'completed',
  })
  const answerEvents = events.filter(event => event.type === 'answer_delta')
  assert.equal(answerEvents.length, 2)
  assert.equal(answerEvents.at(-1).status, 'completed')
  assert.equal(answerEvents.at(-1).replace, true)
})

test('a reused ACP session that refuses before any output is recoverable as stale', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-acp-stale-refusal-'))
  const cli = executable(directory, 'acp-stale-refusal.cjs', `
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
input.on('close', () => process.exit(0))
input.on('line', line => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/resume') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'refusal' } })
  }
})
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  await assert.rejects(
    runAgent(
      { kind: 'hermes', executable: cli, name: 'Hermes' },
      'continue the group task',
      directory,
      { sessionRef: 'stale-session', sessionTransport: 'acp', hermesAcpAvailable: true },
    ),
    error => error.message === 'LOCAL_AGENT_SESSION_INVALID',
  )
})

test('ACP terminal stop reasons preserve exact outcome and failure semantics', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-acp-stop-reasons-'))
  const cli = executable(directory, 'acp-stop-reasons.cjs', `
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'stop-reason-session' } })
  } else if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    const prompt = message.params.prompt[0].text
    send({
      jsonrpc: '2.0', method: 'session/update',
      params: {
        sessionId: message.params.sessionId,
        update: {
          sessionUpdate: 'tool_call', toolCallId: 'tool-' + prompt,
          title: 'read', kind: 'read', status: 'in_progress',
          rawInput: { path: '/private/input' },
        },
      },
    })
    send({
      jsonrpc: '2.0', method: 'session/update',
      params: {
        sessionId: message.params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: prompt + ' reply' },
        },
      },
    })
    const stopReasons = {
      refusal: 'refusal',
      unknown: 'future_stop_reason',
      limited: 'max_tokens',
      cancelled: 'cancelled',
    }
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: stopReasons[prompt] } })
  }
})
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const agent = { kind: 'mimo', executable: cli, name: 'MiMo' }

  await t.test('refusal', async () => {
    const events = []
    await assert.rejects(
      runAgent(agent, 'refusal', directory, { onEvent: event => events.push(event) }),
      error => error.message === 'LOCAL_AGENT_REFUSED'
        && error.failure.code === 'LOCAL_AGENT_REFUSED',
    )
    assert.deepEqual(events.find(event => event.type === 'tool_result_summary'), {
      type: 'tool_result_summary', id: 'tool-refusal', status: 'failed', title: 'tool',
    })
  })
  await t.test('unknown stop reason', async () => {
    await assert.rejects(
      runAgent(agent, 'unknown', directory),
      error => error.message === 'LOCAL_AGENT_OUTCOME_INVALID'
        && error.failure.code === 'LOCAL_AGENT_OUTCOME_INVALID',
    )
  })
  await t.test('max tokens', async () => {
    assert.deepEqual(await runAgent(agent, 'limited', directory), {
      text: 'limited reply',
      sessionRef: 'stop-reason-session',
      outcome: 'partial',
    })
  })
  await t.test('cancellation', async () => {
    const events = []
    await assert.rejects(
      runAgent(agent, 'cancelled', directory, { onEvent: event => events.push(event) }),
      error => error.message === 'LOCAL_AGENT_EXECUTION_STOPPED'
        && error.failure.category === 'cancellation',
    )
    assert.deepEqual(events.find(event => event.type === 'tool_result_summary'), {
      type: 'tool_result_summary', id: 'tool-cancelled', status: 'stopped', title: 'tool',
    })
  })
})

test('MiMo and OpenCode retry JSON only after ACP setup failure', async (t) => {
  for (const kind of ['mimo', 'opencode']) {
    await t.test(kind, async (t) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), `meldwork-${kind}-acp-fallback-`))
      const callsFile = path.join(directory, 'calls.jsonl')
      const cli = executable(directory, `${kind}-fallback.cjs`, `
const fs = require('node:fs')
fs.appendFileSync(process.env.MELDWORK_TEST_CALLS_FILE, JSON.stringify(process.argv.slice(2)) + '\\n')
process.stdout.write(JSON.stringify({
  type: 'text', sessionID: '${kind}-json-session',
  part: { type: 'text', text: '${kind} JSON fallback' },
}) + '\\n')
process.stdout.write(JSON.stringify({
  type: 'step_finish', sessionID: '${kind}-json-session',
  part: { type: 'step-finish', reason: 'stop' },
}) + '\\n')
`)
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
      const events = []

      const result = await runAgent(
        { kind, executable: cli, name: kind },
        'hello',
        directory,
        {
          env: { MELDWORK_TEST_CALLS_FILE: callsFile },
          loadAcpSdkFn: async () => { throw new Error('ACP SDK unavailable') },
          onEvent: event => events.push(event),
        },
      )

      const calls = fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      assert.equal(result.text, `${kind} JSON fallback`)
      assert.equal(calls.length, 1)
      assert.equal(calls[0][0], 'run')
      assert.equal(events.filter(event => event.title === 'connector_fallback').length, 1)
    })
  }
})

test('MiMo and OpenCode preserve resumed sessions through JSON setup fallback', async (t) => {
  for (const kind of ['mimo', 'opencode']) {
    await t.test(kind, async (t) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), `meldwork-${kind}-resume-fallback-`))
      const cli = executable(directory, `${kind}-resume-fallback.cjs`, `
const sessionIndex = process.argv.indexOf('--session')
const sessionRef = sessionIndex === -1 ? '' : process.argv[sessionIndex + 1]
if (!sessionRef) {
  process.stdout.write(JSON.stringify({
    type: 'text', sessionID: '${kind}-fresh-session',
    part: { type: 'text', text: 'unexpected fresh success' },
  }) + '\\n')
  process.stdout.write(JSON.stringify({
    type: 'step_finish', sessionID: '${kind}-fresh-session',
    part: { type: 'step-finish', reason: 'stop' },
  }) + '\\n')
} else {
  process.stdout.write(JSON.stringify({
    type: 'text', sessionID: sessionRef,
    part: { type: 'text', text: 'resumed ' + sessionRef },
  }) + '\\n')
  process.stdout.write(JSON.stringify({
    type: 'step_finish', sessionID: sessionRef,
    part: { type: 'step-finish', reason: 'stop' },
  }) + '\\n')
}
`)
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
      const sessionRef = `${kind}-existing-session`

      const result = await runAgent(
        { kind, executable: cli, name: kind },
        'continue',
        directory,
        {
          sessionRef,
          loadAcpSdkFn: async () => { throw new Error('ACP SDK unavailable') },
        },
      )

      assert.deepEqual(result, {
        text: `resumed ${sessionRef}`,
        sessionRef,
        outcome: 'completed',
      })
    })
  }
})

test('MiMo and OpenCode propagate invalid resumed sessions from JSON setup fallback', async (t) => {
  for (const kind of ['mimo', 'opencode']) {
    await t.test(kind, async (t) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), `meldwork-${kind}-invalid-fallback-`))
      const cli = executable(directory, `${kind}-invalid-fallback.cjs`, `
const sessionIndex = process.argv.indexOf('--session')
const sessionRef = sessionIndex === -1 ? '' : process.argv[sessionIndex + 1]
if (sessionRef) {
  process.stderr.write('No session found with session ID ' + sessionRef)
  process.exit(1)
}
process.stdout.write(JSON.stringify({
  type: 'text', sessionID: '${kind}-fresh-session',
  part: { type: 'text', text: 'unexpected fresh success' },
}) + '\\n')
process.stdout.write(JSON.stringify({
  type: 'step_finish', sessionID: '${kind}-fresh-session',
  part: { type: 'step-finish', reason: 'stop' },
}) + '\\n')
`)
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
      const sessionRef = `${kind}-stale-session`

      await assert.rejects(
        runAgent(
          { kind, executable: cli, name: kind },
          'continue',
          directory,
          {
            sessionRef,
            loadAcpSdkFn: async () => { throw new Error('ACP SDK unavailable') },
          },
        ),
        error => error.message === 'LOCAL_AGENT_SESSION_INVALID'
          && error.failure.sessionInvalid === true,
      )
    })
  }
})

test('ACP setup fallback absorbs asynchronous warning callback rejection', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-acp-fallback-async-event-'))
  const cli = executable(directory, 'acp-fallback-async-event.cjs', `
process.stdout.write(JSON.stringify({
  type: 'text', sessionID: 'fallback-event-session',
  part: { type: 'text', text: 'fallback reply' },
}) + '\\n')
process.stdout.write(JSON.stringify({
  type: 'step_finish', sessionID: 'fallback-event-session',
  part: { type: 'step-finish', reason: 'stop' },
}) + '\\n')
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const rejection = Promise.reject(new Error('renderer callback failed'))
  rejection.then(undefined, () => {})
  const originalCatch = rejection.catch.bind(rejection)
  let absorbed = false
  rejection.catch = (handler) => {
    absorbed = true
    return originalCatch(handler)
  }

  const result = await runAgent(
    { kind: 'mimo', executable: cli, name: 'MiMo' },
    'hello',
    directory,
    {
      loadAcpSdkFn: async () => { throw new Error('ACP SDK unavailable') },
      onEvent: event => event.title === 'connector_fallback' ? rejection : undefined,
    },
  )

  assert.equal(result.text, 'fallback reply')
  assert.equal(absorbed, true)
})

test('MiMo and OpenCode never retry JSON after session prompt delivery', async (t) => {
  for (const kind of ['mimo', 'opencode']) {
    await t.test(kind, async (t) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), `meldwork-${kind}-acp-no-retry-`))
      const callsFile = path.join(directory, 'calls.jsonl')
      const cli = executable(directory, `${kind}-no-retry.cjs`, `
const fs = require('node:fs')
const readline = require('node:readline')
fs.appendFileSync(process.env.MELDWORK_TEST_CALLS_FILE, JSON.stringify(process.argv.slice(2)) + '\\n')
if (process.argv[2] !== 'acp') {
  process.stdout.write(JSON.stringify({
    type: 'text', sessionID: '${kind}-unexpected-fallback',
    part: { type: 'text', text: 'unexpected fallback' },
  }) + '\\n')
  process.stdout.write(JSON.stringify({
    type: 'step_finish', sessionID: '${kind}-unexpected-fallback',
    part: { type: 'step-finish', reason: 'stop' },
  }) + '\\n')
} else {
  const input = readline.createInterface({ input: process.stdin })
  const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
  input.on('line', (line) => {
    const message = JSON.parse(line)
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
    } else if (message.method === 'session/new') {
      send({ jsonrpc: '2.0', id: message.id, result: { sessionId: '${kind}-acp-session' } })
    } else if (message.method === 'session/set_mode') {
      send({ jsonrpc: '2.0', id: message.id, result: {} })
    } else if (message.method === 'session/prompt') {
      send({ jsonrpc: '2.0', id: message.id,
        error: { code: -32000, message: 'failed after prompt delivery' } })
    }
  })
}
`)
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
      const events = []

      await assert.rejects(
        runAgent(
          { kind, executable: cli, name: kind },
          'hello',
          directory,
          {
            env: { MELDWORK_TEST_CALLS_FILE: callsFile },
            onEvent: event => events.push(event),
          },
        ),
        error => error.message === 'LOCAL_AGENT_PROCESS_FAILED',
      )

      const calls = fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      assert.equal(calls.length, 1)
      assert.equal(calls[0][0], 'acp')
      assert.equal(events.some(event => event.title === 'connector_fallback'), false)
    })
  }
})

test('Hermes legacy profile accumulates official quiet stdout as the fallback reply', () => {
  assert.deepEqual(profileOutput(
    'hermes',
    '\u001b[32mHermes process output\u001b[0m\n',
    'hermes-session-123',
  ), {
    text: 'Hermes process output',
    sessionRef: 'hermes-session-123',
    outcome: 'completed',
  })
})

test('Hermes ACP keeps explicit Provider credentials out of process arguments', () => {
  const spec = invocation('hermes', '/tmp/hermes', '/tmp', '', {
    provider: { id: 'openai-api', model: 'glm' },
  })
  assert.deepEqual(spec.args, ['acp'])
  assert.equal(spec.acpMode, 'default')
  assert.equal(spec.args.some(value => value.includes('test-secret')), false)
})

test('Hermes receives selected Skill snapshots through the prompt without native CLI flags', () => {
  const legacySpec = invocation('hermes', '/tmp/hermes', '/tmp', 'hermes-session-123', {
    skills: ['research', 'code-review', 'research'],
    hermesAcpAvailable: false,
  })
  assert.deepEqual(legacySpec.args, [
    'chat', '--quiet',
    '--resume', 'hermes-session-123',
    '--query',
  ])
  assert.equal(legacySpec.args.includes('--skills'), false)

  const acpSpec = invocation('hermes', '/tmp/hermes', '/tmp', '', {
    skills: ['research'],
  })
  assert.deepEqual(acpSpec.args, ['acp'])
})

test('Pi uses non-interactive JSON flags and keeps provider settings out of arguments', () => {
  const spec = invocation('pi', '/tmp/pi', '/tmp', 'pi-session-123', {
    provider: { id: 'zgci', model: 'glm' },
  })
  assert.deepEqual(spec.args, [
    '--mode', 'json', '--print', '--no-approve', '--tools', 'read,grep,find,ls', '--session', 'pi-session-123',
  ])
  assert.equal(spec.promptArg, true)
  assert.equal(spec.eventTransport, 'json')
  assert.equal(typeof parsePiOutput, 'function')
})

test('WorkBuddy write mode accepts edits without skipping every permission check', () => {
  const writable = invocation('workbuddy', '/tmp/codebuddy', '/tmp', '', { sandbox: 'workspace-write' })
  assert.equal(writable.args[writable.args.indexOf('--permission-mode') + 1], 'acceptEdits')
  assert.equal(writable.args.includes('--dangerously-skip-permissions'), false)
  const readOnly = invocation('workbuddy', '/tmp/codebuddy', '/tmp', '', { sandbox: 'read-only' })
  assert.equal(readOnly.args[readOnly.args.indexOf('--permission-mode') + 1], 'plan')
})

test('Hermes forwards one image and rejects additional images instead of dropping them', () => {
  const first = path.resolve('diagram-one.png')
  const second = path.resolve('diagram-two.png')
  // ACP Hermes keeps its session and receives the image as a content block.
  const spec = invocation('hermes', '/tmp/hermes', '/tmp', '', {
    attachments: [first],
  })
  assert.deepEqual(spec.args, ['acp'])
  assert.deepEqual(spec.imageAttachments, [first])
  // A conversation already on the legacy transport passes the image argument.
  const legacy = invocation('hermes', '/tmp/hermes', '/tmp', 'hermes-legacy-session', {
    attachments: [first],
    sessionTransport: 'legacy',
  })
  assert.deepEqual(legacy.args, [
    'chat', '--quiet', '--resume', 'hermes-legacy-session', '--image', first, '--query',
  ])
  assert.throws(
    () => invocation('hermes', '/tmp/hermes', '/tmp', '', {
      attachments: [first, second],
    }),
    { message: 'LOCAL_AGENT_IMAGE_LIMIT' },
  )
})

test('image capability rejects unsupported Agents and malformed paths before spawning', () => {
  assert.equal(imageAttachmentLimit('codex'), 4)
  assert.equal(imageAttachmentLimit('hermes'), 1)
  assert.equal(imageAttachmentLimit('opencode'), 4)
  assert.equal(imageAttachmentLimit('claude'), 0)
  assert.throws(
    () => invocation('claude', '/tmp/claude', '/tmp', '', {
      attachments: [path.resolve('diagram.png')],
    }),
    { message: 'LOCAL_AGENT_IMAGE_UNSUPPORTED' },
  )
  assert.throws(
    () => invocation('codex', '/tmp/codex', '/tmp', '', {
      attachments: ['relative.png'],
    }),
    { message: 'LOCAL_ATTACHMENT_REFERENCE_INVALID' },
  )
})

test('runAgent enables Hermes non-interactive execution only for workspace write mode', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-hermes-env-'))
  const resultFile = path.join(directory, 'hermes-env-result.json')
  const cli = executable(directory, 'hermes-env.cjs', `
const fs = require('node:fs')
fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({
  ask: process.env.HERMES_EXEC_ASK,
  yolo: process.env.HERMES_YOLO_MODE,
}))
process.stderr.write('session_id: hermes-env-session\\n')
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let finalLookup

  const result = await runAgent(
    { kind: 'hermes', executable: cli, name: 'Hermes' },
    'hello',
    directory,
    {
      home: directory,
      sandbox: 'workspace-write',
      hermesAcpAvailable: false,
      env: { HERMES_EXEC_ASK: '0', HERMES_YOLO_MODE: '1' },
      hermesMessageWatermarkFn: () => 0,
      hermesFinalResponseFn: (sessionRef, lookupOptions) => {
        finalLookup = { sessionRef, lookupOptions }
        return fs.readFileSync(resultFile, 'utf8')
      },
    },
  )

  assert.deepEqual(JSON.parse(result.text), { ask: '', yolo: '1' })
  assert.equal(finalLookup.sessionRef, 'hermes-env-session')
  assert.equal(finalLookup.lookupOptions.afterMessageId, 0)
})

test('runAgent restores the Hermes session id reported on successful stderr', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-hermes-session-'))
  const cli = executable(directory, 'hermes-session.cjs', `
process.stdout.write('Hermes reply')
process.stderr.write('diagnostic\\nsession_id: hermes-session-123\\n')
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = await runAgent(
    { kind: 'hermes', executable: cli, name: 'Hermes' },
    'hello',
    directory,
    {
      home: directory,
      hermesAcpAvailable: false,
      hermesMessageWatermarkFn: () => 23,
      hermesFinalResponseFn: () => 'Hermes reply',
    },
  )

  assert.deepEqual(result, {
    text: 'Hermes reply',
    sessionRef: 'hermes-session-123',
    outcome: 'completed',
  })
})

test('legacy profile restores Session/final after close without review-diff progress', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-hermes-final-'))
  const readyFile = path.join(directory, 'ready')
  const releaseFile = path.join(directory, 'release')
  const cli = executable(directory, 'hermes-final.cjs', `
const fs = require('node:fs')
process.stdout.write('┊ planning\\nnoisy stdout fallback')
process.stderr.write('┊ review diff\\na//tmp/report.py → b//tmp/report.py\\n@@ -0,0 +1 @@\\n+tool trace\\nsession_id: hermes-session-final\\n')
fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready')
const finish = () => {
  if (!fs.existsSync(${JSON.stringify(releaseFile)})) return setTimeout(finish, 10)
}
finish()
  `)
  const progress = []
  const events = []
  const lifecycle = []
  let finalLookup
  t.after(() => {
    try { fs.writeFileSync(releaseFile, 'release') } catch { /* test cleanup */ }
    fs.rmSync(directory, { recursive: true, force: true })
  })

  let resultResolved = false
  const resultPromise = runAgent(
    { kind: 'hermes', executable: cli, name: 'Hermes' },
    'hello',
    directory,
    {
      env: { OPENAI_API_KEY: 'test-secret-value' },
      hermesAcpAvailable: false,
      onEvent: event => events.push(event),
      onProgress: step => progress.push(step),
      onSessionRef: async (sessionRef) => lifecycle.push(`session:${sessionRef}`),
      hermesMessageWatermarkFn: () => 41,
      hermesFinalResponseFn: (sessionRef, lookupOptions) => {
        lifecycle.push('final-lookup')
        finalLookup = { sessionRef, lookupOptions }
        return sessionRef === 'hermes-session-final'
          ? 'Hermes authoritative final test-secret-value'
          : ''
      },
    },
  ).then((result) => {
    resultResolved = true
    return result
  })

  await readWhenReady(readyFile)
  assert.equal(resultResolved, false)
  assert.equal(events.some(event => event.type === 'answer_delta'), false)
  fs.writeFileSync(releaseFile, 'release')
  const result = await resultPromise

  assert.deepEqual(result, {
    text: 'Hermes authoritative final [redacted]',
    sessionRef: 'hermes-session-final',
    outcome: 'completed',
  })
  assert.deepEqual(progress, [])
  assert.deepEqual(lifecycle, ['session:hermes-session-final', 'final-lookup'])
  assert.equal(finalLookup.sessionRef, 'hermes-session-final')
  assert.equal(finalLookup.lookupOptions.afterMessageId, 41)
  assert.doesNotMatch(result.text, /review diff|tool trace|noisy stdout|test-secret-value/)
  assert.deepEqual(events.filter(event => event.type === 'answer_delta'), [{
    type: 'answer_delta', status: 'completed', delta: 'Hermes authoritative final [redacted]',
  }])
})

test('Hermes final lookup accepts post-watermark stop and length rows through a read-only query seam', () => {
  const rows = [
    {
      id: 40, session_id: 'session-1', role: 'assistant',
      content: 'previous turn final', finish_reason: 'stop',
    },
    {
      id: 41, session_id: 'session-1', role: 'assistant',
      content: 'current process draft', finish_reason: 'tool_calls',
    },
  ]
  const queries = []
  const queryFn = (query) => {
    queries.push(query)
    if (/MAX\(id\)/.test(query.sql)) return { max_id: 40 }
    const [sessionRef, afterMessageId] = query.params
    return rows
      .filter(row => row.session_id === sessionRef
        && row.id > afterMessageId
        && row.role === 'assistant'
        && ['stop', 'length'].includes(row.finish_reason)
        && row.content.trim())
      .sort((left, right) => right.id - left.id)[0]
  }
  const stateOptions = {
    home: '/virtual/hermes-home',
    existsFn: () => true,
    queryFn,
  }

  const watermark = readHermesMessageWatermark(stateOptions)
  assert.equal(watermark, 40)
  assert.equal(readHermesFinalResponse('session-1', {
    ...stateOptions, afterMessageId: watermark,
  }), '')

  rows.push({
    id: 42, session_id: 'session-1', role: 'assistant',
    content: 'token-limited current final', finish_reason: 'length',
  })
  assert.equal(readHermesFinalResponse('session-1', {
    ...stateOptions, afterMessageId: watermark,
  }), 'token-limited current final')
  rows.push({
    id: 43, session_id: 'session-1', role: 'assistant',
    content: 'authoritative current final', finish_reason: 'stop',
  })
  assert.equal(readHermesFinalResponse('session-1', {
    ...stateOptions, afterMessageId: watermark,
  }), 'authoritative current final')
  assert.equal(queries.every(query => query.readOnly === true), true)
  assert.match(queries.at(-1).sql, /id > \?/)
  assert.match(queries.at(-1).sql, /finish_reason IN \('stop', 'length'\)/)
  assert.deepEqual(queries.at(-1).params, ['session-1', 40])

  const failedQuery = () => { throw new Error('schema changed') }
  assert.equal(readHermesMessageWatermark({
    ...stateOptions, queryFn: failedQuery,
  }), null)
  assert.equal(readHermesFinalResponse('session-1', {
    ...stateOptions, afterMessageId: 40, queryFn: failedQuery,
  }), '')
  assert.equal(readHermesMessageWatermark({
    ...stateOptions, existsFn: () => false,
  }), 0)
})

test('runAgent falls back to Hermes quiet stdout when no post-watermark final exists', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-hermes-no-final-'))
  const processProgress = Array.from({ length: 10 }, () => '┊ review diff').join('\n')
  const cli = executable(directory, 'hermes-no-final.cjs', `
process.stdout.write('Hermes quiet fallback')
process.stderr.write(${JSON.stringify(`${processProgress}\nsession_id: hermes-session-no-final\n`)})
  `)
  const progress = []
  let finalLookup
  const lifecycle = []
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = await runAgent(
    { kind: 'hermes', executable: cli, name: 'Hermes' },
    'hello',
    directory,
    {
      onProgress: step => progress.push(step),
      hermesAcpAvailable: false,
      onSessionRef: async (sessionRef) => {
        await new Promise(resolve => setImmediate(resolve))
        lifecycle.push(`session:${sessionRef}`)
      },
      hermesMessageWatermarkFn: () => 52,
      hermesFinalResponseFn: (sessionRef, lookupOptions) => {
        lifecycle.push('final-lookup')
        finalLookup = { sessionRef, lookupOptions }
        return ''
      },
    },
  )
  assert.equal(result.text, 'Hermes quiet fallback')
  assert.equal(result.sessionRef, 'hermes-session-no-final')
  assert.equal(finalLookup.sessionRef, 'hermes-session-no-final')
  assert.equal(finalLookup.lookupOptions.afterMessageId, 52)
  assert.deepEqual(lifecycle, [
    'session:hermes-session-no-final',
    'final-lookup',
  ])
  assert.deepEqual(progress, [])
})

test('runAgent persists the Hermes session before falling back from a throwing final lookup', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-hermes-lookup-failure-'))
  const cli = executable(directory, 'hermes-lookup-failure.cjs', `
process.stdout.write('process output only')
process.stderr.write('session_id: hermes-session-lookup-failure\\n')
`)
  const lifecycle = []
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = await runAgent(
    { kind: 'hermes', executable: cli, name: 'Hermes' },
    'hello',
    directory,
    {
      onSessionRef: async (sessionRef) => {
        await new Promise(resolve => setImmediate(resolve))
        lifecycle.push(`session:${sessionRef}`)
      },
      hermesAcpAvailable: false,
      hermesMessageWatermarkFn: () => 61,
      hermesFinalResponseFn: () => {
        lifecycle.push('final-lookup')
        throw new Error('schema changed')
      },
    },
  )
  assert.equal(result.text, 'process output only')
  assert.equal(result.sessionRef, 'hermes-session-lookup-failure')
  assert.deepEqual(lifecycle, [
    'session:hermes-session-lookup-failure',
    'final-lookup',
  ])
})

test('runAgent still starts Hermes and uses quiet stdout when the pre-run watermark is unavailable', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-hermes-no-watermark-'))
  const cli = executable(directory, 'hermes-no-watermark.cjs', `
process.stdout.write('\\u001b[36mHermes quiet fallback\\u001b[0m\\n')
process.stderr.write('session_id: hermes-session-no-watermark\\n')
  `)
  let finalLookupCount = 0
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = await runAgent(
    { kind: 'hermes', executable: cli, name: 'Hermes' },
    'hello',
    directory,
    {
      hermesAcpAvailable: false,
      hermesMessageWatermarkFn: () => null,
      hermesFinalResponseFn: () => {
        finalLookupCount += 1
        return 'previous turn final'
      },
    },
  )
  assert.deepEqual(result, {
    text: 'Hermes quiet fallback',
    sessionRef: 'hermes-session-no-watermark',
    outcome: 'completed',
  })
  assert.equal(finalLookupCount, 0)
})

test('OpenClaw terminal profile accumulates JSON output as reply text', () => {
  const raw = JSON.stringify({
    payloads: [{ text: '第一段' }, { text: '第二段' }],
    meta: { aborted: false, completion: { stopReason: 'stop' } },
  })
  assert.deepEqual(profileOutput('openclaw', raw, 'agent:main:desktop-meldwork-group-openclaw'), {
    text: '第一段\n第二段',
    sessionRef: 'agent:main:desktop-meldwork-group-openclaw',
    outcome: 'completed',
  })
})

test('OpenClaw ACP binds the stable group Session key without prefixing cwd', () => {
  const spec = invocation(
    'openclaw', '/tmp/openclaw', '/tmp/work', 'agent:main:desktop-meldwork-group-openclaw',
  )
  assert.deepEqual(spec.args, [
    '--no-color', '--log-level', 'info',
    'acp', '--session', 'agent:main:desktop-meldwork-group-openclaw',
    '--no-prefix-cwd', '--verbose',
  ])
  assert.equal(spec.eventTransport, 'acp')
  assert.equal(spec.openClawGateway, true)
  assert.equal(spec.publicSessionRef, 'agent:main:desktop-meldwork-group-openclaw')
})

test('runAgent uses the app-signed OpenClaw workspace', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-openclaw-workspace-'))
  const workdir = path.join(directory, 'workspace')
  fs.mkdirSync(workdir)
  const cli = executable(directory, 'openclaw-workspace.cjs', `
process.stdout.write(JSON.stringify({
  payloads: [{ text: process.env.OPENCLAW_WORKSPACE_DIR }],
}))
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const runtime = openClawAdapterRuntime(directory, workdir, 'agent:main:adapter-workspace')

  const events = []
  const result = await runAgent(
    { kind: 'openclaw', executable: cli, name: 'OpenClaw' },
    'hello',
    workdir,
    {
      ...runtime,
      onEvent: event => events.push(event),
    },
  )

  assert.equal(result.text, workdir)
  assert.deepEqual(events.filter(event => event.type === 'warning').map(event => event.title), [
    'connector_fallback',
    'connector_limited',
  ])
  assert.equal(events.filter(event => event.type === 'answer_delta')
    .reduce(
      (answer, event) => event.replace === true ? event.delta : answer + event.delta,
      '',
    ), '[path]')
})

test('OpenClaw keeps the re-signed runtime guard when ACP setup falls back to legacy', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-openclaw-acp-fallback-'))
  const workdir = path.join(directory, 'workspace')
  const stoppedFile = path.join(directory, 'gateway-stopped')
  const healthProbeFile = path.join(directory, 'gateway-health-probe.json')
  const legacyProbeFile = path.join(directory, 'legacy-probe.json')
  fs.mkdirSync(workdir)
  const cli = executable(directory, 'openclaw-acp-fallback.cjs', `
const fs = require('node:fs')
const args = process.argv.slice(2)
const globalArgs = ['--no-color', '--log-level', 'info']
const commandOffset = globalArgs.every((value, index) => args[index] === value)
  ? globalArgs.length
  : 0
if (args[commandOffset] === 'gateway' && args[commandOffset + 1] === 'health') {
  const token = process.env.OPENCLAW_GATEWAY_TOKEN || ''
  fs.writeFileSync(${JSON.stringify(healthProbeFile)}, JSON.stringify({
    args,
    hasGatewayToken: token.length >= 32,
    tokenInArgs: Boolean(token && args.join(' ').includes(token)),
  }))
  process.stdout.write(JSON.stringify({ ok: true }))
  process.exit(0)
}
if (args[commandOffset] === 'gateway' && args[commandOffset + 1] === 'run') {
  process.stdout.write('[gateway] ready\\n')
  process.on('SIGTERM', () => {
    fs.writeFileSync(${JSON.stringify(stoppedFile)}, 'stopped')
    process.exit(0)
  })
  setInterval(() => {}, 1000)
  return
}
if (args[commandOffset] === 'acp') {
  process.stderr.write('ACP setup failed')
  process.exit(2)
}
if (args[0] !== 'agent') process.exit(3)
const config = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, 'utf8'))
fs.writeFileSync(${JSON.stringify(legacyProbeFile)}, JSON.stringify({
  gatewayPort: config.gateway?.port,
  hasGatewayToken: (process.env.OPENCLAW_GATEWAY_TOKEN || '').length >= 32,
}))
process.stdout.write(JSON.stringify({
  payloads: [{ text: 'OpenClaw legacy fallback' }],
  meta: { aborted: false, completion: { stopReason: 'stop' } },
}))
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const stableSessionRef = 'agent:main:openclaw-acp-fallback'
  const runtime = openClawAdapterRuntime(directory, workdir, stableSessionRef)

  const result = await runAgent(
    { kind: 'openclaw', executable: cli, name: 'OpenClaw' },
    'hello',
    workdir,
    { ...runtime, sessionRef: stableSessionRef },
  )

  assert.deepEqual(result, {
    text: 'OpenClaw legacy fallback',
    sessionRef: stableSessionRef,
    outcome: 'completed',
  })
  assert.equal(await readWhenReady(stoppedFile), 'stopped')
  const probe = await readJsonWhenReady(legacyProbeFile)
  const healthProbe = await readJsonWhenReady(healthProbeFile)
  assert.equal(Number.isInteger(probe.gatewayPort), true)
  assert.equal(probe.hasGatewayToken, true)
  assert.equal(healthProbe.hasGatewayToken, true)
  assert.equal(healthProbe.tokenInArgs, false)
  assert.deepEqual(healthProbe.args, [
    '--no-color', '--log-level', 'info', 'gateway', 'health',
    '--port', String(probe.gatewayPort),
    '--timeout', '5000',
    '--json',
  ])
})

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { AGENT_RUNTIME_CAPABILITIES } = require('../../../src/agents/agent-runtime-contract.cjs')
const { createStructuredOutputAccumulator } = require('../../../src/agents/cli/cli-output-parsers.cjs')
const {
  ALLOWED_KINDS,
  detectAgents,
  imageAttachmentLimit,
  invocation,
  parseCodexOutput,
  parseGeminiOutput,
  parseKimiOutput,
  parseMimoOutput,
  parseOpenCodeOutput,
  parseOpenCodeReviewOutput,
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
const {
  executable,
  readJsonWhenReady,
  readWhenReady,
  waitForExit,
  within,
} = require('../../support/cli-adapters-test-helpers.cjs')

const OUTPUT_FIXTURE_DIRECTORY = path.join(__dirname, '..', '..', 'fixtures', 'agent-output')
const OUTBOUND_PAYLOAD_KEYS = [
  'prompt',
  'promptMode',
  'serialization',
  'transport',
  'wirePayloadBytes',
  'wirePayloadHash',
]

function profileOutput(kind, stdout, sessionRef = '', requestedTransport = '') {
  const transport = requestedTransport ? { transport: requestedTransport }
    : kind === 'hermes' ? { transport: 'legacy' }
    : kind === 'kimi' ? { transport: 'stream-json' }
      : {}
  const profile = resolveConnectorEventProfile(kind, transport)
  const accumulator = profile.createFinalOutputAccumulator(sessionRef)
  const bytes = Buffer.from(stdout)
  accumulator.capture?.(bytes)
  accumulator.write?.(bytes)
  return accumulator.end({ sessionRef })
}

function wireFingerprint(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value), 'utf8')
  return {
    wirePayloadHash: crypto.createHash('sha256').update(bytes).digest('hex'),
    wirePayloadBytes: bytes.length,
  }
}

function permissionRequestExecutable(directory) {
  return executable(directory, 'kimi-acp-permission.cjs', `
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
let promptRequest
input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'permission-session' } })
  } else if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    promptRequest = message
    send({
      jsonrpc: '2.0', id: 77, method: 'session/request_permission',
      params: {
        _meta: { providerSecret: process.env.MELDWORK_TEST_SECRET },
        sessionId: 'permission-session',
        toolCall: {
          _meta: { providerSecret: process.env.MELDWORK_TEST_SECRET },
          toolCallId: 'tool-1',
          title: 'write /Users/private/workspace token=' + process.env.MELDWORK_TEST_SECRET
            + ' api_key=sk-testpermissionsecret123456789',
          kind: 'edit',
          status: 'pending',
          content: [{ type: 'content', content: { type: 'text', text: 'private content' } }],
          locations: [{ path: '/Users/private/workspace' }],
          rawInput: { command: 'touch /Users/private/workspace/private.txt' },
          rawOutput: 'private output',
        },
        options: [
          {
            _meta: { providerSecret: process.env.MELDWORK_TEST_SECRET },
            optionId: 'allow-once', name: 'Allow once', kind: 'allow_once',
          },
          {
            _meta: { providerSecret: process.env.MELDWORK_TEST_SECRET },
            optionId: 'reject-once', name: 'Reject once', kind: 'reject_once',
          },
        ],
      },
    })
  } else if (message.id === 77) {
    const outcome = message.result.outcome
    const text = outcome.outcome + '|' + (outcome.optionId || '')
    send({
      jsonrpc: '2.0', method: 'session/update',
      params: {
        sessionId: 'permission-session',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      },
    })
    send({ jsonrpc: '2.0', id: promptRequest.id, result: { stopReason: 'end_turn' } })
  } else if (message.method === 'session/cancel') {
    process.exit(0)
  }
})
`)
}

function signedOpenClawRuntime(storageRoot, workdir, sessionRef) {
  return nativeOpenClawOptions({
    storageRoot,
    workdir,
    sessionRef,
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

test('WorkBuddy uses non-interactive output and resumes its native session', () => {
  const spec = invocation('workbuddy', '/tmp/codebuddy', '/tmp/work', 'workbuddy-session')
  assert.equal(spec.promptArg, true)
  assert.deepEqual(spec.args, [
    '--print', '--output-format', 'stream-json', '--include-partial-messages',
    '--permission-mode', 'plan',
    '--max-turns', '8', '--resume', 'workbuddy-session',
  ])
  assert.equal(spec.eventTransport, 'stream-json')
})

test('WorkBuddy configuration enables edits only after explicit authorization', () => {
  const spec = invocation('workbuddy', '/tmp/codebuddy', '/tmp/work', '', {
    sandbox: 'workspace-write',
  })
  assert.equal(spec.args[spec.args.indexOf('--permission-mode') + 1], 'acceptEdits')
})

test('WorkBuddy JSON output returns the final reply and session id', () => {
  const raw = JSON.stringify([
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'draft' }] },
    { type: 'result', result: 'final reply', session_id: 'workbuddy-session' },
  ])
  assert.deepEqual(parseWorkBuddyOutput(raw), {
    text: 'final reply',
    sessionRef: 'workbuddy-session',
  })
})

test('Kimi uses ACP plan mode by default and prompt mode only after write authorization', () => {
  const chat = invocation('kimi', '/tmp/kimi', '/tmp/work')
  assert.deepEqual(chat.args, ['acp'])
  assert.equal(chat.acpMode, 'plan')
  assert.equal(chat.promptArg, undefined)

  const resumed = invocation('kimi', '/tmp/kimi', '/tmp/work', 'kimi-session')
  assert.deepEqual(resumed.args, ['acp'])
  assert.equal(resumed.acpMode, 'plan')

  const writable = invocation('kimi', '/tmp/kimi', '/tmp/work', 'kimi-session', {
    sandbox: 'workspace-write',
  })
  assert.deepEqual(writable.args, [
    '--output-format', 'stream-json', '--auto', '--session', 'kimi-session', '--prompt',
  ])
  assert.equal(writable.args.includes('--plan'), false)
  assert.equal(writable.args.includes('--auto'), true)
})

test('Kimi stream JSON output returns assistant text and the native session id', () => {
  const raw = [
    JSON.stringify({ role: 'assistant', content: '第一段' }),
    JSON.stringify({ role: 'tool', tool_call_id: 'tool-1', content: 'ignored' }),
    JSON.stringify({ role: 'assistant', content: '第二段' }),
    JSON.stringify({
      role: 'meta',
      type: 'session.resume_hint',
      session_id: '64741dae-cecb-4540-9356-6dc10a5cca47',
    }),
  ].join('\n')
  assert.deepEqual(parseKimiOutput(raw), {
    text: '第一段\n第二段',
    sessionRef: '64741dae-cecb-4540-9356-6dc10a5cca47',
  })
})

test('Kimi ACP plan mode creates and resumes sessions while reporting incomplete turns', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-kimi-acp-'))
  const workdir = fs.realpathSync(directory)
  const lifecycleFile = path.join(directory, 'lifecycle.log')
  const promptDeliveryFile = path.join(directory, 'prompt-delivery.log')
  const cli = executable(directory, 'kimi-acp.cjs', `
const fs = require('node:fs')
if (process.argv.includes('--prompt')) {
  process.stderr.write('legacy prompt mode used')
  process.exit(2)
}
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
const record = value => fs.appendFileSync(process.env.MELDWORK_TEST_LIFECYCLE_FILE, value + '\\n')
process.on('SIGTERM', () => {
  record('sigterm')
  process.exit(0)
})
input.on('close', () => record('stdin-close'))
let setup = ''
let sessionId = ''
let mode = ''
let promptRequest = null
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/new') {
    setup = 'new'
    sessionId = process.env.MELDWORK_TEST_SECRET || 'kimi-acp-session'
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId } })
  } else if (message.method === 'session/resume') {
    setup = 'resume'
    sessionId = message.params.sessionId
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/set_mode') {
    if (message.params.sessionId !== sessionId) process.exit(3)
    mode = message.params.modeId
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    if (message.params.sessionId !== sessionId) process.exit(4)
    fs.appendFileSync(
      process.env.MELDWORK_TEST_PROMPT_DELIVERY_FILE,
      line + '\\n',
    )
    promptRequest = message
    send({
      jsonrpc: '2.0', id: 99, method: 'session/request_permission',
      params: { sessionId, toolCall: { toolCallId: 'tool-1', title: 'write' }, options: [] },
    })
  } else if (message.id === 99) {
    const text = [
      setup,
      mode,
      message.result.outcome.outcome,
      promptRequest.params.prompt[0].text,
      process.cwd(),
    ].join('|')
    send({
      jsonrpc: '2.0', method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: {
            type: 'text',
            text: 'PRIVATE_CHAIN_OF_THOUGHT command=rg /Users/private/workspace',
          },
        },
      },
    })
    send({
      jsonrpc: '2.0', method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'tool_call', toolCallId: 'tool-1',
          title: 'command=rg /Users/private/workspace', kind: 'search', status: 'in_progress',
          rawInput: { command: 'rg /Users/private/workspace' },
          locations: [{ path: '/Users/private/workspace' }],
        },
      },
    })
    send({
      jsonrpc: '2.0', method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update', toolCallId: 'tool-1',
          title: 'stderr=private tool output', kind: 'search', status: 'completed',
          rawOutput: 'private tool output',
        },
      },
    })
    send({
      jsonrpc: '2.0', method: 'session/update',
      params: {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      },
    })
    const stopReason = promptRequest.params.prompt[0].text === 'cancelled prompt'
      ? 'cancelled'
      : 'end_turn'
    send({ jsonrpc: '2.0', id: promptRequest.id, result: { stopReason } })
  }
})
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const env = {
    MELDWORK_TEST_LIFECYCLE_FILE: lifecycleFile,
    MELDWORK_TEST_PROMPT_DELIVERY_FILE: promptDeliveryFile,
  }
  const createdSessionRefs = []
  const createdEvents = []
  const createdOutboundPayloads = []

  const created = await runAgent(
    { kind: 'kimi', executable: cli, name: 'Kimi' },
    'first prompt',
    workdir,
    {
      env,
      onSessionRef: (sessionRef, metadata) => createdSessionRefs.push({ sessionRef, metadata }),
      onOutboundPayload: payload => {
        assert.equal(fs.existsSync(promptDeliveryFile), false)
        createdOutboundPayloads.push(payload)
      },
      onEvent: event => createdEvents.push(event),
    },
  )
  assert.equal(created.text, `new|plan|cancelled|first prompt|${workdir}`)
  assert.equal(created.sessionRef, 'kimi-acp-session')
  assert.equal(created.outcome, 'completed')
  assert.deepEqual(createdSessionRefs, [{
    sessionRef: 'kimi-acp-session', metadata: { transport: 'acp' },
  }])
  const deliveredPromptLine = fs.readFileSync(promptDeliveryFile, 'utf8').trim().split('\n')[0]
  assert.equal(deliveredPromptLine, JSON.stringify({
    jsonrpc: '2.0',
    id: 3,
    method: 'session/prompt',
    params: {
      sessionId: 'kimi-acp-session',
      prompt: [{ type: 'text', text: 'first prompt' }],
    },
  }))
  const deliveredPromptFrame = JSON.parse(deliveredPromptLine)
  assert.deepEqual(deliveredPromptFrame.params, {
    sessionId: 'kimi-acp-session',
    prompt: [{ type: 'text', text: 'first prompt' }],
  })
  assert.equal(createdOutboundPayloads.length, 1)
  assert.deepEqual(Object.keys(createdOutboundPayloads[0]).sort(), OUTBOUND_PAYLOAD_KEYS)
  assert.equal(Object.isFrozen(createdOutboundPayloads[0]), true)
  assert.deepEqual(createdOutboundPayloads[0], {
    prompt: 'first prompt',
    transport: 'acp',
    serialization: 'acp-session-prompt-v1',
    promptMode: 'acp',
    ...wireFingerprint(Buffer.from(`${deliveredPromptLine}\n`, 'utf8')),
  })
  assert.equal(JSON.stringify(createdOutboundPayloads).includes('kimi-acp-session'), false)
  assert.equal(createdEvents.some(event => event.type === 'answer_delta'), true)
  assert.equal(
    createdEvents.filter(event => event.type === 'answer_delta').reduce(
      (answer, event) => event.replace === true ? event.delta : answer + event.delta,
      '',
    ),
    'new|plan|cancelled|first prompt|[path]',
  )
  // Thinking surfaces only as a text-free reasoning status event.
  assert.equal(createdEvents.some(event => (
    event.type === 'reasoning_summary' && event.status === 'running' && !event.summary
  )), true)
  const createdToolEvents = createdEvents.filter(event => event.type !== 'reasoning_summary')
  assert.deepEqual(createdToolEvents.slice(0, 2).map(event => ({
    id: event.id,
    type: event.type,
    status: event.status,
    title: event.title,
  })), [
    { id: 'tool-1', type: 'tool_start', status: 'running', title: 'search' },
    { id: 'tool-1', type: 'tool_result_summary', status: 'completed', title: 'search' },
  ])
  assert.equal(createdToolEvents[0].summary, 'search: [operation hidden]')
  assert.match(createdToolEvents[1].detail, /Output: 1 line, 19 bytes/)
  assert.doesNotMatch(
    JSON.stringify(createdEvents),
    /PRIVATE_CHAIN_OF_THOUGHT|command|rg |Users|private tool output|stderr/i,
  )

  const resumedSessionRefs = []
  const resumed = await runAgent(
    { kind: 'kimi', executable: cli, name: 'Kimi' },
    'next prompt',
    workdir,
    {
      sessionRef: created.sessionRef,
      env,
      onSessionRef: (sessionRef, metadata) => resumedSessionRefs.push({ sessionRef, metadata }),
    },
  )
  assert.equal(resumed.text, `resume|plan|cancelled|next prompt|${workdir}`)
  assert.equal(resumed.sessionRef, 'kimi-acp-session')
  assert.equal(resumed.outcome, 'completed')
  assert.deepEqual(resumedSessionRefs, [{
    sessionRef: 'kimi-acp-session', metadata: { transport: 'acp' },
  }])

  await assert.rejects(
    runAgent(
      { kind: 'kimi', executable: cli, name: 'Kimi' },
      'cancelled prompt',
      workdir,
      { sessionRef: created.sessionRef, env },
    ),
    (error) => error.message === 'LOCAL_AGENT_EXECUTION_STOPPED'
      && error.failure.category === 'cancellation',
  )

  const privateSessionRefs = []
  const privateSessionId = 'private-session-reference'
  const privateSession = await runAgent(
    { kind: 'kimi', executable: cli, name: 'Kimi' },
    'private session prompt',
    workdir,
    {
      env: { ...env, MELDWORK_TEST_SECRET: privateSessionId },
      onSessionRef: sessionRef => privateSessionRefs.push(sessionRef),
    },
  )
  assert.equal(privateSession.text, `new|plan|cancelled|private session prompt|${workdir}`)
  assert.equal(privateSession.sessionRef, '')
  assert.deepEqual(privateSessionRefs, [])
  assert.deepEqual(
    fs.readFileSync(lifecycleFile, 'utf8').trim().split('\n'),
    ['stdin-close', 'stdin-close', 'stdin-close', 'stdin-close'],
  )
})

test('ACP outbound callback failure prevents session prompt delivery', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-acp-outbound-blocked-'))
  const deliveryFile = path.join(directory, 'delivered.txt')
  const cli = executable(directory, 'kimi-acp-outbound-blocked.cjs', `
const fs = require('node:fs')
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'blocked-session' } })
  } else if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    fs.writeFileSync(process.env.MELDWORK_TEST_DELIVERY_FILE, 'delivered')
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
  }
})
`)
  const callbackError = new Error('ACP outbound payload capture failed')
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  await assert.rejects(
    runAgent(
      { kind: 'kimi', executable: cli, name: 'Kimi' },
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

test('ACP permission callback uses sanitized requests and fail-closed decisions', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-acp-permission-'))
  const cli = permissionRequestExecutable(directory)
  const secret = 'permission-provider-secret'
  const agent = { kind: 'kimi', executable: cli, name: 'Kimi' }
  const run = onPermissionRequest => runAgent(agent, 'request permission', directory, {
    env: { MELDWORK_TEST_SECRET: secret },
    onPermissionRequest,
  })
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  await t.test('approves a requested option', async () => {
    let received
    const result = await run(async (request, context) => {
      received = request
      assert.equal(context.signal, undefined)
      return { status: 'approved', optionId: 'allow-once' }
    })
    assert.equal(result.text, 'selected|allow-once')
    assert.deepEqual(Object.keys(received).sort(), ['options', 'sessionId', 'toolCall'])
    assert.deepEqual(received.options, [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
    ])
    assert.equal(received.sessionId, 'permission-session')
    assert.equal(received.toolCall.toolCallId, 'tool-1')
    assert.equal(received.toolCall.kind, 'edit')
    assert.equal(received.toolCall.status, 'pending')
    assert.match(received.toolCall.title, /\[path\]/)
    assert.equal(Object.isFrozen(received), true)
    assert.equal(Object.isFrozen(received.toolCall), true)
    assert.equal(Object.isFrozen(received.options), true)
    assert.equal(received.options.every(Object.isFrozen), true)
    assert.doesNotMatch(
      JSON.stringify(received),
      /providerSecret|permission-provider-secret|sk-testpermissionsecret|rawInput|rawOutput|locations|content|_meta|Users/i,
    )
  })

  await t.test('selects an explicit rejection', async () => {
    const result = await run(async () => ({ status: 'rejected', optionId: 'reject-once' }))
    assert.equal(result.text, 'selected|reject-once')
  })

  await t.test('callback errors and forged options fail closed', async () => {
    const missing = await run(undefined)
    assert.equal(missing.text, 'selected|reject-once')

    const forged = await run(async () => ({ status: 'approved', optionId: 'forged-option' }))
    assert.equal(forged.text, 'selected|reject-once')

    const extra = await run(async () => ({
      status: 'approved', optionId: 'allow-once', reason: 'unvalidated',
    }))
    assert.equal(extra.text, 'selected|reject-once')

    const failed = await run(async () => { throw new Error('permission store unavailable') })
    assert.equal(failed.text, 'selected|reject-once')
  })

  await t.test('AbortSignal interrupts a pending decision', async () => {
    const controller = new AbortController()
    let requestedResolve
    const requested = new Promise(resolve => { requestedResolve = resolve })
    const outcome = runAgent(agent, 'wait for permission', directory, {
      signal: controller.signal,
      env: { MELDWORK_TEST_SECRET: secret },
      onPermissionRequest: async (_request, context) => {
        assert.equal(context.signal, controller.signal)
        requestedResolve()
        return new Promise(() => {})
      },
    }).then(value => ({ value }), error => ({ error }))
    await requested
    controller.abort()
    const result = await within(outcome)
    assert.equal(result.error?.message, 'LOCAL_AGENT_EXECUTION_STOPPED')
  })
})

test('ACP rejects a terminal prompt response while its permission handler is pending', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-acp-permission-race-'))
  const terminalFile = path.join(directory, 'terminal-sent.txt')
  const cli = executable(directory, 'kimi-acp-permission-race.cjs', `
const fs = require('node:fs')
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'permission-race-session' } })
  } else if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    send({
      jsonrpc: '2.0', id: 77, method: 'session/request_permission',
      params: {
        sessionId: 'permission-race-session',
        toolCall: { toolCallId: 'tool-1', title: 'read file', kind: 'read', status: 'pending' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
        ],
      },
    })
    send({
      jsonrpc: '2.0', method: 'session/update',
      params: {
        sessionId: 'permission-race-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'must not be accepted' },
        },
      },
    })
    setImmediate(() => {
      send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
      fs.writeFileSync(process.env.MELDWORK_TEST_TERMINAL_FILE, 'sent')
    })
  }
})
`)
  let releaseDecision
  let signalRequested
  const requested = new Promise(resolve => { signalRequested = resolve })
  const decision = new Promise(resolve => { releaseDecision = resolve })
  let settled = false
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const outcome = runAgent(
    { kind: 'kimi', executable: cli, name: 'Kimi' },
    'race terminal against permission',
    directory,
    {
      env: { MELDWORK_TEST_TERMINAL_FILE: terminalFile },
      onPermissionRequest: async () => {
        signalRequested()
        return decision
      },
    },
  ).then(value => ({ value }), error => ({ error })).finally(() => { settled = true })

  await requested
  await readWhenReady(terminalFile)
  try {
    assert.equal(settled, false)
  } finally {
    releaseDecision({ status: 'approved', optionId: 'allow-once' })
  }
  const result = await within(outcome)
  assert.equal(result.error?.message, 'LOCAL_AGENT_PERMISSION_TERMINAL_RACE')
})

test('ACP rejects a duplicate active permission request id before accepting terminal output', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-acp-permission-duplicate-'))
  const callbackFile = path.join(directory, 'permission-callback-started.txt')
  const terminalFile = path.join(directory, 'terminal-sent.txt')
  const cli = executable(directory, 'kimi-acp-permission-duplicate.cjs', `
const fs = require('node:fs')
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
const permission = title => ({
  jsonrpc: '2.0', id: 77, method: 'session/request_permission',
  params: {
    sessionId: 'permission-duplicate-session',
    toolCall: { toolCallId: 'tool-1', title, kind: 'read', status: 'pending' },
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
    ],
  },
})
input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'permission-duplicate-session' } })
  } else if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    send(permission('first request'))
    const waitForCallback = setInterval(() => {
      if (!fs.existsSync(process.env.MELDWORK_TEST_CALLBACK_FILE)) return
      clearInterval(waitForCallback)
      send(permission('duplicate request'))
      send({
        jsonrpc: '2.0', method: 'session/update',
        params: {
          sessionId: 'permission-duplicate-session',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'duplicate terminal must not be accepted' },
          },
        },
      })
      send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
      fs.writeFileSync(process.env.MELDWORK_TEST_TERMINAL_FILE, 'sent')
    }, 5)
  }
})
`)
  let releaseDecision
  let signalRequested
  let callbackCalls = 0
  const requested = new Promise(resolve => { signalRequested = resolve })
  const decision = new Promise(resolve => { releaseDecision = resolve })
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const outcome = runAgent(
    { kind: 'kimi', executable: cli, name: 'Kimi' },
    'reject duplicate permission ids',
    directory,
    {
      env: {
        MELDWORK_TEST_CALLBACK_FILE: callbackFile,
        MELDWORK_TEST_TERMINAL_FILE: terminalFile,
      },
      onPermissionRequest: async () => {
        callbackCalls += 1
        fs.writeFileSync(callbackFile, 'started')
        signalRequested()
        return decision
      },
    },
  ).then(value => ({ value }), error => ({ error }))

  await requested
  await readWhenReady(terminalFile)
  releaseDecision({ status: 'approved', optionId: 'allow-once' })
  const result = await within(outcome)
  assert.equal(callbackCalls, 1)
  assert.equal(result.error?.message, 'LOCAL_AGENT_PROCESS_FAILED')
})

test('Kimi ACP preserves new sessions across failures and keeps diagnostics private', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-kimi-acp-session-ref-'))
  const promptFailureCli = executable(directory, 'kimi-acp-prompt-failure.cjs', `
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'kimi-prompt-failure-session' } })
  } else if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    send({
      jsonrpc: '2.0', id: message.id,
      error: {
        code: -32000,
        message: 'prompt failed in /private/meldwork-agent with ' + process.env.MELDWORK_TEST_SECRET,
      },
    })
  }
})
`)
  const processExitCli = executable(directory, 'kimi-acp-process-exit.cjs', `
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'kimi-process-exit-session' } })
  } else if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    process.stderr.write('process exited after creating the session')
    process.exit(7)
  }
})
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const promptFailureSessionRefs = []
  const secret = 'private-provider-secret'
  await assert.rejects(
    runAgent(
      { kind: 'kimi', executable: promptFailureCli, name: 'Kimi' },
      'fail prompt',
      directory,
      {
        env: { MELDWORK_TEST_SECRET: secret },
        onSessionRef: sessionRef => promptFailureSessionRefs.push(sessionRef),
      },
    ),
    (error) => {
      assert.equal(error.message, 'LOCAL_AGENT_PROCESS_FAILED')
      assert.match(error.diagnostic, /prompt failed in \/private\/meldwork-agent with \[redacted\]/)
      assert.equal(error.diagnostic.includes(secret), false)
      assert.equal(Object.prototype.propertyIsEnumerable.call(error, 'diagnostic'), false)
      assert.doesNotMatch(error.message, /private|redacted|secret/i)
      return true
    },
  )
  assert.deepEqual(promptFailureSessionRefs, ['kimi-prompt-failure-session'])

  const processExitSessionRefs = []
  await assert.rejects(
    runAgent(
      { kind: 'kimi', executable: processExitCli, name: 'Kimi' },
      'exit during prompt',
      directory,
      { onSessionRef: sessionRef => processExitSessionRefs.push(sessionRef) },
    ),
    (error) => {
      assert.equal(error.message, 'LOCAL_AGENT_PROCESS_FAILED')
      assert.equal(Object.prototype.propertyIsEnumerable.call(error, 'diagnostic'), false)
      return true
    },
  )
  assert.deepEqual(processExitSessionRefs, ['kimi-process-exit-session'])
})

test('Kimi ACP classifies an explicitly missing resumed session', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-kimi-acp-missing-session-'))
  const cli = executable(directory, 'kimi-acp-missing-session.cjs', `
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/resume') {
    send({
      jsonrpc: '2.0', id: message.id,
      error: { code: -32001, message: 'Session was not found or has expired.' },
    })
  }
})
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  await assert.rejects(
    runAgent(
      { kind: 'kimi', executable: cli, name: 'Kimi' },
      'resume safely',
      directory,
      { sessionRef: 'kimi-stale-session' },
    ),
    (error) => {
      assert.equal(error.message, 'LOCAL_AGENT_SESSION_INVALID')
      assert.match(error.diagnostic, /Session was not found or has expired/)
      assert.equal(Object.prototype.propertyIsEnumerable.call(error, 'diagnostic'), false)
      return true
    },
  )
})

test('Kimi ACP rejects unsafe protocol input without logging secret-bearing messages', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-kimi-acp-invalid-'))
  const secret = 'private-kimi-transport-secret'
  const cli = executable(directory, 'kimi-acp-invalid.cjs', `
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'kimi-invalid-session' } })
  } else if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    if (process.env.MELDWORK_TEST_CASE === 'malformed') {
      process.stdout.write('{"secret":"' + process.env.MELDWORK_TEST_SECRET + '"\\n')
    } else {
      send({
        jsonrpc: '2.0', method: 'unsupported/client_method',
        params: { secret: process.env.MELDWORK_TEST_SECRET },
      })
    }
  }
})
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const logged = []
  const originalConsoleError = console.error
  console.error = (...args) => logged.push(args.map(String).join(' '))
  t.after(() => { console.error = originalConsoleError })

  for (const testCase of ['malformed', 'unsupported']) {
    await assert.rejects(
      runAgent(
        { kind: 'kimi', executable: cli, name: 'Kimi' },
        'validate transport',
        directory,
        { env: { MELDWORK_TEST_CASE: testCase, MELDWORK_TEST_SECRET: secret } },
      ),
      (error) => {
        assert.equal(error.message, 'LOCAL_AGENT_PROCESS_FAILED')
        assert.equal(error.diagnostic.includes(secret), false)
        assert.equal(Object.prototype.propertyIsEnumerable.call(error, 'diagnostic'), false)
        return true
      },
    )
  }

  assert.deepEqual(logged, [])
})

test('Kimi ACP bounds unframed input, cumulative reply text, and total protocol traffic', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-kimi-acp-limits-'))
  const cli = executable(directory, 'kimi-acp-limits.cjs', `
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'kimi-limit-session' } })
  } else if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    const testCase = process.env.MELDWORK_TEST_CASE
    if (testCase === 'line') {
      process.stdout.write('x'.repeat(1024 * 1024 + 1))
      return
    }
    const update = testCase === 'reply' ? 'agent_message_chunk' : 'agent_thought_chunk'
    const size = testCase === 'reply' ? 512 * 1024 : 960 * 1024
    const count = testCase === 'reply' ? 21 : 18
    const text = 'x'.repeat(size)
    for (let index = 0; index < count; index += 1) {
      send({
        jsonrpc: '2.0', method: 'session/update',
        params: {
          sessionId: 'kimi-limit-session',
          update: { sessionUpdate: update, content: { type: 'text', text } },
        },
      })
    }
  }
})
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  for (const [testCase, diagnostic] of [
    ['line', /line limit/],
    ['reply', /output limit/],
    ['total', /total limit/],
  ]) {
    await assert.rejects(
      runAgent(
        { kind: 'kimi', executable: cli, name: 'Kimi' },
        'validate bounds',
        directory,
        { env: { MELDWORK_TEST_CASE: testCase } },
      ),
      (error) => {
        assert.equal(error.message, 'LOCAL_AGENT_PROCESS_FAILED')
        assert.match(error.diagnostic, diagnostic)
        return true
      },
    )
  }
})

test('Kimi ACP cancellation notifies the session and terminates the child process', {
  skip: process.platform === 'win32',
}, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-kimi-acp-abort-'))
  const readyFile = path.join(directory, 'ready')
  const cancelFile = path.join(directory, 'cancel.json')
  const lifecycleFile = path.join(directory, 'lifecycle.log')
  const cli = executable(directory, 'kimi-acp-abort.cjs', `
const fs = require('node:fs')
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
const record = value => fs.appendFileSync(process.env.MELDWORK_TEST_LIFECYCLE_FILE, value + '\\n')
process.on('SIGTERM', () => record('sigterm'))
input.on('close', () => record('stdin-close'))
input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'kimi-cancel-session' } })
  } else if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    fs.writeFileSync(process.env.MELDWORK_TEST_READY_FILE, String(process.pid))
  } else if (message.method === 'session/cancel') {
    record('cancel')
    fs.writeFileSync(process.env.MELDWORK_TEST_CANCEL_FILE, JSON.stringify(message.params))
  }
})
setInterval(() => {}, 1000)
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const controller = new AbortController()
  const outcome = runAgent(
    { kind: 'kimi', executable: cli, name: 'Kimi' },
    'keep discussing',
    directory,
    {
      signal: controller.signal,
      env: {
        MELDWORK_TEST_READY_FILE: readyFile,
        MELDWORK_TEST_CANCEL_FILE: cancelFile,
        MELDWORK_TEST_LIFECYCLE_FILE: lifecycleFile,
      },
    },
  ).then(value => ({ value }), error => ({ error }))
  const pid = Number(await readWhenReady(readyFile))

  controller.abort()

  const result = await within(outcome)
  assert.equal(result.error?.message, 'LOCAL_AGENT_EXECUTION_STOPPED')
  assert.deepEqual(await readJsonWhenReady(cancelFile), { sessionId: 'kimi-cancel-session' })
  await waitForExit(pid)
  assert.deepEqual(
    fs.readFileSync(lifecycleFile, 'utf8').trim().split('\n'),
    ['cancel', 'stdin-close', 'sigterm'],
  )
})

test('Claude uses partial stream JSON and resumes its native session', () => {
  const spec = invocation('claude', '/tmp/claude', '/tmp/work', 'claude-session')
  assert.deepEqual(spec.args, [
    '--print', '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
    '--permission-mode', 'plan',
    '--resume', 'claude-session',
  ])
  assert.equal(spec.promptArg, true)
})

test('Claude keeps its native credentials without a settings override', () => {
  const spec = invocation('claude', '/tmp/claude', '/tmp/work', 'native-session', {
    sandbox: 'read-only',
  })
  assert.equal(spec.args.includes('--settings'), false)
  assert.equal(spec.args.includes('--model'), false)
  assert.equal(spec.args[spec.args.indexOf('--resume') + 1], 'native-session')
  assert.equal(spec.args[spec.args.indexOf('--permission-mode') + 1], 'plan')
})

test('MiMo uses ACP by default and declares its JSON setup fallback', () => {
  const spec = invocation('mimo', '/tmp/mimo', '/tmp/work', 'mimo-session', {
    sandbox: 'workspace-write',
  })
  assert.deepEqual(spec.args, ['acp', '--pure', '--cwd', '/tmp/work'])
  assert.equal(spec.acpMode, 'build')
  assert.equal(spec.eventTransport, 'acp')
  assert.equal(spec.fallbackTransport, 'json')
  assert.equal(spec.promptArg, undefined)
})

test('MiMo JSON output returns final text and session id', () => {
  const raw = [
    JSON.stringify({
      type: 'text', sessionID: 'mimo-session',
      part: { type: 'text', text: 'MiMo reply' },
    }),
    JSON.stringify({
      type: 'step_finish', sessionID: 'mimo-session',
      part: { type: 'step-finish', reason: 'stop' },
    }),
  ].join('\n')
  assert.deepEqual(parseMimoOutput(raw), {
    text: 'MiMo reply', sessionRef: 'mimo-session', error: '',
  })
  assert.deepEqual(profileOutput('mimo', raw), {
    text: 'MiMo reply', sessionRef: 'mimo-session', error: '', outcome: 'completed',
  })
})

test('Pi uses the current non-interactive JSON mode and resumes by session id', () => {
  const readOnly = invocation('pi', '/tmp/pi', '/tmp/work', 'pi-session', {
    provider: { id: 'zgci', model: 'glm' },
  })
  assert.deepEqual(readOnly.args, [
    '--mode', 'json', '--print', '--no-approve', '--tools', 'read,grep,find,ls', '--session', 'pi-session',
  ])
  assert.equal(readOnly.promptArg, true)
  assert.equal(readOnly.eventTransport, 'json')

  const writable = invocation('pi', '/tmp/pi', '/tmp/work', '', {
    sandbox: 'workspace-write',
  })
  assert.deepEqual(writable.args, ['--mode', 'json', '--print', '--approve'])
})

test('Pi JSON output returns final text and session id from current CLI events', () => {
  const raw = [
    JSON.stringify({
      type: 'session',
      id: '01a03794-ae3f-72ea-9efd-cd2cd16d88a1',
      cwd: '/tmp/work',
    }),
    JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Pi ' },
    }),
    JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'reply' },
    }),
    JSON.stringify({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Pi reply' }],
        stopReason: 'stop',
      },
    }),
    JSON.stringify({
      type: 'turn_end',
      message: { role: 'assistant', stopReason: 'stop' },
    }),
    JSON.stringify({ type: 'agent_settled' }),
  ].join('\n')
  assert.deepEqual(parsePiOutput(raw), {
    text: 'Pi reply',
    sessionRef: '01a03794-ae3f-72ea-9efd-cd2cd16d88a1',
  })
  assert.deepEqual(profileOutput('pi', raw), {
    text: 'Pi reply',
    sessionRef: '01a03794-ae3f-72ea-9efd-cd2cd16d88a1',
    outcome: 'completed',
  })
})

test('Pi ignores user/tool echoes and tool ids while preserving the assistant answer and native session', () => {
  const raw = [
    { type: 'session', id: 'pi-persistent-session' },
    { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'Private input' }] } },
    { type: 'tool_execution_end', id: 'unrelated-tool-id' },
    { type: 'message_end', message: { role: 'toolResult', content: [{ type: 'text', text: 'Tool noise' }] } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Actual answer' } },
    { type: 'turn_end', message: { role: 'assistant', stopReason: 'stop' } },
    { type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'stop' }] },
    { type: 'agent_settled' },
  ].map(event => JSON.stringify(event)).join('\n')
  assert.deepEqual(parsePiOutput(raw), { text: 'Actual answer', sessionRef: 'pi-persistent-session' })
  assert.deepEqual(profileOutput('pi', raw), {
    text: 'Actual answer', sessionRef: 'pi-persistent-session', outcome: 'completed',
  })
})

test('Pi agent_end preserves failed, cancelled and incomplete assistant outcomes', () => {
  for (const [stopReason, outcome] of [['error', 'failed'], ['aborted', 'cancelled'], ['length', 'partial']]) {
    const raw = [
      { type: 'session', id: 'pi-terminal-session' },
      { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'Do not echo me' }] } },
      { type: 'turn_end', message: { role: 'assistant', stopReason } },
      { type: 'agent_end', messages: [{ role: 'assistant', stopReason }] },
      { type: 'agent_settled' },
    ].map(event => JSON.stringify(event)).join('\n')
    const result = profileOutput('pi', raw)
    assert.equal(result.outcome, outcome, stopReason)
    assert.equal(result.text, '', stopReason)
    assert.equal(parsePiOutput(raw).text, '', stopReason)
  }
})

test('Pi clears a recoverable attempt failure after its internal retry completes', () => {
  const raw = [
    { type: 'session', id: 'pi-retry-session' },
    { type: 'turn_end', message: { role: 'assistant', stopReason: 'error' } },
    { type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'error' }], willRetry: true },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Recovered answer' } },
    { type: 'turn_end', message: { role: 'assistant', stopReason: 'stop' } },
    { type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'stop' }], willRetry: false },
    { type: 'agent_settled' },
  ].map(event => JSON.stringify(event)).join('\n')
  assert.deepEqual(profileOutput('pi', raw), {
    text: 'Recovered answer', sessionRef: 'pi-retry-session', outcome: 'completed',
  })
})

test('Claude and Qwen stream JSON output returns the final reply and session id', () => {
  for (const kind of ['claude', 'qwen']) {
    const raw = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: `${kind}-session` }),
      JSON.stringify({
        type: 'stream_event', session_id: `${kind}-session`, parent_tool_use_id: null,
        event: {
          type: 'content_block_delta', index: 0,
          delta: { type: 'text_delta', text: `${kind} partial` },
        },
      }),
      JSON.stringify({
        type: 'assistant', session_id: `${kind}-session`, parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: `${kind} assistant` }] },
      }),
      JSON.stringify({
        type: 'result', result: `${kind} final`, session_id: `${kind}-session`,
      }),
    ].join('\n')
    assert.deepEqual(profileOutput(kind, raw), {
      text: `${kind} final`,
      sessionRef: `${kind}-session`,
      outcome: 'completed',
    })
  }
})

test('Qwen uses plan mode by default and auto-edit after authorization', () => {
  const chat = invocation('qwen', '/tmp/qwen', '/tmp/work', 'qwen-session')
  assert.deepEqual(chat.args, [
    '--output-format', 'stream-json', '--include-partial-messages',
    '--approval-mode', 'plan', '--resume', 'qwen-session',
  ])

  const configure = invocation('qwen', '/tmp/qwen', '/tmp/work', '', {
    sandbox: 'workspace-write',
  })
  assert.deepEqual(configure.args, [
    '--output-format', 'stream-json', '--include-partial-messages',
    '--approval-mode', 'auto-edit',
  ])
})

test('Qwen keeps its native auth without a provider override', () => {
  const spec = invocation('qwen', '/tmp/qwen', '/tmp/work', '', {
    sandbox: 'read-only',
  })
  assert.deepEqual(spec.args, [
    '--output-format', 'stream-json', '--include-partial-messages',
    '--approval-mode', 'plan',
  ])
})

test('Claude and Qwen stream answers and safe tool lifecycle events without final duplication', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-claude-qwen-events-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  for (const kind of ['claude', 'qwen']) {
    const cli = executable(directory, `${kind}-events.cjs`, `
const sessionId = '${kind}-stream-session'
const events = [
  {
    type: 'system', subtype: 'init', session_id: sessionId,
    cwd: '/Users/private/workspace', executable_path: '/private/bin/${kind}',
    env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY },
  },
  {
    type: 'stream_event', uuid: 'reasoning-start', session_id: sessionId,
    parent_tool_use_id: null,
    event: {
      type: 'content_block_start', message_id: 'message-reasoning', index: 0,
      content_block: { type: 'thinking', thinking: '' },
    },
  },
  {
    type: 'stream_event', uuid: 'reasoning-delta', session_id: sessionId,
    parent_tool_use_id: null,
    event: {
      type: 'content_block_delta', message_id: 'message-reasoning', index: 0,
      delta: {
        type: 'thinking_delta',
        thinking: 'hidden reasoning with command=cat /Users/private/workspace/secret.txt',
      },
    },
  },
  {
    type: 'stream_event', uuid: 'reasoning-stop', session_id: sessionId,
    parent_tool_use_id: null,
    event: { type: 'content_block_stop', message_id: 'message-reasoning', index: 0 },
  },
  {
    type: 'assistant', uuid: 'message-reasoning', session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      id: 'message-reasoning',
      content: [{
        type: 'thinking',
        thinking: 'hidden final thought with OPENAI_API_KEY=' + process.env.OPENAI_API_KEY,
      }],
    },
  },
  {
    type: 'stream_event', uuid: 'tool-start', session_id: sessionId,
    parent_tool_use_id: null,
    event: {
      type: 'content_block_start', message_id: 'message-tool', index: 0,
      content_block: {
        type: 'tool_use', id: 'tool-1', name: 'Bash',
        input: {},
      },
    },
  },
  {
    type: 'assistant', uuid: 'message-tool', session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      id: 'message-tool',
      content: [{
        type: 'tool_use', id: 'tool-1', name: 'Bash',
        input: {
          command: 'ls /Users/private/workspace | head -5',
          cwd: '/Users/private/workspace',
          env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY },
        },
      }],
    },
  },
  {
    type: 'user', uuid: 'tool-result', session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      content: [{
        type: 'tool_result', tool_use_id: 'tool-1', is_error: false,
        content: 'raw tool output /Users/private/workspace ' + process.env.OPENAI_API_KEY,
      }],
    },
  },
  {
    type: 'plan', id: 'plan-1', status: 'running',
    summary: 'Inspect evidence\\ncommand=rg /Users/private/workspace\\nOPENAI_API_KEY=' + process.env.OPENAI_API_KEY,
  },
  {
    type: 'reasoning_summary', id: 'reasoning-summary-1', status: 'completed',
    summary: 'Compared the available evidence.',
  },
  {
    type: 'stream_event', uuid: 'subagent-text', session_id: sessionId,
    parent_tool_use_id: 'tool-task',
    event: {
      type: 'content_block_delta', message_id: 'subagent-message', index: 0,
      delta: { type: 'text_delta', text: 'private subagent answer' },
    },
  },
  {
    type: 'stream_event', uuid: 'answer-one', session_id: sessionId,
    parent_tool_use_id: null,
    event: {
      type: 'content_block_delta', message_id: 'message-answer', index: 0,
      delta: { type: 'text_delta', text: 'first ' },
    },
  },
  {
    type: 'stream_event', uuid: 'answer-two', session_id: sessionId,
    parent_tool_use_id: null,
    event: {
      type: 'content_block_delta', message_id: 'message-answer', index: 0,
      delta: { type: 'text_delta', text: 'second' },
    },
  },
  {
    type: 'assistant', uuid: 'message-answer', session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      id: 'message-answer',
      content: [{ type: 'text', text: 'first second' }],
    },
  },
  {
    type: 'result', subtype: 'success', is_error: false,
    result: 'first second', session_id: sessionId,
  },
]
let index = 0
const send = () => {
  process.stdout.write(JSON.stringify(events[index++]) + '\\n')
  if (index < events.length) return setTimeout(send, 10)
  setTimeout(() => process.exit(0), 20)
}
send()
`)
    const secret = `${kind}-provider-secret`
    const events = []
    let firstDeltaResolve
    const firstDelta = new Promise(resolve => { firstDeltaResolve = resolve })
    let resultResolved = false
    const resultPromise = runAgent(
      { kind, executable: cli, name: kind },
      'hello',
      directory,
      {
        env: { OPENAI_API_KEY: secret },
        onEvent: (event) => {
          events.push(event)
          if (event.type === 'answer_delta') firstDeltaResolve()
        },
      },
    ).then((result) => {
      resultResolved = true
      return result
    })

    await within(firstDelta)
    assert.equal(resultResolved, false, kind)
    const result = await resultPromise
    assert.deepEqual(result, {
      text: 'first second',
      sessionRef: `${kind}-stream-session`,
      outcome: 'completed',
    })
    assert.equal(
      events.filter(event => event.type === 'answer_delta').reduce(
        (answer, event) => event.replace === true ? event.delta : answer + event.delta,
        '',
      ),
      'first second',
      kind,
    )
    assert.equal(events.filter(event => event.type === 'tool_start').length, 1, kind)
    assert.equal(events.filter(event => event.type === 'tool_update').length, 1, kind)
    assert.equal(events.filter(event => event.type === 'tool_result_summary').length, 1, kind)
    assert.equal(events.filter(event => event.type === 'plan').length, 1, kind)
    const reasoningEvents = events.filter(event => event.type === 'reasoning_summary')
    assert.deepEqual(reasoningEvents.slice(0, 2).map(event => event.status), [
      'running', 'completed',
    ], kind)
    assert.equal(reasoningEvents[0].summary, undefined, kind)
    assert.equal(reasoningEvents.at(-1).summary, 'Compared the available evidence.', kind)
    assert.equal(events.find(event => event.type === 'tool_start')?.title, 'Bash', kind)
    assert.equal(
      events.find(event => event.type === 'tool_update')?.summary
        .includes('operation: command'),
      true,
      kind,
    )
    assert.equal(
      events.find(event => event.type === 'tool_result_summary')?.summary
        .includes('operation: command'),
      true,
      kind,
    )
    assert.match(
      events.find(event => event.type === 'tool_result_summary')?.detail || '',
      /^Output: 1 line, \d+ bytes$/,
      kind,
    )
    assert.doesNotMatch(
      JSON.stringify(events),
      /hidden reasoning|hidden final thought|private subagent answer|raw tool output|duplicate command|Users|private\/workspace|OPENAI_API_KEY|provider-secret|executable_path|\bls\b|head -5/i,
      kind,
    )
  }
})

test('Gemini uses stream JSON with explicit approval modes and resumes its native session', () => {
  const chat = invocation('gemini', '/tmp/gemini', '/tmp/work', 'gemini-session')
  assert.deepEqual(chat.args, [
    '--output-format', 'stream-json', '--approval-mode', 'plan',
    '--resume', 'gemini-session', '--prompt',
  ])
  assert.equal(chat.promptArg, true)

  const configure = invocation('gemini', '/tmp/gemini', '/tmp/work', '', {
    sandbox: 'workspace-write',
  })
  assert.deepEqual(configure.args, [
    '--output-format', 'stream-json', '--approval-mode', 'auto_edit', '--prompt',
  ])
})

test('Gemini stream JSON output returns assistant chunks and the native session id', () => {
  const raw = [
    JSON.stringify({ type: 'init', session_id: 'gemini-session', model: 'gemini-2.5-pro' }),
    JSON.stringify({ type: 'message', role: 'user', content: 'hello' }),
    JSON.stringify({ type: 'message', role: 'assistant', content: '第一段', delta: true }),
    JSON.stringify({ type: 'message', role: 'assistant', content: '第二段', delta: true }),
    JSON.stringify({ type: 'result', status: 'success' }),
  ].join('\n')
  assert.deepEqual(parseGeminiOutput(raw), {
    text: '第一段第二段',
    sessionRef: 'gemini-session',
  })
})

test('runAgent streams Gemini answer deltas without duplicating the final reply', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-gemini-events-'))
  const cli = executable(directory, 'gemini-events.cjs', `
const events = [
  { type: 'init', session_id: 'gemini-event-session' },
  { type: 'message', role: 'assistant', content: 'first ' },
  { type: 'message', role: 'assistant', content: 'second' },
]
let index = 0
const send = () => {
  process.stdout.write(JSON.stringify(events[index++]) + '\\n')
  if (index < events.length) return setTimeout(send, 20)
  setTimeout(() => process.exit(0), 30)
}
send()
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const events = []
  let firstDeltaResolve
  const firstDelta = new Promise(resolve => { firstDeltaResolve = resolve })
  let resultResolved = false
  const resultPromise = runAgent(
    { kind: 'gemini', executable: cli, name: 'Gemini' },
    'hello',
    directory,
    {
      onEvent: event => {
        events.push(event)
        if (event.type === 'answer_delta') firstDeltaResolve()
      },
    },
  ).then((result) => {
    resultResolved = true
    return result
  })

  await within(firstDelta)
  assert.equal(resultResolved, false)
  const result = await resultPromise
  const deltas = events.filter(event => event.type === 'answer_delta')
  assert.equal(result.text, 'first second')
  assert.equal(result.sessionRef, 'gemini-event-session')
  assert.equal(deltas.reduce(
    (answer, event) => event.replace === true ? event.delta : answer + event.delta,
    '',
  ), result.text)
})

test('OpenCode uses ACP without attachments and keeps JSON for attachment runs', () => {
  const chat = invocation('opencode', '/tmp/opencode', '/tmp/work', 'opencode-session')
  assert.deepEqual(chat.args, ['acp', '--pure', '--cwd', '/tmp/work'])
  assert.equal(chat.acpMode, 'plan')
  assert.equal(chat.eventTransport, 'acp')
  assert.equal(chat.fallbackTransport, 'json')
  assert.equal(chat.promptArg, undefined)

  const configure = invocation('opencode', '/tmp/opencode', '/tmp/work', '', {
    sandbox: 'workspace-write',
  })
  assert.deepEqual(configure.args, ['acp', '--pure', '--cwd', '/tmp/work'])
  assert.equal(configure.acpMode, 'build')

  const first = path.resolve('diagram-one.png')
  const second = path.resolve('diagram-two.jpg')
  const withImages = invocation('opencode', '/tmp/opencode', '/tmp/work', 'opencode-session', {
    attachments: [first, second],
  })
  assert.deepEqual(withImages.args, [
    'run', '--format', 'json', '--agent', 'plan', '--session', 'opencode-session',
    '--file', first, '--file', second,
  ])
  assert.equal(withImages.acpMode, undefined)
  assert.equal(withImages.eventTransport, undefined)
})

test('OpenCodeReview requests a synchronous JSON review with the user message as background', () => {
  const spec = invocation('opencodereview', '/tmp/ocr', '/tmp/work')
  assert.deepEqual(spec.args, [
    'review', '--audience', 'agent', '--format', 'json', '--repo', '/tmp/work',
    '--background',
  ])
  assert.equal(spec.promptArg, true)
})

test('OpenCodeReview maps current and legacy JSON terminal states without exposing thinking', () => {
  const current = parseOpenCodeReviewOutput(JSON.stringify({
    status: 'complete',
    message: 'Review complete.',
    project_summary: 'The change is scoped.',
    session_id: 'ocr-run-1',
    thinking: 'private chain of thought',
    comments: [{
      path: 'src/app.js', start_line: 4, end_line: 5,
      category: 'correctness', severity: 'high', content: 'Handle the missing branch.',
      thinking: 'private finding reasoning',
    }],
    manifest: {
      schema_version: 'ocr.run-manifest/v1',
      operation: 'review',
      terminal_state: 'complete',
    },
  }))
  assert.deepEqual(current, {
    text: [
      'Review complete.',
      'The change is scoped.',
      'src/app.js:4-5 [correctness / high]\nHandle the missing branch.',
    ].join('\n\n'),
    sessionRef: '',
    outcome: 'completed',
    externalRunRef: 'ocr-run-1',
  })
  assert.doesNotMatch(JSON.stringify(current), /private chain|private finding/)

  const legacyCases = new Map([
    ['success', 'completed'],
    ['completed_with_warnings', 'completed'],
    ['completed_with_errors', 'partial'],
    ['budget_exceeded', 'partial'],
    ['skipped', 'completed'],
  ])
  for (const [status, outcome] of legacyCases) {
    assert.equal(parseOpenCodeReviewOutput(JSON.stringify({
      status, message: `OCR ${status}`, comments: [],
    })).outcome, outcome, status)
  }
})

test('OpenCodeReview fails closed for failed, non-terminal, and unknown JSON states', () => {
  const failed = parseOpenCodeReviewOutput(JSON.stringify({
    status: 'failed', message: 'Review failed.', comments: [],
    manifest: {
      schema_version: 'ocr.run-manifest/v1',
      operation: 'review',
      terminal_state: 'failed',
    },
  }))
  assert.equal(failed.outcome, 'failed')
  assert.equal(failed.failure.code, 'LOCAL_AGENT_PROCESS_FAILED')

  for (const output of [
    { status: 'accepted', job_id: 'not-a-real-ocr-job' },
    { status: 'running' },
    { status: 'complete', manifest: {
      schema_version: 'ocr.run-manifest/v2', operation: 'review', terminal_state: 'complete',
    } },
    { status: 'complete', manifest: {
      schema_version: 'ocr.run-manifest/v1', operation: 'scan', terminal_state: 'complete',
    } },
  ]) {
    const parsed = parseOpenCodeReviewOutput(JSON.stringify(output))
    assert.equal(parsed.outcome, 'failed')
    assert.equal(parsed.failure.code, 'LOCAL_AGENT_OUTCOME_INVALID')
  }
})

test('OpenCodeReview resolves only after a verified foreground terminal result', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-ocr-terminal-'))
  const marker = path.join(directory, 'stdout-ready')
  const cli = executable(directory, 'ocr-terminal.cjs', `
const fs = require('node:fs')
process.stdout.write(JSON.stringify({
  status: 'success', message: 'Verified review result', comments: [], session_id: 'ocr-run-2',
}))
fs.writeFileSync(process.env.MELDWORK_TEST_MARKER, 'ready')
setTimeout(() => process.exit(0), 80)
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  let resolved = false
  const resultPromise = runAgent(
    { kind: 'opencodereview', executable: cli, name: 'OpenCodeReview' },
    'Review the current diff',
    directory,
    { env: { MELDWORK_TEST_MARKER: marker } },
  ).then((result) => {
    resolved = true
    return result
  })

  await readWhenReady(marker)
  assert.equal(resolved, false)
  const result = await resultPromise
  assert.deepEqual(result, {
    text: 'Verified review result',
    sessionRef: '',
    outcome: 'completed',
    externalRunRef: 'ocr-run-2',
  })
})

test('OpenCodeReview rejects an exit-zero acknowledgement without a terminal review', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-ocr-accepted-'))
  const cli = executable(directory, 'ocr-accepted.cjs', `
process.stdout.write(JSON.stringify({ status: 'accepted', job_id: 'not-terminal' }))
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  await assert.rejects(
    runAgent(
      { kind: 'opencodereview', executable: cli, name: 'OpenCodeReview' },
      'Review the current diff',
      directory,
    ),
    (error) => error.message === 'LOCAL_AGENT_OUTCOME_INVALID'
      && error.failure.category === 'protocol',
  )
})

test('every supported built-in Agent produces an explicit completion outcome', () => {
  const outputs = {
    codex: [
      JSON.stringify({ type: 'thread.started', thread_id: 'codex-session' }),
      JSON.stringify({
        type: 'item.completed', item: { type: 'agent_message', text: 'Codex reply' },
      }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n'),
    hermes: 'Hermes reply',
    openclaw: JSON.stringify({
      payloads: [{ text: 'OpenClaw reply' }],
      meta: { aborted: false, completion: { stopReason: 'stop' } },
    }),
    workbuddy: JSON.stringify({
      type: 'result', result: 'WorkBuddy reply', session_id: 'workbuddy-session',
    }),
    kimi: [
      JSON.stringify({ role: 'assistant', content: 'Kimi reply' }),
      JSON.stringify({ type: 'session.resume_hint', session_id: 'kimi-session' }),
    ].join('\n'),
    mimo: [
      JSON.stringify({
        type: 'text', sessionID: 'mimo-session', part: { type: 'text', text: 'MiMo reply' },
      }),
      JSON.stringify({
        type: 'step_finish', sessionID: 'mimo-session',
        part: { type: 'step-finish', reason: 'stop' },
      }),
    ].join('\n'),
    pi: [
      JSON.stringify({ type: 'session', version: 3, id: 'pi-session' }),
      JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'Pi Agent reply' },
      }),
      JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant', content: [{ type: 'text', text: 'Pi Agent reply' }],
          stopReason: 'stop', rawStopReason: 'stop',
        },
      }),
      JSON.stringify({ type: 'turn_end', stopReason: 'stop' }),
    ].join('\n'),
    claude: JSON.stringify({
      type: 'result', result: 'Claude reply', session_id: 'claude-session',
    }),
    gemini: [
      JSON.stringify({ type: 'init', session_id: 'gemini-session' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'Gemini reply' }),
      JSON.stringify({ type: 'result', status: 'success' }),
    ].join('\n'),
    opencode: [
      JSON.stringify({
        type: 'text', sessionID: 'opencode-session',
        part: { type: 'text', text: 'OpenCode reply' },
      }),
      JSON.stringify({
        type: 'step_finish', sessionID: 'opencode-session',
        part: { type: 'step-finish', reason: 'stop' },
      }),
    ].join('\n'),
    qwen: JSON.stringify({
      type: 'result', result: 'Qwen reply', session_id: 'qwen-session',
    }),
    opencodereview: JSON.stringify({
      status: 'success', message: 'OpenCodeReview reply', comments: [],
    }),
  }

  assert.deepEqual(Object.keys(outputs).sort(), [...ALLOWED_KINDS].sort())
  for (const kind of ALLOWED_KINDS) {
    const result = profileOutput(
      kind,
      outputs[kind],
      '',
      kind === 'openclaw' ? 'legacy' : '',
    )
    assert.equal(result.outcome, 'completed', kind)
    assert.ok(result.text, kind)
  }
})

test('structured result output keeps the terminal result after an earlier recoverable error', () => {
  for (const [kind, resultText] of [
    ['claude', 'Claude completed after recovering'],
    ['workbuddy', 'WorkBuddy completed after recovering'],
    ['qwen', 'Qwen completed after recovering'],
  ]) {
    const result = profileOutput(kind, [
      JSON.stringify({ type: 'error', error: { message: 'tool attempt failed' } }),
      JSON.stringify({
        type: 'result',
        result: resultText,
        session_id: `${kind}-session`,
      }),
    ].join('\n'))
    assert.equal(result.outcome, 'completed', kind)
    assert.equal(result.text, resultText, kind)
  }
})

test('a Claude terminal result settles even when the native process forgets to exit', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-claude-terminal-hang-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const cli = executable(directory, 'claude-terminal-hang.cjs', `
process.stdout.write(JSON.stringify({ type: 'result', result: 'Claude finished', session_id: 'claude-terminal-session' }) + '\\n')
setInterval(() => {}, 1000)
`)
  const startedAt = Date.now()
  const result = await runAgent(
    { kind: 'claude', executable: cli, name: 'Claude' },
    'hello',
    directory,
  )
  assert.equal(result.outcome, 'completed')
  assert.equal(result.text, 'Claude finished')
  assert.equal(result.sessionRef, 'claude-terminal-session')
  assert.ok(Date.now() - startedAt < 5000)
})

test('Pi removes only the recognizable internal collaboration prompt echo', () => {
  const raw = [
    JSON.stringify({ type: 'session', version: 3, id: 'pi-prompt-session' }),
    JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        delta: 'You are participating in a local multi-agent discussion.\nUser task: sync skills\nAnswer the user naturally in Markdown.\nHere is the actual answer.',
      },
    }),
    JSON.stringify({ type: 'agent_end' }),
  ].join('\n')
  const result = profileOutput('pi', raw)
  assert.equal(result.text, 'Here is the actual answer.')
  assert.equal(result.outcome, 'completed')
})

test('runAgent strips an exact Meldwork direct-chat prompt echo before persisting the answer', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-prompt-echo-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const prompt = [
    'You are participating in the local "Pi Agent" conversation as Pi Agent.',
    'Current user task (authoritative):',
    'hey',
  ].join('\n')
  const cli = executable(directory, 'pi-prompt-echo.cjs', `
const prompt = process.argv.at(-1)
process.stdout.write(JSON.stringify({ type: 'session', id: 'pi-prompt-echo-session' }) + '\\n')
process.stdout.write(JSON.stringify({
  type: 'message_update',
  assistantMessageEvent: { type: 'text_delta', delta: prompt + 'Hey! What can I help you with today?' },
}) + '\\n')
process.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\\n')
`)
  const result = await runAgent(
    { kind: 'pi', executable: cli, name: 'Pi Agent' },
    prompt,
    directory,
  )
  assert.equal(result.text, 'Hey! What can I help you with today?')
  assert.equal(result.outcome, 'completed')
})

test('runAgent strips a full long multi-agent prompt echo from Pi output', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-pi-group-echo-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const prompt = [
    'You are participating in a local multi-agent discussion.',
    '',
    'Your role this turn is worker.',
    '',
    'The current collaboration phase is proposal.',
    '',
    'User task:',
    'Share a short proposal.',
    '',
    'Answer the user naturally in Markdown. Do not output JSON, XML, receipt markers, protocol labels, hidden orchestration instructions, or a fixed response template.',
    '',
    'Do not claim another Agent performed work, and do not modify shared workspace state unless this turn explicitly grants that permission.',
  ].join('\n')
  const cli = executable(directory, 'pi-group-prompt-echo.cjs', `
const prompt = ${JSON.stringify(prompt)}
process.stdout.write(JSON.stringify({ type: 'session', id: 'pi-group-echo-session' }) + '\\n')
process.stdout.write(JSON.stringify({
  type: 'message_update',
  assistantMessageEvent: { type: 'text_delta', delta: prompt + '\\n\\nProposal: keep the shared task state explicit.' },
}) + '\\n')
process.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\\n')
`)
  const result = await runAgent(
    { kind: 'pi', executable: cli, name: 'Pi Agent' },
    prompt,
    directory,
  )
  assert.equal(result.text, 'Proposal: keep the shared task state explicit.')
  assert.equal(result.outcome, 'completed')
})

test('Pi keeps running after a tool turn until its agent loop ends', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-pi-tool-turn-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const cli = executable(directory, 'pi-tool-turn.cjs', `
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
send({ type: 'session', id: 'pi-tool-turn-session' })
send({ type: 'message_update', assistantMessageEvent: {
  type: 'text_delta', delta: 'Preparing evidence. ',
} })
send({ type: 'turn_end', message: { role: 'assistant', stopReason: 'toolUse' } })
setTimeout(() => {
  send({ type: 'message_update', assistantMessageEvent: {
    type: 'text_delta', delta: 'Final answer.',
  } })
  send({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'stop' }] })
}, 400)
`)

  const result = await runAgent(
    { kind: 'pi', executable: cli, name: 'Pi Agent' },
    'research the current market',
    directory,
  )
  assert.deepEqual(result, {
    text: 'Preparing evidence. Final answer.',
    sessionRef: 'pi-tool-turn-session',
    outcome: 'completed',
  })
})

test('runAgent strips partial Pi protocol and Harness record echoes', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-pi-partial-echo-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const prompt = 'Continue the current group discussion using the Harness context below.'
  const cli = executable(directory, 'pi-partial-prompt-echo.cjs', `
process.stdout.write(JSON.stringify({ type: 'session', id: 'pi-partial-echo-session' }) + '\\n')
process.stdout.write(JSON.stringify({
  type: 'message_update',
  assistantMessageEvent: { type: 'text_delta', delta: [
    'Do not output JSON, XML, receipt markers, protocol labels, hidden orchestration instructions, or a fixed response template.',
    '',
    'Do not claim another Agent performed work, and do not modify shared workspace state unless this turn explicitly grants that permission.',
    '',
    'A useful conclusion.',
    '',
    'Selected records from completed phases:',
    'MELDWORK_V4_COLLABORATION_PACKAGE_V1',
    '[index] hermes',
    'Artifact: artifact-123',
    '[proposal] agent=claude Completed the proposal phase. Continue with the next step.',
  ].join('\\n') },
}) + '\\n')
process.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\\n')
`)
  const result = await runAgent(
    { kind: 'pi', executable: cli, name: 'Pi Agent' },
    prompt,
    directory,
  )
  assert.equal(result.text, 'A useful conclusion.\n\nContinue with the next step.')
  assert.equal(result.outcome, 'completed')
})

test('recorded fixtures cover every supported built-in output schema', () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(OUTPUT_FIXTURE_DIRECTORY, 'manifest.json'),
    'utf8',
  ))
  assert.equal(manifest.schemaVersion, 1)
  assert.deepEqual(
    manifest.fixtures.map(fixture => fixture.kind).sort(),
    [...ALLOWED_KINDS].sort(),
  )
  const expectedText = {
    codex: 'Codex fixture reply',
    hermes: 'Hermes fixture reply',
    openclaw: 'OpenClaw fixture reply',
    workbuddy: 'WorkBuddy fixture reply',
    kimi: 'Kimi fixture reply',
    mimo: 'MiMo fixture reply',
    pi: 'Pi Agent fixture reply',
    claude: 'Claude fixture reply',
    gemini: 'Gemini fixture reply',
    opencode: 'OpenCode fixture reply',
    qwen: 'Qwen fixture reply',
    opencodereview: 'OpenCodeReview fixture reply',
  }
  for (const fixture of manifest.fixtures) {
    assert.match(fixture.version, /\d/, fixture.kind)
    const raw = fs.readFileSync(path.join(OUTPUT_FIXTURE_DIRECTORY, fixture.file), 'utf8')
    const result = profileOutput(fixture.kind, raw, '', fixture.transport)
    assert.equal(result.text, expectedText[fixture.kind], fixture.kind)
    assert.equal(result.outcome, 'completed', fixture.kind)
    if (!['hermes', 'openclaw', 'opencodereview'].includes(fixture.kind)) {
      assert.equal(result.sessionRef, `${fixture.kind}-fixture-session`, fixture.kind)
    }
    if (fixture.kind === 'opencodereview') {
      assert.equal(result.externalRunRef, 'ocr-fixture-session')
    }
  }
})

test('OpenCode and MiMo require an explicit step finish before declaring completion', () => {
  for (const kind of ['opencode', 'mimo']) {
    const result = profileOutput(kind, JSON.stringify({
      type: 'text', sessionID: `${kind}-session`,
      part: { type: 'text', text: `${kind} reply` },
    }))
    assert.equal(result.outcome, 'partial', kind)
  }
})

test('structured JSON documents fail closed when malformed or over the safe limit', () => {
  const malformed = createStructuredOutputAccumulator('openclaw')
  malformed.write(Buffer.from('{"payloads":['))
  const malformedResult = malformed.end()
  assert.equal(malformedResult.outcome, 'failed')
  assert.equal(malformedResult.failure.code, 'LOCAL_AGENT_OUTCOME_INVALID')

  const oversized = createStructuredOutputAccumulator('opencodereview')
  oversized.write(Buffer.alloc((64 * 1024 * 1024) + 1))
  const oversizedResult = oversized.end()
  assert.equal(oversizedResult.outcome, 'failed')
  assert.equal(oversizedResult.failure.code, 'LOCAL_AGENT_OUTPUT_LIMIT')
})

test('every resumable built-in adapter classifies an invalid native Session', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-invalid-sessions-'))
  const cli = executable(directory, 'invalid-session.cjs', `
process.stderr.write('Saved session was not found or has expired.\\n')
process.exit(2)
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const resumableKinds = Object.entries(AGENT_RUNTIME_CAPABILITIES)
    .filter(([, capabilities]) => capabilities.resumable)
    .map(([kind]) => kind)
  for (const kind of resumableKinds) {
    const options = {
      sessionRef: `${kind}-stale-session`,
      home: directory,
      ...(kind === 'openclaw'
        ? signedOpenClawRuntime(directory, directory, `${kind}-stale-session`)
        : {}),
      ...(kind === 'hermes'
        ? { hermesAcpAvailable: false, sessionTransport: 'legacy' }
        : {}),
      ...(kind === 'kimi' ? { sandbox: 'workspace-write' } : {}),
    }
    await assert.rejects(
      runAgent({ kind, executable: cli, name: kind }, 'resume', directory, options),
      (error) => error.message === 'LOCAL_AGENT_SESSION_INVALID'
        && error.failure.sessionInvalid === true
        && error.failure.retryable === true,
      kind,
    )
  }
})

test('OpenCode JSONL output returns completed text and the native session id', () => {
  const raw = [
    JSON.stringify({
      type: 'tool_use', sessionID: 'opencode-session',
      part: { type: 'tool', tool: 'read' },
    }),
    JSON.stringify({
      type: 'text', sessionID: 'opencode-session',
      part: { type: 'text', text: 'OpenCode reply' },
    }),
  ].join('\n')
  assert.deepEqual(parseOpenCodeOutput(raw), {
    text: 'OpenCode reply',
    sessionRef: 'opencode-session',
  })
})

test('supported local CLIs run in the selected workdir and return native session ids', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cli-workdir-'))
  const workdir = fs.realpathSync(directory)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const fixtures = [
    {
      kind: 'workbuddy',
      source: `process.stdout.write(JSON.stringify({
        type: 'result', result: process.cwd(), session_id: 'workbuddy-session',
      }))`,
    },
    {
      kind: 'kimi',
      options: { sandbox: 'workspace-write' },
      source: `process.stdout.write([
        JSON.stringify({ role: 'assistant', content: process.cwd() }),
        JSON.stringify({ type: 'session.resume_hint', session_id: 'kimi-session' }),
      ].join('\\n'))`,
    },
    {
      kind: 'claude',
      source: `process.stdout.write(JSON.stringify({
        type: 'result', result: process.cwd(), session_id: 'claude-session',
      }))`,
    },
    {
      kind: 'qwen',
      source: `process.stdout.write(JSON.stringify({
        type: 'result', result: process.cwd(), session_id: 'qwen-session',
      }))`,
    },
    {
      kind: 'gemini',
      source: `process.stdout.write([
        JSON.stringify({ type: 'init', session_id: 'gemini-session' }),
        JSON.stringify({ type: 'message', role: 'assistant', content: process.cwd() }),
      ].join('\\n'))`,
    },
    {
      kind: 'opencode',
      source: `process.stdout.write(JSON.stringify({
        type: 'text', sessionID: 'opencode-session',
        part: { type: 'text', text: process.cwd() },
      }) + '\\n')`,
    },
  ]

  for (const fixture of fixtures) {
    const cli = executable(directory, `${fixture.kind}.cjs`, fixture.source)
    const result = await runAgent(
      { kind: fixture.kind, executable: cli, name: fixture.kind },
      'hello',
      workdir,
      fixture.options,
    )
    assert.equal(result.text, workdir, fixture.kind)
    assert.equal(result.sessionRef, `${fixture.kind}-session`, fixture.kind)
  }
})

test('Pi runs in JSON mode and selects approval flags from the sandbox', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-pi-invocation-'))
  const workdir = fs.realpathSync(directory)
  const argvFile = path.join(directory, 'pi-argv.json')
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const cli = executable(directory, 'pi-argv.cjs', `
const fs = require('node:fs')
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)))
process.stdout.write(JSON.stringify({ type: 'session', version: 3, id: 'pi-session' }) + '\\n')
process.stdout.write(JSON.stringify({
  type: 'message_update',
  assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: process.cwd() },
}) + '\\n')
process.stdout.write(JSON.stringify({ type: 'turn_end', stopReason: 'stop' }) + '\\n')
`)

  for (const sandbox of ['workspace-write', 'read-only']) {
    fs.writeFileSync(argvFile, '')
    const result = await runAgent(
      { kind: 'pi', executable: cli, name: 'pi' },
      'hello',
      workdir,
      { sandbox, sessionRef: 'pi-native-session' },
    )
    const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8'))
    assert.equal(result.text, workdir, sandbox)
    assert.equal(result.sessionRef, 'pi-session', sandbox)
    assert.ok(argv.includes('--mode'), sandbox)
    assert.ok(argv.includes('json'), sandbox)
    assert.ok(argv.includes('--print'), sandbox)
    assert.ok(argv.includes('--session'), sandbox)
    assert.ok(argv.includes('pi-native-session'), sandbox)
    assert.ok(argv.indexOf('--mode') < argv.indexOf('--print'), sandbox)
    assert.ok(argv.includes(sandbox === 'workspace-write' ? '--approve' : '--no-approve'), sandbox)
    assert.equal(argv.includes(sandbox === 'workspace-write' ? '--no-approve' : '--approve'), false, sandbox)
  }
})

test('every conversational built-in Agent emits its answer through the shared runtime event contract', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-agent-events-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const manifest = JSON.parse(fs.readFileSync(
    path.join(OUTPUT_FIXTURE_DIRECTORY, 'manifest.json'),
    'utf8',
  ))

  for (const fixture of manifest.fixtures) {
    const raw = fs.readFileSync(path.join(OUTPUT_FIXTURE_DIRECTORY, fixture.file), 'utf8')
    const cli = executable(directory, `${fixture.kind}-runtime-events.cjs`, `
process.stdout.write(${JSON.stringify(raw)})
`)
    const events = []
    const options = {
      onEvent: event => events.push(event),
      ...(fixture.kind === 'hermes' ? { hermesAcpAvailable: false } : {}),
      ...(fixture.kind === 'kimi' ? { sandbox: 'workspace-write' } : {}),
      ...(fixture.kind === 'openclaw'
        ? signedOpenClawRuntime(directory, directory, 'agent:main:runtime-events')
        : {}),
    }

    const result = await runAgent(
      { kind: fixture.kind, executable: cli, name: fixture.kind },
      'Return a concise answer',
      directory,
      options,
    )
    const answer = events
      .filter(event => event.type === 'answer_delta')
      .reduce(
        (value, event) => event.replace === true ? event.delta : value + event.delta,
        '',
      )

    assert.equal(answer, result.text, fixture.kind)
    assert.equal(events.some(event => event.type === 'answer_delta'), true, fixture.kind)
    assert.equal(events.every(event => !JSON.stringify(event).includes(directory)), true, fixture.kind)
  }
})

test('runAgent retains final structured output after stdout exceeds its capture limit', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cli-long-output-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const fillerBytes = 10 * 1024 * 1024 + 64 * 1024
  const fixtures = [{
    kind: 'codex',
    source: `
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'codex-long-session' }) + '\\n')
process.stdout.write('x'.repeat(${fillerBytes}) + '\\n')
process.stdout.write(JSON.stringify({
  type: 'item.completed', item: { type: 'agent_message', text: 'Codex final after limit' },
}) + '\\n')
process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n')
`,
    expected: {
      text: 'Codex final after limit', sessionRef: 'codex-long-session', outcome: 'completed',
      progress: [{ id: 'turn', title: 'process', status: 'completed' }],
    },
  }, {
    kind: 'qwen',
    source: `
process.stdout.write('x'.repeat(${fillerBytes}) + '\\n')
process.stdout.write(JSON.stringify({
  type: 'result', result: 'Qwen final after limit', session_id: 'qwen-long-session',
}) + '\\n')
`,
    expected: {
      text: 'Qwen final after limit', sessionRef: 'qwen-long-session', outcome: 'completed',
    },
  }, {
    kind: 'workbuddy',
    source: `
process.stdout.write('x'.repeat(${Math.ceil(fillerBytes / 2)}) + '\\n')
process.stdout.write(JSON.stringify({
  type: 'result', result: 'WorkBuddy final after limit', session_id: 'workbuddy-long-session',
}) + '\\n')
process.stdout.write('x'.repeat(${Math.ceil(fillerBytes / 2)}) + '\\n')
`,
    expected: {
      text: 'WorkBuddy final after limit',
      sessionRef: 'workbuddy-long-session',
      outcome: 'completed',
    },
  }, {
    kind: 'openclaw',
    source: `
process.stdout.write('{"payloads":[{"text":"OpenClaw final after limit"}],"meta":{"noise":"')
process.stdout.write('x'.repeat(${fillerBytes}))
process.stdout.write('","aborted":false,"completion":{"stopReason":"stop"}}}')
`,
    expected: {
      text: 'OpenClaw final after limit', sessionRef: '', outcome: 'completed',
    },
  }, {
    kind: 'opencodereview',
    source: `
process.stdout.write('{"status":"complete","message":"OCR final after limit","noise":"')
process.stdout.write('x'.repeat(${fillerBytes}))
process.stdout.write('","comments":[],"session_id":"ocr-long-session","manifest":')
process.stdout.write(JSON.stringify({
  schema_version: 'ocr.run-manifest/v1', operation: 'review', terminal_state: 'complete',
}) + '}')
`,
    expected: {
      text: 'OCR final after limit', sessionRef: '', outcome: 'completed',
      externalRunRef: 'ocr-long-session',
    },
  }]

  for (const fixture of fixtures) {
    const cli = executable(directory, `${fixture.kind}-long-output.cjs`, fixture.source)
    const options = fixture.kind === 'openclaw'
      ? signedOpenClawRuntime(directory, directory, 'agent:main:long-output')
      : undefined
    const result = await runAgent(
      { kind: fixture.kind, executable: cli, name: fixture.kind },
      'hello',
      directory,
      options,
    )
    assert.deepEqual(result, fixture.expected, fixture.kind)
  }
})

test('final JSON agents emit one sanitized fallback answer event', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-final-events-'))
  const cli = executable(directory, 'final-events.cjs', `
process.stdout.write(JSON.stringify({
  type: 'result',
  result: [
    'final answer',
    'command=rg -n token /Users/private/workspace/file.txt',
    'OPENAI_API_KEY=' + process.env.OPENAI_API_KEY,
    'stderr=permission denied',
  ].join('\\n'),
  session_id: 'final-event-session',
}))
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const secret = 'provider-secret-for-runtime-event'
  const events = []

  const result = await runAgent(
    { kind: 'qwen', executable: cli, name: 'Qwen' },
    'hello',
    directory,
    {
      env: { OPENAI_API_KEY: secret },
      onEvent: event => events.push(event),
    },
  )

  assert.equal(result.sessionRef, 'final-event-session')
  assert.equal(result.text.includes('[redacted]'), true)
  assert.equal(events.length, 1)
  assert.deepEqual(
    { type: events[0].type, status: events[0].status },
    { type: 'answer_delta', status: 'completed' },
  )
  assert.match(events[0].delta, /final answer/)
  assert.doesNotMatch(
    JSON.stringify(events),
    /command|rg -n|Users|private|workspace|provider-secret|stderr|permission denied/i,
  )
})

test('runtime event callback failures do not change the Agent result', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-event-callback-'))
  const cli = executable(directory, 'event-callback.cjs', `
process.stdout.write(JSON.stringify({
  type: 'result', result: 'callback-safe reply', session_id: 'callback-session',
}))
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = await runAgent(
    { kind: 'claude', executable: cli, name: 'Claude' },
    'hello',
    directory,
    { onEvent: () => { throw new Error('renderer callback failed') } },
  )

  assert.deepEqual(result, {
    text: 'callback-safe reply',
    sessionRef: 'callback-session',
    outcome: 'completed',
  })
})

test('runAgent forces OpenCode read-only permissions without changing user configuration', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-opencode-permission-'))
  const cli = executable(directory, 'opencode-permission.cjs', `
process.stdout.write(JSON.stringify({
  type: 'text',
  sessionID: 'opencode-session',
  part: { type: 'text', text: process.env.OPENCODE_PERMISSION },
}) + '\\n')
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = await runAgent(
    { kind: 'opencode', executable: cli, name: 'OpenCode' },
    'hello',
    directory,
    { env: { OPENCODE_PERMISSION: JSON.stringify({ edit: 'allow' }) } },
  )

  assert.deepEqual(JSON.parse(result.text), {
    '*': 'deny',
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    webfetch: 'allow',
    websearch: 'allow',
  })
  assert.equal(result.sessionRef, 'opencode-session')
})

test('runAgent injects Provider secrets through the child environment only', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cli-provider-'))
  const cli = executable(directory, 'provider-env.cjs', `
process.stdout.write([
  process.env.KIMI_MODEL_NAME,
  process.env.KIMI_MODEL_BASE_URL,
  process.env.KIMI_MODEL_API_KEY,
].join('|'))
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = await runAgent(
    { kind: 'kimi', executable: cli, name: 'Kimi' },
    'hello',
    directory,
    {
      env: {
        KIMI_MODEL_NAME: 'glm',
        KIMI_MODEL_BASE_URL: 'https://api.example.com/v1',
        KIMI_MODEL_API_KEY: 'test-secret-env-only',
      },
      sandbox: 'workspace-write',
    },
  )
  assert.equal(result.text, 'glm|https://api.example.com/v1|[redacted]')
})

test('runAgent never exposes unrelated Meldwork process values to local CLIs', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cli-private-'))
  const cli = executable(directory, 'token-env.cjs', `
process.stdout.write(JSON.stringify({
  type: 'result',
  result: process.env.MELDWORK_PRIVATE_VALUE || 'not-exposed',
  session_id: 'claude-session',
}))
`)
  const previous = process.env.MELDWORK_PRIVATE_VALUE
  process.env.MELDWORK_PRIVATE_VALUE = 'test-private-value'
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true })
    if (previous == null) delete process.env.MELDWORK_PRIVATE_VALUE
    else process.env.MELDWORK_PRIVATE_VALUE = previous
  })

  const result = await runAgent(
    { kind: 'claude', executable: cli, name: 'Claude' },
    'hello',
    directory,
  )

  assert.equal(result.text, 'not-exposed')
})

test('runAgent scopes the child environment and redacts current Agent secrets from output', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cli-env-scope-'))
  const cli = executable(directory, 'env-scope.cjs', `
process.stdout.write(JSON.stringify({
  type: 'result',
  result: JSON.stringify({
    ambientOpenAi: process.env.OPENAI_API_KEY || '',
    ambientPrivate: process.env.UNRELATED_PRIVATE_VALUE || '',
    explicitAnthropic: process.env.ANTHROPIC_API_KEY || '',
    hasHome: Boolean(process.env.HOME || process.env.USERPROFILE),
  }),
  session_id: 'claude-session',
}))
`)
  const previousOpenAi = process.env.OPENAI_API_KEY
  const previousPrivate = process.env.UNRELATED_PRIVATE_VALUE
  process.env.OPENAI_API_KEY = 'ambient-openai-secret'
  process.env.UNRELATED_PRIVATE_VALUE = 'ambient-private-secret'
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true })
    if (previousOpenAi == null) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousOpenAi
    if (previousPrivate == null) delete process.env.UNRELATED_PRIVATE_VALUE
    else process.env.UNRELATED_PRIVATE_VALUE = previousPrivate
  })

  const result = await runAgent(
    { kind: 'claude', executable: cli, name: 'Claude' },
    'hello',
    directory,
    { env: { ANTHROPIC_API_KEY: 'current-agent-secret' } },
  )

  assert.deepEqual(JSON.parse(result.text), {
    ambientOpenAi: '',
    ambientPrivate: '',
    explicitAnthropic: '[redacted]',
    hasHome: true,
  })
})

test('runAgent keeps redacted Provider diagnostics out of renderer-visible errors', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cli-error-secret-'))
  const cli = executable(directory, 'error-secret.cjs', `
process.stderr.write('Provider rejected ' + process.env.OPENAI_API_KEY)
process.exit(1)
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const secret = 'test-provider-secret-value'

  await assert.rejects(
    runAgent(
      { kind: 'qwen', executable: cli, name: 'Qwen' },
      'hello',
      directory,
      { env: { OPENAI_API_KEY: secret }, sessionRef: 'qwen-existing-session' },
    ),
    (error) => {
      assert.equal(error.message, 'LOCAL_AGENT_AUTH_REQUIRED')
      assert.equal(error.diagnostic, 'Provider rejected [redacted]')
      assert.equal(error.diagnostic.includes(secret), false)
      assert.equal(Object.prototype.propertyIsEnumerable.call(error, 'diagnostic'), false)
      assert.doesNotMatch(error.message, /Provider|redacted/)
      return true
    },
  )
})

test('legacy adapters classify an explicitly missing resumed session', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cli-missing-session-'))
  const cli = executable(directory, 'missing-session.cjs', `
process.stderr.write('No conversation found with session ID qwen-stale-session')
process.exit(1)
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  await assert.rejects(
    runAgent(
      { kind: 'qwen', executable: cli, name: 'Qwen' },
      'resume safely',
      directory,
      { sessionRef: 'qwen-stale-session' },
    ),
    (error) => {
      assert.equal(error.message, 'LOCAL_AGENT_SESSION_INVALID')
      assert.match(error.diagnostic, /No conversation found with session ID/)
      assert.equal(Object.prototype.propertyIsEnumerable.call(error, 'diagnostic'), false)
      return true
    },
  )
})

test('structured CLI authentication failures expose only a stable error code', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cli-error-'))
  const cli = executable(directory, 'structured-error.cjs', `
process.stderr.write('startup warning')
process.stdout.write(JSON.stringify([{ type: 'result', subtype: 'error_during_execution',
  is_error: true, error: { message: 'Select an auth type first.' } }]))
process.exit(1)
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  await assert.rejects(
    runAgent({ kind: 'qwen', executable: cli, name: 'Qwen' }, 'hello', directory),
    (error) => {
      assert.equal(error.message, 'LOCAL_AGENT_AUTH_REQUIRED')
      assert.equal(error.diagnostic, 'startup warning\nSelect an auth type first.')
      assert.equal(Object.prototype.propertyIsEnumerable.call(error, 'diagnostic'), false)
      return true
    },
  )
})

test('generic CLI failures keep executable paths in main-process diagnostics only', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cli-process-error-'))
  const cli = executable(directory, 'process-error.cjs', `
process.stderr.write('Agent crashed in /private/agents/qwen: upstream failure')
process.exit(1)
`)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  await assert.rejects(
    runAgent({ kind: 'qwen', executable: cli, name: 'Qwen' }, 'hello', directory),
    (error) => {
      assert.equal(error.message, 'LOCAL_AGENT_PROCESS_FAILED')
      assert.equal(error.diagnostic, 'Agent crashed in /private/agents/qwen: upstream failure')
      assert.equal(Object.prototype.propertyIsEnumerable.call(error, 'diagnostic'), false)
      assert.doesNotMatch(error.message, /private|qwen|upstream/i)
      return true
    },
  )
})

test('nonzero CLI exits without diagnostics retain the stable exited code', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cli-empty-error-'))
  const cli = executable(directory, 'empty-error.cjs', 'process.exit(1)')
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  await assert.rejects(
    runAgent({ kind: 'qwen', executable: cli, name: 'Qwen' }, 'hello', directory),
    (error) => {
      assert.equal(error.message, 'LOCAL_AGENT_EXITED')
      assert.equal(error.diagnostic, undefined)
      return true
    },
  )
})

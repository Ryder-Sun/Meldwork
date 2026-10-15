const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const adapters = require('../../../src/agents/cli/cli-adapters.cjs')
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

test('Hermes keeps one ACP process across workspace turns and streams each tool lifecycle', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-hermes-persistent-acp-'))
  const spawnCountFile = path.join(directory, 'spawn-count.txt')
  const stoppedFile = path.join(directory, 'stopped.txt')
  const cli = executable(directory, 'hermes-persistent-acp.cjs', `
const fs = require('node:fs')
const readline = require('node:readline')
if (process.argv[2] !== 'acp') {
  process.stdout.write('legacy fallback')
  process.exit(0)
}
const countFile = process.env.MELDWORK_TEST_SPAWN_COUNT_FILE
const spawnCount = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0
fs.writeFileSync(countFile, String(spawnCount + 1))
const input = readline.createInterface({ input: process.stdin })
input.on('close', () => fs.writeFileSync(${JSON.stringify(stoppedFile)}, 'stopped'))
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
const update = (sessionId, value) => send({
  jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value },
})
let resumed = false
let promptCount = 0
input.on('line', (line) => {
  const message = JSON.parse(line)
  const sessionId = message.params?.sessionId || 'hermes-persistent-session'
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId } })
  } else if (message.method === 'session/resume') {
    resumed = true
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    promptCount += 1
    if (resumed) {
      const prompt = message.params?.prompt?.[0]?.text || ''
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: prompt === 'auth prompt'
            ? 'HTTP 401: Invalid token (request id: request-1)'
            : 'resumed turn',
        },
      })
      send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
      return
    }
    const toolCallId = 'tool-' + promptCount
    update(sessionId, {
      sessionUpdate: 'tool_call', toolCallId, title: 'search', kind: 'search',
      status: 'in_progress', rawInput: { query: 'turn ' + promptCount },
    })
    update(sessionId, {
      sessionUpdate: 'tool_call_update', toolCallId, title: 'search', kind: 'search',
      status: 'in_progress', rawOutput: { matches: promptCount },
    })
    update(sessionId, {
      sessionUpdate: 'tool_call_update', toolCallId, title: 'search', kind: 'search',
      status: 'completed', rawOutput: { matches: promptCount },
    })
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'turn-' + promptCount + ' ' },
    })
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'stream' },
    })
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
  }
})
`)
  t.after(async () => {
    await adapters.shutdownAcpSessionRuntime?.()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  const agent = { kind: 'hermes', executable: cli, name: 'Hermes' }
  const firstEvents = []
  const first = await adapters.runAgent(agent, 'first prompt', directory, {
    acpPersistenceKey: 'workspace:hermes:direct',
    env: { MELDWORK_TEST_SPAWN_COUNT_FILE: spawnCountFile },
    onEvent: event => firstEvents.push(event),
  })
  const secondEvents = []
  const second = await adapters.runAgent(agent, 'second prompt', directory, {
    acpPersistenceKey: 'workspace:hermes:direct',
    sessionRef: first.sessionRef,
    sessionTransport: 'acp',
    env: { MELDWORK_TEST_SPAWN_COUNT_FILE: spawnCountFile },
    onEvent: event => secondEvents.push(event),
  })

  assert.equal(first.text, 'turn-1 stream')
  assert.equal(second.text, 'turn-2 stream')
  assert.equal(second.sessionRef, first.sessionRef)
  assert.equal(fs.readFileSync(spawnCountFile, 'utf8'), '1')
  for (const events of [firstEvents, secondEvents]) {
    assert.deepEqual(events.map(event => event.type), [
      'tool_start', 'tool_update', 'tool_result_summary',
      'answer_delta', 'answer_delta', 'answer_delta',
    ])
    assert.equal(events.at(-1).status, 'completed')
    assert.equal(events.at(-1).replace, true)
  }

  assert.equal(typeof adapters.shutdownAcpSessionRuntime, 'function')
  await adapters.shutdownAcpSessionRuntime()
  await within(readWhenReady(stoppedFile))
  const resumed = await adapters.runAgent(agent, 'resumed prompt', directory, {
    acpPersistenceKey: 'workspace:hermes:direct',
    sessionRef: first.sessionRef,
    sessionTransport: 'acp',
    env: { MELDWORK_TEST_SPAWN_COUNT_FILE: spawnCountFile },
  })
  assert.equal(resumed.text, 'resumed turn')
  assert.equal(resumed.sessionRef, first.sessionRef)
  assert.equal(fs.readFileSync(spawnCountFile, 'utf8'), '2')
  await assert.rejects(() => adapters.runAgent(agent, 'auth prompt', directory, {
    acpPersistenceKey: 'workspace:hermes:direct',
    sessionRef: first.sessionRef,
    sessionTransport: 'acp',
    env: { MELDWORK_TEST_SPAWN_COUNT_FILE: spawnCountFile },
  }), error => error.message === 'LOCAL_AGENT_AUTH_REQUIRED'
    && error.failure?.category === 'authentication')
})

test('Hermes ACP receives image attachments as content blocks or falls back when unsupported', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-hermes-acp-image-'))
  const image = path.join(directory, 'diagram.png')
  fs.writeFileSync(image, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  ))
  const fakeHermes = supportsImages => executable(directory, `hermes-image-${supportsImages}.cjs`, `
const readline = require('node:readline')
if (process.argv[2] !== 'acp') {
  process.stdout.write('legacy ' + process.argv.slice(2).filter(arg => arg !== '--query').join(' ').replace(${JSON.stringify(directory)}, '<dir>'))
  process.exit(0)
}
const input = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
input.on('line', (line) => {
  const message = JSON.parse(line)
  const sessionId = message.params?.sessionId || 'hermes-image-session'
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: 1,
      agentCapabilities: { promptCapabilities: { image: ${supportsImages} } },
    } })
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId } })
  } else if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    const blocks = message.params?.prompt || []
    const summary = blocks.map(block => block.type === 'image'
      ? 'image:' + block.mimeType + ':' + (block.data.length > 20)
      : block.type).join(',')
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: summary },
    } } })
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
  }
})
`)
  t.after(async () => {
    await adapters.shutdownAcpSessionRuntime?.()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  const capable = await adapters.runAgent(
    { kind: 'hermes', executable: fakeHermes(true), name: 'Hermes' },
    'describe the diagram', directory,
    { acpPersistenceKey: 'workspace:hermes:image', attachments: [image] },
  )
  assert.equal(capable.text, 'text,image:image/png:true')

  const fallback = await adapters.runAgent(
    { kind: 'hermes', executable: fakeHermes(false), name: 'Hermes' },
    'describe the diagram', directory,
    { acpPersistenceKey: 'workspace:hermes:image-fallback', attachments: [image] },
  )
  assert.match(fallback.text, /^legacy chat --quiet --image <dir>\/diagram\.png/)
})

function resilientHermes(directory) {
  return executable(directory, 'hermes-resilient-acp.cjs', `
const fs = require('node:fs')
const readline = require('node:readline')
if (process.argv[2] !== 'acp') {
  process.stdout.write('legacy fallback')
  process.exit(0)
}
const countFile = process.env.MELDWORK_TEST_SPAWN_COUNT_FILE
const spawnCount = (fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0) + 1
fs.writeFileSync(countFile, String(spawnCount))
const input = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
let pendingSlowPrompt = null
input.on('line', (line) => {
  const message = JSON.parse(line)
  const sessionId = message.params?.sessionId || 'hermes-resilient-session'
  if (message.method === 'initialize') {
    if (process.env.MELDWORK_TEST_HANG_FIRST_INIT === '1' && spawnCount === 1) return
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId } })
  } else if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/cancel') {
    if (pendingSlowPrompt) {
      send({ jsonrpc: '2.0', id: pendingSlowPrompt, result: { stopReason: 'cancelled' } })
      pendingSlowPrompt = null
    }
  } else if (message.method === 'session/prompt') {
    const text = message.params?.prompt?.[0]?.text || ''
    if (text === 'slow prompt') {
      pendingSlowPrompt = message.id
      fs.writeFileSync(process.env.MELDWORK_TEST_PROMPT_FILE, 'received')
      return
    }
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'acp answer ' + spawnCount },
    } } })
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
  }
})
`)
}

test('a hanging ACP initialize times out and releases the conversation lock', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-acp-init-timeout-'))
  const spawnCountFile = path.join(directory, 'spawn-count.txt')
  t.after(async () => {
    await adapters.shutdownAcpSessionRuntime?.()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const agent = { kind: 'hermes', executable: resilientHermes(directory), name: 'Hermes' }
  const env = { MELDWORK_TEST_SPAWN_COUNT_FILE: spawnCountFile, MELDWORK_TEST_HANG_FIRST_INIT: '1' }
  const first = await within(adapters.runAgent(agent, 'first prompt', directory, {
    acpPersistenceKey: 'workspace:hermes:init-timeout', acpInitializeTimeoutMs: 300, env,
  }), 5000)
  // The stuck initialize no longer blocks: the turn falls back instead of hanging.
  assert.equal(first.text, 'legacy fallback')
  // Only the first process hangs; the next turn on the same conversation key
  // is not blocked by a lock left behind and gets a healthy ACP process.
  const second = await within(adapters.runAgent(agent, 'second prompt', directory, {
    acpPersistenceKey: 'workspace:hermes:init-timeout', env,
  }), 10000)
  assert.equal(second.text, 'acp answer 2')
})

test('a stopped ACP turn keeps the persistent process and its session when cancel is honoured', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-acp-cancel-keep-'))
  const spawnCountFile = path.join(directory, 'spawn-count.txt')
  const promptFile = path.join(directory, 'prompt.txt')
  t.after(async () => {
    await adapters.shutdownAcpSessionRuntime?.()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const agent = { kind: 'hermes', executable: resilientHermes(directory), name: 'Hermes' }
  const env = { MELDWORK_TEST_SPAWN_COUNT_FILE: spawnCountFile, MELDWORK_TEST_PROMPT_FILE: promptFile }
  const sessionRefs = []
  const controller = new AbortController()
  const stopped = adapters.runAgent(agent, 'slow prompt', directory, {
    acpPersistenceKey: 'workspace:hermes:cancel-keep',
    env,
    signal: controller.signal,
    onSessionRef: sessionRef => sessionRefs.push(sessionRef),
  }).then(() => null, error => error)
  await within(readWhenReady(promptFile), 5000)
  controller.abort()
  const error = await within(stopped, 5000)
  assert.equal(error?.message, 'LOCAL_AGENT_EXECUTION_STOPPED')

  const next = await within(adapters.runAgent(agent, 'next prompt', directory, {
    acpPersistenceKey: 'workspace:hermes:cancel-keep',
    sessionRef: sessionRefs.at(-1),
    sessionTransport: 'acp',
    env,
  }), 5000)
  assert.equal(next.text, 'acp answer 1')
  assert.equal(next.sessionRef, sessionRefs.at(-1))
  assert.equal(fs.readFileSync(spawnCountFile, 'utf8'), '1')
})

test('a changed PATH between turns keeps the persistent ACP process and session', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-acp-path-churn-'))
  const spawnCountFile = path.join(directory, 'spawn-count.txt')
  t.after(async () => {
    await adapters.shutdownAcpSessionRuntime?.()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const agent = { kind: 'hermes', executable: resilientHermes(directory), name: 'Hermes' }
  const shellPath = shell => [`/tmp/fnm_multishells/${shell}/bin`, '/usr/bin', '/bin'].join(path.delimiter)
  const first = await adapters.runAgent(agent, 'first prompt', directory, {
    acpPersistenceKey: 'workspace:hermes:path-churn',
    env: { MELDWORK_TEST_SPAWN_COUNT_FILE: spawnCountFile, PATH: shellPath('1001_1') },
  })
  const second = await adapters.runAgent(agent, 'second prompt', directory, {
    acpPersistenceKey: 'workspace:hermes:path-churn',
    sessionRef: first.sessionRef,
    sessionTransport: 'acp',
    env: { MELDWORK_TEST_SPAWN_COUNT_FILE: spawnCountFile, PATH: shellPath('1002_2') },
  })
  assert.equal(second.sessionRef, first.sessionRef)
  assert.equal(second.text, 'acp answer 1')
  assert.equal(fs.readFileSync(spawnCountFile, 'utf8'), '1')
})

test('ACP closes a start-only tool with the partial terminal outcome', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-acp-start-only-tool-'))
  const cli = executable(directory, 'acp-start-only-tool.cjs', `
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
const update = (sessionId, value) => send({
  jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value },
})
input.on('line', (line) => {
  const message = JSON.parse(line)
  const sessionId = message.params?.sessionId || 'start-only-tool-session'
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId } })
  } else if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    update(sessionId, {
      sessionUpdate: 'tool_call', toolCallId: 'start-only-tool', title: 'read',
      kind: 'read', status: 'in_progress', rawInput: { path: '/private/input' },
    })
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial answer' },
    })
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'max_tokens' } })
  }
})
`)
  t.after(async () => {
    await adapters.shutdownAcpSessionRuntime?.()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  const events = []
  const result = await adapters.runAgent(
    { kind: 'hermes', executable: cli, name: 'Hermes' },
    'Return a bounded answer.', directory, { onEvent: event => events.push(event) },
  )

  assert.equal(result.outcome, 'partial')
  assert.equal(events.some(event => event.type === 'answer_delta'), true)
  assert.equal(events.filter(event => event.type === 'answer_delta').at(-1).status, 'partial')
  assert.deepEqual(events.filter(event => event.id === 'start-only-tool').map(event => event.type), [
    'tool_start', 'tool_result_summary',
  ])
  assert.equal(events.some(event => event.type === 'tool_update'), false)
  assert.deepEqual(events.find(event => event.type === 'tool_result_summary'), {
    type: 'tool_result_summary',
    id: 'start-only-tool',
    status: 'partial',
    title: 'tool',
  })
})

test('shutdown waits for SDK preparation and prevents a later persistent ACP spawn', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-acp-shutdown-sdk-'))
  const spawnFile = path.join(directory, 'spawned.txt')
  const cli = executable(directory, 'persistent-acp-delayed-sdk.cjs', `
const fs = require('node:fs')
const readline = require('node:readline')
fs.writeFileSync(${JSON.stringify(spawnFile)}, 'spawned')
const input = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
const update = (sessionId, value) => send({
  jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value },
})
input.on('line', (line) => {
  const message = JSON.parse(line)
  const sessionId = message.params?.sessionId || 'delayed-sdk-session'
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId } })
  } else if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'unexpected spawn' },
    })
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
  }
})
`)
  const sdkPromise = Promise.all([
    import('@agentclientprotocol/sdk'),
    import('@agentclientprotocol/sdk/dist/schema/zod.gen.js'),
  ]).then(([sdk, validators]) => ({ ...sdk, validators }))
  let releaseSdk
  let noteSdkStarted
  const sdkStarted = new Promise(resolve => { noteSdkStarted = resolve })
  const sdkGate = new Promise(resolve => { releaseSdk = resolve })
  let settledRun
  t.after(async () => {
    releaseSdk(await sdkPromise)
    await settledRun
    await adapters.shutdownAcpSessionRuntime?.()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  settledRun = adapters.runAgent(
    { kind: 'hermes', executable: cli, name: 'Hermes' },
    'do not spawn after shutdown',
    directory,
    {
      acpPersistenceKey: 'workspace:hermes:delayed-sdk',
      loadAcpSdkFn: () => {
        noteSdkStarted()
        return sdkGate
      },
    },
  ).then(
    value => ({ status: 'fulfilled', value }),
    reason => ({ status: 'rejected', reason }),
  )

  await sdkStarted
  let shutdownSettled = false
  const shutdown = adapters.shutdownAcpSessionRuntime().then(() => { shutdownSettled = true })
  await new Promise(resolve => setImmediate(resolve))
  const settledBeforeSdk = shutdownSettled

  releaseSdk(await sdkPromise)
  await shutdown
  const outcome = await settledRun

  assert.equal(settledBeforeSdk, false)
  assert.equal(fs.existsSync(spawnFile), false)
  assert.equal(outcome.status, 'rejected')
})

test('shutdown waits for disposable ACP preparation and prevents a later spawn', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-acp-disposable-shutdown-sdk-'))
  const spawnFile = path.join(directory, 'spawned.txt')
  const cli = executable(directory, 'disposable-acp-delayed-sdk.cjs', `
const fs = require('node:fs')
const readline = require('node:readline')
fs.writeFileSync(${JSON.stringify(spawnFile)}, 'spawned')
const input = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
input.on('line', (line) => {
  const message = JSON.parse(line)
  const sessionId = message.params?.sessionId || 'disposable-delayed-sdk-session'
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId } })
  } else if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
  }
})
`)
  const sdkPromise = Promise.all([
    import('@agentclientprotocol/sdk'),
    import('@agentclientprotocol/sdk/dist/schema/zod.gen.js'),
  ]).then(([sdk, validators]) => ({ ...sdk, validators }))
  let releaseSdk
  let noteSdkStarted
  const sdkStarted = new Promise(resolve => { noteSdkStarted = resolve })
  const sdkGate = new Promise(resolve => { releaseSdk = resolve })
  let settledRun
  t.after(async () => {
    releaseSdk(await sdkPromise)
    await settledRun
    await adapters.shutdownAcpSessionRuntime?.()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  settledRun = adapters.runAgent(
    { kind: 'hermes', executable: cli, name: 'Hermes' },
    'do not spawn after shutdown',
    directory,
    {
      loadAcpSdkFn: () => {
        noteSdkStarted()
        return sdkGate
      },
    },
  ).then(
    value => ({ status: 'fulfilled', value }),
    reason => ({ status: 'rejected', reason }),
  )

  await sdkStarted
  let shutdownSettled = false
  const shutdown = adapters.shutdownAcpSessionRuntime().then(() => { shutdownSettled = true })
  await new Promise(resolve => setImmediate(resolve))
  const settledBeforeSdk = shutdownSettled
  assert.equal(settledBeforeSdk, false)

  releaseSdk(await sdkPromise)
  await shutdown
  const outcome = await settledRun

  assert.equal(fs.existsSync(spawnFile), false)
  assert.equal(outcome.status, 'rejected')
})

test('shutdown closes a persistent ACP child that is still initializing', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-acp-shutdown-initialize-'))
  const initializingFile = path.join(directory, 'initializing.txt')
  const pidFile = path.join(directory, 'pid.txt')
  const stoppedFile = path.join(directory, 'stopped.txt')
  const cli = executable(directory, 'persistent-acp-initializing.cjs', `
const fs = require('node:fs')
const readline = require('node:readline')
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
const input = readline.createInterface({ input: process.stdin })
input.on('close', () => {
  fs.writeFileSync(${JSON.stringify(stoppedFile)}, 'stopped')
  process.exit(0)
})
input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    fs.writeFileSync(${JSON.stringify(initializingFile)}, 'initializing')
  }
})
setInterval(() => {}, 1000)
`)
  let settledRun
  t.after(async () => {
    await adapters.shutdownAcpSessionRuntime?.()
    try {
      const pid = Number(fs.readFileSync(pidFile, 'utf8'))
      try { process.kill(-pid, 'SIGKILL') } catch {
        try { process.kill(pid, 'SIGKILL') } catch { /* already stopped */ }
      }
      try { await waitForExit(pid) } catch { /* best-effort fixture cleanup */ }
    } catch { /* the child was never spawned */ }
    await settledRun
    fs.rmSync(directory, { recursive: true, force: true })
  })

  settledRun = adapters.runAgent(
    { kind: 'hermes', executable: cli, name: 'Hermes' },
    'wait during initialization',
    directory,
    { acpPersistenceKey: 'workspace:hermes:initializing' },
  ).then(
    value => ({ status: 'fulfilled', value }),
    reason => ({ status: 'rejected', reason }),
  )

  assert.equal(await readWhenReady(initializingFile), 'initializing')
  await adapters.shutdownAcpSessionRuntime()

  assert.equal(await readWhenReady(stoppedFile), 'stopped')
  assert.equal((await within(settledRun)).status, 'rejected')
})

test('the seventeenth concurrent persistent ACP runtime reaches its first turn before eviction', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-acp-runtime-limit-'))
  const releaseFile = path.join(directory, 'release.txt')
  const cli = executable(directory, 'persistent-acp-runtime-limit.cjs', `
const fs = require('node:fs')
const readline = require('node:readline')
const readyFile = process.env.MELDWORK_TEST_READY_FILE
const releaseFile = process.env.MELDWORK_TEST_RELEASE_FILE
const input = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
const update = (sessionId, value) => send({
  jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value },
})
input.on('line', (line) => {
  const message = JSON.parse(line)
  const sessionId = message.params?.sessionId || 'persistent-' + process.pid
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId } })
  } else if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    fs.writeFileSync(readyFile, 'prompted')
    const finish = () => {
      if (!fs.existsSync(releaseFile)) return setTimeout(finish, 10)
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'completed-' + process.pid },
      })
      send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
    }
    finish()
  }
})
`)
  const settledRuns = []
  t.after(async () => {
    fs.writeFileSync(releaseFile, 'release')
    await Promise.all(settledRuns)
    await adapters.shutdownAcpSessionRuntime?.()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  const agent = { kind: 'hermes', executable: cli, name: 'Hermes' }
  const startRun = (index) => {
    const readyFile = path.join(directory, `ready-${index}.txt`)
    const settled = adapters.runAgent(agent, `prompt ${index}`, directory, {
      acpPersistenceKey: `workspace:hermes:limit:${index}`,
      env: {
        MELDWORK_TEST_READY_FILE: readyFile,
        MELDWORK_TEST_RELEASE_FILE: releaseFile,
      },
    }).then(
      value => ({ status: 'fulfilled', value }),
      reason => ({ status: 'rejected', reason }),
    )
    settledRuns.push(settled)
    return { readyFile, settled }
  }

  const firstSixteen = Array.from({ length: 16 }, (_, index) => startRun(index))
  await Promise.all(firstSixteen.map(run => readWhenReady(run.readyFile, 5000)))

  const seventeenth = startRun(16)
  const firstOutcome = await Promise.race([
    readWhenReady(seventeenth.readyFile, 5000).then(() => 'prompted'),
    seventeenth.settled.then(outcome => (
      outcome.status === 'rejected' ? outcome.reason.message : 'settled-before-prompt'
    )),
  ])

  assert.equal(firstOutcome, 'prompted')
  fs.writeFileSync(releaseFile, 'release')
  const outcomes = await Promise.all(settledRuns)
  assert.equal(outcomes.every(outcome => outcome.status === 'fulfilled'), true)
})

test('persistent ACP applies its inbound traffic budget to each turn', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-acp-turn-budget-'))
  const cli = executable(directory, 'persistent-acp-turn-budget.cjs', `
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
const update = (sessionId, value) => send({
  jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value },
})
const thought = 'x'.repeat(900 * 1024)
let promptCount = 0
input.on('line', (line) => {
  const message = JSON.parse(line)
  const sessionId = message.params?.sessionId || 'persistent-turn-budget-session'
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId } })
  } else if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    promptCount += 1
    for (let index = 0; index < 10; index += 1) {
      update(sessionId, {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: thought },
      })
    }
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'turn-' + promptCount },
    })
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
  }
})
`)
  t.after(async () => {
    await adapters.shutdownAcpSessionRuntime?.()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  const agent = { kind: 'hermes', executable: cli, name: 'Hermes' }
  const first = await adapters.runAgent(agent, 'first prompt', directory, {
    acpPersistenceKey: 'workspace:hermes:turn-budget',
  })
  const second = await adapters.runAgent(agent, 'second prompt', directory, {
    acpPersistenceKey: 'workspace:hermes:turn-budget',
    sessionRef: first.sessionRef,
    sessionTransport: 'acp',
  })

  assert.equal(first.text, 'turn-1')
  assert.equal(second.text, 'turn-2')
})

test('OpenClaw uses an authenticated loopback Gateway for pre-terminal ACP events', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-openclaw-acp-gateway-'))
  const workdir = path.join(directory, 'workspace')
  const gatewayProbeFile = path.join(directory, 'gateway.json')
  const healthProbeFile = path.join(directory, 'gateway-health.json')
  const acpProbeFile = path.join(directory, 'acp.json')
  const readyFile = path.join(directory, 'stream-ready')
  const releaseFile = path.join(directory, 'stream-release')
  const stoppedFile = path.join(directory, 'gateway-stopped')
  fs.mkdirSync(workdir)
  const cli = executable(directory, 'openclaw-acp-gateway.cjs', `
const fs = require('node:fs')
const readline = require('node:readline')
const args = process.argv.slice(2)
const token = process.env.OPENCLAW_GATEWAY_TOKEN || ''
const commandOffset = args[0] === '--no-color'
  && args[1] === '--log-level'
  && args[2] === 'info' ? 3 : 0
if (args[commandOffset] === 'gateway' && args[commandOffset + 1] === 'health') {
  fs.writeFileSync(${JSON.stringify(healthProbeFile)}, JSON.stringify({
    args, hasToken: token.length >= 32, tokenInArgs: Boolean(token && args.join(' ').includes(token)),
  }))
  process.stdout.write(JSON.stringify({ ok: true }))
  process.exit(0)
}
if (args[commandOffset] === 'gateway' && args[commandOffset + 1] === 'run') {
  fs.writeFileSync(${JSON.stringify(gatewayProbeFile)}, JSON.stringify({
    args, hasToken: token.length >= 32, tokenInArgs: Boolean(token && args.join(' ').includes(token)),
  }))
  process.stdout.write('[gateway] ready\\n')
  process.on('SIGTERM', () => {
    fs.writeFileSync(${JSON.stringify(stoppedFile)}, 'stopped')
    process.exit(0)
  })
  setInterval(() => {}, 1000)
  return
}
if (args[commandOffset] !== 'acp') {
  process.stdout.write(JSON.stringify({ payloads: [{ text: 'legacy fallback' }] }))
  process.exit(0)
}
fs.writeFileSync(${JSON.stringify(acpProbeFile)}, JSON.stringify({
  args, hasToken: token.length >= 32, tokenInArgs: Boolean(token && args.join(' ').includes(token)),
}))
const input = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
const update = (sessionId, value) => send({
  jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value },
})
input.on('line', (line) => {
  const message = JSON.parse(line)
  const sessionId = message.params?.sessionId || 'openclaw-acp-session'
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId } })
  } else if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    update(sessionId, {
      sessionUpdate: 'tool_call', toolCallId: 'openclaw-tool', title: 'read',
      kind: 'read', status: 'in_progress', rawInput: { path: '/private/path' },
    })
    update(sessionId, {
      sessionUpdate: 'tool_call_update', toolCallId: 'openclaw-tool', title: 'read',
      kind: 'read', status: 'in_progress', rawOutput: { lines: 1 },
    })
    update(sessionId, {
      sessionUpdate: 'tool_call_update', toolCallId: 'openclaw-tool', title: 'read',
      kind: 'read', status: 'completed', rawOutput: { lines: 1 },
    })
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OpenClaw ' },
    })
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'stream' },
    })
    fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready')
    const finish = () => {
      if (!fs.existsSync(${JSON.stringify(releaseFile)})) return setTimeout(finish, 10)
      send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
    }
    finish()
  }
})
`)
  let resultPromise
  t.after(async () => {
    await adapters.shutdownAcpSessionRuntime?.()
    await resultPromise?.catch(() => {})
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const stableSessionRef = 'agent:main:desktop-meldwork-openclaw-acp'
  const spec = adapters.invocation('openclaw', cli, workdir, stableSessionRef)
  assert.equal(spec.eventTransport, 'acp')

  const runtime = openClawAdapterRuntime(directory, workdir, stableSessionRef)
  const events = []
  let receivedStream
  const streamReceived = new Promise(resolve => { receivedStream = resolve })
  let resolved = false
  resultPromise = adapters.runAgent(
    { kind: 'openclaw', executable: cli, name: 'OpenClaw' },
    'hello',
    workdir,
    {
      ...runtime,
      sessionRef: stableSessionRef,
      onEvent: event => {
        events.push(event)
        if (events.length === 5) receivedStream()
      },
    },
  ).then((result) => {
    resolved = true
    return result
  })

  await within(readWhenReady(readyFile))
  // The child's file write does not guarantee the parent has consumed stdout.
  await within(streamReceived)
  assert.equal(resolved, false)
  assert.deepEqual(events.map(event => event.type), [
    'tool_start', 'tool_update', 'tool_result_summary',
    'answer_delta', 'answer_delta',
  ])
  fs.writeFileSync(releaseFile, 'release')
  const result = await resultPromise

  assert.deepEqual(result, {
    text: 'OpenClaw stream', sessionRef: stableSessionRef, outcome: 'completed',
  })
  assert.equal(events.some(event => event.title === 'connector_limited'), false)
  const gatewayProbe = await readJsonWhenReady(gatewayProbeFile)
  const healthProbe = await readJsonWhenReady(healthProbeFile)
  const acpProbe = await readJsonWhenReady(acpProbeFile)
  assert.equal(gatewayProbe.hasToken, true)
  assert.equal(gatewayProbe.tokenInArgs, false)
  assert.deepEqual(gatewayProbe.args.slice(0, 5), [
    '--no-color', '--log-level', 'info', 'gateway', 'run',
  ])
  assert.equal(gatewayProbe.args.includes('loopback'), true)
  const gatewayPort = gatewayProbe.args[gatewayProbe.args.indexOf('--port') + 1]
  assert.equal(healthProbe.hasToken, true)
  assert.equal(healthProbe.tokenInArgs, false)
  assert.deepEqual(healthProbe.args, [
    '--no-color', '--log-level', 'info', 'gateway', 'health',
    '--port', gatewayPort,
    '--timeout', '5000',
    '--json',
  ])
  assert.equal(acpProbe.hasToken, true)
  assert.equal(acpProbe.tokenInArgs, false)
  assert.deepEqual(acpProbe.args.slice(0, 4), [
    '--no-color', '--log-level', 'info', 'acp',
  ])
  assert.equal(acpProbe.args.includes('--session'), true)
  assert.equal(acpProbe.args.includes(stableSessionRef), true)
  assert.equal(acpProbe.args.includes('--no-prefix-cwd'), true)
  const config = JSON.parse(fs.readFileSync(runtime.env.OPENCLAW_CONFIG_PATH, 'utf8'))
  assert.equal(Number.isInteger(config.gateway.port), true)
  assert.equal(config.gateway.port > 0 && config.gateway.port <= 65535, true)
  assert.equal(config.discovery.mdns.mode, 'off')
  assert.equal(config.discovery.wideArea.enabled, false)
  assert.equal(config.update.checkOnStart, false)
  assert.equal(config.logging.file.startsWith(runtime.env.OPENCLAW_STATE_DIR), true)
  await readWhenReady(stoppedFile)
})

test('shutdown closes an active disposable OpenClaw ACP runtime and Gateway without a release file', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-openclaw-acp-shutdown-'))
  const workdir = path.join(directory, 'workspace')
  const readyFile = path.join(directory, 'acp-ready')
  const acpStoppedFile = path.join(directory, 'acp-stopped')
  const gatewayStoppedFile = path.join(directory, 'gateway-stopped')
  const releaseFile = path.join(directory, 'release')
  fs.mkdirSync(workdir)
  const cli = executable(directory, 'openclaw-acp-shutdown.cjs', `
const fs = require('node:fs')
const readline = require('node:readline')
const args = process.argv.slice(2)
const commandOffset = args[0] === '--no-color'
  && args[1] === '--log-level'
  && args[2] === 'info' ? 3 : 0
if (args[commandOffset] === 'gateway' && args[commandOffset + 1] === 'health') {
  process.stdout.write(JSON.stringify({ ok: true }))
  process.exit(0)
}
if (args[commandOffset] === 'gateway' && args[commandOffset + 1] === 'run') {
  process.stdout.write('[gateway] ready\\n')
  process.on('SIGTERM', () => {
    fs.writeFileSync(${JSON.stringify(gatewayStoppedFile)}, 'stopped')
    process.exit(0)
  })
  setInterval(() => {}, 1000)
  return
}
const input = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
input.on('close', () => {
  fs.writeFileSync(${JSON.stringify(acpStoppedFile)}, 'stopped')
  process.exit(0)
})
input.on('line', (line) => {
  const message = JSON.parse(line)
  const sessionId = message.params?.sessionId || 'openclaw-shutdown-session'
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId } })
  } else if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready')
    const finish = () => {
      if (!fs.existsSync(${JSON.stringify(releaseFile)})) return setTimeout(finish, 10)
      send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
    }
    finish()
  }
})
`)
  let settled = false
  const runtime = openClawAdapterRuntime(directory, workdir)
  const resultPromise = adapters.runAgent(
    { kind: 'openclaw', executable: cli, name: 'OpenClaw' },
    'hold until shutdown',
    workdir,
    runtime,
  ).then(
    value => { settled = true; return value },
    error => { settled = true; throw error },
  )
  t.after(async () => {
    const shutdown = adapters.shutdownAcpSessionRuntime?.()
    try {
      await within(shutdown)
      await within(resultPromise.catch(() => {}))
    } catch {
      if (!settled) fs.writeFileSync(releaseFile, 'release')
      await within(shutdown.catch(() => {}))
      await within(resultPromise.catch(() => {}))
    }
    fs.rmSync(directory, { recursive: true, force: true })
  })

  await within(readWhenReady(readyFile))
  await within(adapters.shutdownAcpSessionRuntime())

  await assert.rejects(
    () => within(resultPromise),
    error => error?.message === 'LOCAL_AGENT_EXECUTION_STOPPED',
  )
  assert.equal(fs.existsSync(releaseFile), false)
  assert.equal(await within(readWhenReady(acpStoppedFile)), 'stopped')
  assert.equal(await within(readWhenReady(gatewayStoppedFile)), 'stopped')
})

test('shutdown closes a Gateway held before readiness without spawning ACP', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-openclaw-gateway-shutdown-'))
  const workdir = path.join(directory, 'workspace')
  const gatewayStartedFile = path.join(directory, 'gateway-started')
  const gatewayStoppedFile = path.join(directory, 'gateway-stopped')
  const acpSpawnedFile = path.join(directory, 'acp-spawned')
  const releaseFile = path.join(directory, 'release')
  fs.mkdirSync(workdir)
  const cli = executable(directory, 'openclaw-gateway-shutdown.cjs', `
const fs = require('node:fs')
const readline = require('node:readline')
const args = process.argv.slice(2)
const commandOffset = args[0] === '--no-color'
  && args[1] === '--log-level'
  && args[2] === 'info' ? 3 : 0
if (args[commandOffset] === 'gateway' && args[commandOffset + 1] === 'health') {
  process.stdout.write(JSON.stringify({ ok: true }))
  process.exit(0)
}
if (args[commandOffset] === 'gateway' && args[commandOffset + 1] === 'run') {
  fs.writeFileSync(${JSON.stringify(gatewayStartedFile)}, 'started')
  process.on('SIGTERM', () => {
    fs.writeFileSync(${JSON.stringify(gatewayStoppedFile)}, 'stopped')
    process.exit(0)
  })
  const ready = () => {
    if (!fs.existsSync(${JSON.stringify(releaseFile)})) return setTimeout(ready, 10)
    process.stdout.write('[gateway] ready\\n')
  }
  ready()
  return
}
fs.writeFileSync(${JSON.stringify(acpSpawnedFile)}, 'spawned')
const input = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
input.on('line', (line) => {
  const message = JSON.parse(line)
  const sessionId = message.params?.sessionId || 'gateway-shutdown-session'
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId } })
  } else if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
  }
})
`)
  let settled = false
  const runtime = openClawAdapterRuntime(directory, workdir)
  const resultPromise = adapters.runAgent(
    { kind: 'openclaw', executable: cli, name: 'OpenClaw' },
    'stop during Gateway readiness',
    workdir,
    runtime,
  ).then(
    value => { settled = true; return value },
    error => { settled = true; throw error },
  )
  t.after(async () => {
    const shutdown = adapters.shutdownAcpSessionRuntime?.()
    try {
      await within(shutdown)
      await within(resultPromise.catch(() => {}))
    } catch {
      if (!settled) fs.writeFileSync(releaseFile, 'release')
      await within(shutdown.catch(() => {}))
      await within(resultPromise.catch(() => {}))
    }
    fs.rmSync(directory, { recursive: true, force: true })
  })

  await within(readWhenReady(gatewayStartedFile))
  await within(adapters.shutdownAcpSessionRuntime())

  assert.equal(fs.existsSync(gatewayStoppedFile), true)
  await assert.rejects(
    () => within(resultPromise),
    error => error?.message === 'LOCAL_AGENT_EXECUTION_STOPPED',
  )
  assert.equal(fs.existsSync(acpSpawnedFile), false)
  assert.equal(await within(readWhenReady(gatewayStoppedFile)), 'stopped')
})

test('shutdown closes a Gateway and held health child without spawning ACP', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-openclaw-gateway-health-shutdown-'))
  const workdir = path.join(directory, 'workspace')
  const healthStartedFile = path.join(directory, 'health-started')
  const healthStoppedFile = path.join(directory, 'health-stopped')
  const gatewayStoppedFile = path.join(directory, 'gateway-stopped')
  const acpSpawnedFile = path.join(directory, 'acp-spawned')
  const releaseFile = path.join(directory, 'release')
  fs.mkdirSync(workdir)
  const cli = executable(directory, 'openclaw-gateway-health-shutdown.cjs', `
const fs = require('node:fs')
const readline = require('node:readline')
const args = process.argv.slice(2)
const commandOffset = args[0] === '--no-color'
  && args[1] === '--log-level'
  && args[2] === 'info' ? 3 : 0
if (args[commandOffset] === 'gateway' && args[commandOffset + 1] === 'health') {
  fs.writeFileSync(${JSON.stringify(healthStartedFile)}, 'started')
  process.on('SIGTERM', () => {
    fs.writeFileSync(${JSON.stringify(healthStoppedFile)}, 'stopped')
    process.exit(0)
  })
  const finish = () => {
    if (!fs.existsSync(${JSON.stringify(releaseFile)})) return setTimeout(finish, 10)
    process.stdout.write(JSON.stringify({ ok: true }))
    process.exit(0)
  }
  finish()
  return
}
if (args[commandOffset] === 'gateway' && args[commandOffset + 1] === 'run') {
  process.stdout.write('[gateway] ready\\n')
  process.on('SIGTERM', () => {
    fs.writeFileSync(${JSON.stringify(gatewayStoppedFile)}, 'stopped')
    process.exit(0)
  })
  setInterval(() => {}, 1000)
  return
}
fs.writeFileSync(${JSON.stringify(acpSpawnedFile)}, 'spawned')
const input = readline.createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
input.on('line', (line) => {
  const message = JSON.parse(line)
  const sessionId = message.params?.sessionId || 'gateway-health-shutdown-session'
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId } })
  } else if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else if (message.method === 'session/prompt') {
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
  }
})
`)
  let settled = false
  const runtime = openClawAdapterRuntime(directory, workdir)
  const resultPromise = adapters.runAgent(
    { kind: 'openclaw', executable: cli, name: 'OpenClaw' },
    'stop during Gateway health',
    workdir,
    runtime,
  ).then(
    value => { settled = true; return value },
    error => { settled = true; throw error },
  )
  t.after(async () => {
    const shutdown = adapters.shutdownAcpSessionRuntime?.()
    try {
      await within(shutdown)
      await within(resultPromise.catch(() => {}))
    } catch {
      if (!settled) fs.writeFileSync(releaseFile, 'release')
      await within(shutdown.catch(() => {}))
      await within(resultPromise.catch(() => {}))
    }
    fs.rmSync(directory, { recursive: true, force: true })
  })

  await within(readWhenReady(healthStartedFile))
  await within(adapters.shutdownAcpSessionRuntime())

  assert.equal(fs.existsSync(healthStoppedFile), true)
  assert.equal(fs.existsSync(gatewayStoppedFile), true)
  assert.equal(fs.existsSync(acpSpawnedFile), false)
  await assert.rejects(
    () => within(resultPromise),
    error => error?.message === 'LOCAL_AGENT_EXECUTION_STOPPED',
  )
})

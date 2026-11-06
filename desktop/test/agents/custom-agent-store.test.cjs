const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { PassThrough } = require('node:stream')
const customAgentStoreApi = require('../../src/agents/custom-agent-store.cjs')
const { CustomAgentStore } = customAgentStoreApi

const OUTBOUND_PAYLOAD_KEYS = [
  'prompt',
  'promptMode',
  'serialization',
  'transport',
  'wirePayloadBytes',
  'wirePayloadHash',
]

function wireFingerprint(value) {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8')
  return {
    wirePayloadHash: crypto.createHash('sha256').update(bytes).digest('hex'),
    wirePayloadBytes: bytes.length,
  }
}

test('custom Agent store keeps its public facade stable', () => {
  assert.deepEqual(Object.keys(customAgentStoreApi), [
    'CUSTOM_AGENT_KIND',
    'CustomAgentStore',
    'childEnvironment',
    'executablePath',
    'isCustomAgentKind',
  ])
})

test('custom Agent environment preserves network settings without unrelated credentials', () => {
  const env = customAgentStoreApi.childEnvironment({
    HOME: '/home/example', HTTP_PROXY: 'http://127.0.0.1:3128',
    https_proxy: 'http://127.0.0.1:3129', NO_PROXY: 'localhost',
    REQUESTS_CA_BUNDLE: '/tmp/ca.pem', CURL_CA_BUNDLE: '/tmp/ca.pem',
    NODE_USE_ENV_PROXY: '1', UNRELATED_API_KEY: 'private',
  }, 'linux')
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:3128')
  assert.equal(env.https_proxy, 'http://127.0.0.1:3129')
  assert.equal(env.NO_PROXY, 'localhost')
  assert.equal(env.REQUESTS_CA_BUNDLE, '/tmp/ca.pem')
  assert.equal(env.CURL_CA_BUNDLE, '/tmp/ca.pem')
  assert.equal(env.NODE_USE_ENV_PROXY, '1')
  assert.equal(env.UNRELATED_API_KEY, undefined)
  assert.equal(customAgentStoreApi.childEnvironment({ Http_Proxy: 'http://proxy' }, 'win32').HTTP_PROXY, 'http://proxy')
  assert.equal(customAgentStoreApi.childEnvironment({ Path: 'old', PATH: 'new' }, 'win32').PATH, 'new')
})

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-custom-agent-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const executable = path.join(directory, 'review-agent')
  fs.writeFileSync(executable, '#!/bin/sh\nprintf "review-agent 1.0.0\\n"\n', { mode: 0o700 })
  fs.chmodSync(executable, 0o700)
  const store = new CustomAgentStore({
    storagePath: path.join(directory, 'custom-agents.json'),
    createId: () => options.id || '0123456789abcdef',
    execFileFn: options.execFileFn || (async () => ({ stdout: 'review-agent 1.0.0\n', stderr: '' })),
    environment: options.environment,
    now: () => '2026-08-03T00:00:00.000Z',
  })
  return { directory, executable, store }
}

test('custom Agent probe and execution both receive the configured proxy', async t => {
  const previous = process.env.HTTP_PROXY
  t.after(() => {
    if (previous === undefined) delete process.env.HTTP_PROXY
    else process.env.HTTP_PROXY = previous
  })
  process.env.HTTP_PROXY = 'http://127.0.0.1:3128'
  let probeEnv
  const { executable, store } = fixture(t, {
    execFileFn: async (_command, _args, options) => {
      probeEnv = options.env
      return { stdout: 'review-agent 1.0.0', stderr: '' }
    },
  })
  store.create({ label: 'Review Agent', args: [], promptMode: 'stdin' }, executable)
  await store.detectAgents()
  let runEnv
  await store.run('custom-0123456789abcdef', 'Review', '/tmp', {
    sandbox: 'workspace-write',
    spawnFn: (_command, _args, options) => {
      runEnv = options.env
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.stdin = new PassThrough()
      child.kill = () => true
      setImmediate(() => { child.stdout.write('Done'); child.emit('close', 0) })
      return child
    },
  })
  assert.equal(probeEnv.HTTP_PROXY, process.env.HTTP_PROXY)
  assert.equal(runEnv.HTTP_PROXY, process.env.HTTP_PROXY)
})

test('custom Agent probe and execution inherit filtered login shell settings', async t => {
  let probeEnv
  const { executable, store } = fixture(t, {
    environment: async () => ({ HTTP_PROXY: 'http://shell-proxy:3128', XDG_CONFIG_HOME: '/shell/config', PRIVATE_TOKEN: 'secret' }),
    execFileFn: async (_command, _args, options) => {
      probeEnv = options.env
      return { stdout: 'review-agent 1.0.0', stderr: '' }
    },
  })
  store.create({ label: 'Review Agent', args: [], promptMode: 'stdin' }, executable)
  await store.detectAgents()
  let runEnv
  await store.run('custom-0123456789abcdef', 'Review', '/tmp', {
    sandbox: 'workspace-write',
    spawnFn: (_command, _args, options) => {
      runEnv = options.env
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.stdin = new PassThrough()
      child.kill = () => true
      setImmediate(() => { child.stdout.write('Done'); child.emit('close', 0) })
      return child
    },
  })
  for (const env of [probeEnv, runEnv]) {
    assert.equal(env.HTTP_PROXY, 'http://shell-proxy:3128')
    assert.equal(env.XDG_CONFIG_HOME, '/shell/config')
    assert.equal(env.PRIVATE_TOKEN, undefined)
  }
})

test('stores private definitions while exposing only sanitized Custom Agent metadata', async (t) => {
  const { directory, executable, store } = fixture(t)
  const profile = store.create({
    label: 'Review Agent',
    description: 'Reviews the current repository.',
    args: ['review', '--format=text'],
    promptMode: 'stdin',
  }, executable)

  assert.equal(profile.kind, 'custom-0123456789abcdef')
  assert.equal(profile.commandName, 'review-agent')
  assert.equal(profile.custom, true)
  assert.equal(profile.installed, true)
  assert.equal('executable' in profile, false)
  assert.equal('args' in profile, false)

  const storagePath = path.join(directory, 'custom-agents.json')
  const persisted = JSON.parse(fs.readFileSync(storagePath, 'utf8'))
  assert.equal(persisted.agents[0].executable, fs.realpathSync(executable))
  assert.deepEqual(persisted.agents[0].args, ['review', '--format=text'])
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(storagePath).mode & 0o777, 0o600)
  }

  const detected = await store.detectAgents()
  assert.equal(detected[0].version, 'review-agent 1.0.0')
  assert.equal(detected[0].executable, fs.realpathSync(executable))
  const catalog = await store.catalog()
  assert.equal(catalog[0].version, 'review-agent 1.0.0')
  assert.equal('executable' in catalog[0], false)
  assert.equal('args' in catalog[0], false)
})

test('custom Agent changes durably replace the private configuration', t => {
  const { directory, executable, store } = fixture(t)
  const file = path.join(directory, 'custom-agents.json')
  const original = fs.fsyncSync
  const synced = []
  fs.fsyncSync = fd => { synced.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file'); return original(fd) }
  t.after(() => { fs.fsyncSync = original })
  const profile = store.create({ label: 'Review Agent', args: [], promptMode: 'stdin' }, executable)
  store.remove(profile.kind)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).agents, [])
  assert.equal(synced.filter(kind => kind === 'file').length, 2)
  if (process.platform !== 'win32') assert.equal(synced.filter(kind => kind === 'directory').length, 2)
  assert.equal(fs.readdirSync(directory).some(name => name.endsWith('.tmp')), false)
})

test('a failed custom Agent configuration replacement preserves the previous file', t => {
  const { directory, executable, store } = fixture(t)
  const file = path.join(directory, 'custom-agents.json')
  const profile = store.create({ label: 'Review Agent', args: [], promptMode: 'stdin' }, executable)
  const before = fs.readFileSync(file, 'utf8')
  const rename = fs.renameSync
  fs.renameSync = () => { throw new Error('REPLACE_FAILED') }
  t.after(() => { fs.renameSync = rename })
  assert.throws(() => store.remove(profile.kind), { message: 'REPLACE_FAILED' })
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  assert.equal(store.has(profile.kind), true)
  assert.equal(fs.readdirSync(directory).some(name => name.endsWith('.tmp')), false)
})

test('custom Agent memory follows the renamed file when directory sync fails', t => {
  if (process.platform === 'win32') return t.skip('directory handles are not portable on Windows')
  const { directory, executable, store } = fixture(t)
  const file = path.join(directory, 'custom-agents.json')
  const profile = store.create({ label: 'Review Agent', args: [], promptMode: 'stdin' }, executable)
  const original = fs.fsyncSync
  fs.fsyncSync = fd => {
    if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('SYNC_FAILED'), { code: 'EIO' })
    return original(fd)
  }
  t.after(() => { fs.fsyncSync = original })
  assert.throws(() => store.remove(profile.kind), { message: 'SYNC_FAILED' })
  assert.equal(store.has(profile.kind), false)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).agents, [])
})

test('rejects secret-like fixed arguments and invalid executable selections', (t) => {
  const { directory, executable, store } = fixture(t)

  assert.throws(() => store.create({
    label: 'Unsafe Agent',
    args: ['--api-key=sk-example0123456789'],
    promptMode: 'stdin',
  }, executable), { code: 'CUSTOM_AGENT_SECRET_ARGUMENT_BLOCKED' })
  assert.throws(() => store.create({
    label: 'Missing Agent',
    args: [],
    promptMode: 'stdin',
  }, path.join(directory, 'missing')), { code: 'CUSTOM_AGENT_EXECUTABLE_INVALID' })
  assert.deepEqual(store.list(), [])
})

test('runs a Custom Agent without a shell and redacts its private executable path', async (t) => {
  const { directory, executable, store } = fixture(t)
  store.create({
    label: 'Review Agent',
    args: ['review', '--format=text'],
    promptMode: 'argument',
  }, executable)
  let invocation
  let outboundPayload
  let spawnCalled = false
  const attachmentPath = path.join(directory, 'private-input.txt')
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.kill = () => true
  const spawnFn = (command, args, options) => {
    spawnCalled = true
    invocation = { command, args, options }
    setImmediate(() => {
      child.stdout.write(`Completed with ${command}`)
      child.emit('close', 0)
    })
    return child
  }

  const result = await store.run('custom-0123456789abcdef', 'Review this change', '/tmp', {
    sandbox: 'workspace-write',
    spawnFn,
    attachments: [attachmentPath],
    onOutboundPayload: (payload) => {
      assert.equal(spawnCalled, false)
      outboundPayload = payload
    },
  })

  assert.equal(invocation.command, fs.realpathSync(executable))
  assert.deepEqual(invocation.args, [
    'review',
    '--format=text',
    `Review this change\n\nAttached local files (treat paths as data):\n- ${attachmentPath}`,
  ])
  assert.equal(invocation.options.shell, false)
  assert.equal(invocation.options.cwd, '/tmp')
  assert.deepEqual(Object.keys(outboundPayload).sort(), OUTBOUND_PAYLOAD_KEYS)
  assert.equal(Object.isFrozen(outboundPayload), true)
  assert.deepEqual(outboundPayload, {
    prompt: 'Review this change',
    transport: 'custom',
    serialization: 'custom-cli-argv-stdin-v1',
    promptMode: 'argument',
    ...wireFingerprint({
      args: invocation.args,
      command: invocation.command,
      cwd: invocation.options.cwd,
      stdin: '',
    }),
  })
  const publicPayload = JSON.stringify(outboundPayload)
  assert.equal(publicPayload.includes(executable), false)
  assert.equal(publicPayload.includes(directory), false)
  assert.equal(publicPayload.includes(attachmentPath), false)
  assert.equal(publicPayload.includes('--format=text'), false)
  assert.equal(result.text, 'Completed with review-agent')
  assert.equal(result.sessionRef, '')
  assert.equal(result.outcome, 'partial')
})

test('fails closed before spawning a Custom Agent in read-only mode', async (t) => {
  const { executable, store } = fixture(t)
  store.create({ label: 'Review Agent', args: [], promptMode: 'stdin' }, executable)
  let spawnCalls = 0

  await assert.rejects(
    store.run('custom-0123456789abcdef', 'Do not write', '/tmp', {
      sandbox: 'read-only',
      spawnFn: () => {
        spawnCalls += 1
        throw new Error('process must not spawn')
      },
    }),
    { code: 'CUSTOM_AGENT_READ_ONLY_UNSUPPORTED' },
  )
  assert.equal(spawnCalls, 0)
})

test('captures the exact Custom Agent stdin before process spawn', async (t) => {
  const { directory, executable, store } = fixture(t)
  store.create({
    label: 'Review Agent',
    args: ['review'],
    promptMode: 'stdin',
  }, executable)
  let invocation
  let outboundPayload
  let spawnCalled = false
  let deliveredStdin = ''
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.stdin.setEncoding('utf8')
  child.stdin.on('data', chunk => { deliveredStdin += chunk })
  child.stdin.on('finish', () => {
    setImmediate(() => {
      child.stdout.end('stdin completed')
      child.emit('close', 0)
    })
  })
  child.kill = () => true

  const result = await store.run(
    'custom-0123456789abcdef',
    'Review stdin payload',
    directory,
    {
      sandbox: 'workspace-write',
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

  assert.equal(deliveredStdin, 'Review stdin payload')
  assert.deepEqual(outboundPayload, {
    prompt: 'Review stdin payload',
    transport: 'custom',
    serialization: 'custom-cli-argv-stdin-v1',
    promptMode: 'stdin',
    ...wireFingerprint({
      args: invocation.args,
      command: invocation.command,
      cwd: invocation.options.cwd,
      stdin: deliveredStdin,
    }),
  })
  assert.equal(result.text, 'stdin completed')
})

test('Custom Agent outbound callback failure prevents process spawn', async (t) => {
  const { executable, store } = fixture(t)
  store.create({ label: 'Review Agent', args: [], promptMode: 'stdin' }, executable)
  const callbackError = new Error('Custom Agent outbound payload capture failed')
  let spawnCalls = 0

  await assert.rejects(
    store.run('custom-0123456789abcdef', 'must not be delivered', '/tmp', {
      sandbox: 'workspace-write',
      spawnFn: () => {
        spawnCalls += 1
        throw new Error('process must not spawn')
      },
      onOutboundPayload: async () => { throw callbackError },
    }),
    error => error === callbackError,
  )
  assert.equal(spawnCalls, 0)
})

test('cancels the Custom Agent process through the shared AbortSignal', async (t) => {
  const { executable, store } = fixture(t)
  store.create({ label: 'Review Agent', args: [], promptMode: 'stdin' }, executable)
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.kill = () => {
    setImmediate(() => child.emit('close', null))
    return true
  }
  const controller = new AbortController()
  const run = store.run('custom-0123456789abcdef', 'Review this change', '/tmp', {
    sandbox: 'workspace-write',
    signal: controller.signal,
    spawnFn: () => child,
  })
  controller.abort()

  await assert.rejects(run, { code: 'LOCAL_AGENT_EXECUTION_STOPPED' })
})

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const {
  discoverAgents,
  createServer,
  AGENT_DEFINITIONS,
  invocationFor,
  listSkills,
  parentSessionDetached,
  parseAgentOutput,
  runAgent,
} = require('../../../src/agents/cloud/cloud-agent-bridge-server.cjs')
const { AGENT_PROFILES } = require('../../../src/agents/cli/cli-discovery.cjs')

test('remote discovery covers every built-in Agent profile and command alias', () => {
  assert.deepEqual(new Set(AGENT_DEFINITIONS.map(agent => agent.id)), new Set(Object.keys(AGENT_PROFILES)))
  for (const definition of AGENT_DEFINITIONS) {
    assert.deepEqual(definition.commands || [definition.id], AGENT_PROFILES[definition.id].commands)
  }
})

test('remote Skill discovery follows each CLI native configuration directory', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-remote-skills-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const entries = [
    ['custom-codex', 'skills', 'codex-new'], ['.codex', 'skills', 'codex-old'],
    ['custom-hermes', 'skills', 'hermes-new'], ['.hermes', 'skills', 'hermes-old'],
    ['custom-claude', 'skills', 'claude-new'], ['.claude', 'skills', 'claude-old'],
    ['xdg', 'opencode', 'skill', 'opencode-new'], ['.agents', 'skills', 'shared'],
  ]
  for (const parts of entries) fs.mkdirSync(path.join(home, ...parts), { recursive: true })
  const env = { CODEX_HOME: '~/custom-codex', HERMES_HOME: 'custom-hermes',
    CLAUDE_CONFIG_DIR: path.join(home, 'custom-claude'), XDG_CONFIG_HOME: path.join(home, 'xdg') }
  for (const [kind, expected] of [
    ['codex', ['codex-new', 'shared']], ['hermes', ['hermes-new', 'shared']],
    ['claude', ['claude-new', 'shared']], ['opencode', ['opencode-new']],
  ]) {
    const result = listSkills(kind, { home, env })
    assert.deepEqual(result.map(skill => skill.slug), expected)
    assert.doesNotMatch(JSON.stringify(result), new RegExp(home))
  }
})

test('detects a Bridge parent process detached from its SSH session', () => {
  assert.equal(parentSessionDetached(123, () => '123 (node) S 456 0 0 0'), false)
  assert.equal(parentSessionDetached(123, () => '123 (node) S 1 0 0 0'), true)
  assert.equal(parentSessionDetached(123, () => { throw new Error('gone') }), true)
})

test('starts the Bridge when the module is executed through node stdin', async () => {
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const selected = server.address().port
      server.close(error => error ? reject(error) : resolve(selected))
    })
  })
  const script = fs.readFileSync(
    require.resolve('../../../src/agents/cloud/cloud-agent-bridge-server.cjs'),
    'utf8',
  )
  const child = spawn(process.execPath, ['-'], {
    env: { ...process.env, MELDWORK_AGENT_BRIDGE_PORT: String(port) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  try {
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Bridge did not start')), 3000)
      child.once('error', reject)
      child.stdout.on('data', (chunk) => {
        if (!String(chunk).includes(`MELDWORK_AGENT_BRIDGE_READY ${port}`)) return
        clearTimeout(timer)
        resolve(true)
      })
    })
    child.stdin.end(script)
    assert.equal(await ready, true)
  } finally {
    child.kill('SIGTERM')
  }
})

test('discovers supported remote CLIs and keeps an unauthenticated CLI visible but unavailable', () => {
  const outputs = new Map([
    ['codex --version', { status: 0, stdout: 'codex-cli 0.146.1\n' }],
    ['codex login status', { status: 0, stdout: 'Logged in using an API key\n' }],
    ['hermes --version', { status: 0, stdout: 'Hermes Agent v0.19.1 (2026.7.30)\n' }],
    ['claude --version', { status: 0, stdout: '2.1.123 (Claude Code)\n' }],
    ['claude auth status', { status: 0, stdout: '{"loggedIn":false,"authMethod":"none"}\n' }],
  ])
  const agents = discoverAgents({
    spawnSync: (command, args) => outputs.get(`${command} ${args.join(' ')}`)
      || { status: 127, stdout: '' },
    listSkills: kind => kind === 'hermes'
      ? [{ namespace: 'hermes', slug: 'research', name: 'research' }]
      : [],
  })

  assert.deepEqual(agents.map(agent => [agent.id, agent.version, agent.available]), [
    ['codex', '0.146.1', true],
    ['hermes', '0.19.1', true],
    ['claude', '2.1.123', false],
  ])
  assert.deepEqual(agents[1].skills, [{ namespace: 'hermes', slug: 'research', name: 'research' }])
  assert.equal(agents[2].credentialState, 'missing')
})

test('discovers all supported CLI names and aliases without falsely advertising an execution adapter', () => {
  const versions = new Map([
    ['openclaw', '1.2.3'], ['codebuddy', '1.2.3'], ['zcode', '1.2.3'],
    ['pi-agent', '1.2.3'], ['kimi', '1.2.3'], ['mimo', '1.2.3'],
    ['gemini', '1.2.3'], ['opencode', '1.2.3'], ['qwen', '1.2.3'], ['ocr', '1.2.3'],
  ])
  const agents = discoverAgents({
    spawnSync: (name, args) => args[0] === '--version' && versions.has(name)
      ? { status: 0, stdout: versions.get(name) } : { status: 127, stdout: '' },
    listSkills: () => [],
  })
  assert.deepEqual(agents.map(agent => agent.id), [
    'openclaw', 'workbuddy', 'zcode', 'pi', 'kimi', 'mimo', 'gemini', 'opencode', 'qwen', 'opencodereview',
  ])
  const openCode = agents.find(agent => agent.id === 'opencode')
  assert.equal(openCode.available, true)
  assert.ok(agents.filter(agent => agent.id !== 'opencode').every(agent => !agent.available && agent.credentialState === 'unknown' && !agent.session.supported))
})

test('OpenCode uses plan mode and only accepts completed, non-error responses', () => {
  assert.deepEqual(invocationFor('opencode', 'hello', 'ses_123'), {
    command: 'opencode', args: ['run', '--format', 'json', '--agent', 'plan', '--session', 'ses_123', 'hello'], input: '',
  })
  const text = JSON.stringify({ type: 'text', sessionID: 'ses_123', part: { type: 'text', text: 'Answer' } })
  const tool = JSON.stringify({ type: 'step_finish', part: { reason: 'tool-calls' } })
  const stop = JSON.stringify({ type: 'step_finish', part: { reason: 'stop' } })
  assert.equal(parseAgentOutput('opencode', [text, tool].join('\n')), null)
  assert.deepEqual(parseAgentOutput('opencode', [text, tool, stop].join('\n')), {
    text: 'Answer', sessionRef: 'ses_123', outcome: 'completed',
  })
  assert.equal(parseAgentOutput('opencode', [text, stop, JSON.stringify({ type: 'error' })].join('\n')), null)
})

test('OpenCode returns a completed response even if the native process keeps running', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cloud-opencode-'))
  const originalPath = process.env.PATH
  const executable = path.join(directory, 'opencode')
  fs.writeFileSync(executable, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({type:'text',sessionID:'ses_test',part:{type:'text',text:'Done'}})+'\\n')\nprocess.stdout.write(JSON.stringify({type:'step_finish',part:{reason:'stop'}})+'\\n')\nsetInterval(()=>{}, 1000)\n`, { mode: 0o755 })
  process.env.PATH = `${directory}${path.delimiter}${originalPath}`
  try {
    const result = await runAgent('opencode', 'hello')
    assert.deepEqual(result, { text: 'Done', sessionRef: 'ses_test', outcome: 'completed' })
  } finally {
    process.env.PATH = originalPath
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('OpenCode does not report success when an error follows its terminal event', async t => {
  if (process.platform === 'win32') return t.skip('uses a POSIX executable fixture')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cloud-opencode-error-'))
  const originalPath = process.env.PATH
  const executable = path.join(directory, 'opencode')
  fs.writeFileSync(executable, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({type:'text',sessionID:'ses_test',part:{type:'text',text:'Done'}})+'\\n')\nprocess.stdout.write(JSON.stringify({type:'step_finish',part:{reason:'stop'}})+'\\n')\nsetTimeout(()=>process.stdout.write(JSON.stringify({type:'error'})+'\\n'), 30)\nsetInterval(()=>{}, 1000)\n`, { mode: 0o755 })
  process.env.PATH = `${directory}${path.delimiter}${originalPath}`
  try {
    const result = await runAgent('opencode', 'hello')
    assert.deepEqual(result, { outcome: 'failed', failure: { code: 'REMOTE_AGENT_RESPONSE_INVALID' } })
  } finally {
    process.env.PATH = originalPath
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('OpenCode does not report success when it exits nonzero after a terminal event', async t => {
  if (process.platform === 'win32') return t.skip('uses a POSIX executable fixture')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cloud-opencode-exit-'))
  const originalPath = process.env.PATH
  fs.writeFileSync(path.join(directory, 'opencode'), `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({type:'text',part:{type:'text',text:'Done'}})+'\\n')\nprocess.stdout.write(JSON.stringify({type:'step_finish',part:{reason:'stop'}})+'\\n')\nsetTimeout(()=>process.exit(1), 30)\n`, { mode: 0o755 })
  process.env.PATH = `${directory}${path.delimiter}${originalPath}`
  try {
    assert.deepEqual(await runAgent('opencode', 'hello'), { outcome: 'failed', failure: { code: 'REMOTE_AGENT_FAILED' } })
  } finally {
    process.env.PATH = originalPath
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('OpenCode does not report success when output exceeds the response limit', async t => {
  if (process.platform === 'win32') return t.skip('uses a POSIX executable fixture')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cloud-opencode-limit-'))
  const originalPath = process.env.PATH
  fs.writeFileSync(path.join(directory, 'opencode'), `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({type:'text',part:{type:'text',text:'Done'}})+'\\n')\nprocess.stdout.write(JSON.stringify({type:'step_finish',part:{reason:'stop'}})+'\\n')\nprocess.stdout.write('x'.repeat(300000))\nsetInterval(()=>{}, 1000)\n`, { mode: 0o755 })
  process.env.PATH = `${directory}${path.delimiter}${originalPath}`
  try {
    assert.deepEqual(await runAgent('opencode', 'hello'), { outcome: 'failed', failure: { code: 'REMOTE_AGENT_RESPONSE_INVALID' } })
  } finally {
    process.env.PATH = originalPath
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('remote replies preserve UTF-8 characters split across process output chunks', async t => {
  if (process.platform === 'win32') return t.skip('uses POSIX executable fixtures')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cloud-utf8-'))
  const originalPath = process.env.PATH
  const streams = {
    hermes: 'session_id: session-1\n你好，世界\n',
    codex: `${JSON.stringify({ type: 'thread.started', thread_id: 'session-1' })}\n${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '你好，世界' } })}\n${JSON.stringify({ type: 'turn.completed' })}\n`,
    opencode: `${JSON.stringify({ type: 'text', sessionID: 'session-1', part: { type: 'text', text: '你好，世界' } })}\n${JSON.stringify({ type: 'step_finish', part: { reason: 'stop' } })}\n`,
  }
  for (const [kind, stream] of Object.entries(streams)) {
    const script = `#!/usr/bin/env node\nconst bytes = Buffer.from(${JSON.stringify(stream)}, 'utf8')\nconst split = bytes.indexOf(Buffer.from('你')) + 1\nprocess.stdout.write(bytes.subarray(0, split))\nsetTimeout(() => process.stdout.end(bytes.subarray(split)), 30)\n`
    fs.writeFileSync(path.join(directory, kind), script, { mode: 0o755 })
  }
  process.env.PATH = `${directory}${path.delimiter}${originalPath}`
  try {
    for (const kind of Object.keys(streams)) {
      assert.deepEqual(await runAgent(kind, 'hello'), { text: '你好，世界', sessionRef: 'session-1', outcome: 'completed' })
    }
  } finally {
    process.env.PATH = originalPath
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('cancelling a remote Agent run terminates its native process', async t => {
  if (process.platform === 'win32') return t.skip('uses a POSIX executable fixture')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cloud-cancel-'))
  const originalPath = process.env.PATH
  const pidFile = path.join(directory, 'pid')
  fs.writeFileSync(path.join(directory, 'hermes'), `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 30\n`, { mode: 0o755 })
  process.env.PATH = `${directory}${path.delimiter}${originalPath}`
  const controller = new AbortController()
  try {
    const pending = runAgent('hermes', 'hello', '', controller.signal)
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(fs.existsSync(pidFile))
    const pid = Number(fs.readFileSync(pidFile, 'utf8'))
    controller.abort()
    assert.deepEqual(await pending, { outcome: 'cancelled' })
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  } finally {
    process.env.PATH = originalPath
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('disconnecting a Bridge request terminates the remote Agent process', async t => {
  if (process.platform === 'win32') return t.skip('uses a POSIX executable fixture')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-cloud-disconnect-'))
  const originalPath = process.env.PATH
  const pidFile = path.join(directory, 'pid')
  fs.writeFileSync(path.join(directory, 'hermes'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'Hermes 1.2.3'; exit; fi\necho $$ > '${pidFile}'\nexec sleep 30\n`, { mode: 0o755 })
  process.env.PATH = `${directory}${path.delimiter}${originalPath}`
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const request = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST',
      path: '/v1/agents/hermes/runs', headers: { 'content-type': 'application/json' } })
    request.on('error', () => {})
    request.end(JSON.stringify({ prompt: 'hello', permissionMode: 'read-only' }))
    for (let i = 0; i < 500 && !fs.existsSync(pidFile); i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(fs.existsSync(pidFile))
    const pid = Number(fs.readFileSync(pidFile, 'utf8'))
    request.destroy()
    let alive = true
    for (let i = 0; i < 200 && alive; i++) {
      try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error }
      if (alive) await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(alive, false)
  } finally {
    await new Promise(resolve => server.close(resolve))
    process.env.PATH = originalPath
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('builds read-only invocations and parses Hermes and Claude output', () => {
  assert.deepEqual(invocationFor('codex', 'hello', 'thread-1'), {
    command: 'codex',
    args: ['exec', 'resume', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', 'thread-1', '-'],
    input: 'hello',
  })
  assert.deepEqual(invocationFor('hermes', 'hello', ''), {
    command: 'hermes',
    args: ['chat', '--quiet', '--query', 'hello'],
    input: '',
  })
  assert.deepEqual(invocationFor('claude', 'hello', 'session-1'), {
    command: 'claude',
    args: [
      '--print', '--output-format', 'json', '--permission-mode', 'plan',
      '--resume', 'session-1', 'hello',
    ],
    input: '',
  })
  assert.deepEqual(parseAgentOutput('hermes', 'session_id: hermes-1\nremote answer\n'), {
    text: 'remote answer', sessionRef: 'hermes-1', outcome: 'completed',
  })
  assert.deepEqual(parseAgentOutput('codex', [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'codex answer' } }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n')), {
    text: 'codex answer', sessionRef: 'thread-1', outcome: 'completed',
  })
  assert.equal(parseAgentOutput('codex', JSON.stringify({ type: 'item.completed',
    item: { type: 'agent_message', text: 'incomplete answer' } })), null)
  assert.equal(parseAgentOutput('codex', [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'partial answer' } }),
    JSON.stringify({ type: 'turn.failed', error: { message: 'failed' } }),
  ].join('\n')), null)
  assert.deepEqual(parseAgentOutput('claude', JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    result: 'claude answer', session_id: 'claude-1',
  })), {
    text: 'claude answer', sessionRef: 'claude-1', outcome: 'completed',
  })
})

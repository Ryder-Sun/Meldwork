const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const https = require('node:https')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const {
  defaultVerifyNpmIntegrity,
  defaultVerifyScriptIntegrity,
  npmPackageSpec,
} = require('../../../src/agents/installer/agent-installer-contract.cjs')
const {
  AgentInstaller,
  defaultDownloadScript,
  defaultFindCommand,
  defaultRunProcess,
  installRecipe,
  prepareInstallCommand,
  validateScriptUrl,
} = require('../../../src/agents/installer/agent-installer.cjs')

function shellLiteral(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

test('catalog preserves an inconclusive timeout without hiding the installed CLI', async () => {
  const installer = new AgentInstaller({
    detectAgents: async () => [{
      kind: 'codex', compatibilityState: 'unknown',
      incompatibilityReason: 'LOCAL_AGENT_CAPABILITY_PROBE_TIMEOUT',
      incompatibilityProbe: 'codex-exec',
    }],
    findCommand: async () => '/usr/bin/npm',
  })
  const agent = (await installer.catalog()).agents.find(agent => agent.kind === 'codex')
  assert.equal(agent.installed, true)
  assert.equal(agent.compatibilityState, 'unknown')
  assert.equal(agent.incompatibilityReason, 'LOCAL_AGENT_CAPABILITY_PROBE_TIMEOUT')
  assert.equal(agent.incompatibilityProbe, 'codex-exec')
})

test('catalog exposes install versus update action and permits updating an older CLI', async () => {
  const service = installer({
    detectAgents: async () => [{ kind: 'pi', version: '0.80.0', compatibilityState: 'compatible' }],
    runProcess: async () => {},
  })
  const pi = (await service.catalog()).agents.find(agent => agent.kind === 'pi')
  assert.equal(pi.installed, true)
  assert.equal(pi.installAction, 'update')
  assert.equal(pi.targetVersion, '0.84.2')
  await service.start('pi')
  await service.waitForIdle()
  assert.equal(service.state().errorCode, 'INSTALL_AGENT_VERIFY_FAILED')
})

async function readWhenReady(filename, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const value = fs.readFileSync(filename, 'utf8')
      if (value) return value
    } catch {
      // Keep polling until the child creates the file.
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${filename}`)
}

async function within(promise, timeoutMs = 3000) {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Installer cancellation did not settle.')),
          timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

async function waitForExit(pid, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') return
      throw error
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Process ${pid} did not exit.`)
}

function installer(overrides = {}) {
  return new AgentInstaller({
    platform: 'darwin',
    detectAgents: async () => [],
    findCommand: async command => (command === 'npm' ? '/usr/local/bin/npm' : ''),
    downloadScript: async () => '/tmp/meldwork-installer/install.sh',
    removeDownload: async () => {},
    runProcess: async () => {},
    verifyNpmIntegrity: async () => {},
    verifyScriptIntegrity: async () => {},
    createId: () => 'task-1',
    ...overrides,
  })
}

function detectedRelease(kind, platform = 'darwin', executable = `/tmp/${kind}`) {
  const recipe = installRecipe(kind, platform)
  return {
    kind,
    executable,
    version: recipe.detectedVersion || recipe.version,
    compatibilityState: 'compatible',
  }
}

test('catalog reports installed and recommended Agents', async () => {
  const service = installer({
    detectAgents: async () => [
      {
        kind: 'workbuddy', version: '2.115.0', executable: '/tmp/codebuddy',
        resolvedVersion: '2.115.0', supportedVersionRange: '2.115.0..2.132.0',
        compatibilityState: 'compatible', incompatibilityReason: '', incompatibilityProbe: '',
      },
      {
        kind: 'kimi', version: '0.19.2', executable: '/tmp/kimi',
        resolvedVersion: '0.19.2', supportedVersionRange: '0.19.2..0.32.0',
        compatibilityState: 'compatible', incompatibilityReason: '', incompatibilityProbe: '',
      },
      {
        kind: 'pi', version: '', executable: '/tmp/pi',
        compatibilityState: 'incompatible',
        incompatibilityReason: 'LOCAL_AGENT_VERSION_UNSUPPORTED',
        incompatibilityProbe: '',
        resolvedVersion: '',
        supportedVersionRange: '0.1.0..0.1.999',
        privateMetadata: 'must-not-cross-ipc',
      },
    ],
  })

  const result = await service.catalog()
  assert.equal(result.platform, 'darwin')
  assert.deepEqual(result.agents.map(agent => agent.kind), [
    'codex', 'claude', 'hermes', 'workbuddy', 'openclaw', 'pi',
    'opencode', 'opencodereview', 'kimi', 'mimo', 'qwen',
  ])
  assert.equal(result.agents.find(agent => agent.kind === 'workbuddy').installed, true)
  assert.equal(result.agents.find(agent => agent.kind === 'hermes').recommended, true)
  assert.equal(result.agents.find(agent => agent.kind === 'pi').installed, true)
  assert.equal(result.agents.find(agent => agent.kind === 'pi').version, '')
  assert.deepEqual(
    Object.fromEntries(Object.entries(result.agents.find(agent => agent.kind === 'pi'))
      .filter(([key]) => [
        'resolvedVersion', 'supportedVersionRange', 'compatibilityState',
        'incompatibilityReason', 'incompatibilityProbe',
      ].includes(key))),
    {
      resolvedVersion: '',
      supportedVersionRange: '0.1.0..0.1.999',
      compatibilityState: 'incompatible',
      incompatibilityReason: 'LOCAL_AGENT_VERSION_UNSUPPORTED',
      incompatibilityProbe: '',
    },
  )
  assert.deepEqual(
    Object.fromEntries(Object.entries(result.agents.find(agent => agent.kind === 'claude'))
      .filter(([key]) => [
        'resolvedVersion', 'supportedVersionRange', 'compatibilityState',
        'incompatibilityReason', 'incompatibilityProbe',
      ].includes(key))),
    {
      resolvedVersion: '',
      supportedVersionRange: '',
      compatibilityState: 'unknown',
      incompatibilityReason: '',
      incompatibilityProbe: '',
    },
  )
  assert.equal(result.agents.find(agent => agent.kind === 'openclaw').installSupported, true)
  assert.equal(result.agents.find(agent => agent.kind === 'openclaw').installErrorCode, '')
  assert.equal(JSON.stringify(result).includes('/tmp/codebuddy'), false)
  assert.equal(JSON.stringify(result).includes('/tmp/kimi'), false)
  assert.equal(JSON.stringify(result).includes('must-not-cross-ipc'), false)
})

test('skills are listed only for a verified installed Agent', async () => {
  const listCalls = []
  const service = installer({
    detectAgents: async () => [
      {
        kind: 'codex', version: '0.137.0', executable: '/tmp/codex',
        compatibilityState: 'compatible',
      },
      {
        kind: 'hermes', version: '0.18.0', executable: '/tmp/hermes',
        compatibilityState: 'incompatible',
      },
    ],
    listSkills: kind => {
      listCalls.push(kind)
      return {
        supported: true,
        total: 1,
        limit: 100,
        skills: [{ targetKind: kind, namespace: 'global', slug: 'review', name: 'Review' }],
      }
    },
  })

  assert.deepEqual(await service.skills('codex'), {
    supported: true,
    total: 1,
    limit: 100,
    skills: [{ targetKind: 'codex', namespace: 'global', slug: 'review', name: 'Review' }],
  })
  assert.deepEqual(await service.skills('hermes'), {
    supported: false, total: 0, limit: 1000, skills: [],
  })
  assert.deepEqual(listCalls, ['codex'])
})

test('catalog lookups share in-flight and short-lived Agent detection', async () => {
  let detectCount = 0
  let now = 1000
  let resolveDetection
  const firstDetection = new Promise(resolve => { resolveDetection = resolve })
  const detected = [{ kind: 'hermes', version: '0.18.0', executable: '/tmp/hermes' }]
  const service = installer({
    now: () => now,
    detectAgents: async () => {
      detectCount += 1
      return detectCount === 1 ? firstDetection : detected
    },
  })

  const firstCatalog = service.catalog()
  const secondCatalog = service.catalog()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(detectCount, 1)
  resolveDetection(detected)

  const [firstResult, secondResult] = await Promise.all([firstCatalog, secondCatalog])
  assert.equal(firstResult.agents.find(agent => agent.kind === 'hermes').installed, true)
  assert.equal(secondResult.agents.find(agent => agent.kind === 'hermes').installed, true)

  await service.catalog()
  assert.equal(detectCount, 1)

  now += 30001
  await service.catalog()
  assert.equal(detectCount, 2)

  service.invalidateDetectionCache()
  await service.catalog()
  assert.equal(detectCount, 3)
})

test('cache invalidation does not let an older in-flight detection overwrite fresh results', async () => {
  const detections = []
  const service = installer({
    detectAgents: () => new Promise(resolve => detections.push(resolve)),
  })

  const staleCatalog = service.catalog()
  await new Promise(resolve => setImmediate(resolve))
  service.invalidateDetectionCache()
  const freshCatalog = service.catalog()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(detections.length, 2)

  detections[1]([{ kind: 'hermes', version: '0.18.0', executable: '/tmp/hermes' }])
  assert.equal((await freshCatalog).agents.find(agent => agent.kind === 'hermes').installed, true)
  detections[0]([])
  const retriedCatalog = await staleCatalog
  assert.equal(retriedCatalog.agents.find(agent => agent.kind === 'hermes').installed, true)

  assert.equal((await service.catalog()).agents.find(agent => agent.kind === 'hermes').installed, true)
  assert.equal(detections.length, 2)
})

test('recipes are fixed by Agent and platform', () => {
  const npmKinds = [
    'codex', 'claude', 'openclaw', 'qwen', 'workbuddy', 'gemini',
    'opencode', 'kimi', 'mimo', 'opencodereview', 'pi',
  ]
  for (const platform of ['darwin', 'win32']) {
    for (const kind of npmKinds) {
      const recipe = installRecipe(kind, platform)
      if (!recipe) continue
      assert.equal(recipe.type, 'npm', kind)
      assert.equal(npmPackageSpec(recipe), `${recipe.packageName}@${recipe.version}`, kind)
      assert.match(recipe.version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, kind)
      assert.match(recipe.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/, kind)
      assert.equal(npmPackageSpec(recipe).includes('@latest'), false, kind)
    }
  }
  const pi = installRecipe('pi', 'darwin')
  assert.equal(pi.packageName, '@earendil-works/pi-coding-agent')
  assert.equal(pi.version, '0.84.2')
  assert.equal(
    pi.integrity,
    'sha512-l4E+B7hgXKWddRo8bC/eSue2aWZjEgJ9xIpf5p0Og+lq8a2TArCwJ0HCoCPCgaBP/tN4zbYH/wOwvx9pJpeLCA==',
  )
  assert.deepEqual(installRecipe('pi', 'win32'), pi)
  const darwinHermes = installRecipe('hermes', 'darwin')
  const windowsHermes = installRecipe('hermes', 'win32')
  assert.equal(darwinHermes.type, 'script')
  assert.equal(darwinHermes.interpreter, '/bin/bash')
  assert.match(darwinHermes.url, /^https:\/\/raw\.githubusercontent\.com\/NousResearch\/hermes-agent\/[a-f0-9]{40}\/scripts\/install\.sh$/)
  assert.match(darwinHermes.sha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(darwinHermes.args.slice(0, 3), [
    '$SCRIPT', '--non-interactive', '--skip-setup',
  ])
  assert.equal(darwinHermes.args.at(-2), '--commit')
  assert.equal(darwinHermes.url.includes(darwinHermes.args.at(-1)), true)
  assert.equal(windowsHermes.type, 'script')
  assert.equal(windowsHermes.interpreter, 'powershell.exe')
  assert.match(windowsHermes.url, /^https:\/\/raw\.githubusercontent\.com\/NousResearch\/hermes-agent\/[a-f0-9]{40}\/scripts\/install\.ps1$/)
  assert.match(windowsHermes.sha256, /^[a-f0-9]{64}$/)
  assert.equal(windowsHermes.args.at(-2), '-Commit')
  assert.equal(windowsHermes.url.includes(windowsHermes.args.at(-1)), true)
  assert.equal(installRecipe('hermes', 'linux'), null)
})

test('Pi installation disables package scripts and verifies the detected release', async () => {
  const recipe = installRecipe('pi', 'darwin')
  const calls = []
  let detectCount = 0
  const service = installer({
    detectAgents: async () => {
      detectCount += 1
      return detectCount > 1 ? [detectedRelease('pi')] : []
    },
    runProcess: async (...args) => { calls.push(args) },
  })

  await service.start('pi')
  await service.waitForIdle()

  assert.deepEqual(calls[0].slice(0, 2), [
    '/usr/local/bin/npm',
    [
      'install', '--global', '--ignore-scripts', npmPackageSpec(recipe),
      '--registry', 'https://registry.npmjs.org/',
    ],
  ])
  assert.equal(service.state().phase, 'completed')
})

test('npm lookup uses the enhanced Finder-safe search path', async () => {
  const result = await defaultFindCommand('npm', 'darwin', {
    home: '/Users/Ryder',
    env: { PATH: '/usr/bin:/bin' },
    execFileFn: async (command, args, options) => {
      assert.equal(command, '/usr/bin/which')
      assert.deepEqual(args, ['npm'])
      assert.ok(options.env.PATH.split(':').includes('/Users/Ryder/.volta/bin'))
      return { stdout: '/Users/Ryder/.volta/bin/npm\n', stderr: '' }
    },
  })

  assert.equal(result, '/Users/Ryder/.volta/bin/npm')
})

test('Windows npm lookup normalizes Path and includes user installation locations', async () => {
  const expected = 'C:\\Users\\Ryder\\AppData\\Roaming\\npm\\npm.cmd'
  const result = await defaultFindCommand('npm.cmd', 'win32', {
    home: 'C:\\Users\\Ryder',
    env: {
      Path: 'C:\\Windows\\System32',
      APPDATA: 'C:\\Users\\Ryder\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\Ryder\\AppData\\Local',
    },
    execFileFn: async (command, args, options) => {
      assert.equal(command, 'where.exe')
      assert.deepEqual(args, ['npm.cmd'])
      assert.equal('Path' in options.env, false)
      const lookupPath = options.env.PATH.split(';')
      assert.ok(lookupPath.includes('C:\\Users\\Ryder\\AppData\\Roaming\\npm'))
      assert.ok(lookupPath.includes('C:\\Users\\Ryder\\AppData\\Local\\Microsoft\\WindowsApps'))
      assert.ok(lookupPath.includes('C:\\Users\\Ryder\\AppData\\Local\\Programs\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin'))
      return { stdout: `${expected}\r\n`, stderr: '' }
    },
  })

  assert.equal(result, expected)
})

test('installer processes inherit the same enhanced Finder-safe search path', async () => {
  const calls = []
  const child = new EventEmitter()
  child.pid = 12345
  child.kill = () => true

  const running = defaultRunProcess('/Users/Ryder/.volta/bin/npm', ['install'], {
    platform: 'darwin',
    home: '/Users/Ryder',
    env: {
      PATH: '/usr/bin:/bin',
      PNPM_HOME: '/Users/Ryder/Library/pnpm',
      OPENAI_API_KEY: 'test-provider-key',
      MELDWORK_SESSION_SECRET: 'test-private-value',
      USER_PROMPT: 'test-private-prompt',
    },
    spawnFn: (command, args, options) => {
      calls.push({ command, args, options })
      queueMicrotask(() => child.emit('close', 0))
      return child
    },
  })

  await running
  assert.equal(calls[0].command, '/Users/Ryder/.volta/bin/npm')
  assert.deepEqual(calls[0].args, ['install'])
  const childPath = calls[0].options.env.PATH.split(':')
  assert.ok(childPath.includes('/Users/Ryder/.volta/bin'))
  assert.ok(childPath.includes('/Users/Ryder/Library/pnpm'))
  assert.ok(childPath.includes('/Users/Ryder/.local/share/fnm/aliases/default/bin'))
  assert.equal('OPENAI_API_KEY' in calls[0].options.env, false)
  assert.equal('MELDWORK_SESSION_SECRET' in calls[0].options.env, false)
  assert.equal('USER_PROMPT' in calls[0].options.env, false)
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'ignore', 'ignore'])
  assert.equal(calls[0].options.shell, false)
})

test('npm integrity verification queries the exact release without a shell or sensitive env', async () => {
  const recipe = installRecipe('workbuddy', 'darwin')
  const calls = []

  const actual = await defaultVerifyNpmIntegrity('/usr/local/bin/npm', recipe, {
    platform: 'darwin',
    home: '/Users/Ryder',
    env: {
      PATH: '/usr/bin:/bin',
      OPENAI_API_KEY: 'test-provider-key',
      MELDWORK_SESSION_SECRET: 'test-private-value',
      USER_PROMPT: 'test-private-prompt',
    },
    execFileFn: async (command, args, options) => {
      calls.push({ command, args, options })
      return { stdout: `${JSON.stringify(recipe.integrity)}\n`, stderr: '' }
    },
  })

  assert.equal(actual, recipe.integrity)
  assert.equal(calls[0].command, '/usr/local/bin/npm')
  assert.deepEqual(calls[0].args, [
    'view', npmPackageSpec(recipe), 'dist.integrity', '--json',
    '--registry', 'https://registry.npmjs.org/',
  ])
  assert.equal(calls[0].options.shell, false)
  assert.equal('OPENAI_API_KEY' in calls[0].options.env, false)
  assert.equal('MELDWORK_SESSION_SECRET' in calls[0].options.env, false)
  assert.equal('USER_PROMPT' in calls[0].options.env, false)
})

test('npm integrity verification fails closed on registry mismatch or malformed metadata', async () => {
  const recipe = installRecipe('workbuddy', 'darwin')
  for (const stdout of ['"sha512-ZmFrZQ=="', '{"integrity":"unexpected"}']) {
    await assert.rejects(defaultVerifyNpmIntegrity('/usr/local/bin/npm', recipe, {
      platform: 'darwin',
      env: { PATH: '/usr/bin:/bin' },
      execFileFn: async () => ({ stdout, stderr: '' }),
    }), { message: 'INSTALL_AGENT_INTEGRITY_FAILED' })
  }
})

test('script integrity verification hashes only bounded regular files', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-installer-integrity-'))
  const filename = path.join(directory, 'install.sh')
  const source = '#!/bin/bash\necho verified\n'
  fs.writeFileSync(filename, source)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const recipe = {
    type: 'script',
    sha256: createHash('sha256').update(source).digest('hex'),
  }

  assert.equal(await defaultVerifyScriptIntegrity(filename, recipe), recipe.sha256)
  await assert.rejects(defaultVerifyScriptIntegrity(filename, {
    ...recipe,
    sha256: '0'.repeat(64),
  }), { message: 'INSTALL_AGENT_INTEGRITY_FAILED' })

  for (const stat of [
    { isFile: () => true, isSymbolicLink: () => true, size: source.length },
    { isFile: () => true, isSymbolicLink: () => false, size: (4 * 1024 * 1024) + 1 },
  ]) {
    let read = false
    await assert.rejects(defaultVerifyScriptIntegrity(filename, recipe, {
      lstatFn: async () => stat,
      readFileFn: async () => { read = true; return Buffer.from(source) },
    }), { message: 'INSTALL_AGENT_INTEGRITY_FAILED' })
    assert.equal(read, false)
  }
})

test('rejects non-allowlisted script URLs before any download', () => {
  const recipe = installRecipe('hermes', 'darwin')
  assert.equal(validateScriptUrl(recipe.url).hostname, 'raw.githubusercontent.com')
  assert.throws(
    () => validateScriptUrl('https://example.invalid/install.sh'),
    /INSTALL_AGENT_DOWNLOAD_BLOCKED/,
  )
  assert.throws(
    () => validateScriptUrl(recipe.url.replace('https:', 'http:')),
    /INSTALL_AGENT_DOWNLOAD_BLOCKED/,
  )
  assert.throws(
    () => validateScriptUrl(`${recipe.url}?mutable=1`),
    /INSTALL_AGENT_DOWNLOAD_BLOCKED/,
  )
  assert.throws(
    () => validateScriptUrl('https://hermes-agent.nousresearch.com/install.sh'),
    /INSTALL_AGENT_DOWNLOAD_BLOCKED/,
  )
})

test('npm installation verifies integrity before installing the exact compatible release', async () => {
  const recipe = installRecipe('workbuddy', 'darwin')
  const calls = []
  const order = []
  let detectCount = 0
  const phases = []
  const service = installer({
    detectAgents: async () => {
      detectCount += 1
      return detectCount > 1
        ? [detectedRelease('workbuddy', 'darwin', '/tmp/codebuddy')]
        : []
    },
    verifyNpmIntegrity: async (command, selectedRecipe, options) => {
      order.push('integrity')
      assert.equal(command, '/usr/local/bin/npm')
      assert.deepEqual(selectedRecipe, recipe)
      assert.equal(options.platform, 'darwin')
      assert.equal(options.signal.aborted, false)
    },
    runProcess: async (...args) => { order.push('install'); calls.push(args) },
  })
  service.on('changed', state => phases.push(state.phase))

  const started = await service.start('workbuddy')
  assert.equal(started.taskId, 'task-1')
  await service.waitForIdle()

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].slice(0, 2), [
    '/usr/local/bin/npm',
    [
      'install', '--global', npmPackageSpec(recipe),
      '--registry', 'https://registry.npmjs.org/',
    ],
  ])
  assert.equal(calls[0][2].platform, 'darwin')
  assert.equal(calls[0][2].signal.aborted, false)
  assert.deepEqual(order, ['integrity', 'install'])
  assert.deepEqual(phases, ['checking', 'installing', 'verifying', 'completed'])
  assert.deepEqual(service.state(), {
    taskId: 'task-1',
    kind: 'workbuddy',
    phase: 'completed',
    canCancel: false,
    errorCode: '',
  })
})

test('npm integrity failure is reported before the installer can mutate the machine', async () => {
  const order = []
  const service = installer({
    verifyNpmIntegrity: async () => {
      order.push('integrity')
      throw new Error('registry metadata mismatch')
    },
    runProcess: async () => { order.push('install') },
  })

  await service.start('codex')
  await service.waitForIdle()

  assert.deepEqual(order, ['integrity'])
  assert.deepEqual(service.state(), {
    taskId: 'task-1',
    kind: 'codex',
    phase: 'failed',
    canCancel: false,
    errorCode: 'INSTALL_AGENT_INTEGRITY_FAILED',
  })
})

test('npm integrity verification remains cancellable before process launch', async () => {
  let releaseVerification
  let verificationStarted
  let observedSignal
  let processStarted = false
  const pendingVerification = new Promise(resolve => { releaseVerification = resolve })
  const started = new Promise(resolve => { verificationStarted = resolve })
  const service = installer({
    verifyNpmIntegrity: async (_command, _recipe, options) => {
      observedSignal = options.signal
      verificationStarted()
      return pendingVerification
    },
    runProcess: async () => { processStarted = true },
  })

  const start = service.start('codex')
  await started
  assert.equal(service.cancel('task-1'), true)
  assert.equal(observedSignal.aborted, true)
  await start
  await within(service.waitForIdle())

  assert.equal(processStarted, false)
  assert.equal(service.state().phase, 'cancelled')
  releaseVerification()
  await new Promise(resolve => setImmediate(resolve))
})

test('installation refreshes cached detection before and after mutating the machine', async () => {
  let installed = false
  let detectCount = 0
  const service = installer({
    detectAgents: async () => {
      detectCount += 1
      return installed
        ? [detectedRelease('workbuddy', 'darwin', '/tmp/codebuddy')]
        : []
    },
    runProcess: async () => { installed = true },
  })

  const before = await service.catalog()
  assert.equal(before.agents.find(agent => agent.kind === 'workbuddy').installed, false)
  await service.start('workbuddy')
  await service.waitForIdle()

  const after = await service.catalog()
  assert.equal(after.agents.find(agent => agent.kind === 'workbuddy').installed, true)
  assert.equal(detectCount, 3)
})

test('installation rejects a concurrently starting request before either can launch twice', async () => {
  let installed = false
  let releaseDetection
  let detectCount = 0
  let runCount = 0
  const firstDetection = new Promise(resolve => { releaseDetection = resolve })
  const service = installer({
    detectAgents: async () => {
      detectCount += 1
      if (detectCount === 1) await firstDetection
      return installed
        ? [detectedRelease('workbuddy', 'darwin', '/tmp/codebuddy')]
        : []
    },
    runProcess: async () => {
      runCount += 1
      installed = true
    },
  })

  const firstStart = service.start('workbuddy')
  assert.deepEqual(service.state(), {
    taskId: 'task-1',
    kind: 'workbuddy',
    phase: 'checking',
    canCancel: true,
    errorCode: '',
  })
  await assert.rejects(service.start('qwen'), { message: 'INSTALL_AGENT_BUSY' })
  releaseDetection()
  await firstStart
  await service.waitForIdle()

  assert.equal(runCount, 1)
})

test('pending startup is cancellable and waitForIdle covers detection before process launch', async () => {
  let releaseDetection
  let runCount = 0
  let idleSettled = false
  const detection = new Promise(resolve => { releaseDetection = resolve })
  const service = installer({
    detectAgents: async () => {
      await detection
      return []
    },
    runProcess: async () => { runCount += 1 },
  })

  const start = service.start('workbuddy')
  const idle = service.waitForIdle().finally(() => { idleSettled = true })
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(service.state(), {
    taskId: 'task-1',
    kind: 'workbuddy',
    phase: 'checking',
    canCancel: true,
    errorCode: '',
  })
  assert.equal(idleSettled, false)
  assert.equal(service.cancel('wrong-task'), false)
  assert.equal(service.cancel('task-1'), true)
  assert.equal(service.state().canCancel, false)
  assert.deepEqual(await within(start), {
    taskId: 'task-1',
    kind: 'workbuddy',
    phase: 'cancelled',
    canCancel: false,
    errorCode: '',
  })
  await within(idle)
  assert.equal(idleSettled, true)
  assert.equal(runCount, 0)
  assert.equal(service.cancel('task-1'), false)
  assert.equal(service.cancelPending(), false)
  releaseDetection()
  await new Promise(resolve => setImmediate(resolve))
})

test('npm lookup remains visibly cancellable before the installer process launches', async () => {
  let releaseLookup
  let markLookupStarted
  let runCount = 0
  const lookup = new Promise(resolve => { releaseLookup = resolve })
  const lookupStarted = new Promise(resolve => { markLookupStarted = resolve })
  const service = installer({
    findCommand: async () => {
      markLookupStarted()
      return lookup
    },
    runProcess: async () => { runCount += 1 },
  })

  const start = service.start('workbuddy')
  await lookupStarted

  assert.equal(service.state().phase, 'checking')
  assert.equal(service.state().canCancel, true)
  assert.equal(service.cancel('task-1'), true)
  assert.equal((await within(start)).phase, 'cancelled')
  assert.equal(runCount, 0)

  releaseLookup('/usr/local/bin/npm')
  await new Promise(resolve => setImmediate(resolve))
})

test('installation refuses to overwrite an incompatible Agent that appeared after a cached read', async () => {
  let installed = false
  let detectCount = 0
  let runCount = 0
  const service = installer({
    detectAgents: async () => {
      detectCount += 1
      return installed
        ? [{
            kind: 'workbuddy', version: '', executable: '/tmp/codebuddy',
            compatibilityState: 'incompatible',
          }]
        : []
    },
    runProcess: async () => { runCount += 1 },
  })

  const before = await service.catalog()
  assert.equal(before.agents.find(agent => agent.kind === 'workbuddy').installed, false)
  installed = true

  await assert.rejects(service.start('workbuddy'), {
    message: 'INSTALL_AGENT_ALREADY_INSTALLED',
  })
  assert.equal(detectCount, 2)
  assert.equal(runCount, 0)
})

test('Windows npm installation launches node.exe and npm-cli.js without a shell', async () => {
  const recipe = installRecipe('qwen', 'win32')
  const npmCommand = 'C:\\Program Files\\nodejs\\npm.cmd'
  const nodeCommand = 'C:\\Program Files\\nodejs\\node.exe'
  const npmCli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'
  const shim = [
    '@ECHO off',
    'SET "NODE_EXE=%~dp0\\node.exe"',
    'SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"',
    '"%NODE_EXE%" "%NPM_CLI_JS%" %*',
  ].join('\r\n')
  const calls = []
  let detectCount = 0
  const service = installer({
    platform: 'win32',
    detectAgents: async () => {
      detectCount += 1
      return detectCount > 1
        ? [detectedRelease('qwen', 'win32', 'C:\\npm\\qwen.cmd')]
        : []
    },
    findCommand: async command => command === 'npm.cmd' ? npmCommand : '',
    readCommandFile: filename => {
      assert.equal(filename, npmCommand)
      return shim
    },
    commandPathExists: filename => [nodeCommand, npmCli].includes(filename),
    runProcess: async (...args) => { calls.push(args) },
  })

  await service.start('qwen')
  await service.waitForIdle()

  assert.deepEqual(calls[0].slice(0, 2), [
    nodeCommand,
    [
      npmCli, 'install', '--global', npmPackageSpec(recipe),
      '--registry', 'https://registry.npmjs.org/',
    ],
  ])
  assert.equal(calls[0][2].platform, 'win32')
  assert.equal(service.state().phase, 'completed')
})

test('Windows npm parsing rejects wrappers that do not target npm-cli.js', () => {
  const recipe = installRecipe('qwen', 'win32')
  assert.throws(() => prepareInstallCommand(
    'C:\\Program Files\\nodejs\\npm.cmd',
    [
      'install', '--global', npmPackageSpec(recipe),
      '--registry', 'https://registry.npmjs.org/',
    ],
    {
      platform: 'win32',
      readFileFn: () => '"node.exe" "%~dp0\\download-and-run.js" %*',
      existsFn: () => true,
    },
  ), /INSTALL_AGENT_COMMAND_BLOCKED/)
})

test('script installation verifies the immutable download before process launch', async () => {
  const recipe = installRecipe('hermes', 'darwin')
  const downloads = []
  const calls = []
  const order = []
  let detectCount = 0
  const service = installer({
    detectAgents: async () => {
      detectCount += 1
      return detectCount > 1
        ? [detectedRelease('hermes')]
        : []
    },
    downloadScript: async (...args) => {
      order.push('download')
      downloads.push(args)
      return '/tmp/meldwork-installer/install.sh'
    },
    verifyScriptIntegrity: async (filename, selectedRecipe, options) => {
      order.push('integrity')
      assert.equal(filename, '/tmp/meldwork-installer/install.sh')
      assert.deepEqual(selectedRecipe, recipe)
      assert.equal(options.signal.aborted, false)
    },
    runProcess: async (...args) => { order.push('install'); calls.push(args) },
  })

  await service.start('hermes')
  await service.waitForIdle()

  assert.equal(downloads[0][0], recipe.url)
  assert.deepEqual(calls[0].slice(0, 2), [
    recipe.interpreter,
    recipe.args.map(value => value === '$SCRIPT'
      ? '/tmp/meldwork-installer/install.sh'
      : value),
  ])
  assert.deepEqual(order, ['download', 'integrity', 'install'])
})

test('script integrity failure cleans up the download without launching it', async () => {
  const order = []
  const service = installer({
    downloadScript: async () => {
      order.push('download')
      return '/tmp/meldwork-installer/install.sh'
    },
    verifyScriptIntegrity: async () => {
      order.push('integrity')
      throw new Error('hash mismatch')
    },
    runProcess: async () => { order.push('install') },
    removeDownload: async () => { order.push('cleanup') },
  })

  await service.start('hermes')
  await service.waitForIdle()

  assert.deepEqual(order, ['download', 'integrity', 'cleanup'])
  assert.equal(service.state().phase, 'failed')
  assert.equal(service.state().errorCode, 'INSTALL_AGENT_INTEGRITY_FAILED')
})

test('rejects unknown, verified installed, unsupported and missing-prerequisite installs', async () => {
  const service = installer()
  await assert.rejects(service.start('anything'), /INSTALL_AGENT_UNSUPPORTED/)

  const installed = installer({
    detectAgents: async () => [{ kind: 'kimi', executable: '/tmp/kimi', version: '0.19.2' }],
  })
  await assert.rejects(installed.start('kimi'), /INSTALL_AGENT_ALREADY_INSTALLED/)

  const unsupported = installer({ platform: 'linux' })
  await assert.rejects(unsupported.start('hermes'), /INSTALL_AGENT_PLATFORM_UNSUPPORTED/)

  const noNode = installer({ findCommand: async () => '' })
  await assert.rejects(noNode.start('qwen'), /INSTALL_AGENT_NODE_REQUIRED/)
})

test('installation verification rejects a detected command without a working version', async () => {
  let detectCount = 0
  const service = installer({
    detectAgents: async () => {
      detectCount += 1
      return detectCount > 1
        ? [{ kind: 'openclaw', executable: '/tmp/openclaw', version: '' }]
        : []
    },
  })

  await service.start('openclaw')
  await service.waitForIdle()

  assert.equal(service.state().phase, 'failed')
  assert.equal(service.state().errorCode, 'INSTALL_AGENT_VERIFY_FAILED')
})

test('installation verification requires the exact compatible release', async () => {
  const recipe = installRecipe('workbuddy', 'darwin')
  for (const detected of [
    {
      kind: 'workbuddy', executable: '/tmp/codebuddy', version: '0.0.0',
      compatibilityState: 'compatible',
    },
    {
      kind: 'workbuddy', executable: '/tmp/codebuddy',
      version: recipe.detectedVersion || recipe.version,
      compatibilityState: 'incompatible',
    },
  ]) {
    let detectCount = 0
    const service = installer({
      detectAgents: async () => {
        detectCount += 1
        return detectCount > 1 ? [detected] : []
      },
    })

    await service.start('workbuddy')
    await service.waitForIdle()

    assert.equal(service.state().phase, 'failed')
    assert.equal(service.state().errorCode, 'INSTALL_AGENT_VERIFY_FAILED')
  }
})

test('rejects a non-allowlisted executable before starting a process', async () => {
  let processStarted = false
  const service = installer({
    findCommand: async () => '/tmp/curl',
    runProcess: async () => { processStarted = true },
  })

  await assert.rejects(service.start('qwen'), /INSTALL_AGENT_COMMAND_BLOCKED/)
  assert.equal(processStarted, false)
  assert.equal(service.state().phase, 'idle')
})

test('reports download failures without starting the installer command', async () => {
  let processStarted = false
  const phases = []
  const service = installer({
    downloadScript: async () => { throw new Error('socket closed') },
    runProcess: async () => { processStarted = true },
  })
  service.on('changed', state => phases.push(state.phase))

  await service.start('hermes')
  await service.waitForIdle()

  assert.equal(processStarted, false)
  assert.deepEqual(phases, ['checking', 'downloading', 'failed'])
  assert.deepEqual(service.state(), {
    taskId: 'task-1',
    kind: 'hermes',
    phase: 'failed',
    canCancel: false,
    errorCode: 'INSTALL_AGENT_DOWNLOAD_FAILED',
  })
})

test('download cancellation aborts the request before response headers arrive', async (t) => {
  const originalGet = https.get
  let request
  let destroyedWith
  t.after(() => { https.get = originalGet })
  https.get = () => {
    request = new EventEmitter()
    request.destroy = (error) => {
      destroyedWith = error
      queueMicrotask(() => request.emit('error', error))
    }
    return request
  }
  const controller = new AbortController()

  const download = defaultDownloadScript(
    installRecipe('hermes', 'darwin').url,
    controller.signal,
  )
  while (!request) await new Promise(resolve => setImmediate(resolve))
  controller.abort()

  await assert.rejects(within(download, 500), { name: 'AbortError' })
  assert.equal(destroyedWith?.name, 'AbortError')
})

test('cancels only the active task and never exposes commands or output in state', async () => {
  let rejectRun
  let observedSignal
  const service = installer({
    runProcess: async (_command, _args, options) => {
      observedSignal = options.signal
      await new Promise((_resolve, reject) => { rejectRun = reject })
    },
  })

  await service.start('codex')
  while (!rejectRun) await new Promise(resolve => setImmediate(resolve))
  assert.equal(service.cancel('wrong-task'), false)
  assert.equal(service.cancel('task-1'), true)
  assert.equal(observedSignal.aborted, true)
  rejectRun(Object.assign(new Error('cancelled'), { name: 'AbortError' }))
  await service.waitForIdle()

  assert.deepEqual(service.state(), {
    taskId: 'task-1',
    kind: 'codex',
    phase: 'cancelled',
    canCancel: false,
    errorCode: '',
  })
  assert.equal(JSON.stringify(service.state()).includes('npm'), false)
})

test('process cancellation escalates from SIGTERM to SIGKILL', {
  skip: process.platform === 'win32',
}, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-installer-abort-'))
  const readyFile = path.join(directory, 'ready')
  const termFile = path.join(directory, 'term')
  const script = path.join(directory, 'ignore-term.sh')
  const source = `
const fs = require('node:fs')
process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(termFile)}, 'SIGTERM'))
fs.writeFileSync(${JSON.stringify(readyFile)}, String(process.pid))
setInterval(() => {}, 1000)
`
  fs.writeFileSync(script, `#!/bin/bash\nexec ${shellLiteral(process.execPath)} -e ${shellLiteral(source)}\n`, {
    mode: 0o755,
  })
  let pid = 0
  t.after(() => {
    if (pid) {
      try { process.kill(pid, 'SIGKILL') } catch { /* already exited */ }
    }
    fs.rmSync(directory, { recursive: true, force: true })
  })

  const service = installer({
    downloadScript: async () => script,
    runProcess: undefined,
  })

  await service.start('hermes')
  pid = Number(await readWhenReady(readyFile))
  assert.equal(service.cancel('task-1'), true)
  assert.equal(await readWhenReady(termFile), 'SIGTERM')
  await within(service.waitForIdle())
  await waitForExit(pid)

  assert.deepEqual(service.state(), {
    taskId: 'task-1',
    kind: 'hermes',
    phase: 'cancelled',
    canCancel: false,
    errorCode: '',
  })
})

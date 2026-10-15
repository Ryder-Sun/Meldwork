const { execFile } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { promisify } = require('node:util')
const { searchPath } = require('../cli/cli-adapters.cjs')
const { compareReleaseVersions, extractAgentVersion } = require('../agent-compatibility.cjs')

// True when the installed CLI is the recipe's version or newer. A substring
// test treated "11.2.3" as "1.2.3" and offered downgrades for newer CLIs.
function installedVersionCurrent(installedVersion, targetVersion) {
  const installed = extractAgentVersion(installedVersion).split('-')[0]
  const target = extractAgentVersion(targetVersion).split('-')[0]
  const comparison = installed && target ? compareReleaseVersions(installed, target) : null
  if (comparison != null) return comparison >= 0
  return Boolean(targetVersion) && String(installedVersion || '').includes(targetVersion)
}

const execFileAsync = promisify(execFile)
const DETECTION_CACHE_TTL_MS = 30000
const MAX_SCRIPT_BYTES = 4 * 1024 * 1024
const NPM_REGISTRY = 'https://registry.npmjs.org/'
const NPM_INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/
const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?$/
const SHA256 = /^[a-f0-9]{64}$/
const VERSION_LINE = /\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?)\b/
const SENSITIVE_INSTALL_ENV_KEY = /api[_-]?key|token|secret|password|passwd|credential|authorization|cookie|prompt/i
const HERMES_COMMIT = '3c27eb6234bf91b8ceee9e9071591b31e9b148cb'
const HERMES_SCRIPT_BASE = `https://raw.githubusercontent.com/NousResearch/hermes-agent/${HERMES_COMMIT}/scripts`
const HERMES_RECIPES = Object.freeze({
  darwin: Object.freeze({
    type: 'script',
    version: '0.20.0',
    url: `${HERMES_SCRIPT_BASE}/install.sh`,
    sha256: '45f589461248c7a6ec3aecd7522a69dd49c5c8dbf4798ba1296af5c0c5e7ccd3',
    interpreter: '/bin/bash',
    args: ['$SCRIPT', '--non-interactive', '--skip-setup', '--commit', HERMES_COMMIT],
  }),
  win32: Object.freeze({
    type: 'script',
    version: '0.20.0',
    url: `${HERMES_SCRIPT_BASE}/install.ps1`,
    sha256: '4dcbf2b665750cb578f69a6efa40770659e21821a463746f86da68af0d2bb31c',
    interpreter: 'powershell.exe',
    args: [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '$SCRIPT',
      '-NonInteractive', '-SkipSetup', '-Commit', HERMES_COMMIT,
    ],
  }),
})
const NPM_RELEASES = Object.freeze({
  codex: Object.freeze({
    packageName: '@openai/codex',
    version: '0.146.0',
    integrity: 'sha512-yG3sPWNda/2YAIQIDq9MrrjoCTIQ7rxYM5IasrG3VBcuhCLTkgeg/JzqmJq1V98RE4MJ5jCxDXXQlOjrditFRw==',
  }),
  claude: Object.freeze({
    packageName: '@anthropic-ai/claude-code',
    version: '2.1.221',
    integrity: 'sha512-hcrvYceETHpQepXBkwR0zHShxFbkh9C1o3DyFoJOehMxFWDuiCXONF1X3MDxY7M+p2m3DSpn9DvSA67mNhGQcw==',
  }),
  openclaw: Object.freeze({
    packageName: 'openclaw',
    version: '2026.7.1-2',
    integrity: 'sha512-ycF3yPcbjN6bUPeaUx6Mh6vze1hQWoD3CT/wWcmD7a8xaHHHRUaAlaq+lFxMHf1ssEgODVAwjlzYqp2twkYZ7g==',
  }),
  pi: Object.freeze({
    packageName: '@earendil-works/pi-coding-agent',
    version: '0.84.2',
    integrity: 'sha512-l4E+B7hgXKWddRo8bC/eSue2aWZjEgJ9xIpf5p0Og+lq8a2TArCwJ0HCoCPCgaBP/tN4zbYH/wOwvx9pJpeLCA==',
    ignoreScripts: true,
  }),
  qwen: Object.freeze({
    packageName: '@qwen-code/qwen-code',
    version: '0.21.5',
    integrity: 'sha512-m3cKT8i+bcEjtzWWImgv4oReMSMuxPecvoKGkg5ciS4xlKGuJOHNAROA68Di5mSwMOorACqTjb8jJVaQusudhg==',
  }),
  workbuddy: Object.freeze({
    packageName: '@tencent-ai/codebuddy-code',
    version: '2.132.0',
    integrity: 'sha512-JFa1q0ZXK+TUmqW3X7zgg9RLCHb5dAInLKrTZtEdtAjfhIDwQeBXjYlyPNDLYJg6Y2Ic3p4SGhbXaE+slnjP1Q==',
  }),
  gemini: Object.freeze({
    packageName: '@google/gemini-cli',
    version: '0.53.1',
    integrity: 'sha512-xBGdD/tl05gsTpD2oV1Bq0NCb4BBeTnjSbKxHtwOB7nt1QMaqWYJ9WsOEsQQhQ2P1v0UJth1F17SAXvdZ5mASw==',
  }),
  opencode: Object.freeze({
    packageName: 'opencode-ai',
    version: '1.18.12',
    integrity: 'sha512-3pDzNXO9aHzHUzdLySLWPoYmL6hoUUqWtn+HurG9KTWPqerRegsU7GgCtUH5cpaUikgTyzpEtbfE8F0/dToSEg==',
  }),
  kimi: Object.freeze({
    packageName: '@moonshot-ai/kimi-code',
    version: '0.32.0',
    integrity: 'sha512-iCCj7i4S4o1zzd/OpdVbihAHfBbd6V2ml3YW6zAy/xUJxQ1WiBnnvZByIz2NWg3xxcd3Nkklw1WxkYkRo5ahXA==',
  }),
  mimo: Object.freeze({
    packageName: '@mimo-ai/cli',
    version: '0.1.9',
    detectedVersion: '0.1.0',
    integrity: 'sha512-YFqiotp1sHDmj2BOiw2AbgCY2zm+c7Z36lh5JNL6KACEvYgerB5kqqldqcy/xI4Erry501DsTN1YPxo2mw6fAQ==',
  }),
  opencodereview: Object.freeze({
    packageName: '@alibaba-group/open-code-review',
    version: '1.8.6',
    integrity: 'sha512-m2uMzkuA9NRev2Ds7cCrL9fTYs93RSbzLKIQAEjNVjIFG0aDQqbyuqNTD/rQcUYhS7K7ufpVZ/+EBTD0ZcoDtA==',
  }),
})
const ALLOWED_SCRIPT_URLS = new Set(Object.values(HERMES_RECIPES).map(recipe => recipe.url))

const AGENT_CATALOG = Object.freeze([
  { kind: 'codex', label: 'Codex', recommended: false },
  { kind: 'claude', label: 'Claude Code', recommended: false },
  { kind: 'hermes', label: 'Hermes', recommended: true },
  { kind: 'workbuddy', label: 'WorkBuddy', recommended: true },
  { kind: 'openclaw', label: 'OpenClaw', recommended: true },
  { kind: 'pi', label: 'Pi Agent', recommended: false },
  { kind: 'opencode', label: 'OpenCode', recommended: false },
  { kind: 'opencodereview', label: 'OpenCodeReview', recommended: false },
  { kind: 'kimi', label: 'Kimi Code', recommended: false },
  { kind: 'mimo', label: 'MiMo Code', recommended: false },
  { kind: 'qwen', label: 'Qwen Code', recommended: false },
])

function installRecipe(kind, platform) {
  if (!['darwin', 'win32'].includes(platform)) return null
  if (kind === 'hermes') return { ...HERMES_RECIPES[platform], args: [...HERMES_RECIPES[platform].args] }
  const release = NPM_RELEASES[kind]
  return release ? { type: 'npm', ...release } : null
}

function publicState(state) {
  return {
    taskId: state.taskId || '',
    kind: state.kind || '',
    phase: state.phase || 'idle',
    canCancel: Boolean(state.canCancel),
    errorCode: state.errorCode || '',
  }
}

function installerError(code) {
  return Object.assign(new Error(code), { code })
}

function abortError() {
  return Object.assign(new Error('cancelled'), { name: 'AbortError' })
}

function abortable(task, signal) {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (callback) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      callback()
    }
    const abort = () => settle(() => reject(abortError()))
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(task).then(
      value => settle(() => resolve(value)),
      error => settle(() => reject(error)),
    )
    if (signal.aborted) abort()
  })
}

function validateScriptUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw installerError('INSTALL_AGENT_DOWNLOAD_BLOCKED')
  }
  if (parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.port
    || !ALLOWED_SCRIPT_URLS.has(parsed.toString())) {
    throw installerError('INSTALL_AGENT_DOWNLOAD_BLOCKED')
  }
  return parsed
}

function npmPackageSpec(recipe) {
  const packageName = String(recipe?.packageName || '')
  const version = String(recipe?.version || '')
  if (recipe?.type !== 'npm'
    || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(packageName)
    || !RELEASE_VERSION.test(version)
    || !NPM_INTEGRITY.test(String(recipe.integrity || ''))) {
    throw installerError('INSTALL_AGENT_INTEGRITY_FAILED')
  }
  return `${packageName}@${version}`
}

async function defaultVerifyNpmIntegrity(command, recipe, options = {}) {
  const platform = options.platform || process.platform
  const signal = options.signal
  if (signal?.aborted) throw abortError()
  validateInstallCommand(command, recipe, platform)
  const packageSpec = npmPackageSpec(recipe)
  const args = [
    'view', packageSpec, 'dist.integrity', '--json',
    '--registry', NPM_REGISTRY,
  ]
  const prepared = prepareInstallCommand(command, args, {
    platform,
    readFileFn: options.readFileFn,
    existsFn: options.existsFn,
  })
  const execFileFn = options.execFileFn || execFileAsync
  try {
    const { stdout } = await execFileFn(prepared.command, prepared.args, {
      timeout: 15000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      shell: false,
      signal,
      env: installEnvironment(platform, options.env || process.env, options.home),
    })
    const raw = String(stdout || '').trim()
    let actual
    try {
      actual = JSON.parse(raw)
    } catch {
      actual = raw
    }
    if (typeof actual !== 'string'
      || !NPM_INTEGRITY.test(actual)
      || actual !== recipe.integrity) {
      throw installerError('INSTALL_AGENT_INTEGRITY_FAILED')
    }
    return actual
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw abortError()
    if (error?.code === 'INSTALL_AGENT_INTEGRITY_FAILED') throw error
    throw installerError('INSTALL_AGENT_INTEGRITY_FAILED')
  }
}

async function defaultVerifyScriptIntegrity(filename, recipe, options = {}) {
  const signal = options.signal
  if (signal?.aborted) throw abortError()
  const expected = String(recipe?.sha256 || '')
  if (recipe?.type !== 'script' || !SHA256.test(expected)) {
    throw installerError('INSTALL_AGENT_INTEGRITY_FAILED')
  }
  try {
    const lstatFn = options.lstatFn || fs.promises.lstat
    const readFileFn = options.readFileFn || fs.promises.readFile
    const stat = await lstatFn(filename)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_SCRIPT_BYTES) {
      throw installerError('INSTALL_AGENT_INTEGRITY_FAILED')
    }
    const bytes = await readFileFn(filename, { signal })
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== expected) throw installerError('INSTALL_AGENT_INTEGRITY_FAILED')
    return actual
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw abortError()
    if (error?.code === 'INSTALL_AGENT_INTEGRITY_FAILED') throw error
    throw installerError('INSTALL_AGENT_INTEGRITY_FAILED')
  }
}

function validateInstallCommand(command, recipe, platform) {
  let allowed = false
  if (recipe.type === 'script') {
    const expected = platform === 'win32' ? 'powershell.exe' : '/bin/bash'
    allowed = recipe.interpreter === expected && command === expected
  } else if (recipe.type === 'npm') {
    const pathApi = platform === 'win32' ? path.win32 : path.posix
    const expected = platform === 'win32' ? 'npm.cmd' : 'npm'
    const basename = pathApi.basename(command)
    allowed = pathApi.isAbsolute(command)
      && (platform === 'win32'
        ? basename.toLowerCase() === expected
        : basename === expected)
  }
  if (!allowed) throw installerError('INSTALL_AGENT_COMMAND_BLOCKED')
}

function prepareInstallCommand(command, args, {
  platform = process.platform,
  readFileFn = filename => fs.readFileSync(filename, 'utf8'),
  existsFn = fs.existsSync,
} = {}) {
  if (platform !== 'win32') return { command, args }
  if (!path.win32.isAbsolute(command)
    || path.win32.basename(command).toLowerCase() !== 'npm.cmd') {
    throw installerError('INSTALL_AGENT_COMMAND_BLOCKED')
  }

  let source
  try {
    source = String(readFileFn(command))
  } catch {
    throw installerError('INSTALL_AGENT_COMMAND_BLOCKED')
  }
  if (!/%(?:dp0%|~dp0)[\\/]?node_modules[\\/]npm[\\/]bin[\\/]npm-cli\.js/i
    .test(source)) {
    throw installerError('INSTALL_AGENT_COMMAND_BLOCKED')
  }

  const directory = path.win32.dirname(command)
  const npmCli = path.win32.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const bundledNode = path.win32.join(directory, 'node.exe')
  if (!existsFn(npmCli)) throw installerError('INSTALL_AGENT_COMMAND_BLOCKED')
  return {
    command: existsFn(bundledNode) ? bundledNode : 'node.exe',
    args: [npmCli, ...args],
  }
}

function installEnvironment(platform, sourceEnv, home) {
  const env = Object.fromEntries(
    Object.entries(sourceEnv).filter(([key]) => (
      key.toLowerCase() !== 'path' && !SENSITIVE_INSTALL_ENV_KEY.test(key)
    )),
  )
  env.PATH = searchPath({ platform, env: sourceEnv, home })
  return env
}

function defaultFindCommand(command, platform = process.platform, options = {}) {
  const executable = platform === 'win32' ? 'where.exe' : '/usr/bin/which'
  const sourceEnv = options.env || process.env
  const lookup = options.execFileFn || execFileAsync
  return lookup(executable, [command], {
    timeout: 5000,
    windowsHide: true,
    env: installEnvironment(platform, sourceEnv, options.home),
  })
    .then(({ stdout }) => String(stdout || '').trim().split(/\r?\n/)[0] || '')
    .catch(() => '')
}

function verifiedAgent(agent) {
  return Boolean(agent?.kind && String(agent.version || '').trim())
}

function verifiedRecipeAgent(agent, recipe) {
  if (!verifiedAgent(agent) || !RELEASE_VERSION.test(String(recipe?.version || ''))) return false
  const match = String(agent.version || '').match(VERSION_LINE)
  return match?.[1] === (recipe.detectedVersion || recipe.version)
}

module.exports = {
  installedVersionCurrent,
  AGENT_CATALOG,
  DETECTION_CACHE_TTL_MS,
  abortError,
  abortable,
  defaultVerifyNpmIntegrity,
  defaultVerifyScriptIntegrity,
  defaultFindCommand,
  installEnvironment,
  installRecipe,
  installerError,
  npmPackageSpec,
  prepareInstallCommand,
  publicState,
  validateInstallCommand,
  validateScriptUrl,
  verifiedAgent,
  verifiedRecipeAgent,
}

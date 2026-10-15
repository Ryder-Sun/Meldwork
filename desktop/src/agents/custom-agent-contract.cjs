const fs = require('node:fs')
const path = require('node:path')
const { agentRuntimeError } = require('./agent-runtime-contract.cjs')

const CUSTOM_AGENT_KIND = /^custom-[a-f0-9]{16}$/
const PROMPT_MODES = new Set(['stdin', 'argument'])
const MAX_AGENTS = 32
const MAX_ARGUMENTS = 24
const MAX_ARGUMENT_LENGTH = 512
const MAX_ATTACHMENTS = 32
const MAX_PROMPT_BYTES = 1024 * 1024
const MAX_STDOUT_BYTES = 4 * 1024 * 1024
const MAX_STDERR_BYTES = 1024 * 1024
const TERMINATE_GRACE_MS = 500
const KILL_SETTLE_MS = 500
const VERSION_LINE_LIMIT = 160
const SENSITIVE_ARGUMENT = /api[-_]?key|token|secret|password|passwd|credential|authorization|cookie/i
const SECRET_VALUE = /(?:^|[=:])(?:sk|rk|pk|ghp|github_pat|xox[baprs]?)[_-][A-Za-z0-9_-]{12,}/i
const CHILD_ENV_KEYS = Object.freeze([
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH',
  'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'TERM', 'COLORTERM', 'NO_COLOR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME',
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
  'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
])

function customAgentError(code) {
  return agentRuntimeError(code)
}

function cleanInline(value, limit) {
  const text = String(value || '').trim().replace(/\s+/g, ' ')
  if (!text || text.length > limit || /[\u0000-\u001f\u007f]/.test(text)) return ''
  return text
}

function cleanDescription(value) {
  const text = String(value || '').trim().replace(/\s+/g, ' ')
  if (text.length > 240 || /[\u0000-\u001f\u007f]/.test(text)) return ''
  return text
}

function normalizeArguments(value) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > MAX_ARGUMENTS) {
    throw customAgentError('CUSTOM_AGENT_ARGUMENTS_INVALID')
  }
  return value.map((argument) => {
    if (typeof argument !== 'string' || !argument.length
        || argument.length > MAX_ARGUMENT_LENGTH
        || /[\u0000\r\n]/.test(argument)) {
      throw customAgentError('CUSTOM_AGENT_ARGUMENTS_INVALID')
    }
    if (SENSITIVE_ARGUMENT.test(argument) || SECRET_VALUE.test(argument)) {
      throw customAgentError('CUSTOM_AGENT_SECRET_ARGUMENT_BLOCKED')
    }
    return argument
  })
}

function normalizeDefinition(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const kind = String(input.kind || '')
  const label = cleanInline(input.label, 60)
  const description = cleanDescription(input.description)
  const executable = String(input.executable || '')
  const promptMode = String(input.promptMode || '')
  const createdAt = String(input.createdAt || '')
  if (!CUSTOM_AGENT_KIND.test(kind) || !label || !path.isAbsolute(executable)
      || !PROMPT_MODES.has(promptMode) || !createdAt) return null
  let args
  try {
    args = normalizeArguments(input.args)
  } catch {
    return null
  }
  return { kind, label, description, executable: path.normalize(executable), args, promptMode, createdAt }
}

function executablePath(filename, platform = process.platform) {
  if (typeof filename !== 'string' || !filename || filename.length > 4096
      || !path.isAbsolute(filename) || /[\u0000-\u001f\u007f]/.test(filename)) {
    throw customAgentError('CUSTOM_AGENT_EXECUTABLE_INVALID')
  }
  let resolved
  try {
    resolved = fs.realpathSync(filename)
    const stat = fs.statSync(resolved)
    if (!stat.isFile()) throw customAgentError('CUSTOM_AGENT_EXECUTABLE_INVALID')
    if (platform === 'win32') {
      if (!/\.(?:com|exe)$/i.test(resolved)) {
        throw customAgentError('CUSTOM_AGENT_EXECUTABLE_UNSUPPORTED')
      }
    } else {
      fs.accessSync(resolved, fs.constants.X_OK)
    }
  } catch (error) {
    if (String(error?.code || '').startsWith('CUSTOM_AGENT_')) throw error
    throw customAgentError('CUSTOM_AGENT_EXECUTABLE_INVALID')
  }
  return path.normalize(resolved)
}

function childEnvironment(source = process.env) {
  const env = {}
  for (const name of CHILD_ENV_KEYS) {
    const key = Object.keys(source).find(candidate => candidate.toLowerCase() === name.toLowerCase())
    const value = key ? source[key] : ''
    if (typeof value === 'string' && value) env[name] = value
  }
  return env
}

function publicProfile(definition, version = '') {
  return {
    kind: definition.kind,
    label: definition.label,
    description: definition.description,
    commandName: path.basename(definition.executable),
    promptMode: definition.promptMode,
    custom: true,
    recommended: false,
    installed: true,
    installSupported: false,
    installErrorCode: '',
    imageAttachmentLimit: 32,
    attachmentTypes: ['image', 'audio', 'video', 'file'],
    version: String(version || '').slice(0, VERSION_LINE_LIMIT),
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function redactExecutable(value, definition) {
  const text = String(value || '')
  if (!text) return ''
  return text.replace(
    new RegExp(escapeRegExp(definition.executable), 'g'),
    path.basename(definition.executable),
  )
}

function normalizeAttachments(value) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) {
    throw customAgentError('LOCAL_ATTACHMENT_REFERENCE_INVALID')
  }
  const normalized = value.map((filename) => {
    if (typeof filename !== 'string' || !filename || filename.length > 4096
        || !path.isAbsolute(filename) || /[\u0000-\u001f\u007f]/.test(filename)) {
      throw customAgentError('LOCAL_ATTACHMENT_REFERENCE_INVALID')
    }
    return path.normalize(filename)
  })
  if (new Set(normalized).size !== normalized.length) {
    throw customAgentError('LOCAL_ATTACHMENT_REFERENCE_INVALID')
  }
  return normalized
}

module.exports = {
  CUSTOM_AGENT_KIND,
  KILL_SETTLE_MS,
  MAX_AGENTS,
  MAX_PROMPT_BYTES,
  MAX_STDERR_BYTES,
  MAX_STDOUT_BYTES,
  PROMPT_MODES,
  TERMINATE_GRACE_MS,
  VERSION_LINE_LIMIT,
  childEnvironment,
  cleanDescription,
  cleanInline,
  customAgentError,
  executablePath,
  isCustomAgentKind: value => CUSTOM_AGENT_KIND.test(String(value || '')),
  normalizeArguments,
  normalizeAttachments,
  normalizeDefinition,
  publicProfile,
  redactExecutable,
}

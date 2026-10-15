const path = require('node:path')

const CODEX_SANDBOXES = new Set(['read-only', 'workspace-write'])
const IMAGE_ATTACHMENT_LIMITS = Object.freeze({
  codex: 4,
  hermes: 1,
  opencode: 4,
})
const DEFAULT_INTERNAL_TURN_LIMITS = Object.freeze({
  // Meldwork already owns the outer discussion rounds. Keep WorkBuddy's
  // nested tool loop bounded so one participant cannot dominate a round.
  workbuddy: 8,
})

function internalTurnLimit(kind, requested) {
  const value = Number(requested)
  if (Number.isInteger(value) && value >= 1 && value <= 50) return value
  return DEFAULT_INTERNAL_TURN_LIMITS[kind]
}

function codexSandbox(requested) {
  if (requested != null) {
    if (!CODEX_SANDBOXES.has(requested)) throw new Error('CODEX_SANDBOX_UNSUPPORTED')
    return requested
  }
  const configured = process.env.MELDWORK_CODEX_SANDBOX || 'read-only'
  return CODEX_SANDBOXES.has(configured) ? configured : 'read-only'
}

function imageAttachmentLimit(kind) {
  return IMAGE_ATTACHMENT_LIMITS[kind] || 0
}

function attachmentPaths(kind, value) {
  if (value == null) return []
  if (!Array.isArray(value)) throw new Error('LOCAL_ATTACHMENT_REFERENCE_INVALID')
  const limit = imageAttachmentLimit(kind)
  if (value.length && !limit) throw new Error('LOCAL_AGENT_IMAGE_UNSUPPORTED')
  if (value.length > limit) throw new Error('LOCAL_AGENT_IMAGE_LIMIT')
  const normalized = value.map((filename) => {
    if (typeof filename !== 'string' || !filename || filename.length > 4096
        || !path.isAbsolute(filename) || /[\u0000-\u001f\u007f]/.test(filename)) {
      throw new Error('LOCAL_ATTACHMENT_REFERENCE_INVALID')
    }
    return path.normalize(filename)
  })
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('LOCAL_ATTACHMENT_REFERENCE_INVALID')
  }
  return normalized
}

function invocation(kind, executable, workdir, sessionRef = '', options = {}) {
  const attachments = attachmentPaths(kind, options.attachments)
  if (kind === 'codex') {
    const sandbox = codexSandbox(options.sandbox)
    const imageArgs = attachments.flatMap(filename => ['--image', filename])
    if (sessionRef) {
      return {
        command: executable,
        args: [
          'exec', 'resume', '--json', '--skip-git-repo-check',
          '-c', `sandbox_mode="${sandbox}"`, ...imageArgs, sessionRef, '-',
        ],
        stdin: true,
      }
    }
    return {
      command: executable,
      args: ['exec', '--json', '--skip-git-repo-check', '--sandbox',
        sandbox, '-C', workdir, ...imageArgs, '-'],
      stdin: true,
    }
  }
  if (kind === 'hermes') {
    // Hermes uses the same native conversation identifier across its ACP and
    // legacy transports. Keep it when an attachment requires the legacy path.
    const legacySessionRef = sessionRef
    const useAcp = options.invocationTransport !== 'legacy'
      && options.hermesAcpAvailable !== false
      && (!sessionRef || options.sessionTransport === 'acp')
    if (useAcp) {
      return {
        command: executable,
        args: ['acp'],
        acpMode: options.sandbox === 'workspace-write' ? 'accept_edits' : 'default',
        eventTransport: 'acp',
        fallbackTransport: 'legacy',
        fallbackSessionPolicy: 'invalidate',
      }
    }
    return {
      command: executable,
      args: [
        'chat',
        '--quiet',
        ...(options.sandbox === 'workspace-write' ? ['--yolo'] : []),
        ...(legacySessionRef ? ['--resume', legacySessionRef] : []),
        ...(attachments[0] ? ['--image', attachments[0]] : []),
        '--query',
      ],
      promptArg: true,
      eventTransport: 'legacy',
    }
  }
  if (kind === 'openclaw') {
    if (options.invocationTransport !== 'legacy') {
      return {
        command: executable,
        args: [
          '--no-color', '--log-level', 'info',
          'acp',
          ...(sessionRef ? ['--session', sessionRef] : []),
          '--no-prefix-cwd',
          '--verbose',
        ],
        eventTransport: 'acp',
        acpSessionStrategy: 'new',
        publicSessionRef: sessionRef,
        openClawGateway: true,
        fallbackTransport: 'legacy',
        fallbackSessionPolicy: 'preserve',
      }
    }
    return {
      command: executable,
      args: [
        'agent', '--local', '--agent', 'main',
        ...(sessionRef ? ['--session-key', sessionRef] : []),
        '--message',
      ],
      suffixArgs: ['--json'],
      promptArg: true,
      eventTransport: 'legacy',
    }
  }
  if (kind === 'workbuddy') {
    const maxTurns = internalTurnLimit(kind, options.maxTurns)
    return {
      command: executable,
      args: [
        '--print',
        '--output-format', 'stream-json',
        '--include-partial-messages',
        '--permission-mode', options.sandbox === 'workspace-write' ? 'acceptEdits' : 'plan',
        ...(options.sandbox === 'workspace-write' ? ['--dangerously-skip-permissions'] : []),
        ...(maxTurns ? ['--max-turns', String(maxTurns)] : []),
        ...(sessionRef ? ['--resume', sessionRef] : []),
      ],
      promptArg: true,
      eventTransport: 'stream-json',
    }
  }
  if (kind === 'pi') {
    return {
      command: executable,
      args: [
        '--mode', 'json', '--print',
        ...(options.sandbox === 'workspace-write'
          ? ['--approve']
          : ['--no-approve', '--tools', 'read,grep,find,ls']),
        ...(sessionRef ? ['--session', sessionRef] : []),
      ],
      promptArg: true,
      eventTransport: 'json',
    }
  }
  if (kind === 'kimi') {
    if (options.sandbox !== 'workspace-write') {
      return {
        command: executable,
        args: ['acp'],
        acpMode: 'plan',
        eventTransport: 'acp',
      }
    }
    return {
      command: executable,
      args: [
        '--output-format', 'stream-json',
        '--auto',
        ...(sessionRef ? ['--session', sessionRef] : []),
        '--prompt',
      ],
      promptArg: true,
      eventTransport: 'stream-json',
    }
  }
  if (kind === 'mimo') {
    if (!attachments.length && options.invocationTransport !== 'json') {
      return {
        command: executable,
        args: ['acp', '--pure', '--cwd', workdir],
        acpMode: options.sandbox === 'workspace-write' ? 'build' : 'plan',
        eventTransport: 'acp',
        fallbackTransport: 'json',
        fallbackSessionPolicy: 'preserve',
      }
    }
    return {
      command: executable,
      args: [
        'run', '--pure', '--agent', options.sandbox === 'workspace-write' ? 'build' : 'plan',
        '--format', 'json', '--dir', workdir,
        ...(sessionRef ? ['--session', sessionRef] : []),
      ],
      promptArg: true,
    }
  }
  if (kind === 'claude') {
    return {
      command: executable,
      args: [
        '--print',
        '--output-format', 'stream-json',
        '--include-partial-messages',
        '--verbose',
        '--permission-mode', options.sandbox === 'workspace-write' ? 'acceptEdits' : 'plan',
        ...(sessionRef ? ['--resume', sessionRef] : []),
      ],
      promptArg: true,
    }
  }
  if (kind === 'qwen') {
    return {
      command: executable,
      args: [
        '--output-format', 'stream-json',
        '--include-partial-messages',
        '--approval-mode', options.sandbox === 'workspace-write' ? 'auto-edit' : 'plan',
        ...(sessionRef ? ['--resume', sessionRef] : []),
      ],
      promptArg: true,
    }
  }
  if (kind === 'gemini') {
    return {
      command: executable,
      args: [
        '--output-format', 'stream-json',
        '--approval-mode', options.sandbox === 'workspace-write' ? 'auto_edit' : 'plan',
        ...(sessionRef ? ['--resume', sessionRef] : []),
        '--prompt',
      ],
      promptArg: true,
    }
  }
  if (kind === 'opencode') {
    if (!attachments.length && options.invocationTransport !== 'json') {
      return {
        command: executable,
        args: ['acp', '--pure', '--cwd', workdir],
        acpMode: options.sandbox === 'workspace-write' ? 'build' : 'plan',
        eventTransport: 'acp',
        fallbackTransport: 'json',
        fallbackSessionPolicy: 'preserve',
      }
    }
    return {
      command: executable,
      args: [
        'run', '--format', 'json',
        '--agent', options.sandbox === 'workspace-write' ? 'build' : 'plan',
        ...(sessionRef ? ['--session', sessionRef] : []),
        ...attachments.flatMap(filename => ['--file', filename]),
      ],
      promptArg: true,
    }
  }
  if (kind === 'opencodereview') {
    return {
      command: executable,
      args: [
        'review', '--audience', 'agent', '--format', 'json', '--repo', workdir,
        '--background',
      ],
      promptArg: true,
    }
  }
  throw new Error('LOCAL_AGENT_KIND_UNSUPPORTED')
}

module.exports = {
  imageAttachmentLimit,
  invocation,
}

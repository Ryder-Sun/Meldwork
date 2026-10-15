const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-workspace-'))
  let id = 0
  let runId = 0
  const calls = []
  const agents = [
    { kind: 'codex', name: 'Codex CLI', executable: '/tmp/codex', version: '1' },
    { kind: 'hermes', name: 'Hermes CLI', executable: '/tmp/hermes', version: '2' },
    { kind: 'workbuddy', name: 'WorkBuddy CLI', executable: '/tmp/codebuddy', version: '3' },
    { kind: 'kimi', name: 'Kimi CLI', executable: '/tmp/kimi', version: '4' },
    { kind: 'openclaw', name: 'OpenClaw CLI', executable: '/tmp/openclaw', version: '5' },
  ]
  let runAgentImpl = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    return {
      text: `${agent.kind} reply ${calls.length}`,
      sessionRef: runOptions.sessionRef || `${agent.kind}-session`,
      outcome: 'completed',
    }
  }
  const options = {
    storagePath: path.join(directory, 'workspace.json'),
    detectAgents: async () => agents,
    credentialState: async () => ({ state: 'ready', source: 'native-credential' }),
    resolveAttachments: async refs => refs.map(ref => ({
      id: ref.id,
      name: ref.name,
      mimeType: ref.mimeType,
      size: ref.size,
      path: path.join(directory, 'attachments', `${ref.id}.png`),
    })),
    validateSkillSelections: (_kind, selections) => selections,
    validateKnowledgeBaseSelections: (_kinds, selections) => selections,
    imageAttachmentLimit: kind => ({ codex: 4, hermes: 1, opencode: 4 })[kind] || 0,
    captureAgentOutputs: async () => null,
    importAgentOutputs: async () => [],
    now: () => '2026-07-28T00:00:00.000Z',
    createId: () => `id-${++id}`,
    createRunId: () => `run-${++runId}`,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 4,
    // Gate-focused tests opt out explicitly; production defaults to yolo.
    defaultYolo: false,
    naturalAgentResponses: false,
  }
  Object.defineProperty(options, 'runAgent', {
    enumerable: true,
    configurable: true,
    get() {
      return async (...args) => {
        const result = await runAgentImpl(...args)
        return result && typeof result === 'object' && !result.outcome
          ? { ...result, outcome: 'completed' }
          : result
      }
    },
    set(value) {
      runAgentImpl = value
    },
  })
  return { directory, calls, options }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

module.exports = { deferred, fixture }

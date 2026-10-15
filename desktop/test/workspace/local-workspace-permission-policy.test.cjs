const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { fixture } = require('../support/local-workspace-test-helpers.cjs')

const OPTIONS = [
  { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'deny', name: 'Reject once', kind: 'reject_once' },
]

async function decisionsFor(allowWrite) {
  const { directory, options } = fixture()
  // Production answers permission prompts automatically (the fixture
  // defaults to Human Gates for gate-focused tests).
  options.defaultYolo = true
  const decisions = {}
  options.runAgent = async (_agent, _prompt, _cwd, runOptions) => {
    for (const kind of ['read', 'search', 'edit', 'execute', 'switch_mode', undefined]) {
      decisions[kind || 'unknown'] = await runOptions.onPermissionRequest({
        sessionId: 'session', toolCall: { toolCallId: `tool-${kind}`, ...(kind ? { kind } : {}) }, options: OPTIONS,
      })
    }
    return { text: 'done', sessionRef: runOptions.sessionRef || 'codex-session' }
  }
  try {
    const workspace = new LocalWorkspace(options)
    await workspace.refreshAgents()
    const group = workspace.createGroup({
      name: 'Permissions', agentKinds: ['codex'], workdir: directory, allowWrite,
      conversationType: 'direct', directAgentKind: 'codex',
    })
    await workspace.sendMessage({ groupId: group.id, text: 'Inspect the project' })
    return decisions
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('read-only turns auto-approve only side-effect-free ACP tools', async () => {
  const decisions = await decisionsFor(false)
  assert.deepEqual(decisions.read, { status: 'approved', optionId: 'allow' })
  assert.deepEqual(decisions.search, { status: 'approved', optionId: 'allow' })
  for (const kind of ['edit', 'execute', 'switch_mode', 'unknown']) {
    assert.deepEqual(decisions[kind], { status: 'rejected', optionId: 'deny' }, kind)
  }
})

test('writable turns keep approving tool permissions automatically', async () => {
  const decisions = await decisionsFor(true)
  for (const kind of ['read', 'edit', 'execute']) {
    assert.deepEqual(decisions[kind], { status: 'approved', optionId: 'allow' }, kind)
  }
})

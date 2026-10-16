const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { fixture } = require('../support/local-workspace-test-helpers.cjs')

function documentFixture(options, directory) {
  const sourceRoot = path.join(directory, 'attachments')
  const sourcePath = path.join(sourceRoot, 'report.pdf')
  fs.mkdirSync(sourceRoot)
  fs.writeFileSync(sourcePath, '%PDF-1.7\n')
  options.attachmentSupport = () => ({ image: 4, file: 4 })
  options.resolveAttachments = async refs => refs.map(ref => ({ ...ref, path: sourcePath }))
  return {
    sourceRoot,
    attachment: { id: 'document-1', name: 'report.pdf', mimeType: 'application/pdf', size: 9 },
  }
}

test('manual group replies receive the attached document and tell each Agent its role', async (t) => {
  const { directory, calls, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { sourceRoot, attachment } = documentFixture(options, directory)
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Report review', agentKinds: ['codex', 'hermes'], workdir: directory, allowWrite: false,
  })

  await workspace.sendMessage({
    groupId: group.id, text: 'Review the report', mode: 'manual', protocol: 'v4',
    targetKinds: group.agentKinds, attachments: [attachment],
  })

  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.match(call.prompt, /Review the report/)
    assert.match(call.prompt, /\.meldwork-input\/\.run-[^/]+\/1-report\.pdf/)
    assert.equal(call.prompt.includes(sourceRoot), false)
    assert.match(call.prompt, /Everyone replies on their own at the same time/)
    assert.match(call.prompt, /This reply is read-only/)
    assert.doesNotMatch(call.prompt, /MELDWORK_COLLABORATION|capabilit|intendedWork/)
  }
  assert.equal(fs.existsSync(path.join(directory, '.meldwork-input')), false)
  assert.deepEqual(workspace.snapshot().messages[0].attachments, [attachment])
})

test('an automatic discussion hands the attached document to every participant', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const { sourceRoot, attachment } = documentFixture(options, directory)
  const prompts = []
  const workspace = new LocalWorkspace({
    ...options,
    naturalAgentResponses: true,
    runAgent: async (agent, prompt) => {
      prompts.push({ kind: agent.kind, prompt })
      return {
        outcome: 'completed',
        text: `${agent.kind} read the report.\n\n[[MELDWORK_COLLABORATION:${JSON.stringify({
          summary: 'Reviewed.',
          taskDecision: { status: 'completed', reason: 'Done', deliverables: ['The review'] },
        })}]]`,
      }
    },
  })
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Report discussion', agentKinds: ['codex', 'hermes'], workdir: directory, allowWrite: false,
  })

  await workspace.sendMessage({
    groupId: group.id, text: 'Discuss the report', mode: 'auto', protocol: 'v4',
    targetKinds: group.agentKinds, attachments: [attachment], maxRounds: 2,
  })
  await workspace.activeRuns.get(group.id).promise

  assert.ok(prompts.length >= 2)
  for (const { prompt } of prompts) {
    assert.match(prompt, /\.meldwork-input\/\.run-[^/]+\/1-report\.pdf/)
    assert.equal(prompt.includes(sourceRoot), false)
    assert.match(prompt, /Group: Report discussion/)
    assert.match(prompt, /Answer in English, the language of the user task/)
  }
  assert.equal(fs.existsSync(path.join(directory, '.meldwork-input')), false)
})

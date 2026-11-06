const test = require('node:test')
const assert = require('node:assert/strict')
const { roundsMethods } = require('../../src/workspace/local-workspace-auto-runner-rounds.cjs')

test('resuming a legacy round with no cursor number enters a valid first round', async () => {
  const controller = {
    orchestration: { activeKinds: [], pendingKinds: [], successfulKinds: [], agreementKinds: [] },
    targetKinds: [], signal: { aborted: false }, unlimitedRounds: false, failedKinds: [],
  }
  const runner = { checkpointOrchestration() {}, emitChanged() {}, addMessage() {} }
  const result = await roundsMethods.runRounds.call(runner, { id: 'group' }, controller, 'root', 1,
    { rootAttachments: [], rootSkillsByKind: new Map(), rootKnowledgeBasesByKind: new Map() }, true)
  assert.equal(controller.currentRound, 1)
  assert.equal(result, 'failed')
})

for (const failure of ['LOCAL_BUDGET_EXHAUSTED', 'LOCAL_RUN_CIRCUIT_BREAKER']) {
  test(`${failure} prevents subsequent Agent invocations`, async () => {
    const signal = { aborted: false }
    const controller = {
      targetKinds: ['first', 'second'], signal, unlimitedRounds: true,
      failedKinds: [], completedKinds: [], attemptHistory: [], currentRound: 0,
      abort() { signal.aborted = true },
    }
    const invoked = []
    const runner = {
      checkpointOrchestration() {}, emitChanged() {}, setCurrentAgent() {},
      prepareCollaborationPackage() { return {} }, recordAgentFailure() {}, addMessage() {},
      async invokeWithUnauthorizedRecovery({ kind }) { invoked.push(kind); throw new Error(failure) },
    }
    await roundsMethods.runRounds.call(runner, { id: 'group' }, controller, 'root', 5,
      { rootAttachments: [], rootSkillsByKind: new Map(), rootKnowledgeBasesByKind: new Map() })
    assert.deepEqual(invoked, ['first'])
    assert.equal(signal.aborted, true)
  })
}

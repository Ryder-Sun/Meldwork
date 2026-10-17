import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLocale } from '../../i18n.js'
import { mountApp } from './app-test-harness.js'

const gateId = `human-gate-${'e'.repeat(64)}`

function addPendingDecision(state) {
  state.groups.push(
    {
      id: 'group-needs-you',
      conversationType: 'group',
      name: 'Release review',
      topic: '',
      agentKinds: ['codex', 'hermes'],
      workdir: '/tmp/meldwork-workspace',
      allowWrite: false,
      createdAt: '2026-08-04T08:00:00.000Z',
      updatedAt: '2026-08-04T08:00:00.000Z',
    },
    {
      id: 'group-quiet',
      conversationType: 'group',
      name: 'Quiet group',
      topic: '',
      agentKinds: ['codex', 'hermes'],
      workdir: '/tmp/meldwork-workspace',
      allowWrite: false,
      createdAt: '2026-08-04T07:00:00.000Z',
      updatedAt: '2026-08-04T07:00:00.000Z',
    },
  )
  state.messages.push({
    id: 'needs-you-root',
    groupId: 'group-needs-you',
    role: 'user',
    content: 'Check the release',
    targetKinds: ['codex', 'hermes'],
    createdAt: '2026-08-04T08:00:00.000Z',
  })
  state.runningGroupIds = ['group-needs-you']
  state.runs = [{
    runId: 'run-needs-you',
    groupId: 'group-needs-you',
    threadRootId: 'needs-you-root',
    targetKinds: ['codex', 'hermes'],
    currentKind: 'codex',
    waitingGateIds: [gateId],
    agentRuns: [{
      agentRunId: 'agent-needs-you',
      kind: 'codex',
      round: 1,
      status: 'waiting',
      output: '',
      events: [],
    }],
  }]
  state.humanGates = [{
    gateId,
    type: 'permission',
    runId: 'run-needs-you',
    agentRunId: 'agent-needs-you',
    agentKind: 'codex',
    summary: 'Agent requests permission to continue a tool action.',
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ],
    status: 'pending',
    createdAt: '2026-08-04T08:00:00.000Z',
  }]
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('meldwork-theme', 'light')
  localStorage.setItem('meldwork-onboarding-seen-v1', '1')
  setLocale('en')
})

afterEach(() => {
  delete window.meldworkDesktop
  document.body.innerHTML = ''
})

describe('decisions waiting on the user', () => {
  it('marks only the waiting conversation in the sidebar and lists it on the home page', async () => {
    const { wrapper } = await mountApp(({ state }) => addPendingDecision(state))

    const rows = wrapper.findAll('.group-conversation-row')
    const waitingRow = rows.find(row => row.text().includes('Release review'))
    const quietRow = rows.find(row => row.text().includes('Quiet group'))
    // The decision mark replaces the running bars, so the row reads "needs you", not "busy".
    expect(waitingRow.find('.attention-mark').attributes('aria-label')).toBe('Waiting for your decision')
    expect(waitingRow.find('.run-mark').exists()).toBe(false)
    expect(quietRow.find('.attention-mark').exists()).toBe(false)

    const item = wrapper.get('.home-attention-item')
    expect(wrapper.get('.home-attention-header').text()).toContain('Needs your attention')
    expect(item.text()).toContain('Codex is waiting for you: Permission')
    expect(item.text()).toContain('Release review')

    await item.trigger('click')
    await flushPromises()
    expect(wrapper.get('.conversation-header h1').text()).toBe('Release review')
    // Once the conversation is open, its own row no longer needs the mark.
    expect(wrapper.findAll('.group-conversation-row')
      .find(row => row.text().includes('Release review'))
      .find('.attention-mark').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows a dot on the collapsed group switcher instead of a total count', async () => {
    const { wrapper } = await mountApp(({ state }) => addPendingDecision(state))

    await wrapper.get('.sidebar-toggle').trigger('click')
    const switcher = wrapper.get('.collapsed-group-switcher-button')
    expect(switcher.text()).toBe('')
    expect(switcher.find('.attention-dot').exists()).toBe(true)
    wrapper.unmount()
  })

  it('keeps the home page free of the attention list when nothing is waiting', async () => {
    const { wrapper } = await mountApp()

    expect(wrapper.find('.home-attention').exists()).toBe(false)
    wrapper.unmount()
  })

  it('marks a group discussion that finished while you were elsewhere, then clears it when opened', async () => {
    const { wrapper, state, emitRunFinished } = await mountApp(({ state: fixture }) => {
      fixture.groups.push(
        {
          id: 'group-done',
          conversationType: 'group',
          name: 'Finished discussion',
          topic: '',
          agentKinds: ['codex', 'hermes'],
          workdir: '/tmp/meldwork-workspace',
          allowWrite: false,
          createdAt: '2026-08-04T08:00:00.000Z',
          updatedAt: '2026-08-04T08:00:00.000Z',
        },
        {
          id: 'group-other',
          conversationType: 'group',
          name: 'Where I am now',
          topic: '',
          agentKinds: ['codex', 'hermes'],
          workdir: '/tmp/meldwork-workspace',
          allowWrite: false,
          createdAt: '2026-08-04T07:00:00.000Z',
          updatedAt: '2026-08-04T07:00:00.000Z',
        },
      )
      fixture.messages.push({
        id: 'done-root',
        groupId: 'group-done',
        role: 'user',
        content: 'Discuss the plan',
        targetKinds: ['codex', 'hermes'],
        createdAt: '2026-08-04T08:00:00.000Z',
      })
    })
    void state
    wrapper.vm.selectGroup('group-other')
    await flushPromises()

    // A failed or stopped run is not a "finished" cue.
    emitRunFinished({ groupId: 'group-done', threadRootId: 'done-root', status: 'failed' })
    await flushPromises()
    const doneRow = () => wrapper.findAll('.group-conversation-row').find(row => row.text().includes('Finished discussion'))
    expect(doneRow().find('.run-finished-mark').exists()).toBe(false)

    emitRunFinished({ groupId: 'group-done', threadRootId: 'done-root', status: 'completed' })
    await flushPromises()
    expect(doneRow().get('.run-finished-mark').attributes('aria-label')).toBe('Run finished')

    wrapper.vm.selectGroup('group-done')
    await flushPromises()
    wrapper.vm.selectGroup('group-other')
    await flushPromises()
    expect(doneRow().find('.run-finished-mark').exists()).toBe(false)
    wrapper.unmount()
  })
})

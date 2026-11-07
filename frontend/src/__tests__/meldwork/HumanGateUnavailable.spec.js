import { mount } from '@vue/test-utils'
import { expect, it } from 'vitest'
import RunTracePanel from '../../components/RunTracePanel.vue'
import { t } from '../../i18n.js'

it('explains unavailable decision context and permits rejection only', async () => {
  const gate = { gateId: 'gate', type: 'decision', agentRunId: 'agent-run', agentKind: 'codex',
    summary: 'Choose an outcome.', decisionContextUnavailable: true,
    options: [{ optionId: 'approve', name: 'Approve', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' }] }
  const wrapper = mount(RunTracePanel, { props: { open: true, selectedAgentRunId: 'agent-run',
    items: [{ agentRunId: 'agent-run', agentKind: 'codex', status: 'waiting', round: 1, events: [] }],
    humanGates: [gate] } })
  expect(wrapper.get('[role="alert"]').text()).toBe(t('humanGate.contextUnavailable'))
  const buttons = wrapper.findAll('.trace-human-gate-options button')
  expect(buttons[0].attributes('disabled')).toBeDefined()
  expect(buttons[1].attributes('disabled')).toBeUndefined()
  await buttons[1].trigger('click')
  expect(wrapper.emitted('decide-human-gate')?.[0]?.[0]).toEqual({ gateId: 'gate', optionId: 'reject' })
  wrapper.unmount()
})

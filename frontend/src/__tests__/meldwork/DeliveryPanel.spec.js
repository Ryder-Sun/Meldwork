import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DeliveryPanel from '../../components/DeliveryPanel.vue'
import { setLocale } from '../../i18n.js'

function fixture(outputKind = 'text') {
  const task = {
    id: 'delivery-1', groupId: 'group-1',
    brief: { title: 'Monthly brief', goal: 'Explain progress', output: 'Brief', outputKind, criteria: ['Sources checked'], language: 'en' },
    revision: null, attempts: [{ runId: 'run-1', status: 'completed', sources: [], input: '', revision: null }],
    versions: [{ id: 'version-1', runId: 'run-1', createdAt: '2026-10-19', responses: [{ messageId: 'message-1', agentKind: 'codex', content: 'Actual result' }], attachments: [], checks: ['pending'], notes: '', acceptedAt: '' }],
  }
  const api = {
    localDelivery: Object.fromEntries(['save', 'review', 'revise', 'reuse', 'export'].map(key => [key, vi.fn(async () => ({ taskId: task.id, saved: true }))])),
    localAttachments: { open: vi.fn(async () => {}) },
  }
  const snapshot = { deliveryTasks: [task], runs: [], runningGroupIds: [] }
  const wrapper = mount(DeliveryPanel, { props: { groupId: 'group-1', snapshot, api } })
  return { wrapper, api, task, snapshot }
}
async function select(wrapper) {
  await wrapper.get('.delivery-bar button').trigger('click')
  await wrapper.get('select[aria-label="Select task"]').setValue('delivery-1')
}
function button(wrapper, text) { return wrapper.findAll('button').find(item => item.text() === text) }
beforeEach(() => setLocale('en'))

describe('delivery panel', () => {
  it('starts collapsed with regular chat and requires explicit human checks before acceptance', async () => {
    const { wrapper, api } = fixture()
    expect(wrapper.find('.delivery-body').exists()).toBe(false)
    expect(wrapper.emitted('bind').at(-1)).toEqual([''])
    await select(wrapper)
    expect(wrapper.text()).toContain('Actual result')
    expect(button(wrapper, 'Accept this version').attributes('disabled')).toBeDefined()
    await wrapper.get('.delivery-check select').setValue('met')
    await button(wrapper, 'Accept this version').trigger('click')
    await flushPromises()
    expect(api.localDelivery.review).toHaveBeenCalledWith({ taskId: 'delivery-1', versionId: 'version-1', checks: ['met'], notes: '', accept: true })
    await wrapper.trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('.delivery-body').exists()).toBe(false)
    wrapper.unmount()
  })

  it('does not accept a file claim without an attachment or treat cancelled exports as success', async () => {
    const { wrapper, api } = fixture('files')
    await select(wrapper)
    await wrapper.get('.delivery-check select').setValue('met')
    expect(button(wrapper, 'Accept this version').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('no actual file')
    expect(button(wrapper, 'Export Markdown').attributes('disabled')).toBeDefined()
    await wrapper.get('.delivery-check select').setValue('pending')
    api.localDelivery.export.mockResolvedValueOnce({ saved: false })
    await button(wrapper, 'Export Markdown').trigger('click')
    await flushPromises()
    expect(api.localDelivery.export).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('notify')).toBeUndefined()
    wrapper.unmount()
  })

  it('saves a revision against the selected version without starting an Agent', async () => {
    const { wrapper, api, snapshot, task } = fixture()
    await select(wrapper)
    await wrapper.get('form textarea').setValue('Shorten it')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(api.localDelivery.revise).toHaveBeenCalledWith({ taskId: task.id, baseVersionId: 'version-1', note: 'Shorten it' })
    const changed = structuredClone(snapshot)
    changed.deliveryTasks[0].revision = { baseVersionId: 'version-1', note: 'Shorten it' }
    await wrapper.setProps({ snapshot: changed })
    expect(wrapper.emitted('bind').at(-1)).toEqual([task.id])
    await wrapper.get('select[aria-label="Select task"]').setValue('')
    expect(wrapper.emitted('bind').at(-1)).toEqual([''])
    wrapper.unmount()
  })

  it('creates an editable task with the sample and keeps regular chat available', async () => {
    const { wrapper, api, snapshot } = fixture()
    await wrapper.get('.delivery-bar button').trigger('click')
    await button(wrapper, 'New task').trigger('click')
    await button(wrapper, 'Use project brief example').trigger('click')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(api.localDelivery.save.mock.calls[0][0].brief.criteria).toHaveLength(3)
    const draft = structuredClone(snapshot)
    draft.deliveryTasks[0].versions = []
    draft.deliveryTasks[0].attempts = []
    await wrapper.setProps({ snapshot: draft })
    expect(wrapper.emitted('bind').at(-1)).toEqual(['delivery-1'])
    wrapper.unmount()
  })
})

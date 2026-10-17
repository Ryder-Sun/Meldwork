import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLocale } from '../../i18n.js'
import { mountApp } from './app-test-harness.js'

function addGroups(state) {
  for (const [id, name] of [['group-a', 'Alpha review'], ['group-b', 'Beta review']]) {
    state.groups.push({
      id,
      conversationType: 'group',
      name,
      topic: '',
      agentKinds: ['codex', 'hermes'],
      workdir: '/tmp/meldwork-workspace',
      allowWrite: false,
      createdAt: '2026-08-04T08:00:00.000Z',
      updatedAt: '2026-08-04T08:00:00.000Z',
    })
  }
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('meldwork-theme', 'light')
  localStorage.setItem('meldwork-onboarding-seen-v1', '1')
  setLocale('en')
})

afterEach(() => {
  delete window.meldworkDesktop
  document.body.className = ''
  document.body.innerHTML = ''
})

async function open(wrapper, groupId) {
  wrapper.vm.selectGroup(groupId)
  await flushPromises()
  return wrapper.get('.composer-box textarea')
}

describe('composer drafts', () => {
  it('keeps unsent text for each conversation when switching between them', async () => {
    const { wrapper } = await mountApp(({ state }) => addGroups(state))

    let input = await open(wrapper, 'group-a')
    await input.setValue('Compare the two migration plans')
    input = await open(wrapper, 'group-b')
    // Another conversation starts clean...
    expect(input.element.value).toBe('')
    await input.setValue('Summarise the open risks')

    // ...and each one gets its own text back.
    input = await open(wrapper, 'group-a')
    expect(input.element.value).toBe('Compare the two migration plans')
    input = await open(wrapper, 'group-b')
    expect(input.element.value).toBe('Summarise the open risks')
    wrapper.unmount()
  })

  it('forgets a draft once it has been sent', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => addGroups(state))

    let input = await open(wrapper, 'group-a')
    await input.setValue('Review the release notes')
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()
    expect(bridge.localWorkspace.send).toHaveBeenCalledTimes(1)

    await open(wrapper, 'group-b')
    input = await open(wrapper, 'group-a')
    expect(input.element.value).toBe('')
    wrapper.unmount()
  })

  it('does not bring back text typed into a conversation that was deleted', async () => {
    const { wrapper, state, emitWorkspaceChanged } = await mountApp(({ state: fixture }) => addGroups(fixture))

    const input = await open(wrapper, 'group-a')
    await input.setValue('This conversation is about to disappear')
    await open(wrapper, 'group-b')

    state.groups = state.groups.filter(group => group.id !== 'group-a')
    emitWorkspaceChanged()
    await flushPromises()
    state.groups.push({
      id: 'group-a',
      conversationType: 'group',
      name: 'Alpha review',
      topic: '',
      agentKinds: ['codex', 'hermes'],
      workdir: '/tmp/meldwork-workspace',
      allowWrite: false,
      createdAt: '2026-08-04T09:00:00.000Z',
      updatedAt: '2026-08-04T09:00:00.000Z',
    })
    emitWorkspaceChanged()
    await flushPromises()

    expect((await open(wrapper, 'group-a')).element.value).toBe('')
    wrapper.unmount()
  })
})

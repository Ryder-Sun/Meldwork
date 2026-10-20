import { afterEach, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import WorkPreferences from '../../components/WorkPreferences.vue'
import { locale } from '../../i18n.js'

afterEach(() => { delete window.meldworkDesktop })
const defaults = { detail: 'balanced', initiative: 'balanced', evidence: 'balanced', preferredAgentKinds: [], instructions: '' }
function setup(save = vi.fn(async value => value)) {
  locale.value = 'en'
  window.meldworkDesktop = {
    workPreferences: { get: vi.fn(async () => defaults), save },
    localWorkspace: { get: vi.fn(async () => ({ agents: [{ kind: 'codex', installed: true }] })) },
  }
  return { wrapper: mount(WorkPreferences), save }
}

it('lets users preview a preset, customize and explicitly save bounded preferences', async () => {
  const { wrapper, save } = setup()
  await flushPromises()
  expect(save).not.toHaveBeenCalled()
  await wrapper.get('.work-presets button').trigger('click')
  await wrapper.get('textarea').setValue('Give me a comparison table.')
  await wrapper.get('input[type="checkbox"]').setValue(true)
  await wrapper.get('form').trigger('submit')
  await flushPromises()
  expect(save).toHaveBeenCalledWith({ ...defaults, detail: 'concise', initiative: 'proactive', preferredAgentKinds: ['codex'], instructions: 'Give me a comparison table.' })
  expect(wrapper.find('[role="status"]').exists()).toBe(true)
  await wrapper.get('textarea').setValue('Changed')
  expect(wrapper.find('[role="status"]').exists()).toBe(false)
  expect(wrapper.get('textarea').attributes('maxlength')).toBe('800')
  wrapper.unmount()
})

it('keeps unsaved choices on a busy error and resets only the form', async () => {
  const save = vi.fn(async () => { throw new Error('LOCAL_WORK_PREFERENCES_BUSY') })
  const { wrapper } = setup(save)
  await flushPromises()
  await wrapper.get('textarea').setValue('Keep this draft')
  await wrapper.get('form').trigger('submit')
  await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toBeTruthy()
  expect(wrapper.get('textarea').element.value).toBe('Keep this draft')
  expect(wrapper.find('[role="status"]').exists()).toBe(false)
  await wrapper.get('.work-preferences-actions button[type="button"]').trigger('click')
  expect(wrapper.get('textarea').element.value).toBe('')
  expect(save).toHaveBeenCalledTimes(1)
  wrapper.unmount()
})

it('does not render unsupported controls without the desktop bridge', () => {
  const wrapper = mount(WorkPreferences)
  expect(wrapper.find('section').exists()).toBe(false)
  wrapper.unmount()
})

it('updates collaborators when startup detection finishes without overwriting the draft', async () => {
  const { wrapper } = setup()
  let changed
  const unsubscribe = vi.fn()
  window.meldworkDesktop.localWorkspace.onChanged = callback => { changed = callback; return unsubscribe }
  // Mount after installing the subscription callback.
  wrapper.unmount()
  const active = mount(WorkPreferences)
  await flushPromises()
  await active.get('textarea').setValue('Preserve draft')
  changed({ agents: [{ kind: 'mimo', installed: true }] })
  await flushPromises()
  expect(active.get('input[type="checkbox"]').element.value).toBe('mimo')
  expect(active.get('textarea').element.value).toBe('Preserve draft')
  active.unmount()
  expect(unsubscribe).toHaveBeenCalledOnce()
})

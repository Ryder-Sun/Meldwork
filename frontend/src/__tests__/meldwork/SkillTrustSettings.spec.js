import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import SkillTrustSettings from '../../components/SkillTrustSettings.vue'
import { t } from '../../i18n.js'

afterEach(() => { delete window.meldworkDesktop })

it('reviews and explicitly revokes an Agent-specific Skill approval', async () => {
  const entry = { bindingId: 'binding', state: 'approved', coordinates: { name: 'Review', targetKind: 'codex' }, contentHash: 'abc', manifest: {
    identity: { version: '1.0.0' }, origin: { publisher: 'Local' }, permissionMode: 'read-only', sideEffectClass: 'none', tools: [], networkDestinations: [],
  } }
  const api = { list: vi.fn().mockResolvedValue([entry]), revoke: vi.fn(async () => { entry.state = 'revoked' }) }
  window.meldworkDesktop = { localSkillTrust: api }
  const wrapper = mount(SkillTrustSettings)
  await flushPromises()
  expect(wrapper.text()).toContain('Review')
  expect(wrapper.text()).toContain('codex')
  await vi.waitFor(() => expect(wrapper.get('.skill-trust-actions button').attributes('disabled')).toBeUndefined())
  await wrapper.findAll('button').find(button => button.text() === t('skillTrust.revoke')).trigger('click')
  expect(api.revoke).not.toHaveBeenCalled()
  await flushPromises()
  await wrapper.findAll('button').find(button => button.text() === t('skillTrust.revoke')).trigger('click')
  await flushPromises()
  expect(api.revoke).toHaveBeenCalledWith('binding')
  expect(wrapper.text()).toContain(t('skillTrust.revoked'))
  wrapper.unmount()
})

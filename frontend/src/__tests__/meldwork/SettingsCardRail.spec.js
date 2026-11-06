import { mount } from '@vue/test-utils'
import { describe, it, expect, vi } from 'vitest'
import SettingsCardRail from '../../components/SettingsCardRail.vue'
import { nextTick } from 'vue'

async function pointer(node, type, clientX, pointerId = 1) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 })
  Object.defineProperties(event, { pointerId: { value: pointerId }, pointerType: { value: 'mouse' } })
  node.dispatchEvent(event)
  await nextTick()
}

describe('settings card rail', () => {
  it('preserves the scroll position and selection when the parent updates for a theme change', async () => {
    const wrapper = mount(SettingsCardRail, { props: { label: 'Light theme' }, slots: { default: '<article><div class="rail-card-surface"><button class="agent-card-main">Agent</button></div></article>' } })
    const track = wrapper.get('[role="region"]')
    Object.defineProperties(track.element, { clientWidth: { value: 320 }, scrollWidth: { value: 960 }, scrollLeft: { value: 320, writable: true } })
    await track.trigger('scroll')
    wrapper.get('article').element.classList.add('rail-selected')
    for (let index = 0; index < 10; index++) {
      await wrapper.setProps({ label: index % 2 ? 'Light theme' : 'Dark theme' })
      expect(track.element.scrollLeft).toBe(320)
      expect(track.element.style.height).toBe('')
      expect(wrapper.get('article').classes()).toContain('rail-selected')
    }
    wrapper.unmount()
  })
  it('selects and enlarges only the clicked card without invoking its action', async () => {
    const wrapper = mount(SettingsCardRail, { props: { label: 'Agents' }, slots: { default: '<article><button class="agent-card-main">One</button><button class="action">Chat</button></article><article><button class="agent-card-main">Two</button></article>' } })
    await wrapper.findAll('.agent-card-main')[0].trigger('click')
    expect(wrapper.findAll('.rail-selected')).toHaveLength(1)
    expect(wrapper.findAll('.agent-card-main')[0].attributes('aria-pressed')).toBe('true')
    await wrapper.get('.action').trigger('click')
    expect(wrapper.findAll('article')[0].classes()).toContain('rail-selected')
    await wrapper.findAll('.agent-card-main')[1].trigger('click')
    expect(wrapper.findAll('article')[0].classes()).not.toContain('rail-selected')
    expect(wrapper.findAll('article')[1].classes()).toContain('rail-selected')
    await wrapper.findAll('.agent-card-main')[1].trigger('click')
    expect(wrapper.findAll('.rail-selected')).toHaveLength(0)
    wrapper.unmount()
  })
  it('updates paging controls and keeps nested inputs independent of arrow navigation', async () => {
    const wrapper = mount(SettingsCardRail, { props: { label: 'Agents' }, slots: { default: '<article><input /></article><article>Second</article>' } })
    const track = wrapper.get('[role="region"]')
    Object.defineProperties(track.element, { clientWidth: { value: 320 }, scrollWidth: { value: 680 }, scrollLeft: { value: 0, writable: true } })
    track.element.scrollBy = vi.fn()
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    await track.trigger('scroll')
    expect(wrapper.findAll('button')[0].element.disabled).toBe(true)
    await wrapper.findAll('button')[1].trigger('click')
    expect(track.element.scrollLeft).toBe(272)
    track.element.scrollBy.mockClear()
    await wrapper.get('input').trigger('keydown', { key: 'ArrowLeft' })
    expect(track.element.scrollBy).not.toHaveBeenCalled()
    track.element.scrollLeft = 360
    await track.trigger('scroll')
    expect(wrapper.findAll('button')[1].element.disabled).toBe(true)
    wrapper.unmount()
    vi.unstubAllGlobals()
  })

  it('drags cards with a mouse, suppresses the drag click and preserves normal button clicks', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const click = vi.fn()
    const wrapper = mount(SettingsCardRail, { props: { label: 'Agents' }, slots: { default: '<article><button>Open</button><input /></article><article>Second</article>' } })
    const track = wrapper.get('[role="region"]')
    Object.defineProperties(track.element, { clientWidth: { value: 320 }, scrollWidth: { value: 720 }, scrollLeft: { value: 0, writable: true } })
    wrapper.get('article button').element.addEventListener('click', click)
    wrapper.get('article button').element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    expect(click).toHaveBeenCalledTimes(1)
    await pointer(track.element, 'pointerdown', 250)
    await pointer(track.element, 'pointermove', 150)
    expect(track.element.scrollLeft).toBe(100)
    expect(track.classes()).toContain('dragging')
    await pointer(track.element, 'pointerup', 150)
    wrapper.get('article button').element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    expect(click).toHaveBeenCalledTimes(1)
    expect(track.classes()).not.toContain('dragging')
    await pointer(wrapper.get('input').element, 'pointerdown', 250, 2)
    await pointer(track.element, 'pointermove', 150, 2)
    expect(track.classes()).not.toContain('dragging')
    wrapper.unmount()
    vi.unstubAllGlobals()
  })
})

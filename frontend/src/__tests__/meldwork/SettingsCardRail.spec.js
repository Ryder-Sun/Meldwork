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

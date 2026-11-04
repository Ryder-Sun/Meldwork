<template>
  <div class="settings-card-rail">
    <div class="rail-heading">
    <slot name="heading" />
    <div class="rail-controls">
      <button type="button" :aria-label="t('settingsRail.previous')" :disabled="!canPrevious" @click="move(-1)"><ChevronBackOutline /></button>
      <span class="rail-position" aria-hidden="true">{{ position }} <span>/ {{ count }}</span></span>
      <button type="button" :aria-label="t('settingsRail.next')" :disabled="!canNext" @click="move(1)"><ChevronForwardOutline /></button>
    </div>
    </div>
    <div ref="track" class="rail-track" :class="{ dragging }" :style="railHeight ? { height: `${railHeight}px` } : undefined" tabindex="0" role="region" :aria-label="label" @scroll.passive="update" @keydown="onKey" @pointerdown="startDrag" @pointermove="drag" @pointerup="endDrag" @pointercancel="cancelDrag" @lostpointercapture="cancelDrag" @click.capture="guardClick" @dragstart.prevent @wheel.passive="stopAnimation">
      <slot />
    </div>
    <div class="rail-progress" aria-hidden="true"><span :style="{ transform: `scaleX(${progress})` }" /></div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUpdated, onBeforeUnmount } from 'vue'
import { ChevronBackOutline, ChevronForwardOutline } from '@vicons/ionicons5'
import { t } from '../i18n.js'
defineProps({ label: { type: String, required: true } })
const track = ref(null)
const canPrevious = ref(false)
const canNext = ref(false)
const dragging = ref(false)
const position = ref(1)
const count = ref(0)
const progress = ref(0)
const railHeight = ref(0)
let observer
let gesture = null
let animation = 0
let lastDrag = -Infinity
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
function stopAnimation() { cancelAnimationFrame(animation); animation = 0; track.value?.classList.remove('settling') }
function update() {
  const node = track.value
  if (!node) return
  canPrevious.value = node.scrollLeft > 2
  canNext.value = node.scrollLeft + node.clientWidth < node.scrollWidth - 2
  const cards = [...node.children]
  const visible = cards.filter(card => {
    const left = card.offsetLeft - node.offsetLeft - node.scrollLeft
    return left < node.clientWidth && left + card.offsetWidth > 0
  })
  const height = Math.max(0, ...visible.map(card => card.offsetHeight))
  railHeight.value = height ? height + 36 : 0
  count.value = cards.length
  const closest = cards.reduce((best, card, index) => Math.abs(card.offsetLeft - node.offsetLeft - node.scrollLeft) < best.distance
    ? { index, distance: Math.abs(card.offsetLeft - node.offsetLeft - node.scrollLeft) } : best, { index: 0, distance: Infinity })
  position.value = cards.length ? closest.index + 1 : 0
  progress.value = node.scrollWidth > node.clientWidth ? node.scrollLeft / (node.scrollWidth - node.clientWidth) : 1
  const reduce = reducedMotion()
  for (const card of cards) {
    const distance = (card.offsetLeft - node.offsetLeft - node.scrollLeft + card.offsetWidth / 2 - node.clientWidth / 2) / Math.max(node.clientWidth, 1)
    card.style.setProperty('--rail-angle', `${reduce ? 0 : Math.max(-1, Math.min(1, distance)) * -3}deg`)
  }
}
// Carousel interaction adapted from React Bits: velocity-directed snapping and spring settling.
function settle(target) {
  stopAnimation()
  const node = track.value
  if (!node) return
  target = Math.max(0, Math.min(target, node.scrollWidth - node.clientWidth))
  if (reducedMotion()) { node.scrollLeft = target; update(); return }
  let velocity = 0
  let previous = performance.now()
  node.classList.add('settling')
  function frame(now) {
    const dt = Math.min((now - previous) / 1000, 0.032)
    previous = now
    velocity += ((target - node.scrollLeft) * 300 - velocity * 30) * dt
    node.scrollLeft += velocity * dt
    if (Math.abs(target - node.scrollLeft) < 1 && Math.abs(velocity) < 8) {
      node.scrollLeft = target
      node.classList.remove('settling')
      update()
      animation = 0
    } else animation = requestAnimationFrame(frame)
  }
  animation = requestAnimationFrame(frame)
}
function startDrag(event) {
  stopAnimation()
  if (event.pointerType === 'touch' || event.button !== 0 || event.target.closest('input, textarea, select, summary, [contenteditable="true"]')) return
  gesture = { id: event.pointerId, x: event.clientX, scroll: track.value.scrollLeft, previousX: event.clientX, time: performance.now(), velocity: 0 }
}
function drag(event) {
  if (!gesture || event.pointerId !== gesture.id) return
  const delta = event.clientX - gesture.x
  if (!dragging.value && Math.abs(delta) < 6) return
  if (!dragging.value) { dragging.value = true; track.value.classList.add('dragging'); track.value.setPointerCapture?.(event.pointerId) }
  event.preventDefault()
  const now = performance.now()
  gesture.velocity = (event.clientX - gesture.previousX) / Math.max(now - gesture.time, 1)
  gesture.previousX = event.clientX
  gesture.time = now
  track.value.scrollLeft = gesture.scroll - delta
  update()
}
function endDrag(event) {
  if (!gesture || event.pointerId !== gesture.id) return
  const current = gesture
  const moved = dragging.value
  cancelDrag()
  if (!moved) return
  const node = track.value
  const projected = node.scrollLeft - (performance.now() - current.time < 100 ? current.velocity * 170 : 0)
  const targets = [...node.children].map(card => card.offsetLeft - node.offsetLeft)
  targets.push(node.scrollWidth - node.clientWidth)
  settle(targets.reduce((best, value) => Math.abs(value - projected) < Math.abs(best - projected) ? value : best, 0))
}
function cancelDrag() {
  const id = gesture?.id
  if (dragging.value) lastDrag = performance.now()
  gesture = null
  dragging.value = false
  track.value?.classList.remove('dragging')
  if (id !== undefined && track.value?.hasPointerCapture?.(id)) track.value.releasePointerCapture(id)
}
function guardClick(event) {
  if (event.detail !== 0 && performance.now() - lastDrag < 350) { event.preventDefault(); event.stopImmediatePropagation() }
}
function move(direction) {
  const node = track.value
  const card = node?.firstElementChild
  if (node) settle(node.scrollLeft + direction * ((card?.offsetWidth || node.clientWidth * 0.85) + (card?.offsetWidth ? 16 : 0)))
}
function onKey(event) {
  if (event.target !== track.value || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return
  event.preventDefault()
  move(event.key === 'ArrowLeft' ? -1 : 1)
}
onMounted(() => {
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(update)
    observer.observe(track.value)
    for (const card of track.value.children) observer.observe(card)
  }
  update()
})
onUpdated(() => {
  if (observer && track.value) for (const card of track.value.children) observer.observe(card)
  update()
})
onBeforeUnmount(() => { observer?.disconnect(); stopAnimation(); cancelDrag() })
</script>

<style scoped>
.settings-card-rail { min-width: 0; position: relative; }
.rail-heading { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; min-width: 0; }
.rail-heading > :deep(header) { min-width: 0; }
.rail-controls { flex: 0 0 auto; display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
.rail-position { min-width: 42px; text-align: center; color: var(--text); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
.rail-position > span { color: var(--faint); margin-left: 4px; }
.rail-controls button { display: grid; place-items: center; width: 30px; height: 30px; border: 0; background: transparent; color: var(--muted); cursor: pointer; }
.rail-controls button:hover:not(:disabled) { color: var(--accent-text); }
.rail-controls svg { width: 18px; height: 18px; }
.rail-track { box-sizing: border-box; display: flex; align-items: flex-start; gap: 16px; overflow-x: auto; padding: 12px 2px 24px; scroll-snap-type: x proximity; scroll-padding-inline: 2px; overscroll-behavior-x: contain; scrollbar-width: none; perspective: 1400px; cursor: grab; }
.rail-track.dragging, .rail-track.settling { scroll-snap-type: none; }
.rail-track.dragging, .rail-track.dragging :deep(*) { cursor: grabbing; user-select: none; }
.rail-progress { height: 2px; background: var(--border); overflow: hidden; border-radius: 2px; }
.rail-progress > span { display: block; height: 100%; background: var(--accent-text); transform-origin: left; }
.rail-track::-webkit-scrollbar { display: none; }
.rail-track::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
.rail-track > :deep(*) { flex: 0 0 min(360px, 88%); min-width: 0; scroll-snap-align: start; }
.rail-track > :deep(article) { transform: rotateY(var(--rail-angle, 0deg)); transform-origin: center; transition: background-color 200ms ease, box-shadow 250ms ease; animation: rail-arrive 420ms cubic-bezier(.2,.7,.2,1) both; }
.rail-track > :deep(article:nth-child(2)) { animation-delay: 50ms; }
.rail-track > :deep(article:nth-child(3)) { animation-delay: 100ms; }
.rail-track > :deep(article:hover) { background: var(--surface-raised); box-shadow: 0 10px 28px color-mix(in srgb, var(--text) 9%, transparent); }
.rail-track > :deep(.settings-agent-card) { display: flex; flex-direction: column; min-height: 0; padding: 18px; gap: 14px; }
.rail-track :deep(.agent-card-main) { padding: 0; grid-template-columns: 38px minmax(0, 1fr) 16px; gap: 12px; }
.rail-track :deep(.agent-card-meta-row) { margin: 0; padding: 0; gap: 8px; }
.rail-track :deep(.agent-card-actions) { padding: 0; }
.rail-track :deep(.agent-card-note) { padding: 0; flex-wrap: wrap; }
.rail-track :deep(.agent-card-note > span) { flex: 1 1 180px; }
.rail-track :deep(.workbuddy-settings) { padding: 0; }
.rail-track :deep(.agent-name-row) { flex-wrap: wrap; gap: 8px; }
.rail-track :deep(.agent-card-description) { display: block; overflow: visible; -webkit-line-clamp: unset; }
.rail-track > :deep(.knowledge-base-item), .rail-track > :deep(.knowledge-base-future-item) { display: flex; flex-direction: column; gap: 16px; padding: 18px; }
.rail-track :deep(.knowledge-base-item-main) { width: 100%; display: grid; grid-template-columns: 38px minmax(0, 1fr); gap: 12px; }
.rail-track :deep(.knowledge-base-logo) { width: 38px; height: 38px; }
.rail-track :deep(.knowledge-base-item-title-row) { flex-wrap: wrap; gap: 6px 12px; }
.rail-track :deep(.knowledge-base-item-copy strong) { white-space: normal; overflow: visible; }
.rail-track :deep(.knowledge-base-card-description) { display: block; overflow: visible; -webkit-line-clamp: unset; }
.rail-track :deep(.knowledge-base-action) { position: static; align-self: flex-start; margin-top: auto; max-width: 100%; }
.rail-track :deep(.knowledge-base-path) { max-width: 100%; overflow-wrap: anywhere; }
.rail-track :deep(.knowledge-base-path code) { white-space: normal; }
@keyframes rail-arrive { from { opacity: 0; translate: 18px 6px; } to { opacity: 1; translate: 0 0; } }
@media (prefers-reduced-motion: reduce) { .rail-track > :deep(article) { transition: none; animation: none; transform: none; } }
</style>

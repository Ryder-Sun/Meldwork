<template>
  <div class="settings-card-rail" :class="{ compact }">
    <div class="rail-heading">
    <slot name="heading" />
    <div class="rail-controls">
      <button type="button" :aria-label="t('settingsRail.previous')" :disabled="!canPrevious" @click="move(-1)"><ChevronBackOutline /></button>
      <span class="rail-position" aria-hidden="true">{{ position }} <span>/ {{ count }}</span></span>
      <button type="button" :aria-label="t('settingsRail.next')" :disabled="!canNext" @click="move(1)"><ChevronForwardOutline /></button>
    </div>
    </div>
    <div ref="track" class="rail-track" :class="{ dragging }"  tabindex="0" role="region" :aria-label="label" @scroll.passive="update" @keydown="onKey" @pointerdown="startDrag" @pointermove="drag" @pointerup="endDrag" @pointercancel="cancelDrag" @lostpointercapture="cancelDrag" @click.capture="guardClick" @dragstart.prevent @wheel.passive="stopAnimation">
      <slot />
    </div>
    <div class="rail-progress" aria-hidden="true"><span :style="{ transform: `scaleX(${progress})` }" /></div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUpdated, onBeforeUnmount } from 'vue'
import { ChevronBackOutline, ChevronForwardOutline } from '@vicons/ionicons5'
import { t } from '../i18n.js'
const props = defineProps({ label: { type: String, required: true }, compact: Boolean })
const track = ref(null)
const canPrevious = ref(false)
const canNext = ref(false)
const dragging = ref(false)
const position = ref(1)
const count = ref(0)
const progress = ref(0)
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
  count.value = cards.length
  const closest = cards.reduce((best, card, index) => Math.abs(card.offsetLeft - node.offsetLeft - node.scrollLeft + card.offsetWidth / 2 - node.clientWidth / 2) < best.distance
    ? { index, distance: Math.abs(card.offsetLeft - node.offsetLeft - node.scrollLeft + card.offsetWidth / 2 - node.clientWidth / 2) } : best, { index: 0, distance: Infinity })
  position.value = cards.length ? closest.index + 1 : 0
  progress.value = node.scrollWidth > node.clientWidth ? node.scrollLeft / (node.scrollWidth - node.clientWidth) : 1
  const reduce = reducedMotion()
  for (const card of cards) {
    const offset = card.offsetLeft - node.offsetLeft - node.scrollLeft + card.offsetWidth / 2 - node.clientWidth / 2
    const radius = Math.max(node.clientWidth * .72, 420)
    const angle = Math.max(-.42, Math.min(.42, offset / radius))
    card.style.setProperty('--rail-x', `${reduce ? 0 : Math.sin(angle) * radius - offset}px`)
    card.style.setProperty('--rail-depth', `${reduce ? 0 : -radius * (1 - Math.cos(angle))}px`)
    card.style.setProperty('--rail-angle', `${reduce ? 0 : -angle * 180 / Math.PI}deg`)
    card.style.setProperty('--rail-opacity', String(Math.max(.38, 1 - Math.abs(angle) * .48)))

  }
}
// Cylindrical projection with velocity-directed snapping and spring settling.
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
  const targets = [...node.children].map(card => card.offsetLeft - node.offsetLeft + card.offsetWidth / 2 - node.clientWidth / 2)
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
  if (event.detail !== 0 && performance.now() - lastDrag < 350) { event.preventDefault(); event.stopImmediatePropagation(); return }
  const card = event.target.closest('article')
  if (!card || card.parentElement !== track.value || card.classList.contains('settings-agent-card')) return
  if (event.target.closest('button') && !event.target.closest('.agent-card-main, .knowledge-base-item-main')) return
  const selected = !card.classList.contains('rail-selected')
  for (const item of track.value.children) {
    item.classList.toggle('rail-selected', item === card && selected)
    item.querySelector('.agent-card-main, .knowledge-base-item-main')?.setAttribute('aria-pressed', String(item === card && selected))
  }
  if (selected) settle(card.offsetLeft - track.value.offsetLeft + card.offsetWidth / 2 - track.value.clientWidth / 2)
}
function move(direction) {
  const node = track.value
  const card = node?.firstElementChild
  if (node) settle(node.scrollLeft + direction * ((card?.offsetWidth || node.clientWidth * 0.85) + (card?.offsetWidth ? 20 : 0)))
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
  if (!props.compact && track.value.children.length > 2) {
    const card = track.value.children[2]
    track.value.scrollLeft = card.offsetLeft - track.value.offsetLeft + card.offsetWidth / 2 - track.value.clientWidth / 2
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
.rail-heading { display:flex; justify-content:space-between; align-items:center; gap:16px; }
.rail-controls { display:flex; align-items:center; gap:6px; }
.rail-controls button { width:32px; height:32px; display:grid; place-items:center; border:0; background:transparent; color:var(--muted); cursor:pointer; }
.rail-controls svg { width:18px; }
.rail-position { font-size:12px; color:var(--text); font-variant-numeric:tabular-nums; }
.rail-position span { color:var(--faint); }
.rail-track { --card-width: 176px; position:relative; box-sizing:border-box; display:flex; align-items:center; gap:20px; overflow-x:auto; padding:16px max(16px, calc(50% - var(--card-width) / 2)); scrollbar-width:none; perspective:850px; perspective-origin:50% 50%; cursor:grab; overscroll-behavior-x:contain; }
.rail-track::-webkit-scrollbar { display:none; }
.rail-track { scroll-snap-type:x proximity; }
.rail-track.dragging, .rail-track.settling { scroll-snap-type:none; }
.rail-track > :deep(article) { scroll-snap-align:center; }
.rail-track > :deep(article) { flex:0 0 var(--card-width); box-sizing:border-box; min-width:0; min-height:138px; display:flex; flex-direction:column; justify-content:center; gap:10px; padding:14px 12px; border:0; border-radius:16px; background:var(--surface-raised);  }
.rail-track > :deep(article.rail-selected) { --rail-scale:1.08; background:var(--surface); box-shadow:0 14px 32px color-mix(in srgb,var(--text) 10%,transparent); z-index:2; }
.rail-track :deep(.agent-card-main), .rail-track :deep(.knowledge-base-item-main) { width:100%; display:flex; flex-direction:column; align-items:center; text-align:center; padding:0; border:0; background:transparent; color:var(--text); gap:10px; cursor:pointer; }
.rail-track :deep(.settings-agent-logo), .rail-track :deep(.knowledge-base-logo) { width:34px; height:34px; }
.rail-track :deep(.settings-agent-logo img) { width:100%; height:100%; object-fit:contain; }
.rail-track :deep(.agent-name-row), .rail-track :deep(.knowledge-base-item-title-row) { display:flex; flex-direction:column; align-items:center; gap:5px; }
.rail-track :deep(strong) { font-size:12px; white-space:normal; }
.rail-track :deep(.agent-state), .rail-track :deep(.knowledge-base-status) { font-size:11px; white-space:normal; justify-content:center; }
.rail-track :deep(.agent-card-meta-row), .rail-track :deep(.agent-card-actions) { padding:0; margin:0; justify-content:center; width:100%; }
.rail-track :deep(.agent-card-actions button), .rail-track :deep(.knowledge-base-action) { min-height:32px; font-size:12px; border:0; background:transparent; padding:6px 8px; }
.rail-track :deep(.knowledge-base-action) { position:static; align-self:center; }
.rail-track.dragging, .rail-track.dragging :deep(*) { cursor:grabbing; user-select:none; }
.rail-progress { display:none; }
.rail-track :deep(button:focus-visible) { outline:2px solid var(--accent-text); outline-offset:4px; }
@media (prefers-reduced-motion:reduce) { .rail-track > :deep(article) { transform:none; transition:none; opacity:1; } }
@media (max-width:600px) { .rail-track { --card-width:160px; } }
.compact .rail-track { padding:12px 0; gap:12px; perspective:none; height:auto !important; }
.compact .rail-track > :deep(article) { flex:1 0 180px; min-height:0; padding:12px 14px; transform:none; opacity:1; }
.compact .rail-controls { display:none; }
.compact .rail-track :deep(.knowledge-base-item-main) { flex-direction:row; text-align:left; gap:12px; }
.compact .rail-track :deep(.knowledge-base-item-title-row) { align-items:flex-start; }
.compact .rail-track :deep(.knowledge-base-logo) { width:32px; height:32px; }
.compact .rail-track :deep(.knowledge-base-action) { align-self:flex-start; padding-left:44px; }

/* Fixed layout slots keep transforms out of scroll geometry. */
.rail-track > :deep(article) { height:180px; min-height:180px; padding:10px; overflow:clip; background:transparent; border-radius:0; perspective:850px; }
.rail-track > :deep(article.rail-selected) { background:transparent; box-shadow:none; }
.rail-track :deep(.rail-card-surface) { box-sizing:border-box; width:100%; height:100%; display:flex; flex-direction:column; justify-content:space-between; padding:14px 10px 10px; border-radius:12px; background:var(--surface-raised); transform:translateZ(var(--rail-depth,0px)) rotateY(var(--rail-angle,0deg)) scale(var(--rail-scale,1)); opacity:var(--rail-opacity,1); transition:background-color 180ms ease; }
.rail-track > :deep(article.rail-selected) { --rail-scale:1.04; }
.rail-track :deep(.agent-card-copy) { width:100%; min-width:0; }
.rail-track :deep(.agent-name-row) { width:100%; gap:6px; }
.rail-track :deep(.agent-name-row strong) { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden; line-height:1.35; min-height:32px; max-height:32px; overflow-wrap:anywhere; }
.rail-track :deep(.agent-state) { min-height:16px; font-size:10px; line-height:1.3; }
.rail-track :deep(.settings-agent-actions) { display:flex; flex-wrap:nowrap; align-items:center; gap:2px; }
.rail-track :deep(.settings-agent-actions button) { min-width:28px; min-height:32px; padding:4px; font-size:11px; white-space:nowrap; }
.rail-track :deep(.settings-agent-actions button svg) { width:15px; height:15px; flex:none; }
.compact .rail-track > :deep(article) { height:auto; min-height:0; }
.rail-track > :deep(article.install-expanded) { height:auto; min-height:280px; overflow:visible; }
.rail-track :deep(.install-confirm) { display:flex; flex-direction:column; gap:6px; font-size:11px; line-height:1.5; overflow-wrap:anywhere; }
.rail-track :deep(.install-progress) { font-size:11px; line-height:1.5; overflow-wrap:anywhere; }
@media (prefers-reduced-motion:reduce) { .rail-track :deep(.rail-card-surface) { transform:none; transition:none; opacity:1; } }

.rail-track :deep(.knowledge-base-action:hover:not(:disabled)) { color:var(--accent-text); background:var(--accent-soft); opacity:1; visibility:visible; }
.rail-track :deep(.knowledge-base-action:focus-visible) { color:var(--accent-text); background:var(--accent-soft); }
</style>

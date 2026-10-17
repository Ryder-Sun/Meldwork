<template>
  <Teleport to="body">
    <div
      ref="backdrop"
      class="attachment-media-preview-backdrop"
      role="presentation"
      @click.self="close"
    >
      <section
        ref="dialog"
        class="attachment-media-preview-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="attachment.name"
      >
        <button
          ref="closeButton"
          class="attachment-media-preview-close"
          type="button"
          :aria-label="closeLabel"
          :title="closeLabel"
          @click="close"
        >
          <CloseOutline aria-hidden="true" />
        </button>
        <img
          v-if="type === 'image'"
          :src="source"
          :alt="attachment.name"
        />
        <video
          v-else
          :src="source"
          :aria-label="attachment.name"
          controls
          autoplay
          playsinline
          preload="auto"
        />
        <p class="attachment-media-preview-caption" :title="attachment.name">{{ attachment.name }}</p>
      </section>
    </div>
  </Teleport>
</template>

<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { CloseOutline } from '@vicons/ionicons5'

const props = defineProps({
  attachment: { type: Object, required: true },
  closeLabel: { type: String, required: true },
  source: { type: String, required: true },
  type: { type: String, required: true },
})
const emit = defineEmits(['close'])

const backdrop = ref(null)
const closeButton = ref(null)
const dialog = ref(null)
let returnFocus = null

function close() {
  emit('close')
}

function handleKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
    return
  }
  if (event.key !== 'Tab') return
  // Keep focus inside the preview, but let it reach the video controls.
  const focusable = [...(dialog.value?.querySelectorAll('button, video[controls]') || [])]
  if (!focusable.length) return
  const index = focusable.indexOf(document.activeElement)
  const next = event.shiftKey
    ? focusable[(index - 1 + focusable.length) % focusable.length]
    : focusable[(index + 1) % focusable.length]
  event.preventDefault()
  next.focus()
}

onMounted(() => {
  const active = document.activeElement
  returnFocus = active instanceof HTMLElement ? active : null
  document.body.classList.add('media-preview-open')
  window.addEventListener('keydown', handleKeydown)
  void nextTick(() => closeButton.value?.focus())
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
  document.body.classList.remove('media-preview-open')
  void nextTick(() => {
    if (returnFocus?.isConnected) returnFocus.focus()
  })
})
</script>

<style>
body.media-preview-open {
  overflow: hidden;
}

.attachment-media-preview-backdrop {
  position: fixed;
  z-index: var(--z-lightbox);
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgb(10 14 20 / 78%);
  animation: media-preview-fade var(--dur-base) var(--ease-out) both;
}

.attachment-media-preview-dialog {
  animation: media-preview-zoom var(--dur-slow) var(--ease-out) both;
}

@keyframes media-preview-fade {
  from { opacity: 0; }
}

@keyframes media-preview-zoom {
  from { opacity: 0; transform: scale(0.96); }
}

.attachment-media-preview-dialog {
  position: relative;
  display: grid;
  max-width: min(1100px, 100%);
  max-height: 100%;
  place-items: center;
}

.attachment-media-preview-dialog img,
.attachment-media-preview-dialog video {
  display: block;
  max-width: 100%;
  max-height: calc(100vh - 88px);
  border-radius: var(--radius-sm);
  background: #080b10;
  object-fit: contain;
}

.attachment-media-preview-dialog img {
  width: auto;
  height: auto;
}

.attachment-media-preview-dialog video {
  width: min(1100px, calc(100vw - 48px));
}

.attachment-media-preview-close {
  position: absolute;
  z-index: 1;
  top: 10px;
  right: 10px;
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: rgb(0 0 0 / 62%);
  color: #fff;
  cursor: pointer;
}

.attachment-media-preview-close svg {
  width: 18px;
  height: 18px;
}

.attachment-media-preview-caption {
  max-width: 100%;
  margin: 10px 0 0;
  overflow: hidden;
  color: rgb(255 255 255 / 82%);
  font-size: var(--text-sm);
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attachment-media-preview-close:hover,
.attachment-media-preview-close:focus-visible {
  background: rgb(0 0 0 / 82%);
}

@media (max-width: 640px) {
  .attachment-media-preview-backdrop { padding: 12px; }
  .attachment-media-preview-dialog video { width: calc(100vw - 24px); }
  .attachment-media-preview-dialog img,
  .attachment-media-preview-dialog video { max-height: calc(100vh - 24px); }
}
</style>

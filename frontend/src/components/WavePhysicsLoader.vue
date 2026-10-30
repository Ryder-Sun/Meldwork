<template>
  <div class="wave-physics-loader" :data-theme="theme" aria-hidden="true">
    <div class="wave-physics-track">
      <span
        v-for="bar in bars"
        :key="bar.index"
        class="wave-physics-bar"
        :style="{ height: bar.height, backgroundColor: bar.color }"
      />
      <span
        class="wave-physics-ball"
        :style="{
          transform: `translate3d(${ball.x}, ${ball.y}, 0) scaleX(${ball.scaleX}) scaleY(${ball.scaleY})`,
          backgroundColor: ball.color,
        }"
      />
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

defineProps({
  theme: { type: String, default: 'light' },
})

const numBars = 15
const barWidth = 8
const barGap = 5
const barTotalWidth = barWidth + barGap
const B = 4
const maxBounce = 24
const baseBarH = 8
const wavePeakH = 24
const duration = 4000

const progress = ref(0.5)
let animationFrame = 0

function frameAt(t) {
  const xFrac = t < 0.5 ? t / 0.5 : (1 - t) / 0.5
  const ballIndex = xFrac * (numBars - 1)
  let bounceF = (xFrac * B) % 1
  if (xFrac === 0 || xFrac === 1) bounceF = 0

  const bounceH = 4 * bounceF * (1 - bounceF)
  const heightFactor = Math.max(0, 1 - bounceH * 2)
  const ballIndent = heightFactor * 10
  const ballY = (baseBarH + wavePeakH - ballIndent) + bounceH * maxBounce

  const bars = Array.from({ length: numBars }, (_unused, index) => {
    const dist = Math.abs(index - ballIndex)
    let waveValue = 0
    if (dist < 3) waveValue = Math.cos((dist / 3) * (Math.PI / 2))

    let indent = 0
    if (dist < 1.5) {
      const indentDist = Math.cos((dist / 1.5) * (Math.PI / 2))
      indent = indentDist * heightFactor * 10
    }

    const barHeight = Math.max(3, baseBarH + waveValue * wavePeakH - indent)

    return {
      color: `color-mix(in srgb, var(--accent) ${Math.round(waveValue * 100)}%, var(--accent-soft))`,
      height: `${barHeight}px`,
      index,
    }
  })

  return {
    bars,
    ball: {
      color: 'var(--accent)',
      scaleX: 1 + heightFactor * 0.25,
      scaleY: 1 - heightFactor * 0.3,
      x: `${ballIndex * barTotalWidth}px`,
      y: `-${ballY}px`,
    },
  }
}

const frame = computed(() => frameAt(progress.value))
const bars = computed(() => frame.value.bars)
const ball = computed(() => frame.value.ball)

onMounted(() => {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return
  if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

  const start = performance.now()

  const tick = (now) => {
    progress.value = ((now - start) % duration) / duration
    animationFrame = window.requestAnimationFrame(tick)
  }

  animationFrame = window.requestAnimationFrame(tick)
})

onBeforeUnmount(() => {
  if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(animationFrame)
  }
})
</script>

<style scoped>
.wave-physics-loader {
  width: 100%;
  display: flex;
  justify-content: center;
}

.wave-physics-track {
  position: relative;
  width: 190px;
  height: 72px;
  display: flex;
  align-items: flex-end;
  justify-content: flex-start;
  gap: 5px;
}

.wave-physics-bar {
  width: 8px;
  border-radius: 999px;
  transform-origin: bottom center;
  will-change: height, background-color;
}

.wave-physics-ball {
  position: absolute;
  left: 0;
  bottom: 0;
  width: 8px;
  height: 8px;
  border-radius: 999px;
  transform-origin: bottom center;
  box-shadow: 0 1px 3px color-mix(in srgb, currentColor 24%, transparent);
  will-change: transform, background-color;
}

@media (prefers-reduced-motion: reduce) {
  .wave-physics-bar,
  .wave-physics-ball {
    will-change: auto;
  }
}
</style>

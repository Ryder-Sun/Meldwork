<template>
  <div class="wave-physics-loader" aria-hidden="true">
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

const props = defineProps({
  theme: { type: String, default: 'light' },
})

const numBars = 15
const barWidth = 12
const barGap = 8
const barTotalWidth = barWidth + barGap
const B = 4
const maxBounce = 60
const baseBarH = 16
const wavePeakH = 48
const duration = 4000

const progress = ref(0.5)
let animationFrame = 0

function interpolate(start, end, value) {
  return Math.round(start + (end - start) * value)
}

function barColor(theme, waveValue) {
  if (theme === 'dark') {
    return `rgb(${interpolate(39, 228, waveValue)} ${interpolate(39, 228, waveValue)} ${interpolate(42, 231, waveValue)})`
  }
  return `rgb(${interpolate(228, 39, waveValue)} ${interpolate(228, 39, waveValue)} ${interpolate(231, 42, waveValue)})`
}

function frameAt(t) {
  const xFrac = t < 0.5 ? t / 0.5 : (1 - t) / 0.5
  const ballIndex = xFrac * (numBars - 1)
  let bounceF = (xFrac * B) % 1
  if (xFrac === 0 || xFrac === 1) bounceF = 0

  const bounceH = 4 * bounceF * (1 - bounceF)
  const heightFactor = Math.max(0, 1 - bounceH * 2)
  const ballIndent = heightFactor * 20
  const ballY = (baseBarH + wavePeakH - ballIndent) + bounceH * maxBounce

  const bars = Array.from({ length: numBars }, (_unused, index) => {
    const dist = Math.abs(index - ballIndex)
    let waveValue = 0
    if (dist < 3) waveValue = Math.cos((dist / 3) * (Math.PI / 2))

    let indent = 0
    if (dist < 1.5) {
      const indentDist = Math.cos((dist / 1.5) * (Math.PI / 2))
      indent = indentDist * heightFactor * 20
    }

    const barHeight = Math.max(4, baseBarH + waveValue * wavePeakH - indent)

    return {
      color: barColor(props.theme, waveValue),
      height: `${barHeight}px`,
      index,
    }
  })

  return {
    bars,
    ball: {
      color: props.theme === 'dark' ? 'rgb(244, 244, 245)' : 'rgb(24, 24, 27)',
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
  width: 292px;
  height: 192px;
  display: flex;
  align-items: flex-end;
  justify-content: flex-start;
  gap: 8px;
}

.wave-physics-bar {
  width: 12px;
  border-radius: 999px;
  transform-origin: bottom center;
  will-change: height, background-color;
}

.wave-physics-ball {
  position: absolute;
  left: 0;
  bottom: 0;
  width: 12px;
  height: 12px;
  border-radius: 999px;
  transform-origin: bottom center;
  box-shadow: 0 1px 3px color-mix(in srgb, currentColor 24%, transparent);
  will-change: transform, background-color;
}

@media (max-width: 640px) {
  .wave-physics-track {
    width: 260px;
    transform: scale(0.9);
    transform-origin: center;
  }
}

@media (prefers-reduced-motion: reduce) {
  .wave-physics-bar,
  .wave-physics-ball {
    will-change: auto;
  }
}
</style>

<template>
  <div
    ref="container"
    class="pixel-blast-container"
    :class="{ 'pixel-blast-ready': rendererReady }"
    aria-hidden="true"
  >
    <div class="pixel-blast-fallback" />
    <canvas ref="canvas" />
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps({
  theme: { type: String, default: 'light' },
})

const container = ref(null)
const canvas = ref(null)
const rendererReady = ref(false)
let runtime = null
let disposed = false

const VERTEX_SHADER = `
void main() {
  gl_Position = vec4(position, 1.0);
}
`

// Adapted from the React Bits PixelBlast shader (MIT).
const FRAGMENT_SHADER = `
precision highp float;

uniform vec2 uResolution;
uniform float uTime;
uniform float uPixelSize;
uniform float uScale;
uniform float uDensity;
uniform float uPixelJitter;
uniform float uEdgeFade;
uniform float uOpacity;
uniform vec3 uPrimaryColor;
uniform vec3 uSecondaryColor;
uniform vec3 uTertiaryColor;

out vec4 fragColor;

float Bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x / 2.0 + a.y * a.y * 0.75);
}

#define Bayer4(a) (Bayer2(0.5 * (a)) * 0.25 + Bayer2(a))
#define Bayer8(a) (Bayer4(0.5 * (a)) * 0.25 + Bayer2(a))

float hash11(float n) {
  return fract(sin(n) * 43758.5453);
}

float vnoise(vec3 p) {
  vec3 ip = floor(p);
  vec3 fp = fract(p);
  float n000 = hash11(dot(ip + vec3(0.0, 0.0, 0.0), vec3(1.0, 57.0, 113.0)));
  float n100 = hash11(dot(ip + vec3(1.0, 0.0, 0.0), vec3(1.0, 57.0, 113.0)));
  float n010 = hash11(dot(ip + vec3(0.0, 1.0, 0.0), vec3(1.0, 57.0, 113.0)));
  float n110 = hash11(dot(ip + vec3(1.0, 1.0, 0.0), vec3(1.0, 57.0, 113.0)));
  float n001 = hash11(dot(ip + vec3(0.0, 0.0, 1.0), vec3(1.0, 57.0, 113.0)));
  float n101 = hash11(dot(ip + vec3(1.0, 0.0, 1.0), vec3(1.0, 57.0, 113.0)));
  float n011 = hash11(dot(ip + vec3(0.0, 1.0, 1.0), vec3(1.0, 57.0, 113.0)));
  float n111 = hash11(dot(ip + vec3(1.0, 1.0, 1.0), vec3(1.0, 57.0, 113.0)));
  vec3 weight = fp * fp * fp * (fp * (fp * 6.0 - 15.0) + 10.0);
  float x00 = mix(n000, n100, weight.x);
  float x10 = mix(n010, n110, weight.x);
  float x01 = mix(n001, n101, weight.x);
  float x11 = mix(n011, n111, weight.x);
  return mix(mix(x00, x10, weight.y), mix(x01, x11, weight.y), weight.z) * 2.0 - 1.0;
}

float fbm(vec2 uv, float time) {
  vec3 point = vec3(uv * uScale, time);
  float amplitude = 1.0;
  float frequency = 1.0;
  float sum = 1.0;
  for (int index = 0; index < 5; ++index) {
    sum += amplitude * vnoise(point * frequency);
    frequency *= 1.25;
  }
  return sum * 0.5 + 0.5;
}

void main() {
  vec2 fragCoord = gl_FragCoord.xy - uResolution * 0.5;
  float aspectRatio = uResolution.x / uResolution.y;
  vec2 pixelId = floor(fragCoord / uPixelSize);
  vec2 pixelUv = fract(fragCoord / uPixelSize);
  float cellPixelSize = 8.0 * uPixelSize;
  vec2 cellCoord = floor(fragCoord / cellPixelSize) * cellPixelSize;
  vec2 fieldUv = cellCoord / uResolution * vec2(aspectRatio, 1.0);

  float motionTime = uTime * (1.0 + 0.12 * sin(uTime * 0.17));
  vec2 drift = vec2(sin(uTime * 0.41), cos(uTime * 0.33)) * 0.045;
  float field = fbm(fieldUv + drift, motionTime * 0.05) * 0.5 - 0.65;
  float feed = field + (uDensity - 0.5) * 0.3;
  float bayer = Bayer8(fragCoord / uPixelSize) - 0.5;
  float enabled = step(0.5, feed + bayer);
  float hash = fract(sin(dot(pixelId, vec2(127.1, 311.7))) * 43758.5453);
  float jitter = 1.0 + (hash - 0.5) * uPixelJitter;
  float inset = step(0.08, pixelUv.x) * step(0.08, pixelUv.y)
    * step(pixelUv.x, 0.92) * step(pixelUv.y, 0.92);
  float mask = enabled * jitter * inset;

  vec2 normalized = gl_FragCoord.xy / uResolution;
  float edge = min(min(normalized.x, normalized.y), min(1.0 - normalized.x, 1.0 - normalized.y));
  mask *= smoothstep(0.0, uEdgeFade, edge);
  float centerDistance = length((normalized - 0.5) * vec2(aspectRatio, 1.0));
  // Keep the message area visually calm while preserving the animated field
  // around the edges of the discovery screen.
  mask *= mix(0.1, 1.0, smoothstep(0.14, 0.46, centerDistance));

  float colorNoise = clamp(0.5 + 0.5 * vnoise(vec3((fieldUv + drift * 1.8) * 1.35, motionTime * 0.035)), 0.0, 1.0);
  vec3 color = mix(uPrimaryColor, uSecondaryColor, colorNoise);
  color = mix(color, uTertiaryColor, smoothstep(0.56, 1.0, normalized.y + colorNoise * 0.18));
  fragColor = vec4(color, mask * uOpacity);
}
`

function cssColor(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

function updateThemeColors() {
  if (!runtime) return
  runtime.uniforms.uPrimaryColor.value.set(cssColor('--pixel-blast-primary', '#d92f24'))
  runtime.uniforms.uSecondaryColor.value.set(cssColor('--pixel-blast-secondary', '#007d91'))
  runtime.uniforms.uTertiaryColor.value.set(cssColor('--pixel-blast-tertiary', '#ed512f'))
}

function disposeRuntime() {
  if (!runtime) return
  cancelAnimationFrame(runtime.animationFrame)
  runtime.resizeObserver.disconnect()
  runtime.geometry.dispose()
  runtime.material.dispose()
  runtime.renderer.dispose()
  runtime = null
  rendererReady.value = false
}

async function initializeRenderer() {
  if (!container.value || !canvas.value || typeof window.WebGL2RenderingContext === 'undefined') return
  try {
    const THREE = await import('three')
    if (disposed || !container.value || !canvas.value) return
    const renderer = new THREE.WebGLRenderer({
      canvas: canvas.value,
      alpha: true,
      antialias: false,
      powerPreference: 'high-performance',
    })
    renderer.setClearAlpha(0)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
    const uniforms = {
      uResolution: { value: new THREE.Vector2(1, 1) },
      uTime: { value: Math.random() * 1000 },
      uPixelSize: { value: 3.7 * renderer.getPixelRatio() },
      uScale: { value: 2.2 },
      uDensity: { value: 1.26 },
      uPixelJitter: { value: 0.32 },
      uEdgeFade: { value: 0.12 },
      uOpacity: { value: 0.42 },
      uPrimaryColor: { value: new THREE.Color() },
      uSecondaryColor: { value: new THREE.Color() },
      uTertiaryColor: { value: new THREE.Color() },
    }
    const scene = new THREE.Scene()
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      glslVersion: THREE.GLSL3,
    })
    const geometry = new THREE.PlaneGeometry(2, 2)
    scene.add(new THREE.Mesh(geometry, material))

    const resize = () => {
      const width = Math.max(1, container.value?.clientWidth || 1)
      const height = Math.max(1, container.value?.clientHeight || 1)
      renderer.setSize(width, height, false)
      uniforms.uResolution.value.set(renderer.domElement.width, renderer.domElement.height)
      uniforms.uPixelSize.value = 3.7 * renderer.getPixelRatio()
    }
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(container.value)
    runtime = {
      animationFrame: 0,
      geometry,
      material,
      renderer,
      resizeObserver,
      uniforms,
    }
    resize()
    updateThemeColors()
    rendererReady.value = true

    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
    let previousFrame = performance.now()
    const animate = (now) => {
      if (!runtime) return
      runtime.uniforms.uTime.value += Math.min(32, now - previousFrame) * 0.00036
      previousFrame = now
      renderer.render(scene, camera)
      if (!reducedMotion) runtime.animationFrame = requestAnimationFrame(animate)
    }
    runtime.animationFrame = requestAnimationFrame(animate)
  } catch {
    disposeRuntime()
  }
}

watch(() => props.theme, () => requestAnimationFrame(updateThemeColors))
onMounted(() => { void initializeRenderer() })
onBeforeUnmount(() => {
  disposed = true
  disposeRuntime()
})
</script>

<style scoped>
.pixel-blast-container,
.pixel-blast-container canvas,
.pixel-blast-fallback {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.pixel-blast-container {
  overflow: hidden;
  pointer-events: none;
}

.pixel-blast-container canvas {
  display: block;
  opacity: 0;
  transition: opacity 0.22s ease;
}

.pixel-blast-ready canvas {
  opacity: 1;
}

.pixel-blast-fallback {
  background-image:
    repeating-linear-gradient(90deg, transparent 0 5px, color-mix(in srgb, var(--pixel-blast-secondary) 38%, transparent) 5px 8px),
    repeating-linear-gradient(0deg, transparent 0 5px, color-mix(in srgb, var(--pixel-blast-primary) 34%, transparent) 5px 8px);
  opacity: 0.32;
  transition: opacity 0.22s ease;
  mask-image: linear-gradient(135deg, transparent 2%, black 34%, black 66%, transparent 98%);
}

.pixel-blast-ready .pixel-blast-fallback {
  opacity: 0;
}
</style>

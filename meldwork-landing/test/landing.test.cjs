const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('../../frontend/node_modules/jsdom')

const root = path.resolve(__dirname, '..')
const html = readFileSync(path.join(root, 'index.html'), 'utf8')
const scripts = ['i18n.js', 'glyph-embers.js', 'main.js'].map(file => readFileSync(path.join(root, file), 'utf8'))

test('release metadata, downloads, official logo and commercial licensing stay consistent', () => {
  const version = require('../../desktop/package.json').version
  assert.equal(require('../../frontend/package.json').version, version)
  assert.equal(require('../../desktop/package.json').license, 'Apache-2.0')
  assert.equal(require('../../frontend/package.json').license, 'Apache-2.0')
  assert.match(readFileSync(path.join(root, '..', 'LICENSE'), 'utf8'), /Apache License\s+Version 2\.0/)
  for (const name of ['LICENSE', 'NOTICE', 'COMMERCIAL_USE.md']) {
    assert.equal(readFileSync(path.join(root, name), 'utf8'), readFileSync(path.join(root, '..', name), 'utf8'))
  }
  for (const name of ['README.md', 'README.zh-CN.md', 'COMMERCIAL_USE.md']) {
    const source = readFileSync(path.join(root, '..', name), 'utf8')
    assert.match(source, /Apache/)
    assert.doesNotMatch(source, /Non-Commercial|non-commercial purposes|Commercial use requires prior|禁止商用/)
  }
  assert.deepEqual(readFileSync(path.join(root, 'assets/agents/zcode.png')), readFileSync(path.join(root, '../frontend/public/agent-logos/zcode.png')))
  for (const language of ['en', 'zh-CN']) {
    const p = page({ language })
    try {
      const schema = JSON.parse(p.doc.querySelector('script[type="application/ld+json"]').textContent)['@graph'][0]
      assert.equal(schema.softwareVersion, version)
      assert.equal(schema.license, 'https://www.apache.org/licenses/LICENSE-2.0')
      assert.match(p.doc.querySelector('.foot-meta').textContent, /Commercial use permitted|允许商用/)
      assert.doesNotMatch(p.doc.body.textContent, /Non-Commercial|non-commercial purposes|Commercial use requires prior|禁止商用/)
      for (const link of p.doc.querySelectorAll('a[href*="/releases/"]')) {
        assert.ok(link.href.includes(`Meldwork-V${version}`), link.href)
        if (link.href.includes('/download/')) assert.ok(link.href.endsWith(`Meldwork-${version}-arm64.dmg`), link.href)
      }
      const logos = [...p.doc.querySelectorAll('.logo-chip img')].map(el => el.getAttribute('src'))
      assert.ok(logos.indexOf('assets/agents/zcode.png') >= 0)
      assert.ok(logos.indexOf('assets/agents/zcode.png') < logos.indexOf('assets/agents/pi.svg'))
    } finally { p.dom.window.close() }
  }
})

function page({ language = 'en', saved, reduced = false, blockedStorage = false } = {}) {
  const dom = new JSDOM(html, { url: 'https://meldwork.test/', runScripts: 'outside-only', pretendToBeVisual: true })
  const { window } = dom
  const observers = []
  const timers = new Map()
  const frames = new Map()
  const mediaQueries = []
  let frameId = 0
  let emberDraws = 0
  let glyphSamples = []
  let timerId = 0
  Object.defineProperty(window.navigator, 'language', { value: language })
  if (saved) window.localStorage.setItem('meldwork-landing-locale', saved)
  if (blockedStorage) Object.defineProperty(window, 'localStorage', { get() { throw new Error('unavailable') } })
  window.matchMedia = () => {
    const query = { matches: reduced, addEventListener(name, callback) { this.onChange = callback } }
    mediaQueries.push(query)
    return query
  }
  window.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId }
  window.cancelAnimationFrame = id => frames.delete(id)
  window.setTimeout = (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId }
  window.clearTimeout = id => timers.delete(id)
  window.setInterval = window.setTimeout
  window.clearInterval = window.clearTimeout
  window.HTMLCanvasElement.prototype.getContext = function () {
    const canvas = this
    return { scale() {}, setTransform() {}, drawImage() {}, fillRect() {},
      createRadialGradient() { return { addColorStop() {} } },
      clearRect() { if (!canvas.id) glyphSamples = [] }, beginPath() {}, arc() {}, fill() {},
      fillText(glyph, x, y) {
        if (canvas.id !== 'bgCanvas') emberDraws++
        if (!canvas.id) glyphSamples.push({ glyph, x, y, color: this.fillStyle })
      } }
  }
  window.HTMLMediaElement.prototype.pause = () => {}
  window.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; this.targets = []; observers.push(this) }
    observe(target) { this.targets.push(target) }
    unobserve() {}
    disconnect() {}
  }
  window.ResizeObserver = class { observe() {} }
  scripts.forEach(source => window.eval(source))
  const doc = window.document
  const scenario = doc.querySelector('[data-scenario]')
  function inView(value) {
    const observer = observers.findLast(entry => entry.targets.includes(scenario))
    observer.callback([{ target: scenario, isIntersecting: value }])
  }
  function tick() {
    const timer = [...timers.entries()].find(([, value]) => value.delay >= 7000)
    assert.ok(timer, 'a reading-paced playback timer should exist')
    timers.delete(timer[0])
    timer[1].callback()
  }
  function runFrame(now) {
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach(callback => callback(now))
  }
  function setMotion(value) {
    mediaQueries.forEach(query => { query.matches = value; query.onChange?.() })
  }
  return { dom, window, doc, scenario, inView, tick, timers, runFrame, setMotion,
    emberDraws: () => emberDraws, glyphSamples: () => glyphSamples }
}

test('browser language, saved preference, repeated switching and metadata stay synchronized', () => {
  const p = page({ language: 'zh-CN' })
  try {
    assert.equal(p.doc.documentElement.lang, 'zh-CN')
    assert.match(p.doc.querySelector('h1').textContent, /提出目标/)
    assert.match(p.doc.title, /协作完成/)
    assert.equal(p.doc.querySelector('[data-pause]').textContent, '暂停播放')
    const toggle = p.doc.getElementById('languageToggle')
    toggle.click()
    assert.equal(p.doc.documentElement.lang, 'en')
    assert.equal(p.window.localStorage.getItem('meldwork-landing-locale'), 'en')
    assert.match(p.doc.querySelector('h1').textContent, /Set the Goal/)
    toggle.click()
    toggle.click()
    toggle.click()
    assert.equal(p.doc.querySelectorAll('#headline .hl-line').length, 2)
    assert.match(p.doc.querySelector('a[href*="README.zh-CN.md"]').textContent, /中文/)
    assert.equal(p.doc.querySelector('[data-next]').getAttribute('aria-label'), '下一步')
    const faq = JSON.parse(p.doc.querySelector('script[type="application/ld+json"]').textContent)['@graph'][1]
    assert.ok(faq.mainEntity.some(item => item.name === '我还需要介入吗？'))
    const savedPage = page({ language: 'zh', saved: 'en' })
    assert.equal(savedPage.doc.documentElement.lang, 'en')
    savedPage.dom.window.close()
  } finally { p.dom.window.close() }
})

test('unavailable storage still permits language switching', () => {
  const p = page({ blockedStorage: true, language: 'zh' })
  try {
    p.doc.getElementById('languageToggle').click()
    assert.equal(p.doc.documentElement.lang, 'en')
  } finally { p.dom.window.close() }
})

test('full-page copy has Chinese alternatives while links and emphasis survive switching', () => {
  const p = page()
  try {
    for (const el of p.doc.querySelectorAll('h1 .hl-line,h2,h3,p,.cta-ghost,.nav-link span,.m-link span,.stat-label,.meta-pill,.meta-name,.seg-btn,.t-time,.t-role,.cs-caption,.cmp-row > div,.bnd-col li,.acc-trigger > span:first-child,.foot-meta > span')) {
      assert.ok(el.hasAttribute('data-zh') || el.closest('[data-zh]'), el.outerHTML)
    }
    const linkCount = p.doc.querySelectorAll('a').length
    p.window.meldworkI18n.setLocale('zh')
    assert.equal(p.doc.querySelectorAll('a').length, linkCount)
    assert.ok(p.doc.querySelector('.t-bubble p strong'))
    p.doc.querySelector('.acc-trigger').click()
    assert.equal(p.doc.querySelector('.acc-trigger').getAttribute('aria-expanded'), 'true')
  } finally { p.dom.window.close() }
})

test('manual playback pauses and language switches preserve the current contribution', () => {
  const p = page()
  try {
    p.inView(true)
    assert.equal(p.scenario.dataset.playback, 'playing')
    p.tick()
    assert.equal(p.scenario.querySelector('[aria-current="step"]').dataset.step, '1')
    p.doc.querySelector('[data-next]').click()
    assert.equal(p.scenario.dataset.playback, 'paused')
    p.window.meldworkI18n.setLocale('zh')
    assert.equal(p.scenario.querySelector('[aria-current="step"]').dataset.step, '2')
    assert.equal(p.doc.querySelector('[data-round]').textContent, '第 2 轮 · 评审')
    assert.equal(p.doc.querySelector('[data-pause]').textContent, '继续播放')
    p.doc.querySelector('[data-pause]').click()
    assert.equal(p.scenario.dataset.playback, 'playing')
    p.inView(false)
    assert.equal(p.scenario.dataset.playback, 'paused')
  } finally { p.dom.window.close() }
})

test('autoplay stops at the last contribution and replay starts from the beginning', () => {
  const p = page()
  try {
    p.inView(true)
    for (let i = 0; i < 4; i++) p.tick()
    assert.equal(p.doc.querySelector('[data-status]').textContent, '5 / 5')
    assert.equal(p.scenario.dataset.playback, 'paused')
    assert.equal(p.doc.querySelector('[data-pause]').textContent, 'Replay')
    p.doc.querySelector('[data-pause]').click()
    assert.equal(p.doc.querySelector('[data-status]').textContent, '1 / 5')
  } finally { p.dom.window.close() }
})

test('hover and document visibility suspend playback without losing progress', () => {
  const p = page()
  try {
    p.inView(true)
    p.tick()
    p.scenario.dispatchEvent(new p.window.MouseEvent('mouseenter'))
    assert.equal(p.scenario.dataset.playback, 'paused')
    p.scenario.dispatchEvent(new p.window.MouseEvent('mouseleave'))
    assert.equal(p.scenario.dataset.playback, 'playing')
    Object.defineProperty(p.doc, 'hidden', { value: true, configurable: true })
    p.doc.dispatchEvent(new p.window.Event('visibilitychange'))
    assert.equal(p.scenario.dataset.playback, 'paused')
    Object.defineProperty(p.doc, 'hidden', { value: false, configurable: true })
    p.doc.dispatchEvent(new p.window.Event('visibilitychange'))
    assert.equal(p.scenario.dataset.playback, 'playing')
    assert.equal(p.doc.querySelector('[data-status]').textContent, '2 / 5')
  } finally { p.dom.window.close() }
})

test('keyboard navigation, focus pause and transcript mode keep playback under user control', () => {
  const p = page()
  try {
    p.inView(true)
    p.doc.querySelector('[data-next]').focus()
    assert.equal(p.scenario.dataset.playback, 'paused')
    p.scenario.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    assert.equal(p.doc.querySelector('[data-status]').textContent, '5 / 5')
    p.doc.querySelector('[data-mode="order"]').click()
    assert.ok(p.scenario.classList.contains('is-order'))
    assert.equal(p.doc.querySelector('[data-mode="order"]').getAttribute('aria-pressed'), 'true')
    assert.equal(p.scenario.dataset.playback, 'paused')
  } finally { p.dom.window.close() }
})

test('reduced motion defaults to a readable transcript without automatic playback', () => {
  const p = page({ reduced: true })
  try {
    p.inView(true)
    assert.ok(p.scenario.classList.contains('is-order'))
    p.doc.querySelector('[data-mode="auto"]').click()
    assert.equal(p.scenario.dataset.playback, 'paused')
    assert.equal([...p.timers.values()].some(value => value.delay >= 7000), false)
  } finally { p.dom.window.close() }
})

test('glyph background renders, caps frame rate, and stops drawing in a hidden page', () => {
  const p = page()
  try {
    const canvas = p.doc.getElementById('emberBackground')
    assert.equal(canvas.getAttribute('aria-hidden'), 'true')
    assert.equal(canvas.dataset.state, 'running')
    assert.ok(p.emberDraws() > 0)
    p.runFrame(100)
    const draws = p.emberDraws()
    p.runFrame(110)
    assert.equal(p.emberDraws(), draws, 'frames within 50ms should not repaint the glyph field')
    Object.defineProperty(p.doc, 'hidden', { value: true, configurable: true })
    p.doc.dispatchEvent(new p.window.Event('visibilitychange'))
    p.runFrame(200)
    assert.equal(canvas.dataset.state, 'paused')
    assert.equal(p.emberDraws(), draws)
    Object.defineProperty(p.doc, 'hidden', { value: false, configurable: true })
    p.doc.dispatchEvent(new p.window.Event('visibilitychange'))
    assert.equal(canvas.dataset.state, 'running')
  } finally { p.dom.window.close() }
})

test('glyph background switches to a static frame when reduced motion is enabled', () => {
  const p = page()
  try {
    p.setMotion(true)
    assert.equal(p.doc.getElementById('emberBackground').dataset.state, 'static')
    const draws = p.emberDraws()
    p.runFrame(200)
    assert.equal(p.emberDraws(), draws)
    p.setMotion(false)
    assert.equal(p.doc.getElementById('emberBackground').dataset.state, 'running')
  } finally { p.dom.window.close() }
})

test('fire has a dense bright bed, mixed letter glyphs, and uneven flame tips', () => {
  const p = page()
  try {
    const samples = p.glyphSamples()
    const height = p.window.innerHeight
    const bed = samples.filter(sample => sample.y > height - 12)
    assert.ok(bed.length > 100, 'the bed should be a continuous dense band')
    assert.ok(bed.every(sample => sample.color === 'rgb(255,250,232)'), 'the bed should burn ivory-white')
    assert.ok(new Set(samples.map(sample => sample.glyph)).size > 20, 'fire should use a varied ASCII density ramp')
    const tips = new Map()
    samples.forEach(sample => tips.set(sample.x, Math.min(tips.get(sample.x) ?? Infinity, sample.y)))
    assert.ok(Math.max(...tips.values()) - Math.min(...tips.values()) > height * 0.15, 'flame tongues should reach different heights')
    const first = samples.map(sample => sample.color + sample.glyph).join('')
    p.runFrame(100)
    p.runFrame(1100)
    assert.notEqual(p.glyphSamples().map(sample => sample.color + sample.glyph).join(''), first)
  } finally { p.dom.window.close() }
})

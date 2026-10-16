import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function rule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))
  return match ? match[1] : ''
}

const runs = readFileSync(resolve(process.cwd(), 'src/styles/conversation-runs.css'), 'utf8')
const composer = readFileSync(resolve(process.cwd(), 'src/styles/conversation-composer.css'), 'utf8')

// Overlapping avatars and chips order themselves with z-index. That number is
// only meaningful among siblings; if it reaches the page it beats every menu
// (the composer menu uses z-index 4). jsdom has no layout, so these tests pin
// the CSS that keeps the numbers contained; the behaviour was verified in a
// real renderer (the avatars covered the "@" menu before, none do now).
describe('composer menu stacking', () => {
  it('keeps the run avatar strip in its own stacking context', () => {
    const strip = rule(runs, '.relay-run-indicator')
    expect(strip).toMatch(/position:\s*relative;/)
    expect(strip).toMatch(/isolation:\s*isolate;/)
    // The avatars still order themselves among each other.
    expect(rule(runs, '.relay-run-agent')).toMatch(/z-index:\s*calc\(100 - var\(--avatar-index, 0\)\);/)
  })

  it('keeps the member chips inside the composer box whether or not it is focused', () => {
    const box = rule(composer, '.composer-box')
    expect(box).toMatch(/isolation:\s*isolate;/)
    expect(rule(composer, '.target-chip')).toMatch(/z-index:\s*calc\(var\(--stack-index, 0\) \+ 1\);/)
  })

  it('draws the menus above everything inside the composer', () => {
    const menu = rule(composer, '.skill-menu')
    expect(menu).toMatch(/position:\s*absolute;/)
    const level = Number(menu.match(/z-index:\s*(\d+);/)?.[1])
    // Page-level overlays that are allowed to sit above the menu are all
    // fixed-position and far higher; nothing in the conversation may reach it.
    expect(level).toBeGreaterThanOrEqual(4)
  })
})

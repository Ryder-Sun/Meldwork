import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useKnowledgeBaseSettings } from '../../composables/useKnowledgeBaseSettings.js'

function deferred() {
  let resolve
  const promise = new Promise(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

function obsidianStatus(vaultPath) {
  const ready = Boolean(vaultPath)
  return {
    kind: 'obsidian',
    accessMode: 'vault',
    installed: true,
    vaultPath,
    vaultDetails: {
      directory: ready,
      readable: ready,
      writable: ready,
    },
    probeState: 'ready',
    errorCode: '',
  }
}

describe('knowledge base status requests', () => {
  it('keeps bundled logos when a status response contains a conflicting logo', async () => {
    const settings = useKnowledgeBaseSettings({
      knowledgeBase: ref({ status: vi.fn(async () => [{ ...obsidianStatus(''), logo: '' }]) }),
      showError: vi.fn(),
    })
    await settings.loadKnowledgeBaseStatuses()
    const entries = [...settings.localKnowledgeBaseEntries.value, ...settings.plannedKnowledgeBaseEntries.value]
    expect(entries).toHaveLength(7)
    expect(entries.every(source => source.logo.startsWith('data:image/svg+xml,'))).toBe(true)
  })
  it('does not let an older full refresh overwrite a newer targeted result', async () => {
    const full = deferred()
    const targeted = deferred()
    const status = vi.fn((kind) => (kind === 'obsidian' ? targeted.promise : full.promise))
    const settings = useKnowledgeBaseSettings({
      knowledgeBase: ref({ status }),
      showError: vi.fn(),
    })

    const fullRequest = settings.loadKnowledgeBaseStatuses()
    const targetedRequest = settings.loadKnowledgeBaseStatuses('obsidian')
    targeted.resolve([obsidianStatus('/Users/rydersun/Documents/New Vault')])
    await targetedRequest
    full.resolve([obsidianStatus('')])
    await fullRequest

    const obsidian = settings.localKnowledgeBaseEntries.value.find(source => source.kind === 'obsidian')
    expect(obsidian.vaultPath).toBe('/Users/rydersun/Documents/New Vault')
    expect(settings.knowledgeBaseReady(obsidian)).toBe(true)
  })
})

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
  it('installs missing CLIs through the narrow desktop API and refreshes status', async () => {
    const installation = deferred()
    const source = { kind: 'feishu', accessMode: 'cli', installed: false, probeState: 'ready' }
    const api = { status: vi.fn(async () => [source]), install: vi.fn(() => installation.promise), openGuide: vi.fn() }
    const settings = useKnowledgeBaseSettings({ knowledgeBase: ref(api), showError: vi.fn() })
    await settings.loadKnowledgeBaseStatuses()
    const action = settings.runKnowledgeBasePrimaryAction(source)
    expect(api.install).toHaveBeenCalledWith('feishu')
    expect(settings.knowledgeBasePending(source)).toBe(true)
    await settings.runKnowledgeBasePrimaryAction(source)
    expect(api.install).toHaveBeenCalledTimes(1)
    installation.resolve(null)
    await action
    expect(settings.knowledgeBasePending(source)).toBe(false)
    expect(api.status).toHaveBeenLastCalledWith('feishu')
    expect(api.openGuide).not.toHaveBeenCalled()
  })
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

import { readFileSync as readNodeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RunTracePanel from '../../components/RunTracePanel.vue'
import { setLocale } from '../../i18n.js'
import { deferred, imageAttachment, mountApp } from './app-test-harness.js'
import { readStylesSource, STYLE_FILES } from './style-test-helpers.js'

function readFileSync(filename, encoding) {
  if (filename === resolve(process.cwd(), 'src/styles.css')) {
    return readStylesSource(filename)
  }
  return readNodeFileSync(filename, encoding)
}

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
const originalClipboard = navigator.clipboard
const originalExecCommand = document.execCommand

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('meldwork-theme', 'light')
  localStorage.setItem('meldwork-onboarding-seen-v1', '1')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async () => {}) },
  })
  setLocale('en')
})

afterEach(() => {
  vi.useRealTimers()
  delete window.meldworkDesktop
  document.body.className = ''
  document.body.innerHTML = ''
  if (originalScrollIntoView) HTMLElement.prototype.scrollIntoView = originalScrollIntoView
  else delete HTMLElement.prototype.scrollIntoView
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard })
  if (originalExecCommand) Object.defineProperty(document, 'execCommand', { configurable: true, value: originalExecCommand })
  else delete document.execCommand
  vi.restoreAllMocks()
})

describe('Meldwork workbench', () => {
  it('provides a dedicated cloud-server settings tab', async () => {
    const { wrapper } = await mountApp()

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    const cloudTab = wrapper.findAll('.settings-tabs button')
      .find(button => button.text().includes('Cloud servers'))
    await cloudTab.trigger('click')

    expect(wrapper.get('.cloud-agent-bridge-panel h2').text()).toBe('Cloud servers')
    expect(wrapper.get('.cloud-agent-connect-form').exists()).toBe(true)
    wrapper.unmount()
  })

  it('enables onboarding completion as soon as Agent detection finishes on any slide', async () => {
    vi.useFakeTimers()
    localStorage.removeItem('meldwork-onboarding-seen-v1')
    let finishDetection
    const pendingDetection = new Promise(resolve => { finishDetection = resolve })
    const { wrapper, state } = await mountApp(({ bridge }) => {
      bridge.localWorkspace.refreshAgents.mockReturnValueOnce(pendingDetection)
    })

    expect(wrapper.get('.onboarding-dialog').attributes('aria-modal')).toBe('true')
    expect(wrapper.findAll('.onboarding-dot')).toHaveLength(4)
    expect(wrapper.get('.onboarding-slide img').attributes('src')).toContain('discover-local-agents-meldwork.png')
    expect(wrapper.get('.onboarding-primary').attributes()).toHaveProperty('disabled')
    expect(wrapper.get('.onboarding-primary').text()).toContain('Detecting local Agents')
    expect(document.activeElement).toBe(wrapper.get('.onboarding-dialog').element)
    expect(wrapper.get('.sidebar').attributes()).toHaveProperty('inert')
    expect(wrapper.get('.workspace-pane').attributes()).toHaveProperty('inert')

    await wrapper.findAll('.onboarding-dot')[1].trigger('click')
    expect(wrapper.get('.onboarding-slide img').attributes('src')).toContain('agent-collaboration.png')
    expect(wrapper.findAll('.onboarding-dot')[1].attributes('aria-current')).toBe('step')
    expect(wrapper.get('.onboarding-primary').attributes()).toHaveProperty('disabled')
    expect(wrapper.get('.onboarding-primary').text()).toContain('Detecting local Agents')

    finishDetection(structuredClone(state))
    await flushPromises()

    expect(wrapper.get('.onboarding-slide img').attributes('src')).toContain('agent-collaboration.png')
    expect(wrapper.get('.onboarding-primary').attributes()).not.toHaveProperty('disabled')
    expect(wrapper.get('.onboarding-primary').text()).toContain('Get started')

    await vi.advanceTimersByTimeAsync(3_200)
    await flushPromises()
    expect(wrapper.get('.onboarding-slide img').attributes('src')).toContain('skills-and-images.png')

    await wrapper.get('.onboarding-primary').trigger('click')
    expect(wrapper.find('.onboarding-dialog').exists()).toBe(false)
    expect(localStorage.getItem('meldwork-onboarding-seen-v1')).toBe('1')
    expect(wrapper.get('.sidebar').attributes()).not.toHaveProperty('inert')
    wrapper.unmount()
  })

  it('wraps keyboard focus within the onboarding dialog in both directions', async () => {
    localStorage.removeItem('meldwork-onboarding-seen-v1')
    const { wrapper } = await mountApp()
    const dialog = wrapper.get('.onboarding-dialog')
    const focusable = dialog.findAll('button:not([disabled])')
    const first = focusable[0].element
    const last = focusable[focusable.length - 1].element

    last.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    }))
    expect(document.activeElement).toBe(first)

    first.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }))
    expect(document.activeElement).toBe(last)

    wrapper.unmount()
  })

  it('loads every stylesheet partition from the real entrypoint in stable order', () => {
    const entry = readNodeFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
    expect(entry).toEqual(STYLE_FILES.map(file => `@import './styles/${file}';`))
  })

  it('keeps the onboarding frame stable with faster transitions and no internal dividers', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    const onboardingSource = readFileSync(
      resolve(process.cwd(), 'src/composables/useOnboarding.js'),
      'utf8',
    )

    expect(onboardingSource).toContain('const ONBOARDING_SLIDE_MS = 3200')
    expect(onboardingSource).toContain('const onboardingReady = computed(() => !onboardingDetecting.value)')
    expect(source).toMatch(/\.onboarding-dialog\s*\{[^}]*height:\s*min\(700px, calc\(100dvh - 48px\)\);/s)
    expect(source).toMatch(/\.onboarding-slide-viewport\s*\{[^}]*position:\s*relative;[^}]*overflow:\s*hidden;/s)
    expect(source).toMatch(/\.onboarding-slide\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*grid-template-rows:\s*minmax\(0, 1fr\) 148px;/s)
    expect(source).toMatch(/\.onboarding-slide > img\s*\{[^}]*height:\s*100%;[^}]*border-bottom:\s*0;/s)
    expect(source).toMatch(/\.onboarding-footer\s*\{[^}]*border-top:\s*0;/s)
    expect(source).toMatch(/\.onboarding-slide-enter-active,[^{]+\{[^}]*transition:\s*opacity 0\.1s ease;/s)
  })

  it('dismisses first-run onboarding with Escape and releases the body scroll lock', async () => {
    localStorage.removeItem('meldwork-onboarding-seen-v1')
    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const { wrapper } = await mountApp()

    expect(document.body.classList.contains('modal-open')).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()

    expect(wrapper.find('.onboarding-dialog').exists()).toBe(false)
    expect(document.body.classList.contains('modal-open')).toBe(false)
    expect(localStorage.getItem('meldwork-onboarding-seen-v1')).toBe('1')
    expect(historyBack).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('dismisses first-run onboarding with browser back without navigating twice', async () => {
    localStorage.removeItem('meldwork-onboarding-seen-v1')
    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const { wrapper } = await mountApp()

    expect(document.body.classList.contains('modal-open')).toBe(true)
    window.dispatchEvent(new PopStateEvent('popstate'))
    await flushPromises()

    expect(wrapper.find('.onboarding-dialog').exists()).toBe(false)
    expect(document.body.classList.contains('modal-open')).toBe(false)
    expect(localStorage.getItem('meldwork-onboarding-seen-v1')).toBe('1')
    expect(historyBack).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('does not cover an existing workspace when the onboarding marker is missing', async () => {
    localStorage.removeItem('meldwork-onboarding-seen-v1')
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'existing-group',
        name: 'Existing workspace',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    expect(wrapper.find('.onboarding-dialog').exists()).toBe(false)
    expect(localStorage.getItem('meldwork-onboarding-seen-v1')).toBe('1')
    expect(bridge.localWorkspace.refreshAgents).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('re-probes knowledge bases only from their tab', async () => {
    const { wrapper, bridge } = await mountApp()

    expect(bridge.localKnowledgeBase.status).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.home-overview-item').exists()).toBe(false)

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    expect(wrapper.get('.system-settings-page').exists()).toBe(true)
    expect(bridge.localKnowledgeBase.status).toHaveBeenCalledTimes(1)

    await wrapper.findAll('.settings-tabs button')[0].trigger('click')
    await flushPromises()
    expect(bridge.localKnowledgeBase.status).toHaveBeenCalledTimes(1)

    await wrapper.findAll('.settings-tabs button')[2].trigger('click')
    await flushPromises()
    expect(bridge.localKnowledgeBase.status).toHaveBeenCalledTimes(2)
    expect(wrapper.get('.knowledge-base-ready-summary').text()).toContain('1 ready, 3 total')
    wrapper.unmount()
  })

  it('shows local knowledge sources and can pick an Obsidian vault', async () => {
    const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    expect(styles).toMatch(/\.knowledge-base-toolbar\s*\{/s)
    expect(styles).toMatch(/\.knowledge-base-list,\s*\.knowledge-base-future-list\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/s)
    expect(styles).toMatch(/\.knowledge-base-item\s*,\s*\.knowledge-base-future-item\s*\{[^}]*border:\s*0;[^}]*background:\s*color-mix/s)
    expect(styles).toMatch(/\.knowledge-base-item-main\s*\{[^}]*grid-template-columns:\s*48px minmax\(0, 1fr\);/s)
    expect(styles).toMatch(/\.knowledge-base-tag-row\s*\{[^}]*flex-wrap:\s*wrap;/s)
    expect(styles).toMatch(/\.knowledge-base-tag\s*\{[^}]*border-radius:\s*4px;/s)
    expect(styles).toMatch(/\.knowledge-base-future-item\s*\{[^}]*pointer-events:\s*none;/s)
    for (const [filename, source] of [
      ['feishu.svg', 'https://open.feishu.cn/'],
      ['dingtalk.svg', 'https://www.dingtalk.com/'],
      ['obsidian.svg', 'https://obsidian.md/brand'],
    ]) {
      expect(readFileSync(resolve(process.cwd(), `public/knowledge-base-logos/${filename}`), 'utf8')).toContain(`Source: ${source}`)
    }

    const { wrapper, bridge } = await mountApp()

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    await wrapper.findAll(".settings-tabs button")[2].trigger("click")
    await wrapper.vm.selectSystemSettingsSection('knowledge-bases')
    await flushPromises()

    expect(bridge.localKnowledgeBase.status).toHaveBeenCalled()
    const panelText = wrapper.get('.knowledge-base-panel').text()
    expect(panelText).toContain('Feishu Docs')
    expect(panelText).toContain('DingTalk Docs')
    expect(panelText).toContain('Obsidian')
    expect(panelText).toContain('Notion')
    expect(panelText).toContain('Confluence')
    expect(panelText).toContain('Google Drive')
    expect(panelText).toContain('SharePoint')
    expect(panelText).not.toContain('Knowledge bases')
    expect(panelText).not.toContain('Connect local document sources')

    const sourceGroups = wrapper.findAll('.knowledge-base-group')
    expect(sourceGroups).toHaveLength(2)
    expect(sourceGroups[0].get('h3').text()).toBe('Local connections')
    expect(sourceGroups[0].findAll('.knowledge-base-item')).toHaveLength(3)
    expect(sourceGroups[1].get('h3').text()).toBe('Coming soon')
    expect(sourceGroups[1].findAll('.knowledge-base-future-item')).toHaveLength(4)
    expect(wrapper.get('.knowledge-base-ready-summary').text()).toContain('1 ready, 3 total')
    expect(wrapper.get('.knowledge-base-panel').attributes('aria-busy')).toBe('false')
    expect(wrapper.get('.knowledge-base-ready-summary').attributes('role')).toBe('status')

    for (const label of ['Notion', 'Confluence', 'Google Drive', 'SharePoint']) {
      const plannedItem = wrapper.findAll('.knowledge-base-future-item')
        .find(item => item.text().includes(label))
      expect(plannedItem.get('.knowledge-base-status').text()).toContain('Coming soon')
      expect(plannedItem.attributes('aria-disabled')).toBe('true')
      expect(plannedItem.get('.knowledge-base-action').text()).toContain('Coming soon')
      expect(plannedItem.get('.knowledge-base-action').attributes()).toHaveProperty('disabled')
      expect(plannedItem.text()).not.toContain('Not configured')
    }

    const notionItem = wrapper.findAll('.knowledge-base-future-item')
      .find(item => item.text().includes('Notion'))
    await notionItem.get('.knowledge-base-action').trigger('click')
    await flushPromises()
    expect(bridge.localKnowledgeBase.openGuide).not.toHaveBeenCalled()

    const obsidianItem = wrapper.findAll('.knowledge-base-item')
      .find(item => item.text().includes('Obsidian'))
    expect(obsidianItem.exists()).toBe(true)
    expect(obsidianItem.text()).toContain('Vault not selected')
    await obsidianItem.get('.knowledge-base-action').trigger('click')
    await flushPromises()

    expect(bridge.localKnowledgeBase.pickObsidianVault).toHaveBeenCalledTimes(1)
    expect(wrapper.findAll('.knowledge-base-item').at(2).text()).toContain('/Users/rydersun/Documents/Knowledge')
    wrapper.unmount()
  })

  it('reports verified CLI knowledge access as read-only', async () => {
    const readyCliSource = kind => ({
      kind,
      accessMode: 'cli',
      installed: true,
      configured: true,
      connected: true,
      loginState: 'ready',
      permissionState: 'ready',
      commandName: kind === 'feishu' ? 'lark-cli' : 'dws',
      readable: true,
      writable: false,
      probeState: 'ready',
      errorCode: '',
      ready: true,
    })
    const { wrapper } = await mountApp(({ bridge }) => {
      bridge.localKnowledgeBase.status.mockResolvedValue([
        readyCliSource('feishu'),
        readyCliSource('dingtalk'),
        {
          kind: 'obsidian',
          accessMode: 'vault',
          installed: true,
          configured: false,
          connected: false,
          vaultPath: '',
          vaultDetails: { exists: false, directory: false, readable: false, writable: false },
          readable: false,
          writable: false,
          probeState: 'ready',
          errorCode: '',
          ready: false,
        },
      ])
    })

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    await wrapper.findAll(".settings-tabs button")[2].trigger("click")
    await flushPromises()

    expect(wrapper.get('.knowledge-base-ready-summary').text()).toContain('2 ready, 3 total')
    for (const label of ['Feishu Docs', 'DingTalk Docs']) {
      const card = wrapper.findAll('.knowledge-base-item')
        .find(item => item.text().includes(label))
      expect(card.get('.knowledge-base-status').text()).toContain('Ready')
      const tags = card.findAll('.knowledge-base-tag')
      expect(tags).toHaveLength(1)
      expect(tags[0].text()).toContain('Official CLI')
      expect(card.text()).not.toContain('Read enabled')
      expect(card.text()).not.toContain('Write not verified')
    }
    wrapper.unmount()
  })

  it('keeps local knowledge cards in Checking state until detection finishes', async () => {
    const statusResult = deferred()
    const { wrapper, bridge } = await mountApp(({ bridge }) => {
      bridge.localKnowledgeBase.status.mockReturnValue(statusResult.promise)
    })

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    await wrapper.findAll(".settings-tabs button")[2].trigger("click")
    await wrapper.vm.$nextTick()

    const localItems = wrapper.findAll('.knowledge-base-item')
    expect(localItems).toHaveLength(3)
    for (const item of localItems) {
      expect(item.get('.knowledge-base-status').text()).toContain('Checking')
      const tags = item.findAll('.knowledge-base-tag')
      expect(tags).toHaveLength(1)
      expect(item.get('.knowledge-base-action').text()).toContain('Checking')
      expect(item.get('.knowledge-base-action').attributes()).toHaveProperty('disabled')
      expect(item.text()).not.toMatch(/CLI not installed|CLI missing|Obsidian not installed|App missing|Vault not selected/)
    }
    expect(wrapper.get('.knowledge-base-panel').attributes('aria-busy')).toBe('true')
    expect(wrapper.get('.knowledge-base-ready-summary').text()).toBe('Checking')

    const plannedItems = wrapper.findAll('.knowledge-base-future-item')
    expect(plannedItems).toHaveLength(4)
    for (const item of plannedItems) {
      expect(item.get('.knowledge-base-status').text()).toContain('Coming soon')
      expect(item.get('.knowledge-base-action').text()).toContain('Coming soon')
      expect(item.get('.knowledge-base-action').attributes()).toHaveProperty('disabled')
    }

    statusResult.resolve([])
    await flushPromises()

    expect(wrapper.get('.knowledge-base-panel').attributes('aria-busy')).toBe('false')
    expect(wrapper.get('.knowledge-base-ready-summary').text()).toContain('0 ready, 3 total')
    const unknownItems = wrapper.findAll('.knowledge-base-item')
    for (const item of unknownItems) {
      expect(item.get('.knowledge-base-status').text()).toContain('Could not verify')
      expect(item.findAll('.knowledge-base-tag')).toHaveLength(1)
      expect(item.text()).not.toContain('Read not verified')
      expect(item.text()).not.toContain('Write not verified')
      expect(item.get('.knowledge-base-action').text()).toContain('Recheck')
      expect(item.get('.knowledge-base-action').attributes()).not.toHaveProperty('disabled')
      expect(item.text()).not.toMatch(/CLI not installed|CLI missing|Obsidian not installed|App missing|Vault not selected/)
    }

    await unknownItems[0].get('.knowledge-base-action').trigger('click')
    await flushPromises()
    expect(bridge.localKnowledgeBase.status).toHaveBeenCalledTimes(2)
    expect(bridge.localKnowledgeBase.status).toHaveBeenLastCalledWith('feishu')
    expect(wrapper.findAll('.knowledge-base-item')[0].get('.knowledge-base-status').text()).toContain('Could not verify')
    wrapper.unmount()
  })

  it('shows knowledge probe failures without misreporting a missing CLI', async () => {
    const { wrapper } = await mountApp(({ bridge }) => {
      bridge.localKnowledgeBase.status.mockRejectedValue(Object.assign(
        new Error('probe unavailable'),
        { code: 'KNOWLEDGE_BASE_PROBE_FAILED' },
      ))
    })

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    await wrapper.findAll(".settings-tabs button")[2].trigger("click")
    await flushPromises()

    const feishuCard = wrapper.findAll('.knowledge-base-item')
      .find(card => card.text().includes('Feishu Docs'))
    expect(feishuCard.exists()).toBe(true)
    expect(feishuCard.get('.knowledge-base-status').text()).toContain('Detection failed')
    expect(feishuCard.text()).not.toContain('CLI not installed')
    expect(feishuCard.text()).not.toContain('CLI missing')
    wrapper.unmount()
  })
})

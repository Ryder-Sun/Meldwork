import { readFileSync as readNodeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENTS } from '../../catalog.js'
import App from '../../App.vue'
import RunTracePanel from '../../components/RunTracePanel.vue'
import { setLocale } from '../../i18n.js'
import { createBridge, deferred, imageAttachment, mountApp } from './app-test-harness.js'
import { readStylesSource } from './style-test-helpers.js'

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
  it('shows the startup animation and blocks the workspace until Agent detection finishes', async () => {
    const fixture = createBridge()
    const pendingRefresh = deferred()
    fixture.state.agents = []
    fixture.bridge.localWorkspace.refreshAgents.mockReturnValueOnce(pendingRefresh.promise)
    window.meldworkDesktop = fixture.bridge

    const wrapper = mount(App, { attachTo: document.body })
    await flushPromises()

    expect(wrapper.get('.agent-discovery-overlay').attributes('role')).toBe('status')
    expect(wrapper.get('.agent-discovery-overlay').text()).toContain('Agent CLI')
    expect(wrapper.find('.pixel-blast-container').exists()).toBe(true)
    expect(wrapper.get('.agent-discovery-overlay').find('.wave-physics-loader').exists()).toBe(true)
    expect(wrapper.get('.agent-discovery-overlay').findAll('.wave-physics-loader')).toHaveLength(1)
    expect(wrapper.find('.agent-discovery-progress').exists()).toBe(false)
    expect(wrapper.get('.workspace-pane').attributes()).toHaveProperty('inert')
    expect(wrapper.get('.sidebar').attributes()).toHaveProperty('inert')

    pendingRefresh.resolve(structuredClone({
      ...fixture.state,
      agents: [{ kind: 'codex', installed: true, available: true, credentialState: 'ready', version: '1.0.0' }],
    }))
    await flushPromises()

    expect(wrapper.find('.agent-discovery-overlay').exists()).toBe(false)
    expect(wrapper.get('.workspace-pane').attributes()).not.toHaveProperty('inert')
    expect(wrapper.get('.sidebar').attributes()).not.toHaveProperty('inert')
    expect(wrapper.find('.sidebar-discovery').exists()).toBe(false)
    expect(wrapper.get('.home-workspace-state').text()).not.toBe('Detecting local Agents')
    wrapper.unmount()
  })

  it('keeps a loading animation visible while the initial snapshot is pending', async () => {
    const fixture = createBridge()
    const pendingSnapshot = deferred()
    const pendingRefresh = deferred()
    fixture.bridge.localWorkspace.get.mockReturnValueOnce(pendingSnapshot.promise)
    fixture.bridge.localWorkspace.refreshAgents.mockReturnValueOnce(pendingRefresh.promise)
    window.meldworkDesktop = fixture.bridge
    const wrapper = mount(App, { attachTo: document.body })
    expect(wrapper.get('.boot-state').find('.wave-physics-loader').exists()).toBe(true)
    pendingSnapshot.resolve(structuredClone(fixture.state))
    await flushPromises()
    expect(wrapper.get('.agent-discovery-overlay').find('.wave-physics-loader').exists()).toBe(true)
    pendingRefresh.resolve(structuredClone(fixture.state))
    await flushPromises()
    expect(wrapper.find('.agent-discovery-overlay').exists()).toBe(false)
    wrapper.unmount()
  })

  it('leaves the startup animation and shows an error if detection fails', async () => {
    const pendingRefresh = deferred()
    const { wrapper } = await mountApp(({ bridge }) => {
      bridge.localWorkspace.refreshAgents.mockReturnValueOnce(pendingRefresh.promise)
    })
    expect(wrapper.find('.agent-discovery-overlay').exists()).toBe(true)

    pendingRefresh.reject(new Error('LOCAL_AGENT_PROCESS_FAILED'))
    await flushPromises()

    expect(wrapper.find('.agent-discovery-overlay').exists()).toBe(false)
    expect(wrapper.get('.workspace-pane').attributes()).not.toHaveProperty('inert')
    expect(wrapper.get('.toast-message').attributes('role')).toBe('alert')
    wrapper.unmount()
  })

  it('shows the workspace home, keeps full Agent management in Settings, and switches language and theme', async () => {
    const { wrapper } = await mountApp()

    expect(wrapper.get('.home-dashboard').attributes('data-home-mode')).toBe('first-task')
    expect(wrapper.get('.home-dashboard-header h1').text()).toBe('Meldwork workspace')
    expect(wrapper.get('.home-workspace-state').text()).toContain('2 Agents ready')
    expect(wrapper.get('.home-panel-header h2').text()).toBe('Start your first task')
    expect(wrapper.findAll('.home-panel-header h2')[1].text()).toBe('Start a new task')
    expect(wrapper.get('.home-recent-panel .primary-button').text()).toContain('New group')
    expect(wrapper.find('.home-overview-grid').exists()).toBe(false)
    expect(wrapper.find('.setup-guide').exists()).toBe(false)
    expect(wrapper.findAll('.agent-card')).toHaveLength(0)
    expect(wrapper.get('.brand-button img').attributes('src')).toBe('./logos/meldwork-mark-v3.svg')
    expect(wrapper.get('.brand-button').attributes('aria-current')).toBe('page')
    expect(wrapper.get('.sidebar-settings-entry').attributes()).not.toHaveProperty('aria-current')

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    expect(wrapper.findAll('.agent-card')).toHaveLength(AGENTS.length)
    expect(wrapper.get('.agent-manager').text()).toContain('OpenCodeReview')
    expect(wrapper.get('.system-settings-page').attributes('aria-label')).toBe('Settings')
    expect(wrapper.find('.system-settings-header').exists()).toBe(false)
    expect(wrapper.get('.sidebar-settings-entry').attributes('aria-current')).toBe('page')
    expect(wrapper.get('.brand-button').attributes()).not.toHaveProperty('aria-current')

    const controls = wrapper.findAll('.titlebar-preferences button')
    await controls[0].trigger('click')
    expect(wrapper.get('.system-settings-page').attributes('aria-label')).toBe('设置')
    expect(wrapper.find('.system-settings-header').exists()).toBe(false)

    await controls[1].trigger('click')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(wrapper.get('.brand-button img').attributes('src')).toBe('./logos/meldwork-mark-v3-dark.svg')
    wrapper.unmount()
  })

  it('keeps OpenCodeReview visible for ordinary conversations and direct instructions', async () => {
    const { wrapper, bridge } = await mountApp(({ state, bridge: desktopBridge }) => {
      state.agents.push({
        kind: 'opencodereview',
        installed: true,
        available: true,
        credentialState: 'ready',
        showInSidebar: true,
        task: 'code_review',
        resumable: false,
        version: '1.8.6',
      })
      desktopBridge.localWorkspace.createGroup.mockImplementation(async input => ({
        id: 'direct-opencodereview',
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
        ...structuredClone(input),
      }))
    })

    expect(wrapper.findAll('.home-agent-item').some(item => item.text().includes('OpenCodeReview'))).toBe(true)
    await wrapper.get('.new-group-button').trigger('click')
    expect(wrapper.findAll('.agent-choice').some(choice => choice.text().includes('OpenCodeReview'))).toBe(true)
    await wrapper.get('.modal-header .icon-button').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.sidebar-agent').some(agent => agent.text().includes('OpenCodeReview'))).toBe(true)

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    expect(wrapper.get('.agent-manager').text()).toContain('OpenCodeReview')
    const card = wrapper.findAll('.settings-agent-card')
      .find(node => node.text().includes('OpenCodeReview'))
    await card.findAll('button').find(button => button.text().includes('Open chat')).trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.createGroup).toHaveBeenCalledWith(expect.objectContaining({
      conversationType: 'direct',
      directAgentKind: 'opencodereview',
      name: 'OpenCodeReview',
      allowWrite: true,
    }))
    wrapper.unmount()
  })

  it('renders cloud Agents with product logos, cloud markers, version, and remote Skills', async () => {
    const cloudKind = 'cloud-0123456789abcdef01234567'
    const cloudAgent = {
      kind: cloudKind,
      sourceKind: 'codex',
      label: 'Codex @ Research server',
      description: 'Remote Codex CLI',
      version: '0.146.1',
      installed: true,
      available: true,
      credentialState: 'ready',
      showInSidebar: true,
      custom: false,
      connector: true,
      cloud: true,
      serverLabel: 'Research server',
    }
    const { wrapper, bridge } = await mountApp(({ state, bridge: desktopBridge }) => {
      state.agents.push(cloudAgent)
      desktopBridge.agentInstaller.catalog.mockResolvedValue({
        platform: 'darwin',
        agents: [
          ...AGENTS.map(agent => ({ kind: agent.kind, installed: true, installSupported: true })),
          cloudAgent,
        ],
      })
      desktopBridge.agentInstaller.skills.mockResolvedValue({
        supported: true,
        total: 1,
        skills: [{ targetKind: cloudKind, namespace: 'codex', slug: 'review', name: 'Review' }],
      })
    })

    const sidebarCloud = wrapper.findAll('.sidebar-agent')
      .find(agent => agent.text().includes('Codex @ Research server'))
    expect(sidebarCloud.get('.agent-logo-cloud.cloud').exists()).toBe(true)
    expect(sidebarCloud.get('img').attributes('src')).toContain('agent-logos/codex.svg')

    await wrapper.get('.new-group-button').trigger('click')
    const cloudChoice = wrapper.findAll('.agent-choice')
      .find(choice => choice.text().includes('Codex @ Research server'))
    expect(cloudChoice.get('.agent-choice-logo.cloud').exists()).toBe(true)
    await wrapper.get('.modal-header .icon-button').trigger('click')

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    const cloudCard = wrapper.findAll('.settings-agent-card')
      .find(card => card.text().includes('Codex @ Research server'))
    expect(cloudCard.get('.settings-agent-logo.cloud').exists()).toBe(true)
    expect(cloudCard.text()).toContain('Version 0.146.1')
    await cloudCard.get('.agent-card-main').trigger('click')
    await flushPromises()

    expect(wrapper.get('.agent-detail-logo.cloud img').attributes('src'))
      .toContain('agent-logos/codex.svg')
    expect(wrapper.get('.agent-detail-skill-grid').text()).toContain('@Review')
    expect(bridge.agentInstaller.skills).toHaveBeenCalledWith(cloudKind)
    wrapper.unmount()
  })

  it('shows existing Custom Agents while keeping unavailable setup controls hidden', async () => {
    const customProfile = {
      kind: 'custom-0123456789abcdef',
      label: 'Repository Reviewer',
      description: 'Reviews the current repository diff.',
      commandName: 'review-agent',
      promptMode: 'argument',
      custom: true,
      installed: true,
      installSupported: false,
      imageAttachmentLimit: 0,
      version: 'review-agent 1.0.0',
    }
    const { wrapper, bridge } = await mountApp(({ bridge: configuredBridge, state: configuredState }) => {
      configuredBridge.agentInstaller.catalog.mockImplementation(async () => ({
        platform: 'darwin',
        agents: [
          ...AGENTS.map(agent => ({
            kind: agent.kind,
            installed: true,
            installSupported: true,
          })),
          customProfile,
        ],
      }))
      configuredState.agents.push({
        kind: customProfile.kind,
        label: customProfile.label,
        description: customProfile.description,
        commandName: customProfile.commandName,
        promptMode: customProfile.promptMode,
        custom: true,
        installed: true,
        available: true,
        credentialState: 'ready',
        availabilitySource: 'custom-agent',
        showInSidebar: true,
        version: customProfile.version,
      })
    })

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    expect(wrapper.findAll('.agent-catalog-category').map(category => category.get('h2').text()))
      .toEqual(['Official Agents', 'Custom Agents'])
    expect(wrapper.get('.manager-toolbar-actions').text()).not.toContain('Add custom Agent')
    expect(wrapper.find('.custom-agent-form').exists()).toBe(false)
    expect(wrapper.findAll('.agent-card').some(card => card.text().includes('Repository Reviewer'))).toBe(true)
    expect(bridge.customAgent.create).not.toHaveBeenCalled()
    expect(bridge.customAgent.delete).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('uses the Meldwork wordmark and automatically rotates empty copy in direct and group chats', async () => {
    vi.useFakeTimers()
    setLocale('zh')
    const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    expect(styles).not.toContain('.conversation-empty-refresh')
    expect(styles).toMatch(/\.empty-showcase-enter-active,\s*\.empty-showcase-leave-active\s*\{[^}]*transition:\s*opacity 0\.16s ease,\s*transform 0\.16s ease;/s)
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push(
        {
          id: 'direct-empty-codex',
          conversationType: 'direct',
          directAgentKind: 'codex',
          name: 'Codex',
          topic: '',
          agentKinds: ['codex'],
          workdir: '/tmp/meldwork-workspace',
          allowWrite: true,
          createdAt: '2026-07-29T08:00:00Z',
          updatedAt: '2026-07-29T08:00:00Z',
        },
        {
          id: 'group-empty',
          conversationType: 'group',
          name: 'Agent review',
          topic: '',
          agentKinds: ['codex', 'hermes'],
          workdir: '/tmp/meldwork-workspace',
          allowWrite: false,
          createdAt: '2026-07-29T09:00:00Z',
          updatedAt: '2026-07-29T09:00:00Z',
        },
      )
    })

    await wrapper.get('.direct-session-open').trigger('click')
    expect(wrapper.get('.conversation-empty-wordmark').attributes('src')).toBe('./logos/meldwork-wordmark-v3.svg')
    expect(wrapper.find('.empty-icon').exists()).toBe(false)
    expect(wrapper.find('.conversation-empty-refresh').exists()).toBe(false)
    expect(wrapper.get('.conversation-empty').text()).not.toContain('开始对话')
    expect(wrapper.get('.conversation-empty').text()).not.toContain('给 Codex 发送一个任务')
    expect(wrapper.get('.conversation-empty-copy').text()).toContain('先从一个 Agent 开始')
    expect(wrapper.get('.conversation-empty-copy').text()).not.toMatch(/[。.]$/)

    await vi.advanceTimersByTimeAsync(2_800)
    await flushPromises()
    expect(wrapper.get('.conversation-empty-copy').text()).toContain('提出目标，让 Agent 们协作完成')

    await wrapper.findAll('.titlebar-preferences button')[1].trigger('click')
    expect(wrapper.get('.conversation-empty-wordmark').attributes('src')).toBe('./logos/meldwork-wordmark-v3-dark.svg')

    await wrapper.get('.conversation-link').trigger('click')
    expect(wrapper.get('.conversation-empty-wordmark').attributes('src')).toBe('./logos/meldwork-wordmark-v3-dark.svg')
    expect(wrapper.get('.conversation-empty').text()).not.toContain('先发送讨论主题')
    wrapper.unmount()
  })

  it('shows setup guidance only when no local Agent is ready', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.agents = state.agents.map(agent => ({
        ...agent,
        available: false,
        credentialState: 'missing',
      }))
    })

    expect(wrapper.get('.home-dashboard').attributes('data-home-mode')).toBe('setup')
    expect(wrapper.get('.home-workspace-state').classes()).toContain('attention')
    expect(wrapper.get('.home-workspace-state').text()).toContain('needs attention')
    expect(wrapper.get('.setup-guide').exists()).toBe(true)
    expect(wrapper.find('.home-dashboard-grid').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps conversation history visible when local Agents need recovery', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.agents = state.agents.map(agent => ({
        ...agent,
        available: false,
        credentialState: 'missing',
      }))
      state.groups.push({
        id: 'group-recovery',
        conversationType: 'group',
        name: 'Recovery history',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    expect(wrapper.get('.home-dashboard').attributes('data-home-mode')).toBe('workspace')
    expect(wrapper.get('.home-workspace-state').classes()).toContain('attention')
    expect(wrapper.get('.home-recovery-notice').text()).toContain('conversation history is still available')
    expect(wrapper.get('.home-recent-item').text()).toContain('Recovery history')
    expect(wrapper.find('.setup-guide').exists()).toBe(false)

    await wrapper.get('.home-recovery-notice button').trigger('click')
    expect(wrapper.get('.system-settings-page').exists()).toBe(true)
    expect(wrapper.get('.sidebar-settings-entry').attributes('aria-current')).toBe('page')
    wrapper.unmount()
  })

  it('keeps exactly one current navigation target across conversations, home, and Settings', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-home-navigation',
        conversationType: 'group',
        name: 'Home navigation',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    await wrapper.get('.conversation-link').trigger('click')
    expect(wrapper.find('.conversation-pane').exists()).toBe(true)
    expect(wrapper.get('.conversation-link').attributes('aria-current')).toBe('page')
    expect(wrapper.get('.group-conversation-row').classes()).toContain('active')
    expect(wrapper.get('.brand-button').attributes()).not.toHaveProperty('aria-current')
    expect(wrapper.get('.sidebar-settings-entry').attributes()).not.toHaveProperty('aria-current')

    await wrapper.get('.brand-button').trigger('click')
    expect(wrapper.find('.home-dashboard').exists()).toBe(true)
    expect(wrapper.find('.conversation-pane').exists()).toBe(false)
    expect(wrapper.get('.brand-button').attributes('aria-current')).toBe('page')
    expect(wrapper.get('.conversation-link').attributes()).not.toHaveProperty('aria-current')
    expect(wrapper.get('.group-conversation-row').classes()).not.toContain('active')

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    expect(wrapper.find('.system-settings-page').exists()).toBe(true)
    expect(wrapper.get('.sidebar-settings-entry').attributes('aria-current')).toBe('page')
    expect(wrapper.get('.brand-button').attributes()).not.toHaveProperty('aria-current')
    expect(wrapper.get('.conversation-link').attributes()).not.toHaveProperty('aria-current')
    expect(wrapper.get('.group-conversation-row').classes()).not.toContain('active')

    await wrapper.get('.brand-button').trigger('click')
    expect(wrapper.find('.home-dashboard').exists()).toBe(true)
    expect(wrapper.find('.system-settings-page').exists()).toBe(false)
    wrapper.unmount()
  })

  it('returns explicitly to home when the current conversation disappears', async () => {
    const { wrapper, state, emitWorkspaceChanged } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-removed-externally',
        conversationType: 'group',
        name: 'External removal',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    await wrapper.get('.conversation-link').trigger('click')
    expect(wrapper.get('.conversation-pane').exists()).toBe(true)

    state.groups = []
    emitWorkspaceChanged(state)
    await flushPromises()

    expect(wrapper.get('.home-dashboard').exists()).toBe(true)
    expect(wrapper.get('.home-dashboard').attributes('data-home-mode')).toBe('first-task')
    expect(wrapper.get('.brand-button').attributes('aria-current')).toBe('page')
    wrapper.unmount()
  })

  it('preserves unsent attachments while opening home and Settings', async () => {
    const { wrapper, bridge } = await mountApp(({ state, bridge: desktopBridge }) => {
      state.groups.push({
        id: 'group-preserved-draft',
        conversationType: 'group',
        name: 'Preserved draft',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      desktopBridge.localAttachments.pickAttachments.mockResolvedValueOnce({
        attachments: [imageAttachment('preserved-draft')],
      })
    })

    const conversationLink = wrapper.get('.conversation-link')
    await conversationLink.trigger('click')
    await wrapper.get('[aria-label="Attach files"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('.composer-attachment').exists()).toBe(true)

    await wrapper.get('.brand-button').trigger('click')
    expect(wrapper.get('.home-dashboard').exists()).toBe(true)
    expect(bridge.localAttachments.discard).not.toHaveBeenCalled()

    await conversationLink.trigger('click')
    expect(wrapper.get('.composer-attachment').exists()).toBe(true)
    await wrapper.get('.sidebar-settings-entry').trigger('click')
    expect(wrapper.get('.system-settings-page').exists()).toBe(true)
    expect(bridge.localAttachments.discard).not.toHaveBeenCalled()

    await conversationLink.trigger('click')
    expect(wrapper.get('.composer-attachment').exists()).toBe(true)
    wrapper.unmount()
  })

  it('collapses the sidebar while keeping Agent logos and workspace preferences available', async () => {
    const { wrapper } = await mountApp()
    // The fixture installs WorkBuddy but has no usable WorkBuddy runtime.
    const visibleCount = AGENTS.length - 1

    expect(wrapper.find('.brand-actions').exists()).toBe(false)
    expect(wrapper.findAll('.titlebar-preferences button')).toHaveLength(2)
    expect(wrapper.findAll('.titlebar-preferences .preference-icon-frame')).toHaveLength(2)
    expect(wrapper.findAll('.nav-heading svg')).toHaveLength(0)
    expect(wrapper.findAll('.sidebar-agent-main img')).toHaveLength(visibleCount)
    const [agentsToggle, groupsToggle] = wrapper.findAll('.nav-heading')
    expect(agentsToggle.attributes('aria-expanded')).toBe('true')
    await agentsToggle.trigger('click')
    expect(wrapper.findAll('.sidebar-agent-main img')).toHaveLength(0)
    expect(agentsToggle.attributes('aria-expanded')).toBe('false')
    expect(groupsToggle.attributes('aria-expanded')).toBe('true')
    await groupsToggle.trigger('click')
    expect(wrapper.find('#sidebar-group-list').exists()).toBe(false)
    await groupsToggle.trigger('click')
    expect(wrapper.get('#sidebar-group-list').exists()).toBe(true)
    await agentsToggle.trigger('click')
    expect(wrapper.findAll('.sidebar-agent-main img')).toHaveLength(visibleCount)

    await wrapper.get('.sidebar-toggle').trigger('click')
    expect(wrapper.get('.app-shell').classes()).toContain('sidebar-collapsed')
    expect(wrapper.get('.sidebar').classes()).toContain('collapsed')
    expect(wrapper.findAll('.sidebar-agent-main img')).toHaveLength(visibleCount)

    await wrapper.get('.sidebar-toggle').trigger('click')
    expect(wrapper.get('.app-shell').classes()).not.toContain('sidebar-collapsed')
    wrapper.unmount()
  })

  it('switches between every group from the collapsed sidebar menu', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      for (let index = 1; index <= 10; index += 1) {
        state.groups.push({
          id: `collapsed-group-${index}`,
          conversationType: 'group',
          name: `Collapsed group ${index}`,
          topic: '',
          agentKinds: index % 2 ? ['codex', 'hermes'] : ['codex'],
          workdir: '/tmp/meldwork-workspace',
          allowWrite: false,
          createdAt: `2026-07-29T08:${String(index).padStart(2, '0')}:00Z`,
          updatedAt: `2026-07-29T08:${String(index).padStart(2, '0')}:00Z`,
        })
      }
    })

    await wrapper.get('.sidebar-toggle').trigger('click')
    const switcher = wrapper.get('.collapsed-group-switcher-button')
    expect(switcher.attributes('aria-label')).toBe('Switch group chat')
    // A total count read as "10 unread"; the switcher only shows a dot when a group needs the user.
    expect(switcher.text()).toBe('')
    expect(switcher.find('.attention-dot').exists()).toBe(false)

    await switcher.trigger('click')
    await flushPromises()
    let menu = document.body.querySelector('.collapsed-group-menu')
    expect(menu).not.toBeNull()
    expect(menu.querySelectorAll('.collapsed-group-option')).toHaveLength(10)
    expect(menu.textContent).toContain('Collapsed group 1')
    expect(menu.textContent).toContain('Collapsed group 10')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(document.body.querySelector('.collapsed-group-menu')).toBeNull()
    expect(document.activeElement).toBe(switcher.element)

    await switcher.trigger('click')
    await flushPromises()
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await flushPromises()
    expect(document.body.querySelector('.collapsed-group-menu')).toBeNull()

    await switcher.trigger('click')
    await flushPromises()
    menu = document.body.querySelector('.collapsed-group-menu')
    const target = [...menu.querySelectorAll('.collapsed-group-option')]
      .find(option => option.textContent.includes('Collapsed group 7'))
    target.click()
    await flushPromises()

    expect(document.body.querySelector('.collapsed-group-menu')).toBeNull()
    expect(wrapper.get('.conversation-header h1').text()).toBe('Collapsed group 7')
    wrapper.unmount()
  })

  it('uses the Agent running bars for direct and group sessions in the sidebar', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push(
        {
          id: 'running-direct',
          conversationType: 'direct',
          directAgentKind: 'codex',
          name: 'Running direct',
          topic: '',
          agentKinds: ['codex'],
          workdir: '/tmp/meldwork-workspace',
          allowWrite: false,
          createdAt: '2026-07-29T08:00:00Z',
          updatedAt: '2026-07-29T08:00:00Z',
        },
        {
          id: 'running-group',
          conversationType: 'group',
          name: 'Running group',
          topic: '',
          agentKinds: ['codex', 'hermes'],
          workdir: '/tmp/meldwork-workspace',
          allowWrite: false,
          createdAt: '2026-07-29T08:01:00Z',
          updatedAt: '2026-07-29T08:01:00Z',
        },
      )
      state.runningGroupIds = ['running-direct', 'running-group']
      state.runs.push(
        {
          runId: 'run-running-direct',
          groupId: 'running-direct',
          phase: 'running',
          targetKinds: ['codex'],
          agentRuns: [{
            agentRunId: 'agent-running-direct',
            kind: 'codex',
            round: 0,
            status: 'running',
          }],
        },
        {
          runId: 'run-running-group',
          groupId: 'running-group',
          phase: 'running',
          targetKinds: ['codex', 'hermes'],
          agentRuns: [{
            agentRunId: 'agent-running-group-codex',
            kind: 'codex',
            round: 0,
            status: 'running',
          }],
        },
      )
    })

    const directBars = wrapper.get('.direct-session-row .run-mark .run-agent-bars')
    const groupBars = wrapper.get('.group-conversation-row .run-mark .run-agent-bars')
    expect(directBars.findAll('i')).toHaveLength(3)
    expect(groupBars.findAll('i')).toHaveLength(3)
    expect(wrapper.find('.conversation-nav .run-pulse').exists()).toBe(false)

    await wrapper.get('.sidebar-toggle').trigger('click')
    await wrapper.get('.collapsed-group-switcher-button').trigger('click')
    await flushPromises()
    const collapsedGroup = [...document.body.querySelectorAll('.collapsed-group-option')]
      .find(option => option.textContent.includes('Running group'))
    expect(collapsedGroup.querySelectorAll('.run-agent-bars i')).toHaveLength(3)
    wrapper.unmount()
  })

  it('keeps running sidebar sessions focused on status until the conversation is selected', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push(
        {
          id: 'running-direct',
          conversationType: 'direct',
          directAgentKind: 'codex',
          name: 'Running direct',
          topic: '',
          agentKinds: ['codex'],
          workdir: '/tmp/meldwork-workspace',
          allowWrite: false,
          createdAt: '2026-07-29T08:00:00Z',
          updatedAt: '2026-07-29T08:00:00Z',
        },
        {
          id: 'running-group',
          conversationType: 'group',
          name: 'Running group',
          topic: '',
          agentKinds: ['codex', 'hermes'],
          workdir: '/tmp/meldwork-workspace',
          allowWrite: false,
          createdAt: '2026-07-29T08:01:00Z',
          updatedAt: '2026-07-29T08:01:00Z',
        },
      )
      state.runningGroupIds = ['running-direct', 'running-group']
      state.runs.push(
        {
          runId: 'run-running-direct',
          groupId: 'running-direct',
          phase: 'running',
          targetKinds: ['codex'],
          agentRuns: [{
            agentRunId: 'agent-running-direct',
            kind: 'codex',
            round: 0,
            status: 'running',
          }],
        },
        {
          runId: 'run-running-group',
          groupId: 'running-group',
          phase: 'running',
          targetKinds: ['codex', 'hermes'],
          agentRuns: [{
            agentRunId: 'agent-running-group-codex',
            kind: 'codex',
            round: 0,
            status: 'running',
          }],
        },
      )
    })

    const directRow = wrapper.get('.direct-session-row')
    expect(directRow.find('.run-mark .run-agent-bars').exists()).toBe(true)
    expect(directRow.findAll('.direct-session-action')).toHaveLength(1)
    expect(directRow.get('.direct-session-action').attributes()).not.toHaveProperty('disabled')

    const groupRow = wrapper.get('.group-conversation-row')
    expect(groupRow.find('.run-mark .run-agent-bars').exists()).toBe(true)
    expect(groupRow.get('.direct-session-action').attributes()).not.toHaveProperty('disabled')
    expect(groupRow.get('.direct-session-action.danger').attributes()).toHaveProperty('disabled')

    await directRow.get('.direct-session-open').trigger('click')
    await flushPromises()
    const selectedDirectRow = wrapper.get('.direct-session-row.active')
    expect(selectedDirectRow.find('.run-mark').exists()).toBe(false)
    const directActions = selectedDirectRow.findAll('.direct-session-action')
    expect(directActions).toHaveLength(2)
    expect(directActions[0].attributes()).not.toHaveProperty('disabled')
    expect(directActions[1].attributes()).toHaveProperty('disabled')

    await wrapper.get('.group-conversation-row .conversation-link').trigger('click')
    await flushPromises()
    const selectedGroupRow = wrapper.get('.group-conversation-row.active')
    expect(selectedGroupRow.find('.run-mark').exists()).toBe(false)
    const groupActions = selectedGroupRow.findAll('.direct-session-action')
    expect(groupActions).toHaveLength(2)
    expect(groupActions[0].attributes()).not.toHaveProperty('disabled')
    expect(groupActions[1].attributes()).toHaveProperty('disabled')
    wrapper.unmount()
  })

  it('does not show running bars for a new empty group with a stale running id', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'empty-stale-group',
        conversationType: 'group',
        name: 'Empty stale group',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: true,
        createdAt: '2026-07-29T08:02:00Z',
        updatedAt: '2026-07-29T08:02:00Z',
      })
      state.runningGroupIds = ['empty-stale-group']
    })

    const groupRow = wrapper.get('.group-conversation-row')
    expect(groupRow.text()).toContain('Empty stale group')
    expect(groupRow.find('.run-mark').exists()).toBe(false)
    wrapper.unmount()
  })

  it('lists core shortcuts in the global titlebar and handles sidebar toggle', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-shortcuts',
        conversationType: 'group',
        name: 'Shortcuts',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    await wrapper.get('.conversation-link').trigger('click')
    expect(wrapper.find('.sidebar .titlebar-actions').exists()).toBe(false)
    expect(wrapper.find('.conversation-header .shortcut-menu-anchor').exists()).toBe(false)
    expect(wrapper.findAll('.titlebar-actions button')).toHaveLength(4)
    expect(wrapper.get('[aria-label="Conversation settings"] svg').html()).not.toBe(wrapper.get('.titlebar-actions .sidebar-settings-entry svg').html())
    const shortcutButton = wrapper.get('.titlebar-actions [aria-label="Keyboard shortcuts"]')
    expect(shortcutButton.find('.keyboard-shortcut-icon').exists()).toBe(true)
    await wrapper.get('.shortcut-menu-anchor').trigger('mouseenter')
    expect(wrapper.get('#keyboard-shortcut-menu').attributes('role')).toBe('tooltip')
    expect(wrapper.findAll('#keyboard-shortcut-menu li')).toHaveLength(5)
    expect(wrapper.findAll('#keyboard-shortcut-menu kbd').map(item => item.text()))
      .toEqual(['⌘ B', '⌘ G', '⌘ [', '⌘ ]', '⌘ ,'])

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true }))
    await flushPromises()
    expect(wrapper.get('.app-shell').classes()).toContain('sidebar-collapsed')
    expect(wrapper.find('#keyboard-shortcut-menu').exists()).toBe(false)
    wrapper.unmount()
  })

  it('stacks the collapsed brand mark above the expand control without shrinking either', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')

    expect(source).toMatch(/\.sidebar\.collapsed \.brand-row\s*\{[^}]*flex-direction:\s*column;/s)
    expect(source).toMatch(/\.sidebar\.collapsed \.brand-button\s*\{[^}]*flex:\s*0 0 34px;/s)
    expect(source).toMatch(/\.sidebar\.collapsed \.sidebar-toggle\s*\{[^}]*flex:\s*0 0 34px;/s)
  })

  it('uses directional controls for the sidebar and animates the trace panel state change', () => {
    const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    const sidebarSource = readNodeFileSync(resolve(process.cwd(), 'src/components/WorkspaceSidebar.vue'), 'utf8')
    const appSource = readNodeFileSync(resolve(process.cwd(), 'src/App.vue'), 'utf8')

    expect(sidebarSource).toContain('<ChevronForwardOutline v-if="sidebarCollapsed" />')
    expect(sidebarSource).toContain('<ChevronBackOutline v-else />')
    expect(sidebarSource).not.toContain('<ContractOutline')
    expect(sidebarSource).not.toContain('<MenuOutline')
    expect(appSource).toContain('<transition name="trace-panel">')
    expect(styles).toMatch(/\.trace-panel-enter-active \.run-trace-panel,[^{]+\.trace-panel-leave-active \.run-trace-panel\s*\{[^}]*transition:[^}]*transform[^}]*opacity[^}]*;/s)
    expect(styles).toMatch(/\.trace-panel-enter-from \.run-trace-panel,[^{]+\.trace-panel-leave-to \.run-trace-panel\s*\{[^}]*transform:\s*translateX\(/s)
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.trace-panel-enter-active \.run-trace-panel,[^{]+\.trace-panel-leave-active \.run-trace-panel,[^{]+\{[^}]*transition:\s*none;/s)
  })

  it('anchors collapsed sidebar controls while the workspace width animates', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')

    expect(source).toMatch(/\.app-shell\s*\{[^}]*transition:\s*grid-template-columns 0\.22s cubic-bezier\(0\.16, 1, 0\.3, 1\);/s)
    expect(source).toMatch(/\.sidebar\.collapsed \.brand-row\s*\{[^}]*width:\s*var\(--sidebar-collapsed-width\);[^}]*align-self:\s*flex-start;/s)
    expect(source).toMatch(/\.sidebar\.collapsed \.conversation-nav\s*\{[^}]*width:\s*var\(--sidebar-collapsed-width\);[^}]*align-self:\s*flex-start;/s)
    expect(source).toMatch(/\.sidebar\.collapsed \.sidebar-footer\s*\{[^}]*width:\s*var\(--sidebar-collapsed-width\);[^}]*align-self:\s*flex-start;/s)
    expect(source).toMatch(/\.sidebar\.collapsed \.sidebar-footer button\s*\{[^}]*width:\s*34px;/s)
    expect(source).toMatch(/\.sidebar\.collapsed \.new-group-button\s*\{[^}]*margin:\s*2px 15px 12px;/s)
    expect(source).not.toMatch(/\.sidebar\.collapsed \.new-group-button\s*\{[^}]*margin-inline:\s*auto;/s)
  })

  it('uses a theme-aware rounded desktop shell instead of hard pane dividers', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    const appSource = readFileSync(resolve(process.cwd(), 'src/App.vue'), 'utf8')

    expect(appSource).toContain(':data-platform="desktopPlatform"')
    expect(appSource).toContain("const desktopPlatform = computed(() => api.value?.platform || installCatalog.value.platform || '')")
    expect(source).toMatch(/--shell-gradient:\s*linear-gradient\(145deg,\s*#f1f8f7 0%,\s*#e2efef 48%,\s*#c9dde0 100%\);/)
    // The dark backdrop stays darker than the workspace card so the card reads as raised.
    expect(source).toMatch(/:root\[data-theme="dark"\]\s*\{[^}]*--shell-gradient:\s*linear-gradient\(145deg,\s*#1f292b 0%,\s*#182124 48%,\s*#111a1d 100%\);[^}]*--workspace-surface:\s*#1c2124;/s)
    expect(source).toMatch(/--onboarding-frame-gradient:\s*linear-gradient\(145deg,\s*#dcefeb 0%,\s*#9fc2ca 48%,\s*#ddb5aa 100%\);/)
    expect(source).toMatch(/:root\[data-theme="dark"\]\s*\{[^}]*--onboarding-frame-gradient:\s*linear-gradient\(145deg,\s*#4a696b 0%,\s*#2e4751 52%,\s*#775047 100%\);/s)
    expect(source).toMatch(/\.onboarding-dialog\s*\{[^}]*border:\s*1px solid transparent;[^}]*background:\s*linear-gradient\(var\(--surface\), var\(--surface\)\) padding-box,\s*var\(--onboarding-frame-gradient\) border-box;/s)
    expect(source).toMatch(/\.app-shell\s*\{[^}]*gap:\s*var\(--shell-gutter\);[^}]*padding:\s*calc\(var\(--desktop-titlebar-height\) \+ var\(--shell-gutter\)\) var\(--shell-gutter\) var\(--shell-gutter\) 0;[^}]*background:\s*var\(--shell-gradient\);/s)
    expect(source).toMatch(/\.app-shell\[data-platform="darwin"\]::before\s*\{[^}]*-webkit-app-region:\s*drag;/s)
    expect(source).toMatch(/\.workspace-pane\s*\{[^}]*border-radius:\s*var\(--workspace-radius\);[^}]*background:\s*var\(--workspace-surface\);[^}]*box-shadow:\s*var\(--workspace-shadow\);/s)
    expect(source).toMatch(/\.sidebar\s*\{[^}]*background:\s*transparent;/s)
    expect(source).not.toContain('--sidebar-gradient')
    expect(source).not.toContain('--titlebar-gradient')
    expect(source).toMatch(/\.conversation-header\s*\{[^}]*border-bottom:\s*0;[^}]*background:\s*transparent;/s)
    expect(source).toMatch(/\.composer-zone\s*\{[^}]*background:\s*transparent;/s)
  })

  it('keeps the first-run onboarding transition and the original startup animations', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    const appSource = readFileSync(resolve(process.cwd(), 'src/App.vue'), 'utf8')
    const packageSource = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')

    expect(appSource).toContain('<transition name="onboarding" appear>')
    expect(appSource).toContain('<PixelBlast :theme="theme" />')
    expect(appSource).toContain('<WavePhysicsLoader :theme="theme" />')
    expect(appSource).toContain('agent-discovery-overlay')
    expect(packageSource).toContain('"three"')
    expect(source).toContain('--pixel-blast-')
    expect(source).toMatch(/\.onboarding-leave-active\s*\{[^}]*transition:\s*opacity 0\.42s ease;/s)
    expect(source).toMatch(/\.onboarding-leave-active \.onboarding-backdrop\s*\{[^}]*transition:\s*background-color 0\.42s ease;/s)
    expect(source).toMatch(/\.onboarding-leave-to\s*\{[^}]*opacity:\s*0;/s)
    expect(source).toMatch(/\.onboarding-leave-to \.onboarding-dialog\s*\{[^}]*opacity:\s*0;[^}]*transform:\s*translateY\(14px\) scale\(0\.975\);/s)
  })

  it('uses one settings entry and a borderless Agent mention menu', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')

    expect(source).toMatch(/\.sidebar-footer\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;/s)
    expect(source).toMatch(/\.sidebar-footer-actions \.icon-button:hover\s*\{[^}]*border-color:\s*transparent;[^}]*background:\s*transparent;[^}]*color:\s*var\(--text\);/s)
    expect(source).toMatch(/\.preference-icon-enter-active,[^{]+\.preference-icon-leave-active\s*\{[^}]*opacity 0\.14s ease,[^}]*transform 0\.14s cubic-bezier\(0\.16, 1, 0\.3, 1\);/s)
    expect(source).not.toMatch(/\.nav-heading svg\s*\{/s)
    expect(source).not.toMatch(/\.sidebar\s*\{[^}]*border-right:\s*1px solid var\(--border\);/s)
    expect(source).not.toMatch(/\.sidebar-footer\s*\{[^}]*border-top:\s*1px solid var\(--border\);/s)
    expect(source).not.toMatch(/\.system-settings-header\s*\{[^}]*border-bottom:\s*1px solid var\(--border\);/s)
    expect(source).not.toMatch(/\.settings-tabs\s*\{[^}]*border-bottom:\s*1px solid var\(--border\);/s)
    expect(source).toMatch(/\.settings-tabs button\.active\s*\{[^}]*border-bottom-color:\s*var\(--accent\);/s)
    expect(source).toMatch(/\.skill-menu\s*\{[^}]*border:\s*0;/s)
    expect(source).toMatch(/\.skill-option\.agent-mention-option \.skill-option-copy small,[^{]+\.skill-option\.knowledge-base-mention-option \.skill-option-copy small\s*\{[^}]*-webkit-line-clamp:\s*2;/s)
    expect(source).toMatch(/\.modal-pop-enter-active,[^{]+\.modal-pop-leave-active\s*\{[^}]*transform 0\.18s cubic-bezier\(0\.16, 1, 0\.3, 1\);/s)
    expect(source).toMatch(/\.message-attachment-grid\s*\{[^}]*flex-direction:\s*column;[^}]*align-items:\s*flex-end;[^}]*justify-content:\s*flex-start;/s)
    expect(source).toMatch(/\.message-row\.agent \.message-attachment-grid\s*\{[^}]*align-items:\s*flex-start;/s)
    expect(source).not.toMatch(/\.message-attachment-grid\s*\{[^}]*flex-wrap:\s*wrap;/s)
    expect(source).toMatch(/\.message-document-list\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*nowrap;[^}]*gap:\s*6px;[^}]*overflow-x:\s*auto;/s)
    expect(source).toMatch(/\.message-document-attachment\s*\{[^}]*width:\s*168px;[^}]*min-width:\s*148px;[^}]*min-height:\s*44px;[^}]*border:\s*0;/s)
    expect(source).toMatch(/\.direct-session-open\s*\{[^}]*grid-column:\s*1;/s)
    expect(source).toMatch(/\.direct-session-action\s*\{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/s)
    expect(source).toMatch(/\.direct-session-row:hover \.direct-session-action,[^{]+\.direct-session-row:focus-within \.direct-session-action\s*\{[^}]*opacity:\s*0\.62;[^}]*pointer-events:\s*auto;/s)
    expect(source).toMatch(/\.direct-session-row > \.run-mark,[^{]+\.direct-session-row > \.run-finished-mark,[^{]+\.direct-session-row > \.attention-mark\s*\{[^}]*grid-column:\s*4;[^}]*grid-row:\s*1;[^}]*justify-self:\s*end;/s)
    expect(source).toMatch(/\.run-agent-row\s*\{[^}]*grid-template-columns:\s*32px 20px;[^}]*grid-template-areas:\s*"avatar state"/s)
    expect(source).toMatch(/\.run-agent-state\s*\{[^}]*justify-content:\s*flex-end;/s)
  })

  it('hides scrollbars on the shell, chat page and dialogs but shows thin ones on long lists and panels', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')

    expect(source).toMatch(/html,\s*body,\s*#app\s*\{[^}]*scrollbar-width:\s*none;[^}]*-ms-overflow-style:\s*none;/s)
    expect(source).toMatch(/html::-webkit-scrollbar,[^}]+body::-webkit-scrollbar,[^}]+#app::-webkit-scrollbar,[^}]+\*::\-webkit-scrollbar\s*\{[^}]*width:\s*0;[^}]*height:\s*0;/s)
    // Only run details and settings keep visible scrollbars; sidebar scrolling stays available.
    expect(source).toMatch(/\.trace-panel-scroll,[^{]*\.settings-panel,[^{]*\{[^}]*scrollbar-width:\s*thin;[^}]*scrollbar-color:\s*var\(--scrollbar-thumb\) transparent;/s)
    expect(source).not.toMatch(/\.conversation-nav,[^{]*\{[^}]*scrollbar-width:\s*thin;/s)
    expect(source).not.toMatch(/\.message-scroll,[^{]*\{[^}]*scrollbar-width:\s*thin;/s)
    expect(source).not.toMatch(/\.modal-body,[^{]*\{[^}]*scrollbar-width:\s*thin;/s)
  })

  it('uses a distinct Meldwork palette and separates composer controls', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    const appSource = readFileSync(resolve(process.cwd(), 'src/App.vue'), 'utf8')
    const composerSource = readFileSync(resolve(process.cwd(), 'src/components/ConversationComposer.vue'), 'utf8')

    expect(source).toContain('--accent: #d45f52;')
    expect(source).toContain('--accent: #d98568;')
    expect(source).toMatch(/\.mode-segmented button\[data-mode="auto"\]\.active\s*\{[^}]*background:\s*var\(--accent-soft\);/s)
    expect(source).toMatch(/\.composer-attachment-button\s*\{[^}]*background:\s*transparent;/s)
    expect(source).toMatch(/\.composer-skill-button\s*\{[^}]*background:\s*transparent;/s)
    expect(source).toMatch(/:root\[data-theme="dark"\] \.send-button\s*\{[^}]*background:\s*transparent;/s)
    expect(source).not.toContain(':root[data-theme="dark"] img[src$="/hermes.svg"] {')
    expect(source).toMatch(/\.target-chip\s*\{[^}]*margin-left:\s*-19px;/s)
    expect(source).toMatch(/\.target-row\s*\{[^}]*background:\s*transparent;/s)
    expect(source).toMatch(/\.agent-card\s*\{[^}]*border:\s*0;[^}]*background:\s*color-mix/s)
    expect(source).toMatch(/\.agent-capability-list > span\s*\{[^}]*border:\s*0;/s)
    expect(source).toMatch(/\.agent-version\s*\{[^}]*max-width:\s*min\(20ch, 40%\);/s)
    expect(source).toMatch(/\.agent-card-meta-row\s*\{[^}]*display:\s*flex;[^}]*padding:\s*0 16px 14px 77px;/s)
    expect(source).toMatch(/\.settings-agent-actions\s*\{[^}]*flex-wrap:\s*nowrap;[^}]*padding:\s*0;/s)
    expect(source).toMatch(/\.settings-agent-card\.focused\s*\{[^}]*box-shadow:\s*none;/s)
    expect(source).toMatch(/\.message-row\.agent \.message-body:hover \.message-meta-actions > button,[^{]+\.message-row\.agent \.message-body:hover \.message-footer-actions > button/s)
    expect(source).toMatch(/\.message-meta-actions > button::after,[^{]+\.message-footer-actions > button::after,[^{]+\.code-copy-button::after\s*\{[^}]*bottom:\s*calc\(100% \+ 6px\);[^}]*background:\s*var\(--surface-raised\);/s)
    expect(source).toMatch(/\.message-footer-actions > button::after\s*\{[^}]*top:\s*calc\(100% \+ 6px\);[^}]*bottom:\s*auto;/s)
    // Group names use the full row; row actions float over the end with a fade instead of reserving a column.
    expect(source).toMatch(/\.conversation-link\s*\{[^}]*grid-template-columns:\s*26px minmax\(0, 1fr\) auto;/s)
    expect(source).toMatch(/\.group-conversation-actions\s*\{[^}]*position:\s*absolute;[^}]*background:\s*linear-gradient/s)
    expect(source).toMatch(/\.conversation-empty-wordmark\s*\{[^}]*width:\s*min\(276px, 60vw\);/s)
    expect(source).toMatch(/\.conversation-empty-copy\s*\{[^}]*width:\s*min\(920px, 100%\);[^}]*min-height:\s*60px;/s)
    expect(source).not.toContain('img[src$="/hermes.svg"],\n:root[data-theme="dark"] img[src$="/opencode.svg"]')
    expect(composerSource).toContain('composer-attachment-button')
    expect(composerSource).toContain('composer-skill-button')
    expect(appSource).not.toContain('window.confirm')
  })

  it('keeps the collapsed mobile sidebar to the expandable brand row', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    const mobileRules = source.slice(source.indexOf('@media (max-width: 760px)'))

    expect(mobileRules).toMatch(/\.sidebar\.collapsed\s*\{[^}]*min-height:\s*0;/)
    expect(mobileRules).toMatch(/\.sidebar\.collapsed\s*>\s*:not\(\.brand-row\)\s*\{[^}]*display:\s*none;/)
    expect(mobileRules).toMatch(/\.app-shell,\s*\.app-shell\.sidebar-collapsed\s*\{[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;/s)
  })

  it('lets the conversation and composer grow with wide desktop windows', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')

    expect(source).toMatch(/--conversation-content-width:\s*clamp\(820px,\s*70vw,\s*1360px\)/)
    expect(source).toMatch(/\.message-list\s*\{[^}]*width:\s*min\(var\(--conversation-content-width\),\s*100%\);[^}]*justify-self:\s*center;/s)
    expect(source).toMatch(/\.composer-shell\s*\{[^}]*width:\s*min\(var\(--conversation-content-width\),\s*100%\);/s)
  })

  it('pins the turn rail beside the sidebar with Dock proximity magnification', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    const composerSource = readFileSync(resolve(process.cwd(), 'src/components/ConversationComposer.vue'), 'utf8')

    expect(source).toMatch(/\.message-stage\s*\{[^}]*width:\s*100%;[^}]*grid-template-columns:\s*48px minmax\(0,\s*1fr\);[^}]*padding-right:\s*48px;/s)
    expect(source).toMatch(/\.turn-rail\s*\{[^}]*top:\s*50%;[^}]*transform:\s*translateY\(-50%\);/s)
    expect(source).toContain('.turn-rail button:has(+ button:hover)')
    expect(source).toContain('.turn-rail button:has(+ button + button + button:hover)')
    expect(source).toMatch(/\.turn-rail button:hover > span:first-child,[^{]+\{[^}]*--turn-offset:\s*10px;[^}]*--turn-scale:\s*2\.4;/s)
    expect(source).toMatch(/\.turn-rail button > span:first-child\s*\{[^}]*transform-origin:\s*left center;/s)
    expect(source).toMatch(/\.turn-rail button > span:first-child\s*\{[^}]*width:\s*var\(--turn-width\);[^}]*height:\s*var\(--turn-height\);[^}]*border:\s*0;[^}]*border-radius:\s*999px;/s)
    expect(source).toMatch(/\.turn-rail button > span:first-child\s*\{[^}]*transform:\s*translateX\(var\(--turn-offset\)\) scaleX\(var\(--turn-scale\)\);/s)
    expect(source).not.toMatch(/\.turn-rail button > span:first-child\s*\{[^}]*border-radius:\s*50%;/s)
    expect(source).not.toMatch(/\.turn-rail button > span:first-child\s*\{[^}]*box-shadow:\s*0 0 0 1px/s)
    expect(source).toMatch(/\.turn-rail-tooltip\s*\{[^}]*border:\s*0;[^}]*border-radius:\s*11px 11px 11px 5px;/s)
    expect(source).toMatch(/\.turn-rail-tooltip::before\s*\{[^}]*clip-path:\s*polygon\(100% 0, 0 50%, 100% 100%\);/s)
    expect(source).not.toContain('.turn-rail::before')
    expect(source).toMatch(/\.message-row\.topic-reply\s*\{[^}]*border-left:\s*0;/s)
    expect(source).toMatch(/\.message-row\.group-message\.agent \.message-body::before\s*\{[^}]*background:\s*var\(--agent-accent\);/s)
    expect(source).toMatch(/\.message-copy-surface\s*\{[^}]*cursor:\s*text;/s)
    expect(source).toMatch(/\.run-status-panel\.group\s*\{[^}]*border-left:\s*0;/s)
    expect(source).toMatch(/\.run-status-panel\s*\{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s)
    expect(source).toMatch(/\.run-status-panel\.solo\s*\{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s)
    expect(source).toMatch(/\.run-status-panel\.solo \.run-progress-details\s*\{[^}]*border-top:\s*0;/s)
    expect(source).toMatch(/\.run-agent-logo\[data-status="running"\]::before\s*\{[^}]*background:\s*color-mix/s)
    expect(source).toMatch(/\.run-status-panel\.group \.run-agent-logo::before\s*\{[^}]*content:\s*none;/s)
    expect(source).not.toContain('@keyframes run-agent-halo')
    expect(source).toMatch(/\.run-agent-logo\[data-status="queued"\] img,[^{]+\.run-agent-logo\[data-status="not-started"\] img\s*\{[^}]*opacity:\s*0\.38;/s)
    expect(source).toMatch(/\.run-trace-panel\s*\{[^}]*border-left:\s*0;/s)
    expect(source).not.toContain('.trace-conclusion')
    expect(source).toMatch(/--trace-panel-width:\s*clamp\(340px, 28vw, 520px\);/s)
    expect(source).toMatch(/\.app-shell\.trace-panel-open\s*\{[^}]*var\(--trace-panel-width\);/s)
    expect(source).toMatch(/\.trace-event-list details\s*\{[^}]*border:\s*0;/s)
    expect(source).toMatch(/\.trace-source-list button\s*\{[^}]*border:\s*0;/s)
    expect(source).toMatch(/\.composer-box\s*\{[^}]*border:\s*0;/s)
    expect(source).toMatch(/\.composer-context-row\s*\{[^}]*border-bottom:\s*0;/s)
    expect(source).toMatch(/\.send-button,\s*\.stop-button\s*\{[^}]*border:\s*0;/s)
    expect(source).toMatch(/\.send-button,\s*\.stop-button\s*\{[^}]*border-radius:\s*var\(--radius\);/s)
    expect(source).toMatch(/body\.trace-drawer-open\s*\{[^}]*overflow:\s*hidden;/s)
    expect(source).toMatch(/@media \(max-width: 1179px\)\s*\{[^}]*\.app-shell\.trace-panel-open,[^{]+\{[^}]*grid-template-columns:\s*var\(--sidebar-width\) minmax\(0, 1fr\);/s)
    expect(source).not.toContain('.stop-button-motion')
    expect(composerSource).toContain('<SendOutline v-else aria-hidden="true" />')
    expect(composerSource).toContain('<StopCircleOutline aria-hidden="true" />')
    expect(composerSource).not.toContain('<PlayOutline')
    expect(composerSource).not.toContain('<ArrowUpOutline')
  })

  it('merges live run events into the trace panel and closes it with Escape or browser back', async () => {
    const pushState = vi.spyOn(history, 'pushState')
    const back = vi.spyOn(history, 'back').mockImplementation(() => {})
    const { wrapper, emitRunEvent } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-1',
        conversationType: 'group',
        name: 'Trace review',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.messages.push({
        id: 'root-1',
        groupId: 'group-1',
        role: 'user',
        content: 'Inspect the implementation',
        targetKinds: ['codex', 'hermes'],
        createdAt: '2026-07-29T08:01:00Z',
      })
      state.runningGroupIds = ['group-1']
      state.runs = [{
        runId: 'run-1',
        groupId: 'group-1',
        threadRootId: 'root-1',
        phase: 'running',
        mode: 'auto',
        targetKinds: ['codex', 'hermes'],
        completedKinds: [],
        failedKinds: [],
        currentKind: 'codex',
        currentRound: 1,
        maxRounds: 4,
        progress: [],
        agentRuns: [{
          agentRunId: 'agent-run-codex',
          kind: 'codex',
          round: 1,
          status: 'running',
          output: '',
          events: [],
          sourceMessageIds: ['root-1', 'missing-source'],
          context: {
            includedCount: 4,
            omittedCount: 3,
            charCount: 720,
            sessionRotated: true,
          },
          seenSeqs: [],
        }],
      }]
    })

    await wrapper.get('.conversation-link').trigger('click')
    await wrapper.get('.run-agent-row:not([disabled])').trigger('click')
    await flushPromises()

    expect(wrapper.get('.run-trace-panel').exists()).toBe(true)
    expect(pushState).toHaveBeenCalledWith({ meldworkTracePanel: true }, '', window.location.href)
    expect(wrapper.get('.trace-context-stats').text()).toContain('4 messages injected for this attempt')
    expect(wrapper.get('.trace-context-stats').text()).toContain('3 messages compacted')
    expect(wrapper.get('.trace-context-stats').text()).toContain('720 context characters')
    expect(wrapper.get('.trace-context-stats').text()).toContain('Session context rotated')

    emitRunEvent({
      runId: 'run-1',
      agentRunId: 'agent-run-codex',
      groupId: 'group-1',
      threadRootId: 'root-1',
      agentKind: 'codex',
      round: 1,
      seq: 1,
      type: 'tool_start',
      status: 'running',
      title: 'Reviewing files',
      summary: 'Checking the sidebar implementation.',
      detail: 'Matched two files under [path].',
      command: 'cat /Users/private/secret.txt',
      secret: 'PRIVATE_TOKEN_VALUE',
      timestamp: '2026-07-29T08:02:00Z',
    })
    await flushPromises()

    expect(wrapper.get('.trace-event-list').text()).toContain('Reviewing files')
    expect(wrapper.get('.trace-event-list').text()).toContain('Running')
    const eventDetails = wrapper.get('.trace-event-list details')
    expect(eventDetails.element.open).toBe(false)
    eventDetails.element.open = true
    await eventDetails.trigger('toggle')
    expect(eventDetails.element.open).toBe(true)
    expect(wrapper.get('.trace-event-body').text()).toContain('Checking the sidebar implementation.')
    expect(wrapper.get('.trace-event-body').text()).toContain('Matched two files under [path].')
    expect(wrapper.get('.run-trace-panel').text()).not.toContain('/Users/private/secret.txt')
    expect(wrapper.get('.run-trace-panel').text()).not.toContain('PRIVATE_TOKEN_VALUE')
    expect(wrapper.get('.trace-event-time').text()).not.toBe('2026-07-29T08:02:00Z')
    expect(wrapper.get('.trace-event-live-status').text()).toBe('Codex / Tool call / Reviewing files / Running')
    expect(wrapper.get('.trace-panel-summary').attributes('aria-live')).toBeUndefined()
    expect(wrapper.get('.trace-source-section .trace-section-heading strong').text()).toBe('Messages injected for this attempt')
    const sourceButtons = wrapper.findAll('.trace-source-list button')
    expect(sourceButtons).toHaveLength(2)
    expect(sourceButtons[0].text()).toContain('You: Inspect the implementation')
    expect(sourceButtons[0].text()).not.toContain('root-1')
    expect(sourceButtons[0].attributes('disabled')).toBeUndefined()
    expect(sourceButtons[1].text()).toContain('Source unavailable')
    expect(sourceButtons[1].attributes()).toHaveProperty('disabled')
    const scrollIntoView = vi.fn()
    const sourceMessage = wrapper.get('#message-root-1')
    sourceMessage.element.scrollIntoView = scrollIntoView
    await sourceButtons[0].trigger('click')
    await flushPromises()
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(sourceMessage.element)
    expect(sourceMessage.attributes('tabindex')).toBe('-1')

    emitRunEvent({
      runId: 'run-1',
      agentRunId: 'agent-run-codex',
      groupId: 'group-1',
      threadRootId: 'root-1',
      agentKind: 'codex',
      round: 1,
      seq: 2,
      type: 'tool_start',
      status: 'running',
      title: 'Read source',
      timestamp: '2026-07-29T08:03:00Z',
    })
    emitRunEvent({
      runId: 'run-1',
      agentRunId: 'agent-run-codex',
      groupId: 'group-1',
      threadRootId: 'root-1',
      agentKind: 'codex',
      round: 1,
      seq: 3,
      type: 'status',
      status: 'running',
      title: 'Agent',
      timestamp: '2026-07-29T08:04:00Z',
    })
    emitRunEvent({
      runId: 'run-1',
      agentRunId: 'agent-run-codex',
      groupId: 'group-1',
      threadRootId: 'root-1',
      agentKind: 'codex',
      round: 1,
      seq: 4,
      type: 'status',
      status: 'running',
      title: 'Process',
      timestamp: '2026-07-29T08:05:00Z',
    })
    emitRunEvent({
      runId: 'run-1',
      agentRunId: 'agent-run-codex',
      groupId: 'group-1',
      threadRootId: 'root-1',
      agentKind: 'codex',
      round: 1,
      seq: 5,
      type: 'warning',
      status: 'partial',
      title: 'connector_limited',
      timestamp: '2026-07-29T08:06:00Z',
    })
    await flushPromises()

    emitRunEvent({
      runId: 'run-1',
      agentRunId: 'agent-run-codex',
      groupId: 'group-1',
      threadRootId: 'root-1',
      agentKind: 'codex',
      round: 1,
      seq: 6,
      type: 'warning',
      status: 'waiting',
      title: 'connector_fallback',
      timestamp: '2026-07-29T08:07:00Z',
    })
    await flushPromises()
    const visibleEventTitles = wrapper.findAll('.trace-event-title').map(item => item.text())
    expect(visibleEventTitles).toContain('Read source')
    expect(visibleEventTitles)
      .toContain('Connector provided only the final answer; structured tool activity was unavailable.')
    expect(visibleEventTitles)
      .toContain('Structured connector failed before execution; switched to compatibility mode.')

    setLocale('zh')
    await flushPromises()
    const localizedEventTitles = wrapper.findAll('.trace-event-title').map(item => item.text())
    expect(localizedEventTitles).toContain('Reviewing files')
    expect(localizedEventTitles).toContain('Read source')
    expect(wrapper.get('.trace-source-section .trace-section-heading strong').text()).toBe('本次尝试注入的消息')
    expect(wrapper.findAll('.trace-source-list button')[1].text()).toContain('来源不可用')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(wrapper.find('.run-trace-panel').exists()).toBe(false)
    expect(back).toHaveBeenCalledTimes(1)

    await wrapper.get('.run-agent-row:not([disabled])').trigger('click')
    await flushPromises()
    window.dispatchEvent(new PopStateEvent('popstate'))
    await flushPromises()
    expect(wrapper.find('.run-trace-panel').exists()).toBe(false)
    expect(back).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('traps keyboard focus inside the responsive trace drawer', async () => {
    const wrapper = mount(RunTracePanel, {
      attachTo: document.body,
      props: {
        open: true,
        drawer: true,
        items: [{
          agentRunId: 'agent-run-codex',
          agentKind: 'codex',
          round: 1,
          status: 'running',
          output: '',
          summary: '',
          events: [],
          sourceMessageIds: [],
          context: {},
        }],
        selectedAgentRunId: 'agent-run-codex',
      },
    })
    const focusable = [...wrapper.get('.run-trace-panel').element.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    )]
    const first = focusable[0]
    const last = focusable.at(-1)

    last.focus()
    await wrapper.get('.run-trace-panel').trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(first)

    first.focus()
    await wrapper.get('.run-trace-panel').trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
    wrapper.unmount()
  })

  it('uses the partial tone for terminal trace statuses', () => {
    const wrapper = mount(RunTracePanel, {
      props: {
        open: true,
        items: [{
          agentRunId: 'agent-run-terminal',
          agentKind: 'codex',
          status: 'stopped',
          output: '',
          summary: '',
          events: [
            { type: 'tool_update', status: 'interrupted' },
            { type: 'tool_result_summary', status: 'cancelled' },
          ],
          sourceMessageIds: [],
          context: {},
        }],
        selectedAgentRunId: 'agent-run-terminal',
      },
    })

    expect(wrapper.get('.trace-status').attributes('data-status')).toBe('partial')
    expect(wrapper.findAll('.trace-event-status').map(status => status.attributes('data-status')))
      .toEqual(['partial', 'partial'])
    wrapper.unmount()
  })

  it('localizes default group names and structured system messages at render time', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-1',
        name: '',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.messages.push({
        id: 'message-1',
        groupId: 'group-1',
        role: 'system',
        agentKind: 'hermes',
        content: 'Hermes failed: LOCAL_AGENT_TIMEOUT\nRecovered conclusion before timeout.',
        system: {
          key: 'system.agentCallFailed',
          params: { agent: 'Hermes', reason: 'LOCAL_AGENT_TIMEOUT' },
        },
        createdAt: '2026-07-29T08:01:00Z',
      })
    })

    expect(wrapper.get('.conversation-link').text()).toContain('Agent group')
    await wrapper.get('.conversation-link').trigger('click')
    expect(wrapper.get('.system-message-agent-avatar').attributes('src')).toContain('/agent-logos/hermes')
    expect(wrapper.get('.system-message-agent-avatar').attributes('alt')).toBe('Hermes')
    expect(wrapper.get('.system-message').text()).toContain('Hermes failed: This Agent took too long to respond.')
    expect(wrapper.get('.system-message .markdown-body').text()).toBe('Recovered conclusion before timeout.')
    expect(wrapper.get('.system-message').text()).not.toContain('Hermes failed: LOCAL_AGENT_TIMEOUT')

    await wrapper.findAll('.titlebar-preferences button')[0].trigger('click')
    expect(wrapper.get('.conversation-link').text()).toContain('Agent 群聊')
    expect(wrapper.get('.system-message').text()).toContain('Hermes 调用失败：该 Agent 响应超时')
    expect(wrapper.get('.system-message .markdown-body').text()).toBe('Recovered conclusion before timeout.')
    expect(wrapper.get('.system-message').text()).not.toContain('Hermes failed: LOCAL_AGENT_TIMEOUT')
    wrapper.unmount()
  })

  it('does not treat a multiline failure reason as a streamed Agent conclusion', async () => {
    const reason = 'process failed\n**legacy diagnostic only**'
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'direct-multiline-failure',
        conversationType: 'direct',
        directAgentKind: 'codex',
        name: 'Multiline failure',
        topic: '',
        agentKinds: ['codex'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:01:00Z',
      })
      state.messages.push({
        id: 'multiline-failure',
        groupId: 'direct-multiline-failure',
        role: 'system',
        agentKind: 'codex',
        content: `Codex failed: ${reason}`,
        system: {
          key: 'system.agentCallFailed',
          params: { agent: 'Codex', reason },
        },
        trace: {
          runId: 'run-multiline-failure',
          agentRunId: 'agent-multiline-failure',
          status: 'failed',
          events: [],
        },
        createdAt: '2026-07-29T08:01:00Z',
      })
    })

    await wrapper.get('.direct-session-open').trigger('click')
    expect(wrapper.get('.system-message').text()).toContain('Codex failed: process failed')
    expect(wrapper.find('.system-message .markdown-body').exists()).toBe(false)
    expect(wrapper.find('.system-message strong').exists()).toBe(false)

    setLocale('zh')
    await flushPromises()
    expect(wrapper.get('.system-message').text()).toContain('Codex 调用失败：process failed')
    expect(wrapper.find('.system-message .markdown-body').exists()).toBe(false)
    wrapper.unmount()
  })

  it('preserves selected targets across equivalent structured-clone snapshots', async () => {
    const { wrapper, emitWorkspaceChanged } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-1',
        conversationType: 'group',
        name: 'Review',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    await wrapper.get('.conversation-link').trigger('click')
    await wrapper.get('.mode-segmented [data-mode="manual"]').trigger('click')
    await wrapper.findAll('.target-chip')[1].trigger('click')
    expect(wrapper.findAll('.target-chip')[0].classes()).toContain('selected')
    expect(wrapper.findAll('.target-chip')[1].classes()).not.toContain('selected')

    emitWorkspaceChanged()
    await flushPromises()

    expect(wrapper.findAll('.target-chip')[0].classes()).toContain('selected')
    expect(wrapper.findAll('.target-chip')[1].classes()).not.toContain('selected')
    wrapper.unmount()
  })

  it('keeps explicit routing as the default and sends automatic team formation only when enabled', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-1',
        conversationType: 'group',
        name: 'Review',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    await wrapper.get('.conversation-link').trigger('click')
    await wrapper.get('.mode-segmented [data-mode="manual"]').trigger('click')
    const smartTeam = wrapper.get('.smart-team-trigger')
    expect(wrapper.find('[data-routing-mode]').exists()).toBe(false)
    expect(smartTeam.get('.smart-team-label').text()).toBe('Smart team')
    expect(smartTeam.get('.smart-team-status').text()).toBe('Off')
    expect(smartTeam.attributes('aria-pressed')).toBe('false')
    expect(smartTeam.find('.smart-team-icon-state-off').exists()).toBe(true)
    expect(smartTeam.find('.smart-team-icon-state-on').exists()).toBe(true)
    expect(wrapper.find('.smart-team-tooltip').exists()).toBe(false)
    expect(wrapper.get('.composer-box textarea').attributes('placeholder')).toBe('Every Agent receives your message at once and replies independently, with no hand-offs.')
    expect(wrapper.findAll('.target-chip').every(chip => chip.attributes('disabled') === undefined)).toBe(true)

    await wrapper.get('.smart-team-control').trigger('mouseenter')
    expect(wrapper.get('.smart-team-tooltip').attributes('role')).toBe('tooltip')
    expect(wrapper.get('.smart-team-tooltip').text()).toContain('Off uses the selected group Agents')
    await wrapper.get('.smart-team-control').trigger('mouseleave')
    expect(wrapper.find('.smart-team-tooltip').exists()).toBe(false)

    await wrapper.get('.composer-box textarea').setValue('Use the selected Agents')
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()
    expect(bridge.localWorkspace.send).toHaveBeenNthCalledWith(1, {
      groupId: 'group-1',
      text: 'Use the selected Agents',
      targetKinds: ['codex', 'hermes'],
      skillHints: [],
      knowledgeBaseHints: [],
      attachments: [],
      mode: 'manual',
      protocol: 'v4',
      maxRounds: 6,
    })

    await smartTeam.trigger('click')
    expect(smartTeam.get('.smart-team-status').text()).toBe('On')
    expect(smartTeam.attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('.composer-box textarea').attributes('placeholder')).toBe('Describe the task and Meldwork will choose the right Agent team')
    expect(wrapper.findAll('.target-chip').every(chip => chip.attributes('disabled') !== undefined)).toBe(true)

    await wrapper.get('.smart-team-control').trigger('mouseenter')
    expect(wrapper.get('.smart-team-tooltip').text()).toContain('ignore manual Agent targets')
    await wrapper.get('.smart-team-control').trigger('mouseleave')

    await wrapper.get('.composer-box textarea').setValue('Choose the smallest suitable team')
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.send).toHaveBeenNthCalledWith(2, {
      groupId: 'group-1',
      text: 'Choose the smallest suitable team',
      targetKinds: [],
      routingMode: 'automatic',
      skillHints: [],
      knowledgeBaseHints: [],
      attachments: [],
      mode: 'manual',
      protocol: 'v4',
      maxRounds: 6,
    })

    await smartTeam.trigger('click')
    expect(smartTeam.get('.smart-team-status').text()).toBe('Off')
    expect(wrapper.get('.composer-box textarea').attributes('placeholder')).toBe('Every Agent receives your message at once and replies independently, with no hand-offs.')
    expect(wrapper.findAll('.target-chip').every(chip => chip.attributes('disabled') === undefined)).toBe(true)

    setLocale('zh')
    await flushPromises()
    expect(smartTeam.get('.smart-team-label').text()).toBe('智能组队')
    expect(smartTeam.get('.smart-team-status').text()).toBe('关闭')
    await wrapper.get('.smart-team-control').trigger('mouseenter')
    expect(wrapper.get('.smart-team-tooltip').text()).toContain('关闭时使用当前群聊或手动选择的 Agent')
    wrapper.unmount()
  })

  it('keeps a pending send isolated to its conversation while another conversation sends', async () => {
    const pendingGroupSend = deferred()
    const { wrapper, bridge, state } = await mountApp(({ state, bridge: desktopBridge }) => {
      desktopBridge.localWorkspace.send.mockReturnValueOnce(pendingGroupSend.promise)
      state.groups.push(
        {
          id: 'group-1',
          conversationType: 'group',
          name: 'Review',
          topic: '',
          agentKinds: ['codex', 'hermes'],
          workdir: '/tmp/meldwork-workspace',
          allowWrite: false,
          createdAt: '2026-07-29T08:00:00Z',
          updatedAt: '2026-07-29T08:00:00Z',
        },
        {
          id: 'direct-codex',
          conversationType: 'direct',
          directAgentKind: 'codex',
          name: 'Codex direct',
          topic: '',
          agentKinds: ['codex'],
          workdir: '/tmp/meldwork-workspace',
          allowWrite: false,
          createdAt: '2026-07-29T08:01:00Z',
          updatedAt: '2026-07-29T08:01:00Z',
        },
      )
    })

    await wrapper.get('.conversation-link').trigger('click')
    await wrapper.get('.mode-segmented [data-mode="manual"]').trigger('click')
    await wrapper.get('.composer-box textarea').setValue('Group task')
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()
    expect(bridge.localWorkspace.send).toHaveBeenCalledTimes(1)
    expect(wrapper.get('.composer-box textarea').attributes()).toHaveProperty('disabled')

    await wrapper.get('.direct-session-open').trigger('click')
    await flushPromises()
    expect(wrapper.get('.conversation-header h1').text()).toBe('Codex direct')
    expect(wrapper.get('.composer-box textarea').attributes()).not.toHaveProperty('disabled')

    await wrapper.get('.composer-box textarea').setValue('Direct task')
    expect(wrapper.get('.send-button').attributes()).not.toHaveProperty('disabled')
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.send).toHaveBeenCalledTimes(2)
    expect(bridge.localWorkspace.send.mock.calls[1][0]).toMatchObject({
      groupId: 'direct-codex',
      text: 'Direct task',
      targetKinds: ['codex'],
    })

    pendingGroupSend.resolve(structuredClone(state))
    await flushPromises()
    wrapper.unmount()
  })

  it('sends one atomic automatic discussion with bounded rounds', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-1',
        conversationType: 'group',
        name: 'Review',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.messages.push(
        {
          id: 'root-1',
          groupId: 'group-1',
          role: 'user',
          content: 'First topic',
          createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'reply-1',
          groupId: 'group-1',
          role: 'agent',
          agentKind: 'codex',
          content: 'First reply',
          threadRootId: 'root-1',
          createdAt: '2026-07-29T08:02:00Z',
        },
        {
          id: 'root-2',
          groupId: 'group-1',
          role: 'user',
          content: 'Latest topic',
          createdAt: '2026-07-29T08:03:00Z',
        },
      )
    })

    await wrapper.get('.conversation-link').trigger('click')
    expect(wrapper.get('.mode-segmented [data-mode="auto"]').classes()).toContain('active')
    expect(wrapper.get('.round-settings-trigger').text()).toContain('6 rounds')
    expect(wrapper.findAll('.target-chip').every(chip => chip.classes().includes('selected'))).toBe(true)
    expect(wrapper.findAll('.target-chip').every(chip => chip.attributes('disabled') !== undefined)).toBe(true)
    expect(wrapper.findAll('.target-chip')[0].attributes('aria-label')).toBe('Codex participates in automatic discussion')

    await wrapper.get('.round-settings-trigger').trigger('click')
    const range = wrapper.get('.round-range-input')
    await range.setValue(1)
    expect(wrapper.get('.round-settings-popover output').text()).toBe('1 rounds')
    await range.setValue(10)
    expect(wrapper.get('.round-settings-popover output').text()).toBe('10 rounds')
    await range.setValue(6)
    await wrapper.get('.round-unlimited-button').trigger('click')
    await flushPromises()
    expect(wrapper.get('.confirmation-modal-body').text()).toContain('until collaboration ends or you stop it')
    expect(wrapper.find('.round-range-input').exists()).toBe(true)
    await wrapper.get('.confirmation-modal-footer .primary-button').trigger('click')
    await flushPromises()
    expect(wrapper.find('.round-range-input').exists()).toBe(false)
    expect(wrapper.get('.round-settings-trigger').text()).toContain('No round limit')
    await wrapper.get('.round-bounded-button').trigger('click')
    await flushPromises()
    expect(wrapper.find('.round-range-input').exists()).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(wrapper.find('.round-settings-popover').exists()).toBe(false)

    await wrapper.get('.composer-box textarea').setValue('Continue the review')
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.send).toHaveBeenCalledTimes(1)
    expect(bridge.localWorkspace.send).toHaveBeenCalledWith({
      groupId: 'group-1',
      text: 'Continue the review',
      targetKinds: ['codex', 'hermes'],
      skillHints: [],
      knowledgeBaseHints: [],
      attachments: [],
      mode: 'auto',
      protocol: 'v4',
      maxRounds: 6,
    })
    expect(bridge.localWorkspace.startAuto).toBeUndefined()
    wrapper.unmount()
  })

  it('sends unlimited automatic discussions without a round cap', async () => {
    const { wrapper, bridge } = await mountApp(({ state, bridge: desktopBridge }) => {
      state.groups.push({
        id: 'group-1',
        conversationType: 'group',
        name: 'Open discussion',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      desktopBridge.localWorkspace.send.mockImplementation(async (input) => {
        state.runningGroupIds = [input.groupId]
        state.runs = [{
          groupId: input.groupId,
          mode: 'auto',
          targetKinds: input.targetKinds,
          completedKinds: [],
          currentKind: 'codex',
          currentRound: 1,
          maxRounds: 0,
          unlimitedRounds: true,
          progress: [],
        }]
        return structuredClone(state)
      })
    })

    await wrapper.get('.conversation-link').trigger('click')
    await wrapper.get('.round-settings-trigger').trigger('click')
    await wrapper.get('.round-unlimited-button').trigger('click')
    await wrapper.get('.confirmation-modal-footer .primary-button').trigger('click')
    await wrapper.get('.composer-box textarea').setValue('Continue until consensus')
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.send).toHaveBeenCalledWith({
      groupId: 'group-1',
      text: 'Continue until consensus',
      targetKinds: ['codex', 'hermes'],
      skillHints: [],
      knowledgeBaseHints: [],
      attachments: [],
      mode: 'auto',
      protocol: 'v4',
      maxRounds: 6,
      unlimitedRounds: true,
    })
    expect(wrapper.get('.run-round-progress').text()).toBe('Round 1 / No round limit')
    wrapper.unmount()
  })

  it('creates direct chats and local Agent groups', async () => {
    const { wrapper, bridge, state } = await mountApp()

    let createdGroup = null
    const directGroup = {
      id: 'direct-codex',
      conversationType: 'direct',
      directAgentKind: 'codex',
      name: 'Codex',
      agentKinds: ['codex'],
      workdir: '/tmp/meldwork-workspace',
      allowWrite: true,
      createdAt: '2026-07-29T08:00:00Z',
      updatedAt: '2026-07-29T08:00:00Z',
    }
    bridge.localWorkspace.createGroup.mockResolvedValueOnce(directGroup)
    bridge.localWorkspace.createGroup.mockImplementationOnce(async input => {
      createdGroup = {
        id: 'group-1',
        createdAt: '2026-07-29T09:00:00Z',
        updatedAt: '2026-07-29T09:00:00Z',
        ...structuredClone(input),
      }
      return structuredClone(createdGroup)
    })
    bridge.localWorkspace.get.mockImplementation(async () => ({
      ...state,
      groups: createdGroup ? [directGroup, createdGroup] : [directGroup],
    }))

    await wrapper.findAll('.home-agent-item')[0].trigger('click')
    await flushPromises()
    expect(bridge.localWorkspace.createGroup).toHaveBeenCalledWith({
      conversationType: 'direct',
      directAgentKind: 'codex',
      name: 'Codex',
      agentKinds: ['codex'],
      workdir: '/tmp/meldwork-workspace',
      allowWrite: true,
    })
    expect(wrapper.get('.conversation-capabilities').text()).toContain('Write enabled')

    await wrapper.get('.new-group-button').trigger('click')
    await flushPromises()
    expect(wrapper.get('.modal.medium').attributes('aria-labelledby')).toBe('modal-title')
    expect(wrapper.get('#modal-title').text()).toBe('New Agent group')
    const groupInputs = wrapper.findAll('.form-stack input:not([type="checkbox"])')
    expect(wrapper.get('.switch-row input[type="checkbox"]').element.checked).toBe(true)
    expect(document.activeElement).toBe(wrapper.get('.modal.medium').element)
    await groupInputs[0].setValue('Local review')
    await groupInputs[1].setValue('Review the implementation')
    await wrapper.get('form.form-stack').trigger('submit')
    await flushPromises()

    expect(bridge.localWorkspace.createGroup).toHaveBeenLastCalledWith(expect.objectContaining({
      name: 'Local review',
      topic: 'Review the implementation',
      agentKinds: ['codex', 'hermes'],
      workdir: '/tmp/meldwork-workspace',
      allowWrite: true,
    }))
    expect(() => structuredClone(bridge.localWorkspace.createGroup.mock.calls.at(-1)[0])).not.toThrow()
    wrapper.unmount()
  })

  it('creates only one direct chat when its entry point is clicked twice rapidly', async () => {
    const creation = deferred()
    const directGroup = {
      id: 'direct-codex',
      conversationType: 'direct',
      directAgentKind: 'codex',
      name: 'Codex',
      agentKinds: ['codex'],
      workdir: '/tmp/meldwork-workspace',
      allowWrite: false,
      createdAt: '2026-07-29T08:00:00Z',
      updatedAt: '2026-07-29T08:00:00Z',
    }
    const { wrapper, bridge, state } = await mountApp(({ bridge: desktopBridge }) => {
      desktopBridge.localWorkspace.createGroup.mockReturnValueOnce(creation.promise)
    })
    bridge.localWorkspace.get.mockImplementation(async () => ({ ...state, groups: [directGroup] }))

    const openChat = wrapper.findAll('.sidebar-agent-new')[0]
    openChat.element.click()
    openChat.element.click()
    await wrapper.vm.$nextTick()

    expect(bridge.localWorkspace.createGroup).toHaveBeenCalledTimes(1)
    expect(openChat.attributes()).toHaveProperty('disabled')

    creation.resolve(directGroup)
    await flushPromises()

    expect(openChat.attributes()).not.toHaveProperty('disabled')
    wrapper.unmount()
  })

  it('keeps a group creation modal open while its save is pending', async () => {
    const creation = deferred()
    const group = {
      id: 'group-1',
      conversationType: 'group',
      name: 'Review',
      topic: '',
      agentKinds: ['codex', 'hermes'],
      workdir: '/tmp/meldwork-workspace',
      allowWrite: false,
      createdAt: '2026-07-29T08:00:00Z',
      updatedAt: '2026-07-29T08:00:00Z',
    }
    const { wrapper, bridge, state } = await mountApp(({ bridge: desktopBridge }) => {
      desktopBridge.localWorkspace.createGroup.mockReturnValueOnce(creation.promise)
    })
    bridge.localWorkspace.get.mockImplementation(async () => ({ ...state, groups: [group] }))

    await wrapper.get('.new-group-button').trigger('click')
    await wrapper.get('form.form-stack').trigger('submit')

    const closeButton = wrapper.get('.modal-header .icon-button')
    const cancelButton = wrapper.get('.modal-footer .secondary-button')
    expect(closeButton.attributes()).toHaveProperty('disabled')
    expect(cancelButton.attributes()).toHaveProperty('disabled')

    await wrapper.get('.modal-backdrop').trigger('mousedown')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    closeButton.element.click()
    cancelButton.element.click()
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.modal.medium').exists()).toBe(true)
    expect(bridge.localWorkspace.createGroup).toHaveBeenCalledTimes(1)

    creation.resolve(group)
    await flushPromises()

    expect(wrapper.find('.modal.medium').exists()).toBe(false)
    wrapper.unmount()
  })

  it('restores modal history when browser back occurs during pending group creation', async () => {
    const creation = deferred()
    const group = {
      id: 'group-1',
      conversationType: 'group',
      name: 'Review',
      topic: '',
      agentKinds: ['codex', 'hermes'],
      workdir: '/tmp/meldwork-workspace',
      allowWrite: false,
      createdAt: '2026-07-29T08:00:00Z',
      updatedAt: '2026-07-29T08:00:00Z',
    }
    const historyPush = vi.spyOn(window.history, 'pushState').mockImplementation(() => {})
    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const { wrapper, bridge, state } = await mountApp(({ bridge: desktopBridge }) => {
      desktopBridge.localWorkspace.createGroup.mockReturnValueOnce(creation.promise)
    })
    bridge.localWorkspace.get.mockImplementation(async () => ({ ...state, groups: [group] }))

    await wrapper.get('.new-group-button').trigger('click')
    await wrapper.get('form.form-stack').trigger('submit')
    expect(historyPush).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new PopStateEvent('popstate'))
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.modal.medium').exists()).toBe(true)
    expect(historyPush).toHaveBeenCalledTimes(2)
    expect(historyBack).not.toHaveBeenCalled()

    creation.resolve(group)
    await flushPromises()

    expect(wrapper.find('.modal.medium').exists()).toBe(false)
    expect(historyBack).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('returns focus to the control that opened a modal', async () => {
    vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const { wrapper } = await mountApp()
    const trigger = wrapper.get('.new-group-button')
    trigger.element.focus()

    await trigger.trigger('click')
    expect(document.activeElement).toBe(wrapper.get('.modal.medium').element)

    await wrapper.get('.modal-header .icon-button').trigger('click')
    await flushPromises()

    expect(document.activeElement).toBe(trigger.element)
    wrapper.unmount()
  })

  it('keeps unavailable Agent histories accessible without allowing new runs', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
      Object.assign(state.agents.find(agent => agent.kind === 'hermes'), {
        available: false,
        credentialState: 'missing',
        showInSidebar: true,
      })
      state.groups.push({
        id: 'direct-hermes',
        conversationType: 'direct',
        directAgentKind: 'hermes',
        name: 'Hermes history',
        topic: '',
        agentKinds: ['hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: true,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    const hermesAgent = wrapper.findAll('.sidebar-agent')
      .find(agent => agent.text().includes('Hermes'))
    expect(hermesAgent.get('.sidebar-agent-new').attributes()).toHaveProperty('disabled')
    expect(hermesAgent.findAll('.direct-session-action')).toHaveLength(2)

    await hermesAgent.get('.direct-session-open').trigger('click')

    expect(wrapper.get('.conversation-header h1').text()).toBe('Hermes history')
    expect(wrapper.get('.conversation-capabilities').text()).toContain('Write enabled')
    const textarea = wrapper.get('.composer-box textarea')
    await textarea.setValue('Continue this task')
    expect(wrapper.get('.send-button').attributes()).toHaveProperty('disabled')

    await textarea.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(bridge.localWorkspace.send).not.toHaveBeenCalled()
    expect(wrapper.get('.toast-message').text()).toContain('This local Agent is unavailable.')
    wrapper.unmount()
  })

  it('keeps an unavailable installed Agent without history visible and opens its settings', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
      Object.assign(state.agents.find(agent => agent.kind === 'hermes'), {
        available: false, credentialState: 'missing', showInSidebar: true,
      })
    })
    const agent = wrapper.findAll('.sidebar-agent').find(row => row.text().includes('Hermes'))
    expect(agent.get('small').text()).toBe('Needs sign-in')
    expect(agent.get('.sidebar-agent-main').attributes('title')).toContain('Needs sign-in')
    expect(agent.get('.sidebar-agent-new').attributes()).toHaveProperty('disabled')
    await agent.get('.sidebar-agent-main').trigger('click')
    await flushPromises()
    expect(wrapper.find('.system-settings-page').exists()).toBe(true)
    expect(wrapper.find('.conversation-header').exists()).toBe(false)
    expect(bridge.localWorkspace.createGroup).not.toHaveBeenCalled()
    expect(bridge.localWorkspace.send).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('sends a structured-cloneable plain payload when group settings are saved', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-1',
        conversationType: 'group',
        name: 'Review',
        topic: 'Initial topic',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    await wrapper.get('.conversation-link').trigger('click')
    await wrapper.findAll('.conversation-header-actions .icon-button').at(-1).trigger('click')
    expect(wrapper.get('.modal-header p').text()).toBe('Review')
    const primaryInputs = wrapper.findAll('.settings-primary-grid input')
    expect(primaryInputs[0].element.value).toBe('Review')
    expect(primaryInputs[0].attributes('placeholder')).toBe('Design review')
    expect(primaryInputs[1].element.value).toBe('Initial topic')
    expect(primaryInputs[1].attributes('placeholder')).toBe('What should the Agents work on?')
    expect(wrapper.findAll('.settings-agent-choice.selected')).toHaveLength(2)
    await wrapper.get('form.form-stack').trigger('submit')
    await flushPromises()

    expect(bridge.localWorkspace.updateGroup).toHaveBeenCalledWith('group-1', {
      name: 'Review',
      topic: 'Initial topic',
      agentKinds: ['codex', 'hermes'],
      workdir: '/tmp/meldwork-workspace',
      allowWrite: false,
    })
    expect(() => structuredClone(bridge.localWorkspace.updateGroup.mock.calls[0][1])).not.toThrow()
    wrapper.unmount()
  })

  it('renames a group inline and cancels a later edit with Escape', async () => {
    const { wrapper, bridge } = await mountApp(({ state, bridge: desktopBridge }) => {
      state.groups.push({
        id: 'group-1',
        conversationType: 'group',
        name: 'Review',
        topic: 'Initial topic',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: true,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      desktopBridge.localWorkspace.updateGroup.mockImplementation(async (groupId, input) => {
        Object.assign(state.groups.find(group => group.id === groupId), structuredClone(input))
        return structuredClone(state.groups.find(group => group.id === groupId))
      })
      desktopBridge.localWorkspace.get.mockImplementation(async () => structuredClone(state))
    })

    await wrapper.get('.conversation-link').trigger('click')
    await wrapper.get('.conversation-title-button').trigger('click')
    const input = wrapper.get('.inline-title-form input')
    await input.setValue('Architecture review')
    await wrapper.get('.inline-title-form').trigger('submit')
    await flushPromises()

    expect(bridge.localWorkspace.updateGroup).toHaveBeenCalledWith('group-1', {
      name: 'Architecture review',
    })
    expect(wrapper.get('.conversation-header h1').text()).toBe('Architecture review')

    await wrapper.get('.conversation-title-button').trigger('click')
    await wrapper.get('.inline-title-form input').setValue('Discarded title')
    await wrapper.get('.inline-title-form input').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('.inline-title-form').exists()).toBe(false)
    expect(wrapper.get('.conversation-header h1').text()).toBe('Architecture review')
    expect(bridge.localWorkspace.updateGroup).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('cancels and saves inline title edits for a direct conversation', async () => {
    const { wrapper, bridge } = await mountApp(({ state, bridge: desktopBridge }) => {
      state.groups.push({
        id: 'direct-codex',
        conversationType: 'direct',
        directAgentKind: 'codex',
        name: 'Codex review',
        topic: 'Keep context',
        agentKinds: ['codex'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      desktopBridge.localWorkspace.updateGroup.mockImplementation(async (groupId, input) => {
        Object.assign(state.groups.find(group => group.id === groupId), structuredClone(input))
        return structuredClone(state.groups.find(group => group.id === groupId))
      })
      desktopBridge.localWorkspace.get.mockImplementation(async () => structuredClone(state))
    })

    await wrapper.get('.direct-session-open').trigger('click')
    await wrapper.get('.conversation-title-button').trigger('click')
    await wrapper.get('.inline-title-form input').setValue('Temporary name')
    await wrapper.get('.inline-title-form button[type="button"]').trigger('click')
    expect(wrapper.get('.conversation-header h1').text()).toBe('Codex review')
    expect(bridge.localWorkspace.updateGroup).not.toHaveBeenCalled()

    await wrapper.get('.conversation-title-button').trigger('click')
    await wrapper.get('.inline-title-form input').setValue('Code audit')
    await wrapper.get('.inline-title-form').trigger('submit')
    await flushPromises()

    expect(bridge.localWorkspace.updateGroup).toHaveBeenCalledWith('direct-codex', {
      name: 'Code audit',
    })
    expect(wrapper.get('.conversation-header h1').text()).toBe('Code audit')
    wrapper.unmount()
  })

  it('keeps the inline title editor focused without an underline or outer accent ring', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')

    expect(source).toMatch(/\.inline-title-form input\s*\{[^}]*border:\s*1px solid transparent;[^}]*outline:\s*none;[^}]*box-shadow:\s*none;/s)
    expect(source).toMatch(/\.inline-title-form input:focus-visible\s*\{[^}]*outline:\s*none;[^}]*box-shadow:\s*none;/s)
    expect(source).toMatch(/\.inline-title-form input::selection\s*\{[^}]*var\(--accent\) 28%/s)
  })
})

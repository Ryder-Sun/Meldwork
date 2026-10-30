import { readFileSync as readNodeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENTS } from '../../catalog.js'
import RunTracePanel from '../../components/RunTracePanel.vue'
import { setLocale } from '../../i18n.js'
import { deferred, imageAttachment, mountApp } from './app-test-harness.js'
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
  it('keeps a sanitized busy run shell stoppable while the composer stays locked', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-safe-run-shell',
        conversationType: 'group',
        name: 'Safe run shell',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.runningGroupIds = ['group-safe-run-shell']
      state.runs = [{
        groupId: 'group-safe-run-shell',
        runId: 'run-safe-shell',
        phase: 'running',
        mode: 'manual',
        targetKinds: ['codex', 'hermes'],
        completedKinds: [],
        failedKinds: [],
        currentKind: '',
        currentRound: 0,
        maxRounds: 0,
        unlimitedRounds: false,
        progress: [],
        threadRootId: '',
        responseVersionRootId: '',
        startedAt: '2026-07-29T08:01:00Z',
        agentRuns: [],
        waitingGateIds: [],
        budget: null,
        orchestration: { version: 4 },
        terminalPersistence: { state: 'failed', privatePath: '/private/ledger' },
        unexpectedTopLevel: 'must-not-cross-the-bridge',
      }]
    })

    await wrapper.get('.conversation-link').trigger('click')
    await flushPromises()

    expect(wrapper.get('.composer-box textarea').attributes()).toHaveProperty('disabled')
    expect(wrapper.find('.send-button').exists()).toBe(false)
    expect(wrapper.get('.stop-button').attributes('aria-label')).toBe('Stop')
    await wrapper.get('.stop-button').trigger('click')
    expect(bridge.localWorkspace.stop).toHaveBeenCalledWith('group-safe-run-shell', 'run-safe-shell')
    wrapper.unmount()
  })

  it('keeps send state isolated while direct and group conversations run concurrently', async () => {
    const directSend = deferred()
    const groupSend = deferred()
    const { wrapper, bridge } = await mountApp(({ state, bridge: desktopBridge }) => {
      state.groups.push(
        {
          id: 'direct-concurrent',
          conversationType: 'direct',
          directAgentKind: 'codex',
          name: 'Codex direct',
          topic: '',
          agentKinds: ['codex'],
          workdir: '/tmp/meldwork-workspace',
          allowWrite: false,
          createdAt: '2026-07-29T08:00:00Z',
          updatedAt: '2026-07-29T08:00:00Z',
        },
        {
          id: 'group-concurrent',
          conversationType: 'group',
          name: 'Concurrent review',
          topic: '',
          agentKinds: ['codex', 'hermes'],
          workdir: '/tmp/meldwork-workspace',
          allowWrite: false,
          createdAt: '2026-07-29T09:00:00Z',
          updatedAt: '2026-07-29T09:00:00Z',
        },
      )
      desktopBridge.localWorkspace.send
        .mockImplementationOnce(() => directSend.promise)
        .mockImplementationOnce(() => groupSend.promise)
    })

    wrapper.vm.selectGroup('direct-concurrent')
    await flushPromises()
    await wrapper.get('.composer-box textarea').setValue('Continue the direct task')
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.send).toHaveBeenCalledTimes(1)
    expect(wrapper.get('.composer-box textarea').attributes()).toHaveProperty('disabled')

    wrapper.vm.selectGroup('group-concurrent')
    await flushPromises()
    expect(wrapper.get('.composer-box textarea').attributes()).not.toHaveProperty('disabled')
    await wrapper.get('.composer-box textarea').setValue('Start the group review')
    expect(wrapper.get('.send-button').attributes()).not.toHaveProperty('disabled')
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.send).toHaveBeenCalledTimes(2)
    expect(bridge.localWorkspace.send.mock.calls.map(([input]) => input.groupId))
      .toEqual(['direct-concurrent', 'group-concurrent'])
    expect(wrapper.get('.composer-box textarea').attributes()).toHaveProperty('disabled')

    wrapper.vm.selectGroup('direct-concurrent')
    await flushPromises()
    expect(wrapper.get('.composer-box textarea').attributes()).toHaveProperty('disabled')
    directSend.resolve()
    await flushPromises()
    expect(wrapper.get('.composer-box textarea').attributes()).not.toHaveProperty('disabled')

    wrapper.vm.selectGroup('group-concurrent')
    await flushPromises()
    expect(wrapper.get('.composer-box textarea').attributes()).toHaveProperty('disabled')
    groupSend.resolve()
    await flushPromises()
    expect(wrapper.get('.composer-box textarea').attributes()).not.toHaveProperty('disabled')
    wrapper.unmount()
  })

  it('labels multi-Agent manual replies in both locales', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-manual-labels',
        conversationType: 'group',
        name: 'Manual labels',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    await wrapper.get('.conversation-link').trigger('click')
    expect(wrapper.get('.mode-segmented [data-mode="manual"]').text()).toBe('Concurrent replies')
    const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    expect(styles).toMatch(/@container \(max-width: 420px\)[\s\S]*\.mode-segmented button\s*\{[^}]*white-space:\s*normal;/s)
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.composer-box\.unlimited-running \.round-unlimited-symbol,[\s\S]*animation:\s*none;/s)
    setLocale('zh')
    await flushPromises()
    expect(wrapper.get('.mode-segmented [data-mode="manual"]').text()).toBe('并发回复')

    await wrapper.get('.mode-segmented [data-mode="manual"]').trigger('click')
    await wrapper.findAll('.target-chip')[1].trigger('click')
    expect(wrapper.get('.mode-segmented [data-mode="manual"]').text()).toBe('单次回答')
    wrapper.unmount()
  })

  it.each([['codex'], ['codex', 'hermes']].map(agentKinds => ({ agentKinds })))('sends Auto discussion Beta as V4 with $agentKinds', async ({ agentKinds }) => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-auto-beta',
        conversationType: 'group',
        name: 'Beta group',
        topic: '',
        agentKinds,
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    await wrapper.get('.conversation-link').trigger('click')
    const betaButton = wrapper.get('.mode-segmented [data-mode="auto-beta"]')

    expect(betaButton.attributes()).not.toHaveProperty('disabled')
    expect(betaButton.text()).toContain('Auto discussion')
    expect(betaButton.get('.mode-beta-badge').text()).toBe('Beta')
    expect(betaButton.find('.mode-beta-icon').exists()).toBe(false)

    await betaButton.trigger('click')
    expect(betaButton.classes()).toContain('active')
    expect(wrapper.get('.composer-box textarea').attributes('placeholder'))
      .toBe('Beta: Agents deliver independently in parallel, then the first Agent reviews and invites peers to continue. The task ends when every Agent explicitly accepts the same version.')

    await wrapper.get('.composer-box textarea').setValue('Plan a launch')
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.send).toHaveBeenCalledWith({
      groupId: 'group-auto-beta',
      text: 'Plan a launch',
      targetKinds: agentKinds,
      skillHints: [],
      knowledgeBaseHints: [],
      attachments: [],
      mode: 'auto',
      discussionStyle: 'agent-led',
      protocol: 'v4',
      maxRounds: 6,
    })
    wrapper.unmount()
  })

  it('defaults an empty concurrent-response selection to every group Agent', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.agents.push({
        kind: 'qwen',
        installed: true,
        available: true,
        credentialState: 'ready',
        version: '1.0.0',
      })
      state.groups.push({
        id: 'group-concurrent-default-all',
        conversationType: 'group',
        name: 'Concurrent default all',
        topic: '',
        agentKinds: ['codex', 'hermes', 'qwen'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    await wrapper.get('.conversation-link').trigger('click')
    await wrapper.get('.mode-segmented [data-mode="manual"]').trigger('click')
    expect(wrapper.get('.composer-box textarea').element.value).not.toContain('@')
    expect(wrapper.findAll('.target-chip').map(chip => chip.classes().includes('selected')))
      .toEqual([true, true, true])

    await wrapper.get('.composer-box textarea').setValue('Ask the whole group')
    expect(wrapper.get('.send-button').attributes()).not.toHaveProperty('disabled')
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.send).toHaveBeenCalledWith({
      groupId: 'group-concurrent-default-all',
      text: 'Ask the whole group',
      targetKinds: ['codex', 'hermes', 'qwen'],
      skillHints: [],
      knowledgeBaseHints: [],
      attachments: [],
      mode: 'manual',
      protocol: 'v4',
      maxRounds: 6,
    })
    wrapper.unmount()
  })

  it('keeps automatic round settings isolated per group', async () => {
    const group = (id, name) => ({
      id,
      conversationType: 'group',
      name,
      topic: '',
      agentKinds: ['codex', 'hermes'],
      workdir: '/tmp/meldwork-workspace',
      allowWrite: false,
      createdAt: '2026-07-29T08:00:00Z',
      updatedAt: '2026-07-29T08:00:00Z',
    })
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push(group('group-round-a', 'Round A'), group('group-round-b', 'Round B'))
    })

    wrapper.vm.selectGroup('group-round-a')
    await flushPromises()
    await wrapper.get('.round-settings-trigger').trigger('click')
    await wrapper.get('.round-range-input').setValue(3)
    await wrapper.get('.round-unlimited-button').trigger('click')
    await wrapper.get('.confirmation-modal-footer .primary-button').trigger('click')
    await flushPromises()
    expect(wrapper.get('.round-settings-trigger').text()).toContain('No round limit')

    wrapper.vm.selectGroup('group-round-b')
    await flushPromises()
    expect(wrapper.get('.round-settings-trigger').text()).toContain('6 rounds')
    await wrapper.get('.round-settings-trigger').trigger('click')
    await wrapper.get('.round-range-input').setValue(9)
    await flushPromises()

    wrapper.vm.selectGroup('group-round-a')
    await flushPromises()
    expect(wrapper.get('.round-settings-trigger').text()).toContain('No round limit')
    wrapper.vm.selectGroup('group-round-b')
    await flushPromises()
    expect(wrapper.get('.round-settings-trigger').text()).toContain('9 rounds')
    wrapper.unmount()
  })

  it('cancels a stale unlimited confirmation when its originating group changes', async () => {
    const group = (id, name, updatedAt) => ({
      id,
      conversationType: 'group',
      name,
      topic: '',
      agentKinds: ['codex', 'hermes'],
      workdir: '/tmp/meldwork-workspace',
      allowWrite: false,
      createdAt: '2026-07-29T08:00:00Z',
      updatedAt,
    })
    const { wrapper, state, emitWorkspaceChanged } = await mountApp(({ state }) => {
      state.groups.push(
        group('group-unlimited-a', 'Unlimited A', '2026-07-29T09:00:00Z'),
        group('group-unlimited-b', 'Unlimited B', '2026-07-29T08:00:00Z'),
      )
    })

    wrapper.vm.selectGroup('group-unlimited-a')
    await flushPromises()
    await wrapper.get('.round-settings-trigger').trigger('click')
    await wrapper.get('.round-unlimited-button').trigger('click')
    expect(wrapper.find('.confirmation-modal-body').exists()).toBe(true)

    wrapper.vm.selectGroup('group-unlimited-b')
    await flushPromises()
    expect(wrapper.find('.confirmation-modal-body').exists()).toBe(false)

    wrapper.vm.confirmUnlimitedRounds()
    await flushPromises()
    expect(wrapper.get('.round-settings-trigger').text()).toContain('6 rounds')

    wrapper.vm.selectGroup('group-unlimited-a')
    await flushPromises()
    expect(wrapper.get('.round-settings-trigger').text()).toContain('6 rounds')

    await wrapper.get('.round-settings-trigger').trigger('click')
    await wrapper.get('.round-unlimited-button').trigger('click')
    state.groups = state.groups.filter(group => group.id !== 'group-unlimited-a')
    emitWorkspaceChanged()
    await flushPromises()
    expect(wrapper.find('.confirmation-modal-body').exists()).toBe(false)

    wrapper.vm.confirmUnlimitedRounds()
    wrapper.vm.selectGroup('group-unlimited-b')
    await flushPromises()
    expect(wrapper.get('.round-settings-trigger').text()).toContain('6 rounds')
    wrapper.unmount()
  })

  it('sends one mentioned Agent as a manual reply while the group defaults to automatic mode', async () => {
    const { wrapper, bridge } = await mountApp(({ state, bridge: desktopBridge }) => {
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
      desktopBridge.agentInstaller.skills.mockImplementation(async kind => ({
        skills: kind === 'codex'
          ? [
              { targetKind: 'codex', namespace: 'quality', slug: 'review', name: 'Review code' },
              { targetKind: 'hermes', namespace: 'quality', slug: 'research', name: 'Research' },
            ]
          : [{ targetKind: 'hermes', namespace: 'quality', slug: 'research', name: 'Research' }],
      }))
    })

    await wrapper.get('.conversation-link').trigger('click')
    const textarea = wrapper.get('.composer-box textarea')
    await textarea.setValue('@co')
    await flushPromises()

    expect(wrapper.findAll('.agent-mention-option')).toHaveLength(1)
    expect(wrapper.get('.agent-mention-option').text()).toContain('Codex')
    expect(wrapper.get('.agent-mention-option').text()).toContain('Structured reasoning')
    await wrapper.get('.agent-mention-option').trigger('click')
    expect(wrapper.get('.selected-agent-avatar').attributes('title')).toContain('Codex')
    expect(wrapper.get('.mode-segmented [data-mode="auto"]').classes()).toContain('active')
    expect(wrapper.get('.mode-segmented [data-mode="auto"]').attributes()).not.toHaveProperty('disabled')
    expect(wrapper.get('.send-button').text()).toBe('Send')

    expect(bridge.agentInstaller.skills.mock.calls).toEqual(expect.arrayContaining([['codex'], ['hermes']]))
    bridge.agentInstaller.skills.mockClear()
    await textarea.setValue('@rev')
    await flushPromises()

    expect(bridge.agentInstaller.skills).not.toHaveBeenCalled()
    expect(wrapper.findAll('.skill-option')).toHaveLength(1)
    expect(wrapper.get('.skill-option').text()).toContain('Review code')
    expect(wrapper.get('.skill-option').text()).not.toContain('Research')
    expect(textarea.attributes('role')).toBe('combobox')
    expect(textarea.attributes('aria-expanded')).toBe('true')
    expect(textarea.attributes('aria-controls')).toBe('composer-skill-menu')
    expect(textarea.attributes('aria-activedescendant')).toBe('composer-mention-option-0')

    await textarea.setValue('@review')
    await flushPromises()
    expect(bridge.agentInstaller.skills).not.toHaveBeenCalled()

    await textarea.trigger('keydown', { key: 'Enter' })
    expect(textarea.attributes('aria-expanded')).toBe('false')
    await textarea.setValue('Review this implementation')
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.send).toHaveBeenCalledWith({
      groupId: 'group-1',
      text: 'Review this implementation',
      targetKinds: ['codex'],
      mentionedAgentKinds: ['codex'],
      skillHints: [{ targetKind: 'codex', namespace: 'quality', slug: 'review', name: 'Review code' }],
      knowledgeBaseHints: [],
      attachments: [],
      mode: 'manual',
      maxRounds: 6,
    })
    expect(wrapper.find('.selected-agent-avatar').exists()).toBe(false)
    wrapper.unmount()
  })

  it('supports multiple Agent Tags and removes Skills with their Agent', async () => {
    const { wrapper } = await mountApp(({ state, bridge: desktopBridge }) => {
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
      desktopBridge.agentInstaller.skills.mockImplementation(async kind => ({
        skills: kind === 'hermes'
          ? [{ targetKind: 'hermes', namespace: 'research', slug: 'sources', name: 'Find sources' }]
          : [],
      }))
    })

    await wrapper.get('.conversation-link').trigger('click')
    await wrapper.get('.mode-segmented [data-mode="manual"]').trigger('click')
    const textarea = wrapper.get('.composer-box textarea')
    await textarea.setValue('@cod')
    await wrapper.get('.agent-mention-option').trigger('click')
    await textarea.setValue('@her')
    await flushPromises()
    await wrapper.get('.agent-mention-option').trigger('click')

    expect(wrapper.findAll('.selected-agent-avatar')).toHaveLength(2)
    expect(wrapper.findAll('.selected-agent-avatar img')).toHaveLength(2)
    expect(wrapper.findAll('.selected-agent-avatar').map(tag => tag.attributes('title')))
      .toEqual(['Remove Codex', 'Remove Hermes'])

    await textarea.setValue('@find')
    await flushPromises()
    expect(wrapper.findAll('.skill-option')).toHaveLength(1)
    expect(wrapper.get('.skill-option').text()).toContain('Find sources')
    await textarea.trigger('keydown', { key: 'Enter' })
    const selectedSkill = wrapper.get('.selected-skill')
    expect(selectedSkill.text()).toContain('Find sources')
    expect(selectedSkill.text()).not.toContain('@')
    expect(selectedSkill.element.closest('.composer-input-shell')).not.toBeNull()

    await wrapper.findAll('.selected-agent-avatar')[1].trigger('click')
    expect(wrapper.findAll('.selected-agent-avatar')).toHaveLength(1)
    expect(wrapper.find('.selected-skill').exists()).toBe(false)
    wrapper.unmount()
  })

  it('sends multiple Agent Tags without queueing unmentioned group members', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.agents.push({
        kind: 'qwen',
        installed: true,
        available: true,
        credentialState: 'ready',
        version: '1.0.0',
      })
      state.groups.push({
        id: 'group-1',
        conversationType: 'group',
        name: 'Review',
        topic: '',
        agentKinds: ['codex', 'hermes', 'qwen'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    await wrapper.get('.conversation-link').trigger('click')
    await wrapper.get('.mode-segmented [data-mode="manual"]').trigger('click')
    const textarea = wrapper.get('.composer-box textarea')
    await textarea.setValue('@cod')
    await wrapper.get('.agent-mention-option').trigger('click')
    await textarea.setValue('@her')
    await flushPromises()
    await wrapper.get('.agent-mention-option').trigger('click')
    await textarea.setValue('Compare your findings')
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.send).toHaveBeenCalledWith({
      groupId: 'group-1',
      text: 'Compare your findings',
      targetKinds: ['codex', 'hermes'],
      mentionedAgentKinds: ['codex', 'hermes'],
      skillHints: [],
      knowledgeBaseHints: [],
      attachments: [],
      mode: 'manual',
      protocol: 'v4',
      maxRounds: 6,
    })
    wrapper.unmount()
  })

  it('routes one named Agent as a manual reply while the group defaults to automatic mode', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.agents.push({
        kind: 'qwen',
        installed: true,
        available: true,
        credentialState: 'ready',
        version: '1.0.0',
      })
      state.groups.push({
        id: 'group-natural-routing',
        conversationType: 'group',
        name: 'Natural routing',
        topic: '',
        agentKinds: ['codex', 'hermes', 'qwen'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    await wrapper.get('.conversation-link').trigger('click')
    const textarea = wrapper.get('.composer-box textarea')
    const text = 'Codex，帮我检查这个方案'
    await textarea.setValue(text)
    await flushPromises()

    expect(wrapper.get('.mode-segmented [data-mode="auto"]').classes()).toContain('active')
    expect(wrapper.get('.send-button').text()).toBe('Send')
    expect(wrapper.findAll('.target-chip').map(chip => chip.classes().includes('selected')))
      .toEqual([true, false, false])
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.send).toHaveBeenCalledWith({
      groupId: 'group-natural-routing',
      text,
      targetKinds: ['codex'],
      mentionedAgentKinds: ['codex'],
      skillHints: [],
      knowledgeBaseHints: [],
      attachments: [],
      mode: 'manual',
      maxRounds: 6,
    })
    wrapper.unmount()
  })

  it('does not run an Agent explicitly excluded by a natural-language request', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.agents.push({
        kind: 'claude',
        installed: true,
        available: true,
        credentialState: 'ready',
        version: '1.0.0',
      })
      state.groups.push({
        id: 'group-negated-routing',
        conversationType: 'group',
        name: 'Negated routing',
        topic: '',
        agentKinds: ['codex', 'openclaw', 'claude'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    await wrapper.get('.conversation-link').trigger('click')
    const textarea = wrapper.get('.composer-box textarea')
    const text = 'OpenClaw 不要运行，让 Claude Code 回答'
    await textarea.setValue(text)
    await flushPromises()

    expect(wrapper.get('.send-button').text()).toBe('Send')
    expect(wrapper.findAll('.target-chip').map(chip => chip.classes().includes('selected')))
      .toEqual([false, false, true])
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.send).toHaveBeenCalledWith(expect.objectContaining({
      text,
      targetKinds: ['claude'],
      mentionedAgentKinds: ['claude'],
      mode: 'manual',
    }))
    wrapper.unmount()
  })

  it('keeps the exact OpenClaw and Claude request scoped through a live automatic run', async () => {
    const text = 'openclaw和claude code你们俩互相了解下对方'
    const { wrapper, bridge, emitRunEvent } = await mountApp(({ state, bridge: desktopBridge }) => {
      for (const kind of ['openclaw', 'claude']) {
        state.agents.push({
          kind,
          installed: true,
          available: true,
          credentialState: 'ready',
          version: '1.0.0',
        })
      }
      state.groups.push({
        id: 'group-exact-routing',
        conversationType: 'group',
        name: 'Exact routing',
        topic: '',
        agentKinds: ['codex', 'openclaw', 'claude', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      desktopBridge.localWorkspace.send.mockImplementation(async () => {
        state.messages.push({
          id: 'root-exact-routing',
          groupId: 'group-exact-routing',
          role: 'user',
          content: text,
          targetKinds: ['openclaw', 'claude'],
          mentionedAgentKinds: ['openclaw', 'claude'],
          createdAt: '2026-07-29T08:01:00Z',
        })
        state.runningGroupIds = ['group-exact-routing']
        state.runs = [{
          runId: 'run-exact-routing',
          groupId: 'group-exact-routing',
          threadRootId: 'root-exact-routing',
          phase: 'running',
          mode: 'auto',
          targetKinds: ['codex', 'openclaw', 'claude', 'hermes'],
          completedKinds: ['codex', 'claude'],
          failedKinds: ['codex'],
          currentKind: 'openclaw',
          currentRound: 2,
          maxRounds: 6,
          progress: [],
          agentRuns: [
            {
              agentRunId: 'agent-run-codex-stray',
              kind: 'codex',
              round: 2,
              status: 'running',
              output: 'Stray Codex output',
              events: [{
                runId: 'run-exact-routing',
                agentRunId: 'agent-run-codex-stray',
                groupId: 'group-exact-routing',
                threadRootId: 'root-exact-routing',
                agentKind: 'codex',
                round: 2,
                seq: 1,
                type: 'warning',
                status: 'running',
                title: 'Stray Codex event',
              }],
            },
            {
              agentRunId: 'agent-run-openclaw-round-1',
              kind: 'openclaw',
              round: 1,
              status: 'completed',
              output: 'OpenClaw round one',
              events: [],
            },
            {
              agentRunId: 'agent-run-claude-round-1',
              kind: 'claude',
              round: 1,
              status: 'completed',
              output: 'Claude round one',
              events: [],
            },
            {
              agentRunId: 'agent-run-openclaw-round-2',
              kind: 'openclaw',
              round: 2,
              status: 'running',
              output: '',
              events: [],
            },
          ],
        }]
      })
    })

    await wrapper.get('.conversation-link').trigger('click')
    const textarea = wrapper.get('.composer-box textarea')
    await textarea.setValue(text)
    await flushPromises()

    expect(wrapper.get('.mode-segmented [data-mode="auto"]').classes()).toContain('active')
    expect(wrapper.get('.send-button').text()).toBe('Start discussion')
    expect(wrapper.findAll('.target-chip').map(chip => chip.classes().includes('selected')))
      .toEqual([false, true, true, false])

    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.send).toHaveBeenCalledWith({
      groupId: 'group-exact-routing',
      text,
      targetKinds: ['openclaw', 'claude'],
      mentionedAgentKinds: ['openclaw', 'claude'],
      skillHints: [],
      knowledgeBaseHints: [],
      attachments: [],
      mode: 'auto',
      protocol: 'v4',
      maxRounds: 6,
    })
    expect(wrapper.findAll('.run-status-panel .run-agent-row').map(row => row.get('strong').text()))
      .toEqual(['OpenClaw', 'Claude Code'])
    expect(wrapper.get('.run-status-panel').text()).not.toContain('Codex')
    expect(wrapper.findAll('.message-row.agent[data-agent-kind="codex"]')).toHaveLength(0)

    emitRunEvent({
      runId: 'run-exact-routing',
      agentRunId: 'agent-run-codex-live',
      groupId: 'group-exact-routing',
      threadRootId: 'root-exact-routing',
      agentKind: 'codex',
      round: 2,
      seq: 99,
      type: 'warning',
      status: 'running',
      title: 'Late stray Codex event',
    })
    await flushPromises()

    expect(wrapper.findAll('.run-status-panel .run-agent-row').map(row => row.get('strong').text()))
      .toEqual(['OpenClaw', 'Claude Code'])
    expect(wrapper.get('.run-status-panel').text()).not.toContain('Codex')
    expect(wrapper.findAll('.message-row.agent[data-agent-kind="codex"]')).toHaveLength(0)
    wrapper.unmount()
  })

  it('unions Agent Tags and named members in automatic mode without queueing the rest', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
      for (const kind of ['qwen', 'kimi', 'workbuddy']) {
        state.agents.push({
          kind,
          installed: true,
          available: true,
          credentialState: 'ready',
          version: '1.0.0',
        })
      }
      state.groups.push({
        id: 'group-auto-routing',
        conversationType: 'group',
        name: 'Automatic routing',
        topic: '',
        agentKinds: ['codex', 'hermes', 'qwen', 'kimi', 'workbuddy'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    await wrapper.get('.conversation-link').trigger('click')
    const textarea = wrapper.get('.composer-box textarea')
    await textarea.setValue('@cod')
    await flushPromises()
    await wrapper.get('.agent-mention-option').trigger('click')
    await textarea.setValue('Hermes、Qwen Code，一起检查 Harness')
    await flushPromises()

    expect(wrapper.get('.mode-segmented [data-mode="auto"]').classes()).toContain('active')
    expect(wrapper.get('.mode-segmented [data-mode="auto"]').attributes()).not.toHaveProperty('disabled')
    expect(wrapper.findAll('.target-chip').map(chip => chip.classes().includes('selected')))
      .toEqual([true, true, true, false, false])

    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.send).toHaveBeenCalledWith({
      groupId: 'group-auto-routing',
      text: 'Hermes、Qwen Code，一起检查 Harness',
      targetKinds: ['codex', 'hermes', 'qwen'],
      mentionedAgentKinds: ['codex', 'hermes', 'qwen'],
      skillHints: [],
      knowledgeBaseHints: [],
      attachments: [],
      mode: 'auto',
      protocol: 'v4',
      maxRounds: 6,
    })
    wrapper.unmount()
  })

  it('mentions a ready knowledge base for multiple selected Agents and sends its scoped access', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-knowledge',
        conversationType: 'group',
        name: 'Knowledge review',
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
    const textarea = wrapper.get('.composer-box textarea')
    await textarea.setValue('@cod')
    await wrapper.get('.agent-mention-option').trigger('click')
    await textarea.setValue('@her')
    await flushPromises()
    await wrapper.get('.agent-mention-option').trigger('click')

    await textarea.setValue('@ding')
    await flushPromises()
    const option = wrapper.get('.knowledge-base-mention-option')
    expect(option.get('img').attributes('src')).toBe('./knowledge-base-logos/dingtalk.svg')
    expect(option.text()).toContain('Search DingTalk documents through the configured dws connection')
    expect(option.text()).toContain('Knowledge')
    await option.trigger('click')
    expect(wrapper.get('.selected-knowledge-base-avatar').attributes('title')).toBe('Remove knowledge base')
    expect(wrapper.get('.selected-knowledge-base-avatar img').attributes('src'))
      .toBe('./knowledge-base-logos/dingtalk.svg')

    await textarea.setValue('Compare the internal references')
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.send).toHaveBeenCalledWith({
      groupId: 'group-knowledge',
      text: 'Compare the internal references',
      targetKinds: ['codex', 'hermes'],
      mentionedAgentKinds: ['codex', 'hermes'],
      skillHints: [],
      knowledgeBaseHints: [{ kind: 'dingtalk', targetKinds: ['codex', 'hermes'] }],
      attachments: [],
      mode: 'manual',
      protocol: 'v4',
      maxRounds: 6,
    })
    expect(wrapper.find('.selected-knowledge-base-avatar').exists()).toBe(false)
    wrapper.unmount()
  })

  it('mentions a knowledge base to every group Agent when no Agent is specified', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-knowledge-all',
        conversationType: 'group',
        name: 'Knowledge review',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    await wrapper.get('.conversation-link').trigger('click')
    const textarea = wrapper.get('.composer-box textarea')
    await textarea.setValue('@ding')
    await flushPromises()
    expect(wrapper.get('.knowledge-base-mention-option').text()).toContain('DingTalk Docs')
    await wrapper.get('.knowledge-base-mention-option').trigger('click')
    await textarea.setValue('Compare the internal references')
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.send).toHaveBeenCalledWith({
      groupId: 'group-knowledge-all',
      text: 'Compare the internal references',
      targetKinds: ['codex', 'hermes'],
      skillHints: [],
      knowledgeBaseHints: [{ kind: 'dingtalk', targetKinds: ['codex', 'hermes'] }],
      attachments: [],
      mode: 'auto',
      protocol: 'v4',
      maxRounds: 6,
    })
    wrapper.unmount()
  })

  it('lists knowledge bases before skills in grouped and direct @ menus', async () => {
    const scrollIntoView = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrollIntoView
    const { wrapper } = await mountApp(({ state, bridge: desktopBridge }) => {
      state.groups.push({
        id: 'group-menu-order',
        conversationType: 'group',
        name: 'Knowledge review',
        topic: '',
        agentKinds: ['codex'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.groups.push({
        id: 'direct-menu-order',
        conversationType: 'direct',
        directAgentKind: 'codex',
        name: 'Codex direct',
        topic: '',
        agentKinds: ['codex'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      desktopBridge.agentInstaller.skills.mockResolvedValue({
        skills: [{ targetKind: 'codex', namespace: 'research', slug: 'deep-research', name: 'Deep research' }],
      })
    })

    await wrapper.get('.conversation-link').trigger('click')
    const textarea = wrapper.get('.composer-box textarea')
    await textarea.setValue('@cod')
    await wrapper.get('.agent-mention-option').trigger('click')
    await textarea.setValue('@')
    await flushPromises()

    const sections = wrapper.findAll('.mention-menu-section')
    expect(sections.map(section => section.get('.mention-menu-section-label').text()))
      .toEqual(['Knowledge bases', 'Skills'])
    expect(sections[0].text()).toContain('DingTalk Docs')
    expect(sections[1].text()).toContain('Deep research')
    expect(wrapper.findAll('.skill-option').map(option => option.attributes('id')))
      .toEqual(['composer-mention-option-0', 'composer-mention-option-1'])
    scrollIntoView.mockClear()
    await textarea.trigger('keydown', { key: 'ArrowDown' })
    await flushPromises()
    expect(textarea.attributes('aria-activedescendant')).toBe('composer-mention-option-1')
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })

    wrapper.vm.selectGroup('direct-menu-order')
    await flushPromises()
    await textarea.setValue('@')
    await flushPromises()
    expect(wrapper.findAll('.mention-menu-section').map(section => (
      section.get('.mention-menu-section-label').text()
    ))).toEqual(['Knowledge bases', 'Skills'])
    wrapper.unmount()
  })

  it('restores Agent Tags and Skills when a targeted send fails', async () => {
    const { wrapper } = await mountApp(({ state, bridge: desktopBridge }) => {
      state.groups.push({
        id: 'group-1',
        conversationType: 'group',
        name: 'Research',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      desktopBridge.agentInstaller.skills.mockResolvedValue({
        skills: [{ targetKind: 'hermes', namespace: 'research', slug: 'sources', name: 'Find sources' }],
      })
      desktopBridge.localWorkspace.send.mockRejectedValueOnce(new Error('LOCAL_AGENT_EXECUTION_FAILED'))
    })

    await wrapper.get('.conversation-link').trigger('click')
    await wrapper.get('.mode-segmented [data-mode="manual"]').trigger('click')
    const textarea = wrapper.get('.composer-box textarea')
    await textarea.setValue('@her')
    await wrapper.get('.agent-mention-option').trigger('click')
    await textarea.setValue('@find')
    await flushPromises()
    await textarea.trigger('keydown', { key: 'Enter' })
    await textarea.setValue('Research this market')
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(textarea.element.value).toBe('Research this market')
    expect(wrapper.get('.selected-agent-avatar').attributes('title')).toContain('Hermes')
    expect(wrapper.get('.selected-skill').text()).toContain('Find sources')
    wrapper.unmount()
  })

  it('keeps direct chats on their Agent Skills without Agent Tags', async () => {
    const { wrapper, bridge } = await mountApp(({ state, bridge: desktopBridge }) => {
      state.groups.push({
        id: 'direct-codex',
        conversationType: 'direct',
        directAgentKind: 'codex',
        name: 'Codex',
        agentKinds: ['codex'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      desktopBridge.agentInstaller.skills.mockImplementation(async kind => ({
        skills: kind === 'codex'
          ? [{ targetKind: 'codex', namespace: 'quality', slug: 'review', name: 'Review code' }]
          : [],
      }))
    })

    await wrapper.get('.direct-session-open').trigger('click')
    bridge.agentInstaller.skills.mockClear()
    const textarea = wrapper.get('.composer-box textarea')
    await textarea.setValue('@review')
    await flushPromises()

    expect(bridge.agentInstaller.skills).not.toHaveBeenCalled()
    expect(wrapper.find('.agent-mention-option').exists()).toBe(false)
    expect(wrapper.get('.skill-option').text()).toContain('Review code')
    await textarea.trigger('keydown', { key: 'Enter' })
    await textarea.setValue('Review this implementation')
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.send).toHaveBeenCalledWith({
      groupId: 'direct-codex',
      text: 'Review this implementation',
      targetKinds: ['codex'],
      skillHints: [{ targetKind: 'codex', namespace: 'quality', slug: 'review', name: 'Review code' }],
      knowledgeBaseHints: [],
      attachments: [],
      mode: 'manual',
      maxRounds: 6,
    })
    expect(wrapper.find('.selected-agent-avatar').exists()).toBe(false)
    wrapper.unmount()
  })
})

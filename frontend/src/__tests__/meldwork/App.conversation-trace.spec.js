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
const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
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
  if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight)
  else delete HTMLElement.prototype.scrollHeight
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard })
  if (originalExecCommand) Object.defineProperty(document, 'execCommand', { configurable: true, value: originalExecCommand })
  else delete document.execCommand
  vi.restoreAllMocks()
})

describe('Meldwork workbench', () => {
  it.each(['completed', 'partial'])('shows persisted %s task status despite a historical stop', async (status) => {
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push({ id: 'group-outcome', conversationType: 'group', name: 'Recovered task',
        agentKinds: ['codex'], workdir: '', allowWrite: false })
      state.messages.push(
        { id: 'root-outcome', groupId: 'group-outcome', role: 'user', content: 'Finish task', targetKinds: ['codex'] },
        { id: 'reply-outcome', groupId: 'group-outcome', role: 'agent', agentKind: 'codex',
          threadRootId: 'root-outcome', content: 'Agent finished its turn.',
          trace: { runId: 'run-outcome', agentRunId: 'attempt-outcome', status: 'completed', round: 1 } },
        { id: 'stop-outcome', groupId: 'group-outcome', role: 'system', threadRootId: 'root-outcome',
          content: 'Previous persistence failure', system: { key: 'system.autoStopped', params: { reason: 'LOCAL_RUN_PERSIST_FAILED' } } },
      )
      state.runOutcomes = [{ groupId: 'group-outcome', runId: 'run-outcome', threadRootId: 'root-outcome',
        targetKinds: ['codex'], status, startedAt: 10, finishedAt: 20 }]
    })
    await wrapper.get('.conversation-link').trigger('click')
    await flushPromises()
    const panel = wrapper.get('.run-status-panel.history')
    expect(panel.text()).toContain(status === 'completed' ? '· Completed' : '· Partially completed')
    expect(panel.find('.solo-run-status').exists()).toBe(false)
    expect(wrapper.get('.turn-rail button').attributes('data-status')).toBe(status)
    expect(wrapper.text()).toContain('Meldwork could not save this run')
    setLocale('zh')
    await flushPromises()
    expect(panel.text()).toContain(status === 'completed' ? '已完成' : '部分完成')
    wrapper.unmount()
  })
  it.each(['autoTaskDecisionMissing', 'autoTaskBlocked', 'autoTaskNeedsHuman'])('does not infer task success from completed calls after %s', async (key) => {
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-task-judgment', conversationType: 'group', name: 'Task judgment',
        agentKinds: ['codex'], workdir: '', allowWrite: false,
      })
      state.messages.push(
        { id: 'root-judgment', groupId: 'group-task-judgment', role: 'user', content: 'Complete the task.', targetKinds: ['codex'], createdAt: '2026-09-09T08:00:00Z' },
        {
          id: 'reply-judgment', groupId: 'group-task-judgment', role: 'agent', agentKind: 'codex',
          threadRootId: 'root-judgment', content: 'Input is missing.', createdAt: '2026-09-09T08:01:00Z',
          trace: { runId: 'run-judgment', agentRunId: 'attempt-judgment', status: 'completed', events: [], sourceMessageIds: ['root-judgment'] },
        },
        {
          id: 'notice-judgment', groupId: 'group-task-judgment', role: 'system', threadRootId: 'root-judgment',
          content: 'Input is missing.', system: { key: `system.${key}`, params: { reason: 'Input is missing.' } }, createdAt: '2026-09-09T08:02:00Z',
        },
      )
    })
    await wrapper.get('.conversation-link').trigger('click')
    await flushPromises()
    expect(wrapper.find('.run-status-panel.history').exists()).toBe(false)
    expect(wrapper.find('#message-notice-judgment').exists()).toBe(true)
    wrapper.unmount()
  })

  it('keeps each group topic reply block attached to its query', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-topic-order',
        conversationType: 'group',
        name: 'Topic ordering',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.messages.push(
        {
          id: 'topic-root-1',
          groupId: 'group-topic-order',
          role: 'user',
          content: 'First query',
          createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'topic-root-2',
          groupId: 'group-topic-order',
          role: 'user',
          content: 'Second query',
          createdAt: '2026-07-29T08:02:00Z',
        },
        {
          id: 'topic-reply-1',
          groupId: 'group-topic-order',
          role: 'agent',
          agentKind: 'codex',
          content: 'Reply to the first query',
          threadRootId: 'topic-root-1',
          trace: { round: 1, phase: 'proposal' },
          createdAt: '2026-07-29T08:03:00Z',
        },
        {
          id: 'topic-reply-2',
          groupId: 'group-topic-order',
          role: 'agent',
          agentKind: 'hermes',
          content: 'Reply to the second query',
          threadRootId: 'topic-root-2',
          trace: { round: 1, phase: 'proposal' },
          createdAt: '2026-07-29T08:04:00Z',
        },
      )
    })

    await wrapper.get('.conversation-link').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('.message-list .message-row').map(row => row.attributes('id')))
      .toEqual([
        'message-topic-root-1',
        'message-topic-reply-1',
        'message-topic-root-2',
        'message-topic-reply-2',
      ])
    expect(wrapper.get('#message-topic-reply-1').classes()).toContain('topic-reply')
    expect(wrapper.get('#message-topic-reply-2').classes()).toContain('topic-reply')
    wrapper.unmount()
  })

  it('keeps live Round 2 Agent replies after Round 1 in dispatch turn order', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-live-round-order',
        conversationType: 'group',
        name: 'Live round ordering',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:05:00Z',
      })
      state.messages.push(
        {
          id: 'live-round-root',
          groupId: 'group-live-round-order',
          role: 'user',
          content: 'Review this in sequence',
          createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'codex-round-1',
          groupId: 'group-live-round-order',
          role: 'agent',
          agentKind: 'codex',
          content: 'Codex proposal',
          threadRootId: 'live-round-root',
          turnSeq: 1,
          trace: {
            runId: 'run-live-round-order',
            agentRunId: 'codex-round-1',
            round: 1,
            phase: 'proposal',
            status: 'completed',
            events: [],
          },
          createdAt: '2026-07-29T08:02:00Z',
        },
        {
          id: 'hermes-round-1',
          groupId: 'group-live-round-order',
          role: 'agent',
          agentKind: 'hermes',
          content: 'Hermes proposal',
          threadRootId: 'live-round-root',
          turnSeq: 2,
          trace: {
            runId: 'run-live-round-order',
            agentRunId: 'hermes-round-1',
            round: 1,
            phase: 'proposal',
            status: 'completed',
            events: [],
          },
          createdAt: '2026-07-29T08:03:00Z',
        },
      )
      state.runningGroupIds = ['group-live-round-order']
      state.runs = [{
        runId: 'run-live-round-order',
        groupId: 'group-live-round-order',
        threadRootId: 'live-round-root',
        targetKinds: ['codex', 'hermes'],
        currentRound: 2,
        orchestration: { phase: 'challenge' },
        agentRuns: [
          {
            agentRunId: 'codex-round-2',
            kind: 'codex',
            round: 2,
            turnSeq: 3,
            status: 'completed',
            output: 'Codex challenge',
            events: [],
            // Production live runs carry numeric timestamps; the order must
            // come from the dispatch turn, not from these (reversed) times.
            startedAt: Date.parse('2026-07-29T07:59:00Z'),
          },
          {
            agentRunId: 'hermes-round-2',
            kind: 'hermes',
            round: 2,
            turnSeq: 4,
            status: 'running',
            output: 'Hermes challenge',
            events: [],
            startedAt: Date.parse('2026-07-29T07:58:00Z'),
          },
        ],
      }]
    })

    await wrapper.get('.conversation-link').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('.message-list .message-row').map(row => row.attributes('id')))
      .toEqual([
        'message-live-round-root',
        'message-codex-round-1',
        'message-hermes-round-1',
        'message-run-message-codex-round-2',
        'message-run-message-hermes-round-2',
      ])
    wrapper.unmount()
  })

  it('maps direct tasks onto the turn rail without group reply styling', async () => {
    const scrollIntoView = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrollIntoView
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'direct-codex',
        conversationType: 'direct',
        directAgentKind: 'codex',
        name: 'Codex review',
        topic: '',
        agentKinds: ['codex'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.messages.push(
        {
          id: 'root-1',
          groupId: 'direct-codex',
          role: 'user',
          content: 'First direct task',
          createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'agent-1',
          groupId: 'direct-codex',
          role: 'agent',
          agentKind: 'codex',
          content: 'First answer',
          createdAt: '2026-07-29T08:02:00Z',
        },
        {
          id: 'root-2',
          groupId: 'direct-codex',
          role: 'user',
          content: 'Latest direct task',
          createdAt: '2026-07-29T08:03:00Z',
        },
        {
          id: 'agent-2',
          groupId: 'direct-codex',
          role: 'agent',
          agentKind: 'codex',
          content: 'Latest answer',
          createdAt: '2026-07-29T08:04:00Z',
        },
      )
      state.runningGroupIds = ['direct-codex']
      state.runs = [{
        runId: 'run-direct-turns',
        groupId: 'direct-codex',
        mode: 'manual',
        targetKinds: ['codex'],
        completedKinds: [],
        currentKind: 'codex',
        progress: [],
      }]
    })

    await wrapper.get('.direct-session-open').trigger('click')
    await flushPromises()

    const railButtons = wrapper.findAll('.turn-rail button')
    expect(railButtons).toHaveLength(2)
    expect(railButtons[0].attributes('aria-label')).toContain('First direct task')
    expect(railButtons[0].attributes('aria-label')).not.toContain('reply')
    expect(railButtons[0].attributes('aria-label')).toContain('Completed')
    expect(railButtons[0].get('.turn-rail-tooltip').text()).toBe(railButtons[0].attributes('aria-label'))
    expect(railButtons[1].attributes('data-status')).toBe('running')
    expect(railButtons[1].attributes('aria-current')).toBe('true')
    expect(wrapper.get('#message-agent-1').classes()).toContain('direct-message')
    expect(wrapper.get('#message-agent-1').classes()).not.toContain('topic-reply')
    expect(wrapper.find('.topic-toggle').exists()).toBe(false)
    expect(wrapper.findAll('.active-topic-label').every(label => label.text() === 'Current task')).toBe(true)
    expect(wrapper.get('.conversation-title-button').attributes()).not.toHaveProperty('disabled')
    expect(wrapper.find('.run-round-progress').exists()).toBe(false)
    expect(wrapper.get('.run-status-panel.direct.solo').text()).toContain('Codex is working in this chat')
    expect(wrapper.get('.run-status-panel .run-agent-logo').attributes('data-status')).toBe('running')
    expect(wrapper.find('.relay-run-indicator').exists()).toBe(false)
    expect(wrapper.find('.run-agent-list').exists()).toBe(false)

    scrollIntoView.mockClear()
    await railButtons[0].trigger('click')
    await flushPromises()

    expect(wrapper.get('#message-agent-1').text()).toContain('First answer')
    expect(scrollIntoView).toHaveBeenCalled()
    await wrapper.get('.stop-button').trigger('click')
    expect(bridge.localWorkspace.stop).toHaveBeenCalledWith('direct-codex', 'run-direct-turns')
    wrapper.unmount()
  })

  it('reuses the solo presentation and reflects each run state when a group message targets one Agent', async () => {
    const { wrapper, state, emitWorkspaceChanged } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-1',
        conversationType: 'group',
        name: 'Focused review',
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
        content: 'Codex only',
        targetKinds: ['codex'],
        createdAt: '2026-07-29T08:01:00Z',
      })
      state.runningGroupIds = ['group-1']
      state.runs = [{
        runId: 'run-focused-review',
        groupId: 'group-1',
        phase: 'preparing',
        mode: 'manual',
        targetKinds: ['codex'],
        completedKinds: [],
        failedKinds: [],
        currentKind: '',
        threadRootId: 'root-1',
        progress: [],
      }]
    })

    await wrapper.get('.conversation-link').trigger('click')
    await flushPromises()

    const panel = wrapper.get('.run-status-panel.group.solo')
    expect(panel.classes()).not.toContain('multi')
    expect(panel.text()).toContain('Codex')
    expect(panel.get('.direct-run-indicator').exists()).toBe(true)
    expect(panel.get('.run-agent-logo').attributes('data-status')).toBe('queued')
    expect(panel.get('.solo-run-status').text()).toBe('Queued')
    expect(panel.text()).not.toContain('Codex is working in this chat')
    expect(panel.find('.typing-bars').exists()).toBe(false)
    expect(wrapper.find('.relay-run-indicator').exists()).toBe(false)
    expect(wrapper.find('.run-agent-list').exists()).toBe(false)
    expect(wrapper.findAll('.run-agent-row')).toHaveLength(0)

    state.runs[0].phase = 'running'
    state.runs[0].currentKind = 'codex'
    state.runs[0].progress = [{ title: 'process', status: 'running' }]
    emitWorkspaceChanged()
    await flushPromises()
    expect(panel.get('.run-agent-logo').attributes('data-status')).toBe('running')
    expect(panel.get('.solo-run-status').text()).toBe('Running')
    expect(panel.text()).toContain('Codex is working in this chat')
    expect(panel.get('.typing-bars').exists()).toBe(true)
    expect(panel.get('.run-progress-details').text()).toContain('Run process')

    state.runs[0].currentKind = ''
    state.runs[0].completedKinds = ['codex']
    emitWorkspaceChanged()
    await flushPromises()
    expect(panel.get('.run-agent-logo').attributes('data-status')).toBe('completed')
    expect(panel.get('.solo-run-status').text()).toBe('Completed')
    expect(panel.text()).not.toContain('Codex is working in this chat')
    expect(panel.find('.typing-bars').exists()).toBe(false)

    state.runs[0].agentRuns = [{
      agentRunId: 'focused-codex-round-2',
      kind: 'codex',
      round: 2,
      status: 'partial',
      events: [],
    }]
    emitWorkspaceChanged()
    await flushPromises()
    expect(panel.get('.run-agent-logo').attributes('data-status')).toBe('partial')
    expect(panel.get('.solo-run-status').text()).toBe('Partially completed')

    state.runs[0].agentRuns[0].status = 'stopped'
    emitWorkspaceChanged()
    await flushPromises()
    expect(panel.get('.run-agent-logo').attributes('data-status')).toBe('partial')
    expect(panel.get('.solo-run-status').text()).toBe('Stopped')

    state.runs[0].agentRuns[0].status = 'timeout'
    emitWorkspaceChanged()
    await flushPromises()
    expect(panel.get('.run-agent-logo').attributes('data-status')).toBe('failed')
    expect(panel.get('.solo-run-status').text()).toBe('Timed out')

    state.runs[0].agentRuns = []
    state.runs[0].failedKinds = ['codex']
    emitWorkspaceChanged()
    await flushPromises()
    expect(panel.get('.run-agent-logo').attributes('data-status')).toBe('failed')
    expect(panel.get('.solo-run-status').text()).toBe('Failed')
    expect(panel.text()).not.toContain('Codex is working in this chat')
    expect(panel.find('.typing-bars').exists()).toBe(false)
    wrapper.unmount()
  })

  it('uses a static terminal indicator for partial, stopped, and interrupted Agent rows', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.agents.push({
        kind: 'claude',
        installed: true,
        available: true,
        credentialState: 'ready',
        version: '1.0.0',
      })
      state.groups.push({
        id: 'group-terminal-agent-rows',
        conversationType: 'group',
        name: 'Terminal Agent rows',
        topic: '',
        agentKinds: ['codex', 'hermes', 'claude'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.runningGroupIds = ['group-terminal-agent-rows']
      state.runs = [{
        runId: 'run-terminal-agent-rows',
        groupId: 'group-terminal-agent-rows',
        mode: 'auto',
        targetKinds: ['codex', 'hermes', 'claude', 'qwen', 'pi'],
        currentKind: '',
        agentRuns: [{
          agentRunId: 'agent-terminal-codex',
          kind: 'codex',
          round: 1,
          status: 'partial',
          events: [],
        }, {
          agentRunId: 'agent-terminal-hermes',
          kind: 'hermes',
          round: 1,
          status: 'interrupted',
          events: [],
        }, {
          agentRunId: 'agent-terminal-claude',
          kind: 'claude',
          round: 1,
          status: 'stopped',
          events: [],
        }, {
          agentRunId: 'agent-terminal-qwen',
          kind: 'qwen',
          round: 1,
          status: 'partial',
          events: [],
        }, {
          agentRunId: 'agent-terminal-pi',
          kind: 'pi',
          round: 1,
          status: 'stopped',
          events: [],
        }],
      }]
    })

    await wrapper.get('.conversation-link').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('.relay-run-indicator .run-agent-logo')).toHaveLength(5)
    const rows = wrapper.findAll('.run-agent-row')
    expect(rows).toHaveLength(5)
    expect(rows.every(row => row.get('strong').classes('visually-hidden'))).toBe(true)
    expect(rows.every(row => row.get('.run-agent-state small').classes('visually-hidden'))).toBe(true)
    expect(rows.map(row => row.get('.run-agent-state small').text()))
      .toEqual(['Partially completed', 'Interrupted', 'Stopped', 'Partially completed', 'Stopped'])
    for (const row of rows) {
      expect(row.get('.run-agent-motion').attributes('data-status')).toBe('partial')
      expect(row.find('.run-agent-motion svg').exists()).toBe(true)
      expect(row.find('.run-agent-dots').exists()).toBe(false)
      expect(row.find('.run-agent-bars').exists()).toBe(false)
    }
    const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    expect(styles).toMatch(/\.run-agent-motion\[data-status="partial"\] svg\s*\{[^}]*animation:\s*none;/s)
    wrapper.unmount()
  })

  it('copies message content while ignoring links and active text selections', async () => {
    const { wrapper } = await mountApp(({ state }) => {
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
          content: 'Review the selected text',
          createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'reply-1',
          groupId: 'group-1',
          role: 'agent',
          agentKind: 'codex',
          content: '[Open docs](https://example.com)\n\nCopy this answer.',
          threadRootId: 'root-1',
          createdAt: '2026-07-29T08:02:00Z',
        },
      )
    })
    const getSelection = vi.spyOn(window, 'getSelection')
    const writeText = navigator.clipboard.writeText

    await wrapper.get('.conversation-link').trigger('click')
    getSelection.mockReturnValue({ toString: () => 'selected text' })
    await wrapper.get('.message-row.user .message-copy-surface').trigger('click')
    expect(writeText).not.toHaveBeenCalled()

    getSelection.mockReturnValue({ toString: () => '' })
    const link = wrapper.get('.message-row.agent a')
    link.element.addEventListener('click', event => event.preventDefault(), { once: true })
    await link.trigger('click')
    expect(writeText).not.toHaveBeenCalled()

    await wrapper.get('.message-row.agent .message-copy-surface').trigger('click')
    await flushPromises()
    expect(writeText).not.toHaveBeenCalled()

    expect(wrapper.find('.message-row.agent .message-footer-actions .message-copy-button').exists()).toBe(false)
    await wrapper.get('.message-row.agent .message-meta-actions .message-copy-button').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('[Open docs](https://example.com)\n\nCopy this answer.')
    expect(wrapper.get('.message-row.agent').classes()).toContain('copied')
    expect(wrapper.get('.message-row.agent .message-meta-actions .message-copy-button').attributes('aria-label')).toBe('Copied')
    expect(wrapper.get('.copy-toast-message').text()).toBe('Copied to clipboard')

    writeText.mockClear()
    await wrapper.get('.message-row.user .message-copy-button').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('Review the selected text')

    const execCommand = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })
    writeText.mockRejectedValueOnce(new Error('Clipboard permission denied'))
    await wrapper.get('.message-row.agent .message-meta-actions .message-copy-button').trigger('click')
    await flushPromises()
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(wrapper.find('.toast-message').exists()).toBe(false)
    wrapper.unmount()
  })

  it('collapses oversized user queries and restores them on demand', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return this.classList.contains('user-message-content') && this.textContent.length > 100
          ? 480
          : 0
      },
    })
    const { wrapper } = await mountApp(({ state }) => {
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
      state.messages.push({
        id: 'long-user-query',
        groupId: 'direct-codex',
        role: 'user',
        content: 'A'.repeat(240),
        createdAt: '2026-07-29T08:01:00Z',
      })
    })

    await wrapper.get('.direct-session-open').trigger('click')
    await flushPromises()
    const content = wrapper.get('.user-message-content')
    const toggle = wrapper.get('.user-message-expand-button')
    expect(content.classes()).toContain('collapsed')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(toggle.text()).toBe('Show more')

    await toggle.trigger('click')

    expect(content.classes()).not.toContain('collapsed')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(toggle.text()).toBe('Show less')
    wrapper.unmount()
  })

  it('requires confirmation before persistently deleting replies and whole topics', async () => {
    const { wrapper, state, bridge } = await mountApp(({ state: nextState, bridge: nextBridge }) => {
      nextState.groups.push({
        id: 'group-1',
        conversationType: 'group',
        name: 'Cleanup review',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      nextState.messages.push(
        {
          id: 'keep-root',
          groupId: 'group-1',
          role: 'user',
          content: 'Keep this topic',
          createdAt: '2026-07-29T08:00:30Z',
        },
        {
          id: 'root-1',
          groupId: 'group-1',
          role: 'user',
          content: 'Delete this topic',
          targetKinds: ['codex', 'hermes'],
          createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'reply-1',
          groupId: 'group-1',
          role: 'agent',
          agentKind: 'codex',
          content: 'Delete with the topic',
          threadRootId: 'root-1',
          createdAt: '2026-07-29T08:02:00Z',
          trace: {
            runId: 'run-delete',
            agentRunId: 'agent-run-delete',
            status: 'completed',
            sourceMessageIds: ['root-1'],
            events: [{ type: 'tool_end', status: 'completed', title: 'Review complete' }],
          },
        },
        {
          id: 'reply-2',
          groupId: 'group-1',
          role: 'agent',
          agentKind: 'hermes',
          content: 'Delete only this reply first',
          threadRootId: 'root-1',
          createdAt: '2026-07-29T08:03:00Z',
        },
      )
      nextBridge.localWorkspace.deleteMessage.mockImplementation(async (groupId, messageId) => {
        const target = nextState.messages.find(message => (
          message.groupId === groupId && message.id === messageId
        ))
        const deletedIds = new Set([messageId])
        if (target?.role === 'user' && !target.threadRootId) {
          for (const message of nextState.messages) {
            if (message.groupId === groupId && message.threadRootId === messageId) {
              deletedIds.add(message.id)
            }
          }
        }
        nextState.messages = nextState.messages.filter(message => !deletedIds.has(message.id))
        return structuredClone(nextState)
      })
    })
    const writeText = navigator.clipboard.writeText

    await wrapper.get('.conversation-link').trigger('click')
    await flushPromises()
    expect(wrapper.find('.run-status-panel.history').exists()).toBe(true)

    expect(wrapper.get('.run-status-panel.history .run-status-meta').text()).toContain('Latest topic run')
    expect(wrapper.get('.run-status-panel.history .run-status-meta').text()).not.toContain('Running topic')

    const rootDelete = () => wrapper.get('#message-root-1 .message-delete-button')
    await rootDelete().trigger('click')
    expect(bridge.localWorkspace.deleteMessage).not.toHaveBeenCalled()
    expect(rootDelete().classes()).toContain('armed')
    expect(rootDelete().attributes('aria-label')).toBe('Click again to delete this topic and its replies')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(rootDelete().classes()).not.toContain('armed')
    expect(rootDelete().attributes('aria-label')).toBe('Delete topic')

    await rootDelete().trigger('click')
    const replyDelete = wrapper.get('#message-reply-2 .message-delete-button')
    await replyDelete.trigger('click')
    expect(rootDelete().classes()).not.toContain('armed')
    expect(replyDelete.classes()).toContain('armed')

    await replyDelete.trigger('click')
    await flushPromises()
    expect(bridge.localWorkspace.deleteMessage).toHaveBeenLastCalledWith('group-1', 'reply-2')
    expect(wrapper.find('#message-reply-2').exists()).toBe(false)
    expect(wrapper.find('#message-root-1').exists()).toBe(true)
    expect(writeText).not.toHaveBeenCalled()

    await rootDelete().trigger('click')
    await rootDelete().trigger('click')
    await flushPromises()
    expect(bridge.localWorkspace.deleteMessage).toHaveBeenLastCalledWith('group-1', 'root-1')
    expect(state.messages.map(message => message.id)).toEqual(['keep-root'])
    expect(wrapper.find('#message-root-1').exists()).toBe(false)
    expect(wrapper.find('#message-reply-1').exists()).toBe(false)
    expect(wrapper.find('#message-keep-root').exists()).toBe(true)
    expect(wrapper.find('.run-status-panel.history').exists()).toBe(false)
    wrapper.unmount()
  })

  it('disables message deletion while the conversation is running', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-running',
        conversationType: 'group',
        name: 'Running cleanup',
        topic: '',
        agentKinds: ['codex'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.messages.push({
        id: 'running-root',
        groupId: 'group-running',
        role: 'user',
        content: 'Do not delete while running',
        createdAt: '2026-07-29T08:01:00Z',
      })
      state.runningGroupIds = ['group-running']
      state.runs = [{
        groupId: 'group-running',
        phase: 'running',
        mode: 'manual',
        targetKinds: ['codex'],
        currentKind: 'codex',
        threadRootId: 'running-root',
        progress: [],
      }]
    })

    await wrapper.get('.conversation-link').trigger('click')
    await flushPromises()
    const deleteButton = wrapper.get('.message-delete-button')
    expect(deleteButton.attributes()).toHaveProperty('disabled')
    expect(deleteButton.attributes('aria-label')).toBe('Stop the current run before deleting messages')
    await deleteButton.trigger('click')
    expect(bridge.localWorkspace.deleteMessage).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('reopens and locates the declared running topic while keeping progress and execution metadata collapsed', async () => {
    const scrollIntoView = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrollIntoView
    const { wrapper, state, emitWorkspaceChanged } = await mountApp(({ state: nextState }) => {
      nextState.groups.push({
        id: 'group-1',
        conversationType: 'group',
        name: 'Implementation review',
        topic: '',
        agentKinds: ['codex', 'hermes', 'qwen'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      nextState.messages.push(
        {
          id: 'root-1',
          groupId: 'group-1',
          role: 'user',
          content: 'Review this change',
          targetKinds: ['codex'],
          createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'reply-1',
          groupId: 'group-1',
          role: 'agent',
          agentKind: 'codex',
          content: 'Final answer remains visible.',
          threadRootId: 'root-1',
          toolCalls: [
            { title: 'process', status: 'completed' },
            { title: 'write_file', status: 'succeeded' },
            { title: 'internal_debug', status: 'running' },
          ],
          elapsedMs: 1250,
          createdAt: '2026-07-29T08:02:00Z',
        },
      )
    })

    await wrapper.get('.conversation-link').trigger('click')
    expect(wrapper.get('.message-target-list').text()).toBe('')
    expect(wrapper.get('.message-target-list img').exists()).toBe(true)
    expect(wrapper.get('.message-target-avatar').attributes('aria-label')).toBe('Codex')
    expect(wrapper.get('.message-target-list').element.parentElement).toBe(
      wrapper.get('.message-meta').element,
    )
    expect(wrapper.get('.message-target-list').element.previousElementSibling.tagName).toBe('STRONG')
    expect(wrapper.get('.user-message-content').element.parentElement.className).toBe('user-message-flow')
    expect(wrapper.get('.message-row.agent').classes()).toContain('group-message')
    expect(wrapper.get('.message-row.agent').classes()).toContain('topic-reply')
    expect(wrapper.get('.topic-toggle').text()).toContain('1 reply')
    expect(wrapper.findAll('.topic-reply-avatars img')).toHaveLength(1)
    expect(wrapper.get('.topic-reply-avatars img').attributes('alt')).toBe('Codex')
    await wrapper.get('.topic-toggle').trigger('click')
    expect(wrapper.find('.message-row.agent').exists()).toBe(false)

    state.runningGroupIds = ['group-1']
    state.runs = [{
      groupId: 'group-1',
      mode: 'auto',
      targetKinds: ['codex', 'hermes', 'qwen'],
      completedKinds: ['codex'],
      currentKind: 'hermes',
      threadRootId: 'root-1',
      currentRound: 2,
      maxRounds: 6,
      progress: [
        { title: 'process', status: 'completed' },
        { title: 'write_file', status: 'in_progress' },
        { title: 'private_detail', status: 'queued' },
      ],
    }]
    emitWorkspaceChanged()
    await flushPromises()

    expect(wrapper.get('.message-row.agent').text()).toContain('Final answer remains visible.')
    expect(wrapper.get('#message-root-1').classes()).toContain('active-topic')
    expect(wrapper.get('.run-status-panel .run-status-meta').text()).toContain('Running topic')
    expect(wrapper.get('.run-status-panel .run-status-meta').text()).not.toContain('Latest topic run')
    expect(scrollIntoView).toHaveBeenCalled()
    expect(wrapper.get('.run-status-panel.group.solo').text()).toContain('Codex')
    expect(wrapper.get('.run-status-panel').text()).not.toContain('Hermes')
    expect(wrapper.get('.run-status-panel').text()).not.toContain('Qwen Code')
    expect(wrapper.get('.run-round-progress').text()).toBe('Round 2/6')
    expect(wrapper.findAll('.relay-run-indicator .run-agent-logo')).toHaveLength(0)
    expect(wrapper.findAll('.run-agent-row')).toHaveLength(0)
    expect(wrapper.get('.direct-run-indicator .run-agent-logo').attributes('data-status')).toBe('completed')
    expect(wrapper.findAll('.execution-details')).toHaveLength(2)
    expect(wrapper.findAll('.execution-details').every(details => details.attributes('open') === undefined)).toBe(true)
    expect(wrapper.get('.run-progress-details').element.tagName).toBe('DIV')
    const runningStep = wrapper.findAll('.run-progress-details li')[1].get('small')
    expect(runningStep.text()).toBe('Running')
    expect(runningStep.classes()).toContain('running')

    await wrapper.findAll('.titlebar-preferences button')[0].trigger('click')
    const detailsText = wrapper.findAll('.execution-details').map(details => details.text()).join(' ')
    expect(detailsText).toContain('运行进程')
    expect(detailsText).toContain('写入文件')
    expect(detailsText).toContain('执行步骤 3')
    expect(detailsText).toContain('进行中')
    expect(detailsText).not.toContain('internal_debug')
    expect(detailsText).not.toContain('private_detail')

    state.runs[0].failedKinds = ['codex']
    emitWorkspaceChanged()
    await flushPromises()
    expect(wrapper.get('.direct-run-indicator .run-agent-logo').attributes('data-status')).toBe('failed')
    expect(wrapper.get('.solo-run-status').attributes('data-status')).toBe('failed')
    wrapper.unmount()
  })

  it('keeps skill context and consecutive user message content left-aligned inside direct and group bubbles', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push(
        {
          id: 'direct-codex',
          conversationType: 'direct',
          directAgentKind: 'codex',
          name: 'Codex review',
          topic: '',
          agentKinds: ['codex'],
          workdir: '/tmp/meldwork-workspace',
          allowWrite: false,
          createdAt: '2026-07-29T08:00:00Z',
          updatedAt: '2026-07-29T08:00:00Z',
        },
        {
          id: 'group-1',
          conversationType: 'group',
          name: 'Implementation review',
          topic: '',
          agentKinds: ['codex', 'hermes'],
          workdir: '/tmp/meldwork-workspace',
          allowWrite: false,
          createdAt: '2026-07-29T08:00:00Z',
          updatedAt: '2026-07-29T08:00:00Z',
        },
      )
      state.messages.push(
        {
          id: 'direct-root-1',
          groupId: 'direct-codex',
          role: 'user',
          content: 'Review this implementation',
          skillHints: [{ targetKind: 'codex', namespace: 'quality', slug: 'review', name: 'Review code' }],
          createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'direct-root-2',
          groupId: 'direct-codex',
          role: 'user',
          content: 'Continue with the next check',
          skillHints: [{ targetKind: 'codex', namespace: 'quality', slug: 'review', name: 'Review code' }],
          createdAt: '2026-07-29T08:02:00Z',
        },
        {
          id: 'group-root-1',
          groupId: 'group-1',
          role: 'user',
          content: '**Compare the internal references**\n\n1. Verify the source\n2. Preserve the evidence',
          targetKinds: ['codex', 'hermes'],
          skillHints: [{ targetKind: 'codex', namespace: 'quality', slug: 'review', name: 'Review code' }],
          knowledgeBaseHints: [{ kind: 'dingtalk', targetKinds: ['codex', 'hermes'] }],
          createdAt: '2026-07-29T08:03:00Z',
        },
      )
    })

    await wrapper.get('.direct-session-open').trigger('click')
    await flushPromises()
    const directContents = wrapper.findAll('.user-message-content')
    expect(directContents).toHaveLength(2)
    directContents.forEach((content) => {
      expect(content.element.children[0].classList).toContain('message-skill-list')
      expect(content.element.children[1].classList).toContain('user-message-markdown')
    })

    await wrapper.get('.conversation-link').trigger('click')
    await flushPromises()
    const groupContent = wrapper.get('.user-message-content')
    expect(Array.from(groupContent.element.children).map(element => element.className)).toEqual([
      'message-skill-list',
      'message-content markdown-body user-message-markdown',
    ])
    expect(wrapper.get('.message-target-list').text()).toBe('')
    expect(wrapper.findAll('.message-target-avatar img')).toHaveLength(2)
    expect(groupContent.get('.message-skill-list').text()).toContain('Review code')
    expect(groupContent.get('.message-skill-list').text()).not.toContain('@')
    expect(groupContent.get('.message-knowledge-base img').exists()).toBe(true)
    expect(groupContent.get('.message-knowledge-base').text()).toBe('')
    expect(groupContent.get('.user-message-markdown strong').text()).toBe('Compare the internal references')
    expect(groupContent.findAll('.user-message-markdown ol li').map(item => item.text()))
      .toEqual(['Verify the source', 'Preserve the evidence'])

    const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    expect(styles).toMatch(/\.message-row\.user \.message-body\s*\{[^}]*text-align:\s*left;/s)
    expect(styles).toMatch(/\.message-skill-list\s*\{[^}]*display:\s*inline-flex;/s)
    expect(styles).toMatch(/\.message-row\.user \.message-meta time\s*\{[^}]*margin-left:\s*auto;/s)
    expect(styles).toMatch(/\.user-message-content\s*\{[^}]*display:\s*flow-root;/s)
    expect(styles).toMatch(/\.user-message-markdown\s*\{[^}]*overflow-wrap:\s*break-word;/s)
    wrapper.unmount()
  })

  it('streams direct Agent answer deltas inline without opening the group trace panel', async () => {
    const { wrapper, emitRunEvent } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'direct-trace',
        conversationType: 'direct',
        directAgentKind: 'codex',
        name: 'Codex trace',
        topic: '',
        agentKinds: ['codex'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.messages.push({
        id: 'direct-root',
        groupId: 'direct-trace',
        role: 'user',
        content: 'Stream this answer',
        createdAt: '2026-07-29T08:01:00Z',
      })
      state.runningGroupIds = ['direct-trace']
      state.runs = [{
        runId: 'run-direct',
        groupId: 'direct-trace',
        threadRootId: 'direct-root',
        targetKinds: ['codex'],
        currentKind: 'codex',
        agentRuns: [{
          agentRunId: 'agent-direct',
          kind: 'codex',
          round: 1,
          status: 'running',
          output: '',
          events: [],
        }],
      }]
    })

    await wrapper.get('.direct-session-open').trigger('click')
    emitRunEvent({
      runId: 'run-direct', agentRunId: 'agent-direct', groupId: 'direct-trace',
      threadRootId: 'direct-root', agentKind: 'codex', round: 1, seq: 1,
      type: 'answer_delta', status: 'running', delta: 'First',
    })
    await flushPromises()
    expect(wrapper.get('.message-row.agent[data-agent-kind="codex"] .message-copy-surface').text()).toContain('First')
    expect(wrapper.get('.direct-conclusion-live-status').text()).toBe('Codex / Conclusion / Streaming')
    expect(wrapper.get('.direct-conclusion-live-status').text()).not.toContain('First')
    const traceDetails = wrapper.get('.trace-inline-details')
    expect(traceDetails.exists()).toBe(true)
    expect(traceDetails.element.open).toBe(false)
    expect(wrapper.find('.run-trace-panel').exists()).toBe(false)
    expect(wrapper.find('.message-trace-button').exists()).toBe(false)

    traceDetails.element.open = true
    await traceDetails.trigger('toggle')
    await flushPromises()
    expect(traceDetails.element.open).toBe(true)

    emitRunEvent({
      runId: 'run-direct', agentRunId: 'agent-direct', groupId: 'direct-trace',
      threadRootId: 'direct-root', agentKind: 'codex', round: 1, seq: 2,
      type: 'answer_delta', status: 'running', delta: ' answer',
    })
    emitRunEvent({
      runId: 'run-direct', agentRunId: 'agent-direct', groupId: 'direct-trace',
      threadRootId: 'direct-root', agentKind: 'codex', round: 1, seq: 3,
      type: 'warning', status: 'waiting', title: 'connector_limited',
    })
    await flushPromises()
    expect(wrapper.get('.message-row.agent[data-agent-kind="codex"] .message-copy-surface').text()).toContain('First answer')
    expect(wrapper.get('.direct-conclusion-live-status').text()).toBe('Codex / Conclusion / Streaming')
    expect(wrapper.get('.direct-trace-event-live-status').text()).toContain('Codex / Execution details / Warning')
    expect(wrapper.get('.direct-trace-event-live-status').text()).toContain('Waiting for output')
    expect(wrapper.get('.trace-inline-details').element.open).toBe(true)
    expect(wrapper.get('.trace-inline-event-disclosure summary small').text())
      .toBe('Connector provided only the final answer; structured tool activity was unavailable.')
    expect(wrapper.get('.trace-inline-details').text()).not.toContain('connector_limited')
    wrapper.unmount()
  })

  it('keeps direct Human Gates inline and sends exact approve or reject decisions', async () => {
    const allowGateId = `human-gate-${'a'.repeat(64)}`
    const rejectGateId = `human-gate-${'b'.repeat(64)}`
    const recoveryGateId = `human-gate-${'c'.repeat(64)}`
    const gate = (gateId, type = 'permission') => ({
      gateId,
      type,
      runId: 'run-direct-gated',
      agentRunId: 'agent-direct-gated',
      agentKind: 'codex',
      summary: type === 'budget'
        ? 'Cost usage is unavailable for this Agent attempt.'
        : 'Agent requests permission to continue a tool action.',
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
      status: 'pending',
      createdAt: '2026-08-04T08:00:00.000Z',
    })
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'direct-gated',
        conversationType: 'direct',
        directAgentKind: 'codex',
        name: 'Codex approval',
        topic: '',
        agentKinds: ['codex'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-08-04T08:00:00.000Z',
        updatedAt: '2026-08-04T08:00:00.000Z',
      })
      state.messages.push({
        id: 'direct-gated-root',
        groupId: 'direct-gated',
        role: 'user',
        content: 'Ask before continuing',
        createdAt: '2026-08-04T08:00:00.000Z',
      })
      state.runningGroupIds = ['direct-gated']
      state.runs = [{
        runId: 'run-direct-gated',
        groupId: 'direct-gated',
        threadRootId: 'direct-gated-root',
        targetKinds: ['codex'],
        currentKind: 'codex',
        waitingGateIds: [allowGateId, rejectGateId, recoveryGateId],
        budget: {
          limits: {
            inputTokens: 4000, outputTokens: null, costMicros: null,
            toolCalls: 2, outboundBytes: null, elapsedMs: null,
          },
          used: {
            inputTokens: 750, outputTokens: 120, costMicros: 0,
            toolCalls: 3, outboundBytes: 2048, elapsedMs: 2500,
          },
          source: {
            inputTokens: 'estimated', outputTokens: 'reported', costMicros: 'unknown',
            toolCalls: 'estimated', outboundBytes: 'reported', elapsedMs: 'reported',
          },
          enforcement: {
            inputTokens: 'hard', outputTokens: 'soft', costMicros: 'hard',
            toolCalls: 'hard', outboundBytes: 'soft', elapsedMs: 'soft',
          },
          startedAt: 1000,
          exhaustion: {
            dimension: 'toolCalls', limit: 2, priorUsed: 2, attemptedUsage: 1, used: 3,
            source: 'estimated', enforcement: 'hard', reason: 'BUDGET_LIMIT_EXCEEDED',
          },
        },
        agentRuns: [{
          agentRunId: 'agent-direct-gated',
          kind: 'codex',
          round: 1,
          status: 'waiting',
          output: '',
          events: [],
        }],
      }]
      state.humanGates = [
        gate(allowGateId),
        gate(rejectGateId, 'budget'),
        {
          ...gate(recoveryGateId, 'decision'),
          summary: 'The candidate and unresolved issues have remained unchanged for two rounds.',
          options: [
            { optionId: 'retry-original-writer', name: 'Accept', kind: 'accept' },
            { optionId: 'replace-next-writer', name: 'Accept', kind: 'accept' },
          ],
        },
      ]
    })

    await wrapper.get('.direct-session-open').trigger('click')
    await flushPromises()

    expect(wrapper.find('.run-trace-panel').exists()).toBe(false)
    expect(wrapper.findAll('.direct-human-gate-list .human-gate-card')).toHaveLength(3)
    expect(wrapper.get('.direct-human-gate-list').text()).toContain('This Agent needs permission')
    expect(wrapper.get('.direct-human-gate-list').text()).toContain('cannot report cost usage')
    expect(wrapper.get('.direct-budget-details').text()).toContain('Input tokens')
    expect(wrapper.get('.direct-budget-details').text()).toContain('750 / 4,000')
    expect(wrapper.get('.direct-budget-details').text()).toContain('Hard budget stop')

    const gateCards = wrapper.findAll('.direct-human-gate-list .human-gate-card')
    const recoveryButtons = gateCards[2].findAll('button')
    expect(recoveryButtons.map(button => button.text())).toEqual([
      'Retry original writer',
      'Use next writer',
    ])
    expect(recoveryButtons[0].text()).not.toBe(recoveryButtons[1].text())
    await gateCards[0].findAll('button').find(button => button.text() === 'Allow once').trigger('click')
    await gateCards[1].findAll('button').find(button => button.text() === 'Reject').trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.decideHumanGate).toHaveBeenNthCalledWith(
      1,
      allowGateId,
      { optionId: 'allow-once' },
    )
    expect(bridge.localWorkspace.decideHumanGate).toHaveBeenNthCalledWith(
      2,
      rejectGateId,
      { optionId: 'reject-once' },
    )
    setLocale('zh')
    await flushPromises()
    expect(wrapper.get('.direct-human-gate-list').text()).toContain('候选结论与未解决问题已连续两轮没有变化')
    wrapper.unmount()
  })

  it('submits direct Connector input through the narrow Human Gate decision', async () => {
    const gateId = `human-gate-${'d'.repeat(64)}`
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'direct-input', conversationType: 'direct', directAgentKind: 'codex',
        name: 'Connector input', topic: '', agentKinds: ['codex'],
        workdir: '/tmp/meldwork-workspace', allowWrite: false,
        createdAt: '2026-08-04T08:00:00.000Z', updatedAt: '2026-08-04T08:00:00.000Z',
      })
      state.messages.push({
        id: 'direct-input-root', groupId: 'direct-input', role: 'user',
        content: 'Prepare release', createdAt: '2026-08-04T08:00:00.000Z',
      })
      state.runningGroupIds = ['direct-input']
      state.runs = [{
        runId: 'run-direct-input', groupId: 'direct-input', threadRootId: 'direct-input-root',
        targetKinds: ['codex'], currentKind: 'codex', waitingGateIds: [gateId],
        agentRuns: [{ agentRunId: 'agent-direct-input', kind: 'codex', status: 'waiting' }],
      }]
      state.humanGates = [{
        gateId, type: 'input', runId: 'run-direct-input',
        agentRunId: 'agent-direct-input', agentKind: 'codex',
        summary: 'Choose release channel',
        options: [
          { optionId: 'submit-input', name: 'Submit', kind: 'respond' },
          { optionId: 'cancel-input', name: 'Cancel', kind: 'reject' },
        ],
        status: 'pending', createdAt: '2026-08-04T08:00:00.000Z',
      }]
    })

    await wrapper.get('.direct-session-open').trigger('click')
    await wrapper.get('.human-gate-input input').setValue('stable')
    await wrapper.get('.human-gate-input').trigger('submit')
    await flushPromises()

    expect(bridge.localWorkspace.decideHumanGate).toHaveBeenCalledWith(
      gateId,
      { optionId: 'submit-input', response: 'stable' },
    )
    wrapper.unmount()
  })

  it('keeps live and durable direct traces collapsed by default', async () => {
    const { wrapper, state, emitWorkspaceChanged } = await mountApp(({ state: nextState }) => {
      nextState.groups.push({
        id: 'direct-live-durable',
        conversationType: 'direct',
        directAgentKind: 'codex',
        name: 'Codex live trace',
        topic: '',
        agentKinds: ['codex'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      nextState.messages.push({
        id: 'direct-live-root',
        groupId: 'direct-live-durable',
        role: 'user',
        content: 'Keep the live trace visible',
        createdAt: '2026-07-29T08:01:00Z',
      })
      nextState.runningGroupIds = ['direct-live-durable']
      nextState.runs = [{
        runId: 'run-direct-live-durable',
        groupId: 'direct-live-durable',
        threadRootId: 'direct-live-root',
        targetKinds: ['codex'],
        currentKind: 'codex',
        agentRuns: [{
          agentRunId: 'agent-direct-live-durable',
          kind: 'codex',
          round: 1,
          status: 'running',
          output: 'Live answer',
          events: [{ seq: 1, type: 'reasoning_summary', status: 'running', title: 'Reviewing' }],
        }],
      }]
    })

    await wrapper.get('.direct-session-open').trigger('click')
    await flushPromises()
    expect(wrapper.get('.trace-inline-details').element.open).toBe(false)

    state.messages.push({
      id: 'direct-live-answer',
      groupId: 'direct-live-durable',
      role: 'agent',
      agentKind: 'codex',
      threadRootId: 'direct-live-root',
      content: 'Durable answer',
      trace: {
        runId: 'run-direct-live-durable',
        agentRunId: 'agent-direct-live-durable',
        round: 1,
        status: 'completed',
        events: [{ evidenceId: 'E-R1-CODEX-01', type: 'reasoning_summary', status: 'completed', title: 'Reviewed' }],
      },
      createdAt: '2026-07-29T08:02:00Z',
    })
    emitWorkspaceChanged()
    await flushPromises()
    expect(wrapper.get('.trace-inline-details').element.open).toBe(false)

    state.runs = []
    state.runningGroupIds = []
    emitWorkspaceChanged()
    await flushPromises()

    expect(wrapper.get('.trace-inline-details').element.open).toBe(false)
    expect(wrapper.find('.run-status-panel').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows a failed direct Agent trace inline without opening the group panel', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'direct-failed-trace',
        conversationType: 'direct',
        directAgentKind: 'codex',
        name: 'Codex failure trace',
        topic: '',
        agentKinds: ['codex'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.messages.push(
        {
          id: 'failed-root',
          groupId: 'direct-failed-trace',
          role: 'user',
          content: 'Run the failing task',
          createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'failed-system',
          groupId: 'direct-failed-trace',
          role: 'system',
          agentKind: 'codex',
          content: 'Codex failed: process failed\nPartial conclusion before failure.',
          system: {
            key: 'system.agentCallFailed',
            params: { agent: 'Codex', reason: 'process failed' },
          },
          trace: {
            runId: 'run-failed-direct',
            agentRunId: 'agent-failed-direct',
            status: 'failed',
            summary: 'The process exited before returning a conclusion.',
            events: [{
              evidenceId: 'E-R0-CODEX-01',
              type: 'tool_result_summary',
              status: 'failed',
              title: 'Process',
              summary: 'Exit code 1',
            }],
          },
          createdAt: '2026-07-29T08:02:00Z',
        },
      )
    })

    await wrapper.get('.direct-session-open').trigger('click')
    const details = wrapper.get('.trace-system-details')
    expect(details.element.open).toBe(false)
    expect(wrapper.find('.run-trace-panel').exists()).toBe(false)

    details.element.open = true
    await details.trigger('toggle')
    await flushPromises()
    expect(details.element.open).toBe(true)
    expect(details.text()).toContain('The process exited before returning a conclusion.')
    expect(details.text()).toContain('Tool result')
    expect(details.text()).toContain('Exit code 1')
    expect(details.text()).toContain('Failed')
    expect(wrapper.get('.system-message .markdown-body').text()).toBe('Partial conclusion before failure.')
    expect(wrapper.find('.run-trace-panel').exists()).toBe(false)
    wrapper.unmount()
  })

  it('renders stopped and interrupted system traces in the conversation-specific disclosure', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push(
        {
          id: 'direct-stopped-trace',
          conversationType: 'direct',
          directAgentKind: 'codex',
          name: 'Stopped direct trace',
          topic: '',
          agentKinds: ['codex'],
          workdir: '/tmp/meldwork-workspace',
          allowWrite: false,
          createdAt: '2026-07-29T08:00:00Z',
          updatedAt: '2026-07-29T08:02:00Z',
        },
        {
          id: 'group-interrupted-trace',
          conversationType: 'group',
          name: 'Interrupted group trace',
          topic: '',
          agentKinds: ['codex', 'hermes'],
          workdir: '/tmp/meldwork-workspace',
          allowWrite: false,
          createdAt: '2026-07-29T08:00:00Z',
          updatedAt: '2026-07-29T08:03:00Z',
        },
      )
      state.messages.push(
        {
          id: 'direct-stopped-root',
          groupId: 'direct-stopped-trace',
          role: 'user',
          content: 'Stop this run',
          createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'direct-stopped-system',
          groupId: 'direct-stopped-trace',
          role: 'system',
          agentKind: 'codex',
          content: 'Codex was stopped.\nStopped conclusion retained.',
          system: { key: 'system.agentStopped', params: { agent: 'Codex' } },
          trace: {
            runId: 'run-direct-stopped',
            agentRunId: 'agent-direct-stopped',
            status: 'stopped',
            summary: 'The user stopped this run.',
            events: [],
          },
          createdAt: '2026-07-29T08:02:00Z',
        },
        {
          id: 'group-interrupted-root',
          groupId: 'group-interrupted-trace',
          role: 'user',
          content: 'Resume after restart',
          createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'group-interrupted-system',
          groupId: 'group-interrupted-trace',
          role: 'system',
          agentKind: 'hermes',
          threadRootId: 'group-interrupted-root',
          content: 'Hermes was interrupted when Meldwork closed.\nInterrupted conclusion retained.',
          system: { key: 'system.agentInterrupted', params: { agent: 'Hermes' } },
          trace: {
            runId: 'run-group-interrupted',
            agentRunId: 'agent-group-interrupted',
            round: 1,
            status: 'interrupted',
            summary: 'The application restarted before completion.',
            events: [],
          },
          createdAt: '2026-07-29T08:03:00Z',
        },
      )
    })

    await wrapper.get('.direct-session-open').trigger('click')
    expect(wrapper.get('.turn-rail button').attributes('data-status')).toBe('stopped')
    expect(wrapper.get('.turn-rail button').attributes('aria-label')).toContain('Stopped')
    expect(wrapper.get('.system-message').text()).toContain('Codex was stopped by the user.')
    expect(wrapper.get('.system-message .markdown-body').text()).toBe('Stopped conclusion retained.')
    expect(wrapper.get('.system-message').text()).not.toContain('Codex was stopped.')
    expect(wrapper.get('.trace-system-details').exists()).toBe(true)
    expect(wrapper.find('.message-trace-button').exists()).toBe(false)

    await wrapper.get('.conversation-link').trigger('click')
    expect(wrapper.get('.system-message').text()).toContain('Hermes was interrupted when Meldwork restarted.')
    expect(wrapper.get('.system-message .markdown-body').text()).toBe('Interrupted conclusion retained.')
    expect(wrapper.get('.system-message').text()).not.toContain('Hermes was interrupted when Meldwork closed.')
    expect(wrapper.find('.trace-inline-details').exists()).toBe(false)
    const traceButton = wrapper.get('.message-trace-button')
    await traceButton.trigger('click')
    await flushPromises()
    expect(wrapper.get('.run-trace-panel').text()).not.toContain('The application restarted before completion.')
    expect(wrapper.get('.trace-status').text()).toBe('Interrupted')

    setLocale('zh')
    await flushPromises()
    expect(wrapper.get('.system-message').text()).toContain('Meldwork 重启时，Hermes 的运行已中断。')
    expect(wrapper.get('.system-message .markdown-body').text()).toBe('Interrupted conclusion retained.')
    expect(wrapper.get('.system-message').text()).not.toContain('Hermes was interrupted when Meldwork closed.')
    wrapper.unmount()
  })

  it('restores an interrupted direct turn from a rootless terminal trace after restart', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'direct-interrupted-trace',
        conversationType: 'direct',
        directAgentKind: 'hermes',
        name: 'Interrupted direct trace',
        topic: '',
        agentKinds: ['hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:02:00Z',
      })
      state.messages.push(
        {
          id: 'direct-interrupted-root',
          groupId: 'direct-interrupted-trace',
          role: 'user',
          content: 'Resume after renderer restart',
          createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'direct-interrupted-system',
          groupId: 'direct-interrupted-trace',
          role: 'system',
          agentKind: 'hermes',
          content: 'Hermes was interrupted when Meldwork closed.\nInterrupted conclusion retained.',
          system: { key: 'system.agentInterrupted', params: { agent: 'Hermes' } },
          trace: {
            runId: 'run-direct-interrupted',
            agentRunId: 'agent-direct-interrupted',
            status: 'interrupted',
            summary: 'The application restarted before completion.',
            events: [],
          },
          createdAt: '2026-07-29T08:02:00Z',
        },
      )
    })

    await wrapper.get('.direct-session-open').trigger('click')
    const turn = wrapper.get('.turn-rail button')
    expect(turn.attributes('data-status')).toBe('interrupted')
    expect(turn.attributes('aria-label')).toContain('Interrupted')
    expect(wrapper.get('.system-message .markdown-body').text()).toBe('Interrupted conclusion retained.')
    expect(wrapper.get('.trace-system-details').exists()).toBe(true)
    expect(wrapper.find('.run-trace-panel').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps an interrupted run-finished event as interrupted', async () => {
    const { wrapper, emitRunFinished } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'direct-interrupted-event',
        conversationType: 'direct',
        directAgentKind: 'codex',
        name: 'Interrupted event',
        topic: '',
        agentKinds: ['codex'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:01:00Z',
      })
      state.messages.push({
        id: 'direct-interrupted-event-root',
        groupId: 'direct-interrupted-event',
        role: 'user',
        content: 'Interrupt this live run',
        createdAt: '2026-07-29T08:01:00Z',
      })
    })

    await wrapper.get('.direct-session-open').trigger('click')
    emitRunFinished({
      groupId: 'direct-interrupted-event',
      threadRootId: 'direct-interrupted-event-root',
      status: 'interrupted',
    })
    await flushPromises()

    const turn = wrapper.get('.turn-rail button')
    expect(turn.attributes('data-status')).toBe('interrupted')
    expect(turn.attributes('aria-label')).toContain('Interrupted')
    wrapper.unmount()
  })

  it('restores durable group turn statuses ahead of reply-count fallbacks after restart', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-terminal-turns',
        conversationType: 'group',
        name: 'Recovered terminal turns',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:08:00Z',
      })
      state.messages.push(
        {
          id: 'group-stopped-root',
          groupId: 'group-terminal-turns',
          role: 'user',
          content: 'Stop without a reply',
          createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'group-stopped-system',
          groupId: 'group-terminal-turns',
          role: 'system',
          agentKind: 'codex',
          threadRootId: 'group-stopped-root',
          content: 'Codex was stopped.',
          system: { key: 'system.agentStopped', params: { agent: 'Codex' } },
          trace: {
            runId: 'run-group-stopped',
            agentRunId: 'agent-group-stopped',
            status: 'stopped',
            events: [],
          },
          createdAt: '2026-07-29T08:02:00Z',
        },
        {
          id: 'group-interrupted-with-reply-root',
          groupId: 'group-terminal-turns',
          role: 'user',
          content: 'Interrupt after one reply',
          createdAt: '2026-07-29T08:03:00Z',
        },
        {
          id: 'group-interrupted-reply',
          groupId: 'group-terminal-turns',
          role: 'agent',
          agentKind: 'codex',
          threadRootId: 'group-interrupted-with-reply-root',
          content: 'First Agent completed.',
          trace: {
            runId: 'run-group-interrupted',
            agentRunId: 'agent-group-completed',
            status: 'completed',
            events: [],
          },
          createdAt: '2026-07-29T08:04:00Z',
        },
        {
          id: 'group-interrupted-system',
          groupId: 'group-terminal-turns',
          role: 'system',
          agentKind: 'hermes',
          threadRootId: 'group-interrupted-with-reply-root',
          content: 'Hermes was interrupted when Meldwork closed.',
          system: { key: 'system.agentInterrupted', params: { agent: 'Hermes' } },
          trace: {
            runId: 'run-group-interrupted',
            agentRunId: 'agent-group-interrupted',
            status: 'interrupted',
            events: [],
          },
          createdAt: '2026-07-29T08:05:00Z',
        },
        {
          id: 'group-timeout-root',
          groupId: 'group-terminal-turns',
          role: 'user',
          content: 'Time out this run',
          createdAt: '2026-07-29T08:06:00Z',
        },
        {
          id: 'group-timeout-system',
          groupId: 'group-terminal-turns',
          role: 'system',
          agentKind: 'hermes',
          threadRootId: 'group-timeout-root',
          content: 'Hermes failed: LOCAL_AGENT_TIMEOUT',
          system: {
            key: 'system.agentCallFailed',
            params: { agent: 'Hermes', reason: 'LOCAL_AGENT_TIMEOUT' },
          },
          trace: {
            runId: 'run-group-timeout',
            agentRunId: 'agent-group-timeout',
            status: 'timeout',
            events: [],
          },
          createdAt: '2026-07-29T08:07:00Z',
        },
        {
          id: 'group-partial-root',
          groupId: 'group-terminal-turns',
          role: 'user',
          content: 'Keep the partial result',
          createdAt: '2026-07-29T08:08:00Z',
        },
        {
          id: 'group-partial-reply',
          groupId: 'group-terminal-turns',
          role: 'agent',
          agentKind: 'codex',
          threadRootId: 'group-partial-root',
          content: 'Partial result retained.',
          trace: {
            runId: 'run-group-partial',
            agentRunId: 'agent-group-partial',
            status: 'partial',
            events: [],
          },
          createdAt: '2026-07-29T08:09:00Z',
        },
        {
          id: 'group-round-limit-root',
          groupId: 'group-terminal-turns',
          role: 'user',
          content: 'Reach the round limit',
          createdAt: '2026-07-29T08:10:00Z',
        },
        {
          id: 'group-round-limit-reply',
          groupId: 'group-terminal-turns',
          role: 'agent',
          agentKind: 'codex',
          threadRootId: 'group-round-limit-root',
          content: 'A completed round without consensus.',
          trace: {
            runId: 'run-group-round-limit',
            agentRunId: 'agent-group-round-limit',
            status: 'completed',
            events: [],
          },
          createdAt: '2026-07-29T08:11:00Z',
        },
        {
          id: 'group-round-limit-system',
          groupId: 'group-terminal-turns',
          role: 'system',
          threadRootId: 'group-round-limit-root',
          content: 'Automatic discussion reached the 4-round safety limit without consensus.',
          system: { key: 'system.autoRoundLimit', params: { rounds: 4 } },
          createdAt: '2026-07-29T08:12:00Z',
        },
      )
    })

    await wrapper.get('.conversation-link').trigger('click')
    const turns = wrapper.findAll('.turn-rail button')
    expect(turns.map(turn => turn.attributes('data-status')))
      .toEqual(['stopped', 'interrupted', 'timeout', 'partial', 'round-limit'])
    expect(turns.map(turn => turn.attributes('aria-label'))).toEqual([
      expect.stringContaining('Stopped'),
      expect.stringContaining('Interrupted'),
      expect.stringContaining('Timed out'),
      expect.stringContaining('Partially completed'),
      expect.stringContaining('Round limit reached'),
    ])
    wrapper.unmount()
  })

  it('derives mixed and controller-only run outcomes from durable group messages', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      const createdAt = '2026-07-29T08:00:00Z'
      const root = id => ({
        id,
        groupId: 'group-run-outcomes',
        role: 'user',
        content: id,
        createdAt,
      })
      const reply = (id, rootId, runId, status) => ({
        id,
        groupId: 'group-run-outcomes',
        role: 'agent',
        agentKind: 'codex',
        threadRootId: rootId,
        content: `${status} reply`,
        trace: { runId, agentRunId: id, status, events: [] },
        createdAt,
      })
      const failure = (id, rootId, runId, status) => ({
        id,
        groupId: 'group-run-outcomes',
        role: 'system',
        agentKind: 'hermes',
        threadRootId: rootId,
        content: `Hermes failed: ${status}`,
        system: { key: 'system.agentCallFailed', params: { agent: 'Hermes', reason: status } },
        trace: { runId, agentRunId: id, status, events: [] },
        createdAt,
      })
      const controllerTerminal = (id, rootId, key, params = {}) => ({
        id,
        groupId: 'group-run-outcomes',
        role: 'system',
        threadRootId: rootId,
        content: key,
        system: { key, params },
        createdAt,
      })

      state.groups.push({
        id: 'group-run-outcomes',
        conversationType: 'group',
        name: 'Recovered run outcomes',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt,
        updatedAt: createdAt,
      })
      state.messages.push(
        root('manual-failed-root'),
        reply('manual-failed-success', 'manual-failed-root', 'run-manual-failed', 'completed'),
        failure('manual-failed-error', 'manual-failed-root', 'run-manual-failed', 'failed'),
        root('manual-timeout-root'),
        reply('manual-timeout-success', 'manual-timeout-root', 'run-manual-timeout', 'completed'),
        failure('manual-timeout-error', 'manual-timeout-root', 'run-manual-timeout', 'timeout'),
        root('auto-round-limit-root'),
        reply('auto-round-limit-success', 'auto-round-limit-root', 'run-auto-round-limit', 'completed'),
        failure('auto-round-limit-error', 'auto-round-limit-root', 'run-auto-round-limit', 'failed'),
        controllerTerminal('auto-round-limit-system', 'auto-round-limit-root', 'system.autoRoundLimit', { rounds: 4 }),
        root('controller-timeout-root'),
        controllerTerminal('controller-timeout-system', 'controller-timeout-root', 'system.autoTimeout'),
        root('controller-stopped-root'),
        controllerTerminal('controller-stopped-system', 'controller-stopped-root', 'system.autoStopped', { reason: 'stopped' }),
      )
    })

    await wrapper.get('.conversation-link').trigger('click')
    expect(wrapper.findAll('.turn-rail button').map(turn => turn.attributes('data-status')))
      .toEqual(['partial', 'partial', 'round-limit', 'timeout', 'stopped'])
    wrapper.unmount()
  })

  it('uses each Agent latest round when rebuilding an automatic run outcome', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-retry-consensus',
        conversationType: 'group',
        name: 'Retry consensus',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:05:00Z',
      })
      state.messages.push(
        {
          id: 'retry-consensus-root',
          groupId: 'group-retry-consensus',
          role: 'user',
          content: 'Retry until both Agents agree',
          createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'retry-codex-round-1',
          groupId: 'group-retry-consensus',
          role: 'system',
          agentKind: 'codex',
          threadRootId: 'retry-consensus-root',
          content: 'Codex failed: first attempt failed',
          system: {
            key: 'system.agentCallFailed',
            params: { agent: 'Codex', reason: 'first attempt failed' },
          },
          trace: {
            runId: 'run-retry-consensus',
            agentRunId: 'retry-codex-round-1',
            round: 1,
            status: 'failed',
            events: [],
          },
          createdAt: '2026-07-29T08:02:00Z',
        },
        {
          id: 'retry-hermes-round-1',
          groupId: 'group-retry-consensus',
          role: 'agent',
          agentKind: 'hermes',
          threadRootId: 'retry-consensus-root',
          content: 'Hermes round one answer',
          trace: {
            runId: 'run-retry-consensus',
            agentRunId: 'retry-hermes-round-1',
            round: 1,
            status: 'completed',
            events: [],
          },
          createdAt: '2026-07-29T08:03:00Z',
        },
        {
          id: 'retry-codex-round-2',
          groupId: 'group-retry-consensus',
          role: 'agent',
          agentKind: 'codex',
          threadRootId: 'retry-consensus-root',
          content: 'Codex recovered in round two',
          trace: {
            runId: 'run-retry-consensus',
            agentRunId: 'retry-codex-round-2',
            round: 2,
            status: 'completed',
            events: [],
          },
          createdAt: '2026-07-29T08:04:00Z',
        },
        {
          id: 'retry-hermes-round-2',
          groupId: 'group-retry-consensus',
          role: 'agent',
          agentKind: 'hermes',
          threadRootId: 'retry-consensus-root',
          content: 'Hermes agreed in round two',
          trace: {
            runId: 'run-retry-consensus',
            agentRunId: 'retry-hermes-round-2',
            round: 2,
            status: 'completed',
            events: [],
          },
          createdAt: '2026-07-29T08:05:00Z',
        },
      )
    })

    await wrapper.get('.conversation-link').trigger('click')
    const turn = wrapper.get('.turn-rail button')
    expect(turn.attributes('data-status')).toBe('completed')
    expect(turn.attributes('aria-label')).toContain('Completed')
    wrapper.unmount()
  })

  it('shows an honest empty state when a direct trace contains only lifecycle placeholders', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'direct-empty-trace',
        conversationType: 'direct',
        directAgentKind: 'codex',
        name: 'Codex empty trace',
        topic: '',
        agentKinds: ['codex'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.messages.push(
        {
          id: 'direct-empty-root',
          groupId: 'direct-empty-trace',
          role: 'user',
          content: 'Return the final answer',
          createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'direct-empty-agent',
          groupId: 'direct-empty-trace',
          role: 'agent',
          agentKind: 'codex',
          threadRootId: 'direct-empty-root',
          content: 'Final answer',
          toolCalls: [{ title: 'search', status: 'completed' }],
          trace: {
            runId: 'run-direct-empty',
            agentRunId: 'agent-direct-empty',
            status: 'completed',
            events: [
              { evidenceId: 'E-R1-CODEX-01', type: 'status', status: 'running', title: 'Agent' },
              { evidenceId: 'E-R1-CODEX-02', type: 'status', status: 'running', title: 'Process' },
            ],
          },
          createdAt: '2026-07-29T08:02:00Z',
        },
      )
    })

    await wrapper.get('.direct-session-open').trigger('click')
    const details = wrapper.get('.trace-inline-details')
    expect(details.get('summary small').text()).toBe('0')
    expect(wrapper.findAll('.execution-details')).toHaveLength(1)
    expect(wrapper.text()).not.toContain('Execution process')

    details.element.open = true
    await details.trigger('toggle')
    await flushPromises()

    expect(details.findAll('.trace-inline-event')).toHaveLength(0)
    expect(details.get('.trace-inline-empty').text()).toBe('No detailed events were retained.')
    wrapper.unmount()
  })

  it('collapses Agent replies independently and keeps regenerated response versions in place', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-versioned-replies',
        conversationType: 'group',
        name: 'Versioned replies',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.messages.push(
        {
          id: 'version-root',
          groupId: 'group-versioned-replies',
          role: 'user',
          content: 'Compare both approaches',
          targetKinds: ['codex', 'hermes'],
          createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'codex-version-1',
          groupId: 'group-versioned-replies',
          role: 'agent',
          agentKind: 'codex',
          content: 'Codex first response',
          threadRootId: 'version-root',
          createdAt: '2026-07-29T08:02:00Z',
        },
        {
          id: 'codex-version-failure',
          groupId: 'group-versioned-replies',
          role: 'system',
          agentKind: 'codex',
          content: 'Codex failed after producing a partial response.',
          threadRootId: 'version-root',
          responseVersionRootId: 'codex-version-1',
          system: {
            key: 'system.agentCallFailed',
            params: { agent: 'Codex', reason: 'LOCAL_AGENT_TIMEOUT' },
          },
          trace: { round: 1, phase: 'running', status: 'failed', agentRunId: 'codex-failure-run' },
          createdAt: '2026-07-29T08:02:30Z',
        },
        {
          id: 'hermes-response',
          groupId: 'group-versioned-replies',
          role: 'agent',
          agentKind: 'hermes',
          content: 'Hermes response remains visible',
          threadRootId: 'version-root',
          createdAt: '2026-07-29T08:03:00Z',
        },
        {
          id: 'codex-version-2',
          groupId: 'group-versioned-replies',
          role: 'agent',
          agentKind: 'codex',
          content: 'Codex regenerated response',
          threadRootId: 'version-root',
          responseVersionRootId: 'codex-version-1',
          createdAt: '2026-07-29T08:04:00Z',
        },
      )
    })

    await wrapper.get('.conversation-link').trigger('click')
    const codexReply = () => wrapper.get('[data-agent-kind="codex"]')
    const hermesReply = () => wrapper.get('[data-agent-kind="hermes"]')

    expect(wrapper.get('.topic-toggle').text()).toContain('2 replies')
    expect(wrapper.findAll('.message-row.agent')).toHaveLength(2)
    expect(codexReply().text()).toContain('Codex regenerated response')
    expect(codexReply().get('.response-version-controls').text()).toContain('3/3')
    expect(codexReply().findAll('.message-meta-actions > button').map(button => button.classes()[0]))
      .toEqual(['message-copy-button', 'message-reply-toggle'])
    expect(codexReply().findAll('.message-footer-actions > button').map(button => button.classes()[0]))
      .toEqual(['message-regenerate-button', 'message-delete-button'])
    expect(codexReply().get('.message-footer-actions .response-version-controls').text()).toContain('3/3')
    expect(codexReply().find('.message-footer-actions .message-copy-button').exists()).toBe(false)
    expect(codexReply().find('.message-meta-actions .message-copy-button').exists()).toBe(true)
    expect(hermesReply().find('.response-version-controls').exists()).toBe(false)
    expect(hermesReply().findAll('.message-meta-actions > button').map(button => button.classes()[0]))
      .toEqual(['message-copy-button', 'message-reply-toggle'])
    expect(hermesReply().findAll('.message-footer-actions > button').map(button => button.classes()[0]))
      .toEqual(['message-regenerate-button', 'message-delete-button'])

    await codexReply().get('.message-reply-toggle').trigger('click')
    expect(codexReply().classes()).toContain('agent-reply-collapsed')
    expect(codexReply().find('.message-copy-surface').exists()).toBe(false)
    expect(hermesReply().text()).toContain('Hermes response remains visible')

    const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    expect(styles).toMatch(/\.message-meta\s*\{[^}]*min-width:\s*0;[^}]*flex-wrap:\s*wrap;/s)
    expect(styles).toMatch(/\.message-meta strong\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/s)
    expect(styles).toMatch(/\.message-footer-actions\s*\{[^}]*left:\s*10px;[^}]*right:\s*8px;[^}]*min-width:\s*0;[^}]*display:\s*flex;[^}]*justify-content:\s*flex-end;/s)
    expect(styles).toMatch(/\.message-footer-actions \.response-version-controls\s*\{[^}]*margin-right:\s*auto;/s)
    expect(styles).toMatch(/\.message-row\.agent-reply-collapsed \.message-body\s*\{[^}]*padding-bottom:\s*34px;/s)
    expect(styles).toMatch(/\.message-row\.agent-reply-collapsed \.message-footer-actions\s*\{[^}]*display:\s*inline-flex;/s)
    expect(styles).toMatch(/\.message-row\.agent-reply-collapsed \.message-footer-actions > \.message-regenerate-button,[^}]+\.message-row\.agent-reply-collapsed \.message-footer-actions > \.message-delete-button\s*\{[^}]*display:\s*none;/s)
    expect(styles).toMatch(/\.response-version-controls button:hover::after,\s*\.response-version-controls button:focus-visible::after\s*\{[^}]*opacity:\s*1;[^}]*transform:\s*translate\(-50%, 0\);/s)
    expect(styles).toMatch(/\.response-version-controls button:last-child::after\s*\{[^}]*right:\s*0;[^}]*left:\s*auto;[^}]*transform:\s*translateY\(-2px\);/s)
    expect(styles).toMatch(/\.response-version-controls button:first-child:hover::after,[^}]+\.response-version-controls button:last-child:focus-visible::after\s*\{[^}]*transform:\s*translateY\(0\);/s)
    const stylesheet = document.createElement('style')
    stylesheet.textContent = styles
    document.head.append(stylesheet)
    expect(getComputedStyle(codexReply().get('.message-body').element).paddingBottom).toBe('34px')
    expect(codexReply().get('.message-footer-actions .response-version-controls').isVisible()).toBe(true)
    expect(codexReply().findAll('.message-footer-actions .response-version-controls button')).toHaveLength(2)
    expect(codexReply().find('.message-footer-actions .message-regenerate-button').isVisible()).toBe(false)
    expect(codexReply().find('.message-footer-actions .message-delete-button').isVisible()).toBe(false)
    expect(codexReply().find('.message-meta-actions .message-copy-button').isVisible()).toBe(true)

    await codexReply().get('.response-version-controls button').trigger('click')
    expect(codexReply().text()).toContain('Codex failed:')
    expect(codexReply().get('.response-version-controls').text()).toContain('2/3')

    await codexReply().get('.response-version-controls button').trigger('click')
    expect(codexReply().classes()).toContain('agent-reply-collapsed')
    expect(codexReply().get('.response-version-controls').text()).toContain('1/3')

    await codexReply().get('.message-reply-toggle').trigger('click')
    expect(codexReply().text()).toContain('Codex first response')
    await codexReply().get('.message-regenerate-button').trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.send).toHaveBeenCalledWith({
      groupId: 'group-versioned-replies',
      targetKinds: ['codex'],
      mode: 'manual',
      regenerateMessageId: 'codex-version-1',
    })
    expect(codexReply().text()).toContain('Codex regenerated response')
    expect(codexReply().get('.response-version-controls').text()).toContain('3/3')
    stylesheet.remove()
    wrapper.unmount()
  })

  it('groups a phase-less failed attempt with the completed response version from the same round', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-phase-less-failure',
        conversationType: 'group',
        name: 'Phase-less failure',
        topic: '',
        agentKinds: ['codex'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.messages.push(
        {
          id: 'phase-less-root',
          groupId: 'group-phase-less-failure',
          role: 'user',
          content: 'Review the loading component',
          createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'phase-less-completed',
          groupId: 'group-phase-less-failure',
          role: 'agent',
          agentKind: 'codex',
          content: 'Completed response',
          threadRootId: 'phase-less-root',
          trace: {
            runId: 'phase-less-run', agentRunId: 'phase-less-success', round: 1,
            phase: 'proposal', status: 'completed',
          },
          createdAt: '2026-07-29T08:02:00Z',
        },
        {
          id: 'phase-less-failed',
          groupId: 'group-phase-less-failure',
          role: 'system',
          agentKind: 'codex',
          content: 'Codex failed: LOCAL_AGENT_TIMEOUT',
          threadRootId: 'phase-less-root',
          system: {
            key: 'system.agentCallFailed',
            params: { agent: 'Codex', reason: 'LOCAL_AGENT_TIMEOUT' },
          },
          trace: {
            runId: 'phase-less-run', agentRunId: 'phase-less-failure', round: 1,
            status: 'failed',
          },
          createdAt: '2026-07-29T08:02:30Z',
        },
      )
    })

    await wrapper.get('.conversation-link').trigger('click')

    expect(wrapper.findAll('.message-row.agent')).toHaveLength(1)
    expect(wrapper.get('[data-agent-kind="codex"] .response-version-controls').text())
      .toContain('2/2')
    expect(wrapper.text()).toContain('Completed response')
  })

  it('renders recovered Agent attempts for one group turn as response versions', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-recovered-attempts',
        conversationType: 'group',
        name: 'Recovered attempts',
        topic: '',
        agentKinds: ['codex'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.messages.push({
        id: 'recovered-attempts-root',
        groupId: 'group-recovered-attempts',
        role: 'user',
        content: 'Produce one proposal',
        targetKinds: ['codex'],
        createdAt: '2026-07-29T08:01:00Z',
      })
      state.runningGroupIds = ['group-recovered-attempts']
      state.runs = [{
        runId: 'run-recovered-attempts',
        groupId: 'group-recovered-attempts',
        threadRootId: 'recovered-attempts-root',
        targetKinds: ['codex'],
        currentRound: 1,
        orchestration: { phase: 'proposal' },
        agentRuns: [
          {
            agentRunId: 'codex-before-recovery', kind: 'codex', round: 1,
            status: 'interrupted', output: 'First interrupted proposal', events: [],
            context: { phase: 'proposal' }, startedAt: '2026-07-29T08:02:00Z',
          },
          {
            agentRunId: 'codex-after-recovery', kind: 'codex', round: 1,
            status: 'running', output: 'Latest recovered proposal', events: [],
            context: { phase: 'proposal' }, startedAt: '2026-07-29T08:03:00Z',
          },
        ],
      }]
    })

    await wrapper.get('.conversation-link').trigger('click')
    await flushPromises()

    const replies = wrapper.findAll('.message-row.agent')
    expect(replies).toHaveLength(1)
    expect(replies[0].text()).toContain('Latest recovered proposal')
    expect(replies[0].text()).not.toContain('First interrupted proposal')
    expect(replies[0].get('.response-version-controls').text()).toContain('2/2')
    wrapper.unmount()
  })

  it.each([
    { conversationType: 'group', groupId: 'group-scroll-latest', openSelector: '.conversation-link' },
    { conversationType: 'direct', groupId: 'direct-scroll-latest', openSelector: '.direct-session-open' },
  ])('keeps one localized return-to-bottom control for a $conversationType timeline during streaming', async ({
    conversationType,
    groupId,
    openSelector,
  }) => {
    const { wrapper, emitRunEvent } = await mountApp(({ state }) => {
      state.groups.push({
        id: groupId,
        conversationType,
        ...(conversationType === 'direct' ? { directAgentKind: 'codex' } : {}),
        name: 'Scroll latest',
        topic: '',
        agentKinds: conversationType === 'direct' ? ['codex'] : ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.messages.push({
        id: `${groupId}-root`,
        groupId,
        role: 'user',
        content: 'Keep reading above the latest message',
        createdAt: '2026-07-29T08:01:00Z',
      })
      state.runningGroupIds = [groupId]
      state.runs = [{
        runId: `${groupId}-run`,
        groupId,
        threadRootId: `${groupId}-root`,
        targetKinds: ['codex'],
        agentRuns: [{
          agentRunId: `${groupId}-agent-run`,
          kind: 'codex',
          round: 1,
          status: 'running',
          output: '',
          events: [],
        }],
      }]
    })

    await wrapper.get(openSelector).trigger('click')
    await flushPromises()
    const scroller = wrapper.get('.message-scroll').element
    let scrollTop = 360
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1200 },
      clientHeight: { configurable: true, value: 400 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: value => { scrollTop = value },
      },
    })
    await wrapper.get('.message-scroll').trigger('scroll')

    expect(wrapper.findAll('.conversation-jump-to-latest')).toHaveLength(1)
    expect(wrapper.get('.conversation-jump-to-latest').attributes('aria-label')).toBe('Jump to latest message')
    setLocale('zh')
    await flushPromises()
    expect(wrapper.get('.conversation-jump-to-latest').attributes('aria-label')).toBe('跳至最新消息')

    emitRunEvent({
      runId: `${groupId}-run`,
      agentRunId: `${groupId}-agent-run`,
      groupId,
      threadRootId: `${groupId}-root`,
      agentKind: 'codex',
      round: 1,
      seq: 1,
      type: 'answer_delta',
      status: 'running',
      delta: 'continued streaming output',
    })
    await flushPromises()
    expect(scrollTop).toBe(360)
    expect(wrapper.findAll('.conversation-jump-to-latest')).toHaveLength(1)

    scrollTop = 800
    await wrapper.get('.message-scroll').trigger('scroll')
    expect(wrapper.find('.conversation-jump-to-latest').exists()).toBe(false)

    scrollTop = 650
    await wrapper.get('.message-scroll').trigger('scroll')
    expect(wrapper.findAll('.conversation-jump-to-latest')).toHaveLength(1)

    const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    expect(styles).toMatch(/\.conversation-jump-to-latest-enter-active,[^}]+transition:\s*opacity 0\.16s ease, transform 0\.16s ease;/s)
    expect(styles).toMatch(/@media \(max-width: 640px\)\s*\{[^}]*\.conversation-jump-to-latest\s*\{[^}]*right:\s*12px;[^}]*bottom:\s*12px;/s)
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.conversation-jump-to-latest-enter-active,[^}]+transition:\s*none;/s)

    await wrapper.get('.conversation-jump-to-latest').trigger('click')
    await flushPromises()
    expect(scrollTop).toBe(1200)
    expect(wrapper.find('.conversation-jump-to-latest').exists()).toBe(false)
    wrapper.unmount()
  })
})

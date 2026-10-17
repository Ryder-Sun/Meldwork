import { readFileSync as readNodeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENTS } from '../../catalog.js'
import RunTracePanel from '../../components/RunTracePanel.vue'
import { setLocale, t } from '../../i18n.js'
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
  vi.unstubAllGlobals()
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
  it('creates one live non-Codex tool row from trusted scope without a durable Run', async () => {
    const { wrapper, emitRunEvent } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-live-hermes',
        conversationType: 'group',
        name: 'Live Hermes trace',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.messages.push({
        id: 'live-hermes-root',
        groupId: 'group-live-hermes',
        role: 'user',
        content: 'Hermes, inspect the result',
        targetKinds: ['codex', 'hermes'],
        createdAt: '2026-07-29T08:01:00Z',
      })
    })

    await wrapper.get('.conversation-link').trigger('click')
    const emitTool = (seq, type, status, summary, detail) => emitRunEvent({
      runId: 'run-live-hermes',
      agentRunId: 'agent-live-hermes',
      groupId: 'group-live-hermes',
      threadRootId: 'live-hermes-root',
      agentKind: 'hermes',
      round: 1,
      seq,
      id: 'tool-live-hermes',
      type,
      status,
      title: 'research',
      summary,
      detail,
      timestamp: `2026-07-29T08:01:0${seq}.000Z`,
    })
    emitTool(1, 'tool_start', 'running', 'starting sanitized research')
    emitTool(2, 'tool_update', 'running', 'updated sanitized research')
    emitTool(3, 'tool_result_summary', 'completed', 'final sanitized summary', '3 public results')
    await flushPromises()

    const hermesRow = wrapper.findAll('.run-agent-row').find(row => row.text().includes('Hermes'))
    expect(hermesRow).toBeTruthy()
    await hermesRow.trigger('click')
    await flushPromises()

    expect(wrapper.findAll('.trace-event-list > li')).toHaveLength(1)
    expect(wrapper.get('.trace-event-list').text()).toContain('Tool result')
    expect(wrapper.get('.trace-event-list').text()).toContain('final sanitized summary')
    expect(wrapper.get('.trace-event-status').attributes('data-status')).toBe('completed')
    wrapper.unmount()
  })

  it('opens the selected Agent execution details in a group trace panel', async () => {
    const addMediaListener = vi.fn()
    const removeMediaListener = vi.fn()
    vi.stubGlobal('matchMedia', vi.fn(query => ({
      matches: query === '(max-width: 1179px)',
      addEventListener: addMediaListener,
      removeEventListener: removeMediaListener,
    })))
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-trace',
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
        id: 'group-root',
        groupId: 'group-trace',
        role: 'user',
        content: 'Compare the approaches',
        createdAt: '2026-07-29T08:01:00Z',
      })
      state.runningGroupIds = ['group-trace']
      state.runs = [{
        runId: 'run-group',
        groupId: 'group-trace',
        threadRootId: 'group-root',
        targetKinds: ['codex', 'hermes'],
        currentKind: 'hermes',
        agentRuns: [
          {
            agentRunId: 'agent-codex',
            kind: 'codex',
            round: 1,
            status: 'completed',
            output: 'Codex conclusion',
            events: [{ seq: 1, type: 'reasoning_summary', status: 'completed', summary: 'Codex evidence' }],
          },
          {
            agentRunId: 'agent-hermes',
            kind: 'hermes',
            round: 1,
            status: 'running',
            output: 'Hermes conclusion',
            events: [{ seq: 2, type: 'tool_result_summary', status: 'completed', title: 'Research', summary: 'Hermes evidence' }],
          },
        ],
      }]
    })

    await wrapper.get('.conversation-link').trigger('click')
    const hermesRow = wrapper.findAll('.run-agent-row').find(row => row.get('strong').text() === 'Hermes')
    expect(hermesRow).toBeTruthy()
    await hermesRow.trigger('click')
    await flushPromises()

    expect(wrapper.get('.run-trace-panel').exists()).toBe(true)
    expect(wrapper.get('.trace-panel-header strong').text()).toBe('Hermes')
    expect(wrapper.get('.trace-agent-selector .trace-select-trigger strong').text()).toBe('Hermes')
    expect(wrapper.get('.run-trace-panel').text()).not.toContain('Hermes conclusion')
    expect(wrapper.find('.trace-conclusion').exists()).toBe(false)
    expect(wrapper.get('.trace-event-list').text()).toContain('Tool result')
    expect(document.body.classList.contains('trace-drawer-open')).toBe(true)
    expect(addMediaListener).toHaveBeenCalledTimes(1)
    wrapper.unmount()
    expect(document.body.classList.contains('trace-drawer-open')).toBe(false)
    expect(removeMediaListener).toHaveBeenCalledTimes(1)
  })

  it('opens Run details when a direct Agent reply body is clicked', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'direct-trace-click',
        conversationType: 'direct',
        directAgentKind: 'hermes',
        name: 'Hermes trace',
        topic: '',
        agentKinds: ['hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: true,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:02:00Z',
      })
      state.messages.push(
        {
          id: 'direct-trace-root', groupId: 'direct-trace-click', role: 'user',
          content: 'Generate a preview', createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'direct-trace-reply', groupId: 'direct-trace-click', role: 'agent', agentKind: 'hermes',
          content: 'Hermes generated the preview.', createdAt: '2026-07-29T08:02:00Z',
          trace: {
            runId: 'direct-trace-run', agentRunId: 'direct-trace-agent-run', round: 0,
            status: 'completed', summary: 'Generated media',
            events: [{ seq: 1, type: 'tool_result_summary', status: 'completed', title: 'video_generation' }],
          },
        },
      )
    })

    await wrapper.get('.direct-session-open').trigger('click')
    await wrapper.get('.message-row.agent .message-trace-surface').trigger('click')
    await flushPromises()

    expect(wrapper.get('.run-trace-panel').text()).not.toContain('Hermes generated the preview.')
    expect(wrapper.get('.trace-event-list').text()).toContain('video_generation')
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('keeps pending group Gates available without unrelated runtime controls', async () => {
    const gateId = `human-gate-${'d'.repeat(64)}`
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-runtime-controls',
        conversationType: 'group',
        name: 'Runtime controls',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-08-04T08:00:00.000Z',
        updatedAt: '2026-08-04T08:00:00.000Z',
      })
      state.messages.push({
        id: 'runtime-controls-root',
        groupId: 'group-runtime-controls',
        role: 'user',
        content: 'Coordinate the runtime',
        targetKinds: ['codex', 'hermes'],
        createdAt: '2026-08-04T08:00:00.000Z',
      })
      state.runningGroupIds = ['group-runtime-controls']
      state.runs = [{
        runId: 'run-runtime-controls',
        groupId: 'group-runtime-controls',
        threadRootId: 'runtime-controls-root',
        targetKinds: ['codex', 'hermes'],
        currentKind: 'codex',
        waitingGateIds: [gateId],
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
          agentRunId: 'agent-runtime-codex',
          kind: 'codex',
          round: 1,
          status: 'waiting',
          output: 'Waiting for approval',
          events: [{
            seq: 1, type: 'warning', status: 'waiting', title: 'Permission required',
          }],
        }],
      }]
      state.humanGates = [{
        gateId,
        type: 'decision',
        runId: 'run-runtime-controls',
        agentRunId: 'agent-runtime-codex',
        agentKind: 'codex',
        summary: 'The workspace-write synthesis attempt may have produced side effects, but its result is unknown.',
        options: [
          { optionId: 'continue-discussion', name: 'Accept', kind: 'accept' },
          { optionId: 'stop-discussion', name: 'Reject', kind: 'reject' },
          { optionId: 'retry-original-writer', name: 'Accept', kind: 'accept' },
          { optionId: 'replace-next-writer', name: 'Accept', kind: 'accept' },
        ],
        status: 'pending',
        createdAt: '2026-08-04T08:00:00.000Z',
      }]
    })

    await wrapper.get('.conversation-link').trigger('click')
    await wrapper.get('.run-agent-row').trigger('click')
    await flushPromises()

    // The system is waiting on the user, so the state says so instead of rotating "thinking" words.
    expect(wrapper.get('.trace-waiting-state').text()).toBe('Waiting for your decision')
    expect(wrapper.get('.trace-human-gate-section').text())
      .toContain('workspace-write synthesis attempt may have produced side effects')
    expect(wrapper.find('.trace-budget-section').exists()).toBe(false)
    expect(wrapper.find('.trace-agent-control-section').exists()).toBe(false)
    const gateButtons = wrapper.findAll('.trace-human-gate-options button')
    expect(gateButtons.find(button => button.text() === 'Retry original writer').classes())
      .toContain('primary-button')
    expect(gateButtons.find(button => button.text() === 'Use next writer').classes())
      .toContain('primary-button')
    expect(gateButtons.find(button => button.text() === 'Retry original writer').text())
      .not.toBe(gateButtons.find(button => button.text() === 'Use next writer').text())
    expect(gateButtons.find(button => button.text() === 'Stop discussion').classes())
      .toContain('secondary-button')
    await gateButtons.find(button => button.text() === 'Use next writer').trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.controlAgent).not.toHaveBeenCalled()
    expect(bridge.localWorkspace.decideHumanGate).toHaveBeenCalledWith(
      gateId,
      { optionId: 'replace-next-writer' },
    )
    setLocale('zh')
    await flushPromises()
    expect(wrapper.get('.trace-human-gate-section').text()).toContain('工作区写入综合尝试可能已产生副作用，但结果未知')
    wrapper.unmount()
  })

  it('keeps historical message traces open when an unrelated active run finishes', async () => {
    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const { wrapper, state, emitWorkspaceChanged } = await mountApp(({ state }) => {
      for (const kind of ['claude', 'openclaw']) {
        state.agents.push({
          kind,
          installed: true,
          available: true,
          credentialState: 'ready',
          version: '1.0.0',
        })
      }
      state.groups.push({
        id: 'group-trace-boundaries',
        conversationType: 'group',
        name: 'Trace boundaries',
        topic: '',
        agentKinds: ['codex', 'hermes', 'claude', 'openclaw'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:06:00Z',
      })
      state.messages.push(
        {
          id: 'trace-history-root',
          groupId: 'group-trace-boundaries',
          role: 'user',
          content: 'First historical request',
          targetKinds: ['codex'],
          createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'trace-history-codex',
          groupId: 'group-trace-boundaries',
          role: 'agent',
          agentKind: 'codex',
          threadRootId: 'trace-history-root',
          content: 'Historical Codex answer',
          trace: {
            runId: 'run-trace-history-one',
            agentRunId: 'agent-trace-history-codex',
            status: 'completed',
            events: [{ evidenceId: 'E-R1-CODEX-01', type: 'reasoning_summary', status: 'completed', title: 'Old evidence' }],
          },
          createdAt: '2026-07-29T08:02:00Z',
        },
        {
          id: 'trace-current-root',
          groupId: 'group-trace-boundaries',
          role: 'user',
          content: 'Second historical request',
          targetKinds: ['claude', 'hermes'],
          createdAt: '2026-07-29T08:03:00Z',
        },
        {
          id: 'trace-current-claude',
          groupId: 'group-trace-boundaries',
          role: 'agent',
          agentKind: 'claude',
          threadRootId: 'trace-current-root',
          content: 'Current Claude answer',
          trace: {
            runId: 'run-trace-history-two',
            agentRunId: 'agent-trace-shared-claude',
            status: 'completed',
            events: [{ evidenceId: 'E-R1-CLAUDE-01', type: 'reasoning_summary', status: 'completed', title: 'Current Claude evidence' }],
          },
          createdAt: '2026-07-29T08:04:00Z',
        },
        {
          id: 'trace-current-hermes',
          groupId: 'group-trace-boundaries',
          role: 'agent',
          agentKind: 'hermes',
          threadRootId: 'trace-current-root',
          content: 'Current Hermes answer',
          trace: {
            runId: 'run-trace-history-two',
            agentRunId: 'agent-trace-current-hermes',
            status: 'completed',
            events: [{ evidenceId: 'E-R1-HERMES-01', type: 'tool_result_summary', status: 'completed', title: 'Current Hermes evidence' }],
          },
          createdAt: '2026-07-29T08:05:00Z',
        },
        {
          id: 'trace-active-root',
          groupId: 'group-trace-boundaries',
          role: 'user',
          content: 'Active request',
          targetKinds: ['openclaw', 'claude'],
          createdAt: '2026-07-29T08:06:00Z',
        },
      )
      state.runningGroupIds = ['group-trace-boundaries']
      state.runs = [{
        runId: 'run-trace-active',
        groupId: 'group-trace-boundaries',
        threadRootId: 'trace-active-root',
        targetKinds: ['openclaw', 'claude'],
        currentKind: 'claude',
        currentRound: 1,
        maxRounds: 4,
        agentRuns: [
          {
            agentRunId: 'agent-trace-active-openclaw',
            kind: 'openclaw',
            round: 1,
            status: 'completed',
            output: 'Active OpenClaw answer',
            events: [{ seq: 1, type: 'reasoning_summary', status: 'completed', title: 'Active OpenClaw evidence' }],
          },
          {
            agentRunId: 'agent-trace-shared-claude',
            kind: 'claude',
            round: 1,
            status: 'running',
            output: 'Active Claude work',
            events: [{ seq: 2, type: 'tool_start', status: 'running', title: 'Active Claude evidence' }],
          },
        ],
      }]
    })

    await wrapper.get('.conversation-link').trigger('click')
    const currentClaudeMessage = wrapper.findAll('.message-row.agent[data-agent-kind="claude"]')
      .find(row => row.text().includes('Current Claude answer'))
    expect(currentClaudeMessage).toBeTruthy()
    await currentClaudeMessage.get('.message-trace-surface').trigger('click')
    await flushPromises()

    await wrapper.get('.trace-agent-selector .trace-select-trigger').trigger('click')
    expect(wrapper.findAll('.trace-agent-selector .trace-select-option strong').map(item => item.text()))
      .toEqual(['Claude Code', 'Hermes'])
    expect(wrapper.get('.run-trace-panel').text()).toContain('Current Claude evidence')
    expect(wrapper.get('.run-trace-panel').text()).not.toContain('Historical Codex answer')
    expect(wrapper.get('.run-trace-panel').text()).not.toContain('Active Claude work')

    const activeRun = state.runs[0]
    state.runningGroupIds = []
    state.runs = []
    emitWorkspaceChanged()
    await flushPromises()

    expect(wrapper.find('.run-trace-panel').exists()).toBe(true)
    expect(wrapper.get('.run-trace-panel').text()).toContain('Current Claude evidence')
    expect(historyBack).not.toHaveBeenCalled()

    await wrapper.get('.run-trace-panel .icon-button').trigger('click')
    await flushPromises()
    expect(historyBack).toHaveBeenCalledTimes(1)

    state.runningGroupIds = ['group-trace-boundaries']
    state.runs = [activeRun]
    emitWorkspaceChanged()
    await flushPromises()

    const activeClaudeRow = wrapper.findAll('.run-agent-row')
      .find(row => row.get('strong').text() === 'Claude Code')
    expect(activeClaudeRow).toBeTruthy()
    await activeClaudeRow.trigger('click')
    await flushPromises()

    await wrapper.get('.trace-agent-selector .trace-select-trigger').trigger('click')
    expect(wrapper.findAll('.trace-agent-selector .trace-select-option strong').map(item => item.text()))
      .toEqual(['OpenClaw', 'Claude Code'])
    expect(wrapper.get('.run-trace-panel').text()).not.toContain('Active Claude work')
    expect(wrapper.get('.run-trace-panel').text()).not.toContain('Current Claude answer')
    expect(wrapper.get('.run-trace-panel').text()).not.toContain('Historical Codex answer')
    wrapper.unmount()
  })

  it('opens a retained group trace with no events and keeps its context statistics visible', async () => {
    const contextPackId = `context-pack-${'a'.repeat(64)}`
    const deliveryRecordIds = [
      `delivery-record-${'b'.repeat(64)}`,
      `delivery-record-${'c'.repeat(64)}`,
    ]
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-empty-retained-trace',
        conversationType: 'group',
        name: 'Retained empty trace',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:02:00Z',
      })
      state.messages.push(
        {
          id: 'empty-retained-root',
          groupId: 'group-empty-retained-trace',
          role: 'user',
          content: 'Keep the trace identity',
          targetKinds: ['codex'],
          createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'empty-retained-agent',
          groupId: 'group-empty-retained-trace',
          role: 'agent',
          agentKind: 'codex',
          threadRootId: 'empty-retained-root',
          content: 'Retained conclusion',
          trace: {
            runId: 'run-empty-retained',
            agentRunId: 'agent-empty-retained',
            round: 4,
            status: 'completed',
            summary: '',
            events: [],
            context: {
              includedCount: 3,
              omittedCount: 2,
              charCount: 480,
              contextMode: 'continuation',
              promptChars: 720,
              promptBytes: 760,
              promptHash: 'd'.repeat(64),
              sourceCount: 4,
              sourceHash: 'e'.repeat(64),
              wirePayloadBytes: 900,
              wirePayloadHash: 'f'.repeat(64),
              sessionRotated: true,
              contextPackId,
              deliveryRecordIds,
              sessionProvenance: {
                scope: 'task',
                reuse: true,
                origin: 'resumed',
                originTaskId: 'task-empty-retained',
                inheritedTaskIds: [],
                completeness: 'complete',
              },
            },
          },
          createdAt: '2026-07-29T08:02:00Z',
        },
      )
    })

    await wrapper.get('.conversation-link').trigger('click')
    const traceButton = wrapper.get('.message-row.agent[data-agent-kind="codex"] .message-trace-surface')
    expect(traceButton.exists()).toBe(true)
    await traceButton.trigger('click')
    await flushPromises()

    expect(wrapper.get('.trace-event-section .trace-empty-state').text())
      .toBe('No detailed events were retained.')
    expect(wrapper.get('.trace-agent-selector .trace-select-trigger small').text())
      .toBe('Round 4 / Completed')
    expect(wrapper.get('.trace-context-stats').text()).toContain('3 messages injected for this attempt')
    expect(wrapper.get('.trace-context-stats').text()).toContain('2 messages compacted')
    expect(wrapper.get('.trace-context-stats').text()).toContain('480 context characters')
    expect(wrapper.get('.trace-context-stats').text()).toContain('Continuation payload')
    expect(wrapper.get('.trace-context-stats').text()).toContain('720 prompt characters')
    expect(wrapper.get('.trace-context-stats').text()).toContain('760 prompt bytes')
    expect(wrapper.get('.trace-context-stats').text()).toContain('Session context rotated')
    expect(wrapper.get('[data-context-section="attempt"]').text()).toContain(contextPackId)
    expect(wrapper.get('[data-context-section="outbound"]').text()).toContain('Actual outbound')
    expect(wrapper.get('[data-context-section="outbound"]').text()).toContain(deliveryRecordIds[0])
    expect(wrapper.get('[data-context-section="outbound"]').text()).toContain(deliveryRecordIds[1])
    expect(wrapper.get('[data-context-section="outbound"]').text()).toContain('Sources (4)')
    expect(wrapper.get('[data-context-section="outbound"]').text()).toContain('d'.repeat(64))
    expect(wrapper.get('[data-context-section="outbound"]').text()).toContain('e'.repeat(64))
    expect(wrapper.get('[data-context-section="outbound"]').text()).toContain('f'.repeat(64))
    expect(wrapper.get('[data-context-section="session"]').attributes('data-session-reuse')).toBe('reused')
    expect(wrapper.get('[data-context-section="session"]').text())
      .toContain('Earlier native Session context may exist')

    setLocale('zh')
    await flushPromises()
    expect(wrapper.get('.trace-event-section .trace-empty-state').text()).toBe('没有保留详细过程事件。')
    expect(wrapper.get('.trace-context-stats').text()).toContain('本次尝试注入 3 条消息')
    expect(wrapper.get('.trace-context-stats').text()).toContain('续跑外发')
    expect(wrapper.get('[data-context-section="outbound"]').text()).toContain('实际外发')
    expect(wrapper.get('[data-context-section="outbound"]').text()).toContain('来源（4 项）')
    expect(wrapper.get('[data-context-section="session"]').text()).toContain('Session 中可能还存在更早的上下文')
    wrapper.unmount()
  })

  it('warns that unknown legacy Session history is outside injected message ids', () => {
    const wrapper = mount(RunTracePanel, {
      props: {
        open: true,
        items: [{
          runId: 'run-legacy',
          agentRunId: 'agent-run-legacy',
          agentKind: 'codex',
          status: 'completed',
          events: [],
          context: {
            includedCount: 2,
            omittedCount: 0,
            charCount: 320,
            contextPackId: `context-pack-${'d'.repeat(64)}`,
            deliveryRecordIds: [`delivery-record-${'e'.repeat(64)}`],
            sessionProvenance: {
              scope: 'unknown-legacy',
              reuse: true,
              origin: 'unknown-legacy',
              originTaskId: null,
              inheritedTaskIds: [],
              completeness: 'unknown-legacy',
            },
          },
        }],
        selectedAgentRunId: 'agent-run-legacy',
      },
    })

    expect(wrapper.get('[data-context-section="session"]').attributes('data-provenance-completeness'))
      .toBe('unknown-legacy')
    expect(wrapper.get('.trace-session-warning').text())
      .toBe('Legacy native Session history is unknown. The injected message IDs for this attempt are not the complete context.')
    wrapper.unmount()
  })

  it('warns when a historical Run has no captured Context Pack', () => {
    const wrapper = mount(RunTracePanel, {
      props: {
        open: true,
        items: [{
          runId: 'run-legacy-context',
          agentRunId: 'agent-run-legacy-context',
          agentKind: 'codex',
          status: 'interrupted',
          events: [],
          context: {
            includedCount: 0,
            omittedCount: 0,
            charCount: 0,
            contextPackState: 'legacy-unavailable',
          },
        }],
        selectedAgentRunId: 'agent-run-legacy-context',
      },
    })

    expect(wrapper.get('[data-context-section="context-pack-legacy"]').text())
      .toBe('This historical Run did not record a Context Pack, so its complete input cannot be reconstructed.')
    wrapper.unmount()
  })

  it('closes the group trace panel when leaving the conversation or its group disappears', async () => {
    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const { wrapper, state, emitWorkspaceChanged } = await mountApp(({ state: nextState }) => {
      nextState.groups.push({
        id: 'group-trace-lifecycle',
        conversationType: 'group',
        name: 'Trace lifecycle',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      nextState.runs = [{
        runId: 'run-trace-lifecycle',
        groupId: 'group-trace-lifecycle',
        targetKinds: ['codex', 'hermes'],
        currentKind: 'codex',
        agentRuns: [
          { agentRunId: 'agent-lifecycle-codex', kind: 'codex', round: 1, status: 'running', output: '', events: [] },
          { agentRunId: 'agent-lifecycle-hermes', kind: 'hermes', round: 1, status: 'queued', output: '', events: [] },
        ],
      }]
    })

    await wrapper.get('.conversation-link').trigger('click')
    await wrapper.get('.run-agent-row:not([disabled])').trigger('click')
    await flushPromises()
    expect(wrapper.find('.run-trace-panel').exists()).toBe(true)

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    await flushPromises()
    expect(wrapper.find('.run-trace-panel').exists()).toBe(false)
    expect(wrapper.find('.system-settings-page').exists()).toBe(true)

    await wrapper.get('.conversation-link').trigger('click')
    await wrapper.get('.run-agent-row:not([disabled])').trigger('click')
    await flushPromises()
    expect(wrapper.find('.run-trace-panel').exists()).toBe(true)

    state.groups = []
    state.messages = []
    state.runs = []
    state.runningGroupIds = []
    emitWorkspaceChanged()
    await flushPromises()

    expect(wrapper.find('.run-trace-panel').exists()).toBe(false)
    expect(wrapper.find('.agent-home').exists()).toBe(true)
    expect(historyBack).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('reuses the trace history entry when opening conversation settings', async () => {
    const historyPush = vi.spyOn(window.history, 'pushState')
    const historyReplace = vi.spyOn(window.history, 'replaceState')
    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-trace-modal-history',
        conversationType: 'group',
        name: 'Trace modal history',
        topic: '',
        agentKinds: ['codex'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:02:00Z',
      })
      state.messages.push(
        {
          id: 'trace-modal-root',
          groupId: 'group-trace-modal-history',
          role: 'user',
          content: 'Inspect modal history',
          targetKinds: ['codex'],
          createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'trace-modal-agent',
          groupId: 'group-trace-modal-history',
          role: 'agent',
          agentKind: 'codex',
          threadRootId: 'trace-modal-root',
          content: 'Trace result',
          trace: {
            runId: 'run-trace-modal-history',
            agentRunId: 'agent-trace-modal-history',
            status: 'completed',
            events: [{ type: 'reasoning_summary', status: 'completed', title: 'Reviewed' }],
          },
          createdAt: '2026-07-29T08:02:00Z',
        },
      )
    })

    await wrapper.get('.conversation-link').trigger('click')
    await wrapper.get('.message-row.agent .message-trace-surface').trigger('click')
    await flushPromises()
    expect(historyPush).toHaveBeenCalledTimes(1)

    const settingsButton = wrapper.findAll('.conversation-header-actions > .icon-button').at(-1)
    await settingsButton.trigger('click')
    await flushPromises()

    expect(wrapper.find('.run-trace-panel').exists()).toBe(false)
    expect(wrapper.find('.modal').exists()).toBe(true)
    expect(historyReplace).toHaveBeenCalledWith(
      { meldworkOverlay: true },
      '',
      window.location.href,
    )
    expect(historyPush).toHaveBeenCalledTimes(1)

    await wrapper.get('.modal-header .icon-button').trigger('click')
    await flushPromises()
    expect(historyBack).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('closes the group trace panel with Escape and restores the Agent row focus', async () => {
    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-trace-focus',
        conversationType: 'group',
        name: 'Trace focus',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.runningGroupIds = ['group-trace-focus']
      state.runs = [{
        runId: 'run-focus',
        groupId: 'group-trace-focus',
        targetKinds: ['codex', 'hermes'],
        agentRuns: [
          { agentRunId: 'agent-focus-codex', kind: 'codex', round: 1, status: 'running', output: 'Codex', events: [] },
          { agentRunId: 'agent-focus-hermes', kind: 'hermes', round: 1, status: 'running', output: 'Hermes', events: [] },
        ],
      }]
    })

    await wrapper.get('.conversation-link').trigger('click')
    const opener = wrapper.findAll('.run-agent-row').find(row => row.get('strong').text() === 'Hermes')
    await opener.trigger('click')
    await flushPromises()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()

    expect(wrapper.find('.run-trace-panel').exists()).toBe(false)
    expect(document.activeElement).toBe(opener.element)
    expect(historyBack).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('closes an empty trace panel and falls back to the conversation title', async () => {
    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const { wrapper, state, emitWorkspaceChanged } = await mountApp(({ state: nextState }) => {
      nextState.groups.push({
        id: 'group-trace-title-focus',
        conversationType: 'group',
        name: 'Trace title focus',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      nextState.runs = [{
        runId: 'run-title-focus',
        groupId: 'group-trace-title-focus',
        targetKinds: ['codex', 'hermes'],
        currentKind: 'codex',
        agentRuns: [
          { agentRunId: 'agent-title-focus-codex', kind: 'codex', round: 1, status: 'running', output: '', events: [] },
          { agentRunId: 'agent-title-focus-hermes', kind: 'hermes', round: 1, status: 'queued', output: '', events: [] },
        ],
      }]
    })

    await wrapper.get('.conversation-link').trigger('click')
    const opener = wrapper.get('.run-agent-row:not([disabled])')
    await opener.trigger('click')
    await flushPromises()

    state.runs = []
    emitWorkspaceChanged()
    await flushPromises()
    expect(opener.element.isConnected).toBe(false)
    expect(wrapper.find('.run-trace-panel').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.get('.conversation-title-block').element)
    expect(historyBack).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('keeps the full live ledger until the run ends, then uses the durable trace capsule', async () => {
    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const { wrapper, state, emitWorkspaceChanged } = await mountApp(({ state: nextState }) => {
      nextState.groups.push({
        id: 'group-durable-trace',
        conversationType: 'group',
        name: 'Durable trace',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      nextState.messages.push({
        id: 'durable-root',
        groupId: 'group-durable-trace',
        role: 'user',
        content: 'Keep the evidence',
        createdAt: '2026-07-29T08:01:00Z',
      })
      nextState.runningGroupIds = ['group-durable-trace']
      nextState.runs = [{
        runId: 'run-durable',
        groupId: 'group-durable-trace',
        threadRootId: 'durable-root',
        targetKinds: ['codex', 'hermes'],
        agentRuns: [{
          agentRunId: 'agent-durable',
          kind: 'codex',
          round: 1,
          status: 'completed',
          output: 'live output',
          events: [
            { seq: 1, type: 'reasoning_summary', status: 'completed', summary: 'live reasoning' },
            { seq: 2, type: 'tool_result_summary', status: 'completed', title: 'Bash', summary: 'live tool result' },
          ],
        }, {
          agentRunId: 'agent-durable-hermes',
          kind: 'hermes',
          round: 1,
          status: 'running',
          output: '',
          events: [],
        }],
      }]
    })

    await wrapper.get('.conversation-link').trigger('click')
    expect(wrapper.findAll('.message-row.agent[data-agent-kind="codex"]')).toHaveLength(1)
    expect(wrapper.get('.message-row.agent[data-agent-kind="codex"]').text()).toContain('live output')
    const provisionalTraceButton = wrapper.get('.message-row.agent[data-agent-kind="codex"] .message-trace-surface')
    await provisionalTraceButton.trigger('click')
    await flushPromises()
    expect(wrapper.find('.run-trace-panel').exists()).toBe(true)

    state.messages.push({
      id: 'durable-agent',
      groupId: 'group-durable-trace',
      role: 'agent',
      agentKind: 'codex',
      threadRootId: 'durable-root',
      content: 'durable output',
      createdAt: '2026-07-29T08:02:00Z',
      trace: {
        runId: 'run-durable',
        agentRunId: 'agent-durable',
        round: 1,
        status: 'completed',
        summary: 'durable summary',
        events: [{
          evidenceId: 'E-R1-CODEX-01',
          type: 'tool_result_summary',
          status: 'completed',
          title: 'Bash',
          summary: 'Bash: operation: ls -1 (3 hidden arguments)',
          detail: 'Output: 5 lines, 47 bytes',
        }],
      },
    })
    emitWorkspaceChanged()
    await flushPromises()

    expect(wrapper.findAll('.message-row.agent[data-agent-kind="codex"]')).toHaveLength(1)
    expect(wrapper.get('.message-row.agent[data-agent-kind="codex"]').text()).toContain('durable output')
    expect(wrapper.get('.message-row.agent[data-agent-kind="codex"]').text()).not.toContain('live output')
    expect(provisionalTraceButton.element.isConnected).toBe(false)
    expect(wrapper.get('.run-trace-panel').text()).not.toContain('durable summary')
    expect(wrapper.get('.run-trace-panel').text()).not.toContain('durable output')
    expect(wrapper.get('.trace-event-list').text()).toContain('live reasoning')
    expect(wrapper.get('.trace-event-list').text()).toContain('Bash')
    expect(wrapper.get('.trace-agent-selector .trace-select-trigger small').text())
      .toBe('Round 1 / Completed')

    state.runs = []
    state.runningGroupIds = []
    emitWorkspaceChanged()
    await flushPromises()

    expect(wrapper.find('.run-trace-panel').exists()).toBe(false)
    expect(wrapper.find('.run-status-panel').exists()).toBe(false)
    expect(historyBack).toHaveBeenCalledTimes(1)
    const durableTraceButton = wrapper.get('.message-row.agent[data-agent-kind="codex"] .message-trace-surface')
    await durableTraceButton.trigger('click')
    await flushPromises()

    expect(wrapper.get('.trace-event-list').text()).not.toContain('live reasoning')
    expect(wrapper.get('.trace-agent-selector .trace-select-trigger small').text())
      .toBe('Round 1 / Completed')
    const durableEventDetails = wrapper.get('.trace-event-list details')
    durableEventDetails.element.open = true
    await durableEventDetails.trigger('toggle')
    expect(wrapper.get('.trace-event-body').text()).toContain('Output: 5 lines, 47 bytes')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(document.activeElement).toBe(durableTraceButton.element)
    expect(historyBack).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('omits historical run status after timeout and reopens the durable trace from its message', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.agents.push({
        kind: 'workbuddy', installed: true, available: true, credentialState: 'ready', version: '1.0.0',
      })
      state.groups.push({
        id: 'group-timeout-trace',
        conversationType: 'group',
        name: 'Timeout trace',
        topic: '',
        agentKinds: ['codex', 'hermes', 'workbuddy'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:04:00Z',
      })
      state.messages.push(
        {
          id: 'timeout-root',
          groupId: 'group-timeout-trace',
          role: 'user',
          content: 'Research the available approaches',
          targetKinds: ['codex', 'hermes', 'workbuddy'],
          createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'timeout-codex',
          groupId: 'group-timeout-trace',
          role: 'agent',
          agentKind: 'codex',
          threadRootId: 'timeout-root',
          content: 'Codex retained conclusion',
          trace: {
            runId: 'run-timeout-retained',
            agentRunId: 'run-timeout-retained:1:codex:one',
            round: 1,
            status: 'completed',
            events: [
              { evidenceId: 'E-R1-CODEX-01', type: 'status', status: 'running', title: 'Agent' },
              { evidenceId: 'E-R1-CODEX-02', type: 'tool_result_summary', status: 'completed', title: 'Bash', summary: 'Read 12 files' },
            ],
          },
          createdAt: '2026-07-29T08:02:00Z',
        },
        {
          id: 'timeout-hermes',
          groupId: 'group-timeout-trace',
          role: 'system',
          agentKind: 'hermes',
          threadRootId: 'timeout-root',
          content: 'Hermes failed: process failed',
          trace: {
            runId: 'run-timeout-retained',
            agentRunId: 'run-timeout-retained:1:hermes:two',
            round: 1,
            status: 'failed',
            summary: 'Hermes stopped before returning a conclusion.',
            events: [],
          },
          createdAt: '2026-07-29T08:03:00Z',
        },
        {
          id: 'timeout-system',
          groupId: 'group-timeout-trace',
          role: 'system',
          agentKind: '',
          threadRootId: 'timeout-root',
          content: 'Automatic discussion reached its runtime limit without consensus.',
          system: { key: 'system.autoTimeout', params: {} },
          createdAt: '2026-07-29T08:04:00Z',
        },
      )
    })

    await wrapper.get('.conversation-link').trigger('click')
    expect(wrapper.find('.run-status-panel').exists()).toBe(false)
    expect(wrapper.findAll('.message-trace-button')).toHaveLength(1)
    expect(wrapper.find('.message-row.agent[data-agent-kind="codex"] .trace-inline-details').exists()).toBe(true)
    await wrapper.get('.message-row.agent[data-agent-kind="codex"] .message-trace-surface').trigger('click')
    await flushPromises()
    expect(wrapper.get('.run-trace-panel').text()).not.toContain('Codex retained conclusion')
    expect(wrapper.get('.trace-event-list').text()).toContain('Read 12 files')
    wrapper.unmount()
  })

  it('selects Agents and rounds from themed dropdown menus', async () => {
    const wrapper = mount(RunTracePanel, {
      props: {
        open: true,
        items: [
          {
            runId: 'run-multi-round',
            agentRunId: 'run-multi-round:1:codex',
            agentKind: 'codex',
            round: 1,
            status: 'completed',
            events: [],
          },
          {
            runId: 'run-multi-round',
            agentRunId: 'run-multi-round:1:hermes',
            agentKind: 'hermes',
            round: 1,
            status: 'completed',
            events: [],
          },
          {
            runId: 'run-multi-round',
            agentRunId: 'run-multi-round:2:codex',
            agentKind: 'codex',
            round: 2,
            status: 'partial',
            events: [],
          },
        ],
        selectedAgentRunId: 'run-multi-round:1:codex',
      },
    })

    expect(wrapper.get('.trace-agent-selector .trace-select-trigger strong').text()).toBe('Codex')
    await wrapper.get('.trace-agent-selector .trace-select-trigger').trigger('click')
    expect(wrapper.findAll('.trace-agent-selector .trace-select-option strong').map(item => item.text()))
      .toEqual(['Codex', 'Hermes'])
    const roundSelector = wrapper.get('.trace-round-selector')
    expect(roundSelector.get('.trace-select-label').text()).toBe('Round')
    await roundSelector.get('.trace-select-trigger').trigger('click')
    expect(roundSelector.findAll('.trace-select-option').map(option => option.text()))
      .toEqual(['Round 1Completed', 'Round 2Partially completed'])

    await roundSelector.findAll('.trace-select-option')[1].trigger('click')
    expect(wrapper.emitted('select').at(-1)).toEqual(['run-multi-round:2:codex'])
    await wrapper.setProps({ selectedAgentRunId: 'run-multi-round:2:codex' })
    expect(wrapper.get('.trace-panel-summary-heading').text()).toContain('Round 2')

    await wrapper.get('.trace-agent-selector .trace-select-trigger').trigger('click')
    const hermesOption = wrapper.findAll('.trace-agent-selector .trace-select-option')
      .find(option => option.text().includes('Hermes'))
    await hermesOption.trigger('click')
    expect(wrapper.emitted('select').at(-1)).toEqual(['run-multi-round:1:hermes'])

    setLocale('zh')
    await flushPromises()
    expect(roundSelector.get('.trace-select-label').text()).toBe('轮次')
    wrapper.unmount()
  })

  it('scrolls the conversation to the selected Agent and round message', async () => {
    HTMLElement.prototype.scrollIntoView = vi.fn()
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-trace-jump',
        conversationType: 'group',
        name: 'Trace jump',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:03:00Z',
      })
      state.messages.push(
        {
          id: 'trace-jump-root', groupId: 'group-trace-jump', role: 'user',
          content: 'Compare two rounds', targetKinds: ['codex', 'hermes'],
          createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'trace-jump-codex-one', groupId: 'group-trace-jump', role: 'agent',
          agentKind: 'codex', threadRootId: 'trace-jump-root', content: 'Codex round one',
          trace: { runId: 'trace-jump-run', agentRunId: 'trace-jump-codex-one-run', round: 1, status: 'completed', events: [] },
          createdAt: '2026-07-29T08:02:00Z',
        },
        {
          id: 'trace-jump-hermes-one', groupId: 'group-trace-jump', role: 'agent',
          agentKind: 'hermes', threadRootId: 'trace-jump-root', content: 'Hermes round one',
          trace: { runId: 'trace-jump-run', agentRunId: 'trace-jump-hermes-one-run', round: 1, status: 'completed', events: [] },
          createdAt: '2026-07-29T08:02:30Z',
        },
        {
          id: 'trace-jump-codex-two', groupId: 'group-trace-jump', role: 'agent',
          agentKind: 'codex', threadRootId: 'trace-jump-root', content: 'Codex round two',
          trace: { runId: 'trace-jump-run', agentRunId: 'trace-jump-codex-two-run', round: 2, status: 'completed', events: [] },
          createdAt: '2026-07-29T08:03:00Z',
        },
      )
    })

    await wrapper.get('.conversation-link').trigger('click')
    await wrapper.get('#message-trace-jump-codex-one .message-trace-surface').trigger('click')
    await flushPromises()

    await wrapper.get('.trace-round-selector .trace-select-trigger').trigger('click')
    await wrapper.findAll('.trace-round-selector .trace-select-option')[1].trigger('click')
    await flushPromises()
    expect(wrapper.get('#message-trace-jump-codex-two').element.scrollIntoView)
      .toHaveBeenLastCalledWith({ block: 'center', inline: 'nearest', behavior: 'smooth' })

    await wrapper.get('.trace-agent-selector .trace-select-trigger').trigger('click')
    const hermes = wrapper.findAll('.trace-agent-selector .trace-select-option')
      .find(option => option.text().includes('Hermes'))
    await hermes.trigger('click')
    await flushPromises()
    expect(wrapper.get('#message-trace-jump-hermes-one').element.scrollIntoView)
      .toHaveBeenLastCalledWith({ block: 'center', inline: 'nearest', behavior: 'smooth' })
    wrapper.unmount()
  })

  it('supports keyboard navigation and outside-click dismissal for trace dropdowns', async () => {
    const wrapper = mount(RunTracePanel, {
      attachTo: document.body,
      props: {
        open: true,
        items: [
          {
            runId: 'run-keyboard', agentRunId: 'run-keyboard:1:codex', agentKind: 'codex',
            round: 1, status: 'completed', events: [],
          },
          {
            runId: 'run-keyboard', agentRunId: 'run-keyboard:1:hermes', agentKind: 'hermes',
            round: 1, status: 'completed', events: [],
          },
        ],
        selectedAgentRunId: 'run-keyboard:1:codex',
      },
    })

    const trigger = wrapper.get('.trace-agent-selector .trace-select-trigger')
    await trigger.trigger('click')
    await flushPromises()
    const options = wrapper.findAll('.trace-agent-selector .trace-select-option')
    expect(document.activeElement).toBe(options[0].element)

    await options[0].trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(options[1].element)
    await options[1].trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(wrapper.find('.trace-agent-selector .trace-select-menu').exists()).toBe(false)
    expect(document.activeElement).toBe(trigger.element)

    await trigger.trigger('click')
    await flushPromises()
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await flushPromises()
    expect(wrapper.find('.trace-agent-selector .trace-select-menu').exists()).toBe(false)
    wrapper.unmount()
  })

  it('labels a retained manual trace as a completed response', () => {
    const wrapper = mount(RunTracePanel, {
      props: {
        open: true,
        items: [{
          runId: 'run-manual',
          agentRunId: 'run-manual:0:codex:one',
          agentKind: 'codex',
          round: 0,
          status: 'completed',
          output: 'Manual conclusion',
          events: [],
          live: false,
        }],
        selectedAgentRunId: 'run-manual:0:codex:one',
      },
    })

    expect(wrapper.get('.trace-agent-selector .trace-select-trigger small').text())
      .toBe('Response / Completed')
    wrapper.unmount()
  })

  it('keeps main V4 phase feedback aligned with Trace in both locales', async () => {
    const { wrapper, state, emitWorkspaceChanged } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-v4-phase-feedback',
        conversationType: 'group',
        name: 'V4 phase feedback',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.runningGroupIds = ['group-v4-phase-feedback']
      state.runs = [{
        runId: 'run-v4-phase-feedback',
        groupId: 'group-v4-phase-feedback',
        mode: 'auto',
        phase: 'running',
        targetKinds: ['codex', 'hermes'],
        completedKinds: [],
        failedKinds: [],
        currentKind: '',
        agentRuns: [],
        orchestration: {
          version: 4,
          template: 'discussion',
          phase: 'coordination',
          currentKinds: ['codex', 'hermes'],
          slots: [
            { agentKind: 'codex', phase: 'coordination', status: 'settled' },
            { agentKind: 'hermes', phase: 'coordination', status: 'committed' },
          ],
        },
      }]
    })

    await wrapper.get('.conversation-link').trigger('click')
    await flushPromises()

    expect(wrapper.get('.run-phase-feedback').text()).toContain('Current phase')
    expect(wrapper.get('.run-phase-feedback').text()).toContain('Responsibility alignment')
    expect(wrapper.get('.run-phase-feedback').text()).toContain('2/2 Agents')

    setLocale('zh')
    await flushPromises()
    expect(wrapper.get('.run-phase-feedback').text()).toContain('当前阶段')
    expect(wrapper.get('.run-phase-feedback').text()).toContain('职责协商')
    expect(wrapper.get('.run-phase-feedback').text()).toContain('2/2 个 Agent')

    state.runs[0].orchestration = {
      ...state.runs[0].orchestration,
      phase: 'work',
      slots: state.runs[0].orchestration.slots.map(slot => ({ ...slot, phase: 'work' })),
    }
    emitWorkspaceChanged()
    await flushPromises()
    expect(wrapper.get('.run-phase-feedback').text()).toContain('协作执行')
    expect(wrapper.get('.run-phase-feedback').text()).toContain('2/2 个 Agent')

    setLocale('en')
    await flushPromises()
    expect(wrapper.get('.run-phase-feedback').text()).toContain('Collaborative execution')
    expect(wrapper.get('.run-phase-feedback').text()).toContain('2/2 Agents')
    wrapper.unmount()
  })

  it('renders V4 phase feedback with completed slot counts', async () => {
    const wrapper = mount(RunTracePanel, {
      props: {
        open: true,
        items: [{
          runId: 'run-v4-phase',
          agentRunId: 'run-v4-phase:1:codex',
          agentKind: 'codex',
          round: 1,
          status: 'running',
          events: [],
          orchestration: {
            version: 4,
            template: 'discussion',
            phase: 'proposal',
            currentKinds: ['codex', 'hermes'],
            slots: [
              { agentKind: 'codex', phase: 'proposal', status: 'completed', role: 'integrator', attempt: 1 },
              { agentKind: 'hermes', phase: 'proposal', status: 'running', role: 'verifier', attempt: 1 },
            ],
          },
        }],
        selectedAgentRunId: 'run-v4-phase:1:codex',
      },
    })

    expect(wrapper.get('.trace-phase-feedback').text()).toContain('Current phase')
    expect(wrapper.get('.trace-phase-feedback').text()).toContain('Parallel proposals')
    expect(wrapper.get('.trace-phase-feedback').text()).toContain('1/2 Agents')
    expect(wrapper.get('.trace-phase-slot-list').text()).toContain('Codex')
    expect(wrapper.get('.trace-phase-slot-list').text()).toContain('Hermes')
    expect(wrapper.findAll('.trace-phase-slot-role').map(role => role.text()))
      .toEqual(['Integrator', 'Verifier'])

    setLocale('zh')
    await flushPromises()
    expect(wrapper.get('.trace-phase-feedback').text()).toContain('当前阶段')
    expect(wrapper.get('.trace-phase-feedback').text()).toContain('并行提案')
    expect(wrapper.get('.trace-phase-feedback').text()).toContain('1/2 个 Agent')
    expect(wrapper.findAll('.trace-phase-slot-role').map(role => role.text()))
      .toEqual(['整合者', '复核者'])
    wrapper.unmount()
  })

  it('omits unrecognized Trace role values instead of exposing internal identifiers', () => {
    const wrapper = mount(RunTracePanel, {
      props: {
        open: true,
        items: [{
          runId: 'run-v4-private-role',
          agentRunId: 'run-v4-private-role:1:codex',
          agentKind: 'codex',
          round: 1,
          status: 'running',
          events: [],
          orchestration: {
            version: 4,
            template: 'discussion',
            phase: 'work',
            currentKinds: ['codex'],
            slots: [{
              agentKind: 'codex',
              phase: 'work',
              status: 'running',
              role: 'writer:operation-private-123',
            }],
          },
        }],
        selectedAgentRunId: 'run-v4-private-role:1:codex',
      },
    })

    expect(wrapper.find('.trace-phase-slot-role').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('operation-private-123')
    wrapper.unmount()
  })

  it('provides every allowed collaboration role through the shared i18n catalog', () => {
    const roles = [
      'primary', 'reviewer', 'arbiter', 'worker', 'integrator',
      'synthesizer', 'verifier', 'writer', 'participant',
    ]

    setLocale('en')
    expect(roles.map(role => t(`run.role.${role}`))).toEqual([
      'Primary', 'Reviewer', 'Arbiter', 'Worker', 'Integrator',
      'Synthesizer', 'Verifier', 'Writer', 'Participant',
    ])

    setLocale('zh')
    expect(roles.map(role => t(`run.role.${role}`))).toEqual([
      '主提案者', '审查者', '仲裁者', '执行者', '整合者',
      '合成者', '复核者', '写入者', '参与者',
    ])
  })

  it('keeps Trace Agent roles and phase status readable in a narrow drawer', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/RunTracePanel.vue'), 'utf8')

    expect(source).toMatch(/\.trace-phase-slot-list li\s*\{[^}]*flex-wrap:\s*wrap;/s)
    expect(source).toMatch(/\.trace-phase-slot-list li > span\s*\{[^}]*min-width:\s*0;[^}]*flex:[^;]+;[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/s)
    expect(source).toMatch(/\.trace-phase-slot-list li small\s*\{[^}]*min-width:\s*0;[^}]*flex:[^;]+;[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/s)
  })

  it('renders coordination and work V4 phases with localized Trace labels', async () => {
    const item = {
      runId: 'run-v4-coordination',
      agentRunId: 'run-v4-coordination:1:codex',
      agentKind: 'codex',
      round: 1,
      status: 'running',
      events: [],
      orchestration: {
        version: 4,
        template: 'discussion',
        phase: 'coordination',
        currentKinds: ['codex'],
        slots: [{ agentKind: 'codex', phase: 'coordination', status: 'running' }],
      },
    }
    const wrapper = mount(RunTracePanel, {
      props: {
        open: true,
        items: [item],
        selectedAgentRunId: item.agentRunId,
      },
    })

    expect(wrapper.get('.trace-phase-feedback').text()).toContain('Responsibility alignment')

    setLocale('zh')
    await flushPromises()
    expect(wrapper.get('.trace-phase-feedback').text()).toContain('职责协商')

    await wrapper.setProps({
      items: [{
        ...item,
        orchestration: {
          ...item.orchestration,
          phase: 'work',
          slots: [{ agentKind: 'codex', phase: 'work', status: 'running' }],
        },
      }],
    })
    expect(wrapper.get('.trace-phase-feedback').text()).toContain('协作执行')

    setLocale('en')
    await flushPromises()
    expect(wrapper.get('.trace-phase-feedback').text()).toContain('Collaborative execution')
    wrapper.unmount()
  })

  it('labels historical trace events whose detailed input and result were not captured', async () => {
    const wrapper = mount(RunTracePanel, {
      props: {
        open: true,
        items: [{
          runId: 'run-legacy',
          agentRunId: 'run-legacy:1:codex:one',
          agentKind: 'codex',
          round: 1,
          status: 'completed',
          events: [{
            evidenceId: 'E-R1-CODEX-01',
            type: 'tool_result_summary',
            status: 'completed',
            title: 'search',
          }],
        }],
        selectedAgentRunId: 'run-legacy:1:codex:one',
      },
    })

    expect(wrapper.get('.trace-detail-unavailable').text())
      .toContain('retained tool names and statuses')
    await wrapper.get('.trace-event-list summary').trigger('click')
    expect(wrapper.get('.trace-event-detail-unavailable').text())
      .toContain('was not captured')
    wrapper.unmount()
  })

  it('shows sanitized lifecycle events while retaining answer text outside Trace', () => {
    const wrapper = mount(RunTracePanel, {
      props: {
        open: true,
        items: [{
          runId: 'run-event-visibility',
          agentRunId: 'agent-event-visibility',
          agentKind: 'hermes',
          round: 1,
          status: 'running',
          events: [
            { id: 'status-1', seq: 1, type: 'status', status: 'running', summary: 'sanitized status' },
            { id: 'reasoning-1', seq: 2, type: 'reasoning_summary', status: 'completed', summary: 'sanitized reasoning' },
            { id: 'plan-1', seq: 3, type: 'plan', status: 'completed', summary: 'sanitized plan' },
            { id: 'tool-1', seq: 4, type: 'tool_start', status: 'running', title: 'search' },
            { id: 'tool-2', seq: 5, type: 'tool_update', status: 'running', title: 'search update' },
            { id: 'tool-3', seq: 6, type: 'tool_result_summary', status: 'completed', title: 'search result' },
            { id: 'warning-1', seq: 7, type: 'warning', status: 'partial', summary: 'sanitized warning' },
            { seq: 8, type: 'answer_delta', status: 'running', delta: 'answer body token' },
          ],
        }],
        selectedAgentRunId: 'agent-event-visibility',
      },
    })

    expect(wrapper.findAll('.trace-event-list > li')).toHaveLength(7)
    expect(wrapper.get('.trace-event-list').text()).toContain('Status')
    expect(wrapper.get('.trace-event-list').text()).toContain('Reasoning summary')
    expect(wrapper.get('.trace-event-list').text()).toContain('Plan')
    expect(wrapper.get('.trace-event-list').text()).toContain('Warning')
    expect(wrapper.get('.trace-event-list').text()).not.toContain('answer body token')
    wrapper.unmount()
  })

  it('keeps an opened lifecycle disclosure mounted and announces the latest interleaved update', async () => {
    const item = events => ({
      runId: 'run-stable-event',
      agentRunId: 'agent-stable-event',
      agentKind: 'hermes',
      round: 1,
      status: events.at(-1).status,
      events,
    })
    const wrapper = mount(RunTracePanel, {
      props: {
        open: true,
        items: [item([
          { id: 'tool-stable', seq: 1, type: 'tool_start', status: 'running', title: 'search' },
          { id: 'warning-stable', seq: 2, type: 'warning', status: 'partial', title: 'rate limit' },
        ])],
        selectedAgentRunId: 'agent-stable-event',
      },
    })
    const disclosure = wrapper.findAll('.trace-event-list details')[0].element
    disclosure.open = true

    await wrapper.setProps({
      items: [item([
        {
          id: 'tool-stable', seq: 3, type: 'tool_result_summary', status: 'completed',
          title: 'search', summary: 'final sanitized summary',
        },
        { id: 'warning-stable', seq: 2, type: 'warning', status: 'partial', title: 'rate limit' },
      ])],
    })

    expect(wrapper.findAll('.trace-event-title').map(item => item.text())).toEqual(['rate limit', 'search'])
    expect(wrapper.findAll('.trace-event-list details')[1].element).toBe(disclosure)
    expect(wrapper.findAll('.trace-event-list details')[1].element.open).toBe(true)
    expect(wrapper.get('.trace-event-live-status').text())
      .toBe('Hermes / Tool result / search / Completed')
    wrapper.unmount()
  })

  it('does not force-scroll a direct stream while the user is reading above the bottom', async () => {
    const { wrapper, emitRunEvent } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'direct-scroll',
        conversationType: 'direct',
        directAgentKind: 'codex',
        name: 'Scroll protection',
        topic: '',
        agentKinds: ['codex'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.messages.push({
        id: 'scroll-root',
        groupId: 'direct-scroll',
        role: 'user',
        content: 'Read this carefully',
        createdAt: '2026-07-29T08:01:00Z',
      })
      state.runningGroupIds = ['direct-scroll']
      state.runs = [{
        runId: 'run-scroll',
        groupId: 'direct-scroll',
        threadRootId: 'scroll-root',
        targetKinds: ['codex'],
        agentRuns: [{ agentRunId: 'agent-scroll', kind: 'codex', round: 1, status: 'running', output: '', events: [] }],
      }]
    })

    await wrapper.get('.direct-session-open').trigger('click')
    await flushPromises()
    const scroller = wrapper.get('.message-scroll').element
    let scrollTop = 400
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
    emitRunEvent({
      runId: 'run-scroll', agentRunId: 'agent-scroll', groupId: 'direct-scroll',
      threadRootId: 'scroll-root', agentKind: 'codex', round: 1, seq: 1,
      type: 'answer_delta', status: 'running', delta: 'new output',
    })
    await flushPromises()

    expect(wrapper.get('.message-row.agent[data-agent-kind="codex"]').text()).toContain('new output')
    expect(scrollTop).toBe(400)
    expect(wrapper.get('.conversation-jump-to-latest').attributes('aria-label')).toBe('Jump to latest message')

    await wrapper.get('.conversation-jump-to-latest').trigger('click')
    await flushPromises()
    expect(scrollTop).toBe(1200)
    expect(wrapper.find('.conversation-jump-to-latest').exists()).toBe(false)
    wrapper.unmount()
  })

  it('marks a background direct run as finished and opens its notification target', async () => {
    const directGroup = (id, kind, name, updatedAt) => ({
      id,
      conversationType: 'direct',
      directAgentKind: kind,
      name,
      topic: '',
      agentKinds: [kind],
      workdir: '/tmp/meldwork-workspace',
      allowWrite: false,
      createdAt: '2026-07-29T08:00:00Z',
      updatedAt,
    })
    const { wrapper, emitRunFinished, emitOpenGroup } = await mountApp(({ state }) => {
      state.groups.push(
        directGroup('direct-codex', 'codex', 'Codex review', '2026-07-29T08:02:00Z'),
        directGroup('direct-hermes', 'hermes', 'Hermes review', '2026-07-29T08:01:00Z'),
      )
    })

    await wrapper.findAll('.direct-session-open')
      .find(button => button.text().includes('Codex review'))
      .trigger('click')
    emitRunFinished({ groupId: 'direct-hermes', status: 'failed' })
    emitRunFinished({ groupId: 'direct-hermes', status: 'stopped' })
    await flushPromises()
    expect(wrapper.find('.run-finished-mark').exists()).toBe(false)

    emitRunFinished({ groupId: 'direct-hermes', status: 'completed' })
    await flushPromises()

    expect(wrapper.findAll('.run-finished-mark')).toHaveLength(1)
    emitOpenGroup({ groupId: 'direct-hermes' })
    await flushPromises()

    expect(wrapper.get('.conversation-header h1').text()).toBe('Hermes review')
    expect(wrapper.find('.run-finished-mark').exists()).toBe(false)
    wrapper.unmount()
  })

  it('clears only the finished conversation run so the composer unlocks without refresh', async () => {
    const { wrapper, emitRunFinished } = await mountApp(({ state }) => {
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
          updatedAt: '2026-07-29T08:02:00Z',
        },
        {
          id: 'group-review',
          conversationType: 'group',
          name: 'Group review',
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
          id: 'direct-root',
          groupId: 'direct-codex',
          role: 'user',
          content: 'Review this directly',
          createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'group-root',
          groupId: 'group-review',
          role: 'user',
          content: 'Review this as a group',
          targetKinds: ['codex', 'hermes'],
          createdAt: '2026-07-29T08:02:00Z',
        },
      )
      state.runningGroupIds = ['direct-codex', 'group-review']
      state.runs = [
        {
          runId: 'run-direct',
          groupId: 'direct-codex',
          mode: 'manual',
          phase: 'running',
          targetKinds: ['codex'],
          completedKinds: [],
          failedKinds: [],
          currentKind: 'codex',
          currentRound: 1,
          progress: [],
          agentRuns: [{
            agentRunId: 'agent-run-direct',
            kind: 'codex',
            round: 1,
            status: 'running',
            output: 'working',
            events: [],
          }],
        },
        {
          runId: 'run-group',
          groupId: 'group-review',
          mode: 'manual',
          phase: 'running',
          threadRootId: 'group-root',
          targetKinds: ['codex', 'hermes'],
          completedKinds: [],
          failedKinds: [],
          currentKind: 'codex',
          currentRound: 1,
          progress: [],
          agentRuns: [{
            agentRunId: 'agent-run-group',
            kind: 'codex',
            round: 1,
            status: 'running',
            output: 'working',
            events: [],
          }],
        },
      ]
    })

    await wrapper.findAll('.direct-session-open')
      .find(button => button.text().includes('Codex review'))
      .trigger('click')
    expect(wrapper.find('.stop-button').exists()).toBe(true)

    emitRunFinished({
      groupId: 'direct-codex',
      status: 'completed',
    })
    await flushPromises()

    expect(wrapper.find('.stop-button').exists()).toBe(false)
    expect(wrapper.find('.send-button').exists()).toBe(true)

    await wrapper.get('.conversation-link').trigger('click')
    expect(wrapper.find('.stop-button').exists()).toBe(true)

    emitRunFinished({
      groupId: 'group-review',
      threadRootId: 'group-root',
      status: 'completed',
    })
    await flushPromises()

    expect(wrapper.find('.stop-button').exists()).toBe(false)
    expect(wrapper.find('.send-button').exists()).toBe(true)
    wrapper.unmount()
  })

  it('opens a notification target that arrives before the initial workspace snapshot', async () => {
    const initialSnapshot = deferred()
    const { wrapper, state, emitOpenGroup } = await mountApp(({ bridge }) => {
      bridge.localWorkspace.get.mockReturnValueOnce(initialSnapshot.promise)
    })
    state.groups.push({
      id: 'direct-hermes',
      conversationType: 'direct',
      directAgentKind: 'hermes',
      name: 'Hermes review',
      topic: '',
      agentKinds: ['hermes'],
      workdir: '/tmp/meldwork-workspace',
      allowWrite: false,
      createdAt: '2026-07-29T08:00:00Z',
      updatedAt: '2026-07-29T08:01:00Z',
    })

    emitOpenGroup({ groupId: 'direct-hermes' })
    initialSnapshot.resolve(structuredClone(state))
    await flushPromises()

    expect(wrapper.get('.conversation-header h1').text()).toBe('Hermes review')
    wrapper.unmount()
  })

  it('keeps a direct completion event that arrives before the initial workspace snapshot', async () => {
    const initialSnapshot = deferred()
    const { wrapper, state, emitRunFinished } = await mountApp(({ bridge }) => {
      bridge.localWorkspace.get.mockReturnValueOnce(initialSnapshot.promise)
    })
    state.groups.push({
      id: 'direct-hermes',
      conversationType: 'direct',
      directAgentKind: 'hermes',
      name: 'Hermes review',
      topic: '',
      agentKinds: ['hermes'],
      workdir: '/tmp/meldwork-workspace',
      allowWrite: false,
      createdAt: '2026-07-29T08:00:00Z',
      updatedAt: '2026-07-29T08:01:00Z',
    })

    emitRunFinished({ groupId: 'direct-hermes', status: 'completed' })
    initialSnapshot.resolve(structuredClone(state))
    await flushPromises()

    expect(wrapper.findAll('.run-finished-mark')).toHaveLength(1)
    wrapper.unmount()
  })

  it('keeps multiple turn completions for one group before the initial workspace snapshot', async () => {
    const initialSnapshot = deferred()
    const { wrapper, state, emitRunFinished } = await mountApp(({ bridge }) => {
      bridge.localWorkspace.get.mockReturnValueOnce(initialSnapshot.promise)
    })
    state.groups.push({
      id: 'group-pending-runs',
      conversationType: 'group',
      name: 'Pending runs',
      topic: '',
      agentKinds: ['codex', 'hermes'],
      workdir: '/tmp/meldwork-workspace',
      allowWrite: false,
      createdAt: '2026-07-29T08:00:00Z',
      updatedAt: '2026-07-29T08:02:00Z',
    })
    state.messages.push(
      {
        id: 'pending-root-1',
        groupId: 'group-pending-runs',
        role: 'user',
        content: 'First task',
        createdAt: '2026-07-29T08:01:00Z',
      },
      {
        id: 'pending-root-2',
        groupId: 'group-pending-runs',
        role: 'user',
        content: 'Second task',
        createdAt: '2026-07-29T08:02:00Z',
      },
    )

    emitRunFinished({
      groupId: 'group-pending-runs',
      runId: 'pending-run-1',
      threadRootId: 'pending-root-1',
      status: 'completed',
    })
    emitRunFinished({
      groupId: 'group-pending-runs',
      runId: 'pending-run-2',
      threadRootId: 'pending-root-2',
      status: 'failed',
    })
    initialSnapshot.resolve(structuredClone(state))
    await flushPromises()

    await wrapper.get('.conversation-link').trigger('click')
    const turns = wrapper.findAll('.turn-rail button')
    expect(turns).toHaveLength(2)
    expect(turns.map(turn => turn.attributes('data-status'))).toEqual(['completed', 'failed'])
    wrapper.unmount()
  })
})

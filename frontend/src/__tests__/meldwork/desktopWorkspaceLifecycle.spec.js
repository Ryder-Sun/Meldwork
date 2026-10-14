import { flushPromises, mount } from '@vue/test-utils'
import { h, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDesktopWorkspaceLifecycle } from '../../composables/useDesktopWorkspaceLifecycle.js'

function snapshot() {
  return { agents: [], groups: [], messages: [], runningGroupIds: [], runs: [] }
}

function mountLifecycle(overrides = {}) {
  const unsubscribers = Array.from({ length: 5 }, () => vi.fn())
  const workspaceApi = {
    defaultDirectory: vi.fn(async () => '/tmp/workspace'),
    get: vi.fn(async () => snapshot()),
    onChanged: vi.fn(() => unsubscribers[0]),
    onOpenGroup: vi.fn(() => unsubscribers[1]),
    onRunEvent: vi.fn(() => unsubscribers[2]),
    onRunFinished: vi.fn(() => unsubscribers[3]),
    ...overrides.workspace,
  }
  const installerApi = {
    onChanged: vi.fn(() => unsubscribers[4]),
    state: vi.fn(async () => ({ phase: 'idle' })),
    ...overrides.installer,
  }
  const dependencies = {
    afterInitialLoad: vi.fn(),
    beforeBoot: vi.fn(),
    defaultDirectory: ref(''),
    handleOpenGroup: vi.fn(),
    handleRunFinished: vi.fn(),
    installer: ref(installerApi),
    installerState: ref({ phase: 'loading' }),
    refreshAgents: vi.fn(async () => {}),
    showError: vi.fn(),
    snapshot: ref(snapshot()),
    workspace: ref(workspaceApi),
    ...overrides.dependencies,
  }
  let lifecycle
  const wrapper = mount({
    setup() {
      lifecycle = useDesktopWorkspaceLifecycle(dependencies)
      return () => h('div')
    },
  })
  return { dependencies, installerApi, lifecycle, unsubscribers, workspaceApi, wrapper }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('desktop workspace lifecycle', () => {
  it('subscribes before reading initial state and releases every listener', async () => {
    const fixture = mountLifecycle()

    expect(fixture.workspaceApi.onChanged.mock.invocationCallOrder[0])
      .toBeLessThan(fixture.workspaceApi.get.mock.invocationCallOrder[0])
    await flushPromises()

    expect(fixture.lifecycle.booting.value).toBe(false)
    expect(fixture.dependencies.defaultDirectory.value).toBe('/tmp/workspace')
    expect(fixture.dependencies.installerState.value).toEqual({ phase: 'idle' })
    expect(fixture.dependencies.afterInitialLoad).toHaveBeenCalledTimes(1)

    fixture.wrapper.unmount()
    for (const unsubscribe of fixture.unsubscribers) {
      expect(unsubscribe).toHaveBeenCalledTimes(1)
    }
  })

  it('finishes boot with the desktop-required state when the bridge is missing', async () => {
    const fixture = mountLifecycle({
      dependencies: {
        installer: ref(null),
        workspace: ref(null),
      },
    })
    await flushPromises()

    expect(fixture.lifecycle.booting.value).toBe(false)
    expect(fixture.lifecycle.bridgeMissing.value).toBe(true)
    expect(fixture.dependencies.afterInitialLoad).not.toHaveBeenCalled()
    fixture.wrapper.unmount()
  })

  it('does not render an event without provenance when the initial workspace read fails', async () => {
    let emitRunEvent = null
    let rejectInitialRead = null
    const initialRead = new Promise((_, reject) => {
      rejectInitialRead = reject
    })
    const fixture = mountLifecycle({
      workspace: {
        get: vi.fn(() => initialRead),
        onRunEvent: vi.fn((callback) => {
          emitRunEvent = callback
          return vi.fn()
        }),
      },
    })

    emitRunEvent({
      runId: 'run-before-snapshot',
      agentRunId: 'agent-before-snapshot',
      groupId: 'group-1',
      agentKind: 'codex',
      round: 1,
      seq: 1,
      type: 'answer_delta',
      delta: 'Untrusted live output',
    })
    expect(fixture.dependencies.snapshot.value).toEqual(snapshot())

    rejectInitialRead(new Error('initial read failed'))
    await flushPromises()

    expect(fixture.dependencies.snapshot.value).toEqual(snapshot())
    expect(fixture.lifecycle.booting.value).toBe(false)
    fixture.wrapper.unmount()
  })

  it('refreshes local Agents when the desktop regains focus after an external install window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-19T08:00:00Z'))
    const fixture = mountLifecycle()
    await flushPromises()

    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    expect(fixture.dependencies.refreshAgents).not.toHaveBeenCalled()

    vi.setSystemTime(new Date('2026-08-19T08:00:31Z'))
    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    expect(fixture.dependencies.refreshAgents).toHaveBeenCalledTimes(1)

    fixture.wrapper.unmount()
    vi.setSystemTime(new Date('2026-08-19T08:01:02Z'))
    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    expect(fixture.dependencies.refreshAgents).toHaveBeenCalledTimes(1)
  })
})

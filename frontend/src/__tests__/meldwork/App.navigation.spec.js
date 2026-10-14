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
  it('groups direct sessions under visible Agents and keeps local session actions explicit', async () => {
    const existing = {
      id: 'direct-codex-1',
      conversationType: 'direct',
      directAgentKind: 'codex',
      name: 'Earlier Codex conversation with a longer sidebar title',
      topic: '',
      agentKinds: ['codex'],
      workdir: '/tmp/meldwork-workspace',
      allowWrite: false,
      createdAt: '2026-07-29T08:00:00Z',
      updatedAt: '2026-07-29T08:00:00Z',
    }
    const latest = {
      ...existing,
      id: 'direct-codex-latest',
      name: 'Recent Codex conversation',
      createdAt: '2026-07-29T07:00:00Z',
      updatedAt: '2026-07-29T08:30:00Z',
    }
    const { wrapper, bridge } = await mountApp(({ state, bridge: desktopBridge }) => {
      state.agents[1].showInSidebar = false
      desktopBridge.agentInstaller.catalog.mockResolvedValue({ platform: 'darwin', agents: state.agents })
      state.groups.push(existing, latest)
      desktopBridge.agentInstaller.skills.mockImplementation(async kind => ({
        supported: true,
        total: kind === 'codex' ? 12 : 0,
        skills: [],
      }))
      desktopBridge.localWorkspace.createGroup.mockImplementation(async (input) => {
        const group = {
          id: 'direct-codex-2',
          createdAt: '2026-07-29T09:00:00Z',
          updatedAt: '2026-07-29T09:00:00Z',
          ...structuredClone(input),
        }
        state.groups.push(group)
        return structuredClone(group)
      })
      desktopBridge.localWorkspace.get.mockImplementation(async () => structuredClone(state))
    })

    expect(wrapper.findAll('.sidebar-agent')).toHaveLength(1)
    expect(wrapper.get('.sidebar-agent-main').text()).toContain('Codex')
    await wrapper.get('.sidebar-settings-entry').trigger('click')
    expect(wrapper.get('.agent-card .agent-capability-list').text()).toContain('12 local skills')
    expect(wrapper.get('.agent-card .agent-capability-list').text()).toContain('Up to 4 images')

    await wrapper.get('.sidebar-agent-new').trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.createGroup).toHaveBeenCalledWith(expect.objectContaining({
      conversationType: 'direct',
      directAgentKind: 'codex',
      name: 'Codex chat 3',
      allowWrite: true,
    }))
    expect(wrapper.findAll('.direct-session-row')).toHaveLength(3)
    await wrapper.get('.sidebar-agent-main').trigger('click')
    expect(wrapper.findAll('.direct-session-row')).toHaveLength(0)
    await wrapper.get('.sidebar-agent-main').trigger('click')
    const sessions = wrapper.findAll('.direct-session-row')
    expect(sessions).toHaveLength(3)
    expect(sessions[0].get('.direct-session-open span').text()).toBe('Codex chat 3')
    expect(sessions[1].get('.direct-session-open span').text()).toBe('Recent Codex conversation')
    expect(sessions[1].find('.direct-session-open time').exists()).toBe(false)

    await sessions[0].findAll('.direct-session-action')[0].trigger('click')
    expect(wrapper.get('#modal-title').text()).toBe('Rename direct chat')
    const nameInput = wrapper.get('form.form-stack input:not([type="checkbox"])')
    await nameInput.setValue('Code audit')
    await wrapper.get('form.form-stack').trigger('submit')
    await flushPromises()
    expect(bridge.localWorkspace.updateGroup).toHaveBeenCalledWith(
      'direct-codex-2',
      expect.objectContaining({ name: 'Code audit' }),
    )

    await wrapper.findAll('.direct-session-row')[2].findAll('.direct-session-action')[1].trigger('click')
    expect(wrapper.find('.modal.medium').exists()).toBe(false)
    let sidebarDeletePopover = document.body.querySelector('.sidebar-delete-popover')
    expect(sidebarDeletePopover.textContent).toContain('Delete this conversation?')
    expect(sidebarDeletePopover.textContent).toContain('Native CLI sessions are not deleted')
    expect(sidebarDeletePopover.querySelector('.danger-button').textContent).toContain('Confirm delete')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(document.body.querySelector('.sidebar-delete-popover')).toBeNull()
    await wrapper.findAll('.direct-session-row')[2].findAll('.direct-session-action')[1].trigger('click')
    sidebarDeletePopover = document.body.querySelector('.sidebar-delete-popover')
    sidebarDeletePopover.querySelector('.danger-button').click()
    await flushPromises()
    expect(bridge.localWorkspace.deleteGroup).toHaveBeenCalledWith('direct-codex-1')
    wrapper.unmount()
  })

  it('keeps sidebar session trees visible and collapses long lists behind More', async () => {
    const source = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    expect(source).toMatch(/\.direct-session-list::before/)
    expect(source).toMatch(/\.direct-session-list > \.sidebar-more-button::before/)
    expect(source).toMatch(/--session-tree-line:\s*color-mix\(in srgb,\s*var\(--border\)\s*78%,\s*transparent\);/)
    expect(source).toMatch(/\.direct-session-list::before\s*\{[^}]*border-left:\s*1px solid var\(--session-tree-line\);[^}]*border-bottom-left-radius:\s*7px;/s)
    expect(source).toMatch(/\.direct-session-list > :last-child::before\s*\{[^}]*content:\s*none;/s)
    expect(source).toMatch(/\.direct-session-row\.active\s*\{[^}]*border-color:\s*transparent;[^}]*background:\s*var\(--surface-active\);/s)
    expect(source).toMatch(/\.direct-session-row\.active \.direct-session-open\s*\{[^}]*font-weight:\s*600;/s)
    expect(source).toMatch(/\.direct-session-row\.active::after\s*\{[^}]*background:\s*var\(--accent\);/s)
    expect(source).toMatch(/\.direct-session-action:hover\s*\{[^}]*background:\s*var\(--surface-hover\);/s)
    expect(source).not.toMatch(/\.direct-session-action:hover\s*\{[^}]*border-color:/s)
    expect(source).not.toMatch(/\.direct-session-action\.danger:hover\s*\{[^}]*border-color:/s)
    expect(source).toMatch(/\.sidebar-delete-popover\s*\{[^}]*position:\s*fixed;[^}]*border:\s*0;[^}]*transform:\s*translateY\(calc\(-100% \+ 18px\)\);/s)
    expect(source).toMatch(/\.sidebar-delete-popover::after\s*\{[^}]*border:\s*0;/s)
    expect(source).not.toMatch(/\.group-conversation-list::before/)
    expect(source).not.toMatch(/\.group-conversation-row::before/)

    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push(
        ...Array.from({ length: 6 }, (_, index) => ({
          id: `direct-codex-${index + 1}`,
          conversationType: 'direct',
          directAgentKind: 'codex',
          name: `Codex ${index + 1}`,
          topic: '',
          agentKinds: ['codex'],
          workdir: '/tmp/meldwork-workspace',
          allowWrite: false,
          createdAt: `2026-07-29T08:${String(index).padStart(2, '0')}:00Z`,
          updatedAt: `2026-07-29T09:${String(59 - index).padStart(2, '0')}:00Z`,
        })),
      )
      state.groups.push(
        ...Array.from({ length: 9 }, (_, index) => ({
          id: `group-sidebar-${index + 1}`,
          conversationType: 'group',
          name: `Group ${index + 1}`,
          topic: '',
          agentKinds: ['codex', 'hermes'],
          workdir: '/tmp/meldwork-workspace',
          allowWrite: false,
          createdAt: `2026-07-29T10:${String(index).padStart(2, '0')}:00Z`,
          updatedAt: `2026-07-29T11:${String(59 - index).padStart(2, '0')}:00Z`,
        })),
      )
    })

    const codexAgent = wrapper.findAll('.sidebar-agent').find(node => node.text().includes('Codex'))
    expect(codexAgent).toBeTruthy()
    expect(codexAgent.get('.direct-session-list').classes()).toContain('direct-session-list')
    expect(codexAgent.findAll('.direct-session-row')).toHaveLength(5)

    const directMore = codexAgent.get('.sidebar-more-button')
    expect(directMore.text()).toBe('More')
    expect(directMore.attributes('aria-expanded')).toBe('false')
    await directMore.trigger('click')
    expect(codexAgent.findAll('.direct-session-row')).toHaveLength(6)
    expect(codexAgent.get('.sidebar-more-button').text()).toBe('Less')
    expect(codexAgent.get('.sidebar-more-button').attributes('aria-expanded')).toBe('true')

    const groupList = wrapper.get('.group-conversation-list')
    expect(groupList.classes()).not.toContain('direct-session-list')
    expect(groupList.findAll('.direct-session-row')).toHaveLength(0)
    expect(groupList.findAll('.group-conversation-row')).toHaveLength(8)
    const groupMore = groupList.get('.sidebar-more-button')
    expect(groupMore.text()).toBe('More')
    expect(groupMore.attributes('aria-expanded')).toBe('false')
    await groupMore.trigger('click')
    expect(groupList.findAll('.group-conversation-row')).toHaveLength(9)
    expect(groupList.get('.sidebar-more-button').text()).toBe('Less')
    expect(groupList.get('.sidebar-more-button').attributes('aria-expanded')).toBe('true')

    wrapper.unmount()
  })

  it('keeps group icons transparent and exposes safe sidebar rename and delete actions', async () => {
    const source = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    expect(source).toMatch(/\.group-avatar\s*\{[^}]*background:\s*transparent;/s)
    expect(source).toMatch(/\.group-conversation-row:hover \.group-conversation-actions/)
    expect(source).toMatch(/\.group-conversation-row:hover \.direct-session-action,\s*\.group-conversation-row:focus-within \.direct-session-action/s)

    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-sidebar-actions',
        conversationType: 'group',
        name: 'Market research',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    const row = wrapper.get('.group-conversation-row')
    const actions = row.findAll('.direct-session-action')
    expect(actions).toHaveLength(2)
    expect(actions[0].attributes('aria-label')).toBe('Rename group Market research')
    expect(actions[1].attributes('aria-label')).toBe('Delete group Market research')

    await actions[0].trigger('click')
    expect(wrapper.get('#modal-title').text()).toBe('Rename group chat')
    await wrapper.get('form.form-stack input:not([type="checkbox"])').setValue('GEO research')
    await wrapper.get('form.form-stack').trigger('submit')
    await flushPromises()
    expect(bridge.localWorkspace.updateGroup).toHaveBeenCalledWith(
      'group-sidebar-actions',
      expect.objectContaining({ name: 'GEO research' }),
    )

    await wrapper.get('.group-conversation-row .direct-session-action.danger').trigger('click')
    expect(wrapper.find('.modal.medium').exists()).toBe(false)
    const sidebarDeletePopover = document.body.querySelector('.sidebar-delete-popover')
    expect(sidebarDeletePopover.querySelector('.danger-button').textContent).toContain('Confirm delete')
    sidebarDeletePopover.querySelector('.danger-button').click()
    await flushPromises()
    expect(bridge.localWorkspace.deleteGroup).toHaveBeenCalledWith('group-sidebar-actions')
    wrapper.unmount()
  })

  it('dismisses only the known plan warning for the component lifetime and closes the global toast', async () => {
    const { wrapper, bridge, emitWorkspaceChanged } = await mountApp(({ state, bridge: desktopBridge }) => {
      state.groups.push({
        id: 'direct-codex',
        conversationType: 'direct',
        directAgentKind: 'codex',
        name: 'Codex',
        topic: '',
        agentKinds: ['codex'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.messages.push(
        {
          id: 'plan-warning',
          groupId: 'direct-codex',
          role: 'system',
          content: '  error: Cannot combine --prompt with --plan.\n',
          createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'combined-warning',
          groupId: 'direct-codex',
          role: 'system',
          content: 'error: Cannot combine --prompt with --plan.\nAdditional diagnostic detail',
          createdAt: '2026-07-29T08:01:30Z',
        },
        {
          id: 'other-warning',
          groupId: 'direct-codex',
          role: 'system',
          content: 'Another warning',
          createdAt: '2026-07-29T08:02:00Z',
        },
      )
      desktopBridge.localAttachments.pickAttachments.mockRejectedValueOnce(new Error('LOCAL_ATTACHMENT_INPUT_INVALID'))
    })

    await wrapper.get('.direct-session-open').trigger('click')
    expect(wrapper.findAll('.message-dismiss-button')).toHaveLength(1)
    await wrapper.get('.message-dismiss-button').trigger('click')
    expect(wrapper.find('#message-plan-warning').exists()).toBe(false)
    expect(wrapper.get('#message-combined-warning').text()).toContain('Additional diagnostic detail')
    expect(wrapper.get('#message-other-warning').text()).toContain('Another warning')

    emitWorkspaceChanged()
    await flushPromises()
    expect(wrapper.find('#message-plan-warning').exists()).toBe(false)
    expect(wrapper.findAll('.message-dismiss-button')).toHaveLength(0)

    await wrapper.get('[aria-label="Attach files"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('.toast-message').attributes('role')).toBe('status')
    expect(wrapper.get('.toast-dismiss-button').attributes('aria-label')).toBe('Dismiss')
    await wrapper.get('.toast-dismiss-button').trigger('click')
    expect(wrapper.find('.toast-message').exists()).toBe(false)
    expect(bridge.localAttachments.pickAttachments).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})

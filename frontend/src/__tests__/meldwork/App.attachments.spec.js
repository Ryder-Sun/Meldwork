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
  it('imports a pasted image and sends safe attachment metadata without text', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
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
    })

    await wrapper.get('.direct-session-open').trigger('click')
    const imageFile = {
      name: 'diagram.png',
      type: 'image/png',
      size: 3,
      arrayBuffer: vi.fn(async () => Uint8Array.from([1, 2, 3]).buffer),
    }
    await wrapper.get('.composer-box textarea').trigger('paste', {
      clipboardData: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => imageFile }],
      },
    })
    await flushPromises()

    expect(bridge.localAttachments.importAttachment).toHaveBeenCalledWith({
      name: 'diagram.png',
      mimeType: 'image/png',
      bytes: Uint8Array.from([1, 2, 3]),
    })
    expect(wrapper.get('.composer-attachment img').attributes('src')).toBe('data:image/png;base64,AQID')
    expect(wrapper.get('.composer-attachment').classes()).toContain('is-image')
    expect(wrapper.get('.composer-attachment').text()).toBe('')
    expect(wrapper.get('.send-button').attributes()).not.toHaveProperty('disabled')

    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(bridge.localWorkspace.send).toHaveBeenCalledWith({
      groupId: 'direct-codex',
      text: '',
      targetKinds: ['codex'],
      skillHints: [],
      knowledgeBaseHints: [],
      attachments: [{ id: 'attachment-1', name: 'diagram.png', mimeType: 'image/png', size: 3 }],
      mode: 'manual',
      maxRounds: 6,
    })
    wrapper.unmount()
  })

  it('imports Finder-style files dropped onto an unavailable direct-chat Agent', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.agents.find(agent => agent.kind === 'codex').available = false
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
    })
    await wrapper.get('.direct-session-open').trigger('click')
    const pdf = {
      name: 'report.pdf',
      type: '',
      size: 9,
      lastModified: 1,
      arrayBuffer: vi.fn(async () => Uint8Array.from([37, 80, 68, 70, 45, 49, 46, 55, 10]).buffer),
    }
    const markdown = {
      name: 'notes.md',
      type: 'text/markdown',
      size: 8,
      lastModified: 2,
      arrayBuffer: vi.fn(async () => new TextEncoder().encode('# Notes\n').buffer),
    }
    const html = {
      name: 'preview.html',
      type: 'text/html',
      size: 16,
      lastModified: 3,
      arrayBuffer: vi.fn(async () => new TextEncoder().encode('<h1>Preview</h1>').buffer),
    }
    const dataTransfer = {
      types: ['public.file-url'],
      files: [],
      items: [pdf, markdown, html].map(file => ({ kind: 'file', getAsFile: () => file })),
      dropEffect: 'none',
    }
    const composer = wrapper.get('.composer-box')

    await composer.trigger('dragenter', { dataTransfer })
    expect(wrapper.get('.composer-drop-overlay').text()).toContain('Add these files')
    await composer.trigger('drop', { dataTransfer })
    await flushPromises()

    expect(bridge.localAttachments.importAttachment.mock.calls.map(([input]) => ({
      name: input.name,
      mimeType: input.mimeType,
      bytes: Array.from(input.bytes),
    }))).toEqual([
      {
        name: 'report.pdf',
        mimeType: 'application/pdf',
        bytes: [37, 80, 68, 70, 45, 49, 46, 55, 10],
      },
      {
        name: 'notes.md',
        mimeType: 'text/markdown',
        bytes: Array.from(new TextEncoder().encode('# Notes\n')),
      },
      {
        name: 'preview.html',
        mimeType: 'text/plain',
        bytes: Array.from(new TextEncoder().encode('<h1>Preview</h1>')),
      },
    ])
    expect(wrapper.findAll('.composer-attachment strong').map(item => item.text())).toEqual([
      'report.pdf', 'notes.md', 'preview.html',
    ])
    expect(wrapper.findAll('.composer-attachment small').map(item => item.text())).toEqual([
      'PDF', 'MD', 'HTML',
    ])
    expect(wrapper.find('.composer-drop-overlay').exists()).toBe(false)
    expect(wrapper.find('.toast-message').exists()).toBe(false)
    wrapper.unmount()
  })

  it('imports a dropped image through generic file support in a group conversation', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-file-fallback',
        conversationType: 'group',
        name: 'Image review',
        topic: '',
        agentKinds: ['codex', 'workbuddy'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })
    await wrapper.get('.conversation-link').trigger('click')
    const file = {
      name: 'diagram.png',
      type: 'image/png',
      size: 7,
      lastModified: 1,
      arrayBuffer: vi.fn(async () => Uint8Array.from([1, 2, 3, 4, 5, 6, 7]).buffer),
    }
    const dataTransfer = { types: ['Files'], files: [file], dropEffect: 'none' }

    await wrapper.get('.composer-box').trigger('drop', { dataTransfer })
    await flushPromises()

    expect(bridge.localAttachments.importAttachment).toHaveBeenCalledWith(expect.objectContaining({
      name: 'diagram.png',
      mimeType: 'image/png',
    }))
    expect(wrapper.get('.composer-attachment').text()).toBe('')
    expect(wrapper.get('.composer-attachment').classes()).toContain('is-image')
    expect(wrapper.find('.toast-message').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps group attachment picking and Finder drops available with an offline member', async () => {
    const picked = [{
      id: 'picked-document', name: 'plan.pdf', mimeType: 'application/pdf', size: 12,
    }]
    const { wrapper, bridge } = await mountApp(({ state, bridge: desktopBridge }) => {
      state.agents.find(agent => agent.kind === 'hermes').available = false
      state.groups.push({
        id: 'group-offline-member',
        conversationType: 'group',
        name: 'Offline member group',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      desktopBridge.localAttachments.pickAttachments.mockResolvedValueOnce({ attachments: picked })
    })
    await wrapper.get('.conversation-link').trigger('click')
    await wrapper.get('[data-mode="auto"]').trigger('click')
    await wrapper.get('[aria-label="Attach files"]').trigger('click')
    await flushPromises()

    expect(bridge.localAttachments.pickAttachments).toHaveBeenCalledWith(32)
    expect(wrapper.get('.composer-attachment').text()).toContain('plan.pdf')
    expect(wrapper.find('.toast-message').exists()).toBe(false)

    await wrapper.get('[aria-label="Remove attachment"]').trigger('click')
    await flushPromises()
    const file = {
      name: 'group-notes.md',
      type: 'text/markdown',
      size: 14,
      lastModified: 3,
      arrayBuffer: vi.fn(async () => new TextEncoder().encode('# Group notes\n').buffer),
    }
    const dataTransfer = {
      types: [],
      files: [],
      items: [{ kind: 'file', getAsFile: () => file }],
      dropEffect: 'none',
    }
    await wrapper.get('.composer-box').trigger('drop', { dataTransfer })
    await flushPromises()

    expect(bridge.localAttachments.importAttachment).toHaveBeenCalledWith(expect.objectContaining({
      name: 'group-notes.md',
      mimeType: 'text/markdown',
    }))
    expect(wrapper.get('.composer-attachment').text()).toContain('group-notes.md')
    expect(wrapper.find('.toast-message').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps an all-failed accepted image message out of the composer', async () => {
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
      desktopBridge.localWorkspace.send.mockImplementation(async (input) => {
        state.messages.push(
          {
            id: 'failed-user-message',
            groupId: input.groupId,
            role: 'user',
            agentKind: '',
            content: input.text,
            attachments: structuredClone(input.attachments),
            createdAt: '2026-07-29T08:01:00Z',
          },
          {
            id: 'failed-system-message',
            groupId: input.groupId,
            role: 'system',
            agentKind: '',
            content: 'Codex failed: process failed',
            createdAt: '2026-07-29T08:01:01Z',
          },
        )
        return structuredClone(state)
      })
    })

    await wrapper.get('.direct-session-open').trigger('click')
    const imageFile = {
      name: 'failure.png',
      type: 'image/png',
      size: 3,
      arrayBuffer: vi.fn(async () => Uint8Array.from([1, 2, 3]).buffer),
    }
    await wrapper.get('.composer-box textarea').trigger('paste', {
      clipboardData: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => imageFile }],
      },
    })
    await flushPromises()
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()

    expect(wrapper.get('.composer-box textarea').element.value).toBe('')
    expect(wrapper.find('.composer-attachment').exists()).toBe(false)
    expect(wrapper.findAll('.message-row.user')).toHaveLength(1)
    expect(wrapper.findAll('.message-attachment-grid')).toHaveLength(1)
    expect(bridge.localAttachments.discard).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('rejects an oversized pasted media file before reading its bytes', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0))
    const { wrapper, bridge } = await mountApp(({ state }) => {
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
    })

    await wrapper.get('.direct-session-open').trigger('click')
    await wrapper.get('.composer-box textarea').trigger('paste', {
      clipboardData: {
        items: [{
          kind: 'file',
          type: 'image/png',
          getAsFile: () => ({
            name: 'large.png',
            type: 'image/png',
            size: (128 * 1024 * 1024) + 1,
            arrayBuffer,
          }),
        }],
      },
    })
    await flushPromises()

    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(bridge.localAttachments.importAttachment).not.toHaveBeenCalled()
    expect(wrapper.get('.toast-message').text()).toContain('too large')
    wrapper.unmount()
  })

  it('reloads Skill counts when Agent kinds are unchanged after manual refresh', async () => {
    let total = 1
    const { wrapper, bridge } = await mountApp(({ bridge: desktopBridge }) => {
      desktopBridge.agentInstaller.skills.mockImplementation(async () => ({
        supported: true,
        total,
        skills: [],
      }))
    })
    bridge.agentInstaller.skills.mockClear()
    total = 3

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    const refresh = wrapper.findAll('.manager-toolbar-actions button')
      .find(button => button.text().includes('Refresh catalog'))
    await refresh.trigger('click')
    await flushPromises()

    expect(bridge.agentInstaller.skills.mock.calls.map(([kind]) => kind).sort()).toEqual(['codex', 'hermes'])
    for (const card of wrapper.findAll('.agent-card')
      .filter(node => ['Codex', 'Hermes'].some(label => node.text().includes(label)))) {
      expect(card.find('.agent-capability-list').exists()).toBe(false)
    }
    wrapper.unmount()
  })

  it('discards an unsent image when the user removes it', async () => {
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
      desktopBridge.localAttachments.pickAttachments.mockResolvedValueOnce({
        attachments: [imageAttachment('remove-me')],
      })
    })

    await wrapper.get('.direct-session-open').trigger('click')
    await wrapper.get('[aria-label="Attach files"]').trigger('click')
    await flushPromises()
    await wrapper.get('[aria-label="Remove attachment"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('.composer-attachment').exists()).toBe(false)
    expect(bridge.localAttachments.discard).toHaveBeenCalledWith(['remove-me'])
    wrapper.unmount()
  })

  it('keeps attachment picking available beyond four files and reports the remaining safe capacity', async () => {
    const firstPick = [imageAttachment('picked-1')]
    const secondPick = Array.from({ length: 4 }, (_, index) => imageAttachment(`picked-${index + 2}`))
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
      desktopBridge.localAttachments.pickAttachments
        .mockResolvedValueOnce({ attachments: firstPick, truncated: false })
        .mockResolvedValueOnce({ attachments: secondPick, truncated: false })
    })

    await wrapper.get('.direct-session-open').trigger('click')
    await wrapper.get('[aria-label="Attach files"]').trigger('click')
    await flushPromises()
    await wrapper.get('[aria-label="Attach files"]').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('.composer-attachment')).toHaveLength(5)
    expect(bridge.localAttachments.pickAttachments.mock.calls).toEqual([[32], [31]])
    expect(bridge.localAttachments.discard).not.toHaveBeenCalled()
    expect(wrapper.find('.toast-message').exists()).toBe(false)
    wrapper.unmount()
  })

  it('falls back to generic files beyond an Agent native image limit', async () => {
    const picked = [imageAttachment('hermes-1')]
    const { wrapper, bridge } = await mountApp(({ state, bridge: desktopBridge }) => {
      state.groups.push({
        id: 'direct-hermes',
        conversationType: 'direct',
        directAgentKind: 'hermes',
        name: 'Hermes',
        agentKinds: ['hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      desktopBridge.localAttachments.pickAttachments.mockResolvedValueOnce({
        attachments: picked,
        truncated: false,
      })
    })

    await wrapper.get('.direct-session-open').trigger('click')
    await wrapper.get('[aria-label="Attach files"]').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('.composer-attachment')).toHaveLength(1)
    expect(bridge.localAttachments.pickAttachments).toHaveBeenCalledWith(32)
    expect(bridge.localAttachments.discard).not.toHaveBeenCalled()
    expect(wrapper.get('[aria-label="Attach files"]').attributes()).not.toHaveProperty('disabled')

    await wrapper.get('.composer-box textarea').trigger('paste', {
      clipboardData: {
        items: [{
          kind: 'file',
          type: 'image/png',
          getAsFile: () => ({
            name: 'overflow.png',
            type: 'image/png',
            arrayBuffer: vi.fn(async () => Uint8Array.from([1]).buffer),
          }),
        }],
      },
    })
    await flushPromises()

    expect(bridge.localAttachments.importAttachment).toHaveBeenCalledWith(expect.objectContaining({
      name: 'overflow.png',
      mimeType: 'image/png',
    }))
    expect(wrapper.findAll('.composer-attachment')).toHaveLength(2)
    expect(wrapper.find('.toast-message').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps the attachment action clickable when support is unavailable', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.agents.push({
        kind: 'opencodereview',
        installed: true,
        available: true,
        credentialState: 'ready',
        version: '1.0.0',
      })
      state.groups.push({
        id: 'direct-opencodereview',
        conversationType: 'direct',
        directAgentKind: 'opencodereview',
        name: 'OpenCodeReview',
        agentKinds: ['opencodereview'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    await wrapper.get('.direct-session-open').trigger('click')
    const attachmentButton = wrapper.get('.composer-attachment-button')
    expect(attachmentButton.attributes()).not.toHaveProperty('disabled')
    await attachmentButton.trigger('click')
    await flushPromises()

    expect(bridge.localAttachments.pickAttachments).not.toHaveBeenCalled()
    expect(wrapper.get('.toast-message').text()).toContain('does not support attachments')
    wrapper.unmount()
  })

  it('discards unsent draft images when switching conversations', async () => {
    const { wrapper, bridge } = await mountApp(({ state, bridge: desktopBridge }) => {
      state.groups.push(
        {
          id: 'group-alpha',
          conversationType: 'group',
          name: 'Alpha review',
          topic: '',
          agentKinds: ['codex', 'hermes'],
          workdir: '/tmp/meldwork-workspace',
          allowWrite: false,
          createdAt: '2026-07-29T08:00:00Z',
          updatedAt: '2026-07-29T08:02:00Z',
        },
        {
          id: 'group-beta',
          conversationType: 'group',
          name: 'Beta review',
          topic: '',
          agentKinds: ['codex', 'hermes'],
          workdir: '/tmp/meldwork-workspace',
          allowWrite: false,
          createdAt: '2026-07-29T08:00:00Z',
          updatedAt: '2026-07-29T08:01:00Z',
        },
      )
      desktopBridge.localAttachments.pickAttachments.mockResolvedValueOnce({
        attachments: [imageAttachment('alpha-draft')],
      })
    })

    const links = wrapper.findAll('.conversation-link')
    const alphaLink = links.find(link => link.text().includes('Alpha review'))
    const betaLink = links.find(link => link.text().includes('Beta review'))
    await alphaLink.trigger('click')
    await wrapper.get('[aria-label="Attach files"]').trigger('click')
    await flushPromises()
    await betaLink.trigger('click')
    await flushPromises()

    expect(wrapper.find('.composer-attachment').exists()).toBe(false)
    expect(bridge.localAttachments.discard).toHaveBeenCalledWith(['alpha-draft'])
    wrapper.unmount()
  })

  it('loads persisted attachment previews by id without requiring preview data in the snapshot', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
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
        id: 'message-1',
        groupId: 'direct-codex',
        role: 'user',
        content: '',
        attachments: [{ id: 'persisted-image', name: 'diagram.png', mimeType: 'image/png', size: 3 }],
        createdAt: '2026-07-29T08:01:00Z',
      })
    })

    await wrapper.get('.direct-session-open').trigger('click')
    await flushPromises()

    expect(bridge.localAttachments.preview).toHaveBeenCalledWith('persisted-image')
    expect(wrapper.get('.message-attachment-grid img').attributes('src')).toBe('data:image/png;base64,AQID')
    expect(wrapper.get('.message-attachment-grid figcaption').text()).toBe('diagram.png')
    wrapper.unmount()
  })

  it('renders Agent image, audio, and video outputs inside the conversation', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'direct-codex',
        conversationType: 'direct',
        directAgentKind: 'codex',
        name: 'Codex',
        agentKinds: ['codex'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: true,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.messages.push({
        id: 'agent-media',
        groupId: 'direct-codex',
        role: 'agent',
        agentKind: 'codex',
        content: 'Generated media is ready.',
        attachments: [
          { id: 'poster-image', name: 'poster.png', mimeType: 'image/png', size: 3 },
          { id: 'briefing-audio', name: 'briefing.mp3', mimeType: 'audio/mpeg', size: 12 },
          { id: 'demo-video', name: 'demo.mp4', mimeType: 'video/mp4', size: 24 },
        ],
        createdAt: '2026-07-29T08:01:00Z',
      })
    })

    await wrapper.get('.direct-session-open').trigger('click')
    await flushPromises()

    expect(bridge.localAttachments.preview).toHaveBeenCalledTimes(1)
    expect(bridge.localAttachments.preview).toHaveBeenCalledWith('poster-image')
    expect(wrapper.get('.message-attachment-grid img').attributes('src')).toBe('data:image/png;base64,AQID')
    expect(wrapper.get('.message-attachment-grid audio').attributes('src'))
      .toBe('meldwork-media://attachment/briefing-audio')
    expect(wrapper.get('.message-attachment-grid video').attributes('src'))
      .toBe('meldwork-media://attachment/demo-video')
    expect(wrapper.find('.message-attachment-grid figcaption').exists()).toBe(false)
    wrapper.unmount()
  })

  it('opens uploaded images and generated videos in the original-media preview', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'direct-codex',
        conversationType: 'direct',
        directAgentKind: 'codex',
        name: 'Codex',
        agentKinds: ['codex'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: true,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.messages.push(
        {
          id: 'uploaded-image',
          groupId: 'direct-codex',
          role: 'user',
          content: '',
          attachments: [{ id: 'uploaded-image-id', name: 'upload.png', mimeType: 'image/png', size: 3 }],
          createdAt: '2026-07-29T08:01:00Z',
        },
        {
          id: 'generated-video',
          groupId: 'direct-codex',
          role: 'agent',
          agentKind: 'codex',
          content: 'Video complete.',
          attachments: [{ id: 'generated-video-id', name: 'result.mp4', mimeType: 'video/mp4', size: 24 }],
          createdAt: '2026-07-29T08:02:00Z',
        },
      )
    })

    await wrapper.get('.direct-session-open').trigger('click')
    await flushPromises()

    const triggers = wrapper.findAll('.message-media-preview-trigger')
    expect(triggers).toHaveLength(2)
    await triggers[0].trigger('click')
    await flushPromises()
    expect(document.body.classList.contains('media-preview-open')).toBe(true)
    expect(document.querySelector('.attachment-media-preview-dialog img')?.getAttribute('src'))
      .toBe('meldwork-media://attachment/uploaded-image-id')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(document.querySelector('.attachment-media-preview-dialog')).toBeNull()

    await triggers[1].trigger('click')
    await flushPromises()
    const previewVideo = document.querySelector('.attachment-media-preview-dialog video')
    expect(previewVideo?.getAttribute('src')).toBe('meldwork-media://attachment/generated-video-id')
    expect(previewVideo?.hasAttribute('autoplay')).toBe(true)

    document.querySelector('.attachment-media-preview-backdrop')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(document.querySelector('.attachment-media-preview-dialog')).toBeNull()
    wrapper.unmount()
  })

  it('falls back to the private media protocol when an Agent image has no thumbnail', async () => {
    const { wrapper, bridge } = await mountApp(({ state, bridge: desktopBridge }) => {
      state.groups.push({
        id: 'direct-codex',
        conversationType: 'direct',
        directAgentKind: 'codex',
        name: 'Codex',
        agentKinds: ['codex'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: true,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.messages.push({
        id: 'agent-protocol-image',
        groupId: 'direct-codex',
        role: 'agent',
        agentKind: 'codex',
        content: 'The original image is ready.',
        attachments: [{ id: 'original-image', name: 'original.webp', mimeType: 'image/webp', size: 4 }],
        createdAt: '2026-07-29T08:01:00Z',
      })
      desktopBridge.localAttachments.preview.mockResolvedValue({
        id: 'original-image', name: 'original.webp', mimeType: 'image/webp', size: 4,
      })
    })

    await wrapper.get('.direct-session-open').trigger('click')
    await flushPromises()

    expect(bridge.localAttachments.preview).toHaveBeenCalledWith('original-image')
    expect(wrapper.get('.message-attachment-grid img').attributes('src'))
      .toBe('meldwork-media://attachment/original-image')
    wrapper.unmount()
  })

  it('renders Agent image, audio, and video outputs inside a group conversation', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'group-media',
        conversationType: 'group',
        name: 'Media studio',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: true,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.messages.push({
        id: 'group-agent-media',
        groupId: 'group-media',
        role: 'agent',
        agentKind: 'codex',
        content: 'Generated media is ready.',
        attachments: [
          { id: 'group-poster', name: 'group-poster.png', mimeType: 'image/png', size: 3 },
          { id: 'group-audio', name: 'group-audio.mp3', mimeType: 'audio/mpeg', size: 12 },
          { id: 'group-video', name: 'group-video.mp4', mimeType: 'video/mp4', size: 24 },
        ],
        createdAt: '2026-07-29T08:01:00Z',
      })
    })

    await wrapper.get('.conversation-link').trigger('click')
    await flushPromises()

    expect(bridge.localAttachments.preview).toHaveBeenCalledWith('group-poster')
    expect(wrapper.get('.message-attachment-grid img').attributes('src')).toBe('data:image/png;base64,AQID')
    expect(wrapper.get('.message-attachment-grid audio').attributes('src'))
      .toBe('meldwork-media://attachment/group-audio')
    expect(wrapper.get('.message-attachment-grid video').attributes('src'))
      .toBe('meldwork-media://attachment/group-video')
    wrapper.unmount()
  })

  it('renders and opens an Agent-generated document without exposing a path', async () => {
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'direct-codex',
        conversationType: 'direct',
        directAgentKind: 'codex',
        name: 'Codex',
        agentKinds: ['codex'],
        workdir: '/tmp/meldwork-workspace',
        allowWrite: true,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
      state.messages.push({
        id: 'agent-document',
        groupId: 'direct-codex',
        role: 'agent',
        agentKind: 'codex',
        content: 'The report is ready.',
        attachments: [{ id: 'generated-report', name: 'report.pdf', mimeType: 'application/pdf', size: 2048 }],
        createdAt: '2026-07-29T08:01:00Z',
      })
    })

    await wrapper.get('.direct-session-open').trigger('click')
    await flushPromises()
    const documentCard = wrapper.get('.message-document-attachment')
    expect(documentCard.text()).toContain('report.pdf')
    expect(documentCard.text()).toContain('PDF · 2 KB')
    expect(documentCard.get('[data-document-icon]').attributes('data-document-icon')).toBe('pdf')
    expect(documentCard.html()).not.toContain('/tmp/')
    await documentCard.trigger('click')

    expect(bridge.localAttachments.open).toHaveBeenCalledWith('generated-report')
    wrapper.unmount()
  })

  it('uses distinct document icons for code, spreadsheet, presentation, and archive attachments', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'direct-codex', conversationType: 'direct', directAgentKind: 'codex', name: 'Codex',
        agentKinds: ['codex'], workdir: '/tmp/meldwork-workspace', allowWrite: true,
        createdAt: '2026-07-29T08:00:00Z', updatedAt: '2026-07-29T08:00:00Z',
      })
      state.messages.push({
        id: 'document-icons', groupId: 'direct-codex', role: 'agent', agentKind: 'codex', content: 'Files ready.',
        attachments: [
          { id: 'source-file', name: 'server.ts', mimeType: 'text/plain', size: 10 },
          { id: 'sheet-file', name: 'budget.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 10 },
          { id: 'slides-file', name: 'review.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', size: 10 },
          { id: 'archive-file', name: 'release.zip', mimeType: 'application/zip', size: 10 },
        ],
        createdAt: '2026-07-29T08:01:00Z',
      })
    })

    await wrapper.get('.direct-session-open').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('[data-document-icon]').map(item => item.attributes('data-document-icon')))
      .toEqual(['code', 'spreadsheet', 'presentation', 'archive'])
    expect(wrapper.findAll('.message-document-list')).toHaveLength(1)
    expect(wrapper.get('.message-document-list').findAll('.message-document-attachment')).toHaveLength(4)
    expect(wrapper.get('.message-document-list').findAll('figure')).toHaveLength(0)
    wrapper.unmount()
  })

  it('blocks button and Enter sends until a pasted image finishes importing', async () => {
    const pendingImport = deferred()
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
      desktopBridge.localAttachments.importAttachment.mockReturnValueOnce(pendingImport.promise)
    })

    await wrapper.get('.direct-session-open').trigger('click')
    const textarea = wrapper.get('.composer-box textarea')
    await textarea.setValue('Include this image')
    await textarea.trigger('paste', {
      clipboardData: {
        items: [{
          kind: 'file',
          type: 'image/png',
          getAsFile: () => ({
            name: 'diagram.png',
            type: 'image/png',
            arrayBuffer: vi.fn(async () => Uint8Array.from([1, 2, 3]).buffer),
          }),
        }],
      },
    })
    await flushPromises()

    expect(wrapper.get('.send-button').attributes()).toHaveProperty('disabled')
    await textarea.trigger('keydown', { key: 'Enter' })
    expect(bridge.localWorkspace.send).not.toHaveBeenCalled()

    pendingImport.resolve({
      id: 'attachment-1',
      name: 'diagram.png',
      mimeType: 'image/png',
      size: 3,
      previewDataUrl: 'data:image/png;base64,AQID',
    })
    await flushPromises()

    expect(wrapper.get('.send-button').attributes()).not.toHaveProperty('disabled')
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()
    expect(bridge.localWorkspace.send).toHaveBeenCalledWith(expect.objectContaining({
      groupId: 'direct-codex',
      text: 'Include this image',
      attachments: [{ id: 'attachment-1', name: 'diagram.png', mimeType: 'image/png', size: 3 }],
    }))
    wrapper.unmount()
  })

  it('does not start a second paste import while the current batch is pending', async () => {
    const pendingImport = deferred()
    const secondRead = vi.fn(async () => Uint8Array.from([4, 5, 6]).buffer)
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
      desktopBridge.localAttachments.importAttachment.mockReturnValueOnce(pendingImport.promise)
    })

    await wrapper.get('.direct-session-open').trigger('click')
    const textarea = wrapper.get('.composer-box textarea')
    await textarea.trigger('paste', {
      clipboardData: {
        items: [{
          kind: 'file',
          type: 'image/png',
          getAsFile: () => ({
            name: 'first.png',
            type: 'image/png',
            size: 3,
            arrayBuffer: vi.fn(async () => Uint8Array.from([1, 2, 3]).buffer),
          }),
        }],
      },
    })
    await flushPromises()
    await textarea.trigger('paste', {
      clipboardData: {
        items: [{
          kind: 'file',
          type: 'image/png',
          getAsFile: () => ({
            name: 'second.png',
            type: 'image/png',
            size: 3,
            arrayBuffer: secondRead,
          }),
        }],
      },
    })
    await flushPromises()

    expect(bridge.localAttachments.importAttachment).toHaveBeenCalledTimes(1)
    expect(secondRead).not.toHaveBeenCalled()
    expect(wrapper.get('.toast-message').text()).toContain('current file import')

    pendingImport.resolve(imageAttachment('first'))
    await flushPromises()
    wrapper.unmount()
  })

  it('discards attachment imports that finish after switching conversations', async () => {
    const pendingImport = deferred()
    const { wrapper, bridge } = await mountApp(({ state, bridge: desktopBridge }) => {
      state.groups.push(
        {
          id: 'group-alpha',
          conversationType: 'group',
          name: 'Alpha review',
          topic: '',
          agentKinds: ['codex', 'hermes'],
          workdir: '/tmp/meldwork-workspace',
          allowWrite: false,
          createdAt: '2026-07-29T08:00:00Z',
          updatedAt: '2026-07-29T08:02:00Z',
        },
        {
          id: 'group-beta',
          conversationType: 'group',
          name: 'Beta review',
          topic: '',
          agentKinds: ['codex', 'hermes'],
          workdir: '/tmp/meldwork-workspace',
          allowWrite: false,
          createdAt: '2026-07-29T08:00:00Z',
          updatedAt: '2026-07-29T08:01:00Z',
        },
      )
      desktopBridge.localAttachments.importAttachment.mockReturnValueOnce(pendingImport.promise)
    })

    const links = wrapper.findAll('.conversation-link')
    const alphaLink = links.find(link => link.text().includes('Alpha review'))
    const betaLink = links.find(link => link.text().includes('Beta review'))
    await alphaLink.trigger('click')
    await wrapper.get('.composer-box textarea').trigger('paste', {
      clipboardData: {
        items: [{
          kind: 'file',
          type: 'image/png',
          getAsFile: () => ({
            name: 'alpha.png',
            type: 'image/png',
            arrayBuffer: vi.fn(async () => Uint8Array.from([1, 2, 3]).buffer),
          }),
        }],
      },
    })
    await flushPromises()

    await betaLink.trigger('click')
    const betaTextarea = wrapper.get('.composer-box textarea')
    await betaTextarea.setValue('Beta task')
    expect(wrapper.get('.send-button').attributes()).not.toHaveProperty('disabled')
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()
    expect(bridge.localWorkspace.send).toHaveBeenCalledWith(expect.objectContaining({
      groupId: 'group-beta',
      text: 'Beta task',
      attachments: [],
    }))

    pendingImport.resolve({
      id: 'alpha-image',
      name: 'alpha.png',
      mimeType: 'image/png',
      size: 3,
      previewDataUrl: 'data:image/png;base64,AQID',
    })
    await flushPromises()
    expect(wrapper.find('.composer-attachment').exists()).toBe(false)
    expect(bridge.localAttachments.discard).toHaveBeenCalledWith(['alpha-image'])
    wrapper.unmount()
  })

  it('does not restore a failed send draft after switching conversations', async () => {
    const pendingSend = deferred()
    const { wrapper, bridge } = await mountApp(({ state, bridge: desktopBridge }) => {
      state.groups.push(
        {
          id: 'group-alpha',
          conversationType: 'group',
          name: 'Alpha review',
          topic: '',
          agentKinds: ['codex', 'hermes'],
          workdir: '/tmp/meldwork-workspace',
          allowWrite: false,
          createdAt: '2026-07-29T08:00:00Z',
          updatedAt: '2026-07-29T08:02:00Z',
        },
        {
          id: 'group-beta',
          conversationType: 'group',
          name: 'Beta review',
          topic: '',
          agentKinds: ['codex', 'hermes'],
          workdir: '/tmp/meldwork-workspace',
          allowWrite: false,
          createdAt: '2026-07-29T08:00:00Z',
          updatedAt: '2026-07-29T08:01:00Z',
        },
      )
      desktopBridge.localWorkspace.send.mockReturnValueOnce(pendingSend.promise)
    })

    const links = wrapper.findAll('.conversation-link')
    const alphaLink = links.find(link => link.text().includes('Alpha review'))
    const betaLink = links.find(link => link.text().includes('Beta review'))
    await alphaLink.trigger('click')
    await wrapper.get('.composer-box textarea').setValue('Alpha draft')
    await wrapper.get('.send-button').trigger('click')
    await flushPromises()
    expect(bridge.localWorkspace.send).toHaveBeenCalledWith(expect.objectContaining({
      groupId: 'group-alpha',
      text: 'Alpha draft',
    }))

    await betaLink.trigger('click')
    pendingSend.reject(new Error('LOCAL_AGENT_PROCESS_FAILED'))
    await flushPromises()

    expect(wrapper.get('.conversation-header h1').text()).toBe('Beta review')
    expect(wrapper.get('.composer-box textarea').element.value).toBe('')
    wrapper.unmount()
  })
})

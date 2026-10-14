import { ref } from 'vue'
import { describe, expect, it } from 'vitest'
import conversationComposerSource from '../../components/ConversationComposer.vue?raw'
import conversationHeaderSource from '../../components/ConversationHeader.vue?raw'
import conversationTimelineSource from '../../components/ConversationTimelineView.vue?raw'
import systemSettingsSource from '../../components/SystemSettingsView.vue?raw'
import workspaceModalSource from '../../components/WorkspaceModalContent.vue?raw'
import workspaceSidebarSource from '../../components/WorkspaceSidebar.vue?raw'
import { createConversationControllers } from '../../conversationControllers.js'
import { createWorkspaceControllers } from '../../workspaceControllers.js'

const sourceMetadata = new WeakMap()

function controllerKeys(source) {
  const match = source.match(/const\s*\{([\s\S]*?)\}\s*=\s*props\.controller/)
  if (!match) throw new Error('Controller destructuring was not found')
  return match[1]
    .split(',')
    .map(key => key.trim())
    .filter(Boolean)
    .sort()
}

function source(label, initial = {}) {
  for (const [key, value] of Object.entries(initial)) {
    sourceMetadata.set(value, { key, source: label })
  }
  const proxy = new Proxy(initial, {
    get(target, key) {
      if (!(key in target)) {
        target[key] = Object.freeze({ key, source: label })
        sourceMetadata.set(target[key], { key, source: label })
      }
      return target[key]
    },
  })
  sourceMetadata.set(proxy, { key: null, source: label })
  return proxy
}

function expectSameNamedReferences(controller) {
  for (const [key, value] of Object.entries(controller)) {
    const metadata = sourceMetadata.get(value)
    expect(metadata, `Missing source metadata for ${key}`).toBeDefined()
    expect(metadata.key === null ? metadata.source : metadata.key).toBe(key)
  }
}

function conversationSources() {
  return {
    agentCatalog: source('agentCatalog'),
    agentSkills: source('agentSkills'),
    app: source('app', { activeGroup: ref(null) }),
    attachments: source('attachments'),
    composerContext: source('composerContext'),
    conversationActions: source('conversationActions'),
    knowledgeBase: source('knowledgeBase'),
    messageActions: source('messageActions'),
    timeline: source('timeline'),
  }
}

function workspaceSources() {
  return {
    agentCatalog: source('agentCatalog'),
    agentManagement: source('agentManagement'),
    agentRefresh: source('agentRefresh'),
    agentSkills: source('agentSkills'),
    app: source('app'),
    collapsedGroupMenu: source('collapsedGroupMenu'),
    conversationActions: source('conversationActions'),
    conversationNavigation: source('conversationNavigation'),
    knowledgeBase: source('knowledgeBase'),
    timeline: source('timeline'),
  }
}

describe('App controller contracts', () => {
  it('matches every extracted component controller field exactly', () => {
    const conversation = createConversationControllers(conversationSources())
    const workspace = createWorkspaceControllers(workspaceSources())

    expect(Object.keys(conversation.timelineController).sort()).toEqual(
      controllerKeys(conversationTimelineSource),
    )
    expect(Object.keys(conversation.conversationHeaderController).sort()).toEqual(
      controllerKeys(conversationHeaderSource),
    )
    expect(Object.keys(conversation.composerController).sort()).toEqual(
      controllerKeys(conversationComposerSource),
    )
    expect(Object.keys(workspace.workspaceSidebarController).sort()).toEqual(
      controllerKeys(workspaceSidebarSource),
    )
    expect(Object.keys(workspace.systemSettingsController).sort()).toEqual(
      controllerKeys(systemSettingsSource),
    )
    expect(Object.keys(workspace.workspaceModalController).sort()).toEqual(
      controllerKeys(workspaceModalSource),
    )

    for (const controller of Object.values({ ...conversation, ...workspace })) {
      expectSameNamedReferences(controller)
    }
  })

  it('preserves source refs, functions, and nested controller identities', () => {
    const conversationInput = conversationSources()
    const conversation = createConversationControllers(conversationInput)
    const workspaceInput = workspaceSources()
    const workspace = createWorkspaceControllers(workspaceInput)

    expect(conversation.timelineController.activeGroup).toBe(conversationInput.app.activeGroup)
    expect(conversation.timelineController.copyMessageContent).toBe(
      conversationInput.messageActions.copyMessageContent,
    )
    expect(conversation.conversationHeaderController.activeDirectAgent).toBe(
      conversationInput.agentCatalog.activeDirectAgent,
    )
    expect(conversation.composerController.composerAttachments).toBe(
      conversationInput.attachments.composerAttachments,
    )
    expect(workspace.workspaceSidebarController.groupGroups).toBe(
      workspaceInput.conversationNavigation.groupGroups,
    )
    expect(workspace.workspaceModalController.customAgentForm).toBe(
      workspaceInput.agentManagement.customAgentForm,
    )
  })
})

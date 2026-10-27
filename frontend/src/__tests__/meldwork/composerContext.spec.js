import { effectScope, nextTick, ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useComposerContext } from '../../composables/useComposerContext.js'
import { messageScopedTargetKinds } from '../../messageContext.js'

function deferred() {
  let resolve
  const promise = new Promise(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

function createComposer(overrides = {}) {
  const activeGroup = ref({
    id: 'direct-codex',
    conversationType: 'direct',
    directAgentKind: 'codex',
    agentKinds: ['codex'],
  })
  const scope = effectScope()
  let composer
  scope.run(() => {
    composer = useComposerContext({
      activeGroup,
      activeRun: ref(null),
      agentDescription: kind => kind,
      agentSkillsSnapshot: () => ({ complete: true, skills: [] }),
      knowledgeBaseName: kind => kind,
      knowledgeBaseReady: () => false,
      loadAgentSkills: async () => ({ complete: true, skills: [] }),
      localKnowledgeBaseEntries: ref([]),
      mergedCatalog: ref([
        { kind: 'codex', label: 'Codex' },
        { kind: 'hermes', label: 'Hermes' },
      ]),
      notify: vi.fn(),
      onSubmit: vi.fn(),
      preloadAgentSkills: vi.fn(async () => {}),
      sending: ref(false),
      t: key => key,
      theme: ref('light'),
      ...overrides,
    })
  })
  return { activeGroup, composer, scope }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('composer context', () => {
  it('keeps the selected discussion mode when the current group membership refreshes', () => {
    const { activeGroup, composer, scope } = createComposer()
    activeGroup.value = { id: 'group-auto', agentKinds: ['codex', 'hermes'] }
    composer.resetComposerContext(activeGroup.value)
    composer.discussionMode.value = 'auto-beta'
    composer.resetComposerContext({ ...activeGroup.value, agentKinds: ['hermes', 'codex'] })
    expect(composer.discussionMode.value).toBe('auto-beta')
    composer.resetComposerContext({ id: 'other-group', agentKinds: ['codex', 'hermes'] })
    expect(composer.discussionMode.value).toBe('auto')
    composer.resetComposerContext(activeGroup.value)
    expect(composer.discussionMode.value).toBe('auto-beta')
    scope.stop()
  })

  it('treats an empty manual selection as the whole group', () => {
    const { activeGroup, composer, scope } = createComposer()
    activeGroup.value = {
      id: 'group-concurrent-default-all',
      conversationType: 'group',
      agentKinds: ['codex', 'hermes'],
    }

    composer.resetComposerContext(activeGroup.value)
    composer.discussionMode.value = 'manual'

    expect(composer.targetKinds.value).toEqual([])
    expect(composer.composerTargetKinds.value).toEqual(['codex', 'hermes'])
    scope.stop()
  })

  it('ignores a stale Skill result after the active conversation changes', async () => {
    const pendingSkills = deferred()
    const { activeGroup, composer, scope } = createComposer({
      agentSkillsSnapshot: () => ({ complete: false, skills: [] }),
      loadAgentSkills: vi.fn(() => pendingSkills.promise),
    })

    const opening = composer.openSkillMenu()
    await nextTick()
    activeGroup.value = {
      id: 'direct-hermes',
      conversationType: 'direct',
      directAgentKind: 'hermes',
      agentKinds: ['hermes'],
    }
    composer.resetComposerContext(activeGroup.value)
    composer.draft.value = '@'
    pendingSkills.resolve({
      complete: true,
      skills: [{ targetKind: 'codex', namespace: 'local', slug: 'review', name: 'Review' }],
    })
    await opening
    await flushPromises()

    expect(composer.composerMenuOptions.value).toEqual([])
    expect(composer.skillsLoading.value).toBe(false)
    scope.stop()
  })

  it('captures, serializes, clears, and restores send context without exposing cache state', () => {
    const { composer, scope } = createComposer()
    composer.draft.value = 'Review this'
    composer.selectedAgentKinds.value = ['codex']
    composer.selectedSkills.value = [
      { targetKind: 'codex', namespace: 'local', slug: 'review', name: 'Review' },
    ]
    composer.selectedKnowledgeBases.value = [
      { kind: 'obsidian', targetKinds: ['codex'] },
    ]

    const captured = composer.captureComposerContext()
    expect(composer.serializeComposerContext(['codex'])).toEqual({
      mentionedAgentKinds: [],
      skillHints: [
        { targetKind: 'codex', namespace: 'local', slug: 'review', name: 'Review' },
      ],
      knowledgeBaseHints: [{ kind: 'obsidian', targetKinds: ['codex'] }],
    })

    composer.clearComposerContext()
    expect(composer.draft.value).toBe('')
    expect(composer.selectedSkills.value).toEqual([])
    composer.restoreComposerContext(captured)
    expect(composer.draft.value).toBe('Review this')
    expect(composer.selectedSkills.value[0].slug).toBe('review')
    expect(composer.selectedKnowledgeBases.value[0].targetKinds).toEqual(['codex'])
    scope.stop()
  })

  it('keeps automatic team formation opt-in and disables it for explicit context', async () => {
    const { activeGroup, composer, scope } = createComposer({
      mergedCatalog: ref([
        { kind: 'codex', label: 'Codex', available: true },
        { kind: 'hermes', label: 'Hermes', available: true },
      ]),
    })
    activeGroup.value = {
      id: 'group-review',
      conversationType: 'group',
      agentKinds: ['codex', 'hermes'],
    }
    composer.resetComposerContext(activeGroup.value)
    composer.discussionMode.value = 'manual'

    expect(composer.automaticTeamFormation.value).toBe(false)
    composer.toggleAutomaticTeamFormation()
    expect(composer.automaticTeamFormation.value).toBe(true)
    expect(composer.composerTargetKinds.value).toEqual(['codex', 'hermes'])

    composer.selectedAgentKinds.value = ['codex']
    await nextTick()
    expect(composer.automaticTeamFormation.value).toBe(false)

    composer.toggleAutomaticTeamFormation()
    expect(composer.automaticTeamFormation.value).toBe(false)
    scope.stop()
  })

  it('keeps explicit targets ahead of tags and natural-language routing', () => {
    const group = { agentKinds: ['codex', 'hermes'] }
    const catalog = [
      { kind: 'codex', label: 'Codex' },
      { kind: 'hermes', label: 'Hermes' },
    ]
    expect(messageScopedTargetKinds({
      content: '@Hermes inspect this',
      mentionedAgentKinds: ['hermes'],
      targetKinds: ['codex'],
    }, group, catalog)).toEqual(['codex'])
  })
})

describe('composer targets with an unavailable member', () => {
  function groupComposer(catalog) {
    const created = createComposer({ mergedCatalog: ref(catalog) })
    created.activeGroup.value = {
      id: 'group-with-offline-member',
      conversationType: 'group',
      agentKinds: ['codex', 'hermes', 'kimi'],
    }
    created.composer.resetComposerContext(created.activeGroup.value)
    return created
  }
  const catalog = [
    { kind: 'codex', label: 'Codex', ready: true },
    { kind: 'hermes', label: 'Hermes', ready: false },
    { kind: 'kimi', label: 'Kimi', ready: true },
  ]

  it('skips a member that is not ready when everyone is the implicit recipient', () => {
    const { composer, scope } = groupComposer(catalog)
    composer.discussionMode.value = 'manual'

    expect(composer.composerTargetKinds.value).toEqual(['codex', 'kimi'])
    expect(composer.composerSkippedKinds.value).toEqual(['hermes'])
    composer.discussionMode.value = 'auto'
    expect(composer.composerTargetKinds.value).toEqual(['codex', 'kimi'])
    scope.stop()
  })

  it('keeps an Agent the user picked explicitly so the send can report it', () => {
    const { composer, scope } = groupComposer(catalog)
    composer.discussionMode.value = 'manual'
    composer.targetKinds.value = ['hermes', 'kimi']

    expect(composer.composerTargetKinds.value).toEqual(['hermes', 'kimi'])
    expect(composer.composerSkippedKinds.value).toEqual([])
    scope.stop()
  })

  it('does not hide the problem when nobody in the group is ready', () => {
    const { composer, scope } = groupComposer(catalog.map(agent => ({ ...agent, ready: false })))
    composer.discussionMode.value = 'manual'

    expect(composer.composerTargetKinds.value).toEqual(['codex', 'hermes', 'kimi'])
    expect(composer.composerSkippedKinds.value).toEqual([])
    scope.stop()
  })
})

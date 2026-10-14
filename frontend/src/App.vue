<template>
  <main
    class="app-shell"
    :class="{
      'sidebar-collapsed': sidebarCollapsed,
      'trace-panel-open': tracePanelOpen,
    }"
    :data-theme="theme"
    :data-platform="desktopPlatform"
    :aria-busy="agentDiscoveryPending ? 'true' : undefined"
  >
    <section v-if="booting" class="boot-state" aria-live="polite">
      <img class="boot-logo" :src="productAppIcon" alt="Meldwork" />
      <p>{{ t('app.loading') }}</p>
      <WavePhysicsLoader :theme="theme" />
    </section>

    <section v-else-if="bridgeMissing" class="bridge-state">
      <img class="bridge-logo" :src="productAppIcon" alt="Meldwork" />
      <h1>{{ t('app.desktopRequired') }}</h1>
      <p>{{ t('app.desktopRequiredDetail') }}</p>
    </section>

    <template v-else>
      <transition name="agent-discovery" appear>
        <section
          v-if="agentDiscoveryPending"
          class="agent-discovery-overlay"
          role="status"
          aria-live="polite"
          :aria-label="t('agentDiscovery.title')"
        >
          <PixelBlast :theme="theme" />
          <div class="agent-discovery-content">
            <img class="agent-discovery-mark" :src="productMark" alt="" />
            <div class="agent-discovery-copy">
              <p class="agent-discovery-kicker">{{ t('agentDiscovery.kicker') }}</p>
              <h1>{{ t('agentDiscovery.title') }}</h1>
              <p>{{ t('agentDiscovery.body') }}</p>
              <div class="agent-discovery-progress" aria-hidden="true">
                <span />
              </div>
              <div class="agent-discovery-status">
                <span class="agent-discovery-status-dot" aria-hidden="true" />
                <span>{{ t('agentDiscovery.status') }}</span>
              </div>
            </div>
          </div>
        </section>
      </transition>

      <WorkspaceSidebar :controller="workspaceSidebarController" />

      <section
        class="workspace-pane"
        :inert="contentInteractionBlocked ? '' : undefined"
        :aria-hidden="contentInteractionBlocked ? 'true' : undefined"
      >
        <SystemSettingsView
          v-if="activeView === 'settings'"
          :controller="systemSettingsController"
        />

        <HomeDashboard
          v-else-if="activeView === 'home'"
          :agent-description="agentDescription"
          :group-name="groupName"
          :groups="snapshot.groups"
          :installed-count="installedCount"
          :is-group-running="isGroupRunning"
          :onboarding-completed="onboardingCompleted"
          :ready-agents="readyAgents"
          :recent-group-meta="recentGroupMeta"
          :refreshing="refreshing"
          :theme="theme"
          @open-agent-manager="openAgentManager"
          @open-direct="openDirect"
          @open-new-group="openNewGroup"
          @refresh-agents="refreshAgents"
          @select-group="selectGroup"
        />

        <section v-else class="conversation-pane">
          <ConversationHeader ref="conversationHeader" :controller="conversationHeaderController" />

          <ConversationTimelineView :controller="timelineController" />

          <ConversationComposer :controller="composerController" />
        </section>
      </section>

      <transition name="trace-panel">
        <RunTracePanel
          v-if="tracePanelOpen"
          ref="tracePanel"
          :open="tracePanelOpen"
          :drawer="tracePanelDrawer"
          :human-gate-decision-pending-ids="humanGateDecisionPendingIds"
          :human-gates="tracePanelHumanGates"
          :items="tracePanelItems"
          :selected-agent-run-id="selectedTraceAgentRunId"
          :theme="theme"
          :waiting="tracePanelWaiting"
          @close="closeTracePanel"
          @decide-human-gate="decideHumanGate"
          @select="selectTraceAgentRun"
          @jump-source="jumpToTraceSource"
        />
      </transition>

      <transition name="onboarding" appear>
        <div v-if="onboardingVisible" class="onboarding-transition-shell">
          <OnboardingDialog
            ref="onboardingDialog"
            :controller="onboardingDialogController"
          />
        </div>
      </transition>

      <transition name="modal-backdrop" appear>
        <div v-if="modal" class="modal-backdrop" @mousedown.self="closeModal">
          <transition name="modal-pop" appear>
            <section
              ref="modalDialog"
              class="modal"
              :class="{
                medium: ['new-group', 'settings', 'custom-agent'].includes(modal),
                'agent-detail-modal': modal === 'agent-detail',
                'unlimited-confirm-modal': modal === 'unlimited-confirm',
              }"
              role="dialog"
              aria-modal="true"
              aria-labelledby="modal-title"
              tabindex="-1"
            >
              <header class="modal-header">
                <div>
                  <h2 id="modal-title">{{ modalTitle }}</h2>
                  <p v-if="modalSubtitle">{{ modalSubtitle }}</p>
                </div>
                <button class="icon-button" type="button" :aria-label="t('common.close')" :disabled="saving" @click="closeModal">
                  <CloseOutline />
                </button>
              </header>

              <WorkspaceModalContent
                ref="workspaceModalContent"
                :controller="workspaceModalController"
              />
            </section>
          </transition>
        </div>
      </transition>

      <transition name="toast">
        <div v-if="toastMessage" class="toast-message" role="status" aria-live="polite">
          <WarningOutline />
          <span>{{ toastMessage }}</span>
          <button
            class="toast-dismiss-button"
            type="button"
            :title="t('common.dismiss')"
            :aria-label="t('common.dismiss')"
            @click="dismissToast"
          >
            <CloseOutline />
          </button>
        </div>
      </transition>
      <transition name="copy-toast">
        <div v-if="copyToastMessage" class="copy-toast-message" role="status" aria-live="polite">
          <CheckmarkCircleOutline />
          <span>{{ copyToastMessage }}</span>
        </div>
      </transition>
    </template>
  </main>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  CheckmarkCircleOutline,
  CloseOutline,
  WarningOutline,
} from '@vicons/ionicons5'
import ConversationComposer from './components/ConversationComposer.vue'
import ConversationHeader from './components/ConversationHeader.vue'
import ConversationTimelineView from './components/ConversationTimelineView.vue'
import HomeDashboard from './components/HomeDashboard.vue'
import OnboardingDialog from './components/OnboardingDialog.vue'
import PixelBlast from './components/PixelBlast.vue'
import WavePhysicsLoader from './components/WavePhysicsLoader.vue'
import RunTracePanel from './components/RunTracePanel.vue'
import SystemSettingsView from './components/SystemSettingsView.vue'
import WorkspaceModalContent from './components/WorkspaceModalContent.vue'
import WorkspaceSidebar from './components/WorkspaceSidebar.vue'
import { agentLabel, setCloudAgentProfiles, setCustomAgentProfiles } from './catalog.js'
import { createConversationControllers } from './conversationControllers.js'
import { useAgentCatalog } from './composables/useAgentCatalog.js'
import { useAgentManagement } from './composables/useAgentManagement.js'
import { useAgentRefresh } from './composables/useAgentRefresh.js'
import { useAgentSkills } from './composables/useAgentSkills.js'
import { useAppNotifications } from './composables/useAppNotifications.js'
import { useAppPreferences } from './composables/useAppPreferences.js'
import { useComposerAttachments } from './composables/useComposerAttachments.js'
import {
  normalizeSkill,
  useComposerContext,
} from './composables/useComposerContext.js'
import { useCollapsedGroupMenu } from './composables/useCollapsedGroupMenu.js'
import { useConversationActions } from './composables/useConversationActions.js'
import { useConversationExecution } from './composables/useConversationExecution.js'
import { useConversationTimeline } from './composables/useConversationTimeline.js'
import { useConversationNavigation } from './composables/useConversationNavigation.js'
import { useConversationViewport } from './composables/useConversationViewport.js'
import { useDesktopWorkspaceLifecycle } from './composables/useDesktopWorkspaceLifecycle.js'
import { useEmptyShowcasePlayback } from './composables/useEmptyShowcasePlayback.js'
import { useAppWindowInteractions } from './composables/useAppWindowInteractions.js'
import { useCloudAgentBridges } from './composables/useCloudAgentBridges.js'
import { useKnowledgeBaseSettings } from './composables/useKnowledgeBaseSettings.js'
import { useMessageActions } from './composables/useMessageActions.js'
import { useOnboarding } from './composables/useOnboarding.js'
import { useOverlayLifecycle } from './composables/useOverlayLifecycle.js'
import { useRunFinishedNotifications } from './composables/useRunFinishedNotifications.js'
import { useSystemSettingsNavigation } from './composables/useSystemSettingsNavigation.js'
import { useWorkspaceNavigationState } from './composables/useWorkspaceNavigationState.js'
import { desktopApi, emptySnapshot, normalizeSnapshot } from './desktop.js'
import { locale, t, translateError, translateSystemMessage } from './i18n.js'
import { createWorkspaceControllers } from './workspaceControllers.js'

const snapshot = ref(emptySnapshot())
const shortcutDefinitions = Object.freeze([
  { labelKey: 'shortcut.toggleSidebar', keys: '⌘ B' },
  { labelKey: 'shortcut.newGroup', keys: '⌘ G' },
  { labelKey: 'shortcut.previousConversation', keys: '⌘ [' },
  { labelKey: 'shortcut.nextConversation', keys: '⌘ ]' },
  { labelKey: 'shortcut.openAgents', keys: '⌘ ,' },
])
const READ_ONLY_ENFORCED_AGENT_KINDS = new Set([
  'codex', 'hermes', 'openclaw', 'workbuddy', 'pi', 'kimi', 'mimo', 'claude', 'qwen', 'gemini',
  'opencode', 'opencodereview',
])
const installCatalog = ref({ platform: '', agents: [] })
const installerState = ref({ taskId: '', kind: '', phase: 'idle', canCancel: false, errorCode: '' })
const systemSettingsSection = ref('agents')
const sidebarCollapsed = ref(false)
const sidebarAgentsCollapsed = ref(false)
const sidebarGroupsCollapsed = ref(false)
const refreshing = ref(false)
const agentDiscoveryPending = ref(false)
const sendingGroupIds = ref(new Set())
const saving = ref(false)
const humanGateDecisionPendingIds = ref([])
const modal = ref('')
const composerContextVersion = ref(0)
const DEFAULT_MAX_ROUNDS = 6
const maxRounds = ref(DEFAULT_MAX_ROUNDS)
const unlimitedRounds = ref(false)
const unlimitedConfirmationGroupId = ref('')
const roundSettingsByGroupId = new Map()
const roundSettingsOpen = ref(false)
const formError = ref('')
const customAgentDeleteArmed = ref(false)
const installConfirmKind = ref('')
const focusedAgentKind = ref('')
const shortcutMenuOpen = ref(false)
const conversationHeader = ref(null)
const workspaceModalContent = ref(null)
const onboardingDialog = ref(null)
const modalDialog = ref(null)
const roundSettingsControl = ref(null)
let systemSettingsNavigation = null
const {
  copyToastMessage,
  dismissToast,
  notify,
  showCopyToast,
  showError,
  toastMessage,
} = useAppNotifications()
const collapsedGroupMenuController = useCollapsedGroupMenu({ sidebarCollapsed, shortcutMenuOpen })
const {
  collapsedGroupMenu,
  collapsedGroupMenuButton,
  collapsedGroupMenuOpen,
  closeCollapsedGroupMenu,
} = collapsedGroupMenuController
const api = computed(() => desktopApi())
const conversationTitleBlock = computed(() => ({
  focus: () => conversationHeader.value?.focusTitleBlock(),
}))
const desktopPlatform = computed(() => api.value?.platform || installCatalog.value.platform || '')
const workspace = computed(() => api.value?.localWorkspace || null)
const installer = computed(() => api.value?.agentInstaller || null)
const customAgent = computed(() => api.value?.customAgent || null)
const knowledgeBase = computed(() => api.value?.localKnowledgeBase || null)
const cloudAgentBridge = computed(() => api.value?.cloudAgentBridge || null)
const attachmentsApi = computed(() => api.value?.localAttachments || null)
const {
  clearOnboardingPlayback,
  completeOnboardingState,
  ensureOnboardingPlayback,
  hasPersistedWorkspaceActivity,
  onboardingCompleted,
  onboardingIndex,
  onboardingLoadingLabel,
  onboardingReady,
  onboardingSlide,
  onboardingSlides,
  onboardingVisible,
  openOnboarding,
  selectOnboardingSlide,
} = useOnboarding({ refreshAgents: (...args) => refreshAgents(...args) })
const onboardingDialogController = {
  completeOnboarding: (...args) => completeOnboarding(...args),
  onboardingIndex,
  onboardingLoadingLabel,
  onboardingReady,
  onboardingSlide,
  onboardingSlides,
  selectOnboardingSlide,
  t,
}
const knowledgeBaseSettings = useKnowledgeBaseSettings({ knowledgeBase, showError })
const {
  knowledgeBaseName,
  knowledgeBaseReady,
  loadKnowledgeBaseStatuses,
  localKnowledgeBaseEntries,
} = knowledgeBaseSettings
const {
  applyTheme,
  productAppIcon,
  productMark,
  productWordmark,
  theme,
  toggleLocale,
  toggleTheme,
} = useAppPreferences()
const conversationNavigation = useConversationNavigation({ agentLabel, locale, snapshot, t })
const {
  directGroupsFor,
  groupName,
  isDirectCreationPending,
  recentGroupMeta,
  setDirectCreationPending,
  setSidebarAgentExpanded,
  sortByUpdated,
  toggleSidebarAgentExpanded,
} = conversationNavigation
const workspaceNavigationState = useWorkspaceNavigationState({
  clearSidebarDeleteState: () => { sidebarDeleteGroupId.value = '' },
  closeCollapsedGroupMenu,
  closeTracePanel: (...args) => closeTracePanel(...args),
  directGroupsFor,
  flushPendingRunFinishedEvents: (...args) => flushPendingRunFinishedEvents(...args),
  hasFinishedDirectRun: (...args) => hasFinishedDirectRun(...args),
  isDirectCreationPending,
  openAgentManager: (...args) => openAgentManager(...args),
  openDirect: (...args) => openDirect(...args),
  preloadAgentSkills: (...args) => preloadAgentSkills(...args),
  setFinishedDirectRun: (...args) => setFinishedDirectRun(...args),
  setSidebarAgentExpanded,
  sidebarCollapsed,
  snapshot,
  toggleSidebarAgentExpanded,
})
const {
  activeGroup,
  activeGroupMemberSignature,
  activeView,
  goHome,
  handleAgentPrimary,
  handleOpenGroup,
  handleSidebarAgentMain,
  isGroupRunning,
  selectGroup,
  selectedGroupId,
} = workspaceNavigationState
const sending = computed(() => (
  Boolean(selectedGroupId.value && sendingGroupIds.value.has(selectedGroupId.value))
))
const sidebarDeleteGroup = computed(() => snapshot.value.groups.find(group => group.id === sidebarDeleteGroupId.value) || null)
const sidebarDeletePopoverStyle = computed(() => ({
  left: `${sidebarDeletePopoverPoint.value.left}px`,
  top: `${sidebarDeletePopoverPoint.value.top}px`,
}))
const blockingOverlayOpen = computed(() => Boolean(modal.value || onboardingVisible.value))

const agentCatalog = useAgentCatalog({
  activeGroup,
  directGroupsFor,
  installCatalog,
  snapshot,
  t,
  theme,
})
const {
  agentDescription,
  installedCount,
  mergedCatalog,
  readyAgentKinds,
  readyAgentSignature,
  readyAgents,
} = agentCatalog
const agentSkills = useAgentSkills({
  installer,
  mergedCatalog,
  normalizeSkill,
  readyAgents,
  t,
})
const {
  agentDetailSkillSummary,
  agentSkillsSnapshot,
  disposeAgentSkills,
  invalidateAgentSkillCatalog,
  loadAgentSkills,
  loadAgentSkillStats,
  preloadAgentSkills,
  resetAgentDetailSkills,
  selectAgentDetail,
  selectedAgentDetail,
} = agentSkills
const agentRefresh = useAgentRefresh({
  installCatalog,
  installer,
  installerState,
  invalidateAgentSkillCatalog,
  loadAgentSkillStats,
  readyAgentSignature,
  refreshing,
  showError,
  snapshot,
  workspace,
})
const { refreshAgents } = agentRefresh
const cloudAgentBridges = useCloudAgentBridges({
  bridgeApi: cloudAgentBridge,
  refreshAgents,
  showError,
})
const agentManagement = useAgentManagement({
  activeView,
  closeModal,
  customAgent,
  customAgentDeleteArmed,
  focusedAgentKind,
  formError,
  installConfirmKind,
  installer,
  installerState,
  modal,
  normalizeSnapshot,
  refreshAgents,
  saving,
  selectAgentDetail,
  selectedAgentDetail,
  showError,
  snapshot,
  systemSettingsSection,
  t,
  translateError,
})
const conversationTimeline = useConversationTimeline({
  activeGroup,
  activeView,
  blockingOverlayOpen,
  conversationTitleBlock,
  locale,
  mergedCatalog,
  selectedGroupId,
  snapshot,
  t,
  translateSystemMessage,
})
const {
  activeMessages,
  activeRun,
  activeRunTopicSignature,
  closeTracePanel,
  clearActiveTurn,
  clearDeletedTurnState,
  conversationEmptyVisible,
  focusRunTopic,
  hasFinishedDirectRun,
  jumpToTraceSource,
  liveOutputSignature,
  rememberRunFinishedTurnStatus,
  selectTraceAgentRun,
  selectedTraceAgentRunId,
  setFinishedDirectRun,
  traceDrawerBlocking,
  tracePanel,
  tracePanelDrawer,
  tracePanelItems,
  tracePanelOpen,
  tracePanelRunId,
} = conversationTimeline
const pendingHumanGates = computed(() => (
  snapshot.value.humanGates.filter(gate => gate.status === 'pending')
))
const activeRunHumanGates = computed(() => (
  activeRun.value
    ? pendingHumanGates.value.filter(gate => gate.runId === activeRun.value.runId)
    : []
))
const directHumanGates = computed(() => (
  activeGroup.value?.conversationType === 'direct' ? activeRunHumanGates.value : []
))
const directRunBudget = computed(() => (
  activeGroup.value?.conversationType === 'direct' ? activeRun.value?.budget || null : null
))
const tracePanelRun = computed(() => (
  snapshot.value.runs.find(run => (
    run.runId === tracePanelRunId.value && run.groupId === activeGroup.value?.id
  )) || null
))
const tracePanelHumanGates = computed(() => (
  activeGroup.value?.conversationType !== 'direct' && tracePanelRun.value
    ? pendingHumanGates.value.filter(gate => gate.runId === tracePanelRun.value.runId)
    : []
))
const tracePanelWaiting = computed(() => (
  tracePanelHumanGates.value.length > 0
  && tracePanelHumanGates.value.every(gate => tracePanelRun.value?.waitingGateIds.includes(gate.gateId))
))
const {
  handleMessageScroll,
  messageScroller,
  scrollToLatest,
  showScrollToLatest,
} = useConversationViewport({
  activeMessages,
  activeRunTopicSignature,
  liveOutputSignature,
  selectedGroupId,
})
const { index: emptyShowcaseIndex } = useEmptyShowcasePlayback({
  visible: conversationEmptyVisible,
})
const { completeOnboarding, trapOverlayFocus } = useOverlayLifecycle({
  blockingOverlayOpen,
  clearOnboardingPlayback,
  closeCollapsedGroupMenu,
  closeModal,
  closeTracePanel,
  completeOnboardingState,
  ensureOnboardingPlayback,
  modal,
  modalDialog,
  onboardingDialog,
  onboardingVisible,
  saving,
  tracePanelOpen,
})
const messageActions = useMessageActions({
  activeGroup,
  clearDeletedTurnState,
  isGroupRunning,
  notify,
  showCopyToast,
  showError,
  showLatestResponseVersion: conversationTimeline.showLatestResponseVersion,
  snapshot,
  t,
  workspace,
})
const {
  clearPendingRunFinishedEvents,
  flushPendingRunFinishedEvents,
  handleRunFinished,
} = useRunFinishedNotifications({
  hasFinishedDirectRun,
  rememberRunFinishedTurnStatus,
  setFinishedDirectRun,
  snapshot,
})
const { messageDeleteArmedId } = messageActions
const contentInteractionBlocked = computed(() => (
  blockingOverlayOpen.value || traceDrawerBlocking.value || agentDiscoveryPending.value
))
const composerContext = useComposerContext({
  activeGroup,
  activeRun,
  agentDescription,
  agentSkillsSnapshot,
  knowledgeBaseName,
  knowledgeBaseReady,
  loadAgentSkills,
  localKnowledgeBaseEntries,
  mergedCatalog,
  notify,
  onSubmit: (...args) => sendMessage(...args),
  preloadAgentSkills,
  sending,
  t,
  theme,
})
systemSettingsNavigation = useSystemSettingsNavigation({
  activeView,
  closeModal,
  focusedAgentKind,
  formError,
  installConfirmKind,
  loadKnowledgeBaseStatuses,
  modal,
  saving,
  systemSettingsSection,
})
const {
  captureComposerContext,
  clearComposerContext,
  automaticTeamFormation,
  composerMode,
  composerTargetKinds,
  discussionMode,
  disposeComposerContext,
  draft,
  resetComposerContext,
  restoreComposerContext,
  scheduleComposerResize,
  serializeComposerContext,
  skillMenuOpen,
} = composerContext
const composerTargetsReady = computed(() => (
  composerTargetKinds.value.length > 0
  && composerTargetKinds.value.every(kind => readyAgentKinds.value.has(kind))
))
const composerDisabled = computed(() => Boolean(activeRun.value) || sending.value)
const attachmentController = useComposerAttachments({
  activeGroup,
  attachmentsApi,
  composerDisabled,
  composerContextVersion,
  composerTargetKinds,
  mergedCatalog,
  notify,
  showError,
  t,
})
const {
  attachmentLimitMessage,
  composerAttachmentSupported,
  composerAttachments,
  discardAttachments,
  importingAttachment,
  safeAttachmentPayload,
} = attachmentController
const conversationExecution = useConversationExecution({
  activeGroup,
  activeRun,
  automaticTeamFormation,
  attachmentLimitMessage,
  captureComposerContext,
  clearComposerContext,
  composerAttachmentSupported,
  composerAttachments,
  composerContextVersion,
  composerMode,
  composerTargetKinds,
  composerTargetsReady,
  discardAttachments,
  draft,
  importingAttachment,
  maxRounds,
  normalizeSnapshot,
  notify,
  readyAgentKinds,
  restoreComposerContext,
  roundSettingsOpen,
  safeAttachmentPayload,
  sending,
  sendingGroupIds,
  serializeComposerContext,
  showError,
  snapshot,
  t,
  unlimitedRounds,
  workspace,
})
const { canSendMessage } = conversationExecution

function sendMessage(...args) {
  return conversationExecution.sendMessage(...args)
}

function stopRun(...args) {
  return conversationExecution.stopRun(...args)
}

async function decideHumanGate(payload = {}) {
  const gate = pendingHumanGates.value.find(item => item.gateId === payload.gateId)
  const option = gate?.options.find(item => item.optionId === payload.optionId)
  const response = typeof payload.response === 'string' ? payload.response.trim() : ''
  if (!gate || !option || humanGateDecisionPendingIds.value.includes(gate.gateId)) return false
  if ((gate.type === 'input' && option.kind === 'respond' && !response)
      || (gate.type !== 'input' && response)) return false
  const bridge = workspace.value
  if (!bridge?.decideHumanGate) return false
  humanGateDecisionPendingIds.value = [...humanGateDecisionPendingIds.value, gate.gateId]
  try {
    const result = await bridge.decideHumanGate(gate.gateId, {
      optionId: option.optionId,
      ...(response ? { response } : {}),
    })
    if (!['approved', 'rejected'].includes(result?.status)
        || result?.decision?.optionId !== option.optionId) {
      throw new Error('HUMAN_GATE_DECISION_FAILED')
    }
    return true
  } catch (error) {
    showError(error)
    return false
  } finally {
    humanGateDecisionPendingIds.value = humanGateDecisionPendingIds.value
      .filter(gateId => gateId !== gate.gateId)
  }
}

const roundProgressPercent = computed(() => {
  const bounded = Math.max(1, Math.min(10, Number(maxRounds.value) || 1))
  return `${((bounded - 1) / 9) * 100}%`
})
const conversationActions = useConversationActions({
  activeGroup,
  activeRun,
  activeView,
  closeModal,
  conversationHeader,
  directGroupsFor,
  formError,
  groupName,
  isDirectCreationPending,
  isGroupRunning,
  modal,
  openAgentManager,
  preloadAgentSkills,
  readyAgents,
  saving,
  selectedGroupId,
  selectGroup,
  sending,
  setDirectCreationPending,
  setSidebarAgentExpanded,
  showError,
  snapshot,
  t,
  translateError,
  workspace,
  workspaceModalContent,
})
const {
  cancelInlineTitleEdit,
  defaultDirectory,
  deleteArmed,
  openDirect,
  openNewGroup,
  settingsIntent,
  sidebarDeleteGroupId,
  sidebarDeletePopoverPoint,
} = conversationActions
const {
  composerController,
  conversationHeaderController,
  timelineController,
} = createConversationControllers({
  agentCatalog,
  agentSkills,
  app: {
    activeGroup,
    activeRun,
    canSendMessage,
    compactPath,
    conversationPermissionLabel,
    emptyShowcaseIndex,
    groupName,
    handleMessageScroll,
    maxRounds,
    messageScroller,
    productWordmark,
    requestUnlimitedRounds,
    roundProgressPercent,
    roundSettingsControl,
    roundSettingsOpen,
    saving,
    sendMessage,
    sending,
    scrollToLatest,
    showScrollToLatest,
    shortcutDefinitions,
    shortcutMenuOpen,
    stopRun,
    t,
    theme,
    translateSystemMessage,
    unlimitedRounds,
  },
  attachments: attachmentController,
  composerContext,
  conversationActions,
  knowledgeBase: knowledgeBaseSettings,
  messageActions,
  timeline: conversationTimeline,
})
Object.assign(timelineController, {
  decideHumanGate,
  directHumanGates,
  directRunBudget,
  humanGateDecisionPendingIds,
})

const modalTitle = computed(() => ({
  'new-group': t('group.newTitle'),
  settings: settingsIntent.value === 'rename'
    ? t(activeGroup.value?.conversationType === 'direct' ? 'settings.renameDirectTitle' : 'settings.renameGroupTitle')
    : t('settings.title'),
  'custom-agent': t('customAgent.title'),
  'unlimited-confirm': t('composer.unlimitedConfirmTitle'),
  'agent-detail': selectedAgentDetail.value?.label || t('systemSettings.openAgentDetailDefault'),
})[modal.value] || '')
const modalSubtitle = computed(() => ({
  settings: groupName(activeGroup.value),
  'custom-agent': t('customAgent.subtitle'),
  'agent-detail': agentDetailSkillSummary.value,
})[modal.value] || '')

const {
  systemSettingsController,
  workspaceModalController,
  workspaceSidebarController,
} = createWorkspaceControllers({
  agentCatalog,
  agentManagement,
  agentRefresh,
  agentSkills,
  app: {
    activeGroup,
    activeView,
    closeModal,
    cloudAgentBridges,
    confirmUnlimitedRounds,
    contentInteractionBlocked,
    customAgentDeleteArmed,
    focusedAgentKind,
    formError,
    goHome,
    groupName,
    handleSidebarAgentMain,
    installConfirmKind,
    installerState,
    isGroupRunning,
    modal,
    openAgentManager,
    openSystemSettings,
    productMark,
    refreshing,
    saving,
    selectGroup,
    selectedGroupId,
    selectSystemSettingsSection,
    sidebarAgentsCollapsed,
    sidebarGroupsCollapsed,
    sidebarCollapsed,
    sidebarDeleteGroup,
    sidebarDeletePopoverStyle,
    systemSettingsSection,
    t,
    theme,
    toggleLocale,
    toggleTheme,
  },
  collapsedGroupMenu: collapsedGroupMenuController,
  conversationActions,
  conversationNavigation,
  knowledgeBase: knowledgeBaseSettings,
  timeline: conversationTimeline,
})

useAppWindowInteractions({
  closeCollapsedGroupMenu,
  closeModal,
  closeTracePanel,
  collapsedGroupMenu,
  collapsedGroupMenuButton,
  collapsedGroupMenuOpen,
  completeOnboarding,
  conversationHeader,
  customAgentDeleteArmed,
  deleteArmed,
  messageDeleteArmedId,
  modal,
  onboardingVisible,
  openNewGroup,
  openSystemSettings,
  roundSettingsControl,
  roundSettingsOpen,
  selectGroup,
  selectedGroupId,
  shortcutMenuOpen,
  sidebarCollapsed,
  sidebarDeleteGroupId,
  skillMenuOpen,
  snapshot,
  sortByUpdated,
  tracePanelOpen,
  trapOverlayFocus,
})

const { booting, bridgeMissing } = useDesktopWorkspaceLifecycle({
  afterInitialLoad: () => {
    if (!onboardingCompleted.value && hasPersistedWorkspaceActivity(snapshot.value)) {
      completeOnboarding({ fromHistory: true })
    }
    if (!onboardingCompleted.value) {
      openOnboarding()
    } else {
      agentDiscoveryPending.value = true
      void refreshAgents().finally(() => { agentDiscoveryPending.value = false })
    }
    void loadKnowledgeBaseStatuses()
  },
  beforeBoot: () => {
    applyTheme(theme.value)
    setCustomAgentProfiles([])
    setCloudAgentProfiles([])
  },
  defaultDirectory,
  handleOpenGroup,
  handleRunFinished,
  installer,
  installerState,
  refreshAgents,
  showError,
  snapshot,
  workspace,
})

function conversationPermissionLabel(group) {
  const kinds = Array.isArray(group?.agentKinds) ? group.agentKinds : []
  const enforced = kinds.length && kinds.every(kind => READ_ONLY_ENFORCED_AGENT_KINDS.has(kind))
  if (!enforced) return t('conversation.agentManagedPermissions')
  return group?.allowWrite ? t('conversation.writeEnabled') : t('conversation.readOnly')
}

function compactPath(path) {
  const value = String(path || '')
  if (value.length <= 42) return value
  const parts = value.split(/[\\/]/).filter(Boolean)
  return parts.length >= 2 ? `.../${parts.slice(-2).join('/')}` : `${value.slice(0, 38)}...`
}

function openAgentManager(kind = '') {
  return systemSettingsNavigation.openAgentManager(kind)
}

function openSystemSettings(section = 'agents', kind = '') {
  return systemSettingsNavigation.openSystemSettings(section, kind)
}

function selectSystemSettingsSection(section) {
  return systemSettingsNavigation.selectSystemSettingsSection(section)
}

function requestUnlimitedRounds() {
  if (unlimitedRounds.value) return
  const groupId = roundSettingsGroupId()
  if (!groupId) return
  unlimitedConfirmationGroupId.value = groupId
  modal.value = 'unlimited-confirm'
}

function confirmUnlimitedRounds() {
  const groupId = unlimitedConfirmationGroupId.value
  if (
    !groupId
    || groupId !== roundSettingsGroupId()
    || !snapshot.value.groups.some(group => group.id === groupId)
  ) {
    closeModal()
    return
  }
  unlimitedRounds.value = true
  closeModal()
}

function roundSettingsGroupId(group = activeGroup.value) {
  if (!group || group.conversationType === 'direct') return ''
  return String(group.id || '')
}

function persistRoundSettings(groupId = roundSettingsGroupId()) {
  if (!groupId) return
  roundSettingsByGroupId.set(groupId, {
    maxRounds: Math.max(1, Math.min(10, Number(maxRounds.value) || DEFAULT_MAX_ROUNDS)),
    unlimitedRounds: unlimitedRounds.value === true,
  })
}

function restoreRoundSettings(group = activeGroup.value) {
  const groupId = roundSettingsGroupId(group)
  const saved = groupId ? roundSettingsByGroupId.get(groupId) : null
  maxRounds.value = Math.max(1, Math.min(10, Number(saved?.maxRounds) || DEFAULT_MAX_ROUNDS))
  unlimitedRounds.value = saved?.unlimitedRounds === true
}

function closeModal(options = {}) {
  if (saving.value && options?.force !== true) return false
  if (!modal.value) return false
  modal.value = ''
  settingsIntent.value = 'settings'
  formError.value = ''
  deleteArmed.value = false
  customAgentDeleteArmed.value = false
  installConfirmKind.value = ''
  focusedAgentKind.value = ''
  unlimitedConfirmationGroupId.value = ''
  resetAgentDetailSkills()
  return true
}

watch(() => snapshot.value.messages.map(message => message.id).join('\u0000'), () => {
  flushPendingRunFinishedEvents()
  if (
    messageDeleteArmedId.value
    && !snapshot.value.messages.some(message => message.id === messageDeleteArmedId.value)
  ) {
    messageDeleteArmedId.value = ''
  }
})
watch([maxRounds, unlimitedRounds], () => {
  persistRoundSettings()
})
watch(activeGroupMemberSignature, (value, previous) => {
  const currentGroupId = String(value || '').split('\u0000')[0]
  const previousGroupId = String(previous || '').split('\u0000')[0]
  if (
    modal.value === 'unlimited-confirm'
    && unlimitedConfirmationGroupId.value !== currentGroupId
  ) closeModal()
  if (previousGroupId && previousGroupId !== currentGroupId) persistRoundSettings(previousGroupId)
  restoreRoundSettings(activeGroup.value)
  composerContextVersion.value += 1
  const abandonedAttachments = composerAttachments.value
  const group = activeGroup.value
  cancelInlineTitleEdit({ restoreFocus: false })
  messageDeleteArmedId.value = ''
  clearActiveTurn()
  roundSettingsOpen.value = false
  resetComposerContext(group)
  composerAttachments.value = []
  void discardAttachments(abandonedAttachments)
})
watch(activeRun, (value) => {
  if (!value) return
  messageDeleteArmedId.value = ''
  roundSettingsOpen.value = false
  cancelInlineTitleEdit({ restoreFocus: false })
})
watch(discussionMode, (value) => {
  if (value !== 'auto') roundSettingsOpen.value = false
})
watch(
  [draft, () => composerAttachments.value.length, activeGroupMemberSignature],
  scheduleComposerResize,
  { flush: 'post' },
)
watch(activeRunTopicSignature, async (value) => {
  if (!value) return
  await focusRunTopic()
  await scrollToLatest({ force: true })
})
watch(readyAgentSignature, (value) => { if (value) void loadAgentSkillStats() })
watch(() => installerState.value.phase, (phase, previous) => {
  if (phase === 'completed' && previous !== 'completed') void refreshAgents()
})

onBeforeUnmount(() => {
  composerContextVersion.value += 1
  const abandonedAttachments = composerAttachments.value
  composerAttachments.value = []
  void discardAttachments(abandonedAttachments)
  disposeComposerContext()
  disposeAgentSkills()
  clearPendingRunFinishedEvents()
})
</script>

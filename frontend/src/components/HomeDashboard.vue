<template>
  <section class="agent-home home-dashboard" :data-home-mode="homeMode">
    <header class="home-dashboard-header">
      <div>
        <h1>{{ t('home.dashboardTitle') }}</h1>
        <p>{{ t('home.dashboardSubtitle') }}</p>
      </div>
      <div class="home-workspace-state" :class="{ attention: homeNeedsAttention }" role="status">
        <WarningOutline v-if="homeNeedsAttention" />
        <CheckmarkCircleOutline v-else />
        <span>{{ homeWorkspaceSummary }}</span>
      </div>
    </header>

    <section v-if="showRecoveryGuide" class="home-recovery-notice" aria-live="polite">
      <WarningOutline />
      <div>
        <h2>{{ t('home.recoveryTitle') }}</h2>
        <p>{{ t('home.recoveryBody') }}</p>
      </div>
      <button class="secondary-button compact" type="button" @click="$emit('open-agent-manager')">
        <SettingsOutline />
        {{ t('home.openSettings') }}
      </button>
    </section>

    <div v-if="!showSetupGuide" class="home-dashboard-grid">
      <section class="home-panel home-recent-panel">
        <header class="home-panel-header">
          <div>
            <h2>{{ t(homeMode === 'first-task' ? 'home.firstTaskTitle' : 'home.recentTitle') }}</h2>
            <p>{{ t(homeMode === 'first-task' ? 'home.firstTaskSubtitle' : 'home.recentSubtitle') }}</p>
          </div>
        </header>
        <div v-if="recentGroups.length" class="home-recent-list">
          <button
            v-for="group in recentGroups"
            :key="group.id"
            class="home-recent-item"
            type="button"
            @click="$emit('select-group', group.id)"
          >
            <span class="home-recent-avatar">
              <ChatbubblesOutline v-if="group.conversationType !== 'direct'" />
              <img v-else :src="agentLogo(group.directAgentKind, theme)" alt="" />
            </span>
            <span class="home-recent-copy">
              <strong>{{ groupName(group) }}</strong>
              <small>{{ recentGroupMeta(group) }}</small>
            </span>
            <span v-if="isGroupRunning(group.id)" class="run-mark" :title="t('conversation.runningGeneric')">
              <span class="run-pulse" />
            </span>
            <ChevronForwardOutline />
          </button>
        </div>
        <div v-else class="home-panel-empty">
          <ChatbubblesOutline />
          <p>{{ t('home.recentEmpty') }}</p>
          <button
            v-if="homeMode === 'first-task'"
            class="primary-button compact"
            type="button"
            :disabled="readyCount < 2"
            @click="$emit('open-new-group')"
          >
            <AddOutline />
            {{ t('nav.newGroup') }}
          </button>
        </div>
      </section>

      <section class="home-panel home-agent-panel">
        <header class="home-panel-header">
          <div>
            <h2>{{ t('home.agentStatusTitle') }}</h2>
            <p>{{ t('home.agentStatusSubtitle') }}</p>
          </div>
          <button
            v-if="homeMode !== 'first-task'"
            class="secondary-button compact home-new-group-button"
            type="button"
            :disabled="readyCount < 2"
            @click="$emit('open-new-group')"
          >
            <AddOutline />
            {{ t('nav.newGroup') }}
          </button>
        </header>
        <div v-if="homeAgentPreview.length" class="home-agent-list">
          <button
            v-for="agent in homeAgentPreview"
            :key="agent.kind"
            type="button"
            class="home-agent-item"
            @click="$emit('open-direct', agent)"
          >
            <img :src="agent.logo" :alt="agent.label" />
            <span>
              <strong>{{ agent.label }}</strong>
              <small>{{ agentDescription(agent.kind) }}</small>
            </span>
            <ChevronForwardOutline />
          </button>
        </div>
        <div v-else class="home-panel-empty">
          <TerminalOutline />
          <p>{{ t('home.noReadyAgents') }}</p>
        </div>
      </section>
    </div>

    <section v-if="showSetupGuide" class="setup-guide" :aria-label="t('setupGuide.title')">
      <header>
        <div>
          <h2>{{ t('setupGuide.title') }}</h2>
          <p>{{ setupGuideMessage }}</p>
        </div>
      </header>
      <ol>
        <li :class="{ complete: installedCount > 0 }">
          <CheckmarkCircleOutline v-if="installedCount > 0" />
          <RefreshOutline v-else />
          <span>
            <strong>{{ t('setupGuide.detectTitle') }}</strong>
            <small>{{ t('setupGuide.detectBody') }}</small>
          </span>
        </li>
        <li :class="{ complete: readyCount > 0 }">
          <CheckmarkCircleOutline v-if="readyCount > 0" />
          <ChatbubblesOutline v-else />
          <span>
            <strong>{{ t('setupGuide.chatTitle') }}</strong>
            <small>{{ t('setupGuide.chatBody') }}</small>
          </span>
        </li>
      </ol>
      <footer>
        <button class="secondary-button" type="button" :disabled="refreshing" @click="$emit('refresh-agents')">
          <RefreshOutline :class="{ spinning: refreshing }" />
          {{ refreshing ? t('home.refreshing') : t('home.refresh') }}
        </button>
        <button class="primary-button" type="button" @click="$emit('open-agent-manager')">
          <SettingsOutline />
          {{ t('home.openSettings') }}
        </button>
      </footer>
    </section>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import {
  AddOutline,
  ChatbubblesOutline,
  CheckmarkCircleOutline,
  ChevronForwardOutline,
  RefreshOutline,
  SettingsOutline,
  TerminalOutline,
  WarningOutline,
} from '@vicons/ionicons5'
import { agentLogo } from '../catalog.js'
import { t } from '../i18n.js'

const props = defineProps({
  agentDescription: { type: Function, required: true },
  groupName: { type: Function, required: true },
  groups: { type: Array, required: true },
  installedCount: { type: Number, required: true },
  isGroupRunning: { type: Function, required: true },
  onboardingCompleted: { type: Boolean, required: true },
  readyAgents: { type: Array, required: true },
  recentGroupMeta: { type: Function, required: true },
  refreshing: { type: Boolean, required: true },
  theme: { type: String, required: true },
})

defineEmits([
  'open-agent-manager',
  'open-direct',
  'open-new-group',
  'refresh-agents',
  'select-group',
])

const readyCount = computed(() => props.readyAgents.length)
const recentGroups = computed(() => props.groups.slice().sort((left, right) => (
  new Date(right.updatedAt || right.createdAt || 0).getTime()
  - new Date(left.updatedAt || left.createdAt || 0).getTime()
)).slice(0, 6))
const homeAgentPreview = computed(() => props.readyAgents.slice(0, 5))
const homeMode = computed(() => {
  if (props.groups.length) return 'workspace'
  return readyCount.value > 0 ? 'first-task' : 'setup'
})
const homeNeedsAttention = computed(() => readyCount.value === 0)
const showSetupGuide = computed(() => props.onboardingCompleted && homeMode.value === 'setup')
const showRecoveryGuide = computed(() => (
  props.onboardingCompleted && homeMode.value === 'workspace' && homeNeedsAttention.value
))
const homeWorkspaceSummary = computed(() => (
  homeNeedsAttention.value
    ? t('home.setupNeeded')
    : t('home.workspaceSummary', {
        agents: readyCount.value,
        conversations: props.groups.length,
      })
))
const setupGuideMessage = computed(() => t('setupGuide.detectBody'))
</script>

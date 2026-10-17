<template>
  <section class="settings-panel agent-manager">
    <div class="manager-toolbar">
      <span>{{ t('home.readyCount', { ready: readyCount, installed: installedCount }) }}</span>
      <div class="manager-toolbar-actions">
        <button class="secondary-button" type="button" :disabled="refreshing" @click="$emit('refresh-agents')">
          <RefreshOutline :class="{ spinning: refreshing }" />
          {{ t('installer.refresh') }}
        </button>
      </div>
    </div>
    <section v-for="category in agentCatalogGroups" :key="category.id" class="agent-catalog-category">
      <header class="agent-catalog-category-header">
        <div>
          <h2>{{ t(category.titleKey) }}</h2>
          <p>{{ t(category.subtitleKey) }}</p>
        </div>
        <small>{{ t('systemSettings.agentCount', { count: category.agents.length }) }}</small>
      </header>
      <div v-if="category.agents.length" class="agent-grid settings-agent-grid">
        <article
          v-for="agent in category.agents"
          :key="agent.kind"
          class="agent-card settings-agent-card"
          :class="{ focused: focusedAgentKind === agent.kind }"
        >
          <button
            class="agent-card-main"
            type="button"
            :title="t('systemSettings.openAgentDetail', { agent: agent.label })"
            @click="$emit('open-agent-detail', agent)"
          >
            <span class="settings-agent-logo" :class="{ cloud: agent.cloud }">
              <img :src="agent.logo" :alt="agent.label" />
              <CloudOutline v-if="agent.cloud" aria-hidden="true" />
            </span>
            <span class="agent-card-copy">
              <span class="agent-name-row">
                <strong>{{ agent.label }}</strong>
                <span class="agent-state" :class="agentState(agent).tone">
                  <component :is="agentState(agent).icon" />
                  {{ agentState(agent).label }}
                </span>
              </span>
              <span class="agent-card-description">{{ agentDescription(agent.kind) }}</span>
              <span class="agent-capability-list">
                <span v-if="agent.ready">{{ agentSkillLabel(agent.kind) }}</span>
                <span>{{ agentImageLabel(agent) }}</span>
              </span>
            </span>
            <ChevronForwardOutline class="card-chevron" />
          </button>
          <div v-if="installConfirmKind === agent.kind" class="install-confirm">
            <strong>{{ t('installer.confirm', { agent: agent.label }) }}</strong>
            <span>{{ t('installer.confirmHint') }}</span>
          </div>
          <div v-if="installerState.kind === agent.kind && installerState.phase !== 'idle'" class="install-progress">
            <span>{{ installerPhaseLabel }}</span>
          </div>
          <p v-if="agentStateNote(agent)" class="agent-card-note" :data-tone="agentState(agent).tone">
            <span>{{ agentStateNote(agent) }}</span>
            <button type="button" :disabled="refreshing" @click.stop="$emit('refresh-agents')">
              {{ t('home.refresh') }}
            </button>
          </p>
          <div class="agent-card-meta-row">
            <span
              v-if="agent.version"
              class="agent-version"
              :title="t('agent.detectedVersion', { version: agent.version })"
            >
              {{ t('agent.detectedVersion', { version: agent.version }) }}
            </span>
            <div class="agent-card-actions settings-agent-actions">
              <button
                v-if="agent.ready"
                type="button"
                :disabled="isDirectCreationPending(agent.kind)"
                @click.stop="$emit('open-direct', agent)"
              >
                <ChatbubbleEllipsesOutline />
                {{ t('home.openChat') }}
              </button>
              <button
                v-else-if="!agent.installed && agent.installSupported"
                type="button"
                :disabled="installerBusy && installerState.kind !== agent.kind"
                @click.stop="$emit('request-install', agent)"
              >
                <DownloadOutline />
                {{ installConfirmKind === agent.kind ? t('installer.confirm', { agent: agent.label }) : t('installer.install') }}
              </button>
              <span v-else-if="!agent.installed" class="manager-note">
                {{ agent.custom
                  ? t('customAgent.executableUnavailable')
                  : agent.installErrorCode === 'INSTALL_AGENT_NODE_REQUIRED'
                    ? t('installer.nodeRequired')
                    : t('installer.unsupported') }}
              </span>
              <button
                v-if="installerState.kind === agent.kind && installerState.canCancel"
                type="button"
                @click.stop="$emit('cancel-install')"
              >
                {{ t('installer.cancel') }}
              </button>
            </div>
          </div>
        </article>
      </div>
      <div v-else class="custom-agent-empty">
        <span>{{ t('customAgent.empty') }}</span>
      </div>
    </section>
  </section>
</template>

<script setup>
import {
  ChatbubbleEllipsesOutline,
  ChevronForwardOutline,
  CloudOutline,
  DownloadOutline,
  RefreshOutline,
} from '@vicons/ionicons5'
import { t } from '../i18n.js'

defineProps({
  agentCatalogGroups: { type: Array, required: true },
  agentDescription: { type: Function, required: true },
  agentImageLabel: { type: Function, required: true },
  agentSkillLabel: { type: Function, required: true },
  agentState: { type: Function, required: true },
  agentStateNote: { type: Function, default: () => '' },
  focusedAgentKind: { type: String, required: true },
  installConfirmKind: { type: String, required: true },
  installedCount: { type: Number, required: true },
  installerBusy: { type: Boolean, required: true },
  installerPhaseLabel: { type: String, required: true },
  installerState: { type: Object, required: true },
  isDirectCreationPending: { type: Function, required: true },
  readyCount: { type: Number, required: true },
  refreshing: { type: Boolean, required: true },
})

defineEmits([
  'cancel-install',
  'open-agent-detail',
  'open-direct',
  'refresh-agents',
  'request-install',
])
</script>

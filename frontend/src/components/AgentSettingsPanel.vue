<template>
  <section class="settings-panel agent-manager">
    <div class="manager-toolbar">
      <div class="manager-toolbar-actions">
        <button class="secondary-button" type="button" :disabled="refreshing" @click="$emit('refresh-agents')">
          <RefreshOutline :class="{ spinning: refreshing }" />
          {{ t('installer.refresh') }}
        </button>
      </div>
    </div>
    <section v-for="category in agentCatalogGroups" :key="category.id" class="agent-catalog-category">
      <SettingsCardRail v-if="category.agents.length" :label="t(category.titleKey)">
        <template #heading>
          <header class="agent-catalog-category-header"><div>
            <h2><component :is="category.id === 'cloud' ? CloudOutline : TerminalOutline" class="category-icon" />{{ t(category.titleKey) }}<slot v-if="category.id === 'cloud'" name="toolbar" /></h2>
          </div></header>
        </template>
        <article
          v-for="agent in category.agents"
          :key="agent.kind"
          class="agent-card settings-agent-card"
          :class="{ focused: focusedAgentKind === agent.kind }"
          @click="$emit('open-agent-detail', agent)"
        >
          <div class="rail-card-surface">
          <button
            class="agent-card-main"
            type="button"
            :aria-label="t('systemSettings.openAgentDetail', { agent: agent.label })"
          >
            <span class="settings-agent-logo" :class="{ cloud: agent.cloud }">
              <img :src="agent.logo" :alt="agent.label" />
              <CloudOutline v-if="agent.cloud" aria-hidden="true" />
            </span>
            <span class="agent-card-copy">
              <span class="agent-name-row">
                <strong>{{ agent.label }}</strong>
                <span class="agent-state" :class="agentState(agent).tone" :title="agentState(agent).description || agentState(agent).label">
                  <component :is="agentState(agent).icon" />
                  {{ agentState(agent).label }}
                </span>
              </span>
            </span>
          </button>
          <div v-if="installConfirmKind === agent.kind" class="install-confirm">
            <strong>{{ t('installer.confirm', { agent: agent.label }) }}</strong>
            <span>{{ t('installer.confirmHint') }}</span>
          </div>
          <div v-if="installerState.kind === agent.kind && installerState.phase !== 'idle'" class="install-progress">
            <span>{{ installerPhaseLabel }}</span>
          </div>
          <div class="agent-card-meta-row">
            <div class="agent-card-actions settings-agent-actions">
              <button v-if="agent.installed && !agent.ready" class="agent-card-recheck" type="button" :title="t('home.refresh')" :aria-label="t('home.refresh')" :disabled="refreshing" @click.stop="$emit(agent.cloud ? 'refresh-cloud-agents' : 'refresh-agents')"><RefreshOutline /></button>
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
          </div>
        </article>
      </SettingsCardRail>
      <div v-else class="custom-agent-empty">
        <span>{{ t('customAgent.empty') }}</span>
      </div>
    </section>
    <section v-if="!agentCatalogGroups.some(category => category.id === 'cloud')" class="agent-catalog-category cloud-empty-section">
      <header class="agent-catalog-category-header"><h2><CloudOutline class="category-icon" />{{ t('systemSettings.cloudAgents') }}<slot name="toolbar" /></h2></header>
      <p class="cloud-empty-copy">{{ t('cloudAgents.empty') }}</p>
    </section>
  </section>
</template>

<script setup>
import {
  ChatbubbleEllipsesOutline,
  TerminalOutline,
  CloudOutline,
  DownloadOutline,
  RefreshOutline,
} from '@vicons/ionicons5'
import { t } from '../i18n.js'
import SettingsCardRail from './SettingsCardRail.vue'

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
  'refresh-cloud-agents',
  'request-install',
])
</script>

<style scoped>
.agent-catalog-category-header h2 { display:flex; align-items:center; gap:8px; margin:0; font-size:14px; }
.cloud-empty-copy { margin:12px 0 20px; color:var(--muted); font-size:12px; }
.category-icon { width:17px; height:17px; flex:none; }
</style>

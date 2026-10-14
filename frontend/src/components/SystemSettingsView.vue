<template>
  <section class="system-settings-page">
    <header class="system-settings-header">
      <div>
        <h1>{{ t('systemSettings.title') }}</h1>
        <p>{{ t('systemSettings.subtitle') }}</p>
      </div>
    </header>

    <div class="system-settings-body">
      <nav class="settings-tabs" role="tablist" :aria-label="t('systemSettings.title')">
        <button
          type="button"
          role="tab"
          :aria-selected="systemSettingsSection === 'agents'"
          :class="{ active: systemSettingsSection === 'agents' }"
          @click="selectSystemSettingsSection('agents')"
        >
          <TerminalOutline />
          {{ t('systemSettings.agents') }}
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="systemSettingsSection === 'cloud-agents'"
          :class="{ active: systemSettingsSection === 'cloud-agents' }"
          @click="selectSystemSettingsSection('cloud-agents')"
        >
          <CloudOutline />
          {{ t('systemSettings.cloudServers') }}
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="systemSettingsSection === 'knowledge-bases'"
          :class="{ active: systemSettingsSection === 'knowledge-bases' }"
          @click="selectSystemSettingsSection('knowledge-bases')"
        >
          <LibraryOutline />
          {{ t('systemSettings.knowledgeBases') }}
        </button>
      </nav>

      <AgentSettingsPanel
        v-if="systemSettingsSection === 'agents'"
        :agent-catalog-groups="agentCatalogGroups"
        :agent-description="agentDescription"
        :agent-image-label="agentImageLabel"
        :agent-skill-label="agentSkillLabel"
        :agent-state="agentState"
        :focused-agent-kind="focusedAgentKind"
        :install-confirm-kind="installConfirmKind"
        :installed-count="installedCount"
        :installer-busy="installerBusy"
        :installer-phase-label="installerPhaseLabel"
        :installer-state="installerState"
        :is-direct-creation-pending="isDirectCreationPending"
        :ready-count="readyCount"
        :refreshing="refreshing"
        @cancel-install="cancelInstall"
        @open-agent-detail="openAgentDetail"
        @open-direct="openDirect"
        @refresh-agents="refreshAgents"
        @request-install="requestInstall"
      />

      <CloudAgentBridgePanel
        v-else-if="systemSettingsSection === 'cloud-agents'"
        :controller="cloudAgentBridges"
      />

      <KnowledgeBaseSettingsPanel
        v-else-if="systemSettingsSection === 'knowledge-bases'"
        :icon="knowledgeBaseIcon"
        :loading="knowledgeBaseLoading"
        :local-entries="localKnowledgeBaseEntries"
        :location-label="knowledgeBaseLocationLabel"
        :pending="knowledgeBasePending"
        :planned-entries="plannedKnowledgeBaseEntries"
        :primary-action-label="knowledgeBasePrimaryActionLabel"
        :ready-count="readyKnowledgeBaseCount"
        :status-label="knowledgeBaseStatusLabel"
        :tag-items="knowledgeBaseTagItems"
        :tone="knowledgeBaseTone"
        @primary-action="runKnowledgeBasePrimaryAction"
        @refresh="loadKnowledgeBaseStatuses"
      />
    </div>
  </section>
</template>

<script setup>
import { CloudOutline, LibraryOutline, TerminalOutline } from '@vicons/ionicons5'
import AgentSettingsPanel from './AgentSettingsPanel.vue'
import CloudAgentBridgePanel from './CloudAgentBridgePanel.vue'
import KnowledgeBaseSettingsPanel from './KnowledgeBaseSettingsPanel.vue'

const props = defineProps({
  controller: { type: Object, required: true },
})

const {
  agentCatalogGroups,
  agentDescription,
  agentImageLabel,
  agentSkillLabel,
  agentState,
  cancelInstall,
  cloudAgentBridges,
  focusedAgentKind,
  installConfirmKind,
  installedCount,
  installerBusy,
  installerPhaseLabel,
  installerState,
  isDirectCreationPending,
  knowledgeBaseIcon,
  knowledgeBaseLoading,
  knowledgeBaseLocationLabel,
  knowledgeBasePending,
  knowledgeBasePrimaryActionLabel,
  knowledgeBaseStatusLabel,
  knowledgeBaseTagItems,
  knowledgeBaseTone,
  loadKnowledgeBaseStatuses,
  localKnowledgeBaseEntries,
  openAgentDetail,
  openDirect,
  plannedKnowledgeBaseEntries,
  readyCount,
  readyKnowledgeBaseCount,
  refreshAgents,
  refreshing,
  requestInstall,
  runKnowledgeBasePrimaryAction,
  selectSystemSettingsSection,
  systemSettingsSection,
  t,
} = props.controller
</script>

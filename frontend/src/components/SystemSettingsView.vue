<template>
  <section class="system-settings-page" :aria-label="t('systemSettings.title')">
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
        <button
          type="button"
          role="tab"
          :aria-selected="systemSettingsSection === 'general'"
          :class="{ active: systemSettingsSection === 'general' }"
          @click="selectSystemSettingsSection('general')"
        >
          <OptionsOutline />
          {{ t('systemSettings.general') }}
        </button>
      </nav>

      <AgentSettingsPanel
        v-if="systemSettingsSection === 'agents'"
        :agent-catalog-groups="agentCatalogGroups"
        :agent-description="agentDescription"
        :agent-image-label="agentImageLabel"
        :agent-skill-label="agentSkillLabel"
        :agent-state="agentState"
        :agent-state-note="agentStateNote"
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

      <GeneralSettingsPanel
        v-else-if="systemSettingsSection === 'general'"
        :set-theme-preference="setThemePreference"
        :theme-preference="themePreference"
      />
    </div>
  </section>
</template>

<script setup>
import { CloudOutline, LibraryOutline, OptionsOutline, TerminalOutline } from '@vicons/ionicons5'
import AgentSettingsPanel from './AgentSettingsPanel.vue'
import CloudAgentBridgePanel from './CloudAgentBridgePanel.vue'
import GeneralSettingsPanel from './GeneralSettingsPanel.vue'
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
  agentStateNote,
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
  setThemePreference,
  systemSettingsSection,
  t,
  themePreference,
} = props.controller
</script>

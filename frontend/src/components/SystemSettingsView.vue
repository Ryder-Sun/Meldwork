<template>
  <section class="system-settings-page" :aria-label="t('systemSettings.title')">
    <div class="system-settings-body">
      <nav class="settings-tabs" role="tablist" :aria-label="t('systemSettings.title')">
        <button
          type="button"
          role="tab"
          :aria-selected="systemSettingsSection !== 'general'"
          :class="{ active: systemSettingsSection !== 'general' }"
          @click="selectSystemSettingsSection('agents')"
        >
          <TerminalOutline />
          {{ t('systemSettings.agents') }}
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

      <div v-if="systemSettingsSection !== 'general'" class="unified-agent-catalog">
      <AgentSettingsPanel
        v-if="systemSettingsSection !== 'general'"
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
        @refresh-cloud-agents="cloudAgentBridges.refresh"
        @request-install="requestInstall"
      >
        <template #toolbar><span class="catalog-cloud-toolbar"><button type="button" class="cloud-edit-button" :title="t('systemSettings.editCloudServers')" :aria-label="t('systemSettings.editCloudServers')" :aria-expanded="cloudExpanded" @click="openCloudDialog"><CreateOutline />{{ t('systemSettings.configureServers') }}</button></span></template>
      </AgentSettingsPanel>

      <section v-if="cloudExpanded" ref="cloudInline" class="cloud-inline" @keydown.esc="closeCloud"><button type="button" class="cloud-back" @click="closeCloud"><CloseOutline />{{ t('common.close') }}</button><CloudAgentBridgePanel :controller="cloudAgentBridges" /></section>
      <KnowledgeBaseSettingsPanel
        v-if="systemSettingsSection !== 'general'"
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

      <GeneralSettingsPanel
        v-else-if="systemSettingsSection === 'general'"
        :set-theme-preference="setThemePreference"
        :theme-preference="themePreference"
      />
    </div>

  </section>
</template>

<script setup>
import { ref, nextTick, watch } from 'vue'
import { CreateOutline, CloseOutline, OptionsOutline, TerminalOutline } from '@vicons/ionicons5'
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
const cloudExpanded = ref(systemSettingsSection.value === 'cloud-agents')
const cloudInline = ref(null)
async function openCloudDialog() {
  cloudExpanded.value = !cloudExpanded.value
  if (cloudExpanded.value) {
    await nextTick()
    cloudInline.value?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
    cloudInline.value?.querySelector('input')?.focus({ preventScroll: true })
  }
}
function closeCloud() {
  cloudExpanded.value = false
  nextTick(() => document.querySelector('.catalog-cloud-toolbar button')?.focus())
}
watch(systemSettingsSection, section => { cloudExpanded.value = section === 'cloud-agents' })
</script>

<style scoped>
.unified-agent-catalog { min-height: 0; overflow-y: auto; padding-bottom: 16px; }
.unified-agent-catalog :deep(.settings-panel) { overflow: visible; padding-top: 4px; padding-bottom: 8px; }
.unified-agent-catalog :deep(.manager-toolbar) { position: static; margin: 0 0 12px; }
.catalog-cloud-toolbar { display: flex; }
.cloud-inline { margin: 0 0 10px; padding: 24px; border-radius: 16px; background: var(--surface-raised); }
.cloud-back { display: flex; align-items: center; gap: 6px; margin-left: auto; border: 0; background: transparent; color: var(--muted); cursor: pointer; min-height: 44px; }
.cloud-back svg { width: 18px; }
.unified-agent-catalog { padding-top: 12px; }
.unified-agent-catalog :deep(.agent-catalog-category) { margin: 0 0 10px; }
.unified-agent-catalog :deep(.agent-catalog-category-header h2) { font-size: 14px; }
.unified-agent-catalog :deep(.knowledge-base-toolbar) { margin-bottom: 0; }

.cloud-edit-button { display:flex; align-items:center; gap:5px; width:auto; height:32px; border:0; padding:6px 8px; font-size:12px; font-weight:500; border-radius:8px; background:transparent; color:var(--muted); cursor:pointer; }
.cloud-edit-button svg { width:17px; height:17px; }
.cloud-edit-button:hover { background:var(--surface-raised); color:var(--accent-text); }
.cloud-edit-button:focus-visible { outline:2px solid var(--accent-text); }
.unified-agent-catalog :deep(.manager-toolbar) { margin:0; min-height:32px; }
.unified-agent-catalog :deep(.knowledge-base-toolbar) { min-height:0; height:0; position:relative; }
.unified-agent-catalog :deep(.knowledge-base-toolbar > button) { position:absolute; right:0; top:0; z-index:1; font-size:12px; border:0; background:transparent; min-height:32px; }
.unified-agent-catalog :deep(.knowledge-base-group-header h3) { margin:0; font-size:14px; }
.unified-agent-catalog :deep(.knowledge-base-group-header) { margin:0; min-height:32px; display:flex; align-items:center; }
</style>

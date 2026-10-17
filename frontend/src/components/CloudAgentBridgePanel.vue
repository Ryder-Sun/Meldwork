<template>
  <section class="settings-panel cloud-agent-bridge-panel">
    <div class="manager-toolbar">
      <div>
        <h2>{{ t('cloudAgents.title') }}</h2>
        <p>{{ t('cloudAgents.subtitle') }}</p>
      </div>
      <button class="secondary-button" type="button" :disabled="loading || saving" @click="refresh">
        <RefreshOutline :class="{ spinning: loading }" />
        {{ t('cloudAgents.refresh') }}
      </button>
    </div>

    <form class="cloud-agent-connect-form" @submit.prevent="connect">
      <label>
        <span>{{ t('cloudAgents.address') }}</span>
        <input
          v-model="address"
          type="text"
          inputmode="url"
          :placeholder="t('cloudAgents.addressPlaceholder')"
          :disabled="saving"
          required
        />
      </label>
      <label>
        <span>{{ t('cloudAgents.label') }}</span>
        <input
          v-model="label"
          type="text"
          autocomplete="off"
          :placeholder="t('cloudAgents.labelPlaceholder')"
          :disabled="saving"
        />
      </label>
      <button class="primary-button" type="submit" :disabled="saving || !address.trim()">
        <CloudOutline />
        {{ t('cloudAgents.connect') }}
      </button>
    </form>

    <p v-if="error" class="cloud-agent-bridge-error" role="alert">{{ translateError(error) }}</p>

    <div v-if="bridges.length" class="cloud-agent-bridge-list">
      <article v-for="bridge in bridges" :key="bridge.bridgeId" class="cloud-agent-bridge-item">
        <div class="cloud-agent-bridge-item-main">
          <strong>{{ bridge.label }}</strong>
          <span>{{ bridge.address }}</span>
          <small :class="bridge.available ? 'bridge-online' : 'bridge-offline'">
            {{ bridge.available ? t('cloudAgents.online') : t('cloudAgents.offline') }}
          </small>
          <small>{{ transportLabel(bridge.transport) }}</small>
          <small v-if="bridge.agents?.length">
            {{ t('cloudAgents.agentCount', { count: bridge.agents.length }) }}
          </small>
          <p v-if="bridge.agents?.length" class="cloud-agent-bridge-agent-list">
            {{ agentSummary(bridge.agents) }}
          </p>
          <small v-if="!bridge.available && bridge.lastError">{{ translateError(bridge.lastError) }}</small>
        </div>
        <div v-if="confirmingBridgeId === bridge.bridgeId" class="cloud-agent-bridge-confirm" role="group" :aria-label="t('cloudAgents.deletePrompt')">
          <span>{{ t('cloudAgents.deletePrompt') }}</span>
          <button class="secondary-button compact" type="button" :disabled="saving" @click="confirmingBridgeId = ''">
            {{ t('common.cancel') }}
          </button>
          <button class="danger-button compact" type="button" :disabled="saving" @click="confirmRemove(bridge.bridgeId)">
            {{ t('cloudAgents.delete') }}
          </button>
        </div>
        <button
          v-else
          class="icon-button"
          type="button"
          :title="t('cloudAgents.delete')"
          :aria-label="t('cloudAgents.delete')"
          :disabled="saving"
          @click="confirmingBridgeId = bridge.bridgeId"
        >
          <TrashOutline />
        </button>
      </article>
    </div>
    <p v-else-if="!loading" class="cloud-agent-bridge-empty">{{ t('cloudAgents.empty') }}</p>
  </section>
</template>

<script setup>
import { ref } from 'vue'
import { CloudOutline, RefreshOutline, TrashOutline } from '@vicons/ionicons5'
import { t, translateError } from '../i18n.js'

const props = defineProps({
  controller: { type: Object, required: true },
})

const {
  address,
  bridges,
  connect,
  error,
  label,
  loading,
  refresh,
  remove,
  saving,
} = props.controller

const confirmingBridgeId = ref('')

async function confirmRemove(bridgeId) {
  confirmingBridgeId.value = ''
  await remove(bridgeId)
}

function transportLabel(transport) {
  return t(`cloudAgents.transport.${transport || 'bridge'}`)
}

function agentSummary(agents) {
  return agents.map(agent => agent.label || agent.id).filter(Boolean).join(', ')
}
</script>

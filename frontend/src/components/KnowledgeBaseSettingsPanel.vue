<template>
  <section
    class="settings-panel knowledge-base-manager knowledge-base-panel"
    :aria-busy="String(loading)"
  >
    <div class="manager-toolbar knowledge-base-toolbar">
      <span class="knowledge-base-ready-summary visually-hidden" role="status" aria-live="polite">
        {{ loading ? t('knowledgeBase.status.checking') : t('knowledgeBase.readyCount', { ready: readyCount, total: localEntries.length }) }}
      </span>

    </div>
    <div class="knowledge-base-sections">
      <section class="knowledge-base-group" aria-labelledby="knowledge-base-group-local">
        <SettingsCardRail compact :label="t('systemSettings.knowledgeBases')">
          <template #heading><header class="knowledge-base-group-header"><h3 id="knowledge-base-group-local"><LibraryOutline class="knowledge-title-icon" />{{ t('systemSettings.knowledgeBases') }}</h3></header></template>
          <article
            v-for="source in localEntries"
            :key="source.kind"
            class="knowledge-base-item"
            :class="{ pending: pending(source) }"
          >
            <button type="button" class="knowledge-base-item-main" aria-pressed="false">
              <img class="knowledge-base-logo" :src="source.logo" :alt="t(`knowledgeBase.source.${source.kind}`)" />
              <div class="knowledge-base-item-copy">
                <div class="knowledge-base-item-title-row">
                  <strong>{{ t(`knowledgeBase.source.${source.kind}`) }}</strong>
                  <span class="knowledge-base-status" :class="tone(source)">
                    <component :is="icon(source)" :class="{ spinning: pending(source) }" />
                    {{ statusLabel(source) }}
                  </span>
                </div>

              </div>
            </button>
            <button
              class="knowledge-base-action"
              type="button"
              :disabled="pending(source)"
              @click="$emit('primary-action', source)"
            >
              <RefreshOutline v-if="pending(source)" class="spinning" />
              {{ primaryActionLabel(source) }}
              <ChevronForwardOutline v-if="!pending(source)" />
            </button>
          </article>
        </SettingsCardRail>
      </section>

    </div>
  </section>
</template>

<script setup>
import { ChevronForwardOutline, LibraryOutline, RefreshOutline } from '@vicons/ionicons5'
import { t } from '../i18n.js'
import SettingsCardRail from './SettingsCardRail.vue'

defineProps({
  icon: { type: Function, required: true },
  loading: { type: Boolean, required: true },
  localEntries: { type: Array, required: true },
  locationLabel: { type: Function, required: true },
  pending: { type: Function, required: true },
  plannedEntries: { type: Array, required: true },
  primaryActionLabel: { type: Function, required: true },
  readyCount: { type: Number, required: true },
  statusLabel: { type: Function, required: true },
  tagItems: { type: Function, required: true },
  tone: { type: Function, required: true },
})

defineEmits(['primary-action', 'refresh'])
</script>

<style scoped>
.knowledge-base-group-header h3 { display:flex; align-items:center; gap:8px; }
.knowledge-title-icon { width:17px; height:17px; }
</style>

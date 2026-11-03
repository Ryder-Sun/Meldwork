<template>
  <section
    class="settings-panel knowledge-base-manager knowledge-base-panel"
    :aria-busy="String(loading)"
  >
    <div class="manager-toolbar knowledge-base-toolbar">
      <span class="knowledge-base-ready-summary" role="status" aria-live="polite">
        {{ loading
          ? t('knowledgeBase.status.checking')
          : t('knowledgeBase.readyCount', { ready: readyCount, total: localEntries.length }) }}
      </span>
      <button class="secondary-button" type="button" :disabled="loading" @click="$emit('refresh')">
        <RefreshOutline :class="{ spinning: loading }" />
        {{ t('knowledgeBase.refresh') }}
      </button>
    </div>
    <div class="knowledge-base-sections">
      <section class="knowledge-base-group" aria-labelledby="knowledge-base-group-local">
        <header class="knowledge-base-group-header">
          <h3 id="knowledge-base-group-local">{{ t('knowledgeBase.group.local') }}</h3>
        </header>
        <SettingsCardRail :label="t('knowledgeBase.group.local')">
          <article
            v-for="source in localEntries"
            :key="source.kind"
            class="knowledge-base-item"
            :class="{ pending: pending(source) }"
          >
            <div class="knowledge-base-item-main">
              <img class="knowledge-base-logo" :src="source.logo" :alt="t(`knowledgeBase.source.${source.kind}`)" />
              <div class="knowledge-base-item-copy">
                <div class="knowledge-base-item-title-row">
                  <strong>{{ t(`knowledgeBase.source.${source.kind}`) }}</strong>
                  <span class="knowledge-base-status" :class="tone(source)">
                    <component :is="icon(source)" :class="{ spinning: pending(source) }" />
                    {{ statusLabel(source) }}
                  </span>
                </div>
                <div class="knowledge-base-tag-row">
                  <span
                    v-for="tag in tagItems(source)"
                    :key="tag.key"
                    class="knowledge-base-tag"
                    :class="tag.tone"
                  >
                    {{ tag.label }}
                  </span>
                </div>
                <span class="knowledge-base-card-description">{{ t(`knowledgeBase.description.${source.kind}`) }}</span>
                <p v-if="locationLabel(source)" class="knowledge-base-path">
                  <code>{{ locationLabel(source) }}</code>
                </p>
              </div>
            </div>
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
      <section class="knowledge-base-group" aria-labelledby="knowledge-base-group-planned">
        <header class="knowledge-base-group-header">
          <h3 id="knowledge-base-group-planned">{{ t('knowledgeBase.group.planned') }}</h3>
        </header>
        <SettingsCardRail :label="t('knowledgeBase.group.planned')">
          <article
            v-for="source in plannedEntries"
            :key="source.kind"
            class="knowledge-base-future-item"
            aria-disabled="true"
          >
            <div class="knowledge-base-item-main">
              <img class="knowledge-base-logo" :src="source.logo" :alt="t(`knowledgeBase.source.${source.kind}`)" />
              <div class="knowledge-base-item-copy">
                <div class="knowledge-base-item-title-row">
                  <strong>{{ t(`knowledgeBase.source.${source.kind}`) }}</strong>
                  <span class="knowledge-base-status">
                    <CloudOutline />
                    {{ statusLabel(source) }}
                  </span>
                </div>
                <span class="knowledge-base-card-description">{{ t(`knowledgeBase.description.${source.kind}`) }}</span>
              </div>
            </div>
            <button class="knowledge-base-action ghost" type="button" disabled>
              <CloudOutline />
              {{ statusLabel(source) }}
            </button>
          </article>
        </SettingsCardRail>
      </section>
    </div>
  </section>
</template>

<script setup>
import { ChevronForwardOutline, CloudOutline, RefreshOutline } from '@vicons/ionicons5'
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

<template>
  <section v-if="claims?.length" class="decision-context" :aria-label="t('humanGate.selectedConclusions')">
    <strong>{{ t('humanGate.selectedConclusions') }}</strong>
    <ul>
      <li v-for="(claim, index) in claims" :key="`${claim.agentKind}-${index}`">
        <strong>{{ agentLabel(claim.agentKind) }}</strong>
        <p>{{ claim.text }}</p>
        <small v-if="claim.truncated">{{ t('humanGate.conclusionTruncated') }}</small>
      </li>
    </ul>
  </section>
</template>

<script setup>
import { agentLabel } from '../catalog.js'
import { t } from '../i18n.js'

defineProps({ claims: { type: Array, default: () => [] } })
</script>

<style scoped>
.decision-context { display: grid; gap: 6px; min-width: 0; font-size: var(--text-sm); }
.decision-context > strong { color: var(--text-soft); }
.decision-context ul { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.decision-context li { min-width: 0; padding-left: 10px; border-left: 2px solid var(--border); }
.decision-context li > strong { color: var(--text); }
.decision-context p { margin: 3px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>

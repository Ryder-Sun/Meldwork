<template>
  <section class="skill-trust" :aria-label="t('skillTrust.title')">
    <div class="skill-trust-heading"><div><h2>{{ t('skillTrust.title') }}</h2><p>{{ t('skillTrust.hint') }}</p></div>
      <button type="button" class="secondary-button" :disabled="busy" @click="load">{{ t('skillTrust.refresh') }}</button></div>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-else-if="!busy && !entries.length">{{ t('skillTrust.empty') }}</p>
    <article v-for="entry in entries" :key="entry.bindingId" class="skill-trust-row">
      <div>
        <strong>{{ entry.coordinates.name }}</strong>
        <p>{{ entry.coordinates.targetKind }} · {{ entry.manifest.identity.version }} · {{ t(entry.state === 'approved' ? 'skillTrust.approved' : 'skillTrust.revoked') }}</p>
        <details><summary>{{ t('skillTrust.details') }}</summary>
          <p>{{ t('skillTrust.publisher') }}: {{ entry.manifest.origin.publisher }}</p>
          <p>{{ t('skillTrust.permissions') }}: {{ entry.manifest.permissionMode }} · {{ entry.manifest.sideEffectClass }}</p>
          <p>{{ t('skillTrust.tools') }}: {{ entry.manifest.tools.join(', ') || t('skillTrust.none') }}</p>
          <p>{{ t('skillTrust.destinations') }}: {{ entry.manifest.networkDestinations.join(', ') || t('skillTrust.none') }}</p>
          <p>{{ t('skillTrust.contentHash') }}: {{ entry.contentHash }}</p>
        </details>
      </div>
      <div v-if="entry.state === 'approved'" class="skill-trust-actions">
        <template v-if="confirming === entry.bindingId">
          <span>{{ t('skillTrust.confirm') }}</span>
          <button type="button" :disabled="busy" @click="confirming = ''">{{ t('common.cancel') }}</button>
          <button type="button" :disabled="busy" @click="revoke(entry)">{{ t('skillTrust.revoke') }}</button>
        </template>
        <button v-else type="button" :disabled="busy" @click="confirming = entry.bindingId">{{ t('skillTrust.revoke') }}</button>
      </div>
    </article>
  </section>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { desktopApi } from '../desktop.js'
import { t, translateError } from '../i18n.js'

const api = desktopApi().localSkillTrust
const entries = ref([])
const busy = ref(false)
const error = ref('')
const confirming = ref('')
async function load() {
  busy.value = true
  error.value = ''
  try { entries.value = await api.list() }
  catch (caught) { entries.value = []; error.value = translateError(caught) }
  finally { busy.value = false }
}
async function revoke(entry) {
  busy.value = true
  error.value = ''
  confirming.value = ''
  try { await api.revoke(entry.bindingId) }
  catch (caught) { error.value = translateError(caught) }
  try { entries.value = await api.list() }
  catch (caught) { entries.value = []; error.value = translateError(caught) }
  finally { busy.value = false }
}
onMounted(load)
</script>

<style scoped>
.skill-trust { margin-top: 28px; }
.skill-trust h2 { font-size: 16px; }
.skill-trust-heading, .skill-trust-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.skill-trust p { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.skill-trust-row { padding: 14px 0; border-bottom: 1px solid var(--border); }
.skill-trust-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.skill-trust-actions button { border: 0; background: transparent; color: var(--accent-text); cursor: pointer; padding: 8px; }
.skill-trust-actions button:focus-visible { outline: 2px solid var(--accent-text); }
@media (max-width: 800px) { .skill-trust-row { flex-direction: column; } }
</style>

<template>
  <section class="connector-panel" @keydown.esc="$emit('close')">
    <div class="connector-heading">
      <h2>{{ t('connectorPackages.title') }}</h2>
      <button class="secondary-button" type="button" @click="$emit('close')">{{ t('common.close') }}</button>
    </div>
    <button class="secondary-button" type="button" :disabled="busy" @click="importPackage">{{ t('connectorPackages.import') }}</button>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="!packages.length && !busy">{{ t('connectorPackages.empty') }}</p>
    <article v-for="item in packages" :key="item.packageId" class="connector-row">
      <div><strong>{{ item.label }}</strong> <span>{{ item.connectorVersion }}</span><p>{{ item.publisher.name }} · {{ t(`connectorPackages.state.${item.state}`) }}</p></div>
      <div class="connector-actions">
        <button v-if="item.state === 'imported'" type="button" :disabled="busy" @click="perform('approve', item)">{{ t('connectorPackages.approve') }}</button>
        <button v-if="item.state === 'approved' || item.state === 'disabled'" type="button" :disabled="busy" @click="perform('install', item)">{{ t('connectorPackages.install') }}</button>
        <button v-if="item.state === 'approved' && packages.some(other => other.connectorId === item.connectorId && other.state === 'installed')" type="button" :disabled="busy" @click="perform('upgrade', item)">{{ t('connectorPackages.upgrade') }}</button>
        <button v-if="item.state === 'installed'" type="button" :disabled="busy" @click="configure(item)">{{ t('connectorPackages.configure') }}</button>
        <button v-if="item.state === 'installed'" type="button" :disabled="busy" @click="perform('disable', item)">{{ t('connectorPackages.disable') }}</button>
        <button v-if="!['revoked', 'removed'].includes(item.state)" type="button" :disabled="busy" @click="perform('revoke', item)">{{ t('connectorPackages.revoke') }}</button>
        <button v-if="['imported', 'approved', 'disabled', 'revoked'].includes(item.state)" type="button" :disabled="busy" @click="perform('remove', item)">{{ t('connectorPackages.remove') }}</button>
      </div>
    </article>
    <p v-if="notice" role="status">{{ notice }}</p>
  </section>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { desktopApi } from '../desktop.js'
import { t, translateError } from '../i18n.js'

defineEmits(['close'])
const api = desktopApi().localAgentConnector
const packages = ref([])
const busy = ref(false)
const error = ref('')
const notice = ref('')
async function run(action) {
  busy.value = true
  error.value = ''
  notice.value = ''
  try { await action(); packages.value = await api.packages() }
  catch (caught) { error.value = translateError(caught) }
  finally { busy.value = false }
}
function importPackage() { return run(() => api.import()) }
function perform(action, item) { return run(() => api[action](item.packageId)) }
function configure(item) {
  return run(async () => {
    const detail = await api.inspect(item.packageId)
    if (detail.manifest.credentials.slots.length) {
      notice.value = t('connectorPackages.credentialsUnavailable')
      return
    }
    await api.configure({ manifestId: item.manifestId, label: item.label, credentials: null })
    notice.value = t('connectorPackages.configured')
  })
}
onMounted(() => run(async () => {}))
</script>

<style scoped>
.connector-panel { margin: 0 0 10px; padding: 24px; border-radius: 16px; background: var(--surface-raised); }
.connector-heading, .connector-row { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
.connector-heading h2 { font-size: 18px; }
.connector-row { padding: 14px 0; border-bottom: 1px solid var(--border); }
.connector-row p { color: var(--muted); margin: 4px 0 0; }
.connector-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.connector-actions button { border: 0; background: transparent; color: var(--accent-text); cursor: pointer; padding: 8px; }
.connector-actions button:focus-visible { outline: 2px solid var(--accent-text); }
@media (max-width: 800px) { .connector-row { align-items: flex-start; flex-direction: column; } }
</style>

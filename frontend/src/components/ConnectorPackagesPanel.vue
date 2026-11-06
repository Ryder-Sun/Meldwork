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
        <button type="button" :disabled="busy" @click="inspect(item)">{{ t('connectorPackages.inspect') }}</button>
        <button v-if="item.state === 'imported'" type="button" :disabled="busy" @click="perform('approve', item)">{{ t('connectorPackages.approve') }}</button>
        <button v-if="item.state === 'approved' || item.state === 'disabled'" type="button" :disabled="busy" @click="perform('install', item)">{{ t('connectorPackages.install') }}</button>
        <button v-if="item.state === 'approved' && packages.some(other => other.connectorId === item.connectorId && other.state === 'installed')" type="button" :disabled="busy" @click="perform('upgrade', item)">{{ t('connectorPackages.upgrade') }}</button>
        <button v-if="item.state === 'installed'" type="button" :disabled="busy" @click="configure(item)">{{ t('connectorPackages.configure') }}</button>
        <button v-if="item.state === 'installed'" type="button" :disabled="busy" @click="perform('disable', item)">{{ t('connectorPackages.disable') }}</button>
        <button v-if="!['revoked', 'removed'].includes(item.state)" type="button" :disabled="busy" @click="perform('revoke', item)">{{ t('connectorPackages.revoke') }}</button>
        <button v-if="['imported', 'approved', 'disabled', 'revoked'].includes(item.state)" type="button" :disabled="busy" @click="perform('remove', item)">{{ t('connectorPackages.remove') }}</button>
      </div>
      <div v-if="selected?.packageId === item.packageId" class="connector-detail">
        <p>{{ t('connectorPackages.origin') }}: {{ selected.origin.filename }} · {{ selected.origin.sha256 }}</p>
        <p>{{ t('connectorPackages.transport') }}: {{ selected.manifest.transport.type }} / {{ selected.manifest.transport.protocol }}</p>
        <p>{{ t('connectorPackages.permissions') }}: {{ selected.manifest.permissionModes.join(', ') || t('connectorPackages.none') }}</p>
        <p>{{ t('connectorPackages.credentials') }}: {{ selected.manifest.credentials.slots.map(slot => slot.slotId).join(', ') || t('connectorPackages.none') }}</p>
        <p>{{ t('connectorPackages.destinations') }}: {{ selected.manifest.outboundDestinations.join(', ') || t('connectorPackages.none') }}</p>
        <h4>{{ t('connectorPackages.audit') }}</h4>
        <ol><li v-for="event in audit" :key="event.eventId">{{ t(`connectorPackages.event.${event.action}`) }} · {{ event.timestamp }}</li></ol>
      </div>
    </article>
    <h3 v-if="instances.length">{{ t('connectorPackages.instances') }}</h3>
    <article v-for="instance in instances" :key="instance.instanceId" class="connector-row">
      <div><strong>{{ instance.label }}</strong><p>{{ t(instance.available ? 'connectorPackages.available' : 'connectorPackages.unavailable') }}</p></div>
      <div class="connector-actions">
        <button type="button" :disabled="busy || !instance.available" @click="testInstance(instance)">{{ t('connectorPackages.test') }}</button>
        <template v-if="confirmingInstance === instance.instanceId">
          <span>{{ t('connectorPackages.deletePrompt') }}</span>
          <button type="button" :disabled="busy" @click="confirmingInstance = ''">{{ t('common.cancel') }}</button>
          <button type="button" :disabled="busy" @click="deleteInstance(instance)">{{ t('connectorPackages.delete') }}</button>
        </template>
        <button v-else type="button" :disabled="busy" @click="confirmingInstance = instance.instanceId">{{ t('connectorPackages.delete') }}</button>
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
const instances = ref([])
const busy = ref(false)
const error = ref('')
const notice = ref('')
const confirmingInstance = ref('')
const selected = ref(null)
const audit = ref([])
async function run(action) {
  busy.value = true
  error.value = ''
  notice.value = ''
  try { await action(); [packages.value, instances.value] = await Promise.all([api.packages(), api.list()]) }
  catch (caught) { error.value = translateError(caught) }
  finally { busy.value = false }
}
function importPackage() { return run(() => api.import()) }
function perform(action, item) {
  selected.value = null
  return run(() => api[action](item.packageId))
}
function inspect(item) {
  if (selected.value?.packageId === item.packageId) { selected.value = null; return }
  return run(async () => {
    ;[selected.value, audit.value] = await Promise.all([api.inspect(item.packageId), api.audit(item.packageId)])
  })
}
function testInstance(instance) {
  return run(async () => {
    const result = await api.test(instance.instanceId)
    notice.value = t(result.passed ? 'connectorPackages.testPassed' : 'connectorPackages.testFailed')
  })
}
function deleteInstance(instance) {
  confirmingInstance.value = ''
  return run(() => api.delete(instance.instanceId))
}
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
.connector-row:has(.connector-detail) { flex-wrap: wrap; }
.connector-detail { flex-basis: 100%; overflow-wrap: anywhere; }
.connector-row p { color: var(--muted); margin: 4px 0 0; }
.connector-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.connector-actions button { border: 0; background: transparent; color: var(--accent-text); cursor: pointer; padding: 8px; }
.connector-actions button:focus-visible { outline: 2px solid var(--accent-text); }
@media (max-width: 800px) { .connector-row { align-items: flex-start; flex-direction: column; } }
</style>

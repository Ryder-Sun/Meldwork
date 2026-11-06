<template>
  <section class="agent-detail-section">
    <h3>{{ t('nativeConfig.title') }}</h3>
    <p>{{ directory || t('nativeConfig.automatic') }}</p>
    <p v-if="error" class="form-error" role="alert">{{ error }} <template v-if="invalid">{{ t(`nativeConfig.expected.${kind}`) }}</template></p>
    <button type="button" class="secondary-button" :disabled="busy" @click="update('choose')">{{ t('nativeConfig.choose') }}</button>
    <button v-if="directory" type="button" class="secondary-button" :disabled="busy" @click="update('clear')">{{ t('nativeConfig.clear') }}</button>
  </section>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { desktopApi, errorCode } from '../desktop.js'
import { t, translateError } from '../i18n.js'

const props = defineProps({ kind: { type: String, required: true } })
const api = desktopApi().localAgentNativeConfig
const directory = ref('')
const busy = ref(false)
const error = ref('')
const invalid = ref(false)
async function load() {
  try { directory.value = (await api.get(props.kind)).directory }
  catch (caught) { error.value = translateError(caught) }
}
async function update(action) {
  busy.value = true
  error.value = ''
  invalid.value = false
  try {
    const result = await api[action](props.kind)
    if (!result.canceled) directory.value = result.directory
  } catch (caught) {
    error.value = translateError(caught)
    invalid.value = errorCode(caught).includes('LOCAL_NATIVE_CONFIG_INVALID')
    await load()
  } finally { busy.value = false }
}
onMounted(load)
</script>

<style scoped>
p { overflow-wrap: anywhere; }
button + button { margin-inline-start: 8px; }
</style>

<template>
  <section class="agent-detail-section">
    <h3>{{ t('nativeConfig.title') }}</h3>
    <p v-if="directory !== null">{{ directory || t('nativeConfig.automatic') }}</p>
    <p v-if="directoryMissing" class="form-error" role="alert">{{ t('nativeConfig.directoryMissing') }} {{ t(`nativeConfig.expected.${kind}`) }}</p>
    <p v-if="kind === 'hermes' && directory !== null">{{ t('nativeConfig.configuredProvider') }}: {{ provider || t('nativeConfig.providerUnknown') }}</p>
    <p v-if="kind === 'codex' && directory !== null">{{ t('nativeConfig.userConfiguredProvider') }}: {{ provider || t('nativeConfig.providerUnknown') }}</p>
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
const directory = ref(null)
const directoryMissing = ref(false)
const provider = ref('')
const busy = ref(false)
const error = ref('')
const invalid = ref(false)
async function load() {
  try {
    const result = await api.get(props.kind)
    directory.value = result.directory
    directoryMissing.value = result.directoryMissing === true
    provider.value = result.provider || ''
  }
  catch (caught) { error.value = translateError(caught) }
}
async function update(action) {
  busy.value = true
  error.value = ''
  invalid.value = false
  try {
    const result = await api[action](props.kind)
    if (!result.canceled) {
      directory.value = result.directory
      directoryMissing.value = false
      provider.value = ''
      if (['hermes', 'codex'].includes(props.kind)) {
        const details = await api.get(props.kind)
        if (details.directory === result.directory) {
          provider.value = details.provider || ''
          directoryMissing.value = details.directoryMissing === true
        }
      }
    }
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

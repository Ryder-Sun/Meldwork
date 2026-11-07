<template>
  <section class="agent-detail-section">
    <h3>{{ t('nativeConfig.title') }}</h3>
    <p v-if="directory !== null">{{ directory || t('nativeConfig.automatic') }}</p>
    <p v-if="['zcode', 'qwen', 'opencodereview'].includes(kind)">{{ t(`nativeConfig.expected.${kind}`) }}</p>
    <p v-if="directoryMissing" class="form-error" role="alert">{{ t('nativeConfig.directoryMissing') }} {{ t(`nativeConfig.expected.${kind}`) }}</p>
    <p v-if="directory && !directoryMissing && configurationFiles?.present?.length">{{ t('nativeConfig.foundFiles') }}: {{ configurationFiles.present.join(', ') }}</p>
    <p v-if="directory && configurationFiles?.missing?.length">{{ t('nativeConfig.otherFilesMissing') }}: {{ configurationFiles.missing.join(', ') }}</p>
    <p v-if="kind === 'hermes' && directory !== null">{{ t('nativeConfig.configuredProvider') }}: {{ provider || t('nativeConfig.providerUnknown') }}</p>
    <p v-if="kind === 'deepseek' && directory !== null">{{ t('nativeConfig.configuredProvider') }}: {{ provider || t('nativeConfig.providerUnknown') }}</p>
    <p v-if="['codex', 'zcode'].includes(kind) && directory !== null">{{ t('nativeConfig.userConfiguredProvider') }}: {{ provider || t('nativeConfig.providerUnknown') }}</p>
    <p v-if="kind === 'qwen' && directory !== null">{{ t('nativeConfig.userAuthType') }}: {{ authType || t('nativeConfig.providerUnknown') }}</p>
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
const configurationFiles = ref(null)
const provider = ref('')
const authType = ref('')
const busy = ref(true)
const error = ref('')
const invalid = ref(false)
async function load() {
  try {
    const result = await api.get(props.kind)
    directory.value = result.directory
    directoryMissing.value = result.directoryMissing === true
    configurationFiles.value = result.configurationFiles || null
    provider.value = result.provider || ''
    authType.value = result.authType || ''
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
      configurationFiles.value = null
      provider.value = ''
      authType.value = ''
      const details = await api.get(props.kind)
      if (details.directory === result.directory) {
        provider.value = details.provider || ''
        authType.value = details.authType || ''
        directoryMissing.value = details.directoryMissing === true
        configurationFiles.value = details.configurationFiles || null
      }
    }
  } catch (caught) {
    error.value = translateError(caught)
    invalid.value = errorCode(caught).includes('LOCAL_NATIVE_CONFIG_INVALID')
    await load()
  } finally { busy.value = false }
}
onMounted(async () => {
  try { await load() } finally { busy.value = false }
})
</script>

<style scoped>
p { overflow-wrap: anywhere; }
button + button { margin-inline-start: 8px; }
</style>

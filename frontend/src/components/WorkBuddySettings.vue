<template>
  <details v-if="bridge" class="workbuddy-settings">
    <summary>{{ t('workbuddy.advanced') }}</summary>
    <form @submit.prevent="save">
    <label for="workbuddy-model">{{ t('workbuddy.model') }}</label>
    <div class="workbuddy-model-actions">
      <select id="workbuddy-model" v-model="modelId" :disabled="loading || saving">
        <option value="">{{ t('workbuddy.native') }}</option>
        <option v-for="model in models" :key="model.id" :value="model.id">{{ model.name }}</option>
        <option v-if="modelId && !models.some(model => model.id === modelId)" :value="modelId">{{ t('workbuddy.modelUnavailable') }}</option>
      </select>
      <button class="secondary-button compact" type="submit" :disabled="loading || saving || modelId === savedModelId">{{ t('common.save') }}</button>
      <button class="secondary-button compact" type="button" :disabled="loading || saving" @click="load">{{ t('home.refresh') }}</button>
    </div>
    <p>{{ t('workbuddy.modelHint') }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
    </form>
  </details>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { desktopApi } from '../desktop.js'
import { t, translateError } from '../i18n.js'

const bridge = desktopApi()?.workBuddy
const emit = defineEmits(['changed'])
const models = ref([])
const modelId = ref('')
const savedModelId = ref('')
const loading = ref(false)
const saving = ref(false)
const error = ref('')
function apply(value) {
  models.value = value.models
  modelId.value = value.modelId
  savedModelId.value = value.modelId
}
async function load() {
  loading.value = true
  error.value = ''
  try { apply(await bridge.settings()) } catch (failure) { error.value = translateError(failure) }
  finally { loading.value = false }
}
async function save() {
  saving.value = true
  error.value = ''
  try { apply(await bridge.setModel(modelId.value)); emit('changed') }
  catch (failure) { error.value = translateError(failure) }
  finally { saving.value = false }
}
onMounted(() => { if (bridge) void load() })
</script>

<style scoped>
.workbuddy-settings { display: grid; gap: 8px; padding: 0 16px 12px; }
.workbuddy-settings form { display: grid; gap: 8px; margin-top: 8px; }
.workbuddy-settings summary { color: var(--muted); cursor: pointer; font-size: var(--text-xs); }
.workbuddy-model-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.workbuddy-model-actions select { flex: 1; min-width: 160px; }
.workbuddy-settings label { color: var(--text-soft); font-size: var(--text-xs); }
.workbuddy-settings p { margin: 0; color: var(--muted); font-size: var(--text-xs); line-height: 1.5; }
.workbuddy-settings [role="alert"] { color: var(--danger); }
</style>

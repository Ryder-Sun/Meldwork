<template>
  <section v-if="bridge" class="work-preferences" @keydown.left.stop @keydown.right.stop>
    <h2>{{ t('workPreferences.title') }}</h2>
    <p>{{ t('workPreferences.hint') }}</p>
    <div class="work-presets" :aria-label="t('workPreferences.presets')">
      <button v-for="preset in presets" :key="preset.id" class="secondary-button compact" type="button" @click="applyPreset(preset)">
        {{ t(`workPreferences.preset.${preset.id}`) }}
      </button>
    </div>
    <form @submit.prevent="save">
      <label v-for="field in fields" :key="field.id" class="work-preference-dial">
        <span>{{ t(`workPreferences.${field.id}`) }} <strong>{{ t(`workPreferences.${field.values[form[field.id]]}`) }}</strong></span>
        <input v-model.number="form[field.id]" type="range" min="0" max="2" step="1" :aria-valuetext="t(`workPreferences.${field.values[form[field.id]]}`)" />
        <small>{{ t(`workPreferences.${field.values[0]}`) }} <span>{{ t(`workPreferences.${field.values[2]}`) }}</span></small>
      </label>
      <fieldset v-if="agents.length">
        <legend>{{ t('workPreferences.agents') }}</legend>
        <label v-for="agent in agents" :key="agent.kind" class="work-agent-choice">
          <input v-model="form.preferredAgentKinds" type="checkbox" :value="agent.kind" :disabled="!form.preferredAgentKinds.includes(agent.kind) && form.preferredAgentKinds.length >= 8" />
          {{ agent.label }}
        </label>
      </fieldset>
      <label class="work-custom">{{ t('workPreferences.instructions') }}
        <textarea v-model="form.instructions" rows="2" maxlength="800" :placeholder="t('workPreferences.example')" />
      </label>
      <output class="work-preferences-preview">{{ t('workPreferences.preview') }} · {{ t(`workPreferences.${fields[0].values[form.detail]}`) }} · {{ t(`workPreferences.${fields[1].values[form.initiative]}`) }} · {{ t(`workPreferences.${fields[2].values[form.evidence]}`) }}</output>
      <div class="work-preferences-actions">
        <button class="primary-button compact" type="submit" :disabled="loading || saving">{{ t('common.save') }}</button>
        <button class="secondary-button compact" type="button" :disabled="loading || saving" @click="reset">{{ t('workPreferences.reset') }}</button>
        <span v-if="saved" role="status">{{ t('workPreferences.saved') }}</span>
      </div>
      <p v-if="error" role="alert">{{ error }}</p>
    </form>
  </section>
</template>

<script setup>
import { onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { desktopApi } from '../desktop.js'
import { agentLabel } from '../catalog.js'
import { t, translateError } from '../i18n.js'

const bridge = desktopApi()?.workPreferences
const fields = [
  { id: 'detail', values: ['concise', 'balanced', 'thorough'] },
  { id: 'initiative', values: ['ask', 'balanced', 'proactive'] },
  { id: 'evidence', values: ['practical', 'balanced', 'strict'] },
]
const presets = [
  { id: 'quick', detail: 0, initiative: 2, evidence: 1 },
  { id: 'careful', detail: 2, initiative: 0, evidence: 2 },
  { id: 'explore', detail: 1, initiative: 1, evidence: 1 },
]
const form = reactive({ detail: 1, initiative: 1, evidence: 1, preferredAgentKinds: [], instructions: '' })
const agents = ref([])
const loading = ref(false)
const saving = ref(false)
const saved = ref(false)
const error = ref('')
let unsubscribe
watch(form, () => { saved.value = false }, { flush: 'sync' })
function updateAgents(snapshot) {
  agents.value = (snapshot?.agents || []).filter(agent => agent.installed !== false)
    .map(agent => ({ kind: agent.kind, label: agentLabel(agent.kind) }))
}
function apply(value) {
  for (const field of fields) form[field.id] = Math.max(0, field.values.indexOf(value[field.id]))
  form.preferredAgentKinds = [...value.preferredAgentKinds]
  form.instructions = value.instructions
}
function reset() {
  Object.assign(form, { detail: 1, initiative: 1, evidence: 1, preferredAgentKinds: [], instructions: '' })
  saved.value = false
}
function applyPreset(preset) {
  for (const field of fields) form[field.id] = preset[field.id]
  saved.value = false
}
async function save() {
  saving.value = true
  error.value = ''
  saved.value = false
  try {
    const value = { preferredAgentKinds: [...form.preferredAgentKinds], instructions: form.instructions }
    for (const field of fields) value[field.id] = field.values[form[field.id]]
    apply(await bridge.save(value))
    saved.value = true
  } catch (failure) { error.value = translateError(failure) }
  finally { saving.value = false }
}
onMounted(async () => {
  if (!bridge) return
  loading.value = true
  unsubscribe = desktopApi().localWorkspace?.onChanged?.(updateAgents)
  try {
    apply(await bridge.get())
    updateAgents(await desktopApi().localWorkspace?.get())
  } catch (failure) { error.value = translateError(failure) }
  finally { loading.value = false }
})
onBeforeUnmount(() => unsubscribe?.())
</script>

<style scoped>
.work-preferences { display: grid; gap: 14px; max-width: 680px; }
.work-preferences h2 { margin: 0; color: var(--text); font-size: var(--text-lg); }
.work-preferences p { margin: 0; font-size: var(--text-xs); color: var(--muted); line-height: 1.6; }
.work-preferences form { display: grid; gap: 18px; }
.work-presets, .work-preferences-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.work-preference-dial, .work-custom { display: grid; gap: 8px; font-size: var(--text-sm); }
.work-preference-dial > span { display: flex; justify-content: space-between; gap: 10px; }
.work-preference-dial strong { color: var(--accent-text); font-weight: 600; }
.work-preference-dial input { width: 100%; padding: 0; accent-color: var(--accent); }
.work-custom textarea { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); font: inherit; resize: vertical; }
.work-preference-dial small { display: flex; justify-content: space-between; color: var(--muted); }
fieldset { border: 0; padding: 0; margin: 0; }
legend { margin-bottom: 8px; font-size: var(--text-sm); }
.work-agent-choice { display: inline-flex; align-items: center; gap: 5px; margin: 0 14px 8px 0; font-size: var(--text-xs); }
.work-agent-choice input { width: auto; accent-color: var(--accent); }
.work-preferences-preview { padding: 10px 12px; border-radius: var(--radius-sm); background: var(--accent-soft); color: var(--text-soft); font-size: var(--text-xs); line-height: 1.6; }
[role="alert"] { color: var(--danger) !important; }
[role="status"] { color: var(--muted); font-size: var(--text-xs); }
</style>

<template>
  <section v-if="bridge" class="work-preferences" @keydown.left.stop @keydown.right.stop>
    <h2>{{ t('workPreferences.title') }}</h2>
    <p>{{ t('workPreferences.hint') }}</p>
    <div class="work-presets" :aria-label="t('workPreferences.presets')">
      <button v-for="preset in presets" :key="preset.id" class="work-preset" type="button" :aria-pressed="fields.every(field => form[field.id] === preset[field.id])" @click="applyPreset(preset)">
        {{ t(`workPreferences.preset.${preset.id}`) }}
      </button>
    </div>
    <form @submit.prevent="save">
      <div class="work-preference-controls">
        <h3>{{ t('workPreferences.deliverySection') }}</h3>
        <label v-for="field in fields" :key="field.id" class="work-preference-dial">
          <span>{{ t(`workPreferences.${field.id}`) }} <strong>{{ form[field.id] }}/100</strong></span>
          <input :value="form[field.id]" type="range" min="0" max="100" step="1" :style="{ '--preference-fill': `${form[field.id]}%` }" :aria-label="t(`workPreferences.${field.id}`)" :aria-valuetext="`${form[field.id]}/100`" @input="form[field.id] = Number($event.target.value)" />
          <small>{{ t(`workPreferences.${field.values[0]}`) }} <span>{{ t(`workPreferences.${field.values[2]}`) }}</span></small>
        </label>
      </div>
      <div class="work-preference-context">
        <fieldset v-if="agents.length">
          <legend>{{ t('workPreferences.agents') }}</legend>
          <div class="work-agent-options">
            <label v-for="agent in agents" :key="agent.kind" class="work-agent-choice">
              <input v-model="form.preferredAgentKinds" type="checkbox" :value="agent.kind" :disabled="!form.preferredAgentKinds.includes(agent.kind) && form.preferredAgentKinds.length >= 8" />
              <img :src="agentLogo(agent.sourceKind || agent.kind)" alt="" />
              {{ agent.label }}
            </label>
          </div>
        </fieldset>
        <label class="work-custom">{{ t('workPreferences.instructions') }}
          <textarea v-model="form.instructions" rows="2" maxlength="800" :placeholder="t('workPreferences.example')" />
        </label>
      </div>
      <div class="work-preferences-footer">
        <output class="work-preferences-preview">{{ t('workPreferences.preview') }} · {{ t('workPreferences.detail') }} {{ form.detail }}/100 · {{ t('workPreferences.initiative') }} {{ form.initiative }}/100 · {{ t('workPreferences.evidence') }} {{ form.evidence }}/100</output>
        <div class="work-preferences-actions">
          <button class="primary-button compact" type="submit" :disabled="loading || saving">{{ t('common.save') }}</button>
          <button class="secondary-button compact" type="button" :disabled="loading || saving" @click="reset">{{ t('workPreferences.reset') }}</button>
          <span v-if="saved" role="status">{{ t('workPreferences.saved') }}</span>
        </div>
      </div>
      <p v-if="error" role="alert">{{ error }}</p>
    </form>
  </section>
</template>

<script setup>
import { onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { desktopApi } from '../desktop.js'
import { agentLabel, agentLogo } from '../catalog.js'
import { t, translateError } from '../i18n.js'

const bridge = desktopApi()?.workPreferences
const fields = [
  { id: 'detail', values: ['concise', 'balanced', 'thorough'] },
  { id: 'initiative', values: ['ask', 'balanced', 'proactive'] },
  { id: 'evidence', values: ['practical', 'balanced', 'strict'] },
]
const presets = [
  { id: 'quick', detail: 15, initiative: 85, evidence: 50 },
  { id: 'careful', detail: 90, initiative: 15, evidence: 95 },
  { id: 'explore', detail: 80, initiative: 90, evidence: 55 },
  { id: 'decision', detail: 25, initiative: 50, evidence: 90 },
  { id: 'practical', detail: 45, initiative: 85, evidence: 30 },
]
const form = reactive({ detail: 50, initiative: 50, evidence: 50, preferredAgentKinds: [], instructions: '' })
const agents = ref([])
const loading = ref(false)
const saving = ref(false)
const saved = ref(false)
const error = ref('')
let unsubscribe
watch(form, () => { saved.value = false }, { flush: 'sync' })
function updateAgents(snapshot) {
  agents.value = (snapshot?.agents || []).filter(agent => agent.installed !== false)
    .map(agent => ({ kind: agent.kind, sourceKind: agent.sourceKind, label: agent.label || agent.name || agentLabel(agent.kind) }))
}
function apply(value) {
  for (const field of fields) form[field.id] = typeof value[field.id] === 'number' ? value[field.id] : Math.max(0, field.values.indexOf(value[field.id])) * 50
  form.preferredAgentKinds = [...value.preferredAgentKinds]
  form.instructions = value.instructions
}
function reset() {
  Object.assign(form, { detail: 50, initiative: 50, evidence: 50, preferredAgentKinds: [], instructions: '' })
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
    for (const field of fields) value[field.id] = form[field.id]
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
.work-preferences { display: grid; gap: 16px; min-width: 0; container-name: work-preferences; container-type: inline-size; }
.work-preferences h2 { margin: 0; color: var(--text); font-size: var(--text-lg); }
.work-preferences p { margin: 0; font-size: var(--text-xs); color: var(--muted); line-height: 1.6; }
.work-preferences form { display: grid; gap: 28px; min-width: 0; }
.work-preference-controls, .work-preference-context { display: grid; align-content: start; gap: 26px; min-width: 0; }
.work-preference-controls h3 { margin: 0; color: var(--text); font-size: var(--text-sm); font-weight: 600; }
.work-preferences-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; }
.work-preferences-actions { flex-shrink: 0; }
.work-agent-options { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 190px), 1fr)); gap: 10px 16px; }
.work-presets, .work-preferences-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.work-preset { border: 0; box-shadow: none; border-radius: var(--radius-sm); padding: 8px 10px; background: transparent; color: var(--text-soft); font: inherit; font-size: var(--text-xs); cursor: pointer; }
.work-preset:hover, .work-preset[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent-text); }
.work-preference-dial, .work-custom { display: grid; gap: 8px; font-size: var(--text-sm); }
.work-preference-dial > span { display: flex; justify-content: space-between; gap: 10px; }
.work-preference-dial strong { color: var(--accent-text); font-weight: 600; }
.work-preference-dial input { width: 100%; height: 26px; margin: 0; padding: 0; appearance: none; background: transparent; border: 0; box-shadow: none; cursor: ew-resize; -webkit-app-region: no-drag; touch-action: pan-y; }
.work-preference-dial input::-webkit-slider-runnable-track { height: 6px; border: 0; border-radius: 3px; box-shadow: none; background: linear-gradient(to right, var(--accent) var(--preference-fill), var(--surface-hover) var(--preference-fill)); }
.work-preference-dial input::-webkit-slider-thumb { appearance: none; width: 16px; height: 16px; margin-top: -5px; border: 0; border-radius: 50%; box-shadow: none; background: var(--accent); }
.work-preference-dial input::-moz-range-track { height: 6px; border: 0; border-radius: 3px; background: var(--surface-hover); }
.work-preference-dial input::-moz-range-progress { height: 6px; border: 0; border-radius: 3px; background: var(--accent); }
.work-preference-dial input::-moz-range-thumb { width: 16px; height: 16px; border: 0; border-radius: 50%; background: var(--accent); }
.work-agent-choice img { width: 18px; height: 18px; object-fit: contain; flex-shrink: 0; }
.work-custom textarea { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); font: inherit; resize: vertical; }
.work-preference-dial small { display: flex; justify-content: space-between; color: var(--muted); }
fieldset { border: 0; padding: 0; margin: 0; }
legend { margin-bottom: 16px; font-size: var(--text-sm); font-weight: 600; }
.work-agent-choice { display: flex; align-items: center; gap: 8px; min-height: 28px; font-size: var(--text-xs); overflow-wrap: anywhere; cursor: pointer; }
.work-agent-choice input { width: auto; accent-color: var(--accent); }
.work-preferences-preview { flex: 1 1 280px; color: var(--muted); font-size: var(--text-xs); line-height: 1.7; }
@container work-preferences (min-width: 900px) {
  .work-preferences form { grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr); column-gap: clamp(32px, 5cqw, 72px); }
  .work-preferences-footer, .work-preferences form > [role="alert"] { grid-column: 1 / -1; }
}
[role="alert"] { color: var(--danger) !important; }
[role="status"] { color: var(--muted); font-size: var(--text-xs); }
</style>

<template>
  <section class="delivery-panel" @keydown.esc.stop="close">
    <div class="delivery-bar">
      <button ref="toggle" class="secondary-button compact" type="button" :aria-expanded="open" @click="open = !open">
        {{ t('delivery.title') }}<span v-if="task"> · {{ task.brief.title }}</span>
      </button>
      <small v-if="boundTaskId">{{ t('delivery.bound') }}</small>
      <small v-else-if="task">{{ t('delivery.viewing') }}</small>
    </div>
    <div v-if="open" class="delivery-body">
      <div class="delivery-actions">
        <select v-model="selectedId" :aria-label="t('delivery.select')" :disabled="busy">
          <option value="">{{ t('delivery.chat') }}</option>
          <option v-for="item in tasks" :key="item.id" :value="item.id">{{ item.brief.title }}</option>
        </select>
        <button class="secondary-button compact" type="button" :disabled="busy" @click="newDraft">{{ t('delivery.new') }}</button>
        <button v-if="task && !task.attempts.length" class="secondary-button compact" type="button" :disabled="busy" @click="editDraft">{{ t('delivery.edit') }}</button>
        <button v-if="task" class="secondary-button compact" type="button" :disabled="busy" @click="reuse">{{ t('delivery.reuse') }}</button>
      </div>

      <form v-if="editing" class="delivery-form" @submit.prevent="save">
        <div class="delivery-actions">
          <button class="secondary-button compact" type="button" @click="sample">{{ t('delivery.sample') }}</button>
        </div>
        <label>{{ t('delivery.name') }}<input v-model="form.title" required maxlength="120" /></label>
        <label>{{ t('delivery.goal') }}<textarea v-model="form.goal" required maxlength="4000" rows="2" /></label>
        <label>{{ t('delivery.output') }}<textarea v-model="form.output" required maxlength="2000" rows="2" /></label>
        <label>{{ t('delivery.kind') }}<select v-model="form.outputKind"><option value="text">{{ t('delivery.text') }}</option><option value="files">{{ t('delivery.files') }}</option></select></label>
        <label>{{ t('delivery.criteria') }}<textarea v-model="criteriaText" required maxlength="6000" rows="3" /></label>
        <div class="delivery-actions">
          <button class="primary-button compact" type="submit" :disabled="busy">{{ t('common.save') }}</button>
          <button class="secondary-button compact" type="button" @click="editing = false">{{ t('common.cancel') }}</button>
        </div>
      </form>

      <template v-else-if="task">
        <p>{{ task.brief.goal }}</p>
        <p>{{ task.brief.output }} · {{ t(`delivery.${task.brief.outputKind}`) }}</p>
        <p v-if="boundTaskId" class="delivery-hint">{{ t('delivery.sendHint') }}</p>
        <p v-if="task.revision">{{ t('delivery.revision') }}: {{ task.revision.note }}</p>
        <p v-if="latestAttempt" role="status">{{ t('delivery.run') }}: {{ runLabel }}</p>
        <template v-if="!task.versions.length">
          <ul><li v-for="(criterion, index) in task.brief.criteria" :key="index">{{ criterion }}</li></ul>
          <p>{{ t('delivery.none') }}</p>
        </template>
        <template v-else>
          <label>{{ t('delivery.version') }}
            <select v-model="versionId">
              <option v-for="(item, index) in task.versions" :key="item.id" :value="item.id">V{{ index + 1 }} · {{ item.createdAt }}</option>
            </select>
          </label>
          <template v-if="version">
            <p role="status">{{ t('delivery.status') }}: {{ t(`delivery.${version.acceptedAt ? 'accepted' : task.revision?.baseVersionId === version.id ? 'changes' : 'pending'}`) }}<span v-if="version.acceptedAt"> · {{ version.acceptedAt }}</span></p>
            <p>{{ t('delivery.versionRun') }}: {{ statusLabel(versionAttempt) }}</p>
            <p v-if="versionAttempt?.revision">{{ t('delivery.revision') }} (V{{ baseVersionNumber }}): {{ versionAttempt.revision.note }}</p>
            <div v-for="response in version.responses" :key="response.messageId" class="delivery-response">
              <strong>{{ agentLabel(response.agentKind) }}</strong>
              <MarkdownMessage :content="response.content" />
            </div>
            <div v-for="attachment in version.attachments" :key="attachment.id" class="delivery-actions">
              <span>{{ attachment.name }}</span>
              <button class="secondary-button compact" type="button" @click="openAttachment(attachment.id)">{{ t('delivery.openFile') }}</button>
              <button class="secondary-button compact" type="button" :disabled="pending" @click="exportVersion(attachment.id)">{{ t('delivery.exportFile') }}</button>
            </div>
            <p v-if="task.brief.outputKind === 'files' && !version.attachments.length" class="delivery-warning">{{ t('delivery.missingFile') }}</p>
            <details>
              <summary>{{ t('delivery.sources') }}</summary>
              <p>{{ t('delivery.sourceHint') }}</p>
              <p v-if="!versionAttempt?.sources.length">{{ t('delivery.noSources') }}</p>
              <ul><li v-for="(source, index) in versionAttempt?.sources || []" :key="index">
                {{ source.name }}
                <button v-if="source.attachmentId" class="secondary-button compact" type="button" @click="openAttachment(source.attachmentId)">{{ t('delivery.openFile') }}</button>
              </li></ul>
              <p v-if="versionAttempt?.input">{{ versionAttempt.input }}</p>
            </details>
            <fieldset :disabled="busy || Boolean(version.acceptedAt)">
              <legend>{{ t('delivery.review') }}</legend>
              <label v-for="(criterion, index) in task.brief.criteria" :key="index" class="delivery-check">
                <span>{{ criterion }}</span>
                <select v-model="checks[index]">
                  <option v-for="state in ['pending', 'met', 'unmet', 'unknown']" :key="state" :value="state">{{ t(`delivery.check.${state}`) }}</option>
                </select>
              </label>
              <label>{{ t('delivery.notes') }}<textarea v-model="notes" rows="2" maxlength="4000" /></label>
            </fieldset>
            <div class="delivery-actions">
              <button class="secondary-button compact" type="button" :disabled="busy || Boolean(version.acceptedAt)" @click="review(false)">{{ t('delivery.saveReview') }}</button>
              <button class="primary-button compact" type="button" :disabled="!canAccept" @click="review(true)">{{ t('delivery.accept') }}</button>
              <button class="secondary-button compact" type="button" :disabled="pending || dirtyReview" @click="exportVersion()">{{ t('delivery.export') }}</button>
              <button class="secondary-button compact" type="button" @click="copy">{{ t('delivery.copy') }}</button>
            </div>
            <p v-if="dirtyReview">{{ t('delivery.unsavedReview') }}</p>
            <form class="delivery-form" @submit.prevent="revise">
              <p>{{ t('delivery.revisionFiles') }}</p>
              <label>{{ t('delivery.revision') }}<textarea v-model="revisionNote" required rows="2" maxlength="4000" :disabled="busy" /></label>
              <button class="secondary-button compact" type="submit" :disabled="busy || !revisionNote.trim()">{{ t('delivery.requestRevision') }}</button>
            </form>
          </template>
        </template>
      </template>
      <p v-else-if="!editing">{{ t('delivery.empty') }}</p>
    </div>
  </section>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { agentLabel } from '../catalog.js'
import { locale, t } from '../i18n.js'
import MarkdownMessage from './MarkdownMessage.vue'

const props = defineProps({
  groupId: { type: String, required: true }, snapshot: { type: Object, required: true },
  api: { type: Object, required: true }, sending: Boolean,
})
const emit = defineEmits(['bind', 'refresh', 'error', 'notify', 'reuse'])
const open = ref(false)
const toggle = ref(null)
const selectedId = ref('')
const editing = ref(false)
const editingId = ref('')
const form = ref({ title: '', goal: '', output: '', outputKind: 'text' })
const criteriaText = ref('')
const pending = ref(false)
const versionId = ref('')
const checks = ref([])
const notes = ref('')
const revisionNote = ref('')
const tasks = computed(() => (props.snapshot.deliveryTasks || []).filter(item => item.groupId === props.groupId))
const task = computed(() => tasks.value.find(item => item.id === selectedId.value))
const busy = computed(() => pending.value || props.sending || props.snapshot.runningGroupIds.includes(props.groupId))
const version = computed(() => task.value?.versions.find(item => item.id === versionId.value))
const versionAttempt = computed(() => task.value?.attempts.find(item => item.runId === version.value?.runId))
const latestAttempt = computed(() => task.value?.attempts.at(-1))
const boundTaskId = computed(() => !editing.value && task.value && (!task.value.versions.length || task.value.revision) ? task.value.id : '')
const baseVersionNumber = computed(() => (task.value?.versions.findIndex(item => item.id === versionAttempt.value?.revision?.baseVersionId) ?? -1) + 1)
function statusLabel(attempt) {
  const live = props.snapshot.runs.find(item => item.runId === attempt?.runId)
  const status = live?.waitingGateIds?.length ? 'waiting' : live ? 'running' : attempt?.status
  const known = ['preparing', 'running', 'waiting', 'completed', 'partial', 'failed', 'stopped', 'timeout', 'interrupted', 'round-limit', 'budget-exhausted', 'circuit-breaker']
  return t(`delivery.run.${known.includes(status) ? status : 'failed'}`)
}
const runLabel = computed(() => statusLabel(latestAttempt.value))
const canAccept = computed(() => version.value && !version.value.acceptedAt && !busy.value
  && checks.value.length === task.value.brief.criteria.length && checks.value.every(item => item === 'met')
  && (task.value.brief.outputKind !== 'files' || version.value.attachments.length > 0))
const dirtyReview = computed(() => version.value && (notes.value !== version.value.notes
  || JSON.stringify(checks.value) !== JSON.stringify(version.value.checks)))

watch(boundTaskId, value => emit('bind', value), { immediate: true })
watch([selectedId, () => task.value?.versions.length], ([, count], previous) => {
  versionId.value = task.value?.versions.at(-1)?.id || ''
  if (previous && count > previous[1]) open.value = true
})
watch(() => version.value?.id, () => {
  checks.value = [...(version.value?.checks || [])]
  notes.value = version.value?.notes || ''
  revisionNote.value = ''
})

function close() { open.value = false; nextTick(() => toggle.value?.focus()) }
function newDraft() {
  editingId.value = ''
  form.value = { title: '', goal: '', output: '', outputKind: 'text' }
  criteriaText.value = ''
  editing.value = true
}
function editDraft() {
  editingId.value = task.value.id
  form.value = { ...task.value.brief }
  criteriaText.value = task.value.brief.criteria.join('\n')
  editing.value = true
}
function sample() {
  form.value = { title: t('delivery.sampleTitle'), goal: t('delivery.sampleGoal'), output: t('delivery.sampleOutput'), outputKind: 'text' }
  criteriaText.value = t('delivery.sampleCriteria')
}
async function act(callback) {
  if (pending.value) return
  pending.value = true
  try { return await callback() } catch (error) { emit('error', error) }
  finally { pending.value = false }
}
async function save() {
  await act(async () => {
    const result = await props.api.localDelivery.save({
      groupId: props.groupId, ...(editingId.value ? { taskId: editingId.value } : {}),
      brief: { title: form.value.title, goal: form.value.goal, output: form.value.output, outputKind: form.value.outputKind,
        criteria: criteriaText.value.split('\n').map(item => item.trim()).filter(Boolean), language: locale.value === 'zh' ? 'zh' : 'en' },
    })
    selectedId.value = result.taskId
    editing.value = false
    emit('refresh')
  })
}
async function review(accept) {
  await act(async () => {
    await props.api.localDelivery.review({ taskId: task.value.id, versionId: version.value.id, checks: [...checks.value], notes: notes.value, accept })
    emit('refresh')
  })
}
async function revise() {
  await act(async () => {
    await props.api.localDelivery.revise({ taskId: task.value.id, baseVersionId: version.value.id, note: revisionNote.value })
    emit('refresh')
    emit('notify', t('delivery.sendHint'))
  })
}
async function exportVersion(attachmentId) {
  await act(async () => {
    const result = await props.api.localDelivery.export({ taskId: task.value.id, versionId: version.value.id, ...(attachmentId ? { attachmentId } : {}) })
    if (result.saved) emit('notify', t('delivery.exported'))
  })
}
async function reuse() {
  await act(async () => {
    const result = await props.api.localDelivery.reuse({ taskId: task.value.id })
    emit('reuse', result)
    emit('notify', t('delivery.reused'))
  })
}
async function openAttachment(id) { await act(() => props.api.localAttachments.open(id)) }
async function copy() { await act(async () => { await navigator.clipboard.writeText(version.value.responses.map(item => item.content).join('\n\n')); emit('notify', t('delivery.copied')) }) }
function selectTask(id) { selectedId.value = id; open.value = true }
defineExpose({ selectTask })
</script>

<style scoped>
.delivery-panel { flex: 0 0 auto; border-bottom: 1px solid var(--border); min-width: 0; }
.delivery-bar { padding: 6px 20px; display: flex; align-items: center; gap: 12px; }
.delivery-bar button { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.delivery-bar small, .delivery-hint { color: var(--muted); }
.delivery-body { padding: 12px 20px; max-height: 52vh; overflow: auto; overscroll-behavior: contain; }
.delivery-body p { margin: 10px 0; overflow-wrap: anywhere; }
.delivery-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 8px 0; }
.delivery-form { display: grid; gap: 10px; margin: 12px 0; }
.delivery-body label { display: grid; gap: 5px; margin: 8px 0; }
.delivery-body input, .delivery-body textarea, .delivery-body select { font: inherit; color: inherit; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 8px; max-width: 100%; min-width: 0; }
.delivery-body textarea { resize: vertical; }
.delivery-body fieldset { border: 1px solid var(--border); border-radius: 8px; margin: 12px 0; padding: 10px; }
.delivery-check { grid-template-columns: minmax(0, 1fr) auto; align-items: center; }
.delivery-response { padding: 10px 0; }
.delivery-warning { color: var(--danger); }
.delivery-body summary { cursor: pointer; padding: 8px 0; }
@media (max-width: 600px) { .delivery-bar { flex-wrap: wrap; } .delivery-body { padding: 10px; } .delivery-check { grid-template-columns: 1fr; } }
</style>

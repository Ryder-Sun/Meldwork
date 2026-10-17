<template>
  <div v-if="open" class="trace-panel-layer" :class="{ drawer }">
    <button
      v-if="drawer"
      class="trace-panel-scrim"
      type="button"
      :aria-label="t('trace.close')"
      @click="emit('close')"
    />

    <aside
      ref="panelElement"
      class="run-trace-panel"
      role="dialog"
      :aria-modal="drawer ? 'true' : undefined"
      :aria-label="t('trace.title')"
      tabindex="-1"
      @keydown.tab="trapFocus"
      @keydown.esc="handlePanelEscape"
    >
      <header class="trace-panel-header">
        <div>
          <span class="trace-panel-kicker">{{ t('trace.title') }}</span>
          <strong>{{ selectedItem ? agentLabel(selectedItem.agentKind) : t('trace.noProcess') }}</strong>
        </div>
        <button
          class="icon-button"
          type="button"
          :title="t('trace.close')"
          :aria-label="t('trace.close')"
          @click="emit('close')"
        >
          <CloseOutline />
        </button>
      </header>

      <div
        v-if="items.length"
        class="trace-panel-selectors"
        :class="{ 'single-selector': selectedAgentRuns.length <= 1 }"
      >
        <div ref="agentSelector" class="trace-select trace-agent-selector">
          <span class="trace-select-label">{{ t('trace.agentSelector') }}</span>
          <button
            ref="agentSelectTrigger"
            class="trace-select-trigger"
            type="button"
            :disabled="agentGroups.length <= 1"
            :aria-expanded="String(openSelector === 'agent')"
            :aria-haspopup="agentGroups.length > 1 ? 'listbox' : undefined"
            :aria-label="t('trace.selectAgent')"
            @click="toggleSelector('agent')"
            @keydown.down.prevent="openSelectorMenu('agent')"
          >
            <img v-if="selectedItem" :src="agentLogo(selectedItem.agentKind, theme)" alt="" />
            <span>
              <strong>{{ selectedItem ? agentLabel(selectedItem.agentKind) : t('trace.noProcess') }}</strong>
              <small v-if="selectedItem">{{ roundLabel(selectedItem) }} / {{ statusLabel(selectedItem.status) }}</small>
            </span>
            <ChevronDownOutline v-if="agentGroups.length > 1" :class="{ expanded: openSelector === 'agent' }" />
          </button>
          <div
            v-if="openSelector === 'agent'"
            class="trace-select-menu"
            role="listbox"
            :aria-label="t('trace.agentRuns')"
            @keydown="navigateSelector"
          >
            <button
              v-for="group in agentGroups"
              :key="group.agentKind"
              class="trace-select-option"
              type="button"
              role="option"
              :aria-selected="String(group.agentKind === selectedItem?.agentKind)"
              :data-selected="group.agentKind === selectedItem?.agentKind ? 'true' : undefined"
              @click="selectAgentGroup(group)"
            >
              <img :src="agentLogo(group.agentKind, theme)" alt="" />
              <span>
                <strong>{{ agentLabel(group.agentKind) }}</strong>
                <small>{{ roundLabel(agentTabItem(group)) }} / {{ statusLabel(agentTabItem(group).status) }}</small>
              </span>
              <CheckmarkCircleOutline v-if="group.agentKind === selectedItem?.agentKind" />
            </button>
          </div>
        </div>

        <div v-if="selectedAgentRuns.length > 1" ref="roundSelector" class="trace-select trace-round-selector">
          <span class="trace-select-label">{{ t('trace.roundSelector') }}</span>
          <button
            ref="roundSelectTrigger"
            class="trace-select-trigger trace-round-trigger"
            type="button"
            :aria-expanded="String(openSelector === 'round')"
            aria-haspopup="listbox"
            :aria-label="t('trace.selectRound', { agent: agentLabel(selectedItem?.agentKind) })"
            @click="toggleSelector('round')"
            @keydown.down.prevent="openSelectorMenu('round')"
          >
            <span>
              <strong>{{ roundLabel(selectedItem) }}</strong>
              <small>{{ statusLabel(selectedItem?.status) }}</small>
            </span>
            <ChevronDownOutline :class="{ expanded: openSelector === 'round' }" />
          </button>
          <div
            v-if="openSelector === 'round'"
            class="trace-select-menu trace-round-menu"
            role="listbox"
            :aria-label="t('trace.selectRound', { agent: agentLabel(selectedItem?.agentKind) })"
            @keydown="navigateSelector"
          >
            <button
              v-for="item in selectedAgentRuns"
              :key="item.agentRunId"
              class="trace-select-option trace-round-option"
              type="button"
              role="option"
              :aria-selected="String(item.agentRunId === selectedItem?.agentRunId)"
              :data-selected="item.agentRunId === selectedItem?.agentRunId ? 'true' : undefined"
              @click="selectRound(item.agentRunId)"
            >
              <span>
                <strong>{{ roundLabel(item) }}</strong>
                <small>{{ statusLabel(item.status) }}</small>
              </span>
              <CheckmarkCircleOutline v-if="item.agentRunId === selectedItem?.agentRunId" />
            </button>
          </div>
        </div>
      </div>

      <p
        class="visually-hidden trace-event-live-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {{ eventLiveStatus }}
      </p>

      <div v-if="selectedItem" class="trace-panel-scroll">
        <section class="trace-panel-summary">
          <div class="trace-panel-summary-heading">
            <div>
              <strong>{{ agentLabel(selectedItem.agentKind) }}</strong>
              <span>{{ roundLabel(selectedItem) }}</span>
            </div>
            <span class="trace-summary-statuses">
              <span v-if="waiting" class="trace-waiting-state">
                <span class="attention-dot" aria-hidden="true" />
                {{ t('humanGate.waiting') }}
              </span>
              <span class="trace-status" :data-status="statusTone(selectedItem.status)">
                {{ statusLabel(selectedItem.status) }}
              </span>
            </span>
          </div>
          <section
            v-if="selectedPhaseLabel"
            class="trace-phase-feedback"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <header class="trace-section-heading">
              <strong>{{ t('run.phaseFeedback') }}</strong>
              <small v-if="selectedPhaseSlots.length">
                {{ t('run.phaseSlots', {
                  completed: selectedPhaseSlots.filter(slot => orchestrationSlotCompleted(slot.status)).length,
                  total: selectedPhaseSlots.length,
                }) }}
              </small>
            </header>
            <div class="trace-phase-current">
              <strong>{{ selectedPhaseLabel }}</strong>
            </div>
            <ul v-if="selectedPhaseSlots.length" class="trace-phase-slot-list">
              <li v-for="slot in selectedPhaseSlots" :key="`${slot.agentKind}:${slot.slotId || slot.phase}`">
                <span>{{ agentLabel(slot.agentKind) }}</span>
                <small>
                  <span v-if="slot.role" class="trace-phase-slot-role">
                    {{ collaborationRoleLabel(slot.role) }}
                  </span>
                  <template v-if="slot.role"> · </template>
                  {{ phaseLabel(slot.phase) }} / {{ statusLabel(slot.status) }}
                </small>
              </li>
            </ul>
          </section>
          <details v-if="selectedItem.context && hasTraceContext(selectedItem.context)" class="trace-context-disclosure">
            <summary>
              <span>{{ t('trace.attemptInjection') }}</span>
              <ChevronDownOutline aria-hidden="true" />
            </summary>
            <div class="trace-context-stats" data-context-section="attempt">
              <span>{{ t('trace.contextIncluded', { count: selectedItem.context.includedCount }) }}</span>
              <span>{{ t('trace.contextOmitted', { count: selectedItem.context.omittedCount }) }}</span>
              <span>{{ t('trace.contextChars', { count: selectedItem.context.charCount }) }}</span>
              <span v-if="selectedItem.context.contextMode">
                {{ t(`trace.contextMode.${selectedItem.context.contextMode}`) }}
              </span>
              <span v-if="Number.isInteger(selectedItem.context.promptChars)">
                {{ t('trace.promptChars', { count: selectedItem.context.promptChars }) }}
              </span>
              <span v-if="Number.isInteger(selectedItem.context.promptBytes)">
                {{ t('trace.promptBytes', { count: selectedItem.context.promptBytes }) }}
              </span>
              <span v-if="selectedItem.context.sessionRotated">{{ t('trace.contextRotated') }}</span>
              <span v-if="selectedItem.context.contextPackId" class="trace-context-record">
                {{ t('trace.contextPackId') }}
                <code>{{ selectedItem.context.contextPackId }}</code>
              </span>
            </div>
            <p
              v-if="selectedItem.context.contextPackState === 'legacy-unavailable'"
              class="trace-detail-unavailable trace-context-record trace-session-warning"
              data-context-section="context-pack-legacy"
            >
              {{ t('trace.contextPackLegacyUnavailable') }}
            </p>
            <p
              v-if="selectedItem.context.deliveryRecordIds?.length"
              class="trace-detail-unavailable trace-context-record"
              data-context-section="outbound"
            >
              <strong>{{ t('trace.actualOutbound') }}</strong><br />
              <span>{{ t('trace.deliveryRecordIds', { count: selectedItem.context.deliveryRecordIds.length }) }}</span>
              <template v-for="(id, index) in selectedItem.context.deliveryRecordIds" :key="id">
                <br v-if="index === 0" />
                <span v-else>, </span>
                <code>{{ id }}</code>
              </template>
              <template v-if="selectedItem.context.sourceHash">
                <br />
                <span>{{ t('trace.sourceFingerprint', { count: selectedItem.context.sourceCount }) }} </span>
                <code>{{ selectedItem.context.sourceHash }}</code>
              </template>
              <template v-if="selectedItem.context.promptHash">
                <br />
                <span>{{ t('trace.promptFingerprint') }} </span>
                <code>{{ selectedItem.context.promptHash }}</code>
              </template>
              <template v-if="selectedItem.context.wirePayloadHash">
                <br />
                <span>{{ t('trace.wireFingerprint', { count: selectedItem.context.wirePayloadBytes }) }} </span>
                <code>{{ selectedItem.context.wirePayloadHash }}</code>
              </template>
            </p>
            <p
              v-if="selectedItem.context.sessionProvenance"
              class="trace-detail-unavailable trace-context-record"
              data-context-section="session"
              :data-session-reuse="selectedItem.context.sessionProvenance.reuse ? 'reused' : 'new'"
              :data-provenance-completeness="selectedItem.context.sessionProvenance.completeness"
            >
              <strong>{{ t('trace.sessionProvenance') }}</strong><br />
              <span>{{ sessionProvenanceSummary(selectedItem.context.sessionProvenance) }}</span>
              <template v-if="selectedItem.context.sessionProvenance.originTaskId">
                <br />
                <span>{{ t('trace.sessionOriginTask') }} </span>
                <code>{{ selectedItem.context.sessionProvenance.originTaskId }}</code>
              </template>
              <template v-if="selectedItem.context.sessionProvenance.inheritedTaskIds.length">
                <br />
                <span>{{ t('trace.sessionInheritedTasks') }} </span>
                <template
                  v-for="(taskId, index) in selectedItem.context.sessionProvenance.inheritedTaskIds"
                  :key="taskId"
                >
                  <span v-if="index">, </span><code>{{ taskId }}</code>
                </template>
              </template>
              <template v-if="sessionProvenanceWarning(selectedItem.context.sessionProvenance)">
                <br />
                <span class="trace-session-warning">
                  {{ sessionProvenanceWarning(selectedItem.context.sessionProvenance) }}
                </span>
              </template>
            </p>
          </details>
          <p v-if="hasOnlyBareEvents(selectedItem)" class="trace-detail-unavailable">
            {{ t('trace.detailUnavailable') }}
          </p>
          <p v-if="selectedItem.truncated" class="trace-truncated">{{ t('trace.truncated') }}</p>
        </section>

        <section v-if="orderedHumanGates.length" class="trace-human-gate-section" aria-live="polite">
          <header class="trace-section-heading">
            <strong>{{ t('humanGate.pendingTitle') }}</strong>
            <small>{{ orderedHumanGates.length }}</small>
          </header>
          <article v-for="gate in orderedHumanGates" :key="gate.gateId" class="trace-human-gate-card">
            <header>
              <span>
                <img :src="agentLogo(gate.agentKind, theme)" alt="" />
                <strong>{{ agentLabel(gate.agentKind) }}</strong>
              </span>
              <small>{{ t(`humanGate.type.${gate.type}`) }}</small>
            </header>
            <p>{{ humanGateSummary(gate) }}</p>
            <form
              v-if="gate.type === 'input'"
              class="trace-human-gate-input"
              @submit.prevent="submitHumanGateInput(gate)"
            >
              <input
                v-model="humanGateResponses[gate.gateId]"
                type="text"
                maxlength="32768"
                :placeholder="t('humanGate.inputPlaceholder')"
                :aria-label="t('humanGate.inputLabel')"
                :disabled="humanGateDecisionPending(gate.gateId)"
              />
              <div class="trace-human-gate-options">
                <button
                  class="compact primary-button"
                  type="submit"
                  :disabled="humanGateDecisionPending(gate.gateId) || !humanGateResponse(gate.gateId)"
                >
                  <CheckmarkCircleOutline />
                  {{ t('humanGate.option.submitInput') }}
                </button>
                <button
                  class="compact secondary-button"
                  type="button"
                  :disabled="humanGateDecisionPending(gate.gateId)"
                  @click="cancelHumanGateInput(gate)"
                >
                  <CloseCircleOutline />
                  {{ t('humanGate.option.cancelInput') }}
                </button>
              </div>
            </form>
            <div v-else class="trace-human-gate-options">
              <button
                v-for="option in gate.options"
                :key="option.optionId"
                class="compact"
                :class="optionApprovesHumanGate(option) ? 'primary-button' : 'secondary-button'"
                type="button"
                :disabled="humanGateDecisionPending(gate.gateId)"
                @click="emit('decide-human-gate', { gateId: gate.gateId, optionId: option.optionId })"
              >
                <CheckmarkCircleOutline v-if="optionApprovesHumanGate(option)" />
                <CloseCircleOutline v-else />
                {{ humanGateOptionLabel(option) }}
              </button>
            </div>
          </article>
        </section>

        <section class="trace-event-section" :aria-label="t('trace.events')">
          <header class="trace-section-heading">
            <strong>{{ t('trace.events') }}</strong>
            <small>{{ filteredEvents(selectedItem).length }}</small>
          </header>
          <ol v-if="filteredEvents(selectedItem).length" class="trace-event-list">
            <li v-for="(event, index) in filteredEvents(selectedItem)" :key="eventKey(event, index)">
              <details>
                <summary>
                  <span class="trace-event-type">{{ eventTypeLabel(event.type) }}</span>
                  <span class="trace-event-title">{{ eventTitle(event) }}</span>
                  <span class="trace-event-status" :data-status="statusTone(event.status)">
                    {{ statusLabel(event.status) }}
                  </span>
                  <ChevronDownOutline />
                </summary>
                <div class="trace-event-body">
                  <p v-if="event.summary">{{ event.summary }}</p>
                  <pre v-if="event.detail">{{ event.detail }}</pre>
                  <p v-if="!eventHasDetails(event)" class="trace-event-detail-unavailable">
                    {{ t('trace.eventDetailUnavailable') }}
                  </p>
                  <small v-if="formatEventTime(event.timestamp)" class="trace-event-time">
                    {{ formatEventTime(event.timestamp) }}
                  </small>
                </div>
              </details>
            </li>
          </ol>
          <p v-else class="trace-empty-state">{{ t('trace.noEvents') }}</p>
        </section>

        <section v-if="selectedSources.length" class="trace-source-section">
          <header class="trace-section-heading">
            <strong>{{ t('trace.sources') }}</strong>
            <small>{{ selectedSources.length }}</small>
          </header>
          <div class="trace-source-list">
            <button
              v-for="source in selectedSources"
              :key="source.id"
              type="button"
              :disabled="!source.available"
              :aria-label="source.label"
              @click="emit('jump-source', source.id)"
            >
              <span>{{ source.label }}</span>
              <ChevronForwardOutline />
            </button>
          </div>
        </section>
      </div>

      <div v-else class="trace-empty-state trace-panel-empty">
        {{ t('trace.noProcess') }}
      </div>
    </aside>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  CheckmarkCircleOutline,
  ChevronDownOutline,
  ChevronForwardOutline,
  CloseCircleOutline,
  CloseOutline,
} from '@vicons/ionicons5'
import { agentLabel, agentLogo } from '../catalog.js'
import { retainedTraceEvents } from '../conversationTimelineModel.js'
import { orchestrationPhase, orchestrationSlotCompleted } from '../desktop-normalization.js'
import { locale, t } from '../i18n.js'

const COLLABORATION_ROLES = new Set([
  'primary', 'reviewer', 'arbiter', 'worker', 'integrator',
  'synthesizer', 'verifier', 'writer', 'participant',
])

const props = defineProps({
  open: { type: Boolean, default: false },
  drawer: { type: Boolean, default: false },
  humanGateDecisionPendingIds: { type: Array, default: () => [] },
  humanGates: { type: Array, default: () => [] },
  items: { type: Array, default: () => [] },
  selectedAgentRunId: { type: String, default: '' },
  theme: { type: String, default: 'light' },
  waiting: { type: Boolean, default: false },
})

const emit = defineEmits(['close', 'decide-human-gate', 'select', 'jump-source'])
const panelElement = ref(null)
const agentSelector = ref(null)
const agentSelectTrigger = ref(null)
const roundSelector = ref(null)
const roundSelectTrigger = ref(null)
const openSelector = ref('')
const humanGateResponses = reactive({})
const selectedItem = computed(() => props.items.find(item => item.agentRunId === props.selectedAgentRunId) || props.items.at(-1) || null)
const agentGroups = computed(() => {
  const groups = new Map()
  for (const item of props.items) {
    const agentKind = String(item?.agentKind || '')
    if (!agentKind) continue
    const group = groups.get(agentKind) || { agentKind, items: [] }
    group.items.push(item)
    groups.set(agentKind, group)
  }
  return [...groups.values()]
})
const selectedAgentRuns = computed(() => {
  const items = agentGroups.value.find(group => group.agentKind === selectedItem.value?.agentKind)?.items || []
  const byRound = new Map()
  for (const item of items) {
    const key = Number.isInteger(Number(item.round)) ? Number(item.round) : 0
    const previous = byRound.get(key)
    const itemTime = Date.parse(item.createdAt || item.startedAt || '') || 0
    const previousTime = Date.parse(previous?.createdAt || previous?.startedAt || '') || 0
    if (!previous || item.live || itemTime >= previousTime) byRound.set(key, item)
  }
  return [...byRound.values()].sort((left, right) => (
    (Number(left.round) || 0) - (Number(right.round) || 0)
  ))
})
const selectedOrchestration = computed(() => (
  selectedItem.value?.orchestration && typeof selectedItem.value.orchestration === 'object'
    ? selectedItem.value.orchestration
    : null
))
const selectedPhase = computed(() => orchestrationPhase(selectedOrchestration.value?.phase))
const selectedPhaseLabel = computed(() => (
  selectedPhase.value ? t(`run.phase.${selectedPhase.value}`) : ''
))
const selectedPhaseSlots = computed(() => {
  const orchestrationSlots = Array.isArray(selectedOrchestration.value?.slots)
    ? selectedOrchestration.value.slots
    : []
  const kinds = orchestrationSlots.length
    ? orchestrationSlots.map(slot => slot.agentKind)
    : (Array.isArray(selectedOrchestration.value?.currentKinds)
        ? selectedOrchestration.value.currentKinds
        : [])
  const seen = new Set()
  return kinds.filter(Boolean).filter(kind => {
    if (seen.has(kind)) return false
    seen.add(kind)
    return true
  }).map(agentKind => {
    const slot = orchestrationSlots.find(item => item.agentKind === agentKind)
    return {
      agentKind,
      slotId: String(slot?.slotId || ''),
      phase: String(slot?.phase || selectedPhase.value || '').toLowerCase(),
      status: String(slot?.status || 'pending').toLowerCase(),
      role: collaborationRole(slot?.role),
    }
  })
})
const orderedHumanGates = computed(() => [...props.humanGates].sort((left, right) => (
  Number(right.agentRunId === selectedItem.value?.agentRunId)
  - Number(left.agentRunId === selectedItem.value?.agentRunId)
)))
const selectedSources = computed(() => {
  const item = selectedItem.value
  const sources = Array.isArray(item?.sources) ? item.sources : []
  if (sources.length) {
    return sources.map(source => ({
      id: String(source?.id || ''),
      available: source?.available === true && Boolean(source?.label),
      label: String(source?.label || t('trace.sourceUnavailable')),
    })).filter(source => source.id)
  }
  return (Array.isArray(item?.sourceMessageIds) ? item.sourceMessageIds : []).map(id => ({
    id,
    available: false,
    label: t('trace.sourceUnavailable'),
  }))
})
const eventLiveStatus = computed(() => {
  const item = selectedItem.value
  const event = filteredEvents(item).at(-1)
  if (!item || !event) return ''
  return [...new Set([
    agentLabel(item.agentKind),
    phaseLabel(selectedPhase.value),
    eventTypeLabel(event.type),
    eventTitle(event),
    statusLabel(event.status),
  ].filter(Boolean))].join(' / ')
})

watch(() => props.open, (value) => {
  if (!value) openSelector.value = ''
})

function focus() {
  void nextTick(() => panelElement.value?.focus())
}

function agentTabItem(group) {
  return group.agentKind === selectedItem.value?.agentKind
    ? selectedItem.value
    : group.items.at(-1)
}

function selectAgentGroup(group) {
  const item = agentTabItem(group)
  if (item?.agentRunId) {
    emit('select', item.agentRunId)
    closeSelectorMenu(true)
  }
}

function selectRound(agentRunId) {
  const selectedId = String(agentRunId || '')
  if (selectedId) {
    emit('select', selectedId)
    closeSelectorMenu(true)
  }
}

function selectorTrigger(name) {
  return name === 'agent' ? agentSelectTrigger.value : roundSelectTrigger.value
}

function selectorElement(name) {
  return name === 'agent' ? agentSelector.value : roundSelector.value
}

function focusSelectedOption() {
  void nextTick(() => {
    const selector = selectorElement(openSelector.value)
    const selected = selector?.querySelector('.trace-select-option[data-selected="true"]')
    const first = selector?.querySelector('.trace-select-option')
    ;(selected || first)?.focus?.()
  })
}

function openSelectorMenu(name) {
  if (name === 'agent' && agentGroups.value.length <= 1) return
  if (name === 'round' && selectedAgentRuns.value.length <= 1) return
  openSelector.value = name
  focusSelectedOption()
}

function toggleSelector(name) {
  if (openSelector.value === name) closeSelectorMenu(false)
  else openSelectorMenu(name)
}

function closeSelectorMenu(returnFocus = false) {
  const name = openSelector.value
  openSelector.value = ''
  if (returnFocus && name) void nextTick(() => selectorTrigger(name)?.focus?.())
}

function navigateSelector(event) {
  const options = [...event.currentTarget.querySelectorAll('.trace-select-option')]
  const current = options.indexOf(document.activeElement)
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    options[(current + 1 + options.length) % options.length]?.focus()
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    options[(current - 1 + options.length) % options.length]?.focus()
  } else if (event.key === 'Home') {
    event.preventDefault()
    options[0]?.focus()
  } else if (event.key === 'End') {
    event.preventDefault()
    options.at(-1)?.focus()
  }
}

function handlePanelEscape(event) {
  if (!openSelector.value) return
  event.preventDefault()
  event.stopPropagation()
  closeSelectorMenu(true)
}

function handleDocumentPointerDown(event) {
  const selector = selectorElement(openSelector.value)
  if (selector && !selector.contains(event.target)) closeSelectorMenu(false)
}

onMounted(() => document.addEventListener('pointerdown', handleDocumentPointerDown))
onBeforeUnmount(() => document.removeEventListener('pointerdown', handleDocumentPointerDown))

// "Always allow" grants a lasting permission, so it is never the default-looking button.
function optionApprovesHumanGate(option) {
  return ['allow_once', 'accept', 'respond'].includes(option?.kind)
}

function humanGateResponse(gateId) {
  return String(humanGateResponses[gateId] || '').trim()
}

function submitHumanGateInput(gate) {
  const option = gate?.options?.find(item => item.kind === 'respond')
  const response = humanGateResponse(gate?.gateId)
  if (!option || !response) return
  emit('decide-human-gate', { gateId: gate.gateId, optionId: option.optionId, response })
}

function cancelHumanGateInput(gate) {
  const option = gate?.options?.find(item => item.kind === 'reject')
  if (option) emit('decide-human-gate', { gateId: gate.gateId, optionId: option.optionId })
}

function humanGateDecisionPending(gateId) {
  return props.humanGateDecisionPendingIds.includes(gateId)
}

function humanGateSummary(gate) {
  const key = {
    'Agent requests permission to continue a tool action.': 'humanGate.summary.permission',
    'Cost usage is unavailable for this Agent attempt.': 'humanGate.summary.budget',
    'This run requires a human decision.': 'humanGate.summary.decision',
    'The previous write-capable Agent attempt may already have changed the workspace.': 'humanGate.summary.retry',
    'The candidate and unresolved issues have remained unchanged for two rounds.': 'humanGate.summary.stalledCandidate',
    'The workspace-write synthesis attempt may have produced side effects, but its result is unknown.': 'humanGate.summary.unknownWriteSynthesis',
  }[gate?.summary]
  return key ? t(key) : gate?.summary || ''
}

function humanGateOptionLabel(option) {
  const optionIdKey = {
    'continue-discussion': 'humanGate.option.continueDiscussion',
    'stop-discussion': 'humanGate.option.stopDiscussion',
    'retry-once': 'humanGate.option.retryOnce',
    'cancel-retry': 'humanGate.option.cancelRetry',
    'retry-original-writer': 'humanGate.option.retryOriginalWriter',
    'replace-next-writer': 'humanGate.option.replaceNextWriter',
  }[option?.optionId]
  if (optionIdKey) return t(optionIdKey)
  const key = {
    allow_once: 'humanGate.option.allowOnce',
    allow_always: 'humanGate.option.allowAlways',
    reject_once: 'humanGate.option.reject',
    reject_always: 'humanGate.option.rejectAlways',
    accept: 'humanGate.option.acceptArtifact',
    reject: 'humanGate.option.rejectArtifact',
    reopen: 'humanGate.option.reopenTask',
  }[option?.kind]
  return key ? t(key) : option?.name || ''
}

function trapFocus(event) {
  if (!props.drawer || !panelElement.value) return
  const focusable = [...panelElement.value.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
  )]
  if (!focusable.length) {
    event.preventDefault()
    panelElement.value.focus()
    return
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const focusOutside = !panelElement.value.contains(document.activeElement)
  if (event.shiftKey && (focusOutside || document.activeElement === first)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (focusOutside || document.activeElement === last)) {
    event.preventDefault()
    first.focus()
  }
}

function filteredEvents(item) {
  return retainedTraceEvents(item?.events)
}

function eventHasDetails(event) {
  return Boolean(String(event?.summary || '').trim() || String(event?.detail || '').trim())
}

function hasOnlyBareEvents(item) {
  const events = filteredEvents(item)
  return events.length > 0 && events.every(event => !eventHasDetails(event))
}

function eventKey(event, index) {
  const type = String(event?.type || '').toLowerCase()
  const family = type.startsWith('tool_')
    ? 'tool'
    : (['reasoning_summary', 'plan', 'status', 'warning'].includes(type) ? type : '')
  if (family && event?.id) return `lifecycle:${family}:${event.id}`
  if (event?.evidenceId) return `evidence:${event.evidenceId}`
  if (event?.seq != null) return `seq:${event.seq}`
  if (event?.timestamp) return `timestamp:${event.timestamp}`
  return `event:${index}`
}

function eventTypeLabel(type) {
  const key = {
    status: 'trace.eventStatus',
    reasoning_summary: 'trace.eventReasoning',
    plan: 'trace.eventPlan',
    tool_start: 'trace.eventToolStart',
    tool_update: 'trace.eventToolUpdate',
    tool_result_summary: 'trace.eventToolResult',
    warning: 'trace.eventWarning',
  }[String(type || '').toLowerCase()] || 'trace.eventOther'
  return t(key)
}

function eventTitle(event) {
  const title = String(event?.title || '').trim()
  const connectorTitleKey = {
    connector_fallback: 'trace.eventConnectorFallback',
    connector_limited: 'trace.eventConnectorLimited',
  }[title.toLowerCase()]
  if (connectorTitleKey) return t(connectorTitleKey)
  if (!title || ['agent', 'waiting_for_output'].includes(title.toLowerCase())) return eventTypeLabel(event?.type)
  return title
}

function statusTone(status) {
  const value = String(status || '').toLowerCase()
  if (['completed', 'succeeded', 'settled', 'committed'].includes(value)) return 'completed'
  if (['failed', 'timeout', 'budget-exhausted', 'circuit-breaker'].includes(value)) return 'failed'
  if (['partial', 'cancelled', 'stopped', 'interrupted'].includes(value)) return 'partial'
  if (['running', 'in_progress', 'waiting'].includes(value)) return 'running'
  return 'queued'
}

function statusLabel(status) {
  const key = {
    pending: 'pending',
    queued: 'queued',
    planned: 'queued',
    prepared: 'preparing',
    preparing: 'preparing',
    running: 'running',
    streaming: 'streaming',
    waiting: 'waiting',
    completed: 'completed',
    succeeded: 'succeeded',
    settled: 'completed',
    committed: 'completed',
    failed: 'failed',
    partial: 'partial',
    cancelled: 'cancelled',
    stopped: 'stopped',
    timeout: 'timeout',
    interrupted: 'interrupted',
    'budget-exhausted': 'budgetExhausted',
    'circuit-breaker': 'circuitBreaker',
  }[String(status || '').toLowerCase()] || 'unknown'
  return t(`run.status.${key}`)
}

function phaseLabel(phase) {
  const value = orchestrationPhase(phase)
  return value ? t(`run.phase.${value}`) : ''
}

function collaborationRole(value) {
  const role = String(value || '').trim().toLowerCase()
  return COLLABORATION_ROLES.has(role) ? role : ''
}

function collaborationRoleLabel(value) {
  const role = collaborationRole(value)
  return role ? t(`run.role.${role}`) : ''
}

function roundLabel(item) {
  const round = Number(item?.round)
  if (Number.isInteger(round) && round > 0) return t('trace.round', { count: round })
  if (Number.isInteger(round) && round === 0) return t('trace.response')
  return item?.live && ['running', 'streaming', 'waiting'].includes(String(item?.status || '').toLowerCase())
    ? t('trace.live')
    : t('trace.response')
}

function hasTraceContext(context) {
  return Number(context?.includedCount) > 0
    || Number(context?.omittedCount) > 0
    || Number(context?.charCount) > 0
    || Number.isInteger(context?.promptChars)
    || Number.isInteger(context?.promptBytes)
    || Boolean(context?.sourceHash)
    || Boolean(context?.promptHash)
    || Boolean(context?.wirePayloadHash)
    || context?.sessionRotated === true
    || Boolean(context?.contextPackId)
    || context?.contextPackState === 'legacy-unavailable'
    || Boolean(context?.deliveryRecordIds?.length)
    || Boolean(context?.sessionProvenance)
}

function sessionProvenanceSummary(provenance) {
  return t('trace.sessionProvenanceSummary', {
    scope: t(`trace.sessionScope.${provenance?.scope || 'none'}`),
    origin: t(`trace.sessionOrigin.${provenance?.origin || 'none'}`),
    completeness: t(`trace.sessionCompleteness.${provenance?.completeness || 'complete'}`),
  })
}

function sessionProvenanceWarning(provenance) {
  if (
    provenance?.scope === 'unknown-legacy'
    || provenance?.origin === 'unknown-legacy'
    || provenance?.completeness === 'unknown-legacy'
  ) return t('trace.sessionUnknownLegacyWarning')
  return provenance?.reuse ? t('trace.sessionReuseWarning') : ''
}

function formatEventTime(value) {
  if (value == null || value === '') return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(locale.value === 'zh' ? 'zh-CN' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date)
}

defineExpose({ focus })
</script>

<style scoped>
.trace-context-disclosure {
  display: grid;
  gap: 6px;
  border-radius: var(--radius-sm);
}

.trace-context-disclosure > summary {
  min-height: 30px;
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: var(--text-xs);
  font-weight: 600;
  list-style: none;
  cursor: pointer;
}

.trace-context-disclosure > summary::-webkit-details-marker {
  display: none;
}

.trace-context-disclosure > summary:hover {
  color: var(--text);
}

.trace-context-disclosure > summary svg {
  width: 13px;
  height: 13px;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.trace-context-disclosure[open] > summary svg {
  transform: rotate(180deg);
}

.trace-context-disclosure code {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
}

.trace-context-record code {
  overflow-wrap: anywhere;
}

.trace-summary-statuses,
.trace-human-gate-card header,
.trace-human-gate-card header span,
.trace-human-gate-options {
  display: flex;
  align-items: center;
}

.trace-summary-statuses {
  gap: 7px;
}

.trace-phase-feedback {
  display: grid;
  gap: 8px;
  padding: 9px 10px;
  border: 1px solid color-mix(in srgb, var(--accent) 20%, var(--border));
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--accent-soft) 52%, var(--surface-raised) 48%);
}

.trace-phase-current {
  min-width: 0;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.trace-phase-current strong {
  color: var(--accent-text);
  font-size: var(--text-xs);
}

.trace-phase-slot-list {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.trace-phase-slot-list li {
  min-width: 0;
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px;
  color: var(--text-soft);
  font-size: var(--text-xs);
}

.trace-phase-slot-list li > span {
  min-width: 0;
  flex: 1 1 88px;
  white-space: normal;
  overflow-wrap: anywhere;
}

.trace-phase-slot-list li small {
  min-width: 0;
  flex: 1 1 142px;
  color: var(--muted);
  font-size: var(--text-xs);
  line-height: 1.35;
  text-align: right;
  white-space: normal;
  overflow-wrap: anywhere;
}

.trace-waiting-state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--warning);
  font-size: var(--text-xs);
  font-weight: 600;
  white-space: nowrap;
}

.trace-human-gate-section {
  display: grid;
  gap: 8px;
  padding-top: 18px;
}

.trace-human-gate-card {
  display: grid;
  gap: 9px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--warning) 34%, var(--border));
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--warning-soft) 50%, var(--surface-raised));
}

.trace-human-gate-card header {
  justify-content: space-between;
  gap: 8px;
}

.trace-human-gate-card header span {
  min-width: 0;
  gap: 6px;
}

.trace-human-gate-card header img {
  width: 20px;
  height: 20px;
  border-radius: 50%;
}

.trace-human-gate-card header strong {
  overflow: hidden;
  font-size: var(--text-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trace-human-gate-card header small {
  color: var(--warning);
  font-size: var(--text-2xs);
  font-weight: 600;
}

.trace-human-gate-card p {
  margin: 0;
  color: var(--text-soft);
  font-size: var(--text-sm);
  line-height: 1.5;
}

.trace-human-gate-options {
  flex-wrap: wrap;
  gap: 6px;
}

.trace-human-gate-input {
  display: grid;
  gap: 10px;
}

.trace-human-gate-input input {
  width: 100%;
  min-width: 0;
}

.trace-human-gate-options button svg {
  width: 14px;
  height: 14px;
}
</style>

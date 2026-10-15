<template>
  <header class="conversation-header" :class="{ 'editing-title': inlineTitleEditing }">
    <div class="conversation-identity">
      <div v-if="activeGroup.conversationType === 'direct'" class="conversation-avatar single">
        <img :src="agentLogo(activeGroup.directAgentKind, theme)" alt="" />
      </div>
      <div v-else class="conversation-avatar stack">
        <img
          v-for="kind in activeGroup.agentKinds.slice(0, 3)"
          :key="kind"
          :src="agentLogo(kind, theme)"
          alt=""
        />
      </div>
      <div ref="titleBlock" class="conversation-title-block" tabindex="-1">
        <form v-if="inlineTitleEditing" class="inline-title-form" @submit.prevent="saveInlineTitle">
          <input
            ref="titleInput"
            v-model="inlineTitleDraft"
            :aria-label="t('settings.conversationName')"
            :placeholder="groupName(activeGroup)"
            :disabled="saving"
            maxlength="60"
            @keydown.esc.stop.prevent="cancelInlineTitleEdit"
          />
          <button
            type="submit"
            :title="t('common.save')"
            :aria-label="t('common.save')"
            :disabled="saving"
          >
            <CheckmarkCircleOutline />
          </button>
          <button
            type="button"
            :title="t('common.cancel')"
            :aria-label="t('common.cancel')"
            :disabled="saving"
            @click="cancelInlineTitleEdit"
          >
            <CloseOutline />
          </button>
        </form>
        <h1 v-else>
          <button
            ref="titleButton"
            class="conversation-title-button"
            type="button"
            :title="t('conversation.renameTitle')"
            :aria-label="t('conversation.renameTitle')"
            :disabled="Boolean(activeRun) || sending || saving"
            @click="beginInlineTitleEdit"
          >
            <span>{{ groupName(activeGroup) }}</span>
            <PencilOutline />
          </button>
        </h1>
        <p class="conversation-capabilities">
          <span>{{ activeGroup.conversationType === 'direct' ? t('conversation.direct') : t('conversation.members', { count: activeGroup.agentKinds.length }) }}</span>
          <span class="meta-separator">/</span>
          <span>{{ conversationPermissionLabel(activeGroup) }}</span>
          <template v-if="activeDirectAgent">
            <template v-if="activeDirectAgent.ready">
              <span class="meta-separator">/</span>
              <span>{{ agentSkillLabel(activeDirectAgent.kind) }}</span>
            </template>
            <span class="meta-separator">/</span>
            <span>{{ agentImageLabel(activeDirectAgent) }}</span>
          </template>
        </p>
      </div>
    </div>
    <div class="conversation-header-actions">
      <button
        class="workspace-chip"
        type="button"
        :title="activeGroup.workdir"
        :disabled="Boolean(activeRun) || sending"
        @click="openGroupSettings"
      >
        <FolderOpenOutline />
        <span>{{ compactPath(activeGroup.workdir) }}</span>
      </button>
      <button
        class="icon-button"
        type="button"
        :title="t('conversation.settings')"
        :aria-label="t('conversation.settings')"
        :disabled="Boolean(activeRun) || sending"
        @click="openGroupSettings"
      >
        <OptionsOutline />
      </button>
    </div>
  </header>
</template>

<script setup>
import { ref } from 'vue'
import {
  CheckmarkCircleOutline,
  CloseOutline,
  FolderOpenOutline,
  PencilOutline,
  OptionsOutline,
} from '@vicons/ionicons5'
import { agentLogo } from '../catalog.js'

const props = defineProps({
  controller: { type: Object, required: true },
})

const {
  activeDirectAgent,
  activeGroup,
  activeRun,
  agentImageLabel,
  agentSkillLabel,
  beginInlineTitleEdit,
  cancelInlineTitleEdit,
  compactPath,
  conversationPermissionLabel,
  groupName,
  inlineTitleDraft,
  inlineTitleEditing,
  openGroupSettings,
  saveInlineTitle,
  saving,
  sending,
  t,
  theme,
} = props.controller

const titleBlock = ref(null)
const titleInput = ref(null)
const titleButton = ref(null)
function focusTitleBlock() {
  titleBlock.value?.focus?.()
}

function focusTitleInput() {
  titleInput.value?.focus?.()
  titleInput.value?.select?.()
}

function focusTitleButton() {
  titleButton.value?.focus?.()
}

defineExpose({
  focusTitleBlock,
  focusTitleButton,
  focusTitleInput,
})
</script>

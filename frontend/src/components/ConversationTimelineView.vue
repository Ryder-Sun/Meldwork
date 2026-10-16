<template>
  <p
    v-if="activeGroup.conversationType === 'direct'"
    class="visually-hidden direct-conclusion-live-status"
    role="status"
    aria-live="polite"
    aria-atomic="true"
  >
    {{ directConclusionLiveStatus }}
  </p>
  <p
    v-if="activeGroup.conversationType === 'direct'"
    class="visually-hidden direct-trace-event-live-status"
    role="status"
    aria-live="polite"
    aria-atomic="true"
  >
    {{ directTraceEventLiveStatus }}
  </p>

  <div class="conversation-timeline">
    <div ref="messageScroller" class="message-scroll" @scroll="handleMessageScroll">
    <section v-if="conversationEmptyVisible" class="conversation-empty">
      <img class="conversation-empty-wordmark" :src="productWordmark" alt="Meldwork" />
      <Transition name="empty-showcase" mode="out-in">
        <div :key="emptyShowcaseIndex" class="conversation-empty-copy" aria-live="polite">
          <strong>{{ t(`conversation.emptyShowcase.${emptyShowcaseIndex}.title`) }}</strong>
          <p>{{ t(`conversation.emptyShowcase.${emptyShowcaseIndex}.body`) }}</p>
        </div>
      </Transition>
    </section>

    <div v-else class="message-stage">
      <nav class="turn-rail" :aria-label="t('conversation.turnRail')">
        <button
          v-for="turn in turnRailItems"
          :key="turn.id"
          type="button"
          :class="{ active: activeTurnRailId === turn.id }"
          :data-status="turn.status"
          :aria-label="turnRailLabel(turn)"
          :aria-current="activeTurnRailId === turn.id ? 'true' : undefined"
          @click="focusTurn(turn.id)"
        >
          <span aria-hidden="true" />
          <span class="turn-rail-tooltip" aria-hidden="true">{{ turnRailLabel(turn) }}</span>
        </button>
      </nav>

      <div class="message-list">
        <article
          v-for="message in timelineMessages"
          :key="message.id"
          :id="messageElementId(message.id)"
          class="message-row"
          :data-agent-kind="message.agentKind && (message.role === 'agent' || responseVersionRootId(message))
            ? message.agentKind
            : undefined"
          :class="[
            message.role,
            {
              'direct-message': activeGroup.conversationType === 'direct',
              'group-message': activeGroup.conversationType !== 'direct',
              'topic-root': activeGroup.conversationType !== 'direct' && isTopicRoot(message),
              'topic-reply': activeGroup.conversationType !== 'direct' && Boolean(messageThreadRootId(message)),
              'active-topic': isActiveRunTopic(message),
              'agent-reply-collapsed': message.role === 'agent' && !isAgentReplyExpanded(message),
              copied: isMessageCopied(message.id),
            },
          ]"
        >
          <template v-if="message.role === 'system'">
            <div class="system-message-stack">
              <div class="system-message">
                <span
                  v-if="isAgentFailureMessage(message) && message.agentKind"
                  class="system-message-agent-avatar-wrap"
                  :class="{ cloud: isCloudAgentKind(message.agentKind) }"
                >
                  <img
                    class="system-message-agent-avatar"
                    :src="agentLogo(message.agentKind, theme)"
                    :alt="agentLabel(message.agentKind)"
                  />
                  <CloudOutline v-if="isCloudAgentKind(message.agentKind)" aria-hidden="true" />
                </span>
                <WarningOutline v-else />
                <span>
                  <span>{{ translateSystemMessage(message) }}</span>
                  <MarkdownMessage
                    v-if="terminalSystemConclusion(message)"
                    :content="terminalSystemConclusion(message)"
                  />
                </span>
                <button
                  v-if="activeGroup.conversationType !== 'direct' && message.agentKind && messageHasTrace(message)"
                  class="message-trace-button"
                  type="button"
                  :data-trace-agent-run-id="messageAgentRunId(message) || undefined"
                  :title="t('trace.viewProcess')"
                  :aria-label="t('trace.viewProcess')"
                  @click.stop="openTraceForMessage(message, $event.currentTarget)"
                >
                  <TerminalOutline />
                </button>
                <button
                  v-if="isDismissibleSystemWarning(message)"
                  class="message-dismiss-button"
                  type="button"
                  :title="t('common.dismiss')"
                  :aria-label="t('common.dismiss')"
                  @click="dismissSystemMessage(message.id)"
                >
                  <CloseOutline />
                </button>
                <div
                  v-if="responseVersionInfo(message).total > 1"
                  class="response-version-controls"
                  :aria-label="t('conversation.responseVersions')"
                >
                  <button
                    type="button"
                    :disabled="!responseVersionInfo(message).hasPrevious"
                    :data-tooltip="t('conversation.previousResponseVersion')"
                    :title="t('conversation.previousResponseVersion')"
                    :aria-label="t('conversation.previousResponseVersion')"
                    @click.stop="selectResponseVersion(message, -1)"
                  >
                    <ChevronBackOutline />
                  </button>
                  <span aria-live="polite">
                    {{ t('conversation.responseVersion', responseVersionInfo(message)) }}
                  </span>
                  <button
                    type="button"
                    :disabled="!responseVersionInfo(message).hasNext"
                    :data-tooltip="t('conversation.nextResponseVersion')"
                    :title="t('conversation.nextResponseVersion')"
                    :aria-label="t('conversation.nextResponseVersion')"
                    @click.stop="selectResponseVersion(message, 1)"
                  >
                    <ChevronForwardOutline />
                  </button>
                </div>
              </div>
              <details
                v-if="activeGroup.conversationType === 'direct' && message.agentKind && messageHasTrace(message)"
                class="execution-details trace-inline-details trace-system-details"
                :open="isDirectTraceOpen(message)"
                @toggle="syncDirectTraceDisclosure(message, $event)"
              >
                <summary>
                  <TerminalOutline />
                  <span>{{ agentLabel(message.agentKind) }} · {{ t('trace.process') }}</span>
                  <small>{{ messageTraceEvents(message).length }}</small>
                  <time v-if="messageTraceStatus(message)">{{ runStatusLabel(messageTraceStatus(message)) }}</time>
                </summary>
                <p v-if="messageTraceSummary(message)" class="trace-inline-summary">
                  {{ messageTraceSummary(message) }}
                </p>
                <ol v-if="messageTraceEvents(message).length">
                  <li
                    v-for="(event, index) in messageTraceEvents(message)"
                    :key="`${messageTraceKey(message)}-${index}`"
                    class="trace-inline-event"
                  >
                    <details class="trace-inline-event-disclosure">
                      <summary>
                        <span>
                          <strong>{{ traceEventTypeLabel(event.type) }}</strong>
                          <small v-if="traceEventTitle(event)">{{ traceEventTitle(event) }}</small>
                        </span>
                        <small :class="runStatusTone(event.status)">{{ runStatusLabel(event.status) }}</small>
                      </summary>
                      <div class="trace-inline-event-body">
                        <p v-if="event.summary">{{ event.summary }}</p>
                        <pre v-if="event.detail">{{ event.detail }}</pre>
                        <p v-if="!event.summary && !event.detail" class="trace-inline-empty">
                          {{ t('trace.detailUnavailable') }}
                        </p>
                      </div>
                    </details>
                  </li>
                </ol>
                <p v-else class="trace-inline-empty">{{ t('trace.noEvents') }}</p>
              </details>
            </div>
          </template>
          <template v-else>
            <span
              v-if="message.role === 'agent'"
              class="message-avatar-wrap"
              :class="{ cloud: isCloudAgentKind(message.agentKind) }"
            >
              <img
                class="message-avatar"
                :src="agentLogo(message.agentKind, theme)"
                :alt="agentLabel(message.agentKind)"
              />
              <CloudOutline v-if="isCloudAgentKind(message.agentKind)" aria-hidden="true" />
            </span>
            <div class="message-body" :class="{ 'has-topic-replies': isTopicRoot(message) }">
              <div class="message-meta" :class="{ 'user-message-meta': message.role === 'user' }">
                <strong>{{ message.role === 'user' ? t('conversation.you') : agentLabel(message.agentKind) }}</strong>
                <span
                  v-if="message.role === 'user'
                    && activeGroup.conversationType !== 'direct'
                    && messageTargetKinds(message).length"
                  class="message-target-list"
                  :aria-label="t('composer.mentionedAgents')"
                >
                  <span
                    v-for="kind in messageTargetKinds(message)"
                    :key="kind"
                    class="message-target-avatar"
                    :title="agentLabel(kind)"
                    :aria-label="agentLabel(kind)"
                  >
                    <img :src="agentLogo(kind, theme)" alt="" />
                  </span>
                </span>
                <span v-if="isActiveRunTopic(message)" class="active-topic-label">
                  {{ t(activeGroup.conversationType === 'direct' ? 'conversation.activeTask' : 'conversation.activeTopic') }}
                </span>
                <time>{{ formatTime(message.createdAt) }}</time>
                <div class="message-meta-actions">
                  <button
                    v-if="message.role === 'user' && message.content"
                    class="message-copy-button"
                    type="button"
                    :data-tooltip="isMessageCopied(message.id) ? t('conversation.copied') : t('conversation.copyMessage')"
                    :aria-label="isMessageCopied(message.id) ? t('conversation.copied') : t('conversation.copyMessage')"
                    @click.stop="copyMessageContent(message, $event, true)"
                    @keydown.enter.prevent="copyMessageContent(message, $event, true)"
                    @keydown.space.prevent="copyMessageContent(message, $event, true)"
                  >
                    <CheckmarkCircleOutline v-if="isMessageCopied(message.id)" />
                    <CopyOutline v-else />
                  </button>
                  <button
                    v-if="message.role === 'user' && !message.provisional"
                    class="message-delete-button"
                    :class="{
                      armed: messageDeleteArmedId === message.id,
                      deleting: deletingMessageId === message.id,
                    }"
                    type="button"
                    :disabled="messageDeleteDisabled(message)"
                    :data-tooltip="messageDeleteTitle(message)"
                    :aria-label="messageDeleteTitle(message)"
                    :aria-pressed="messageDeleteArmedId === message.id ? 'true' : 'false'"
                    @click.stop="requestMessageDelete(message)"
                  >
                    <CheckmarkCircleOutline v-if="messageDeleteArmedId === message.id" />
                    <TrashOutline v-else />
                  </button>
                  <button
                    v-if="message.role === 'agent' && message.content"
                    class="message-copy-button"
                    type="button"
                    :data-tooltip="isMessageCopied(message.id) ? t('conversation.copied') : t('conversation.copyMessage')"
                    :aria-label="isMessageCopied(message.id) ? t('conversation.copied') : t('conversation.copyMessage')"
                    @click.stop="copyMessageContent(message, $event, true)"
                    @keydown.enter.prevent="copyMessageContent(message, $event, true)"
                    @keydown.space.prevent="copyMessageContent(message, $event, true)"
                  >
                    <CheckmarkCircleOutline v-if="isMessageCopied(message.id)" />
                    <CopyOutline v-else />
                  </button>
                  <button
                    v-if="message.role === 'agent'"
                    class="message-reply-toggle"
                    type="button"
                    :data-tooltip="t(isAgentReplyExpanded(message)
                      ? 'conversation.collapseAgentResponse'
                      : 'conversation.expandAgentResponse', { agent: agentLabel(message.agentKind) })"
                    :aria-label="t(isAgentReplyExpanded(message)
                      ? 'conversation.collapseAgentResponse'
                      : 'conversation.expandAgentResponse', { agent: agentLabel(message.agentKind) })"
                    :aria-expanded="String(isAgentReplyExpanded(message))"
                    @click.stop="toggleAgentReply(message)"
                  >
                    <ChevronDownOutline :class="{ expanded: isAgentReplyExpanded(message) }" />
                  </button>
                </div>
              </div>
              <template v-if="message.role === 'agent'">
                <template v-if="isAgentReplyExpanded(message)">
                  <div
                    class="message-copy-surface message-trace-surface"
                    :class="{ copied: isMessageCopied(message.id) }"
                    :tabindex="messageHasTrace(message) ? 0 : undefined"
                    :role="messageHasTrace(message) ? 'button' : undefined"
                    :aria-label="messageHasTrace(message) ? t('trace.viewProcess') : undefined"
                    @click="openAgentMessageTrace(message, $event)"
                    @keydown.enter.prevent="openAgentMessageTrace(message, $event)"
                    @keydown.space.prevent="openAgentMessageTrace(message, $event)"
                  >
                    <MarkdownMessage
                      v-if="message.content"
                      :content="message.content"
                      :mention-profiles="(activeGroup.agentKinds || []).map(kind => ({ kind, label: agentLabel(kind) }))"
                    />
                    <span v-else class="trace-waiting-output">
                      <span class="typing-bars" aria-hidden="true"><span /><span /><span /></span>
                      {{ t('trace.waitingOutput') }}
                    </span>
                  </div>
                <details
                  v-if="messageExecutionSteps(message).length && !messageHasTrace(message)"
                  class="execution-details"
                >
                  <summary>
                    <TerminalOutline />
                    <span>{{ t('conversation.executionProcess') }}</span>
                    <small>{{ messageExecutionSteps(message).length }}</small>
                    <time v-if="messageElapsedLabel(message)">{{ messageElapsedLabel(message) }}</time>
                  </summary>
                  <ol>
                    <li v-for="(step, index) in messageExecutionSteps(message)" :key="`${message.id}-${index}`">
                      <span>{{ localizedStepTitle(step, index) }}</span>
                      <small :class="runStatusTone(step.status)">{{ runStatusLabel(step.status) }}</small>
                    </li>
                  </ol>
                </details>
                  <details
                    v-if="messageHasTrace(message)"
                    class="execution-details trace-inline-details"
                    :open="isDirectTraceOpen(message)"
                    @toggle="syncDirectTraceDisclosure(message, $event)"
                  >
                  <summary>
                    <TerminalOutline />
                    <span>{{ agentLabel(message.agentKind) }} · {{ t('trace.process') }}</span>
                    <small>{{ messageTraceEvents(message).length }}</small>
                    <time v-if="messageTraceStatus(message)">{{ runStatusLabel(messageTraceStatus(message)) }}</time>
                  </summary>
                  <p v-if="messageTraceSummary(message)" class="trace-inline-summary">
                    {{ messageTraceSummary(message) }}
                  </p>
                  <ol v-if="messageTraceEvents(message).length">
                    <li
                      v-for="(event, index) in messageTraceEvents(message)"
                      :key="`${messageTraceKey(message)}-${index}`"
                      class="trace-inline-event"
                    >
                      <details class="trace-inline-event-disclosure">
                        <summary>
                          <span>
                            <strong>{{ traceEventTypeLabel(event.type) }}</strong>
                            <small v-if="traceEventTitle(event)">{{ traceEventTitle(event) }}</small>
                          </span>
                          <small :class="runStatusTone(event.status)">{{ runStatusLabel(event.status) }}</small>
                        </summary>
                        <div class="trace-inline-event-body">
                          <p v-if="event.summary">{{ event.summary }}</p>
                          <pre v-if="event.detail">{{ event.detail }}</pre>
                          <p v-if="!event.summary && !event.detail" class="trace-inline-empty">
                            {{ t('trace.detailUnavailable') }}
                          </p>
                        </div>
                      </details>
                    </li>
                  </ol>
                    <p v-else class="trace-inline-empty">{{ t('trace.noEvents') }}</p>
                  </details>
                </template>
              </template>
              <template v-else>
                <div class="user-message-flow">
                  <div
                    v-if="message.content
                      || (activeGroup.conversationType !== 'direct' && messageTargetKinds(message).length)
                      || messageSkills(message).length
                      || messageKnowledgeBases(message).length"
                    :ref="element => setUserMessageContentElement(message.id, element)"
                    class="message-content message-copy-surface user-message-content"
                    :class="{
                      copied: isMessageCopied(message.id),
                      collapsed: isUserMessageCollapsed(message.id),
                    }"
                    @click="copyMessageContent(message, $event)"
                  >
                    <span
                      v-if="messageSkills(message).length || messageKnowledgeBases(message).length"
                      class="message-skill-list"
                    ><span v-for="skill in messageSkills(message)" :key="skillKey(skill)">
                        <LibraryOutline aria-hidden="true" />
                        {{ skill.name || skill.slug }}
                      </span><span
                        v-for="source in messageKnowledgeBases(message)"
                        :key="`knowledge:${source.kind}`"
                        class="message-knowledge-base"
                        :title="knowledgeBaseName(source.kind)"
                        :aria-label="knowledgeBaseName(source.kind)"
                      >
                        <img :src="knowledgeBaseLogo(source.kind)" alt="" />
                      </span></span><MarkdownMessage
                      v-if="message.content"
                      class="user-message-markdown"
                      :content="message.content"
                    />
                  </div>
                  <button
                    v-if="isUserMessageCollapsible(message.id)"
                    class="user-message-expand-button"
                    type="button"
                    :aria-expanded="String(!isUserMessageCollapsed(message.id))"
                    @click.stop="toggleUserMessageExpansion(message.id)"
                  >
                    {{ isUserMessageCollapsed(message.id)
                      ? t('conversation.expandMessage')
                      : t('conversation.collapseMessage') }}
                  </button>
                </div>
                <button
                  v-if="isTopicRoot(message)"
                  class="topic-toggle topic-reply-summary"
                  type="button"
                  :aria-expanded="isTopicExpanded(message.id) ? 'true' : 'false'"
                  :aria-label="topicToggleLabel(message.id)"
                  @click="toggleTopic(message.id)"
                >
                  <span class="topic-reply-avatars" aria-hidden="true">
                    <span
                      v-for="kind in topicReplyAgentKinds(message.id)"
                      :key="kind"
                      class="topic-reply-avatar-wrap"
                      :class="{ cloud: isCloudAgentKind(kind) }"
                    >
                      <img
                        :src="agentLogo(kind, theme)"
                        :alt="agentLabel(kind)"
                      />
                      <CloudOutline v-if="isCloudAgentKind(kind)" aria-hidden="true" />
                    </span>
                  </span>
                  <span>{{ topicReplyLabel(topicReplyCount(message.id)) }}</span>
                  <ChevronDownOutline :class="{ collapsed: !isTopicExpanded(message.id) }" />
                </button>
              </template>
              <div
                v-if="messageAttachments(message).length
                  && (message.role !== 'agent' || isAgentReplyExpanded(message))"
                class="message-attachment-grid"
              >
                <figure
                  v-for="attachment in mediaMessageAttachments(message)"
                  :key="attachment.id"
                  v-attachment-preview="isImageAttachment(attachment) ? attachment : null"
                  :class="`media-${attachmentKind(attachment)}`"
                >
                  <button
                    v-if="isImageAttachment(attachment) && (attachmentPreviewUrl(attachment) || attachmentMediaUrl(attachment))"
                    class="message-media-preview-trigger"
                    type="button"
                    :title="t('attachment.preview', { name: attachment.name })"
                    :aria-label="t('attachment.preview', { name: attachment.name })"
                    @click="openMediaPreview(attachment)"
                  >
                    <img
                      :src="attachmentPreviewUrl(attachment) || attachmentMediaUrl(attachment)"
                      :alt="attachment.name"
                      loading="lazy"
                      decoding="async"
                    />
                  </button>
                  <audio
                    v-else-if="attachmentKind(attachment) === 'audio'"
                    :src="attachmentMediaUrl(attachment)"
                    :aria-label="attachment.name"
                    controls
                    preload="metadata"
                  />
                  <button
                    v-else-if="attachmentKind(attachment) === 'video'"
                    class="message-media-preview-trigger"
                    type="button"
                    :title="t('attachment.preview', { name: attachment.name })"
                    :aria-label="t('attachment.preview', { name: attachment.name })"
                    @click="openMediaPreview(attachment)"
                  >
                    <video
                      :src="attachmentMediaUrl(attachment)"
                      :aria-label="attachment.name"
                      muted
                      preload="metadata"
                      playsinline
                    />
                  </button>
                  <figcaption
                    v-if="attachmentKind(attachment) !== 'file' && message.role !== 'agent'"
                    :title="attachment.name"
                  >
                    {{ attachment.name }}
                  </figcaption>
                </figure>
                <div
                  v-if="documentMessageAttachments(message).length"
                  class="message-document-list"
                >
                  <button
                    v-for="attachment in documentMessageAttachments(message)"
                    :key="attachment.id"
                    class="message-document-attachment"
                    type="button"
                    :title="t('attachment.open', { name: attachment.name })"
                    :aria-label="t('attachment.open', { name: attachment.name })"
                    @click="openAttachment(attachment)"
                  >
                    <component
                      :is="attachmentDocumentIcon(attachment)"
                      class="message-document-icon"
                      :data-document-icon="attachmentDocumentIconName(attachment)"
                      aria-hidden="true"
                    />
                    <span>
                      <strong>{{ attachment.name }}</strong>
                      <small>{{ attachmentTypeLabel(attachment) }} · {{ formatAttachmentSize(attachment) }}</small>
                    </span>
                    <OpenOutline aria-hidden="true" />
                  </button>
                </div>
              </div>
              <div v-if="message.role === 'agent'" class="message-footer-actions">
                <div
                  v-if="responseVersionInfo(message).total > 1"
                  class="response-version-controls"
                  :aria-label="t('conversation.responseVersions')"
                >
                  <button
                    type="button"
                    :disabled="!responseVersionInfo(message).hasPrevious"
                    :data-tooltip="t('conversation.previousResponseVersion')"
                    :title="t('conversation.previousResponseVersion')"
                    :aria-label="t('conversation.previousResponseVersion')"
                    @click.stop="selectResponseVersion(message, -1)"
                  >
                    <ChevronBackOutline />
                  </button>
                  <span aria-live="polite">
                    {{ t('conversation.responseVersion', responseVersionInfo(message)) }}
                  </span>
                  <button
                    type="button"
                    :disabled="!responseVersionInfo(message).hasNext"
                    :data-tooltip="t('conversation.nextResponseVersion')"
                    :title="t('conversation.nextResponseVersion')"
                    :aria-label="t('conversation.nextResponseVersion')"
                    @click.stop="selectResponseVersion(message, 1)"
                  >
                    <ChevronForwardOutline />
                  </button>
                </div>
                <button
                  v-if="!message.provisional"
                  class="message-regenerate-button"
                  type="button"
                  :disabled="messageRegenerateDisabled(message)"
                  :data-tooltip="messageRegenerateTitle(message)"
                  :aria-label="messageRegenerateTitle(message)"
                  @click.stop="regenerateMessage(message)"
                >
                  <RefreshOutline :class="{ spinning: isMessageRegenerating(message) }" />
                </button>
                <button
                  v-if="!message.provisional"
                  class="message-delete-button"
                  :class="{
                    armed: messageDeleteArmedId === message.id,
                    deleting: deletingMessageId === message.id,
                  }"
                  type="button"
                  :disabled="messageDeleteDisabled(message)"
                  :data-tooltip="messageDeleteTitle(message)"
                  :aria-label="messageDeleteTitle(message)"
                  :aria-pressed="messageDeleteArmedId === message.id ? 'true' : 'false'"
                  @click.stop="requestMessageDelete(message)"
                >
                  <CheckmarkCircleOutline v-if="messageDeleteArmedId === message.id" />
                  <TrashOutline v-else />
                </button>
              </div>
            </div>
          </template>
        </article>

        <section
          v-if="activeGroup.conversationType === 'direct' && directHumanGates.length"
          class="direct-human-gate-list"
          :aria-label="t('humanGate.pendingTitle')"
          aria-live="polite"
        >
          <article v-for="gate in directHumanGates" :key="gate.gateId" class="human-gate-card">
            <header>
              <span class="human-gate-agent">
                <span class="human-gate-agent-avatar" :class="{ cloud: isCloudAgentKind(gate.agentKind) }">
                  <img :src="agentLogo(gate.agentKind, theme)" alt="" />
                  <CloudOutline v-if="isCloudAgentKind(gate.agentKind)" aria-hidden="true" />
                </span>
                <strong>{{ agentLabel(gate.agentKind) }}</strong>
              </span>
              <small>{{ t(`humanGate.type.${gate.type}`) }}</small>
            </header>
            <p>{{ humanGateSummary(gate) }}</p>
            <form
              v-if="gate.type === 'input'"
              class="human-gate-input"
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
              <div class="human-gate-options">
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
            <div v-else class="human-gate-options">
              <button
                v-for="option in gate.options"
                :key="option.optionId"
                class="compact"
                :class="optionApprovesHumanGate(option) ? 'primary-button' : 'secondary-button'"
                type="button"
                :disabled="humanGateDecisionPending(gate.gateId)"
                @click="decideHumanGate({ gateId: gate.gateId, optionId: option.optionId })"
              >
                <CheckmarkCircleOutline v-if="optionApprovesHumanGate(option)" />
                <CloseCircleOutline v-else />
                {{ humanGateOptionLabel(option) }}
              </button>
            </div>
          </article>
        </section>

        <details
          v-if="activeGroup.conversationType === 'direct' && directBudgetRows.length"
          class="execution-details direct-budget-details"
        >
          <summary>
            <span>{{ t('trace.budgetTitle') }}</span>
            <small>{{ directBudgetRows.length }}</small>
          </summary>
          <dl>
            <div v-for="row in directBudgetRows" :key="row.dimension">
              <dt>{{ row.label }}</dt>
              <dd>{{ row.usage }}</dd>
              <small>{{ row.meta }}</small>
            </div>
          </dl>
        </details>

        <section
          v-if="displayedRun && (activeGroup.conversationType !== 'direct' || !provisionalMessages.length)"
          class="run-status-panel"
          :class="{
            direct: activeGroup.conversationType === 'direct',
            group: activeGroup.conversationType !== 'direct',
            solo: !isDisplayedCoordinatedRun,
            multi: isDisplayedCoordinatedRun,
            history: !activeRun,
          }"
          aria-live="polite"
        >
          <header class="run-status-header">
            <div v-if="!isDisplayedCoordinatedRun" class="direct-run-indicator" aria-hidden="true">
              <span
                class="run-agent-logo"
                :class="{ cloud: isCloudAgentKind(displayedRunAgentKind) }"
                :data-status="displayedRunAgentTone"
              >
                <img :src="agentLogo(displayedRunAgentKind, theme)" alt="" />
                <CloudOutline v-if="isCloudAgentKind(displayedRunAgentKind)" aria-hidden="true" />
              </span>
              <div v-if="displayedRunAgentTone === 'running'" class="typing-bars"><span /><span /><span /></div>
            </div>
            <div v-else class="relay-run-indicator" aria-hidden="true">
              <span
                v-for="(kind, index) in displayedRunTargetKinds"
                :key="kind"
                class="run-agent-logo relay-run-agent"
                :class="{ cloud: isCloudAgentKind(kind) }"
                :data-status="displayedRunAgentToneForKind(kind)"
                :style="{ '--avatar-index': index }"
              >
                <img :src="agentLogo(kind, theme)" alt="" />
                <CloudOutline v-if="isCloudAgentKind(kind)" aria-hidden="true" />
              </span>
            </div>
            <div class="run-status-copy">
              <strong>{{ displayedRunLabel }}</strong>
              <span
                v-if="!isDisplayedCoordinatedRun && (activeRun || !displayedRun.authoritative)"
                class="solo-run-status"
                :data-status="displayedRunAgentTone"
              >
                {{ runStatusLabel(displayedRunAgentStatus) }}
              </span>
              <div class="run-status-meta">
                <span v-if="displayedRunTopicRootId">
                  {{ t(activeRun
                    ? (activeGroup.conversationType === 'direct' ? 'conversation.activeTask' : 'conversation.activeTopic')
                    : 'conversation.retainedTopic') }}
                </span>
                <span v-if="runRoundProgress" class="run-round-progress">
                  {{ t(runRoundProgress.unlimited ? 'run.roundProgressUnlimited' : 'run.roundProgress', runRoundProgress) }}
                </span>
              </div>
              <div
                v-if="isDisplayedCoordinatedRun && displayedRunPhaseLabel"
                class="run-phase-feedback"
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                <span class="run-phase-feedback-label">{{ t('run.phaseFeedback') }}</span>
                <strong>{{ displayedRunPhaseLabel }}</strong>
                <small v-if="displayedRunPhaseSlots.length">
                  {{ t('run.phaseSlots', {
                    completed: displayedRunPhaseSlots.filter(slot => orchestrationSlotCompleted(slot.status)).length,
                    total: displayedRunPhaseSlots.length,
                  }) }}
                </small>
              </div>
            </div>
            <button
              v-if="activeGroup.conversationType !== 'direct' && displayedRunAgentRuns.length"
              class="icon-button run-details-button"
              type="button"
              :title="t('run.openDetails')"
              :aria-label="t('run.openDetails')"
              @click="openDisplayedRunTrace($event.currentTarget)"
            >
              <TerminalOutline />
            </button>
          </header>
          <div v-if="isDisplayedCoordinatedRun" class="run-agent-list" :aria-label="t('run.agents')">
            <button
              v-for="(kind, index) in displayedRunTargetKinds"
              :key="kind"
              class="run-agent-row"
              :data-status="displayedRunAgentToneForKind(kind)"
              :data-trace-agent-run-id="displayedRunAgentForKind(kind)?.agentRunId || undefined"
              :style="{ '--reveal-index': index }"
              type="button"
              :disabled="!displayedRunAgentForKind(kind)"
              :aria-label="displayedRunAgentTraceLabel(kind)"
              @click="openDisplayedTraceForAgent(kind, $event.currentTarget)"
            >
              <span
                class="run-agent-logo"
                :class="{ cloud: isCloudAgentKind(kind) }"
                :data-status="displayedRunAgentToneForKind(kind)"
                aria-hidden="true"
              >
                <img :src="agentLogo(kind, theme)" alt="" />
                <CloudOutline v-if="isCloudAgentKind(kind)" aria-hidden="true" />
              </span>
              <strong class="visually-hidden">{{ agentLabel(kind) }}</strong>
              <span class="run-agent-state">
                <span class="run-agent-motion" :data-status="displayedRunAgentToneForKind(kind)" aria-hidden="true">
                  <CheckmarkCircleOutline v-if="displayedRunAgentToneForKind(kind) === 'completed'" />
                  <CloseCircleOutline v-else-if="displayedRunAgentToneForKind(kind) === 'failed'" />
                  <span v-else-if="displayedRunAgentToneForKind(kind) === 'running'" class="run-agent-bars">
                    <i /><i /><i />
                  </span>
                  <WarningOutline v-else-if="displayedRunAgentToneForKind(kind) === 'partial'" />
                  <span v-else class="run-agent-dots"><i /><i /><i /></span>
                </span>
                <small class="visually-hidden" :class="displayedRunAgentToneForKind(kind)">
                  {{ runStatusLabel(displayedRunAgentStatusForKind(kind)) }}
                </small>
              </span>
            </button>
          </div>
          <div v-if="activeRunProgress.length && !activeRunHasAgentRuns" class="execution-details run-progress-details">
            <div class="execution-progress-header">
              <TerminalOutline />
              <span>{{ t('run.progress') }}</span>
              <small>{{ activeRunProgress.length }}</small>
            </div>
            <ol>
              <li v-for="(step, index) in activeRunProgress" :key="`${step.title}-${index}`">
                <span>{{ localizedStepTitle(step, index) }}</span>
                <small :class="runStatusTone(step.status)">{{ runStatusLabel(step.status) }}</small>
              </li>
            </ol>
          </div>
        </section>
      </div>
    </div>
    </div>
    <Transition name="conversation-jump-to-latest">
      <button
        v-if="showScrollToLatest"
        class="conversation-jump-to-latest"
        type="button"
        :data-tooltip="t('conversation.jumpToLatest')"
        :aria-label="t('conversation.jumpToLatest')"
        @click="scrollToLatest({ force: true, behavior: 'smooth' })"
      >
        <ArrowDownOutline aria-hidden="true" />
      </button>
    </Transition>
  </div>
  <AttachmentMediaPreview
    v-if="mediaPreviewAttachment"
    :attachment="mediaPreviewAttachment"
    :close-label="t('attachment.closePreview')"
    :source="attachmentMediaUrl(mediaPreviewAttachment)"
    :type="attachmentKind(mediaPreviewAttachment)"
    @close="closeMediaPreview"
  />
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  ArrowDownOutline,
  AttachOutline,
  ArchiveOutline,
  CheckmarkCircleOutline,
  ChevronBackOutline,
  ChevronDownOutline,
  ChevronForwardOutline,
  CloudOutline,
  CloseCircleOutline,
  CloseOutline,
  CodeOutline,
  CopyOutline,
  DocumentOutline,
  DocumentTextOutline,
  EaselOutline,
  GridOutline,
  LibraryOutline,
  OpenOutline,
  ReaderOutline,
  RefreshOutline,
  TerminalOutline,
  TrashOutline,
  WarningOutline,
} from '@vicons/ionicons5'
import { agentLabel, agentLogo, isCloudAgentKind } from '../catalog.js'
import { skillKey } from '../composables/useComposerContext.js'
import { orchestrationSlotCompleted } from '../desktop-normalization.js'
import { locale } from '../i18n.js'
import { messageKnowledgeBases, messageSkills, messageTargetKinds } from '../messageContext.js'
import { isAgentFailureMessage, responseVersionRootId } from '../conversationTimelineModel.js'
import AttachmentMediaPreview from './AttachmentMediaPreview.vue'
import MarkdownMessage from './MarkdownMessage.vue'

const props = defineProps({
  controller: { type: Object, required: true },
})

const {
  activeGroup,
  activeRun,
  activeRunHasAgentRuns,
  activeRunProgress,
  activeTurnRailId,
  attachmentKind,
  attachmentMediaUrl,
  attachmentPreviewUrl,
  attachmentTypeLabel,
  conversationEmptyVisible,
  copyMessageContent,
  deletingMessageId,
  directConclusionLiveStatus,
  directTraceEventLiveStatus,
  dismissSystemMessage,
  displayedRun,
  displayedRunAgentForKind,
  displayedRunAgentKind,
  displayedRunAgentRuns,
  displayedRunAgentStatus,
  displayedRunAgentStatusForKind,
  displayedRunAgentTone,
  displayedRunAgentToneForKind,
  displayedRunAgentTraceLabel,
  displayedRunLabel,
  displayedRunPhaseLabel,
  displayedRunPhaseSlots,
  displayedRunTargetKinds,
  displayedRunTopicRootId,
  emptyShowcaseIndex,
  focusTurn,
  formatTime,
  formatAttachmentSize,
  handleMessageScroll,
  isActiveRunTopic,
  isAgentReplyExpanded,
  isDirectTraceOpen,
  isDismissibleSystemWarning,
  isDisplayedCoordinatedRun,
  isImageAttachment,
  isMessageCopied,
  isMessageRegenerating,
  isTopicExpanded,
  isTopicRoot,
  knowledgeBaseLogo,
  knowledgeBaseName,
  localizedStepTitle,
  messageAgentRunId,
  messageAttachments,
  messageDeleteArmedId,
  messageDeleteDisabled,
  messageDeleteTitle,
  messageElapsedLabel,
  messageElementId,
  messageExecutionSteps,
  messageHasTrace,
  messageRegenerateDisabled,
  messageRegenerateTitle,
  messageScroller,
  messageThreadRootId,
  messageTraceEvents,
  messageTraceKey,
  messageTraceStatus,
  messageTraceSummary,
  openDisplayedRunTrace,
  openAttachment,
  openDisplayedTraceForAgent,
  openTraceForMessage,
  productWordmark,
  provisionalMessages,
  regenerateMessage,
  requestMessageDelete,
  responseVersionInfo,
  runRoundProgress,
  runStatusLabel,
  runStatusTone,
  scrollToLatest,
  selectResponseVersion,
  showScrollToLatest,
  syncDirectTraceDisclosure,
  t,
  terminalSystemConclusion,
  theme,
  timelineMessages,
  toggleAgentReply,
  toggleTopic,
  topicReplyAgentKinds,
  topicReplyCount,
  topicReplyLabel,
  topicToggleLabel,
  traceEventTitle,
  traceEventTypeLabel,
  translateSystemMessage,
  turnRailItems,
  turnRailLabel,
  vAttachmentPreview,
} = props.controller

const BUDGET_DIMENSIONS = [
  'inputTokens', 'outputTokens', 'costMicros', 'toolCalls', 'outboundBytes', 'elapsedMs',
]
const directHumanGates = computed(() => props.controller.directHumanGates?.value || [])
const directRunBudget = computed(() => props.controller.directRunBudget?.value || null)
const humanGateDecisionPendingIds = computed(() => (
  props.controller.humanGateDecisionPendingIds?.value || []
))
const humanGateResponses = reactive({})
const directBudgetRows = computed(() => budgetRows(directRunBudget.value))
const USER_MESSAGE_COLLAPSE_HEIGHT = 216
const userMessageElements = new Map()
const collapsibleUserMessageIds = ref(new Set())
const expandedUserMessageIds = ref(new Set())
let userMessageResizeObserver = null
let userMessageMeasurementQueued = false
const mediaPreviewAttachment = ref(null)
const DOCUMENT_ICON_COMPONENTS = {
  archive: ArchiveOutline,
  code: CodeOutline,
  document: DocumentOutline,
  pdf: DocumentTextOutline,
  presentation: EaselOutline,
  spreadsheet: GridOutline,
  text: ReaderOutline,
}
const DOCUMENT_ICON_BY_EXTENSION = {
  '7z': 'archive', gz: 'archive', tar: 'archive', tgz: 'archive', zip: 'archive',
  c: 'code', cc: 'code', cjs: 'code', cpp: 'code', css: 'code', go: 'code', h: 'code',
  hpp: 'code', html: 'code', java: 'code', js: 'code', json: 'code', md: 'code', mjs: 'code',
  py: 'code', rs: 'code', sh: 'code', ts: 'code', tsx: 'code', vue: 'code', xml: 'code', yaml: 'code', yml: 'code',
  csv: 'spreadsheet', ods: 'spreadsheet', xls: 'spreadsheet', xlsx: 'spreadsheet',
  doc: 'text', docx: 'text', odt: 'text', rtf: 'text', txt: 'text',
  key: 'presentation', odp: 'presentation', ppt: 'presentation', pptx: 'presentation',
  pdf: 'pdf',
}

function sameIds(left, right) {
  return left.size === right.size && [...left].every(id => right.has(id))
}

function measureUserMessageContent() {
  if (userMessageMeasurementQueued) return
  userMessageMeasurementQueued = true
  void nextTick(() => {
    userMessageMeasurementQueued = false
    const nextCollapsibleIds = new Set()
    userMessageElements.forEach((element, id) => {
      if (element.scrollHeight > USER_MESSAGE_COLLAPSE_HEIGHT + 1) {
        nextCollapsibleIds.add(id)
      }
    })
    if (!sameIds(nextCollapsibleIds, collapsibleUserMessageIds.value)) {
      collapsibleUserMessageIds.value = nextCollapsibleIds
    }
    const nextExpandedIds = new Set(
      [...expandedUserMessageIds.value].filter(id => nextCollapsibleIds.has(id)),
    )
    if (!sameIds(nextExpandedIds, expandedUserMessageIds.value)) {
      expandedUserMessageIds.value = nextExpandedIds
    }
  })
}

function setUserMessageContentElement(id, element) {
  const messageId = String(id || '')
  if (!messageId) return
  const previous = userMessageElements.get(messageId)
  if (!element) {
    if (previous) userMessageResizeObserver?.unobserve(previous)
    userMessageElements.delete(messageId)
    return
  }
  if (previous && previous !== element) userMessageResizeObserver?.unobserve(previous)
  userMessageElements.set(messageId, element)
  userMessageResizeObserver?.observe(element)
  measureUserMessageContent()
}

function isUserMessageCollapsible(id) {
  return collapsibleUserMessageIds.value.has(String(id || ''))
}

function isUserMessageCollapsed(id) {
  const messageId = String(id || '')
  return isUserMessageCollapsible(messageId) && !expandedUserMessageIds.value.has(messageId)
}

function toggleUserMessageExpansion(id) {
  const messageId = String(id || '')
  if (!isUserMessageCollapsible(messageId)) return
  const next = new Set(expandedUserMessageIds.value)
  if (next.has(messageId)) next.delete(messageId)
  else next.add(messageId)
  expandedUserMessageIds.value = next
}

watch(timelineMessages, measureUserMessageContent, { flush: 'post', immediate: true })

onMounted(() => {
  if (typeof ResizeObserver === 'function') {
    userMessageResizeObserver = new ResizeObserver(measureUserMessageContent)
    userMessageElements.forEach(element => userMessageResizeObserver.observe(element))
  }
  measureUserMessageContent()
})

onBeforeUnmount(() => userMessageResizeObserver?.disconnect())

function openMediaPreview(attachment) {
  if (!['image', 'video'].includes(attachmentKind(attachment)) || !attachmentMediaUrl(attachment)) return
  mediaPreviewAttachment.value = attachment
}

function closeMediaPreview() {
  mediaPreviewAttachment.value = null
}

function openAgentMessageTrace(message, event) {
  if (!messageHasTrace(message)) return
  const target = event?.target
  if (target instanceof Element && target.closest(
    'a, button, input, textarea, select, option, form, summary, [contenteditable="true"]',
  )) return
  const selection = typeof window.getSelection === 'function' ? window.getSelection() : null
  if (selection && String(selection).trim()) return
  openTraceForMessage(message, event?.currentTarget || null)
}

function attachmentDocumentIconName(attachment) {
  const extension = String(attachment?.name || '').split('.').pop()?.toLowerCase() || ''
  return DOCUMENT_ICON_BY_EXTENSION[extension] || 'document'
}

function attachmentDocumentIcon(attachment) {
  return DOCUMENT_ICON_COMPONENTS[attachmentDocumentIconName(attachment)] || DocumentOutline
}

function mediaMessageAttachments(message) {
  return messageAttachments(message).filter(attachment => attachmentKind(attachment) !== 'file')
}

function documentMessageAttachments(message) {
  return messageAttachments(message).filter(attachment => attachmentKind(attachment) === 'file')
}

function decideHumanGate(payload) {
  return props.controller.decideHumanGate?.(payload)
}

function humanGateResponse(gateId) {
  return String(humanGateResponses[gateId] || '').trim()
}

function submitHumanGateInput(gate) {
  const option = gate?.options?.find(item => item.kind === 'respond')
  const response = humanGateResponse(gate?.gateId)
  if (!option || !response) return false
  return decideHumanGate({ gateId: gate.gateId, optionId: option.optionId, response })
}

function cancelHumanGateInput(gate) {
  const option = gate?.options?.find(item => item.kind === 'reject')
  return option ? decideHumanGate({ gateId: gate.gateId, optionId: option.optionId }) : false
}

function optionApprovesHumanGate(option) {
  return ['allow_once', 'allow_always', 'accept', 'respond'].includes(option?.kind)
}

function humanGateDecisionPending(gateId) {
  return humanGateDecisionPendingIds.value.includes(gateId)
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

function budgetRows(budget) {
  if (!budget) return []
  const rows = BUDGET_DIMENSIONS.map((dimension) => {
    const used = budget.used[dimension]
    const limit = budget.limits[dimension]
    return {
      dimension,
      label: t(`trace.budgetDimension.${dimension}`),
      usage: t('trace.budgetUsage', {
        used: formatBudgetNumber(used),
        limit: limit === null ? t('trace.budgetUnlimited') : formatBudgetNumber(limit),
      }),
      meta: `${t(`trace.budgetSource.${budget.source[dimension]}`)} / ${t(`trace.budgetEnforcement.${budget.enforcement[dimension]}`)}`,
      meaningful: used > 0 || limit !== null || budget.source[dimension] !== 'unknown'
        || budget.enforcement[dimension] === 'hard',
    }
  }).filter(row => row.meaningful)
  const exhaustion = budget.exhaustion
  if (exhaustion) {
    rows.unshift({
      dimension: `exhaustion:${exhaustion.dimension}`,
      label: `${t(`trace.budgetDimension.${exhaustion.dimension}`)} · ${t('trace.budgetExhaustion')}`,
      usage: t('trace.budgetUsage', {
        used: formatBudgetNumber(exhaustion.used),
        limit: formatBudgetNumber(exhaustion.limit),
      }),
      meta: t('trace.budgetAttempt', {
        prior: formatBudgetNumber(exhaustion.priorUsed),
        attempted: formatBudgetNumber(exhaustion.attemptedUsage),
      }),
    })
  }
  return rows
}

function formatBudgetNumber(value) {
  return new Intl.NumberFormat(locale.value === 'zh' ? 'zh-CN' : 'en-US').format(value)
}
</script>

<style scoped>
.direct-human-gate-list {
  display: grid;
  gap: 8px;
  margin: 4px 0;
}

.human-gate-card {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-raised);
}

.human-gate-card header,
.human-gate-agent,
.human-gate-options {
  display: flex;
  align-items: center;
}

.human-gate-card header {
  justify-content: space-between;
  gap: 10px;
}

.human-gate-card header small {
  color: var(--accent-hover);
  font-size: 10px;
  font-weight: 700;
}

.human-gate-agent {
  min-width: 0;
  gap: 7px;
}

.human-gate-agent-avatar {
  position: relative;
  width: 22px;
  height: 22px;
  flex: 0 0 auto;
  display: block;
}

.human-gate-agent-avatar img {
  width: 22px;
  height: 22px;
  border-radius: 50%;
}

.human-gate-agent-avatar > svg {
  position: absolute;
  right: -4px;
  bottom: -3px;
  width: 12px;
  height: 12px;
  padding: 2px;
  border-radius: 50%;
  background: var(--surface-raised);
  color: var(--accent);
}

.human-gate-card p {
  margin: 0;
  color: var(--text-soft);
  font-size: 12px;
  line-height: 1.5;
}

.human-gate-options {
  flex-wrap: wrap;
  gap: 7px;
}

.human-gate-input {
  display: grid;
  gap: 10px;
}

.human-gate-input input {
  width: 100%;
  min-width: 0;
}

.human-gate-options button svg {
  width: 15px;
  height: 15px;
}

.direct-budget-details {
  margin-top: 8px;
}

.direct-budget-details summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.direct-budget-details dl {
  display: grid;
  gap: 5px;
  margin: 8px 0 0;
}

.direct-budget-details dl div {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 2px 10px;
  color: var(--text-soft);
  font-size: 11px;
}

.direct-budget-details dd {
  margin: 0;
}

.direct-budget-details dl small {
  grid-column: 1 / -1;
  color: var(--muted);
  font-size: 9px;
}
</style>

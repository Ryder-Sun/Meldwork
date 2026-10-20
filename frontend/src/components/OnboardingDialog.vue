<template>
  <div class="onboarding-backdrop">
    <section
      ref="dialog"
      class="onboarding-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
      tabindex="-1"
      @keydown.left="selectOnboardingSlide(onboardingIndex - 1)"
      @keydown.right="selectOnboardingSlide(onboardingIndex + 1)"
    >
      <div class="onboarding-slide-viewport">
        <transition name="onboarding-slide">
          <article :key="onboardingIndex" class="onboarding-slide" :class="{ 'preferences-slide': onboardingSlide.preferences }">
            <img v-if="!onboardingSlide.preferences" :src="onboardingSlide.image" alt="" />
            <div>
              <h1 id="onboarding-title">{{ onboardingSlide.title }}</h1>
              <p>{{ onboardingSlide.body }}</p>
              <WorkPreferences v-if="onboardingSlide.preferences" />
            </div>
          </article>
        </transition>
      </div>
      <footer class="onboarding-footer">
        <div class="onboarding-dots" :aria-label="t('onboarding.progress')">
          <button
            v-for="(_slide, index) in onboardingSlides"
            :key="index"
            type="button"
            class="onboarding-dot"
            :class="{ active: onboardingIndex === index }"
            :aria-label="t('onboarding.goToSlide', { count: index + 1 })"
            :aria-current="onboardingIndex === index ? 'step' : undefined"
            @click="selectOnboardingSlide(index)"
          />
        </div>
        <div class="onboarding-actions">
        <button class="onboarding-skip" type="button" @click="completeOnboarding">
          {{ t('onboarding.skip') }}
        </button>
        <button
          class="primary-button onboarding-primary"
          type="button"
          :class="{ loading: !onboardingReady }"
          :disabled="!onboardingReady"
          @click="completeOnboarding"
        >
          <span v-if="!onboardingReady" class="loading-dots" aria-hidden="true"><i /><i /><i /></span>
          <CheckmarkCircleOutline v-else />
          {{ onboardingReady ? t('onboarding.start') : onboardingLoadingLabel }}
        </button>
        </div>
      </footer>
    </section>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { CheckmarkCircleOutline } from '@vicons/ionicons5'
import WorkPreferences from './WorkPreferences.vue'

const props = defineProps({
  controller: { type: Object, required: true },
})

const {
  completeOnboarding,
  onboardingIndex,
  onboardingLoadingLabel,
  onboardingReady,
  onboardingSlide,
  onboardingSlides,
  selectOnboardingSlide,
  t,
} = props.controller

const dialog = ref(null)

defineExpose({
  contains: target => dialog.value?.contains(target) === true,
  focus: () => dialog.value?.focus(),
  querySelectorAll: selector => dialog.value?.querySelectorAll(selector) || [],
})
</script>

<style scoped>
.preferences-slide { grid-template-rows: minmax(0, 1fr); }
.preferences-slide :deep(.work-preferences) { margin-top: 20px; }
.preferences-slide :deep(.work-preferences h2), .preferences-slide :deep(.work-preferences > p) { display: none; }
</style>

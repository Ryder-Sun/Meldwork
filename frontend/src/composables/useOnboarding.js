import { computed, ref } from 'vue'
import { publicAsset } from '../catalog.js'
import { t } from '../i18n.js'
import { readProductPreference, writeProductPreference } from '../product-preferences.js'

const ONBOARDING_PREFERENCE = 'onboarding-seen-v1'
const ONBOARDING_SLIDE_MS = 3200

function onboardingSeen() {
  try { return readProductPreference(ONBOARDING_PREFERENCE) === '1' } catch { return false }
}

export function useOnboarding({ refreshAgents }) {
  const onboardingVisible = ref(false)
  const onboardingCompleted = ref(onboardingSeen())
  const onboardingIndex = ref(0)
  const onboardingDetecting = ref(false)
  const onboardingPlaybackComplete = ref(false)
  let playbackTimer = null

  const onboardingSlides = computed(() => [
    {
      image: publicAsset('onboarding/discover-local-agents-meldwork.png'),
      title: t('onboarding.discoverTitle'),
      body: t('onboarding.discoverBody'),
    },
    {
      image: publicAsset('onboarding/agent-collaboration.png'),
      title: t('onboarding.collaborationTitle'),
      body: t('onboarding.collaborationBody'),
    },
    {
      image: publicAsset('onboarding/skills-and-images.png'),
      title: t('onboarding.toolsTitle'),
      body: t('onboarding.toolsBody'),
    },
    {
      image: publicAsset('onboarding/auto-discussion-v2.png'),
      title: t('onboarding.autoTitle'),
      body: t('onboarding.autoBody'),
    },
  ])
  const onboardingSlide = computed(() => (
    onboardingSlides.value[onboardingIndex.value] || onboardingSlides.value[0]
  ))
  const onboardingLastIndex = computed(() => Math.max(0, onboardingSlides.value.length - 1))
  const onboardingOnLastSlide = computed(() => onboardingIndex.value === onboardingLastIndex.value)
  const onboardingReady = computed(() => !onboardingDetecting.value)
  const onboardingLoadingLabel = computed(() => (
    onboardingDetecting.value ? t('onboarding.detecting') : t('onboarding.loading')
  ))

  function hasPersistedWorkspaceActivity(value) {
    return Boolean(value?.groups?.length || value?.messages?.length)
  }

  function completeOnboardingState() {
    try { writeProductPreference(ONBOARDING_PREFERENCE, '1') } catch { /* noop */ }
    onboardingCompleted.value = true
    clearOnboardingPlayback()
    onboardingVisible.value = false
  }

  function clearOnboardingPlayback() {
    if (playbackTimer) clearTimeout(playbackTimer)
    playbackTimer = null
  }

  function startOnboardingPlayback() {
    clearOnboardingPlayback()
    onboardingPlaybackComplete.value = false
    if (onboardingSlides.value.length <= 1) {
      onboardingPlaybackComplete.value = true
      return
    }
    const step = () => {
      if (!onboardingVisible.value) return
      if (!onboardingOnLastSlide.value) {
        onboardingIndex.value = Math.min(onboardingIndex.value + 1, onboardingLastIndex.value)
        playbackTimer = setTimeout(step, ONBOARDING_SLIDE_MS)
        return
      }
      onboardingPlaybackComplete.value = true
      clearOnboardingPlayback()
    }
    playbackTimer = setTimeout(step, ONBOARDING_SLIDE_MS)
  }

  function ensureOnboardingPlayback() {
    if (!playbackTimer && !onboardingPlaybackComplete.value) startOnboardingPlayback()
  }

  function selectOnboardingSlide(index) {
    onboardingIndex.value = Math.max(0, Math.min(Number(index) || 0, onboardingLastIndex.value))
    clearOnboardingPlayback()
    if (onboardingOnLastSlide.value) {
      onboardingPlaybackComplete.value = true
      return
    }
    startOnboardingPlayback()
  }

  function beginOnboardingDetection() {
    onboardingDetecting.value = true
    void refreshAgents().finally(() => { onboardingDetecting.value = false })
  }

  function openOnboarding() {
    onboardingIndex.value = 0
    onboardingPlaybackComplete.value = false
    onboardingVisible.value = true
    startOnboardingPlayback()
    beginOnboardingDetection()
  }

  return {
    clearOnboardingPlayback,
    completeOnboardingState,
    ensureOnboardingPlayback,
    hasPersistedWorkspaceActivity,
    onboardingCompleted,
    onboardingDetecting,
    onboardingIndex,
    onboardingLoadingLabel,
    onboardingReady,
    onboardingSlide,
    onboardingSlides,
    onboardingVisible,
    openOnboarding,
    selectOnboardingSlide,
  }
}

import { onBeforeUnmount, ref } from 'vue'
import { errorCode } from '../desktop.js'
import { t, translateError } from '../i18n.js'

// Long messages stay up long enough to read: 4 s plus about 60 ms per
// character, at most 10 s. Hovering the toast pauses the countdown.
const TOAST_MIN_MS = 4000
const TOAST_MAX_MS = 10000
const TOAST_MS_PER_CHARACTER = 60

function toastDuration(message) {
  const length = String(message || '').length
  return Math.min(TOAST_MAX_MS, TOAST_MIN_MS + length * TOAST_MS_PER_CHARACTER)
}

export function useAppNotifications() {
  const toastMessage = ref('')
  const toastTone = ref('warning')
  const copyToastMessage = ref('')
  let toastTimer = null
  let copyToastTimer = null

  function scheduleToastDismiss() {
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { toastMessage.value = '' }, toastDuration(toastMessage.value))
  }

  function notify(message, { tone = 'warning' } = {}) {
    toastMessage.value = message
    toastTone.value = tone === 'error' ? 'error' : 'warning'
    scheduleToastDismiss()
  }

  function pauseToast() {
    clearTimeout(toastTimer)
    toastTimer = null
  }

  function resumeToast() {
    if (toastMessage.value) scheduleToastDismiss()
  }

  function showCopyToast() {
    copyToastMessage.value = t('conversation.copySuccess')
    clearTimeout(copyToastTimer)
    copyToastTimer = setTimeout(() => { copyToastMessage.value = '' }, 1500)
  }

  function dismissToast() {
    clearTimeout(toastTimer)
    toastMessage.value = ''
  }

  function showError(error) {
    console.error('[Meldwork]', errorCode(error))
    notify(translateError(error), { tone: 'error' })
  }

  onBeforeUnmount(() => {
    clearTimeout(toastTimer)
    clearTimeout(copyToastTimer)
  })

  return {
    copyToastMessage,
    dismissToast,
    notify,
    pauseToast,
    resumeToast,
    showCopyToast,
    showError,
    toastMessage,
    toastTone,
  }
}

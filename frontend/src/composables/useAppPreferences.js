import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { publicAsset } from '../catalog.js'
import { locale, setLocale } from '../i18n.js'
import { readProductPreference, writeProductPreference } from '../product-preferences.js'

const THEME_PREFERENCES = new Set(['system', 'light', 'dark'])
// Matches --bg in base-foundation.css for each theme.
const THEME_COLORS = { light: '#f3f6f8', dark: '#111618' }

function initialThemePreference() {
  try {
    const saved = readProductPreference('theme')
    if (THEME_PREFERENCES.has(saved)) return saved
  } catch { /* noop */ }
  return 'system'
}

function systemTheme() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function useAppPreferences() {
  // 'system' follows the OS appearance; 'light' and 'dark' are explicit.
  // Only an explicit choice by the user is written back, so a first launch
  // keeps following the system instead of freezing whatever it was then.
  const themePreference = ref(initialThemePreference())
  const theme = ref(themePreference.value === 'system' ? systemTheme() : themePreference.value)
  let colorSchemeQuery = null
  const productMark = computed(() => publicAsset(
    theme.value === 'dark' ? 'logos/meldwork-mark-v3-dark.svg' : 'logos/meldwork-mark-v3.svg',
  ))
  const productWordmark = computed(() => publicAsset(
    theme.value === 'dark' ? 'logos/meldwork-wordmark-v3-dark.svg' : 'logos/meldwork-wordmark-v3.svg',
  ))
  const productAppIcon = computed(() => publicAsset('logos/meldwork-app.png'))

  function applyTheme(value) {
    document.documentElement.dataset.theme = value
    document.documentElement.style.colorScheme = value
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[value] || THEME_COLORS.light)
  }

  function syncSystemTheme() {
    if (themePreference.value === 'system') theme.value = systemTheme()
  }

  function followSystemTheme(enabled) {
    if (enabled && !colorSchemeQuery && typeof matchMedia === 'function') {
      colorSchemeQuery = matchMedia('(prefers-color-scheme: dark)')
      colorSchemeQuery.addEventListener?.('change', syncSystemTheme)
    } else if (!enabled && colorSchemeQuery) {
      colorSchemeQuery.removeEventListener?.('change', syncSystemTheme)
      colorSchemeQuery = null
    }
  }

  function setThemePreference(value) {
    const next = THEME_PREFERENCES.has(value) ? value : 'system'
    themePreference.value = next
    try { writeProductPreference('theme', next) } catch { /* noop */ }
    theme.value = next === 'system' ? systemTheme() : next
  }

  function toggleTheme() {
    setThemePreference(theme.value === 'dark' ? 'light' : 'dark')
  }

  function toggleLocale() {
    setLocale(locale.value === 'zh' ? 'en' : 'zh')
  }

  watch(theme, applyTheme)
  watch(themePreference, value => followSystemTheme(value === 'system'), { immediate: true })
  onBeforeUnmount(() => followSystemTheme(false))

  return {
    applyTheme,
    productAppIcon,
    productMark,
    productWordmark,
    setThemePreference,
    theme,
    themePreference,
    toggleLocale,
    toggleTheme,
  }
}

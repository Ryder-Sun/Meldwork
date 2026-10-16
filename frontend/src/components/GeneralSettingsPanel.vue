<template>
  <section class="settings-panel general-settings-panel">
    <div class="general-settings-row">
      <div class="general-settings-copy">
        <h2 id="general-settings-language">{{ t('generalSettings.languageTitle') }}</h2>
        <p>{{ t('generalSettings.languageHint') }}</p>
      </div>
      <div class="choice-segmented" role="radiogroup" aria-labelledby="general-settings-language">
        <button
          v-for="option in languageOptions"
          :key="option.value"
          type="button"
          role="radio"
          :aria-checked="String(locale === option.value)"
          :class="{ active: locale === option.value }"
          :lang="option.lang"
          @click="setLocale(option.value)"
        >
          {{ option.label }}
        </button>
      </div>
    </div>

    <div class="general-settings-row">
      <div class="general-settings-copy">
        <h2 id="general-settings-theme">{{ t('generalSettings.themeTitle') }}</h2>
        <p>{{ t('generalSettings.themeHint') }}</p>
      </div>
      <div class="choice-segmented" role="radiogroup" aria-labelledby="general-settings-theme">
        <button
          v-for="option in themeOptions"
          :key="option.value"
          type="button"
          role="radio"
          :aria-checked="String(themePreference === option.value)"
          :class="{ active: themePreference === option.value }"
          @click="setThemePreference(option.value)"
        >
          <component :is="option.icon" aria-hidden="true" />
          {{ t(option.labelKey) }}
        </button>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed, unref } from 'vue'
import { DesktopOutline, MoonOutline, SunnyOutline } from '@vicons/ionicons5'
import { locale as currentLocale, setLocale, t } from '../i18n.js'

const props = defineProps({
  setThemePreference: { type: Function, required: true },
  themePreference: { type: [String, Object], required: true },
})

// Language names are shown in their own language, whatever the UI locale is.
const languageOptions = [
  { value: 'zh', label: '中文', lang: 'zh-CN' },
  { value: 'en', label: 'English', lang: 'en' },
]
const themeOptions = [
  { value: 'system', labelKey: 'generalSettings.themeSystem', icon: DesktopOutline },
  { value: 'light', labelKey: 'generalSettings.themeLight', icon: SunnyOutline },
  { value: 'dark', labelKey: 'generalSettings.themeDark', icon: MoonOutline },
]

const locale = currentLocale
const themePreference = computed(() => unref(props.themePreference))

function setThemePreference(value) {
  props.setThemePreference(value)
}
</script>

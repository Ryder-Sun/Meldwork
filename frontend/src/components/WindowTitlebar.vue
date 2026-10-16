<template>
      <div class="titlebar-actions" :aria-label="t('nav.settings')" :inert="blocked ? '' : undefined">
        <button class="icon-button sidebar-settings-entry" :aria-current="activeView === 'settings' ? 'page' : undefined" type="button" :title="t('nav.settings')" :aria-label="t('nav.settings')" @click="openSystemSettings('agents')">
          <SettingsOutline />
        </button>
        <div class="titlebar-preferences">
        <button class="icon-button" type="button" :title="t('common.languageTarget')" :aria-label="t('common.language')" @click="toggleLocale">
          <span class="preference-icon-frame"><LanguageOutline /></span>
        </button>
        <button class="icon-button" type="button" :title="theme === 'dark' ? t('common.themeLight') : t('common.themeDark')" :aria-label="theme === 'dark' ? t('common.themeLight') : t('common.themeDark')" @click="toggleTheme">
          <span class="preference-icon-frame">
            <Transition name="preference-icon">
              <span :key="theme" class="preference-icon"><SunnyOutline v-if="theme === 'dark'" /><MoonOutline v-else /></span>
            </Transition>
          </span>
        </button>
        </div>
      <div
        ref="shortcutMenu"
        class="shortcut-menu-anchor"
        @mouseenter="openShortcutMenu"
        @mouseleave="scheduleShortcutMenuClose"
        @focusin="openShortcutMenu"
        @focusout="closeShortcutMenuAfterFocus"
      >
        <button
          class="icon-button"
          type="button"
          :title="t('shortcut.title')"
          :aria-label="t('shortcut.title')"
          :aria-expanded="String(shortcutMenuOpen)"
          aria-controls="keyboard-shortcut-menu"
        >
          <span class="keyboard-shortcut-icon" aria-hidden="true"><span /></span>
        </button>
        <section
          v-if="shortcutMenuOpen"
          id="keyboard-shortcut-menu"
          class="shortcut-menu"
          role="tooltip"
          :aria-label="t('shortcut.title')"
        >
          <header>{{ t('shortcut.title') }}</header>
          <ul>
            <li v-for="shortcut in shortcutDefinitions" :key="shortcut.labelKey">
              <span>{{ t(shortcut.labelKey) }}</span>
              <kbd>{{ shortcut.keys }}</kbd>
            </li>
          </ul>
        </section>
      </div>
      </div>
</template>
<script setup>
import { ref, onBeforeUnmount } from 'vue'
import { SettingsOutline, LanguageOutline, SunnyOutline, MoonOutline } from '@vicons/ionicons5'
defineProps(['t', 'theme', 'activeView', 'blocked', 'openSystemSettings', 'toggleLocale', 'toggleTheme', 'shortcutDefinitions'])
const shortcutMenuOpen = defineModel('shortcutMenuOpen', { type: Boolean, default: false })
const shortcutMenu = ref(null)
let shortcutMenuCloseTimer = null

function openShortcutMenu() {
  clearTimeout(shortcutMenuCloseTimer)
  shortcutMenuCloseTimer = null
  shortcutMenuOpen.value = true
}

function scheduleShortcutMenuClose() {
  clearTimeout(shortcutMenuCloseTimer)
  shortcutMenuCloseTimer = setTimeout(() => {
    shortcutMenuOpen.value = false
    shortcutMenuCloseTimer = null
  }, 90)
}

function containsShortcutTarget(target) {
  return shortcutMenu.value?.contains(target) === true
}

function closeShortcutMenuAfterFocus(event) {
  if (shortcutMenu.value?.contains(event.relatedTarget)) return
  scheduleShortcutMenuClose()
}

onBeforeUnmount(() => clearTimeout(shortcutMenuCloseTimer))

defineExpose({ containsShortcutTarget })
</script>

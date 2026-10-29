import { defineStore } from 'pinia'
import { ref, computed, onMounted, onUnmounted } from 'vue'

export const useUiStore = defineStore('ui', () => {
  const theme = ref<'auto' | 'light' | 'dark'>((localStorage.getItem('mr_theme') as any) || 'auto')
  const systemDark = ref(window.matchMedia('(prefers-color-scheme: dark)').matches)
  const hideAmounts = ref(localStorage.getItem('mr_hide_amounts') === '1')

  const isDark = computed(() => (theme.value === 'auto' ? systemDark.value : theme.value === 'dark'))
  const vantTheme = computed(() => (isDark.value ? 'dark' : 'light'))
  const isDesktop = ref(window.innerWidth >= 1024)

  function toggleHideAmounts() {
    hideAmounts.value = !hideAmounts.value
    localStorage.setItem('mr_hide_amounts', hideAmounts.value ? '1' : '0')
  }

  function apply() {
    document.documentElement.classList.toggle('dark', isDark.value)
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', isDark.value ? '#121318' : '#3B82F6')
  }
  function setTheme(t: 'auto' | 'light' | 'dark') {
    theme.value = t
    localStorage.setItem('mr_theme', t)
    apply()
  }

  function listen() {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      systemDark.value = e.matches
      apply()
    })
    window.addEventListener('resize', () => {
      isDesktop.value = window.innerWidth >= 1024
    })
    apply()
  }

  return { theme, isDark, vantTheme, isDesktop, hideAmounts, toggleHideAmounts, setTheme, listen }
})

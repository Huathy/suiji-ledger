import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '../api/client'
import { flipTimeSortDir, parseTimeSortDir, TIME_SORT_DIR_KEY, type TimeSortDir } from '../../../../packages/shared/src/index'

export const useUiStore = defineStore('ui', () => {
  const theme = ref<'auto' | 'light' | 'dark'>((localStorage.getItem('mr_theme') as any) || 'auto')
  const systemDark = ref(window.matchMedia('(prefers-color-scheme: dark)').matches)
  const hideAmounts = ref(localStorage.getItem('mr_hide_amounts') === '1')
  /**
   * 全站时间排序方向：desc = 倒序（新的在前，默认，与历史行为一致）；asc = 顺序（旧的在前）。
   * 本机 localStorage 立即生效，同时写回 settings（服务端/离线本地库同一份），换设备跟随账号。
   */
  const timeSort = ref<TimeSortDir>(parseTimeSortDir(localStorage.getItem('mr_time_sort')))

  const isDark = computed(() => (theme.value === 'auto' ? systemDark.value : theme.value === 'dark'))
  const vantTheme = computed(() => (isDark.value ? 'dark' : 'light'))
  const isDesktop = ref(window.innerWidth >= 1024)

  function toggleHideAmounts() {
    hideAmounts.value = !hideAmounts.value
    localStorage.setItem('mr_hide_amounts', hideAmounts.value ? '1' : '0')
  }

  /** 切换时间排序方向（倒序 ⇄ 顺序）；列表页与设置页共用这一个入口 */
  function setTimeSort(dir: TimeSortDir) {
    timeSort.value = dir
    localStorage.setItem('mr_time_sort', dir)
    api('/system/settings', { method: 'PUT', body: { settings: { [TIME_SORT_DIR_KEY]: dir } } }).catch(() => { /* 未登录/离线写失败不影响本机 */ })
  }
  function toggleTimeSort() {
    setTimeSort(flipTimeSortDir(timeSort.value))
  }
  /**
   * 启动/进页时对齐服务端：服务端存过就以服务端为准，
   * 没存过（首次使用）就把本机当前值推上去，避免把用户刚调好的方向冲掉。
   */
  async function pullTimeSort() {
    try {
      const r = await api<{ settings: Record<string, string> }>('/system/settings')
      const raw = r.settings[TIME_SORT_DIR_KEY]
      if (raw === 'asc' || raw === 'desc') {
        if (raw !== timeSort.value) {
          timeSort.value = raw
          localStorage.setItem('mr_time_sort', raw)
        }
      } else {
        setTimeSort(timeSort.value)
      }
    } catch { /* 拿不到就沿用本机值 */ }
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

  return {
    theme, isDark, vantTheme, isDesktop, hideAmounts, toggleHideAmounts, setTheme, listen,
    timeSort, setTimeSort, toggleTimeSort, pullTimeSort,
  }
})

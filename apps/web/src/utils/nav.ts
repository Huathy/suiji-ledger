/** 导航辅助：避免无历史时 router.back() 退到空白页 */
import { useRouter } from 'vue-router'

/**
 * 二级页「返回」：
 * - 有站内历史（history.state.back 由 vue-router 写入）→ 正常后退
 * - 直接深链进入（无历史）→ 回总览，绝不产生空白页
 */
export function useGoBack() {
  const router = useRouter()
  return function goBack(fallback = '/') {
    const state = window.history.state || {}
    if (typeof state.back === 'string' && state.back !== '' && state.back !== null) {
      router.back()
      return
    }
    router.replace(fallback)
  }
}

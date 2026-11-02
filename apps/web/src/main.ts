import { createApp } from 'vue'
import { createPinia } from 'pinia'
import Vant from 'vant'
import App from './App.vue'
import { router } from './router'
import { installPcPickerSupport } from './utils/pc-picker'
import './styles.css'
import 'vant/lib/index.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.use(Vant)
app.mount('#app')

// Vant Picker/DatePicker 只绑定了 touch 事件：桌面端补上滚轮 + 鼠标拖动（问题 1）
installPcPickerSupport()

// 注意括号：SW 只在 https 或 localhost 下注册，且必须先确认 API 存在。
// 开发模式（vite dev）不注册，并主动注销历史遗留的 SW：
// sw.js 对非 HTML 的 GET 是「缓存优先」，开发下会把旧模块/旧设置读回，改完刷新看不到效果。
if ('serviceWorker' in navigator) {
  if (import.meta.env.DEV) {
    navigator.serviceWorker.getRegistrations()
      .then((rs) => rs.forEach((r) => r.unregister()))
      .catch(() => {})
  } else if (location.protocol === 'https:' || location.hostname === 'localhost') {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  }
}

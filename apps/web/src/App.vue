<script setup lang="ts">
import { onMounted, computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ConfigProvider, Tabbar, TabbarItem } from 'vant'
import { useUiStore } from './stores/ui'
import { useAuthStore } from './stores/auth'
import SideNav from './components/SideNav.vue'

const ui = useUiStore()
const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

// 初始导航完成前 currentRoute 仍是 START_LOCATION('/')，
// 直接渲染会让需要鉴权的页面在登录前就发请求（401 竞态）
const routerReady = ref(false)
router.isReady().then(() => { routerReady.value = true })

onMounted(() => {
  ui.listen()
  auth.bootstrap()
})

// 未登录（且非离线模式）时不渲染数据页与侧栏
const showNav = computed(() => route.path !== '/login' && auth.ready && auth.authed())
// 平账是五 Tab 之一：进入后 TabBar 必须保持可见（否则其余四 Tab 不可达）
const isTab = computed(() => !!(route.meta as any).tab)
const tab = computed(() => {
  const p = route.path
  if (p === '/') return 'home'
  if (p === '/trends') return 'trends'
  if (p === '/reconcile' || p.startsWith('/reconcile')) return 'reconcile'
  if (p === '/accounts' || p.startsWith('/accounts/')) return 'accounts'
  if (p === '/me') return 'me'
  return 'home'
})
function onTabChange(name: string | number) {
  const map: Record<string, string> = { home: '/', trends: '/trends', reconcile: '/reconcile', accounts: '/accounts', me: '/me' }
  const to = map[String(name)]
  if (to && route.path !== to) window.location.hash = '#' + to
}
</script>

<template>
  <ConfigProvider :theme="ui.vantTheme">
    <div class="app-shell" :class="{ desktop: ui.isDesktop }">
      <SideNav v-if="ui.isDesktop && showNav" />
      <main class="app-main">
        <router-view v-if="auth.ready && routerReady" :key="route.fullPath" />
      </main>
      <van-tabbar v-if="!ui.isDesktop && isTab && routerReady" :model-value="tab" @update:model-value="onTabChange" fixed placeholder safe-area-inset-bottom>
        <TabbarItem name="home" icon="wap-home-o">总览</TabbarItem>
        <TabbarItem name="trends" icon="chart-trending-o">走势</TabbarItem>
        <!-- 中央凸起 FAB：全系统唯一录入入口，层级高于普通 Tab -->
        <div class="fab-cell" role="button" tabindex="0" aria-label="平账"
          @click="onTabChange('reconcile')" @keyup.enter="onTabChange('reconcile')">
          <span class="fab" :class="{ on: tab === 'reconcile' }">＋</span>
          <span class="fab-label">平账</span>
        </div>
        <TabbarItem name="accounts" icon="balance-o">账户</TabbarItem>
        <TabbarItem name="me" icon="user-o">我的</TabbarItem>
      </van-tabbar>
    </div>
  </ConfigProvider>
</template>

<style>
/* 底部中央平账按钮：独立 flex 单元格，位置稳定 */
.fab-cell {
  flex: 1; display: flex; flex-direction: column; align-items: center;
  justify-content: flex-end; gap: 3px; cursor: pointer; padding-bottom: 4px;
  /* 整块可点区 ≥44px（含内边距），满足触控目标 */
  min-height: 50px;
}
.fab {
  width: 46px; height: 46px; border-radius: 50%;
  background: var(--brand); color: #fff; font-size: 26px;
  line-height: 46px; text-align: center; margin-top: -26px;
  box-shadow: 0 6px 14px rgba(59, 130, 246, 0.4);
  border: 3px solid var(--surface);
  transition: transform 0.12s ease;
}
.fab:active { transform: scale(0.94); }
.fab.on { background: var(--brand); box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.22), 0 6px 14px rgba(59, 130, 246, 0.4); }
.fab-label { font-size: 10px; color: var(--brand); font-weight: 600; }
</style>

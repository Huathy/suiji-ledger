<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import SyncBadge from './SyncBadge.vue'

const router = useRouter()
function goReconcile() {
  router.push('/reconcile')
}
// PC 快捷键：N 平账 · 1/2/3/4 切页 · / 聚焦搜索（输入框内不触发）
function onKey(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey) return
  const map: Record<string, string> = { n: '/reconcile', 1: '/', 2: '/trends', 3: '/accounts', 4: '/types', '/': '/search' }
  const to = map[e.key.toLowerCase()]
  if (to) {
    e.preventDefault()
    router.push(to)
  }
}
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <aside class="side-nav">
    <div class="logo">⚖️ SuijiLedger</div>
    <router-link to="/">🏠 总览</router-link>
    <router-link to="/trends">📈 走势</router-link>
    <router-link to="/accounts">🏦 账户</router-link>
    <router-link to="/types">🏷 类型管理</router-link>
    <router-link to="/sync">🔄 数据同步</router-link>
    <router-link to="/me">⚙️ 设置</router-link>
    <div class="sync-slot"><SyncBadge compact /></div>
    <div style="flex: 1"></div>
    <button class="side-rec-btn" @click="goReconcile">＋ 平账 <span class="kbd">N</span></button>
    <div class="side-foot">
      每月 1 分钟 · 看清资产负债<br>
      快捷键 N 平账 · 1/2/3/4 切页 · / 搜索 · Ctrl+S 保存
    </div>
  </aside>
</template>

<style>
.side-rec-btn {
  width: 100%; border: none; border-radius: 11px; padding: 12px 0;
  background: var(--brand); color: #fff; font-size: 14px; font-weight: 600;
  cursor: pointer; box-shadow: 0 6px 14px rgba(59, 130, 246, 0.35);
  display: flex; align-items: center; justify-content: center; gap: 6px;
}
.side-rec-btn .kbd {
  font-size: 10px; opacity: 0.85; border: 1px solid rgba(255, 255, 255, 0.5);
  border-radius: 4px; padding: 0 4px; font-weight: 400;
}
.sync-slot { padding: 6px 0 2px; }
.side-foot {
  font-size: 10px; color: var(--t3); padding: 8px 8px 0; margin-top: 8px;
  border-top: 1px solid var(--line); line-height: 1.7;
}
</style>

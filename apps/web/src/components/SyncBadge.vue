<script setup lang="ts">
/**
 * 同步状态徽标（设计稿 v2.1 §6 SyncBadge）：
 * 绿=已同步 · 黄=待推送/待启用 · 灰=未配置 · 红=失败
 * M4 推送引擎未交付，故只会出现 灰/黄 两态，且 tooltip 明确说明，不做假状态。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api/client'

const props = withDefaults(defineProps<{ compact?: boolean }>(), { compact: false })
const router = useRouter()
const remote = ref('')
const pushMode = ref('daily')
const loaded = ref(false)

onMounted(async () => {
  try {
    const s = await api<{ settings: Record<string, string> }>('/system/settings')
    remote.value = s.settings.gitRemote || ''
    pushMode.value = s.settings.gitPushMode || 'daily'
  } catch {
    remote.value = ''
  } finally {
    loaded.value = true
  }
})

const state = computed(() => (!loaded.value ? 'loading' : remote.value ? 'pending' : 'unconfigured'))
const label = computed(
  () =>
    ({
      loading: '检测中',
      unconfigured: '未配置同步',
      pending: '已配置 · 待 M4 推送',
      ok: '已同步',
      fail: '同步失败',
    }[state.value]),
)
const dotClass = computed(() => (state.value === 'unconfigured' ? 'dot-gray' : state.value === 'pending' ? 'dot-amber' : 'dot-gray'))
const tip = computed(() =>
  state.value === 'unconfigured'
    ? '尚未配置远程仓库。当前请在「我的 → 导出全量备份 JSON」手动备份。'
    : '已填写远程仓库，自动 commit / push 引擎将在 M4 里程碑交付。',
)
</script>

<template>
  <button type="button" class="sync-badge" :class="{ compact }" :title="tip" :aria-label="label + '（点击查看数据同步）'" @click="router.push('/sync')">
    <i class="dot" :class="dotClass"></i>
    <span class="txt">{{ label }}</span>
  </button>
</template>

<style>
.sync-badge {
  display: inline-flex; align-items: center; gap: 6px; margin-left: auto;
  border: 1px solid var(--line); background: var(--surface); color: var(--t2);
  font-size: 11.5px; padding: 5px 10px; border-radius: 13px; cursor: pointer; font-family: inherit;
  min-height: 28px;
}
.sync-badge:hover { border-color: var(--brand); color: var(--brand); }
.sync-badge .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.dot-gray { background: #94a3b8; }
.dot-amber { background: var(--warn); }
.dot-green { background: var(--income); }
.dot-red { background: var(--expense); }
.sync-badge.compact { font-size: 11px; padding: 4px 8px; }
</style>

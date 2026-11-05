<script setup lang="ts">
/**
 * 同步状态徽标（设计稿 v2.1 §6 SyncBadge）
 * 绿=已同步 · 黄=待推送/离线/同步中 · 红=冲突/失败 · 灰=未配置
 *
 * 状态 → 文案/圆点/提示的映射只住在 `utils/syncState.ts`（`BADGE_COPY` / `badgeTip`）：
 * 以前这里三段 if 级联 + SyncView 两份内联表各算一遍，加一个状态必然漏
 * （v1.2 就漏过 `ok`/`fail` 的 dot 映射，红/绿两态永远显示不出来）。
 * 状态形状也不再手抄：`SyncStatus` 只有一个家在 `packages/shared`——
 * 本文件当年抄的版本少了 5 个字段，正是漂移的证据。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api/client'
import { type SyncStatus } from '../../../../packages/shared/src/index'
import { BADGE_COPY, badgeTip, resolveBadgeState } from '../utils/syncState'

const props = withDefaults(defineProps<{ compact?: boolean }>(), { compact: false })
const router = useRouter()
const st = ref<SyncStatus | null>(null)
const failed = ref(false)

onMounted(async () => {
  try {
    st.value = await api<SyncStatus>('/system/sync/status')
  } catch {
    failed.value = true // 离线/未登录：降级为未配置，不白屏
  }
})

const state = computed(() => resolveBadgeState(st.value, { failed: failed.value }))

const label = computed(() => BADGE_COPY[state.value].label)
const dotClass = computed(() => BADGE_COPY[state.value].dot)
const tip = computed(() => badgeTip(state.value, st.value))
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

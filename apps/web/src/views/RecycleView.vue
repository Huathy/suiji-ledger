<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NavBar, Button, Empty, showConfirmDialog, showSuccessToast, Dialog } from 'vant'
import { api } from '../api/client'
import { useGoBack } from '../utils/nav'

interface TrashRow { id: number; kind: 'entry' | 'loan' | 'account'; summary: string; deletedAt: number; payload: any }

const goBack = useGoBack()
const items = ref<TrashRow[]>([])
const loaded = ref(false)

const kindName: Record<string, string> = { entry: '变动条目', loan: '借还记录', account: '账户' }
const kindEmoji: Record<string, string> = { entry: '📝', loan: '🤝', account: '🏦' }

async function load() {
  const r = await api<{ items: TrashRow[] }>('/recycle')
  items.value = r.items
  loaded.value = true
}
onMounted(load)

function fmtTime(ts: number) {
  const d = new Date(ts * (ts < 1e12 ? 1000 : 1))
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function restore(it: TrashRow) {
  await api(`/recycle/${it.id}/restore`, { method: 'POST' })
  showSuccessToast('已恢复')
  await load()
}
async function removeForever(it: TrashRow) {
  await showConfirmDialog({ title: '永久删除？', message: '恢复后将无法再找回这条数据。' })
  await api(`/recycle/${it.id}`, { method: 'DELETE' })
  showSuccessToast('已永久删除')
  await load()
}
async function clearAll() {
  await showConfirmDialog({ title: '清空回收站？', message: '所有回收站条目将被永久删除。' })
  await api('/recycle', { method: 'DELETE' })
  showSuccessToast('已清空')
  await load()
}
function payloadLine(it: TrashRow): string {
  const p = it.payload
  if (it.kind === 'entry') return `${p.ym} · ${p.amount >= 0 ? '+' : ''}${(p.amount / 100).toFixed(2)} 元${p.note ? ' · ' + p.note : ''}`
  if (it.kind === 'loan') return `${p.date} · ${(p.amount / 100).toFixed(2)} 元${p.note ? ' · ' + p.note : ''}`
  return p.group ? `分组：${p.group}` : ''
}
</script>

<template>
  <div>
    <NavBar title="回收站" left-arrow left-text="返回" @click-left="goBack('/')">
      <template #right>
        <button v-if="items.length" class="link-btn danger" @click="clearAll">清空</button>
      </template>
    </NavBar>
    <div style="font-size: 11px; color: var(--t3); margin: 8px 18px 0; line-height: 1.7">
      删除的大项、借还记录、账户都会先进入这里，可恢复或永久删除。账户因有历史快照而走「归档」的，不经过回收站。
    </div>
    <div class="card" style="padding: 4px 14px" v-if="items.length">
      <div v-for="it in items" :key="it.id" class="row-line">
        <span class="cicon">{{ kindEmoji[it.kind] || '🗑' }}</span>
        <div style="flex: 1; min-width: 0">
          <div style="font-size: 13px; color: var(--t1)">
            <span class="kind-tag">{{ kindName[it.kind] || it.kind }}</span> {{ it.summary }}
          </div>
          <div style="font-size: 10.5px; color: var(--t3)" class="num">{{ fmtTime(it.deletedAt) }}{{ payloadLine(it) ? ' · ' + payloadLine(it) : '' }}</div>
        </div>
        <button class="link-btn" @click="restore(it)">恢复</button>
        <button class="link-btn danger" @click="removeForever(it)">永久删</button>
      </div>
    </div>
    <Empty v-else-if="loaded" description="回收站是空的" />
    <div v-if="items.length" style="font-size: 10.5px; color: var(--t3); text-align: center; margin-top: 10px">
      共 {{ items.length }} 条 · 恢复大条目会自动重算当月恒等式
    </div>
  </div>
</template>

<style>
.kind-tag { font-size: 9px; color: var(--brand); background: var(--focus-bg); border-radius: 4px; padding: 1px 5px; margin-right: 4px; }
.link-btn {
  border: none; background: transparent; cursor: pointer; font: inherit;
  font-size: 12px; color: var(--brand); padding: 6px 8px; min-width: 44px; min-height: 36px;
  border-radius: 8px; flex-shrink: 0;
}
.link-btn:hover { background: var(--cell); }
.link-btn.danger { color: var(--expense); }
</style>

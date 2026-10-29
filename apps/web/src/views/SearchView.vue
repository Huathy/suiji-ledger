<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NavBar, Field, CellGroup, Button, Empty } from 'vant'
import { api } from '../api/client'
import { money } from '../utils/money'
import { useGoBack } from '../utils/nav'

interface SearchRow { id: number; ym: string; name: string; emoji: string; amount: number; note: string | null; accountName: string | null }
interface MatchAccount { id: number; name: string; emoji: string }

const router = useRouter()
const goBack = useGoBack()
const q = ref('')
const minYuan = ref('')
const maxYuan = ref('')
const results = ref<SearchRow[]>([])
const matchedAccounts = ref<MatchAccount[]>([])
const searched = ref(false)
const loading = ref(false)
const fieldRef = ref<any>(null)

// 快捷键 / 跳转进来后自动聚焦搜索框（设计稿 v2.1 §2）
onMounted(() => {
  nextTick(() => fieldRef.value?.$el?.querySelector?.('input')?.focus?.())
})

async function doSearch() {
  if (!q.value.trim() && !minYuan.value && !maxYuan.value) {
    results.value = []
    matchedAccounts.value = []
    searched.value = false
    return
  }
  loading.value = true
  try {
    const params = new URLSearchParams()
    if (q.value.trim()) params.set('q', q.value.trim())
    if (minYuan.value) params.set('minYuan', minYuan.value)
    if (maxYuan.value) params.set('maxYuan', maxYuan.value)
    const r = await api<{ results: SearchRow[]; matchedAccounts: MatchAccount[] }>('/search?' + params.toString())
    results.value = r.results
    matchedAccounts.value = r.matchedAccounts
    searched.value = true
  } finally {
    loading.value = false
  }
}

const grouped = computed(() => {
  const map = new Map<string, SearchRow[]>()
  for (const r of results.value) {
    if (!map.has(r.ym)) map.set(r.ym, [])
    map.get(r.ym)!.push(r)
  }
  return [...map.entries()]
})
</script>

<template>
  <div>
    <NavBar title="搜索" left-arrow left-text="返回" @click-left="goBack('/')" />
    <CellGroup inset style="margin-top: 10px">
      <Field ref="fieldRef" v-model="q" label="关键词" placeholder="备注 / 类型 / 账户名" clearable @keyup.enter="doSearch" />
      <div style="display: flex; gap: 8px; padding: 0 4px 6px">
        <Field v-model="minYuan" label="金额≥" type="number" placeholder="元" style="padding: 4px 8px" />
        <Field v-model="maxYuan" label="金额≤" type="number" placeholder="元" style="padding: 4px 8px" />
      </div>
    </CellGroup>
    <div style="margin: 12px 16px">
      <Button type="primary" round block :loading="loading" @click="doSearch">搜索</Button>
    </div>

    <div v-if="matchedAccounts.length" class="card" style="padding: 8px 14px">
      <div style="font-size: 11px; color: var(--t3); padding: 2px 0">匹配的账户（点击查看）</div>
      <button v-for="a in matchedAccounts" :key="a.id" type="button" class="acc-chip" @click="router.push('/accounts/' + a.id)">{{ a.emoji }} {{ a.name }}</button>
    </div>

    <template v-if="searched">
      <div v-if="results.length === 0"><Empty description="没有匹配的记录" /></div>
      <div v-for="[ym, rows] in grouped" :key="ym">
        <div class="grp-head" @click="router.push('/month/' + ym)">{{ ym }} <i style="font-style: normal; font-size: 10px; color: var(--t3)">查看当月 ›</i></div>
        <div class="card" style="padding: 4px 14px">
          <div v-for="r in rows" :key="r.id" class="row-line">
            <span class="cicon">{{ r.emoji }}</span>
            <div style="flex: 1; min-width: 0">
              <div style="font-size: 13px; color: var(--t1)">{{ r.name }}{{ r.note ? ' · ' + r.note : '' }}</div>
              <div style="font-size: 10.5px; color: var(--t3)">{{ r.accountName || '—' }}</div>
            </div>
            <span class="num" style="font-weight: 600" :class="r.amount >= 0 ? 'm-inc' : 'm-exp'">{{ money(r.amount, { signed: true }) }}</span>
          </div>
        </div>
      </div>
    </template>
    <div v-else class="empty-tip">输入关键词或金额范围搜索大项记录<br>支持按备注、类型名、账户名匹配</div>
  </div>
</template>

<style>
.grp-head { font-size: 13px; font-weight: 600; color: var(--t1); padding: 14px 18px 6px; cursor: pointer; }
.acc-chip {
  display: inline-block; font-size: 12px; padding: 8px 12px; border-radius: 14px;
  background: var(--cell); color: var(--t2); margin: 2px 4px; cursor: pointer;
  border: none; font-family: inherit; min-height: 32px;
}
.acc-chip:hover { color: var(--brand); }
</style>

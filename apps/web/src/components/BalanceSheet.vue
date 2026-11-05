<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api/client'
import { money } from '../utils/money'
import { sortByTime, type TimeSortDir } from '../../../../packages/shared/src/index'
import { useUiStore } from '../stores/ui'

interface MatrixData {
  accounts: { id: number; name: string; emoji: string; kind: string }[]
  rows: {
    ym: string; recordDate: string; cells: (number | null)[]
    assetsTotal: number; networth: number; delta: number | null
    dailyAvg: number | null; estimated: boolean | null
  }[]
}

const router = useRouter()
const ui = useUiStore()
const data = ref<MatrixData | null>(null)
/** 列排序：key = 'ym' | 'acc:<id>' | 'assetsTotal' | 'networth' | 'delta' | 'dailyAvg' */
const sortKey = ref('ym')
const sortDir = ref<'asc' | 'desc'>(ui.timeSort)

// 横向溢出提示（窄 PC 窗口下用户不知道右侧还有列）
const scrollEl = ref<HTMLElement | null>(null)
const canScrollX = ref(false)
const scrolledRight = ref(false)
const hiddenCols = ref(0)
function measureScroll() {
  const el = scrollEl.value
  if (!el) return
  canScrollX.value = el.scrollWidth - el.clientWidth > 4
  scrolledRight.value = el.scrollLeft + el.clientWidth >= el.scrollWidth - 4
  // 按平均列宽估算右侧未显示的列数
  const cols = Math.max(1, (data.value?.accounts.length || 0) + 5)
  const avg = el.scrollWidth / cols
  hiddenCols.value = Math.max(1, Math.floor((el.scrollWidth - el.clientWidth) / Math.max(1, avg)))
}
onMounted(async () => {
  data.value = await api<MatrixData>('/system/matrix?limit=36')
  // 等 v-if 的表格真正渲染出来再测量，否则 scrollWidth/clientWidth 都是 0
  await nextTick()
  measureScroll()
  window.addEventListener('resize', measureScroll)
})
onUnmounted(() => window.removeEventListener('resize', measureScroll))

const columns = computed(() => {
  const accs = (data.value?.accounts || []).map((a) => ({ key: 'acc:' + a.id, label: `${a.emoji}${a.name}${a.kind === 'liability' ? '(欠)' : ''}`, kind: a.kind, id: a.id }))
  return [
    { key: 'ym', label: '月份', kind: 'asset', id: 0 },
    ...accs,
    { key: 'assetsTotal', label: '总资产', kind: 'asset', id: -1 },
    { key: 'networth', label: '净资产', kind: 'asset', id: -2 },
    { key: 'delta', label: '结余', kind: 'asset', id: -3 },
    { key: 'dailyAvg', label: '日均开销(估)', kind: 'asset', id: -4 },
  ]
})

/** 取某行某列的可比较数值（null 排最后） */
function cellValue(row: MatrixData['rows'][number], key: string): number | null {
  if (key === 'assetsTotal') return row.assetsTotal
  if (key === 'networth') return row.networth
  if (key === 'delta') return row.delta
  if (key === 'dailyAvg') return row.dailyAvg
  if (key.startsWith('acc:')) {
    const idx = (data.value?.accounts || []).findIndex((a) => a.id === Number(key.slice(4)))
    return idx >= 0 ? row.cells[idx] : null
  }
  return null
}

const rows = computed(() => {
  const list = data.value?.rows || []
  // 月份列走时间排序：字典序即时间序，倒序=新的在前、顺序=旧的在前
  if (sortKey.value === 'ym') return sortByTime(list, (r) => r.ym, sortDir.value)
  const out = list.slice()
  out.sort((a, b) => {
    const va = cellValue(a, sortKey.value)
    const vb = cellValue(b, sortKey.value)
    if (va === null && vb === null) return 0 // 同空值：交给稳定排序保持原时间序
    if (va === null) return 1
    if (vb === null) return -1
    return sortDir.value === 'asc' ? va - vb : vb - va
  })
  return out
})

function sortBy(key: string) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
    // 点的是时间列 → 把方向同步成全站偏好
    if (key === 'ym') ui.setTimeSort(sortDir.value as TimeSortDir)
  } else {
    sortKey.value = key
    // 时间列跟随全局方向（默认倒序=新的在前）；金额列默认从大到小
    sortDir.value = key === 'ym' ? ui.timeSort : 'desc'
  }
}
/** 全局时间方向变化（设置页/其它页切换）→ 本表月份列跟着翻 */
watch(() => ui.timeSort, (d) => { if (sortKey.value === 'ym') sortDir.value = d })
function indicator(key: string) {
  if (sortKey.value !== key) return '↕'
  return sortDir.value === 'asc' ? '↑' : '↓'
}
function openMonth(ym: string) {
  router.push('/month/' + ym)
}
</script>

<template>
  <div class="card" v-if="data && data.rows.length">
    <div class="sec-t">
      📊 资产负债总表
      <span class="hint">月份 × 账户 · 单位：元 · 点列头排序（时间列可切倒序/顺序）· 点击行看月度详情</span>
      <button type="button" class="dir-pill" :title="ui.timeSort === 'asc' ? '当前：时间顺序（旧→新），点击改为倒序' : '当前：时间倒序（新→旧），点击改为顺序'"
        @click="ui.toggleTimeSort()">
        时间 {{ ui.timeSort === 'asc' ? '↑ 顺序' : '↓ 倒序' }}
      </button>
    </div>
    <div class="matrix-wrap">
      <div ref="scrollEl" class="matrix-scroll" style="max-height: 480px" @scroll.passive="measureScroll">
        <table class="matrix">
          <thead>
            <tr>
              <th v-for="c in columns" :key="c.key" scope="col" class="sortable" @click="sortBy(c.key)">
                {{ c.label }}<span class="sort-ind">{{ indicator(c.key) }}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.ym" style="cursor: pointer" @click="openMonth(r.ym)">
              <td><b>{{ r.ym }}</b> <span style="color:var(--t3);font-size:10px">{{ r.recordDate }}</span></td>
              <td v-for="(v, i) in r.cells" :key="i" :class="{ neg: v !== null && data!.accounts[i].kind === 'liability' }" class="num">
                {{ v === null ? '—' : money(v) }}
              </td>
              <td class="num">{{ money(r.assetsTotal) }}</td>
              <td class="num" style="font-weight: 700">{{ money(r.networth) }}</td>
              <td class="num" :class="r.delta === null ? 'm-mut' : r.delta >= 0 ? 'm-inc' : 'm-exp'">
                {{ r.delta === null ? '—' : money(r.delta, { signed: true }) }}
              </td>
              <td class="num m-exp">
                {{ r.dailyAvg === null ? '—' : '¥' + money(r.dailyAvg) + (r.estimated ? ' *' : '') }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <div v-if="canScrollX && !scrolledRight" class="scroll-hint">
      右侧还有 <b>{{ hiddenCols }}</b> 列 · 横向滚动查看 →
    </div>
    <div style="font-size: 10px; color: var(--t3); margin-top: 8px">
      * 未记收入大项的区间，支出按「资产净减少」估算
    </div>
  </div>
</template>

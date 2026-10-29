<script setup lang="ts">
import { onMounted, ref, watch, nextTick, onUnmounted } from 'vue'
import { NavBar, Popup, Picker, Button } from 'vant'
import * as echarts from 'echarts/core'
import { LineChart, BarChart, PieChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { api } from '../api/client'
import { useUiStore } from '../stores/ui'
import { money } from '../utils/money'
import SyncBadge from '../components/SyncBadge.vue'

echarts.use([LineChart, BarChart, PieChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer])

const ui = useUiStore()
const range = ref<'12' | '24' | '36'>('12')

interface Point { ym: string; recordDate: string; networth: number; delta: number | null }
interface DailyAvgRow { ym: string; days: number | null; spendEst: number | null; dailyAvg: number | null; dailyNet: number | null; estimated: boolean | null }
interface Interval {
  fromYm: string; toYm: string; fromDate: string; toDate: string; days: number
  delta: number; incomeTotal: number; spendEst: number; dailyAvg: number; dailyNet: number; estimated: boolean
}

const points = ref<Point[]>([])
const avgRows = ref<DailyAvgRow[]>([])
const interval = ref<Interval | null>(null)
const fromYm = ref('')
const toYm = ref('')

// 区间选择
const pickShow = ref<'from' | 'to' | null>(null)

const allocData = ref<{ name: string; value: number }[]>([])
const netEl = ref<HTMLElement>()
const avgEl = ref<HTMLElement>()
const allocEl = ref<HTMLElement>()
let netChart: echarts.ECharts | null = null
let avgChart: echarts.ECharts | null = null
let allocChart: echarts.ECharts | null = null
const contrib = ref<{ name: string; emoji: string; direction: string; total: number }[]>([])

async function loadAll() {
  const [nw, avg, contribR] = await Promise.all([
    api<{ points: Point[] }>('/stats/networth?limit=' + range.value),
    api<{ months: DailyAvgRow[] }>('/stats/daily-avg?limit=12'),
    api<{ items: { name: string; emoji: string; direction: string; total: number }[] }>('/stats/type-contribution?limit=12').catch(() => ({ items: [] })),
  ])
  points.value = nw.points
  avgRows.value = avg.months
  contrib.value = contribR.items
  try {
    const accs = await api<any[]>('/accounts')
    allocData.value = accs
      .filter((a: any) => !a.archived && a.inNetWorth)
      .map((a: any) => ({ name: a.name, value: (a.kind === 'liability' ? -a.balance : a.balance) / 100 }))
      .filter((x: any) => x.value > 0)
      .sort((a: any, b: any) => b.value - a.value)
  } catch { allocData.value = [] }
  if (!fromYm.value && nw.points.length > 1) {
    fromYm.value = nw.points[Math.max(0, nw.points.length - 2)].ym
    toYm.value = nw.points[nw.points.length - 1].ym
    await loadInterval()
  }
  await nextTick()
  renderCharts()
}

async function loadInterval() {
  if (!fromYm.value || !toYm.value || fromYm.value === toYm.value) return
  try {
    interval.value = await api<Interval>(`/stats/interval?from=${fromYm.value}&to=${toYm.value}`)
  } catch { interval.value = null }
}

function renderCharts() {
  const dark = ui.isDark
  const axisColor = dark ? '#9aa0a6' : '#8f959e'
  const splitColor = dark ? '#2c2f3a' : '#eef0f4'
  if (netEl.value) {
    netChart = netChart || echarts.init(netEl.value)
    const few = points.value.length <= 4
    netChart.setOption({
      grid: { left: 60, right: 16, top: 20, bottom: 28 },
      tooltip: { trigger: 'axis', formatter: (p: any) => `${p[0].name}<br/>净资产 ¥${money(Math.round(p[0].value * 100))}` },
      xAxis: {
        type: 'category', data: points.value.map((p) => p.ym.slice(2)),
        // 点极少时不留两侧空白（走查 S3：两点折线挤在中间）
        boundaryGap: few ? 0.2 : false,
        axisLabel: { color: axisColor, fontSize: 10 }, axisLine: { lineStyle: { color: splitColor } },
      },
      yAxis: { type: 'value', scale: true, axisLabel: { color: axisColor, fontSize: 10, formatter: (v: number) => Math.round(v).toLocaleString('zh-CN') }, splitLine: { lineStyle: { color: splitColor } } },
      series: [{
        type: 'line', data: points.value.map((p) => p.networth / 100),
        smooth: true, symbol: 'circle', symbolSize: 6,
        label: few ? { show: true, color: axisColor, fontSize: 10, formatter: (p: any) => money(Math.round(p.value * 100)) } : { show: false },
        lineStyle: { color: '#3b82f6', width: 2.5 },
        itemStyle: { color: '#3b82f6' },
        areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(59,130,246,.25)' }, { offset: 1, color: 'rgba(59,130,246,0)' }] } as any },
      }],
    })
  }
  if (allocEl.value && allocData.value.length) {
    allocChart = allocChart || echarts.init(allocEl.value)
    const palette = ['#3b82f6', '#7b61ff', '#00b578', '#ff8800', '#22d3ee', '#f472b6', '#94a3b8', '#4ade80', '#38bdf8', '#fbbf24']
    allocChart.setOption({
      // PC 加宽后饼图靠左 + 右侧图例，避免标签互相重叠（走查 S3）
      legend: { type: 'scroll', orient: 'vertical', right: 8, top: 'middle', textStyle: { color: axisColor, fontSize: 11 }, formatter: (name: string) => name },
      tooltip: { trigger: 'item', formatter: (p: any) => `${p.name}<br/>¥${money(Math.round(p.value * 100))}（${p.percent}%）` },
      series: [{
        type: 'pie', radius: ['50%', '76%'], center: ['26%', '50%'],
        label: { show: false }, labelLine: { show: false },
        data: allocData.value.map((x, i) => ({ name: x.name, value: x.value, itemStyle: { color: palette[i % palette.length] } })),
      }],
    })
  }
  if (avgEl.value && avgRows.value.some((r) => r.dailyAvg !== null)) {
    avgChart = avgChart || echarts.init(avgEl.value)
    const rows = avgRows.value.filter((r) => r.dailyAvg !== null)
    avgChart.setOption({
      grid: { left: 50, right: 16, top: 20, bottom: 28 },
      tooltip: { trigger: 'axis', formatter: (p: any) => `${p[0].name}<br/>日均开销 ¥${money(p[0].value * 100)}${rows[p[0].dataIndex]?.estimated ? '（估）' : ''}` },
      xAxis: { type: 'category', data: rows.map((r) => r.ym.slice(2)), axisLabel: { color: axisColor, fontSize: 10 }, axisLine: { lineStyle: { color: splitColor } } },
      yAxis: { type: 'value', axisLabel: { color: axisColor, fontSize: 10 }, splitLine: { lineStyle: { color: splitColor } } },
      series: [{
        type: 'bar', data: rows.map((r) => ({ value: r.dailyAvg! / 100, itemStyle: { color: r.estimated ? 'rgba(240,72,72,.4)' : '#f04848', borderRadius: [4, 4, 0, 0] } })),
        barMaxWidth: 18,
      }],
    })
  }
}

/** 窗口尺寸变化时重绘（走查 S2-9：图表不随窗口 resize 被裁切） */
let resizeTimer: number | undefined
function onResize() {
  window.clearTimeout(resizeTimer)
  resizeTimer = window.setTimeout(() => {
    netChart?.resize()
    avgChart?.resize()
    allocChart?.resize()
  }, 150)
}
onMounted(() => window.addEventListener('resize', onResize))
onUnmounted(() => {
  window.removeEventListener('resize', onResize)
  window.clearTimeout(resizeTimer)
})

function monthLabel(ym: string) {
  const p = points.value.find((x) => x.ym === ym)
  return `${ym}${p ? `（${p.recordDate}）` : ''}`
}

onMounted(loadAll)
watch(range, loadAll)
watch(() => ui.isDark, () => {
  netChart?.dispose(); netChart = null
  avgChart?.dispose(); avgChart = null
  allocChart?.dispose(); allocChart = null
  nextTick(renderCharts)
})
</script>

<template>
  <div>
    <NavBar title="走势" />
    <div class="range-row">
      <button v-for="r in ['12', '24', '36']" :key="r" type="button" class="range-pill" :class="{ on: range === r }" @click="range = r as any">{{ r }}月</button>
      <SyncBadge v-if="ui.isDesktop" compact />
    </div>

    <div class="card">
      <div class="sec-t">📈 净资产 <span class="hint">当前 ¥{{ points.length ? money(points[points.length - 1].networth) : '0' }}</span></div>
      <div ref="netEl" style="height: 220px"></div>
    </div>

    <!-- 区间分析器 -->
    <div class="card">
      <div class="sec-t">🎯 区间分析 <span class="hint">任选两个记录点</span></div>
      <div style="display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600">
        <button type="button" class="pick-btn" @click="pickShow = 'from'">{{ fromYm || '起始月 ▾' }}</button>
        <span style="color: var(--t3)">──→</span>
        <button type="button" class="pick-btn" @click="pickShow = 'to'">{{ toYm || '结束月 ▾' }}</button>
        <Button size="small" round type="primary" plain class="calc-btn" @click="loadInterval">计算</Button>
      </div>
      <template v-if="interval">
        <div style="font-size: 11px; color: var(--t3); margin: 6px 0 10px" class="num">
          {{ interval.fromDate }} → {{ interval.toDate }} · 区间 {{ interval.days }} 天
        </div>
        <div class="ia-kv"><span>净资产变化</span><b class="num" :class="interval.delta >= 0 ? 'm-inc' : 'm-exp'">{{ money(interval.delta, { signed: true }) }}</b></div>
        <div class="ia-kv"><span>大项收入</span><b class="num m-inc">{{ money(interval.incomeTotal, { signed: true }) }}</b></div>
        <div class="ia-kv"><span>支出估算（= 收入 − 净增）</span><b class="num m-exp">−{{ money(interval.spendEst) }}</b></div>
        <div class="ia-big num">
          <span>平均每日开销</span>
          <span class="ia-val">¥{{ money(interval.dailyAvg) }}<i class="ia-tag">估算</i></span>
        </div>
        <div class="ia-kv" style="font-size: 11px"><span>日均净结余</span><b class="num" :class="interval.dailyNet >= 0 ? 'm-inc' : 'm-exp'">{{ money(interval.dailyNet, { signed: true }) }}</b></div>
        <div v-if="interval.estimated" class="est-hint">
          💡 本区间未记收入大项，支出按「资产净减少」估算。想更准？平账时记一笔工资大项即可。
        </div>
      </template>
      <div v-else class="empty-tip" style="padding: 12px 0 4px">选择两个有记录的月份后点「计算」</div>
    </div>

    <!-- 日均开销柱状 -->
    <div class="card">
      <div class="sec-t">日均开销（按月区间）<span class="hint">浅色 = 未记收入，估算值</span></div>
      <div ref="avgEl" style="height: 180px" v-show="avgRows.some((r) => r.dailyAvg !== null)"></div>
      <div v-if="!avgRows.some((r) => r.dailyAvg !== null)" class="empty-tip" style="padding: 20px 10px">
        记录第二个月后，这里会出现每日平均开销的柱状图
      </div>

      <div class="sec-t" style="padding-top: 10px">🥧 资产配置（当前）</div>
      <div ref="allocEl" style="height: 220px" v-show="allocData.length"></div>
      <div v-if="!allocData.length" class="empty-tip" style="padding: 14px 10px">添加账户并平账后，这里显示资产配置</div>

      <div class="sec-t" style="padding-top: 10px">📊 类型累计贡献<span class="hint">近 12 个月大项合计</span></div>
      <div v-if="contrib.length">
        <div v-for="c in contrib" :key="c.name" class="ct-row">
          <span style="width: 20px; text-align: center">{{ c.emoji }}</span>
          <span style="flex: 1; color: var(--t2)">{{ c.name }}</span>
          <span class="num" :class="c.total >= 0 ? 'm-inc' : 'm-exp'" style="font-weight: 600">{{ money(c.total, { signed: true }) }}</span>
        </div>
      </div>
      <div v-else class="empty-tip" style="padding: 10px">暂无大项记录</div>
    </div>

    <!-- 区间月份选择 -->
    <Popup :show="pickShow !== null" position="bottom" round @update:show="(v: boolean) => (pickShow = null)">
      <Picker :columns="points.map((p) => ({ text: monthLabel(p.ym), value: p.ym }))" title="选择记录月份"
        @confirm="(e: any) => { if (pickShow === 'from') fromYm = e.selectedValues[0]; else toYm = e.selectedValues[0]; pickShow = null }"
        @cancel="pickShow = null" />
    </Popup>
  </div>
</template>

<style>
.range-row { display: flex; align-items: center; gap: 8px; padding: 4px 16px 0; }
.range-pill { font-size: 11px; padding: 6px 14px; border-radius: 14px; background: var(--surface); color: var(--t2); cursor: pointer; border: none; font-family: inherit; min-height: 30px; }
.range-pill.on { background: var(--brand); color: #fff; font-weight: 600; }
html.dark .range-pill.on { color: #0b1220; }
.pick-btn { border: none; background: transparent; cursor: pointer; font: inherit; font-size: 13px; font-weight: 600; color: var(--brand); padding: 6px 4px; min-height: 32px; }
.calc-btn { margin-left: auto; min-height: 32px; }
.ct-row { display: flex; align-items: center; gap: 8px; font-size: 12.5px; padding: 5px 0; }
.ia-kv { display: flex; justify-content: space-between; gap: 10px; font-size: 12.5px; color: var(--t2); padding: 4px 0; }
.ia-kv b { font-weight: 600; text-align: right; }
/* 主指标卡：全部走主题变量，深色下对比度达标（走查 S3） */
.ia-big {
  display: flex; align-items: center; gap: 10px; margin: 8px 0; padding: 10px 13px;
  background: var(--expense-bg); border-radius: 12px; color: var(--expense-fg); font-size: 12px;
}
.ia-big .ia-val { margin-left: auto; font-size: 22px; font-weight: 700; color: var(--expense); white-space: nowrap; }
.ia-big .ia-tag { font-style: normal; font-size: 10px; color: var(--t3); margin-left: 4px; font-weight: 400; }
.est-hint {
  font-size: 11px; color: var(--hint-fg); background: var(--hint-bg);
  border-radius: 8px; padding: 7px 10px; margin-top: 8px;
}
</style>

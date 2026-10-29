<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Button } from 'vant'
import { api } from '../api/client'
import { todayYMD } from '../../../../packages/shared/src/index'
import SparkLine from '../components/SparkLine.vue'
import BalanceSheet from '../components/BalanceSheet.vue'
import SyncBadge from '../components/SyncBadge.vue'
import { useUiStore } from '../stores/ui'
import { money, deltaClass } from '../utils/money'

interface MonthPoint { ym: string; recordDate: string; networth: number; delta: number | null }
interface MonthDetail {
  ym: string; recordDate: string | null; reconciled: boolean
  accounts: { id: number; name: string; emoji: string; kind: string; group: string | null; balance: number | null; prevBalance: number; delta: number | null }[]
  networth: number; prevNetworth: number | null; delta: number | null
  assetsTotal: number; liabilityTotal: number
  entries: { id: number; name: string; emoji: string; direction: string; amount: number; note: string | null; accountName: string | null; auto: boolean }[]
  bigTotal: number; incomeTotal: number; autoEntry: { amount: number } | null
  interval: { fromDate: string; toDate: string; days: number; delta: number; incomeTotal: number; spendEst: number; dailyAvg: number; dailyNet: number; estimated: boolean } | null
}

const router = useRouter()
const ui = useUiStore()
const months = ref<MonthPoint[]>([])
const detail = ref<MonthDetail | null>(null)
const settings = ref<Record<string, string>>({})
const loading = ref(true)

onMounted(async () => {
  const [m, s] = await Promise.all([
    api<{ months: MonthPoint[] }>('/months?limit=12'),
    api<{ settings: Record<string, string> }>('/system/settings'),
  ])
  months.value = m.months
  settings.value = s.settings
  if (m.months.length) {
    detail.value = await api<MonthDetail>('/month/' + m.months[0].ym)
  }
  loading.value = false
  // 平账提醒：到提醒日且本月未平账 → 系统通知（可在我的页开关）
  if (s.settings.reminderEnabled !== 'off' && 'Notification' in window && Notification.permission === 'granted') {
    const curYm = todayYMD().slice(0, 7)
    const done = m.months.some((x) => x.ym === curYm)
    const day = new Date().getDate()
    const rd = Number(s.settings.reminderDay || 28)
    if (!done && day >= rd) {
      try {
        new Notification('SuijiLedger · 该平账了', {
          body: `${curYm} 还没平账（提醒日每月 ${rd} 号），花 1 分钟对个账吧`,
          icon: '/icon.svg',
        })
      } catch { /* 部分环境不支持 */ }
    }
  }
})

const currentYm = todayYMD().slice(0, 7)
const thisMonthDone = computed(() => months.value.some((m) => m.ym === currentYm))
const lastRecordDate = computed(() => months.value[0]?.recordDate ?? null)
const needReconcile = computed(() => {
  if (!thisMonthDone.value) {
    const day = new Date().getDate()
    const reminderDay = Number(settings.value.reminderDay || 28)
    if (day >= reminderDay) return true
    if (lastRecordDate.value) {
      const days = (Date.now() - new Date(lastRecordDate.value).getTime()) / 86400000
      if (days > 31) return true
    }
  }
  return false
})
const spark = computed(() => months.value.slice(0, 8).reverse().map((m) => m.networth))
const topEntries = computed(() => (detail.value?.entries || []).slice(0, 4))
const recentMonths = computed(() => months.value.slice(1, 4))

function gotoReconcile() { router.push('/reconcile') }
</script>

<template>
  <div>
    <!-- 空态引导 -->
    <div v-if="!loading && months.length === 0" class="card" style="text-align: center; padding: 30px 20px">
      <div style="font-size: 44px">⚖️</div>
      <div style="font-size: 17px; font-weight: 700; margin: 10px 0 6px">记下第一个月的余额</div>
      <div style="font-size: 12.5px; color: var(--t3); line-height: 1.8">
        第 1 步：到「账户」添加你的银行卡 / 微信 / 支付宝等<br>
        第 2 步：每月点「＋ 平账」，把各账户实际余额抄进来<br>
        之后净资产、结余、日均开销全部自动算
      </div>
      <Button type="primary" round style="margin-top: 16px; min-width: 160px" @click="router.push('/accounts')">去添加账户</Button>
      <Button round style="margin-top: 10px; min-width: 160px; display: block; margin-left: auto; margin-right: auto" @click="gotoReconcile">直接开始平账</Button>
    </div>

    <template v-else>
      <!-- PC 顶栏：面包屑 + 同步状态（设计稿 v2.1 §2） -->
      <div v-if="ui.isDesktop" class="pc-topbar">
        <div class="crumb"><span>总览</span><i>/</i><b>{{ currentYm }}</b></div>
        <SyncBadge />
      </div>

      <!-- 顶部栏：账期 + 快捷入口 -->
      <div class="h-top">
        <span class="h-period">⚖️ 总览 <i>· {{ currentYm }}</i></span>
        <span class="h-acts">
          <router-link to="/accounts" class="h-act" aria-label="账户" title="账户">🏦</router-link>
          <router-link to="/me" class="h-act" aria-label="设置" title="设置">⚙️</router-link>
        </span>
      </div>
      <!-- 净资产大卡：点击进入走势页（设计稿 06 §4.1） -->
      <div class="netcard" v-if="detail" role="link" tabindex="0" aria-label="查看净资产走势"
        @click="router.push('/trends')" @keyup.enter="router.push('/trends')">
        <div style="font-size: 11px; opacity: 0.85">净资产 · {{ detail.ym }}</div>
        <div class="net-big num">¥{{ money(detail.networth) }}</div>
        <div style="display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 12px">
          <span class="num chip">
            {{ detail.delta === null ? '本月首记' : '本月 ' + money(detail.delta, { signed: true }) }}
          </span>
          <span v-if="detail.interval" class="num">日均开销 ¥{{ money(detail.interval.dailyAvg) }} · {{ detail.interval.days }} 天</span>
        </div>
        <SparkLine v-if="spark.length > 1" :points="spark" :height="36" class="net-spark" />
      </div>

      <!-- 平账提醒 -->
      <div v-if="needReconcile" class="remind" role="status">
        ⚠️ 该平账了 · 上次记录 {{ lastRecordDate || '尚无' }}
        <button class="go" @click="gotoReconcile">去平账</button>
      </div>

      <!-- 本月卡片 -->
      <div class="card" v-if="detail">
        <div class="sec-t">
          {{ detail.ym }}
          <span v-if="detail.reconciled" class="done-tag">已平账 ✓</span>
          <router-link :to="'/month/' + detail.ym" class="detail-link">详情 ›</router-link>
        </div>
        <div v-for="a in detail.accounts.filter((x) => x.balance !== null)" :key="a.id" class="row-line"
          role="link" tabindex="0" :aria-label="a.name + ' 详情'" @click="router.push('/accounts/' + a.id)"
          @keyup.enter="router.push('/accounts/' + a.id)">
          <span class="cicon">{{ a.emoji }}</span>
          <span style="flex: 1; color: var(--t2); font-size: 13px">{{ a.name }}</span>
          <b class="num" style="font-size: 13.5px">¥{{ money(a.balance!) }}</b>
          <span class="num delta-cell" :class="deltaClass(a.kind, a.delta)">
            {{ a.delta === null ? '' : money(a.delta, { signed: true }) }}
          </span>
        </div>
        <div style="border-top: 1px dashed var(--line); margin: 8px 0 4px"></div>
        <div v-for="e in topEntries" :key="e.id" class="row-line" style="padding: 5px 0">
          <span style="width: 22px; text-align: center">{{ e.emoji }}</span>
          <span style="flex: 1; color: var(--t2); font-size: 12.5px">
            {{ e.name }} <span v-if="e.auto" style="font-size: 9px; color: var(--neutral)">自动</span>
          </span>
          <span class="num" style="font-size: 12.5px" :class="e.amount >= 0 ? 'm-inc' : 'm-exp'">{{ money(e.amount, { signed: true }) }}</span>
        </div>
        <div v-if="detail.interval" class="interval-line">
          <router-link :to="'/trends'">区间 {{ detail.interval.fromDate }} → {{ detail.interval.toDate }}（{{ detail.interval.days }} 天）· 日均开销 ¥{{ money(detail.interval.dailyAvg) }}<span v-if="detail.interval.estimated"> (估)</span></router-link>
        </div>
      </div>

      <!-- 近几月 -->
      <div v-if="recentMonths.length" class="recent-row">
        <router-link v-for="m in recentMonths" :key="m.ym" :to="'/month/' + m.ym" class="recent-card">
          {{ m.ym.slice(5) }}月<b class="num" style="display: block; font-size: 12px; color: var(--t1); margin-top: 2px">¥{{ money(m.networth) }}</b>
        </router-link>
      </div>

      <!-- PC 资产负债总表 -->
      <BalanceSheet v-if="ui.isDesktop" style="margin-top: 14px" />
    </template>
  </div>
</template>

<style>
.netcard {
  margin: 12px 14px; border-radius: 14px; padding: 16px;
  background: linear-gradient(135deg, var(--brand), var(--brand-deep)); color: #fff;
  cursor: pointer;
}
.netcard .chip { background: rgba(255, 255, 255, 0.18); border-radius: 8px; padding: 2px 8px; }
.net-spark { display: block; margin-top: 10px; max-width: 100%; }
.h-act {
  color: var(--t2); text-decoration: none; font-size: 17px;
  width: 40px; height: 40px; display: inline-flex; align-items: center; justify-content: center;
  margin: -8px -8px -8px 0; border-radius: 10px;
}
.h-act:hover { background: var(--cell); color: var(--brand); }
.delta-cell { width: 62px; text-align: right; font-size: 11px; }
.done-tag { font-size: 10px; color: var(--income); background: rgba(0, 181, 120, 0.12); border-radius: 6px; padding: 1px 6px; }
.detail-link { margin-left: auto; font-size: 12px; color: var(--t3); text-decoration: none; padding: 6px 4px; }
.detail-link:hover { color: var(--brand); }
.interval-line { font-size: 11px; color: var(--t3); margin-top: 6px; }
.interval-line a {
  color: inherit; text-decoration: none; display: inline-block;
  padding: 8px 0; min-height: 32px; line-height: 1.5;
}
.interval-line a:hover { color: var(--brand); }
/* 近几月：PC 下不再被拉伸成整行（走查 S3 一致性） */
.recent-row { display: flex; gap: 8px; margin: 0 14px; }
.recent-card {
  flex: 1; max-width: 220px; background: var(--surface); border-radius: 11px;
  padding: 10px 12px; font-size: 10.5px; color: var(--t3); text-decoration: none;
}
.recent-card:hover { outline: 1.5px solid var(--brand); }
.app-shell.desktop .recent-row { margin: 0; }
.app-shell.desktop .recent-card { max-width: 260px; }
/* 提醒条按钮：键盘可达 */
.remind .go {
  margin-left: auto; background: var(--warn); color: #fff; font-size: 12px;
  border: none; border-radius: 12px; padding: 6px 14px; cursor: pointer; font-family: inherit; min-height: 30px;
}
/* PC 顶栏 */
.pc-topbar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.crumb { font-size: 13px; color: var(--t3); display: flex; align-items: center; gap: 6px; }
.crumb i { font-style: normal; }
.crumb b { color: var(--t1); font-weight: 600; }
</style>

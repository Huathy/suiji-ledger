<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NavBar, Popup, Field, CellGroup, Button, Picker, showConfirmDialog, showSuccessToast, showFailToast } from 'vant'
import { saveTextFile } from '../api/client'
import { api } from '../api/client'
import { toCents, fromCents, type Direction } from '../../../../packages/shared/src/index'
import { money, deltaClass } from '../utils/money'
import { useUiStore } from '../stores/ui'
import { useGoBack } from '../utils/nav'

interface Detail {
  ym: string; recordDate: string | null; reconciled: boolean
  accounts: { id: number; name: string; emoji: string; kind: string; group: string | null; balance: number | null; prevBalance: number; delta: number | null }[]
  networth: number; delta: number | null; assetsTotal: number; liabilityTotal: number
  entries: { id: number; name: string; emoji: string; direction: string; amount: number; note: string | null; accountName: string | null; auto: boolean }[]
  bigTotal: number; incomeTotal: number; autoEntry: { id: number; amount: number; note?: string | null } | null
  interval: { fromDate: string; toDate: string; days: number; delta: number; incomeTotal: number; spendEst: number; dailyAvg: number; dailyNet: number; estimated: boolean } | null
}
interface TypeInfo { id: number; name: string; emoji: string; direction: Direction; builtin: boolean }

const route = useRoute()
const router = useRouter()
const ui = useUiStore()
const goBack = useGoBack()
const ym = route.params.ym as string
const detail = ref<Detail | null>(null)
const types = ref<TypeInfo[]>([])
const loading = ref(true)

/**
 * 该月是否真的平过账。
 * 接口对未平账月份也返回结构完整的 0 值对象，只判 null 会让空月显示成
 * 「净资产 ¥0.00 · ✓ 平」，被误读为已记账（走查 S1-4）。
 */
const hasSnapshot = computed(() => {
  const d = detail.value
  if (!d) return false
  return !!d.reconciled || d.accounts.some((a) => a.balance !== null)
})

// 条目编辑
const editShow = ref(false)
const editId = ref<number | null>(null)
const editTypeIdx = ref(0)
const editAmount = ref('')
const editNote = ref('')
const customTypes = computed(() => types.value.filter((t) => !t.builtin))

async function load() {
  detail.value = await api<Detail>('/month/' + ym)
}
onMounted(async () => {
  types.value = await api<TypeInfo[]>('/types')
  await load()
  loading.value = false
})

const autoRows = computed(() => {
  const d = detail.value
  if (!d) return []
  return d.accounts.filter((a) => a.balance !== null && a.delta !== null && a.delta !== 0)
})

function openEdit(e: Detail['entries'][number] & { typeId?: number }) {
  if (e.auto) return
  editId.value = e.id
  editTypeIdx.value = Math.max(0, customTypes.value.findIndex((t) => t.id === e.typeId))
  editAmount.value = fromCents(Math.abs(e.amount))
  editNote.value = e.note || ''
  editShow.value = true
}
async function saveEdit() {
  const t = customTypes.value[editTypeIdx.value]
  let cents = toCents(editAmount.value || '0')
  if (cents === null) return
  if (t?.direction === 'expense' && cents > 0) cents = -cents
  if (t?.direction === 'income' && cents < 0) cents = -cents
  await api(`/month/${ym}/entry/${editId.value}`, { method: 'PATCH', body: { typeId: t?.id, amount: cents, note: editNote.value } })
  editShow.value = false
  showSuccessToast('已保存，平账已自动重算')
  await load()
}
// ---- 新增大项（详情页内） ----
const addShow = ref(false)
const addTypeIdx = ref(0)
const addAmount = ref('')
const addNote = ref('')
async function saveAdd() {
  const t = customTypes.value[addTypeIdx.value]
  let cents = toCents(addAmount.value || '0')
  if (cents === null || cents === 0) return
  if (t?.direction === 'expense' && cents > 0) cents = -cents
  if (t?.direction === 'income' && cents < 0) cents = -cents
  await api(`/month/${ym}/entry`, { method: 'POST', body: { typeId: t?.id, amount: cents, note: addNote.value || undefined } })
  addShow.value = false
  showSuccessToast('已添加，平账已自动重算')
  await load()
}

// ---- 月报分享图 ----
async function shareImage() {
  const d = detail.value
  if (!d) return
  const hidden = ui.hideAmounts
  const W = 1080
  const H = 1440
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  const ctx = cv.getContext('2d')!
  const m = (cents: number | null, signed = false) => (hidden ? '¥••••••' : '¥' + require_fmt(cents, signed))
  const g = ctx.createLinearGradient(0, 0, W, 420)
  g.addColorStop(0, '#3B82F6')
  g.addColorStop(1, '#2F5FD0')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, 420)
  ctx.fillStyle = '#ffffff'
  ctx.font = '600 40px system-ui'
  ctx.fillText(`Suiji Ledger · ${d.ym} 月报`, 60, 90)
  ctx.font = '28px system-ui'
  ctx.globalAlpha = 0.85
  ctx.fillText('净资产', 60, 170)
  ctx.globalAlpha = 1
  ctx.font = '700 96px system-ui'
  ctx.fillText(m(d.networth), 60, 290)
  ctx.font = '600 36px system-ui'
  ctx.fillStyle = '#7EE2B8'
  ctx.fillText(`本月 ${d.delta === null ? '首记' : m(d.delta, true)}`, 60, 370)
  if (d.interval) {
    ctx.fillStyle = '#ffffff'
    ctx.globalAlpha = 0.9
    ctx.font = '28px system-ui'
    ctx.fillText(`日均开销 ${m(d.interval.dailyAvg)} · ${d.interval.days} 天`, 60, 560)
    ctx.globalAlpha = 1
  }
  ctx.fillStyle = '#1f2329'
  let y = 660
  ctx.font = '600 36px system-ui'
  ctx.fillText('变动构成', 60, y)
  y += 70
  ctx.font = '32px system-ui'
  for (const e of d.entries.slice(0, 8)) {
    ctx.fillStyle = '#646a73'
    ctx.fillText(`${e.emoji} ${e.name}${e.note ? '（' + e.note + '）' : ''}`, 60, y)
    ctx.fillStyle = e.amount >= 0 ? '#00b578' : '#f04848'
    ctx.fillText(m(e.amount, true), W - 360, y)
    y += 76
  }
  ctx.fillStyle = '#8f959e'
  ctx.font = '26px system-ui'
  ctx.fillText(`Σ变动条目 = 余额变动 = ${m(d.delta ?? 0, true)} ✓ 平`, 60, H - 140)
  ctx.fillText('由 Suiji Ledger 生成 · 每月 1 分钟看清资产负债', 60, H - 80)
  const blob: Blob | null = await new Promise((r) => cv.toBlob((b) => r(b), 'image/png'))
  if (!blob) return showFailToast('生成失败')
  const where = await saveTextFile(`Suiji Ledger-${d.ym}-月报.png`, blob)
  showSuccessToast(typeof where === 'string' && (where.startsWith('已保存') || where.startsWith('D:')) ? where : '月报图已生成')
}
/** 月报图内联用（不经隐藏开关，由调用方 m() 处理） */
function require_fmt(cents: number | null, signed = false): string {
  if (cents === null) return '—'
  const neg = cents < 0
  const abs = Math.abs(cents)
  const s = (abs / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  if (signed) return (neg ? '−' : '+') + s
  return neg ? '−' + s : s
}

async function removeEntry(id: number) {
  await showConfirmDialog({ title: '删除这条大项？' })
  await api(`/month/${ym}/entry/${id}`, { method: 'DELETE' })
  showSuccessToast('已删除，平账已自动重算')
  await load()
}
</script>

<template>
  <!-- 未平账月份：明确空态 + 引导，不再显示 ¥0.00 / ✓ 平 -->
  <div v-if="!loading && !hasSnapshot" class="empty-state">
    <NavBar :title="ym + ' 月度详情'" left-arrow left-text="返回" @click-left="goBack('/')" />
    <div class="card" style="text-align: center; padding: 34px 20px">
      <div style="font-size: 42px">📭</div>
      <div style="font-size: 16px; font-weight: 700; margin: 12px 0 6px">{{ ym }} 还没有平账</div>
      <div style="font-size: 12.5px; color: var(--t3); line-height: 1.9">
        这个月还没有任何账户余额记录。<br>
        花 1 分钟把各账户余额抄进来，净资产与日均开销会自动生成。
      </div>
      <Button type="primary" round style="margin-top: 18px; min-width: 160px" @click="router.push('/reconcile?ym=' + ym)">去平账</Button>
    </div>
  </div>

  <div v-else-if="detail">
    <NavBar :title="ym + ' 月度详情'" left-arrow left-text="返回" @click-left="goBack('/')">
      <template #right>
        <span class="nav-act" role="button" tabindex="0" @click="router.push('/reconcile?ym=' + ym)" @keyup.enter="router.push('/reconcile?ym=' + ym)">
          {{ hasSnapshot ? '✎ 重新平账' : '✎ 去平账' }}
        </span>
      </template>
    </NavBar>

    <div class="card" style="display: flex; align-items: baseline; gap: 10px">
      <span style="font-size: 11px; color: var(--t2)">净资产</span>
      <span class="num" style="font-size: 22px; font-weight: 700">¥{{ money(detail.networth) }}</span>
      <span class="num" style="margin-left: auto; font-size: 12px; font-weight: 600" :class="detail.delta === null ? 'm-mut' : detail.delta >= 0 ? 'm-inc' : 'm-exp'">
        环比 {{ detail.delta === null ? '—' : money(detail.delta, { signed: true }) }}
      </span>
    </div>
    <div style="font-size: 11px; color: var(--t3); margin: 0 18px">记录日：{{ detail.recordDate || '—' }}</div>

    <!-- 区间统计 -->
    <div class="card interval-card" v-if="detail.interval">
      <div class="sec-t">📌 区间统计</div>
      <div class="kv"><span>记录区间</span><b class="num">{{ detail.interval.fromDate }} → {{ detail.interval.toDate }}（{{ detail.interval.days }} 天）</b></div>
      <div class="kv"><span>大项收入</span><b class="num m-inc">+{{ money(detail.interval.incomeTotal) }}</b></div>
      <div class="kv"><span>支出估算（= 收入 − 净增）</span><b class="num m-exp">−{{ money(detail.interval.spendEst) }}</b></div>
      <div class="ia-big num"><span>平均每日开销</span><span class="ia-val">¥{{ money(detail.interval.dailyAvg) }}<i class="ia-tag">估算</i></span></div>
      <div class="kv" style="font-size: 11.5px"><span>日均净结余</span><b class="num" :class="detail.interval.dailyNet >= 0 ? 'm-inc' : 'm-exp'">{{ money(detail.interval.dailyNet, { signed: true }) }}</b></div>
    </div>

    <!-- 账户余额表 -->
    <div class="card">
      <div class="sec-t">账户余额 <span class="hint">上月 → 本月</span></div>
      <div class="matrix-scroll">
      <table class="matrix">
        <thead><tr><th scope="col">账户</th><th scope="col">上月</th><th scope="col">本月</th><th scope="col">变动</th></tr></thead>
        <tbody>
          <tr v-for="a in detail.accounts.filter((x) => x.balance !== null)" :key="a.id">
            <td>{{ a.emoji }} {{ a.name }}<span v-if="a.kind === 'liability'" class="kind-tag"> 欠</span></td>
            <td class="num" style="color: var(--t2)">{{ money(a.prevBalance) }}</td>
            <td class="num">{{ money(a.balance!) }}</td>
            <td class="num" :class="deltaClass(a.kind, a.delta)">{{ money(a.delta, { signed: true }) }}</td>
          </tr>
        </tbody>
      </table>
      </div>
    </div>

    <!-- 变动构成 -->
    <div class="card" style="padding: 6px 14px 10px">
      <div class="sec-t" style="padding: 10px 2px 6px">本月变动构成 <span class="hint">Σ条目 = Σ余额变动，永远平</span></div>
      <div v-for="e in detail.entries.filter((x) => !x.auto)" :key="e.id" class="row-line" style="cursor: pointer" @click="openEdit(e as any)">
        <span class="cicon" style="width: 32px; height: 32px; font-size: 15px">{{ e.emoji }}</span>
        <div style="flex: 1; min-width: 0">
          <div style="font-size: 13px; font-weight: 500">{{ e.name }}</div>
          <div style="font-size: 10.5px; color: var(--t3)">{{ e.note || (e.accountName || '大项') }}</div>
        </div>
        <span class="num" style="font-weight: 700; font-size: 13.5px" :class="e.amount >= 0 ? 'm-inc' : 'm-exp'">{{ money(e.amount, { signed: true }) }}</span>
        <button class="link-btn mute" @click.stop="removeEntry(e.id)">删</button>
      </div>
      <div style="display: flex; gap: 10px; padding: 6px 0 10px">
        <Button size="small" plain round type="primary" style="flex: 1" @click="addShow = true">＋ 大项</Button>
        <Button size="small" plain round style="flex: 1" @click="router.push('/reconcile?ym=' + ym)">✎ 平账</Button>
        <Button size="small" plain round style="flex: 1" @click="shareImage">📤 月报图</Button>
      </div>

      <!-- 自动平账条目 -->
      <div class="row-line">
        <span class="cicon" style="width: 32px; height: 32px; font-size: 15px; background: var(--cell)">⚖️</span>
        <div style="flex: 1">
          <div style="font-size: 13px; font-weight: 500">平账 <span class="auto-badge">自动</span></div>
          <div style="font-size: 10.5px; color: var(--t3)">
            <template v-if="detail.autoEntry && detail.autoEntry.note">📝 {{ detail.autoEntry.note }}<br></template>
            <template v-if="detail.autoEntry && detail.autoEntry.amount !== 0">
              <span v-for="a in autoRows" :key="a.id" class="num">{{ a.name }} {{ money(a.delta, { signed: true }) }}　</span>
            </template>
            <template v-else>所有变动都有大项解释</template>
          </div>
        </div>
        <span class="num" style="font-weight: 700; font-size: 13.5px" :class="(detail.autoEntry?.amount ?? 0) >= 0 ? 'm-inc' : 'm-exp'">
          {{ money(detail.autoEntry?.amount ?? 0, { signed: true }) }}
        </span>
      </div>
      <div style="border-top: 1px dashed var(--line); padding-top: 8px; display: flex; font-size: 11.5px; color: var(--t3)">
        <span>合计 = 余额变动</span>
        <b class="num" style="margin-left: auto; color: var(--t1)">{{ money(detail.delta ?? (detail.bigTotal + (detail.autoEntry?.amount ?? 0)), { signed: true }) }} <span class="ok-tag">✓ 平</span></b>
      </div>
    </div>

    <!-- 新增大项 -->
    <Popup v-model:show="addShow" position="bottom" round style="padding: 16px">
      <div style="font-weight: 600; margin-bottom: 10px">新增大项（{{ ym }}）</div>
      <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px">
        <button v-for="(t, i) in customTypes" :key="t.id" type="button" class="type-chip" :class="{ on: addTypeIdx === i }" @click="addTypeIdx = i">{{ t.emoji }} {{ t.name }}</button>
      </div>
      <CellGroup inset>
        <Field v-model="addAmount" label="金额(元)" type="number" :placeholder="customTypes[addTypeIdx]?.direction === 'expense' ? '支出记正数，自动转负' : '收入记正数'" />
        <Field v-model="addNote" label="备注" maxlength="60" />
      </CellGroup>
      <div style="display: flex; gap: 10px; margin-top: 14px">
        <Button block round @click="addShow = false">取消</Button>
        <Button type="primary" block round @click="saveAdd">保存</Button>
      </div>
    </Popup>

    <!-- 编辑弹层 -->
    <Popup v-model:show="editShow" position="bottom" round style="padding: 16px">
      <div style="font-weight: 600; margin-bottom: 10px">编辑大项</div>
      <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px">
        <button v-for="(t, i) in customTypes" :key="t.id" type="button" class="type-chip" :class="{ on: editTypeIdx === i }" @click="editTypeIdx = i">{{ t.emoji }} {{ t.name }}</button>
      </div>
      <CellGroup inset>
        <Field v-model="editAmount" label="金额(元)" type="number" />
        <Field v-model="editNote" label="备注" />
      </CellGroup>
      <div style="display: flex; gap: 10px; margin-top: 14px">
        <Button block round @click="editShow = false">取消</Button>
        <Button type="primary" block round @click="saveEdit">保存</Button>
      </div>
    </Popup>
  </div>
  <div v-else class="empty-tip">加载中…</div>
</template>

<style>
.kv { display: flex; justify-content: space-between; gap: 10px; font-size: 12.5px; color: var(--t2); padding: 4px 0; }
.kv b { font-weight: 600; color: var(--t1); text-align: right; }
/* 平均每日开销主指标：全部走主题变量，深色模式不再出现深字压深底 */
.ia-big {
  display: flex; align-items: center; gap: 10px; margin: 8px 0; padding: 10px 13px;
  background: var(--expense-bg); border-radius: 12px; color: var(--expense-fg); font-size: 12px;
}
.ia-big .ia-val { margin-left: auto; font-size: 22px; font-weight: 700; color: var(--expense); white-space: nowrap; }
.ia-big .ia-tag { font-style: normal; font-size: 10px; color: var(--t3); margin-left: 4px; font-weight: 400; }
.interval-card { border: 1.5px solid var(--expense-line); }
.kind-tag { font-size: 10px; color: var(--expense); }
.auto-badge { font-size: 9px; color: var(--neutral); border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; margin-left: 5px; font-weight: 400; }
.ok-tag { color: var(--income); }
.nav-act { color: var(--brand); font-size: 13px; cursor: pointer; padding: 8px 6px; min-height: 32px; display: inline-flex; align-items: center; }
.link-btn {
  border: none; background: transparent; cursor: pointer; font: inherit;
  font-size: 12px; color: var(--brand); padding: 6px 8px; min-width: 34px; min-height: 30px; border-radius: 8px;
}
.link-btn:hover { background: var(--cell); }
.link-btn.mute { color: var(--t3); }
.type-chip {
  font-size: 12px; padding: 6px 12px; border-radius: 14px; min-height: 32px;
  background: var(--cell); color: var(--t2); cursor: pointer; border: none; font-family: inherit;
}
.type-chip.on { background: var(--brand); color: #fff; font-weight: 600; }
html.dark .type-chip.on { color: #0b1220; }
</style>

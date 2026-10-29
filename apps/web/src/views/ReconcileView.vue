<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { NavBar, Popup, DatePicker, NumberKeyboard, Field, CellGroup, Button, showSuccessToast, showConfirmDialog, showToast } from 'vant'
import { api } from '../api/client'
import { toCents, fromCents, todayYMD, ymOf, ymBounds, ymdToColumns, rawDaysBetween, type Direction } from '../../../../packages/shared/src/index'
import { useUiStore } from '../stores/ui'
import { money, deltaClass } from '../utils/money'
import { useGoBack } from '../utils/nav'
import SyncBadge from '../components/SyncBadge.vue'

interface AccountRow { id: number; name: string; emoji: string; kind: string; group: string | null; archived: boolean; balance: number; initBalance: number; prevBalance?: number }
interface TypeInfo { id: number; name: string; emoji: string; direction: Direction; builtin: boolean; usageCount: number }
interface BigItem { typeId: number; amount: string; note: string }

const router = useRouter()
const route = useRoute()
const ui = useUiStore()
const goBack = useGoBack()

const accounts = ref<AccountRow[]>([])
const types = ref<TypeInfo[]>([])
const ym = ref((route.query.ym as string) || ymOf())
const recordDate = ref(todayYMD())
const inputs = ref<Record<number, string>>({})
const bigItems = ref<BigItem[]>([])
const loaded = ref(false)
/** 该月是否已有快照（决定「新平账 / 编辑中」状态与返回文案） */
const existingPoint = ref(false)
/** 进入页面时的原始输入快照，用于判断是否有未保存改动 */
const pristine = ref('')

// 键盘
const kbShow = ref(false)
const focusId = ref<number | null>(null)
// 月份选择（[年, 月]）
const monthPickShow = ref(false)
const monthValue = ref<string[]>(ymOf().split('-'))
// 记录日选择（[年, 月, 日]）—— 与 monthValue 完全独立，必须回填当前 recordDate
const datePickShow = ref(false)
const dateValue = ref<string[]>(ymdToColumns(todayYMD()))
// 记录日可选范围 = 所选月份的首末日（防止跨月导致天数算错）
const dateBounds = computed(() => ymBounds(ym.value))
const dateMin = computed(() => new Date(dateBounds.value.start + 'T00:00:00'))
const dateMax = computed(() => new Date(dateBounds.value.end + 'T00:00:00'))
// 大项表单
const itemShow = ref(false)
const itemEditIdx = ref(-1)
const itemTypeIdx = ref(0)
const itemAmount = ref('')
const itemNote = ref('')
// 汇总
const showSplit = ref(false)
const batchNote = ref('（批量记录）')

const usableTypes = computed(() => types.value.filter((t) => !t.builtin))
const filledCount = computed(() => Object.values(inputs.value).filter((v) => v !== '' && v !== undefined).length)

function accountById(id: number) { return accounts.value.find((a) => a.id === id) }
/** 上月基准 = 上一月快照余额（API 提供 prevBalance），无则初始余额 */
function prevBalance(id: number): number {
  const a = accountById(id)
  return a ? (a.prevBalance ?? a.balance ?? a.initBalance) : 0
}

const lastPointDate = ref<string | null>(null)

/** 区间天数：不做 Math.max(1,…) 兜底，非法值交给 daysWarn 提示 */
const daysRaw = computed(() => {
  if (!lastPointDate.value) return 0
  return rawDaysBetween(lastPointDate.value, recordDate.value)
})
const daysWarn = computed(() => {
  if (filledCount.value === 0 || !lastPointDate.value) return ''
  if (daysRaw.value <= 0) return '记录日不晚于上次记录，天数无效'
  if (daysRaw.value > 62) return '区间超过 62 天，请确认记录日'
  return ''
})

/** 实时变动合计（仅统计已填账户） */
const totals = computed(() => {
  let delta = 0
  let filled = 0
  for (const a of accounts.value) {
    const raw = inputs.value[a.id]
    if (raw === undefined || raw === '') continue
    const cents = toCents(raw)
    if (cents === null) continue
    delta += cents - prevBalance(a.id)
    filled++
  }
  const bigSum = bigItems.value.reduce((s, it) => {
    const c = toCents(it.amount || '0')
    return s + (c ?? 0)
  }, 0)
  const income = bigItems.value.reduce((s, it) => {
    const t = usableTypes.value.find((x) => x.id === it.typeId)
    const c = toCents(it.amount || '0') ?? 0
    return s + (t?.direction === 'income' && c > 0 ? c : 0)
  }, 0)
  const auto = filled > 0 ? delta - bigSum : 0
  const days = daysRaw.value > 0 ? daysRaw.value : 0
  const spendEst = income > 0 ? income - delta : -delta
  return { delta, filled, bigSum, income, auto, spendEst: filled > 0 ? spendEst : 0, dailyAvg: filled > 0 && days > 0 ? Math.round(spendEst / days) : 0, days }
})

const dirty = computed(() => loaded.value && pristine.value !== snapshotState())
function snapshotState() {
  return JSON.stringify({ i: inputs.value, b: bigItems.value, r: recordDate.value, n: batchNote.value })
}
const saveDisabled = computed(() => filledCount.value === 0 || !!daysWarn.value)

// PC 快捷键：Ctrl+S 保存
function onKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    if (!saveDisabled.value && !saving.value) save()
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

/** 拉取指定月份的账户 / 类型 / 历史，并回填输入 */
async function init(targetYm: string) {
  const [accs, ts, months] = await Promise.all([
    api<AccountRow[]>('/accounts'),
    api<TypeInfo[]>('/types'),
    api<{ months: { ym: string; recordDate: string }[] }>('/months?limit=120'),
  ])
  accounts.value = accs.filter((a) => !a.archived)
  types.value = ts

  const pts = months.months
  const idx = pts.findIndex((m) => m.ym === targetYm)
  existingPoint.value = idx >= 0
  // months 为倒序：本月的上一点在 idx+1；新月份则取最近记录点
  lastPointDate.value = idx >= 0 ? (pts[idx + 1]?.recordDate ?? null) : (pts[0]?.recordDate ?? null)

  if (idx >= 0) {
    // 编辑已有快照：预填
    const detail = await api<any>('/month/' + targetYm)
    recordDate.value = detail.recordDate || clampToMonth(targetYm, todayYMD())
    const pre: Record<number, string> = {}
    for (const a of detail.accounts) {
      if (a.balance !== null) pre[a.id] = fromCents(a.balance)
    }
    inputs.value = pre
    bigItems.value = (detail.entries || [])
      .filter((e: any) => !e.auto)
      .map((e: any) => ({ typeId: e.typeId, amount: fromCents(e.amount), note: e.note || '' }))
    batchNote.value = detail.autoEntry?.note || '（批量记录）'
  } else {
    recordDate.value = clampToMonth(targetYm, todayYMD())
    inputs.value = {}
    bigItems.value = []
    batchNote.value = '（批量记录）'
  }
  syncPickers()
  pristine.value = snapshotState()
  loaded.value = true
}

/** 把日期夹进指定月份（默认记录日不越界） */
function clampToMonth(month: string, d: string): string {
  const { start, end } = ymBounds(month)
  if (d < start) return start
  if (d > end) return end
  return d
}
function syncPickers() {
  monthValue.value = ym.value.split('-')
  dateValue.value = ymdToColumns(clampToMonth(ym.value, recordDate.value))
}

onMounted(() => init(ym.value))

// ---- 月份切换：响应式重载，不再整页 reload ----
async function onMonthConfirm({ selectedValues }: any) {
  const next = `${selectedValues[0]}-${selectedValues[1]}`
  monthPickShow.value = false
  if (next === ym.value) return
  if (dirty.value) {
    try {
      await showConfirmDialog({ title: '切换月份将丢弃未保存的填写', message: `当前 ${ym.value} 的内容还没保存，确认切到 ${next}？`, confirmButtonText: '丢弃并切换', cancelButtonText: '留在本页' })
    } catch {
      syncPickers()
      return
    }
  }
  loaded.value = false
  ym.value = next
  // 同步地址栏但保留 vue-router 的 history.state（传 null 会丢掉 state.back，破坏返回逻辑）
  window.history.replaceState({ ...window.history.state }, '', '#/reconcile?ym=' + next)
  await init(next)
}

// ---- 记录日：确认前校验落在当月内 ----
async function onDateConfirm({ selectedValues }: any) {
  const next = `${selectedValues[0]}-${selectedValues[1]}-${selectedValues[2] ?? '01'}`
  datePickShow.value = false
  const { start, end } = ymBounds(ym.value)
  if (next < start || next > end) {
    showToast(`记录日必须在 ${ym.value} 当月内（${start} ~ ${end}）`)
    syncPickers()
    return
  }
  recordDate.value = next
}

// ---- 键盘输入 ----
function openKb(id: number) {
  focusId.value = id
  kbShow.value = true
}
function onKey(ch: string) {
  if (focusId.value === null) return
  let cur = inputs.value[focusId.value] ?? ''
  if (ch === '.') {
    if (cur.includes('.')) return
    cur = cur === '' ? '0.' : cur + '.'
  } else {
    const parts = cur.split('.')
    if (parts[0].replace(/[^0-9]/g, '').length >= 9 && !cur.includes('.')) return
    if (cur.includes('.') && parts[1].length >= 2) return
    cur += ch
  }
  inputs.value = { ...inputs.value, [focusId.value]: cur }
}
function onDel() {
  if (focusId.value === null) return
  const cur = inputs.value[focusId.value] ?? ''
  inputs.value = { ...inputs.value, [focusId.value]: cur.slice(0, -1) }
}

// ---- PC 表格：回车跳下一行（设计稿 v2.1 §2 承诺） ----
function onPcEnter(i: number) {
  const list = document.querySelectorAll<HTMLInputElement>('.pc-amt')
  const next = list[i + 1]
  if (next) {
    next.focus()
    next.select()
  } else {
    ;(list[i] as HTMLElement).blur()
    if (!saveDisabled.value && !saving.value) save()
  }
}

// ---- 大项 ----
function openItem(idx: number) {
  itemEditIdx.value = idx
  const it = bigItems.value[idx]
  itemTypeIdx.value = it ? Math.max(0, usableTypes.value.findIndex((t) => t.id === it.typeId)) : 0
  itemAmount.value = it?.amount || ''
  itemNote.value = it?.note || ''
  itemShow.value = true
}
function saveItem() {
  const t = usableTypes.value[itemTypeIdx.value]
  if (!t) return
  const cents = toCents(itemAmount.value || '0')
  if (cents === null || cents === 0) return
  const item: BigItem = { typeId: t.id, amount: itemAmount.value, note: itemNote.value }
  if (itemEditIdx.value >= 0) bigItems.value.splice(itemEditIdx.value, 1, item)
  else bigItems.value.push(item)
  itemShow.value = false
}
function removeItem(idx: number) {
  showConfirmDialog({ title: '删除这条大项？' }).then(() => bigItems.value.splice(idx, 1)).catch(() => {})
}
function typeLabel(id: number) {
  const t = types.value.find((x) => x.id === id)
  return t ? `${t.emoji} ${t.name}` : '未知'
}
function typeDirection(id: number): Direction {
  return types.value.find((x) => x.id === id)?.direction || 'neutral'
}

// ---- 保存 ----
const saving = ref(false)
async function save() {
  if (saveDisabled.value) {
    if (daysWarn.value) showToast(daysWarn.value)
    return
  }
  const balances = accounts.value
    .filter((a) => inputs.value[a.id] !== undefined && inputs.value[a.id] !== '')
    .map((a) => ({ accountId: a.id, balance: toCents(inputs.value[a.id])! }))
  if (balances.length === 0) return
  const bigItemsPayload = bigItems.value
    .map((it) => ({ typeId: it.typeId, amount: toCents(it.amount || '0')!, note: it.note || undefined }))
    .filter((x) => !Number.isNaN(x.amount))
  saving.value = true
  try {
    await api('/reconcile', { method: 'POST', body: { ym: ym.value, recordDate: recordDate.value, note: batchNote.value || '（批量记录）', balances, bigItems: bigItemsPayload } })
    pristine.value = snapshotState()
    showSuccessToast(existingPoint.value ? '已更新本月快照' : '已保存本月快照')
    router.replace('/month/' + ym.value)
  } finally {
    saving.value = false
  }
}

/** 返回：有历史则后退，深链进入则回总览；有未保存内容先确认 */
async function onBack() {
  if (dirty.value) {
    try {
      await showConfirmDialog({ title: '还有未保存的填写', message: '离开后本次录入的内容会丢失。', confirmButtonText: '放弃并返回', cancelButtonText: '继续填写' })
    } catch {
      return
    }
  }
  goBack('/')
}

// 输入变化后刷新脏标记（供 onBack 判断）：dirty 由 computed 自动跟随，无需额外 watch
</script>

<template>
  <div class="reconcile-page" :class="{ 'kb-open': kbShow }">
    <NavBar :title="ym + ' 平账'" left-arrow left-text="返回" @click-left="onBack">
      <template #right>
        <span v-if="existingPoint" class="edit-badge">编辑中</span>
        <span v-else class="new-badge">待平账</span>
      </template>
    </NavBar>

    <!-- PC：表格化平账 -->
    <template v-if="ui.isDesktop">
      <div class="pc-topbar">
        <div class="crumb">
          <router-link to="/">总览</router-link><i>/</i><span>{{ ym }} 平账</span>
        </div>
        <SyncBadge />
      </div>
      <div class="card" v-if="loaded">
        <div class="sec-t">
          {{ ym }} · 记录日
          <span class="num date-pick" @click="datePickShow = true">📅 {{ recordDate }}</span>
          <span class="hint">回车跳下一行 · Ctrl+S 保存</span>
        </div>
        <Field v-model="batchNote" label="平账备注" maxlength="60" placeholder="（批量记录）" style="padding: 2px 0 8px" />
        <table class="matrix">
          <thead>
            <tr><th style="width: 30%">账户</th><th>上月余额</th><th>本月余额（输入）</th><th>变动</th></tr>
          </thead>
          <tbody>
            <tr v-for="(a, ai) in accounts" :key="a.id">
              <td>{{ a.emoji }} {{ a.name }} <span v-if="a.kind === 'liability'" class="kind-tag">欠</span></td>
              <td class="num" style="color: var(--t2)">¥{{ money(prevBalance(a.id)) }}</td>
              <td style="text-align: right">
                <input v-model="inputs[a.id]" class="pc-amt num" inputmode="decimal"
                  :class="{ filled: inputs[a.id] !== undefined && inputs[a.id] !== '' }" placeholder="—"
                  @keydown.enter.prevent="onPcEnter(ai)" />
              </td>
              <td class="num" :class="deltaClass(a.kind, (toCents(inputs[a.id] || '') ?? prevBalance(a.id)) - prevBalance(a.id))"
                v-if="inputs[a.id] !== undefined && inputs[a.id] !== ''">
                {{ money((toCents(inputs[a.id] || '') ?? 0) - prevBalance(a.id), { signed: true }) }}
              </td>
              <td v-else class="m-mut">—</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="card" v-if="loaded">
        <div class="sec-t">▸ 记几笔大项（可选）<span class="hint">不记的部分自动归入平账</span></div>
        <div v-for="(it, i) in bigItems" :key="i" class="row-line">
          <span>{{ typeLabel(it.typeId) }}</span>
          <span class="num" style="margin-left: auto" :class="typeDirection(it.typeId) === 'income' ? 'm-inc' : 'm-exp'">{{ money(toCents(it.amount || '0') || 0, { signed: true }) }}</span>
          <button class="link-btn" @click="openItem(i)">改</button>
          <button class="link-btn mute" @click="removeItem(i)">删</button>
        </div>
        <Button size="small" plain round style="margin-top: 8px" @click="openItem(-1)">＋ 添加大项</Button>
      </div>
      <div class="card pc-foot" v-if="loaded">
        <span>变动合计 <b class="num" :class="totals.delta >= 0 ? 'm-inc' : 'm-exp'">{{ money(totals.delta, { signed: true }) }}</b></span>
        <span>大项 <b class="num">{{ money(totals.bigSum, { signed: true }) }}</b></span>
        <span>平账 <b class="num m-mut">{{ money(totals.auto, { signed: true }) }}</b></span>
        <span class="daily-pill num">日均开销 ¥{{ money(totals.dailyAvg) }}<template v-if="totals.days">（{{ totals.days }} 天）</template></span>
        <span v-if="daysWarn" class="days-warn">⚠️ {{ daysWarn }}</span>
        <Button type="primary" round style="min-width: 140px" :loading="saving" :disabled="saveDisabled" @click="save">
          保存快照 (Ctrl+S)
        </Button>
      </div>
    </template>

    <!-- 移动端：卡片行 + 数字键盘 -->
    <template v-else>
      <div class="mb-bar">
        <span class="mb-pick" @click="monthPickShow = true">📅 {{ ym }} ▾</span>
        <span class="mb-pick" @click="datePickShow = true">记录日 {{ recordDate }} ▾</span>
        <span style="margin-left: auto">已填 {{ filledCount }} / {{ accounts.length }}</span>
      </div>

      <template v-if="loaded">
        <div v-for="a in accounts" :key="a.id" class="bal-row" :class="{ focus: focusId === a.id }" @click="openKb(a.id)">
          <span class="cicon">{{ a.emoji }}</span>
          <div style="flex: 1; min-width: 0">
            <div class="nm">{{ a.name }} <span v-if="a.kind === 'liability'" class="kind-tag">欠</span>
              <span v-if="inputs[a.id] !== undefined && inputs[a.id] !== ''" style="color: var(--income); font-size: 11px; margin-left: 4px">✓</span>
            </div>
            <div class="last num">{{ a.kind === 'liability' ? '上次欠款' : '上月' }} ¥{{ money(prevBalance(a.id)) }}</div>
          </div>
          <input class="amt-input num" :value="inputs[a.id] || ''" readonly placeholder="点击填写" @click.stop="openKb(a.id)" />
        </div>

        <!-- 大项折叠 -->
        <div class="split-toggle" @click="showSplit = !showSplit">
          ▸ 记几笔大项（可选，不记全部算平账）
          <span style="margin-left: auto; color: var(--brand)" class="num">已记 {{ bigItems.length }} 笔 {{ money(totals.bigSum, { signed: true }) }}</span>
        </div>
        <div v-if="showSplit" class="card" style="padding: 6px 14px">
          <div v-for="(it, i) in bigItems" :key="i" class="row-line" @click="openItem(i)">
            <span style="font-size: 13px">{{ typeLabel(it.typeId) }}</span>
            <span class="num" style="margin-left: auto" :class="typeDirection(it.typeId) === 'income' ? 'm-inc' : 'm-exp'">{{ money(toCents(it.amount || '0') || 0, { signed: true }) }}</span>
            <button class="link-btn mute" style="margin-left: 10px" @click.stop="removeItem(i)">删</button>
          </div>
          <Button size="small" plain round block style="margin: 8px 0" @click="openItem(-1)">＋ 添加大项</Button>
        </div>

        <!-- 批量备注 -->
        <div class="card" style="padding: 2px 14px; margin-top: 6px">
          <Field v-model="batchNote" label="平账备注" maxlength="60" placeholder="（批量记录）" style="padding: 6px 0" />
        </div>

        <!-- 汇总条 -->
        <div class="sumbar" v-if="filledCount > 0">
          <div style="flex: 1">
            <div style="font-size: 11px; opacity: 0.8">本月变动合计</div>
            <div style="font-size: 10px; opacity: 0.7; margin-top: 2px" class="num">
              大项 {{ money(totals.bigSum, { signed: true }) }} · 平账 {{ money(totals.auto, { signed: true }) }}
              <template v-if="lastPointDate">· 上次记录 {{ lastPointDate }}（{{ totals.days || '—' }} 天）</template>
            </div>
            <div v-if="daysWarn" class="days-warn" style="margin-top: 4px">⚠️ {{ daysWarn }}</div>
          </div>
          <div style="text-align: right">
            <div class="num" style="font-size: 19px; font-weight: 700" :class="totals.delta >= 0 ? 'pos' : 'neg'">
              {{ money(totals.delta, { signed: true }) }}
            </div>
            <div class="num" style="font-size: 10px; opacity: 0.75">日均 ¥{{ money(totals.dailyAvg) }}</div>
          </div>
        </div>
        <div v-else class="sumbar" style="opacity: 0.6">
          <div style="font-size: 11px; opacity: 0.85">填写任意账户余额后，这里实时显示本月变动</div>
        </div>

        <!-- 保存按钮（移动端）：放在键盘占位之前，弹键盘时靠 .kb-pad 抬到键盘上方 -->
        <div class="mb-save">
          <Button type="primary" round block :loading="saving" :disabled="saveDisabled" @click="save">
            {{ existingPoint ? '更新本月快照' : '保存本月快照' }}
          </Button>
        </div>

        <!-- 键盘占位：必须在保存按钮之后，否则会把按钮顶出可视区（走查 S0-2） -->
        <div v-if="kbShow" class="kb-space kb-pad"></div>

        <NumberKeyboard :show="kbShow" theme="custom" extra-key="." close-button-text="完成"
          @input="onKey" @delete="onDel" @close="kbShow = false" @blur="kbShow = false" />
      </template>
    </template>

    <!-- 月份选择 -->
    <Popup v-model:show="monthPickShow" position="bottom" round>
      <DatePicker v-model="monthValue" type="year-month" title="选择月份" :min-date="new Date(2000, 0, 1)" :max-date="new Date(2035, 11, 31)" @confirm="onMonthConfirm" @cancel="syncPickers()" />
    </Popup>
    <!-- 记录日选择：独立 model + 限定当月 -->
    <Popup v-model:show="datePickShow" position="bottom" round>
      <DatePicker v-model="dateValue" :title="'记录日（' + ym + '）'" :min-date="dateMin" :max-date="dateMax"
        @confirm="onDateConfirm" @cancel="syncPickers()" />
    </Popup>

    <!-- 大项表单 -->
    <Popup v-model:show="itemShow" position="bottom" round style="padding: 16px">
      <div style="font-weight: 600; margin-bottom: 10px">{{ itemEditIdx >= 0 ? '编辑大项' : '添加大项' }}</div>
      <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px">
        <button v-for="(t, i) in usableTypes" :key="t.id" type="button" class="type-chip" :class="{ on: itemTypeIdx === i }" @click="itemTypeIdx = i">
          {{ t.emoji }} {{ t.name }}
        </button>
        <button type="button" class="type-chip" @click="router.push('/types')">＋ 管理</button>
      </div>
      <CellGroup inset>
        <Field v-model="itemAmount" label="金额(元)" type="number" placeholder="收入为正 / 支出记负数" />
        <Field v-model="itemNote" label="备注" placeholder="选填" />
      </CellGroup>
      <div style="display: flex; gap: 10px; margin-top: 14px">
        <Button block round @click="itemShow = false">取消</Button>
        <Button type="primary" block round @click="saveItem">保存</Button>
      </div>
    </Popup>
  </div>
</template>

<style>
/* 键盘弹起时：占位块在保存按钮之后（300px > 键盘 236px），按钮滚到底即在键盘上方可见 */
.mb-bar {
  display: flex; align-items: center; gap: 10px; padding: 6px 16px 2px;
  font-size: 12px; color: var(--t3);
}
.mb-pick { cursor: pointer; color: var(--brand); min-height: 30px; display: inline-flex; align-items: center; padding: 0 2px; }
.mb-pick + .mb-pick { color: var(--t2); }
.split-toggle { margin: 8px 18px 4px; font-size: 12px; color: var(--t2); display: flex; cursor: pointer; min-height: 34px; align-items: center; }
.mb-save { margin: 10px 14px 20px; }
.kind-tag { font-size: 10px; color: var(--expense); }
.edit-badge { font-size: 10.5px; color: var(--warn); background: rgba(255, 136, 0, 0.12); border-radius: 6px; padding: 3px 8px; }
.new-badge { font-size: 10.5px; color: var(--brand); background: rgba(59, 130, 246, 0.12); border-radius: 6px; padding: 3px 8px; }
.date-pick { cursor: pointer; color: var(--brand); }
.days-warn { font-size: 11px; color: var(--expense); font-weight: 600; }
/* 汇总条 */
.sumbar {
  margin: 4px 14px; border-radius: 13px; padding: 11px 14px;
  background: var(--sumbar-bg); color: #fff; display: flex; align-items: center;
}
.sumbar .pos { color: var(--sumbar-fg-pos); }
.sumbar .neg { color: var(--sumbar-fg-neg); }
/* PC 平账 */
.pc-topbar { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
.crumb { font-size: 12.5px; color: var(--t3); display: flex; align-items: center; gap: 6px; }
.crumb a { color: var(--t2); text-decoration: none; padding: 10px 6px; min-height: 32px; display: inline-flex; align-items: center; }
.crumb a:hover { color: var(--brand); }
.crumb i { font-style: normal; }
.crumb span { color: var(--t1); font-weight: 600; }
.pc-amt {
  width: 140px; border: 1.5px solid var(--line); border-radius: 8px; padding: 8px 10px;
  font-size: 13px; font-weight: 600; text-align: right; background: var(--surface); color: var(--t1);
  outline: none; font-family: inherit; min-height: 34px;
}
.pc-amt:focus { border-color: var(--brand); box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.12); }
.pc-foot { display: flex; align-items: center; gap: 18px; font-size: 12.5px; color: var(--t2); flex-wrap: wrap; }
.daily-pill { background: var(--expense-bg); color: var(--expense-fg); border-radius: 9px; padding: 5px 12px; font-weight: 600; font-size: 12px; }
html.dark .daily-pill { color: #ffb4b4; }
/* 文字操作按钮：补足触控区与可访问性 */
.link-btn {
  border: none; background: transparent; cursor: pointer; font: inherit;
  font-size: 12px; color: var(--brand); padding: 6px 8px; min-width: 34px; min-height: 30px;
  border-radius: 8px;
}
.link-btn:hover { background: var(--cell); }
.link-btn.mute { color: var(--t3); }
/* 大项类型 chip：跟随主题，深色下不再浅底亮字（走查 S3） */
.type-chip {
  font-size: 12px; padding: 6px 12px; border-radius: 14px; min-height: 32px;
  background: var(--cell); color: var(--t2); cursor: pointer; border: none; font-family: inherit;
}
.type-chip.on { background: var(--brand); color: #fff; font-weight: 600; }
html.dark .type-chip.on { color: #0b1220; }
</style>

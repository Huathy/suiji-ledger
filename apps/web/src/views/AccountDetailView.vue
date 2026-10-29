<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NavBar, Button, Popup, Field, CellGroup, showConfirmDialog, showSuccessToast } from 'vant'
import { api } from '../api/client'
import { fromCents } from '../../../../packages/shared/src/index'
import { money, deltaClass } from '../utils/money'
import { useGoBack } from '../utils/nav'

interface AccountRow { id: number; name: string; emoji: string; kind: string; group: string | null; initBalance: number; inNetWorth: boolean; archived: boolean; note: string | null; balance: number }
interface Snap { ym: string; balance: number; recordDate: string; note: string | null }

const route = useRoute()
const router = useRouter()
const goBack = useGoBack()
const accountId = Number(route.params.id)
const account = ref<AccountRow | null>(null)
const snaps = ref<Snap[]>([])

const rows = computed(() => {
  const out: { ym: string; recordDate: string; balance: number; delta: number | null }[] = []
  const asc = [...snaps.value].reverse()
  asc.forEach((s, i) => {
    const prev = i > 0 ? asc[i - 1].balance : account.value?.initBalance ?? 0
    out.push({ ym: s.ym, recordDate: s.recordDate, balance: s.balance, delta: s.balance - prev })
  })
  return out.reverse()
})

onMounted(async () => {
  const [accounts, snapsAll] = await Promise.all([
    api<AccountRow[]>('/accounts'),
    api<any>('/system/matrix?limit=120'),
  ])
  account.value = accounts.find((a) => a.id === accountId) || null
  const colIdx = snapsAll.accounts.findIndex((a: any) => a.id === accountId)
  snaps.value = colIdx >= 0
    ? snapsAll.rows.map((r: any) => ({ ym: r.ym, recordDate: r.recordDate, balance: r.cells[colIdx], note: null })).filter((x: any) => x.balance !== null)
    : []
})

async function archive() {
  if (!account.value) return
  await showConfirmDialog({ title: account.value.archived ? '取消归档？' : `归档「${account.value.name}」？`, message: '归档后不再出现在平账页，历史快照保留。' })
  await api('/accounts/' + accountId, { method: 'PATCH', body: { archived: !account.value.archived } })
  showSuccessToast('已更新')
  goBack('/accounts')
}

// ---- 修改余额（单独生成平账记录） ----
const balShow = ref(false)
const balYuan = ref('')
const balNote = ref('余额调整')
const balSaving = ref(false)
function openEditBalance() {
  balYuan.value = account.value ? (account.value.balance / 100).toFixed(2) : ''
  balNote.value = '余额调整'
  balShow.value = true
}
async function saveBalance() {
  const cents = Math.round(Number(balYuan.value) * 100)
  if (!Number.isFinite(cents) || cents < 0) return
  balSaving.value = true
  try {
    const r = await api<{ delta: number }>(`/accounts/${accountId}/set-balance`, {
      method: 'POST',
      body: { balance: cents, note: balNote.value || '余额调整' },
    })
    showSuccessToast(r.delta === 0 ? '余额未变化' : `已生成平账记录 ${r.delta >= 0 ? '+' : '−'}¥${(Math.abs(r.delta) / 100).toFixed(2)}`)
    balShow.value = false
    const accounts = await api<AccountRow[]>('/accounts')
    account.value = accounts.find((a) => a.id === accountId) || null
    const snapsAll = await api<any>('/system/matrix?limit=120')
    const colIdx = snapsAll.accounts.findIndex((a: any) => a.id === accountId)
    snaps.value = colIdx >= 0
      ? snapsAll.rows.map((r: any) => ({ ym: r.ym, recordDate: r.recordDate, balance: r.cells[colIdx], note: null })).filter((x: any) => x.balance !== null)
      : []
  } finally {
    balSaving.value = false
  }
}
</script>

<template>
  <div v-if="account">
    <NavBar :title="account.name" left-arrow left-text="返回" @click-left="goBack('/accounts')">
      <template #right>
        <button class="nav-act" @click="archive">{{ account.archived ? '取消归档' : '归档' }}</button>
      </template>
    </NavBar>
    <div class="card">
      <div class="row-line" style="border: none">
        <span class="cicon" style="width: 44px; height: 44px; font-size: 22px">{{ account.emoji }}</span>
        <div style="flex: 1">
          <div style="font-weight: 600">{{ account.name }}</div>
          <div style="font-size: 11px; color: var(--t3)">{{ account.kind === 'liability' ? '负债账户' : '资产账户' }}{{ account.group ? ' · ' + account.group : '' }}{{ account.note ? ' · ' + account.note : '' }}</div>
        </div>
        <div style="text-align: right">
          <div class="num" style="font-size: 19px; font-weight: 700" :class="account.kind === 'liability' ? 'm-exp' : ''">¥{{ money(account.balance) }}</div>
          <div style="font-size: 10px; color: var(--t3)">{{ account.kind === 'liability' ? '当前欠款' : '最近快照余额' }}</div>
        </div>
      </div>
      <Button size="small" round plain type="primary" block style="margin-top: 6px" @click="openEditBalance">✏️ 修改余额（单独生成平账记录）</Button>
    </div>
    <div class="card" style="padding: 4px 14px" v-if="rows.length">
      <div class="sec-t" style="padding: 10px 2px 4px">历史余额</div>
      <div v-for="r in rows" :key="r.ym" class="row-line hist-row" role="link" tabindex="0" :aria-label="r.ym + ' 月度详情'"
        @click="router.push('/month/' + r.ym)" @keyup.enter="router.push('/month/' + r.ym)">
        <span class="num" style="font-size: 13px">{{ r.ym }} <span style="font-size: 10px; color: var(--t3)">{{ r.recordDate }}</span></span>
        <span class="num hist-bal">{{ money(r.balance) }}</span>
        <span class="num hist-delta" :class="deltaClass(account.kind, r.delta)">
          {{ r.delta === null ? '' : money(r.delta, { signed: true }) }}
        </span>
      </div>
    </div>
    <div v-else class="empty-tip">还没有快照记录<br>到「平账」页填写该账户余额开始记录</div>

    <!-- 修改余额 -->
    <Popup v-model:show="balShow" position="bottom" round style="padding: 16px">
      <div style="font-weight: 600; margin-bottom: 4px">修改余额</div>
      <div style="font-size: 11px; color: var(--t3); margin-bottom: 10px">
        将更新{{ account?.kind === 'liability' ? '欠款' : '余额' }}并<b style="color: var(--brand)">单独生成一条平账记录</b>（差额自动计入当月）
      </div>
      <CellGroup inset>
        <Field v-model="balYuan" label="新余额(元)" type="number" />
        <Field v-model="balNote" label="备注" maxlength="50" />
      </CellGroup>
      <div style="display: flex; gap: 10px; margin-top: 14px">
        <Button block round @click="balShow = false">取消</Button>
        <Button type="primary" block round :loading="balSaving" @click="saveBalance">保存</Button>
      </div>
    </Popup>
  </div>
</template>

<style>
.nav-act { border: none; background: transparent; color: var(--brand); font-size: 13px; cursor: pointer; font-family: inherit; min-height: 40px; padding: 8px 6px; }
/* 历史余额行：PC 下不再把三列拉成整行（走查 S3），并补足触控区 */
.hist-row { cursor: pointer; min-height: 44px; }
.hist-row:hover { background: var(--hover); }
.hist-bal { margin-left: auto; font-weight: 600; min-width: 110px; text-align: right; }
.hist-delta { width: 88px; text-align: right; font-size: 11.5px; flex-shrink: 0; }
.app-shell.desktop .hist-bal { min-width: 160px; }
</style>

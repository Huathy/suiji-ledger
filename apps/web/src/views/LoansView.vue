<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NavBar, Popup, Field, CellGroup, Button, RadioGroup, Radio, showSuccessToast, showConfirmDialog } from 'vant'
import { api } from '../api/client'
import { toCents, todayYMD } from '../../../../packages/shared/src/index'
import { yuan as money } from '../utils/money'
import { useGoBack } from '../utils/nav'

interface LoanRow {
  id: number; direction: 'in' | 'out'; counterparty: string; amount: number
  settledAmount: number; remaining: number; status: string
  date: string; dueDate: string | null; accountId: number | null; note: string | null
}

const router = useRouter()
const goBack = useGoBack()
const loans = ref<LoanRow[]>([])
const summary = ref({ borrowIn: 0, lendOut: 0 })
const accounts = ref<{ id: number; name: string; emoji: string }[]>([])
const showSettled = ref(false)
const loaded = ref(false)

function accName(id: number | null): string {
  if (!id) return ''
  return accounts.value.find((a) => a.id === id)?.name || ''
}
function dueHint(l: LoanRow): string {
  if (!l.dueDate || l.status === 'settled') return ''
  const days = Math.ceil((new Date(l.dueDate).getTime() - Date.now()) / 86400000)
  if (days < 0) return `已逾期 ${-days} 天`
  if (days <= 7) return days === 0 ? '今天到期' : `${days} 天内到期`
  return ''
}

async function load() {
  const [r, accs] = await Promise.all([
    api<{ loans: LoanRow[]; summary: { borrowIn: number; lendOut: number } }>('/loans'),
    api<{ id: number; name: string; emoji: string }[]>('/accounts').catch(() => []),
  ])
  loans.value = r.loans
  summary.value = r.summary
  accounts.value = accs as any
  loaded.value = true
}
onMounted(load)

// 新建
const addShow = ref(false)
const form = ref({ direction: 'out' as 'in' | 'out', counterparty: '', amountYuan: '', date: todayYMD(), dueDate: '', accountId: null as number | null, note: '' })
function openAdd(direction: 'in' | 'out') {
  form.value = { direction, counterparty: '', amountYuan: '', date: todayYMD(), dueDate: '', accountId: null, note: '' }
  addShow.value = true
}
async function saveAdd() {
  const cents = toCents(form.value.amountYuan || '0')
  if (cents === null || cents <= 0) return
  await api('/loans', { method: 'POST', body: { ...form.value, amount: cents } })
  showSuccessToast('已记录')
  addShow.value = false
  await load()
}

// 收回/还上
const settleShow = ref(false)
const settleLoan = ref<LoanRow | null>(null)
const settleAmount = ref('')
function openSettle(l: LoanRow) {
  settleLoan.value = l
  settleAmount.value = (l.remaining / 100).toFixed(2)
  settleShow.value = true
}
async function saveSettle() {
  const cents = toCents(settleAmount.value || '0')
  if (cents === null || cents <= 0 || !settleLoan.value) return
  await api(`/loans/${settleLoan.value.id}/settle`, { method: 'POST', body: { amount: cents } })
  showSuccessToast(settleLoan.value.direction === 'out' ? '已收回' : '已还上')
  settleShow.value = false
  await load()
}
async function removeLoan(l: LoanRow) {
  await showConfirmDialog({ title: `删除「${l.counterparty}」这笔记录？`, message: '记录会进入回收站，可恢复。' })
  await api('/loans/' + l.id, { method: 'DELETE' })
  await load()
}

// 一键结清 / 结束债权
async function closeLoan(l: LoanRow, mode: 'settled' | 'closed') {
  const isOut = l.direction === 'out'
  await showConfirmDialog({
    title: mode === 'settled' ? (isOut ? '确认结清？' : '确认还清？') : (isOut ? '结束这笔债权？' : '结束这笔债务？'),
    message: mode === 'settled'
      ? `将剩余 ${money(l.remaining)} 全部记为已${isOut ? '收回' : '归还'}，本金即结清。`
      : `不再追讨/继续，已${isOut ? '收回' : '归还'}部分保留进度；关联的「债权-${l.counterparty}」账户将归档（历史保留）。`,
  })
  await api(`/loans/${l.id}/close`, { method: 'POST', body: { mode } })
  showSuccessToast(mode === 'settled' ? '已结清' : '已结束')
  await load()
}

// 还款设置（编辑金额/约定归还日/备注）
const editShow = ref(false)
const editLoan = ref<LoanRow | null>(null)
const editForm = ref({ amountYuan: '', dueDate: '', note: '' })
function openEdit(l: LoanRow) {
  editLoan.value = l
  editForm.value = { amountYuan: (l.amount / 100).toFixed(2), dueDate: l.dueDate || '', note: l.note || '' }
  editShow.value = true
}
async function saveEdit() {
  if (!editLoan.value) return
  const cents = toCents(editForm.value.amountYuan || '0')
  if (cents === null || cents <= 0) return
  await api('/loans/' + editLoan.value.id, {
    method: 'PATCH',
    body: { amount: cents, dueDate: editForm.value.dueDate || null, note: editForm.value.note || null },
  })
  showSuccessToast('已保存')
  editShow.value = false
  await load()
}

const outOpen = computed(() => loans.value.filter((l) => l.direction === 'out' && l.status !== 'settled'))
const inOpen = computed(() => loans.value.filter((l) => l.direction === 'in' && l.status !== 'settled'))
const outSettled = computed(() => loans.value.filter((l) => l.direction === 'out' && l.status === 'settled'))
const inSettled = computed(() => loans.value.filter((l) => l.direction === 'in' && l.status === 'settled'))
</script>

<template>
  <div>
    <NavBar title="借还中心" left-arrow left-text="返回" @click-left="goBack('/')">
      <template #right><button class="nav-add" aria-label="记一笔借出" @click="openAdd('out')">＋</button></template>
    </NavBar>

    <div class="card" style="display: flex; text-align: center; padding: 14px 0">
      <div style="flex: 1">
        <div style="font-size: 11px; color: var(--t3)">⬆️ 总借出（别人欠我）</div>
        <div class="num m-inc" style="font-size: 19px; font-weight: 700; margin-top: 4px">{{ money(summary.lendOut) }}</div>
      </div>
      <div style="width: 1px; background: var(--line)"></div>
      <div style="flex: 1">
        <div style="font-size: 11px; color: var(--t3)">⬇️ 总借入（我欠别人）</div>
        <div class="num m-exp" style="font-size: 19px; font-weight: 700; margin-top: 4px">{{ money(summary.borrowIn) }}</div>
      </div>
    </div>

    <template v-if="loaded">
      <div class="grp-head">⬆️ 借出（别人欠我）</div>
      <div class="card" style="padding: 4px 14px" v-if="outOpen.length">
        <div v-for="l in outOpen" :key="l.id" class="row-line">
          <div style="flex: 1; min-width: 0">
            <div style="font-size: 13.5px; color: var(--t1)">{{ l.counterparty }} <span class="loan-status" :class="'st-' + l.status">{{ l.status === 'partial' ? '部分收回' : '待收回' }}</span></div>
            <div style="font-size: 10.5px; color: var(--t3)" class="num">{{ l.date }}{{ accName(l.accountId) ? ' · ' + accName(l.accountId) : '' }}{{ l.note ? ' · ' + l.note : '' }}<b v-if="dueHint(l)" style="color: var(--warn)"> ⚠️ {{ dueHint(l) }}</b></div>
          </div>
          <div style="text-align: right">
            <div class="num" style="font-weight: 700; font-size: 13.5px">{{ money(l.remaining) }}</div>
            <div class="num" style="font-size: 9.5px; color: var(--t3)">共 {{ money(l.amount) }}</div>
          </div>
          <button class="link-btn" @click="openSettle(l)">收回</button>
          <button class="link-btn ok" @click="closeLoan(l, 'settled')">结清</button>
          <button class="link-btn mute" @click="openEdit(l)">设置</button>
          <button class="link-btn mute" @click="removeLoan(l)">删</button>
        </div>
      </div>
      <div v-if="outSettled.length" style="margin: 8px 16px">
        <span class="settled-toggle" @click="showSettled = !showSettled">{{ showSettled ? '▾' : '▸' }} 已结清（{{ outSettled.length }}）</span>
        <div v-show="showSettled" class="card" style="padding: 4px 14px; opacity: 0.6; margin-top: 4px">
          <div v-for="l in outSettled" :key="l.id" class="row-line">
            <div style="flex: 1"><div style="font-size: 13px; color: var(--t3)">{{ l.counterparty }}</div></div>
            <span class="num m-mut" style="font-size: 12px">{{ money(l.amount) }}</span>
            <button class="link-btn mute" @click="removeLoan(l)">删</button>
          </div>
        </div>
      </div>
      <div v-if="!outOpen.length && !outSettled.length" class="empty-tip" style="padding: 14px 10px">暂无借出记录</div>

      <div class="grp-head">⬇️ 借入（我欠别人）</div>
      <div class="card" style="padding: 4px 14px" v-if="inOpen.length">
        <div v-for="l in inOpen" :key="l.id" class="row-line">
          <div style="flex: 1; min-width: 0">
            <div style="font-size: 13.5px; color: var(--t1)">{{ l.counterparty }} <span class="loan-status" :class="'st-' + l.status">{{ l.status === 'partial' ? '部分归还' : '待归还' }}</span></div>
            <div style="font-size: 10.5px; color: var(--t3)" class="num">{{ l.date }}{{ accName(l.accountId) ? ' · ' + accName(l.accountId) : '' }}{{ l.note ? ' · ' + l.note : '' }}<b v-if="dueHint(l)" style="color: var(--warn)"> ⚠️ {{ dueHint(l) }}</b></div>
          </div>
          <div style="text-align: right">
            <div class="num" style="font-weight: 700; font-size: 13.5px">{{ money(l.remaining) }}</div>
            <div class="num" style="font-size: 9.5px; color: var(--t3)">共 {{ money(l.amount) }}</div>
          </div>
          <button class="link-btn" @click="openSettle(l)">还上</button>
          <button class="link-btn ok" @click="closeLoan(l, 'settled')">还清</button>
          <button class="link-btn mute" @click="openEdit(l)">设置</button>
          <button class="link-btn mute" @click="removeLoan(l)">删</button>
        </div>
      </div>
      <div v-if="inSettled.length" style="margin: 8px 16px">
        <span class="settled-toggle" @click="showSettled = !showSettled">{{ showSettled ? '▾' : '▸' }} 已结清（{{ inSettled.length }}）</span>
        <div v-show="showSettled" class="card" style="padding: 4px 14px; opacity: 0.6; margin-top: 4px">
          <div v-for="l in inSettled" :key="l.id" class="row-line">
            <div style="flex: 1"><div style="font-size: 13px; color: var(--t3)">{{ l.counterparty }}</div></div>
            <span class="num m-mut" style="font-size: 12px">{{ money(l.amount) }}</span>
            <button class="link-btn mute" @click="removeLoan(l)">删</button>
          </div>
        </div>
      </div>
      <div v-if="!inOpen.length && !inSettled.length" class="empty-tip" style="padding: 14px 10px">暂无借入记录</div>

      <div style="display: flex; gap: 10px; margin: 14px 16px 30px">
        <Button block round plain type="primary" @click="openAdd('out')">＋ 记一笔借出</Button>
        <Button block round plain type="danger" @click="openAdd('in')">＋ 记一笔借入</Button>
      </div>
      <div style="font-size: 10.5px; color: var(--t3); text-align: center; padding-bottom: 20px; line-height: 1.7">
        借还台账只记录「谁欠谁」，不直接改账户余额；<br>钱实际进出体现在平账/调余额里，两种记录互不干扰。
      </div>
    </template>

    <!-- 新建 -->
    <Popup v-model:show="addShow" position="bottom" round style="padding: 16px">
      <div style="font-weight: 600; margin-bottom: 12px">记一笔{{ form.direction === 'out' ? '借出' : '借入' }}</div>
      <CellGroup inset>
        <Field label="方向">
          <template #input>
            <RadioGroup v-model="form.direction" direction="horizontal">
              <Radio name="out">借出（别人欠我）</Radio>
              <Radio name="in">借入（我欠别人）</Radio>
            </RadioGroup>
          </template>
        </Field>
        <Field v-model="form.counterparty" label="对方" placeholder="人名 / 机构" maxlength="20" />
        <Field v-model="form.amountYuan" label="金额(元)" type="number" placeholder="本金" />
        <Field v-model="form.date" label="日期" placeholder="YYYY-MM-DD" />
        <Field v-model="form.dueDate" label="约定归还" placeholder="选填 YYYY-MM-DD" />
        <Field label="关联账户">
          <template #input>
            <select v-model="form.accountId" style="width: 100%; background: transparent; border: none; color: var(--t1); font-size: 13px">
              <option :value="null">不关联</option>
              <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.emoji }} {{ a.name }}</option>
            </select>
          </template>
        </Field>
        <Field v-model="form.note" label="备注" maxlength="50" placeholder="选填" />
      </CellGroup>
      <div style="display: flex; gap: 10px; margin-top: 14px">
        <Button block round @click="addShow = false">取消</Button>
        <Button type="primary" block round :disabled="!form.counterparty.trim()" @click="saveAdd">保存</Button>
      </div>
    </Popup>

    <!-- 收回/还上 -->
    <Popup v-model:show="settleShow" position="bottom" round style="padding: 16px">
      <div style="font-weight: 600; margin-bottom: 4px">{{ settleLoan?.direction === 'out' ? '收回借款' : '归还借款' }}</div>
      <div style="font-size: 11px; color: var(--t3)" class="num">
        {{ settleLoan?.counterparty }} · 剩余 {{ money(settleLoan?.remaining || 0) }} / 共 {{ money(settleLoan?.amount || 0) }}
      </div>
      <CellGroup inset style="margin-top: 10px">
        <Field v-model="settleAmount" label="本次金额(元)" type="number" />
      </CellGroup>
      <div style="display: flex; gap: 10px; margin-top: 14px">
        <Button block round @click="settleShow = false">取消</Button>
        <Button type="primary" block round @click="saveSettle">确认</Button>
      </div>
    </Popup>

    <!-- 还款设置（编辑本金 / 约定归还日 / 备注） -->
    <Popup v-model:show="editShow" position="bottom" round style="padding: 16px">
      <div style="font-weight: 600; margin-bottom: 4px">还款设置 · {{ editLoan?.counterparty }}</div>
      <div style="font-size: 11px; color: var(--t3); margin-bottom: 8px" class="num">
        已{{ editLoan?.direction === 'out' ? '收回' : '归还' }} {{ money(editLoan?.settledAmount || 0) }} / 共 {{ money(editLoan?.amount || 0) }}
      </div>
      <CellGroup inset>
        <Field v-model="editForm.amountYuan" label="本金(元)" type="number" />
        <Field v-model="editForm.dueDate" label="约定归还" placeholder="选填 YYYY-MM-DD" />
        <Field v-model="editForm.note" label="备注" maxlength="50" />
      </CellGroup>
      <div style="display: flex; gap: 10px; margin-top: 14px">
        <Button block round type="warning" plain @click="editLoan && closeLoan(editLoan, 'closed'); editShow = false">直接结束（坏账/免除）</Button>
        <Button type="primary" block round @click="saveEdit">保存</Button>
      </div>
    </Popup>
  </div>
</template>

<style>
.grp-head { font-size: 13px; font-weight: 600; color: var(--t1); padding: 14px 18px 6px; }
.loan-status { font-size: 9px; border-radius: 4px; padding: 0 4px; margin-left: 4px; font-weight: 400; }
.st-open { color: var(--warn); border: 1px solid var(--warn); }
.st-partial { color: var(--brand); border: 1px solid var(--brand); }
.st-settled { color: var(--income); border: 1px solid var(--income); }
.settled-toggle { font-size: 11.5px; color: var(--t3); cursor: pointer; padding: 6px 4px; display: inline-block; }
.nav-add { border: none; background: transparent; color: var(--brand); font-size: 20px; cursor: pointer; min-width: 40px; min-height: 40px; }
/* 行内文字操作按钮：原先是 11px 的 <a>（实测 22×15 / 11×15），触控区过小 */
.link-btn {
  border: none; background: transparent; cursor: pointer; font: inherit;
  font-size: 12px; color: var(--brand); padding: 6px 8px; min-width: 40px; min-height: 36px;
  border-radius: 8px; flex-shrink: 0;
}
.link-btn:hover { background: var(--cell); }
.link-btn.mute { color: var(--t3); }
.link-btn.ok { color: var(--income); }
</style>

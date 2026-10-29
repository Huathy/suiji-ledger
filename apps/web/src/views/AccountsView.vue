<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NavBar, Popup, Field, CellGroup, Cell, Button, RadioGroup, Radio, Switch, showSuccessToast, showConfirmDialog } from 'vant'
import { api } from '../api/client'
import { toCents, fromCents } from '../../../../packages/shared/src/index'
import { yuan as money } from '../utils/money'
import { useUiStore } from '../stores/ui'

interface AccountRow {
  id: number; name: string; emoji: string; kind: string; group: string | null
  initBalance: number; inNetWorth: boolean; archived: boolean; note: string | null
  balance: number; prevBalance: number
}
interface LoanSummary { borrowIn: number; lendOut: number }

const router = useRouter()
const ui = useUiStore()
const accounts = ref<AccountRow[]>([])
const loanSummary = ref<LoanSummary>({ borrowIn: 0, lendOut: 0 })
const loaded = ref(false)

const assetsTotal = computed(() =>
  accounts.value.filter((a) => a.inNetWorth && !a.archived && a.kind === 'asset').reduce((s, a) => s + a.balance, 0),
)
const liabilityTotal = computed(() =>
  accounts.value.filter((a) => a.inNetWorth && !a.archived && a.kind === 'liability').reduce((s, a) => s + a.balance, 0),
)
const networth = computed(() => assetsTotal.value - liabilityTotal.value)
const debtRatio = computed(() => (assetsTotal.value > 0 ? Math.min(100, Math.round((liabilityTotal.value / assetsTotal.value) * 100)) : 0))
const assetCount = computed(() => accounts.value.filter((a) => !a.archived && a.kind === 'asset').length)
const liabilityCount = computed(() => accounts.value.filter((a) => !a.archived && a.kind === 'liability').length)

/** 分组：资产按 group 聚合（含小计），负债单列一组 */
interface GroupSec { name: string; total: number; accounts: AccountRow[] }
const assetGroups = computed<GroupSec[]>(() => {
  const map = new Map<string, AccountRow[]>()
  for (const a of accounts.value.filter((x) => !x.archived && x.kind === 'asset')) {
    const g = a.group || '未分组'
    if (!map.has(g)) map.set(g, [])
    map.get(g)!.push(a)
  }
  return [...map.entries()]
    .map(([name, list]) => ({ name, total: list.reduce((s, a) => s + a.balance, 0), accounts: list }))
    .sort((a, b) => b.total - a.total)
})
const liabilityGroup = computed<GroupSec>(() => {
  const list = accounts.value.filter((a) => !a.archived && a.kind === 'liability')
  return { name: '负债', total: list.reduce((s, a) => s + a.balance, 0), accounts: list }
})
const collapsed = ref<Record<string, boolean>>(JSON.parse(localStorage.getItem('mr_group_collapsed') || '{}'))

// ---- 分组管理：自定义分组持久化在 settings.groups（JSON 数组）----
const customGroups = ref<string[]>([])
const newGroupShow = ref(false)
const newGroupName = ref('')
const selected = ref<Set<number>>(new Set())
const moveShow = ref(false)
const moveTarget = ref<string>('')
const moveNewName = ref('')

function toggleSel(id: number) {
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected.value = next
}
const selCount = computed(() => selected.value.size)

async function loadSettings() {
  try {
    const r = await api<{ settings: Record<string, string> }>('/system/settings')
    customGroups.value = JSON.parse(r.settings.groups || '[]')
  } catch {
    customGroups.value = []
  }
}
async function persistGroups() {
  await api('/system/settings', { method: 'PUT', body: { settings: { groups: JSON.stringify(customGroups.value) } } })
}

/** 已知分组 = 自定义分组 + 账户实际所在分组（去重） */
const knownGroups = computed(() => {
  const set = new Set<string>(customGroups.value)
  for (const a of accounts.value.filter((x) => !x.archived)) set.add(a.group || '未分组')
  return [...set]
})
const emptyCustomGroups = computed(() =>
  customGroups.value.filter((g) => !accounts.value.some((a) => !a.archived && (a.group || '未分组') === g)),
)
const accountGroupsSet = computed(() => new Set(accounts.value.filter((x) => !x.archived).map((x) => x.group || '未分组')))

async function createGroup() {
  const name = newGroupName.value.trim()
  if (!name) return
  if (customGroups.value.includes(name)) return showSuccessToast('分组已存在')
  customGroups.value.push(name)
  await persistGroups()
  newGroupName.value = ''
  showSuccessToast(`分组「${name}」已创建，勾选账户后可批量移入`)
}
async function deleteEmptyGroup(g: string) {
  await showConfirmDialog({ title: `删除空分组「${g}」？` })
  customGroups.value = customGroups.value.filter((x) => x !== g)
  await persistGroups()
}

// 批量移入分组
async function moveSelected() {
  const target = moveTarget.value === '__new__' ? moveNewName.value.trim() : moveTarget.value
  if (!target) return
  for (const id of selected.value) {
    await api('/accounts/' + id, { method: 'PATCH', body: { group: target === '未分组' ? null : target } })
  }
  if (!customGroups.value.includes(target) && target !== '未分组') {
    customGroups.value.push(target)
    await persistGroups()
  }
  showSuccessToast(`已将 ${selected.value.size} 个账户移入「${target}」`)
  selected.value = new Set()
  moveShow.value = false
  moveTarget.value = ''
  moveNewName.value = ''
  await load()
}

// 排序
const sortShow = ref(false)
const sortable = computed(() => accounts.value.filter((a) => !a.archived))
async function moveAcc(a: AccountRow, dir: -1 | 1) {
  const list = sortable.value.slice().sort((x, y) => x.sort - y.sort)
  const i = list.findIndex((x) => x.id === a.id)
  const j = i + dir
  if (j < 0 || j >= list.length) return
  await api('/accounts/' + list[i].id, { method: 'PATCH', body: { sort: list[j].sort } })
  await api('/accounts/' + list[j].id, { method: 'PATCH', body: { sort: list[i].sort } })
  await load()
}
// 分组重命名
const renameShow = ref(false)
const renameFrom = ref('')
const renameTo = ref('')
function openRename(g: string) {
  renameFrom.value = g
  renameTo.value = g
  renameShow.value = true
}
async function saveRename() {
  if (!renameTo.value.trim() || renameTo.value === renameFrom.value) return
  const inGroup = accounts.value.filter((a) => (a.group || '未分组') === renameFrom.value && !a.archived)
  for (const a of inGroup) {
    await api('/accounts/' + a.id, { method: 'PATCH', body: { group: renameTo.value.trim() } })
  }
  showSuccessToast(`已将 ${inGroup.length} 个账户移入「${renameTo.value.trim()}」`)
  renameShow.value = false
  await load()
}
function toggleGroup(name: string) {
  collapsed.value[name] = !collapsed.value[name]
  localStorage.setItem('mr_group_collapsed', JSON.stringify(collapsed.value))
}

// 表单
const sheetShow = ref(false)
const editId = ref<number | null>(null)
const form = ref({ name: '', emoji: '🏦', kind: 'asset', group: '', initYuan: '', inNetWorth: true, note: '' })
const emojiQuick = ['🏦', '💵', '🟢', '🔵', '📈', '💳', '🏠', '🚗', '🪙', '💼', '🏘', '👛']

async function load() {
  await loadSettings()
  const [accs, loans] = await Promise.all([
    api<AccountRow[]>('/accounts'),
    api<{ summary: LoanSummary }>('/loans').catch(() => ({ summary: { borrowIn: 0, lendOut: 0 } })),
  ])
  accounts.value = accs
  loanSummary.value = loans.summary
  loaded.value = true
}
onMounted(load)

function openAdd() {
  editId.value = null
  form.value = { name: '', emoji: '🏦', kind: 'asset', group: '', initYuan: '', inNetWorth: true, note: '' }
  sheetShow.value = true
}
function openEdit(a: AccountRow) {
  editId.value = a.id
  form.value = { name: a.name, emoji: a.emoji, kind: a.kind, group: a.group || '', initYuan: fromCents(a.initBalance), inNetWorth: a.inNetWorth, note: a.note || '' }
  sheetShow.value = true
}
async function save() {
  const cents = toCents(form.value.initYuan || '0')
  if (cents === null || cents < 0) return
  const body: any = {
    name: form.value.name, emoji: form.value.emoji, kind: form.value.kind,
    group: form.value.group || null, inNetWorth: form.value.inNetWorth, note: form.value.note || null,
  }
  if (editId.value === null) body.initBalance = cents
  if (editId.value === null) await api('/accounts', { method: 'POST', body })
  else await api('/accounts/' + editId.value, { method: 'PATCH', body })
  showSuccessToast('已保存')
  sheetShow.value = false
  await load()
}
async function toggleArchive(a: AccountRow) {
  const to = !a.archived
  await showConfirmDialog({ title: to ? `归档「${a.name}」？` : `取消归档「${a.name}」？`, message: to ? '归档后不再出现在平账页，历史快照保留。' : '' })
  await api('/accounts/' + a.id, { method: 'PATCH', body: { archived: to } })
  await load()
}
</script>

<template>
  <div>
    <NavBar title="账户">
      <template #right><button class="nav-add" aria-label="添加账户" @click="openAdd">＋</button></template>
    </NavBar>

    <!-- 净资产大卡 -->
    <div class="card">
      <div style="text-align: center">
        <div style="font-size: 12px; color: var(--t2)">
          净资产
          <span class="eye-btn" role="button" tabindex="0" :aria-label="ui.hideAmounts ? '显示金额' : '隐藏金额'" :title="ui.hideAmounts ? '显示金额' : '隐藏金额'"
            @click="ui.toggleHideAmounts()" @keyup.enter="ui.toggleHideAmounts()">{{ ui.hideAmounts ? '🙈' : '👁' }}</span>
        </div>
        <div class="num" style="font-size: 30px; font-weight: 700; margin: 6px 0 10px">{{ money(networth) }}</div>
        <div style="display: flex; text-align: center">
          <div style="flex: 1">
            <div style="font-size: 11px; color: var(--t3)">总资产</div>
            <div class="num" style="font-size: 15px; font-weight: 600; margin-top: 2px">{{ money(assetsTotal) }}</div>
          </div>
          <div style="width: 1px; background: var(--line)"></div>
          <div style="flex: 1">
            <div style="font-size: 11px; color: var(--t3)">总负债</div>
            <div class="num" style="font-size: 15px; font-weight: 600; margin-top: 2px" :class="liabilityTotal > 0 ? 'm-exp' : ''">
              {{ liabilityTotal > 0 ? money(liabilityTotal) : '无' }}
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 负债率 + 借入借出 -->
    <div class="card">
      <div class="sec-t" style="padding-bottom: 6px">资产概览</div>
      <div class="ratio-row"><span class="num">{{ assetCount }} 项资产</span><span class="num">{{ debtRatio }}% 负债率</span><span class="num">{{ liabilityCount }} 项负债</span></div>
      <div class="ratio-bar"><i :style="{ width: debtRatio + '%' }"></i></div>
      <div style="display: flex; margin-top: 12px; border-top: 1px solid var(--line); padding-top: 12px">
        <div style="flex: 1; text-align: center; cursor: pointer" @click="router.push('/loans')">
          <div style="font-size: 11px; color: var(--t3)">⬆️ 总借出（别人欠我）</div>
          <div class="num" style="font-size: 16px; font-weight: 700; margin-top: 3px">{{ money(loanSummary.lendOut) }}</div>
        </div>
        <div style="width: 1px; background: var(--line)"></div>
        <div style="flex: 1; text-align: center; cursor: pointer" @click="router.push('/loans')">
          <div style="font-size: 11px; color: var(--t3)">⬇️ 总借入（我欠别人）</div>
          <div class="num" style="font-size: 16px; font-weight: 700; margin-top: 3px">{{ money(loanSummary.borrowIn) }}</div>
        </div>
      </div>
    </div>

    <template v-if="loaded">
      <!-- 资产分组（小计 + 折叠） -->
      <div v-for="g in assetGroups" :key="g.name">
        <div class="grp-head" @click="toggleGroup(g.name)">
          <span>{{ g.name }}</span>
          <i class="grp-edit" @click.stop="openRename(g.name)">✎</i>
          <span style="margin-left: auto; display: flex; align-items: center; gap: 6px">
            <b class="num">{{ money(g.total) }}</b>
            <i :class="['chev', collapsed[g.name] ? 'rot' : '']">▼</i>
          </span>
        </div>
        <div class="card" style="padding: 4px 14px" v-show="!collapsed[g.name]">
          <div v-for="a in g.accounts" :key="a.id" class="row-line" style="cursor: pointer" @click="router.push('/accounts/' + a.id)">
            <span class="sel-box" :class="{ on: selected.has(a.id) }" @click.stop="toggleSel(a.id)">{{ selected.has(a.id) ? '✓' : '' }}</span>
            <span class="cicon">{{ a.emoji }}</span>
            <div style="flex: 1; min-width: 0">
              <div style="font-size: 13.5px; color: var(--t1)">{{ a.name }} <span v-if="!a.inNetWorth" class="badge-n">不计入</span></div>
              <div style="font-size: 10.5px; color: var(--t3)" class="num">上月 {{ money(a.prevBalance) }}</div>
            </div>
            <b class="num" style="font-size: 14px">{{ money(a.balance) }}</b>
          </div>
        </div>
      </div>

      <!-- 负债组 -->
      <template v-if="liabilityGroup.accounts.length">
        <div class="grp-head" @click="toggleGroup('负债')">
          <span>负债</span>
          <span style="margin-left: auto; display: flex; align-items: center; gap: 6px">
            <b class="num m-exp">{{ money(liabilityGroup.total) }}</b>
            <i :class="['chev', collapsed['负债'] ? 'rot' : '']">▼</i>
          </span>
        </div>
        <div class="card" style="padding: 4px 14px" v-show="!collapsed['负债']">
          <div v-for="a in liabilityGroup.accounts" :key="a.id" class="row-line" style="cursor: pointer" @click="router.push('/accounts/' + a.id)">
            <span class="cicon">{{ a.emoji }}</span>
            <div style="flex: 1">
              <div style="font-size: 13.5px; color: var(--t1)">{{ a.name }} <span v-if="!a.inNetWorth" class="badge-n">不计入</span></div>
              <div style="font-size: 10.5px; color: var(--t3)">当前欠款</div>
            </div>
            <b class="num m-exp" style="font-size: 14px">{{ money(a.balance) }}</b>
          </div>
        </div>
      </template>

      <!-- 已归档 -->
      <div v-if="accounts.some((a) => a.archived)">
        <div class="grp-head" @click="toggleGroup('已归档')">
          <span>已归档（历史保留）</span><i :class="['chev', collapsed['已归档'] ? '' : 'rot']">▼</i>
        </div>
        <div class="card" style="padding: 4px 14px" v-show="collapsed['已归档']">
          <div v-for="a in accounts.filter((x) => x.archived)" :key="a.id" class="row-line" @click="openEdit(a)">
            <span class="cicon" style="opacity: 0.5">{{ a.emoji }}</span>
            <div style="flex: 1; font-size: 13px; color: var(--t3)">{{ a.name }}</div>
            <span class="num m-mut">{{ money(a.balance) }}</span>
          </div>
        </div>
      </div>

      <div v-if="selCount > 0" class="card" style="display: flex; align-items: center; gap: 10px; padding: 10px 14px; border: 1.5px solid var(--brand)">
        <span style="font-size: 12.5px; color: var(--t2)">已选 <b class="num">{{ selCount }}</b> 个账户</span>
        <Button size="small" round type="primary" style="margin-left: auto" @click="moveTarget = knownGroups[0] || ''; moveNewName = ''; moveShow = true">移入分组…</Button>
        <Button size="small" round plain @click="selected = new Set()">取消选择</Button>
      </div>
      <div style="display: flex; gap: 10px; margin: 14px 16px; flex-wrap: wrap">
        <Button block round plain type="primary" @click="openAdd">＋ 添加账户</Button>
        <Button block round plain @click="newGroupShow = true">🗂 新建分组</Button>
        <Button block round plain @click="sortShow = true">⇅ 排序</Button>
      </div>
      <Popup v-model:show="newGroupShow" position="bottom" round style="padding: 16px">
        <div style="font-weight: 600; margin-bottom: 4px">新建分组</div>
        <div style="font-size: 11px; color: var(--t3); margin-bottom: 8px">创建后，勾选账户即可批量归入</div>
        <CellGroup inset>
          <Field v-model="newGroupName" label="分组名" placeholder="如：资金 / 充值 / 投资" maxlength="15" />
        </CellGroup>
        <Button type="primary" block round style="margin-top: 12px" :disabled="!newGroupName.trim()" @click="createGroup">创建</Button>
        <div v-if="customGroups.length" style="margin-top: 12px">
          <div style="font-size: 11px; color: var(--t3); padding: 2px 0">已有自定义分组（空的可删除）</div>
          <div style="display: flex; gap: 6px; flex-wrap: wrap">
            <span v-for="g in customGroups" :key="g" class="emoji-chip">
              {{ g }}
              <a v-if="emptyCustomGroups.includes(g)" style="color: var(--expense); margin-left: 4px" @click="deleteEmptyGroup(g)">×</a>
            </span>
          </div>
        </div>
      </Popup>
      <Popup v-model:show="moveShow" position="bottom" round style="padding: 16px">
        <div style="font-weight: 600; margin-bottom: 4px">移入分组</div>
        <div style="font-size: 11px; color: var(--t3); margin-bottom: 8px">将选中的 {{ selCount }} 个账户归入以下分组</div>
        <CellGroup inset>
          <RadioGroup v-model="moveTarget">
            <Cell v-for="g in knownGroups" :key="g" :title="g" is-link @click="moveTarget = g">
              <template #right-icon><Radio :name="g" @click.stop /></template>
            </Cell>
            <Cell title="＋ 新建分组…" is-link @click="moveTarget = '__new__'">
              <template #right-icon><Radio name="__new__" @click.stop /></template>
            </Cell>
          </RadioGroup>
        </CellGroup>
        <CellGroup inset v-if="moveTarget === '__new__'" style="margin-top: 8px">
          <Field v-model="moveNewName" label="新分组名" placeholder="输入新分组名称" maxlength="15" />
        </CellGroup>
        <div style="display: flex; gap: 10px; margin-top: 14px">
          <Button block round @click="moveShow = false">取消</Button>
          <Button type="primary" block round :disabled="!moveTarget || (moveTarget === '__new__' && !moveNewName.trim())" @click="moveSelected">确认移入</Button>
        </div>
      </Popup>
      <Popup v-model:show="sortShow" position="bottom" round style="padding: 16px">
        <div style="font-weight: 600; margin-bottom: 8px">账户排序（上/下移动）</div>
        <div class="card" style="padding: 4px 14px; margin: 0">
          <div v-for="(a, i) in sortable" :key="a.id" class="row-line">
            <span class="cicon" style="width: 30px; height: 30px; font-size: 14px">{{ a.emoji }}</span>
            <span style="flex: 1; font-size: 13px">{{ a.name }}</span>
            <a style="cursor: pointer; color: var(--brand); margin: 0 8px" @click="i > 0 && moveAcc(a, -1)">↑</a>
            <a style="cursor: pointer; color: var(--brand)" @click="i < sortable.length - 1 && moveAcc(a, 1)">↓</a>
          </div>
        </div>
        <Button block round style="margin-top: 12px" @click="sortShow = false">完成</Button>
      </Popup>
      <Popup v-model:show="renameShow" position="bottom" round style="padding: 16px">
        <div style="font-weight: 600; margin-bottom: 4px">重命名分组「{{ renameFrom }}」</div>
        <CellGroup inset style="margin-top: 8px">
          <Field v-model="renameTo" label="新名称" maxlength="15" />
        </CellGroup>
        <div style="display: flex; gap: 10px; margin-top: 14px">
          <Button block round @click="renameShow = false">取消</Button>
          <Button type="primary" block round @click="saveRename">保存</Button>
        </div>
      </Popup>
    </template>

    <!-- 账户表单 -->
    <Popup v-model:show="sheetShow" position="bottom" round style="padding: 16px">
      <div style="font-weight: 600; margin-bottom: 12px">{{ editId ? '编辑账户' : '添加账户' }}</div>
      <div style="display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px">
        <span v-for="e in emojiQuick" :key="e" class="emoji-chip" :class="{ on: form.emoji === e }" @click="form.emoji = e">{{ e }}</span>
      </div>
      <CellGroup inset>
        <Field v-model="form.name" label="名称" placeholder="如：招商银行卡" maxlength="20" />
        <Field v-model="form.emoji" label="图标" maxlength="4" />
        <Field label="性质">
          <template #input>
            <RadioGroup v-model="form.kind" direction="horizontal">
              <Radio name="asset">资产</Radio>
              <Radio name="liability">负债（存欠款）</Radio>
            </RadioGroup>
          </template>
        </Field>
        <Field v-model="form.group" label="分组" placeholder="如：资金 / 充值 / 投资（选填）" maxlength="15" />
        <div style="display: flex; gap: 6px; flex-wrap: wrap; padding: 0 16px 4px">
          <span v-for="g in knownGroups.filter((x) => x !== '未分组')" :key="g" class="emoji-chip" :class="{ on: form.group === g }" @click="form.group = g">{{ g }}</span>
        </div>
        <Field v-model="form.initYuan" label="初始余额" type="number" placeholder="元 · 即首次快照基准">
          <template #right-icon>
            <span style="font-size: 10px; color: var(--t3)">计入净资产</span>
            <Switch v-model="form.inNetWorth" size="20px" style="margin-left: 6px" />
          </template>
        </Field>
        <Field v-model="form.note" label="备注" maxlength="50" placeholder="选填" />
      </CellGroup>
      <div style="display: flex; gap: 10px; margin-top: 14px">
        <Button v-if="editId" block round type="warning" plain @click="editId !== null && toggleArchive(accounts.find((x) => x.id === editId)!).then(() => (sheetShow = false))">
          {{ accounts.find((x) => x.id === editId)?.archived ? '取消归档' : '归档' }}
        </Button>
        <Button block round @click="sheetShow = false">取消</Button>
        <Button type="primary" block round :disabled="!form.name.trim()" @click="save">保存</Button>
      </div>
    </Popup>
  </div>
</template>

<style>
.grp-head {
  display: flex; align-items: center; padding: 14px 18px 6px;
  font-size: 13px; font-weight: 600; color: var(--t1); cursor: pointer;
}
.chev { font-style: normal; font-size: 9px; color: var(--t3); transition: transform 0.2s; display: inline-flex; align-items: center; justify-content: center; min-width: 24px; min-height: 24px; }
.chev.rot { transform: rotate(-90deg); }
.badge-n { font-size: 9px; color: var(--t3); border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; margin-left: 4px; }
.ratio-row { display: flex; justify-content: space-between; font-size: 11px; color: var(--t2); padding: 4px 0; }
.ratio-bar { height: 6px; border-radius: 3px; background: var(--cell); overflow: hidden; }
.ratio-bar i { display: block; height: 100%; background: var(--expense); border-radius: 3px; }
.grp-edit { font-style: normal; font-size: 11px; color: var(--t3); margin-left: 6px; padding: 6px 8px; border-radius: 8px; background: var(--cell); min-width: 28px; min-height: 28px; display: inline-flex; align-items: center; justify-content: center; }
.grp-edit:hover { color: var(--brand); }
.eye-btn {
  cursor: pointer; margin-left: 6px; display: inline-flex; align-items: center; justify-content: center;
  min-width: 32px; min-height: 32px; border-radius: 8px; vertical-align: middle;
}
.eye-btn:hover { background: var(--cell); }
.nav-add { border: none; background: transparent; color: var(--brand); font-size: 20px; cursor: pointer; min-width: 40px; min-height: 40px; line-height: 1; }
/* 多选框：原先误写在 style 块之后，样式从未生效（走查补修） */
.sel-box {
  width: 18px; height: 18px; border-radius: 5px; border: 1.5px solid var(--line);
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; color: #fff; flex-shrink: 0; cursor: pointer;
  padding: 6px; background-clip: content-box;
}
html.dark .sel-box { border-color: #4a4f5c; }
.sel-box.on { background: var(--brand); border-color: var(--brand); }
</style>


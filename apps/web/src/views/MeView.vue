<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NavBar, Field, CellGroup, Button, Dialog, showSuccessToast, showConfirmDialog, RadioGroup, Radio, Switch } from 'vant'
import { api, downloadFile, OFFLINE, saveTextFile, pickTextFile } from '../api/client'
import { useUiStore } from '../stores/ui'
import { useAuthStore } from '../stores/auth'

const router = useRouter()
const ui = useUiStore()
const auth = useAuthStore()

const settings = ref<Record<string, string>>({})
const stats = ref({ accounts: 0, snapshots: 0 })
const reminderDay = ref('28')
const reminderOn = ref('on')

// 改口令
const pwdShow = ref(false)
const oldPwd = ref('')
const newPwd = ref('')
const newPwd2 = ref('')

// 恢复
const restoreMode = ref<'replace' | 'merge'>('replace')


onMounted(async () => {
  const [s, me] = await Promise.all([
    api<{ settings: Record<string, string> }>('/system/settings'),
    api<any>('/auth/me'),
  ])
  settings.value = s.settings
  reminderDay.value = s.settings.reminderDay || '28'
  reminderOn.value = s.settings.reminderEnabled || 'on'
  stats.value = { accounts: me.accounts, snapshots: me.snapshots }
})

async function saveReminder() {
  const d = Math.min(28, Math.max(1, Number(reminderDay.value) || 28))
  await api('/system/settings', { method: 'PUT', body: { settings: { reminderDay: String(d) } } })
  settings.value.reminderDay = String(d)
  showSuccessToast('已保存，每月 ' + d + ' 号提醒')
}
async function saveReminderEnabled() {
  await api('/system/settings', { method: 'PUT', body: { settings: { reminderEnabled: reminderOn.value } } })
  if (reminderOn.value === 'on' && 'Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission()
  }
  showSuccessToast(reminderOn.value === 'on' ? '提醒已开启' : '提醒已关闭')
}
async function exportXlsx() {
  const XLSX = await import('xlsx')
  const m = await api<any>('/system/matrix?limit=120')
  const head = ['月份', '记录日', ...m.accounts.map((a: any) => `${a.emoji}${a.name}${a.kind === 'liability' ? '(欠)' : ''}`), '总资产', '净资产', '结余', '日均开销(估)']
  const rows = m.rows.map((r: any) => [
    r.ym, r.recordDate,
    ...r.cells.map((v: any) => (v === null ? '' : Number((v / 100).toFixed(2)))),
    Number((r.assetsTotal / 100).toFixed(2)), Number((r.networth / 100).toFixed(2)),
    r.delta === null ? '' : Number((r.delta / 100).toFixed(2)),
    r.dailyAvg === null ? '' : Number((r.dailyAvg / 100).toFixed(2)),
  ])
  const ws = XLSX.utils.aoa_to_sheet([head, ...rows])
  ws['!cols'] = head.map((h) => ({ wch: Math.max(10, String(h).length + 4) }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '资产负债总表')
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
  const { saveTextFile } = await import('../api/client')
  const where = await saveTextFile(`suiji-ledger-总表-${new Date().toISOString().slice(0, 10)}.xlsx`, new Blob([out]))
  showSuccessToast(typeof where === 'string' && where.startsWith('已保存') ? where : '已导出')
}

function setTheme(t: 'auto' | 'light' | 'dark') {
  ui.setTheme(t)
}

async function changePwd() {
  if (newPwd.value !== newPwd2.value) return
  await api('/auth/password', { method: 'POST', body: { old: oldPwd.value, new: newPwd.value } })
  showSuccessToast('口令已修改')
  pwdShow.value = false
  oldPwd.value = newPwd.value = newPwd2.value = ''
}

async function exportBackup() {
  const name = `suiji-ledger-backup-${new Date().toISOString().slice(0, 10)}.json`
  if (OFFLINE) {
    const data = await api<any>('/system/backup')
    const where = await saveTextFile(name, JSON.stringify(data, null, 2))
    showSuccessToast(where)
    return
  }
  await downloadFile('/system/backup', name)
}
async function exportCsv() {
  await downloadFile('/system/matrix.csv', 'suiji-ledger-balance-sheet.csv')
}

/** 离线模式：走系统文件选择器；服务端模式：网页文件输入 */
async function onRestorePick() {
  const text = await pickTextFile()
  if (!text) return
  await doRestore(text)
}
async function onRestoreFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  await doRestore(await file.text())
  ;(e.target as HTMLInputElement).value = ''
}
async function doRestore(text: string) {
  let data: any
  try {
    data = JSON.parse(text)
  } catch {
    return
  }
  await showConfirmDialog({
    title: restoreMode.value === 'replace' ? '确认覆盖恢复？' : '确认合并恢复？',
    message: restoreMode.value === 'replace'
      ? '将清空现有全部数据，用备份文件内容替换。'
      : '按账户名+性质合并到现有数据，同月快照以备份为准。',
  })
  const r = await api<{ imported: number }>('/system/restore', { method: 'POST', body: { mode: restoreMode.value, data } })
  showSuccessToast(`恢复完成，导入 ${r.imported} 条快照`)
}

async function logout() {
  await showConfirmDialog({ title: '退出登录？' })
  auth.logout()
  window.location.hash = '#/login'
}
</script>

<template>
  <div>
    <NavBar title="我的" />
    <div class="card" style="display: flex; align-items: center; gap: 12px">
      <div style="width: 48px; height: 48px; border-radius: 50%; background: linear-gradient(135deg, #3b82f6, #60a5fa); color: #fff; font-size: 22px; display: flex; align-items: center; justify-content: center">💰</div>
      <div>
        <div style="font-size: 15px; font-weight: 600">我的账本</div>
        <div style="font-size: 11px; color: var(--t3)" class="num">{{ stats.accounts }} 个账户 · {{ stats.snapshots }} 条月度快照</div>
      </div>
    </div>

    <div class="grp-label">记账与数据</div>
    <div class="card" style="padding: 2px 14px">
      <div class="menu-line" @click="router.push('/types')"><span>🏷</span>类型管理<span class="arr">›</span></div>
      <div class="menu-line" @click="router.push('/accounts')"><span>🏦</span>账户管理<span class="arr">›</span></div>
      <div class="menu-line" v-if="!OFFLINE" @click="router.push('/sync')"><span>🔄</span>数据同步（Git）<span class="arr">›</span></div>
    </div>

    <div class="grp-label">导入导出</div>
    <div class="card" style="padding: 2px 14px">
      <div class="menu-line" @click="exportCsv"><span>📤</span>导出资产负债总表 CSV<span class="arr">⬇</span></div>
      <div class="menu-line" @click="exportBackup"><span>💾</span>导出全量备份 JSON<span class="arr">⬇</span></div>
      <div class="menu-line" style="flex-wrap: wrap">
        <span>📥</span>从备份恢复
        <RadioGroup v-model="restoreMode" direction="horizontal" style="margin-left: auto; transform: scale(.9)">
          <Radio name="replace">覆盖</Radio>
          <Radio name="merge">合并</Radio>
        </RadioGroup>
        <label v-if="!OFFLINE" class="restore-btn">
          选择文件<input type="file" accept=".json" style="display: none" @change="onRestoreFile" />
        </label>
        <span v-else class="restore-btn" @click="onRestorePick">选择文件</span>
      </div>
      <div class="menu-line" @click="router.push('/import')"><span>🧾</span>导入钱迹账单<span class="arr">›</span></div>
      <div class="menu-line" @click="exportXlsx"><span>📊</span>导出资产负债总表 Excel(.xlsx)<span class="arr">⬇</span></div>
      <div class="menu-line" @click="router.push('/search')"><span>🔍</span>搜索记录<span class="arr">›</span></div>
      <div class="menu-line" @click="router.push('/recycle')"><span>🗑</span>回收站<span class="arr">›</span></div>
    </div>
    <div v-if="OFFLINE" style="font-size: 10.5px; color: var(--t3); margin: 8px 18px 0; line-height: 1.7">
      📱 离线模式：数据保存在本机应用内。卸载或清除应用数据会丢失，请定期「导出全量备份 JSON」。
    </div>

    <div class="grp-label">外观与提醒</div>
    <div class="card" style="padding: 2px 14px">
      <div class="menu-line">
        <span>🌗</span>深色模式
        <RadioGroup :model-value="ui.theme" direction="horizontal" style="margin-left: auto" @update:model-value="(v: any) => setTheme(v)">
          <Radio name="auto">跟随</Radio>
          <Radio name="light">浅色</Radio>
          <Radio name="dark">深色</Radio>
        </RadioGroup>
      </div>
      <div class="menu-line">
        <span>{{ ui.hideAmounts ? '🙈' : '👁' }}</span>隐藏金额
        <span class="hint-inline">全站金额显示为 ••••••（月报图同步生效）</span>
        <Switch :model-value="ui.hideAmounts" size="20px" style="margin-left: auto" @update:model-value="ui.toggleHideAmounts()" />
      </div>
      <div class="menu-line" style="flex-wrap: wrap">
        <span>🔔</span>平账提醒
        <RadioGroup v-model="reminderOn" direction="horizontal" style="margin-left: auto; transform: scale(.9)" @update:model-value="saveReminderEnabled">
          <Radio name="on">开</Radio>
          <Radio name="off">关</Radio>
        </RadioGroup>
      </div>
      <div class="menu-line" style="flex-wrap: wrap">
        <span>📅</span>每月平账提醒日
        <Field v-model="reminderDay" type="digit" style="width: 70px; margin-left: auto; padding: 4px 8px" />
        <Button size="small" round type="primary" plain style="min-height: 32px" @click="saveReminder">保存</Button>
      </div>
    </div>

    <div class="grp-label">安全</div>
    <div class="card" style="padding: 2px 14px">
      <div class="menu-line" @click="pwdShow = true"><span>🔑</span>修改口令<span class="arr">›</span></div>
      <div class="menu-line" @click="logout"><span>🚪</span>退出登录<span class="arr">›</span></div>
    </div>

    <div style="text-align: center; font-size: 10.5px; color: var(--t3); padding: 18px 0 26px; line-height: 1.8">
      SuijiLedger v0.1.0 · 月度平账版<br>
      每月 1 分钟 · 看清资产负债 · 数据 100% 自有
    </div>

    <!-- 改口令 -->
    <Dialog v-model:show="pwdShow" title="修改口令" :show-confirm-button="false">
      <CellGroup inset style="margin: 8px 0 4px">
        <Field v-model="oldPwd" type="password" label="原口令" />
        <Field v-model="newPwd" type="password" label="新口令" />
        <Field v-model="newPwd2" type="password" label="确认新口令" />
      </CellGroup>
      <div style="display: flex; gap: 10px; padding: 10px 16px 16px">
        <Button block round @click="pwdShow = false">取消</Button>
        <Button type="primary" block round @click="changePwd">保存</Button>
      </div>
    </Dialog>
  </div>
</template>

<style>
.grp-label { font-size: 11.5px; color: var(--t3); padding: 12px 18px 2px; }
.menu-line { display: flex; align-items: center; gap: 10px; padding: 13px 2px; font-size: 13.5px; color: var(--t1); cursor: pointer; min-height: 48px; }
.menu-line + .menu-line { border-top: 1px solid var(--line); }
.menu-line .arr { margin-left: auto; color: var(--t3); }
.menu-line .todo { margin-left: auto; font-size: 10px; color: var(--t3); border: 1px solid var(--line); border-radius: 5px; padding: 1px 6px; }
.menu-line .hint-inline { font-size: 10.5px; color: var(--t3); }
.restore-btn { margin-left: 8px; font-size: 11px; color: var(--brand); background: var(--focus-bg); border-radius: 9px; padding: 8px 12px; cursor: pointer; min-height: 32px; display: inline-flex; align-items: center; }
</style>

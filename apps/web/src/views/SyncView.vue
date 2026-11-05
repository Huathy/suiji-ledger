<script setup lang="ts">
/**
 * 数据同步（Git）设置页
 * 方案：.docs/21_设计方案_M4_Git同步.md
 *  · 状态全部来自 /system/sync/status（不再"已配置 · 待 M4 推送"这种假状态）
 *  · 加密 / 可合并是两个设置项，默认「明文 + 可合并」；开加密前必须确认"合并将不可用"
 */
import { computed, onMounted, ref } from 'vue'
import { NavBar, Field, CellGroup, Button, RadioGroup, Radio, Switch, Loading, showSuccessToast, showToast, showConfirmDialog } from 'vant'
import { api } from '../api/client'
import { useGoBack } from '../utils/nav'
import SyncConflictDialog from '../components/SyncConflictDialog.vue'
// 状态形状不再在本页手抄：`SyncStatus` 唯一家在 packages/shared（原 :27-44 那份已删，
// 字段注释（mode / haltedAt / maxAutoRetries / lastCommitOid 的来历）随类型一起搬到了那里）
import { type SyncStatus } from '../../../../packages/shared/src/index'
import { phaseDot, phaseState, phaseText } from '../utils/syncState'

const goBack = useGoBack()
const remote = ref('')
const branch = ref('main')
const token = ref('')
const tokenMasked = ref('')
const authUser = ref('')
const pushMode = ref('daily')
const encrypt = ref(false)
const mergeEnabled = ref(true)
const autoCommit = ref(true)
const loaded = ref(false)
const saving = ref(false)

const status = ref<SyncStatus | null>(null)
const syncing = ref(false)
const conflictShow = ref(false)

type Commit = { oid: string; message: string; ts: number; networthCents: number | null }
const commits = ref<Commit[]>([])
const historyLoading = ref(false)

onMounted(async () => {
  // 兜底：离线/未登录/网络异常一律降级为"未配置"，不能白屏（§8.2）
  try {
    const s = await api<{ settings: Record<string, string> }>('/system/settings')
    remote.value = s.settings.gitRemote || ''
    branch.value = s.settings.gitBranch || 'main'
    pushMode.value = s.settings.gitPushMode || 'daily'
    encrypt.value = s.settings.gitEncrypt === 'on'
    mergeEnabled.value = s.settings.gitMergeEnabled !== 'off'
    autoCommit.value = s.settings.gitAutoCommit !== 'off' // 修 bug：以前只写不读
    tokenMasked.value = s.settings.gitAuthMasked || ''
    authUser.value = s.settings.gitAuthUser || ''
  } catch {
    /* 离线/未登录：保持空态 */
  }
  loaded.value = true
  await Promise.all([refreshStatus(), loadHistory()])
})

const configured = computed(() => !!remote.value.trim())
// 状态判据、圆点色、标题短文案全部来自 utils/syncState（单一映射表）：
// /status 读不到时按"有没有配远程仓库"兜底成 idle/unconfigured，不白屏（§8.2）
const state = computed(() => phaseState(status.value, configured.value))
const dotClass = computed(() => phaseDot(status.value, configured.value))
const stateLabel = computed(() => phaseText(status.value, configured.value))
const pushModeLabel = computed(() => ({ 'every-commit': '每次提交', daily: '每日 03:00', manual: '手动' }[pushMode.value] || pushMode.value))

function fmtTime(ts: number | null): string {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function refreshStatus() {
  try {
    status.value = await api<SyncStatus>('/system/sync/status')
  } catch {
    status.value = null
  }
}

async function loadHistory() {
  historyLoading.value = true
  try {
    const r = await api<{ commits: Commit[] }>('/system/sync/history?limit=20')
    commits.value = r.commits || []
  } catch {
    commits.value = []
  } finally {
    historyLoading.value = false
  }
}

async function save() {
  saving.value = true
  try {
    await api('/system/settings', {
      method: 'PUT',
      body: {
        settings: {
          gitRemote: remote.value.trim(),
          gitBranch: branch.value.trim() || 'main',
          gitAuthUser: authUser.value.trim(),
          gitPushMode: pushMode.value,
          gitEncrypt: encrypt.value ? 'on' : 'off',
          gitMergeEnabled: encrypt.value ? 'off' : mergeEnabled.value ? 'on' : 'off',
          gitAutoCommit: autoCommit.value ? 'on' : 'off',
          ...(token.value ? { gitAuth: token.value } : {}),
        },
      },
    })
    token.value = ''
    showSuccessToast('同步配置已保存')
    const s = await api<{ settings: Record<string, string> }>('/system/settings')
    tokenMasked.value = s.settings.gitAuthMasked || ''
    mergeEnabled.value = s.settings.gitMergeEnabled !== 'off'
    await refreshStatus()
  } finally {
    saving.value = false
  }
}

/** 开加密前必须把代价说清楚（文案与方案 §7.1 一致） */
async function onEncryptToggle(v: boolean) {
  if (!v) {
    encrypt.value = false
    return
  }
  encrypt.value = false
  try {
    await showConfirmDialog({
      title: '开启加密后，冲突合并将不可用',
      message:
        '两端同时修改同一条记录时，只能整份二选一（以本地为准 / 以远程为准），无法逐字段对照合并。\n\n' +
        '将把明文历史覆盖为密文，建议先备份远端：已推送的明文历史不会追溯加密，如需彻底加密需重建远端仓库。\n\n' +
        '首次开启前请确认两端已放置同一把 git.key，否则互相解不开（会进冲突并提示密钥不匹配）。\n\n仍要开启？',
      confirmButtonText: '仍要开启',
      cancelButtonText: '取消',
    })
    encrypt.value = true
    mergeEnabled.value = false
  } catch {
    encrypt.value = false
  }
}

/**
 * 租约式强推（D9/§6.3 的**前端触发面**，评审修复项：后端实装了但全仓没有调用点，
 * 远端持续前进时用户只能死循环）。必须二次确认；后端再校验租约，不符即拒绝转人工。
 */
async function forcePush() {
  try {
    await showConfirmDialog({
      title: '强制推送（租约保护）',
      message:
        '用本机当前历史覆盖远端分支。仅当远端还停在你上次同步所见的那一版时才会执行；\n' +
        '若远端已被第三方推进，本次强推会被拒绝并转入正常同步逐条裁决。\n\n确认强推？',
      confirmButtonText: '强制推送',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  syncing.value = true
  try {
    const r = await api<{ ok: boolean; reason?: string; message?: string }>('/system/sync/run?force=lease', { method: 'POST' })
    if (r.ok) showSuccessToast('强推完成')
    else showToast(r.message || '强推失败')
  } finally {
    syncing.value = false
    await Promise.all([refreshStatus(), loadHistory()])
  }
}

async function runSync() {
  syncing.value = true
  try {
    const r = await api<{ ok: boolean; reason?: string; message?: string }>('/system/sync/run', { method: 'POST' })
    if (r.ok) showSuccessToast('同步完成')
    else if (r.reason === 'conflict') {
      showToast(r.message || '存在冲突')
      conflictShow.value = true
    } else showToast(r.message || '同步失败')
  } finally {
    syncing.value = false
    await Promise.all([refreshStatus(), loadHistory()])
  }
}

/**
 * 恢复（doc08 §3「点任一版本 → 弹层含差异摘要」，评审修复项：此前直接 confirm+apply，
 * /diff 端点在前端零调用）。先取差异摘要进确认框，确认后才 apply。
 */
async function restore(oid: string) {
  let summaryText = ''
  try {
    const d = await api<{
      summary?: { added: number; removed: number; changed: number }
      added?: string[]
      removed?: string[]
      changed?: string[]
    }>(`/system/sync/diff?oid=${encodeURIComponent(oid)}`)
    const s = d.summary || { added: 0, removed: 0, changed: 0 }
    const brief = (arr?: string[]) => (arr && arr.length ? `（${arr.slice(0, 3).map((n) => n.replace(/\.json$/, '')).join('、')}${arr.length > 3 ? '…' : ''}）` : '')
    // 后端口径：added=当前有、该版本没有（恢复不会删它们）；removed=该版本有、当前没有（会被带回）；changed=两边内容不同（将被该版本覆盖）
    summaryText =
      `该版本会带回 ${s.removed} 条${brief(d.removed)}、覆盖 ${s.changed} 条${brief(d.changed)}；` +
      `本机另有 ${s.added} 条该版本没有的记录（不受影响）。\n\n`
  } catch {
    summaryText = '（差异摘要获取失败，仍可继续恢复）\n\n'
  }
  try {
    await showConfirmDialog({
      title: '恢复到这个版本？',
      message:
        summaryText +
        '会把该版本的记录写回本地库（并生成一条恢复提交），当前数据仍保留在版本历史里，可再恢复回来。',
      confirmButtonText: '恢复',
    })
  } catch {
    return
  }
  const r = await api<{ ok: boolean; push?: { ok?: boolean; reason?: string; message?: string } }>('/system/sync/restore', {
    method: 'POST',
    body: { oid, mode: 'apply' },
  })
  if (r.ok) {
    if (r.push && r.push.ok === false && r.push.reason === 'error') showToast('已恢复到本机，但推送失败：' + (r.push.message || ''))
    else showSuccessToast('已恢复')
    await Promise.all([refreshStatus(), loadHistory()])
  }
}

async function abortConflict() {
  await api('/system/sync/conflict', { method: 'DELETE' })
  showToast('已放弃本次合并')
  await refreshStatus()
}

async function onResolved() {
  await Promise.all([refreshStatus(), loadHistory()])
}
</script>

<template>
  <div>
    <NavBar title="数据同步（Git）" left-arrow left-text="返回" @click-left="goBack('/')" />

    <!-- 状态卡：绿=已同步 黄=待推送/离线/同步中 红=冲突/失败 灰=未配置 -->
    <div class="card status-card">
      <div class="status-line">
        <i class="dot" :class="dotClass"></i>
        <b>{{ stateLabel }}</b>
      </div>
      <div class="status-meta">
        <template v-if="configured">
          远程 {{ remote }} · 分支 {{ branch }}<br>
          上次同步 {{ fmtTime(status?.lastSyncAt ?? null) }} · 待推 {{ status?.pendingCommits ?? 0 }} 条 · 推送策略 {{ pushModeLabel }}<br>
          <!-- §6.1 运行态：冲突时到底能不能逐字段合并，这里说人话（值来自 /status 现算，不是前端自猜） -->
          冲突裁决：{{ status?.mode === 'whole-file' ? '整份二选一（加密已开或合并已关）' : '逐条 / 逐字段合并' }}<br>
          <span v-if="status?.lastError" class="err">{{ status.lastError }}</span>
        </template>
        <template v-else>
          当前数据只存在本机数据库，没有任何异地副本。<br>
          也可先用「我的 → 导出全量备份 JSON」手动备份。
        </template>
      </div>
      <div class="status-acts">
        <Button size="small" round type="primary" :loading="syncing" :disabled="!configured" @click="runSync">立即同步</Button>
        <Button v-if="state === 'conflict'" size="small" round type="danger" plain @click="conflictShow = true">
          裁决冲突（{{ status?.conflictCount || 0 }}）
        </Button>
        <Button v-if="state === 'conflict'" size="small" round plain @click="abortConflict">放弃合并</Button>
        <!-- D9/§6.3 强推的唯一触发面（评审修复项：后端有实装、前端没入口）。
             halted 也放行：凭据修好后用户可能就是要"覆盖远端"，入口不能只给 error/conflict。 -->
        <Button v-if="configured && (state === 'error' || state === 'conflict' || state === 'halted')" size="small" round type="warning" plain :loading="syncing" @click="forcePush">
          强制推送…
        </Button>
      </div>
    </div>

    <!-- 未配置时的三步引导 -->
    <div v-if="loaded && !configured" class="card guide-card">
      <div class="sec-t">三步开启同步</div>
      <div class="guide-step"><b>①</b><span>在 GitHub / Gitee 建一个<b>私有</b>仓库（数据含金额，切勿公开）</span></div>
      <div class="guide-step"><b>②</b><span>在下方填仓库地址与 PAT（只给该仓库 Contents 读写权限）</span></div>
      <div class="guide-step"><b>③</b><span>选推送策略并保存；之后每次平账自动提交</span></div>
    </div>

    <div class="grp-label">远程仓库（必须私有）</div>
    <CellGroup inset v-if="loaded">
      <Field v-model="remote" label="地址" placeholder="https://github.com/you/mr-data.git" />
      <Field v-model="branch" label="分支" placeholder="main" />
      <Field v-model="token" label="凭据" type="password" :placeholder="tokenMasked || 'PAT（仅该仓库最小权限）'" />
    </CellGroup>
    <div class="hint" v-if="configured">凭据加密存在本机（git.key），接口只回脱敏值；换机需重新填写。<br>
      Gitee 会校验「Basic 用户名 = 令牌属主」，填令牌即可，引擎按地址自动选用户名（Gitee/GitLab 用 <code>oauth2</code>，GitHub/Gitea 用 <code>x-access-token</code>）；特殊自建服务可在下方手动指定。</div>

    <div class="grp-label" v-if="configured">凭据用户名（一般留空自动判定）</div>
    <CellGroup inset v-if="loaded && configured">
      <Field v-model="authUser" label="用户名" placeholder="留空 = 按地址自动（Gitee→oauth2）" />
    </CellGroup>

    <div class="grp-label">自动规则</div>
    <div class="card" style="padding: 2px 14px" v-if="loaded">
      <div class="menu-line">
        <span>☁️</span>推送时机
        <RadioGroup v-model="pushMode" direction="horizontal" style="margin-left: auto; transform: scale(.9)">
          <Radio name="every-commit">每次提交</Radio>
          <Radio name="daily">每日 03:00</Radio>
          <Radio name="manual">手动</Radio>
        </RadioGroup>
      </div>
      <div class="menu-line">
        <span>✍️</span>平账后自动提交
        <Switch v-model="autoCommit" size="20px" style="margin-left: auto" />
      </div>
      <div class="menu-line">
        <span>🔒</span>备份加密（AES-256）
        <Switch :model-value="encrypt" size="20px" style="margin-left: auto" @update:model-value="onEncryptToggle" />
      </div>
      <div class="menu-line">
        <span>🔀</span>冲突合并（逐条 / 逐字段对照）
        <Switch v-model="mergeEnabled" size="20px" style="margin-left: auto" :disabled="encrypt" />
      </div>
      <div class="menu-sub">
        {{ encrypt
          ? '加密已开启，合并不可用：双端同改只能整份二选一'
          : mergeEnabled
            ? '无重叠的改动自动合并；同一记录双端同改时进对照界面逐条勾选'
            : '双端同改一律整份二选一（无重叠的改动仍自动合并）' }}
      </div>
    </div>

    <div style="margin: 16px">
      <Button type="primary" round block :loading="saving" @click="save">保存同步配置</Button>
    </div>

    <!-- 版本历史 -->
    <div class="grp-label">版本历史（可恢复）</div>
    <div class="card">
      <div v-if="historyLoading" class="empty-tip" style="padding: 18px 10px"><Loading size="18">读取中…</Loading></div>
      <div v-else-if="commits.length === 0" class="empty-tip" style="padding: 18px 10px">
        还没有任何提交记录。<br>
        <span style="font-size: 11px">每次平账会自动生成一条「chore(data): 平账 YYYY-MM · 净资产 …」提交，任意版本可一键恢复。</span>
      </div>
      <div v-else class="hist">
        <div v-for="c in commits" :key="c.oid" class="hist-row">
          <div class="hist-main">
            <div class="hist-msg">{{ c.message }}</div>
            <div class="hist-meta">{{ fmtTime(c.ts) }} · {{ c.oid.slice(0, 7) }}</div>
          </div>
          <Button size="mini" round plain @click="restore(c.oid)">恢复</Button>
        </div>
      </div>
    </div>

    <div class="empty-tip" style="padding-top: 0">
      隐私约定：备份内容按设置加密，密钥仅存本地数据目录（git.key），不入库不推送。<br>
      冲突处理：无重叠改动自动合并；同一记录双端同改 → 对照界面逐条勾选（电脑端可逐字段）。
    </div>

    <SyncConflictDialog v-model:show="conflictShow" @resolved="onResolved" />
  </div>
</template>

<style>
.grp-label { font-size: 11.5px; color: var(--t3); padding: 12px 18px 2px; }
.menu-line { display: flex; align-items: center; gap: 10px; padding: 12px 2px; font-size: 13.5px; color: var(--t1); }
.menu-line + .menu-line { border-top: 1px solid var(--line); }
.menu-sub { font-size: 11px; color: var(--t3); padding: 0 2px 10px; line-height: 1.6; }
.hint { font-size: 11px; color: var(--t3); padding: 6px 18px 0; line-height: 1.6; }
.status-card .status-line { display: flex; align-items: center; gap: 8px; font-size: 14px; }
.status-card .dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.dot-gray { background: var(--neutral); }
.dot-amber { background: var(--warn); }
.dot-green { background: var(--income); }
.dot-red { background: var(--expense); }
.status-meta { font-size: 11.5px; color: var(--t2); line-height: 1.8; margin-top: 6px; }
.status-meta .err { color: var(--expense); }
.status-acts { display: flex; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
.guide-card { background: var(--focus-bg); }
html.dark .guide-card { background: #1b2436; }
.guide-step { display: flex; gap: 8px; font-size: 12px; color: var(--t2); line-height: 1.9; }
.guide-step b { color: var(--brand); font-weight: 700; }
.hist-row { display: flex; align-items: center; gap: 10px; padding: 10px 2px; }
.hist-row + .hist-row { border-top: 1px solid var(--line); }
.hist-main { flex: 1; min-width: 0; }
.hist-msg { font-size: 12.5px; color: var(--t1); word-break: break-all; }
.hist-meta { font-size: 11px; color: var(--t3); margin-top: 2px; }
</style>

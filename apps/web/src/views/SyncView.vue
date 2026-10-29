<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NavBar, Field, CellGroup, Button, RadioGroup, Radio, Switch, showSuccessToast, showToast } from 'vant'
import { api } from '../api/client'
import { useGoBack } from '../utils/nav'

const goBack = useGoBack()
const remote = ref('')
const branch = ref('main')
const token = ref('')
const pushMode = ref('daily')
const encrypt = ref(false)
const autoCommit = ref(true)
const loaded = ref(false)
const saving = ref(false)
/** 最近一次本地备份时间（来自 /system/health 的备份计数，M4 前作为唯一可见的“版本”线索） */
const lastBackup = ref<string>('')

onMounted(async () => {
  const s = await api<{ settings: Record<string, string> }>('/system/settings')
  remote.value = s.settings.gitRemote || ''
  branch.value = s.settings.gitBranch || 'main'
  pushMode.value = s.settings.gitPushMode || 'daily'
  encrypt.value = s.settings.gitEncrypt === 'on'
  loaded.value = true
})

const configured = computed(() => !!remote.value.trim())
const pushModeLabel = computed(() => ({ 'every-commit': '每次提交', daily: '每日 03:00', manual: '手动' }[pushMode.value] || pushMode.value))

async function save() {
  saving.value = true
  try {
    await api('/system/settings', {
      method: 'PUT',
      body: {
        settings: {
          gitRemote: remote.value.trim(), gitBranch: branch.value.trim() || 'main',
          gitPushMode: pushMode.value, gitEncrypt: encrypt.value ? 'on' : 'off',
          gitAutoCommit: autoCommit.value ? 'on' : 'off',
          ...(token.value ? { gitAuth: token.value } : {}),
        },
      },
    })
    showSuccessToast('同步配置已保存')
  } finally {
    saving.value = false
  }
}
function notReady() {
  showToast('自动 commit / push 引擎将在 M4 交付；现在请先用「我的 → 导出全量备份 JSON」手动备份')
}
</script>

<template>
  <div>
    <NavBar title="数据同步（Git）" left-arrow left-text="返回" @click-left="goBack('/')" />

    <!-- 状态卡（设计稿 v2.1 §3）：M4 引擎未交付，如实显示灰/黄两态，不做假“已同步” -->
    <div class="card status-card">
      <div class="status-line">
        <i class="dot" :class="configured ? 'dot-amber' : 'dot-gray'"></i>
        <b>{{ configured ? '已配置 · 待 M4 推送' : '未配置同步' }}</b>
      </div>
      <div class="status-meta">
        <template v-if="configured">
          远程 {{ remote }} · 分支 {{ branch }}<br>
          推送策略 {{ pushModeLabel }} · 备份加密 {{ encrypt ? '开' : '关' }}
        </template>
        <template v-else>
          当前数据只存在本机数据库，没有任何异地副本。<br>
          M4 前请先手动备份：我的 → 导出全量备份 JSON。
        </template>
      </div>
      <div class="status-acts">
        <Button size="small" round type="primary" plain @click="notReady">立即同步（M4）</Button>
        <Button size="small" round plain @click="goBack('/')">去手动备份</Button>
      </div>
    </div>

    <!-- 未配置时的三步引导（设计稿 §3 空态） -->
    <div v-if="loaded && !configured" class="card guide-card">
      <div class="sec-t">三步开启同步</div>
      <div class="guide-step"><b>①</b><span>在 GitHub 建一个<b>私有</b>仓库（数据含金额，切勿公开）</span></div>
      <div class="guide-step"><b>②</b><span>在下方填仓库地址与 PAT（只给该仓库 Contents 写权限）</span></div>
      <div class="guide-step"><b>③</b><span>选推送策略并保存；M4 上线后自动开始提交</span></div>
    </div>

    <div class="grp-label">远程仓库（建议私有）</div>
    <CellGroup inset v-if="loaded">
      <Field v-model="remote" label="地址" placeholder="https://github.com/you/mr-data.git" />
      <Field v-model="branch" label="分支" placeholder="main" />
      <Field v-model="token" label="凭据" type="password" placeholder="PAT（仅该仓库最小权限）" />
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
        <Switch v-model="encrypt" size="20px" style="margin-left: auto" />
      </div>
    </div>

    <div style="margin: 16px">
      <Button type="primary" round block :loading="saving" @click="save">保存同步配置</Button>
    </div>

    <!-- 版本历史（设计稿 §3）：引擎未交付，如实显示空态而非假列表 -->
    <div class="grp-label">版本历史（可恢复）</div>
    <div class="card">
      <div class="empty-tip" style="padding: 18px 10px">
        还没有任何提交记录。<br>
        <span style="font-size: 11px">M4 上线后，每次平账会自动生成一条「chore(data): 平账 YYYY-MM · 净资产 …」提交，任意版本可一键恢复。</span>
      </div>
    </div>

    <div class="empty-tip" style="padding-top: 0">
      隐私约定：备份 JSON 提交前可选加密，密钥仅存本地数据目录，不入库不推送。<br>
      冲突处理（M4）：推送失败时二选一「以本地为准 / 以远程为准」。
    </div>
  </div>
</template>

<style>
.grp-label { font-size: 11.5px; color: var(--t3); padding: 12px 18px 2px; }
.menu-line { display: flex; align-items: center; gap: 10px; padding: 12px 2px; font-size: 13.5px; color: var(--t1); }
.menu-line + .menu-line { border-top: 1px solid var(--line); }
.status-card .status-line { display: flex; align-items: center; gap: 8px; font-size: 14px; }
.status-card .dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.dot-gray { background: var(--neutral); }
.dot-amber { background: var(--warn); }
.dot-green { background: var(--income); }
.dot-red { background: var(--expense); }
.status-meta { font-size: 11.5px; color: var(--t2); line-height: 1.8; margin-top: 6px; }
.status-acts { display: flex; gap: 10px; margin-top: 10px; }
.guide-card { background: var(--focus-bg); }
html.dark .guide-card { background: #1b2436; }
.guide-step { display: flex; gap: 8px; font-size: 12px; color: var(--t2); line-height: 1.9; }
.guide-step b { color: var(--brand); font-weight: 700; }
</style>

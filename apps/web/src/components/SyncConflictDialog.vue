<script setup lang="ts">
/**
 * 同步冲突对照（.docs/21_设计方案_M4_Git同步.md §5.6）
 *
 * 两个层次：
 *   ① 记录级：整条以哪边为准（两端都做）
 *   ② 字段级：逐字段取哪边（**仅 PC**；小屏勾 4 个字段是折磨）
 * 两种窗口：
 *   · PC（≥1024）：三窗口 本地 / 共同祖先 / 远程，对齐 IDEA Merge 的肌肉记忆
 *   · 移动端：严格两窗口（本地 / 远程），祖先值只出现在"变化"那行文字里
 *
 * 数据来源是后端冲突瞬间抓的三方原文快照（Setting.gitConflictState），
 * 不是前端现算 diff —— 保证界面看到的就是 git 当时看到的那三份内容。
 */
import { computed, reactive, ref, watch } from 'vue'
import { Button, RadioGroup, Radio, Loading, showConfirmDialog, showSuccessToast, showToast } from 'vant'
import { api } from '../api/client'
import { useUiStore } from '../stores/ui'
// 冲突形状只有一个家：packages/shared。本文件以前自抄的 Pick/FieldDiff/ConflictItem 已删——
// 手抄版和后端 `sync.service.ts:34` 的连载字段 `kind` 都对不上（string | null vs RecordKind | null）。
// 下面三个别名只为少改下游 60 行 `FieldDiff`/`Pick` 引用，**类型定义不在这里**。
import {
  effectiveFieldPick,
  lockedFields,
  lockedSideOf,
  type SyncConflictItem,
  type SyncFieldDiff,
  type SyncPick,
} from '../../../../packages/shared/src/index'

type Pick = SyncPick
type FieldDiff = SyncFieldDiff
type ConflictItem = SyncConflictItem

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'update:show', v: boolean): void; (e: 'resolved'): void }>()

const ui = useUiStore()
const loading = ref(false)
const submitting = ref(false)
const items = ref<ConflictItem[]>([])
const mode = ref<'merge' | 'whole-file'>('merge')
/** §5.6.2「已自动合并 N 项」折叠核对区（数据源：冲突瞬间驱动记录的 cleanMerge 文件） */
const autoMerged = ref<string[]>([])
const autoMergedOpen = ref(false)
const picks = reactive<Record<string, Pick>>({})
const fieldPicks = reactive<Record<string, Record<string, Pick>>>({})
const included = reactive<Record<string, boolean>>({})
const cursor = ref(0)

const current = computed(() => items.value[Math.min(cursor.value, Math.max(0, items.value.length - 1))] || null)
const selectedCount = computed(() => items.value.filter((i) => included[i.key]).length)
const isEncryptedMode = computed(() => mode.value === 'whole-file' || items.value.some((i) => i.conflictType === 'encrypted'))

watch(
  () => props.show,
  async (v) => {
    if (!v) return
    await load()
  },
)

async function load() {
  loading.value = true
  try {
    const r = await api<{ items: ConflictItem[]; mode: 'merge' | 'whole-file'; autoMerged?: string[] }>('/system/sync/conflicts')
    items.value = r.items || []
    mode.value = r.mode || 'merge'
    autoMerged.value = r.autoMerged || []
    for (const it of items.value) {
      picks[it.key] = it.recommend || 'local'
      included[it.key] = true
      fieldPicks[it.key] = {}
    }
    cursor.value = 0
  } catch {
    items.value = []
  } finally {
    loading.value = false
  }
}

/** 纯收起界面（不再触发放弃逻辑）：apply 成功后用这个 */
function hide() {
  emit('update:show', false)
}

/**
 * ✕ / ‹ 关闭。
 *  · PC（三窗口）：只收界面——后端冲突快照还在，随时回来接着裁。
 *  · 移动端（两窗口）：§5.6.3 第 4 条「中途退出 = 全部放弃」→ 走 abort（abortMerge + 清快照），
 *    评审修复项：以前只关层不 abort，index 里的 stage 1/2/3 残局一直挂着。
 */
async function close() {
  if (!ui.isDesktop && items.value.length > 0 && !submitting.value) {
    await abort()
    return
  }
  hide()
}

/**
 * 某字段最终取哪边：字段级优先于记录级（§5.6 第 1 条）。
 *
 * 回落链不再自己拼：`effectiveFieldPick` 在 shared 里，且**锁定字段恒取动过那端**
 * （§5.6.2 第 2 条：`changed:'local'|'remote'` 的字段用户根本不该被问）。
 * 这里自己写一条 `fieldPicks || picks || 'local'` 的后果是"整条按钮 pickWhole 清空
 * fieldPicks 之后，锁定字段又冒出记录级默认值"——同一个判据两处实现，早晚分叉。
 */
function effective(item: ConflictItem, field: string): Pick {
  return effectiveFieldPick(picks[item.key] || 'local', field, item.fields, fieldPicks[item.key])
}
function valueOf(item: ConflictItem, f: FieldDiff, side: Pick): string | null {
  return side === 'local' ? f.local : f.remote
}

/**
 * 该字段是否被锁到某一端（仅本地改 / 仅远端改）。
 * 判据只有 shared 的 `lockedSideOf`：一支箭头点不点得动、提交给后端时取哪边，
 * 必须是同一句话，否则就会出"界面锁住了但 payload 仍带反向覆盖"的错觉。
 */
function isFieldLocked(f: FieldDiff): boolean {
  return lockedSideOf(f.changed) !== null
}
/** 结果预览：必须实时，否则用户不知道自己在拼什么；三边一致的字段不占位 */
function preview(item: ConflictItem) {
  return item.fields
    .filter((f) => f.changed !== 'same')
    .map((f) => {
      const side = effective(item, f.name)
      return { label: f.label, value: valueOf(item, f, side), side }
    })
}

/** 字段状态标签：让"到底谁改了什么"一眼可见，避免对着两列相同的值做选择 */
function changeTag(c: FieldDiff['changed']): string {
  return c === 'both' ? '两端都改' : c === 'local' ? '仅本地改' : c === 'remote' ? '仅远端改' : '一致'
}

function pickWhole(item: ConflictItem, side: Pick) {
  picks[item.key] = side
  fieldPicks[item.key] = {}
}
function pickField(item: ConflictItem, field: string, side: Pick) {
  if (!fieldPicks[item.key]) fieldPicks[item.key] = {}
  fieldPicks[item.key][field] = side
}

/**
 * 提交给后端的字段级裁决（§5.6.4：`pick` 定基线，`fieldPicks` 覆盖）。
 *
 * 锁定字段（§5.6.2 第 2 条）：用户手放在这里的任何选择都先剔除，只留共享契约判定的那端——
 * 界面已经置灰时还让一个残留的旧值跟着上飞机，等于把"锁定"做成纯视觉装饰。
 *
 * 为什么不干脆把锁定字段整条丢掉：后端 `composeResolved`（`apps/server/src/sync/ledger.ts`）
 * 是「`pick` 定基线 + `fieldPicks` 覆盖」，缺省字段跟随 `pick`。丢掉之后，一条
 * `changed:'local'` 的字段会在用户整条选"以远程为准"时被远程值抹掉——动过那端的改动白丢，
 * 下次同步再冲突一次。所以锁定字段**必须显式带上锁定侧**，这也是剔除的边界：
 * 剔除的是"用户的选择"，不是"锁定这件事"。
 *
 * 与记录级相同的一律不传（后端覆盖后结果不变，纯噪声），`same` 字段本来就不需要裁决。
 */
function resolvedFieldPicks(item: ConflictItem): Record<string, Pick> {
  const locked = lockedFields(item.fields)
  const base = picks[item.key] || 'local'
  const out: Record<string, Pick> = {}
  for (const f of item.fields) {
    if (f.changed === 'same') continue
    const side = locked[f.name] || fieldPicks[item.key]?.[f.name]
    if (side && side !== base) out[f.name] = side
  }
  return out
}
function selectAllRecommended() {
  for (const it of items.value) {
    pickWhole(it, it.recommend)
    included[it.key] = true
  }
}
function selectAll(side: Pick) {
  for (const it of items.value) {
    pickWhole(it, side)
    included[it.key] = true
  }
}

async function apply() {
  // 移动端语义（doc08 §3.1）：上一条/下一条单条推进——「应用」只提交当前条，
  // 未看过的条目保持冲突态等用户逐条裁决（不拿预选默认值静默定案，D5）。
  // PC 语义：整列勾选批量提交。
  const source = ui.isDesktop
    ? items.value.filter((i) => included[i.key])
    : current.value
      ? [current.value]
      : []
  const payload = source.map((i) => ({
    key: i.key,
    pick: picks[i.key] || 'local',
    // 字段级只在 PC 传；移动端传了后端也会忽略，这里干脆不传。
    // 传的也不是 fieldPicks 原件：锁定字段先归一到动过那端（resolvedFieldPicks），
    // 否则"界面上灰掉的字段仍可能被一个残留选择反向覆盖"。
    fieldPicks: ui.isDesktop && !isEncryptedMode.value ? resolvedFieldPicks(i) : undefined,
  }))
  if (payload.length === 0) {
    showToast('没有勾选任何一条')
    return
  }
  submitting.value = true
  try {
    const r = await api<{
      remaining: number
      applied: number
      pushed?: boolean
      partial?: boolean
      message?: string
      push?: { ok?: boolean; reason?: string; message?: string }
    }>('/system/sync/resolve', {
      method: 'POST',
      body: { items: payload, push: true },
    })
    if (r.remaining > 0) {
      // partial：某条写库中途失败，已成功的部分后端已如实落快照——把原因摊开，别说"已应用"就完事
      showToast(r.message || `已应用 ${r.applied} 项，还剩 ${r.remaining} 项待裁决`)
      await load()
    } else if (r.pushed) {
      // 评审修复项：toast 必须读后端 pushed 真值，不能只看 remaining 就说"已推送"
      showSuccessToast(`已应用 ${r.applied} 项并推送`)
      emit('resolved')
      hide()
    } else if (r.push?.reason === 'conflict') {
      showToast(`已应用 ${r.applied} 项；推送时又遇新冲突，请继续裁决`)
      await load()
    } else {
      // 别再兜一句"稍后自动重试"：halted（凭据/权限被拒）之后不会自动重试，
      // 兜错了用户会干等。理由后端已经定性并拼进 message，原样摊开。
      showToast(`已应用 ${r.applied} 项，但推送未成功：${r.push?.message || r.push?.reason || (r.push?.halted ? '已停止自动重试，请检查配置后手动同步' : '稍后手动同步')}`)
      emit('resolved')
      hide()
    }
  } finally {
    submitting.value = false
  }
}

async function abort() {
  try {
    await showConfirmDialog({
      title: '放弃本次合并？',
      message: '会丢弃这次合并（本地数据一字不动），下次同步会重新拉取并再问一次。',
      confirmButtonText: '放弃合并',
    })
  } catch {
    return
  }
  await api('/system/sync/conflict', { method: 'DELETE' })
  emit('resolved')
  hide()
}
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="cf-overlay">
      <!-- PC：三窗口对照 -->
      <div v-if="ui.isDesktop" class="cf-dialog">
        <div class="cf-head">
          <b>同步冲突 · {{ items.length }} 条待处理</b>
          <span class="cf-sub">{{ isEncryptedMode ? '已关闭逐字段合并，只能整份二选一' : '逐条勾选以哪边为准' }}</span>
          <button class="cf-x" @click="close">✕</button>
        </div>

        <div v-if="loading" class="cf-loading"><Loading size="20">读取冲突快照…</Loading></div>
        <div v-else-if="items.length === 0" class="cf-empty">没有待处理的冲突</div>

        <div v-else class="cf-body">
          <!-- ① 冲突列表 -->
          <div class="cf-list">
            <div
              v-for="(it, i) in items"
              :key="it.key"
              class="cf-row"
              :class="{ active: cursor === i }"
              @click="cursor = i"
            >
              <input v-model="included[it.key]" type="checkbox" @click.stop />
              <div class="cf-row-main">
                <div class="cf-row-title">{{ it.title }}</div>
                <div class="cf-row-meta" :class="{ warn: it.conflictType === 'edit-delete' }">
                  {{ it.conflictType === 'edit-delete' ? '⚠ 一端删 / 一端改' : it.conflictType === 'encrypted' ? '🔒 密文' : it.conflictType === 'unparsable' ? '⚠ 无法解析' : '⚠ 两端都改' }}
                  · 荐:{{ it.recommend === 'local' ? '本地' : '远程' }}
                </div>
              </div>
            </div>

            <!-- §5.6.2：本次合并中被驱动自动处理掉的文件（评审修复项：此前无核对区） -->
            <div v-if="autoMerged.length" class="cf-auto">
              <button class="cf-auto-head" @click="autoMergedOpen = !autoMergedOpen">
                ✓ 已自动合并 {{ autoMerged.length }} 项 {{ autoMergedOpen ? '▲' : '▼' }}
              </button>
              <ul v-if="autoMergedOpen" class="cf-auto-list">
                <li v-for="f in autoMerged" :key="f">{{ f }}</li>
              </ul>
            </div>
          </div>

          <!-- ② 三窗口对照 -->
          <div v-if="current" class="cf-panes">
            <div class="cf-cols">
              <div class="cf-col-head">
                <div class="cf-col">本地（本机）</div>
                <div class="cf-col">共同祖先</div>
                <div class="cf-col">远程</div>
              </div>
              <div
                v-for="f in current.fields"
                :key="f.name"
                class="cf-field"
                :class="{ same: f.changed === 'same', clash: f.changed === 'both', locked: isFieldLocked(f) }"
              >
                <div class="cf-label">
                  {{ f.label }}<i class="cf-tag">{{ changeTag(f.changed) }}<template v-if="isFieldLocked(f)">（锁定）</template></i>
                </div>
                <div class="cf-cells">
                  <div class="cf-cell" :class="{ picked: !isEncryptedMode && f.changed !== 'same' && effective(current, f.name) === 'local' }">
                    <span class="cf-val">{{ f.local ?? '—' }}</span>
                    <button
                      class="cf-arrow"
                      :class="{ on: !isEncryptedMode && f.changed !== 'same' && effective(current, f.name) === 'local' }"
                      :disabled="isEncryptedMode || f.changed === 'same' || isFieldLocked(f)"
                      @click="pickField(current, f.name, 'local')"
                    >◀</button>
                  </div>
                  <div class="cf-cell base"><span class="cf-val">{{ f.base ?? '—' }}</span></div>
                  <div class="cf-cell" :class="{ picked: !isEncryptedMode && f.changed !== 'same' && effective(current, f.name) === 'remote' }">
                    <button
                      class="cf-arrow"
                      :class="{ on: !isEncryptedMode && f.changed !== 'same' && effective(current, f.name) === 'remote' }"
                      :disabled="isEncryptedMode || f.changed === 'same' || isFieldLocked(f)"
                      @click="pickField(current, f.name, 'remote')"
                    >▶</button>
                    <span class="cf-val">{{ f.remote ?? '—' }}</span>
                  </div>
                </div>
              </div>
            </div>

            <div class="cf-whole">
              <span v-if="isEncryptedMode" class="cf-lock">🔒 已加密：只能整份二选一，逐字段裁决不可用</span>
              整条：
              <button class="cf-chip" :class="{ on: picks[current.key] === 'local' }" @click="pickWhole(current, 'local')">以本地为准</button>
              <button class="cf-chip" :class="{ on: picks[current.key] === 'remote' }" @click="pickWhole(current, 'remote')">以远程为准</button>
              <span class="cf-reason">{{ current.reason }}</span>
            </div>

            <div class="cf-preview">
              <div class="cf-preview-t">结果预览</div>
              <div class="cf-preview-body">
                <span v-for="p in preview(current)" :key="p.label" class="cf-pv">
                  <i>{{ p.label }}</i>{{ p.value ?? '—' }}
                  <em>{{ p.side === 'local' ? '本' : '远' }}</em>
                </span>
              </div>
            </div>
          </div>
        </div>

        <div class="cf-foot">
          <div class="cf-foot-left">
            <Button size="small" round plain @click="selectAllRecommended">全选荐项</Button>
            <Button size="small" round plain @click="selectAll('local')">全部用本地</Button>
            <Button size="small" round plain @click="selectAll('remote')">全部用远程</Button>
          </div>
          <div class="cf-foot-right">
            <Button size="small" round plain @click="abort">取消（不同步）</Button>
            <Button size="small" round type="primary" :loading="submitting" @click="apply">应用 {{ selectedCount }} 项并推送</Button>
          </div>
        </div>
      </div>

      <!-- 移动端：严格两窗口 -->
      <div v-else class="cf-sheet">
        <div class="cf-head">
          <button class="cf-x left" @click="close">‹</button>
          <b>同步冲突 {{ items.length ? cursor + 1 : 0 }}/{{ items.length }}</b>
          <span class="cf-sub">两窗口对照</span>
        </div>

        <div v-if="loading" class="cf-loading"><Loading size="20">读取冲突快照…</Loading></div>
        <div v-else-if="!current" class="cf-empty">没有待处理的冲突</div>

        <div v-else class="cf-mbody">
          <div class="cf-mtitle">{{ current.title }}</div>
          <div class="cf-mtag" :class="{ warn: current.conflictType === 'edit-delete' }">
            {{ current.conflictType === 'edit-delete' ? '⚠ 一端删 / 一端改' : current.conflictType === 'encrypted' ? '🔒 已加密，无法逐字段合并' : '⚠ 两端都改' }}
            · 建议取{{ current.recommend === 'local' ? '本地' : '远程' }}
          </div>

          <RadioGroup v-model="picks[current.key]" class="cf-cards">
            <label class="cf-card" :class="{ on: picks[current.key] === 'local' }" @click="picks[current.key] = 'local'">
              <div class="cf-card-t"><Radio name="local" />本地（本机）</div>
              <div v-for="f in current.fields" :key="f.name" class="cf-card-line">
                <span>{{ f.label }}</span><b>{{ f.local ?? '—' }}</b>
              </div>
            </label>
            <label class="cf-card" :class="{ on: picks[current.key] === 'remote' }" @click="picks[current.key] = 'remote'">
              <div class="cf-card-t"><Radio name="remote" />远程</div>
              <div v-for="f in current.fields" :key="f.name" class="cf-card-line">
                <span>{{ f.label }}</span><b>{{ f.remote ?? '—' }}</b>
              </div>
            </label>
          </RadioGroup>

          <div class="cf-mnote">
            变化：<span v-for="f in current.fields.filter((x) => x.changed === 'both')" :key="f.name">{{ f.label }} {{ f.base ?? '—' }}→{{ f.local }}(本) / →{{ f.remote }}(远)；</span>
          </div>
          <div class="cf-mreason">理由：{{ current.reason }}</div>
          <div class="cf-mtip">逐字段合并请在电脑端操作</div>
        </div>

        <div class="cf-mfoot">
          <Button size="small" round plain :disabled="cursor <= 0" @click="cursor--">上一条</Button>
          <Button size="small" round type="primary" :loading="submitting" @click="apply">应用</Button>
          <Button size="small" round plain :disabled="cursor >= items.length - 1" @click="cursor++">下一条</Button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style>
.cf-overlay { position: fixed; inset: 0; z-index: 3000; background: rgba(10, 14, 22, .55); display: flex; align-items: center; justify-content: center; }
.cf-dialog { width: min(1180px, 96vw); height: min(760px, 92vh); background: var(--surface); border-radius: 14px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 24px 60px rgba(0,0,0,.35); }
.cf-sheet { width: 100%; height: 100%; background: var(--surface); display: flex; flex-direction: column; }
.cf-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--line); font-size: 14px; color: var(--t1); }
.cf-head .cf-sub { font-size: 11.5px; color: var(--t3); }
.cf-x { margin-left: auto; border: 0; background: transparent; color: var(--t2); font-size: 16px; cursor: pointer; }
.cf-x.left { margin-left: 0; margin-right: 4px; font-size: 22px; }
.cf-loading, .cf-empty { padding: 40px; text-align: center; color: var(--t3); font-size: 13px; }
.cf-body { flex: 1; display: flex; min-height: 0; }
.cf-list { width: 300px; border-right: 1px solid var(--line); overflow: auto; padding: 6px; }
.cf-row { display: flex; gap: 8px; padding: 9px 8px; border-radius: 8px; cursor: pointer; align-items: flex-start; }
.cf-row:hover { background: var(--focus-bg); }
.cf-row.active { background: var(--focus-bg); box-shadow: inset 2px 0 0 var(--brand); }
.cf-row-title { font-size: 13px; color: var(--t1); }
.cf-row-meta { font-size: 11px; color: var(--t3); margin-top: 2px; }
.cf-row-meta.warn { color: var(--warn); }
.cf-auto { margin: 8px 6px 0; border-top: 1px dashed var(--line); padding-top: 6px; }
.cf-auto-head { border: 0; background: transparent; color: var(--t3); font-size: 11px; cursor: pointer; padding: 2px 4px; }
.cf-auto-head:hover { color: var(--brand); }
.cf-auto-list { margin: 4px 0 0; padding: 0 0 0 18px; max-height: 120px; overflow: auto; font-size: 10.5px; color: var(--t3); line-height: 1.7; word-break: break-all; }
.cf-panes { flex: 1; display: flex; flex-direction: column; min-width: 0; overflow: auto; }
.cf-cols { padding: 10px 14px; }
.cf-col-head, .cf-field { display: flex; align-items: center; gap: 10px; }
.cf-col-head { margin-bottom: 6px; }
.cf-col-head .cf-col { flex: 1; font-size: 11.5px; color: var(--t3); text-align: center; }
.cf-field { padding: 6px 0; border-top: 1px solid var(--line); }
.cf-label { width: 78px; flex-shrink: 0; font-size: 11.5px; color: var(--t3); }
.cf-tag { display: block; margin-top: 2px; font-style: normal; font-size: 9.5px; color: var(--t4, var(--t3)); opacity: .75; }
/* 两端都改 → 需要裁决，整行提亮；三边一致 → 压暗，别让用户以为这里也得选 */
.cf-field.clash .cf-tag { color: var(--brand); opacity: 1; }
.cf-field.same { opacity: .5; }
.cf-field.same .cf-val { color: var(--t3); }
/* 单端改动的字段（§5.6.2 第 2 条）：锁定到动过那端，整行压暗——沿用 same 那档的"灰=不用你选"语义，
   标签文字仍是 changeTag() 的「仅本地改 / 仅远端改」，只补一个"（锁定）"后缀，不另造视觉语言 */
.cf-field.locked { opacity: .8; }
.cf-field.locked .cf-tag { color: var(--t3); }
.cf-cells { flex: 1; display: flex; gap: 8px; align-items: center; }
.cf-cell { flex: 1; display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--line); font-size: 12.5px; color: var(--t1); min-height: 34px; }
.cf-cell.base { color: var(--t3); background: var(--focus-bg); }
.cf-cell.picked { border-color: var(--brand); background: color-mix(in srgb, var(--brand) 10%, transparent); }
.cf-val { flex: 1; word-break: break-all; }
.cf-arrow { border: 1px solid var(--line); background: var(--surface); color: var(--t2); border-radius: 6px; padding: 2px 7px; cursor: pointer; font-size: 11px; }
.cf-arrow.on { border-color: var(--brand); color: var(--brand); }
.cf-arrow:disabled { opacity: .35; cursor: default; }
.cf-whole { padding: 8px 14px; border-top: 1px solid var(--line); font-size: 12px; color: var(--t2); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cf-chip { border: 1px solid var(--line); background: var(--surface); color: var(--t2); border-radius: 12px; padding: 4px 10px; font-size: 11.5px; cursor: pointer; }
.cf-chip.on { border-color: var(--brand); color: var(--brand); }
.cf-reason { color: var(--t3); font-size: 11px; }
.cf-lock { color: var(--brand); font-size: 11.5px; font-weight: 600; }
.cf-preview { margin: 10px 14px 14px; border: 1px dashed var(--line); border-radius: 10px; padding: 10px 12px; }
.cf-preview-t { font-size: 11px; color: var(--t3); margin-bottom: 6px; }
.cf-preview-body { display: flex; flex-wrap: wrap; gap: 14px; font-size: 12.5px; color: var(--t1); }
.cf-pv i { font-style: normal; color: var(--t3); font-size: 11px; margin-right: 4px; }
.cf-pv em { font-style: normal; color: var(--brand); font-size: 10px; margin-left: 3px; }
.cf-foot { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-top: 1px solid var(--line); }
.cf-foot-left, .cf-foot-right { display: flex; gap: 8px; }
.cf-foot-right { margin-left: auto; }
.cf-mbody { flex: 1; overflow: auto; padding: 12px 14px; }
.cf-mtitle { font-size: 15px; color: var(--t1); font-weight: 600; }
.cf-mtag { font-size: 11.5px; color: var(--t3); margin-top: 4px; }
.cf-mtag.warn { color: var(--warn); }
.cf-cards { display: flex; gap: 10px; margin-top: 12px; }
.cf-card { flex: 1; border: 1px solid var(--line); border-radius: 12px; padding: 10px; background: var(--surface); }
.cf-card.on { border-color: var(--brand); background: var(--focus-bg); }
.cf-card-t { display: flex; align-items: center; gap: 4px; font-size: 12.5px; color: var(--t2); margin-bottom: 6px; }
.cf-card-line { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--t1); padding: 3px 0; }
.cf-card-line span { color: var(--t3); }
.cf-mnote, .cf-mreason, .cf-mtip { font-size: 11.5px; color: var(--t2); margin-top: 10px; line-height: 1.7; }
.cf-mtip { color: var(--t3); }
.cf-mfoot { display: flex; gap: 10px; justify-content: space-between; padding: 10px 14px; border-top: 1px solid var(--line); }
</style>

/**
 * 同步状态 → 徽标 / 状态行文案 的唯一映射表（M4 §6 SyncBadge + 「数据同步」页状态卡）
 *
 * 为什么要有这个模块：同一个 `SyncState` 以前在 `components/SyncBadge.vue`（state → label /
 * dot / tip 三段 if 级联）和 `views/SyncView.vue`（dotClass / stateLabel 两份内联映射表）里
 * 各算一遍，加一个状态要改三个地方、且必然漏（v1.2 就漏过 `ok`/`fail` 的 dot 映射，
 * 引擎交付了红/绿两态也永远显示不出来）。
 *
 * 形态约定：纯函数 + 常量表，**无 Vue 依赖**——`.vue` 文件不能被 vitest 直接 import
 * （要过 vue 编译器），所以判据必须住在这种纯 ts 里，`tests/sync-ui-state.test.ts` 才能断言。
 */
import { type SyncState, type SyncStatus } from '../../../../packages/shared/src/index'

/**
 * 徽标的八个视觉态：比后端 `SyncState` 多 `loading`（还没读到）/ `pending`（待推送或离线，
 * 都由后端状态折算出来）/ `fail`（=error，文案口径），比它少 `idle` / `offline` / `error`
 * 三个原始值（它们都投影到上面的视觉态）。
 */
export type SyncBadgeState = 'loading' | 'unconfigured' | 'pending' | 'syncing' | 'conflict' | 'fail' | 'halted' | 'ok'

/** 徽标文案与圆点色（设计稿 v2.1 §6：绿=已同步 · 黄=待推送/同步中 · 红=冲突/失败 · 灰=未配置） */
export const BADGE_COPY: Record<SyncBadgeState, { label: string; dot: string }> = {
  loading: { label: '检测中', dot: 'dot-gray' },
  unconfigured: { label: '未配置同步', dot: 'dot-gray' },
  pending: { label: '待推送', dot: 'dot-amber' },
  syncing: { label: '同步中', dot: 'dot-amber' },
  conflict: { label: '有冲突', dot: 'dot-red' },
  fail: { label: '同步失败', dot: 'dot-red' },
  // halted 与 fail 同色，但文案必须区分：一个还在自动退避重试，一个已经不再重试
  halted: { label: '同步已停手', dot: 'dot-red' },
  ok: { label: '已同步', dot: 'dot-green' },
}

/**
 * 后端状态（+ 本地读失败标志）→ 徽标视觉态。
 *
 * 顺序即优先级，来自 §8.1：读不到 → loading；读失败（离线版/未登录）降级 unconfigured 不白屏；
 * `error`→fail 与 `halted`→halted 必须分开（同色不同文案）；`offline` 与 idle+pending 都是 pending。
 */
export function resolveBadgeState(st: SyncStatus | null, opts: { failed?: boolean } = {}): SyncBadgeState {
  if (opts.failed) return 'unconfigured'
  if (!st) return 'loading'
  switch (st.state) {
    case 'unconfigured':
      return 'unconfigured'
    case 'conflict':
      return 'conflict'
    case 'error':
      return 'fail'
    case 'halted':
      return 'halted'
    case 'offline':
      return 'pending'
    case 'syncing':
      return 'syncing'
    default:
      // idle：有待推送提交才是 pending，否则就是"已同步"
      return (st.pendingCommits || 0) > 0 ? 'pending' : 'ok'
  }
}

/** 「已重试 N 次」的统一样式；上限来自后端的 `maxAutoRetries`，前端不另抄一份数字 */
function retriesText(st: SyncStatus | null): string {
  const r = st?.retries || 0
  if (r <= 0) return ''
  const max = st?.maxAutoRetries
  return max && max > 0 ? `已重试 ${r}/${max} 次` : `已重试 ${r} 次`
}

/**
 * 徽标 `title`（悬停提示）：与 `BADGE_COPY.label` 分开——徽标窄，长解释只能放 title。
 * §6.4：失败/待推送/停手都要带"已重试 N 次"（retries 后端一直有返回，v1.2 之前没进文案）。
 */
export function badgeTip(state: SyncBadgeState, st: SyncStatus | null): string {
  const r = retriesText(st)
  if (state === 'unconfigured') return '尚未配置远程仓库。当前数据只在本机，可先手动导出备份 JSON。'
  if (state === 'conflict') return `有 ${st?.conflictCount || 0} 条冲突待裁决，点击进入对照界面。`
  if (state === 'fail') return `同步失败：${st?.lastError || '未知原因'}${r ? `（${r}，将自动退避重试）` : '（将自动退避重试）'}`
  if (state === 'halted')
    return `已停止自动重试：${st?.lastError || '凭据或权限被服务端拒绝'}${r ? `（${r}）` : ''}\n修正配置后到「数据同步」点「立即同步」恢复。`
  if (state === 'pending') return r ? `有本地改动待推送（${r}，将自动重试）。` : '有本地改动待推送（或当前离线，将自动重试）。'
  return '已与远程仓库同步。'
}

/** `SyncState` → 徽标视觉态（`idle` 的"有待推送"判据在 `badgeOfState` 里单独处理） */
const BADGE_OF_STATE: Record<SyncState, SyncBadgeState> = {
  unconfigured: 'unconfigured',
  idle: 'ok',
  syncing: 'syncing',
  offline: 'pending',
  conflict: 'conflict',
  error: 'fail',
  halted: 'halted',
}

function badgeOfState(state: SyncState, st: SyncStatus | null): SyncBadgeState {
  if (state === 'idle') return (st?.pendingCommits || 0) > 0 ? 'pending' : 'ok'
  return BADGE_OF_STATE[state]
}

/**
 * 「数据同步」页状态卡的原始态：/status 没读到（网络/未登录）时按"有没有配远程仓库"兜底，
 * 不能白屏（§8.2）。这就是 SyncView 里 `status?.state || (configured ? 'idle' : 'unconfigured')`
 * 的同一判据，抽出来让文案与圆点共用一份。
 */
export function phaseState(st: SyncStatus | null, configured = false): SyncState {
  return st?.state ?? (configured ? 'idle' : 'unconfigured')
}

/**
 * 状态卡标题短文案（原 `SyncView.stateLabel`）。
 *
 * 与 `BADGE_COPY.label` 冲突时**以这里为准**：状态卡是整行文字，有地方把计数、重试次数说全
 * （"待推送 3 条""已重试 2 次，自动退避"）；徽标是 11.5px 的胶囊，只能放 4 个字。
 * 所以徽标用 `label`、状态卡用 `phaseText`，两者都不是"另一个真相"，只是同一批字段的两种详略。
 */
export function phaseText(st: SyncStatus | null, configured = false): string {
  const state = phaseState(st, configured)
  const r = (st?.retries || 0) > 0 ? `（已重试 ${st!.retries} 次）` : ''
  switch (state) {
    case 'unconfigured':
      return '未配置同步'
    case 'idle':
      return (st?.pendingCommits || 0) > 0 ? `待推送 ${st!.pendingCommits} 条` : '已同步'
    case 'syncing':
      return '同步中…'
    case 'offline':
      return `离线，稍后自动重试${r}`
    case 'conflict':
      return `有 ${st?.conflictCount || 0} 条冲突待裁决`
    case 'error':
      return `同步失败${(st?.retries || 0) > 0 ? `（已重试 ${st!.retries} 次，自动退避）` : ''}`
    // halted = 后端已停手（永久性失败或重试封顶）。标题只说"停手 + 等手动"，
    // 原因与修法都在下面那行 lastError（后端已把定性结论和处置建议拼好），别在两处算同一个数。
    case 'halted':
      return `已停止自动重试 · 需手动点击${r}`
    default:
      return String(state)
  }
}

/** 状态卡圆点色：与徽标共用 `BADGE_COPY`，不再出现第二份 dot 映射 */
export function phaseDot(st: SyncStatus | null, configured = false): string {
  return BADGE_COPY[badgeOfState(phaseState(st, configured), st)].dot
}

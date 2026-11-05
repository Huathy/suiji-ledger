// M4 同步 UI 状态层单测：状态映射表（syncState.ts）+ 字段锁定判据（shared 契约）
//
// 只 import 纯 ts。`apps/web/src/components/*.vue` 一律不进来——vitest 直接吃 `.vue`
// 要过 vue 编译器，而这里要测的判据本来就被抽到 `apps/web/src/utils/syncState.ts` 里了。
import { describe, it, expect } from 'vitest'
import {
  effectiveFieldPick,
  lockedFields,
  lockedSideOf,
  type SyncFieldDiff,
  type SyncStatus,
} from '../packages/shared/src/index'
import {
  BADGE_COPY,
  badgeTip,
  phaseDot,
  phaseText,
  resolveBadgeState,
  type SyncBadgeState,
} from '../apps/web/src/utils/syncState'

/** 一份"全字段都有值"的 /system/sync/status 响应；用例只覆盖自己关心的几个字段 */
function status(patch: Partial<SyncStatus> = {}): SyncStatus {
  return {
    state: 'idle',
    pendingCommits: 0,
    lastSyncAt: null,
    lastError: null,
    conflictCount: 0,
    pushMode: 'daily',
    mergeEnabled: true,
    encrypt: false,
    retries: 0,
    nextRetryAt: null,
    ...patch,
  }
}

/** 四种 `changed` 各一条：锁定判据（仅单端改动）与需要人判（both）必须能分开 */
const FIELDS: SyncFieldDiff[] = [
  { name: 'amount', label: '金额', base: '100', local: '120', remote: '100', changed: 'local' },
  { name: 'note', label: '备注', base: '旧', local: '旧', remote: '新', changed: 'remote' },
  { name: 'day', label: '日期', base: '1', local: '2', remote: '3', changed: 'both' },
  { name: 'typeName', label: '类型', base: 'a', local: 'a', remote: 'a', changed: 'same' },
]

describe('resolveBadgeState：后端状态 → 徽标视觉态', () => {
  it('还没读到 → loading；读失败降级 unconfigured（不白屏，不是 fail）', () => {
    expect(resolveBadgeState(null)).toBe('loading')
    expect(resolveBadgeState(null, { failed: true })).toBe('unconfigured')
    expect(resolveBadgeState(status({ state: 'idle' }), { failed: true })).toBe('unconfigured')
  })

  it('unconfigured / conflict / syncing 各自投影到同名视觉态', () => {
    expect(resolveBadgeState(status({ state: 'unconfigured' }))).toBe('unconfigured')
    expect(resolveBadgeState(status({ state: 'conflict', conflictCount: 2 }))).toBe('conflict')
    expect(resolveBadgeState(status({ state: 'syncing' }))).toBe('syncing')
  })

  it('error → fail，halted → halted：同色但绝不能合并成一个态', () => {
    expect(resolveBadgeState(status({ state: 'error', retries: 1 }))).toBe('fail')
    expect(resolveBadgeState(status({ state: 'halted', retries: 3, maxAutoRetries: 3 }))).toBe('halted')
    expect(BADGE_COPY.fail.dot).toBe(BADGE_COPY.halted.dot) // 同色
    expect(BADGE_COPY.fail.label).not.toBe(BADGE_COPY.halted.label) // 不同文案
  })

  it('offline → pending（离线与待推送在徽标上是同一个视觉态）', () => {
    expect(resolveBadgeState(status({ state: 'offline', nextRetryAt: 1 }))).toBe('pending')
  })

  it('idle：有待推送提交 → pending，没有则 ok', () => {
    expect(resolveBadgeState(status({ state: 'idle', pendingCommits: 0 }))).toBe('ok')
    expect(resolveBadgeState(status({ state: 'idle', pendingCommits: 3 }))).toBe('pending')
  })

  it('八个视觉态都有文案与圆点色（新增态漏映射会在这里炸）', () => {
    const all: SyncBadgeState[] = ['loading', 'unconfigured', 'pending', 'syncing', 'conflict', 'fail', 'halted', 'ok']
    for (const s of all) {
      expect(BADGE_COPY[s].label.length).toBeGreaterThan(0)
      expect(BADGE_COPY[s].dot).toMatch(/^dot-(green|amber|red|gray)$/)
    }
  })
})

describe('badgeTip：halted 与 fail 的文案必须能区分，且都带重试信息', () => {
  it('fail = 还会自动退避重试；halted = 后端已停手、要人点「立即同步」', () => {
    const st = status({ state: 'error', retries: 2, maxAutoRetries: 3, lastError: '推送被拒' })
    const failTip = badgeTip('fail', st)
    const haltedTip = badgeTip('halted', status({ state: 'halted', retries: 3, maxAutoRetries: 3, lastError: '推送被拒' }))
    expect(failTip).not.toBe(haltedTip)
    expect(failTip).toContain('已重试 2/3 次')
    expect(failTip).toContain('自动退避')
    expect(haltedTip).toContain('已重试 3/3 次')
    expect(haltedTip).toContain('已停止自动重试')
    expect(haltedTip).toContain('修正配置后')
    expect(haltedTip).not.toContain('自动退避')
  })

  it('重试次数为 0 时不硬塞"已重试 0 次"；conflict 带条数、pending 带重试', () => {
    expect(badgeTip('fail', status({ state: 'error', retries: 0, lastError: '断网' }))).not.toContain('已重试 0')
    expect(badgeTip('conflict', status({ state: 'conflict', conflictCount: 4 }))).toContain('4 条冲突')
    expect(badgeTip('pending', status({ state: 'offline', retries: 1 }))).toContain('已重试 1 次')
  })
})

describe('字段锁定（§5.6.2 第 2 条）：单端改动的字段锁定到动过那端', () => {
  it('lockedSideOf 只认 local / remote，both 与 same 不锁', () => {
    expect(lockedSideOf('local')).toBe('local')
    expect(lockedSideOf('remote')).toBe('remote')
    expect(lockedSideOf('both')).toBeNull()
    expect(lockedSideOf('same')).toBeNull()
  })

  it('lockedFields 只收单端改动字段（same 与 both 都不进）', () => {
    expect(lockedFields(FIELDS)).toEqual({ amount: 'local', note: 'remote' })
    expect(lockedFields([])).toEqual({})
  })

  it('effectiveFieldPick：锁定字段无论记录级/字段级怎么选，都取动过那端', () => {
    // 正是不变量：整条选"以远程为准"，`changed:'local'` 的 amount 仍必须取本地值
    expect(effectiveFieldPick('remote', 'amount', FIELDS)).toBe('local')
    expect(effectiveFieldPick('local', 'note', FIELDS)).toBe('remote')
    // 连残留的字段级手选也压不住锁定
    expect(effectiveFieldPick('remote', 'amount', FIELDS, { amount: 'remote' })).toBe('local')
    expect(effectiveFieldPick('local', 'note', FIELDS, { note: 'local' })).toBe('remote')
  })

  it('未锁定字段：字段级覆盖记录级，没有字段级则跟随记录级', () => {
    expect(effectiveFieldPick('local', 'day', FIELDS)).toBe('local')
    expect(effectiveFieldPick('remote', 'day', FIELDS)).toBe('remote')
    expect(effectiveFieldPick('local', 'day', FIELDS, { day: 'remote' })).toBe('remote')
  })
})

describe('phaseText / phaseDot：状态卡与徽标共用同一批字段', () => {
  it('/status 读不到时按"有没有配远程仓库"兜底', () => {
    expect(phaseText(null, false)).toBe('未配置同步')
    expect(phaseText(null, true)).toBe('已同步')
    expect(phaseDot(null, false)).toBe(BADGE_COPY.unconfigured.dot)
    expect(phaseDot(null, true)).toBe(BADGE_COPY.ok.dot)
  })

  it('状态卡说得比徽标细：待推送条数与重试次数都写全', () => {
    expect(phaseText(status({ state: 'idle', pendingCommits: 3 }))).toBe('待推送 3 条')
    expect(phaseText(status({ state: 'error', retries: 2 }))).toContain('已重试 2 次，自动退避')
    expect(phaseText(status({ state: 'halted', retries: 3 }))).toContain('已停止自动重试')
    expect(phaseDot(status({ state: 'conflict' }))).toBe('dot-red')
  })
})

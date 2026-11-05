/**
 * git-engine 的两个"必须被测试钉死"的判据（R3 同款要求）：
 *  ① statusMatrix 的 stage 号只在第 4 列 —— 旧实现把第 3 列（WORKDIR 权限位）也当 stage 判，
 *     正常可执行文件（WORKDIR=3）会被误判成"合并残局"，每次同步白做一轮 abortMerge+重投影。
 *  ② run() 的抢门必须是同步的 —— 检查与置位之间一旦有 await，
 *     两个并发 run() 会双双进主体并发改同一个 .git（互踩）。
 */
import { describe, it, expect, vi } from 'vitest'
import { hasStage3 } from '../apps/server/src/sync/git-engine'
import { SyncService } from '../apps/server/src/sync/sync.service'

describe('hasStage3 · statusMatrix 列语义', () => {
  const R = (f: string, head: number, workdir: number, stage: number) => [f, head, workdir, stage]

  it('只有第 4 列为 3 才算未决合并', () => {
    expect(hasStage3([R('ledger/v1/entries/e_a.json', 0, 0, 3)])).toBe(true)
    // 混杂矩阵：WORKDIR=3 的行不算，真正的 stage 3 行才算
    expect(hasStage3([R('a', 1, 3, 0), R('b', 0, 0, 3)])).toBe(true)
  })

  it('可执行文件的 WORKDIR=3 不是 stage 3（旧实现的误判点）', () => {
    expect(hasStage3([R('script.sh', 3, 3, 0)])).toBe(false)
    expect(hasStage3([R('e_a.json', 1, 3, 0), R('meta.json', 1, 1, 0)])).toBe(false)
  })

  it('空矩阵 / stage 1/2 单独存在都不算（裁决中途的合法中间态由快照承载）', () => {
    expect(hasStage3([])).toBe(false)
    expect(hasStage3([R('a', 0, 0, 1), R('a', 0, 0, 2)])).toBe(false)
  })
})

describe('run() 抢门同步化（并发互踩防护）', () => {
  /** 慢 cfg：每个读设置都让出宏任务 —— 旧实现在 running 检查与置位之间有这类 await */
  const slowCfg: any = {
    remote: vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5))
      return ''
    }),
    conflictState: vi.fn(async () => null),
    state: vi.fn(async () => ({ state: 'idle', lastSyncAt: null, lastError: null, pendingCommits: 0, retries: 0, nextRetryAt: null, lastCommitOid: null })),
    setState: vi.fn(async () => undefined),
    pushMode: vi.fn(async () => 'manual'),
    mergeEnabled: vi.fn(async () => true),
    encrypt: vi.fn(async () => false),
  }

  function mk() {
    return new SyncService({} as any, { recomputeAuto: vi.fn() } as any, { onSnapshot: vi.fn() } as any, { deviceId: vi.fn(async () => 'd_a') } as any, slowCfg, {} as any, {} as any)
  }

  it('并发两次 run：第二个必须同步拿到 busy，不得进入主体', async () => {
    const svc = mk()
    const spy = vi.spyOn(svc as any, 'runInner')
    const [a, b] = await Promise.all([svc.run({ reason: 'A' }), svc.run({ reason: 'B' })])
    expect(spy).toHaveBeenCalledTimes(1)
    const results = [a, b].map((r: any) => r.reason)
    expect(results).toContain('busy')
    expect(results).toContain('unconfigured') // 配置为空的那个走正常早退
    expect(a.ok).toBe(false)
    expect(b.ok).toBe(false)
  })
})

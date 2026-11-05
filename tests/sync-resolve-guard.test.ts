/**
 * 冲突裁决的**整批预校验**（评审修复项 Spec(c)1）：
 * 任何一项不合格（重复 key / 非法方向 / whole-file 带字段覆盖 / 选了远程但远程不可解析）
 * 必须在**第一次写库之前**抛出——旧实现循环中途 throw 400 时，前面已 apply 的项留在库里，
 * 界面显示整批失败，重试还会二次 apply（rev 双顶、回收站双份）。
 *
 * 这里不起 Nest，直接 new SyncService 塞鸭子类型依赖：resolve → gate → resolveInner
 * 在预校验阶段返回，全部下游写通道（apply/project/prisma）都应当**零调用**。
 */
import { describe, it, expect, vi } from 'vitest'
import { SyncService } from '../apps/server/src/sync/sync.service'
import { canonicalRecord, type LedgerRecord } from '../apps/server/src/sync/ledger'

const rec = (uid: string, amount: number, rev = 3): LedgerRecord => ({
  uid, kind: 'entry', ym: '2026-10', typeUid: 't-1', amountCents: amount, note: null,
  accountUid: null, auto: false, rev, updatedAt: 100, deleted: false, origin: 'd_a',
})

function mkItem(fileName: string, localText: string | null, remoteText: string | null) {
  return {
    key: `ledger/v1/entries/${fileName}`,
    fileName,
    kind: 'entry',
    title: fileName,
    conflictType: 'both',
    base: null,
    local: localText,
    remote: remoteText,
    fields: [],
    recommend: 'local',
    reason: '',
  }
}

function mkState(items: any[], mode: 'merge' | 'whole-file' = 'merge') {
  return { at: 1, mode, oursOid: null, theirsOid: null, items, errorData: null }
}

function makeService(items: any[], mode: 'merge' | 'whole-file' = 'merge') {
  const prisma: any = {
    // pick=remote 会先走 recycleBeforeOverwrite → 按 uid 查本机现状行
    changeEntry: { findUnique: vi.fn(async () => ({ id: 7, uid: 'a', ym: '2026-10', typeId: 1, amount: 100, note: null, accountId: null, auto: false, rev: 3, deleted: false })) },
    loan: { findUnique: vi.fn(async () => null) },
    account: { findUnique: vi.fn(async () => null) },
    monthlySnapshot: { findUnique: vi.fn(async () => null) },
    recordType: { findUnique: vi.fn(async () => null) },
    deletedItem: { create: vi.fn(async () => undefined) },
  }
  const cfg = {
    conflictState: vi.fn(async () => mkState(items, mode)),    setConflictState: vi.fn(async () => undefined),
    setState: vi.fn(async () => undefined),
    state: vi.fn(async () => ({ state: 'conflict', lastSyncAt: null, lastError: null, pendingCommits: 0, retries: 0, nextRetryAt: null, lastCommitOid: null })),
    remote: vi.fn(async () => ''),
    branch: vi.fn(async () => 'main'),
    lastRemoteOid: vi.fn(async () => ''),
    setLastRemoteOid: vi.fn(async () => undefined),
  }
  const apply = { apply: vi.fn(async () => ({ applied: true })) }
  const project = { engine: vi.fn(), writeAll: vi.fn(), commitAll: vi.fn(), commitMerge: vi.fn(), buildFiles: vi.fn() }
  const svc: any = new SyncService(
    prisma,
    { recomputeAuto: vi.fn(async () => undefined) } as any,
    { snapshot: vi.fn(async () => undefined), onSnapshot: vi.fn() } as any,
    { deviceId: vi.fn(async () => 'd_a'), noteSeen: vi.fn(async () => undefined), bump: vi.fn(async () => ({})) } as any,
    cfg as any,
    project as any,
    apply as any,
  )
  return { svc, cfg, apply, project }
}

const good = canonicalRecord(rec('a', 100))
const goodRemote = canonicalRecord(rec('a', 200, 4))

describe('resolve 整批预校验（半批写入防护）', () => {
  it('批次里混入"远程不可解析却选了远程" → 400 且下游零写入（前面的项也不许 apply）', async () => {
    const items = [mkItem('e_a.json', good, goodRemote), mkItem('e_b.json', canonicalRecord(rec('b', 1)), 'not-json-at-all')]
    const { svc, apply, cfg, project } = makeService(items)
    await expect(
      svc.resolve([
        { key: items[0].key, pick: 'local' },
        { key: items[1].key, pick: 'remote' },
      ]),
    ).rejects.toThrow(/不能以远程为准/)
    expect(apply.apply).not.toHaveBeenCalled()
    expect(project.writeAll).not.toHaveBeenCalled()
    expect(cfg.setConflictState).not.toHaveBeenCalled()
  })

  it('非法 pick 方向同样整批拒绝，不落任何一项', async () => {
    const items = [mkItem('e_a.json', good, goodRemote)]
    const { svc, apply } = makeService(items)
    await expect(svc.resolve([{ key: items[0].key, pick: 'ours' as any }])).rejects.toThrow(/裁决方向不合法/)
    expect(apply.apply).not.toHaveBeenCalled()
  })

  it('同一记录重复提交 → 拒绝（防重试时二次 apply）', async () => {
    const items = [mkItem('e_a.json', good, goodRemote)]
    const { svc, apply } = makeService(items)
    await expect(
      svc.resolve([
        { key: items[0].key, pick: 'local' },
        { key: items[0].fileName, pick: 'local' }, // byFile 会命中同一条
      ]),
    ).rejects.toThrow(/重复提交/)
    expect(apply.apply).not.toHaveBeenCalled()
  })

  it('whole-file 模式带字段覆盖 → 拒绝且零写入', async () => {
    const items = [mkItem('e_a.json', good, goodRemote)]
    const { svc, apply } = makeService(items, 'whole-file')
    await expect(svc.resolve([{ key: items[0].key, pick: 'remote', fieldPicks: { amountCents: 'remote' } }], false)).rejects.toThrow(
      /不接受逐字段裁决/,
    )
    expect(apply.apply).not.toHaveBeenCalled()
  })

  it('合法批次正常走完：两项都预校验通过后才逐条 apply', async () => {
    const items = [mkItem('e_a.json', good, goodRemote), mkItem('e_b.json', canonicalRecord(rec('b', 1)), canonicalRecord(rec('b', 2, 4)))]
    const { svc, apply, project } = makeService(items)
    // 门内收尾需要引擎与投影通道：给最小可用的假引擎（head 有值、abortMerge 无操作）
    project.engine = (() =>
      Promise.resolve({
        abortMerge: async () => undefined,
        headOid: async () => 'aaaa'.repeat(10),
        setRemote: async () => undefined,
        push: async () => ({ ok: true }),
        remoteOid: async () => 'aaaa'.repeat(10),
      })) as any
    project.writeAll = (async () => ({ files: 0, written: [] })) as any
    project.commitMerge = (async () => 'bbbb'.repeat(10)) as any
    const r = await svc.resolve(
      [
        { key: items[0].key, pick: 'remote' },
        { key: items[1].key, pick: 'local' },
      ],
      false, // 不推送，聚焦预校验→落地顺序
    )
    expect(r.ok).toBe(true)
    expect(apply.apply).toHaveBeenCalledTimes(2)
  })
})

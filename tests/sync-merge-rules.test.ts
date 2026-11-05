// 合并裁决簇的回归用例（M4 第二轮双轴评审修复项）
//
// 守的三件事：
//  1. 预选 tie-break 必须**确定性且对称**：两台设备把两端视角反过来，也得选出同一份内容
//     （否则用户各按各的默认点下去，永远收敛不到同一份数据，§5.3 第 4 条）。
//  2. 非载体文件不许进冲突界面（进不去就裁不掉，勾选被静默丢弃 = c5）。
//  3. 不静默降级（R14）：值没变别写库；类型回退/账户缺失必须带 warning 报上去。
import { describe, it, expect, vi } from 'vitest'
import {
  canonicalRecord,
  composeResolved,
  diffFields,
  fileNameOf,
  recommendPick,
  tieBreakPick,
  type LedgerRecord,
  type Pick,
} from '../apps/server/src/sync/ledger'
import { makeLedgerDriver, type CapturedTriple } from '../apps/server/src/sync/merge-driver'
import { ApplyRecordService, type ApplyOutcome } from '../apps/server/src/sync/apply-record.service'

const entry = (over: Partial<LedgerRecord> = {}): LedgerRecord => ({
  uid: 'e-1',
  kind: 'entry',
  ym: '2026-10',
  typeUid: 't-1',
  amountCents: 1400000,
  note: '工资',
  accountUid: null,
  auto: false,
  rev: 1,
  updatedAt: 100,
  deleted: false,
  origin: '',
  ...over,
})

const setting = (over: Partial<LedgerRecord> = {}): LedgerRecord => ({
  uid: 'set_theme',
  kind: 'setting',
  key: 'theme',
  value: 'dark',
  rev: 1,
  updatedAt: 100,
  deleted: false,
  origin: '',
  ...over,
})

/** 某次裁决落到库里的那份内容（按 pick 取 baseline，不看 rev/origin 这些元数据） */
const contentOfPick = (local: LedgerRecord, remote: LedgerRecord, pick: Pick): string =>
  canonicalRecord(pick === 'local' ? local : remote)

describe('预选 tie-break 确定性（§5.3 第 4 条）', () => {
  it('origin 双边非空且不等 → 字典序大者胜（d_b 胜 d_a）', () => {
    expect(tieBreakPick('d_a', 'd_b')).toBe('remote')
    expect(tieBreakPick('d_b', 'd_a')).toBe('local')
  })

  it('origin 双空 + 内容不同 → 同一输入两次调用结果相同（不许有随机兜底）', () => {
    const a = entry({ note: '工资' })
    const b = entry({ note: '奖金' })
    const p1 = recommendPick(null, a, b).pick
    expect(recommendPick(null, a, b).pick).toBe(p1)
    // 记录对象与 canonical 文本两条入口必须得出同一个指纹结论（两个调用点不能各自为政）
    expect(tieBreakPick('', '', { local: a, remote: b })).toBe(p1)
    expect(tieBreakPick('', '', { local: canonicalRecord(a), remote: canonicalRecord(b) })).toBe(p1)
  })

  it('视角反转收敛：两端对调后选中的是同一份内容（这是防回归的关键断言）', () => {
    const a = entry({ note: '工资' })
    const b = entry({ note: '奖金' })
    const p1 = recommendPick(null, a, b).pick
    const p2 = recommendPick(null, b, a).pick
    expect(p2).toBe(p1 === 'local' ? 'remote' : 'local')
    expect(contentOfPick(b, a, p2)).toBe(contentOfPick(a, b, p1))
  })

  it('origin 两边相等（同一设备重放）也落到内容指纹，而不是恒取 local', () => {
    const a = entry({ note: '工资', origin: 'd_a' })
    const b = entry({ note: '奖金', origin: 'd_a' })
    const p1 = recommendPick(null, a, b).pick
    expect(recommendPick(null, b, a).pick).toBe(p1 === 'local' ? 'remote' : 'local')
    // 内容相同时固定 local（兜底级，只保证确定性，不产生分歧）
    const same = entry({ note: '工资' })
    expect(tieBreakPick('d_a', 'd_a', { local: same, remote: { ...same } })).toBe('local')
  })

  it('前三级（墓碑 / rev / 更新时间）仍优先于 tie-break', () => {
    expect(recommendPick(null, entry({ deleted: true }), entry({ deleted: false })).pick).toBe('local')
    expect(recommendPick(null, entry({ rev: 3 }), entry({ rev: 1 })).pick).toBe('local')
    expect(recommendPick(null, entry({ rev: 1, updatedAt: 50 }), entry({ rev: 1, updatedAt: 200 })).pick).toBe('remote')
  })
})

describe('merge-driver 只把载体文件当冲突（c5）', () => {
  const drive = (captured: CapturedTriple[], autoMerged?: string[]) =>
    makeLedgerDriver({ captured, autoMerged, mergeEnabled: true, encrypted: false, deviceId: 'd_a', now: () => 1000 })

  it('非载体文件（.gitignore）→ 取 ours + cleanMerge，且不落 captured / autoMerged', () => {
    const captured: CapturedTriple[] = []
    const autoMerged: string[] = []
    const out = drive(captured, autoMerged)({
      path: 'ledger/v1/.gitignore',
      contents: ['# base\n', '# ours\n', '# theirs\n'],
    })
    expect(out.cleanMerge).toBe(true)
    expect(out.mergedText).toBe('# ours\n')
    expect(captured).toHaveLength(0)
    expect(autoMerged).toHaveLength(0)
  })

  it('meta.json 仍取 ours（投影指纹没有合并语义）', () => {
    const captured: CapturedTriple[] = []
    const out = drive(captured)({ path: 'ledger/v1/meta.json', contents: ['{}', '{"a":1}', '{"a":2}'] })
    expect(out.cleanMerge).toBe(true)
    expect(out.mergedText).toBe('{"a":1}')
    expect(captured).toHaveLength(0)
  })

  it('载体记录真冲突时照旧落 captured（别把上面那条扩过头）', () => {
    const captured: CapturedTriple[] = []
    const ours = canonicalRecord(entry({ note: '工资' }))
    const theirs = canonicalRecord(entry({ note: '奖金', rev: 2 }))
    const out = drive(captured)({
      path: `ledger/v1/entries/${fileNameOf(entry())}`,
      contents: [canonicalRecord(entry({ note: '原始' })), ours, theirs],
    })
    expect(out.cleanMerge).toBe(false)
    expect(captured).toHaveLength(1)
    expect(captured[0].fileName).toBe('e_e-1.json')
  })

  it('两端内容一致 → 自动合并，也不落 captured', () => {
    const captured: CapturedTriple[] = []
    const same = canonicalRecord(entry({note: '工资' }))
    const out = drive(captured)({ path: `ledger/v1/entries/${fileNameOf(entry())}`, contents: [same, same, same] })
    expect(out.cleanMerge).toBe(true)
    expect(captured).toHaveLength(0)
  })
})

describe('applySetting 不写无变更的库（R14）', () => {
  const stub = (local: { key: string; value: string } | null) => {
    const update = vi.fn(async () => ({}))
    const create = vi.fn(async () => ({}))
    const noteSeen = vi.fn(async () => {})
    const prisma = { setting: { findUnique: vi.fn(async () => local), update, create } }
    return { svc: new ApplyRecordService(prisma as any, { noteSeen } as any), update, create, noteSeen }
  }

  it('值相同 → skipped:identical，update 调用 0 次、不进水位', async () => {
    const { svc, update, create, noteSeen } = stub({ key: 'theme', value: 'dark' })
    const out = await svc.apply(setting())
    expect(out).toEqual({ applied: false, reason: 'skipped:identical' })
    expect(update).toHaveBeenCalledTimes(0)
    expect(create).toHaveBeenCalledTimes(0)
    expect(noteSeen).toHaveBeenCalledTimes(0)
  })

  it('值不同 → update 一次，applied', async () => {
    const { svc, update } = stub({ key: 'theme', value: 'light' })
    const out = await svc.apply(setting({ value: 'dark' }))
    expect(out.applied).toBe(true)
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('本机没有这个键 → create 一次', async () => {
    const { svc, create, update } = stub(null)
    const out = await svc.apply(setting())
    expect(out.applied).toBe(true)
    expect(create).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledTimes(0)
  })

  it('白名单外的键 / 墓碑 → skipped:*，一个库操作都不做', async () => {
    const { svc, update, create } = stub({ key: 'theme', value: 'dark' })
    expect(await svc.apply(setting({ key: 'gitRemote', value: 'x' }))).toEqual({
      applied: false,
      reason: 'skipped:not-whitelisted',
    })
    expect(await svc.apply(setting({ deleted: true }))).toEqual({ applied: false, reason: 'skipped:setting-tombstone' })
    expect(update).toHaveBeenCalledTimes(0)
    expect(create).toHaveBeenCalledTimes(0)
  })
})

describe('applyEntry / applySnapshot 不静默降级（R14）', () => {
  const stub = (o: {
    type?: any
    builtin?: any
    account?: any
    entryRow?: any
    snapshotRow?: any
  } = {}) => {
    const created: any[] = []
    const updated: any[] = []
    const noteSeen = vi.fn(async () => {})
    const prisma = {
      recordType: { findUnique: vi.fn(async () => o.type ?? null), findFirst: vi.fn(async () => o.builtin ?? null) },
      account: { findUnique: vi.fn(async () => o.account ?? null) },
      changeEntry: {
        findUnique: vi.fn(async () => o.entryRow ?? null),
        create: vi.fn(async (a: any) => (created.push(a), {})),
        update: vi.fn(async (a: any) => (updated.push(a), {})),
      },
      monthlySnapshot: {
        findUnique: vi.fn(async () => o.snapshotRow ?? null),
        create: vi.fn(async () => ({})),
        update: vi.fn(async () => ({})),
      },
    }
    return { svc: new ApplyRecordService(prisma as any, { noteSeen } as any), created, updated, noteSeen, prisma }
  }

  it('类型本机不存在 → 回退内置类型，applied 且带 warning（写进去了但要告诉用户）', async () => {
    const { svc, created } = stub({ builtin: { id: 1, name: '餐饮' } })
    const out: ApplyOutcome = await svc.apply(entry({ typeUid: 't-不存在' }))
    expect(out.applied).toBe(true)
    expect(out.warning).toContain('已回退为内置类型 餐饮')
    expect(created).toHaveLength(1)
  })

  it('连内置类型都没有 → failed:type-missing + warning，且不顶水位', async () => {
    const { svc, noteSeen } = stub({ builtin: null })
    const out = await svc.apply(entry({ typeUid: 't-不存在' }))
    expect(out.applied).toBe(false)
    expect(out.reason).toBe('failed:type-missing')
    expect(out.warning).toBeTruthy()
    expect(noteSeen).toHaveBeenCalledTimes(0)
  })

  it('auto 派生条目 → skipped:auto（正常跳过，不是丢数据）', async () => {
    const { svc } = stub()
    expect(await svc.apply(entry({ auto: true }))).toEqual({ applied: false, reason: 'skipped:auto' })
  })

  it('snapshot 的账户本机不存在 → failed:account-missing + warning', async () => {
    const { svc, noteSeen } = stub({ account: null })
    const rec: LedgerRecord = {
      uid: '2026-10__a-x',
      kind: 'snapshot',
      ym: '2026-10',
      accountUid: 'a-x',
      balanceCents: 100000,
      recordDate: '2026-10-31',
      note: null,
      rev: 1,
      updatedAt: 100,
      deleted: false,
      origin: '',
    }
    const out = await svc.apply(rec)
    expect(out.applied).toBe(false)
    expect(out.reason).toBe('failed:account-missing')
    expect(out.warning).toContain('本机不存在')
    expect(noteSeen).toHaveBeenCalledTimes(0)
  })
})

describe('composeResolved 字段锁（§5.6.2）', () => {
  const base = entry({ note: '原始', amountCents: 100 })
  const localOnly = entry({ note: '本端改过', amountCents: 100 })
  const remoteSame = entry({ note: '原始', amountCents: 100 })

  it('单端改动的字段被 payload 反向覆盖 → 锁定侧仍生效', () => {
    const out = composeResolved({
      base,
      local: localOnly,
      remote: remoteSame,
      pick: 'remote',
      fieldPicks: { note: 'remote' }, // 伪造/前端 bug：想反着来
      deviceId: 'd_a',
      now: 200,
    })
    // diff 说 note 只有本地动过 → 恒取 local
    expect(diffFields(base, localOnly, remoteSame).find((f) => f.name === 'note')!.changed).toBe('local')
    expect(out.note).toBe('本端改过')
  })

  it('两端都改过的字段 → 用户勾选仍然生效（锁只锁单端改动）', () => {
    const out = composeResolved({
      base,
      local: entry({ note: '本地版' }),
      remote: entry({ note: '远端版', rev: 2 }),
      pick: 'local',
      fieldPicks: { note: 'remote' },
      deviceId: 'd_a',
      now: 200,
    })
    expect(out.note).toBe('远端版')
  })

  it('字段不在 KIND_FIELDS 内 → 忽略（防塞任意键）', () => {
    const out = composeResolved({
      base,
      local: localOnly,
      remote: remoteSame,
      pick: 'local',
      fieldPicks: { evil: 'remote' } as any,
      deviceId: 'd_a',
      now: 200,
    })
    expect((out as any).evil).toBeUndefined()
  })

  it('墓碑不可用字段覆盖复活', () => {
    const out = composeResolved({
      base,
      local: entry({ deleted: true }),
      remote: entry({ note: '远端版' }),
      pick: 'local',
      fieldPicks: { note: 'remote' },
      deviceId: 'd_a',
      now: 200,
    })
    expect(out.deleted).toBe(true)
    expect(out.note).toBe('工资') // 仍是 local 墓碑那侧的取值，没被覆盖
  })

  it('rev 恒顶到 max+1，origin 记本机（保证对端看得见这次裁决）', () => {
    const out = composeResolved({
      base,
      local: withRev(3),
      remote: withRev(5),
      pick: 'local',
      deviceId: 'd_z',
      now: 999,
    })
    expect(out.rev).toBe(6)
    expect(out.origin).toBe('d_z')
    expect(out.updatedAt).toBe(999)
  })
})

function withRev(rev: number): LedgerRecord {
  return entry({ rev })
}

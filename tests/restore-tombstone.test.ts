/**
 * replace 恢复必须**墓碑化**而不是物理删（评审修复项，任务 1 / §4.3 / R10）。
 *
 * 这里用内存 Prisma 桩（含 (ym, accountId) 唯一约束）跑真实的 SystemService.restore()：
 *  · 五张同步载体的旧行全部 deleted:true、rev >= maxSeen+1、origin=deviceId、行数不减（没物理删）
 *  · 导入出来的是**新活行**（新 uid），且同 ym+accountId 的墓碑行被原地复活而不是撞唯一索引
 */
import { describe, it, expect } from 'vitest'
import { SystemService } from '../apps/server/src/system/system.service'

const MAX_SEEN = 7
const NOW = 1000
const DEVICE = 'd_local'

const metaStub = () => {
  let seq = 0
  return {
    now: () => NOW,
    deviceId: async () => DEVICE,
    maxSeen: async () => MAX_SEEN,
    stamp: async () => ({ uid: `u${++seq}`, rev: MAX_SEEN + 1, updatedAt: NOW, deleted: false, origin: DEVICE }),
    bump: async (r: any) => ({ rev: Math.max(Number(r?.rev || 0), MAX_SEEN) + 1, updatedAt: NOW, origin: DEVICE }),
    // 防翻倍引入的确定性 uid：测试桩里按 kind+key 稳定派生（与实现同语义，不同输入不同输出）
    deterministicUid: (kind: string, key: string) => `det-${kind}-${key.replace(/[^a-zA-Z0-9]/g, '_')}`,
  }
}

const monthsStub = () => ({ recomputeAuto: async () => ({}), recordPoints: async () => [] })
const backupStub = () => ({ snapshot: async () => undefined })

type Row = Record<string, any>

/** where 匹配：只支持本仓库用到的形态（标量等值 + ym_accountId 复合键 + OR 数组） */
function matches(row: Row, where: Row = {}): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'OR') {
      if (!(v as Row[]).some((w) => matches(row, w))) return false
      continue
    }
    if (k === 'ym_accountId') {
      if (row.ym !== (v as any).ym || row.accountId !== (v as any).accountId) return false
      continue
    }
    if (row[k] !== v) return false
  }
  return true
}

function makePrisma(seed: Record<string, Row[]>) {
  const db: any = {
    recordType: seed.types || [],
    account: seed.accounts || [],
    monthlySnapshot: seed.snapshots || [],
    changeEntry: seed.entries || [],
    loan: seed.loans || [],
    setting: seed.settings || [],
  }
  const calls: Array<{ table: string; op: string; args: any }> = []
  let nextId = 1 + Math.max(0, ...[...Object.values(db)].flat().map((r: any) => r.id || 0))

  /** 唯一约束：MonthlySnapshot 的 @@unique([ym, accountId])，撞了就抛（模拟 prisma） */
  const assertSnapshotUnique = (row: Row, selfId?: number) => {
    const dup = db.monthlySnapshot.some((r: any) => r.ym === row.ym && r.accountId === row.accountId && r.id !== selfId)
    if (dup) throw new Error(`Unique constraint failed: MonthlySnapshot(ym, accountId) = (${row.ym}, ${row.accountId})`)
  }

  const table = (name: string): any => ({
    findMany: async (args: any = {}) => {
      calls.push({ table: name, op: 'findMany', args })
      const rows = db[name].filter((r: Row) => matches(r, args.where))
      return rows.map((r: Row) => ({ ...r }))
    },
    findUnique: async (args: any) => {
      calls.push({ table: name, op: 'findUnique', args })
      const row = db[name].find((r: Row) => matches(r, args.where))
      return row ? { ...row } : null
    },
    findFirst: async (args: any = {}) => {
      calls.push({ table: name, op: 'findFirst', args })
      const row = db[name].find((r: Row) => matches(r, args.where))
      return row ? { ...row } : null
    },
    create: async (args: any) => {
      calls.push({ table: name, op: 'create', args })
      const row = { id: nextId++, ...args.data }
      if (name === 'monthlySnapshot') assertSnapshotUnique(row)
      db[name].push(row)
      return { ...row }
    },
    update: async (args: any) => {
      calls.push({ table: name, op: 'update', args })
      const i = db[name].findIndex((r: Row) => matches(r, args.where))
      if (i < 0) throw new Error(`${name} update: row not found`)
      const row = { ...db[name][i], ...args.data }
      if (name === 'monthlySnapshot') assertSnapshotUnique(row, db[name][i].id)
      db[name][i] = row
      return { ...row }
    },
    updateMany: async (args: any) => {
      calls.push({ table: name, op: 'updateMany', args })
      let count = 0
      for (const r of db[name]) {
        if (!matches(r, args.where)) continue
        Object.assign(r, args.data)
        count++
      }
      return { count }
    },
    deleteMany: async (args: any) => {
      calls.push({ table: name, op: 'deleteMany', args })
      throw new Error(`物理删除被调用：${name}.deleteMany()（replace 必须墓碑化，不能物理删）`)
    },
  })

  const prisma: any = {
    recordType: table('recordType'),
    account: table('account'),
    monthlySnapshot: table('monthlySnapshot'),
    changeEntry: table('changeEntry'),
    loan: table('loan'),
    setting: table('setting'),
    // 数组式事务：桩里没有回滚语义，直接并发执行
    $transaction: async (ops: any[]) => Promise.all(ops),
  }
  return { prisma, db, calls }
}

const baseSeed = () => ({
  types: [
    { id: 1, uid: 't_old', rev: 3, updatedAt: 1, deleted: false, origin: 'd_a', name: '工资', emoji: '💰', direction: 'income', builtin: false, sort: 0 },
    { id: 2, uid: 't_builtin', rev: 3, updatedAt: 1, deleted: false, origin: 'd_a', name: '平账', emoji: '⚖️', direction: 'neutral', builtin: true, sort: 0 },
    // 已墓碑的类型：merge 时不能被当成"已存在"
    { id: 4, uid: 't_dead', rev: 5, updatedAt: 1, deleted: true, origin: 'd_a', name: '餐饮', emoji: '🍜', direction: 'expense', builtin: false, sort: 0 },
  ],
  accounts: [{ id: 1, uid: 'a_old', rev: 3, updatedAt: 1, deleted: false, origin: 'd_a', name: '招行', emoji: '🏦', kind: 'asset', initBalance: 0, sort: 0, archived: false, createdAt: 1 }],
  snapshots: [{ id: 1, uid: '2026-10__a_old', rev: 3, updatedAt: 1, deleted: false, origin: 'd_a', ym: '2026-10', accountId: 1, balance: 100, recordDate: '2026-10-01', note: null }],
  entries: [{ id: 1, uid: 'e_old', rev: 3, updatedAt: 1, deleted: false, origin: 'd_a', ym: '2026-10', typeId: 1, amount: 50, note: null, accountId: 1, auto: false }],
  loans: [{ id: 1, uid: 'l_old', rev: 3, updatedAt: 1, deleted: false, origin: 'd_a', direction: 'out', counterparty: '老王', amount: 100, settledAmount: 0, date: '2026-10-01', createdAt: 1 }],
  settings: [{ key: 'gitDeviceId', value: 'd_a' }, { key: 'gitMaxRev', value: String(MAX_SEEN) }],
})

const backupData = () => ({
  format: 'suiji-ledger-backup',
  version: 1,
  types: [{ id: 10, name: '餐饮', emoji: '🍜', direction: 'expense', builtin: false, sort: 0 }],
  accounts: [{ id: 10, name: '微信', emoji: '💚', kind: 'asset', initBalance: 0, createdAt: 1 }],
  snapshots: [{ ym: '2026-10', accountId: 10, balance: 200, recordDate: '2026-10-05', note: null }],
  entries: [{ ym: '2026-10', typeId: 10, amount: 10, note: null, accountId: 10, auto: false }],
  loans: [],
  settings: [],
})

describe('restore(replace)：五表墓碑化，不物理删', () => {
  it('旧行全部 deleted:true 且 rev >= maxSeen+1，行数不减，导入的是新活行', async () => {
    const { prisma, db, calls } = makePrisma(baseSeed())
    const svc: any = new SystemService(prisma, monthsStub() as any, backupStub() as any, metaStub() as any)

    const before = {
      recordType: db.recordType.length,
      account: db.account.length,
      monthlySnapshot: db.monthlySnapshot.length,
      changeEntry: db.changeEntry.length,
      loan: db.loan.length,
    }
    const res = await svc.restore('replace', backupData())
    expect(res).toMatchObject({ ok: true, mode: 'replace' })
    expect(res.imported).toBe(1)

    // ── 1) 五张表都用 updateMany 打墓碑，且 where 只圈活行
    const tombOps = calls.filter((c) => c.op === 'updateMany')
    expect(tombOps.map((c) => c.table).sort()).toEqual(['account', 'changeEntry', 'loan', 'monthlySnapshot', 'recordType'])
    for (const c of tombOps) {
      expect(c.args.where).toEqual({ deleted: false })
      expect(c.args.data.deleted).toBe(true)
      expect(c.args.data.rev).toBeGreaterThanOrEqual(MAX_SEEN + 1) // 墓碑 rev 必须 > maxSeen
      expect(c.args.data.origin).toBe(DEVICE)
      expect(c.args.data.updatedAt).toBe(NOW)
    }
    // ── 2) 没有任何物理删除被调用（桩里的 deleteMany 会直接抛错）
    expect(calls.some((c) => c.op === 'deleteMany')).toBe(false)

    // ── 3) 旧行还在（行数不减），只是被墓碑化
    const oldRows = [
      db.recordType.find((r: any) => r.uid === 't_old'),
      db.account.find((r: any) => r.uid === 'a_old'),
      db.monthlySnapshot.find((r: any) => r.uid === '2026-10__a_old'),
      db.changeEntry.find((r: any) => r.uid === 'e_old'),
      db.loan.find((r: any) => r.uid === 'l_old'),
    ]
    for (const r of oldRows) {
      expect(r, '旧行必须还在（墓碑而非物理删）').toBeTruthy()
      expect(r.deleted).toBe(true)
      expect(r.rev).toBeGreaterThanOrEqual(MAX_SEEN + 1)
      expect(r.origin).toBe(DEVICE)
      expect(r.uid).toMatch(/^[^u]/) // uid 不变：墓碑保留原 uid，便于对端认出"是这条被删了"
    }
    expect(db.recordType.length).toBeGreaterThanOrEqual(before.recordType)
    expect(db.account.length).toBe(before.account + 1) // + 新增的「微信」
    // 防翻倍：无 uid 旧备份两次 replace 恢复必须产出同一 uid（两端恢复才能对齐不对出两套）
    expect(db.monthlySnapshot.length).toBe(before.monthlySnapshot + 1)
    expect(db.changeEntry.length).toBe(before.changeEntry + 1)
    expect(db.loan.length).toBe(before.loan)

    // ── 4) 导入的是新活行（新 uid），不是复活墓碑行
    const newType = db.recordType.find((r: any) => r.name === '餐饮' && !r.deleted)
    expect(newType).toBeTruthy()
    expect(newType.uid).not.toBe('t_dead')
    const newAccount = db.account.find((r: any) => r.name === '微信')
    expect(newAccount).toBeTruthy()
    expect(newAccount.deleted).toBe(false)
    // 防翻倍后新账户 uid 是确定性派生（不再是随机 uN），只要非空且与墓碑旧行不同
    expect(newAccount.uid).toBeTruthy()
    expect(newAccount.uid).not.toBe('a_old')
    const newSnap = db.monthlySnapshot.find((r: any) => r.id !== 1 && r.ym === '2026-10' && r.accountId === newAccount.id)
    expect(newSnap).toBeTruthy()
    expect(newSnap.deleted).toBe(false)
    expect(newSnap.uid).toBe(`2026-10__${newAccount.uid}`)
    const newEntry = db.changeEntry.find((r: any) => r.id !== 1)
    expect(newEntry.deleted).toBe(false)

    // ── 5) 新内置「平账」类型：旧的墓碑行不算"已存在"
    const builtin = db.recordType.filter((r: any) => r.builtin)
    expect(builtin.filter((r: any) => !r.deleted)).toHaveLength(1)
  })

  it('无 uid 旧备份两次恢复产出同一 uid（两端恢复对齐不翻倍）', async () => {
    const mk = () => {
      const { prisma, db } = makePrisma(baseSeed())
      return { svc: new SystemService(prisma, monthsStub() as any, backupStub() as any, metaStub() as any) as any, db }
    }
    const first = mk()
    await first.svc.restore('replace', backupData())
    const second = mk()
    await second.svc.restore('replace', backupData())
    const uidOf = (db: any, table: string, pred: (r: any) => boolean) =>
      db[table].filter(pred).map((r: any) => r.uid).sort()
    // 账户/类型/条目 uid 两次恢复完全一致
    expect(uidOf(second.db, 'account', (r: any) => !r.deleted)).toEqual(
      uidOf(first.db, 'account', (r: any) => !r.deleted),
    )
    expect(uidOf(second.db, 'recordType', (r: any) => !r.deleted)).toEqual(
      uidOf(first.db, 'recordType', (r: any) => !r.deleted),
    )
    expect(uidOf(second.db, 'changeEntry', (r: any) => !r.deleted)).toEqual(
      uidOf(first.db, 'changeEntry', (r: any) => !r.deleted),
    )
    // 快照 uid 派生自账户 uid，同样一致
    expect(uidOf(second.db, 'monthlySnapshot', (r: any) => !r.deleted)).toEqual(
      uidOf(first.db, 'monthlySnapshot', (r: any) => !r.deleted),
    )
  })
})

describe('restore(merge)：墓碑行不能冒充"已存在"', () => {
  it('同 ym+accountId 的墓碑快照被原地复活（不新建、不撞唯一索引）', async () => {
    const seed: any = baseSeed()
    // 活账户 id=5（merge 按 name+kind 命中它，名字必须与种子里的 id=1 不同），它的 2026-10 快照已墓碑
    seed.accounts.push({ id: 5, uid: 'a5', rev: 4, updatedAt: 1, deleted: false, origin: 'd_a', name: '支付宝', emoji: '💙', kind: 'asset', initBalance: 0, sort: 0, archived: false, createdAt: 1 })
    seed.snapshots.push({ id: 3, uid: 's_dead', rev: 6, updatedAt: 1, deleted: true, origin: 'd_a', ym: '2026-10', accountId: 5, balance: 1, recordDate: '2026-09-01', note: null })
    const { prisma, db, calls } = makePrisma(seed)
    const svc: any = new SystemService(prisma, monthsStub() as any, backupStub() as any, metaStub() as any)

    const data: any = {
      format: 'suiji-ledger-backup',
      types: [{ id: 10, name: '工资', emoji: '💰', direction: 'income', builtin: false, sort: 0 }],
      accounts: [{ id: 10, name: '支付宝', emoji: '💙', kind: 'asset' }],
      snapshots: [{ ym: '2026-10', accountId: 10, balance: 200, recordDate: '2026-10-05' }],
      entries: [],
    }
    const res = await svc.restore('merge', data)
    expect(res.imported).toBe(1)

    // merge 不墓碑化任何东西
    expect(calls.some((c) => c.op === 'updateMany')).toBe(false)
    // 类型：id=1 的活行命中（不是 t_dead）
    const type2 = calls.find((c) => c.table === 'recordType' && c.op === 'findFirst')
    expect(type2.args.where).toMatchObject({ name: '工资', direction: 'income', deleted: false })

    // 快照：原地复活 id=3，而不是新建第二行（唯一索引只允许一条）
    const snapRows = db.monthlySnapshot.filter((r: any) => r.ym === '2026-10' && r.accountId === 5)
    expect(snapRows).toHaveLength(1)
    expect(snapRows[0].id).toBe(3)
    expect(snapRows[0].deleted).toBe(false)
    expect(snapRows[0].balance).toBe(200)
    expect(snapRows[0].rev).toBeGreaterThanOrEqual(MAX_SEEN + 1)
    expect(snapRows[0].uid).toBe('2026-10__a5') // 新 uid，不复用墓碑行的 s_dead
    expect(calls.some((c) => c.table === 'monthlySnapshot' && c.op === 'create')).toBe(false)
  })
})

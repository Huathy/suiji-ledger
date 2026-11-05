// 同步载体格式与裁决规则单测（纯函数层）
import { describe, it, expect } from 'vitest'
import {
  canonicalRecord,
  composeResolved,
  decideMerge,
  diffFields,
  fileNameOf,
  kindOfFileName,
  recommendPick,
  repoPathOf,
  SYNC_SETTING_KEYS,
  uidOfFileName,
  type LedgerRecord,
} from '../apps/server/src/sync/ledger'

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
  origin: 'd_a',
  ...over,
})

const loan = (over: Partial<LedgerRecord> = {}): LedgerRecord => ({
  uid: 'l-1',
  kind: 'loan',
  direction: 'out',
  counterparty: '张三',
  amountCents: 30000,
  settledCents: 0,
  date: '2026-10-01',
  dueDate: null,
  accountUid: null,
  note: null,
  createdAt: 1,
  rev: 1,
  updatedAt: 100,
  deleted: false,
  origin: 'd_a',
  ...over,
})

describe('canonical 序列化（R2）', () => {
  it('同内容不同字段插入顺序 → 字节完全相同', () => {
    const a = entry()
    const b: any = {}
    // 故意乱序塞一遍
    for (const k of ['origin', 'deleted', 'updatedAt', 'rev', 'auto', 'accountUid', 'note', 'amountCents', 'typeUid', 'ym', 'kind', 'uid']) b[k] = (a as any)[k]
    expect(canonicalRecord(a)).toBe(canonicalRecord(b))
  })

  it('key 顺序固定且以单个换行结尾（不是 0 个、不是 2 个）', () => {
    const s = canonicalRecord(entry())
    expect(s.endsWith('\n')).toBe(true)
    expect(s.endsWith('\n\n')).toBe(false)
    expect(Object.keys(JSON.parse(s))).toEqual([
      'uid', 'kind', 'ym', 'typeUid', 'amountCents', 'note', 'accountUid', 'auto', 'rev', 'updatedAt', 'deleted', 'origin',
    ])
  })

  it('金额只认整数分：小数被四舍五入，undefined 变 null', () => {
    const rec: any = entry({ amountCents: 12.6 })
    delete rec.note
    const obj = JSON.parse(canonicalRecord(rec))
    expect(obj.amountCents).toBe(13)
    expect(obj.note).toBeNull()
  })
})

describe('文件名规则（R12：驱动只拿得到 basename）', () => {
  it('前缀编码 kind，set_ 不会被误判成 snapshot', () => {
    expect(kindOfFileName(fileNameOf({ kind: 'setting', uid: 'reminderDay' }))).toBe('setting')
    expect(kindOfFileName('set_reminderDay.json')).toBe('setting')
    expect(kindOfFileName('s_2026-10__acc-1.json')).toBe('snapshot')
    expect(kindOfFileName('e_abc.json')).toBe('entry')
    expect(kindOfFileName('meta.json')).toBeNull()
    expect(kindOfFileName('ledger/v1/entries/e_abc.json')).toBe('entry')
  })

  it('uid 含特殊字符也能还原', () => {
    const name = fileNameOf({ kind: 'setting', uid: 'weird key/值' })
    expect(uidOfFileName(name)).toBe('weird key/值')
  })

  it('全库 basename 唯一：不同 kind 的同名 uid 不撞名', () => {
    const names = new Set<string>()
    const recs = [
      { kind: 'entry' as const, uid: 'x' },
      { kind: 'account' as const, uid: 'x' },
      { kind: 'snapshot' as const, uid: 'x' },
      { kind: 'loan' as const, uid: 'x' },
      { kind: 'type' as const, uid: 'x' },
      { kind: 'setting' as const, uid: 'x' },
    ]
    for (const r of recs) names.add(fileNameOf(r))
    expect(names.size).toBe(recs.length)
  })

  it('repoPathOf 与 kind 的目录一致（仅用于展示，判类不靠它）', () => {
    expect(repoPathOf({ kind: 'entry', uid: 'e-1' })).toBe('ledger/v1/entries/e_e-1.json')
  })
})

describe('预选规则（§5.3，确定性 tie-break）', () => {
  it('墓碑优先：一端删了 → 推荐删除那端', () => {
    expect(recommendPick(null, entry({ deleted: true }), entry()).pick).toBe('local')
    expect(recommendPick(null, entry(), entry({ deleted: true })).pick).toBe('remote')
  })

  it('rev 大者胜', () => {
    const r = recommendPick(null, entry({ rev: 5 }), entry({ rev: 7, origin: 'd_b' }))
    expect(r.pick).toBe('remote')
    expect(r.reason).toContain('7')
  })

  it('rev 与时间都相同 → 按 origin 字典序，两端算出来必须一致', () => {
    const a = entry({ origin: 'd_aaa' })
    const b = entry({ origin: 'd_zzz' })
    expect(recommendPick(null, a, b).pick).toBe('remote')
    expect(recommendPick(null, b, a).pick).toBe('local')
  })
})

describe('驱动判定顺序（§5.3）', () => {
  const base = canonicalRecord(entry({ rev: 3 }))

  it('内容一致 → cleanMerge，取 our', () => {
    const same = canonicalRecord(entry({ rev: 4 }))
    const d = decideMerge({ baseText: base, ourText: same, theirText: same, fileName: 'e_e-1.json', mergeEnabled: true, encrypted: false, deviceId: 'd', now: 1 })
    expect(d.cleanMerge).toBe(true)
    if (d.cleanMerge) expect(d.mergedText).toBe(same)
  })

  it('借还进度纯累加 → 取 max 并自动合并（不打扰用户）', () => {
    const b = canonicalRecord(loan({ settledCents: 0, rev: 2 }))
    const our = canonicalRecord(loan({ settledCents: 10000, rev: 3 }))
    const their = canonicalRecord(loan({ settledCents: 5000, rev: 3 }))
    const d = decideMerge({ baseText: b, ourText: our, theirText: their, fileName: 'l_l-1.json', mergeEnabled: true, encrypted: false, deviceId: 'd_x', now: 9 })
    expect(d.cleanMerge).toBe(true)
    if (d.cleanMerge) {
      const merged = JSON.parse(d.mergedText)
      expect(merged.settledCents).toBe(10000) // 两笔还款都不丢
      expect(merged.rev).toBe(4)
    }
  })

  it('借还本金也变了 → 交人工，不做数值合并', () => {
    const b = canonicalRecord(loan({ rev: 2 }))
    const our = canonicalRecord(loan({ settledCents: 10000, amountCents: 30000, rev: 3 }))
    const their = canonicalRecord(loan({ settledCents: 5000, amountCents: 40000, rev: 3 }))
    const d = decideMerge({ baseText: b, ourText: our, theirText: their, fileName: 'l_l-1.json', mergeEnabled: true, encrypted: false, deviceId: 'd', now: 9 })
    expect(d.cleanMerge).toBe(false)
    if (!d.cleanMerge) expect(d.conflictType).toBe('both')
  })

  it('双端同改 → cleanMerge:false（不定案，交人勾选）', () => {
    const our = canonicalRecord(entry({ amountCents: 1400000, rev: 4 }))
    const their = canonicalRecord(entry({ amountCents: 1350000, rev: 4 }))
    const d = decideMerge({ baseText: base, ourText: our, theirText: their, fileName: 'e_e-1.json', mergeEnabled: true, encrypted: false, deviceId: 'd', now: 9 })
    expect(d.cleanMerge).toBe(false)
    if (!d.cleanMerge) {
      expect(d.conflictType).toBe('both')
      expect(['local', 'remote']).toContain(d.recommend)
    }
  })

  it('改/删并发 → edit-delete', () => {
    const our = canonicalRecord(entry({ deleted: true, rev: 4 }))
    const their = canonicalRecord(entry({ amountCents: 1, rev: 4 }))
    const d = decideMerge({ baseText: base, ourText: our, theirText: their, fileName: 'e_e-1.json', mergeEnabled: true, encrypted: false, deviceId: 'd', now: 9 })
    expect(d.cleanMerge).toBe(false)
    if (!d.cleanMerge) expect(d.conflictType).toBe('edit-delete')
  })

  it('合并已关闭 / 加密开启 → 一律整份二选一', () => {
    const our = canonicalRecord(entry({ rev: 4 }))
    const their = canonicalRecord(entry({ rev: 5 }))
    const off = decideMerge({ baseText: base, ourText: our, theirText: their, fileName: 'e_e-1.json', mergeEnabled: false, encrypted: false, deviceId: 'd', now: 9 })
    expect(off.cleanMerge).toBe(false)
    const enc = decideMerge({ baseText: base, ourText: our, theirText: their, fileName: 'e_e-1.json', mergeEnabled: true, encrypted: true, deviceId: 'd', now: 9 })
    expect(enc.cleanMerge).toBe(false)
    if (!enc.cleanMerge) expect(enc.conflictType).toBe('encrypted')
  })

  it('坏 JSON / kind 与文件名不符 → unparsable', () => {
    const bad = decideMerge({ baseText: null, ourText: '{oops', theirText: '{}', fileName: 'e_e-1.json', mergeEnabled: true, encrypted: false, deviceId: 'd', now: 9 })
    expect(bad.cleanMerge).toBe(false)
    if (!bad.cleanMerge) expect(bad.conflictType).toBe('unparsable')

    const mismatch = canonicalRecord(entry())
    const m = decideMerge({ baseText: null, ourText: mismatch, theirText: canonicalRecord(loan()), fileName: 'e_e-1.json', mergeEnabled: true, encrypted: false, deviceId: 'd', now: 9 })
    expect(m.cleanMerge).toBe(false)
    if (!m.cleanMerge) expect(m.conflictType).toBe('unparsable')
  })
})

describe('composeResolved（字段级优先于记录级）', () => {
  const local = entry({ amountCents: 1400000, note: '存款', rev: 4 })
  const remote = entry({ amountCents: 1350000, note: '工资到账', rev: 5 })

  it('整条取远程 → 全部字段跟随远程，rev 顶到 max+1', () => {
    const r = composeResolved({ base: null, local, remote, pick: 'remote', deviceId: 'd_x', now: 100 })
    expect(r.amountCents).toBe(1350000)
    expect(r.note).toBe('工资到账')
    expect(r.rev).toBe(6)
    expect(r.origin).toBe('d_x')
  })

  it('整条取本地 + 备注单独取远程 → 拼出混合结果', () => {
    const r = composeResolved({ base: null, local, remote, pick: 'local', fieldPicks: { note: 'remote' }, deviceId: 'd_x', now: 100 })
    expect(r.amountCents).toBe(1400000)
    expect(r.note).toBe('工资到账')
  })

  it('选了墓碑那端 → 结果就是删除，字段覆盖不复活', () => {
    const r = composeResolved({
      base: null,
      local: entry({ deleted: true }),
      remote: entry(),
      pick: 'local',
      fieldPicks: { note: 'remote' },
      deviceId: 'd_x',
      now: 100,
    })
    expect(r.deleted).toBe(true)
  })

  it('借还没显式勾选进度时取两端最大值（不丢还款）', () => {
    const r = composeResolved({
      base: loan({ settledCents: 0 }),
      local: loan({ settledCents: 10000 }),
      remote: loan({ settledCents: 5000, note: '部分还款' }),
      pick: 'local',
      deviceId: 'd_x',
      now: 100,
    })
    expect(r.settledCents).toBe(10000)
    expect(r.note).toBeNull()
  })
})

describe('字段级 diff', () => {
  it('只有一端动过的字段标成 local/remote（界面标灰，不占注意力）', () => {
    const base = entry({ note: 'a', amountCents: 100 })
    const local = entry({ note: 'b', amountCents: 100 })
    const remote = entry({ note: 'a', amountCents: 200 })
    const fields = diffFields(base, local, remote)
    expect(fields.find((f) => f.name === 'note')?.changed).toBe('local')
    expect(fields.find((f) => f.name === 'amountCents')?.changed).toBe('remote')
  })

  it('金额按元展示，不是裸的分', () => {
    const f = diffFields(null, entry({ amountCents: 1400000 }), entry({ amountCents: 1350000 }))
    expect(f.find((x) => x.name === 'amountCents')?.local).toBe('¥14,000.00')
  })

  it('三边相同的字段标 same（否则对照表全是假高亮）', () => {
    const base = entry({ note: 'a', amountCents: 100 })
    const fields = diffFields(base, entry({ note: 'a', amountCents: 200 }), entry({ note: 'a', amountCents: 300 }))
    expect(fields.find((f) => f.name === 'note')?.changed).toBe('same')
    expect(fields.find((f) => f.name === 'amountCents')?.changed).toBe('both')
  })

  it('两端改成同一个值也算 same，不需要人裁决', () => {
    const base = entry({ amountCents: 100 })
    const fields = diffFields(base, entry({ amountCents: 300 }), entry({ amountCents: 300 }))
    expect(fields.find((f) => f.name === 'amountCents')?.changed).toBe('same')
  })
})

describe('设置白名单', () => {
  it('同步自身的开关绝不投影进 git', () => {
    for (const k of ['gitRemote', 'gitAuth', 'gitAuthEnc', 'gitEncrypt', 'gitMergeEnabled', 'gitPushMode', 'gitConflictState', 'gitDeviceId']) {
      expect(SYNC_SETTING_KEYS).not.toContain(k)
    }
    expect(SYNC_SETTING_KEYS).toContain('theme')
  })
})

describe('调度纯函数（§6.2 / §6.4）', () => {
  it('daily：今天 03:00 后且今天没跑过 → 该跑；跑过就不重复', async () => {
    const { shouldRunNow } = await import('../apps/server/src/sync/schedule')
    const now = new Date(2026, 10, 2, 9, 30, 0)
    const today3 = Math.floor(new Date(2026, 10, 2, 3, 0, 0).getTime() / 1000)
    expect(shouldRunNow('daily', now, null)).toBe(true)
    expect(shouldRunNow('daily', now, today3 - 3600)).toBe(true) // 昨天跑的 → 补跑
    expect(shouldRunNow('daily', now, today3 + 60)).toBe(false) // 今天已跑
    expect(shouldRunNow('daily', new Date(2026, 10, 2, 2, 59, 0), null)).toBe(false) // 还没到 03:00
  })

  it('manual / every-commit 不走定时器', async () => {
    const { shouldRunNow } = await import('../apps/server/src/sync/schedule')
    expect(shouldRunNow('manual', new Date(2026, 10, 2, 9, 0, 0), null)).toBe(false)
    expect(shouldRunNow('every-commit', new Date(2026, 10, 2, 9, 0, 0), null)).toBe(false)
  })

  it('离线退避 1/5/15/30 分钟封顶', async () => {
    const { backoffMinutes } = await import('../apps/server/src/sync/schedule')
    expect([0, 1, 2, 3, 9].map(backoffMinutes)).toEqual([1, 5, 15, 30, 30])
  })

  it('租约式强推（D9/§6.3）：远端 oid 等于上次所见才放行', async () => {
    const { leaseAllowsForce } = await import('../apps/server/src/sync/schedule')
    expect(leaseAllowsForce('aaa', 'aaa')).toBe(true) // 远端没动 → 覆盖的是看清的那一版
    expect(leaseAllowsForce('aaa', 'bbb')).toBe(false) // 第三方推进过 → 拒绝转人工
    expect(leaseAllowsForce('', 'aaa')).toBe(false) // 本机从没推成功 = 无租约
    expect(leaseAllowsForce(null, null)).toBe(false)
    expect(leaseAllowsForce('aaa', null)).toBe(true) // 远端分支不存在 = 首次建分支
  })
})

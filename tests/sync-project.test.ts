/**
 * §4.1 硬约束的真实投影版（评审修复项 Spec(a)7）：
 * 旧单测只对手工 6 条合成记录断言"不撞名"，没跑投影通道。
 * 这里拿 mock 的 Prisma 行 → ProjectService.buildFiles() 全库投影，
 * 断言 basename 集合大小 == 记录数（一条不落、一条不并），并顺手验证墓碑行仍投影（R10）。
 */
import { describe, it, expect, vi } from 'vitest'
import { ProjectService } from '../apps/server/src/sync/project.service'
import { kindOfFileName } from '../apps/server/src/sync/ledger'

const row = (o: any) => ({ rev: 1, updatedAt: 1, deleted: false, origin: 'd_a', ...o })

function makeProject(rows: {
  types?: any[]
  accounts?: any[]
  snapshots?: any[]
  entries?: any[]
  loans?: any[]
  settings?: any[]
}) {
  const prisma: any = {
    recordType: { findMany: vi.fn(async () => rows.types || []) },
    account: { findMany: vi.fn(async () => rows.accounts || []) },
    monthlySnapshot: { findMany: vi.fn(async () => rows.snapshots || []) },
    changeEntry: { findMany: vi.fn(async () => rows.entries || []) },
    loan: { findMany: vi.fn(async () => rows.loans || []) },
    setting: { findMany: vi.fn(async () => rows.settings || []) },
  }
  const meta: any = { ensureUids: vi.fn(async () => undefined), deviceId: vi.fn(async () => 'd_a') }
  const cfg: any = { encrypt: vi.fn(async () => false), branch: vi.fn(async () => 'main') }
  return new ProjectService(prisma, meta, cfg)
}

describe('真实投影：全库 basename 唯一（§4.1 / R12）', () => {
  it('混合六类 + 同 uid 跨类 + 设置白名单：文件数 = 记录数 + meta.json，basename 无碰撞', async () => {
    const svc = makeProject({
      types: [row({ id: 1, uid: 'x', name: '工资', emoji: '💰', direction: 'income', builtin: false, sort: 0 })],
      accounts: [row({ id: 2, uid: 'x', name: '招行', emoji: '🏦', kind: 'asset', group: null, initBalance: 0, inNetWorth: true, sort: 0, archived: false, note: null, createdAt: 1 })],
      snapshots: [row({ id: 3, uid: 'x', ym: '2026-10', accountId: 2, balance: 100, recordDate: '2026-10-01', note: null })],
      entries: [
        row({ id: 4, uid: 'x', ym: '2026-10', typeId: 1, amount: 50, note: null, accountId: 2, auto: false }),
        row({ id: 5, uid: 'x2', ym: '2026-10', typeId: 1, amount: 60, note: null, accountId: null, auto: false }),
        // 自动条目是派生值不投影（project.service 里 continue），不计入期望
        row({ id: 6, uid: 'x3', ym: '2026-10', typeId: 1, amount: 0, note: null, accountId: null, auto: true }),
      ],
      loans: [row({ id: 7, uid: 'x', direction: 'out', counterparty: '张三', amount: 100, settledAmount: 0, date: '2026-10-01', dueDate: null, accountId: null, note: null, createdAt: 1 })],
      settings: [
        row({ key: 'theme', value: 'dark' }),
        row({ key: 'gitRemote', value: 'https://x' }), // 同步自身开关：绝不投影
        row({ key: 'timeSortDir', value: 'desc' }),
      ],
    })
    const { files, records } = await svc.buildFiles()
    // 非派生、非黑名单的记录数：type1 + account1 + snapshot1 + entry2 + loan1 + setting2(theme/timeSortDir) = 8
    expect(records).toHaveLength(8)
    expect(files.size).toBe(9) // + meta.json
    const basenames = [...files.keys()]
    expect(new Set(basenames).size).toBe(basenames.length)
    // 同 uid 'x' 在五个 kind 里前缀互不相同
    const kinds = basenames.filter((n) => n !== 'meta.json').map((n) => kindOfFileName(n))
    expect(kinds.filter(Boolean)).toHaveLength(8)
    // 同名 uid 的载体真的都在：t_x / a_x / s_x / e_x / l_x / set_theme / set_timeSortDir / e_x2
    for (const n of ['t_x.json', 'a_x.json', 's_x.json', 'e_x.json', 'l_x.json', 'set_theme.json', 'set_timeSortDir.json', 'e_x2.json']) {
      expect(files.has(n), n).toBe(true)
    }
    expect(files.has('set_gitRemote.json')).toBe(false)
  })

  it('墓碑行照常投影（R10：删除=改内容，不删文件）', async () => {
    const svc = makeProject({
      entries: [row({ id: 1, uid: 'dead', ym: '2026-10', typeId: 9, amount: 1, note: null, accountId: null, auto: false, deleted: true })],
      types: [row({ id: 9, uid: 't9', name: 'A', emoji: 'x', direction: 'expense', builtin: false, sort: 0 })],
    })
    const { files } = await svc.buildFiles()
    expect(files.has('e_dead.json')).toBe(true)
    expect(JSON.parse(files.get('e_dead.json')!).deleted).toBe(true)
  })
})

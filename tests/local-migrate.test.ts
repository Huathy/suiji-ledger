// 旧版本本地库迁移单测：缺 loans / trash 的历史数据不应再抛 undefined 错误
import { describe, it, expect, vi } from 'vitest'

const OLD_DB = {
  version: 1,
  seq: 20,
  accounts: [{ id: 1, name: '招商银行', emoji: '🏦', kind: 'asset', group: '资金', initBalance: 500000, inNetWorth: true, sort: 1, archived: false, note: null, createdAt: 1 }],
  types: [{ id: 4, name: '平账', emoji: '⚖️', color: null, direction: 'neutral', builtin: true, sort: 0 }],
  snapshots: [{ id: 10, ym: '2026-09', accountId: 1, balance: 610000, recordDate: '2026-09-28', note: null }],
  entries: [{ id: 11, ym: '2026-09', typeId: 4, amount: 110000, note: '（批量记录）', accountId: null, auto: true }],
  settings: { theme: 'auto' },
}

const store = new Map<string, string>([['mr_local_db_v1', JSON.stringify(OLD_DB)]])
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => store.set(k, v),
  removeItem: (k: string) => store.delete(k),
})

const { localHandle } = await import('../apps/web/src/local/backend')

describe('本地后端：旧库迁移', () => {
  it('缺 loans/trash 的库加载后自动补齐，/loans 与 /recycle 可用', async () => {
    const loans = await localHandle('GET', '/loans')
    expect(loans.loans).toEqual([])
    expect(loans.summary).toEqual({ borrowIn: 0, lendOut: 0 })

    const recycle = await localHandle('GET', '/recycle')
    expect(recycle.items).toEqual([])

    const saved = JSON.parse(store.get('mr_local_db_v1') as string)
    expect(Array.isArray(saved.loans)).toBe(true)
    expect(Array.isArray(saved.trash)).toBe(true)
  })

  it('原有账户/快照数据保持不变，新增记录主键不冲突', async () => {
    const accs = await localHandle('GET', '/accounts')
    expect(accs).toHaveLength(1)
    expect(accs[0].name).toBe('招商银行')

    const month = await localHandle('GET', '/month/2026-09')
    expect(month.networth).toBe(610000)

    const acc = await localHandle('POST', '/accounts', { name: '新卡', emoji: '🏦', kind: 'asset', initBalance: 0 })
    expect(acc.id).toBeGreaterThan(11)
  })
})

// 离线本地后端单测：平账恒等式 / 快速调余额单独成条 / 回收站恢复 / 借还台账
import { describe, it, expect, beforeAll, vi } from 'vitest'

// localStorage 桩（backend.ts 依赖）
const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => store.set(k, v),
  removeItem: (k: string) => store.delete(k),
})

let localHandle: (m: string, p: string, b?: any) => Promise<any>

beforeAll(async () => {
  ;({ localHandle } = await import('../apps/web/src/local/backend'))
})

async function login() {
  return localHandle('POST', '/auth/login', { password: 'x' })
}

const fmt = (c: number) => (c / 100).toFixed(2)

describe('本地后端：月度平账闭环', () => {
  it('平账 → 恒等式成立；批量备注落在自动条目', async () => {
    await login()
    const wage = await localHandle('POST', '/types', { name: '工资', emoji: '💼', direction: 'income' })
    const acc = await localHandle('POST', '/accounts', { name: '测试卡', emoji: '🏦', kind: 'asset', initBalance: 5570000 })
    await localHandle('POST', '/reconcile', {
      ym: '2026-09', recordDate: '2026-09-30',
      balances: [{ accountId: acc.id, balance: 5570000 }], bigItems: [],
    })
    const oct = await localHandle('POST', '/reconcile', {
      ym: '2026-10', recordDate: '2026-10-24',
      balances: [{ accountId: acc.id, balance: 5890000 }],
      bigItems: [{ typeId: wage.id, amount: 1200000, note: '发薪' }],
      note: '（批量记录）',
    })
    expect(oct.networth).toBe(5890000)
    expect(oct.delta).toBe(320000)
    expect(oct.autoEntry.amount).toBe(320000 - 1200000)
    expect(oct.autoEntry.note).toBe('（批量记录）')
    const bigTotal = oct.entries.filter((e: any) => !e.auto).reduce((s: number, e: any) => s + e.amount, 0)
    expect(bigTotal + oct.autoEntry.amount).toBe(oct.delta) // 恒等式
  })

  it('单账户调余额：单独生成平账记录，与批量条目并列且恒等式保持', async () => {
    const accs = await localHandle('GET', '/accounts')
    const acc = accs.find((a: any) => a.name === '测试卡')
    const r = await localHandle('POST', `/accounts/${acc.id}/set-balance`, { balance: 5990000, note: '余额调整 10-25' })
    expect(r.delta).toBe(100000)
    const d = await localHandle('GET', '/month/2026-10')
    const manual = d.entries.filter((e: any) => !e.auto)
    const adjust = manual.find((e: any) => e.typeId === 1 && (e.note || '').includes('余额调整'))
    expect(adjust).toBeTruthy()
    expect(adjust.amount).toBe(100000)
    const bigTotal = manual.reduce((s: number, e: any) => s + e.amount, 0)
    expect(bigTotal + d.autoEntry.amount).toBe(d.delta)
  })

  it('删除大项 → 回收站 → 恢复后恒等式自动重算', async () => {
    let d = await localHandle('GET', '/month/2026-10')
    const item = d.entries.find((e: any) => !e.auto && e.name === '工资')
    d = await localHandle('DELETE', `/month/2026-10/entry/${item.id}`)
    expect(d.entries.find((e: any) => e.id === item.id)).toBeUndefined()
    const recycle = await localHandle('GET', '/recycle')
    const trashed = recycle.items.find((i: any) => i.kind === 'entry' && i.payload.id === item.id)
    expect(trashed).toBeTruthy()
    await localHandle('POST', `/recycle/${trashed.id}/restore`)
    d = await localHandle('GET', '/month/2026-10')
    expect(d.entries.find((e: any) => e.typeId === item.typeId && e.amount === item.amount && e.note === item.note)).toBeTruthy()
    const bigTotal = d.entries.filter((e: any) => !e.auto).reduce((s: number, e: any) => s + e.amount, 0)
    expect(bigTotal + d.autoEntry.amount).toBe(d.delta)
  })

  it('借还台账：借出→部分收回→结清；删除入回收站', async () => {
    const loan = await localHandle('POST', '/loans', { direction: 'out', counterparty: '老王', amount: 1500000, date: '2026-10-01' })
    let r = await localHandle('POST', `/loans/${loan.id}/settle`, { amount: 500000 })
    expect(r.summary.lendOut).toBe(1000000)
    r = await localHandle('POST', `/loans/${loan.id}/settle`, { amount: 1000000 })
    expect(r.summary.lendOut).toBe(0)
    await localHandle('DELETE', `/loans/${loan.id}`)
    const recycle = await localHandle('GET', '/recycle')
    expect(recycle.items.some((i: any) => i.kind === 'loan' && i.payload.counterparty === '老王')).toBe(true)
  })

  it('跨月搜索与类型贡献', async () => {
    const s1 = await localHandle('GET', '/search?q=发薪')
    expect(s1.results.length).toBeGreaterThanOrEqual(1)
    const tc = await localHandle('GET', '/stats/type-contribution?limit=12')
    expect(tc.items.some((i: any) => i.name === '工资')).toBe(true)
    expect(tc.items.some((i: any) => i.name === '平账（自动）')).toBe(true)
  })
})

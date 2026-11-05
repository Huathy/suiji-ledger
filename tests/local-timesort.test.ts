// 时间排序方向（倒序/顺序）在离线本地后端的落地校验：
// /months、/search、/loans、/recycle、/system/matrix.csv 五个入口都接受 dir 参数，
// 且与服务端（NestJS + Prisma orderBy）同语义。
import { describe, it, expect, beforeAll, vi } from 'vitest'

// 每个测试文件独立模块实例 + 独立 localStorage 桩
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

describe('离线后端：时间排序方向', () => {
  it('月份列表 dir=asc 为时间顺序（最早在前），默认/ dir=desc 为倒序（最近在前）', async () => {
    const acc = await localHandle('POST', '/accounts', { name: '排序卡', emoji: '🏦', kind: 'asset', initBalance: 100000 })
    for (const [ym, date] of [['2026-06', '2026-06-28'], ['2026-07', '2026-07-28'], ['2026-08', '2026-08-28']] as [string, string][]) {
      await localHandle('POST', '/reconcile', {
        ym, recordDate: date,
        balances: [{ accountId: acc.id, balance: 100000 }], bigItems: [],
      })
    }
    const desc = await localHandle('GET', '/months?limit=120')
    expect(desc.months.map((m: any) => m.ym)).toEqual(['2026-08', '2026-07', '2026-06'])
    const asc = await localHandle('GET', '/months?limit=120&dir=asc')
    expect(asc.months.map((m: any) => m.ym)).toEqual(['2026-06', '2026-07', '2026-08'])
    const dExplicit = await localHandle('GET', '/months?limit=120&dir=desc')
    expect(dExplicit.months.map((m: any) => m.ym)).toEqual(desc.months.map((m: any) => m.ym))
  })

  it('limit 语义不随方向变：asc 仍是「最近的 N 个月」正着排，而不是只看最老的 N 个月', async () => {
    const r = await localHandle('GET', '/months?limit=2&dir=asc')
    expect(r.months.map((m: any) => m.ym)).toEqual(['2026-07', '2026-08'])
  })

  it('搜索 dir=asc：同月内按录入先后（id）正排，月份也早的在前', async () => {
    const type = await localHandle('POST', '/types', { name: '测试工资', emoji: '💼', direction: 'income' })
    await localHandle('POST', '/month/2026-06/entry', { typeId: type.id, amount: 100000, note: '六月A' })
    await localHandle('POST', '/month/2026-06/entry', { typeId: type.id, amount: 200000, note: '六月B' })
    await localHandle('POST', '/month/2026-08/entry', { typeId: type.id, amount: 300000, note: '八月C' })
    const asc = await localHandle('GET', '/search?q=六月&dir=asc')
    expect(asc.results.map((x: any) => x.note)).toEqual(['六月A', '六月B'])
    const all = await localHandle('GET', '/search?q=月&dir=asc')
    expect(all.results.map((x: any) => x.ym)).toEqual(['2026-06', '2026-06', '2026-08'])
    const desc = await localHandle('GET', '/search?q=月&dir=desc')
    expect(desc.results.map((x: any) => x.ym)).toEqual(['2026-08', '2026-06', '2026-06'])
    // 截断上限与方向无关
    expect(all.results.length).toBeLessThanOrEqual(200)
  })

  it('借还台账按发生日期排：dir=asc 早的在前，dir=desc 晚的在前', async () => {
    await localHandle('POST', '/loans', { direction: 'out', counterparty: '早借出', amount: 10000, date: '2026-01-05' })
    await localHandle('POST', '/loans', { direction: 'out', counterparty: '晚借出', amount: 20000, date: '2026-09-05' })
    const asc = await localHandle('GET', '/loans?dir=asc')
    expect(asc.loans.map((l: any) => l.counterparty)).toEqual(['早借出', '晚借出'])
    const desc = await localHandle('GET', '/loans?dir=desc')
    expect(desc.loans.map((l: any) => l.counterparty)).toEqual(['晚借出', '早借出'])
    // 汇总金额与排序无关
    expect(desc.summary.lendOut).toBe(asc.summary.lendOut)
  })

  it('回收站 dir 翻转删除时间顺序', async () => {
    const d = await localHandle('GET', '/month/2026-08')
    const item = d.entries.find((e: any) => !e.auto && e.note === '八月C')
    await localHandle('DELETE', `/month/2026-08/entry/${item.id}`)
    const tr = await localHandle('POST', '/loans', { direction: 'in', counterparty: '删掉的借入', amount: 5000, date: '2026-02-02' })
    await localHandle('DELETE', '/loans/' + tr.id)
    const asc = await localHandle('GET', '/recycle?dir=asc')
    const desc = await localHandle('GET', '/recycle?dir=desc')
    expect(asc.items.length).toBe(2)
    expect(asc.items.map((i: any) => i.id)).toEqual([...asc.items.map((i: any) => i.id)].sort((a, b) => a - b))
    expect(desc.items.map((i: any) => i.id)).toEqual([...asc.items.map((i: any) => i.id)].reverse())
  })

  it('CSV 导出行序跟随 dir（表头与末行导出时间不变）', async () => {
    const descCsv = (await localHandle('GET', '/system/matrix.csv?dir=desc')).csv
    const ascCsv = (await localHandle('GET', '/system/matrix.csv?dir=asc')).csv
    const monthsOf = (csv: string) =>
      csv.split('\r\n').slice(1).filter((l) => /^\d{4}-\d{2},/.test(l)).map((l) => l.split(',')[0])
    expect(monthsOf(descCsv)).toEqual(['2026-08', '2026-07', '2026-06'])
    expect(monthsOf(ascCsv)).toEqual(['2026-06', '2026-07', '2026-08'])
    expect(descCsv.split('\r\n')[0]).toBe(ascCsv.split('\r\n')[0])
    expect(ascCsv).toMatch(/# 导出时间,/)
  })

  it('timeSortDir 设置可读写（跨设备跟随账号）', async () => {
    await localHandle('PUT', '/system/settings', { settings: { timeSortDir: 'asc' } })
    const r = await localHandle('GET', '/system/settings')
    expect(r.settings.timeSortDir).toBe('asc')
  })
})

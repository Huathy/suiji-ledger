// 时间排序原语单测：倒序/顺序方向、二次键、不可变性、设置值解析
import { describe, it, expect } from 'vitest'
import {
  sortByTime, parseTimeSortDir, flipTimeSortDir, TIME_SORT_DIR_KEY,
} from '../packages/shared/src/index'

describe('parseTimeSortDir / flipTimeSortDir', () => {
  it('只认 asc，其余（含 undefined / 坏值）一律回退 desc', () => {
    expect(parseTimeSortDir('asc')).toBe('asc')
    expect(parseTimeSortDir('desc')).toBe('desc')
    expect(parseTimeSortDir(undefined)).toBe('desc')
    expect(parseTimeSortDir(null)).toBe('desc')
    expect(parseTimeSortDir('ASC')).toBe('desc') // 大小写严格，避免脏值当成 asc
    expect(parseTimeSortDir('')).toBe('desc')
  })
  it('flip 在两个方向间来回切', () => {
    expect(flipTimeSortDir('desc')).toBe('asc')
    expect(flipTimeSortDir('asc')).toBe('desc')
  })
  it('设置键名固定（服务端 settings / 离线 db.settings 共用）', () => {
    expect(TIME_SORT_DIR_KEY).toBe('timeSortDir')
  })
})

describe('sortByTime', () => {
  const rows = [
    { id: 3, ym: '2026-10' },
    { id: 1, ym: '2026-08' },
    { id: 2, ym: '2026-09' },
  ]

  it('desc = 倒序（新的在前），asc = 顺序（旧的在前）', () => {
    expect(sortByTime(rows, (r) => r.ym, 'desc').map((r) => r.ym))
      .toEqual(['2026-10', '2026-09', '2026-08'])
    expect(sortByTime(rows, (r) => r.ym, 'asc').map((r) => r.ym))
      .toEqual(['2026-08', '2026-09', '2026-10'])
  })

  it('同一时间键内用 id 作二次键：asc 时后记的在后，desc 时后记的在前', () => {
    const same = [
      { id: 7, ym: '2026-10' },
      { id: 5, ym: '2026-10' },
      { id: 9, ym: '2026-09' },
    ]
    expect(sortByTime(same, (r) => r.ym, 'desc', (r) => r.id).map((r) => r.id))
      .toEqual([7, 5, 9])
    expect(sortByTime(same, (r) => r.ym, 'asc', (r) => r.id).map((r) => r.id))
      .toEqual([9, 5, 7])
  })

  it('数值时间键（epoch 秒/毫秒）按数值比，不按字典序', () => {
    const list = [{ t: 999 }, { t: 1000 }, { t: 100 }]
    // 字典序会得到 100 < 1000 < 999，这里必须是真正的数值时间序
    expect(sortByTime(list, (r) => r.t, 'asc').map((r) => r.t)).toEqual([100, 999, 1000])
    expect(sortByTime(list, (r) => r.t, 'desc').map((r) => r.t)).toEqual([1000, 999, 100])
  })

  it('混合字符串日期键（YYYY-MM-DD）字典序即时间序', () => {
    const list = [{ d: '2026-10-01' }, { d: '2026-09-30' }, { d: '2027-01-05' }]
    expect(sortByTime(list, (r) => r.d, 'asc').map((r) => r.d))
      .toEqual(['2026-09-30', '2026-10-01', '2027-01-05'])
    expect(sortByTime(list, (r) => r.d, 'desc').map((r) => r.d))
      .toEqual(['2027-01-05', '2026-10-01', '2026-09-30'])
  })

  it('不变更入参（返回新数组）', () => {
    const src = [1, 2, 3]
    const out = sortByTime(src, (x) => x, 'desc')
    expect(out).toEqual([3, 2, 1])
    expect(src).toEqual([1, 2, 3])
  })

  it('默认方向为 desc（保持历史行为：新的在前）', () => {
    expect(sortByTime(rows, (r) => r.ym).map((r) => r.ym)).toEqual(['2026-10', '2026-09', '2026-08'])
  })

  it('空数组 / 单元素不炸', () => {
    expect(sortByTime([], () => 'x', 'asc')).toEqual([])
    expect(sortByTime([{ ym: '2026-01' }], (r) => r.ym, 'asc')).toEqual([{ ym: '2026-01' }])
  })
})

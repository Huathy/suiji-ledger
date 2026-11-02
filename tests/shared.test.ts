// packages/shared 纯函数单测：金额换算 / 区间统计（平账核心公式）
import { describe, it, expect } from 'vitest'
import {
  toCents, fromCents, fmtMoney, computeIntervalStats, daysBetween,
  BUILTIN_PINGZHANG, fileStamp, stampText, prevYm, yoyYm, pctChange, fmtPct,
  parseOrder, applyOrder,
} from '../packages/shared/src/index'

describe('金额：元 ↔ 分', () => {
  it('字符串/数字转分', () => {
    expect(toCents('35')).toBe(3500)
    expect(toCents('35.5')).toBe(3550)
    expect(toCents('35.55')).toBe(3555)
    expect(toCents('1,234.56')).toBe(123456)
    expect(toCents('￥89.9')).toBe(8990)
    expect(toCents(-3.2)).toBe(-320)
    expect(toCents('abc')).toBeNull()
    expect(toCents('1.234')).toBeNull() // 超过两位小数
  })
  it('分转元与千分位', () => {
    expect(fromCents(6936350)).toBe('69363.50')
    expect(fmtMoney(123456789)).toBe('1,234,567.89')
    expect(fmtMoney(464500, { signed: true })).toBe('+4,645.00')
    expect(fmtMoney(-935500, { signed: true })).toBe('−9,355.00')
  })
})

describe('区间统计公式（07 号纪要口径）', () => {
  it('有收入大项：支出估算 = 收入 − 净增', () => {
    const r = computeIntervalStats(464500, 1400000, 24)
    expect(r.spendEst).toBe(935500)
    expect(r.dailyAvg).toBe(Math.round(935500 / 24))
    expect(r.dailyNet).toBe(Math.round(464500 / 24))
    expect(r.estimated).toBe(false)
  })
  it('未记收入：按资产净减少估算', () => {
    const r = computeIntervalStats(-300000, 0, 10)
    expect(r.spendEst).toBe(300000)
    expect(r.estimated).toBe(true)
  })
  it('同日两次记录按 1 天，最小 1 天', () => {
    expect(daysBetween('2026-10-24', '2026-10-24')).toBe(1)
    expect(daysBetween('2026-09-30', '2026-10-24')).toBe(24)
    expect(computeIntervalStats(0, 0, 0).days).toBe(1)
  })
})

describe('内置类型', () => {
  it('平账为内置中性类型', () => {
    expect(BUILTIN_PINGZHANG.name).toBe('平账')
    expect(BUILTIN_PINGZHANG.direction).toBe('neutral')
    expect(BUILTIN_PINGZHANG.builtin).toBe(true)
  })
})

describe('导出时间戳（问题 3）', () => {
  it('fileStamp 为 YYYYMMDD-HHMMSS 本地时间', () => {
    const d = new Date(2026, 10, 1, 9, 5, 3)
    expect(fileStamp(d)).toBe('20261101-090503')
    expect(stampText(d)).toBe('2026-11-01 09:05:03')
  })
  it('文件名长度固定且不含冒号（跨平台安全）', () => {
    expect(fileStamp()).toMatch(/^\d{8}-\d{6}$/)
  })
})

describe('环比 / 同比（问题 5）', () => {
  it('prevYm / yoyYm 处理跨年', () => {
    expect(prevYm('2026-01')).toBe('2025-12')
    expect(prevYm('2026-11')).toBe('2026-10')
    expect(yoyYm('2026-11')).toBe('2025-11')
  })
  it('pctChange：正常/负增长/基数为 0/缺基线', () => {
    expect(pctChange(189706, 168000)).toBeCloseTo(12.92, 1)
    expect(pctChange(90, 100)).toBe(-10)
    expect(pctChange(100, 0)).toBeNull()
    expect(pctChange(100, null)).toBeNull()
    expect(pctChange(null, 100)).toBeNull()
  })
  it('fmtPct 带符号，null 显示占位', () => {
    expect(fmtPct(12.922)).toBe('+12.9%')
    expect(fmtPct(-3.5)).toBe('−3.5%')
    expect(fmtPct(0)).toBe('0.0%')
    expect(fmtPct(null)).toBe('—')
  })
})

describe('自定义顺序（问题 2/6）', () => {
  it('parseOrder：合法数组 / 空 / 坏 JSON', () => {
    expect(parseOrder('["a","b"]')).toEqual(['a', 'b'])
    expect(parseOrder(undefined)).toBeNull()
    expect(parseOrder('[]')).toBeNull()
    expect(parseOrder('not-json')).toBeNull()
  })
  it('applyOrder：已知按给定顺序在前，未知保持原序在后；不改入参', () => {
    const list = [{ id: 'x' }, { id: 'a' }, { id: 'b' }, { id: 'y' }]
    const out = applyOrder(list, (v) => v.id, ['b', 'a'])
    expect(out.map((v) => v.id)).toEqual(['b', 'a', 'x', 'y'])
    expect(list.map((v) => v.id)).toEqual(['x', 'a', 'b', 'y'])
  })
  it('applyOrder：order 为空/为 null 时等价于原序拷贝', () => {
    const list = ['a', 'b']
    expect(applyOrder(list, (v) => v, null)).toEqual(['a', 'b'])
    expect(applyOrder(list, (v) => v, [])).toEqual(['a', 'b'])
  })
})

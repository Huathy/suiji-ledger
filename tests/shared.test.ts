// packages/shared 纯函数单测：金额换算 / 区间统计（平账核心公式）
import { describe, it, expect } from 'vitest'
import {
  toCents, fromCents, fmtMoney, computeIntervalStats, daysBetween,
  BUILTIN_PINGZHANG,
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

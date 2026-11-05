/**
 * 提交信息 ↔ 净资产的契约（评审修复项 Primitive Obsession）。
 *
 * 旧实现把净资产以**展示格式**（`¥1,234.56`）写进提交文案，历史页再用正则反解。
 * 这是单向耦合：文案里换货币符号、改千分位、或者句子中再出现一次"净资产"，
 * 曲线会静默错位，且没有任何测试能钉住它。
 * 现在主路径是 git 惯例 trailer（`Suiji-Networth-Cents: 整数分`），旧正则只作兼容通道。
 */
import { describe, it, expect } from 'vitest'
import { parseNetworth } from '../apps/server/src/sync/sync.service'

describe('parseNetworth：结构化 trailer 优先', () => {
  it('读 trailer 里的整数分', () => {
    const msg = 'chore(data): 同步投影 · 净资产 ¥1,234.56 · 12 条\n\nSuiji-Networth-Cents: 123456\nSuiji-Records: 12'
    expect(parseNetworth(msg)).toBe(123456)
  })

  it('负数净资产（欠款）不被正则形态影响', () => {
    const msg = 'chore(data): 同步投影 · 净资产 .. · 3 条\n\nSuiji-Networth-Cents: -8500'
    expect(parseNetworth(msg)).toBe(-8500)
  })

  it('trailer 与文案不一致时以 trailer 为准（机器读的才是契约）', () => {
    // 文案被人工改写 / 货币前缀变体：都不该影响曲线
    const msg = 'chore(data): 手改文案 · 净资产 ¥99.00 · 5 条\n\nSuiji-Networth-Cents: 123456'
    expect(parseNetworth(msg)).toBe(123456)
  })

  it('文案里出现两次"净资产"也不会错取', () => {
    const msg = 'chore(data): 净资产对比 ¥1,000.00 · 净资产 ¥2,000.00 · 8 条\n\nSuiji-Networth-Cents: 200000'
    expect(parseNetworth(msg)).toBe(200000)
  })
})

describe('parseNetworth：旧提交兼容通道', () => {
  it('没有 trailer 时回落旧正则', () => {
    expect(parseNetworth('chore(data): 同步投影 · 净资产 1,234.56 · 12 条')).toBe(123456)
  })

  it('旧格式负数', () => {
    expect(parseNetworth('chore(data): 同步投影 · 净资产 -12.34 · 2 条')).toBe(-1234)
  })

  it('两种情况都不匹配时返回 null（历史页不画假点）', () => {
    expect(parseNetworth('chore(data): resolve-conflict 2 local / 1 remote')).toBeNull()
    expect(parseNetworth('')).toBeNull()
    expect(parseNetworth(null as unknown as string)).toBeNull()
  })

  it('trailer 值非整数（损坏）时不被当作数字', () => {
    // 半截 trailer（例如被编辑器截断）不能折成 12 → 曲线会凭空多一个点
    expect(parseNetworth('chore(data): x · 净资产 12.00\n\nSuiji-Networth-Cents: 12.5')).toBe(1200)
  })
})

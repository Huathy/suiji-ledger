// 钱迹导出文件解析器 + 月度快照聚合器 单测
import { describe, it, expect } from 'vitest'
import { parseQianjiFile, aggregateQianji } from '../apps/web/src/import/qianji'

const CSV = [
  'ID,时间,账本,分类,二级分类,类型,金额,币种,账户1,账户2,备注,已报销,手续费,优惠券,记账者,账单标记,标签,账单图片,关联账单',
  'qj1,2025-08-10 10:00:00,账本,分类,,收入,12000.00,￥,招商银行卡,,工资,,,,me,,,',
  'qj2,2025-08-12 12:00:00,账本,分类,,支出,300.00,￥,招商银行卡,,餐饮,,,,me,,,',
  'qj3,2025-08-15 09:00:00,账本,分类,,转账,500.00,￥,招商银行卡,微信钱包,充值,,3.00,,me,,,',
  'qj4,2025-09-01 08:00:00,账本,分类,,支出,600.00,￥,微信钱包,,购物,,,100.00,me,,,',
  'qj5,2025-09-10 10:00:00,账本,分类,,还款,2000.00,￥,招商银行卡,信用卡欠款,还款,,,,me,,,',
  'qj6,2025-09-20 10:00:00,账本,分类,,借出,1000.00,￥,招商银行卡,,借出,,,,me,,,',
  'qj7,2025-10-01 09:00:00,账本,分类,,收入,8000.00,￥,招商银行卡,,工资,,,,me,,,',
  'qj8,2025-10-06 12:00:00,账本,分类,,已报销,450.00,￥,微信钱包,,聚合行,,,,me,,,',
].join('\r\n')

async function parse(): Promise<ReturnType<typeof aggregateQianji>> {
  const file = new File([CSV], 'qianji.csv')
  const parsed = await parseQianjiFile(file)
  expect(parsed.bills.length).toBe(7) // 已报销聚合行跳过
  return aggregateQianji(parsed.bills, { 招商银行卡: 5000000 }, {})
}

function balanceOf(agg: any, name: string, ym: string): number {
  const p = agg.payloads.find((x: any) => x.accountName === name && x.ym === ym)
  expect(p, `${name} ${ym} 应有快照`).toBeTruthy()
  return p.balance
}

describe('钱迹解析 + 聚合', () => {
  it('19 列解析：收入/支出/转账(含手续费)/还款/借出，聚合行跳过', async () => {
    const agg = await parse()
    // 招行（期初 50,000）：08末 61197 = 50000+12000-300-503(转账500+手续费3)；09末 58197（-还款2000-借出1000）；10末 66197（+8000）
    expect(balanceOf(agg, '招商银行卡', '2025-08')).toBe(6119700)
    expect(balanceOf(agg, '招商银行卡', '2025-09')).toBe(5819700)
    expect(balanceOf(agg, '招商银行卡', '2025-10')).toBe(6619700)
    // 微信：08末 500；09末 0（支出 600 含券 100 实扣 500）；10末 0
    expect(balanceOf(agg, '微信钱包', '2025-08')).toBe(50000)
    expect(balanceOf(agg, '微信钱包', '2025-09')).toBe(0)
    // 信用卡：09末 2000（欠款正数）
    expect(balanceOf(agg, '信用卡欠款', '2025-09')).toBe(200000)
    expect(agg.snapshotCount).toBe(8) // 招行3 + 微信3 + 信用卡2
  })
  it('逐月填充：无活动月份余额延续（信用卡 10 月保持 2000）', async () => {
    const agg = await parse()
    expect(balanceOf(agg, '信用卡欠款', '2025-10')).toBe(200000)
  })
})

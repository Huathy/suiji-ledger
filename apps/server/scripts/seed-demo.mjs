// 演示数据脚本：清空并重建示例账本（与 UI 设计稿数字一致）
// 运行：node scripts/seed-demo.mjs  （服务需已启动，口令可用环境变量 SJ_PWD 覆盖，默认 test123456）
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const BASE = process.env.SJ_BASE || 'http://localhost:3000/api'
const PWD = process.env.SJ_PWD || 'test123456'

async function api(path, opts = {}, token = '') {
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(path + ' -> ' + JSON.stringify(data))
  return data
}

async function main() {
  // 1. 清空业务数据（保留用户口令与设置；重建内置平账类型）
  await prisma.changeEntry.deleteMany()
  await prisma.monthlySnapshot.deleteMany()
  await prisma.account.deleteMany()
  await prisma.recordType.deleteMany()
  await prisma.recordType.create({ data: { name: '平账', emoji: '⚖️', direction: 'neutral', builtin: true, sort: 0 } })

  // 2. 登录
  const { token } = await api('/auth/login', { method: 'POST', body: { password: PWD } })

  // 3. 类型与账户（示例账本，与设计稿一致）
  const wage = await api('/types', { method: 'POST', body: { name: '工资', emoji: '💼', direction: 'income' } }, token)
  const invest = await api('/types', { method: 'POST', body: { name: '投资', emoji: '📈', direction: 'income' } }, token)
  const accounts = []
  for (const a of [
    { name: '招商银行卡', emoji: '🏦', kind: 'asset', group: '现金与储蓄', initBalance: 5570000 },
    { name: '基金账户', emoji: '📈', kind: 'asset', group: '投资', initBalance: 2100000 },
    { name: '微信钱包', emoji: '🟢', kind: 'asset', group: '网络资产', initBalance: 47650 },
    { name: '支付宝余额', emoji: '🔵', kind: 'asset', group: '网络资产', initBalance: 221000 },
    { name: '现金', emoji: '💵', kind: 'asset', group: '现金与储蓄', initBalance: 120000 },
    { name: '信用卡欠款', emoji: '💳', kind: 'liability', group: '负债', initBalance: 1586800 },
  ]) {
    accounts.push(await api('/accounts', { method: 'POST', body: a }, token))
  }
  const id = (name) => accounts.find((a) => a.name === name).id

  // 4. 九月基线平账 + 十月平账（工资 12,000 / 投资 2,000 → 平账 −9,355）
  const bal9 = [
    [id('招商银行卡'), 5570000], [id('基金账户'), 2100000], [id('微信钱包'), 47650],
    [id('支付宝余额'), 221000], [id('现金'), 120000], [id('信用卡欠款'), 1586800],
  ]
  await api('/reconcile', {
    method: 'POST',
    body: { ym: '2026-09', recordDate: '2026-09-30', balances: bal9.map(([accountId, balance]) => ({ accountId, balance })), bigItems: [] },
  }, token)
  const oct = await api('/reconcile', {
    method: 'POST',
    body: {
      ym: '2026-10', recordDate: '2026-10-24',
      balances: [
        [id('招商银行卡'), 5890000], [id('基金账户'), 2300000], [id('微信钱包'), 32650],
        [id('支付宝余额'), 180500], [id('现金'), 120000], [id('信用卡欠款'), 1586800],
      ].map(([accountId, balance]) => ({ accountId, balance })),
      bigItems: [
        { typeId: wage.id, amount: 1200000, note: '10月发薪' },
        { typeId: invest.id, amount: 200000, note: '净值上涨' },
      ],
    },
  }, token)

  console.log('演示数据已重建：')
  console.log('  净资产', (oct.networth / 100).toFixed(2), '· 结余', (oct.delta / 100).toFixed(2),
    '· 平账', (oct.autoEntry.amount / 100).toFixed(2), '· 日均', (oct.interval.dailyAvg / 100).toFixed(2))
}

main().finally(() => prisma.$disconnect())

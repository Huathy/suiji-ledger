/**
 * 钱迹导出文件解析与月度快照聚合器（浏览器端，xlsx/csv 双格式）。
 * 格式规格来自逆向确认（.docs/.history/02_需求规格说明书.md §5，钱迹 v4.5.3）：
 * 19 列：ID, 时间, 账本, 分类, 二级分类, 类型, 金额, 币种, 账户1, 账户2, 备注,
 *        已报销, 手续费, 优惠券, 记账者, 账单标记, 标签, 账单图片, 关联账单
 * ID 形如 qj{billid}；类型为中文；金额为元。
 */
import * as XLSX from 'xlsx'
import { toCents } from '../../../../packages/shared/src/index'

export interface QianjiBill {
  billId: string
  dateStr: string
  ym: string
  type: string
  moneyCents: number // 正数，元→分
  account1: string
  account2: string
  feeCents: number // 手续费（正）
  couponCents: number // 优惠券（正）
}

export interface QianjiParsed {
  bills: QianjiBill[]
  skipped: { reason: string; count: number }[]
  sheetName: string
}

/** 类型中文 → 对（账户1符号, 账户2符号）；账户2 为 0 表示不参与 */
const TYPE_RULES: Record<string, [number, number]> = {
  支出: [-1, 0],
  收入: [1, 0],
  转账: [-1, 1],
  还款: [-1, 1], // 信用卡还款：账户1 资金 −，账户2 信用卡 +
  报销: [-1, 0],
  退款: [1, 0],
  借入: [1, 0],
  借出: [-1, 0],
  收款: [1, 0], // 近似：回款进账户1
  利息支出: [-1, 0],
  利息收入: [1, 0],
}

function cellStr(row: any[], i: number): string {
  const v = row?.[i]
  if (v === undefined || v === null) return ''
  return String(v).trim()
}

/** 自带 CSV 解析（引号/转义/BOM 兼容）——不用 SheetJS 解析 CSV，避免它改写日期格式与时区偏移 */
function parseCsvText(text: string): string[][] {
  const rows: string[][] = []
  let cur: string[] = []
  let field = ''
  let inQ = false
  const push = () => { cur.push(field); rows.push(cur); cur = []; field = '' }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else inQ = false
      } else field += ch
    } else if (ch === '"') inQ = true
    else if (ch === ',') { cur.push(field); field = '' }
    else if (ch === '\n') push()
    else if (ch !== '\r') field += ch
  }
  if (field !== '' || cur.length) push()
  return rows
}

/** 解析钱迹导出文件（xlsx 或 csv 字节流），自动定位表头行 */
export async function parseQianjiFile(file: File): Promise<QianjiParsed> {
  const buf = await file.arrayBuffer()
  let rows: any[][]
  let sheetName = 'Sheet1'
  if (/\.csv$/i.test(file.name)) {
    // CSV：先严格 UTF-8，失败回退 GBK；用自带解析器保持日期原样
    const bytes = new Uint8Array(buf)
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      text = new TextDecoder('gbk').decode(bytes)
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    rows = parseCsvText(text)
  } else {
    const wb = XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: false })
    sheetName = wb.SheetNames[0]
    rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
      header: 1, raw: false, defval: '', dateNF: 'yyyy-mm-dd hh:mm:ss',
    })
  }

  // 定位表头行：首列 ID 且含 时间/类型/金额
  let headIdx = rows.findIndex((r) => cellStr(r, 0) === 'ID' && cellStr(r, 1).includes('时间') && cellStr(r, 5).includes('类型'))
  if (headIdx < 0) headIdx = rows.findIndex((r) => cellStr(r, 0) === 'ID')
  if (headIdx < 0) {
    throw new Error('未找到钱迹表头（首列应为 ID，且包含 时间/类型/金额 列）。请确认导出的是钱迹「账单明细」文件')
  }

  const bills: QianjiBill[] = []
  const skipped = new Map<string, number>()
  const skip = (reason: string) => skipped.set(reason, (skipped.get(reason) || 0) + 1)

  for (const row of rows.slice(headIdx + 1)) {
    const id = cellStr(row, 0)
    const dateStr = cellStr(row, 1)
    const typeName = cellStr(row, 5)
    const moneyStr = cellStr(row, 6)
    const account1 = cellStr(row, 8)
    const account2 = cellStr(row, 9)
    const feeStr = cellStr(row, 12)
    const couponStr = cellStr(row, 13)
    if (!id && !dateStr && !moneyStr) continue // 空行
    // 类型 21 已报销 / 22 报销包 是聚合记录，底层支出已计入，跳过防重复
    if (typeName === '已报销' || typeName === '报销包' || typeName === 'ED报销' || typeName === '报销包(已报销)') {
      skip(`聚合行（${typeName}）不计入，防重复`)
      continue
    }
    const rule = TYPE_RULES[typeName]
    if (!rule) {
      skip(`未知类型「${typeName || '空'}」`)
      continue
    }
    const moneyCents = toCents(moneyStr)
    if (moneyCents === null || moneyCents <= 0) {
      skip('金额为空或非法')
      continue
    }
    const ymMatch = dateStr.match(/(\d{4})[-/年.](\d{1,2})/)
    const ym = ymMatch ? `${ymMatch[1]}-${String(Number(ymMatch[2])).padStart(2, '0')}` : ''
    if (!ym) {
      skip('时间无法解析')
      continue
    }
    if (!account1 && !account2) {
      skip('无账户信息')
      continue
    }
    const feeCents = toCents(feeStr) ?? 0
    const couponCents = toCents(couponStr) ?? 0
    bills.push({
      billId: id, dateStr, ym, type: typeName, moneyCents,
      account1: account1 || account2, account2: account1 ? account2 : '',
      feeCents: Math.max(0, feeCents), couponCents: Math.max(0, couponCents),
    })
  }
  return { bills, skipped: [...skipped.entries()].map(([reason, count]) => ({ reason, count })), sheetName }
}

export interface QianjiAccountPreview {
  name: string
  firstYm: string
  lastYm: string
  activeMonths: number
  netFlowCents: number // 文件区间内的净流入
}

export interface QianjiAggregated {
  accounts: QianjiAccountPreview[]
  months: string[] // 全局月份范围（升序）
  snapshotCount: number
  /** 提交载荷 */
  payloads: { ym: string; accountName: string; kind: 'asset' | 'liability'; balance: number; recordDate: string }[]
}

function monthEnd(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`
}

/**
 * 按账户重放每月累计收支 → 月末余额（07 号纪要口径）。
 * openingBalances: 账户名 → 期初余额（分，导入起点之前已有的钱）。
 * 快照覆盖：账户首个活跃月 → 全局最后月，逐月填充（保证任意月份净资产完整）。
 */
export function aggregateQianji(bills: QianjiBill[], opening: Record<string, number>, kinds: Record<string, 'asset' | 'liability'>): QianjiAggregated {
  // 每账户每月净流量
  const flow = new Map<string, Map<string, number>>() // account -> ym -> cents
  for (const b of bills) {
    const rule = TYPE_RULES[b.type]
    const apply = (acc: string, sign: number, cents: number) => {
      if (!acc || sign === 0 || cents === 0) return
      if (!flow.has(acc)) flow.set(acc, new Map())
      const byMonth = flow.get(acc)!
      byMonth.set(b.ym, (byMonth.get(b.ym) || 0) + sign * cents)
    }
    // 支出/报销：优惠券抵扣，实际扣款 = money − coupon；转账/还款手续费从账户1 额外扣
    const isSpendLike = b.type === '支出' || b.type === '报销'
    const isTransferLike = b.type === '转账' || b.type === '还款'
    if (isSpendLike) {
      apply(b.account1, -1, b.moneyCents - b.couponCents)
    } else if (isTransferLike) {
      apply(b.account1, -1, b.moneyCents + b.feeCents)
      apply(b.account2, 1, b.moneyCents)
    } else {
      apply(b.account1, rule[0], b.moneyCents)
      apply(b.account2, rule[1], b.moneyCents)
    }
  }

  const allMonths = [...new Set(bills.map((b) => b.ym))].sort()
  if (allMonths.length === 0) return { accounts: [], months: [], snapshotCount: 0, payloads: [] }
  const lastMonth = allMonths[allMonths.length - 1]

  const accounts: QianjiAccountPreview[] = []
  const payloads: QianjiAggregated['payloads'] = []
  for (const [name, byMonth] of flow) {
    const activeMonths = [...byMonth.keys()].sort()
    const firstYm = activeMonths[0]
    const kind = kinds[name] || 'asset'
    let running = opening[name] || 0
    // 从首活跃月到最后全局月逐月填充快照（无活动月份余额延续）
    const months = allMonths.filter((m) => m >= firstYm && m <= lastMonth)
    for (const ym of months) {
      running += byMonth.get(ym) || 0
      payloads.push({ ym, accountName: name, kind, balance: running, recordDate: monthEnd(ym) })
    }
    const netFlow = [...byMonth.values()].reduce((s, v) => s + v, 0)
    accounts.push({
      name,
      firstYm,
      lastYm: activeMonths[activeMonths.length - 1],
      activeMonths: activeMonths.length,
      netFlowCents: netFlow,
    })
  }
  accounts.sort((a, b) => a.firstYm.localeCompare(b.firstYm))
  return { accounts, months: allMonths, snapshotCount: payloads.length, payloads }
}

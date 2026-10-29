/** Suiji Ledger 共享类型与纯函数（前后端共用，无框架依赖） */

export type Direction = 'income' | 'expense' | 'neutral'
export type AccountKind = 'asset' | 'liability'

/** 内置类型：平账（差额兜底，不可删） */
export const BUILTIN_PINGZHANG = {
  name: '平账',
  emoji: '⚖️',
  direction: 'neutral' as Direction,
  builtin: true,
}

/** 元（字符串/数字）→ 分（整数）。非法输入返回 null。 */
export function toCents(input: string | number): number | null {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null
    return Math.round(input * 100)
  }
  const s = input.replace(/[,，\s￥¥]/g, '')
  if (s === '' || !/^-?\d*(\.\d{0,2})?$/.test(s)) return null
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100)
}

/** 分 → 元字符串（两位小数） */
export function fromCents(cents: number): string {
  return (cents / 100).toFixed(2)
}

/** 分 → 千分位展示字符串；signed=true 时正数带 + */
export function fmtMoney(cents: number, opts: { signed?: boolean; blankZero?: boolean } = {}): string {
  if (opts.blankZero && cents === 0) return '0'
  const neg = cents < 0
  const abs = Math.abs(cents)
  const s = fromCents(abs).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  if (opts.signed) return (neg ? '−' : '+') + s
  return neg ? '−' + s : s
}

/** 本地时区的 YYYY-MM-DD / YYYY-MM */
export function todayYMD(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
export function ymOf(d = new Date()): string {
  return todayYMD(d).slice(0, 7)
}

/** 某年月的天数 */
export function daysInMonth(ym: string): number {
  const [y, m] = ym.split('-').map(Number)
  if (!y || !m || m < 1 || m > 12) return 31
  return new Date(y, m, 0).getDate()
}

/** 某年月的起止日 YYYY-MM-DD（用于把「记录日」限定在其所属月份内） */
export function ymBounds(ym: string): { start: string; end: string } {
  const last = String(daysInMonth(ym)).padStart(2, '0')
  return { start: `${ym}-01`, end: `${ym}-${last}` }
}

/** 把 YYYY-MM-DD 拆成 DatePicker 需要的 [年, 月, 日] 字符串数组 */
export function ymdToColumns(ymd: string): string[] {
  const [y, m, d] = ymd.split('-')
  return [y, m, d]
}

/** 日期相差天数（b−a），不兜底：可为 0 或负，供调用方做合法性判断 */
export function rawDaysBetween(aYMD: string, bYMD: string): number {
  const [ay, am, ad] = aYMD.split('-').map(Number)
  const [by, bm, bd] = bYMD.split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000)
}

/** 日期串（YYYY-MM-DD）相差天数 b−a；同日按 1 天（两次记录区间约定） */
export function daysBetween(aYMD: string, bYMD: string): number {
  const [ay, am, ad] = aYMD.split('-').map(Number)
  const [by, bm, bd] = bYMD.split('-').map(Number)
  const ms = Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)
  return Math.max(1, Math.round(ms / 86400000))
}

export const YM_RE = /^\d{4}-(0[1-9]|1[0-2])$/
export const YMD_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

export interface IntervalStats {
  days: number
  /** 净资产变化（分） */
  delta: number
  /** 大项收入合计（分） */
  incomeTotal: number
  /** 支出估算（分，正数=花了多少） */
  spendEst: number
  /** 平均每日开销（分） */
  dailyAvg: number
  /** 日均净结余（分） */
  dailyNet: number
  /** 未记任何收入大项时，支出按“资产净减少”估算 */
  estimated: boolean
}

/**
 * 区间统计（会议口径）：
 *   Δ = 本期净资产 − 上期净资产；I = 大项收入合计
 *   支出估算 S = I − Δ（未记收入时 S = −Δ，estimated=true）
 *   日均开销 = S / 天数；日均净结余 = Δ / 天数
 */
export function computeIntervalStats(delta: number, incomeTotal: number, days: number): IntervalStats {
  const d = Math.max(1, days)
  const hasIncome = incomeTotal > 0
  const spendEst = hasIncome ? incomeTotal - delta : -delta
  return {
    days: d,
    delta,
    incomeTotal,
    spendEst,
    dailyAvg: Math.round(spendEst / d),
    dailyNet: Math.round(delta / d),
    estimated: !hasIncome,
  }
}

export const directionLabel: Record<Direction, string> = {
  income: '收入',
  expense: '支出',
  neutral: '中性',
}

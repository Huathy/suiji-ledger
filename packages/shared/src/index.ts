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

/** 本地时区的 YYYY-MM-DD HH:mm:ss（备份内容里的可读导出时间） */
export function stampText(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${todayYMD(d)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * 文件名时间戳：YYYYMMDD-HHMMSS（本地时区）。
 * 导出 CSV / JSON / Excel 一律带上，避免同名覆盖、便于对账（问题 3）。
 */
export function fileStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 上一个月的 YYYY-MM（跨年） */
export function prevYm(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

/** 同去年同月 YYYY-MM */
export function yoyYm(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return `${y - 1}-${String(m).padStart(2, '0')}`
}

/**
 * 环比/同比百分比变化：(cur − prev) / |prev| × 100。
 * prev 缺失或为 0 时返回 null（无法计算增长率，调用方显示「—」）。
 */
export function pctChange(cur: number | null | undefined, prev: number | null | undefined): number | null {
  if (cur === null || cur === undefined || prev === null || prev === undefined || prev === 0) return null
  return ((cur - prev) / Math.abs(prev)) * 100
}

/** 百分比展示：+3.2% / −1.4%，null → 「—」 */
export function fmtPct(p: number | null, digits = 1): string {
  if (p === null || !Number.isFinite(p)) return '—'
  const s = Math.abs(p).toFixed(digits)
  return (p > 0 ? '+' : p < 0 ? '−' : '') + s + '%'
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

/**
 * 排序设置键（存在 settings 表 / 离线 db.settings 里，值为 JSON 数组字符串）：
 * - groupOrder：账户分组的自定义顺序（问题 2）。账户本身已有 sort 字段，
 *   分组没有实体，故分组顺序存在设置里；没设置时沿用「按小计金额」顺序。
 * - groupSortMode：分组排序方式 total | name | custom
 * - timeSortDir：全站时间排序方向 desc（倒序，默认）| asc（顺序），跟随账号同步
 */
export const GROUP_ORDER_KEY = 'groupOrder'
export const GROUP_SORT_MODE_KEY = 'groupSortMode'
export const TIME_SORT_DIR_KEY = 'timeSortDir'

/** 解析顺序数组设置值；非法/空返回 null（表示未自定义排序） */
export function parseOrder(raw: string | undefined | null): string[] | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) && v.length ? v.map(String) : null
  } catch {
    return null
  }
}

/**
 * 时间排序方向：desc = 倒序（新的在前，历史默认习惯）；asc = 顺序（旧的在前，便于顺着看增长）。
 * 全站所有「按时间排」的列表（月份总表 / 账户历史 / 搜索结果 / 借还台账 / 回收站 /
 * 月度变动构成）共用这一个语义，前端一个开关即可整体翻转。
 */
export type TimeSortDir = 'desc' | 'asc'

/** 解析时间排序方向设置值；非法/缺失一律回退默认（desc，保持老行为） */
export function parseTimeSortDir(raw: unknown): TimeSortDir {
  return raw === 'asc' ? 'asc' : 'desc'
}

/** 翻转方向（点同一个表头在 倒序/顺序 间来回切） */
export function flipTimeSortDir(dir: TimeSortDir): TimeSortDir {
  return dir === 'asc' ? 'desc' : 'asc'
}

/**
 * 按时间字段排序（不变更入参）。timeOf 返回可比较的时间键
 * （'YYYY-MM' / 'YYYY-MM-DD' / epoch 毫秒或秒，字典序与数值序都与时间序一致）。
 * 同一时间键内用 tieOf（一般是自增 id）作二次键：asc 时后记的在后、
 * desc 时后记的在前，与后端 `orderBy: [{ ym: 'desc' }, { id: 'desc' }]` 同口径。
 */
export function sortByTime<T>(
  list: readonly T[],
  timeOf: (x: T) => string | number,
  dir: TimeSortDir = 'desc',
  tieOf?: (x: T) => number,
): T[] {
  const sign = dir === 'asc' ? 1 : -1
  const out = list.slice()
  out.sort((a, b) => {
    const ta = timeOf(a)
    const tb = timeOf(b)
    let c: number
    if (typeof ta === 'number' && typeof tb === 'number') c = ta - tb
    else {
      // 字符串键（YYYY-MM / YYYY-MM-DD）：按码位比较，字典序 == 时间序，且不受 locale 影响
      const sa = String(ta)
      const sb = String(tb)
      c = sa < sb ? -1 : sa > sb ? 1 : 0
    }
    if (c === 0 && tieOf) c = tieOf(a) - tieOf(b)
    return c * sign
  })
  return out
}

/**
 * 按自定义顺序数组排序（不变更入参）：order 里出现的按给定顺序在前，
 * 未出现的保持原相对顺序排在后。用于分组顺序 / 账户拖拽顺序。
 */
export function applyOrder<T>(list: T[], keyOf: (x: T) => string | number, order: string[] | null): T[] {
  if (!order || !order.length) return list.slice()
  const rank = new Map(order.map((k, i) => [String(k), i]))
  const known: T[] = []
  const rest: T[] = []
  for (const x of list) (rank.has(String(keyOf(x))) ? known : rest).push(x)
  known.sort((a, b) => rank.get(String(keyOf(a)))! - rank.get(String(keyOf(b)))!)
  return [...known, ...rest]
}

// ===================== M4 Git 同步：跨端契约（§8） =====================
//
// 这些形状以前在 `apps/server/src/sync/sync.service.ts`、`apps/web/src/views/SyncView.vue`、
// `apps/web/src/components/SyncBadge.vue`、`apps/web/src/components/SyncConflictDialog.vue`
// 各抄过一份，字段数还不一样（SyncBadge 少 5 个、ConflictItem 与后端手写版不同步）。
// 契约只有一个家：这里。改后端形状时 TS 会同时在 PC/移动端报错，不会静默漂移。

/** `/system/sync/status` 的 `state` 取值（§8.1 状态机） */
export type SyncState = 'unconfigured' | 'idle' | 'syncing' | 'offline' | 'conflict' | 'error' | 'halted'

/** 同步记录类型：由文件名前缀编码（§3；server 侧 `PREFIX_KIND` 是同一套值的映射） */
export type SyncRecordKind = 'entry' | 'account' | 'snapshot' | 'loan' | 'type' | 'setting'

/** 冲突裁决：整条记录 / 单个字段以哪一端为准（§5.6 两个层次） */
export type SyncPick = 'local' | 'remote'

/** 冲突成因：both=两端都改 · edit-delete=一端删一端改 · unparsable=载体不可解析 · encrypted=加密仓不可合并 */
export type SyncConflictType = 'both' | 'edit-delete' | 'unparsable' | 'encrypted'

/** 字段级对照的一行（§5.6.2） */
export type SyncFieldDiff = {
  name: string
  label: string
  base: string | null
  local: string | null
  remote: string | null
  /**
   * both 才需要人判断；local/remote 只有一端动过（界面锁定）；
   * same 两侧取值一致，没有任何需要裁决的东西。
   */
  changed: 'both' | 'local' | 'remote' | 'same'
}

/** 冲突界面的一条（§5.6.1） */
export type SyncConflictItem = {
  key: string
  fileName: string
  kind: SyncRecordKind | null
  title: string
  conflictType: SyncConflictType
  base: string | null
  local: string | null
  remote: string | null
  fields: SyncFieldDiff[]
  recommend: SyncPick
  reason: string
}

/**
 * 单端改动字段的锁定侧（§5.6.2 第 2 条）：`changed==='local'|'remote'` 锁定到动过那端，
 * `both`/`same` 返回 null（前者交人判断、后者无需裁决）。
 *
 * 为什么这条规则必须放 shared：前端画置灰箭头、后端做 payload 清洗都靠它，
 * 两边各写一遍就会出现"界面锁住了但后端仍接受反向覆盖"这种只在一端成立的错觉。
 */
export function lockedSideOf(changed: SyncFieldDiff['changed']): SyncPick | null {
  if (changed === 'local') return 'local'
  if (changed === 'remote') return 'remote'
  return null
}

/** 一条冲突里全部锁定字段：字段名 → 强制取值（前端画锁、后端清洗共用） */
export function lockedFields(fields: readonly SyncFieldDiff[]): Record<string, SyncPick> {
  const out: Record<string, SyncPick> = {}
  for (const f of fields) {
    const side = lockedSideOf(f.changed)
    if (side) out[f.name] = side
  }
  return out
}

/**
 * 单个字段的生效取值（字段级优先于记录级，§5.6 第 1 条）：
 * 锁定字段恒取动过那端；其余按 fieldPicks → 整条 pick → 'local' 兜底。
 */
export function effectiveFieldPick(
  pick: SyncPick,
  field: string,
  fields: readonly SyncFieldDiff[],
  fieldPicks?: Record<string, SyncPick> | null,
): SyncPick {
  const f = fields.find((x) => x.name === field)
  const locked = f ? lockedSideOf(f.changed) : null
  if (locked) return locked
  return fieldPicks?.[field] || pick
}

/** 冲突对这个上下文的展示信息 + 后端返回的附带字段（§8.1） */
export type SyncStatus = {
  state: SyncState
  pendingCommits: number
  lastSyncAt: number | null
  lastError: string | null
  conflictCount: number
  pushMode: string
  mergeEnabled: boolean
  encrypt: boolean
  /** §6.1 preflight 的运行态：whole-file = 合并已关/加密已开，冲突一律整份二选一 */
  mode?: 'merge' | 'whole-file'
  retries: number
  nextRetryAt: number | null
  /** 自动重试已停手的时刻（秒）；state=halted 时非空 */
  haltedAt?: number | null
  /** 后端自动重试上限，文案引用它，前端不另抄一份数字 */
  maxAutoRetries?: number
  /** 本地 head 的 oid（调试/支持用，界面不展示） */
  lastCommitOid?: string | null
}

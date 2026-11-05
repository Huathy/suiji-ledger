/**
 * 离线本地后端：与 NestJS 服务端同一套接口/响应结构，数据存 localStorage。
 * APK 构建启用（VITE_OFFLINE=1），应用完全自持、无服务端依赖。
 * 业务逻辑与 server 侧 months/stats/system service 保持一致（平账恒等式、区间统计公式来自 packages/shared）。
 */
import {
  BUILTIN_PINGZHANG,
  todayYMD,
  computeIntervalStats,
  daysBetween,
  fromCents,
  pctChange,
  stampText,
  yoyYm,
  YM_RE,
  YMD_RE,
  parseTimeSortDir,
  sortByTime,
  type SyncConflictItem as SharedConflictItem,
  type SyncStatus,
  type TimeSortDir,
} from '../../../../packages/shared/src/index'

// 同步引擎（懒加载：isomorphic-git + lightning-fs 体积大，只在进同步页时加载）
type SyncMod = typeof import('./sync-run') & { localSyncAdapter?: any }
let syncMod: SyncMod | null = null
async function getSync(): Promise<SyncMod> {
  if (!syncMod) syncMod = (await import('./sync-run')) as SyncMod
  return syncMod!
}

// ---------- 数据模型 ----------

/**
 * 同步元数据（与服务端 Prisma 五表同结构，见 apps/server/src/sync/record-meta.service.ts）：
 * uid 跨端主键、rev 写入递增、updatedAt 秒级、deleted 墓碑、origin 设备号。
 * 离线 Db 是 localStorage JSON，没有列迁移概念：normalize() 负责给历史行补齐。
 */
interface SyncMeta {
  uid: string | null; rev: number; updatedAt: number; deleted: boolean; origin: string
}
interface Account extends SyncMeta {
  id: number; name: string; emoji: string; kind: 'asset' | 'liability'; group: string | null
  initBalance: number; inNetWorth: boolean; sort: number; archived: boolean
  note: string | null; createdAt: number
}
interface RecordType extends SyncMeta {
  id: number; name: string; emoji: string; color: string | null
  direction: 'income' | 'expense' | 'neutral'; builtin: boolean; sort: number
}
interface Snapshot extends SyncMeta {
  id: number; ym: string; accountId: number; balance: number; recordDate: string; note: string | null
}
interface Entry extends SyncMeta {
  id: number; ym: string; typeId: number; amount: number
  note: string | null; accountId: number | null; auto: boolean
}
interface Loan extends SyncMeta {
  id: number; direction: 'in' | 'out'; counterparty: string; amount: number
  settledAmount: number; date: string; dueDate: string | null; accountId: number | null
  note: string | null; createdAt: number
}
interface TrashItem { id: number; kind: 'entry' | 'loan' | 'account'; summary: string; payload: any; deletedAt: number }
interface Db {
  version: 1
  seq: number
  accounts: Account[]
  types: RecordType[]
  snapshots: Snapshot[]
  entries: Entry[]
  loans: Loan[]
  trash: TrashItem[]
  settings: Record<string, string>
}

const KEY = 'mr_local_db_v1'
const DEFAULT_SETTINGS: Record<string, string> = {
  theme: 'auto', reminderDay: '28', baseCurrency: 'CNY',
  gitRemote: '', gitBranch: 'main', gitAuth: '', gitAuthUser: '', gitPushMode: 'daily', gitEncrypt: 'off',
  gitMergeEnabled: 'on', gitAutoCommit: 'on',
}

function randomUid(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

function metaFresh(deviceId: string): SyncMeta {
  return { uid: randomUid(), rev: 1, updatedAt: Math.floor(Date.now() / 1000), deleted: false, origin: deviceId }
}

function freshDb(): Db {
  // 内置平账类型的 uid 固定即可（单机单库，不会跨端冲突）。
  return {
    version: 1, seq: 2, accounts: [], snapshots: [], entries: [], loans: [], trash: [],
    settings: { ...DEFAULT_SETTINGS, gitDeviceId: '' },
    types: [{ id: 1, uid: 'builtin-pingzhang', rev: 1, updatedAt: 0, deleted: false, origin: '', name: '平账', emoji: '⚖️', color: null, direction: 'neutral' as const, builtin: true, sort: 0 }],
  }
}

/**
 * 结构归一：旧版本（v0.2.x）的库里没有 loans / trash 等集合，
 * 直接使用会在 /loans、/recycle 抛 "Cannot read properties of undefined (reading 'slice')"。
 * 这里补齐缺失集合与内置类型，并保证 seq 大于所有已用 id，避免主键冲突。
 */
function normalize(raw: any): Db {
  const db: Db = {
    version: 1,
    seq: Number.isFinite(raw?.seq) ? Number(raw.seq) : 1,
    accounts: Array.isArray(raw?.accounts) ? raw.accounts : [],
    types: Array.isArray(raw?.types) ? raw.types : [],
    snapshots: Array.isArray(raw?.snapshots) ? raw.snapshots : [],
    entries: Array.isArray(raw?.entries) ? raw.entries : [],
    loans: Array.isArray(raw?.loans) ? raw.loans : [],
    trash: Array.isArray(raw?.trash) ? raw.trash : [],
    settings: raw?.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings) ? raw.settings : {},
  }
  db.accounts = db.accounts.map((a: any) => ({
    ...a,
    group: a?.group ?? null,
    sort: Number.isFinite(a?.sort) ? a.sort : 0,
    inNetWorth: a?.inNetWorth !== false,
    archived: !!a?.archived,
    note: a?.note ?? null,
    uid: typeof a?.uid === 'string' && a.uid ? a.uid : randomUid(),
    rev: Number.isFinite(a?.rev) ? a.rev : 1,
    updatedAt: Number.isFinite(a?.updatedAt) ? a.updatedAt : 0,
    deleted: !!a?.deleted,
    origin: typeof a?.origin === 'string' ? a.origin : '',
  }))
  db.loans = db.loans.map((l: any) => ({
    ...l,
    settledAmount: Number.isFinite(l?.settledAmount) ? l.settledAmount : 0,
    dueDate: l?.dueDate ?? null, accountId: l?.accountId ?? null,
    uid: typeof l?.uid === 'string' && l.uid ? l.uid : randomUid(),
    rev: Number.isFinite(l?.rev) ? l.rev : 1,
    updatedAt: Number.isFinite(l?.updatedAt) ? l.updatedAt : 0,
    deleted: !!l?.deleted,
    origin: typeof l?.origin === 'string' ? l.origin : '',
  }))
  // 其余三表同理：历史行（v0.2.x 无 uid）全部补元数据，否则同步认不出它们
  db.types = db.types.map((t: any) => ({
    ...t,
    uid: typeof t?.uid === 'string' && t.uid ? t.uid : randomUid(),
    rev: Number.isFinite(t?.rev) ? t.rev : 1,
    updatedAt: Number.isFinite(t?.updatedAt) ? t.updatedAt : 0,
    deleted: !!t?.deleted,
    origin: typeof t?.origin === 'string' ? t.origin : '',
  }))
  db.snapshots = db.snapshots.map((s: any) => ({
    ...s,
    uid: typeof s?.uid === 'string' && s.uid ? s.uid : randomUid(),
    rev: Number.isFinite(s?.rev) ? s.rev : 1,
    updatedAt: Number.isFinite(s?.updatedAt) ? s.updatedAt : 0,
    deleted: !!s?.deleted,
    origin: typeof s?.origin === 'string' ? s.origin : '',
  }))
  db.entries = db.entries.map((e: any) => ({
    ...e,
    uid: typeof e?.uid === 'string' && e.uid ? e.uid : randomUid(),
    rev: Number.isFinite(e?.rev) ? e.rev : 1,
    updatedAt: Number.isFinite(e?.updatedAt) ? e.updatedAt : 0,
    deleted: !!e?.deleted,
    origin: typeof e?.origin === 'string' ? e.origin : '',
  }))
  // 快照 uid 派生规则（与服务端 ensureUids 同口径）：`${ym}__${accountUid}`
  for (const s of db.snapshots) {
    const acc = db.accounts.find((a) => a.id === (s as any).accountId)
    const want = acc?.uid ? `${s.ym}__${acc.uid}` : null
    if (want && !String(s.uid || '').includes('__')) s.uid = want
  }
  // deviceId：首次生成落 settings（与服务端 record-meta.deviceId 同语义）
  if (!db.settings.gitDeviceId) {
    const b = new Uint8Array(4)
    crypto.getRandomValues(b)
    db.settings.gitDeviceId = 'd_' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  }
  let maxId = 0
  for (const list of [db.accounts, db.types, db.snapshots, db.entries, db.loans, db.trash]) {
    for (const it of list as { id?: number }[]) {
      if (Number.isFinite(it?.id) && (it.id as number) > maxId) maxId = it.id as number
    }
  }
  if (!db.types.some((t) => t.builtin)) {
    maxId += 1
    db.types.unshift({ id: maxId, uid: 'builtin-pingzhang', rev: 1, updatedAt: 0, deleted: false, origin: '', name: '平账', emoji: '⚖️', color: null, direction: 'neutral', builtin: true, sort: 0 })
  }
  if (!Number.isFinite(db.seq) || db.seq <= maxId) db.seq = maxId + 1
  return db
}

function load(): Db {
  let rawStr = ''
  let raw: any = null
  try {
    rawStr = localStorage.getItem(KEY) || ''
    if (rawStr) raw = JSON.parse(rawStr)
  } catch { /* 损坏则重建 */ }
  if (!raw || raw.version !== 1) {
    const fresh = freshDb()
    persist(fresh)
    return fresh
  }
  const db = normalize(raw)
  // 迁移过就回写，避免每次启动重复处理
  if (JSON.stringify(db) !== rawStr) persist(db)
  return db
}
function persist(db: Db) {
  localStorage.setItem(KEY, JSON.stringify(db))
}

/** 本地自动备份轮转（保留 5 份）：重要变更后调用 */
function localAutoBackup(reason: string) {
  try {
    const slots: { ts: number; reason: string; data: string }[] = JSON.parse(localStorage.getItem('mr_autobak') || '[]')
    slots.unshift({ ts: Date.now(), reason, data: localStorage.getItem(KEY) || '' })
    localStorage.setItem('mr_autobak', JSON.stringify(slots.slice(0, 5)))
  } catch { /* 存储满则忽略 */ }
}
const db = load()

function nextId(): number {
  return db.seq++
}
function builtinType(): RecordType {
  return db.types.find((t) => t.builtin)!
}

/**
 * 同步元数据写路径（与服务端 RecordMetaService 同语义，见其注释）：
 * stamp=新建行（uid 随机 + rev=maxSeen+1）；bump=修改行（rev=max(本地,maxSeen)+1）；
 * tombstone=墓碑（rev 同样前进，对端才看得出"这条删过"）。
 */
function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}
function deviceId(): string {
  return db.settings.gitDeviceId || 'd_tmp'
}
function maxSeen(): number {
  return Number(db.settings.gitMaxRev || 0) || 0
}
function noteSeen(rev: number): void {
  if (!Number.isFinite(rev) || rev <= maxSeen()) return
  db.settings.gitMaxRev = String(rev)
}
function stampMeta(): SyncMeta {
  return { uid: randomUid(), rev: maxSeen() + 1, updatedAt: nowSec(), deleted: false, origin: deviceId() }
}
function bumpMeta(local: { rev?: number | null }): { rev: number; updatedAt: number; origin: string } {
  return { rev: Math.max(Number(local?.rev || 0), maxSeen()) + 1, updatedAt: nowSec(), origin: deviceId() }
}
function tombMeta(local: { rev?: number | null }): { rev: number; updatedAt: number; origin: string; deleted: true } {
  return { ...bumpMeta(local), deleted: true as const }
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}
const bad = (m: string): never => { throw new HttpError(400, m) }
const notFound = (m: string): never => { throw new HttpError(404, m) }

// ---------- 基础计算（与服务端一致） ----------

/**
 * 墓碑过滤（与服务端 allAccounts/allSnaps 同口径）：
 * 删除 = deleted:true 的墓碑行，读路径一律过滤，只留投影/同步能看见它们。
 */
function liveAccounts(): Account[] {
  return db.accounts.filter((a) => !a.deleted)
}
function liveTypes(): RecordType[] {
  return db.types.filter((t) => !t.deleted)
}
function liveSnapshots(): Snapshot[] {
  return db.snapshots.filter((s) => !s.deleted)
}
function liveEntries(): Entry[] {
  return db.entries.filter((e) => !e.deleted)
}
function liveLoans(): Loan[] {
  return db.loans.filter((l) => !l.deleted)
}

function allAccounts(): Account[] {
  return liveAccounts().slice().sort((a, b) => (a.archived === b.archived ? (a.sort - b.sort || a.id - b.id) : a.archived ? 1 : -1))
}
function prevBalanceOf(accountId: number, ym: string): number {
  const acc = liveAccounts().find((a) => a.id === accountId)
  let prev = acc ? acc.initBalance : 0
  for (const s of liveSnapshots().slice().sort((a, b) => (a.ym < b.ym ? -1 : a.ym > b.ym ? 1 : a.id - b.id))) {
    if (s.ym >= ym) break
    if (s.accountId === accountId) prev = s.balance
  }
  return prev
}
function networthOf(ym: string): number {
  let total = 0
  for (const s of liveSnapshots()) {
    if (s.ym !== ym) continue
    const a = liveAccounts().find((x) => x.id === s.accountId)
    if (!a || !a.inNetWorth || a.archived) continue
    total += a.kind === 'liability' ? -s.balance : s.balance
  }
  return total
}
/** 记录点时间轴（升序） */
function pointsAsc(): { ym: string; recordDate: string; networth: number; delta: number | null }[] {
  const yms = [...new Set(liveSnapshots().map((s) => s.ym))].sort()
  const pts = yms.map((ym) => {
    const list = liveSnapshots().filter((s) => s.ym === ym)
    return { ym, recordDate: list.map((s) => s.recordDate).sort().at(-1)!, networth: networthOf(ym), delta: 0 }
  })
  return pts.map((p, i) => ({ ...p, delta: i > 0 ? p.networth - pts[i - 1]!.networth : null }))
}
function entryRows(ym: string) {
  const entries = liveEntries().filter((e) => e.ym === ym).sort((a, b) => (a.auto === b.auto ? a.id - b.id : a.auto ? 1 : -1))
  return entries.map((e) => {
    const t = liveTypes().find((x) => x.id === e.typeId)
    const acc = liveAccounts().find((a) => a.id === e.accountId)
    return {
      id: e.id, ym: e.ym, typeId: e.typeId,
      name: t?.name ?? '未知类型', emoji: t?.emoji ?? '🏷', direction: t?.direction ?? 'neutral',
      amount: e.amount, note: e.note, accountId: e.accountId,
      accountName: acc?.name ?? null, auto: e.auto,
    }
  })
}
function recomputeAuto(ym: string, autoNote?: string) {
  const prevAuto = liveEntries().find((e) => e.ym === ym && e.auto)
  const note = autoNote ?? (prevAuto ? prevAuto.note : null) ?? '（批量记录）'
  db.entries = db.entries.filter((e) => !(e.ym === ym && e.auto))
  const ymSnaps = liveSnapshots().filter((s) => s.ym === ym)
  if (ymSnaps.length === 0) { persist(db); return }
  let delta = 0
  for (const s of ymSnaps) {
    const a = liveAccounts().find((x) => x.id === s.accountId)
    if (!a || !a.inNetWorth || a.archived) continue // 与 networthOf 同口径：归档/不计入账户不参与恒等式
    delta += s.balance - prevBalanceOf(s.accountId, ym)
  }
  const bigSum = liveEntries().filter((e) => e.ym === ym && !e.auto).reduce((s, e) => s + e.amount, 0)
  const bt = builtinType()
  db.entries.push({ id: nextId(), ...stampMeta(), ym, typeId: bt.id, amount: delta - bigSum, note, accountId: null, auto: true })
  persist(db)
}
function monthDetail(ym: string) {
  if (!YM_RE.test(ym)) bad('月份格式应为 YYYY-MM')
  const ymSnaps = liveSnapshots().filter((s) => s.ym === ym)
  const rows = allAccounts().map((a) => {
    const snap = ymSnaps.find((s) => s.accountId === a.id)
    const prev = prevBalanceOf(a.id, ym)
    return {
      id: a.id, name: a.name, emoji: a.emoji, kind: a.kind, group: a.group, inNetWorth: a.inNetWorth, archived: a.archived,
      balance: snap ? snap.balance : null,
      recordDate: snap ? snap.recordDate : null,
      prevBalance: prev,
      delta: snap ? snap.balance - prev : null,
    }
  })
  const networth = networthOf(ym)
  const assetsTotal = rows.filter((r) => r.kind === 'asset' && r.inNetWorth && !r.archived && r.balance !== null).reduce((s, r) => s + (r.balance || 0), 0)
  const liabilityTotal = rows.filter((r) => r.kind === 'liability' && r.inNetWorth && !r.archived && r.balance !== null).reduce((s, r) => s + (r.balance || 0), 0)
  const pts = pointsAsc()
  const idx = pts.findIndex((p) => p.ym === ym)
  const prevPoint = idx > 0 ? pts[idx - 1] : null
  const entries = entryRows(ym)
  const lastRecord = ymSnaps.map((s) => s.recordDate).sort().at(-1) ?? null
  let interval: any = null
  if (ymSnaps.length > 0 && prevPoint) {
    const incomeTotal = entries.filter((e) => !e.auto && e.direction === 'income').reduce((s, e) => s + Math.max(0, e.amount), 0)
    interval = {
      fromDate: prevPoint.recordDate, toDate: lastRecord,
      ...computeIntervalStats(networth - prevPoint.networth, incomeTotal, daysBetween(prevPoint.recordDate, lastRecord!)),
    }
  }
  return {
    ym,
    recordDate: lastRecord,
    reconciled: ymSnaps.length > 0,
    accounts: rows,
    networth,
    prevNetworth: prevPoint ? prevPoint.networth : null,
    delta: prevPoint ? networth - prevPoint.networth : null,
    assetsTotal, liabilityTotal,
    entries,
    bigTotal: entries.filter((e) => !e.auto).reduce((s, e) => s + e.amount, 0),
    incomeTotal: entries.filter((e) => !e.auto && e.direction === 'income').reduce((s, e) => s + Math.max(0, e.amount), 0),
    autoEntry: entries.find((e) => e.auto) ?? null,
    interval,
  }
}
function matrix(limit = 24) {
  const pts = pointsAsc().slice(-limit)
  const accounts = allAccounts().filter((a) => !a.archived)
  const rows = pts.map((p, i) => {
    const ymSnaps = liveSnapshots().filter((s) => s.ym === p.ym)
    const snapByAcc = new Map(ymSnaps.map((s) => [s.accountId, s.balance]))
    const cells = accounts.map((a) => snapByAcc.get(a.id) ?? null)
    const incomeTotal = liveEntries()
      .filter((e) => e.ym === p.ym && !e.auto && liveTypes().find((t) => t.id === e.typeId)?.direction === 'income')
      .reduce((s, e) => s + Math.max(0, e.amount), 0)
    const days = i > 0 ? daysBetween(pts[i - 1]!.recordDate, p.recordDate) : 0
    const interval = i > 0 ? computeIntervalStats(p.delta ?? 0, incomeTotal, days) : null
    return {
      ym: p.ym, recordDate: p.recordDate, cells,
      assetsTotal: accounts.reduce((s, a, j) => s + (a.kind === 'asset' && cells[j] !== null ? (cells[j] as number) : 0), 0),
      networth: p.networth, delta: p.delta,
      dailyAvg: interval ? interval.dailyAvg : null,
      estimated: interval ? interval.estimated : null,
    }
  })
  return { accounts: accounts.map((a) => ({ id: a.id, name: a.name, emoji: a.emoji, kind: a.kind })), rows }
}
/** 与服务端 matrixCsv 同口径：dir 只翻行序（倒序=最新月份在前 / 顺序=最早在前），表头与列不变 */
function matrixCsv(dir: TimeSortDir = 'desc'): string {
  const m = matrix(120)
  const ordered = sortByTime(m.rows, (r) => r.ym, dir)
  const head = ['月份', '记录日', ...m.accounts.map((a) => `${a.emoji}${a.name}${a.kind === 'liability' ? '(欠)' : ''}`), '总资产', '净资产', '结余', '日均开销(估)']
  const lines = [head.join(',')]
  for (const r of ordered) {
    const daily = r.dailyAvg === null ? '' : fromCents(r.dailyAvg) + (r.estimated ? '*' : '')
    lines.push([
      r.ym, r.recordDate,
      ...r.cells.map((v: number | null) => (v === null ? '' : fromCents(v))),
      fromCents(r.assetsTotal), fromCents(r.networth),
      r.delta === null ? '' : fromCents(r.delta), daily,
    ].join(','))
  }
  // 末尾附导出时间（问题 3），与服务端 matrixCsv 保持一致
  lines.push('')
  lines.push(`# 导出时间,${stampText()}`)
  return '\uFEFF' + lines.join('\r\n')
}

// ---------- 路由处理 ----------

/**
 * `path` 里的查询参数；无 `?` 或空 query 返回空实例（11 处各抄一遍的 `path.split('?')[1] || ''` 收到这里）。
 *
 * 这是纯收敛，**不是**顺手修 bug，所以两条原有行为要原样保留（改它等于改语义，必须单独记账）：
 * - query 里再出现 `?` 时只取第一个 `?` 之后的那一段（`split` 的第二段），`a=1?b=2` 解析成 `a=1`。
 *   换成 `indexOf` + `slice(indexOf('?') + 1)` 会把后半截一起吃掉，与原行为不等价。
 * - `#hash` 不剥离：上面 `localHandle` 的 `path.split('?')[0]` 也不处理 hash，全文件一路都不处理。
 *   哪天某个路由真的需要处理 hash，在那个路由里显式写，别在这里静默加分支。
 */
function queryOf(path: string): URLSearchParams {
  const parts = path.split('?')
  return new URLSearchParams(parts.length > 1 ? parts[1] : '')
}

export async function localHandle(method: string, path: string, body?: any): Promise<any> {
  // 剥离查询串后再按段路由；p1=资源, p2=:id, p3=子资源, p4=:id
  const [pathname] = path.split('?')
  const [, p1, p2, p3, p4] = pathname.split('/')
  const m = method.toUpperCase()

  // ---- 认证（离线模式直接放行，保持接口兼容） ----
  if (p1 === 'auth') {
    if (p2 === 'bootstrap') return { hasUser: false }
    if (p2 === 'login' || p2 === 'setup') return { token: 'offline' }
    if (p2 === 'me') return { userId: 0, accounts: db.accounts.length, snapshots: db.snapshots.length }
    if (p2 === 'password') return { ok: true }
  }

  // ---- 账户 ----
  if (p1 === 'accounts' && m === 'GET' && !p2) {
    return allAccounts().map((a) => {
      const last = liveSnapshots().filter((s) => s.accountId === a.id).sort((x, y) => (x.ym < y.ym ? -1 : x.ym > y.ym ? 1 : x.id - y.id)).at(-1)
      return {
        ...a,
        currentYm: last?.ym ?? null,
        balance: last ? last.balance : a.initBalance,
        prevBalance: last ? (last.balance && liveSnapshots().filter((s) => s.accountId === a.id && s.ym < last.ym).sort((x, y) => x.ym.localeCompare(y.ym)).at(-1)?.balance || a.initBalance) : a.initBalance,
      }
    })
  }
  if (p1 === 'accounts' && m === 'POST' && !p2) {
    const name = String(body?.name || '').trim()
    if (!name) bad('请填写账户名称')
    if (!['asset', 'liability'].includes(body?.kind)) bad('账户类型不合法')
    if (!Number.isInteger(body?.initBalance) || body.initBalance < 0) bad('初始余额不合法（分）')
    const acc: Account = {
      id: nextId(), ...stampMeta(),
      name: name.slice(0, 30), emoji: String(body.emoji || '🏦').slice(0, 8),
      kind: body.kind, group: body.group ? String(body.group).slice(0, 30) : null,
      initBalance: body.initBalance, inNetWorth: body.inNetWorth !== false,
      sort: db.accounts.reduce((s, a) => Math.max(s, a.sort), 0) + 1,
      archived: false, note: body.note ? String(body.note).slice(0, 200) : null,
      createdAt: Date.now(),
    }
    db.accounts.push(acc); persist(db)
    return acc
  }
  if (p1 === 'accounts' && p2 && m === 'PATCH') {
    const acc = db.accounts.find((a) => a.id === Number(p2))
    if (!acc || acc.deleted) notFound('账户不存在')
    const accRow = acc!
    const d = body || {}
    if (d.name !== undefined) accRow.name = String(d.name).trim().slice(0, 30)
    if (d.emoji !== undefined) accRow.emoji = String(d.emoji).slice(0, 8)
    if (d.group !== undefined) accRow.group = d.group ? String(d.group).slice(0, 30) : null
    if (d.inNetWorth !== undefined) accRow.inNetWorth = !!d.inNetWorth
    if (d.note !== undefined) accRow.note = d.note ? String(d.note).slice(0, 200) : null
    if (d.archived !== undefined) accRow.archived = !!d.archived
    if (d.sort !== undefined) accRow.sort = Number(d.sort)
    Object.assign(accRow, bumpMeta(accRow))
    persist(db)
    return accRow
  }
  if (p1 === 'accounts' && p2 && m === 'DELETE') {
    const id = Number(p2)
    // 墓碑语义（与服务端 remove() 同款）：物理删会让对端把"我删了"读成"文件消失"，冲突绕开驱动
    if (liveSnapshots().some((s) => s.accountId === id)) bad('该账户已有历史快照，请改用「归档」保留历史')
    const acc = db.accounts.find((a) => a.id === id)!
    if (!acc || acc.deleted) notFound('账户不存在')
    db.trash.push({ id: nextId(), kind: 'account', summary: `账户 ${acc.name}`, payload: { ...acc }, deletedAt: Date.now() })
    Object.assign(acc, tombMeta(acc)); persist(db)
    localAutoBackup('删除账户')
    return { ok: true }
  }

  // ---- 类型 ----
  if (p1 === 'types' && m === 'GET' && !p2) {
    return liveTypes().slice().sort((a, b) => (a.builtin === b.builtin ? a.sort - b.sort || a.id - b.id : a.builtin ? -1 : 1))
      .map((t) => ({ ...t, usageCount: liveEntries().filter((e) => e.typeId === t.id).length }))
  }
  if (p1 === 'types' && m === 'POST' && !p2) {
    const name = String(body?.name || '').trim()
    if (!name) bad('请填写类型名称')
    if (!['income', 'expense', 'neutral'].includes(body?.direction)) bad('收支方向不合法')
    const t: RecordType = {
      id: nextId(), ...stampMeta(),
      name: name.slice(0, 20), emoji: String(body.emoji || '🏷').slice(0, 8),
      color: body.color ? String(body.color).slice(0, 20) : null, direction: body.direction,
      builtin: false, sort: db.types.reduce((s, x) => Math.max(s, x.sort), 0) + 1,
    }
    db.types.push(t); persist(db)
    return t
  }
  if (p1 === 'types' && p2 && m === 'PATCH') {
    const t = db.types.find((x) => x.id === Number(p2))
    if (!t || t.deleted) notFound('类型不存在')
    const tRow = t!
    if (tRow.builtin && body?.name !== undefined && String(body.name).trim() !== tRow.name) bad('内置类型名称不可修改')
    if (tRow.builtin && body?.direction !== undefined && body.direction !== tRow.direction) bad('内置类型方向不可修改')
    if (body?.name !== undefined) tRow.name = String(body.name).trim().slice(0, 20)
    if (body?.emoji !== undefined) tRow.emoji = String(body.emoji).slice(0, 8)
    if (body?.color !== undefined) tRow.color = body.color ? String(body.color).slice(0, 20) : null
    if (body?.direction !== undefined) tRow.direction = body.direction
    Object.assign(tRow, bumpMeta(tRow))
    persist(db)
    return tRow
  }
  if (p1 === 'types' && p2 && m === 'DELETE') {
    const t = db.types.find((x) => x.id === Number(p2))
    if (!t || t.deleted) notFound('类型不存在')
    const tRow = t!
    if (tRow.builtin) bad('内置「平账」类型不可删除')
    const bt = builtinType()
    // 回退条目的类型变了，rev 必须前进，否则对端看不出这些条目变过（与服务端 remove() 同款）
    for (const e of liveEntries()) {
      if (e.typeId === tRow.id) {
        e.typeId = bt.id
        Object.assign(e, bumpMeta(e))
      }
    }
    db.trash.push({ id: nextId(), kind: 'type' as any, summary: `类型 ${tRow.name}`, payload: { ...tRow }, deletedAt: Date.now() })
    Object.assign(tRow, tombMeta(tRow)); persist(db)
    return { ok: true }
  }

  // ---- 月份与平账 ----
  if (p1 === 'months' && m === 'GET') {
    const qs = queryOf(path)
    const limit = Math.min(120, Number(qs.get('limit')) || 60)
    // 与服务端同语义：limit 始终取「最近的 N 个月」，dir 只决定排列方向
    const picked = pointsAsc().reverse().slice(0, limit)
    return { months: parseTimeSortDir(qs.get('dir')) === 'asc' ? picked.slice().reverse() : picked }
  }
  if (p1 === 'month' && p2 && m === 'GET' && !p3) return monthDetail(p2)
  if (p1 === 'reconcile' && m === 'POST') {
    const ym = String(body?.ym || '')
    if (!YM_RE.test(ym)) bad('月份格式应为 YYYY-MM')
    const recordDate = YMD_RE.test(body?.recordDate || '') ? body.recordDate : new Date().toISOString().slice(0, 10)
    const balances: any[] = body?.balances || []
    const bigItems: any[] = body?.bigItems || []
    if (balances.length === 0) bad('请至少填写一个账户余额')
    for (const b of balances) {
      if (!liveAccounts().some((a) => a.id === b.accountId)) bad('包含未知账户')
      if (!Number.isInteger(b.balance) || b.balance < 0) bad('余额须为非负整数（分）')
    }
    for (const it of bigItems) {
      if (!Number.isInteger(it.amount)) bad('大项金额不合法（分）')
      if (!liveTypes().some((t) => t.id === it.typeId)) bad('包含未知类型')
    }
    // 1. 快照 upsert（rev 前进，对端才看得出"这条变过"）
    for (const b of balances) {
      const acc = liveAccounts().find((a) => a.id === b.accountId)
      const existing = db.snapshots.find((s) => !s.deleted && s.ym === ym && s.accountId === b.accountId)
      const note = b.note ?? existing?.note ?? null
      if (existing) {
        const changed = existing.balance !== b.balance || existing.recordDate !== recordDate || existing.note !== note
        if (changed) {
          existing.balance = b.balance; existing.recordDate = recordDate; existing.note = note
          Object.assign(existing, bumpMeta(existing))
        }
      } else {
        const stamp = stampMeta()
        db.snapshots.push({
          id: nextId(), ...stamp,
          uid: acc?.uid ? `${ym}__${acc.uid}` : stamp.uid,
          ym, accountId: b.accountId, balance: b.balance, recordDate, note,
        })
      }
    }
    // 2. 大项按 uid diff（与服务端 planBigItems 同语义，防物理删丢数据）：
    //    对上号的 update（保 uid），本次没出现墓碑，新增的 stamp
    {
      const existing = db.entries.filter((e) => !e.deleted && e.ym === ym && !e.auto)
      const incoming = (bigItems as any[]).filter((it) => it.amount !== 0 || it.note)
      const byUid = new Map(existing.filter((e) => e.uid).map((e) => [e.uid as string, e]))
      const claimed = new Set<number>()
      for (const it of incoming) {
        let target = it.uid ? byUid.get(it.uid) : undefined
        if (!target) {
          target = existing.find(
            (e) => !claimed.has(e.id) && e.typeId === it.typeId && e.amount === it.amount &&
              (e.note ?? null) === (it.note ? String(it.note).slice(0, 200) : null) &&
              (e.accountId ?? null) === (it.accountId ?? null),
          )
        }
        if (!target) {
          db.entries.push({
            id: nextId(), ...stampMeta(), ym, typeId: it.typeId, amount: it.amount,
            note: it.note ? String(it.note).slice(0, 200) : null, accountId: it.accountId ?? null, auto: false,
          })
          continue
        }
        claimed.add(target.id)
        const changed = target.typeId !== it.typeId || target.amount !== it.amount ||
          (target.note ?? null) !== (it.note ? String(it.note).slice(0, 200) : null) ||
          (target.accountId ?? null) !== (it.accountId ?? null)
        if (changed) {
          target.typeId = it.typeId; target.amount = it.amount
          target.note = it.note ? String(it.note).slice(0, 200) : null
          target.accountId = it.accountId ?? null
          Object.assign(target, bumpMeta(target))
        }
      }
      for (const e of existing) {
        if (claimed.has(e.id)) continue
        db.trash.push({ id: nextId(), kind: 'entry', summary: `条目 ${e.note || ''} ${ym}`, payload: { ...e }, deletedAt: Date.now() })
        Object.assign(e, tombMeta(e))
      }
    }
    persist(db)
    recomputeAuto(ym, body?.note ? String(body.note).slice(0, 100) : undefined)
    return monthDetail(ym)
  }
  if (p1 === 'month' && p2 && p3 === 'entry' && m === 'POST') {
    if (!YM_RE.test(p2)) bad('月份格式应为 YYYY-MM')
    if (!Number.isInteger(body?.amount)) bad('金额不合法（分）')
    const t = liveTypes().find((x) => x.id === Number(body?.typeId))
    if (!t) bad('类型不存在')
    const tRow = t!
    db.entries.push({ id: nextId(), ...stampMeta(), ym: p2, typeId: tRow.id, amount: body.amount, note: body?.note ?? null, accountId: body?.accountId ?? null, auto: false })
    persist(db)
    recomputeAuto(p2)
    localAutoBackup('新增大项')
    return monthDetail(p2)
  }
  if (p1 === 'month' && p2 && p3 === 'entry' && p4) {
    const ym = p2
    const e = db.entries.find((x) => x.id === Number(p4) && x.ym === ym && !x.deleted)
    if (!e) notFound('条目不存在')
    const eRow = e!
    if (m === 'PATCH') {
      if (eRow.auto) bad('平账条目由系统自动计算，不可直接编辑')
      if (body?.typeId !== undefined) eRow.typeId = Number(body.typeId)
      if (body?.amount !== undefined) {
        if (!Number.isInteger(body.amount)) bad('金额不合法（分）')
        eRow.amount = body.amount
      }
      if (body?.note !== undefined) eRow.note = body.note ? String(body.note).slice(0, 200) : null
      if (body?.accountId !== undefined) eRow.accountId = body.accountId ?? null
      Object.assign(eRow, bumpMeta(eRow))
      persist(db); recomputeAuto(ym)
      return monthDetail(ym)
    }
    if (m === 'DELETE') {
      if (eRow.auto) bad('平账条目不可删除，会随大项修改自动重算')
      // 墓碑：删除也是"改内容"，rev 前进，对端才看得出删过（R10）
      db.trash.push({ id: nextId(), kind: 'entry', summary: `条目 ${eRow.note || ''} ${ym}`, payload: { ...eRow }, deletedAt: Date.now() })
      Object.assign(eRow, tombMeta(eRow)); persist(db); recomputeAuto(ym)
      localAutoBackup('删除大项')
      return monthDetail(ym)
    }
  }

  // ---- 钱迹导入：批量写入月度快照（手动记录优先，不覆盖） ----
  if (p1 === 'import' && p2 === 'snapshots' && m === 'POST') {
    const rows: any[] = body?.snapshots || []
    if (rows.length === 0) bad('没有可导入的快照')
    const accountsCreated: string[] = []
    const idByName = new Map<string, number>()
    let created = 0
    let skipped = 0
    const touchedYms = new Set<string>()
    for (const r of rows) {
      const ym = String(r.ym || '')
      const accountName = String(r.accountName || '').trim()
      if (!YM_RE.test(ym) || !accountName) { skipped++; continue }
      if (!Number.isInteger(r.balance) || r.balance < 0) { skipped++; continue }
      let accountId = idByName.get(accountName)
      if (!accountId) {
        let acc = liveAccounts().find((a) => a.name === accountName)
        if (!acc) {
          acc = {
            id: nextId(), ...stampMeta(),
            name: accountName.slice(0, 30), emoji: '🏦',
            kind: r.kind === 'liability' ? 'liability' : 'asset',
            group: null, initBalance: 0, inNetWorth: true,
            sort: db.accounts.reduce((s, a) => Math.max(s, a.sort), 0) + 1,
            archived: false, note: '钱迹导入', createdAt: Date.now(),
          }
          db.accounts.push(acc)
          accountsCreated.push(accountName)
        }
        accountId = acc.id
        idByName.set(accountName, accountId)
      }
      if (db.snapshots.some((s) => !s.deleted && s.ym === ym && s.accountId === accountId)) { skipped++; continue }
      const recordDate = YMD_RE.test(r.recordDate || '') ? r.recordDate! : ym + '-28'
      {
        const acc = db.accounts.find((a) => a.id === accountId)!
        const stamp = stampMeta()
        db.snapshots.push({
          id: nextId(), ...stamp, uid: acc?.uid ? `${ym}__${acc.uid}` : stamp.uid,
          ym, accountId, balance: r.balance, recordDate, note: '钱迹导入',
        })
      }
      created++
      touchedYms.add(ym)
    }
    persist(db)
    for (const ym of touchedYms) recomputeAuto(ym)
    return { ok: true, created, skipped, accountsCreated }
  }

  // ---- 单账户快速调余额（随时，单独生成平账记录） ----
  if (p1 === 'accounts' && p2 && p3 === 'set-balance' && m === 'POST') {
    const acc = db.accounts.find((a) => a.id === Number(p2))
    if (!acc || acc.deleted) notFound('账户不存在')
    const accRow = acc!
    const balance = Number(body?.balance)
    if (!Number.isInteger(balance) || balance < 0) bad('余额须为非负整数（分）')
    const note = body?.note ? String(body.note).slice(0, 200) : '余额调整'
    const ym = todayYMD().slice(0, 7)
    const recordDate = todayYMD()
    const existing = db.snapshots.find((x) => !x.deleted && x.ym === ym && x.accountId === accRow.id)
    let prev = accRow.initBalance
    if (!existing) {
      const earlier = db.snapshots.filter((x) => !x.deleted && x.accountId === accRow.id && x.ym < ym).sort((a, b) => b.ym.localeCompare(a.ym))[0]
      if (earlier) prev = earlier.balance
    }
    const oldCurrent = existing ? existing.balance : prev
    const delta = balance - oldCurrent
    if (existing) {
      existing.balance = balance
      existing.recordDate = recordDate
      Object.assign(existing, bumpMeta(existing))
    } else {
      const stamp = stampMeta()
      db.snapshots.push({ id: nextId(), ...stamp, uid: accRow.uid ? `${ym}__${accRow.uid}` : stamp.uid, ym, accountId: accRow.id, balance, recordDate, note: '快速调整' })
    }
    if (delta !== 0) {
      db.entries.push({ id: nextId(), ...stampMeta(), ym, typeId: builtinType().id, amount: delta, note, accountId: accRow.id, auto: false })
    }
    persist(db)
    recomputeAuto(ym)
    localAutoBackup('调整余额')
    return { ok: true, delta, balance }
  }

  // ---- 借入借出台账 ----
  if (p1 === 'loans' && m === 'GET' && !p2) {
    const dir = parseTimeSortDir(queryOf(path).get('dir'))
    const view = sortByTime(liveLoans(), (l) => l.date, dir, (l) => l.id).map((l) => ({
      ...l,
      remaining: l.amount - l.settledAmount,
      status: l.settledAmount >= l.amount ? 'settled' : l.settledAmount > 0 ? 'partial' : 'open',
    }))
    const borrowIn = view.filter((l) => l.direction === 'in' && l.status !== 'settled').reduce((s, l) => s + l.remaining, 0)
    const lendOut = view.filter((l) => l.direction === 'out' && l.status !== 'settled').reduce((s, l) => s + l.remaining, 0)
    return { loans: view, summary: { borrowIn, lendOut } }
  }
  if (p1 === 'loans' && m === 'POST' && !p2) {
    const direction = body?.direction === 'in' || body?.direction === 'out' ? body.direction : null
    if (!direction) bad('借还方向不合法')
    const counterparty = String(body?.counterparty || '').trim()
    if (!counterparty) bad('请填写对方名称')
    if (!Number.isInteger(body?.amount) || body.amount <= 0) bad('金额不合法（分）')
    const loan: Loan = {
      id: nextId(), ...stampMeta(),
      direction, counterparty: counterparty.slice(0, 30), amount: body.amount,
      settledAmount: 0,
      date: /^\d{4}-\d{2}-\d{2}$/.test(body?.date || '') ? body.date : todayYMD(),
      dueDate: /^\d{4}-\d{2}-\d{2}$/.test(body?.dueDate || '') ? body.dueDate : null,
      accountId: Number.isInteger(body?.accountId) ? body.accountId : null,
      note: body?.note ? String(body.note).slice(0, 200) : null,
      createdAt: Date.now(),
    }
    db.loans.push(loan); persist(db)
    return loan
  }
  if (p1 === 'loans' && p2 && p3 === 'settle' && m === 'POST') {
    const loan = db.loans.find((l) => l.id === Number(p2))
    if (!loan || loan.deleted) notFound('借还记录不存在')
    const loanRow = loan!
    if (!Number.isInteger(body?.amount) || body.amount <= 0) bad('金额不合法（分）')
    loanRow.settledAmount = Math.min(loanRow.amount, loanRow.settledAmount + body.amount)
    Object.assign(loanRow, bumpMeta(loanRow))
    persist(db)
    localAutoBackup('借还进度')
    return localHandle('GET', '/loans')
  }
  if (p1 === 'loans' && p2 && p3 === 'close' && m === 'POST') {
    const loan = db.loans.find((l) => l.id === Number(p2))
    if (!loan || loan.deleted) notFound('借还记录不存在')
    const loanRow = loan!
    const mode = body?.mode === 'closed' ? 'closed' : 'settled'
    const tag = mode === 'settled' ? '【已结清】' : '【已结束】'
    if (mode === 'settled') loanRow.settledAmount = loanRow.amount
    if (!(loanRow.note || '').startsWith(tag)) loanRow.note = (tag + ' ' + (loanRow.note || '')).slice(0, 200)
    const mirror = db.accounts.find((a) => !a.deleted && a.name === '债权-' + loanRow.counterparty)
    if (mirror && !mirror.archived) {
      mirror.archived = true
      Object.assign(mirror, bumpMeta(mirror))
    }
    Object.assign(loanRow, bumpMeta(loanRow))
    persist(db)
    localAutoBackup(mode === 'settled' ? '结清借还' : '结束借还')
    return localHandle('GET', '/loans')
  }
  if (p1 === 'loans' && p2 && m === 'PATCH') {
    const loan = db.loans.find((l) => l.id === Number(p2))
    if (!loan || loan.deleted) notFound('借还记录不存在')
    const loanRow = loan!
    if (body?.counterparty !== undefined) {
      const cp = String(body.counterparty).trim()
      if (!cp) bad('对方名称不能为空')
      loanRow.counterparty = cp.slice(0, 30)
    }
    if (body?.amount !== undefined) {
      if (!Number.isInteger(body.amount) || body.amount <= 0) bad('金额不合法（分）')
      loanRow.amount = body.amount
      if (loanRow.settledAmount > body.amount) loanRow.settledAmount = body.amount
    }
    if (body?.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(body.date || '')) loanRow.date = body.date
    if (body?.dueDate !== undefined) loanRow.dueDate = /^\d{4}-\d{2}-\d{2}$/.test(body.dueDate || '') ? body.dueDate : null
    if (body?.accountId !== undefined) loanRow.accountId = Number.isInteger(body.accountId) ? body.accountId : null
    if (body?.note !== undefined) loanRow.note = body.note ? String(body.note).slice(0, 200) : null
    Object.assign(loanRow, bumpMeta(loanRow))
    persist(db)
    localAutoBackup('编辑借还')
    return loanRow
  }
  if (p1 === 'loans' && p2 && m === 'DELETE') {
    const id = Number(p2)
    const loan = db.loans.find((l) => l.id === id)
    if (!loan || loan.deleted) notFound('借还记录不存在')
    const loanRow = loan!
    db.trash.push({ id: nextId(), kind: 'loan', summary: `${loanRow.direction === 'out' ? '借出' : '借入'} ${loanRow.counterparty}`, payload: { ...loanRow }, deletedAt: Date.now() })
    // 墓碑：借还删除同样 rev 前进（与服务端 remove() 同款）
    Object.assign(loanRow, tombMeta(loanRow)); persist(db)
    localAutoBackup('删除借还')
    return { ok: true }
  }

  // ---- 回收站 ----
  if (p1 === 'recycle' && m === 'GET' && !p2) {
    const dir = parseTimeSortDir(queryOf(path).get('dir'))
    return { items: sortByTime(db.trash, (t) => t.deletedAt, dir, (t) => t.id) }
  }
  if (p1 === 'recycle' && p2 && p3 === 'restore' && m === 'POST') {
    const item = db.trash.find((t) => t.id === Number(p2))
    if (!item) notFound('回收站条目不存在')
    const itemRow = item!
    const pl = itemRow.payload
    // 恢复=复活墓碑行 + rev 顶到新值（与服务端 RecycleService 同款 R8）：
    // 沿用旧 rev 会让对端的墓碑继续胜出，出现"恢复了又被同步删掉"
    if (itemRow.kind === 'entry') {
      const local = pl.uid ? db.entries.find((e) => e.uid === pl.uid) : null
      if (local) {
        Object.assign(local, pl, { id: local.id, deleted: false }, bumpMeta(local))
      } else {
        db.entries.push({ ...pl, ...stampMeta(), id: nextId(), uid: pl.uid || randomUid(), deleted: false })
      }
      persist(db); recomputeAuto(pl.ym)
    } else if (itemRow.kind === 'loan') {
      const local = pl.uid ? db.loans.find((l) => l.uid === pl.uid) : null
      if (local) {
        Object.assign(local, pl, { id: local.id, deleted: false }, bumpMeta(local))
      } else {
        db.loans.push({ ...pl, ...stampMeta(), id: nextId(), uid: pl.uid || randomUid(), deleted: false })
      }
      persist(db)
    } else if (itemRow.kind === 'account') {
      const local = pl.uid ? db.accounts.find((a) => a.uid === pl.uid) : db.accounts.find((a) => !a.deleted && a.name === pl.name)
      if (local) {
        Object.assign(local, { deleted: false }, bumpMeta(local))
      } else {
        db.accounts.push({ ...pl, ...stampMeta(), id: nextId(), uid: pl.uid || randomUid(), deleted: false })
      }
      persist(db)
    } else if ((itemRow.kind as string) === 'type') {
      const local = pl.uid ? db.types.find((t) => t.uid === pl.uid) : null
      if (local) {
        Object.assign(local, pl, { id: local.id, deleted: false }, bumpMeta(local))
      } else {
        db.types.push({ ...pl, ...stampMeta(), id: nextId(), uid: pl.uid || randomUid(), deleted: false })
      }
      persist(db)
    } else {
      bad(`回收站不支持恢复该类型：${itemRow.kind}`)
    }
    db.trash = db.trash.filter((t) => t.id !== itemRow.id); persist(db)
    return { ok: true }
  }
  if (p1 === 'recycle' && p2 && m === 'DELETE') {
    db.trash = db.trash.filter((t) => t.id !== Number(p2)); persist(db)
    return { ok: true }
  }
  if (p1 === 'recycle' && m === 'DELETE' && !p2) {
    db.trash = []; persist(db)
    return { ok: true }
  }

  // ---- 跨月搜索 ----
  if (p1 === 'search' && m === 'GET') {
    const qs = queryOf(path)
    const kw = (qs.get('q') || '').trim()
    const dir: TimeSortDir = parseTimeSortDir(qs.get('dir'))
    const min = qs.get('minYuan') ? Math.round(Number(qs.get('minYuan')) * 100) : null
    const max = qs.get('maxYuan') ? Math.round(Number(qs.get('maxYuan')) * 100) : null
    const results = sortByTime(
      liveEntries()
        .filter((e) => !e.auto)
        .filter((e) => (min === null || e.amount >= min) && (max === null || e.amount <= max))
        .filter((e) => {
          if (!kw) return true
          const t = liveTypes().find((x) => x.id === e.typeId)
          const acc = e.accountId ? liveAccounts().find((x) => x.id === e.accountId) : null
          return (e.note || '').includes(kw) || (t?.name || '').includes(kw) || (acc?.name || '').includes(kw)
        }),
      (e) => e.ym,
      dir,
      (e) => e.id,
    )
      .slice(0, 200)
      .map((e) => {
        const t = liveTypes().find((x) => x.id === e.typeId)
        const acc = e.accountId ? liveAccounts().find((x) => x.id === e.accountId) : null
        return { id: e.id, ym: e.ym, typeId: e.typeId, name: t?.name ?? '未知', emoji: t?.emoji ?? '🏷', amount: e.amount, note: e.note, accountName: acc?.name ?? null }
      })
    return { results, matchedAccounts: kw ? liveAccounts().filter((a) => a.name.includes(kw)).map((a) => ({ id: a.id, name: a.name, emoji: a.emoji })) : [] }
  }

  // ---- 统计 ----
  if (p1 === 'stats' && p2 === 'type-contribution') {
    const limit = Math.min(60, Number(queryOf(path).get('limit')) || 12)
    const yms = pointsAsc().slice(0, limit).map((p) => p.ym)
    const sums = new Map<number, number>()
    for (const e of liveEntries()) {
      if (!yms.includes(e.ym)) continue
      const key = e.auto ? -1 : e.typeId
      sums.set(key, (sums.get(key) || 0) + e.amount)
    }
    const items = [...sums.entries()]
      .map(([typeId, total]) => {
        if (typeId === -1) return { typeId: -1, name: '平账（自动）', emoji: '⚖️', direction: 'neutral', total }
        const t = liveTypes().find((x) => x.id === typeId)
        return { typeId, name: t?.name ?? '未知', emoji: t?.emoji ?? '🏷', direction: t?.direction ?? 'neutral', total }
      })
      .sort((a, b) => Math.abs(b.total) - Math.abs(a.total))
    return { months: yms, items }
  }
  if (p1 === 'stats' && p2 === 'networth') {
    const limit = Math.min(120, Number(queryOf(path).get('limit')) || 36)
    return { points: pointsAsc().slice(-limit) }
  }
  if (p1 === 'stats' && p2 === 'daily-avg') {
    const limit = Math.min(60, Number(queryOf(path).get('limit')) || 12)
    const pts = pointsAsc()
    const out = pts.map((p, i) => {
      const incomeTotal = liveEntries()
        .filter((e) => e.ym === p.ym && !e.auto && liveTypes().find((t) => t.id === e.typeId)?.direction === 'income')
        .reduce((s, e) => s + Math.max(0, e.amount), 0)
      const stats = i > 0 ? computeIntervalStats(p.delta ?? 0, incomeTotal, daysBetween(pts[i - 1].recordDate, p.recordDate)) : null
      return {
        ym: p.ym, recordDate: p.recordDate, networth: p.networth, delta: p.delta,
        days: stats ? stats.days : null, spendEst: stats ? stats.spendEst : null,
        dailyAvg: stats ? stats.dailyAvg : null, dailyNet: stats ? stats.dailyNet : null,
        estimated: stats ? stats.estimated : null,
        accountCount: liveSnapshots().filter((s) => s.ym === p.ym).length,
      }
    })
    return { months: out.slice(-limit) }
  }
  if (p1 === 'stats' && p2 === 'summary') {
    // 与 server StatsService.summary 同口径（问题 5：总览环比/同比/日均增减）
    const q = queryOf(path)
    const pts = pointsAsc()
    const curYm = q.get('ym') && YM_RE.test(q.get('ym')!) ? q.get('ym')! : pts.at(-1)?.ym
    if (!curYm) return { ym: null }
    const i = pts.findIndex((p) => p.ym === curYm)
    if (i < 0) return { ym: null } // 该月没有记录点：按「无数据」返回，避免越界取值
    const cur = pts[i]
    const prev = i > 0 ? pts[i - 1] : null
    const yoy = pts.find((p) => p.ym === yoyYm(curYm)) || null
    const incomeOf = (month: string) =>
      db.entries
        .filter((e) => e.ym === month && !e.auto && db.types.find((t) => t.id === e.typeId)?.direction === 'income')
        .reduce((s, e) => s + Math.max(0, e.amount), 0)
    const lastRecordDateOf = (month: string) =>
      db.snapshots.filter((s) => s.ym === month).map((s) => s.recordDate).sort().at(-1) || null
    const dailyAvgOf = (idx: number) => {
      if (idx <= 0) return null
      const p = pts[idx]
      const days = daysBetween(pts[idx - 1].recordDate, lastRecordDateOf(p.ym) || p.recordDate)
      return computeIntervalStats(p.networth - pts[idx - 1].networth, incomeOf(p.ym), days)
    }
    const curStats = dailyAvgOf(i)
    const prevStats = dailyAvgOf(i - 1)
    return {
      ym: curYm,
      networth: cur.networth,
      delta: cur.delta,
      momPct: pctChange(cur.networth, prev ? prev.networth : null),
      yoyPct: pctChange(cur.networth, yoy ? yoy.networth : null),
      prevYm: prev ? prev.ym : null,
      yoyYm: yoy ? yoy.ym : null,
      days: curStats ? curStats.days : null,
      dailyAvg: curStats ? curStats.dailyAvg : null,
      dailyNet: curStats ? curStats.dailyNet : null,
      estimated: curStats ? curStats.estimated : null,
      prevDailyAvg: prevStats ? prevStats.dailyAvg : null,
      dailyAvgDelta: curStats && prevStats ? curStats.dailyAvg - prevStats.dailyAvg : null,
    }
  }
  if (p1 === 'stats' && p2 === 'interval') {
    const q = queryOf(path)
    const fromYm = q.get('from') || '', toYm = q.get('to') || ''
    if (!YM_RE.test(fromYm) || !YM_RE.test(toYm)) bad('月份格式应为 YYYY-MM')
    const pts = pointsAsc()
    const from = pts.find((p) => p.ym === fromYm), to = pts.find((p) => p.ym === toYm)
    if (!from || !to) bad('所选月份没有记录点，请先平账')
    const fromRow = from!
    const toRow = to!
    if (toRow.ym <= fromRow.ym) bad('结束月份需晚于起始月份')
    const incomeTotal = liveEntries()
      .filter((e) => !e.auto && e.ym >= fromRow.ym && e.ym <= toRow.ym && liveTypes().find((t) => t.id === e.typeId)?.direction === 'income')
      .reduce((s, e) => s + Math.max(0, e.amount), 0)
    return {
      fromYm: fromRow.ym, toYm: toRow.ym, fromDate: fromRow.recordDate, toDate: toRow.recordDate,
      ...computeIntervalStats(toRow.networth - fromRow.networth, incomeTotal, daysBetween(fromRow.recordDate, toRow.recordDate)),
    }
  }

  // ---- 系统 ----
  if (p1 === 'system') {
    /**
     * 离线版 Git 同步（直连远端仓库，与服务端同模型）：
     * 引擎在 IndexedDB（lightning-fs），首次用时懒加载；配置在 settings（D11 约束不变）。
     */
    if (p2 === 'sync') {
      const mod = await getSync()
      const { setSyncAdapterHooks } = await import('./sync-adapter')
      setSyncAdapterHooks({
        load: () => db,
        nextId: () => nextId(),
        recomputeYm: (ym: string) => recomputeAuto(ym),
        backup: (reason: string) => localAutoBackup(reason),
        trashKinds: () => undefined,
        persist: () => persist(db),
      })
      const { deps, toSharedConflict } = await import('./sync-adapter')
      const d = deps()
      void toSharedConflict
      if (p3 === 'status') return mod.statusOf(d)
      if (p3 === 'conflicts') {
        const c = d.conflict()
        if (!c) return { items: [], mode: d.cfg().mergeEnabled ? 'merge' : 'whole-file', errorData: null, autoMerged: [] }
        return { items: c.items.map(toSharedConflict), mode: c.mode, errorData: c.errorData, autoMerged: c.autoMerged || [] }
      }
      if (p3 === 'history') {
        const qs = queryOf(path)
        return mod.syncHistory(d, Math.min(200, Number(qs.get('limit')) || 50), Number(qs.get('cursor')) || 0)
      }
      if (p3 === 'diff') return mod.syncDiff(d, String(queryOf(path).get('oid') || body?.oid || ''))
      if (p3 === 'run') {
        const b = body || {}
        const qs = queryOf(path)
        // SyncView 强推走 `POST /system/sync/run?force=lease`（query），与服务端同口径
        return mod.runSync(d, {
          phase: b.phase,
          reason: b.reason,
          forceLease: !!b.forceLease || qs.get('force') === 'lease',
          localOnly: !!b.localOnly,
          userInitiated: b.userInitiated !== false,
        })
      }
      if (p3 === 'resolve') {
        const b = body || {}
        return mod.resolveConflicts(d, b.items || [], b.push !== false)
      }
      if (p3 === 'restore') {
        const b = body || {}
        return mod.syncRestore(d, String(b.oid || ''), b.mode === 'apply' ? 'apply' : 'preview')
      }
      if (p3 === 'conflict') {
        if (m === 'DELETE') return mod.abortConflict(d)
        return { ok: true }
      }
      notFound(`离线模式未实现: ${m} ${path}`)
    }
    if (p2 === 'health') return { ok: true, version: '0.2.0-offline', accounts: liveAccounts().length, snapshots: liveSnapshots().length, entries: liveEntries().length }
    if (p2 === 'settings' && m === 'GET') {
      const { secretSettingKeys, readSyncSettings, maskToken } = await import('./sync-adapter')
      const secrets = new Set(secretSettingKeys())
      const pub: Record<string, string> = {}
      for (const [k, v] of Object.entries(db.settings)) {
        if (!secrets.has(k)) pub[k] = v
      }
      const sync = readSyncSettings(db.settings)
      // 兼容 SyncView（gitAuth/gitAuthMasked）与旧键（gitAuth 明文）：
      // 新键 gitToken 优先，旧键照读；回包同时给新旧两套掩码，前端零改。
      const mask = maskToken(db.settings)
      pub.gitAuthMasked = mask
      pub.tokenMask = mask
      return { settings: { ...DEFAULT_SETTINGS, ...pub }, sync: { ...sync, tokenMask: mask } }
    }
    if (p2 === 'settings' && m === 'PUT') {
      const incoming = { ...(body?.settings || {}) }
      // 同步配置走专用写通道（token 存密文），其它键沿用旧校验
      const { writeSyncSettings, importGitKey, resetEngine } = await import('./sync-adapter')
      // SyncView 发的是 gitAuth（旧键名），新版用 gitToken：两个都认，gitToken 优先
      const syncKeys = ['gitRemote', 'gitBranch', 'gitToken', 'gitAuth', 'gitAuthUser', 'gitPushMode', 'gitMergeEnabled', 'gitEncrypt', 'gitAutoCommit', 'gitKeepCommits', 'gitKey']
      const syncInput: Record<string, string> = {}
      for (const k of syncKeys) {
        if (k in incoming) {
          // 直传 settings 键名（writeSyncSettings 内兼容短键），token/key 做键名归一
          syncInput[k === 'gitToken' || k === 'gitAuth' ? 'token' : k === 'gitKey' ? 'keyImport' : k] = String(incoming[k])
          delete incoming[k]
        }
      }
      for (const [k, v] of Object.entries(incoming)) {
        if (typeof v !== 'string' || v.length > 5000) bad('设置值不合法')
        db.settings[k] = v as string
      }
      if (Object.keys(syncInput).length > 0) {
        if (syncInput.keyImport !== undefined) {
          const ok = importGitKey(String(syncInput.keyImport || ''))
          if (!ok) bad('密钥格式不合法（需 64 位 hex 或 base64，解码后 32 字节）')
          delete syncInput.keyImport
        }
        writeSyncSettings(syncInput)
        resetEngine()
      }
      persist(db)
      return { ok: true, settings: { ...DEFAULT_SETTINGS, ...db.settings } }
    }
    if (p2 === 'matrix' && m === 'GET') {
      const limit = Math.min(120, Number(queryOf(path).get('limit')) || 24)
      return matrix(limit)
    }
    if (p2 === 'matrix.csv') return { csv: matrixCsv(parseTimeSortDir(queryOf(path).get('dir'))) }
    if (p2 === 'backup' && m === 'GET') {
      // 敏感键永不进导出（与服务端 SECRET_KEYS 同口径）：gitAuthEnc/gitConflictState/gitSyncState
      const { secretSettingKeys } = await import('./sync-adapter')
      const secrets = new Set([...secretSettingKeys(), 'gitSyncState', 'gitLastRemoteOid', 'gitMaxRev'])
      return {
        format: 'suiji-ledger-backup', version: 1, exportedAt: Date.now(), exportedAtText: stampText(),
        types: db.types, accounts: db.accounts, snapshots: db.snapshots, entries: db.entries, loans: db.loans,
        settings: Object.entries(db.settings).filter(([k]) => !secrets.has(k)).map(([key, value]) => ({ key, value })),
        meta: { snapshotCount: liveSnapshots().length, entryCount: liveEntries().length },
      }
    }
    if (p2 === 'restore' && m === 'POST') {
      const data = body?.data
      const mode = body?.mode === 'merge' ? 'merge' : 'replace'
      // 兼容旧版本备份（重命名前的 format 标识）
      if (!data || (data.format !== 'suiji-ledger-backup' && data.format !== 'moneyrecord-backup'))
        bad('不是有效的 Suiji Ledger 备份文件')
      if (mode === 'replace') {
        db.entries = []; db.snapshots = []; db.accounts = []; db.types = []; db.loans = []
        db.types.push({ id: nextId(), uid: 'builtin-pingzhang', rev: 1, updatedAt: 0, deleted: false, origin: '', name: '平账', emoji: '⚖️', color: null, direction: 'neutral', builtin: true, sort: 0 })
      }
      const typeMap = new Map<number, number>()
      for (const t of data.types || []) {
        const exist = mode === 'merge' ? db.types.find((x) => !x.deleted && x.name === t.name && x.direction === t.direction) : undefined
        if (exist) typeMap.set(t.id, exist.id)
        else {
          const id = nextId()
          const stamp = t.uid ? { uid: String(t.uid) } : stampMeta()
          db.types.push({ ...stamp, ...t, id, rev: Number(t.rev) || 1, updatedAt: Number(t.updatedAt) || 0, deleted: false, origin: String(t.origin || '') })
          typeMap.set(t.id, id)
        }
      }
      const accMap = new Map<number, number>()
      for (const a of data.accounts || []) {
        const exist = mode === 'merge' ? db.accounts.find((x) => !x.deleted && x.name === a.name && x.kind === a.kind) : undefined
        if (exist) accMap.set(a.id, exist.id)
        else {
          const id = nextId()
          db.accounts.push({ ...stampMeta(), ...a, id })
          accMap.set(a.id, id)
        }
      }
      let imported = 0
      for (const s of data.snapshots || []) {
        const accountId = accMap.get(s.accountId)
        if (!accountId) continue
        const exist = db.snapshots.find((x) => !x.deleted && x.ym === s.ym && x.accountId === accountId)
        if (exist) {
          exist.balance = s.balance; exist.recordDate = s.recordDate; exist.note = s.note ?? null
          Object.assign(exist, bumpMeta(exist))
        } else {
          const acc = db.accounts.find((a) => a.id === accountId)!
          const stamp = stampMeta()
          db.snapshots.push({ ...stamp, uid: s.uid || `${s.ym}__${acc.uid}`, id: nextId(), ym: s.ym, accountId, balance: s.balance, recordDate: s.recordDate, note: s.note ?? null })
        }
        imported++
      }
      for (const e of data.entries || []) {
        const typeId = typeMap.get(e.typeId)
        if (!typeId) continue
        db.entries.push({ ...stampMeta(), ...e, id: nextId(), ym: e.ym, typeId, amount: e.amount, note: e.note ?? null, accountId: e.accountId ? accMap.get(e.accountId) ?? null : null, auto: !!e.auto })
      }
      for (const l of data.loans || []) {
        db.loans.push({
          ...stampMeta(), ...l,
          id: nextId(), direction: l.direction === 'in' ? 'in' : 'out', counterparty: l.counterparty,
          amount: l.amount, settledAmount: l.settledAmount ?? 0, date: l.date,
          dueDate: l.dueDate ?? null, note: l.note ?? null, createdAt: l.createdAt ?? Date.now(),
        })
      }
      persist(db)
      const yms = [...new Set((data.snapshots || []).map((s: any) => String(s?.ym ?? '')))] as string[]
      for (const ym of yms) recomputeAuto(ym)
      return { ok: true, mode, imported }
    }
  }

  throw new HttpError(404, `离线模式未实现: ${method} ${path}`)
}

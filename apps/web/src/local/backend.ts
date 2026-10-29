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
  YM_RE,
  YMD_RE,
} from '../../../../packages/shared/src/index'

// ---------- 数据模型 ----------

interface Account {
  id: number; name: string; emoji: string; kind: 'asset' | 'liability'; group: string | null
  initBalance: number; inNetWorth: boolean; sort: number; archived: boolean
  note: string | null; createdAt: number
}
interface RecordType {
  id: number; name: string; emoji: string; color: string | null
  direction: 'income' | 'expense' | 'neutral'; builtin: boolean; sort: number
}
interface Snapshot { id: number; ym: string; accountId: number; balance: number; recordDate: string; note: string | null }
interface Entry {
  id: number; ym: string; typeId: number; amount: number
  note: string | null; accountId: number | null; auto: boolean
}
interface Loan {
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
  gitRemote: '', gitBranch: 'main', gitAuth: '', gitPushMode: 'daily', gitEncrypt: 'off',
}

function freshDb(): Db {
  return {
    version: 1, seq: 1, accounts: [], types: [], snapshots: [], entries: [], loans: [], trash: [],
    settings: { ...DEFAULT_SETTINGS },
    // 内置平账类型
    ...{ types: [{ id: 1, name: '平账', emoji: '⚖️', color: null, direction: 'neutral' as const, builtin: true, sort: 0 }], seq: 2 },
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
  }))
  db.loans = db.loans.map((l: any) => ({ ...l, settledAmount: Number.isFinite(l?.settledAmount) ? l.settledAmount : 0, dueDate: l?.dueDate ?? null, accountId: l?.accountId ?? null }))
  let maxId = 0
  for (const list of [db.accounts, db.types, db.snapshots, db.entries, db.loans, db.trash]) {
    for (const it of list as { id?: number }[]) {
      if (Number.isFinite(it?.id) && (it.id as number) > maxId) maxId = it.id as number
    }
  }
  if (!db.types.some((t) => t.builtin)) {
    maxId += 1
    db.types.unshift({ id: maxId, name: '平账', emoji: '⚖️', color: null, direction: 'neutral', builtin: true, sort: 0 })
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

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}
const bad = (m: string) => { throw new HttpError(400, m) }
const notFound = (m: string) => { throw new HttpError(404, m) }

// ---------- 基础计算（与服务端一致） ----------

function allAccounts(): Account[] {
  return db.accounts.slice().sort((a, b) => (a.archived === b.archived ? (a.sort - b.sort || a.id - b.id) : a.archived ? 1 : -1))
}
function prevBalanceOf(accountId: number, ym: string): number {
  const acc = db.accounts.find((a) => a.id === accountId)
  let prev = acc ? acc.initBalance : 0
  for (const s of db.snapshots.slice().sort((a, b) => (a.ym < b.ym ? -1 : a.ym > b.ym ? 1 : a.id - b.id))) {
    if (s.ym >= ym) break
    if (s.accountId === accountId) prev = s.balance
  }
  return prev
}
function networthOf(ym: string): number {
  let total = 0
  for (const s of db.snapshots) {
    if (s.ym !== ym) continue
    const a = db.accounts.find((x) => x.id === s.accountId)
    if (!a || !a.inNetWorth || a.archived) continue
    total += a.kind === 'liability' ? -s.balance : s.balance
  }
  return total
}
/** 记录点时间轴（升序） */
function pointsAsc(): { ym: string; recordDate: string; networth: number; delta: number | null }[] {
  const yms = [...new Set(db.snapshots.map((s) => s.ym))].sort()
  const pts = yms.map((ym) => {
    const list = db.snapshots.filter((s) => s.ym === ym)
    return { ym, recordDate: list.map((s) => s.recordDate).sort().at(-1)!, networth: networthOf(ym), delta: 0 }
  })
  return pts.map((p, i) => ({ ...p, delta: i > 0 ? p.networth - pts[i - 1].networth : null }))
}
function entryRows(ym: string) {
  const entries = db.entries.filter((e) => e.ym === ym).sort((a, b) => (a.auto === b.auto ? a.id - b.id : a.auto ? 1 : -1))
  return entries.map((e) => {
    const t = db.types.find((x) => x.id === e.typeId)
    const acc = db.accounts.find((a) => a.id === e.accountId)
    return {
      id: e.id, ym: e.ym, typeId: e.typeId,
      name: t?.name ?? '未知类型', emoji: t?.emoji ?? '🏷', direction: t?.direction ?? 'neutral',
      amount: e.amount, note: e.note, accountId: e.accountId,
      accountName: acc?.name ?? null, auto: e.auto,
    }
  })
}
function recomputeAuto(ym: string, autoNote?: string) {
  const prevAuto = db.entries.find((e) => e.ym === ym && e.auto)
  const note = autoNote ?? (prevAuto ? prevAuto.note : null) ?? '（批量记录）'
  db.entries = db.entries.filter((e) => !(e.ym === ym && e.auto))
  const ymSnaps = db.snapshots.filter((s) => s.ym === ym)
  if (ymSnaps.length === 0) { persist(db); return }
  let delta = 0
  for (const s of ymSnaps) {
    const a = db.accounts.find((x) => x.id === s.accountId)
    if (!a || !a.inNetWorth || a.archived) continue // 与 networthOf 同口径：归档/不计入账户不参与恒等式
    delta += s.balance - prevBalanceOf(s.accountId, ym)
  }
  const bigSum = db.entries.filter((e) => e.ym === ym && !e.auto).reduce((s, e) => s + e.amount, 0)
  const bt = builtinType()
  db.entries.push({ id: nextId(), ym, typeId: bt.id, amount: delta - bigSum, note, accountId: null, auto: true })
  persist(db)
}
function monthDetail(ym: string) {
  if (!YM_RE.test(ym)) bad('月份格式应为 YYYY-MM')
  const ymSnaps = db.snapshots.filter((s) => s.ym === ym)
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
    const ymSnaps = db.snapshots.filter((s) => s.ym === p.ym)
    const cells = accounts.map((a) => ymSnaps.find((x) => x.accountId === a.id)?.balance ?? null)
    const incomeTotal = db.entries
      .filter((e) => e.ym === p.ym && !e.auto && db.types.find((t) => t.id === e.typeId)?.direction === 'income')
      .reduce((s, e) => s + Math.max(0, e.amount), 0)
    const days = i > 0 ? daysBetween(pts[i - 1].recordDate, p.recordDate) : 0
    const interval = i > 0 ? computeIntervalStats(p.delta ?? 0, incomeTotal, days) : null
    return {
      ym: p.ym, recordDate: p.recordDate, cells,
      assetsTotal: cells.reduce((s, v, j) => s + (accounts[j].kind === 'asset' && v !== null ? v : 0), 0),
      networth: p.networth, delta: p.delta,
      dailyAvg: interval ? interval.dailyAvg : null,
      estimated: interval ? interval.estimated : null,
    }
  })
  return { accounts: accounts.map((a) => ({ id: a.id, name: a.name, emoji: a.emoji, kind: a.kind })), rows }
}
function matrixCsv(): string {
  const m = matrix(120)
  const head = ['月份', '记录日', ...m.accounts.map((a) => `${a.emoji}${a.name}${a.kind === 'liability' ? '(欠)' : ''}`), '总资产', '净资产', '结余', '日均开销(估)']
  const lines = [head.join(',')]
  for (const r of m.rows) {
    const daily = r.dailyAvg === null ? '' : fromCents(r.dailyAvg) + (r.estimated ? '*' : '')
    lines.push([
      r.ym, r.recordDate,
      ...r.cells.map((v: number | null) => (v === null ? '' : fromCents(v))),
      fromCents(r.assetsTotal), fromCents(r.networth),
      r.delta === null ? '' : fromCents(r.delta), daily,
    ].join(','))
  }
  return '\uFEFF' + lines.join('\r\n')
}

// ---------- 路由处理 ----------

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
      const last = db.snapshots.filter((s) => s.accountId === a.id).sort((x, y) => (x.ym < y.ym ? -1 : x.ym > y.ym ? 1 : x.id - y.id)).at(-1)
      return {
        ...a,
        currentYm: last?.ym ?? null,
        balance: last ? last.balance : a.initBalance,
        prevBalance: last ? (last.balance && db.snapshots.filter((s) => s.accountId === a.id && s.ym < last.ym).sort((x, y) => x.ym.localeCompare(y.ym)).at(-1)?.balance || a.initBalance) : a.initBalance,
      }
    })
  }
  if (p1 === 'accounts' && m === 'POST' && !p2) {
    const name = String(body?.name || '').trim()
    if (!name) bad('请填写账户名称')
    if (!['asset', 'liability'].includes(body?.kind)) bad('账户类型不合法')
    if (!Number.isInteger(body?.initBalance) || body.initBalance < 0) bad('初始余额不合法（分）')
    const acc: Account = {
      id: nextId(), name: name.slice(0, 30), emoji: String(body.emoji || '🏦').slice(0, 8),
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
    if (!acc) notFound('账户不存在')
    const d = body || {}
    if (d.name !== undefined) acc.name = String(d.name).trim().slice(0, 30)
    if (d.emoji !== undefined) acc.emoji = String(d.emoji).slice(0, 8)
    if (d.group !== undefined) acc.group = d.group ? String(d.group).slice(0, 30) : null
    if (d.inNetWorth !== undefined) acc.inNetWorth = !!d.inNetWorth
    if (d.note !== undefined) acc.note = d.note ? String(d.note).slice(0, 200) : null
    if (d.archived !== undefined) acc.archived = !!d.archived
    if (d.sort !== undefined) acc.sort = Number(d.sort)
    persist(db)
    return acc
  }
  if (p1 === 'accounts' && p2 && m === 'DELETE') {
    const id = Number(p2)
    if (db.snapshots.some((s) => s.accountId === id)) bad('该账户已有历史快照，请改用「归档」保留历史')
    const acc = db.accounts.find((a) => a.id === id)!
    db.trash.push({ id: nextId(), kind: 'account', summary: `账户 ${acc.name}`, payload: acc, deletedAt: Date.now() })
    db.accounts = db.accounts.filter((a) => a.id !== id); persist(db)
    localAutoBackup('删除账户')
    return { ok: true }
  }

  // ---- 类型 ----
  if (p1 === 'types' && m === 'GET' && !p2) {
    return db.types.slice().sort((a, b) => (a.builtin === b.builtin ? a.sort - b.sort || a.id - b.id : a.builtin ? -1 : 1))
      .map((t) => ({ ...t, usageCount: db.entries.filter((e) => e.typeId === t.id).length }))
  }
  if (p1 === 'types' && m === 'POST' && !p2) {
    const name = String(body?.name || '').trim()
    if (!name) bad('请填写类型名称')
    if (!['income', 'expense', 'neutral'].includes(body?.direction)) bad('收支方向不合法')
    const t: RecordType = {
      id: nextId(), name: name.slice(0, 20), emoji: String(body.emoji || '🏷').slice(0, 8),
      color: body.color ? String(body.color).slice(0, 20) : null, direction: body.direction,
      builtin: false, sort: db.types.reduce((s, x) => Math.max(s, x.sort), 0) + 1,
    }
    db.types.push(t); persist(db)
    return t
  }
  if (p1 === 'types' && p2 && m === 'PATCH') {
    const t = db.types.find((x) => x.id === Number(p2))
    if (!t) notFound('类型不存在')
    if (t.builtin && body?.name !== undefined && String(body.name).trim() !== t.name) bad('内置类型名称不可修改')
    if (t.builtin && body?.direction !== undefined && body.direction !== t.direction) bad('内置类型方向不可修改')
    if (body?.name !== undefined) t.name = String(body.name).trim().slice(0, 20)
    if (body?.emoji !== undefined) t.emoji = String(body.emoji).slice(0, 8)
    if (body?.color !== undefined) t.color = body.color ? String(body.color).slice(0, 20) : null
    if (body?.direction !== undefined) t.direction = body.direction
    persist(db)
    return t
  }
  if (p1 === 'types' && p2 && m === 'DELETE') {
    const t = db.types.find((x) => x.id === Number(p2))
    if (!t) notFound('类型不存在')
    if (t.builtin) bad('内置「平账」类型不可删除')
    const bt = builtinType()
    for (const e of db.entries) if (e.typeId === t.id) e.typeId = bt.id
    db.types = db.types.filter((x) => x.id !== t.id); persist(db)
    return { ok: true }
  }

  // ---- 月份与平账 ----
  if (p1 === 'months' && m === 'GET') {
    const limit = Math.min(120, Number(new URLSearchParams(path.split('?')[1] || '').get('limit')) || 60)
    const pts = pointsAsc().reverse().slice(0, limit)
    return { months: pts }
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
      if (!db.accounts.some((a) => a.id === b.accountId)) bad('包含未知账户')
      if (!Number.isInteger(b.balance) || b.balance < 0) bad('余额须为非负整数（分）')
    }
    for (const it of bigItems) {
      if (!Number.isInteger(it.amount)) bad('大项金额不合法（分）')
      if (!db.types.some((t) => t.id === it.typeId)) bad('包含未知类型')
    }
    for (const b of balances) {
      const existing = db.snapshots.find((s) => s.ym === ym && s.accountId === b.accountId)
      if (existing) {
        existing.balance = b.balance; existing.recordDate = recordDate
        if (b.note !== undefined) existing.note = b.note ?? existing.note
      } else {
        db.snapshots.push({ id: nextId(), ym, accountId: b.accountId, balance: b.balance, recordDate, note: b.note ?? null })
      }
    }
    db.entries = db.entries.filter((e) => !(e.ym === ym && !e.auto))
    for (const it of bigItems) {
      if (it.amount === 0 && !it.note) continue
      db.entries.push({ id: nextId(), ym, typeId: it.typeId, amount: it.amount, note: it.note ?? null, accountId: it.accountId ?? null, auto: false })
    }
    persist(db)
    recomputeAuto(ym, body?.note ? String(body.note).slice(0, 100) : undefined)
    return monthDetail(ym)
  }
  if (p1 === 'month' && p2 && p3 === 'entry' && m === 'POST') {
    if (!YM_RE.test(p2)) bad('月份格式应为 YYYY-MM')
    if (!Number.isInteger(body?.amount)) bad('金额不合法（分）')
    const t = db.types.find((x) => x.id === Number(body?.typeId))
    if (!t) bad('类型不存在')
    db.entries.push({ id: nextId(), ym: p2, typeId: t.id, amount: body.amount, note: body?.note ?? null, accountId: body?.accountId ?? null, auto: false })
    persist(db)
    recomputeAuto(p2)
    localAutoBackup('新增大项')
    return monthDetail(p2)
  }
  if (p1 === 'month' && p2 && p3 === 'entry' && p4) {
    const ym = p2
    const e = db.entries.find((x) => x.id === Number(p4) && x.ym === ym)
    if (!e) notFound('条目不存在')
    if (m === 'PATCH') {
      if (e.auto) bad('平账条目由系统自动计算，不可直接编辑')
      if (body?.typeId !== undefined) e.typeId = Number(body.typeId)
      if (body?.amount !== undefined) {
        if (!Number.isInteger(body.amount)) bad('金额不合法（分）')
        e.amount = body.amount
      }
      if (body?.note !== undefined) e.note = body.note ? String(body.note).slice(0, 200) : null
      if (body?.accountId !== undefined) e.accountId = body.accountId ?? null
      persist(db); recomputeAuto(ym)
      return monthDetail(ym)
    }
    if (m === 'DELETE') {
      if (e.auto) bad('平账条目不可删除，会随大项修改自动重算')
      db.trash.push({ id: nextId(), kind: 'entry', summary: `条目 ${e.note || ''} ${ym}`, payload: e, deletedAt: Date.now() })
      db.entries = db.entries.filter((x) => x.id !== e.id); persist(db); recomputeAuto(ym)
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
        let acc = db.accounts.find((a) => a.name === accountName)
        if (!acc) {
          acc = {
            id: nextId(), name: accountName.slice(0, 30), emoji: '🏦',
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
      if (db.snapshots.some((s) => s.ym === ym && s.accountId === accountId)) { skipped++; continue }
      const recordDate = YMD_RE.test(r.recordDate || '') ? r.recordDate! : ym + '-28'
      db.snapshots.push({ id: nextId(), ym, accountId, balance: r.balance, recordDate, note: '钱迹导入' })
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
    if (!acc) notFound('账户不存在')
    const balance = Number(body?.balance)
    if (!Number.isInteger(balance) || balance < 0) bad('余额须为非负整数（分）')
    const note = body?.note ? String(body.note).slice(0, 200) : '余额调整'
    const ym = todayYMD().slice(0, 7)
    const recordDate = todayYMD()
    const existing = db.snapshots.find((x) => x.ym === ym && x.accountId === acc.id)
    let prev = acc.initBalance
    if (!existing) {
      const earlier = db.snapshots.filter((x) => x.accountId === acc.id && x.ym < ym).sort((a, b) => b.ym.localeCompare(a.ym))[0]
      if (earlier) prev = earlier.balance
    }
    const oldCurrent = existing ? existing.balance : prev
    const delta = balance - oldCurrent
    if (existing) {
      existing.balance = balance
      existing.recordDate = recordDate
    } else {
      db.snapshots.push({ id: nextId(), ym, accountId: acc.id, balance, recordDate, note: '快速调整' })
    }
    if (delta !== 0) {
      db.entries.push({ id: nextId(), ym, typeId: builtinType().id, amount: delta, note, accountId: acc.id, auto: false })
    }
    persist(db)
    recomputeAuto(ym)
    localAutoBackup('调整余额')
    return { ok: true, delta, balance }
  }

  // ---- 借入借出台账 ----
  if (p1 === 'loans' && m === 'GET' && !p2) {
    const view = db.loans.slice().sort((a, b) => b.id - a.id).map((l) => ({
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
      id: nextId(), direction, counterparty: counterparty.slice(0, 30), amount: body.amount,
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
    if (!loan) notFound('借还记录不存在')
    if (!Number.isInteger(body?.amount) || body.amount <= 0) bad('金额不合法（分）')
    loan.settledAmount = Math.min(loan.amount, loan.settledAmount + body.amount)
    persist(db)
    localAutoBackup('借还进度')
    return localHandle('GET', '/loans')
  }
  if (p1 === 'loans' && p2 && p3 === 'close' && m === 'POST') {
    const loan = db.loans.find((l) => l.id === Number(p2))
    if (!loan) notFound('借还记录不存在')
    const mode = body?.mode === 'closed' ? 'closed' : 'settled'
    const tag = mode === 'settled' ? '【已结清】' : '【已结束】'
    if (mode === 'settled') loan.settledAmount = loan.amount
    if (!(loan.note || '').startsWith(tag)) loan.note = (tag + ' ' + (loan.note || '')).slice(0, 200)
    const mirror = db.accounts.find((a) => a.name === '债权-' + loan.counterparty)
    if (mirror && !mirror.archived) mirror.archived = true
    persist(db)
    localAutoBackup(mode === 'settled' ? '结清借还' : '结束借还')
    return localHandle('GET', '/loans')
  }
  if (p1 === 'loans' && p2 && m === 'PATCH') {
    const loan = db.loans.find((l) => l.id === Number(p2))
    if (!loan) notFound('借还记录不存在')
    if (body?.counterparty !== undefined) {
      const cp = String(body.counterparty).trim()
      if (!cp) bad('对方名称不能为空')
      loan.counterparty = cp.slice(0, 30)
    }
    if (body?.amount !== undefined) {
      if (!Number.isInteger(body.amount) || body.amount <= 0) bad('金额不合法（分）')
      loan.amount = body.amount
      if (loan.settledAmount > body.amount) loan.settledAmount = body.amount
    }
    if (body?.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(body.date || '')) loan.date = body.date
    if (body?.dueDate !== undefined) loan.dueDate = /^\d{4}-\d{2}-\d{2}$/.test(body.dueDate || '') ? body.dueDate : null
    if (body?.accountId !== undefined) loan.accountId = Number.isInteger(body.accountId) ? body.accountId : null
    if (body?.note !== undefined) loan.note = body.note ? String(body.note).slice(0, 200) : null
    persist(db)
    localAutoBackup('编辑借还')
    return loan
  }
  if (p1 === 'loans' && p2 && m === 'DELETE') {
    const id = Number(p2)
    const loan = db.loans.find((l) => l.id === id)
    if (!loan) notFound('借还记录不存在')
    db.trash.push({ id: nextId(), kind: 'loan', summary: `${loan.direction === 'out' ? '借出' : '借入'} ${loan.counterparty}`, payload: loan, deletedAt: Date.now() })
    db.loans = db.loans.filter((l) => l.id !== id); persist(db)
    localAutoBackup('删除借还')
    return { ok: true }
  }

  // ---- 回收站 ----
  if (p1 === 'recycle' && m === 'GET' && !p2) {
    return { items: db.trash.slice().sort((a, b) => b.deletedAt - a.deletedAt) }
  }
  if (p1 === 'recycle' && p2 && p3 === 'restore' && m === 'POST') {
    const item = db.trash.find((t) => t.id === Number(p2))
    if (!item) notFound('回收站条目不存在')
    const pl = item.payload
    if (item.kind === 'entry') {
      db.entries.push({ ...pl, id: nextId() })
      persist(db); recomputeAuto(pl.ym)
    } else if (item.kind === 'loan') {
      db.loans.push({ ...pl, id: nextId() }); persist(db)
    } else if (item.kind === 'account') {
      if (!db.accounts.some((a) => a.name === pl.name)) {
        db.accounts.push({ ...pl, id: nextId() }); persist(db)
      }
    }
    db.trash = db.trash.filter((t) => t.id !== item.id); persist(db)
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
    const qs = new URLSearchParams(path.split('?')[1] || '')
    const kw = (qs.get('q') || '').trim()
    const min = qs.get('minYuan') ? Math.round(Number(qs.get('minYuan')) * 100) : null
    const max = qs.get('maxYuan') ? Math.round(Number(qs.get('maxYuan')) * 100) : null
    const results = db.entries
      .filter((e) => !e.auto)
      .filter((e) => (min === null || e.amount >= min) && (max === null || e.amount <= max))
      .filter((e) => {
        if (!kw) return true
        const t = db.types.find((x) => x.id === e.typeId)
        const acc = e.accountId ? db.accounts.find((x) => x.id === e.accountId) : null
        return (e.note || '').includes(kw) || (t?.name || '').includes(kw) || (acc?.name || '').includes(kw)
      })
      .sort((a, b) => b.ym.localeCompare(a.ym) || b.id - a.id)
      .slice(0, 200)
      .map((e) => {
        const t = db.types.find((x) => x.id === e.typeId)
        const acc = e.accountId ? db.accounts.find((x) => x.id === e.accountId) : null
        return { id: e.id, ym: e.ym, typeId: e.typeId, name: t?.name ?? '未知', emoji: t?.emoji ?? '🏷', amount: e.amount, note: e.note, accountName: acc?.name ?? null }
      })
    return { results, matchedAccounts: kw ? db.accounts.filter((a) => a.name.includes(kw)).map((a) => ({ id: a.id, name: a.name, emoji: a.emoji })) : [] }
  }

  // ---- 统计 ----
  if (p1 === 'stats' && p2 === 'type-contribution') {
    const limit = Math.min(60, Number(new URLSearchParams(path.split('?')[1] || '').get('limit')) || 12)
    const yms = pointsAsc().slice(0, limit).map((p) => p.ym)
    const sums = new Map<number, number>()
    for (const e of db.entries) {
      if (!yms.includes(e.ym)) continue
      const key = e.auto ? -1 : e.typeId
      sums.set(key, (sums.get(key) || 0) + e.amount)
    }
    const items = [...sums.entries()]
      .map(([typeId, total]) => {
        if (typeId === -1) return { typeId: -1, name: '平账（自动）', emoji: '⚖️', direction: 'neutral', total }
        const t = db.types.find((x) => x.id === typeId)
        return { typeId, name: t?.name ?? '未知', emoji: t?.emoji ?? '🏷', direction: t?.direction ?? 'neutral', total }
      })
      .sort((a, b) => Math.abs(b.total) - Math.abs(a.total))
    return { months: yms, items }
  }
  if (p1 === 'stats' && p2 === 'networth') {
    const limit = Math.min(120, Number(new URLSearchParams(path.split('?')[1] || '').get('limit')) || 36)
    return { points: pointsAsc().slice(-limit) }
  }
  if (p1 === 'stats' && p2 === 'daily-avg') {
    const limit = Math.min(60, Number(new URLSearchParams(path.split('?')[1] || '').get('limit')) || 12)
    const pts = pointsAsc()
    const out = pts.map((p, i) => {
      const incomeTotal = db.entries
        .filter((e) => e.ym === p.ym && !e.auto && db.types.find((t) => t.id === e.typeId)?.direction === 'income')
        .reduce((s, e) => s + Math.max(0, e.amount), 0)
      const stats = i > 0 ? computeIntervalStats(p.delta ?? 0, incomeTotal, daysBetween(pts[i - 1].recordDate, p.recordDate)) : null
      return {
        ym: p.ym, recordDate: p.recordDate, networth: p.networth, delta: p.delta,
        days: stats ? stats.days : null, spendEst: stats ? stats.spendEst : null,
        dailyAvg: stats ? stats.dailyAvg : null, dailyNet: stats ? stats.dailyNet : null,
        estimated: stats ? stats.estimated : null,
        accountCount: db.snapshots.filter((s) => s.ym === p.ym).length,
      }
    })
    return { months: out.slice(-limit) }
  }
  if (p1 === 'stats' && p2 === 'interval') {
    const q = new URLSearchParams(path.split('?')[1] || '')
    const fromYm = q.get('from') || '', toYm = q.get('to') || ''
    if (!YM_RE.test(fromYm) || !YM_RE.test(toYm)) bad('月份格式应为 YYYY-MM')
    const pts = pointsAsc()
    const from = pts.find((p) => p.ym === fromYm), to = pts.find((p) => p.ym === toYm)
    if (!from || !to) bad('所选月份没有记录点，请先平账')
    if (to.ym <= from.ym) bad('结束月份需晚于起始月份')
    const incomeTotal = db.entries
      .filter((e) => !e.auto && e.ym >= from.ym && e.ym <= to.ym && db.types.find((t) => t.id === e.typeId)?.direction === 'income')
      .reduce((s, e) => s + Math.max(0, e.amount), 0)
    return {
      fromYm: from.ym, toYm: to.ym, fromDate: from.recordDate, toDate: to.recordDate,
      ...computeIntervalStats(to.networth - from.networth, incomeTotal, daysBetween(from.recordDate, to.recordDate)),
    }
  }

  // ---- 系统 ----
  if (p1 === 'system') {
    if (p2 === 'health') return { ok: true, version: '0.2.0-offline', accounts: db.accounts.length, snapshots: db.snapshots.length, entries: db.entries.length }
    if (p2 === 'settings' && m === 'GET') return { settings: { ...DEFAULT_SETTINGS, ...db.settings } }
    if (p2 === 'settings' && m === 'PUT') {
      for (const [k, v] of Object.entries(body?.settings || {})) {
        if (typeof v !== 'string' || v.length > 5000) bad('设置值不合法')
        db.settings[k] = v
      }
      persist(db)
      return { settings: { ...DEFAULT_SETTINGS, ...db.settings } }
    }
    if (p2 === 'matrix' && m === 'GET') {
      const limit = Math.min(120, Number(new URLSearchParams(path.split('?')[1] || '').get('limit')) || 24)
      return matrix(limit)
    }
    if (p2 === 'matrix.csv') return { csv: matrixCsv() }
    if (p2 === 'backup' && m === 'GET') {
      return {
        format: 'suiji-ledger-backup', version: 1, exportedAt: Date.now(),
        types: db.types, accounts: db.accounts, snapshots: db.snapshots, entries: db.entries, loans: db.loans,
        settings: Object.entries(db.settings).map(([key, value]) => ({ key, value })),
        meta: { snapshotCount: db.snapshots.length, entryCount: db.entries.length },
      }
    }
    if (p2 === 'restore' && m === 'POST') {
      const data = body?.data
      const mode = body?.mode === 'merge' ? 'merge' : 'replace'
      // 兼容旧版本备份（重命名前的 format 标识）
      if (!data || (data.format !== 'suiji-ledger-backup' && data.format !== 'moneyrecord-backup'))
        bad('不是有效的 SuijiLedger 备份文件')
      if (mode === 'replace') {
        db.entries = []; db.snapshots = []; db.accounts = []; db.types = []; db.loans = []
        db.types.push({ id: nextId(), name: '平账', emoji: '⚖️', color: null, direction: 'neutral', builtin: true, sort: 0 })
      }
      const typeMap = new Map<number, number>()
      for (const t of data.types || []) {
        const exist = mode === 'merge' ? db.types.find((x) => x.name === t.name && x.direction === t.direction) : undefined
        if (exist) typeMap.set(t.id, exist.id)
        else {
          const id = nextId()
          db.types.push({ id, name: t.name, emoji: t.emoji, color: t.color ?? null, direction: t.direction, builtin: !!t.builtin, sort: t.sort ?? 0 })
          typeMap.set(t.id, id)
        }
      }
      const accMap = new Map<number, number>()
      for (const a of data.accounts || []) {
        const exist = mode === 'merge' ? db.accounts.find((x) => x.name === a.name && x.kind === a.kind) : undefined
        if (exist) accMap.set(a.id, exist.id)
        else {
          const id = nextId()
          db.accounts.push({ ...a, id })
          accMap.set(a.id, id)
        }
      }
      let imported = 0
      for (const s of data.snapshots || []) {
        const accountId = accMap.get(s.accountId)
        if (!accountId) continue
        const exist = db.snapshots.find((x) => x.ym === s.ym && x.accountId === accountId)
        if (exist) {
          exist.balance = s.balance; exist.recordDate = s.recordDate; exist.note = s.note ?? null
        } else {
          db.snapshots.push({ id: nextId(), ym: s.ym, accountId, balance: s.balance, recordDate: s.recordDate, note: s.note ?? null })
        }
        imported++
      }
      for (const e of data.entries || []) {
        const typeId = typeMap.get(e.typeId)
        if (!typeId) continue
        db.entries.push({ id: nextId(), ym: e.ym, typeId, amount: e.amount, note: e.note ?? null, accountId: e.accountId ? accMap.get(e.accountId) ?? null : null, auto: !!e.auto })
      }
      for (const l of data.loans || []) {
        db.loans.push({
          id: nextId(), direction: l.direction === 'in' ? 'in' : 'out', counterparty: l.counterparty,
          amount: l.amount, settledAmount: l.settledAmount ?? 0, date: l.date,
          dueDate: l.dueDate ?? null, note: l.note ?? null, createdAt: l.createdAt ?? Date.now(),
        })
      }
      persist(db)
      const yms = [...new Set((data.snapshots || []).map((s: any) => String(s.ym)))]
      for (const ym of yms) recomputeAuto(ym)
      return { ok: true, mode, imported }
    }
  }

  throw new HttpError(404, `离线模式未实现: ${method} ${path}`)
}

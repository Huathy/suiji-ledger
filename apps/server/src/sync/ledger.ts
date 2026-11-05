/**
 * 同步载体格式（M4 的"硬约定"层，纯函数、无 IO、无框架依赖）
 *
 * 一条记录一个文件，文件名前缀编码 kind —— 因为 isomorphic-git 的 `mergeDriver`
 * 只拿得到 **basename**（源码 `mergeTree` 内 `const path = basename(filepath)`），
 * 靠目录判类必然判错。详见 .docs/21_设计方案_M4_Git同步.md §1 / §4.1 / R12。
 */
import {
  fmtMoney,
  lockedFields,
  type SyncConflictType,
  type SyncFieldDiff,
  type SyncPick,
  type SyncRecordKind,
} from '../../../../packages/shared/src/index'

/**
 * 记录类型值域的唯一来源是 shared 的 `SyncRecordKind`（后端前缀映射、前端冲突界面共用一套值）。
 * 这里只做别名再导出：既有 import 路径与导出名不变，值域要改只改 shared 一处。
 */
export type RecordKind = SyncRecordKind

/**
 * 投影进 git 的设置白名单：只放"跨设备应该一致"的展示类偏好。
 * 同步自身的开关（gitRemote/gitAuth/gitEncrypt/gitMergeEnabled/gitPushMode…）**绝不投影**。
 */
export const SYNC_SETTING_KEYS = ['theme', 'reminderDay', 'baseCurrency', 'groupOrder', 'timeSortDir']


export const RECORD_KINDS: RecordKind[] = ['type', 'account', 'snapshot', 'entry', 'loan', 'setting']

/** 文件名前缀 → kind。'set' 必须排在 's' 之前，正则里已用最长优先 */
export const KIND_PREFIX: Record<RecordKind, string> = {
  type: 't',
  account: 'a',
  snapshot: 's',
  entry: 'e',
  loan: 'l',
  setting: 'set',
}
/** 前缀 → kind 的唯一映射（relPathOf 也用它，别再手抄 dir 表） */
export const PREFIX_KIND: Record<string, RecordKind> = { t: 'type', a: 'account', s: 'snapshot', e: 'entry', l: 'loan', set: 'setting' }

/**
 * 每种记录的载荷字段（顺序即 canonical 序列化顺序）。
 * 金额一律「分」的整数，键名带 Cents 后缀，避免与元混用。
 */
export const KIND_FIELDS: Record<RecordKind, string[]> = {
  type: ['name', 'emoji', 'color', 'direction', 'builtin', 'sort'],
  account: ['name', 'emoji', 'accKind', 'group', 'initBalanceCents', 'inNetWorth', 'sort', 'archived', 'note', 'createdAt'],
  snapshot: ['ym', 'accountUid', 'balanceCents', 'recordDate', 'note'],
  entry: ['ym', 'typeUid', 'amountCents', 'note', 'accountUid', 'auto'],
  loan: ['direction', 'counterparty', 'amountCents', 'settledCents', 'date', 'dueDate', 'accountUid', 'note', 'createdAt'],
  setting: ['key', 'value'],
}

/** 冲突对照界面参与比较的字段（只列人看得懂的 4 类，不是全部载荷） */
export const DIFF_FIELDS: Record<RecordKind, string[]> = {
  entry: ['amountCents', 'note', 'accountUid', 'ym'],
  snapshot: ['balanceCents', 'note', 'recordDate', 'ym'],
  loan: ['amountCents', 'settledCents', 'counterparty', 'date', 'note'],
  account: ['name', 'initBalanceCents', 'note', 'archived'],
  type: ['name', 'direction', 'emoji'],
  setting: ['value'],
}

const FIELD_LABELS: Record<string, string> = {
  ym: '月份',
  typeUid: '类型',
  amountCents: '金额',
  balanceCents: '余额',
  initBalanceCents: '初始余额',
  settledCents: '已还/已收',
  note: '备注',
  accountUid: '关联账户',
  auto: '自动条目',
  recordDate: '记录日',
  date: '日期',
  dueDate: '约定归还日',
  counterparty: '对方',
  name: '名称',
  emoji: '图标',
  color: '颜色',
  direction: '方向',
  builtin: '内置',
  sort: '排序',
  accKind: '账户类型',
  group: '分组',
  inNetWorth: '计入净资产',
  archived: '归档',
  createdAt: '创建时间',
  key: '键',
  value: '值',
}

const AMOUNT_FIELDS = new Set(['amountCents', 'balanceCents', 'initBalanceCents', 'settledCents'])

export type LedgerRecord = {
  uid: string
  kind: RecordKind
  rev: number
  updatedAt: number
  deleted: boolean
  origin: string
  /** 载荷字段，见 KIND_FIELDS */
  [k: string]: any
}

/** 解析失败的原因分类（决定冲突界面怎么展示） */
export type ParseFailure = 'encrypted' | 'invalid' | 'kind-mismatch' | 'empty'

export type ParseResult =
  | { ok: true; rec: LedgerRecord }
  | { ok: false; reason: ParseFailure; message?: string; rev?: number; deleted?: boolean }

// ---------------- 文件名 ----------------

/** 全库 basename 唯一：uid 是 uuid v4，快照 uid 是 `${ym}__${accountUid}`，设置是白名单键 */
export function fileNameOf(rec: { kind: RecordKind; uid: string }): string {
  return `${KIND_PREFIX[rec.kind]}_${encodeURIComponent(rec.uid)}.json`
}

/** 从 basename 反推 kind；meta.json 等非记录文件返回 null */
export function kindOfFileName(fileName: string): RecordKind | null {
  const base = fileName.includes('/') ? fileName.slice(fileName.lastIndexOf('/') + 1) : fileName
  const m = /^(set|t|a|s|e|l)_(.+)\.json$/.exec(base)
  if (!m) return null
  return PREFIX_KIND[m[1]] ?? null
}

/** 从 basename 反推 uid（decode 失败时退回原串） */
export function uidOfFileName(fileName: string): string | null {
  const base = fileName.includes('/') ? fileName.slice(fileName.lastIndexOf('/') + 1) : fileName
  const m = /^(set|t|a|s|e|l)_(.+)\.json$/.exec(base)
  if (!m) return null
  try {
    return decodeURIComponent(m[2])
  } catch {
    return m[2]
  }
}

/** 仓库内全路径（只用于展示与后端回查，驱动永远只看到 basename） */
export function repoPathOf(rec: { kind: RecordKind; uid: string }): string {
  return `ledger/v1/${DIR_OF[rec.kind]}/${fileNameOf(rec)}`
}

export const DIR_OF: Record<RecordKind, string> = {
  type: 'types',
  account: 'accounts',
  snapshot: 'snapshots',
  entry: 'entries',
  loan: 'loans',
  setting: 'settings',
}

export function repoPathOfFile(kind: RecordKind, fileName: string): string {
  return `ledger/v1/${DIR_OF[kind]}/${fileName}`
}

// ---------------- 序列化 ----------------

function normalizeValue(v: any): any {
  if (v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : 0
  if (typeof v === 'boolean') return v
  if (v === null) return null
  return String(v)
}

/**
 * 确定性序列化（R2）：key 顺序固定、无缩进、UTF-8、结尾单个 \n。
 * 不这样做，同一逻辑内容在不同设备会产出不同 blob → 每次投影都"全库变更"。
 */
export function canonicalRecord(rec: LedgerRecord): string {
  const out: Record<string, any> = { uid: rec.uid, kind: rec.kind }
  for (const f of KIND_FIELDS[rec.kind]) out[f] = normalizeValue(rec[f])
  out.rev = Number.isFinite(rec.rev) ? Math.round(rec.rev) : 1
  out.updatedAt = Number.isFinite(rec.updatedAt) ? Math.round(rec.updatedAt) : 0
  out.deleted = !!rec.deleted
  out.origin = String(rec.origin || '')
  return JSON.stringify(out) + '\n'
}

/** 加密载体（gitEncrypt=on）：整份密文，只留 rev/deleted 明文用于排障展示 */
export function canonicalEncrypted(env: any, rev: number, deleted: boolean): string {
  return JSON.stringify({ enc: env, rev: Math.round(rev), deleted: !!deleted }) + '\n'
}

export function isEncryptedEnvelope(obj: any): boolean {
  return !!obj && typeof obj === 'object' && !!obj.enc && typeof obj.enc === 'object' && typeof obj.enc.ct === 'string'
}

export function parseRecordText(text: string, fileName?: string): ParseResult {
  if (!text || !text.trim()) return { ok: false, reason: 'empty' }
  let obj: any
  try {
    obj = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'invalid', message: 'JSON 解析失败' }
  }
  if (!obj || typeof obj !== 'object') return { ok: false, reason: 'invalid', message: '不是对象' }
  if (isEncryptedEnvelope(obj)) {
    return { ok: false, reason: 'encrypted', rev: Number(obj.rev) || 0, deleted: !!obj.deleted }
  }
  const kind = obj.kind as RecordKind
  if (!RECORD_KINDS.includes(kind)) return { ok: false, reason: 'invalid', message: '未知 kind' }
  if (typeof obj.uid !== 'string' || !obj.uid) return { ok: false, reason: 'invalid', message: '缺 uid' }
  if (fileName) {
    const fk = kindOfFileName(fileName)
    if (fk && fk !== kind) return { ok: false, reason: 'kind-mismatch', message: `文件名前缀是 ${fk}，内容却写 ${kind}` }
  }
  const rec: LedgerRecord = {
    uid: obj.uid,
    kind,
    rev: Number.isInteger(obj.rev) ? obj.rev : 1,
    updatedAt: Number.isInteger(obj.updatedAt) ? obj.updatedAt : 0,
    deleted: !!obj.deleted,
    origin: typeof obj.origin === 'string' ? obj.origin : '',
  }
  for (const f of KIND_FIELDS[kind]) rec[f] = obj[f] === undefined ? null : obj[f]
  return { ok: true, rec }
}

export function sameRecord(a: LedgerRecord, b: LedgerRecord): boolean {
  if (a.kind !== b.kind) return false
  return canonicalRecord(a) === canonicalRecord(b)
}

// ---------------- 展示 ----------------

export function formatValue(field: string, value: any): string {
  if (value === null || value === undefined || value === '') return '—'
  if (AMOUNT_FIELDS.has(field)) {
    const n = Number(value)
    return Number.isFinite(n) ? '¥' + fmtMoney(n) : String(value)
  }
  if (field === 'direction') return ({ income: '收入', expense: '支出', neutral: '中性' } as any)[value] || String(value)
  if (field === 'accKind') return value === 'liability' ? '负债' : '资产'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (field === 'createdAt' || field === 'updatedAt') {
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) return '—'
    const d = new Date(n * 1000)
    const p = (x: number) => String(x).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }
  if (field === 'note' || field === 'value' || field === 'name' || field === 'counterparty') return String(value)
  return String(value)
}

export type TitleCtx = {
  typeName?: (uid: string) => string | null
  accountName?: (uid: string) => string | null
}

/** 冲突列表里的一行标题，人能一眼认出是哪条数据 */
export function titleOf(rec: LedgerRecord, ctx: TitleCtx = {}): string {
  const ymText = (ym: any) => (typeof ym === 'string' ? `${Number(ym.slice(5, 7))} 月` : '')
  switch (rec.kind) {
    case 'entry': {
      const t = rec.typeUid ? ctx.typeName?.(rec.typeUid) : null
      const sign = Number(rec.amountCents) >= 0 ? '+' : ''
      return `${ymText(rec.ym)} · ${t || '条目'} ${sign}${fmtMoney(Number(rec.amountCents) || 0)}`
    }
    case 'snapshot': {
      const a = rec.accountUid ? ctx.accountName?.(rec.accountUid) : null
      return `${rec.ym || ''} · ${a || '账户'} 余额`
    }
    case 'account':
      return `账户 · ${rec.name || rec.uid}`
    case 'loan':
      return `${rec.direction === 'in' ? '借入' : '借出'} ${rec.counterparty || ''}`
    case 'type':
      return `类型 · ${rec.name || rec.uid}`
    case 'setting':
      return `设置 · ${rec.key || rec.uid}`
    default:
      return rec.uid
  }
}

// ---------------- 字段级 diff ----------------

/**
 * 字段级对照的一行 = shared 的 `SyncFieldDiff`（§5.6.2）。
 * 前端画箭头/置灰、后端算锁都吃这同一份形状，两边各抄一份必然漂移。
 */
export type FieldDiff = SyncFieldDiff

export function diffFields(base: LedgerRecord | null, local: LedgerRecord, remote: LedgerRecord, ctx: TitleCtx = {}): FieldDiff[] {
  const fields = DIFF_FIELDS[local.kind] || []
  const relabel = (f: string, rec: LedgerRecord | null): string | null => {
    if (!rec) return null
    const v = rec[f]
    if (f === 'accountUid') return v ? ctx.accountName?.(String(v)) || String(v).slice(0, 8) : '—'
    if (f === 'typeUid') return v ? ctx.typeName?.(String(v)) || String(v).slice(0, 8) : '—'
    return formatValue(f, v)
  }
  return fields.map((f) => {
    const b = base ? (base[f] ?? null) : null
    const l = local[f] ?? null
    const r = remote[f] ?? null
    let changed: FieldDiff['changed']
    // 两侧一致优先判：两端改成同一个值（或压根没动）都不需要人裁决
    if (l === r) changed = 'same'
    else if (!base) changed = 'both' // 没有共同祖先，无从判断谁改了什么
    else if (l === b) changed = 'remote'
    else if (r === b) changed = 'local'
    else changed = 'both'
    return {
      name: f,
      label: FIELD_LABELS[f] || f,
      base: relabel(f, base),
      local: relabel(f, local),
      remote: relabel(f, remote),
      changed,
    }
  })
}

// ---------------- 预选与合并 ----------------

/** 裁决方向 = shared 的 `SyncPick`（后端 composeResolved、前端箭头都吃这一个值域） */
export type Pick = SyncPick

/** 冲突成因 = shared 的 `SyncConflictType` */
export type ConflictType = SyncConflictType

/**
 * 单条预选的返回形状。shared 里没有"单条推荐"这个类型（只有整条 ConflictItem 上的
 * recommend/reason 两个字段），所以这里保留本地结构体，但 pick 直接取 shared 的 SyncPick——
 * 值域只有一个家，形状多一层壳无妨。
 */
export type Recommend = { pick: SyncPick; reason: string }

/** 载荷 → 指纹文本：字符串按原样（已是 canonical 文本），记录/对象按键排序后再指纹 */
function payloadFingerprint(v: unknown): string {
  if (typeof v === 'string') return fingerprint(v)
  if (v && typeof v === 'object') {
    if (RECORD_KINDS.includes((v as any).kind)) return fingerprint(canonicalRecord(v as LedgerRecord))
    return fingerprint(stableText(v))
  }
  return fingerprint(v === undefined || v === null ? '' : String(v))
}

/** 无 kind 的对象也要有确定性序列化：键序不稳定就会两端算出不同指纹 */
function stableText(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stableText).join(',') + ']'
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return '{' + Object.keys(o).sort().map((k) => `${k}:${stableText(o[k])}`).join(',') + '}'
  }
  return String(v)
}

/**
 * 确定性 tie-break（§5.3 预选规则第 4 条）。三级顺序，**任何一级都不许出现
 * "随机 / 先到先得 / 本地优先"的兜底**：
 *
 *  1. origin 双边非空且不等 → 字典序大者胜（本端 'd_a'、远端 'd_b' ⇒ remote 胜）；
 *  2. 其余情况（origin 有一侧为空、或两侧相等，老库/无 origin 的记录都落在这里）
 *     → **内容指纹**字典序大者胜：`fingerprint(本地载荷)` vs `fingerprint(远端载荷)`；
 *  3. 指纹也相等 ⇒ 两端载荷逐字节一致（调用方本该在 identical 分支就返回，这里只是兜底），
 *     固定返回 'local'。这一级不产生分歧：内容相同，选哪边落地结果都一样，
 *     但必须"同一输入永远同一输出"，否则它自己就成了新的不确定来源。
 *
 * 为什么必须确定性：预选只决定界面默认勾哪边（不定案），两台设备若各按各的默认
 * 一路点下去，会得到两份不同内容，下次同步再次冲突，永远不收敛（CRDT 里的 classic bug，§5.3）。
 *
 * tieKeys 是本端/远端的**载荷**（记录对象或 canonical 文本均可）。不传时第 2 级无从比较，
 * 退化为第 3 级；本仓三个调用点（recommendPick / decideMerge / recommendFromTexts）都传。
 */
export function tieBreakPick(
  localOrigin: string,
  remoteOrigin: string,
  tieKeys?: { local: unknown; remote: unknown },
): Pick {
  const lo = String(localOrigin || '')
  const ro = String(remoteOrigin || '')
  if (lo && ro && lo !== ro) return lo > ro ? 'local' : 'remote'
  const lf = payloadFingerprint(tieKeys?.local)
  const rf = payloadFingerprint(tieKeys?.remote)
  if (lf === rf) return 'local'
  return lf > rf ? 'local' : 'remote'
}

/**
 * 预选规则（只决定界面默认勾哪边，**不定案**，§5.3）。
 * 前三条（墓碑 / rev / updatedAt）都判不出来时，一律交 `tieBreakPick`——
 * origin 双空的老库记录、两端 origin 相同（同一设备重放）以前会恒取 local，
 * 那等于"本地优先"，两边默认值不同、永不收敛。理由见 tieBreakPick 注释。
 */
export function recommendPick(base: LedgerRecord | null, local: LedgerRecord, remote: LedgerRecord): Recommend {
  if (local.deleted !== remote.deleted) {
    return local.deleted
      ? { pick: 'local', reason: '本地已删除，远程仍有修改（保留删除会丢弃远程改动）' }
      : { pick: 'remote', reason: '远程已删除，本地仍有修改（保留删除会丢弃本地改动）' }
  }
  if (local.rev !== remote.rev) {
    return local.rev > remote.rev
      ? { pick: 'local', reason: `本地 rev 更大（${local.rev} > ${remote.rev}）` }
      : { pick: 'remote', reason: `远程 rev 更大（${remote.rev} > ${local.rev}）` }
  }
  if (local.updatedAt !== remote.updatedAt) {
    return local.updatedAt > remote.updatedAt
      ? { pick: 'local', reason: '本地更新时间更晚' }
      : { pick: 'remote', reason: '远程更新时间更晚' }
  }
  const lo = String(local.origin || '')
  const ro = String(remote.origin || '')
  const pick = tieBreakPick(lo, ro, { local, remote })
  const byOrigin = !!lo && !!ro && lo !== ro
  return {
    pick,
    reason: byOrigin
      ? '确定性兜底（rev 与时间都相同，按设备号字典序大者胜）'
      : '确定性兜底（rev 与时间都相同，设备号缺失或相同，改按内容指纹字典序大者胜）',
  }
}

export type MergeDecision =
  | { cleanMerge: true; mergedText: string }
  | { cleanMerge: false; conflictType: ConflictType; recommend: Pick; reason: string }

/**
 * 驱动内的判定顺序（§5.3，严格按序，第一条命中即返回）。
 * 先判"能不能自动"，再判"该推荐谁"——两件事必须分开，混在一起就会写出自相矛盾的规则。
 */
export function decideMerge(input: {
  baseText: string | null
  ourText: string
  theirText: string
  fileName: string
  mergeEnabled: boolean
  encrypted: boolean
  deviceId: string
  now: number
}): MergeDecision {
  const { baseText, ourText, theirText, fileName, mergeEnabled, encrypted, deviceId, now } = input

  // 0. 合并已关闭（设置里关掉，或加密开启）→ 整份二选一
  if (!mergeEnabled || encrypted) {
    const ourRev = parseRecordText(ourText, fileName)
    const theirRev = parseRecordText(theirText, fileName)
    const ourDeleted = ourRev.ok ? ourRev.rec.deleted : !!ourRev.deleted
    const theirDeleted = theirRev.ok ? theirRev.rec.deleted : !!theirRev.deleted
    const pick: Pick = ourDeleted && !theirDeleted ? 'local' : 'remote'
    return {
      cleanMerge: false,
      conflictType: encrypted ? 'encrypted' : 'both',
      recommend: pick,
      reason: encrypted ? '已开启加密，只能整份二选一' : '合并已关闭，只能整份二选一',
    }
  }

  const base = baseText ? parseRecordText(baseText, fileName) : null
  const our = parseRecordText(ourText, fileName)
  const their = parseRecordText(theirText, fileName)
  if (!our.ok || !their.ok || (base && !base.ok)) {
    const failed = !our.ok ? our : !their.ok ? their : (base as any)
    const reason =
      failed.reason === 'encrypted'
        ? '内容为密文，无法逐字段合并'
        : failed.reason === 'kind-mismatch'
          ? `文件名与内容类型不一致（${failed.message || ''}）`
          : '内容无法解析，只能整份二选一'
    return { cleanMerge: false, conflictType: failed.reason === 'encrypted' ? 'encrypted' : 'unparsable', recommend: 'local', reason }
  }

  const ourRec = our.rec
  const theirRec = their.rec
  const baseRec = base && base.ok ? base.rec : null

  // 2. 内容一致 → 无需分歧
  if (sameRecord(ourRec, theirRec)) return { cleanMerge: true, mergedText: ourText }

  // 3. 唯一例外：Loan.settledAmount 纯累加（两端都只多还了一点）→ 取 max
  if (ourRec.kind === 'loan' && theirRec.kind === 'loan') {
    const others = KIND_FIELDS.loan.filter((f) => f !== 'settledCents')
    const onlySettled = others.every((f) => normalizeValue(ourRec[f]) === normalizeValue(theirRec[f]))
    const baseSettled = baseRec ? Number(baseRec.settledCents) || 0 : 0
    const o = Number(ourRec.settledCents) || 0
    const t = Number(theirRec.settledCents) || 0
    if (onlySettled && o >= baseSettled && t >= baseSettled) {
      const merged: LedgerRecord = {
        ...ourRec,
        settledCents: Math.max(o, t),
        rev: Math.max(ourRec.rev, theirRec.rev) + 1,
        updatedAt: now,
        origin: deviceId,
      }
      return { cleanMerge: true, mergedText: canonicalRecord(merged) }
    }
  }

  // 4. 其余：B 类双端同改 / C 类改删并发 → 交人工，附预选
  const rec = recommendPick(baseRec, ourRec, theirRec)
  const conflictType: ConflictType = ourRec.deleted !== theirRec.deleted ? 'edit-delete' : 'both'
  return { cleanMerge: false, conflictType, recommend: rec.pick, reason: rec.reason }
}

/**
 * 只借预选规则算冲突项默认值（§5.6 对照界面），不做"能不能自动"判定。
 *
 * 评审修复项：以前这里用 decideMerge({mergeEnabled:true, encrypted:false, deviceId:'', now:0})
 * 传 4 个哨兵值——语义混淆（Data Clumps）：进到这里的东西**已经**是冲突了，
 * 再假装走一遍"能否自动合并"的完整判定纯属搭便车。
 */
export function recommendFromTexts(
  baseText: string | null,
  ourText: string,
  theirText: string,
  fileName: string,
): { identical: boolean; recommend: Pick; conflictType: ConflictType; reason: string } {
  const base = baseText ? parseRecordText(baseText, fileName) : null
  const our = parseRecordText(ourText, fileName)
  const their = parseRecordText(theirText, fileName)
  if (!our.ok || !their.ok) {
    return { identical: false, recommend: 'local', conflictType: 'unparsable', reason: '内容无法解析，只能整份二选一' }
  }
  if (sameRecord(our.rec, their.rec)) {
    return { identical: true, recommend: 'local', conflictType: 'both', reason: '内容一致' }
  }
  const rec = recommendPick(base && base.ok ? base.rec : null, our.rec, their.rec)
  return {
    identical: false,
    recommend: rec.pick,
    conflictType: our.rec.deleted !== their.rec.deleted ? 'edit-delete' : 'both',
    reason: rec.reason,
  }
}

/**
 * 应用用户勾选：`pick` 定基线，`fieldPicks` 逐字段覆盖（字段级优先于记录级）。
 * 返回合成后的记录（rev 已顶到 max+1，保证对端能看见这次裁决）。
 *
 * 字段锁（§5.6.2 第 2 条）：只动了一端的字段恒取动过那端，`fieldPicks` 的**反向**取值一律忽略。
 * 界面把那种箭头画成置灰/锁定，但界面不是唯一防线：`fieldPicks` 是请求体，
 * 可以被伪造（前端 bug、脚本直调 /system/sync/resolve）。锁在后端生效，才谈得上"锁定"。
 * 锁定侧由 shared 的 `lockedFields(diffFields(...))` 算出——和前端置灰用的是同一份规则。
 *
 * 两条既有语义保持不变：`fieldPicks` 仅在 `!picked.deleted` 时生效（墓碑不能靠字段覆盖复活），
 * 且只在 `KIND_FIELDS[kind]` 内的字段才接受覆盖（防止往记录里塞任意键）。
 */
export function composeResolved(input: {
  base: LedgerRecord | null
  local: LedgerRecord
  remote: LedgerRecord
  pick: Pick
  fieldPicks?: Record<string, Pick>
  deviceId: string
  now: number
}): LedgerRecord {
  const { base, local, remote, pick, fieldPicks, deviceId, now } = input
  const picked = pick === 'local' ? local : remote
  const other = pick === 'local' ? remote : local
  const out: LedgerRecord = { ...picked }

  // 墓碑不能靠字段覆盖复活：要复活就得选另一端
  if (!picked.deleted) {
    const picks = Object.entries(fieldPicks || {})
    // 没有字段级覆盖就不必算 diff（diff 要遍历 DIFF_FIELDS，纯展示开销）
    const locked = picks.length ? lockedFields(diffFields(base, local, remote)) : {}
    for (const [field, side] of picks) {
      if (!(KIND_FIELDS[picked.kind] || []).includes(field)) continue
      const forced = locked[field]
      if (forced) {
        // 单端改动：忽略用户/payload 的取值，恒取动过那端
        out[field] = forced === 'local' ? local[field] : remote[field]
        continue
      }
      if (side !== 'local' && side !== 'remote') continue
      out[field] = side === 'local' ? local[field] : remote[field]
    }
    // 借还进度：用户没显式指定时，取两端最大值，别让"选了一边"顺带丢掉另一边的还款
    if (picked.kind === 'loan' && !fieldPicks?.settledCents) {
      const baseSettled = base ? Number(base.settledCents) || 0 : 0
      const o = Number(local.settledCents) || 0
      const t = Number(remote.settledCents) || 0
      if (o >= baseSettled && t >= baseSettled) out.settledCents = Math.max(o, t)
    }
  }

  out.rev = Math.max(local.rev, remote.rev, base?.rev ?? 0) + 1
  out.updatedAt = now
  out.origin = deviceId
  out.deleted = picked.deleted
  return out
}

/** 两段文本的指纹（E2 类只能看指纹时用） */
export function fingerprint(text: string): string {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16).padStart(8, '0') + ` / ${Buffer.byteLength(text, 'utf8')}B`
}

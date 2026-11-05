/**
 * 离线同步投影器（浏览器版，与服务端 ProjectService 同语义）。
 *
 * DB → git 工作区（lightning-fs /git）：全量重投影、原子写、永不物理删文件。
 * kind 判定一律走 ledger.kindOfFileName（basename 前缀），不另抄表。
 */
import { canonicalRecord, DIR_OF, encodeRecordLocal, fileNameOf, kindOfFileName, type LedgerRecord } from './sync-shared'
import type { GitEngineLocal } from './sync-engine'

export type ProjectResult = { files: number; written: string[] }

export type LocalDbView = {
  types: any[]
  accounts: any[]
  snapshots: any[]
  entries: any[]
  loans: any[]
  settings: Record<string, string>
  typeUid(id: number): string | null
  accUid(id: number): string | null
}

const SYNC_SETTING_KEYS = ['theme', 'reminderDay', 'baseCurrency', 'groupOrder', 'timeSortDir']

const str = (v: any): string | null => (v === null || v === undefined || v === '' ? null : String(v))
const num = (v: any): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n) : 0
}

function base(row: any, kind: LedgerRecord['kind'], fallback: string): LedgerRecord {
  return {
    uid: row.uid || fallback,
    kind,
    rev: row.rev || 1,
    updatedAt: row.updatedAt || 0,
    deleted: !!row.deleted,
    origin: row.origin || '',
  }
}

function typeToRecord(row: any): LedgerRecord {
  return { ...base(row, 'type', `legacy-t-${row.id}`), name: row.name, emoji: row.emoji, color: row.color ?? null, direction: row.direction, builtin: !!row.builtin, sort: num(row.sort) }
}
function accountToRecord(row: any): LedgerRecord {
  return {
    ...base(row, 'account', `legacy-a-${row.id}`), name: row.name, emoji: row.emoji,
    accKind: row.kind, group: row.group ?? null, initBalanceCents: num(row.initBalance),
    inNetWorth: !!row.inNetWorth, sort: num(row.sort), archived: !!row.archived,
    note: row.note ?? null, createdAt: num(row.createdAt),
  }
}
function snapshotToRecord(row: any, accountUid: string): LedgerRecord {
  return {
    ...base(row, 'snapshot', `${row.ym}__${accountUid}`),
    uid: row.uid || `${row.ym}__${accountUid}`,
    ym: row.ym, accountUid, balanceCents: num(row.balance), recordDate: row.recordDate, note: row.note ?? null,
  }
}
function entryToRecord(row: any, typeUid: string, accountUid: string | null): LedgerRecord {
  return { ...base(row, 'entry', `legacy-e-${row.id}`), ym: row.ym, typeUid, amountCents: num(row.amount), note: row.note ?? null, accountUid, auto: !!row.auto }
}
function loanToRecord(row: any, accountUid: string | null): LedgerRecord {
  return {
    ...base(row, 'loan', `legacy-l-${row.id}`), direction: row.direction, counterparty: row.counterparty,
    amountCents: num(row.amount), settledCents: num(row.settledAmount), date: row.date,
    dueDate: row.dueDate ?? null, accountUid, note: row.note ?? null, createdAt: num(row.createdAt),
  }
}
function settingToRecord(key: string, value: string): LedgerRecord {
  return { uid: key, kind: 'setting', key, value, rev: 1, updatedAt: 0, deleted: false, origin: '' }
}

export function buildRecordsLocal(view: LocalDbView): LedgerRecord[] {
  const typeUid = new Map(view.types.map((t) => [t.id, t.uid!]))
  const accUid = new Map(view.accounts.map((a) => [a.id, a.uid!]))
  const recs: LedgerRecord[] = []
  for (const t of view.types) if (t.uid) recs.push(typeToRecord(t))
  for (const a of view.accounts) if (a.uid) recs.push(accountToRecord(a))
  for (const s of view.snapshots) {
    const au = accUid.get(s.accountId)
    if (au) recs.push(snapshotToRecord(s, au))
  }
  for (const e of view.entries) {
    if (e.auto) continue
    const tu = typeUid.get(e.typeId)
    if (!tu) continue
    recs.push(entryToRecord(e, tu, e.accountId ? accUid.get(e.accountId) ?? null : null))
  }
  for (const l of view.loans) recs.push(loanToRecord(l, l.accountId ? accUid.get(l.accountId) ?? null : null))
  for (const s of view.settings ? Object.entries(view.settings) : []) {
    if (SYNC_SETTING_KEYS.includes(s[0])) recs.push(settingToRecord(s[0], s[1]))
  }
  return recs
}

export async function buildFilesLocal(view: LocalDbView, encrypted: boolean, deviceId: string): Promise<{ files: Map<string, string>; records: LedgerRecord[] }> {
  const records = buildRecordsLocal(view)
  const files = new Map<string, string>()
  for (const rec of records) files.set(fileNameOf(rec), encodeRecordLocal(rec, encrypted))
  const counts = {
    types: records.filter((r) => r.kind === 'type').length,
    accounts: records.filter((r) => r.kind === 'account').length,
    snapshots: records.filter((r) => r.kind === 'snapshot').length,
    entries: records.filter((r) => r.kind === 'entry').length,
    loans: records.filter((r) => r.kind === 'loan').length,
  }
  files.set('meta.json', JSON.stringify({ format: 'suiji-ledger-v1', version: 1, deviceId, counts }) + '\n')
  return { files, records }
}

export function relPathOf(fileName: string): string {
  const kind = kindOfFileName(fileName)
  const dir = kind ? DIR_OF[kind] : ''
  return dir ? `ledger/v1/${dir}/${fileName}` : `ledger/v1/${fileName}`
}

export async function writeAllLocal(engine: GitEngineLocal, view: LocalDbView, encrypted: boolean, deviceId: string, branch: string): Promise<ProjectResult> {
  const { files } = await buildFilesLocal(view, encrypted, deviceId)
  await engine.init(branch)
  const written: string[] = []
  for (const [name, content] of files) {
    const rel = relPathOf(name)
    const cur = await engine.readWorkFile(rel)
    if (cur === content) continue
    await engine.writeFile(rel + '.tmp', content)
    // lightning-fs 无 rename 覆盖语义保证时用"写 tmp + 读回 + 覆盖写"两步；
    // 实测 lightning-fs 支持 writeFile 覆盖，直接覆盖写即原子（单线程 JS 无半截读取）
    await engine.writeFile(rel, content)
    written.push(rel)
  }
  return { files: files.size, written }
}

export async function stageAllLocal(engine: GitEngineLocal): Promise<boolean> {
  const rows = await engine.statusMatrix()
  const toAdd: string[] = []
  const toRemove: string[] = []
  for (const [filepath, head, workdir] of rows as any[]) {
    if (head === workdir) continue
    if (Number(workdir) === 0) toRemove.push(filepath)
    else toAdd.push(filepath)
  }
  if (toAdd.length) await engine.add(toAdd)
  if (toRemove.length) await engine.remove(toRemove)
  return toAdd.length + toRemove.length > 0
}

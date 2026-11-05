/**
 * 离线同步吸收层（浏览器版，与服务端 ApplyRecordService 同语义）。
 *
 * 唯一写通道：rev 吸收、关系按 uid 解析、墓碑语义、当月恒等式重算。
 * 返回口径与服务端 ApplyOutcome 一字不差（skipped 前缀族 / failed 前缀族）。
 */
import { accountToRecord, canonicalRecord, entryToRecord, loanToRecord, recordToAccountData, recordToEntryData, recordToLoanData, recordToSnapshotData, recordToTypeData, snapshotToRecord, SYNC_SETTING_KEYS, typeToRecord } from './sync-shared'
import type { LedgerRecord as LedgerRecordT } from './sync-shared'
export type LedgerRecord = LedgerRecordT

export type ApplyOutcome = { applied: boolean; ym?: string; reason?: string; warning?: string }

export type ApplyDb = {
  types: any[]
  accounts: any[]
  snapshots: any[]
  entries: any[]
  loans: any[]
  settings: Record<string, string>
  noteSeen(rev: number): void
  nextId(): number
  persist(): void
  recomputeYm(ym: string): void
  pushTrash(kind: string, summary: string, payload: any): void
}

export const APPLY_ORDER: LedgerRecord['kind'][] = ['type', 'account', 'snapshot', 'entry', 'loan', 'setting']

function samePayload(localRec: LedgerRecord, incoming: LedgerRecord): boolean {
  const a = canonicalRecord({ ...localRec, rev: incoming.rev, updatedAt: incoming.updatedAt, origin: incoming.origin })
  const b = canonicalRecord(incoming)
  return a === b
}

export async function applyRecord(db: ApplyDb, rec: LedgerRecord): Promise<ApplyOutcome> {
  let out: ApplyOutcome
  switch (rec.kind) {
    case 'type':
      out = applyType(db, rec)
      break
    case 'account':
      out = applyAccount(db, rec)
      break
    case 'snapshot':
      out = applySnapshot(db, rec)
      break
    case 'entry':
      out = applyEntry(db, rec)
      break
    case 'loan':
      out = applyLoan(db, rec)
      break
    case 'setting':
      out = applySetting(db, rec)
      break
    default:
      out = { applied: false, reason: 'failed:unknown-kind' }
  }
  if (out.applied) db.noteSeen(rec.rev)
  return out
}

function maxSeenOf(db: ApplyDb): number {
  return Number(db.settings.gitMaxRev || 0) || 0
}

function applyType(db: ApplyDb, rec: LedgerRecord): ApplyOutcome {
  const local = db.types.find((t) => t.uid === rec.uid)
  const data = recordToTypeData(rec)
  if (!local) {
    db.types.push({ id: db.nextId(), uid: rec.uid, ...data, rev: rec.rev, updatedAt: rec.updatedAt, deleted: !!rec.deleted, origin: rec.origin || '' })
    db.persist()
    return { applied: true }
  }
  if (rec.rev < local.rev) return { applied: false, reason: 'skipped:stale' }
  if (samePayload(typeToRecord(local), rec)) return { applied: false, reason: 'skipped:identical' }
  const rev = rec.rev === local.rev ? rec.rev + 1 : rec.rev
  Object.assign(local, data, { rev, updatedAt: rec.updatedAt, deleted: !!rec.deleted, origin: rec.origin || '' })
  db.persist()
  return { applied: true }
}

function applyAccount(db: ApplyDb, rec: LedgerRecord): ApplyOutcome {
  const local = db.accounts.find((a) => a.uid === rec.uid)
  const data = recordToAccountData(rec)
  if (!local) {
    db.accounts.push({ id: db.nextId(), uid: rec.uid, ...data, rev: rec.rev, updatedAt: rec.updatedAt, deleted: !!rec.deleted, origin: rec.origin || '' })
    db.persist()
    return { applied: true }
  }
  if (rec.rev < local.rev) return { applied: false, reason: 'skipped:stale' }
  if (samePayload(accountToRecord(local), rec)) return { applied: false, reason: 'skipped:identical' }
  const rev = rec.rev === local.rev ? rec.rev + 1 : rec.rev
  Object.assign(local, data, { rev, updatedAt: rec.updatedAt, deleted: !!rec.deleted, origin: rec.origin || '' })
  db.persist()
  return { applied: true }
}

function applySnapshot(db: ApplyDb, rec: LedgerRecord): ApplyOutcome {
  const accountUid = String(rec.accountUid || '')
  const ym = String(rec.ym || '')
  const acc = accountUid ? db.accounts.find((a) => a.uid === accountUid) : null
  if (!acc) {
    return { applied: false, reason: 'failed:account-missing', warning: `snapshot ${rec.uid} (${ym || '(空)'}) 的账户 ${accountUid || '(空)'} 本机不存在，已跳过` }
  }
  if (!ym) return { applied: false, reason: 'failed:bad-ym' }
  const local =
    db.snapshots.find((s) => s.uid === rec.uid) ||
    db.snapshots.find((s) => s.ym === ym && s.accountId === acc.id)
  const data = recordToSnapshotData(rec)
  if (!local) {
    db.snapshots.push({ id: db.nextId(), uid: rec.uid, accountId: acc.id, ...data, rev: rec.rev, updatedAt: rec.updatedAt, deleted: !!rec.deleted, origin: rec.origin || '' })
    db.persist()
    return { applied: true, ym }
  }
  if (rec.rev < local.rev) return { applied: false, reason: 'skipped:stale' }
  if (samePayload(snapshotToRecord(local, accountUid), rec)) return { applied: false, reason: 'skipped:identical' }
  const rev = rec.rev === local.rev ? rec.rev + 1 : rec.rev
  Object.assign(local, { uid: rec.uid, accountId: acc.id, ...data, rev, updatedAt: rec.updatedAt, deleted: !!rec.deleted, origin: rec.origin || '' })
  db.persist()
  return { applied: true, ym }
}

function applyEntry(db: ApplyDb, rec: LedgerRecord): ApplyOutcome {
  if (rec.auto) return { applied: false, reason: 'skipped:auto' }
  const ym = String(rec.ym || '')
  if (!ym) return { applied: false, reason: 'failed:bad-ym' }
  const typeUid = String(rec.typeUid || '')
  let type = typeUid ? db.types.find((t) => t.uid === typeUid) : null
  let warning: string | undefined
  if (!type) {
    type = db.types.find((t) => t.builtin && !t.deleted)
    if (!type) return { applied: false, reason: 'failed:type-missing', warning: `条目 ${rec.uid} 的类型 ${typeUid || '(空)'} 本机不存在，且本机没有可用的内置类型，已跳过` }
    warning = `条目 ${rec.uid} 的类型 ${typeUid || '(空)'} 本机不存在，已回退为内置类型 ${type.name}`
  }
  const accountUid = rec.accountUid ? String(rec.accountUid) : ''
  const acc = accountUid ? db.accounts.find((a) => a.uid === accountUid) : null
  const local = db.entries.find((e) => e.uid === rec.uid)
  const data = recordToEntryData(rec)
  const link = { typeId: type.id, accountId: acc?.id ?? null }
  if (!local) {
    db.entries.push({ id: db.nextId(), uid: rec.uid, ...data, ...link, ym, rev: rec.rev, updatedAt: rec.updatedAt, deleted: !!rec.deleted, origin: rec.origin || '' })
    db.persist()
    return { applied: true, ym, ...(warning ? { warning } : {}) }
  }
  if (rec.rev < local.rev) return { applied: false, reason: 'skipped:stale', ...(warning ? { warning } : {}) }
  if (samePayload(entryToRecord(local, typeUid, accountUid || null), rec)) {
    return { applied: false, reason: 'skipped:identical', ...(warning ? { warning } : {}) }
  }
  const rev = rec.rev === local.rev ? rec.rev + 1 : rec.rev
  Object.assign(local, data, link, { rev, updatedAt: rec.updatedAt, deleted: !!rec.deleted, origin: rec.origin || '' })
  db.persist()
  return { applied: true, ym, ...(warning ? { warning } : {}) }
}

function applyLoan(db: ApplyDb, rec: LedgerRecord): ApplyOutcome {
  const accountUid = rec.accountUid ? String(rec.accountUid) : ''
  const acc = accountUid ? db.accounts.find((a) => a.uid === accountUid) : null
  const local = db.loans.find((l) => l.uid === rec.uid)
  const data = recordToLoanData(rec)
  const link = { accountId: acc?.id ?? null }
  if (!local) {
    db.loans.push({ id: db.nextId(), uid: rec.uid, ...data, ...link, rev: rec.rev, updatedAt: rec.updatedAt, deleted: !!rec.deleted, origin: rec.origin || '' })
    db.persist()
    return { applied: true }
  }
  if (rec.rev < local.rev) return { applied: false, reason: 'skipped:stale' }
  if (samePayload(loanToRecord(local, accountUid || null), rec)) return { applied: false, reason: 'skipped:identical' }
  const rev = rec.rev === local.rev ? rec.rev + 1 : rec.rev
  Object.assign(local, data, link, { rev, updatedAt: rec.updatedAt, deleted: !!rec.deleted, origin: rec.origin || '' })
  db.persist()
  return { applied: true }
}

function applySetting(db: ApplyDb, rec: LedgerRecord): ApplyOutcome {
  const key = String(rec.key || rec.uid || '')
  if (!SYNC_SETTING_KEYS.includes(key)) return { applied: false, reason: 'skipped:not-whitelisted' }
  if (rec.deleted) return { applied: false, reason: 'skipped:setting-tombstone' }
  const value = String(rec.value ?? '')
  const local = db.settings[key]
  if (local === undefined) {
    db.settings[key] = value
    db.persist()
    return { applied: true }
  }
  if (local === value) return { applied: false, reason: 'skipped:identical' }
  db.settings[key] = value
  db.persist()
  return { applied: true }
}

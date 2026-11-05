import type { LedgerRecord } from './ledger'

/**
 * DB 行 ↔ 同步记录的双向映射。
 * 规则：**同步载体里绝不出现自增 id**，关系一律用 uid（§3.1）；
 * 金额一律「分」的整数，键名带 Cents 后缀。
 */

const str = (v: any): string | null => (v === null || v === undefined || v === '' ? null : String(v))
const num = (v: any): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n) : 0
}

type Common = { uid: string | null; rev: number; updatedAt: number; deleted: boolean; origin: string }

function base(row: Common, kind: LedgerRecord['kind'], uidFallback: string): LedgerRecord {
  return {
    uid: row.uid || uidFallback,
    kind,
    rev: row.rev || 1,
    updatedAt: row.updatedAt || 0,
    deleted: !!row.deleted,
    origin: row.origin || '',
  }
}

export function typeToRecord(row: any): LedgerRecord {
  return {
    ...base(row, 'type', `legacy-t-${row.id}`),
    name: row.name,
    emoji: row.emoji,
    color: row.color ?? null,
    direction: row.direction,
    builtin: !!row.builtin,
    sort: num(row.sort),
  }
}

export function accountToRecord(row: any): LedgerRecord {
  return {
    ...base(row, 'account', `legacy-a-${row.id}`),
    name: row.name,
    emoji: row.emoji,
    accKind: row.kind,
    group: row.group ?? null,
    initBalanceCents: num(row.initBalance),
    inNetWorth: !!row.inNetWorth,
    sort: num(row.sort),
    archived: !!row.archived,
    note: row.note ?? null,
    createdAt: num(row.createdAt),
  }
}

export function snapshotToRecord(row: any, accountUid: string): LedgerRecord {
  return {
    ...base(row, 'snapshot', `${row.ym}__${accountUid}`),
    uid: row.uid || `${row.ym}__${accountUid}`,
    ym: row.ym,
    accountUid,
    balanceCents: num(row.balance),
    recordDate: row.recordDate,
    note: row.note ?? null,
  }
}

export function entryToRecord(row: any, typeUid: string, accountUid: string | null): LedgerRecord {
  return {
    ...base(row, 'entry', `legacy-e-${row.id}`),
    ym: row.ym,
    typeUid,
    amountCents: num(row.amount),
    note: row.note ?? null,
    accountUid,
    auto: !!row.auto,
  }
}

export function loanToRecord(row: any, accountUid: string | null): LedgerRecord {
  return {
    ...base(row, 'loan', `legacy-l-${row.id}`),
    direction: row.direction,
    counterparty: row.counterparty,
    amountCents: num(row.amount),
    settledCents: num(row.settledAmount),
    date: row.date,
    dueDate: row.dueDate ?? null,
    accountUid,
    note: row.note ?? null,
    createdAt: num(row.createdAt),
  }
}

export function settingToRecord(key: string, value: string): LedgerRecord {
  return {
    uid: key,
    kind: 'setting',
    key,
    value,
    rev: 1,
    updatedAt: 0,
    deleted: false,
    origin: '',
  }
}

// ---------------- 反向：记录 → DB 写入数据 ----------------

export function recordToTypeData(rec: LedgerRecord) {
  return {
    name: String(rec.name ?? '').slice(0, 20),
    emoji: String(rec.emoji ?? '🏷').slice(0, 8),
    color: str(rec.color),
    direction: ['income', 'expense', 'neutral'].includes(String(rec.direction)) ? String(rec.direction) : 'neutral',
    builtin: !!rec.builtin,
    sort: num(rec.sort),
  }
}

export function recordToAccountData(rec: LedgerRecord) {
  return {
    name: String(rec.name ?? '').slice(0, 30),
    emoji: String(rec.emoji ?? '🏦').slice(0, 8),
    kind: rec.accKind === 'liability' ? 'liability' : 'asset',
    group: str(rec.group),
    initBalance: num(rec.initBalanceCents),
    inNetWorth: rec.inNetWorth !== false,
    sort: num(rec.sort),
    archived: !!rec.archived,
    note: str(rec.note),
    createdAt: num(rec.createdAt) || Math.floor(Date.now() / 1000),
  }
}

export function recordToSnapshotData(rec: LedgerRecord) {
  return {
    ym: String(rec.ym ?? ''),
    balance: num(rec.balanceCents),
    recordDate: String(rec.recordDate ?? ''),
    note: str(rec.note),
  }
}

export function recordToEntryData(rec: LedgerRecord) {
  return {
    ym: String(rec.ym ?? ''),
    amount: num(rec.amountCents),
    note: str(rec.note),
    auto: !!rec.auto,
  }
}

export function recordToLoanData(rec: LedgerRecord) {
  return {
    direction: rec.direction === 'in' ? 'in' : 'out',
    counterparty: String(rec.counterparty ?? '').slice(0, 30),
    amount: num(rec.amountCents),
    settledAmount: num(rec.settledCents),
    date: String(rec.date ?? ''),
    dueDate: str(rec.dueDate),
    note: str(rec.note),
    createdAt: num(rec.createdAt) || Math.floor(Date.now() / 1000),
  }
}

/** 写库时统一带上的同步元数据 */
export function metaOf(rec: LedgerRecord, rev: number) {
  return { rev, updatedAt: rec.updatedAt || Math.floor(Date.now() / 1000), deleted: !!rec.deleted, origin: rec.origin || '' }
}

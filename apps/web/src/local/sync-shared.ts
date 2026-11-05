/**
 * 离线同步共享纯函数（浏览器版入口）。
 *
 * 策略：直接复用服务端源码（apps/server/src/sync/*.ts 全部无框架依赖，
 * 只有 node:crypto / node:fs / node:path 三个平台相关点，均已在下层抽象掉）。
 * 这里做三件事：
 *  1. 从服务端文件 re-export 纯函数（ledger / merge-driver / mappers / keep-commits / schedule）
 *  2. 提供浏览器版 codec（encode/decode 走 sync-crypto 的 noble 实现）
 *  3. 提供 defaultAuthUser / hasStage3（git-engine.ts 里的两个小纯函数，浏览器引擎共用）
 *
 * Vite 解析服务端源码路径：../../../../server → apps/server，根据 tsconfig include 需放行。
 * 若构建期报"超出 root"，改由本文件逐个 re-export 改为复制（当前先用相对导入）。
 */
export {
  canonicalRecord,
  canonicalEncrypted,
  isEncryptedEnvelope,
  parseRecordText,
  sameRecord,
  fileNameOf,
  kindOfFileName,
  uidOfFileName,
  repoPathOf,
  repoPathOfFile,
  DIR_OF,
  KIND_FIELDS,
  DIFF_FIELDS,
  RECORD_KINDS,
  KIND_PREFIX,
  PREFIX_KIND,
  SYNC_SETTING_KEYS,
  diffFields,
  formatValue,
  titleOf,
  decideMerge,
  recommendPick,
  recommendFromTexts,
  composeResolved,
  fingerprint,
  tieBreakPick,
  type LedgerRecord,
  type ParseResult,
  type FieldDiff,
  type Pick,
  type ConflictType,
  type Recommend,
  type MergeDecision,
  type TitleCtx,
} from '@server-sync/ledger'

export { makeLedgerDriver, type CapturedTriple, type DriverOutcome } from '@server-sync/merge-driver'

export { nextSnapshotTag, rollMessage, shouldRoll, parseKeepCommits, DEFAULT_KEEP_COMMITS, MIN_KEEP_COMMITS } from '@server-sync/keep-commits'

export { shouldRunNow, backoffMinutes, isPermanentFailure, permanentFailureHint, leaseAllowsForce, MAX_AUTO_RETRIES, shouldHalt } from '@server-sync/schedule'

export {
  accountToRecord,
  entryToRecord,
  loanToRecord,
  snapshotToRecord,
  typeToRecord,
  settingToRecord,
  recordToAccountData,
  recordToEntryData,
  recordToLoanData,
  recordToSnapshotData,
  recordToTypeData,
  metaOf,
} from '@server-sync/mappers'

import {
  canonicalEncrypted,
  canonicalRecord,
  isEncryptedEnvelope,
  parseRecordText,
  type LedgerRecord,
  type ParseResult,
} from '@server-sync/ledger'
import { decryptEnvelopeLocal, encryptEnvelopeLocal, keyHintLocal } from './sync-crypto'

export function encodeRecordLocal(rec: LedgerRecord, encrypted: boolean): string {
  if (!encrypted) return canonicalRecord(rec)
  return canonicalEncrypted(encryptEnvelopeLocal(canonicalRecord(rec), { deterministic: true }), rec.rev, rec.deleted)
}

export function decodeRecordLocal(text: string, fileName?: string): ParseResult {
  const trimmed = (text || '').trim()
  if (!trimmed) return { ok: false, reason: 'empty' }
  let obj: any = null
  try {
    obj = JSON.parse(trimmed)
  } catch {
    return { ok: false, reason: 'invalid', message: 'JSON 解析失败' }
  }
  if (!isEncryptedEnvelope(obj)) return parseRecordText(trimmed, fileName)
  try {
    const plain = decryptEnvelopeLocal(obj.enc)
    return parseRecordText(plain, fileName)
  } catch {
    const hint = typeof obj?.enc?.hint === 'string' ? obj.enc.hint : ''
    const local = keyHintLocal()
    const message =
      hint && local && hint !== local
        ? `密钥不匹配（远端由指纹 ${hint} 的密钥加密，本机为 ${local}）`
        : '远端仓库已加密，请在本机开启加密并填入同一密钥'
    return { ok: false, reason: 'encrypted', message, rev: Number(obj.rev) || 0, deleted: !!obj.deleted }
  }
}

/** 与服务端 git-engine.defaultAuthUser 同口径（Gitee/GitLab 用 oauth2） */
export function defaultAuthUser(url: string | undefined | null, fallback = 'x-access-token'): string {
  const host = /^(?:https?:\/\/)([^/@:]+)/i.exec(String(url || ''))?.[1]?.toLowerCase() || ''
  if (/\bgitee\.com$/.test(host) || /(^|\.)gitlab\./.test(host)) return 'oauth2'
  return fallback
}

/** 与服务端 git-engine.hasStage3 同口径：只认第 4 列 */
export function hasStage3(matrix: any[][]): boolean {
  return matrix.some((row) => Number(row[3]) === 3)
}

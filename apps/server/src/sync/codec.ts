import { canonicalEncrypted, canonicalRecord, isEncryptedEnvelope, parseRecordText, type LedgerRecord, type ParseResult } from './ledger'
import { decryptEnvelope, encryptEnvelope, keyHint } from './crypto'

/**
 * 记录文本的编解码：加密开关只影响这一层，上层（驱动 / 裁决 / 吸收）永远面对明文记录。
 * `gitEncrypt=on` 时整份密文，但 rev/deleted 留明文（排障展示用，不参与自动裁决）。
 */
export function encodeRecord(rec: LedgerRecord, encrypted: boolean): string {
  if (!encrypted) return canonicalRecord(rec)
  // deterministic：同一份记录在两端必须密文逐字节相同，否则加密档处处冲突
  return canonicalEncrypted(encryptEnvelope(canonicalRecord(rec), { deterministic: true }), rec.rev, rec.deleted)
}

/**
 * 解析（自动识别密文信封）；密钥不匹配时返回 reason='encrypted'，界面只显示指纹。
 * message 按 §7.1 三行表给定稿文案（R14：不静默降级，评审修复项）：
 *   - 信封 hint 与本机密钥指纹不同 → 「密钥不匹配（远端由 <hint> 加密）」
 *   - 本机没开加密却读到密文 → 「远端仓库已加密，请在本机开启加密并填入同一密钥」
 * 旧实现只回一句通用"内容为密文"，两端排障分不清是哪种情况。
 */
export function decodeRecord(text: string, fileName?: string): ParseResult {
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
    const plain = decryptEnvelope(obj.enc)
    return parseRecordText(plain, fileName)
  } catch {
    const hint = typeof obj?.enc?.hint === 'string' ? obj.enc.hint : ''
    const local = keyHint()
    const message =
      hint && local && hint !== local
        ? `密钥不匹配（远端由指纹 ${hint} 的密钥加密，本机为 ${local}）`
        : '远端仓库已加密，请在本机开启加密并填入同一密钥'
    return { ok: false, reason: 'encrypted', message, rev: Number(obj.rev) || 0, deleted: !!obj.deleted }
  }
}

/**
 * 离线同步加密（浏览器版，与服务端 apps/server/src/sync/crypto.ts 同语义）。
 *
 * 差异只有载体：node:crypto → WebCrypto(@noble/*) + localStorage 存 git.key。
 * 算法口径必须一字不差，否则两端同一把密钥解不开对方的密文：
 *  · 记录信封 AES-256-GCM + 确定性 IV(SHA-256(明文)前12B) + hint(主钥sha256前12hex)
 *  · 主钥域分离 HKDF-SHA256('suiji-ledger:git.key:records'/'...:secrets')
 *  · 凭据随机 IV + 独立子钥
 *  · 旧钥兼容：先子钥、再主钥原文
 */
import { gcm } from '@noble/ciphers/aes.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

export type EncEnvelope = { iv: string; ct: string; tag: string; alg: 'AES-256-GCM'; hint?: string }

const ALG = 'AES-256-GCM' as const
const KEY_SETTING = 'git.key.local'
const enc = new TextEncoder()
const dec = new TextDecoder()

function b64e(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
function b64d(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function hex(buf: Uint8Array): string {
  return [...buf].map((x) => x.toString(16).padStart(2, '0')).join('')
}
function parseKey(raw: string): Uint8Array | null {
  const s = raw.trim()
  if (/^[0-9a-f]{64}$/i.test(s)) {
    const out = new Uint8Array(32)
    for (let i = 0; i < 32; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
    return out
  }
  try {
    const b = b64d(s)
    return b.length === 32 ? b : null
  } catch {
    return null
  }
}

/** 本机主钥：存 localStorage（git.key.local），与服务端 DATA_DIR/git.key 同款 32B hex */
export function gitKeyBytes(): Uint8Array {
  try {
    const raw = localStorage.getItem(KEY_SETTING) || ''
    const k = raw ? parseKey(raw) : null
    if (k) return k
  } catch { /* 无存储则新建 */ }
  const buf = new Uint8Array(32)
  crypto.getRandomValues(buf)
  try {
    localStorage.setItem(KEY_SETTING, hex(buf))
  } catch { /* 存储满则只用内存钥，本次会话有效 */ }
  return buf
}

/** 外部拷入密钥（两台设备首次开加密前必须放同一把）：hex 或 base64 均认 */
export function setGitKey(raw: string): boolean {
  const k = parseKey(raw)
  if (!k) return false
  try {
    localStorage.setItem(KEY_SETTING, hex(k))
  } catch { /* 忽略 */ }
  return true
}

const derive = (info: string): Uint8Array => hkdf(sha256, gitKeyBytes(), undefined, enc.encode(info), 32)
export function recordKeyBytes(): Uint8Array {
  return derive('suiji-ledger:git.key:records')
}
export function secretKeyBytes(): Uint8Array {
  return derive('suiji-ledger:git.key:secrets')
}

export function keyHintLocal(): string {
  try {
    return hex(sha256(gitKeyBytes())).slice(0, 12)
  } catch {
    return ''
  }
}

function sealEnvelope(key: Uint8Array, plain: string, deterministic: boolean): EncEnvelope {
  const pt = enc.encode(plain)
  const iv = deterministic ? sha256(pt).subarray(0, 12) : crypto.getRandomValues(new Uint8Array(12))
  const c = gcm(key, iv)
  const ctTag = c.encrypt(pt)
  const tag = ctTag.subarray(ctTag.length - 16)
  const ct = ctTag.subarray(0, ctTag.length - 16)
  return { iv: b64e(iv), ct: b64e(ct), tag: b64e(tag), alg: ALG }
}

function openEnvelope(key: Uint8Array, env: EncEnvelope): string {
  const iv = b64d(env.iv)
  const ct = b64d(env.ct)
  const tag = b64d(env.tag)
  const c = gcm(key, iv)
  const full = new Uint8Array(ct.length + tag.length)
  full.set(ct, 0)
  full.set(tag, ct.length)
  return dec.decode(c.decrypt(full))
}

function openWithLegacy(primary: () => Uint8Array, env: EncEnvelope): string {
  try {
    return openEnvelope(primary(), env)
  } catch (e) {
    try {
      return openEnvelope(gitKeyBytes(), env)
    } catch {
      throw e
    }
  }
}

function assertAlg(env: EncEnvelope | null | undefined): asserts env is EncEnvelope {
  if (!env || env.alg !== ALG) throw new Error('未知的加密算法')
}

export function encryptEnvelopeLocal(plain: string, opts: { deterministic?: boolean } = {}): EncEnvelope {
  const envelope = sealEnvelope(recordKeyBytes(), plain, !!opts.deterministic)
  if (opts.deterministic) envelope.hint = keyHintLocal()
  return envelope
}

export function decryptEnvelopeLocal(env: EncEnvelope): string {
  assertAlg(env)
  return openWithLegacy(recordKeyBytes, env)
}

export function encryptSecretLocal(plain: string): string {
  return b64e(enc.encode(JSON.stringify(sealEnvelope(secretKeyBytes(), plain, false))))
}

export function decryptSecretLocal(blob: string): string {
  const env = JSON.parse(dec.decode(b64d(blob))) as EncEnvelope
  assertAlg(env)
  return openWithLegacy(secretKeyBytes, env)
}

export function maskSecretLocal(plain: string): string {
  return `已配置 · ****${plain.slice(-4)}`
}

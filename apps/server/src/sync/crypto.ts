import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../env'

/**
 * 本机密钥：`DATA_DIR/git.key`（32B，与 main.ts 的 secret.key 同款持久化方式）。
 * 仓库根是 `DATA_DIR/git/`，密钥放在上一级，**不进 git**（R4）。
 */
const KEY_FILE = () => path.join(DATA_DIR, 'git.key')

/**
 * 缓存但**按内容指纹失效**：用户把另一台设备的 git.key 拷过来时，
 * 不能要求重启进程才认新密钥（否则表现为"密钥换了还是解不开/还是用旧的"）。
 *
 * ⚠️ 指纹必须是**内容哈希**而不是 mtime+size（docs/21 §13.2）：
 * 资源管理器拷贝会保留源 mtime，且密钥文件长度恒为 64 hex——旧实现两项全相同，
 * 拷钥后继续用旧缓存，正是文档明令避免的表现。这里直接比原文（32B 钥，代价可忽略）。
 */
let cached: { raw: string; buf: Buffer } | null = null

export function gitKey(): Buffer {
  const file = KEY_FILE()
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8').trim()
    if (cached && cached.raw === raw) return cached.buf
    // 兼容 hex 与 base64 两种历史写法
    const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
    if (buf.length === 32) {
      cached = { raw, buf }
      return buf
    }
  }
  const buf = crypto.randomBytes(32)
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(file, buf.toString('hex'), { mode: 0o600 })
  cached = { raw: fs.readFileSync(file, 'utf8').trim(), buf }
  return buf
}

/**
 * 域分离子密钥（HKDF-SHA256，docs/21 v1.3 修正的落地）：记录加密（确定性 IV / 收敛加密）
 * 与 PAT（随机 IV）不再共用同一把 32B 主密钥——同钥双用途时一处的密钥相关性质
 * 可能渗到另一处。派生确定性，两端同一把 git.key 必得同一把子钥，跨设备解密不受影响。
 */
const derive = (info: string) => Buffer.from(crypto.hkdfSync('sha256', gitKey(), Buffer.alloc(0), Buffer.from(info, 'utf8'), 32))

/** 记录/信封加密用子钥 */
export function recordKey(): Buffer {
  return derive('suiji-ledger:git.key:records')
}

/** 凭据（PAT）加密用子钥 */
export function secretKey(): Buffer {
  return derive('suiji-ledger:git.key:secrets')
}

/**
 * keyHint（docs/21 §7.2）：主密钥内容指纹前 12 hex，随 backup() 导出。
 * 只用于人眼核对"备份时的密钥与本机当前密钥是否同一把"，本身不泄露密钥。
 * 密钥丢失 = 历史密文不可解，等同丢失远端。
 */
export function keyHint(): string {
  try {
    return crypto.createHash('sha256').update(gitKey()).digest('hex').slice(0, 12)
  } catch {
    return ''
  }
}

export type EncEnvelope = { iv: string; ct: string; tag: string; alg: 'AES-256-GCM'; hint?: string }

const ALG = 'AES-256-GCM' as const

/**
 * 构造信封（真正的加密动作）。
 *
 * `deterministic: true` 是**同步仓库的硬要求**，不是可选优化：
 * 随机 IV 下同一份明文每次加密都出不同密文，于是"两端内容完全一致"在 git 眼里
 * 也是"双端都改"→ 加密档每个文件都进冲突（e2e 实测：26 个文件全冲突，裁决都裁不完）。
 * 确定性 IV 取自 SHA-256(明文) 前 12 字节：不同明文必得不同 IV，
 * 只有明文相同才复用 IV —— 这是收敛加密（convergent encryption），
 * 代价是"密文相同 ⇒ 明文相同"这层等价关系会泄露，对账本记录可以接受。
 * 凭据（PAT）走随机 IV，不适用这条。
 *
 * （评审修复项：这段说明原来错挂在 `aesGcmOpen` 上——那是个只解密的函数，
 * 谁都以为"加密函数在上面"，改 IV 策略时最容易改错地方。）
 */
function sealEnvelope(key: Buffer, plain: string, opts: { deterministic?: boolean } = {}): EncEnvelope {
  const iv = opts.deterministic
    ? crypto.createHash('sha256').update(plain, 'utf8').digest().subarray(0, 12)
    : crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64'), alg: ALG }
}

function openEnvelope(key: Buffer, env: EncEnvelope): string {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]).toString('utf8')
}

/**
 * 旧钥兼容通道：HKDF 域分离之前落盘的密文用的是**主密钥原文**。
 * 先试子钥、失败再试主钥，都不成才抛出**第一次**的错误（保留原始定性信息）。
 *
 * 抽成一个函数而不是两处 try/catch（评审修复项 Duplicated Code）：记录解密与凭据解密
 * 原本各抄一份完全相同的兜底，任一侧漏改就会出现"记录能解、PAT 解不开"这种对不上号的现象。
 */
function openWithLegacy(primaryKey: () => Buffer, env: EncEnvelope): string {
  try {
    return openEnvelope(primaryKey(), env)
  } catch (e) {
    try {
      return openEnvelope(gitKey(), env)
    } catch {
      throw e
    }
  }
}

function assertAlg(env: EncEnvelope | null | undefined): asserts env is EncEnvelope {
  if (!env || env.alg !== ALG) throw new Error('未知的加密算法')
}

/** 记录文件信封（确定性 IV 才有 hint） */
export function encryptEnvelope(plain: string, opts: { deterministic?: boolean } = {}): EncEnvelope {
  const env = sealEnvelope(recordKey(), plain, opts)
  // hint = 加密时所使用密钥的指纹（非机密，只有 12 hex 哈希前缀）。
  // §7.1 的三条跨端不一致文案要靠它区分"密钥不匹配" vs"本机没开加密"——
  // 没有 hint，两端密文撞车时只能说"内容为密文"（R14 不静默降级打了折，评审修复项）。
  // 确定性不受影响：同明文 + 同密钥 ⇒ hint 相同 ⇒ 双端密文逐字节仍一致（v1.3 修正 1）。
  if (opts.deterministic) env.hint = keyHint()
  return env
}

export function decryptEnvelope(env: EncEnvelope): string {
  assertAlg(env)
  return openWithLegacy(recordKey, env)
}

/** 凭据加密：落库的是 base64(JSON envelope)，不是明文 PAT；随机 IV + 独立派生子钥 */
export function encryptSecret(plain: string): string {
  return Buffer.from(JSON.stringify(sealEnvelope(secretKey(), plain)), 'utf8').toString('base64')
}

export function decryptSecret(blob: string): string {
  const env = JSON.parse(Buffer.from(blob, 'base64').toString('utf8')) as EncEnvelope
  assertAlg(env)
  return openWithLegacy(secretKey, env)
}

/** 脱敏展示：`已配置 · ****1a2f` */
export function maskSecret(plain: string): string {
  const tail = plain.slice(-4)
  return `已配置 · ****${tail}`
}

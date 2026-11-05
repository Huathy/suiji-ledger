#!/usr/bin/env node
/**
 * M4a 一次性迁移（幂等）：给 5 张业务表补 uid / rev / updatedAt / deleted / origin。
 *
 * 跑法：node apps/server/scripts/m4a-migrate.mjs [--dry-run]
 * 说明：
 *  - --dry-run 只报告将改什么，不写库、不留痕文件（评审修复：直改生产库前先看清单）。
 *  - 只补 NULL 的列，重复执行不会改动已有 uid（uid 一旦生成就是跨设备主键，绝不能重写）。
 *  - SQLite 没有 uuid 函数，脚本侧生成 uuid v4。
 *  - MonthlySnapshot 的 uid 是派生键 `${ym}__${accountUid}`（跨设备稳定，不依赖自增 id）。
 *  - 跑前请先手动落一份全量备份（我的 → 导出全量备份 JSON）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER_ROOT = path.resolve(HERE, '..')
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(SERVER_ROOT, 'data')

// ⚠️ 同上：import '@prisma/client' 已注入 .env 里的相对 DATABASE_URL，必须强制覆盖
process.env.DATABASE_URL = 'file:' + path.join(DATA_DIR, 'money.db').split(path.sep).join('/')

const prisma = new PrismaClient()
const DRY = process.argv.includes('--dry-run')
const now = () => Math.floor(Date.now() / 1000)

async function getOrCreateDeviceId() {
  const row = await prisma.setting.findUnique({ where: { key: 'gitDeviceId' } })
  if (row?.value) return row.value
  const id = 'd_' + crypto.randomBytes(4).toString('hex')
  if (!DRY) await prisma.setting.upsert({ where: { key: 'gitDeviceId' }, update: { value: id }, create: { key: 'gitDeviceId', value: id } })
  return id
}

async function main() {
  const deviceId = await getOrCreateDeviceId()
  const ts = now()
  const report = {}

  // 1. 类型
  const types = await prisma.recordType.findMany()
  let n = 0
  for (const t of types) {
    if (t.uid && t.updatedAt) continue
    if (!DRY) await prisma.recordType.update({
      where: { id: t.id },
      data: { uid: t.uid || crypto.randomUUID(), rev: t.rev || 1, updatedAt: t.updatedAt || ts, origin: t.origin || deviceId },
    })
    n++
  }
  report.types = n

  // 2. 账户（先补，快照 uid 依赖它）
  const accounts = await prisma.account.findMany()
  const accUid = new Map()
  n = 0
  for (const a of accounts) {
    let uid = a.uid
    if (!uid) uid = crypto.randomUUID()
    accUid.set(a.id, uid)
    if (a.uid && a.updatedAt) continue
    if (!DRY) await prisma.account.update({
      where: { id: a.id },
      data: { uid, rev: a.rev || 1, updatedAt: a.updatedAt || ts, origin: a.origin || deviceId },
    })
    n++
  }
  report.accounts = n

  // 3. 快照：uid = `${ym}__${accountUid}`
  const snaps = await prisma.monthlySnapshot.findMany()
  n = 0
  for (const s of snaps) {
    const au = accUid.get(s.accountId)
    if (!au) continue // 孤儿快照（账户已被删）不参与同步
    const uid = `${s.ym}__${au}`
    if (s.uid === uid && s.updatedAt) continue
    if (!DRY) await prisma.monthlySnapshot.update({
      where: { id: s.id },
      data: { uid, rev: s.rev || 1, updatedAt: s.updatedAt || ts, origin: s.origin || deviceId },
    })
    n++
  }
  report.snapshots = n

  // 4. 条目
  const entries = await prisma.changeEntry.findMany()
  n = 0
  for (const e of entries) {
    if (e.uid && e.updatedAt) continue
    if (!DRY) await prisma.changeEntry.update({
      where: { id: e.id },
      data: { uid: e.uid || crypto.randomUUID(), rev: e.rev || 1, updatedAt: e.updatedAt || ts, origin: e.origin || deviceId },
    })
    n++
  }
  report.entries = n

  // 5. 借还
  const loans = await prisma.loan.findMany()
  n = 0
  for (const l of loans) {
    if (l.uid && l.updatedAt) continue
    if (!DRY) await prisma.loan.update({
      where: { id: l.id },
      data: { uid: l.uid || crypto.randomUUID(), rev: l.rev || 1, updatedAt: l.updatedAt || ts, origin: l.origin || deviceId },
    })
    n++
  }
  report.loans = n

  // 6. 同步状态键（缺失时补默认值，避免前端读到 undefined）
  if (!DRY) for (const [key, value] of Object.entries({ gitLastRemoteOid: '', gitMaxRev: '0' })) {
    const row = await prisma.setting.findUnique({ where: { key } })
    if (!row) await prisma.setting.create({ data: { key, value } })
  }

  // 7. 旧明文 PAT → gitAuthEnc（与 sync/crypto.ts 同款 HKDF 派生 + AES-256-GCM），迁移即清空明文键
  //    （docs/21 §7.2「旧明文键迁移时清空」——评审修复项：明文键此前既不清也不加密）
  const legacy = await prisma.setting.findUnique({ where: { key: 'gitAuth' } })
  if (legacy?.value && !DRY) {
    const keyFile = path.join(DATA_DIR, 'git.key')
    if (!fs.existsSync(keyFile)) {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 })
    }
    const rawKey = fs.readFileSync(keyFile, 'utf8').trim()
    const mainKey = /^[0-9a-f]{64}$/i.test(rawKey) ? Buffer.from(rawKey, 'hex') : Buffer.from(rawKey, 'base64')
    if (mainKey.length !== 32) throw new Error('git.key 不是合法 32B 密钥，终止（不猜）')
    const sk = Buffer.from(crypto.hkdfSync('sha256', mainKey, Buffer.alloc(0), Buffer.from('suiji-ledger:git.key:secrets'), Buffer.alloc(32)))
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', sk, iv)
    const ct = Buffer.concat([cipher.update(legacy.value, 'utf8'), cipher.final()])
    const env = { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64'), alg: 'AES-256-GCM' }
    const blob = Buffer.from(JSON.stringify(env), 'utf8').toString('base64')
    await prisma.setting.upsert({ where: { key: 'gitAuthEnc' }, update: { value: blob }, create: { key: 'gitAuthEnc', value: blob } })
    await prisma.setting.upsert({ where: { key: 'gitAuth' }, update: { value: '' }, create: { key: 'gitAuth', value: '' } })
    report.gitAuthMigrated = 1
  } else if (legacy?.value && DRY) {
    report.gitAuthMigrated = '(dry-run：将加密并清空明文 gitAuth)'
  }

  // 迁移完立即落一份备份，留痕
  // ⚠️ settings 过 SECRET_KEYS 过滤：留痕文件也是"会离开本机的 JSON"，不能带凭据（评审修复项同源）
  const SECRET_KEYS = new Set(['gitAuthEnc', 'gitAuth', 'gitConflictState'])
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = path.join(DATA_DIR, 'backups')
  fs.mkdirSync(dir, { recursive: true })
  const all = {
    format: 'suiji-ledger-backup',
    version: 1,
    exportedAt: Date.now(),
    reason: 'M4a uid 迁移',
    types: await prisma.recordType.findMany(),
    accounts: await prisma.account.findMany(),
    snapshots: await prisma.monthlySnapshot.findMany(),
    entries: await prisma.changeEntry.findMany(),
    loans: await prisma.loan.findMany(),
    settings: (await prisma.setting.findMany()).filter((s) => !SECRET_KEYS.has(s.key)),
  }
  if (!DRY) fs.writeFileSync(path.join(dir, `m4a-${stamp}.json`), JSON.stringify(all))

  console.log('[m4a] deviceId =', deviceId)
  console.log('[m4a] 补齐行数:', report)
}

main()
  .catch((e) => {
    console.error('[m4a] 迁移失败:', e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())

/**
 * 自动快照的密钥过滤（评审修复项，任务 2）。
 *
 * 断言的是**落盘的真实 JSON**，不是内存里的 payload：BackupService.snapshot() 只写文件、
 * 不返回数据，所以测试读 DATA_DIR/backups/ 下最新那份 auto-*.json 来判定。
 * DATA_DIR 必须在 import backup.service **之前**指向临时目录（env.ts 在模块加载时求值）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let BackupService: any
let dir = ''

// 非密钥设置：必须原样留在备份里（别把过滤写成"settings 直接丢掉"）
const NORMAL_SETTINGS = [
  { key: 'theme', value: 'dark' },
  { key: 'gitRemote', value: 'https://example.invalid/repo.git' },
  { key: 'gitAuthUser', value: 'oauth2' }, // key 里带 gitAuth 前缀，但本身不是凭据
  { key: 'timeSortDir', value: 'desc' },
]
// 三个必须被过滤的键（与 secret-keys.ts 的 SECRET_KEYS 对齐）
const SECRET_SETTINGS = [
  { key: 'gitAuthEnc', value: 'eyJjdCI6IkFCQ0RFRiJ9' },
  { key: 'gitAuth', value: 'ghp_THISISAPLAINTOKEN' },
  { key: 'gitConflictState', value: '{"items":[{"ours":"明文余额 123.45"}]}' },
]

function newestBackupFile(): string {
  const dir = path.join(process.env.DATA_DIR!, 'backups')
  const files = fs.readdirSync(dir).filter((f) => /^auto-\d{8}-\d{6}\.json$/.test(f)).sort()
  expect(files.length).toBeGreaterThan(0)
  return path.join(dir, files[files.length - 1])
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suiji-backup-secret-'))
  // 先定 DATA_DIR，再动态 import（env.ts / crypto.ts 都在 import 时读它）
  process.env.DATA_DIR = dir
  ;({ BackupService } = await import('../apps/server/src/backup.service'))
})

afterAll(() => {
  delete process.env.DATA_DIR
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 临时目录清理失败不影响结论 */
  }
})

function makeBackup(settings: any[]) {
  const prisma: any = {
    recordType: { findMany: async () => [{ id: 1, uid: 't1', name: '工资' }] },
    account: { findMany: async () => [{ id: 1, uid: 'a1', name: '招行' }] },
    monthlySnapshot: { findMany: async () => [{ id: 1, uid: 's1', ym: '2026-10', balance: 100 }] },
    changeEntry: { findMany: async () => [{ id: 1, uid: 'e1', ym: '2026-10', amount: 50 }] },
    loan: { findMany: async () => [{ id: 1, uid: 'l1', counterparty: '老王' }] },
    setting: { findMany: async () => settings },
  }
  return new BackupService(prisma)
}

describe('自动快照：SECRET_KEYS 一律不落盘', () => {
  it('settings 不含 gitAuthEnc / gitAuth / gitConflictState，且带 settingsKeyHint', async () => {
    const svc = makeBackup([...NORMAL_SETTINGS, ...SECRET_SETTINGS])
    await svc.snapshot('测试快照')
    const raw = fs.readFileSync(newestBackupFile(), 'utf8')
    const payload = JSON.parse(raw)

    const keys = payload.settings.map((r: any) => r.key)
    expect(keys).not.toContain('gitAuthEnc')
    expect(keys).not.toContain('gitAuth')
    expect(keys).not.toContain('gitConflictState')
    // 非密钥设置一条不少（gitAuthUser 只是名字像凭据，不是名单成员）
    for (const s of NORMAL_SETTINGS) expect(keys).toContain(s.key)

    // 强断言：明文 PAT 与密文/blobs 的字节根本没进文件
    expect(raw).not.toContain('ghp_THISISAPLAINTOKEN')
    expect(raw).not.toContain('明文余额 123.45')
    expect(raw).not.toContain('eyJjdCI6IkFCQ0RFRiJ9')

    // 密钥指纹：12 hex，供恢复时核对"备份来自另一把密钥"（docs/21 §7.2）
    expect(payload.settingsKeyHint).toMatch(/^[0-9a-f]{12}$/)
  })

  it('settings 只有密钥行时导出为空数组，流程不炸', async () => {
    const svc = makeBackup([...SECRET_SETTINGS])
    await svc.snapshot('只有密钥')
    const payload = JSON.parse(fs.readFileSync(newestBackupFile(), 'utf8'))
    expect(payload.settings).toEqual([])
    expect(payload.settingsKeyHint).toMatch(/^[0-9a-f]{12}$/)
  })
})

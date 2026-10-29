import { Injectable } from '@nestjs/common'
import fs from 'node:fs'
import path from 'node:path'
import { PrismaService } from './prisma.service'
import { DATA_DIR } from './env'

/**
 * 自动备份轮转：重要数据变更后落一份全量 JSON 到 DATA_DIR/backups/，保留最近 30 份。
 * 由 reconcile / setBalance / 条目增删改 / 借还增删 / 恢复 等操作触发。
 */
@Injectable()
export class BackupService {
  constructor(private prisma: PrismaService) {}

  private dir(): string {
    return path.join(DATA_DIR, 'backups')
  }

  async snapshot(reason: string): Promise<void> {
    try {
      const dir = this.dir()
      fs.mkdirSync(dir, { recursive: true })
      const [types, accounts, snapshots, entries, loans, settings] = await Promise.all([
        this.prisma.recordType.findMany(),
        this.prisma.account.findMany(),
        this.prisma.monthlySnapshot.findMany(),
        this.prisma.changeEntry.findMany(),
        this.prisma.loan.findMany(),
        this.prisma.setting.findMany(),
      ])
      const payload = {
        format: 'suiji-ledger-backup',
        version: 1,
        exportedAt: Date.now(),
        reason,
        types, accounts, snapshots, entries, loans, settings,
        meta: { snapshotCount: snapshots.length, entryCount: entries.length },
      }
      const d = new Date()
      const p2 = (n: number) => String(n).padStart(2, '0')
      const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
      fs.writeFileSync(path.join(dir, `auto-${stamp}.json`), JSON.stringify(payload))
      // 轮转：保留最近 30 份
      const files = fs.readdirSync(dir).filter((f) => /^auto-\d{8}-\d{6}\.json$/.test(f)).sort()
      while (files.length > 30) {
        const oldest = files.shift()!
        fs.unlinkSync(path.join(dir, oldest))
      }
    } catch (e: any) {
      console.warn('[SuijiLedger] 自动备份失败:', e?.message || e)
    }
  }
}

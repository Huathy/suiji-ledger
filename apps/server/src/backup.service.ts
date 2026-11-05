import { Injectable } from '@nestjs/common'
import fs from 'node:fs'
import path from 'node:path'
import { PrismaService } from './prisma.service'
import { DATA_DIR } from './env'
import { keyHint } from './sync/crypto'
import { SECRET_KEYS } from './secret-keys'

/**
 * 自动备份轮转：重要数据变更后落一份全量 JSON 到 DATA_DIR/backups/，保留最近 30 份。
 * 由 reconcile / setBalance / 条目增删改 / 借还增删 / 恢复 等操作触发。
 */
@Injectable()
export class BackupService {
  /**
   * 快照后的旁听者：M4 的同步触发挂在这里（D10），
   * 这样 11 个写操作调用点一个都不用改，也不会出现 BackupService ↔ SyncService 的循环依赖。
   */
  private listeners: Array<(reason: string) => void> = []

  constructor(private prisma: PrismaService) {}

  onSnapshot(cb: (reason: string) => void): void {
    this.listeners.push(cb)
  }

  private dir(): string {
    return path.join(DATA_DIR, 'backups')
  }

  /**
   * `notify:false` = 只落备份文件，**不叫醒旁听者**。
   * 同步引擎自己的「同步前」快照必须走这条：它是在 run() 门内拍的，
   * 若照样广播，handleSnapshot 会给它再排一次 every-commit 的 debounce，
   * 于是 run → 快照 → 排程 → run → … 形成**绕过 nextRetryAt 的自激重试环**
   * （实测每 ~5s 一轮，403 就是这样被刷到 retries=452 的）。
   * 用户写操作触发的快照仍照常广播——那才是真正"有待推变更"的信号。
   */
  async snapshot(reason: string, opts: { notify?: boolean } = {}): Promise<void> {
    try {
      const dir = this.dir()
      fs.mkdirSync(dir, { recursive: true })
      const [types, accounts, snapshots, entries, loans, settingRows] = await Promise.all([
        this.prisma.recordType.findMany(),
        this.prisma.account.findMany(),
        this.prisma.monthlySnapshot.findMany(),
        this.prisma.changeEntry.findMany(),
        this.prisma.loan.findMany(),
        this.prisma.setting.findMany(),
      ])
      /**
       * 自动快照同样必须过 SECRET_KEYS 过滤（口径对齐 `system.service.ts` 的 backup()）：
       * 这份 JSON 明文落在 DATA_DIR/backups/ 里，桌面版/手机端还会被用户拷进取证目录。
       * 原样导出会把 gitAuth（明文 PAT）、gitAuthEnc（凭据密文）、gitConflictState
       * （冲突三方快照，含两端明文财务数据）一起写进磁盘 —— 凭据等于离开本机。
       */
      const settings = settingRows.filter((r) => !SECRET_KEYS.has(r.key))
      const payload = {
        format: 'suiji-ledger-backup',
        version: 1,
        exportedAt: Date.now(),
        reason,
        types, accounts, snapshots, entries, loans, settings,
        /**
         * 密钥指纹（docs/21 §7.2）：恢复时据此提示"备份来自另一把密钥"。
         * 密文不可解 = 历史加密档读不出来，人眼要对得上号才知道该拷哪把 git.key。
         * 指纹只是主密钥 SHA-256 的前 12 hex，本身不泄露密钥。
         */
        settingsKeyHint: keyHint(),
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
      console.warn('[Suiji Ledger] 自动备份失败:', e?.message || e)
    }
    // 备份成功与否都不影响写操作本身；旁听者自己兜异常
    if (opts.notify === false) return
    for (const cb of this.listeners) {
      try {
        cb(reason)
      } catch (e: any) {
        console.warn('[Suiji Ledger] 备份旁听者异常:', e?.message || e)
      }
    }
  }
}

import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma.service'
import { RecordMetaService } from './record-meta.service'
import { canonicalRecord, SYNC_SETTING_KEYS, type LedgerRecord } from './ledger'
import {
  accountToRecord,
  entryToRecord,
  loanToRecord,
  metaOf,
  recordToAccountData,
  recordToEntryData,
  recordToLoanData,
  recordToSnapshotData,
  recordToTypeData,
  snapshotToRecord,
  typeToRecord,
} from './mappers'

/**
 * 吸收一条记录的返回。
 *
 * - `reason` 带前缀族，上层据此区分"正常跳过"与"失败"：
 *
 *   `skipped:` —— 正常跳过，**不是**数据丢失，不必报警
 *     · `skipped:auto`               派生条目（`auto:true`）不参与同步，各端自行重算（§5.5）
 *     · `skipped:identical`          载荷与库内完全一致，无需写库
 *     · `skipped:stale`              远端 rev 比库内旧，已有更新的写入（正常跳过，不是失败）
 *     · `skipped:not-whitelisted`    设置键不在 `SYNC_SETTING_KEYS` 白名单
 *     · `skipped:setting-tombstone`  设置墓碑（Setting 表没有 deleted 列，见 applySetting 注释）
 *
 *   `failed:` —— 异常失败，上层**必须让用户看见**（进 `lastError` / 冲突提示），不许静默
 *     · `failed:type-missing`        条目类型本机既无该 uid、也无内置类型可挂
 *     · `failed:account-missing`     snapshot 的账户本机不存在（硬失败，跳过本条）
 *     · `failed:bad-ym`              缺 ym，月份无法定位（当月恒等式也无从重算）
 *     · `failed:unknown-kind`        未识别的记录类型
 *
 * - `warning` 与 `applied` **正交**：`applied:true` 也可以带 warning（"写进去了，但没完全按远端原样"，
 *   典型是类型回退）。它是给用户看的一句话，不是失败信号；失败一律走 `reason: 'failed:*'`。
 * - `applied:false` 必有 reason；`skipped:*` 与 `failed:*` 谁都不许只 log 不报（R14：不静默降级）。
 */
export type ApplyOutcome = { applied: boolean; ym?: string; reason?: string; warning?: string }

/**
 * 吸收远端记录的唯一写通道（§5.5）。
 *
 * 为什么必须唯一：rev 吸收、关系按 uid 解析、墓碑语义、当月恒等式重算这四件事
 * 任何一处漏做都会造成"同步后数据看起来对、平账却对不上"。所有入口（merge / 恢复 / 裁决）
 * 一律走这里。
 */
@Injectable()
export class ApplyRecordService {
  private log = new Logger('SyncApply')

  constructor(private prisma: PrismaService, private meta: RecordMetaService) {}

  async apply(rec: LedgerRecord): Promise<ApplyOutcome> {
    let out: ApplyOutcome
    switch (rec.kind) {
      case 'type':
        out = await this.applyType(rec)
        break
      case 'account':
        out = await this.applyAccount(rec)
        break
      case 'snapshot':
        out = await this.applySnapshot(rec)
        break
      case 'entry':
        out = await this.applyEntry(rec)
        break
      case 'loan':
        out = await this.applyLoan(rec)
        break
      case 'setting':
        out = await this.applySetting(rec)
        break
      default:
        out = { applied: false, reason: 'failed:unknown-kind' }
    }
    if (out.applied) await this.meta.noteSeen(rec.rev)
    return out
  }

  /** 顺序：类型 → 账户 → 快照/条目/借还 → 设置（前者是后者的 uid 依赖） */
  static readonly APPLY_ORDER: LedgerRecord['kind'][] = ['type', 'account', 'snapshot', 'entry', 'loan', 'setting']

  // ---------------- 各类型 ----------------

  private async applyType(rec: LedgerRecord): Promise<ApplyOutcome> {
    const local = await this.prisma.recordType.findUnique({ where: { uid: rec.uid } })
    const data = recordToTypeData(rec)
    if (!local) {
      await this.prisma.recordType.create({ data: { uid: rec.uid, ...data, ...metaOf(rec, rec.rev) } })
      return { applied: true }
    }
    if (rec.rev < local.rev) return { applied: false, reason: 'skipped:stale' }
    if (this.samePayload(typeToRecord(local), rec)) return { applied: false, reason: 'skipped:identical' }
    const rev = rec.rev === local.rev ? rec.rev + 1 : rec.rev
    await this.prisma.recordType.update({ where: { id: local.id }, data: { ...data, ...metaOf(rec, rev) } })
    return { applied: true }
  }

  private async applyAccount(rec: LedgerRecord): Promise<ApplyOutcome> {
    const local = await this.prisma.account.findUnique({ where: { uid: rec.uid } })
    const data = recordToAccountData(rec)
    if (!local) {
      await this.prisma.account.create({ data: { uid: rec.uid, ...data, ...metaOf(rec, rec.rev) } })
      return { applied: true }
    }
    if (rec.rev < local.rev) return { applied: false, reason: 'skipped:stale' }
    if (this.samePayload(accountToRecord(local), rec)) return { applied: false, reason: 'skipped:identical' }
    const rev = rec.rev === local.rev ? rec.rev + 1 : rec.rev
    await this.prisma.account.update({ where: { id: local.id }, data: { ...data, ...metaOf(rec, rev) } })
    return { applied: true }
  }

  private async applySnapshot(rec: LedgerRecord): Promise<ApplyOutcome> {
    const accountUid = String(rec.accountUid || '')
    const ym = String(rec.ym || '')
    const acc = accountUid ? await this.prisma.account.findUnique({ where: { uid: accountUid } }) : null
    if (!acc) {
      // 硬失败：快照必挂在某个账户上，账户本机没有 = 这条记录无处安放（跳过但不能无声，
      // 上层要能把它进 lastError：用户看得见"某个账户没同步过来"，而不是余额莫名缺月）。
      const msg = `snapshot ${rec.uid} (${ym || '(空)'}) 的账户 ${accountUid || '(空)'} 本机不存在，已跳过`
      this.log.warn(msg)
      return { applied: false, reason: 'failed:account-missing', warning: msg }
    }
    if (!ym) return { applied: false, reason: 'failed:bad-ym' }

    const local =
      (await this.prisma.monthlySnapshot.findUnique({ where: { uid: rec.uid } })) ||
      (await this.prisma.monthlySnapshot.findUnique({ where: { ym_accountId: { ym, accountId: acc.id } } }))
    const data = recordToSnapshotData(rec)
    if (!local) {
      await this.prisma.monthlySnapshot.create({
        data: { uid: rec.uid, accountId: acc.id, ...data, ...metaOf(rec, rec.rev) },
      })
      return { applied: true, ym }
    }
    if (rec.rev < local.rev) return { applied: false, reason: 'skipped:stale' }
    if (this.samePayload(snapshotToRecord(local, accountUid), rec)) return { applied: false, reason: 'skipped:identical' }
    const rev = rec.rev === local.rev ? rec.rev + 1 : rec.rev
    await this.prisma.monthlySnapshot.update({
      where: { id: local.id },
      // uid 也回填：老库升级后可能靠 ym+account 命中的是没 uid 的行
      data: { uid: rec.uid, accountId: acc.id, ...data, ...metaOf(rec, rev) },
    })
    return { applied: true, ym }
  }

  private async applyEntry(rec: LedgerRecord): Promise<ApplyOutcome> {
    if (rec.auto) return { applied: false, reason: 'skipped:auto' } // 派生值，各端自行重算（不算丢数据）
    const ym = String(rec.ym || '')
    if (!ym) return { applied: false, reason: 'failed:bad-ym' }

    const typeUid = String(rec.typeUid || '')
    let type = typeUid ? await this.prisma.recordType.findUnique({ where: { uid: typeUid } }) : null
    // 类型回退保留（否则条目无处安放 = 直接丢钱），但必须**报给调用方**：
    // 只 log.warn 等于"写了一半、没人知道"，R14 不允许静默降级。
    let warning: string | undefined
    if (!type) {
      type = await this.prisma.recordType.findFirst({ where: { builtin: true, deleted: false } })
      if (!type) return { applied: false, reason: 'failed:type-missing', warning: `条目 ${rec.uid} 的类型 ${typeUid || '(空)'} 本机不存在，且本机没有可用的内置类型，已跳过` }
      warning = `条目 ${rec.uid} 的类型 ${typeUid || '(空)'} 本机不存在，已回退为内置类型 ${type.name}`
      this.log.warn(warning)
    }
    const accountUid = rec.accountUid ? String(rec.accountUid) : ''
    const acc = accountUid ? await this.prisma.account.findUnique({ where: { uid: accountUid } }) : null

    const local = await this.prisma.changeEntry.findUnique({ where: { uid: rec.uid } })
    const data = recordToEntryData(rec)
    const link = { typeId: type.id, accountId: acc?.id ?? null }
    if (!local) {
      await this.prisma.changeEntry.create({ data: { uid: rec.uid, ...data, ...link, ...metaOf(rec, rec.rev) } })
      return { applied: true, ym, ...(warning ? { warning } : {}) }
    }
    if (rec.rev < local.rev) return { applied: false, reason: 'skipped:stale', ...(warning ? { warning } : {}) }
    if (this.samePayload(entryToRecord(local, typeUid, accountUid || null), rec)) {
      return { applied: false, reason: 'skipped:identical', ...(warning ? { warning } : {}) }
    }
    const rev = rec.rev === local.rev ? rec.rev + 1 : rec.rev
    await this.prisma.changeEntry.update({ where: { id: local.id }, data: { ...data, ...link, ...metaOf(rec, rev) } })
    return { applied: true, ym, ...(warning ? { warning } : {}) }
  }

  private async applyLoan(rec: LedgerRecord): Promise<ApplyOutcome> {
    const accountUid = rec.accountUid ? String(rec.accountUid) : ''
    const acc = accountUid ? await this.prisma.account.findUnique({ where: { uid: accountUid } }) : null
    const local = await this.prisma.loan.findUnique({ where: { uid: rec.uid } })
    const data = recordToLoanData(rec)
    const link = { accountId: acc?.id ?? null }
    if (!local) {
      await this.prisma.loan.create({ data: { uid: rec.uid, ...data, ...link, ...metaOf(rec, rec.rev) } })
      return { applied: true }
    }
    if (rec.rev < local.rev) return { applied: false, reason: 'skipped:stale' }
    if (this.samePayload(loanToRecord(local, accountUid || null), rec)) return { applied: false, reason: 'skipped:identical' }
    const rev = rec.rev === local.rev ? rec.rev + 1 : rec.rev
    await this.prisma.loan.update({ where: { id: local.id }, data: { ...data, ...link, ...metaOf(rec, rev) } })
    return { applied: true }
  }

  private async applySetting(rec: LedgerRecord): Promise<ApplyOutcome> {
    const key = String(rec.key || rec.uid || '')
    if (!SYNC_SETTING_KEYS.includes(key)) return { applied: false, reason: 'skipped:not-whitelisted' }
    if (rec.deleted) return { applied: false, reason: 'skipped:setting-tombstone' }
    const value = String(rec.value ?? '')
    // 判重只能按 value：`Setting` 表**没有 rev / deleted 列**（见 mappers.ts 的 settingToRecord 恒 rev:1），
    // 远端记录的 rev 与库内不可比，所以别假装有 rev —— 值相同就是"这次同步无变更"。
    // 原来的无脑 upsert 会让每次同步都把整张设置表写一遍（哪怕一个字都没改）。
    const local = await this.prisma.setting.findUnique({ where: { key } })
    if (!local) {
      await this.prisma.setting.create({ data: { key, value } })
      return { applied: true }
    }
    if (local.value === value) return { applied: false, reason: 'skipped:identical' }
    await this.prisma.setting.update({ where: { key }, data: { value } })
    return { applied: true }
  }

  /**
   * 只比载荷，不比 rev/updatedAt/origin —— 否则"内容没变但 rev 变了"会被当成变更写库，
   * 每次同步都白写一遍全表。
   */
  private samePayload(localRec: LedgerRecord, incoming: LedgerRecord): boolean {
    const a = canonicalRecord({ ...localRec, rev: incoming.rev, updatedAt: incoming.updatedAt, origin: incoming.origin })
    const b = canonicalRecord(incoming)
    return a === b
  }
}

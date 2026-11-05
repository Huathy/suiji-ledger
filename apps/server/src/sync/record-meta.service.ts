import { Injectable } from '@nestjs/common'
import crypto from 'node:crypto'
import { PrismaService } from '../prisma.service'

/**
 * 同步元数据的唯一生成口：uid / rev / updatedAt / origin。
 *
 * rev 推进规则（§3.3）：
 *   写一条记录时 rev = max(本地该记录 rev, 上次吸收到的远端最大 rev) + 1
 * 这样"本端新写的"永远大于"上次看到的远端"，跨设备比较不会因时钟漂移错判。
 */
@Injectable()
export class RecordMetaService {
  private deviceIdCache: string | null = null
  private maxRevCache: number | null = null

  constructor(private prisma: PrismaService) {}

  now(): number {
    return Math.floor(Date.now() / 1000)
  }

  /** 本机设备号（d_xxxxxxxx），首次使用时生成并落库 */
  async deviceId(): Promise<string> {
    if (this.deviceIdCache) return this.deviceIdCache
    const row = await this.prisma.setting.findUnique({ where: { key: 'gitDeviceId' } })
    if (row?.value) {
      this.deviceIdCache = row.value
      return row.value
    }
    const id = 'd_' + crypto.randomBytes(4).toString('hex')
    await this.prisma.setting.upsert({ where: { key: 'gitDeviceId' }, update: { value: id }, create: { key: 'gitDeviceId', value: id } })
    this.deviceIdCache = id
    return id
  }

  /** 上次吸收到的远端最大 rev */
  async maxSeen(): Promise<number> {
    if (this.maxRevCache !== null) return this.maxRevCache
    const row = await this.prisma.setting.findUnique({ where: { key: 'gitMaxRev' } })
    this.maxRevCache = Number(row?.value || 0) || 0
    return this.maxRevCache
  }

  /** 吸收远端后顶高水位，保证本端后续写入一定比它大 */
  async noteSeen(rev: number): Promise<void> {
    if (!Number.isFinite(rev) || rev <= 0) return
    const cur = await this.maxSeen()
    if (rev <= cur) return
    this.maxRevCache = rev
    await this.prisma.setting.upsert({ where: { key: 'gitMaxRev' }, update: { value: String(rev) }, create: { key: 'gitMaxRev', value: String(rev) } })
  }

  /** 新建记录的同步元数据 */
  async stamp(): Promise<{ uid: string; rev: number; updatedAt: number; deleted: boolean; origin: string }> {
    const [origin, maxSeen] = await Promise.all([this.deviceId(), this.maxSeen()])
    return { uid: crypto.randomUUID(), rev: maxSeen + 1, updatedAt: this.now(), deleted: false, origin }
  }

  /**
   * 确定性 uid（防复发：同一备份在两端恢复必须产出同一 uid，否则同步认作不同记录翻倍）。
   *
   * 根因（bug20261104）：无 uid 的旧备份在两端 restore 时各生成随机 uid，
   * 同名账户在两端 uid 不同 → 同步按 uid 对齐误判为"两端各新增一批" → 账户/快照翻倍、净资产翻倍。
   * 快照已有 `${ym}__${accountUid}` 派生规则；账户/类型/条目/借还此前全随机。
   *
   * 规则（v5 备份自带 uid 时直接采用，不走这里；只用于无 uid 的旧备份）：
   *  - account: `acc::<kind>::<name>`
   *  - type:    `type::<direction>::<name>`
   *  - entry:   `entry::<ym>::<typeKey>::<amount>::<note>::<accountKey>`
   *             （typeKey/accountKey 取备份里的源 id：同份备份在两端映射结果一致）
   *  - loan:    `loan::<direction>::<counterparty>::<amount>::<date>`
   * 命名空间用 uuid v5（URL 命名空间），同输入在两端必同输出；不同输入碰撞概率可忽略。
   * 注意：这只是"旧备份首次恢复"的收敛手段；恢复后各端正常写入仍用随机 uid + rev 推进。
   */
  deterministicUid(kind: 'account' | 'type' | 'entry' | 'loan', key: string): string {
    const NS = '6ba7b811-9dad-11d1-80b4-00c04fd430c8'
    const hex = crypto.createHash('sha1').update(`${NS}:${kind}:${key}`, 'utf8').digest('hex')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  }

  /** 修改记录：rev 前进一格，保证对端能看出"这条变过" */
  async bump(local: { rev?: number | null }): Promise<{ rev: number; updatedAt: number; origin: string }> {
    const [origin, maxSeen] = await Promise.all([this.deviceId(), this.maxSeen()])
    return { rev: Math.max(Number(local?.rev || 0), maxSeen) + 1, updatedAt: this.now(), origin }
  }

  /** 墓碑：删除也是"改内容"，rev 同样要前进（否则对端会认为删除比修改旧） */
  async tombstone(local: { rev?: number | null }): Promise<{ rev: number; updatedAt: number; origin: string; deleted: true }> {
    return { ...(await this.bump(local)), deleted: true }
  }

  /**
   * 自愈：给历史遗留（uid 为空 / updatedAt=0）的行补元数据。
   * 幂等，投影前跑一次，避免旧库升级后出现"没有 uid 的行无法同步"。
   */
  async ensureUids(): Promise<number> {
    const ts = this.now()
    const origin = await this.deviceId()
    let fixed = 0
    const need = { OR: [{ uid: null }, { updatedAt: 0 }] }

    for (const t of await this.prisma.recordType.findMany({ where: need as any })) {
      await this.prisma.recordType.update({
        where: { id: t.id },
        data: { uid: t.uid || crypto.randomUUID(), rev: t.rev || 1, updatedAt: t.updatedAt || ts, origin: t.origin || origin },
      })
      fixed++
    }
    for (const a of await this.prisma.account.findMany({ where: need as any })) {
      await this.prisma.account.update({
        where: { id: a.id },
        data: { uid: a.uid || crypto.randomUUID(), rev: a.rev || 1, updatedAt: a.updatedAt || ts, origin: a.origin || origin },
      })
      fixed++
    }
    const accounts = await this.prisma.account.findMany()
    const accUid = new Map(accounts.map((a) => [a.id, a.uid!]))
    for (const s of await this.prisma.monthlySnapshot.findMany({ where: need as any })) {
      const au = accUid.get(s.accountId)
      if (!au) continue
      await this.prisma.monthlySnapshot.update({
        where: { id: s.id },
        data: { uid: `${s.ym}__${au}`, rev: s.rev || 1, updatedAt: s.updatedAt || ts, origin: s.origin || origin },
      })
      fixed++
    }
    for (const e of await this.prisma.changeEntry.findMany({ where: need as any })) {
      await this.prisma.changeEntry.update({
        where: { id: e.id },
        data: { uid: e.uid || crypto.randomUUID(), rev: e.rev || 1, updatedAt: e.updatedAt || ts, origin: e.origin || origin },
      })
      fixed++
    }
    for (const l of await this.prisma.loan.findMany({ where: need as any })) {
      await this.prisma.loan.update({
        where: { id: l.id },
        data: { uid: l.uid || crypto.randomUUID(), rev: l.rev || 1, updatedAt: l.updatedAt || ts, origin: l.origin || origin },
      })
      fixed++
    }
    return fixed
  }
}

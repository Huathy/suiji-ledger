import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma.service'
import { MonthsService } from '../months/months.service'
import { RecordMetaService } from '../sync/record-meta.service'
import type { TimeSortDir } from '../../../../packages/shared/src/index'

/**
 * 回收站：删除的大项条目 / 借还 / 账户先入站（payload 为原 JSON），支持恢复与永久删除。
 * 恢复后自动重算当月恒等式（账户恢复无需重算——账户删除本就要求无快照）。
 *
 * M4 之后删除是**墓碑**（`deleted:true`，行还在），所以恢复 = 复活那一行 + rev 顶到新值（R8）；
 * 沿用旧 rev 会让对端的墓碑继续胜出，出现"恢复了又被同步删掉"。
 */
@Injectable()
export class RecycleService {
  private log = new Logger('Recycle')
  constructor(private prisma: PrismaService, private months: MonthsService, private meta: RecordMetaService) {}

  /** dir='desc'（默认）= 按删除时间倒序（刚删的在前）；'asc' = 按删除时间顺序（最早删的在前） */
  async list(dir: TimeSortDir = 'desc') {
    const items = await this.prisma.deletedItem.findMany({ orderBy: [{ deletedAt: dir }, { id: dir }] })
    return {
      items: items.map((i) => ({
        id: i.id,
        kind: i.kind,
        summary: i.summary,
        deletedAt: i.deletedAt,
        payload: JSON.parse(i.payload),
      })),
    }
  }

  async restore(id: number) {
    const item = await this.prisma.deletedItem.findUnique({ where: { id } })
    if (!item) throw new NotFoundException('回收站条目不存在')
    const payload = JSON.parse(item.payload)
    if (item.kind === 'entry') {
      const local = payload.uid ? await this.prisma.changeEntry.findUnique({ where: { uid: payload.uid } }) : null
      if (local) {
        await this.prisma.changeEntry.update({
          where: { id: local.id },
          data: {
            ym: payload.ym, typeId: payload.typeId, amount: payload.amount,
            note: payload.note ?? null, accountId: payload.accountId ?? null, auto: !!payload.auto,
            deleted: false,
            ...(await this.meta.bump(local)),
          },
        })
      } else {
        // stamp() 本身就返回 uid/rev/updatedAt/deleted/origin 五件套，直接展开（评审修复项：手抄 18 处）
        const stamp = await this.meta.stamp()
        await this.prisma.changeEntry.create({
          data: {
            ...stamp,
            ym: payload.ym, typeId: payload.typeId, amount: payload.amount,
            note: payload.note ?? null, accountId: payload.accountId ?? null, auto: !!payload.auto,
          },
        })
      }
      await this.months.recomputeAuto(payload.ym)
    } else if (item.kind === 'loan') {
      const local = payload.uid ? await this.prisma.loan.findUnique({ where: { uid: payload.uid } }) : null
      const data = {
        direction: payload.direction, counterparty: payload.counterparty, amount: payload.amount,
        settledAmount: payload.settledAmount ?? 0, date: payload.date, dueDate: payload.dueDate ?? null,
        accountId: payload.accountId ?? null, note: payload.note ?? null,
        createdAt: payload.createdAt ?? Math.floor(Date.now() / 1000),
      }
      if (local) {
        await this.prisma.loan.update({ where: { id: local.id }, data: { ...data, deleted: false, ...(await this.meta.bump(local)) } })
      } else {
        const stamp = await this.meta.stamp()
        await this.prisma.loan.create({
          data: { ...stamp, ...data },
        })
      }
    } else if (item.kind === 'account') {
      const local = payload.uid
        ? await this.prisma.account.findUnique({ where: { uid: payload.uid } })
        : await this.prisma.account.findFirst({ where: { name: payload.name, deleted: false } })
      if (local) {
        await this.prisma.account.update({ where: { id: local.id }, data: { deleted: false, ...(await this.meta.bump(local)) } })
      } else {
        const stamp = await this.meta.stamp()
        await this.prisma.account.create({
          data: {
            ...stamp,
            name: payload.name, emoji: payload.emoji, kind: payload.kind, group: payload.group ?? null,
            initBalance: payload.initBalance ?? 0, inNetWorth: payload.inNetWorth ?? true,
            sort: payload.sort ?? 0, archived: !!payload.archived, note: payload.note ?? null,
            createdAt: payload.createdAt ?? Math.floor(Date.now() / 1000),
          },
        })
      }
    } else if (item.kind === 'snapshot') {
      // 同步裁决覆盖（pick=remote / 字段覆盖）会写 snapshot 类回收项（doc23 §8「5 类可复活」）。
      // 此前只处理 entry/loan/account：snapshot/type 进来不恢复却照样走到末尾 delete →
      // 用户点「恢复」= 静默丢数据（评审修复项）。
      const local = payload.uid ? await this.prisma.monthlySnapshot.findUnique({ where: { uid: payload.uid } }) : null
      if (local) {
        await this.prisma.monthlySnapshot.update({
          where: { id: local.id },
          data: {
            balance: payload.balance, recordDate: payload.recordDate, note: payload.note ?? null,
            deleted: false,
            ...(await this.meta.bump(local)),
          },
        })
      } else {
        const acc = typeof payload.accountId === 'number' ? await this.prisma.account.findUnique({ where: { id: payload.accountId } }) : null
        if (!acc) throw new BadRequestException('该快照的账户已不存在，无法恢复；可先恢复对应账户')
        // (ym, accountId) 唯一：新行还占着位就以回收内容覆盖复活，没有才 create
        const existing = await this.prisma.monthlySnapshot.findUnique({ where: { ym_accountId: { ym: payload.ym, accountId: acc.id } } })
        if (existing) {
          await this.prisma.monthlySnapshot.update({
            where: { id: existing.id },
            data: {
              balance: payload.balance, recordDate: payload.recordDate, note: payload.note ?? null,
              deleted: false,
              ...(await this.meta.bump(existing)),
            },
          })
        } else {
          const stamp = await this.meta.stamp()
          await this.prisma.monthlySnapshot.create({
            data: {
              ...stamp,
              uid: payload.uid || stamp.uid,
              ym: payload.ym, accountId: acc.id, balance: payload.balance,
              recordDate: payload.recordDate, note: payload.note ?? null,
            },
          })
        }
      }
      await this.months.recomputeAuto(String(payload.ym))
    } else if (item.kind === 'type') {
      const local = payload.uid ? await this.prisma.recordType.findUnique({ where: { uid: payload.uid } }) : null
      const data = {
        name: payload.name, emoji: payload.emoji, color: payload.color ?? null,
        direction: payload.direction, builtin: !!payload.builtin, sort: payload.sort ?? 0,
      }
      if (local) {
        await this.prisma.recordType.update({ where: { id: local.id }, data: { ...data, deleted: false, ...(await this.meta.bump(local)) } })
      } else {
        const stamp = await this.meta.stamp()
        await this.prisma.recordType.create({ data: { ...stamp, ...data } })
      }
    } else {
      // 未知 kind：以前会一路走到末尾 delete——回收项被删、数据却没回来（静默丢数据）。
      // 明确拒绝，条目留在回收站由人处置。
      this.log.warn(`回收站恢复遇到不支持的类型 kind=${item.kind} id=${id}`)
      throw new BadRequestException(`回收站不支持恢复该类型：${item.kind}`)
    }
    await this.prisma.deletedItem.delete({ where: { id } })
    return { ok: true }
  }

  async removeForever(id: number) {
    await this.prisma.deletedItem.delete({ where: { id } }).catch(() => {
      throw new NotFoundException('回收站条目不存在')
    })
    return { ok: true }
  }

  async clear() {
    await this.prisma.deletedItem.deleteMany()
    return { ok: true }
  }
}

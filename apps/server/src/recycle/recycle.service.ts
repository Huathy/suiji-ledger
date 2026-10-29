import { Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma.service'
import { MonthsService } from '../months/months.service'

/**
 * 回收站：删除的大项条目 / 借还 / 账户先入站（payload 为原 JSON），支持恢复与永久删除。
 * 恢复后自动重算当月恒等式（账户恢复无需重算——账户删除本就要求无快照）。
 */
@Injectable()
export class RecycleService {
  constructor(private prisma: PrismaService, private months: MonthsService) {}

  async list() {
    const items = await this.prisma.deletedItem.findMany({ orderBy: { deletedAt: 'desc' } })
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
      await this.prisma.changeEntry.create({
        data: {
          ym: payload.ym, typeId: payload.typeId, amount: payload.amount,
          note: payload.note ?? null, accountId: payload.accountId ?? null, auto: !!payload.auto,
        },
      })
      await this.months.recomputeAuto(payload.ym)
    } else if (item.kind === 'loan') {
      await this.prisma.loan.create({
        data: {
          direction: payload.direction, counterparty: payload.counterparty, amount: payload.amount,
          settledAmount: payload.settledAmount ?? 0, date: payload.date, dueDate: payload.dueDate ?? null,
          accountId: payload.accountId ?? null, note: payload.note ?? null,
          createdAt: payload.createdAt ?? Math.floor(Date.now() / 1000),
        },
      })
    } else if (item.kind === 'account') {
      const exists = await this.prisma.account.findFirst({ where: { name: payload.name } })
      if (!exists) {
        await this.prisma.account.create({
          data: {
            name: payload.name, emoji: payload.emoji, kind: payload.kind, group: payload.group ?? null,
            initBalance: payload.initBalance ?? 0, inNetWorth: payload.inNetWorth ?? true,
            sort: payload.sort ?? 0, archived: !!payload.archived, note: payload.note ?? null,
            createdAt: payload.createdAt ?? Math.floor(Date.now() / 1000),
          },
        })
      }
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

import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma.service'
import { MonthsService } from '../months/months.service'
import { BackupService } from '../backup.service'
import { todayYMD } from '../../../../packages/shared/src/index'

@Injectable()
export class AccountsService {
  constructor(private prisma: PrismaService, private months: MonthsService, private backup: BackupService) {}

  /**
   * 单账户快速调整余额（随时，不必等月末平账）：
   * 更新/创建当月快照，并单独生成一条平账记录（类型=平账，note 默认「余额调整」），
   * 当月恒等式由 recomputeAuto 自动重算。批量月末平账生成的自动条目则带「（批量记录）」备注，两种来源可区分。
   */
  async setBalance(id: number, dto: any) {
    const acc = await this.prisma.account.findUnique({ where: { id } })
    if (!acc) throw new NotFoundException('账户不存在')
    const balance = Number(dto?.balance)
    if (!Number.isInteger(balance) || balance < 0) throw new BadRequestException('余额须为非负整数（分）')
    const note = dto?.note ? String(dto.note).slice(0, 200) : '余额调整'

    const ym = todayYMD().slice(0, 7)
    const recordDate = todayYMD()
    const existing = await this.prisma.monthlySnapshot.findUnique({
      where: { ym_accountId: { ym, accountId: id } },
    })
    let prev = acc.initBalance
    if (!existing) {
      const earlier = await this.prisma.monthlySnapshot.findFirst({
        where: { accountId: id, ym: { lt: ym } },
        orderBy: [{ ym: 'desc' }, { id: 'desc' }],
      })
      if (earlier) prev = earlier.balance
    }
    const oldCurrent = existing ? existing.balance : prev
    const delta = balance - oldCurrent

    if (existing) {
      await this.prisma.monthlySnapshot.update({
        where: { id: existing.id },
        data: { balance, recordDate },
      })
    } else {
      await this.prisma.monthlySnapshot.create({
        data: { ym, accountId: id, balance, recordDate, note: '快速调整' },
      })
    }
    if (delta !== 0) {
      const builtin = await this.prisma.recordType.findFirst({ where: { builtin: true } })
      await this.prisma.changeEntry.create({
        data: { ym, typeId: builtin!.id, amount: delta, note, accountId: id, auto: false },
      })
    }
    await this.months.recomputeAuto(ym)
    await this.backup.snapshot('调整余额 ' + acc.name)
    return { ok: true, delta, balance }
  }

  /** 列表：附当前余额（最近快照，否则初始余额）与最近两次余额 */
  async list() {
    const accounts = await this.prisma.account.findMany({ orderBy: [{ archived: 'asc' }, { sort: 'asc' }, { id: 'asc' }] })
    const snaps = await this.prisma.monthlySnapshot.findMany({ orderBy: [{ ym: 'asc' }, { id: 'asc' }] })
    const lastBy = new Map<number, { ym: string; balance: number; prev: number }>()
    for (const s of snaps) {
      const cur = lastBy.get(s.accountId)
      lastBy.set(s.accountId, { ym: s.ym, balance: s.balance, prev: cur ? cur.balance : 0 })
    }
    return accounts.map((a) => {
      const last = lastBy.get(a.id)
      return {
        ...a,
        currentYm: last?.ym ?? null,
        balance: last ? last.balance : a.initBalance,
        prevBalance: last ? (last.prev || a.initBalance) : a.initBalance,
      }
    })
  }

  async create(dto: any) {
    const name = String(dto.name || '').trim()
    if (!name) throw new BadRequestException('请填写账户名称')
    if (!['asset', 'liability'].includes(dto.kind)) throw new BadRequestException('账户类型不合法')
    const balance = Number(dto.initBalance)
    if (!Number.isInteger(balance) || balance < 0) throw new BadRequestException('初始余额不合法（分）')
    const max = await this.prisma.account.aggregate({ _max: { sort: true } })
    return this.prisma.account.create({
      data: {
        name,
        emoji: String(dto.emoji || '🏦').slice(0, 8),
        kind: dto.kind,
        group: dto.group ? String(dto.group).slice(0, 30) : null,
        initBalance: balance,
        inNetWorth: dto.inNetWorth !== false,
        note: dto.note ? String(dto.note).slice(0, 200) : null,
        sort: (max._max.sort ?? 0) + 1,
        createdAt: Math.floor(Date.now() / 1000),
      },
    })
  }

  async update(id: number, dto: any) {
    const account = await this.prisma.account.findUnique({ where: { id } })
    if (!account) throw new NotFoundException('账户不存在')
    const data: any = {}
    if (dto.name !== undefined) data.name = String(dto.name).trim().slice(0, 30)
    if (dto.emoji !== undefined) data.emoji = String(dto.emoji).slice(0, 8)
    if (dto.group !== undefined) data.group = dto.group ? String(dto.group).slice(0, 30) : null
    if (dto.inNetWorth !== undefined) data.inNetWorth = !!dto.inNetWorth
    if (dto.note !== undefined) data.note = dto.note ? String(dto.note).slice(0, 200) : null
    if (dto.archived !== undefined) data.archived = !!dto.archived
    if (dto.sort !== undefined) data.sort = Number(dto.sort)
    return this.prisma.account.update({ where: { id }, data })
  }

  async remove(id: number) {
    const acc = await this.prisma.account.findUnique({ where: { id } })
    if (!acc) throw new NotFoundException('账户不存在')
    const snaps = await this.prisma.monthlySnapshot.count({ where: { accountId: id } })
    if (snaps > 0) throw new BadRequestException('该账户已有历史快照，请改用「归档」保留历史')
    await this.prisma.deletedItem.create({
      data: { kind: 'account', summary: `账户 ${acc.name}`, payload: JSON.stringify(acc), deletedAt: Math.floor(Date.now() / 1000) },
    })
    await this.prisma.account.delete({ where: { id } })
    await this.backup.snapshot('删除账户 ' + acc.name)
    return { ok: true }
  }
}

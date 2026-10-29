import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma.service'
import { BackupService } from '../backup.service'

/**
 * 借入借出台账：in = 借入(我欠人) / out = 借出(人欠我)。
 * 台账只记录债权债务与回收进度，不直接改账户余额（余额由平账/调余额体现）。
 */
@Injectable()
export class LoansService {
  constructor(private prisma: PrismaService, private backup: BackupService) {}

  async list() {
    const loans = await this.prisma.loan.findMany({ orderBy: [{ id: 'desc' }] })
    const view = loans.map((l) => ({
      ...l,
      remaining: l.amount - l.settledAmount,
      status: l.settledAmount >= l.amount ? 'settled' : l.settledAmount > 0 ? 'partial' : 'open',
    }))
    const borrowIn = view.filter((l) => l.direction === 'in' && l.status !== 'settled').reduce((s, l) => s + l.remaining, 0)
    const lendOut = view.filter((l) => l.direction === 'out' && l.status !== 'settled').reduce((s, l) => s + l.remaining, 0)
    return { loans: view, summary: { borrowIn, lendOut } }
  }

  async create(dto: any) {
    const direction = dto?.direction === 'in' || dto?.direction === 'out' ? dto.direction : null
    if (!direction) throw new BadRequestException('借还方向不合法')
    const counterparty = String(dto?.counterparty || '').trim()
    if (!counterparty) throw new BadRequestException('请填写对方名称')
    if (!Number.isInteger(dto?.amount) || dto.amount <= 0) throw new BadRequestException('金额不合法（分）')
    return this.prisma.loan.create({
      data: {
        direction,
        counterparty: counterparty.slice(0, 30),
        amount: dto.amount,
        settledAmount: 0,
        date: /^\d{4}-\d{2}-\d{2}$/.test(dto?.date || '') ? dto.date : new Date().toISOString().slice(0, 10),
        dueDate: /^\d{4}-\d{2}-\d{2}$/.test(dto?.dueDate || '') ? dto.dueDate : null,
        accountId: Number.isInteger(dto?.accountId) ? dto.accountId : null,
        note: dto?.note ? String(dto.note).slice(0, 200) : null,
        createdAt: Math.floor(Date.now() / 1000),
      },
    })
  }

  /** 收回/还上：累计进度，>=本金即结清 */
  async settle(id: number, dto: any) {
    const loan = await this.prisma.loan.findUnique({ where: { id } })
    if (!loan) throw new NotFoundException('借还记录不存在')
    if (!Number.isInteger(dto?.amount) || dto.amount <= 0) throw new BadRequestException('金额不合法（分）')
    const settled = Math.min(loan.amount, loan.settledAmount + dto.amount)
    await this.prisma.loan.update({ where: { id }, data: { settledAmount: settled } })
    await this.backup.snapshot('借还进度 ' + loan.counterparty)
    return this.list()
  }

  /** 编辑借还记录：金额 / 约定归还日 / 日期 / 关联账户 / 备注（还款设置） */
  async update(id: number, dto: any) {
    const loan = await this.prisma.loan.findUnique({ where: { id } })
    if (!loan) throw new NotFoundException('借还记录不存在')
    const data: any = {}
    if (dto.counterparty !== undefined) {
      const cp = String(dto.counterparty).trim()
      if (!cp) throw new BadRequestException('对方名称不能为空')
      data.counterparty = cp.slice(0, 30)
    }
    if (dto.amount !== undefined) {
      if (!Number.isInteger(dto.amount) || dto.amount <= 0) throw new BadRequestException('金额不合法（分）')
      data.amount = dto.amount
      if (loan.settledAmount > dto.amount) data.settledAmount = dto.amount // 本金下调时进度封顶
    }
    if (dto.date !== undefined) data.date = /^\d{4}-\d{2}-\d{2}$/.test(dto.date || '') ? dto.date : loan.date
    if (dto.dueDate !== undefined) data.dueDate = /^\d{4}-\d{2}-\d{2}$/.test(dto.dueDate || '') ? dto.dueDate : null
    if (dto.accountId !== undefined) data.accountId = Number.isInteger(dto.accountId) ? dto.accountId : null
    if (dto.note !== undefined) data.note = dto.note ? String(dto.note).slice(0, 200) : null
    const r = await this.prisma.loan.update({ where: { id }, data })
    await this.backup.snapshot('编辑借还 ' + r.counterparty)
    return r
  }

  /**
   * 结束债权/债务：
   *  - mode 'settled'（默认）= 全额结清：settledAmount 拉到本金；
   *  - mode 'closed' = 直接结束（坏账/免除）：保留已收部分进度，备注打【已结束】标记。
   * 若存在同名「债权-<对方>」镜像账户，一并归档（历史保留，不再计入净资产/平账页）。
   */
  async close(id: number, dto: any) {
    const loan = await this.prisma.loan.findUnique({ where: { id } })
    if (!loan) throw new NotFoundException('借还记录不存在')
    const mode = dto?.mode === 'closed' ? 'closed' : 'settled'
    const tag = mode === 'settled' ? '【已结清】' : '【已结束】'
    const note = (loan.note || '').startsWith(tag) ? loan.note : (tag + ' ' + (loan.note || '')).slice(0, 200)
    await this.prisma.loan.update({
      where: { id },
      data: mode === 'settled' ? { settledAmount: loan.amount, note } : { note },
    })
    const mirror = await this.prisma.account.findFirst({ where: { name: '债权-' + loan.counterparty } })
    if (mirror && !mirror.archived) {
      await this.prisma.account.update({ where: { id: mirror.id }, data: { archived: true } })
    }
    await this.backup.snapshot((mode === 'settled' ? '结清' : '结束') + '借还 ' + loan.counterparty)
    return this.list()
  }

  async remove(id: number) {
    const loan = await this.prisma.loan.findUnique({ where: { id } })
    if (!loan) throw new NotFoundException('借还记录不存在')
    await this.prisma.deletedItem.create({
      data: { kind: 'loan', summary: `${loan.direction === 'out' ? '借出' : '借入'} ${loan.counterparty}`, payload: JSON.stringify(loan), deletedAt: Math.floor(Date.now() / 1000) },
    })
    await this.prisma.loan.delete({ where: { id } })
    await this.backup.snapshot('删除借还 ' + loan.counterparty)
    return { ok: true }
  }
}

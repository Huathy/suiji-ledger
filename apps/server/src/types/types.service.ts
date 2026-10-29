import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma.service'

const DIRECTIONS = ['income', 'expense', 'neutral']

@Injectable()
export class TypesService {
  constructor(private prisma: PrismaService) {}

  async list() {
    const types = await this.prisma.recordType.findMany({
      orderBy: [{ builtin: 'desc' }, { sort: 'asc' }, { id: 'asc' }],
    })
    const counts = await this.prisma.changeEntry.groupBy({ by: ['typeId'], _count: true })
    const cmap = new Map(counts.map((c) => [c.typeId, c._count]))
    return types.map((t) => ({ ...t, usageCount: cmap.get(t.id) ?? 0 }))
  }

  async create(dto: any) {
    const name = String(dto.name || '').trim()
    if (!name) throw new BadRequestException('请填写类型名称')
    if (!DIRECTIONS.includes(dto.direction)) throw new BadRequestException('收支方向不合法')
    const max = await this.prisma.recordType.aggregate({ _max: { sort: true } })
    return this.prisma.recordType.create({
      data: {
        name: name.slice(0, 20),
        emoji: String(dto.emoji || '🏷').slice(0, 8),
        color: dto.color ? String(dto.color).slice(0, 20) : null,
        direction: dto.direction,
        sort: (max._max.sort ?? 0) + 1,
      },
    })
  }

  async update(id: number, dto: any) {
    const t = await this.prisma.recordType.findUnique({ where: { id } })
    if (!t) throw new NotFoundException('类型不存在')
    if (t.builtin && dto.name !== undefined && String(dto.name).trim() !== t.name) {
      throw new BadRequestException('内置类型名称不可修改')
    }
    if (t.builtin && dto.direction !== undefined && dto.direction !== t.direction) {
      throw new BadRequestException('内置类型方向不可修改')
    }
    const data: any = {}
    if (dto.name !== undefined) data.name = String(dto.name).trim().slice(0, 20)
    if (dto.emoji !== undefined) data.emoji = String(dto.emoji).slice(0, 8)
    if (dto.color !== undefined) data.color = dto.color ? String(dto.color).slice(0, 20) : null
    if (dto.direction !== undefined) {
      if (!DIRECTIONS.includes(dto.direction)) throw new BadRequestException('收支方向不合法')
      data.direction = dto.direction
    }
    return this.prisma.recordType.update({ where: { id }, data })
  }

  /** 删除自定义类型：历史条目回退为「平账」，数据不丢 */
  async remove(id: number) {
    const t = await this.prisma.recordType.findUnique({ where: { id } })
    if (!t) throw new NotFoundException('类型不存在')
    if (t.builtin) throw new BadRequestException('内置「平账」类型不可删除')
    const builtin = await this.prisma.recordType.findFirst({ where: { builtin: true } })
    await this.prisma.changeEntry.updateMany({ where: { typeId: id }, data: { typeId: builtin!.id } })
    await this.prisma.recordType.delete({ where: { id } })
    return { ok: true }
  }
}

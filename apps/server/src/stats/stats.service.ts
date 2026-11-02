import { Injectable, BadRequestException } from '@nestjs/common'
import { MonthsService } from '../months/months.service'
import { PrismaService } from '../prisma.service'
import { computeIntervalStats, daysBetween, pctChange, yoyYm, YM_RE } from '../../../../packages/shared/src/index'

@Injectable()
export class StatsService {
  constructor(private months: MonthsService, private prisma: PrismaService) {}

  /** 净资产走势（升序序列，含环比 delta） */
  async networth(limit = 36) {
    const points = await this.months.recordPoints()
    const list = points.slice(0, limit).reverse()
    return { points: list }
  }

  /** 各月区间日均开销（本月区间由上次记录点决定） */
  async dailyAvg(limit = 12) {
    const points = await this.months.recordPoints()
    const asc = points.slice().reverse()
    const [accounts, entries, allTypes] = await Promise.all([
      this.prisma.account.findMany(),
      this.prisma.changeEntry.findMany(),
      this.prisma.recordType.findMany(),
    ])
    const snaps = await this.prisma.monthlySnapshot.findMany({ orderBy: [{ ym: 'asc' }, { id: 'asc' }] })
    const tdir = new Map(allTypes.map((t) => [t.id, t.direction]))
    const out: any[] = []
    for (let i = 0; i < asc.length; i++) {
      const p = asc[i]
      const ymEntries = entries.filter((e) => e.ym === p.ym)
      const incomeTotal = ymEntries
        .filter((e) => !e.auto && tdir.get(e.typeId) === 'income')
        .reduce((s, e) => s + Math.max(0, e.amount), 0)
      const ymSnaps = snaps.filter((s) => s.ym === p.ym)
      let days = 0
      if (i > 0) {
        days = daysBetween(asc[i - 1].recordDate, ymSnaps.map((s) => s.recordDate).sort().at(-1) || p.recordDate)
      }
      const delta = p.delta ?? 0
      const stats = i > 0 ? computeIntervalStats(delta, incomeTotal, days) : null
      out.push({
        ym: p.ym,
        recordDate: p.recordDate,
        networth: p.networth,
        delta: p.delta,
        days: stats ? stats.days : null,
        spendEst: stats ? stats.spendEst : null,
        dailyAvg: stats ? stats.dailyAvg : null,
        dailyNet: stats ? stats.dailyNet : null,
        estimated: stats ? stats.estimated : null,
        accountCount: ymSnaps.length,
      })
    }
    return { months: out.slice(-limit) }
  }

  /** 类型累计贡献：最近 N 个月各大项类型合计（自动平账单列） */
  async typeContribution(limit = 12) {
    const points = await this.months.recordPoints()
    const yms = points.slice(0, limit).map((p) => p.ym)
    if (yms.length === 0) return { months: yms, items: [] }
    const [entries, types] = await Promise.all([
      this.prisma.changeEntry.findMany({ where: { ym: { in: yms } } }),
      this.prisma.recordType.findMany(),
    ])
    const tmap = new Map(types.map((t) => [t.id, t]))
    const sums = new Map<number, number>()
    for (const e of entries) {
      if (!yms.includes(e.ym)) continue
      const key = e.auto ? -1 : e.typeId
      sums.set(key, (sums.get(key) || 0) + e.amount)
    }
    const items = [...sums.entries()]
      .map(([typeId, total]) => {
        if (typeId === -1) {
          const bt = types.find((t) => t.builtin)
          return { typeId: -1, name: '平账（自动）', emoji: '⚖️', direction: 'neutral', total }
        }
        const t = tmap.get(typeId)
        return { typeId, name: t?.name ?? '未知', emoji: t?.emoji ?? '🏷', direction: t?.direction ?? 'neutral', total }
      })
      .sort((a, b) => Math.abs(b.total) - Math.abs(a.total))
    return { months: yms, items }
  }

  /**
   * 总览摘要（问题 5 · PC 端）：本月相对上月/去年同月的增长率、日均开销增减。
   * 数据源与 /stats/daily-avg 同口径，避免前端二次拼公式。
   */
  async summary(ym?: string) {
    const points = await this.months.recordPoints() // 近的在前
    const asc = points.slice().reverse()
    const curYm = ym && YM_RE.test(ym) ? ym : asc.at(-1)?.ym
    if (!curYm) return { ym: null }
    const i = asc.findIndex((p) => p.ym === curYm)
    if (i < 0) return { ym: null } // 该月没有记录点：按「无数据」返回，避免越界取值
    const cur = asc[i]
    const prev = i > 0 ? asc[i - 1] : null
    const yoy = asc.find((p) => p.ym === yoyYm(curYm)) || null

    const [entries, types] = await Promise.all([
      this.prisma.changeEntry.findMany(),
      this.prisma.recordType.findMany(),
    ])
    const tdir = new Map(types.map((t) => [t.id, t.direction]))
    const incomeOf = (month: string) =>
      entries
        .filter((e) => e.ym === month && !e.auto && tdir.get(e.typeId) === 'income')
        .reduce((s, e) => s + Math.max(0, e.amount), 0)
    const snaps = await this.prisma.monthlySnapshot.findMany({ orderBy: [{ ym: 'asc' }, { id: 'asc' }] })
    const lastRecordDateOf = (month: string) =>
      snaps.filter((s) => s.ym === month).map((s) => s.recordDate).sort().at(-1) || null

    const dailyAvgOf = (idx: number) => {
      if (idx <= 0) return null
      const p = asc[idx]
      const prevDate = asc[idx - 1].recordDate
      const curDate = lastRecordDateOf(p.ym) || p.recordDate
      const days = daysBetween(prevDate, curDate)
      return computeIntervalStats(p.networth - asc[idx - 1].networth, incomeOf(p.ym), days)
    }
    const curStats = dailyAvgOf(i)
    const prevStats = dailyAvgOf(i - 1)

    return {
      ym: curYm,
      networth: cur.networth,
      delta: cur.delta,
      momPct: pctChange(cur.networth, prev ? prev.networth : null),
      yoyPct: pctChange(cur.networth, yoy ? yoy.networth : null),
      prevYm: prev ? prev.ym : null,
      yoyYm: yoy ? yoy.ym : null,
      days: curStats ? curStats.days : null,
      dailyAvg: curStats ? curStats.dailyAvg : null,
      dailyNet: curStats ? curStats.dailyNet : null,
      estimated: curStats ? curStats.estimated : null,
      prevDailyAvg: prevStats ? prevStats.dailyAvg : null,
      dailyAvgDelta: curStats && prevStats ? curStats.dailyAvg - prevStats.dailyAvg : null,
    }
  }

  /** 区间分析器：任选两个记录点月份 */
  async interval(fromYm: string, toYm: string) {
    if (!YM_RE.test(fromYm) || !YM_RE.test(toYm)) throw new BadRequestException('月份格式应为 YYYY-MM')
    const points = await this.months.recordPoints()
    const asc = points.slice().reverse()
    const from = asc.find((p) => p.ym === fromYm)
    const to = asc.find((p) => p.ym === toYm)
    if (!from || !to) throw new BadRequestException('所选月份没有记录点，请先平账')
    if (to.ym <= from.ym) throw new BadRequestException('结束月份需晚于起始月份')
    const entries = await this.prisma.changeEntry.findMany({ where: { ym: { gte: from.ym, lte: to.ym } } })
    const types = await this.prisma.recordType.findMany()
    const tdir = new Map(types.map((t) => [t.id, t.direction]))
    const incomeTotal = entries
      .filter((e) => !e.auto && tdir.get(e.typeId) === 'income')
      .reduce((s, e) => s + Math.max(0, e.amount), 0)
    const days = daysBetween(from.recordDate, to.recordDate)
    const delta = to.networth - from.networth
    return {
      fromYm: from.ym,
      toYm: to.ym,
      fromDate: from.recordDate,
      toDate: to.recordDate,
      ...computeIntervalStats(delta, incomeTotal, days),
    }
  }
}

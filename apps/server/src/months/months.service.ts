import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma.service'
import { BackupService } from '../backup.service'
import { computeIntervalStats, daysBetween, YM_RE, YMD_RE, IntervalStats } from '../../../../packages/shared/src/index'

type Snap = { id: number; ym: string; accountId: number; balance: number; recordDate: string; note: string | null }

@Injectable()
export class MonthsService {
  constructor(private prisma: PrismaService, private backup: BackupService) {}

  // ---------- 基础查询 ----------

  /** 全部快照按 ym 升序（本地数据量级一次性载入即可） */
  private async allSnaps(): Promise<Snap[]> {
    return this.prisma.monthlySnapshot.findMany({ orderBy: [{ ym: 'asc' }, { id: 'asc' }] })
  }

  private async allAccounts() {
    return this.prisma.account.findMany({ orderBy: [{ sort: 'asc' }, { id: 'asc' }] })
  }

  /** 单账户在 ym 之前最近一次快照余额，否则初始余额 */
  private prevBalanceOf(snaps: Snap[], accounts: any[], accountId: number, ym: string): number {
    const acc = accounts.find((a) => a.id === accountId)
    let prev = acc ? acc.initBalance : 0
    for (const s of snaps) {
      if (s.ym < ym && s.accountId === accountId) prev = s.balance
      if (s.ym >= ym) break
    }
    return prev
  }

  /** 净资产：Σ(资产余额) − Σ(负债余额)，仅计入 inNetWorth 且未归档账户（与账户页合计口径一致） */
  networthOf(snaps: Snap[], accounts: any[], ym: string): number {
    let total = 0
    for (const s of snaps) {
      if (s.ym !== ym) continue
      const a = accounts.find((x) => x.id === s.accountId)
      if (!a || !a.inNetWorth || a.archived) continue
      total += a.kind === 'liability' ? -s.balance : s.balance
    }
    return total
  }

  /** 记录点时间轴：每个有快照的月份 → { ym, recordDate, networth } */
  async recordPoints() {
    const [snaps, accounts] = await Promise.all([this.allSnaps(), this.allAccounts()])
    const byYm = new Map<string, Snap[]>()
    for (const s of snaps) {
      if (!byYm.has(s.ym)) byYm.set(s.ym, [])
      byYm.get(s.ym)!.push(s)
    }
    const points = [...byYm.keys()].sort().map((ym) => {
      const list = byYm.get(ym)!
      const recordDate = list.map((s) => s.recordDate).sort().at(-1)!
      return { ym, recordDate, networth: this.networthOf(snaps, accounts, ym) }
    })
    const withDelta = points.map((p, i) => ({
      ...p,
      delta: i > 0 ? p.networth - points[i - 1].networth : null,
    }))
    return withDelta.reverse() // 近的在前
  }

  /** 月份列表（总览/月选择器/近期入口共用） */
  async months(limit = 60) {
    const points = await this.recordPoints()
    return { months: points.slice(0, limit) }
  }

  // ---------- 月度详情 ----------

  async detail(ym: string) {
    if (!YM_RE.test(ym)) throw new BadRequestException('月份格式应为 YYYY-MM')
    const [snaps, accounts, entries, types] = await Promise.all([
      this.allSnaps(),
      this.allAccounts(),
      this.prisma.changeEntry.findMany({ where: { ym }, orderBy: [{ auto: 'asc' }, { id: 'asc' }] }),
      this.prisma.recordType.findMany(),
    ])
    const ymSnaps = snaps.filter((s) => s.ym === ym)
    const tmap = new Map(types.map((t) => [t.id, t]))

    const accountRows = accounts.map((a) => {
      const snap = ymSnaps.find((s) => s.accountId === a.id)
      const prev = this.prevBalanceOf(snaps, accounts, a.id, ym)
      return {
        id: a.id,
        name: a.name,
        emoji: a.emoji,
        kind: a.kind,
        group: a.group,
        inNetWorth: a.inNetWorth,
        archived: a.archived,
        balance: snap ? snap.balance : null,
        recordDate: snap ? snap.recordDate : null,
        prevBalance: prev,
        delta: snap ? snap.balance - prev : null,
      }
    })

    const networth = this.networthOf(snaps, accounts, ym)
    const assetsTotal = accountRows
      .filter((r) => r.kind === 'asset' && r.inNetWorth && !r.archived && r.balance !== null)
      .reduce((s, r) => s + (r.balance || 0), 0)
    const liabilityTotal = accountRows
      .filter((r) => r.kind === 'liability' && r.inNetWorth && !r.archived && r.balance !== null)
      .reduce((s, r) => s + (r.balance || 0), 0)

    // 区间：上次记录点 = 早于本月的最近记录点
    const points = (await this.recordPoints()).slice().reverse() // 升序
    const idx = points.findIndex((p) => p.ym === ym)
    const prevPoint = idx > 0 ? points[idx - 1] : null
    let interval: (IntervalStats & { fromDate: string; toDate: string }) | null = null
    if (ymSnaps.length > 0 && prevPoint) {
      const delta = networth - prevPoint.networth
      const incomeTotal = entries
        .filter((e) => !e.auto && tmap.get(e.typeId)?.direction === 'income')
        .reduce((s, e) => s + Math.max(0, e.amount), 0)
      const days = daysBetween(prevPoint.recordDate, ymSnaps.map((s) => s.recordDate).sort().at(-1)!)
      interval = { fromDate: prevPoint.recordDate, toDate: ymSnaps.map((s) => s.recordDate).sort().at(-1)!, ...computeIntervalStats(delta, incomeTotal, days) }
    }

    const entryRows = entries.map((e) => {
      const t = tmap.get(e.typeId)
      const acc = accounts.find((a) => a.id === e.accountId)
      return {
        id: e.id,
        ym: e.ym,
        typeId: e.typeId,
        name: t?.name ?? '未知类型',
        emoji: t?.emoji ?? '🏷',
        direction: t?.direction ?? 'neutral',
        amount: e.amount,
        note: e.note,
        accountId: e.accountId,
        accountName: acc?.name ?? null,
        auto: e.auto,
      }
    })

    const bigTotal = entryRows.filter((e) => !e.auto).reduce((s, e) => s + e.amount, 0)
    const incomeTotal = entryRows.filter((e) => !e.auto && e.direction === 'income').reduce((s, e) => s + Math.max(0, e.amount), 0)
    const autoEntry = entryRows.find((e) => e.auto) ?? null

    return {
      ym,
      recordDate: ymSnaps.map((s) => s.recordDate).sort().at(-1) ?? null,
      reconciled: ymSnaps.length > 0,
      accounts: accountRows,
      networth,
      prevNetworth: prevPoint ? prevPoint.networth : null,
      delta: prevPoint ? networth - prevPoint.networth : null,
      assetsTotal,
      liabilityTotal,
      entries: entryRows,
      bigTotal,
      incomeTotal,
      autoEntry,
      interval,
    }
  }

  // ---------- 平账（保存当月快照 + 大项） ----------

  async reconcile(dto: {
    ym?: string
    recordDate?: string
    note?: string
    balances?: { accountId: number; balance: number; note?: string }[]
    bigItems?: { typeId: number; amount: number; note?: string; accountId?: number | null }[]
  }) {
    const ym = String(dto.ym || '')
    if (!YM_RE.test(ym)) throw new BadRequestException('月份格式应为 YYYY-MM')
    const recordDate = YMD_RE.test(dto.recordDate || '') ? dto.recordDate! : new Date().toISOString().slice(0, 10)
    const balances = dto.balances || []
    const bigItems = dto.bigItems || []
    if (balances.length === 0) throw new BadRequestException('请至少填写一个账户余额')

    const accounts = await this.allAccounts()
    const validIds = new Set(accounts.map((a) => a.id))
    for (const b of balances) {
      if (!validIds.has(b.accountId)) throw new BadRequestException('包含未知账户')
      if (!Number.isInteger(b.balance) || b.balance < 0) throw new BadRequestException('余额须为非负整数（分）')
    }
    for (const it of bigItems) {
      if (!Number.isInteger(it.amount)) throw new BadRequestException('大项金额不合法（分）')
      if (!validIds.has(it.typeId) && !(await this.prisma.recordType.findUnique({ where: { id: it.typeId } }))) {
        throw new BadRequestException('包含未知类型')
      }
    }

    // 1. 快照 upsert（未填写的账户保持原快照不动）
    for (const b of balances) {
      const existing = await this.prisma.monthlySnapshot.findUnique({
        where: { ym_accountId: { ym, accountId: b.accountId } },
      })
      if (existing) {
        await this.prisma.monthlySnapshot.update({
          where: { id: existing.id },
          data: { balance: b.balance, recordDate, note: b.note ?? existing.note },
        })
      } else {
        await this.prisma.monthlySnapshot.create({
          data: { ym, accountId: b.accountId, balance: b.balance, recordDate, note: b.note ?? null },
        })
      }
    }

    // 2. 替换大项条目（全量保存语义）
    await this.prisma.changeEntry.deleteMany({ where: { ym, auto: false } })
    for (const it of bigItems) {
      if (it.amount === 0 && !it.note) continue
      await this.prisma.changeEntry.create({
        data: { ym, typeId: it.typeId, amount: it.amount, note: it.note ?? null, accountId: it.accountId ?? null, auto: false },
      })
    }

    // 3. 重算自动平账条目（备注默认「（批量记录）」，可自定义），返回当月详情
    await this.recomputeAuto(ym, dto?.note ? String(dto.note).slice(0, 100) : undefined)
    await this.backup.snapshot('平账 ' + ym)
    return this.detail(ym)
  }

  /** 恒等式兜底：平账条目 = Σ余额变动 − Σ大项条目（幂等，单条；备注保留批量语义） */
  async recomputeAuto(ym: string, autoNote?: string) {
    const [snaps, accounts, entries, builtin] = await Promise.all([
      this.allSnaps(),
      this.allAccounts(),
      this.prisma.changeEntry.findMany({ where: { ym } }),
      this.prisma.recordType.findFirst({ where: { builtin: true } }),
    ])
    if (!builtin) throw new NotFoundException('内置平账类型缺失')
    const ymSnaps = snaps.filter((s) => s.ym === ym)
    const prevAuto = entries.find((e) => e.auto)
    const note = autoNote ?? (prevAuto === null || prevAuto === undefined ? '（批量记录）' : prevAuto.note) ?? '（批量记录）'
    // 删除旧的自动条目
    await this.prisma.changeEntry.deleteMany({ where: { ym, auto: true } })
    if (ymSnaps.length === 0) return
    let delta = 0
    for (const s of ymSnaps) {
      const a = accounts.find((x) => x.id === s.accountId)
      if (!a || !a.inNetWorth || a.archived) continue // 与 networthOf 同口径：归档/不计入账户不参与恒等式
      delta += s.balance - this.prevBalanceOf(snaps, accounts, s.accountId, ym)
    }
    const bigSum = entries.filter((e) => !e.auto).reduce((s, e) => s + e.amount, 0)
    const amount = delta - bigSum
    await this.prisma.changeEntry.create({
      data: { ym, typeId: builtin.id, amount, auto: true, note, accountId: null },
    })
  }

  // ---------- 条目编辑（大项可改，平账只读自动重算） ----------

  async updateEntry(ym: string, id: number, dto: any) {
    const e = await this.prisma.changeEntry.findUnique({ where: { id } })
    if (!e || e.ym !== ym) throw new NotFoundException('条目不存在')
    if (e.auto) throw new BadRequestException('平账条目由系统自动计算，不可直接编辑')
    const data: any = {}
    if (dto.typeId !== undefined) data.typeId = Number(dto.typeId)
    if (dto.amount !== undefined) {
      if (!Number.isInteger(dto.amount)) throw new BadRequestException('金额不合法（分）')
      data.amount = dto.amount
    }
    if (dto.note !== undefined) data.note = dto.note ? String(dto.note).slice(0, 200) : null
    if (dto.accountId !== undefined) data.accountId = dto.accountId ?? null
    await this.prisma.changeEntry.update({ where: { id }, data })
    await this.recomputeAuto(ym)
    await this.backup.snapshot('编辑大项 ' + ym)
    return this.detail(ym)
  }

  async deleteEntry(ym: string, id: number) {
    const e = await this.prisma.changeEntry.findUnique({ where: { id } })
    if (!e || e.ym !== ym) throw new NotFoundException('条目不存在')
    if (e.auto) throw new BadRequestException('平账条目不可删除，会随大项修改自动重算')
    await this.moveToRecycle('entry', `条目 #${id} · ${ym}`, e)
    await this.prisma.changeEntry.delete({ where: { id } })
    await this.recomputeAuto(ym)
    await this.backup.snapshot('删除大项')
    return this.detail(ym)
  }

  /** 月度详情内直接新增大项（无需跳转平账页） */
  async addEntry(ym: string, dto: any) {
    if (!YM_RE.test(ym)) throw new BadRequestException('月份格式应为 YYYY-MM')
    if (!Number.isInteger(dto?.amount)) throw new BadRequestException('金额不合法（分）')
    const t = await this.prisma.recordType.findUnique({ where: { id: Number(dto?.typeId) } })
    if (!t) throw new BadRequestException('类型不存在')
    await this.prisma.changeEntry.create({
      data: {
        ym, typeId: t.id, amount: dto.amount,
        note: dto?.note ? String(dto.note).slice(0, 200) : null,
        accountId: dto?.accountId ?? null, auto: false,
      },
    })
    await this.recomputeAuto(ym)
    await this.backup.snapshot('新增大项')
    return this.detail(ym)
  }

  private async moveToRecycle(kind: string, summary: string, payload: object) {
    await this.prisma.deletedItem.create({
      data: { kind, summary, payload: JSON.stringify(payload), deletedAt: Math.floor(Date.now() / 1000) },
    })
  }

  /** 跨月搜索：备注 / 类型名 / 账户名 关键词 + 金额区间（元） */
  async search(q: string, minYuan: number | null, maxYuan: number | null) {
    const kw = q.trim()
    const [entries, types, accounts] = await Promise.all([
      this.prisma.changeEntry.findMany({ orderBy: [{ ym: 'desc' }, { id: 'desc' }] }),
      this.prisma.recordType.findMany(),
      this.prisma.account.findMany(),
    ])
    const tmap = new Map(types.map((t) => [t.id, t]))
    const amap = new Map(accounts.map((a) => [a.id, a]))
    const min = minYuan !== null && Number.isFinite(minYuan) ? Math.round(minYuan * 100) : null
    const max = maxYuan !== null && Number.isFinite(maxYuan) ? Math.round(maxYuan * 100) : null
    const hit = (e: (typeof entries)[number]) => {
      if (min !== null && e.amount < min) return false
      if (max !== null && e.amount > max) return false
      if (!kw) return true
      const t = tmap.get(e.typeId)
      const acc = e.accountId ? amap.get(e.accountId) : null
      return (
        (e.note || '').includes(kw) ||
        (t?.name || '').includes(kw) ||
        (acc?.name || '').includes(kw)
      )
    }
    const results = entries.filter((e) => !e.auto && hit(e)).slice(0, 200).map((e) => ({
      id: e.id, ym: e.ym, typeId: e.typeId,
      name: tmap.get(e.typeId)?.name ?? '未知', emoji: tmap.get(e.typeId)?.emoji ?? '🏷',
      amount: e.amount, note: e.note, accountName: e.accountId ? amap.get(e.accountId)?.name ?? null : null,
    }))
    const matchedAccounts = accounts.filter((a) => kw && a.name.includes(kw)).map((a) => ({ id: a.id, name: a.name, emoji: a.emoji }))
    return { results, matchedAccounts }
  }

  // ---------- 钱迹导入：批量写入月度快照（手动记录优先，不覆盖） ----------

  async importSnapshots(dto: {
    snapshots?: { ym: string; accountName: string; kind?: string; balance: number; recordDate?: string }[]
  }) {
    const rows = dto?.snapshots || []
    if (rows.length === 0) throw new BadRequestException('没有可导入的快照')
    const accountsCreated: string[] = []
    const idByName = new Map<string, number>()
    let created = 0
    let skipped = 0
    const touchedYms = new Set<string>()

    for (const r of rows) {
      const ym = String(r.ym || '')
      const accountName = String(r.accountName || '').trim()
      if (!YM_RE.test(ym) || !accountName) { skipped++; continue }
      if (!Number.isInteger(r.balance) || r.balance < 0) { skipped++; continue }
      let accountId = idByName.get(accountName)
      if (!accountId) {
        const existing = await this.prisma.account.findFirst({ where: { name: accountName } })
        if (existing) {
          accountId = existing.id
        } else {
          const max = await this.prisma.account.aggregate({ _max: { sort: true } })
          const acc = await this.prisma.account.create({
            data: {
              name: accountName.slice(0, 30),
              emoji: '🏦',
              kind: r.kind === 'liability' ? 'liability' : 'asset',
              initBalance: 0,
              sort: (max._max.sort ?? 0) + 1,
              createdAt: Math.floor(Date.now() / 1000),
              note: '钱迹导入',
            },
          })
          accountsCreated.push(accountName)
          accountId = acc.id
        }
        idByName.set(accountName, accountId)
      }
      const existingSnap = await this.prisma.monthlySnapshot.findUnique({
        where: { ym_accountId: { ym, accountId } },
      })
      if (existingSnap) { skipped++; continue }
      const recordDate = YMD_RE.test(r.recordDate || '') ? r.recordDate! : ym + '-28'
      await this.prisma.monthlySnapshot.create({
        data: { ym, accountId, balance: r.balance, recordDate, note: '钱迹导入' },
      })
      created++
      touchedYms.add(ym)
    }
    for (const ym of touchedYms) await this.recomputeAuto(ym)
    return { ok: true, created, skipped, accountsCreated }
  }
}

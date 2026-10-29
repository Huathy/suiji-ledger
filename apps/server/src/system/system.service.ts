import { Injectable, BadRequestException } from '@nestjs/common'
import { PrismaService } from '../prisma.service'
import { MonthsService } from '../months/months.service'
import { BackupService } from '../backup.service'
import { computeIntervalStats, daysBetween, fromCents } from '../../../../packages/shared/src/index'

export const DEFAULT_SETTINGS: Record<string, string> = {
  theme: 'auto', // auto | light | dark
  reminderDay: '28',
  baseCurrency: 'CNY',
  // M4（Git 同步）预留键位
  gitRemote: '',
  gitBranch: 'main',
  gitAuth: '',
  gitPushMode: 'daily', // manual | daily | every-commit
  gitEncrypt: 'off',
}

@Injectable()
export class SystemService {
  constructor(private prisma: PrismaService, private months: MonthsService, private backupSvc: BackupService) {}

  async getSettings() {
    const rows = await this.prisma.setting.findMany()
    const map: Record<string, string> = { ...DEFAULT_SETTINGS }
    for (const r of rows) map[r.key] = r.value
    return { settings: map }
  }

  async putSettings(dto: Record<string, string>) {
    for (const [key, value] of Object.entries(dto || {})) {
      if (typeof value !== 'string' || value.length > 5000) throw new BadRequestException('设置值不合法')
      await this.prisma.setting.upsert({
        where: { key },
        update: { value },
        create: { key, value },
      })
    }
    return this.getSettings()
  }

  /** 全量备份 JSON（自有 schema v1） */
  async backup() {
    const [types, accounts, snapshots, entries, loans, settings] = await Promise.all([
      this.prisma.recordType.findMany(),
      this.prisma.account.findMany(),
      this.prisma.monthlySnapshot.findMany({ orderBy: [{ ym: 'asc' }, { id: 'asc' }] }),
      this.prisma.changeEntry.findMany({ orderBy: [{ ym: 'asc' }, { id: 'asc' }] }),
      this.prisma.loan.findMany(),
      this.prisma.setting.findMany(),
    ])
    return {
      format: 'suiji-ledger-backup',
      version: 1,
      exportedAt: Date.now(),
      types,
      accounts,
      snapshots,
      entries,
      loans,
      settings,
      meta: { snapshotCount: snapshots.length, entryCount: entries.length },
    }
  }

  /** 恢复：replace=清空后导入；merge=按账户名+kind 映射合并 */
  async restore(mode: 'replace' | 'merge', data: any) {
    // 兼容旧版本备份（重命名前的 format 标识）
    if (!data || (data.format !== 'suiji-ledger-backup' && data.format !== 'moneyrecord-backup'))
      throw new BadRequestException('不是有效的 SuijiLedger 备份文件')
    if (!['replace', 'merge'].includes(mode)) throw new BadRequestException('恢复模式不合法')
    const rows = Array.isArray(data.snapshots) ? data.snapshots : []

    if (mode === 'replace') {
      await this.prisma.$transaction([
        this.prisma.changeEntry.deleteMany(),
        this.prisma.monthlySnapshot.deleteMany(),
        this.prisma.account.deleteMany(),
        this.prisma.recordType.deleteMany(),
      ])
      await this.prisma.recordType.create({ data: { name: '平账', emoji: '⚖️', direction: 'neutral', builtin: true, sort: 0 } })
    }

    // 类型映射：merge 时按 builtin+name 匹配，replace 直接自增
    const typeIdMap = new Map<number, number>()
    for (const t of data.types || []) {
      const existing =
        mode === 'merge'
          ? (await this.prisma.recordType.findFirst({ where: { name: t.name, direction: t.direction } }))
          : null
      if (existing) {
        typeIdMap.set(t.id, existing.id)
      } else {
        const created = await this.prisma.recordType.create({
          data: { name: t.name, emoji: t.emoji, color: t.color ?? null, direction: t.direction, builtin: !!t.builtin, sort: t.sort ?? 0 },
        })
        typeIdMap.set(t.id, created.id)
      }
    }

    const accIdMap = new Map<number, number>()
    for (const a of data.accounts || []) {
      const existing =
        mode === 'merge'
          ? (await this.prisma.account.findFirst({ where: { name: a.name, kind: a.kind } }))
          : null
      if (existing) {
        accIdMap.set(a.id, existing.id)
      } else {
        const created = await this.prisma.account.create({
          data: {
            name: a.name,
            emoji: a.emoji,
            kind: a.kind,
            group: a.group ?? null,
            initBalance: a.initBalance ?? 0,
            inNetWorth: a.inNetWorth ?? true,
            sort: a.sort ?? 0,
            archived: !!a.archived,
            note: a.note ?? null,
            createdAt: a.createdAt ?? Math.floor(Date.now() / 1000),
          },
        })
        accIdMap.set(a.id, created.id)
      }
    }

    let imported = 0
    for (const s of rows) {
      const accountId = accIdMap.get(s.accountId)
      if (!accountId) continue
      await this.prisma.monthlySnapshot.upsert({
        where: { ym_accountId: { ym: s.ym, accountId } },
        update: { balance: s.balance, recordDate: s.recordDate, note: s.note ?? null },
        create: { ym: s.ym, accountId, balance: s.balance, recordDate: s.recordDate, note: s.note ?? null },
      })
      imported++
    }
    for (const e of data.entries || []) {
      const typeId = typeIdMap.get(e.typeId)
      const accountId = e.accountId ? accIdMap.get(e.accountId) : null
      if (!typeId) continue
      await this.prisma.changeEntry.create({
        data: { ym: e.ym, typeId, amount: e.amount, note: e.note ?? null, accountId: accountId ?? null, auto: !!e.auto },
      })
    }
    // 全部重算自动条目
    const yms = [...new Set<string>(rows.map((s: any) => String(s.ym)))]
    for (const ym of yms) await this.months.recomputeAuto(ym)
    await this.backupSvc.snapshot('恢复备份 ' + mode)
    return { ok: true, mode, imported }
  }

  /** PC 资产负债总表（月份 × 账户矩阵）+ CSV 导出数据源 */
  async matrix(limit = 24) {
    const points = (await this.months.recordPoints()).slice(0, limit).reverse()
    const accounts = (await this.prisma.account.findMany({ orderBy: [{ sort: 'asc' }, { id: 'asc' }] })).filter(
      (a) => !a.archived,
    )
    const snaps = await this.prisma.monthlySnapshot.findMany()
    const entries = await this.prisma.changeEntry.findMany()
    const types = await this.prisma.recordType.findMany()
    const tdir = new Map(types.map((t) => [t.id, t.direction]))

    const rows = points.map((p, i) => {
      const ymSnaps = snaps.filter((s) => s.ym === p.ym)
      const cells = accounts.map((a) => {
        const s = ymSnaps.find((x) => x.accountId === a.id)
        return s ? s.balance : null
      })
      const incomeTotal = entries
        .filter((e) => e.ym === p.ym && !e.auto && tdir.get(e.typeId) === 'income')
        .reduce((s, e) => s + Math.max(0, e.amount), 0)
      const days = i > 0 ? daysBetween(points[i - 1].recordDate, p.recordDate) : 0
      const interval = i > 0 ? computeIntervalStats(p.delta ?? 0, incomeTotal, days) : null
      return {
        ym: p.ym,
        recordDate: p.recordDate,
        cells,
        assetsTotal: cells.reduce<number>((s, v, j) => s + (accounts[j].kind === 'asset' && v !== null ? v : 0), 0),
        networth: p.networth,
        delta: p.delta,
        dailyAvg: interval ? interval.dailyAvg : null,
        estimated: interval ? interval.estimated : null,
      }
    })
    return { accounts: accounts.map((a) => ({ id: a.id, name: a.name, emoji: a.emoji, kind: a.kind })), rows }
  }

  async matrixCsv() {
    const { accounts, rows } = await this.matrix(120)
    const head = ['月份', '记录日', ...accounts.map((a) => `${a.emoji}${a.name}${a.kind === 'liability' ? '(欠)' : ''}`), '总资产', '净资产', '结余', '日均开销(估)']
    const lines = [head.join(',')]
    for (const r of rows) {
      const daily = r.dailyAvg === null ? '' : fromCents(r.dailyAvg) + (r.estimated ? '*' : '')
      lines.push(
        [
          r.ym,
          r.recordDate,
          ...r.cells.map((v: number | null) => (v === null ? '' : fromCents(v))),
          fromCents(r.assetsTotal),
          fromCents(r.networth),
          r.delta === null ? '' : fromCents(r.delta),
          daily,
        ].join(','),
      )
    }
    return '\uFEFF' + lines.join('\r\n')
  }

  async health() {
    const [accounts, snapshots, entries] = await Promise.all([
      this.prisma.account.count(),
      this.prisma.monthlySnapshot.count(),
      this.prisma.changeEntry.count(),
    ])
    return { ok: true, version: '0.1.0', accounts, snapshots, entries }
  }
}

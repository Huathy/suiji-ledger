import { Injectable, BadRequestException } from '@nestjs/common'
import { PrismaService } from '../prisma.service'
import { MonthsService } from '../months/months.service'
import { BackupService } from '../backup.service'
import { RecordMetaService } from '../sync/record-meta.service'
import { encryptSecret, decryptSecret, maskSecret, keyHint } from '../sync/crypto'
// 密钥名单单点定义：getSettings / backup / backup.service 的自动快照共用同一份，
// 名单散成两处就一定会有一处漏过滤（解释见 secret-keys.ts）
import { SECRET_KEYS } from '../secret-keys'
import { computeIntervalStats, daysBetween, fromCents, stampText, sortByTime, type TimeSortDir } from '../../../../packages/shared/src/index'

export const DEFAULT_SETTINGS: Record<string, string> = {
  theme: 'auto', // auto | light | dark
  reminderDay: '28',
  baseCurrency: 'CNY',
  // 全站时间排序方向（timeSortDir：desc 倒序=新的在前 / asc 顺序=旧的在前）
  // 故意**不写进默认值**：缺键代表「用户还没设置过」，前端据此把本机值推上去；
  // 一旦给出默认值，新设备登录会被服务端 'desc' 覆盖掉本机刚调好的 'asc'。
  // M4（Git 同步）
  gitRemote: '',
  gitBranch: 'main',
  gitAuth: '',
  // Basic 用户名覆盖：留空 = 由引擎按远端 host 自动判定（Gitee/GitLab=oauth2，其余=x-access-token）。
  // Gitee 会校验用户名必须等于令牌属主，写死 GitHub 习惯值会直接吃 403。
  gitAuthUser: '',
  gitPushMode: 'daily', // manual | daily | every-commit
  gitEncrypt: 'off', // off | on（只有一档：整文件密文）
  gitMergeEnabled: 'on', // on | off；gitEncrypt=on 时后端强制 off
  gitAutoCommit: 'on',
}

@Injectable()
export class SystemService {
  constructor(
    private prisma: PrismaService,
    private months: MonthsService,
    private backupSvc: BackupService,
    private meta: RecordMetaService,
  ) {}

  async getSettings() {
    const rows = await this.prisma.setting.findMany()
    const map: Record<string, string> = { ...DEFAULT_SETTINGS }
    for (const r of rows) map[r.key] = r.value
    // 凭据一律脱敏：前端只需要知道"配没配"，不需要（也不应该）拿到明文
    let masked = ''
    if (map.gitAuthEnc) {
      try {
        masked = maskSecret(decryptSecret(map.gitAuthEnc))
      } catch {
        masked = '已配置 · 密钥不匹配'
      }
    } else if (map.gitAuth) {
      masked = maskSecret(map.gitAuth)
    }
    for (const k of SECRET_KEYS) delete map[k]
    return { settings: { ...map, gitAuthMasked: masked } }
  }

  async putSettings(dto: Record<string, string>) {
    const payload: Record<string, string> = {}
    for (const [key, value] of Object.entries(dto || {})) {
      if (typeof value !== 'string' || value.length > 5000) throw new BadRequestException('设置值不合法')
      payload[key] = value
    }

    // 凭据：明文永远不落库。空串 = 显式清除
    if (payload.gitAuth !== undefined) {
      const token = payload.gitAuth.trim()
      delete payload.gitAuth
      await this.prisma.setting.upsert({ where: { key: 'gitAuth' }, update: { value: '' }, create: { key: 'gitAuth', value: '' } })
      await this.prisma.setting.upsert({
        where: { key: 'gitAuthEnc' },
        update: { value: token ? encryptSecret(token) : '' },
        create: { key: 'gitAuthEnc', value: token ? encryptSecret(token) : '' },
      })
    }
    delete payload.gitAuthMasked

    // 加密 ⇒ 合并强制关（后端联动，不能只靠前端置灰；§7.1）
    if (payload.gitEncrypt === 'on') payload.gitMergeEnabled = 'off'

    for (const [key, value] of Object.entries(payload)) {
      await this.prisma.setting.upsert({
        where: { key },
        update: { value },
        create: { key, value },
      })
    }
    return this.getSettings()
  }

  /**
   * 全量备份 JSON（自有 schema v1）。
   *
   * ⚠️ settings 必须过 SECRET_KEYS 过滤：备份文件会落到手机「下载/SuijiLedger」等目录，
   * gitAuth/gitAuthEnc/gitConflictState 一旦原样导出，明文 PAT 就离开了本机
   * （getSettings 有过滤但 backup() 读的是 prisma 原始行——评审修复项）。
   * 密钥指纹以 keyHint 形式随备份导出（docs/21 §7.2）：密钥丢失 = 历史密文不可解。
   */
  async backup() {
    const [types, accounts, snapshots, entries, loans, settingRows] = await Promise.all([
      this.prisma.recordType.findMany(),
      this.prisma.account.findMany(),
      this.prisma.monthlySnapshot.findMany({ orderBy: [{ ym: 'asc' }, { id: 'asc' }] }),
      this.prisma.changeEntry.findMany({ orderBy: [{ ym: 'asc' }, { id: 'asc' }] }),
      this.prisma.loan.findMany(),
      this.prisma.setting.findMany(),
    ])
    const settings = settingRows.filter((r) => !SECRET_KEYS.has(r.key))
    return {
      format: 'suiji-ledger-backup',
      version: 1,
      exportedAt: Date.now(),
      exportedAtText: stampText(),
      types,
      accounts,
      snapshots,
      entries,
      loans,
      settings,
      keyHint: keyHint(),
      meta: { snapshotCount: snapshots.length, entryCount: entries.length },
    }
  }

  /** 恢复：replace=清空后导入；merge=按账户名+kind 映射合并 */
  async restore(mode: 'replace' | 'merge', data: any) {
    // 兼容旧版本备份（重命名前的 format 标识）
    if (!data || (data.format !== 'suiji-ledger-backup' && data.format !== 'moneyrecord-backup'))
      throw new BadRequestException('不是有效的 Suiji Ledger 备份文件')
    if (!['replace', 'merge'].includes(mode)) throw new BadRequestException('恢复模式不合法')
    const rows = Array.isArray(data.snapshots) ? data.snapshots : []

    // replace 新建的内置「平账」行：备份里的 builtin 直接复用它，不另建（防每次恢复多一个"平账"）
    let freshBuiltin: { id: number; uid: string } | null = null
    if (mode === 'replace') {
      /**
       * replace 的"清空"必须是**墓碑化**，不能 deleteMany（docs/21 §4.3 / R10）。
       *
       * 物理清空会破坏墓碑语义：投影永不物理删文件，"删除"只写成 `deleted:true` 的墓碑内容，
       * 因为 mergeDriver 只在"两端都有该文件且都改过"时才被调用——文件一消失，冲突就绕开驱动。
       * 而 deleteMany 清库后工作区的旧文件与旧 commit 树仍在，对端 pull 时读成
       * "远端把这些全删了又新增了一堆"，已清掉的数据在对端复活/错乱；
       * 同理 replace 语义本身也不完整——旧的实现连 Loan 表都没清。
       *
       * 墓碑 rev 必须 > maxSeen（本机见过的最大 rev）：rev 不比对端见过的大，
       * 对端就会把自己的旧版本判为"更新"从而把数据复活。
       */
      const [origin, maxSeen] = await Promise.all([this.meta.deviceId(), this.meta.maxSeen()])
      const tomb = { deleted: true, rev: maxSeen + 1, updatedAt: this.meta.now(), origin }
      // 五张同步载体一个事务里全墓碑，要么全墓碑要么全不动
      await this.prisma.$transaction([
        this.prisma.changeEntry.updateMany({ where: { deleted: false }, data: tomb }),
        this.prisma.monthlySnapshot.updateMany({ where: { deleted: false }, data: tomb }),
        this.prisma.account.updateMany({ where: { deleted: false }, data: tomb }),
        this.prisma.recordType.updateMany({ where: { deleted: false }, data: tomb }),
        this.prisma.loan.updateMany({ where: { deleted: false }, data: tomb }),
      ])
      const freshBuiltinRow = await this.prisma.recordType.create({
        data: {
          ...(await this.meta.stamp()),
          name: '平账', emoji: '⚖️', direction: 'neutral', builtin: true, sort: 0,
        },
      })
      // replace 自带的内置类型：备份里一般也含"平账"，直接复用这一行，
      // 不再为备份里的 builtin 另建第二行（否则每次 replace 恢复都多一个"平账"类型）。
      freshBuiltin = { id: freshBuiltinRow.id, uid: freshBuiltinRow.uid as string }
    }

    // 类型映射：merge 时按 name+direction 匹配，replace 直接新建。
    // `deleted: false`：墓碑行不能被当成"已存在"，否则导入数据会挂在墓碑 uid 上（等于没导入）
    //
    // 防翻倍（bug20261104）：备份自带 uid（v1 现行导出含 uid/rev/origin）时直接采用，
    // 同一份备份在两端恢复产出同一 uid，同步才能对齐；无 uid 的旧备份用确定性 uid
    //（同名同属性在两端算出同一值），不再各生成随机值导致"同名账户翻倍"。
    const typeIdMap = new Map<number, number>()
    const typeUidById = new Map<number, string>()
    for (const t of data.types || []) {
      const incomingUid = typeof t.uid === 'string' && t.uid ? t.uid : null
      const detUid = incomingUid || this.meta.deterministicUid('type', `${t.direction}::${t.name}`)
      // 备份里的内置类型直接复用 replace 新建的那一行，不再另建
      if (t.builtin && freshBuiltin) {
        typeIdMap.set(t.id, freshBuiltin.id)
        typeUidById.set(t.id, freshBuiltin.uid)
        continue
      }
      const existing =
        mode === 'merge'
          ? (await this.prisma.recordType.findFirst({ where: { name: t.name, direction: t.direction, deleted: false } }))
          : null
      if (existing) {
        typeIdMap.set(t.id, existing.id)
        typeUidById.set(t.id, existing.uid!)
      } else {
        const stamp = await this.meta.stamp()
        const created = await this.prisma.recordType.create({
          data: {
            ...stamp,
            uid: detUid,
            name: t.name, emoji: t.emoji, color: t.color ?? null, direction: t.direction, builtin: !!t.builtin, sort: t.sort ?? 0,
          },
        })
        typeIdMap.set(t.id, created.id)
        typeUidById.set(t.id, detUid)
      }
    }

    const accIdMap = new Map<number, number>()
    const accUidById = new Map<number, string>()
    for (const a of data.accounts || []) {
      const incomingUid = typeof a.uid === 'string' && a.uid ? a.uid : null
      const detUid = incomingUid || this.meta.deterministicUid('account', `${a.kind}::${a.name}`)
      const existing =
        mode === 'merge'
          ? (await this.prisma.account.findFirst({ where: { name: a.name, kind: a.kind, deleted: false } }))
          : null
      if (existing) {
        accIdMap.set(a.id, existing.id)
        accUidById.set(a.id, existing.uid!)
      } else {
        const stamp = await this.meta.stamp()
        const created = await this.prisma.account.create({
          data: {
            ...stamp,
            uid: detUid,
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
        accUidById.set(a.id, detUid)
      }
    }

    let imported = 0
    for (const s of rows) {
      const accountId = accIdMap.get(s.accountId)
      if (!accountId) continue
      const acc = await this.prisma.account.findUnique({ where: { id: accountId } })
      // 只认**活行**：ym_accountId 是唯一索引，墓碑行同样占着这个位置。
      // 用 findUnique/upsert 直连复合键会把墓碑行当成"已存在"→ 只改内容、deleted 仍是 true，
      // 导入的数据等于凭空消失（rev 也是给墓碑行 bump，对端看到的还是"已删除"）。
      const alive = await this.prisma.monthlySnapshot.findFirst({ where: { ym: s.ym, accountId, deleted: false } })
      const stamp = await this.meta.stamp()
      // uid 一律重新生成（语义上还带着 account.uid 的派生写法），绝不复用墓碑行的旧 uid
      const uid = acc?.uid ? `${s.ym}__${acc.uid}` : stamp.uid
      const body = { balance: s.balance, recordDate: s.recordDate, note: s.note ?? null }
      if (alive) {
        await this.prisma.monthlySnapshot.update({
          where: { id: alive.id },
          data: { ...body, ...(await this.meta.bump(alive)) },
        })
      } else {
        // 同 ym+accountId 若被墓碑行占位，只能**原地复活**（物理删被禁止、新建会撞唯一索引）
        const dead = await this.prisma.monthlySnapshot.findFirst({ where: { ym: s.ym, accountId, deleted: true } })
        if (dead) {
          await this.prisma.monthlySnapshot.update({
            where: { id: dead.id },
            data: { ...stamp, uid, ym: s.ym, accountId, deleted: false, ...body },
          })
        } else {
          await this.prisma.monthlySnapshot.create({
            data: { ...stamp, uid, ym: s.ym, accountId, ...body },
          })
        }
      }
      imported++
    }
    for (const e of data.entries || []) {
      const typeId = typeIdMap.get(e.typeId)
      const accountId = e.accountId ? accIdMap.get(e.accountId) : null
      if (!typeId) continue
      // 条目同样复用备份 uid（无则确定性派生）：两端恢复同一备份得到同一条目 uid，
      // 同步吸收时判 identical 而不是"对端新增"，大项不再翻倍。auto 条目跳过——
      // 它是派生值，各端 recomputeAuto 会重算，导入只会污染恒等式。
      if (e.auto) continue
      const incomingUid = typeof e.uid === 'string' && e.uid ? e.uid : null
      const entryUid = incomingUid || this.meta.deterministicUid(
        'entry',
        `${e.ym}::${typeUidById.get(e.typeId) ?? e.typeId}::${e.amount}::${e.note ?? ''}::${e.accountId ? (accUidById.get(e.accountId) ?? e.accountId) : ''}`,
      )
      const existingEntry = await this.prisma.changeEntry.findUnique({ where: { uid: entryUid } })
      if (existingEntry) continue
      const stamp = await this.meta.stamp()
      await this.prisma.changeEntry.create({
        data: {
          ...stamp,
          uid: entryUid,
          ym: e.ym, typeId, amount: e.amount, note: e.note ?? null, accountId: accountId ?? null, auto: false,
        },
      })
    }
    for (const l of data.loans || []) {
      // 借还复用备份 uid（无则确定性派生），同备份两端恢复不对出两条。
      const incomingUid = typeof l.uid === 'string' && l.uid ? l.uid : null
      const loanUid = incomingUid || this.meta.deterministicUid(
        'loan',
        `${l.direction}::${l.counterparty}::${l.amount}::${l.date}`,
      )
      const existingLoan = await this.prisma.loan.findUnique({ where: { uid: loanUid } })
      if (existingLoan) continue
      const stamp = await this.meta.stamp()
      await this.prisma.loan.create({
        data: {
          ...stamp,
          uid: loanUid,
          direction: l.direction === 'in' ? 'in' : 'out',
          counterparty: String(l.counterparty ?? '').slice(0, 30),
          amount: l.amount, settledAmount: l.settledAmount ?? 0,
          date: String(l.date ?? ''), dueDate: l.dueDate ?? null,
          accountId: l.accountId ? accIdMap.get(l.accountId) ?? null : null,
          note: l.note ?? null, createdAt: l.createdAt ?? Math.floor(Date.now() / 1000),
        },
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
    const accounts = (await this.prisma.account.findMany({ where: { deleted: false }, orderBy: [{ sort: 'asc' }, { id: 'asc' }] })).filter(
      (a) => !a.archived,
    )
    const snaps = await this.prisma.monthlySnapshot.findMany({ where: { deleted: false } })
    const entries = await this.prisma.changeEntry.findMany({ where: { deleted: false } })
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

  /**
   * CSV 导出：行序与页面一致，dir='desc'（默认）= 时间倒序（最新月份在前），'asc' = 时间顺序。
   * 表头与列口径不变，只翻行序（问题：数据排序要支持时间倒序/顺序）。
   */
  async matrixCsv(dir: TimeSortDir = 'desc') {
    const { accounts, rows } = await this.matrix(120)
    const ordered = sortByTime(rows, (r: any) => r.ym, dir)
    const head = ['月份', '记录日', ...accounts.map((a) => `${a.emoji}${a.name}${a.kind === 'liability' ? '(欠)' : ''}`), '总资产', '净资产', '结余', '日均开销(估)']
    const lines = [head.join(',')]
    for (const r of ordered) {
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
    // 末尾附导出时间（问题 3）：不污染表头，Excel 打开只是最后一行备注
    lines.push('')
    lines.push(`# 导出时间,${stampText()}`)
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

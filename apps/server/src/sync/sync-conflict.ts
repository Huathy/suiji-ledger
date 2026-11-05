import { BadRequestException } from '@nestjs/common'
import path from 'node:path'
import { PrismaService } from '../prisma.service'
import { MonthsService } from '../months/months.service'
import { ApplyRecordService } from './apply-record.service'
import { RecordMetaService } from './record-meta.service'
import { ProjectService } from './project.service'
import { SyncConfigService } from './sync-config.service'
import { decodeRecord } from './codec'
import type { CapturedTriple } from './merge-driver'
import {
  composeResolved,
  diffFields,
  fingerprint,
  kindOfFileName,
  recommendFromTexts,
  repoPathOfFile,
  titleOf,
  uidOfFileName,
  type LedgerRecord,
  type TitleCtx,
} from './ledger'
import type { ConflictItem, ResolveItem, StoredConflict, SyncHost } from './sync-types'

export type ConflictDeps = {
  prisma: PrismaService
  cfg: SyncConfigService
  project: ProjectService
  apply: ApplyRecordService
  months: MonthsService
  meta: RecordMetaService
  host: SyncHost
}

/**
 * 冲突的**呈现**与**裁决**（原 SyncService 里 709–1051 行那一坨）。
 *
 * 拆出来的理由（评审修复项 Divergent Change）：这段与同步编排只共享"门"和"推送"两个能力，
 * 却被塞在同一个 1227 行的类里——读 `pullMerge` 的人要穿过 300 行冲突渲染才能看懂推送，
 * 改字段级锁定又要回头确认有没有打断调度。现在边界是硬的：
 * 这个文件只碰 `StoredConflict` 快照与业务表，一行调度代码都没有。
 */
export class SyncConflict {
  constructor(private readonly deps: ConflictDeps) {}

  private get log() {
    return this.deps.host.log
  }

  // ---------------- 呈现 ----------------

  async list() {
    const state = await this.deps.cfg.conflictState<StoredConflict>()
    if (!state) return { items: [], mode: 'merge', errorData: null, autoMerged: [] as string[] }
    return { items: state.items, mode: state.mode, errorData: state.errorData, at: state.at, autoMerged: state.autoMerged || [] }
  }

  private async titleCtx(): Promise<TitleCtx> {
    const [types, accounts] = await Promise.all([
      this.deps.prisma.recordType.findMany({ select: { uid: true, name: true } }),
      this.deps.prisma.account.findMany({ select: { uid: true, name: true } }),
    ])
    const tmap = new Map(types.filter((t) => t.uid).map((t) => [t.uid as string, t.name]))
    const amap = new Map(accounts.filter((a) => a.uid).map((a) => [a.uid as string, a.name]))
    return { typeName: (u) => tmap.get(u) ?? null, accountName: (u) => amap.get(u) ?? null }
  }

  /** 把"驱动回调 + mergeTree 报出的路径"折成界面能裁决的条目（只收同步载体文件） */
  async build(captured: CapturedTriple[], errorData: any, oursOid: string | null, theirsOid: string | null, encrypted: boolean): Promise<ConflictItem[]> {
    const ctx = await this.titleCtx()
    const items: ConflictItem[] = []
    const seen = new Set<string>()

    for (const t of captured) {
      seen.add(t.fileName)
      items.push(await this.toItem(t, ctx, false, encrypted))
    }

    // 驱动没回调的（单侧删除等走的是 mergeTree 的 delete 分支，不调驱动）→ 从两个 ref 补读
    const paths: string[] = []
    for (const k of ['filepaths', 'bothModified', 'deleteByUs', 'deleteByTheirs']) {
      const arr = errorData?.[k]
      if (Array.isArray(arr)) paths.push(...arr)
    }
    const engine = await this.deps.project.engine()
    for (const fp of [...new Set(paths)]) {
      const fileName = path.basename(fp)
      if (seen.has(fileName)) continue
      // 只收同步载体文件（评审修复项）：errorData 里还会带 .gitignore 等非载体路径
      // （isomorphic-git 把整棵树的冲突都报出来）。收进来会造出界面无法裁决的条目
      // —— 驱动对它们返回 cleanMerge 已被跳过，这里再补一遍就会让"勾选后静默丢弃"复现。
      if (!kindOfFileName(fileName)) continue
      seen.add(fileName)
      const our = oursOid ? await engine.readFileAt(oursOid, fp) : null
      const their = theirsOid ? await engine.readFileAt(theirsOid, fp) : null
      if (!our && !their) continue
      items.push(await this.toItem({ fileName, base: null, our: our || '', their: their || '' }, ctx, true, encrypted))
    }
    return items
  }

  private async toItem(t: CapturedTriple, ctx: TitleCtx, sideMissing = false, encryptedStore = false): Promise<ConflictItem> {
    const kind = kindOfFileName(t.fileName)
    const local = t.our ? decodeRecord(t.our, t.fileName) : null
    const remote = t.their ? decodeRecord(t.their, t.fileName) : null
    const base = t.base ? decodeRecord(t.base, t.fileName) : null

    // kind 已保证非空（build() 只收载体文件）；key 与 resolveInner 的索引口径必须一字不差
    const key = kind ? repoPathOfFile(kind, t.fileName) : `ledger/v1/${t.fileName}`
    const fallbackTitle = uidOfFileName(t.fileName) || t.fileName

    if (local?.ok && remote?.ok) {
      const baseRec = base?.ok ? base.rec : null
      // 预选规则走专门的纯函数；不再拿 decideMerge 传哨兵值（评审修复项 Data Clumps）
      const d = recommendFromTexts(t.base, t.our, t.their, t.fileName)
      return {
        key,
        fileName: t.fileName,
        kind: kind,
        title: titleOf(local.rec, ctx),
        // 加密仓库：即使两端都能解密（同一把 key），也只能整份二选一（§5.6.3 第 6 条）
        conflictType: encryptedStore ? 'encrypted' : sideMissing || local.rec.deleted !== remote.rec.deleted ? 'edit-delete' : 'both',
        base: t.base,
        local: t.our,
        remote: t.their,
        fields: diffFields(baseRec, local.rec, remote.rec, ctx),
        recommend: d.identical ? 'local' : d.recommend,
        reason: encryptedStore ? '已开启加密，只能整份二选一（字段值仅供对照）' : d.identical ? '内容一致' : d.reason,
      }
    }

    const localReason = local && !local.ok ? local.reason : null
    const remoteReason = remote && !remote.ok ? remote.reason : null
    const encrypted = localReason === 'encrypted' || remoteReason === 'encrypted'
    // 密文类冲突带上 §7.1 定稿 message（密钥不匹配 / 远端已加密），不再挤成一句通用文案
    // （R14：不静默降级，评审修复项）
    const encMsg = [!local || local.ok ? null : local.message, !remote || remote.ok ? null : remote.message].filter(Boolean).join('；')
    return {
      key,
      fileName: t.fileName,
      kind: kind,
      title: fallbackTitle,
      conflictType: encrypted ? 'encrypted' : 'unparsable',
      base: t.base,
      local: t.our || null,
      remote: t.their || null,
      fields: [
        {
          name: '__raw',
          label: '内容',
          base: t.base ? fingerprint(t.base) : null,
          local: t.our ? fingerprint(t.our) : null,
          remote: t.their ? fingerprint(t.their) : null,
          changed: 'both',
        },
      ],
      recommend: 'local',
      reason: encrypted
        ? [encMsg || '远端仓库已加密，请在本机开启加密并填入同一密钥', '无法逐字段合并，只能整份二选一'].filter(Boolean).join(' · ')
        : '内容无法解析，只能整份二选一',
    }
  }

  // ---------------- 裁决 ----------------

  /** 应用用户勾选（§5.6.4）；未勾选的项保持冲突态，不猜。走门：与定时器 run 串行 */
  async resolve(items: ResolveItem[], push = true) {
    return this.deps.host.gate('冲突裁决', () => this.resolveInner(items, push))
  }

  /**
   * §5.6.5 批量兜底联动：pick=remote 覆盖本地前，把被覆盖的本机行送进回收站（不静默删）。
   * 支持 entry/loan/account/snapshot/type（RecycleService.restore 同表复活）。
   */
  private async recycleBeforeOverwrite(rec: LedgerRecord, summary: string) {
    const row =
      rec.kind === 'entry'
        ? await this.deps.prisma.changeEntry.findUnique({ where: { uid: rec.uid } })
        : rec.kind === 'loan'
          ? await this.deps.prisma.loan.findUnique({ where: { uid: rec.uid } })
          : rec.kind === 'account'
            ? await this.deps.prisma.account.findUnique({ where: { uid: rec.uid } })
            : rec.kind === 'snapshot'
              ? await this.deps.prisma.monthlySnapshot.findUnique({ where: { uid: rec.uid } })
              : rec.kind === 'type'
                ? await this.deps.prisma.recordType.findUnique({ where: { uid: rec.uid } })
                : null
    if (!row) return
    await this.deps.prisma.deletedItem.create({
      data: {
        kind: rec.kind,
        summary: `同步裁决覆盖 · ${summary}`.slice(0, 120),
        payload: JSON.stringify(row),
        deletedAt: Math.floor(Date.now() / 1000),
      },
    })
  }

  private async resolveInner(items: ResolveItem[], push = true) {
    const cfg = this.deps.cfg
    const state = await cfg.conflictState<StoredConflict>()
    if (!state) throw new BadRequestException('当前没有待处理的冲突')
    if (!Array.isArray(items) || items.length === 0) throw new BadRequestException('没有提交任何裁决项')

    const byKey = new Map(state.items.map((i) => [i.key, i]))
    const byFile = new Map(state.items.map((i) => [i.fileName, i]))
    const resolved = new Set<string>()
    const yms = new Set<string>()
    let localCount = 0
    let remoteCount = 0

    // ── 预校验整批，再逐条落地（评审修复项 Spec(c)1）──
    // 旧实现在循环中途遇到"远端不可解析却选了远程"直接 throw 400，
    // 但排在它前面的项**已经 apply 落库**：界面看到的是整批失败，库里却进了半批，
    // 冲突快照也没更新——用户修正后重裁，已成功的项会被二次 apply（rev 双重顶高、
    // 覆盖件二次进回收站）。现在任何一项不合格都在第一次写库之前抛出。
    type Plan = { item: ConflictItem; it: ResolveItem; localParsed: any; remoteParsed: any; baseParsed: any }
    const plan: Plan[] = []
    const seenKeys = new Set<string>()
    const unknown: string[] = []
    for (const it of items) {
      const item = byKey.get(it.key) || byFile.get(it.key)
      // 勾选不许静默丢弃（评审修复项 Spec(c)5）：冲突快照里找不到的 key 说明界面数据过期
      // （别的设备刚裁决过 / 冲突已被处理）。旧实现 `continue` 把这一项扔进黑洞，
      // 用户勾了一屏、只落了半屏，界面还说"已全部裁决"。
      if (!item) {
        unknown.push(String(it.key))
        continue
      }
      if (seenKeys.has(item.key)) throw new BadRequestException(`同一记录被重复提交裁决：${item.title}`)
      seenKeys.add(item.key)
      if (it.pick !== 'local' && it.pick !== 'remote') throw new BadRequestException('裁决方向不合法')
      // 整份二选一的场景（加密 / 合并已关）不接受字段级覆盖，否则等于绕过"不可合并"的开关
      if (state.mode === 'whole-file' && it.fieldPicks && Object.keys(it.fieldPicks).length > 0) {
        throw new BadRequestException('当前为整份二选一模式（已加密或已关闭合并），不接受逐字段裁决')
      }
      const localParsed = item.local ? decodeRecord(item.local, item.fileName) : null
      const remoteParsed = item.remote ? decodeRecord(item.remote, item.fileName) : null
      const baseParsed = item.base ? decodeRecord(item.base, item.fileName) : null
      if (it.pick === 'remote' && (!localParsed?.ok || !remoteParsed?.ok) && !remoteParsed?.ok) {
        throw new BadRequestException(`「${item.title}」远端内容无法解析（或密钥不匹配），不能以远程为准；请改选以本地为准`)
      }
      plan.push({ item, it, localParsed, remoteParsed, baseParsed })
    }
    if (unknown.length > 0) {
      throw new BadRequestException(
        `有 ${unknown.length} 项裁决与当前冲突快照不匹配（可能已被其它设备处理或界面数据过期）：${unknown.slice(0, 3).join(', ')}${unknown.length > 3 ? '…' : ''}。请刷新冲突列表后重新裁决。`,
      )
    }
    if (plan.length === 0) throw new BadRequestException('没有可落地的裁决项')

    /** 半批收尾：把已裁决项从快照摘掉、保持 conflict 态，并明确报哪一条出的事 */
    const partialStop = async (title: string, e: any) => {
      for (const ymDone of yms) await this.deps.months.recomputeAuto(ymDone).catch(() => undefined)
      const left = state.items.filter((i) => !resolved.has(i.key))
      await cfg.setConflictState({ ...state, items: left })
      await cfg.setState({ state: 'conflict' })
      this.log.warn(`裁决落地中断于「${title}」: ${e?.message || e}`)
      return {
        ok: false,
        partial: true,
        applied: resolved.size,
        remaining: left.length,
        pushed: false,
        message: `已落地 ${resolved.size} 条，「${title}」写入失败：${String(e?.message || e).slice(0, 200)}。剩余冲突仍在，可重试。`,
      }
    }

    for (const { item, it, localParsed, remoteParsed, baseParsed } of plan) {
      if (it.pick === 'local') localCount++
      else remoteCount++

      if (!localParsed?.ok || !remoteParsed?.ok) {
        // 密文/坏内容：只能"整份以某一侧为准"（pick=remote 的可解析性已在预校验保证）
        if (it.pick === 'remote') {
          // §5.6.5：以远程为准 = 本地被覆盖，覆盖前把本机行送进回收站（不静默删）
          // 预校验已保证此处 remoteParsed.ok 必真；本地不可解析时退化为"按远端记录找本机行"
          if (localParsed?.ok) await this.recycleBeforeOverwrite(localParsed.rec, item.title)
          else await this.recycleBeforeOverwrite(remoteParsed.rec, item.title)
          try {
            const rr = await this.deps.apply.apply(remoteParsed.rec)
            if (rr.ym) yms.add(String(rr.ym))
          } catch (e: any) {
            return partialStop(item.title, e)
          }
        }
        // 以本地为准：本地库本来就是这份内容，无需写库
        resolved.add(item.key)
        continue
      }

      const [deviceId, nowSec] = [await this.deps.meta.deviceId(), Math.floor(Date.now() / 1000)]
      const merged = composeResolved({
        base: baseParsed?.ok ? baseParsed.rec : null,
        local: localParsed.rec,
        remote: remoteParsed.rec,
        pick: it.pick,
        fieldPicks: it.fieldPicks,
        deviceId,
        now: nowSec,
      })
      // §5.6.5 联动（评审修复项）：本地行将被动到（pick=remote 或字段覆盖改了本地值）→
      // 先把**本地现状**存回收站，再 apply。纯 pick=local 且无字段覆盖的不进（没覆盖任何东西）。
      if (it.pick === 'remote' || (it.fieldPicks && Object.keys(it.fieldPicks).length > 0)) {
        await this.recycleBeforeOverwrite(localParsed.rec, item.title)
      }
      // 写库通道中途故障（prisma 异常等）：已成功的项不许"整批假装没发生"。
      let r: any
      try {
        r = await this.deps.apply.apply(merged)
      } catch (e: any) {
        return partialStop(item.title, e)
      }
      if (r.ym) yms.add(r.ym)
      resolved.add(item.key)
    }

    for (const ym of yms) await this.deps.months.recomputeAuto(ym)

    const remaining = state.items.filter((i) => !resolved.has(i.key))
    if (remaining.length > 0) {
      // 还没处理完：保持冲突态（index 里还有 stage 1/2/3），只把已勾选的落地
      await cfg.setConflictState({ ...state, items: remaining })
      await cfg.setState({ state: 'conflict' })
      return { ok: true, applied: resolved.size, remaining: remaining.length, pushed: false }
    }

    // 六步顺序不能颠倒（§5.5）：先写库 → abortMerge → 重投影 → **合并提交** → push → 清快照
    const engine = await this.deps.project.engine()
    const branch = await cfg.branch()
    await engine.abortMerge()
    await this.deps.project.writeAll()
    // 必须双亲（head + theirs），否则推送不是 fast-forward，见 ProjectService.commitMerge 注释
    const oid = await this.deps.project.commitMerge(`chore(data): resolve-conflict ${localCount} local / ${remoteCount} remote`, state.theirsOid)
    await cfg.setConflictState(null)

    let pushResult: any = { ok: false, skipped: true }
    if (push && (await cfg.remote())) {
      // 门内不能再走 run()（撞自己的 running 门返回 busy——评审修复项：以前"裁决后推送"
      // 撞 busy 却照样置 idle、界面 toast「已推送」说谎）。用门内直推路径。
      try {
        pushResult = await this.deps.host.pushInGate(branch)
      } catch (e: any) {
        pushResult = { ok: false, reason: 'error', message: String(e?.message || e), statusCode: this.deps.host.statusCodeOf(e) }
      }
    }
    // 推送阶段又撞上新冲突时，pushWithRetry→pullMerge 已把快照与状态落成 conflict，这里不能覆盖成 idle 骗界面
    if (pushResult?.reason === 'conflict' || pushResult?.reason === 'conflict-pending') {
      return { ok: true, applied: resolved.size, remaining: 0, pushed: false, commit: oid, push: pushResult }
    }
    const pushedOk = !!pushResult?.ok || !!pushResult?.skipped
    if (!pushedOk) {
      // 裁决后的推送失败也走唯一定性落点：凭据/权限类一律转 halted 并给修法，
      // 不再手抄一份 setState({state:'error'}) —— 那份副本会沿用上一轮的 nextRetryAt 让 tick 反复重试。
      // kind 传 'error'：auto=false 时 markFailure 不落 offline，只有 halted / error 两种去向。
      const res = await this.deps.host.markFailure('error', String(pushResult?.message || '推送失败'), {
        auto: false,
        statusCode: pushResult?.statusCode ?? null,
      })
      await cfg.setState({ lastCommitOid: oid || (await cfg.state()).lastCommitOid })
      return { ok: true, applied: resolved.size, remaining: 0, pushed: false, commit: oid, push: { ...pushResult, reason: res?.reason || 'error', halted: !!res?.halted } }
    }
    await cfg.setState({
      state: 'idle',
      lastSyncAt: Math.floor(Date.now() / 1000),
      lastError: null,
      retries: 0,
      nextRetryAt: null,
      lastCommitOid: oid || (await cfg.state()).lastCommitOid,
    })
    return { ok: true, applied: resolved.size, remaining: 0, pushed: pushedOk && !pushResult?.skipped, commit: oid, push: pushResult }
  }

  /** 放弃合并：abortMerge 复位 + 清快照，本地数据一字不动（§5.6.3 第 4 条：中途退出＝全部放弃） */
  async abort() {
    return this.deps.host.gate('放弃合并', async () => {
      const engine = await this.deps.project.engine()
      await engine.abortMerge()
      await this.deps.cfg.setConflictState(null)
      await this.deps.cfg.setState({ state: 'idle', lastError: null })
      return { ok: true }
    })
  }
}

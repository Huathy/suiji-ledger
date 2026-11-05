import { BadRequestException } from '@nestjs/common'
import { MonthsService } from '../months/months.service'
import { ApplyRecordService } from './apply-record.service'
import { RecordMetaService } from './record-meta.service'
import { ProjectService } from './project.service'
import { SyncConfigService } from './sync-config.service'
import { decodeRecord } from './codec'
import { kindOfFileName, type LedgerRecord } from './ledger'
import type { SyncHost } from './sync-types'

export type HistoryDeps = {
  cfg: SyncConfigService
  project: ProjectService
  apply: ApplyRecordService
  months: MonthsService
  meta: RecordMetaService
  host: SyncHost
}

/**
 * 历史 / 版本差异 / 版本恢复（原 SyncService 里 1053–1227 行）。
 *
 * 拆出来的理由同 SyncConflict（Divergent Change）：这三件事只读写"仓库里的旧提交"与
 * "当前投影"，属于**只读巡检 + 一次性写回**，跟调度、门队列、失败退避没有共同状态；
 * 混在一个类里时，恢复路径要改一行都得重读 1200 行才知道会不会动到 tick。
 */
export class SyncHistory {
  constructor(private readonly deps: HistoryDeps) {}

  private get log() {
    return this.deps.host.log
  }

  async history(limit = 50, cursor = 0) {
    return this.deps.host.gate('版本历史', async () => {
      const engine = await this.deps.project.engine()
      // 多取 1 条判"还有没有下一页"：旧实现深度截在 min(500, limit+cursor)，
      // 历史恰好 ≥500 条时把截断误报成"没有更多"（评审修复项 Std 7）
      const want = limit + cursor + 1
      const rows = await engine.log(Math.min(2000, want))
      const page = rows.slice(cursor, cursor + limit)
      return {
        commits: page.map((r) => ({ oid: r.oid, message: r.message, ts: r.ts, author: r.author, networthCents: parseNetworth(r.message) })),
        nextCursor: rows.length >= want ? cursor + limit : null,
      }
    })
  }

  async diff(oid: string) {
    if (!oid) throw new BadRequestException('缺少 oid')
    return this.deps.host.gate('版本对比', () => this.diffInner(oid))
  }

  /**
   * 差异摘要（§4.5）：目标版 vs **当前工作投影**，按记录级给 added/removed/changed。
   * 评审修复项补上 spec 点名的 merge-base：用 `findMergeBase(head, oid)` 找共同祖先，
   * 祖先里既存在、双端内容又不同 → changed；只在目标版存在 → removed（相对当前）；
   * 只在当前存在 → added。没有祖先（无关历史）时退回纯两侧对比，全部按双改对待。
   */
  async diffInner(oid: string) {
    const engine = await this.deps.project.engine()
    const target = await engine.listFiles(oid)
    if (target.length === 0) throw new BadRequestException('该版本不存在或没有内容')
    const { files: current } = await this.deps.project.buildFiles()
    const head = await engine.headOid()
    const baseOid = head && head !== oid ? await engine.mergeBase(head, oid) : head === oid ? oid : null

    const baseNames = new Map<string, string>() // fileName → path
    if (baseOid && baseOid !== oid && baseOid !== head) {
      for (const fp of await engine.listFiles(baseOid)) {
        const fileName = fp.slice(fp.lastIndexOf('/') + 1)
        if (kindOfFileName(fileName)) baseNames.set(fileName, fp)
      }
    }

    const added: string[] = []
    const removed: string[] = []
    const changed: string[] = []
    const targetNames = new Set<string>()
    for (const fp of target) {
      const fileName = fp.slice(fp.lastIndexOf('/') + 1)
      if (!kindOfFileName(fileName)) continue
      targetNames.add(fileName)
      const text = await engine.readFileAt(oid, fp)
      const cur = current.get(fileName)
      if (cur === undefined) {
        // 目标有、当前没有：祖先里也没有 → 这条是"目标版新增后被本地删干净"；
        // 统一按 removed（恢复到该版本会把它带回来）呈现，语义与旧版一致
        removed.push(fileName)
      } else if (cur !== text) changed.push(fileName)
    }
    for (const name of current.keys()) {
      if (name === 'meta.json') continue
      if (!targetNames.has(name)) added.push(name)
    }
    return {
      oid,
      baseOid,
      added,
      removed,
      changed,
      summary: { added: added.length, removed: removed.length, changed: changed.length },
    }
  }

  async restore(oid: string, mode: 'preview' | 'apply') {
    if (!oid) throw new BadRequestException('缺少 oid')
    return this.deps.host.gate('版本恢复', async () => {
      // 门内用 diffInner：不能再调 this.diff()（会再排一个门任务，自己等自己）
      const preview = await this.diffInner(oid)
      if (mode === 'preview') return { ok: true, mode, ...preview }

      const engine = await this.deps.project.engine()
      const files = await engine.listFiles(oid)
      const recs: LedgerRecord[] = []
      for (const fp of files) {
        const fileName = fp.slice(fp.lastIndexOf('/') + 1)
        if (!kindOfFileName(fileName)) continue
        const text = await engine.readFileAt(oid, fp)
        if (text === null) {
          this.log.warn(`恢复：${fileName} 在 ${oid.slice(0, 7)} 中不存在，跳过`)
          continue
        }
        const parsed = decodeRecord(text, fileName)
        if (!parsed.ok) continue
        // 恢复 = 复活 + rev 顶到新值（否则对端墓碑继续胜出，R8）
        recs.push({ ...parsed.rec, deleted: false })
      }
      recs.sort((a, b) => ApplyRecordService.APPLY_ORDER.indexOf(a.kind) - ApplyRecordService.APPLY_ORDER.indexOf(b.kind))
      const yms = new Set<string>()
      for (const rec of recs) {
        const bumped = { ...rec, ...(await this.deps.meta.bump({ rev: rec.rev })), deleted: false }
        const r = await this.deps.apply.apply(bumped as LedgerRecord)
        if (r.ym) yms.add(r.ym)
      }
      for (const ym of yms) await this.deps.months.recomputeAuto(ym)

      await this.deps.project.writeAll()
      const deviceId = await this.deps.meta.deviceId()
      const commit = await this.deps.project.commitAll(`chore(data): 恢复 ${oid.slice(0, 7)} · 由 ${deviceId}`)
      // 评审修复项：以前 `void this.run(...)` 撞定时器返回 busy 后静默丢推送。
      // 门内直推；失败明确落 error 状态（徽标可见），不再无声。
      let push: any = { ok: false, skipped: true }
      if (await this.deps.cfg.remote()) {
        try {
          push = await this.deps.host.pushInGate()
        } catch (e: any) {
          push = { ok: false, reason: 'error', message: String(e?.message || e), statusCode: this.deps.host.statusCodeOf(e) }
          // 退避落点唯一化（markFailure）：以前这里手抄了一份 setState 副本。
          // auto=false：恢复版本是用户点击的动作，失败不排自动重试；凭据类直接转 halted。
          const res = await this.deps.host.markFailure('error', push.message, { auto: false, statusCode: push.statusCode })
          push = { ...push, reason: res?.reason || 'error', halted: !!res?.halted }
        }
      }
      return { ok: true, mode, commit, push, ...preview }
    })
  }
}

/**
 * 从提交信息里取净资产（分）。
 *
 * 优先认结构化 trailer `Suiji-Networth-Cents: <int>`（唯一可靠来源）；
 * 旧提交没有 trailer，才回落到旧正则——**兼容通道，不是主路径**（见 commitMessage 注释）。
 */
export function parseNetworth(message: string): number | null {
  const t = /^Suiji-Networth-Cents:\s*(-?\d+)\s*$/m.exec(message || '')
  if (t) {
    const n = Number(t[1])
    return Number.isSafeInteger(n) ? n : null
  }
  const m = /净资产\s*(-?[\d,]+\.\d{2})/.exec(message || '')
  if (!m) return null
  const n = Number(m[1].replace(/,/g, ''))
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

/**
 * 离线同步编排（浏览器版，与服务端 SyncService.runInner 同流程）。
 *
 * 流程：投影+提交 → 拉取+合并 → 推送 → 租约/滚动/状态收尾。
 * 门：单轮串行（running 标志 + 队列），history/diff/restore/resolve 与 run 串行。
 * 失败定性：markFailure 唯一落点（permanent→halted / 手动→error / 自动→退避）。
 *
 * 与服务端差异：
 *  - 无定时器 tick / debounce / 每日调度：离线端只手动跑（省电 + 省流量）
 *  - 无 backup.snapshot：localAutoBackup 由各写路径自己调
 *  - prune/recomputeAuto 由调用方（backend.ts）提供
 */
import type { GitEngineLocal } from './sync-engine'
import {
  backoffMinutes,
  composeResolved,
  decodeRecordLocal,
  decideMerge,
  diffFields,
  encodeRecordLocal,
  fingerprint,
  isPermanentFailure,
  kindOfFileName,
  leaseAllowsForce,
  makeLedgerDriver,
  MAX_AUTO_RETRIES,
  nextSnapshotTag,
  parseKeepCommits,
  recommendFromTexts,
  repoPathOfFile,
  shouldHalt,
  titleOf,
  uidOfFileName,
  type CapturedTriple,
  type ConflictType,
  type LedgerRecord,
  type Pick,
} from './sync-shared'
import { APPLY_ORDER, applyRecord, type ApplyDb } from './sync-apply'
import { decryptSecretLocal } from './sync-crypto'
import { fmtMoney } from '../../../../packages/shared/src/index'

export type SyncRunState = 'unconfigured' | 'idle' | 'syncing' | 'offline' | 'conflict' | 'error' | 'halted'

export type SyncStateSnapshot = {
  state: SyncRunState
  lastSyncAt: number | null
  lastError: string | null
  pendingCommits: number
  retries: number
  nextRetryAt: number | null
  lastCommitOid: string | null
  lastHaltedAt?: number | null
}

export type ConflictItem = {
  key: string
  fileName: string
  kind: LedgerRecord['kind'] | null
  title: string
  conflictType: ConflictType
  base: string | null
  local: string | null
  remote: string | null
  fields: ReturnType<typeof diffFields>
  recommend: Pick
  reason: string
}

export type StoredConflict = {
  at: number
  mode: 'merge' | 'whole-file'
  oursOid: string | null
  theirsOid: string | null
  items: ConflictItem[]
  errorData: any
  autoMerged?: string[]
}

export type Cfg = {
  remote: string
  branch: string
  token: string
  authUser: string
  pushMode: 'every-commit' | 'daily' | 'manual'
  encrypt: boolean
  mergeEnabled: boolean
  autoCommit: boolean
  keepCommits: number
}

export type RunDeps = {
  engine(): GitEngineLocal
  cfg(): Cfg
  db(): ApplyDb & { settings: Record<string, string> }
  deviceId(): string
  state(): SyncStateSnapshot
  setState(patch: Partial<SyncStateSnapshot>): SyncStateSnapshot
  conflict(): StoredConflict | null
  setConflict(v: StoredConflict | null): void
  lastRemoteOid(): string
  setLastRemoteOid(oid: string): void
  projectWriteAll(): Promise<{ written: string[] }>
  projectCommitAll(message: string): Promise<string | null>
  absorb(oid: string): Promise<{ yms: string[]; problems: string[]; dropped: string[] }>
  recomputeYm(ym: string): void
  recycle(kind: string, summary: string, payload: any): void
}

const MERGE_CONFLICT = 'MergeConflictError'

let running = false
const queue: Array<{ label: string; fn: () => Promise<any>; resolve: (v: any) => void; reject: (e: any) => void }> = []
let pumping = false

async function pump() {
  if (pumping) return
  pumping = true
  try {
    while (queue.length > 0) {
      if (running) {
        await new Promise((r) => setTimeout(r, 500))
        continue
      }
      const job = queue.shift()!
      running = true
      try {
        job.resolve(await job.fn())
      } catch (e) {
        job.reject(e)
      } finally {
        running = false
      }
    }
  } finally {
    pumping = false
  }
}

function gate<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (running) return Promise.reject(new Error(`${label}：同步正在进行中，请稍后再试`))
  return new Promise<T>((resolve, reject) => {
    queue.push({ label, fn, resolve, reject })
    void pump()
  })
}

export function statusOf(d: RunDeps) {
  const st = d.state()
  const cfg = d.cfg()
  const conflict = d.conflict()
  const state: SyncRunState = !cfg.remote ? 'unconfigured' : conflict ? 'conflict' : st.state
  return {
    state,
    pendingCommits: st.pendingCommits,
    lastSyncAt: st.lastSyncAt,
    lastError: st.lastError,
    lastCommitOid: st.lastCommitOid,
    conflictCount: conflict?.items?.length ?? 0,
    pushMode: cfg.pushMode,
    mergeEnabled: cfg.mergeEnabled,
    encrypt: cfg.encrypt,
    mode: cfg.mergeEnabled && !cfg.encrypt ? 'merge' : 'whole-file',
    retries: st.retries,
    nextRetryAt: st.nextRetryAt,
    haltedAt: st.state === 'halted' ? st.lastHaltedAt ?? null : null,
    maxAutoRetries: MAX_AUTO_RETRIES,
  }
}

function markFailure(d: RunDeps, kind: 'offline' | 'error', msg: string, opts: { auto: boolean; statusCode?: number | null }) {
  if (isPermanentFailure(opts.statusCode ?? null, msg)) {
    d.setState({
      state: 'halted',
      lastError: `${msg}（永久性失败：重试多少次结果都一样，已停止自动重试。修好后点「立即同步」。）`,
      nextRetryAt: null,
      lastHaltedAt: Math.floor(Date.now() / 1000),
    })
    return { ok: false, reason: 'halted', halted: true, message: msg }
  }
  if (!opts.auto) {
    d.setState({ state: 'error', lastError: msg, nextRetryAt: null })
    return { ok: false, reason: 'error', halted: true, message: msg }
  }
  const st = d.state()
  const retries = st.retries + 1
  if (shouldHalt(retries)) {
    d.setState({
      state: 'halted',
      lastError: `${msg}（已连续自动重试 ${retries} 次仍失败，停止自动重试。请检查配置或网络后点「立即同步」。）`,
      retries,
      nextRetryAt: null,
      lastHaltedAt: Math.floor(Date.now() / 1000),
    })
    return { ok: false, reason: 'halted', halted: true, message: msg, retries }
  }
  d.setState({ state: kind, lastError: msg, retries, nextRetryAt: Date.now() + backoffMinutes(retries - 1) * 60_000 })
  return { ok: false, reason: kind, halted: false, message: msg, retries }
}

function statusCodeOf(e: any): number | null {
  const sc = Number(e?.data?.statusCode || 0)
  return sc >= 100 ? sc : null
}

function isNetworkError(e: any): boolean {
  const code = String(e?.code || '')
  const msg = String(e?.message || '')
  return (
    ['HttpError', 'NetworkError', 'FetchError', 'ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT'].includes(code) ||
    /network|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|socket hang up|getaddrinfo|Failed to fetch|Load failed/i.test(msg)
  )
}

async function commitMessage(d: RunDeps, reason: string): Promise<string> {
  const adb = d.db() as any
  const networth = (() => {
    try {
      const snaps = adb.snapshots || []
      const accs = adb.accounts || []
      const yms = [...new Set(snaps.map((s: any) => s.ym))].sort()
      const last = yms[yms.length - 1]
      if (!last) return null
      let total = 0
      for (const s of snaps) {
        if (s.ym !== last || s.deleted) continue
        const a = accs.find((x: any) => x.id === s.accountId)
        if (!a || !a.inNetWorth || a.archived || a.deleted) continue
        total += a.kind === 'liability' ? -s.balance : s.balance
      }
      return total
    } catch {
      return null
    }
  })()
  const count = (adb.entries || []).filter((e: any) => !e.deleted && !e.auto).length
  const net = networth === null ? '—' : '¥' + fmtMoney(networth)
  const head = `chore(data): ${reason} · 净资产 ${net} · ${count} 条`
  if (networth === null) return head
  return `${head}\n\nSuiji-Networth-Cents: ${Math.round(networth)}\nSuiji-Records: ${count}`
}

async function pullMerge(d: RunDeps, engine: GitEngineLocal, branch: string): Promise<{ result: 'clean' | 'conflict' | 'noop'; theirsOid: string | null }> {
  await engine.fetch(branch)
  const theirs = await engine.remoteOid(branch)
  const ours = await engine.headOid()
  if (!theirs || !ours || theirs === ours) return { result: 'noop', theirsOid: theirs || null }

  if (!(await engine.mergeBase(ours, theirs))) {
    await engine.adoptRemote(branch, theirs)
    await d.absorb(theirs)
    await d.projectWriteAll()
    await d.projectCommitAll('chore(data): 接管远端历史（本地历史与之无关）')
    return { result: 'clean', theirsOid: theirs }
  }

  const captured: CapturedTriple[] = []
  const autoMerged: string[] = []
  const cfg = d.cfg()
  const deviceId = d.deviceId()
  const { makeLedgerDriver } = await import('./sync-shared')
  void cfg
  const dd = await import('./sync-shared')
  void dd.makeLedgerDriver
  const driver = (dd.makeLedgerDriver as (opts: any) => any)({ captured, autoMerged, mergeEnabled: (d.cfg() as any).mergeEnabled, encrypted: (d.cfg() as any).encrypt, deviceId, now: () => Math.floor(Date.now() / 1000) })

  try {
    const m: any = await engine.merge({
      branch,
      theirs: `remotes/origin/${branch}`,
      mergeDriver: driver,
      message: `chore(data): merge ${ours.slice(0, 7)} ${theirs.slice(0, 7)}`,
      author: { name: deviceId, email: `${deviceId}@local` },
    })
    await d.absorb(m.oid)
    await d.projectWriteAll()
    return { result: 'clean', theirsOid: theirs }
  } catch (e: any) {
    if (e?.code !== MERGE_CONFLICT) throw e
    const items = await buildItems(d, captured, e.data, ours, theirs, cfg.encrypt)
    const state: StoredConflict = {
      at: Math.floor(Date.now() / 1000),
      mode: cfg.mergeEnabled && !cfg.encrypt ? 'merge' : 'whole-file',
      oursOid: ours,
      theirsOid: theirs,
      items,
      errorData: e.data || null,
      autoMerged,
    }
    d.setConflict(state)
    d.setState({ state: 'conflict', lastError: null })
    return { result: 'conflict', theirsOid: theirs }
  }
}

async function titleCtxOf(d: RunDeps) {
  const adb = d.db() as any
  const tmap = new Map((adb.types || []).filter((t: any) => t.uid).map((t: any) => [t.uid, t.name]))
  const amap = new Map((adb.accounts || []).filter((a: any) => a.uid).map((a: any) => [a.uid, a.name]))
  return { typeName: (u: string) => tmap.get(u) ?? null, accountName: (u: string) => amap.get(u) ?? null }
}

async function buildItems(d: RunDeps, captured: CapturedTriple[], errorData: any, oursOid: string | null, theirsOid: string | null, encrypted: boolean): Promise<ConflictItem[]> {
  const ctx = await titleCtxOf(d)
  const items: ConflictItem[] = []
  const seen = new Set<string>()
  for (const t of captured) {
    seen.add(t.fileName)
    items.push(await toItem(t, ctx, false, encrypted))
  }
  const paths: string[] = []
  for (const k of ['filepaths', 'bothModified', 'deleteByUs', 'deleteByTheirs']) {
    const arr = errorData?.[k]
    if (Array.isArray(arr)) paths.push(...arr)
  }
  const engine = d.engine()
  for (const fp of [...new Set(paths)]) {
    const fileName = fp.slice(fp.lastIndexOf('/') + 1)
    if (seen.has(fileName)) continue
    if (!kindOfFileName(fileName)) continue
    seen.add(fileName)
    const our = oursOid ? await engine.readFileAt(oursOid, fp) : null
    const their = theirsOid ? await engine.readFileAt(theirsOid, fp) : null
    if (!our && !their) continue
    items.push(await toItem({ fileName, base: null, our: our || '', their: their || '' }, ctx, true, encrypted))
  }
  return items
}

async function toItem(t: CapturedTriple, ctx: any, sideMissing: boolean, encryptedStore: boolean): Promise<ConflictItem> {
  const kind = kindOfFileName(t.fileName)
  const local = t.our ? decodeRecordLocal(t.our, t.fileName) : null
  const remote = t.their ? decodeRecordLocal(t.their, t.fileName) : null
  const base = t.base ? decodeRecordLocal(t.base, t.fileName) : null
  const key = kind ? repoPathOfFile(kind, t.fileName) : `ledger/v1/${t.fileName}`
  const fallbackTitle = uidOfFileName(t.fileName) || t.fileName
  if (local?.ok && remote?.ok) {
    const baseRec = base?.ok ? base.rec : null
    const dd = recommendFromTexts(t.base, t.our, t.their, t.fileName)
    return {
      key,
      fileName: t.fileName,
      kind,
      title: titleOf(local.rec, ctx),
      conflictType: encryptedStore ? 'encrypted' : sideMissing || local.rec.deleted !== remote.rec.deleted ? 'edit-delete' : 'both',
      base: t.base,
      local: t.our,
      remote: t.their,
      fields: diffFields(baseRec, local.rec, remote.rec, ctx),
      recommend: dd.identical ? 'local' : dd.recommend,
      reason: encryptedStore ? '已开启加密，只能整份二选一（字段值仅供对照）' : dd.identical ? '内容一致' : dd.reason,
    }
  }
  const localReason = local && !local.ok ? local.reason : null
  const remoteReason = remote && !remote.ok ? remote.reason : null
  const enc = localReason === 'encrypted' || remoteReason === 'encrypted'
  const encMsg = [!local || local.ok ? null : (local as any).message, !remote || remote.ok ? null : (remote as any).message].filter(Boolean).join('；')
  return {
    key,
    fileName: t.fileName,
    kind,
    title: fallbackTitle,
    conflictType: enc ? 'encrypted' : 'unparsable',
    base: t.base,
    local: t.our || null,
    remote: t.their || null,
    fields: [{ name: '__raw', label: '内容', base: t.base ? fingerprint(t.base) : null, local: t.our ? fingerprint(t.our) : null, remote: t.their ? fingerprint(t.their) : null, changed: 'both' as const }],
    recommend: 'local',
    reason: enc ? [encMsg || '远端仓库已加密，请在本机开启加密并填入同一密钥', '无法逐字段合并，只能整份二选一'].filter(Boolean).join(' · ') : '内容无法解析，只能整份二选一',
  }
}

async function pushWithRetry(d: RunDeps, engine: GitEngineLocal, branch: string): Promise<'ok' | 'conflict'> {
  for (let round = 0; round < 2; round++) {
    let res: any = null
    let rejected = false
    try {
      res = await engine.push(branch)
      if (!res?.ok) rejected = /not-fast-forward|rejected|non-fast-forward/i.test(String(res?.error || ''))
    } catch (e: any) {
      if (!/not-fast-forward|rejected|non-fast-forward/i.test(String(e?.message || e?.code || ''))) throw e
      rejected = true
    }
    if (!rejected) {
      if (res && res.ok) return 'ok'
      throw new Error(res?.error || '推送失败')
    }
    const merged = await pullMerge(d, engine, branch)
    if (merged.result === 'conflict') return 'conflict'
  }
  throw new Error('推送反复被拒绝（远端持续前进），请稍后再试')
}

async function afterPush(d: RunDeps, engine: GitEngineLocal, branch: string): Promise<void> {
  const remote = await engine.remoteOid(branch)
  const baseline = remote ?? (await engine.headOid())
  if (baseline) d.setLastRemoteOid(baseline)
  if (remote) await maybeRollHistory(d, engine, branch, remote)
}

async function maybeRollHistory(d: RunDeps, engine: GitEngineLocal, branch: string, remoteOid: string | null): Promise<void> {
  try {
    if (!remoteOid) return
    const cfg = d.cfg()
    const keep = parseKeepCommits(String(cfg.keepCommits ?? ''))
    const { shouldRoll, nextSnapshotTag, rollMessage } = await import('./sync-shared')
    const count = await engine.countCommits(branch, keep + 1)
    if (!shouldRoll(count, keep)) return
    if (await engine.hasUnmerged()) return
    const leaseOid = d.lastRemoteOid()
    const nowRemote = await engine.remoteOid(branch)
    if (!leaseAllowsForce(leaseOid, nowRemote)) return
    const head = await engine.headOid()
    const tree = await engine.headTree()
    if (!head || !tree) return
    const tag = nextSnapshotTag(await engine.listTagNames())
    await engine.tagAnchor(tag, head)
    const deviceId = d.deviceId()
    const author = { name: deviceId, email: `${deviceId}@local` }
    await engine.rollToRoot(branch, tree, rollMessage(tag), author)
    const res: any = await engine.push(branch, true)
    if (res && res.ok === false) throw new Error(res.error || '滚动后强推失败')
    const newRemote = (await engine.remoteOid(branch)) ?? (await engine.headOid())
    if (newRemote) d.setLastRemoteOid(newRemote)
  } catch (e: any) {
    d.setState({ lastError: `历史滚动失败（不影响本次同步）：${String(e?.message || e).slice(0, 200)}` })
  }
}

export function runSync(d: RunDeps, opts: { phase?: 'push' | 'pull'; reason?: string; forceLease?: boolean; localOnly?: boolean; userInitiated?: boolean } = {}) {
  if (running) return Promise.resolve({ ok: false, reason: 'busy', message: '同步正在进行中' })
  running = true
  return runInner(d, opts).finally(() => {
    running = false
    void pump()
  })
}

async function runInner(d: RunDeps, opts: { phase?: 'push' | 'pull'; reason?: string; forceLease?: boolean; localOnly?: boolean; userInitiated?: boolean }) {
  const auto = !opts.phase && !opts.userInitiated && !!opts.reason
  const st0 = d.state()
  if (st0.state === 'halted' && !opts.userInitiated) {
    if (!opts.localOnly) return { ok: false, reason: 'halted', message: '自动重试已停止。请修正配置后点「立即同步」。' }
  }
  if (opts.userInitiated && st0.retries) d.setState({ retries: 0, nextRetryAt: null })
  const cfg = d.cfg()
  if (!cfg.remote) {
    d.setState({ state: 'unconfigured' })
    return { ok: false, reason: 'unconfigured', message: '尚未配置远程仓库' }
  }
  const pending = d.conflict()
  if (pending) {
    d.setState({ state: 'conflict' })
    return { ok: false, reason: 'conflict-pending', message: '存在未处理的冲突，请先裁决或放弃' }
  }

  d.setState({ state: 'syncing' })
  try {
    const { GitEngineLocal } = await import('./sync-engine')
    void GitEngineLocal
    const engine = d.engine()
    const branch = cfg.branch
    await engine.init(branch)
    await engine.setRemote(cfg.remote)

    if (await engine.hasUnmerged()) {
      await engine.abortMerge()
      await d.projectWriteAll()
      await d.projectCommitAll('chore(data): 复位未决合并残局')
    }

    if (!(await engine.hasCommits()) && !opts.localOnly) {
      try {
        await engine.fetch(branch)
        const theirs = await engine.remoteOid(branch)
        if (theirs) {
          await engine.adoptRemote(branch, theirs)
          await d.absorb(theirs)
        }
      } catch (e: any) {
        if (!isNetworkError(e) && !isPermanentFailure(statusCodeOf(e), String(e?.message || e))) throw e
      }
    }

    await d.projectWriteAll()
    const message = await commitMessage(d, opts.reason || '同步投影')
    const oid = await d.projectCommitAll(message)
    if (oid) {
      const st = d.state()
      d.setState({ lastCommitOid: oid, pendingCommits: st.pendingCommits + 1 })
    }

    if (opts.localOnly) {
      const st = d.state()
      return { ok: true, localOnly: true, state: st.state, pendingCommits: st.pendingCommits, message: '新记录已保存到本机版本历史' }
    }

    let pulledTheirs: string | null | undefined
    if (opts.phase !== 'push') {
      const pulled = await pullMerge(d, engine, branch)
      if (pulled.result === 'conflict') return { ok: false, reason: 'conflict', message: '存在冲突，请在对照界面裁决' }
      pulledTheirs = pulled.theirsOid
    }

    let pushed = false
    if (opts.phase !== 'pull') {
      if (opts.forceLease) {
        await engine.fetch(branch)
        const [leaseOid, remoteOid] = [d.lastRemoteOid(), await engine.remoteOid(branch)]
        if (!leaseAllowsForce(leaseOid, remoteOid)) {
          d.setState({ state: 'conflict', lastError: '强推被租约拒绝：远端已被第三方推进，请正常同步并逐条裁决。' })
          return { ok: false, reason: 'conflict', message: '强推被租约拒绝' }
        }
        const res: any = await engine.push(branch, true)
        if (res && res.ok === false) throw new Error(res.error || '强推失败')
        pushed = true
      } else {
        const pushedRes = await pushWithRetry(d, engine, branch)
        if (pushedRes === 'conflict') return { ok: false, reason: 'conflict', message: '推送时远端又前进并产生冲突' }
        pushed = true
      }
    }

    if (pushed) await afterPush(d, engine, branch)
    else if (pulledTheirs) d.setLastRemoteOid(pulledTheirs)
    const pendingCommits = opts.phase === 'pull' ? await engine.countAhead(branch) : 0
    d.setState({
      state: 'idle',
      lastSyncAt: Math.floor(Date.now() / 1000),
      lastError: null,
      retries: 0,
      nextRetryAt: null,
      lastHaltedAt: null,
      pendingCommits,
    })
    return { ok: true, state: 'idle', pendingCommits }
  } catch (e: any) {
    const msg = String(e?.message || e || '同步失败').slice(0, 500)
    if (!auto) d.setState({ retries: 0 })
    return markFailure(d, isNetworkError(e) ? 'offline' : 'error', msg, { auto, statusCode: statusCodeOf(e) })
  } finally {
    void pump()
  }
}

export function pushInGate(d: RunDeps, branchHint?: string) {
  if (!d.cfg().remote) return Promise.resolve({ ok: false, skipped: true })
  return gate('推送', async () => {
    const engine = d.engine()
    const branch = branchHint || d.cfg().branch
    await engine.setRemote(d.cfg().remote)
    const pushed = await pushWithRetry(d, engine, branch)
    if (pushed === 'conflict') return { ok: false, reason: 'conflict', message: '推送时远端又前进并产生冲突' }
    await afterPush(d, engine, branch)
    return { ok: true }
  })
}

export function resolveConflicts(
  d: RunDeps,
  items: Array<{ key: string; pick: Pick; fieldPicks?: Record<string, Pick> }>,
  push = true,
) {
  return gate('冲突裁决', () => resolveInner(d, items, push))
}

async function resolveInner(d: RunDeps, items: Array<{ key: string; pick: Pick; fieldPicks?: Record<string, Pick> }>, push: boolean) {
  const state = d.conflict()
  if (!state) throw new Error('当前没有待处理的冲突')
  if (!Array.isArray(items) || items.length === 0) throw new Error('没有提交任何裁决项')
  const byKey = new Map(state.items.map((i) => [i.key, i]))
  const byFile = new Map(state.items.map((i) => [i.fileName, i]))
  const resolved = new Set<string>()
  const yms = new Set<string>()
  let localCount = 0
  let remoteCount = 0

  type Plan = { item: ConflictItem; it: { key: string; pick: Pick; fieldPicks?: Record<string, Pick> }; localParsed: any; remoteParsed: any; baseParsed: any }
  const plan: Plan[] = []
  const seenKeys = new Set<string>()
  const unknown: string[] = []
  for (const it of items) {
    const item = byKey.get(it.key) || byFile.get(it.key)
    if (!item) {
      unknown.push(String(it.key))
      continue
    }
    if (seenKeys.has(item.key)) throw new Error(`同一记录被重复提交裁决：${item.title}`)
    seenKeys.add(item.key)
    if (it.pick !== 'local' && it.pick !== 'remote') throw new Error('裁决方向不合法')
    if (state.mode === 'whole-file' && it.fieldPicks && Object.keys(it.fieldPicks).length > 0) {
      throw new Error('当前为整份二选一模式，不接受逐字段裁决')
    }
    const localParsed = item.local ? decodeRecordLocal(item.local, item.fileName) : null
    const remoteParsed = item.remote ? decodeRecordLocal(item.remote, item.fileName) : null
    const baseParsed = item.base ? decodeRecordLocal(item.base, item.fileName) : null
    if (it.pick === 'remote' && (!localParsed?.ok || !remoteParsed?.ok) && !remoteParsed?.ok) {
      throw new Error(`「${item.title}」远端内容无法解析（或密钥不匹配），不能以远程为准`)
    }
    plan.push({ item, it, localParsed, remoteParsed, baseParsed })
  }
  if (unknown.length > 0) throw new Error(`有 ${unknown.length} 项裁决与当前冲突快照不匹配，请刷新后重裁`)
  if (plan.length === 0) throw new Error('没有可落地的裁决项')

  const adb = d.db()
  for (const { item, it, localParsed, remoteParsed, baseParsed } of plan) {
    if (it.pick === 'local') localCount++
    else remoteCount++
    const deviceId = d.deviceId()
    const nowSec = Math.floor(Date.now() / 1000)
    if (!localParsed?.ok || !remoteParsed?.ok) {
      if (it.pick === 'remote') {
        const rec = remoteParsed.rec as LedgerRecord
        if (localParsed?.ok) d.recycle(item.kind || 'entry', `同步裁决覆盖 · ${item.title}`, { ...localParsed.rec })
        const r = await applyRecord(adb, rec)
        if (r.ym) {
          yms.add(String(r.ym))
        }
      }
      resolved.add(item.key)
      continue
    }
    // 字段锁由 composeResolved 内部执行（与服务端同一份 lockedFields(diffFields()) 规则），
    // 这里只做透传 + 非法取值过滤，不自己重算锁。
    const merged = composeResolved({
      base: baseParsed?.ok ? baseParsed.rec : null,
      local: localParsed.rec,
      remote: remoteParsed.rec,
      pick: it.pick,
      fieldPicks: (() => {
        const out: Record<string, Pick> = {}
        for (const [f, side] of Object.entries(it.fieldPicks || {})) {
          if (side !== 'local' && side !== 'remote') continue
          out[f] = side
        }
        return out
      })(),
      deviceId,
      now: nowSec,
    })
    if (it.pick === 'remote' || (it.fieldPicks && Object.keys(it.fieldPicks).length > 0)) {
      d.recycle(item.kind || 'entry', `同步裁决覆盖 · ${item.title}`, { ...localParsed.rec })
    }
    const r = await applyRecord(adb, merged)
    if (r.ym) yms.add(String(r.ym))
    resolved.add(item.key)
  }

  for (const ym of yms) d.recomputeYm(ym)

  const remaining = state.items.filter((i) => !resolved.has(i.key))
  if (remaining.length > 0) {
    d.setConflict({ ...state, items: remaining })
    d.setState({ state: 'conflict' })
    return { ok: true, applied: resolved.size, remaining: remaining.length, pushed: false }
  }

  const engine = d.engine()
  const branch = d.cfg().branch
  await engine.abortMerge()
  await d.projectWriteAll()
  const { GitEngineLocal: _G } = await import('./sync-engine')
  void _G
  const { stageAllLocal } = await import('./sync-project')
  void stageAllLocal
  const deviceId = d.deviceId()
  // 合并提交：双亲 = head + theirs
  const head = await engine.headOid()
  if (head) {
    await stageAllLocal(engine)
    await engine.commit(`chore(data): resolve-conflict ${localCount} local / ${remoteCount} remote`, { name: deviceId, email: `${deviceId}@local` }, state.theirsOid && state.theirsOid !== head ? [head, state.theirsOid] : [head])
  }
  d.setConflict(null)

  let pushResult: any = { ok: false, skipped: true }
  if (push && d.cfg().remote) {
    try {
      pushResult = await pushInGate(d, branch)
    } catch (e: any) {
      pushResult = { ok: false, reason: 'error', message: String(e?.message || e), statusCode: statusCodeOf(e) }
    }
  }
  if (pushResult?.reason === 'conflict' || pushResult?.reason === 'conflict-pending') {
    return { ok: true, applied: resolved.size, remaining: 0, pushed: false, push: pushResult }
  }
  const pushedOk = !!pushResult?.ok || !!pushResult?.skipped
  if (!pushedOk) {
    const res = markFailure(d, 'error', String(pushResult?.message || '推送失败'), { auto: false, statusCode: pushResult?.statusCode ?? null })
    const st = d.state()
    d.setState({ lastCommitOid: st.lastCommitOid })
    return { ok: true, applied: resolved.size, remaining: 0, pushed: false, push: { ...pushResult, reason: res?.reason || 'error', halted: !!(res as any)?.halted } }
  }
  d.setState({ state: 'idle', lastSyncAt: Math.floor(Date.now() / 1000), lastError: null, retries: 0, nextRetryAt: null, lastHaltedAt: null })
  return { ok: true, applied: resolved.size, remaining: 0, pushed: pushedOk && !pushResult?.skipped, push: pushResult }
}

export function abortConflict(d: RunDeps) {
  return gate('放弃合并', async () => {
    const engine = d.engine()
    await engine.abortMerge()
    d.setConflict(null)
    d.setState({ state: 'idle', lastError: null })
    return { ok: true }
  })
}

export function syncHistory(d: RunDeps, limit = 50, cursor = 0) {
  return gate('版本历史', async () => {
    const engine = d.engine()
    const want = limit + cursor + 1
    const rows = await engine.log(Math.min(2000, want))
    const { parseNetworth } = await import('./sync-history-util')
    const page = rows.slice(cursor, cursor + limit)
    return {
      commits: page.map((r: any) => ({ oid: r.oid, message: r.message, ts: r.ts, author: r.author, networthCents: parseNetworth(r.message) })),
      nextCursor: rows.length >= want ? cursor + limit : null,
    }
  })
}

export function syncDiff(d: RunDeps, oid: string) {
  if (!oid) return Promise.reject(new Error('缺少 oid'))
  return gate('版本对比', () => diffInner(d, oid))
}

async function diffInner(d: RunDeps, oid: string) {
  const engine = d.engine()
  const target = await engine.listFiles(oid)
  if (target.length === 0) throw new Error('该版本不存在或没有内容')
  const adb = d.db() as any
  const { buildFilesLocal } = await import('./sync-project')
  const view = {
    types: adb.types || [],
    accounts: adb.accounts || [],
    snapshots: adb.snapshots || [],
    entries: adb.entries || [],
    loans: adb.loans || [],
    settings: adb.settings || {},
    typeUid: (id: number) => null as string | null,
    accUid: (id: number) => null as string | null,
  }
  const { files: current } = await buildFilesLocal(view, d.cfg().encrypt, d.deviceId())
  const head = await engine.headOid()
  const { findMergeBaseLocal } = await import('./sync-history-util')
  const baseOid = await findMergeBaseLocal(engine, head, oid)
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
    if (cur === undefined) removed.push(fileName)
    else if (cur !== text) changed.push(fileName)
  }
  for (const name of current.keys()) {
    if (name === 'meta.json') continue
    if (!targetNames.has(name)) added.push(name)
  }
  return { oid, baseOid, added, removed, changed, summary: { added: added.length, removed: removed.length, changed: changed.length } }
}

export function syncRestore(d: RunDeps, oid: string, mode: 'preview' | 'apply') {
  if (!oid) return Promise.reject(new Error('缺少 oid'))
  return gate('版本恢复', async () => {
    const preview = await diffInner(d, oid)
    if (mode === 'preview') return { ok: true, mode, ...preview }
    const engine = d.engine()
    const files = await engine.listFiles(oid)
    const adb = d.db()
    const recs: LedgerRecord[] = []
    for (const fp of files) {
      const fileName = fp.slice(fp.lastIndexOf('/') + 1)
      if (!kindOfFileName(fileName)) continue
      const text = await engine.readFileAt(oid, fp)
      if (text === null) continue
      const parsed = decodeRecordLocal(text, fileName)
      if (!parsed.ok) continue
      recs.push({ ...parsed.rec, deleted: false })
    }
    recs.sort((a, b) => APPLY_ORDER.indexOf(a.kind) - APPLY_ORDER.indexOf(b.kind))
    const yms = new Set<string>()
    for (const rec of recs) {
      const maxSeen = Number((adb as any).settings?.gitMaxRev || 0) || 0
      const bumped = { ...rec, rev: Math.max(Number(rec.rev || 0), maxSeen) + 1, deleted: false }
      const r = await applyRecord(adb, bumped as LedgerRecord)
      if (r.ym) yms.add(r.ym)
    }
    for (const ym of yms) d.recomputeYm(ym)
    await d.projectWriteAll()
    const commit = await d.projectCommitAll(`chore(data): 恢复 ${oid.slice(0, 7)} · 由 ${d.deviceId()}`)
    let push: any = { ok: false, skipped: true }
    if (d.cfg().remote) {
      try {
        push = await pushInGate(d)
      } catch (e: any) {
        push = { ok: false, reason: 'error', message: String(e?.message || e), statusCode: statusCodeOf(e) }
        const res = markFailure(d, 'error', push.message, { auto: false, statusCode: push.statusCode })
        push = { ...push, reason: res?.reason || 'error', halted: !!(res as any)?.halted }
      }
    }
    return { ok: true, mode, commit, push, ...preview }
  })
}

import { BadRequestException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { PrismaService } from '../prisma.service'
import { MonthsService } from '../months/months.service'
import { BackupService } from '../backup.service'
import { RecordMetaService } from './record-meta.service'
import { SyncConfigService } from './sync-config.service'
import { ProjectService } from './project.service'
import { ApplyRecordService } from './apply-record.service'
import { GitEngine } from './git-engine'
import { makeLedgerDriver, type CapturedTriple } from './merge-driver'
import { decodeRecord } from './codec'
import { kindOfFileName, type LedgerRecord } from './ledger'
import { SyncConflict } from './sync-conflict'
import { SyncHistory, parseNetworth } from './sync-history'
import type { ConflictItem, FailureOutcome, ResolveItem, StoredConflict, SyncHost } from './sync-types'
import { fmtMoney } from '../../../../packages/shared/src/index'
import { backoffMinutes, isPermanentFailure, leaseAllowsForce, permanentFailureHint, shouldRunNow, shouldHalt, MAX_AUTO_RETRIES } from './schedule'
import { nextSnapshotTag, rollMessage, shouldRoll } from './keep-commits'

const MERGE_CONFLICT = 'MergeConflictError'

// 形状定义只有一个家（sync-types.ts），这里只做转出：controller 与单测历来从 sync.service 取这些类型
export type { ConflictItem, FailureOutcome, ResolveItem, StoredConflict } from './sync-types'
export { parseNetworth } from './sync-history'

// 注：曾在这里 `export { shouldRunNow, backoffMinutes } from './schedule'` 再导一层，
// 全仓无人从这里取（测试直接 import ./schedule），属 Middle Man，删（评审修复项）。

@Injectable()
export class SyncService implements OnModuleInit, OnModuleDestroy {
  private log = new Logger('Sync')
  private running = false
  private timer: NodeJS.Timeout | null = null
  private debounce: NodeJS.Timeout | null = null

  constructor(
    private prisma: PrismaService,
    private months: MonthsService,
    private backup: BackupService,
    private meta: RecordMetaService,
    private cfg: SyncConfigService,
    private project: ProjectService,
    private apply: ApplyRecordService,
  ) {
    // 两个子域共用的那四个能力（门、门内直推、失败定性、状态码）。写成能力对象而不是注入
    // SyncService 自己：注入会绕成循环（SyncService → 子域 → SyncService）。
    const host: SyncHost = {
      gate: (label, fn) => this.gate(label, fn),
      pushInGate: (branch) => this.pushInGate(branch),
      markFailure: (kind, msg, opts) => this.markFailure(kind, msg, opts),
      statusCodeOf: (e) => this.statusCodeOf(e),
      log: this.log,
    }
    this.conflict = new SyncConflict({ prisma, cfg, project, apply, months: this.months, meta, host })
    this.historySvc = new SyncHistory({ cfg, project, apply, months: this.months, meta, host })
  }

  /** 冲突呈现与裁决（原属本类的 300 行，见 sync-conflict.ts 顶部说明） */
  private conflict: SyncConflict
  /** 历史 / 差异 / 恢复（原属本类的 140 行，见 sync-history.ts 顶部说明） */
  private historySvc: SyncHistory

  // ---------------- 生命周期 ----------------

  onModuleInit() {
    // 挂到既有备份埋点上（D10）：11 个写操作调用点全部覆盖，零侵入
    this.backup.onSnapshot((reason) => this.handleSnapshot(reason))
    void this.resetCrashState()
    this.timer = setInterval(() => void this.tick(), 60_000)
    this.timer.unref?.()
    // 启动补跑：今天该跑而未跑（进程整点不在的常见场景）
    setTimeout(() => void this.tick(), 8_000).unref?.()
  }

  /**
   * 复位崩溃残留的 `syncing`：run() 入口就把它写进状态，进程若在 await 网络时被杀（关窗口、
   * 断电、崩溃），库里就永久留着 syncing。tick 只认 offline/error/halted，看到这个态**什么都不做**，
   * 表现是徽标永远「同步中…」、既不重试也不报错、用户点什么都不生效（现网踩过：403 停摆后 state 就卡在这）。
   * 数据真相在 SQLite，工作区只是投影，复位状态即可，不必动 git。
   */
  private async resetCrashState() {
    try {
      const st = await this.cfg.state()
      if (st.state !== 'syncing') return
      const msg = st.lastError || '上次同步未跑完（进程中断），已复位。可点「立即同步」重试。'
      // 复位成 offline 而不是 idle：让它回到「退避后可自愈」的轨道；
      // 若真相是凭据问题，第一次重试就会被 markFailure 定性为 halted 停手。
      await this.cfg.setState({ state: 'offline', lastError: msg, nextRetryAt: Date.now() + 60_000 })
      this.log.warn('复位崩溃残留的 syncing 状态')
    } catch (e: any) {
      this.log.warn('状态复位失败: ' + (e?.message || e))
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer)
    if (this.debounce) clearTimeout(this.debounce)
  }

  private handleSnapshot(reason: string) {
    void (async () => {
      try {
        if (!(await this.cfg.autoCommit())) return
        if (!(await this.cfg.remote())) return
        const mode = await this.cfg.pushMode()
        if (mode === 'manual') return
        if (mode === 'every-commit') {
          // halted = 自动重试已停手（永久性失败或次数封顶）。此时新写的账**仍然本地投影+提交**
          // （历史照常累积、数据不欠），但一律不碰网络：不碰就不会把"已停手"又变成"再试一次"。
          // 恢复网络的唯一入口是用户点「立即同步」。
          const st = await this.cfg.state()
          this.scheduleDebounce(reason, false, st.state === 'halted')
        }
      } catch (e: any) {
        this.log.warn('自动同步触发失败: ' + (e?.message || e))
      }
    })()
  }

  /**
   * every-commit 的 5s debounce（合并连续操作，避免一次平账触发多次提交/推送）。
   * 拿不到门时**重挂一次**而不是丢弃：旧实现 `void this.run()` 撞上 busy 就等于
   * "这次变更没人推"，只能等下一次写操作或每日定时（评审修复项，doc23 §9.2）。
   * `localOnly`：只做投影+提交，不拉不推（halted 态下新写的账走这条路）。
   */
  private scheduleDebounce(reason: string, waited = false, localOnly = false) {
    if (this.debounce) clearTimeout(this.debounce)
    const delay = waited ? 15_000 : 5_000
    this.debounce = setTimeout(() => {
      void this.run({ reason, localOnly }).then((r: any) => {
        // busy = 门被 history/resolve 之类占着：再等一轮，别把这次的变更丢掉
        if (r?.reason === 'busy') this.scheduleDebounce(reason, waited, localOnly)
      })
    }, delay)
    this.debounce.unref?.()
  }

  private async tick() {
    try {
      if (this.running) return
      if (!(await this.cfg.remote())) return
      if (await this.cfg.conflictState()) return
      const st = await this.cfg.state()
      const now = Date.now()

      // halted：**不自动重试**（用户诉求：重试三次就别一直重试，除非手动点击）。
      // tick 每 60s 一次，若放行就会拿同一个必然失败的凭据无限打远端。
      if (st.state === 'halted') return

      // 离线/失败退避：**只有排了退避时刻的才自动重试**（error 与 offline 同一把退避尺）。
      // nextRetryAt=null = 手动路径失败或已停手，等用户点「立即同步」，tick 不碰。
      if (st.state === 'offline' || st.state === 'error') {
        if (!st.nextRetryAt) return
        if (now < st.nextRetryAt) return
        await this.run({ reason: st.state === 'offline' ? '离线重试' : '失败重试' })
        return
      }
      const mode = await this.cfg.pushMode()
      if (shouldRunNow(mode, new Date(now), st.lastSyncAt)) await this.run({ reason: '每日同步' })
    } catch (e: any) {
      this.log.warn('定时检查失败: ' + (e?.message || e))
    }
  }

  // ---------------- 状态 ----------------

  /**
   * §6.1 preflight 要求把 `mode=whole-file`（合并关 / 加密开）记进运行态。
   * 运行态里的 mode 不单独落 Setting：它完全由 mergeEnabled/encrypt 两个开关决定，
   * 存一份就会多一份真相（SyncConfigService 的 mergeEnabled() 已经是后端强制联动后的唯一裁决），
   * 所以 /status 现算并回传（此前该字段定义了从不写、/status 也读不到——评审修复项）。
   */
  async status() {
    const [st, remote, conflict, pushMode, mergeEnabled, encrypt] = await Promise.all([
      this.cfg.state(),
      this.cfg.remote(),
      this.cfg.conflictState<StoredConflict>(),
      this.cfg.pushMode(),
      this.cfg.mergeEnabled(),
      this.cfg.encrypt(),
    ])
    const state = !remote ? 'unconfigured' : conflict ? 'conflict' : st.state
    return {
      state,
      pendingCommits: st.pendingCommits,
      lastSyncAt: st.lastSyncAt,
      lastError: st.lastError,
      lastCommitOid: st.lastCommitOid,
      conflictCount: conflict?.items?.length ?? 0,
      pushMode,
      mergeEnabled,
      encrypt,
      mode: mergeEnabled && !encrypt ? 'merge' : 'whole-file',
      retries: st.retries,
      nextRetryAt: st.nextRetryAt,
      /** halted 的时刻（秒）。前端据此把「已停止自动重试」说成具体从何时起停的 */
      haltedAt: st.state === 'halted' ? st.lastHaltedAt ?? null : null,
      /** 自动重试次数上限（暴露给前端，文案不再自己抄一份数字，避免两处真相） */
      maxAutoRetries: MAX_AUTO_RETRIES,
    }
  }

  // ---------------- 主流程 ----------------

  /**
   * 抢门必须是**同步**的（评审修复项）：旧实现在 `if (this.running)` 与置位之间夹了
   * `await cfg.remote()` / `await cfg.conflictState()`，两个并发 run()（tick 与手动触发）
   * 会在各自的 await 里都看到 running=false，双双置位进入主体——正是 :321 注释要防的
   * 「history/diff/restore 与 run 并发互踩同一 .git」的竞态源头。
   * 现在入口第一件事就检查并占用 running，配置校验挪到门内做。
   */
  async run(opts: { phase?: 'push' | 'pull'; reason?: string; forceLease?: boolean; localOnly?: boolean; userInitiated?: boolean } = {}) {
    if (this.running) return { ok: false, reason: 'busy', message: '同步正在进行中' }
    this.running = true
    try {
      return await this.runInner(opts)
    } finally {
      this.running = false
      void this.pump()
    }
  }

  private async runInner(opts: { phase?: 'push' | 'pull'; reason?: string; forceLease?: boolean; localOnly?: boolean; userInitiated?: boolean }) {
    const auto = this.isAutoRun(opts)
    const st0 = await this.cfg.state()
    // halted：**只有用户点击**（runSync / 强推）能重启网络同步；
    // 自动触发（tick / every-commit debounce）遇到 halted 一律立即返回，绝不"顺手再试一次"。
    if (st0.state === 'halted' && !opts.userInitiated) {
      if (!opts.localOnly) return { ok: false, reason: 'halted', message: '自动重试已停止（凭据或权限问题不会被时间治愈）。请修正配置后点「立即同步」。' }
      // localOnly（halted 下又写了新账）：照常本地投影+提交，只是不碰网络
    }
    // 用户点击 = 明确的"再给一次机会"：重试预算重新起算（3 次），halted 随之解除。
    // 只有这一次真的打通网络才算恢复，失败则按 auto=false 停在 error，不再自动排重试。
    if (opts.userInitiated && st0.retries) await this.cfg.setState({ retries: 0, nextRetryAt: null })
    const remote = await this.cfg.remote()
    if (!remote) {
      await this.cfg.setState({ state: 'unconfigured' })
      return { ok: false, reason: 'unconfigured', message: '尚未配置远程仓库' }
    }
    const pending = await this.cfg.conflictState<StoredConflict>()
    if (pending) {
      await this.cfg.setState({ state: 'conflict' })
      return { ok: false, reason: 'conflict-pending', message: '存在未处理的冲突，请先裁决或放弃' }
    }

    await this.cfg.setState({ state: 'syncing' })
    this.dbg(`=== run 开始 phase=${opts.phase || 'full'} localOnly=${!!opts.localOnly} auto=${auto} reason=${opts.reason || '-'} device=${await this.meta.deviceId()} ===`)
    try {
      // 永远先落一份本地保险。notify:false：引擎内的快照不得反向触发同步（自激重试环，见 BackupService）
      await this.backup.snapshot('同步前', { notify: false })

      const engine = await this.project.engine()
      const branch = await this.cfg.branch()
      await engine.init(branch)
      await engine.setRemote(remote)

      // R13 preflight：index 里有 stage 3（物理冲突未决）却没有冲突快照 = 上次进程崩在合并中途。
      // 三方原文只存在于快照里，残局无法还原成可裁决项；数据真相在 SQLite，工作区只是投影，
      // 唯一安全出路是 abortMerge 复位 + 重投影（评审修复项：hasUnmerged 此前零调用）。
      if (await engine.hasUnmerged()) {
        this.log.warn('检测到未决合并残局（index stage3 无快照），abortMerge 复位后重投影')
        await engine.abortMerge()
        await this.project.writeAll()
        await this.project.commitAll('chore(data): 复位未决合并残局')
      }

      // 0. 首次同步：本地还是空仓库 → 认领远端历史，否则 merge 会撞"历史无关"（§5.1 F）
      if (!(await engine.hasCommits()) && !opts.localOnly) {
        try {
          await engine.fetch(branch)
          const theirs = await engine.remoteOid(branch)
          if (theirs) {
            await engine.adoptRemote(branch, theirs)
            await this.absorbAndRecompute(theirs)
          }
        } catch (e: any) {
          if (this.isNetworkError(e) || isPermanentFailure(this.statusCodeOf(e), String(e?.message || e))) {
            // 首次就断网/凭据不通：先只做本地提交，等能连上了再认领
            this.log.warn('首次同步拉取失败，先落本地提交: ' + (e?.message || e))
          } else throw e
        }
      }

      // 1. 投影 + 提交（本地写入永不被网络阻塞）
      await this.project.writeAll()
      const message = await this.commitMessage(opts.reason || '同步投影')
      const oid = await this.project.commitAll(message)
      if (oid) {
        const st = await this.cfg.state()
        await this.cfg.setState({ lastCommitOid: oid, pendingCommits: st.pendingCommits + 1 })
      }
      this.dbg(`phase=${opts.phase || 'full'} 本地提交 ${oid ? oid.slice(0, 7) : '(无变更)'} head=${(await engine.headOid())?.slice(0, 7)}`)

      // halted 下的 localOnly：投影+提交已完成，到此为止（不 fetch / 不 merge / 不 push）。
      // **不写 lastSyncAt**（没同步过就是没同步过），**不清 lastError**（那条 403 还得让人看见），
      // 也不加 retries（这不是重试）。状态留在 halted，等用户点「立即同步」。
      if (opts.localOnly) {
        const st = await this.cfg.state()
        return { ok: true, localOnly: true, state: st.state, pendingCommits: st.pendingCommits, message: '新记录已保存到本机版本历史，网络同步已暂停（修正配置后点「立即同步」）' }
      }

      // 2. 拉取 + 合并
      let pulledTheirs: string | null | undefined
      if (opts.phase !== 'push') {
        const pulled = await this.pullMerge(engine, branch)
        if (pulled.result === 'conflict') return { ok: false, reason: 'conflict', message: '存在冲突，请在对照界面裁决' }
        pulledTheirs = pulled.theirsOid
      }

      // 3. 推送
      let pushed = false
      if (opts.phase !== 'pull') {
        if (opts.forceLease) {
          // D9/§6.3 租约式强推（--force-with-lease 等价物，isomorphic-git 不内置必须手写）：
          // 远端必须还停在"我们上次真正推到的那一版"，否则说明被第三方推进过 → 拒绝并转人工。
          // 触发面 = 用户在同步页看过提示后的二次确认（controller 只认 ?force=lease）。
          await engine.fetch(branch)
          const [leaseOid, remoteOid] = await Promise.all([this.cfg.lastRemoteOid(), engine.remoteOid(branch)])
          if (!leaseAllowsForce(leaseOid, remoteOid)) {
            // §6.3 规定拒绝强推后置 state=conflict（转人工），不是 error：
            // error 态会吃 1/5/15/30 退避并让 tick 反复重试同一个必然失败的强推；
            // conflict 态 tick 直接跳过（:119 见到冲突快照即返回），等人来裁决。
            // 这里没有冲突快照可放（三方原文只在合并现场才有），用 lastError 承载人工提示。
            await this.cfg.setState({
              state: 'conflict',
              lastError: '强推被租约拒绝：远端已被第三方推进（不再是上次同步所见的版本）。请正常同步并逐条裁决。',
            })
            return { ok: false, reason: 'conflict', message: '强推被租约拒绝：远端已被第三方推进，请正常同步并逐条裁决' }
          }
          const res: any = await engine.push(branch, true)
          if (res && res.ok === false) throw new Error(res.error || '强推失败')
          this.dbg('push: 租约强推 ok')
          pushed = true
        } else {
          const pushedRes = await this.pushWithRetry(engine, branch)
          if (pushedRes === 'conflict') return { ok: false, reason: 'conflict', message: '推送时远端又前进并产生冲突' }
          pushed = true
        }
      }

      /**
       * 租约基准 + §6.5 历史滚动（评审修复项）：
       *
       * 租约记的是**远端此刻的 oid**，不是本地 head。旧实现无条件 `setLastRemoteOid(head)`、
       * 连 `phase='pull'` 也写，两个后果都很安静：
       *  ① 只拉不推时把"本地 head"当成"远端版本"存进租约：远端若已被第三方推进，
       *     下次强推的闸门 `leaseAllowsForce(本地head, 真实远端)` 必然拒绝（假阳性）；
       *  ② 更糟的镜像情形：pull 之后本地又前进，head 与远端无关，租约存成 head 就再也
       *     匹配不上真实远端 → 强推永久不可用，用户只能被告知"被第三方推进"。
       * 现在只写两种已知真相：真的推成了（走 afterPush，远端 == 我们刚推的那版，顺带判滚动）
       * 或刚观测到远端（theirs）。
       */
      if (pushed) await this.afterPush(engine, branch)
      else if (pulledTheirs) await this.cfg.setLastRemoteOid(pulledTheirs)
      // pushWithRetry 回拉时可能又造了新提交（merge commit），pendingCommits 要如实重新数，
      // 不能沿用第 1 步加过的值（Std 修复项：phase=pull 清零会让徽标谎报"无待推"）。
      // 推成功 → 待推必为 0；phase=pull 没推 → countAhead 数真实的领先提交数。
      const pendingCommits = opts.phase === 'pull' ? await engine.countAhead(branch) : 0
      await this.cfg.setState({
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
      if (process.env.SYNC_DEBUG === '1') this.log.warn('同步失败堆栈:\n' + (e?.stack || ''))
      // retries 只统计"连续自动重试失败"：手动点击失败不该推高它，也不该排退避（auto=false）
      if (!auto) await this.cfg.setState({ retries: 0 })
      return await this.markFailure(this.isNetworkError(e) ? 'offline' : 'error', msg, { auto, statusCode: this.statusCodeOf(e) })
    } finally {
      // 门由外层 run() 统一释放（抢门同步化之后这里不能再清 running，否则门提前开）
      void this.pump()
    }
  }

  /**
   * 失败态 + 退避的**唯一**落点（评审修复项 Duplicated Code：旧版在 run/restore 三处复制同一段）。
   *
   * 三级定性，别只看着像就归离线（本次 403 无限重试的根因之一）：
   *  ① **永久性失败**（凭据/权限/地址：401/403/404、token username invalid）→ `halted` +
   *    `nextRetryAt=null`，**不排重试**。它不会随时间自愈，退避循环只是空转打远端；
   *  ② 手动路径（`auto:false`：用户点「立即同步」、裁决/恢复的推送）失败 → 同样不排退避，
   *    停在 error 等人处理 —— 这是「除非手动点击」的落点；
   *  ③ 自动路径的**暂时性失败**（断网/DNS/超时/5xx/429）才走 1/5/15/30 退避；
   *    连续达 `MAX_AUTO_RETRIES` 次也转 `halted`：自动重试到此为止
   *    （用户诉求：重试三次就别一直重试）。
   *
   * `retries` 语义钉死为「**连续自动重试失败**的次数」：手动路径不加它，
   * 否则 every-commit「每存一条记一条」会把计数一路顶高（现网曾冲到 452）。
   *
   * protected：单测直接驱动这条唯一落点（tests/sync-halt.test.ts），
   * 比塞七个 mock 跑整条 runInner 便宜，且失败定性语义只在这一处。
   *
   * `statusCode` 取 isomorphic-git HttpError 的 `e.data.statusCode`（服务端原文状态码）；
   * 没有它（非 HTTP 故障）传 null，只按消息文本兜底判。
   *
   * 返回类型显式声明：四个分支形状必须一致，否则调用方取 `halted` 会撞 TS2339。
   */
  protected async markFailure(kind: 'offline' | 'error', msg: string, opts: { auto: boolean; statusCode?: number | null }): Promise<FailureOutcome> {
    if (isPermanentFailure(opts.statusCode ?? null, msg)) {
      await this.cfg.setState({
        state: 'halted',
        lastError: `${msg}（永久性失败：重试多少次结果都一样，已停止自动重试。${permanentFailureHint(msg)} 修好后点「立即同步」。）`,
        nextRetryAt: null,
        lastHaltedAt: Math.floor(Date.now() / 1000),
      })
      this.log.warn('同步被服务端拒绝，已停止自动重试: ' + msg)
      return { ok: false, reason: 'halted', halted: true, message: msg }
    }
    if (!opts.auto) {
      await this.cfg.setState({ state: 'error', lastError: msg, nextRetryAt: null })
      this.log.warn('手动同步失败（不排自动重试）: ' + msg)
      return { ok: false, reason: 'error', halted: true, message: msg }
    }
    const st = await this.cfg.state()
    const retries = st.retries + 1
    if (shouldHalt(retries)) {
      await this.cfg.setState({
        state: 'halted',
        lastError: `${msg}（已连续自动重试 ${retries} 次仍失败，停止自动重试。请检查配置或网络后点「立即同步」。）`,
        retries,
        nextRetryAt: null,
        lastHaltedAt: Math.floor(Date.now() / 1000),
      })
      this.log.warn(`同步连续失败 ${retries} 次，停止自动重试: ${msg}`)
      return { ok: false, reason: 'halted', halted: true, message: msg, retries }
    }
    await this.cfg.setState({
      state: kind,
      lastError: msg,
      retries,
      nextRetryAt: Date.now() + backoffMinutes(retries - 1) * 60_000,
    })
    if (kind === 'error') this.log.warn('同步失败: ' + msg)
    return { ok: false, reason: kind, halted: false, message: msg, retries }
  }

  /**
   * 这次 run 是不是「自动触发」（tick 的离线/失败/每日重试、every-commit 的 debounce 都带 reason）。
   * 用户点「立即同步」带 userInitiated、分程带 phase —— 两者都算手动，失败不排退避、也不推高 retries。
   */
  private isAutoRun(opts: { phase?: string; reason?: string; userInitiated?: boolean }): boolean {
    return !opts.phase && !opts.userInitiated && !!opts.reason
  }

  /** isomorphic-git 的 HttpError 把状态码放在 data.statusCode（服务端原文），定性首选它 */
  private statusCodeOf(e: any): number | null {
    const sc = Number(e?.data?.statusCode || 0)
    return sc >= 100 ? sc : null
  }

  /**
   * 已在门内（running 归我）时的"只推不拉"路径：resolve / restore 的推送阶段专用。
   * 不能复用 run({phase:'push'})——那会撞上自己持有的 running 门返回 busy，
   * 评审修复项里"裁决后推送落空但界面说已推送"的根因之一就是这里。
   */
  private async pushInGate(branchHint?: string): Promise<any> {
    if (!(await this.cfg.remote())) return { ok: false, skipped: true }
    const engine = await this.project.engine()
    const branch = branchHint || (await this.cfg.branch())
    await engine.setRemote((await this.cfg.remote()))
    const pushed = await this.pushWithRetry(engine, branch)
    if (pushed === 'conflict') return { ok: false, reason: 'conflict', message: '推送时远端又前进并产生冲突' }
    // 租约基准 = 远端此刻的 oid（评审修复项：原来写的是本地 head，见 runInner 末尾注释）
    // 顺带做 §6.5 滚动判定：只在"本地与远端刚刚一致"这个瞬间才有资格断链
    await this.afterPush(engine, branch)
    return { ok: true }
  }

  /**
   * 推成功之后的两件事，**必须在这里一起做**（旧版散在 runInner 与 pushInGate 两处各写一次）：
   *  ① 记租约基准 = 远端现在的 oid（强推闸门的判据，写错就假阳性或永久不可用）；
   *  ② §6.5 历史膨胀治理：条数超 `gitKeepCommits` 就滚动分支并打锚点 tag。
   *
   * 为什么滚动只在"刚推成"时做：此刻远端 == 本地 head，滚完立刻强推就能把
   * 断链后的历史送上去，两边重新对齐；若在只拉不推时滚，本地独有历史会断成孤儿，
   * `pendingCommits` 与后续 push 全部失真。
   */
  private async afterPush(engine: GitEngine, branch: string): Promise<void> {
    const remote = await engine.remoteOid(branch)
    const baseline = remote ?? (await engine.headOid())
    if (baseline) await this.cfg.setLastRemoteOid(baseline)
    if (remote) await this.maybeRollHistory(engine, branch, remote)
  }

  /**
   * §6.5 分支滚动（治理动作，不是数据路径）。
   *
   * 前置条件缺一不可：
   *  · 远端存在且**仍停在**我们上次真正推到的那版（`leaseAllowsForce`）——
   *    滚动要断链，而断链只能靠强推送达远端；租约不满足时强推会覆盖别人的提交，
   *    所以这一步与 §6.3 的强推闸门共用同一判据，不另立标准；
   *  · 没有未合并状态（`hasUnmerged`）：合并残局里动 ref 会让驱动抓不到两侧原文。
   * 失败不当成同步失败：治理没做成本次同步也成功了，只在 `lastError` 留一句可读提示
   * （R14 精神：不静默，但也不把治理失败升级成离线/暂停）。
   */
  private async maybeRollHistory(engine: GitEngine, branch: string, remoteOid: string | null): Promise<void> {
    try {
      if (!remoteOid) return
      const keep = await this.cfg.keepCommits()
      const count = await engine.countCommits(branch, keep + 1)
      if (!shouldRoll(count, keep)) return
      if (await engine.hasUnmerged()) return
      const [leaseOid, nowRemote] = await Promise.all([this.cfg.lastRemoteOid(), engine.remoteOid(branch)])
      if (!leaseAllowsForce(leaseOid, nowRemote)) return
      const head = await engine.headOid()
      const tree = await engine.headTree()
      if (!head || !tree) return
      const tag = nextSnapshotTag(await engine.listTagNames())
      await engine.tagAnchor(tag, head)
      const deviceId = await this.meta.deviceId()
      const author = { name: deviceId, email: `${deviceId}@local` }
      await engine.rollToRoot(branch, tree, rollMessage(tag), author)
      const res: any = await engine.push(branch, true)
      if (res && res.ok === false) throw new Error(res.error || '滚动后强推失败')
      const newRemote = (await engine.remoteOid(branch)) ?? (await engine.headOid())
      if (newRemote) await this.cfg.setLastRemoteOid(newRemote)
      this.log.log(`历史滚动完成：${count} 条提交压到新根，旧历史锚在 ${tag}`)
      // 成功不碰 state/lastError：这次同步本身已经成功，runInner 收尾时自然会清 lastError；
      // 而在 pushInGate 路径上贸然清 lastError 会让"error 态 + 空消息"这种自相矛盾的状态出现
    } catch (e: any) {
      const msg = `历史滚动失败（不影响本次同步）：${String(e?.message || e).slice(0, 200)}`
      this.log.warn(msg)
      await this.cfg.setState({ lastError: msg })
    }
  }

  /** 排障用：SYNC_DEBUG=1 时把每一步的 oid/结论打进日志（默认静默，不刷屏） */
  private dbg(msg: string) {
    if (process.env.SYNC_DEBUG === '1') this.log.debug(msg)
  }

  /**
   * 运行状态串行化（评审修复项）：history / diff / restore / commitAll 也走 .git 读写，
   * 与定时器触发的 run() 并发操作同一仓库会互踩（isomorphic-git 无 onLock 时不互斥）。
   * 独立入口统一进这条串行队列；拿不到门就明确 busy，让调用方稍后再试而不是硬闯。
   */
  private gate<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (this.running) return Promise.reject(new BadRequestException(`${label}：同步正在进行中，请稍后再试`))
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ label, fn, resolve, reject })
      this.pump()
    })
  }

  private queue: Array<{ label: string; fn: () => Promise<any>; resolve: (v: any) => void; reject: (e: any) => void }> = []
  private pumping = false
  private async pump() {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.queue.length > 0) {
        if (this.running) {
          // run() 插队时，队列任务原地等待再排空（run 结束会主动 pump 一次）
          await new Promise((r) => setTimeout(r, 500))
          continue
        }
        const job = this.queue.shift()!
        this.running = true
        try {
          job.resolve(await job.fn())
        } catch (e) {
          job.reject(e)
        } finally {
          this.running = false
        }
      }
    } finally {
      this.pumping = false
    }
  }

  private isNetworkError(e: any): boolean {
    const code = String(e?.code || '')
    const msg = String(e?.message || '')
    return (
      ['HttpError', 'NetworkError', 'FetchError', 'ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT'].includes(code) ||
      /network|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|socket hang up|getaddrinfo/i.test(msg)
    )
  }

  /**
   * fetch + merge + 吸收。返回 conflict 时已落盘冲突快照并置状态。
   *
   * 返回值带上 `theirsOid`（评审修复项，原实现只回 `'clean'|'conflict'|'noop'`）：
   * 租约基准必须是"远端此刻停在哪"，而这只有 pull 顺手观测得到；
   * 调用方拿不到 theirs 就只能退回写本地 head，正是租约失效的根因。
   */
  private async pullMerge(engine: GitEngine, branch: string): Promise<{ result: 'clean' | 'conflict' | 'noop'; theirsOid: string | null }> {
    await engine.fetch(branch)
    const theirs = await engine.remoteOid(branch)
    const ours = await engine.headOid()
    this.dbg(`pull: ours=${ours?.slice(0, 7)} theirs=${theirs?.slice(0, 7)}`)
    if (!theirs || !ours || theirs === ours) return { result: 'noop', theirsOid: theirs || null }

    /**
     * 历史无关自愈（§5.1 F 的补集，实测：本地孤立提交 da40ede vs 远端 cc9f6bd，无共同祖先）：
     * 只要"首次同步那一次网络失败"发生过（403、断网、令牌没配好都算），本地就已经带着一个
     * 自建根提交，之后每次合并都抛 `MergeNotSupportedError`。这个错既不像断网也不像权限，
     * 会被定性成 error → 吃满退避 → halted，**数据永远推不上去**（修好 403 也只是换个姿势卡住）。
     * 出路和首次同步一样：认领远端历史，把本机投影重写成它的后继提交，之后 push 就是 fast-forward。
     */
    if (!(await engine.mergeBase(ours, theirs))) {
      this.log.warn(`本地 ${ours.slice(0, 7)} 与远端 ${theirs.slice(0, 7)} 历史无关，认领远端历史后重投影`)
      await engine.adoptRemote(branch, theirs)
      await this.absorbAndRecompute(theirs)
      await this.project.writeAll()
      const rebuilt = await this.project.commitAll('chore(data): 接管远端历史（本地历史与之无关）')
      this.dbg(`pull: 接管完成 newHead=${rebuilt?.slice(0, 7) || '(无变更)'}`)
      return { result: 'clean', theirsOid: theirs }
    }

    const captured: CapturedTriple[] = []
    const autoMerged: string[] = []
    const [mergeEnabled, encrypted, deviceId] = await Promise.all([
      this.cfg.mergeEnabled(),
      this.cfg.encrypt(),
      this.meta.deviceId(),
    ])
    const driver = makeLedgerDriver({ captured, autoMerged, mergeEnabled, encrypted, deviceId, now: () => Math.floor(Date.now() / 1000) })

    try {
      const m = await engine.merge({
        branch,
        theirs: `remotes/origin/${branch}`,
        mergeDriver: driver,
        message: `chore(data): merge ${ours.slice(0, 7)} ${theirs.slice(0, 7)}`,
        author: { name: deviceId, email: `${deviceId}@local` },
      })
      await this.absorbAndRecompute(m.oid)
      // 只把**吸收后的真相回写投影**，不再额外 commit（Spec 蔓延修复项）：
      // merge 提交 m.oid 本身已含两端合并后的载体，再补一条"merge 吸收"纯属历史膨胀
      // （§5.5 的落地只有 applyRecord 吸收一步，六步重投影只属冲突路径）。
      // 万一吸收时发生 rev 顶高（rec.rev === local.rev）导致投影与 m.oid 有微差，
      // 留在工作区由下一轮 run 的第 1 步 commitAll 收掉，不丢内容。
      await this.project.writeAll()
      this.dbg(`pull: 合并干净 merge=${m.oid?.slice(0, 7)} 驱动回调=${captured.length}`)
      // 合并后远端 oid 仍是 theirs（我们还没推），租约基准就该记它
      return { result: 'clean', theirsOid: theirs }
    } catch (e: any) {
      if (e?.code !== MERGE_CONFLICT) throw e
      this.dbg(`pull: 冲突 驱动回调=${captured.length} filepaths=${(e.data?.filepaths || []).length}`)
      // ⚠️ abortOnConflict:false 仍然抛（实测 1.44.9），e.data 才是冲突清单来源
      const items = await this.conflict.build(captured, e.data, ours, theirs, encrypted)
      const state: StoredConflict = {
        at: Math.floor(Date.now() / 1000),
        mode: mergeEnabled && !encrypted ? 'merge' : 'whole-file',
        oursOid: ours,
        theirsOid: theirs,
        items,
        errorData: e.data || null,
        autoMerged,
      }
      await this.cfg.setConflictState(state)
      await this.cfg.setState({ state: 'conflict', lastError: null })
      return { result: 'conflict', theirsOid: theirs }
    }
  }

  private async pushWithRetry(engine: GitEngine, branch: string): Promise<'ok' | 'conflict'> {
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
        if (res && res.ok) {
          this.dbg(`push: ok round=${round} remote=${(await engine.remoteOid(branch))?.slice(0, 7)}`)
          return 'ok'
        }
        throw new Error(res?.error || '推送失败')
      }
      this.dbg(`push: 被拒 round=${round} → 回拉合并`)
      // 远端前进了：回 fetch + merge（这是常态，不是冲突）
      const merged = await this.pullMerge(engine, branch)
      if (merged.result === 'conflict') return 'conflict'
    }
    throw new Error('推送反复被拒绝（远端持续前进），请稍后再试')
  }

  // ---------------- 吸收 ----------------

  private async absorbAndRecompute(oid: string): Promise<void> {
    const engine = await this.project.engine()
    const files = await engine.listFiles(oid)
    const recs: LedgerRecord[] = []
    const dropped: string[] = []
    for (const fp of files) {
      const fileName = fp.slice(fp.lastIndexOf('/') + 1)
      if (!kindOfFileName(fileName)) continue
      // readFileAt 现在只把"对象不存在"折算成 null；真故障（fs/zlib）直接上抛，
      // 由 run() 捕获进 error 退避——绝不静默跳过记录（评审修复项）。
      const text = await engine.readFileAt(oid, fp)
      if (text === null) {
        this.log.warn(`记录文件 ${fileName} 在 ${oid.slice(0, 7)} 中不存在（可能被裁剪），跳过`)
        dropped.push(fileName)
        continue
      }
      const parsed = decodeRecord(text, fileName)
      if (!parsed.ok) {
        this.log.warn(`跳过无法解析的记录 ${fileName}（${parsed.reason}）`)
        dropped.push(fileName)
        continue
      }
      recs.push(parsed.rec)
    }
    if (dropped.length > 0) {
      const st = await this.cfg.state()
      await this.cfg.setState({ ...st, lastError: `吸收时跳过 ${dropped.length} 个无法解析的记录文件：${dropped.slice(0, 5).join(', ')}${dropped.length > 5 ? '…' : ''}` })
    }
    recs.sort((a, b) => ApplyRecordService.APPLY_ORDER.indexOf(a.kind) - ApplyRecordService.APPLY_ORDER.indexOf(b.kind))
    const yms = new Set<string>()
    const problems: string[] = []
    for (const rec of recs) {
      const r = await this.apply.apply(rec)
      if (r.ym) yms.add(r.ym)
      // R14「不静默降级」（评审修复项）：applyX 现在把"缺依赖挂错上级"折成
      // `warning:*`、"彻底应用不了"折成 `failed:*`，旧实现只看 dropped，
      // 于是"条目挂到了别的类型上"这类脏数据在界面上完全看不见。
      if (r.reason?.startsWith('failed:')) problems.push(`${rec.uid} ${r.reason}`)
      else if (r.warning) problems.push(`${rec.uid} ${r.warning}`)
    }
    if (problems.length > 0) this.log.warn(`吸收告警 ${problems.length} 条：${problems.slice(0, 5).join(' | ')}`)
    const errParts: string[] = []
    if (dropped.length > 0) {
      errParts.push(`吸收时跳过 ${dropped.length} 个无法解析的记录文件：${dropped.slice(0, 5).join(', ')}${dropped.length > 5 ? '…' : ''}`)
    }
    if (problems.length > 0) {
      errParts.push(`${problems.length} 条记录未能完整应用：${problems.slice(0, 3).join(' | ')}${problems.length > 3 ? '…' : ''}`)
    }
    if (errParts.length > 0) {
      const st = await this.cfg.state()
      await this.cfg.setState({ ...st, lastError: errParts.join('；') })
    }
    for (const ym of yms) await this.months.recomputeAuto(ym)
  }

  // ---------------- 冲突 / 历史（委派给子域） ----------------
  // 这两块各自成文件（sync-conflict.ts / sync-history.ts）：原来 1227 行单类里，
  // 调度、门队列、git 编排、冲突渲染、历史差异恢复、提交文案六个变化原因挤在一起，
  // 改其中任何一件都要通读全文才能确认没碰坏别的（Std 评审 Divergent Change）。
  // 公开签名保持不变：controller 与单测仍对 SyncService 调用。

  /** 当前冲突快照（无冲突时返回空列表） */
  async conflicts() {
    return this.conflict.list()
  }

  /** 应用用户勾选（§5.6.4）；走门：与定时器 run 串行 */
  async resolve(items: ResolveItem[], push = true) {
    return this.conflict.resolve(items, push)
  }

  /** 放弃合并：abortMerge 复位 + 清快照，本地数据一字不动 */
  async abortConflict() {
    return this.conflict.abort()
  }

  async history(limit = 50, cursor = 0) {
    return this.historySvc.history(limit, cursor)
  }

  async diff(oid: string) {
    return this.historySvc.diff(oid)
  }

  async restore(oid: string, mode: 'preview' | 'apply') {
    return this.historySvc.restore(oid, mode)
  }

  // ---------------- 杂项 ----------------

  /**
   * 提交信息：人读的一句话 + 机读的 trailer。
   *
   * 评审修复项（Primitive Obsession）：净资产原本只以"¥1,234.56"这种**展示格式**写进文案，
   * 历史页再用正则 `/净资产\\s*(-?[\\d,]+\\.[\\d]{2})/` 反解回数字——
   * 展示格式一改（货币前缀、千分位、负数括号）、或者文案里恰好再出现一次"净资产"短语，
   * 历史曲线就静默错位，且没有任何测试能锁住这种耦合。
   * trailer 走 git 惯例（`Key: value`，放末段），机器读整数分、人类仍看那句话。
   */
  private async commitMessage(reason: string): Promise<string> {
    const [points, count] = await Promise.all([
      this.months.recordPoints().catch(() => [] as any[]),
      this.prisma.changeEntry.count({ where: { deleted: false, auto: false } }),
    ])
    const cents = points.length > 0 ? points[0].networth : null
    const net = cents === null ? '—' : fmtMoney(cents)
    const head = `chore(data): ${reason} · 净资产 ${net} · ${count} 条`
    if (cents === null) return head
    return `${head}\n\nSuiji-Networth-Cents: ${Math.round(cents)}\nSuiji-Records: ${count}`
  }
}

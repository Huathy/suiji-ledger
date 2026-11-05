import path from 'node:path'
import { decideMerge, kindOfFileName, type ConflictType, type Pick } from './ledger'

/**
 * 冲突现场快照：**只装同步载体记录**（kindOfFileName 能识别的文件）。
 *
 * 非载体文件（.gitignore / meta.json / 未来新增的任何仓库杂项）一律不进这里——
 * 它们没有三方语义，进冲突界面只会产生"无法裁决的假条目"：
 * `SyncService.toConflictItem` 对 `kind === null` 会编一个 `ledger/v1/<fileName>` 的假 key，
 * 而 `resolveInner` 的预校验按 `repoPathOfFile(kind, fileName)` 找 key，两边永远对不上，
 * 用户勾了也被静默丢弃（评审修复项 c5 的一半）。
 */
export type CapturedTriple = {
  /** basename —— 驱动只拿得到这个（§1 `mergeDriver.path` 行） */
  fileName: string
  base: string | null
  our: string
  their: string
}

export type DriverOutcome = {
  cleanMerge: boolean
  mergedText: string
  /**
   * ⚠️ isomorphic-git 的 mergeTree 只消费 `{cleanMerge, mergedText}` 两个字段
   * （源码 8636/8871 行实测），这里多带的 meta 会被**原样丢弃**——保留它只为可读性：
   * 标出"驱动判过什么"，裁决预选由 buildConflictItems 走 recommendFromTexts 重算，两者互不依赖。
   * 曾试图借它给冲突界面传 recommend，不成立，别再往这个方向优化。
   */
  meta?: { conflictType: ConflictType; recommend: Pick; reason: string }
}

/**
 * 语义合并驱动（本方案的支点）。
 *
 * 三条必须遵守的实测约束：
 *  1. `path` 只有 basename → 判类只能靠文件名前缀（`e_/a_/s_/l_/t_/set_/meta`）。
 *  2. 驱动只在"两端都有该文件且都改过"时被调用；单端改动 git 直接取那端。
 *  3. 冲突时返回 `mergedText = our`：真相在 SQLite，工作区只是投影，
 *     返回远端内容会让本地投影被污染（下一次投影又会改回来，白折腾）。
 */
export function makeLedgerDriver(opts: {
  captured: CapturedTriple[]
  /** 驱动内被自动合并掉的**载体记录**（§5.6.2 "已自动合并 N 项可展开核对"的数据源；非载体文件不记） */
  autoMerged?: string[]
  mergeEnabled: boolean
  encrypted: boolean
  deviceId: string
  now: () => number
}) {
  return (args: { path: string; contents: string[]; branches?: string[] }): DriverOutcome => {
    const fileName = path.basename(String(args.path || ''))
    const contents = args.contents || []
    const base = contents[0] ?? ''
    const our = contents[1] ?? ''
    const their = contents[2] ?? ''

    // meta.json 是本端投影指纹，没有合并语义：永远取 ours
    if (fileName === 'meta.json') return { cleanMerge: true, mergedText: our }

    // 非载体文件在这里就分流掉，不进 decideMerge（判类只看前缀，见 CapturedTriple 注释）
    if (!kindOfFileName(fileName)) {
      /**
       * 非载体文件（.gitignore 之类）：保守取 ours + cleanMerge，且**不进 `captured`**。
       *
       * 为什么不能返回 cleanMerge:false：它会被当成冲突塞进对照界面，而对照界面只能裁决
       * "一条记录"，非载体文件根本没有可裁决的语义（详见上面 CapturedTriple 的注释）。
       *
       * 为什么取 ours 无害：本项目这类文件由工具链自己兜底生成，两端口径一致——
       * `GitEngine.init` 写初始 .gitignore，`ProjectService.ensureTmpIgnored` 每次投影补齐
       * tmp/ 条目；真正的规则来源是代码不是这个文件。丢掉"对方手工加的规则"是唯一的代价，
       * 而对方手改 .gitignore 后本端下一次投影/推送本来也会被重新生成盖掉（取舍：可丢规则，
       * 不可留一条谁也裁不掉的假冲突）。
       *
       * 不记入 opts.autoMerged：那是"已自动合并 N 项可展开核对"的数据源，指的都是载体记录；
       * 这里没有合并任何内容，只是取 ours 兜底，列进去只会给界面添噪音。
       */
      return { cleanMerge: true, mergedText: our }
    }

    const decision = decideMerge({
      baseText: base || null,
      ourText: our,
      theirText: their,
      fileName,
      mergeEnabled: opts.mergeEnabled,
      encrypted: opts.encrypted,
      deviceId: opts.deviceId,
      now: opts.now(),
    })

    if (decision.cleanMerge) {
      if (opts.autoMerged) opts.autoMerged.push(fileName)
      return { cleanMerge: true, mergedText: decision.mergedText }
    }

    // 冲突现场落盘用：崩溃/重启后 index 的 stage 读不出来（R11），只能靠这份快照
    opts.captured.push({ fileName, base: base || null, our, their })
    return {
      cleanMerge: false,
      mergedText: our,
      meta: { conflictType: decision.conflictType, recommend: decision.recommend, reason: decision.reason },
    }
  }
}

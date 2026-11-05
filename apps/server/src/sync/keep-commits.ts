/**
 * §6.5 历史膨胀治理的**决策**部分（纯函数，无 IO）。
 *
 * 为什么单独成文件：滚动是"要不要动历史"的判断题，最怕两件事——
 *  ① 阈值判错（多滚一次 = 白丢一条锚点链；少滚一次 = 历史无限长）；
 *  ② tag 序号撞车（两个设备各自数"下一个号"，写同一个 `snapshot-3` 就互相覆盖）。
 * 这两件都能用纯函数钉死并单测（R3 同款要求：判据要被测试锁定），
 * 操作 .git 的那步留给 GitEngine，不在测试里搭真仓库也能验判据。
 *
 * 旧版本这两条判据根本不存在（spec §6.5 与 §14「仍欠」都记着），
 * 于是 `gitKeepCommits` 是个只在文档里有效的开关。
 */

/** spec §6.5 的默认值：500 条提交 */
export const DEFAULT_KEEP_COMMITS = 500

/**
 * 下限 50：`gitKeepCommits=0/1` 会让每推一次就滚一次，
 * 每滚一次本地历史就与远端断链一次（对端得走 adoptRemote 重接）。
 * 这是"配置写错就把同步打成震荡"的形态，必须夹住而不是照用户填的数执行。
 */
export const MIN_KEEP_COMMITS = 50

/**
 * 解析设置值。空值/非数字/0 都回落默认值（不信任 Setting 表里的字符串），
 * 负数与小数一并归一（`Math.floor`）。
 */
export function parseKeepCommits(raw: string | null | undefined): number {
  const n = Math.floor(Number(String(raw ?? '').trim()))
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_KEEP_COMMITS
  return Math.max(MIN_KEEP_COMMITS, n)
}

/**
 * 该不该滚动：**严格大于**才滚。
 * 边界按"保留 keep 条"读：count=500 时历史正好是上限内，不该白滚一次
 * （滚动本身要写 tag、重建根提交、强推，代价不小，别在阈值上抖）。
 */
export function shouldRoll(count: number, keep: number): boolean {
  return count > keep
}

/** `snapshot-<n>` 里的 n；不像锚点 tag 的返回 null（用户手工打的 tag 不许参与计数） */
export function snapshotSeq(tag: string): number | null {
  const m = /^snapshot-(\d+)$/.exec(String(tag || '').trim())
  if (!m) return null
  const n = Number(m[1])
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/**
 * 下一个锚点号 = 现有锚点号的最大值 + 1。
 *
 * 不数"有几个 anchor"：中间删过锚点就会撞号（有 1、3 时会再发 2），
 * duplicate tag 在 force 写 ref 时表现为**静默覆盖**旧锚点 → 老历史彻底失锚。
 * 取 max+1 保证单调，代价是号不连续（可接受，序号不是给人看的）。
 */
export function nextSnapshotTag(existing: string[]): string {
  let max = 0
  for (const t of existing) {
    const n = snapshotSeq(t)
    if (n !== null && n > max) max = n
  }
  return `snapshot-${max + 1}`
}

/**
 * 滚动提交的文案。带上锚点名，人眼在 `git log` 里能立刻看出"这里断链了、旧历史在哪个 tag"；
 * 也带上 §6.5 的兜底线索（旧历史另有 backups/ 30 份轮转）。
 */
export function rollMessage(tag: string): string {
  return `chore(data): 历史滚动 · 旧历史锚点 ${tag} · 超出 gitKeepCommits，分支重接到当前投影`
}

import fs from 'node:fs'
import path from 'node:path'
import * as gitNS from 'isomorphic-git'
import * as httpNS from 'isomorphic-git/http/node'

/** isomorphic-git 是 CJS 包：esModuleInterop 下 default 与命名空间两种形态都见过，统一兜一层 */
const git: any = (gitNS as any).default ?? gitNS
const http: any = (httpNS as any).default ?? httpNS

export type Author = { name: string; email: string }

export type GitAuth = { token: string; username?: string } | null

/**
 * 各 Git 服务对 **Basic 认证用户名** 的要求不一样，这是 403 的直接来源：
 *  - GitHub / Gitea / 自建：PAT 作密码，用户名任意（沿用社区习惯值 `x-access-token`）。
 *  - **Gitee：用户名必须是令牌属主的 login，或它认可的占位值 `oauth2`**；
 *    拿 `x-access-token` 去配 Gitee PAT 会被直接拒 `403 remote: The token username invalid`
 *    （实测：`oauth2` / `huathy` / `huathy@qq.com` → 200；`x-access-token` / `Huathy`（首字母大写）→ 403）。
 *  - GitLab：要求 `oauth2`。
 * host 判定失败（URL 看不懂）时退回 GitHub 习惯值，至少不破坏既有用户。
 */
export function defaultAuthUser(url: string | undefined | null, fallback = 'x-access-token'): string {
  const host = /^(?:https?:\/\/)([^/@:]+)/i.exec(String(url || ''))?.[1]?.toLowerCase() || ''
  if (/\bgitee\.com$/.test(host) || /(^|\.)gitlab\./.test(host)) return 'oauth2'
  return fallback
}

/**
 * statusMatrix 行 `[filepath, HEAD, WORKDIR, STAGE]`：只有第 4 列是 stage 号，
 * stage 3 = "their" 侧存在 = 合并冲突未决（R13）。导出给单测钉死列语义。
 */
export function hasStage3(matrix: any[][]): boolean {
  return matrix.some((row) => Number(row[3]) === 3)
}

/**
 * isomorphic-git 的薄封装（只包本方案用到的调用）。
 * 所有错误原样抛出（保留 `e.code`），由 SyncService 按 code 分支 —— 见 §1「冲突错误」行。
 */
export class GitEngine {
  /** setRemote 时记下的远端地址：onAuth 靠它判断该用哪种用户名（见 defaultAuthUser） */
  private remoteUrl: string | null = null

  constructor(public readonly dir: string, private auth: GitAuth = null) {}

  private get gitdir(): string {
    return path.join(this.dir, '.git')
  }

  exists(): boolean {
    return fs.existsSync(this.gitdir)
  }

  async init(branch: string): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true })
    if (!this.exists()) {
      await git.init({ fs, dir: this.dir, defaultBranch: branch })
    }
    const ignore = path.join(this.dir, '.gitignore')
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '# 仓库根只放 ledger 投影；数据库与密钥都在上一级\n')
  }

  /**
   * 凭据：token 作密码；用户名按远端 host 现算（Gitee/GitLab 必须 `oauth2`，
   * 写死 GitHub 习惯值会让 Gitee 私有仓每次 fetch/push 都吃 403）。
   * 配置里显式给了 gitAuthUser 时以配置为准（供特殊自建服务兜底）。
   */
  private onAuth() {
    const token = this.auth?.token || ''
    const username = this.auth?.username?.trim() || defaultAuthUser(this.remoteUrl)
    return { username, password: token }
  }

  async headOid(): Promise<string | null> {
    try {
      return await git.resolveRef({ fs, dir: this.dir, ref: 'HEAD' })
    } catch {
      return null // 空仓库还没有提交
    }
  }

  async resolveRef(ref: string): Promise<string | null> {
    try {
      return await git.resolveRef({ fs, dir: this.dir, ref })
    } catch {
      return null
    }
  }

  /**
   * 列某 ref 的文件。语义与 readFileAt 同规矩（评审修复项）：
   * **只有"ref/对象不存在"才折算成空清单**，fs/zlib 类真故障一律上抛——
   * 旧实现 catch→[] 会把故障伪装成"这版没有数据"，吸收端 0 条记录还照常提交推送。
   */
  async listFiles(ref?: string): Promise<string[]> {
    try {
      return await git.listFiles({ fs, dir: this.dir, ref })
    } catch (e: any) {
      if (this.isNotFound(e)) return []
      throw e
    }
  }

  private isNotFound(e: any): boolean {
    const msg = String(e?.message || '')
    return String(e?.code || '').startsWith('NotFound') || /not exist|not found|does not exist|cannot resolve/i.test(msg)
  }

  /**
   * 读某个提交里的文件内容；**只有"对象不存在"才返回 null**，其它错误上抛。
   * 旧实现 catch→null 把 fs/解压类故障也吞成"文件缺失"，吸收端 `if (!text) continue`
   * 直接静默丢记录——与 doc23 §1「没有静默丢数据的路径」相抵（评审修复项）。
   */
  async readFileAt(ref: string, filepath: string): Promise<string | null> {
    try {
      const r = await git.readBlob({ fs, dir: this.dir, oid: ref, filepath })
      return Buffer.from(r.blob).toString('utf8')
    } catch (e: any) {
      if (this.isNotFound(e)) return null
      throw e
    }
  }

  async add(filepaths: string[]): Promise<void> {
    for (const filepath of filepaths) {
      await git.add({ fs, dir: this.dir, filepath })
    }
  }

  async remove(filepaths: string[]): Promise<void> {
    for (const filepath of filepaths) {
      await git.remove({ fs, dir: this.dir, filepath })
    }
  }

  async commit(message: string, author: Author, parents?: string[]): Promise<string> {
    // parents 省略 = 单亲（普通提交）；显式传两个 = 合并提交（冲突裁决落地时必须用）
    return git.commit({ fs, dir: this.dir, message, author, committer: author, ...(parents ? { parent: parents } : {}) })
  }

  async log(depth = 50): Promise<Array<{ oid: string; message: string; author: string; ts: number }>> {
    // "还没有任何提交"是合法的空历史（HEAD 不可解析）；其余故障上抛（见 listFiles 注释）
    if (!(await this.headOid())) return []
    const rows: any[] = await git.log({ fs, dir: this.dir, depth })
    return rows.map((r: any) => ({
      oid: r.oid,
      message: String(r.commit?.message || '').trim(),
      author: r.commit?.author?.name || '',
      ts: Number(r.commit?.author?.timestamp || 0),
    }))
  }

  /**
   * 冲突未决的物理标记：index 里存在 stage 3（R13）。
   * ⚠️ statusMatrix 行是 `[filepath, HEAD, WORKDIR, STAGE]`——**stage 号只在第 4 列**。
   * 旧实现 `row[3]===3 || row[2]===3` 把 WORKDIR 位也当 stage 判：权限位恰好为 3 的
   * 正常可执行文件会被误判成"合并残局"，每次 run 白做 abortMerge+重投影+多一条提交。
   * 判定抽成纯函数 hasStage3 并单测锁定列语义（R3 同款要求：判据必须被测试钉死；
   * Windows 下复现不了 exec 位，直接测谓词比测平台行为可靠）。
   */
  async hasUnmerged(): Promise<boolean> {
    if (!this.exists()) return false
    return hasStage3(await this.statusMatrix())
  }

  /**
   * 真故障一律上抛（评审修复项，与 listFiles/readFileAt 同规矩）：
   * 旧实现 catch→[] 在 commitAll 眼里＝"没有变更"，fs 故障会被伪装成"什么都没改"，
   * 投影不落提交、同步照常推进——正是 §1「没有静默丢数据的路径」要防的形态。
   */
  async statusMatrix(): Promise<any[]> {
    if (!this.exists()) return []
    return await git.statusMatrix({ fs, dir: this.dir })
  }

  /**
   * 共同祖先（§4.5 差异预览的地基，isomorphic-git 内置 findMergeBase）。
   * 无关历史/无祖先返回 null，调用方按"没有祖先"处理（全部按双改对待）。
   */
  async mergeBase(oidA: string, oidB: string): Promise<string | null> {
    try {
      const bases: string[] = await git.findMergeBase({ fs, dir: this.dir, oids: [oidA, oidB] })
      return bases[0] ?? null
    } catch (e: any) {
      if (this.isNotFound(e)) return null
      throw e
    }
  }

  async setRemote(url: string): Promise<void> {
    // 先记地址再落配置：onAuth 需要它挑用户名；两处都必须更新，
    // 否则"URL 相同就 return"的短路会让 remoteUrl 停在 null（engine 每次新建，其实是首调）。
    this.remoteUrl = url || null
    const remotes: any[] = await git.listRemotes({ fs, dir: this.dir }).catch(() => [])
    if (remotes.some((r) => r.remote === 'origin')) {
      const cur = remotes.find((r) => r.remote === 'origin')
      if (cur?.url === url) return
      await git.setConfig({ fs, dir: this.dir, path: 'remote.origin.url', value: url })
    } else {
      await git.addRemote({ fs, dir: this.dir, remote: 'origin', url })
    }
  }

  async fetch(branch: string) {
    try {
      return await git.fetch({
        fs,
        http,
        dir: this.dir,
        remote: 'origin',
        ref: branch,
        singleBranch: true,
        tags: false,
        onAuth: () => this.onAuth(),
      })
    } catch (e: any) {
      /**
       * 裸仓库的 HEAD 指向一个还不存在的分支（`git init --bare` 默认 master，而数据分支是 main）时，
       * isomorphic-git 会在**更新完远端 refs 之后**因为找不到 HEAD 而抛 NotFoundError。
       * refs 已经落好了，这里视同成功——否则第二台设备永远拉不下来（§5.1 F）。
       */
      if (e?.code === 'NotFoundError' && (e?.data?.what === 'HEAD' || /HEAD/.test(String(e?.message)))) {
        const oid = await this.remoteOid(branch)
        if (oid) return { fetchHead: oid, ok: true }
      }
      throw e
    }
  }

  async remoteOid(branch: string): Promise<string | null> {
    return this.resolveRef(`refs/remotes/origin/${branch}`)
  }

  /**
   * 合并远端到本地分支。
   * ⚠️ `abortOnConflict:false` **仍然抛** `MergeConflictError`（实测 1.44.9），
   * 它只保证"保留冲突现场"（index 写 stage 1/2/3），调用方必须 try/catch。
   */
  async merge(opts: {
    branch: string
    theirs: string
    mergeDriver: (args: { path: string; contents: string[]; branches: string[] }) => { cleanMerge: boolean; mergedText: string }
    message: string
    author: Author
  }) {
    return git.merge({
      fs,
      dir: this.dir,
      ours: opts.branch,
      theirs: opts.theirs,
      fastForward: true,
      fastForwardOnly: false,
      abortOnConflict: false,
      allowUnrelatedHistories: false,
      mergeDriver: opts.mergeDriver,
      message: opts.message,
      author: opts.author,
      committer: opts.author,
    })
  }

  async abortMerge(): Promise<void> {
    try {
      await git.abortMerge({ fs, dir: this.dir })
    } catch {
      /* 不在冲突态时 abortMerge 会抛，忽略即可 */
    }
  }

  /**
   * 首次同步"认领"远端历史（§5.1 F 的落地方式）。
   *
   * 新设备本地仓库是空的，直接 merge 会撞 `allowUnrelatedHistories=false` → 永远拉不下来。
   * 正确做法：把本地分支指到远端 oid 并检出，让本地历史**成为远端历史的延续**，
   * 然后再把本机数据投影成一次新提交推上去（= 文档说的"先拉后推"）。
   */
  async adoptRemote(branch: string, oid: string): Promise<void> {
    await git.writeRef({ fs, dir: this.dir, ref: `refs/heads/${branch}`, value: oid, force: true })
    await git.checkout({ fs, dir: this.dir, ref: branch, force: true })
  }

  async hasCommits(): Promise<boolean> {
    return (await this.headOid()) !== null
  }

  /**
   * 本分支领先远端多少个提交（phase=pull 后如实重算 pendingCommits 用）。
   * ⚠️ isomorphic-git 的公开 API **没有** countAheadBehind（exports 表实测无此名，
   * 想当然会 MODULE 运行期 undefined 炸同步）→ 用 log 扫祖先链实现：
   *   远端引用不存在 → 全部提交都待推；
   *   远端 oid 在 head 的祖先链上（下标 i）→ ahead = i；
   *   找不到（已分叉）→ 保守按全量计（反正 push 会 non-fast-forward 触发回拉）。
   */
  async countAhead(branch: string): Promise<number> {
    const [head, remoteOid] = await Promise.all([this.headOid(), this.remoteOid(branch)])
    if (!head) return 0
    if (remoteOid === head) return 0
    const rows: any[] = await git.log({ fs, dir: this.dir, ref: `refs/heads/${branch}`, depth: 1000 })
    const oids = rows.map((r: any) => r.oid)
    if (!remoteOid) return oids.length
    const idx = oids.indexOf(remoteOid)
    return idx >= 0 ? idx : oids.length
  }

  /**
   * 本分支的提交条数（只数到 `cap` 就停，用于 §6.5 的阈值判断）。
   * 同 countAhead 的教训：isomorphic-git 没有 count API，只能用 log 抓；
   * 抓 `cap` 条也够判"超没超"——真超了就该滚，具体超多少不影响决策。
   * 空仓库/无提交返回 0（`log` 对不可解析的 ref 会抛，这里按 0 处理）。
   */
  async countCommits(branch: string, cap: number): Promise<number> {
    try {
      const rows: any[] = await git.log({ fs, dir: this.dir, ref: `refs/heads/${branch}`, depth: Math.max(1, cap) })
      return rows.length
    } catch (e: any) {
      if (this.isNotFound(e)) return 0
      throw e
    }
  }

  /** 当前 head 的 tree oid：滚动时新根提交要挂的是"当前投影"，不是空树 */
  async headTree(): Promise<string | null> {
    const oid = await this.headOid()
    if (!oid) return null
    const c: any = await git.readCommit({ fs, dir: this.dir, oid })
    return String(c?.commit?.tree || '') || null
  }

  /**
   * §6.5 分支滚动：把分支指到"以给定 tree 为内容、**没有父提交**的新根提交"。
   *
   * 为什么必须无父：`git gc`/`repack` 在纯 JS 里没有，历史只会一直长；
   * 断链是唯一能在 isomorphic-git 里做到"历史归零、内容不变"的手段
   * （旧历史靠调用方打的 `snapshot-<n>` tag 锚住，远端侧仍可按锚点找回）。
   * `parent: []` 是 isomorphic-git 的 real API（`_commit` 里对显式空数组
   * 不再回填 refOid，见 index.cjs 的 `if (!parent)` 分支），不是 yolo 猜的。
   * ⚠️ 滚完之后本地与远端历史无共同祖先：必须配合强推（调用方按租约闸门决定）。
   */
  async rollToRoot(branch: string, tree: string, message: string, author: Author): Promise<string> {
    return git.commit({
      fs,
      dir: this.dir,
      ref: `refs/heads/${branch}`,
      parent: [],
      tree,
      message,
      author,
      committer: author,
    })
  }

  async listTagNames(): Promise<string[]> {
    try {
      const tags: string[] = await git.listTags({ fs, dir: this.dir })
      return tags
    } catch (e: any) {
      if (this.isNotFound(e)) return []
      throw e
    }
  }

  /**
   * 打锚点 tag（指向一个既有提交）。`git.tag` 的 `object` 走 ref resolve，
   * 40 位十六进制会被原样返回（GitRefManager.resolve 的 SHA 快路径）→ 传 oid 合法。
   * `force: true`：同号重复打时宁可覆盖成新值（序号由 nextSnapshotTag 保证单调，理论上不会撞）。
   */
  async tagAnchor(name: string, oid: string): Promise<void> {
    await git.tag({ fs, dir: this.dir, ref: name, object: oid, force: true })
  }

  async push(branch: string, force = false) {
    return git.push({
      fs,
      http,
      dir: this.dir,
      remote: 'origin',
      ref: branch,
      force,
      onAuth: () => this.onAuth(),
    })
  }
}

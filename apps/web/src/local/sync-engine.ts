/**
 * 离线同步 Git 引擎（浏览器版，与服务端 apps/server/src/sync/git-engine.ts 同口径）。
 *
 * 差异只有三处，其余一字不抄都不行（否则两端对同一仓库算出不同结果）：
 *  1. fs：node:fs → lightning-fs（IndexedDB），dir 固定 GIT_DIR
 *  2. http：isomorphic-git/http/node → isomorphic-git/http/web（fetch 版）
 *  3. 同步：lightning-fs 全是异步，服务端版的 existsSync 之类全部改 await
 *
 * statusMatrix 列语义、adoptRemote、rollToRoot(parent:[])、countAhead 用 log 扫祖先链——
 * 全部与服务端一致，注释里标了出处。
 */
import { ensureGitDir, git, gitHttp, gitPfs, GIT_DIR } from './sync-gitfs'
import { defaultAuthUser, hasStage3 } from './sync-shared'

export type Author = { name: string; email: string }
export type GitAuth = { token: string; username?: string } | null

export { hasStage3 }

export class GitEngineLocal {
  private remoteUrl: string | null = null

  constructor(private auth: GitAuth = null) {}

  private get fs(): any {
    return gitPfs()
  }
  private get dir(): string {
    return GIT_DIR
  }

  async exists(): Promise<boolean> {
    try {
      await this.fs.stat(this.dir + '/.git')
      return true
    } catch {
      return false
    }
  }

  async init(branch: string): Promise<void> {
    await ensureGitDir()
    if (!(await this.exists())) {
      await git.init({ fs: this.fs, dir: this.dir, defaultBranch: branch })
    }
  }

  private onAuth() {
    const token = this.auth?.token || ''
    const username = this.auth?.username?.trim() || defaultAuthUser(this.remoteUrl)
    return { username, password: token }
  }

  async headOid(): Promise<string | null> {
    try {
      return await git.resolveRef({ fs: this.fs, dir: this.dir, ref: 'HEAD' })
    } catch {
      return null
    }
  }

  async resolveRef(ref: string): Promise<string | null> {
    try {
      return await git.resolveRef({ fs: this.fs, dir: this.dir, ref })
    } catch {
      return null
    }
  }

  async listFiles(ref?: string): Promise<string[]> {
    try {
      return await git.listFiles({ fs: this.fs, dir: this.dir, ref } as any)
    } catch (e: any) {
      if (this.isNotFound(e)) return []
      throw e
    }
  }

  private isNotFound(e: any): boolean {
    const msg = String(e?.message || '')
    return String(e?.code || '').startsWith('NotFound') || /not exist|not found|does not exist|cannot resolve/i.test(msg)
  }

  async readFileAt(ref: string, filepath: string): Promise<string | null> {
    try {
      const r: any = await git.readBlob({ fs: this.fs, dir: this.dir, oid: ref, filepath })
      const blob = r.blob as Uint8Array
      return new TextDecoder().decode(blob)
    } catch (e: any) {
      if (this.isNotFound(e)) return null
      throw e
    }
  }

  async add(filepaths: string[]): Promise<void> {
    for (const filepath of filepaths) {
      await git.add({ fs: this.fs, dir: this.dir, filepath })
    }
  }

  async remove(filepaths: string[]): Promise<void> {
    for (const filepath of filepaths) {
      await git.remove({ fs: this.fs, dir: this.dir, filepath })
    }
  }

  async writeFile(rel: string, content: string): Promise<void> {
    const pfs = this.fs
    const abs = this.dir + '/' + rel
    // lightning-fs 的 mkdir recursive 在部分版本不可靠：逐级建，EEXIST 忽略
    const parts = abs.split('/').filter(Boolean)
    let cur = ''
    for (let i = 0; i < parts.length - 1; i++) {
      cur += '/' + parts[i]
      try {
        await pfs.mkdir(cur)
      } catch (e: any) {
        const msg = String(e?.code || e?.message || '')
        if (!/EEXIST|exists/i.test(msg)) throw e
      }
    }
    await pfs.writeFile(abs, new TextEncoder().encode(content))
  }

  async readWorkFile(rel: string): Promise<string | null> {
    try {
      const buf = await this.fs.readFile(this.dir + '/' + rel)
      return new TextDecoder().decode(buf)
    } catch {
      return null
    }
  }

  async commit(message: string, author: Author, parents?: string[]): Promise<string> {
    return git.commit({ fs: this.fs, dir: this.dir, message, author, committer: author, ...(parents ? { parent: parents } : {}) } as any)
  }

  async log(depth = 50): Promise<Array<{ oid: string; message: string; author: string; ts: number }>> {
    if (!(await this.headOid())) return []
    const rows: any[] = await git.log({ fs: this.fs, dir: this.dir, depth })
    return rows.map((r: any) => ({
      oid: r.oid,
      message: String(r.commit?.message || '').trim(),
      author: r.commit?.author?.name || '',
      ts: Number(r.commit?.author?.timestamp || 0),
    }))
  }

  async hasUnmerged(): Promise<boolean> {
    if (!(await this.exists())) return false
    return hasStage3(await this.statusMatrix())
  }

  async statusMatrix(): Promise<any[]> {
    if (!(await this.exists())) return []
    return await git.statusMatrix({ fs: this.fs, dir: this.dir } as any)
  }

  async mergeBase(oidA: string, oidB: string): Promise<string | null> {
    try {
      const bases: string[] = await git.findMergeBase({ fs: this.fs, dir: this.dir, oids: [oidA, oidB] })
      return bases[0] ?? null
    } catch (e: any) {
      if (this.isNotFound(e)) return null
      throw e
    }
  }

  async setRemote(url: string): Promise<void> {
    this.remoteUrl = url || null
    const remotes: any[] = await git.listRemotes({ fs: this.fs, dir: this.dir }).catch(() => [])
    if (remotes.some((r) => r.remote === 'origin')) {
      const cur = remotes.find((r) => r.remote === 'origin')
      if (cur?.url === url) return
      await git.setConfig({ fs: this.fs, dir: this.dir, path: 'remote.origin.url', value: url })
    } else {
      await git.addRemote({ fs: this.fs, dir: this.dir, remote: 'origin', url })
    }
  }

  async fetch(branch: string) {
    try {
      return await git.fetch({
        fs: this.fs,
        http: gitHttp,
        dir: this.dir,
        remote: 'origin',
        ref: branch,
        singleBranch: true,
        tags: false,
        onAuth: () => this.onAuth(),
      } as any)
    } catch (e: any) {
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

  async merge(opts: {
    branch: string
    theirs: string
    mergeDriver: (args: { path: string; contents: string[]; branches: string[] }) => { cleanMerge: boolean; mergedText: string }
    message: string
    author: Author
  }) {
    return git.merge({
      fs: this.fs,
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
    } as any)
  }

  async abortMerge(): Promise<void> {
    try {
      await git.abortMerge({ fs: this.fs, dir: this.dir } as any)
    } catch {
      /* 不在冲突态时抛，忽略 */
    }
  }

  async adoptRemote(branch: string, oid: string): Promise<void> {
    await git.writeRef({ fs: this.fs, dir: this.dir, ref: `refs/heads/${branch}`, value: oid, force: true })
    await git.checkout({ fs: this.fs, dir: this.dir, ref: branch, force: true })
  }

  async hasCommits(): Promise<boolean> {
    return (await this.headOid()) !== null
  }

  async countAhead(branch: string): Promise<number> {
    const [head, remoteOid] = await Promise.all([this.headOid(), this.remoteOid(branch)])
    if (!head) return 0
    if (remoteOid === head) return 0
    const rows: any[] = await git.log({ fs: this.fs, dir: this.dir, ref: `refs/heads/${branch}`, depth: 1000 } as any)
    const oids = rows.map((r: any) => r.oid)
    if (!remoteOid) return oids.length
    const idx = oids.indexOf(remoteOid)
    return idx >= 0 ? idx : oids.length
  }

  async countCommits(branch: string, cap: number): Promise<number> {
    try {
      const rows: any[] = await git.log({ fs: this.fs, dir: this.dir, ref: `refs/heads/${branch}`, depth: Math.max(1, cap) } as any)
      return rows.length
    } catch (e: any) {
      if (this.isNotFound(e)) return 0
      throw e
    }
  }

  async headTree(): Promise<string | null> {
    const oid = await this.headOid()
    if (!oid) return null
    const c: any = await git.readCommit({ fs: this.fs, dir: this.dir, oid })
    return String(c?.commit?.tree || '') || null
  }

  async rollToRoot(branch: string, tree: string, message: string, author: Author): Promise<string> {
    return git.commit({
      fs: this.fs,
      dir: this.dir,
      ref: `refs/heads/${branch}`,
      parent: [],
      tree,
      message,
      author,
      committer: author,
    } as any)
  }

  async listTagNames(): Promise<string[]> {
    try {
      return await git.listTags({ fs: this.fs, dir: this.dir })
    } catch (e: any) {
      if (this.isNotFound(e)) return []
      throw e
    }
  }

  async tagAnchor(name: string, oid: string): Promise<void> {
    await git.tag({ fs: this.fs, dir: this.dir, ref: name, object: oid, force: true } as any)
  }

  async push(branch: string, force = false) {
    return git.push({
      fs: this.fs,
      http: gitHttp,
      dir: this.dir,
      remote: 'origin',
      ref: branch,
      force,
      onAuth: () => this.onAuth(),
    } as any)
  }
}

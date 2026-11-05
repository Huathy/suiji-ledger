import { Injectable, Logger } from '@nestjs/common'
import fs from 'node:fs'
import path from 'node:path'
import { PrismaService } from '../prisma.service'
import { RecordMetaService } from './record-meta.service'
import { SyncConfigService } from './sync-config.service'
import { GitEngine } from './git-engine'
import { encodeRecord } from './codec'
import { DIR_OF, fileNameOf, kindOfFileName, SYNC_SETTING_KEYS, type LedgerRecord } from './ledger'
import { accountToRecord, entryToRecord, loanToRecord, settingToRecord, snapshotToRecord, typeToRecord } from './mappers'

/**
 * files = 本次写入的相对路径。
 * 评审修复项（死字段）：删掉了恒为 [] 的 `removed` —— 墓碑语义（R10）下投影**永不删文件**，
 * "被删记录"以 `deleted:true` 的内容变更出现在 written 里，不存在"从工作区移除"这条通道。
 */
export type ProjectResult = { files: number; written: string[] }

/**
 * 投影器（DB → git 工作区）。
 *
 * 硬规则：
 *  1. **绝不物理删文件**（§4.3 / R10）—— 删除必须写成 `deleted:true` 的墓碑内容，
 *     否则冲突会绕开 `mergeDriver`（驱动只在"两端都有该文件且都改过"时被调用），
 *     我们连裁决机会都拿不到。
 *  2. 序列化走 `encodeRecord`（确定性 + 可选加密），否则每次投影都会"全库变更"。
 */
@Injectable()
export class ProjectService {
  private log = new Logger('SyncProject')

  constructor(private prisma: PrismaService, private meta: RecordMetaService, private cfg: SyncConfigService) {}

  async engine(): Promise<GitEngine> {
    return new GitEngine(this.cfg.repoDir(), { token: await this.cfg.token(), username: await this.cfg.authUser() })
  }

  async buildRecords(): Promise<LedgerRecord[]> {
    await this.meta.ensureUids() // 老库升级自愈：uid 为空的行就地补
    const [types, accounts, snapshots, entries, loans, settings] = await Promise.all([
      this.prisma.recordType.findMany({ orderBy: [{ sort: 'asc' }, { id: 'asc' }] }),
      this.prisma.account.findMany({ orderBy: [{ sort: 'asc' }, { id: 'asc' }] }),
      this.prisma.monthlySnapshot.findMany({ orderBy: [{ ym: 'asc' }, { id: 'asc' }] }),
      this.prisma.changeEntry.findMany({ orderBy: [{ ym: 'asc' }, { id: 'asc' }] }),
      this.prisma.loan.findMany({ orderBy: [{ date: 'asc' }, { id: 'asc' }] }),
      this.prisma.setting.findMany(),
    ])
    const typeUid = new Map(types.map((t) => [t.id, t.uid!]))
    const accUid = new Map(accounts.map((a) => [a.id, a.uid!]))
    const recs: LedgerRecord[] = []

    for (const t of types) if (t.uid) recs.push(typeToRecord(t))
    for (const a of accounts) if (a.uid) recs.push(accountToRecord(a))
    for (const s of snapshots) {
      const au = accUid.get(s.accountId)
      if (au) recs.push(snapshotToRecord(s, au))
    }
    for (const e of entries) {
      if (e.auto) continue // 派生值不参与同步：各端余额一致时自然一致，推上去只会制造必然冲突
      const tu = typeUid.get(e.typeId)
      if (!tu) continue
      recs.push(entryToRecord(e, tu, e.accountId ? accUid.get(e.accountId) ?? null : null))
    }
    for (const l of loans) recs.push(loanToRecord(l, l.accountId ? accUid.get(l.accountId) ?? null : null))
    for (const s of settings) {
      if (SYNC_SETTING_KEYS.includes(s.key)) recs.push(settingToRecord(s.key, s.value))
    }
    return recs
  }

  /** basename → 文件内容（含 meta.json） */
  async buildFiles(): Promise<{ files: Map<string, string>; records: LedgerRecord[] }> {
    const [records, encrypted, deviceId] = await Promise.all([this.buildRecords(), this.cfg.encrypt(), this.meta.deviceId()])
    const files = new Map<string, string>()
    for (const rec of records) files.set(fileNameOf(rec), encodeRecord(rec, encrypted))

    // meta.json 是"本端投影指纹"，没有合并语义 → 冲突时永远取 ours（§5.2）
    const counts = {
      types: records.filter((r) => r.kind === 'type').length,
      accounts: records.filter((r) => r.kind === 'account').length,
      snapshots: records.filter((r) => r.kind === 'snapshot').length,
      entries: records.filter((r) => r.kind === 'entry').length,
      loans: records.filter((r) => r.kind === 'loan').length,
    }
    // 注意：不要写 projectedAt 这类每次都变的时间戳，否则每次投影都产生一条空提交
    files.set('meta.json', JSON.stringify({ format: 'suiji-ledger-v1', version: 1, deviceId, counts }) + '\n')
    return { files, records }
  }

  /** 全量重投影：内容相同不动，不同才写；多余的旧文件**不删**（墓碑语义） */
  async writeAll(): Promise<ProjectResult> {
    const { files } = await this.buildFiles()
    const engine = await this.engine()
    const branch = await this.cfg.branch()
    await engine.init(branch)

    const dir = this.cfg.repoDir()
    const written: string[] = []
    for (const [name, content] of files) {
      const rel = this.relPathOf(name)
      const abs = path.join(dir, rel)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      if (fs.existsSync(abs) && fs.readFileSync(abs, 'utf8') === content) continue
      // 原子写（评审修复项）：直接 writeFileSync 在进程崩溃/断电时可能留下半截 JSON，
      // 下一轮 commitAll 会把半截文件原样提交进历史——对端拉到时整条记录不可解析。
      // temp+rename 同目录替换是原子的（Windows 的 rename 可覆盖已存在目标）：
      // 落盘状态要么旧内容要么新内容，没有中间态。
      const tmp = abs + '.tmp'
      fs.writeFileSync(tmp, content, 'utf8')
      fs.renameSync(tmp, abs)
      written.push(rel)
    }
    // .gitignore 兜底：万一崩溃在 write 与 rename 之间留下 .tmp，绝不许它进 index
    this.ensureTmpIgnored(dir)
    if (written.length > 0) this.log.debug(`投影写入 ${written.length} 个文件`)
    return { files: files.size, written }
  }

  /** 数据仓根 .gitignore 由 GitEngine.init 创建；这里补 *.tmp 规则（原子写的残料） */
  private ensureTmpIgnored(dir: string) {
    const ignore = path.join(dir, '.gitignore')
    try {
      const cur = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : ''
      if (!cur.includes('*.tmp')) fs.writeFileSync(ignore, cur + '\n# 原子写残料（崩溃兜底，绝不进历史）\n*.tmp\n', 'utf8')
    } catch (e: any) {
      this.log.warn('.gitignore *.tmp 补写失败: ' + (e?.message || e))
    }
  }

  private relPathOf(fileName: string): string {
    // 目录只是给人看的；判定 kind 一律靠 basename 前缀（R12）。
    // dir 映射唯一来源 = ledger 的 PREFIX_KIND/DIR_OF（评审修复项：此处以前手抄第二份表）
    const kind = kindOfFileName(fileName)
    const dir = kind ? DIR_OF[kind] : ''
    return dir ? path.posix.join('ledger', 'v1', dir, fileName) : path.posix.join('ledger', 'v1', fileName)
  }

  /**
   * 把工作区里相对 head 的全部变更加入 index，返回"是否有东西被暂存"。
   *
   * 为什么单独抽出来（评审修复项 Duplicated Code）：`commitAll` 与 `commitMerge` 原本各抄一份
   * statusMatrix → toAdd/toRemove 的循环，逐行相同。这两份一旦分叉，症状都很安静：
   * 合并提交漏掉删除 → 被删记录在历史里"复活"；普通提交漏掉复原 → 恢复的版本推不上去。
   * 暂存是"哪些文件变了"的唯一判定点，只能有一份。
   */
  private async stageAll(engine: GitEngine): Promise<boolean> {
    const rows = await engine.statusMatrix()
    const toAdd: string[] = []
    const toRemove: string[] = []
    for (const [filepath, head, workdir] of rows as any[]) {
      if (head === workdir) continue // 未变更
      if (Number(workdir) === 0) toRemove.push(filepath) // 工作区没有 = 被删
      else toAdd.push(filepath)
    }
    if (toAdd.length) await engine.add(toAdd)
    if (toRemove.length) await engine.remove(toRemove)
    return toAdd.length + toRemove.length > 0
  }

  /** 把工作区里的实际变更提交掉；无变更返回 null */
  async commitAll(message: string): Promise<string | null> {
    const engine = await this.engine()
    const branch = await this.cfg.branch()
    await engine.init(branch)
    if (!(await this.stageAll(engine))) return null
    const deviceId = await this.meta.deviceId()
    return engine.commit(message, { name: deviceId, email: `${deviceId}@local` })
  }

  /**
   * 冲突裁决后的"落地提交"：**必须是合并提交**（双亲 = 本端 head + 冲突快照里的 theirs）。
   *
   * 少了第二个亲本会怎样（e2e 实测踩到）：提交只有本端父节点，push 永远不是 fast-forward →
   * 远端一直拒 → `pushWithRetry` 回拉 → 又一次撞上同一处冲突 → 冲突态原地复活，
   * 表现是"裁决完还在冲突里"，而且远端一次都没更新。
   *
   * 注意：这里**不能**复用 `commitAll` —— 用户全部选"以本地为准"时工作区与 head 内容一致，
   * `commitAll` 会因为"无变更"直接返回 null，合并提交就丢了。
   */
  async commitMerge(message: string, theirsOid: string | null): Promise<string | null> {
    const engine = await this.engine()
    const branch = await this.cfg.branch()
    await engine.init(branch)
    const head = await engine.headOid()
    if (!head) return null

    // 暂存后即使"没有可暂存的东西"也必须提交：全部选"以本地为准"时工作区与 head 一致，
    // 但合并提交本身是这轮裁决的载体，不能因为"无变更"就丢（见上面的注释）。
    await this.stageAll(engine)

    const deviceId = await this.meta.deviceId()
    const parents = theirsOid && theirsOid !== head ? [head, theirsOid] : [head]
    return engine.commit(message, { name: deviceId, email: `${deviceId}@local` }, parents)
  }
}

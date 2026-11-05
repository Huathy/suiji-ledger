// mergeDriver 与真实 git 合并行为的集成测试（验证 §1 三条实测约束没被写错）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import * as gitNS from 'isomorphic-git'
import { makeLedgerDriver, type CapturedTriple } from '../apps/server/src/sync/merge-driver'
import { canonicalRecord, type LedgerRecord } from '../apps/server/src/sync/ledger'

const git: any = (gitNS as any).default ?? gitNS
const author = { name: 'd_a', email: 'd_a@local' }

const entry = (uid: string, amountCents: number, rev = 1): LedgerRecord => ({
  uid,
  kind: 'entry',
  ym: '2026-10',
  typeUid: 't-1',
  amountCents,
  note: null,
  accountUid: null,
  auto: false,
  rev,
  updatedAt: 100 + rev,
  deleted: false,
  origin: 'd_a',
})

const loan = (settledCents: number, rev = 1): LedgerRecord => ({
  uid: 'l-1',
  kind: 'loan',
  direction: 'out',
  counterparty: '张三',
  amountCents: 30000,
  settledCents,
  date: '2026-10-01',
  dueDate: null,
  accountUid: null,
  note: null,
  createdAt: 1,
  rev,
  updatedAt: 100 + rev,
  deleted: false,
  origin: 'd_a',
})

async function newRepo(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-merge-'))
  await git.init({ fs, dir, defaultBranch: 'main' })
  return dir
}

function write(dir: string, rel: string, content: string) {
  const abs = path.join(dir, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf8')
}

async function commitAll(dir: string, message: string) {
  const st = await git.statusMatrix({ fs, dir })
  for (const [f] of st) await git.add({ fs, dir, filepath: f })
  return git.commit({ fs, dir, message, author })
}

function driverFor(captured: CapturedTriple[], mergeEnabled = true, encrypted = false, autoMerged?: string[]) {
  return makeLedgerDriver({ captured, autoMerged, mergeEnabled, encrypted, deviceId: 'd_merge', now: () => 999 })
}

async function merge(dir: string, theirs: string, driver: any) {
  return git.merge({
    fs,
    dir,
    ours: 'main',
    theirs,
    fastForward: true,
    fastForwardOnly: false,
    abortOnConflict: false,
    mergeDriver: driver,
    message: 'merge',
    author,
    committer: author,
  })
}

describe('mergeDriver 接入真实 git', () => {
  it('两端各改不同记录（不同文件）→ 自动 clean merge，零打扰', async () => {
    const dir = await newRepo()
    write(dir, 'ledger/v1/entries/e_a.json', canonicalRecord(entry('a', 100)))
    write(dir, 'ledger/v1/entries/e_b.json', canonicalRecord(entry('b', 200)))
    await commitAll(dir, 'base')
    await git.branch({ fs, dir, ref: 'side' })

    write(dir, 'ledger/v1/entries/e_a.json', canonicalRecord(entry('a', 150, 2)))
    await commitAll(dir, 'main change a')

    await git.checkout({ fs, dir, ref: 'side' })
    write(dir, 'ledger/v1/entries/e_b.json', canonicalRecord(entry('b', 260, 2)))
    await commitAll(dir, 'side change b')
    await git.checkout({ fs, dir, ref: 'main' })

    const captured: CapturedTriple[] = []
    const r = await merge(dir, 'side', driverFor(captured))
    expect(r.mergeCommit || r.oid).toBeTruthy()
    expect(captured).toHaveLength(0) // 驱动根本没被调用
    // 断言合并结果（合并提交的树），工作区稍后由 writeAll 重投影
    const a = await git.readBlob({ fs, dir, oid: r.oid, filepath: 'ledger/v1/entries/e_a.json' })
    const b = await git.readBlob({ fs, dir, oid: r.oid, filepath: 'ledger/v1/entries/e_b.json' })
    expect(JSON.parse(Buffer.from(a.blob).toString('utf8')).amountCents).toBe(150)
    expect(JSON.parse(Buffer.from(b.blob).toString('utf8')).amountCents).toBe(260)
  })

  it('§5.6.2 已自动合并核对区：同文件同值（内容一致）驱动 cleanMerge 时记入 autoMerged', async () => {
    const dir = await newRepo()
    write(dir, 'ledger/v1/entries/e_a.json', canonicalRecord(entry('a', 100)))
    write(dir, 'ledger/v1/loans/l_l-1.json', canonicalRecord(loan(1000, 2)))
    await commitAll(dir, 'base')
    await git.branch({ fs, dir, ref: 'side' })

    // 两端把同一条借还改成"各还一点"（只有 settledCents 变且都 ≥ 祖先）→ 驱动自动取 max = cleanMerge
    write(dir, 'ledger/v1/loans/l_l-1.json', canonicalRecord(loan(4000, 3)))
    await commitAll(dir, 'local settle')
    await git.checkout({ fs, dir, ref: 'side' })
    write(dir, 'ledger/v1/loans/l_l-1.json', canonicalRecord(loan(2500, 4)))
    await commitAll(dir, 'remote settle')
    await git.checkout({ fs, dir, ref: 'main' })

    const captured: CapturedTriple[] = []
    const autoMerged: string[] = []
    await merge(dir, 'side', driverFor(captured, true, false, autoMerged))
    expect(captured).toHaveLength(0)
    expect(autoMerged).toContain('l_l-1.json') // 核对区数据源（评审修复项）
  })

  it('同一记录双端都改 → 抛 MergeConflictError，且三方原文被驱动捕获', async () => {
    const dir = await newRepo()
    write(dir, 'ledger/v1/entries/e_a.json', canonicalRecord(entry('a', 100)))
    await commitAll(dir, 'base')
    await git.branch({ fs, dir, ref: 'side' })

    write(dir, 'ledger/v1/entries/e_a.json', canonicalRecord(entry('a', 150, 3)))
    await commitAll(dir, 'local')

    await git.checkout({ fs, dir, ref: 'side' })
    write(dir, 'ledger/v1/entries/e_a.json', canonicalRecord(entry('a', 120, 4)))
    await commitAll(dir, 'remote')
    await git.checkout({ fs, dir, ref: 'main' })

    const captured: CapturedTriple[] = []
    let code = ''
    try {
      await merge(dir, 'side', driverFor(captured))
    } catch (e: any) {
      code = e.code
      expect(e.data.filepaths.length).toBeGreaterThan(0) // 冲突清单来源
    }
    expect(code).toBe('MergeConflictError')
    expect(captured).toHaveLength(1)
    expect(captured[0].fileName).toBe('e_a.json') // 只有 basename（R12）
    expect(JSON.parse(captured[0].base!).amountCents).toBe(100) // 共同祖先
    expect(JSON.parse(captured[0].our).amountCents).toBe(150)
    expect(JSON.parse(captured[0].their).amountCents).toBe(120)

    // 冲突时返回 our → 工作区不被远端内容污染
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'ledger/v1/entries/e_a.json'), 'utf8')).amountCents).toBe(150)

    // 冲突未决的物理标记：index 有 stage 3（R13）
    const m = await git.statusMatrix({ fs, dir })
    expect(m.some((row: any[]) => row[3] === 3)).toBe(true)

    // abortMerge 能复位
    await git.abortMerge({ fs, dir })
    const after = await git.statusMatrix({ fs, dir })
    expect(after.every((row: any[]) => row[3] !== 3)).toBe(true)
  })

  it('借还进度纯累加 → 驱动自动取 max，不进冲突界面', async () => {
    const dir = await newRepo()
    write(dir, 'ledger/v1/loans/l_l-1.json', canonicalRecord(loan(0)))
    await commitAll(dir, 'base')
    await git.branch({ fs, dir, ref: 'side' })

    write(dir, 'ledger/v1/loans/l_l-1.json', canonicalRecord(loan(10000, 2)))
    await commitAll(dir, 'local')
    await git.checkout({ fs, dir, ref: 'side' })
    write(dir, 'ledger/v1/loans/l_l-1.json', canonicalRecord(loan(5000, 3)))
    await commitAll(dir, 'remote')
    await git.checkout({ fs, dir, ref: 'main' })

    const captured: CapturedTriple[] = []
    const r = await merge(dir, 'side', driverFor(captured))
    expect(captured).toHaveLength(0)
    const blob = await git.readBlob({ fs, dir, oid: r.oid, filepath: 'ledger/v1/loans/l_l-1.json' })
    const merged = JSON.parse(Buffer.from(blob.blob).toString('utf8'))
    expect(merged.settledCents).toBe(10000)
  })

  it('meta.json 永远取 ours（本端投影指纹），不产生冲突', async () => {
    const dir = await newRepo()
    write(dir, 'meta.json', JSON.stringify({ deviceId: 'd_a', counts: { entries: 1 } }) + '\n')
    write(dir, 'ledger/v1/entries/e_a.json', canonicalRecord(entry('a', 100)))
    await commitAll(dir, 'base')
    await git.branch({ fs, dir, ref: 'side' })

    write(dir, 'meta.json', JSON.stringify({ deviceId: 'd_a', counts: { entries: 2 } }) + '\n')
    await commitAll(dir, 'local meta')
    await git.checkout({ fs, dir, ref: 'side' })
    write(dir, 'meta.json', JSON.stringify({ deviceId: 'd_b', counts: { entries: 9 } }) + '\n')
    await commitAll(dir, 'remote meta')
    await git.checkout({ fs, dir, ref: 'main' })

    const captured: CapturedTriple[] = []
    const r = await merge(dir, 'side', driverFor(captured))
    expect(captured).toHaveLength(0)
    const blob = await git.readBlob({ fs, dir, oid: r.oid, filepath: 'meta.json' })
    expect(JSON.parse(Buffer.from(blob.blob).toString('utf8')).deviceId).toBe('d_a')
  })

  it('合并关闭（设置 off）时，双端同改一律进整份二选一', async () => {
    const dir = await newRepo()
    write(dir, 'ledger/v1/entries/e_a.json', canonicalRecord(entry('a', 100)))
    await commitAll(dir, 'base')
    await git.branch({ fs, dir, ref: 'side' })
    write(dir, 'ledger/v1/entries/e_a.json', canonicalRecord(entry('a', 150, 2)))
    await commitAll(dir, 'local')
    await git.checkout({ fs, dir, ref: 'side' })
    write(dir, 'ledger/v1/entries/e_a.json', canonicalRecord(entry('a', 120, 3)))
    await commitAll(dir, 'remote')
    await git.checkout({ fs, dir, ref: 'main' })

    const captured: CapturedTriple[] = []
    await expect(merge(dir, 'side', driverFor(captured, false))).rejects.toMatchObject({ code: 'MergeConflictError' })
    expect(captured).toHaveLength(1)
    await git.abortMerge({ fs, dir })
  })
})

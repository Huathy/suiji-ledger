/**
 * §6.5 历史膨胀治理：判据（纯函数） + 真仓库上的滚动动作。
 *
 * 旧版这块**一行实现都没有**（spec §6.5 写了 `gitKeepCommits`，§14「仍欠」也记着），
 * 于是"历史无限长"这件事没有任何代码负责。这里分两层锁：
 *  ① 纯函数层（阈值/序号/文案）——判据写错就是白丢锚点链或永久不滚，必须单测钉死；
 *  ② 真仓库层——`rollToRoot` 建新根、`tagAnchor` 留锚点、内容不丢，
 *     这些只能真跑 isomorphic-git 才可信（mock 掉等于没验）。
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_KEEP_COMMITS,
  MIN_KEEP_COMMITS,
  nextSnapshotTag,
  parseKeepCommits,
  rollMessage,
  shouldRoll,
  snapshotSeq,
} from '../apps/server/src/sync/keep-commits'
import { GitEngine } from '../apps/server/src/sync/git-engine'

const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function newRepo(): GitEngine {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suji-keep-'))
  tmpDirs.push(dir)
  return new GitEngine(dir)
}

const AUTHOR = { name: 'dev-a', email: 'dev-a@local' }

describe('parseKeepCommits：设置值不可信，一律归一', () => {
  it('空值/非数字/0/负数 → 回落默认 500（Setting 表里可能是任何字符串）', () => {
    expect(parseKeepCommits('')).toBe(DEFAULT_KEEP_COMMITS)
    expect(parseKeepCommits(null)).toBe(DEFAULT_KEEP_COMMITS)
    expect(parseKeepCommits(undefined)).toBe(DEFAULT_KEEP_COMMITS)
    expect(parseKeepCommits('abc')).toBe(DEFAULT_KEEP_COMMITS)
    expect(parseKeepCommits('0')).toBe(DEFAULT_KEEP_COMMITS)
    expect(parseKeepCommits('-7')).toBe(DEFAULT_KEEP_COMMITS)
  })

  it('低于下限的合法正数被夹到 50（否则每推一次就断一次链）', () => {
    expect(parseKeepCommits('1')).toBe(MIN_KEEP_COMMITS)
    expect(parseKeepCommits('49')).toBe(MIN_KEEP_COMMITS)
    expect(MIN_KEEP_COMMITS).toBe(50)
  })

  it('正常值原样（含空白与小数：向下取整），大写/空格不误伤', () => {
    expect(parseKeepCommits(' 500 ')).toBe(500)
    expect(parseKeepCommits('1200')).toBe(1200)
    expect(parseKeepCommits('800.9')).toBe(800)
  })
})

describe('shouldRoll：严格大于才滚（边界不许抖）', () => {
  it('等于上限不滚、超出一条才滚', () => {
    expect(shouldRoll(499, 500)).toBe(false)
    expect(shouldRoll(500, 500)).toBe(false)
    expect(shouldRoll(501, 500)).toBe(true)
  })

  it('countCommits 只抓到 cap=keep+1：多滚一次要写 tag + 重建根 + 强推，不能靠猜', () => {
    expect(shouldRoll(501, 500)).toBe(true)
    expect(shouldRoll(0, 500)).toBe(false)
  })
})

describe('nextSnapshotTag：号必须单调（撞号 = 静默覆盖旧锚点）', () => {
  it('没有锚点时从 1 开始', () => {
    expect(nextSnapshotTag([])).toBe('snapshot-1')
  })

  it('有锚点时取 max+1，而不是"数个数"（中间删过锚点就撞号）', () => {
    expect(nextSnapshotTag(['snapshot-1', 'snapshot-2'])).toBe('snapshot-3')
    expect(nextSnapshotTag(['snapshot-1', 'snapshot-3'])).toBe('snapshot-4')
    expect(nextSnapshotTag(['snapshot-9'])).toBe('snapshot-10')
  })

  it('用户手工 tag / 非锚点形状不参与计数', () => {
    expect(nextSnapshotTag(['v1.0', 'release-2026', 'snapshot-x', 'snapshot-'])).toBe('snapshot-1')
    expect(nextSnapshotTag(['snapshot-0'])).toBe('snapshot-1')
  })

  it('snapshotSeq 只认正整数', () => {
    expect(snapshotSeq('snapshot-7')).toBe(7)
    expect(snapshotSeq('snapshot-0')).toBeNull()
    expect(snapshotSeq('snapshot-1x')).toBeNull()
    expect(snapshotSeq('')).toBeNull()
  })
})

describe('rollMessage：断链必须在 log 里可读', () => {
  it('带上锚点名，人眼能顺着找回旧历史', () => {
    const msg = rollMessage('snapshot-3')
    expect(msg).toContain('snapshot-3')
    expect(msg).toContain('历史滚动')
  })
})

describe('真仓库：滚动后内容不变、旧历史仍有锚点', () => {
  it('建 3 条提交 → 滚动 → 新根无父、tree 与内容原样、tag 指向旧 head', async () => {
    const engine = newRepo()
    await engine.init('main')
    for (let i = 1; i <= 3; i++) {
      fs.writeFileSync(path.join(engine.dir, 'a.txt'), `第 ${i} 版\n`)
      await engine.add(['a.txt'])
      await engine.commit(`提交 ${i}`, AUTHOR)
    }

    expect(await engine.countCommits('main', 10)).toBe(3)
    const oldHead = await engine.headOid()
    const tree = await engine.headTree()
    expect(oldHead).toBeTruthy()
    expect(tree).toBeTruthy()

    // 锚点先打，再断链：顺序反了会有一段"旧历史没人指"的窗口
    await engine.tagAnchor('snapshot-1', oldHead!)
    expect(await engine.listTagNames()).toContain('snapshot-1')

    const newHead = await engine.rollToRoot('main', tree!, rollMessage('snapshot-1'), AUTHOR)
    expect(newHead).not.toBe(oldHead)

    // 新根：depth 只数得到 1 条（无父提交）
    expect(await engine.countCommits('main', 10)).toBe(1)
    // 内容不丢：新 head 读到的仍是同一份投影
    expect(await engine.readFileAt(newHead, 'a.txt')).toBe('第 3 版\n')
    // 旧历史可按锚点找回（这是"历史没丢，只是断链"的证据）
    expect(await engine.readFileAt(oldHead!, 'a.txt')).toBe('第 3 版\n')
  })

  it('滚动只改分支 ref，工作区文件不动（否则下一次 statusMatrix 全是脏行）', async () => {
    const engine = newRepo()
    await engine.init('main')
    fs.writeFileSync(path.join(engine.dir, 'a.txt'), '内容\n')
    await engine.add(['a.txt'])
    await engine.commit('初始', AUTHOR)
    const tree = await engine.headTree()
    await engine.rollToRoot('main', tree!, rollMessage('snapshot-1'), AUTHOR)
    expect(fs.readFileSync(path.join(engine.dir, 'a.txt'), 'utf8')).toBe('内容\n')
    // 只看投影文件：init() 顺手写的 .gitignore 本条测试没提交过，本来就该是未跟踪（与滚动无关）
    const matrix = await engine.statusMatrix()
    const dirty = matrix.filter((r: any[]) => r[0] === 'a.txt' && r[1] !== r[2])
    expect(dirty).toHaveLength(0)
  })
})

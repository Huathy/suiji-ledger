/**
 * 「403 无限自动重试」的回归钉（本轮排查的六个根因，逐条锁死）：
 *  ① Gitee 校验 Basic 用户名必须等于令牌属主 → 写死 x-access-token 直接吃 403；
 *  ② 403 被 isNetworkError(HttpError) 误判成「离线」→ 显示"离线，稍后自动重试"；
 *  ③ 凭据/权限类失败不会随时间自愈 → 不该退避重试，该停手转人工；
 *  ④ every-commit 的 debounce 会绕过 nextRetryAt 把 retries 顶到几百 → 重试必须有上限；
 *  ⑤ 引擎内 snapshot('同步前') 反向触发同步 = 5 秒自激环（452 次就是这么来的）；
 *  ⑥ 修好 403 之后会撞上"本地与远端历史无关"→ MergeNotSupportedError，数据仍推不上去。
 *
 * 直接驱动 markFailure / pullMerge（失败定性与合并决策的唯一落点）而非整条 runInner：
 * 后者要塞满 7 个 mock 还得造 git 仓，语义却只在这两处。
 */
import { describe, it, expect, vi } from 'vitest'
import { SyncService } from '../apps/server/src/sync/sync.service'
import { GitEngine, defaultAuthUser } from '../apps/server/src/sync/git-engine'
import { backoffMinutes, isPermanentFailure, MAX_AUTO_RETRIES, permanentFailureHint, shouldHalt } from '../apps/server/src/sync/schedule'

const OID = (c: string) => c.repeat(40)

// ---------------- ① 用户名按 host 判定 ----------------

describe('defaultAuthUser · PAT 的 Basic 用户名按远端 host 选', () => {
  it('Gitee 必须 oauth2（写死 x-access-token 会被拒 403）', () => {
    expect(defaultAuthUser('https://gitee.com/huathy/mydata')).toBe('oauth2')
    expect(defaultAuthUser('https://gitee.com/huathy/mydata.git')).toBe('oauth2')
    expect(defaultAuthUser('https://www.gitee.com/a/b.git')).toBe('oauth2')
  })

  it('GitLab 也走 oauth2；GitHub / Gitea / 自建保留 x-access-token', () => {
    expect(defaultAuthUser('https://gitlab.com/a/b.git')).toBe('oauth2')
    expect(defaultAuthUser('https://self-hosted.gitlab.example/a/b.git')).toBe('oauth2')
    expect(defaultAuthUser('https://github.com/Huathy/x.git')).toBe('x-access-token')
    expect(defaultAuthUser('https://gitea.example.com/a/b.git')).toBe('x-access-token')
  })

  it('地址读不懂时退回 GitHub 习惯值，不破坏既有用户', () => {
    expect(defaultAuthUser('')).toBe('x-access-token')
    expect(defaultAuthUser(null)).toBe('x-access-token')
    expect(defaultAuthUser('git@github.com:a/b.git')).toBe('x-access-token')
    expect(defaultAuthUser('http://154.8.227.13:16000/a/b.git')).toBe('x-access-token')
  })

  it('onAuth 用 setRemote 记下的地址挑用户名；配置显式给了就听配置的', async () => {
    const e = new GitEngine('/tmp/whatever', { token: 'tok' })
    await e.setRemote('https://gitee.com/huathy/mydata').catch(() => undefined) // 无 .git 会抛，remoteUrl 已先记上
    expect((e as any).onAuth()).toEqual({ username: 'oauth2', password: 'tok' })

    const forced = new GitEngine('/tmp/whatever', { token: 'tok', username: 'huathy' })
    await forced.setRemote('https://gitee.com/huathy/mydata').catch(() => undefined)
    expect((forced as any).onAuth().username).toBe('huathy')

    const gh = new GitEngine('/tmp/whatever', { token: 'tok' })
    await gh.setRemote('https://github.com/Huathy/x.git').catch(() => undefined)
    expect((gh as any).onAuth().username).toBe('x-access-token')
  })
})

// ---------------- ②③ 永久性失败定性 ----------------

describe('isPermanentFailure · 哪些失败重试也不会变成功', () => {
  it('401/403/404 优先按状态码判（isomorphic-git 放在 data.statusCode）', () => {
    expect(isPermanentFailure(403, 'HTTP Error: 403 Forbidden')).toBe(true)
    expect(isPermanentFailure(401, 'HTTP Error: 401 Unauthorized')).toBe(true)
    expect(isPermanentFailure(404, 'HTTP Error: 404 Not Found')).toBe(true)
  })

  it('拿不到状态码时认消息里的 HTTP Error 前缀与凭据类原文', () => {
    expect(isPermanentFailure(null, 'HTTP Error: 403 Forbidden')).toBe(true)
    expect(isPermanentFailure(null, 'remote: [session-ab12] The token username invalid')).toBe(true)
    expect(isPermanentFailure(null, 'HTTP Error: 404 Project not found')).toBe(true)
  })

  it('暂时性失败绝不归为永久（误判会停手，那是更坏的错）', () => {
    expect(isPermanentFailure(null, 'HTTP Error: 429 Too Many Requests')).toBe(false)
    expect(isPermanentFailure(503, 'HTTP Error: 503 Service Unavailable')).toBe(false)
    expect(isPermanentFailure(null, 'connect ETIMEDOUT 122.207.224.114:443')).toBe(false)
    expect(isPermanentFailure(null, 'getaddrinfo ENOTFOUND gitee.com')).toBe(false)
    expect(isPermanentFailure(null, 'socket hang up')).toBe(false)
    // 端口号 / 毫秒数里带 403/404 字样也不能误判
    expect(isPermanentFailure(null, 'http://127.0.0.1:4030/api git fetch timeout 4040ms')).toBe(false)
  })

  it('定性文案给出可执行的下一步', () => {
    expect(permanentFailureHint('HTTP Error: 403 Forbidden')).toMatch('oauth2')
    expect(permanentFailureHint('HTTP Error: 404 Not Found')).toMatch('分支')
    expect(permanentFailureHint('HTTP Error: 401 Unauthorized')).toMatch('PAT')
  })
})

describe('MAX_AUTO_RETRIES · 自动重试有上限', () => {
  it('三次封顶：第 3 次起停手（>= 而非 ===，旧库带着高计数也能跨过去）', () => {
    expect(MAX_AUTO_RETRIES).toBe(3)
    expect([0, 1, 2].map(shouldHalt)).toEqual([false, false, false])
    expect([3, 4, 452].map(shouldHalt)).toEqual([true, true, true])
  })

  it('退避尺不变（1/5/15/30 封顶）', () => {
    expect([0, 1, 2, 3, 9].map(backoffMinutes)).toEqual([1, 5, 15, 30, 30])
  })
})

// ---------------- 失败定性的落库形状 ----------------

describe('markFailure · 状态机落点', () => {
  type Patch = Record<string, unknown>
  function mk(retries = 0) {
    const patches: Patch[] = []
    const cfg: any = {
      state: vi.fn(async () => ({ state: 'idle', lastSyncAt: null, lastError: null, pendingCommits: 0, retries, nextRetryAt: null, lastCommitOid: null })),
      setState: vi.fn(async (p: Patch) => {
        patches.push(p)
        return { ...(p as any) }
      }),
    }
    const svc: any = new SyncService({} as any, {} as any, {} as any, {} as any, cfg, {} as any, {} as any)
    return { svc, patches }
  }
  const last = (patches: Patch[]) => patches[patches.length - 1]

  it('403 → halted，且 nextRetryAt 归零（tick 与 debounce 都无从排重试）', async () => {
    const { svc, patches } = mk(452)
    const r = await svc.markFailure('offline', 'HTTP Error: 403 Forbidden', { auto: true, statusCode: 403 })
    expect(r.reason).toBe('halted')
    expect(r.halted).toBe(true)
    expect(last(patches).state).toBe('halted')
    expect(last(patches).nextRetryAt).toBeNull()
    expect(String(last(patches).lastError)).toContain('已停止自动重试')
  })

  it('手动点击失败不推高 retries、不排退避（除非手动点击）', async () => {
    const { svc, patches } = mk(0)
    const r = await svc.markFailure('error', 'HTTP Error: 500 boom', { auto: false, statusCode: null })
    expect(r.reason).toBe('error')
    expect(last(patches).nextRetryAt).toBeNull()
    expect(last(patches).retries).toBeUndefined() // 手动失败不 +1
  })

  it('自动暂时性失败：未封顶走退避，达封顶转 halted', async () => {
    const a = mk(0)
    const ra = await a.svc.markFailure('offline', 'connect ETIMEDOUT', { auto: true, statusCode: null })
    expect(ra.reason).toBe('offline')
    expect(ra.retries).toBe(1)
    expect(a.patches[0].nextRetryAt).toBeGreaterThan(Date.now())

    const b = mk(MAX_AUTO_RETRIES - 1)
    const rb = await b.svc.markFailure('offline', 'connect ETIMEDOUT', { auto: true, statusCode: null })
    expect(rb.reason).toBe('halted')
    expect(rb.retries).toBe(MAX_AUTO_RETRIES)
    expect(b.patches[0].nextRetryAt).toBeNull()
  })
})

// ---------------- ④ halted 态的调度闸门 ----------------

describe('halted 态不再自动重试', () => {
  const base = (state: string, retries = 99) => ({
    state,
    lastSyncAt: null,
    lastError: 'HTTP Error: 403 Forbidden',
    pendingCommits: 1,
    retries,
    nextRetryAt: null,
    lastCommitOid: null,
  })

  function mkSvc(st: any) {
    const cfg: any = {
      remote: vi.fn(async () => 'https://gitee.com/huathy/mydata'),
      conflictState: vi.fn(async () => null),
      state: vi.fn(async () => st),
      setState: vi.fn(async () => st),
      pushMode: vi.fn(async () => 'every-commit'),
    }
    // backup/meta 给最小可用替身：runInner 第一步就是 snapshot(..., {notify:false})，
    // 缺它会抛错并被 markFailure 吞成"退避重试"，掩盖这里要钉的门禁行为。
    const backup: any = { onSnapshot: vi.fn(), snapshot: vi.fn(async () => undefined) }
    const meta: any = { deviceId: vi.fn(async () => 'd_test'), bump: vi.fn(async () => ({ rev: 1 })) }
    const svc: any = new SyncService({} as any, { recomputeAuto: vi.fn() } as any, backup, meta, cfg, {} as any, {} as any)
    const spy = vi.spyOn(svc, 'runInner')
    return { svc, spy }
  }

  it('tick 见 halted 直接返回：一次 run 都不排', async () => {
    const { svc, spy } = mkSvc(base('halted'))
    await svc.tick()
    expect(spy).not.toHaveBeenCalled()
  })

  it('tick 见 offline 但没排退避时刻（手动失败的形状）也不重试', async () => {
    const { svc, spy } = mkSvc(base('offline'))
    await svc.tick()
    expect(spy).not.toHaveBeenCalled()
  })

  it('tick 见 offline 且退避到点 → 才重试一次', async () => {
    const { svc, spy } = mkSvc({ ...base('offline'), nextRetryAt: Date.now() - 1000 })
    spy.mockImplementation(async () => ({ ok: true })) // 只钉"该不该排这次 run"，主体不真跑
    await svc.tick()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(String(spy.mock.calls[0][0].reason)).toMatch(/离线重试|失败重试/)
  })

  it('every-commit 在 halted 下排的是 localOnly（只本地提交，不碰网络）', async () => {
    const cfg: any = {
      autoCommit: vi.fn(async () => true),
      remote: vi.fn(async () => 'https://gitee.com/huathy/mydata'),
      pushMode: vi.fn(async () => 'every-commit'),
      state: vi.fn(async () => ({ state: 'halted', retries: 9, nextRetryAt: null })),
    }
    const svc: any = new SyncService({} as any, {} as any, {} as any, {} as any, cfg, {} as any, {} as any)
    const spy = vi.spyOn(svc, 'scheduleDebounce')
    svc.handleSnapshot('新增大项')
    await new Promise((r) => setTimeout(r, 0))
    expect(spy).toHaveBeenCalledWith('新增大项', false, true)

    cfg.state = vi.fn(async () => ({ state: 'idle', retries: 0, nextRetryAt: null }))
    svc.scheduleDebounce.mockClear()
    svc.handleSnapshot('平账 2026-11')
    await new Promise((r) => setTimeout(r, 0))
    expect(svc.scheduleDebounce).toHaveBeenCalledWith('平账 2026-11', false, false)
  })

  it('debounce 撞上 halted → 进门即返回，不碰引擎（不 fetch / 不投影 / 不 push）', async () => {
    const { svc } = mkSvc(base('halted'))
    const project: any = { engine: vi.fn(), writeAll: vi.fn(), commitAll: vi.fn() }
    svc.project = project
    const r = await svc.run({ reason: '新增大项', localOnly: false })
    expect(r.reason).toBe('halted')
    expect(r.ok).toBe(false)
    expect(project.engine).not.toHaveBeenCalled() // 真碰网络的第一步
    expect(project.writeAll).not.toHaveBeenCalled()
  })

  it('用户点击（userInitiated）是解除 halted 的唯一入口', async () => {
    const { svc, spy } = mkSvc(base('halted'))
    spy.mockImplementation(async () => ({ ok: true }))
    const r = await svc.run({ userInitiated: true })
    expect(r.ok).toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('isAutoRun：只有带 reason 且非手动/非分程才算自动', () => {
    const svc: any = new SyncService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any)
    expect(svc.isAutoRun({ reason: '离线重试' })).toBe(true)
    expect(svc.isAutoRun({ reason: '新增大项' })).toBe(true)
    expect(svc.isAutoRun({})).toBe(false) // 用户点「立即同步」
    expect(svc.isAutoRun({ phase: 'push' })).toBe(false)
    expect(svc.isAutoRun({ reason: '每日同步', userInitiated: true })).toBe(false)
  })
})

// ---------------- ⑥ 第二道墙：修好 403 之后撞上"历史无关" ----------------

describe('pullMerge · 本地与远端历史无关时认领远端，而不是死在 MergeNotSupportedError', () => {
  // 现网实测：首次同步那次 403 让本地自建的孤立提交留了下来，
  // 之后每次 merge 都抛 MergeNotSupportedError（既不像断网也不像权限）：
  // 定性成 error → 退避到封顶 → 数据永远推不上去。
  function mkPull(mergeBaseResult: string | null) {
    const calls: string[] = []
    const engine: any = {
      fetch: vi.fn(async () => { calls.push('fetch'); return {} }),
      remoteOid: vi.fn(async () => OID('r')),
      headOid: vi.fn(async () => OID('l')),
      mergeBase: vi.fn(async () => mergeBaseResult),
      adoptRemote: vi.fn(async () => { calls.push('adoptRemote') }),
      merge: vi.fn(async () => { calls.push('merge'); return { oid: OID('m') } }),
      abortMerge: vi.fn(async () => undefined),
      listFiles: vi.fn(async () => []),
      readFileAt: vi.fn(async () => null),
    }
    const cfg: any = {
      mergeEnabled: vi.fn(async () => true),
      encrypt: vi.fn(async () => false),
      state: vi.fn(async () => ({ state: 'idle', retries: 0, lastError: null })),
      setState: vi.fn(async () => undefined),
      setConflictState: vi.fn(async () => undefined),
    }
    const project: any = {
      engine: vi.fn(async () => engine),
      writeAll: vi.fn(async () => ({ files: 1, written: [] })),
      commitAll: vi.fn(async () => OID('n')),
    }
    const svc: any = new SyncService(
      {} as any,
      { recomputeAuto: vi.fn() } as any,
      {} as any,
      { deviceId: vi.fn(async () => 'd_test') } as any,
      cfg,
      project,
      { apply: vi.fn(async () => ({ ym: null })) } as any,
    )
    return { svc, calls, project }
  }

  it('无共同祖先 → adoptRemote + 重投影 + 接管提交，绝不进 merge', async () => {
    const { svc, calls, project } = mkPull(null)
    const engine = await svc.project.engine()
    const r = await svc.pullMerge(engine, 'suiqi-ledger')
    // 返回值自 v0.6.3 起带 theirsOid（租约基准要"远端此刻的 oid"，本地 head 不算）：
    // 接管路径的远端就是被认领的那个 oid。
    expect(r.result).toBe('clean')
    expect(r.theirsOid).toBe(OID('r'))
    expect(calls).toEqual(expect.arrayContaining(['fetch', 'adoptRemote']))
    expect(calls).not.toContain('merge')
    expect(project.writeAll).toHaveBeenCalled()
    expect(String(project.commitAll.mock.calls[0][0])).toMatch('接管远端历史')
  })

  it('有共同祖先 → 走正常 merge，认领路径一次都不碰', async () => {
    const { svc, calls } = mkPull(OID('b'))
    const engine = await svc.project.engine()
    const r = await svc.pullMerge(engine, 'suiqi-ledger')
    expect(r.result).toBe('clean')
    // 合并后远端仍是 theirs（我们还没推），租约基准就该记它而不是本地 head
    expect(r.theirsOid).toBe(OID('r'))
    expect(calls).toContain('merge')
    expect(calls).not.toContain('adoptRemote')
  })
})

// ---------------- ⑤ 自激环：引擎内快照不许叫醒同步 ----------------

describe('BackupService.snapshot(notify:false) 切断同步自激环', () => {
  it('notify:false 只落盘不广播；默认仍广播', async () => {
    const { BackupService } = await import('../apps/server/src/backup.service')
    const prisma: any = {
      recordType: { findMany: vi.fn(async () => []) },
      account: { findMany: vi.fn(async () => []) },
      monthlySnapshot: { findMany: vi.fn(async () => []) },
      changeEntry: { findMany: vi.fn(async () => []) },
      loan: { findMany: vi.fn(async () => []) },
      setting: { findMany: vi.fn(async () => []) },
    }
    const svc: any = new BackupService(prisma)
    const seen: string[] = []
    svc.onSnapshot((reason: string) => seen.push(reason))
    await svc.snapshot('同步前', { notify: false })
    expect(seen).toEqual([])
    await svc.snapshot('新增大项')
    expect(seen).toEqual(['新增大项'])
  })
})

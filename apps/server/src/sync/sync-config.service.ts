import { Injectable } from '@nestjs/common'
import path from 'node:path'
import { PrismaService } from '../prisma.service'
import { DATA_DIR } from '../env'
import { decryptSecret, encryptSecret } from './crypto'
import { parseKeepCommits } from './keep-commits'

/** 同步相关的设置键（都存 Setting 表，**都不投影进 git**） */
export const SYNC_KEYS = {
  remote: 'gitRemote',
  branch: 'gitBranch',
  auth: 'gitAuth',
  authEnc: 'gitAuthEnc',
  /** Basic 用户名覆盖（Gitee 需要 login/oauth2；留空则按 host 自动判定） */
  authUser: 'gitAuthUser',
  pushMode: 'gitPushMode',
  encrypt: 'gitEncrypt',
  mergeEnabled: 'gitMergeEnabled',
  autoCommit: 'gitAutoCommit',
  deviceId: 'gitDeviceId',
  lastRemoteOid: 'gitLastRemoteOid',
  maxRev: 'gitMaxRev',
  /** §6.5 历史膨胀治理：提交条数超过它就把分支滚到新根（默认 500，见 keep-commits.ts） */
  keepCommits: 'gitKeepCommits',
  state: 'gitSyncState',
  conflict: 'gitConflictState',
} as const

// 'pending' 已删（评审修复项 Speculative Generality）：后端从不写入该值，前端分支永远打不到；
// "待推送"语义由 idle + pendingCommits>0 表达。
/**
 * 'halted' = 自动重试已封顶（次数达上限）或失败定性为**永久性**（凭据/权限/地址错）。
 * 与 offline/error 的区别：这一态 tick 与 every-commit 的 debounce 都**不再排重试**，
 * 只等用户修正配置后点「立即同步」（手动路径会清零 retries 再跑）。
 */
export type SyncRunState = 'unconfigured' | 'idle' | 'syncing' | 'offline' | 'conflict' | 'error' | 'halted'

export type SyncStateSnapshot = {
  state: SyncRunState
  lastSyncAt: number | null
  lastError: string | null
  pendingCommits: number
  retries: number
  nextRetryAt: number | null
  lastCommitOid: string | null
  /** 转入 halted 的时刻（秒）。只用于「停在 halted 多久了」的人话展示，不参与调度判定 */
  lastHaltedAt?: number | null
  /**
   * 评审修复项（死字段）：§6.1 的 `mode` 不在这里落库。
   * 它完全由 mergeEnabled/encrypt 两个开关推导（本服务的 mergeEnabled() 已含后端强制联动），
   * 再存一份就是第二份真相，且旧版定义了从不写入。/status 现算现返回。
   */
}

@Injectable()
export class SyncConfigService {
  constructor(private prisma: PrismaService) {}

  repoDir(): string {
    return path.join(DATA_DIR, 'git')
  }

  async get(key: string, def = ''): Promise<string> {
    const row = await this.prisma.setting.findUnique({ where: { key } })
    return row?.value ?? def
  }

  async set(key: string, value: string): Promise<void> {
    await this.prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } })
  }

  async all(): Promise<Record<string, string>> {
    const rows = await this.prisma.setting.findMany()
    return Object.fromEntries(rows.map((r) => [r.key, r.value]))
  }

  async branch(): Promise<string> {
    return (await this.get(SYNC_KEYS.branch, 'main')) || 'main'
  }

  async remote(): Promise<string> {
    return (await this.get(SYNC_KEYS.remote, '')).trim()
  }

  /**
   * Basic 用户名（可选覆盖）。留空 → GitEngine 按远端 host 自动挑
   * （Gitee/GitLab = `oauth2`，其余 = `x-access-token`）。
   * 给自建/反代这类不认默认值的场景留一个口子，不必改代码。
   */
  async authUser(): Promise<string> {
    return (await this.get(SYNC_KEYS.authUser, '')).trim()
  }

  /** 加密开启 = 整份密文（只有一档，§7.1） */
  async encrypt(): Promise<boolean> {
    return (await this.get(SYNC_KEYS.encrypt, 'off')) === 'on'
  }

  /**
   * 可合并：默认 on；加密开启时**强制 off**（后端联动，不能只靠前端）。
   * 这样即便有人绕过 UI 直接写库，也不会出现"加密仓还在跑语义合并"的自相矛盾状态。
   */
  async mergeEnabled(): Promise<boolean> {
    if (await this.encrypt()) return false
    return (await this.get(SYNC_KEYS.mergeEnabled, 'on')) !== 'off'
  }

  async pushMode(): Promise<'every-commit' | 'daily' | 'manual'> {
    const v = await this.get(SYNC_KEYS.pushMode, 'daily')
    return v === 'every-commit' || v === 'manual' ? v : 'daily'
  }

  async autoCommit(): Promise<boolean> {
    return (await this.get(SYNC_KEYS.autoCommit, 'on')) !== 'off'
  }

  /**
   * §6.5 保留提交条数。解析与夹取全在 keep-commits.ts（纯函数可单测）：
   * 这里只负责把 Setting 表的字符串递过去，不做"看着像数字就当数字"的临场判断。
   */
  async keepCommits(): Promise<number> {
    return parseKeepCommits(await this.get(SYNC_KEYS.keepCommits, ''))
  }

  /**
   * PAT：只认密文键。
   * 旧明文键（docs/21 §7.2「旧明文键迁移时清空」）：若密文缺失而明文存在，
   * 就地把明文加密迁移到 gitAuthEnc 并清空明文键；解密失败（密钥换了）则两键一起清，
   * 表现为"未配置"而不是继续拿着明文走网络。
   */
  async token(): Promise<string> {
    const enc = await this.get(SYNC_KEYS.authEnc, '')
    if (enc) {
      try {
        return decryptSecret(enc)
      } catch {
        await this.set(SYNC_KEYS.authEnc, '') // 密钥换了 = 解不开，等同未配置；顺手清烂数据
        return ''
      }
    }
    const legacy = await this.get(SYNC_KEYS.auth, '')
    if (legacy) {
      await this.set(SYNC_KEYS.authEnc, encryptSecret(legacy))
      await this.set(SYNC_KEYS.auth, '') // 迁移即清空：明文键从此不留值（system.service putSettings 同语义）
    }
    return legacy
  }

  async state(): Promise<SyncStateSnapshot> {
    const raw = await this.get(SYNC_KEYS.state, '')
    const base: SyncStateSnapshot = {
      state: 'idle',
      lastSyncAt: null,
      lastError: null,
      pendingCommits: 0,
      retries: 0,
      nextRetryAt: null,
      lastCommitOid: null,
    }
    if (!raw) return base
    try {
      return { ...base, ...JSON.parse(raw) }
    } catch {
      return base
    }
  }

  async setState(patch: Partial<SyncStateSnapshot>): Promise<SyncStateSnapshot> {
    const next = { ...(await this.state()), ...patch }
    await this.set(SYNC_KEYS.state, JSON.stringify(next))
    return next
  }

  async conflictState<T = any>(): Promise<T | null> {
    const raw = await this.get(SYNC_KEYS.conflict, '')
    if (!raw) return null
    try {
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }

  async setConflictState(v: any | null): Promise<void> {
    if (!v) {
      await this.set(SYNC_KEYS.conflict, '')
      return
    }
    await this.set(SYNC_KEYS.conflict, JSON.stringify(v))
  }

  async lastRemoteOid(): Promise<string> {
    return await this.get(SYNC_KEYS.lastRemoteOid, '')
  }

  async setLastRemoteOid(oid: string): Promise<void> {
    await this.set(SYNC_KEYS.lastRemoteOid, oid)
  }
}

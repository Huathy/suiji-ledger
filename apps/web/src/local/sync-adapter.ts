/**
 * 离线同步适配器：把 backend.ts 的 Db 接到 sync-run.ts 的 RunDeps 上。
 *
 * 单例 + 懒引擎：GitEngineLocal 在首次同步操作时创建（lightning-fs 开库有成本）。
 * 配置存 settings（gitRemote/gitBranch/gitToken/gitAuthUser/gitPushMode/gitEncrypt/gitMergeEnabled/gitAutoCommit/gitKeepCommits），
 * 与服务端 Setting 键同名（git.key 不进同步投影，只留本机）。
 */
import { GitEngineLocal, type GitAuth } from './sync-engine'
import { decryptSecretLocal, encryptSecretLocal, keyHintLocal, maskSecretLocal, setGitKey } from './sync-crypto'
import { writeAllLocal, stageAllLocal } from './sync-project'
import { applyRecord, APPLY_ORDER, type ApplyDb } from './sync-apply'
import type { LedgerRecord } from './sync-shared'
import { parseKeepCommits, DEFAULT_KEEP_COMMITS } from './sync-shared'
import type { Cfg, ConflictItem, RunDeps, StoredConflict, SyncStateSnapshot } from './sync-run'

type DbLike = {
  types: any[]
  accounts: any[]
  snapshots: any[]
  entries: any[]
  loans: any[]
  trash: any[]
  settings: Record<string, string>
  seq: number
}

type Hooks = {
  load: () => DbLike
  nextId: () => number
  recomputeYm: (ym: string) => void
  backup: (reason: string) => void
  trashKinds: (kind: string) => void
  persist: () => void
}

let hooks: Hooks | null = null
export function setSyncAdapterHooks(h: Hooks) {
  hooks = h
}
function H(): Hooks {
  if (!hooks) throw new Error('sync-adapter 未初始化')
  return hooks
}
function db(): DbLike {
  return H().load()
}
function save() {
  H().persist()
}

let engine: GitEngineLocal | null = null
let state: SyncStateSnapshot = { state: 'idle', lastSyncAt: null, lastError: null, pendingCommits: 0, retries: 0, nextRetryAt: null, lastCommitOid: null }
let conflict: StoredConflict | null = null
let lastRemoteOid = ''
let cfgCache: Cfg | null = null
let cfgKey = ''

const SECRET_SETTINGS = new Set(['gitAuth', 'gitAuthEnc', 'gitConflictState', 'gitSyncState'])

function readCfg(): Cfg {
  const d = db()
  const key = JSON.stringify([d.settings.gitRemote, d.settings.gitBranch, d.settings.gitPushMode, d.settings.gitEncrypt, d.settings.gitMergeEnabled, d.settings.gitAutoCommit, d.settings.gitKeepCommits])
  if (cfgCache && cfgKey === key) return cfgCache
  const remote = (d.settings.gitRemote || '').trim()
  const branch = (d.settings.gitBranch || 'main').trim() || 'main'
  let token = ''
  const enc = d.settings.gitAuthEnc || ''
  if (enc) {
    try {
      token = decryptSecretLocal(enc)
    } catch { /* 密钥换过则解不出，当未配 */ }
  } else {
    token = d.settings.gitAuth || ''
  }
  const authUser = (d.settings.gitAuthUser || '').trim()
  const pushMode = d.settings.gitPushMode === 'every-commit' || d.settings.gitPushMode === 'daily' ? d.settings.gitPushMode : 'manual'
  const cfg: Cfg = {
    remote,
    branch,
    token,
    authUser,
    pushMode,
    encrypt: d.settings.gitEncrypt === 'on',
    mergeEnabled: d.settings.gitMergeEnabled !== 'off',
    autoCommit: d.settings.gitAutoCommit !== 'off',
    keepCommits: parseKeepCommits(d.settings.gitKeepCommits ?? null),
  }
  cfgCache = cfg
  cfgKey = key
  engine = null
  return cfg
}

export function getEngine(): GitEngineLocal {
  const c = readCfg()
  if (!engine) {
    const auth: GitAuth = c.token ? { token: c.token, username: c.authUser || undefined } : null
    engine = new GitEngineLocal(auth)
  }
  return engine
}

export function resetEngine() {
  engine = null
  cfgCache = null
}

function deviceId(): string {
  return db().settings.gitDeviceId || 'd_tmp'
}

function loadSyncState(): SyncStateSnapshot {
  try {
    const raw = db().settings.gitSyncState
    if (raw) {
      const s = JSON.parse(raw)
      state = { ...state, ...s }
    }
  } catch { /* 损坏则用默认 */ }
  return state
}
function saveSyncState() {
  try {
    db().settings.gitSyncState = JSON.stringify({
      state: state.state,
      lastSyncAt: state.lastSyncAt,
      lastError: state.lastError,
      pendingCommits: state.pendingCommits,
      retries: state.retries,
      nextRetryAt: state.nextRetryAt,
      lastCommitOid: state.lastCommitOid,
      lastHaltedAt: state.lastHaltedAt ?? null,
    })
    save()
  } catch { /* 忽略 */ }
}

function loadConflict(): StoredConflict | null {
  try {
    const raw = db().settings.gitConflictState
    if (raw) conflict = JSON.parse(raw)
    else if (conflict && !raw) conflict = null
  } catch {
    conflict = null
  }
  return conflict
}
function saveConflict() {
  try {
    if (conflict) db().settings.gitConflictState = JSON.stringify(conflict)
    else delete db().settings.gitConflictState
    save()
  } catch { /* 忽略 */ }
}

function loadRemoteOid(): string {
  lastRemoteOid = db().settings.gitLastRemoteOid || ''
  return lastRemoteOid
}
function saveRemoteOid(oid: string) {
  lastRemoteOid = oid
  try {
    db().settings.gitLastRemoteOid = oid
    save()
  } catch { /* 忽略 */ }
}

function viewOf() {
  const d = db()
  const typeById = new Map(d.types.map((t: any) => [t.id, t.uid]))
  const accById = new Map(d.accounts.map((a: any) => [a.id, a.uid]))
  return {
    types: d.types,
    accounts: d.accounts,
    snapshots: d.snapshots,
    entries: d.entries,
    loans: d.loans,
    settings: d.settings,
    typeUid: (id: number) => typeById.get(id) ?? null,
    accUid: (id: number) => accById.get(id) ?? null,
  }
}

function applyDbOf(): ApplyDb & { settings: Record<string, string> } {
  const d = db()
  return {
    types: d.types,
    accounts: d.accounts,
    snapshots: d.snapshots,
    entries: d.entries,
    loans: d.loans,
    settings: d.settings,
    noteSeen(rev: number) {
      const cur = Number(d.settings.gitMaxRev || 0) || 0
      if (rev > cur) {
        d.settings.gitMaxRev = String(rev)
        save()
      }
    },
    nextId() {
      return H().nextId()
    },
    persist() {
      save()
    },
    recomputeYm(ym: string) {
      H().recomputeYm(ym)
    },
    pushTrash(kind: string, summary: string, payload: any) {
      d.trash.push({ id: H().nextId(), kind, summary, payload, deletedAt: Date.now() })
      save()
    },
  }
}

export function deps(): RunDeps {
  loadSyncState()
  loadConflict()
  loadRemoteOid()
  return {
    engine: getEngine,
    cfg: readCfg,
    db: applyDbOf,
    deviceId,
    state: () => state,
    setState(patch) {
      state = { ...state, ...patch }
      saveSyncState()
      return state
    },
    conflict: () => conflict,
    setConflict(v) {
      conflict = v
      saveConflict()
    },
    lastRemoteOid: () => lastRemoteOid,
    setLastRemoteOid(oid: string) {
      saveRemoteOid(oid)
    },
    async projectWriteAll() {
      const c = readCfg()
      const res = await writeAllLocal(getEngine(), viewOf(), c.encrypt, deviceId(), c.branch)
      save()
      return res
    },
    async projectCommitAll(message: string) {
      const eng = getEngine()
      const changed = await stageAllLocal(eng)
      if (!changed && (await eng.headOid())) return null
      const oid = await eng.commit(message, { name: deviceId(), email: `${deviceId()}@local` })
      save()
      return oid
    },
    async absorb(oid: string) {
      const eng = getEngine()
      const c = readCfg()
      const files = await eng.listFiles(oid)
      const { decodeRecordLocal } = await import('./sync-shared')
      const recs: LedgerRecord[] = []
      const problems: string[] = []
      const dropped: string[] = []
      for (const fp of files) {
        const fileName = fp.slice(fp.lastIndexOf('/') + 1)
        const text = await eng.readFileAt(oid, fp)
        if (text === null) continue
        const parsed = decodeRecordLocal(text, fileName)
        if (!parsed.ok) {
          if (parsed.reason === 'encrypted') {
            problems.push(`${fileName}：远端已加密，本机解不开（先配同一密钥）`)
          } else {
            dropped.push(fileName)
          }
          continue
        }
        recs.push(parsed.rec)
      }
      const adb = applyDbOf()
      const yms = new Set<string>()
      for (const kind of APPLY_ORDER) {
        for (const rec of recs) {
          if (rec.kind !== kind) continue
          const r = await applyRecord(adb, rec)
          if (r.warning) problems.push(r.warning)
          if (r.ym) yms.add(r.ym)
        }
      }
      const maxSeen = Number(db().settings.gitMaxRev || 0) || 0
      for (const ym of yms) H().recomputeYm(ym)
      save()
      return { yms: [...yms], problems, dropped, maxSeen }
    },
    recomputeYm(ym: string) {
      H().recomputeYm(ym)
    },
    recycle(kind: string, summary: string, payload: any) {
      db().trash.push({ id: H().nextId(), kind: kind as any, summary, payload, deletedAt: Date.now() })
      save()
    },
  }
}

export function toSharedConflict(c: ConflictItem): any {
  return { key: c.key, title: c.title, kind: c.kind, conflictType: c.conflictType, fields: c.fields, recommend: c.recommend, reason: c.reason }
}

/** 配置读写（settings 路由用）：token 只存密文 gitAuthEnc，读只回掩码 */
export function readSyncSettings(settings?: Record<string, string>) {
  const d = settings ? ({ settings } as DbLike) : db()
  const hasToken = !!(d.settings.gitAuthEnc || d.settings.gitAuth)
  return {
    remote: d.settings.gitRemote || '',
    branch: d.settings.gitBranch || 'main',
    authUser: d.settings.gitAuthUser || '',
    pushMode: d.settings.gitPushMode || 'manual',
    mergeEnabled: d.settings.gitMergeEnabled !== 'off',
    encrypt: d.settings.gitEncrypt === 'on',
    autoCommit: d.settings.gitAutoCommit !== 'off',
    keepCommits: parseKeepCommits(d.settings.gitKeepCommits ?? null),
    hasToken,
    keyHint: (() => { try { return keyHintLocal() } catch { return '' } })(),
  }
}

export function maskToken(settings?: Record<string, string>): string {
  const d = settings ? ({ settings } as DbLike) : db()
  const enc = d.settings.gitAuthEnc || ''
  if (!enc) return d.settings.gitAuth ? maskSecretLocal(d.settings.gitAuth) : ''
  try {
    return maskSecretLocal(decryptSecretLocal(enc))
  } catch {
    return '已配置（当前密钥解不开）'
  }
}

export function writeSyncSettings(input: Record<string, any>) {
  const d = db()
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) if (input[k] !== undefined) return String(input[k])
    return undefined
  }
  // 兼容 SyncView 的 settings 键名（gitRemote/gitBranch/…）与内部短键（remote/branch/…）
  const remote = pick('gitRemote', 'remote')
  if (remote !== undefined) d.settings.gitRemote = remote.trim()
  const branch = pick('gitBranch', 'branch')
  if (branch !== undefined) d.settings.gitBranch = branch.trim() || 'main'
  const authUser = pick('gitAuthUser', 'authUser')
  if (authUser !== undefined) d.settings.gitAuthUser = authUser.trim()
  const pushMode = pick('gitPushMode', 'pushMode')
  if (pushMode !== undefined) d.settings.gitPushMode = pushMode
  const mergeEnabled = pick('gitMergeEnabled', 'mergeEnabled')
  if (mergeEnabled !== undefined) d.settings.gitMergeEnabled = mergeEnabled ? 'on' : 'off'
  const encrypt = pick('gitEncrypt', 'encrypt')
  if (encrypt !== undefined) d.settings.gitEncrypt = encrypt ? 'on' : 'off'
  const autoCommit = pick('gitAutoCommit', 'autoCommit')
  if (autoCommit !== undefined) d.settings.gitAutoCommit = autoCommit ? 'on' : 'off'
  const keepCommits = pick('gitKeepCommits', 'keepCommits')
  if (keepCommits !== undefined) d.settings.gitKeepCommits = String(keepCommits)
  if (input.token !== undefined) {
    const t = String(input.token || '').trim()
    if (t) {
      d.settings.gitAuthEnc = encryptSecretLocal(t)
      delete d.settings.gitAuth
    } else {
      delete d.settings.gitAuthEnc
      delete d.settings.gitAuth
    }
  }
  save()
  resetEngine()
}

export function importGitKey(raw: string): boolean {
  return setGitKey(raw)
}

export function secretSettingKeys(): string[] {
  return [...SECRET_SETTINGS]
}

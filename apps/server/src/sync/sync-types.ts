import type { Logger } from '@nestjs/common'
import type { ConflictType, FieldDiff, Pick, RecordKind } from './ledger'

/**
 * 同步子域的共享形状（只有类型，没有逻辑）。
 *
 * 单独成文件是因为三处需要同一批类型：
 *  `sync.service.ts`（编排） / `sync-conflict.ts`（冲突呈现与裁决） / `sync-history.ts`（历史差异恢复）。
 * 放在任一实现文件里，另一个就得反向 import 回来 —— 那正好是循环依赖的入口
 * （旧版 1227 行单类时，这三个职责共享字段是靠"都在一个类里"实现的，代价是 Divergent Change）。
 */
export type ConflictItem = {
  key: string
  fileName: string
  kind: RecordKind | null
  title: string
  conflictType: ConflictType
  base: string | null
  local: string | null
  remote: string | null
  fields: FieldDiff[]
  recommend: Pick
  reason: string
}

export type StoredConflict = {
  at: number
  mode: 'merge' | 'whole-file'
  oursOid: string | null
  theirsOid: string | null
  items: ConflictItem[]
  errorData: any
  /** §5.6.2：本次合并中被驱动自动处理掉的文件（界面折叠可展开核对） */
  autoMerged?: string[]
}

export type ResolveItem = { key: string; pick: Pick; fieldPicks?: Record<string, Pick> }

/** markFailure 的返回：四个分支形状不同，必须显式声明，否则 `res?.halted` 在联合类型上取不到属性 */
export type FailureOutcome = { ok: false; reason: string; message: string; halted?: boolean; retries?: number }

/**
 * 子域回望主服务的那几个能力（门、门内直推、失败定性）。
 *
 * 用**能力对象**而不是注入 SyncService：注入会绕成循环（SyncService → 冲突服务 → SyncService），
 * 得靠 forwardRef + 延迟解析，比这层显式的四个函数丑得多。
 * 门的意义就在这里：历史/差异/恢复/裁决都读写同一个 .git 与同一批表，
 * 必须与定时器触发的 run() 串行（§6.1 单轮串行），不能各拿各的锁。
 */
export type SyncHost = {
  gate<T>(label: string, fn: () => Promise<T>): Promise<T>
  pushInGate(branch?: string): Promise<any>
  markFailure(kind: 'offline' | 'error', msg: string, opts: { auto: boolean; statusCode?: number | null }): Promise<FailureOutcome>
  statusCodeOf(e: any): number | null
  log: Logger
}

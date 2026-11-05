/**
 * 平账「大项列表」落库计划（纯函数，无 Prisma/框架依赖）。
 *
 * 为什么要抽出来（.docs/21 R1，§3.2）：
 *   旧实现是 `deleteMany` + 循环 `create`，两个致命问题——
 *     ① uid 丢了：对端把"我改了列表"读成"本机删光 + 新增一堆"，同步历史上全是无谓 churn；
 *     ② 他端刚加进来、本机这次列表里没有的大项会被**物理删除**，
 *        物理删绕开 mergeDriver（R10），对端连裁决机会都没有 = 必丢数据。
 *   新实现按 uid 做 diff：能对上就 update（保住 uid），对不上才打墓碑（`deleted:true`）。
 *
 *   R1 的对策要求「新旧行为用 Setting 开关灰度」。这里把两种语义都做成同一个纯函数的
 *   两个分支（mode: 'diff' | 'legacy'），服务端按 Setting.reconcileLegacy 选择——
 *   开关是**本机设置，不投影进 git**（它决定的是本机怎么写库，不是跨端该一致的展示偏好）。
 */

export type ExistingBigItem = {
  id: number
  uid: string | null
  typeId: number
  amount: number
  note: string | null
  accountId: number | null
}

/** 前端提交的大项（note/accountId 已由调用方归一化） */
export type IncomingBigItem = {
  uid?: string | null
  typeId: number
  amount: number
  note: string | null
  accountId: number | null
}

export type BigItemPlan = {
  /** 命中既有条目且内容变了 → 按 id update（uid 保持不变） */
  updates: Array<{ id: number; typeId: number; amount: number; note: string | null; accountId: number | null }>
  /** 没命中任何既有条目 → create（新 uid） */
  creates: IncomingBigItem[]
  /** 本次列表里没出现的既有条目 → 打墓碑 */
  tombstoneIds: number[]
}

export function planBigItems(existing: ExistingBigItem[], incoming: IncomingBigItem[], mode: 'diff' | 'legacy' = 'diff'): BigItemPlan {
  // legacy 灰度分支：等价于旧的"全量替换"——所有既有条目一律墓碑，所有提交项一律新建。
  // 保留这条通路只为一件事：新算法出问题时能一键退回旧行为验证，不指望它长期存在。
  if (mode === 'legacy') {
    return {
      updates: [],
      creates: incoming.map((it) => ({ ...it, uid: null })),
      tombstoneIds: existing.map((e) => e.id),
    }
  }

  const byUid = new Map(existing.filter((e) => e.uid).map((e) => [e.uid as string, e]))
  const claimed = new Set<number>()
  const updates: BigItemPlan['updates'] = []
  const creates: IncomingBigItem[] = []

  for (const it of incoming) {
    let target = it.uid ? byUid.get(it.uid) : undefined
    if (!target) {
      // 老前端不带 uid：按内容找一条还没被认领的同款，把 uid 保住（而不是新建一条）
      target = existing.find(
        (e) =>
          !claimed.has(e.id) &&
          e.typeId === it.typeId &&
          e.amount === it.amount &&
          (e.note ?? null) === it.note &&
          (e.accountId ?? null) === it.accountId,
      )
    }
    if (!target) {
      creates.push(it)
      continue
    }
    claimed.add(target.id)
    const changed =
      target.typeId !== it.typeId ||
      target.amount !== it.amount ||
      (target.note ?? null) !== it.note ||
      (target.accountId ?? null) !== it.accountId
    if (changed) {
      updates.push({ id: target.id, typeId: it.typeId, amount: it.amount, note: it.note, accountId: it.accountId })
    }
  }

  return {
    updates,
    creates,
    tombstoneIds: existing.filter((e) => !claimed.has(e.id)).map((e) => e.id),
  }
}

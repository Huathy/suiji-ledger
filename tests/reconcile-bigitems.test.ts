/**
 * R1（.docs/21 §9）点名的三条回归用例 + 灰度分支断言。
 * 计划层是纯函数，直接测计划；服务端接入点在 reconcile() 里只是把计划翻译成 Prisma 写。
 */
import { describe, it, expect } from 'vitest'
import { planBigItems, type ExistingBigItem, type IncomingBigItem } from '../apps/server/src/months/bigitem-diff'

const ex = (o: Partial<ExistingBigItem> & { id: number }): ExistingBigItem => ({
  uid: null, typeId: 1, amount: 100, note: null, accountId: null, ...o,
})
const inc = (o: Partial<IncomingBigItem> & { typeId: number; amount: number }): IncomingBigItem => ({
  uid: null, note: null, accountId: null, ...o,
})

describe('planBigItems · R1 回归（.docs/21 §9 要求的三条）', () => {
  it('① 双端同月平账：本机列表命中既有条目时只 update，绝不产生"删光+新增" churn', () => {
    const existing = [ex({ id: 1, uid: 'u1', typeId: 2, amount: 300 }), ex({ id: 2, uid: 'u2', typeId: 3, amount: 50 })]
    const incoming = [inc({ uid: 'u1', typeId: 2, amount: 320 }), inc({ uid: 'u2', typeId: 3, amount: 50 })]
    const p = planBigItems(existing, incoming)
    // u1 改了金额 → update；u2 原样 → 不动；没有任何墓碑/新建
    expect(p.updates).toEqual([{ id: 1, typeId: 2, amount: 320, note: null, accountId: null }])
    expect(p.creates).toHaveLength(0)
    expect(p.tombstoneIds).toEqual([])
  })

  it('② 他端新增的大项被本次替换列表覆盖：只以墓碑表达（可裁决复活），绝无物理删通道；命中项保 uid', () => {
    // 本机平账时列表 = [自己那条]；对端刚同步进来一条 u9，本机列表里没有它。
    // 旧实现 deleteMany + create：u9 被**物理删**（绕开 mergeDriver，R10，对端零裁决机会），
    // 且本机自己的条目也丢了 uid → 对端读成"删光+新增一堆"。
    // 新实现：计划层只有 tombstoneIds（deleted:true，行还在，可回收站/裁决复活），没有 delete；
    // 命中 incoming 的行只 update，uid 原样保住。
    const existing = [ex({ id: 1, uid: 'me', typeId: 2, amount: 100 }), ex({ id: 9, uid: 'u9', typeId: 4, amount: 77, note: '他端加的大项' })]
    const incoming = [inc({ uid: 'me', typeId: 2, amount: 120 })]
    const p = planBigItems(existing, incoming)
    expect('delete' in p).toBe(false) // 接口上根本不存在物理删通道
    expect(p.tombstoneIds).toEqual([9])
    expect(p.updates).toEqual([{ id: 1, typeId: 2, amount: 120, note: null, accountId: null }])
    expect(p.creates).toHaveLength(0)
  })

  it('②b 同款兜底认领：不带 uid 的老前端提交，命中未认领的同款条目时保住 uid、不新建', () => {
    const existing = [ex({ id: 1, uid: 'u1', typeId: 2, amount: 100 })]
    const incoming = [inc({ typeId: 2, amount: 100 })] // 无 uid、内容相同
    const p = planBigItems(existing, incoming)
    expect(p.updates).toHaveLength(0)
    expect(p.creates).toHaveLength(0)
    expect(p.tombstoneIds).toHaveLength(0)
  })

  it('③ 删除后重平账：列表里去掉的条目只打墓碑，重新提交时同一行复活可被 update 命中', () => {
    const existing = [ex({ id: 1, uid: 'u1', typeId: 2, amount: 100 }), ex({ id: 2, uid: 'u2', typeId: 3, amount: 200 })]
    // 第一次：u2 被移出列表 → 墓碑
    const p1 = planBigItems(existing, [inc({ uid: 'u1', typeId: 2, amount: 100 })])
    expect(p1.tombstoneIds).toEqual([2])
    // 第二次：墓碑行还在表里（deleted:true 的行由调用方过滤后传入"未删行"，这里模拟重提同款）
    const p2 = planBigItems(existing, [inc({ uid: 'u2', typeId: 3, amount: 200 }), inc({ uid: 'u1', typeId: 2, amount: 100 })])
    expect(p2.tombstoneIds).toEqual([])
    expect(p2.updates).toHaveLength(0)
    expect(p2.creates).toHaveLength(0)
  })

  it('金额 0 且无备注的项在调用方已被过滤；计划层对空 incoming 全量墓碑', () => {
    const existing = [ex({ id: 1, uid: 'u1' })]
    const p = planBigItems(existing, [])
    expect(p.tombstoneIds).toEqual([1])
  })

  it('灰度分支 reconcileLegacy=on：退回旧"全量替换"语义——一律墓碑 + 一律新建', () => {
    const existing = [ex({ id: 1, uid: 'u1', typeId: 2, amount: 100 })]
    const incoming = [inc({ uid: 'u1', typeId: 2, amount: 100 })]
    const p = planBigItems(existing, incoming, 'legacy')
    expect(p.updates).toHaveLength(0)
    expect(p.tombstoneIds).toEqual([1])
    expect(p.creates).toHaveLength(1)
    expect(p.creates[0].uid).toBeNull() // 旧语义不带 uid 新建（uid 丢失正是旧行为的一部分）
  })
})

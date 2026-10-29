/** 全站金额格式化与收支配色：统一处理「隐藏金额」开关与负债账户颜色语义 */
import { fmtMoney } from '../../../../packages/shared/src/index'
import { useUiStore } from '../stores/ui'

/** 隐藏金额时的占位符 */
export const MASK = '••••••'

/** 是否处于「隐藏金额」状态 */
export function amountsHidden(): boolean {
  return useUiStore().hideAmounts
}

/** 分 → 千分位字符串（自动响应隐藏金额开关） */
export function money(cents: number | null | undefined, opts: { signed?: boolean } = {}): string {
  if (amountsHidden()) return MASK
  if (cents === null || cents === undefined) return '—'
  return fmtMoney(cents, opts)
}

/** 带 ¥ 前缀（自动响应隐藏金额开关） */
export function yuan(cents: number | null | undefined, opts: { signed?: boolean } = {}): string {
  const s = money(cents, opts)
  return s === MASK || s === '—' ? s : '¥' + s
}

/**
 * 变动配色（全站唯一口径）：
 * 资产：增加=绿 / 减少=红；负债：欠款增加=红 / 欠款减少=绿；0=灰。
 */
export function deltaClass(kind: string | null | undefined, delta: number | null | undefined): string {
  if (delta === null || delta === undefined || delta === 0) return 'm-mut'
  const good = kind === 'liability' ? delta < 0 : delta > 0
  return good ? 'm-inc' : 'm-exp'
}

/** 余额配色：负债账户的余额本身按「欠款」显示为红 */
export function balanceClass(kind: string | null | undefined, cents?: number): string {
  return kind === 'liability' && (cents === undefined || cents > 0) ? 'm-exp' : ''
}

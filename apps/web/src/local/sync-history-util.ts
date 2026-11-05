/**
 * 离线同步历史小工具：parseNetworth + mergeBase（与服务端 sync-history.ts 同口径）。
 */
import type { GitEngineLocal } from './sync-engine'

export function parseNetworth(message: string): number | null {
  const t = /^Suiji-Networth-Cents:\s*(-?\d+)\s*$/m.exec(message || '')
  if (t) {
    const n = Number(t[1])
    return Number.isSafeInteger(n) ? n : null
  }
  const m = /净资产\s*(-?[\d,]+\.\d{2})/.exec(message || '')
  if (!m) return null
  const n = Number(m[1].replace(/,/g, ''))
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

export async function findMergeBaseLocal(engine: GitEngineLocal, head: string | null, oid: string): Promise<string | null> {
  if (!head) return null
  if (head === oid) return oid
  return engine.mergeBase(head, oid)
}

// 加密档的两个硬要求：① 同明文必须同密文（否则处处冲突）② 解不回来要能识别
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { LedgerRecord } from '../apps/server/src/sync/ledger'

// DATA_DIR 在 env.ts 里是模块求值时读的，所以必须先设好再动态 import
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-crypto-'))
process.env.DATA_DIR = TMP

let encodeRecord: (r: LedgerRecord, e: boolean) => string
let decodeRecord: (t: string, f?: string) => any

const entry = (uid: string, amountCents: number, rev = 1): LedgerRecord => ({
  uid,
  kind: 'entry',
  ym: '2026-10',
  typeUid: 't-1',
  amountCents,
  note: '工资',
  accountUid: null,
  auto: false,
  rev,
  updatedAt: 100 + rev,
  deleted: false,
  origin: 'd_a',
})

describe('加密记录', () => {
  beforeAll(async () => {
    const codec = await import('../apps/server/src/sync/codec')
    encodeRecord = codec.encodeRecord
    decodeRecord = codec.decodeRecord
  })

  it('同一份记录两次加密必须逐字节相同（确定性 IV）', () => {
    const rec = entry('a', 1212000)
    expect(encodeRecord(rec, true)).toBe(encodeRecord(rec, true))
  })

  it('不同金额必须得到不同密文（IV 不能退化成常量）', () => {
    expect(encodeRecord(entry('a', 1212000), true)).not.toBe(encodeRecord(entry('a', 1214000), true))
  })

  it('密文里不含明文金额，但能解回原记录', () => {
    const rec = entry('a', 1212000)
    const text = encodeRecord(rec, true)
    expect(text).not.toContain('amountCents')
    expect(text).not.toContain('1212000')
    const parsed = decodeRecord(text, 'e_a.json')
    expect(parsed.ok).toBe(true)
    expect(parsed.rec.amountCents).toBe(1212000)
    expect(parsed.rec.uid).toBe('a')
  })

  it('密钥不匹配时返回 reason=encrypted，不抛也不当成坏数据', () => {
    const text = encodeRecord(entry('a', 1212000), true)
    // 换一把密钥（内容变化后缓存必须失效，否则测试里换 key 不生效）
    fs.writeFileSync(path.join(TMP, 'git.key'), 'b'.repeat(64))
    const parsed = decodeRecord(text, 'e_a.json')
    expect(parsed.ok).toBe(false)
    expect(parsed.reason).toBe('encrypted')
    expect(parsed.rev).toBe(1)
  })

  it('拷钥回归（§13.2）：新钥与旧钥等长且 mtime 被保留，缓存仍必须认新钥', () => {
    // 上一用例已把密钥换成 'b'.repeat(64)；再造一把"等长 + 显式同 mtime"的第三钥
    const keyFile = path.join(TMP, 'git.key')
    const st = fs.statSync(keyFile)
    fs.writeFileSync(keyFile, 'c'.repeat(64))
    fs.utimesSync(keyFile, st.atime, st.mtime) // mtime 完全等于上一把（模拟资源管理器拷贝保留时间戳）
    const thirdKeyText = encodeRecord(entry('x', 888), true) // 用第三钥加密一份新记录
    fs.writeFileSync(keyFile, 'd'.repeat(64)) // 再换第四钥：等长、mtime 不管
    fs.utimesSync(keyFile, st.atime, st.mtime)
    const parsed = decodeRecord(thirdKeyText, 'e_x.json')
    // 旧实现（mtime+size 指纹）在这里会命中缓存继续用第三钥 → 解析"成功"；内容指纹实现必须判为解不开
    expect(parsed.ok).toBe(false)
    expect(parsed.reason).toBe('encrypted')
  })
})

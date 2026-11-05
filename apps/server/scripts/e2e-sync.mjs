#!/usr/bin/env node
/**
 * M4 同步的双端对敲验收（方案 §10 M4c 的验收条件）
 *
 * 两个独立 DATA_DIR 实例 + 一个本地 smart-HTTP 裸仓库：
 *   ① A 首推 → ② B 首次同步认领远端历史 → ③ 两端各改同一条记录 → ④ A 推、B 冲突
 *   ⑤ B 在冲突里选一边 → ⑥ A 再同步 → 两端数据收敛一致
 *
 * 用法：node apps/server/scripts/e2e-sync.mjs
 * 依赖：本机 git（脚本会起 dev-git-http.mjs 转发 upload-pack/receive-pack）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import net from 'node:net'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import jwt from 'jsonwebtoken'
import { PrismaClient } from '@prisma/client'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const WORK = path.join(os.tmpdir(), 'suiji-e2e-' + Date.now())
/** 上一轮的临时目录：清掉，免得残留的 git 仓/库文件干扰排查与磁盘 */
const E2E_PREFIX = 'suiji-e2e-'
function pruneOldWork() {
  const keep = path.basename(WORK)
  for (const name of fs.readdirSync(os.tmpdir())) {
    if (!name.startsWith(E2E_PREFIX) || name === keep) continue
    try {
      fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true, maxRetries: 2 })
    } catch {}
  }
}
const A = path.join(WORK, 'a')
const B = path.join(WORK, 'b')
const REMOTE = path.join(WORK, 'remote')
const PORT_A = 3011
const PORT_B = 3012
const GIT_PORT = 3021
const GIT_URL = `http://127.0.0.1:${GIT_PORT}/ledger.git`

const children = []
const LOGS = { A: path.join(WORK, 'a.log'), B: path.join(WORK, 'b.log') }
function log(step, msg) {
  console.log(`\n[${step}] ${msg}`)
}
function fail(msg) {
  console.error('\n✗ ' + msg)
  for (const [name, file] of Object.entries(LOGS)) {
    try {
      const txt = fs.readFileSync(file, 'utf8')
      console.error(`\n--- ${name} 日志（末 3000 字）---\n` + txt.slice(-3000))
    } catch {}
  }
  cleanup()
  process.exit(1)
}
/**
 * 收进程必须收**整棵树**：spawn(..., {shell:true}) 的 child 是 cmd.exe 外壳，
 * `child.kill()` 只杀掉外壳，里面的 ts-node 服务端继续占 3011/3012 ——
 * 下一次跑脚本时新实例起不来，请求却打到上一轮的老实例（它的 DATA_DIR 是别的临时目录），
 * "A 同步没有写自己的库"就是这么误报的（本轮实测踩过）。
 */
function killTree(c) {
  if (!c || !c.pid) return
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-c.pid, 'SIGKILL')
  } catch {
    try {
      c.kill()
    } catch {}
  }
}
function cleanup() {
  for (const c of children) killTree(c)
}

/** 端口占用预检（同上：宁可立刻报错，也不要让老实例接走请求把验收跑成假的） */
async function assertPortFree(port, name) {
  const probe = await new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(port, '127.0.0.1', () => {
      s.close(() => resolve(true))
    })
  })
  if (!probe) fail(`端口 ${port} 已被占用（疑似上一轮 ${name} 残留）。先杀掉残留 node 进程再重跑。`)
}

async function waitUp(port, name) {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/auth/bootstrap`)
      if (r.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  fail(`${name} 启动超时（端口 ${port}）`)
}

function token() {
  const secret = fs.readFileSync(path.join(A, 'secret.key'), 'utf8').trim()
  return jwt.sign({ uid: 1 }, secret, { expiresIn: '1d' })
}

async function api(port, p, method = 'GET', body) {
  const r = await fetch(`http://127.0.0.1:${port}/api${p}`, {
    method,
    headers: { Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text, status: r.status }
  }
}

function entriesOf(month) {
  return (month.entries || []).filter((e) => !e.auto).map((e) => `${e.uid}:${e.amount}:${e.note || ''}`).sort()
}

/**
 * 两个实例各自换一个 deviceId。
 * 复制同一份 money.db 会让两端 gitDeviceId 相同 —— 冲突兜底的 origin 平局判定就测不出来，
 * 而且"到底是谁写的"也看不出来，等于把 §3 的 origin 规则从验收里抹掉。
 */
async function setDeviceId(dir, id) {
  const url = 'file:' + path.join(dir, 'money.db').split(path.sep).join('/')
  const p = new PrismaClient({ datasources: { db: { url } } })
  await p.setting.upsert({ where: { key: 'gitDeviceId' }, update: { value: id }, create: { key: 'gitDeviceId', value: id } })
  await p.$disconnect()
}

/** 断言实例真的在自己的数据目录里写库（曾经踩过：DATA_DIR 被 .env 的 DATABASE_URL 顶掉，两端共用一个库） */
function dbMtime(dir) {
  return fs.statSync(path.join(dir, 'money.db')).mtimeMs
}

async function main() {
  pruneOldWork()
  for (const [port, name] of [[PORT_A, 'A'], [PORT_B, 'B'], [GIT_PORT, 'git-http']]) await assertPortFree(port, name)
  fs.mkdirSync(A, { recursive: true })
  fs.mkdirSync(B, { recursive: true })
  fs.mkdirSync(REMOTE, { recursive: true })
  const srcDb = path.join(ROOT, 'apps', 'server', 'data', 'money.db')
  const srcKey = path.join(ROOT, 'apps', 'server', 'data', 'secret.key')
  if (!fs.existsSync(srcDb)) fail('找不到 apps/server/data/money.db（先跑一次服务端或 npm run db:push）')
  for (const dir of [A, B]) {
    fs.copyFileSync(srcDb, path.join(dir, 'money.db'))
    fs.copyFileSync(srcKey, path.join(dir, 'secret.key'))
  }
  await setDeviceId(A, 'd_e2e0000a')
  await setDeviceId(B, 'd_e2e0000b')
  execFileSync('git', ['init', '--bare', '-b', 'main', path.join(REMOTE, 'ledger.git')], { stdio: 'ignore' })

  log('0', `工作目录 ${WORK}`)
  children.push(spawn(process.execPath, [path.join(HERE, 'dev-git-http.mjs'), REMOTE, String(GIT_PORT)], { stdio: 'inherit' }))
  children.push(
    spawn('npx', ['ts-node', path.join(ROOT, 'apps', 'server', 'src', 'main.ts')], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT_A), DATA_DIR: A, SYNC_DEBUG: '1' },
      stdio: ['ignore', fs.openSync(LOGS.A, 'a'), fs.openSync(LOGS.A, 'a')],
      shell: true,
    }),
  )
  children.push(
    spawn('npx', ['ts-node', path.join(ROOT, 'apps', 'server', 'src', 'main.ts')], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT_B), DATA_DIR: B, SYNC_DEBUG: '1' },
      stdio: ['ignore', fs.openSync(LOGS.B, 'a'), fs.openSync(LOGS.B, 'a')],
      shell: true,
    }),
  )
  await waitUp(PORT_A, 'A')
  await waitUp(PORT_B, 'B')

  for (const port of [PORT_A, PORT_B]) {
    await api(port, '/system/settings', 'PUT', {
      settings: { gitRemote: GIT_URL, gitBranch: 'main', gitPushMode: 'manual', gitAutoCommit: 'off', gitEncrypt: 'off' },
    })
  }

  log('1', 'A 首次同步（远端为空 → 建历史并推送）')
  const mtimeA0 = dbMtime(A)
  const mtimeB0 = dbMtime(B)
  const r1 = await api(PORT_A, '/system/sync/run', 'POST')
  if (!r1.ok) fail('A 首次同步失败: ' + JSON.stringify(r1))
  if (dbMtime(A) === mtimeA0) fail('A 同步没有写自己的库 —— DATA_DIR 没生效（两端是不是共用一个 money.db？）')
  if (dbMtime(B) !== mtimeB0) fail('B 的库被 A 的同步改了 —— 两个实例连的是同一个数据库，验收无意义')

  log('2', 'B 首次同步（本地空仓库 → 认领远端历史 + 吸收数据）')
  const r2 = await api(PORT_B, '/system/sync/run', 'POST')
  if (!r2.ok) fail('B 首次同步失败（首拉认领没生效？）: ' + JSON.stringify(r2))

  const mA = await api(PORT_A, '/month/2026-10')
  const mB = await api(PORT_B, '/month/2026-10')
  const ea = entriesOf(mA)
  const eb = entriesOf(mB)
  if (JSON.stringify(ea) !== JSON.stringify(eb)) fail('两端数据没对齐:\nA=' + JSON.stringify(ea) + '\nB=' + JSON.stringify(eb))
  log('2b', `两端条目一致（${ea.length} 条）`)

  const target = (mA.entries || []).find((e) => !e.auto)
  if (!target) fail('没有可用于制造冲突的大项条目')

  const balancesOf = (m) => m.accounts.filter((a) => a.balance !== null).map((a) => ({ accountId: a.id, balance: a.balance }))
  const bigOf = (m, amountOverride) =>
    m.entries
      .filter((e) => !e.auto)
      .map((e) => ({ uid: e.uid, typeId: e.typeId, amount: e.uid === target.uid ? amountOverride : e.amount, note: e.note }))

  log('3', `两端各改同一条记录（uid=${target.uid.slice(0, 8)}）：A +50 元 / B +70 元，都不推送`)
  await api(PORT_A, '/reconcile', 'POST', {
    ym: '2026-10',
    recordDate: mA.recordDate,
    note: mA.autoEntry?.note || '（批量记录）',
    balances: balancesOf(mA),
    bigItems: bigOf(mA, target.amount + 5000),
  })
  await api(PORT_B, '/reconcile', 'POST', {
    ym: '2026-10',
    recordDate: mB.recordDate,
    note: mB.autoEntry?.note || '（批量记录）',
    balances: balancesOf(mB),
    bigItems: bigOf(mB, target.amount + 7000),
  })

  // 冲突的前置条件：两端同一条 uid 必须真的各写各的，否则后面"合并干净"是假通过
  const amountOf = (m, uid) => (m.entries || []).find((e) => e.uid === uid)?.amount
  const aAmt = amountOf(await api(PORT_A, '/month/2026-10'), target.uid)
  const bAmt = amountOf(await api(PORT_B, '/month/2026-10'), target.uid)
  if (aAmt === bAmt) fail(`两端改完金额仍然相同（${aAmt}）—— 造不出冲突，检查实例是否共用一个库`)
  log('3b', `两端已分叉：A=${aAmt} / B=${bAmt}（基准 ${target.amount}）`)

  log('4', 'A 同步（推送成功）')
  const r4 = await api(PORT_A, '/system/sync/run', 'POST')
  if (!r4.ok) fail('A 推送失败: ' + JSON.stringify(r4))

  log('5', 'B 同步（应进入冲突态）')
  const r5 = await api(PORT_B, '/system/sync/run', 'POST')
  if (r5.ok || r5.reason !== 'conflict') fail('B 应当冲突，实际: ' + JSON.stringify(r5))

  const conflicts = await api(PORT_B, '/system/sync/conflicts')
  if (!conflicts.items || conflicts.items.length === 0) fail('冲突清单为空')
  const item = conflicts.items[0]
  log('5b', `冲突项 ${item.title} · 类型 ${item.conflictType} · 预选 ${item.recommend} · ${item.reason}`)
  if (!item.fields || item.fields.length === 0) fail('冲突项没有字段级 diff')
  console.log('    字段对照:', item.fields.map((f) => `${f.label}[${f.changed}] ${f.local} | ${f.base} | ${f.remote}`).join('  '))

  log('6', 'B 在对照界面选"以远程为准"并推送')
  const r6 = await api(PORT_B, '/system/sync/resolve', 'POST', { items: [{ key: item.key, pick: 'remote' }], push: true })
  if (!r6.ok || r6.remaining > 0) fail('裁决失败: ' + JSON.stringify(r6))

  log('7', 'A 再同步（应收敛到同一结果）')
  const r7 = await api(PORT_A, '/system/sync/run', 'POST')
  if (!r7.ok) fail('A 二次同步失败: ' + JSON.stringify(r7))

  const a2 = await api(PORT_A, '/month/2026-10')
  const b2 = await api(PORT_B, '/month/2026-10')
  const ea2 = entriesOf(a2)
  const eb2 = entriesOf(b2)
  if (JSON.stringify(ea2) !== JSON.stringify(eb2)) fail('裁决后仍未收敛:\nA=' + JSON.stringify(ea2) + '\nB=' + JSON.stringify(eb2))

  // ---------------- M4d：加密档（gitEncrypt=on） ----------------
  log('8', '两端开启加密 → 断言"合并"被后端强制关闭')
  // 密文仓库要求两端同一把 git.key（§7.2）。这里模拟"用户把密钥拷到另一台"，
  // 必须在任何一端首次加密之前放好，否则两端各生成一把 → 全库密文互相解不开。
  const sharedKey = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(path.join(A, 'git.key'), sharedKey)
  fs.writeFileSync(path.join(B, 'git.key'), sharedKey)
  for (const port of [PORT_A, PORT_B]) {
    await api(port, '/system/settings', 'PUT', { settings: { gitEncrypt: 'on', gitMergeEnabled: 'on' } })
  }
  for (const [port, name] of [[PORT_A, 'A'], [PORT_B, 'B']]) {
    const s = (await api(port, '/system/settings')).settings || {}
    if (s.gitEncrypt !== 'on') fail(`${name} 加密没写进去: ` + JSON.stringify(s.gitEncrypt))
    // §7.1：开启加密时 putSettings 必须把 gitMergeEnabled 压回 off，不能只靠前端置灰
    if (s.gitMergeEnabled !== 'off') fail(`${name} 开启加密后 gitMergeEnabled 仍为 ${s.gitMergeEnabled}（应被强制 off）`)
  }

  log('8b', '两端再各改同一条（A +50 / B +70）')
  const m3A = await api(PORT_A, '/month/2026-10')
  const m3B = await api(PORT_B, '/month/2026-10')
  const t3 = (m3A.entries || []).find((e) => !e.auto)
  const big3 = (m, over) => m.entries.filter((e) => !e.auto).map((e) => ({ uid: e.uid, typeId: e.typeId, amount: e.uid === t3.uid ? over : e.amount, note: e.note }))
  await api(PORT_A, '/reconcile', 'POST', { ym: '2026-10', recordDate: m3A.recordDate, note: m3A.autoEntry?.note, balances: balancesOf(m3A), bigItems: big3(m3A, t3.amount + 5000) })
  await api(PORT_B, '/reconcile', 'POST', { ym: '2026-10', recordDate: m3B.recordDate, note: m3B.autoEntry?.note, balances: balancesOf(m3B), bigItems: big3(m3B, t3.amount + 7000) })

  log('8c', 'A 同步（首次以密文推送）')
  const r8 = await api(PORT_A, '/system/sync/run', 'POST')
  if (!r8.ok) fail('A 加密同步失败: ' + JSON.stringify(r8))

  // 密文仓库要求两端同一把 git.key（§7.2：密钥不同 = 历史不可解）——已在第 8 步预置

  log('8d', '校验远端文件确实是密文（不含明文金额字段）')
  const entryFile = `ledger/v1/entries/e_${t3.uid}.json`
  const rawRemote = execFileSync('git', ['show', `main:${entryFile}`], { cwd: path.join(REMOTE, 'ledger.git'), encoding: 'utf8' })
  if (/amountCents/.test(rawRemote)) fail('远端仍是明文: ' + rawRemote.slice(0, 200))
  if (!/"enc"/.test(rawRemote)) fail('远端文件不是密文信封: ' + rawRemote.slice(0, 200))
  console.log('    密文样例:', rawRemote.trim().slice(0, 120) + '…')

  log('9', 'B 同步（加密档应进整份二选一冲突）')
  const r9 = await api(PORT_B, '/system/sync/run', 'POST')
  if (r9.ok || r9.reason !== 'conflict') fail('B 在加密档应当冲突，实际: ' + JSON.stringify(r9))
  const c9 = await api(PORT_B, '/system/sync/conflicts')
  if (c9.mode !== 'whole-file') fail('加密档的冲突模式应为 whole-file，实际 ' + c9.mode)
  const it9 = (c9.items || [])[0]
  if (!it9) fail('加密档冲突清单为空')
  if (it9.conflictType !== 'encrypted') fail('加密档冲突类型应为 encrypted，实际 ' + it9.conflictType)
  console.log(`    冲突项 ${it9.title} · ${it9.conflictType} · ${it9.reason}`)

  log('10', 'B 选"以远程为准" → 收敛')
  const r10 = await api(PORT_B, '/system/sync/resolve', 'POST', { items: [{ key: it9.key, pick: 'remote' }], push: true })
  if (!r10.ok || r10.remaining > 0) fail('加密档裁决失败: ' + JSON.stringify(r10))
  const r11 = await api(PORT_A, '/system/sync/run', 'POST')
  if (!r11.ok) fail('A 加密二次同步失败: ' + JSON.stringify(r11))
  const ea3 = entriesOf(await api(PORT_A, '/month/2026-10'))
  const eb3 = entriesOf(await api(PORT_B, '/month/2026-10'))
  if (JSON.stringify(ea3) !== JSON.stringify(eb3)) fail('加密档裁决后未收敛:\nA=' + JSON.stringify(ea3) + '\nB=' + JSON.stringify(eb3))

  log('11', '密钥不匹配：B 换一把随机密钥后应"解不开远端"而不是静默改数据')
  // 必须让 A 先动同一条：否则 B 只是快进推送，根本不会触发三方合并
  const m4A = await api(PORT_A, '/month/2026-10')
  const t4 = (m4A.entries || []).find((e) => !e.auto)
  const big4 = (m, over) => m.entries.filter((e) => !e.auto).map((e) => ({ uid: e.uid, typeId: e.typeId, amount: e.uid === t4.uid ? over : e.amount, note: e.note }))
  await api(PORT_A, '/reconcile', 'POST', { ym: '2026-10', recordDate: m4A.recordDate, note: m4A.autoEntry?.note, balances: balancesOf(m4A), bigItems: big4(m4A, t4.amount + 100) })
  const rA = await api(PORT_A, '/system/sync/run', 'POST')
  if (!rA.ok) fail('A 侧加密推送失败: ' + JSON.stringify(rA))

  fs.writeFileSync(path.join(B, 'git.key'), crypto.randomBytes(32).toString('hex'))
  const m4B = await api(PORT_B, '/month/2026-10')
  await api(PORT_B, '/reconcile', 'POST', { ym: '2026-10', recordDate: m4B.recordDate, note: m4B.autoEntry?.note, balances: balancesOf(m4B), bigItems: big4(m4B, t4.amount + 200) })

  const r12 = await api(PORT_B, '/system/sync/run', 'POST')
  if (r12.ok || r12.reason !== 'conflict') fail('密钥不匹配时应进冲突态，实际: ' + JSON.stringify(r12))
  const c12 = await api(PORT_B, '/system/sync/conflicts')
  const it12 = (c12.items || []).find((i) => i.conflictType === 'encrypted')
  if (!it12) fail('密钥不匹配没有产出 encrypted 冲突项: ' + JSON.stringify((c12.items || []).map((i) => i.conflictType)))
  const bad = await api(PORT_B, '/system/sync/resolve', 'POST', { items: [{ key: it12.key, pick: 'remote' }], push: false })
  if (bad.ok) fail('密钥不匹配时"以远程为准"必须被拒绝（不能把解不开的密文写进库）')
  console.log('    已拒绝:', bad.message)
  await api(PORT_B, '/system/sync/conflict', 'DELETE') // 收尾，别把冲突态留给后面的断言

  console.log('\n✓ 全部通过：首推 / 首拉认领 / 冲突检测 / 人工裁决 / 双向收敛 / 加密档整份二选一 / 密钥不匹配')
  console.log('  明文档最终条目：' + ea2.join(' , '))
  cleanup()
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  fail('脚本异常')
})

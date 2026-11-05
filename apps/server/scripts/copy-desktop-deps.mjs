#!/usr/bin/env node
/**
 * 把 Git 同步引擎的依赖 + 最新的 Prisma 客户端补进桌面端 `server/deps`。
 *
 * 为什么必须手动拷：Electron 打包时 `main.js` 用 `NODE_PATH=server/deps` 解析内嵌服务端的依赖，
 * 不在这份目录里的包，装出来的安装包一 require 就崩（方案 §9 R5）。
 *
 * 为什么不能手写白名单：isomorphic-git 的依赖树有 49 个包（simple-get → decompress-response /
 * once / simple-concat，sha.js → inherits，readable-stream → 一串…），手抄必然漏，
 * 漏一个就是 `MODULE_NOT_FOUND` 白屏。所以这里**从 package.json 递归算闭包**。
 *
 * 为什么还要拷 Prisma：打包用的是 `windows/staging/node_modules` 里另装的一份，
 * 它的 `.prisma/client` 是**上一次 generate 的产物**。schema 加了新字段（M4 的 uid/rev/…）后
 * 不重新拷，装出来的应用会拿旧客户端去查新库 —— 报 "Unknown argument uid" 或静默读不到字段。
 *
 * 用法（stage 之后、electron-builder 之前）：
 *   node apps/server/scripts/copy-desktop-deps.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const FROM = path.join(ROOT, 'node_modules')
/**
 * 目标目录默认 Electron 链的 server/deps；`--to <dir>` 可指到别处——
 * 旧的 windows 便携链（assemble.py → pack/app/node_modules）以前各拷各的，
 * staging 里根本没有 isomorphic-git，装出来的包一启动就 MODULE_NOT_FOUND（评审修复项）。
 * 现在两条链共用这份闭包计算，目标由参数决定。
 */
const toArg = process.argv.indexOf('--to')
const TO = toArg >= 0 && process.argv[toArg + 1] ? path.resolve(process.argv[toArg + 1]) : path.join(ROOT, 'apps', 'desktop', 'server', 'deps')

/** 闭包起点：内嵌服务端自己 require 的运行时依赖（其余由 staging 提供） */
const ROOTS = ['isomorphic-git']

/** Prisma 必须与 `prisma generate` 的产物一起整体替换，否则客户端/引擎/模型定义三者版本错位 */
const PRISMA_DIRS = ['@prisma/client', '.prisma']

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else if (entry.isFile()) fs.copyFileSync(s, d)
    else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(s), d)
  }
}

/** 从根 node_modules 递归求依赖闭包（扁平树：本项目的安装形态） */
function closure(roots) {
  const seen = new Map()
  const missing = new Set()
  const walk = (name) => {
    if (seen.has(name)) return
    const dir = path.join(FROM, name)
    if (!fs.existsSync(path.join(dir, 'package.json'))) {
      missing.add(name)
      return
    }
    seen.set(name, dir)
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    for (const dep of Object.keys({ ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) })) walk(dep)
  }
  roots.forEach(walk)
  return { list: [...seen.keys()].sort(), missing: [...missing] }
}

if (!fs.existsSync(TO)) {
  // 桌面链要求 stage.py 先铺目录；--to 指定的其它目标（windows 便携链）由本脚本自己建
  if (toArg >= 0) fs.mkdirSync(TO, { recursive: true })
  else {
    console.error(`[deps] 目标目录不存在：${TO}\n先跑 apps/desktop/stage.py 把 staging 依赖铺进来，再执行本脚本。`)
    process.exit(1)
  }
}

const { list, missing } = closure(ROOTS)
let ok = 0
const absent = []
for (const name of list) {
  const src = path.join(FROM, name)
  if (!fs.existsSync(src)) {
    absent.push(name)
    continue
  }
  copyDir(src, path.join(TO, name))
  ok++
}
console.log(`[deps] Git 同步闭包 ${ok}/${list.length} 个包 → ${path.relative(ROOT, TO)}`)

let prismaOk = 0
for (const name of PRISMA_DIRS) {
  const src = path.join(FROM, name)
  if (!fs.existsSync(src)) {
    absent.push(name)
    continue
  }
  const dest = path.join(TO, name)
  fs.rmSync(dest, { recursive: true, force: true })
  copyDir(src, dest)
  prismaOk++
}
console.log(`[deps] Prisma 客户端 ${prismaOk}/${PRISMA_DIRS.length} 个目录已刷新（与 schema 同版本）`)

if (missing.length) console.warn('[deps] 依赖声明了但未安装（请先 npm install）:', missing.join(', '))
if (absent.length) {
  console.error('[deps] 拷贝失败:', absent.join(', '))
  process.exitCode = 1
}

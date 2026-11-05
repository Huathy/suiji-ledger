/**
 * node:path 浏览器垫片：仅供服务端同步纯函数（merge-driver.ts）在 Vite 下打包。
 * 只实现用到的 basename/dirname/join/resolve 四个函数，与 node 语义一致
 * （posix 风格即可，同步仓库内路径全是正斜杠）。
 *
 * 注意：vitest.config.ts 的 alias 是全局的，服务端单测（env.ts 用 path.resolve）
 * 也会命中这个垫片，所以 resolve 必须可用，不能只给打包用的三个函数。
 */
export function basename(p: string, ext?: string): string {
  const s = String(p || '').split('/').pop() || ''
  if (ext && s.endsWith(ext)) return s.slice(0, -ext.length)
  return s
}
export function dirname(p: string): string {
  const s = String(p || '')
  const i = s.lastIndexOf('/')
  if (i < 0) return '.'
  if (i === 0) return '/'
  return s.slice(0, i)
}
export function join(...parts: string[]): string {
  return normalize(parts.join('/'))
}
const isAbs = (p: string): boolean => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)
export function resolve(...parts: string[]): string {
  // 简化版 resolve：从右找第一个绝对段（含 Windows 盘符），拼起来后 normalize（够 env.ts 用）
  let acc = ''
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = String(parts[i] || '')
    if (!p) continue
    acc = acc ? p + '/' + acc : p
    if (isAbs(p)) break
  }
  if (!isAbs(acc)) acc = '/cwd/' + acc
  return normalize(acc.replace(/\\/g, '/'))
}
function normalize(p: string): string {
  const abs = p.startsWith('/')
  const segs: string[] = []
  for (const s of p.split('/')) {
    if (!s || s === '.') continue
    if (s === '..') segs.pop()
    else segs.push(s)
  }
  return (abs ? '/' : '') + segs.join('/')
}
const path = { basename, dirname, join, resolve, sep: '/' as const, posix: { basename, dirname, join, resolve } }
export default path

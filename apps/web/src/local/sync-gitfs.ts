/**
 * 离线同步的 git 存储层：IndexedDB 里的 lightning-fs + isomorphic-git 浏览器版。
 *
 * 为什么单独一层：isomorphic-git 要的 `fs` 是"类 node fs"（promises API），
 * lightning-fs 是唯一能在浏览器里给它的实现。仓库根固定 `/git`，
 * 与服务端 DATA_DIR/git 同内容（但不是同一份文件：两端各有一份工作区+git，
 * 靠远端仓库对齐——这正是 Git 同步的模型）。
 */
import FS from '@isomorphic-git/lightning-fs'
import git from 'isomorphic-git'
import http from 'isomorphic-git/http/web'

let _fs: any = null
let _pfs: any = null

export function gitFs(): any {
  if (!_fs) _fs = new FS('suiji-ledger')
  return _fs
}

/** isomorphic-git 要的 promises 风格 fs（lightning-fs 的 .promises） */
export function gitPfs(): any {
  if (!_pfs) _pfs = gitFs().promises
  return _pfs
}

export const gitHttp = http

/** 仓库根（lightning-fs 内路径，与服务端 DATA_DIR/git 对应） */
export const GIT_DIR = '/git'

/** 确保 /git 目录存在（lightning-fs 首次使用前需 mkdir） */
export async function ensureGitDir(): Promise<void> {
  const pfs = gitPfs()
  try {
    await pfs.mkdir(GIT_DIR)
  } catch (e: any) {
    if (String(e?.code || e?.message || '').includes('EEXIST')) return
    // 已存在时 lightning-fs 抛 EEXIST，其他错误上抛
    try {
      await pfs.stat(GIT_DIR)
    } catch {
      throw e
    }
  }
}

export { git }

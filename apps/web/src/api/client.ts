import { showFailToast } from 'vant'
import { localHandle } from '../local/backend'

/** 离线模式（安卓 APK）：数据全部存手机本地，不依赖任何服务端 */
export const OFFLINE = import.meta.env.VITE_OFFLINE === '1'

declare global {
  interface Window {
    AndroidBridge?: {
      saveFile: (name: string, content: string) => Promise<string>
      saveBase64: (name: string, base64: string) => Promise<string>
      pickFile: (cb: string) => void
    }
    __mrFilePicked?: (content: string | null) => void
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] || '')
    r.readAsDataURL(blob)
  })
}

/** 安卓桥：保存文件（文本或二进制）到手机「下载/Suiji Ledger」；无桥（浏览器）回退 a.download */
export async function saveTextFile(name: string, content: string | Blob): Promise<string> {
  const mime = 'application/octet-stream'
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime })
  if (window.AndroidBridge?.saveBase64) {
    return window.AndroidBridge.saveBase64(name, await blobToBase64(blob))
  }
  if (window.AndroidBridge?.saveFile && !(content instanceof Blob)) {
    return window.AndroidBridge.saveFile(name, content)
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
  return name
}

/** 选择本地文本文件（安卓用系统文件选择器；浏览器回退 input[type=file]） */
export function pickTextFile(): Promise<string | null> {
  if (window.AndroidBridge?.pickFile) {
    return new Promise((resolve) => {
      window.__mrFilePicked = (s) => resolve(s)
      window.AndroidBridge.pickFile('__mrFilePicked')
    })
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.onchange = async () => {
      const f = input.files?.[0]
      resolve(f ? await f.text() : null)
    }
    input.click()
  })
}

const TOKEN_KEY = 'mr_token'
const SERVER_KEY = 'mr_server'

/** API 基地址：Web 同源为空串；服务端模式的 APK 用内置默认（VITE_DEFAULT_SERVER）或登录页填写 */
export function getServerBase(): string {
  const ls = localStorage.getItem(SERVER_KEY)
  if (ls !== null) return ls.replace(/\/+$/, '')
  const baked = (import.meta.env.VITE_DEFAULT_SERVER as string | undefined) || ''
  return baked.replace(/\/+$/, '')
}
export function setServerBase(url: string) {
  const v = url.trim().replace(/\/+$/, '')
  if (v) localStorage.setItem(SERVER_KEY, v)
  else localStorage.removeItem(SERVER_KEY)
}

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) || ''
}
export function setToken(t: string) {
  if (t) localStorage.setItem(TOKEN_KEY, t)
  else localStorage.removeItem(TOKEN_KEY)
}

/** 统一请求入口：离线模式走本地后端，否则走 HTTP API */
export async function api<T = any>(path: string, opts: { method?: string; body?: any } = {}): Promise<T> {
  if (OFFLINE) {
    try {
      return await localHandle(opts.method || 'GET', path, opts.body)
    } catch (e: any) {
      showFailToast(e?.message || '操作失败')
      throw e
    }
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = getToken()
  if (token) headers['Authorization'] = 'Bearer ' + token
  let res: Response
  try {
    res = await fetch(getServerBase() + '/api' + path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })
  } catch {
    showFailToast('网络异常，请检查服务是否在线')
    throw new Error('network')
  }
  if (res.status === 401) {
    setToken('')
    location.hash = '#/login'
    throw new Error('unauthorized')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = (data as any)?.message || `请求失败 (${res.status})`
    showFailToast(String(Array.isArray(msg) ? msg[0] : msg))
    throw new Error(String(msg))
  }
  return data as T
}

/** 下载带鉴权的文件（备份 JSON / CSV）；离线模式请用 saveTextFile */
export async function downloadFile(path: string, filename: string) {
  if (OFFLINE) {
    if (path.includes('matrix.csv')) {
      const { csv } = await api<{ csv: string }>('/system/matrix.csv')
      await saveTextFile(filename, csv)
    }
    return
  }
  const res = await fetch(getServerBase() + '/api' + path, { headers: { Authorization: 'Bearer ' + getToken() } })
  if (!res.ok) {
    showFailToast('下载失败')
    return
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

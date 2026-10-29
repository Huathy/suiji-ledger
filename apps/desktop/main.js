/**
 * SuijiLedger 桌面版主进程：
 * 内嵌 NestJS 服务（同进程，动态端口）+ BrowserWindow 加载界面。
 * 数据目录：%APPDATA%/SuijiLedger/data（SQLite；自动从旧版 Windows 包迁移）
 */
const { app, BrowserWindow, Menu, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const net = require('net')
const http = require('http')

let mainWin = null

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore()
      mainWin.focus()
    }
  })

  app.whenReady().then(bootstrap)
}

app.on('window-all-closed', () => app.quit())

function findFreePort(start) {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(start, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
    s.on('error', () => resolve(findFreePort(start + 1)))
  })
}

function httpOk(url) {
  return new Promise((resolve) => {
    const r = http.get(url, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    r.on('error', () => resolve(false))
    r.setTimeout(800, () => {
      r.destroy()
      resolve(false)
    })
  })
}

async function waitFor(url, timeoutMs) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await httpOk(url)) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

async function bootstrap() {
  Menu.setApplicationMenu(null)

  const dataDir = path.join(app.getPath('userData'), 'data')
  fs.mkdirSync(dataDir, { recursive: true })

  // 旧版 Windows 包数据迁移（旧包目录名仍为 MoneyRecord，此处保留原字面量）
  try {
    const oldData = path.join(process.env.LOCALAPPDATA || '', 'MoneyRecord', 'data')
    if (!fs.existsSync(path.join(dataDir, 'money.db')) && fs.existsSync(path.join(oldData, 'money.db'))) {
      fs.copyFileSync(path.join(oldData, 'money.db'), path.join(dataDir, 'money.db'))
      const oldKey = path.join(oldData, 'secret.key')
      if (fs.existsSync(oldKey)) fs.copyFileSync(oldKey, path.join(dataDir, 'secret.key'))
      console.log('[desktop] migrated data from legacy windows package')
    }
  } catch (e) {
    console.warn('[desktop] migration skipped:', e.message)
  }

  const port = await findFreePort(38999)
  process.env.DATA_DIR = dataDir
  process.env.PORT = String(port)
  process.env.ELECTRON = '1'

  // 内嵌服务端（编译产物，require 即启动监听）；依赖打包在 server/deps，用 NODE_PATH 挂载解析
  process.env.NODE_PATH = path.join(__dirname, 'server', 'deps') +
    (process.env.NODE_PATH ? require('path').delimiter + process.env.NODE_PATH : '')
  require('module')._initPaths()
  require('./server/apps/server/src/main.js')

  const url = 'http://localhost:' + port + '/'
  const ready = await waitFor(url + 'api/auth/bootstrap', 20000)
  if (!ready) console.warn('[desktop] server slow to start, opening window anyway')

  mainWin = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 390,
    minHeight: 640,
    autoHideMenuBar: true,
    backgroundColor: '#121318',
    title: 'SuijiLedger 月度平账',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  mainWin.loadURL(url)
  // 外部链接用系统浏览器打开
  mainWin.webContents.setWindowOpenHandler(({ url: u }) => {
    shell.openExternal(u)
    return { action: 'deny' }
  })
  mainWin.on('closed', () => {
    mainWin = null
  })
}

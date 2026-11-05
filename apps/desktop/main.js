/**
 * Suiji Ledger 桌面版主进程：
 * 内嵌 NestJS 服务（同进程，动态端口）+ BrowserWindow 加载界面。
 * 数据目录：%APPDATA%/suiji-ledger-desktop/data（SQLite；自动从旧版 Windows 包迁移）
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

  // 旧版 Windows 包数据迁移（两代遗留目录都认，评审修复项：
  // v0.3.0 PyInstaller 链落 %LOCALAPPDATA%\SuijiLedger\data，更早的 MoneyRecord 链落 …\MoneyRecord\data；
  // 此前只认 MoneyRecord → 从 SuijiLedger 旧包升级的用户数据"消失"）
  try {
    const localAppData = process.env.LOCALAPPDATA || ''
    const candidates = [
      path.join(localAppData, 'SuijiLedger', 'data'),
      path.join(localAppData, 'MoneyRecord', 'data'),
    ]
    if (!fs.existsSync(path.join(dataDir, 'money.db'))) {
      for (const oldData of candidates) {
        if (!fs.existsSync(path.join(oldData, 'money.db'))) continue
        fs.copyFileSync(path.join(oldData, 'money.db'), path.join(dataDir, 'money.db'))
        for (const extra of ['secret.key', 'git.key']) {
          const oldKey = path.join(oldData, extra)
          if (fs.existsSync(oldKey)) fs.copyFileSync(oldKey, path.join(dataDir, extra))
        }
        // 旧包 git 仓一并带过来（历史与租约 oid 都在 .git 里）
        const oldRepo = path.join(oldData, 'git')
        if (fs.existsSync(oldRepo)) fs.cpSync(oldRepo, path.join(dataDir, 'git'), { recursive: true })
        console.log('[desktop] migrated data from legacy windows package: ' + oldData)
        break
      }
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

  // R5 启动自检（.docs/21 §9 对策点名，评审修复项）：deps 白名单是手工脚本算的，
  // 漏一个包过去要等 Nest 模块求值才炸，窗口开了、服务端半死不活最难排。
  // 这里在 require 服务端之前把同步引擎的两个入口 require.resolve 一遍，缺了就明说缺什么。
  try {
    require.resolve('isomorphic-git')
    require.resolve('isomorphic-git/http/node')
  } catch (e) {
    console.error('[desktop] 同步引擎依赖缺失（server/deps 不完整），请重新执行 npm run deps:desktop 后打包。', e.message)
    const { dialog } = require('electron')
    dialog.showErrorBox(
      'SuijiLedger 依赖不完整',
      'Git 同步引擎的依赖（isomorphic-git）不在安装包内，数据同步不可用。\n' +
      '其余功能不受影响；如需同步请重新安装或反馈打包版本。',
    )
  }

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
    title: 'Suiji Ledger 月度平账',
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

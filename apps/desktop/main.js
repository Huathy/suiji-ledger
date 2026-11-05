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
// 启动完成标志：隐藏探测窗口关闭时会触发 window-all-closed，
// 必须在主窗口建好前忽略，否则探测窗口一关就 app.quit()，主窗口刚出来就被杀 = “窗口一闪而过”。
let bootDone = false

let APP_VERSION = '0.3.15'
try {
  APP_VERSION = require('./package.json').version || APP_VERSION
} catch { /* 打包后 package.json 一定在同目录，拿不到就用硬编码 */ }

// GPU 安全模式：渲染进程秒崩（Win11 某些核显驱动 + Electron 33 已知问题）是"完全没窗口、无弹框"
// 的头号嫌疑人。用法：exe --safe-gpu（便携包 NSIS 会把参数透传给内部程序）。
// appendSwitch 必须在 app ready 之前调，所以放模块顶层。
const GPU_SAFE =
  process.argv.includes('--gpu-fallback') ||
  process.argv.includes('--safe-gpu') ||
  process.env.SUIJI_SAFE_GPU === '1'
if (GPU_SAFE) {
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-software-rasterizer')
}

// 秒退排障：GUI 程序的 console 直接丢掉，闪退=无日志，所以双写落盘：
//  · bootLog：早产儿日志，写持久路径（便携包优先 PORTABLE_EXECUTABLE_DIR，即用户双击的 exe 同目录，
//    NSIS 退出清 TEMP 也删不掉它；exe 目录不可写时退到 LOCALAPPDATA）。用户取证只看这一个文件。
//  · logFile：app ready 后切换到 userData/data/logs/main.log（详细日志），boot 之前先写 exe 同目录。
// 落盘点不用 app.getPath（app ready 之前调它会抛，单实例秒退那条分支正好在 ready 之前）。
function earlyLogDir() {
  const cands = []
  if (process.env.PORTABLE_EXECUTABLE_DIR) cands.push(process.env.PORTABLE_EXECUTABLE_DIR)
  try {
    cands.push(path.dirname(process.execPath))
  } catch { /* ignore */ }
  try {
    if (process.env.LOCALAPPDATA) cands.push(path.join(process.env.LOCALAPPDATA, 'suiji-ledger-desktop-crash'))
  } catch { /* ignore */ }
  for (const d of cands) {
    try {
      fs.mkdirSync(d, { recursive: true })
      return d
    } catch { /* 换下一个候选 */ }
  }
  return null
}
let logFile = null
let bootLog = null
try {
  const d = earlyLogDir()
  if (d) {
    bootLog = path.join(d, 'SuijiLedger-boot.log')
    logFile = path.join(d, 'data', 'logs', 'main.log')
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
  }
} catch {
  logFile = null
  bootLog = null
}
function logLine(...args) {
  try {
    const line = new Date().toISOString() + ' ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
    console.log(line)
    if (bootLog) fs.appendFileSync(bootLog, line + '\n')
    if (logFile && logFile !== bootLog) fs.appendFileSync(logFile, line + '\n')
  } catch {
    /* 日志失败不能影响启动 */
  }
}
process.on('uncaughtException', (e) => {
  logLine('[fatal] uncaughtException:', e && e.stack ? e.stack : String(e))
})
process.on('unhandledRejection', (e) => {
  logLine('[fatal] unhandledRejection:', e && e.stack ? e.stack : String(e))
})

logLine('[boot] entry version=' + APP_VERSION + ' execPath=' + process.execPath +
  ' gpuSafe=' + GPU_SAFE + ' argv=' + process.argv.slice(1).join(' '))

/**
 * 残留自愈（用户要求：双击启动时先检查残留进程，有就杀掉历史进程再起）。
 *
 * 背景：Electron 单实例锁是 userData 下的 SingletonLock 文件+socket。进程被杀软/断电/任务管理器
 * 强杀后，锁文件残留，新实例 `requestSingleInstanceLock()` 返回 false → 直接 quit，
 * 用户视角就是"双击没反应/闪一下没了"，且无任何提示（旧行为）。
 *
 * 策略（误杀代价 >> 残留代价，所以宁可放过不可误杀）：
 *  1. 锁失败 → 先判活：读锁文件里的持有者 PID，用 tasklist 查它是否还活着；
 *  2. 持有者已死（僵尸锁）→ 删 SingletonLock/SingletonSocket/SingletonCookie，重试拿锁；
 *     重试成功 = 自愈，走正常启动；重试仍失败 = 真有活实例，把它顶到前台后退出；
 *  3. 持有者还活着 → 说明是真双击/真多开，不杀（那可能是用户开着旧窗口），只把旧窗口顶上来后退出。
 *
 * 注意：删锁文件只在 Windows 上做（`SingletonLock` 文件锁语义在 Win 下是"文件存在即持有"，
 * 删掉即可释放；POSIX 下是 flock，删文件没用——mac/Linux 走原逻辑直接退出）。
 * taskkill 只在"确认是本应用残留子进程且持有者已死"时才用？不——这里不杀进程，
 * 只清锁文件。僵尸进程本身会被系统回收，清锁就够了。杀进程风险太高（PID 复用会误杀）。
 */
function readLockPid() {
  try {
    const lockFile = path.join(app.getPath('userData'), 'SingletonLock')
    const raw = fs.readFileSync(lockFile, 'utf8').trim()
    const pid = Number(raw.split(/[^0-9]/)[0])
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}
function isPidAlive(pid) {
  try {
    // tasklist 按 PID 查：活着返回一行进程信息，死了返回 "INFO: No tasks are running"
    const out = require('child_process').execSync(`tasklist /FI "PID eq ${pid}" /NH /FO CSV`, {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    })
    return out.includes(`"${pid}"`)
  } catch {
    return false
  }
}
function clearStaleLock() {
  if (process.platform !== 'win32') return false
  const dir = app.getPath('userData')
  let cleared = false
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'SingletonCookie-journal']) {
    try {
      const f = path.join(dir, name)
      if (fs.existsSync(f)) {
        fs.unlinkSync(f)
        cleared = true
      }
    } catch { /* 被占用就跳过，不强删 */ }
  }
  return cleared
}

let gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  const holder = readLockPid()
  const alive = holder !== null && isPidAlive(holder)
  logLine('[lock] first try failed, holder pid=', holder, 'alive=', alive)
  if (holder !== null && !alive) {
    // 僵尸锁：持有者已死，清锁文件后重试
    const cleared = clearStaleLock()
    logLine('[lock] stale lock holder dead, cleared files=', cleared, ', retrying...')
    gotLock = app.requestSingleInstanceLock()
    logLine('[lock] retry result=', gotLock)
  } else if (holder === null) {
    // 读不到持有者（锁文件损坏/权限问题）：也试一次清锁+重试，救能救的
    const cleared = clearStaleLock()
    logLine('[lock] holder unknown, cleared files=', cleared, ', retrying...')
    gotLock = app.requestSingleInstanceLock()
    logLine('[lock] retry result=', gotLock)
  } else {
    logLine('[lock] holder alive, another running instance owns the lock')
  }
}
if (!gotLock) {
  logLine('[exit] second instance (lock held by live holder or retry failed), quitting')
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore()
      mainWin.focus()
    }
  })

  app.whenReady().then(bootstrap).catch((e) => {
    logLine('[fatal] bootstrap rejected:', e && e.stack ? e.stack : String(e))
    // 无弹框秒退时用户唯一能看到的就是这个框：弹框本身再崩也不能吞日志（日志已落盘）
    try {
      const { dialog } = require('electron')
      dialog.showErrorBox('SuijiLedger 启动失败', String((e && e.message) || e))
    } catch (e2) {
      logLine('[fatal] errorBox failed:', String((e2 && e2.message) || e2))
    }
    app.quit()
  })
}

app.on('window-all-closed', () => {
  // 启动期（主窗口还没建好）所有窗口关闭都忽略：隐藏探测窗口的关闭会先触发这里，
  // 0.3.13 的闪退就是它干的——探测窗一关就 quit，主窗口刚出来就被杀。
  if (!bootDone) {
    logLine('[boot] ignore window-all-closed during boot')
    return
  }
  logLine('[exit] window-all-closed')
  app.quit()
})
app.on('will-quit', () => logLine('[exit] will-quit'))
app.on('render-process-gone', (_e, wc, details) => {
  logLine('[fatal] render-process-gone:', details ? details.reason : 'unknown',
    details && details.exitCode !== undefined ? 'exitCode=' + details.exitCode : '')
})

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
  logLine('[boot] start, version=' + APP_VERSION + ' argv=', process.argv.slice(1).join(' '))
  Menu.setApplicationMenu(null)

  const dataDir = path.join(app.getPath('userData'), 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  // 日志切换到 userData（exe 同目录的只是早产儿日志，boot 起后统一归档到这里）
  try {
    const f = path.join(dataDir, 'logs', 'main.log')
    fs.mkdirSync(path.dirname(f), { recursive: true })
    logFile = f
    logLine('[boot] logFile switched to', f)
  } catch { /* 保持 exe 同目录日志 */ }
  logLine('[boot] dataDir=', dataDir)

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

  // 启动自检（.docs/21 §9 R5，评审修复项）：deps 是 copy-desktop-deps.mjs 手工算的闭包，
  // 漏一个包过去要等 Nest 模块求值才炸——窗口开了、服务端半死不活最难排。
  // require 服务端之前先把**必死项** resolve 一遍，缺了就明说缺什么，不开半残窗口。
  const missing = []
  for (const name of ['reflect-metadata', '@nestjs/core', '@nestjs/common',
    '@nestjs/platform-express', '@prisma/client', 'rxjs',
    'isomorphic-git', 'isomorphic-git/http/node']) {
    try {
      require.resolve(name)
    } catch {
      missing.push(name)
    }
  }
  logLine('[boot] deps check:', missing.length ? 'MISSING ' + missing.join(',') : 'ok')
  if (missing.length > 0) {
    logLine('[exit] missing deps, quitting')
    console.error('[desktop] 运行时依赖缺失（server/deps 不完整）:', missing.join(', '))
    const { dialog } = require('electron')
    dialog.showErrorBox(
      'SuijiLedger 无法启动',
      '安装包内缺少运行必需的依赖：\n' + missing.join('\n') +
      '\n\n这通常是打包时依赖闭包没铺全。请重新执行 npm run deps:desktop 后再打包，' +
      '或反馈打包版本号。',
    )
    app.quit()
    return
  }

  logLine('[boot] requiring server main.js...')
  require('./server/apps/server/src/main.js')
  logLine('[boot] server required, waiting for api...')

  const url = 'http://localhost:' + port + '/'
  const ready = await waitFor(url + 'api/auth/bootstrap', 20000)
  logLine('[boot] api ready=', ready)
  if (!ready) {
    logLine('[exit] server never became ready in 20s, quitting (see data/logs for server output)')
    const { dialog } = require('electron')
    dialog.showErrorBox(
      'SuijiLedger 服务启动超时',
      '内嵌服务 20 秒内没有就绪，已退出。\n请查看 data/logs/main.log，或用安装版重试。',
    )
    app.quit()
    return
  }

  // 渲染进程是"完全没窗口、无弹框"秒退的头号嫌疑（Win11 核显驱动 + Chromium 已知有秒崩 case）。
  // 先无头加载一次：能 ready 说明 GPU 有问题 → 自动降级重开可见窗口；不能则直接走可见窗口（老行为）。
  logLine('[boot] preload probe (hidden, 8s)...')
  let gpuOk = false
  try {
    const probe = new BrowserWindow({ width: 400, height: 300, show: false, backgroundColor: '#121318' })
    const probeOk = await new Promise((resolve) => {
      const done = (v) => {
        try { if (!probe.isDestroyed()) probe.close() } catch { /* ignore */ }
        resolve(v)
      }
      const timer = setTimeout(() => done(false), 8000)
      probe.webContents.on('did-finish-load', () => { clearTimeout(timer); done(true) })
      probe.webContents.on('did-fail-load', (_e, code, desc) => { clearTimeout(timer); logLine('[boot] probe fail-load:', code, desc); done(false) })
      probe.webContents.on('crashed', () => { clearTimeout(timer); logLine('[boot] probe crashed'); done(false) })
      probe.webContents.on('render-process-gone', (_e, d) => { clearTimeout(timer); logLine('[boot] probe gone:', d && d.reason); done(false) })
      probe.loadURL(url).catch((e) => { clearTimeout(timer); logLine('[boot] probe loadURL throw:', String((e && e.message) || e)); done(false) })
    })
    gpuOk = probeOk
  } catch (e) {
    logLine('[boot] probe throw:', String((e && e.message) || e))
    gpuOk = false
  }
  logLine('[boot] preload probe result gpuOk=', gpuOk)
  if (!gpuOk) {
    // 自动降级：本次进程直接禁用 GPU 重开可见窗口（无需用户找 --safe-gpu 参数）
    logLine('[boot] enabling gpu fallback switches and retrying visible window')
    app.commandLine.appendSwitch('disable-gpu')
    app.commandLine.appendSwitch('disable-software-rasterizer')
  }
  logLine('[boot] creating window...')
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
  mainWin.webContents.on('did-fail-load', (_e, code, desc) => logLine('[window] did-fail-load:', code, desc))
  mainWin.webContents.on('crashed', () => logLine('[fatal] renderer crashed'))
  mainWin.webContents.on('render-process-gone', (_e, d) => logLine('[fatal] window render-process-gone:', d && d.reason, 'exitCode=' + (d && d.exitCode)))
  mainWin.on('unresponsive', () => logLine('[window] unresponsive'))
  mainWin.loadURL(url)
  logLine('[boot] window created, url=', url)
  // 外部链接用系统浏览器打开
  mainWin.webContents.setWindowOpenHandler(({ url: u }) => {
    shell.openExternal(u)
    return { action: 'deny' }
  })
  mainWin.on('closed', () => {
    logLine('[exit] window closed')
    mainWin = null
  })
  bootDone = true
  logLine('[boot] done')
}

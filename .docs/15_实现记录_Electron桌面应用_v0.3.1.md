# 实现记录 · Electron 桌面应用（v0.3.1）

| 项 | 内容 |
|---|---|
| 日期 | 2026-10-24 |
| 产物 | `apps/desktop/dist/` → `SuijiLedger-桌面版-安装包-v0.3.1.exe`（NSIS，106 MB）<br>`SuijiLedger-桌面版-直接启动-v0.3.1.exe`（Electron Portable，105 MB） |
| 起因 | 项目所有者澄清：Windows 包要**真正的桌面窗口程序**，不要"黑窗口 + 浏览器"形态（v0.3.0 两个产物因此废弃） |

## 架构（单进程 Electron）

```
SuijiLedger.exe（Electron 33）
├─ 主进程 main.js
│   ├─ 动态空闲端口（38999 起）→ 内嵌 NestJS 服务（编译产物 require 即启动）
│   ├─ DATA_DIR = %APPDATA%/suiji-ledger-desktop/data（SQLite；**运行时自建表**）
│   ├─ 旧版 v0.3.0 包数据自动迁移（%LOCALAPPDATA%\SuijiLedger\data → 新目录）
│   └─ BrowserWindow(1360×880) 加载 http://localhost:{port}（无菜单栏、单实例、外链走系统浏览器）
└─ server/deps + server/apps|packages   服务端编译树 + 生产依赖（deps 规避 builder 对 node_modules 的裁剪）
```

## 验证记录

| 用例 | 结果 |
|---|---|
| win-unpacked 实测启动 | ✓ Nest 全路由注册、**全新目录自建表**、38999 监听、data/money.db+secret.key 生成 |
| NSIS 安装包 + Portable exe 构建 | ✓（未签名，首次运行会有 SmartScreen 提示，选"仍要运行"） |
| 单实例锁 / 二次启动聚焦已有窗口 | 代码实现（未逐一实测） |

## 过程问题备忘

1. **electron-builder 强制裁剪名为 node_modules 的目录**（无论层级）→ 运行时依赖改名为 `server/deps/`，主进程用 `NODE_PATH + Module._initPaths()` 挂载解析
2. Prisma 引擎为 N-API 构建，Electron 内无需重编译；`asar:false` 避开引擎解包问题
3. electron-builder 用 `electronVersion: 33.2.0` 配置自行下载运行时，无需 electron npm 包（避免与手拷的运行时 node_modules 冲突）
4. 桌面版数据目录 `%APPDATA%/suiji-ledger-desktop/data` 与 v0.3.0 旧包不同 → 启动时自动迁移旧数据

## 产物对照（Windows 全家福）

| 版本 | 形态 | 说明 |
|---|---|---|
| 桌面版 v0.3.1（本次） | Electron 窗口程序 | 推荐日常使用 |
| v0.3.0 服务端形态包 | 启动器+浏览器 | 已被桌面版取代，产物保留在 dist-windows（可删） |
| 安卓 v0.2.3 | 离线 APK | 手机端 |

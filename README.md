# Suiji Ledger · 月度平账记资产负债

> 每月记一次各账户余额，系统自动平账、算结余、估日均开销。
> 数据 100% 自托管（SQLite 单文件），支持钱迹数据导入，PWA 可安装到安卓桌面，≥1024px 自动切换 PC 桌面布局。

文档基线见 [`.docs/`](./.docs/)（05/06/07/08 号文档为现行方案；钱迹 19 列格式规格见 `.docs/.history/02` §5）。

## 功能（v0.1 · M1+M2+M5 已实现）

- **平账**：每月一次填各账户余额（手机卡片 + 数字键盘 / PC 表格 + Ctrl+S），大项（工资/房贷等，类型自定义）可选记，剩余差额自动生成 ⚖️ 平账条目，**Σ条目 ≡ Σ余额变动 恒等成立**
- **总览**：净资产大卡 + 迷你走势 + 本月账户变动 + 变动构成 + 平账提醒条
- **走势**：净资产折线、月度结余柱状、**区间日均开销**（两次记录区间 → 天数/支出估算/日均，未记收入时明确标注"估算"）、日均柱状图
- **账户**：资产/负债分组、归档（保留历史）、账户历史余额
- **类型管理**：内置「平账」不可删；自定义类型 = emoji + 名称 + 收支方向；删除时历史条目回退平账
- **PC 端**：≥1024px 侧栏布局 + 资产负债总表（月份 × 账户矩阵 + 日均开销列）+ 表格化平账；快捷键 `N` 平账、`1/2/3/4` 切页、`/` 预留、`Ctrl+S` 保存
- **数据**：全量备份 JSON 导出/恢复（覆盖与合并）、资产负债总表 CSV 导出
- **时间排序**：全站「倒序（新→旧，默认）/ 顺序（旧→新）」开关（我的页、总表表头、各列表页胶囊任一处切换即全局生效），覆盖月份总表、账户历史、搜索、借还、回收站、月度变动构成与 CSV/xlsx 导出；方向存 `settings.timeSortDir`，换设备跟随账号
- **PWA**：manifest + Service Worker，安卓 Chrome「添加到主屏幕」即可安装
- **深色模式**：跟随系统 / 手动切换
- **M3 钱迹账单导入**：解析钱迹导出 Excel/CSV → 自动生成月度快照（`apps/web/src/import/qianji.ts`）
- **M4 Git 自动同步（服务端/Electron 桌面）**：一条记录一个文件投影进私有 git 仓；本地自动提交、远端双向合并、双端同改进对照界面人工裁决（PC 三窗口 / 移动两窗口）、AES-256-GCM 整文件加密档（一开即退化为整份二选一）、租约式强推（D9）。设计见 `.docs/21`，交付见 `.docs/23`。**离线 APK 不含同步引擎**（D11）：手机连自家服务端照样受益。
- **Windows 桌面版（Electron，现行）**：安装包（NSIS）支持控制面板卸载，卸载时**明确询问是否连同本地数据清除**；「直接启动」Portable 免安装。数据在 `%APPDATA%\suiji-ledger-desktop\data`，自动从旧版便携包（`%LOCALAPPDATA%\SuijiLedger\data` / `MoneyRecord\data`）迁移。

**未实现（按计划后续迭代）**：多用户；墓碑超期清理与 `meta.json.purgedUids`（缺"保留期"口径，`.docs/21` §14.1）。

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | Vue 3 + TypeScript + Vite + Pinia + Vant 4 + ECharts（移动优先，响应式 PC 布局） |
| 后端 | NestJS + Prisma + SQLite（ts-node 直跑） |
| 共享库 | `packages/shared`（金额分↔元、区间统计公式，前后端同一份） |
| 金额 | 内部一律整数「分」存储（Int，上限约 ¥2,147 万，个人使用足够） |
| 部署 | Docker Compose 单容器，数据卷 = `apps/server/data` |

## 本地运行（开发）

```bash
# 0. 依赖：Node.js 20+
npm install          # 安装全部 workspace 依赖
npm run db:push      # 创建 SQLite 表（apps/server/data/money.db）

# 1. 启动后端（含生产模式静态托管，构建过前端则直接访问 3000）
npm run dev:server   # http://localhost:3000

# 2. 前端热更开发（可选，另开终端）
npm run dev:web      # http://localhost:5173（已代理 /api → 3000）

# 3. 构建前端产物（由 3000 端口直接托管）
npm run build:web
```

首次访问 → 设置访问口令（≥6 位）→ 添加账户 → 点「＋平账」记录第一个月。

**演示数据**（与 UI 设计稿数字一致）：

```bash
cd apps/server && node scripts/seed-demo.mjs   # 需服务已启动；口令默认 test123456
```

## 安卓 APK（离线版，v0.2.14）

**APK 完全离线自持**：前端与本地数据层（localStorage）全部打包在 APK 内，装上即用、无需电脑、无需网络。数据存手机应用内；卸载或清除应用数据会丢失，请定期在「我的 → 导出全量备份 JSON」（保存到手机 `下载/SuijiLedger/`）。

```bash
# 构建（需 JDK + build-tools，见 mobile/build-apk.py 顶部说明）
cd apps/web && VITE_OFFLINE=1 npx vite build --base=./ --outDir dist-mobile
cd ../../mobile && python build-apk.py
# 产物：dist/SuijiLedger-v0.2.12.apk（已签名，minSdk 24 / targetSdk 35）
```

架构：`MainActivity`（全屏 WebView + 文件桥）+ `AssetHost`（回环 127.0.0.1:18080 资源服务器）+ 离线本地后端（`apps/web/src/local/backend.ts`，与 NestJS 服务端同一套接口与业务口径）。备份导出/导入通过 JS 桥写入/读取手机「下载/SuijiLedger」目录（Android 10+）。

> 升级安装必须同签名：keystore `mobile/moneyrecord.jks`（**口令不入库**，构建时通过环境变量 `SJ_KEYSTORE_PASS` 提供，或写入 `mobile/keystore-pass.txt`，该文件已 gitignore）。keystore 文件名与 alias 沿用旧版，以确保可覆盖升级已有 APK。

## 双模式说明

| 模式 | 载体 | 数据位置 | 适用 |
|---|---|---|---|
| **离线模式**（APK） | 手机 App | 手机本地存储 | 随身记账，无网可用 |
| **服务端模式**（浏览器访问 3000 端口） | PC/手机浏览器 | 电脑 SQLite | 家庭共享、PC 大屏总表 |

两种模式数据不自动互通，通过「导出/导入全量备份 JSON」迁移（格式一致）。

## 安卓（PWA 方式，可选）

1. 局域网/公网部署后，用 **HTTPS** 访问（可用 Caddy/Nginx 反代；或本机 `localhost` 直接可装）；
2. 安卓 Chrome 菜单 → **添加到主屏幕/安装应用**。

> HTTP + 局域网 IP 时 Chrome 不出安装提示，可临时用 `chrome://flags/#unsafely-treat-insecure-origin-as-secure` 或上 HTTPS。推荐直接用上面的 APK。

## Docker 部署

```bash
npm install && npm run build:web     # 先构建前端
docker compose up -d --build         # 数据持久化在 ./data
```

## 目录结构

```
suji-ledger/
├── .docs/                  # 需求/设计文档（.history/ 为历史版本；21=M4设计、23=M4交付）
├── apps/
│   ├── server/             # NestJS API（auth/accounts/types/months/stats/system/sync）
│   │   ├── prisma/schema.prisma
│   │   ├── scripts/seed-demo.mjs   # 演示数据
│   │   └── data/           # SQLite + 备份 + git 仓 + git.key/secret.key（数据卷，勿入库）
│   ├── desktop/            # Electron 桌面版（安装包 NSIS + Portable；nsis/customUninstaller.nsh=卸载数据确认）
│   └── web/                # Vue3 前端（views: 总览/走势/平账/账户/月详情/类型/同步/我的）
├── windows/                # 旧版便携包打包链（v0.3.0，已被 Electron 取代，保留可构建）
├── mobile/                 # 安卓离线 APK（WebView + 资源服务器 + 本地后端）
├── packages/shared/        # 金额与区间统计纯函数
├── Dockerfile / docker-compose.yml
└── README.md
```

## API 摘要（鉴权：Bearer JWT，`/api` 前缀）

`POST /auth/setup|login|password` · `GET /accounts` + CRUD · `GET /types` + CRUD ·
`GET /months?limit&dir` · `GET /month/:ym` · **`POST /reconcile`**（当月快照+大项全量保存，自动重算平账条目）·
`PATCH|DELETE /month/:ym/entry/:id`（大项编辑，平账自动重算）·
`GET /stats/networth|daily-avg|interval` · `GET/PUT /system/settings` ·
`GET /system/matrix|matrix.csv?dir|backup` · `POST /system/restore` · `GET /system/health` ·
`GET /search?q&minYuan&maxYuan&dir` · `GET /loans?dir` · `GET /recycle?dir` ·
**Git 同步（M4）** `GET /system/sync/status` · `POST /system/sync/run?phase=push|pull&force=lease` ·
`GET /system/sync/conflicts` · `POST /system/sync/resolve` · `DELETE /system/sync/conflict`（放弃合并）·
`GET /system/sync/history?limit&cursor` · `GET /system/sync/diff?oid` · `POST /system/sync/restore`（按版本恢复）

> `dir=desc`（默认，时间倒序＝新的在前）/ `dir=asc`（时间顺序＝旧的在前），与设置项 `timeSortDir` 同语义；
> `limit` 始终取「最近 N 个月」，只翻返回顺序，不动取数范围。

## 已知限制与说明

- 金额 Int 分存储上限约 ¥2,147 万/笔；如需更大改 Prisma BigInt + JSON 序列化层
- 归档/「计入净资产」开关会整体作用于历史统计（v1 取舍，文档已注明）
- Git 自动同步（M4）已交付（服务端 + Electron 桌面）：设计 `.docs/21`、交付记录 `.docs/23`；离线 APK 按计划不含同步引擎（D11）。**`DATA_DIR/git.key` 丢失 = 历史密文不可解，等同丢失远端**——备份 JSON 里带 `keyHint`（密钥指纹前 12 hex）供人眼核对；请单独留存 git.key
- 历史膨胀治理已实装（`.docs/21` §6.5）：提交条数超过 `gitKeepCommits`（默认 500，`Setting` 表可调，低于 50 按 50 执行）时，把分支滚到"以当前投影为内容的新根提交"，旧历史用 `snapshot-<n>` tag 锚住；滚动只在"刚推成 + 租约允许 + 无未合并状态"时发生，且需要一次强推把断链后的历史送达远端。墓碑**不会**被物理删除（R10 的超期清理仍缺"保留期"口径），兜底是 `DATA_DIR/backups/` 30 份轮转
- **代码仓 ≠ 数据仓**：同步引擎写的是设置里 `gitRemote` 指向的**私有数据仓**（建议私有），账本数据绝不进本代码仓；`DATA_DIR/git.key`、`money.db` 与投影仓库都在 `.gitignore` 内
- 平账大项落库新语义（uid-diff）可用 `Setting.reconcileLegacy='on'` 一键回退旧"全量替换"（R1 灰度；本机设置，不投影进 git）
- 演示/测试数据可用 `node scripts/seed-demo.mjs` 一键重建；彻底清库删除 `apps/server/data/` 后重启

## 环境变量与运维脚本

| 变量 | 说明 |
|---|---|
| `DATA_DIR` | 数据目录（SQLite、secret.key、git.key、git/ 仓库、backups/）；缺省 `apps/server/data` |
| `SUIJI_DATABASE_URL` | 显式覆盖 Prisma 连接串（测试/特殊部署用）；不设时由 `DATA_DIR` 推导并**强制覆盖** .env 里的相对值 |
| `PORT` | 服务端口（Electron 桌面版用动态端口，忽略此项） |
| `SYNC_DEBUG=1` | 同步排障日志（每步 oid/结论） |

```bash
npm run m4a:migrate    # M4a uid/rev 迁移（幂等；先跑 --dry-run 看清单：node apps/server/scripts/m4a-migrate.mjs --dry-run）
npm run deps:desktop   # 桌面打包依赖闭包（isomorphic-git 传递闭包 + Prisma 客户端 → apps/desktop/server/deps；--to <dir> 可指到旧 windows 链的 staging）
node apps/server/scripts/e2e-sync.mjs   # 双实例同步对敲（验收用，tmpdir 内自足，不碰真实数据）
```

---

*本项目为个人自用软件的独立实现；钱迹（QianJi）相关逆向结论仅用于数据格式兼容目的，不包含其任何代码、资源与文案，亦不得用于侵害原作者权益的用途。*

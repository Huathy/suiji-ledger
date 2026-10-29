# 实现记录 · Windows 包（v0.3.0：安装包 + 便携版）

| 项 | 内容 |
|---|---|
| 日期 | 2026-10-24 |
| 产物 | `dist-windows/SuijiLedger-安装包-v0.3.0.exe`（91 MB）<br>`dist-windows/SuijiLedger-便携版-v0.3.0.zip`（85 MB） |
| 形态 | **本机服务 + 浏览器界面**：无需 Node 环境与任何依赖，双击启动器 → 自动起服务（隐藏窗口）→ 自动打开浏览器 http://localhost:3000 |

## 打包结构

```
SuijiLedger/
├── SuijiLedger.exe      PyInstaller 启动器：起 node（隐藏）→ 健康检查 → 自动开浏览器
├── start-server.bat     手动前台启动（看日志）
├── 停止服务.bat          按端口杀进程
├── runtime/node.exe     Node.js 官方二进制（MIT）
├── app/
│   ├── build/           服务端 TS 编译产物（tsc rootDir=monorepo 根，shared 库同树编译）
│   │   └── apps/web/dist  前端产物（由服务端静态托管）
│   └── node_modules/    生产依赖（staging 干净安装 + 拷贝 .prisma 生成客户端与引擎）
├── uninstall.cmd        卸载（保留 data 数据目录）
└── data/                首次启动自动创建（SQLite；**首次启动服务端自建表，免 prisma CLI**）
```

## 安装包行为（PyInstaller onefile 内嵌便携 zip）

解压到 `%LOCALAPPDATA%\SuijiLedger` → 桌面/开始菜单快捷方式 → HKCU 卸载注册表项（控制面板可卸载）→ 自动启动。卸载脚本保留 `data`（数据备份至 `%LOCALAPPDATA%\SuijiLedger-data-备份`）。

## 验证记录

| 用例 | 结果 |
|---|---|
| 便携包启动器（临时目录 + 端口 3100） | ✓ 服务起、**全新数据目录自动建表**、setup 口令、/types 内置平账、SPA 静态托管 |
| 安装包测试模式解压 | ✓ 4501 文件全部落位，SuijiLedger.exe/web dist 存在 |
| 兼容性 | 编译产物相对路径深度与 src 一致，DATA_DIR/静态目录均按包根解析 ✓ |

## 过程问题备忘

1. shared 库跨包导入 → tsc rootDir 设为 monorepo 根，输出镜像目录树
2. 全新数据目录没有表 → PrismaService.ensureSchema() 运行时执行 DDL（幂等，与 schema.prisma 一致）
3. PyInstaller --add-data 保留原文件名 → 内嵌 zip 必须用 ASCII 名（SuijiLedger-portable.zip）
4. zip 内顶层 SuijiLedger/ 目录导致解压多一层 → 安装器逐条目剥离前缀
5. 测试发现 curl/Git Bash 中文请求体 mojibake 是环境问题，接口测试统一 Node fetch

## 使用限制

- 启动器默认端口 3000（可传参：`SuijiLedger.exe 3100`）；3000 被占用时请先 停止服务.bat
- 关闭启动器黑色窗口 = 停止服务；数据在 `data/`，拷贝即备份
- 与安卓离线版（v0.2.3）数据不自动互通，通过备份 JSON 互迁

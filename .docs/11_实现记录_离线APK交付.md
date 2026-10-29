# 实现记录 · 离线安卓 APK 交付（v0.2.0）

| 项 | 内容 |
|---|---|
| 日期 | 2026-10-24 |
| 产物 | `dist/SuijiLedger-v0.2.0.apk`（390 KB，自签名，versionCode 2，minSdk 24 / targetSdk 35） |
| 变更起因 | 项目所有者明确要求：**不能用客户端-服务端模式，必须离线可用**。v0.1.0 的"WebView 壳指向电脑服务端"方案废弃 |

## 架构（离线自持）

```
APK (com.suiji.ledger.app v0.2.0)
├─ MainActivity（全屏 WebView + AndroidBridge 文件桥）
├─ AssetHost（回环 127.0.0.1:18080，服务内置前端）
└─ 前端 = VITE_OFFLINE=1 构建
     └─ apps/web/src/local/backend.ts —— 本地后端
          与 NestJS 服务端同接口/同业务口径，数据存 localStorage（mr_local_db_v1）
          免登录直进；备份导出/导入走 AndroidBridge ↔ 手机「下载/SuijiLedger」
```

PC 浏览器访问 3000 端口的服务端模式保持不变；两模式以备份 JSON（格式一致）互通。

## 验证记录（浏览器实测离线模式全流程）

| 步骤 | 结果 |
|---|---|
| 免登录直进首页空态引导 | ✓ |
| 添加账户（招行 55,700）持久化 | ✓ |
| 新建类型「工资（收入）」 | ✓ |
| 平账 58,900 + 大项 12,000 → 自动平账 −8,800 | ✓ 恒等式成立 |
| 资产负债总表 / 月度详情渲染 | ✓ |
| 刷新后数据仍在（localStorage 持久化） | ✓ |
| APK badging / assets / 签名 | ✓ |

## 过程问题备忘

1. `localHandle` 路由未剥离查询串（`/months?limit=12` 匹配失败）→ 入口先 `split('?')`
2. 月度详情页脚"合计"在首月（环比 null）误显示 +0.00 → 回退为 Σ条目
3. WebView 中 `<input type=file>` 默认不可用、blob 下载受限 → 实现 JavascriptInterface 桥（saveFile→MediaStore Downloads / pickFile→ACTION_OPEN_DOCUMENT→evaluateJavascript 回调）
4. v0.1.0 APK 已删除；升级到 v0.2.0 为覆盖安装（同签名）

## 已知限制

- 数据在应用私有存储：**卸载 App 或"清除数据"会丢失**，请定期导出备份（我的 → 导出全量备份 JSON）
- 手机本地数据量与 PC 服务端不自动同步
- 旧版 Android（<10）备份保存到应用外部目录 `Android/data/com.suiji.ledger.app/files/export/`

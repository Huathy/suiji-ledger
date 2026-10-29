# 实现记录 · 安卓 APK 交付（v0.1.0）

| 项 | 内容 |
|---|---|
| 日期 | 2026-10-24 |
| 产物 | `dist/SuijiLedger-v0.1.0.apk`（388 KB，已自签名，minSdk 24 / targetSdk 35） |
| 形态 | 极简 WebView 壳（2 个 Java 类）：前端构建产物内置于 APK assets，数据仍来自自托管服务端 |

## 架构

```
APK (com.moneyrecord.app)
├─ MainActivity（全屏 WebView，回退键/状态恢复）
├─ AssetHost（回环 127.0.0.1:18080 资源服务器，服务 assets 内的前端）
│    └─ 用 http://127.0.0.1 而非 file:// —— ES Module/fetch 需要 http origin
└─ assets/（vite build --base=./ 产物，登录页内置默认服务器 http://192.168.10.5:3000，可改）
        └─ API → http://电脑局域网IP:3000/api（服务端已开 CORS，usesCleartextTraffic 允许 http）
```

## 构建链（零 Gradle，`mobile/build-apk.py`）

本机无 Android Studio SDK，只有独立 build-tools r35 → 手工流水线：
下载 platform-35 提取 `android.jar` → `aapt2 compile/link`（资源+manifest+assets）→ `javac`（source 8 交叉编译）→ `d8` 转 dex → Python zipfile 重打包（resources.arsc 保持 STORED）→ `zipalign` → `keytool` 生成 keystore → `apksigner` 签名。

前端配套改造：`api/client.ts` 支持 `getServerBase()`（localStorage `mr_server` / `VITE_DEFAULT_SERVER` / 同源三级回退）；登录页新增「服务器」地址栏。

## 验证记录

| 检查 | 结果 |
|---|---|
| aapt badging | 包名/版本/权限/label/icon 正确 ✓ |
| assets 完整性 | 34 条目，index.html + 全部 js/css 在 assets/ ✓ |
| dexdump | DEX 037，AssetHost/MainActivity 两个类完整 ✓ |
| zipalign -c 4 | 通过 ✓ |
| apksigner verify --print-certs | CN=SuijiLedger，SHA-256 6643ea80… ✓ |
| 真机运行 | **未验证**（本机无模拟器/真机），首启如遇白屏优先检查服务器地址与防火墙 |

## 过程问题备忘

1. `aapt2 -A` 把 www 内容放 **assets 根**（assets/index.html），不是 assets/www/ —— AssetHost 读取路径已修正
2. dexdump 直接读 zip 在 Windows 上 mmap 失败 → 先解出 classes.dex 再检查
3. file:// 加载 Vite ES Module 会被 CORS 拦 → 内置回环 HTTP 服务绕开（标准做法）
4. 签名 keystore：`mobile/moneyrecord.jks`（alias `moneyrecord`，口令不入库：环境变量 `SJ_KEYSTORE_PASS` 或 `mobile/keystore-pass.txt`，已 gitignore），升级必须同签名

## 用户侧使用条件

1. 电脑启动服务（监听 0.0.0.0:3000）；
2. Windows 防火墙放行 3000 端口（命令见 README）；
3. 手机与电脑同一 Wi-Fi；登录页「服务器」确认地址（默认 http://192.168.10.5:3000，网卡变化时修改）。

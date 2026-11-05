# 23 · 实现记录 · M4 Git 同步（v0.6）

> 依据：`.docs/21_设计方案_M4_Git同步.md`（v1.2 定稿，v1.3 回写四处实现期修正）。
> 交付范围：M4a 数据模型 / M4b 投影与历史 / M4c 拉取合并与冲突对照 / M4d 加密与调度。
> 验收：`npx vitest run` 7 文件 59 例全绿；`tsc --noEmit`（server）干净；在线与离线（`VITE_OFFLINE=1`）构建通过；
> 双实例对敲脚本 `node apps/server/scripts/e2e-sync.mjs` 全通过。

---

## 1. 一句话

钱迹的账本数据现在能以"一条记录一个文件"的形态进 git：本地自动提交、远端双向合并、
双端同改进对照界面人工裁决、加密开关一开就退化为整份二选一。**没有静默丢数据的路径**。

## 2. 新增文件（14 个后端 + 2 个组件 + 5 个脚本/测试）

| 文件 | 职责 |
|---|---|
| `apps/server/src/sync/ledger.ts` | 纯格式与规则层：文件名规则、canonical 序列化、字段对照 `diffFields`、预选 `recommendPick`、驱动判定 `decideMerge`、裁决合成 `composeResolved`、指纹 |
| `sync/crypto.ts` | `git.key`（32B，`DATA_DIR/git.key`）、AES-256-GCM 信封、PAT 加解密、脱敏 |
| `sync/git-engine.ts` | isomorphic-git 薄封装（init/head/fetch/merge/push/log/statusMatrix/add/remove/commit/adoptRemote/abortMerge） |
| `sync/mappers.ts` | DB 行 ↔ `LedgerRecord` 双向映射（uid 化，快照 uid = `${ym}__${accountUid}`） |
| `sync/record-meta.service.ts` | `deviceId` / `rev` 推进 / 墓碑 / `ensureUids` 自愈 |
| `sync/apply-record.service.ts` | **唯一写通道**：吸收远端记录（rev 吸收、关系按 uid 解析、auto 过滤、恒等式重算） |
| `sync/codec.ts` | 记录文本编解码（明文 / 密文），`gitEncrypt` 只影响这一层 |
| `sync/project.service.ts` | 投影器：DB → 工作区（**永不物理删文件**）、`commitAll`、`commitMerge`（合并提交） |
| `sync/merge-driver.ts` | `mergeDriver` 接入：捕获三方原文、按 §5.3 判定、`meta.json` 永远取 ours |
| `sync/sync-config.service.ts` | 同步相关 Setting 读写、仓库目录、状态/冲突快照持久化 |
| `sync/schedule.ts` | `shouldRunNow`（daily / every-commit / manual）、离线退避分钟表 |
| `sync/sync.service.ts` | 主流程：`run` / `pullMerge` / `pushWithRetry` / `absorbAndRecompute` / `resolve` / `history` / `diff` / `restore` |
| `sync/sync.controller.ts` | `@Controller('system/sync')`：status / run / conflicts / resolve / conflict(DELETE) / history / diff / restore |
| `sync/sync.module.ts` | `@Global()` 模块，导出上述服务 |
| `apps/web/src/components/SyncConflictDialog.vue` | 冲突对照：PC 三窗口（逐字段 ◀/▶ + 结果预览）/ 移动端两窗口 |
| `apps/web/src/components/SyncBadge.vue` | 状态点：`ok→绿 / pending,syncing→琥珀 / conflict,fail→红 / unconfigured→灰` |
| `apps/server/scripts/m4a-migrate.mjs` | uid/rev 幂等迁移（已跑：3 类型 / 6 账户 / 12 快照 / 8 条目 / 1 借还） |
| `apps/server/scripts/copy-desktop-deps.mjs` | 桌面打包依赖白名单（isomorphic-git 及其 11 个传递依赖） |
| `apps/server/scripts/dev-git-http.mjs` | 本地 smart-HTTP git 服务（isomorphic-git 无 `file://` 传输，对敲验收必需） |
| `apps/server/scripts/e2e-sync.mjs` | 双实例对敲：11 步覆盖首推/认领/冲突/裁决/加密/密钥不匹配 |
| `tests/sync-ledger.test.ts` | 29 例：canonical 确定性、文件名规则、预选确定性、判定顺序、字段对照、设置白名单、调度 |
| `tests/sync-git-merge.test.ts` | 5 例：真实 git 合并（不同文件自动合并 / 同文件抛 `MergeConflictError` 且三方被捕获 / 借还取 max / `meta.json` 取 ours / 关合并整份冲突） |
| `tests/sync-crypto.test.ts` | 4 例：确定性 IV、密文不含明文、往返、密钥不匹配识别 |

## 3. 数据模型改动（M4a）

`RecordType / Account / MonthlySnapshot / ChangeEntry / Loan` 五张表各加：

```
uid       String?  @unique    // 跨设备主键，生成后永不重写
rev       Int      @default(1)
updatedAt Int      @default(0)
deleted   Boolean  @default(false)   // 墓碑，不物理删
origin    String   @default("")      // 最后写入的 deviceId，冲突平局时定序
```

配套行为改动：

- **`reconcile` 从"全量替换"改成 uid diff**（原实现 `deleteMany + create` 会丢 uid，让对端把"我改了列表"读成"删光+新增一堆"）。
- 所有 `list`/统计查询加 `deleted:false`；删除一律 `tombstone()`。
- `rev` 规则：本地改 `max(local, maxSeen)+1`；吸收时 `incoming.rev > local.rev` 直接取，`==` 时 `+1`（否则两端永远打平）。
- 自动平账条目（`auto:true`）**不参与同步**，各端自行重算。

## 4. 接口（`/api/system/sync`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/status` | `state`（unconfigured/idle/syncing/conflict/offline/error）+ pendingCommits + lastSyncAt + conflictCount + pushMode/mergeEnabled/encrypt |
| POST | `/run` | 手动同步（**query** `?phase=push\|pull`；`?force=lease`=D9 租约式强推，远端 oid≠`gitLastRemoteOid` 即拒绝转人工。v0.6.1 修正：原文误写 body，以实现为准） |
| GET | `/conflicts` | 冲突快照（items 含 base/local/remote 原文、字段对照、预选与理由；v0.6.1 起带 `autoMerged`＝§5.6.2 自动合并核对区） |
| POST | `/resolve` | 提交裁决 `{items:[{key,pick,fieldPicks?}], push}`；v0.6.1 起：pick=remote/字段覆盖时本机被覆盖行**进回收站**（§5.6.5），返回 `pushed` 真值 |
| DELETE | `/conflict` | 放弃合并（`abortMerge` + 清快照，本地数据不动） |
| GET | `/history` | 版本历史（消息/时间/作者/当时净资产） |
| GET | `/diff` | 某版本 vs 当前投影的增/删/改清单 |
| POST | `/restore` | 恢复到某版本（`preview` / `apply`，恢复会顶高 rev 复活墓碑；v0.6.1 起返回 `push` 结果，失败落 error 态不再静默） |

设置项：`gitRemote / gitBranch / gitPushMode(daily|every-commit|manual) / gitAutoCommit / gitEncrypt / gitMergeEnabled`（v0.6.1 修正：原文 `immediate` 不存在，键值实况 `daily` 为默认），
PAT 存 `gitAuthEnc`（AES-256-GCM），读接口只回 `已配置 · ****1a2f`。**这两个开关都是本机设置，不投影进 git。**

## 5. 验收结果（可复跑）

```
$ npx vitest run
 ✓ tests/time-sort.test.ts (10)   ✓ tests/local-migrate.test.ts (2)
 ✓ tests/local-backend.test.ts (7) ✓ tests/sync-ledger.test.ts (29)
 ✓ tests/sync-crypto.test.ts (4)   ✓ tests/qianji.test.ts (2)
 ✓ tests/sync-git-merge.test.ts (5)
 Test Files 7 passed · Tests 59 passed

$ node apps/server/scripts/e2e-sync.mjs
 [1] A 首推 → [2] B 认领远端历史 → [2b] 两端 4 条一致
 [3b] 分叉：A=1212000 / B=1214000（基准 1207000）
 [5] B 冲突：金额[both] ¥12,140.00 | ¥12,070.00 | ¥12,120.00
              备注[same] / 关联账户[same] / 月份[same]   ← same 不再假高亮
 [6][7] B 选远程 → 合并提交 → 推送 → A 收敛
 [8] 加密开启 → 断言 gitMergeEnabled 被强制 off
 [8d] 远端文件确为密文信封（无 amountCents 明文）
 [9] B 冲突：conflictType=encrypted，mode=whole-file
 [10] 裁决后双向收敛
 [11] 换随机密钥 → 冲突态且"以远程为准"被拒（不把解不开的密文写库）
 ✓ 全部通过
```

## 6. 实现期发现并修掉的 4 个坑（已回写方案 §13）

1. **`DATA_DIR` 对数据库无效**：`import '@prisma/client'` 在模块求值阶段就读 `.env` 注入相对 `DATABASE_URL`，
   原来的 `||=` 保不住 → 多实例静默共用一个库。`main.ts` 改为强制覆盖，e2e 加"库 mtime 哨兵"。
2. **裁决提交必须是合并提交**：单亲提交 → push 永不快进 → 回拉再冲突 → 冲突态原地复活（接口却返回 `ok:true`）。
3. **记录加密必须确定性 IV**：随机 IV 下同一内容两端密文不同 → 加密档 26 个文件全冲突。
4. **`diffFields` 缺 `same` 档**：三边相同的字段被标成"远端改过"，对照表满屏假高亮。

## 7. 已知边界（明确不做 / 留待后续）

- **密钥没有自动交换通道**：两端各生成一把 = 互相解不开（进冲突态并提示）。首次开加密前需手动放同一把 `git.key`；换密钥 = 全库重加密，会产生一次大规模变更提交。
- 移动端（`VITE_OFFLINE`）**不含 git 引擎**：`/system/sync/*` 走离线桩，返回 `unconfigured` 并说明"请在电脑端配置"（此前缺桩导致进「数据同步」白屏）。
- 历史膨胀治理（§6.5 的 squash）未做；先靠 `git gc` 与"一条记录一个文件"的天然低 churn 撑着。
- 离线 30 分钟重连自动补齐、`daily`/`every-commit` 调度的**定时器行为**只做了单测（`shouldRunNow`/`backoffMinutes`），未做长时挂机验收。
- `apps/web/src/local/backend.ts` 有 75 处历史遗留 `strict` 报错（`find()` 未判空），与 M4 无关；`vite build` 不做类型检查，未阻塞构建。

## 8. v0.6.1 代码评审修复（对照 .docs/21 的缺项清零）

| 修复项 | spec 依据 | 落点 |
|---|---|---|
| 租约式强推实装 | D9/§6.3 | `schedule.leaseAllowsForce()`（纯函数+单测）；`run({forceLease})` 先 fetch 比对 `gitLastRemoteOid`，不符即拒并转人工；controller `?force=lease` |
| 裁决覆盖进回收站 | §5.6.5 | `resolveInner` 对 pick=remote / 字段覆盖项，先把本机行写入 `DeletedItem`（kind 5 类，回收站可复活） |
| error 态退避 | §6.4 | 失败路径更新 retries/nextRetryAt（复用 1/5/15/30 退避尺；**不写 lastSyncAt**，避免把"没跑成"伪装成"今天跑过"）；tick 对 error 与 offline 同闸 |
| R13 preflight | docs/21 R13 | `run()` 开工先 `hasUnmerged()`：index 有 stage3 而无快照＝崩溃残局 → abortMerge+重投影（此前 hasUnmerged 零调用） |
| 吸收不再静默丢数据 | doc23 §1 | `readFileAt` 只把"对象不存在"折成 null，fs/zlib 真故障上抛；absorb 跳过的文件计数写入 lastError 可见 |
| 并发门 | 评审重点检查① | `gate()/pump()`：history/diff/restore/resolve/abort 与定时器 run 串行；门内直推 `pushInGate()` 不再自撞 busy |
| 裁决后推送诚实化 | 评审"界面说谎" | resolve 返回 `pushed` 真值与 push 结果；撞冲突不再覆盖成 idle；restore 的推送失败落 error 态 |
| PAT 明文键清零 | §7.2 | `token()` 懒迁移（加密进 `gitAuthEnc` 并清空明文键）；`m4a-migrate` 第 7 步批量迁移 + `--dry-run`；留痕备份过 SECRET_KEYS |
| 备份泄露 PAT | §7.2 | `backup()` settings 过滤 SECRET_KEYS（gitAuth/gitAuthEnc/gitConflictState 不再随 JSON 出机器） |
| keyHint 入备份 | §7.2 | `crypto.keyHint()`（主钥 sha256 前 12 hex），`backup()` 带出；README 已知限制补"密钥丢失"说明 |
| 密钥缓存认内容不认 mtime | §13.2 | `gitKey()` 缓存比对原文（等长+保留 mtime 的拷贝回归测试已入 sync-crypto） |
| 主钥域分离 | 评审重点检查② | HKDF-SHA256 派生 `recordKey()/secretKey()`；解密侧保留主钥兼容通道（历史密文/PAT 不炸） |
| secret.key 权限 | 评审重点检查③ | `main.ts` 补 `mode:0o600` 与 git.key 同款（POSIX 生效；Windows 靠 ACL） |
| autoMerged 核对区 | §5.6.2 | 驱动记录 cleanMerge 文件 → 冲突快照 → `/conflicts` → SyncConflictDialog 折叠区 |
| 移动端退出=放弃 | §5.6.3 第4条 | 两窗口 ✕/‹ 走 abort（abortMerge+清快照）；PC 仍只关层 |
| 移动端逐条应用 | doc08 §3.1 | 移动端「应用」只提交当前条；PC 批量 |
| 徽标重试次数 | §6.4 | SyncBadge/SyncView 文案带"已重试 N 次" |
| 哨兵值清理 | 气味 Data Clumps | `recommendFromTexts()` 取代 decideMerge 借道调用 |
| 死代码 | Speculative Generality | 删 `refreshState/writeOne/pathOf/currentBranch` 与 SyncRunState `'pending'`（前后端分支同步清） |
| dir 表双抄 | 气味 Duplicated Code | `relPathOf` 改用 ledger `kindOfFileName/DIR_OF` 唯一来源 |
| stamp 手抄 18 处 | 气味 Duplicated Code | 六处 service 统一 `...stamp` 展开 |
| 安装器双拷贝 | 气味 Duplicated Code | `windows/package.py` 不再内嵌全文/反向覆盖 installer.py，单一来源读文件注版本 |
| 卸载数据确认 | 评审 Q1 | Electron：`nsis/customUninstaller.nsh` 卸载前 Yes/No/Cancel 询问是否清除 `%APPDATA%\suiji-ledger-desktop`（/S 静默一律保留；makensis 语法验证通过）。旧链 uninstall.cmd：y/N 询问 + move 失败即中止（不再吞错后 rd /s /q）+ 保留模式只删程序不碰 data |
| 桌面迁移断链 | 评审 Q1 | `main.js` 认 `%LOCALAPPDATA%\SuijiLedger\data` 与 `MoneyRecord` 双路径，连 git.key/git 仓一并迁 |
| README/doc23 漂移 | — | README：M4/M3 状态、sync 8 端点、APK 0.2.12、环境变量表、m4a --dry-run；doc23：§4 phase=query、pushMode=daily、v0.6.1 修复表 |

---

## 9. v0.6.2 双轴复审修复（Standards × Spec 两路评审落地）

复审方式：以 HEAD=bb61294 为基点，Standards（规范/坏味道）与 Spec（.docs/21 忠实度）各由独立评审跑出报告，再逐条落地。

### 9.1 会丢数据 / 会说谎的路径

| 修复项 | 依据 | 落点 |
|---|---|---|
| 回收站 snapshot/type 不能恢复却照样删条目 | §1「没有静默丢数据」+ 本文 §8 承诺 5 类可复活 | `recycle.service.ts` 补两类恢复分支（快照按 uid→(ym,accountId) 唯一键复活，账户缺失明确报错）；未知 kind 抛 400，不再静默删 |
| 裁决中途 throw 400，前面已 apply 的项留在库里（界面显示整批失败、重试二次 apply） | §5.6.4 | `resolveInner` 两阶段：**整批预校验**（重复 key / 非法方向 / whole-file 带字段覆盖 / 选远程但远程不可解析）→ 再逐条落地；落地期写库异常也收尾（已裁项摘出快照、保持 conflict、返回 `partial:true`）。新增 `tests/sync-resolve-guard.test.ts` |
| `listFiles/log/hasUnmerged/statusMatrix` 仍 catch→空值：fs/zlib 故障被伪装成"没数据/没变更/没历史"还照常提交推送 | §1（本文 §8 只修了 readFileAt） | `git-engine.ts` 统一"只有 NotFound 类才折算空值，真故障上抛"；`isNotFound()` 唯一判据 |
| `hasUnmerged` 把 statusMatrix 第 3 列（WORKDIR 位）当 stage 判：可执行位=3 的正常文件被误判合并残局，每轮白做 abortMerge+重投影+多一条提交 | R13/R3 | 抽纯函数 `hasStage3()`（只认第 4 列）+ `tests/sync-gate.test.ts` 钉死列语义 |
| `run()` 抢门与置位之间有 await，并发两次 run 双双进主体并发改同一 `.git` | §6.1 串行化 | 入口**同步**抢门，配置校验挪进 `runInner`；测试断言并发第二次必拿 busy |
| 投影 `writeFileSync` 非原子，崩溃留半截 JSON 会被原样提交 | §4.3 | temp+rename 原子写；数据仓 `.gitignore` 补 `*.tmp` 兜底 |
| `phase='pull'` 成功也清零 pendingCommits（徽标谎报"无待推"） | §8.2 | pull 分支用 `engine.countAhead(branch)` 如实重算；⚠️ isomorphic-git **没有** `countAheadBehind` 公开 API（实测 exports 表），实现走 `log` 祖先链扫描 |
| 租约强推前端零触发面：后端全套实装、用户永远点不到，远端持续前进只能死循环 | §6.3/D9 + §5.6.5 二次确认 | `SyncView` 增「强制推送…」按钮（error/conflict 态）+ 确认弹窗 + `?force=lease`；后端被拒按 §6.3 置 conflict（不再 error 退避反复重试必然失败的强推） |
| 差异预览没接前端；spec 点名的 `findMergeBase` 全仓未用 | §4.5 / doc08 §3 | `/diff` 增 `baseOid`；`SyncView.restore` 先取摘要再确认 apply，口径：added=本机独有、removed=会带回、changed=会覆盖 |
| 加密跨端不一致只回一句"内容为密文"，分不清哪种情况 | §7.1 三行表 / R14 不静默降级 | 确定性信封带非机密 `enc.hint`（密钥指纹 12 hex），`decodeRecord` 据此回"密钥不匹配（远端指纹 X，本机 Y）"或"远端仓库已加密，请在本机开启加密并填入同一密钥"；同明文+同密钥仍逐字节一致（不破 §13.1） |
| 桌面包缺依赖要到 Nest 求值才炸 | R5 启动自检 | `apps/desktop/main.js` require 服务端前 `require.resolve('isomorphic-git')`，缺失弹框明说 |
| 旧 Windows 便携链装配必崩：assemble 用含 SyncModule 的 build-pkg + 无 isomorphic-git 的 staging | R5 | `copy-desktop-deps.mjs` 加 `--to`；`assemble.py` 装配前铺闭包、失败即中止出包 |

### 9.2 行为与规范偏差（已对齐或记明口径）

| 项 | 口径 |
|---|---|
| 合并干净路径的多余提交 | §5.5/§6.1 的 pull 只要求 `applyRecord` 吸收，旧实现吸收后又 `writeAll+commitAll('merge 吸收')` 白造提交 → 已删多余提交，只回写投影，rev 顶高造成的微差留给下一轮 `commitAll` 收 |
| `async-lock` | §6.1 写的是 `async-lock key='sync:run'`，实现是自研 `running` + `gate()/pump()` 队列。**本轮只修竞态，未换锁库**（换=重写串行化语义+全量回归）；差异记在 §9.3 |
| §6.1 preflight 的 `mode` | `SyncStateSnapshot.mode` 定义了从不写 → 删字段，`/status` 由 `mergeEnabled && !encrypt` 现算返回（不留第二份真相） |
| R1 reconcile 灰度 | 大项落库计划抽成纯函数 `months/bigitem-diff.ts`（`planBigItems`，含 `legacy` 全量替换分支），`Setting.reconcileLegacy='on'` 一键回退；R1 要求的三条回归用例落 `tests/reconcile-bigitems.test.ts`（含"他端新增不被物理删"这一 uid-diff 核心动机） |
| §4.1 basename 全库唯一 | 旧单测只验手工 6 条合成记录 → 新增 `tests/sync-project.test.ts` 走真实投影通道（六类混合 / 同 uid 跨类 / 白名单外设置不投影 / 墓碑照常投影） |
| 退避 setState 三处复制 | 收敛为 `markFailure()` 唯一落点（run 两个分支 + restore 推送失败）；`every-commit` 触发若拿不到门，重挂 debounce 等下一轮，不再丢事件 |
| 死字段 / 中间人 | 删 `ProjectResult.removed`（恒 `[]`）、`sync.service` 对 schedule 的再导出；`DriverOutcome.meta` 核实 isomorphic-git 只消费 `{cleanMerge,mergedText}`（mergeTree 8636/8871 行），保留仅作可读性注记——别再指望它把预选传给界面 |
| 历史分页 | `log` 深度被 `min(500,…)` 截断，500 条处 `nextCursor` 误报"没有更多" → 多取 1 条判位，深度上限放宽 2000 |

### 9.3 仍未做（诚实登记，别当成已完成）

- §6.5 `gitKeepCommits`(500) 分支滚动 + `writeRef`/tag `snapshot-<n>` 锚点——**v0.6.3 已实现**（见 §10.1）。R10 的超期墓碑清理与 `meta.json.purgedUids` 仍未做：缺的不是代码而是**墓碑保留期策略**（多久算超期、超期后对端如何区分"你删了记录"与"你清了墓碑"），这是新的设计决策，不属于"实现漏项"，须先定口径再写。
- §6.1 的 `async-lock` 未采纳（见 §9.2）。
- 定时器（daily 03:00 / 离线退避 / every-commit debounce）仍只有纯函数单测，无长时挂机验收。
- §4.2「Cents 整数字符串化」实现为 JSON number（`normalizeValue` 走 `Math.round`）：确定性合并成立，但 spec 明写的字符串化口径保持偏离（改它 = 全库 blob 重写，需迁移方案）。
- `timeSortDir` 在投影白名单里（§4.1 原文只列 theme/reminderDay/baseCurrency/groupOrder）：跨端排序方向一致是 v0.3.8 的有意扩展，**spec 需回写补一行**，否则文档与代码长期不一致。
- 旧 Windows 便携链（`windows/launcher.py`、`assemble.py`）仍在库，`windows/pack/` 是 10-24 的旧产物；现役发布链是 Electron。

### 9.4 验收（可复跑，本轮实测）

> 下面是 v0.6.2 当时的数；v0.6.3 复审修复后已升到 **21 文件 / 191 例**，见 §10.4。

- `npx vitest run`：**13 文件 / 100 例全绿**（新增 sync-resolve-guard 5、sync-project 2、sync-gate 4、reconcile-bigitems 6）
- `apps/server`：`tsc --noEmit` 退出 0
- 前端：`vite build`（在线）与 `VITE_OFFLINE=1 vite build --outDir dist-mobile`（离线 APK）均通过
- `node apps/server/scripts/e2e-sync.mjs`：双实例对敲全通过（首推 / 首拉认领 / 明文档冲突+字段对照+裁决+双向收敛 / 加密档整份二选一 / 密钥不匹配拒绝落地——末条报错已是 §9.1 的新预校验文案）
- `node apps/server/scripts/copy-desktop-deps.mjs --to <tmp>`：闭包 49/49 + Prisma 2/2 目录，探针内确认 `isomorphic-git/index.cjs` 落地

---

## 10. v0.6.3 第二轮双轴复审修复（2026-11-04，仍未提交）

复审方式同 §9：以 HEAD=`bb61294` 为基点，Standards 与 Spec 独立跑报告 → 逐条落地；本轮还额外做了"先修、再精简"两步（§10.2 的坏味道项是第二步）。

### 10.1 数据安全与会说谎的路径

| 修复项 | 依据 | 落点 |
|---|---|---|
| `restore('replace')` 物理 `deleteMany` 四表 → 工作区旧文件与旧 commit 树仍在，对端 pull 读成"删光+新增"，**已清数据复活** | §4.3 墓碑 / D3 / R10 | `system.service.ts` replace 改**五表**（补上此前漏掉的 `loan`）`updateMany({deleted:false → 墓碑})` 包进 `$transaction`；导入建**新活行**（`where` 带 `deleted:false`、uid 走 `meta.stamp()`）；月度快照三分支（活行更新 / 墓碑行原地复活 / 新建）。`tests/restore-tombstone.test.ts` 以"`deleteMany` 一旦被调用就抛错"作守卫 |
| `backup.service` 把 `setting.findMany()` 全量塞进 payload：`gitAuthEnc` 密文、`gitConflictState` 三方快照随 JSON 出机器，且无 keyHint | §7.2 | 密钥表抽成 `apps/server/src/secret-keys.ts`（单一来源，`system.service` 同源引用）；`snapshot()` 过滤 SECRET_KEYS 并带 `settingsKeyHint`。`tests/backup-secret-filter.test.ts` |
| 租约基准写本地 head 且 `phase='pull'` 也写 → 强推闸门假阳性 / 永久不可用 | §6.3/D9 | `runInner` 与 `pushInGate` 收敛成 `afterPush(engine,branch)`：只在**真推成**时写 `remoteOid`，只拉不推时写观测到的 theirs |
| 非载体文件（`.gitignore` 等）在驱动里返回 `cleanMerge:false` → 被造进冲突列表，用户勾选后 `resolveInner` 找不到 key **静默丢弃** | §5.4/R14 | `merge-driver.ts` 非载体直接 `cleanMerge:true`（不进 captured）；`sync-conflict.build()` 只收 `kindOfFileName` 命中的文件 |
| 裁决提交里出现未知 key 静默 `continue`（勾了等于没勾） | §5.6.4 | `resolveInner` 预校验阶段收集 unknown key → 400（文案"冲突快照不匹配/刷新后重裁"），并拒空计划 |
| `applyEntry` 缺 typeUid 时 `findFirst({builtin:true})` 挂到随机类型只 `log.warn`；`applySetting` 完全不比 rev 直接 upsert | R14 不静默降级 | `ApplyOutcome = {applied, ym?, reason?, warning?}`，reason 前缀 `skipped:`/`failed:`；`applyEntry` 回退内置类型时给 `warning`，连内置都没有则 `failed:type-missing`；`applySetting` findUnique → value 相同即 `skipped:identical` → 才 update/create；`absorbAndRecompute` 把 `failed:*` 与 `warning` 汇总进 `lastError` |
| `recommendPick` tie-break 用 `String(local.origin) >= String(remote.origin)`：origin 双空/相等时恒取 local（非对称） | §5.3「deviceId 字典序大者胜」 | `ledger.tieBreakPick()` 三级：origin 字典序 → 内容指纹 → 确定性兜底 |

### 10.2 精简重构（第二步）

| 坏味道 | 落点 |
|---|---|
| Divergent Change：`sync.service.ts` 1227 行单类兼调度/门队列/git 编排/冲突呈现/历史恢复 | 拆出 `sync-types.ts`（共享形状 + `SyncHost` 能力对象）、`sync-conflict.ts`（`SyncConflict`：呈现/裁决/放弃/回收站）、`sync-history.ts`（`SyncHistory`：历史/差异/恢复 + `parseNetworth`）；主服务 **1227 → 742 行**，原 687–1163 行整段替换为 6 个委派方法 |
| Duplicated Code（数据风险）：`commitAll` 与 `commitMerge` 的 `statusMatrix → 暂存` 段逐行相同 | `project.stageAll(engine)` 唯一实现（漏删除=记录复活、漏复原=恢复推不上去，两份分叉迟早一处失修） |
| Duplicated Code：`encryptEnvelope`/`encryptSecret` 信封构造 + 新旧钥兜底各写一遍，且"确定性 IV"长注释误挂在 `aesGcmOpen` | `crypto.sealEnvelope/openEnvelope/openWithLegacy/assertAlg`；注释归位到 `sealEnvelope`；两个 `decrypt*` 各瘦成一行 |
| Primitive Obsession：净资产写成中文塞进提交信息再正则反解 | `commitMessage()` 追加结构化 trailer `Suiji-Networth-Cents` / `Suiji-Records`；`parseNetworth` 先认 trailer、再回落旧正则（历史提交仍可读）。`tests/sync-commit-message.test.ts` 8 例锁优先级 |
| 跨端类型三处手抄（`SyncStatus` 两份、`Pick/FieldDiff/ConflictItem` 一份） | 全部收进 `packages/shared/src/index.ts`（`SyncStatus/SyncState/SyncRecordKind/SyncPick/SyncConflictType/SyncConflictItem/SyncFieldDiff` + `lockedSideOf/lockedFields/effectiveFieldPick`）；三端只留 import |
| Repeated Switches：徽标/同步页各自 if 级联判状态 | `apps/web/src/utils/syncState.ts`（`resolveBadgeState/BADGE_COPY/badgeTip/phaseText/phaseDot`）唯一映射表 |
| Data Clumps：`new URLSearchParams(path.split('?')[1] \|\| '')` 散落 11 处 | `local/backend.ts` 的 `queryOf(path)` |
| §5.6 字段锁定缺失：单端改过的字段可被整条 pick 反向覆盖 | `SyncConflictDialog` 用 `effectiveFieldPick`/`lockedFields`：锁定字段置灰恒取动过那端，payload 剔除锁定字段；**服务端 `composeResolved` 同样强制**（界面置灰不是唯一防线） |
| 卸载问答两份（`assemble.py` 的 `uninstall.cmd` 与 NSIS）、`assemble.py` 硬编码 `C:\env\nodejs\node.exe` | 两处是**不同运行时无法合一**，改为把共同策略钉成断言：`tests/packaging-uninstall-policy.test.ts` 8 例（默认保留、清除前先 move 且失败中止、删数据只在清除分支、静默判据是命令行 `/S`）；`assemble.py` 改 `node_exe()`（`SUIJI_NODE` → `shutil.which` → 明确报错退出） |
| 跨端换行：`.gitattributes` 要求 LF，4 个文件被写成 CRLF | `git ls-files --eol` 实测全部回到 `w/lf`（`stats.service.ts` / `ReconcileView.vue` / `mobile/AndroidManifest.xml` / `mobile/build-apk.py`） |

**§6.5 历史膨胀治理（此前零实现）**

- `keep-commits.ts`（纯函数）：`DEFAULT_KEEP_COMMITS=500`、`MIN_KEEP_COMMITS=50`（`gitKeepCommits=1` 会让每推一次就断一次链）、`parseKeepCommits`（空/非数/≤0 回落默认）、`shouldRoll`（**严格大于**才滚）、`nextSnapshotTag`（取 `snapshot-<n>` 的 **max+1** 而非"数个数"，否则删过锚点就撞号 → force 写 ref 静默覆盖旧锚点）、`rollMessage`。
- `GitEngine` 补 `countCommits(branch,cap)` / `headTree()` / `rollToRoot(branch,tree,message,author)` / `listTagNames()` / `tagAnchor(name,oid)`。`parent: []` 是 isomorphic-git 的真 API（`_commit` 里显式空数组不再回填 refOid，index.cjs 实测），不是猜的。
- `sync.service.afterPush()` → `maybeRollHistory()`：只在**刚推成**（远端 == 本地 head）且 `leaseAllowsForce` 允许、无未合并状态时滚动；顺序是"先打 tag 再断链"（反了会有一段旧历史没人指的窗口）；滚完强推并改写租约。失败只写 `lastError`，不升级成离线/暂停（治理失败 ≠ 数据路径失败）。
- `tests/sync-keep-commits.test.ts` 12 例：判据层 + **真仓库层**（3 条提交 → 滚动 → 新根无父、`countCommits` 读到 1、`readFileAt` 内容不变、旧 head 可按锚点找回、工作区不产生脏行）。

### 10.3 范围蔓延与口径登记（不改实现，只记口径）

| 项 | 处置 |
|---|---|
| `gitAuthUser` 全链路新增（DEFAULT_SETTINGS / git-engine / SYNC_KEYS / SyncView 表单 / backend 默认值） | 保留：Gitee 拿 `x-access-token` 会 403（`git-engine.ts` 注释有实测三例）。spec §6.3 只写"按 host 判 oauth2/x-access-token"，实现多给了一个显式覆盖键 → **口径回写进 docs/21 §14** |
| `/system/sync/status` 多返 `lastCommitOid/haltedAt/retries/nextRetryAt/maxAutoRetries` | 保留：徽标"已重试 N 次"与 halted 文案要用（§6.4/§8.2 的界面要求），§8.1 的 8 字段是**最小集**而非封闭集 → 回写 §14 |
| `scripts/dev-git-http.mjs`、`apps/desktop/nsis/customUninstaller.nsh` 非 spec 条目 | 保留：前者是本机联调工具，后者是 M4 卸载问答的落地载体（§9.1 已记） |
| ⑦ Shotgun Surgery：加一个同步字段要同改 schema.prisma / prisma.service DDL 串 + SYNC_COLUMNS / KIND_FIELDS / DIFF_FIELDS / mappers / shared 类型 | **不重构**：把"六处同改"收成一处需要 schema 驱动的投影引擎（DDL 串是运行时建库用的，无法从 prisma 声明反推），收益 ≪ 风险；登记在此，下次加字段时照单核对 |

### 10.4 验收（v0.6.3 实测）

- `npx vitest run`：**21 文件 / 191 例全绿**（新增 `sync-keep-commits` 12、`sync-merge-rules` 22、`sync-ui-state` 14、`sync-commit-message` 8、`backup-secret-filter` 2、`restore-tombstone` 2、`packaging-uninstall-policy` 8）
- `apps/server`：`tsc --noEmit` 退出 0
- `npm run build:web`（vite build）：通过（`SyncView` 20.30 kB / gzip 8.53 kB）
- `git ls-files --eol`：本次改动涉及的 4 个原 CRLF 文件全部 `w/lf`（`windows/installer.py` 仍是 `w/crlf`，但 HEAD blob 自带 CR，非本次引入）
- 未做：`node apps/server/scripts/e2e-sync.mjs` 双实例对敲**本轮未复跑**（需要可写远端；§10.1 的租约/滚动改动动的是推送路径，建议发版前补跑）；定时器仍无长时挂机验收。

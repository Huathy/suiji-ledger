# 设计方案 · M4 数据同步（Git 引擎 + 冲突处理）

| 项 | 内容 |
|---|---|
| 文档版本 | **v1.3**（2026-11-02，实现期回写；正文主体仍是 v1.2 定稿） |
| 取代 | 07 号纪要 §一（Git 同步方案决议）、08 号设计稿 §3 冲突交互 |
| 状态 | **已按 v1.2 实现并验收通过**（见 `.docs/23_实现记录_M4_Git同步_v0.6.md`） |
| v1.3 变更 | ① §5.5 裁决落地第 4 步改为**合并提交（双亲）**——单亲提交会让 push 永不快进、冲突态原地复活 ② §7.2 补三条加密硬事实：记录加密必须**确定性 IV**、`git.key` 缓存须按文件失效、密钥无自动交换通道 ③ 新增 §13「实现期新增的四条事实」，含 `DATA_DIR` 被 `.env` 的 `DATABASE_URL` 顶掉、`diffFields` 需 `same` 档 |
| v1.2 变更 | ① **加密与「可合并」都做成设置项**：`gitEncrypt` 默认 `off`（明文）、`gitMergeEnabled` 默认 `on`；**开启加密前弹窗明示"合并将不可用"**，开启后合并开关强制关并置灰 ② **删掉 v1.1 的 `values`/`full` 两档加密**，回到现网已有的 `on`/`off` 二值——两档与"加密即不可合并"自相矛盾，且要多写一套字段级加解密 ③ 明确"合并要做**两个层次的对照**"：记录级（整条以哪边为准，必做）+ 字段级（逐字段取哪边，仅 PC）；PC 走 IDEA 式**三窗口**，移动端**严格两窗口**（删掉 v1.1 的"祖先折叠窗"） ④ **按 1.44.9 源码 + 实跑修正三处硬事实**：`mergeDriver` 的 `path` 只有 basename、`merge()` 冲突时**仍抛** `MergeConflictError`（`e.data` 带 4 组清单）、`walk({trees:[STAGE()]})` 拿不到 stage 号 → 三方内容改为在驱动回调里捕获 ⑤ 订正 resolve 端点体、强推兜底、单测基线 |
| v1.1 变更 | ① 加密改为设置项、默认明文 ② 合并裁决改为人工对照勾选（PC 三窗口／移动两窗口），自动规则降级为"预选 + 无冲突合并" |
| 前置事实（已实测） | ① 仓库现有配置键位（`gitRemote/gitBranch/gitAuth/gitPushMode/gitEncrypt/gitAutoCommit`）+ 设置页 + 徽标，**无** `isomorphic-git` 依赖、无任何 commit/push/merge 代码 ② `gitEncrypt` 现网取值是 **`on`/`off`**（[SyncView.vue:24,39](../apps/web/src/views/SyncView.vue#L24)），不存在 `values`/`full` ③ `gitAutoCommit` 只写不读（`onMounted` 未回填）→ 现存 bug，M4d 顺手修 ④ `SyncBadge` 的 `ok`/`fail` 不可达：`dotClass` 只映射 `unconfigured/pending`，其余落 `dot-gray`（[SyncBadge.vue:40](../apps/web/src/components/SyncBadge.vue#L40)） ⑤ 单测基线 **26 例**（`npx vitest run` 实测；v1.1 写的"13 例"已过期） ⑥ 离线 APK 的 `localHandle` **没有** `/system/sync/*` 分支，访问抛 404，而 `SyncView.onMounted` 无 try/catch → 白屏 |

---

## 0. 一句话结论

同步粒度是**每次平账后的全量备份 JSON**，这个决议必须改：**全量快照文件无法做三方合并**（每次提交重写整个文件 → 任何跨端差异都表现为同一文件冲突 → 只能"以本地为准 / 以远程为准"，而二者都是丢整段数据）。
本方案把 git 里的载体从「一个全量 JSON」改为「**一条记录一个文件**」，用 isomorphic-git 的 `mergeDriver` 钩子做**记录级语义合并**，于是绝大多数跨端差异自动无冲突收敛；只剩「同一记录被两端同时改」这一类，交**人工对照勾选**（§5.6）。

**「加密」和「可合并」都是设置项，不是硬编码能力**：默认 `gitEncrypt=off`（明文）+ `gitMergeEnabled=on`（可合并），开箱即可用；用户一旦选择加密，合并能力关闭（冲突退化为整份二选一），并且**在开启前明确告知这个代价**。取舍交给用户，默认不替他做（§7.1）。

---

## 1. 依赖与能力核实（不是猜的，实测过）

在 `D:\works\temp\dsh\probe-isogit` 装 `isomorphic-git@1.44.9` 后 `Object.keys(require('isomorphic-git'))` 实测：

| 需要 | 实际存在 | 备注 |
|---|---|---|
| `init add commit log push fetch merge checkout` | ✅ | 全在顶层导出 |
| `abortMerge` `findMergeBase` `currentBranch` `deleteBranch` `writeRef` `resolveRef` `readBlob` `writeBlob` `listFiles` `hashBlob` `status` `statusMatrix` `resetIndex` `tag` `branch` `listBranches` `getRemoteInfo` `getConfig` `setConfig` | ✅ | |
| `getCurrentBranch` / `deleteLocalBranch` / `hashObject` / `writeTree`（部分写法） | ❌ 不存在 | 别按 GitLab 习惯写，用表里的真名 |
| `pull` | ⚠️ 存在但**只支持 fast-forward**（源码 body 里不引用 `merge`，只有 `fastForward`/`fastForwardOnly`） | **不要用它做真合并**；走 `fetch` → `merge` |
| `merge` | ✅ 参数含 `ours theirs fastForward fastForwardOnly dryRun noUpdateBranch abortOnConflict message author committer mergeDriver allowUnrelatedHistories` | 返回 `MergeResult{ oid, alreadyMerged, fastForward, mergeCommit, tree }` |
| `mergeDriver` | ✅ 类型 `({branches:[baseName,ourName,theirName], contents:[baseContent,ourContent,theirContent], path}) => {cleanMerge:boolean, mergedText:string}` | **本方案的支点**：默认驱动是 `mergeFile`→`diff3Merge(ours, base, theirs)`；我们替换成 JSON 语义合并。**驱动只在"两端都改了同一 blob"时被调用**（源码 `mergeTree` 的 `true-true` 分支），单端改动 git 直接取那端、不回调 |
| `mergeDriver.path` | ⚠️ **只有 basename**。源码 `mergeTree` 内 `const path = basename(filepath)`（index.cjs 8528 附近），实测传 `ledger/v1/entries/a.json` 时驱动收到 `a.json` | **硬约束**：判定"哪类记录"只能靠**文件名**，不能靠目录前缀。见 §4.1 命名规则 + §9 R12 |
| `merge()` 冲突时的返回值 | ⚠️ `abortOnConflict:false` **仍然抛** `MergeConflictError`（实测）；`e.data = { filepaths, bothModified, deleteByUs, deleteByTheirs }`，四项都是**仓库内全路径** | 所以不能按 v1.1 写的"交给驱动兜底、别让它先抛"来实现：必须 try/catch，`e.data` 正是冲突清单来源 |
| `walk({trees:[STAGE()]})` | ❌ 每个路径只返回**一条** entry，`StageEntry` **没有** `stage()` 方法（实测 `entry.stage is not a function`），stage 1/2/3 无法从 walk 区分 | 别指望它读三阶段；三方内容在**驱动回调里捕获**（§5.2）。R11 因此改写 |
| 冲突时的 index | ✅ 冲突文件按 stage 1/2/3 写入 index（`index.insert({filepath, oid, stage:1\|2\|3})`）；`abortMerge` 能复位（实测 `statusMatrix` 由 `[path,1,1,3]` 回到 `[path,1,1,1]`） | 可把"index 有未合并 stage"当作**冲突未决的物理标记**，重启后仍能识别（§6.1 preflight / R13） |
| `push` | ✅ 有 `force: false` 参数，**无 force-with-lease** | 需要自己实现"租约"语义（见 §6.3） |
| 冲突错误 | 源码含 `MergeConflictError`、`MergeNotSupportedError`、`UnmergedPathsError`、`CheckoutConflictError`；`_merge` 以 `acquire({allowUnmerged:false})` 拿 index 锁 | ① 按 `e.code` 分支，实现时**用单测锁定 code 字面量**，不硬背文档 ② 仓库残留未合并状态会直接拒绝下次 merge（`UnmergedPathsError`）→ 进冲突态后必须"裁决或 abort"二选一，不能半途而废；反过来这也让"index 有 stage 1/2/3"成为重启后识别未决冲突的可靠依据 |
| 依赖树 | `async-lock clean-git-ref crc-32 diff3 ignore minimisted pako pify readable-stream sha.js simple-get` | 纯 JS，无原生模块 → Electron/pkg 打包友好；但需一并拷进 `apps/desktop/server/deps` |
| Node 接入 | `const git = require('isomorphic-git')` + `const http = require('isomorphic-git/http/node')` + `fs: require('fs')` | SSH 不支持，只走 HTTP(S) → 凭据形态锁定为 **PAT**（07 纪要里的"或 SSH"取消） |

---

## 2. 决策总表（评审要逐条圈的）

| # | 决策 | 选择 | 放弃项与代价 |
|---|---|---|---|
| D1 | git 载体 | **记录级文件树**（一条记录一个 blob） | 放弃「单文件全量 JSON」。代价：仓库文件数 O(记录数)，本地 git 工作区体积变大；换来可行的三方合并 |
| D2 | 真相源 | **SQLite 是唯一真相**，git 只是投影（projection） | 放弃"git 为源 + 检出即恢复"。代价：远端仓库不能独立当数据源直接改（人手改远端 JSON 不保证被吸收）；换来本地写入永不被网络/冲突阻塞 |
| D3 | 删除表达 | **tombstone**（`deleted:true` + 墓碑保留） | 放弃"文件消失=删了"。代价：需轮询清理超期墓碑；换来"我删的 vs 你没同步到"可区分，不会复活 |
| D4 | 并发时钟 | `rev`（每记录单调逻辑序号）+ `deviceId`，`updatedAt` 仅做展示/二级比较 | 放弃纯墙钟 LWW。代价：多存两列；换来时钟漂移/时区/改系统时间不产生错判 |
| D5 | 冲突裁决 | **人工对照勾选为默认**（PC 三窗口／移动两窗口，见 §5.6）；自动规则只做"无重叠差异自动合并 + 勾选预选" | 放弃"自动 LWW 静默定案"。代价：两端同写时用户必须动手；换来数据归属由人拍板，不会静默选错 |
| D5b | 对照层次 | **两个层次**：① 记录级（整条以哪边为准，两端都做）② 字段级（逐字段取哪边，仅 PC）。PC 三窗口、移动端**严格两窗口** | 放弃"移动端字段级"。理由：小屏勾 4 个字段是折磨；要细粒度就上 PC（§5.6.0） |
| D6 | 数值字段合并 | 整条记录二选一，**唯一例外** `Loan.settledAmount` 取语义合并（见 §5.4） | 放弃通用字段级 merge。理由：金额拼接会产生假账 |
| D7 | 加密 | **设置项 `gitEncrypt: off\|on`，默认 `off`（明文不加密）**；只有 `on` 一档 = 整文件密文，**删掉 v1.1 的 `values`／`full` 两档**。**开启前弹窗明示"合并将不可用"**，开启后 `gitMergeEnabled` 强制 `off` 并置灰（§7.1） | 放弃"字段级加密"。理由：字段级与"加密即不可合并"自相矛盾（元数据仍明文，且要多写一套字段级加解密 + 双倍测试）；代价：明文金额进公网仓的风险回到用户自选（UI 红字 + 必须私有仓）；换来"一个开关一个语义"，且默认明文不踩密钥丢失即变砖的坑 |
| D7b | 可合并 | **设置项 `gitMergeEnabled: on\|off`，默认 `on`**；`off` 时不做记录级语义合并，任何双端同改一律退化为**整份二选一**；`gitEncrypt=on` 时强制 `off`（不可反选） | 放弃"合并能力不可关"。理由：有人只想要"异地保险"，不想任何自动改写；同时它是加密的强制联动位 |
| D8 | pull 落地 | `fetch` + `merge` 到本地分支后，**经 `applyRecord` 通道写回 SQLite**；不可解冲突**不落地** | 放弃 `checkout` 覆盖工作区（工作区只是投影，checkout 不改 SQLite） |
| D9 | 强推 | `force` 前做**租约校验**（远端 oid 必须等于 `gitLastRemoteOid`），否则拒绝并转人工 | 放弃"一键强推"的爽。代价：真·多写场景需两步；换来不静默覆盖他人整段历史 |
| D10 | 触发点 | 挂在**已有的 `BackupService.snapshot()`**（现 11 个调用点：平账/大项增删改/调余额/删账户/借还 4 处/恢复，已覆盖全部关键写操作） | 放弃新建埋点/改 11 处调用。零侵入复用 |
| D11 | 离线 APK | **不做**（`VITE_OFFLINE=1` 无服务端，且手机内跑 git 引擎不值）；入口沿用 `v-if="!OFFLINE"` | 放弃手机端直连同步。手机连自家服务端照样受益 |
| D12 | 远程形态 | GitHub / Gitee / 自建 Gitea 的 **HTTPS + PAT**；凭据加密落盘 | 放弃 SSH（引擎不支持） |

---

## 3. 数据模型改造（M4a，一切的前提）

新增统一"可同步行"元数据，5 张表加列（全部可空/带默认，`prisma db push` 安全，不需回填冲突）：

```prisma
model ChangeEntry {
  uid       String  @unique           // uuid v4，跨设备稳定主键（替代裸自增 id 对外）
  rev       Int     @default(1)       // 单调逻辑序号，见 §3.3
  updatedAt Int                       // epoch 秒（本地生成）
  deleted   Boolean @default(false)   // tombstone
  origin    String                    // deviceId：最后一次写入者
}
// Account / RecordType / Loan 同样四列
// MonthlySnapshot 的 @@unique([ym, accountId]) 已是天然稳定键：
//   同步 key = `snap:<ym>:<accountUid>` —— 注意 accountId 必须换成 accountUid，
//   否则两端各自自增出来的 id 会把同一条快照识别成两条（现 restore(merge) 靠 name+kind 映射，正是这个坑）
```

### 3.1 uid 迁移（一次性脚本，幂等）

`apps/server/scripts/m4a-migrate.mjs`：对每表 `UPDATE ... SET uid=<uuid>, rev=1, origin=<deviceId>, updatedAt=<now> WHERE uid IS NULL`；SQLite 无 uuid 函数 → 脚本侧生成。跑前先落一份 `BackupService` 全量 JSON。
自增 `id` **保留**做本地外键（`entries.typeId`/`snapshots.accountId` 关系不动），只是**不再出现在同步载体里**——git 文件内所有引用一律换成 uid，这是跨设备能对齐的唯一办法。

### 3.2 必改行为：`reconcile` 的"全量替换"语义

现状（[months.service.ts:219-225](../apps/server/src/months/months.service.ts#L219-L225)）：
```ts
await this.prisma.changeEntry.deleteMany({ where: { ym, auto: false } })  // ← 物理删，然后 create 一批新 id
```
两个致命问题：① 物理删丢失 uid，下次同步把"我改了列表"误判成"删了全部 + 新增全部"，制造满屏假冲突；② 另一端刚加的大项会被这台设备的这次平账**静默删掉**。
改成**按 uid 做 diff**：

```ts
const kept = new Set<string>()
for (const it of bigItems) {
  if (it.uid) kept.add(it.uid)
  else { it.uid = uuid() }                       // 新增
  await upsertEntry(it)                          // 存在则比内容，变了才 rev++
}
for (const e of await entriesOf(ym, {auto:false})) if (!kept.has(e.uid)) await softDelete(e.uid) // 打墓碑，不再 deleteMany
```
回收站行为保留（`moveToRecycle`），`restore` 改为按 uid 复活并 `rev++`（不能沿用旧 rev，否则另一端墓碑继续胜出）。

### 3.3 rev 推进规则

```
写一条记录时： rev = max(本地该记录 rev, 上次吸收到的远端最大 rev) + 1
吸收远端时：   若远端 rev > 本地 rev → 覆盖本地并采纳远端 rev
```
`gitLastRemoteOid` / `gitMaxRev` 存 `Setting`（不进 git）。

---

## 4. git 仓库与投影布局（M4b）

### 4.1 位置与文件树

仓库根 `DATA_DIR/git/`（与 `backups/`、`uploads/` 平级，随 `./data` 卷整体备份）：

```
DATA_DIR/git/                       ← git init（工作区 + .git 同目录）
  ledger/v1/
    meta.json                       ← { format, version:1, deviceId, projectedAt, counts }
    types/t_<typeUid>.json
    accounts/a_<accUid>.json
    snapshots/s_<ym>_<accUid>.json
    entries/e_<entryUid>.json
    loans/l_<loanUid>.json
    settings/set_<key>.json         ← 仅白名单键（theme/reminderDay/baseCurrency/groupOrder…）
  .gitignore                        ← 不含 *.json；ledger 全量入库
```

**文件名规则（v1.2 新增，硬约束）**：`mergeDriver` 只能拿到 **basename**（§1），所以
1. 文件名必须以 `t_/a_/s_/e_/l_/set_` 前缀编码 kind —— 判定"这是哪类记录"不许靠目录；
2. **全库 basename 必须唯一**（uid 是 uuid v4 天然唯一；`s_<ym>_<accUid>` 也唯一）→ 单测断言"投影后 basename 集合大小 == 文件数"，一旦撞名立刻失败；
3. 目录保留只是为了人眼浏览 + 未来分片，**逻辑上视为扁平命名空间**。

**不入库**：`money.db`、`secret.key`、`git.key`、`backups/`、`uploads/`——它们都在 `DATA_DIR`，仓库根设在 `DATA_DIR/git` 而不是 `DATA_DIR` 正是为此（避免把 SQLite/密钥扫进历史，见 §9 R4）。
**`setting.gitAuth` 不投影**（凭据绝不进 git）。

### 4.2 一条记录的文件内容（canonical form）

```json
{"uid":"e_9f0c…","kind":"entry","ym":"2026-10","typeUid":"t_3","amountCents":"qzB1…","note":null,"accountUid":null,"auto":false,"rev":7,"updatedAt":1730530000,"deleted":false,"origin":"d_5a1c"}
```
**确定性序列化是硬要求**：key 固定顺序（上表顺序）、`JSON.stringify` 无缩进、UTF-8 无 BOM、结尾单个 `\n`。不这样，同一逻辑内容在不同设备产生不同 blob → 每次投影都"全库变更"，diff 与合并同时作废。金额单位统一 `Cents` 整数字符串化（避免两端浮点差异）。
`kind` 字段与文件名前缀**双写**：驱动从 basename 判类，再用 `kind` 交叉校验，不一致直接判 E 类（防止有人手改文件名把记录改错类型）。
`gitEncrypt=on` 时整份内容替换为 `{"enc":{"iv","ct","tag","alg":"AES-256-GCM"},"rev":…,"deleted":…}`（`rev`/`deleted` 留明文只用于排障展示，不参与任何自动裁决——因为此时合并已关闭）。

### 4.3 投影（DB → 工作区）

`projectService.writeAll()`：全表扫描 → 生成 uid 路径集合 → 与 `listFiles` 结果比对：内容相同不动；不同 `fs.writeFileSync`。数据量级（账户数十、条目数千）一次性重写成本可接受，且逻辑最简、无漏投影。

**`writeAll()` 绝不物理删文件**（v1.2 明确）：DB 里记录被删 → 投影写出 `deleted:true` 的墓碑内容，文件仍留在工作区。原因是 `mergeDriver` **只在"两端都有该文件且都改过"时才被调用**（R10），一旦物理删文件，冲突会绕开驱动、我们也拿不到裁决机会。只有墓碑超期清理（`purgedUids`）时才允许 `git.remove`，且必须在无未合并状态时执行。

提交：`git.add` 全部变更 → `git.commit({ message, author:{name:deviceId, email:`${deviceId}@local`}, committer 同 })`。

### 4.4 提交消息模板（07 纪要 §一.2 落地）

```
chore(data): 平账 2026-10 · 净资产 69363.50 · 47 条
```
前缀固定 `chore(data):`，便于历史列表解析；净资产由现有 `MonthsService.networthOf` 算，不重实现。恢复类提交：`chore(data): 恢复 <oid7> · 由 <deviceId>`；冲突人工裁决：`chore(data): resolve-conflict <local|remote>`。

### 4.5 版本历史 / 恢复

- 历史：`git.log({ depth: N })` → `{ oid, message, author, timestamp }`，展示消息 + 时间 + 当时净资产（解析消息，不额外存表）。
- 预览差异：`git.findMergeBase` + 双方 `readBlob` → 走 §5 同一比较器出「新增/修改/删除」三段摘要。
- **恢复 = 不 checkout**：读该 commit 的文件集合（`listFiles({ref: oid})` + `readBlob`）→ 反序列化 → 交 `applyRecord` 通道（含把墓碑复活、rev 顶到新值）→ 立即生成一条恢复 commit。历史不丢，符合 07 纪要 §一.4，且天然可回退（再恢复上一版）。

---

## 5. 冲突处理（M4c，本方案的核心交付）

### 5.1 冲突从哪来

| 类别 | 具体 | 处置（v1.2） |
|---|---|---|
| A 记录不重叠 | 两端各改不同记录 → **不同文件** | git 自动 clean merge，零打扰 |
| A2 单端独有 | 同一 uid 只有一端相对祖先变过（另一端原样） | git 直接取变过的那端（**驱动根本不被调用**），**不进对照界面** |
| B 同记录双改 | 同一 uid 两端都改（同一月同一账户余额被两台设备分别平账） | **进对照界面逐条勾选**（§5.6）。`mergeDriver` 标 `cleanMerge:false` 交人工，不定案 |
| C 改/删并发 | 一端改，另一端删同一记录 | **进对照界面**并加 ⚠（保留删除 = 丢远程编辑，必须让人看见）；预选按 §5.3 的"预选规则 1 墓碑优先" |
| D 路径新增冲突 | 理论不发生：路径含 uid，两端新建必得不同 uid（uuid 唯一性） | — |
| E 加密仓库 | `gitEncrypt=on`：驱动对任何双端同改一律 `cleanMerge:false`（合并已在设置里关掉） | **不进字段级对照**，只出整份二选一（本地/远程），界面注明"加密仓库不支持逐字段合并，如需合并请先关闭加密" |
| E2 结构/解析失败 | JSON 坏、schema 未知 `kind`、`kind` 与文件名前缀不一致 | 进对照界面，但三栏只能显示指纹（哈希前 8 位 + 字节数）→ 实际等于整份二选一 |
| F 历史无关 | 远端仓库非本投影初始化（首次配置指到一个已有仓库/空仓不同根） | `allowUnrelatedHistories` **保持 false**，报错并要求换仓或先拉后推 |
| G 非快进推送 | 远端已前进 | `push({force:false})` 失败 → 回到 fetch+merge 循环（这是常态，不是冲突） |

### 5.2 驱动挂接点（v1.2 按实测重写）

```ts
const captured: ConflictTriple[] = []          // 驱动里捕获的三方原文，冲突界面直接用它
try {
  const m = await git.merge({
    fs, dir: repoDir, gitdir,
    ours: branch, theirs: `remotes/origin/${branch}`,
    fastForward: true,
    abortOnConflict: false,                    // 只为"保留冲突现场"（index 写 stage 1/2/3），不能阻止抛错
    mergeDriver: makeLedgerDriver(captured),   // 语义合并
    message: `chore(data): merge ${short(oursOid)} ${short(theirsOid)}`,
    author, committer,
  })
  await absorbRemote(m.oid)                    // clean：逐文件 applyRecord
} catch (e) {
  if (e.code !== 'MergeConflictError') throw e // ← 实测必然抛这个，别写成 "不会抛"
  // e.data = { filepaths, bothModified, deleteByUs, deleteByTheirs }，四项都是仓库内全路径
  await saveConflictState({ items: captured, errorData: e.data })  // 落 Setting，重启可恢复
}
```

驱动实现要点（每条都是源码/实测结论，不是推测）：

| 要点 | 说明 |
|---|---|
| `path` 只有 basename | 判类靠**文件名前缀**（`e_/a_/s_/l_/t_/set_/meta`），再用记录里的 `kind` 交叉校验（§4.1、§4.2） |
| `meta.json` 特判 | 永远取 `ours` 且 `cleanMerge:true`——它是本端投影指纹，没有合并语义 |
| 单端改动不回调 | git 在 `ours.oid===baseOid` 时直接取 theirs（反之亦然），所以 A2 类**天然不进界面**，驱动里不需要写这段逻辑 |
| 冲突时返回什么 | `cleanMerge:false` + `mergedText = our` 原文：git 会把它写进工作区，返回 our 才不会让远端内容污染本地投影（真相在 SQLite，工作区只是投影） |
| 冲突现场必须落盘 | `captured` 只在内存 → 崩溃/重启即丢，而 index 里的 stage 又读不出（§1 `walk(STAGE)` 行）。所以冲突瞬间把 `{path, base, our, their, fields}` 写进 `Setting.gitConflictState`（本机库，含金额但不出本机） |
| 加密仓库 | `gitEncrypt=on` 时驱动一律返回 `cleanMerge:false`（不尝试解密合并），冲突退化整份二选一（§7.1） |

### 5.3 驱动内的判定顺序（严格按序，第一条命中即返回）

**先判"能不能自动"，再判"该推荐谁"**——v1.1 把这两件事混在一起，导致"人工为默认"和"自动 LWW 定案"互相矛盾。v1.2 拆开：

```
0. 合并已关闭（gitMergeEnabled=off 或 gitEncrypt=on） → cleanMerge:false（整份二选一，§7.1）
1. 任一方解析失败 / kind 与文件名前缀不符 / 密文无法解 → cleanMerge:false（E2 类，界面只显示指纹）
2. canonical(our) === canonical(their)                → cleanMerge:true，取 our（内容一样，无需 commit 分歧）
3. 差异只落在 Loan.settledAmount 且两端都是"变大"      → cleanMerge:true，取 max（§5.4，纯累加无损，不进界面）
4. 其余（B 类双端同改 / C 类改删并发）                 → cleanMerge:false，并附 recommend 供界面预选
```

**预选规则**（只决定界面上默认勾哪边，**不再定案**）：

```
1. 墓碑优先：our.deleted || their.deleted
     → 推荐 deleted=true 的一方；两端都删则按 rev 大者
     → 理由：显式删除被静默复活 = 用户"删了又冒出来"，比反向错误更刺眼
2. rev 大者胜
3. rev 相等 → updatedAt 大者胜（正常不该发生：rev 由 max-seen 推进，相等只可能是同一设备重放）
4. 仍相等 → deviceId 字典序大者胜（确定性兜底）
```

第 4 条的确定性 tie-break 不可省：若用"随机/本地优先"，两台设备算出的预选不同，用户按默认一路点下去会得到两个不同结果，下次同步再次冲突，永远不收敛（CRDT 文献里的 classic bug，写进注释）。
注意：预选**只影响默认勾选**，用户不点 `[应用]` 就永远不落地——所以 tie-break 不影响正确性，只影响"两台机器默认值是否一致"这种体验一致性。

### 5.4 唯一例外：`Loan.settledAmount`

借还"还了 300"是**单调累加**语义，不是"最后写的人说了算"。两端分别记 `+100` / `+50` 时，LWW 会丢掉一次还款。规则：

```
若差异仅落在 settledAmount，且两端都 ≥ base（都是"又还了一点"）
    → settledAmount = max(our, their)，cleanMerge（§5.3 规则 3，不进界面）
若其余字段也有差异（改了本金/对手方/日期）
    → 整条进人工对照；但 settledAmount 那一栏的预选值仍取 max（不让"选了一边"顺带丢掉另一边的还款）
amount（本金）冲突 = 编辑冲突，不是累加 → 走人工，不做数值合并
```
**明确不升级为"增量合并"**：要做对得存 delta 集合（G-Counter），当前模型没有，且借还量级不足以值这笔复杂度。`max` 已消除最痛的丢还款。评审若要更强语义，须先加 `LoanSettleEvent` 表（另立里程碑）。

### 5.5 落地到 SQLite（吸收远端）

merge 成功后遍历 `listFiles({ref: m.oid})`：逐文件反序列化 → 按 `kind` 交 `applyRecord(kind, payload)`（唯一写通道，内含 §3.3 rev 吸收 + 关系按 uid 解析 + 末尾 `recomputeAuto(ym)` 重算当月恒等式）。
自动条目 `auto:true` **不参与同步**：它是派生值（`Σ余额变动 − Σ大项`），各端余额一致时自然一致，把它推上去只会制造必然冲突。投影直接过滤 `auto=true`——**这一条同时消掉一大类 B 类冲突**。

**冲突裁决的落地顺序（v1.2 新增；别在冲突态上直接 commit）**：

```
1. 按用户勾选，逐条把选中的内容交 applyRecord 写 SQLite   ← 此步完全不碰 git
2. git.abortMerge()                                      ← 清掉 index 里的 stage 1/2/3，回到 HEAD 投影
3. projectService.writeAll()                             ← 全量重投影：把"合并后的真相"写回工作区
4. git.add 全部 + commit(message, parent=[HEAD, theirs])  ← **必须是合并提交（双亲）**
5. push({ force:false })；非快进 → 回 §6.1 的 fetch+merge（不是强推）
6. 清 Setting.gitConflictState
```
顺序不能颠倒：① 直接 `git.add`+commit 会撞 `UnmergedPathsError`；② 在冲突态上 `checkout` 会把工作区里"未提交的投影改动"一起丢掉；③ 只有重投影这一步能保证"用户勾选的结果"和"工作区文件"一致。

> **v1.3 修正（实测踩坑，第 4 步）**：`commit` 必须带**第二个亲本 = 冲突快照里的 `theirsOid`**。
> 只提交单亲时，本端历史与远端**没有任何连接**，`push` 永远不是 fast-forward → 远端一直拒 →
> `pushWithRetry` 回拉 → 又撞同一处冲突 → **冲突态原地复活**，远端一次都没更新。
> 表现极具迷惑性：裁决接口返回 `ok:true`，界面上却还在冲突里。
> 另外这一步**不能复用 `commitAll`**：用户全部选"以本地为准"时工作区与 HEAD 内容一致，
> `commitAll` 会因"无变更"返回 `null`，合并提交就丢了。落地为 `ProjectService.commitMerge()`。

### 5.6 冲突裁决：两个层次的对照 + 人工勾选（**默认路径**）

> v1.0 把"人工二选一"当兜底；v1.1 改成"一律进对照界面"；**v1.2 定死对照的层次与窗口数**（所有者要求）：
> **合并要做两个对照** —— ① **记录级**：整条记录以哪边为准（两端都做，必做）② **字段级**：逐字段取哪边（仅 PC）。
> 界面形态：**PC 三窗口**（本地／共同祖先／远程，对齐 IDEA Merge 的肌肉记忆）、**移动端严格两窗口**（本地／远程，不出祖先栏）。
> §5.3 的自动规则只剩"能不能自动"这一层判断（A/A2 类 + 纯累加），凡是进界面的，一律由人勾。

#### 5.6.0 两个对照层次 × 两种端

| 对照层次 | PC（三窗口） | 移动端（两窗口） | 参与字段 |
|---|---|---|---|
| **记录级**（必做） | 左列表 `☑` + 右侧整条 `[◀ 以本地为准] [以远程为准 ▶]` | 两张卡片各一个 `Radio`，整条二选一 | 整条记录 |
| **字段级**（仅 PC） | 每字段左右箭头，可覆盖整条选择 | **不做**（小屏勾 4 个字段是折磨；要细粒度就上 PC） | 金额/余额 · 备注 · 关联账户 · 记录日 |
| 结果预览 | 底部实时拼出最终值 | 卡片底部一行"将采用：本地 · ¥12,480.00" | — |

两层的关系：**字段级优先于记录级**——用户点了"以本地为准"，再把"备注"改成远程，最终值 = 本地其余字段 + 远程备注。所以"结果预览"必须**实时**跟着变，否则用户不知道自己在拼什么。

#### 5.6.1 对照的数据结构

裁决单元是**记录**，不是文本行。每个冲突项后端算好四元组下发：

```ts
type ConflictItem = {
  key: string            // 'ledger/v1/entries/e_9f0c….json' —— 唯一 row-key（仓库内全路径）
  fileName: string       // 'e_9f0c….json' —— 驱动只能给 basename（§1），回查/匹配用
  kind: 'entry'|'account'|'snapshot'|'loan'|'type'|'setting'
  title: string          // 「10 月 · 招商银行」/「工资 +14,000」
  conflictType: 'both'|'edit-delete'|'unparsable'|'encrypted'  // 决定界面警示强度
  base:  RecordStr|null  // 共同祖先 = 驱动回调的 contents[0]；新建冲突为 null → 界面显示 —
  local: RecordStr       // 本地（ours）
  remote: RecordStr      // 远程（theirs）
  fields: Array<{        // 字段级 diff，仅 4 列参与：金额/余额 · 备注 · 关联账户 · 记录日
    name: string; label: string
    base: string|null; local: string; remote: string
    changed: 'both'|'local'|'remote'
  }>
  recommend: 'local'|'remote'   // §5.3 预选规则算出的默认勾选
  reason: string                // 「远程 rev 更大（7 > 6）」「本地为删除」…
}
```

两个实现约束：
1. **冲突项不是"事后重新算 diff"**，而是冲突瞬间从 `mergeDriver` 回调里抓的原文（§5.2），落 `Setting.gitConflictState`。`GET /system/sync/conflicts` 只读这份快照——保证界面看到的就是 git 当时看到的那三份内容，不会因为期间本地又改了数据而错位。
2. `changed:'local'|'remote'`（只有一端动过）的字段 → 标灰并锁定到动过的那端，**不浪费用户注意力**；只有 `both` 才真的需要人判断。这类记录如果整条都只有单端改动，根本不会进界面（git 已自动取那端）。

#### 5.6.2 PC · 三窗口对照（IDEA 风格）

```
┌─ 同步冲突 · 5 条待处理 ──────────────────────────────────────── ⤢ ─┐
│ ① 冲突列表（记录级）        │ ② 三窗口对照（本地 │ 祖先 │ 远程）      │
│ ┌─────────────────────────┐│ ┌────────┬────────┬────────┐          │
│ │☑ 10月·招商银行 余额      ││ │本地    │共同祖先│远程    │          │
│ │  ⚠两端都改 · 荐:远程     ││ │12,480 ◀│12,300  │12,350 ▶│          │
│ │☑ 工资 +14,000           ││ │存款  ◀ │存款    │工资到账▶│          │
│ │  ⚠两端都改 · 荐:本地     ││ │11-01 ◀ │10-31   │11-02  ▶│          │
│ │☐ 借出 张三 已还 300      ││ └────────┴────────┴────────┘          │
│ │  ⚠本地删/远程改          ││  整条：( )以本地为准  (•)以远程为准      │
│ │☐ 设置·提醒日 28→25       ││ ├─ 差异摘要 ────────────────────────┤  │
│ └─────────────────────────┘│  余额 本+180 / 远+50 · 备注两端不同      │
│                             │ ┌─ 结果预览 ───────────────────────┐  │
│ [全选荐项][全部用本地]       │ │ 余额 ¥12,350.00 · 备注 工资到账   │  │
│ [全部用远程]                 │ └──────────────────────────────────┘  │
│                             │        [取消（不同步）] [应用 4 项并推送]│
└─────────────────────────────┴────────────────────────────────────────┘
```

关键交互（都对齐 IDEA 的 Merge dialog 肌肉记忆）：

| IDEA 行为 | 本项目实现 |
|---|---|
| 左栏带 "⚠ 两端都改 / 仅左 / 仅右" 分组 | 列表**只放要人判断的**（`conflictType='both'/'edit-delete'`），`changed:'both'` 排最上并加粗；已自动处理的项折叠在底部"已自动合并 N 项"里可展开核对，不占注意力 |
| 中列固定「来源／基线」 | 中列 = 驱动回调的 `contents[0]`（共同祖先那版），**不重新 `findMergeBase` 现算**；无祖先（新建冲突）显示 `—` |
| 每行两侧 `>>` / `<<` 取整块 | 每**字段**左右各一个箭头 `[◀ 以本地为准] [以远程为准 ▶]`（字段少，字段粒度比行块更贴用）；金额字段显示格式化值，不是 `1248000` |
| 顶部三个大按钮「Accept Left/Right」 | 底部 `[全部用本地] [全部用远程]`；再配 `[全选荐项]` 一键按 §5.3 预选。**整条归属用 radio（记录级）**，与字段箭头（字段级）并存且字段级优先 |
| 结果区实时预览 | "结果预览"随勾选变化——**必须实时**，否则用户不知道自己在拼什么 |
| 关闭 = 放弃合并 | `[取消（不同步）]` → `abortMerge` 复位 + 清 `gitConflictState`，本地数据一字不动 |
| 逐行可展开字符级高亮 | 展开态对 `note` 做词级高亮（金额/日期差异红绿底）；余额/金额字段不做词级（数字拆开无意义） |

技术形态：**后端出结构化 diff，前端纯渲染表格**，不在浏览器里跑 diff 库，也不用 monaco/codemirror（多 ~1MB 且要写 JSON 语法着色）。字段固定的结构化对照比通用文本 diff 更快更准，也天然适配金额格式化。
布局：新增 `components/SyncConflictDialog.vue`，用 `useUiStore().isDesktop`（阈值 `window.innerWidth >= 1024`，[stores/ui.ts:18](../apps/web/src/stores/ui.ts#L18)）分叉；PC 侧全屏 overlay，**不用** vant 的 `Popup`（宽度撑不住三栏）。

#### 5.6.3 移动端 · 两窗口对照（**严格两窗，不出祖先栏**）

手机端**只做两窗口**：左本地、右远程，一条一屏、整条二选一。
**删掉 v1.1 的"查看共同祖先"折叠窗**——祖先值只以一行文字出现在"变化"里，不构成第三个对照窗口。

```
┌─ ‹ 同步冲突  4/5 ──────────────────────┐
│ 10 月 · 招商银行            余额        │
│ ⚠ 两端都改 · 建议取远程                 │
│ ┌── 本地（本机）───┐ ┌── 远程 ────────┐ │
│ │ ○ 余额 12,480.00 │ │ ● 余额 12,350.00│ │
│ │   备注 存款       │ │   备注 工资到账  │ │
│ │   记录日 11-01    │ │   记录日 11-02   │ │
│ └──────────────────┘ └─────────────────┘ │
│ 变化：余额 12,300→12,480(本) / →12,350(远)│
│ 理由：远程 rev 更大（7 > 6）              │
│                    [ 应用 ]              │
├──────────────────────────────────────────┤
│  ← 上一条                  下一条 →      │
└──────────────────────────────────────────┘
```

移动端规则：
1. **一条一屏**，`Radio` 选整条归属，**不做字段级**；卡片底部注明"逐字段合并请在电脑端操作"。
2. 顺序：只翻真冲突（`both` / `edit-delete`），已自动合并的项不进翻页队列。
3. **祖先值只出现在"变化"行的文字里**（`12,300→12,480`），不给它单独一栏或单独一屏——两窗口就是两窗口。
4. 底部进度 `4/5` + `[应用]`；中途退出 = 全部放弃 → `abortMerge` + 清快照。
5. 组件用 vant `RadioGroup` + `Cell`，零新增依赖。
6. 加密仓库（`gitEncrypt=on`）：卡片只显示"整份密文（指纹 8 位 / N 字节）"，radio 仍二选一，顶部注明"已开启加密，无法逐字段合并"。

#### 5.6.4 应用勾选结果（两端同一后端通道）

```
POST /system/sync/resolve
{
  items: [
    { key: 'ledger/v1/entries/e_9f0c….json',
      pick: 'remote',                    // 记录级（必填）
      fieldPicks: { note: 'local' } }    // 字段级（仅 PC 传；缺省 = 跟随 pick）
  ],
  push: true                             // false = 只落地本地，不推送
}
```
后端：按 `items` 取对应内容（`pick` 定基线，`fieldPicks` 覆盖）→ 合成最终记录 → `applyRecord` 写 SQLite → 按 §5.5 的六步顺序（abortMerge / 重投影 / commit / push）→ 清 `gitConflictState`。

- 提交消息：`chore(data): resolve-conflict 4 local / 1 remote`（计数从 `items` 现算）。
- 未被勾选（用户跳过）的冲突项：**保持冲突态**（不 abort、不猜），下次 `GET /conflicts` 原样再问。
- `fieldPicks` 只在 PC 传；移动端传了也忽略（避免两端语义分叉）。
- `pick` 指向墓碑（`deleted:true`）时，落地动作 = 该记录**软删**（保留墓碑），不是物理删（D3）。

#### 5.6.5 批量兜底（保留 v1.0 的整份二选一）

对照界面底部始终留 `[全部用本地]` / `[全部用远程]`，等价原来的粗粒度二选一：

| 选项 | 动作 |
|---|---|
| 全部用本地 | 所有冲突项 `pick:'local'` → 按 §5.5 六步走 → `push({force:false})`；**非快进就回 fetch+merge，不静默强推**（D9） |
| 全部用远程 | 所有冲突项 `pick:'remote'` → `applyRecord` 覆盖本地 → 本地被覆盖的记录**进回收站**（不静默删） |

> v1.1 这里写"必要时 `force:true`"，与 D9 的租约式强推自相矛盾，v1.2 删除：强推只能由 §6.3 的租约校验触发，且必须用户在提示里二次确认。


---

## 6. 同步流程与调度（M4c/M4d）

### 6.1 单轮 sync（串行化，`async-lock` key=`sync:run`）

```
preflight  gitRemote 为空 → state=unconfigured，直接返回
           已存在 gitConflictState → state=conflict，直接返回（先裁决；此时 index 还有 stage 1/2/3，再 merge 会撞 UnmergedPathsError）
           gitMergeEnabled=off 或 gitEncrypt=on → 记 mode=whole-file（冲突只走整份二选一）
snapshot   BackupService.snapshot('同步前')          ← 永远先落本地保险
project    writeAll()  → commit（无变更则跳过，记 pendingCommits）
fetch      失败 → state=offline，保留 commit，退避重试（见 6.4）
merge      ours=branch theirs=remotes/origin/<b>  fastForward:true  abortOnConflict:false  mergeDriver
           try 成功          → applyRecord 吸收 → continue
           catch MergeConflictError → state=conflict
                                      把驱动捕获的三方内容 + e.data 落 Setting.gitConflictState
                                      停止（不 push）
push       force:false；成功 → gitLastRemoteOid = 新 oid
           非快进（PushRejectedError: not-fast-forward）→ 回到 fetch（最多 2 轮）
```
全程 `state` 存内存 + `Setting.gitSyncState`（重启可恢复展示），失败原因截 500 字。

### 6.2 三种推送时机（`gitPushMode`）

- `every-commit`：`snapshot()` 后 debounce 5s 触发 sync（合并连续操作）。
- `daily`（默认）：`setInterval` 每分钟检查，本地 03:00 且非离线时触发；启动时补跑一次"今天该跑而未跑"（进程可能不在）。
- `manual`：仅 `POST /system/sync/run`。
现项目无 cron 依赖，**不加 `@nestjs/schedule`**，用 `node:timer` + 单测覆盖纯函数 `shouldRunNow(mode, now, lastRunAt)`。

### 6.3 租约式强推（D9 落地）

```
await fetch(...)                                   // 更新 remotes/origin/<b>
const remoteOid = await resolveRef(`refs/remotes/origin/${branch}`)
if (remoteOid !== settings.gitLastRemoteOid) 拒绝强推 → state=conflict + 提示"远端被第三方推进，请先拉取或逐条裁决"
else push({ force:true })                          // 与上次所见一致 = 覆盖的是"我们本要看清的那一版"
```
这就是 `--force-with-lease` 的等价物，isomorphic-git 不内置，必须手写。

### 6.4 离线与退避

`fetch` 失败 → `offline`，指数退避 1m/5m/15m/30m 封顶 30m；恢复网络后自动补一轮并在徽标提示"已重试 N 次"。commit 不受网络影响，历史不丢。

### 6.5 历史膨胀治理

- 每投影前清 `git gc` 不可用（无原生 git）→ 改为：`.gitignore` 控文件数、`meta.counts` 便于人眼校验、**分支滚动**：超过 `gitKeepCommits`(默认 500) 时，`writeRef` 把 branch 软重置到最新 oid 并打 tag `snapshot-<n>` 保留锚点，旧历史靠 `backups/` 30 份轮转兜底。
- 记录级布局下文件数 ≈ 记录数（千级），单次提交 diff 只有真改动，体积可控。

---

## 7. 设置项：加密与可合并（M4d）

### 7.1 两个开关，默认"明文 + 可合并"

| 键 | 取值 | 默认 | 语义 |
|---|---|---|---|
| `gitEncrypt` | `off` \| `on` | **`off`** | `on` = **整文件** AES-256-GCM 密文（只保留一档，`values`/`full` 已删，见 D7） |
| `gitMergeEnabled` | `on` \| `off` | **`on`** | `off` = 不做记录级语义合并，任何双端同改 → **整份二选一** |

**联动规则（后端 `putSettings` 强制，不能只靠前端）**：

```
if (gitEncrypt === 'on')  gitMergeEnabled = 'off'      // 加密开启 → 合并强制关，不允许 on
if (gitEncrypt === 'off') gitMergeEnabled 保持用户原值  // 关加密不自动打开合并，尊重上次选择
```

**开启加密前的确认弹窗（必须，文案定稿）**：

> **开启加密后，冲突合并将不可用。**
> 两端同时修改同一条记录时，只能整份二选一（以本地为准 / 以远程为准），**无法逐字段对照合并**。
> 已推送的明文历史不会追溯加密，如需彻底加密需重建远端仓库。
> 仍要开启？

**设置页交互**（`SyncView.vue` 现有"自动规则"卡片，在"备份加密"下面加一行）：

| 控件 | 状态 |
|---|---|
| 🔒 备份加密（AES-256） | `off` 默认。开 → 弹上面的确认框 → 确认后写 `gitEncrypt=on` + 强制 `gitMergeEnabled=off` |
| 🔀 冲突合并（逐条 / 逐字段对照） | `on` 默认。`gitEncrypt=on` 时 `disabled` + 副文案"加密已开启，合并不可用"；`off` 时副文案"双端同改一律整份二选一；无重叠的改动仍自动合并" |

两个键都是**本机设置，不投影进 git**（`settings/` 白名单不含它们）。后端 `DEFAULT_SETTINGS`（[system.service.ts:7](../apps/server/src/system/system.service.ts#L7)）补一行 `gitMergeEnabled: 'on'`（`gitEncrypt: 'off'` 已存在），离线库 `local/backend.ts` 的 `DEFAULT_SETTINGS` 同步补。跨端不一致的处理：

| 情况 | 处理 |
|---|---|
| 本机 `off`、远端是密文 | fetch 后解析失败 → 进 conflict 态，提示"远端仓库已加密，请在本机开启加密并填入同一密钥" |
| 本机 `on`、远端是明文 | 允许拉取（明文可读），但下次 push 会把文件改写成密文 → 提示"将把明文历史覆盖为密文，建议先备份远端" |
| 两端密钥不同 | 解密失败 → conflict 态，文案"密钥不匹配（远端由 <deviceId> 加密）" |

### 7.2 凭据与密钥

| 项 | 做法 |
|---|---|
| `gitAuth`（PAT） | **不再明文**。新增 `Setting.gitAuthEnc`，用 `DATA_DIR/git.key`（32B，`main.ts` 现有 `secret.key` 同款持久化路径与权限）AES-256-GCM 加密；读取时解密，API 返回一律脱敏（只回 `已配置 · ****1a2f`）。旧明文键迁移时清空 |
| 密钥丢失 | `git.key` 不进 git（`.gitignore`），但在 `backup()` 的 JSON 里带一个 `keyHint`；文档说明：密钥丢 = 历史密文不可解，等同丢失远端 |
| `gitEncrypt: on` | 整个 blob → `{"enc":{"iv","ct","tag","alg":"AES-256-GCM"},"rev":n,"deleted":false}`。**合并能力已由设置关闭**，驱动一律 `cleanMerge:false`，冲突退化为整份二选一（§5.6.3 第 6 条） || `gitEncrypt: off`（默认） | 全明文，三方语义合并全功能可用；仅建议私有仓 + 自建 Gitea |
| 远程建议 | 保持 08 号文案：必须私有仓；`every-commit` + 明文 + 公开仓 = 金额上公网（UI 加红字警告） |

> **v1.3 修正（实测踩坑，加密档的地基）**：
> 1. **记录加密必须用确定性 IV**（`iv = SHA-256(明文)[0:12]`）。随机 IV 下同一份明文每次加密都出不同密文，
>    于是"两端内容完全一致"在 git 眼里也是"双端都改"→ 加密档**每个文件都进冲突**（e2e 实测 26 个文件全冲突，
>    裁决都裁不完）。这是收敛加密，代价是"密文相同 ⇒ 明文相同"这层等价关系会泄露，对账本记录可接受。
>    凭据（PAT）仍走随机 IV，不适用这条。
> 2. **`git.key` 不能只在进程内缓存一次**：用户把另一台设备的密钥拷过来时必须立即生效，
>    否则表现为"换了密钥还是解不开/还是用旧的"。落地为按文件 `mtimeMs + size` 失效。
> 3. **密钥跨端共享没有自动交换通道**：两端各生成一把 = 互相解不开（§7.2 已列为冲突态文案）。
>    首次开启加密前应把同一把 `git.key` 放到两端；换密钥 = 全库重加密，会产生一次大规模变更提交。

---

## 8. 接口 / UI / 状态机

### 8.1 新增端点（`SystemController` 同级新 `SyncController`，`@UseGuards(AuthGuard)`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/system/sync/status` | `{state, pendingCommits, lastSyncAt, lastError, conflictCount, pushMode, mergeEnabled, encrypt}` |
| POST | `/system/sync/run` | 手动一轮全量 sync；`?phase=push\|pull` 可单步 |
| GET | `/system/sync/conflicts` | 读 `Setting.gitConflictState` → `{items: ConflictItem[], mode:'merge'\|'whole-file', errorData}`（§5.6.1，**不现算 diff**） |
| POST | `/system/sync/resolve` | `{items:[{key, pick:'local'\|'remote', fieldPicks?}], push?:boolean}`（§5.6.4） |
| GET | `/system/sync/history?limit=50&cursor=` | git log → `{oid, message, ts, networthCents}` |
| GET | `/system/sync/diff?oid=` | 与当前工作区的三段差异摘要 |
| POST | `/system/sync/restore` | `{oid, mode:'preview'\|'apply'}` |
| DELETE | `/system/sync/conflict` | 显式放弃：`abortMerge` + 清 `gitConflictState` → 回干净态 |

> v1.1 的 `{strategy, picks:{path:'our'|'their'}}` 已废弃：它与 §5.6.4 的 `items[]` 是两套语义，前端只能写错一个。**以 §5.6.4 为准**。

### 8.2 状态机（把不可达的红态真正接上）

```
unconfigured → idle → syncing → idle(✓)
                          ↘ offline(黄,自动重试)
                          ↘ conflict(红,二选一/逐条) → resolve → syncing
                          ↘ error(红) → idle
idle →(project 有 pending)→ pending(N)(黄) → syncing
```
`SyncBadge.vue` 的 `state` 从"只读 `gitRemote`"改为读 `/system/sync/status`，且**必须重写 `dotClass` 映射**：现在只映射 `unconfigured/pending`，`ok`/`fail` 都会落到 `dot-gray`（[SyncBadge.vue:40](../apps/web/src/components/SyncBadge.vue#L40)），所以即便引擎交付，红/绿两态**照样显示不出来**。同时删掉"不做假已同步"的注释（引擎交付后 `ok/green` 才是真实态）。
`SyncView.vue`：① `notReady()` 删除；② 状态卡加"上次同步时间 + 待推提交数"；③ 版本历史接 `/history`；④ 冲突弹层接 `/conflicts` + `/resolve`（PC 三窗口 / 移动两窗口按 `isDesktop` 分叉）；⑤ **新增"冲突合并"开关 + 加密确认框**（§7.1）；⑥ 顺手修 `gitAutoCommit` 只写不读的 bug（`onMounted` 里补 `autoCommit.value = s.settings.gitAutoCommit !== 'off'`）。
本地 `apps/web/src/local/backend.ts`：`localHandle` **目前没有任何 `/system/sync/*` 分支**，会走末尾的 `throw new HttpError(404, …)`；而 `SyncView.onMounted` 没有 try/catch → APK 端进 `/sync` 直接白屏。要求：① 补 `/system/sync/status` 桩返回 `state:'unconfigured'`（离线无 git 引擎）；② `SyncView`/`SyncBadge` 的 `onMounted` 加 catch 兜底，网络/404 一律降级为"未配置"，不再白屏。

### 8.3 文档增补

08 号设计稿 §3 的"冲突处理二选一"改写为"**自动合并 + 两层次对照（PC 三窗口 / 移动两窗口）+ 整份二选一兜底**"；07 号纪要 §一.5 的"加密"改写为"**加密是设置项（默认 off；开启即关合并）**"；09/18 号实现记录的 M4 待办勾销。

---

## 9. 风险与对策（评审重点）

| # | 风险 | 严重 | 对策 |
|---|---|---|---|
| R1 | §3.2 改 `reconcile` 语义触及核心平账路径，可能回归 | **高** | 先补 `tests/` 用例（现 **26 例**基线之外）：双端同月平账 / 他端新增被本次替换列表覆盖 / 删除后重平账；`reconcile` 新旧行为用 `Setting` 开关灰度 |
| R2 | canonical 序列化不统一 → 每次提交全库变更 | 高 | 序列化器唯一出口 + 单测：同内容不同插入顺序必须同 hash（`git.hashBlob` 断言） |
| R3 | `isomorphic-git` 错误 code 字面量与文档不符 | 中 | 实现时 `e.code` 实测后锁进单测；冲突路径统一走 `abortMerge` 复位，禁止残留未合并 index（否则下次 merge 被 `UnmergedPathsError` 拒） |
| R4 | `./data` 卷整体挂载/拷贝 → `.git` 含历史全量、`git.key` 同目录 | 中 | 密钥留在 `DATA_DIR/git.key` 而仓库根设在 `DATA_DIR/git/`，避免密钥与历史同层；文档写明：备份整卷 = 备份所有历史密文与密钥 |
| R5 | 桌面端依赖不在 `server/deps` → 打包后 `require('isomorphic-git')` 崩 | 中 | 15 号记录既有流程补一步：`build` 脚本把 `isomorphic-git` + 上表 10 个子依赖拷进 `apps/desktop/server/deps/`，并加"启动自检 require" 断言 |
| R6 | Dockerfile `npm install --omit=dev` 只拷 `apps/server/package.json` → 依赖漏装 | 低 | 依赖加在 `apps/server`（不是根），并本地 `docker build` 跑通一次 `/system/sync/status` |
| R7 | 多设备真多写（家庭场景）语义未定义 | 中 | 维持 07 纪要：v1 单写多读。本方案把"必丢数据"降到"极少冲突"，但**不承诺**并发编辑无损；给谨慎用户的开关是 **`gitMergeEnabled=off`**（v1.1 写的 `gitConflictPolicy` 从来不存在，v1.2 更正） |
| R8 | 恢复旧版与 tombstone 交互（恢复一个已删记录 = 复活） | 中 | `applyRecord` 复活时 `rev = maxRev+1`（§3.3），保证复活事件对端可见 |
| R10 | **`mergeDriver` 只在"双端都有该文件且都改过"时被调用**（`mergeTree` 的 `true-true` 分支才 `mergeBlobs`，且要求 `ours && theirs` 同为 blob；单侧删除走 `// deleted by us` 分支，**根本不调驱动**） | 中（已规避） | 这正是 **D3 tombstone 的硬理由**：删除必须写成 `deleted:true` 留在文件里，绝不能在投影时物理删文件——一旦物理删，冲突绕开驱动、我们也拿不到裁决机会。§4.3 投影里写明"删除=改内容，不删文件"。超期墓碑清理只能在**无未合并状态**时做，且清理动作本身也要留 `deleted:true` 于 `meta.json` 的 `purgedUids` 里，避免对端把"文件消失"理解成待合并 |
| R11 | 对照界面的"三方内容"从哪来 | 低（**v1.2 已改正**） | v1.1 说"用 `walk({trees:[STAGE()]})` 读 stage 1/2/3"——**实测不成立**：`StageEntry` 没有 `stage()`，每个路径只返回一条 entry。改为：① 冲突瞬间在 `mergeDriver` 回调里捕获 `contents[0/1/2]`（base/our/their 原文）② `MergeConflictError.data` 的全路径清单做交叉校验 ③ 两者落 `Setting.gitConflictState`，界面只读这份快照，不再碰 index |
| R12 | **`mergeDriver.path` 只有 basename**（`mergeTree` 内 `const path = basename(filepath)`），靠目录前缀判类必然判错 | **高（已规避）** | 文件名前缀编码 kind（`e_/a_/s_/l_/t_/set_/meta`）+ 记录内 `kind` 交叉校验；单测断言"全库 basename 唯一"（§4.1）。这是本方案唯一不能出错的命名约定 |
| R13 | 冲突态跨重启丢失 → 用户看不到冲突，同步永久卡住 | 中 | 冲突瞬间落 `Setting.gitConflictState`；`preflight` 见到它就置 `state=conflict` 并**拒绝再 merge**（否则撞 `UnmergedPathsError`）；只有 resolve / `DELETE /conflict` 才清 |
| R14 | 加密与合并两个开关跨端不一致（一端开一端关） | 中 | 后端强制联动（加密 `on` ⇒ 合并 `off`）；跨端不一致按 §7.1 的三行表格给明确文案，**不静默降级** |

---

## 10. 交付顺序与工作量

| 阶段 | 内容 | 验收 | 人日 |
|---|---|---|---|
| **M4a** | uid/rev/updatedAt/deleted 列 + 迁移脚本 + `reconcile` 改 uid-diff + `applyRecord` 通道 + 单测 | `npm test` 全绿；双端模拟数据可对齐；旧库升级不丢数据 | 3 |
| **M4b** | 投影器 + canonical 序列化 + `init/add/commit/log` + 本地历史/恢复（无网络）+ `.gitignore` | 平账 3 次 → `git.log` 3 条、消息含净资产；恢复到第 1 版再回第 3 版数据一致 | 4 |
| **M4c** | `fetch/merge/push` + `mergeDriver` 全规则 + 冲突快照落盘 + **两层次对照界面（PC 三窗口 / 移动两窗口）** + 租约强推 + 状态机 + sync 路由 | 两个独立 DATA_DIR 实例对敲：A 平 10 月、B 平 11 月 → 双向零冲突收敛；同一快照双改 → 两端都进对照界面、默认预选一致、各自勾选后两端数据收敛一致；PC 三栏能显示祖先值、移动端只有两栏 | 5 |
| **M4d** | 凭据加密 + `gitEncrypt`(off/on) 与 `gitMergeEnabled` 联动 + 开启加密的确认框 + daily 定时/离线退避 + 打包（deps/Docker/pkg）+ 文档 08/09/18 增补 | 断网 30min 重连自动补齐；Electron 安装包内 sync 可用；开加密后合并开关自动置灰且冲突只出整份二选一 | 3 |
| 合计 | | | **15** |

> v1.2 删掉 `values` 档省下约 0.5 人日，但新增"设置联动 + 确认框 + 冲突快照落盘"约 0.5 人日，合计不变。
> 07 纪要估的是 **+4 人日**，那是"提交一个全量 JSON + push 失败弹二选一"的量。本方案为了冲突真能合并，多付 M4a（3d）+ 驱动与裁决（2d）。**这笔钱必须付**，否则交付的是"冲突即丢数据"的假同步。

### 10.1 可选降级 MVP（若想 M4 只做 6 人日）

`M4a(3) + M4b(3，去掉恢复 UI，只留手动上传备份文件)`：只做 **单向 push 备份**，pull/merge/冲突一律不做，"恢复"= 下载 JSON 走现有手动 `restore(merge)`。冲突态显示"远端已前进，本端提交保留在本地待推"。UI 文案相应降级（不声称双向同步）。
> 这条路的价值：99% 的个人单设备场景只需要"异地保险"，不需要多写合并。**我推荐先交付 MVP，再按真实需求决定要不要 M4c**——家庭多写目前是 P2，没人真正用过。

---

## 11. 明确不做

- 双向 LWW 之外的完整 CRDT（向量时钟/因果序）
- SSH 远程（引擎不支持）、`git worktree`/子模块、多分支策略（只有 `gitBranch` 单分支）
- 同步 `money.db` 二进制、同步 `backups/`、同步凭据/密钥
- 手机端（`VITE_OFFLINE`）本地 git 引擎
- 冲突自动合并 `note` 文本拼接（会产生假备注）
- **字段级／值级加密（v1.1 的 `values` 档）**：与"加密即不可合并"直接冲突，且要多写一套字段级加解密 + 双倍测试，v1.2 删除
- **移动端字段级合并**：两窗口只做整条二选一，逐字段请上 PC
- **加密仓库的自动合并**：`gitEncrypt=on` 时驱动一律 `cleanMerge:false`，不做"解密后再合并"

---

## 12. 本次核对结论（v1.2 逐条对账）

核对方式：读代码 + `grep` 计数 + 在 `probe-isogit` 里实跑 `isomorphic-git@1.44.9`（脚本：`probe-merge.js` / `probe-stage.js`）。

| # | 原方案的说法 | 核对结果 | 处理 |
|---|---|---|---|
| 1 | 11 个 `BackupService.snapshot()` 调用点 | ✅ 实测 11 个（借还 4 / 账户 2 / 月度 4 / 恢复 1） | 保留 D10 |
| 2 | `reconcile` 在 `months.service.ts:219-225` 做全量替换 | ✅ 行号与代码一致（`deleteMany` + `create` 循环） | 保留 §3.2 |
| 3 | 现 13 例单测 | ❌ 实测 **26 例**（`npx vitest run`） | 已改 R1 |
| 4 | `gitEncrypt: values` / `full` 两档 | ❌ 现网代码与 UI 只有 `on`/`off` | 已删两档（D7、§7） |
| 5 | `gitAutoCommit` 可用 | ❌ 只写不读（`onMounted` 没回填） | 记入前置事实 + §8.2 顺手修 |
| 6 | `SyncBadge` 红/绿不可达 | ✅ 成立，且更精确：`dotClass` 只映射 `unconfigured/pending`，`ok`/`fail` 落 `dot-gray` | §8.2 要求重写映射 |
| 7 | `mergeDriver` 的 `path` 含 `ledger/v1/` 前缀 | ❌ **只有 basename**（`const path = basename(filepath)`） | 改名规则 + R12（**影响最大的一条**） |
| 8 | `abortOnConflict:false` 后由驱动兜底、不抛 | ❌ **仍抛** `MergeConflictError`，`e.data` 带 4 组全路径清单 | §5.2 重写 |
| 9 | 用 `walk({trees:[STAGE()]})` 读 stage 1/2/3 | ❌ `StageEntry` 无 `stage()`，每路径只 1 条 entry | 改为驱动回调捕获 + 落盘（R11） |
| 10 | `pull` 只能 fast-forward | ✅ 成立（无 `mergeDriver` 参数） | 保留 fetch+merge |
| 11 | 仓库无 `isomorphic-git` 依赖 | ✅ `package.json` 三个都无 | 保留 M4b 装依赖 |
| 12 | `gitConflictPolicy` 开关 | ❌ 该键从不存在 | 改为 `gitMergeEnabled`（R7） |
| 13 | 离线 APK 的 `/system/sync/*` 走桩 | ❌ `localHandle` 无该分支 → 404 → `SyncView` 白屏 | §8.2 要求补桩 + try/catch |

**留给所有者确认的三处口径**（我按最合理的方式先写了，改起来成本很低）：

1. **"两个对照"我理解为两个层次**：记录级（整条归属）+ 字段级（逐字段）。若原意只是"本地 / 远程两侧各一个对照面"，那字段级整层可以砍掉，M4c 约省 1 人日——PC 就只剩"三窗口 + 整条二选一"。
2. **移动端严格两窗**：连 v1.1 的"祖先折叠"也删了（祖先值降级为一行文字）。若要保留折叠，把 §5.6.3 第 3 条改回去即可（+0.2d）。
3. **加密只留一档**：`on` = 整文件密文。若确实需要"只加密金额、保留 uid 明文"，那"加密即不可合并"这条规则要重新商量（因为字段级加密其实还能做三方合并）。

---

## 13. 实现期新增的四条事实（v1.3，写代码时才暴露，验收已覆盖）

| # | 事实 | 影响 | 落地 |
|---|---|---|---|
| 14 | `import '@prisma/client'` 在**模块求值阶段**就会读 `apps/server/.env` 并注入 `DATABASE_URL=file:../data/money.db`（相对 schema 目录） | 原来写的 `process.env.DATABASE_URL ||= databaseFileUrl()` 形同虚设 → **`DATA_DIR` 对数据库完全无效**，多实例会静默共用一个库。表现为"两端改同一条记录却毫无冲突"，验收全假通过 | `main.ts` 改成**强制覆盖**（保留 `SUIJI_DATABASE_URL` 显式指定）；e2e 增加"同步后本端库 mtime 必须变化、对端不许变化"的哨兵 |
| 15 | 裁决后的提交必须是**合并提交**（双亲） | 单亲提交 → push 永不快进 → 冲突态原地复活（见 §5.5 v1.3 修正） | `ProjectService.commitMerge()` |
| 16 | 记录加密的 IV 必须**由明文确定性派生** | 随机 IV → 同一内容两端密文不同 → 加密档处处冲突（见 §7.2 v1.3 修正） | `encryptEnvelope(plain, {deterministic:true})`，仅记录用；凭据仍随机 IV |
| 17 | `diffFields` 需要第三档 `changed:'same'` | 原来"三边都相同"会落进 `else` 被标成"远端改过"，对照表满屏假高亮 | 判定顺序改为 `l===r → same` 优先 |

**验收状态（v1.3）**：`npx vitest run` 7 文件 / 59 例全绿；`apps/server` `tsc --noEmit` 干净；
`vite build`（在线）与 `VITE_OFFLINE=1 vite build`（离线 APK）均通过；
`node apps/server/scripts/e2e-sync.mjs` 双实例对敲全通过：首推 / 首拉认领 / 同记录双改冲突（字段级对照 + `same` 标注）/
裁决→合并提交→推送→双向收敛 / 加密档整份二选一 / 密钥不匹配拒绝落地。

---

## 14. 双轴复审后的口径修订（v1.4，2026-11-04）

Standards/Spec 两路独立复审后，以下几处**以实现为准修订方案**（修复明细见 `.docs/23` §9）：

| 节 | 原方案 | v1.4 口径 |
|---|---|---|
| §6.1 | 串行化用 `async-lock key='sync:run'` | 实装为进程内 `running` 标志 + `gate()/pump()` 串行队列（run 同步抢门，history/diff/restore/resolve/abort 排队）。单进程桌面/容器场景等价；不再引入 async-lock |
| §4.1 | 设置白名单 `theme/reminderDay/baseCurrency/groupOrder…` | 实含 `timeSortDir`（v0.3.8 的跨端排序方向偏好，属于"跨设备应一致"的同类，补进白名单口径） |
| §4.2 | 金额 `Cents` **字符串化** | 实为整数 JSON number + `Math.round`：确定性成立（两端同源同 round），字符串化不再补（改它=全库 blob 重写） |
| §7.1 | 三行跨端不一致表（无实现口径） | 密文信封确定性档带非机密 `enc.hint`=密钥指纹 12 hex，`decodeRecord` 据此出三条定稿文案；"本机 on、远端明文"场景因明文侧本就可读，不另设文案，下次 push 自然改写成密文 |
| §6.3 | 强推触发面描述为"用户在同步页看过提示后的二次确认" | 已实装：`SyncView` error/conflict 态出「强制推送…」按钮 → 确认弹窗 → `POST /run?force=lease`；被租约拒绝置 `conflict`（不是 error，避免退避期反复重试必然失败的强推） |
| §4.5 | 差异预览 `findMergeBase` + 同一比较器 | 已接：`/diff` 返回 `baseOid`；`SyncView` 恢复前展示带回/覆盖/不受影响三段摘要。记录级口径（文件名集合），未做到字段级对照（字段级仍只属冲突界面） |
| §6.1 project | 每轮 sync 投影一次提交 | 干净合并吸收后**不再**补"merge 吸收"提交（白造历史）；rev 顶高的微差由下一轮投影提交收编 |
| §9 R1 | "reconcile 新旧行为用 Setting 开关灰度" | 已补：`planBigItems` 纯函数含 `legacy` 分支，`Setting.reconcileLegacy='on'` 回退；三条回归用例落 `tests/reconcile-bigitems.test.ts` |
| §9 R5 | 桌面依赖"启动自检 require 断言" | 已补：`main.js` require 服务端前 `require.resolve('isomorphic-git')`；旧 windows 链 `assemble.py` 装配前跑 `copy-desktop-deps.mjs --to`，失败中止出包 |

**仍欠（不粉饰）**：R10 `purgedUids` 墓碑清理未实现（缺保留期口径，见 §14.1）；定时器只有纯函数单测、无长时挂机验收。
（§6.5 `gitKeepCommits` 分支滚动曾在 v1.4 列为未实现，v0.6.3 已落地并补了租约/序号两条判定，见 §14.1。）

### 14.1 第二轮双轴复审后的口径修订（v1.5，2026-11-04）

实施明细见 `.docs/23` §10。与 v1.4 同规矩：**以实现为准修订方案**，不为了对齐文档去改已经正确的实现。

| 节 | 原方案 | v1.5 口径 |
|---|---|---|
| §6.5 | "超过 `gitKeepCommits`(500) 时 `writeRef` 把 branch 软重置到最新 oid 并打 tag `snapshot-<n>`" | 已实现，并补两条原文没写的判定：①**严格大于**才滚（`count=500` 不滚，滚动要写 tag+重建根+强推，别在阈值抖）；②只有"刚推成、远端 == 本地 head、`leaseAllowsForce` 允许、无未合并状态"时才滚（断链只能靠强推送达远端，租约不满足时强推等于覆盖别人的提交）。序号取现有 `snapshot-<n>` 的 **max+1**（"数个数"会在删过锚点后撞号，force 写 ref 静默覆盖旧锚点）。最小值夹到 50（`=1` 会让每推一次都断一次链） |
| §9 R10 | 墓碑超期清理 + `meta.json.purgedUids` | **仍未实现，且不是实现漏项**：它缺的是"墓碑保留期"这一设计决策（多久算超期、超期后对端如何区分"你删了记录"与"你清了墓碑"）。当前口径写明：墓碑文件只增不减，兜底只有 `DATA_DIR/backups/` 30 份轮转；先定保留期再写代码，不许拍脑袋清 |
| §5.3 | "deviceId 字典序大者胜" | 补成三级 tie-break：origin 字典序 → 内容指纹 → 确定性兜底。旧实现 `String(a) >= String(b)` 在 origin 双空/相等时恒取 local（非对称） |
| §5.4/§5.6 | 冲突列表只列"记录级文件"（隐含） | 明写：**非载体文件（`.gitignore`、临时文件等）永不进冲突**（驱动返回 cleanMerge 而非 unparsable），且裁决提交里出现未知 key 必须 400 而不是静默跳过 |
| §6.3 | 租约基准 = "上次同步所见的版本"（未指明哪一侧） | 钉死：只在**真推成**的那次写"远端此刻 oid"，只拉不推时写观测到的 theirs；写本地 head 会让闸门假阳性或永久不可用 |
| §4.3 投影 | "删除 = 写墓碑，绝不物理删" 只约束投影 | 同样约束**恢复备份**：`restore('replace')` 改五表墓碑化（曾漏 `loan`，且真做 `deleteMany` 会让对端把"删光+新增"读成新数据 → 已清数据复活） |
| §8.1 | `/status` 8 字段（按最小集读） | 明写"最小集，非封闭集"：实现多返 `lastCommitOid/haltedAt/retries/nextRetryAt/maxAutoRetries`，因为 §6.4「已重试 N 次」与 halted 文案要用；`gitAuthUser` 同理——§6.3 只写"按 host 判"，Gitee 实测 `x-access-token` 403，故补一个显式覆盖键 |
| §5.6.6（新增） | — | **字段锁定必须在服务端也生效**：`changed:'local'|'remote'` 的字段只取动过那端，`composeResolved` 强清洗；界面置灰只是提示（旧版缺省回落整条 pick，单端改动的字段可被反向覆盖） |
| §4.4 提交信息 | "提交信息带净资产便于人眼"（无结构约定） | 追加机器可读 trailer `Suiji-Networth-Cents` / `Suiji-Records`；解析先认 trailer、再回落旧中文正则（历史提交仍可读）。文本即接口这件事，终于有测试锁（`tests/sync-commit-message.test.ts`）|
| §6.5 附注 | — | 读历史/加字段的连带成本（schema.prisma + DDL 串 + SYNC_COLUMNS + KIND_FIELDS + DIFF_FIELDS + mappers）**不重构**：收成一处需要 schema 驱动的投影引擎，DDL 串是运行时建库用的、无法从 prisma 声明反推，收益 ≪ 风险。加字段时照 `.docs/23` §10.3 清单核对即可 |

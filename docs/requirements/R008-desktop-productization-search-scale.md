# R008：Desktop 产品化收尾与搜索规模化

- **版本**：0.1
- **状态**：实现中（Stage 0–3 已完成，Stage 4 实现中——中断点见 §11 头部记录）
- **更新时间**：2026-08-21
- **前置需求**：R007（Desktop Local Vault 产品化基础闭环）
- **基线 Commit**：`065a0174657e5ea9c4c6510970b5809ed66a87c0`
- **建议目标分支**：`feat/r008-desktop-productization-search-scale`
- **建议仓库路径**：`docs/requirements/R008-desktop-productization-search-scale.md`

---

# 1. 背景

R006 已经验证 Electron Desktop + Local Markdown Vault 的双 Runtime 技术路线可行；R007 阶段 0–4 进一步把 Desktop 从 PoC 推进到了基本可日用状态。

当前 Desktop 已真实具备：

- 本地 Vault 选择、初始化、最近知识库；
- Markdown 扫描、读取、创建、安全保存；
- Tiptap ↔ Markdown 持久化编解码；
- Stable Note ID / Identity Adoption；
- Frontmatter `title` / `tags` 安全写入；
- 乐观锁与 `DocumentVersionChannel`；
- 本地附件与相对资源路径；
- 收藏 / 最近打开设备级持久化；
- chokidar 文件监听；
- 外部新增 / 修改 / 删除 / 移动 reconciliation；
- 当前文档 clean reload / dirty conflict；
- 新建真实目录；
- 文档移动；
- 回收站删除 / 恢复 / 永久删除；
- `RuntimeCapabilities` 与 `RuntimeOperations` 双层能力门控；
- Desktop golden E2E 已覆盖打开、保存、附件、metadata、watcher、回收站等关键路径。

因此下一阶段的核心问题已经从：

> Desktop 能否正确读写一个本地 Markdown Vault？

转变为：

> Desktop 是否已经足够安全、一致、可搜索、可扩展，能够承担大规模本地知识库的日常主力使用？

本需求把两类工作合并到一个连续版本中：

1. **R007 的剩余产品化收口项**：修复现有 Operation Support 语义不准确、Runtime 依赖边界、Native Secret Store、Reveal in File Manager 等遗留问题。
2. **R008 的正式能力建设**：建立 Desktop 全文搜索、可重建派生索引、增量索引、性能基线和规模化验收。

本需求完成后，R007 不再继续追加阶段；Desktop 后续能力以新的独立需求编号演进。

---

# 2. 当前状态

## 2.1 当前 RuntimeCapabilities

当前 Desktop 能力约为：

```ts
{
  localDirectory: true,
  fileWatching: true,
  revealInFileManager: false,
  nativeMenu: false,
  nativeSecrets: false,
  persistentAssetPaths: true,
  documentPersistence: true,
}
```

其中：

- `localDirectory`：真实；
- `fileWatching`：真实；
- `persistentAssetPaths`：真实；
- `documentPersistence`：真实；
- `revealInFileManager`：未实现；
- `nativeSecrets`：未实现；
- `nativeMenu`：本需求不实现。

## 2.2 当前 RuntimeOperations

当前 Desktop 操作矩阵约为：

```ts
{
  workspace: {
    rename: false,
    favorite: true,
  },
  page: {
    createDocument: true,
    createGroup: true,
    renameTitle: true,
    renameFile: false,
    move: true,
    trash: true,
    restore: true,
    purge: true,
    favorite: true,
  },
  tag: {
    write: true,
  },
  revision: {
    read: false,
    write: false,
  },
}
```

这个矩阵目前存在一个语义问题：

```text
page.renameTitle = true
page.move = true
```

实际上只完整适用于 document：

```text
Document rename title    ✅
Group rename directory   ❌

Document move            ✅
Group move directory     ❌
```

因此当前某些 Group UI 操作仍可能出现：

```text
入口可见
→ 用户操作
→ Repository
→ NOT_IMPLEMENTED
```

这违反 R007 的 G4 原则：

> 已显示给 Desktop 用户的主操作，要么真实可用，要么明确隐藏 / 禁用。

## 2.3 当前 Desktop Search

Desktop 当前使用：

```text
DesktopTitleSearchIndex
```

其目标是避免在没有完整正文索引时伪装成“全文搜索”。

现状：

- 标题搜索可用；
- 正文搜索不完整；
- Watcher 已具备增量事件基础；
- Markdown 是唯一正文真相；
- 当前尚无持久化 Desktop 全文索引数据库；
- 当前尚无索引版本、重建、损坏恢复和性能基线。

---

# 3. 产品目标

本需求包含五个正式目标。

## G1：产品操作能力必须与真实实现一致

Desktop 中所有页面树操作必须满足：

```text
Visible / Enabled
=> 真实支持
```

禁止：

```text
Visible
→ click / drag
→ NOT_IMPLEMENTED
```

必须明确区分：

- document rename；
- group rename；
- document move；
- group move；
- title rename；
- physical file rename。

## G2：Desktop Secret 必须安全持久化

AI API Key：

- 不进入 Markdown；
- 不进入 Vault；
- 不进入 localStorage；
- 不进入日志；
- 不进入测试 artifact；
- 系统安全存储可用时安全持久化；
- 系统安全存储不可安全使用时只允许 session-only；
- UI 必须能表达当前 secret persistence mode。

## G3：Desktop 可以安全定位本地文件

用户可以：

- 在文件管理器中显示当前 Markdown；
- 在文件管理器中显示本地附件。

安全约束：

- Renderer 永远不传 absolutePath；
- Main 必须重新通过 Vault 授权边界解析路径；
- malformed / 越界路径必须拒绝；
- Reveal 不得绕过 `PathGuard`。

## G4：Desktop 支持真实全文搜索

搜索至少支持：

- title；
- tags；
- Markdown body text。

搜索结果至少返回：

- note/page identity；
- title；
- match source；
- snippet；
- ranking score 或稳定排序依据。

## G5：全文索引可以增量维护且永远可重建

索引不是正文真相。

必须满足：

```text
删除 Desktop 搜索数据库
→ 重新扫描 Markdown Vault
→ 完整恢复搜索能力
```

Watcher 驱动：

```text
created
modified
moved
deleted
```

必须正确映射到索引：

```text
insert
update
relocate
delete
```

任何索引错误都不能损坏 Markdown。

---

# 4. 非目标

本需求明确不做：

- Cloud Sync；
- 多设备同步；
- Git 集成；
- 插件系统；
- 实时多人协作；
- 多窗口完整同步；
- Native Menu 完整体系；
- 系统托盘；
- 自动更新；
- 正式安装器；
- 代码签名；
- Desktop 完整 Revision History；
- Notion database；
- `.e1/tree.json` 自定义目录排序；
- 自动批量重写所有第三方 Markdown 相对链接；
- SQLite 作为 Markdown 正文真相；
- 搜索数据库成为主存储；
- 向 Renderer 暴露本机绝对路径；
- Group rename / Group move 的完整文件系统实现；
- Physical file rename UI；
- backlinks / knowledge graph；
- 向量数据库 / semantic search；
- RAG / embedding；
- 云端搜索服务。

其中 Group rename / move、Revision、backlinks、installer / updater 必须独立进入后续需求，而不是继续扩大 R008。

---

# 5. 新增架构不变量

在既有 DUAL / DSK 不变量基础上新增：

## R8-01：Operation Support 必须描述业务对象，而不是模糊 Page

错误：

```ts
page.move = true
```

如果 document 和 group 的实现不同。

正确方向：

```ts
page.document.move
page.group.move
```

或提供：

```ts
operations.canMove(page)
operations.canRename(page)
```

UI 不得自己判断平台名称。

## R8-02：Secret capability 与 Secret runtime status 分离

Capability：

```text
这个 Runtime 是否实现了 native secret integration
```

Status：

```text
这台机器当前是否真的有安全 secret backend
```

不能用单一静态 boolean 表达两者。

## R8-03：搜索数据库只是 Derived Data

```text
Markdown
= source of truth

Search DB
= rebuildable derived state
```

禁止：

```text
Search DB 中的数据
→ 反向覆盖 Markdown
```

## R8-04：索引 API 不泄露具体数据库实现

Application 层只依赖 `SearchIndexPort` 或新增 Desktop-neutral port。

禁止 `application/`、`domain/`、`components/` 直接 import：

```text
node:sqlite
better-sqlite3
SQL statements
```

## R8-05：Watcher 只发布事实，Index Service 自行决定索引动作

```text
Watcher
→ ExternalVaultChangeService
→ normalized change event
→ Search Index Reconciler
```

禁止：

```text
VaultWatcher
→ 直接执行 SQL
```

## R8-06：任何索引失败不得阻断正文保存

```text
Markdown commit success
→ index update failure
```

最终语义必须是：

```text
文档保存成功
搜索索引进入 degraded / dirty
后续自动修复或重建
```

## R8-07：Reveal 路径只能在 Main 内解析

Renderer 仅允许：

```ts
{ vaultId, relativePath }
```

或：

```ts
{ vaultId, assetId }
```

Main：

```text
VaultRegistry
→ authorization
→ PathGuard
→ absolute path
→ shell.showItemInFolder
```

---

# 6. 阶段拆分

本需求建议分为 7 个阶段：

```text
Stage 0  R007 遗留一致性收口
Stage 1  Native Secret Store
Stage 2  Reveal in File Manager
Stage 3  Search Contract + Benchmark
Stage 4  Desktop Search Database + Full Text
Stage 5  Watcher Incremental Index
Stage 6  Rebuild / Recovery / Scale Acceptance
```

不要一次性提交。

---

# 7. Stage 0：R007 遗留一致性收口

## 7.1 目标

在开始新的搜索基础设施前，清理当前已经明确存在的产品能力与工程依赖不一致。

## 7.2 RuntimeOperations 精确化

推荐把 `page` 操作细分到 document / group：

```ts
interface RuntimeOperations {
  workspace: {
    rename: boolean;
    favorite: boolean;
  };

  page: {
    document: {
      create: boolean;
      renameTitle: boolean;
      renameFile: boolean;
      move: boolean;
      trash: boolean;
      favorite: boolean;
    };

    group: {
      create: boolean;
      rename: boolean;
      move: boolean;
      trash: boolean;
    };

    trash: {
      restore: boolean;
      purge: boolean;
    };
  };

  tag: {
    write: boolean;
  };

  revision: {
    read: boolean;
    write: boolean;
  };
}
```

Desktop：

```ts
page.document.renameTitle = true
page.document.move = true

page.group.rename = false
page.group.move = false
```

Web 可保持完整 true。

如果认为接口改动过大，可先增加：

```ts
interface PageOperationPolicy {
  canRename(page: Page): boolean;
  canMove(page: Page): boolean;
}
```

但长期更推荐静态 operation matrix + 对象类型细分。

## 7.3 PageTreeSidebar 行为

必须达到：

```text
Document
├─ rename title ✅
├─ drag move    ✅
└─ trash        ✅

Group
├─ rename       ❌ hidden
├─ drag move    ❌ disabled
└─ trash        ✅
```

要求：

- F2 在 unsupported Group 上不触发 rename；
- Group 不设置 `draggable=true`；
- drag visual hint 不应出现在 unsupported source 上；
- 新建 Group 后不得自动进入一个必然失败的 rename flow；
- unsupported operation 不显示错误条，因为用户根本不能发起。

## 7.4 chokidar Runtime Dependency 修正

当前 Electron Main bundle：

```js
external: ["electron", "chokidar"]
```

因此 `chokidar` 是 runtime dependency。

要求：

- 将 `chokidar` 从 `devDependencies` 移到 `dependencies`；
- 新增构建级测试，保证 Electron Main 的第三方 `external` 包均存在于 production dependencies；
- CI 中增加 production-runtime sanity：

```bash
npm ci
npm run build:desktop
npm prune --omit=dev
# 验证 Electron main 可解析全部 external runtime dependency
```

可不实际启动完整 GUI，但必须能完成 Main module resolution。

## 7.5 文档状态修正

R007 文档中的 Current State 必须同步真实状态：

- `fileWatching: true`；
- group create 已实现；
- document move 已实现；
- trash / restore / purge 已实现；
- workspace/page favorite 已实现；
- page lastOpened 已持久；
- R007 阶段 0–4 已完成；
- 明确 Stage 5 已迁移到 R008 Stage 1–2；
- R007 状态更新为 `待验收` 或 `已完成`。

## 7.6 Stage 0 DoD

- document/group operation UI 与真实支持一致；
- Group 不再触发已知 `NOT_IMPLEMENTED`；
- chokidar production dependency 正确；
- production-pruned runtime dependency test 通过；
- Web operation behavior 无回归；
- Desktop E2E 全绿；
- R007 文档关闭，不再添加 Stage 6+。

## 7.7 Stage 0 实现记录

**状态：已完成（2026-08-21）**

实际实现：

- `RuntimeOperations` 按 §7.2 推荐方案细分（`src/runtime/RuntimeOperations.ts`）：
  `page.document{create,renameTitle,renameFile,move,trash,favorite}` /
  `page.group{create,rename,move,trash}` / `page.trash{restore,purge}`，
  原扁平字段无兼容层直接迁移；装配为 `webOperations`（全 true）、
  `desktopOperations`（document 除 renameFile=false 外全 true，
  group.create/trash=true、group.rename/move=false，trash.restore/purge=true，
  workspace/tag/revision 维持现值）与内存容器缺省全 true。
- `PageTreeSidebar`（§7.3）：行内重命名按钮、`draggable`、F2 快捷键均按
  行对象类型（document/group）分别门控；新建分组后仅当
  `page.group.rename=true` 才自动进入行内改名（Desktop 下不再进入必然
  失败的 rename flow）；unsupported 操作入口直接不存在，不产生错误条。
- chokidar 从 devDependencies 迁入 dependencies（package.json + lockfile
  同步，readdirp 一并去 dev 标记）；新增构建级门禁测试
  `scripts/build-electron.test.mjs`（解析 build-electron.mjs 全部 external，
  断言除 electron 外均在 dependencies 且 node_modules 可解析）；
  CI 新增独立 `desktop-runtime-deps` job：`npm ci` → `build:desktop` →
  `npm prune --omit=dev` → 逐个 external `await import` 验证可解析
  （prune 动 node_modules，故与 build-desktop 分离）。
- 文档状态修正（§7.5）：R007 标记已完成（阶段 0–4 + 阶段 5 迁移去向
  写明）、§2.2 补真实状态指针；`docs/requirements/README.md` 与
  `AGENTS.md` 同步。

偏差记录：

- §22 建议的 `docs(R008): 关闭 R007 并冻结 Search contract` 独立提交
  未单独拆出——R007 关闭随「操作矩阵收口」提交、Stage 0 实现记录随
  「external dependencies」提交合入（本批按 3 提交执行：需求文档 /
  操作矩阵收口 / runtime dependencies）。
- 测试用例按批次规则只写不跑，统一测试执行在全部阶段完成后进行；
  DoD 中「Web 无回归 / Desktop E2E 全绿」以该统一执行结果为准。

---

# 8. Stage 1：Native Secret Store

## 8.1 目标

把当前 Desktop `InMemorySecretStore` 替换为真实安全存储。

## 8.2 数据流

```text
AIConfigService
→ SecretStore
→ DesktopSecretStore
→ E1DesktopAPI.secret
→ preload
→ IPC
→ Main SecretPersistence
→ Electron safeStorage
→ userData/secrets.json
```

Application 层不改变 secret 使用方式。

## 8.3 IPC

新增：

```ts
secret.get({ name })
secret.set({ name, value })
secret.remove({ name })
secret.getStatus()
```

Renderer 不得知道：

- storage path；
- encryption raw buffer；
- OS keychain identifier；
- machine absolute path。

## 8.4 Main Secret Persistence

建议：

```text
electron/main/secrets/
├─ DesktopSecretStore.ts
├─ SecretFilePersistence.ts
├─ SecretBackendStatus.ts
└─ *.test.ts
```

持久文件：

```text
userData/secrets.json
```

建议格式：

```json
{
  "version": 1,
  "entries": {
    "ai.apiKey": {
      "ciphertext": "<base64>",
      "updatedAt": 1787300000000
    }
  }
}
```

不得保存明文 API Key。

## 8.5 safeStorage 使用原则

优先异步接口：

```ts
safeStorage.encryptStringAsync()
safeStorage.decryptStringAsync()
```

如果当前 Electron API 可用。

需要检查：

```ts
safeStorage.isEncryptionAvailable()
```

Linux 还必须检查 encryption backend。

如果平台只能使用不安全 backend，例如 `basic_text`，则：

```text
mode = "session-only"
```

禁止自动把 API Key 明文或弱保护落盘。

## 8.6 SecretStorageStatus

新增平台无关状态：

```ts
export interface SecretStorageStatus {
  mode:
    | "secure-persistent"
    | "session-only"
    | "unavailable";

  backend?: string;
  reason?: string;
}
```

区分：

```text
RuntimeCapabilities.nativeSecrets
= Desktop 接入了 native secret system

SecretStorageStatus.mode
= 当前机器实际运行状态
```

Desktop capability 可以表示 `nativeSecrets: true`，但实际持久性由 status 决定。

## 8.7 Renderer 行为

安全可用：

```text
API Key 会安全保存在本机系统凭据存储中
```

Session-only：

```text
当前系统安全存储不可用，API Key 仅在本次会话有效
```

禁止 fallback 到 localStorage。

## 8.8 Stage 1 验收

- macOS / Windows 安全 backend 下 API Key 重启保持；
- Linux 安全 backend 下可持久；
- insecure backend 下不持久明文 secret；
- `secrets.json` 中看不到原始 API Key；
- corrupted secrets file 可自愈或安全降级；
- unknown schema version 不覆盖原文件；
- secret 不进入日志；
- secret 不进入 Playwright screenshot / artifact；
- `AIConfigService` 无需知道 Electron。

## 8.9 Stage 1 实现记录

**状态：已完成（2026-08-21）**

实际实现：

- Main（`electron/main/secrets/`）：
  - `SecretBackendStatus.ts`：`SafeStorageLike` 结构视图 +
    `resolveSecretBackendStatus` 三档判定——safeStorage 缺失或加解密
    API 全缺 → `unavailable`；`isEncryptionAvailable()` false 或 backend
    命中已知不安全值（`basic_text`）→ `session-only`；其余 →
    `secure-persistent`。`getSelectedStorageBackend()` 调用 try/catch
    容忍非 Linux 平台；`forceBackend` 为测试/E2E 注入点
    （env `E1_SECRET_BACKEND_FORCE`，G11 模拟 basic_text）。
  - `SecretFilePersistence.ts`：`userData/secrets.json`
    （`{version:1, entries:{<name>:{ciphertext:<base64>, updatedAt}}}`），
    容错与 DesktopVaultStateStore 同口径——缺失空表、JSON 损坏/未知
    version 备份 `.corrupt-<ts>` 后空表自愈（原文件字节保留在备份中，
    不被静默覆盖丢弃）、逐条丢弃畸形条目、mkdir -p + tmp + rename
    原子写，落盘后 best-effort `chmod 0o600`。
  - `DesktopSecretStore.ts`：三档模式编排——secure-persistent 经
    safeStorage 加密落盘（**优先 `encryptStringAsync`/`decryptStringAsync`，
    缺失退回同步版**；解密失败按记录损坏返回 null，与 SecretStore port
    语义一致）；session-only 仅进程内存 Map 兜底、绝不读写持久文件；
    unavailable 下 `set` 抛 `SECRET_STORAGE_UNAVAILABLE`、`get` 返回
    null、`remove` 安全 no-op。status 进程内缓存一次。
- IPC（§8.3）：`secret.get`/`secret.set`/`secret.remove`/`secret.getStatus`
  四通道 + `SecretStorageStatus` 契约类型（`shared/ipc/contracts.ts`）；
  schema 校验（`shared/ipc/schemas.ts`）：name 白名单
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`、value 上限 8 KiB
  （`SECRET_VALUE_MAX_LENGTH`），错误消息不回显 secret 值（§15.1/§15.2）；
  `IpcErrorCode` 新增 `SECRET_STORAGE_UNAVAILABLE`（不新增 DomainError
  code，反向映射得 null，R007 §11 同原则）；handler
  `electron/main/ipc/secret.ts`（与 vault 授权边界无关，secret 属设备级
  状态）+ preload `secret` 组桥方法。
- Renderer：`src/application/services/SecretStorageStatus.ts` 平台无关
  状态类型（与 shared 线格式同形独立声明）+ `SecretStore` port 新增可选
  `getStatus()`；`src/platform/desktop/DesktopSecretStore.ts` 走桥实现
  port（复用 SecretStore 契约套件）；`createDesktopRuntime` 以之替换
  `InMemorySecretStore`；`desktopCapabilities.nativeSecrets` 翻 true
  （R8-02：capability=接入 native secret 体系，运行态持久性由
  `SecretStorageStatus` 表达）；`capabilities.matrix.test` 与
  `docs/architecture/runtime-boundaries.md` 同步。
- UI（§8.7）：`SettingsPanel` 按 `secretStore.getStatus()` 分流说明
  文案——secure-persistent「API Key 会安全保存在本机系统凭据存储中」/
  session-only「当前系统安全存储不可用，API Key 仅在本次会话有效」
  （role=alert）/ unavailable「当前环境无法在本机保存 API Key」；
  无状态提供方（Web/内存）回退既有 IndexedDB 文案；无 localStorage
  fallback。`AIConfigService` 不变（无需知道 Electron）。
- 测试（按批次规则只写不跑）：Main 单测
  （`SecretBackendStatus`/`SecretFilePersistence`/`DesktopSecretStore`
  三套件：状态判定、加密往返、同步 API 回退、跨实例保持、session-only
  不落盘与不读既有文件、损坏自愈、unknown version 备份、删 secret、
  不存在 secret、错误不带 secret 值）+ `ipc/secret.test.ts`（handler
  往返 + schema 拦截链）+ Renderer 契约/桥映射
  （`DesktopSecretStore.test.ts`）+ preload 形状/透传 +
  `desktop.smoke.spec.ts` 桥形状补 secret 组 + SettingsPanel 四种文案
  组件测试 + E2E `e2e/desktop.secrets.spec.ts` G10/G11（@golden）。

偏差记录：

- G11 的真实 basic_text 环境在本机/CI 无法轻易制造，按任务约定以
  Main 注入点 `E1_SECRET_BACKEND_FORCE=basic_text` 模拟，E2E 保留
  G10/G11 双用例；G10 在运行到无安全 backend 的环境（如 CI Linux）
  时按 `getStatus().mode` 条件跳过（此时持久性不成立的降级语义已由
  G11 覆盖）。
- E2E 走桥（`window.e1.secret`）直接验证保存/重启保持语义，设置 UI
  的保存链路由组件测试覆盖。
- 测试用例只写不跑（批次规则），统一测试执行在全部阶段完成后进行；
  §8.8 各验收点以该统一执行结果为准。
- `SecretStorageStatus` 在 shared（线格式）与 application（平台无关
  类型）两处同形独立声明，保持 application 不依赖 shared；由
  DesktopSecretStore 透传时结构兼容。

---

# 9. Stage 2：Reveal in File Manager

## 9.1 目标

Desktop 用户可以定位：

- 当前 Markdown 文件；
- 本地附件文件。

## 9.2 IPC

推荐：

```ts
note.reveal({
  vaultId,
  relativePath
})
```

附件：

```ts
asset.reveal({
  vaultId,
  assetId
})
```

## 9.3 Main 安全链路

```text
Renderer vaultId + relativePath
→ IPC schema validation
→ VaultRegistry
→ authorized root
→ PathGuard
→ ensure target belongs to Vault
→ shell.showItemInFolder(absolutePath)
```

禁止：

```ts
shell.showItemInFolder(rendererProvidedAbsolutePath)
```

## 9.4 UI

文档：

```text
EditorShell
└─ 更多
   └─ 在文件管理器中显示
```

附件：

```text
Attachment context menu
└─ 在文件管理器中显示
```

只在 `capabilities.revealInFileManager === true` 时显示。

## 9.5 Stage 2 验收

- note reveal 成功；
- asset reveal 成功；
- malformed relative path 拒绝；
- `../` 逃逸拒绝；
- symlink escape 拒绝；
- transient Vault 行为明确；
- Renderer 无 absolutePath；
- capability 翻为 true；
- Web UI 不出现该入口。

## 9.6 Stage 2 实现记录

**状态：已完成（2026-08-21）**

实际实现：

- IPC（§9.2/§15.1）：`note.reveal` / `asset.reveal` 两通道共用同一入参
  `RevealInput{vaultId, relativePath}`（`shared/ipc/contracts.ts`）——
  附件按 relativePath 寻址而非 §9.2 推荐的 assetId：Renderer 侧附件身份
  本就是 assetId/relativePath 双持（DesktopAssetRegistry 会话索引），
  反查 relativePath 后与 note 走完全同一安全链路，Main 无需第二张
  assetId 解析表（R8-07 允许 {vaultId, relativePath} 形态）。成功返回
  null；schema 校验复用 assertRelativePath（`parseRevealInput`）。
- Main（§9.3）：`electron/main/ipc/reveal.ts`——resolveVaultRoot
  （registry/transients 双通道授权边界）→ PathGuard.resolveWithinVault
  （realpath 根内判定，目标必须存在）→ `shell.showItemInFolder`；
  `ShellLike` 结构视图可注入 mock，shell 缺失归一 INTERNAL。
  `index.ts` 注入真实 electron shell；preload 补 note/asset 两组桥方法。
- transient 行为（§9.5）：允许 reveal——reveal 是只读操作，不修改 Vault
  任何文件，仅预览会话的文件真实存在于磁盘，定位不越权；schema 与
  PathGuard 校验与常规 Vault 一视同仁。
- 目录 reveal：允许（showItemInFolder 选中该目录），取最小语义不单独
  限制；目标不存在统一归一 NOTE_NOT_FOUND（不新增 REVEAL_* 码，
  R007 §11 原则：UI 无需新分流）。
- Renderer：平台无关可选 port `RevealService`
  （`src/application/services/RevealService.ts`，revealDocument/revealAsset
  → boolean）挂 `AppServices.revealService`；Desktop 实现
  `DesktopRevealService`——pageId 经 DesktopDocumentSourceCache、assetId
  经 DesktopAssetRegistry 反查 {vaultId, relativePath} 后走桥；反查缺失
  或 IPC 失败归一 false，全链路不出现 absolutePath。
  `createDesktopRuntime` 装配；`desktopCapabilities.revealInFileManager`
  翻 true（capabilities.matrix.test 与 runtime-boundaries.md 同步）。
- UI（§9.4）：EditorShell 顶栏新增「在文件管理器中显示」图标按钮
  （照版本历史入口模式，capability + port 存在双门控，只读/兼容文档
  同样可用）；附件块新增「定位」动作按钮（RevealService 由
  DocumentEditor 按能力门控注入 editor.storage.revealService，未注入的
  运行时入口不存在）。失败提示只说「无法定位」级别文案，不泄露路径；
  Web 端 capability false 天然无入口。
- 测试（按批次规则只写不跑）：Main 单测
  （`electron/main/ipc/reveal.test.ts`：正常 note/asset/目录 reveal +
  realpath 路径断言、NOTE_NOT_FOUND、schema 拦截链、symlink 逃逸、
  未知 vaultId、transient 允许、shell 缺失 INTERNAL）+ Renderer 服务
  契约（`DesktopRevealService.test.ts`）+ 组件门控
  （`revealEntry.test.tsx`：入口可见/点击调用/失败提示/capability false
  或无 port 不出现）+ 附件节点视图三例（attachment.test.ts）+ preload
  形状/透传 + smoke 桥形状 + index 注册齐全（自动覆盖新 channel）+
  E2E `e2e/desktop.reveal.spec.ts` G12/G13。

偏差记录：

- E2E（§17.4）：CI/Linux 无法验证真实 GUI 文件管理器，经
  `app.evaluate` stub Main 进程 `shell.showItemInFolder`（调用记录进
  globalThis），断言 IPC 全链路被调用且路径在 realpath(Vault) 内；
  真实 GUI 行为留平台人工验收。
- 附件契约取 relativePath 而非 assetId（见上）；REVEAL_TARGET_NOT_FOUND
  未新增，复用 NOTE_NOT_FOUND（R007 §11）。
- 测试用例只写不跑（批次规则），统一测试执行在全部阶段完成后进行；
  §9.5 各验收点以该统一执行结果为准。

---

# 10. Stage 3：Search Contract + Benchmark

## 10.1 目标

在写数据库之前先冻结：

- 搜索语义；
- Search Port；
- Index document model；
- ranking baseline；
- benchmark fixture；
- correctness test corpus。

不允许一边写 SQL 一边决定产品语义。

## 10.2 搜索范围

R008 第一版搜索：

```text
title
tags
body plain text
```

不做 semantic embedding、OCR、PDF indexing、image content、code intelligence、backlinks。

## 10.3 SearchDocument

建议：

```ts
interface SearchDocument {
  pageId: string;
  vaultId: string;
  stableNoteId: string | null;
  relativePath: string;

  title: string;
  tags: string[];
  bodyText: string;

  createdAt: number | null;
  updatedAt: number | null;
  versionToken: string;
}
```

`bodyText` 来源：

```text
Markdown
→ codec / parser
→ searchable plain text
```

不要直接把原始 Markdown syntax 作为唯一索引文本。

## 10.4 SearchResult

建议：

```ts
interface SearchResult {
  pageId: string;
  title: string;

  matchedField:
    | "title"
    | "tag"
    | "body";

  snippet: string | null;
  score: number;
  relativePath?: string;
}
```

## 10.5 Search API

继续沿用 / 扩展 `SearchIndexPort`：

```ts
prepareWorkspace(vaultId): Promise<void>;

search(input: {
  vaultId?: string;
  query: string;
  limit: number;
}): Promise<SearchResult[]>;

upsert(doc: SearchDocument): Promise<void>;

remove(input: {
  vaultId: string;
  pageId: string;
}): Promise<void>;

rebuild(vaultId: string): Promise<SearchRebuildResult>;
getStatus(vaultId: string): Promise<SearchIndexStatus>;
```

## 10.6 Query 规则

第一版定义：

- trim query；
- 空字符串返回空结果；
- Unicode / 中文必须支持；
- 大小写默认不敏感；
- title 命中权重最高；
- tag 次之；
- body 最低；
- 相同 score 使用稳定排序；
- limit 必须有上限，例如 100；
- 不做复杂 query language。

## 10.7 Benchmark Fixture

建立：

```text
fixtures/search/
├─ 1k/
├─ 10k/
└─ generator.ts
```

50k 可以程序生成，不提交完整大体积 fixture。

文档分布至少包含：

- 中文标题；
- 英文标题；
- 中英混合；
- 多标签；
- 长文；
- 短文；
- 深目录；
- 重复词；
- 高频词；
- emoji；
- code block；
- links；
- tables；
- frontmatter。

## 10.8 Performance Baseline

目标级：

```text
1k notes rebuild        < 1~2 s 目标区间
10k notes rebuild       < 10 s 目标区间
search warm query       < 100 ms
single document upsert  < 50 ms
watcher → searchable    < 1 s
```

实际值以开发机与 CI benchmark 报告为准。

Perf 独立运行，不塞进普通 unit test hard SLA。

## 10.9 Stage 3 实现记录

**状态：已完成（2026-08-21）**

契约冻结终值：

- **`src/application/services/SearchContract.ts`**（与既有
  `SearchIndexPort` 同目录）：
  - `SearchDocument{pageId, vaultId, stableNoteId, relativePath, title,
    tags, bodyText, createdAt, updatedAt, versionToken}`（§10.3 终值）；
  - `SearchResult{pageId, title, matchedField, snippet, score,
    relativePath?}`（§10.4 终值；与 domain/types 的标题搜索
    `SearchResult` 同名的遗留形状并存，消费方按模块路径区分，
    Stage 4 接线时如需同文件引用用 import alias）；
  - `SearchIndexStatus` 五态 / `SearchRebuildResult{indexedDocuments,
    durationMs}` / `SearchQueryInput` / `SearchRemoveInput`；
  - **新 port `FullTextSearchIndexPort`**：`prepareWorkspace(vaultId)` /
    `search({vaultId?, query, limit})` / `upsert(doc)` /
    `remove({vaultId, pageId})` / `rebuild(vaultId)` / `getStatus(vaultId)`。
- **查询语义可执行化**（§10.6/§11.7 由纯函数实现而非注释约定）：
  `normalizeSearchQuery`（trim + 小写，Unicode 安全）、
  `scoreSearchDocument`（权重 exact title 100 > title prefix 80 >
  title contains 60 > tag exact 45 > tag contains 40 > body 20）、
  `makeSearchSnippet`（半径 30，保留原文大小写，正文未命中为 null）、
  `compareSearchResults`（score 降序 → 标题码元升序 → pageId 升序，
  与插入顺序无关）、`rankSearchDocuments`（空查询 []，limit 夹在
  [0, `SEARCH_LIMIT_MAX=100`]）。所有实现的查询路径复用这些函数或
  经契约测试证明等价。
- **Markdown → searchable text**：`shared/markdown/searchText.ts` 的
  `markdownToSearchText`（frontmatter 剥离；围栏代码保留内容去围栏；
  链接锚文本/图片 alt 保留、URL 丢弃；表格管道/HTML 标签/水平线/
  链接引用定义剔除；强调标记仅非词内边界剔除，snake_case 保留；
  空白归一为单行）。零依赖、环境中立，Electron Main（Stage 4 扫描/
  重建）与 Renderer 共用（frontmatter.ts 双端先例），NodeNext 下
  以 `.js` 扩展名引用。
- **内存参照实现**：`src/infrastructure/memory/fullTextSearchIndex.ts`
  （vault 分桶存储 + 状态模型，查询完全委托契约层纯函数——即
  Stage 4 推荐「存储/召回 + 契约层精排」分层的最小形态）。
- **契约测试套件**（§17.2）：`src/test/searchIndexContract.ts`
  14 组断言——upsert 幂等、同 pageId 覆盖后旧文本消失、remove 幂等、
  query 确定性（乱序插入两实例一致）、rebuild 后结果一致、trim/
  空查询/大小写/中文/emoji、title>tag>body 权重、同分稳定排序、
  limit 上限 100 与截断、vault 隔离、跨 vault 合并、getStatus
  状态机（missing → ready + rebuild 计数）、验收语料全量。
  内存实现接入：`src/infrastructure/memory/fullTextSearchIndex.test.ts`；
  Stage 4 Desktop 实现复跑同一套件。
- **Benchmark 语料与基线**（§10.7/§10.8）：`fixtures/search/generator.ts`
  （mulberry32 固定 seed 20260821，12 原型轮转覆盖 §10.7 全维度，
  每篇产出 markdown + SearchDocument 双形态，bodyText 经
  `markdownToSearchText` 真实提取；1k/10k/50k 参数化，实体不提交）+
  `fixtures/search/corpus.ts`（12 文档 + 16 条固定 query 断言：
  中文「知识库」「部署」、大小写 react/REACT/typescript、tag
  exact/contains、emoji、代码词、snippet 原文大小写、空标题回退
  「无标题」、跨 vault、limit）。`src/test/searchIndex.perf-wallclock.test.ts`
  （内存实现占位：1k/10k build + 3 轮 warm query p50/p95 + 20 次单
  文档 upsert p95，输出 §18 JSON 形状 `[search-benchmark]` 前缀），
  在 `vitest.perf.config.ts` 覆盖范围内（`src/**/*perf-wallclock.test.ts`），
  Stage 4 复用同一 harness（`runSearchBenchmark`）只换 `makeIndex`。
  `tsconfig.json` include 增加 `fixtures`。

中文搜索方案倾向（§11.4，最终由 Stage 4 实测确认）：**倾向方案 B
（应用层 normalized bigram token + FTS）**。理由：契约层
`rankSearchDocuments` 提供与底层分词器无关的精确打分与稳定排序，
Stage 4 可用「FTS bigram 召回候选 + 契约层精排」保证契约套件与
中文验收语料通过——中文可控、不引入 SQLite 原生扩展、跨平台
packaging 简单；代价是索引体积增长，可接受（索引是 derived data，
可随时重建）。方案 A（unicode61 + substring）作为实测 fallback。

偏差记录：

- §10.5 称「继续沿用/扩展 `SearchIndexPort`」——实际新建独立 port
  `FullTextSearchIndexPort`：既有 port 的方法签名（workspaceId 语义、
  `syncPages`/`updateText`/`has`/`query`、仓储取数）与 §10.5 模型
  整体不兼容，扩展会波及 Web/内存/DesktopTitle 三实现与
  `SearchQueryService` 回退链路的全部装配，违反最小破坏原则；
  新旧 port 并存，Stage 4 由装配层接入新 port。
- §10.7 的 `fixtures/search/1k/`、`10k/` 实体目录不提交（10k 实体
  体积过大且无必要），全部规模由生成器参数化产出；提交的实体
  只有验收语料 `corpus.ts`。
- 测试用例按批次规则只写不跑，统一测试执行在全部阶段完成后进行；
  本阶段已验证 `tsc --noEmit`（Web + Electron 双 tsconfig）与
  eslint（全部新增文件 0 error）。

---

# 11. Stage 4：Desktop Search Database + Full Text

**状态：实现中（2026-08-21，中断点记录）**

已落地（工作区，随中断点提交，测试只写未跑、未经统一执行验证）：

- 契约下沉：模型类型与查询语义纯函数唯一来源移至 `shared/search/model.ts`（SearchDocument/SearchResult/SearchIndexStatus/SearchRebuildResult/SearchQueryInput/SearchRemoveInput）与 `shared/search/ranking.ts`（rankSearchDocuments/权重/SEARCH_LIMIT_MAX），`src/application/services/SearchContract.ts` 原样 re-export 冻结导出面——Electron Main 复用同一实现（electron 不得 import src，同 searchText.ts 先例）。
- Main 搜索库 `electron/main/search/`：`DesktopSearchDatabase.ts`（node:sqlite，`userData/search-index/`）、`DesktopSearchService.ts`、`VaultSearchDocumentSource.ts`（扫描 → SearchDocument 映射）、`searchTokens.ts`（中文 bigram，方案 B 路线）+ 各自测试。
- IPC search 组：`shared/ipc/contracts.ts`（SearchVaultInput/SearchUpsertInput + search 组 E1DesktopAPI）+ `schemas.ts` 校验 + `electron/main/ipc/search.ts` + preload 桥。
- Renderer：`src/platform/desktop/DesktopFullTextSearchIndex.ts`（FullTextSearchIndexPort 桥实现）+ `createDesktopRuntime.ts` 装配（AppServices 可选 fullTextSearchIndex）+ `WorkspaceQueryService` 注入 + `src/test/desktopFullTextSearch.contract.test.ts`（契约套件接入）。

未完成（下一阶段继续）：契约套件双实现复跑的完整性核对、SearchPanel 全文接入与 title-only 降级（§14/§20）、E2E G14–G16（只写）、本节省略的实现记录与中文方案终选确认、AGENTS.md/persistence.md 同步；全部测试（含本阶段既有改动）待统一执行阶段验证。

## 11.1 技术选型

首选评估：

```text
node:sqlite
```

原因：

- Electron 当前自带 Node；
- 避免额外 native addon rebuild；
- 降低跨平台 packaging 复杂度；
- 能放在 Electron Main；
- 搜索 DB 只是 derived index，可替换。

但必须通过 adapter 隔离：

```text
SearchIndexPort
        ↓
DesktopSearchIndex
        ↓
DesktopSearchDatabase
        ↓
node:sqlite
```

如果实测 FTS 能力不满足、Electron bundled Node API 不合适或性能不达标，允许改用 `better-sqlite3`，但不能影响 Application / Domain。

## 11.2 数据库位置

推荐：

```text
userData/search-index/<vaultId>.sqlite
```

不要放 `Vault/.e1/`。

理由：

- 搜索索引是设备级派生状态；
- 不应该污染用户 Markdown Vault；
- 不应该跟随 Vault 同步到第三方设备；
- 删除 userData 索引不影响正文。

## 11.3 Schema

示意：

```sql
CREATE TABLE index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE notes (
  page_id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  stable_note_id TEXT,
  relative_path TEXT NOT NULL,
  title TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  version_token TEXT NOT NULL,
  updated_at INTEGER
);
```

全文表：

```text
notes_fts
```

字段：

```text
title
tags
body
```

具体 FTS tokenizer 必须通过中文搜索测试后再冻结。

## 11.4 中文搜索

这是本阶段的重要风险项。

SQLite 默认 tokenizer 对中文分词能力有限。

第一版可接受两种方案：

### 方案 A：unicode61 + substring/prefix 策略

优点：

- 实现简单；
- 无额外原生扩展。

缺点：

- 中文检索效果有限。

### 方案 B：应用层生成 normalized searchable tokens

```text
Markdown body
→ normalize
→ char n-gram / bigram
→ FTS token stream
```

优点：

- 不引入 SQLite extension；
- 中文可控。

缺点：

- 索引体积增长。

R008 必须通过真实中文 corpus 决定，不允许只用英文 benchmark。

## 11.5 Initial Rebuild

首次打开一个没有索引的 Vault：

```text
Vault scan
→ SearchIndexStatus = rebuilding
→ batch read notes
→ parse/search text
→ transaction batch upsert
→ commit
→ status ready
```

UI 可以显示：

```text
搜索索引正在建立
```

但页面树和编辑器必须先可使用，不能阻断打开 Vault。

## 11.6 Batch Strategy

禁止每个 note 一个 transaction。

建议：

```text
100~500 docs / transaction
```

具体经 benchmark 决定。

## 11.7 Search Ranking

第一版可定义：

```text
exact title
> title prefix
> title contains
> tag match
> body match
```

必须保证同一查询结果排序稳定。

---

# 12. Stage 5：Watcher Incremental Index

## 12.1 目标

在 Stage 4 完成后，不再每次 Vault 变化都全量 rebuild。

## 12.2 数据流

```text
VaultWatcher
→ events:vaultChanges
→ DesktopExternalVaultChangeService
→ normalized:
   created
   modified
   moved
   deleted
→ DesktopSearchIndexReconciler
→ SearchIndexPort
```

## 12.3 事件行为

### created

```text
read new note
→ parse
→ upsert
```

### modified

先比较 `versionToken`。

相同则 no-op；不同则：

```text
read
→ parse
→ upsert
```

### moved

Stable ID 存在：

```text
same page identity
→ update relativePath
```

如果第一版实现复杂，可以重新 read + upsert。

### deleted

```text
delete index row
```

## 12.4 Self-write

现有 `SelfWriteRegistry` 继续负责 UI watcher echo 抑制。

但索引不能因为 self-write suppression 导致漏更新。

推荐：

```text
DocumentCommitService success
→ best-effort searchIndex upsert
```

Watcher 主要负责外部变化。

## 12.5 索引维护失败

如果：

```text
Markdown save success
Search upsert failed
```

则：

```text
SearchIndexStatus = degraded
mark vault dirty
schedule rebuild
```

用户正文保存仍然成功。

---

# 13. Stage 6：Rebuild / Recovery / Scale Acceptance

## 13.1 Index Status

推荐：

```ts
type SearchIndexStatus =
  | { state: "missing" }
  | { state: "building"; progress?: number }
  | { state: "ready"; indexedDocuments: number }
  | { state: "degraded"; reason: string }
  | { state: "corrupt"; reason: string };
```

## 13.2 Schema Version

DB 必须有：

```text
schemaVersion
indexFormatVersion
```

如果版本不兼容：

```text
delete old derived DB
→ rebuild
```

派生索引优先 rebuild，不做过重 migration。

## 13.3 Corruption Recovery

如果 SQLite open / integrity / schema 失败：

```text
close
→ rename .corrupt.<timestamp>
→ create fresh DB
→ rebuild
```

绝不能因为搜索库坏了导致 Vault 无法打开。

## 13.4 Manual Rebuild

设置或搜索 UI 增加：

```text
重建搜索索引
```

流程：

```text
drop derived index
→ rebuild
```

不能删除 Markdown。

## 13.5 Performance Acceptance

最终至少测：

```text
1,000 notes
10,000 notes
50,000 notes sanity
```

建议验收目标：

### 1k

```text
initial index build <= 2s target
warm query <= 100ms
single update <= 100ms
```

### 10k

```text
initial index build <= 10s target
warm query <= 150ms
single update <= 150ms
```

### 50k

不要求极端首建速度，但必须：

```text
无 OOM
UI 不永久卡死
搜索可在 index ready 后稳定工作
增量更新不退化成全量 scan
```

时间数字最终依据真实 benchmark 调整并回写本文档。

---

# 14. UI / UX

## 14.1 Search UI

现有搜索入口继续使用，不重新设计大 UI。

状态：

```text
index missing/building:
  正在建立本地搜索索引…

ready:
  正常搜索

degraded:
  搜索索引需要修复
  [重建索引]
```

## 14.2 Search Result

建议：

```text
[标题]
snippet 中命中内容……
标签 / 路径辅助信息
```

命中词高亮由 UI 做，不要求 DB 返回 HTML。

禁止 DB snippet 中直接返回未经转义 HTML。

## 14.3 Search Input

要求：

- debounce；
- query request id；
- 丢弃过期结果；
- 搜索期间不能阻断编辑；
- Escape 清空 / 关闭遵循现有 UI 规则。

---

# 15. 安全设计

## 15.1 IPC

所有新 IPC：

- schema validation；
- known channel only；
- Renderer 不得传 absolute path；
- error code 继续通过现有 IPC bridge encoding 保留；
- secret value 不进入 Error details。

## 15.2 Secret

禁止：

```text
console.log(apiKey)
JSON.stringify(settings with secret)
test snapshot secret
Playwright artifact secret
```

## 15.3 Search DB

搜索 DB 可能包含正文派生文本。

因此：

- 只保存在本机 `userData`；
- 不上传；
- 不加入日志；
- crash report 不自动附带 DB；
- 删除 Vault / 移除最近记录时不自动删除 index，除非用户明确清理；
- 后续可以提供“清除本机索引数据”。

---

# 16. 模块规划

建议新增：

```text
electron/main/
├─ secrets/
│  ├─ DesktopSecretStore.ts
│  ├─ SecretFilePersistence.ts
│  └─ SecretBackendStatus.ts
│
├─ search/
│  ├─ DesktopSearchDatabase.ts
│  ├─ DesktopSearchSchema.ts
│  ├─ DesktopSearchIndexer.ts
│  ├─ DesktopSearchRebuilder.ts
│  └─ DesktopSearchRecovery.ts
│
└─ ipc/
   ├─ secret.ts
   └─ reveal.ts
```

Renderer / application：

```text
src/application/services/
├─ SearchIndexStatusService.ts
└─ SecretStorageStatus.ts

src/platform/desktop/
├─ DesktopSecretStore.ts
├─ DesktopSearchIndex.ts
├─ DesktopSearchIndexReconciler.ts
└─ DesktopRevealService.ts
```

共享：

```text
shared/ipc/
├─ contracts.ts
└─ schemas.ts
```

---

# 17. 测试计划

## 17.1 Unit

Stage 0：

- operation policy document/group；
- Group rename hidden；
- Group draggable false；
- external runtime dependency validation。

Secret：

- encrypt/decrypt adapter；
- session-only fallback；
- corrupted secret file；
- unknown secret；
- delete secret；
- secret schema version。

Reveal：

- valid relative path；
- traversal；
- symlink escape；
- unknown vault；
- missing file。

Search：

- SearchDocument mapper；
- title/tag/body query；
- 中文；
- Unicode；
- ranking；
- empty query；
- stable ordering；
- rebuild；
- corrupt DB；
- schema mismatch；
- incremental create/update/delete/move。

## 17.2 Contract

SearchIndexPort contract：

```text
Memory implementation
Desktop implementation
```

在共同语义上必须通过同一套测试。

重点：

- upsert 幂等；
- remove 幂等；
- query deterministic；
- rebuild 后结果一致；
- update 后旧文本消失。

## 17.3 Component

- Group 不显示 unsupported rename；
- Group 不可拖；
- Secret session-only 文案；
- Search building 状态；
- Search degraded + rebuild；
- Search result snippet；
- stale search request 丢弃。

## 17.4 Desktop E2E

在现有黄金路径基础上新增：

```text
G10 API Key 保存 → 重启 → 仍存在（安全 backend）
G11 Secret backend 不安全 → 重启后 key 不存在
G12 当前文档 → Reveal
G13 附件 → Reveal
G14 title 搜索
G15 body 搜索
G16 中文正文搜索
G17 外部编辑文档 → watcher → 新正文可搜索
G18 外部删除 → 搜索结果消失
G19 外部 move → 搜索结果身份保持
G20 删除 search DB → 重启 → 自动 rebuild
```

Reveal 在 CI Linux 环境不一定能验证真实 GUI file manager，可：

- Main service 单元测试真实路径；
- E2E 验证 IPC 调用与 capability/UI；
- 平台人工验收验证 shell 行为。

---

# 18. CI

继续保持现有：

```text
quality
build-web
build-desktop
e2e-web
e2e-desktop
```

建议新增非阻塞或独立：

```text
perf-search
```

第一阶段只上传 benchmark artifact。

例如：

```bash
npm run test:perf -- search
```

输出：

```json
{
  "documents": 10000,
  "buildMs": 5230,
  "queryP50Ms": 18,
  "queryP95Ms": 42,
  "updateP95Ms": 35
}
```

不要在共享 CI 环境一开始就使用脆弱的绝对 wall-clock hard fail。

---

# 19. 数据迁移

## 19.1 Vault

本需求不改变 Markdown 主格式。

已有 Vault 无需迁移。

## 19.2 Secret

旧 Desktop 使用 `InMemorySecretStore`，无持久 secret 可迁移。

首次升级：

```text
用户下一次设置 API Key
→ 写入安全存储
```

## 19.3 Search DB

首次升级：

```text
index missing
→ 自动创建
→ rebuild
```

任何 schema 更新优先 derived DB rebuild，而不是复杂 migration。

---

# 20. 失败处理原则

## Secret Failure

```text
secure backend unavailable
→ session-only
→ 明确 UI
```

不是 plaintext persistent fallback。

## Reveal Failure

```text
missing / unauthorized
→ 用户可理解错误
```

不能泄露完整绝对路径。

## Search Failure

```text
index unavailable
→ Markdown editor 继续工作
```

搜索可降级为 title-only 或提示重建。

正文编辑永远优先。

---

# 21. 需求实施顺序

强制推荐：

```text
1. Stage 0
   Operation truthfulness
   Runtime dependency hygiene

2. Stage 1
   Native Secret Store

3. Stage 2
   Reveal

4. R007 closure
   更新 R007 = 已完成

5. Stage 3
   Search contract + benchmark

6. Stage 4
   Full-text derived database

7. Stage 5
   Incremental indexing

8. Stage 6
   Recovery + scale acceptance

9. R008 acceptance
```

不建议先上 SQLite，再回头修 operation / secret / runtime dependency。

---

# 22. 提交拆分建议

建议至少拆成以下提交：

```text
fix(R008): 收口 Desktop document/group 操作支持矩阵
```

```text
build(R008): 修正 Electron runtime external dependencies
```

```text
feat(R008): Desktop native secret store 与安全降级
```

```text
feat(R008): Desktop reveal in file manager
```

```text
docs(R008): 关闭 R007 并冻结 Search contract
```

```text
feat(R008): Desktop derived full-text search index
```

```text
feat(R008): watcher 驱动增量索引
```

```text
feat(R008): search index rebuild/recovery 与规模化验收
```

不要合成一个超大 commit。

---

# 23. R008 Definition of Done

只有同时满足以下条件才可将 R008 标记为完成。

## R007 收口

- [ ] document/group operation support 与真实能力一致；
- [ ] Group 不再暴露会抛 NOT_IMPLEMENTED 的 rename/move；
- [ ] chokidar 属 production runtime dependency；
- [ ] Electron external dependency 有自动门禁；
- [ ] R007 文档状态与实际代码一致；
- [ ] R007 标记已完成。

## Secret

- [ ] Desktop 不再使用 `InMemorySecretStore` 作为正常持久实现；
- [ ] secure backend 下 API Key 重启保持；
- [ ] insecure backend 下不会明文持久化；
- [ ] SecretStorageStatus 可表达真实运行状态；
- [ ] secret 不出现在日志 / artifact / Vault。

## Reveal

- [ ] note reveal 可用；
- [ ] asset reveal 可用；
- [ ] Renderer 无 absolutePath；
- [ ] PathGuard / Vault authorization 不可绕过；
- [ ] `revealInFileManager = true`。

## Search

- [ ] title 搜索；
- [ ] tags 搜索；
- [ ] body 全文搜索；
- [ ] 中文搜索通过验收 corpus；
- [ ] Search DB 是 derived data；
- [ ] 删除 Search DB 后可完整 rebuild；
- [ ] watcher create/update/delete/move 可增量维护；
- [ ] self-write 不产生重复 UI reload / index loop；
- [ ] index failure 不影响 Markdown save；
- [ ] 10k notes 规模可日用；
- [ ] 50k notes sanity 不 OOM；
- [ ] degraded / rebuilding 状态有 UI；
- [ ] Desktop golden E2E 全绿；
- [ ] Web 无回归；
- [ ] 架构 / decisions / requirements / AGENTS 同步。

---

# 24. 后续需求建议

R008 完成后再按价值选择：

## R009：Desktop Distribution

- electron-builder；
- dmg；
- Windows installer；
- signing；
- auto update；
- release CI。

## R010：Knowledge Graph

- backlinks；
- link index；
- broken links；
- outgoing links；
- graph view。

## R011：Desktop File Operations v2

- group rename；
- group move；
- physical file rename；
- relative link impact analysis；
- optional link rewrite。

## R012：Revision / History

- Desktop local revisions；
- snapshot retention；
- restore；
- diff。

不要把以上需求重新塞回 R008。

---

# 25. 决策摘要

本需求最终冻结以下方向：

1. **R007 不再新增 Stage 6+，剩余内容并入 R008。**
2. **先清产品一致性债务，再建设搜索。**
3. **Document 和 Group 的 operation support 必须分开。**
4. **Secret 使用系统安全存储，不安全时只 session-only。**
5. **Reveal 绝不向 Renderer 暴露 absolutePath。**
6. **Search Index 永远是 Markdown 的可重建派生数据。**
7. **优先评估 `node:sqlite`，但通过 adapter 隔离数据库实现。**
8. **中文搜索必须是正式验收项。**
9. **Watcher 负责事实，Indexer 负责索引语义。**
10. **搜索失败不能影响正文保存。**
11. **10k 文档是正式性能目标，50k 是规模 sanity。**
12. **Installer / revision / backlinks / group file ops 继续后移。**

---

# 26. 变更记录

## 0.1 — 2026-08-21

首次建立。

合并：

- R007 阶段 4 后遗留的 Operation Support 精确化；
- Electron `chokidar` production runtime dependency 修正；
- 原 R007 Stage 5 Native Secret Store；
- 原 R007 Stage 5 Reveal in File Manager；
- R008 Desktop Full-text Search；
- Desktop Search derived database；
- Watcher incremental index；
- Search rebuild / corruption recovery；
- 1k / 10k / 50k 性能验收。

R007 在本需求 Stage 0–2 完成后正式关闭，后续不继续追加产品化阶段。

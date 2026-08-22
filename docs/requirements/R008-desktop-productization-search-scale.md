# R008：Desktop 产品化收尾与搜索规模化

- **版本**：0.1
- **状态**：实现中（Stage 0–5 已完成）
- **更新时间**：2026-08-22
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

> 2026-08-22 事实同步（R007 阶段 5 已交付 + Stage 1 对齐）：`revealInFileManager` 已翻 true；`nativeSecrets` 为「集成存在」静态 true（R8-02），本机实际安全后端由运行时 `secret.status` / `AppServices.secretStorageStatus` 表达。

当前 Desktop 能力约为：

```ts
{
  localDirectory: true,
  fileWatching: true,
  revealInFileManager: true,   // R007 阶段 5 已实现（note.reveal / asset.reveal）
  nativeMenu: false,
  nativeSecrets: true,         // 集成存在（R8-02）；持久性见 secretStorageStatus
  persistentAssetPaths: true,
  documentPersistence: true,
}
```

其中：

- `localDirectory`：真实；
- `fileWatching`：真实；
- `persistentAssetPaths`：真实；
- `documentPersistence`：真实；
- `revealInFileManager`：真实（R007 阶段 5）；
- `nativeSecrets`：DesktopSecretStore 已接 Main safeStorage（R007 阶段 5 落地 + Stage 1 对齐 R8-02），「集成存在」恒 true；持久性由 `SecretStorageStatus.mode` 决定；
- `nativeMenu`：本需求不实现。

## 2.2 当前 RuntimeOperations

> 2026-08-22 事实同步（Stage 0 已按 §7.2 完成细分）：page 已拆为 document / group / trash 三组的静态矩阵。

```ts
{
  workspace: { rename: false, favorite: true },
  page: {
    document: {
      create: true, renameTitle: true, renameFile: false,
      move: true, trash: true, favorite: true,
    },
    group: { create: true, rename: false, move: false, trash: true },
    trash: { restore: true, purge: true },
  },
  tag: { write: true },
  revision: { read: false, write: false },
}
```

Stage 0 之前矩阵存在的语义问题（`page.renameTitle = true` / `page.move = true` 只完整适用于 document，Group UI 仍可能「入口可见 → 操作 → NOT_IMPLEMENTED」）已通过 document/group 细分消除，违反 R007 G4 原则的路径已收口。

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
page.move = true;
```

如果 document 和 group 的实现不同。

正确方向：

```ts
page.document.move;
page.group.move;
```

或提供：

```ts
operations.canMove(page);
operations.canRename(page);
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
{
  (vaultId, relativePath);
}
```

或：

```ts
{
  (vaultId, assetId);
}
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

**状态：已完成（2026-08-22）**

实际实现与偏差记录：

- RuntimeOperations 按 §7.2 推荐的静态矩阵细分（未采用 PageOperationPolicy 备选）：`page.document{create,renameTitle,renameFile,move,trash,favorite}` / `page.group{create,rename,move,trash}` / `page.trash{restore,purge}`；Desktop `group.rename/group.move=false`（R011）、`document.renameFile=false`，Web 全 true；内存容器缺省同步。
- PageTreeSidebar（§7.3）：行内动作/F2/拖拽按页面 kind 取 operation 子组——Group 隐藏重命名按钮、`draggable=false`、F2 不触发；`group.rename=false` 时新建分组不再自动进入必然失败的重命名流程（renamingSeed 按 `group.rename` 门控）；拖拽视觉提示随 `draggable=false` 整体不出现。
- chokidar（§7.4）：devDependencies → dependencies；新增 `scripts/verifyElectronRuntimeDeps.mjs`（构建脚本 external 提取 + production dependencies 声明校验 + `--resolve` 运行时解析模式）与 `scripts/verifyElectronRuntimeDeps.test.mjs` 构建级回归锁；CI 新增 `desktop-runtime-deps` job（npm ci → build:desktop → `npm prune --omit=dev` → 运行时解析 sanity）。
- 文档（§7.5）：R007 文档状态已由 R007 阶段 5 批次同步（待验收）；本文件 §2.1/§2.2 已按真实状态回写；runtime-boundaries 操作矩阵表同步细分。
- 偏差：无（§7.2 推荐方案直接落地）。

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
page.document.renameTitle = true;
page.document.move = true;

page.group.rename = false;
page.group.move = false;
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
external: ["electron", "chokidar"];
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

---

# 8. Stage 1：Native Secret Store

**状态：已完成（2026-08-22）**

实际实现与偏差记录：

- 主体链路已在 R007 阶段 5 交付（safeStorage 密文落 `userData/secrets.json` + `secret.status/get/set/delete` IPC + Renderer DesktopSecretStore + 设置页降级提示）；本阶段按 R008 口径对齐，Application 层 secret 使用方式不变（§8.2）。
- 模块迁移（§8.4/§16）：`electron/main/state/DesktopSecretPersistence` → `electron/main/secrets/SecretFilePersistence.ts` + `SecretBackendStatus.ts`。
- 文件格式对齐 §8.4：`{ version: 1, entries: { <name>: { ciphertext, updatedAt } } }`；读兼容 R007 阶段 5 的 `{ secrets: { name: base64 } }`（未发布格式，静默迁移，下次写盘即新格式）。
- §8.5 安全后端判定（`SecretBackendStatus.evaluate`）：非 Linux 看 `isEncryptionAvailable()`（Keychain/DPAPI）；Linux 必须 `getSelectedStorageBackend()` ∈ gnome_libsecret/kwallet* 才算 secure-persistent，`basic_text`/`unknown` → session-only，**绝不弱保护落盘**。加解密优先 Electron 43 的 `encryptStringAsync/decryptStringAsync`（`shouldReEncrypt` 时顺带重写该条），缺省回退同步接口。
- §8.6 SecretStorageStatus：`{ mode: "secure-persistent" | "session-only" | "unavailable", backend?, reason? }` 取代 R007 的 `{ available }` 布尔；R8-02 落地——`capabilities.nativeSecrets` 翻为静态 true（集成存在），本机实际状态由 `secret.status` → `AppServices.secretStorageStatus` 表达（平台无关视图 `application/services/SecretStorageStatus.ts`）；`main.desktop.tsx` 探测失败按 unavailable（安全缺省）。
- §8.7 Renderer 文案：secure-persistent →「API Key 会安全保存在本机系统凭据存储中」；session-only →「当前系统安全存储不可用，API Key 仅在本次会话有效」；unavailable →「无法使用系统安全存储…」。禁止 fallback localStorage（沿用，无此路径）。
- 设置页状态修正（G2 顺带）：「AI 已配置」改为 endpoint/model **且** apiKey 同时在场才成立——session-only 重启后偏好仍在但 Key 已丢，不再显示半配置的「已配置」。
- unknown schema version（§8.8）：与损坏同口径——先备份（`.corrupt-<ts>`，原内容字节级保留）再自愈为空表；测试断言备份完整保留未知版本内容（「不湮灭不理解的格式」，备份即不覆盖原内容）。
- E2E（§17.4 映射：G10=本文 G09）：`desktop.secrets.spec.ts` 重写为双用例按 `secret.status` 实测分流——@golden G09 安全后端（重启保持 + 无明文 + 凭据存储文案，后端不安全时 skip）与 @golden G11 不安全后端（session-only 提示 + 重启后 Key 不存在 + 不弱保护落盘，后端安全时 skip）；启动保留 `--password-store=basic` 使 Linux CI 确定落在 G11。
- 偏差：IPC 形状沿用 R007 的 `secret.status/get/set/remove`（未改名 `getStatus`）；模块落 `electron/main/secrets/` 两文件（未再细分 DesktopSecretStore.ts/SecretBackendStatus 独立目录层）。

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
secret.get({ name });
secret.set({ name, value });
secret.remove({ name });
secret.getStatus();
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
safeStorage.encryptStringAsync();
safeStorage.decryptStringAsync();
```

如果当前 Electron API 可用。

需要检查：

```ts
safeStorage.isEncryptionAvailable();
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
  mode: "secure-persistent" | "session-only" | "unavailable";

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

---

# 9. Stage 2：Reveal in File Manager

**状态：已完成（2026-08-22）**

实际实现与偏差记录：

- 主体链路已在 R007 阶段 5 交付：`note.reveal({vaultId, relativePath})` / `asset.reveal` IPC（schema 校验 → resolveVaultRoot 授权 → PathGuard（realpath 符号链接逃逸防护）→ `shell.showItemInFolder`，§9.3 全链路；目标不存在归一 `REVEAL_TARGET_NOT_FOUND`）+ Renderer `DesktopRevealService`（可选 port `AppServices.reveal`）+ `capabilities.revealInFileManager` 翻 true。本阶段做验收口径对齐与 E2E 补齐。
- **偏差 1（§9.2 asset.reveal 入参）**：实际为 `{ assetId }` 而非 `{ vaultId, assetId }`——assetId 本身编码 vaultId + relativePath（`shared/assets/desktopAssetId`），Main 解码后重新 resolveVaultRoot + PathGuard，授权语义等价且不增加冗余参数。
- **偏差 2（§9.4 UI 形态）**：EditorShell 无「更多」菜单，文档入口为顶栏「在文件管理器中显示」图标按钮（当前文档；树行内方案因第 4 按钮覆盖行点击中心被弃用，见 R007 阶段 5 偏差 3）；附件无 context menu，入口为附件块「在文件夹中显示」按钮（`AssetAccessService.reveal?` 可选方法，仅 Desktop 实现）。均按 `capabilities.revealInFileManager` 门控，Web 不出现（组件测试锁定）。
- transient 行为（§9.5）：允许（只读操作，与 note.read 同口径，Main 单元测试锁定）。
- E2E（§17.4）：`desktop.reveal.spec.ts`——@golden G12 当前文档顶栏 reveal（入口可见 + 点击后无错误条，真实 IPC + Main 真实路径解析）与 @golden G13 附件节点 reveal（无「无法定位文件」）；GUI 文件管理器效果不可断言（CI xvfb），malformed/逃逸/缺失拒绝由 Main 单元测试覆盖（reveal.test.ts 9 例）。

## 9.1 目标

Desktop 用户可以定位：

- 当前 Markdown 文件；
- 本地附件文件。

## 9.2 IPC

推荐：

```ts
note.reveal({
  vaultId,
  relativePath,
});
```

附件：

```ts
asset.reveal({
  vaultId,
  assetId,
});
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
shell.showItemInFolder(rendererProvidedAbsolutePath);
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

---

# 10. Stage 3：Search Contract + Benchmark

**状态：已完成（2026-08-22）**

实际实现与偏差记录：

- 契约（§10.3–10.6 冻结）：`src/application/search/FullTextSearchIndex.ts`（SearchDocument / FullTextSearchResult{matchedField,snippet,score,relativePath} / SearchIndexStatus / port：rebuild/search/upsert/remove/relocate/getStatus）——与既有 SearchIndexPort（Web 语义）**并存**，不改 Web 搜索行为；评分表 exact title 100 > prefix 80 > contains 60 > tag 40 > body 20（§11.7），排序 score 降序 → title zh-CN → pageId；limit 缺省 50 上限 100。
- 中文方案（§11.4）：选定**方案 B**——应用层 CJK unigram+bigram 词元（`shared/search/textMatch.ts`，环境中立零依赖，Main/Renderer 共用）；body 命中 = 查询切词后逐项 CJK bigram 覆盖 / 拉丁词前缀（AND）；title/tag = 归一化子串；归一 = NFKC + lowercase（全角 ＲＵＳＴ 可查 rust）。语义以契约套件冻结，两实现（内存/SQLite）必须一致。
- bodyText 提取（§10.3）：`shared/markdown/plainText.ts`——剥离 Frontmatter 与语法标记（围栏/链接 URL/图片语法/表格管道/HTML 标签/强调/标题列表标记），保留代码、链接文字、alt、单元格内容为可搜索文本；不依赖 Tiptap（Main 可用，R006 约束）。
- 契约套件（§17.2）：`src/test/fullTextSearchContract.ts` 16 例——title 三级评分排序、tag/body 命中、中文子串与跨词 AND、拉丁前缀、大小写/NFKC、emoji、code/表格/链接、空查询、limit、稳定排序、upsert 幂等+旧文本消失、remove 幂等、relocate 身份保持、rebuild 一致、跨 Vault 与状态机；语料覆盖 §10.7 分布（中文/英文/混合/多标签/长短文/深目录/重复高频词/emoji/code/links/tables）。内存参照实现 `src/infrastructure/memory/fullTextSearchIndex.ts` 全绿。
- Benchmark（§10.7/§10.8/§18）：`fixtures/search/generator.mjs`（种子确定性，CLI 按需生成 1k/10k/50k，产物 `fixtures/search/generated/` 不入库）+ `src/infrastructure/memory/fullTextSearchIndex.perf-wallclock.test.ts`（npm run test:perf，输出 §18 JSON 形状）。**开发机基线（内存参照实现）**：1k build 24ms / query p50 1.32ms p95 2.58ms / upsert 0.31ms；10k build 210ms / query p50 16.6ms p95 19.39ms / upsert 0.27ms——远在 §10.8 目标区间内（SQLite 实现基线在 Stage 4/6 补测回写）。
- **偏差 1**：§10.7 的 `fixtures/search/1k|10k` 目录不入库（11k 文件的提交体积不可接受）——改为确定性生成器按需产出 + 契约套件内置 14 篇精选语料覆盖同一分布，语义验收不依赖大体积 fixture。
- **偏差 2**：port 形状相对 §10.5 建议有两处调整——`rebuild(vaultId, documents?)`（调用方供给真实数据源快照，Main 批量索引实现可忽略自读）；`getStatus` 为同步签名（IPC 实现以 Renderer 侧镜像满足）；`remove/relocate` 入参为对象（与既有 IPC 契约风格一致）。

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

  matchedField: "title" | "tag" | "body";

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

---

# 11. Stage 4：Desktop Search Database + Full Text

**状态：已完成（2026-08-22）**

实际实现与偏差记录：

- 技术选型（§11.1）：**node:sqlite 成立**——Electron 43 内置 Node 24.18.1，`node:sqlite` + FTS5 实测可用（本机 Node v24.15.0 同验）；零 native addon，esbuild platform:node 自动 external（无需改构建配置）。
- Main（`electron/main/search/`）：`DesktopSearchDatabase.ts`（index_meta + notes + notes_fts；schema/index_format_version 不兼容 → 备份 `.corrupt-<ts>` 整库重建；损坏同理自愈；候选 = title/tags 归一化 LIKE + body FTS5 MATCH，评分/snippet/排序全量复用 `shared/search/textMatch` 的 scoreDocument——与内存参照实现逐点一致）+ `DesktopSearchIndexer.ts`（scanVault → readNoteFile → Frontmatter/plainText 提取 → 200 篇/事务分批 upsert，批间让出事件循环；单篇读失败跳过不阻断）。
- 中文（§11.4）：方案 B 落地——body 词元流为 CJK unigram+bigram；emoji 等非词字符编码 `u<码点hex>` 词元保证 FTS 可检索（unicode61 不为 emoji 建词，契约用例暴露后修复）；MATCH 表达式 CJK 引号 AND、纯拉丁词前缀。
- DB 位置（§11.2）：`userData/search-index/<vaultId>.sqlite`；transient:<uuid> 等非常规 id 走确定性 sha1 哈希文件名（路径不可逃逸，handler 测试暴露后修复）。
- IPC（`search.query/rebuild/upsert/remove/relocate/status`）：upsert 为「Main 读盘解析」（Renderer 不传正文）；remove/relocate 按路径定位（文件已消失也可维护）；transient 仅预览允许（只读派生能力）。
- Renderer（R8-04）：`DesktopSearchIndex`（FullTextSearchIndex port IPC 实现——稳定键 → 会话 id 经 Adoption 别名翻译；状态镜像 + refreshStatus）+ `AppServices.fullTextSearch` 可选字段 + `SearchQueryService` 优先消费（ready 时；building/degraded/missing 回退既有标题索引/全量扫描，§20 搜索可降级）。
- 契约双实现：SQLite 实现与内存参照实现跑同一契约套件（16 例）全绿——含中文子串/跨词 AND/拉丁前缀/emoji/评分排序/幂等/relocate/rebuild。
- 测试：DB 单测 6 例（损坏自愈/版本不兼容/按路径维护/FTS 编码/管理器）+ Indexer 3 例 + IPC handler 4 例（含 transient/schema/全链路）+ Renderer 适配 5 例 + SearchQueryService 集成 3 例 + 桥形状断言（preload + desktop.smoke）。
- **偏差**：§17.4 G14–G16（title/body/中文搜索 E2E）依赖「无索引自动 rebuild」入口（§11.5 的 rebuilding 流程），随 Stage 5/6 的会话接线一并落地；本阶段索引重建经 search.rebuild IPC 显式驱动。

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

**状态：已完成（2026-08-22）**

实际实现与偏差记录：

- 数据流（§12.2/R8-05）：`DesktopSearchIndexReconciler`（`src/platform/desktop/`）订阅 `DesktopExternalVaultChangeService` 归一化事件（装配根 `createDesktopRuntime` 接线）——Watcher 只发事实，索引语义全在 reconciler。
- 事件行为（§12.3）：created/modified → `search.upsert`（Main 读盘解析；**versionToken 未变即跳过写入**——DB.upsert 内置去重，modified 同令牌 no-op）；moved → `search.relocate`（事件 from/to 路径，身份保持——`relocateByPath` UPDATE 不重读文件）；deleted → `search.remove`（**新增 noteKey 通道**：stable id / Adoption 别名解析出的 stableNoteId 直删 note_key，path 身份按 relativePath）。
- 自写（§12.4）：`DesktopTitleSearchIndex` 新增 `onCommitted` 钩子——`DocumentCommitService` 的 commit/replaceContent（→ updateText）与 createWithContent（→ upsertDocument）成功后通知 reconciler 做 best-effort `search.upsert`；索引维护不依赖 watcher 自写抑制路径，不会漏更新。
- 首次建库（§11.5）：port 新增 `prepare(vaultId)`（契约补充，Stage 3 冻结后增补，见偏差）——`ExternalVaultChangeBridge` 在 vaultId 生效时调用：refreshStatus → missing 即 rebuild（building 先行，期间 SearchQueryService 回退标题索引，页面树与编辑器先用不阻断）；reconciler 应用事件前同样先 prepare。
- 失败降级（§12.5/R8-06）：任何索引动作失败 → `markDegraded`（status=degraded）+ 每库一次 30s 防抖延迟 rebuild；reconcile/onDocumentCommitted 绝不向上抛错，正文保存不受影响（测试锁定：失败后 status=degraded、调度 rebuild 后回 ready）。
- E2E（§17.4）：`desktop.search.spec.ts`——@golden G14 title / G15 body / G16 中文正文（打开 Vault 自动 prepare → 搜索面板可见结果）、G17 外部编辑 → watcher → 新正文可搜索（IPC 层轮询索引 + UI 断言）、G18 外部删除 → 结果消失。
- **偏差 1**：FullTextSearchIndex port 在 Stage 3 冻结后增补 `prepare(vaultId)`（§11.5 自动建库的运行时入口；内存实现 no-op）；契约套件 16 例不受影响，接口增补已同步 shared/search 与 application 重导出。
- **偏差 2**：modified 的 versionToken 比较下推到 Main DB.upsert（读盘即得令牌，避免「相同也重写 FTS」的无效写），而非 Renderer 侧预比较——语义等价且省一次往返。
- **偏差 3**：G17 的 UI 断言前先经 `search.query` IPC 轮询索引就绪——watcher 链路（chokidar 200ms + coalesce 150ms + 静止窗口 200ms + rescan）总延迟超过搜索面板单次防抖窗口，一次性 fill 无法等待；数据层与 UI 层分开断言更诚实。

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

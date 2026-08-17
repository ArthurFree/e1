# R007：Desktop Local Vault 产品化基础闭环

- **版本**：0.1
- **状态**：实现中（阶段 0–3 已完成）
- **更新时间**：2026-08-17
- **基线 Commit**：`623f5292c290d0843d8e7eb72a7ce11bbaf22d06`
- **前置阶段**：R006（Electron Desktop 本地 Vault 技术验证版）
- **目标分支**：建议从 `main` 建立独立 R007 feature branch，按阶段提交，不一次性大改

---

## 1. 背景

R006 已经证明 E1 的双 Runtime 架构可行：

- Web 以 IndexedDB + Tiptap JSON 为真实数据源；
- Desktop 以本地 Markdown + Vault 文件夹为真实数据源；
- Renderer 不接触绝对路径；
- Desktop 已真实支持 Vault 打开/扫描、Markdown 读取、文档创建、安全保存；
- 保存复用共享 `DocumentSaveCoordinator`；
- Desktop 已具备 Source Gate / Output Gate / Stable ID Adoption；
- 图片与附件可保存到 Vault `assets/`，Markdown 使用相对路径；
- Web / Desktop 已通过同一 `AppServices`、commands / queries 和 port 体系装配；
- `desktopExtras` 已删除，替换为平台无关 `vaultMaintenance` / `documentSafety` port；
- Web IndexedDB 实现已经归入 `src/platform/web/persistence/`；
- MainArea 已拆为 DocumentScreen / hooks / EditorShell；
- CI 已拆为 quality / build-web / build-desktop / e2e-web / e2e-desktop。

因此 R007 不再承担“验证 Electron 是否可行”的职责，而是回答：

> E1 Desktop 是否可以成为单窗口、本地优先 Markdown 用户的日常主力编辑器，同时继续允许 VS Code / Typora / Obsidian 等外部程序共同修改 Vault？

---

## 2. 当前基线与遗留缺口

### 2.1 已真实能力

当前 Desktop capability：

```ts
{
  localDirectory: true,
  fileWatching: false,
  revealInFileManager: false,
  nativeMenu: false,
  nativeSecrets: false,
  persistentAssetPaths: true,
  documentPersistence: true,
}
```

当前已经可工作的核心链路：

```text
选择 / 打开 Vault
→ 扫描 Markdown
→ 页面树
→ 打开文档
→ MarkdownCodec.parse
→ Tiptap 编辑
→ SaveCoordinator
→ MarkdownCodec.serialize
→ note.save
→ AtomicFileWriter
→ Markdown 落盘
```

附件链路：

```text
选择文件
→ authorized-ref
→ asset.import
→ Vault/assets/
→ 编辑器节点
→ Markdown 相对路径
→ 重启 Hydration
```

### 2.2 当前仍未完成的 Desktop 行为

`DesktopWorkspaceRepository`：

- rename workspace：未实现；
- update workspace：未实现；
- favorite workspace：未实现。

`DesktopPageRepository`：

- 创建 document：已实现；
- 创建 group / 目录：未实现；
- rename page：未实现；
- favorite page：未实现；
- move：未实现；
- remove / restore / purge / purgeTrashed：未实现；
- page-level lastOpened：仅会话内，不持久。

`DesktopTagRepository`：

- 标签读取：已实现；
- create tag：未实现；
- remove tag：未实现；
- setPageTags：未实现。

其他：

- Desktop RevisionRepository 仍为空实现；
- Desktop 搜索仍为 title-only；
- 外部文件修改没有实时 watcher；
- AI API Key 使用内存 SecretStore，重启丢失；
- reveal in file manager 未实现；
- native menu 未实现；
- 安装器 / 签名 / 自动更新未实现。

### 2.3 当前 CI 前置问题

R007 开始前必须保证 `main` 全绿。

当前基线提交的：

- quality：通过；
- build-web：通过；
- build-desktop：通过；
- e2e-web：通过；
- e2e-desktop：2/3 通过。

失败原因不是产品逻辑，而是 Playwright selector：

```ts
getByLabel("插入")
```

同时匹配：

```text
插入
插入表情
```

应改为：

```ts
getByRole("button", { name: "插入", exact: true })
```

R007 不在红色基线上开发。

---

# 3. R007 产品目标

R007 的目标不是一次补齐 Web 全部 parity，而是把 Desktop 推到“可日用的本地 Markdown 编辑器”。

必须完成四个闭环：

## G1：文档元数据可安全修改

用户可以：

- 修改标题；
- 修改标签；
- 收藏文档 / Vault；
- 重启后状态保持；
- 不因为修改标题 / 标签而覆盖正文或绕过乐观锁。

## G2：外部文件修改可正确感知

当 VS Code / Typora / Obsidian 修改 Vault 时：

- 页面树能刷新；
- 新文件出现；
- 删除文件消失；
- 重命名 / 移动尽可能按 stable note id 识别；
- 当前文档无本地修改时可自动重载；
- 当前文档有本地修改时进入明确冲突状态；
- E1 自己写文件不会产生 watcher 回声循环。

## G3：Desktop 机密配置可持久

AI API Key：

- 不存 Markdown；
- 不存 Vault；
- 不存 localStorage；
- 使用系统安全存储；
- 系统安全存储不可用时明确降级，不伪装为安全。

## G4：现有 UI 不再暴露“点了才 NOT_IMPLEMENTED”的动作

规则：

> 已显示给 Desktop 用户的主操作，要么真实可用，要么通过 capability / operation support 明确隐藏或降级。

---

# 4. 明确非目标

R007 不做：

- 多窗口；
- 云同步；
- 多设备同步；
- Git 集成；
- 插件系统；
- 实时多人协作；
- 原生菜单完整体系；
- 系统托盘；
- 自动更新；
- 正式代码签名；
- 完整 Web/Desktop 功能 1:1 parity；
- SQLite 作为正文存储；
- 页面数据库 / Notion database；
- 自定义目录排序 `.e1/tree.json`；
- 自动批量重写所有第三方 Markdown 链接；
- Desktop 完整版本历史。

全文搜索和正式安装包可作为 R007 后段可选项；如果主线延期，独立进入 R008。

---

# 5. 架构原则

继续保持既有 DUAL 不变量。

新增 R007 不变量：

## DSK-01：Watcher 只产生事实，不直接修改 UI

```text
Filesystem Watcher
→ ExternalChangeEvent
→ Application reconciliation
→ cache/index invalidation
→ query refresh
→ React state
```

禁止：

```text
Electron Main
→ 直接控制 React state
```

## DSK-02：Renderer 永远不接触 absolutePath

所有新增 IPC 参数继续使用：

```text
vaultId
relativePath
noteId
assetId
```

禁止新增：

```ts
fs.readFile(absolutePath)
shell.showItemInFolder(absolutePathFromRenderer)
```

## DSK-03：Metadata 写入不得绕过版本控制

标题 / 标签更新必须：

```text
读取当前磁盘版本
→ expectedVersion 校验
→ 修改 Frontmatter
→ Atomic Write
→ 返回新 versionToken
```

如果当前编辑器已打开，必须同步推进该 Document Session 的 loaded version。

## DSK-04：Watcher 回声必须抑制

E1 自己写盘：

```text
note.save
→ watcher event
```

不能再触发：

```text
reload
→ save
→ watcher
→ reload
```

必须通过：

- versionToken/hash；
- recent self-write registry；
- event coalescing；

识别自写事件。

## DSK-05：Stable ID 优先于路径

外部 rename / move：

```text
same frontmatter id
different relativePath
```

解释为：

```text
MOVE / RENAME
```

而不是：

```text
DELETE + CREATE
```

没有 stable id 时才回退 path identity。

## DSK-06：索引永远可重建

任何 Desktop 搜索 / metadata cache：

```text
删除数据库 / cache
→ 从 Vault Markdown 重建
```

正文真相始终是 Markdown。

---

# 6. 阶段拆分

建议 R007 分 6 个阶段，不要一次性大提交。

---

## 阶段 0：基线与契约冻结

**状态：已完成（2026-08-14）**

实际偏差记录：

1. E2E selector 修复（`e2e/desktop.assets.spec.ts` 改 `getByRole("button", { name: "插入", exact: true })`）后，E2E-01 仍失败——暴露出 selector 之下掩盖的真实缺陷：重启后打开含图文档，图片节点视图随 EditorView 创建同步装配，早于 `DocumentEditor` useEffect 的 `storage.assetServices` 注入，首屏一律误报「图片不可用」。修复为在 `onBeforeCreate` 中提前注入（`DocumentEditor.tsx`），并新增组件回归测试（无修复时变红，已验证）。
2. §2.2 未实现操作的 NOT_IMPLEMENTED 契约断言在 `src/platform/desktop/repositories.test.ts` 已齐备（workspace/page/tag/revision/lastOpened no-op），无需新增。
3. `docs/requirements/README.md` 索引补齐 R003–R007；R006 标记待验收，不再开 R006-C6。
4. 已知遗留：`npm test` 存在偶发未捕获异常（react-dom 调度器在 jsdom 拆除后回调，`window is not defined`，源自组件测试拆除时序，非本次改动引入），出现时 vitest 退出码为 1 但全部用例通过；重跑即绿。根治留待后续批次。

本地等价验证（对应 5 个 CI job）全绿：`npm run ci`（1018 测试）、`build:web`、`build:desktop`、`e2e/app.spec.ts + responsive.spec.ts`（24 例）、`test:e2e:desktop:golden`（3 例）。

### 目标

建立可持续开发的全绿基线。

### 工作

1. 修复 Desktop golden E2E selector。
2. 确认 5 个 CI job 全绿。
3. 为 Desktop repository 未实现操作增加明确 contract tests。
4. 更新 `docs/requirements/README.md`，补齐 R003–R007 索引。
5. R006 标记为已完成 / 待验收，不再继续往 R006-C6 塞新需求。

### DoD

```text
quality        green
build-web      green
build-desktop  green
e2e-web        green
e2e-desktop    green
```

---

## 阶段 1：Document Metadata Write Pipeline

**状态：已完成（2026-08-14）**

实际实现与偏差记录：

- IPC：`note.patchMetadata({vaultId, relativePath, expectedVersionToken, patch:{title?, tags?}})` → `{versionToken, updatedAt, stableNoteId}`（`shared/ipc/contracts.ts` + `schemas.ts` 校验，patch 至少含一键）。
- Main：`electron/main/filesystem/NoteMetadataFileSystem.ts`——readNoteFile 全套校验 → 令牌比对 → 只改 title/tags（id/created/aliases/未知键/正文逐字节保留，BOM/CRLF 跟随）→ AtomicFileWriter 二次校验 + 原子替换。冲突直接复用 `DOCUMENT_CONFLICT`（未新增 NOTE_METADATA_CONFLICT，§11 原则：UI 无需分流）。
- Renderer：`DesktopNoteMetadataService`（乐观锁起点：已打开文档取 Source Cache，未打开先 note.read）→ IPC → Source Cache 同步（metadata + versionToken，保证下一次 autosave 序列化出新元数据）→ `DocumentVersionChannel.publish` → 扫描缓存失效。`DesktopPageRepository.rename` / `DesktopTagRepository.setPageTags` 接入。
- 版本推进（§1.4）：`DocumentVersionChannel` port（`application/services/`，内存实现双端共用）加入 AppServices；`DocumentEditor` 订阅推进协调器版本，惰性创建协调器时经 `latest()` 取起点——「先改名后编辑」时序亦覆盖。
- 标签模型（§1.5）：`create` 合成不持久化标签（持久化在随后的 setPageTags）；颜色按名称哈希确定性派生（`deterministicTagColor`，替代 R006 的固定灰 DESKTOP_TAG_COLOR）；`remove` 维持 NOT_IMPLEMENTED 至阶段 4。
- 测试：Main 6 例（保留语义/BOM/CRLF/冲突/路径）、schema 校验 3 例、Renderer 契约 6 例、DocumentEditor 版本推进组件测试 1 例、桌面 golden E2E G04（rename 重启保持）/G05（tag 重启保持）2 例。

### 目标

安全实现：

- rename document；
- setPageTags；
- persisted metadata；
- 不覆盖正文；
- 不制造假冲突。

### 1.1 新增 Main 能力

推荐新增业务 IPC：

```ts
note.patchMetadata({
  vaultId,
  relativePath,
  expectedVersionToken,
  patch: {
    title?: string,
    tags?: string[],
  }
})
```

返回：

```ts
{
  versionToken: string,
  updatedAt: number,
  stableNoteId?: string
}
```

禁止暴露通用：

```ts
readFile/writeFile
```

### 1.2 Main 实现

新增：

```text
electron/main/filesystem/
└── NoteMetadataFileSystem.ts
```

职责：

```text
PathGuard
→ read file
→ expected hash check
→ preserve BOM
→ preserve line endings
→ parse Frontmatter
→ patch known keys
→ preserve unknown Frontmatter
→ AtomicFileWriter
→ new SHA-256 versionToken
```

### 1.3 Renderer adapter

修改：

```text
DesktopPageRepository.rename
DesktopTagRepository.setPageTags
```

使其调用 `note.patchMetadata`。

### 1.4 Version 推进问题

这是本阶段最重要的技术点。

Metadata 写盘后，当前 DocumentSaveCoordinator 的 `knownVersion` 必须推进。

建议新增 application port：

```ts
interface DocumentVersionChannel {
  publish(pageId: string, version: ContentVersionToken): void;
  subscribe(
    pageId: string,
    listener: (version: ContentVersionToken) => void,
  ): () => void;
}
```

`DocumentEditor` / `DocumentSession`：

```text
metadata saved
→ DocumentVersionChannel
→ coordinator.setLoadedVersion(newVersion)
```

这样下一次正文 autosave 不会拿旧 token 制造假冲突。

不要让 `DesktopContentRepository.save()` 偷偷忽略 SaveCoordinator 传入的 expectedVersion。

### 1.5 标签模型

Desktop tags 真相：

```text
Markdown Frontmatter tags
```

Tag color 不属于 Markdown 标准数据。

R007 建议：

```text
Tag.name → Markdown
Tag.color → E1 local metadata
```

颜色先使用稳定 hash 派生色，避免立刻增加额外持久化格式：

```text
color = deterministicColor(tagName)
```

本阶段：

- `setPageTags`：实现；
- `create tag`：可视为“给页面加入新字符串标签”；
- `remove tag`：定义为从所有笔记 Frontmatter 移除，属于批量写，放到阶段 4。

### 验收

- 修改标题后重启仍存在；
- 修改标签后外部文本编辑器能直接看到 Frontmatter；
- 修改标题时正文不变；
- 正文 dirty 状态下修改标题，再 autosave 不出现假冲突；
- 外部已经修改文件时 metadata patch 正确进入 DOCUMENT_CONFLICT。

---

## 阶段 2：Desktop Local Metadata Store

**状态：已完成（2026-08-14）**

实际实现与偏差记录：

- IPC：采用推荐的 `vaultState.get(vaultId)` / `vaultState.patch({vaultId, patch})` 形状（局部合并：缺省键保留、显式 null 清空、空补丁不建条目），返回合并后完整状态供 Renderer 镜像对账；`shared/ipc/schemas.ts` 逐字段校验（非负整数毫秒时间戳或 null）。
- Main：`electron/main/state/DesktopVaultStateStore.ts`——落 `userData/vault-state/<vaultId>.json`（vaultId 文件名片段白名单校验防路径逃逸），容错与 VaultRegistry 同口径（缺失空表、损坏备份 `.corrupt-<ts>` 后自愈、畸形页面条目逐条丢弃、tmp+rename 原子写）。handler 只校验注册表登记、**不做目录可达性复查**（目录暂不可访问不应拖垮列表）；transient 仅预览会话短路（get 空表、patch 不落盘）。
- Renderer：`DesktopVaultStateClient`（会话内缓存 + transient 内存镜像；get 失败降级空表并告警——读路径不被状态故障拖垮；patch 失败原样抛出，与 Web 仓储写失败语义一致）。`DesktopWorkspaceRepository.setFavorite` / `DesktopPageRepository.setFavorite/setLastOpened` 接通；`list`/`listByWorkspace`/`listAll`/`trackOpened` 合并 state 映射 favoriteAt/lastOpenedAt。
- Adoption 键迁移以「读兜底 + 写清空」实现（`pageStateOfEntry` stable 键优先、path 键兜底；写入已知 stableNoteId 时同请求清空旧 path 键），而非显式迁移流程——效果等价且无额外时序耦合。
- `DesktopPageRepository.setLastOpened` 写失败只告警不抛出（fire-and-forget 非关键路径，与阶段 0 的 no-op 约定兼容）。
- 测试：store 9 例 + handler 4 例 + schema 3 例 + Renderer 5 例（含 transient 不发起 IPC、path 键、迁移清空）+ preload 透传；桌面 golden E2E G06（收藏重启保持 + Markdown 逐字节不变）/G07（最近重启保持）2 例。
- 偏差 1：修复阶段 1 引入的 CI flake——`DocumentEditor.test.tsx` 版本推进用例在慢机上「发布落在于飞保存完成之前、被保存结果覆盖」，改为经 `onSaveStateChange` 等待「saving 之后的 saved」再发布（本地连跑 6/6 通过）。
- 偏差 2：`desktop.saving`/`desktop.assets` 4 例（E2E-03/04、外部修改冲突、新建文档）在 macOS 本地确定性失败（strict mode 双匹配等时序问题），已用 HEAD 源码 + HEAD 产物复现确认**非本阶段引入**（CI xvfb 的 e2e-desktop 任务为绿）；属阶段 0 遗留的本地环境差异，本阶段不处理。
- 偏差 3：`desktop.smoke` 的桥形状断言补齐 vaultState 组（顺带补齐阶段 1 漏更的 patchMetadata/asset.read——该用例不在 golden 集合，阶段 1 本地未跑到）。

### 目标

实现不应该进入 Markdown 的 E1 状态：

- favoriteAt；
- page lastOpenedAt；
- workspace favorite；
- UI 辅助状态。

### 存储位置

推荐：

```text
userData/
└── vault-state/
    └── <vaultId>.json
```

不要写入：

```text
Markdown Frontmatter
```

原因：

- 收藏/最近是设备级交互状态；
- 不属于用户 Markdown 内容；
- 不应该让第三方工具看到；
- 不必参与 Vault portable truth。

建议格式：

```json
{
  "version": 1,
  "pages": {
    "<stableNoteId>": {
      "favoriteAt": 1786600000000,
      "lastOpenedAt": 1786601000000
    }
  },
  "workspace": {
    "favoriteAt": null
  }
}
```

无 stable id 的 path note：

```text
key = path:<normalizedRelativePath>
```

Stable ID Adoption 后迁移 key。

### 新增

```text
electron/main/state/DesktopVaultStateStore.ts
```

IPC 推荐：

```text
vaultState.get
vaultState.patch
```

或者将其完全封装在 Main 的业务 API 中。

### Renderer

实现：

```text
DesktopWorkspaceRepository.setFavorite
DesktopPageRepository.setFavorite
DesktopPageRepository.setLastOpened
```

### 验收

- 收藏文档重启保持；
- 最近文档重启保持；
- 不修改 Markdown；
- Vault 被复制到另一台机器不会携带本机最近记录；
- state 文件损坏自动自愈，不影响 Vault 打开。

---

## 阶段 3：External Change Watcher

**状态：已完成（2026-08-17）**

实际实现与偏差记录：

- Main（`electron/main/watcher/`）：`VaultWatcher`/`VaultWatcherService`（chokidar 4，`ignoreInitial` + `awaitWriteFinish` 200ms，scan 成功后按 vaultId 幂等启动，transient 同监听，before-quit 关闭）+ `WatchEventCoalescer`（150ms 静止窗口去重合并，单批超 500 降级 rescan-required）+ `SelfWriteRegistry`（TTL 10s，note 按落盘 sha256 比对消费一次回声，asset import 无 token 按路径+有效期抑制）。
- 忽略规则：`.` 开头段（天然覆盖 AtomicFileWriter 临时文件）放行 `.e1/vault.json`；`node_modules`、`*.tmp`。受管 assets 目录下变化归 `asset-changed`；vault.json 变化整批降级 rescan-required。
- 自写登记挂点：`note.create/save/patchMetadata` 与 `asset.import` 成功后 record；watcher 启动失败/error 只 console.warn + rescan-required，handler 永不 throw 口径不变。
- IPC：首个 Main→Renderer 单向通道 `events:vaultChanges`（payload 为 `VaultFsEvent[]` 批次，只含 vaultId+relativePath）；preload `events.subscribeVaultChanges`（schema 校验后投递，非法批次丢弃）。
- Renderer（§3.3）：`application/services/ExternalVaultChangeService` 契约 + `platform/desktop/DesktopExternalVaultChangeService`（200ms 静止窗口 → 按 vault 串行 scan 旧快照/rescan 新快照 → stable-id diff + watcher 事实归并 → created/modified/moved/deleted；asset-changed/rescan-required 只触发重扫不通知）。**偏差 1**：`modified` 不携带 versionToken——消费方（reload/冲突面板）一律经 getContent/openDocument 重读磁盘拿新令牌，事件带令牌只会过期。
- 当前文档策略（§3.4）：clean+modified/moved 自动重载 + 5s 轻量提示；dirty 复用冲突面板；clean+deleted 正文区替换为「源文件已被删除」错误块（重新扫描/返回知识库）；dirty+deleted 保留编辑器内存 + 另存副本/复制出口；同 stable id 外部重建（created 命中删除态）按外部修改处理。**偏差 2**：`DocumentScreen` 幽灵页保活——外部删除当前文档后 pages 镜像移除该页，保留最后一个已知 page 对象让会话/编辑器/错误块继续工作（E2E 暴露的原始缺口：直接落空态导致错误块不可达、dirty 内存被卸载）。
- moved 发布前同步 `DesktopDocumentSourceCache.updateRelativePath`（含 Adoption 别名的 path:* 缓存键），避免下次保存写回旧路径。
- 能力（§3.6）：`desktopCapabilities.fileWatching` 翻 true；`capabilities.matrix.test` 与 `docs/architecture/runtime-boundaries.md` 同步。
- 测试：watcher 单测 34 例 + 真 chokidar 集成 5 例；Renderer 服务 16 例；文档策略组件测试 7 例（含幽灵页回归）；桌面 E2E `desktop.watcher.spec.ts` 9 例覆盖验收 1–7（含扩展的 dirty 删除与复苏场景）全绿。**已知不绿**：`desktop.assets` E2E-03/04 与 `desktop.saving` 新建文档 3 例在阶段 3 之前的基线提交上即失败（环境相关，基线对照实验证实），非本阶段引入，待单独排查。

### 目标

让“本地 Markdown 是真相”真正成立。

### 3.1 Main Watcher

推荐新增：

```text
electron/main/watcher/
├── VaultWatcher.ts
├── WatchEventCoalescer.ts
└── SelfWriteRegistry.ts
```

可以使用：

```text
chokidar
```

而不是在第一版自己处理不同系统 `fs.watch` 的大量边缘差异。

监听：

```text
*.md
assets/**
.e1/vault.json
```

忽略：

```text
.e1/trash/**
.e1/tmp/**
*.tmp
AtomicFileWriter 临时文件
```

### 3.2 IPC 事件

现有 IPC 主要 request/response。

新增单向事件：

```ts
type VaultFsEvent =
  | { type: "note-created"; vaultId; relativePath }
  | { type: "note-changed"; vaultId; relativePath }
  | { type: "note-removed"; vaultId; relativePath }
  | { type: "asset-changed"; vaultId; relativePath }
  | { type: "rescan-required"; vaultId };
```

Preload：

```ts
window.e1.events.subscribeVaultChanges(...)
```

仍然只传相对路径。

### 3.3 Renderer reconciliation

新增 application service：

```text
ExternalVaultChangeService
```

职责：

```text
batch events
→ invalidate DesktopVaultScanCache
→ rescan
→ old snapshot vs new snapshot
→ stable id diff
→ publish normalized change
```

推荐 normalized event：

```ts
type ExternalDocumentChange =
  | { type: "created"; pageId }
  | { type: "modified"; pageId; versionToken }
  | { type: "moved"; pageId; from; to }
  | { type: "deleted"; pageId };
```

### 3.4 当前文档策略

#### Clean document

外部修改：

```text
auto reload
```

显示轻量提示：

```text
“文件已由其他程序更新”
```

#### Dirty document

外部修改：

```text
不自动 reload
→ remoteConflict
→ 冲突面板
```

复用当前已有：

```text
重新载入
另存副本
强制覆盖
复制当前内容
```

#### 外部删除

```text
当前文档 dirty
→ 保留编辑器内存
→ 提示“源文件已删除”
→ 允许另存副本

当前文档 clean
→ 错误块
→ 重新扫描 / 返回知识库
```

### 3.5 Self-write suppression

`note.save / patchMetadata / asset.import` 成功后：

```text
SelfWriteRegistry.record({
  vaultId,
  relativePath,
  versionToken,
  expiresAt
})
```

Watcher 收到事件：

```text
hash == recent self write
→ consume / ignore reload
```

但仍允许：

```text
invalidate derived scan/index
```

### 3.6 capability

阶段完成后：

```ts
fileWatching: true
```

同步更新：

- desktopCapabilities；
- runtime-boundaries；
- capability matrix test。

### 验收

至少 E2E：

1. E1 打开 clean 文档，外部写文件 → 自动刷新；
2. E1 有 dirty 内容，外部写文件 → 冲突，不覆盖本地；
3. 外部新增 `.md` → 页面树出现；
4. 外部删除 `.md` → 页面树消失；
5. 外部 rename stable-id 文件 → 仍是同一 pageId；
6. E1 自己 autosave → 不触发 reload loop；
7. 100 个短时间文件事件 → coalescing 后只触发有限次数 rescan。

---

## 阶段 4：文件操作闭环

### 目标

补齐现有 UI 中最影响日常使用的目录操作。

优先级：

```text
P0 delete / restore
P0 new group
P1 move document
P1 rename group
P2 rename physical markdown filename
```

### 4.1 新建 Group

映射：

```text
Group = real directory
```

IPC：

```ts
vault.createDirectory({
  vaultId,
  parentRelativePath,
  name
})
```

要求：

- PathGuard；
- deterministic name collision；
- 禁止 `.e1` / `assets` 等保留目录冲突。

### 4.2 删除与恢复

使用 R006 已规划但未落地的：

```text
Vault/.e1/trash/
```

推荐：

```text
.e1/trash/<operationId>/
├── payload/...
└── meta.json
```

`meta.json`：

```json
{
  "version": 1,
  "deletedAt": "...",
  "originalRelativePath": "学习/React.md",
  "stableNoteId": "..."
}
```

删除必须：

```text
rename/move
```

而不是直接 unlink。

恢复：

```text
original path available
→ restore original

collision
→ deterministic renamed restore
```

永久删除才物理删除。

### 4.3 Move

第一版只支持：

```text
document → directory
```

不支持任意自定义排序。

Stable ID 不变。

必须检测：

- source exists；
- destination inside Vault；
- destination not `.e1` / assets；
- collision；
- symlink escape。

相对 Markdown 链接：

R007 不承诺全库自动重写第三方链接。

移动前若检测当前文档存在相对本地链接，可弹提示：

```text
“移动文件可能影响其他 Markdown 文件中的相对链接。”
```

### 4.4 rename

区分两个概念：

```text
Title rename
!=
File rename
```

R007 必须支持 Title rename。

Physical file rename 可以放阶段 4 尾部，UI 必须明确叫：

```text
“重命名文件”
```

而不是和标题混在一起。

### 验收

- 新建分组；
- 删除 → 回收站；
- 恢复；
- 永久删除；
- 移动文档；
- 重启后路径正确；
- stable note id 不变；
- 无 Vault 外路径逃逸。

---

## 阶段 5：Native Secret Store + Reveal

### 5.1 DesktopSecretStore

实现现有：

```ts
SecretStore
```

不要新增 UI 专属 API。

Main 使用 Electron：

```text
safeStorage
```

推荐存储：

```text
userData/secrets.json
```

其中 value 必须是 `safeStorage.encryptString()` 结果的 base64。

IPC：

```text
secret.get
secret.set
secret.delete
```

Renderer 只看 SecretStore。

如果：

```ts
safeStorage.isEncryptionAvailable() === false
```

则：

- `nativeSecrets = false`；
- 默认不持久化 API Key；
- UI 提示“系统安全存储不可用，本次会话使用”。

不能偷偷明文落盘。

完成后：

```ts
nativeSecrets: true
```

仅在当前系统运行时确认可用时成立。

### 5.2 Reveal in File Manager

新增业务 IPC：

```ts
note.reveal({ vaultId, relativePath })
asset.reveal({ vaultId, assetId })
```

Main：

```text
resolve authorized path
→ PathGuard
→ shell.showItemInFolder
```

Renderer 不拿绝对路径。

完成后：

```ts
revealInFileManager: true
```

### 验收

- AI key 重启保持；
- secrets 文件不可直接看到明文 key；
- safeStorage 不可用时不明文降级；
- “在文件管理器中显示”可以定位 note / asset；
- malformed relative path 被拒绝。

---

# 7. 搜索策略

R007 不建议立刻进入 SQLite FTS，除非阶段 1–5 全部稳定。

当前 title-only search 是明确的技术债，但优先级低于：

```text
外部修改不丢数据
标题/标签能保存
删除能恢复
API Key 不丢
```

建议将全文搜索独立为：

```text
R008：Desktop Search & Scale
```

R008 再评估：

- SQLite FTS5；
- `node:sqlite`；
- incremental indexing；
- link graph；
- backlinks；
- 10k / 50k note benchmark。

保持：

```text
SQLite = derived index
Markdown = source of truth
```

---

# 8. Revision 策略

R007 不实现完整 Desktop 版本历史。

原因：

Desktop Markdown 本身可能已经由：

- Git；
- Time Machine；
- OneDrive；
- Dropbox；
- 系统备份；

承担历史。

当前 `DesktopRevisionRepository` 可以继续 no-op，但 UI 必须：

```text
capability / operation support
→ 隐藏版本历史入口
```

不要显示空版本列表让用户误以为“有版本功能但没有记录”。

正式 Desktop revision 可独立进入后续需求。

---

# 9. Operation Support：不要继续滥用 RuntimeCapabilities

当前 RuntimeCapabilities 是平台级粗能力：

```text
fileWatching
nativeSecrets
...
```

R007 不建议为：

```text
canRename
canDelete
canMove
canTag
...
```

每个动作继续增加 boolean。

建议新增 operation support：

```ts
export interface RuntimeOperations {
  workspace: {
    rename: boolean;
    favorite: boolean;
  };
  page: {
    createDocument: boolean;
    createGroup: boolean;
    renameTitle: boolean;
    renameFile: boolean;
    move: boolean;
    trash: boolean;
    restore: boolean;
    purge: boolean;
    favorite: boolean;
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

放入：

```ts
AppServices.operations
```

作用：

```text
UI 是否显示操作
```

而 `RuntimeCapabilities` 继续表示：

```text
底层平台能力
```

这样避免 capability matrix 膨胀成几十个字段。

原则：

```text
Capability = runtime 能做什么
Operation  = 当前产品允许用户做什么
```

---

# 10. 推荐目录结构

新增后建议：

```text
electron/
└── main/
    ├── filesystem/
    │   ├── NoteFileSystem.ts
    │   ├── NoteMetadataFileSystem.ts
    │   ├── VaultFileSystem.ts
    │   ├── AssetFileSystem.ts
    │   └── AtomicFileWriter.ts
    │
    ├── watcher/
    │   ├── VaultWatcher.ts
    │   ├── WatchEventCoalescer.ts
    │   └── SelfWriteRegistry.ts
    │
    ├── state/
    │   ├── DesktopVaultStateStore.ts
    │   └── DesktopSecretPersistence.ts
    │
    └── ipc/
        ├── note.ts
        ├── vault.ts
        ├── asset.ts
        ├── secrets.ts
        └── events.ts

shared/
├── ipc/
│   ├── channels.ts
│   ├── schemas.ts
│   └── events.ts
└── errors.ts

src/
├── application/
│   └── services/
│       ├── ExternalVaultChangeService.ts
│       └── DocumentVersionChannel.ts
│
└── platform/
    └── desktop/
        ├── repositories.ts
        ├── DesktopVaultScanCache.ts
        ├── DesktopDocumentSourceCache.ts
        ├── DesktopVaultStateClient.ts
        ├── DesktopSecretStore.ts
        └── DesktopFsChangeChannel.ts
```

---

# 11. 错误码

建议新增 / 明确：

```text
NOTE_METADATA_CONFLICT
VAULT_WATCH_FAILED
VAULT_PATH_COLLISION
VAULT_RESERVED_PATH
VAULT_TRASH_NOT_FOUND
VAULT_RESTORE_COLLISION
SECRET_STORAGE_UNAVAILABLE
REVEAL_TARGET_NOT_FOUND
```

尽量在 Application/UI 继续映射为既有：

```text
DOCUMENT_CONFLICT
PAGE_NOT_FOUND
WORKSPACE_NOT_FOUND
INVALID_INPUT
```

只有真正需要 UI 分流的错误才新增 DomainError code。

---

# 12. 测试计划

## Unit

Main：

- watcher coalescing；
- self-write suppression；
- metadata patch；
- trash move / restore；
- DesktopVaultStateStore 损坏恢复；
- secret encryption adapter；
- PathGuard。

Renderer：

- external change reconciliation；
- stable id rename diff；
- metadata version propagation；
- operation support。

## Contract

继续补：

```text
Web
Memory
Desktop
```

共享可复用部分。

不能要求 Desktop 强行满足 Web 的物理语义，例如：

```text
custom sibling position
```

合同测试要验证业务语义，不验证 IndexedDB 实现细节。

## Component

- dirty + external modification conflict；
- clean + external modification reload；
- operation support 隐藏 unsupported 按钮；
- title / tag persistence feedback。

## Desktop E2E Golden

R007 完成后 golden 至少：

```text
G01 open vault
G02 edit/save/restart
G03 image/save/restart
G04 rename title/restart
G05 tag/restart
G06 external edit clean → reload
G07 external edit dirty → conflict
G08 delete → restore
G09 AI key restart persistence
```

Golden 控制在约 8–12 条，其他边缘行为留 unit / component。

---

# 13. CI

建议最终：

```text
quality
build-web
build-desktop
e2e-web
e2e-desktop-golden
```

性能测试：

```text
test:perf
```

继续不作为普通 wall-clock hard gate。

可以增加非阻塞：

```text
perf-observation
```

上传 JSON artifact 记录趋势。

---

# 14. 性能预算

R007 watcher 引入后必须给预算。

建议目标，不作为 fake environment 单测 hard SLA：

```text
1000 Markdown 初始扫描：
目标 < 1s（开发机参考）

单文件 watcher event：
UI 树刷新感知 < 500ms

50 events burst：
coalesce 后 rescan <= 3 次

clean 当前文档外部修改：
1s 内完成 UI 更新

self-write：
0 次 editor reload
```

性能记录放真实 Electron sanity / benchmark。

---

# 15. 安全要求

必须保持：

```text
contextIsolation = true
sandbox = true
nodeIntegration = false
```

新增能力仍遵守：

```text
Renderer
→ business IPC
→ Main authorization
→ PathGuard
→ filesystem
```

Watcher 特别注意：

- symlink；
- Vault 外 rename；
- `.e1` 保留区；
- event path normalization；
- Unicode path；
- Windows separator；
- case insensitive filesystem；
- temporary file noise。

Secret：

- API Key 永不进 console；
- 永不进 error details；
- 永不进 Vault；
- 永不进 Playwright artifact。

---

# 16. 文档同步

阶段完成时必须同步：

```text
docs/requirements/r007-desktop-local-vault-productization.md
docs/requirements/README.md
docs/architecture/runtime-boundaries.md
docs/architecture/persistence.md
docs/architecture/document-write-path.md
docs/decisions.md
AGENTS.md
README.md
```

能力翻 true 时必须同时更新：

```text
desktopCapabilities.ts
capabilities.matrix.test.ts
runtime-boundaries.md
```

---

# 17. 实施顺序

推荐严格顺序：

```text
0. main 全绿
        ↓
1. Metadata Write Pipeline
        ↓
2. Desktop Local Metadata
        ↓
3. External File Watcher
        ↓
4. Trash / Group / Move
        ↓
5. Native Secret + Reveal
        ↓
R007 验收
        ↓
R008 Search & Scale
```

不要先做：

```text
SQLite
Native Menu
Auto Update
Installer
```

因为这些都不能解决当前 Desktop 最危险的问题：

```text
“用户与外部 Markdown 工具同时修改文件时，是否可靠且不丢数据？”
```

---

# 18. R007 完成定义

R007 只有同时满足以下条件才能标记“已完成”：

1. GitHub Actions 全绿；
2. Desktop 核心 UI 不再出现主流程 `NOT_IMPLEMENTED`；
3. 标题和标签真实写回 Frontmatter；
4. 收藏/最近状态重启保持但不污染 Markdown；
5. 外部新增/修改/删除/移动 Markdown 能被 E1 感知；
6. dirty + external edit 不发生静默覆盖；
7. E1 autosave 不产生 watcher reload loop；
8. Desktop API Key 可通过系统安全存储持久化；
9. reveal in file manager 不暴露 absolute path 给 Renderer；
10. Desktop golden E2E 全绿；
11. Web E2E 零行为回归；
12. architecture / requirements / decisions / AGENTS / README 与源码同步；
13. 所有新增 derived cache 均可从 Markdown 重建；
14. 任意失败路径都不允许破坏用户原始 Markdown。

---

# 19. 后续入口

R007 完成后建议：

## R008：Desktop Search & Scale

- SQLite / FTS；
- 增量索引；
- backlinks；
- link graph；
- 10k / 50k Markdown；
- 索引 rebuild；
- 搜索排序 / snippet。

## R009：Desktop Distribution

- electron-builder；
- macOS dmg；
- Windows installer；
- signing；
- auto update；
- release channel。

不要把 R008 / R009 提前塞回 R007。

# 运行时边界（R005 / R006）

R005 将项目划分为四层运行时边界：Shared UI、Shared Application、Web Runtime、Desktop Runtime。本文定义各层职责与禁止事项，并收录九条架构不变量（DUAL-01~09）与能力矩阵 `RuntimeCapabilities` 的字段语义。目标分层图见 `docs/requirements/r005-web-first-dual-runtime.md`（历史规划）；**当前事实以本文与源码 `webCapabilities` / `desktopCapabilities` 为准**，并由 `src/runtime/capabilities.matrix.test.ts` 锁定。

## 分层职责

### Shared UI（`src/components/`、`src/state/`、React/Tiptap 交互层）

职责：渲染、交互、状态生命周期（`useReducer`、Context 分发、requestId 过期响应保护、错误状态展示）、调用应用命令与查询。

禁止事项：

- 不得 import `infrastructure` 与 `platform/web/persistence`（既有约束，PR6 起由 `.dependency-cruiser.js` 强制）；
- 不得直接使用持久化仓储 port（DUAL-02，阶段 1 收紧 AppServices 后由架构测试强制）；
- 不得判断平台名称（DUAL-01）：代码中不得出现 `isElectron`、`process.platform`、`window.electron` 等平台分支，只允许判断 `RuntimeCapabilities`；
- 不得直接调用 IndexedDB、localStorage、BroadcastChannel、文件系统等持久化 API。

### Shared Application（`src/application/`、命令/查询服务、SaveCoordinator、MarkdownCodec）

职责：全部业务编排——工作区/页面/文档/标签/回收站命令、查询服务、保存协调、搜索索引同步、Markdown 解析与序列化、附件导入校验编排。两运行时共享同一份应用模型与用例实现。

禁止事项：

- 不得知道 IndexedDB 或 Electron 的存在（只依赖 port 接口）；
- 不得假设版本号是数字（阶段 3 起使用不透明 `ContentVersionToken`）；
- 不得暴露 `Blob` 给上层（阶段 5 起附件二进制经 Asset 服务以 `Uint8Array`/URL 抽象）；
- 不得直接调用 localStorage、BroadcastChannel 或 StorageManager（阶段 8 起经 RecoveryStore/ChangeChannel/StorageHealth 抽象）。

### Web Runtime（正式交付端）

职责：为 Shared Application 的全部 port 提供浏览器实现——IndexedDB 仓储、localStorage 恢复缓冲、BroadcastChannel 同步、`<input type=file>` 文件选择、Object URL 资源解析、内存搜索索引、`navigator.storage` 配额。Web 以 IndexedDB 中的 Tiptap JSON 为真实数据源（DUAL-03）。

禁止事项：

- 不得把浏览器实现细节（Blob、Object URL、BroadcastChannel 事件形状）泄漏进 application/domain 的公开接口；
- `browserServices.ts` 只负责装配，不含业务判断。

### Desktop Runtime（R006 技术验证版：Shell → C5 已落地）

**现状（当前事实）：**

- Electron Shell：`electron/main` ESM + sandbox preload CJS，contextIsolation 开启、nodeIntegration 关闭；装配根 `src/main.desktop.tsx` 经 `desktop.html` 多页入口加载。
- IPC：`shared/ipc` 契约与手写 schema 校验、`shared/errors` 统一错误码、preload `window.e1`（vault/note/asset 三组，信封解包 + 带码拒签）。注意 sandbox 下跨 contextBridge 的错误会被重建为 plain Error（自定义属性丢失），preload 把 `{code,message,details}` 编码进 message（`encodeIpcBridgeError`），Renderer 侧 `desktopApi.getDesktopApi()` 统一解码还原为 `DesktopIpcError`，调用方按 `err.code` 分流。
- 授权边界（C2.1）：Renderer 全程不接触 absolutePath（一次性 selectionToken + `openRecent` + transient 仅预览，SEC-01）；未初始化目录经三选项确认框后才初始化。
- **文档读写已真实**：`note.read` / `note.create` / `note.save` 经 PathGuard、NoteFileSystem、AtomicFileWriter；Renderer 侧 `DesktopContentRepository` + `DesktopMarkdownWriteService`（Source/Identity/Output Gate、Frontmatter 保留、Stable ID Adoption）；`documentPersistence: true`，编辑走共享 SaveCoordinator。
- **附件已真实（C5）**：`asset.pick` / `import` / `read`、`DesktopAssetStore` / Registry / Access、`e1-asset://` 协议、Markdown Hydration 与相对路径写出；`persistentAssetPaths: true`。
- 能力矩阵见下表（`src/platform/desktop/desktopCapabilities.ts`）：`localDirectory`、`documentPersistence`、`persistentAssetPaths`、`fileWatching`、`nativeSecrets`、`revealInFileManager` 为 true；`nativeMenu` 仍为 false（未实现，不得写「未来全 true」）。
- **Reveal in File Manager 已真实（R008 Stage 2，R8-07）**：`note.reveal` / `asset.reveal` 两通道共用同一安全链路——Renderer 只传 `{vaultId, relativePath}`（附件经会话资源索引反查 relativePath，绝不传 absolutePath），Main 经授权边界（registry/transients 双通道）+ PathGuard（realpath 根内判定）解析后调 `shell.showItemInFolder`；只读操作，transient 仅预览 Vault 同样允许。Renderer 侧为平台无关可选 port `AppServices.revealService`（`RevealService`：revealDocument/revealAsset），UI 以「capability + port 存在」门控入口。
- **Native Secret 已真实（R008 Stage 1）**：`secret.get/set/remove/getStatus` 四通道经 Main `electron/main/secrets/`（Electron `safeStorage` 加解密，优先异步 API）落 `userData/secrets.json` 密文；不安全 backend（如 Linux `basic_text`）降级 session-only 仅进程内存兜底、绝不落盘。R8-02：`nativeSecrets: true` 只表示「接入了 native secret 体系」，本机当前持久性由 `SecretStorageStatus`（`secret.getStatus`）表达，设置 UI 按之分流文案。
- **外部文件监听已真实（R007 阶段 3）**：Main 侧 `electron/main/watcher/`（chokidar + coalescing + 自写抑制）经首个单向事件通道 `events:vaultChanges` 推送 `VaultFsEvent` 批次；Renderer 侧 `ExternalVaultChangeService`（application 契约 + Desktop 实现）做静止窗口合并 → 重扫 → stable-id diff → 归一化变更；页面树经 `ExternalVaultChangeBridge` 刷新，当前文档按 clean 自动重载 / dirty 冲突面板 / 外部删除提示处理。
- 平台专属能力经**平台无关的可选 port** 注入（PR5，原 `AppServices.desktopExtras` PoC 通道已删除）：`AppServices.vaultMaintenance`（`rescan(vaultId)`，FR-26 重新扫描）与 `AppServices.documentSafety`（`approveLossySource` / `approveLossyOutput` / `approveIdentityAdoption` 会话级门闸）。Web/内存容器不装配这两个字段；UI 一律以「能力矩阵字段 + port 是否存在」门控（DUAL-01，不判断平台名称）。

职责：Renderer 侧经 IPC Client 实现同一组 port；Electron Main 负责目录选择、路径安全校验、Markdown 文件读写、临时文件原子替换、附件复制、自定义资源协议、文件 hash、IPC 参数校验。Desktop 以 Markdown 文件为真实数据源（DUAL-04）。

禁止事项：

- Renderer 不得直接使用 `fs`、`path`、SQLite、`ipcRenderer`、绝对文件路径写接口；
- IPC 只暴露业务能力（`note.read`/`note.save`/`asset.import` 等），不得暴露通用文件读写（`fs.readFile(path)`）；
- SQLite 只能保存可重建索引，不得成为正文唯一存储（DUAL-05；当前 Desktop 搜索仍为内存索引，SQLite 未落地）。

## 架构不变量（DUAL-01~09）

> 原文照录自 r005.md §五，各配一句执行说明。

- **DUAL-01：组件不得判断 web/electron 平台名称。** 落地为：组件只能判断 `RuntimeCapabilities`，代码中不得出现 `isElectron`/`process.platform`/`window.electron`。
- **DUAL-02：组件与 React Provider 不得直接使用持久化仓储。** 落地为：阶段 1 将 AppServices 公开面收紧为 commands/queries/runtime，原始仓储只存在于装配根内部，由架构测试强制。
- **DUAL-03：Web 继续以 IndexedDB 正文为真实数据源。** 落地为：Web 侧正文读写仍走 IndexedDB 仓储与 `DocumentCommitService`，搜索索引/恢复缓冲均为可重建派生物。
- **DUAL-04：Desktop 以后以 Markdown 文件为真实数据源。** 落地为：桌面端正文读写经 MarkdownCodec + 文件原子替换，元数据进 Frontmatter，见 ADR 006。
- **DUAL-05：SQLite 只能保存可重建索引，不成为正文唯一存储。** 落地为：SQLite 仅存 noteId/path/title/tags/links/textSnapshot/hash 等派生数据，删除后必须能从 Markdown 全量重建。
- **DUAL-06：所有平台实现必须通过同一应用契约测试。** 落地为：沿用现有「两实现共用契约套件」模式（参照 `src/test/documentWriteContract.ts`），每个 port 的 Web/Memory/Desktop 实现跑同一组契约测试。
- **DUAL-07：所有可持久化编辑器节点必须定义 Markdown 迁移策略。** 落地为：新增节点必须同时提供 schema、运行时校验、Markdown 解析与序列化、Portable Vault 行为，策略矩阵见 `docs/architecture/markdown-compatibility.md`。
- **DUAL-08：删除搜索索引后必须能够从真实数据源重建。** 落地为：Web 内存索引可从 IndexedDB 正文重建，Desktop SQLite 索引可从 Markdown 重建（`SearchIndexPort.rebuild`）。
- **DUAL-09：Web 导出的 Portable Vault 必须能被 Desktop 导入。** 落地为：Web 阶段 7 实现的导出格式即 Desktop 的迁移入口，Desktop 不依赖 IndexedDB schema，格式定义见 `docs/architecture/portable-vault.md`。

## 能力矩阵 `RuntimeCapabilities`

类型定义在 `src/runtime/RuntimeCapabilities.ts`。组件经 `capabilities.<field>` 判断能力是否存在，不做平台分支（DUAL-01）。

下表为**当前实现值**（源：`src/platform/web/webCapabilities.ts`、`src/platform/desktop/desktopCapabilities.ts`；由 `src/runtime/capabilities.matrix.test.ts` 锁定）。未实现的字段保持 false，不因运行在 Electron 就提前翻 true。

| 字段                   | 语义                                                                                    | Web | Desktop |
| ---------------------- | --------------------------------------------------------------------------------------- | :-: | :-----: |
| `localDirectory`       | 能以本地目录作为 Vault 直接读写（文件夹即页面树）                                       | 否  |   是    |
| `fileWatching`         | 能监听真实数据源的外部变更并触发刷新/冲突提示                                           | 否  |   是    |
| `revealInFileManager`  | 能在系统文件管理器中显示笔记或附件文件                                                  | 否  |   是    |
| `nativeMenu`           | 能使用系统原生菜单（应用菜单/上下文菜单）                                               | 否  |   否    |
| `nativeSecrets`        | 接入了 native secret 体系（运行态持久性由 `SecretStorageStatus` 表达，R8-02）           | 否  |   是    |
| `persistentAssetPaths` | 附件拥有稳定文件路径，可被外部软件直接访问（而非 Blob/Object URL）                      | 否  |   是    |
| `documentPersistence`  | 文档编辑会真实持久化（false 时编辑器不启动 SaveCoordinator，UI 必须提示修改不写回磁盘） | 是  |   是    |

约定：能力为 `false` 时对应 UI 入口隐藏或降级，不做「平台名 + 弹窗提示」式分支；新增平台功能一律先定义能力字段再实现（r005.md §十六）。变更任一字段时须同步更新本表、对应 `*Capabilities.ts` 与 `capabilities.matrix.test.ts`。

## 操作支持矩阵 `RuntimeOperations`（R007 阶段 4 §9；R008 Stage 0 R8-01 细分）

类型定义在 `src/runtime/RuntimeOperations.ts`，挂在 `AppServices.operations`。与 capabilities 的分工：

- **Capability = runtime 能做什么**（底层平台能力，如 fileWatching）；
- **Operation = 当前产品允许用户做什么**（UI 是否显示该操作入口）。

不为每个动作膨胀 capabilities 的 boolean；组件经 `useAppServices().operations` 门控入口（DUAL-01 同样适用：不判断平台名称）。未实现的操作必须保持 false——入口隐藏，而不是点了才抛 NOT_IMPLEMENTED。

R8-01：Operation Support 必须描述业务对象——document 与 group 的真实实现不同（Desktop 分组 rename/move 未实现），故 page 组细分 `document` / `group` / `trash` 三个对象，禁止用扁平 `page.move` 模糊表达两种对象的能力。

下表为**当前实现值**（源：`src/platform/web/webOperations.ts`、`src/platform/desktop/desktopOperations.ts`；由 `src/platform/desktop/desktopOperations.test.ts` 锁定）：

| 字段                        | 语义                                                             | Web | Desktop |
| --------------------------- | ---------------------------------------------------------------- | :-: | :-----: |
| `workspace.rename`          | 重命名知识库（Desktop 库名取自 vault.json/目录名，未实现）       | 是  |   否    |
| `workspace.favorite`        | 收藏/取消收藏知识库                                              | 是  |   是    |
| `page.document.create`      | 新建文档                                                         | 是  |   是    |
| `page.document.renameTitle` | 标题重命名（Desktop 写 Frontmatter title）                       | 是  |   是    |
| `page.document.renameFile`  | 物理文件名重命名（§4.4 P2，与标题重命名分开；UI 入口属后续批次） | 是  |   否    |
| `page.document.move`        | 移动文档（Desktop 仅 document → directory，不支持自定义排序）    | 是  |   是    |
| `page.document.trash`       | 文档移入回收站（Desktop = rename 进 .e1/trash）                  | 是  |   是    |
| `page.document.favorite`    | 收藏/取消收藏文档                                                | 是  |   是    |
| `page.group.create`         | 新建分组（Desktop = 真实目录）                                   | 是  |   是    |
| `page.group.rename`         | 分组重命名（Desktop 待 Main 目录 rename IPC，R011）              | 是  |   否    |
| `page.group.move`           | 分组移动（Desktop 待 Main 目录 move IPC，R011）                  | 是  |   否    |
| `page.group.trash`          | 分组移入回收站                                                   | 是  |   是    |
| `page.trash.restore`        | 从回收站恢复                                                     | 是  |   是    |
| `page.trash.purge`          | 永久删除（含清空回收站）                                         | 是  |   是    |
| `tag.write`                 | 标签写入（create / setPageTags）                                 | 是  |   是    |
| `revision.read`             | 读取版本历史（false 时 UI 必须隐藏版本历史入口，R007 §8）        | 是  |   否    |
| `revision.write`            | 写入版本快照（Desktop 版本历史为空实现）                         | 是  |   否    |

变更任一字段时须同步更新本表与 `desktopOperations.test.ts`。

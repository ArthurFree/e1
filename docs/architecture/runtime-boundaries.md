# 运行时边界（R005）

R005 将项目划分为四层运行时边界：Shared UI、Shared Application、Web Runtime、未来 Desktop Runtime。本文定义各层职责与禁止事项，并收录九条架构不变量（DUAL-01~09）与能力矩阵 `RuntimeCapabilities` 的字段语义。目标分层图见 `docs/requirements/r005-web-first-dual-runtime.md`。

## 分层职责

### Shared UI（`src/components/`、`src/state/`、React/Tiptap 交互层）

职责：渲染、交互、状态生命周期（`useReducer`、Context 分发、requestId 过期响应保护、错误状态展示）、调用应用命令与查询。

禁止事项：

- 不得 import `infrastructure`（既有约束，由 `src/test/architecture.test.ts` 强制）；
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

### Web Runtime（当前唯一正式交付端）

职责：为 Shared Application 的全部 port 提供浏览器实现——IndexedDB 仓储、localStorage 恢复缓冲、BroadcastChannel 同步、`<input type=file>` 文件选择、Object URL 资源解析、内存搜索索引、`navigator.storage` 配额。Web 以 IndexedDB 中的 Tiptap JSON 为真实数据源（DUAL-03）。

禁止事项：

- 不得把浏览器实现细节（Blob、Object URL、BroadcastChannel 事件形状）泄漏进 application/domain 的公开接口；
- `browserServices.ts` 只负责装配，不含业务判断。

### Desktop Runtime（R006 阶段 0+1 骨架、阶段 2 读路径、C2.1 授权边界、C3 安全阅读已落地）

现状：Electron Shell（`electron/main` ESM + sandbox preload CJS，contextIsolation 开启、nodeIntegration 关闭）、`shared/ipc` 契约与手写 schema 校验、`shared/errors` 统一错误码、preload `window.e1`（vault/note/asset 三组，信封解包 + 带码拒签）、`src/platform/desktop/`（`desktopCapabilities` 为 `localDirectory: true` 其余 false——含 C3 新增的 `documentPersistence: false`，FR-22 技术验证模式不写盘；`createDesktopRuntime` 为 IPC-backed 真实装配——Workspace/Page/Tag 读路径经 vault:listRecent/openRecent/openSelection/scan 映射 domain port，Content 经 note.read 真实读取（C3：MarkdownCodec.parse 在 Renderer，lossy 默认只读），写路径全部抛 DomainError("NOT_IMPLEMENTED") 诚实失败，note.create/save 属 C4）。装配根 `src/main.desktop.tsx` 经 `desktop.html` 多页入口加载。C2.1 起 Renderer 全程不接触 absolutePath（一次性 selectionToken + openRecent + transient 仅预览，SEC-01）；C3 起 `AppServices.desktopExtras`（可选，仅 Desktop）承载「重新扫描知识库」过渡通道（FR-26，PoC）。

职责（目标）：Renderer 侧经 IPC Client 实现同一组 port；Electron Main 负责目录选择、路径安全校验、Markdown 文件读写、临时文件原子替换、附件复制、自定义资源协议、文件 hash、IPC 参数校验。Desktop 以 Markdown 文件为真实数据源（DUAL-04）。

禁止事项：

- Renderer 不得直接使用 `fs`、`path`、SQLite、`ipcRenderer`、绝对文件路径写接口；
- IPC 只暴露业务能力（`notes.read`/`notes.save`/`assets.import` 等），不得暴露通用文件读写（`fs.readFile(path)`）；
- SQLite 只能保存可重建索引，不得成为正文唯一存储（DUAL-05）。

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

| 字段                   | 语义                                                                                    | Web | Desktop（未来） |
| ---------------------- | -------------------------------------------------------------------------------------- | :-: | :-------------: |
| `localDirectory`       | 能以本地目录作为 Vault 直接读写（文件夹即页面树）                                      | 否  |       是        |
| `fileWatching`         | 能监听真实数据源的外部变更并触发刷新/冲突提示                                          | 否  |       是        |
| `revealInFileManager`  | 能在系统文件管理器中显示笔记或附件文件                                                 | 否  |       是        |
| `nativeMenu`           | 能使用系统原生菜单（应用菜单/上下文菜单）                                              | 否  |       是        |
| `nativeSecrets`        | 能使用系统级安全存储保存 AI 密钥等机密                                                 | 否  |       是        |
| `persistentAssetPaths` | 附件拥有稳定文件路径，可被外部软件直接访问（而非 Blob/Object URL）                     | 否  |       是        |
| `documentPersistence`  | 文档编辑会真实持久化（false 时编辑器不启动 SaveCoordinator，UI 必须提示修改不写回磁盘） | 是  |  否（C4 翻是）  |

约定：能力为 `false` 时对应 UI 入口隐藏或降级，不做「平台名 + 弹窗提示」式分支；新增平台功能一律先定义能力字段再实现（r005.md §十六）。

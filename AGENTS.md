# AGENTS.md

面向 AI 编码代理的项目说明。本文件描述项目当前的真实状态，不推测未实现的细节。

## 项目概述

`notion-like-web` 是一个独立的 Web 笔记应用：以 Tiptap 的 Notion-like 模板为交互和视觉参考，提供本地优先（离线可用）的知识库、页面树和块编辑能力。面向简体中文个人用户。

**当前状态：第 1–5 阶段、R001（v0.2）与 R002（UI 设计系统与核心页面视觉重构）均已完成，R001/R002 待验收。** R002 落地：语义设计令牌（浅/深颜色、字体、圆角、阴影、z-index、动效 + `prefers-reduced-motion`，主色为项目自有绿色 `#22A06B`）、240px 全局侧栏（账户/搜索/主导航/知识库列表/底部工具区，1024–1279px 折叠 64px）、开始首页与知识库首页重构（64px 快捷卡片、54px 活动行、960px 知识库首页）、编辑器外框（48px 顶栏、42px 常驻工具栏、780px 正文、32px 文档标题、16px/1.75 正文）、统一 `ui/Dialog`（8 个面板迁移，聚焦与焦点归还）与 `ui/EmptyState`、Lucide 风格 SVG 系统图标（系统 Emoji 图标清零，用户自定义图标仍允许 Emoji）、页面树键盘导航（方向键/F2）、Cascade Layers 样式结构（tokens/reset/typography/global + components/*）。

**R003（架构整改）第一批（阶段 0–3）已完成：并发/竞态测试基线（保存乱序、文档切换挂起保存、附件清理竞态、工作区连切、偏好并发更新）、`SaveCoordinator` 保存系统（每文档串行队列 + 代次管理，附件清理与间隔版本只跟随最新快照，localStorage 恢复缓冲 + 启动恢复提示条）、知识库会话原子化（`WorkspaceSessionService` 一次加载 + requestId 丢弃过期响应 + 单次 dispatch 提交）、偏好事务化（仓储 update 单事务 + `PreferencesService` 串行队列，侧栏宽度 250ms 防抖、路由 last-write-wins）。**

**R003 第二批（阶段 4，数据校验和领域不变量）已完成：正文 JSON 白名单运行时校验（`domain/validation/documentContent.ts`，与 extensions.ts 的 schema 同步由测试强制）+ 损坏面板（尝试恢复 sanitize / 导出原始 JSON / 创建空白副本 + localStorage 诊断记录）+ 恢复缓冲收紧、统一 `DomainError` 错误码（`domain/errors.ts`）、页面/标签关系约束（父级存在/同知识库/未删除、标签同知识库、kind 与标题入参校验，14 例不变量测试）。** 后续批次（应用层/DI、AppState 拆分、IndexedDB v3、文档/架构约束）未做，见 `docs/requirements/R003.md`。

**R003 第三批（阶段 5，应用层与依赖注入）已完成：`AppServices` 服务容器 + `AppServicesProvider` 注入（生产 `createBrowserAppServices`，现经 `main.web.tsx` / `createWebRuntime` 装配，R005 阶段 2 前移自 main.tsx），12 个生产文件全部迁离 infrastructure 直接导入（Tiptap 附件扩展经 `editor.storage` 通道取仓储），`infrastructure/memory/` 内存仓储实现全部 7 个 port（复用 domain/pageTree，与 IndexedDB 版共用不变量断言），AppProvider 全流程内存容器集成测试，分层约束由 `src/test/architecture.test.ts`（import.meta.glob 源码扫描，替代 ESLint）强制。** 用例编排由 AppState actions + application 服务承载，不另建 use-case 类（决策见 decisions.md）。

**R003 第四批（阶段 6，AppState 拆分）已完成：单一状态所有者 + 四个窄 Context 分发（WorkspaceSession / Navigation / Preferences / Overlay，AppProvider 按域 memo 注入），`useApp()` 缩减为兼容聚合门面（既有组件与测试零改动）；OverlayContext 统一 settings/search/trash/treeDrawer 开关并删除 onOpenTree prop 链；trashedPages 派生本地化；PageTreeSidebar 树主体提取为 React.memo 的 PageTreeBody；@ 提及候选改为 getMentionPages + ref 动态读取（新建/重命名立即生效）。渲染隔离由 renderProbe 基建 + contextIsolation 测试强制（主题/重命名/开面板互不扇出）。

**R003 第五批（阶段 7，IndexedDB 性能优化）已完成：DB v3（pages 复合索引 `workspaceId_parentId` / `workspaceId_updatedAt` + trash `deletedAt`，纯索引迁移 + v1/v2 跳级迁移测试）、热点查询全部改走索引（listByWorkspace/create/move/remove/restore/purge/tag 列表）、工作区级内存搜索索引（`SearchIndexService`，会话加载构建 + 页面动作/协调器 onSaved 增量同步，与 searchPages 语义等价由测试强制）、页面树邻接表（`buildChildrenByParent`，collectSubtreeIds 与树渲染 O(n²) → O(n)）、清空回收站单事务化（六 store 一次事务）、三档基准测试（中型会话加载 264ms < 300ms、搜索 < 100ms、10,000 页面 listByWorkspace < 1s）。**

**R003 第六批（阶段 8，文档/ADR/开发诊断）已完成，R003 全部八个阶段收尾：架构文档拆分为 `docs/architecture/` 六主题（overview/dependency-rules/state-management/persistence/editor-save-pipeline/error-handling）+ `docs/adr/` 四 ADR + `docs/migrations/indexeddb-v3.md`，`docs/architecture.md` 改为索引页，README 同步；`src/application/devDiagnostics.ts` 开发诊断（workspace-load/search-query/save-queue/idb-save/db-migration/corrupted-content 六项指标，仅 Vite dev 启用、生产与测试静默，不记录正文与密钥）。**

**图标整改已完成：`ui/icons.tsx` 从 23 扩至 54 个 SVG 图标（新增重命名/新建分组/导入/标签/附件/关闭/勾选/恢复/右箭头/历史/四枚对齐/七枚行内格式/三枚列表/缩进/清格式/段落/撤销重做/文本颜色），系统 UI 的文本字形与 Emoji 图标全部替换（☰ ★ ☆ ✕ ✓ ＋ ▸ ▾ ≡ ⇥ ↩ 等清零，FormatToolbar 常驻工具栏与 BubbleToolbar 全图标化），R002 的「系统 Emoji 图标清零」至此真正实现。非 React 环境复用同一图标源：@ 提及候选回退经 `createElement(IconFile)`，附件 NodeView 经 `paperclipSvgString()` 内联 SVG（与 IconPaperclip 共用路径数据）。语义重映射：版本历史按钮 IconClock → IconHistory（IconClock 只表示「最近」）；TargetPicker 空图标回退移到组件层（IconBook），domain/picker 不再含 Emoji 回退。Emoji 仅保留在 EmojiPicker 表情列表、seed 用户数据与 CreateWorkspaceModal placeholder。**

**R004（架构与数据一致性整改）第一批（阶段 0–2 部分）已完成：保存后半程竞态基线测试（revision.add/removeOrphans 挂起窗口 + 空 retryLatest + components 直写仓储白名单快照）、保存协调器并发边界修复（快照 `capturedAt` 时间戳 + `isCurrent()` 每个 await 后重查、`removeOrphans` 增加 `createdBeforeOrAt` 时间边界（INV-03）、维护任务（版本/附件清理/恢复缓冲）整段跳过过期快照、维护失败经 `onMaintenanceError` 分流不进 error 态、空状态 retryLatest 显式拒绝）、`DocumentWriteRepository` 原子文档写 port（`createWithContent` 单事务「校验 + 写页面 + 写正文」，正文白名单校验失败整体回滚，INV-04；IndexedDB 与内存实现共用契约套件）、`DocumentCommitService` 正文提交单点（commit/createWithContent/replaceContent 统一「落盘 + 搜索索引同步」，INV-05；协调器 deps 由 ContentRepository 收窄为 DocumentContentCommitter，onSaved 回调移除）、`docs/architecture/document-write-path.md` 写入路径与 INV-01~07 不变量文档。** **R004 第二批（阶段 3–4）已完成：阶段 3 全部绕过写入迁移清零（模板/AI/Markdown 导入经 AppState action `createDocumentWithContent` 原子创建；版本恢复经 `DocumentEditorController` 串行化——flush 防抖与协调器队列 → before-restore 版本 → 协调器提交目标版本 → setContent 抑制二次保存（INV-06），`DocumentCommitService.restoreRevision` 承载编排；MainArea 空白副本走 `documentCommit.replaceContent`；components 直写仓储白名单清零，新增即架构测试失败；`RestoreRevisionRace` 竞态测试 + e2e 3 例）。阶段 4 拆解 AppState：单一状态所有者拆为四状态域 Provider（`AppProviders` 组合 Preferences → Workspace → Navigation → Overlay；会话纯 reducer 提取至 `workspace/sessionReducer.ts`），跨域动作经内部通道协作——内层 NavigationProvider 消费偏好路由通道与工作区会话通道，外层工作区动作经 `navigationBridge` 命令桥触发导航（不复制实现，公开 Context value 形状不变）；`PreferencesService.dispose()`（清防抖定时器 + 挂起宽度补写 + 队列排空）随 PreferencesProvider 卸载调用；13 个生产文件全部迁离 `useApp()` 聚合门面（移入 `legacy/useApp.ts` 仅供既有测试），`AppState.tsx` 只剩兼容 re-export；每个新 Provider 有单元测试（连切过期响应/跨库打开/删除当前文档回首页/dispose 语义）。**

**R004 第三批（阶段 5–7）已完成，R004 全部八个阶段收尾：阶段 5 IndexedDB v4（contents/pageTags 补 `workspaceId` 字段回写 + 三个工作区索引，孤立记录不猜测不删除被索引天然排除；`content.listByWorkspace` 替代会话加载全表扫描；`content.save` 收紧为读 page 补 workspaceId、页面不存在抛 PAGE_NOT_FOUND；v1/v2/v3→v4 五条迁移路径测试 + 多工作区基准零 listAll 调用）。阶段 6 图片/配额/版本空间治理（`localImage` 节点只存 attachmentId、Base64 禁新增旧数据兼容、附件统一校验 20MB/100MB/MIME 白名单 + 新错误码 ATTACHMENT_TOO_LARGE/UNSUPPORTED_ATTACHMENT_TYPE、`StorageQuotaService` + 保存错误 errorKind "quota" 独立文案、设置面板「本地存储」区、interval 版本 5MB 字节预算确定性裁剪）。阶段 7 多标签页与工程门禁（db.ts 连接生命周期 blocked/blocking/versionchange/terminated + 提示条、BroadcastChannel 四类事件 + tabId 回声抑制 + dirty 冲突提示、正文乐观锁 `DocumentContent.version` + expectedVersion + DOCUMENT_CONFLICT + 四选项冲突面板、ESLint flat/Prettier/dependency-cruiser 零违规零循环、`npm run ci` 统一门禁、GitHub Actions quality/e2e 双 job——视觉基线 macOS 生成不进 CI）。** **R004 §4.6（Context 数据/命令细分）已完成：Workspace/Navigation 两域公开 Context 各拆为 Data(State)/Command 双片（`useWorkspaceData`/`useWorkspaceCommands`/`useNavigationState`/`useNavigationCommands`），命令回调经 sessionRef/workspacesRef 读取最新数据保持引用恒定（纯命令消费者不随数据/路由变化重渲染），18 个生产组件全部迁到细粒度 hook（聚合 hook 仅供测试，架构测试强制），渲染粒度由 `contextGranularity.test.tsx` 强制。** 内容寻址快照（§6.5 可选）未做，见 `docs/requirements/r004.md`。

**R005（Web 优先与 Electron 双端准备）阶段 0–2 已完成：**双端边界与 Portable Vault v1/Markdown 兼容性文档基线 + DUAL-01~09 不变量（`docs/architecture/runtime-boundaries.md`）+ ADR 005/006；业务编排移出 React Provider——`application/commands/` 四个命令服务（Workspace/Page/Tag/Document，回收站操作并入 PageCommandService）与 `application/queries/` 三个查询服务（Workspace/Document/Search）承载全部页面/知识库/标签/正文写编排与查询，WorkspaceProvider 只留状态生命周期（编排下沉 699→633 行），NavigationProvider 同步迁移；AppServices 收紧不再暴露原始仓储（attachment 例外经 editor.storage 保留，TODO R005-13/14 待阶段 5 Asset 抽象）与 documentCommit/session/searchIndex，PreferencesService 改由装配根构造；Bootstrap 拆分——`bootstrap/mountApplication` 共享挂载（含样式 import）+ `platform/web/createWebRuntime` + `main.web.tsx` 唯一 Web 装配根（index.html 指向，`src/main.tsx` 删除）+ `RuntimeCapabilities` 能力矩阵（Web 六能力全 false，接入 `AppServices.capabilities`）；架构门禁新增 components/state 不得 import domain/repositories、不得访问已删容器字段、装配链唯一 + bootstrap 不得 import infrastructure。阶段 3+（VersionToken/MarkdownCodec/Asset/SearchPort/Portable Vault/平台服务抽象/Electron）未做，见 `docs/requirements/r005.md`。

质量：471 单元/组件测试（含性能基准、v1–v4 迁移、两实现契约套件、多标签页同步、Context 渲染粒度、R005 命令/查询服务双实现断言 30 例）、47 Playwright（功能 18 + 多标签页 1、视觉基线 13 + 四档宽度 8 + 深色开始页、响应式 6）、typecheck、lint、deps:check、生产构建全部通过。（3 项文档编辑区视觉基线曾因环境渲染漂移失败，已用 git stash 验证与代码改动无关，并于 R003 第一批收尾时重新生成基线；设置面板基线因阶段 6「本地存储」区于 R004 第三批更新。）常用命令：`npm run dev`、`npm run build`、`npm test`、`npm run dev:web` / `build:web` / `test:web`（R005 起 Web 端显式命名，原命令保留为别名）、`npm run typecheck`、`npm run lint`、`npm run deps:check`、`npm run ci`、`npm run test:e2e`（截图基线更新用 `npm run test:e2e:update`）。

## 源码结构

- `src/domain/`：实体类型（`types.ts`）、页面树纯逻辑（`pageTree.ts`）、全局搜索（`search.ts`）、AI（`ai.ts`）、活动列表排序与归属路径（`activity.ts`）、创建位置选择（`picker.ts`）、路由持久化（`route.ts`）、版本策略（`revisions.ts`，含 interval 5MB 字节预算与确定性裁剪）、字数统计（`wordCount.ts`）、仓储接口（`repositories.ts`，含 R004 原子文档写 port `DocumentWriteRepository` 与 save 乐观锁 expectedVersion）、领域错误码（`errors.ts`，DomainError + 稳定 code，含 DOCUMENT_CONFLICT/ATTACHMENT_TOO_LARGE/UNSUPPORTED_ATTACHMENT_TYPE 与 isQuotaExceededError）、附件统一校验（`attachments.ts`，R004 阶段 6）、多标签页事件契约（`sync.ts`，R004 阶段 7）、正文 JSON 白名单校验与修复（`validation/documentContent.ts`，含 localImage，白名单与 extensions.ts schema 同步由测试强制）。
- `src/infrastructure/`：IndexedDB 实现——`db.ts`（DB v4 schema 与按 oldVersion 分支迁移 + 连接生命周期 blocked/blocking/versionchange/terminated 处理，导出 `createV1Schema` 供迁移 fixture）、`repositories.ts`（含损坏数据降级、软删/恢复、版本与附件仓储、purge 级联、R003 阶段 4 关系约束、阶段 7 索引查询与单事务清空、R004 `documentWriteRepository` 原子文档写、附件清理时间边界、正文 save 乐观锁 version + v4 工作区索引）、`seed.ts`（预置知识库，模块级 Promise 防并发重复种子）、`aiProvider.ts`、`browserServices.ts`（生产服务装配根 `createBrowserAppServices`）、`memory/`（内存仓储：8 个 port 的纯内存实现 + `createInMemoryAppServices`，可替换性证明）、`migration.test.ts`（v1 真实 fixture 迁移测试）、`dbV3Migration.test.ts` / `dbV4Migration.test.ts`（跳级迁移与孤立记录）、`dbLifecycle.test.ts`（连接生命周期）、`perf.bench.test.ts`（三档 + 多工作区基准）、`documentWriteRepository.test.ts` / `contentSaveContract.test.ts`（+ memory 对应件，两实现共用契约套件）。
- `src/editor/`：编辑器内核——`extensions.ts`、`markdown.ts`、`commands.ts`（统一命令注册表）、`aiBridge.ts`、`slashSuggestion.ts` / `mentionSuggestion.ts` / `popupRenderer.ts`、`toc.ts`、`blockActions.ts`、`tableUtils.ts`、`format.ts`（段落样式/字号/清格式，常驻工具栏与其他入口共用）、`indent.ts`、`codeBlock.ts`（语言选择 + lowlight 高亮 + 复制）、`attachment.ts`（附件节点）、`localImage.ts`（图片附件化节点：只存 attachmentId，Object URL 渲染即毁，粘贴/拖拽/命令三入口统一走校验 + 附件仓储，R004 阶段 6）、`templates.ts`（六个内置模板 JSON）。
- `src/application/`：应用服务层——`AppServices.ts`（服务容器接口，R005 阶段 1 收紧：`commands{workspace,page,tag,document}` + `queries{workspace,document,search}` + `preferencesService` + `attachment`（TODO R005-13/14 经 editor.storage 保留）+ `createAIProvider` / `createSaveCoordinator` / `syncChannel` / `storageEvents` / `capabilities`，原始仓储与 documentCommit/session/searchIndex 不再公开）、`commands/`（R005 阶段 1 业务写编排：`WorkspaceCommandService` / `PageCommandService`（含回收站操作）/ `TagCommandService` / `DocumentCommandService`，承载仓储写 + 搜索索引同步 + 跨标签页广播）、`queries/`（R005 阶段 1 只读编排：`WorkspaceQueryService` / `DocumentQueryService` / `SearchQueryService`）、`services/SaveCoordinator.ts`（每文档保存串行队列 + 代次管理 + 快照 capturedAt + knownVersion 乐观锁，isCurrent 逐 await 重查，维护任务只跟随当前代次、维护失败经 onMaintenanceError 分流，正文提交走 DocumentContentCommitter 窄接口，冲突进 errorKind "conflict" 不自动重试）、`services/DocumentCommitService.ts`（R004：正文提交单点——commit/createWithContent/replaceContent/restoreRevision 统一落盘 + 搜索索引同步 + 同步广播）、`services/SearchIndexService.ts`（工作区级内存搜索索引）、`services/SyncChannelService.ts`（BroadcastChannel 多标签页同步 + tabId 回声抑制，R004 阶段 7）、`services/StorageQuotaService.ts`（存储估算与阈值，降级 null）、`services/StorageConnectionEventBus.ts`（db 连接事件到 UI 提示条的中转）、`services/documentRecovery.ts`（localStorage 恢复缓冲，正文 JSON 经白名单校验）、`services/corruptedDiagnostics.ts`（损坏正文诊断记录）、`services/WorkspaceSessionService.ts`（知识库会话原子加载：页面/标签/关联/正文，v4 起正文走工作区索引）、`services/PreferencesService.ts`（偏好写入串行队列 + 侧栏防抖 + 路由 last-write-wins + dispose/resume 生命周期，R005 起由装配根构造经容器注入）、`devDiagnostics.ts`（开发诊断指标，仅 dev 启用）；仓储经构造函数注入（domain port），不直接依赖 IndexedDB 实现。
- `src/bootstrap/`：`mountApplication.tsx`（R005 阶段 2 共享挂载入口：React 树装配与样式 import 的平台无关部分，Web 与未来 Desktop 装配根共用，不得 import infrastructure）。
- `src/runtime/`：`RuntimeCapabilities.ts`（R005 阶段 0 能力矩阵接口，DUAL-01：组件只判断能力字段、不得判断平台名称；字段语义见 `docs/architecture/runtime-boundaries.md`）。
- `src/platform/web/`：`createWebRuntime.ts`（Web 运行时装配：createBrowserAppServices 容器 + 能力矩阵）+ `webCapabilities.ts`（Web 能力矩阵，六字段全 false）；`src/main.web.tsx` 为唯一 Web 装配根（index.html 指向，仅它与 platform/web 可 import browserServices）。
- `src/state/`：`AppServicesProvider.tsx`（AppServices 容器注入，组件/状态层经 `useAppServices()` 取服务，禁止直接 import infrastructure）、`AppProviders.tsx`（组合层：Preferences → Workspace → Navigation → Overlay 四状态域 Provider 嵌套装配，R004 阶段 4）、`PreferencesProvider.tsx`（preferences + 消费装配根构造的 PreferencesService 单例（R005 批次 2），卸载时 dispose；内部路由通道 persistRoute/routePersistenceStatus/whenLoaded）、`WorkspaceProvider.tsx`（workspaces/会话状态生命周期所有者（useReducer + requestId 过期保护 + dispatch），页面/知识库/标签写编排与查询经 application commands/queries（R005 阶段 1）；内部通道 loadSession/loadPages/getSnapshot；命令回调经 sessionRef/workspacesRef 保持引用恒定）、`NavigationProvider.tsx`（view/selectedPageId/titleFocusPageId + 导航动作，R005 起同样经 commands/queries 取数；经 `navigationBridge` 命令桥向工作区域暴露导航命令）、`workspace/sessionReducer.ts`（会话纯 reducer）、`WorkspaceSessionContext.tsx` / `NavigationContext.tsx`（各细分为 Data(State)/Command 双 Context，R004 §4.6，聚合形状不变）/ `PreferencesContext.tsx` / `OverlayContext.tsx`（四个状态域 Context）、`legacy/useApp.ts`（兼容聚合门面，仅供既有测试过渡）、`AppState.tsx`（兼容 re-export 层）。生产代码一律用细粒度 hook（useWorkspaceData/useWorkspaceCommands/useNavigationState/useNavigationCommands/usePreferences/useOverlay），组件使用聚合 hook 由架构测试拦截。
- `src/components/`：`AppShell`、`shell/GlobalSidebar`（240px 全局侧栏）、`ui/`（icons SVG 图标集 54 枚 + PageIcon、Button、IconButton、Dialog、EmptyState）、`PageTreeSidebar`、`MainArea`（按视图分发）、`StartPage`、`ActivityList`、`RecentPage`、`FavoritesPage`、`WorkspaceHome`、`TargetPicker`、`TemplateCenter`、`AIDraftModal`、`CreateWorkspaceModal`、`SearchPanel`、`TrashPanel`、`SettingsPanel`、`VersionPanel`、`TagPicker`、`TitleEditor`、`StartPreview`；`src/components/editor/`：`DocumentEditor`（宿主 + 装配：编辑变更提交 `SaveCoordinator`，保存状态机与恢复保存由协调器驱动）、`FormatToolbar`（常驻工具栏）、`BubbleToolbar`、`AIAssistantPanel`、`SaveStateIndicator`、`WordCount`、`TableToolbar`、`BlockHandle`、`CommandList`、`EmojiPicker`、`TocPanel`。
- `src/hooks/useDebouncedCallback.ts`：防抖保存 hook（beforeunload/卸载时 flush）。
- `src/test/`：Vitest 共享底座——`setup.ts`（jest-dom + fake-indexeddb + jsdom getClientRects polyfill）、`fixtures.ts`（确定性数据生成器 + deferred/sleep 时序工具）、`renderProbe.tsx`（渲染计数 probe，Context 隔离测试用）、`TestApp.tsx`（测试装配：IndexedDB 容器 + AppProvider）、`documentWriteContract.ts` / `contentSaveContract.ts`（DocumentWrite 与正文乐观锁两实现共用契约套件，R004）、`architecture.test.ts`（分层约束源码扫描：components/state/editor/application/domain 不得 import infrastructure，domain 不得 import react，application 不得 import components；components 禁聚合 hook（R004 §4.6）与直写仓储（R004 白名单已清零）；R005 新增——components/state 不得 import domain/repositories、不得访问 AppServices 已移除的原始仓储/服务字段、仅 main.web.tsx 与 platform/web 可 import browserServices、bootstrap 不得 import infrastructure）。
- `src/styles/`：`index.css`（Cascade Layers 入口）+ `tokens.css`（语义设计令牌：浅/深颜色、字体、圆角、阴影、z-index、动效）+ `reset.css` + `typography.css` + `global.css`（迁移期组件层）+ `components/`（buttons/sidebar/empty-state）；应用壳网格行高固定为 `minmax(0, 1fr)` 且 `overflow: clip`；`.doc-layout` 纵向（工具栏在上），`.doc-main` 为正文 + 目录行容器。
- `e2e/`：Playwright 测试——`app.spec.ts`（18 例功能端到端：开始首页/知识库首页/收藏/最近/保存状态/版本历史/模板/AI/回收站/树键盘导航 + R004 统一写入路径 3 例，含 mock endpoint 验证「确认后才写入」）、`multi-tab.spec.ts`（同 context 双标签页：dirty 标签页收冲突提示、磁盘不被覆盖、重新载入后一致）、`visual.spec.ts`（13 张 1440 × 900 基线）、`visual-pages.spec.ts`（开始页与知识库首页 × 1440/1024/768/390 基线 + 深色开始页）、`responsive.spec.ts`（1024/768/375 冒烟）；浏览器二进制装在项目内（`PLAYWRIGHT_BROWSERS_PATH=0`，npm script 已注入）。
- 工程门禁（R004 阶段 7）：`eslint.config.js`（flat：typescript-eslint + react-hooks + react-refresh，0 error 12 存量 warning）、`.prettierrc` / `.prettierignore`、`.dependency-cruiser.js`（no-circular + 分层 forbidden，测试文件豁免）、`.github/workflows/ci.yml`（quality：npm ci → npm run ci → coverage；e2e：Chromium + app/responsive，视觉基线 macOS 生成不进 CI，失败上传截图与 trace）。

## 技术栈（已确认的决策）

- React + Vite + TypeScript：单页 Web 应用。
- Tiptap 3：富文本编辑内核，只使用开源扩展，不引入 Tiptap Pro 专有能力；Markdown 导入导出用官方 `@tiptap/markdown`。
- IndexedDB：本地数据与二进制资源持久化，封装为仓储层。
- CSS variables + 模块化样式：主题令牌与组件样式。
- Vitest + Testing Library：单元与组件测试；Playwright：端到端与截图回归。

首版不做：注册/登录、云同步、多人协作、评论、权限、支付。

## 文档结构（唯一的内容来源）

- `README.md`：功能、运行/测试命令、架构概览（分层/数据模型/编辑器组合/AI 接口）、隐私说明与已确认决策。
- `docs/requirements.md`：产品需求、功能范围与验收标准。
- `docs/architecture.md`：架构文档索引；主题文档在 `docs/architecture/`（overview/dependency-rules/state-management/persistence/editor-save-pipeline/error-handling），重大决策 ADR 在 `docs/adr/`，数据库迁移说明在 `docs/migrations/`。
- `docs/ui-spec.md`：页面结构、视觉状态、响应式规则与可访问性要求；基准视口 1440 × 900。
- `docs/test-plan.md`：单元、组件、端到端与视觉回归测试计划及发布前验收。
- `docs/implementation-plan.md`：五个实现阶段及各阶段完成标准。
- `docs/decisions.md`：决策记录表；**任何改变这些结论的需求，须先更新本表及受影响的文档，再改代码。**
- `docs/requirements/R003.md`：架构整改实施规划（已全部完成，实施报告见 `docs/r003-implementation-report.md`）。

## 开始实现时的架构约束

- 界面只依赖仓储接口和领域状态；Tiptap 仅通过编辑器适配层与页面内容交互，基础设施层（IndexedDB、Markdown 转换、AI provider）可整体替换。
- 文档内容 JSON 是唯一编辑真相；`textSnapshot` 仅用于搜索与 Markdown 导出。
- 统一命令定义驱动命令菜单、浮动工具栏和块菜单，避免三处功能分叉。
- 编辑器变更经防抖后保存；切换文档或卸载页面时强制落盘。
- 实施顺序约束（见 `docs/implementation-plan.md` 末尾）：仓储与领域模型先于编辑器保存；命令注册先于各类菜单；表格、拖拽、AI 在基础编辑器稳定后引入；每阶段完成后才更新视觉基线。

## 构建与测试

已有命令：`npm run dev`（开发，别名 `dev:web`）、`npm run build`（类型检查 + 生产构建，别名 `build:web`）、`npm test`（Vitest，jsdom + fake-indexeddb，别名 `test:web`）、`npm run typecheck`、`npm run lint`（ESLint，0 error 门禁）、`npm run format:check` / `npm run format`（Prettier）、`npm run deps:check`（dependency-cruiser 分层与循环依赖）、`npm run test:coverage`、`npm run ci`（统一门禁：typecheck + lint + deps:check + test + build）、`npm run test:e2e` / `npm run test:e2e:update`。测试体系现状：

- 单元测试覆盖页面树、仓储（含 IndexedDB v1–v4 迁移、损坏数据降级、正文乐观锁与 DocumentWrite 两实现契约套件）、搜索、Markdown 导入导出、AI 配置校验与错误映射、附件校验与版本空间预算。
- 组件测试覆盖菜单键盘操作、格式化、撤销重做、自动保存防抖、刷新后状态恢复、保存后半程与版本恢复竞态、多标签页同步与冲突面板、状态域 Provider。
- Playwright 在 1440 × 900 固定视口做截图回归，保存中文基线并对动态光标、时间、随机 ID 做屏蔽；另在 1024px、768px、375px 做响应式冒烟；多标签页 e2e 验证冲突不静默覆盖。
- CI（GitHub Actions）：quality job 跑 `npm run ci` + 覆盖率；e2e job 跑功能与响应式，失败上传截图与 trace；视觉基线为 macOS 生成不进 CI。
- 发布前须通过全部自动化测试、类型检查、lint、deps:check 和生产构建。

## 约定与安全要求

- 默认语言为简体中文：UI 文案、预置示例文档、截图基线均使用中文。
- API key 和 endpoint 只存 IndexedDB，不进入同步、日志、分析或错误上报；未配置 AI 时不发起任何外部请求，AI 输出须经用户确认后才写入文档。
- 图片、Markdown 导入和 AI 返回内容都经编辑器白名单解析，禁止把原始 HTML 直接注入 DOM。
- 可访问性：图标按钮提供 `aria-label`，菜单支持方向键、Enter、Escape，保证可见焦点状态与文本对比度。
- 视觉基准为 1440 × 900 桌面视口下的高还原度；窄屏（768px、375px）保持可用即可。

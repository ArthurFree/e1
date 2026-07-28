# 状态管理

## 结构：四状态域 Provider 组合（R004 阶段 4）

状态层已拆分为四个独立的状态所有者，由 `AppProviders`（`src/state/AppProviders.tsx`）嵌套装配，嵌套顺序即依赖方向：`PreferencesProvider → WorkspaceProvider → NavigationProvider → OverlayProvider`：

| Provider | 文件 | 拥有 | 公开 Context |
| --- | --- | --- | --- |
| Preferences | `PreferencesProvider.tsx` | preferences、routePersistenceStatus、`PreferencesService` 实例（卸载时 `dispose()`：清防抖定时器 + 队列排空） | `PreferencesContext.tsx` |
| Workspace | `WorkspaceProvider.tsx` | ready/error/retryLoad、workspaces、会话（pages/tags/pageTags/status）、页面/标签 CRUD、搜索索引构建 | `WorkspaceSessionContext.tsx` |
| Navigation | `NavigationProvider.tsx` | view、selectedPageId、titleFocusPageId、导航动作 | `NavigationContext.tsx` |
| Overlay | `OverlayContext.tsx` | settings/search/trash/treeDrawer 开关（自包含 Provider） | 同左 |

跨域动作不复制实现，经两条内部通道协作（公开 Context value 形状均不变）：

- **内层消费外层**：NavigationProvider 经 `usePreferencesRoute()`（persistRoute/routePersistenceStatus/whenLoaded）与 `useWorkspaceInternals()`（loadSession/loadPages/getSnapshot）读取偏好与工作区能力；
- **外层调用内层**：WorkspaceProvider 的跨域动作（切换/创建知识库、新建/删除页面）经 `navigationBridge` 命令桥触发导航（restoreRoute/showWorkspaceHome/openDocumentView/exitDocumentIfSelected），桥对象由 AppProviders 创建，NavigationProvider 挂载时注册。

会话纯 reducer 提取至 `workspace/sessionReducer.ts`；`useApp()` 聚合门面移入 `legacy/useApp.ts` 仅供既有测试过渡，`AppState.tsx` 只剩兼容 re-export。生产代码一律使用窄 hook 获得渲染隔离。

## 知识库会话原子加载（R003 阶段 2）

- `workspaceId/pages/tags/pageTags` 由单个 `useReducer` 持有，切换知识库时经 `WorkspaceSessionService.load` 一次 `Promise.all` 拉齐（含正文，供搜索索引），`requestId` 递增丢弃过期响应，单次 dispatch 提交——UI 永远不会看到「新知识库 + 旧页面」。
- 会话未 ready 不进入文档视图；加载失败进 error 状态并有重试入口。
- 会话加载成功即构建工作区级搜索索引（`SearchIndexService.build`）。

## 渲染隔离

- 每域 value 独立 memo：主题变化只扇出到 Preferences 消费者，页面重命名只扇出到会话消费者。由 `src/test/renderProbe.tsx` + `src/state/contextIsolation.test.tsx` 强制。
- 贵价子树加 memo 边界：页面树主体 `PageTreeBody`（PageTreeSidebar）为 `React.memo`，交互状态内收。
- 派生状态不进 Context：`trashedPages`（TrashPanel 本地 useMemo）、activePage、favoritePages、树结构（`buildChildrenByParent` 邻接表，pages 变化时一次构建）。

## 偏好与路由写入（R003 阶段 3）

`PreferencesService` 串行队列合并全部偏好写入：主题/AI 配置直接排队；侧栏宽度 250ms 防抖（拖动期间内存实时更新）；路由 last-write-wins（连续导航只落盘最后一次）。仓储 `preferences.update` 在单个 readwrite 事务内读-改-写，并发更新不再互相覆盖；写入错误经 `routePersistenceStatus` 可观测。

## @ 提及候选（R003 阶段 6）

编辑器实例不随 pages 重建；扩展经 `getMentionPages` 函数 + ref 动态读取候选，新建/重命名页面后 @ 候选立即更新（`MentionRefresh.test.tsx` 验证）。

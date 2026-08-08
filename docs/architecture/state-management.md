# 状态管理

## 结构：四状态域 Provider 组合（R004 阶段 4）

状态层已拆分为四个独立的状态所有者，由 `AppProviders`（`src/state/AppProviders.tsx`）嵌套装配，嵌套顺序即依赖方向：`PreferencesProvider → WorkspaceProvider → NavigationProvider → OverlayProvider`：

| Provider    | 文件                      | 拥有                                                                                                          | 公开 Context                                            |
| ----------- | ------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Preferences | `PreferencesProvider.tsx` | preferences、routePersistenceStatus、`PreferencesService` 实例（卸载时 `dispose()`：清防抖定时器 + 队列排空） | `PreferencesContext.tsx`                                |
| Workspace   | `WorkspaceProvider.tsx`   | ready/error/retryLoad、workspaces、会话（pages/tags/pageTags/status）、页面/标签 CRUD、搜索索引准备           | `WorkspaceSessionContext.tsx`（细分 Data/Command 双片） |
| Navigation  | `NavigationProvider.tsx`  | view、selectedPageId、titleFocusPageId、导航动作                                                              | `NavigationContext.tsx`（细分 State/Command 双片）      |
| Overlay     | `OverlayContext.tsx`      | settings/search/trash/treeDrawer 开关（自包含 Provider）                                                      | 同左                                                    |

跨域动作不复制实现，经两条内部通道协作（公开 Context value 形状均不变）：

- **内层消费外层**：NavigationProvider 经 `usePreferencesRoute()`（persistRoute/routePersistenceStatus/whenLoaded）与 `useWorkspaceInternals()`（loadSession/loadPages/getSnapshot）读取偏好与工作区能力；
- **外层调用内层**：WorkspaceProvider 的跨域动作（切换/创建知识库、新建/删除页面）经 `navigationBridge` 命令桥触发导航（restoreRoute/showWorkspaceHome/openDocumentView/exitDocumentIfSelected），桥对象由 AppProviders 创建，NavigationProvider 挂载时注册。

会话纯 reducer 提取至 `workspace/sessionReducer.ts`；`useApp()` 聚合门面移入 `legacy/useApp.ts` 仅供既有测试过渡，`AppState.tsx` 只剩兼容 re-export。生产代码一律使用细粒度 hook（useWorkspaceData/useWorkspaceCommands/useNavigationState/useNavigationCommands/usePreferences/useOverlay）获得渲染隔离。

## Context 数据/命令细分（R004 §4.6）

Workspace 与 Navigation 两个状态域各自的公开 Context 进一步拆为两片：

- **WorkspaceSessionContext** → `WorkspaceDataContext`（ready/error/workspaces/workspace/会话数据，随数据变化更新）+ `WorkspaceCommandContext`（全部页面/标签/知识库动作，value 恒定）；
- **NavigationContext** → `NavigationStateContext`（view/selectedPageId/titleFocusPageId/routePersistenceStatus）+ `NavigationCommandContext`（全部导航动作，value 恒定）。

命令切片引用恒定的前提是所有命令回调不依赖会变的闭包数据：WorkspaceProvider 的命令统一经 `sessionRef`/`workspacesRef` 读取最新会话与知识库列表，useCallback 依赖只剩仓储/服务/桥等稳定引用。纯命令消费者（如 AIDraftModal、CreateWorkspaceModal、SearchPanel 的导航侧）因此完全不随数据/路由变化重渲染；命令引用稳定也让 memo 子树（PageTreeBody 等）的 props 不再因回调身份漂移失效。

聚合 hook（`useWorkspaceSession()`/`useNavigation()`）仍导出且形状不变，但仅供既有测试过渡；生产组件使用聚合 hook 会触发 `src/test/architecture.test.ts` 失败。粒度隔离由 `src/state/contextGranularity.test.tsx` 强制（renamePage 不动命令消费者、showRecent 不动导航命令消费者、命令引用跨变化稳定）。

## 知识库会话原子加载（R003 阶段 2）

- `workspaceId/pages/tags/pageTags` 由单个 `useReducer` 持有，切换知识库时经 `WorkspaceSessionService.load` 一次 `Promise.all` 拉齐（R005 阶段 6 起会话数据不再携带正文），`requestId` 递增丢弃过期响应，单次 dispatch 提交——UI 永远不会看到「新知识库 + 旧页面」。
- 会话未 ready 不进入文档视图；加载失败进 error 状态并有重试入口。
- 会话加载成功即经 `SearchIndexPort.prepareWorkspace` 准备/重建工作区级搜索索引（R005 阶段 6；索引实现自行经仓储读取页面与正文快照，Web 实现为 `BrowserMemorySearchIndex`）。

## 渲染隔离

- 每域 value 独立 memo：主题变化只扇出到 Preferences 消费者，页面重命名只扇出到会话数据消费者。由 `src/test/renderProbe.tsx` + `src/state/contextIsolation.test.tsx` + `src/state/contextGranularity.test.tsx` 强制。
- 贵价子树加 memo 边界：页面树主体 `PageTreeBody`（PageTreeSidebar）为 `React.memo`，交互状态内收。
- 派生状态不进 Context：`trashedPages`（TrashPanel 本地 useMemo）、activePage、favoritePages、树结构（`buildChildrenByParent` 邻接表，pages 变化时一次构建）。

## 偏好与路由写入（R003 阶段 3）

`PreferencesService` 串行队列合并全部偏好写入：主题/AI 配置直接排队；侧栏宽度 250ms 防抖（拖动期间内存实时更新）；路由 last-write-wins（连续导航只落盘最后一次）。仓储 `preferences.update` 在单个 readwrite 事务内读-改-写，并发更新不再互相覆盖；写入错误经 `routePersistenceStatus` 可观测。

## @ 提及候选（R003 阶段 6）

编辑器实例不随 pages 重建；扩展经 `getMentionPages` 函数 + ref 动态读取候选，新建/重命名页面后 @ 候选立即更新（`MentionRefresh.test.tsx` 验证）。

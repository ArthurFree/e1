# 状态管理

## 结构：单一状态所有者 + 窄 Context 分发

`AppProvider`（`src/state/AppState.tsx`）是唯一状态所有者：持有全部跨域状态与 actions（动作天然跨域，如 `openDocument` 同时写会话与导航），但按域 memo 出四份 value 分别注入四个窄 Context：

| Context | 文件 | 内容 |
| --- | --- | --- |
| WorkspaceSession | `WorkspaceSessionContext.tsx` | ready/error/retryLoad、workspaces/workspace、会话 status、pages/tags/pageTags、全部页面/标签/知识库写操作、search |
| Navigation | `NavigationContext.tsx` | view、selectedPageId、titleFocusPageId、routePersistenceStatus、导航动作 |
| Preferences | `PreferencesContext.tsx` | preferences、setTheme/setSidebarWidth/setAIConfig |
| Overlay | `OverlayContext.tsx` | settings/search/trash/treeDrawer 开关（自包含 Provider） |

`useApp()` 是兼容聚合门面：读四个 Context 聚合为原 AppState 全集（44 字段），既有组件与测试零改动；新代码优先用窄 hook 获得渲染隔离。

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

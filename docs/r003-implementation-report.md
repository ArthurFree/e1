# R003 架构整改实施报告

本文汇总 R003（`docs/requirements/R003.md`）全部八个阶段的实施内容，按阶段组织：目标、关键改动（含文件）、测试与验证、与原文档的偏差说明。实施分六批提交（见文末提交清单），全部验收通过。

## 阶段 0：建立基线和保护网

**目标**：修改保存逻辑与数据库结构前，先让当前行为可回归验证。

- `src/test/fixtures.ts`：确定性测试数据生成器（固定 ID/时间戳的 workspace/page/tag 工厂）+ `createDeferred`/`sleep` 时序工具。
- 五个竞态基线测试（先验证在当前实现下暴露预期缺陷，后续阶段逐一转绿）：
  - `src/components/editor/SaveConcurrency.test.tsx`：保存 A 未完成时触发 B、A 比 B 更晚完成——旧保存覆盖新内容 + 误报「已保存」；
  - `src/components/editor/SaveOnDocumentSwitch.test.tsx`：切换文档时挂起防抖保存被写入新文档（pageId 闭包缺陷）；
  - `src/components/editor/SaveAttachmentRace.test.tsx`：旧快照的孤儿清理误删新插入附件；
  - `src/state/WorkspaceSwitchRace.test.tsx`：快速连切知识库，过期响应覆盖新数据；
  - `src/state/PreferencesRace.test.tsx`：主题/侧栏宽度/路由并发更新互相覆盖。
- E2E 截图基线作为回归基准（期间发现 3 项基线因环境渲染漂移失败，经 git stash 验证与代码无关后重新生成）。

## 阶段 1：重构编辑器保存系统

**目标**：消除并发覆盖与状态误报。

- `src/application/services/SaveCoordinator.ts`：每文档一个 `DocumentSaveCoordinator`——generation 代次、串行队列（latest-wins）、旧代次不发布 saved、附件清理与间隔版本只跟随最新快照、失败保留快照可 `retryLatest()`、`flush()`/`dispose()` 语义；7 例单元测试。
- `src/application/services/documentRecovery.ts`：localStorage 恢复缓冲（正文 JSON + 代次 + 时间戳，不含附件 Blob），保存成功按代次清除；MainArea 启动比对，提示条支持恢复（立即落盘）/丢弃。
- `src/components/editor/DocumentEditor.tsx` 重写为纯装配层：快照自带编辑时的 pageId（修复切换文档写错目标）、协调器按 pageId 创建/销毁、保存状态由协调器 `onStateChange` 驱动、恢复保存经 `restoreRequestId` 触发。
- 阶段 0 的三个保存竞态测试转绿。

## 阶段 2：工作区会话原子化

**目标**：切换期间不出现新旧数据混合。

- `src/application/services/WorkspaceSessionService.ts`：一次 `Promise.all` 原子加载页面/标签/关联（阶段 7 起含正文）。
- `src/state/AppState.tsx`：workspaceId/pages/tags/pageTags 并入会话 `useReducer`；`requestId` 丢弃过期响应；单次 dispatch 提交；`openDocument`/`locatePage`/`createDocumentIn`/`createWorkspace` 跨库流程会话未 ready 不进文档视图；MainArea 增加会话 loading/error（含重试）分支。
- `WorkspaceSwitchRace.test.tsx` 转绿。

## 阶段 3：偏好与路由更新事务化

**目标**：并发偏好更新不互相覆盖。

- `preferencesRepository.update` 改为单个 readwrite 事务内读-改-写（`normalizePreferences` 提取共用）。
- `src/application/services/PreferencesService.ts`：串行写入队列；侧栏宽度 250ms 防抖持久化；路由 last-write-wins（连续导航只落盘最后一次）；错误统一经 `routePersistenceStatus` 可观测；4 例单元测试。
- `PreferencesRace.test.tsx` 转绿。

## 阶段 4：数据校验和领域不变量

**目标**：损坏正文不白屏、跨库关系不可建、错误有稳定码。

- `src/domain/errors.ts`：`DomainError` + 10 个错误码（在 R003 清单上补 `TAG_NOT_FOUND`/`CROSS_WORKSPACE_TAG`/`INVALID_INPUT`）；repositories 9 处 + pageTree 2 处中文字符串 Error 全部迁移（文案保留，code 供程序判断）。
- `src/domain/validation/documentContent.ts`：`parseDocumentContent`（白名单严格校验）+ `sanitizeDocumentContent`（尽力修复）；白名单与编辑器真实 schema 的同步由测试强制；22 例测试。
- 损坏正文 UI：MainArea 损坏面板（尝试恢复/导出原始 JSON/创建空白副本）+ `corruptedDiagnostics.ts`（localStorage 诊断记录）；VersionPanel 损坏版本拒绝恢复；恢复缓冲读取增加正文校验。
- 仓储关系约束：create/move 校验父级存在/同知识库/未删除 + kind/标题入参；`setPageTags` 校验页面/标签存在且同知识库；`repositoryInvariants.test.ts` 14 例全部按错误码断言。

## 阶段 5：建立应用层并消除基础设施泄漏

**目标**：UI 不直接依赖 IndexedDB 实现，仓储可整体替换。

- `src/application/AppServices.ts` 容器接口 + `src/state/AppServicesProvider.tsx` 注入 + `src/infrastructure/browserServices.ts` 生产装配根（main.tsx 顶层装配）。
- 12 个生产文件迁离 infrastructure 直接导入；Tiptap 附件扩展经 `editor.storage.attachmentRepository` 通道注入（唯一非 Context 通道）；删除 AppState 底部无消费方的 `export { contentRepository }`。
- `src/infrastructure/memory/`：7 个 port 纯内存实现（复用 domain/pageTree，与 IndexedDB 版共用不变量断言）+ `createInMemoryAppServices`；`AppState.memory.test.tsx` 证明 AppProvider 全流程可脱离 IndexedDB。
- `src/test/architecture.test.ts`：`import.meta.glob` 源码扫描强制分层规则（替代 ESLint）；21 个测试文件迁移到 `TestApp` 装配；`setup.ts` 补 jsdom getClientRects polyfill。

## 阶段 6：拆分 AppState

**目标**：每个 Context 只负责一个状态域，无关重渲染隔离。

- 四个窄 Context：`WorkspaceSessionContext` / `NavigationContext` / `PreferencesContext` / `OverlayContext`；AppProvider 作为单一状态所有者按域 memo 注入；`useApp()` 缩减为兼容聚合门面（44 字段全集，既有组件与测试零改动）。
- `OverlayContext` 统一 settings/search/trash/treeDrawer 开关；删除 `onOpenTree` prop 链（AppShell → MainArea → 四个页面组件）。
- 派生状态本地化：`trashedPages` 移出 Context（TrashPanel 本地 useMemo）；PageTreeSidebar 树主体提取为 `React.memo` 的 `PageTreeBody`。
- @ 提及候选改 `getMentionPages` + ref 动态读取，新建/重命名后立即更新（`MentionRefresh.test.tsx`）。
- `src/test/renderProbe.tsx` + `contextIsolation.test.tsx`：主题/重命名/开面板互不扇出，测试强制。

## 阶段 7：IndexedDB 性能优化和 v3 迁移

**目标**：消除全表扫描，数据量增长后性能不降。

- `db.ts` v3：pages 复合索引 `workspaceId_parentId` / `workspaceId_updatedAt`、trash `deletedAt`（纯索引无数据迁移）；upgrade 回调修正为 async/await；`dbV3Migration.test.ts`（v2→v3 + v1 跳级）。
- 热点查询全部改走索引：listByWorkspace/create/move/remove/restore/purge/标签列表；`purgeTrashed` 重写为六 store 单事务（共用 `purgePagesInTx`）。
- `SearchIndexService`：工作区级内存搜索索引，会话加载构建 + 页面动作 syncPages/upsertPage + 协调器 `onSaved` 增量更新；查询语义与 searchPages 等价（测试强制）。
- `buildChildrenByParent` 邻接表：collectSubtreeIds 与树渲染 O(n²) → O(n)。
- `perf.bench.test.ts` 三档基准：中型（2,000 页/1,500 文档）会话加载 264ms（< 300ms）、搜索 < 100ms、清空回收站一次事务；大型（10,000 页）listByWorkspace < 1s。

## 阶段 8：文档、监控和架构约束

**目标**：文档与代码一致、重大决策有 ADR、开发期可观测。

- 文档重组：`docs/architecture/` 六主题（overview/dependency-rules/state-management/persistence/editor-save-pipeline/error-handling）按当前代码重写；`docs/adr/` 四 ADR（001 本地优先、002 文档 JSON 唯一真相、003 SaveCoordinator、004 应用层与服务容器）；`docs/migrations/indexeddb-v3.md`；`docs/architecture.md` 改索引页；README 同步。
- 架构约束核对：R003 §8.2 规则清单已由阶段 5 的扫描测试全覆盖。
- `src/application/devDiagnostics.ts` 开发诊断：六项指标（workspace-load/search-query/save-queue/idb-save/db-migration/corrupted-content），仅 Vite dev 启用、生产与测试静默，不记录正文与密钥；五处埋点 + 4 例测试。

## 与 R003 原文档的偏差

1. **未另建 25 个 use-case 类**（§5.2）：用例编排由 AppState actions + application 服务承载，容器按领域分组暴露 port，语义等价（决策见 decisions.md）。
2. **未加 `isDeleted`/`isFavorite` 规范化列**（§7.1）：所有回收站过滤都在工作区数据集内内存完成，无 nullable 等值索引需求。
3. **架构约束用 vitest 扫描替代 ESLint**（§8.2）：项目无 ESLint 依赖，R003 允许「ESLint 或脚本」。
4. **诊断记录暂存 localStorage**（§4.1）：损坏诊断记录待后续版本再迁入 IndexedDB store。
5. 错误码在 R003 清单基础上补了 `TAG_NOT_FOUND` / `CROSS_WORKSPACE_TAG` / `INVALID_INPUT`（§4.2/§4.3 的标签与入参约束需要）。

## 提交清单

| 批次   | 阶段                       | 提交      |
| ------ | -------------------------- | --------- |
| 第一批 | 0–3（基线/保存/会话/偏好） | `99155cd` |
| 第二批 | 4（校验与不变量）          | `dc39a8d` |
| 第三批 | 5（应用层/DI）             | `74f789c` |
| 第四批 | 6（AppState 拆分）         | `0bc85e6` |
| 第五批 | 7（v3 性能）               | `1bafec2` |
| 第六批 | 8（文档/ADR/诊断）         | `163aad9` |

## 最终质量基线

- 单元/组件测试：317（含竞态基线、不变量、schema 同步、Context 隔离、内存容器集成、v3 迁移、三档性能基准）；
- Playwright：43（功能 15、视觉基线 13 + 四档宽度 8 + 深色开始页、响应式 6）；
- `npm run typecheck`、`npm run build` 全部通过。

# 持久化

## 数据库

单一 IndexedDB 数据库 `notion-like-web`（`src/platform/web/persistence/db.ts`），当前版本 **v5**。10 个 object store：workspaces、pages、contents、tags、pageTags、preferences、trash、revisions、attachments、**secrets**。

索引（v5，相对 v4 无新增索引；v5 仅新增 secrets store 与偏好机密迁移）：

| store       | 索引                                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------- |
| pages       | `workspaceId`、`parentId`、`deletedAt`、`updatedAt`、`workspaceId_parentId`（复合）、`workspaceId_updatedAt`（复合） |
| contents    | `updatedAt`、`textSnapshot`、`workspaceId`、`workspaceId_updatedAt`（复合）                                          |
| tags        | `workspaceId`                                                                                                        |
| pageTags    | `pageId`、`tagId`、`workspaceId`                                                                                     |
| revisions   | `pageId`、`pageId_createdAt`（复合）                                                                                 |
| attachments | `pageId`                                                                                                             |
| trash       | `deletedAt`                                                                                                          |
| workspaces  | `updatedAt`                                                                                                          |
| secrets     | （无二级索引；`keyPath: "name"`）                                                                                    |

注意：IndexedDB 索引排除键为 `null`/缺失的记录（如 `parentId: null` 的顶层页面不进 `workspaceId_parentId`）；顶层兄弟查询回退到「`workspaceId` 索引 + 内存过滤」。nullable 字段不建等值查询索引，因此未加 `isDeleted/isFavorite` 规范化列。v4 为 contents/pageTags 补齐 `workspaceId` 字段（孤立记录不回写、被索引天然排除），工作区会话加载不再跨库全表扫描，详见 [../migrations/indexeddb-v4.md](../migrations/indexeddb-v4.md)。v5 将 AI `apiKey` 从偏好记录迁入 `secrets` store（SecretStore），详见 [../migrations/indexeddb-v5.md](../migrations/indexeddb-v5.md)。

## 迁移策略

- `DB_VERSION` 递增 + `getDB()` 的 upgrade 回调按 `oldVersion` 分支逐级叠加（v1 schema → v2 数据迁移 → v3 索引 → v4 字段回写 + 索引 → v5 secrets store + apiKey 剥离），回调为 async，全部分支 await。
- 迁移链：v1 → v2 → v3 → v4 → v5（跳级打开时分支按顺序叠加执行）。
- 迁移全部在 versionchange 事务内完成，失败即整体回滚，不留半升级数据库。
- 迁移测试：`platform/web/persistence/migration.test.ts`（v1 真实 fixture）、`dbV3Migration.test.ts`（v2→v3 与 v1 跳级）、`dbV4Migration.test.ts`（v1/v2/v3→v4 与孤立记录）、`dbV5Migration.test.ts`（v4→v5 与 v1 跳级、apiKey 迁 secrets）。迁移文档见 [../migrations/](../migrations/)。

## 仓储横切策略（`src/platform/web/persistence/repositories.ts`）

- **损坏数据降级**：读路径一律经 `normalize*`/`isValid*` 校验，核心字段非法的记录跳过或回退默认值；写路径经 `getRequiredPage` 显式抛错。
- **多步写入单事务**：页面+正文、软删、purge 级联、清空回收站（六 store 一次事务）、偏好读-改-写、正文保存（读 page 补 `workspaceId` 后写 contents，页面不存在抛 `PAGE_NOT_FOUND`）。
- **索引查询**：listByWorkspace（页面/正文/标签/标签关联）/create/move/remove/restore/purge 全部走索引；跨库全量查询（`listAll`）仅用于最近/收藏等全局视图与 WorkspaceHome 总字数。
- **关系约束（R003 阶段 4）**：create/move 校验父级存在/同知识库/未删除；`setPageTags` 校验页面与标签存在且同知识库；kind 与标题入参校验。错误统一为 `DomainError` + 稳定错误码（`src/domain/errors.ts`）。
- **seed**：首次启动惰性写入预置知识库，模块级 Promise 防并发重复种子。
- **机密**：AI `apiKey` 不经 preferences 仓储读写；经 `SecretStore`（Web：`src/platform/web/persistence/secretStore.ts`，store `secrets`）与 `AIConfigService` 组装。

## 内存仓储

`src/infrastructure/memory/` 实现全部 8 个仓储 port（复用 `domain/pageTree` 纯函数，语义与 IndexedDB 版一致，共用不变量断言与 DocumentWrite 契约套件）。用途：可替换性证明（AppProvider 全流程脱离 IndexedDB 运行）与未来存储后端参照。SecretStore / RecoveryStore / StorageHealth 亦有内存实现。

## 搜索

搜索索引抽象为 `SearchIndexPort`（`src/application/services/SearchIndexPort.ts`，R005 阶段 6），Web 实现为工作区级内存索引 `BrowserMemorySearchIndex`（`src/platform/web/search/`，Desktop 未来可换 SQLite 实现）。会话加载不再携带正文：`prepareWorkspace(workspaceId)` 由索引实现自行经仓储读取页面与正文快照（`page.listByWorkspace` + `content.listByWorkspace`），幂等、重复调用等价于 `rebuild`。页面写操作 `syncPages`/`upsertDocument` 同步元数据、正文保存经 `DocumentCommitService.commit` 的 `updateText` 增量更新；查询语义与 `domain/search.ts` 的 `searchPages` 完全等价（测试强制）。索引未准备时查询返回空，由调用方回退全量扫描路径。索引是派生数据，同步失败不反向影响保存主流程。

### Desktop 搜索派生索引（R008 Stage 3 契约冻结）

Desktop 全文搜索沿用同一「派生数据」原则并固化为契约（R8-03/R8-04）：

- **Markdown 是唯一正文真相，搜索索引是可完整重建的 derived data**——删除索引后重扫 Vault 即恢复全部搜索能力；索引数据绝不反向覆盖 Markdown；索引失败只进入 `degraded`/`corrupt` 状态，不阻断正文保存（R8-06）。
- **契约落点**：`src/application/services/SearchContract.ts`——`SearchDocument`（`bodyText` 经 `shared/markdown/searchText.ts` 的 `markdownToSearchText` 从 Markdown 提取，Main 与 Renderer 共用同一实现）、`SearchResult`、`SearchIndexStatus` 五态（missing/building/ready/degraded/corrupt）与 port `FullTextSearchIndexPort`（prepareWorkspace/search/upsert/remove/rebuild/getStatus）。查询语义由契约层纯函数 `rankSearchDocuments` 可执行化（title > tag > body 权重 + 同分稳定排序 + limit ≤ 100），与底层存储/分词器解耦。
- **Port 隔离（R8-04）**：`application/`、`domain/`、`components/` 只依赖该 port，禁止出现 `node:sqlite`/`better-sqlite3`/SQL 语句；Stage 4 的 SQLite 实现（`userData/search-index/<vaultId>.sqlite`，设备级派生状态，不进 Vault）经 adapter 接入，推荐「FTS 召回候选 + 契约层精排」。
- **可替换性证明**：内存参照实现 `src/infrastructure/memory/fullTextSearchIndex.ts` 与 Stage 4 的 Desktop 实现必须通过同一契约套件（`src/test/searchIndexContract.ts`，含中文验收语料 `fixtures/search/corpus.ts`）与性能基线（`src/test/searchIndex.perf-wallclock.test.ts`，`fixtures/search/generator.ts` 确定性生成 1k/10k/50k）。
- 与既有标题搜索 `SearchIndexPort`（workspaceId 语义，Web 现行链路）并存、互不影响；装配切换属 Stage 4。

## 恢复缓冲与损坏诊断（localStorage）

- `pending-document-recovery:{pageId}`：未落盘正文快照兜底（beforeunload 不保证 IndexedDB 写入完成），保存成功即清除；读取时经正文白名单校验（Web 经 `RecoveryStore` port，实现见 `platform/web/webRecoveryStore.ts`）。
- `diagnostic:corrupted-document:{pageId}`：正文校验失败时的原始数据留存，供「尝试恢复 / 导出原始 JSON / 创建空白副本」。两类 localStorage 数据均不超出本地数据源边界。

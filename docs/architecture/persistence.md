# 持久化

## 数据库

单一 IndexedDB 数据库 `notion-like-web`（`src/infrastructure/db.ts`），当前版本 **v4**。9 个 object store：workspaces、pages、contents、tags、pageTags、preferences、trash、revisions、attachments。

索引（v4）：

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

注意：IndexedDB 索引排除键为 `null`/缺失的记录（如 `parentId: null` 的顶层页面不进 `workspaceId_parentId`）；顶层兄弟查询回退到「`workspaceId` 索引 + 内存过滤」。nullable 字段不建等值查询索引，因此未加 `isDeleted/isFavorite` 规范化列。v4 为 contents/pageTags 补齐 `workspaceId` 字段（孤立记录不回写、被索引天然排除），工作区会话加载不再跨库全表扫描，详见 [../migrations/indexeddb-v4.md](../migrations/indexeddb-v4.md)。

## 迁移策略

- `DB_VERSION` 递增 + `getDB()` 的 upgrade 回调按 `oldVersion` 分支逐级叠加（v1 schema → v2 数据迁移 → v3 索引 → v4 字段回写 + 索引），回调为 async，全部分支 await。
- 迁移全部在 versionchange 事务内完成，失败即整体回滚，不留半升级数据库。
- 迁移测试：`migration.test.ts`（v1 真实 fixture）、`dbV3Migration.test.ts`（v2→v3 与 v1 跳级）、`dbV4Migration.test.ts`（v1/v2/v3→v4 与孤立记录）。迁移文档见 [../migrations/](../migrations/)。

## 仓储横切策略（`src/infrastructure/repositories.ts`）

- **损坏数据降级**：读路径一律经 `normalize*`/`isValid*` 校验，核心字段非法的记录跳过或回退默认值；写路径经 `getRequiredPage` 显式抛错。
- **多步写入单事务**：页面+正文、软删、purge 级联、清空回收站（六 store 一次事务）、偏好读-改-写、正文保存（读 page 补 `workspaceId` 后写 contents，页面不存在抛 `PAGE_NOT_FOUND`）。
- **索引查询**：listByWorkspace（页面/正文/标签/标签关联）/create/move/remove/restore/purge 全部走索引；跨库全量查询（`listAll`）仅用于最近/收藏等全局视图与 WorkspaceHome 总字数。
- **关系约束（R003 阶段 4）**：create/move 校验父级存在/同知识库/未删除；`setPageTags` 校验页面与标签存在且同知识库；kind 与标题入参校验。错误统一为 `DomainError` + 稳定错误码（`src/domain/errors.ts`）。
- **seed**：首次启动惰性写入预置知识库，模块级 Promise 防并发重复种子。

## 内存仓储

`src/infrastructure/memory/` 实现全部 8 个仓储 port（复用 `domain/pageTree` 纯函数，语义与 IndexedDB 版一致，共用不变量断言与 DocumentWrite 契约套件）。用途：可替换性证明（AppProvider 全流程脱离 IndexedDB 运行）与未来存储后端参照。

## 搜索

工作区级内存索引（`SearchIndexService`）：会话加载时一次构建（页面 + 正文快照），页面写操作 `syncPages`/`upsertPage` 同步、正文保存经 `DocumentCommitService.commit` 增量更新；查询语义与 `domain/search.ts` 的 `searchPages` 完全等价（测试强制）。索引未构建时回退全量扫描路径。

## 恢复缓冲与损坏诊断（localStorage）

- `pending-document-recovery:{pageId}`：未落盘正文快照兜底（beforeunload 不保证 IndexedDB 写入完成），保存成功即清除；读取时经正文白名单校验。
- `diagnostic:corrupted-document:{pageId}`：正文校验失败时的原始数据留存，供「尝试恢复 / 导出原始 JSON / 创建空白副本」。两类 localStorage 数据均不超出本地数据源边界。

# IndexedDB v4 迁移说明

## 变更清单（v3 → v4）

数据回写 + 索引迁移（R004 阶段 5）：消除工作区会话加载的跨库全表扫描。

| store    | 字段变更                                             | 新增索引                                       | 用途                                                                   |
| -------- | ---------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------- |
| contents | 补 `workspaceId`（由 pageId → workspaceId 映射回写） | `workspaceId`、`workspaceId_updatedAt`（复合） | 工作区正文按索引加载（`ContentRepository.listByWorkspace`）            |
| pageTags | 补 `workspaceId`（同源回写）                         | `workspaceId`                                  | 工作区页面-标签关联按索引加载（`TagRepository.listWorkspacePageTags`） |

类型同步：`DocumentContent` 与 `PageTag` 均增加 `workspaceId: string`。

## 迁移过程

全部在 versionchange 事务内完成：

1. 遍历 pages 建立 `pageId → workspaceId` 映射；
2. 创建三个新索引；
3. 游标遍历 contents 与 pageTags，逐条回写 `workspaceId`。

**孤立记录**（页面已不存在的正文/标签关联）：不猜测、不删除、不回写，统计数量经 `console.warn` + `devDiagnostics.increment("db-migration", …)` 记录（仅数量，不含内容）。因缺 `workspaceId` 键，这些记录天然被排除在新索引之外（IndexedDB 索引排除缺失键，见 v3 说明的 nullable 索引行为），不进工作区查询结果。

迁移失败由升级事务天然整体回滚，无 try/catch 吞错。

## 写入路径约束

- `contentRepository.save`：单事务 `[pages, contents]`，先按键读 page 取 `workspaceId` 再写；页面不存在/损坏抛 `PAGE_NOT_FOUND`（由静默 upsert 收紧为显式失败）。
- `pageRepository.create` / `documentWriteRepository.createWithContent` / `replaceContent` / `tagRepository.setPageTags`：写 contents/pageTags 均带 `workspaceId`。
- 读路径 `listAll`/`listByWorkspace` 共用 `isValidContent` 校验：缺 `workspaceId` 的记录按损坏跳过（孤立正文不再计入跨库总字数，语义更正确）。

## 测试

`src/platform/web/persistence/dbV4Migration.test.ts`：空库→v4、v3→v4（索引 + 回写 + 新查询）、v2→v4、v1→v4 跳级、含孤立正文/孤立 pageTag 的 v3→v4（孤立记录原样保留、不进工作区查询）。多工作区基准（20 库 × 500 页面）见 `perf.bench.test.ts`：会话加载只读目标库正文、不再调用 `listAll`。

## 回滚

不支持降级 `DB_VERSION` 回退（浏览器拒绝低版本打开）。v4 为字段补齐 + 新索引：旧版代码（v3）可打开 v4 数据库（多余字段与索引被忽略），但 v3 代码写出的新记录不含 `workspaceId`，会在 v4 读路径被按损坏跳过——回退到 v3 代码运行不应超过一个保存周期。

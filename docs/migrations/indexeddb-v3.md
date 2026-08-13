# IndexedDB v3 迁移说明

## 变更清单（v2 → v3）

纯索引迁移，无数据改写：

| store | 新增索引                        | 用途                        |
| ----- | ------------------------------- | --------------------------- |
| pages | `workspaceId_parentId`（复合）  | 同知识库同父级兄弟查询      |
| pages | `workspaceId_updatedAt`（复合） | 工作区内按更新时间排序/过滤 |
| trash | `deletedAt`                     | 回收站时间维度操作          |

同时把 upgrade 回调修正为 async（v2 分支此前未 await 的遗留问题一并修复）。

## nullable 索引行为

IndexedDB 索引会排除键为 `null` 的记录：`parentId: null` 的顶层页面不进 `workspaceId_parentId`。顶层兄弟查询回退到「`workspaceId` 索引 + 内存过滤」。因此 v3 **未**为 `deletedAt`/`favoriteAt` 等 nullable 字段增加 `isDeleted`/`isFavorite` 规范化列——当前所有回收站过滤都在工作区数据集内内存完成，无等值索引需求。

## 原子性

迁移全部在 versionchange 事务内完成：任一步失败，整个 upgrade 回滚，数据库保持旧版本，不会留下半升级状态。迁移测试：`src/platform/web/persistence/dbV3Migration.test.ts`（v2→v3 索引就位 + 数据完整、v1 跳级叠加生效）。

## 回滚

不支持降级 `DB_VERSION` 回退（浏览器会拒绝以低版本打开）。由于 v3 只新增索引，旧版代码（v2）可以正常打开 v3 数据库——多余索引被忽略，无需回滚操作。

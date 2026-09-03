/**
 * 派生链接索引 port（R010 Stage 3 §6/§11，LINK-03）：Application 层只依赖
 * 本接口，不感知 SQLite/IPC（禁止 application/domain/components import
 * node:sqlite/SQL 语句）。
 *
 * 类型与契约统一定义在 shared/links/LinkIndex.ts（Renderer 与 Electron
 * Main 共用；本文件重导出保持 application 既有消费路径风格一致）。
 * 状态机复用 application/search/SearchIndexStatus（同一五态类型）。
 */
export type {
  LinkIndex,
  LinkIndexDocument,
} from "../../../shared/links/LinkIndex";
export type { Backlink, DocumentLink } from "../../../shared/links/types";

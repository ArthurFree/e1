/**
 * 全文搜索索引 port（R008 Stage 3 §10，R8-04）：Application 层只依赖
 * 本接口，不感知 SQLite/IPC（禁止 application/domain/components import
 * node:sqlite/better-sqlite3/SQL 语句）。
 *
 * 类型与契约统一定义在 shared/search/FullTextSearchIndex.ts（Renderer 与
 * Electron Main 共用；本文件重导出保持 application 既有消费路径不变）。
 *
 * 与既有 SearchIndexPort（Web 标题/正文内存索引）并存互不影响：
 * SearchIndexPort 服务 Web 语义（workspace 分桶、与 domain searchPages
 * 等价）；本 port 服务 Desktop 全文搜索（vault 维度、stable id/相对路径
 * 身份、matchedField/score/snippet、状态机）。
 */
export type {
  FullTextSearchIndex,
  FullTextSearchInput,
  FullTextSearchResult,
  SearchDocument,
  SearchMatchField,
} from "../../../shared/search/FullTextSearchIndex";
export {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  SEARCH_SCORE,
} from "../../../shared/search/FullTextSearchIndex";

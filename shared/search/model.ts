/**
 * 全文搜索模型类型（R008 Stage 3 §10.3–§10.5 冻结；Stage 4 自
 * src/application/services/SearchContract.ts 平移至 shared/）。
 *
 * 平移原因（与 shared/markdown/frontmatter.ts / searchText.ts 同先例）：
 * Electron Main 的搜索实现（electron/main/search/）需要与 Renderer 完全
 * 一致的 SearchDocument/SearchResult/SearchIndexStatus 形状，而 electron
 * 不得 import src（分层约束）——模型类型零依赖、环境中立，满足 shared/
 * 要求。src/application/services/SearchContract.ts 原样 re-export，
 * 既有 import 路径与冻结契约表面不变。
 *
 * shared/ 不得 import src/electron；本模块不得新增任何运行时依赖。
 */

/** 搜索命中的字段来源。 */
export type SearchMatchedField = "title" | "tag" | "body";

/**
 * 一条待索引文档（§10.3 终值）。bodyText 必须经
 * shared/markdown/searchText.ts 的 markdownToSearchText 提取，
 * 不得直接索引原始 Markdown 语法文本。
 */
export interface SearchDocument {
  pageId: string;
  vaultId: string;
  /** Frontmatter stable note id；未分配（新文档未落盘）时为 null。 */
  stableNoteId: string | null;
  /** Vault 内相对路径（展示与 reveal 辅助；不出现绝对路径）。 */
  relativePath: string;
  title: string;
  tags: string[];
  /** markdownToSearchText 提取的可检索纯文本。 */
  bodyText: string;
  createdAt: number | null;
  updatedAt: number | null;
  /** 正文版本令牌（Desktop 为内容 SHA256），增量索引据此判重。 */
  versionToken: string;
}

/** 一条搜索结果（§10.4 终值）。 */
export interface SearchResult {
  pageId: string;
  /** 展示标题；空标题回退「无标题」。 */
  title: string;
  /** 产生最高得分的命中字段（title > tag > body）。 */
  matchedField: SearchMatchedField;
  /** 正文命中处的上下文片段（保留原文大小写）；正文未命中为 null。 */
  snippet: string | null;
  /** 排序得分（仅用于排序，不承诺跨版本可比）。 */
  score: number;
  relativePath?: string;
}

/** 索引状态机（§13.1 终值）。 */
export type SearchIndexStatus =
  | { state: "missing" }
  | { state: "building"; progress?: number }
  | { state: "ready"; indexedDocuments: number }
  | { state: "degraded"; reason: string }
  | { state: "corrupt"; reason: string };

/** rebuild 结果（§10.5）：重建耗时供 benchmark 对照。 */
export interface SearchRebuildResult {
  indexedDocuments: number;
  durationMs: number;
}

export interface SearchQueryInput {
  /** 缺省表示跨全部已索引 vault 合并查询（结果按全局得分重排）。 */
  vaultId?: string;
  query: string;
  /** 请求条数上限；超过 SEARCH_LIMIT_MAX 按上限截断。 */
  limit: number;
}

export interface SearchRemoveInput {
  vaultId: string;
  pageId: string;
}

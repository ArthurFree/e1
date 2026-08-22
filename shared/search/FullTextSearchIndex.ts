/**
 * 全文搜索索引契约（R008 Stage 3 §10，R8-04）：Desktop 全文搜索的
 * 环境中立 port 与文档/结果类型——Renderer（application/components 经
 * src/application/search/FullTextSearchIndex.ts 重导出消费）与
 * Electron Main（SQLite 实现/契约套件）共用同一来源。
 *
 * 语义冻结（契约套件强制，见 shared/search/fullTextSearchContract.ts）：
 * - 范围：title / tags / body（bodyText 由 shared/markdown/plainText 提取，
 *   不含 Markdown 语法）；
 * - 归一：NFKC + lowercase；查询 trim 后为空 → []；Unicode/中文必须支持；
 * - body 命中：查询按空白切词，逐项 CJK bigram 覆盖 / 拉丁词前缀，AND；
 * - 评分：exact title 100 > title prefix 80 > title contains 60 >
 *   tag match 40 > body match 20（§11.7）；
 * - 排序：score 降序 → title localeCompare("zh-CN") → pageId（稳定）；
 * - limit 缺省 50，上限 100；
 * - 索引是 derived data（R8-03）：删除索引库后可从 Markdown 全量 rebuild；
 *   upsert/remove 幂等；relocate 保持页面身份只改路径。
 *
 * 实现：
 * - 内存参照：src/infrastructure/memory/fullTextSearchIndex.ts（契约基准）；
 * - Desktop：SQLite（Electron Main node:sqlite，Stage 4）+ IPC 适配（Stage 5）。
 */
import type { SearchIndexStatus } from "../ipc/contracts.js";

export type { SearchMatchField } from "./textMatch.js";

/** 索引一条文档所需的全部字段（§10.3 SearchDocument）。 */
export interface SearchDocument {
  pageId: string;
  vaultId: string;
  /** Frontmatter 稳定 id；无 id 文档为 null（path 身份）。 */
  stableNoteId: string | null;
  /** 相对 Vault 根的 POSIX 路径（relocate 的更新目标）。 */
  relativePath: string;
  title: string;
  tags: string[];
  /** shared/markdown/plainText 提取的可搜索纯文本（非原始 Markdown）。 */
  bodyText: string;
  createdAt: number | null;
  updatedAt: number | null;
  /** 内容版本令牌（modified 事件的增量去重依据，§12.3）。 */
  versionToken: string;
}

/** 单条搜索结果（§10.4）。 */
export interface FullTextSearchResult {
  pageId: string;
  title: string;
  /** 命中的最高优先级字段（title > tag > body）。 */
  matchedField: import("./textMatch.js").SearchMatchField;
  /** body 命中时的纯文本 snippet（无 HTML）；title/tag 命中为 null。 */
  snippet: string | null;
  /** 排序依据（评分表见文件头；同分按 title zh-CN、pageId 稳定排序）。 */
  score: number;
  relativePath?: string;
}

export interface FullTextSearchInput {
  /** 缺省表示跨全部已索引 Vault。 */
  vaultId?: string;
  query: string;
  /** 缺省 50；上限 MAX_SEARCH_LIMIT（100）。 */
  limit?: number;
}

/** §10.6 / §11.7：limit 与评分表（统一定义在 ./textMatch.js，两实现共用）。 */
export {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  SEARCH_SCORE,
} from "./textMatch.js";

export interface FullTextSearchIndex {
  /**
   * 删除并重建指定 Vault 的索引。documents 由调用方从真实数据源
   *（Markdown）供给；实现侧自读的实现（Main 批量索引）可忽略该参数。
   * 幂等；完成后 getStatus(vaultId).state === "ready"。
   */
  rebuild(
    vaultId: string,
    documents?: Iterable<SearchDocument> | AsyncIterable<SearchDocument>,
  ): Promise<void>;

  /** 查询；索引未 ready 的实现返回 []（调用方决定降级路径）。 */
  search(input: FullTextSearchInput): Promise<FullTextSearchResult[]>;

  /** 单文档 upsert（created/modified/self-write 提交）；幂等。 */
  upsert(document: SearchDocument): Promise<void>;

  /** 删除单条索引（deleted）；对缺失条目为 no-op（幂等）。 */
  remove(input: { vaultId: string; pageId: string }): Promise<void>;

  /**
   * 移动/重命名文件（moved）：保持页面身份（pageId/stableNoteId）只更新
   * relativePath；实现复杂时允许 read + upsert 等价实现。
   */
  relocate(input: {
    vaultId: string;
    pageId: string;
    relativePath: string;
  }): Promise<void>;

  /** 索引状态（同步快照；IPC 实现为 Renderer 侧镜像）。 */
  getStatus(vaultId: string): SearchIndexStatus;
}

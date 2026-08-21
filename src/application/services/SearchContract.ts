/**
 * 全文搜索契约（R008 Stage 3 §10.3–§10.6 冻结）：Desktop 全文搜索的
 * 文档模型、结果模型、状态模型、port 接口与可执行查询语义。
 *
 * 与既有 `SearchIndexPort`（同目录，R005 标题搜索）的关系：
 * - 既有 port 服务 Web 标题搜索链路（workspaceId 语义 + 仓储取数），
 *   其实现与装配（BrowserMemorySearchIndex / DesktopTitleSearchIndex /
 *   SearchQueryService 回退路径）本阶段一律不动；
 * - 本契约是独立的全文搜索 port（vaultId 语义 + tags/body/权重排序/
 *   状态模型），Stage 4 的 Desktop SQLite 实现与内存参照实现
 *   （src/infrastructure/memory/fullTextSearchIndex.ts）都必须通过同一套
 *   契约测试（src/test/searchIndexContract.ts，R8-04）。
 *
 * 架构不变量（R008 §5）：
 * - R8-03：索引是可重建派生数据，Markdown/仓储是唯一正文真相，
 *   索引数据绝不反向覆盖正文；
 * - R8-04：application/domain/components 只依赖本接口，不得出现
 *   node:sqlite / better-sqlite3 / SQL 语句；
 * - R8-06：任何索引失败不得阻断正文保存（调用侧容错，索引进入
 *   degraded 后自动修复或重建）。
 *
 * 查询语义不按注释「约定」而由本模块纯函数直接实现
 * （rankSearchDocuments），所有实现的查询路径必须复用这些函数或
 * 通过契约测试证明等价——Stage 4 推荐「FTS 召回候选 + 本模块精排」，
 * 使排序语义与底层分词器解耦（中文方案倾向 B，见 R008 §10.9）。
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

/**
 * 全文搜索索引 port（§10.5 终值）。所有方法幂等；任何实现不得因索引
 * 内部错误抛出影响正文主流程的异常（实现自行归一并通过 getStatus
 * 暴露 degraded/corrupt）。
 */
export interface FullTextSearchIndexPort {
  /**
   * 准备（必要时创建）一个 vault 的索引；幂等。首次打开无索引的
   * Vault 后，重建/增量 upsert 驱动其进入 ready（§11.5），
   * 准备过程不得阻断页面树与编辑器。
   */
  prepareWorkspace(vaultId: string): Promise<void>;

  /**
   * 查询。vaultId 缺省时跨 vault 合并；索引 missing/building 的
   * vault 贡献空结果（由调用方决定回退或提示，§20）。
   */
  search(input: SearchQueryInput): Promise<SearchResult[]>;

  /**
   * 单文档 upsert：同 pageId 覆盖（旧文本立即消失）；同一文档重复
   * upsert 不产生重复结果。versionToken 未变化时实现可判重 no-op。
   */
  upsert(doc: SearchDocument): Promise<void>;

  /** 移除单条索引；条目或 vault 不存在时为 no-op。 */
  remove(input: SearchRemoveInput): Promise<void>;

  /**
   * 丢弃派生索引并从正文真相完整重建（§13.4 手动重建与 §13.3 损坏
   * 恢复共用本通道）。重建期间状态为 building，完成后 ready；
   * 重建不得触碰 Markdown。
   */
  rebuild(vaultId: string): Promise<SearchRebuildResult>;

  /** 查询 vault 的索引状态；未知 vault 返回 missing。 */
  getStatus(vaultId: string): Promise<SearchIndexStatus>;
}

/* ------------------------------------------------------------------ */
/* 可执行查询语义（§10.6 / §11.7 冻结）                                 */
/* ------------------------------------------------------------------ */

/** limit 硬上限（§10.6）。 */
export const SEARCH_LIMIT_MAX = 100;

/** snippet 命中处前后各保留的字符数。 */
export const SEARCH_SNIPPET_RADIUS = 30;

/**
 * 排序权重（§11.7 终值）：
 * exact title > title prefix > title contains > tag match > body match。
 */
export const SEARCH_SCORE = {
  titleExact: 100,
  titlePrefix: 80,
  titleContains: 60,
  tagExact: 45,
  tagContains: 40,
  bodyContains: 20,
} as const;

/**
 * 查询归一化（§10.6）：trim + 小写化（Unicode 安全；不做音调/繁简折叠，
 * 第一版不支持）。中文无需分词——子串匹配天然覆盖。
 */
export function normalizeSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * limit 截断：向下取整后夹在 [0, SEARCH_LIMIT_MAX]；非有限数与 ≤0
 * 归一为 0（空结果）。
 */
export function clampSearchLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 0;
  return Math.min(SEARCH_LIMIT_MAX, Math.max(0, Math.floor(limit)));
}

export interface SearchMatch {
  score: number;
  matchedField: SearchMatchedField;
}

/**
 * 单文档对归一化查询的匹配与得分；不匹配返回 null。
 * normalizedQuery 必须经 normalizeSearchQuery 处理。
 */
export function scoreSearchDocument(
  doc: SearchDocument,
  normalizedQuery: string,
): SearchMatch | null {
  if (normalizedQuery === "") return null;
  const title = doc.title.toLowerCase();
  if (title === normalizedQuery) {
    return { score: SEARCH_SCORE.titleExact, matchedField: "title" };
  }
  if (title.startsWith(normalizedQuery)) {
    return { score: SEARCH_SCORE.titlePrefix, matchedField: "title" };
  }
  if (title.includes(normalizedQuery)) {
    return { score: SEARCH_SCORE.titleContains, matchedField: "title" };
  }
  let tagMatch: SearchMatch | null = null;
  for (const tag of doc.tags) {
    const normalizedTag = tag.toLowerCase();
    if (normalizedTag === normalizedQuery) {
      tagMatch = { score: SEARCH_SCORE.tagExact, matchedField: "tag" };
      break;
    }
    if (tagMatch === null && normalizedTag.includes(normalizedQuery)) {
      tagMatch = { score: SEARCH_SCORE.tagContains, matchedField: "tag" };
    }
  }
  if (tagMatch !== null) return tagMatch;
  if (doc.bodyText.toLowerCase().includes(normalizedQuery)) {
    return { score: SEARCH_SCORE.bodyContains, matchedField: "body" };
  }
  return null;
}

/**
 * 正文命中处的上下文片段（原文大小写保留，两端超出以省略号标示）。
 * 正文未命中返回 null（title/tag 命中且正文不含查询词时为 null）。
 */
export function makeSearchSnippet(
  bodyText: string,
  normalizedQuery: string,
): string | null {
  if (normalizedQuery === "") return null;
  const hit = bodyText.toLowerCase().indexOf(normalizedQuery);
  if (hit === -1) return null;
  const start = Math.max(0, hit - SEARCH_SNIPPET_RADIUS);
  const end = Math.min(
    bodyText.length,
    hit + normalizedQuery.length + SEARCH_SNIPPET_RADIUS,
  );
  return `${start > 0 ? "…" : ""}${bodyText.slice(start, end)}${
    end < bodyText.length ? "…" : ""
  }`;
}

/**
 * 稳定排序比较器（§10.6）：score 降序 → 展示标题码元升序 → pageId
 * 码元升序。与插入顺序、迭代顺序无关，保证跨实现确定性。
 */
export function compareSearchResults(a: SearchResult, b: SearchResult): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  if (a.pageId !== b.pageId) return a.pageId < b.pageId ? -1 : 1;
  return 0;
}

/**
 * 查询语义唯一实现：归一化 → 打分 → 稳定排序 → limit 截断。
 * 空查询 / limit 为 0 返回 []；空标题结果展示为「无标题」。
 */
export function rankSearchDocuments(
  documents: Iterable<SearchDocument>,
  query: string,
  limit: number,
): SearchResult[] {
  const normalizedQuery = normalizeSearchQuery(query);
  const cappedLimit = clampSearchLimit(limit);
  if (normalizedQuery === "" || cappedLimit === 0) return [];
  const results: SearchResult[] = [];
  for (const doc of documents) {
    const match = scoreSearchDocument(doc, normalizedQuery);
    if (match === null) continue;
    results.push({
      pageId: doc.pageId,
      title: doc.title || "无标题",
      matchedField: match.matchedField,
      snippet: makeSearchSnippet(doc.bodyText, normalizedQuery),
      score: match.score,
      relativePath: doc.relativePath,
    });
  }
  results.sort(compareSearchResults);
  return results.slice(0, cappedLimit);
}

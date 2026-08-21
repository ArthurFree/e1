/**
 * 全文搜索可执行查询语义（R008 Stage 3 §10.6/§11.7 冻结；Stage 4 自
 * src/application/services/SearchContract.ts 平移至 shared/）。
 *
 * 平移原因与 shared/search/model.ts 相同：Electron Main 的 SQLite 搜索
 * 实现必须复用同一套归一化/打分/排序/snippet 纯函数（「存储召回 +
 * 契约层精排」分层，中文方案 B 的精排层），electron 不得 import src，
 * 故实现唯一来源下沉 shared/。src/application/services/SearchContract.ts
 * 原样 re-export，冻结契约表面不变。
 *
 * 零依赖、环境中立（不触 Node/DOM API）；NodeNext 下以 .js 扩展名引用。
 */
import type {
  SearchDocument,
  SearchMatchedField,
  SearchResult,
} from "./model.js";

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

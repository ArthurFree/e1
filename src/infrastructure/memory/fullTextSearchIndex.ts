/**
 * R008 Stage 3（§10）：FullTextSearchIndex 的内存参照实现——
 * 契约语义的基准（与 Desktop SQLite 实现跑同一套契约套件，
 * src/test/fullTextSearchContract.ts）。
 *
 * 匹配/评分/排序规则全部来自 shared/search/textMatch 与
 * application/search/FullTextSearchIndex 的冻结定义；纯内存 Map，
 * 不触碰浏览器/Node API（内存测试容器同形状复用）。
 */
import type {
  FullTextSearchIndex,
  FullTextSearchInput,
  FullTextSearchResult,
  SearchDocument,
} from "../../application/search/FullTextSearchIndex";
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  SEARCH_SCORE,
} from "../../application/search/FullTextSearchIndex";
import type { SearchIndexStatus } from "../../application/search/SearchIndexStatus";
import {
  bodyMatches,
  fieldMatches,
  makeTextSnippet,
  normalizeSearchText,
  splitQueryTerms,
  tokenizeForIndex,
} from "../../../shared/search/textMatch";

/** 索引条目：原文（展示/snippet）+ 归一化字段 + body 词元集。 */
interface Entry {
  document: SearchDocument;
  titleNormalized: string;
  tagsNormalized: string[];
  bodyTokens: Set<string>;
}

function entryOf(document: SearchDocument): Entry {
  return {
    document,
    titleNormalized: normalizeSearchText(document.title),
    tagsNormalized: document.tags.map(normalizeSearchText),
    bodyTokens: tokenizeForIndex(document.bodyText),
  };
}

export class InMemoryFullTextSearchIndex implements FullTextSearchIndex {
  private readonly byVault = new Map<string, Map<string, Entry>>();
  private readonly status = new Map<string, SearchIndexStatus>();

  async rebuild(
    vaultId: string,
    documents?: Iterable<SearchDocument> | AsyncIterable<SearchDocument>,
  ): Promise<void> {
    if (!documents) {
      throw new Error("内存实现需要调用方供给 documents（真实数据源快照）");
    }
    this.status.set(vaultId, { state: "building" });
    const entries = new Map<string, Entry>();
    for await (const document of toAsyncIterable(documents)) {
      entries.set(document.pageId, entryOf(document));
    }
    this.byVault.set(vaultId, entries);
    this.status.set(vaultId, {
      state: "ready",
      indexedDocuments: entries.size,
    });
  }

  search(input: FullTextSearchInput): Promise<FullTextSearchResult[]> {
    const normalized = normalizeSearchText(input.query.trim());
    if (normalized === "") return Promise.resolve([]);
    const terms = splitQueryTerms(normalized);
    const limit = Math.min(
      input.limit ?? DEFAULT_SEARCH_LIMIT,
      MAX_SEARCH_LIMIT,
    );
    const buckets = input.vaultId
      ? [this.byVault.get(input.vaultId)]
      : [...this.byVault.values()];
    const results: FullTextSearchResult[] = [];
    for (const bucket of buckets) {
      if (!bucket) continue;
      for (const entry of bucket.values()) {
        const scored = scoreEntry(entry, normalized, terms);
        if (scored) results.push(scored);
      }
    }
    results.sort(compareResults);
    return Promise.resolve(results.slice(0, limit));
  }

  upsert(document: SearchDocument): Promise<void> {
    let bucket = this.byVault.get(document.vaultId);
    if (!bucket) {
      bucket = new Map();
      this.byVault.set(document.vaultId, bucket);
    }
    bucket.set(document.pageId, entryOf(document));
    this.status.set(document.vaultId, {
      state: "ready",
      indexedDocuments: bucket.size,
    });
    return Promise.resolve();
  }

  remove(input: { vaultId: string; pageId: string }): Promise<void> {
    const bucket = this.byVault.get(input.vaultId);
    if (!bucket) return Promise.resolve();
    bucket.delete(input.pageId);
    this.status.set(input.vaultId, {
      state: "ready",
      indexedDocuments: bucket.size,
    });
    return Promise.resolve();
  }

  relocate(input: {
    vaultId: string;
    pageId: string;
    relativePath: string;
  }): Promise<void> {
    const entry = this.byVault.get(input.vaultId)?.get(input.pageId);
    if (!entry) return Promise.resolve();
    entry.document = { ...entry.document, relativePath: input.relativePath };
    return Promise.resolve();
  }

  getStatus(vaultId: string): SearchIndexStatus {
    return this.status.get(vaultId) ?? { state: "missing" };
  }
}

/** 按冻结评分表给单条文档打分；未命中返回 null。 */
function scoreEntry(
  entry: Entry,
  normalizedQuery: string,
  terms: string[],
): FullTextSearchResult | null {
  const { document, titleNormalized, tagsNormalized, bodyTokens } = entry;
  let score = 0;
  let matchedField: FullTextSearchResult["matchedField"] | null = null;
  if (titleNormalized === normalizedQuery) {
    score = SEARCH_SCORE.titleExact;
    matchedField = "title";
  } else if (titleNormalized.startsWith(normalizedQuery)) {
    score = SEARCH_SCORE.titlePrefix;
    matchedField = "title";
  } else if (fieldMatches(titleNormalized, normalizedQuery)) {
    score = SEARCH_SCORE.titleContains;
    matchedField = "title";
  } else if (tagsNormalized.some((tag) => fieldMatches(tag, normalizedQuery))) {
    score = SEARCH_SCORE.tagMatch;
    matchedField = "tag";
  } else if (bodyMatches(terms, bodyTokens)) {
    score = SEARCH_SCORE.bodyMatch;
    matchedField = "body";
  }
  if (matchedField === null) return null;
  return {
    pageId: document.pageId,
    title: document.title,
    matchedField,
    snippet:
      matchedField === "body"
        ? makeTextSnippet(document.bodyText, normalizedQuery)
        : null,
    score,
    relativePath: document.relativePath,
  };
}

/** 稳定排序：score 降序 → title zh-CN → pageId。 */
function compareResults(
  a: FullTextSearchResult,
  b: FullTextSearchResult,
): number {
  if (a.score !== b.score) return b.score - a.score;
  const byTitle = a.title.localeCompare(b.title, "zh-CN");
  if (byTitle !== 0) return byTitle;
  return a.pageId.localeCompare(b.pageId);
}

async function* toAsyncIterable(
  documents: Iterable<SearchDocument> | AsyncIterable<SearchDocument>,
): AsyncIterable<SearchDocument> {
  for await (const document of documents) {
    yield document;
  }
}

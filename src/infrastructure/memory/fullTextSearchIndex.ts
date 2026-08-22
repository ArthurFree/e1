/**
 * R008 Stage 3（§10）：FullTextSearchIndex 的内存参照实现——
 * 契约语义的基准（与 Desktop SQLite 实现跑同一套契约套件，
 * src/test/fullTextSearchContract.ts）。
 *
 * 匹配/评分/排序全部委托 shared/search/textMatch 的冻结实现
 *（scoreDocument/compareSearchResults），与 SQLite 实现逐点一致；
 * 纯内存 Map，不触碰浏览器/Node API（内存测试容器同形状复用）。
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
} from "../../application/search/FullTextSearchIndex";
import type { SearchIndexStatus } from "../../application/search/SearchIndexStatus";
import {
  compareSearchResults,
  normalizeSearchText,
  scoreDocument,
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
    if (normalizeSearchText(input.query.trim()) === "") {
      return Promise.resolve([]);
    }
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
        const scored = scoreDocument(
          {
            title: entry.document.title,
            titleNormalized: entry.titleNormalized,
            tagsNormalized: entry.tagsNormalized,
            bodyTokens: entry.bodyTokens,
            bodyText: entry.document.bodyText,
          },
          input.query,
        );
        if (!scored) continue;
        results.push({
          pageId: entry.document.pageId,
          title: entry.document.title,
          matchedField: scored.matchedField,
          snippet: scored.snippet,
          score: scored.score,
          relativePath: entry.document.relativePath,
        });
      }
    }
    results.sort(compareSearchResults);
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

  /** 内存实现无外部触发源：rebuild 即准备（调用方供给 documents 时）。 */
  prepare(): Promise<void> {
    return Promise.resolve();
  }
}

async function* toAsyncIterable(
  documents: Iterable<SearchDocument> | AsyncIterable<SearchDocument>,
): AsyncIterable<SearchDocument> {
  for await (const document of documents) {
    yield document;
  }
}

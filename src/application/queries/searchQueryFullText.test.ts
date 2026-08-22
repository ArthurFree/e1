/**
 * R008 Stage 4：SearchQueryService 全文搜索集成——
 * fullText ready 时优先走全文索引（title/tags/body），未 ready/未装配
 * 回退既有 SearchIndexPort/全量扫描路径。
 */
import { describe, expect, it, vi } from "vitest";
import type { ContentRepository } from "../../domain/repositories";
import type { FullTextSearchIndex } from "../search/FullTextSearchIndex";
import type { SearchIndexStatus } from "../search/SearchIndexStatus";
import type { SearchIndexPort } from "../services/SearchIndexPort";
import { SearchQueryService } from "./SearchQueryService";

function stubContent(): ContentRepository {
  return {
    listAll: vi.fn(async () => []),
  } as unknown as ContentRepository;
}

function stubSearchIndex(): SearchIndexPort {
  return {
    has: vi.fn(() => true),
    query: vi.fn(async () => [
      { pageId: "legacy", title: "旧索引", snippet: "" },
    ]),
  } as unknown as SearchIndexPort;
}

function stubFullText(status: SearchIndexStatus): FullTextSearchIndex {
  return {
    getStatus: vi.fn(() => status),
    search: vi.fn(async () => [
      {
        pageId: "01JABC",
        title: "React 笔记",
        matchedField: "body" as const,
        snippet: "…组件化…",
        score: 20,
        relativePath: "学习/React.md",
      },
    ]),
    prepare: vi.fn(async () => {}),
    rebuild: vi.fn(),
    upsert: vi.fn(),
    remove: vi.fn(),
    relocate: vi.fn(),
  };
}

describe("SearchQueryService 全文搜索集成（R008 Stage 4）", () => {
  it("fullText ready：走全文索引并映射为 domain SearchResult", async () => {
    const fullText = stubFullText({ state: "ready", indexedDocuments: 1 });
    const legacy = stubSearchIndex();
    const service = new SearchQueryService({
      searchIndex: legacy,
      content: stubContent(),
      fullText,
    });
    const results = await service.query("v1", [], "组件化");
    expect(fullText.search).toHaveBeenCalledWith({
      vaultId: "v1",
      query: "组件化",
    });
    expect(results).toEqual([
      { pageId: "01JABC", title: "React 笔记", snippet: "…组件化…" },
    ]);
    // 不再触碰旧索引路径。
    expect(legacy.query).not.toHaveBeenCalled();
  });

  it("fullText 未 ready（building/degraded/missing）：回退旧索引路径", async () => {
    for (const status of [
      { state: "building" },
      { state: "degraded", reason: "x" },
      { state: "missing" },
    ] as const) {
      const fullText = stubFullText(status);
      const legacy = stubSearchIndex();
      const service = new SearchQueryService({
        searchIndex: legacy,
        content: stubContent(),
        fullText,
      });
      const results = await service.query("v1", [], "q");
      expect(legacy.query).toHaveBeenCalledWith("v1", "q");
      expect(results[0].pageId).toBe("legacy");
    }
  });

  it("未装配 fullText：行为与既有路径一致", async () => {
    const legacy = stubSearchIndex();
    const service = new SearchQueryService({
      searchIndex: legacy,
      content: stubContent(),
    });
    const results = await service.query("v1", [], "q");
    expect(results[0].pageId).toBe("legacy");
  });
});

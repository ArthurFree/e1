/**
 * SearchIndexService 测试（R003 阶段 7）：
 * - 查询语义与 domain/search.ts 的 searchPages 完全等价（标题命中在前、
 *   回收站排除、分组只匹配标题、snippet 一致）；
 * - build / syncPages / upsertPage / updateText 的增量同步正确性。
 */
import { describe, expect, it } from "vitest";
import { searchPages } from "../../domain/search";
import type { DocumentContent, Page } from "../../domain/types";
import { makePage, resetFixtureSeq } from "../../test/fixtures";
import { SearchIndexService } from "./SearchIndexService";

const WS = "ws-1";

function makeCorpus(): { pages: Page[]; contents: DocumentContent[] } {
  resetFixtureSeq();
  const pages: Page[] = [
    makePage({ workspaceId: WS, id: "p1", title: "项目周报", position: 0 }),
    makePage({ workspaceId: WS, id: "p2", title: "会议纪要", position: 1 }),
    makePage({
      workspaceId: WS,
      id: "g1",
      kind: "group",
      title: "项目分组",
      position: 2,
    }),
    makePage({ workspaceId: WS, id: "p3", title: "无关页面", position: 3 }),
    makePage({
      workspaceId: WS,
      id: "p4",
      title: "回收站里的项目",
      position: 4,
      deletedAt: 1_700_000_000_000,
    }),
    makePage({ workspaceId: "ws-2", id: "x1", title: "其他库项目", position: 0 }),
  ];
  const contents: DocumentContent[] = [
    {
      pageId: "p1",
      contentJson: null,
      textSnapshot: "本周推进了搜索索引与性能优化",
      updatedAt: 1,
    },
    {
      pageId: "p2",
      contentJson: null,
      textSnapshot: "讨论了项目排期与里程碑",
      updatedAt: 1,
    },
    { pageId: "p3", contentJson: null, textSnapshot: "无关内容", updatedAt: 1 },
    {
      pageId: "p4",
      contentJson: null,
      textSnapshot: "项目已废弃",
      updatedAt: 1,
    },
    { pageId: "x1", contentJson: null, textSnapshot: "项目在其他库", updatedAt: 1 },
  ];
  return { pages, contents };
}

describe("SearchIndexService", () => {
  it("查询结果与 searchPages 完全等价", () => {
    const { pages, contents } = makeCorpus();
    const index = new SearchIndexService();
    const wsPages = pages.filter((p) => p.workspaceId === WS);
    index.build(WS, wsPages, contents);

    for (const q of ["项目", "搜索", "会议", "无标题", "不存在的词", " 项目 "]) {
      const expected = searchPages(wsPages, contents, q);
      const actual = index.query(WS, q);
      expect(actual, `查询「${q}」应与 searchPages 一致`).toEqual(expected);
    }
    // 空查询。
    expect(index.query(WS, "")).toEqual([]);
    expect(index.query(WS, "   ")).toEqual([]);
  });

  it("updateText 增量更新正文后立即可检索", () => {
    const { pages, contents } = makeCorpus();
    const index = new SearchIndexService();
    index.build(WS, pages.filter((p) => p.workspaceId === WS), contents);

    expect(index.query(WS, "全新关键词")).toEqual([]);
    index.updateText("p3", "包含全新关键词的新正文", Date.now());
    const hits = index.query(WS, "全新关键词");
    expect(hits).toHaveLength(1);
    expect(hits[0].pageId).toBe("p3");
    expect(hits[0].snippet).toContain("全新关键词");
  });

  it("upsertPage 同步重命名后的标题", () => {
    const { pages, contents } = makeCorpus();
    const index = new SearchIndexService();
    index.build(WS, pages.filter((p) => p.workspaceId === WS), contents);

    const renamed = pages.find((p) => p.id === "p3")!;
    index.upsertPage({ ...renamed, title: "改名后的项目页" });
    expect(index.query(WS, "改名后").map((r) => r.pageId)).toEqual(["p3"]);
    // 正文索引保留。
    expect(index.query(WS, "无关内容").map((r) => r.pageId)).toEqual(["p3"]);
  });

  it("syncPages 刷新元数据并移除已 purge 的页面", () => {
    const { pages, contents } = makeCorpus();
    const index = new SearchIndexService();
    const wsPages = pages.filter((p) => p.workspaceId === WS);
    index.build(WS, wsPages, contents);

    // p1 软删、p2 被 purge。
    const next = wsPages
      .filter((p) => p.id !== "p2")
      .map((p) => (p.id === "p1" ? { ...p, deletedAt: Date.now() } : p));
    index.syncPages(WS, next);

    expect(index.query(WS, "项目周报")).toEqual([]); // p1 已删
    expect(index.query(WS, "会议纪要")).toEqual([]); // p2 已 purge
    expect(index.query(WS, "项目分组")).toHaveLength(1);
  });

  it("未构建的工作区查询返回空，has 反映构建状态", () => {
    const index = new SearchIndexService();
    expect(index.has(WS)).toBe(false);
    expect(index.query(WS, "项目")).toEqual([]);
    index.build(WS, [], []);
    expect(index.has(WS)).toBe(true);
  });
});

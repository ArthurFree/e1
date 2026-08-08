/**
 * BrowserMemorySearchIndex 测试（R003 阶段 7 语义用例自
 * application/services/SearchIndexService.test.ts 迁移，R005 阶段 6）：
 * - 查询语义与 domain/search.ts 的 searchPages 完全等价（标题命中在前、
 *   回收站排除、分组只匹配标题、snippet 一致）；
 * - prepareWorkspace 自行经仓储取数；syncPages / upsertDocument /
 *   updateText / removeDocument 的增量同步正确性；
 * - rebuild/prepareWorkspace 重跑后查询结果一致（内存索引删除后可重建）。
 */
import { describe, expect, it } from "vitest";
import type {
  ContentRepository,
  PageRepository,
} from "../../../domain/repositories";
import { searchPages } from "../../../domain/search";
import type { DocumentContent, Page } from "../../../domain/types";
import { makePage, resetFixtureSeq } from "../../../test/fixtures";
import { BrowserMemorySearchIndex } from "./BrowserMemorySearchIndex";

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
    makePage({
      workspaceId: "ws-2",
      id: "x1",
      title: "其他库项目",
      position: 0,
    }),
  ];
  const contents: DocumentContent[] = [
    {
      pageId: "p1",
      workspaceId: WS,
      contentJson: null,
      textSnapshot: "本周推进了搜索索引与性能优化",
      version: "t:1",
      updatedAt: 1,
    },
    {
      pageId: "p2",
      workspaceId: WS,
      contentJson: null,
      textSnapshot: "讨论了项目排期与里程碑",
      version: "t:1",
      updatedAt: 1,
    },
    {
      pageId: "p3",
      workspaceId: WS,
      contentJson: null,
      textSnapshot: "无关内容",
      version: "t:1",
      updatedAt: 1,
    },
    {
      pageId: "p4",
      workspaceId: WS,
      contentJson: null,
      textSnapshot: "项目已废弃",
      version: "t:1",
      updatedAt: 1,
    },
    {
      pageId: "x1",
      workspaceId: "ws-2",
      contentJson: null,
      textSnapshot: "项目在其他库",
      version: "t:1",
      updatedAt: 1,
    },
  ];
  return { pages, contents };
}

/**
 * 取数仓储桩：prepareWorkspace/rebuild 的唯一数据来源（R005 阶段 6）。
 * 返回闭包引用，测试可原地改数据后验证重建语义。
 */
function stubDeps(store: { pages: Page[]; contents: DocumentContent[] }): {
  pages: PageRepository;
  content: ContentRepository;
} {
  return {
    pages: {
      listByWorkspace: (ws: string) =>
        Promise.resolve(store.pages.filter((p) => p.workspaceId === ws)),
    } as unknown as PageRepository,
    content: {
      listByWorkspace: (ws: string) =>
        Promise.resolve(store.contents.filter((c) => c.workspaceId === ws)),
    } as unknown as ContentRepository,
  };
}

describe("BrowserMemorySearchIndex", () => {
  it("查询结果与 searchPages 完全等价", async () => {
    const corpus = makeCorpus();
    const index = new BrowserMemorySearchIndex(stubDeps(corpus));
    await index.prepareWorkspace(WS);
    const wsPages = corpus.pages.filter((p) => p.workspaceId === WS);

    for (const q of [
      "项目",
      "搜索",
      "会议",
      "无标题",
      "不存在的词",
      " 项目 ",
    ]) {
      const expected = searchPages(wsPages, corpus.contents, q);
      const actual = await index.query(WS, q);
      expect(actual, `查询「${q}」应与 searchPages 一致`).toEqual(expected);
    }
    // 空查询。
    expect(await index.query(WS, "")).toEqual([]);
    expect(await index.query(WS, "   ")).toEqual([]);
  });

  it("updateText 增量更新正文后立即可检索", async () => {
    const index = new BrowserMemorySearchIndex(stubDeps(makeCorpus()));
    await index.prepareWorkspace(WS);

    expect(await index.query(WS, "全新关键词")).toEqual([]);
    await index.updateText("p3", "包含全新关键词的新正文", Date.now());
    const hits = await index.query(WS, "全新关键词");
    expect(hits).toHaveLength(1);
    expect(hits[0].pageId).toBe("p3");
    expect(hits[0].snippet).toContain("全新关键词");
  });

  it("upsertDocument 纯元数据更新（缺省 textSnapshot）保留已索引正文", async () => {
    const corpus = makeCorpus();
    const index = new BrowserMemorySearchIndex(stubDeps(corpus));
    await index.prepareWorkspace(WS);

    const renamed = corpus.pages.find((p) => p.id === "p3")!;
    await index.upsertDocument({
      workspaceId: WS,
      pageId: "p3",
      title: "改名后的项目页",
      kind: renamed.kind,
      updatedAt: Date.now(),
      deletedAt: null,
    });
    expect((await index.query(WS, "改名后")).map((r) => r.pageId)).toEqual([
      "p3",
    ]);
    // 正文索引保留。
    expect((await index.query(WS, "无关内容")).map((r) => r.pageId)).toEqual([
      "p3",
    ]);
  });

  it("upsertDocument 携带 textSnapshot 时覆盖已索引正文", async () => {
    const index = new BrowserMemorySearchIndex(stubDeps(makeCorpus()));
    await index.prepareWorkspace(WS);

    await index.upsertDocument({
      workspaceId: WS,
      pageId: "p3",
      title: "无关页面",
      kind: "document",
      textSnapshot: "覆盖后的新正文关键词",
      updatedAt: Date.now(),
      deletedAt: null,
    });
    expect(await index.query(WS, "无关内容")).toEqual([]);
    expect(
      (await index.query(WS, "新正文关键词")).map((r) => r.pageId),
    ).toEqual(["p3"]);
  });

  it("upsertDocument 的 deletedAt 变化驱动软删排除与恢复", async () => {
    const index = new BrowserMemorySearchIndex(stubDeps(makeCorpus()));
    await index.prepareWorkspace(WS);

    // 软删 p1：标题与正文均不再命中。
    await index.upsertDocument({
      workspaceId: WS,
      pageId: "p1",
      title: "项目周报",
      kind: "document",
      updatedAt: Date.now(),
      deletedAt: Date.now(),
    });
    expect(await index.query(WS, "项目周报")).toEqual([]);
    expect(await index.query(WS, "性能优化")).toEqual([]);

    // 恢复：deletedAt 归 null 后重新可检索，且正文索引仍在。
    await index.upsertDocument({
      workspaceId: WS,
      pageId: "p1",
      title: "项目周报",
      kind: "document",
      updatedAt: Date.now(),
      deletedAt: null,
    });
    expect((await index.query(WS, "项目周报")).map((r) => r.pageId)).toEqual([
      "p1",
    ]);
    expect((await index.query(WS, "性能优化")).map((r) => r.pageId)).toEqual([
      "p1",
    ]);
  });

  it("removeDocument 移除条目后不再命中", async () => {
    const index = new BrowserMemorySearchIndex(stubDeps(makeCorpus()));
    await index.prepareWorkspace(WS);

    await index.removeDocument(WS, "p2");
    expect(await index.query(WS, "会议纪要")).toEqual([]);
    expect(await index.query(WS, "项目排期")).toEqual([]);
    // 其他条目不受影响。
    expect((await index.query(WS, "项目周报")).map((r) => r.pageId)).toEqual([
      "p1",
    ]);
  });

  it("syncPages 刷新元数据并移除已 purge 的页面", async () => {
    const corpus = makeCorpus();
    const index = new BrowserMemorySearchIndex(stubDeps(corpus));
    await index.prepareWorkspace(WS);
    const wsPages = corpus.pages.filter((p) => p.workspaceId === WS);

    // p1 软删、p2 被 purge。
    const next = wsPages
      .filter((p) => p.id !== "p2")
      .map((p) => (p.id === "p1" ? { ...p, deletedAt: Date.now() } : p));
    await index.syncPages(WS, next);

    expect(await index.query(WS, "项目周报")).toEqual([]); // p1 已删
    expect(await index.query(WS, "会议纪要")).toEqual([]); // p2 已 purge
    expect(await index.query(WS, "项目分组")).toHaveLength(1);
  });

  it("未准备的工作区查询返回空，has 反映准备状态", async () => {
    const index = new BrowserMemorySearchIndex(
      stubDeps({ pages: [], contents: [] }),
    );
    expect(index.has(WS)).toBe(false);
    expect(await index.query(WS, "项目")).toEqual([]);
    await index.prepareWorkspace(WS);
    expect(index.has(WS)).toBe(true);
  });

  it("rebuild/prepareWorkspace 重跑后查询结果一致，且反映底层数据变化", async () => {
    const corpus = makeCorpus();
    const index = new BrowserMemorySearchIndex(stubDeps(corpus));
    await index.prepareWorkspace(WS);
    const before = await index.query(WS, "项目");

    // 内存索引删除后重建（等价于重跑 prepareWorkspace）：结果一致。
    await index.rebuild(WS);
    expect(await index.query(WS, "项目")).toEqual(before);

    // 底层正文变化（模拟另一标签页落盘）后 rebuild 反映新数据。
    const p3Content = corpus.contents.find((c) => c.pageId === "p3")!;
    p3Content.textSnapshot = "重建后才出现的关键词";
    await index.rebuild(WS);
    const wsPages = corpus.pages.filter((p) => p.workspaceId === WS);
    expect(await index.query(WS, "重建后")).toEqual(
      searchPages(wsPages, corpus.contents, "重建后"),
    );
    expect((await index.query(WS, "重建后")).map((r) => r.pageId)).toEqual([
      "p3",
    ]);
  });

  it("prepareWorkspace 幂等：重复准备不产生重复条目", async () => {
    const corpus = makeCorpus();
    const index = new BrowserMemorySearchIndex(stubDeps(corpus));
    await index.prepareWorkspace(WS);
    await index.prepareWorkspace(WS);
    const wsPages = corpus.pages.filter((p) => p.workspaceId === WS);
    const hits = await index.query(WS, "项目");
    expect(hits).toEqual(searchPages(wsPages, corpus.contents, "项目"));
    // 标题命中在前：p1/g1 为标题命中，p2 为正文命中。
    expect(hits.map((r) => r.pageId)).toEqual(["p1", "g1", "p2"]);
  });
});

/**
 * 性能基准测试（R003 阶段 7 验收）：三档数据量验证索引查询、
 * 会话加载、搜索索引、邻接表与单事务清空的性能特征。
 *
 * 注意：fake-indexeddb 与真实浏览器 IndexedDB 性能特征不同，
 * 阈值仅作回归保护（留出充足余量），不作精确度量。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { collectSubtreeIds } from "../domain/pageTree";
import type { Page } from "../domain/types";
import { BrowserMemorySearchIndex } from "../platform/web/search/BrowserMemorySearchIndex";
import { WorkspaceSessionService } from "../application/services/WorkspaceSessionService";
import { getDB, resetDB, STORE_CONTENTS, STORE_PAGES, STORE_TRASH } from "./db";
import {
  contentRepository,
  pageRepository,
  tagRepository,
} from "./repositories";

const WS = "ws-perf";

/** 批量灌库：n 个页面（75% 文档）+ 对应正文，单个事务写入。 */
async function seedTier(pageCount: number, trashedCount = 0) {
  const db = await getDB();
  const now = Date.now();
  const tx = db.transaction([STORE_PAGES, STORE_CONTENTS], "readwrite");
  for (let i = 0; i < pageCount; i++) {
    const isDoc = i % 4 !== 0;
    const page: Page = {
      id: `p${i}`,
      workspaceId: WS,
      parentId: i === 0 ? null : "p0",
      kind: isDoc ? "document" : "group",
      title: `页面 ${i} 基准`,
      icon: null,
      position: i,
      favoriteAt: null,
      lastOpenedAt: null,
      deletedAt: i >= pageCount - trashedCount ? now : null,
      createdAt: now,
      updatedAt: now,
    };
    await tx.objectStore(STORE_PAGES).put(page);
    if (isDoc) {
      await tx.objectStore(STORE_CONTENTS).put({
        pageId: page.id,
        workspaceId: WS,
        contentJson: { type: "doc", content: [] },
        textSnapshot: `第 ${i} 篇基准正文，包含搜索关键词样本。`,
        updatedAt: now,
      });
    }
  }
  await tx.done;
}

beforeEach(async () => {
  await resetDB();
});

describe("性能基准", () => {
  it("小型（100 页面）：会话加载与搜索", async () => {
    await seedTier(100);
    // R005 阶段 6：会话加载不再读取正文；正文读取移入索引准备
    // （prepareWorkspace 自行取数），计时口径为「会话 + 索引准备」，
    // 覆盖打开知识库的总成本，阈值不动。
    const session = new WorkspaceSessionService({
      pages: pageRepository,
      tags: tagRepository,
    });
    const index = new BrowserMemorySearchIndex({
      pages: pageRepository,
      content: contentRepository,
    });
    const t0 = performance.now();
    const data = await session.load(WS);
    await index.prepareWorkspace(WS);
    expect(data.pages).toHaveLength(100);
    expect(performance.now() - t0).toBeLessThan(300);

    const t1 = performance.now();
    expect((await index.query(WS, "搜索关键词")).length).toBeGreaterThan(0);
    expect(performance.now() - t1).toBeLessThan(100);
  }, 30000);

  it("中型（2,000 页面 / 1,500 文档）：会话加载 < 300ms，搜索 < 100ms", async () => {
    await seedTier(2000);
    const session = new WorkspaceSessionService({
      pages: pageRepository,
      tags: tagRepository,
    });
    const index = new BrowserMemorySearchIndex({
      pages: pageRepository,
      content: contentRepository,
    });
    const t0 = performance.now();
    const data = await session.load(WS);
    // 索引准备（含 1,500 篇正文快照读取）计入打开知识库总成本（口径见上）。
    await index.prepareWorkspace(WS);
    expect(data.pages).toHaveLength(2000);
    expect(data).not.toHaveProperty("contents");
    expect(performance.now() - t0).toBeLessThan(300);

    const t1 = performance.now();
    expect((await index.query(WS, "搜索关键词")).length).toBeGreaterThan(0);
    expect(performance.now() - t1).toBeLessThan(100);
  }, 60000);

  it("中型回收站：清空为一次六 store 事务", async () => {
    await seedTier(2000, 50);
    const db = await getDB();
    // 补回收站记录（remove 路径的语义）。
    const trashTx = db.transaction(STORE_TRASH, "readwrite");
    for (let i = 1950; i < 2000; i++) {
      await trashTx.store.put({
        pageId: `p${i}`,
        deletedAt: Date.now(),
        originalParentId: "p0",
      });
    }
    await trashTx.done;

    const spy = vi.spyOn(db, "transaction");
    const t0 = performance.now();
    await pageRepository.purgeTrashed(WS);
    const elapsed = performance.now() - t0;

    const purgeCalls = spy.mock.calls.filter(
      (args) => Array.isArray(args[0]) && (args[0] as string[]).length === 6,
    );
    expect(purgeCalls).toHaveLength(1);
    expect(elapsed).toBeLessThan(500);
    expect(
      (await pageRepository.listByWorkspace(WS)).filter(
        (p) => p.deletedAt !== null,
      ),
    ).toHaveLength(0);
  }, 60000);

  it("大型（10,000 页面 / 8,000 文档）：listByWorkspace 与邻接表", async () => {
    await seedTier(10000);
    const t0 = performance.now();
    const pages = await pageRepository.listByWorkspace(WS);
    expect(pages).toHaveLength(10000);
    expect(performance.now() - t0).toBeLessThan(1000);

    const t1 = performance.now();
    const ids = collectSubtreeIds(pages, "p0");
    expect(ids).toHaveLength(10000);
    expect(performance.now() - t1).toBeLessThan(50);
  }, 120000);

  it("多工作区（20 库 × 500 页面）：切换只读目标库，不再全表扫描正文（R004 阶段 5）", async () => {
    // 总库 10,000 页面 / 7,500 正文，目标库仅 500 页面 / 375 正文：
    // 若退回 listAll 全表扫描，耗时随总库规模增长；索引直取下与目标库规模相关。
    const db = await getDB();
    const now = Date.now();
    for (let w = 0; w < 20; w++) {
      const wsId = `ws-m${w}`;
      const tx = db.transaction([STORE_PAGES, STORE_CONTENTS], "readwrite");
      for (let i = 0; i < 500; i++) {
        const isDoc = i % 4 !== 0;
        const page: Page = {
          id: `w${w}-p${i}`,
          workspaceId: wsId,
          parentId: i === 0 ? null : `w${w}-p0`,
          kind: isDoc ? "document" : "group",
          title: `页面 ${i} 多库基准`,
          icon: null,
          position: i,
          favoriteAt: null,
          lastOpenedAt: null,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        await tx.objectStore(STORE_PAGES).put(page);
        if (isDoc) {
          await tx.objectStore(STORE_CONTENTS).put({
            pageId: page.id,
            workspaceId: wsId,
            contentJson: { type: "doc", content: [] },
            textSnapshot: `第 ${i} 篇多库基准正文。`,
            updatedAt: now,
          });
        }
      }
      await tx.done;
    }

    const session = new WorkspaceSessionService({
      pages: pageRepository,
      tags: tagRepository,
    });
    const listAllSpy = vi.spyOn(contentRepository, "listAll");
    // R005 阶段 6：会话加载不再触碰正文仓储（含工作区索引直取）。
    const listByWorkspaceSpy = vi.spyOn(contentRepository, "listByWorkspace");
    const t0 = performance.now();
    const data = await session.load("ws-m7");
    const elapsed = performance.now() - t0;

    expect(data.pages).toHaveLength(500);
    expect(data).not.toHaveProperty("contents");
    // 验收：会话加载不调用任何正文仓储读路径。
    expect(listAllSpy).not.toHaveBeenCalled();
    expect(listByWorkspaceSpy).not.toHaveBeenCalled();
    // 阈值对齐中型单库基准（2000 页面 < 300ms），目标库仅 500 页面，余量充足。
    expect(elapsed).toBeLessThan(300);
  }, 120000);
});

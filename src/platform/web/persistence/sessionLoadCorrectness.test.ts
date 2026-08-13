/**
 * 会话加载 / 清空回收站正确性（不含 wall-clock）。
 * 性能阈值见 `perf-wallclock.test.ts`，由 `npm run test:perf` 单独跑，不进 `npm test`。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { collectSubtreeIds } from "../../../domain/pageTree";
import type { Page } from "../../../domain/types";
import { BrowserMemorySearchIndex } from "../search/BrowserMemorySearchIndex";
import { WorkspaceSessionService } from "../../../application/services/WorkspaceSessionService";
import { getDB, resetDB, STORE_CONTENTS, STORE_PAGES, STORE_TRASH } from "./db";
import {
  contentRepository,
  pageRepository,
  tagRepository,
} from "./repositories";

const WS = "ws-correctness";

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
      title: `页面 ${i} 正确性`,
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
        textSnapshot: `第 ${i} 篇正确性正文，包含搜索关键词样本。`,
        updatedAt: now,
      });
    }
  }
  await tx.done;
}

beforeEach(async () => {
  await resetDB();
});

describe("会话加载正确性", () => {
  it("小型（100 页面）：会话加载与搜索结果正确", async () => {
    await seedTier(100);
    const session = new WorkspaceSessionService({
      pages: pageRepository,
      tags: tagRepository,
    });
    const index = new BrowserMemorySearchIndex({
      pages: pageRepository,
      content: contentRepository,
    });
    const data = await session.load(WS);
    await index.prepareWorkspace(WS);
    expect(data.pages).toHaveLength(100);
    expect((await index.query(WS, "搜索关键词")).length).toBeGreaterThan(0);
  });

  it("中型（2,000 页面）：会话不含 contents，搜索可用", async () => {
    await seedTier(2000);
    const session = new WorkspaceSessionService({
      pages: pageRepository,
      tags: tagRepository,
    });
    const index = new BrowserMemorySearchIndex({
      pages: pageRepository,
      content: contentRepository,
    });
    const data = await session.load(WS);
    await index.prepareWorkspace(WS);
    expect(data.pages).toHaveLength(2000);
    expect(data).not.toHaveProperty("contents");
    expect((await index.query(WS, "搜索关键词")).length).toBeGreaterThan(0);
  }, 60000);

  it("中型回收站：清空为一次六 store 事务", async () => {
    await seedTier(2000, 50);
    const db = await getDB();
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
    await pageRepository.purgeTrashed(WS);

    const purgeCalls = spy.mock.calls.filter(
      (args) => Array.isArray(args[0]) && (args[0] as string[]).length === 6,
    );
    expect(purgeCalls).toHaveLength(1);
    expect(
      (await pageRepository.listByWorkspace(WS)).filter(
        (p) => p.deletedAt !== null,
      ),
    ).toHaveLength(0);
  }, 60000);

  it("大型（10,000 页面）：listByWorkspace 与邻接表结果正确", async () => {
    await seedTier(10000);
    const pages = await pageRepository.listByWorkspace(WS);
    expect(pages).toHaveLength(10000);
    const ids = collectSubtreeIds(pages, "p0");
    expect(ids).toHaveLength(10000);
  }, 120000);

  it("多工作区：会话加载不再全表扫描正文", async () => {
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
          title: `页面 ${i} 多库`,
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
            textSnapshot: `第 ${i} 篇多库正文。`,
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
    const listByWorkspaceSpy = vi.spyOn(contentRepository, "listByWorkspace");
    const data = await session.load("ws-m7");

    expect(data.pages).toHaveLength(500);
    expect(data).not.toHaveProperty("contents");
    expect(listAllSpy).not.toHaveBeenCalled();
    expect(listByWorkspaceSpy).not.toHaveBeenCalled();
  }, 120000);
});

/**
 * v3 → v4 迁移测试（R004 阶段 5）：
 * - 空库、v1、v2、v3 老库升级到 v4 后新索引就位、contents/pageTags 补齐 workspaceId；
 * - 页面已不存在的孤立正文/标签关联：不猜测、不删除，跳过并记录数量（console.warn），
 *   且不进入工作区索引查询结果；
 * - 迁移全部在 upgrade 事务内完成（IndexedDB 升级事务失败即整体回滚，本套件不做 fault 注入）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDB, type IDBPDatabase } from "idb";
import {
  DB_NAME,
  DB_VERSION,
  STORE_ATTACHMENTS,
  STORE_CONTENTS,
  STORE_PAGES,
  STORE_PAGE_TAGS,
  STORE_REVISIONS,
  STORE_TAGS,
  STORE_TRASH,
  STORE_WORKSPACES,
  createV1Schema,
  getDB,
  resetDB,
} from "./db";
import { contentRepository, tagRepository } from "./repositories";

const NOW = 1_700_000_000_000;

function makePageRow(
  id: string,
  workspaceId: string,
  kind: "document" | "group",
) {
  return {
    id,
    workspaceId,
    parentId: null,
    kind,
    title: `页面 ${id}`,
    icon: null,
    position: 0,
    favoriteAt: null,
    lastOpenedAt: null,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeContentRow(pageId: string, textSnapshot: string) {
  return {
    pageId,
    contentJson: { type: "doc", content: [] },
    textSnapshot,
    updatedAt: NOW,
  };
}

/** 以真实 v3 库写入旧结构 fixture（contents/pageTags 无 workspaceId）。 */
async function writeV3Fixture(options?: { withOrphans?: boolean }) {
  const db = await openDB(DB_NAME, 3, {
    upgrade(db, _oldVersion, _newVersion, tx) {
      createV1Schema(db);
      // 复刻 db.ts 的 v2/v3 迁移分支（新增内容不得回改旧迁移函数，故此处手工复刻）。
      const revisions = db.createObjectStore(STORE_REVISIONS, {
        keyPath: "id",
      });
      revisions.createIndex("pageId", "pageId");
      revisions.createIndex("pageId_createdAt", ["pageId", "createdAt"]);
      const attachments = db.createObjectStore(STORE_ATTACHMENTS, {
        keyPath: "id",
      });
      attachments.createIndex("pageId", "pageId");
      tx.objectStore(STORE_PAGES).createIndex("workspaceId_parentId", [
        "workspaceId",
        "parentId",
      ]);
      tx.objectStore(STORE_PAGES).createIndex("workspaceId_updatedAt", [
        "workspaceId",
        "updatedAt",
      ]);
      tx.objectStore(STORE_TRASH).createIndex("deletedAt", "deletedAt");
    },
  });
  await db.put(STORE_WORKSPACES, {
    id: "ws1",
    name: "甲库",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.put(STORE_WORKSPACES, {
    id: "ws2",
    name: "乙库",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.put(STORE_PAGES, makePageRow("d1", "ws1", "document"));
  await db.put(STORE_PAGES, makePageRow("g1", "ws1", "group"));
  await db.put(STORE_PAGES, makePageRow("x1", "ws2", "document"));
  await db.put(STORE_CONTENTS, makeContentRow("d1", "甲库正文"));
  await db.put(STORE_CONTENTS, makeContentRow("x1", "乙库正文"));
  await db.put(STORE_TAGS, {
    id: "t1",
    workspaceId: "ws1",
    name: "标签",
    color: "#000",
  });
  await db.put(STORE_PAGE_TAGS, { pageId: "d1", tagId: "t1" });
  if (options?.withOrphans) {
    // 页面已不存在的孤立记录：迁移不得猜测归属，也不得删除。
    await db.put(STORE_CONTENTS, makeContentRow("ghost", "孤立正文"));
    await db.put(STORE_PAGE_TAGS, { pageId: "ghost", tagId: "t1" });
  }
  db.close();
}

function indexNames(db: IDBPDatabase, store: string): string[] {
  return Array.from(db.transaction(store).objectStore(store).indexNames);
}

beforeEach(async () => {
  await resetDB();
  vi.restoreAllMocks();
});

describe("v3 → v4 迁移", () => {
  it("空库直接建 v4：新索引就位", async () => {
    const db = await getDB();
    expect(db.version).toBe(DB_VERSION);
    expect(indexNames(db, STORE_CONTENTS)).toEqual(
      expect.arrayContaining(["workspaceId", "workspaceId_updatedAt"]),
    );
    expect(indexNames(db, STORE_PAGE_TAGS)).toContain("workspaceId");
  });

  it("v3 老库升级：contents 与 pageTags 补齐 workspaceId，工作区索引可查", async () => {
    await writeV3Fixture();
    const db = await getDB();
    expect(db.version).toBe(DB_VERSION);
    expect(indexNames(db, STORE_CONTENTS)).toEqual(
      expect.arrayContaining(["workspaceId", "workspaceId_updatedAt"]),
    );
    expect(indexNames(db, STORE_PAGE_TAGS)).toContain("workspaceId");

    // 数据回写（读原始记录验证，不经仓储过滤）。
    const d1 = (await db.get(STORE_CONTENTS, "d1")) as { workspaceId?: string };
    expect(d1.workspaceId).toBe("ws1");
    const x1 = (await db.get(STORE_CONTENTS, "x1")) as { workspaceId?: string };
    expect(x1.workspaceId).toBe("ws2");
    const pt = (await db.get(STORE_PAGE_TAGS, ["d1", "t1"])) as {
      workspaceId?: string;
    };
    expect(pt.workspaceId).toBe("ws1");

    // 仓储新查询路径：只取目标工作区。
    const ws1Contents = await contentRepository.listByWorkspace("ws1");
    expect(ws1Contents.map((c) => c.pageId)).toEqual(["d1"]);
    const pageTags = await tagRepository.listWorkspacePageTags("ws1");
    expect(pageTags).toEqual([
      { pageId: "d1", tagId: "t1", workspaceId: "ws1" },
    ]);
  });

  it("含孤立正文/孤立 pageTag 的 v3 老库：孤立记录跳过且数量被记录，其余记录补齐", async () => {
    await writeV3Fixture({ withOrphans: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const db = await getDB();
    expect(db.version).toBe(DB_VERSION);

    // 孤立记录原样保留（不猜测 workspaceId、不删除）。
    const ghost = (await db.get(STORE_CONTENTS, "ghost")) as {
      workspaceId?: string;
    };
    expect(ghost).toBeDefined();
    expect(ghost.workspaceId).toBeUndefined();
    const orphanPt = (await db.get(STORE_PAGE_TAGS, ["ghost", "t1"])) as {
      workspaceId?: string;
    };
    expect(orphanPt).toBeDefined();
    expect(orphanPt.workspaceId).toBeUndefined();

    // 数量经 console.warn 记录（仅数量，不含内容）。
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]?.[0] as string;
    expect(message).toContain("1");
    expect(message).toContain("孤立");

    // 正常记录补齐，孤立记录不进工作区查询结果。
    expect(
      ((await db.get(STORE_CONTENTS, "d1")) as { workspaceId?: string })
        .workspaceId,
    ).toBe("ws1");
    expect(
      (await contentRepository.listByWorkspace("ws1")).map((c) => c.pageId),
    ).toEqual(["d1"]);
    expect(await tagRepository.listWorkspacePageTags("ws1")).toEqual([
      { pageId: "d1", tagId: "t1", workspaceId: "ws1" },
    ]);
  });

  it("v2 老库跳级 v4：v3 索引与 v4 回写叠加生效", async () => {
    const v2 = await openDB(DB_NAME, 2, {
      upgrade(db) {
        createV1Schema(db);
        const revisions = db.createObjectStore(STORE_REVISIONS, {
          keyPath: "id",
        });
        revisions.createIndex("pageId", "pageId");
        revisions.createIndex("pageId_createdAt", ["pageId", "createdAt"]);
        const attachments = db.createObjectStore(STORE_ATTACHMENTS, {
          keyPath: "id",
        });
        attachments.createIndex("pageId", "pageId");
      },
    });
    await v2.put(STORE_WORKSPACES, {
      id: "ws1",
      name: "旧库",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await v2.put(STORE_PAGES, makePageRow("d1", "ws1", "document"));
    await v2.put(STORE_CONTENTS, makeContentRow("d1", "旧正文"));
    await v2.put(STORE_TAGS, {
      id: "t1",
      workspaceId: "ws1",
      name: "标签",
      color: "#000",
    });
    await v2.put(STORE_PAGE_TAGS, { pageId: "d1", tagId: "t1" });
    v2.close();

    const db = await getDB();
    expect(db.version).toBe(DB_VERSION);
    expect(indexNames(db, STORE_PAGES)).toContain("workspaceId_parentId");
    expect(
      ((await db.get(STORE_CONTENTS, "d1")) as { workspaceId?: string })
        .workspaceId,
    ).toBe("ws1");
    expect(await tagRepository.listWorkspacePageTags("ws1")).toEqual([
      { pageId: "d1", tagId: "t1", workspaceId: "ws1" },
    ]);
  });

  it("v1 老库跳级 v4：数据迁移与 v4 回写叠加生效", async () => {
    const v1 = await openDB(DB_NAME, 1, {
      upgrade(db) {
        createV1Schema(db);
      },
    });
    await v1.put(STORE_WORKSPACES, {
      id: "ws1",
      name: "旧库",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await v1.put(STORE_PAGES, {
      ...makePageRow("d1", "ws1", "document"),
      kind: "document",
    });
    await v1.put(STORE_CONTENTS, makeContentRow("d1", "旧正文"));
    await v1.put(STORE_TAGS, {
      id: "t1",
      workspaceId: "ws1",
      name: "标签",
      color: "#000",
    });
    await v1.put(STORE_PAGE_TAGS, { pageId: "d1", tagId: "t1" });
    v1.close();

    const db = await getDB();
    expect(db.version).toBe(DB_VERSION);
    expect(
      ((await db.get(STORE_CONTENTS, "d1")) as { workspaceId?: string })
        .workspaceId,
    ).toBe("ws1");
    expect(
      (await contentRepository.listByWorkspace("ws1")).map((c) => c.pageId),
    ).toEqual(["d1"]);
  });
});

/**
 * v2 → v3 迁移测试（R003 阶段 7）：
 * - v2 老库升级到 v3 后新索引就位、业务数据完整；
 * - v1 老库直接跳 v3 时 v2/v3 分支叠加生效；
 * - 迁移在 upgrade 事务内完成，索引与数据一致性可验证。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDB } from "idb";
import {
  DB_NAME,
  DB_VERSION,
  STORE_CONTENTS,
  STORE_PAGES,
  STORE_TRASH,
  STORE_WORKSPACES,
  createV1Schema,
  getDB,
  resetDB,
} from "./db";
import {
  contentRepository,
  pageRepository,
  workspaceRepository,
} from "./repositories";

const NOW = 1_700_000_000_000;

/** 以 v2 库写入旧结构 fixture（v1 schema + v2 迁移，等价于存量用户的库）。 */
async function writeV2Fixture() {
  const db = await openDB(DB_NAME, 2, {
    upgrade(db) {
      createV1Schema(db);
    },
  });
  await db.put(STORE_WORKSPACES, {
    id: "ws1",
    name: "旧知识库",
    createdAt: NOW,
    updatedAt: NOW,
  });
  const base = {
    workspaceId: "ws1",
    icon: null,
    favoriteAt: null,
    lastOpenedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  await db.put(STORE_PAGES, {
    ...base,
    id: "g1",
    parentId: null,
    kind: "group",
    title: "分组",
    position: 0,
    deletedAt: null,
  });
  await db.put(STORE_PAGES, {
    ...base,
    id: "d1",
    parentId: "g1",
    kind: "document",
    title: "组内文档",
    position: 0,
    deletedAt: null,
  });
  await db.put(STORE_PAGES, {
    ...base,
    id: "d2",
    parentId: null,
    kind: "document",
    title: "已删文档",
    position: 1,
    deletedAt: NOW,
  });
  await db.put(STORE_CONTENTS, {
    pageId: "d1",
    contentJson: { type: "doc", content: [] },
    textSnapshot: "正文",
    updatedAt: NOW,
  });
  await db.put(STORE_TRASH, {
    pageId: "d2",
    deletedAt: NOW,
    originalParentId: null,
  });
  db.close();
}

describe("v2 → v3 迁移", () => {
  beforeEach(async () => {
    await resetDB();
  });

  it("v2 老库升级后新索引就位且数据完整", async () => {
    await writeV2Fixture();
    const db = await getDB();
    expect(db.version).toBe(DB_VERSION);

    const pageIndexes = Array.from(
      db.transaction(STORE_PAGES).objectStore(STORE_PAGES).indexNames,
    );
    expect(pageIndexes).toContain("workspaceId_parentId");
    expect(pageIndexes).toContain("workspaceId_updatedAt");
    const trashIndexes = Array.from(
      db.transaction(STORE_TRASH).objectStore(STORE_TRASH).indexNames,
    );
    expect(trashIndexes).toContain("deletedAt");

    // 业务数据完整：经仓储读取与升级前一致。
    const pages = await pageRepository.listByWorkspace("ws1");
    expect(pages).toHaveLength(3);
    expect(pages.find((p) => p.id === "d2")?.deletedAt).toBe(NOW);
    expect((await contentRepository.get("d1"))?.textSnapshot).toBe("正文");
    expect((await workspaceRepository.list())[0].name).toBe("旧知识库");
  });

  it("复合索引可按 [workspaceId, parentId] 检索（顶层 null 键除外）", async () => {
    await writeV2Fixture();
    const db = await getDB();
    const inGroup = await db.getAllFromIndex(
      STORE_PAGES,
      "workspaceId_parentId",
      ["ws1", "g1"],
    );
    expect(inGroup.map((p) => (p as { id: string }).id)).toEqual(["d1"]);
  });

  it("v1 老库直接跳 v3：v2 数据迁移与 v3 索引叠加生效", async () => {
    // 真实 v1 库（含 folder 页面）。
    const v1 = await openDB(DB_NAME, 1, {
      upgrade(db) {
        createV1Schema(db);
      },
    });
    await v1.put(STORE_WORKSPACES, {
      id: "ws1",
      name: "旧知识库",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await v1.put(STORE_PAGES, {
      id: "f1",
      workspaceId: "ws1",
      parentId: null,
      kind: "folder",
      title: "旧文件夹",
      position: 0,
      deletedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    v1.close();

    const db = await getDB();
    expect(db.version).toBe(DB_VERSION);
    // v2 分支：folder → group，新字段补默认值。
    const pages = await pageRepository.listByWorkspace("ws1");
    expect(pages[0]?.kind).toBe("group");
    expect(pages[0]?.favoriteAt).toBeNull();
    // v3 分支：新索引就位。
    const pageIndexes = Array.from(
      db.transaction(STORE_PAGES).objectStore(STORE_PAGES).indexNames,
    );
    expect(pageIndexes).toContain("workspaceId_parentId");
  });
});

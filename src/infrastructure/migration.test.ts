import { beforeEach, describe, expect, it } from "vitest";
import { openDB } from "idb";
import {
  DB_NAME,
  DB_VERSION,
  STORE_ATTACHMENTS,
  STORE_CONTENTS,
  STORE_PAGES,
  STORE_PAGE_TAGS,
  STORE_PREFERENCES,
  STORE_REVISIONS,
  STORE_TAGS,
  STORE_TRASH,
  STORE_WORKSPACES,
  createV1Schema,
  getDB,
  resetDB,
} from "./db";
import {
  contentRepository,
  pageRepository,
  preferencesRepository,
  tagRepository,
  workspaceRepository,
} from "./repositories";

const NOW = 1_700_000_000_000;

/** 以真实 v1 库写入旧结构 fixture：folder 页面、旧 workspace、标签、回收站与偏好。 */
async function writeV1Fixture() {
  const db = await openDB(DB_NAME, 1, {
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

  const v1Pages = [
    {
      id: "g1",
      workspaceId: "ws1",
      parentId: null,
      kind: "folder",
      title: "旧文件夹",
      icon: "📁",
      position: 0,
      deletedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: "d1",
      workspaceId: "ws1",
      parentId: "g1",
      kind: "document",
      title: "组内文档",
      icon: null,
      position: 0,
      deletedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: "d2",
      workspaceId: "ws1",
      parentId: null,
      kind: "document",
      title: "根文档",
      icon: null,
      position: 1,
      deletedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: "d3",
      workspaceId: "ws1",
      parentId: null,
      kind: "document",
      title: "已删除文档",
      icon: null,
      position: 2,
      deletedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ];
  for (const page of v1Pages) {
    await db.put(STORE_PAGES, page);
  }

  const docJson = { type: "doc", content: [{ type: "paragraph" }] };
  for (const [pageId, text] of [
    ["d1", "组内文档正文"],
    ["d2", "根文档正文"],
    ["d3", "已删除文档正文"],
  ] as const) {
    await db.put(STORE_CONTENTS, {
      pageId,
      contentJson: docJson,
      textSnapshot: text,
      updatedAt: NOW,
    });
  }

  await db.put(STORE_TRASH, { pageId: "d3", deletedAt: NOW, originalParentId: null });

  await db.put(STORE_TAGS, { id: "t1", workspaceId: "ws1", name: "旧标签", color: "#e16259" });
  await db.put(STORE_PAGE_TAGS, { pageId: "d1", tagId: "t1" });

  await db.put(STORE_PREFERENCES, { id: "preferences", theme: "dark", sidebarWidth: 300 });

  db.close();
}

beforeEach(async () => {
  await resetDB();
});

describe("v1 → v2 迁移", () => {
  it("旧数据升级后数量、层级、正文、标签、回收站与偏好完整保留", async () => {
    await writeV1Fixture();

    const workspaces = await workspaceRepository.list();
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].id).toBe("ws1");
    expect(workspaces[0].name).toBe("旧知识库");

    const pages = await pageRepository.listByWorkspace("ws1");
    expect(pages).toHaveLength(4);

    const group = pages.find((p) => p.id === "g1");
    expect(group?.kind).toBe("group");
    expect(group?.parentId).toBeNull();
    expect(group?.position).toBe(0);

    const inner = pages.find((p) => p.id === "d1");
    expect(inner?.parentId).toBe("g1");
    const root = pages.find((p) => p.id === "d2");
    expect(root?.position).toBe(1);

    const trashed = pages.find((p) => p.id === "d3");
    expect(trashed?.deletedAt).toBe(NOW);

    const content = await contentRepository.get("d1");
    expect(content?.textSnapshot).toBe("组内文档正文");
    expect((content?.contentJson as { type: string }).type).toBe("doc");

    expect((await tagRepository.listByWorkspace("ws1")).map((t) => t.name)).toEqual(["旧标签"]);
    expect(await tagRepository.listPageTagIds("d1")).toEqual(["t1"]);

    const prefs = await preferencesRepository.get();
    expect(prefs.theme).toBe("dark");
    expect(prefs.sidebarWidth).toBe(300);
  });

  it("为 Page 与 Workspace 补齐新字段默认值", async () => {
    await writeV1Fixture();

    const [ws] = await workspaceRepository.list();
    expect(ws.icon).toBeNull();
    expect(ws.description).toBe("");
    expect(ws.homePageId).toBeNull();
    expect(ws.favoriteAt).toBeNull();
    expect(ws.lastOpenedAt).toBeNull();

    const pages = await pageRepository.listByWorkspace("ws1");
    for (const page of pages) {
      expect(page.favoriteAt).toBeNull();
      expect(page.lastOpenedAt).toBeNull();
    }
  });

  it("新增 revisions 与 attachments store 且初始为空", async () => {
    await writeV1Fixture();
    const db = await getDB();
    expect(db.objectStoreNames.contains(STORE_REVISIONS)).toBe(true);
    expect(db.objectStoreNames.contains(STORE_ATTACHMENTS)).toBe(true);
    expect(await db.count(STORE_REVISIONS)).toBe(0);
    expect(await db.count(STORE_ATTACHMENTS)).toBe(0);
  });

  it("重复打开数据库不重复迁移、不产生副作用", async () => {
    await writeV1Fixture();
    const firstPages = await pageRepository.listByWorkspace("ws1");

    // 以同版本另开一个连接，不应触发 upgrade，数据保持不变。
    const reopened = await openDB(DB_NAME, DB_VERSION);
    expect(reopened.version).toBe(DB_VERSION);
    expect(await reopened.count(STORE_PAGES)).toBe(4);
    expect(await reopened.count(STORE_WORKSPACES)).toBe(1);
    const group = await reopened.get(STORE_PAGES, "g1");
    expect(group?.kind).toBe("group");
    reopened.close();

    // 仓储层再次读取结果一致。
    const secondPages = await pageRepository.listByWorkspace("ws1");
    expect(secondPages.map((p) => p.id).sort()).toEqual(firstPages.map((p) => p.id).sort());
    expect(secondPages.find((p) => p.id === "g1")?.kind).toBe("group");
  });
});

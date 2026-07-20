import { beforeEach, describe, expect, it } from "vitest";
import { getDB, resetDB, STORE_PAGES } from "./db";
import {
  contentRepository,
  pageRepository,
  preferencesRepository,
  tagRepository,
  workspaceRepository,
} from "./repositories";

beforeEach(async () => {
  await resetDB();
});

describe("种子初始化", () => {
  it("首次启动创建预置知识库与示例页面", async () => {
    const workspaces = await workspaceRepository.list();
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].name).toBe("我的知识库");

    const pages = await pageRepository.listByWorkspace(workspaces[0].id);
    expect(pages.length).toBeGreaterThanOrEqual(4);
    expect(pages.some((p) => p.kind === "folder")).toBe(true);

    const welcome = pages.find((p) => p.title.includes("欢迎"));
    expect(welcome).toBeDefined();
    const content = await contentRepository.get(welcome!.id);
    expect(content?.textSnapshot).toContain("本地优先");
  });

  it("重复调用不重复播种", async () => {
    const first = await workspaceRepository.list();
    const second = await workspaceRepository.list();
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(first[0].id);
  });
});

describe("页面仓储", () => {
  async function seedWorkspace() {
    const [ws] = await workspaceRepository.list();
    return ws;
  }

  it("创建页面后刷新仍可读取，标题可修改", async () => {
    const ws = await seedWorkspace();
    const page = await pageRepository.create({
      workspaceId: ws.id,
      parentId: null,
      kind: "document",
      title: "测试文档",
    });
    await pageRepository.rename(page.id, "改名后");

    const pages = await pageRepository.listByWorkspace(ws.id);
    const found = pages.find((p) => p.id === page.id);
    expect(found?.title).toBe("改名后");
  });

  it("移动页面更新父级，循环父级被拒绝", async () => {
    const ws = await seedWorkspace();
    const folder = await pageRepository.create({
      workspaceId: ws.id,
      parentId: null,
      kind: "folder",
      title: "文件夹",
    });
    const doc = await pageRepository.create({
      workspaceId: ws.id,
      parentId: null,
      kind: "document",
      title: "文档",
    });
    await pageRepository.move(doc.id, folder.id);
    let pages = await pageRepository.listByWorkspace(ws.id);
    expect(pages.find((p) => p.id === doc.id)?.parentId).toBe(folder.id);

    await expect(pageRepository.move(folder.id, folder.id)).rejects.toThrow();
    await pageRepository.move(doc.id, folder.id);
    const childDoc = await pageRepository.create({
      workspaceId: ws.id,
      parentId: doc.id,
      kind: "document",
      title: "子文档",
    });
    await expect(pageRepository.move(doc.id, childDoc.id)).rejects.toThrow();
    pages = await pageRepository.listByWorkspace(ws.id);
    expect(pages.find((p) => p.id === doc.id)?.parentId).toBe(folder.id);
  });

  it("删除进回收站，恢复回到原父级", async () => {
    const ws = await seedWorkspace();
    const folder = await pageRepository.create({
      workspaceId: ws.id,
      parentId: null,
      kind: "folder",
      title: "文件夹",
    });
    const doc = await pageRepository.create({
      workspaceId: ws.id,
      parentId: folder.id,
      kind: "document",
      title: "文档",
    });

    await pageRepository.remove(folder.id);
    let pages = await pageRepository.listByWorkspace(ws.id);
    expect(pages.find((p) => p.id === folder.id)?.deletedAt).not.toBeNull();
    expect(pages.find((p) => p.id === doc.id)?.deletedAt).not.toBeNull();

    await pageRepository.restore(folder.id);
    pages = await pageRepository.listByWorkspace(ws.id);
    expect(pages.find((p) => p.id === folder.id)?.deletedAt).toBeNull();
    const restored = pages.find((p) => p.id === doc.id);
    expect(restored?.deletedAt).toBeNull();
    expect(restored?.parentId).toBe(folder.id);
  });

  it("损坏的页面记录被跳过而不是抛错", async () => {
    const ws = await seedWorkspace();
    const db = await getDB();
    await db.put(STORE_PAGES, { id: "broken", workspaceId: ws.id });
    await db.put(STORE_PAGES, null as unknown as object).catch(() => undefined);

    const pages = await pageRepository.listByWorkspace(ws.id);
    expect(pages.every((p) => typeof p.title === "string")).toBe(true);
  });

  it("带 index 的移动支持同级排序", async () => {
    const ws = await seedWorkspace();
    const make = (title: string) =>
      pageRepository.create({ workspaceId: ws.id, parentId: null, kind: "document", title });
    const a = await make("A");
    const b = await make("B");
    const c = await make("C");

    await pageRepository.move(a.id, null, 99);
    let pages = await pageRepository.listByWorkspace(ws.id);
    const titles = pages
      .filter((p) => p.parentId === null && ["A", "B", "C"].includes(p.title))
      .sort((x, y) => x.position - y.position)
      .map((p) => p.title);
    expect(titles).toEqual(["B", "C", "A"]);

    // 省略 index 时维持原语义：追加到末尾。
    await pageRepository.move(b.id, null);
    pages = await pageRepository.listByWorkspace(ws.id);
    const after = pages
      .filter((p) => p.parentId === null && ["A", "B", "C"].includes(p.title))
      .sort((x, y) => x.position - y.position)
      .map((p) => p.title);
    expect(after).toEqual(["C", "A", "B"]);
    expect(c.id).not.toBe(a.id);
  });

  it("purge 永久删除整棵子树及其正文与标签关联", async () => {
    const ws = await seedWorkspace();
    const folder = await pageRepository.create({
      workspaceId: ws.id, parentId: null, kind: "folder", title: "文件夹",
    });
    const doc = await pageRepository.create({
      workspaceId: ws.id, parentId: folder.id, kind: "document", title: "文档",
    });
    const tag = await tagRepository.create(ws.id, "标签", "#e16259");
    await tagRepository.setPageTags(doc.id, [tag.id]);

    await pageRepository.remove(folder.id);
    await pageRepository.purge(folder.id);

    const pages = await pageRepository.listByWorkspace(ws.id);
    expect(pages.some((p) => p.id === folder.id || p.id === doc.id)).toBe(false);
    expect(await contentRepository.get(doc.id)).toBeUndefined();
    expect(await tagRepository.listPageTagIds(doc.id)).toEqual([]);
    // 标签本身保留。
    expect((await tagRepository.listByWorkspace(ws.id)).map((t) => t.id)).toContain(tag.id);
  });

  it("purgeTrashed 清空回收站但保留未删除页面", async () => {
    const ws = await seedWorkspace();
    const keep = await pageRepository.create({
      workspaceId: ws.id, parentId: null, kind: "document", title: "保留",
    });
    const drop = await pageRepository.create({
      workspaceId: ws.id, parentId: null, kind: "document", title: "丢弃",
    });
    await pageRepository.remove(drop.id);

    await pageRepository.purgeTrashed(ws.id);
    const pages = await pageRepository.listByWorkspace(ws.id);
    expect(pages.some((p) => p.id === keep.id)).toBe(true);
    expect(pages.some((p) => p.id === drop.id)).toBe(false);
    expect(pages.every((p) => p.deletedAt === null)).toBe(true);
  });
});

describe("标签仓储", () => {
  async function seedWorkspace() {
    const [ws] = await workspaceRepository.list();
    return ws;
  }

  it("创建、列出、关联与覆盖页面标签", async () => {
    const ws = await seedWorkspace();
    const page = await pageRepository.create({
      workspaceId: ws.id, parentId: null, kind: "document", title: "文档",
    });
    const t1 = await tagRepository.create(ws.id, "工作", "#e16259");
    const t2 = await tagRepository.create(ws.id, "学习", "#0f7b6c");

    expect((await tagRepository.listByWorkspace(ws.id)).map((t) => t.name).sort()).toEqual([
      "学习", "工作",
    ]);

    await tagRepository.setPageTags(page.id, [t1.id, t2.id, t1.id]);
    expect((await tagRepository.listPageTagIds(page.id)).sort()).toEqual([t1.id, t2.id].sort());
    const workspaceTags = await tagRepository.listWorkspacePageTags(ws.id);
    expect(workspaceTags.filter((r) => r.pageId === page.id)).toHaveLength(2);

    await tagRepository.setPageTags(page.id, [t2.id]);
    expect(await tagRepository.listPageTagIds(page.id)).toEqual([t2.id]);
  });

  it("删除标签时级联解除页面关联", async () => {
    const ws = await seedWorkspace();
    const page = await pageRepository.create({
      workspaceId: ws.id, parentId: null, kind: "document", title: "文档",
    });
    const tag = await tagRepository.create(ws.id, "临时", "#6940a5");
    await tagRepository.setPageTags(page.id, [tag.id]);

    await tagRepository.remove(tag.id);
    expect(await tagRepository.listByWorkspace(ws.id)).toEqual([]);
    expect(await tagRepository.listPageTagIds(page.id)).toEqual([]);
  });
});

describe("偏好设置", () => {
  it("默认浅色主题并持久化修改", async () => {
    const initial = await preferencesRepository.get();
    expect(initial.theme).toBe("light");

    await preferencesRepository.update({ theme: "dark", sidebarWidth: 320 });
    const stored = await preferencesRepository.get();
    expect(stored.theme).toBe("dark");
    expect(stored.sidebarWidth).toBe(320);
  });

  it("损坏的偏好记录回退默认值", async () => {
    const db = await getDB();
    await db.put("preferences", { id: "preferences", theme: "neon" });
    const prefs = await preferencesRepository.get();
    expect(prefs.theme).toBe("light");
  });
});

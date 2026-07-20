import { beforeEach, describe, expect, it } from "vitest";
import { getDB, resetDB, STORE_PAGES } from "./db";
import {
  contentRepository,
  pageRepository,
  preferencesRepository,
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

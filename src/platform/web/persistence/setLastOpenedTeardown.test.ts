/**
 * setLastOpened 打点在连接 teardown 后不得抛出（CI InvalidStateError 回归）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDB, resetDB, STORE_WORKSPACES } from "./db";
import { pageRepository, workspaceRepository } from "./repositories";

describe("setLastOpened 连接 teardown", () => {
  beforeEach(async () => {
    await resetDB();
  });

  afterEach(async () => {
    await resetDB();
  });

  it("workspace.setLastOpened：连接关闭后静默返回", async () => {
    const db = await getDB();
    await db.put(STORE_WORKSPACES, {
      id: "ws-teardown",
      name: "测试库",
      icon: null,
      description: "",
      homePageId: null,
      favoriteAt: null,
      lastOpenedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // 手动关闭连接但不清缓存：getDB() 仍返回已关闭实例（模拟 teardown 竞态）。
    db.close();

    await expect(
      workspaceRepository.setLastOpened("ws-teardown", Date.now()),
    ).resolves.toBeUndefined();
  });

  it("page.setLastOpened：连接关闭后静默返回", async () => {
    const ws = await workspaceRepository.create("打点库");
    const page = await pageRepository.create({
      workspaceId: ws.id,
      parentId: null,
      kind: "document",
      title: "文档",
    });

    const db = await getDB();
    db.close();

    await expect(
      pageRepository.setLastOpened(page.id, Date.now()),
    ).resolves.toBeUndefined();
  });
});

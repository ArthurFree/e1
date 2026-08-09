/**
 * R006 阶段 1：createDesktopRuntime 测试——fake adapter 接线验证：
 * 返回完整 AppServices 容器（内存实现），capabilities 为桌面矩阵；
 * 容器可真实跑通业务编排（内存创建知识库/文档），证明 PoC 可用。
 */
import { describe, expect, it } from "vitest";
import { createDesktopRuntime } from "./createDesktopRuntime";
import { desktopCapabilities } from "./desktopCapabilities";
import type { E1DesktopAPI } from "./desktopApi";

const stubApi = { platform: "desktop" } as unknown as E1DesktopAPI;

describe("createDesktopRuntime", () => {
  it("capabilities 为桌面能力矩阵（runtime 与 services 两处一致）", () => {
    const runtime = createDesktopRuntime(stubApi);
    expect(runtime.capabilities).toBe(desktopCapabilities);
    expect(runtime.services.capabilities).toBe(desktopCapabilities);
  });

  it("返回完整 AppServices 形状", () => {
    const { services } = createDesktopRuntime(stubApi);
    expect(Object.keys(services.commands).sort()).toEqual([
      "document",
      "page",
      "tag",
      "workspace",
    ]);
    expect(Object.keys(services.queries).sort()).toEqual([
      "document",
      "search",
      "workspace",
    ]);
    for (const key of [
      "assets",
      "preferencesService",
      "secretStore",
      "aiConfigService",
      "recoveryStore",
      "syncChannel",
      "storageHealth",
      "createAIProvider",
      "createSaveCoordinator",
    ] as const) {
      expect(services[key], `缺少 ${key}`).toBeDefined();
    }
  });

  it("fake adapter 可跑通业务编排（内存创建知识库与文档）", async () => {
    const { services } = createDesktopRuntime(stubApi);
    const workspace = await services.commands.workspace.create("桌面 PoC 库");
    const page = await services.commands.page.create({
      workspaceId: workspace.id,
      parentId: null,
      kind: "document",
      title: "第一篇",
    });
    const workspaces = await services.queries.workspace.listWorkspaces();
    expect(workspaces.map((w) => w.name)).toContain("桌面 PoC 库");
    expect(page.title).toBe("第一篇");
  });
});

/**
 * WorkspaceSessionController 单元测试（PR4）：会话生命周期脱离 React 后
 * 可直接断言——初始加载的路由恢复决策、连切时过期响应丢弃、最近打开
 * 打点的静默失败、无会话时刷新为 no-op。
 */
import { describe, expect, it, vi } from "vitest";
import type { Page, Workspace } from "../../domain/types";
import type { WorkspaceCommandService } from "../commands/WorkspaceCommandService";
import type { WorkspaceQueryService } from "../queries/WorkspaceQueryService";
import type { WorkspaceSessionData } from "./WorkspaceSessionService";
import {
  WorkspaceSessionController,
  type WorkspaceSessionSink,
} from "./WorkspaceSessionController";
import { createDeferred } from "../../test/fixtures";

function workspaceOf(id: string, name = id): Workspace {
  return {
    id,
    name,
    icon: null,
    description: "",
    homePageId: null,
    favoriteAt: null,
    lastOpenedAt: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function documentOf(id: string, workspaceId: string, deleted = false): Page {
  return {
    id,
    workspaceId,
    parentId: null,
    kind: "document",
    title: id,
    icon: null,
    position: 0,
    favoriteAt: null,
    lastOpenedAt: null,
    deletedAt: deleted ? 1 : null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function sessionOf(workspaceId: string, pages: Page[]): WorkspaceSessionData {
  return { workspaceId, pages, tags: [], pageTags: [] };
}

function createSink() {
  const calls: string[] = [];
  const sink: WorkspaceSessionSink = {
    sessionLoadStarted: (id, ws) => calls.push(`start:${id}:${ws}`),
    sessionLoadSucceeded: (id, data) =>
      calls.push(`success:${id}:${data.workspaceId}`),
    sessionLoadFailed: (id, message) => calls.push(`error:${id}:${message}`),
    pagesLoaded: (pages) => calls.push(`pages:${pages.length}`),
    tagsLoaded: (tags, pageTags) =>
      calls.push(`tags:${tags.length}:${pageTags.length}`),
    workspacesLoaded: (list) => calls.push(`workspaces:${list.length}`),
    workspaceLastOpened: (id, at) => calls.push(`lastOpened:${id}:${at}`),
  };
  return { sink, calls };
}

function createController(
  queries: Partial<WorkspaceQueryService>,
  commands: Partial<WorkspaceCommandService> = {},
  currentWorkspaceId: string | null = null,
) {
  const { sink, calls } = createSink();
  const controller = new WorkspaceSessionController({
    queries: queries as WorkspaceQueryService,
    workspaceCommands: {
      setLastOpened: vi.fn().mockResolvedValue(undefined),
      ...commands,
    } as unknown as WorkspaceCommandService,
    sink,
    getCurrentWorkspaceId: () => currentWorkspaceId,
  });
  return { controller, calls };
}

describe("WorkspaceSessionController", () => {
  it("初始加载：恢复文档路由并回填最近打开", async () => {
    const doc = documentOf("doc-1", "ws-1");
    const { controller, calls } = createController({
      listWorkspaces: async () => [workspaceOf("ws-0"), workspaceOf("ws-1")],
      loadSession: async () => sessionOf("ws-1", [doc]),
    });

    const result = await controller.bootstrap({
      preferences: Promise.resolve({
        lastRoute: JSON.stringify({
          view: "document",
          workspaceId: "ws-1",
          pageId: "doc-1",
        }),
      }),
    });

    expect(result).toEqual({
      status: "restored",
      workspaceId: "ws-1",
      view: "document",
      pageId: "doc-1",
    });
    expect(calls).toContain("workspaces:2");
    expect(calls).toContain("success:1:ws-1");
    // 打点是 fire-and-forget，落库后才回填镜像。
    await vi.waitFor(() =>
      expect(calls.some((c) => c.startsWith("lastOpened:ws-1:"))).toBe(true),
    );
  });

  it("初始加载：路由文档已删除时回退知识库首页", async () => {
    const { controller } = createController({
      listWorkspaces: async () => [workspaceOf("ws-1")],
      loadSession: async () =>
        sessionOf("ws-1", [documentOf("doc-1", "ws-1", true)]),
    });

    const result = await controller.bootstrap({
      preferences: Promise.resolve({
        lastRoute: JSON.stringify({
          view: "document",
          workspaceId: "ws-1",
          pageId: "doc-1",
        }),
      }),
    });

    expect(result).toMatchObject({ view: "workspace", pageId: null });
  });

  it("初始加载：没有任何知识库时为 empty，仓储异常时为 failed", async () => {
    const { controller: emptyController } = createController({
      listWorkspaces: async () => [],
    });
    expect(
      await emptyController.bootstrap({
        preferences: Promise.resolve({ lastRoute: null }),
      }),
    ).toEqual({ status: "empty" });

    const { controller: failing } = createController({
      listWorkspaces: async () => {
        throw new Error("db down");
      },
    });
    expect(
      await failing.bootstrap({
        preferences: Promise.resolve({ lastRoute: null }),
      }),
    ).toEqual({ status: "failed", message: "本地数据加载失败，请重试。" });
  });

  it("初始加载：isActive 为 false 时中止且不写回", async () => {
    const { controller, calls } = createController({
      listWorkspaces: async () => [workspaceOf("ws-1")],
      loadSession: async () => sessionOf("ws-1", []),
    });

    const result = await controller.bootstrap({
      preferences: Promise.resolve({ lastRoute: null }),
      isActive: () => false,
    });

    expect(result).toEqual({ status: "aborted" });
    expect(calls).toEqual([]);
  });

  it("连切知识库：过期响应被丢弃，只有最后一次提交", async () => {
    const first = createDeferred<WorkspaceSessionData>();
    const second = createDeferred<WorkspaceSessionData>();
    const { controller, calls } = createController({
      loadSession: (id: string) =>
        id === "ws-a" ? first.promise : second.promise,
    });

    const a = controller.loadSession("ws-a");
    const b = controller.loadSession("ws-b");
    second.resolve(sessionOf("ws-b", []));
    first.resolve(sessionOf("ws-a", []));

    expect(await b).not.toBeNull();
    expect(await a).toBeNull();
    expect(calls.filter((c) => c.startsWith("success:"))).toEqual([
      "success:2:ws-b",
    ]);
  });

  it("会话加载失败：置错误态并返回 null", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { controller, calls } = createController({
      loadSession: async () => {
        throw new Error("boom");
      },
    });

    expect(await controller.loadSession("ws-1")).toBeNull();
    expect(calls).toContain("error:1:知识库加载失败，请重试。");
  });

  it("最近打开打点失败静默：不抛出、不回填镜像", async () => {
    const { controller, calls } = createController(
      {},
      { setLastOpened: vi.fn().mockRejectedValue(new Error("teardown")) },
    );

    controller.touchLastOpened("ws-1", 100);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([]);
  });

  it("refreshCurrentWorkspace：无会话时为 no-op，有会话时重读页面与标签", async () => {
    const loadPages = vi.fn().mockResolvedValue([documentOf("p1", "ws-1")]);
    const loadTags = vi.fn().mockResolvedValue({ tags: [], pageTags: [] });

    const { controller: idle } = createController({ loadPages, loadTags });
    await idle.refreshCurrentWorkspace();
    expect(loadPages).not.toHaveBeenCalled();

    const { controller, calls } = createController(
      { loadPages, loadTags },
      {},
      "ws-1",
    );
    await controller.refreshCurrentWorkspace();
    expect(loadPages).toHaveBeenCalledWith("ws-1");
    expect(loadTags).toHaveBeenCalledWith("ws-1");
    expect(calls).toEqual(["pages:1", "tags:0:0"]);
  });
});

/**
 * AppProvider 内存容器集成测试（R003 阶段 5 验收）：
 * 全套应用行为（启动、建库、建页、打开文档、重命名、标签、偏好、
 * 路由持久化、切换知识库）可脱离 IndexedDB 运行——
 * 证明仓储实现可整体替换。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { AppProvider, useApp } from "./AppState";
import { AppServicesProvider } from "./AppServicesProvider";
import { createInMemoryAppServices } from "../infrastructure/memory/createInMemoryAppServices";

let host: { app: ReturnType<typeof useApp> | null };

function Probe() {
  host.app = useApp();
  return null;
}

function renderWithMemory() {
  const { services, store } = createInMemoryAppServices();
  render(
    <AppServicesProvider services={services}>
      <AppProvider>
        <Probe />
      </AppProvider>
    </AppServicesProvider>,
  );
  return store;
}

describe("AppProvider + 内存仓储", () => {
  beforeEach(() => {
    cleanup();
    host = { app: null };
  });

  it("空启动就绪，全流程行为可脱离 IndexedDB", async () => {
    const store = renderWithMemory();
    // 空库：无知识库，直接就绪（UI 引导创建）。
    await waitFor(() => expect(host.app?.ready).toBe(true), { timeout: 3000 });
    expect(host.app!.workspaces).toHaveLength(0);

    // 建库并自动切换：会话原子加载完成。
    await host.app!.createWorkspace("我的知识库");
    await waitFor(() => expect(host.app!.workspace?.name).toBe("我的知识库"));
    expect(host.app!.workspaceStatus).toBe("ready");
    const wsId = host.app!.workspace!.id;

    // 建文档并打开。
    const page = await host.app!.createPage("document", null);
    expect(page).not.toBeNull();
    await waitFor(() => expect(host.app!.view).toBe("document"));
    expect(host.app!.selectedPageId).toBe(page!.id);

    // 重命名同步内存镜像。
    await host.app!.renamePage(page!.id, "第一篇文章");
    await waitFor(() =>
      expect(host.app!.pages.find((p) => p.id === page!.id)?.title).toBe(
        "第一篇文章",
      ),
    );

    // 标签绑定。
    const tag = await host.app!.createTag("重要", "#22A06B");
    await host.app!.setPageTags(page!.id, [tag!.id]);
    await waitFor(() =>
      expect(
        host.app!.pageTags.some(
          (pt) => pt.pageId === page!.id && pt.tagId === tag!.id,
        ),
      ).toBe(true),
    );

    // 偏好与路由持久化（内存容器内合并）。
    await host.app!.setTheme("dark");
    await waitFor(() => expect(host.app!.preferences.theme).toBe("dark"));
    host.app!.showRecent();
    await waitFor(() => expect(host.app!.view).toBe("recent"));
    await waitFor(() =>
      expect(store.preferences.lastRoute ?? "").toContain("recent"),
    );
    expect(store.preferences.theme).toBe("dark");

    // 切换知识库：会话原子替换。
    await host.app!.createWorkspace("第二知识库");
    await waitFor(() => expect(host.app!.workspace?.name).toBe("第二知识库"));
    expect(host.app!.pages.every((p) => p.workspaceId !== wsId)).toBe(true);
    await host.app!.switchWorkspace(wsId);
    await waitFor(() =>
      expect(host.app!.pages.some((p) => p.title === "第一篇文章")).toBe(true),
    );
  }, 15000);

  it("createDocumentWithContent 原子创建页面与正文并同步搜索索引（R004）", async () => {
    const store = renderWithMemory();
    await waitFor(() => expect(host.app?.ready).toBe(true), { timeout: 3000 });
    await host.app!.createWorkspace("我的知识库");
    await waitFor(() => expect(host.app!.workspace?.name).toBe("我的知识库"));
    const wsId = host.app!.workspace!.id;

    const contentJson = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "原子创建的正文关键词" }],
        },
      ],
    };
    const page = await host.app!.createDocumentWithContent({
      workspaceId: wsId,
      parentId: null,
      title: "原子文档",
      contentJson,
      textSnapshot: "原子创建的正文关键词",
    });
    expect(page).not.toBeNull();

    // 页面镜像已刷新，包含新页面。
    await waitFor(() =>
      expect(host.app!.pages.some((p) => p.id === page!.id)).toBe(true),
    );
    // 正文随创建一次落盘（非两段式）。
    expect(store.contents.get(page!.id)?.textSnapshot).toBe(
      "原子创建的正文关键词",
    );
    // 搜索索引可命中正文。
    const results = await host.app!.search("正文关键词");
    expect(results.some((r) => r.pageId === page!.id)).toBe(true);
  });
});

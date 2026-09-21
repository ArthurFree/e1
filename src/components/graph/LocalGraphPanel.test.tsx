/**
 * LocalGraphPanel 截断提示测试（R015.1）：
 * 截断 hint 归属 Panel 层（`.local-graph__hint`），GraphCanvas 不承担。
 * 装配沿用 BrokenLinksPanel 测试先例：生产 Web 容器浅拷贝后覆盖 graph port。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { GraphProjection } from "../../application/graph/GraphQueryPort";
import type { GraphQueryPort } from "../../application/graph/GraphQueryPort";
import { AppProvider } from "../../state/AppState";
import { AppServicesProvider } from "../../state/AppServicesProvider";
import { createBrowserAppServices } from "../../platform/web/createBrowserServices";
import { resetDB } from "../../platform/web/persistence/db";
import { LocalGraphPanel } from "./LocalGraphPanel";

function makeProjection(truncated: boolean): GraphProjection {
  return {
    centerNodeId: "a",
    nodes: [
      {
        id: "a",
        title: "中心页",
        relativePath: "中心.md",
        groupPath: null,
        tags: [],
      },
      {
        id: "b",
        title: "出站页",
        relativePath: "出站.md",
        groupPath: null,
        tags: [],
      },
    ],
    edges: [
      {
        id: "e1",
        sourceId: "a",
        targetId: "b",
        direction: "outgoing",
        state: "resolved",
        href: "出站.md",
      },
    ],
    truncated,
  };
}

function renderPanel(projection: GraphProjection) {
  // createBrowserAppServices 是进程单例——浅拷贝后覆盖可选 graph 字段。
  const base = createBrowserAppServices();
  const graph = {
    getLocalGraph: vi.fn(async () => projection),
    getWorkspaceGraph: vi.fn(async () => projection),
    getOrphans: vi.fn(async () => []),
  } satisfies GraphQueryPort;
  render(
    <AppServicesProvider services={{ ...base, graph }}>
      <AppProvider>
        <LocalGraphPanel pageId="a" vaultId="v1" savedAt={null} />
      </AppProvider>
    </AppServicesProvider>,
  );
}

describe("LocalGraphPanel", () => {
  beforeEach(async () => {
    cleanup();
    await resetDB();
  });

  it("投影 truncated 时渲染截断提示", async () => {
    renderPanel(makeProjection(true));
    expect(await screen.findByText("关系较多，已截断显示。")).toBeVisible();
  });

  it("投影未截断时不渲染截断提示", async () => {
    renderPanel(makeProjection(false));
    // 等待画布渲染完成后断言 hint 不存在。
    expect(
      await screen.findByRole("img", { name: "当前文档关系图" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("关系较多，已截断显示。")).toBeNull();
  });
});

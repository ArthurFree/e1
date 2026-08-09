import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { useApp } from "../../state/AppState";
import { AppProvider } from "../../state/AppState";
import { AppServicesProvider } from "../../state/AppServicesProvider";
import { resetDB } from "../../infrastructure/db";
import { TestApp } from "../../test/TestApp";
import { createDesktopRuntime } from "../../platform/desktop/createDesktopRuntime";
import type { E1DesktopAPI } from "../../platform/desktop/desktopApi";
import type { AppServices } from "../../application/AppServices";
import { GlobalSidebar } from "./GlobalSidebar";

/** 等 AppProvider 就绪后再渲染侧栏。 */
function ReadySidebar() {
  const { ready } = useApp();
  return ready ? <GlobalSidebar /> : null;
}

function ViewProbe() {
  const { view } = useApp();
  return <output data-testid="view">{view}</output>;
}

/** 以指定服务容器装配（R006 阶段 2：Desktop 容器走 mock 桌面桥）。 */
function ServicesApp({
  services,
  children,
}: {
  services: AppServices;
  children: ReactNode;
}) {
  return (
    <AppServicesProvider services={services}>
      <AppProvider>{children}</AppProvider>
    </AppServicesProvider>
  );
}

/** mock 桌面桥：listRecent 为空（全新安装），可选 selectDirectory 行为。 */
function mockDesktopApi(
  selectDirectory: E1DesktopAPI["vault"]["selectDirectory"],
): { api: E1DesktopAPI; open: ReturnType<typeof vi.fn> } {
  const open = vi.fn(async () => ({
    vaultId: "v1",
    absolutePath: "/tmp/测试库",
    name: "测试库",
    displayName: "测试库",
    createdAt: "2026-08-09T00:00:00.000Z",
    initialized: true,
  }));
  const api = {
    platform: "desktop",
    versions: {},
    vault: {
      selectDirectory,
      open,
      listRecent: vi.fn(async () => []),
      scan: vi.fn(async () => ({
        vault: { vaultId: "v1", name: "测试库" },
        entries: [
          {
            noteId: null,
            relativePath: "笔记.md",
            kind: "document",
            title: "笔记",
            parentPath: null,
            tags: [],
          },
        ],
      })),
    },
    note: { read: vi.fn(), create: vi.fn(), save: vi.fn() },
    asset: { pick: vi.fn(), import: vi.fn(), resolveUrl: vi.fn() },
  } as unknown as E1DesktopAPI;
  return { api, open };
}

describe("GlobalSidebar", () => {
  beforeEach(async () => {
    cleanup();
    await resetDB();
  });

  it("渲染账户行、搜索、主导航、知识库列表与底部工具区", async () => {
    render(
      <TestApp>
        <ReadySidebar />
      </TestApp>,
    );
    expect(await screen.findByText("个人空间")).toBeInTheDocument();
    expect(screen.getByLabelText("搜索")).toBeInTheDocument();
    expect(screen.getByLabelText("开始")).toBeInTheDocument();
    expect(screen.getByLabelText("最近")).toBeInTheDocument();
    expect(screen.getByLabelText("收藏")).toBeInTheDocument();
    expect(screen.getByLabelText("知识库「我的知识库」")).toBeInTheDocument();
    expect(screen.getByLabelText("回收站")).toBeInTheDocument();
    expect(screen.getByLabelText("设置")).toBeInTheDocument();
  });

  it("主导航切换视图", async () => {
    render(
      <TestApp>
        <ViewProbe />
        <ReadySidebar />
      </TestApp>,
    );
    await screen.findByLabelText("最近");
    fireEvent.click(screen.getByLabelText("最近"));
    expect(screen.getByTestId("view")).toHaveTextContent("recent");
    fireEvent.click(screen.getByLabelText("收藏"));
    expect(screen.getByTestId("view")).toHaveTextContent("favorites");
    fireEvent.click(screen.getByLabelText("开始"));
    expect(screen.getByTestId("view")).toHaveTextContent("start");
  });

  it("点击知识库切换到知识库首页", async () => {
    render(
      <TestApp>
        <ViewProbe />
        <ReadySidebar />
      </TestApp>,
    );
    fireEvent.click(await screen.findByLabelText("知识库「我的知识库」"));
    // switchWorkspace 为异步流程
    await waitFor(() =>
      expect(screen.getByTestId("view")).toHaveTextContent("workspace"),
    );
  });

  it("Web 端（localDirectory=false）只渲染「新建知识库」入口", async () => {
    render(
      <TestApp>
        <ReadySidebar />
      </TestApp>,
    );
    expect(await screen.findByLabelText("新建知识库")).toBeInTheDocument();
    expect(screen.queryByLabelText("打开本地知识库")).not.toBeInTheDocument();
  });
});

describe("GlobalSidebar（Desktop 能力，R006 阶段 2）", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("localDirectory=true 时渲染「打开本地知识库」而非「新建知识库」", async () => {
    const { api } = mockDesktopApi(vi.fn(async () => null));
    const { services } = createDesktopRuntime(api);
    render(
      <ServicesApp services={services}>
        <ReadySidebar />
      </ServicesApp>,
    );
    expect(await screen.findByLabelText("打开本地知识库")).toBeInTheDocument();
    expect(screen.queryByLabelText("新建知识库")).not.toBeInTheDocument();
  });

  it("点击「打开本地知识库」走 selectDirectory → vault.open 链路并入库列表", async () => {
    const selectDirectory = vi.fn(async () => ({
      vaultId: null,
      absolutePath: "/tmp/测试库",
      displayName: "测试库",
    }));
    const { api, open } = mockDesktopApi(selectDirectory);
    const { services } = createDesktopRuntime(api);
    render(
      <ServicesApp services={services}>
        <ReadySidebar />
      </ServicesApp>,
    );
    fireEvent.click(await screen.findByLabelText("打开本地知识库"));
    await screen.findByLabelText("知识库「测试库」");
    expect(selectDirectory).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith({ absolutePath: "/tmp/测试库" });
  });

  it("取消目录选择：不产生新知识库也不报错", async () => {
    const { api, open } = mockDesktopApi(vi.fn(async () => null));
    const { services } = createDesktopRuntime(api);
    render(
      <ServicesApp services={services}>
        <ReadySidebar />
      </ServicesApp>,
    );
    fireEvent.click(await screen.findByLabelText("打开本地知识库"));
    // 等一拍确认没有异步错误落地；知识库列表保持为空。
    await waitFor(() => expect(open).not.toHaveBeenCalled());
    expect(screen.queryByLabelText(/^知识库「/)).not.toBeInTheDocument();
  });
});

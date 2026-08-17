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
import { resetDB } from "../../platform/web/persistence/db";
import { TestApp } from "../../test/TestApp";
import { createDesktopRuntime } from "../../platform/desktop/createDesktopRuntime";
import { discardPendingVaultSelection } from "../../platform/desktop/vaultOpenConfirmation";
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
function mockDesktopApi(overrides: {
  selectDirectory: E1DesktopAPI["vault"]["selectDirectory"];
  openRecent?: E1DesktopAPI["vault"]["openRecent"];
  openSelection?: E1DesktopAPI["vault"]["openSelection"];
}): {
  api: E1DesktopAPI;
  openRecent: ReturnType<typeof vi.fn>;
  openSelection: ReturnType<typeof vi.fn>;
} {
  const openRecent = vi.fn(async () => ({
    vaultId: "v1",
    absolutePath: "/tmp/测试库",
    name: "测试库",
    displayName: "测试库",
    createdAt: "2026-08-09T00:00:00.000Z",
    initialized: false,
  }));
  const openSelection = vi.fn(
    async (input: { selectionToken: string; initialize: boolean }) => ({
      vaultId: input.initialize ? "v-new" : "transient:t-1",
      absolutePath: "/tmp/测试库",
      name: "测试库",
      displayName: "测试库",
      createdAt: "2026-08-09T00:00:00.000Z",
      initialized: input.initialize,
      transient: !input.initialize,
    }),
  );
  const api = {
    platform: "desktop",
    versions: {},
    vault: {
      selectDirectory: overrides.selectDirectory,
      openRecent: overrides.openRecent ?? openRecent,
      openSelection: overrides.openSelection ?? openSelection,
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
    asset: {
      pick: vi.fn(),
      import: vi.fn(),
      read: vi.fn(),
      resolveUrl: vi.fn(),
    },
    // R007 阶段 3：外部变更事件订阅（测试不推送事件，空订阅即可）。
    events: { subscribeVaultChanges: vi.fn(() => () => {}) },
  } as unknown as E1DesktopAPI;
  return { api, openRecent, openSelection };
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

describe("GlobalSidebar（Desktop 能力，R006 阶段 2 / C2.1）", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    // 确认握手模块为进程级单例，逐用例清理避免串扰。
    discardPendingVaultSelection();
  });

  it("localDirectory=true 时渲染「打开本地知识库」而非「新建知识库」", async () => {
    const { api } = mockDesktopApi({
      selectDirectory: vi.fn(async () => null),
    });
    const { services } = createDesktopRuntime(api);
    render(
      <ServicesApp services={services}>
        <ReadySidebar />
      </ServicesApp>,
    );
    expect(await screen.findByLabelText("打开本地知识库")).toBeInTheDocument();
    expect(screen.queryByLabelText("新建知识库")).not.toBeInTheDocument();
  });

  it("已初始化目录：selectDirectory → openRecent 链路并入库列表", async () => {
    const selectDirectory = vi.fn(async () => ({
      selectionToken: "s-token",
      vaultId: "v1",
      displayName: "测试库",
      initialized: true,
    }));
    const { api, openRecent } = mockDesktopApi({ selectDirectory });
    const { services } = createDesktopRuntime(api);
    render(
      <ServicesApp services={services}>
        <ReadySidebar />
      </ServicesApp>,
    );
    fireEvent.click(await screen.findByLabelText("打开本地知识库"));
    await screen.findByLabelText("知识库「测试库」");
    expect(selectDirectory).toHaveBeenCalledTimes(1);
    expect(openRecent).toHaveBeenCalledWith({ vaultId: "v1" });
  });

  it("未初始化目录：弹三选项确认框（FR-03）；「初始化并打开」走 openSelection", async () => {
    const selectDirectory = vi.fn(async () => ({
      selectionToken: "s-token",
      vaultId: null,
      displayName: "测试库",
      initialized: false,
    }));
    const { api, openSelection } = mockDesktopApi({ selectDirectory });
    const { services } = createDesktopRuntime(api);
    render(
      <ServicesApp services={services}>
        <ReadySidebar />
      </ServicesApp>,
    );
    fireEvent.click(await screen.findByLabelText("打开本地知识库"));
    // 三选项确认框出现（§36.1）。
    await screen.findByRole("dialog", { name: "打开本地文件夹" });
    expect(
      screen.getByText("这是一个普通 Markdown 文件夹"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "仅预览" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "初始化并打开" }));
    await screen.findByLabelText("知识库「测试库」");
    expect(openSelection).toHaveBeenCalledWith({
      selectionToken: "s-token",
      initialize: true,
    });
    expect(
      screen.queryByRole("dialog", { name: "打开本地文件夹" }),
    ).not.toBeInTheDocument();
  });

  it("未初始化目录：「仅预览」入库列表并带（预览）后缀", async () => {
    const selectDirectory = vi.fn(async () => ({
      selectionToken: "s-token",
      vaultId: null,
      displayName: "测试库",
      initialized: false,
    }));
    const { api, openSelection } = mockDesktopApi({ selectDirectory });
    const { services } = createDesktopRuntime(api);
    render(
      <ServicesApp services={services}>
        <ReadySidebar />
      </ServicesApp>,
    );
    fireEvent.click(await screen.findByLabelText("打开本地知识库"));
    await screen.findByRole("dialog", { name: "打开本地文件夹" });
    fireEvent.click(screen.getByRole("button", { name: "仅预览" }));
    await screen.findByLabelText("知识库「测试库（预览）」");
    expect(openSelection).toHaveBeenCalledWith({
      selectionToken: "s-token",
      initialize: false,
    });
  });

  it("未初始化目录：「取消」确认框后无变化（不产生知识库、不调 openSelection）", async () => {
    const selectDirectory = vi.fn(async () => ({
      selectionToken: "s-token",
      vaultId: null,
      displayName: "测试库",
      initialized: false,
    }));
    const { api, openSelection } = mockDesktopApi({ selectDirectory });
    const { services } = createDesktopRuntime(api);
    render(
      <ServicesApp services={services}>
        <ReadySidebar />
      </ServicesApp>,
    );
    fireEvent.click(await screen.findByLabelText("打开本地知识库"));
    await screen.findByRole("dialog", { name: "打开本地文件夹" });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "打开本地文件夹" }),
      ).not.toBeInTheDocument(),
    );
    expect(openSelection).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/^知识库「/)).not.toBeInTheDocument();
  });

  it("取消目录选择：不产生新知识库也不报错", async () => {
    const { api, openRecent } = mockDesktopApi({
      selectDirectory: vi.fn(async () => null),
    });
    const { services } = createDesktopRuntime(api);
    render(
      <ServicesApp services={services}>
        <ReadySidebar />
      </ServicesApp>,
    );
    fireEvent.click(await screen.findByLabelText("打开本地知识库"));
    // 等一拍确认没有异步错误落地；知识库列表保持为空。
    await waitFor(() => expect(openRecent).not.toHaveBeenCalled());
    expect(screen.queryByLabelText(/^知识库「/)).not.toBeInTheDocument();
  });
});

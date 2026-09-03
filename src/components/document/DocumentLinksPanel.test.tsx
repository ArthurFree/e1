/**
 * DocumentLinksPanel 组件测试（R010 Stage 5 §13）：
 * 门控（无 linkIndex 不渲染）、backlinks/outgoing 渲染、broken 置灰、
 * 点击导航调用 openDocument、索引状态提示（building/degraded + 重建）。
 * 装配沿用 SearchPanel 测试先例：生产 Web 容器浅拷贝后覆盖 linkIndex，
 * 导航命令经 NavigationSpy 替换为 spy 以断言调用。
 */
import type { ReactNode } from "react";
import { useMemo } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  Backlink,
  DocumentLink,
  LinkIndex,
} from "../../application/links/LinkIndex";
import type { SearchIndexStatus } from "../../application/search/SearchIndexStatus";
import { AppProvider } from "../../state/AppState";
import { AppServicesProvider } from "../../state/AppServicesProvider";
import {
  NavigationCommandContext,
  useNavigationCommands,
} from "../../state/NavigationContext";
import { createBrowserAppServices } from "../../platform/web/createBrowserServices";
import { resetDB } from "../../platform/web/persistence/db";
import { TestApp } from "../../test/TestApp";
import { DocumentLinksPanel } from "./DocumentLinksPanel";

function makeBacklink(overrides: Partial<Backlink> = {}): Backlink {
  return {
    sourcePageId: "src-1",
    targetPageId: "page-1",
    sourceTitle: "来源文档",
    snippet: null,
    href: "./source.md",
    ...overrides,
  };
}

function makeOutgoing(overrides: Partial<DocumentLink> = {}): DocumentLink {
  return {
    sourcePageId: "page-1",
    href: "./target.md",
    label: "目标文档",
    kind: "internal",
    targetPageId: "target-1",
    targetRelativePath: "target.md",
    fragment: null,
    broken: false,
    sourceVersion: "v1",
    ...overrides,
  };
}

/** 可观测的 LinkIndex stub（默认 ready + 空结果）。 */
function stubLinkIndex(input?: {
  backlinks?: Backlink[];
  outgoing?: DocumentLink[];
  status?: SearchIndexStatus;
}) {
  return {
    prepare: vi.fn(async () => {}),
    rebuild: vi.fn(async () => {}),
    upsert: vi.fn(async () => ({ indexed: true })),
    remove: vi.fn(async () => {}),
    relocate: vi.fn(async () => {}),
    analyzeRelocation: vi.fn(async () => []),
    getOutgoing: vi.fn(async () => input?.outgoing ?? []),
    getBacklinks: vi.fn(async () => input?.backlinks ?? []),
    getBrokenLinks: vi.fn(async () => []),
    getStatus: vi.fn(
      (): SearchIndexStatus =>
        input?.status ?? { state: "ready", indexedDocuments: 3 },
    ),
  } satisfies LinkIndex;
}

/** 把面板消费到的 openDocument 替换为 spy（其余命令保持真实实现）。 */
function NavigationSpy({
  spy,
  children,
}: {
  spy: (pageId: string) => Promise<void>;
  children: ReactNode;
}) {
  const commands = useNavigationCommands();
  const value = useMemo(
    () => ({ ...commands, openDocument: spy }),
    [commands, spy],
  );
  return (
    <NavigationCommandContext.Provider value={value}>
      {children}
    </NavigationCommandContext.Provider>
  );
}

function renderPanel(
  linkIndex: LinkIndex,
  options?: { openDocument?: (pageId: string) => Promise<void> },
) {
  // createBrowserAppServices 是进程单例——浅拷贝后覆盖可选字段。
  const services = { ...createBrowserAppServices(), linkIndex };
  const spy = options?.openDocument ?? (async () => {});
  render(
    <AppServicesProvider services={services}>
      <AppProvider>
        <NavigationSpy spy={spy}>
          <DocumentLinksPanel pageId="page-1" vaultId="ws-1" savedAt={null} />
        </NavigationSpy>
      </AppProvider>
    </AppServicesProvider>,
  );
}

describe("DocumentLinksPanel", () => {
  beforeEach(async () => {
    cleanup();
    await resetDB();
    vi.restoreAllMocks();
  });

  it("未装配 linkIndex（Web）时不渲染任何内容", () => {
    const { container } = render(
      <TestApp>
        <DocumentLinksPanel pageId="page-1" vaultId="ws-1" savedAt={null} />
      </TestApp>,
    );
    expect(container.querySelector(".doc-links")).toBeNull();
    expect(screen.queryByText(/引用此页面/)).toBeNull();
    expect(screen.queryByText(/此页面引用/)).toBeNull();
  });

  it("backlinks：显示来源标题与摘录，点击来源调用 openDocument", async () => {
    const openDocument = vi.fn(async (_pageId: string) => {});
    renderPanel(
      stubLinkIndex({
        backlinks: [
          makeBacklink({
            sourcePageId: "src-1",
            sourceTitle: "React 调度系统",
            snippet: "Fiber 更新流程",
          }),
          makeBacklink({
            sourcePageId: "src-2",
            sourceTitle: "前端性能优化",
          }),
        ],
      }),
      { openDocument },
    );
    expect(await screen.findByText("引用此页面 · 2")).toBeInTheDocument();
    expect(screen.getByText("React 调度系统")).toBeInTheDocument();
    expect(screen.getByText("「Fiber 更新流程」")).toBeInTheDocument();

    fireEvent.click(screen.getByText("React 调度系统"));
    await waitFor(() => expect(openDocument).toHaveBeenCalledWith("src-1"));
  });

  it("outgoing：internal 可点击打开目标；external 静态展示 href 与徽标", async () => {
    const openDocument = vi.fn(async (_pageId: string) => {});
    renderPanel(
      stubLinkIndex({
        outgoing: [
          makeOutgoing({ label: "React Fiber", targetPageId: "target-1" }),
          makeOutgoing({
            href: "https://example.com",
            label: "Example",
            kind: "external",
            targetPageId: null,
            targetRelativePath: null,
          }),
        ],
      }),
      { openDocument },
    );
    expect(await screen.findByText("此页面引用 · 2")).toBeInTheDocument();

    fireEvent.click(screen.getByText("React Fiber"));
    await waitFor(() => expect(openDocument).toHaveBeenCalledWith("target-1"));

    expect(screen.getByText("Example")).toBeInTheDocument();
    expect(screen.getByText("https://example.com")).toBeInTheDocument();
    expect(screen.getByText("外部链接")).toBeInTheDocument();
    // external 链接不可点击导航。
    fireEvent.click(screen.getByText("Example"));
    expect(openDocument).toHaveBeenCalledTimes(1);
  });

  it("broken 内部链接：置灰并标注「目标不存在」，不可点击", async () => {
    const openDocument = vi.fn(async (_pageId: string) => {});
    renderPanel(
      stubLinkIndex({
        outgoing: [
          makeOutgoing({
            href: "./gone.md",
            label: "旧方案",
            targetPageId: null,
            targetRelativePath: "gone.md",
            broken: true,
          }),
        ],
      }),
      { openDocument },
    );
    const label = await screen.findByText("旧方案");
    expect(label.closest(".doc-links__item--broken")).not.toBeNull();
    expect(screen.getByText("目标不存在")).toBeInTheDocument();

    fireEvent.click(label);
    expect(openDocument).not.toHaveBeenCalled();
  });

  it("backlinks 与 outgoing 均为空时整体隐藏", async () => {
    const { container } = render(
      <TestApp>
        <DocumentLinksPanel pageId="page-1" vaultId="ws-1" savedAt={null} />
      </TestApp>,
    );
    expect(container.querySelector(".doc-links")).toBeNull();

    cleanup();
    const { container: withIndex } = render(
      <AppServicesProvider
        services={{ ...createBrowserAppServices(), linkIndex: stubLinkIndex() }}
      >
        <AppProvider>
          <DocumentLinksPanel pageId="page-1" vaultId="ws-1" savedAt={null} />
        </AppProvider>
      </AppServicesProvider>,
    );
    // ready + 空结果：首轮查询返回后仍不留空区。
    await waitFor(() => {
      expect(withIndex.querySelector(".doc-links")).toBeNull();
    });
  });

  it("building：显示「正在建立链接索引…」", async () => {
    renderPanel(stubLinkIndex({ status: { state: "building" } }));
    expect(await screen.findByText("正在建立链接索引…")).toBeInTheDocument();
  });

  it("degraded：显示「链接索引需要修复」，点「重建索引」触发 rebuild", async () => {
    const linkIndex = stubLinkIndex({
      status: { state: "degraded", reason: "x" },
    });
    renderPanel(linkIndex);
    const button = await screen.findByRole("button", { name: "重建索引" });
    fireEvent.click(button);
    await waitFor(() => expect(linkIndex.rebuild).toHaveBeenCalled());
  });

  it("保存成功（savedAt 变化）后延迟刷新查询", async () => {
    const linkIndex = stubLinkIndex();
    const services = { ...createBrowserAppServices(), linkIndex };
    const { rerender } = render(
      <AppServicesProvider services={services}>
        <AppProvider>
          <DocumentLinksPanel pageId="page-1" vaultId="ws-1" savedAt={null} />
        </AppProvider>
      </AppServicesProvider>,
    );
    // 挂载完成（立即拉取 + prepare 后拉取）后记录基线调用次数。
    await waitFor(() =>
      expect(linkIndex.getBacklinks.mock.calls.length).toBeGreaterThanOrEqual(
        2,
      ),
    );
    const before = linkIndex.getBacklinks.mock.calls.length;
    rerender(
      <AppServicesProvider services={services}>
        <AppProvider>
          <DocumentLinksPanel pageId="page-1" vaultId="ws-1" savedAt={12345} />
        </AppProvider>
      </AppServicesProvider>,
    );
    // 400ms 防抖后触发新一轮拉取。
    await waitFor(
      () =>
        expect(linkIndex.getBacklinks.mock.calls.length).toBeGreaterThan(
          before,
        ),
      { timeout: 2000 },
    );
  });
});

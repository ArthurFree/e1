/**
 * BrokenLinksPanel 组件测试（R010 Stage 6 §14）：
 * 门控（无 linkIndex 不渲染）、broken 列表渲染（来源/href/「目标不存在」）、
 * 点击来源打开文档、重新定位流程（PagePicker → 编排命令 → 乐观移除）、
 * 节点引用禁用入口、失败错误提示、building/空列表状态。
 * 装配沿用 DocumentLinksPanel 测试先例：生产 Web 容器浅拷贝后覆盖
 * linkIndex 与 commands.document，导航命令经 NavigationSpy 替换为 spy。
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
import type { DocumentLink, LinkIndex } from "../application/links/LinkIndex";
import type { SearchIndexStatus } from "../application/search/SearchIndexStatus";
import type { DocumentCommandService } from "../application/commands/DocumentCommandService";
import { AppProvider } from "../state/AppState";
import { AppServicesProvider } from "../state/AppServicesProvider";
import {
  NavigationCommandContext,
  useNavigationCommands,
} from "../state/NavigationContext";
import { createBrowserAppServices } from "../platform/web/createBrowserServices";
import { resetDB } from "../platform/web/persistence/db";
import { TestApp } from "../test/TestApp";
import { BrokenLinksPanel } from "./BrokenLinksPanel";

function makeBroken(overrides: Partial<DocumentLink> = {}): DocumentLink {
  return {
    sourcePageId: "src-1",
    href: "../archive/旧方案.md",
    label: "旧方案",
    kind: "internal",
    targetPageId: null,
    targetRelativePath: "archive/旧方案.md",
    fragment: null,
    broken: true,
    sourceVersion: "v1",
    ...overrides,
  };
}

/** 可观测的 LinkIndex stub（默认 ready + 给定 broken 列表）。 */
function stubLinkIndex(input?: {
  broken?: DocumentLink[];
  status?: SearchIndexStatus;
}) {
  return {
    prepare: vi.fn(async () => {}),
    rebuild: vi.fn(async () => {}),
    upsert: vi.fn(async () => ({ indexed: true })),
    remove: vi.fn(async () => {}),
    relocate: vi.fn(async () => {}),
    getOutgoing: vi.fn(async () => []),
    getBacklinks: vi.fn(async () => []),
    getBrokenLinks: vi.fn(async () => input?.broken ?? []),
    getStatus: vi.fn(
      (): SearchIndexStatus =>
        input?.status ?? { state: "ready", indexedDocuments: 3 },
    ),
  } satisfies LinkIndex;
}

/** relocateBrokenLink 编排 spy（其余命令保持生产实现）。 */
function stubDocumentCommands(
  relocate: ReturnType<typeof vi.fn>,
): DocumentCommandService {
  return {
    relocateBrokenLink: relocate,
  } as unknown as DocumentCommandService;
}

/** 把面板消费到的 openDocument 替换为 spy（DocumentLinksPanel 测试同先例）。 */
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

function renderPanel(options?: {
  linkIndex?: LinkIndex;
  relocate?: ReturnType<typeof vi.fn>;
  openDocument?: (pageId: string) => Promise<void>;
}) {
  // createBrowserAppServices 是进程单例——浅拷贝后覆盖可选字段。
  const base = createBrowserAppServices();
  const services = {
    ...base,
    linkIndex: options?.linkIndex ?? stubLinkIndex(),
    ...(options?.relocate
      ? {
          commands: {
            ...base.commands,
            document: stubDocumentCommands(options.relocate),
          },
        }
      : {}),
  };
  const spy = options?.openDocument ?? (async () => {});
  render(
    <AppServicesProvider services={services}>
      <AppProvider>
        <NavigationSpy spy={spy}>
          <BrokenLinksPanel vaultId="ws-1" onClose={() => {}} />
        </NavigationSpy>
      </AppProvider>
    </AppServicesProvider>,
  );
}

describe("BrokenLinksPanel", () => {
  beforeEach(async () => {
    cleanup();
    await resetDB();
    vi.restoreAllMocks();
  });

  it("未装配 linkIndex（Web）时不渲染任何内容", () => {
    const { container } = render(
      <TestApp>
        <BrokenLinksPanel vaultId="ws-1" onClose={() => {}} />
      </TestApp>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(container.querySelector(".broken-links__row")).toBeNull();
  });

  it("渲染 broken 列表：来源标题回退、原 href 与「目标不存在」徽标", async () => {
    renderPanel({
      linkIndex: stubLinkIndex({
        broken: [
          makeBroken(),
          makeBroken({
            sourcePageId: "src-2",
            href: "./gone.md",
            label: "已删除",
          }),
        ],
      }),
    });
    expect(await screen.findByText("失效链接 · 2")).toBeInTheDocument();
    // 来源 pageId 不在会话页面镜像中 → 标题回退「未知文档」。
    expect(screen.getAllByText("未知文档")).toHaveLength(2);
    expect(screen.getByText("../archive/旧方案.md")).toBeInTheDocument();
    expect(screen.getAllByText("目标不存在")).toHaveLength(2);
  });

  it("点击来源标题调用 openDocument", async () => {
    const openDocument = vi.fn(async (_pageId: string) => {});
    renderPanel({
      linkIndex: stubLinkIndex({ broken: [makeBroken()] }),
      openDocument,
    });
    const source = await screen.findByRole("button", { name: /未知文档/ });
    fireEvent.click(source);
    await waitFor(() => expect(openDocument).toHaveBeenCalledWith("src-1"));
  });

  it("重新定位：PagePicker 选页 → 调编排命令 → 成功后移除命中行", async () => {
    const relocate = vi.fn(async () => ({ rewritten: 1, newHref: "x.md" }));
    renderPanel({
      linkIndex: stubLinkIndex({ broken: [makeBroken()] }),
      relocate,
    });
    fireEvent.click(await screen.findByRole("button", { name: "重新定位" }));
    // PagePicker 打开（嵌套 Dialog），列出种子页面（源文档被排除）。
    const picker = await screen.findByRole("dialog", { name: "选择页面" });
    expect(picker).toBeInTheDocument();
    fireEvent.click(await screen.findByText("任务清单"));
    await waitFor(() =>
      expect(relocate).toHaveBeenCalledWith({
        sourcePageId: "src-1",
        oldHref: "../archive/旧方案.md",
        newTargetPageId: expect.any(String),
      }),
    );
    // 成功后乐观移除命中行 → 空列表。
    expect(await screen.findByText("没有失效链接。")).toBeInTheDocument();
  });

  it("重新定位失败时展示错误文案且行保留", async () => {
    const relocate = vi.fn(async () => {
      throw new Error("文档已被其他窗口修改。");
    });
    renderPanel({
      linkIndex: stubLinkIndex({ broken: [makeBroken()] }),
      relocate,
    });
    fireEvent.click(await screen.findByRole("button", { name: "重新定位" }));
    fireEvent.click(await screen.findByText("任务清单"));
    expect(
      await screen.findByText("文档已被其他窗口修改。"),
    ).toBeInTheDocument();
    expect(screen.getByText("../archive/旧方案.md")).toBeInTheDocument();
  });

  it("节点引用（href 为空）禁用「重新定位」", async () => {
    renderPanel({
      linkIndex: stubLinkIndex({
        broken: [makeBroken({ href: "", label: "被删的提及" })],
      }),
    });
    const button = await screen.findByRole("button", { name: "重新定位" });
    expect(button).toBeDisabled();
  });

  it("building：显示「正在建立链接索引…」", async () => {
    renderPanel({
      linkIndex: stubLinkIndex({ status: { state: "building" } }),
    });
    expect(await screen.findByText("正在建立链接索引…")).toBeInTheDocument();
  });

  it("空列表：显示「没有失效链接。」", async () => {
    renderPanel({ linkIndex: stubLinkIndex({ broken: [] }) });
    expect(await screen.findByText("没有失效链接。")).toBeInTheDocument();
  });
});

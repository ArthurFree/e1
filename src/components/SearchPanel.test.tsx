import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AppServices } from "../application/AppServices";
import type { FullTextSearchIndex } from "../application/search/FullTextSearchIndex";
import type { SearchIndexStatus } from "../application/search/SearchIndexStatus";
import { AppProvider } from "../state/AppState";
import { AppServicesProvider } from "../state/AppServicesProvider";
import { createBrowserAppServices } from "../platform/web/createBrowserServices";
import { TestApp } from "../test/TestApp";
import { resetDB } from "../platform/web/persistence/db";
import { SearchPanel } from "./SearchPanel";

describe("SearchPanel", () => {
  beforeEach(async () => {
    cleanup();
    await resetDB();
    vi.restoreAllMocks();
  });

  it("输入关键词后显示匹配文档，Enter 选中并关闭", async () => {
    const onClose = vi.fn();
    render(
      <TestApp>
        <SearchPanel onClose={onClose} />
      </TestApp>,
    );
    const input = screen.getByLabelText("搜索文档");
    fireEvent.change(input, { target: { value: "本地优先" } });

    const item = await screen.findByText(
      (content, element) =>
        element?.classList.contains("command-list__title") === true &&
        content.includes("欢迎"),
      undefined,
      { timeout: 2000 },
    );
    expect(item).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onClose).toHaveBeenCalled();
  });

  it("无匹配时显示空结果态", async () => {
    render(
      <TestApp>
        <SearchPanel onClose={() => undefined} />
      </TestApp>,
    );
    fireEvent.change(screen.getByLabelText("搜索文档"), {
      target: { value: "肯定不存在的关键词xyz" },
    });
    expect(
      await screen.findByText("没有匹配的结果", undefined, { timeout: 2000 }),
    ).toBeInTheDocument();
  });

  it("未输入时显示提示而非结果", () => {
    render(
      <TestApp>
        <SearchPanel onClose={() => undefined} />
      </TestApp>,
    );
    expect(
      screen.getByText("输入关键词，按标题与正文查找文档。"),
    ).toBeInTheDocument();
  });
});

/** 携带 fullTextSearch 的装配（R008 Stage 6：Desktop 运行时注入）。 */
function renderWithFullText(
  fullText: FullTextSearchIndex,
  servicesOverride?: (services: AppServices) => void,
) {
  // createBrowserAppServices 是进程单例——浅拷贝后覆盖可选字段。
  const services = { ...createBrowserAppServices(), fullTextSearch: fullText };
  servicesOverride?.(services);
  render(
    <AppServicesProvider services={services}>
      <AppProvider>
        <SearchPanel onClose={() => undefined} />
      </AppProvider>
    </AppServicesProvider>,
  );
}

function stubFullText(status: SearchIndexStatus): FullTextSearchIndex & {
  current: SearchIndexStatus;
} {
  const stub = {
    current: status,
    getStatus: vi.fn(() => stub.current),
    prepare: vi.fn(async () => {}),
    rebuild: vi.fn(async () => {
      stub.current = { state: "ready", indexedDocuments: 2 };
    }),
    search: vi.fn(async () => []),
    upsert: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    relocate: vi.fn(async () => {}),
  };
  return stub as FullTextSearchIndex & { current: SearchIndexStatus };
}

describe("SearchPanel 全文索引状态（R008 Stage 6 §14.1/§14.3）", () => {
  beforeEach(async () => {
    cleanup();
    await resetDB();
    vi.restoreAllMocks();
  });

  it("building：显示「正在建立本地搜索索引…」", async () => {
    renderWithFullText(stubFullText({ state: "building" }));
    expect(
      await screen.findByText("正在建立本地搜索索引…"),
    ).toBeInTheDocument();
  });

  it("degraded：显示「搜索索引需要修复」，点「重建索引」触发 rebuild", async () => {
    const fullText = stubFullText({ state: "degraded", reason: "x" });
    renderWithFullText(fullText);
    const button = await screen.findByRole("button", { name: "重建索引" });
    button.click();
    await waitFor(() => expect(fullText.rebuild).toHaveBeenCalled());
  });

  it("未装配 fullTextSearch（Web）：不出现索引状态条", async () => {
    render(
      <TestApp>
        <SearchPanel onClose={() => undefined} />
      </TestApp>,
    );
    expect(screen.queryByText("正在建立本地搜索索引…")).toBeNull();
    expect(screen.queryByText("搜索索引需要修复")).toBeNull();
  });

  it("过期查询结果被丢弃（§14.3 request id）", async () => {
    const fullText = stubFullText({ state: "ready", indexedDocuments: 1 });
    // 第一次查询慢、第二次快：慢的后至不得回填旧结果。
    const pending: {
      resolve?: (
        value: { pageId: string; title: string; snippet: string }[],
      ) => void;
    } = {};
    const queryMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            pending.resolve = resolve;
          }),
      )
      .mockResolvedValue([{ pageId: "p2", title: "新结果", snippet: "" }]);
    renderWithFullText(fullText, (services) => {
      services.queries.search.query =
        queryMock as AppServices["queries"]["search"]["query"];
    });
    const input = screen.getByLabelText("搜索文档");
    fireEvent.change(input, { target: { value: "第一次" } });
    await waitFor(() => expect(queryMock).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: "第二次" } });
    await waitFor(() => expect(queryMock).toHaveBeenCalledTimes(2));
    await screen.findByText("新结果");
    // 慢查询后至：结果被丢弃，不回填。
    pending.resolve?.([{ pageId: "p1", title: "旧结果", snippet: "" }]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText("旧结果")).toBeNull();
    expect(screen.getByText("新结果")).toBeInTheDocument();
  });
});

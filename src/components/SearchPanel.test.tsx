import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppProvider } from "../state/AppState";
import { resetDB } from "../infrastructure/db";
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
      <AppProvider>
        <SearchPanel onClose={onClose} />
      </AppProvider>,
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
      <AppProvider>
        <SearchPanel onClose={() => undefined} />
      </AppProvider>,
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
      <AppProvider>
        <SearchPanel onClose={() => undefined} />
      </AppProvider>,
    );
    expect(screen.getByText("输入关键词，按标题与正文查找文档。")).toBeInTheDocument();
  });
});

/**
 * PagePicker 组件测试（R010 Stage 6 §14）：
 * 页面列表渲染、搜索过滤、选中回调、排除源文档、Escape 关闭。
 * 装配沿用面板测试先例：生产 Web 容器（TestApp 种子数据）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TestApp } from "../test/TestApp";
import { resetDB } from "../platform/web/persistence/db";
import { PagePicker } from "./PagePicker";

function renderPicker(
  onSelect = vi.fn(),
  onClose = vi.fn(),
  excludePageId?: string,
) {
  render(
    <TestApp>
      <PagePicker
        onSelect={onSelect}
        onClose={onClose}
        excludePageId={excludePageId}
      />
    </TestApp>,
  );
  return { onSelect, onClose };
}

describe("PagePicker", () => {
  beforeEach(async () => {
    cleanup();
    await resetDB();
  });

  it("列出当前知识库未删除的文档（分组不出现）", async () => {
    renderPicker();
    // 种子数据：任务清单 / 会议纪要示例 为文档，产品资料 为分组。
    expect(await screen.findByText("任务清单")).toBeInTheDocument();
    expect(screen.getByText("会议纪要示例")).toBeInTheDocument();
    expect(screen.queryByText("产品资料")).toBeNull();
  });

  it("按标题过滤，无匹配时提示", async () => {
    renderPicker();
    // 等待页面列表异步加载完成再输入，避免过滤的是空列表。
    await screen.findByText("任务清单");
    const input = screen.getByLabelText("搜索页面");
    fireEvent.change(input, { target: { value: "任务" } });
    expect(screen.getByText("任务清单")).toBeInTheDocument();
    expect(screen.queryByText("会议纪要示例")).toBeNull();

    fireEvent.change(input, { target: { value: "不存在" } });
    expect(screen.getByText("没有匹配的结果")).toBeInTheDocument();
  });

  it("点击选中回调 pageId；Enter 选中首条", async () => {
    const { onSelect } = renderPicker();
    const option = await screen.findByText("任务清单");
    fireEvent.click(option);
    expect(onSelect).toHaveBeenCalledTimes(1);
    const firstId = onSelect.mock.calls[0]![0] as string;
    expect(firstId).not.toBe("");

    cleanup();
    const second = renderPicker();
    // 等待列表加载后 Enter 才有候选可选。
    await screen.findByText("任务清单");
    const input = screen.getByLabelText("搜索页面");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(second.onSelect).toHaveBeenCalledTimes(1);
  });

  it("excludePageId 的页面不出现在列表中", async () => {
    // 先经一次选中拿到「任务清单」的 pageId，再以它作为排除项重渲染。
    const first = renderPicker();
    fireEvent.click(await screen.findByText("任务清单"));
    const taskId = first.onSelect.mock.calls[0]![0] as string;
    cleanup();

    renderPicker(vi.fn(), vi.fn(), taskId);
    await screen.findByText("会议纪要示例");
    expect(screen.queryByText("任务清单")).toBeNull();
  });

  it("Escape 触发 onClose", async () => {
    const { onClose } = renderPicker();
    await screen.findByLabelText("搜索页面");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

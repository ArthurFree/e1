import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TitleEditor } from "./TitleEditor";

describe("TitleEditor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("标题编辑经防抖后自动保存一次", () => {
    const onSave = vi.fn();
    render(<TitleEditor pageId="p1" title="旧标题" onSave={onSave} />);
    const input = screen.getByLabelText("文档标题");

    fireEvent.change(input, { target: { value: "新" } });
    fireEvent.change(input, { target: { value: "新标" } });
    fireEvent.change(input, { target: { value: "新标题" } });
    expect(onSave).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("p1", "新标题");
  });

  it("卸载时强制保存挂起的编辑", () => {
    const onSave = vi.fn();
    const { unmount } = render(
      <TitleEditor pageId="p1" title="旧标题" onSave={onSave} />,
    );
    fireEvent.change(screen.getByLabelText("文档标题"), {
      target: { value: "未落盘" },
    });
    unmount();
    expect(onSave).toHaveBeenCalledWith("p1", "未落盘");
  });

  it("Enter 落盘标题并进入正文", () => {
    const onSave = vi.fn();
    const onExitToBody = vi.fn();
    render(
      <TitleEditor
        pageId="p1"
        title="旧标题"
        onSave={onSave}
        onExitToBody={onExitToBody}
      />,
    );
    const input = screen.getByLabelText("文档标题");

    fireEvent.change(input, { target: { value: "新标题" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // 不等防抖：Enter 立即 flush 保存，再交出焦点。
    expect(onSave).toHaveBeenCalledWith("p1", "新标题");
    expect(onExitToBody).toHaveBeenCalledTimes(1);
  });

  it("ArrowDown 进入正文", () => {
    const onExitToBody = vi.fn();
    render(
      <TitleEditor
        pageId="p1"
        title="旧标题"
        onSave={vi.fn()}
        onExitToBody={onExitToBody}
      />,
    );
    fireEvent.keyDown(screen.getByLabelText("文档标题"), { key: "ArrowDown" });
    expect(onExitToBody).toHaveBeenCalledTimes(1);
  });
});

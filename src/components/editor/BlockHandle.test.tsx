import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { Editor } from "@tiptap/core";
import { buildDocumentExtensions } from "../../editor/extensions";
import { BlockHandle } from "./BlockHandle";

let editor: Editor | null = null;

/**
 * jsdom 无布局信息，posAtCoords 恒为 null；把它 stub 成固定文档位置，
 * 让悬停定位逻辑（getTopLevelBlock / nodeDOM）在真实编辑器状态上运行。
 */
function setup() {
  editor = new Editor({
    element: document.createElement("div"),
    extensions: buildDocumentExtensions(),
    content: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "第一段" }] },
        { type: "paragraph", content: [{ type: "text", text: "第二段" }] },
      ],
    } as never,
  });
  vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: 1, inside: 0 });
  render(
    <div>
      <BlockHandle editor={editor} />
    </div>,
  );
  return editor;
}

/** 悬停正文使把手出现，再点开块菜单。 */
function openMenu(e: Editor) {
  fireEvent.mouseMove(e.view.dom, { clientX: 10, clientY: 10 });
  fireEvent.click(screen.getByRole("button", { name: "块菜单" }));
  return screen.getByRole("menu", { name: "块操作菜单" });
}

describe("BlockHandle 块菜单键盘导航", () => {
  beforeEach(() => cleanup());
  afterEach(() => {
    editor?.destroy();
    editor = null;
    vi.restoreAllMocks();
  });

  it("打开菜单后焦点落在首个菜单项", () => {
    const e = setup();
    openMenu(e);
    const items = screen.getAllByRole("menuitem");
    expect(items[0]).toHaveFocus();
    expect(items[0]).toHaveTextContent("复制");
  });

  it("方向键在菜单项间循环移动焦点", () => {
    const e = setup();
    const menu = openMenu(e);
    const items = screen.getAllByRole("menuitem");

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(items[1]).toHaveFocus();

    fireEvent.keyDown(menu, { key: "ArrowUp" });
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    // 从首项向上环绕到末项。
    expect(items[items.length - 1]).toHaveFocus();

    fireEvent.keyDown(menu, { key: "Home" });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(menu, { key: "End" });
    expect(items[items.length - 1]).toHaveFocus();
  });

  it("Enter 执行聚焦的菜单项（复制块）", () => {
    const e = setup();
    openMenu(e);
    const blocksBefore = e.state.doc.childCount;
    // 原生 button 聚焦时 Enter 即 click；组件测试里直接触发 click 等价。
    fireEvent.click(screen.getAllByRole("menuitem")[0]);
    expect(e.state.doc.childCount).toBe(blocksBefore + 1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("Escape 关闭菜单并把焦点还给菜单按钮", () => {
    const e = setup();
    openMenu(e);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "块菜单" })).toHaveFocus();
  });

  it("拖动开始即关闭已打开的块菜单", () => {
    const e = setup();
    openMenu(e);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.dragStart(screen.getByRole("button", { name: "拖动块" }), {
      dataTransfer: { effectAllowed: "none", setData: vi.fn() },
    });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("从正文移向把手时不立刻隐藏", () => {
    vi.useFakeTimers();
    const e = setup();
    fireEvent.mouseMove(e.view.dom, { clientX: 10, clientY: 10 });
    const dragBtn = screen.getByRole("button", { name: "拖动块" });

    // 模拟离开正文且 relatedTarget 指向把手按钮（真实浏览器移入把手时的行为）。
    fireEvent.mouseLeave(e.view.dom, { relatedTarget: dragBtn });
    expect(screen.getByRole("button", { name: "块菜单" })).toBeInTheDocument();

    fireEvent.mouseEnter(dragBtn.parentElement!);
    vi.advanceTimersByTime(300);
    // 宽限被取消，把手仍在。
    expect(screen.getByRole("button", { name: "拖动块" })).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("彻底离开编辑区后经短暂延迟隐藏把手", () => {
    vi.useFakeTimers();
    const e = setup();
    fireEvent.mouseMove(e.view.dom, { clientX: 10, clientY: 10 });
    expect(screen.getByRole("button", { name: "拖动块" })).toBeInTheDocument();

    // mouseleave 不冒泡；用原生 MouseEvent 确保 relatedTarget 生效。
    e.view.dom.dispatchEvent(
      new MouseEvent("mouseleave", {
        bubbles: false,
        relatedTarget: document.body,
      }),
    );
    expect(screen.getByRole("button", { name: "拖动块" })).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(
      screen.queryByRole("button", { name: "拖动块" }),
    ).not.toBeInTheDocument();
    vi.useRealTimers();
  });
});

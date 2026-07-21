import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { buildDocumentExtensions } from "../../editor/extensions";
import { FormatToolbar } from "./FormatToolbar";

let editor: Editor | null = null;

function setup(content?: unknown) {
  editor = new Editor({
    element: document.createElement("div"),
    extensions: buildDocumentExtensions(),
    content: (content ?? { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "正文内容" }] }] }) as never,
  });
  render(<FormatToolbar editor={editor} />);
  return editor;
}

describe("FormatToolbar", () => {
  beforeEach(() => cleanup());
  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  it("渲染核心命令按钮", () => {
    setup();
    expect(screen.getByRole("toolbar", { name: "格式工具栏" })).toBeInTheDocument();
    for (const label of ["撤销", "重做", "加粗", "斜体", "下划线", "删除线", "行内代码", "上标", "下标", "链接", "项目列表", "编号列表", "任务列表", "增加缩进", "减少缩进", "清除行内格式", "重置为正文"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    for (const label of ["插入", "段落样式", "字号", "颜色与高亮", "更多命令"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("撤销在无历史时禁用，编辑后可用", async () => {
    const e = setup();
    expect(screen.getByRole("button", { name: "撤销" })).toBeDisabled();
    e.commands.insertContent("新内容");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "撤销" })).toBeEnabled();
    });
  });

  it("段落样式菜单包含标题 4–6 并可应用", () => {
    const e = setup();
    e.commands.setTextSelection(1);
    fireEvent.click(screen.getByRole("button", { name: "段落样式" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "标题 4" }));
    expect(e.getJSON().content?.[0]?.attrs?.level).toBe(4);

    fireEvent.click(screen.getByRole("button", { name: "段落样式" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "标题 6" }));
    expect(e.getJSON().content?.[0]?.attrs?.level).toBe(6);
  });

  it("字号菜单设置并恢复默认", () => {
    const e = setup();
    e.commands.setTextSelection({ from: 1, to: 5 });
    fireEvent.click(screen.getByRole("button", { name: "字号" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "20px" }));
    expect(JSON.stringify(e.getJSON())).toContain("20px");

    fireEvent.click(screen.getByRole("button", { name: "字号" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "默认" }));
    expect(JSON.stringify(e.getJSON())).not.toContain("20px");
  });

  it("加粗按钮反映并切换激活态", () => {
    const e = setup();
    e.commands.setTextSelection({ from: 1, to: 3 });
    const bold = screen.getByRole("button", { name: "加粗" });
    expect(bold).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(bold);
    expect(JSON.stringify(e.getJSON())).toContain("bold");
  });

  it("插入菜单提供分隔线/图片/附件/表格/公式/AI", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "插入" }));
    expect(screen.getByRole("menuitem", { name: "分隔线" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "附件" })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: "表格" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "AI 助手" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: "分隔线" }));
    expect(JSON.stringify(editor?.getJSON())).toContain("horizontalRule");
  });

  it("菜单支持 Escape 关闭与方向键移动焦点", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "段落样式" }));
    const first = screen.getByRole("menuitem", { name: "正文" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "标题 1" }));
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(screen.queryByRole("menuitem", { name: "正文" })).toBeNull();
  });
});

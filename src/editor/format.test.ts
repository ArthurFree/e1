import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { buildDocumentExtensions } from "./extensions";
import {
  clearInlineFormat,
  currentFontSize,
  isBlockStyleActive,
  resetBlockToParagraph,
  setBlockStyle,
  setFontSize,
} from "./format";

function createEditor(content?: unknown) {
  return new Editor({
    element: document.createElement("div"),
    extensions: buildDocumentExtensions(),
    content: content as never,
  });
}

describe("段落样式", () => {
  it("支持标题 1–6 与激活判断", () => {
    const editor = createEditor({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "正文" }] }],
    });
    editor.commands.setTextSelection(1);
    for (const level of [1, 2, 3, 4, 5, 6] as const) {
      setBlockStyle(editor, `heading${level}`);
      const node = editor.getJSON().content?.[0];
      expect(node?.type).toBe("heading");
      expect(node?.attrs?.level).toBe(level);
      expect(isBlockStyleActive(editor, `heading${level}`)).toBe(true);
    }
    setBlockStyle(editor, "paragraph");
    expect(editor.getJSON().content?.[0]?.type).toBe("paragraph");
    editor.destroy();
  });

  it("引用与代码块样式", () => {
    const editor = createEditor();
    editor.commands.setTextSelection(1);
    setBlockStyle(editor, "blockquote");
    expect(editor.isActive("blockquote")).toBe(true);
    setBlockStyle(editor, "codeBlock");
    expect(editor.isActive("codeBlock")).toBe(true);
    editor.destroy();
  });
});

describe("字号", () => {
  it("设置、读取与恢复默认", () => {
    const editor = createEditor({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "字号测试" }] }],
    });
    editor.commands.setTextSelection({ from: 1, to: 5 });

    setFontSize(editor, 20);
    expect(currentFontSize(editor)).toBe(20);
    const span = JSON.stringify(editor.getJSON());
    expect(span).toContain("20px");

    setFontSize(editor, null);
    expect(currentFontSize(editor)).toBeNull();
    expect(JSON.stringify(editor.getJSON())).not.toContain("20px");
    editor.destroy();
  });
});

describe("清理", () => {
  it("清除行内格式", () => {
    const editor = createEditor({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "加粗", marks: [{ type: "bold" }] },
          ],
        },
      ],
    });
    editor.commands.setTextSelection({ from: 1, to: 3 });
    clearInlineFormat(editor);
    expect(JSON.stringify(editor.getJSON())).not.toContain("bold");
    editor.destroy();
  });

  it("将列表块重置为正文", () => {
    const editor = createEditor({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "项" }] }] },
          ],
        },
      ],
    });
    editor.commands.setTextSelection(3);
    resetBlockToParagraph(editor);
    expect(editor.getJSON().content?.[0]?.type).toBe("paragraph");
    editor.destroy();
  });
});

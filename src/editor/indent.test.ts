import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { buildDocumentExtensions } from "./extensions";
import { MAX_INDENT } from "./indent";

function createEditor(content?: unknown) {
  return new Editor({
    element: document.createElement("div"),
    extensions: buildDocumentExtensions(),
    content: content as never,
  });
}

describe("缩进扩展", () => {
  it("段落可增加/减少缩进，0 级后不再减少", () => {
    const editor = createEditor({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "正文" }] }],
    });
    editor.commands.setTextSelection(1);

    expect(editor.commands.indent()).toBe(true);
    expect(editor.getJSON().content?.[0]?.attrs?.indent).toBe(1);
    expect(editor.commands.outdent()).toBe(true);
    expect(editor.getJSON().content?.[0]?.attrs?.indent).toBe(0);
    expect(editor.commands.outdent()).toBe(false);
    editor.destroy();
  });

  it("缩进最大 8 级", () => {
    const editor = createEditor({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "正文" }] }],
    });
    editor.commands.setTextSelection(1);
    for (let i = 0; i < MAX_INDENT + 3; i += 1) editor.commands.indent();
    expect(editor.getJSON().content?.[0]?.attrs?.indent).toBe(MAX_INDENT);
    editor.destroy();
  });

  it("标题同样支持缩进", () => {
    const editor = createEditor({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "标题" }] },
      ],
    });
    editor.commands.setTextSelection(1);
    editor.commands.indent();
    expect(editor.getJSON().content?.[0]?.attrs?.indent).toBe(1);
    editor.destroy();
  });

  it("列表内缩进走 sink/lift，而不是 indent 属性", () => {
    const editor = createEditor({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "一" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "二" }] }] },
          ],
        },
      ],
    });
    // 选中第二个列表项并降级为子项。
    editor.commands.setTextSelection(12);
    expect(editor.commands.indent()).toBe(true);
    const list = editor.getJSON().content?.[0] as
      | { content?: { type: string; content?: { type: string }[] }[] }
      | undefined;
    const firstItemChildren = list?.content?.[0]?.content ?? [];
    expect(firstItemChildren.some((n) => n.type === "bulletList")).toBe(true);

    expect(editor.commands.outdent()).toBe(true);
    const restored = editor.getJSON().content?.[0];
    expect(restored?.content?.length).toBe(2);
    editor.destroy();
  });

  it("代码块内缩进命令不生效", () => {
    const editor = createEditor({
      type: "doc",
      content: [{ type: "codeBlock", content: [{ type: "text", text: "code" }] }],
    });
    editor.commands.setTextSelection(1);
    expect(editor.commands.indent()).toBe(false);
    editor.destroy();
  });
});

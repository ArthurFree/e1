import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { buildEditorExtensions } from "./extensions";
import { EDITOR_COMMANDS } from "./commands";
import { extractToc } from "./toc";

function createEditor(content?: unknown) {
  const holder: { editor: Editor | null } = { editor: null };
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: buildEditorExtensions({
      mentionPages: [],
      getEditor: () => holder.editor as Editor,
    }),
    content: content as never,
  });
  holder.editor = editor;
  return editor;
}

describe("编辑器扩展组合", () => {
  it("可以创建并输出 JSON 与纯文本快照", () => {
    const editor = createEditor({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "你好" }] }],
    });
    expect(editor.getText()).toContain("你好");
    expect(editor.getJSON().type).toBe("doc");
    editor.destroy();
  });

  it("/ 命令把段落转换为标题", () => {
    const editor = createEditor();
    editor.commands.insertContent("正文");
    const heading1 = EDITOR_COMMANDS.find((c) => c.id === "heading1");
    heading1?.run(editor);
    expect(editor.getJSON().content?.[0]?.type).toBe("heading");
    editor.destroy();
  });

  it("支持待办列表与代码块", () => {
    const editor = createEditor();
    editor.commands.toggleTaskList();
    editor.commands.insertContent("待办事项");
    const json = editor.getJSON();
    expect(json.content?.[0]?.type).toBe("taskList");
    editor.commands.setContent("<p>x</p>");
    editor.commands.toggleCodeBlock();
    expect(editor.getJSON().content?.[0]?.type).toBe("codeBlock");
    editor.destroy();
  });

  it("支持插入表格", () => {
    const editor = createEditor();
    editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true });
    expect(editor.getJSON().content?.some((n) => n.type === "table")).toBe(true);
    editor.destroy();
  });

  it("支持插入公式块", () => {
    const editor = createEditor();
    editor.commands.insertBlockMath({ latex: "E=mc^2" });
    const mathNode = editor.getJSON().content?.find((n) => n.type === "blockMath");
    expect(mathNode?.attrs?.latex).toBe("E=mc^2");
    editor.destroy();
  });

  it("目录从标题自动提取", () => {
    const editor = createEditor({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "第一章" }] },
        { type: "paragraph", content: [{ type: "text", text: "正文" }] },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "小节" }] },
      ],
    });
    const toc = extractToc(editor);
    expect(toc.map((t) => t.text)).toEqual(["第一章", "小节"]);
    expect(toc[1].level).toBe(2);
    editor.destroy();
  });

  it("撤销重做恢复变更", () => {
    const editor = createEditor();
    editor.commands.insertContent("第一步");
    editor.commands.undo();
    expect(editor.getText()).not.toContain("第一步");
    editor.commands.redo();
    expect(editor.getText()).toContain("第一步");
    editor.destroy();
  });
});

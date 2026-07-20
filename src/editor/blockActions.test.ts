import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { buildEditorExtensions } from "./extensions";
import {
  clearBlockFormatting,
  convertBlock,
  deleteBlock,
  duplicateBlock,
  getTopLevelBlock,
  moveBlock,
} from "./blockActions";

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

function docWithTwoBlocks() {
  return createEditor({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "第一块" }] },
      { type: "paragraph", content: [{ type: "text", text: "第二块" }] },
    ],
  });
}

describe("块操作", () => {
  it("getTopLevelBlock 定位顶层块", () => {
    const editor = docWithTwoBlocks();
    const block = getTopLevelBlock(editor, 2);
    expect(block?.node.textContent).toBe("第一块");
    editor.destroy();
  });

  it("moveBlock 把块移到文档末尾", () => {
    const editor = docWithTwoBlocks();
    const first = getTopLevelBlock(editor, 2);
    expect(first).not.toBeNull();
    moveBlock(editor, first!.pos, editor.state.doc.content.size);
    const texts = editor
      .getJSON()
      .content?.map((n) => (n.content?.[0] as { text?: string } | undefined)?.text);
    expect(texts).toEqual(["第二块", "第一块"]);
    editor.destroy();
  });

  it("duplicateBlock 在原块后插入副本", () => {
    const editor = docWithTwoBlocks();
    const first = getTopLevelBlock(editor, 2)!;
    duplicateBlock(editor, first.pos);
    const texts = editor
      .getJSON()
      .content?.map((n) => (n.content?.[0] as { text?: string } | undefined)?.text);
    expect(texts).toEqual(["第一块", "第一块", "第二块"]);
    editor.destroy();
  });

  it("deleteBlock 删除块", () => {
    const editor = docWithTwoBlocks();
    const first = getTopLevelBlock(editor, 2)!;
    deleteBlock(editor, first.pos);
    expect(editor.getText()).not.toContain("第一块");
    expect(editor.getText()).toContain("第二块");
    editor.destroy();
  });

  it("convertBlock 把段落转成标题与列表", () => {
    const editor = docWithTwoBlocks();
    const first = getTopLevelBlock(editor, 2)!;
    convertBlock(editor, first.pos, "heading2");
    expect(editor.getJSON().content?.[0]?.type).toBe("heading");
    expect(editor.getJSON().content?.[0]?.attrs?.level).toBe(2);

    const heading = getTopLevelBlock(editor, 2)!;
    convertBlock(editor, heading.pos, "bulletList");
    expect(editor.getJSON().content?.[0]?.type).toBe("bulletList");
    editor.destroy();
  });

  it("clearBlockFormatting 去掉加粗并还原段落", () => {
    const editor = createEditor({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [
            { type: "text", marks: [{ type: "bold" }], text: "加粗标题" },
          ],
        },
      ],
    });
    clearBlockFormatting(editor, 0);
    const node = editor.getJSON().content?.[0];
    expect(node?.type).toBe("paragraph");
    expect(node?.content?.[0]?.marks).toBeUndefined();
    editor.destroy();
  });
});

import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { buildEditorExtensions } from "./extensions";
import {
  currentColumnIndex,
  moveColumn,
  moveRow,
  sortByColumn,
} from "./tableUtils";

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

function cell(text: string, header = false) {
  return {
    type: header ? "tableHeader" : "tableCell",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function row(cells: ReturnType<typeof cell>[]) {
  return { type: "tableRow", content: cells };
}

function createTableEditor() {
  return createEditor({
    type: "doc",
    content: [
      {
        type: "table",
        content: [
          row([cell("名称", true), cell("数量", true)]),
          row([cell("香蕉"), cell("3")]),
          row([cell("苹果"), cell("5")]),
        ],
      },
    ],
  });
}

function tableTexts(editor: Editor): string[][] {
  const rows: string[][] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "table") {
      node.forEach((r) => {
        const cells: string[] = [];
        r.forEach((c) => cells.push(c.textContent));
        rows.push(cells);
      });
      return false;
    }
    return true;
  });
  return rows;
}

/** 找文档中第一个表格（不依赖选区）。 */
function firstTable(editor: Editor): { pos: number; node: import("@tiptap/pm/model").Node } | null {
  let found: { pos: number; node: import("@tiptap/pm/model").Node } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === "table") {
      found = { pos, node };
      return false;
    }
    return true;
  });
  return found;
}

/** 把光标放进指定行的指定列。 */
function focusCell(editor: Editor, rowIdx: number, colIdx: number) {
  const table = firstTable(editor)!;
  let target: number | undefined;
  let rIndex = -1;
  table.node.forEach((r, rPos) => {
    rIndex += 1;
    if (rIndex !== rowIdx) return;
    let cIndex = -1;
    r.forEach((_c, cPos) => {
      cIndex += 1;
      if (cIndex === colIdx) target = table.pos + rPos + cPos + 3;
    });
  });
  expect(target).toBeDefined();
  editor.commands.setTextSelection((target as number) + 1);
}

describe("表格工具", () => {
  it("定位当前列", () => {
    const editor = createTableEditor();
    focusCell(editor, 1, 1);
    expect(currentColumnIndex(editor)).toBe(1);
    editor.destroy();
  });

  it("moveColumn 交换列顺序", () => {
    const editor = createTableEditor();
    focusCell(editor, 1, 0);
    moveColumn(editor, 0, 1);
    expect(tableTexts(editor)).toEqual([
      ["数量", "名称"],
      ["3", "香蕉"],
      ["5", "苹果"],
    ]);
    editor.destroy();
  });

  it("moveRow 交换行顺序", () => {
    const editor = createTableEditor();
    focusCell(editor, 1, 0);
    moveRow(editor, 1, 2);
    expect(tableTexts(editor)).toEqual([
      ["名称", "数量"],
      ["苹果", "5"],
      ["香蕉", "3"],
    ]);
    editor.destroy();
  });

  it("sortByColumn 保留表头并按列排序", () => {
    const editor = createTableEditor();
    focusCell(editor, 1, 0);
    sortByColumn(editor, 0, "asc");
    expect(tableTexts(editor)).toEqual([
      ["名称", "数量"],
      ["苹果", "5"],
      ["香蕉", "3"],
    ]);
    focusCell(editor, 1, 0);
    sortByColumn(editor, 0, "desc");
    expect(tableTexts(editor)).toEqual([
      ["名称", "数量"],
      ["香蕉", "3"],
      ["苹果", "5"],
    ]);
    editor.destroy();
  });
});

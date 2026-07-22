/**
 * 表格行列操作工具（TableToolbar 的能力实现）。
 * 定位当前选区所在表格，支持移动行/列与按列排序；
 * 通过整体重建表格节点（replaceWith）提交变更，保证 transaction 原子性。
 * 已知简化：按行内直接子单元格下标操作，含跨列合并单元格的表格下标可能与可视列不一致。
 */
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";

interface TableLocation {
  pos: number;
  node: PMNode;
}

/** 当前选区所在的表格。 */
export function findTable(editor: Editor): TableLocation | null {
  const { $from } = editor.state.selection;
  // 自内向外逐层向上找 table 节点；pos 取表格起始位置（before）。
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === "table") {
      return { pos: $from.before(depth), node };
    }
  }
  return null;
}

/** 当前单元格在其行内的列下标；不在表格中返回 null。 */
export function currentColumnIndex(editor: Editor): number | null {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const name = $from.node(depth).type.name;
    if (name === "tableCell" || name === "tableHeader") {
      return $from.index(depth - 1);
    }
  }
  return null;
}

/** 当前行在表格中的行下标。 */
export function currentRowIndex(editor: Editor): number | null {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name === "tableRow") {
      return $from.index(depth - 1);
    }
  }
  return null;
}

function replaceTable(editor: Editor, loc: TableLocation, rows: PMNode[]) {
  const newTable = loc.node.type.create(loc.node.attrs, rows);
  editor.view.dispatch(
    editor.state.tr.replaceWith(loc.pos, loc.pos + loc.node.nodeSize, newTable),
  );
}

function tableRows(table: PMNode): PMNode[] {
  const rows: PMNode[] = [];
  table.forEach((row) => rows.push(row));
  return rows;
}

function rowCells(row: PMNode): PMNode[] {
  const cells: PMNode[] = [];
  row.forEach((cell) => cells.push(cell));
  return cells;
}

/**
 * 移动列。按行的直接子单元格下标操作；
 * 含跨列合并单元格的表格下标可能不对应可视列，属已知简化。
 */
export function moveColumn(editor: Editor, from: number, to: number): boolean {
  const loc = findTable(editor);
  if (!loc) return false;
  const rows = tableRows(loc.node);
  if (from === to || from < 0 || to < 0 || from >= rowCells(rows[0]).length || to >= rowCells(rows[0]).length) {
    return false;
  }
  const newRows = rows.map((row) => {
    const cells = rowCells(row);
    if (from >= cells.length || to >= cells.length) return row;
    const next = [...cells];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return row.type.create(row.attrs, next);
  });
  replaceTable(editor, loc, newRows);
  return true;
}

/** 移动行。 */
export function moveRow(editor: Editor, from: number, to: number): boolean {
  const loc = findTable(editor);
  if (!loc) return false;
  const rows = tableRows(loc.node);
  if (from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) {
    return false;
  }
  const next = [...rows];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  replaceTable(editor, loc, next);
  return true;
}

/** 按列排序：首行若为表头行则固定不参与排序。 */
export function sortByColumn(
  editor: Editor,
  column: number,
  direction: "asc" | "desc",
): boolean {
  const loc = findTable(editor);
  if (!loc) return false;
  const rows = tableRows(loc.node);
  if (rows.length < 2) return false;

  const firstIsHeader = rowCells(rows[0]).every((c) => c.type.name === "tableHeader");
  const header = firstIsHeader ? [rows[0]] : [];
  const body = firstIsHeader ? rows.slice(1) : rows;

  const cellText = (row: PMNode) =>
    (rowCells(row)[column]?.textContent ?? "").trim();

  const sorted = [...body].sort((a, b) => {
    // zh-Hans-CN + numeric：中文按拼音、数字串按数值比较，符合中文用户直觉。
    const cmp = cellText(a).localeCompare(cellText(b), "zh-Hans-CN", { numeric: true });
    return direction === "asc" ? cmp : -cmp;
  });
  replaceTable(editor, loc, [...header, ...sorted]);
  return true;
}

/**
 * 表格操作浮动条：选区进入表格时出现（BubbleMenu shouldShow = isActive("table")）。
 * 提供插/删行列、表头切换、合并/拆分、行列移动与按列排序。
 * 增删与表头操作直接用 Tiptap Table 扩展命令；移动与排序依赖
 * editor/tableUtils 的行列索引定位，选区不在单元格内（索引为 null）时禁用。
 */
import { BubbleMenu } from "@tiptap/react/menus";
import type { Editor } from "@tiptap/core";
import {
  currentColumnIndex,
  currentRowIndex,
  moveColumn,
  moveRow,
  sortByColumn,
} from "../../editor/tableUtils";

/** TableToolbar 入参。 */
interface TableToolbarProps {
  editor: Editor;
}

/** 单个表格操作项；disabled 用于行列索引不可用时（选区不在单元格内）。 */
interface TableAction {
  id: string;
  label: string;
  run(): void;
  disabled?: boolean;
}

/** 表格操作条：选区在表格内时出现。 */
export function TableToolbar({ editor }: TableToolbarProps) {
  const col = currentColumnIndex(editor);
  const row = currentRowIndex(editor);

  const groups: TableAction[][] = [
    [
      { id: "addRowBefore", label: "上方插行", run: () => editor.chain().focus().addRowBefore().run() },
      { id: "addRowAfter", label: "下方插行", run: () => editor.chain().focus().addRowAfter().run() },
      { id: "addColBefore", label: "左侧插列", run: () => editor.chain().focus().addColumnBefore().run() },
      { id: "addColAfter", label: "右侧插列", run: () => editor.chain().focus().addColumnAfter().run() },
    ],
    [
      { id: "deleteRow", label: "删除行", run: () => editor.chain().focus().deleteRow().run() },
      { id: "deleteCol", label: "删除列", run: () => editor.chain().focus().deleteColumn().run() },
      { id: "deleteTable", label: "删除表格", run: () => editor.chain().focus().deleteTable().run() },
    ],
    [
      { id: "toggleHeaderRow", label: "表头行", run: () => editor.chain().focus().toggleHeaderRow().run() },
      { id: "toggleHeaderCol", label: "表头列", run: () => editor.chain().focus().toggleHeaderColumn().run() },
      { id: "mergeCells", label: "合并", run: () => editor.chain().focus().mergeCells().run() },
      { id: "splitCell", label: "拆分", run: () => editor.chain().focus().splitCell().run() },
    ],
    [
      { id: "rowUp", label: "行上移", disabled: row === null || row <= 0, run: () => { if (row !== null && row > 0) moveRow(editor, row, row - 1); } },
      { id: "rowDown", label: "行下移", disabled: row === null, run: () => { if (row !== null) moveRow(editor, row, row + 1); } },
      { id: "colLeft", label: "列左移", disabled: col === null || col <= 0, run: () => { if (col !== null && col > 0) moveColumn(editor, col, col - 1); } },
      { id: "colRight", label: "列右移", disabled: col === null, run: () => { if (col !== null) moveColumn(editor, col, col + 1); } },
      { id: "sortAsc", label: "升序", disabled: col === null, run: () => { if (col !== null) sortByColumn(editor, col, "asc"); } },
      { id: "sortDesc", label: "降序", disabled: col === null, run: () => { if (col !== null) sortByColumn(editor, col, "desc"); } },
    ],
  ];

  return (
    <BubbleMenu
      editor={editor}
      options={{ placement: "top", offset: 8 }}
      shouldShow={({ editor: e }) => e.isActive("table")}
    >
      <div className="table-toolbar" role="toolbar" aria-label="表格操作">
        {groups.map((group, gi) => (
          <div key={gi} className="table-toolbar__group">
            {group.map((action) => (
              <button
                key={action.id}
                type="button"
                className="table-toolbar__button"
                aria-label={action.label}
                disabled={action.disabled}
                onClick={action.run}
              >
                {action.label}
              </button>
            ))}
          </div>
        ))}
      </div>
    </BubbleMenu>
  );
}

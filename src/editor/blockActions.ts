import { TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/core";

/** 顶层块信息：pos 为块起始位置，node 为块节点。兼容传入块起点的情况。 */
export function getTopLevelBlock(editor: Editor, pos: number) {
  const size = editor.state.doc.content.size;
  let $pos = editor.state.doc.resolve(Math.min(pos, size));
  if ($pos.depth < 1 && pos < size) {
    $pos = editor.state.doc.resolve(pos + 1);
  }
  if ($pos.depth < 1) return null;
  const depth = 1;
  const start = $pos.before(depth);
  const node = $pos.node(depth);
  return { pos: start, node, end: start + node.nodeSize };
}

/** 把 fromPos 处的顶层块移动到 insertPos（文档位置，移动前坐标系）。 */
export function moveBlock(editor: Editor, fromPos: number, insertPos: number) {
  const node = editor.state.doc.nodeAt(fromPos);
  if (!node) return false;
  if (insertPos >= fromPos && insertPos <= fromPos + node.nodeSize) return false;
  const { tr } = editor.state;
  let target = insertPos;
  tr.delete(fromPos, fromPos + node.nodeSize);
  if (target > fromPos) target -= node.nodeSize;
  tr.insert(target, node);
  editor.view.dispatch(tr);
  return true;
}

/** 复制块：在原块后插入相同副本。 */
export function duplicateBlock(editor: Editor, pos: number) {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return false;
  const insertPos = pos + node.nodeSize;
  editor.view.dispatch(editor.state.tr.insert(insertPos, node));
  return true;
}

/** 删除块。 */
export function deleteBlock(editor: Editor, pos: number) {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return false;
  editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize));
  return true;
}

export type ConvertTarget =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "blockquote"
  | "codeBlock"
  | "bulletList"
  | "orderedList"
  | "taskList";

function selectBlock(editor: Editor, pos: number) {
  const $pos = editor.state.doc.resolve(pos + 1);
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.near($pos)),
  );
  editor.view.focus();
}

/** 块类型转换：复用统一命令的语义，作用于 pos 处的块。 */
export function convertBlock(editor: Editor, pos: number, target: ConvertTarget) {
  selectBlock(editor, pos);
  const chain = editor.chain().focus();
  switch (target) {
    case "paragraph":
      return chain.setParagraph().run();
    case "heading1":
      return chain.setNode("heading", { level: 1 }).run();
    case "heading2":
      return chain.setNode("heading", { level: 2 }).run();
    case "heading3":
      return chain.setNode("heading", { level: 3 }).run();
    case "blockquote":
      return chain.setParagraph().toggleBlockquote().run();
    case "codeBlock":
      return chain.setNode("codeBlock").run();
    case "bulletList":
      return chain.toggleBulletList().run();
    case "orderedList":
      return chain.toggleOrderedList().run();
    case "taskList":
      return chain.toggleTaskList().run();
  }
}

/** 清除格式：去掉行内标记并把块还原为普通段落。 */
export function clearBlockFormatting(editor: Editor, pos: number) {
  const block = getTopLevelBlock(editor, pos);
  if (!block) return false;
  const { tr } = editor.state;
  tr.setSelection(
    TextSelection.create(editor.state.doc, block.pos + 1, Math.max(block.pos + 1, block.end - 1)),
  );
  editor.view.dispatch(tr);
  return editor.chain().focus().unsetAllMarks().clearNodes().run();
}

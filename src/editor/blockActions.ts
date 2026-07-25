/**
 * 顶层块操作工具（块菜单/块手柄的能力实现）。
 * 提供块的定位、移动、复制、删除、类型转换与清除格式，
 * 全部直接构造 ProseMirror transaction，不经过 React 状态。
 */
import { TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/core";

/**
 * 顶层块信息：pos 为块起始位置，node 为块节点。兼容传入块起点的情况。
 * @returns 文档为空等无法定位到顶层块时返回 null。
 */
export function getTopLevelBlock(editor: Editor, pos: number) {
  const size = editor.state.doc.content.size;
  let $pos = editor.state.doc.resolve(Math.min(pos, size));
  // 传入块起点时 resolve 落在 depth 0，向后移一位进入块内部再解析。
  if ($pos.depth < 1 && pos < size) {
    $pos = editor.state.doc.resolve(pos + 1);
  }
  if ($pos.depth < 1) return null;
  const depth = 1;
  const start = $pos.before(depth);
  const node = $pos.node(depth);
  return { pos: start, node, end: start + node.nodeSize };
}

/** 把指针坐标夹进正文矩形，使左侧把手列也能用 posAtCoords 命中块。 */
function mapIntoContent(
  viewDom: HTMLElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = viewDom.getBoundingClientRect();
  return {
    x: Math.min(Math.max(clientX, rect.left + 1), Math.max(rect.left + 1, rect.right - 1)),
    y: Math.min(Math.max(clientY, rect.top + 1), Math.max(rect.top + 1, rect.bottom - 1)),
  };
}

/**
 * 按垂直坐标查找最近的顶层块（含块间空隙：落到距哪块更近）。
 * 用于指针在左侧把手列、posAtCoords 可能落空时的拖放命中。
 */
function findTopLevelBlockAtY(editor: Editor, clientY: number) {
  let best: { pos: number; end: number; rect: DOMRect; dist: number } | null = null;
  editor.state.doc.forEach((node, offset) => {
    const dom = editor.view.nodeDOM(offset);
    if (!(dom instanceof HTMLElement)) return;
    const rect = dom.getBoundingClientRect();
    let dist = 0;
    if (clientY < rect.top) dist = rect.top - clientY;
    else if (clientY > rect.bottom) dist = clientY - rect.bottom;
    if (!best || dist < best.dist) {
      best = { pos: offset, end: offset + node.nodeSize, rect, dist };
    }
  });
  return best;
}

/**
 * 解析块拖放的插入位置：上半区插到目标块前，下半区插到目标块后。
 * 指针可在正文外（左侧把手列），内部会把坐标映射进内容区再命中。
 * @returns insertPos 为移动前坐标系的文档位置；lineClientY 供放置指示线；无法命中时 null。
 */
export function resolveBlockDropTarget(
  editor: Editor,
  clientX: number,
  clientY: number,
): { insertPos: number; lineClientY: number } | null {
  const viewDom = editor.view.dom as HTMLElement;
  const { x, y } = mapIntoContent(viewDom, clientX, clientY);

  let target: { pos: number; end: number; rect: DOMRect } | null = null;
  const coords = editor.view.posAtCoords({ left: x, top: y });
  if (coords) {
    const block = getTopLevelBlock(editor, coords.pos);
    if (block) {
      const dom = editor.view.nodeDOM(block.pos);
      if (dom instanceof HTMLElement) {
        target = { pos: block.pos, end: block.end, rect: dom.getBoundingClientRect() };
      }
    }
  }
  if (!target) {
    const byY = findTopLevelBlockAtY(editor, clientY);
    if (!byY) return null;
    target = byY;
  }

  // 用原始 clientY（未竖直夹紧）判断上/下半，便于在块间空隙时落到正确一侧。
  const insertBefore = clientY < target.rect.top + target.rect.height / 2;
  return {
    insertPos: insertBefore ? target.pos : target.end,
    lineClientY: insertBefore ? target.rect.top : target.rect.bottom,
  };
}

/** 把 fromPos 处的顶层块移动到 insertPos（文档位置，移动前坐标系）。 */
export function moveBlock(editor: Editor, fromPos: number, insertPos: number) {
  const node = editor.state.doc.nodeAt(fromPos);
  if (!node) return false;
  // 目标落在块自身区间内视为无效移动（原地不动）。
  if (insertPos >= fromPos && insertPos <= fromPos + node.nodeSize) return false;
  const { tr } = editor.state;
  let target = insertPos;
  tr.delete(fromPos, fromPos + node.nodeSize);
  // 删除使后续位置前移：目标在原块之后时要扣除被删长度。
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

/** 块菜单「转换为」支持的目标类型。 */
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

/** 把选区移到指定块内并聚焦，让后续的 chain 命令作用于该块。 */
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

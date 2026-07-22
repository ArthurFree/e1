/**
 * 目录（TOC）提取与定位（编辑器内核的只读查询工具）。
 * Tiptap 官方的 TableOfContents 为 Pro 扩展；按「只用开源扩展」的约束，
 * 这里直接遍历文档 JSON 收集标题节点，供 TocPanel 渲染，
 * 点击条目时按文档位置（pos）滚动到对应 DOM。
 */
import type { Editor } from "@tiptap/core";

/** 目录条目：一个标题节点的层级、纯文本与文档位置。 */
export interface TocItem {
  /** 标题级别（1–6），对应 heading 节点的 level 属性。 */
  level: number;
  /** 标题纯文本（可能为空串，空标题原样展示）。 */
  text: string;
  /** 标题节点在文档中的起始位置，作为滚动定位锚点。 */
  pos: number;
}

/**
 * 目录：TableOfContents 是 Tiptap Pro 能力，这里直接遍历文档 JSON
 * 收集标题，点击时按 pos 定位滚动（开源等价实现）。
 * @returns 按文档顺序排列的目录条目；无标题时为空数组。
 */
export function extractToc(editor: Editor): TocItem[] {
  const items: TocItem[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "heading") {
      items.push({
        level: node.attrs.level as number,
        text: node.textContent,
        pos,
      });
    }
    return true;
  });
  return items;
}

/** 滚动到 pos 处的标题 DOM 节点。 */
export function scrollToPos(editor: Editor, pos: number) {
  const dom = editor.view.nodeDOM(pos);
  if (dom instanceof HTMLElement) {
    dom.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  // 兜底：渲染时序等原因拿不到 DOM 时，退化为把选区移到标题处。
  editor.chain().focus().setTextSelection(pos).run();
}

import type { Editor } from "@tiptap/core";

export interface TocItem {
  level: number;
  text: string;
  pos: number;
}

/**
 * 目录：TableOfContents 是 Tiptap Pro 能力，这里直接遍历文档 JSON
 * 收集标题，点击时按 pos 定位滚动（开源等价实现）。
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
  editor.chain().focus().setTextSelection(pos).run();
}

/**
 * 文档目录面板：由 editor/toc.extractToc 从当前文档提取标题生成目录，
 * 随编辑器 update 事件自动刷新；点击条目经 scrollToPos 滚动到对应标题。
 * 无标题时显示引导文案；空文本标题显示占位「无标题」。
 */
import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/core";
import { extractToc, scrollToPos, type TocItem } from "../../editor/toc";

/** TocPanel 入参。 */
interface TocPanelProps {
  editor: Editor;
}

/** 目录面板：依据文档标题自动生成，点击跳转。 */
export function TocPanel({ editor }: TocPanelProps) {
  const [items, setItems] = useState<TocItem[]>(() => extractToc(editor));

  useEffect(() => {
    const refresh = () => setItems(extractToc(editor));
    editor.on("update", refresh);
    return () => {
      editor.off("update", refresh);
    };
  }, [editor]);

  return (
    <nav className="toc" aria-label="目录">
      <div className="toc__header">目录</div>
      {items.length === 0 ? (
        <div className="toc__empty">添加标题后自动生成目录。</div>
      ) : (
        items.map((item) => (
          <button
            // 以文档位置作 key：标题文本可重复，位置唯一。
            key={item.pos}
            type="button"
            className="toc__item"
            style={{ paddingLeft: 8 + (item.level - 1) * 14 }}
            onClick={() => scrollToPos(editor, item.pos)}
          >
            {item.text || "无标题"}
          </button>
        ))
      )}
    </nav>
  );
}

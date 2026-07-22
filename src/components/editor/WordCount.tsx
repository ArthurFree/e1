import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/core";
import { countWords, formatWordCount } from "../../domain/wordCount";

interface WordCountProps {
  editor: Editor;
}

/** 统计编辑器当前文档的字符数、词数和段落数。 */
function computeStats(editor: Editor) {
  const { characters, words } = countWords(editor.getText());
  let paragraphs = 0;
  editor.state.doc.descendants((node) => {
    if (node.isTextblock && node.textContent.trim() !== "") paragraphs += 1;
    return true;
  });
  return { characters, words, paragraphs };
}

/**
 * 字数统计（R001 §8.2）：顶栏显示紧凑词数，点击展开详情。
 * 数据来自当前编辑器文档（随事务节流更新），不依赖已保存快照。
 */
export function WordCount({ editor }: WordCountProps) {
  const [stats, setStats] = useState(() => computeStats(editor));
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setStats(computeStats(editor));
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      // 大文档节流：事务密集时 300ms 合并一次统计。
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        setStats(computeStats(editor));
      }, 300);
    };
    editor.on("transaction", refresh);
    return () => {
      editor.off("transaction", refresh);
      if (timer !== null) clearTimeout(timer);
    };
  }, [editor]);

  return (
    <span className="word-count">
      <button
        type="button"
        className="word-count__toggle"
        aria-label="字数统计详情"
        aria-expanded={open}
        title="字数统计"
        onClick={() => setOpen((v) => !v)}
      >
        {formatWordCount(stats.words)}
      </button>
      {open && (
        <span className="word-count__detail" role="status">
          <span>字符数 {stats.characters.toLocaleString("zh-CN")}</span>
          <span>词数 {stats.words.toLocaleString("zh-CN")}</span>
          <span>段落数 {stats.paragraphs.toLocaleString("zh-CN")}</span>
        </span>
      )}
    </span>
  );
}

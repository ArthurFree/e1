/**
 * Emoji 选择器：向光标处插入常用 Emoji。
 * 使用本地静态表情表，不请求网络（本地优先原则）；
 * 面板经外部点击或 Escape 关闭。
 */
import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { IconSmile } from "../ui/icons";

/** 常用 Emoji 静态表（32 个，覆盖表情/手势/符号/文档类）；本地数据，不发请求。 */
const EMOJIS = [
  "😀", "😄", "😂", "🤣", "😊", "😍", "🤔", "😴",
  "👍", "👎", "👏", "🙏", "💪", "🎉", "✨", "🔥",
  "❤️", "💡", "⭐", "⚠️", "✅", "❌", "📌", "📎",
  "📝", "📚", "🗂️", "🚀", "🐛", "🔧", "💬", "🕐",
];

interface EmojiPickerProps {
  editor: Editor;
}

/** Emoji 选择器：本地静态表，不请求网络。 */
export function EmojiPicker({ editor }: EmojiPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="emoji-picker" ref={rootRef}>
      <button
        type="button"
        className="icon-button"
        aria-label="插入表情"
        aria-expanded={open}
        title="插入表情"
        onClick={() => setOpen((v) => !v)}
      >
        <IconSmile />
      </button>
      {open && (
        <div className="emoji-picker__panel" role="menu" aria-label="表情列表">
          {EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              role="menuitem"
              className="emoji-picker__item"
              aria-label={`插入表情 ${emoji}`}
              onClick={() => {
                editor.chain().focus().insertContent(emoji).run();
                setOpen(false);
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

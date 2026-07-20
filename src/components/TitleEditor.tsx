import { useEffect, useState } from "react";
import { useDebouncedCallback } from "../hooks/useDebouncedCallback";

interface TitleEditorProps {
  pageId: string;
  title: string;
  onSave(pageId: string, title: string): void;
}

/** 文档标题：本地即时更新，500ms 防抖保存，卸载/切换前强制落盘。 */
export function TitleEditor({ pageId, title, onSave }: TitleEditorProps) {
  const [value, setValue] = useState(title);
  const { debounced, flush } = useDebouncedCallback(
    (id: string, next: string) => onSave(id, next),
    500,
  );

  // 切换到其他文档时：先落盘当前编辑，再载入新标题。
  useEffect(() => {
    flush();
    setValue(title);
  }, [pageId]); // 仅在切换文档时落盘并载入新标题

  useEffect(() => {
    setValue(title);
  }, [title]);

  return (
    <input
      className="doc-title"
      value={value}
      placeholder="无标题"
      aria-label="文档标题"
      onChange={(event) => {
        setValue(event.target.value);
        debounced(pageId, event.target.value);
      }}
      onBlur={flush}
    />
  );
}

/**
 * @file 文档标题输入框：文档编辑区顶部的 32px 标题（R002）。
 * 输入即时更新本地状态，经 500ms 防抖写回仓储；切换文档或失焦时强制落盘，
 * 与正文的防抖保存策略一致（卸载时由 useDebouncedCallback 兜底 flush）。
 */

import { useEffect, useState } from "react";
import { useDebouncedCallback } from "../hooks/useDebouncedCallback";

interface TitleEditorProps {
  /** 所属文档 ID，防抖保存时回传给 onSave。 */
  pageId: string;
  /** 外部持久化的标题；变化时同步进本地编辑态。 */
  title: string;
  /** 新建文档后聚焦标题输入框（消费后经 onFocused 清除标记）。 */
  autoFocus?: boolean;
  /** autoFocus 生效并完成聚焦后的回调，用于清除一次性聚焦标记。 */
  onFocused?(): void;
  /** 标题落盘回调；(pageId, 新标题) 通常接到 AppState.renamePage。 */
  onSave(pageId: string, title: string): void;
  /** Enter/ArrowDown 离开标题进入正文（通常聚焦编辑器首行）。 */
  onExitToBody?(): void;
}

/** 文档标题：本地即时更新，500ms 防抖保存，卸载/切换前强制落盘。 */
export function TitleEditor({
  pageId,
  title,
  autoFocus,
  onFocused,
  onSave,
  onExitToBody,
}: TitleEditorProps) {
  const [value, setValue] = useState(title);
  const { debounced, flush } = useDebouncedCallback(
    (id: string, next: string) => onSave(id, next),
    500,
  );

  // 切换到其他文档时先落盘挂起的编辑；flush 引用稳定（useCallback 无依赖），
  // 仅在 pageId 变化时执行。
  useEffect(() => {
    flush();
  }, [pageId, flush]);

  // 外部标题变化时同步进本地编辑态；pageId 一并作为依赖，覆盖两篇文档
  // 标题恰好相同、仅 pageId 变化的切换场景（此时 title 不变也须重置本地态）。
  useEffect(() => {
    setValue(title);
  }, [pageId, title]);

  return (
    <input
      className="doc-title"
      value={value}
      placeholder="无标题"
      aria-label="文档标题"
      autoFocus={autoFocus}
      onFocus={() => {
        if (autoFocus) onFocused?.();
      }}
      onChange={(event) => {
        setValue(event.target.value);
        debounced(pageId, event.target.value);
      }}
      onKeyDown={(event) => {
        // Notion/语雀惯例：标题内 Enter 或 ArrowDown 进入正文首行。
        if (event.key === "Enter" || event.key === "ArrowDown") {
          event.preventDefault();
          flush();
          onExitToBody?.();
        }
      }}
      onBlur={flush}
    />
  );
}

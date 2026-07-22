/**
 * @file 全局搜索面板：当前知识库内按标题与正文全文检索。
 * 输入经 300ms 防抖后查询；结果列表复用编辑器的 CommandList 以获得
 * 统一的键盘导航（↑↓ 移动、Enter 跳转），方向键事件从输入框转发给列表。
 * 匹配与高亮逻辑在 domain/search.ts。
 */

import { useRef, useState } from "react";
import type { SuggestionKeyDownProps } from "@tiptap/suggestion";
import type { SearchResult } from "../domain/types";
import { useApp } from "../state/AppState";
import { useDebouncedCallback } from "../hooks/useDebouncedCallback";
import { Dialog } from "./ui/Dialog";
import { PageIcon } from "./ui/icons";
import {
  CommandList,
  type CommandListItem,
  type CommandListRef,
} from "./editor/CommandList";

interface SearchPanelProps {
  /** 关闭面板（选中结果跳转、Escape、点击遮罩时触发）。 */
  onClose(): void;
}

/** 全局搜索面板：按标题与正文匹配当前知识库，Enter 跳转。 */
export function SearchPanel({ onClose }: SearchPanelProps) {
  const { pages, search, selectPage } = useApp();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const listRef = useRef<CommandListRef>(null);

  const { debounced: debouncedSearch } = useDebouncedCallback((value: string) => {
    void search(value).then(setResults);
  }, 300);

  const onQueryChange = (value: string) => {
    setQuery(value);
    // 清空输入时立即清结果并跳过防抖查询，避免旧结果闪回
    if (!value.trim()) {
      setResults([]);
      return;
    }
    debouncedSearch(value);
  };

  const items: CommandListItem[] = results.map((result) => {
    const page = pages.find((p) => p.id === result.pageId);
    return {
      id: result.pageId,
      title: result.title,
      subtitle: result.snippet || undefined,
      icon: page?.icon ?? <PageIcon kind={page?.kind === "group" ? "group" : "document"} size={14} />,
    };
  });

  const jump = (item: CommandListItem) => {
    selectPage(item.id);
    onClose();
  };

  return (
    <Dialog label="全局搜索" className="search-panel" onClose={onClose}>
      <input
        className="search-panel__input"
        aria-label="搜索文档"
        placeholder="搜索标题与正文…"
        value={query}
        autoFocus
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          // 方向键/回车在输入框上截获并转交给 CommandList 的键盘导航
          if (["ArrowUp", "ArrowDown", "Enter"].includes(event.key)) {
            event.preventDefault();
            listRef.current?.onKeyDown({
              event: event.nativeEvent,
            } as unknown as SuggestionKeyDownProps);
          }
        }}
      />
      {query.trim() ? (
        <CommandList ref={listRef} items={items} command={jump} />
      ) : (
        <div className="search-panel__hint">输入关键词，按标题与正文查找文档。</div>
      )}
    </Dialog>
  );
}

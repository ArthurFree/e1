import { useEffect, useRef, useState } from "react";
import type { SuggestionKeyDownProps } from "@tiptap/suggestion";
import type { SearchResult } from "../domain/types";
import { useApp } from "../state/AppState";
import { useDebouncedCallback } from "../hooks/useDebouncedCallback";
import {
  CommandList,
  type CommandListItem,
  type CommandListRef,
} from "./editor/CommandList";

interface SearchPanelProps {
  onClose(): void;
}

/** 全局搜索面板：按标题与正文匹配当前知识库，Enter 跳转。 */
export function SearchPanel({ onClose }: SearchPanelProps) {
  const { pages, search, selectPage } = useApp();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const listRef = useRef<CommandListRef>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const { debounced: debouncedSearch } = useDebouncedCallback((value: string) => {
    void search(value).then(setResults);
  }, 300);

  const onQueryChange = (value: string) => {
    setQuery(value);
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
      icon: page?.icon ?? (page?.kind === "folder" ? "📁" : "📄"),
    };
  });

  const jump = (item: CommandListItem) => {
    selectPage(item.id);
    onClose();
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog search-panel"
        role="dialog"
        aria-label="全局搜索"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          className="search-panel__input"
          aria-label="搜索文档"
          placeholder="搜索标题与正文…"
          value={query}
          autoFocus
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
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
      </div>
    </div>
  );
}

/**
 * @file 全局搜索面板：当前知识库内按标题与正文全文检索。
 * 输入经 300ms 防抖后查询；结果列表复用编辑器的 CommandList 以获得
 * 统一的键盘导航（↑↓ 移动、Enter 跳转），方向键事件从输入框转发给列表。
 * 匹配与高亮逻辑在 domain/search.ts。
 * R008 Stage 6（§14.1/§14.3）：查询请求 id 丢弃过期结果；全文索引
 *（Desktop）状态条——building「正在建立本地搜索索引…」/ degraded
 * 「搜索索引需要修复」+ 重建入口（§13.4）。
 */

import { useEffect, useRef, useState } from "react";
import type { SuggestionKeyDownProps } from "@tiptap/suggestion";
import type { SearchResult } from "../domain/types";
import type { SearchIndexStatus } from "../application/search/SearchIndexStatus";
import { useAppServices } from "../state/AppServicesProvider";
import {
  useWorkspaceCommands,
  useWorkspaceData,
} from "../state/WorkspaceSessionContext";
import { useNavigationCommands } from "../state/NavigationContext";
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
  const services = useAppServices();
  const { pages, workspace } = useWorkspaceData();
  const { search } = useWorkspaceCommands();
  const { selectPage } = useNavigationCommands();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const listRef = useRef<CommandListRef>(null);
  // §14.3：查询请求 id——慢查询后至时丢弃过期结果（不回填旧列表）。
  const requestIdRef = useRef(0);

  const { debounced: debouncedSearch } = useDebouncedCallback(
    (value: string) => {
      const requestId = ++requestIdRef.current;
      void search(value).then((next) => {
        if (requestId === requestIdRef.current) setResults(next);
      });
    },
    300,
  );

  const onQueryChange = (value: string) => {
    setQuery(value);
    // 清空输入时立即清结果并跳过防抖查询，避免旧结果闪回
    if (!value.trim()) {
      // 使在途查询失效（其结果被丢弃）。
      requestIdRef.current += 1;
      setResults([]);
      return;
    }
    debouncedSearch(value);
  };

  // R008 §14.1：全文索引状态条（仅 Desktop 装配 fullTextSearch 时出现）。
  const fullText = services.fullTextSearch;
  const vaultId = workspace?.id ?? null;
  const [indexStatus, setIndexStatus] = useState<SearchIndexStatus | null>(
    null,
  );
  useEffect(() => {
    if (!fullText || !vaultId) {
      setIndexStatus(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const read = () => {
      if (!cancelled) setIndexStatus(fullText.getStatus(vaultId));
    };
    read();
    // building 期间轮询直至 ready/degraded。
    timer = setInterval(() => {
      const status = fullText.getStatus(vaultId);
      if (!cancelled) setIndexStatus(status);
      if (status.state !== "building" && timer) {
        clearInterval(timer);
        timer = null;
      }
    }, 500);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [fullText, vaultId]);

  const rebuildIndex = () => {
    if (!fullText || !vaultId) return;
    setIndexStatus({ state: "building" });
    void fullText.rebuild(vaultId).then(() => {
      setIndexStatus(fullText.getStatus(vaultId));
    });
  };

  const items: CommandListItem[] = results.map((result) => {
    const page = pages.find((p) => p.id === result.pageId);
    return {
      id: result.pageId,
      title: result.title,
      subtitle: result.snippet || undefined,
      icon: page?.icon ?? (
        <PageIcon
          kind={page?.kind === "group" ? "group" : "document"}
          size={14}
        />
      ),
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
      {fullText && indexStatus?.state === "building" && (
        <div className="search-panel__hint" role="status">
          正在建立本地搜索索引…
        </div>
      )}
      {fullText && indexStatus?.state === "degraded" && (
        <div className="search-panel__hint" role="alert">
          <span>搜索索引需要修复</span>
          <button type="button" onClick={rebuildIndex}>
            重建索引
          </button>
        </div>
      )}
      {query.trim() ? (
        <CommandList ref={listRef} items={items} command={jump} />
      ) : (
        <div className="search-panel__hint">
          输入关键词，按标题与正文查找文档。
        </div>
      )}
    </Dialog>
  );
}

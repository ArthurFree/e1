/**
 * @file 页面选择器（R010 Stage 6 §14）：Dialog + 搜索过滤的页面列表，
 * 供「失效链接重新定位」等场景选择目标页面。
 *
 * 与 TargetPicker（创建位置选择器，选知识库/分组）不同，本组件选的是
 * 具体文档页面；交互形态沿用 SearchPanel 先例：输入框 + CommandList
 * 键盘导航（↑↓ 移动、Enter 选择），方向键事件从输入框转发给列表。
 * 数据源为会话页面镜像（useWorkspaceData().pages），只列当前知识库的
 * 未删除文档。
 */

import { useMemo, useRef, useState } from "react";
import type { SuggestionKeyDownProps } from "@tiptap/suggestion";
import { useWorkspaceData } from "../state/WorkspaceSessionContext";
import { Dialog } from "./ui/Dialog";
import { PageIcon } from "./ui/icons";
import {
  CommandList,
  type CommandListItem,
  type CommandListRef,
} from "./editor/CommandList";

interface PagePickerProps {
  /** 选中某个页面时的回调（关闭由调用方负责）。 */
  onSelect(pageId: string): void;
  /** 关闭选择器（Escape、点击遮罩时触发）。 */
  onClose(): void;
  /** 列表中排除的页面 id（如源文档自身）。 */
  excludePageId?: string;
}

/** 页面选择器：搜索过滤当前知识库的文档，Enter/点击选中。 */
export function PagePicker({
  onSelect,
  onClose,
  excludePageId,
}: PagePickerProps) {
  const { pages } = useWorkspaceData();
  const [query, setQuery] = useState("");
  const listRef = useRef<CommandListRef>(null);

  const items: CommandListItem[] = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return pages
      .filter(
        (page) =>
          page.kind === "document" &&
          page.deletedAt === null &&
          page.id !== excludePageId,
      )
      .filter(
        (page) =>
          keyword === "" ||
          (page.title || "无标题").toLowerCase().includes(keyword),
      )
      .map((page) => ({
        id: page.id,
        title: page.title || "无标题",
        icon: <PageIcon icon={page.icon} kind="document" size={14} />,
      }));
  }, [pages, query, excludePageId]);

  return (
    <Dialog label="选择页面" className="search-panel" onClose={onClose}>
      <input
        className="search-panel__input"
        aria-label="搜索页面"
        placeholder="输入页面标题…"
        value={query}
        autoFocus
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          // 方向键/回车在输入框上截获并转交给 CommandList 的键盘导航
          //（SearchPanel 同口径）。
          if (["ArrowUp", "ArrowDown", "Enter"].includes(event.key)) {
            event.preventDefault();
            listRef.current?.onKeyDown({
              event: event.nativeEvent,
            } as unknown as SuggestionKeyDownProps);
          }
        }}
      />
      <CommandList
        ref={listRef}
        items={items}
        command={(item) => onSelect(item.id)}
      />
    </Dialog>
  );
}

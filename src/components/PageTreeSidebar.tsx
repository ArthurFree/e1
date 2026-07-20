import { useCallback, useRef, useState } from "react";
import type { Page } from "../domain/types";
import { childrenOf } from "../domain/pageTree";
import { useApp } from "../state/AppState";

interface PageTreeSidebarProps {
  open: boolean;
  onClose(): void;
}

/** 文档树侧栏：层级展示、新建、重命名、删除、拖动调宽。 */
export function PageTreeSidebar({ open, onClose }: PageTreeSidebarProps) {
  const {
    pages,
    selectedPageId,
    selectPage,
    createPage,
    renamePage,
    deletePage,
    preferences,
    setSidebarWidth,
  } = useApp();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [resizing, setResizing] = useState(false);
  const widthRef = useRef(preferences.sidebarWidth);

  const toggleCollapse = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const startRename = (page: Page) => {
    setRenamingId(page.id);
    setRenameValue(page.title);
  };

  const commitRename = () => {
    if (renamingId) {
      const value = renameValue.trim();
      if (value) void renamePage(renamingId, value);
    }
    setRenamingId(null);
  };

  const onResizeStart = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      setResizing(true);
      const startX = event.clientX;
      const startWidth = widthRef.current;

      const onMove = (move: PointerEvent) => {
        const next = Math.min(480, Math.max(200, startWidth + move.clientX - startX));
        widthRef.current = next;
        const el = document.querySelector<HTMLElement>(".tree-sidebar");
        if (el) el.style.width = `${next}px`;
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        setResizing(false);
        void setSidebarWidth(widthRef.current);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [setSidebarWidth],
  );

  const renderTree = (parentId: string | null) => {
    const nodes = childrenOf(pages, parentId);
    if (parentId === null && nodes.length === 0) {
      return <div className="tree-empty">还没有页面，点击上方 ＋ 新建。</div>;
    }
    return nodes.map((page) => {
      const children = childrenOf(pages, page.id);
      const isCollapsed = collapsed.has(page.id);
      const isFolder = page.kind === "folder";
      return (
        <div key={page.id}>
          <div
            className={`tree-row${page.id === selectedPageId ? " tree-row--selected" : ""}`}
            role="treeitem"
            aria-selected={page.id === selectedPageId}
            aria-expanded={children.length > 0 ? !isCollapsed : undefined}
            tabIndex={0}
            onClick={() => {
              if (isFolder) toggleCollapse(page.id);
              else {
                selectPage(page.id);
                onClose();
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                if (isFolder) toggleCollapse(page.id);
                else selectPage(page.id);
              }
            }}
          >
            {children.length > 0 ? (
              <button
                type="button"
                className="tree-row__toggle"
                aria-label={isCollapsed ? "展开" : "折叠"}
                onClick={(event) => {
                  event.stopPropagation();
                  toggleCollapse(page.id);
                }}
              >
                {isCollapsed ? "▸" : "▾"}
              </button>
            ) : (
              <span className="tree-row__toggle" aria-hidden="true" />
            )}
            <span className="tree-row__icon" aria-hidden="true">
              {page.icon ?? (isFolder ? "📁" : "📄")}
            </span>
            {renamingId === page.id ? (
              <input
                className="tree-row__rename"
                aria-label="重命名"
                value={renameValue}
                autoFocus
                onChange={(event) => setRenameValue(event.target.value)}
                onBlur={commitRename}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitRename();
                  if (event.key === "Escape") setRenamingId(null);
                }}
                onClick={(event) => event.stopPropagation()}
              />
            ) : (
              <span
                className={`tree-row__title${page.title ? "" : " tree-row__title--untitled"}`}
              >
                {page.title || "无标题"}
              </span>
            )}
            <span className="tree-row__actions">
              <button
                type="button"
                className="tree-row__action"
                aria-label={`在「${page.title || "无标题"}」下新建文档`}
                title="新建子文档"
                onClick={(event) => {
                  event.stopPropagation();
                  void createPage("document", page.id);
                }}
              >
                ＋
              </button>
              <button
                type="button"
                className="tree-row__action"
                aria-label={`重命名「${page.title || "无标题"}」`}
                title="重命名"
                onClick={(event) => {
                  event.stopPropagation();
                  startRename(page);
                }}
              >
                ✏️
              </button>
              <button
                type="button"
                className="tree-row__action"
                aria-label={`删除「${page.title || "无标题"}」`}
                title="删除"
                onClick={(event) => {
                  event.stopPropagation();
                  void deletePage(page.id);
                }}
              >
                🗑️
              </button>
            </span>
          </div>
          {!isCollapsed && children.length > 0 && (
            <div className="tree-children" role="group">
              {renderTree(page.id)}
            </div>
          )}
        </div>
      );
    });
  };

  return (
    <aside
      className={`tree-sidebar${open ? " tree-sidebar--open" : ""}`}
      aria-label="文档树"
      style={{ width: preferences.sidebarWidth }}
    >
      <div className="tree-sidebar__header">
        <span>页面</span>
        <span className="tree-sidebar__actions">
          <button
            type="button"
            className="icon-button"
            aria-label="新建文档"
            title="新建文档"
            onClick={() => void createPage("document", null)}
          >
            ＋
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="新建文件夹"
            title="新建文件夹"
            onClick={() => void createPage("folder", null)}
          >
            📁
          </button>
        </span>
      </div>
      <div className="tree-sidebar__body" role="tree" aria-label="页面树">
        {renderTree(null)}
      </div>
      <div
        className={`tree-resizer${resizing ? " tree-resizer--active" : ""}`}
        role="separator"
        aria-label="调整侧栏宽度"
        aria-orientation="vertical"
        onPointerDown={onResizeStart}
      />
    </aside>
  );
}

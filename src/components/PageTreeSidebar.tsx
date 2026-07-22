import { useCallback, useRef, useState } from "react";
import type { Page } from "../domain/types";
import {
  childrenOf,
  dropZoneAt,
  resolveDrop,
  type DropZone,
} from "../domain/pageTree";
import { jsonToText, markdownToJson } from "../editor/markdown";
import { contentRepository } from "../infrastructure/repositories";
import { useApp } from "../state/AppState";

interface PageTreeSidebarProps {
  open: boolean;
  onClose(): void;
}

const DND_MIME = "application/x-page-id";

/** 文档树侧栏：层级展示、新建、重命名、删除、拖拽移动、标签筛选、Markdown 导入。 */
export function PageTreeSidebar({ open, onClose }: PageTreeSidebarProps) {
  const {
    pages,
    selectedPageId,
    view,
    selectPage,
    showWorkspaceHome,
    createPage,
    renamePage,
    deletePage,
    movePage,
    tags,
    pageTags,
    deleteTag,
    preferences,
    setSidebarWidth,
  } = useApp();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [resizing, setResizing] = useState(false);
  const [activeTagId, setActiveTagId] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string; zone: DropZone } | null>(null);
  const widthRef = useRef(preferences.sidebarWidth);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // HTML5 DnD 的 dragover 事件里读不到 dataTransfer 数据，用 ref 记下被拖页面。
  const dragIdRef = useRef<string | null>(null);

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

  const onImportFile = async (file: File) => {
    setImportError(null);
    try {
      const text = await file.text();
      const json = markdownToJson(text);
      const page = await createPage("document", null);
      if (!page) throw new Error("create failed");
      const title = file.name.replace(/\.(md|markdown)$/i, "") || "导入文档";
      await renamePage(page.id, title);
      await contentRepository.save(page.id, json, jsonToText(json));
      selectPage(page.id);
    } catch (error) {
      setImportError(
        error instanceof Error && error.message === "无法解析该 Markdown 文件"
          ? error.message
          : "导入失败，请确认文件为有效的 Markdown。",
      );
    }
  };

  const onDragOverRow = (event: React.DragEvent, page: Page) => {
    const draggedId = event.dataTransfer.types.includes(DND_MIME)
      ? dragIdRef.current
      : null;
    if (!draggedId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const zone = dropZoneAt((event.clientY - rect.top) / rect.height);
    if (!resolveDrop(pages, draggedId, page.id, zone)) {
      setDropHint(null);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropHint({ id: page.id, zone });
  };

  const onDropRow = (event: React.DragEvent, page: Page) => {
    event.preventDefault();
    const draggedId = event.dataTransfer.getData(DND_MIME) || dragIdRef.current;
    setDropHint(null);
    if (!draggedId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const zone = dropZoneAt((event.clientY - rect.top) / rect.height);
    const target = resolveDrop(pages, draggedId, page.id, zone);
    if (target) void movePage(draggedId, target.parentId, target.index);
  };

  const dropClass = (page: Page) => {
    if (dropHint?.id !== page.id) return "";
    return ` tree-row--drop-${dropHint.zone}`;
  };

  const renderRow = (page: Page, children: Page[]) => {
    const isCollapsed = collapsed.has(page.id);
    const isGroup = page.kind === "group";
    return (
      <div
        className={`tree-row${page.id === selectedPageId ? " tree-row--selected" : ""}${dropClass(page)}`}
        role="treeitem"
        aria-selected={page.id === selectedPageId}
        aria-expanded={children.length > 0 ? !isCollapsed : undefined}
        tabIndex={0}
        draggable
        onDragStart={(event) => {
          dragIdRef.current = page.id;
          event.dataTransfer.setData(DND_MIME, page.id);
          event.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => {
          dragIdRef.current = null;
          setDropHint(null);
        }}
        onDragOver={(event) => onDragOverRow(event, page)}
        onDragLeave={() => setDropHint((hint) => (hint?.id === page.id ? null : hint))}
        onDrop={(event) => onDropRow(event, page)}
        onClick={() => {
          if (isGroup) toggleCollapse(page.id);
          else {
            selectPage(page.id);
            onClose();
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (isGroup) toggleCollapse(page.id);
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
          {page.icon ?? (isGroup ? "📁" : "📄")}
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
    );
  };

  const renderTree = (parentId: string | null) => {
    const nodes = childrenOf(pages, parentId);
    if (parentId === null && nodes.length === 0) {
      return <div className="tree-empty">还没有页面，点击上方 ＋ 新建。</div>;
    }
    return nodes.map((page) => {
      const children = childrenOf(pages, page.id);
      const isCollapsed = collapsed.has(page.id);
      return (
        <div key={page.id}>
          {renderRow(page, children)}
          {!isCollapsed && children.length > 0 && (
            <div className="tree-children" role="group">
              {renderTree(page.id)}
            </div>
          )}
        </div>
      );
    });
  };

  // 标签筛选：只显示带该标签的文档，扁平列表。
  const renderTagFiltered = () => {
    const taggedPageIds = pageTags
      .filter((r) => r.tagId === activeTagId)
      .map((r) => r.pageId);
    const matched = pages.filter(
      (p) => p.deletedAt === null && taggedPageIds.includes(p.id),
    );
    if (matched.length === 0) {
      return <div className="tree-empty">没有带此标签的页面。</div>;
    }
    return matched.map((page) => (
      <div key={page.id}>{renderRow(page, childrenOf(pages, page.id))}</div>
    ));
  };

  return (
    <aside
      className={`tree-sidebar${open ? " tree-sidebar--open" : ""}`}
      aria-label="文档树"
      style={{ width: preferences.sidebarWidth }}
    >
      <button
        type="button"
        className={`tree-nav${view === "workspace" ? " tree-nav--active" : ""}`}
        aria-current={view === "workspace" ? "page" : undefined}
        onClick={() => {
          showWorkspaceHome();
          onClose();
        }}
      >
        <span aria-hidden="true">🏠</span> 首页
      </button>
      <div className="tree-sidebar__header">
        <span>目录</span>
        <span className="tree-sidebar__actions">
          <button
            type="button"
            className="icon-button"
            aria-label="导入 Markdown"
            title="导入 Markdown"
            onClick={() => fileInputRef.current?.click()}
          >
            📥
          </button>
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
            aria-label="新建分组"
            title="新建分组"
            onClick={() => {
              // 创建后立即进入重命名状态。
              void (async () => {
                const page = await createPage("group", null);
                if (page) startRename(page);
              })();
            }}
          >
            📁
          </button>
        </span>
        <input
          ref={fileInputRef}
          type="file"
          accept=".md,.markdown,text/markdown"
          hidden
          aria-label="选择 Markdown 文件"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void onImportFile(file);
          }}
        />
      </div>
      {importError && (
        <div className="tree-sidebar__error" role="alert">
          <span>{importError}</span>
          <button
            type="button"
            className="tree-row__action"
            aria-label="关闭错误提示"
            onClick={() => setImportError(null)}
          >
            ✕
          </button>
        </div>
      )}
      <div className="tree-sidebar__body" role="tree" aria-label="页面树">
        {activeTagId ? renderTagFiltered() : renderTree(null)}
      </div>
      <div className="tree-tags" aria-label="标签筛选">
        <span className="tree-tags__label">标签</span>
        {tags.length === 0 ? (
          <span className="tree-tags__empty">在文档标题下方添加标签</span>
        ) : (
          tags.map((tag) => (
            <span
              key={tag.id}
              className={`tag-chip${activeTagId === tag.id ? " tag-chip--active" : ""}`}
              style={{ color: tag.color }}
            >
              <span className="tag-chip__dot" style={{ background: tag.color }} />
              <button
                type="button"
                className="tag-chip__filter"
                aria-pressed={activeTagId === tag.id}
                aria-label={`按标签「${tag.name}」筛选`}
                onClick={() =>
                  setActiveTagId((current) => (current === tag.id ? null : tag.id))
                }
              >
                {tag.name}
              </button>
              <button
                type="button"
                className="tag-chip__remove"
                aria-label={`删除标签「${tag.name}」`}
                onClick={() => {
                  if (activeTagId === tag.id) setActiveTagId(null);
                  void deleteTag(tag.id);
                }}
              >
                ✕
              </button>
            </span>
          ))
        )}
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
